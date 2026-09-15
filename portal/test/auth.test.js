// 单测：session 只存 hash + 密码校验（错口令 401、正确口令拿 cookie）。
// 隔离约定（docs/testing.md §2.1）：注入 in-memory fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import * as auth from '../src/auth.js';
import { cookieSettings } from '../src/config.js';
import { createServer } from '../src/http.js';

/** 最小 in-memory pool，模拟 auth.js / http.js 用到的 SQL。 */
class FakePool {
  constructor(users = []) {
    this.users = users; // [{id, login, display_name, role, fde_name, auth_source, status, password_hash}]
    this.sessions = [];
    this.insertedSessions = [];
  }

  async query(sql, params = []) {
    if (sql.includes('schema_migrations')) {
      return { rows: [{ version: '0000_baseline' }] };
    }
    if (sql.includes('FROM users WHERE login')) {
      const login = params[0];
      const u = this.users.find((x) => x.login === login && x.status === 'active');
      return { rows: u ? [u] : [] };
    }
    if (sql.includes('INSERT INTO login_sessions')) {
      const [userId, tokenHash] = params;
      this.insertedSessions.push({ user_id: userId, token_hash: tokenHash });
      this.sessions.push({ user_id: userId, token_hash: tokenHash });
      return { rows: [] };
    }
    if (sql.includes('FROM login_sessions s')) {
      const tokenHash = params[0];
      const s = this.sessions.find((x) => x.token_hash === tokenHash && !x.revoked_at);
      if (!s) return { rows: [] };
      const u = this.users.find((x) => x.id === s.user_id);
      return {
        rows: [
          {
            id: u.id,
            login: u.login,
            display_name: u.display_name,
            role: u.role,
            fde_name: u.fde_name,
            auth_source: u.auth_source,
            status: u.status,
            session_id: 's1',
            expires_at: s.expires_at,
          },
        ],
      };
    }
    if (sql.includes('UPDATE login_sessions SET revoked_at')) {
      const tokenHash = params[0];
      const s = this.sessions.find((x) => x.token_hash === tokenHash);
      if (s) s.revoked_at = new Date();
      return { rows: [] };
    }
    return { rows: [] };
  }

  async end() {}
}

test('createSession 只存 token_hash，DB 里查不到原文', async () => {
  const pool = new FakePool();
  const { token, tokenHash } = await auth.createSession(pool, 'user-1', { ttlSeconds: 604800 });
  assert.ok(token);
  assert.equal(pool.insertedSessions.length, 1);
  assert.equal(pool.insertedSessions[0].token_hash, tokenHash);
  assert.equal(pool.insertedSessions[0].token_hash, auth.hashToken(token));
  assert.notEqual(pool.insertedSessions[0].token_hash, token);
  // 落库内容任何字段都不含 token 原文
  assert.ok(!JSON.stringify(pool.insertedSessions).includes(token));
});

test('口令校验：错口令 401、正确口令拿到 cookie 且 /api/me 返回用户', async () => {
  const password = 'correct horse battery staple';
  const user = {
    id: 'u1',
    login: 'alice',
    display_name: 'Alice',
    role: 'admin',
    fde_name: null,
    auth_source: 'local',
    status: 'active',
    password_hash: await auth.hashPassword(password),
  };
  const pool = new FakePool([user]);
  const config = {
    cookie: cookieSettings('prod', 604800),
    sessionTtlSeconds: 604800,
    staticDir: process.cwd(),
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // 错口令
    const bad = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'wrong' }),
    });
    assert.equal(bad.status, 401);

    // 正确口令
    const good = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password }),
    });
    assert.equal(good.status, 200);
    const setCookie = good.headers.get('set-cookie');
    assert.ok(setCookie);
    assert.ok(setCookie.startsWith('__Host-fde_session='));
    assert.ok(setCookie.includes('Secure'));
    assert.ok(setCookie.includes('HttpOnly'));
    assert.ok(setCookie.includes('SameSite=Lax'));
    assert.ok(!setCookie.toLowerCase().includes('domain=')); // host-only

    const token = setCookie.split(';')[0].split('=')[1];
    // 带 cookie 调 /api/me
    const me = await fetch(`${base}/api/me`, {
      headers: { Cookie: `__Host-fde_session=${token}` },
    });
    assert.equal(me.status, 200);
    const body = await me.json();
    assert.equal(body.user.login, 'alice');
    assert.equal(body.user.role, 'admin');
  } finally {
    await new Promise((res) => server.close(res));
  }
});
