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
 *  P5：projects 表退役留档——不再 JOIN projects（project_id 可空，cwd 为权威绑定）。 */
async function fetchSession(pool, sessionId, userId, { forUpdate = false } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.project_id, s.cwd, s.title, s.title_source, s.model, s.status, s.last_seq
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
            (SELECT r.id FROM runs r WHERE r.session_id = s.id AND r.status IN ${ACTIVE_RUN_STATES} ORDER BY r.queued_at DESC LIMIT 1) AS active_run_id
       FROM chat_sessions s
      WHERE ${where}
      ORDER BY s.updated_at DESC, s.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const items = res.rows.slice(0, n).map((r) => ({ ...rowToSession(r), active_run_id: r.active_run_id ?? null }));
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
 */
export async function getSession(pool, { userId, sessionId, limit = 20, messagesCursor }) {
  const s = await fetchSession(pool, sessionId, userId);
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
  const msgs = await pool.query(
    `SELECT id, run_id, seq, role, content, synthetic, attachments, created_at
       FROM messages WHERE ${where} ORDER BY seq DESC LIMIT $2`,
    params,
  );
  const hasOlder = msgs.rows.length > n; // 多取的 1 条存在 ⇒ 还有更早消息
  if (hasOlder) msgs.rows.pop();
  msgs.rows.reverse(); // 升序返回
  const active = await pool.query(
    `SELECT id, status FROM runs WHERE session_id = $1 AND status IN ${ACTIVE_RUN_STATES} ORDER BY queued_at DESC LIMIT 1`,
    [sessionId],
  );
  return {
    session: { ...rowToSession(s), active_run_id: active.rows[0]?.id ?? null },
    messages: msgs.rows.map((m) => ({
      id: m.id,
      run_id: m.run_id,
      seq: Number(m.seq),
      role: m.role,
      content: m.content,
      synthetic: m.synthetic,
      attachments: m.attachments ?? [],
      created_at: m.created_at?.toISOString?.() ?? m.created_at,
    })),
    last_seq: Number(s.last_seq),
    // 还有更早的消息时给出 cursor（客户端用它取历史；对齐 §1.3 响应形状）
    next_cursor: hasOlder ? Number(msgs.rows[0].seq) : null,
  };
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
 * seq 原子分配写 user 消息 → 建 run + run_queue → **幂等台账转 done（record，同事务）** → COMMIT
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

    // N3（Round C 评审）：取与 setFdeLlmConfig 相同的 per-FDE advisory lock，使「建 run」与
    // 「LLM 配置写入」全序——关闭「F6 守卫检查在配置事务外 → PUT 查到无活跃 run → 并发建 run
    // 提交 → PUT 提交」的竞态窗口。锁序：chat_sessions（上，FOR UPDATE）→ 本 advisory →（D2 起
    // 中间还有 llm-provider advisory，见下）→ containers（下，FOR UPDATE）——与全系统偏序
    // chat_sessions < llm-binding < llm-provider < containers 一致（完整论证见 llm.js 文件头注释），
    // 无环、无死锁。
    // fde_name 为 null 的账户不可能有 fde_llm_bindings 行（配置按 fde_name 寻址），跳过不取锁。
    const fde = await client.query(`SELECT fde_name FROM users WHERE id = $1`, [userId]);
    if (fde.rows[0]?.fde_name) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${fde.rows[0].fde_name}`]);
    }

    // D2（Round D 评审）：该 FDE 当前 active binding 的 provider 再取 per-provider advisory lock
    //（key 与 updateProvider 事务开头所取同），使「provider PATCH（换上游/停用）」与「建 run」全序——
    // 关闭「PATCH 在建 run 的『无活跃 run』检查之后提交、已启动 run 的上游被改」的窗口：PATCH 先提交则
    // 本 run 用新上游（run 边界语义）；本 run 先提交则 updateProvider 拿锁后的 N2 事务内复检必见其 → 409。
    // 锁序：本锁在 llm-binding 之后、containers FOR UPDATE 之前（chat_sessions < llm-binding <
    // llm-provider < containers），无环（完整论证见 llm.js 文件头注释）。
    // 一致性：本 SELECT 在 llm-binding 锁之下——该锁串行化 setFdeLlmConfig/deleteFdeLlmConfig/syncFde
    // 全部 binding 写入方，读到的是已提交快照（provider_id 本身可被 setFdeLlmConfig 更新，
    // 但该更新同样必须持 llm-binding 锁——与本读串行：要么先提交（本读得新值），要么后提交
    // （其事务内活跃 run 复检必见本 run → 409/force）），故锁 key 与本 run 实际使用的 provider 同指。
    const binding = await client.query(
      `SELECT provider_id FROM fde_llm_bindings WHERE fde_id = $1 AND state = 'active'`,
      [userId],
    );
    if (binding.rows[0]?.provider_id) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-provider:${binding.rows[0].provider_id}`]);
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
    const msg = await client.query(
      `INSERT INTO messages (session_id, seq, role, content, attachments)
       VALUES ($1, $2, 'user', $3, $4)
       RETURNING id, seq, role, content, attachments, created_at`,
      [s.id, seq, safeContent, JSON.stringify(safeAttachments)],
    );

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
        content: msg.rows[0].content,
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
 * POST /api/sessions/:id/stop —— 写 cancel_requested_at + status='cancelling'（portal.md §4.5）。
 * 事务内锁 session 行（与发消息串行化，防「检查无活跃 run → 新 run 提交 → 误停新 run」竞态）；
 * 终止结果经 SSE run_end（reason='aborted'）体现；cancelling 重复停止幂等返回 200。
 */
export async function stopSession(pool, { userId, sessionId }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const s = await fetchSession(client, sessionId, userId, { forUpdate: true });
    // 先停止 queued/running；已是 cancelling 视为幂等成功（前端重复点击不报错）
    let res = await client.query(
      `UPDATE runs SET status = 'cancelling', cancel_requested_at = now()
        WHERE session_id = $1 AND status IN ('queued', 'running')
        RETURNING id`,
      [s.id],
    );
    if (res.rows.length === 0) {
      res = await client.query(
        `SELECT id FROM runs WHERE session_id = $1 AND status = 'cancelling' ORDER BY queued_at DESC LIMIT 1`,
        [s.id],
      );
      if (res.rows.length === 0) {
        throw new SessionError('no_active_run', 'no active run on session', { httpStatus: 409 });
      }
    }
    await client.query('COMMIT');
    return { run: { id: res.rows[0].id, status: 'cancelling' } };
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

/**
 * provider 解析（issue #114）：① 会话属主 FDE 的 active LLM binding（llm.js 既有读取面）优先；
 * ② 回退第一个启用的 text provider + model；③ 都没有 → 409 llm_not_configured（清晰文案）。
 *
 * 回退分支为何不带凭据：`llm_providers` 表**不存 api_key**——key 只存在于 per-FDE 的
 * `fde_llm_bindings`（红线 ①「容器永不持有真 key」的同源纪律：key 按 FDE 隔离）。
 * 因此该回退只适用于无需鉴权的自建 OpenAI 兼容端点；带鉴权的上游必须为对应 FDE 配 binding。
 */
export async function resolveAiTitleProvider(pool, userId) {
  // ① FDE binding（llm.js 既有读取面）：DB 故障不吞（fetchSession 已证明 DB 可用，抛错走 500 更诚实）。
  const cfg = await getFdeLlmConfig(pool, userId);
  const mainModel = cfg?.main?.model_id;
  if (cfg?.base_url && cfg?.api_key && mainModel) {
    return { base_url: cfg.base_url, api_key: cfg.api_key, model: mainModel, source: 'fde_binding' };
  }
  const res = await pool.query(
    `SELECT p.base_url, m.model_id
       FROM llm_providers p
       JOIN llm_models m ON m.provider_id = p.id
      WHERE p.enabled = true AND m.enabled = true AND m.type = 'text'
      ORDER BY p.created_at ASC, m.created_at ASC
      LIMIT 1`,
  );
  const row = res.rows?.[0];
  if (row?.base_url && row?.model_id) {
    return { base_url: row.base_url, api_key: null, model: row.model_id, source: 'first_text_provider' };
  }
  throw new SessionError(
    'llm_not_configured',
    '未配置可用的 LLM 上游（AI 改名需要一次 LLM 调用）：请在管理台为该 FDE 配置 LLM 供应商与模型，或至少启用一个 text 模型',
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
  userId, sessionId, fetchImpl = fetch, timeoutMs = AI_TITLE_TIMEOUT_MS, notify, log = console,
} = {}) {
  await fetchSession(pool, sessionId, userId);

  const msgs = await pool.query(
    `SELECT content FROM messages
      WHERE session_id = $1 AND role = 'user'
      ORDER BY seq ASC LIMIT $2`,
    [sessionId, AI_TITLE_CONTEXT_MESSAGES],
  );
  const contexts = (msgs.rows ?? []).map((r) => r.content);
  if (contexts.length === 0) {
    throw new SessionError('no_user_messages', '会话还没有用户消息，无法生成标题', { httpStatus: 409 });
  }

  const provider = await resolveAiTitleProvider(pool, userId);

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
