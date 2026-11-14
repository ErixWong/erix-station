// 单测：issue #506 的 copilot **第四轮（最终验收）复审① + ②**（都在 `portal/src/shutdown.js` 的
//   退出前刷日志那一步）：
//   ① flush 排在总预算**之外**，于是「整个关闭流程 ≤ totalTimeoutMs」这条承诺其实是假的；
//   ② `write(chunk, cb)` 的回调**不看 err**，于是已 destroy / EPIPE 的流会被记成「刷到了」。
// 以及 **第五轮复审（506f）**：① 的修法留下一个尾巴——总 deadline 获胜时剩余预算恒为 0
//   ⇒ flush 退化成 `setTimeout(0)` ⇒ 到点强退那条 warn **仍可能**被截断；修法是**从总预算里**
//   给 flush 切一块预留（见下面 ⑤ 节）。
//
// 缺陷形状（现查 `portal/src/shutdown.js`，改前的第 4 步）：
//   const outcome = await Promise.race([everything, deadline]);
//   if (timer) clearTimeout(timer);
//   const elapsedMs = Date.now() - startedAt;      // ← 账目在这里就结算了
//   … warn / 汇总日志 …
//   flushReport = await flush({ timeoutMs: flushTimeoutMs });   // ← **又等一段**，且不受总上限约束
//   exit(report.exitCode);
// 三个后果：
//   1. 到点强退的实际情况是「等满 totalTimeoutMs，**再**等最多 flushTimeoutMs」⇒ 总上限被突破
//      （compose/k8s 的宽限期是按整个流程算的，不是按其中一段）；
//   2. `report.elapsedMs` 在 flush **之前**算 ⇒ 上报耗时少一段，看日志的人对不上账；
//   3. `flushTimeoutMs` 是调用方传的：传 `3e9` 就是等约 **24.9 天**（夹取后的 Node timer 上限）——
//      「有上限的关闭」在这一步又变回没有上限。
//
// 判据形状（都用注入的短数值，不真等）：
//   · 注入很小的 `totalTimeoutMs` + **永不回调**的流 ⇒ 关闭**总耗时** ≤ `totalTimeoutMs` + 小余量；
//   · 注入一个**延迟回调**的流 ⇒ `report.elapsedMs` 必须**含**那一段延迟；
//   · 注入 flush spy ⇒ 拿到的 `timeoutMs` 必须是「min(请求值, 剩余预算)」，不是请求值本身。
// 红线：`exit` 一律注入 spy（真跑 process.exit 会杀掉测试进程）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  gracefulShutdown,
  flushLogs,
  FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  FLUSH_RESERVE_MS_DEFAULT,
} from '../src/shutdown.js';

function recordingLog() {
  const warns = [];
  const logs = [];
  return { warns, logs, warn: (m) => warns.push(String(m)), error: () => {}, log: (m) => logs.push(String(m)) };
}

const settled = () => Promise.resolve();
const forever = () => new Promise(() => {});

/** 假 HTTP server：`neverCallback` 模拟 SSE keep-alive（close 回调一直不来）。 */
function fakeServer(events, { neverCallback = false } = {}) {
  return {
    closeCalls: 0,
    close(cb) {
      this.closeCalls += 1;
      events.push('server.close');
      if (!neverCallback) setImmediate(() => cb(null));
    },
  };
}

/**
 * 假输出流：`delayMs` 模拟「管道还在排空」（回调延迟才来）；
 * `neverCallback` 模拟「永远刷不动」（本单计时判据用的就是它——上限没生效就会一直等）。
 */
function fakeStream(events, { neverCallback = false, delayMs = 0 } = {}) {
  return {
    chunks: 0,
    write(chunk, cb) {
      this.chunks += 1;
      events.push('flush');
      if (neverCallback) return;
      if (delayMs > 0) setTimeout(() => cb(), delayMs);
      else setImmediate(() => cb());
    },
  };
}

/** 跑一次关闭，返回报告 + 从**外面**量到的真实耗时（两者不一致就是本单的缺陷本体）。 */
async function run(makeOpts) {
  const events = [];
  const exits = [];
  const log = recordingLog();
  const opts = typeof makeOpts === 'function' ? makeOpts(events) : makeOpts;
  const t0 = Date.now();
  const report = await gracefulShutdown({
    exit: (code) => { events.push('exit'); exits.push(code); },
    log,
    ...opts,
  });
  return { report, exits, log, events, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// ① 总上限是**硬**的：flush 不许在总预算之外再等一段
// ---------------------------------------------------------------------------

test('#506e① 到点强退不再额外等 flushTimeoutMs：总耗时 ≤ totalTimeoutMs + 小余量', async () => {
  // 循环永不 resolve + server close 永不回调 + 流永不回调 ⇒ 唯一的出口就是总上限。
  // 改前：总上限 60ms 到点后**又**等满 flushTimeoutMs=1500ms ⇒ 实测 ~1560ms，本用例红。
  const { report, exits, ms } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'routes', stop() {}, done: forever() }],
    loopTimeoutMs: 4000,
    totalTimeoutMs: 60,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 1500,
  }));
  assert.equal(report.timedOut, true, '本条走的必须是总上限分支（否则测不到复审报的那条路径）');
  assert.deepEqual(exits, [0], '照样 exit(0)');
  assert.ok(ms <= 60 + 150,
    `总耗时必须贴着总上限（实测 ${ms}ms / 总上限 60ms，flush 请求值 1500ms）——改前 flush 在总预算之外，实测 ~1560ms`);
  assert.ok(ms >= 55, `总上限本身还是要走完（实测 ${ms}ms），不许顺手把它缩短成「早早退出」`);
  assert.ok(report.flushTimeoutMs <= 60,
    `实际生效的 flush 上限必须是**剩余预算**（实测 ${report.flushTimeoutMs}ms），不是请求值 1500ms`);
  assert.equal(report.flush.attempted, 1, '预算用尽也照样**发起**刷日志（write 本身仍会把已排队的字节推下去）');
});

test('#506e① flushTimeoutMs=3e9 也不再等到天荒地老（改前是 ~24.9 天：夹取后的 timer 上限）', async () => {
  const { report, exits, ms } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'materializer', stop() {}, done: forever() }],
    loopTimeoutMs: 3000,
    totalTimeoutMs: 40,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 3e9, // 运维把「刷日志上限」配成一个巨大的数
  }));
  assert.deepEqual(exits, [0]);
  assert.ok(ms <= 40 + 150,
    `总耗时仍要贴着总上限（实测 ${ms}ms）——改前这里会等 min(3e9, Node timer 上限) ≈ 24.9 天`);
  assert.ok(report.flushTimeoutMs <= 40, `生效的 flush 上限是剩余预算（实测 ${report.flushTimeoutMs}ms）`);
});

test('#506e① flush 拿到的是「剩余预算」而不是请求值；预算充足时请求值照常生效', async () => {
  const seen = [];
  const flushSpy = async (o) => {
    seen.push(o.timeoutMs);
    return { attempted: 0, flushed: 0, stuck: 0, failed: 0, errors: [], elapsedMs: 0 };
  };
  // A) 预算几乎用尽 ⇒ 传给 flush 的超时≈0
  const a = await run(() => ({
    server: fakeServer([]),
    loops: [{ name: 'routes', stop() {}, done: forever() }],
    loopTimeoutMs: 3000,
    totalTimeoutMs: 50,
    flushTimeoutMs: FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
    flush: flushSpy,
  }));
  assert.equal(seen.length, 1);
  assert.ok(seen[0] <= 50, `剩余预算用尽时只能给剩下那一点（实测 ${seen[0]}ms，请求值 250ms）`);
  assert.equal(a.report.flushTimeoutMs, seen[0], '账目里的 flush 上限 = **实际生效**的那个数');
  // B) 预算充足 ⇒ min(请求值, 剩余) = 请求值，正常路径的行为不许被改坏
  const b = await run(() => ({
    server: fakeServer([]),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 5000,
    flushTimeoutMs: FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
    flush: flushSpy,
  }));
  assert.equal(seen[1], FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
    `预算够的时候请求值照常生效（实测 ${seen[1]}ms）——修法是「不突破总上限」，不是「一律不等」`);
  assert.equal(b.report.timedOut, false);
});

// ---------------------------------------------------------------------------
// ② report.elapsedMs 必须**含** flush 那一段
// ---------------------------------------------------------------------------

test('#506e② report.elapsedMs 含刷日志那一段（改前它在 flush 之前结算，账目少一段）', async () => {
  const FLUSH_DELAY = 120;
  const { report, ms } = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 5000, // 预算充足 ⇒ 这条只测「账目含不含 flush」，不测总上限
    logStreams: [fakeStream(ev, { delayMs: FLUSH_DELAY })],
    flushTimeoutMs: 1000,
  }));
  assert.ok(ms >= FLUSH_DELAY, `夹带：延迟回调的流确实被等了（实测总耗时 ${ms}ms）`);
  assert.ok(report.elapsedMs >= ms - 20,
    `report.elapsedMs 必须**含** flush 那一段（上报 ${report.elapsedMs}ms / 真实 ${ms}ms）——改前上报的是 flush 之前的值，约 ${ms - FLUSH_DELAY}ms`);
  assert.ok(report.elapsedMs <= ms + 20, `也不许虚报（上报 ${report.elapsedMs}ms / 真实 ${ms}ms）`);
  assert.equal(report.flush.flushed, 1, '延迟但最终刷到了 ⇒ 仍记 flushed');
});

test('#506e② 汇总日志说明「用时」是刷日志前的口径（不假装含 flush）', async () => {
  const { log, report } = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 3000,
    logStreams: [fakeStream(ev, { delayMs: 60 })],
    flushTimeoutMs: 500,
  }));
  const line = log.logs.join('\n');
  assert.match(line, /关闭收尾/, '运维汇总行不许丢');
  assert.match(line, /刷日志前/, '汇总行在 flush **之前**记（否则它自己不会被刷），口径要写明，别和 report.elapsedMs 打架');
  assert.ok(report.elapsedMs >= 60, `返回账目含 flush（实测 ${report.elapsedMs}ms）`);
});

// ---------------------------------------------------------------------------
// ③ flushLogs 自己的超时仍然可信（剩余预算=0 时不许变成「等回调」）
// ---------------------------------------------------------------------------

test('#506e③ flushLogs(timeoutMs=0) 对永不回调的流立刻返回 stuck（总预算用尽时靠的就是它）', async () => {
  const ev = [];
  const t0 = Date.now();
  const out = await flushLogs({ timeoutMs: 0, streams: [fakeStream(ev, { neverCallback: true })] });
  const waited = Date.now() - t0;
  assert.equal(out.attempted, 1, '照样发起 write');
  assert.equal(out.flushed, 0);
  assert.ok(waited < 100, `不许等回调（实测 ${waited}ms）——「不等」是修法的一部分`);
});

// ---------------------------------------------------------------------------
// 源码钉：顺序 + 结算点
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ④ write 回调的 err 必须看（copilot 第四轮复审②）
// ---------------------------------------------------------------------------

/** 模拟「已 destroy / EPIPE 的流」：`write` 当场以**回调错误**返回（不抛）。 */
function errCallbackStream(events, message = 'EPIPE: broken pipe') {
  return {
    chunks: 0,
    write(chunk, cb) {
      this.chunks += 1;
      events.push('flush');
      cb(new Error(message)); // Node 对已 destroy 的流就是这么返回的
    },
  };
}

test('#506e② write 回调带 err ⇒ 记 failed，不许记成 flushed（日志不许假称「刷了」）', async () => {
  const bad = errCallbackStream([]);
  const out = await flushLogs({ timeoutMs: 50, streams: [bad] });
  assert.equal(out.attempted, 1);
  assert.equal(out.flushed, 0,
    `回调带 err 就不是「刷到了」（实测 ${JSON.stringify(out)}）——改前回调不看参数，这里会记 flushed=1`);
  assert.equal(out.failed, 1, `要单独数得出失败数（实测 ${JSON.stringify(out)}）`);
  assert.equal(out.stuck, 0, '失败不是「到点没回调」，两种坑不许挤在同一个字段里');
  assert.equal(out.errors.length, 1, '账目里要能点名那条错误');
  assert.match(out.errors.join('|'), /EPIPE/, `实测 ${JSON.stringify(out.errors)}`);
  assert.match(out.errors.join('|'), /stream#0/, '要点名是哪一条流');

  // `cb(null)` / `cb()` 仍是刷到了：严格不等于「一律不信回调」
  const okish = await flushLogs({ timeoutMs: 50, streams: [{ write: (c, cb) => cb(null) }, { write: (c, cb) => cb() }] });
  assert.equal(okish.flushed, 2, `无 err 的回调照常算 flushed（实测 ${JSON.stringify(okish)}）`);
  assert.equal(okish.failed, 0);
  assert.deepEqual(okish.errors, []);

  // 三种结局同场：账必须加得起来
  const ev = [];
  const mixed = await flushLogs({
    timeoutMs: 60,
    streams: [fakeStream(ev), errCallbackStream(ev, 'ERR_STREAM_DESTROYED'), fakeStream(ev, { neverCallback: true })],
  });
  assert.deepEqual(
    { attempted: mixed.attempted, flushed: mixed.flushed, failed: mixed.failed, stuck: mixed.stuck },
    { attempted: 3, flushed: 1, failed: 1, stuck: 1 },
    `一条刷到 / 一条失败 / 一条卡住要分得清（实测 ${JSON.stringify(mixed)}）`,
  );
  assert.equal(mixed.flushed + mixed.failed + mixed.stuck, mixed.attempted, '三种结局必须刚好覆盖 attempted');
  assert.match(mixed.errors.join('|'), /ERR_STREAM_DESTROYED/);
});

test('#506e② gracefulShutdown：写失败的流不记成刷到，并在日志里点名，但仍照样 exit(0)', async () => {
  const { report, exits, log } = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 3000,
    logStreams: [errCallbackStream(ev), fakeStream(ev)], // stderr 坏了 + stdout 好的
    flushTimeoutMs: 100,
  }));
  assert.deepEqual(exits, [0], '刷失败不许变成不退');
  assert.equal(report.flush.attempted, 2);
  assert.equal(report.flush.flushed, 1, '好的那条仍算刷到');
  assert.equal(report.flush.failed, 1, `坏的那条必须记 failed（实测 ${JSON.stringify(report.flush)}）`);
  const line = log.warns.join('\n');
  assert.match(line, /没刷成/, '要在日志里看得见「有一条没刷到」，否则运维以为那条 warn 已落盘');
  assert.match(line, /EPIPE/, `要点名是哪个错（实测 ${line}）`);
  assert.equal(log.warns.filter((m) => /总上限/.test(m)).length, 0, '本条没走到总上限，不许误报');
});

test('#506e② 源码钉：刷日志的账目里有 failed / errors 两个口径', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  assert.match(s, /finish\(err \? 'failed' : 'flushed', err \?\? null\)/, '回调必须收 err 并分流到 failed');
  assert.match(s, /catch \(err\) \{\s*\n\s*finish\('failed', err/, 'write 当场抛也算 failed（与回调带 err 同类）');
  assert.match(s, /stuck: results\.length - flushed - failed/, 'stuck 必须是「剩下的」，不能把失败也算成卡住/刷到');
  assert.match(s, /errors,/, '返回账目要带 errors（给日志点名用）');
});

test('#506e 源码钉：flush 的超时取剩余预算，elapsedMs 在 flush 之后结算', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  const remainingAt = s.search(/const remainingMs = Math\.max\(0, totalBudgetMs - \(Date\.now\(\) - startedAt\)\)/);
  // 506f 把取小写成 `Math.min(flushRequestedMs, Math.max(remainingMs, 0))`（防 deadline timer 晚触发压成负数）
  // ⇒ 两种写法都认：本条要钉的是「取小」这个口径，不是括号多一层。
  const budgetAt = s.search(/const flushBudgetMs = Math\.min\(flushRequestedMs, (?:Math\.max\(remainingMs, 0\)|remainingMs)\)/);
  const flushAt = s.search(/flushReport = await flush\(\{ timeoutMs: flushBudgetMs/);
  const exitAt = s.search(/exit\(report\.exitCode\)/);
  const settleAt = s.search(/report\.elapsedMs = Date\.now\(\) - startedAt/);
  assert.ok(remainingAt >= 0, '必须有「剩余预算」这一步（总预算用尽 ⇒ 0）');
  assert.ok(budgetAt >= 0 && budgetAt > remainingAt, 'flush 上限必须是 min(请求值, 剩余预算)');
  assert.ok(flushAt >= 0 && flushAt > budgetAt, '传给 flush 的必须是 flushBudgetMs，不是 flushTimeoutMs 请求值');
  assert.ok(exitAt >= 0 && flushAt < exitAt, '仍然是「先刷再退」');
  assert.ok(settleAt >= 0 && settleAt > flushAt, 'report.elapsedMs 必须在 flush **之后**重算（含那一段）');
  assert.doesNotMatch(s, /await flush\(\{ timeoutMs: flushTimeoutMs/, '不许再把未夹取剩余预算的请求值直接喂给 flush');
  assert.match(s, /flush 在总预算之内，不是额外赠送的 250ms/, '注释要写清这条预算口径');
});

// ---------------------------------------------------------------------------
// ⑤ 第五轮复审（506f）：总 deadline 获胜时，flush 手上必须还剩**正**预算
// ---------------------------------------------------------------------------
//
// 缺陷形状（第四轮那个修法留下的尾巴，现查 `portal/src/shutdown.js`）：
//   race 的 deadline 用的就是 `totalBudgetMs` 本身 ⇒ 它获胜的那一刻 `Date.now() - startedAt`
//   已经贴着总预算 ⇒ 第 4 步现算的 `remainingMs = 0` ⇒ `flushBudgetMs = min(请求值, 0) = 0`
//   ⇒ `flushLogs` 走 `setTimeout(0)` 那一支，**先于**流的 write 回调触发
//   ⇒ 「到点强退」那条 warn 与汇总行**仍然可能被截断**——而这恰恰是最需要看日志的那一次。
//   等于把第三轮（`3d27606`）「退出前刷日志」的修复，在最需要它的那条路径上抵消掉。
//
// 修法（也是本节的判据）：给 flush **预留**一块正等待时间，且这块是**从总预算里切出来的**
// （race 的 deadline 改成 `总预算 - 预留`），**不是额外赠送** ⇒ 总耗时上限一字不改。
// 红线：`exit` 注入 spy；三条都用短数值（不真等 8s）。

test('#506f 到点强退路径：flush 拿到的是「预留」那一块（不再是 0），总耗时仍 ≤ totalTimeoutMs + 小余量', async () => {
  const TOTAL = 300;
  const RESERVE = 100;
  const seen = [];
  // 循环永不 resolve + close 永不回调 + 流**永不回调** ⇒ 唯一的出口是总 deadline，
  // 而 flush 手上剩多少，直接决定那条 warn 有没有机会落盘。
  const { report, exits, ms } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'routes', stop() {}, done: forever() }],
    loopTimeoutMs: 4000, // 故意远大于总上限：起作用的是总预算，不是循环那一段
    totalTimeoutMs: TOTAL,
    flushReserveMs: RESERVE,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 1500, // 请求值远大于预留 ⇒ 生效值必然是「剩余预算」
  }));
  assert.equal(report.timedOut, true, '本条必须走总 deadline 分支（否则测不到复审报的那条路径）');
  assert.deepEqual(exits, [0], '照样 exit(0)');
  assert.equal(report.loopsBudgetMs, TOTAL - RESERVE,
    `race 的预算必须是「总预算 - 预留」（实测 ${report.loopsBudgetMs}）——预留是从总预算里**切**出来的`);
  assert.equal(report.flushReserveMs, RESERVE, `预留要落进账目（实测 ${report.flushReserveMs}）`);
  // 核心判据：flush 的预算不再退化成 0。容差是给 timer 溢出留的：deadline 会比预算**晚** 1~3ms
  // （CI 负载下几十 ms）触发，那一点溢出正好从 remaining 里扣掉。改前这里是**恰好 0**，容差不影响判别。
  assert.ok(report.flushTimeoutMs > 0,
    `到点强退时 flush 的预算不许再是 0（实测 ${report.flushTimeoutMs}ms）——0 ⇒ setTimeout(0) 抢在 write 回调前 ⇒ warn 照样被截断`);
  assert.ok(report.flushTimeoutMs >= RESERVE - 40,
    `flush 要拿到≈预留那么多（实测 ${report.flushTimeoutMs}ms / 预留 ${RESERVE}ms，容差 40ms 给 deadline timer 溢出）`);
  assert.ok(ms <= TOTAL + 120,
    `总耗时仍要贴着总上限（实测 ${ms}ms / 总上限 ${TOTAL}ms）——预留不是额外赠送，8s 不许变成 8.25s`);
  assert.ok(report.elapsedMs <= TOTAL + 120,
    `上报账目同样含 flush 且不超总上限（上报 ${report.elapsedMs}ms / 总上限 ${TOTAL}ms）`);
  assert.ok(report.elapsedMs >= TOTAL - RESERVE,
    `deadline 仍要在自己的那份预算（${TOTAL - RESERVE}ms）用完才获胜（上报 ${report.elapsedMs}ms）——修法是给 flush 留时间，不是让循环提前不等`);
  assert.equal(report.flush.attempted, 1);
  assert.equal(report.flush.stuck, 1, '永不回调的流要如实记 stuck（刷不到就认，不假称成功）');
  // flush 拿到的入参也要能看见（账目与真实入参不一致就是假账）
  const spyRun = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'routes', stop() {}, done: forever() }],
    loopTimeoutMs: 4000,
    totalTimeoutMs: TOTAL,
    flushReserveMs: RESERVE,
    flushTimeoutMs: 1500,
    flush: async (o) => {
      seen.push(o.timeoutMs);
      return { attempted: 1, flushed: 0, stuck: 1, failed: 0, errors: [], elapsedMs: 0 };
    },
  }));
  assert.ok(seen[0] >= RESERVE - 40, `传给 flush 的实参就是那份预留（实测 ${seen[0]}ms）`);
  assert.equal(spyRun.report.flushTimeoutMs, seen[0], '账目里的上限 = 实际传给 flush 的那个数');
});

test('#506f 退化：flushReserveMs >= totalTimeoutMs ⇒ 收尾预算为 0（不挂死），flush 仍拿到正预算，总耗时仍 ≤ 总上限', async () => {
  const TOTAL = 100;
  const RESERVE = 250; // 比总上限还大 ⇒ 全部预算归 flush，循环那一段完全不等
  const { report, exits, ms } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'materializer', stop() {}, done: forever() }],
    loopTimeoutMs: 4000,
    totalTimeoutMs: TOTAL,
    flushReserveMs: RESERVE,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 1500,
  }));
  assert.equal(report.loopsBudgetMs, 0, `race 预算夹到下限 0（实测 ${report.loopsBudgetMs}）——不许出现负数延迟`);
  assert.equal(report.timedOut, true, '预算为 0 ⇒ 立刻判超时（这不是挂死，是本条要证的事）');
  assert.deepEqual(exits, [0], '退化路径照样 exit(0)');
  assert.ok(report.flushTimeoutMs > 0 && report.flushTimeoutMs <= TOTAL,
    `flush 仍要拿到正预算、且不超过总上限（实测 ${report.flushTimeoutMs}ms / 总上限 ${TOTAL}ms）`);
  assert.ok(ms <= TOTAL + 120, `总耗时仍 ≤ 总上限 + 小余量（实测 ${ms}ms）——预留把整块预算让给 flush，不是加在外面`);
  assert.ok(report.elapsedMs <= TOTAL + 120, `上报账目同理（实测 ${report.elapsedMs}ms）`);
  assert.deepEqual(report.pendingLoops, ['materializer'], '没退的循环仍要被点名（不等 ≠ 忘记记）');
});

test('#506f 正常路径不受影响：循环立即收尾 ⇒ flush 用满 flushTimeoutMs 请求值', async () => {
  const seen = [];
  const flushSpy = async (o) => {
    seen.push(o.timeoutMs);
    return { attempted: 1, flushed: 1, stuck: 0, failed: 0, errors: [], elapsedMs: 0 };
  };
  const t0 = Date.now();
  const { report, exits, ms } = await run((ev) => ({
    server: fakeServer(ev), // close 回调正常来
    loops: [{ name: 'routes', stop() {}, done: settled() }], // 循环立即收尾
    loopTimeoutMs: 200,
    totalTimeoutMs: 5000,
    flush: flushSpy, // A) spy：看实参
  }));
  assert.deepEqual(exits, [0]);
  assert.equal(report.timedOut, false, '正常路径不许被预留搅成超时');
  assert.equal(report.loopsBudgetMs, 5000 - FLUSH_RESERVE_MS_DEFAULT,
    `race 预算 = 总预算 - 默认预留（实测 ${report.loopsBudgetMs}）`);
  assert.equal(report.flushReserveMs, FLUSH_RESERVE_MS_DEFAULT, '默认预留要落进账目');
  assert.equal(seen[0], FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
    `预算充足时 flush 照旧用满请求值（实测 ${seen[0]}ms）——预留只影响 deadline 的位置，不砍正常路径的刷日志预算`);
  assert.ok(ms < 300, `正常路径不该因为预留而多等（实测 ${ms}ms）`);
  // B) 真流：既有用例的「刷到底」不许退化（506d 那条判据的同款）
  const b = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 5000,
    logStreams: [fakeStream(ev), fakeStream(ev)],
    flushTimeoutMs: FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  }));
  assert.equal(b.report.flush.attempted, 2);
  assert.equal(b.report.flush.flushed, 2, `正常路径两条流都要刷到底（实测 ${JSON.stringify(b.report.flush)}）`);
  assert.equal(b.report.flushTimeoutMs, FLUSH_LOGS_TIMEOUT_MS_DEFAULT);
  assert.ok(Date.now() - t0 < 800, `整个正常路径是毫秒级的（实测 ${Date.now() - t0}ms）`);
});

test('#506f 源码钉：race 的 deadline 用「总预算 - 预留」，且预留是切出来的不是加在外面', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  assert.match(s, /export const FLUSH_RESERVE_MS_DEFAULT = /, '预留要是一个**导出的具名常量**（默认值可查、可钉）');
  assert.match(s, /flushReserveMs: flushReserveMsRaw = FLUSH_RESERVE_MS_DEFAULT/, '可注入 flushReserveMs，默认取那个常量');
  assert.match(s, /const flushReserveMs = safeTimeoutMs\(flushReserveMsRaw\)/, '脏值（3e9 / 负数 / NaN）先夹取，不许放大成无限');
  const reserveAt = s.search(/const loopsBudgetMs = Math\.max\(0, totalBudgetMs - flushReserveMs\)/);
  const deadlineAt = s.search(/const left = Math\.max\(0, loopsBudgetMs - \(Date\.now\(\) - startedAt\)\)/);
  const flushAt = s.search(/flushReport = await flush\(\{ timeoutMs: flushBudgetMs/);
  assert.ok(reserveAt >= 0, '必须有「总预算 - 预留」这一步（下限 0）');
  assert.ok(deadlineAt >= 0 && deadlineAt > reserveAt, '总 deadline 必须用减过预留的那个数');
  assert.ok(flushAt > deadlineAt, '顺序仍是 race → flush → exit');
  assert.doesNotMatch(s, /const left = Math\.max\(0, totalBudgetMs - \(Date\.now\(\) - startedAt\)\)/,
    'race 的 deadline 不许回退成「总预算本身」（那正是剩余预算退化成 0 的根因）');
  assert.match(s, /const remainingMs = Math\.max\(0, totalBudgetMs - \(Date\.now\(\) - startedAt\)\)/,
    'flush 的剩余预算仍按**总预算**算（预留的那一块就在这里落地）');
  assert.doesNotMatch(s, /totalBudgetMs \+ flushReserve|SHUTDOWN_TOTAL_MS_DEFAULT \+ /,
    '预留不许被写成加在总预算**之外**（那会把 8s 变成 8.25s，突破第四轮的硬承诺）');
  assert.match(s, /从总预算里切出来/, '注释要写清预留的口径：切出来的，不是额外赠送');
});

// ---------------------------------------------------------------------------
// ⑥ copilot 最后一轮复审（唯一 1 条，LOW）：账目把「配置的预留」当成「实际切出的那一块」报
// ---------------------------------------------------------------------------
// 缺陷：`report.flushReserveMs` 报的是**清洗后的配置值**，但实际从总预算里切给 flush 的那一块是
//   `min(总预算, 配置值)`。`totalTimeoutMs=100 / flushReserveMs=250` 时总预算只有 100
//   ⇒ 实际最多只能留 100ms，而 report 与超时日志仍写 250ms ⇒ 账目与实际不符（运维按 250 对账对不上）。
// 修法：两个口径**并存**且自解释 —— `flushReserveConfiguredMs`（配置值）+ `flushReserveEffectiveMs`
//   （= `min(总预算, 配置值)`，实际切出的那一块）；日志改用 **effective**（日志要反映实际）。
// 红线：只改账目字段与日志用词，**行为语义一字未动**（deadline / flush 预算 / exit 路径都不碰）。

test('#506g 预留的两个口径要分开报：T=100/R=250 ⇒ configured=250 但 effective=100，日志报 effective', async () => {
  const TOTAL = 100;
  const RESERVE = 250; // 比总上限还大 ⇒ 两个口径必然分离（这正是原缺陷露馅的那一组数）
  const { report, log } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [{ name: 'materializer', stop() {}, done: forever() }],
    loopTimeoutMs: 4000,
    totalTimeoutMs: TOTAL,
    flushReserveMs: RESERVE,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 1500,
  }));
  assert.equal(report.flushReserveConfiguredMs, RESERVE,
    `配置口径照实上报（实测 ${report.flushReserveConfiguredMs}）——运维要能看见自己配了多少`);
  assert.equal(report.flushReserveEffectiveMs, TOTAL,
    `实际切出的那一块只有 min(总预算, 配置值)=${TOTAL}（实测 ${report.flushReserveEffectiveMs}）`
    + '——改前账目与超时日志都写 250，而实际最多留 100，账目对不上');
  assert.equal(report.flushReserveMs, report.flushReserveConfiguredMs,
    '旧字段 `flushReserveMs` 保留为**配置口径**的别名（既有账目读它，不许断）');
  assert.ok(report.flushReserveEffectiveMs <= report.totalTimeoutMs,
    `effective 永远不许超过总上限（实测 ${report.flushReserveEffectiveMs} / ${report.totalTimeoutMs}）`);
  // 日志必须反映**实际**：出现 effective（100），且不再把 250 说成「切出去的那一块」
  const allText = [...log.warns, ...log.logs].join('\n');
  assert.match(allText, /预留 100ms/, `超时/汇总日志要报实际切出的那一块 100ms（实测：${allText}）`);
  assert.doesNotMatch(allText, /预留 250ms|其中 250ms|内含刷日志预留 250ms/,
    `日志不许再把配置值 250ms 说成切出去的那一块（实测：${allText}）`);
});

test('#506g 常规情形 T=5000/R=250 ⇒ 两个口径相等（都是 250），日志不受影响', async () => {
  const TOTAL = 5000;
  const RESERVE = 250;
  const { report, log } = await run((ev) => ({
    server: fakeServer(ev), // close 回调正常来
    loops: [{ name: 'routes', stop() {}, done: settled() }], // 循环立即收尾
    loopTimeoutMs: 200,
    totalTimeoutMs: TOTAL,
    flushReserveMs: RESERVE,
    logStreams: [fakeStream(ev)],
    flushTimeoutMs: FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  }));
  assert.equal(report.timedOut, false, '本条要的是正常路径（没到点强退）');
  assert.equal(report.flushReserveConfiguredMs, RESERVE, `配置口径 ${RESERVE}（实测 ${report.flushReserveConfiguredMs}）`);
  assert.equal(report.flushReserveEffectiveMs, RESERVE,
    `预算充足时 effective == configured（实测 ${report.flushReserveEffectiveMs}）——修法不许把常规情形砍小`);
  assert.equal(report.loopsBudgetMs, TOTAL - RESERVE,
    `行为语义未变：race 预算仍是「总预算 - 预留」（实测 ${report.loopsBudgetMs}）`);
  assert.match(log.logs.join('\n'), /内含实际刷日志预留 250ms/, '汇总行的数与账目一致');
});

test('#506g 源码钉：两个口径各自成字段，日志取 effective', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  assert.match(s, /flushReserveConfiguredMs: flushReserveMs/, '配置口径要单独成字段（自解释，不留含糊的单一字段）');
  assert.match(s, /flushReserveEffectiveMs: Math\.min\(totalBudgetMs, flushReserveMs\)/,
    'effective 必须是 min(总预算, 配置值) —— 实际切出的那一块');
  assert.match(s, /预留 \$\{report\.flushReserveEffectiveMs\}ms/, '超时日志用 effective（日志要反映实际）');
  assert.match(s, /内含实际刷日志预留 \$\{report\.flushReserveEffectiveMs\}ms/, '汇总行同理用 effective');
  assert.match(s, /配置值 ≠ 实际切出去的那一块|配置值 ≠ 实际/, '注释要写清两个口径的差别');
});
