// 会话与对话链路（portal.md §4/§5；P5 去项目化 docs/design/directory-as-project.md 定稿）。
// 端点：GET/POST /api/sessions、GET/PATCH/DELETE /api/sessions/:id、
//       POST /api/sessions/:id/messages（建 run 入队）、POST .../stop（写 cancel_requested_at）。
// SSE 流（GET /api/sessions/:id/events）在 http.js 组装：DB 补发（§5.2 Last-Event-ID）+ 实时注册（session hub）。
// 依据：规格 §10.2/§13.2-4（多轮显式传 task）、D7（事件先落 DB）、§9.3（seq 由宿主原子分配）。
//
// P5：会话 = cwd + transcript 的绑定体。请求体仍叫 project_id（前端契约），语义 = 目录名
// （相对形式 ~/projects/<name>）：服务端校验形态 + 目录不存在时 mkdir（「＋新建目录」语义，
// 直接写 FDE 家目录 bind mount）。projects 表写入路径退役（留档只读）。
import crypto from 'node:crypto';
import path from 'node:path';
import { ensureDirSafe } from './fsutil.js';
import { clipTitleFromMessage, sanitizeTitle, AUTO_TITLE_MAX_LEN } from './session-title.js';
import { getFdeLlmConfig } from './llm.js';
import { projectSessionMessages } from './session-view.js';
import { projectTranscriptForDisplay } from 'erix-agent';
import { fetchUserTextTurns } from './session-text.js';
import { appendUserInputTurn } from './transcript-store.js';
import { allocSeq } from './seq.js';

export class SessionError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const ACTIVE_RUN_STATES = `('queued', 'running', 'cancelling')`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 会话 cwd 形态：~/projects/<name>（name 为一级目录名，不得含 /，不得为 . / ..；P5 边界）。 */
export const CWD_RE = /^~\/projects\/([^/]+)$/;

/**
 * 校验并规范化会话 cwd（纯函数）：返回相对形式 `~/projects/<name>`。
 * 与项目注册时代的 PROJECT_NAME_RE 不同——目录名允许下划线等（用户在容器内自建目录的自由
 * 命名权），唯一硬边界是「一级目录、无路径穿越」（name 不得含 /，拒绝 . 与 ..）。
 */
export function validateSessionCwd(value) {
  const m = typeof value === 'string' && CWD_RE.exec(value);
  if (!m) {
    throw new SessionError('validation_failed', 'project_id（cwd）必须是 ~/projects/<name> 一级目录形式', {
      details: { field: 'project_id' },
    });
  }
  const name = m[1];
  if (name === '.' || name === '..' || /[\x00-\x1f\x7f]/.test(name)) {
    throw new SessionError('validation_failed', '目录名非法（拒绝 . / .. / 控制字符）', {
      details: { field: 'project_id' },
    });
  }
  return `~/projects/${name}`;
}
/** 单条 user 消息内容上限（portal.md §4.3）。 */
export const MAX_MESSAGE_CONTENT_LENGTH = 100_000;

/**
 * 请求体校验（**纯函数，无 IO**）：返回裁剪后的 `{content, attachments}`；不合法一律 `SessionError`(400 validation_failed)。
 *
 * 为什么单独导出（F3 裁决 / reviewer M-7）：`handlePostMessage` 必须在**幂等包装之前**调用它——
 * 非法请求体要 400 且**不占用** Idempotency-Key 占位行；否则首次非法体先占位，同 key 的合法重试
 * 会因 request_hash 不同撞 409 idempotency_key_reuse（等于把一次笔误钉成永久 409）。
 * 同时它把 attachments 元素裁剪为实际消费的 `{kind, path, name?}` 子集，供请求 hash 复用。
 */
export function validateMessageBody(body) {
  const content = body?.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SessionError('validation_failed', 'content 必填且非空', { details: { field: 'content' } });
  }
  if (content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    throw new SessionError('validation_failed', `content 过长（≤${MAX_MESSAGE_CONTENT_LENGTH} 字符）`, { details: { field: 'content' } });
  }
  const raw = body?.attachments;
  if (raw !== undefined && !Array.isArray(raw)) {
    throw new SessionError('validation_failed', 'attachments 必须为数组', { details: { field: 'attachments' } });
  }
  const attachments = (raw ?? []).map((a) => {
    if (!a || typeof a !== 'object' || !['file', 'image'].includes(a.kind) || typeof a.path !== 'string' || !a.path) {
      throw new SessionError('validation_failed', 'attachments 元素须为 {kind: file|image, path, name?}', { details: { field: 'attachments' } });
    }
    // 只保留实际消费的字段（多送的 UI 字段既不落库也不参与幂等 hash）
    return a.name === undefined ? { kind: a.kind, path: a.path } : { kind: a.kind, path: a.path, name: a.name };
  });
  return { content, attachments };
}

/** session 属主校验 + 取行；不存在/不属本人/已归档/非法 UUID 一律 404（不泄露存在性，portal.md §1.2 惯例）。
 *  P5：projects 表退役留档——不再 JOIN projects（project_id 可空，cwd 为权威绑定）。
 *  withMessageCount（issue #197）：仅 getSession 置 true——同一条 SQL 内嵌 messages 相关子查询带出
 *  会话消息总数（口径与 listSessions 的 message_count 同源：该会话 messages 表全量行数、含 synthetic、
 *  不按 role/synthetic/分页过滤）。写在这里而非另发 COUNT：零额外往返；其余调用方（postMessage/
 *  stop/archive/SSE 校验等）不带该列，热路径 SQL 逐字不变。 */
async function fetchSession(pool, sessionId, userId, { forUpdate = false, withMessageCount = false } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  const lock = forUpdate ? ' FOR UPDATE' : '';
  // 与 listSessions 那条内嵌子查询逐字同款（索引同理：UNIQUE (session_id, seq) 首列等值 COUNT）。
  const countCol = withMessageCount
    ? `,\n            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count`
    : '';
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.project_id, s.cwd, s.title, s.title_source, s.model, s.status, s.last_seq${countCol}
       FROM chat_sessions s
      WHERE s.id = $1${lock}`,
    [sessionId],
  );
  const row = res.rows?.[0];
  if (!row || row.user_id !== userId) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  if (row.status !== 'active') {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  return row;
}

export async function assertSessionOwner(pool, { userId, sessionId }) {
  await fetchSession(pool, sessionId, userId);
}

/**
 * issue #94：keyset 游标编解码（不透明串）——base64url(JSON {u: updated_at ISO, i: id})。
 * 旧格式（纯 UUID）与任何非法值一律 validation_failed（游标与查询条件绑定，跨条件复用本就失效，
 * 严格拒绝比静默跳过安全）。
 */
export function encodeSessionCursor(row) {
  return Buffer.from(JSON.stringify({ u: rowToSession(row).updated_at, i: row.id }), 'utf8').toString('base64url');
}

export function decodeSessionCursor(cursor) {
  try {
    const obj = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (obj && typeof obj.u === 'string' && obj.u && typeof obj.i === 'string' && UUID_RE.test(obj.i)) {
      return { updatedAt: obj.u, id: obj.i };
    }
  } catch { /* 非法编码落入统一报错 */ }
  throw new SessionError('validation_failed', 'cursor 非法', { details: { field: 'cursor' } });
}

/** GET /api/sessions?project_id=&cwd=&cursor=&limit=（可选过滤，updated_at DESC, id DESC
 *  复合 keyset 分页 §1.3：默认 20、上限 100；issue #94）。
 *  P5：cwd 过滤为「该目录的会话列表」（directory-as-project §4 左栏；精确匹配会话绑定 cwd）。
 *  排序键为 (updated_at, id) 复合——仅按 updated_at 会在同时间戳记录间跳页（旧游标缺陷修复）。
 *  评审裁决（issue #94 瘦身）：q 搜索/total 计数已拆除（前端选择器降级为单次全量浏览），
 *  待 #88 标题自动生成后再评估是否加回。 */
export async function listSessions(pool, { userId, projectId, cwd, cursor, limit = 20 }) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [userId];
  let where = `user_id = $1 AND status = 'active'`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  if (cwd) {
    params.push(validateSessionCwd(cwd));
    where += ` AND cwd = $${params.length}`;
  }
  if (cursor) {
    const boundary = decodeSessionCursor(cursor);
    params.push(boundary.updatedAt, boundary.id);
    where += ` AND (s.updated_at, s.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(n + 1);
  const res = await pool.query(
    `SELECT s.id, s.project_id, s.cwd, s.title, s.title_source, s.model, s.last_seq, s.created_at, s.updated_at,
            (SELECT r.id FROM runs r WHERE r.session_id = s.id AND r.status IN ${ACTIVE_RUN_STATES} ORDER BY r.queued_at DESC LIMIT 1) AS active_run_id,
            -- issue #197：每会话消息数（侧栏列表展示）。口径与头部状态行同源（StreamPanel sessionStats ←
            -- getSession DTO 的 messages 长度）：= 该会话在 messages 表的全部行数，含 synthetic、
            -- 不按 role/synthetic/分页过滤，故 COUNT(*) 全量计数。
            -- 索引：messages 无 session_id 专列索引，但 UNIQUE (session_id, seq) 隐式唯一索引首列即
            -- session_id，等值 COUNT 可走该索引（schema baseline 冻结，不新增迁移）。
            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
       FROM chat_sessions s
      WHERE ${where}
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const items = res.rows.slice(0, n).map((r) => ({
    ...rowToSession(r),
    active_run_id: r.active_run_id ?? null,
    message_count: Number(r.message_count), // 与头部状态行同源口径（见上方 SQL 注释）
  }));
  const nextCursor = res.rows.length > n ? encodeSessionCursor(res.rows[n - 1]) : null;
  return { items, next_cursor: nextCursor };
}

/**
 * POST /api/sessions —— 建会话（P5：请求体 project_id = 目录名 → 绑定 cwd）。
 * 校验 `~/projects/<name>` 形态（validateSessionCwd）→ 目录存在性确保（不存在则 mkdir，
 * 「＋新建目录」语义；直写 FDE 家目录 bind mount <userSpaceRoot>/<fde>/projects/<name>）。
 * projects 表写入路径已退役：不再要求/不再写 project_id（列留档，迁移 0008 解除 NOT NULL）。
 */
export async function createSession(pool, { userId, projectId, title, model, config }) {
  const cwd = validateSessionCwd(projectId);
  const name = CWD_RE.exec(cwd)[1];
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    throw new SessionError('validation_failed', 'title 必须为 ≤200 字符的字符串', { details: { field: 'title' } });
  }
  if (model !== undefined && (typeof model !== 'string' || model.length > 100)) {
    throw new SessionError('validation_failed', 'model 必须为 ≤100 字符的字符串', { details: { field: 'model' } });
  }

  // 「＋新建目录」语义：目录不存在则创建（权限口径同 provisioner/materializer 工作区目录：
  // 2770 + erix 属主；root 创建即 chown，非 root 环境 best-effort 告警不阻断——fsutil 语义）。
  const fde = await pool.query(
    `SELECT fde_name FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const fdeName = fde.rows?.[0]?.fde_name;
  if (!fdeName) {
    throw new SessionError('validation_failed', '当前用户未配置 fde_name，无法确定家目录', {
      details: { field: 'fde_name' },
    });
  }
  const userSpaceRoot = config?.userSpaceRoot;
  if (!userSpaceRoot) {
    throw new SessionError('internal', 'userSpaceRoot 未配置', { httpStatus: 500 });
  }
  ensureDirSafe(
    userSpaceRoot,
    path.join(path.resolve(userSpaceRoot), fdeName, 'projects', name),
    { mode: 0o2770, uid: config?.fdeUid ?? 1000, gid: config?.fdeGid ?? 1000 },
  );

  // issue #88：显式传 title = 用户起名（含空串显式置空视为接管）→ 'manual'，自动更新不再覆盖；
  // 未传 → 'auto'，等首条消息后的自动标题（session-title.js）。
  const titleSource = title === undefined ? 'auto' : 'manual';
  const res = await pool.query(
    `INSERT INTO chat_sessions (user_id, cwd, title, model, title_source)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, project_id, cwd, title, title_source, model, status, last_seq, created_at, updated_at`,
    [userId, cwd, title ?? '', model ?? null, titleSource],
  );
  return rowToSession(res.rows[0]);
}

/**
 * GET /api/sessions/:id —— 会话详情 + 消息列表 + last_seq + active_run_id（§4.1 ChatSession 契约）。
 * 消息 keyset 分页（§1.3）：默认/无 cursor 取**最新** limit 条（升序返回）；cursor=更早一批的最小 seq，取 seq < cursor 的最新一批。
 * includeMessages=false 供 SSE 仅校验 session/last_seq 时使用，避免无用 transcript 读取。
 */
export async function getSession(pool, { userId, sessionId, limit = 20, messagesCursor, includeMessages = true }) {
  // issue #197：withMessageCount → 会话总数与属主校验同一条 SQL 取回（见 fetchSession）。
  const s = await fetchSession(pool, sessionId, userId, { withMessageCount: true });
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [sessionId, n];
  let where = `session_id = $1`;
  if (messagesCursor != null) {
    if (!Number.isInteger(Number(messagesCursor)) || Number(messagesCursor) < 1) {
      throw new SessionError('validation_failed', 'cursor 必须为正整数', { details: { field: 'cursor' } });
    }
    params.push(Number(messagesCursor));
    where += ` AND seq < $3`;
  }
  const msgs = includeMessages
    ? await pool.query(
      // 内容双写尚未停（下一单），但锚点侧只还需要合成行的内容：
      // 用户/助手正文一律由官方投影提供（契约 ④：无证据留空，不读 messages.content 兜底）。
      `SELECT id, run_id, seq, role,
              CASE WHEN synthetic THEN content END AS content,
              synthetic, attachments, created_at
         FROM messages WHERE ${where} ORDER BY seq DESC LIMIT $2`,
      params,
    )
    : { rows: [] };
  const hasOlder = msgs.rows.length > n; // 多取的 1 条存在 ⇒ 还有更早消息
  if (hasOlder) msgs.rows.pop();
  msgs.rows.reverse(); // 升序返回
  const userAnchors = msgs.rows.length > 0
    ? await pool.query(
      // Seed / 引擎轮 / 历史快照行没有 message ID（投影的 meta.dedupKey 是轮级键），
      // 故仅这类行仍保留锚点文本做精确内容匹配；`:input:<messageId>` 行走 meta.dedupKey 映射，不读此列。
      `SELECT id, run_id, seq, synthetic, content AS anchor_text, created_at
         FROM messages WHERE session_id = $1 AND role = 'user' ORDER BY seq ASC`,
      [sessionId],
    )
    : { rows: [] };
  const transcript = msgs.rows.length > 0
    ? await pool.query(
      // 0.16.0 同 round 保序：同 (transcript_key, round) 多行按持久化追加序（append_seq，迁移 0016）
      // 排列，created_at 存在完全相同的行、无法确定性还原 → 对话流 DTO 行序才可复现。
      `SELECT run_id, round, dedup_key, record, created_at
         FROM transcript_rounds WHERE transcript_key = $1
         ORDER BY round ASC, append_seq ASC`,
      [sessionId],
    )
    : { rows: [] };
  const active = await pool.query(
    `SELECT id, status FROM runs WHERE session_id = $1 AND status IN ${ACTIVE_RUN_STATES} ORDER BY queued_at DESC LIMIT 1`,
    [sessionId],
  );
  // issue #283：工具耗时由**宿主自己**补——引擎官方投影的 `toolCalls[]` 不带时长（上游明说该形状
  // 没有 duration），取数面只能是本站 `tool_calls`（数据由 M2 的 U3 tool_result UPDATE 回填）。
  // 只取本批锚点涉及的 run（锚点分页窗口已是 run 的超集）；`duration_ms IS NOT NULL` ⇒ 旧数据
  //（引擎当年就没发时长的那批）根本不参与 join ⇒ DTO 不出现 `durationMs` 键，不写 0。
  const durationRunIds = [...new Set(msgs.rows
    .map((row) => row.run_id)
    .filter((runId) => typeof runId === 'string' && runId !== ''))];
  const toolCallDurations = durationRunIds.length > 0
    ? await pool.query(
      `SELECT run_id, call_id, duration_ms
         FROM tool_calls WHERE run_id = ANY($1::uuid[]) AND duration_ms IS NOT NULL`,
      [durationRunIds],
    )
    : { rows: [] };
  const projection = projectSessionMessages({
    sessionId,
    anchors: msgs.rows,
    userAnchors: userAnchors.rows,
    transcriptRows: transcript.rows,
    toolCallRows: toolCallDurations.rows,
  });
  return {
    session: {
      ...rowToSession(s),
      active_run_id: active.rows[0]?.id ?? null,
      // issue #197：会话消息总数（前端头部状态行的权威源）。口径与列表 API 的 message_count 同源
      // （fetchSession 内嵌相关子查询：messages 全量行数、含 synthetic、不受下方 limit 分页窗口影响）。
      // fake pool 缺列时置 null（前端按「缺失」回退已加载条数），真库恒为数字。
      message_count: s.message_count == null ? null : Number(s.message_count),
    },
    messages: projection,
    last_seq: Number(s.last_seq),
    // 还有更早的消息时给出 cursor（客户端用它取历史；对齐 §1.3 响应形状）
    next_cursor: hasOlder ? Number(msgs.rows[0].seq) : null,
  };
}

/**
 * issue #189：折叠原文只读端点（GET /api/sessions/:id/folded/:round）。
 * 属主/存在性/active 校验同 fetchSession 口径（非属主/不存在一律 404，不泄露存在性）；
 * 取该 session 该 round 的折叠原文：优先 `folded_payload` 派生列（#195 修复后由引擎 record.foldedPayload
 * 回退提取写入），存量行（列 NULL）回退 `record.foldedPayload`——与 #195 的读侧 collectRoundText（internal.js）、
 * 写侧 putSessionRound 同一规则。
 * 为空/无行 → 404 folded_payload_not_found。命中时原文一律走同一个上游投影
 * `projectTranscriptForDisplay`（不另造折叠渲染，#95 红线），返回 { round, turns }。
 * 同 round 多行（append_seq 保序）：取最早一条（原文内容同源，首条即可）。
 */
export async function getFoldedPayload(pool, { userId, sessionId, round }) {
  await fetchSession(pool, sessionId, userId);
  const n = Number(round);
  if (!Number.isInteger(n) || n < 0) {
    throw new SessionError('validation_failed', 'round 必须为非负整数', { details: { field: 'round' } });
  }
  const res = await pool.query(
    `SELECT round, folded_payload, record FROM transcript_rounds
      WHERE transcript_key = $1 AND round = $2
      ORDER BY append_seq ASC LIMIT 1`,
    [sessionId, n],
  );
  // #195 一致性：列优先、record.foldedPayload 回退（存量行列值为 NULL、原文只在 record 里，不得误 404）。
  const row = res.rows?.[0];
  const payload = Array.isArray(row?.folded_payload)
    ? row.folded_payload
    : (Array.isArray(row?.record?.foldedPayload) ? row.record.foldedPayload : null);
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new SessionError('folded_payload_not_found', 'folded payload not found', { httpStatus: 404 });
  }
  const turns = projectTranscriptForDisplay([{ round: n, messages: payload }]);
  return { round: n, turns };
}

/** PATCH /api/sessions/:id —— 改标题（CAS 限定 active，防归档后仍改成功）。 */
export async function updateSession(pool, { userId, sessionId, title }) {
  await fetchSession(pool, sessionId, userId);
  if (typeof title !== 'string' || title.length > 200) {
    throw new SessionError('validation_failed', 'title 必须为 ≤200 字符的字符串', { details: { field: 'title' } });
  }
  // issue #88：手工 PATCH 标题 → title_source='manual'（手工优先：自动更新只写 'auto' 行）。
  const res = await pool.query(
    `UPDATE chat_sessions SET title = $2, title_source = 'manual', updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, user_id, project_id, cwd, title, title_source, model, status, last_seq, created_at, updated_at`,
    [sessionId, title],
  );
  if (res.rows.length === 0) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  return rowToSession(res.rows[0]);
}

/** DELETE /api/sessions/:id —— 归档（有进行中 run → 409 run_in_progress，portal.md §4.2）。 */
export async function archiveSession(pool, { userId, sessionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });
    const active = await client.query(
      `SELECT 1 FROM runs WHERE session_id = $1 AND status IN ${ACTIVE_RUN_STATES} LIMIT 1`,
      [s.id],
    );
    if (active.rows.length > 0) {
      throw new SessionError('run_in_progress', 'session has an active run', { httpStatus: 409 });
    }
    await client.query(`UPDATE chat_sessions SET status = 'archived', updated_at = now() WHERE id = $1`, [s.id]);
    await client.query('COMMIT');
    return { archived: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/sessions/:id/messages —— 发用户消息 + 建 run 入队（portal.md §4.3）。
 * 事务内：锁 session（串行化并发发送）→ 活跃 run 检查（409 run_in_progress）→
 * seq 原子分配写 user 消息 + session transcript → 建 run + run_queue →
 * **幂等台账转 done（record，同事务）** → COMMIT
 * → 唤醒 claim（runner §4.2）。
 * 拉模型（终态）语义：落库即 202，FDE 不在线时 run 在队列等待（§6.3）。
 *
 * `record`（可选）由幂等层注入（idempotency.js `executeWithIdempotency` 传给 fn 的回调，G2）：
 * 在 COMMIT 前以**同一个 client** 调 `record(client, 202, payload)`，使「消息/run 写入」与「幂等台账
 * 转 done」落在同一事务提交——否则「业务已提交、记账未提交」的崩溃窗口会让客户端重发时再执行一次。
 * record 命中 0 行（占位已被其它 owner 接管）会抛 409 → 本事务 ROLLBACK，不产生第二次副作用。
 *
 * `onSessionTitle`（可选，issue #114）：本次若用首条用户消息截断出了默认标题，在 **COMMIT 之后**
 * 回调一次（入参为新标题），由调用方推 SSE session_updated——让侧栏标题立即到位；不入事务，
 * 失败不影响 202。
 */
export async function postMessage(pool, { userId, sessionId, content, attachments, notify, record, onSessionTitle }) {
  // 体校验（与 handlePostMessage 的前置校验同一函数；此处兜底，保证直接调用者也拿不到非法数据）
  const valid = validateMessageBody({ content, attachments });
  const safeContent = valid.content;
  const safeAttachments = valid.attachments;

  const client = await pool.connect();
  let committed = null;
  let clippedTitle = null; // issue #114：首条消息截断出的默认标题（COMMIT 后回调用）
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });

    const active = await client.query(
      `SELECT id FROM runs WHERE session_id = $1 AND status IN ${ACTIVE_RUN_STATES} LIMIT 1`,
      [s.id],
    );
    if (active.rows.length > 0) {
      throw new SessionError('run_in_progress', 'session has an active run', { httpStatus: 409 });
    }

    // 同 setFdeLlmConfig 使用 per-FDE advisory lock，使新 run 与 key/model binding 变更全序。
    // 锁序：chat_sessions（上，FOR UPDATE）→ llm-binding → containers（下，FOR UPDATE）。
    // fde_name 为 null 的账户不可能有 fde_llm_bindings 行（配置按 fde_name 寻址），跳过不取锁。
    const fde = await client.query(`SELECT fde_name FROM users WHERE id = $1`, [userId]);
    if (fde.rows[0]?.fde_name) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fde.rows[0].fde_name}`]);
    }

    // issue #37 评审（major）：必须同时排除 revoked_at 非空的容器——deprovision 前置事务先吊销 token
    // 并释放网段（此时 status 可能还是 running），若只按 status 过滤，吊销后仍能建新 run，
    // 而该 run 不在 offboard 的收敛快照里、容器随后被删 → 永久排队无人 claim。
    // FOR UPDATE（评审 #37 二轮 major）：对 containers 行加锁与 offboard 的吊销 UPDATE 串行化——
    // 本事务若先拿锁，则吊销必然等本事务提交（terminateActiveRuns 在吊销后执行，快照必含本 run）；
    // 吊销先提交，则本 SELECT 读到 revoked_at 非空 → 拒绝。两侧任一顺序都不会产生收敛遗漏。
    const container = await client.query(
      `SELECT id FROM containers
        WHERE user_id = $1 AND status <> 'removed' AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [userId],
    );
    if (!container.rows?.[0]) {
      throw new SessionError('no_active_container', 'no active FDE container for user', { httpStatus: 409 });
    }

    // seq 原子分配（§9.3）+ user 消息
    const seqRes = await client.query(
      `UPDATE chat_sessions SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq`,
      [s.id],
    );
    const seq = Number(seqRes.rows[0].last_seq);
    // P3 PR②b B2（docs/design/conversation-state.md §6）：**停止正文双写**——`messages` 降级为纯锚点行。
    // `content` 恒写空串：用户输入的文本真相已由下方 `appendUserInputTurn` 落在 `transcript_rounds`，
    // 读侧（`session-view.js` / `session-text.js`）一律从官方投影取文，本列对**新行**不再有语义。
    // 列本身仍是 `text NOT NULL`（不改 DDL），故写 `''`。
    // 前瞻性例外（尚未实现，约束先钉住）：**合成行（`synthetic = true`，宿主注入的 judge/wrapup 之类）
    // 必须继续写正文**——它在 transcript 里没有对应轮次，读侧取的就是锚点自身文本
    // （`session-view.js` 的 `anchor.synthetic === true` 分支 + `session-text.js` 的 `CASE WHEN synthetic`）。
    // 本路径（POST 用户消息）恒为非合成行，故可无条件写空串。
    const msg = await client.query(
      `INSERT INTO messages (session_id, seq, role, content, attachments)
       VALUES ($1, $2, 'user', '', $3)
       RETURNING id, seq, role, content, attachments, created_at`,
      [s.id, seq, JSON.stringify(safeAttachments)],
    );

    // P3 契约①（erix-agent 0.15.0 起，写侧由引擎 appendUserTurn 承担）：同事务先将用户输入
    // 落入 session transcript，再创建/入队 run。round 推导（复用现有最大 round，空=0）、
    // dedupKey 生成（`<sessionId>:input:<messageId>`）、record 形态与幂等判据均在引擎内；
    // store 适配器复用本事务 client（portal/src/transcript-store.js），落库列形态与原手搓一致。
    // 顺序红线：必须发生在 run 入队之前（session FOR UPDATE 串行化同 key 并发追加，满足引擎
    // 「在接收事务内发起」的并发前提）。
    // 错误语义：appendUserTurn 对纯空白 text 抛 TypeError——本路径不可达（validateMessageBody
    // 已在幂等与事务之前以 400 validation_failed 拒绝空白 content）；兜底捕获转同一错误码，
    // 保证任何回归都不把 400 语义升格成 500。
    try {
      await appendUserInputTurn(client, { key: s.id, text: safeContent, messageId: msg.rows[0].id });
    } catch (err) {
      if (err instanceof TypeError) {
        throw new SessionError('validation_failed', err.message, { details: { field: 'content' } });
      }
      throw err;
    }

    // issue #114：默认标题 = 首条用户消息截断（零 LLM）。
    // 幂等：仅当标题为空（NULL/空串/纯空白）且 title_source='auto' 时写；已有标题（手工/AI 改名）不动。
    // 与 ERIX_SESSION_AUTO_TITLE 开关**解耦**：这是默认命名（不是 #88 的「自动标题刷新」），
    // 开关关闭时照样生效——故此处不读 config.sessionAutoTitle。
    // 超长尾加 `…`（ellipsis: true）；截断本身仍在 AUTO_TITLE_MAX_LEN=30 字。
    if (String(s.title ?? '').trim() === '' && (s.title_source ?? 'auto') === 'auto') {
      const clip = clipTitleFromMessage(safeContent, { ellipsis: true });
      if (clip != null) {
        // WHERE 再带一次守卫：并发 PATCH/AI 改名已置 manual/标题非空 → 0 行，安静放弃（幂等）。
        const titleUpd = await client.query(
          `UPDATE chat_sessions SET title = $2, updated_at = now()
            WHERE id = $1 AND status = 'active' AND title_source = 'auto'
              AND (title IS NULL OR btrim(title) = '')
            RETURNING title`,
          [s.id, clip],
        );
        clippedTitle = titleUpd.rows?.[0]?.title ?? null;
      }
    }

    // run + 入队（§4.3：显式把用户输入作为 task 传引擎；id 由 portal 生成，禁止 cwd 派生 §9.3-3）
    const runId = crypto.randomUUID();
    const run = await client.query(
      `INSERT INTO runs (id, session_id, status) VALUES ($1, $2, 'queued') RETURNING id, status`,
      [runId, s.id],
    );
    await client.query(
      `INSERT INTO run_queue (run_id, container_id, status) VALUES ($1, $2, 'pending')`,
      [runId, container.rows[0].id],
    );
    // 消息关联 run（user 消息 = 它触发的 run）
    await client.query(`UPDATE messages SET run_id = $2 WHERE id = $1`, [msg.rows[0].id, runId]);

    const payload = {
      message: {
        id: msg.rows[0].id,
        run_id: runId,
        seq: Number(msg.rows[0].seq),
        role: 'user',
        // P3 PR②b B2：`messages.content` 已降级为锚点元数据（新行恒为空串），故 202 响应体的 `content`
        // **回显请求正文** `safeContent`（不是从 messages 读回来）：前端 `send()` 直接拿本响应渲染用户
        // 气泡（portal.md §4.3），写空串会让刚发出的消息渲染成空气泡。此处不违反「不读 messages.content」：
        // 它是调用方刚提交的入参，且下一句 `appendUserInputTurn` 已把它写入 transcript（文本真相）。
        content: safeContent,
        synthetic: false,
        attachments: safeAttachments,
        created_at: msg.rows[0].created_at?.toISOString?.() ?? msg.rows[0].created_at,
      },
      run: { id: run.rows[0].id, status: run.rows[0].status },
    };

    // G2：幂等记账并入业务事务（同 client 同事务）——状态码取本端点的契约值 202（portal.md §4.3）。
    if (record) await record(client, 202, payload);

    await client.query('COMMIT');
    committed = payload;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // COMMIT 后唤醒 agentd claim（notify 不入事务：失败不影响 202）
  try {
    notify?.({ runId: committed.run.id, userId, sessionId });
  } catch { /* 通知失败不影响主流程 */ }
  // issue #114：首条截断标题的 SSE 推送（同样在 COMMIT 之后——绝不先于落库到达客户端）。
  if (clippedTitle != null) {
    try {
      onSessionTitle?.(clippedTitle);
    } catch { /* 推送失败不影响已落库的标题 */ }
  }
  return committed;
}

/**
 * POST /api/sessions/:id/stop —— 停止会话上进行中的 run（portal.md §4.5）。
 * 事务内锁 session 行（与发消息串行化，防「检查无活跃 run → 新 run 提交 → 误停新 run」竞态）；
 * 状态变更一律**条件更新（CAS）**，禁止先查后改；重复停止幂等返回 200。
 *
 * **两条路径（issue #277 第一片；#277-A2 补「已领走」守卫）**：
 *  1. `queued` 且**未被领走**（没有任何执行体会去报它的终态）：**直接进终态** `finished`
 *     + `termination={"reason":"aborted","detail":"cancelled_before_start"}`，并在同事务把它从
 *     `run_queue` 摘掉（口径同 release/reaper 的 cancelled 分支：queue → `cancelled` + 清租约字段），
 *     并**同事务合成一条 `run_end` 事件**（#277-A2：不合成则活页面的输入框要等刷新才摘「运行中」）。
 *     旧实现在这里也写 `cancelling`，而 `cancelling` ①被认领 SQL 排除（internal.js tryClaim 的
 *     `r.status IN ('queued','running')`，A2）、②终态只能由 worker 经 U2 写、③不在 reaper 的收敛集合里
 *     ⇒ 一个从未执行的 run 被停止后**永远没人收敛**，`active_run_id` 恒非空（ACTIVE_RUN_STATES 含
 *     `cancelling`）⇒ 会话锁死：UI 恒「运行中」+ 发新消息恒 409 `run_in_progress`。
 *  2. `running`，以及**已被 agentd 领走但尚未写 `running`** 的 `queued`（#277-A2，见下方守卫注释）：
 *     → `cancelling`（等 worker abort 后经 U2 报终态；**不回退**，A2 语义不变）。
 *  3. 两步都 0 行 ⇒ 幂等重放：`cancelling` 中的 run、或本端点已直接终态化的 run（按
 *     `termination.detail='cancelled_before_start'` 识别）→ 仍 `200` 且零写入；否则 409 `no_active_run`。
 *
 * ⚠ 竞态（不得吞）：run 在第 1 步之前刚被领走并写了 `running` ⇒ queued 分支 0 行，第 2 步接住它。
 *
 * ⚠ 已领走但尚未写 `running`（#277-A2 的守卫，见第 1 步 SQL）：**不能**直接终态，理由三条——
 *   ① 落到 `cancelling` 后，worker 那次**正常**的 `markRunState('running')` 由 internal.js setRunState
 *      的 issue #220 ack 分支接住（无副作用 2xx，不会炸成 `persistence_failed`，也**不会**把状态改回
 *      `running`）；
 *   ② 心跳 `stop_run_ids` 的谓词要求 `status='cancelling'` 且 run 在 worker 上报列表里
 *      （internal.js heartbeat）⇒ 中止信号能送到**活着的** worker；
 *   ③ worker abort 后经 U2 报终态（`cancelling → finished|failed` 合法，且我们**没清**租约 ⇒
 *      finishRun 的租约门禁过得去）⇒ 能收敛，且带**真实 usage 与真实 termination**。
 *   反过来，若把它直接终态化：worker 后续写终态被 fencing（lease_lost）拒 ⇒ **那一次 attempt 的
 *   usage 直接丢掉**，并且 `termination.detail='cancelled_before_start'` 是在**说谎**（它已开始执行）。
 *
 * ⚠ 未覆盖（下一片）：`running` 的 run 被停止后若容器死掉 / worker 再不报终态，`cancelling` 无人收敛；
 *   本端点不解决这个问题（心跳 `stop_run_ids` 只把停止信号送给**还活着的** worker）。
 *
 * `notify`（#277-A2，可选）：形状即 `internal.js notifySessionEvents(sessionId, events)`，由 http.js 注入；
 * 只在「直接终态」那一步真的写了 `run_end` 后、在 **COMMIT 之后**调一次（失败不影响 200，同 postMessage
 * 的 `onSessionTitle` 口径）。`running → cancelling` 分支**不**推：它的 `run_end` 由 worker 的 U2 终态事务产出。
 */
export async function stopSession(pool, { userId, sessionId, notify }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });

    // 第 1 步 CAS：queued → 终态（未开始就被取消）。转换合法性见 internal.js validateTransition
    // 的 `queued → finished|failed` 边（portal.md §9.6）。
    // #277-A2 守卫：`status='queued'` **不足以**判定「从未开始」——认领只写 `run_queue`
    // （`status='claimed'` + `claim_token` + `owner_container_id` + `lease_until`，见 schema.sql §8），
    // `runs.status` 要等 worker 的 markRunState 才变 `running`，所以「已领走、还没来得及写 running」的
    // run 这里仍是 `queued`。把它直接终态会 ①写下说谎的 detail='cancelled_before_start'（它其实已开始）、
    // ②清掉租约 ⇒ worker 随后写终态被 fencing 拒（lease_lost）⇒ **那一次 attempt 的 usage 丢掉**。
    // 故用租约事实（已领走 = `q.status='claimed'` 且 `lease_until > now()`）把它排除，让它落到第 2 步
    // → `cancelling`（为什么 cancelling 才是能收敛的那条路：见本函数 docstring 的三条理由）。
    // ⚠ 守卫必须带 `lease_until > now()`：租约**已过期**的 claimed 行按 reaper 口径属于「worker 已死」
    //   （reaper 分支2/3 会把它回 pending 或判 failed），此时没有任何活着的执行体会再来报终态
    //   ⇒ 仍该直接终态，否则就退回 #277 的卡死态。
    const killedQueued = await client.query(
      `UPDATE runs
          SET status = 'finished',
              termination = '{"reason":"aborted","detail":"cancelled_before_start"}'::jsonb,
              cancel_requested_at = COALESCE(cancel_requested_at, now()),
              ended_at = now()
        WHERE session_id = $1 AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM run_queue q
                           WHERE q.run_id = runs.id AND q.status = 'claimed' AND q.lease_until > now())
        RETURNING id`,
      [s.id],
    );
    // 出队：终态 run 绝不能留在 `run_queue`（照 finishRun / releaseRun / reaper 的 cancelled 写法：
    // queue → 'cancelled' + 清 claim_token/owner_container_id/lease_until/claimed_at，不发明第三种）。
    // 同时**同事务合成 `run_end`**（#277-A2 返修 2）：不合成则活页面的输入框要等刷新才能摘「运行中」
    // ——写法照 `internal.js finishRun` / `provisioner.js terminateActiveRuns` 的先例（client_event_id
    // = `<runId>:final:run_end`、seq 走 §7.3 统一分配器 `allocSeq`、`ON CONFLICT DO NOTHING`），不自创第三种。
    // 锁序（为何此处**不需要** provisioner 那个独立小事务 B）：本事务已在开头 `fetchSession(..., FOR UPDATE)`
    // **持住 chat_sessions 单行**，同事务内 `allocSeq`（再改同一行）不引入新锁序也不会自锁；provisioner
    // 那段注释里「runs → sessions 与 stopSession 反序」的问题在这里根本不存在（它就是 stopSession，
    // 本来就是 sessions → runs）。后人照抄小事务 B 反而绕远，且会把「终态 + run_end」拆成两次提交。
    const runEnds = [];
    for (const row of killedQueued.rows) {
      const q = await client.query(
        `UPDATE run_queue
            SET status = 'cancelled', claim_token = NULL, owner_container_id = NULL,
                lease_until = NULL, claimed_at = NULL
          WHERE run_id = $1 RETURNING attempts`,
        [row.id],
      );
      // run_end 载荷形状与 finishRun 合成的那条同构（termination/usage/rounds/attempt）：
      // 未开始就被取消 ⇒ 零用量、零轮次（与 provisioner offboard 合成那条同口径）。
      const payload = {
        termination: { reason: 'aborted', detail: 'cancelled_before_start' },
        usage: { input_tokens: 0, output_tokens: 0 },
        rounds: 0,
        attempt: Number(q.rows?.[0]?.attempts ?? 1),
      };
      const seq = await allocSeq(client, s.id);
      await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [row.id, s.id, seq, `${row.id}:final:run_end`, JSON.stringify(payload)],
      );
      runEnds.push({ run_id: row.id, seq, payload });
    }

    // 第 2 步 CAS：剩下的 running → cancelling（等 worker 报终态，见上方 ⚠）。
    // #277-A2：与第 1 步的守卫**互为补集**——「已领走、还没写 running」的 run（runs.status 仍是 `queued`
    // 且租约有效）在第 1 步被排除，必须由这一步接住，否则两步都 0 行会掉进 409 `no_active_run`。
    let res;
    if (killedQueued.rows.length > 0) {
      res = killedQueued.rows.map((r) => ({ id: r.id, status: 'finished' }));
    } else {
      const cancelling = await client.query(
        `UPDATE runs
            SET status = 'cancelling', cancel_requested_at = COALESCE(cancel_requested_at, now())
          WHERE session_id = $1
            AND (status = 'running'
                 OR (status = 'queued' AND EXISTS (SELECT 1 FROM run_queue q
                        WHERE q.run_id = runs.id AND q.status = 'claimed' AND q.lease_until > now())))
          RETURNING id`,
        [s.id],
      );
      res = cancelling.rows.map((r) => ({ id: r.id, status: 'cancelling' }));
    }

    if (res.length === 0) {
      // 幂等重放：已在 cancelling（重复点击），或本端点已把未开始的 run 直接终态（同因重放）。
      const replay = await client.query(
        `SELECT id, status FROM runs
          WHERE session_id = $1
            AND (status = 'cancelling'
                 OR (status = 'finished' AND termination ->> 'detail' = 'cancelled_before_start'))
          ORDER BY queued_at DESC LIMIT 1`,
        [s.id],
      );
      if (replay.rows.length === 0) {
        throw new SessionError('no_active_run', 'no active run on session', { httpStatus: 409 });
      }
      res = replay.rows;
    }
    await client.query('COMMIT');
    // SSE 推送必须在 COMMIT **之后**（同 finishRun / postMessage 的 `onSessionTitle`）：
    // 先于落库到达客户端会让前端重取到未提交的旧状态。事件不推也不影响已落库的终态（尽力而为）。
    // 形状与 finishRun 合成的那条一致（{ seq, ts, run_id, type, payload }），前端无需分路径处理。
    if (runEnds.length > 0) {
      try {
        notify?.(s.id, runEnds.map((e) => ({
          seq: e.seq, ts: new Date().toISOString(), run_id: e.run_id, type: 'run_end', payload: e.payload,
        })));
      } catch { /* 推送失败不影响已落库的终态与事件 */ }
    }
    return { run: { id: res[0].id, status: res[0].status } };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// issue #114：「AI 改名」——按需的一次性 LLM 调用（用户点按钮才花钱，不做任何自动刷新）
//
// 决策豁免说明：issue #88 定下「portal 不持 LLM 客户端」（标题由 agent 侧生成随 run 终态上报），
// 本端点是**用户拍板（2026-10-01，issue #114）的修订豁免**：用户主动触发的一次性命名请求，
// 走 portal 直连 OpenAI 兼容 chat/completions（一次往返），不重复造 agent 链路。
// 豁免范围**仅限本函数**——其余自动路径仍不得由 portal 发 LLM 请求。
//
// key 纪律（llm.js 三条存储纪律 ③）：api_key 只进 Authorization 请求头，
// 绝不进日志/错误信息/HTTP 响应（redactSecret 做最后一道兜底）。
// ---------------------------------------------------------------------------

/** AI 改名的上下文：会话最早的 N 条 user 消息（单条折叠空白后截 AI_TITLE_CONTEXT_MAX_LEN 字符）。 */
export const AI_TITLE_CONTEXT_MESSAGES = 3;
export const AI_TITLE_CONTEXT_MAX_LEN = 200;
/** 单次上游调用超时（issue #114：~15s）。 */
export const AI_TITLE_TIMEOUT_MS = 15_000;
/** 系统提示：与 AUTO_TITLE_MAX_LEN 同口径（≤30 字；落库前仍过一遍 sanitizeTitle）。 */
export const AI_TITLE_SYSTEM_PROMPT =
  '你是会话命名助手。根据用户消息为这次会话生成一个简短标题。'
  + '要求：不超过 30 个字符；与用户消息的语言一致；只输出标题本身，不要引号、序号、解释或结尾标点。';

/** 拼接改名上下文（纯函数，供单测）：最早 N 条 user 消息，各折叠空白并截断 ~200 字。 */
export function buildAiTitlePrompt(messages) {
  const list = (Array.isArray(messages) ? messages : [])
    .slice(0, AI_TITLE_CONTEXT_MESSAGES)
    .map((m, i) => {
      const t = String(m ?? '').replace(/\s+/g, ' ').trim().slice(0, AI_TITLE_CONTEXT_MAX_LEN);
      return `${i + 1}. ${t}`;
    });
  return `用户消息：\n${list.join('\n')}\n\n请只输出标题。`;
}

/** 从 OpenAI 兼容响应体取助手文本（纯函数）：content 为字符串或分片数组。 */
export function extractAssistantText(body) {
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** 脱敏（纯函数）：从任意文本里抹掉已知 key 与 sk-* 形态串，并截断长度（纪律 ③ 兜底）。 */
export function redactSecret(text, secret) {
  let out = String(text ?? '');
  if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('***');
  out = out.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***');
  return out.slice(0, 200);
}

/** OpenAI 兼容 chat/completions URL：base 已带 /v1 则直接用，否则补 /v1（口径同 erix-agent provider）。 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

/** AI 改名必须使用该 FDE 的 LiteLLM 虚拟 key；不再回退到 Station 本地 provider 目录。 */
export async function resolveAiTitleProvider(pool, userId, { gatewayUrl = 'http://127.0.0.1:4100' } = {}) {
  const cfg = await getFdeLlmConfig(pool, userId);
  const mainModel = cfg?.main?.name;
  if (cfg?.api_key && mainModel) {
    return { base_url: gatewayUrl, api_key: cfg.api_key, model: mainModel, source: 'fde_binding' };
  }
  throw new SessionError(
    'llm_not_configured',
    '该 FDE 未配置 LiteLLM 虚拟 key（AI 改名需要一次 LLM 调用）：请在管理台配置 LiteLLM 模型',
    { httpStatus: 409 },
  );
}

/**
 * POST /api/sessions/:id/ai-title —— 「AI 改名」（issue #114）。
 * 属主鉴权同 PATCH（fetchSession：非属主/不存在/已归档一律 404）。
 * 流程：取上下文 → 解析 provider（无 → 409）→ 一次 chat/completions（15s 超时，失败 → 502）
 *       → sanitizeTitle 清洗（≤30 字）→ 落库 title_source='manual'（用户主动触发，自动流程不得覆盖）。
 * @returns 更新后的会话行（rowToSession 形状）
 */
export async function generateAiTitle(pool, {
  userId, sessionId, gatewayUrl, fetchImpl = fetch, timeoutMs = AI_TITLE_TIMEOUT_MS, notify, log = console,
} = {}) {
  await fetchSession(pool, sessionId, userId);

  // P3 PR②b B1 ①（issue #114）：AI 改名上下文的前 N 条 user 文本**改从 transcript 投影取**
  // （`fetchUserTextTurns` → `projectSessionMessages` 同一口径）。投影对该轮无证据时才 legacy
  // 回退 `messages.content`（迁移 0015 之前的行；legacy-only，不用于新会话）。
  const turns = await fetchUserTextTurns(pool, { sessionId, limit: AI_TITLE_CONTEXT_MESSAGES });
  const contexts = turns.map((turn) => turn.text);
  if (contexts.length === 0) {
    throw new SessionError('no_user_messages', '会话还没有用户消息，无法生成标题', { httpStatus: 409 });
  }

  const provider = await resolveAiTitleProvider(pool, userId, { gatewayUrl });

  // 超时用显式 AbortController + clearTimeout（不依赖 AbortSignal.timeout 的定时器语义）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(chatCompletionsUrl(provider.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: AI_TITLE_SYSTEM_PROMPT },
          { role: 'user', content: buildAiTitlePrompt(contexts) },
        ],
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // 网络/超时：错误信息里只有原因，绝无请求头（key）；再过一遍脱敏兜底。
    const reason = controller.signal.aborted
      ? `上游调用超时（>${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}）`
      : redactSecret(err?.message ?? err, provider.api_key);
    log?.warn?.(`[ai-title] 上游调用失败（session=${sessionId}）：${reason}`);
    throw new SessionError('llm_upstream_failed', `LLM 调用失败：${reason}`, { httpStatus: 502 });
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text().catch(() => '');
  if (!res.ok) {
    // 只回显上游 error.message（脱敏 + 截断），不回显整个响应体。
    let hint = '';
    try {
      const msg = JSON.parse(raw)?.error?.message;
      if (typeof msg === 'string' && msg.trim() !== '') hint = `（${redactSecret(msg, provider.api_key)}）`;
    } catch { /* 非 JSON 响应体：不给细节 */ }
    const reason = `上游返回 HTTP ${res.status}${hint}`;
    log?.warn?.(`[ai-title] 上游返回错误（session=${sessionId}）：${reason}`);
    throw new SessionError('llm_upstream_failed', `LLM 调用失败：${reason}`, { httpStatus: 502 });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch { /* 非 JSON：下面统一按「无法解析标题」处理 */ }
  const title = sanitizeTitle(extractAssistantText(parsed));
  if (title == null) {
    log?.warn?.(`[ai-title] 上游未返回可用标题（session=${sessionId}）`);
    throw new SessionError('llm_upstream_failed', 'LLM 未返回可用的标题', { httpStatus: 502 });
  }

  // title_source='manual'：用户主动触发 → 任何自动流程（evaluateAutoTitle 只写 'auto' 行）不得覆盖。
  const upd = await pool.query(
    `UPDATE chat_sessions SET title = $2, title_source = 'manual', updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, user_id, project_id, cwd, title, title_source, model, status, last_seq, created_at, updated_at`,
    [sessionId, title],
  );
  if (upd.rows.length === 0) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  const session = rowToSession(upd.rows[0]);
  log?.info?.(`[ai-title] 会话标题已更新（session=${sessionId}，source=${provider.source}）：${title}`);
  // 多标签页 / SessionPicker 的列表标题实时同步（形状同 #88/#107：{ ts, type, payload:{ title } }）。
  try {
    notify?.(sessionId, [{ ts: new Date().toISOString(), type: 'session_updated', payload: { title } }]);
  } catch { /* 推送失败不影响已落库的标题 */ }
  return session;
}

function rowToSession(r) {
  return {
    id: r.id,
    project_id: r.project_id ?? null,
    cwd: r.cwd ?? null,
    title: r.title,
    title_source: r.title_source ?? 'auto', // issue #88：旧部署行由迁移 0009 回填；缺省兜底 'auto'
    model: r.model,
    status: r.status,
    last_seq: Number(r.last_seq),
    created_at: r.created_at?.toISOString?.() ?? r.created_at,
    updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}
