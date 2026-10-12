// issue #261（后端半边）：worker 侧 LLM provider 超时相的显式配置（纯函数、零依赖、不 import 引擎）。
//
// 要解决的问题（工单 /tmp/TICKET-261 + issue #261 及其更正评论，2026-10-12 R-2 演练实测）：
// `runner/worker.js` 调 `createOpenAIProvider` 曾**不传任何超时配置**，于是引擎 erix-agent 0.18.0
// 走 legacy 模式：`src/providers/payload.js` `resolveProviderTimeouts` 里 `hasExplicitPhase=false`
// ⇒ `legacyTimeoutMs = requestTimeoutMs = 120000`；`src/providers/timeout.js:43-46` 据此算出
// `legacyDeadline = startedAt + legacyTimeoutMs`——一条**从请求发起就定死的绝对线**，覆盖
// 排队 + prefill + 全部生成，流式有 chunk 回流也**不重置**（`timeout.js` `phaseEntries`：
// `legacyDeadline !== undefined` 时只返回这一条 `{phase:'request'}`，三相全部作废）。
// 重型轮子（8-10K 输出 ≈ 100-130s）自然逼近 120s ⇒ run 整条 `failed`、
// `termination={reason:'failed',errorCode:'timeout',detail:'request timed out'}`。
//
// 本模块的唯一职责：给 `createOpenAIProvider` 一份**显式**的相超时。真正的修复不是「把 120000
// 换成更大的数」，而是**触发引擎 `hasExplicitPhase=true` 让 legacy 总闸消失**（`legacyTimeoutMs
// === undefined`）——这条真正的回归门由 `runner/test/llm-timeouts.test.js` ② 钉住。
//
// 参数契约（决策者定稿，不要自行改数值口径；issue #261）：
//   firstByteTimeoutMs   240000      首字节前的静默上限（用户语义：超过 N 秒没返回才算超时）
//   streamIdleTimeoutMs  180000      见到首字节后**每来一个 chunk 重新计时**（有返回就不算超时）
//   streamTotalTimeoutMs 2147483647  ≈「不设总闸」，为什么只能是这个数见下方 MAX_TIMER_MS
//   requestTimeoutMs     300000      只兜**非流式**路径（如会话标题生成），防悬挂
// 四项都可 env 覆盖（`LLM_TIMEOUT_ENV`，已登记 `docs/env.md` §10.4）；默认值就是上表。
//
// env 解析口径（红线：不许抛错炸 run）：
//   · 未设置（undefined / null / 空串或纯空白）→ 默认值，**不 warn**（没配过不算配错）。
//   · 有限且 ≥1 的数字 → 采用；> MAX_TIMER_MS → 钳到 MAX_TIMER_MS 并 warn（否则 Node 把延时钳成 1ms）。
//   · 其余非法值（0 / 负数 / NaN / 垃圾串 / **Infinity**）→ 回落默认 + `console.warn` 一次。
//     `Infinity` 特意归到非法：它字面上像「永不超时」，实际会踩下面那条溢出陷阱，不给它透传的路。

// setTimeout 不溢出的最大 delay（2^31-1 ms ≈ 24.85 天）。Node 对 > 2^31-1 或 NaN/Infinity 的
// delay 发 `TimeoutOverflowWarning` 并把延时**钳成 1ms**——「以为不超时，其实秒死」。
//
// 为什么 `streamTotalTimeoutMs` 只能写成这个数，而不是更自然的 undefined / null / 0 / Infinity
// （0.18.0 源码 + 本机实测，取证见 runner/test/llm-timeouts.test.js ③ 与交付报告）：
//   · `undefined` / `null`：`resolveProviderTimeouts` 用 `?? 300000` 回落**引擎默认 300s**——
//     引擎没有「显式关闭总闸」这个值，重型轮子（>300s）照样被杀。
//   · `0` / `false`：`??` 不拦 0/false，值原样透传；`providers/openai.js:500-504` 再算
//     `Math.max(0, 0 - streamElapsedMs())` = 0 → `setTimeout(fn, 0)` → **流一开跑就被杀**
//     （实测：3ms 即 `streamTotal timed out`）。
//   · `Infinity`：两条路都不是我们想要的。流式路上 `timeout.js` `normalizeDuration` 只认
//     `Number.isFinite`，Infinity 让这一相**整条被丢弃** ⇒ 根本没有表（静默 fail-open，
//     靠的是引擎内部实现细节，不是契约）；非流式路（`providers/openai.js` `chat()` 把
//     `requestTimeout` 直接交给 `setTimeout`，不过 normalizeDuration）则撞溢出钳制 → 1ms →
//     **立刻 `request timed out`**（实测：7ms 即失败，症状与本单要修的 120s 一模一样）。
//   ⇒ 唯一在两条路上都「溢出安全 + 事实关闭 + 不依赖内部实现」的写法就是 `2 ** 31 - 1`。别改成 Infinity。
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** 决策者定稿的默认四项（毫秒）；键名 = 引擎 `resolveProviderTimeouts` 认的显式相键名。 */
export const DEFAULT_LLM_TIMEOUTS = Object.freeze({
  firstByteTimeoutMs: 240_000,
  streamIdleTimeoutMs: 180_000,
  streamTotalTimeoutMs: MAX_TIMER_MS,
  requestTimeoutMs: 300_000,
});

/** 四项的 env 覆盖入口（字段名 ↔ env 名一一对应；语义与默认值登记在 docs/env.md §10.4）。 */
export const LLM_TIMEOUT_ENV = Object.freeze({
  firstByteTimeoutMs: 'ERIX_LLM_TIMEOUT_FIRST_BYTE_MS',
  streamIdleTimeoutMs: 'ERIX_LLM_TIMEOUT_STREAM_IDLE_MS',
  streamTotalTimeoutMs: 'ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS',
  requestTimeoutMs: 'ERIX_LLM_TIMEOUT_REQUEST_MS',
});

// 「同一个坏值只 warn 一次」：worker 每 run 才解析一次，但同一个坏 env 会在崩溃恢复/重试的
// 每个 run 里重复命中，去重以免刷日志。dedupe 键 = `<env 名> <原始值>`（不同坏值各提示一次）。
const warnedKeys = new Set();

function defaultWarn(envName, raw, message) {
  const key = `${envName}\u0000${String(raw)}`;
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(`[station-runner] ${message}`);
}

function parseTimeoutMs(raw, { envName, defaultValue }, warn) {
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === undefined || text === null || text === '') return defaultValue;
  const n = typeof text === 'number' ? text : Number(text);
  if (!Number.isFinite(n) || n < 1) {
    warn(envName, raw, `env ${envName}="${String(raw)}" 不是有限正数毫秒值（0 / 负数 / NaN / Infinity / 垃圾串皆非法），回落默认 ${defaultValue}ms`);
    return defaultValue;
  }
  if (n > MAX_TIMER_MS) {
    warn(envName, raw, `env ${envName}="${String(raw)}" 超过 setTimeout 上限 ${MAX_TIMER_MS}ms（再大 Node 会把延时钳成 1ms → 请求秒死），已钳到 ${MAX_TIMER_MS}ms`);
    return MAX_TIMER_MS;
  }
  return n;
}

/**
 * 解析喂给 `createOpenAIProvider({ timeouts })` 的四相超时（默认 = 决策者定稿值，env 可覆盖）。
 * 纯函数：只读入参 env，不读进程全局、不 import 引擎。四项**永远非空**——这正是关闭引擎
 * legacy 120s 总闸的开关（任一相为 undefined 都可能让 `hasExplicitPhase` 判假）。
 *
 * @param {Record<string, string|undefined>} [env] 缺省 process.env（测试传自造对象）
 * @param {{ warn?: (envName: string, raw: unknown, message: string) => void }} [io] 注警器（测试用）
 * @returns {{firstByteTimeoutMs:number, streamIdleTimeoutMs:number, streamTotalTimeoutMs:number, requestTimeoutMs:number}}
 */
export function resolveLlmTimeouts(env = process.env, { warn = defaultWarn } = {}) {
  const out = {};
  for (const field of Object.keys(LLM_TIMEOUT_ENV)) {
    const envName = LLM_TIMEOUT_ENV[field];
    out[field] = parseTimeoutMs(env?.[envName], { envName, defaultValue: DEFAULT_LLM_TIMEOUTS[field] }, warn);
  }
  return out;
}
