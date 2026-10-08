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

/**
 * 引擎 runToolLoop 的「种子」选项（纯函数，供单测）。对齐上游 CLI `repl.js:656` 的
 * `...(resume ? {} : { initialUserMessage })` 模式。
 *
 * P3 PR③（issue #69 文本注入退役）：**两个分支都永不返回 `initialMessages`**——
 * 会话上下文唯一来源 = transcript（resume 时恢复记录即完整上文；空本子由引擎 round 0
 * 把 `task` 种进 transcript）。原 `initialMessages: mapHistoryToInitialMessages(history)`
 * 注入链已退役（thinking 模型会因 `reasoning_content must be passed back` 被上游拒）。
 *
 * @param {object} input
 * @param {boolean} input.resume 是否走 transcript resume
 * @param {string} input.task 本轮用户输入（RUN_START.task）
 * @returns {Record<string, unknown>} 展开进 runToolLoop options 的种子片段
 */
export function buildEngineSeedOptions({ resume, task }) {
  if (resume === true) return {}; // 恢复记录即完整上文：不传 initialMessages/initialUserMessage
  return { initialUserMessage: typeof task === 'string' ? task : '' };
}
