// portal 侧 internal API：容器（agentd）→ portal 的全出站通道（runner-integration §4）。
// 依据：docs/design/runner-integration.md §4/§6/§7/§9、docs/api/portal.md §9、docs/data/schema.sql。
// 三条不变式落地：容器不直连 DB（本模块是唯一写方）、DB 是状态真相、ingress 是唯一入口
//   （internal 经 Traefik Host+PathPrefix+ipAllowList 回环到 portal，见 routes.js）。
//
// 本模块只含「纯逻辑 + DB 操作 + 进程内 SSE/长轮询 hub」，不直接读写 HTTP 响应头；
// http.js 负责路由/鉴权头解析/响应序列化（SSE 头与事件写入的薄封装由本模块导出）。

import crypto from 'node:crypto';
import { hashToken, audit } from './auth.js';
import { purgeExpired } from './idempotency.js';
import { allocSeq } from './seq.js';
import { getFdeLlmHeartbeatModels } from './llm.js';
import { scheduleAutoTitle, AGENT_TITLE_MAX_LEN } from './session-title.js';
import { fetchInputTextByMessageId, fetchRunAssistantText } from './session-text.js';

const LEASE_SECONDS = 90; // ⚠️ runner §4.2（待决策者确认）
const REAPER_INTERVAL_MS = 15000; // run 租约 reaper 扫描间隔（lease 90s 的 1/6，schema.sql §8 注释）
const IDEMPOTENCY_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 幂等键过期清理间隔（TTL 24h，1h 扫一次足够）
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

/** claim ticket 组装（纯函数，供单测）。resume = attempt > 1（方案 B）。
 *  P3 PR③（issue #69 下行退役）：ticket **不再带 `history`**——会话上下文唯一来源 = transcript resume
 *  （写侧：用户输入已在 POST 事务内由引擎 `appendUserTurn` 落树；读侧：正文真相 = transcript）。
 *  `run.task` 保留：空本子（引擎 round 0 种子）路径与 notes/标题仍需要它。
 *  P5 去项目化：run.cwd = 会话绑定 cwd（~/projects/<name> 相对形式）为权威下行；run.project 保留
 *  项目名/根路径快照仅为**旧 agentd** 过渡兼容（部署序 portal 先上、FDE 镜像后上，新 agentd 优先读
 *  run.cwd）。 */
export function assembleTicket({
  queueId, claimToken, leaseUntil, run, project, message, attempts, gitIdentity, baseDomain,
}) {
  const gitName = typeof gitIdentity?.display_name === 'string' && gitIdentity.display_name.length > 0
    ? gitIdentity.display_name
    : typeof gitIdentity?.login === 'string' && gitIdentity.login.length > 0
      ? gitIdentity.login
      : undefined;
  const gitEmail = typeof gitIdentity?.email === 'string' && gitIdentity.email.length > 0
    ? gitIdentity.email
    : typeof gitIdentity?.login === 'string' && gitIdentity.login.length > 0 &&
        typeof baseDomain === 'string' && baseDomain.length > 0
      ? `${gitIdentity.login}@${baseDomain}`
      : undefined;
  return {
    queue_id: queueId,
    claim_token: claimToken,
    lease_expires_at: leaseUntil instanceof Date ? leaseUntil.toISOString() : leaseUntil,
    run: {
      id: run.id,
      session_id: run.session_id,
      attempt: attempts,
      cwd: run.cwd ?? null,
      project: { name: project?.name ?? '', root_path: project?.root_path ?? '' },
      task: message?.content ?? '',
      message_id: message?.id ?? null,
      model: run.model ?? null,
      resume: attempts > 1,
      attachments: Array.isArray(message?.attachments) ? message.attachments : [],
      ...(gitName || gitEmail ? { git_identity: { name: gitName, email: gitEmail } } : {}),
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
            u.login, u.display_name, u.email, u.status AS user_status
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
    user: { id: row.user_id, login: row.login, display_name: row.display_name, email: row.email },
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
async function tryClaim(pool, { container, user, capacity, now = new Date(), baseDomain, log } = {}) {
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
    `SELECT r.id, r.session_id, s.model, s.cwd
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE r.id = $1`,
    [row.run_id],
  );
  const runRow = run.rows?.[0];
  if (!runRow) return null;

  // P5：cwd 为权威绑定；run.project 快照（目录名/根路径）供旧 agentd 过渡兼容。
  const projectName = typeof runRow.cwd === 'string'
    ? runRow.cwd.replace(/^~\/projects\//, '')
    : '';
  const project = {
    name: projectName,
    root_path: typeof runRow.cwd === 'string' ? runRow.cwd : '',
  };
  // P3 PR②b B1 ④（**运行关键路径**）：ticket 的 task 文本改从 transcript 输入行取
  // （dedupKey = `<sessionId>:input:<messageId>` 单行精确命中）。回退顺序（写死在此）：
  //   ① 输入行存在且投影有 user 正文 → 用它（新会话恒命中）；
  //   ② 取不到 → legacy 回退 `messages.content`（仅迁移 0015 之前入档的行；legacy-only，不用于新会话）；
  //   ③ 两者都空 → 空串（`assembleTicket` 既有 `?? ''` 语义，不阻断 claim）。
  // `attachments` 仍从 `messages` 取（附件是本平台自有元数据，不在 transcript 里）。
  const message = await pool.query(
    `SELECT id, content, attachments FROM messages
      WHERE run_id = $1 AND role = 'user' ORDER BY seq DESC LIMIT 1`,
    [row.run_id],
  );
  const currentMessage = message.rows?.[0] ?? null;
  let taskText = null;
  try {
    taskText = await fetchInputTextByMessageId(pool, {
      sessionId: runRow.session_id, messageId: currentMessage?.id,
    });
  } catch (err) {
    // 输入行查询异常同样走 ② legacy 回退（关键路径不因投影读失败而中断 claim）。
    log?.warn?.(`[internal] task transcript projection read failed, claim falls back to message anchor: ${String(err?.message ?? err)}`);
  }
  if (typeof taskText !== 'string' || taskText === '') {
    taskText = typeof currentMessage?.content === 'string' ? currentMessage.content : ''; // ② legacy-only
  }

  // P3 PR③（issue #69 下行退役）：此处原本查「session 最近 user/assistant 文本」拼成 ticket.history。
  // 已删：resume 路径下引擎本来忽略 initialMessages，而正常新会话必然走 resume（输入行已在 POST
  // 事务内落树），注入成为死重；thinking 模型还会因 `reasoning_content must be passed back` 被上游拒
  // （deploy/migrations/0007 头部实证）。会话上下文唯一来源 = transcript resume。

  return assembleTicket({
    queueId: row.queue_id,
    claimToken: row.claim_token,
    leaseUntil: row.lease_until,
    run: { id: runRow.id, session_id: runRow.session_id, model: runRow.model, cwd: runRow.cwd ?? null },
    project,
    message: { ...currentMessage, content: taskText },
    attempts: Number(row.attempts),
    gitIdentity: user,
    baseDomain,
  });
}

// ---- 进程内长轮询唤醒 + SSE 下行 hub（单节点，规格 §10.2 同构） ----

const claimWaiters = new Map(); // userId -> Set<wake fn>
const sseClients = new Map(); // containerId -> { userId, res }

// issue #180：`signal` 用于「客户端在响应写出前断开」时提前结束等待——否则旧 agentd 的悬挂请求会
// 在 reaper 重排队唤醒的瞬间为死连接领走 ticket（attempts+1、占租约），直到 90s 自然到期才恢复。
// signal 已在等待前 abort 也立即 resolve（不注册 waiter）。注册/清理语义不变，无泄漏。
function waitForWakeup(userId, deadlineMs, signal) {
  return new Promise((resolve) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0 || signal?.aborted) return resolve();
    let settled = false;
    const timer = setTimeout(() => finish(), remaining);
    const wake = () => finish();
    const onAbort = () => finish();
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      const set = claimWaiters.get(userId);
      if (set) {
        set.delete(wake);
        if (set.size === 0) claimWaiters.delete(userId);
      }
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
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

// ---- 浏览器侧 session SSE hub（portal.md §5；keyed by session，多客户端并存） ----
// 注册先于补发（防「补发查询→注册」窗口丢事件）：注册后先缓冲，补发完成后 flush（跳过已补发 seq）再转 live。
// 缓冲上限溢出不再静默丢弃（B 项，§5.1/§5.2）：写 `resync` 控制帧 + `res.end()` 让该客户端重连——
// 浏览器 EventSource 自动带 `Last-Event-ID`（或前端按 §5.2 用 `?last_event_id=` 重连），由 SSE handler 补发收敛。
const sessionClients = new Map(); // sessionId -> Set<clientRec>
export const SESSION_CLIENT_BUFFER_MAX = 1000;

export function registerSessionClient(sessionId, res) {
  let set = sessionClients.get(sessionId);
  if (!set) {
    set = new Set();
    sessionClients.set(sessionId, set);
  }
  const rec = { res, buffer: [], live: false, resync: false, lastSeq: null };
  set.add(rec);
  return rec;
}

/** 补发完成后调用：把缓冲中的事件（seq > sinceSeq）写给该客户端，随后转 live。 */
export function sessionClientGoLive(sessionId, rec, sinceSeq = null) {
  if (rec.resync) return; // 已判定需重同步（缓冲溢出）：连接已 end，不再 flush
  const events = rec.buffer.splice(0, rec.buffer.length);
  for (const ev of events) {
    if (sinceSeq != null && ev.seq <= sinceSeq) continue; // 补发已含
    writeSessionEvent(rec.res, ev, sessionId);
    rec.lastSeq = ev.seq;
  }
  rec.live = true;
}

export function unregisterSessionClient(sessionId, recOrRes) {
  const set = sessionClients.get(sessionId);
  if (!set) return;
  for (const rec of set) {
    if (rec === recOrRes || rec.res === recOrRes) set.delete(rec);
  }
  if (set.size === 0) sessionClients.delete(sessionId);
}

function writeSessionEvent(res, ev, sessionId) {
  const data = JSON.stringify({
    seq: ev.seq, ts: ev.ts, session_id: sessionId, run_id: ev.run_id, type: ev.type, ...ev.payload,
  });
  writeSseEvent(res, ev.type, data, ev.seq);
}

/**
 * 缓冲溢出处理（B 项，§5.1/§5.2）：写 `resync` 控制帧（reason='buffer_overflow'）→ `res.end()` 关闭该连接
 * → 从 map 移除。
 * 客户端收到后立刻 close + 带 `last_event_id` 重连，由 SSE handler 补发漏掉的事件（seq > last_event_id）。
 * 帧内**不带** last_seq（F6 / reviewer M-3）：客户端本地水位线才是权威值（服务端 rec.lastSeq 在补发窗口
 * 内可能尚未包含已落库事件，用它当重连游标会丢事件）；重连游标由客户端自己维护。
 */
function resyncSessionClient(sessionId, rec) {
  rec.resync = true;
  try {
    writeSseEvent(rec.res, 'resync', { reason: 'buffer_overflow' });
    if (typeof rec.res.end === 'function') rec.res.end();
  } catch { /* 尽力：写失败也要把 rec 摘掉，避免脏状态常驻 */ }
  rec.buffer.length = 0;
  unregisterSessionClient(sessionId, rec);
}

/** 事件落库后推给该 session 的所有浏览器 SSE 客户端（portal.md §5.1 wire 格式）；未 live 的先缓冲。 */
export function notifySessionEvents(sessionId, events) {
  const set = sessionClients.get(sessionId);
  if (!set || set.size === 0) return;
  for (const ev of events) {
    for (const rec of [...set]) { // 复制：溢出路径会在迭代中从 set 移除 rec
      if (rec.resync) continue; // 已判定需重同步，等待连接关闭/清理
      if (!rec.live) {
        if (rec.buffer.length < SESSION_CLIENT_BUFFER_MAX) {
          rec.buffer.push(ev);
          rec.lastSeq = ev.seq;
          continue;
        }
        // 缓冲已满：不再静默丢事件，改判重同步（§5.1：seq 无空洞 → 丢一条即需补发收敛）
        resyncSessionClient(sessionId, rec);
        continue;
      }
      writeSessionEvent(rec.res, ev, sessionId);
      rec.lastSeq = ev.seq;
    }
  }
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

export function writeSseEvent(res, event, data, id = null) {
  if (res.writableEnded || res.destroyed) return;
  const idLine = id != null ? `id: ${id}\n` : '';
  res.write(`${idLine}event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
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
  return {
    sseClients: sseClients.size,
    sessionClients: [...sessionClients.values()].reduce((n, set) => n + set.size, 0),
    claimWaiters: claimWaiters.size,
  };
}

// ---------------------------------------------------------------------------
// U1 claim（含 hold 长轮询）
// ---------------------------------------------------------------------------

export async function claimRun(pool, {
  container, user, capacity = 1, holdMs = HOLD_MS_MAX, now = new Date(), baseDomain, log = console, signal,
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
    throw new InternalError(400, 'validation_failed', 'capacity 越界（1..64）', { details: { field: 'capacity' } });
  }
  if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > HOLD_MS_MAX) {
    throw new InternalError(400, 'validation_failed', `hold_ms 越界（1..${HOLD_MS_MAX}）`, { details: { field: 'hold_ms' } });
  }

  const ticket = await tryClaim(pool, { container, user, capacity, now, baseDomain, log });
  if (ticket) {
    await audit(pool, { actorId: user.id, action: 'run.claim', target: ticket.run.id, details: { attempt: ticket.run.attempt } }).catch(() => {});
    return ticket;
  }

  // issue #180：客户端（agentd）已断开时不再进入/继续长轮询——为死连接领 ticket 会白耗一次 attempt。
  if (signal?.aborted) return null;
  const deadline = Date.now() + holdMs;
  await waitForWakeup(user.id, deadline, signal);
  // 等待被 abort 中断（客户端断开）→ 不 tryClaim（否则 attempts+1、占租约，响应却写向死连接）。
  if (signal?.aborted) return null;
  const retry = await tryClaim(pool, { container, user, capacity, now, baseDomain, log });
  if (retry) {
    await audit(pool, { actorId: user.id, action: 'run.claim', target: retry.run.id, details: { attempt: retry.run.attempt } }).catch(() => {});
    return retry;
  }
  return null;
}

/**
 * issue #180：claim 已提交但 ticket 未能送达 worker（客户端在响应写出前断开）→ 释放认领并把 attempt 还回去。
 *
 * 与 `releaseRun` 的区别（**不要复用**）：`releaseRun` 是 agentd 主动上报路径（claim 已送达、worker 失败），
 * 需要完整 body/reason 校验、且**不还 attempt**；本函数只处理「ticket 从未送达任何 worker」的孤儿认领。
 *
 * 语义：
 *  - 仅当 `claim_token` 匹配且 `status='claimed'` 才生效；否则静默 no-op（不踩已被别人重领/收敛的行）。
 *  - 回到 `pending`、清 `claimed_at`/`lease_until`/`owner_container_id`/`claim_token`；
 *    `attempts = GREATEST(attempts - 1, 0)`（未送达即不消耗重试预算；schema 的 `CHECK (attempts <= max_attempts)`
 *    只约束上界，递减方向不冲突）。
 *  - 记 warn 日志（run_id/attempts），便于运维观察孤儿认领频次。
 */
export async function releaseUndeliveredClaim(pool, { runId, claimToken, log = console } = {}) {
  const updated = await pool.query(
    `UPDATE run_queue
        SET status = 'pending',
            claimed_at = NULL,
            lease_until = NULL,
            owner_container_id = NULL,
            claim_token = NULL,
            attempts = GREATEST(attempts - 1, 0)
      WHERE run_id = $1 AND claim_token = $2 AND status = 'claimed'
      RETURNING attempts, max_attempts`,
    [runId, claimToken],
  );
  const row = updated.rows?.[0];
  if (!row) return { released: false };
  log?.warn?.(`[internal] released undelivered claim (client gone before response): run_id=${runId} attempts=${row.attempts}/${row.max_attempts}`);
  return { released: true, attempts: Number(row.attempts) };
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
  // P3 PR②b B1 ⑥：锚点定位不变（该 run 最新的非合成 assistant 行），**正文改从 transcript 投影取**；
  // 投影对该轮无证据时才 legacy 回退 `messages.content`（迁移 0015 之前的行）。
  const storedAssistant = await fetchRunAssistantText(pool, { sessionId: run.session_id, runId: run.id });
  stored.final_text = storedAssistant?.text ?? '';
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
  // issue #88 修订：worker 侧已顺带生成的会话标题随终态上报（字符串；截断 ≤200 入库评估）。
  // 只进 chat_sessions 评估链（scheduleAutoTitle），不写 runs 行、不参与终态幂等比对
  // （标题是会话级 best-effort 元数据，重放丢一次评估无妨）。
  let agentTitle = '';
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') {
      throw new InternalError(400, 'validation_failed', 'title 必须为字符串', { details: { field: 'title' } });
    }
    agentTitle = Array.from(body.title).slice(0, AGENT_TITLE_MAX_LEN).join('');
  }

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
    // P3 PR②b B2（docs/design/conversation-state.md §6）：**停止正文双写**——`messages` 降级为纯锚点行。
    // `finalText` 的前置条件保持不变（它决定「是否产生一条 assistant 锚点」，无终态文本就不建行），
    // 但写入的 `content` 恒为空串：终态正文的真相在 `transcript_rounds`（引擎落树），读侧
    // （`session-view.js` / `session-text.fetchRunAssistantText`）由投影派生，新行不再依赖本列。
    // 列是 `text NOT NULL`（不改 DDL），故写 `''`。
    // 前瞻性例外（当前无此类写入点，约束先钉住）：**合成行（`synthetic = true`，judge/wrapup 等宿主
    // 注入）必须继续写正文**——它在 transcript 里没有对应轮次，读侧只能取锚点自身文本
    // （`session-view.js` 的 `anchor.synthetic === true` 分支）。本路径写的恒是 `synthetic = false`。
    if (typeof finalText === 'string' && finalText.length > 0) {
      const seq = await allocSeq(client, r.session_id);
      await client.query(
        `INSERT INTO messages (session_id, run_id, seq, role, content, synthetic)
         VALUES ($1, $2, $3, 'assistant', '', false)`,
        [r.session_id, runId, seq],
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
    // 浏览器侧 SSE 推送（终态 run_end 也必须实时可见）
    try {
      notifySessionEvents(r.session_id, [{ seq: runEndSeq, ts: new Date().toISOString(), run_id: runId, type: 'run_end', payload }]);
    } catch { /* 尽力推送 */ }
    // issue #88：run 终态后异步评估会话自动标题（fire-and-forget：不阻塞本响应，失败全降级，
    // 天然「每 run 至多评估一次」）。标题由 worker 侧生成随终态上报（agentTitle）；经 session
    // SSE hub 推 'session_updated' 让列表标题实时到达。
    try {
      scheduleAutoTitle(pool, { sessionId: r.session_id, runId, agentTitle, notify: notifySessionEvents });
    } catch { /* 评估调度失败不影响终态响应 */ }
    await audit(pool, { actorId: user.id, action: 'run.finish', target: runId, details: { state, queue_status: queueStatus } }).catch(() => {});
    return { state, queue_status: queueStatus, run_end_seq: runEndSeq };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    const committedEvents = []; // 提交后推浏览器侧 SSE（D7）
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
        committedEvents.push({
          seq, ts: (ev.ts ?? new Date().toISOString()),
          run_id: runId, type: ev.type, payload: ev.payload ?? {},
        });
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
    // D7：事件先落 DB，再推浏览器侧 SSE（§5.1）。通知失败不影响 200（客户端靠 Last-Event-ID 补发）。
    try {
      if (committedEvents.length > 0) notifySessionEvents(r.session_id, committedEvents);
    } catch { /* 尽力推送 */ }
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

  // issue #117：心跳下行 LiteLLM model_name（数据面别名）；DB 槽位仍以 model_info.id 做绑定身份。
  // 查询只读 binding、不含 api_key；无 active binding → null（agentd 保持旧行为）。
  const models = await getFdeLlmHeartbeatModels(pool, user.id);

  return { now: now.toISOString(), stop_run_ids: stopRunIds, revoked: false, runs: results, models };
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
  // 0.16.0 同 round 保序：按持久化追加序列（append_seq，迁移 0016）排序，不再依赖执行计划/扫描顺序。
  const res = await pool.query(
    `SELECT round, record FROM transcript_rounds
      WHERE run_id = $1 AND round > $2
      ORDER BY round ASC, append_seq ASC LIMIT $3`,
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
// session-scoped transcript（issue #81 P2，docs/design/conversation-state.md §4.1）
//
// transcript key = sessionId（引擎 runToolLoop 的 store key）；宿主（worker）以
// dedupKey=`<key>:input:<messageId>` 预写入用户消息后 resume=true，跨 run 在同一会话键上累积。
// 与 run 作用域端点（U5–U9/runstate）并存：旧 runner 继续走旧端点，互不干扰（迁移 0006）。
// 鉴权三层：① per-container token（authenticateContainer，http.js 统一）；
// ② session 属主校验（fetchSession）；③ writer run  fencing——请求必带 `?run_id=<writer runId>`
// query 参数 + X-Claim-Token 头：writer run 必须属于该 session 且持有当前有效租约
// （assertClaimToken）。终态后 queue 行释放 claim_token → 一切写自动 409 lease_lost，
// 无需额外终态 barrier（与 run 作用域读端点「终态放宽」不同：session 读写都发生在
// 活跃租约窗口内，portal 侧不提供终态后 session 读）。
// ---------------------------------------------------------------------------

const MAX_TRANSCRIPT_KEY_LEN = 128;

async function fetchSession(pool, key, userId) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_TRANSCRIPT_KEY_LEN) {
    throw new InternalError(400, 'validation_failed', 'transcript key 必填且 ≤128 字符', { details: { field: 'key' } });
  }
  const res = await pool.query(`SELECT id, user_id FROM chat_sessions WHERE id = $1`, [key]);
  const row = res.rows?.[0];
  if (!row) throw new InternalError(404, 'session_not_found', 'session not found');
  if (row.user_id !== userId) {
    throw new InternalError(403, 'session_ownership_mismatch', 'session does not belong to this container');
  }
  return row;
}

/** writer run 校验：真 runId 必带；必须存在、属主一致、且属于该 transcript 的 session。 */
async function fetchWriterRun(pool, runId, userId, key) {
  const run = await fetchRun(pool, runId, userId);
  if (run.session_id !== key) {
    throw new InternalError(400, 'transcript_key_mismatch', 'writer run does not belong to this transcript session', {
      details: { key, run_id: runId },
    });
  }
  return run;
}

/** session transcript 写入（宿主预写 + 引擎轮记录）。行唯一性 = (transcript_key, dedup_key)——
 *  CLI 模式下行号可复用（宿主预写行与上一轮引擎记录同行号），dedupKey 才是幂等判据（迁移 0006）。
 *
 *  0.16.0 同 round 共存：同一 round 下**不同 dedup_key** 的记录合法共存（不再 409）——CLI 行号复用
 *  + 引擎 `:resume` 补跑重落盘都会同轮多行；读侧按 append_seq 还原追加序（迁移 0016，
 *  getSessionTranscript 的 ORDER BY round, append_seq）。
 *  并发幂等方案：由部分唯一索引 `transcript_rounds_session_dedup_uidx`
 *  （(transcript_key, dedup_key) WHERE transcript_key IS NOT NULL，迁移 0006）+ 本语句的
 *  `ON CONFLICT (transcript_key, dedup_key) DO NOTHING` 保证——并发同 dedupKey 重放只会命中一条，
 *  不会因「先查后插」的检查-插入竞态产生重复 user 消息（崩溃重跑红线）；同 dedupKey 不同 body
 *  才 409 round_conflict（真冲突），folded false→true 仍走 UPDATE。 */
export async function putSessionRound(pool, { container, user, key, round, claimToken, writerRunId, body }) {
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

  await fetchSession(pool, key, user.id);
  await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const record = body;
  const folded = body.folded === true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const foldedPayload = body.foldedPayload ?? null;

  const inserted = await pool.query(
    `INSERT INTO transcript_rounds (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
     VALUES (NULL, $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (transcript_key, dedup_key) WHERE transcript_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [key, dedupKey, round, JSON.stringify(record), folded, JSON.stringify(messages), foldedPayload ? JSON.stringify(foldedPayload) : null],
  );
  if (inserted.rows.length > 0) return { inserted: true };

  const existing = await pool.query(
    `SELECT record, folded FROM transcript_rounds WHERE transcript_key = $1 AND dedup_key = $2`,
    [key, dedupKey],
  );
  const ex = existing.rows?.[0];
  if (!ex) return { inserted: true }; // 理论上不可达（并发已由 ON CONFLICT 序列化）

  if (canonicalHash(ex.record) === canonicalHash(record)) {
    return { inserted: false }; // 幂等命中（崩溃重跑红线：绝不产生重复 user 消息）
  }
  // fold 更新：同 dedupKey、folded false→true 视为合法 UPDATE（同 run 作用域 U5 语义）。
  if (folded && ex.folded === false) {
    await pool.query(
      `UPDATE transcript_rounds SET record = $3, folded = true, messages = $4, folded_payload = $5
        WHERE transcript_key = $1 AND dedup_key = $2`,
      [key, dedupKey, JSON.stringify(record), JSON.stringify(messages), foldedPayload ? JSON.stringify(foldedPayload) : null],
    );
    return { inserted: true };
  }
  throw new InternalError(409, 'round_conflict', '同 dedupKey 已存在且 body 不同', { details: { dedupKey } });
}

/** session transcript 全量读取（load 分页；行序 = round ASC, append_seq ASC——行号可复用，
 *  同 round 多行按**持久化追加序**（迁移 0016 的 append_seq），恢复后的消息顺序才正确；
 *  erix-agent 0.16.0 起引擎不再二次排序，故宿主必须显式保序，不得依赖 created_at/执行计划）。
 *  cursor 以 round 为游标：同 round 行必同页（LIMIT 截断的极端大会话才可能出现跨页同行号，
 *  单会话 >10000 轮超出 P2 范围）。 */
export async function getSessionTranscript(pool, { container, user, key, claimToken, writerRunId, limit = 10000, cursor = null }) {
  await fetchSession(pool, key, user.id);
  await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const lim = Math.min(Math.max(1, Number(limit) || 10000), 10000);
  const cur = cursor == null ? -1 : Number(cursor);
  const res = await pool.query(
    `SELECT round, record FROM transcript_rounds
      WHERE transcript_key = $1 AND round > $2
      ORDER BY round ASC, append_seq ASC
      LIMIT $3`,
    [key, cur, lim],
  );
  const records = res.rows.map((r) => ({ round: Number(r.round), ...r.record }));
  const nextCursor = records.length > 0 ? records[records.length - 1].round : null;
  return { records, next_cursor: nextCursor };
}

/** session checkpoint 覆盖写 + revision CAS（同 U8 语义，键 = transcript key）。 */
export async function putSessionCheckpoint(pool, { container, user, key, claimToken, writerRunId, body }) {
  const revision = body?.revision;
  if (!Number.isInteger(revision) || revision < 0) {
    throw new InternalError(400, 'validation_failed', 'revision 必须为非负整数');
  }
  if (!body?.snapshot || typeof body.snapshot !== 'object' || Array.isArray(body.snapshot)) {
    throw new InternalError(400, 'validation_failed', 'snapshot 必须为对象');
  }
  await fetchSession(pool, key, user.id);
  await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const res = await pool.query(
    `INSERT INTO run_checkpoints (run_id, transcript_key, snapshot, revision, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (transcript_key) WHERE transcript_key IS NOT NULL DO UPDATE
       SET snapshot = EXCLUDED.snapshot, revision = EXCLUDED.revision, updated_at = now()
       WHERE run_checkpoints.revision < EXCLUDED.revision
     RETURNING revision`,
    [writerRunId, key, JSON.stringify(body.snapshot), revision],
  );
  if (res.rows.length === 0) {
    throw new InternalError(409, 'checkpoint_stale', 'checkpoint revision 不大于当前（CAS 拒绝）');
  }
  return { revision: Number(res.rows[0].revision) };
}

/** session checkpoint 读取；无 → null（HTTP 204）。 */
export async function getSessionLatestCheckpoint(pool, { container, user, key, claimToken, writerRunId }) {
  await fetchSession(pool, key, user.id);
  await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const res = await pool.query(
    `SELECT snapshot, revision, updated_at FROM run_checkpoints WHERE transcript_key = $1`,
    [key],
  );
  const row = res.rows?.[0];
  if (!row) return null;
  return { checkpoint: { snapshot: row.snapshot, revision: Number(row.revision), updated_at: row.updated_at } };
}

function runStateStatusRecord(statusRecord, hasStatusRecord, runState, key) {
  if (hasStatusRecord) {
    if (!statusRecord || typeof statusRecord !== 'object' || Array.isArray(statusRecord)
        || typeof statusRecord.status !== 'string' || statusRecord.status.length === 0) {
      throw new InternalError(500, 'run_state_status_corrupt', `run-state status record is malformed (${key})`);
    }
    return statusRecord;
  }
  if (runState != null && (typeof runState !== 'object' || Array.isArray(runState))) {
    throw new InternalError(500, 'run_state_status_corrupt', `legacy run-state snapshot is malformed (${key})`);
  }
  if (runState && Object.hasOwn(runState, 'state')) {
    if (typeof runState.state !== 'string' || runState.state.length === 0) {
      throw new InternalError(500, 'run_state_status_corrupt', `legacy run-state status is malformed (${key})`);
    }
    return { status: runState.state };
  }
  return null;
}

/** session 引擎 run state 快照合并写；markRunState 的状态落独立 status 列。
 *  blob 并入 runId = transcript key（reference 语义 = 上游 file store 的 {...state, runId}，
 *  引擎契约 loadRunState(key).runId === key）。不动 runs.status（宿主终态唯一权威仍是 U2，不变式 3）。 */
export async function saveSessionRunState(pool, { container, user, key, claimToken, writerRunId, body }) {
  let patch;
  let statusRecord;
  if (body?.run_state !== undefined) {
    if (!body.run_state || typeof body.run_state !== 'object' || Array.isArray(body.run_state)) {
      throw new InternalError(400, 'validation_failed', 'run_state 必须为对象', { details: { field: 'run_state' } });
    }
    patch = Object.fromEntries(Object.entries(body.run_state).filter(([name]) => name !== 'state'));
  } else if (typeof body?.state === 'string' && body.state) {
    statusRecord = { status: body.state, runId: key, ts: new Date().toISOString() };
  } else {
    throw new InternalError(400, 'validation_failed', 'body 需含 run_state 对象或 state 字符串', { details: { field: 'body' } });
  }

  await fetchSession(pool, key, user.id);
  const writerRun = await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const column = statusRecord ? 'engine_run_state_status' : 'engine_run_state';
  const value = statusRecord ?? { ...patch, runId: key };
  const result = await pool.query(
    `UPDATE chat_sessions s
        SET ${column} = ${statusRecord ? '$2::jsonb' : "COALESCE(s.engine_run_state, '{}'::jsonb) || $2::jsonb"}
       FROM runs r, run_queue q
      WHERE s.id = $1 AND s.user_id = $3
        AND r.id = $4 AND r.session_id = s.id
        AND q.run_id = r.id AND q.claim_token = $5 AND q.lease_until > now()
        AND r.status IN ('queued','running','cancelling')
      RETURNING s.id`,
    [key, JSON.stringify(value), user.id, writerRunId, claimToken],
  );
  if (result.rowCount === 0) {
    if (isTerminal(writerRun.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
    throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
  }
  return { ok: true };
}

/** session 引擎 run state 读取；无 → null（HTTP 204）。 */
export async function loadSessionRunState(pool, { container, user, key, claimToken, writerRunId }) {
  await fetchSession(pool, key, user.id);
  await fetchWriterRun(pool, writerRunId, user.id, key);
  await assertClaimToken(pool, writerRunId, claimToken);

  const res = await pool.query(`SELECT engine_run_state FROM chat_sessions WHERE id = $1`, [key]);
  const row = res.rows?.[0];
  if (!row || row.engine_run_state == null) return null;
  return { run_state: row.engine_run_state };
}

/** session 引擎 run-state 终态状态通道；兼容读取旧 engine_run_state.state。 */
export async function loadSessionRunStateStatus(pool, { container, user, key, claimToken, writerRunId }) {
  await fetchSession(pool, key, user.id);
  const writerRun = await fetchWriterRun(pool, writerRunId, user.id, key);
  if (!isTerminal(writerRun.status)) await assertClaimToken(pool, writerRunId, claimToken);

  const res = await pool.query(
    `SELECT engine_run_state, engine_run_state_status,
            engine_run_state_status IS NOT NULL AS has_engine_run_state_status
       FROM chat_sessions WHERE id = $1`,
    [key],
  );
  const row = res.rows?.[0];
  const status = runStateStatusRecord(
    row?.engine_run_state_status, row?.has_engine_run_state_status === true, row?.engine_run_state, key,
  );
  return status === null ? null : { status };
}

// ---------------------------------------------------------------------------
// runstate（run-state snapshot 与终态 status 独立存储）
// ---------------------------------------------------------------------------

/**
 * body 两种形态：① {run_state: <object>}——saveRunState 快照合并写（不写 state）；
 * ② {state: <string>}——markRunState 写入 run_state_status 独立列，不触碰 runs.status。
 */
export async function saveRunState(pool, { container, user, runId, claimToken, body }) {
  let patch;
  let statusRecord;
  if (body?.run_state !== undefined) {
    if (!body.run_state || typeof body.run_state !== 'object' || Array.isArray(body.run_state)) {
      throw new InternalError(400, 'validation_failed', 'run_state 必须为对象', { details: { field: 'run_state' } });
    }
    patch = Object.fromEntries(Object.entries(body.run_state).filter(([name]) => name !== 'state'));
  } else if (typeof body?.state === 'string' && body.state) {
    statusRecord = { status: body.state, runId, ts: new Date().toISOString() };
  } else {
    throw new InternalError(400, 'validation_failed', 'body 需含 run_state 对象或 state 字符串', { details: { field: 'body' } });
  }

  // runId 并入快照；status 记录由 markRunState 单独写入。
  // F2（issue #43 评审）：单条条件 UPDATE、写本身原子——非终态 + 属主 + 有效租约/claim 全部进
  // WHERE（口径同 setRunState markRunning 的 CAS），0 行才二次分类错误（fetchRun 补 404/403，
  // 终态 → run_terminal，否则 lease_lost）。杜绝 check-then-update 竞态：租约过期/re-claim 后
  // 旧 worker 的迟到写不可能覆盖新 worker 的 run_state。
  const assignment = statusRecord
    ? 'run_state_status = $4::jsonb'
    : "run_state = COALESCE(r.run_state, '{}'::jsonb) || $4::jsonb";
  const value = statusRecord ?? { ...patch, runId };
  const res = await pool.query(
    `UPDATE runs r
        SET ${assignment}
       FROM run_queue q, chat_sessions s
      WHERE r.id = $1
        AND r.session_id = s.id
        AND s.user_id = $3
        AND q.run_id = r.id
        AND q.claim_token = $2
        AND q.lease_until > now()
        AND r.status IN ('queued','running','cancelling')`,
    [runId, claimToken, user.id, JSON.stringify(value)],
  );
  if (res.rowCount === 0) {
    const run = await fetchRun(pool, runId, user.id); // 404/403 在此抛
    if (isTerminal(run.status)) throw new InternalError(409, 'run_terminal', 'run already terminal');
    throw new InternalError(409, 'lease_lost', 'claim token mismatch or lease expired (run reclaimed)');
  }
  return { ok: true };
}

/** 读取引擎 run state；无 → null（HTTP 204）。读语义同 U9：终态 run 仍可读。 */
export async function loadRunState(pool, { container, user, runId, claimToken }) {
  const run = await fetchRun(pool, runId, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, runId, claimToken);

  const res = await pool.query(`SELECT run_state FROM runs WHERE id = $1`, [runId]);
  const row = res.rows?.[0];
  if (!row || row.run_state == null) return null;
  return { run_state: row.run_state };
}

/** 读取引擎 run-state status；兼容回退到旧 run_state.state。 */
export async function loadRunStateStatus(pool, { container, user, runId, claimToken }) {
  const run = await fetchRun(pool, runId, user.id);
  if (!isTerminal(run.status)) await assertClaimToken(pool, runId, claimToken);

  const res = await pool.query(
    `SELECT run_state, run_state_status, run_state_status IS NOT NULL AS has_run_state_status
       FROM runs WHERE id = $1`,
    [runId],
  );
  const row = res.rows?.[0];
  const status = runStateStatusRecord(
    row?.run_state_status, row?.has_run_state_status === true, row?.run_state, runId,
  );
  return status === null ? null : { status };
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
    let committedRunEnd = null; // 提交后推浏览器侧 SSE（aborted/max_attempts 的合成 run_end）
    // 注意：release 后保留 claim_token（供幂等重放识别），fencing 由 lease_until 清空保证（旧 token 无法续租/写）。
    if (qrow.status === 'cancelled' || r.status === 'cancelling') {
      await client.query(`UPDATE run_queue SET status='cancelled', owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
      await client.query(`UPDATE runs SET status='finished', termination='{"reason":"aborted"}'::jsonb, ended_at=now() WHERE id=$1`, [runId]);
      outcome = 'cancelled';
      runStatus = 'finished';
      queueStatus = 'cancelled';
      const runEndSeq = await allocSeq(client, r.session_id);
      const runEndPayload = { termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts) };
      await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [runId, r.session_id, runEndSeq, `${runId}:final:run_end`, JSON.stringify(runEndPayload)],
      );
      committedRunEnd = { session_id: r.session_id, seq: runEndSeq, payload: runEndPayload };
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
      const runEndPayload = { termination: null, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts),
        error: { code: 'max_attempts_exceeded', message: 'attempts exhausted', retryable: false } };
      await client.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [runId, r.session_id, runEndSeq, `${runId}:final:run_end`, JSON.stringify(runEndPayload)],
      );
      committedRunEnd = { session_id: r.session_id, seq: runEndSeq, payload: runEndPayload };
    }

    await client.query('COMMIT');
    try {
      if (committedRunEnd) notifySessionEvents(committedRunEnd.session_id, [{ seq: committedRunEnd.seq, ts: new Date().toISOString(), run_id: runId, type: 'run_end', payload: committedRunEnd.payload }]);
    } catch { /* 尽力推送 */ }
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
  let committedRunEnd = null; // 提交后推浏览器侧 SSE（回收路径的合成 run_end）
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
        const runEndPayload = { termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts) };
        await client.query(
          `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
           VALUES ($1, $2, $3, $4, 'run_end', $5, now())
           ON CONFLICT (run_id, client_event_id) DO NOTHING`,
          [runId, r.session_id, runEndSeq, `${runId}:final:run_end`, JSON.stringify(runEndPayload)],
        );
        committedRunEnd = { session_id: r.session_id, seq: runEndSeq, payload: runEndPayload };
        results.push({ run_id: runId, outcome: 'cancelled', run_status: 'finished' });
      } else if (Number(qrow.attempts) >= Number(qrow.max_attempts)) {
        await client.query(`UPDATE run_queue SET status='done', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
        await client.query(
          `UPDATE runs SET status='failed', error='{"code":"max_attempts_exceeded","message":"attempts exhausted","retryable":false}'::jsonb, ended_at=now() WHERE id=$1`,
          [runId],
        );
        const runEndSeq = await allocSeq(client, r.session_id);
        const runEndPayload = { termination: null, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: Number(qrow.attempts),
          error: { code: 'max_attempts_exceeded', message: 'attempts exhausted', retryable: false } };
        await client.query(
          `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
           VALUES ($1, $2, $3, $4, 'run_end', $5, now())
           ON CONFLICT (run_id, client_event_id) DO NOTHING`,
          [runId, r.session_id, runEndSeq, `${runId}:final:run_end`, JSON.stringify(runEndPayload)],
        );
        committedRunEnd = { session_id: r.session_id, seq: runEndSeq, payload: runEndPayload };
        results.push({ run_id: runId, outcome: 'failed_max_attempts', run_status: 'failed' });
      } else {
        await client.query(`UPDATE run_queue SET status='pending', claim_token=NULL, owner_container_id=NULL, lease_until=NULL, claimed_at=NULL WHERE run_id=$1`, [runId]);
        await client.query(`UPDATE runs SET status='queued' WHERE id=$1`, [runId]);
        results.push({ run_id: runId, outcome: 'requeued', run_status: 'queued' });
      }
      await client.query('COMMIT');
      try {
        if (committedRunEnd) notifySessionEvents(committedRunEnd.session_id, [{ seq: committedRunEnd.seq, ts: new Date().toISOString(), run_id: runId, type: 'run_end', payload: committedRunEnd.payload }]);
      } catch { /* 尽力推送 */ }
      committedRunEnd = null;
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
  let lastPurgeAt = 0;
  (async () => {
    while (!stopped) {
      try {
        await reapExpiredRuns(pool);
      } catch (err) {
        log.warn?.(`[reaper] loop error: ${err.message}`);
      }
      // 幂等键过期清理（portal.md §1.4，TTL 24h）：低频（默认 1h，与 15s 的 run 扫描解耦）跑一次。
      // 清理失败不影响 reaper 主循环——命中判定本身带 TTL 过滤，脏行只是占空间。
      if (Date.now() - lastPurgeAt >= IDEMPOTENCY_PURGE_INTERVAL_MS) {
        lastPurgeAt = Date.now();
        try {
          const purged = await purgeExpired(pool);
          if (purged > 0) log.log?.(`[reaper] purged ${purged} expired idempotency_keys`);
        } catch (err) {
          log.warn?.(`[reaper] idempotency purge error: ${err.message}`);
        }
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
