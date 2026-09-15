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

async function startServer({ users = [], overrides = {} } = {}) {
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
  const pool = new FakePool({ users });
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
