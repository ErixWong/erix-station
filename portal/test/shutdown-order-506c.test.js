// 单测：issue #506 的 copilot **第二轮复审①**（主 agent 现查核实）——停机顺序错，
// 先等循环 5s、**之后**才 `server.close` ⇒ 那 5s 里仍在接新请求，且整个关闭流程没有上限。
//
// 缺陷形状（现查 `portal/src/cli.js:105-117`，改前）：
//   const out = await stopLoopsAndWait(loops, { timeoutMs: SHUTDOWN_WAIT_MS }); // 最多 5s，期间 server 仍 listen
//   ...
//   server.close(() => process.exit(0));   // ← 这之后还要等**既有连接**自己结束
// SSE 是 keep-alive：`server.close` 只停止接受新连接，然后等既有连接结束，而它们的结束依赖
// 循环/心跳清理 ⇒ **5s 只是循环等待上限，不是整个关闭流程的上限**，实际可以超过 compose / k8s
// 默认 10s 宽限期（超了就是 SIGKILL，连 warn 都看不到）。
//
// 判据形状：不是「两个都被调了」，而是**顺序与预算**——
//   · `server.close` 必须在 `stopLoopsAndWait` **之前**被调用（用共享序列数组断言，
//     并且在每个循环的 `stop()` 时刻观察「server 是否已经停接新连接」）；
//   · 循环永不 resolve + close 永不回调 ⇒ 仍必须在 `totalTimeoutMs` 内 `exit(0)`；
//   · 超时路径必须 warn 点名还没退的循环。
// 红线：`exit` 一律注入 spy（默认是 process.exit，真跑会把测试进程杀掉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stopLoopsAndWait, gracefulShutdown, SHUTDOWN_LOOPS_MS_DEFAULT, SHUTDOWN_TOTAL_MS_DEFAULT, FLUSH_LOGS_TIMEOUT_MS_DEFAULT } from '../src/shutdown.js';

const NODE_TIMER_MAX_MS = 2147483647;

function recordingLog() {
  const warns = [];
  const logs = [];
  return { warns, logs, warn: (m) => warns.push(String(m)), error: () => {}, log: (m) => logs.push(String(m)) };
}

/**
 * 假 HTTP server：`close()` **发起即返回**（与 Node 的 http.Server 一样，回调要等既有连接结束）。
 * `listening` 用来模拟「还能不能接新请求」；`events` 是共享时间线。
 */
function fakeServer(events, { neverCallback = false, throwOnClose = false } = {}) {
  const s = {
    listening: true,
    closeCalls: 0,
    close(cb) {
      s.closeCalls += 1;
      s.listening = false; // 从这一刻起不再接新连接
      events.push('server.close');
      if (throwOnClose) { s.listening = true; throw new Error('server 没在 listen'); }
      if (!neverCallback) setImmediate(() => cb(null));
    },
  };
  return s;
}

/** 假循环：`stop()` 时把「此刻 server 是否已停接新连接」记进时间线（这是复审① 的直接判据）。 */
function fakeLoop(name, events, server, donePromise) {
  return {
    name,
    stop() {
      events.push(`stop:${name}`);
      events.push(`${name}:serverListening=${server ? server.listening : 'none'}`);
    },
    done: donePromise,
  };
}

/** 立即 resolve 的 done。 */
const settled = () => Promise.resolve();
/** 永不落定的 done。 */
const forever = () => new Promise(() => {});

/** 注入 exit / log 跑一次；返回 { report, exits, log, ms }。 */
async function run(opts) {
  const exits = [];
  const log = recordingLog();
  const t0 = Date.now();
  const report = await gracefulShutdown({ exit: (code) => exits.push(code), log, ...opts });
  return { report, exits, log, ms: Date.now() - t0 };
}

/** 把 `stopLoops` 换成「记录被调用 + 转交真 helper」的代理（顺序判据要看得见它何时被调）。 */
function spyStopLoops(events) {
  return (loops, o) => {
    events.push('stopLoopsAndWait');
    return stopLoopsAndWait(loops, o);
  };
}

// ---------------------------------------------------------------------------
// ① 顺序：先停接新连接，再等循环收尾
// ---------------------------------------------------------------------------

test('#506c 顺序：server.close 必须在 stopLoopsAndWait 之前被调用（旧代码是之后）', async () => {
  const events = [];
  const server = fakeServer(events);
  const loops = [fakeLoop('materializer', events, server, settled()), fakeLoop('routes', events, server, settled())];

  const { report, exits, ms } = await run({
    server,
    loops,
    loopTimeoutMs: 200,
    totalTimeoutMs: 1000,
    stopLoops: spyStopLoops(events),
  });

  assert.equal(server.closeCalls, 1, `server.close 必须恰好被调一次（实测 ${server.closeCalls}）`);
  const closeAt = events.indexOf('server.close');
  const waitAt = events.indexOf('stopLoopsAndWait');
  assert.equal(closeAt, 0, `server.close 必须是关闭流程的第一个动作（时间线 ${JSON.stringify(events)}）`);
  assert.ok(waitAt > closeAt,
    `close(${closeAt}) 必须在 stopLoopsAndWait(${waitAt}) 之前——旧顺序里那 5s 循环等待期间 server 仍在 listen、仍在接新请求`);
  assert.deepEqual(report.sequence, ['server.close', 'stopLoopsAndWait', 'flushLogs'],
    'helper 自己也要把这几步的顺序记账出来（运维与回归都看这个；flushLogs 必须在最后——exit 前）');
  // 每个循环被 stop 的那一刻，server 必须已经不再接新连接
  for (const name of ['materializer', 'routes']) {
    assert.ok(events.includes(`${name}:serverListening=false`),
      `${name} 的 stop() 时刻 server 必须已停接新连接（实测 ${events.find((e) => e.startsWith(`${name}:serverListening`))}）`);
  }
  assert.deepEqual(exits, [0], '收尾成功也要 exit(0)');
  assert.equal(report.timedOut, false);
  assert.equal(report.serverClosed, true, 'close 回调来了就要记账（否则总上限到点会误报）');
  assert.ok(ms < 1000, `一切顺利时不该等满上限（实测 ${ms}ms）`);
});

test('#506c close 发起即返回：close 的回调永不来也必须继续往下收尾循环（不许卡在 close 上）', async () => {
  const events = [];
  const server = fakeServer(events, { neverCallback: true }); // SSE keep-alive：回调一直不来
  const stopped = [];
  const loops = [{ name: 'routes', stop: () => stopped.push('routes'), done: settled() }];

  const { report, exits } = await run({
    server,
    loops,
    loopTimeoutMs: 200,
    totalTimeoutMs: 150, // 小值而已：本条要证的是「没卡在 close 上」，不是等满预算
    stopLoops: spyStopLoops(events),
  });

  assert.deepEqual(stopped, ['routes'], 'close 没回调也要照样 stop / 等循环（旧代码是反过来：先等循环才 close）');
  assert.deepEqual(exits, [0]);
  assert.ok(report.loops && report.loops.waited === 1 && report.loops.timedOut === false,
    `循环那一头必须**真的收尾了**（实测 ${JSON.stringify(report.loops)}）`);
  assert.equal(report.serverClosed, false, 'close 回调没来 ⇒ 如实记「没关完」');
});

// ---------------------------------------------------------------------------
// ② 总上限：覆盖整个流程（循环 + server 关闭），到点无论收没收完都 exit(0)
// ---------------------------------------------------------------------------

test('#506c 总上限：循环永不 resolve + close 永不回调 ⇒ 仍要在 totalTimeoutMs 内 exit(0)（不真等 8s）', async () => {
  const events = [];
  const server = fakeServer(events, { neverCallback: true });
  const loops = [fakeLoop('routes', events, server, forever()), fakeLoop('materializer', events, server, forever())];

  const { report, exits, ms } = await run({
    server,
    loops,
    loopTimeoutMs: 400, // 故意远大于总上限：能退出就证明起作用的是**总上限**，不是循环那一段
    totalTimeoutMs: 120,
    // 506f：总预算里要给退出前刷日志留一块（默认 250ms > 本条的 120ms ⇒ race 预算会被压到 0）。
    // 本条要证的是「总上限到点才退」，所以把预留收到 20ms：race 预算 = 100ms，下面的下限判据仍然有意义
    // （「给 flush 留时间」的判据在 shutdown-flush-budget-506e.test.js 的 506f 一节，不在这里）。
    flushReserveMs: 20,
    stopLoops: spyStopLoops(events),
  });

  assert.deepEqual(exits, [0], `到点必须 exit(0)（实测 ${JSON.stringify(exits)}）——旧代码这里根本没上限`);
  assert.equal(report.timedOut, true, '必须如实报「走到总上限」');
  assert.equal(report.loopsBudgetMs, 100, `race 预算 = 总上限 - 预留（实测 ${report.loopsBudgetMs}）——预留是从总预算里切的，不是加在外面`);
  assert.ok(ms < 400, `总上限（120ms）起作用 ⇒ 不该等到循环那一段的上限（实测 ${ms}ms）`);
  assert.ok(ms >= 90, `总上限到点才退，不该提前跑（实测 ${ms}ms）`);
  assert.equal(report.loops, null, '循环 helper 还没返回就被总上限切掉（这条断言本身证明总上限在管整个流程）');
  assert.deepEqual(report.pendingLoops, ['routes', 'materializer'], `要点名还没退的循环（实测 ${JSON.stringify(report.pendingLoops)}）`);
});

test('#506c 总上限也要覆盖 server.close 那一段：循环全收工、close 不回调 ⇒ 到点照样 exit(0) 并说明原因', async () => {
  const events = [];
  const server = fakeServer(events, { neverCallback: true });
  const loops = [fakeLoop('routes', events, server, settled())]; // 循环这一头全退完了

  const { report, exits, log, ms } = await run({
    server,
    loops,
    loopTimeoutMs: 50,
    totalTimeoutMs: 200,
    flushReserveMs: 20, // 同上一条：506f 之后总预算含 flush 预留，本条要证的仍是「等 close 等到预算用尽」
    stopLoops: spyStopLoops(events),
  });

  assert.deepEqual(exits, [0], '复审① 的核心：5s 从来不是整个关闭流程的上限——close 那一头也得有上限');
  assert.equal(report.timedOut, true);
  assert.ok(report.loops && report.loops.timedOut === false, '循环那一段是成功收尾的（超时来自 server 那一头）');
  assert.deepEqual(report.pendingLoops, [], '没退的循环为空要说得出口');
  assert.ok(ms >= 150 && ms < 1200, `等 close 等到剩余预算用尽（实测 ${ms}ms）`);
  const cap = log.warns.filter((m) => /总上限/.test(m));
  assert.equal(cap.length, 1, `总超时只记一条 warn（实测 ${JSON.stringify(log.warns)}）`);
  assert.match(cap[0], /server/i, '这条超时来自 server.close，warn 必须点名它');
  assert.match(cap[0], /keep-alive|SSE/, '要解释为什么 close 不回调（SSE 是 keep-alive），否则运维查不到头');
  assert.match(cap[0], /SIGKILL|10s|宽限期/, '要交代再等下去的后果');
});

test('#506c 总上限默认 8000ms（留 2s 给 exit 与 compose 默认 10s 宽限期），循环上限默认 5000ms', () => {
  assert.equal(SHUTDOWN_TOTAL_MS_DEFAULT, 8000,
    'compose / k8s 默认只给 10s 宽限期 ⇒ 整个流程上限取 8s，另留 ~2s 给 process.exit');
  assert.equal(SHUTDOWN_LOOPS_MS_DEFAULT, 5000, '等循环那一段仍是 5s（评审② 的原值，不许被总上限顶掉）');
  assert.ok(SHUTDOWN_LOOPS_MS_DEFAULT < SHUTDOWN_TOTAL_MS_DEFAULT, '循环上限必须小于总上限，否则总上限永远轮不到管 server 那一段');
});

// ---------------------------------------------------------------------------
// ③ 点名：超时路径必须 warn 出没退的循环名
// ---------------------------------------------------------------------------

test('#506c 总超时必须 warn 点名还没退的循环，且不冤枉已经退的那个', async () => {
  const events = [];
  const server = fakeServer(events, { neverCallback: true });
  const loops = [
    fakeLoop('routes', events, server, settled()), // 退了
    fakeLoop('materializer', events, server, forever()), // 没退
    fakeLoop('onboarding', events, server, forever()), // 没退
  ];

  const { report, log, exits } = await run({
    server,
    loops,
    loopTimeoutMs: 400,
    totalTimeoutMs: 120,
    // 用真 helper 的默认实现（不注入 stopLoops）⇒ 判据覆盖「默认接线」而不是只覆盖 spy
  });

  assert.deepEqual(exits, [0]);
  assert.equal(report.timedOut, true);
  assert.deepEqual(report.pendingLoops, ['materializer', 'onboarding'], `点名要准（实测 ${JSON.stringify(report.pendingLoops)}）`);
  const cap = log.warns.filter((m) => /总上限/.test(m));
  assert.ok(cap.length >= 1, `总超时必须有一条 warn（实测 ${JSON.stringify(log.warns)}）`);
  const line = cap[0];
  assert.match(line, /materializer/, '要点出没退的循环名，运维才有的可查');
  assert.match(line, /onboarding/);
  assert.doesNotMatch(line, /routes/, `已经退掉的循环不许被点名（实测 ${line}）`);
  assert.match(line, /process\.exit/, '要说清接下来是直接退出');
});

// ---------------------------------------------------------------------------
// ④ 不许把关闭流程炸掉 / 不许漏未捕获拒绝
// ---------------------------------------------------------------------------

test('#506c server.close 自己抛错 ⇒ 照样收尾循环并 exit(0)（关闭路径上日志与控制流分开）', async () => {
  const events = [];
  const server = fakeServer(events, { throwOnClose: true });
  const stopped = [];
  const loops = [{ name: 'routes', stop: () => stopped.push('routes'), done: settled() }];

  const { report, exits, log } = await run({ server, loops, loopTimeoutMs: 200, totalTimeoutMs: 1000 });

  assert.deepEqual(stopped, ['routes'], 'close 抛错不许让循环没人 stop');
  assert.deepEqual(exits, [0]);
  assert.equal(report.serverCloseStarted, true, 'close 被发起过要如实记账');
  assert.equal(report.serverClosed, true, '抛错当作已关闭，否则每次关闭都要白等到总上限');
  assert.equal(log.warns.filter((m) => /server\.close 抛错/.test(m)).length, 1, '抛错要看得见，但不许变成控制流');
});

test('#506c stopLoops 抛错 / 拒绝 ⇒ gracefulShutdown 自己不炸、不漏未捕获拒绝，仍 exit(0)', async () => {
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const stopLoops of [
      () => { throw new Error('helper 同步炸'); },
      () => Promise.reject(new Error('helper 异步炸')),
    ]) {
      const events = [];
      const server = fakeServer(events);
      const { report, exits, log } = await run({
        server, loops: [fakeLoop('routes', events, server, settled())],
        loopTimeoutMs: 100, totalTimeoutMs: 1000, stopLoops,
      });
      assert.deepEqual(exits, [0], `helper 炸了也要退（${stopLoops}`);
      assert.equal(report.loops, null, '拿不到收尾账目就记 null，不许伪造');
      assert.equal(report.timedOut, false, 'helper 炸不是超时');
      assert.equal(log.warns.filter((m) => /helper 自身抛错/.test(m)).length, 1);
    }
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, [], `关闭流程自己不许漏未捕获拒绝：${seen.map((e) => e.message).join(',')}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#506c 循环的 done 被拒绝 ⇒ 照样走完关闭（拒绝不许冒泡），exit(0)', async () => {
  const events = [];
  const server = fakeServer(events);
  const loops = [
    fakeLoop('routes', events, server, Promise.reject(new Error('循环带错误退出'))),
    fakeLoop('materializer', events, server, settled()),
  ];
  const { report, exits, log } = await run({ server, loops, loopTimeoutMs: 200, totalTimeoutMs: 1000 });
  assert.deepEqual(exits, [0]);
  assert.equal(report.timedOut, false, '拒绝不是超时');
  assert.equal(report.loops.rejected, 1, `真 helper 要照记拒绝数（实测 ${report.loops?.rejected}）`);
  assert.ok(log.logs.some((m) => /带错误退出/.test(m)), '汇总日志要看得见「有循环带错误退出」');
});

// ---------------------------------------------------------------------------
// ⑤ 汇总日志 + 上限夹取 + 缺参数
// ---------------------------------------------------------------------------

test('#506c 汇总日志交代：close 在第 1 步、等了几个循环、用了多少预算', async () => {
  const events = [];
  const server = fakeServer(events);
  const loops = [
    fakeLoop('routes', events, server, settled()),
    { name: 'onboarding', stop() {} }, // 真实形状：没有 done
  ];
  const { report, log } = await run({ server, loops, loopTimeoutMs: 200, totalTimeoutMs: 1000 });
  const line = log.logs.join('\n');
  assert.match(line, /关闭收尾/, '要留一条运维可查的汇总（旧代码有，重构不许把它弄丢）');
  assert.match(line, /server\.close（已关完）/, 'close 这一步的结果要写进汇总');
  assert.match(line, /等了 1 个/, `只等有 done 的（实测 ${line}）`);
  assert.match(line, /跳过 1 个无 done 的/);
  assert.match(line, /总上限 1000ms/);
  assert.equal(report.exitCode, 0);
});

test('#506c 总上限与循环上限都要夹到 Node timer 边界（3e9 不许被折成 1ms）', async () => {
  const real = globalThis.setTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms, ...rest) => { captured.push(ms); return real(fn, 1, ...rest); };
  const events = [];
  const server = fakeServer(events);
  try {
    const { report } = await run({
      server,
      loops: [fakeLoop('routes', events, server, forever())],
      loopTimeoutMs: 3e9,
      totalTimeoutMs: 3e9,
    });
    assert.ok(captured.length >= 2, `循环上限与总上限各要一个 deadline timer（实测 ${JSON.stringify(captured)}）`);
    // #506d 之后这条路径上还会多**两个刷日志的 timer**（每条流一个，默认 250ms）：它们不是「收尾预算」
    // timer，按**精确值**剔掉（剔不掉的 flush 回归会被下面那条「没 timer 越界」断言抓住）。
    const budgetTimers = captured.filter((ms) => ms !== FLUSH_LOGS_TIMEOUT_MS_DEFAULT);
    assert.equal(Math.max(...budgetTimers), NODE_TIMER_MAX_MS,
      `两个上限都必须落在夹住后的 ${NODE_TIMER_MAX_MS} 上（实测 ${JSON.stringify(budgetTimers)}；原样 3e9 会被 Node 折成 1ms ⇒ 关闭刚发起就自杀）`);
    assert.ok(budgetTimers.every((ms) => ms <= NODE_TIMER_MAX_MS), `没有 timer 越界（实测 ${JSON.stringify(budgetTimers)}）`);
    // 总上限那一条是「剩余预算」（= 总上限 - 已用时），所以允许比上限小 1~2ms；但绝不允许被折成个位数
    assert.ok(Math.min(...budgetTimers) > NODE_TIMER_MAX_MS - 1000,
      `没有任何一个收尾 timer 被截短（实测 ${JSON.stringify(budgetTimers)}）`);
    assert.equal(report.totalTimeoutMs, NODE_TIMER_MAX_MS);
    assert.equal(report.loopTimeoutMs, NODE_TIMER_MAX_MS);
  } finally {
    globalThis.setTimeout = real;
  }
});

test('#506c 没有 server / 没有 loops 也不许卡死（healthcheck、单测、以及 close 前就崩的路径）', async () => {
  const a = await run({ loops: [], loopTimeoutMs: 100, totalTimeoutMs: 1000 });
  assert.deepEqual(a.exits, [0], '没 server 没循环也要正常退出');
  assert.equal(a.report.serverCloseStarted, false, '没 server 就别假装 close 过');
  assert.equal(a.report.timedOut, false);

  const b = await run({ server: fakeServer([]), loopTimeoutMs: 100, totalTimeoutMs: 1000 });
  assert.deepEqual(b.exits, [0]);
  assert.equal(b.report.loops.waited, 0);
});

test('#506c 顺序不许回退成源码里的形状（close 在 helper 里、cli 不再自己排顺序）', () => {
  const s = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  const closeAt = s.search(/sequence\.push\('server\.close'\)/);
  const waitAt = s.search(/sequence\.push\('stopLoopsAndWait'\)/);
  assert.ok(closeAt >= 0 && waitAt > closeAt,
    'gracefulShutdown 内部必须是「先 push server.close 再 push stopLoopsAndWait」的顺序（复审① 的修法本体）');
  assert.match(s, /Promise\.race\(\[everything, deadline\]\)/, '总上限必须 race **整个流程**（loops + serverClosed），不是只 race 循环');
  assert.match(s, /loopsSettled\.then\(\(\) => serverClosedP\)/, '「全部收尾」的定义要包含 server 关闭那一段');
  assert.doesNotMatch(s, /timer\.unref\(\)/, '总上限 timer 不许 unref（否则「只剩它在等」时 await 被跳过）');
});
