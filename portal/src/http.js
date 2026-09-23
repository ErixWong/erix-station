// HTTP 服务：零框架 node:http 路由分发。
// 端点：GET /healthz、GET /api/health、POST /api/auth/login（口令→pending_token）、
//       POST /api/auth/login/totp（TOTP→session cookie）、POST /api/auth/logout、GET /api/me + 静态页面。
// 旧路径 /api/login、/api/logout 仅 307 到新路径（不保留旧单步发 cookie 行为）。
// cookie 语义见 docs/api/portal.md §2.5；两步登录见 §2.2/§2.3。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import * as auth from './auth.js';
import * as migrate from './migrate.js';
import * as projects from './projects.js';
import * as sessions from './sessions.js';
import * as idempotency from './idempotency.js';
import * as preview from './preview.js';
import * as internal from './internal.js';
import * as llm from './llm.js';
import * as admin from './admin.js';
import { createDockerClient, onboardFde } from './provisioner.js';
import { createRateLimiter, createSemaphore } from './ratelimit.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 带标准错误信封的 HTTP 异常（route 层统一捕获 → sendJson）。 */
class HttpError extends Error {
  constructor(status, code, message, { retryable = false, details, headers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
    this.headers = headers;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function errorBody(code, message, retryable = false, details) {
  const err = { code, message, retryable };
  if (details !== undefined) err.details = details;
  return { error: err };
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

/** F2：审计前只记 path，剥离所有 query（?preview_ticket=<明文> 等绝不入审计）。 */
function pathOnly(uri) {
  if (typeof uri !== 'string') return '/';
  const q = uri.indexOf('?');
  return q === -1 ? uri : uri.slice(0, q);
}

function sessionCookieHeader(cookie, token) {
  const parts = [`${cookie.name}=${token}`, `Path=${cookie.path}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`, `Max-Age=${cookie.maxAge}`);
  return parts.join('; ');
}

/** 预览 cookie（host-only，无 Domain）——ticket 换取 / 滚动续期重发（portal.md §2.7/§2.8）。 */
function previewCookieHeader(cookie, token) {
  const parts = [`${cookie.name}=${token}`, `Path=${cookie.path}`];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`, `Max-Age=${cookie.maxAge}`);
  return parts.join('; ');
}

function clearCookieHeader(cookie) {
  const parts = [
    `${cookie.name}=`,
    `Path=${cookie.path}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.secure) parts.push('Secure');
  parts.push(`SameSite=${cookie.sameSite}`);
  return parts.join('; ');
}

/** 校验 Content-Type（JSON 端点要求 application/json）。 */
function requireJson(req) {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (ct !== 'application/json') {
    throw new HttpError(400, 'validation_failed', 'Content-Type 必须为 application/json');
  }
}

/** 读取 JSON 请求体：Content-Length 早期拒绝 413；流式超限也 413（不 destroy 连接，回错误信封）。 */
function readJsonBody(req, limit) {
  return new Promise((resolve, reject) => {
    const contentLength = req.headers['content-length'];
    if (contentLength) {
      const n = Number(contentLength);
      if (Number.isFinite(n) && n > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.resume(); // 排空，配合响应 Connection: close
        return;
      }
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large', { details: { max_bytes: limit } }));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'validation_failed', 'invalid JSON body'));
      }
    });
    req.on('error', (e) => reject(e));
  });
}

/**
 * readiness：DB 可达 + 迁移已到 head（baseline + deploy/migrations/*.sql 全部已应用）。
 * 对比实际 migration head（deploy-contract §3.3 / §8），而非仅 baseline 存在。
 */
export async function checkReady(pool, migrationsDir = migrate.defaultMigrationsDir()) {
  try {
    const r = await pool.query(`SELECT version FROM schema_migrations`);
    const applied = new Set((r.rows || []).map((x) => x.version));
    const expected = migrate.computeExpectedVersions(migrationsDir);
    return expected.length > 0 && expected.every((v) => applied.has(v));
  } catch {
    return false;
  }
}

export function createServer({ pool, config, log = console, docker = null }) {
  const loginLimiter = createRateLimiter(config.loginRateLimit);
  // TOTP 失败限流按「账户 + IP」计数（防换新 pending_token 绕过）；单 token 尝试上限单独计。
  const totpLimiter = createRateLimiter({
    maxFailures: config.totpRateLimit.maxFailures,
    windowMs: config.totpRateLimit.windowMs,
    blockMs: config.totpRateLimit.blockMs,
    maxEntries: config.totpRateLimit.maxEntries,
  });
  const totpTokenLimiter = createRateLimiter({
    maxFailures: config.totpRateLimit.perTokenMaxFailures,
    windowMs: config.totpRateLimit.windowMs,
    blockMs: config.totpRateLimit.blockMs,
    maxEntries: config.totpRateLimit.maxEntries,
  });
  const kdfSemaphore = createSemaphore({
    max: config.kdfConcurrency,
    maxQueue: config.kdfQueueLimit,
    queueTimeoutMs: config.kdfQueueTimeoutMs,
  });
  const previewTicketLimiter = createRateLimiter(config.previewTicketRateLimit ?? {
    maxFailures: 20,
    windowMs: 60 * 1000,
    blockMs: 60 * 1000,
    maxEntries: 10000,
  });
  const ctx = { pool, config, log, loginLimiter, totpLimiter, totpTokenLimiter, kdfSemaphore, previewTicketLimiter, docker };
  // issue #38 Phase B2 admin UI：portal serve 进程本就有 config.dockerHost（cli.js serve 的
  // startProvisionerLoop 也用它自建 client——调查结论见 Phase B2 报告），故 provision 端点**可实现**：
  // 按需懒建并缓存 docker client（不持有连接，仅 HTTP 工厂）。测试可经 createServer({ docker }) 注入。
  let lazyDocker = null;
  ctx.adminDocker = () => {
    if (ctx.docker) return ctx.docker;
    if (!lazyDocker) lazyDocker = createDockerClient({ dockerHost: ctx.config.dockerHost });
    return lazyDocker;
  };

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, ctx);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = { ...(err.headers || {}) };
        if (err.status === 413) headers['Connection'] = 'close'; // 未读完的请求体需断开
        sendJson(res, err.status, errorBody(err.code, err.message, err.retryable, err.details), headers);
        return;
      }
      if (err instanceof projects.ProjectError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof sessions.SessionError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof idempotency.IdempotencyError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, err.retryable, err.details));
        return;
      }
      if (err instanceof internal.InternalError) {
        sendJson(res, err.status, errorBody(err.code, err.message, err.retryable, err.details));
        return;
      }
      if (err instanceof llm.LlmError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      if (err instanceof admin.AdminError) {
        sendJson(res, err.httpStatus, errorBody(err.code, err.message, false, err.details));
        return;
      }
      log.error?.('[portal] unhandled:', err);
      if (!res.headersSent) sendJson(res, 500, errorBody('internal', 'internal error'));
      else res.destroy();
    }
  });
}

/**
 * 路径参数中的 UUID 解码 + **归一化为小写**（F5 / reviewer M-4）。
 * UUID 大小写等价（十六进制），但宿主侧会把 session/run id 当**字符串**用：
 *   ① 幂等 `endpoint` 串（`POST /api/sessions/<id>/messages`）——同一 session 的大小写不同会变成两个幂等命名空间；
 *   ② session SSE hub 的 key（`registerSessionClient(sessionId)`）——DB 回读的 id 恒为小写，
 *      用大写路径连上来的客户端会被注册到另一个 key 下，**永远收不到实时事件**。
 * 合法 UUID 的字符集（0-9a-f）不受影响；仍按原样交给各自的 UUID 正则/DB 查询（非法值照常 404）。
 */
function decodeUuid(raw) {
  return decodeURIComponent(raw).toLowerCase();
}

async function route(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  // admin UI 页面（issue #38 Phase B2）：GET /admin 服务 admin.html。
  // 未登录 → 302 /（与登录页同入口）；非 admin → 403（与 /api/admin/* 的错误信封一致）。
  if (pathname === '/admin') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    let session = null;
    try {
      session = await requireSession(req, ctx);
    } catch {
      session = null; // 未登录 → 302 到登录页
    }
    if (!session) {
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
    }
    if (session.user.role !== 'admin') {
      return sendJson(res, 403, errorBody('forbidden', 'forbidden'));
    }
    return sendStaticFile(res, path.join(path.resolve(ctx.config.staticDir), 'admin.html'));
  }

  if (pathname === '/healthz' || pathname === '/api/health') {
    if (req.method !== 'GET') {
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    const ok = await checkReady(ctx.pool);
    if (ok) return sendJson(res, 200, { status: 'ok' });
    return sendJson(res, 503, errorBody('migration_failed', 'not ready'));
  }

  if (pathname.startsWith('/api/')) {
    return routeApi(req, res, ctx, url);
  }

  return serveStatic(req, res, ctx, url);
}

async function routeApi(req, res, ctx, url) {
  const { pathname } = url;
  const { pool, config } = ctx;

  // 兼容旧路径：仅 307 到新路径，不保留旧的单步发 cookie 行为（portal.md §0.1）。
  if (req.method === 'POST' && pathname === '/api/login') {
    res.writeHead(307, { Location: '/api/auth/login' });
    res.end();
    return;
  }
  if (req.method === 'POST' && pathname === '/api/logout') {
    res.writeHead(307, { Location: '/api/auth/logout' });
    res.end();
    return;
  }

  // 容器 → portal 全出站通道（per-container token 鉴权，不经 forwardAuth，portal.md §9）。
  if (pathname.startsWith('/api/internal/')) {
    return handleInternal(req, res, ctx, url);
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    return handleLoginStep1(req, res, ctx);
  }

  if (req.method === 'POST' && pathname === '/api/auth/login/totp') {
    return handleLoginTotp(req, res, ctx);
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const token = getCookie(req, config.cookie.name);
    if (!token) throw new HttpError(401, 'unauthorized', 'unauthorized');
    await auth.revokeSession(pool, token);
    res.writeHead(204, { 'Set-Cookie': clearCookieHeader(config.cookie) });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const token = getCookie(req, config.cookie.name);
    if (!token) throw new HttpError(401, 'unauthorized', 'unauthorized');
    const session = await auth.findSessionUser(pool, token);
    if (!session) throw new HttpError(401, 'unauthorized', 'unauthorized');
    const renewed = await auth.renewSession(pool, session.session.id, {
      ttlSeconds: config.sessionTtlSeconds,
      renewIntervalMs: config.sessionRenewIntervalSeconds * 1000,
    });
    const headers = {};
    if (renewed) headers['Set-Cookie'] = sessionCookieHeader(config.cookie, token);
    return sendJson(res, 200, { user: session.user }, headers);
  }

  // 边缘授权回调（Traefik forwardAuth）：非浏览器 API，不要求 session cookie。
  if (pathname === '/api/forward-auth') {
    return handleForwardAuth(req, res, ctx);
  }

  // ---- 项目与端口（portal.md §3） ----
  if (pathname === '/api/projects') {
    if (req.method === 'POST') return handleCreateProject(req, res, ctx);
    if (req.method === 'GET') return handleListProjects(req, res, ctx);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    if (req.method === 'GET') return handleGetProject(req, res, ctx, projectId);
    if (req.method === 'PATCH') return handlePatchProject(req, res, ctx, projectId);
    if (req.method === 'DELETE') return handleDeleteProject(req, res, ctx, projectId);
  }
  // F10：端口列表（portal.md §4.7）——复用 getProject 的 ports 查询。
  const projectPortsMatch = pathname.match(/^\/api\/projects\/([^/]+)\/ports$/);
  if (projectPortsMatch) {
    const projectId = decodeURIComponent(projectPortsMatch[1]);
    if (req.method === 'GET') return handleGetProjectPorts(req, res, ctx, projectId);
  }
  // 预览 ticket 签发（portal.md §2.8）。
  const portTicketMatch = pathname.match(/^\/api\/ports\/([^/]+)\/preview-ticket$/);
  if (portTicketMatch) {
    const portId = decodeURIComponent(portTicketMatch[1]);
    if (req.method === 'POST') return handlePreviewTicket(req, res, ctx, portId);
  }

  // ---- 会话与对话（portal.md §4/§5）----
  if (pathname === '/api/sessions') {
    if (req.method === 'POST') return handleCreateSession(req, res, ctx);
    if (req.method === 'GET') return handleListSessions(req, res, ctx);
  }
  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const sessionId = decodeUuid(sessionMatch[1]);
    if (req.method === 'GET') return handleGetSession(req, res, ctx, sessionId);
    if (req.method === 'PATCH') return handlePatchSession(req, res, ctx, sessionId);
    if (req.method === 'DELETE') return handleArchiveSession(req, res, ctx, sessionId);
  }
  if (req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/messages$/.test(pathname)) {
    return handlePostMessage(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/)[1]));
  }
  if (req.method === 'GET' && /^\/api\/sessions\/([^/]+)\/events$/.test(pathname)) {
    return handleSessionStream(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/events$/)[1]));
  }
  if (req.method === 'POST' && /^\/api\/sessions\/([^/]+)\/stop$/.test(pathname)) {
    return handleStopSession(req, res, ctx, decodeUuid(pathname.match(/^\/api\/sessions\/([^/]+)\/stop$/)[1]));
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const runId = decodeUuid(runMatch[1]);
    if (req.method === 'GET') return handleGetRun(req, res, ctx, runId);
  }

  // ---- admin LLM 配置（issue #38 Phase A；requireAdmin 鉴权） ----
  if (pathname.startsWith('/api/admin/')) {
    return handleAdminApi(req, res, ctx, url);
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

// ---------------------------------------------------------------------------
// admin LLM 配置端点（issue #38 Phase A）
// ---------------------------------------------------------------------------

/** admin 鉴权：session 用户 role 必须为 'admin'，否则 403 forbidden。 */
async function requireAdmin(req, ctx) {
  const session = await requireSession(req, ctx);
  if (session.user.role !== 'admin') throw new HttpError(403, 'forbidden', 'forbidden');
  return session;
}

async function handleAdminApi(req, res, ctx, url) {
  const { pathname } = url;
  const session = await requireAdmin(req, ctx); // 所有 /api/admin/* 端点统一先鉴权

  // 供应商 CRUD
  if (pathname === '/api/admin/llm/providers') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await llm.listProviders(ctx.pool));
    }
    if (req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const provider = await llm.createProvider(ctx.pool, { name: body?.name, base_url: body?.base_url });
      return sendJson(res, 201, { provider });
    }
  }
  const adminProviderMatch = pathname.match(/^\/api\/admin\/llm\/providers\/([^/]+)$/);
  if (adminProviderMatch) {
    const providerId = decodeUuid(adminProviderMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      // N2（Round C 评审）：base_url/enabled 变更撞活跃 run 由 updateProvider 在**同一事务内**守卫
      // （409 active_run_conflict，不写变更/不写 outbox）；force=true 透传放行。
      const provider = await llm.updateProvider(ctx.pool, providerId, {
        base_url: body?.base_url,
        enabled: body?.enabled,
        force: body?.force === true,
      });
      return sendJson(res, 200, { provider });
    }
    if (req.method === 'DELETE') {
      await llm.deleteProvider(ctx.pool, providerId);
      res.writeHead(204);
      res.end();
      return;
    }
  }
  const adminProviderModelsMatch = pathname.match(/^\/api\/admin\/llm\/providers\/([^/]+)\/models$/);
  if (adminProviderModelsMatch && req.method === 'POST') {
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const model = await llm.createModel(ctx.pool, {
      provider_id: decodeUuid(adminProviderModelsMatch[1]),
      model_id: body?.model_id,
      name: body?.name,
      type: body?.type,
      tool_calling: body?.tool_calling,
      context_window: body?.context_window,
    });
    return sendJson(res, 201, { model });
  }

  // 模型 CRUD
  const adminModelMatch = pathname.match(/^\/api\/admin\/llm\/models\/([^/]+)$/);
  if (adminModelMatch) {
    const modelId = decodeUuid(adminModelMatch[1]);
    if (req.method === 'PATCH') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const model = await llm.updateModel(ctx.pool, modelId, {
        name: body?.name,
        enabled: body?.enabled,
        tool_calling: body?.tool_calling,
        context_window: body?.context_window,
      });
      return sendJson(res, 200, { model });
    }
    if (req.method === 'DELETE') {
      await llm.deleteModel(ctx.pool, modelId);
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // admin 用户管理（issue #38 Phase B2 admin UI）
  if (pathname === '/api/admin/users') {
    if (req.method === 'GET') {
      return sendJson(res, 200, await admin.listUsers(ctx.pool));
    }
    if (req.method === 'POST') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const created = await admin.createUser(ctx.pool, {
        actorId: session.user.id,
        login: body?.login,
        display_name: body?.display_name,
        password: body?.password,
        fde_name: body?.fde_name,
        totpIssuer: ctx.config.totp?.issuer,
        limits: {
          maxLoginLength: ctx.config.maxLoginLength,
          maxPasswordLength: ctx.config.maxPasswordLength,
        },
      });
      // totp_secret 仅此响应出现一次（红线）；列表/其它端点永不回显。
      return sendJson(res, 201, created);
    }
  }

  // FDE 容器 provision（调查结论：portal serve 进程有 config.dockerHost，client 懒建，端点可实现）
  const adminProvisionMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/provision$/);
  if (adminProvisionMatch && req.method === 'POST') {
    const fdeName = decodeURIComponent(adminProvisionMatch[1]);
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    let out;
    try {
      out = await onboardFde(ctx.pool, ctx.config, { fdeName, docker: ctx.adminDocker(), log: ctx.log });
    } catch (err) {
      // 对账循环仍在后台跑，失败不致命——把原因回给 admin（无敏感信息）。
      throw new HttpError(500, 'provision_failed', String(err?.message ?? err));
    }
    return sendJson(res, 200, {
      fde: fdeName,
      network: out.networkName,
      subnet: out.subnet,
      container: out.containerName,
    });
  }

  // per-FDE LLM 配置（回显只给掩码；api_key 缺省 = 保留旧值）
  const adminFdeLlmMatch = pathname.match(/^\/api\/admin\/fdes\/([^/]+)\/llm$/);
  if (adminFdeLlmMatch) {
    const fdeName = decodeURIComponent(adminFdeLlmMatch[1]);
    if (!projects.validateFdeName(fdeName).ok) {
      throw new HttpError(400, 'validation_failed', 'fde_name 非法', { details: { field: 'fde_name' } });
    }
    if (req.method === 'GET') {
      // 无配置 200 + null；api_key 永不出响应（只掩码）。
      // active_run（口径同 sessions.js ACTIVE_RUN_STATES）：true 时 UI 提示「换供应商/key 将被服务端 409
      // 拒绝（F6 守卫见 PUT 分支）」；纯模型变更不受影响（run 边界生效）。
      const config = await llm.getFdeLlmEcho(ctx.pool, fdeName);
      let activeRun = false;
      if (config) {
        const u = await ctx.pool.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
        if (u.rows[0]) activeRun = await admin.fdeHasActiveRun(ctx.pool, u.rows[0].id);
      }
      return sendJson(res, 200, { config, active_run: activeRun });
    }
    if (req.method === 'PUT') {
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      // F6（Round B 评审，fail-visible）：运行中换 provider/key 会**静默**改变运行中 run 的上游
      //（RUN_START 只快照 models，provider/key 由 Traefik 当前路由决定）——撞活跃 run 时服务端拒绝：
      //   ① provider 事实变化（provider_id 值变化；无旧配置时首次给上游 = 从「无路由」变「有路由」）；
      //   ② 凭据事实变化（与当前配置值比较：缺省=保留旧值不算变化；显式新 key 或显式 null=清空都算）。
      // 纯模型变更（main/embedding/vision）不受守卫：模型本就是 run 边界生效（RUN_START 快照），不误伤。
      // 显式 force=true 放行（管理员知情确认），放行后仍正常写 outbox。
      if (body?.force !== true) {
        const u = await ctx.pool.query(`SELECT id FROM users WHERE fde_name = $1 AND status = 'active'`, [fdeName]);
        const userId = u.rows[0]?.id;
        if (userId && await admin.fdeHasActiveRun(ctx.pool, userId)) {
          // N1（Round C 评审）：判定「凭据事实是否真的变化」——与**当前配置值**比较，而不是
          // 「是否显式传了非空值」。旧口径把显式 api_key:null 当「无变更」放过，而 llm.js 会把它
          // 写成 api_key=NULL → 运行中静默清空凭据（路由消失，run 的 LLM 调用直接失败）。
          // current 含明文 key：仅用于内存比较，绝不写进日志/错误（红线 ③）。
          // 注：这只是事务外预检（快路径）；权威复检在 setFdeLlmConfig 事务内（N3，防并发 PUT）。
          const current = await llm.getFdeLlmConfig(ctx.pool, userId);
          const providerChanged = body?.provider_id !== undefined && body.provider_id !== (current?.provider_id ?? null);
          const keyChanged = body?.api_key !== undefined && (body.api_key ?? null) !== (current?.api_key ?? null);
          if (providerChanged || keyChanged) {
            throw new HttpError(409, 'active_run_conflict',
              '该 FDE 有进行中的 run：更换供应商或 API key 会改变运行中 run 的上游/凭据。'
              + '确认无影响请带 force=true 重试。');
          }
        }
      }
      // N3：force 透传——权威复检在 setFdeLlmConfig 事务内（advisory lock 之后、写入之前），
      // 上方事务外预检只是快路径（提前 409，不进事务）。
      const config = await llm.setFdeLlmConfig(ctx.pool, {
        actorId: session.user.id,
        fdeName,
        provider_id: body?.provider_id,
        api_key: body?.api_key,
        main_model_id: body?.main_model_id,
        embedding_model_id: body?.embedding_model_id,
        vision_model_id: body?.vision_model_id,
        force: body?.force === true,
      });
      return sendJson(res, 200, { config });
    }
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

async function handleListSessions(req, res, ctx) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const result = await sessions.listSessions(ctx.pool, {
    userId: session.user.id,
    projectId: url.searchParams.get('project_id') || undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    limit: url.searchParams.get('limit') || undefined,
  });
  return sendJson(res, 200, result);
}

async function handleCreateSession(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const created = await sessions.createSession(ctx.pool, {
    userId: session.user.id,
    projectId: body?.project_id,
    title: body?.title,
    model: body?.model,
  });
  return sendJson(res, 201, { session: created });
}

async function handleGetSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://x');
  const result = await sessions.getSession(ctx.pool, {
    userId: session.user.id, sessionId,
    limit: url.searchParams.get('limit') || undefined,
    messagesCursor: url.searchParams.get('cursor'),
  });
  return sendJson(res, 200, result);
}

async function handlePatchSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const updated = await sessions.updateSession(ctx.pool, { userId: session.user.id, sessionId, title: body?.title });
  return sendJson(res, 200, { session: updated });
}

async function handleArchiveSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  await sessions.archiveSession(ctx.pool, { userId: session.user.id, sessionId });
  res.writeHead(204); // §4.2：204 无体
  res.end();
}

/**
 * POST /api/sessions/:id/messages（portal.md §4.3）：发用户消息 + 建 run 入队。
 * 可选 `Idempotency-Key`（§1.4）：同 key 重复提交返回**首次结果**（同 message.id / run.id），
 * 不产生第二条 user 消息/第二个 run，也**不重复副作用**（notify 唤醒只在首次执行路径发生，
 * 因为 replay 路径不会调用 sessions.postMessage）。
 *
 * G2：把幂等层给的 `record` 回调转交 sessions.postMessage，由它在**同一个业务事务内**调
 * `record(client, 202, payload)`——消息/run 与幂等台账同一次 COMMIT，“同 key 至多一次副作用”
 * （记账与业务写入同事务）；占位被接管时 record 抛 409 → 业务事务回滚。
 */
async function handlePostMessage(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  // 先读体（与其它端点一致：413/400 行为不受密钥校验影响），再校验体与 Idempotency-Key 头
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  // F3：请求体校验**前置到幂等包装之前**——非法体 400 且不占幂等占位行；
  // 否则首次非法体占位后，同 key 的合法重试会因 request_hash 不同撞 409 idempotency_key_reuse。
  const { content, attachments } = sessions.validateMessageBody(body);
  const key = idempotency.normalizeKey(req.headers['idempotency-key']); // 非法 → 400 validation_failed
  const endpoint = `POST /api/sessions/${sessionId}/messages`; // 含路径参数：同 key 跨 session 不串号
  const result = await idempotency.executeWithIdempotency(
    ctx.pool,
    { userId: session.user.id, endpoint, key, requestHash: idempotency.requestHash({ content, attachments }), log: ctx.log },
    async (record) => {
      // issue #41：建 run 前预检该 FDE 是否已绑定可用 LLM 上游（active binding + enabled provider +
      // 非空 api_key；SQL 口径同 routes.js llmRows / llm.js getFdeLlmHeartbeatModels 的 JOIN 条件）。
      // 未配置 → 409 llm_not_configured fail-fast：不入队 run（否则 run 永久排队，等一个永远不会
      // 出现的 LLM 出口）。
      // 评审 MEDIUM-1：预检必须放在 fn 内（executeWithIdempotency 之后）——回放优先（findDone 在
      // fn 之前返回首次结果，不被预检截断）；claim 后 fn 抛错走 ⑤ release 路径，「失败不占位」
      // 语义保持（修好绑定后同 key 原样重试可成功建 run）。
      const bound = await ctx.pool.query(
        `SELECT 1
           FROM fde_llm_bindings b
           JOIN llm_providers p ON p.id = b.provider_id AND p.enabled = true
          WHERE b.fde_id = $1 AND b.state = 'active' AND b.api_key IS NOT NULL AND b.api_key <> ''
          LIMIT 1`,
        [session.user.id],
      );
      if (!bound.rows?.length) {
        throw new HttpError(409, 'llm_not_configured', '该 FDE 未配置 LLM 上游，请在管理台配置');
      }
      const posted = await sessions.postMessage(ctx.pool, {
        userId: session.user.id,
        sessionId,
        content,
        attachments,
        record,
        notify: ({ runId, userId }) => internal.notifyRunEnqueued(userId, { run_id: runId }),
      });
      return { statusCode: 202, response: posted };
    },
  );
  // 回放路径按首次 status_code（202）与首次 body 原样返回（§1.4）
  return sendJson(res, result.statusCode, result.response);
}

async function handleStopSession(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req, ctx.config.maxBodyBytes); // 无体（空 JSON {}）
  const result = await sessions.stopSession(ctx.pool, { userId: session.user.id, sessionId });
  // 即时停止通道：SSE 下行 stop_request（agentd 立即 abort）；若容器离线，靠心跳 stop_run_ids 兼底（15s）。
  try {
    internal.broadcastStopRequest(session.user.id, { run_id: result.run.id, session_id: sessionId });
  } catch { /* 心跳兼容 */ }
  return sendJson(res, 200, result);
}

/** 浏览器 SSE（portal.md §5）：先注册（缓冲）→ DB 补发（Last-Event-ID / ?last_event_id）→ flush 后转 live；15s 心跳。 */
async function handleSessionStream(req, res, ctx, sessionId) {
  const session = await requireSession(req, ctx);
  const s = await sessions.getSession(ctx.pool, { userId: session.user.id, sessionId, limit: 1 });
  const url = new URL(req.url, 'http://x');
  // 无 Last-Event-ID（首连）不补发历史（§5.2.3）；非法值 400（header/query 同口径）。
  const raw = req.headers['last-event-id'] ?? url.searchParams.get('last_event_id');
  let lastEventId = null;
  if (raw !== undefined && raw !== null && raw !== '') {
    lastEventId = Number(raw);
    if (!Number.isInteger(lastEventId) || lastEventId < 0) {
      throw new HttpError(400, 'validation_failed', 'Last-Event-ID 必须为非负整数');
    }
    if (lastEventId > s.last_seq) {
      throw new HttpError(404, 'not_found', 'last_event_id beyond session');
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 3000\n\n');

  // 先注册（此后落库的事件进缓冲，不丢）；再补发；最后 flush 缓冲（跳过已补发 seq）转 live（§5.2）。
  const rec = internal.registerSessionClient(sessionId, res);

  // F4：注册后**立即**安装 cleanup（once 守卫）——补发前的 DB 查询/写帧期间客户端断开，
  // 也必须在第一时间把 rec 从 hub 摘除（否则 rec 永久残留：事件泄漏 + ping 定时器常驻）。
  let pingTimer = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (pingTimer) clearInterval(pingTimer);
    internal.unregisterSessionClient(sessionId, rec);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);

  let replayedSeq = null;
  if (lastEventId != null) {
    const replay = await ctx.pool.query(
      `SELECT seq, ts, run_id, type, payload FROM run_events
        WHERE session_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [sessionId, lastEventId],
    );
    for (const row of replay.rows) {
      // 补发期间缓冲溢出 → hub 已写 resync 并 end()：停止补发（写入被 writeSseEvent 静默跳过）
      if (rec.resync) break;
      if (cleaned) return; // 补发期间连接已断开（cleanup 已摘除 rec）：不再写
      const seq = Number(row.seq);
      const data = JSON.stringify({
        seq, ts: row.ts?.toISOString?.() ?? row.ts,
        session_id: sessionId, run_id: row.run_id, type: row.type, ...row.payload,
      });
      internal.writeSseEvent(res, row.type, data, seq);
      replayedSeq = seq;
    }
  } else {
    internal.writeSseComment(res, 'connected'); // 首连不补发历史
  }
  if (cleaned) return; // 补发期间断开：连接已关，不再 goLive（rec 已摘除）/不再起心跳
  internal.sessionClientGoLive(sessionId, rec, replayedSeq);
  if (rec.resync) return; // 已判定需重同步（res.end 已调用）：跳过 ping 与心跳循环
  internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });

  pingTimer = setInterval(() => {
    internal.writeSseComment(res, 'ping');
    internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  }, 15000);
}

/** GET /api/runs/:id（portal.md §4.6）：run 详情（属主经 session join 校验，不泄露存在性）。 */
async function handleGetRun(req, res, ctx, runId) {
  const session = await requireSession(req, ctx);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runId ?? '')) {
    throw new HttpError(404, 'not_found', 'run not found');
  }
  const r = await ctx.pool.query(
    `SELECT r.id, r.session_id, r.status, r.termination, r.usage, r.error, r.cancel_requested_at,
            r.queued_at, r.started_at, r.ended_at
       FROM runs r JOIN chat_sessions s ON s.id = r.session_id
      WHERE r.id = $1 AND s.user_id = $2`,
    [runId, session.user.id],
  );
  const row = r.rows?.[0];
  if (!row) throw new HttpError(404, 'not_found', 'run not found');
  return sendJson(res, 200, {
    run: {
      id: row.id, session_id: row.session_id, status: row.status,
      termination: row.termination ?? null, usage: row.usage ?? null, error: row.error ?? null,
      cancel_requested_at: row.cancel_requested_at?.toISOString?.() ?? null,
      queued_at: row.queued_at?.toISOString?.() ?? null,
      started_at: row.started_at?.toISOString?.() ?? null,
      ended_at: row.ended_at?.toISOString?.() ?? null,
    },
  });
}

async function handleLoginStep1(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req, config.maxBodyBytes);
  const login = typeof body.login === 'string' ? body.login.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!login || !password) {
    throw new HttpError(400, 'validation_failed', 'login 与 password 均为必填');
  }
  if (login.length > config.maxLoginLength) {
    throw new HttpError(400, 'validation_failed', `login 长度超过上限 ${config.maxLoginLength}`);
  }
  if (password.length > config.maxPasswordLength) {
    throw new HttpError(400, 'validation_failed', `password 长度超过上限 ${config.maxPasswordLength}`);
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `login:${ip}:${login}`;
  const check = ctx.loginLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // 限制并发 KDF：未认证请求不能无界并发触发 scrypt（S3）。
  // 队列满/排队超时快速失败（503 kdf_busy），不让请求无限排队。
  try {
    await ctx.kdfSemaphore.acquire();
  } catch (err) {
    if (err?.code === 'kdf_queue_full' || err?.code === 'kdf_queue_timeout') {
      throw new HttpError(503, 'kdf_busy', '服务繁忙，请稍后重试', {
        retryable: true,
        headers: { 'Retry-After': '1' },
      });
    }
    throw err;
  }
  let result;
  try {
    result = await auth.authenticate(pool, login, password, { log: ctx.log });
  } finally {
    ctx.kdfSemaphore.release();
  }

  if (!result.ok) {
    ctx.loginLimiter.recordFailure(rlKey);
    if (result.reason === 'malformed_hash') {
      ctx.log.warn?.(`[auth] malformed password_hash for login=${JSON.stringify(login)}`);
      await auth.audit(pool, { action: 'auth.login_malformed_hash', target: login, details: { login } }).catch(() => {});
    }
    throw new HttpError(401, 'invalid_credentials', '用户名或口令错误');
  }

  ctx.loginLimiter.reset(rlKey);

  // 未注册 TOTP（totp_secret 为空）→ 跳过第二因素，口令直通建会话。
  // （偏离规格 §7.1「强制 TOTP」：NULL secret 原语义 = 第二步永远失败 = 永久锁死；
  //   现改为「未注册即跳过」，用户决策 2026-09-22，规格同步见 issue）
  if (!(await auth.hasTotpEnrollment(pool, result.user.id))) {
    const session = await auth.createSession(pool, result.user.id, {
      ip,
      userAgent: req.headers['user-agent'] ?? null,
      ttlSeconds: config.sessionTtlSeconds,
    });
    return sendJson(res, 200, { status: 'authenticated', user: result.user }, {
      'Set-Cookie': sessionCookieHeader(config.cookie, session.token),
    });
  }

  const pending = await auth.createPendingToken(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: config.pendingTokenTtlSeconds,
  });
  return sendJson(res, 200, {
    status: 'totp_required',
    pending_token: pending.token,
    expires_in: config.pendingTokenTtlSeconds,
  });
}

async function handleLoginTotp(req, res, ctx) {
  const { pool, config } = ctx;
  requireJson(req);
  const body = await readJsonBody(req, config.maxBodyBytes);
  const pendingToken = typeof body.pending_token === 'string' ? body.pending_token : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!pendingToken || !code) {
    throw new HttpError(400, 'validation_failed', 'pending_token 与 code 均为必填');
  }

  const ip = req.socket.remoteAddress || 'unknown';

  // 非消费读取：TOTP 错误允许用同一 pending_token 重试（错误码不烧 token）；
  // 只有 TOTP 通过才原子消费（单次消费）。先解出用户，再按「账户 + IP」限流。
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  // 账户 + IP 失败计数：换新 pending_token 不重置（口令步成功也不清空），防第二因素爆破。
  const accountKey = `totp:${userId}:${ip}`;
  const accountCheck = ctx.totpLimiter.check(accountKey);
  if (!accountCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(accountCheck.retryAfterSeconds) },
    });
  }

  // 单 token 尝试上限（保留原有单 token 爆破防护）。
  const tokenKey = `totp-token:${ip}:${pendingToken}`;
  const tokenCheck = ctx.totpTokenLimiter.check(tokenKey);
  if (!tokenCheck.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(tokenCheck.retryAfterSeconds) },
    });
  }

  const result = await auth.verifyTotpForUser(pool, userId, code, {
    digits: config.totp.digits,
    period: config.totp.period,
    window: config.totp.window,
    log: ctx.log,
  });
  if (!result.ok) {
    ctx.totpLimiter.recordFailure(accountKey);
    ctx.totpTokenLimiter.recordFailure(tokenKey);
    throw new HttpError(401, 'totp_invalid', 'TOTP 校验失败');
  }

  const consumedUserId = await auth.consumePendingToken(pool, pendingToken);
  if (!consumedUserId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  ctx.totpLimiter.reset(accountKey);
  ctx.totpTokenLimiter.reset(tokenKey);
  const session = await auth.createSession(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: config.sessionTtlSeconds,
  });
  const cookieHeader = sessionCookieHeader(config.cookie, session.token);
  return sendJson(res, 200, { user: result.user }, { 'Set-Cookie': cookieHeader });
}

/** 要求有效 session（除登录/forward-auth 外所有公开端点）。 */
async function requireSession(req, ctx) {
  const token = getCookie(req, ctx.config.cookie.name);
  if (!token) throw new HttpError(401, 'unauthorized', 'unauthorized');
  const session = await auth.findSessionUser(ctx.pool, token);
  if (!session) throw new HttpError(401, 'unauthorized', 'unauthorized');
  return session;
}

/**
 * forwardAuth 回调（portal.md §2.7）。fail-closed：
 *  ① hostname 精确查 port_allocations（查不到 404 = 路由表里没有 = 不可达）；
 *  ② released → 403 allocation_released；
 *  ③ 无凭证 → 403 preview_ticket_required；ticket 无效/过期 → 401；撤销/不匹配/重放 → 403；
 *  ④ 凭证校验通过 → exposure 判定（private：owner/admin）；
 *  ⑤ ticket 通过 → 302 + Set-Cookie（换取预览 cookie）；cookie 通过 → 200 + X-Auth-User。
 * 放行（allow/redirect）后执行 allocated→active 幂等升级：
 *   UPDATE port_allocations SET state='active' WHERE id=$1 AND state='allocated'（fde-platform §8.6）。
 */
async function handleForwardAuth(req, res, ctx) {
  // dev 端口（8090/8443）下浏览器 Host 恒带端口后缀（如 `xxx.fde.localhost:8090`），而
  // port_allocations.hostname 按无端口 hostname 存储（fix-250923-01）：剥离 `:port` 再做
  // 精确匹配（生产 80/443 无端口后缀，行为不变）。
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
  const host = typeof rawHost === 'string' ? rawHost.replace(/:\d+$/, '') : rawHost;
  const uri = req.headers['x-forwarded-uri'] || req.url;
  const method = req.headers['x-forwarded-method'] || req.method;
  const scheme = req.headers['x-forwarded-proto'] || 'https';
  const cookieValue = getCookie(req, ctx.config.previewCookie?.name ?? '__Host-fde_preview');

  const result = await preview.authorizeForwardAuth(ctx.pool, ctx.config, {
    hostname: host || '',
    // 原始 Host（可能带端口）：302 Location 需要保留非默认端口（fix-250923-01，dev 8090/8443）。
    hostHeader: rawHost || '',
    uri,
    cookieValue,
    method,
    scheme,
  });

  // 审计：每次判定（无论通过与否）都写（portal.md §2.7）。details 不记 ticket/cookie 明文，也不记 query（F2：剥离所有 query，只记 path）。
  const details = {
    uri: pathOnly(uri),
    method,
    exposure: result.allocation?.exposure ?? null,
    result: result.outcome,
    grant_kind: result.grantKind ?? null,
    subject_id: result.subjectId ?? null,
    issuer_id: result.issuerId ?? null,
    grant_id: result.grantId ?? null,
  };
  await auth.audit(ctx.pool, {
    actorId: result.subjectId ?? null,
    action: 'auth.forward_auth',
    target: host || '',
    details,
  }).catch(() => {});

  if (result.outcome === 'deny') {
    return sendJson(res, result.status, errorBody(result.code, result.message));
  }

  // 放行 → allocated→active 幂等升级（fde-platform §8.6）；不写 route outbox、不重发路由。
  await ctx.pool
    .query(`UPDATE port_allocations SET state = 'active' WHERE id = $1 AND state = 'allocated'`, [result.allocation.id])
    .catch(() => {});

  if (result.outcome === 'redirect') {
    const headers = {
      'Set-Cookie': previewCookieHeader(ctx.config.previewCookie, result.sessionToken),
      Location: result.location,
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    };
    res.writeHead(302, headers);
    res.end();
    return;
  }

  // allow：200 + X-Auth-User（Traefik authResponseHeaders 透传）；session 续期重发 Set-Cookie。
  const headers = { 'X-Auth-User': result.fdeName || '' };
  if (result.cookieToken) headers['Set-Cookie'] = previewCookieHeader(ctx.config.previewCookie, result.cookieToken);
  sendJson(res, 200, {}, headers);
}

/** 签发一次性预览 ticket（portal.md §2.8）。 */
async function handlePreviewTicket(req, res, ctx, portId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  await readJsonBody(req, ctx.config.maxBodyBytes); // 无体（空 JSON {}）

  const ip = req.socket.remoteAddress || 'unknown';
  const rlKey = `ticket:${session.user.id}:${ip}`;
  const check = ctx.previewTicketLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '预览 ticket 签发过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  const result = await preview.issuePreviewTicket(ctx.pool, ctx.config, {
    allocationId: portId,
    session,
    ip,
    ua: req.headers['user-agent'] ?? null,
  });
  if (result.error) {
    const { status, code } = result.error;
    throw new HttpError(status, code, code === 'not_found' ? 'not found' : code);
  }

  // 记录本次成功签发（作为限流计数），防单用户短时刷 ticket。
  ctx.previewTicketLimiter.recordFailure(rlKey);
  return sendJson(res, 201, result);
}

async function handleCreateProject(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const repoUrl = body.repo_url === undefined || body.repo_url === null ? undefined : body.repo_url;
  const template = typeof body.template === 'string' ? body.template : 'default';
  const result = await projects.createProject(ctx.pool, {
    userId: session.user.id,
    name,
    repoUrl,
    template,
    config: ctx.config,
  });
  return sendJson(res, 201, { project: result.project, ports: [result.port] });
}

async function handleListProjects(req, res, ctx) {
  const session = await requireSession(req, ctx);
  const url = new URL(req.url, 'http://localhost');
  const cursor = url.searchParams.get('cursor') || undefined;
  const limit = Number(url.searchParams.get('limit') || 20);
  const result = await projects.listProjects(ctx.pool, { userId: session.user.id, cursor, limit });
  return sendJson(res, 200, result);
}

async function handleGetProject(req, res, ctx, projectId) {
  const session = await requireSession(req, ctx);
  const result = await projects.getProject(ctx.pool, { userId: session.user.id, projectId });
  return sendJson(res, 200, result);
}

async function handleGetProjectPorts(req, res, ctx, projectId) {
  const session = await requireSession(req, ctx);
  const result = await projects.getProject(ctx.pool, { userId: session.user.id, projectId });
  return sendJson(res, 200, { items: result.ports });
}

async function handlePatchProject(req, res, ctx, projectId) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new HttpError(400, 'validation_failed', 'name 为必填字段', { details: { field: 'name' } });
  }
  const project = await projects.renameProject(ctx.pool, {
    userId: session.user.id,
    projectId,
    name: body.name.trim(),
  });
  return sendJson(res, 200, project);
}

async function handleDeleteProject(req, res, ctx, projectId) {
  const session = await requireSession(req, ctx);
  await projects.deleteProject(ctx.pool, { userId: session.user.id, projectId });
  res.writeHead(204);
  res.end();
}

// ---------------------------------------------------------------------------
// internal 端点（portal.md §9）：容器 → portal 全出站通道。Bearer token 鉴权 + X-Claim-Token 租约凭证。
// ---------------------------------------------------------------------------

const INTERNAL_EVENTS_LIMIT = 320 * 1024; // 事件批 256KB 载荷 + 信封冗余
const INTERNAL_ROUND_LIMIT = 1.5 * 1024 * 1024; // transcript round 1MB + 信封冗余
const INTERNAL_CHECKPOINT_LIMIT = 2 * 1024 * 1024; // checkpoint snapshot 可较大

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : '';
}

function claimTokenHeader(req) {
  return (req.headers['x-claim-token'] || '').trim();
}

async function handleInternal(req, res, ctx, url) {
  const { pathname } = url;
  const identity = await internal.authenticateContainer(ctx.pool, bearerToken(req));
  const { container, user } = identity;

  // SSE 下行通道（§9.12）
  if (pathname === '/api/internal/stream') {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    return handleInternalStream(req, res, ctx, identity);
  }

  // U1 claim（长轮询，§9.3）
  if (pathname === '/api/internal/claim') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const capacity = body.capacity ?? 1;
    const holdMs = body.hold_ms ?? 30000;
    const ticket = await internal.claimRun(ctx.pool, { container, user, capacity, holdMs });
    if (!ticket) {
      res.writeHead(204);
      res.end();
      return;
    }
    return sendJson(res, 200, ticket);
  }

  // U4 heartbeat（§9.5）
  if (pathname === '/api/internal/heartbeat') {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    requireJson(req);
    const body = await readJsonBody(req, ctx.config.maxBodyBytes);
    const result = await internal.heartbeat(ctx.pool, { container, user, body });
    return sendJson(res, 200, result);
  }

  // U11 approval 结果轮询兜底（§9.10）
  const approvalMatch = pathname.match(/^\/api\/internal\/approvals\/([^/]+)$/);
  if (approvalMatch) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    const approvalId = decodeURIComponent(approvalMatch[1]);
    const result = await internal.getApproval(ctx.pool, { container, user, approvalId, claimToken: claimTokenHeader(req) });
    return sendJson(res, 200, result);
  }

  // runs/:id/*
  const runMatch = pathname.match(/^\/api\/internal\/runs\/([^/]+)(\/.*)?$/);
  if (runMatch) {
    const runId = decodeUuid(runMatch[1]);
    const sub = runMatch[2] || '';
    const claimToken = claimTokenHeader(req);

    if (sub === '/state') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await internal.setRunState(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/events') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_EVENTS_LIMIT);
      const result = await internal.postEvents(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/release') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await internal.releaseRun(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint') {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
      const result = await internal.putCheckpoint(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, 200, result);
    }
    if (sub === '/checkpoint/latest') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const result = await internal.getLatestCheckpoint(ctx.pool, { container, user, runId, claimToken });
      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }
      return sendJson(res, 200, result);
    }
    if (sub === '/runstate') {
      // 0.9.0 起引擎 8 方法契约：saveRunState（PUT {run_state}）/ loadRunState（GET）。
      if (req.method === 'PUT') {
        requireJson(req);
        const body = await readJsonBody(req, INTERNAL_CHECKPOINT_LIMIT);
        const result = await internal.saveRunState(ctx.pool, { container, user, runId, claimToken, body });
        return sendJson(res, 200, result);
      }
      if (req.method === 'GET') {
        const result = await internal.loadRunState(ctx.pool, { container, user, runId, claimToken });
        if (result === null) {
          res.writeHead(204);
          res.end();
          return;
        }
        return sendJson(res, 200, result);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }
    if (sub === '/transcript') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const limit = Number(url.searchParams.get('limit') || 10000);
      const cursor = url.searchParams.get('cursor') ? Number(url.searchParams.get('cursor')) : null;
      const result = await internal.getTranscript(ctx.pool, { container, user, runId, claimToken, limit, cursor });
      return sendJson(res, 200, result);
    }
    if (sub === '/transcript/recall') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const fromRound = Number(url.searchParams.get('from_round') ?? 0);
      const toRoundRaw = url.searchParams.get('to_round');
      const toRound = toRoundRaw === null ? null : Number(toRoundRaw);
      const pattern = url.searchParams.get('pattern') ?? '';
      const result = await internal.recallTranscript(ctx.pool, { container, user, runId, claimToken, fromRound, toRound, pattern });
      return sendJson(res, 200, result);
    }
    if (sub === '/approvals') {
      if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, ctx.config.maxBodyBytes);
      const result = await internal.createApproval(ctx.pool, { container, user, runId, claimToken, body });
      return sendJson(res, result.status, { approval_id: result.approval_id });
    }

    const roundMatch = sub.match(/^\/transcript\/rounds\/(\d+)$/);
    if (roundMatch) {
      if (req.method !== 'PUT') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      requireJson(req);
      const body = await readJsonBody(req, INTERNAL_ROUND_LIMIT);
      const round = Number(roundMatch[1]);
      const result = await internal.putRound(ctx.pool, { container, user, runId, round, claimToken, body });
      return sendJson(res, 200, result);
    }
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

/** SSE 下行：注册到 hub，15s 保活，断开时注销（§9.12）。 */
function handleInternalStream(req, res, ctx, identity) {
  const { container, user } = identity;
  internal.registerSseClient(container.id, user.id, res);
  res.writeHead(200, internal.sseHeaders());
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  internal.writeSseComment(res, 'connected');
  internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  const pingTimer = setInterval(() => {
    internal.writeSseComment(res, 'ping');
    internal.writeSseEvent(res, 'ping', { ts: new Date().toISOString() });
  }, 15000);
  const cleanup = () => {
    clearInterval(pingTimer);
    internal.unregisterSseClient(container.id, res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function serveStatic(req, res, ctx, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed', 'method not allowed');
  }
  const staticRoot = path.resolve(ctx.config.staticDir);
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'validation_failed', 'invalid path');
  }
  // issue #61 P2 翻转：/ 服务 Vue SPA——dist 由 Docker 多阶段构建注入 staticDir/app/
  //（vite base '/'，产物引用 /assets/*，故 /assets/ 前缀映射到注入目录；hash 路由承担子路径，
  // 无需 pathname catch-all）。旧 static/index.html 保留文件但不再被引用（P4 删）。
  if (rel === '/' || rel === '/index.html') rel = '/app/index.html';
  else if (rel.startsWith('/assets/')) rel = `/app${rel}`;
  // 以静态目录为根做规范化，再用 path.relative 校验未逃逸（静态路径穿越防护）。
  const filePath = path.resolve(staticRoot, `.${rel}`);
  const relPath = path.relative(staticRoot, filePath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return sendJson(res, 403, errorBody('forbidden', 'forbidden'));
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return sendJson(res, 404, errorBody('not_found', 'not found'));
    return sendStaticFile(res, filePath);
  } catch {
    return sendJson(res, 404, errorBody('not_found', 'not found'));
  }
}

/** 发送单个静态文件（/admin 页面与 serveStatic 共用；不存在走 404）。 */
function sendStaticFile(res, filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return sendJson(res, 404, errorBody('not_found', 'not found'));
    const contentType = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    return sendJson(res, 404, errorBody('not_found', 'not found'));
  }
}
