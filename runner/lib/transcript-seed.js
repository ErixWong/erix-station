// issue #81 P2：worker 装配 runToolLoop 前的 transcript 种子决策（纯函数，供单测）。
// 照抄 erix-agent CLI「预写入 + resume」模式（bin/cli.js:566-614 / bin/repl.js:602-656），
// 依据 docs/design/conversation-state.md §4.1 三分支：
//   ① 空本子（会话首条，load 无记录）→ 不 resume：initialMessages(#70 history) + initialUserMessage
//     走引擎全新路径（引擎自行 round 0 种子入档）。
//   ② 新消息未入档（正常下一轮 / 崩溃在预写前）→ 宿主预写入 appendRound
//     （round = latestRound，dedupKey = `<key>:input:<messageId>` 幂等）→ resume=true。
//   ③ 消息已入档（崩溃重跑 attempt>1）→ 直接 resume=true，不重复写入（幂等红线）。
//
// ⚠️ 判据细节（CLI 没有的崩溃重跑歧义，CLI 每轮独立进程、station 有 attempt>1）：
//   attempt>1 且 dedupKey 未命中时，transcript 里可能已有本条消息，两种来源：
//   a) attempt 1 走的是分支①（当时 transcript 为空）：引擎 round 0 种子已把本条 user 消息入档
//      （dedupKey 是引擎命名空间 `<key>:engine:round:0:seed`，宿主 dedupKey 查不到）→ 不得重复预写，
//      否则 resume 后 user 消息出现两次。识别特征：全档案无任何宿主 `:input:` 行 且 round 0 种子
//      的末条消息就是本条 task（引擎种子 = [...history, user(task)]，task 恒在最后）。
//   b) 上一轮正常完成（档案有宿主 `:input:` 行）：attempt 1 崩在预写前 → 必须补预写，否则本轮
//      user 消息丢失。
//   二者用「档案是否已有宿主 :input: 行」区分：有 → 必属 b)；无 → 档案全部来自 attempt 1 的
//   引擎种子（a)。a 的兜底再用 task 文本比对（会话历史上文里可能有同文消息，只比对种子末条）。
//   残余歧义：attempt1 崩在预写前 + 前文有与 task 完全相同的种子末条消息——极小概率，语义上
//   消息内容等价（模型不可区分），不重复预写可接受（见 README 决策记录）。

/** 从消息块中提取纯文本（与宿主预写/引擎种子的 content 形态对齐）。 */
function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

/** round 0 种子末条消息是否就是本条 task（引擎种子 = [...history, user(task)]）。 */
function seedEndsWithTask(records, task) {
  const seeds = records.filter((r) => (r?.round ?? 0) === 0 && Array.isArray(r?.messages));
  if (seeds.length === 0) return false;
  const last = seeds[seeds.length - 1].messages.at(-1);
  return last?.role === 'user' && textOf(last) === task;
}

/**
 * @param {object} input
 * @param {Array} input.records store.load(key) 全量（RoundRecord[]）
 * @param {string} input.transcriptKey transcript key（=sessionId）
 * @param {string|null} input.messageId 当前消息的 message_id（RUN_START 下行，portal claim ticket 已有）
 * @param {number} input.attempt 本次 attempt（RUN_START 下行）
 * @param {string} input.task 本条用户消息文本（ticket task）
 * @param {boolean} input.legacyResume 旧链路回退（无 session/message 下行时 = ticket.resume，main 现状）
 * @returns {{ resume:boolean, record:?object }} record = 宿主预写记录（null = 不预写）
 */
export function planTranscriptSeed({ records, transcriptKey, messageId, attempt, task, legacyResume }) {
  // 旧链路（旧 portal ticket 无 session/message 下行）：不预写，resume 以 ticket 为准。
  if (!transcriptKey || !messageId) {
    return { resume: legacyResume === true, record: null };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { resume: false, record: null }; // 分支①：空本子，引擎 round 0 种子入档
  }
  const dedupKey = `${transcriptKey}:input:${messageId}`;
  if (records.some((r) => r?.dedupKey === dedupKey)) {
    return { resume: true, record: null }; // 分支③：消息已入档（预写或崩溃重跑），不重复写
  }
  const hasHostInput = records.some((r) => typeof r?.dedupKey === 'string' && r.dedupKey.includes(':input:'));
  if (attempt > 1 && !hasHostInput && seedEndsWithTask(records, task)) {
    // 分支③变体：attempt 1 走了空本子路径，引擎种子已含本条消息 → 直接 resume。
    return { resume: true, record: null };
  }
  // 分支②：新消息未入档 → 宿主预写（round = latestRound，行号可复用——CLI 模式）。
  const latestRound = Math.max(0, ...records.map((r) => (Number.isSafeInteger(r?.round) ? r.round : 0)));
  return {
    resume: true,
    record: {
      round: latestRound,
      roundKey: dedupKey,
      dedupKey,
      messages: [{ role: 'user', content: [{ type: 'text', text: task }] }],
      ts: new Date().toISOString(),
    },
  };
}
