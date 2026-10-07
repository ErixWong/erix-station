// IPC 协议常量与辅助（agentd ↔ worker 共享，零依赖）。
// 依据：docs/design/runner-integration.md §5（消息表）——传输用 Node child_process.fork 内建 IPC 通道（JSON 序列化）。
// 所有消息 {type, ...}；请求/响应式消息带 req_id（worker 侧单调递增）。

/** 消息类型（runner §5 消息表）。 */
export const MSG = {
  // worker → agentd
  WORKER_READY: 'worker_ready',
  EVENT: 'event',
  STORE_REQUEST: 'store_request',
  APPROVAL_REQUEST: 'approval_request',
  RUN_FINISHED: 'run_finished',
  LOG: 'log',
  // agentd → worker
  RUN_START: 'run_start',
  STORE_RESPONSE: 'store_response',
  APPROVAL_DECISION: 'approval_decision',
  ABORT: 'abort',
};

/**
 * store_request 支持的 method（runner §9.1 映射表）。
 * 0.14.0 TranscriptStore 必需 appendRound/load；快照与 run-state 是可选能力。
 * `loadRunStateStatus` 是 station 的宿主读接口，不属于引擎能力校验。
 * `recall` 为 **legacy 兼容项**（0.8.0 recall 退役：引擎不再调用、worker 不注册 recall 工具；
 * U7 端点保留只读兼容，见 issue #43 拍板）——不属于 TranscriptStore 契约。
 */
export const STORE_METHODS = new Set([
  'appendRound',
  'load',
  'markRunState',
  'saveRunState',
  'loadRunState',
  'loadRunStateStatus',
  'saveRunSnapshot',
  'loadLatestRunSnapshot',
  // legacy（0.8.0 recall 退役，非 0.9.0 契约方法）：
  'recall',
]);

/**
 * 规范化 RoundRecord 为 portal U5 请求体。
 * erix-agent v0.3.5 的 appendRound record 使用 roundKey（round 0 种子）或 roundKey+dedupKey（常规轮），
 * portal U5 要求必填 dedupKey（≤256 字符）；这里兜底注入 dedupKey，并对齐 folded/messages/foldedPayload 字段。
 */
export function normalizeRoundRecord(runId, record) {
  const round = Number.isInteger(record?.round) ? record.round : 0;
  const dedupKey = typeof record?.dedupKey === 'string' && record.dedupKey.length > 0
    ? record.dedupKey
    : (typeof record?.roundKey === 'string' && record.roundKey.length > 0
      ? record.roundKey
      : `${String(runId)}:round:${String(round)}`);
  return {
    ...(record ?? {}),
    dedupKey,
    round,
    folded: record?.folded === true,
    messages: Array.isArray(record?.messages) ? record.messages : [],
    foldedPayload: record?.foldedPayload ?? null,
  };
}

/** 生成单调递增的 req_id（worker 侧）。 */
export function createReqIdGenerator() {
  let n = 0;
  return () => ++n;
}

/** 发送 IPC 消息（忽略通道关闭的写失败，避免 shutdown 竞态抛错）。 */
export function sendIpc(proc, msg) {
  // ⚠️ Node IPC 背压语义（真机 bug 实证）：proc.send() 返回 false 有两种含义——
  //   ① channel 已关闭（真失败）；② 消息超过内部缓冲阈值，**已入队**待 'drain'（背压，非失败！）。
  // 原实现把 false 一律当失败 → 大 checkpoint（transcript 增长跨过阈值）被误判
  // 'ipc channel closed' → 引擎 fail-closed → run 在固定 round 确定性失败。
  // 修法：connected 为真时 send 只可能「成功/入队」或「抛错」，false 一律视为已入队成功。
  if (proc && typeof proc.send === 'function' && proc.connected) {
    try {
      proc.send(msg);
      return true;
    } catch (err) {
      // 序列化失败（BigInt/循环引用）或 send 时 channel 恰好关闭——真失败，留痕。
      lastSendError = err?.message ?? String(err);
      return false;
    }
  }
  lastSendError = 'channel closed';
  return false;
}

/** 最近一次 sendIpc 失败的真实原因（ipcRequest reject 时透传，避免误诊）。 */
export let lastSendError = null;
