// P3 PR②a：portal 在 POST 事务内写入新的 session-scoped user 行。
// worker 只选择 resume/全新种子路径，不再代宿主预写 transcript。

/**
 * @param {object} input
 * @param {Array} input.records store.load(key) 全量（RoundRecord[]）
 * @param {string} input.transcriptKey transcript key（=sessionId）
 * @param {string|null} input.messageId 当前消息的 message_id（RUN_START 下行）
 * @param {boolean} input.legacyResume 旧链路回退（无 session/message 下行时 = ticket.resume）
 * @returns {{ resume:boolean }}
 */
export function planTranscriptSeed({ records, transcriptKey, messageId, legacyResume }) {
  // 旧链路（旧 portal ticket 无 session/message 下行）：resume 以 ticket 为准。
  if (!transcriptKey || !messageId) {
    return { resume: legacyResume === true };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { resume: false }; // 空本子，由引擎 round 0 种子入档
  }
  // 新 portal 的 ticket 对应的 :input 行已在 POST 事务写入；迁移前 ticket 也必须保留已有档案。
  // 两种情形都直接恢复，worker 不再推断或补写当前 user 行。
  return { resume: true };
}
