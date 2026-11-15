// issue #520：常驻循环的**节拍**工具（空闲退避 + 可中断 sleep + 严格 env 正整数）。
//
// 为什么另开一个模块：#506 只在 `routes.js` / `materializer.js` 两个 outbox 消费循环里做了空闲退避，
// 当时这两份 `idleDelayMs` / `sleepCancellable` / `envInt` 是各自内联的副本。#520 要把同一形状
// 用到**另外三个**循环（onboarding / offboarding / provisioner），再复制三份就是五份副本——
// 而这三处的判据（「改回去必须红」）要求阶梯算法完全一致，所以抽到这里共用。
// ⚠ **没有**回改 `routes.js` / `materializer.js`：它们在 #506 的改动面里，现在动必然合并撞车
// （工单 fix-261116-01 红线）。等 #506 落地后的一次单独清理再统一。
//
// 算法与 #506 逐字同形（唯一的差别是基准节拍 `baseMs` 由调用方给，#506 那两处固定 250ms）：
//   · `idleTicks = 0` ⇒ 上一拍有活 ⇒ 回基准；
//   · `idleTicks = n` ⇒ `baseMs * 2^(n-1)`，夹在 `[baseMs, min(maxMs, MAX_BACKOFF_MS_SAFE)]`。

// Node 的 timer 只吃 **32 位有符号整数**：`setTimeout(fn, 3e9)` 会被折成 **1ms**
// （`Timeout duration was set to 1.`，#506 评审①实测）。所以退避上限必须夹，否则「退避变长」
// 的真实后果是**退化成 1ms 空转**——比不修还糟。
export const NODE_TIMER_MAX_MS = 2147483647;
// 业务上限：与 #506 同口径取 60s（`max` 越界 ⇒ 回落默认 + warn，不静默夹取，理由见 `envInt`）。
export const MAX_BACKOFF_MS_SAFE = Math.min(NODE_TIMER_MAX_MS, 60_000);

// 严格正整数：**trim 后整串**必须全是十进制数字（#506 第四轮复审③的口径）。
// `parseInt` 吃前缀 ⇒ `'1e4'` → 1、`'10000abc'` → 10000，两种都静默：配了垃圾值却按另一个数生效，
// 比直接不认更难查。空格算合法（compose / env-file 里带空格很常见）。
const STRICT_POSITIVE_INT_RE = /^\d+$/;

/**
 * 正整数 env（照 #506 `routes.js` 的 `envInt`）。三种情形一律**回落默认并 warn**，绝不静默：
 *   · 非法值（`abc` / `-1` / `0` / `1e4` / `10000abc`）；
 *   · 越界（> `max`）；
 *   · 没配（空串）⇒ 静默用默认（这不是错误，不该每次启动刷噪声）。
 * @param {string} name @param {number} fallback @param {{max?: number, log?: object}} [opts]
 */
export function envInt(name, fallback, { max = MAX_BACKOFF_MS_SAFE, log = console } = {}) {
  const raw = String(process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = STRICT_POSITIVE_INT_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    log.warn?.(`[env] ${name}=${raw} 不是严格正整数（trim 后整串必须是十进制数字；'1e4' / '10000abc' 这类不认）`
      + ` ⇒ 回落默认 ${fallback}ms（这行配置没生效）`);
    return fallback;
  }
  if (n > max) {
    log.warn?.(`[env] ${name}=${n} 超过安全上限 ${max}ms ⇒ 回落默认 ${fallback}ms（不夹取：夹取会让人以为这行配置生效了）`);
    return fallback;
  }
  return n;
}

/**
 * 第 `idleTicks` 个**连续空闲拍**该等多久。
 * @param {number} idleTicks 0 = 上一拍认领到了活 ⇒ 回基准
 * @param {{ baseMs: number, maxMs?: number }} opts baseMs = 有活时的基准节拍（#506 是 250，本单三个循环是 5000）
 * @returns {number} 恒在 `[baseMs, min(maxMs, MAX_BACKOFF_MS_SAFE)]`
 */
export function idleDelayMs(idleTicks, { baseMs, maxMs = MAX_BACKOFF_MS_SAFE } = {}) {
  // 基准本身也要防越界：`baseMs` 来自代码常量 + env，越界同样会造出 1ms 空转。
  const base = Number.isFinite(baseMs) && baseMs > 0 ? Math.min(baseMs, MAX_BACKOFF_MS_SAFE) : MAX_BACKOFF_MS_SAFE;
  if (!(idleTicks > 0)) return base;
  const cap = Number.isFinite(maxMs) && maxMs > 0
    ? Math.min(Math.max(base, maxMs), MAX_BACKOFF_MS_SAFE) // 下限：配置不许把基准节拍压低
    : Math.min(Math.max(base, 60_000), MAX_BACKOFF_MS_SAFE); // NaN / Infinity / 负数 ⇒ 生产上限
  return Math.min(base * 2 ** (idleTicks - 1), cap);
}

/**
 * 可中断 sleep（照 #506）：`stop()` 不许再等满一个退避窗口——本单把上限从 2s 抬到 30s，
 * 不可中断的 sleep 会把优雅关闭的等待同步抬到 30s。
 * resolve(true) = 睡满了；resolve(false) = 被 abort（调用方应当立刻退出循环）。
 * @param {number} ms @param {AbortSignal} [signal]
 */
export function sleepCancellable(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * #506 评审③同款：给裸 async IIFE 的循环 Promise 挂上就地处理器，返回
 * `{ settled, failure }`。`done` 原样交给 `stopLoopsAndWait`（拒绝照原样冒），
 * `settled` 永不拒绝 ⇒ 只想等退出的人不会自己制造未捕获拒绝。
 * @param {Promise<unknown>} done @param {(msg: string) => void} [warn]
 */
export function attachLoopWatch(done, warn) {
  let loopFailure = null;
  const settled = done.catch((err) => {
    loopFailure = err;
    try {
      warn?.(`循环异常退出（已就地接住，未成为未捕获拒绝）：${err?.message ?? err}`);
    } catch {
      // 日志面自己坏了不许再制造第二条未捕获拒绝
    }
  });
  return { settled, failure: () => loopFailure };
}
