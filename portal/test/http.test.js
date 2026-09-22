// HTTP 层集成测试（无真实 DB）：createServer + FakePool，覆盖两步登录、畸形 hash 401、
// 限流 429、413 信封、Content-Type 400、字段上限、静态路径穿越、滚动续期、旧路径 307。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as totp from '../src/totp.js';
import { FakePool } from './fake-pool.js';

async function startServer({ users = [], overrides = {}, pool: customPool } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: {
      maxFailures: 5,
      windowMs: 15 * 60 * 1000,
      blockMs: 60 * 1000,
      perTokenMaxFailures: 5,
      maxEntries: 10000,
    },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
    ...overrides,
  };
  const pool = customPool || new FakePool({ users });
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    pool,
    config,
    base,
    staticDir,
    close: () => new Promise((res) => server.close(res)),
  };
}

test('两步登录：口令正确仅返回 pending_token（不发 cookie），TOTP 通过才发 cookie', async () => {
  const password = 'correct horse battery staple';
  const totpSecret = totp.generateSecret(20);
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totpSecret, last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    // 第一步
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(step1.status, 200);
    const body1 = await step1.json();
    assert.equal(body1.status, 'totp_required');
    assert.ok(body1.pending_token);
    assert.equal(step1.headers.get('set-cookie'), null); // 第一步不发 cookie

    // 第二步：正确 TOTP
    const code = totp.totp(totpSecret);
    const step2 = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token: body1.pending_token, code }),
    });
    assert.equal(step2.status, 200);
    const setCookie = step2.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.startsWith('fde_session_dev='));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));
    const token = setCookie.split(';')[0].split('=')[1];
    const body2 = await step2.json();
    assert.equal(body2.user.login, 'alice');

    // 已登录后可 /api/me
    const me = await fetch(`${s.base}/api/me`, { headers: { Cookie: `fde_session_dev=${token}` } });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).user.login, 'alice');
  } finally {
    await s.close();
  }
});

test('未注册 TOTP（totp_secret 为 NULL）→ step1 口令直通建会话', async () => {
  const password = 'correct horse battery staple';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: null, last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(step1.status, 200);
    const body = await step1.json();
    assert.equal(body.status, 'authenticated');
    assert.ok(body.user);
    assert.equal(Object.hasOwn(body, 'pending_token'), false);
    assert.ok(step1.headers.get('set-cookie'));
  } finally {
    await s.close();
  }
});

test('未注册 TOTP（totp_secret 为空字符串）→ step1 口令直通建会话', async () => {
  const password = 'correct horse battery staple';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: '', last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(step1.status, 200);
    const body = await step1.json();
    assert.equal(body.status, 'authenticated');
    assert.ok(body.user);
    assert.equal(Object.hasOwn(body, 'pending_token'), false);
    assert.ok(step1.headers.get('set-cookie'));
  } finally {
    await s.close();
  }
});

test('错误 TOTP → 401 totp_invalid；pending_token 二次使用 → 401 pending_expired', async () => {
  const password = 'pw';
  const totpSecret = totp.generateSecret(20);
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totpSecret, last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    const { pending_token } = await step1.json();

    // 错误码
    const bad = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code: '000000' }),
    });
    assert.equal(bad.status, 401);
    assert.equal((await bad.json()).error.code, 'totp_invalid');

    // 用同一 pending_token 换正确码 → 已被上面消费？注意：错误码不会消费 pending_token，
    // 但为验证「单次消费」，先成功消费一次再重放。
    const code = totp.totp(totpSecret);
    const ok = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code }),
    });
    assert.equal(ok.status, 200);

    const replay = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code }),
    });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, 'pending_expired');
  } finally {
    await s.close();
  }
});

test('畸形 password_hash（空 hash / 非整数参数）→ 401 而非 200/500', async () => {
  for (const badHash of ['scrypt$16384$8$1$00$zz', 'scrypt$bad$8$1$00$00']) {
    const user = {
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
      auth_source: 'local', status: 'active',
      password_hash: badHash, totp_secret: null, last_totp_step: null,
    };
    const s = await startServer({ users: [user] });
    try {
      const r = await fetch(`${s.base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: 'alice', password: 'anything-at-all' }),
      });
      assert.equal(r.status, 401, `hash=${badHash}`);
      assert.equal((await r.json()).error.code, 'invalid_credentials');
    } finally {
      await s.close();
    }
  }
});

test('登录失败限流：连续失败达阈值 → 429 rate_limited + Retry-After', async () => {
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword('correct'), totp_secret: null, last_totp_step: null,
  };
  const s = await startServer({
    users: [user],
    overrides: { loginRateLimit: { maxFailures: 2, windowMs: 60 * 1000, blockMs: 60 * 1000 } },
  });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${s.base}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: 'alice', password: 'wrong' }),
      });
      assert.equal(r.status, 401);
    }
    const blocked = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'wrong' }),
    });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await blocked.json()).error.code, 'rate_limited');
  } finally {
    await s.close();
  }
});

test('超大请求体 → 413 payload_too_large 标准错误信封', async () => {
  const s = await startServer({ overrides: { maxBodyBytes: 100 } });
  try {
    const r = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'x'.repeat(200) }),
    });
    assert.equal(r.status, 413);
    const body = await r.json();
    assert.equal(body.error.code, 'payload_too_large');
    assert.ok(body.error.message);
    assert.equal(body.error.retryable, false);
  } finally {
    await s.close();
  }
});

test('非 JSON Content-Type → 400；超长字段 → 400', async () => {
  const s = await startServer();
  try {
    const wrongCt = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: 'login=alice&password=x',
    });
    assert.equal(wrongCt.status, 400);
    assert.equal((await wrongCt.json()).error.code, 'validation_failed');

    const longPassword = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'x'.repeat(300) }),
    });
    assert.equal(longPassword.status, 400);
    assert.equal((await longPassword.json()).error.code, 'validation_failed');
  } finally {
    await s.close();
  }
});

test('静态路径穿越 → 403（不泄露文件内容）', async () => {
  const s = await startServer();
  try {
    const ok = await fetch(`${s.base}/`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'SECRET_INDEX');

    // 编码的 .. 与 /（避免 URL 规范化提前折叠）
    const traversal = await fetch(`${s.base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(traversal.status, 403);
    assert.ok(!(await traversal.text()).includes('root:'));
  } finally {
    await s.close();
  }
});

test('滚动续期：/api/me 在续期阈值外重发 Set-Cookie', async () => {
  const password = 'pw';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totp.generateSecret(20), last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    const { pending_token } = await step1.json();
    const step2 = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code: totp.totp(user.totp_secret) }),
    });
    const token = step2.headers.get('set-cookie').split(';')[0].split('=')[1];

    // 把会话 last_seen_at 拨到 2 小时前（模拟久未活跃）
    s.pool.sessions[0].last_seen_at = new Date(Date.now() - 2 * 60 * 60 * 1000);

    const me = await fetch(`${s.base}/api/me`, { headers: { Cookie: `fde_session_dev=${token}` } });
    assert.equal(me.status, 200);
    assert.ok(me.headers.get('set-cookie')); // 已续期 → 重发 cookie

    // 紧接着再次请求（阈值内）→ 不再重发
    const me2 = await fetch(`${s.base}/api/me`, { headers: { Cookie: `fde_session_dev=${token}` } });
    assert.equal(me2.status, 200);
    assert.equal(me2.headers.get('set-cookie'), null);
  } finally {
    await s.close();
  }
});

test('旧路径 /api/login、/api/logout → 307 到新路径', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'x' }),
      redirect: 'manual',
    });
    assert.equal(r.status, 307);
    assert.equal(r.headers.get('location'), '/api/auth/login');
  } finally {
    await s.close();
  }
});

test('TOTP 限流按账户+IP 计数：换新 pending token 仍被限流（不被绕过）', async () => {
  const password = 'pw';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totp.generateSecret(20), last_totp_step: null,
  };
  const s = await startServer({
    users: [user],
    overrides: {
      totpRateLimit: {
        maxFailures: 2,
        windowMs: 60 * 1000,
        blockMs: 60 * 1000,
        perTokenMaxFailures: 10,
        maxEntries: 10000,
      },
    },
  });
  const login = async () => {
    const r = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(r.status, 200);
    return (await r.json()).pending_token;
  };
  const tryTotp = (token) =>
    fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token: token, code: '000000' }),
    });

  try {
    let token = await login();
    for (let i = 0; i < 2; i++) {
      assert.equal((await tryTotp(token)).status, 401);
    }

    // 口令步成功拿到全新 pending token，但账户+IP 计数已封禁 → 仍 429
    token = await login();
    const blocked = await tryTotp(token);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await blocked.json()).error.code, 'rate_limited');
  } finally {
    await s.close();
  }
});

test('TOTP 单 token 尝试上限独立生效：同 token 超限 → 429', async () => {
  const password = 'pw';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totp.generateSecret(20), last_totp_step: null,
  };
  const s = await startServer({
    users: [user],
    overrides: {
      totpRateLimit: {
        maxFailures: 10,
        windowMs: 60 * 1000,
        blockMs: 60 * 1000,
        perTokenMaxFailures: 2,
        maxEntries: 10000,
      },
    },
  });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    const { pending_token } = await step1.json();
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${s.base}/api/auth/login/totp`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_token, code: '000000' }),
      });
      assert.equal(r.status, 401);
    }
    const blocked = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code: '000000' }),
    });
    assert.equal(blocked.status, 429);
    assert.equal((await blocked.json()).error.code, 'rate_limited');
  } finally {
    await s.close();
  }
});

test('畸形 totp_secret（非法 base32）→ 401 totp_invalid，不 500', async () => {
  const password = 'pw';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: 'not-base32!', last_totp_step: null,
  };
  const s = await startServer({ users: [user] });
  try {
    const step1 = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    const { pending_token } = await step1.json();
    const r = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token, code: '123456' }),
    });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.code, 'totp_invalid');
  } finally {
    await s.close();
  }
});

test('KDF 队列满 → 503 kdf_busy（快速失败，不无限排队）', async () => {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const password = 'pw';
  const passwordHash = await auth.hashPassword(password);
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const pool = {
    async query(sql) {
      if (sql.includes('schema_migrations')) return { rows: [{ version: '0000_baseline' }] };
      if (sql.includes('FROM users WHERE login')) {
        await gate; // 持有 KDF 信号量，制造并发
        return {
          rows: [{ id: 'u1', login: 'alice', display_name: 'Alice', role: 'admin', fde_name: null, auth_source: 'local', status: 'active', password_hash: passwordHash }],
        };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 1,
    kdfQueueLimit: 0,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((res) => server.close(res));
  try {
    const first = fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    await new Promise((r) => setTimeout(r, 30)); // 让第一个请求先拿到信号量
    const second = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(second.status, 503);
    assert.equal((await second.json()).error.code, 'kdf_busy');
    releaseGate();
    assert.equal((await first).status, 200);
  } finally {
    await close();
  }
});

test('forward-auth fail-closed：无预览凭证 403 / 未知 host 404 / released 403', async () => {
  const allocs = new Map([
    ['alice-p-proj1-4016.fde.localhost', { id: 'pa1', fde_id: 'u1', state: 'allocated', fde_name: 'alice' }],
    ['bob-p-proj1-4016.fde.localhost', { id: 'pa2', fde_id: 'u2', state: 'released', fde_name: 'bob' }],
  ]);
  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM port_allocations a')) {
        const host = params[0];
        const a = allocs.get(host);
        return { rows: a ? [a] : [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const s = await startServer({ pool });
  try {
    const unknown = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'nope.fde.localhost' } });
    assert.equal(unknown.status, 404);

    const nocred = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'alice-p-proj1-4016.fde.localhost' } });
    assert.equal(nocred.status, 403);
    assert.equal((await nocred.json()).error.code, 'preview_ticket_required');

    const released = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'bob-p-proj1-4016.fde.localhost' } });
    assert.equal(released.status, 403);
    assert.equal((await released.json()).error.code, 'allocation_released');
  } finally {
    await s.close();
  }
});

test('POST /api/ports/:id/preview-ticket：无会话 401；有会话 201 且存哈希（portal.md §2.8）', async () => {
  const password = 'pw';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password),
    totp_secret: totp.generateSecret(20), last_totp_step: null,
  };
  const grants = [];
  const pool = {
    grants,
    async query(sql, params = []) {
      if (sql.includes('schema_migrations')) return { rows: [{ version: '0000_baseline' }] };
      if (sql.includes('FROM users WHERE login')) return { rows: [user] };
      if (sql.includes('FROM users WHERE id') && sql.includes('totp_secret')) return { rows: [user] };
      if (sql.includes('INSERT INTO login_pending')) {
        this.pending = { user_id: user.id, token_hash: params[1], created_at: params[2], expires_at: params[3], used_at: null };
        return { rows: [] };
      }
      if (sql.includes('SELECT user_id FROM login_pending')) {
        const p = this.pending;
        return { rows: p && p.used_at === null && new Date(p.expires_at) > new Date(params[1]) ? [{ user_id: p.user_id }] : [] };
      }
      if (sql.includes('UPDATE login_pending SET used_at')) {
        if (this.pending && this.pending.used_at === null) { this.pending.used_at = new Date(); return { rows: [{ user_id: this.pending.user_id }] }; }
        return { rows: [] };
      }
      if (sql.includes('UPDATE users SET last_totp_step')) { user.last_totp_step = Number(params[1]); return { rows: [{ id: user.id }] }; }
      if (sql.includes('INSERT INTO login_sessions')) {
        this.session = { id: 's1', user_id: user.id, token_hash: params[1], created_at: params[2], expires_at: params[3], last_seen_at: params[2], revoked_at: null };
        return { rows: [] };
      }
      if (sql.includes('FROM login_sessions s') && sql.includes('JOIN users')) {
        if (!this.session || this.session.revoked_at) return { rows: [] };
        return { rows: [{ id: user.id, login: user.login, display_name: user.display_name, role: user.role, fde_name: user.fde_name, auth_source: user.auth_source, status: user.status, session_id: this.session.id, expires_at: this.session.expires_at, last_seen_at: this.session.last_seen_at }] };
      }
      if (sql.includes('FROM port_allocations WHERE id = $1')) {
        return { rows: [{ id: 'pa1', fde_id: 'u1', state: 'allocated', exposure: 'private', url: 'https://alice-p-proj1-4000.fde.localhost' }] };
      }
      if (sql.includes('INSERT INTO preview_grants')) {
        grants.push({ token_hash: params[0], kind: 'ticket', user_id: params[1], issuer_id: params[2], allocation_id: params[3], expires_at: params[4] });
        return { rows: [] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const s = await startServer({ pool, overrides: {
    previewTicketTtlSeconds: 60,
    previewSessionSigningKey: 'test-key',
    previewCookie: { name: 'fde_preview_dev', secure: false, httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 900 },
  } });
  try {
    // 无会话 → 401
    const noSession = await fetch(`${s.base}/api/ports/pa1/preview-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noSession.status, 401);

    // 登录拿会话
    const step1 = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'alice', password }) });
    const { pending_token } = await step1.json();
    const step2 = await fetch(`${s.base}/api/auth/login/totp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending_token, code: totp.totp(user.totp_secret) }) });
    const token = step2.headers.get('set-cookie').split(';')[0].split('=')[1];

    const r = await fetch(`${s.base}/api/ports/pa1/preview-ticket`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${token}` }, body: '{}' });
    assert.equal(r.status, 201);
    const body = await r.json();
    assert.ok(body.ticket.startsWith('pt_'));
    assert.equal(body.expires_in, 60);
    // 只存哈希
    assert.equal(grants.length, 1);
    assert.notEqual(grants[0].token_hash, body.ticket);
  } finally {
    await s.close();
  }
});

test('GET /api/projects/:id/ports：返回端口列表（portal.md §4.7）', async () => {
  const port = { id: 'pa1', scope: 'project', port: 4000, role: 'frontend', run_id: null, hostname: 'alice-p-proj1-4000.fde.localhost', url: 'https://alice-p-proj1-4000.fde.localhost', exposure: 'private', state: 'allocated', released_at: null };
  const pool = {
    async query(sql, params) {
      if (sql.includes('FROM login_sessions s') && sql.includes('JOIN users')) {
        return { rows: [{ id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', session_id: 's1', expires_at: new Date(Date.now() + 3600000), last_seen_at: new Date() }] };
      }
      if (sql.includes('FROM projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL')) {
        return { rows: [{ id: 'p1', name: 'proj1', repo_url: 'https://git.example/a.git', root_path: '~/projects/proj1', slot: 0, template: 'node', created_at: new Date('2026-09-12T08:30:00.000Z') }] };
      }
      if (sql.includes('FROM port_allocations WHERE project_id = $1 AND state')) {
        return { rows: [port] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const s = await startServer({ pool });
  try {
    const r = await fetch(`${s.base}/api/projects/p1/ports`, { headers: { Cookie: 'fde_session_dev=tok' } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].hostname, 'alice-p-proj1-4000.fde.localhost');
  } finally {
    await s.close();
  }
});

test('F2：forward-auth 审计不记 query（含 ?preview_ticket=<明文>）', async () => {
  const pool = new FakePool({ users: [] });
  const s = await startServer({ pool });
  try {
    const secret = 'pt_S3CRET_TICKET_LEAK_CHECK';
    const res = await fetch(`${s.base}/api/forward-auth`, {
      headers: {
        'x-forwarded-host': 'alice-p-proj1-4000.fde.localhost',
        'x-forwarded-uri': `/?preview_ticket=${secret}&extra=1`,
      },
    });
    assert.equal(res.status, 404); // 无真实 allocation → deny；审计仍写入
    const auditRow = pool.audit.find((a) => a.action === 'auth.forward_auth');
    assert.ok(auditRow, 'forward-auth 审计已写入');
    const details = JSON.parse(auditRow.details);
    assert.equal(details.uri, '/', '审计只记 path，剥离所有 query');
    assert.ok(!details.uri.includes('preview_ticket'), '不含 preview_ticket');
    assert.ok(!JSON.stringify(auditRow).includes(secret), '审计不含 ticket 明文');
  } finally {
    await s.close();
  }
});
