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
import {
  buildAiTitlePrompt, generateTitle, resolveTitleLlmProvider,
  TITLE_CONTEXT_MESSAGES, TITLE_CONTEXT_MAX_LEN, TITLE_LLM_MAX_TOKENS, TITLE_LLM_TIMEOUT_MS, TITLE_SYSTEM_PROMPT,
} from './title-llm.js';
import { collectTranscriptFacts, projectSessionMessages } from './session-view.js';
import { projectTranscriptForDisplay } from 'erix-agent';
import { fetchUserTextTurns } from './session-text.js';
// issue #596 片 A：手工改名的 system 从 `platform_prompts` 取（每次现读、无缓存 ⇒ 保存后下一次改名就生效）。
import { resolveEffectiveTitlePrompt } from './platform-prompts.js';
import { appendUserInputTurn } from './transcript-store.js';
import { allocSeq } from './seq.js';
// #322：本文件**不再直接调** `chatCompletion`（手工改名走 `./title-llm.js` 的唯一生成入口）；
// 下面三个「一次对话请求」的通用件仍在此重新导出，只为既有调用方与文档口径不受影响。
import { chatCompletionsUrl, extractAssistantText, redactSecret } from './llm-chat.js';
// issue #676 ①：越界 cwd 校验要 jail 的单一真值表（宿主子目录 / 哪些能当 run cwd）。
import { JAIL_RUN_CWD_HOST_SUFFIXES } from '../shared/jail-mounts.js';

export class SessionError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 活跃 run 状态集合（#370 起被 `queued-inputs.js` 复用——入队判定与它必须同源）。 */
export const ACTIVE_RUN_STATES = `('queued', 'running', 'cancelling')`;
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

/**
 * issue #676 ①：校验**一条 run 的 cwd 是否落在该用户的 jail 内**（纯函数，与
 * `validateSessionCwd` 并列；导出以便单测）。这是「响亮失败」的闸门——过去
 * `postMessage` / `createReviewSession` 任意字符串都收，错 cwd 会「账上 done、实际空转」。
 *
 * 接受两类形态：
 *  1. `~/projects/<name>` 相对形式 —— 走既有 `validateSessionCwd`（会话约定，回归口径不变）。
 *  2. **绝对路径**，且必须在该用户 jail 之内：`<userSpaceRoot>/<fde>/{home,projects,cache}/…`。
 *     jail 子目录取自 `JAIL_RUN_CWD_HOST_SUFFIXES`（`platform/git` 不在内 ⇒ 被拒，它是平台挂载点）。
 *     判前一律 `path.resolve` 规范化，防 `..` 穿越。
 *
 * 其余（越界绝对路径、`platform/git`、相对但非 `~/projects/`、`..` 穿出 jail、空）
 * ⇒ `SessionError('validation_failed', ...)`，`details.field='cwd'`。
 *
 * @param {string} cwd
 * @param {{ userSpaceRoot?: string, fdeName?: string|null }} ctx 绝对路径判定需要两者；
 *        缺 userSpaceRoot/fdeName（如账户无 fde）时，绝对路径一律拒（无法证明在 jail 内）。
 * @returns {string} 规范后的 cwd（相对形式原样；绝对形式取 resolve 结果）
 */
export function validateRunCwd(cwd, { userSpaceRoot, fdeName } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') {
    throw new SessionError('validation_failed', 'cwd 不能为空', { details: { field: 'cwd' } });
  }
  const value = cwd.trim();

  // 形态 1：`~/projects/<name>`——交给既有校验器（其内部已拒 . / .. / 穿越）。
  if (value.startsWith('~/')) {
    return validateSessionCwd(value);
  }

  // 非绝对路径（如 `projects/x`、相对 `foo`）既不是会话约定也不可信 ⇒ 拒。
  if (!path.isAbsolute(value)) {
    throw new SessionError('validation_failed', 'cwd 必须是 ~/projects/<name> 或 jail 内的绝对路径', {
      details: { field: 'cwd' },
    });
  }

  // 形态 2：绝对路径 ⇒ 规范化后必须落在 `<userSpaceRoot>/<fde>/{home,projects,cache}` 之下。
  const root = typeof userSpaceRoot === 'string' && userSpaceRoot.trim() !== '' ? userSpaceRoot : null;
  const fde = typeof fdeName === 'string' && fdeName.trim() !== '' ? fdeName.trim() : null;
  if (!root || !fde) {
    throw new SessionError('validation_failed', '绝对 cwd 需要 userSpaceRoot 与 fde_name 才能判定 jail 归属', {
      details: { field: 'cwd' },
    });
  }
  const jailRoot = path.resolve(root, fde); // `<userSpaceRoot>/<fde>`（resolve 已吃掉 `..`）
  const target = path.resolve(value);
  const rel = path.relative(jailRoot, target);
  // 逃出 jail（rel 以 `..` 开头或为空/绝对）⇒ 拒。
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new SessionError('validation_failed', `cwd 越出用户 jail（${jailRoot}）：${value}`, {
      details: { field: 'cwd' },
    });
  }
  // 第一段子目录必须是允许当 run cwd 的 jail 子目录（home / projects / cache；platform/git 被排除）。
  const firstSeg = rel.split(path.sep)[0];
  if (!JAIL_RUN_CWD_HOST_SUFFIXES.includes(firstSeg)) {
    const allowed = JAIL_RUN_CWD_HOST_SUFFIXES.join(', ');
    throw new SessionError('validation_failed', `cwd 所在 jail 子目录不可作 run 目录（允许：${allowed}）：${value}`, {
      details: { field: 'cwd', allowed: JAIL_RUN_CWD_HOST_SUFFIXES },
    });
  }
  return target;
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
 *  stop/archive/SSE 校验等）不带该列，热路径 SQL 逐字不变。
 *  includeArchived（issue #727，只有管理台只读浏览置 true）：默认 false 时
 *  「非 active ⇒ 404」那条分支逐字不变；true 才跳过它。属主校验照旧。 */
export async function fetchSession(
  pool, sessionId, userId,
  { forUpdate = false, withMessageCount = false, includeArchived = false } = {},
) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  const lock = forUpdate ? ' FOR UPDATE' : '';
  // 与 listSessions 那条内嵌子查询逐字同款（索引同理：UNIQUE (session_id, seq) 首列等值 COUNT）。
  const countCol = withMessageCount
    ? `,\n            (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count`
    : '';
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.project_id, s.cwd, s.title, s.title_source, s.model, s.status, s.last_seq, s.origin${countCol}
       FROM chat_sessions s
      WHERE s.id = $1${lock}`,
    [sessionId],
  );
  const row = res.rows?.[0];
  if (!row || row.user_id !== userId) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  if (includeArchived !== true && row.status !== 'active') {
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

/**
 * LIKE/ILIKE 通配符转义（issue #727 管理台搜索）：`\` 必须第一个转，
 * 否则会把后两条的转义符再转一次。
 */
function escapeLikePattern(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** GET /api/sessions?project_id=&cwd=&cursor=&limit=（可选过滤，updated_at DESC, id DESC
 *  复合 keyset 分页 §1.3：默认 20、上限 100；issue #94）。
 *  P5：cwd 过滤为「该目录的会话列表」（directory-as-project §4 左栏；精确匹配会话绑定 cwd）。
 *  排序键为 (updated_at, id) 复合——仅按 updated_at 会在同时间戳记录间跳页（旧游标缺陷修复）。
 *  评审裁决（issue #94 瘦身）：q 搜索/total 计数已拆除（前端选择器降级为单次全量浏览），
 *  待 #88 标题自动生成后再评估是否加回。
 *  issue #727（管理台只读浏览，默认行为逐字节不变）：
 *    · includeArchived=true ⇒ where 去掉 status 条件（默认仍过滤 active）；
 *    · q 是**新增的可选参数**（不是恢复 #94 拆掉的搜索框）：
 *    仅当「非空白字符串
 *      且 ≤100 字符」时追加 title/cwd 的 ILIKE 过滤（转义 \ % _ 并 ESCAPE
 *      反斜杠），
 *      其余情形（未传 / 全空白 / 超长）一律不加条件。
 */
export async function listSessions(
  pool, { userId, projectId, cwd, cursor, limit = 20, includeArchived = false, q = null },
) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [userId];
  let where = includeArchived === true ? `user_id = $1` : `user_id = $1 AND status = 'active'`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  if (cwd) {
    params.push(validateSessionCwd(cwd));
    where += ` AND cwd = $${params.length}`;
  }
  if (typeof q === 'string' && q.trim() !== '' && q.length <= 100) {
    params.push(`%${escapeLikePattern(q)}%`);
    const p = params.length;
    where += ` AND (title ILIKE $${p} ESCAPE '\\' OR cwd ILIKE $${p} ESCAPE '\\')`;
  }
  if (cursor) {
    const boundary = decodeSessionCursor(cursor);
    params.push(boundary.updatedAt, boundary.id);
    where += ` AND (s.updated_at, s.id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(n + 1);
  const res = await pool.query(
    `SELECT s.id, s.project_id, s.cwd, s.title, s.title_source, s.model, s.last_seq, s.origin, s.created_at, s.updated_at,
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
  // mode 传 2770、**落盘 0770**，口径定在 0770（setgid 不承载行为，issue #273）；+ erix 属主；root 创建即
  // chown，非 root 环境 best-effort 告警不阻断——fsutil 语义）。
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
export async function getSession(
  pool, {
    userId, sessionId, limit = 20, messagesCursor,
    includeMessages = true, includeArchived = false,
  },
) {
  // issue #197：withMessageCount → 会话总数与属主校验同一条 SQL 取回（见 fetchSession）。
  // issue #727：includeArchived 默认 false ⇒ fetchSession 的 404 分支逐字不变。
  const s = await fetchSession(
    pool, sessionId, userId, { withMessageCount: true, includeArchived },
  );
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
  // #451：`transcript.rows` 只扫这一次——折叠事实与压缩层聚合同源（不另发 SQL）。
  const facts = collectTranscriptFacts(transcript.rows);
  const projection = projectSessionMessages({
    sessionId,
    anchors: msgs.rows,
    userAnchors: userAnchors.rows,
    transcriptRows: transcript.rows,
    toolCallRows: toolCallDurations.rows,
    // #451：**同一趟扫描**的产物既喂投影（折叠摘要/折叠替代物），又喂下面的
    // `session.compaction` 聚合——成本红线：对 `transcript_rounds` 的查询次数不变。
    facts,
  });
  // #370：未投递的输入队列快照（`queued_messages`）**不在这里取**，由 `http.js handleGetSession`
  // 在 DTO 出口挂上。两个理由，都不是洁癖：
  //   ① 依赖方向——`queued-inputs.js` 必须能 import 本文件（它要复用 `postMessage` 这条唯一发送路），
  //      本文件再 import 它就是循环；ESM 靠函数声明提升能跑，但那是**运气不是设计**，
  //      将来谁把某个依赖改成模块级常量求值就会炸成 undefined。
  //   ② 只有 `GET /api/sessions/:id` 这一个入口需要它（SSE 首连那条 `includeMessages:false` 不需要），
  //      放在 DTO 出口比在数据层无条件多打一条查询更诚实。
  return {
    session: {
      ...rowToSession(s),
      active_run_id: active.rows[0]?.id ?? null,
      // issue #197：会话消息总数（前端头部状态行的权威源）。口径与列表 API 的 message_count 同源
      // （fetchSession 内嵌相关子查询：messages 全量行数、含 synthetic、不受下方 limit 分页窗口影响）。
      // fake pool 缺列时置 null（前端按「缺失」回退已加载条数），真库恒为数字。
      message_count: s.message_count == null ? null : Number(s.message_count),
      // #451：压缩层累计观测（**键缺席而非零**）——一条 `compactionStats` 都没有（或全部层
      // `triggered === 0`）⇒ 整个键不给：前端据此一个字节都不渲染（不是「0 次压缩」）。
      // 零 DDL：数据源是引擎已经写进轮记录的 `record.compactionStats`，读侧聚合，存量与新 run 同时覆盖。
      ...(facts.compaction === null ? {} : { compaction: facts.compaction }),
    },
    messages: projection,
    last_seq: Number(s.last_seq),
    // 还有更早的消息时给出 cursor（客户端用它取历史；对齐 §1.3 响应形状）
    next_cursor: hasOlder ? Number(msgs.rows[0].seq) : null,
  };
}

/**
 * issue #189：折叠原文只读端点（GET /api/sessions/:id/folded/:round）。
 * 属主/存在性/active 校验同 fetchSession 口径（非属主/不存在一律 404，不泄露存在性）。
 *
 * ⚠ **口径已由 #375 改了一遗**：旧行为是“取该 round 那一行的归档”（`folded_payload` 列优先、
 * 存量行回退 `record.foldedPayload`，为空一律 404）。那在 erix-agent 0.25.0 之前“意外成立”——
 * 当时每次折叠都把 `from:1` 的全量写进归档，所最新那一行就是全部原文。0.25.0（erix-agent#461）
 * 把归档改成**本轮新增的有界差分**（会话级内容去重 + 默认 256 KiB 夹断，超限保尾丢头，丢弃量记在
 * `record.foldedPayloadMeta`）⇒ 只读归档现在只能给出**残缺**，去重全吸收时甚至是**空**，而旧口径会回
 * `404 folded_payload_not_found`、前端渲染成「原文已不可用（上游未保留折叠前载荷）」——假话。
 *
 * 新口径（契约 host-consumer-contract：原文在各自的轮行里，`foldedRoundRange`/`navigationRecord` 才是
 * 有界指针，宿主不得把截断/缺失读成丢数据）：
 *   ① 有 `foldedRoundRange` ⇒ **从同会话已有轮行重建**（`source:'rebuilt'`，可证无损：账本 append-only
 *     且全站 `DELETE FROM transcript_rounds` 零命中）；行数超 `FOLDED_REBUILD_MAX_ROWS` 只置 `truncated`。
 *   ② 无 range（或 range 内一行正文都没有）⇒ 退回归档（`source:'archive'`，#195 列优先/record 回退不变）。
 *   ③ 两条都拿不出正文 ⇒ `404 folded_payload_not_found`（语义收窄为“这个范围真的一行都没有”）。
 * 返回形状**向后兼容**：`{ round, turns }` 一字未动，新增 `source`/`truncated`/`dropped_messages` 三个可选键。
 */
const FOLDED_REBUILD_MAX_ROWS = 2000; // 扫描上限与 U7 recall 同尺（internal.js `recallTranscript` 先例）
// 一个 round 的行数极小（引擎轮行 + 若干消息行 + **折叠那一行**），取全再挑一次的代价就是一次索引扫。
const FOLD_ROW_SCAN_LIMIT = 64;

/**
 * **同一个 round 有多行，折叠指针只长在折叠那一行上**（真机 `9e0c8a17` round 100 实测 4 行：
 * `append_seq` 1818/1819/1820 是轮行与消息行、`folded_payload` 为 JSON `null`，折叠行是**最后**那条
 * 1821：`folded = true`、带 `foldedRoundRange`、归档 550 KB）。
 * ⇒ 旧口径 `ORDER BY append_seq ASC LIMIT 1` 挑中的是**没有归档的那一行**，于是「账本里明明有原文」
 * 被读成 `404 folded_payload_not_found`，前端渲染成「原文已不可用（上游未保留折叠前载荷）」——
 * 这就是 #375 那声「假 404」的真病根（跟 erix-agent 0.25.0 的差分归档**无关**，两个病叠在一起）。
 * 挑选次序：① `folded === true` 且带 range 或正文 ② 任意带 range 的行 ③ 任意带正文的行 ④ 交回 null
 * （调用方退到「第一行」，保持旧行为：一条归档都没有时仍然 404，不误判成有）。
 */
function pickFoldCarrierRow(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hasRange = (row) => normalizeFoldedRoundRange(row?.record?.foldedRoundRange) !== null;
  const hasPayload = (row) => (Array.isArray(row?.folded_payload) && row.folded_payload.length > 0)
    || (Array.isArray(row?.record?.foldedPayload) && row.record.foldedPayload.length > 0);
  return list.find((row) => row?.folded === true && (hasRange(row) || hasPayload(row)))
    ?? list.find(hasRange)
    ?? list.find(hasPayload)
    ?? null;
}

export async function getFoldedPayload(
  pool, { userId, sessionId, round, log, includeArchived = false },
) {
  await fetchSession(pool, sessionId, userId, { includeArchived });
  const n = Number(round);
  if (!Number.isInteger(n) || n < 0) {
    throw new SessionError('validation_failed', 'round 必须为非负整数', { details: { field: 'round' } });
  }
  const res = await pool.query(
    `SELECT round, folded, folded_payload, record FROM transcript_rounds
      WHERE transcript_key = $1 AND round = $2
      ORDER BY append_seq ASC LIMIT $3`,
    [sessionId, n, FOLD_ROW_SCAN_LIMIT],
  );
  // #195 一致性：列优先、record.foldedPayload 回退（存量行列值为 NULL、原文只在 record 里，不得误 404）。
  // ⚠ 必须**挑折叠那一行**而不是取该轮第一行，理由见 `pickFoldCarrierRow`（#375 真病根）。
  const row = pickFoldCarrierRow(res.rows) ?? res.rows?.[0] ?? null;
  const payload = Array.isArray(row?.folded_payload)
    ? row.folded_payload
    : (Array.isArray(row?.record?.foldedPayload) ? row.record.foldedPayload : null);
  const range = normalizeFoldedRoundRange(row?.record?.foldedRoundRange);
  const meta = row?.record?.foldedPayloadMeta;
  const droppedMessages = Number.isSafeInteger(meta?.droppedMessages) && meta.droppedMessages > 0 ? meta.droppedMessages : 0;

  // ① 有范围 ⇒ 以账本为准重建（#375 主路）。归档只能给差分，而横幅说的是整个范围。
  if (range) {
    const rebuilt = await rebuildFoldedRange(pool, { key: sessionId, range, log });
    if (rebuilt.turns.length > 0) {
      return {
        round: n, turns: rebuilt.turns, source: 'rebuilt',
        truncated: rebuilt.truncated || droppedMessages > 0, dropped_messages: droppedMessages,
      };
    }
    // 重建空（range 内一行正文都没有：极端旧账本 / range 越界）→ 落回 ②，不误 404。
  }
  // ② 无 range（或重建为空）：归档本身就是全部可用原文，它非空即完整（不存在“只给一段”的歧义）。
  if (Array.isArray(payload) && payload.length > 0) {
    return {
      round: n, turns: projectTranscriptForDisplay([{ round: n, messages: payload }]), source: 'archive',
      truncated: droppedMessages > 0, dropped_messages: droppedMessages,
    };
  }
  // ③ 两条路都拿不出正文 ⇒ 这时候才真的叫“没有原文”。
  throw new SessionError('folded_payload_not_found', 'folded payload not found', { httpStatus: 404 });
}

/** `foldedRoundRange` 形态校验：两个非负整数且 from ≤ to；其余-shape 一律当“无范围”。 */
function normalizeFoldedRoundRange(raw) {
  const from = raw?.from;
  const to = raw?.to;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return null;
  if (from < 0 || to < from) return null;
  return { from, to };
}

/** 消息的 content block 数组（字符串 content 与上游一样当「没有 block」；非对象块丢掉）。 */
function contentBlocks(content) {
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === 'object') : [];
}

/**
 * issue #387：**纯读侧**把 `tool_result` 挂回带它那次 `tool_use` 的那条记录，再喂上游投影。
 *
 * 病根（实测 `resultPreview` **0/98**）：erix-agent 0.23+ 一轮是**多行**落盘的
 * （`:msg:<n>:0` = assistant 的 `tool_use`，`:msg:<n>:1..k` = 每个 `tool_result` 各一行，
 * `:engine:round:<n>` 载体的 `messages` 是空数组），而 `rebuildFoldedRange` 把**每行各自一条记录**
 * 喂给 `projectTranscriptForDisplay`。上游的配对函数 `toolResultsOf`（`src/display/projection.js`）
 * **只扫本条记录的 `messages`** ⇒ 结果块与调用块分家 ⇒ 每个 `toolCalls[]` 项只有 `name`/`argsSummary`，
 * 「调了什么」看得见、「返回了什么」全丢（#384 之后渲染器已经会画工具行，缺的就是这一件）。
 * 主消息流没这个病，是因为 `session-view.js` 在喂投影前先过了一遍读侧折叠
 * （`transcript-fold.js`，把消息行折回轮行）——**同一条「先配对再投影」的口径**。
 *
 * 为什么是「挂记录」而不是「折行」：本端点的 SQL 只取 `round, messages`（不取 `record`/`dedup_key`），
 * 折叠闸要的是 record 级形状；而重建面要的只有「让上游能配上对」这一件事。于是这里做**最小动作**：
 * 按 `tool_use_id` 在本 range 内建结果索引，把**缺结果的那些块原样**（同一个块对象引用，不改写任何字段）
 * 追加成一条 `{role:'user', content:[…tool_result 块…]}` 挂到带 `tool_use` 的那条记录末尾，
 * **配对仍由上游做** ⇒ `resultPreview`/`isError`/`executionStatus`/`durationMs` 与主消息流**同一把尺**，
 * 本站不复制第二套预览/截断规则（#95 红线：不向上游形状注入字段）。
 *
 * 三条不伪造的边界（判据 ②）：
 *   · 本 range 内**查不到** `tool_use_id` ⇒ 不追加任何东西 ⇒ 上游连 `resultPreview` 这个**键都不写**
 *     （上游对配不上的调用就是缺键，不是空串）；
 *   · 结果**本来就在同一条记录里**（0.22 老账本、或同轮单行）⇒ 不重复追加（幂等，输出逐字节不变）；
 *   · 只有 `tool_use` 没有 `id`（旧记录形状）⇒ 跳过，不猜。
 * 追加的那条消息**只有 tool_result 块**，上游 `textOf()` 对它是空串 ⇒ 走的是「model plumbing」那条
 * `continue`（`projection.js` 原注释）⇒ **不会多冒一个 user turn**（判据里用 turn 计数钉住）。
 *
 * ⚠ **同一个 `tool_use_id` 在 range 内有多份结果时取「就近」，不取「最后一条」也不取「第一条」**
 * （PR #541 第三方审计 MED，主 agent 裁决返工）。为什么不是 last-write-wins：上游明写 provider id
 * **不保证在一个 run 内唯一**（`erix-agent/src/tool-fact.js:209-210`：「**跳轮不在这里继承**：provider id
 * 不保证 run 内唯一（issue #284）」），于是「round A 用 `x` 得 A、round B 用 `x` 得 B」是合法形状 ——
 * range 级 `Map.set` 会把 B 覆盖成唯一值，**第一个 round 也就显示 B**（错内容比缺内容更难发现）。
 * 而「取第一条」只是把错的方向反过来（B 会显示 A）：正确性来自**位置**，不是插入顺序。
 * 现在的尺（`seq` 是全局单调计数，按「记录顺序 → 消息顺序 → 块顺序」发放，记录顺序就是 SQL 的
 * `ORDER BY round ASC, append_seq ASC` ⇒ `seq` 就是账本里的真实先后）：
 *   ① 取该 `tool_use` **之后**最近的一条同 id 结果（正常形状：结果行紧跟在调用行后面）；
 *   ② 之后一条都没有 ⇒ 回退取**之前**最近的一条（resume 复放：`:round:<n>:resume` 行重发旧调用，
 *      它的结果落在前面；真库实测 6 个跨轮复用的 id 全是这一类，见 §8.132 的取证读数）；
 *   ③ 一条都没有 ⇒ 不追加（回到判据 ② 的「缺键不伪造」）。
 * 同 id 出现多份时**必须可观测**：`duplicateIds` 交回调用方，由 `rebuildFoldedRange` 走现成的
 * `log.warn` 通道打一条（零新事件类型、零 DDL、零响应字段）。
 *
 * 只读：不改 `rows`、不改 `record.messages`（新建数组/新对象），账本一字节不动。
 * @returns {{ records: object[], duplicateIds: string[] }}
 */
function attachToolResultsToRecords(records) {
  const list = Array.isArray(records) ? records : [];
  /** @type {Map<string, { seq: number, block: object }[]>} range 内的 tool_use_id → 该 id 的全部结果块（带位置） */
  const results = new Map();
  /** @type {{ seq: number, id: string, recordIndex: number }[]} 按位置排的调用块 */
  const calls = [];
  /** @type {Set<string>[]} 每条记录里**已经**自己结清的 id（`own`，不重复挂） */
  const ownIds = [];
  let seq = 0; // 全局位置：只在 pass 1 里单调发号，pass 2 只读比较
  list.forEach((record, recordIndex) => {
    const own = new Set();
    ownIds[recordIndex] = own;
    for (const message of Array.isArray(record?.messages) ? record.messages : []) {
      for (const block of contentBlocks(message?.content)) {
        const at = seq++;
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const bucket = results.get(block.tool_use_id);
          const entry = { seq: at, block };
          if (bucket) bucket.push(entry);
          else results.set(block.tool_use_id, [entry]);
          own.add(block.tool_use_id);
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          calls.push({ seq: at, id: block.id, recordIndex });
        }
      }
    }
  });
  if (results.size === 0) return { records: list, duplicateIds: [] }; // 一条结果都没有 ⇒ 原样交回（老账本零改写）

  /** @type {Map<number, object[]>} recordIndex → 要追加的结果块（同一条记录内按调用顺序，去重同一块引用） */
  const picks = new Map();
  for (const call of calls) {
    if (ownIds[call.recordIndex]?.has(call.id)) continue; // 本记录已结清 ⇒ 用本记录那一份
    const candidates = results.get(call.id);
    if (candidates === undefined) continue; // range 内查不到 ⇒ 缺键，不伪造
    // ①「之后最近」优先；② 否则退到「之前最近」。两者都不看插入顺序 ⇒ first-wins 与 last-write-wins 一样错。
    let chosen;
    for (const c of candidates) {
      if (c.seq > call.seq && (chosen === undefined || c.seq < chosen.seq)) chosen = c;
    }
    if (chosen === undefined) {
      for (const c of candidates) {
        if (c.seq < call.seq && (chosen === undefined || c.seq > chosen.seq)) chosen = c;
      }
    }
    if (chosen === undefined) continue; // 位置相同（不可能：seq 唯一）⇒ 宁可不挂
    const bucket = picks.get(call.recordIndex) ?? [];
    if (!bucket.includes(chosen.block)) bucket.push(chosen.block); // 同一条记录里同 id 复用两次 ⇒ 只挂一份
    picks.set(call.recordIndex, bucket);
  }

  const duplicateIds = [...results.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([id]) => id);
  const out = list.map((record, recordIndex) => {
    const missing = picks.get(recordIndex);
    if (missing === undefined || missing.length === 0) return record;
    const messages = Array.isArray(record?.messages) ? record.messages : [];
    return { ...record, messages: [...messages, { role: 'user', content: missing }] };
  });
  return { records: out, duplicateIds };
}

/**
 * 按 `foldedRoundRange` 从同会话已有轮行重建原文（#375）。
 * 账本 append-only、全站 `DELETE FROM transcript_rounds` 零命中 ⇒ 可证无损；上限与截断口径同 U7 recall。
 * 取行不取折叠行本身（它的 `messages` 是空数组）；`messages <> '[]'::jsonb` 把无正文的事实行筛掉。
 */
async function rebuildFoldedRange(pool, { key, range, log }) {
  const res = await pool.query(
    `SELECT round, messages FROM transcript_rounds
      WHERE transcript_key = $1 AND round BETWEEN $2 AND $3 AND messages <> '[]'::jsonb
      ORDER BY round ASC, append_seq ASC LIMIT $4`,
    [key, range.from, range.to, FOLDED_REBUILD_MAX_ROWS + 1],
  );
  const rows = res.rows ?? [];
  const truncated = rows.length > FOLDED_REBUILD_MAX_ROWS;
  const kept = truncated ? rows.slice(0, FOLDED_REBUILD_MAX_ROWS) : rows;
  const records = kept.map((r) => ({ round: Number(r.round), messages: r.messages }));
  // issue #387：先把 `tool_result` 挂回带 `tool_use` 的记录（纯读侧，见 `attachToolResultsToRecords`），
  // 再喂上游投影：配对与预览截断的尺全部留在上游。
  const { records: paired, duplicateIds } = attachToolResultsToRecords(records);
  // PR #541 MED：同一个 `tool_use_id` 在 range 内有多份结果 ⇒ 取「就近」必须**可观测**（否则挂错了
  // 没人看得见）。走现成的 warn 日志通道：零新事件类型、零 DDL、零响应字段（响应形状是契约，
  // 而「运维要看」不需要前端画它）。只报条数 + 一个示例 id，不拼完整 id 列表（日志不许刷屏）。
  if (duplicateIds.length > 0) {
    log?.warn?.(`[sessions] folded 重建：${duplicateIds.length} 个 tool_use_id 在 range ${range.from}-${range.to} 内`
      + `有多份结果，已按「就近优先」取一条（session=${key}，例：${duplicateIds[0]}）`);
  }
  return { turns: projectTranscriptForDisplay(paired), truncated };
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
export async function postMessage(pool, {
  userId, sessionId, content, attachments, notify, record, onSessionTitle,
  triggerKind = 'user_send',
  // issue #627 ②③：两个只给「平台自己起的 run」（宏 / 自动化）用的参数。
  //  ② `cwd`：非空串且与会话当前 cwd 不同 ⇒ 事务内刷 `chat_sessions.cwd`（run 的 cwd 是 claim
  //     时从会话行读的，不刷 = 继续在旧目录跑）。会话行本事务已 FOR UPDATE，与并发发送串行。
  //  ③ `maxRounds`：本次 run 的轮数上限。**选定的路线 = 写进 run 行**，理由写在下面写入处。
  // 两者对用户面发消息（routes 层）都不传 ⇒ 行为逐字不变。
  cwd = null, maxRounds = null,
  //  issue #676 ①：`config` 只为绝对路径 cwd 的 jail 校验提供 `userSpaceRoot`（相对形式无需）。
  //    缺省 ⇒ `{}`：相对 `~/projects/<name>` 照旧通过；绝对路径会因缺 userSpaceRoot 而被拒（响亮失败）。
  config = {},
  //  ④ issue #662：`reviewOnly` = 本次 run 是「只读审查 run」的宿主声明（专为宏审查 run 用）。
  //    与 `maxRounds` 同路（写进 `runs.run_state` 的 **`host_review_only`** jsonb 键，**不加列**、
  //    不动迁移），下行经 `internal.assembleTicket` 的 `review_only` → `runner/agentd.js` 的
  //    `childEnv.RUN_REVIEW_ONLY`。⚠ 严格布尔：只有 `=== true` 才落键；`false`/缺省**不写**
  //    （区分「没声明」与「声明关」，回落到容器默认；worker 的 `isReviewOnly()` 判 `=== '1'`）。
  reviewOnly = false,
}) {
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

    // issue #676 ①：越界 cwd **响亮失败**——在写任何行（消息 / run / run_queue）之前先验。
    // 过去 `postMessage` 任意字符串都收 → 错 cwd（如快照建在 portal 本地盘 `/root/.erix/...`）
    // 会「账上 done、实际空转」。校验器（`validateRunCwd`）拒绝 ⇒ SessionError → 本事务 ROLLBACK，
    // 会话 cwd 不刷、run 不入队（调用方看到 validation_failed，而不是假绿）。
    const nextCwd = typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null;
    if (nextCwd !== null && nextCwd !== s.cwd) {
      validateRunCwd(nextCwd, { userSpaceRoot: config?.userSpaceRoot, fdeName: fde.rows[0]?.fde_name ?? null });
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
    // issue #497（工单 feat-261112-01，方案 A3）：`users.last_activity_at` = 该用户**按下发送那一刻**。
    // 本处与 `queued-inputs.js#enqueueQueuedInput` 是全仓**唯二**的两个写入点（口径见 `docs/data/model.md` §1.1）。
    // 三条红线：
    //  ① **同一个 `client`、同一事务**（就贴在上面那条 seq 分配旁边）——本列的语义是「这句话真的说出去了」。
    //    把它挪到 COMMIT 之后、或另开一次 `pool.query`（= 自开连接、自带事务），就会出现
    //    「消息因 409 / 幂等冲突 / ROLLBACK 没落库，但活动位已经前进」——那是说谎的时间戳。
    //  ② **不节流**（人已拍板）：每发一条写一次，不时间窗、不「比当前值新才写」。
    //    节流会把「12:00:03 他说过一句」抹成「12:00:00 他说过话」，而这一列存在的唯一理由就是「他什么时候说的这句话」。
    //  ③ **登录 / run 生命周期 / 改名 / 归档都不写它** ⇒ 它**允许比 `last_login_at` 旧**
    //    （登录了但一句话没说）。那是设计意图，别「顺手」在别处补写。
    await client.query(`UPDATE users SET last_activity_at = now() WHERE id = $1`, [userId]);
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
    // #370：lineage。`queued_steer` / `queued_follow_up` 的 run 各带一份 maxRounds 预算，
    // 没有这个字段就没法把「队列投递产生的成本」从普通发送里分出来（拍板点 ①：先测量再调参）。
    const run = await client.query(
      `INSERT INTO runs (id, session_id, status, trigger_kind)
       VALUES ($1, $2, 'queued', $3) RETURNING id, status, trigger_kind`,
      [runId, s.id, triggerKind],
    );
    await client.query(
      `INSERT INTO run_queue (run_id, container_id, status) VALUES ($1, $2, 'pending')`,
      [runId, container.rows[0].id],
    );
    // issue #627 ②：会话级 cwd 刷新（只对传了 cwd 的调用方生效）。放在同事务 ⇒ 与
    // 「本 run 入队」原子：不会出现「run 已排但 cwd 仍旧」的一半状态。
    // #676 ①：`nextCwd` 已在事务开头经 `validateRunCwd` 校验（越界早在入队前就抛），此处只做刷新。
    if (nextCwd !== null && nextCwd !== s.cwd) {
      await client.query(
        `UPDATE chat_sessions SET cwd = $2, updated_at = now() WHERE id = $1`,
        [s.id, nextCwd],
      );
    }
    // issue #627 ③：`maxRounds` 真的进 run。**路线选择与理由**（issue 里给了两条）：
    //   查清：run 的 maxRounds 过去**只来自容器级 env** `ERIX_MAX_ROUNDS`（provisioner.js:231 注入、
    //   worker.js:1105 parseMaxRounds，默认 16）——runs 表无 `max_rounds` 列、run_queue 无 payload 列、
    //   claim ticket 也不带 ⇒ 根本不存在 per-run 通道，「只加 postMessage 参数」落不了地。
    //   拍板：**写进 run 行**（本行），再让 claim 把它随 ticket 下行，agentd 以 per-run
    //   `ERIX_MAX_ROUNDS` 起 worker——worker 已经读这个 env，一行不用改，语义与容器默认同一口径。
    //   存在 `runs.run_state` 的 **`host_max_rounds`** 键上而不是新增列：加列要动迁移（#626/#627
    //   硬要求：不动迁移，代价是 19 处 head 断言）。`run_state` 本列由引擎 `saveRunState` 服务端
    //   `||` 合并写，它的键集里没有 `host_max_rounds` ⇒ 宿主的键不会被引擎覆盖（引擎也不读它）。
    const mr = Number(maxRounds);
    const safeMaxRounds = Number.isInteger(mr) && mr >= 1 && mr <= 100 ? mr : null;
    // 区间与 `shared/macro-kinds.js` KIND_SCHEMA['scheduled-task'].maxRounds（min 1 / max 100）同口径；
    // 非法值不写键（而不是写个 0）：没声明 = 用容器默认，不能把非法输入翻译成一个更小的小轮数。
    if (safeMaxRounds !== null) {
      await client.query(
        `UPDATE runs SET run_state = COALESCE(run_state, '{}'::jsonb)
                              || jsonb_build_object('host_max_rounds', $2::int)
          WHERE id = $1`,
        [runId, safeMaxRounds],
      );
    }
    // issue #662：`reviewOnly` 进 run（per-run，容器多 run 共用 ⇒ 进程级 env 不够）。
    // 与 `host_max_rounds` 完全同路：同一张 `run_state` 的 `||` 合并写；**只有 true 才落键**
    // （`false`/缺省不写，区分「没声明」与「声明关」；agentd 只对 true 置 RUN_REVIEW_ONLY='1'）。
    if (reviewOnly === true) {
      await client.query(
        `UPDATE runs SET run_state = COALESCE(run_state, '{}'::jsonb)
                              || jsonb_build_object('host_review_only', true)
          WHERE id = $1`,
        [runId],
      );
    }
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
      run: {
        id: run.rows[0].id, status: run.rows[0].status, trigger_kind: run.rows[0].trigger_kind,
        // #627 ③：回显本次 run 真的带上了轮数上限（没带 = null，调用方可判）。
        max_rounds: safeMaxRounds,
      },
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
      // issue #502 形态 M 在这里**故意不写** `run_end.payload.partial_text`，不是漏接：
      // 本分支的 run 从未开始（`runs.status` 仍是 `queued`，worker 先报 U1 `running` 才会开跑），
      // 而碎片只可能从 U3 上来 ⇒ 此时进程内缓冲必然是空的，`internal.js#runEndPartialKeys` 会直接
      // 返回空对象（= 载荷逐字不变）。所以这里**不调它也没有任何缺口**，而留着这段理由是必要的：
      // 将来若有「queued 但已流式过」的终态点，接 `runEndPartialKeys(runId)` 并开载荷即可
      //（别又开一条事件行 —— 形态 M 的落点是既有的 `run_end`，理由见那处注释）。
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
// issue #114：「AI 改名」——按需的一次 LLM 调用（用户点按钮才花钱，不做任何自动刷新）
//
// **issue #322 起：标题只有一条生成路径。**手工改名（本文件的 `generateAiTitle`）与自动改名
// （`session-title.js` 的 `evaluateAutoTitle`）**都**调 `portal/src/title-llm.js` 的 `generateTitle()`，
// 那个文件再调 `portal/src/llm-chat.js`（portal 侧**对话调用面**的唯一出口：URL 拼接 / `max_tokens` 必发 /
// 超时到点必报错 / 错误映射 / key 只进 `Authorization` 头都在那里）。系统提示、上下文形状、输出预算、
// provider 形态⇒ **只有一份**，在 `title-llm.js`；本文件只留会话业务：取上下文 → 调生成 → 清洗 → 落库 → 推送。
//
// 「例外」这个词从本单起消失：过去本端点被写成「决策者批准的例外（portal 允许直连一次对话）」，
// 而 #322 把生成统一回 portal 后，portal 就是标题的**唯一实现点**，它不再是例外，只是一条正常实现。
// （另：此处与 `portal.md` §4.5a 过去写「原则出自 #88『portal 不持 LLM 客户端』」是**记错了**——#88 原文是
// 「只动 portal + 前端展示；runner/agentd 零改动」，方向相反；真实成因是实现把自动标题放到了 runner。）
//
// 新加的 portal 直连对话**不许**自己拼 `fetch`，一律走 `llm-chat.js`（`llm.js` 是网关**管理面**，不发对话）。
//
// key 纪律（llm.js 三条存储纪律 ③）：api_key 只进 Authorization 请求头，
// 绝不进日志/错误信息/HTTP 响应（`llm-chat.js` 里的 redactSecret 做最后一道兜底）。
// ---------------------------------------------------------------------------

/**
 * 以下五个名字是 `title-llm.js` 里那份的**别名**（#322 前这些值由本文件定；现在生成只有一条路径，
 * 值也只有一个定义点）。保留名字是为了：既有调用方 / 文档 / 测试口径一字不动
 * （`portal/test/llm-chat.test.js` 钉的就是「与 `sessions.js` 同一个数」）。
 *
 * `AI_TITLE_MAX_TOKENS` 就是 #315 里那个「必发的 512」——它等于 `llm-chat.js` 的显式默认
 * `LLM_CHAT_DEFAULT_MAX_TOKENS`，不再是本文件自己写的字面量（两条路径共用一个数 = #315 的病因消失）。
 * 不发会怎样的完整因果链留在 `title-llm.js` 与 `docs/api/portal.md` §4.5a。
 */
export const AI_TITLE_CONTEXT_MESSAGES = TITLE_CONTEXT_MESSAGES;
export const AI_TITLE_CONTEXT_MAX_LEN = TITLE_CONTEXT_MAX_LEN;
export const AI_TITLE_TIMEOUT_MS = TITLE_LLM_TIMEOUT_MS;
export const AI_TITLE_MAX_TOKENS = TITLE_LLM_MAX_TOKENS;
/** 系统提示：与 `AUTO_TITLE_MAX_LEN`（30）同口径（落库前仍过一遍 `sanitizeTitle`）；两条路径共用。 */
export const AI_TITLE_SYSTEM_PROMPT = TITLE_SYSTEM_PROMPT;

// 拼接改名上下文的纯函数已抽到 `title-llm.js`（两条路径共用），此处重新导出，名字与行为一字未改。
export { buildAiTitlePrompt };

// 以下三个「一次对话请求」的通用件（URL 拼接 / 取助手文本 / 脱敏）**已搬到 `llm-chat.js`**——那是
// portal 侧对话调用面的唯一定义点（工单 261020-04，#315 追加）。此处**重新导出**只为让既有调用方
// 与文档口径不受影响（名字与行为一字未改）；**新代码请直接从 `./llm-chat.js` 引**。
export { chatCompletionsUrl, extractAssistantText, redactSecret };

/**
 * AI 改名必须使用该 FDE 的 **活绑定**（LiteLLM 虚拟 key）；不再回退到 Station 本地 provider 目录。
 *
 * 取数与 provider 形态住在 `title-llm.js` 的 `resolveTitleLlmProvider`（手工与自动**共用那一份**，
 * 它拿不到绑定时返回 `null` 而不抛错）。**是否报错是会话业务的判断**：手工改名是用户主动点的，
 * 没绑定就 `409 llm_not_configured`（文案与收口前逐字一致）；自动改名则静默退到降级链。
 */
export async function resolveAiTitleProvider(pool, userId, { gatewayUrl = 'http://127.0.0.1:4100' } = {}) {
  const provider = await resolveTitleLlmProvider(pool, userId, { gatewayUrl });
  if (provider) return provider;
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
 * 工单 261020-04（#315 追加）：那条手搓 `fetch`（自拼 URL / 自写超时 / 自填 max_tokens）**已退役**；
 * 工单 #322：生成那一层（系统提示 / 上下文形状 / 预算 / provider 形态）**再往上收一层**到
 * `title-llm.js`，与自动改名共用同一个出口 ⇒ 手工与自动不再可能是两套语义。
 * 本函数只负责会话业务（取上下文、清洗、落库、推送）；「发一次对话」的口径在 `llm-chat.js`。
 * 错误类型仍用 `SessionError`（作为 `ErrorCtor` 递给 client）⇒ `http.js` 的映射不用改，状态码 /
 * `error.code` / 文案与收口前一致（`error.details` 是错误体里本就可选的附加结构，只放原因与状态码，
 * 见 `docs/api/portal.md` §4.5a）。
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

  // #322：生成走**唯一入口** `title-llm.js` 的 `generateTitle()`（它再走 `llm-chat.js`：URL 拼接 /
  // `max_tokens` 必发 / 超时 / 错误映射 / key 只进 Authorization 头都在那里定死）。本处只传会话业务
  // 需要的东西：上下文拼成的 user 提示、超时、`ErrorCtor`（递 SessionError ⇒ `http.js` 的映射零改动）、
  // 以及日志用的 tag/session（日志文本与收口前一致）。预算/温度/系统提示不再在本文件出现——它们只
  // 在 `title-llm.js` 有一份，自动改名吃的是完全同一份。
  // #596：`systemPrompt` = DB 生效值（读不到 ⇒ 内置 `TITLE_SYSTEM_PROMPT`，`resolveEffectiveTitlePrompt`
  // 永不抛）。提示词**不是守卫**：下面照旧 `sanitizeTitle` 后才落库。
  const titlePrompt = await resolveEffectiveTitlePrompt({ pool, log });
  const text = await generateTitle({
    provider,
    systemPrompt: titlePrompt.text,
    userPrompt: buildAiTitlePrompt(contexts),
    timeoutMs,
    fetchImpl,
    ErrorCtor: SessionError,
    log,
    logTag: 'ai-title',
    logContext: `session=${sessionId}`,
  });

  const title = sanitizeTitle(text);
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
    // #526（10 篇 §4 第 4 条）：会话来源。`human`（默认）/ `macro:<宏名>`；侧栏「自动化」分组按
    // `origin LIKE 'macro:%'` 过滤（写入侧归 W7）。旧行/未带列的查询兔底 'human'。
    origin: r.origin ?? 'human',
    model: r.model,
    status: r.status,
    last_seq: Number(r.last_seq),
    created_at: r.created_at?.toISOString?.() ?? r.created_at,
    updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}
