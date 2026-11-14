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

// ---------------------------------------------------------------------------
// 退出前把日志刷下去（issue #506 copilot **第三轮复审①**）
// ---------------------------------------------------------------------------
//
// 缺陷形状：`gracefulShutdown` 在「总 deadline 获胜且仍有循环 pending」时，记完 warn 与汇总就
// `exit(0)`。两个后果：
//   1. `process.exit()` **不保证**已经排队的 stdout/stderr 写入落到 fd 上。生产里 stdout/stderr
//      是**管道**（compose / k8s 的日志驱动），管道上的写入是异步的 ⇒ 恰好在最需要看日志的那一次，
//      那条 warn 与汇总行可能被截断。
//   2. 同一条路径上在途的 DB 事务被强断 ⇒ 整笔回滚，或留下带 `lease_until` 的 `processing` 行。
//
// 修法只有一件事：**exit 前先刷一次**（对每个 stream `write('', cb)` 等回调，带超时；**超时也照样
// 退**）。第 2 条不在这里治：**预算就是预算**，超了就不再等——残留的 `processing` 行由 `lease_until`
// 到期后的**既有**孤儿回收接管（那是仓库里早就有的机制，不是这条修改新增的承诺）。改成「为了等事务
// 而延长 deadline / 给 exit 加长超时」会把 #506 最初的缺陷（关闭没有上限）原样放回去。

/** 刷日志的默认上限：够把已排队的几行推到 fd（实测本机管道上 `write('', cb)` ≈2ms），又不至于拖住退出。 */
export const FLUSH_LOGS_TIMEOUT_MS_DEFAULT = 250;

/**
 * 对每个流写一个**空 chunk**（不产生任何输出，只是把该流上已排队的写入推到 fd）并等回调；
 * 每个流各自带超时，**超时/抛错都算刷过**（日志是尽力而为，不是控制流）。
 * @param {{ timeoutMs?: number, streams?: Array<{ write: (chunk: string, cb: () => void) => unknown }> }} [opts]
 * @returns {Promise<{attempted: number, flushed: number, stuck: number, elapsedMs: number}>} 给日志与单测看的账
 */
export function flushLogs({
  timeoutMs = FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  streams = [process.stdout, process.stderr],
} = {}) {
  const list = (Array.isArray(streams) ? streams : [streams]).filter((s) => s && typeof s.write === 'function');
  const limit = safeTimeoutMs(timeoutMs);
  const startedAt = Date.now();
  const one = (stream) => new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (flushed) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer); // 刷日志的 timer 不许反过来拖住退出（与收尾 timer 同一口径，故意不 unref）
      resolve(flushed);
    };
    // timer **先建**再 write：注入的假 stream 会**同步**回调，先 write 就会留下一个清不掉的悬空 timer。
    timer = setTimeout(() => finish(false), limit);
    try {
      stream.write('', () => finish(true));
    } catch {
      finish(false); // 流自己坏了（EPIPE、已 destroy）⇒ 认了，不许挡住 exit
    }
  });
  return Promise.all(list.map(one)).then((flags) => {
    const flushed = flags.filter(Boolean).length;
    return { attempted: list.length, flushed, stuck: flags.length - flushed, elapsedMs: Date.now() - startedAt };
  });
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
// server 关完 → 刷日志 → `exit(0)`**，并给**整个流程**一个总上限 `SHUTDOWN_TOTAL_MS`（默认 8000，剩下
// ~2s 给刷日志、exit 与 compose 宽限期）。到点无论收没收完都退出，并 warn 点名还没退的循环。
// `server.close` 不放第一位的话，那 5s 就白等；总上限不覆盖 server.close 的话，第 2 条照旧。

/** 等循环收尾的默认上限（旧的那个 5s，语义不变）。 */
export const SHUTDOWN_LOOPS_MS_DEFAULT = 5000;
/** 整个关闭流程的总上限：5s 循环 + 3s server 关闭，另留 ~2s 给刷日志与 exit（compose 默认 10s 宽限期）。 */
export const SHUTDOWN_TOTAL_MS_DEFAULT = 8000;

/**
 * 编排一次优雅关闭：停接新连接 → 等循环收尾 → 等 server 关完 → **刷日志** → 退出。**始终在总上限内返回/退出**
 * （刷日志**也在总预算之内**：它的超时取「剩余预算」与 `flushTimeoutMs` 取小，不是额外赠送的 250ms）。
 * @param {object} opts
 * @param {{ close: (cb: (err?: Error | null) => void) => unknown }} [opts.server] HTTP server（假对象可注入）
 * @param {Array} [opts.loops] 循环句柄，原样转交 `stopLoops`
 * @param {number} [opts.loopTimeoutMs] 等循环收尾的上限（默认 `SHUTDOWN_LOOPS_MS_DEFAULT`）
 * @param {number} [opts.totalTimeoutMs] **整个关闭流程**的总上限（默认 `SHUTDOWN_TOTAL_MS_DEFAULT`）
 * @param {object} [opts.log]
 * @param {(code: number) => void} [opts.exit] 默认 `process.exit`（测试注入 spy，否则用例自己被杀掉）
 * @param {(loops: Array, o: object) => Promise<object>} [opts.stopLoops] 默认 `stopLoopsAndWait`
 * @param {(o: object) => Promise<object>} [opts.flush] 默认 `flushLogs`：exit 前把已排队的日志推到 fd（第三轮复审①）
 * @param {number} [opts.flushTimeoutMs] 刷日志的上限**请求值**（默认 `FLUSH_LOGS_TIMEOUT_MS_DEFAULT`）；
 *   实际生效值 = `min(该请求值, 总预算剩余)`（第四轮复审①：flush 不许突破总上限），落在返回账目 `flushTimeoutMs`
 * @param {Array} [opts.logStreams] 注入点：要刷的流（缺省交给 `flushLogs` 自己取 stdout/stderr）
 * @returns {Promise<{sequence: string[], elapsedMs: number, timedOut: boolean, exitCode: number,
 *                    loops: object | null, pendingLoops: string[], serverCloseStarted: boolean,
 *                    serverClosed: boolean, totalTimeoutMs: number, loopTimeoutMs: number,
 *                    flush: object | null, flushTimeoutMs: number}>}
 *   （`elapsedMs` **含**退出前刷日志那一段；`flushTimeoutMs` 是实际生效的刷日志上限）
 */
export async function gracefulShutdown({
  server,
  loops = [],
  loopTimeoutMs = SHUTDOWN_LOOPS_MS_DEFAULT,
  totalTimeoutMs = SHUTDOWN_TOTAL_MS_DEFAULT,
  log = console,
  exit = (code) => process.exit(code),
  stopLoops = stopLoopsAndWait,
  flush = flushLogs,
  flushTimeoutMs = FLUSH_LOGS_TIMEOUT_MS_DEFAULT,
  logStreams,
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
    // 残留是**显式接受**的，不是漏掉了：到点就不再等（预算就是预算），剩下的在途事务随进程退出回滚，
    // 已认领的 `processing` 行带着 `lease_until` 躺在那儿，由**既有的**孤儿回收（租约到期后接管）捞回。
    // 另：下面 exit 前会先 `flushLogs`，否则这条 warn 在管道上自己被截断（第三轮复审① 的第一半）。
    warn(`[shutdown] 关闭流程超过总上限 ${totalBudgetMs}ms（已用 ${elapsedMs}ms）仍没收尾：`
      + `还有 ${pendingLoops.length} 个循环没退（${pendingLoops.join(', ') || '无名'}）`
      + (serverClosed ? '' : '；HTTP server 也没关完（SSE 是 keep-alive，close 只停接新连接、要等既有连接自己结束）')
      + '。不再等，直接 process.exit(0)——再等下去就撞上 compose/k8s 默认 10s 宽限期 ⇒ SIGKILL。'
      + '残留已知：在途事务会回滚，已认领的行会带着 lease_until 租约等着，由既有的孤儿回收（租约到期后）接管。');
  }
  const loopWaited = loopsReport?.waited ?? 0;
  const loopSkipped = loopsReport?.skipped ?? 0;
  try {
    // eslint-disable-next-line no-console
    log?.log?.(`[portal] 关闭收尾：先 server.close（${serverClosed ? '已关完' : '已停接新连接，未等关完'}）`
      + ` → 循环等了 ${loopWaited} 个（跳过 ${loopSkipped} 个无 done 的）`
      + (loopsReport?.timedOut ? ` ⇒ 循环收尾超时 ${loopBudgetMs}ms` : '')
      + (loopsReport?.rejected ? `，${loopsReport.rejected} 个带错误退出` : '')
      // 「刷日志前」三个字是**故意**的：汇总行必须**在 flush 之前**记（否则它自己就不会被刷），
      // 所以这里的数字天然不含 flush；含 flush 的最终耗时看返回账目 `report.elapsedMs`。
      + ` ⇒ 用时 ${elapsedMs}ms（刷日志前）/ 总上限 ${totalBudgetMs}ms${timedOut ? '（到点强退）' : ''}`);
  } catch { /* 日志坏了也要退 */ }

  // 第 4 步：**先刷日志，再 exit**（copilot 第三轮复审①）。
  // 为何必须：`process.exit()` 不等已经排队的 stdout/stderr 写入落盘，而生产里它们就是**管道**
  // ⇒ 上面那条 warn（以及汇总行）可能在到点强退那一次里被截断。deadline 路径与正常路径**都**走这里。
  //
  // **预算口径（copilot 第四轮复审①）：flush 在总预算之内，不是额外赠送的 250ms。**
  // 改前这里是「`flush({ timeoutMs: flushTimeoutMs })`」——总 deadline 的 race 已经结束、timer 也
  // clearTimeout 了，才又**无条件**等最多 250ms ⇒ 两点都不成立：
  //   · 「整个关闭流程 ≤ totalTimeoutMs」被突破（到点强退实际是 total + flushTimeoutMs）；
  //   · `report.elapsedMs` 是 flush **之前**算的 ⇒ 账面上报的时间比真实耗时少一段，运维看日志对不上；
  //   · 更糟的是 flushTimeoutMs 是**调用方传的**：传 `3e9` 就等约 24.9 天（夹取后的 timer 上限）——
  //     「有上限的关闭」在这一步又变回没有上限。
  // 修法：flush 的超时取 **min(flushTimeoutMs, 剩余预算)**；剩余为 0 时**照样调用**（write 本身仍会把
  // 已排队的字节推下去），但不等回调 ⇒ 总上限是**硬**的，flush 只是「余量里能刷多少算多少」。
  sequence.push('flushLogs');
  const flushRequestedMs = safeTimeoutMs(flushTimeoutMs);
  const remainingMs = Math.max(0, totalBudgetMs - (Date.now() - startedAt));
  const flushBudgetMs = Math.min(flushRequestedMs, remainingMs);
  let flushReport = null;
  try {
    flushReport = await flush({ timeoutMs: flushBudgetMs, ...(logStreams ? { streams: logStreams } : {}) });
  } catch (err) {
    // 刷日志自己炸了不许把 exit 挡掉（日志不是控制流）
    warn(`[shutdown] 退出前刷日志失败（忽略，照样 exit）：${err?.message ?? err}`);
  }
  report.flush = flushReport;
  report.flushTimeoutMs = flushBudgetMs; // **实际生效**的那个数（= 请求值与剩余预算取小），不是请求值
  // elapsedMs 必须**含** flush 那一段（第四轮复审①：改前它少算一段，账目与真实耗时不一致）
  report.elapsedMs = Date.now() - startedAt;

  // 第 5 步：无论收没收完都退（`exit` 默认就是 `process.exit` ⇒ 后面那行 return 在生产里执行不到）
  exit(report.exitCode);
  return report;
}
