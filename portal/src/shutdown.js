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
