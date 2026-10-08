// issue #212：run 失败/中止终态信封构造（worker catch 专用；纯函数，可单测 runner/test/termination.test.js）。
//
// 背景：erix-agent 0.17.0 的失败/中止走 `fail()` **抛异常**，并把完整 termination 挂在上抛的错误上
//   （`erix-agent/src/loop/orchestrator.js:734-773` 定 reason + 挂落盘细节，
//     `erix-agent/src/loop/termination.js:40-49` `annotateTermination` 把对象塞进 `error.termination`）。
//   于是：
//     * `reason` 可能是 `persistence_failed`（run snapshot / markRunState 没落盘），**不是** `failed`；
//     * 该 reason 还额外携带 `operation` / `phase` / `sideEffect`（哪一步没写、副作用是否可能已发生）。
//   station 此前在 worker 里把它拍平成 `{reason:'failed'}`，前端既看不见「快照没落盘」也看不见 phase，
//   崩溃恢复可能重复副作用这一最重的语义被降级成一条普通失败。
//
// retryable 判据同样与上游对齐（此前是手写半截清单：只有 `checkpoint_failed` 与 `rate_limited`）：
//   上游 `erix-agent/src/providers/errors.js:1` `RETRYABLE_CODES` = `timeout` / `rate_limited` /
//   `server` / `disconnect`，再加 `checkpoint_failed`（`src/loop/run-snapshot-executor.js` 抛的
//   KitError，已对外文档化为可重试，见 docs/api/portal.md §6.2/§6.4）。
//
// ⚠️ 单一真相：可重试码集的权威常量在前端 `portal/frontend/src/lib/terminationReasons.ts`
//   （`RUN_RETRYABLE_ERROR_CODES`，理由见该文件头注）。本文件是它的**运行时镜像**——FDE 镜像只
//   `COPY runner/*`（runner/Dockerfile），运行时拿不到前端文件，所以必须自带一份；两者的逐项一致
//   由 `portal/test/termination-contract.test.js` 钉死（改一处必改另一处，否则根 npm test 挂）。
//   `termination.reason` 全集则不在本文件重复：runner 只做透传，不校验取值（§5.3 向后兼容）。

/** 上游判定「可重试」的 run 级错误码（与前端 RUN_RETRYABLE_ERROR_CODES 逐项一致）。 */
export const RETRYABLE_ERROR_CODES = new Set([
  'timeout',
  'rate_limited',
  'server',
  'disconnect',
  'checkpoint_failed',
]);

/** 错误码是否属上游可重试码集（`err.retryable` 显式为 true 时另算，见 buildFailureEnvelope）。 */
export function isRetryableErrorCode(code) {
  return typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code);
}

/**
 * 取引擎挂在错误上的 termination（优先），没有才回退拍平口径。
 * 透传时保留全部上游键（reason/detail/operation/phase/sideEffect 及未来 additive 新增键）。
 *
 * @param {{ termination?: unknown, aborted?: boolean }} input
 * @returns {Record<string, unknown>}
 */
export function buildRunTermination({ termination, aborted = false } = {}) {
  const reason = typeof termination?.reason === 'string' && termination.reason.length > 0
    ? termination.reason
    : null;
  // 引擎没给（非 runToolLoop 抛出的错误、或旧版本引擎）→ 回退历史口径。
  if (reason === null) return { reason: aborted ? 'aborted' : 'failed' };
  // 竞态兜底：引擎的 fail() 用自己的 signal 快照定 reason，若它在 abort 落地前就判成兜底值
  // `failed`，而 worker 自己的 signal 已 aborted，仍以「用户主动停止」呈现——agentd 据此把
  // run 收敛为 finished（runner/agentd.js:929），与本次改动前的行为一致（「停止」不会变红成失败）。
  // 只覆盖兜底值 `failed`：引擎给出的其它 reason（含 persistence_failed）一律以引擎为准。
  if (aborted && reason === 'failed') return { ...termination, reason: 'aborted' };
  return /** @type {Record<string, unknown>} */ (termination);
}

/**
 * 构造 `run_finished`（IPC）的失败终态片段：`termination` + `error`。
 * @param {{ err: any, aborted?: boolean }} input
 * @returns {{ termination: Record<string, unknown>, error: { code: string, message: string, retryable: boolean } }}
 */
export function buildFailureEnvelope({ err, aborted = false } = {}) {
  const code = aborted ? 'aborted' : (err?.code ?? 'failed');
  return {
    termination: buildRunTermination({ termination: err?.termination, aborted }),
    error: {
      code,
      message: String(err?.message ?? err),
      // 上游显式标记优先，其余按码表判（issue #212：此前只认 checkpoint_failed / rate_limited）。
      retryable: err?.retryable === true || isRetryableErrorCode(code),
    },
  };
}
