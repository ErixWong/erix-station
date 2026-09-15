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
  const totpLimiter = createRateLimiter(config.totpRateLimit);
  const kdfSemaphore = createSemaphore(config.kdfConcurrency);
  const ctx = { pool, config, log, loginLimiter, totpLimiter, kdfSemaphore };

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
  await ctx.kdfSemaphore.acquire();
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
  const rlKey = `totp:${ip}:${pendingToken}`;
  const check = ctx.totpLimiter.check(rlKey);
  if (!check.allowed) {
    throw new HttpError(429, 'rate_limited', '尝试过于频繁，请稍后再试', {
      retryable: true,
      headers: { 'Retry-After': String(check.retryAfterSeconds) },
    });
  }

  // 非消费读取：TOTP 错误允许用同一 pending_token 重试（错误码不烧 token）；
  // 只有 TOTP 通过才原子消费（单次消费）。
  const userId = await auth.findPendingUser(pool, pendingToken);
  if (!userId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  const result = await auth.verifyTotpForUser(pool, userId, code, {
    digits: config.totp.digits,
    period: config.totp.period,
    window: config.totp.window,
  });
  if (!result.ok) {
    ctx.totpLimiter.recordFailure(rlKey);
    throw new HttpError(401, 'totp_invalid', 'TOTP 校验失败');
  }

  const consumedUserId = await auth.consumePendingToken(pool, pendingToken);
  if (!consumedUserId) {
    throw new HttpError(401, 'pending_expired', 'pending_token 过期或已使用，请重新登录');
  }

  ctx.totpLimiter.reset(rlKey);
  const session = await auth.createSession(pool, result.user.id, {
    ip,
    userAgent: req.headers['user-agent'] ?? null,
    ttlSeconds: config.sessionTtlSeconds,
  });
  const cookieHeader = sessionCookieHeader(config.cookie, session.token);
  return sendJson(res, 200, { user: result.user }, { 'Set-Cookie': cookieHeader });
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
