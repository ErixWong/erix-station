// 单测：issue #38 Phase B2 admin UI 服务端——用户管理端点 / provision 端点 /
//       GET llm 的 active_run 字段 / GET /admin 兼容跳转（302 → /#/admin，issue #61 P4）/ 非 admin 403。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool，不碰真实 DB / docker。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteUser } from '../src/admin.js';
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
const TEST_GIT_HOST_ID = 'c0000000-0000-4000-8000-000000000011';

/** admin 测试 pool：FakePool（会话/audit）+ users CRUD / active run / llm echo 的最小模拟。 */
class AdminPool extends FakePool {
  constructor(seed = {}) {
    super({ users: [ADMIN, FDE_USER].map((user) => ({ ...user })) });
    this.runs = seed.runs ?? [];               // [{id, session_id, status}]
    this.chatSessions = seed.chatSessions ?? []; // [{id, user_id}]
    this.containers = seed.containers ?? [];     // [{user_id, status}]
    this.llm = seed.llm ?? null;               // { binding, provider, models } | null
    this.nextUser = 0;
    this.sqlLog = [];
    this.gitHosts = seed.gitHosts ?? [{
      id: TEST_GIT_HOST_ID, provider: 'gitea', enabled: true, base_url: 'https://git.example.test',
    }];
    this.gitAccounts = [];
    this.onboardings = [];
    this.forceEmailConflict = false;
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });
    // 建用户：login / fde_name 唯一性核查（含非 active 行——真实 DB 有 UNIQUE 约束）
    if (sql.includes('SELECT 1 FROM users WHERE login')) {
      return { rows: this.users.filter((u) => u.login === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (sql.includes('SELECT 1 FROM users WHERE email')) {
      return { rows: this.users.filter((u) => u.email === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (sql.includes('SELECT 1 FROM users WHERE fde_name')) {
      return {
        rows: this.users
          .filter((u) => u.fde_name === params[0] && (!sql.includes('id <>') || u.id !== params[1]))
          .map(() => ({ '?column?': 1 })),
      };
    }
    if (sql.includes('SELECT id, login FROM users WHERE id')) {
      const user = this.users.find((u) => u.id === params[0]);
      return { rows: user ? [{ id: user.id, login: user.login }] : [] };
    }
    if (sql.includes('SELECT id, provider, enabled FROM git_hosts WHERE id')) {
      return { rows: this.gitHosts.filter((host) => host.id === params[0]) };
    }
    if (sql.includes('INSERT INTO fde_onboarding')) {
      const [fdeId, steps] = params;
      const row = {
        fde_id: fdeId, state: 'pending', steps: JSON.parse(steps), last_error: null, attempt: 0,
      };
      const existing = this.onboardings.find((item) => item.fde_id === fdeId);
      if (existing) Object.assign(existing, row);
      else this.onboardings.push(row);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO fde_git_accounts')) {
      const [fdeId, gitHostId] = params;
      const existing = this.gitAccounts.find((item) => item.fde_id === fdeId);
      if (existing) existing.git_host_id = gitHostId;
      else this.gitAccounts.push({ fde_id: fdeId, git_host_id: gitHostId });
      return { rows: [] };
    }
    if (sql.includes('SELECT state, steps, last_error FROM fde_onboarding')) {
      const row = this.onboardings.find((item) => item.fde_id === params[0]);
      return { rows: row ? [{ state: row.state, steps: row.steps, last_error: row.last_error }] : [] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes('SET state = \'pending\'')) {
      const row = this.onboardings.find((item) => item.fde_id === params[0]);
      if (!row) return { rows: [] };
      row.state = 'pending';
      row.steps = JSON.parse(params[1]);
      row.last_error = null;
      return { rows: [{ state: row.state, steps: row.steps, last_error: row.last_error }] };
    }
    if (sql.includes('WITH updated AS') && sql.includes('UPDATE users SET')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      const field = (name) => {
        const match = sql.match(new RegExp(`${name} = \\$([0-9]+)`));
        return match ? params[Number(match[1]) - 1] : undefined;
      };
      for (const name of ['display_name', 'role', 'fde_name']) {
        const value = field(name);
        if (value !== undefined) user[name] = value;
      }
      const status = field('status');
      if (status !== undefined) {
        user.status = status;
        user.disabled_at = status === 'disabled' ? new Date() : null;
      }
      if (user.status === 'disabled') {
        for (const session of this.sessions) {
          if (session.user_id === user.id && session.revoked_at === null) session.revoked_at = new Date();
        }
      }
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name, role: user.role,
          fde_name: user.fde_name ?? null, auth_source: user.auth_source, status: user.status,
          created_at: user.created_at ?? new Date(), totp_enabled: user.totp_secret != null,
          last_login_at: null,
        }],
      };
    }
    if (sql.includes('WITH target AS') && sql.includes('UPDATE users SET')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      if (sql.includes('password_hash')) user.password_hash = params[1];
      if (sql.includes('totp_secret = $2')) {
        user.totp_secret = params[1];
        user.last_totp_step = null;
      }
      if (sql.includes('totp_secret = NULL')) {
        user.totp_secret = null;
        user.last_totp_step = null;
      }
      for (const session of this.sessions) {
        if (session.user_id === user.id && session.revoked_at === null) session.revoked_at = new Date();
      }
      if (sql.includes('totp_secret = $2')) {
        return {
          rows: [{
            id: user.id, login: user.login, display_name: user.display_name, role: user.role,
            fde_name: user.fde_name ?? null, auth_source: user.auth_source, status: user.status,
            created_at: user.created_at ?? new Date(), totp_enabled: true, last_login_at: null,
          }],
        };
      }
      return { rows: [{ id: user.id, login: user.login }] };
    }
    if (sql.includes('SELECT 1 FROM containers WHERE user_id')) {
      return { rows: this.containers.some((container) => container.user_id === params[0] && container.status !== 'removed') ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('SELECT id, login FROM users WHERE id = $1 FOR UPDATE')) {
      const user = this.users.find((u) => u.id === params[0]);
      return { rows: user ? [{ id: user.id, login: user.login }] : [] };
    }
    if (sql.includes('SELECT state FROM fde_onboarding WHERE fde_id = $1 FOR UPDATE')) {
      const row = this.onboardings.find((item) => item.fde_id === params[0]);
      return { rows: row ? [{ state: row.state }] : [] };
    }
    if (sql.includes('DELETE FROM login_sessions WHERE user_id')) {
      this.sessions = this.sessions.filter((session) => session.user_id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM login_pending WHERE user_id')) {
      this.pending = this.pending.filter((pending) => pending.user_id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM users WHERE id')) {
      const index = this.users.findIndex((user) => user.id === params[0]);
      if (index === -1) return { rows: [] };
      this.users.splice(index, 1);
      return { rows: [{ id: params[0] }] };
    }
    // 建用户 INSERT（RETURNING 安全字段）
    if (sql.includes('INSERT INTO users (login, email, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)')) {
      if (this.forceEmailConflict) {
        const error = new Error('duplicate email');
        error.code = '23505';
        error.constraint = 'users_email_key';
        throw error;
      }
      this.nextUser += 1;
      const row = {
        id: `u-new-${this.nextUser}`, login: params[0], email: params[1], display_name: params[2],
        role: 'fde', fde_name: params[5], auth_source: 'local', status: 'active',
        password_hash: params[3], totp_secret: params[4], created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [{ id: row.id, login: row.login, display_name: row.display_name, role: row.role, fde_name: row.fde_name, auth_source: row.auth_source, status: row.status, created_at: row.created_at, totp_enabled: row.totp_secret !== null }] };
    }
    // 用户列表
    if (sql.includes('FROM users') && sql.includes('LEFT JOIN')) {
      const rows = this.users.map((u) => ({
        id: u.id, login: u.login, display_name: u.display_name, role: u.role,
        fde_name: u.fde_name ?? null, auth_source: u.auth_source, status: u.status, created_at: u.created_at ?? new Date(),
        totp_enabled: u.totp_secret != null,
        last_login_at: this.sessions
          .filter((session) => session.user_id === u.id)
          .map((session) => session.created_at)
          .filter(Boolean)
          .sort((a, b) => new Date(b) - new Date(a))[0] ?? null,
        git_host_id: this.gitAccounts.find((account) => account.fde_id === u.id)?.git_host_id ?? null,
        onboarding_state: this.onboardings.find((entry) => entry.fde_id === u.id)?.state ?? null,
        onboarding_steps: this.onboardings.find((entry) => entry.fde_id === u.id)?.steps ?? null,
        onboarding_error: this.onboardings.find((entry) => entry.fde_id === u.id)?.last_error ?? null,
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
    // getFdeLlmConfig 的直接 binding 读取（id 与数据面 model_name 分列保存）。
    if (sql.includes('FROM fde_llm_bindings') && sql.includes('main_model_id')) {
      if (!this.llm?.binding) return { rows: [] };
      const b = this.llm.binding;
      return {
        rows: [{
          provider_id: b.provider_id, api_key: b.api_key ?? null, gateway: b.gateway ?? 'litellm',
          gateway_user_id: b.gateway_user_id ?? null, key_id: b.key_id ?? null, key_alias: b.key_alias ?? null,
          state: b.state, main_model_id: b.main_model_id, main_model_name: b.main_model_name ?? null,
          embedding_model_id: b.embedding_model_id ?? null, vision_model_id: b.vision_model_id ?? null,
          embedding_model_name: b.embedding_model_name ?? null, vision_model_name: b.vision_model_name ?? null,
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
  // P4：旧 index.html/admin.html 静态页已退役（serveStatic 只服务注入的 app/），fixture 不再写文件。
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-admin-static-'));
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

test('admin 用户管理：创建用户默认不启用 TOTP，响应与列表无种子', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  try {
    const H = { cookie, 'content-type': 'application/json' };
    const res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        login: 'bob', display_name: 'Bob', password: 'secret-pass-1',
        email: 'bob@example.test', fde_name: 'bob', git_host_id: TEST_GIT_HOST_ID,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.login, 'bob');
    assert.equal(body.user.role, 'fde');
    assert.equal(body.user.fde_name, 'bob');
    assert.equal(body.user.status, 'active');
    assert.deepEqual(body.onboarding, { state: 'pending', step: 'provision', error: null });
    assert.equal(pool.gitAccounts.find((row) => row.fde_id === body.user.id)?.git_host_id, TEST_GIT_HOST_ID);
    assert.equal(body.user.totp_enabled, false);
    assert.equal(pool.users.find((u) => u.login === 'bob').totp_secret, null, '未启用时 DB totp_secret 为 NULL');
    assert.ok(!Object.hasOwn(body, 'totp_secret') && !Object.hasOwn(body, 'totp_uri'), '未启用时响应不含一次性种子字段');
    assert.ok(!('password_hash' in body.user) && !('totp_secret' in body.user), 'user 对象无敏感字段');

    // 列表：含新用户，但绝不回显 totp_secret / password_hash
    const olderLogin = new Date('2026-10-03T01:00:00.000Z');
    const latestLogin = new Date('2026-10-04T01:00:00.000Z');
    const createdUser = pool.users.find((u) => u.login === 'bob');
    pool.sessions.push(
      { id: 'ls-bob-old', user_id: createdUser.id, created_at: olderLogin, revoked_at: null },
      { id: 'ls-bob-new', user_id: createdUser.id, created_at: latestLogin, revoked_at: new Date(0) },
    );
    const list = await (await fetch(`${base}/api/admin/users`, { headers: { cookie } })).json();
    const bob = list.items.find((u) => u.login === 'bob');
    assert.ok(bob, '列表含新用户');
    assert.equal(bob.fde_name, 'bob');
    assert.equal(bob.totp_enabled, false);
    assert.equal(bob.last_login_at, latestLogin.toISOString());
    const root = list.items.find((u) => u.login === 'root');
    assert.equal(root.totp_enabled, false);
    assert.ok(root.last_login_at);
    const raw = JSON.stringify(list);
    assert.ok(!raw.includes('totp_secret'), '列表响应无 totp_secret 键');
    assert.ok(!raw.includes('password_hash'), '列表响应无口令哈希键');
    assert.ok(!raw.includes('secret-pass-1'), '任何响应不含明文口令');
    assert.ok(!raw.includes('bob@example.test'), '用户列表不返回 email');
    assert.deepEqual(bob.onboarding, { state: 'pending', step: 'provision', error: null });
    assert.equal(pool.users.find((u) => u.login === 'bob').password_hash.startsWith('scrypt$'), true, 'DB 侧 scrypt 哈希（bootstrap-admin 同口径）');
  } finally {
    await close();
  }
});

test('admin 用户管理：显式启用 TOTP 时一次性下发种子与 URI，审计不含种子', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  try {
    const res = await fetch(`${base}/api/admin/users`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        login: 'totp-bob', password: 'secret-pass-1', email: 'totp-bob@example.test',
        fde_name: 'totp-bob', git_host_id: TEST_GIT_HOST_ID, totp_enabled: true,
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.user.totp_enabled, true);
    assert.match(body.totp_secret, /^[A-Z2-7]{32}$/, 'TOTP 种子仍为 20 字节 base32');
    assert.match(body.totp_uri, new RegExp(`secret=${body.totp_secret}`));
    assert.match(body.totp_uri, /issuer=erix-station-test/);
    assert.equal(pool.users.find((u) => u.login === 'totp-bob').totp_secret, body.totp_secret);
    assert.ok(!('totp_secret' in body.user), 'user 对象仍无敏感字段');
    const audit = pool.sqlLog.find(({ sql, params }) =>
      sql.includes("'admin.user_created'") && sql.includes('INSERT INTO audit_log') && params[1] === 'totp-bob');
    assert.ok(audit, '用户创建仍写审计');
    assert.ok(!JSON.stringify(audit).includes(body.totp_secret), '审计不含 TOTP 种子');
  } finally {
    await close();
  }
});

test('admin 用户管理：email / fde_name 必填校验与重复 login、email 冲突', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  try {
    const H = { cookie, 'content-type': 'application/json' };
    const fields = { email: 'carol@example.test', git_host_id: TEST_GIT_HOST_ID };
    // 重复 login
    let res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'alice', password: 'whatever-1', fde_name: 'carol' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'login_conflict');
    // 缺 password
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ login: 'carol', password: 'whatever-1', fde_name: 'carol', git_host_id: TEST_GIT_HOST_ID }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'email');
    // 邮箱格式错误。
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, email: 'not-an-email', login: 'carol', password: 'whatever-1', fde_name: 'carol' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'email');
    // fde_name 缺失也拒绝。
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'carol', password: 'whatever-1' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'fde_name');
    // 非法 fde_name
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'carol', password: 'whatever-1', fde_name: 'BAD_NAME' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.details.field, 'fde_name');
    // 尾随连字符会被 DB CHECK 拒绝，必须在落库前返回 validation_failed
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'dave', password: 'whatever-1', fde_name: 'abc-' }),
    });
    assert.equal(res.status, 400);
    const invalidFde = await res.json();
    assert.equal(invalidFde.error.code, 'validation_failed');
    assert.equal(invalidFde.error.details.field, 'fde_name');
    // fde_name 被占用
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'carol', password: 'whatever-1', fde_name: 'alice' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'fde_name_conflict');
    // email 冲突
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'carol', password: 'whatever-1', fde_name: 'carol' }),
    });
    assert.equal(res.status, 201);
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ ...fields, login: 'carol-2', password: 'whatever-1', fde_name: 'carol-2' }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'email_conflict');
    pool.forceEmailConflict = true;
    res = await fetch(`${base}/api/admin/users`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        email: 'race@example.test', git_host_id: TEST_GIT_HOST_ID,
        login: 'email-race', password: 'whatever-1', fde_name: 'email-race',
      }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'email_conflict');
  } finally {
    await close();
  }
});

test('admin 用户管理：开户重试只重排 failed，running 返回 409，未知用户返回 404', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  try {
    const H = { cookie, 'content-type': 'application/json' };
    pool.onboardings.push({
      fde_id: FDE_USER.id, state: 'failed',
      steps: { provision: { state: 'failed', error: 'docker unavailable' }, materialize: { state: 'pending' } },
      last_error: 'docker unavailable', attempt: 1,
    });
    let response = await fetch(`${base}/api/admin/users/${FDE_USER.id}/onboard/retry`, { method: 'POST', headers: H });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).onboarding, { state: 'pending', step: 'provision', error: null });
    assert.equal(pool.onboardings[0].steps.provision.state, 'pending');

    pool.onboardings[0].state = 'running';
    response = await fetch(`${base}/api/admin/users/${FDE_USER.id}/onboard/retry`, { method: 'POST', headers: H });
    assert.equal(response.status, 409);

    response = await fetch(`${base}/api/admin/users/c0000000-0000-4000-8000-000000000099/onboard/retry`, {
      method: 'POST', headers: H,
    });
    assert.equal(response.status, 404);
  } finally {
    await close();
  }
});

test('admin 用户管理：PATCH 更新资料并在禁用时吊销会话；重新启用清空 disabled_at', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  pool.sessions.push(
    { id: 'ls-alice-active', user_id: FDE_USER.id, created_at: new Date(), revoked_at: null },
    { id: 'ls-alice-revoked', user_id: FDE_USER.id, created_at: new Date(), revoked_at: new Date(0) },
  );
  try {
    const res = await fetch(`${base}/api/admin/users/${FDE_USER.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: ' Alice Wong ', role: 'admin', fde_name: 'alice-new', status: 'disabled' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      { display_name: body.user.display_name, role: body.user.role, fde_name: body.user.fde_name, status: body.user.status },
      { display_name: 'Alice Wong', role: 'admin', fde_name: 'alice-new', status: 'disabled' },
    );
    assert.ok(pool.users.find((user) => user.id === FDE_USER.id).disabled_at instanceof Date);
    assert.ok(pool.sessions.find((session) => session.id === 'ls-alice-active').revoked_at);
    assert.equal(pool.sessions.find((session) => session.id === 'ls-alice-revoked').revoked_at.getTime(), 0);
    assert.ok(pool.sqlLog.some(({ sql }) => sql.includes('UPDATE login_sessions SET revoked_at = now()')));

    const enabled = await fetch(`${base}/api/admin/users/${FDE_USER.id}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
    assert.equal(enabled.status, 200);
    assert.equal((await enabled.json()).user.status, 'active');
    assert.equal(pool.users.find((user) => user.id === FDE_USER.id).disabled_at, null);
  } finally {
    await close();
  }
});

test('admin 用户管理：PATCH 至少一个字段且拒绝不可改 login、非法字段与重复 fde_name', async () => {
  const { base, cookie, close } = await startAdminServer();
  try {
    const patch = (id, body) => fetch(`${base}/api/admin/users/${id}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    for (const body of [{}, { login: 'alice-2' }, { role: 'owner' }, { status: 'pending' }, { fde_name: 'BAD_NAME' }]) {
      const res = await patch(FDE_USER.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await res.json()).error.code, 'validation_failed');
    }
    let res = await patch(ADMIN.id, { fde_name: 'alice' });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'fde_name_conflict');

    res = await fetch(`${base}/api/admin/users/not-a-uuid`, { headers: { cookie } });
    assert.equal(res.status, 400);
    res = await patch('c0000000-0000-4000-8000-000000000003', { role: 'admin' });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('admin 用户管理：DELETE 自删冲突、活动资源保护；无依赖用户删除会清理会话', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  pool.sessions.push({ id: 'ls-alice-delete', user_id: FDE_USER.id, created_at: new Date(), revoked_at: null });
  pool.pending.push({ id: 'pending-alice', user_id: FDE_USER.id });
  try {
    let res = await fetch(`${base}/api/admin/users/${ADMIN.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'self_delete');

    const withContainer = await startAdminServer({ seed: { containers: [{ user_id: FDE_USER.id, status: 'running' }] } });
    try {
      res = await fetch(`${withContainer.base}/api/admin/users/${FDE_USER.id}`, {
        method: 'DELETE', headers: { cookie: withContainer.cookie },
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error.code, 'user_has_active_fde');
    } finally {
      await withContainer.close();
    }
    const withRun = await startAdminServer({
      seed: { chatSessions: [{ id: 's1', user_id: FDE_USER.id }], runs: [{ id: 'r1', session_id: 's1', status: 'cancelling' }] },
    });
    try {
      res = await fetch(`${withRun.base}/api/admin/users/${FDE_USER.id}`, {
        method: 'DELETE', headers: { cookie: withRun.cookie },
      });
      assert.equal(res.status, 409);
      assert.equal((await res.json()).error.code, 'user_has_active_fde');
    } finally {
      await withRun.close();
    }

    res = await fetch(`${base}/api/admin/users/${FDE_USER.id}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(res.status, 204);
    assert.equal(pool.users.some((user) => user.id === FDE_USER.id), false);
    assert.equal(pool.sessions.some((session) => session.user_id === FDE_USER.id), false);
    assert.equal(pool.pending.some((pending) => pending.user_id === FDE_USER.id), false);

    res = await fetch(`${base}/api/admin/users/c0000000-0000-4000-8000-000000000003`, {
      method: 'DELETE', headers: { cookie },
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

function makeDeleteUserPool(fdeName) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT id, login FROM users WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: FDE_USER.id, login: FDE_USER.login }] };
      }
      if (sql.includes('SELECT state FROM fde_onboarding WHERE fde_id = $1 FOR UPDATE')) return { rows: [] };
      if (sql.includes('FROM containers WHERE user_id') || sql.includes('FROM runs r')) return { rows: [] };
      if (sql.includes('DELETE FROM login_sessions') || sql.includes('DELETE FROM login_pending')) return { rows: [] };
      if (sql.includes('DELETE FROM users WHERE id')) return { rows: [{ id: FDE_USER.id, fde_name: fdeName }] };
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {},
  };
  return {
    calls,
    pool: {
      async connect() { return client; },
      async query(sql) {
        calls.push(sql);
        if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
        throw new Error(`Unexpected pool query: ${sql}`);
      },
    },
  };
}

test('deleteUser：提交删除后按 RETURNING 的 fde_name 删除凭据文件', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-delete-user-'));
  const home = path.join(root, 'alice', 'home');
  fs.mkdirSync(home, { recursive: true });
  const credentialPath = path.join(home, '.git-credentials');
  fs.writeFileSync(credentialPath, 'https://alice:secret@github.com\n', { mode: 0o640 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { pool, calls } = makeDeleteUserPool('alice');

  assert.deepEqual(await deleteUser(pool, {
    actorId: ADMIN.id,
    userId: FDE_USER.id,
    config: { userSpaceRoot: root },
    log: { warn() {} },
  }), { ok: true });
  assert.ok(calls.includes('DELETE FROM users WHERE id = $1 RETURNING id, fde_name'));
  assert.equal(fs.existsSync(credentialPath), false);
});

test('deleteUser：凭据文件删除失败只告警，不影响已提交删除', async () => {
  const missingRoot = path.join(os.tmpdir(), `station-delete-missing-${Date.now()}-${Math.random()}`);
  const { pool } = makeDeleteUserPool('alice');
  const warnings = [];
  assert.deepEqual(await deleteUser(pool, {
    actorId: ADMIN.id,
    userId: FDE_USER.id,
    config: { userSpaceRoot: missingRoot },
    log: { warn: (message) => warnings.push(message) },
  }), { ok: true });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('git credential cleanup failed'));
});

test('deleteUser：审计写入失败不回滚已提交的用户删除', async () => {
  const calls = [];
  const auditError = Object.assign(new Error('audit foreign key violation'), { code: '23503' });
  let transactionAborted = false;
  let deletedInTransaction = false;
  let userStillExists = true;
  const client = {
    async query(sql) {
      calls.push({ executor: 'client', sql });
      if (sql === 'BEGIN') return { rows: [] };
      if (sql.includes('SELECT id, login FROM users WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: 'deleted-user', login: 'alice' }] };
      }
      if (sql.includes('SELECT state FROM fde_onboarding WHERE fde_id = $1 FOR UPDATE')) {
        return { rows: [] };
      }
      if (sql.includes('FROM containers WHERE user_id') || sql.includes('FROM runs r')) {
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM users WHERE id')) {
        deletedInTransaction = true;
        return { rows: [{ id: 'deleted-user' }] };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        transactionAborted = true;
        throw auditError;
      }
      if (sql === 'COMMIT') {
        // PostgreSQL treats COMMIT in an aborted transaction as ROLLBACK without throwing.
        if (!transactionAborted) userStillExists = !deletedInTransaction;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK' || sql.includes('DELETE FROM login_sessions') || sql.includes('DELETE FROM login_pending')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected transaction query: ${sql}`);
    },
    release() {
      calls.push({ executor: 'client', sql: 'RELEASE' });
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(sql, params) {
      calls.push({ executor: 'pool', sql, params });
      if (sql.includes('INSERT INTO audit_log')) {
        throw auditError;
      }
      throw new Error(`Unexpected pool query: ${sql}`);
    },
  };

  assert.deepEqual(await deleteUser(pool, { actorId: 'missing-admin', userId: 'deleted-user' }), { ok: true });
  assert.equal(userStillExists, false);
  const commitIndex = calls.findIndex((call) => call.executor === 'client' && call.sql === 'COMMIT');
  const releaseIndex = calls.findIndex((call) => call.executor === 'client' && call.sql === 'RELEASE');
  const auditIndex = calls.findIndex((call) => call.executor === 'pool' && call.sql.includes('INSERT INTO audit_log'));
  assert.ok(commitIndex >= 0 && commitIndex < releaseIndex && releaseIndex < auditIndex);
  assert.equal(calls.some((call) => call.executor === 'client' && call.sql.includes('INSERT INTO audit_log')), false);
  assert.deepEqual(calls[auditIndex].params, [
    'missing-admin', 'admin.user_deleted', 'alice', JSON.stringify({ user_id: 'deleted-user' }),
  ]);
});

test('deleteUser：拒绝与正在运行的开户任务并发删除', async () => {
  const client = {
    async query(sql) {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql.includes('SELECT id, login FROM users WHERE id = $1 FOR UPDATE')) {
        return { rows: [{ id: FDE_USER.id, login: FDE_USER.login }] };
      }
      if (sql.includes('SELECT state FROM fde_onboarding WHERE fde_id = $1 FOR UPDATE')) {
        return { rows: [{ state: 'running' }] };
      }
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected delete query: ${sql}`);
    },
    release() {},
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(
    deleteUser(pool, { actorId: 'admin', userId: FDE_USER.id }),
    (err) => err.code === 'user_onboarding_running' && err.httpStatus === 409,
  );
});

test('admin 用户管理：重置口令校验长度、更新 scrypt hash 并吊销会话', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  const user = pool.users.find((row) => row.id === FDE_USER.id);
  user.password_hash = 'scrypt$old';
  pool.sessions.push(
    { id: 'ls-alice-password', user_id: user.id, created_at: new Date(), revoked_at: null },
    { id: 'ls-alice-password-old', user_id: user.id, created_at: new Date(), revoked_at: new Date(0) },
  );
  try {
    let res = await fetch(`${base}/api/admin/users/${user.id}/reset-password`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: '' }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/admin/users/${user.id}/reset-password`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(257) }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/admin/users/${user.id}/reset-password`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'new-secret-1' }),
    });
    assert.equal(res.status, 200);
    const response = await res.text();
    assert.equal(response, '{"ok":true}');
    assert.ok(user.password_hash.startsWith('scrypt$'));
    assert.notEqual(user.password_hash, 'new-secret-1');
    assert.ok(pool.sessions.find((session) => session.id === 'ls-alice-password').revoked_at);
    assert.equal(pool.sessions.find((session) => session.id === 'ls-alice-password-old').revoked_at.getTime(), 0);
    assert.ok(pool.sqlLog.some(({ sql }) => sql.includes('UPDATE login_sessions SET revoked_at = now()')));

    res = await fetch(`${base}/api/admin/users/c0000000-0000-4000-8000-000000000003/reset-password`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'new-secret-1' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test('admin 用户管理：重置 TOTP 清空重放步并吊销会话，绝不回显种子', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  const user = pool.users.find((row) => row.id === FDE_USER.id);
  user.totp_secret = 'JBSWY3DPEHPK3PXP';
  user.last_totp_step = 1234;
  pool.sessions.push({ id: 'ls-alice-totp', user_id: user.id, created_at: new Date(), revoked_at: null });
  try {
    const res = await fetch(`${base}/api/admin/users/${user.id}/totp-reset`, { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.equal(raw, '{"ok":true}');
    assert.equal(raw.includes('JBSWY3DPEHPK3PXP'), false);
    assert.equal(user.totp_secret, null);
    assert.equal(user.last_totp_step, null);
    assert.ok(pool.sessions.find((session) => session.id === 'ls-alice-totp').revoked_at);

    const missing = await fetch(`${base}/api/admin/users/c0000000-0000-4000-8000-000000000003/totp-reset`, {
      method: 'POST', headers: { cookie },
    });
    assert.equal(missing.status, 404);
  } finally {
    await close();
  }
});

test('admin 用户管理：补绑/重绑 TOTP 只响应一次下发种子，清重放步、吊销会话并审计', async () => {
  const { base, cookie, pool, close } = await startAdminServer();
  const user = pool.users.find((row) => row.id === FDE_USER.id);
  user.totp_secret = 'PREVIOUS_TEST_TOTP_SEED';
  user.last_totp_step = 1234;
  pool.sessions.push(
    { id: 'ls-alice-enroll', user_id: user.id, created_at: new Date(), revoked_at: null },
    { id: 'ls-alice-enroll-old', user_id: user.id, created_at: new Date(), revoked_at: new Date(0) },
  );
  try {
    const res = await fetch(`${base}/api/admin/users/${user.id}/totp-enroll`, {
      method: 'POST', headers: { cookie },
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    const body = JSON.parse(raw);
    assert.match(body.totp_secret, /^[A-Z2-7]{32}$/, '新种子为 20 字节 base32');
    assert.notEqual(body.totp_secret, 'PREVIOUS_TEST_TOTP_SEED');
    assert.match(body.totp_uri, new RegExp(`secret=${body.totp_secret}`));
    assert.match(body.totp_uri, /issuer=erix-station-test/);
    assert.equal(body.user.login, 'alice');
    assert.equal(body.user.totp_enabled, true);
    assert.ok(!('totp_secret' in body.user) && !('password_hash' in body.user));
    assert.equal(user.totp_secret, body.totp_secret);
    assert.equal(user.last_totp_step, null);
    assert.ok(pool.sessions.find((session) => session.id === 'ls-alice-enroll').revoked_at);
    assert.equal(pool.sessions.find((session) => session.id === 'ls-alice-enroll-old').revoked_at.getTime(), 0);
    const enrollAudit = pool.audit.find((event) => event.action === 'admin.user_totp_enroll');
    assert.deepEqual(enrollAudit, {
      actor_id: ADMIN.id, action: 'admin.user_totp_enroll', target: 'alice', details: '{}',
    });
    assert.ok(pool.sqlLog.some(({ sql }) => sql.includes('UPDATE login_sessions SET revoked_at = now()')));

    const list = await (await fetch(`${base}/api/admin/users`, { headers: { cookie } })).text();
    assert.ok(!list.includes(body.totp_secret), '后续列表不再回显种子');
    assert.ok(!list.includes(body.totp_uri), '后续列表不再回显 otpauth URI');

    const missing = await fetch(`${base}/api/admin/users/c0000000-0000-4000-8000-000000000003/totp-enroll`, {
      method: 'POST', headers: { cookie },
    });
    assert.equal(missing.status, 404);
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
      ['PATCH', `/api/admin/users/${FDE_USER.id}`, '{}'],
      ['DELETE', `/api/admin/users/${FDE_USER.id}`],
      ['POST', `/api/admin/users/${FDE_USER.id}/reset-password`, '{}'],
      ['POST', `/api/admin/users/${FDE_USER.id}/totp-reset`],
      ['POST', `/api/admin/users/${FDE_USER.id}/totp-enroll`],
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
    binding: { fde_id: FDE_USER.id, state: 'active', gateway: 'litellm', api_key: 'sk-test-1234', provider_id: 'p1', main_model_id: 'm1', main_model_name: 'deepseek-flash', embedding_model_id: null, vision_model_id: null },
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
    assert.equal(body.config.main.model_id, 'm1');
    assert.equal(body.config.main.name, 'deepseek-flash');
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

test('GET /admin 兼容跳转（P4）：一律 302 /#/admin；POST → 405；认证/角色交给前端路由守卫', async () => {
  const { base, cookie, close } = await startAdminServer();
  try {
    // 未登录 / 已登录 / admin：后端一律 302 到 SPA hash 路由（认证与角色判断由前端守卫承担）。
    for (const headers of [{}, { cookie }]) {
      const res = await fetch(`${base}/admin`, { redirect: 'manual', headers });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/#/admin');
    }
    const head = await fetch(`${base}/admin`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, 302);
    assert.equal(head.headers.get('location'), '/#/admin');
    // POST 非幂等方法维持 405（不 302，避免改写非幂等请求语义——http.js /admin 注释）。
    const post = await fetch(`${base}/admin`, { method: 'POST', redirect: 'manual' });
    assert.equal(post.status, 405);
  } finally {
    await close();
  }
});
