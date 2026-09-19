// 会话与对话链路（portal.md §4/§5）。
// 端点：GET/POST /api/sessions、GET/PATCH/DELETE /api/sessions/:id、
//       POST /api/sessions/:id/messages（建 run 入队）、POST .../stop（写 cancel_requested_at）。
// SSE 流（GET /api/sessions/:id/events）在 http.js 组装：DB 补发（§5.2 Last-Event-ID）+ 实时注册（session hub）。
// 依据：规格 §10.2/§13.2-4（多轮显式传 task）、D7（事件先落 DB）、§9.3（seq 由宿主原子分配）。
import crypto from 'node:crypto';

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

/** session 属主校验 + 取行；不存在/不属本人/已归档/非法 UUID 一律 404（不泄露存在性，portal.md §1.2 惯例）。 */
async function fetchSession(pool, sessionId, userId, { forUpdate = false } = {}) {
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) {
    throw new SessionError('not_found', 'session not found', { httpStatus: 404 });
  }
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const res = await pool.query(
    `SELECT s.id, s.user_id, s.project_id, s.title, s.model, s.status, s.last_seq,
            p.name AS project_name
       FROM chat_sessions s
       JOIN projects p ON p.id = s.project_id
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

/** GET /api/sessions?project_id=（可选过滤，按 updated_at 倒序 + keyset 分页 §1.3：默认 20、上限 100）。 */
export async function listSessions(pool, { userId, projectId, cursor, limit = 20 }) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const params = [userId];
  let where = `user_id = $1 AND status = 'active'`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  if (cursor) {
    if (!UUID_RE.test(cursor)) {
      throw new SessionError('validation_failed', 'cursor 非法', { details: { field: 'cursor' } });
    }
    params.push(cursor);
    where += ` AND updated_at < (SELECT updated_at FROM chat_sessions WHERE id = $${params.length})`;
  }
  params.push(n + 1);
  const res = await pool.query(
    `SELECT s.id, s.project_id, s.title, s.model, s.last_seq, s.created_at, s.updated_at,
            (SELECT r.id FROM runs r WHERE r.session_id = s.id AND r.status IN ${ACTIVE_RUN_STATES} ORDER BY r.queued_at DESC LIMIT 1) AS active_run_id
       FROM chat_sessions s
      WHERE ${where}
      ORDER BY s.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const items = res.rows.slice(0, n).map((r) => ({ ...rowToSession(r), active_run_id: r.active_run_id ?? null }));
  const nextCursor = res.rows.length > n ? res.rows[n - 1].id : null;
  return { items, next_cursor: nextCursor };
}

/** POST /api/sessions —— 建会话（project 必须属本人且未删除）。 */
export async function createSession(pool, { userId, projectId, title, model }) {
  if (!projectId || typeof projectId !== 'string') {
    throw new SessionError('validation_failed', 'project_id 必填', { details: { field: 'project_id' } });
  }
  const own = await pool.query(
    `SELECT id FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [projectId, userId],
  );
  if (!own.rows?.[0]) {
    throw new SessionError('not_found', 'project not found', { httpStatus: 404 });
  }
  if (title !== undefined && (typeof title !== 'string' || title.length > 200)) {
    throw new SessionError('validation_failed', 'title 必须为 ≤200 字符的字符串', { details: { field: 'title' } });
  }
  if (model !== undefined && (typeof model !== 'string' || model.length > 100)) {
    throw new SessionError('validation_failed', 'model 必须为 ≤100 字符的字符串', { details: { field: 'model' } });
  }
  const res = await pool.query(
    `INSERT INTO chat_sessions (user_id, project_id, title, model)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, project_id, title, model, status, last_seq, created_at, updated_at`,
    [userId, projectId, title ?? '', model ?? null],
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
  const res = await pool.query(
    `UPDATE chat_sessions SET title = $2, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, user_id, project_id, title, model, status, last_seq, created_at, updated_at`,
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
 */
export async function postMessage(pool, { userId, sessionId, content, attachments, notify, record }) {
  // 体校验（与 handlePostMessage 的前置校验同一函数；此处兜底，保证直接调用者也拿不到非法数据）
  const valid = validateMessageBody({ content, attachments });
  const safeContent = valid.content;
  const safeAttachments = valid.attachments;

  const client = await pool.connect();
  let committed = null;
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

function rowToSession(r) {
  return {
    id: r.id,
    project_id: r.project_id,
    title: r.title,
    model: r.model,
    status: r.status,
    last_seq: Number(r.last_seq),
    created_at: r.created_at?.toISOString?.() ?? r.created_at,
    updated_at: r.updated_at?.toISOString?.() ?? r.updated_at,
  };
}
