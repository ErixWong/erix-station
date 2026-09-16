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

/** store_request 支持的 method（runner §9.1 六方法）。 */
export const STORE_METHODS = new Set([
  'appendRound',
  'load',
  'recall',
  'markRunState',
  'saveCheckpoint',
  'loadLatestCheckpoint',
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
  if (proc && typeof proc.send === 'function' && proc.connected) {
    try {
      return proc.send(msg);
    } catch {
      return false;
    }
  }
  return false;
}
