// 单测：issue #520 —— 其余轮询器的**空闲退避**（#506 的续作；#506 只管了 routes / materializer）。
//
// 判据形状（工单判据 3）：断言**观察到的 sleep 毫秒序列**，不是「代码里有没有 sleep」。
// 每条退避都配一条**反向**用例：reaper / drift / offboarding 的 1h 清理是**定时语义**，
// 它们不许跟着空闲退避 —— 反向用例红的形状就是「有人顺手把它们也退避了」。
//
// 夹具口径（工单 fix-261116-01 (d) 与 issue #531）：
//   · `sleep` 全部注入假睡眠 ⇒ 一秒真时间都不等；
//   · 等「循环停在某一拍上」用**截止时刻**（`waitUntil`），不用「转满 N 个 `setImmediate`」的
//     轮次预算 —— 轮次预算在同机并发下会假红（#531 就是 #506 那批夹具的 `arm()` 撞上的）。
//     正常路径这里 < 5ms 就满足，15s 只是病态情况下的兜底与可读的失败消息。
//   · 唯一用真墙钟的地方是「stop() 必须打断正在睡的那一拍」那两条：测的正是可中断性本身，
//     拿假 sleep 测等于测夹具（与 #506 同口径）。
//
// 隔离约定（docs/testing.md §2.1）：假 pool + 假 docker + 临时目录，不碰真实 DB / /srv/erix。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { idleDelayMs, envInt, sleepCancellable, MAX_BACKOFF_MS_SAFE, NODE_TIMER_MAX_MS } from '../src/loop-timing.js';
import { startOnboardingLoop } from '../src/onboarding.js';
import { startOffboardingLoop } from '../src/offboarding.js';
import { startProvisionerLoop, reconcileDidWork } from '../src/provisioner.js';
import { startReaperLoop } from '../src/internal.js';
import { hashToken } from '../src/auth.js';
import { startRouteDriftMonitor, DRIFT_INTERVAL_MS } from '../src/routesdrift.js';
import { stopLoopsAndWait } from '../src/shutdown.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'station-520-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 假睡眠：记录每一拍的毫秒数，且不自己醒来（循环必须停在 sleep 上，由测试推进）。
// ---------------------------------------------------------------------------

function makeFakeSleep() {
  const sleeps = [];
  let pending = null; // { ms, finish(ok) }
  const sleep = (ms, signal) => new Promise((resolve) => {
    sleeps.push(ms);
    const entry = { ms, done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (pending === entry) pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending = entry;
  });
  /** 放行当前这一拍（=「假时钟走完了」）。没有正在等的 sleep 就是夹具用错了。 */
  const pass = () => {
    assert.ok(pending, '循环必须停在某一拍的 sleep 上（没停住 = 循环抛错或已经退了）');
    const entry = pending;
    entry.finish(true);
    return entry.ms;
  };
  return {
    sleeps,
    sleep,
    pass,
    get parked() { return pending !== null; },
    get parkedMs() { return pending?.ms ?? null; },
  };
}

/**
 * 等到条件成立（**截止时刻**兜底，不是轮次预算 —— #531）。
 * 每一轮只 `setImmediate`，正常情况一两轮就满足；同机负载高时只是多转几轮，不会假红。
 *
 * PR #552 审计 LOW-4：墙钟在这条里仍是**看门狗**，不是判据；但一个被长 GC / 并发门禁压住十几秒的
 * 事件循环仍可能让它误红（墙钟到期了，而循环只差一个宏任务）。所以到期后先给**几轮宏任务的宽限
 * 复检**再判失败：真挂死仍然立刻红（只多几个宏任务，不多花一秒），而“只是被停顿了一下”不再假红。
 * 没换成假时钟的理由：这里等的是“真事件循环把微任务链跑到了 sleep 上”，换成假时钟就变成在测夹具。
 */
async function waitUntil(cond, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) {
      for (let i = 0; i < 5 && !cond(); i += 1) await new Promise((r) => setImmediate(r)); // 宽限复检（防假红）
      if (cond()) return;
      assert.fail(`等超时（${deadlineMs}ms + 5 轮宽限，同机负载？）：${label}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

/** 跑到「第 n 拍 sleep 已被记录」为止（`who` 只用于失败消息：红了要知道是哪个循环没跑起来）。 */
async function parkedTick(fake, n, who = '循环') {
  await waitUntil(() => fake.sleeps.length >= n,
    `${who} 应已走到第 ${n} 拍 sleep；实际 ${fake.sleeps.length} 拍（${JSON.stringify(fake.sleeps)}）`);
  return fake.sleeps;
}

/**
 * 把假时钟推到「第 n 拍并**停在**那一拍的 sleep 上」（前面的拍逐拍放行）。
 * 必要性的理由：假睡眠**不会自己醒**（这是它的卖点：不等真时间），所以每一拍都得由测试
 * `pass()` 放行——直接 `parkedTick(n)` 而不放行前 n-1 拍，永远也等不到第 n 拍。
 */
async function parkAt(fake, n, who = '循环') {
  for (let i = 1; i < n; i += 1) {
    await parkedTick(fake, i, who);
    fake.pass();
  }
  await parkedTick(fake, n, who);
}

/**
 * 给一个「正常情况立刻落定」的 promise 加**看门狗**（不是判据，只是防挂死）。
 * 为什么这里允许墙钟：判据是「`stop()` 能打断睡」——假睡眠**永不自己醒**，所以
 * `settled` 能落定就只可能是 abort 生效；20s 只是「万一没打断也别挂死整个文件」。
 * 与 #531 里那族红线的区别：那里拿墙钟/轮次**当判据**，这里拿它当看门狗。
 *
 * PR #552 审计 LOW-4：看门狗到点后先**复查 promise 是否其实已落定**（再给几轮宏任务）。
 * 事件循环被停顿十几秒时，定时器回调可能排在那个已经落定的 promise **之后**才被调度
 * ⇒ 老写法会把“其实已经落定”误判成“stop 没打断”（假红）。真没落定时仍然立刻红。
 * 顺带修了 reject 不吞报：老写法 `promise.then(ok, err)` 把异常当返回值抛，新的 tracked 形式
 * 保证 promise 自己被接住，不留 unhandled rejection。
 */
async function awaitWatchdog(promise, label, ms = 20_000) {
  let state = 'pending';
  const tracked = Promise.resolve(promise).then(
    () => { state = 'ok'; },
    (err) => { state = { err }; },
  );
  let timer = null;
  const watchdog = new Promise((resolve) => { timer = setTimeout(() => resolve(), ms); });
  await Promise.race([tracked, watchdog]);
  if (timer) clearTimeout(timer);
  for (let i = 0; i < 5 && state === 'pending'; i += 1) await new Promise((r) => setImmediate(r)); // 宽限复检（防假红）
  if (state === 'pending') assert.fail(`stop() 没能打断在睡的那一拍（${label}，${ms}ms watchdog + 5 轮宽限）`);
  if (state !== 'ok') throw state.err;
}

const silentLog = { log() {}, warn() {}, error() {} };

// ---------------------------------------------------------------------------
// A. `loop-timing.js`：阶梯算法本体（三处退避共用一份，所以直接测它）
// ---------------------------------------------------------------------------

test('#520 A1 idleDelayMs：基准 5000 起指数翻倍，封顶在 maxMs（判据 3 的阶梯可读性）', () => {
  const base = { baseMs: 5000 };
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((n) => idleDelayMs(n, { ...base, maxMs: 30000 })),
    [5000, 5000, 10000, 20000, 30000, 30000, 30000],
    'idleTicks=0 必须回基准（=有活立刻回 5000），之后 5s→10s→20s→30s 封顶',
  );
  // provisioner 的上限是 15s（漂移发现延迟是它的业务承诺，见 provisioner.js 的注释）
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => idleDelayMs(n, { baseMs: 5000, maxMs: 15000 })),
    [5000, 10000, 15000, 15000],
  );
});

test('#520 A2 idleDelayMs：maxMs 越界/非法自己也要夹（不假定调用方已过 envInt）', () => {
  // 3e9 不夹 ⇒ 交给 setTimeout 会折成 1ms 空转（#506 评审①实测），所以这里必须夹
  assert.equal(idleDelayMs(9, { baseMs: 5000, maxMs: 3e9 }), MAX_BACKOFF_MS_SAFE);
  assert.ok(idleDelayMs(9, { baseMs: 5000, maxMs: 3e9 }) <= NODE_TIMER_MAX_MS);
  // 配置不许把基准节拍压低（maxMs < baseMs ⇒ 夹到 baseMs，不是变成 1ms）
  assert.equal(idleDelayMs(3, { baseMs: 5000, maxMs: 100 }), 5000);
  // NaN / Infinity / 负数 ⇒ 回落生产上限，绝不静默变成 0/1ms
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    const v = idleDelayMs(3, { baseMs: 5000, maxMs: bad });
    assert.ok(Number.isFinite(v) && v >= 5000 && v <= MAX_BACKOFF_MS_SAFE, `maxMs=${bad} ⇒ ${v}`);
  }
  // baseMs 本身非法同样不许漏出 0/NaN
  assert.ok(Number.isFinite(idleDelayMs(2, { baseMs: Number.NaN, maxMs: 30000 })));
});

test('#520 A3 envInt：严格整串正整数；非法/越界 ⇒ 回落默认 + warn，没配 ⇒ 静默默认', () => {
  const warns = [];
  const log = { warn: (m) => warns.push(m) };
  process.env.STATION_520_TEST_MS = '1e4';
  assert.equal(envInt('STATION_520_TEST_MS', 30000, { log }), 30000, "'1e4' 不认（parseInt 前缀匹配会读成 1）");
  assert.equal(warns.length, 1, '非法值必须 warn 一次（这行配置没生效，不能静默）');
  process.env.STATION_520_TEST_MS = '10000abc';
  assert.equal(envInt('STATION_520_TEST_MS', 30000, { log }), 30000);
  process.env.STATION_520_TEST_MS = '45000';
  assert.equal(envInt('STATION_520_TEST_MS', 30000, { max: 40000, log }), 30000, '越界 ⇒ 回落默认，不夹取');
  process.env.STATION_520_TEST_MS = ' 20000 ';
  assert.equal(envInt('STATION_520_TEST_MS', 30000, { log }), 20000, 'trim 后整串是数字 ⇒ 合法（env-file 常带空格）');
  warns.length = 0;
  delete process.env.STATION_520_TEST_MS;
  assert.equal(envInt('STATION_520_TEST_MS', 30000, { log }), 30000);
  assert.equal(warns.length, 0, '没配不算错误 ⇒ 不许每次启动刷噪声');
});

// PR #552 审计 LOW-4 登记：本格是全文件**唯一拿真 timer 当被测对象**的地方（真 5ms / 真 1ms）。
// 不换成假时钟的理由：这里测的就是 `sleepCancellable` 对**真** timer + **真** AbortSignal 的行为，
// 换成假时钟就变成在测夹具（与 #506 的 B4/C3/D3/E3 同口径）。
// 墙钟依赖的实际风险：判据是 resolve 的**布尔值**，不是流逝毫秒数 ⇒ 事件循环被停顿时本格只会变慢，
// 不会假红（唯一能红它的形状是 timer 回调根本不跑，那已经是运行时故障）。已登记的残留见。
test('#520 A4 sleepCancellable：abort 立刻 resolve(false)，睡满 resolve(true)', async () => {
  const ac = new AbortController();
  const p = sleepCancellable(60_000, ac.signal); // 真 timer，但下面立刻 abort
  setTimeout(() => ac.abort(), 5);
  assert.equal(await p, false, '被 abort 必须返回 false（调用方据此退出循环）');
  assert.equal(await sleepCancellable(1), true, '没给 signal 时睡满返回 true');
  // 已经 abort 的 signal：立刻 false（否则关闭会白等一整拍）
  const ac2 = new AbortController();
  ac2.abort();
  assert.equal(await sleepCancellable(60_000, ac2.signal), false);
});

// ---------------------------------------------------------------------------
// B. onboarding 循环
// ---------------------------------------------------------------------------

const FDE_ID = 'b0000000-0000-4000-8000-000000000002';

/** 假 pool：`claimRows()` 决定这一拍认不认得到活；steps 全 done ⇒ 认领到活但不碰 docker。 */
function makeOnboardingPool({ claimRows }) {
  return {
    calls: [],
    async query(sql, params = []) {
      this.calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM fde_onboarding o')) {
        return { rows: claimRows() ? [{
          fde_id: FDE_ID,
          steps: { provision: { state: 'done' }, materialize: { state: 'done' }, 'llm-binding': { state: 'done' } },
          fde_name: 'alice',
          git_host_id: 'c0000000-0000-4000-8000-000000000011',
        }] : [] };
      }
      if (sql.includes("SET state = 'running'")) return { rows: [{ attempt: 1 }] };
      if (sql.includes('SELECT status FROM users')) return { rows: [{ status: 'active' }] };
      return { rows: [] };
    },
    async connect() { return { query: (sql, p) => this.query(sql, p), release() {} }; },
  };
}

test('#520 B1 onboarding：认领 0 行 ⇒ sleep 序列 5000/10000/20000/30000/30000（改回去必须红）', async () => {
  const fake = makeFakeSleep();
  const pool = makeOnboardingPool({ claimRows: () => false });
  const loop = startOnboardingLoop(pool, { dockerHost: 'tcp://nowhere' }, {
    docker: {}, log: silentLog, sleep: fake.sleep, idleBackoffMaxMs: 30000,
  });
  for (let i = 1; i <= 5; i += 1) {
    await parkedTick(fake, i);
    fake.pass();
  }
  assert.deepEqual(fake.sleeps, [5000, 10000, 20000, 30000, 30000],
    `空闲退避阶梯没跑起来：${JSON.stringify(fake.sleeps)}`);
  // 每一拍都真的跑了一次认领（退避不是「啥也不干地睡」）
  assert.ok(pool.calls.filter((s) => s.includes('FROM fde_onboarding o')).length >= 5);
  loop.stop();
  await loop.settled;
});

test('#520 B2 onboarding：认领到活立刻回基准 5000（退避不许粘住）', async () => {
  // 拍与 sleep 的对应关系（弄错这个就会造出一条「看起来像测了但其实没测」的用例）：
  //   循环是「干活 → 决定这一拍睡多久 → sleep」，所以 **sleeps[i] 是第 i+1 拍干完活后的决定**。
  //   ⇒ 要让某一拍「有活」，必须在它**还没开始干**的时候把 `hasWork` 翻上去 = 在上一拍还停在
  //     sleep 上时翻。先 pass 再翻就晚了（那一拍已经按空闲拍过睡了）。
  const fake = makeFakeSleep();
  let hasWork = false;
  const pool = makeOnboardingPool({ claimRows: () => hasWork });
  const loop = startOnboardingLoop(pool, {}, { docker: {}, log: silentLog, sleep: fake.sleep, idleBackoffMaxMs: 30000 });
  await parkedTick(fake, 1); fake.pass();            // 拍 1 空闲 ⇒ 5000
  await parkedTick(fake, 2);
  assert.equal(fake.sleeps[1], 10000, '拍 2 仍空闲 ⇒ 阶梯继续爬');
  hasWork = true; // 拍 2 停在 sleep 上时入队 ⇒ 拍 3 一开工就认领得到
  fake.pass();
  await parkedTick(fake, 3);
  assert.equal(fake.sleeps[2], 5000, '认领到活的那一拍必须回基准（idleTicks 清 0）');
  hasWork = false;
  fake.pass();                                       // 拍 4 又开始空闲
  await parkedTick(fake, 4);
  assert.equal(fake.sleeps[3], 5000, '活干完之后从基准重新爬，不是接着 20000 继续');
  loop.stop();
  await loop.settled;
});

test('#520 B3 onboarding：旋钮把上限顶到越界也不会变成 1ms（夹到 MAX_BACKOFF_MS_SAFE）', async () => {
  const warns = [];
  const fake = makeFakeSleep();
  const pool = makeOnboardingPool({ claimRows: () => false });
  const loop = startOnboardingLoop(pool, {}, {
    docker: {}, log: { ...silentLog, warn: (m) => warns.push(m) }, sleep: fake.sleep,
    idleBackoffMaxMs: envInt('ONBOARDING_IDLE_BACKOFF_MAX_MS_TEST', 30000, { log: { warn: (m) => warns.push(m) } }),
  });
  for (let i = 1; i <= 4; i += 1) { await parkedTick(fake, i); fake.pass(); }
  assert.deepEqual(fake.sleeps, [5000, 10000, 20000, 30000]);
  loop.stop();
  await loop.settled;
});

test('#520 B4 onboarding：stop() 打断正在睡的那一拍（假睡眠永不自己醒 ⇒ 能落定就只可能来自 abort）', async () => {
  // 口径（工单 (d) + #531）：本条**不拿墙钟当判据**。假睡眠不会自己醒，所以 `settled` 能落定
  // 就是 abort 生效的直接证据；`sleepCancellable` 自己的真 timer 行为由 A4 守。
  const fake = makeFakeSleep();
  const pool = makeOnboardingPool({ claimRows: () => false });
  const loop = startOnboardingLoop(pool, {}, { docker: {}, log: silentLog, sleep: fake.sleep });
  await parkAt(fake, 3, 'onboarding');
  assert.equal(fake.sleeps[2], 20000, '已经爬到退避上（否则本条测不到「退避中也能退」）');
  assert.ok(fake.parked, '这一拍必须还停在 sleep 上');
  loop.stop();
  await awaitWatchdog(loop.settled, 'onboarding');
  assert.equal(fake.parked, false, '睡过去的那一拍必须以 abort 收场');
  assert.equal(loop.failure(), null, '正常退出不该留下循环异常');
  await loop.done; // `done` 与 `settled` 指同一次退出（done 仍是给 stopLoopsAndWait 的那一份）
});

test('#520 B5 onboarding：异常分支走 BACKOFF_MS（不是空闲阶梯），且 onPause 收到', async () => {
  const fake = makeFakeSleep();
  const pauses = [];
  const boom = Object.assign(makeOnboardingPool({ claimRows: () => false }), {
    async query() { const e = new Error('db down'); throw e; },
    async connect() { return { query: () => { throw new Error('db down'); }, release() {} }; },
  });
  const loop = startOnboardingLoop(boom, {}, {
    docker: {}, log: silentLog, sleep: fake.sleep, onPause: (w, err) => pauses.push(err.message),
  });
  for (const want of [1000, 2000, 5000]) {
    await parkedTick(fake, fake.sleeps.length + 1);
    assert.equal(fake.sleeps[fake.sleeps.length - 1], want, '失败重试节拍必须是 BACKOFF_MS 阶梯（#506 红线：没动它）');
    fake.pass();
  }
  assert.deepEqual(pauses, ['db down', 'db down', 'db down']);
  loop.stop();
  await loop.settled;
});

// ---------------------------------------------------------------------------
// C. offboarding 循环（退避 + 1h 清理的定时语义）
// ---------------------------------------------------------------------------

/** 假 pool：认领由 `claimRows()` 决定；清理查询返回 0 行（只数它跑了几次）。 */
function makeOffboardingPool({ claimRows, sweepCount = { n: 0 } }) {
  return {
    sweepCount,
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM fde_offboarding o')) return { rows: claimRows() ? [{
        fde_id: FDE_ID, fde_name: 'alice',
        steps: {
          'disable-user': { state: 'done' }, 'stop-container': { state: 'done' }, 'revoke-runner-token': { state: 'done' },
          'revoke-llm-key': { state: 'done' }, 'delete-git-credential': { state: 'done' },
          'revoke-git-account-access': { state: 'done' }, 'release-network-routes': { state: 'done' },
          'schedule-workspace-purge': { state: 'done' },
        },
        container_name: null, network_name: null,
      }] : [] };
      if (sql.includes('SET state = ')) return { rows: [] };
      if (sql.includes('workspace_purge_after')) {
        this.sweepCount.n += 1; // 清理那一条 SELECT：本轮没有到期工作区
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() { return { query: (sql, p) => this.query(sql, p), release() {} }; },
  };
}

const HOUR_MS = 60 * 60 * 1000;

test('#520 C1 offboarding：认领 0 行 ⇒ 同样阶梯；且**空闲时 1h 清理照样跑**（定时语义不被退避饿死）', async () => {
  const fake = makeFakeSleep();
  const sweepCount = { n: 0 };
  let t = 1_700_000_000_000; // 生产里 `Date.now()` 远大于 0 ⇒ 启动那一拍必跑一次清理（保持原语义）
  const pool = makeOffboardingPool({ claimRows: () => false, sweepCount });
  // ⚠ `workspaceRetentionDays` 必须非 0：它是清理功能的**开关**（0 ⇒ `sweepOffboardedWorkspaces`
  // 直接 return `{disabled:true}`，一条 SQL 都不跑，本条用例就变成「断言一个从未跑的查询」）。
  const loop = startOffboardingLoop(pool, { userSpaceRoot: tmpRoot, workspaceRetentionDays: 7 }, {
    docker: {}, log: silentLog, sleep: fake.sleep, now: () => t, idleBackoffMaxMs: 30000,
  });
  for (let i = 1; i <= 5; i += 1) {
    await parkedTick(fake, i);
    fake.pass();
  }
  assert.deepEqual(fake.sleeps, [5000, 10000, 20000, 30000, 30000],
    `销号循环的空闲阶梯没跑起来：${JSON.stringify(fake.sleeps)}`);
  // 阶梯已经爬到 30s（= 主拍退让了），但清理闸门只按**时刻**判：一秒都没推进 ⇒ 只跑过启动那一拍
  assert.equal(sweepCount.n, 1, `退避期间清理不该重复跑（期望只跑启动那一拍，实际 ${sweepCount.n} 次）`);
  t += HOUR_MS + 1000; // 跨过 1h 闸门，而主拍仍在 30s 的退避上
  await parkedTick(fake, 6);
  fake.pass();
  assert.equal(sweepCount.n, 2, '跨过 1h 闸门后，**即便主拍在退避**也必须跑清理（它的节拍就是它的语义）');
  loop.stop();
  await loop.settled;
});

test('#520 C2 offboarding：认领到活立刻回基准', async () => {
  const fake = makeFakeSleep();
  let hasWork = false;
  const pool = makeOffboardingPool({ claimRows: () => hasWork });
  const loop = startOffboardingLoop(pool, { userSpaceRoot: tmpRoot, workspaceRetentionDays: 7 }, {
    docker: {}, log: silentLog, sleep: fake.sleep, now: () => 1_700_000_000_000, idleBackoffMaxMs: 30000,
  });
  await parkedTick(fake, 1); fake.pass();
  await parkedTick(fake, 2);
  assert.equal(fake.sleeps[1], 10000, '两拍空闲 ⇒ 在爬阶梯');
  hasWork = true; // 拍 2 还停在 sleep 上 ⇒ 拍 3 一开工就认领得到
  fake.pass();
  await parkedTick(fake, 3);
  assert.equal(fake.sleeps[2], 5000, '有活 ⇒ 回基准');
  loop.stop();
  await loop.settled;
});

test('#520 C3 offboarding：stop() 打断在睡的那一拍（同 B4 口径：不用墙钟）', async () => {
  const fake = makeFakeSleep();
  const pool = makeOffboardingPool({ claimRows: () => false });
  const loop = startOffboardingLoop(pool, { userSpaceRoot: tmpRoot, workspaceRetentionDays: 7 },
    { docker: {}, log: silentLog, sleep: fake.sleep });
  await parkAt(fake, 2, 'offboarding');
  assert.equal(fake.sleeps[1], 10000);
  loop.stop();
  await awaitWatchdog(loop.settled, 'offboarding');
  assert.equal(fake.parked, false);
  assert.equal(loop.failure(), null);
});

// ---------------------------------------------------------------------------
// D. provisioner 循环（对账：本轮没动手 ⇒ 退避）
// ---------------------------------------------------------------------------

const RECONCILE_CONFIG = {
  userSpaceRoot: tmpRoot,
  userSpaceRootHost: tmpRoot,
  fdeUid: process.getuid?.() ?? 1000,
  fdeGid: process.getgid?.() ?? 1000,
  fdeImage: 'traefik/whoami',
  fdeCmd: ['-port', '4000'],
  fdeMemoryLimit: '512m',
  fdeAgentVersion: 'dev',
  baseDomain: 'localhost',
  llmHost: 'llm.localhost',
};

/**
 * 假 pool + 假 docker：`containerExists` 决定这一拍要不要动手重建。
 * 稳态（容器在跑）⇒ `reconcileOnce` 返回的 stats 全 0 ⇒ 判据是「没动手」。
 *
 * 两个假必顶得住真实的契约校验（否则 `reconcileOnce` 会在 `assertNetworkContract` 那里
 * 抱一条 warn 就跳过本 FDE，`stats` 永远全 0 ⇒ 用例在**假绿**）：
 *   · 网络 inspect 必须带 `station.managed` / `fde.name` / IPAM 的 subnet+gateway；
 *   · 容器 inspect 的 `ERIX_STATION_TOKEN` 必须与 `runner_token_hash` 对得上（#404 的 F6：
 *     对不上会被当成漂移重建）⇒ 这里两边同源算（`hashToken(TOKEN)`）。
 *   · `State.Status = 'running'`（不跑 ⇒ `started=true` ⇒ `statusUpdates++` ⇒ 本单判为「动手」）。
 */
function makeReconcileFakes({ containerExists }) {
  const TOKEN = 'tok-520';
  const state = { rebuilds: 0, queries: [] };
  const pool = {
    async query(sql, params = []) {
      state.queries.push(sql);
      if (sql.includes('FROM users u') && sql.includes('JOIN fde_networks n')) {
        return { rows: [{
          user_id: 'u1', fde_name: 'alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1',
          network_name: 'fde-alice', container_id: 'c1', container_name: 'fde-alice',
          container_status: 'running', runner_token_hash: hashToken(TOKEN),
        }] };
      }
      if (sql.includes('SELECT 1 FROM fde_networks')) return { rows: [{ '?column?': 1 }] };
      return { rows: [] };
    },
    async connect() { return { query: (sql, p) => this.query(sql, p), release() {} }; },
  };
  const docker = {
    async inspectNetwork() {
      return {
        status: 200,
        data: {
          Name: 'fde-alice', Id: 'nid',
          Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
          IPAM: { Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] },
        },
      };
    },
    async createNetwork() { return { status: 201, data: { Id: 'nid' } }; },
    async inspectContainer(name) {
      if (containerExists()) {
        return {
          status: 200,
          data: {
            Name: `/${name}`, Id: 'cid',
            State: { Status: 'running' },
            Config: {
              Image: 'sha256:img', Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
              Env: [`ERIX_STATION_TOKEN=${TOKEN}`],
            },
            HostConfig: { Memory: 512 * 1024 * 1024, Binds: [] },
          },
        };
      }
      return { status: 404, data: null };
    },
    async createContainer() { return { status: 201, data: { Id: 'cid' } }; },
    async startContainer() { state.rebuilds += 1; return { status: 204 }; },
    async removeContainer() { return { status: 204 }; },
    async stopContainer() { return { status: 204 }; },
    async listContainers() { return { status: 200, data: [] }; },
    async listNetworks() { return { status: 200, data: [] }; },
    async removeNetwork() { return { status: 204 }; },
  };
  return { pool, docker, state };
}

test('#520 D0 reconcileDidWork：`ensured` 不算动手（拿它判活会让退避永不生效）', () => {
  assert.equal(reconcileDidWork({ ensured: 6, rebuilt: 0, orphansRemoved: 0, orphanNetworksRemoved: 0, statusUpdates: 0 }), false);
  assert.equal(reconcileDidWork({ ensured: 6, rebuilt: 1 }), true);
  assert.equal(reconcileDidWork({ statusUpdates: 1 }), true);
  assert.equal(reconcileDidWork({ orphansRemoved: 1 }), true);
  assert.equal(reconcileDidWork({ orphanNetworksRemoved: 1 }), true);
  assert.equal(reconcileDidWork({}), false, '空 stats（DB 抖成一团也没动手）⇒ 算空闲');
});

test('#520 D1 provisioner：对账无事可做 ⇒ 阶梯 5000/10000/15000/15000（上限 15s，不是 30s）', async () => {
  const fake = makeFakeSleep();
  const { pool, docker } = makeReconcileFakes({ containerExists: () => true });
  const loop = startProvisionerLoop(pool, RECONCILE_CONFIG, {
    docker, log: silentLog, sleep: fake.sleep, idleBackoffMaxMs: 15000,
  });
  for (let i = 1; i <= 4; i += 1) {
    await parkedTick(fake, i);
    fake.pass();
  }
  assert.deepEqual(fake.sleeps, [5000, 10000, 15000, 15000],
    `对账循环的空闲阶梯没跑起来：${JSON.stringify(fake.sleeps)}`);
  loop.stop();
  await loop.settled;
});

test('#520 D2 provisioner：本轮真的动手收敛了 ⇒ 回基准 5000（漂移不能被退避拖慢）', async () => {
  const fake = makeFakeSleep();
  let exists = true;
  const { pool, docker } = makeReconcileFakes({ containerExists: () => exists });
  const loop = startProvisionerLoop(pool, RECONCILE_CONFIG, {
    docker, log: silentLog, sleep: fake.sleep, idleBackoffMaxMs: 15000,
  });
  await parkedTick(fake, 1); fake.pass();
  await parkedTick(fake, 2);
  assert.equal(fake.sleeps[1], 10000, '两拍无事可做 ⇒ 已经在爬阶梯');
  exists = false; // 拍 2 停在 sleep 上时被人 `docker rm` ⇒ 拍 3 的 reconcile 会看到容器没了
  fake.pass();
  await parkedTick(fake, 3);
  assert.equal(fake.sleeps[2], 5000, '动手重建的那一拍必须回基准（漂移发现后连续收敛）');
  exists = true;
  fake.pass();
  await parkedTick(fake, 4);
  assert.equal(fake.sleeps[3], 5000, '收敛完之后从基准重新爬');
  loop.stop();
  await loop.settled;
});

test('#520 D3 provisioner：stop() 打断在睡的那一拍（同 B4 口径：不用墙钟）', async () => {
  const fake = makeFakeSleep();
  const { pool, docker } = makeReconcileFakes({ containerExists: () => true });
  const loop = startProvisionerLoop(pool, RECONCILE_CONFIG, { docker, log: silentLog, sleep: fake.sleep });
  await parkAt(fake, 3, 'provisioner');
  assert.equal(fake.sleeps[2], 15000, '已经顶到本循环的上限（15s）');
  loop.stop();
  await awaitWatchdog(loop.settled, 'provisioner');
  assert.equal(fake.parked, false);
  assert.equal(loop.failure(), null);
});

// ---------------------------------------------------------------------------
// E. reaper / drift：**反向**判据（定时语义不许被顺手退避）
// ---------------------------------------------------------------------------

function makeReaperPool() {
  return {
    purges: 0,
    reaps: 0,
    async query(sql) {
      if (sql.includes('FROM run_queue q JOIN runs r')) { this.reaps += 1; return { rows: [] }; }
      if (sql.includes('DELETE FROM idempotency_keys')) { this.purges += 1; return { rowCount: 0 }; }
      return { rows: [] };
    },
    async connect() { return { query: (sql, p) => this.query(sql, p), release() {} }; },
  };
}

test('#520 E1 reaper：每拍都是 15s，**一条都不许退避**（租约回收是定时语义）', async () => {
  const fake = makeFakeSleep();
  const pool = makeReaperPool();
  const loop = startReaperLoop(pool, { log: silentLog, sleep: fake.sleep, now: () => 1_700_000_000_000 });
  for (let i = 1; i <= 5; i += 1) {
    await parkedTick(fake, i);
    assert.equal(fake.sleeps[i - 1], 15000,
      `第 ${i} 拍睡 ${fake.sleeps[i - 1]}ms：租约 90s 的 1/6 = 15s 是崩溃后发现延迟的承诺，退避会偷走它`);
    fake.pass();
  }
  assert.ok(pool.reaps >= 5, '每拍都要真扫一次到期租约');
  loop.stop();
  await loop.settled;
});

test('#520 E2 reaper：1h 幂等键清理只按时刻判，跨闸门那一拍必跑（且只跑一次）', async () => {
  const fake = makeFakeSleep();
  let t = 1_700_000_000_000;
  const pool = makeReaperPool();
  const loop = startReaperLoop(pool, { log: silentLog, sleep: fake.sleep, now: () => t });
  await parkedTick(fake, 1); fake.pass();
  assert.equal(pool.purges, 1, '启动那一拍必跑一次清理（保持改前语义）');
  t += 30 * 60 * 1000; // 30 分钟 ⇒ 还没到 1h
  await parkedTick(fake, 2); fake.pass();
  assert.equal(pool.purges, 1, '没到 1h 不许再清（否则这条低频闸门等于没生效）');
  t += HOUR_MS;
  await parkedTick(fake, 3); fake.pass();
  assert.equal(pool.purges, 2, '跨过 1h 必须清');
  loop.stop();
  await loop.settled;
});

test('#520 E3 reaper：stop() 打断在睡的那一拍（改前是裸 setTimeout(15s)，同样不用墙钟）', async () => {
  const fake = makeFakeSleep();
  const pool = makeReaperPool();
  const loop = startReaperLoop(pool, { log: silentLog, sleep: fake.sleep }); // 节拍仍是默认 15s
  await parkedTick(fake, 1, 'reaper');
  assert.equal(fake.sleeps[0], 15000);
  loop.stop();
  await awaitWatchdog(loop.settled, 'reaper');
  assert.equal(fake.parked, false, '改前这里不可中断：stop() 会白等到多 15s');
  assert.equal(loop.failure(), null);
});

test('#520 E4 drift monitor：60s 固定周期没动，也没有空闲退避的形状', () => {
  // 盘上文件被人手改 ⇒ 没有通知源 ⇒ 周期就是发现延迟本身。这里守两件事：
  //   1) 周期常量没被顺手改小/改大（60s 是工单 §2 的口径）；
  //   2) 本模块没有退避依赖（`idleDelayMs` 出现在这里就说明有人把定时语义改成了退避）。
  assert.equal(DRIFT_INTERVAL_MS, 60_000);
  const src = fs.readFileSync(new URL('../src/routesdrift.js', import.meta.url), 'utf8');
  assert.ok(!/idleDelayMs|loop-timing/.test(src), 'drift 监控不该引入空闲退避（它是定时语义）');
  assert.ok(/clearInterval\(timer\)/.test(src) && /timer\.unref\(\)/.test(src),
    'stop() 必须 clearInterval，且定时器不许拖住进程退出');
});

test('#520 E5 drift monitor：tick 仍在跑（60s 一拍 = 最便宜的一个循环，不需要退避）', async () => {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'drift-'));
  let rounds = 0;
  const pool = {
    async query(sql) {
      if (sql.includes('FROM port_allocations')) { rounds += 1; return { rows: [] }; }
      return { rows: [] };
    },
    async connect() { return { query: (sql, p) => this.query(sql, p), release() {} }; },
  };
  const monitor = startRouteDriftMonitor(pool, { ...RECONCILE_CONFIG, traefikDynamicDir: tmp }, {
    log: silentLog, intervalMs: 20,
  });
  await monitor.tick();
  assert.ok(rounds >= 1, '一拍至少要读一次期望态');
  monitor.stop();
});

// ---------------------------------------------------------------------------
// F. 判据 4：优雅关闭仍有界（复用 #506 的 stopLoopsAndWait，不新开一套）
// ---------------------------------------------------------------------------

test('#520 F1 stopLoopsAndWait：四个循环现在都有 done（改前只能记账跳过），且退避中也能有界收尾', async () => {
  const fakes = { onboarding: makeFakeSleep(), offboarding: makeFakeSleep(), provisioner: makeFakeSleep(), reaper: makeFakeSleep() };
  const obPool = makeOnboardingPool({ claimRows: () => false });
  const offPool = makeOffboardingPool({ claimRows: () => false });
  const rec = makeReconcileFakes({ containerExists: () => true });
  const reaperPool = makeReaperPool();
  const loops = [
    { name: 'onboarding', ...startOnboardingLoop(obPool, {}, { docker: {}, log: silentLog, sleep: fakes.onboarding.sleep }) },
    { name: 'offboarding', ...startOffboardingLoop(offPool, { userSpaceRoot: tmpRoot }, { docker: {}, log: silentLog, sleep: fakes.offboarding.sleep, now: () => 1_700_000_000_000 }) },
    { name: 'provisioner', ...startProvisionerLoop(rec.pool, RECONCILE_CONFIG, { docker: rec.docker, log: silentLog, sleep: fakes.provisioner.sleep }) },
    { name: 'reaper', ...startReaperLoop(reaperPool, { log: silentLog, sleep: fakes.reaper.sleep }) },
  ];
  // 让四个循环都停在**退避中**的那一拍上（阶梯已爬过基准）；label 带名字，否则红了不知道是谁没跑起来
  const named = [
    ['onboarding', fakes.onboarding],
    ['offboarding', fakes.offboarding],
    ['provisioner', fakes.provisioner],
    ['reaper', fakes.reaper],
  ];
  for (const [name, fake] of named) {
    await parkAt(fake, 2, name);
  }
  assert.ok(fakes.onboarding.parkedMs > 5000,
    `onboarding 应停在退避上，实际 ${fakes.onboarding.parkedMs}`);
  const result = await stopLoopsAndWait(loops, { timeoutMs: 5000, log: silentLog });
  assert.deepEqual(
    { stopped: result.stopped, waited: result.waited, skipped: result.skipped, timedOut: result.timedOut, rejected: result.rejected, pending: result.pending },
    { stopped: 4, waited: 4, skipped: 0, timedOut: false, rejected: 0, pending: [] },
    '四个循环都要被等到（改前 onboarding/offboarding/provisioner/reaper 全部是 skipped）；'
    + ' `timedOut:false` 就是「退避中也能收完」的判据本身（不靠量墙钟，#531）',
  );
  for (const loop of loops) await loop.settled; // 都没留下未捕获拒绝
});

test('#520 F2 优雅关闭总预算没被改（gracefulShutdown 仍是有界那一个，本单没新开一套）', async () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  assert.ok(/gracefulShutdown\(/.test(src) && /loopTimeoutMs: SHUTDOWN_WAIT_MS/.test(src) && /totalTimeoutMs: SHUTDOWN_TOTAL_MS/.test(src),
    'cli.js 必须仍走 gracefulShutdown + 两个预算常量（#506 的口径）');
  assert.ok(!/stopLoopsAndWait\(/.test(src), 'cli.js 不许绕过 gracefulShutdown 自己等循环');
  // 7 个循环全在 shutdown 的 loops 清单里（漏一个 = 那个循环的在途事务没人等）
  for (const name of ['materializer', 'onboarding', 'offboarding', 'routes', 'routes-drift', 'provisioner', 'reaper']) {
    assert.ok(src.includes(`name: '${name}'`), `loops 清单缺 ${name}`);
  }
});
