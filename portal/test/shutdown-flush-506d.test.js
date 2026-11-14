// 单测：issue #506 的 copilot **第三轮复审①**——总 deadline 获胜且仍有循环 pending 时，
// 记完 warn / 汇总就 `exit(0)`，**没刷过 stdout/stderr**。
//
// 缺陷形状（现查 `portal/src/shutdown.js`，改前的 deadline 分支）：
//   if (timedOut) { warn(...) }
//   log?.log?.('[portal] 关闭收尾 …')
//   exit(report.exitCode);        // ← 排队的写入没保证落到 fd
// 生产里 stdout/stderr 是**管道**（compose / k8s 的日志驱动），管道上的写入是异步的
// ⇒ 恰好在「到点强退」那一次——最需要看日志的一次——那条 warn 与汇总行可能被截断。
//
// 判据形状：不是「代码里调了 write」，而是**顺序**与**有界**：
//   · 注入假 streams / 假 exit ⇒ 时间线里 `flush` 必须排在 `exit` **之前**，正常路径与 deadline
//     路径**都**要刷过（只补超时分支的话，正常收尾那次的日志照样可能截断）；
//   · 注入一个**永不回调**的 stream ⇒ 关闭仍在 `flushTimeoutMs` 内 exit（刷不到就认，不许挂死）；
//   · `exit` 仍然**只被调一次**（加了刷日志这一步，原 #506c 的「一次退出」断言不许退化）；
//   · deadline 路径的 warn 必须点名「还有 N 个循环没退（名字）」，并交代残留兜底是**既有**的
//     `lease_until` 孤儿回收（那是显式接受的残留，不是这里新加的等待——不许为了等事务放宽预算）。
// 红线：`exit` 一律注入 spy；真跑 `process.exit` 会把测试进程杀掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  flushLogs,
  gracefulShutdown,
  FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  SHUTDOWN_TOTAL_MS_DEFAULT,
  SHUTDOWN_LOOPS_MS_DEFAULT,
} from '../src/shutdown.js';

function recordingLog() {
  const warns = [];
  const logs = [];
  return { warns, logs, warn: (m) => warns.push(String(m)), error: () => {}, log: (m) => logs.push(String(m)) };
}

/** 立即 resolve 的 done / 永不落定的 done。 */
const settled = () => Promise.resolve();
const forever = () => new Promise(() => {});

/** 假 HTTP server：`neverCallback` 模拟 SSE keep-alive（close 的回调一直不来）。 */
function fakeServer(events, { neverCallback = false, syncCallback = false } = {}) {
  const s = {
    listening: true,
    closeCalls: 0,
    close(cb) {
      s.closeCalls += 1;
      s.listening = false;
      events.push('server.close');
      if (neverCallback) return;
      if (syncCallback) { cb(null); return; } // 「根本没连接要等，close 立刻回调」
      setImmediate(() => cb(null));
    },
  };
  return s;
}

/**
 * 假输出流：`write('', cb)` 往**共享时间线**记一笔 `flush`。
 * `neverCallback: true` 模拟「刷不动」（管道被对端拖住）——回调永不来。
 */
function fakeStream(events, { neverCallback = false, throwOnWrite = false } = {}) {
  const s = {
    chunks: 0,
    write(chunk, cb) {
      s.chunks += 1;
      events.push('flush');
      if (throwOnWrite) throw new Error('EPIPE');
      if (!neverCallback) setImmediate(() => cb());
    },
  };
  return s;
}

/**
 * 注入假 streams / 假 exit 跑一次。`makeOpts(events)` 拿到**共享时间线**，
 * 好让假流与假 exit 记在同一条线上（顺序判据只看这一条线）。
 * @returns {Promise<{report, exits, log, events, ms}>}
 */
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

/** 时间线里 `server.close` 被记了几次（= close 被发起的次数）。 */
function serverCloseCalls(events) {
  return events.filter((e) => e === 'server.close').length;
}

/** 时间线里第一个 `exit` 之前必须已经出现过 `flush`（这就是本单的全部本体）。 */
function assertFlushBeforeExit(events, label) {
  const flushAt = events.indexOf('flush');
  const exitAt = events.indexOf('exit');
  assert.ok(flushAt >= 0, `${label}：退出前必须真的调过刷日志（时间线 ${JSON.stringify(events)}）`);
  assert.ok(exitAt >= 0, `${label}：必须走到 exit（时间线 ${JSON.stringify(events)}）`);
  assert.ok(flushAt < exitAt,
    `${label}：flush(${flushAt}) 必须在 exit(${exitAt}) 之前——process.exit 不等已排队的管道写入，顺序反了那条日志就是白记`);
}

// ---------------------------------------------------------------------------
// ① 刷日志先于 exit：正常路径与 deadline 路径都要刷
// ---------------------------------------------------------------------------

test('#506d 退出前必须刷日志：flush 在 exit 之前（正常收尾路径与到点强退路径都要刷）', async () => {
  // A) 正常路径：close 回调来了、循环都退了 ⇒ 改前这里根本没有 flush 这一步
  const a = await run((events) => ({
    server: fakeServer(events),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 1000,
    logStreams: [fakeStream(events), fakeStream(events)], // stdout + stderr 各一条假流
    flushTimeoutMs: 50,
  }));
  assertFlushBeforeExit(a.events, '正常收尾路径');
  assert.deepEqual(a.exits, [0], '正常路径照样 exit(0)');
  assert.equal(a.report.timedOut, false);
  assert.equal(a.report.flush.attempted, 2, `两条流都要被尝试（实测 ${JSON.stringify(a.report.flush)}）`);
  assert.equal(a.report.flush.flushed, 2, `两条流都要刷到底（实测 ${JSON.stringify(a.report.flush)}）`);
  assert.equal(a.report.flush.stuck, 0);
  assert.deepEqual(a.report.sequence, ['server.close', 'stopLoopsAndWait', 'flushLogs'],
    'flushLogs 要出现在收尾账目的最后一步（exit 之前）');

  // B) deadline 路径：循环永不 resolve + close 永不回调 ⇒ 到点强退——**正是**复审报的那条分支
  const b = await run((events) => ({
    server: fakeServer(events, { neverCallback: true }),
    loops: [{ name: 'materializer', stop() {}, done: forever() }],
    loopTimeoutMs: 400,
    totalTimeoutMs: 80,
    logStreams: [fakeStream(events), fakeStream(events)],
    flushTimeoutMs: 50,
  }));
  assertFlushBeforeExit(b.events, '到点强退路径');
  assert.equal(b.report.timedOut, true, '本条要走的确实是总上限分支（否则测不到复审报的那条路径）');
  assert.deepEqual(b.exits, [0]);
  assert.equal(b.report.flush.attempted, 2);
  assert.equal(b.report.flush.flushed, 2, `到点强退时也要把两条流都刷到底（实测 ${JSON.stringify(b.report.flush)}）`);
});

// ---------------------------------------------------------------------------
// ② flush 卡住不许挂死：超时也照样 exit
// ---------------------------------------------------------------------------

test('#506d 刷日志卡住（write 永不回调）⇒ 仍在 flush 超时内 exit，不许挂死', async () => {
  const { report, exits, events, ms } = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 200,
    totalTimeoutMs: 1000,
    logStreams: [fakeStream(ev, { neverCallback: true })],
    flushTimeoutMs: 80, // 注入短超时：本条要证的是「有上限」，不是真等 250ms
  }));

  assert.ok(events.includes('flush'), '至少要发起过刷日志');
  assert.deepEqual(exits, [0], `刷不动也要退（实测 ${JSON.stringify(exits)}）——否则修法把「日志被截断」换成了「进程挂死」`);
  assert.ok(ms >= 70, `超时到点才退（实测 ${ms}ms，注入上限 80ms）`);
  assert.ok(ms < 1000, `只等 flushTimeoutMs 就放行（实测 ${ms}ms）——不许变成无限等`);
  assert.equal(report.flush.attempted, 1);
  assert.equal(report.flush.flushed, 0, '没回调就如实记「没刷到」，不许假称成功');
  assert.equal(report.flush.stuck, 1, '要能数出几条流卡住（运维查日志截断时看得懂）');
});

test('#506d 流自己抛错 / flush 不是函数 ⇒ 照样 exit(0)，日志失败不许变成控制流', async () => {
  const bad = await run((ev) => ({
    server: fakeServer(ev),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 100,
    totalTimeoutMs: 500,
    logStreams: [fakeStream(ev, { throwOnWrite: true })],
    flushTimeoutMs: 50,
  }));
  assert.deepEqual(bad.exits, [0], '流抛错（EPIPE / 已 destroy）不许挡住退出');
  assert.equal(bad.report.flush.flushed, 0);
  assert.equal(bad.report.flush.stuck, 1);

  const broken = await run({
    server: fakeServer([]),
    loops: [],
    loopTimeoutMs: 100,
    totalTimeoutMs: 500,
    flush: () => { throw new Error('flush 自己炸了'); },
  });
  assert.deepEqual(broken.exits, [0]);
  assert.equal(broken.report.flush, null, '拿不到刷日志账目就记 null，不许伪造');
  assert.equal(broken.log.warns.filter((m) => /刷日志失败/.test(m)).length, 1, '要看得见「没刷成」，但不许冒泡');
});

// ---------------------------------------------------------------------------
// ③ exit 仍然只被调一次（deadline 与 serverClosed 同时落定）
// ---------------------------------------------------------------------------

test('#506d deadline 与 serverClosed 同时落定 ⇒ exit 只被调一次（#506c 的原断言不许退化）', async () => {
  for (const [label, totalTimeoutMs, syncCallback] of [
    ['总上限先到、close 回调同一拍也到了', 0, false],
    ['close 同步回调 + 循环立刻退（两边都已落定）', 0, true],
    ['正常收尾 + 极短总预算（race 两头几乎同时）', 1, false],
  ]) {
    const { exits, report, events } = await run((ev) => ({
      server: fakeServer(ev, { syncCallback }),
      loops: [{ name: 'routes', stop() {}, done: settled() }],
      loopTimeoutMs: 50,
      totalTimeoutMs,
      logStreams: [fakeStream(ev)],
      flushTimeoutMs: 20,
    }));
    assert.equal(exits.length, 1,
      `${label}：exit 必须恰好一次（实测 ${JSON.stringify(exits)}）——加「刷日志」这一步不许多出一次退出`);
    assert.equal(exits[0], 0, `${label}：退出码仍是 0`);
    assert.equal(report.exitCode, 0);
    assert.equal(report.serverCloseStarted, true, `${label}：close 要被发起过（只一次，见下）`);
    assert.equal(serverCloseCalls(events), 1, `${label}：close 只发起一次`);
    if (syncCallback) assert.equal(report.serverClosed, true, `${label}：close 同步回调 ⇒ 要如实记「已关完」`);
    assert.equal(report.flush.attempted, 1, `${label}：刷日志只跑一轮（注入一条流）`);
    assertFlushBeforeExit(events, label);
  }
});

// ---------------------------------------------------------------------------
// ④ 日志点名：到点强退那条 warn 要说清「还有几个没退、名字、残留谁兜底」
// ---------------------------------------------------------------------------

test('#506d 到点强退的 warn 必须点名「还有 N 个循环没退（名字）」并交代 lease_until 兜底', async () => {
  const { log, report } = await run((ev) => ({
    server: fakeServer(ev, { neverCallback: true }),
    loops: [
      { name: 'routes', stop() {}, done: settled() },        // 退了 ⇒ 不许被点名
      { name: 'materializer', stop() {}, done: forever() },  // 没退
      { name: 'onboarding', stop() {}, done: forever() },    // 没退
    ],
    loopTimeoutMs: 400,
    totalTimeoutMs: 120,
    logStreams: [fakeStream(ev)],
    flushTimeoutMs: 20,
  }));

  assert.deepEqual(report.pendingLoops, ['materializer', 'onboarding'], `账目要准（实测 ${JSON.stringify(report.pendingLoops)}）`);
  const cap = log.warns.filter((m) => /总上限/.test(m));
  assert.equal(cap.length, 1, `到点强退只记一条 warn（实测 ${JSON.stringify(log.warns)}）`);
  const line = cap[0];
  assert.match(line, /还有 2 个循环没退/, `要点出「还有几个没退」（实测 ${line}）`);
  assert.match(line, /materializer/, '要写出没退的循环名，运维才有的可查');
  assert.match(line, /onboarding/);
  assert.doesNotMatch(line, /routes/, `已经退掉的循环不许被点名（实测 ${line}）`);
  assert.match(line, /lease_until/, '残留要说清是「带租约等回收」，别只说「超时了」');
  assert.match(line, /孤儿回收/, '要说清兜底机制是谁（既有的回收，不是本次新加的等待）');
  assert.match(line, /既有/, '要写明那是既有兜底机制 = 显式接受的残留，不是新承诺');
  assert.match(line, /process\.exit/, '要说清接下来直接退出');
  assert.match(line, /不再等/, '要说清「预算就是预算」——不许为了等事务把 deadline 往后推');
  assert.ok(!/延长|加长超时|重试等待/.test(line), `这条日志不许承诺「再等一会儿」（实测 ${line}）`);
});

// ---------------------------------------------------------------------------
// flushLogs 本体的直测（gracefulShutdown 之外也要能用、也不许挂死）
// ---------------------------------------------------------------------------

test('#506d flushLogs：等回调、计账、坏流不 reject、非法流跳过、上限有限小', async () => {
  const events = [];
  const ok = fakeStream(events);
  const out = await flushLogs({ timeoutMs: 50, streams: [ok, null, undefined, { write: 'not-a-function' }] });
  assert.equal(out.attempted, 1, `只有「真的带 write 函数」的流才算账（实测 ${JSON.stringify(out)}）`);
  assert.equal(out.flushed, 1);
  assert.equal(out.stuck, 0);
  assert.ok(Number.isFinite(out.elapsedMs));
  assert.equal(ok.chunks, 1, '每条流只写一个空 chunk（不许往日志里塞内容）');

  // 空清单 / 非法上限：不许抛、不许挂死（timeoutMs 非法 ⇒ 不真等，但依然发起 write）
  const empty = await flushLogs({ streams: [] });
  assert.deepEqual({ attempted: empty.attempted, flushed: empty.flushed, stuck: empty.stuck }, { attempted: 0, flushed: 0, stuck: 0 });
  const zero = await flushLogs({ timeoutMs: 0, streams: [fakeStream([])] });
  assert.equal(zero.attempted, 1, 'timeoutMs=0 也照样发起（只是不真等）');

  // 刷日志的默认上限必须「有限且小」：为等事务把它放大 = 回到 #506 最初的缺陷（关闭没有上限）
  assert.ok(Number.isFinite(FLUSH_LOGS_TIMEOUT_MS_DEFAULT) && FLUSH_LOGS_TIMEOUT_MS_DEFAULT > 0 && FLUSH_LOGS_TIMEOUT_MS_DEFAULT <= 1000,
    `默认上限必须是有限小值（实测 ${FLUSH_LOGS_TIMEOUT_MS_DEFAULT}）`);
  assert.equal(SHUTDOWN_TOTAL_MS_DEFAULT, 8000, '总上限不许因为「要刷日志」被改动');
  assert.equal(SHUTDOWN_LOOPS_MS_DEFAULT, 5000, '等循环的上限也不许被顺手放宽');
});

test('#506d 不注入 streams 时，刷的是**真** stdout/stderr（生产接线，不许只测假流）', async () => {
  const t0 = Date.now();
  const { report, exits } = await run({
    server: fakeServer([]),
    loops: [{ name: 'routes', stop() {}, done: settled() }],
    loopTimeoutMs: 100,
    totalTimeoutMs: 500,
  });
  assert.deepEqual(exits, [0]);
  assert.equal(report.flush.attempted, 2, `缺省就要刷 stdout + stderr 两条（实测 ${JSON.stringify(report.flush)}）——否则生产上那条 warn 依旧会被截断`);
  assert.equal(report.flush.stuck, 0, `真流也要刷得动（实测 ${JSON.stringify(report.flush)}）`);
  assert.ok(Date.now() - t0 < 1000, `真流上的 flush 是毫秒级的（实测 ${Date.now() - t0}ms，含关闭本身）——不许拿 250ms 当常态`);
});

test('#506d 源码钉：刷日志在 exit 之前，且没给 exit 加长超时 / 没引入无限等', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  const flushAt = s.search(/flushReport = await flush\(/);
  const exitAt = s.search(/exit\(report\.exitCode\)/);
  assert.ok(flushAt >= 0 && exitAt >= 0 && flushAt < exitAt,
    'gracefulShutdown 里必须是「先 await flush 再 exit」的顺序（第三轮复审① 的修法本体）');
  assert.match(s, /stream\.write\('', \(\) => finish\(true\)\)/, '刷日志用空 chunk + 回调（只推已排队的写入，不产生新输出）');
  assert.match(s, /timer = setTimeout\(\(\) => finish\(false\), limit\)/, '每条流各自带超时：刷不到也照样退');
  assert.ok(s.indexOf('timer = setTimeout(() => finish(false), limit)') < s.indexOf("stream.write('', () => finish(true))"),
    'timer 必须**先建**再 write：假流会同步回调，先 write 就留下清不掉的悬空 timer');
  assert.doesNotMatch(s, /exit\(report\.exitCode\)[\s\S]{0,80}await flush\(/, 'exit 之后不许再有 flush（那行永远执行不到）');
  assert.doesNotMatch(s, /flushTimeoutMs = (Infinity|Number\.POSITIVE_INFINITY|\d{6,})/, '刷日志的默认值不许是无限/巨大值');
});
