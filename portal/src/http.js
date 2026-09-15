// HTTP 服务：零框架 node:http 路由分发。
// 端点：GET /healthz、GET /api/health、POST /api/login、POST /api/logout、GET /api/me + 静态页面。
// cookie 语义见 docs/api/portal.md §2.5（prod __Host-fde_session；dev-http fde_session_dev）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import * as auth from './auth.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
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

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
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
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

/** readiness：DB 可达 + baseline 已应用（deploy-contract §2.3/§8）。 */
export async function checkReady(pool) {
  try {
    const r = await pool.query(
      `SELECT version FROM schema_migrations WHERE version = '0000_baseline'`,
    );
    return Array.isArray(r.rows) && r.rows.length > 0;
  } catch {
    return false;
  }
}

export function createServer({ pool, config, log = console }) {
  return http.createServer(async (req, res) => {
    try {
      await route(req, res, { pool, config, log });
    } catch (err) {
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
      return sendJson(res, 405, errorBody('method_not_allowed', 'method not allowed'));
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

  if (req.method === 'POST' && pathname === '/api/login') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      return sendJson(res, 400, errorBody('validation_failed', 'invalid JSON body'));
    }
    const login = typeof body.login === 'string' ? body.login.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!login || !password) {
      return sendJson(res, 400, errorBody('validation_failed', 'login 与 password 均为必填'));
    }
    const result = await auth.authenticate(pool, login, password);
    if (!result.ok) {
      return sendJson(res, 401, errorBody('invalid_credentials', '用户名或口令错误'));
    }
    const session = await auth.createSession(pool, result.user.id, {
      ip: req.socket.remoteAddress,
      userAgent: req.headers['user-agent'] ?? null,
      ttlSeconds: config.sessionTtlSeconds,
    });
    const cookieHeader = sessionCookieHeader(config.cookie, session.token);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': cookieHeader,
    });
    res.end(JSON.stringify({ user: result.user }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const token = getCookie(req, config.cookie.name);
    if (!token) return sendJson(res, 401, errorBody('unauthorized', 'unauthorized'));
    await auth.revokeSession(pool, token);
    res.writeHead(204, { 'Set-Cookie': clearCookieHeader(config.cookie) });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me') {
    const token = getCookie(req, config.cookie.name);
    if (!token) return sendJson(res, 401, errorBody('unauthorized', 'unauthorized'));
    const session = await auth.findSessionUser(pool, token);
    if (!session) return sendJson(res, 401, errorBody('unauthorized', 'unauthorized'));
    return sendJson(res, 200, { user: session.user });
  }

  return sendJson(res, 404, errorBody('not_found', 'not found'));
}

async function serveStatic(req, res, ctx, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, errorBody('method_not_allowed', 'method not allowed'));
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const normalized = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(ctx.config.staticDir, normalized);
  if (!filePath.startsWith(path.resolve(ctx.config.staticDir))) {
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
