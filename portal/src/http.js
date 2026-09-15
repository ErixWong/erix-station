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

function sessionCookieHeader(cookie, token) {
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

export function createServer({ pool, config, log = console }) {
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
  const ctx = { pool, config, log, loginLimiter, totpLimiter, totpTokenLimiter, kdfSemaphore };

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
      log.error?.('[portal] unhandled:', err);
      if (!res.headersSent) sendJson(res, 500, errorBody('internal', 'internal error'));
      else res.destroy();
    }
  });
}

async function route(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

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

  return sendJson(res, 404, errorBody('not_found', 'not found'));
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
 *  ③ 无有效预览凭证 → 403 preview_ticket_required（⚠️ WP2b：一次性 ticket / 预览 cookie /
 *     exposure 授权完整实现归后续 WP；当前严禁「只查 hostname 就放行」）。
 * 放行成功分支（WP2b 上线后）在返回 200 + X-Auth-User 前执行 allocated→active 幂等升级：
 *   UPDATE port_allocations SET state='active' WHERE id=$1 AND state='allocated'（fde-platform §8.6）。
 */
async function handleForwardAuth(req, res, ctx) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return sendJson(res, 404, errorBody('not_found', 'not found'));
  const r = await ctx.pool.query(
    `SELECT a.id, a.fde_id, a.state, u.fde_name
       FROM port_allocations a
       JOIN users u ON u.id = a.fde_id
      WHERE a.hostname = $1
      LIMIT 1`,
    [host],
  );
  if (r.rows.length === 0) return sendJson(res, 404, errorBody('not_found', 'not found'));
  const alloc = r.rows[0];
  if (alloc.state === 'released') {
    return sendJson(res, 403, errorBody('allocation_released', 'allocation released'));
  }
  // ⚠️ WP2b：此处为完整预览凭证校验（ticket → 预览 cookie / exposure 判定）的插入点。
  // 凭证校验通过后放行并执行 allocated → active 升级（幂等）。
  // P1 fail-closed：无有效预览凭证一律 403（绝不因 hostname 存在即放行）。
  return sendJson(res, 403, errorBody('preview_ticket_required', 'preview ticket required'));
}

async function handleCreateProject(req, res, ctx) {
  const session = await requireSession(req, ctx);
  requireJson(req);
  const body = await readJsonBody(req, ctx.config.maxBodyBytes);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const repoUrl = typeof body.repo_url === 'string' ? body.repo_url.trim() : '';
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
  if (rel === '/') rel = '/index.html';
  // 以静态目录为根做规范化，再用 path.relative 校验未逃逸（静态路径穿越防护）。
  const filePath = path.resolve(staticRoot, `.${rel}`);
  const relPath = path.relative(staticRoot, filePath);
  if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
    return sendJson(res, 403, errorBody('forbidden', 'forbidden'));
  }
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
