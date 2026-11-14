// 单测：issue #506 —— 两个 outbox 消费循环（routes / materializer）的**空闲退避**。
//
// 判据形状：不是「代码里有没有 sleep」，而是**观察到的 sleep 数字序列**与**孤儿回收的调用次数**。
// 所以这里注入假时钟（`sleep` / `now` 由测试驱动，一秒真时间都不等），只有「退避等待中关闭」
// 那两条反过来用**真 setTimeout + 真 AbortController**（那条判据测的正是可中断性本身，
// 拿假 sleep 测等于测夹具）。
//
// 隔离约定（docs/testing.md §2.1）：fake pool + 临时目录，不碰真实 DB / /srv/erix / Traefik 目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  startRoutesLoop,
  runRoutesOnce,
  idleDelayMs as routesIdleDelayMs,
  sleepCancellable as routesSleepCancellable,
} from '../src/routes.js';
import {
  startMaterializerLoop,
  runMaterializerOnce,
  idleDelayMs as materializerIdleDelayMs,
  sleepCancellable as materializerSleepCancellable,
} from '../src/materializer.js';

// ---------------------------------------------------------------------------
// 假时钟：`sleep(ms, signal)` 把这一拍的等待挂起来，由测试决定「什么时候放行 / 假时钟走多久」。
// 循环里两件事都靠它：退避时长（`idleDelayMs` 的结果）与孤儿回收的时间戳（`now()`）。
// ---------------------------------------------------------------------------

function makeFakeClock() {
  const clock = {
    nowMs: 0,
    sleeps: [], // 观察到的 sleep 毫秒序列（判据 1/2 直接断言它）
    pending: null, // { ms, finish(ok) }
  };
  const now = () => clock.nowMs;

  const sleep = (ms, signal) => new Promise((resolve) => {
    clock.sleeps.push(ms);
    const entry = { ms, done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (clock.pending === entry) clock.pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    clock.pending = entry;
  });

  /** 让循环跑到「停在某一拍的等待上」（假时钟不动，只放行微任务/宏任务）。 */
  async function arm() {
    for (let i = 0; i < 300 && !clock.pending; i += 1) await new Promise((r) => setImmediate(r));
    assert.ok(clock.pending, '循环必须停在某一拍的 sleep 上（没停住 = 循环抛错或已经退了）');
  }

  /** 放行当前这一拍：假时钟按它请求的毫秒数前进，然后等下一拍挂起。返回这一拍的 sleep 毫秒。 */
  async function release() {
    const entry = clock.pending;
    assert.ok(entry, '没有挂起的 sleep 可放行');
    clock.pending = null;
    clock.nowMs += entry.ms;
    entry.finish(true);
    await arm();
    return entry.ms;
  }

  return { clock, now, sleep, arm, release };
}

/** 一个 SQL 流水（`statements`）+ 认领计划（`claimPlan[i]` = 第 i 拍认领几行）的 fake pool。 */
class LoopFakePool {
  constructor({ table, claimPlan = [] }) {
    this.table = table; // route_outbox / materialize_outbox
    this.claimPlan = claimPlan;
    this.statements = [];
    this.claims = 0; // 认领事务跑了几拍（= 循环拍了多少拍）
    this.orphanRecoveries = 0; // recover*Orphans 那条 UPDATE 跑了几次
    this.publishedMarks = 0; // mark*Published 的按行 UPDATE 次数（证明退避没把活吞掉）
  }

  claimRows() {
    return this.claimPlan[this.claims] ?? 0;
  }

  #rowsForClaim() {
    const n = this.claimRows();
    this.claims += 1;
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(this.table === 'route_outbox'
        // routes 的 RETURNING 形状（claimRouteRows）
        ? { id: `row-${this.claims}-${i}`, aggregate: 'port_allocation', aggregate_id: '11111111-1111-1111-1111-111111111111', revision: 1, op: 'upsert' }
        // materializer 的 RETURNING 形状（claimMaterializeRows）
        : { id: `row-${this.claims}-${i}`, fde_id: 'u1', revision: 1, op: 'upsert' });
    }
    return { rows };
  }

  #dispatch(sql) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    // recover*Orphans：SET state = 'pending' ... WHERE state = 'processing' AND lease_until < now()
    if (sql.includes(this.table) && sql.includes("SET state = 'pending'") && sql.includes('lease_until < now()')) {
      this.orphanRecoveries += 1;
      return { rows: [] };
    }
    // 认领事务里的第二条 UPDATE（把 head 行置 processing）
    if (sql.includes(this.table) && sql.includes("SET state = 'processing'")) return this.#rowsForClaim();
    if (sql.includes(this.table) && sql.includes('WHERE id = $1')) {
      this.publishedMarks += 1;
      return { rows: [] };
    }
    return { rows: [] };
  }

  async query(sql, params = []) {
    this.statements.push({ sql, params });
    return this.#dispatch(sql);
  }

  async connect() {
    const self = this;
    return {
      query: async (sql, params = []) => { self.statements.push({ sql, params }); return self.#dispatch(sql); },
      release: () => {},
    };
  }
}

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ROUTES_CONFIG = (dir) => ({
  portalHost: 'station.localhost',
  portalBackendUrl: 'http://127.0.0.1:18080',
  traefikEntryPoint: 'web',
  llmHost: 'llm.localhost',
  llmGatewayUrl: 'http://station-litellm:4000',
  traefikDynamicFile: 'routes.yml',
  traefikLlmDynamicFile: 'llm-routes.yml',
  traefikDynamicDir: dir,
});

const MATERIALIZER_CONFIG = (root) => ({
  userSpaceRoot: root,
  llmPublicBaseUrl: 'http://llm.localhost:8090',
  baseDomain: 'localhost',
});

const QUIET_LOG = { warn: () => {}, error: () => {}, log: () => {} };

/** 两套循环的公共入口（本文件的判据必须**两边都跑一遍**，不许只测一个）。 */
const SUITES = [
  {
    name: 'routes',
    start(pool, opts) {
      const dir = tmpdir('routes-506-');
      const loop = startRoutesLoop(pool, ROUTES_CONFIG(dir), { log: QUIET_LOG, ...opts });
      return { loop, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    },
    pool: (claimPlan) => new LoopFakePool({ table: 'route_outbox', claimPlan }),
    idleDelayMs: routesIdleDelayMs,
    sleepCancellable: routesSleepCancellable,
  },
  {
    name: 'materializer',
    start(pool, opts) {
      const root = tmpdir('mat-506-');
      const loop = startMaterializerLoop(pool, MATERIALIZER_CONFIG(root), { log: QUIET_LOG, ...opts });
      return { loop, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
    },
    pool: (claimPlan) => new LoopFakePool({ table: 'materialize_outbox', claimPlan }),
    idleDelayMs: materializerIdleDelayMs,
    sleepCancellable: materializerSleepCancellable,
  },
];

// ---------------------------------------------------------------------------
// 用例 0：纯函数侧的阶梯与旋钮默认值（把「默认值就是生产值」钉住）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} 退避阶梯：0 行 ⇒ 250,500,1000,2000,2000；上限可配且非法值回落默认`, () => {
    const ladder = [0, 1, 2, 3, 4, 5, 9].map((idleTicks) => suite.idleDelayMs(idleTicks));
    assert.deepEqual(ladder, [250, 250, 500, 1000, 2000, 2000, 2000],
      'idleTicks=0（上一拍有活）必须回 250；连续空拍 250→500→1000→2000 封顶（issue #506 定的阶梯）');

    // 旋钮生效：上限调小 ⇒ 阶梯被夹住（不是只写在注释里）
    assert.deepEqual([1, 2, 3, 4].map((n) => suite.idleDelayMs(n, 500)), [250, 500, 500, 500]);
    // 上限也必须能调大（真要把退避放宽时别被 2000 硬编码挡住）
    assert.deepEqual([1, 2, 3, 4, 5].map((n) => suite.idleDelayMs(n, 30000)), [250, 500, 1000, 2000, 4000]);
  });
}

test('#506 生产默认值：退避上限 2000ms / 孤儿回收 10000ms（代码默认 = 工单定的生产值）', () => {
  // 走源码字面量：这两个数字是「上线后的预期读数」的算式输入，改了必须连带改文档与预期值。
  for (const file of ['../src/routes.js', '../src/materializer.js']) {
    const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
    const max = /const IDLE_BACKOFF_MAX_MS_DEFAULT = (\d+);/.exec(src);
    const orphan = /const ORPHAN_RECOVERY_INTERVAL_MS_DEFAULT = (\d+);/.exec(src);
    assert.ok(max, `${file} 必须用命名常量声明空闲退避上限`);
    assert.equal(Number(max[1]), 2000, `${file}：空闲退避上限默认必须是 2000`);
    assert.ok(orphan, `${file} 必须用命名常量声明孤儿回收间隔`);
    assert.equal(Number(orphan[1]), 10000, `${file}：孤儿回收间隔默认必须是 10000`);
    for (const env of file.includes('routes')
      ? ['ROUTE_IDLE_BACKOFF_MAX_MS', 'ROUTE_ORPHAN_RECOVERY_INTERVAL_MS']
      : ['MATERIALIZE_IDLE_BACKOFF_MAX_MS', 'MATERIALIZE_ORPHAN_RECOVERY_INTERVAL_MS']) {
      assert.ok(src.includes(env), `${file} 必须读 env ${env}（工单要求可配）`);
    }
  }
});

// ---------------------------------------------------------------------------
// 用例 1：空闲退避序列（判据 = 观察到的 sleep 数字序列）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} 空闲退避序列：连续空拍上观察到的 sleep 恰为 250,500,1000,2000,2000,2000`, async () => {
    const fakes = makeFakeClock();
    const pool = suite.pool([0, 0, 0, 0, 0, 0, 0]); // 每拍认领 0 行
    const { loop, cleanup } = suite.start(pool, { sleep: fakes.sleep, now: fakes.now });
    try {
      await fakes.arm();
      const observed = [];
      for (let i = 0; i < 6; i += 1) observed.push(await fakes.release());
      assert.deepEqual(observed, [250, 500, 1000, 2000, 2000, 2000],
        `空转时必须按阶梯退避；实测 ${observed.join(',')}（改前是六个 250 —— 26.4 事务/秒就是这么来的）`);
      // 认领事务仍然每拍在跑（退避只拉长等待，没有跳过消费 = 不改协议）
      assert.equal(pool.claims, 7, '每一拍照常跑一次 claim（退避不许变成「少查一次」，那是语义改动）');
    } finally {
      loop.stop();
      fakes.clock.pending?.finish(true);
      await loop.done;
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// 用例 2：有活立刻复位（吞吐一秒不让）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} 有活立刻复位：退避到 2000 后认领到 1 行 ⇒ 下一拍 sleep 回到 250（并从阶梯头重长）`, async () => {
    const fakes = makeFakeClock();
    // 5 拍空转（退避爬到 2000）→ 第 6 拍认领到 1 行 → 之后继续空转
    const pool = suite.pool([0, 0, 0, 0, 0, 1, 0, 0, 0]);
    const { loop, cleanup } = suite.start(pool, { sleep: fakes.sleep, now: fakes.now });
    try {
      await fakes.arm();
      const observed = [];
      for (let i = 0; i < 9; i += 1) observed.push(await fakes.release());
      assert.equal(observed[4], 2000, `第 5 拍应当已经退避到 2000（实测前 5 拍 ${observed.slice(0, 5).join(',')}）`);
      assert.equal(observed[5], 250,
        `认领到 1 行的那一拍之后必须回 250ms（实测 ${observed.join(',')}）—— 有积压时吞吐不许被退避拖慢`);
      assert.deepEqual(observed.slice(5), [250, 250, 500, 1000],
        '复位必须回到阶梯头重长（实测尾部序列），不是粘在 2000 上');

      // 认领到的行照常走完发布链路（退避不得吞活）
      assert.equal(pool.publishedMarks, 1, '认领到的那一行必须被 mark*Published（协议没动）');
    } finally {
      loop.stop();
      fakes.clock.pending?.finish(true);
      await loop.done;
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// 用例 3：孤儿回收走独立节拍（一条与「有没有活」无关的 UPDATE，不该每拍陪跑）
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} 孤儿回收按独立节拍：模拟 60s 空转 ⇒ 回收约 6 次（改前 240 次），而拍数 ~34`, async () => {
    const fakes = makeFakeClock();
    const pool = suite.pool([]); // 永远认领 0 行
    const { loop, cleanup } = suite.start(pool, { sleep: fakes.sleep, now: fakes.now });
    try {
      await fakes.arm();
      let steps = 0;
      while (fakes.clock.nowMs < 60_000 && steps < 200) {
        await fakes.release();
        steps += 1;
      }
      const { orphanRecoveries, claims } = pool;
      // 理论值：阶梯爬到 2000 后一拍 2s ⇒ 60s 约 34 拍；回收每 10s 一次 ⇒ 7 次（t=0 那次含在内）。
      assert.ok(claims >= 28 && claims <= 40, `60s 空转的拍数应在 ~34（实测 ${claims}）`);
      assert.ok(orphanRecoveries >= 5 && orphanRecoveries <= 8,
        `孤儿回收应每 10s 一次 ⇒ 60s 里 ~7 次（实测 ${orphanRecoveries}）；改前是**每拍一条** = ${claims} 次`);
      assert.ok(orphanRecoveries * 3 < claims,
        `回收次数必须远低于拍数（实测 ${orphanRecoveries} vs ${claims}），否则退避收益被这条 UPDATE 吃掉`);
      // 首拍必跑一次：崩溃恢复语义没动（进程一起来就回收 processing 孤儿）
      assert.ok(orphanRecoveries >= 1, '启动/首拍必须至少回收一次孤儿');
      // 语句总量：60s 空转的往返（改前 ~240 拍 × ~5 条 ≈ 1200 条）
      assert.ok(pool.statements.length < 300,
        `60s 空转的 DB 往返应远小于改前的 ~1200 条（实测 ${pool.statements.length} 条）`);
    } finally {
      loop.stop();
      fakes.clock.pending?.finish(true);
      await loop.done;
      cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// 用例 4：退避等待中 stop() ⇒ 立刻返回
// 这条**故意不用假时钟**：判据是「真 timer 被真 AbortController 打断」，用假 sleep 就成了自证。
// ---------------------------------------------------------------------------

for (const suite of SUITES) {
  test(`#${suite.name} 关闭不等待：退避等待中 stop() ⇒ 循环立刻退出（真 timer + 真 AbortController）`, async () => {
    const slept = [];
    const sleep = (ms, signal) => {
      slept.push(ms);
      return suite.sleepCancellable(ms, signal); // 生产实现本身，不是替身
    };
    const pool = suite.pool([]);
    const { loop, cleanup } = suite.start(pool, { sleep }); // now 不注入 ⇒ 真 Date.now
    try {
      await new Promise((r) => setTimeout(r, 2200));
      const last = slept.at(-1);
      assert.ok(last >= 1000, `必须已经退避到 ≥1000ms 的等待里才谈得上「等待中关闭」（实测序列 ${slept.join(',')}）`);
      const t0 = Date.now();
      loop.stop();
      await loop.done;
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 250,
        `stop() 后 ${elapsed}ms 才退出；这一拍还剩约 ${Math.max(0, last - 100)}ms 没睡完 ⇒ sleep 不可中断（改前必挂在这）`);
    } finally {
      cleanup();
    }
  });
}

test('#506 sleepCancellable：abort 立刻 resolve(false)，不 abort 才 resolve(true)', async () => {
  for (const sleepCancellable of [routesSleepCancellable, materializerSleepCancellable]) {
    const ac = new AbortController();
    const started = Date.now();
    const p = sleepCancellable(30_000, ac.signal);
    setTimeout(() => ac.abort(), 10);
    assert.equal(await p, false, 'abort 必须让等待以 false 结束（循环靠它 break）');
    assert.ok(Date.now() - started < 500, 'abort 后必须立刻返回，而不是等满 30s');

    // 已经 abort 的 signal 进去 ⇒ 一次 timer 都不建（stop 之后再进循环也不许等）
    const ac2 = new AbortController();
    ac2.abort();
    assert.equal(await sleepCancellable(30_000, ac2.signal), false, '已 abort 的 signal 必须立即返回');

    assert.equal(await sleepCancellable(5, undefined), true, '没有 signal 时照常睡满并返回 true');
  }
});

test('#506 sleep 被取消时循环必须**退出**而不是再跑一拍（把 `if (!(await sleep(...))) break` 钉住）', async () => {
  // 假 sleep 直接当作「被 stop() 打断」立即 resolve(false)：循环必须就此收摊。
  // 少了那个 break ⇒ `while (!signal.aborted)` 条件早已为真 ⇒ 这一拍之后无限空转 ⇒ done 永不 resolve。
  for (const suite of SUITES) {
    const pool = suite.pool([]);
    const { loop, cleanup } = suite.start(pool, { sleep: async () => false, now: () => 0 });
    try {
      const settled = await Promise.race([
        loop.done.then(() => 'exited'),
        new Promise((r) => setTimeout(() => r('timeout'), 2000)),
      ]);
      assert.equal(settled, 'exited', `${suite.name}：sleep 报「被取消」后循环没退（done 不 resolve）⇒ 取消会退化成无限空转`);
      assert.equal(pool.claims, 1, `${suite.name}：退出一拍都不得再跑（实测认领 ${pool.claims} 次）`);
    } finally {
      loop.stop();
      await loop.done;
      cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// 认领计数信号：run*Once 必须把「这一轮认领了几行」交回给循环（退避的输入）
// ---------------------------------------------------------------------------

test('#506 runRoutesOnce 返回 claimed（0 行与 >0 行都报数），runMaterializerOnce 同口径', async () => {
  const dir = tmpdir('routes-506-claimed-');
  try {
    assert.deepEqual(await runRoutesOnce(new LoopFakePool({ table: 'route_outbox', claimPlan: [0] }), ROUTES_CONFIG(dir), { log: QUIET_LOG }),
      { processed: 0, claimed: 0 }, '空拍必须报 claimed:0（循环靠它决定退避）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const root = tmpdir('mat-506-claimed-');
  try {
    const r = await runMaterializerOnce(new LoopFakePool({ table: 'materialize_outbox', claimPlan: [0] }), MATERIALIZER_CONFIG(root), { log: QUIET_LOG });
    assert.equal(r.claimed, 0, 'materializer 同样要报 claimed:0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
