// 测试辅助：`portal/src/session-text.js` 三条取数 SQL 的内存实现（P3 PR②b B1）。
//
// 为什么单列一份：transcript 投影取文本被 6 个读取点共用（AI 改名 / 自动标题 / claim task /
// claim 历史 / 终态幂等比较），各 fake pool 手写一份分支会互相漂移。这里按 SQL 形态派发，
// 行为与真库 + 官方投影一致：锚点行给元数据 + `legacy_content`，正文由 fake pool 提供的
// `transcriptRows` 经投影派生。
//
// 用法（fake pool 的 query 里最先尝试，命中即返回）：
//   const handler = createSessionTextHandler({ messages, transcriptRows });
//   const hit = handler(sql, params); if (hit) return hit;

const textBlock = (value) => [{ type: 'text', text: value }];

/** 便捷构造：一条 `:input:<messageId>` transcript 行（新会话 POST 事务预写入的形态）。 */
export function inputTranscriptRow({ sessionId, messageId, text, round = 0, createdAt = null }) {
  return {
    transcript_key: sessionId,
    run_id: null,
    round,
    dedup_key: `${sessionId}:input:${messageId}`,
    created_at: createdAt,
    record: {
      round,
      dedupKey: `${sessionId}:input:${messageId}`,
      messages: [{ role: 'user', content: textBlock(text) }],
    },
  };
}

/** 便捷构造：一条引擎轮 transcript 行（user 提问 + assistant 终态答复）。 */
export function engineTranscriptRow({
  sessionId, runId, round, userText, assistantText, keyPrefix, createdAt = null,
}) {
  const prefix = keyPrefix ?? (runId ? runId : sessionId);
  const dedupKey = runId ? `${prefix}:round:${round}` : `${sessionId}:engine:round:${round}`;
  const messages = [];
  if (typeof userText === 'string' && userText !== '') {
    messages.push({ role: 'user', content: textBlock(userText) });
  }
  const record = { round, dedupKey, messages };
  if (typeof assistantText === 'string' && assistantText !== '') {
    record.response = { role: 'assistant', content: textBlock(assistantText), toolCalls: [] };
  }
  return { transcript_key: sessionId ?? null, run_id: null, round, dedup_key: dedupKey, created_at: createdAt, record };
}

function anchorRows(rows) {
  return rows.map((m) => ({
    id: m.id,
    run_id: m.run_id ?? null,
    seq: Number(m.seq),
    role: m.role,
    synthetic: m.synthetic === true,
    attachments: m.attachments ?? [],
    created_at: m.created_at ?? null,
    content: m.synthetic === true ? m.content : null, // CASE WHEN synthetic THEN content END
    legacy_content: m.content, // 锚点正文（仅 legacy 兜底路径读）
  }));
}

function bySeqDesc(a, b) {
  return Number(b.seq) - Number(a.seq);
}

/**
 * @param {object} arg
 * @param {Array<object>} arg.messages   `{id, session_id, run_id, seq, role, content, synthetic?, attachments?, created_at?}`
 * @param {Array<object>} [arg.transcriptRows] `transcript_rounds` 行（`{run_id, round, dedup_key, record, created_at}`）
 * @param {string} [arg.sessionId]       user 锚点查询没有带 sessionId 时的兜底会话 id
 */
export function createSessionTextHandler({ messages = [], transcriptRows = [], sessionId = null }) {
  const sessionOf = (candidate) => candidate ?? sessionId;

  return function handle(sql, params = []) {
    const has = (needle) => sql.includes(needle);

    // ① user 锚点（内容匹配启发式用）
    if (has('FROM messages') && has('content AS anchor_text')) {
      const key = sessionOf(params[0]);
      const rows = messages
        .filter((m) => m.session_id === key && m.role === 'user')
        .sort((a, b) => Number(a.seq) - Number(b.seq))
        .map((m) => ({
          id: m.id,
          run_id: m.run_id ?? null,
          seq: Number(m.seq),
          synthetic: m.synthetic === true,
          anchor_text: m.content,
          created_at: m.created_at ?? null,
        }));
      return { rows };
    }

    // ② 读取点锚点查询（三条都带 `legacy_content` 列）
    if (has('FROM messages') && has('legacy_content')) {
      if (has("role IN ('user', 'assistant')")) {
        const [key, excludeId, limit] = params;
        const rows = messages
          .filter((m) => m.session_id === sessionOf(key) && ['user', 'assistant'].includes(m.role) && m.id !== excludeId)
          .sort(bySeqDesc)
          .slice(0, Number(limit));
        return { rows: anchorRows(rows) };
      }
      if (has("role = 'assistant'")) {
        const [runId] = params;
        const rows = messages
          .filter((m) => m.run_id === runId && m.role === 'assistant' && m.synthetic !== true)
          .sort(bySeqDesc)
          .slice(0, 1);
        return { rows: anchorRows(rows) };
      }
      const [key, limit] = params;
      const descOrder = has('ORDER BY seq DESC');
      let rows = messages
        .filter((m) => m.session_id === sessionOf(key) && m.role === 'user')
        .sort(descOrder ? bySeqDesc : (a, b) => Number(a.seq) - Number(b.seq));
      if (Number.isInteger(limit)) rows = rows.slice(0, limit);
      // 真库按 SQL 的 ORDER BY 原序返回（DESC 就是 DESC），翻回升序是 session-text 的职责。
      return { rows: anchorRows(rows) };
    }

    // ③ 按 dedupKey 单行精确命中（claim task 输入行）
    if (has('FROM transcript_rounds') && has('SELECT round, dedup_key, record, folded, created_at')) {
      const [key, dedupKey] = params;
      const row = transcriptRows.find((x) => x.transcript_key === key && x.dedup_key === dedupKey);
      if (!row) return { rows: [] };
      return {
        rows: [{
          round: row.round,
          dedup_key: row.dedup_key,
          record: row.record,
          folded: row.folded === true,
          created_at: row.created_at ?? null,
        }],
      };
    }

    // ④ 整会话 transcript 行（投影上下文）
    if (has('FROM transcript_rounds') && has('SELECT run_id, round, dedup_key, record, created_at')) {
      const [key] = params;
      const rows = transcriptRows
        .filter((x) => (x.transcript_key ?? x.transcriptKey) === key)
        .sort((a, b) => (Number(a.round) - Number(b.round))
          || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
        .map((x) => ({
          run_id: x.run_id ?? null,
          round: Number(x.round),
          dedup_key: x.dedup_key ?? null,
          record: x.record,
          created_at: x.created_at ?? null,
        }));
      return { rows };
    }

    return null;
  };
}
