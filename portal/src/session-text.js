// P3 PR②b B1（docs/design/conversation-state.md §6）：「从 transcript 投影取文本」的共享读取层。
//
// 背景：`messages.content` 的文本真相正在迁到 `transcript_rounds`（P3 PR②a 已把对话流 DTO 改为
// 官方投影输出）。本模块承载**其余文本读取点**（AI 改名上下文 / 自动标题降级链 / claim ticket 的
// task / 终态幂等比较的 final_text），使这些点在停写 `messages.content`（PR②b B2）之后仍能取到文本。
// （原第四个读取点「claim ticket 的历史下行 `run.history`」已随 **P3 PR③** 退役，见文件尾 ④ 注。）
//
// 不重复实现投影：文本一律由 `session-view.js` 的 `projectSessionMessages`（内部逐行调用上游官方纯函数
// `projectTranscriptForDisplay`，并用 `recordForProjection` 把 `dedup_key` 列合成进 record）派生——
// 与 `GET /api/sessions/:id` 对话流**同一口径**，同一轮文本在两处必然一致。
//
// legacy 兜底（红线）：仅当**投影对该锚点无证据**（投影输出空文本）时，才最小回退 `messages.content`。
// P3 PR②b B2 已生效（停写 `messages.content`）：**两个写入点的新行 content 恒为空串**，
// 所以本兜底**只对老数据有意义**（迁移 0015 之前入档、正文仍留在 `messages.content` 的行）——
// 新会话恒有 transcript 证据，不会走到兜底（即使走到也只是空串）。**不得删除**：删了老会话就地丢正文。
// 例外：`synthetic = true` 的锚点行（judge/wrapup 等宿主注入）在 transcript 里没有对应轮次，
// 其**正文本就应写在 `messages.content`**（故 SQL 用 `CASE WHEN synthetic THEN content END`），不参与兜底语义。
import { projectTranscriptForDisplay } from 'erix-agent';
import { projectSessionMessages, recordForProjection, userTurnTexts } from './session-view.js';

/** 锚点列集：展示元数据取自 `messages`，正文取自投影；`legacy_content` 只服务于 legacy 兜底
 * （P3 PR②b B2 后新行恒为空串，故只对迁移 0015 之前的老行有意义）。 */
const ANCHOR_COLUMNS = `id, run_id, seq, role, synthetic, attachments, created_at,
              CASE WHEN synthetic THEN content END AS content,
              content AS legacy_content`;

/** user 锚点（非 `:input:` 行的内容匹配启发式用），与 `sessions.js` 的 `getSession` 同口径。 */
const USER_ANCHOR_SQL = `SELECT id, run_id, seq, synthetic, content AS anchor_text, created_at
     FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY seq ASC`;

/** session transcript 行（行序 = round/created_at，与 store.load / getSession 同口径）。 */
const TRANSCRIPT_SQL = `SELECT run_id, round, dedup_key, record, created_at
     FROM transcript_rounds WHERE transcript_key = $1
     ORDER BY round ASC, created_at ASC`;

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 读一次投影上下文（user 锚点 + transcript 行）。同一请求里多个读取点共用，避免反复整表读。
 * 投影的锚点认领是**整会话启发式**（历史快照/seed 行按内容精确认领、seq 升序单调游标），
 * 因此不能只取切片——必须整会话读取，否则认领结果与对话流 DTO 不一致。
 */
export async function loadTextContext(executor, { sessionId } = {}) {
  const [userAnchors, transcript] = await Promise.all([
    executor.query(USER_ANCHOR_SQL, [sessionId]),
    executor.query(TRANSCRIPT_SQL, [sessionId]),
  ]);
  return {
    sessionId,
    userAnchors: userAnchors.rows ?? [],
    transcriptRows: transcript.rows ?? [],
  };
}

/** 投影输出 + legacy 兜底 → `{ text, source }`。`source` 仅供测试断言/排障，不参与业务判定。 */
function withLegacy(anchor, projectedContent) {
  const projected = textOf(projectedContent);
  if (anchor?.synthetic === true) return { text: projected, source: 'anchor' }; // 合成行正文本就落在锚点上
  if (projected !== '') return { text: projected, source: 'transcript' };
  const legacy = textOf(anchor?.legacy_content ?? anchor?.content); // legacy-only（迁移 0015 之前）
  return { text: legacy, source: legacy === '' ? 'empty' : 'legacy' };
}

/** 通用：按给定 anchor SQL 取锚点 → 走 `projectSessionMessages` 派生文本 → 逐位配回锚点。 */
async function projectAnchors(executor, { sessionId, context, anchorSql, params }) {
  const anchored = await executor.query(anchorSql, params);
  const anchors = anchored.rows ?? [];
  if (anchors.length === 0) return [];
  const ctx = context ?? (await loadTextContext(executor, { sessionId }));
  const projected = projectSessionMessages({
    sessionId: ctx.sessionId,
    anchors,
    userAnchors: ctx.userAnchors,
    transcriptRows: ctx.transcriptRows,
  });
  // projectSessionMessages 按 anchors 原序输出 → 逐位对应。
  return projected.map((row, index) => ({ row, anchor: anchors[index] }));
}

/**
 * ① 按 `messageId` 取用户输入文本（claim ticket 的 `task`，**运行关键路径**）。
 *
 * 取数：`transcript_key = sessionId` + `dedup_key = <sessionId>:input:<messageId>` 单行精确命中
 * （迁移 0006 的部分唯一索引，不必整会话读取），正文口径同 `userTurnTexts`（排除合成/折叠轮）。
 *
 * @returns {Promise<string|null>} 命中输入行且投影有 user 正文 → 文本；否则 **null**，由调用方按
 *   「legacy `messages.content` → 空串」的顺序回退（调用点注释写明了回退顺序）。
 */
export async function fetchInputTextByMessageId(executor, { sessionId, messageId } = {}) {
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof messageId !== 'string' || messageId === '') return null;
  const res = await executor.query(
    `SELECT round, dedup_key, record, folded, created_at
       FROM transcript_rounds
      WHERE transcript_key = $1 AND dedup_key = $2`,
    [sessionId, `${sessionId}:input:${messageId}`],
  );
  const row = res.rows?.[0];
  if (!row) return null;
  const { record } = recordForProjection(row);
  const texts = userTurnTexts(projectTranscriptForDisplay([record]));
  return texts.at(-1) ?? null;
}

/**
 * ② 按 session 取有序 user 文本（AI 改名上下文 / 自动标题降级链首条 / 话题漂移最新一条）。
 *
 * @param {object} executor pool 或事务 client
 * @param {object} arg
 * @param {string} arg.sessionId
 * @param {object} [arg.context] `loadTextContext` 产物（同请求内复用；缺省现场读一次）
 * @param {number} [arg.limit]   取前 N 条（`desc` 缺省）或最新 N 条（`desc: true`）
 * @param {boolean} [arg.desc]   true = 从最新往回取（返回仍按 seq 升序）
 * @returns {Promise<Array<{ messageId, seq, text, source }>>} seq 升序
 */
export async function fetchUserTextTurns(executor, { sessionId, context, limit = null, desc = false } = {}) {
  const n = Number.isInteger(limit) && limit > 0 ? limit : null;
  const params = [sessionId];
  let order = 'ASC';
  if (n !== null) {
    order = desc ? 'DESC' : 'ASC';
    params.push(n);
  }
  const rows = await projectAnchors(executor, {
    sessionId,
    context: context ?? (await loadTextContext(executor, { sessionId })),
    anchorSql: `SELECT ${ANCHOR_COLUMNS}
         FROM messages WHERE session_id = $1 AND role = 'user'
        ORDER BY seq ${order}${n !== null ? ` LIMIT $${params.length}` : ''}`,
    params,
  });
  const turns = rows.map(({ row, anchor }) => ({
    messageId: row.id,
    seq: Number(row.seq),
    ...withLegacy(anchor, row.content),
  }));
  return desc ? turns.reverse() : turns;
}

/**
 * ③ 按 run 取 assistant 终态正文（终态幂等比较的 `stored.final_text`）。
 *
 * 锚点定位与旧实现逐字一致（该 run 最新的非合成 assistant 行）；**文本**改由投影派生，
 * 投影无证据时 legacy 回退 `messages.content`。
 *
 * @returns {Promise<{ messageId, seq, text, source }|null>} 无该锚点行 → null（调用方按 `''` 处理）
 */
export async function fetchRunAssistantText(executor, { sessionId, runId, context } = {}) {
  if (typeof runId !== 'string' || runId === '') return null;
  const rows = await projectAnchors(executor, {
    sessionId,
    context: context ?? (await loadTextContext(executor, { sessionId })),
    anchorSql: `SELECT ${ANCHOR_COLUMNS}
         FROM messages WHERE run_id = $1 AND role = 'assistant' AND synthetic = false
        ORDER BY seq DESC LIMIT 1`,
    params: [runId],
  });
  const first = rows[0];
  if (!first) return null;
  return { messageId: first.row.id, seq: Number(first.row.seq), ...withLegacy(first.anchor, first.row.content) };
}

// ④ 会话历史下行（issue #69：claim ticket 的 `run.history`）**已随 P3 PR③ 退役**，`fetchConversationTurns`
// 已删除：resume 路径下引擎本就忽略 initialMessages，而正常新会话必然走 resume（用户输入已在 POST 事务内
// 落树），文本注入成为死重（且 thinking 模型会因 `reasoning_content must be passed back` 被上游拒）。
// 会话上下文唯一来源 = transcript resume；空本子靠 ticket 的 `task`（引擎 round 0 种子）。
