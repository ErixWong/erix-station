// 中止信号最小工具（issue #211）。
// runner 自带工具（shell / file）共用的一份「可被宿主中止」语义：错误形状对齐上游
// erix-agent src/loop/abort.js 的 abortError（name='AbortError'），但**不 import 上游内部模块**
// ——src/loop/abort.js 不是 erix-agent 公开导出面（package.json exports 只暴露包根/子路径导出，
// 深引内部文件会让 runner 依赖上游文件布局），本仓库自带工具自己实现 8 行更稳。
//
// 分工：run 级终态判定仍在 worker.js（靠 run 自己的 abortController.signal.aborted 判 aborted/failed，
// 本模块只负责「工具这一层能被叫停」，不去改终态口径）。

/**
 * 造一个中止错误（语义与形状逐字对齐上游 abortError，abort.js:1-8）：
 *   - signal.reason 是 Error → **原样返回该对象**（保住调用方错误身份与堆栈，不改写）；
 *   - 否则 new Error(reason 文本或默认文案)，name='AbortError'。
 *   ⚠ 不改写 reason 还有一层现实原因：Node 默认 reason 是 DOMException，其 message 是原型上的
 *   只读 getter，ESM 严格模式下赋值会抛 TypeError。
 * @param {AbortSignal} [signal]
 * @returns {Error}
 */
export function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(
    signal?.reason === undefined ? 'The operation was aborted' : String(signal?.reason),
  );
  error.name = 'AbortError';
  return error;
}

/**
 * 已中止就抛（同步/纯计算路径的检查点用）。
 * @param {AbortSignal} [signal]
 */
export function throwIfAborted(signal) {
  if (signal?.aborted === true) throw abortError(signal);
}

/**
 * 挂 abort 监听，返回「摘除」函数（务必在 promise 收尾时调用，防监听器泄漏 / MaxListeners 警告）。
 * signal 缺失、或不支持 addEventListener（测试里的假信号只给 aborted getter）时退化成空操作。
 * @param {AbortSignal} [signal]
 * @param {() => void} handler
 * @returns {() => void} remove
 */
export function onAbort(signal, handler) {
  if (!signal || typeof signal.addEventListener !== 'function') return () => {};
  if (signal.aborted === true) {
    handler();
    return () => {};
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

/**
 * 让出一次事件循环（setImmediate）——纯同步遍历（rg / tree）想「真中断」必须靠它：
 * JS 同步跑起来时 event loop 转不动，agentd 下行的 MSG.ABORT 处理器根本没机会执行，
 * signal.aborted 也就永远不会翻成 true。所以遍历里每 N 次操作让出一次，中止才有落点。
 * @returns {Promise<void>}
 */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
