// 单测：issue #845——内部通道（FDE 容器里的 runner → 平台 `/api/internal/*`）的错误语言
// 由**平台按「这条请求属于谁」取 profile** 决定，而不是由请求头决定。
//
// 为什么不能用请求头：语言协商（`portal/src/locale.js#resolveRequestLocale`）读的是
// `Cookie: locale=` 与 `Accept-Language`，那是**为浏览器设计**的机制——浏览器天然带 cookie。
// 内部通道根本没有浏览器、没有 cookie 罐子，runner 两个头都不发，在这里等 cookie 永远等不到
// ⇒ #803 E 片补好的 50 处英文对备好之后界面仍然恒中文。修法是在平台**本来就知道答案**的地方取：
// `authenticateContainer` 的既有 `JOIN users u` 顺带取 `u.locale`（零额外查询），
// `handleInternal` 把它挂成 `req.localeHint`，兜底 catch 用 `req.localeHint ?? resolveRequestLocale(req)`。
//
// 为什么必须「挂 hint」而不是改 `resolveRequestLocale`（本文件最后一条钉子）：浏览器那条路
// **必须继续只认 cookie**——#828 P2b 刚修完「过期账号值顶掉用户当场选的语言」，账号值绝不能在
// 浏览器路径上插队。hint 只在内部面设置，作用域天然隔离，故这条性质必须被钉住。
//
// 断言一律 `assert.equal(实际, 期望)` **逐字等值**（不许 includes / match）；内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { seedClaimable } from './fake-internal-pool.js';
import { FakePool } from './fake-pool.js';

// 内部面与浏览器面各自起一台 server（两套 config/cookie 名，互不干扰）。
const BASE_CONFIG = {
  sessionTtlSeconds: 604800,
  sessionRenewIntervalSeconds: 3600,
  pendingTokenTtlSeconds: 120,
  totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
  loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
  totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
  kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
  maxLoginLength: 128, maxPasswordLength: 256,
};

function makeStatic() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-internal-locale-static-'));
  return { staticDir, rm: () => fs.rmSync(staticDir, { recursive: true, force: true }) };
}

/** 内部面 server：注入 `seedClaimable` 的 FakeInternalPool。 */
async function startInternalServer(pool) {
  const stat = makeStatic();
  const config = { ...BASE_CONFIG, cookie: cookieSettings('dev-internal-locale', 604800), staticDir: stat.staticDir };
  const server = createServer({ pool, config, log: { warn() {}, info() {}, error() {}, debug() {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((res) => server.close(res)).finally(stat.rm);
    },
  };
}

const OWNER = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const SESSION_TOKEN = 'tok-internal-locale-session';

/** 浏览器面 server：FakePool + 一条 active 管理员会话（属主可种 `locale`）。 */
async function startBrowserServer({ ownerLocale }) {
  const stat = makeStatic();
  const config = {
    ...BASE_CONFIG, cookie: cookieSettings('dev-owner-locale', 604800),
    dockerHost: 'tcp://127.0.0.1:1', staticDir: stat.staticDir,
  };
  class Pool extends FakePool {
    constructor() {
      super({ users: [{ ...OWNER, locale: ownerLocale }] });
      this.sessions.push({
        id: 'ls-owner-locale', user_id: OWNER.id, token_hash: auth.hashToken(SESSION_TOKEN),
        created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
      });
    }
  }
  const server = createServer({
    pool: new Pool(), config, docker: null,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
    log: { error: () => {}, warn: () => {}, log: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    sessionCookie: `${config.cookie.name}=${SESSION_TOKEN}`,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((res) => server.close(res)).finally(stat.rm);
    },
  };
}

/** 一次请求；返回 {status, error}（error = 响应体 error 信封）。 */
async function hit(base, { method, p, token, cookie, ct = 'application/json', body }) {
  const headers = {};
  if (ct) headers['content-type'] = ct;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const payload = body === undefined ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

/** 把种子里的属主语言设成 `locale`（`undefined` ⇒ 与今天一致：列不存在/NULL 都按 NULL 处理）。 */
function setOwnerLocale(pool, locale) {
  if (locale === undefined) delete pool.users[0].locale;
  else pool.users[0].locale = locale;
}

// 内部面这条请求必定抛 `InternalError`（`state` 形状校验，早于任何 DB 写）：
// PUT /api/internal/runs/run1/state  body {state:'bogus'} ⇒ 400 validation_failed。
const STATE_REQ = { method: 'PUT', p: '/api/internal/runs/run1/state', ct: 'application/json', body: { state: 'bogus' } };
const ZH_STATE = 'state 必须为 running/finished/failed';
const EN_STATE = 'state must be running/finished/failed';

// ── 1. 属主 locale='en' ⇒ 内部面错误逐字英文（runner 一个语言头都不发）──
test('属主 locale=en ⇒ 内部面错误体出英文（请求不带任何语言头）', async () => {
  const { pool, token } = seedClaimable();
  setOwnerLocale(pool, 'en');
  const s = await startInternalServer(pool);
  try {
    const res = await hit(s.base, { ...STATE_REQ, token });
    assert.equal(res.status, 400);
    assert.ok(res.error, '应返回错误信封');
    assert.equal(res.error.code, 'validation_failed');
    assert.equal(res.error.message, EN_STATE);
    assert.ok(!('en' in res.error), 'en 不得出现在错误体');
  } finally { await s.close(); }
});

// ── 2. 属主 locale=NULL ⇒ 中文，与今天逐字相同（回落链：hint(null) → 请求头(无) → zh-CN）──
test('属主 locale=NULL ⇒ 内部面错误体出中文（与今天逐字相同）', async () => {
  const { pool, token } = seedClaimable();
  setOwnerLocale(pool, null);
  const s = await startInternalServer(pool);
  try {
    const res = await hit(s.base, { ...STATE_REQ, token });
    assert.equal(res.status, 400);
    assert.ok(res.error, '应返回错误信封');
    assert.equal(res.error.code, 'validation_failed');
    assert.equal(res.error.message, ZH_STATE);
  } finally { await s.close(); }
});

// ── 2b. 属主 locale 列缺失（fake 未种该行）也按 NULL 处理 ⇒ 中文（additive 字段不改变既有行为）──
test('属主 locale 列缺失（未种）⇒ 仍出中文，与 #803 现状钉逐字相同', async () => {
  const { pool, token } = seedClaimable();   // seedClaimable 的 users 本就没有 locale 键
  const s = await startInternalServer(pool);
  try {
    const res = await hit(s.base, { ...STATE_REQ, token });
    assert.equal(res.error.message, ZH_STATE);
  } finally { await s.close(); }
});

// ── 3. 属主 locale='zh-CN' ⇒ 中文 ──
test('属主 locale=zh-CN ⇒ 内部面错误体出中文', async () => {
  const { pool, token } = seedClaimable();
  setOwnerLocale(pool, 'zh-CN');
  const s = await startInternalServer(pool);
  try {
    const res = await hit(s.base, { ...STATE_REQ, token });
    assert.equal(res.status, 400);
    assert.equal(res.error.message, ZH_STATE);
  } finally { await s.close(); }
});

// ── 3b. 换一条内部路由（artifact 空 body）同样按属主取语言 ⇒ 不是「只有 state 那条凑巧」──
test('另一条内部路由（artifact 空 body）也按属主取语言：en 出英文 / NULL 出中文', async () => {
  const { pool, token } = seedClaimable();
  const s = await startInternalServer(pool);
  const req = { method: 'PUT', p: '/api/internal/runs/run1/artifact', ct: null, body: Buffer.alloc(0) };
  try {
    setOwnerLocale(pool, 'en');
    const en = await hit(s.base, { ...req, token });
    assert.equal(en.status, 400);
    assert.equal(en.error.code, 'validation_failed');
    assert.equal(en.error.message, 'the artifact body must be a non-empty byte stream');

    setOwnerLocale(pool, null);
    const zh = await hit(s.base, { ...req, token });
    assert.equal(zh.status, 400);
    assert.equal(zh.error.message, 'artifact body 必须为非空字节流');
  } finally { await s.close(); }
});

// ── 4. 防回归（最重要）：浏览器路径不被属主 profile 插队 ⇒ 只认 cookie ──
// 属主（会话所属用户）`locale='en'`，但浏览器当场带 `Cookie: locale=zh-CN` ⇒ 必须出中文。
// 这是 #828 P2b 的口径：账号值不得顶掉用户当场选的语言。
test('防回归：浏览器请求属主 locale=en 但 Cookie locale=zh-CN ⇒ 仍出中文（账号值不许插队）', async () => {
  const s = await startBrowserServer({ ownerLocale: 'en' });
  try {
    const res = await hit(s.base, {
      method: 'GET', p: '/api/admin/users/not-a-uuid',
      cookie: `${s.sessionCookie}; locale=zh-CN`, ct: null,
    });
    assert.equal(res.status, 400);
    assert.ok(res.error, '应返回错误信封');
    assert.equal(res.error.code, 'validation_failed');
    assert.equal(res.error.message, '用户 id 必须是 UUID');
  } finally { await s.close(); }
});

// ── 4b. 浏览器侧 cookie 仍是唯一入口：属主 en + Cookie locale=en ⇒ 英文；属主 en + 不带 cookie ⇒ 中文
//（中文那条同时钉住「浏览器路径不读 users.locale」：属主是 en，若被读就会出英文）──
test('防回归：浏览器侧只认 cookie（Cookie locale=en ⇒ 英文；不带 locale cookie ⇒ 中文，即使属主是 en）', async () => {
  const s = await startBrowserServer({ ownerLocale: 'en' });
  try {
    const en = await hit(s.base, {
      method: 'GET', p: '/api/admin/users/not-a-uuid',
      cookie: `${s.sessionCookie}; locale=en`, ct: null,
    });
    assert.equal(en.error.message, 'User id must be a UUID');

    const zh = await hit(s.base, { method: 'GET', p: '/api/admin/users/not-a-uuid', cookie: s.sessionCookie, ct: null });
    assert.equal(zh.error.message, '用户 id 必须是 UUID');
  } finally { await s.close(); }
});
