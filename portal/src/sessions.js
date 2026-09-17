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

/** session 属主校验 + 取行；不存在/不属本人一律 404（不泄露存在性，portal.md §1.2 惯例）。 */
async function fetchSession(pool, sessionId, userId, { forUpdate = false } = {}) {
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

/** GET /api/sessions?project_id=（可选过滤，按 updated_at 倒序 + keyset 分页 §1.3）。 */
export async function listSessions(pool, { userId, projectId, cursor, limit = 50 }) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [userId];
  let where = `user_id = $1 AND status = 'active'`;
  if (projectId) {
    params.push(projectId);
    where += ` AND project_id = $${params.length}`;
  }
  if (cursor) {
    params.push(cursor);
    where += ` AND updated_at < (SELECT updated_at FROM chat_sessions WHERE id = $${params.length})`;
  }
  params.push(n + 1);
  const res = await pool.query(
    `SELECT s.id, s.project_id, s.title, s.model, s.last_seq, s.created_at, s.updated_at,
            (SELECT count(*) FROM runs r WHERE r.session_id = s.id AND r.status IN ${ACTIVE_RUN_STATES}) > 0 AS has_active_run
       FROM chat_sessions s
      WHERE ${where}
      ORDER BY s.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
  const items = res.rows.slice(0, n).map(rowToSession);
  const nextCursor = res.rows.length > n ? res.rows[n - 1].id : null;
  return { items, next_cursor: nextCursor };
}

/** POST /api/sessions —— 建会话（project 必须属本人）。 */
export async function createSession(pool, { userId, projectId, title, model }) {
  if (!projectId || typeof projectId !== 'string') {
    throw new SessionError('validation_failed', 'project_id 必填', { details: { field: 'project_id' } });
  }
  const own = await pool.query(`SELECT id FROM projects WHERE id = $1 AND user_id = $2`, [projectId, userId]);
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

/** GET /api/sessions/:id —— 会话详情 + 消息列表（seq 升序）+ last_seq + 活跃 run。 */
export async function getSession(pool, { userId, sessionId, limit = 200 }) {
  const s = await fetchSession(pool, sessionId, userId);
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const msgs = await pool.query(
    `SELECT id, run_id, seq, role, content, synthetic, attachments, created_at
       FROM messages WHERE session_id = $1 ORDER BY seq ASC LIMIT $2`,
    [sessionId, n],
  );
  const active = await pool.query(
    `SELECT id, status FROM runs WHERE session_id = $1 AND status IN ${ACTIVE_RUN_STATES} ORDER BY queued_at DESC LIMIT 1`,
    [sessionId],
  );
  return {
    session: rowToSession(s),
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
    active_run: active.rows[0] ? { id: active.rows[0].id, status: active.rows[0].status } : null,
  };
}

/** PATCH /api/sessions/:id —— 改标题。 */
export async function updateSession(pool, { userId, sessionId, title }) {
  await fetchSession(pool, sessionId, userId);
  if (typeof title !== 'string' || title.length > 200) {
    throw new SessionError('validation_failed', 'title 必须为 ≤200 字符的字符串', { details: { field: 'title' } });
  }
  const res = await pool.query(
    `UPDATE chat_sessions SET title = $2, updated_at = now() WHERE id = $1
     RETURNING id, user_id, project_id, title, model, status, last_seq, created_at, updated_at`,
    [sessionId, title],
  );
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
 * seq 原子分配写 user 消息 → 建 run + run_queue → COMMIT → 唤醒 claim（runner §4.2）。
 * 拉模型（终态）语义：落库即 202，FDE 不在线时 run 在队列等待（§6.3）。
 */
export async function postMessage(pool, { userId, sessionId, content, attachments, notify }) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new SessionError('validation_failed', 'content 必填且非空', { details: { field: 'content' } });
  }
  if (content.length > 100_000) {
    throw new SessionError('validation_failed', 'content 过长（≤100000 字符）', { details: { field: 'content' } });
  }
  if (attachments !== undefined) {
    if (!Array.isArray(attachments)) {
      throw new SessionError('validation_failed', 'attachments 必须为数组', { details: { field: 'attachments' } });
    }
    for (const a of attachments) {
      if (!a || typeof a !== 'object' || !['file', 'image'].includes(a.kind) || typeof a.path !== 'string' || !a.path) {
        throw new SessionError('validation_failed', 'attachments 元素须为 {kind: file|image, path, name?}', { details: { field: 'attachments' } });
      }
    }
  }

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

    const container = await client.query(
      `SELECT id FROM containers WHERE user_id = $1 AND status <> 'removed' ORDER BY created_at DESC LIMIT 1`,
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
      [s.id, seq, content, JSON.stringify(attachments ?? [])],
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

    await client.query('COMMIT');
    committed = {
      message: {
        id: msg.rows[0].id,
        run_id: runId,
        seq: Number(msg.rows[0].seq),
        role: 'user',
        content: msg.rows[0].content,
        synthetic: false,
        attachments: attachments ?? [],
        created_at: msg.rows[0].created_at?.toISOString?.() ?? msg.rows[0].created_at,
      },
      run: { id: run.rows[0].id, status: run.rows[0].status },
    };
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
 * 终止结果经 SSE run_end（reason='aborted'）体现；无进行中 run → 409 no_active_run。
 */
export async function stopSession(pool, { userId, sessionId }) {
  await fetchSession(pool, sessionId, userId);
  const res = await pool.query(
    `UPDATE runs SET status = 'cancelling', cancel_requested_at = now()
      WHERE session_id = $1 AND status IN ('queued', 'running')
      RETURNING id, status`,
    [sessionId],
  );
  if (res.rows.length === 0) {
    throw new SessionError('no_active_run', 'no active run on session', { httpStatus: 409 });
  }
  return { run: { id: res.rows[0].id, status: res.rows[0].status } };
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
