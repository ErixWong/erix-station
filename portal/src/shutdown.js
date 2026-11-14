// 优雅关闭：停循环 + **等在途那一拍收尾**（issue #506 评审②）。
//
// 为什么要有这个文件（缺陷形状）：`cli.js` 的 `shutdown()` 原先只同步调 7 个 `stop()`，随后
// `server.close(() => process.exit(0))`。而 `stop()` 只做 `abort.abort()`——**在跑的
// `claim*Rows()` 事务不会被中断**，循环的 `done` 要等当前轮结束才 resolve，却没人 await 它
// ⇒ 进程可能在事务中途 `process.exit(0)`：连接被断 ⇒ 整笔事务回滚（活白干一轮，还要重认领），
// 或者更糟：认领事务已提交、`mark*Published` 没跑 ⇒ processing 行带着 60s 的 `lease_until`
// 租约躺在那儿等孤儿回收（#506 之后回收是 10s 一拍，但那条 UPDATE 也得等下一拍才跑）。
//
// 于是把「先全部 stop，再有上限地 await 所有 done」抽成一个**可测**的函数，红线：
//   · **有上限**（默认 5000ms）：绝不无限等——真库抖起来一条查询能挂几十秒，而停机只给几秒；
//   · 超时 ⇒ 记一条 warn 后继续退（宁可让行带着租约等回收，也不许进程挂死在关闭上）；
//   · `allSettled` 语义：某个循环带着拒绝退出**不许**把关闭流程炸掉；
//   · 缺 `done` 的循环（onboarding / offboarding / provisioner / reaper / driftMonitor 只有
//     `stop()`，且用的是**不可中断**的 `sleep(5000)` / `sleep(15000)`）直接跳过——await 它们
//     会让每次关闭都白等满 timeout（比原来更糟）。给它们补可中断 `done` 不在本单范围。

// Node 的 `setTimeout` 把延迟存成 **32 位有符号整数**：实测 Node v22.23.2 `setTimeout(fn, 3e9)` 打印
//   `TimeoutOverflowWarning: 3000000000 does not fit into a 32-bit signed integer.`
//   `Timeout duration was set to 1.`
// ⇒ `timeoutMs: 3e9` 的真实后果**不是**「等很久」，而是 **1ms 就判超时**——过早放弃收尾，正好把
//   这个文件存在的理由（等在途那一拍）原样放回去。所以进 timer 前必须夹一次。
// 注意与 `routes.js` / `materializer.js` 的 `MAX_BACKOFF_MS_SAFE`（60s）区分：那是**空闲退避的业务上限**，
// 「退避超过 60s 没意义」这条判断对关闭超时不成立（关闭上限只受 timer 表示范围约束），两者各自常量。
const NODE_TIMER_MAX_MS = 2147483647;

/** 关闭类超时的硬夹取点：任何要进 `setTimeout` 的关闭上限都先过它（越界 ⇒ Node 折成 1ms ⇒ 过早超时）。 */
export const MAX_SHUTDOWN_TIMEOUT_MS = NODE_TIMER_MAX_MS;

/** 脏值 → 安全毫秒数：非有限数 / ≤0 一律 0（=「不等」，关闭路径上最不该出现「等死」），越界夹到 timer 上限。 */
function safeTimeoutMs(value) {
  const ms = Number.isFinite(value) && value > 0 ? value : 0;
  return Math.min(ms, MAX_SHUTDOWN_TIMEOUT_MS);
}

/**
 * @typedef {object} LoopHandle
 * @property {() => void} [stop] 停循环（要求幂等；抛错被接住，不影响其余循环）
 * @property {Promise<unknown>} [done] 循环真正退出时 resolve / reject（只有可中断的循环才有）
 * @property {string} [name] 可选标签，只用于超时时点名是哪个循环没退
 */

/**
 * 先 `stop()` 全部循环，再有上限地等它们的 `done` 收尾。
 * @param {Array<LoopHandle | null | undefined>} loops 循环句柄（null / 非对象条目跳过）
 * @param {{ timeoutMs?: number, log?: object }} [opts]
 * @returns {Promise<{stopped: number, waited: number, skipped: number, timedOut: boolean,
 *                   pending: string[], rejected: number}>} 给日志与单测看的收尾账目
 */
export async function stopLoopsAndWait(loops, { timeoutMs = 5000, log = console } = {}) {
  const list = (Array.isArray(loops) ? loops : [loops]).filter((l) => l && typeof l === 'object');
  const nameOf = (l, i) => (typeof l.name === 'string' && l.name ? l.name : `loop#${i}`);
  const warn = (msg) => {
    // log 面自己坏了不许把关闭流程拖崩（与循环侧同一口径：日志是尽力而为，不是控制流）
    try { log?.warn?.(msg); } catch { /* 忽略 */ }
  };

  // 第 1 步：全部 stop —— 同步、立刻发信号（顺序 = 传入顺序，测试会断言它）
  let stopped = 0;
  list.forEach((loop, i) => {
    try {
      if (typeof loop.stop === 'function') { loop.stop(); stopped += 1; }
    } catch (err) {
      warn(`[shutdown] ${nameOf(loop, i)} 的 stop() 抛错（忽略，继续关其余循环）：${err?.message ?? err}`);
    }
  });

  // 第 2 步：只 await **有 done** 的循环；缺 done 的记账后跳过（理由见文件头）
  const entries = [];
  list.forEach((loop, i) => {
    if (loop.done && typeof loop.done.then === 'function') entries.push({ name: nameOf(loop, i), done: loop.done });
  });
  const result = { stopped, waited: entries.length, skipped: list.length - entries.length, timedOut: false, pending: [], rejected: 0 };
  if (entries.length === 0) return result;

  // 第 3 步：给每个 done 挂一个**就地记账**的观察器：
  //   · 落定状态在超时点上也要能点名（所以不能等 allSettled 的结果，那要等全部落定才有）；
  //   · 顺手吃掉拒绝 ⇒ 关闭流程自己绝不制造未捕获拒绝（#506 评审③同源的那类坑）。
  const state = entries.map(() => 'pending');
  const tracked = entries.map((entry, i) => entry.done.then(
    (value) => { state[i] = 'resolved'; return value; },
    (err) => { state[i] = 'rejected'; return { rejectedByShutdown: err }; }, // 不冒泡
  ));

  // 第 4 步：有上限地等。超时分支**不再等**剩下的（那可能永远不 resolve），直接记一条 warn 继续退。
  let timer = null;
  // 进 timer 前夹一次（`3e9` 不夹会被 Node 折成 **1ms** ⇒ 过早超时），日志也只报**实际生效**的那个数。
  const effectiveTimeoutMs = safeTimeoutMs(timeoutMs);
  const deadline = new Promise((resolve) => {
    // 改前（#506 copilot 复审①-b）这里是 `Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0`，
    // 即**不夹**上限 ⇒ `timeoutMs: 3e9` 原样进 setTimeout。夹取理由见上面 `MAX_SHUTDOWN_TIMEOUT_MS`。
    // 故意**不 unref**：unref 的 deadline 在「只剩它在等」时会被 Node 当成事件循环已空
    // （实测 node:test 报 `Promise resolution is still pending but the event loop has already resolved`），
    // 那等于 await 被跳过。它是有限长的 timer，落定后立刻 clearTimeout（下面），不会拖住退出。
    timer = setTimeout(() => resolve('timeout'), effectiveTimeoutMs);
  });
  const outcome = await Promise.race([Promise.allSettled(tracked).then(() => 'settled'), deadline]);
  // clearTimeout 是必须的：正常收尾路径上不许留一个还在等的 timer（否则它才是新的“拖住退出”的东西）
  if (timer) clearTimeout(timer);

  result.rejected = state.filter((s) => s === 'rejected').length;
  if (outcome === 'timeout') {
    result.timedOut = true;
    result.pending = entries.filter((_, i) => state[i] === 'pending').map((e) => e.name);
    warn(`[shutdown] 等循环收尾超时（${effectiveTimeoutMs}ms${effectiveTimeoutMs !== timeoutMs ? `，原配置 ${timeoutMs}ms 已夹到 timer 上限` : ''}）：${result.pending.length}/${entries.length} 个没退`
      + `（${result.pending.join(', ') || '无名'}）。继续退出——它们未提交的事务会回滚，`
      + '已认领的行会带着 lease_until 租约等下一轮孤儿回收。');
  }
  return result;
}

// ---------------------------------------------------------------------------
// 整个关闭流程的编排（issue #506 copilot 第二轮复审①）
// ---------------------------------------------------------------------------
//
// 缺陷形状（改前 `cli.js` 的 shutdown）：先 `await stopLoopsAndWait(...)`（最多 5s），**之后**才
// `server.close(() => process.exit(0))`。两个后果：
//   1. 那 5s 里 server 还在 listen ⇒ 仍在接新请求（新 SSE / 新事务在停机窗口里被创建，永远收不了尾）；
//   2. `server.close` **只停止接受新连接，然后等既有连接自己结束**——SSE 是 keep-alive，它的结束
//      依赖循环/心跳清理，于是 close 的回调可能很久不来。⇒ 5s 只是「等循环」的上限，
//      **不是整个关闭流程的上限**：5s + server 关闭可以轻易超过 compose/k8s 默认 10s 宽限期，
//      超了就是 SIGKILL（连 warn 都来不及看，比有超时更糟）。
//
// 于是顺序改成：**先 `server.close()`（发起即返回，不等回调）→ 等循环收尾 → 在剩余总预算里等
// server 关完 → `exit(0)`**，并给**整个流程**一个总上限 `SHUTDOWN_TOTAL_MS`（默认 8000，留 2s 给
// exit 与 compose 宽限期）。到点无论收没收完都退出，并 warn 点名还没退的循环。
// `server.close` 不放第一位的话，那 5s 就白等；总上限不覆盖 server.close 的话，第 2 条照旧。

/** 等循环收尾的默认上限（旧的那个 5s，语义不变）。 */
export const SHUTDOWN_LOOPS_MS_DEFAULT = 5000;
/** 整个关闭流程的总上限：5s 循环 + 3s server 关闭，另留 ~2s 给 exit（compose 默认 10s 宽限期）。 */
export const SHUTDOWN_TOTAL_MS_DEFAULT = 8000;

/**
 * 编排一次优雅关闭：停接新连接 → 等循环收尾 → 等 server 关完 → 退出。**始终在总上限内返回/退出**。
 * @param {object} opts
 * @param {{ close: (cb: (err?: Error | null) => void) => unknown }} [opts.server] HTTP server（假对象可注入）
 * @param {Array} [opts.loops] 循环句柄，原样转交 `stopLoops`
 * @param {number} [opts.loopTimeoutMs] 等循环收尾的上限（默认 `SHUTDOWN_LOOPS_MS_DEFAULT`）
 * @param {number} [opts.totalTimeoutMs] **整个关闭流程**的总上限（默认 `SHUTDOWN_TOTAL_MS_DEFAULT`）
 * @param {object} [opts.log]
 * @param {(code: number) => void} [opts.exit] 默认 `process.exit`（测试注入 spy，否则用例自己被杀掉）
 * @param {(loops: Array, o: object) => Promise<object>} [opts.stopLoops] 默认 `stopLoopsAndWait`
 * @returns {Promise<{sequence: string[], elapsedMs: number, timedOut: boolean, exitCode: number,
 *                    loops: object | null, pendingLoops: string[], serverCloseStarted: boolean,
 *                    serverClosed: boolean, totalTimeoutMs: number, loopTimeoutMs: number}>}
 */
export async function gracefulShutdown({
  server,
  loops = [],
  loopTimeoutMs = SHUTDOWN_LOOPS_MS_DEFAULT,
  totalTimeoutMs = SHUTDOWN_TOTAL_MS_DEFAULT,
  log = console,
  exit = (code) => process.exit(code),
  stopLoops = stopLoopsAndWait,
} = {}) {
  const warn = (msg) => { try { log?.warn?.(msg); } catch { /* 日志不是控制流 */ } };
  const startedAt = Date.now();
  const sequence = [];
  const list = (Array.isArray(loops) ? loops : [loops]).filter((l) => l && typeof l === 'object');
  const nameOf = (l, i) => (typeof l?.name === 'string' && l.name ? l.name : `loop#${i}`);

  // 先给每个 done 挂上就地记账的观察器：总上限到点时要能**点名**还没退的循环，
  // 而那份账在 stopLoops 那边（它可能自己也永不返回）不一定拿得到。顺手吃掉拒绝。
  const state = list.map(() => 'no-done');
  list.forEach((loop, i) => {
    if (!loop.done || typeof loop.done.then !== 'function') return;
    state[i] = 'pending';
    loop.done.then(
      () => { state[i] = 'resolved'; },
      () => { state[i] = 'rejected'; }, // 不冒泡：关闭流程不许制造未捕获拒绝
    );
  });
  const pendingNames = () => list.map((l, i) => (state[i] === 'pending' ? nameOf(l, i) : null)).filter(Boolean);

  const loopBudgetMs = safeTimeoutMs(loopTimeoutMs);
  const totalBudgetMs = safeTimeoutMs(totalTimeoutMs);

  // 第 1 步：**立刻**停止接受新连接（只发起，不等回调——回调要等既有连接自己结束，那是第 3 步的事）
  let serverCloseStarted = false;
  let serverClosed = false;
  const serverClosedP = new Promise((resolve) => {
    if (!server || typeof server.close !== 'function') { serverClosed = true; resolve(); return; }
    sequence.push('server.close');
    serverCloseStarted = true;
    try {
      server.close((err) => {
        serverClosed = true;
        if (err) warn(`[shutdown] server.close 带错误返回（忽略，照样退出）：${err?.message ?? err}`);
        resolve();
      });
    } catch (err) {
      // close 自己抛错（例如从没 listen 过）⇒ 当成已关闭，不许挡住后面的循环收尾
      serverClosed = true;
      warn(`[shutdown] server.close 抛错（忽略，照样收尾退出）：${err?.message ?? err}`);
      resolve();
    }
  });

  // 第 2 步：停循环并等它们收尾（helper 自己有上限；它自己炸了也不许挡住退出）。
  // 结果同时存一仳 `loopsReport`：**总上限到点时不能再 await 它**（注入的假 helper 可以永不 resolve，
  // 那 await 就把「到点强退」本身拖死了）。
  sequence.push('stopLoopsAndWait');
  let loopsReport = null;
  const loopsSettled = (async () => stopLoops(list, { timeoutMs: loopBudgetMs, log }))()
    .then((r) => { loopsReport = r ?? null; return r; })
    .catch((err) => {
      warn(`[shutdown] 收尾 helper 自身抛错（忽略，继续关 server 并退出）：${err?.message ?? err}`);
      return null;
    });

  // 第 3 步：**整个流程**一个总上限（不是只给循环）。到点就退——超过 compose/k8s 的宽限期是 SIGKILL。
  let timer = null;
  const everything = loopsSettled.then(() => serverClosedP).then(() => 'settled');
  const deadline = new Promise((resolve) => {
    const left = Math.max(0, totalBudgetMs - (Date.now() - startedAt));
    // 同 stopLoopsAndWait：故意不 unref，否则「只剩它在等」时 await 会被跳过
    timer = setTimeout(() => resolve('timeout'), left);
  });
  const outcome = await Promise.race([everything, deadline]);
  if (timer) clearTimeout(timer);

  const elapsedMs = Date.now() - startedAt;
  const timedOut = outcome === 'timeout';
  const pendingLoops = pendingNames();
  const report = {
    sequence,
    elapsedMs,
    timedOut,
    exitCode: 0,
    loops: loopsReport, // 取「已落定的那份账」；race 之后**不再 await 任何东西**，否则「到点强退」自己会被拖死
    pendingLoops,
    serverCloseStarted,
    serverClosed,
    loopTimeoutMs: loopBudgetMs,
    totalTimeoutMs: totalBudgetMs,
  };

  if (timedOut) {
    warn(`[shutdown] 关闭流程超过总上限 ${totalBudgetMs}ms（已用 ${elapsedMs}ms）仍没收尾：`
      + `还没退的循环 ${pendingLoops.join(', ') || '（无：要么都退了，要么本来就不带 done）'}`
      + (serverClosed ? '' : '；HTTP server 也没关完（SSE 是 keep-alive，close 只停接新连接、要等既有连接自己结束）')
      + '。直接 process.exit(0)——再等下去就撞上 compose/k8s 默认 10s 宽限期 ⇒ SIGKILL。');
  }
  const loopWaited = loopsReport?.waited ?? 0;
  const loopSkipped = loopsReport?.skipped ?? 0;
  try {
    // eslint-disable-next-line no-console
    log?.log?.(`[portal] 关闭收尾：先 server.close（${serverClosed ? '已关完' : '已停接新连接，未等关完'}）`
      + ` → 循环等了 ${loopWaited} 个（跳过 ${loopSkipped} 个无 done 的）`
      + (loopsReport?.timedOut ? ` ⇒ 循环收尾超时 ${loopBudgetMs}ms` : '')
      + (loopsReport?.rejected ? `，${loopsReport.rejected} 个带错误退出` : '')
      + ` ⇒ 用时 ${elapsedMs}ms / 总上限 ${totalBudgetMs}ms${timedOut ? '（到点强退）' : ''}`);
  } catch { /* 日志坏了也要退 */ }

  // 第 4 步：无论收没收完都退（`exit` 默认就是 `process.exit` ⇒ 后面那行 return 在生产里执行不到）
  exit(report.exitCode);
  return report;
}
