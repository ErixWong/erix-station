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
// P1 范围（任务约定）：approvals 路径留空（P2）、spool 不落盘（§7.5 待定）。
// P5 去项目化（directory-as-project §2）：同项目并行放行——capacity 默认 1 → 2（pi 对齐，不加锁；
// env ERIX_AGENTD_CAPACITY 可调），同 cwd 两个 run 各自隔离（run 数据/notes/transcript/artifacts
// 全 per-run/per-session），工作文件碰撞由用户 git 自治。

import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MSG, normalizeRoundRecord, sendIpc } from './lib/ipc.js';
import { drainRuns } from './lib/drain.js';
import { parseHeartbeatModels } from './lib/llm-models.js';
import { archiveRunData, prepareRunDataDir, prepareSessionNotesDir, sweepRunDataDir, touchRunDataDir } from './lib/run-data.js';
import { captureAndUploadArtifact } from './lib/artifacts.js';
// 端口呈现优化·观测层 MVP（迁移 0022）：/proc 采样当前真实监听，随 U4 heartbeat 捐带 `listeners`。
// 只读展示用途，不做管控（#246 不变式）；采样失败只报空数组，绝不拖死心跳。
import { collectListeners } from './lib/listeners.js';
// issue #288 启动不变式：只取 shell 超时上限的**解析口径**（与 worker 侧同源），不引入 shell 执行本身。
import { resolveShellMaxTimeoutMs } from './lib/shell-tools.js';

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
  capacity: Number(process.env.ERIX_AGENTD_CAPACITY || 2),
  hbOkPath: process.env.ERIX_HB_OK_PATH || '/run/station/hb-ok',
  heartbeatMs: Number(process.env.ERIX_HEARTBEAT_MS || 15000),
  // /proc 采样根目录（测试可注入 fixture；非 Linux / /proc 不可读 ⇒ listeners 恒空，不影响其余心跳语义）。
  procPath: process.env.ERIX_PROC_PATH || '/proc',
  // issue #79：冷启动 gate 的最长等待——最多 2 个心跳周期（默认 30s）。超时后放行 claim
  // 并 warn「llmModels 未就绪，run 将回退 config 占位模型」，防心跳故障时永久卡死。
  hbInitMaxWaitMs: Number(process.env.ERIX_AGENTD_HB_INIT_MAX_WAIT_MS || 2 * (Number(process.env.ERIX_HEARTBEAT_MS || 15000))),
  batchWindowMs: Number(process.env.ERIX_BATCH_WINDOW_MS || 250),
  batchBytes: Number(process.env.ERIX_BATCH_BYTES || 2048),
  maxEventsPerBatch: 200,
  maxBatchBytes: 256 * 1024,
  // F6：worker 无响应 watchdog——超过此时间无任何 IPC 消息（事件/store/log）→ SIGKILL worker + release requeue。
  // 默认 5min：runToolLoop 在 LLM 流式等待期间也可能长时间无 IPC，阈值必须远大于正常模型等待；env 可调。
  watchdogMs: Number(process.env.ERIX_AGENTD_WATCHDOG_MS || 300000),
  maxPendingEvents: Number(process.env.ERIX_MAX_PENDING_EVENTS || 20000),
  // issue #46：启动清扫 run 数据目录的 mtime 保留期（小时）；0 = 禁用清扫。
  // 必须保留窗口远大于「崩溃 → portal re-claim 同 run（resume）」的间隔，否则会把待 resume
  // 的 notes 当残留删光（race 推导见 runner/lib/run-data.js sweepRunDataDir 头注释）。
  runDataTtlHours: Number(process.env.ERIX_RUN_DATA_TTL_HOURS || 24),
  // issue #64 R1 配套（conversation-state.md §5 P1）：runs-archive/ 归档保留期（小时），
  // 默认 168h=7 天；0 = 禁用归档清扫（一律保留，纯人工/运维兜底）。
  // 用 ?? 而非 ||：显式 0 必须生效（禁用语义），不能被默认值覆盖。
  archiveTtlHours: Number(process.env.ERIX_ARCHIVE_TTL_HOURS ?? 168),
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
  // 审计 #34 评审 A：未完成的终态补报（PUT）——退出前必须等（否则被 process.exit 截断，
  // 退化为 90s reaper 兜底，违背 issue #25 第 4 项「省掉兜底等待」的目的）。
  pendingReports: new Set(),
  sseOk: false,
  sawPing: false,
  revokeReason: null, // 非空 → 停领新任务、收敛后退出
  shutdown: false,
  runs: new Map(), // runId -> RunCtx
  // issue #38 Phase B2：心跳下行的模型集（{main,embedding,vision} 或 null）。仅 IPC 内存传递，
  // **不落文件/日志**。每次心跳刷新；进行中的 run 不受影响（run 边界生效，见 spawnWorker 快照）。
  llmModels: null,
};

/** RunCtx：单个活跃 run 的本地上下文。 */
function makeRunCtx(runId) {
  return {
    runId,
    claimToken: null,
    attempt: 1,
    resume: false,
    // issue #81 P2：transcript key = sessionId（portal ticket 下行）；null = 旧 portal，回退 run 作用域。
    sessionId: null,
    worker: null,
    workerPid: null,
    // 审计 #34 F-A：worker 退出的可等待句柄（drain 用它等「真退出」而非盲退）
    exited: null,
    // 事件批量缓冲
    events: [],
    eventBytes: 0,
    flushTimer: null,
    inflight: false,
    // 终态 barrier
    finishing: false,
    // 已被租约/停止裁决，丢弃后续写
    dropped: false,
    // F6：最后一次 IPC 活动（watchdog 用）。D8 修订（2026-09-24）：cwd = 项目目录，无 worktree 清理路径。
    lastIpcAt: Date.now(),
    projectDir: null,
    // issue #288（缺陷 D）：本次 attempt 内 worker 报上来的 shell 子进程组 id（pgid = child.pid，
    // 源于 `spawn(..., {detached:true})` 使子命令自成进程组）。**不在 worker 的进程组里**，
    // 所以 watchdog/abort 的 `-workerPid` 组杀不到它们（dev 真机实测：第一次 kill 后同时存在
    // attempt 1 的孤儿 `bash -c sleep 360` 与 attempt 2 新起的）⇒ 每一条终止路径补杀整组。
    // Set 而非单值：同一次 attempt 内可以多次 shell 调用（并发/串行都有）。随 attempt 结束清空。
    shellPgids: new Set(),
    // issue #288（缺陷 B）：本 attempt 的死因（watchdog 写入）；null = 还没杀过。
    killReport: null,
  };
}

// ---------------------------------------------------------------------------
// 内部 HTTP 客户端（零依赖，Node 22 fetch；§4.5 重试/错误分类）
// ---------------------------------------------------------------------------
const BACKOFF = [1000, 2000, 5000, 10000, 30000];

/**
 * 等未完成的终态补报（评审 A：fire-and-forget 的 PUT 不得被 process.exit 截断）。
 * 循环等待（非单次快照）：等待期间 onWorkerExit 仍可能把新的补报放进 pendingReports；
 * 总预算 graceMs 封顶，超时即放行（不阻塞容器停止）。调用顺序：**drainRuns 之后**调用。
 */
async function drainPendingReports(graceMs = 2000) {
  const deadline = Date.now() + graceMs;
  while (state.pendingReports.size > 0 && Date.now() < deadline) {
    const pending = [...state.pendingReports].map((p) => p.catch(() => {}));
    await Promise.race([Promise.all(pending), sleep(Math.max(1, deadline - Date.now()))]);
  }
}

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

async function internalRequest(method, p, { body, claimToken, retries = 0, timeoutMs = 30000, contentType, headers: extraHeaders } = {}) {
  const headers = {
    Authorization: `Bearer ${CFG.token}`,
  };
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      // issue #64：artifact 上传等二进制端点（U13）。
      payload = body;
      headers['Content-Type'] = contentType ?? 'application/octet-stream';
    } else {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
    }
    // ⚠️ Content-Length 必须按 UTF-8 字节数：JSON.stringify 返回 string，`.length` 数的是
    //    UTF-16 码元——含中文等多字节字符时小于实际字节数，server 会等永远等不完的字节
    //    → 请求挂起 → 客户端 30s 超时 → network_error 无限重试（#77 真机风暴根因，实测复现）。
    headers['Content-Length'] = Buffer.byteLength(payload);
  } else {
    headers['Content-Type'] = 'application/json';
  }
  if (claimToken) headers['X-Claim-Token'] = claimToken;
  if (extraHeaders) Object.assign(headers, extraHeaders);

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
            beginRevoke('token_revoked');
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
    log('warn', 'revoke received', { reason: payload?.reason ?? 'revoked' });
    beginRevoke(payload?.reason ?? 'revoked');
    return;
  }
  if (event === 'approval_decision') {
    // P1 不实现审批；忽略（P2 接入）。
    return;
  }
}

// ---------------------------------------------------------------------------
// 冷启动 gate（issue #79）：先完成首次心跳（拿到 models 下行写入 state.llmModels）
// 再启动 claimLoop——否则容器冷启动时排队 run 会在首跳前被立刻 claim，RUN_START.models
// 仍是 null → worker 回退 config.json 占位模型名（relay 拒绝「Model ... is not supported」）。
// 心跳持续故障按超时兜底放行（走占位回退 + warn，不永久卡死）。
// deps 全部可注入（heartbeatOnce/sleep/now/log/maxWaitMs）——单测用桩断言启动顺序，非对外契约。
// ---------------------------------------------------------------------------
async function initialHeartbeatGate(deps = {}) {
  const hb = deps.heartbeatOnce ?? heartbeatOnce;
  const sleepImpl = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const logImpl = deps.log ?? log;
  const maxWaitMs = deps.maxWaitMs ?? CFG.hbInitMaxWaitMs;
  const deadline = now() + maxWaitMs;
  let attempt = 0;
  for (;;) {
    try {
      const data = await hb();
      touchHbOk(); // M5：与 heartbeatLoop 同语义——心跳成功刷新健康标记
      // Phase B2：下行模型集（与 heartbeatLoop 同语义）。此后 claim 出的 run 的
      // RUN_START.models 快照取到的即是真实下行模型名，不再回退占位。
      state.llmModels = parseHeartbeatModels(data);
      if (data?.revoked) beginRevoke('revoked'); // 同径兜底，与 heartbeatLoop 一致
      return;
    } catch (err) {
      if (err instanceof InternalError && err.code === 'token_revoked') {
        // 与 claim/heartbeat 同径（issue #22 方案②）：吊销即收敛退出，claimLoop 会因
        // revokeReason 首圈即返回，不存在卡死。
        beginRevoke('token_revoked');
        return;
      }
      attempt += 1;
      if (now() >= deadline) {
        logImpl('warn', 'llmModels 未就绪，run 将回退 config 占位模型（initial heartbeat gate timeout）', {
          waited_ms: maxWaitMs, attempts: attempt, err: String(err?.message ?? err),
        });
        return;
      }
      await sleepImpl(Math.min(backoffFor(attempt), Math.max(0, deadline - now())));
    }
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
  // 观测层 MVP：真实监听快照（绝不 throw，双保险再包一层；旧 portal 不认识该字段会直接忽略，additive）。
  let listeners = [];
  try { listeners = collectListeners({ procPath: CFG.procPath, home: CFG.home }); } catch { listeners = []; }
  const r = await internalRequest('POST', '/heartbeat', {
    body: { agent_version: CFG.agentVersion, runs, listeners },
  });
  return r.data;
}

// ---------------------------------------------------------------------------
// 项目目录准备（§6.2，D8 修订 2026-09-24，AGENTS.md §7）：确保 ~/projects/<name> 存在，
// agent 直接在项目目录工作（pi 参照系），不再做 git worktree add。
// ⚠️ 项目目录是用户资产：任何路径不得删除（原 cleanupWorktree 已整体拆除）。
// ---------------------------------------------------------------------------
function prepareProjectCwd(projectName) {
  const projectDir = path.join(CFG.home, 'projects', projectName || 'default');
  fs.mkdirSync(projectDir, { recursive: true });
  return projectDir;
}

/**
 * 解析 run 工作目录（P5）：优先 run.cwd（portal 下发的 ~/projects/<name> 相对形式，权威）；
 * 缺失/非法时回退 run.project?.name（旧 portal 部署序错位兼容）并 warn。任何路径不得删除。
 */
function resolveRunCwd(run) {
  const raw = run?.cwd;
  if (typeof raw === 'string' && raw.length > 0) {
    const m = /^~\/projects\/([^/]+)$/.exec(raw);
    // 形态防线：只认 ~/projects/<name> 一级目录（含 . / .. 拒收），绝不接受任意绝对路径。
    if (m && m[1] !== '.' && m[1] !== '..') {
      const dir = path.join(CFG.home, 'projects', m[1]);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    }
    log('warn', 'run.cwd 形态非法，回退 project name', { run_id: run?.id ?? null, cwd: raw });
  } else {
    log('warn', 'run.cwd 缺失（旧 portal），回退 project name', { run_id: run?.id ?? null, project: run?.project?.name ?? null });
  }
  return prepareProjectCwd(run?.project?.name ?? 'default');
}

// ---------------------------------------------------------------------------
// store_request → internal 端点映射（§9.1；issue #81 P2 起 session 维度）
// ---------------------------------------------------------------------------
// transcript key = ctx.sessionId（引擎 store key，worker 以它调用 TranscriptStore 方法并自检）。
// P2 起 transcript、快照、run-state/status 方法走新 session 端点 `/transcript/:key/...`；writer fencing = 真 runId 经
// ?run_id= query 参数 + X-Claim-Token（portal 校验 writer run 属于该 session 且持有效租约）。
// markRunState('running') 仍走 U2 真 runId（runs 表生命周期，sessionId 绝不进 U2）。
// 旧 portal（ctx.sessionId = null）→ 全部回退 run 作用域旧端点（向后兼容，语义 = main 现状）。

/** session 键一致性自检：worker 传来的引擎 key 必须等于 RUN_START 下行的 sessionId。 */
function assertSessionKey(ctx, args) {
  if (args?.runId !== ctx.sessionId) {
    throw new Error(`transcript key mismatch: worker sent ${String(args?.runId)}, expect session ${ctx.sessionId}`);
  }
  return ctx.sessionId;
}

async function handleStoreRequest(ctx, method, args, deps = {}) {
  const request = deps.request ?? internalRequest;
  const runId = ctx.runId;
  const sessionKey = ctx.sessionId;
  // session 端点公共 query：writer run（租约 fencing）。
  const writerQs = `?run_id=${encodeURIComponent(runId)}`;
  switch (method) {
    case 'appendRound': {
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const record = normalizeRoundRecord(key, args?.record);
        const round = record.round;
        const r = await withRetry(
          () => request('PUT', `/transcript/${encodeURIComponent(key)}/rounds/${round}${writerQs}`, { body: record, claimToken: ctx.claimToken }),
          { what: `appendRound key=${key} round=${round}` },
        );
        return r.data;
      }
      const record = normalizeRoundRecord(runId, args?.record);
      const round = record.round;
      const r = await withRetry(
        () => request('PUT', `/runs/${runId}/transcript/rounds/${round}`, { body: record, claimToken: ctx.claimToken }),
        { what: `appendRound run=${runId} round=${round}` },
      );
      return r.data;
    }
    case 'load': {
      // 分页循环拉全量（runner §9.1 注）：游标是 portal 给的**不透明串** `<round>:<append_seq>`
      // （issue #338 真 keyset）——原样回传并 encodeURIComponent，**绝不 Number()**（会变 NaN ⇒ 死循环）。
      const records = [];
      let cursor = null;
      let pages = 0;
      let maxRound = null;
      const basePath = sessionKey
        ? `/transcript/${encodeURIComponent(assertSessionKey(ctx, args))}`
        : `/runs/${runId}/transcript`;
      for (;;) {
        const paging = cursor == null ? 'limit=10000' : `limit=10000&cursor=${encodeURIComponent(cursor)}`;
        const qs = sessionKey ? `?${paging}&run_id=${encodeURIComponent(runId)}` : `?${paging}`;
        const r = await withRetry(
          () => request('GET', `${basePath}${qs}`, { claimToken: ctx.claimToken }),
          { what: `load ${sessionKey ? `key=${sessionKey}` : `run=${runId}`}` },
        );
        const page = r.data?.records ?? [];
        pages += 1;
        records.push(...page);
        for (const rec of page) {
          if (Number.isFinite(rec?.round) && (maxRound === null || rec.round > maxRound)) maxRound = rec.round;
        }
        cursor = r.data?.next_cursor ?? null;
        if (cursor == null) break;
      }
      // 纯可观测：分页真的发生过才记一条（不是 run event、不前进 run_events、零新错误码）。
      if (pages > 1) {
        log('warn', 'transcript load paged', {
          key: sessionKey ?? runId, run_id: runId, pages, rows: records.length, max_round: maxRound,
        });
      }
      return { records };
    }
    case 'recall': {
      const qs = new URLSearchParams();
      if (args?.fromRound != null) qs.set('from_round', String(args.fromRound));
      if (args?.toRound != null) qs.set('to_round', String(args.toRound));
      qs.set('pattern', String(args?.pattern ?? ''));
      const r = await withRetry(
        () => request('GET', `/runs/${runId}/transcript/recall?${qs.toString()}`, { claimToken: ctx.claimToken }),
        { what: `recall run=${runId}` },
      );
      return r.data;
    }
    case 'markRunState': {
      // 双路语义（issue #81 P2，容易错）：
      // 'running' → U2 /runs/:真runId/state（runs 表生命周期，sessionId 绝不进 U2）；
      // 引擎状态（含终态）→ session run-state status 通道（键 = args.runId = sessionId）。
      const state = args?.state ?? 'running';
      if (state === 'running' || !sessionKey) {
        const endpoint = state === 'running' ? 'state' : 'runstate';
        const r = await withRetry(
          () => request('PUT', `/runs/${runId}/${endpoint}`, { body: { state }, claimToken: ctx.claimToken }),
          { what: `markRunState run=${runId} state=${state}` },
        );
        return r.data;
      }
      const key = assertSessionKey(ctx, args);
      const r = await withRetry(
        () => request('PUT', `/transcript/${encodeURIComponent(key)}/runstate${writerQs}`, { body: { state }, claimToken: ctx.claimToken }),
        { what: `markRunState key=${key} state=${state}` },
      );
      return r.data;
    }
    case 'saveRunState': {
      // run-state 快照与终态 status 分通道；快照方法属于可选的 TranscriptStore 分层能力。
      const runState = args?.runState ?? {};
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const r = await withRetry(
          () => request('PUT', `/transcript/${encodeURIComponent(key)}/runstate${writerQs}`, { body: { run_state: runState }, claimToken: ctx.claimToken }),
          { what: `saveRunState key=${key}` },
        );
        return r.data;
      }
      const r = await withRetry(
        () => request('PUT', `/runs/${runId}/runstate`, { body: { run_state: runState }, claimToken: ctx.claimToken }),
        { what: `saveRunState run=${runId}` },
      );
      return r.data;
    }
    case 'loadRunState': {
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const r = await withRetry(
          () => request('GET', `/transcript/${encodeURIComponent(key)}/runstate${writerQs}`, { claimToken: ctx.claimToken }),
          { what: `loadRunState key=${key}` },
        );
        log('info', 'store loadRunState', { session_key: key, restored: r?.data?.run_state != null });
        return r.data; // {run_state} 或 204 → null
      }
      const r = await withRetry(
        () => request('GET', `/runs/${runId}/runstate`, { claimToken: ctx.claimToken }),
        { what: `loadRunState run=${runId}` },
      );
      // F3（issue #43 评审）：loadRunState 仅引擎 resume 路径调用（attempt ≥ 2 的 re-claim）。
      // 留痕 = 「恢复读」请求痕迹：wp3b-e2e 用它区分 attempt2 真的经 loadRunState 恢复
      // （vs 只靠 attempt2 自己的 saveRunState 也能通过的假绿）。每 resume 仅 1 次，低量。
      log('info', 'store loadRunState', { run_id: runId, restored: r?.data?.run_state != null });
      return r.data; // {run_state} 或 204 → null
    }
    case 'loadRunStateStatus': {
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const r = await withRetry(
          () => request('GET', `/transcript/${encodeURIComponent(key)}/runstate/status${writerQs}`, { claimToken: ctx.claimToken }),
          { what: `loadRunStateStatus key=${key}` },
        );
        return r.data; // {status:{status,...}}；无状态时 204 → null
      }
      const r = await withRetry(
        () => request('GET', `/runs/${runId}/runstate/status`, { claimToken: ctx.claimToken }),
        { what: `loadRunStateStatus run=${runId}` },
      );
      return r.data;
    }
    case 'saveRunSnapshot': {
      const revision = Number(args?.revision ?? 0);
      const snapshot = args?.snapshot ?? {};
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const r = await withRetry(
          () => request('PUT', `/transcript/${encodeURIComponent(key)}/checkpoint${writerQs}`, { body: { revision, snapshot }, claimToken: ctx.claimToken }),
          { what: `saveRunSnapshot key=${key} rev=${revision}` },
        );
        return r.data;
      }
      const r = await withRetry(
        () => request('PUT', `/runs/${runId}/checkpoint`, { body: { revision, snapshot }, claimToken: ctx.claimToken }),
        { what: `saveRunSnapshot run=${runId} rev=${revision}` },
      );
      return r.data;
    }
    case 'loadLatestRunSnapshot': {
      if (sessionKey) {
        const key = assertSessionKey(ctx, args);
        const r = await withRetry(
          () => request('GET', `/transcript/${encodeURIComponent(key)}/checkpoint/latest${writerQs}`, { claimToken: ctx.claimToken }),
          { what: `loadLatestRunSnapshot key=${key}` },
        );
        return r.data; // {checkpoint:{snapshot,revision,updated_at}} 或 204 → null
      }
      const r = await withRetry(
        () => request('GET', `/runs/${runId}/checkpoint/latest`, { claimToken: ctx.claimToken }),
        { what: `loadLatestRunSnapshot run=${runId}` },
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
 * revoke 统一入口（issue #22 评审 F2）：置位 + abort 全部在跑 run。
 * 三个信号源（SSE revoke / claim 401 token_revoked / heartbeat 401 token_revoked）必须同径，
 * 否则某个循环先行退出时会遗留 detached worker 与未清理的 runs（评审实测：心跳 401 原实现无 abort）。
 * 补报语义：abort 后 onWorkerExit 对 stop_* 补报 U2；revoked 场景不补报——token 已吊销，U2 必 401，
 * 终态由 portal 侧收敛（active runs 收敛属 issue #22 F6 follow-up）。
 */
function beginRevoke(reason) {
  state.revokeReason = reason;
  log('warn', 'revoke begin', { reason, active_runs: state.runs.size });
  for (const ctx of state.runs.values()) {
    abortRun(ctx, 'revoked');
  }
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
// issue #288：`kill` 可注入（watchdog 单测要「先杀 -workerPid、再杀登记的每个 -pgid」的**真实顺序**，
// 只靠真进程做不到确定性观测）；缺省仍是 `process.kill`，既有调用点（drain / abort / cleanup）行为不变。
const defaultProcessKill = (pid, sig) => { process.kill(pid, sig); };

function killProcessGroup(pid, sig, kill = defaultProcessKill) {
  try { kill(-pid, sig); return; } catch {}
  try { kill(pid, sig); } catch {}
}

/**
 * issue #288（缺陷 D）：补杀本 attempt 内 worker 报上来的**全部 shell 子进程组**。
 *
 * 为什么需要：`runner/lib/shell-tools.js:138` 用 `spawn(..., {detached:true})`，子命令因此
 * **自成一个进程组**，不是 worker 组的成员 ⇒ `killProcessGroup(workerPid)` 杀不到它。
 * dev 真机（run `e480a06f…`）：第一次 watchdog kill 后同时存在 attempt 1 的孤儿 `bash -c sleep 360`
 * （etime 05:46）与 attempt 2 新起的（etime 00:18）；`sleep` 自己会退出所以相安无事，
 * **常驻服务命令会跨 attempt 无限累加**。
 *
 * 为什么不能放在 worker 侧 `process.on('exit')`：watchdog 用的是 **SIGKILL**，worker 没机会跑任何
 * handler（该前提由 `runner/test/shell-liveness.test.js` 的真进程用例钉住）。
 *
 * @param {{runId:string, shellPgids?:Set<number>}} ctx
 * @param {{kill?:(pid:number,sig:string)=>void, log?:(level:string,msg:string,extra?:object)=>void}} [deps]
 * @returns {number[]} 实际发了信号的 pgid 列表（已清空登记集，重复调用为空）
 */
function killShellChildGroups(ctx, { kill = defaultProcessKill, logImpl = log } = {}) {
  const pgids = [...(ctx.shellPgids ?? [])];
  if (pgids.length === 0) return [];
  // 先清空再杀：同一次终止会在多条路径上过（watchdog kill → onWorkerExit → cleanupRun），
  // 登记集只能被消费一次；杀不掉的（ESRCH=自然退出）也不需要重试。
  ctx.shellPgids = new Set();
  const killed = [];
  for (const pgid of pgids) {
    try {
      kill(-pgid, 'SIGKILL');
      killed.push(pgid);
    } catch (err) {
      // ESRCH = 组已自然退出（竞态，正常）；其它失败也不能阻断终止流程，但要留痕。
      logImpl('warn', 'shell child group kill failed (ignored)', {
        run_id: ctx.runId, pgid, code: err?.code ?? null, msg: String(err?.message ?? err),
      });
    }
  }
  if (killed.length > 0) {
    logImpl('warn', 'orphan shell child groups killed', { run_id: ctx.runId, pgids: killed, count: killed.length });
  }
  return killed;
}

/**
 * `shell_liveness` 消息的宿主侧账本（issue #288 缺陷 A + D）。**不是**事件通道：绝不进
 * `enqueueEvent`（⇒ 不产生 U3/run_events 行，模型与前端都看不见它），只刷活动戳 + 记 pgid。
 * @param {object} ctx RunCtx
 * @param {{phase?:string, pgid?:number, command?:string}} msg
 * @param {{now?:()=>number, log?:(level:string,msg:string,extra?:object)=>void}} [deps]
 * @returns {'spawn'|'exit'|'heartbeat'|'ignored'} 记账结果（`ignored` = 字段不合法，已丢）
 */
function applyShellLiveness(ctx, msg, { now = Date.now, logImpl = log } = {}) {
  const phase = msg?.phase;
  if (phase !== 'spawn' && phase !== 'exit' && phase !== 'heartbeat') return 'ignored';
  // 保活的承重动作就是这一行：心跳到达 ⇒ watchdog 的静默计时归零。
  ctx.lastIpcAt = now();
  if (phase === 'heartbeat') {
    logImpl('debug', 'shell liveness heartbeat', { run_id: ctx.runId, pgid: msg.pgid ?? null, silent_ms: 0 });
    return 'heartbeat';
  }
  const pgid = Number(msg.pgid);
  if (!Number.isInteger(pgid) || pgid <= 0) {
    logImpl('warn', 'shell liveness without usable pgid', { run_id: ctx.runId, phase, pgid: msg.pgid ?? null });
    return 'ignored';
  }
  if (!ctx.shellPgids) ctx.shellPgids = new Set();
  if (phase === 'spawn') ctx.shellPgids.add(pgid);
  else ctx.shellPgids.delete(pgid);
  logImpl('debug', 'shell child group registered', {
    run_id: ctx.runId, phase, pgid, pending: ctx.shellPgids.size, command: typeof msg.command === 'string' ? msg.command.slice(0, 120) : undefined,
  });
  return phase;
}

/**
 * F6 watchdog 单轮巡检（从 heartbeatLoop 里抽出：「谁被杀、按什么顺序杀」必须可被单测确定性驱动）。
 * 行为与抽出前逐字一致：跳过无 worker / 正在收尾的 ctx → 刷 run 数据目录活动戳 → 静默超阈值则
 * **先 SIGKILL worker 组，再补杀登记的 shell 子进程组**（issue #288 缺陷 D 的顺序红线）。
 * @returns {Array<{run_id:string, silent_ms:number}>} 本轮判死的 run
 */
function sweepWatchdog({
  runs = state.runs.values(),
  now = Date.now(),
  watchdogMs = CFG.watchdogMs,
  kill = defaultProcessKill,
  refreshActivity = (ctx) => touchRunDataDir(CFG.home, ctx.runId),
  logImpl = log,
} = {}) {
  const killedRuns = [];
  for (const ctx of runs) {
    if (!ctx.worker || ctx.finishing) continue;
    try {
      refreshActivity(ctx);
    } catch (err) {
      logImpl('warn', 'run data activity refresh failed', { run_id: ctx.runId, err: String(err?.message ?? err) });
    }
    const silentMs = now - ctx.lastIpcAt;
    if (silentMs > watchdogMs) {
      logImpl('warn', 'watchdog: worker silent, killing', {
        run_id: ctx.runId, silent_ms: silentMs, threshold_ms: watchdogMs });
      // issue #288（缺陷 B）：记下「怎么死的」，供随后真正发生在 `onWorkerExit` 里的 release 上报
      // （watchdog 只负责杀，release 在 worker 退出之后，两者不同帧）。
      ctx.killReport = { killed_by: 'watchdog', silent_ms: silentMs };
      if (ctx.workerPid) killProcessGroup(ctx.workerPid, 'SIGKILL', kill);
      // 顺序：worker 组先走，否则 shell 子进程还能被活着的 worker 自己收一轮。
      killShellChildGroups(ctx, { kill, logImpl });
      killedRuns.push({ run_id: ctx.runId, silent_ms: silentMs });
    }
  }
  return killedRuns;
}

/**
 * issue #288 启动不变式：`watchdogMs < shell 超时上限` 时打一条 **warn**，点名本容器对
 * 「shell 执行期心跳保活」的依赖（心跳通道失效时仍会误杀）并打印两个数值。
 * ⚠ **故意不自动抬高 watchdogMs**：抬高会同时拖长「worker 真死」的发现时间（F6 watchdog 的存在理由），
 * 拿一个洞换另一个洞。默认形态（300s / 600s）就落在这条 warn 上——那是设计内的常态，不是故障。
 * @returns {boolean} 是否打了 warn
 */
function warnIfWatchdogBelowShellMax({
  watchdogMs = CFG.watchdogMs,
  shellMaxTimeoutMs = resolveShellMaxTimeoutMs(),
  logImpl = log,
} = {}) {
  if (watchdogMs >= shellMaxTimeoutMs) return false;
  logImpl('warn', 'watchdog threshold below shell max timeout: shell liveness heartbeat is the only guard', {
    watchdog_ms: watchdogMs,
    shell_max_timeout_ms: shellMaxTimeoutMs,
    hint: '长命令（shell 工具 timeout_ms 可到 shell_max_timeout_ms）执行期零引擎 IPC，'
      + '不误杀全靠 worker 侧 shell 心跳保活（runner/lib/shell-tools.js → agentd `shell_liveness`）；'
      + '心跳通道失效（worker 被 SIGSTOP / IPC 通道死）时仍会误杀并 requeue。'
      + '要么抬 ERIX_AGENTD_WATCHDOG_MS ≥ ERIX_SHELL_MAX_TIMEOUT_MS（代价：worker 真死发现得更慢），'
      + '要么降 ERIX_SHELL_MAX_TIMEOUT_MS。',
  });
  return true;
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
      // 审计 #36-4：只在「仍是同一个在跑的 worker」时强杀——5s 后 pid 可能已被 OS 回收复用给无关进程。
      // 退出时 onWorkerExit 置 ctx.workerPid = null，cleanupRun 使 ctx 离开 state.runs → 两个条件都不成立。
      if (pid && ctx.workerPid === pid && state.runs.get(ctx.runId) === ctx) {
        killProcessGroup(pid, 'SIGKILL');
        // issue #288 缺陷 D：worker 组里没有 shell 子命令（detached 自成一族），跟着补一刀。
        killShellChildGroups(ctx);
      }
    }, 5000);
  } else {
    // 无 IPC 通道（worker 已退出或从未连上）：没有宽限可等，登记过的 shell 组当场就成孤儿。
    killShellChildGroups(ctx);
  }
  log('info', 'abort run', { run_id: ctx.runId, reason });
}

// ---------------------------------------------------------------------------
// worker 生命周期（§5/§6）
// ---------------------------------------------------------------------------
function buildWorkerEnv(runStart, baseEnv = process.env) {
  const childEnv = { ...baseEnv };
  // §11：worker 无凭据——剔除 token；HOME 指向 erix（工作区属主）。
  delete childEnv.ERIX_STATION_TOKEN;
  childEnv.HOME = CFG.home;
  childEnv.FDE_CONTAINER_USER = CFG.homeUser;
  const identity = runStart?.git_identity;
  if (typeof identity?.name === 'string' && typeof identity.email === 'string') {
    childEnv.GIT_AUTHOR_NAME = identity.name;
    childEnv.GIT_AUTHOR_EMAIL = identity.email;
    childEnv.GIT_COMMITTER_NAME = identity.name;
    childEnv.GIT_COMMITTER_EMAIL = identity.email;
  }
  return childEnv;
}

function spawnWorker(ctx, runStart) {
  const child = fork(WORKER_PATH, [], {
    uid: CFG.workerUid,
    gid: CFG.workerGid,
    detached: true, // M2：独立进程组，watchdog/abort 可整组杀
    env: buildWorkerEnv(runStart),
    cwd: runStart.cwd,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  ctx.worker = child;
  ctx.workerPid = child.pid ?? null;
  ctx.lastIpcAt = Date.now();
  // 审计 #34 F-A：可等待的退出句柄（与下面 onWorkerExit 并存——exit 事件可多监听）
  ctx.exited = new Promise((resolve) => { child.once('exit', () => resolve()); });

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
    case MSG.SHELL_LIVENESS: {
      // issue #288（缺陷 A + D）：shell 执行期保活 + 子进程组登记。
      // ⚠ 上面已统一刷过 `ctx.lastIpcAt = Date.now()`（任意 IPC 都算 worker 活着），
      // 保活的「刷活动戳」一半是免费的；这里只负责另一半（pgid 账本）。applyShellLiveness 自己
      // 也会刷一次（单测直接驱动它时不能依赖调用点），两次赋值同义、幂等。
      // **本分支绝不往事件队列里塞东西**：它是宿主内部信号，不是 run_events/U3 事件。
      if (msg.run_id === ctx.runId) applyShellLiveness(ctx, msg);
      break;
    }
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
    // 方案②（issue #25 第 4 项）：stop 场景租约仍在我方 → 显式上报终态，省掉 90s 租约 reaper
    // 兑底等待（「停止」体验立竿见影）。lease_lost 场景租约已易主，写必 409 → 仅清理；
    // revoked 场景 token 已吊销，U2 必 401 → 也不补报（issue #22 评审 F3，终态由 portal 收敛）。
    if (ctx.dropReason === 'stop_request' || ctx.dropReason === 'stop_heartbeat') {
      // 审计 #34 评审 A：track 未完成的补报（见 state.pendingReports），退出前由 drainPendingReports 等待。
      const p = reportTerminalAfterDrop(ctx).finally(() => state.pendingReports.delete(p));
      state.pendingReports.add(p);
      // issue #64 R1：stop 路径是终态（补报 aborted）→ 清场前先捕获产物（best-effort），
      // 捕获完成后照常清场（含 run 数据目录）。lease_lost/revoked 非本端收敛 → 走下方 else 不捕获。
      captureRunArtifact(ctx).finally(() => cleanupRun(ctx, { archiveRunData: true }));
    } else {
      cleanupRun(ctx, { archiveRunData: false });
    }
    return;
  }
  // 非预期退出且未终态 → release + 重新认领（§6.4 worker 崩溃）。
  if (!ctx.finishing && (code !== 0 || signal)) {
    log('warn', 'worker crashed', { run_id: ctx.runId, code, signal });
    // issue #288（缺陷 B）：被 watchdog 杀掉的也走这条 exit 路（SIGKILL ⇒ 非零退出），**不得**仍按
    // 「worker 自己崩了」上报，否则用户看到的仍是一个误诊的理由。portal 捨 killed_by 写 attempt_killed。
    const report = ctx.killReport ?? { killed_by: 'crash' };
    const reason = report.killed_by === 'watchdog' ? 'watchdog_silent' : 'worker_crashed';
    releaseAndRequeue(ctx, reason, report);
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
    // issue #322：标题**归 portal 生成**（`session-title.js` → `title-llm.js` → `llm-chat.js`），worker
    // 侧不再起标题 ⇒ 这个字段现在恒是空串。本行只保留**透传**（契约形状一字未改：旧 portal + 新 agentd
    // 的组合下拿到空串即走降级链），`title` 在 U2 上的口径见 `docs/api/portal.md` §9.6。
    title: typeof msg.title === 'string' ? msg.title : '',
  };
  if (!msg.ok && msg.termination?.reason !== 'aborted') {
    body.error = msg.error ?? { code: 'failed', message: 'run failed', retryable: false };
  }

  // issue #46：仅当 U2 确认终态收敛（成功或 run_terminal 幂等命中）才清 run 数据目录；
  // lease_lost（已易主）/其他失败 → 保留（易主后由新持有者重建，本地残留由启动 sweep 兜底）。
  let runTerminalConfirmed = false;
  try {
    const r = await finishRun(ctx, body);
    runTerminalConfirmed = true;
    log('info', 'run finished', { run_id: ctx.runId, state: body.state, run_end_seq: r?.run_end_seq });
  } catch (err) {
    // 409 run_terminal 幂等命中 → 视为成功；lease_lost → 已易主，不再写。
    if (err instanceof InternalError && err.code === 'run_terminal') {
      runTerminalConfirmed = true;
      log('info', 'run finish idempotent', { run_id: ctx.runId });
    } else {
      log('warn', 'run finish failed', { run_id: ctx.runId, code: err?.code, msg: String(err?.message ?? err) });
    }
  }
  // issue #64 R1：终态确认后、清场前捕获产物（best-effort，不阻塞）。
  if (runTerminalConfirmed) await captureRunArtifact(ctx);
  cleanupRun(ctx, { archiveRunData: runTerminalConfirmed });
}

/**
 * issue #64 R1：run 终态产物回收——清场（run 数据目录归档）前捕获并上传（U13）。
 * 仅由「终态已确认」路径调用：onWorkerFinished 收敛成功 / 409 run_terminal 幂等命中、
 * stop 路径（stop_request/stop_heartbeat，补报 aborted 的分支）。
 * 崩溃/lease_lost/revoke/resume 路径**不捕获**——run 还会继续，产物回收只发生在确认终态时。
 * best-effort：lib 内已全量兜底不抛出，失败仅 warn 日志，绝不得阻塞清场。
 */
async function captureRunArtifact(ctx) {
  const result = await captureAndUploadArtifact({
    runId: ctx.runId,
    cwd: ctx.projectDir,
    log,
    upload: ({ buffer, sha256, size }) => internalRequest('PUT', `/runs/${ctx.runId}/artifact`, {
      body: buffer,
      contentType: 'application/gzip',
      timeoutMs: 60000, // 20MB 上传，放宽超时
      headers: { 'X-Sha-256': sha256, 'X-Artifact-Size': String(size) },
    }),
  });
  if (!result.ok) {
    log('warn', 'artifact capture failed (cleanup continues)', { run_id: ctx.runId, error: result.error });
  }
  return result;
}

function cleanupRun(ctx, { archiveRunData: shouldArchive = false } = {}) {
  if (ctx.flushTimer) { clearTimeout(ctx.flushTimer); ctx.flushTimer = null; }
  if (ctx.worker) {
    const pid = ctx.workerPid;
    try { if (ctx.worker.connected) ctx.worker.kill('SIGTERM'); } catch {}
    if (pid) {
      // M2：SIGTERM 后短宽限整组 SIGKILL，防 worker 忽略信号残留。
      // 审计 #37 评审：与 abortRun 的 5s timer 同样的 PID 复用防护——worker 已退出（workerPid=null）
      // 或 ctx 已不在跑（state.runs 移除）时不得杀。
      // 评审 #37 二轮 major：cleanup 语境下不能用 state.runs 校验（cleanupRun 随后立即移除该条目，
      // 条件永假 → 强杀失效）。正确判据 = worker 仍未退出（onWorkerExit 会把 workerPid 置 null）。
      setTimeout(() => {
        if (pid && ctx.workerPid === pid) killProcessGroup(pid, 'SIGKILL');
        // issue #288 缺陷 D：组杀不到 detached 的 shell 子命令，补一刀（登记集已消费过则空操作）。
        killShellChildGroups(ctx);
      }, 2000);
    }
  } else {
    // worker 已退出：还挂在登记集里的就是孤儿（worker 被 SIGKILL 时没机会自己收），当场补杀。
    killShellChildGroups(ctx);
  }
  // issue #46 + #64 R1 配套：run 数据目录仅在终态清理（archiveRunData=true，onWorkerFinished 收敛成功后）
  // **归档**（runs/ → runs-archive/，conversation-state.md §5 P1 真相层归档 TTL 替代物理删除）；
  // releaseAndRequeue（resume/崩溃重排队）与 lease_lost 路径绝不归档——attempt 间 notes 必须保留。
  if (shouldArchive) archiveRunData({ home: CFG.home, runId: ctx.runId, workerUid: CFG.workerUid, workerGid: CFG.workerGid, log });
  state.runs.delete(ctx.runId);
  log('info', 'run cleaned up', { run_id: ctx.runId, archived: shouldArchive });
}

// run 数据目录生命周期（issue #46 选项 A + #64 R1 配套归档修正）实现在 ./lib/run-data.js：
// <CFG.home>/runs/<runId>/notes/ 跨 attempt 保留（resume 可读前序 attempt 的 notes），与 run
// 工作区（D8 修订后 = 项目目录，用户资产不删）生命周期完全解耦；终态确认后归档（runs-archive/），
// 启动 sweep 双扫描（runs/ 残留 TTL + runs-archive/ 归档 TTL，race 推导见该文件头注释）。

async function releaseAndRequeue(ctx, reason, killReport = null) {
  // issue #288（缺陷 B）：additive 上报「本 attempt 是怎么死的」，portal 同事务写 attempt_killed。
  // 无 killReport（fork_failed / prepare_cwd_failed / run_data_failed）⇒ **一个额外字段都不发**，
  // portal 也不写事件（「无 kill 时零事件」两面都得成立）。
  // next_retry_in_ms 本站**故意不发**：下一次 attempt 由同一容器的 claim 循环立即接走，没有固定
  // 延迟可报，拿 0 冒充「立即」就是伪装（portal 侧支持该键，有则写）。
  const body = { reason };
  if (killReport?.killed_by) body.killed_by = killReport.killed_by;
  if (Number.isFinite(killReport?.silent_ms)) body.silent_ms = killReport.silent_ms;
  try {
    const r = await internalRequest('POST', `/runs/${ctx.runId}/release`, { body, claimToken: ctx.claimToken });
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
  ctx.sessionId = typeof run.session_id === 'string' && run.session_id.length > 0 ? run.session_id : null;
  state.runs.set(runId, ctx);

  let cwd;
  try {
    cwd = resolveRunCwd(run);
  } catch (err) {
    log('warn', 'project cwd prep failed', { run_id: runId, err: String(err?.message ?? err) });
    await releaseAndRequeue(ctx, 'prepare_cwd_failed');
    return;
  }
  // D8 修订：cwd 即项目目录（单一事实来源；产物捕获、spawnWorker 均用它）。
  ctx.projectDir = cwd;

  // issue #46（选项 A）：备 run 数据目录（notes 落点，跨 attempt 保留）。
  try {
    ctx.runDataPath = prepareRunDataDir(CFG.home, runId, {
      workerUid: CFG.workerUid,
      workerGid: CFG.workerGid,
    });
  } catch (err) {
    log('warn', 'run data dir prep failed', { run_id: runId, err: String(err?.message ?? err) });
    await releaseAndRequeue(ctx, 'run_data_failed');
    return;
  }

  // issue #392（B 片）：会话 notes 目录（与 run 数据目录并列的**第二条**准备路径，两种语义：
  // run 级目录随终态归档、会话级目录与会话同命）。失败只降级不 requeue，理由见下面下行处注释。
  ctx.notesDir = null;
  if (typeof run.session_id === 'string' && run.session_id.length > 0) {
    try {
      ctx.notesDir = prepareSessionNotesDir(CFG.home, run.session_id, {
        workerUid: CFG.workerUid, workerGid: CFG.workerGid,
      });
    } catch (err) {
      log('warn', 'session notes dir prep failed, fall back to run-scoped notes',
        { run_id: runId, err: String(err?.message ?? err) });
    }
  }

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
    // issue #81 P2：message_id 下行（transcript 预写 dedupKey = `<sessionId>:input:<messageId>`）。
    message_id: run.message_id ?? null,
    attempt: ctx.attempt,
    task: run.task ?? '',
    cwd,
    project: run.project?.name ?? 'default',
    model: run.model ?? null,
    resume: ctx.resume,
    attachments: Array.isArray(run.attachments) ? run.attachments : [],
    // P3 PR③（issue #69 下行退役）：ticket 无 `history`、RUN_START 也不再透传——会话上下文
    // 唯一来源 = transcript resume（conversation-state.md §6 契约③）。
    // issue #46 → #392（B 片）：notesDir 下行。**作用域 = 会话**（`<home>/sessions/<sessionId>/notes`），
    // 不再随 run 终态归档搬走 ⇒ 同一会话的下一个 run 看得见上一个 run 写的笔记（旧语义下
    // `scopeRef=runId`，而本站一条用户消息就是一个 run ⇒ 笔记天然无效）。
    // 无 session_id（无本子的工单/旧下行）⇒ 逐字退回旧的 run 级目录。会话目录备不出来时
    // **降级到 run 级 + warn**，不因此把 run 打死（笔记是加分项，`run_data_failed` 那种崩法不适用于它）。
    notes_dir: ctx.notesDir ?? path.join(ctx.runDataPath, 'notes'),
    config: { model_config_path: path.join(CFG.home, '.erix', 'config.json') },
    // issue #38 Phase B2：模型快照，run 边界生效——此处取的是 **run 启动瞬间**的 state.llmModels，
    // 之后心跳刷新 state.llmModels 不影响本 run（进行中 run 的模型名在其生命周期内锁定）。
    models: state.llmModels,
    ...(run.git_identity ? { git_identity: run.git_identity } : {}),
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
        beginRevoke('token_revoked'); // issue #22 评审 F2：与 SSE/heartbeat 同径，abort 全部在跑 run
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
    // issue #288：巡检本体已抽成 sweepWatchdog（可注入 kill，单测能钉「先 worker 组后 shell 组」的顺序）。
    sweepWatchdog({ now: Date.now() });
    try {
      const data = await heartbeatOnce();
      touchHbOk(); // M5：心跳成功 → 刷新健康标记（healthcheck.sh 读 mtime）
      // Phase B2：刷新下行模型集。旧 portal 不下行 / 无配置 → null（行为与现状一致）。
      state.llmModels = parseHeartbeatModels(data);
      if (data?.revoked) {
        // 审计 #34 F-C：此分支当前不可达（authenticateContainer 对 revoked_at 非空的行先返回
        // 401 token_revoked，吊销走下面的 catch）。保留为**同径兜底**：若将来 portal 改回 200
        // 语义，行为必须与 401 路径一致——abort 全部在跑 run + drain 退出（旧实现只置
        // revokeReason 不 abort，与 runner-integration.md 的 revoke 口径不符）。
        beginRevoke('revoked');
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
        // 普通错误继续转。beginRevoke 统一处理：停心跳 + abort 全部在跑 run + 收敛退出。
        beginRevoke('token_revoked');
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
  const ctxs = [...state.runs.values()];
  for (const ctx of ctxs) {
    abortRun(ctx, 'agent_shutdown');
    // 崩溃恢复方案 B（§6.4/§9.6）：agent 关停属「容器是牲口」——不写终态（U2），
    // 让租约过期后由 portal re-claim（attempt+1、resume）收敛。finishing=true 挡住
    // onWorkerFinished 的 U2 写入（F4 修复后 dropped 也会尝试 U2，这里必须显式豁免），
    // 否则容器 restart 会被误判为永久 failed、恢复路径被劫持（e2e 实测回归）。
    ctx.finishing = true;
  }
  // 审计 #34 F-A：等 worker 真退出（含 SIGKILL 兜底）再退；hard deadline 防“死等”卡住容器停止。
  // 兜底 15s > drain 的 5s + kill grace 2s。tini 仍会 reap 孤儿进程。
  const hardExit = setTimeout(() => {
    log('warn', 'shutdown hard exit (drain did not finish)');
    // issue #288 缺陷 D：process.exit 之后没人再跑 drain/cleanup，孤儿 shell 组必须在这里先杀完。
    for (const c of ctxs) killShellChildGroups(c);
    process.exit(0);
  }, 15000);
  void drainRuns(ctxs, { deadlineMs: 5000, kill: killProcessGroup, log: (m, e) => log('warn', m, e) })
    .then((r) => {
      log('info', 'shutdown drain done', { drained: r.drained, pending: r.pending });
      // issue #288 缺陷 D：drain 的 kill 只能杀 worker 组；pending（SIGKILL 都杀不掉的 D 态 worker）
      // 场景下 onWorkerExit 跑不到 ⇒ cleanupRun 也跑不到 ⇒ 这里兼底。
      for (const c of ctxs) killShellChildGroups(c);
      return drainPendingReports(); // 同上：drain 期间才产生的新补报
    })
    .finally(() => { clearTimeout(hardExit); process.exit(0); });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
async function main() {
  if (!CFG.token) {
    log('error', 'ERIX_STATION_TOKEN missing');
    // 此处无需 drain：尚无 worker（评审 A 指出的例外路径，此处显式说明）。
    process.exit(1);
  }
  // user-space §6.2：容器内进程 umask = 0002（新建文件 664/目录 775，配合同 GID 1000 组协作）。
  // agentd 建项目目录、fork worker（继承 umask）的文件都需跨 UID（1001/1002）组可写。
  process.umask(0o002);
  log('info', 'agentd starting', { base: CFG.baseUrl, capacity: CFG.capacity, worker_uid: CFG.workerUid });
  // issue #288 启动不变式：watchdog 阈值 < shell 超时上限 ⇒ 长命令的存活全靠 shell 心跳保活，打 warn 点名。
  warnIfWatchdogBelowShellMax();

  // issue #46 + #64 R1 配套：清扫上次运行残留的 run 数据目录（终态归档失败/异常退出遗留）与
  // 超归档 TTL 的 runs-archive/ 目录。必须在 claimLoop 之前调用；只删 mtime 超过保留期的目录
  // ——崩溃后待 resume re-claim 的 run 目录 mtime 新鲜必然保留（race 推导见 runner/lib/run-data.js 头注释）。
  sweepRunDataDir({
    home: CFG.home,
    ttlHours: CFG.runDataTtlHours,
    archiveTtlHours: CFG.archiveTtlHours,
    workerUid: CFG.workerUid,
    workerGid: CFG.workerGid,
    log,
  });

  const sse = openSse();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const sseTask = sse.run(); // 后台运行，不 await——SSE 流由 portal 主动关闭，token 吊销后流不会断
  // （评审 PR#23 reviewer M1：不能把它挂进 Promise.all，否则 revoke 后 agentd 永不退出）。
  // issue #79：冷启动 gate——首次心跳成功（models 下行就位）后才放行 claimLoop；
  // 心跳持续故障按 hbInitMaxWaitMs 超时兜底放行（warn，走占位回退），不阻塞启动。
  await initialHeartbeatGate();
  await Promise.all([claimLoop(), heartbeatLoop()]);
  // 两个决策循环返回（正常退出/revoke/token_revoked）即收敛退出，残留流由 process.exit 关断。
  sse.stop();
  void sseTask;
  // 审计 #34 F-A（major）：不能盲退——先 drain（等 worker 真退出、deadline 后强杀）
  // 再退出，否则：① abortRun 的 5s SIGKILL timer 随进程消失 → 挂住的 worker 进程组残留；
  // ② onWorkerExit 不跑 → cleanupRun 不跑 → capacity 不释放、run 数据目录残留（D8 修订后
  //    项目目录是用户资产，本就无 worktree 清理义务）。
  const drained = await drainRuns([...state.runs.values()], { kill: killProcessGroup, log: (m, e) => log('warn', m, e) });
  // 顺序（评审 A 定向复核）：必须**先 drain runs 再等补报**——onWorkerExit 在 drain 期间才把新的补报
  // 放进 pendingReports；反序（先等补报）会漏掉这一批，drainRuns 返回后立即 exit 即截断 PUT。
  await drainPendingReports();
  log('info', 'agentd exiting', { revoke: state.revokeReason, drained: drained.drained, pending: drained.pending });
  process.exit(0);
}

// 仅直接执行（`node agentd.js` / 容器入口）时启动主循环；被测试 import 时不启动。
const isDirectRun = typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(async (err) => {
    log('error', 'agentd fatal', { err: String(err?.stack ?? err) });
    // 审计 #34 评审 A（major）：fatal 可能发生在 worker 已启动之后——与正常退出同等要求：
    // 先给未完成的补报留时间，再 drain worker（短 deadline：已是异常路径，不拖长容器退出）。
    await drainRuns([...state.runs.values()], {
      deadlineMs: 3000, killGraceMs: 1000, kill: killProcessGroup, log: (m, e) => log('warn', m, e),
    }).catch(() => {});
    await drainPendingReports(1000).catch(() => {}); // 同上：drain 期间才产生的新补报
    process.exit(1);
  });
}

// 测试导出（issue #64：终态清场路径的捕获触发用 node:test + stub fetch 覆盖；非对外契约）。
// issue #79：initialHeartbeatGate/state 供冷启动顺序单测注入桩断言（非对外契约）。
// P5：resolveRunCwd 供 cwd 解析/回退语义单测；testConfig 仅暴露 capacity 默认值断言（非对外契约）。
export {
  onWorkerFinished, onWorkerExit, initialHeartbeatGate, state, handleStoreRequest,
  resolveRunCwd, buildWorkerEnv, CFG as testConfig,
  // issue #288：watchdog 巡检 / shell 子进程组账本 / 启动不变式，均为**单测可见面**（非对外契约）。
  sweepWatchdog, killShellChildGroups, applyShellLiveness, warnIfWatchdogBelowShellMax, makeRunCtx,
};
