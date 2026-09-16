// portal 侧 internal API：容器（agentd）→ portal 的全出站通道（runner-integration §4）。
// 依据：docs/design/runner-integration.md §4/§6/§7/§9、docs/api/portal.md §9、docs/data/schema.sql。
// 三条不变式落地：容器不直连 DB（本模块是唯一写方）、DB 是状态真相、ingress 是唯一入口
//   （internal 经 Traefik Host+PathPrefix+ipAllowList 回环到 portal，见 routes.js）。
//
// 本模块只含「纯逻辑 + DB 操作 + 进程内 SSE/长轮询 hub」，不直接读写 HTTP 响应头；
// http.js 负责路由/鉴权头解析/响应序列化（SSE 头与事件写入的薄封装由本模块导出）。

import crypto from 'node:crypto';
import { hashToken, audit } from './auth.js';

const LEASE_SECONDS = 90; // ⚠️ runner §4.2（待决策者确认）
const REAPER_INTERVAL_MS = 15000; // run 租约 reaper 扫描间隔（lease 90s 的 1/6，schema.sql §8 注释）
const HOLD_MS_MAX = 30000; // claim 长轮询 hold 上限
const MAX_EVENTS_PER_BATCH = 200; // runner §7.2
const MAX_EVENTS_BYTES = 256 * 1024; // runner §7.2
const MAX_ROUND_BYTES = 1024 * 1024; // portal.md §9.7

/** internal 通道统一错误（http.js 映射为标准错误信封，portal.md §9.13）。 */
export class InternalError extends Error {
  constructor(status, code, message, { retryable = false, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/** 规范化 JSON（键递归排序）——幂等 body hash 的稳定输入（portal.md §9.6/§9.7）。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/** 规范化 JSON 的 sha256 hex（幂等命中判定）。 */
export function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 校验 client_event_id 格式：run_id:attempt:计数（attempt/计数为非负整数）。 */
export function isValidClientEventId(runId, clientEventId) {
  if (typeof clientEventId !== 'string') return false;
  const rest = clientEventId.slice(runId.length + 1);
  if (!clientEventId.startsWith(`${runId}:`)) return false;
  const [attempt, counter] = rest.split(':');
  return (
    /^\d+$/.test(attempt || '') &&
    /^\d+$/.test(counter || '') &&
    Number.isSafeInteger(Number(attempt)) &&
    Number.isSafeInteger(Number(counter))
  );
}

/** run 状态机合法转换表（portal.md §9.6）。终态不可回退；cancelling 不可回 running。 */
export function validateTransition(from, to) {
  return (
    (from === 'queued' && to === 'running') ||
    (from === 'running' && to === 'running') ||
    (from === 'running' && to === 'finished') ||
    (from === 'running' && to === 'failed') ||
    (from === 'cancelling' && to === 'finished') ||
    (from === 'cancelling' && to === 'failed')
  );
}

/** claim ticket 组装（纯函数，供单测）。resume = attempt > 1（方案 B）。 */
export function assembleTicket({ queueId, claimToken, leaseUntil, run, project, message, attempts }) {
  return {
    queue_id: queueId,
    claim_token: claimToken,
    lease_expires_at: leaseUntil instanceof Date ? leaseUntil.toISOString() : leaseUntil,
    run: {
      id: run.id,
      session_id: run.session_id,
      attempt: attempts,
      project: { name: project?.name ?? '', root_path: project?.root_path ?? '' },
      task: message?.content ?? '',
      message_id: message?.id ?? null,
      model: run.model ?? null,
      resume: attempts > 1,
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
    },
  };
}

/** 事件载荷合法性：payload 必须为 JSON 对象（portal.md §9.4）。 */
export function validateEventPayload(payload) {
  return payload !== null && typeof payload === 'object' && !Array.isArray(payload);
}

// ---------------------------------------------------------------------------
// 认证：per-container token（Authorization: Bearer <token>）
// ---------------------------------------------------------------------------

/**
 * 由 token 解出容器与属主。失配 → 401 token_invalid；吊销/已移除/用户禁用 → 401 token_revoked。
 * DB 只存 runner_token_hash（D1'），不存原文。
 */
export async function authenticateContainer(pool, token, { now = new Date() } = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InternalError(401, 'token_invalid', 'missing or invalid bearer token');
  }
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `SELECT c.id AS container_id, c.user_id, c.revoked_at, c.status AS container_status,
            c.fde_name, c.container_name, c.token_generation,
            u.login, u.status AS user_status
       FROM containers c
       JOIN users u ON u.id = c.user_id
      WHERE c.runner_token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows?.[0];
  if (!row) throw new InternalError(401, 'token_invalid', 'invalid token');
  if (row.revoked_at != null || row.container_status === 'removed' || row.user_status !== 'active') {
    throw new InternalError(401, 'token_revoked', 'token revoked');
  }
  return {
    container: {
      id: row.container_id,
      user_id: row.user_id,
      fde_name: row.fde_name,
      container_name: row.container_name,
    },
    user: { id: row.user_id, login: row.login },
  };
}

// ---------------------------------------------------------------------------
// 归属 / 租约校验辅助
// ---------------------------------------------------------------------------

/** 读 run + 归属校验（403 run_ownership_mismatch / 404 run_not_found）。 */
async function fetchRun(pool, runId, userId, { forUpdate = false } = {}) {
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const res = await pool.query(
    `SELECT r.id, r.session_id, r.status, r.cancel_requested_at, r.rounds, r.usage, r.error, r.termination,
            s.user_id, s.project_id
       FROM runs r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1${lock}`,
    [runId],
  );
  const row = res.rows?.[0];
  if (!row) throw new InternalError(404, 'run_not_found', 'run not found');
  if (row.user_id !== userId) {
    throw new InternalError(403, 'run_ownership_mismatch', 'run does not belong to this container');
  }
  return row;
}

/** 校验 X-Claim-Token 与当前有效租约一致（防 re-claim 后旧 agentd 双写，runner §6.4）。
 *  F1：同时要求 lease_until > now()（DB 时钟），过期租约一律 409 lease_lost，不得继续写。 */
async function assertClaimToken(pool, runId, claimToken) {
  const res = await pool.query(
    `SELECT claim_token, status FROM run_queue WHERE run_id = $1 AND lease_until > now()`,
    [runId],
  );
  const row = res.rows?.[0];
  if (!row || row.claim_token !== claimToken) {
    throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
  }
  return row;
}

function isTerminal(status) {
  return status === 'finished' || status === 'failed';
}

// ---------------------------------------------------------------------------
// U1 claim（长轮询领任务）
// ---------------------------------------------------------------------------

/** 单次原子认领（FOR UPDATE SKIP LOCKED，schema.sql §8 认领 SQL）。返回 ticket 或 null。 */
async function tryClaim(pool, { container, user, capacity, now = new Date() } = {}) {
  const claimToken = crypto.randomBytes(24).toString('base64url');
  const claimed = await pool.query(
    `UPDATE run_queue q
        SET status = 'claimed',
            claimed_at = now(),
            lease_until = now() + interval '${LEASE_SECONDS} seconds',
            owner_container_id = $1,
            claim_token = $2,
            attempts = attempts + 1
      WHERE q.id = (
        SELECT q2.id
          FROM run_queue q2
          JOIN runs r          ON r.id = q2.run_id
          JOIN chat_sessions s ON s.id = r.session_id
         WHERE s.user_id = $3
           AND r.status IN ('queued', 'running')          -- A2：cancelling/终态不可领
           AND q2.attempts < q2.max_attempts              -- 未达崩溃循环上限
           AND (q2.status = 'pending'
                OR (q2.status = 'claimed' AND q2.lease_until < now()))  -- 租约过期可重领
         ORDER BY q2.created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING q.id AS queue_id, q.run_id, q.claim_token, q.lease_until, q.attempts`,
    [container.id, claimToken, user.id],
  );
  const row = claimed.rows?.[0];
  if (!row) return null;

  const run = await pool.query(
    `SELECT r.id, r.session_id, s.model
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE r.id = $1`,
    [row.run_id],
  );
  const runRow = run.rows?.[0];
  if (!runRow) return null;

  const project = await pool.query(
    `SELECT name, root_path FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = $1)`,
    [runRow.session_id],
  );
  const message = await pool.query(
    `SELECT id, content, attachments FROM messages
      WHERE run_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    [row.run_id],
  );

  return assembleTicket({
    queueId: row.queue_id,
    claimToken: row.claim_token,
    leaseUntil: row.lease_until,
    run: { id: runRow.id, session_id: runRow.session_id, model: runRow.model },
    project: project.rows?.[0],
    message: message.rows?.[0],
    attempts: Number(row.attempts),
  });
}

// ---- 进程内长轮询唤醒 + SSE 下行 hub（单节点，规格 §10.2 同构） ----

const claimWaiters = new Map(); // userId -> Set<wake fn>
const sseClients = new Map(); // containerId -> { userId, res }

function waitForWakeup(userId, deadlineMs) {
  return new Promise((resolve) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return resolve();
    let settled = false;
    const timer = setTimeout(() => finish(), remaining);
    const wake = () => { clearTimeout(timer); finish(); };
    function finish() {
      if (settled) return;
      settled = true;
      const set = claimWaiters.get(userId);
      if (set) {
        set.delete(wake);
        if (set.size === 0) claimWaiters.delete(userId);
      }
      resolve();
    }
    let set = claimWaiters.get(userId);
    if (!set) {
      set = new Set();
      claimWaiters.set(userId, set);
    }
    set.add(wake);
  });
}

/** 入队后唤醒该用户的挂起 claim + 广播 run_assigned hint（runner §4.2/§4.3）。 */
export function notifyRunEnqueued(userId, hint = {}) {
  const set = claimWaiters.get(userId);
  if (set) for (const wake of [...set]) wake();
  for (const client of sseClients.values()) {
    if (client.userId === userId) writeSseEvent(client.res, 'run_assigned', hint);
  }
}

export function broadcastStopRequest(userId, data) {
  for (const client of sseClients.values()) {
    if (client.userId === userId) writeSseEvent(client.res, 'stop_request', data);
  }
}

export function broadcastApprovalDecision(userId, data) {
  for (const client of sseClients.values()) {
    if (client.userId === userId) writeSseEvent(client.res, 'approval_decision', data);
  }
}

export function broadcastRevoke(containerId, data) {
  const client = sseClients.get(containerId);
  if (!client) return;
  writeSseEvent(client.res, 'revoke', data);
  // F7：token 吊销后服务端主动关闭已建立的 SSE 连接（agentd 收到 revoke 即停领新任务并退出）。
  if (typeof client.res.end === 'function') client.res.end();
  sseClients.delete(containerId);
}

// ---- SSE 写封装 ----

export function sseHeaders() {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

export function writeSseEvent(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function writeSseComment(res, text) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: ${text}\n\n`);
}

export function registerSseClient(containerId, userId, res) {
  sseClients.set(containerId, { userId, res });
}

export function unregisterSseClient(containerId, res) {
  const client = sseClients.get(containerId);
  if (client && client.res === res) sseClients.delete(containerId);
}

/** 供单测观察当前 SSE 客户端/等待者数量（不暴露内部结构）。 */
export function hubStats() {
  return { sseClients: sseClients.size, claimWaiters: claimWaiters.size };
}

// ---------------------------------------------------------------------------
// U1 claim（含 hold 长轮询）
// ---------------------------------------------------------------------------

export async function claimRun(pool, { container, user, capacity = 1, holdMs = HOLD_MS_MAX, now = new Date() } = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
    throw new InternalError(400, 'validation_failed', 'capacity 越界（1..64）', { details: { field: 'capacity' } });
  }
  if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > HOLD_MS_MAX) {
    throw new InternalError(400, 'validation_failed', `hold_ms 越界（1..${HOLD_MS_MAX}）`, { details: { field: 'hold_ms' } });
  }

  const ticket = await tryClaim(pool, { container, user, capacity, now });
  if (ticket) {
    await audit(pool, { actorId: user.id, action: 'run.claim', target: ticket.run.id, details: { attempt: ticket.run.attempt } }).catch(() => {});
    return ticket;
  }

  const deadline = Date.now() + holdMs;
  await waitForWakeup(user.id, deadline);
  const retry = await tryClaim(pool, { container, user, capacity, now });
  if (retry) {
    await audit(pool, { actorId: user.id, action: 'run.claim', target: retry.run.id, details: { attempt: retry.run.attempt } }).catch(() => {});
    return retry;
  }
  return null;
}

// ---------------------------------------------------------------------------
// U2 run 状态收敛（markRunState + 终态）
// ---------------------------------------------------------------------------

export async function setRunState(pool, { container, user, runId, claimToken, body }) {
  const state = body?.state;
  if (state !== 'running' && state !== 'finished' && state !== 'failed') {
    throw new InternalError(400, 'validation_failed', 'state 必须为 running/finished/failed', { details: { field: 'state' } });
  }

  const run = await fetchRun(pool, runId, user.id);
  if (isTerminal(run.status)) {
    // F4：终态幂等重放——相同终态载荷返回 200（响应丢失后重试安全）；载荷不同才 409 run_terminal。
    if (state === run.status && (await terminalPayloadMatches(pool, run, body))) {
      return { state: run.status, idempotent: true };
    }
    throw new InternalError(409, 'run_terminal', 'run already terminal');
  }

  if (state === 'running') {
    if (!validateTransition(run.status, 'running')) {
      throw new InternalError(409, 'invalid_transition', `invalid transition ${run.status} -> running`, {
        details: { from: run.status, to: 'running' },
      });
    }
    await assertClaimToken(pool, runId, claimToken);
    const upd = await pool.query(
      `UPDATE runs r
          SET status = 'running', started_at = COALESCE(r.started_at, now())
         FROM run_queue q
        WHERE r.id = $1 AND q.run_id = r.id AND q.claim_token = $2
          AND q.lease_until > now()
          AND r.status IN ('queued','running')`,
      [runId, claimToken],
    );
    // F6：CAS 查影响行数——伪造/过期 token 竞态下 0 行生效不得返回成功。
    if (upd.rowCount === 0) {
      throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
    }
    return { state: 'running' };
  }

  return finishRun(pool, { user, run, runId, claimToken, state, body });
}

/** F4：终态载荷一致判定（同 termination/error/rounds/usage/final_text → 幂等成功）。 */
async function terminalPayloadMatches(pool, run, body) {
  const stored = {
    termination: run.termination ?? null,
    error: run.error ?? null,
    rounds: run.rounds ?? 0,
    usage: run.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
  const incoming = {
    termination: body?.termination ?? null,
    error: body?.error ?? null,
    rounds: body?.rounds ?? 0,
    usage: body?.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
  // M4：final_text 落在 messages（assistant、synthetic=false）而非 runs 行——
  // 幂等重放需一并比对，否则不同 final_text 的重放会被误判为幂等成功。
  const msg = await pool.query(
    `SELECT content FROM messages
      WHERE run_id = $1 AND role = 'assistant' AND synthetic = false
      ORDER BY seq DESC LIMIT 1`,
    [run.id],
  );
  stored.final_text = msg.rows?.[0]?.content ?? '';
  incoming.final_text = typeof body?.final_text === 'string' ? body.final_text : '';
  return canonicalHash(stored) === canonicalHash(incoming);
}

/** 终态收敛事务（runner §7.6 加锁顺序：锁 run → 校验租约 → 写终态 → queue 收敛 → messages/usage/run_end）。 */
async function finishRun(pool, { user, runId, claimToken, state, body }) {
  const termination = body.termination;
  const usage = body.usage;
  const rounds = body.rounds;
  const finalText = body.final_text;
  const error = body.error ?? null;

  if (!termination || typeof termination !== 'object' || !termination.reason) {
    throw new InternalError(400, 'validation_failed', '终态载荷缺 termination.reason');
  }
  if (usage !== undefined && usage !== null && typeof usage !== 'object') {
    throw new InternalError(400, 'validation_failed', 'usage 必须为对象');
  }
  if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 0)) {
    throw new InternalError(400, 'validation_failed', 'rounds 必须为非负整数');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runRow = await client.query(`SELECT id, session_id, status FROM runs WHERE id = $1 FOR UPDATE`, [runId]);
    const r = runRow.rows?.[0];
    if (!r) throw new InternalError(404, 'run_not_found', 'run not found');
    if (isTerminal(r.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
    if (!validateTransition(r.status, state)) {
      throw new InternalError(409, 'invalid_transition', `invalid transition ${r.status} -> ${state}`, {
        details: { from: r.status, to: state },
      });
    }
    const q = await client.query(`SELECT claim_token, attempts FROM run_queue WHERE run_id = $1 AND lease_until > now() FOR UPDATE`, [runId]);
    if (!q.rows?.[0] || q.rows[0].claim_token !== claimToken) {
      throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
    }

    const payload = {
      termination,
      usage: usage ?? { input_tokens: 0, output_tokens: 0 },
      rounds: rounds ?? 0,
      attempt: Number(q.rows[0].attempts),
    };
    if (error) payload.error = error;
    if (state === 'failed') payload.error = error ?? { code: 'internal', message: 'run failed', retryable: false };

    const queueStatus = r.status === 'cancelling' ? 'cancelled' : 'done';
    await client.query(
      `UPDATE runs SET status = $2, termination = $3, usage = $4, rounds = $5, error = $6, ended_at = now()
        WHERE id = $1`,
      [runId, state, JSON.stringify(termination), JSON.stringify(usage ?? { input_tokens: 0, output_tokens: 0 }), rounds ?? 0, error ? JSON.stringify(error) : null],
    );
    await client.query(
      `UPDATE run_queue SET status = $2, claim_token = NULL, owner_container_id = NULL, lease_until = NULL, claimed_at = NULL
        WHERE run_id = $1`,
      [runId, queueStatus],
    );

    // 回写 assistant 消息（人看的对话层，§9.6）。
    if (typeof finalText === 'string' && finalText.length > 0) {
      const seq = await allocSeq(client, r.session_id);
      await client.query(
        `INSERT INTO messages (session_id, run_id, seq, role, content, synthetic)
         VALUES ($1, $2, $3, 'assistant', $4, false)`,
        [r.session_id, runId, seq, finalText],
      );
    }

    // 用量台账（source='erix'，一 run 一条，§9.9）。
    if (usage) {
      await client.query(
        `INSERT INTO usage_ledger (user_id, project_id, run_id, source, input_tokens, output_tokens, day)
         VALUES ($1, (SELECT project_id FROM chat_sessions WHERE id = $2), $3, 'erix', $4, $5, (now() AT TIME ZONE 'utc')::date)
         ON CONFLICT DO NOTHING`,
        [user.id, r.session_id, runId, Number(usage.input_tokens ?? 0) || 0, Number(usage.output_tokens ?? 0) || 0],
      );
    }

    // 合成 run_end 事件（run 内最后一条，§7.6）。client_event_id 与 worker 事件命名空间不碰撞。
    const runEndSeq = await allocSeq(client, r.session_id);
    await client.query(
      `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
       VALUES ($1, $2, $3, $4, 'run_end', $5, now())
       ON CONFLICT (run_id, client_event_id) DO NOTHING`,
      [runId, r.session_id, runEndSeq, `${runId}:final:run_end`, JSON.stringify(payload)],
    );

    await client.query('COMMIT');
    await audit(pool, { actorId: user.id, action: 'run.finish', target: runId, details: { state, queue_status: queueStatus } }).catch(() => {});
    return { state, queue_status: queueStatus, run_end_seq: runEndSeq };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** seq 分配器：单行 chat_sessions.last_seq +1（§7.3 统一口径；messages 与 run_events 共享）。 */
async function allocSeq(client, sessionId) {
  const res = await client.query(
    `UPDATE chat_sessions SET last_seq = last_seq + 1, updated_at = now() WHERE id = $1 RETURNING last_seq`,
    [sessionId],
  );
  return Number(res.rows[0].last_seq);
}

// ---------------------------------------------------------------------------
// U3 事件批量上报
// ---------------------------------------------------------------------------

export async function postEvents(pool, { container, user, runId, claimToken, body }) {
  const events = body?.events;
  if (!Array.isArray(events) || events.length > MAX_EVENTS_PER_BATCH) {
    throw new InternalError(400, 'validation_failed', `events 必须为数组且 ≤ ${MAX_EVENTS_PER_BATCH}`, { details: { field: 'events' } });
  }
  if (body.batch_id !== undefined && (typeof body.batch_id !== 'string' || body.batch_id.length > 128)) {
    throw new InternalError(400, 'validation_failed', 'batch_id 非法', { details: { field: 'batch_id' } });
  }
  const bytes = Buffer.byteLength(JSON.stringify(body.events ?? []), 'utf8');
  if (bytes > MAX_EVENTS_BYTES) {
    throw new InternalError(400, 'validation_failed', '事件批超过 256KB 上限');
  }
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string' || !ev.type) {
      throw new InternalError(400, 'validation_failed', 'event.type 必填', { details: { field: 'events[].type' } });
    }
    if (!validateEventPayload(ev.payload)) {
      throw new InternalError(400, 'validation_failed', 'event.payload 必须为对象', { details: { field: 'events[].payload' } });
    }
    if (!isValidClientEventId(runId, ev.client_event_id)) {
      throw new InternalError(400, 'validation_failed', 'client_event_id 格式非法（run_id:attempt:计数）', {
        details: { field: 'events[].client_event_id' },
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const run = await client.query(
      `SELECT r.id, r.session_id, r.status, s.user_id
         FROM runs r JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 FOR UPDATE`,
      [runId],
    );
    const r = run.rows?.[0];
    if (!r) throw new InternalError(404, 'run_not_found', 'run not found');
    if (r.user_id !== user.id) throw new InternalError(403, 'run_ownership_mismatch', 'run does not belong to this container');
    if (isTerminal(r.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
    const q = await client.query(`SELECT claim_token FROM run_queue WHERE run_id = $1 AND lease_until > now()`, [runId]);
    if (!q.rows?.[0] || q.rows[0].claim_token !== claimToken) {
      throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
    }

    let stored = 0;
    let seqFirst = null;
    let seqLast = null;
    for (const ev of events) {
      // 先查重再分配 seq：重复事件不消耗 seq（§7.3 严格递增、无空洞）。
      const dup = await client.query(`SELECT 1 FROM run_events WHERE run_id = $1 AND client_event_id = $2`, [runId, ev.client_event_id]);
      if (dup.rows.length > 0) continue;
      const seq = await allocSeq(client, r.session_id);
      const ins = await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
         ON CONFLICT (run_id, client_event_id) DO NOTHING
         RETURNING id`,
        [runId, r.session_id, seq, ev.client_event_id, ev.type, JSON.stringify(ev.payload), ev.ts ?? null],
      );
      if (ins.rows.length > 0) {
        stored += 1;
        if (seqFirst === null) seqFirst = seq;
        seqLast = seq;
      }
    }

    // tool_calls 行由 portal 在 U3 对 tool_use 事件幂等 upsert（portal.md §9.10）。
    for (const ev of events) {
      if (ev.type !== 'tool_use') continue;
      await client.query(
        `INSERT INTO tool_calls (run_id, call_id, round, name, input)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (run_id, call_id) DO NOTHING`,
        [runId, ev.payload?.tool_call_id, Number(ev.payload?.round ?? 0) || 0, ev.payload?.name ?? '', JSON.stringify(ev.payload?.input ?? {})],
      );
    }

    await client.query('COMMIT');
    return { stored, seq_first: seqFirst, seq_last: seqLast };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// U4 heartbeat（租约续期 + stop 兜底 + 容器级 revoked）
// ---------------------------------------------------------------------------

export async function heartbeat(pool, { container, user, body }) {
  const runs = body?.runs ?? [];
  if (!Array.isArray(runs)) {
    throw new InternalError(400, 'validation_failed', 'runs 必须为数组', { details: { field: 'runs' } });
  }
  for (const r of runs) {
    if (!r || typeof r.run_id !== 'string' || !r.run_id) {
      throw new InternalError(400, 'validation_failed', 'runs[].run_id 必填');
    }
    if (typeof r.claim_token !== 'string' || !r.claim_token) {
      throw new InternalError(400, 'validation_failed', 'runs[].claim_token 必填');
    }
  }

  await pool.query(
    `UPDATE containers
        SET last_heartbeat = now(),
            status = CASE WHEN status IN ('creating','stopped','exited') THEN 'running' ELSE status END,
            updated_at = now()
      WHERE id = $1`,
    [container.id],
  );

  const now = new Date();
  const results = [];
  for (const r of runs) {
    const row = await pool.query(`SELECT claim_token, status, lease_until FROM run_queue WHERE run_id = $1`, [r.run_id]);
    const q = row.rows?.[0];
    if (!q) {
      results.push({ run_id: r.run_id, lease: 'lease_lost', reason: 'terminal' });
      continue;
    }
    if (q.claim_token !== r.claim_token) {
      const reason = q.status === 'claimed' ? 'reclaimed' : q.status === 'pending' ? 'released' : 'terminal';
      results.push({ run_id: r.run_id, lease: 'lease_lost', reason });
      continue;
    }
    // F1：token 匹配但租约已过期 → 不得续期，返回 lease_lost（agentd 应 re-claim）。
    if (!q.lease_until || new Date(q.lease_until).getTime() <= Date.now()) {
      results.push({ run_id: r.run_id, lease: 'lease_lost', reason: 'expired' });
      continue;
    }
    const renewed = await pool.query(
      `UPDATE run_queue SET lease_until = now() + interval '${LEASE_SECONDS} seconds'
        WHERE run_id = $1 AND claim_token = $2 AND lease_until > now() RETURNING lease_until`,
      [r.run_id, r.claim_token],
    );
    if (renewed.rows.length === 0) {
      results.push({ run_id: r.run_id, lease: 'lease_lost', reason: 'expired' });
      continue;
    }
    results.push({ run_id: r.run_id, lease: 'renewed', lease_until: renewed.rows?.[0]?.lease_until ?? null });
  }

  let stopRunIds = [];
  if (runs.length > 0) {
    const stop = await pool.query(
      `SELECT id FROM runs WHERE id = ANY($1::uuid[]) AND cancel_requested_at IS NOT NULL AND status = 'cancelling'`,
      [runs.map((r) => r.run_id)],
    );
    stopRunIds = stop.rows.map((r) => r.id);
  }

  return { now: now.toISOString(), stop_run_ids: stopRunIds, revoked: false, runs: results };
}

// ---------------------------------------------------------------------------
// U5/U6/U7 transcript rounds
// ---------------------------------------------------------------------------

export async function putRound(pool, { container, user, runId, round, claimToken, body }) {
  if (!Number.isInteger(round) || round < 0) {
    throw new InternalError(400, 'validation_failed', 'round 必须为非负整数');
  }
  const dedupKey = body?.dedupKey;
  if (typeof dedupKey !== 'string' || dedupKey.length === 0 || dedupKey.length > 256) {
    throw new InternalError(400, 'validation_failed', 'dedupKey 必填且 ≤256 字符');
  }
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes > MAX_ROUND_BYTES) {
    throw new InternalError(400, 'validation_failed', 'round 请求体超过 1MB 上限');
  }

  const run = await fetchRun(pool, runId, user.id);
  if (isTerminal(run.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
  await assertClaimToken(pool, runId, claimToken);

  const record = body;
  const folded = body.folded === true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const foldedPayload = body.foldedPayload ?? null;

  const inserted = await pool.query(
    `INSERT INTO transcript_rounds (run_id, round, record, folded, messages, folded_payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (run_id, round) DO NOTHING
     RETURNING id`,
    [runId, round, JSON.stringify(record), folded, JSON.stringify(messages), foldedPayload ? JSON.stringify(foldedPayload) : null],
  );
  if (inserted.rows.length > 0) return { inserted: true };

  const existing = await pool.query(`SELECT record, folded FROM transcript_rounds WHERE run_id = $1 AND round = $2`, [runId, round]);
  const ex = existing.rows?.[0];
  if (!ex) return { inserted: true }; // 理论上不可达（并发已由 ON CONFLICT 序列化）

  if (ex.record?.dedupKey !== dedupKey) {
    throw new InternalError(409, 'round_conflict', '同 round 已存在且 dedupKey 不同', { details: { round } });
  }
  if (canonicalHash(ex.record) === canonicalHash(record)) {
    return { inserted: false }; // 幂等命中
  }
  // fold 更新：同 dedupKey、folded false→true 视为合法 UPDATE（runner §9.3）。
  if (folded && ex.folded === false) {
    await pool.query(
      `UPDATE transcript_rounds SET record = $3, folded = true, messages = $4, folded_payload = $5
        WHERE run_id = $1 AND round = $2`,
      [runId, round, JSON.stringify(record), JSON.stringify(messages), foldedPayload ? JSON.stringify(foldedPayload) : null],
    );
    return { inserted: true };
  }
  throw new InternalError(409, 'round_conflict', '同 round 已存在且 body 不同', { details: { round } });
}

export async function getTranscript(pool, { container, user, runId, claimToken, limit = 10000, cursor = null }) {
  const run = await fetchRun(pool, runId, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, runId, claimToken);

  const lim = Math.min(Math.max(1, Number(limit) || 10000), 10000);
  const cur = cursor == null ? -1 : Number(cursor);
  const res = await pool.query(
    `SELECT round, record FROM transcript_rounds
      WHERE run_id = $1 AND round > $2
      ORDER BY round ASC LIMIT $3`,
    [runId, cur, lim],
  );
  const records = res.rows.map((r) => ({ round: Number(r.round), ...r.record }));
  const nextCursor = records.length > 0 ? records[records.length - 1].round : null;
  return { records, next_cursor: nextCursor };
}

export async function recallTranscript(pool, { container, user, runId, claimToken, fromRound = 0, toRound = null, pattern }) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 256) {
    throw new InternalError(400, 'validation_failed', 'pattern 必填且 ≤256 字符');
  }
  if (!Number.isInteger(fromRound) || fromRound < 0) {
    throw new InternalError(400, 'validation_failed', 'from_round 必须为非负整数');
  }
  if (toRound !== null && toRound !== undefined && (!Number.isInteger(toRound) || toRound < fromRound)) {
    throw new InternalError(400, 'validation_failed', 'to_round 必须 ≥ from_round');
  }
  const run = await fetchRun(pool, runId, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, runId, claimToken);

  const to = toRound == null ? 2147483647 : toRound;
  const res = await pool.query(
    `SELECT round, record, folded_payload FROM transcript_rounds
      WHERE run_id = $1 AND round BETWEEN $2 AND $3
      ORDER BY round ASC LIMIT 2000`,
    [runId, fromRound, to],
  );
  const hits = [];
  let matchedRounds = 0;
  for (const row of res.rows) {
    const text = collectRoundText(row);
    if (text.includes(pattern)) {
      hits.push(text);
      matchedRounds += 1;
      if (hits.join('\n').length >= 1024 * 1024) break;
    }
  }
  const text = hits.join('\n');
  const truncated = hits.join('\n').length >= 1024 * 1024 || res.rows.length >= 2000;
  return { text, truncated, matched_rounds: matchedRounds };
}

function collectRoundText(row) {
  const parts = [];
  const msgs = row.record?.messages;
  if (Array.isArray(msgs)) {
    for (const m of msgs) if (typeof m?.content === 'string') parts.push(m.content);
  }
  if (row.folded_payload && typeof row.folded_payload === 'object') {
    parts.push(JSON.stringify(row.folded_payload));
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// U8/U9 checkpoint
// ---------------------------------------------------------------------------

export async function putCheckpoint(pool, { container, user, runId, claimToken, body }) {
  const revision = body?.revision;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new InternalError(400, 'validation_failed', 'revision 必须为非负整数');
  }
  if (!body?.snapshot || typeof body.snapshot !== 'object' || Array.isArray(body.snapshot)) {
    throw new InternalError(400, 'validation_failed', 'snapshot 必须为对象');
  }
  const run = await fetchRun(pool, runId, user.id);
  if (isTerminal(run.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
  await assertClaimToken(pool, runId, claimToken);

  const res = await pool.query(
    `INSERT INTO run_checkpoints (run_id, snapshot, revision, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (run_id) DO UPDATE
       SET snapshot = EXCLUDED.snapshot, revision = EXCLUDED.revision, updated_at = now()
       WHERE run_checkpoints.revision < EXCLUDED.revision
     RETURNING revision`,
    [runId, JSON.stringify(body.snapshot), revision],
  );
  if (res.rows.length === 0) {
    throw new InternalError(409, 'checkpoint_stale', 'checkpoint revision 不大于当前（CAS 拒绝）');
  }
  return { revision: Number(res.rows[0].revision) };
}

export async function getLatestCheckpoint(pool, { container, user, runId, claimToken }) {
  const run = await fetchRun(pool, runId, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, runId, claimToken);

  const res = await pool.query(`SELECT snapshot, revision, updated_at FROM run_checkpoints WHERE run_id = $1`, [runId]);
  const row = res.rows?.[0];
  if (!row) return null;
  return { checkpoint: { snapshot: row.snapshot, revision: Number(row.revision), updated_at: row.updated_at } };
}

// ---------------------------------------------------------------------------
// U10/U11 approvals
// ---------------------------------------------------------------------------

export async function createApproval(pool, { container, user, runId, claimToken, body }) {
  const toolCallId = body?.tool_call_id;
  const name = body?.name;
  if (typeof toolCallId !== 'string' || !toolCallId || typeof name !== 'string' || !name) {
    throw new InternalError(400, 'validation_failed', 'tool_call_id 与 name 必填');
  }
  const run = await fetchRun(pool, runId, user.id);
  if (isTerminal(run.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
  await assertClaimToken(pool, runId, claimToken);

  const tc = await pool.query(`SELECT 1 FROM tool_calls WHERE run_id = $1 AND call_id = $2`, [runId, toolCallId]);
  if (!tc.rows?.[0]) {
    throw new InternalError(400, 'validation_failed', 'tool_call_id 无对应 tool_calls 行');
  }

  const ins = await pool.query(
    `INSERT INTO approvals (run_id, tool_call_id, status) VALUES ($1, $2, 'pending')
     ON CONFLICT (run_id, tool_call_id) DO NOTHING RETURNING id`,
    [runId, toolCallId],
  );
  if (ins.rows.length > 0) {
    await audit(pool, { actorId: user.id, action: 'approval.create', target: ins.rows[0].id, details: { run_id: runId, tool_call_id: toolCallId } }).catch(() => {});
    return { status: 201, approval_id: ins.rows[0].id };
  }
  const existing = await pool.query(`SELECT id FROM approvals WHERE run_id = $1 AND tool_call_id = $2`, [runId, toolCallId]);
  return { status: 200, approval_id: existing.rows[0].id };
}

export async function getApproval(pool, { container, user, approvalId, claimToken }) {
  const res = await pool.query(
    `SELECT a.id, a.status, a.decided_by, a.decided_at, a.expired_at, a.note, a.run_id, u.login AS decided_by_login
       FROM approvals a
       LEFT JOIN users u ON u.id = a.decided_by
      WHERE a.id = $1`,
    [approvalId],
  );
  const row = res.rows?.[0];
  if (!row) throw new InternalError(404, 'approval_not_found', 'approval not found');
  const run = await fetchRun(pool, row.run_id, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, row.run_id, claimToken);

  const out = { status: row.status };
  if (row.status === 'approved' || row.status === 'denied') {
    out.decided_by = row.decided_by_login;
    out.decided_at = row.decided_at;
    out.note = row.note ?? undefined;
  }
  if (row.status === 'expired') out.expired_at = row.expired_at;
  return out;
}

// ---------------------------------------------------------------------------
// U12 release（主动放弃已领任务）
// ---------------------------------------------------------------------------

export async function releaseRun(pool, { container, user, runId, claimToken, body }) {
  const reason = body?.reason;
  if (typeof reason !== 'string' || reason.length === 0 || reason.length > 64) {
    throw new InternalError(400, 'validation_failed', 'reason 必填且 ≤64 字符');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const runRow = await client.query(
      `SELECT r.id, r.session_id, r.status, s.user_id
         FROM runs r JOIN chat_sessions s ON s.id = r.session_id
        WHERE r.id = $1 FOR UPDATE`,
      [runId],
    );
    const r = runRow.rows?.[0];
    if (!r) throw new InternalError(404, 'run_not_found', 'run not found');
    if (r.user_id !== user.id) throw new InternalError(403, 'run_ownership_mismatch', 'run does not belong to this container');

    const q = await client.query(
      `SELECT status, attempts, max_attempts, claim_token, lease_until FROM run_queue WHERE run_id = $1 FOR UPDATE`,
      [runId],
    );
    const qrow = q.rows?.[0];
    if (!qrow) throw new InternalError(404, 'run_not_found', 'run not found');
    if (qrow.claim_token !== claimToken) {
      throw new InternalError(409, 'lease_lost', 'claim token mismatch (run reclaimed)');
    }

    // F5：幂等重放——claim_token 匹配但已非 claimed（首次 release 已收敛）→ 返回首次结果。
    if (qrow.status !== 'claimed') {
      const replay = replayReleaseResult(qrow.status, r.status, qrow);
      await client.query('COMMIT');
      return { run_id: runId, ...replay };
    }

    // F1：租约 fencing——仍 claimed 但租约过期 → 409 lease_lost（不处理）。
    if (!qrow.lease_until || new Date(qrow.lease_until).getTime() <= Date.now()) {
      throw new InternalError(409, 'lease_lost', 'lease expired');
    }
    if (isTerminal(r.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');

    let outcome;
    let runStatus;
    let queueStatus;
    // 注意：release 后保留 claim_token（供幂等重放识别），fencing 由 lease_until 清空保证（旧 token 无法续租/写）。
    if (qrow.status === 'cancelled' || r.status === 'cancelling') {
      await client.query(`UPDATE run_queue SET status='cancelled', owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
      await client.query(`UPDATE runs SET status='finished', termination='{"reason":"aborted"}'::jsonb, ended_at=now() WHERE id=$1`, [runId]);
      outcome = 'cancelled';
      runStatus = 'finished';
      queueStatus = 'cancelled';
      const runEndSeq = await allocSeq(client, r.session_id);
      await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [runId, r.session_id, runEndSeq, `${runId}:final:run_end`,
          JSON.stringify({ termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts) })],
      );
    } else if (Number(qrow.attempts) < Number(qrow.max_attempts)) {
      await client.query(`UPDATE run_queue SET status='pending', owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
      await client.query(`UPDATE runs SET status='queued' WHERE id=$1`, [runId]);
      outcome = 'requeued';
      runStatus = 'queued';
      queueStatus = 'pending';
    } else {
      await client.query(`UPDATE run_queue SET status='done', owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
      await client.query(
        `UPDATE runs SET status='failed', error='{"code":"max_attempts_exceeded","message":"attempts exhausted","retryable":false}'::jsonb, ended_at=now() WHERE id=$1`,
        [runId],
      );
      outcome = 'failed_max_attempts';
      runStatus = 'failed';
      queueStatus = 'done';
      const runEndSeq = await allocSeq(client, r.session_id);
      await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [runId, r.session_id, runEndSeq, `${runId}:final:run_end`,
          JSON.stringify({ termination: null, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts),
            error: { code: 'max_attempts_exceeded', message: 'attempts exhausted', retryable: false } })],
      );
    }

    await client.query('COMMIT');
    await audit(pool, { actorId: user.id, action: 'run.release', target: runId, details: { reason, outcome } }).catch(() => {});
    return {
      run_id: runId,
      run_status: runStatus,
      queue_status: queueStatus,
      attempts: Number(qrow.attempts),
      max_attempts: Number(qrow.max_attempts),
      outcome,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** F5：由 queue 状态重建首次 release 的结果（幂等重放）。 */
function replayReleaseResult(queueStatus, runStatus, qrow) {
  const attempts = Number(qrow.attempts);
  const maxAttempts = Number(qrow.max_attempts);
  if (queueStatus === 'cancelled') {
    return { run_status: 'finished', queue_status: 'cancelled', attempts, max_attempts: maxAttempts, outcome: 'cancelled' };
  }
  if (queueStatus === 'done') {
    return { run_status: 'failed', queue_status: 'done', attempts, max_attempts: maxAttempts, outcome: 'failed_max_attempts' };
  }
  return { run_status: runStatus ?? 'queued', queue_status: 'pending', attempts, max_attempts: maxAttempts, outcome: 'requeued' };
}

// ---------------------------------------------------------------------------
// run 租约 reaper（runner §6.4/§12；schema.sql §8 注释）
// ---------------------------------------------------------------------------

function sleepReaper(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 单次 reaper 扫描：把 lease_until 过期的 claimed 行按矩阵收敛。
 *   ① cancelling（用户已 stop 但容器死）→ queue cancelled + runs finished（aborted，A2）；
 *   ② attempts >= max_attempts → queue done + runs failed(max_attempts_exceeded)（A1 耗尽）；
 *   ③ attempts < max_attempts → 回 pending（attempts 不变，claim 时已 +1）。
 * 终态分支（①/②）同事务合成 run_end（F3 口径，runner §7.6）。
 * @returns {Array<{run_id, outcome, run_status}>}
 */
export async function reapExpiredRuns(pool) {
  const candidates = await pool.query(
    `SELECT q.run_id, q.attempts, q.max_attempts, r.status, r.session_id
       FROM run_queue q JOIN runs r ON r.id = q.run_id
      WHERE q.status = 'claimed' AND q.lease_until < now()`,
  );
  const results = [];
  for (const c of candidates.rows ?? []) {
    const runId = c.run_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const runRow = await client.query(`SELECT id, session_id, status FROM runs WHERE id = $1 FOR UPDATE`, [runId]);
      const r = runRow.rows?.[0];
      if (!r) {
        await client.query('ROLLBACK');
        continue;
      }
      const q = await client.query(
        `SELECT status, attempts, max_attempts, lease_until FROM run_queue WHERE run_id = $1 FOR UPDATE`,
        [runId],
      );
      const qrow = q.rows?.[0];
      // 双检：仍在 claimed 且租约确实过期（防与心跳续租竞态）。
      if (!qrow || qrow.status !== 'claimed' || !qrow.lease_until || new Date(qrow.lease_until).getTime() >= Date.now()) {
        await client.query('ROLLBACK');
        continue;
      }

      if (r.status === 'cancelling') {
        await client.query(`UPDATE run_queue SET status='cancelled', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
        await client.query(`UPDATE runs SET status='finished', termination='{"reason":"aborted"}'::jsonb, ended_at=now() WHERE id=$1`, [runId]);
        const runEndSeq = await allocSeq(client, r.session_id);
        await client.query(
          `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
           VALUES ($1, $2, $3, $4, 'run_end', $5, now())
           ON CONFLICT (run_id, client_event_id) DO NOTHING`,
          [runId, r.session_id, runEndSeq, `${runId}:final:run_end`,
            JSON.stringify({ termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts) })],
        );
        results.push({ run_id: runId, outcome: 'cancelled', run_status: 'finished' });
      } else if (Number(qrow.attempts) >= Number(qrow.max_attempts)) {
        await client.query(`UPDATE run_queue SET status='done', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
        await client.query(
          `UPDATE runs SET status='failed', error='{"code":"max_attempts_exceeded","message":"attempts exhausted","retryable":false}'::jsonb, ended_at=now() WHERE id=$1`,
          [runId],
        );
        const runEndSeq = await allocSeq(client, r.session_id);
        await client.query(
          `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
           VALUES ($1, $2, $3, $4, 'run_end', $5, now())
           ON CONFLICT (run_id, client_event_id) DO NOTHING`,
          [runId, r.session_id, runEndSeq, `${runId}:final:run_end`,
            JSON.stringify({ termination: null, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts),
              error: { code: 'max_attempts_exceeded', message: 'attempts exhausted', retryable: false } })],
        );
        results.push({ run_id: runId, outcome: 'failed_max_attempts', run_status: 'failed' });
      } else {
        await client.query(`UPDATE run_queue SET status='pending', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
        await client.query(`UPDATE runs SET status='queued' WHERE id=$1`, [runId]);
        results.push({ run_id: runId, outcome: 'requeued', run_status: 'queued' });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return results;
}

/** 启动 run 租约 reaper 常驻循环（由 cli serve 调用）。 */
export function startReaperLoop(pool, { intervalMs = REAPER_INTERVAL_MS, log = console } = {}) {
  let stopped = false;
  (async () => {
    while (!stopped) {
      try {
        await reapExpiredRuns(pool);
      } catch (err) {
        log.warn?.(`[reaper] loop error: ${err.message}`);
      }
      await sleepReaper(intervalMs);
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
