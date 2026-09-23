// 单测：issue #38 Phase B2 admin UI 服务端——用户管理端点 / provision 端点 /
//       GET llm 的 active_run 字段 / GET /admin 页面路由（302/403/200）/ 非 admin 403。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool，不碰真实 DB / docker。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const FDE_USER = {
  id: 'b0000000-0000-4000-8000-000000000002', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-admin-b2-test';

/** admin 测试 pool：FakePool（会话/audit）+ users CRUD / active run / llm echo 的最小模拟。 */
class AdminPool extends FakePool {
  constructor(seed = {}) {
    super({ users: [ADMIN, FDE_USER] });
    this.runs = seed.runs ?? [];               // [{id, session_id, status}]
    this.chatSessions = seed.chatSessions ?? []; // [{id, user_id}]
    this.llm = seed.llm ?? null;               // { binding, provider, models } | null
    this.nextUser = 0;
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    // 建用户：login / fde_name 唯一性核查（含非 active 行——真实 DB 有 UNIQUE 约束）
    if (sql.includes('SELECT 1 FROM users WHERE login')) {
      return { rows: this.users.filter((u) => u.login === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (sql.includes('SELECT 1 FROM users WHERE fde_name')) {
      return { rows: this.users.filter((u) => u.fde_name === params[0]).map(() => ({ '?column?': 1 })) };
    }
    // 建用户 INSERT（RETURNING 安全字段）
    if (sql.includes('INSERT INTO users (login, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)')) {
      this.nextUser += 1;
      const row = {
        id: `u-new-${this.nextUser}`, login: params[0], display_name: params[1],
        role: 'fde', fde_name: params[4] ?? null, auth_source: 'local', status: 'active',
        password_hash: params[2], totp_secret: params[3], created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [{ id: row.id, login: row.login, display_name: row.display_name, role: row.role, fde_name: row.fde_name, auth_source: row.auth_source, status: row.status, created_at: row.created_at }] };
    }
    // 用户列表
    if (sql.includes('FROM users ORDER BY')) {
      const rows = this.users.map((u) => ({
        id: u.id, login: u.login, display_name: u.display_name, role: u.role,
        fde_name: u.fde_name ?? null, auth_source: u.auth_source, status: u.status, created_at: u.created_at ?? new Date(),
      }));
      return { rows };
    }
    // 按 fde_name 查 active 用户（provision / GET llm active_run）
    if (sql.includes('FROM users WHERE fde_name') && sql.includes('status = \'active\'')) {
      return { rows: this.users.filter((u) => u.fde_name === params[0] && u.status === 'active') };
    }
    // active run 判定（口径同 sessions.js ACTIVE_RUN_STATES）
    if (sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions')) {
      const hit = this.chatSessions.some(
        (s) => s.user_id === params[0] && this.runs.some((r) => r.session_id === s.id && ['queued', 'running', 'cancelling'].includes(r.status)),
      );
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    // getFdeLlmConfig 的 JOIN（GET llm 回显用）：有 binding → 拼一行
    if (sql.includes('FROM fde_llm_bindings b') && sql.includes('main_upstream')) {
      if (!this.llm?.binding) return { rows: [] };
      const b = this.llm.binding;
      const m = (id) => this.llm.models.find((x) => x.id === id);
      const slot = (id) => (id == null ? null : m(id));
      const sMain = slot(b.main_model_id);
      const sEmb = slot(b.embedding_model_id ?? null);
      const sVis = slot(b.vision_model_id ?? null);
      return {
        rows: [{
          fde_id: b.fde_id, api_key: b.api_key ?? null, state: b.state,
          provider_id: this.llm.provider.id, provider_name: this.llm.provider.name, base_url: this.llm.provider.base_url,
          main_upstream: sMain?.model_id ?? null, main_name: sMain?.name ?? null, main_type: sMain?.type ?? null,
          embedding_upstream: sEmb?.model_id ?? null, embedding_name: sEmb?.name ?? null, embedding_type: sEmb?.type ?? null,
          vision_upstream: sVis?.model_id ?? null, vision_name: sVis?.name ?? null, vision_type: sVis?.type ?? null,
        }],
      };
    }
    return super.query(sql, params);
  }

  async connect() {
    const pool = this;
    return {
      query: (sql, params) => pool.query(sql, params),
      release() {},
    };
  }
}

async function startAdminServer({ seed = {}, docker = null } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-admin-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  fs.writeFileSync(path.join(staticDir, 'admin.html'), 'ADMIN-HTML');
  const config = {
    cookie: cookieSettings('dev-admin', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1',
    staticDir,
  };
  const pool = new AdminPool(seed);
  const server = createServer({ pool, config, docker, log: { error: () => {}, warn: () => {}, log: () => {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${config.cookie.name}=${ADMIN_TOKEN}`;
  return {
    pool, base, cookie,
    close: () => new Promise((res) => server.close(res)),
  };
}

test('admin 用户管理：建用户 201（role=fde，totp_secret 仅本次响应）→ 列表无敏感字段', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  try {
    const H = { cookie, 'content-type': 'application/json' };
    const res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ login: 'bob', display_name: 'Bob', password: 'secret-pass-1', fde_name: 'bob' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.login, 'bob');
    assert.equal(body.user.role, 'fde');
    assert.equal(body.user.fde_name, 'bob');
    assert.equal(body.user.status, 'active');
    assert.match(body.totp_secret, /^[A-Z2-7]{32}$/, 'TOTP 种子 base32（20 字节）');
    assert.ok(body.totp_uri.startsWith('otpauth://totp/'), '给 otpauth provisioning URI');
    assert.ok(!('password_hash' in body.user) && !('totp_secret' in body.user), 'user 对象无敏感字段');

    // 列表：含新用户，但绝不回显 totp_secret / password_hash
    const list = await (await fetch(`${base}/api/admin/users`, { headers: { cookie } })).json();
    const bob = list.items.find((u) => u.login === 'bob');
    assert.ok(bob, '列表含新用户');
    assert.equal(bob.fde_name, 'bob');
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes('totp_secret'), '列表响应无 totp_secret 键');
    assert.ok(!raw.includes(body.totp_secret), '列表响应无 TOTP 种子值');
    assert.ok(!raw.includes('password_hash'), '列表响应无口令哈希键');
    assert.ok(!raw.includes('secret-pass-1'), '任何响应不含明文口令');
    assert.equal(pool.users.find((u) => u.login === 'bob').password_hash.startsWith('scrypt$'), true, 'DB 侧 scrypt 哈希（bootstrap-admin 同口径）');
  } finally {
    await close();
  }
});

test('admin 用户管理：重复 login → 409；缺字段 / 非法 fde_name → 400', async () => {
  const { base, cookie, close } = await startAdminServer();
  try {
    const H = { cookie, 'content-type': 'application/json' };
    // 重复 login
    let res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H, body: JSON.stringify({ login: 'alice', password: 'whatever-1' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'login_conflict');
    // 缺 password
    res = await fetch(`${base}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ login: 'carol' }) });
    assert.equal(res.status, 400);
    // 非法 fde_name
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H, body: JSON.stringify({ login: 'carol', password: 'whatever-1', fde_name: 'BAD_NAME' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'fde_name');
    // 尾随连字符会被 DB CHECK 拒绝，必须在落库前返回 validation_failed
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H, body: JSON.stringify({ login: 'dave', password: 'whatever-1', fde_name: 'abc-' }),
    });
    assert.equal(res.status, 400);
    const invalidFde = await res.json();
    assert.equal(invalidFde.error.code, 'validation_failed');
    assert.equal(invalidFde.error.details.field, 'fde_name');
    // fde_name 被占用
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H, body: JSON.stringify({ login: 'carol', password: 'whatever-1', fde_name: 'alice' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'fde_name_conflict');
  } finally {
    await close();
  }
});

test('admin 用户管理 + provision + llm：非 admin 一律 403，无 cookie 401', async () => {
  const { base, pool, cookie, close } = await startAdminServer();
  try {
    const cookieName = cookie.split('=')[0];
    pool.sessions.push({
      id: 'ls-fde', user_id: FDE_USER.id, token_hash: auth.hashToken('tok-fde-b2'),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    const endpoints = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', '{}'],
      ['POST', '/api/admin/fdes/alice/provision', '{}'],
      ['GET', '/api/admin/fdes/alice/llm'],
    ];
    for (const [method, p, body] of endpoints) {
      const anon = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body });
      assert.equal(anon.status, 401, `${method} ${p} 无 cookie → 401`);
      const fde = await fetch(`${base}${p}`, {
        method, headers: { 'content-type': 'application/json', cookie: `${cookieName}=tok-fde-b2` }, body,
      });
      assert.equal(fde.status, 403, `${method} ${p} fde role → 403`);
      assert.equal((await fde.json()).error.code, 'forbidden');
    }
  } finally {
    await close();
  }
});

test('admin provision：未知 fde → 500 provision_failed（对账循环后台兜底，错误信息回显）', async () => {
  const { base, cookie, close } = await startAdminServer();
  try {
    const invalid = await fetch(`${base}/api/admin/fdes/abc-/provision`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.error.code, 'validation_failed');
    assert.equal(invalidBody.error.details.field, 'fde_name');

    const res = await fetch(`${base}/api/admin/fdes/ghost/provision`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'provision_failed');
    assert.match(body.error.message, /no active user with fde_name=ghost/);
  } finally {
    await close();
  }
});

test('GET llm 响应附加 active_run：有 queued/running/cancelling run → true，否则 false', async () => {
  const llm = {
    binding: { fde_id: FDE_USER.id, state: 'active', api_key: 'sk-test-1234', provider_id: 'p1', main_model_id: 'm1', embedding_model_id: null, vision_model_id: null },
    provider: { id: 'p1', name: 'openai', base_url: 'https://api.openai.com/v1' },
    models: [{ id: 'm1', provider_id: 'p1', model_id: 'gpt-4o', name: 'GPT-4o', type: 'text' }],
  };
  // 无活跃 run
  const a = await startAdminServer({ seed: { llm, chatSessions: [{ id: 's1', user_id: FDE_USER.id }], runs: [{ id: 'r1', session_id: 's1', status: 'finished' }] } });
  try {
    const res = await fetch(`${a.base}/api/admin/fdes/alice/llm`, { headers: { cookie: a.cookie } });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.active_run, false);
    assert.equal(body.config.main.model_id, 'gpt-4o');
    assert.equal(body.config.api_key, 'sk-...1234', 'key 只给掩码');
  } finally {
    await a.close();
  }
  // 有 running run → true
  const b = await startAdminServer({ seed: { llm, chatSessions: [{ id: 's1', user_id: FDE_USER.id }], runs: [{ id: 'r1', session_id: 's1', status: 'running' }] } });
  try {
    const res = await fetch(`${b.base}/api/admin/fdes/alice/llm`, { headers: { cookie: b.cookie } });
    const body = await res.json();
    assert.equal(body.active_run, true);
  } finally {
    await b.close();
  }
  // 无配置 → config null，active_run false
  const c = await startAdminServer();
  try {
    const res = await fetch(`${c.base}/api/admin/fdes/alice/llm`, { headers: { cookie: c.cookie } });
    const body = await res.json();
    assert.equal(body.config, null);
    assert.equal(body.active_run, false);
  } finally {
    await c.close();
  }
});

test('GET /admin 页面：未登录 → 302 /；非 admin → 403；admin → 200 admin.html', async () => {
  const { base, pool, cookie, close } = await startAdminServer();
  try {
    const anon = await fetch(`${base}/admin`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/');

    pool.sessions.push({
      id: 'ls-fde2', user_id: FDE_USER.id, token_hash: auth.hashToken('tok-fde-b2-admin'),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    const cookieName = cookie.split('=')[0];
    const fde = await fetch(`${base}/admin`, { headers: { cookie: `${cookieName}=tok-fde-b2-admin` } });
    assert.equal(fde.status, 403);
    assert.equal((await fde.json()).error.code, 'forbidden');

    const admin = await fetch(`${base}/admin`, { headers: { cookie } });
    assert.equal(admin.status, 200);
    assert.match(admin.headers.get('content-type'), /text\/html/);
    assert.equal(await admin.text(), 'ADMIN-HTML');
  } finally {
    await close();
  }
});
