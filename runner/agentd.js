#!/usr/bin/env node
// station-agentd：FDE 容器内常驻守护/桥接进程。
// 依据：docs/design/runner-integration.md §2/§3/§4/§6/§7/§11/§12。
//
// 职责（§3）：
//   - 唯一持 per-container token（env ERIX_STATION_TOKEN，仅本进程内存，fork worker 时从 env 剔除）；
//   - 全出站：SSE 下行 + POST 上行 → portal（internal API）；
//   - 心跳循环（15s）：续租 + stop 兜底 + revoked 收敛；
//   - claim 长轮询领任务 → 准备工作目录 → fork worker 子进程（UID 1002）；
//   - 事件批量上报（250ms/2KB，§7.2）+ store_request 转发（加 Authorization + X-Claim-Token）；
//   - 终态 barrier（§7.6）：事件批全部 200 后才 PUT 终态；
//   - lease_lost → 本地 abort worker、丢缓冲（方案 B，§6.4）；revoked → 收敛后退出。
//
// P1 范围（任务约定）：单容器串行（capacity=1）、approvals 路径留空（P2）、spool 不落盘（§7.5 待定）。

import { fork, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MSG, normalizeRoundRecord, sendIpc } from './lib/ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'worker.js');

// ---------------------------------------------------------------------------
// 配置（env §10 / deploy-contract §6.2）
// ---------------------------------------------------------------------------
const CFG = {
  token: process.env.ERIX_STATION_TOKEN || '',
  baseUrl: (process.env.ERIX_STATION_BASE_URL || 'https://station.localhost/api/internal').replace(/\/+$/, ''),
  fdeName: process.env.ERIX_FDE_NAME || 'unknown',
  agentVersion: process.env.ERIX_AGENT_VERSION || '0.1.0',
  homeUser: process.env.FDE_CONTAINER_USER || 'erix',
  home: process.env.FDE_HOME || `/home/${process.env.FDE_CONTAINER_USER || 'erix'}`,
  workerUid: Number(process.env.FDE_WORKER_UID || process.env.ERIX_WORKER_UID || 1002),
  workerGid: Number(process.env.FDE_WORKER_GID || process.env.ERIX_WORKER_GID || 1000),
  capacity: Number(process.env.ERIX_AGENTD_CAPACITY || 1),
  hbOkPath: process.env.ERIX_HB_OK_PATH || '/run/station/hb-ok',
  heartbeatMs: Number(process.env.ERIX_HEARTBEAT_MS || 15000),
  batchWindowMs: Number(process.env.ERIX_BATCH_WINDOW_MS || 250),
  batchBytes: Number(process.env.ERIX_BATCH_BYTES || 2048),
  maxEventsPerBatch: 200,
  maxBatchBytes: 256 * 1024,
  // F6：worker 无响应 watchdog——超过此时间无任何 IPC 消息（事件/store/log）→ SIGKILL worker + release requeue。
  // 默认 5min：runToolLoop 在 LLM 流式等待期间也可能长时间无 IPC，阈值必须远大于正常模型等待；env 可调。
  watchdogMs: Number(process.env.ERIX_AGENTD_WATCHDOG_MS || 300000),
  maxPendingEvents: Number(process.env.ERIX_MAX_PENDING_EVENTS || 20000),
};

// 批处理单批上限（§7.2）。
const BATCH_BYTES_MAX = CFG.maxBatchBytes;
const BATCH_EVENTS_MAX = CFG.maxEventsPerBatch;

// ---------------------------------------------------------------------------
// 日志（单行 JSON，runner §14）
// ---------------------------------------------------------------------------
function log(level, msg, extra = {}) {
  const line = { ts: new Date().toISOString(), level, msg, fde: CFG.fdeName, ...extra };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(line));
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const state = {
  sseOk: false,
  sawPing: false,
  revokeReason: null, // 非空 → 停领新任务、收敛后退出
  shutdown: false,
  runs: new Map(), // runId -> RunCtx
};

/** RunCtx：单个活跃 run 的本地上下文。 */
function makeRunCtx(runId) {
  return {
    runId,
    claimToken: null,
    attempt: 1,
    resume: false,
    worker: null,
    workerPid: null,
    // 事件批量缓冲
    events: [],
    eventBytes: 0,
    flushTimer: null,
    inflight: false,
    // 终态 barrier
    finishing: false,
    // 已被租约/停止裁决，丢弃后续写
    dropped: false,
    // F6：最后一次 IPC 活动（watchdog 用）；M3：worktree 清理路径
    lastIpcAt: Date.now(),
    worktreePath: null,
    projectDir: null,
  };
}

// ---------------------------------------------------------------------------
// 内部 HTTP 客户端（零依赖，Node 22 fetch；§4.5 重试/错误分类）
// ---------------------------------------------------------------------------
const BACKOFF = [1000, 2000, 5000, 10000, 30000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffFor(n) {
  return BACKOFF[Math.min(n, BACKOFF.length - 1)];
}

class InternalError extends Error {
  constructor(status, code, message, retryable) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

async function internalRequest(method, p, { body, claimToken, retries = 0, timeoutMs = 30000 } = {}) {
  const headers = {
    Authorization: `Bearer ${CFG.token}`,
    'Content-Type': 'application/json',
  };
  if (claimToken) headers['X-Claim-Token'] = claimToken;
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  if (payload !== undefined) headers['Content-Length'] = Buffer.byteLength(payload);

  let res;
  try {
    res = await fetch(`${CFG.baseUrl}${p}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // 网络错误 → 可重试
    throw new InternalError(0, 'network_error', String(err?.message ?? err), true);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (res.status >= 200 && res.status < 300) return { status: res.status, data };

  const code = data?.error?.code ?? `http_${res.status}`;
  const message = data?.error?.message ?? text;
  // §4.5 错误分类
  const retryable = res.status >= 500 || res.status === 429;
  const err = new InternalError(res.status, code, message, retryable);

  // lease_lost / run_terminal / checkpoint_stale / 4xx 等 → 不重试（由调用方按语义处理）。
  if (res.status === 409) err.retryable = false;
  throw err;
}

/** 无限指数退避重试（仅对可重试错误）。onRetry 用于观测。 */
async function withRetry(fn, { what, retryable = () => true, maxRetries = Infinity } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const canRetry = err instanceof InternalError && err.retryable && retryable(err) && attempt < maxRetries;
      if (!canRetry) throw err;
      const delay = backoffFor(attempt) * (0.8 + Math.random() * 0.4);
      log('warn', `retry ${what}`, { attempt: attempt + 1, code: err.code, delayMs: Math.round(delay) });
      await sleep(delay);
      attempt += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// SSE 下行（§4.3）：ping 保活 / stop_request / revoke / approval_decision（P2）
// ---------------------------------------------------------------------------
function openSse() {
  let stopped = false;
  const run = async () => {
    let attempt = 0;
    while (!stopped && !state.revokeReason && !state.shutdown) {
      if (attempt > 0) {
        const delay = backoffFor(attempt - 1) * (0.8 + Math.random() * 0.4);
        log('info', 'sse reconnect', { attempt, delayMs: Math.round(delay) });
        await sleep(delay);
      }
      try {
        const res = await fetch(`${CFG.baseUrl}/stream`, {
          headers: { Authorization: `Bearer ${CFG.token}`, Accept: 'text/event-stream' },
        });
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          if (res.status === 401) {
            state.revokeReason = 'token_revoked';
            log('warn', 'sse 401 token_revoked');
            return;
          }
          throw new InternalError(res.status, 'sse', text, true);
        }
        state.sseOk = true;
        attempt = 0;
        log('info', 'sse connected');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            handleSseChunk(raw);
          }
        }
        state.sseOk = false;
        log('warn', 'sse stream ended', {});
        attempt += 1;
      } catch (err) {
        state.sseOk = false;
        log('warn', 'sse disconnected', { reason: String(err?.message ?? err) });
        attempt += 1;
      }
    }
  };
  return { run, stop: () => { stopped = true; } };
}

function handleSseChunk(raw) {
  let event = 'message';
  const data = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // 注释心跳
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return;
  let payload;
  try { payload = JSON.parse(data.join('\n')); } catch { return; }

  if (event === 'ping') {
    if (!state.sawPing) {
      state.sawPing = true;
      log('info', 'sse ping received', {});
    }
    return;
  }
  if (event === 'run_assigned') {
    // 唤醒 hint：不携带权威载荷；claim 长轮询本身会被 portal 侧 NOTIFY 唤醒，此处仅日志。
    log('debug', 'run_assigned hint', { run_id: payload?.run_id });
    return;
  }
  if (event === 'stop_request') {
    const runId = payload?.run_id;
    const ctx = runId ? state.runs.get(runId) : null;
    if (ctx) abortRun(ctx, 'stop_request');
    return;
  }
  if (event === 'revoke') {
    state.revokeReason = payload?.reason ?? 'revoked';
    log('warn', 'revoke received', { reason: state.revokeReason });
    // F5：revoke → abort 全部运行中 run（worker 收敛），否则 heartbeat loop 虽退、runs 与
    // claim/sse 循环仍在，agentd 无法按契约「收敛后退出」（评审 F5：token 已吊销仍持续心跳）。
    for (const ctx of state.runs.values()) {
      abortRun(ctx, 'revoked');
    }
    return;
  }
  if (event === 'approval_decision') {
    // P1 不实现审批；忽略（P2 接入）。
    return;
  }
}

// ---------------------------------------------------------------------------
// claim 长轮询（§4.2 U1）
// ---------------------------------------------------------------------------
async function claimOnce() {
  // hold_ms=30000 是服务端长轮询上限；客户端超时必须显著大于 hold，否则会在 204 返回前被 AbortSignal
  // 掐断（30s vs 30s 竞态 → claim 永远拿不到响应）。留 10s 缓冲。
  const holdMs = 30000;
  return internalRequest('POST', '/claim', {
    body: { capacity: CFG.capacity, hold_ms: holdMs },
    timeoutMs: holdMs + 10000,
  });
}

// M5：心跳成功 → 刷新健康标记文件 mtime（healthcheck.sh 检查 180s 内新鲜度）。
// 放 agentd 侧（进程内）而非 cron：与心跳节奏一致，失败不影响心跳主流程。
function touchHbOk() {
  try { fs.utimesSync(CFG.hbOkPath, new Date(), new Date()); } catch {}
}

// ---------------------------------------------------------------------------
// 心跳（§4.2 U4）
// ---------------------------------------------------------------------------
async function heartbeatOnce() {
  const runs = [];
  for (const ctx of state.runs.values()) {
    if (!ctx.worker) continue;
    runs.push({ run_id: ctx.runId, status: 'running', worker_pid: ctx.workerPid, claim_token: ctx.claimToken });
  }
  const r = await internalRequest('POST', '/heartbeat', {
    body: { agent_version: CFG.agentVersion, runs },
  });
  return r.data;
}

// ---------------------------------------------------------------------------
// worktree 准备（§6.2）：git worktree add，失败回退 mkdir（P1 无真实仓库）
// ---------------------------------------------------------------------------
function prepareWorktree(projectName, runId) {
  const projectsDir = path.join(CFG.home, 'projects');
  const worktreesDir = path.join(CFG.home, 'worktrees');
  const projectDir = path.join(projectsDir, projectName || 'default');
  const wt = path.join(worktreesDir, `${projectName || 'default'}-${runId}`);
  fs.mkdirSync(worktreesDir, { recursive: true });

  // 尝试 git worktree（真实仓库场景）；失败/非 git 仓库 → 普通目录（P1 兜底）。
  try {
    const isRepo = fs.existsSync(path.join(projectDir, '.git'));
    if (isRepo) {
      execFileSync('git', ['worktree', 'add', wt, '-b', `agent/${runId}`], {
        cwd: projectDir, stdio: ['ignore', 'ignore', 'ignore'],
      });
      return wt;
    }
  } catch (err) {
    // fallthrough → mkdir 兜底（P1 无真实仓库场景）。⚠️ 不能静默：dubious ownership / EACCES
    // 被吞曾导致 worktree 机制整体静默降级（issue #27，2026-09-18 修复），失败必须留痕。
    log('warn', 'worktree add failed, fallback to plain dir', { run_id: runId, wt, err: String(err?.message ?? err) });
  }
  fs.mkdirSync(wt, { recursive: true });
  return wt;
}

// ---------------------------------------------------------------------------
// store_request → internal 端点映射（§9.1）
// ---------------------------------------------------------------------------
async function handleStoreRequest(ctx, method, args) {
  const runId = ctx.runId;
  switch (method) {
    case 'appendRound': {
      const record = normalizeRoundRecord(runId, args?.record);
      const round = record.round;
      const r = await withRetry(
        () => internalRequest('PUT', `/runs/${runId}/transcript/rounds/${round}`, { body: record, claimToken: ctx.claimToken }),
        { what: `appendRound run=${runId} round=${round}` },
      );
      return r.data;
    }
    case 'load': {
      // U6 分页循环拉全量（runner §9.1 注：超出 10000 轮时循环；P1 单页足够）。
      const records = [];
      let cursor = null;
      for (;;) {
        const q = cursor == null ? '?limit=10000' : `?limit=10000&cursor=${cursor}`;
        const r = await withRetry(
          () => internalRequest('GET', `/runs/${runId}/transcript${q}`, { claimToken: ctx.claimToken }),
          { what: `load run=${runId}` },
        );
        records.push(...(r.data?.records ?? []));
        cursor = r.data?.next_cursor ?? null;
        if (cursor == null) break;
      }
      return { records };
    }
    case 'recall': {
      const qs = new URLSearchParams();
      if (args?.fromRound != null) qs.set('from_round', String(args.fromRound));
      if (args?.toRound != null) qs.set('to_round', String(args.toRound));
      qs.set('pattern', String(args?.pattern ?? ''));
      const r = await withRetry(
        () => internalRequest('GET', `/runs/${runId}/transcript/recall?${qs.toString()}`, { claimToken: ctx.claimToken }),
        { what: `recall run=${runId}` },
      );
      return r.data;
    }
    case 'markRunState': {
      const r = await withRetry(
        () => internalRequest('PUT', `/runs/${runId}/state`, { body: { state: args?.state ?? 'running' }, claimToken: ctx.claimToken }),
        { what: `markRunState run=${runId}` },
      );
      return r.data;
    }
    case 'saveCheckpoint': {
      const revision = Number(args?.revision ?? 0);
      const snapshot = args?.snapshot ?? {};
      const r = await withRetry(
        () => internalRequest('PUT', `/runs/${runId}/checkpoint`, { body: { revision, snapshot }, claimToken: ctx.claimToken }),
        { what: `saveCheckpoint run=${runId} rev=${revision}` },
      );
      return r.data;
    }
    case 'loadLatestCheckpoint': {
      const r = await withRetry(
        () => internalRequest('GET', `/runs/${runId}/checkpoint/latest`, { claimToken: ctx.claimToken }),
        { what: `loadLatestCheckpoint run=${runId}` },
      );
      return r.data; // {checkpoint:{snapshot,revision,updated_at}} 或 204 → null
    }
    default:
      throw new Error(`unknown store method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// 事件批量上报（§7.2/§7.6）
// ---------------------------------------------------------------------------
function scheduleFlush(ctx) {
  if (ctx.flushTimer || ctx.dropped) return;
  ctx.flushTimer = setTimeout(() => {
    ctx.flushTimer = null;
    flushEvents(ctx).catch((err) => {
      if (!ctx.dropped) log('warn', 'flush events failed', { run_id: ctx.runId, err: String(err?.message ?? err) });
    });
  }, CFG.batchWindowMs);
}

async function flushEvents(ctx) {
  if (ctx.dropped || ctx.inflight || ctx.events.length === 0) return;
  ctx.inflight = true;
  // F7：按字节切批——单批 ≤ BATCH_BYTES_MAX 且 ≤ BATCH_EVENTS_MAX（评审 F7：原实现只按条数，
  // portal 端 256KiB 拒收 → 整批退回无限重试风暴）。
  const batch = [];
  let batchBytes = 0;
  while (ctx.events.length > 0 && batch.length < BATCH_EVENTS_MAX) {
    const evSize = Buffer.byteLength(JSON.stringify(ctx.events[0]), 'utf8');
    // F7：单事件超批上限 → 丢弃 + 告警，不毒化整个队列（portal 400 非可重试 → 原实现会无限重试风暴）。
    if (evSize > BATCH_BYTES_MAX) {
      const ev = ctx.events.shift();
      ctx.eventBytes = Math.max(0, ctx.eventBytes - evSize);
      log('warn', 'event exceeds batch byte limit, dropped', {
        run_id: ctx.runId, bytes: evSize, limit: BATCH_BYTES_MAX, type: ev?.type });
      continue;
    }
    if (batch.length > 0 && batchBytes + evSize > BATCH_BYTES_MAX) break;
    const ev = ctx.events.shift();
    batch.push(ev);
    batchBytes += evSize;
  }
  const body = {
    batch_id: `${ctx.runId}:b${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    events: batch,
  };
  try {
    const r = await internalRequest('POST', `/runs/${ctx.runId}/events`, { body, claimToken: ctx.claimToken });
    log('debug', 'events stored', { run_id: ctx.runId, stored: r.data?.stored, count: batch.length });
  } catch (err) {
    // 不可重试的 409 lease_lost/run_terminal → 丢弃该 run 缓冲（§4.5/§6.5）。
    if (err instanceof InternalError && !err.retryable && err.status === 409) {
      ctx.dropped = true;
      log('warn', 'events dropped (409)', { run_id: ctx.runId, code: err.code });
      ctx.events.length = 0;
      ctx.eventBytes = 0;
    } else {
      // 可重试：放回队首，退避重试。
      ctx.events.unshift(...batch);
      if (err instanceof InternalError && err.retryable) {
        await sleep(backoffFor(0));
      }
    }
  } finally {
    ctx.inflight = false;
    if (ctx.events.length > 0) scheduleFlush(ctx);
  }
}

function enqueueEvent(ctx, ev) {
  if (ctx.dropped) return;
  ctx.events.push(ev);
  // F7：待发事件总量设上限（env ERIX_MAX_PENDING_EVENTS，默认 20000），防止队列无界增长。
  if (ctx.events.length > CFG.maxPendingEvents) {
    const ev2 = ctx.events.shift();
    ctx.eventBytes = Math.max(0, ctx.eventBytes - Buffer.byteLength(JSON.stringify(ev2), 'utf8'));
    log('warn', 'pending event queue overflow, oldest dropped', { run_id: ctx.runId, pending: ctx.events.length });
  }
  ctx.eventBytes += Buffer.byteLength(JSON.stringify(ev), 'utf8');
  if (ctx.eventBytes >= CFG.batchBytes || ctx.events.length >= BATCH_EVENTS_MAX) {
    if (ctx.flushTimer) { clearTimeout(ctx.flushTimer); ctx.flushTimer = null; }
    flushEvents(ctx).catch(() => {});
  } else {
    scheduleFlush(ctx);
  }
}

/** 终态 barrier（§7.6）：排空事件批 → PUT 终态。 */
async function drainEvents(ctx) {
  if (ctx.flushTimer) { clearTimeout(ctx.flushTimer); ctx.flushTimer = null; }
  for (let i = 0; i < 200 && ctx.events.length > 0; i++) {
    await flushEvents(ctx);
    if (ctx.dropped) break;
    if (ctx.events.length === 0) break;
  }
  // 若仍有余量且未被丢弃 → 最后一搏（切多批）。
  while (ctx.events.length > 0 && !ctx.dropped) {
    await flushEvents(ctx);
    if (ctx.events.length === 0) break;
    await sleep(backoffFor(0));
  }
}

// ---------------------------------------------------------------------------
// 终态收敛（U2，§7.6）
// ---------------------------------------------------------------------------
async function finishRun(ctx, payload) {
  // M1：终态上报必须 transient 重试（网络闪断/5xx 时丢终态 → run 卡 running 只能靠 reaper 收敛）。
  const r = await withRetry(
    () => internalRequest('PUT', `/runs/${ctx.runId}/state`, {
      body: payload,
      claimToken: ctx.claimToken,
    }),
    { what: `finishRun run=${ctx.runId}`, retryable: () => !ctx.dropped },
  );
  return r.data;
}

/**
 * 方案②（issue #25 第 4 项）：abort 后 worker 被 SIGKILL/未回 U2 消息时的显式终态补报。
 * 语义与 reaper A2 对齐：cancelling → runs finished + termination aborted（用户停止）。
 * best-effort：dropped 使 withRetry 不重试；409 run_terminal（已收敛）/lease_lost（fencing）
 * 幂等吞掉；上报失败仍有 90s reaper 兑底（双保险，不丢终态）。
 */
async function reportTerminalAfterDrop(ctx) {
  try {
    await finishRun(ctx, {
      state: 'finished',
      termination: { reason: 'aborted' },
      usage: { input_tokens: 0, output_tokens: 0 },
      rounds: 0,
      final_text: '',
    });
    log('info', 'terminal reported after abort', { run_id: ctx.runId, drop_reason: ctx.dropReason });
  } catch (err) {
    if (err instanceof InternalError && (err.code === 'run_terminal' || err.code === 'lease_lost')) {
      log('info', 'terminal report skipped after abort', { run_id: ctx.runId, code: err.code });
    } else {
      log('warn', 'terminal report failed after abort', { run_id: ctx.runId, msg: String(err?.message ?? err) });
    }
  }
}

// ---------------------------------------------------------------------------
// abort（§6.4/§6.5）：SIGTERM worker，标记丢弃
// ---------------------------------------------------------------------------
// M2：杀整个进程组（worker 以 detached fork 创建，负 pid = 组）；回退单 pid。
function killProcessGroup(pid, sig) {
  try { process.kill(-pid, sig); return; } catch {}
  try { process.kill(pid, sig); } catch {}
}

function abortRun(ctx, reason) {
  if (ctx.dropped) return;
  ctx.dropped = true;
  ctx.dropReason = reason; // 方案②（issue #25）：onWorkerExit 按原因决定是否补报终态
  if (ctx.worker && ctx.worker.connected) {
    sendIpc(ctx.worker, { type: MSG.ABORT, run_id: ctx.runId, reason });
    // 5s 宽限后 SIGKILL（§2.4）；M2：按进程组杀，防孑遗子进程
    const pid = ctx.workerPid;
    setTimeout(() => {
      if (pid) killProcessGroup(pid, 'SIGKILL');
    }, 5000);
  }
  log('info', 'abort run', { run_id: ctx.runId, reason });
}

// ---------------------------------------------------------------------------
// worker 生命周期（§5/§6）
// ---------------------------------------------------------------------------
function spawnWorker(ctx, runStart) {
  const childEnv = { ...process.env };
  // §11：worker 无凭据——剔除 token；HOME 指向 erix（工作区属主）。
  delete childEnv.ERIX_STATION_TOKEN;
  childEnv.HOME = CFG.home;
  childEnv.FDE_CONTAINER_USER = CFG.homeUser;

  const child = fork(WORKER_PATH, [], {
    uid: CFG.workerUid,
    gid: CFG.workerGid,
    detached: true, // M2：独立进程组，watchdog/abort 可整组杀
    env: childEnv,
    cwd: runStart.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  ctx.worker = child;
  ctx.workerPid = child.pid ?? null;
  ctx.lastIpcAt = Date.now();

  child.stdout?.on('data', (d) => process.stdout.write(`[worker ${ctx.runId.slice(0, 8)}] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[worker ${ctx.runId.slice(0, 8)}] ${d}`));

  child.on('message', (msg) => onWorkerMessage(ctx, runStart, msg));
  child.on('error', (err) => log('warn', 'worker error', { run_id: ctx.runId, err: String(err?.message ?? err) }));
  child.on('exit', (code, signal) => onWorkerExit(ctx, code, signal));
}

function onWorkerMessage(ctx, runStart, msg) {
  if (!msg || typeof msg !== 'object') return;
  ctx.lastIpcAt = Date.now(); // F6：任意 IPC 消息都算 worker 活着
  switch (msg.type) {
    case MSG.WORKER_READY:
      sendIpc(ctx.worker, { type: MSG.RUN_START, ...runStart });
      break;
    case MSG.EVENT:
      if (msg.run_id === ctx.runId) enqueueEvent(ctx, msg.event);
      break;
    case MSG.STORE_REQUEST: {
      handleStoreRequest(ctx, msg.method, msg.args)
        .then((result) => sendIpc(ctx.worker, { type: MSG.STORE_RESPONSE, req_id: msg.req_id, ok: true, result }))
        .catch((err) => {
          const isLeaseLost = err instanceof InternalError && err.code === 'lease_lost';
          if (isLeaseLost) ctx.dropped = true;
          sendIpc(ctx.worker, {
            type: MSG.STORE_RESPONSE,
            req_id: msg.req_id,
            ok: false,
            error: {
              code: err?.code ?? 'internal',
              message: String(err?.message ?? err),
              retryable: err instanceof InternalError ? err.retryable : false,
            },
          });
        });
      break;
    }
    case MSG.APPROVAL_REQUEST:
      // P1：approvals 路径留空（runner §10 端点 P2 接入）。
      sendIpc(ctx.worker, { type: MSG.APPROVAL_DECISION, req_id: msg.req_id, decision: 'denied', note: 'approvals not implemented (P1)' });
      break;
    case MSG.RUN_FINISHED:
      onWorkerFinished(ctx, msg);
      break;
    case MSG.LOG:
      log('info', 'worker log', { run_id: ctx.runId, level: msg.level, msg: msg.msg });
      break;
    default:
      break;
  }
}

function onWorkerExit(ctx, code, signal) {
  log('info', 'worker exit', { run_id: ctx.runId, code, signal });
  if (ctx.worker) { ctx.worker = null; ctx.workerPid = null; }
  // F4：dropped（stop/lease_lost 裁决）也必须清理 ctx——否则 state.runs 永不移除，
  // capacity=1 下 claim 循环永久停摆（评审实测路径）。dropped 不写 U2（租约已易主，写必 409），
  // 但 capacity 必须释放、本地上下文必须回收。
  if (ctx.dropped) {
    // 方案②（issue #25 第 4 项）：stop/revoked 场景租约仍在我方 → 显式上报终态，
    // 省掉 90s 租约 reaper 兑底等待（「停止」体验立竿见影）。lease_lost 场景租约已易主，
    // 写必 409 lease_lost → 保持仅清理（由新持有者/portal 收敛，评审 F4 语义不变）。
    if (ctx.dropReason === 'stop_request' || ctx.dropReason === 'stop_heartbeat' || ctx.dropReason === 'revoked') {
      void reportTerminalAfterDrop(ctx);
    }
    cleanupRun(ctx);
    return;
  }
  // 非预期退出且未终态 → release + 重新认领（§6.4 worker 崩溃）。
  if (!ctx.finishing && (code !== 0 || signal)) {
    log('warn', 'worker crashed', { run_id: ctx.runId, code, signal });
    releaseAndRequeue(ctx, 'worker_crashed');
  }
}

async function onWorkerFinished(ctx, msg) {
  // F4：dropped（stop/lease_lost 已裁决）时仍尝试 U2——若租约仍在我方则终态收敛；
  // 已易主则 U2 得 409 lease_lost（fencing），run 由新租约持有者收敛（§6.4/§12）。
  // 无论 U2 是否成功，worker 退出后都必须 cleanupRun 释放 capacity（评审 F4：dropped ctx 永留 state.runs）。
  if (ctx.finishing) return;
  ctx.finishing = true;

  // 终态 barrier：先排空事件（§7.6 ①）。
  await drainEvents(ctx);

  const body = {
    // 状态机口径（issue #25 方案②）：用户主动停止（abort）与自然结束同为 finished——
    // termination.reason 区分（aborted/end_turn），与 reaper A2 口径一致（此前 aborted 走 failed，
    // 与 reaper 收敛结果不一致）。
    state: msg.ok || msg.termination?.reason === 'aborted' ? 'finished' : 'failed',
    termination: msg.termination ?? (msg.ok ? { reason: 'end_turn' } : { reason: 'failed' }),
    usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
    rounds: msg.rounds ?? 0,
    final_text: msg.final_text ?? '',
  };
  if (!msg.ok && msg.termination?.reason !== 'aborted') {
    body.error = msg.error ?? { code: 'failed', message: 'run failed', retryable: false };
  }

  try {
    const r = await finishRun(ctx, body);
    log('info', 'run finished', { run_id: ctx.runId, state: body.state, run_end_seq: r?.run_end_seq });
  } catch (err) {
    // 409 run_terminal 幂等命中 → 视为成功；lease_lost → 已易主，不再写。
    if (err instanceof InternalError && err.code === 'run_terminal') {
      log('info', 'run finish idempotent', { run_id: ctx.runId });
    } else {
      log('warn', 'run finish failed', { run_id: ctx.runId, code: err?.code, msg: String(err?.message ?? err) });
    }
  }
  cleanupRun(ctx);
}

function cleanupRun(ctx) {
  if (ctx.flushTimer) { clearTimeout(ctx.flushTimer); ctx.flushTimer = null; }
  if (ctx.worker) {
    const pid = ctx.workerPid;
    try { if (ctx.worker.connected) ctx.worker.kill('SIGTERM'); } catch {}
    if (pid) {
      // M2：SIGTERM 后短宽限整组 SIGKILL，防 worker 忽略信号残留
      setTimeout(() => killProcessGroup(pid, 'SIGKILL'), 2000);
    }
  }
  cleanupWorktree(ctx); // M3
  state.runs.delete(ctx.runId);
  log('info', 'run cleaned up', { run_id: ctx.runId });
}

// M3：清理 run 的 worktree——真实 git worktree 用 `git worktree remove --force`；
// 兑底目录（mkdir fallback）直接 rmSync；之后 prune 残留元数据。best-effort。
function cleanupWorktree(ctx) {
  const wt = ctx.worktreePath;
  if (!wt) return;
  const projectDir = ctx.projectDir;
  if (projectDir && fs.existsSync(path.join(projectDir, '.git')) && fs.existsSync(wt)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], {
        cwd: projectDir, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000,
      });
      return;
    } catch {}
  }
  try {
    if (fs.existsSync(wt)) fs.rmSync(wt, { recursive: true, force: true });
  } catch {}
  if (projectDir) {
    try { execFileSync('git', ['worktree', 'prune'], { cwd: projectDir, stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000 }); } catch {}
  }
}

async function releaseAndRequeue(ctx, reason) {
  try {
    const r = await internalRequest('POST', `/runs/${ctx.runId}/release`, { body: { reason }, claimToken: ctx.claimToken });
    log('info', 'release run', { run_id: ctx.runId, reason, outcome: r.data?.outcome });
  } catch (err) {
    log('warn', 'release failed', { run_id: ctx.runId, code: err?.code, msg: String(err?.message ?? err) });
  }
  // 回 pending 后立即 re-claim 同一 run（attempt+1、resume=true）由主 claim 循环完成。
  cleanupRun(ctx);
}

// ---------------------------------------------------------------------------
// claim → 准备 → fork worker（§6.1）
// ---------------------------------------------------------------------------
async function handleTicket(ticket) {
  const run = ticket.run ?? {};
  const runId = run.id;
  if (!runId) return;
  if (state.runs.has(runId)) return; // 已在跑（幂等）

  const ctx = makeRunCtx(runId);
  ctx.claimToken = ticket.claim_token;
  ctx.attempt = Number(run.attempt ?? 1);
  ctx.resume = run.resume === true;
  state.runs.set(runId, ctx);

  let cwd;
  try {
    cwd = prepareWorktree(run.project?.name ?? 'default', runId);
  } catch (err) {
    log('warn', 'worktree prep failed', { run_id: runId, err: String(err?.message ?? err) });
    await releaseAndRequeue(ctx, 'worktree_failed');
    return;
  }
  // M3：记录清理所需路径
  ctx.worktreePath = cwd;
  ctx.projectDir = path.join(CFG.home, 'projects', run.project?.name ?? 'default');

  // 先 PUT running（§6.1：准备就绪后）。worker 内部 runToolLoop 也会 markRunState('running')，幂等。
  try {
    await internalRequest('PUT', `/runs/${runId}/state`, { body: { state: 'running' }, claimToken: ctx.claimToken });
  } catch (err) {
    log('warn', 'mark running failed', { run_id: runId, code: err?.code, msg: String(err?.message ?? err) });
    if (err instanceof InternalError && err.code === 'lease_lost') {
      cleanupRun(ctx);
      return;
    }
  }

  const runStart = {
    run_id: runId,
    session_id: run.session_id ?? null,
    attempt: ctx.attempt,
    task: run.task ?? '',
    cwd,
    project: run.project?.name ?? 'default',
    model: run.model ?? null,
    resume: ctx.resume,
    attachments: Array.isArray(run.attachments) ? run.attachments : [],
    config: { model_config_path: path.join(CFG.home, '.erix', 'config.json') },
  };
  try {
    spawnWorker(ctx, runStart);
    log('info', 'worker spawned', { run_id: runId, attempt: ctx.attempt, resume: ctx.resume, pid: ctx.workerPid, cwd });
  } catch (err) {
    log('warn', 'fork failed', { run_id: runId, err: String(err?.message ?? err) });
    await releaseAndRequeue(ctx, 'fork_failed');
  }
}

// ---------------------------------------------------------------------------
// 主循环：claim + heartbeat（并行的两个长任务）
// ---------------------------------------------------------------------------
async function claimLoop() {
  for (;;) {
    if (state.revokeReason || state.shutdown) return;
    const available = CFG.capacity - state.runs.size;
    if (available <= 0) {
      await sleep(1000);
      continue;
    }
    try {
      const r = await claimOnce();
      if (r.status === 200 && r.data) {
        await handleTicket(r.data);
      }
      // 204 → 立即再 claim
    } catch (err) {
      if (err instanceof InternalError && err.code === 'token_revoked') {
        state.revokeReason = 'token_revoked';
        return;
      }
      if (err instanceof InternalError && !err.retryable) {
        log('warn', 'claim non-retryable', { code: err.code, msg: String(err.message) });
        await sleep(backoffFor(0));
        continue;
      }
      log('warn', 'claim failed', { msg: String(err?.message ?? err) });
      await sleep(backoffFor(0));
    }
  }
}

async function heartbeatLoop() {
  for (;;) {
    if (state.shutdown) return;
    // 评审 PR#23（reviewer M1）：revoke 后必须停心跳——否则 heartbeatLoop 永不返回、
    // Promise.all 不 resolve，'agentd exiting' 不可达，agentd 只能靠 SIGTERM 兕底。
    if (state.revokeReason) return;
    await sleep(CFG.heartbeatMs);
    // F6：watchdog——worker 长时间无任何 IPC（SIGSTOP/死循环/管道卡死）→ SIGKILL 整组，
    // exit 路径会 releaseAndRequeue（attempt+1、resume）。阈值远大于正常 LLM 等待。
    const now = Date.now();
    for (const ctx of state.runs.values()) {
      if (!ctx.worker || ctx.finishing) continue;
      const silentMs = now - ctx.lastIpcAt;
      if (silentMs > CFG.watchdogMs) {
        log('warn', 'watchdog: worker silent, killing', {
          run_id: ctx.runId, silent_ms: silentMs, threshold_ms: CFG.watchdogMs });
        if (ctx.workerPid) killProcessGroup(ctx.workerPid, 'SIGKILL');
      }
    }
    try {
      const data = await heartbeatOnce();
      touchHbOk(); // M5：心跳成功 → 刷新健康标记（healthcheck.sh 读 mtime）
      if (data?.revoked) {
        state.revokeReason = 'revoked';
        log('warn', 'heartbeat revoked', {});
        return;
      }
      for (const runId of data?.stop_run_ids ?? []) {
        const ctx = state.runs.get(runId);
        if (ctx) abortRun(ctx, 'stop_heartbeat');
      }
      for (const item of data?.runs ?? []) {
        if (item?.lease === 'lease_lost') {
          const ctx = state.runs.get(item.run_id);
          if (ctx) {
            log('warn', 'lease_lost from heartbeat', { run_id: item.run_id, reason: item.reason });
            abortRun(ctx, 'lease_lost');
            // 丢弃缓冲与 spool（§6.4）；run 由新租约持有者/portal 收敛。
            ctx.dropped = true;
          }
        }
      }
    } catch (err) {
      if (err instanceof InternalError && err.code === 'token_revoked') {
        // issue #22 方案②：token_revoked 即显式 revoke 信号——心跳路径不能像 claim 那样吞成
        // 普通错误继续转（否则收敛只剩 claim 循环的 ≤30s 兑底）。置位后与本循环 revoked 分支
        // 同径：停心跳、abort 全部 run、收敛退出。
        state.revokeReason = 'token_revoked';
        log('warn', 'heartbeat 401 token_revoked', {});
        return;
      }
      log('warn', 'heartbeat failed', { msg: String(err?.message ?? err) });
    }
  }
}

// ---------------------------------------------------------------------------
// 优雅退出（§2/§14）
// ---------------------------------------------------------------------------
function shutdown() {
  if (state.shutdown) return;
  state.shutdown = true;
  log('info', 'shutdown: draining runs');
  for (const ctx of state.runs.values()) {
    abortRun(ctx, 'agent_shutdown');
    // 崩溃恢复方案 B（§6.4/§9.6）：agent 关停属「容器是牲口」——不写终态（U2），
    // 让租约过期后由 portal re-claim（attempt+1、resume）收敛。finishing=true 挡住
    // onWorkerFinished 的 U2 写入（F4 修复后 dropped 也会尝试 U2，这里必须显式豁免），
    // 否则容器 restart 会被误判为永久 failed、恢复路径被劫持（e2e 实测回归）。
    ctx.finishing = true;
  }
  // 给 worker 5s 宽限后退出；tini 会转发信号并 reap。
  setTimeout(() => process.exit(0), 5000);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!CFG.token) {
    log('error', 'ERIX_STATION_TOKEN missing');
    process.exit(1);
  }
  // user-space §6.2：容器内进程 umask = 0002（新建文件 664/目录 775，配合同 GID 1000 组协作）。
  // agentd 建 worktree、fork worker（继承 umask）的文件都需跨 UID（1001/1002）组可写。
  process.umask(0o002);
  log('info', 'agentd starting', { base: CFG.baseUrl, capacity: CFG.capacity, worker_uid: CFG.workerUid });

  const sse = openSse();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const sseTask = sse.run(); // 后台运行，不 await——SSE 流由 portal 主动关闭，token 吊销后流不会断
  // （评审 PR#23 reviewer M1：不能把它挂进 Promise.all，否则 revoke 后 agentd 永不退出）。
  await Promise.all([claimLoop(), heartbeatLoop()]);
  // 两个决策循环返回（正常退出/revoke/token_revoked）即收敛退出，残留流由 process.exit 关断。
  sse.stop();
  void sseTask;
  log('info', 'agentd exiting', { revoke: state.revokeReason });
  process.exit(0);
}

main().catch((err) => {
  log('error', 'agentd fatal', { err: String(err?.stack ?? err) });
  process.exit(1);
});
