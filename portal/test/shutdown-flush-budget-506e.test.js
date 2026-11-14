// 单测：issue #506 的 copilot **第四轮（最终验收）复审①**——flush 排在总预算**之外**，
// 于是「整个关闭流程 ≤ totalTimeoutMs」这条承诺其实是假的。
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

test('#506e 源码钉：flush 的超时取剩余预算，elapsedMs 在 flush 之后结算', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  const remainingAt = s.search(/const remainingMs = Math\.max\(0, totalBudgetMs - \(Date\.now\(\) - startedAt\)\)/);
  const budgetAt = s.search(/const flushBudgetMs = Math\.min\(flushRequestedMs, remainingMs\)/);
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
