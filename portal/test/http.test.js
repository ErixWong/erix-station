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
import { hashToken } from '../src/auth.js';
import * as totp from '../src/totp.js';
import { FakePool } from './fake-pool.js';

const TEST_GIT_HOST_ID = 'c0000000-0000-4000-8000-000000000011';
const TEST_LLM = { provider_id: 'mock-provider', main_model_id: 'mock-main' };

function createTestLlmGateway({ unavailable = false } = {}) {
  return {
    async listCredentials() {
      if (unavailable) throw new Error('catalog secret must not be returned');
      return { credentials: [{ credential_name: 'mock-provider', credential_info: { credential_name: 'mock-provider' } }] };
    },
    async listModels() {
      if (unavailable) throw new Error('catalog secret must not be returned');
      return {
        data: [{
          model_name: 'mock-chat',
          litellm_params: { litellm_credential_name: 'mock-provider' },
          model_info: { id: 'mock-main', type: 'text', tool_calling: true },
        }],
      };
    },
  };
}

async function startServer({ users = [], overrides = {}, pool: customPool, llmGateway = createTestLlmGateway() } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  // issue #61 P2：Vue SPA dist 由 Docker 注入 staticDir/app/（见 portal/Dockerfile），/ 翻转后服务它。
  fs.mkdirSync(path.join(staticDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'app', 'index.html'), 'SECRET_VUE_INDEX');
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
  const server = createServer({ pool, config, llmGateway });
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

class TotpEnrollHttpPool extends FakePool {
  async query(sql, params = []) {
    if (sql.includes('WITH target AS') && sql.includes('UPDATE users SET totp_secret = $2')) {
      const [userId, secret] = params;
      const user = this.users.find((row) => row.id === userId);
      if (!user) return { rows: [] };
      user.totp_secret = secret;
      user.last_totp_step = null;
      for (const session of this.sessions) {
        if (session.user_id === userId && session.revoked_at === null) session.revoked_at = new Date();
      }
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name, role: user.role,
          fde_name: user.fde_name ?? null, auth_source: user.auth_source, status: user.status,
          created_at: user.created_at ?? new Date(), totp_enabled: true,
        }],
      };
    }
    return super.query(sql, params);
  }
}

class AdminCreateHttpPool extends FakePool {
  constructor(options) {
    super(options);
    this.createdTotpSecrets = [];
    this.gitHosts = [{ id: TEST_GIT_HOST_ID, provider: 'gitea', enabled: true }];
    this.onboardings = [];
    this.gitAccounts = [];
  }

  async query(sql, params = []) {
    if (sql.includes('SELECT id, provider, enabled FROM git_hosts WHERE id')) {
      return { rows: this.gitHosts.filter((host) => host.id === params[0]) };
    }
    if (sql.includes('SELECT 1 FROM users WHERE email')) {
      return { rows: this.users.filter((user) => user.email === params[0]).map(() => ({ '?column?': 1 })) };
    }
    if (sql.includes('INSERT INTO fde_onboarding')) {
      const [fdeId, steps] = params;
      this.onboardings.push({ fde_id: fdeId, state: 'pending', steps: JSON.parse(steps), last_error: null });
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO fde_git_accounts')) {
      this.gitAccounts.push({ fde_id: params[0], git_host_id: params[1] });
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO users (login, email, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)')) {
      const [login, email, displayName, passwordHash, totpSecret, fdeName] = params;
      this.createdTotpSecrets.push(totpSecret);
      const row = {
        id: `created-${this.createdTotpSecrets.length}`,
        login,
        email,
        display_name: displayName,
        role: 'fde',
        fde_name: fdeName,
        auth_source: 'local',
        status: 'active',
        password_hash: passwordHash,
        totp_secret: totpSecret,
        created_at: new Date(),
      };
      this.users.push(row);
      return {
        rows: [{
          id: row.id, login: row.login, display_name: row.display_name, role: row.role,
          fde_name: row.fde_name, auth_source: row.auth_source, status: row.status,
          created_at: row.created_at, totp_enabled: row.totp_secret !== null,
        }],
      };
    }
    return super.query(sql, params);
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }
}

test('admin 创建用户路由：仅布尔 true 启用 TOTP，其它值关闭', async () => {
  const admin = {
    id: 'a0000000-0000-4000-8000-000000000001', login: 'admin', display_name: 'Admin',
    role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  };
  const pool = new AdminCreateHttpPool({ users: [admin] });
  const now = new Date();
  pool.sessions.push({
    id: 'admin-create-session', user_id: admin.id, token_hash: auth.hashToken('admin-create-token'),
    created_at: now, expires_at: new Date(Date.now() + 3_600_000), last_seen_at: now, revoked_at: null,
  });
  const s = await startServer({ pool });
  const headers = { 'content-type': 'application/json', cookie: 'fde_session_dev=admin-create-token' };
  try {
    const enabled = await fetch(`${s.base}/api/admin/users`, {
      method: 'POST', headers,
      body: JSON.stringify({
        login: 'totp-user', password: 'secret-pass-1', email: 'totp-user@example.test',
        fde_name: 'totp-user', git_host_id: TEST_GIT_HOST_ID, llm: TEST_LLM, totp_enabled: true,
      }),
    });
    assert.equal(enabled.status, 201);
    const enabledBody = await enabled.json();
    assert.equal(enabledBody.user.totp_enabled, true);
    assert.deepEqual(enabledBody.onboarding, {
      state: 'pending', step: 'provision', error: null, llm_binding: { state: 'pending', error: null },
    });
    assert.deepEqual(pool.onboardings[0].steps, {
      provision: { state: 'pending' },
      materialize: { state: 'pending' },
      'llm-binding': {
        state: 'pending',
        models: { ...TEST_LLM, embedding_model_id: null, vision_model_id: null },
      },
    });
    assert.notEqual(pool.createdTotpSecrets[0], null, 'boolean true 经路由透传并创建种子');
    assert.equal(typeof enabledBody.totp_uri, 'string');

    const invalid = await fetch(`${s.base}/api/admin/users`, {
      method: 'POST', headers,
      body: JSON.stringify({
        login: 'password-only', password: 'secret-pass-1', email: 'password-only@example.test',
        fde_name: 'password-only', git_host_id: TEST_GIT_HOST_ID, llm: TEST_LLM, totp_enabled: 'true',
      }),
    });
    assert.equal(invalid.status, 201);
    const invalidBody = await invalid.json();
    assert.equal(invalidBody.user.totp_enabled, false);
    assert.equal(pool.createdTotpSecrets[1], null, '非布尔值按 false 处理');
    assert.ok(!Object.hasOwn(invalidBody, 'totp_secret') && !Object.hasOwn(invalidBody, 'totp_uri'));
  } finally {
    await s.close();
  }
});

test('admin 创建用户路由：LLM provider 和模型必填且必须存在于 LiteLLM 目录；目录不可达时 fail-closed', async () => {
  const admin = {
    id: 'a0000000-0000-4000-8000-000000000001', login: 'admin', display_name: 'Admin',
    role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  };
  const pool = new AdminCreateHttpPool({ users: [admin] });
  pool.sessions.push({
    id: 'admin-create-session', user_id: admin.id, token_hash: auth.hashToken('admin-create-token'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(), revoked_at: null,
  });
  const s = await startServer({ pool });
  const headers = { 'content-type': 'application/json', cookie: 'fde_session_dev=admin-create-token' };
  const post = (body) => fetch(`${s.base}/api/admin/users`, {
    method: 'POST', headers,
    body: JSON.stringify({
      login: 'no-llm-user', password: 'secret-pass-1', email: 'no-llm-user@example.test',
      fde_name: 'no-llm-user', git_host_id: TEST_GIT_HOST_ID, ...body,
    }),
  });
  try {
    let response = await post({});
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm.provider_id');

    response = await post({ llm: null });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm');

    response = await post({ llm: { provider_id: 'mock-provider', main_model_id: '   ' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm.main_model_id');

    response = await post({ llm: { provider_id: 'mock-provider', main_model_id: '' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm.main_model_id');

    response = await post({ llm: { provider_id: 'missing-provider', main_model_id: 'mock-main' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm.provider_id');

    response = await post({ llm: { provider_id: 'mock-provider', main_model_id: 'missing-model' } });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'llm.main_model_id');
    assert.equal(pool.users.length, 1, 'invalid selections never create the user');
  } finally {
    await s.close();
  }

  const unavailablePool = new AdminCreateHttpPool({ users: [admin] });
  unavailablePool.sessions.push({
    id: 'admin-create-session', user_id: admin.id, token_hash: auth.hashToken('admin-create-token'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(), revoked_at: null,
  });
  const unavailable = await startServer({
    pool: unavailablePool,
    llmGateway: createTestLlmGateway({ unavailable: true }),
  });
  try {
    const response = await fetch(`${unavailable.base}/api/admin/users`, {
      method: 'POST', headers,
      body: JSON.stringify({
        login: 'unavailable-user', password: 'secret-pass-1', email: 'unavailable@example.test',
        fde_name: 'unavailable-user', git_host_id: TEST_GIT_HOST_ID, llm: TEST_LLM,
      }),
    });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'llm_catalog_unavailable');
    assert.match(body.error.message, /enable or repair|启用或修复/i);
    assert.ok(!JSON.stringify(body).includes('catalog secret'));
    assert.equal(unavailablePool.users.length, 1, 'catalog failure never creates the user');
  } finally {
    await unavailable.close();
  }
});

test('admin 建用户路由：缺少开户必填字段返回 400', async () => {
  const admin = {
    id: 'a0000000-0000-4000-8000-000000000001', login: 'admin', display_name: 'Admin',
    role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  };
  const pool = new AdminCreateHttpPool({ users: [admin] });
  pool.sessions.push({
    id: 'admin-create-session', user_id: admin.id, token_hash: auth.hashToken('admin-create-token'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(), revoked_at: null,
  });
  const s = await startServer({ pool });
  try {
    const response = await fetch(`${s.base}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'fde_session_dev=admin-create-token' },
      body: JSON.stringify({
        login: 'missing-email', password: 'secret-pass-1', fde_name: 'missing-email',
        git_host_id: TEST_GIT_HOST_ID, llm: TEST_LLM,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'email');
    assert.equal(pool.users.some((user) => user.login === 'missing-email'), false);
  } finally {
    await s.close();
  }
});

test('admin 建用户路由：拒绝停用或 Azure Git host 且不插入用户', async () => {
  const admin = {
    id: 'a0000000-0000-4000-8000-000000000001', login: 'admin', display_name: 'Admin',
    role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  };
  const pool = new AdminCreateHttpPool({ users: [admin] });
  pool.sessions.push({
    id: 'admin-create-session', user_id: admin.id, token_hash: auth.hashToken('admin-create-token'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(), revoked_at: null,
  });
  const s = await startServer({ pool });
  try {
    const postUser = () => fetch(`${s.base}/api/admin/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'fde_session_dev=admin-create-token' },
      body: JSON.stringify({
        login: 'not-created', password: 'secret-pass-1', email: 'not-created@example.test',
        fde_name: 'not-created', git_host_id: TEST_GIT_HOST_ID, llm: TEST_LLM,
      }),
    });
    pool.gitHosts[0].enabled = false;
    let response = await postUser();
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'git_host_id');
    assert.equal(pool.users.length, 1);

    pool.gitHosts[0].enabled = true;
    pool.gitHosts[0].provider = 'azure';
    response = await postUser();
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.details.field, 'git_host_id');
    assert.equal(pool.users.length, 1);
  } finally {
    await s.close();
  }
});

test('admin TOTP 补绑路由：仅 admin POST；其它方法 405，缺失用户 404', async () => {
  const admin = {
    id: 'a0000000-0000-4000-8000-000000000001', login: 'admin', display_name: 'Admin',
    role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
  };
  const fde = {
    id: 'b0000000-0000-4000-8000-000000000002', login: 'alice', display_name: 'Alice',
    role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  };
  const pool = new TotpEnrollHttpPool({ users: [admin, fde] });
  const now = new Date();
  for (const [user, token] of [[admin, 'admin-enroll-token'], [fde, 'fde-enroll-token']]) {
    pool.sessions.push({
      id: `session-${user.login}`, user_id: user.id, token_hash: auth.hashToken(token),
      created_at: now, expires_at: new Date(Date.now() + 3_600_000),
      last_seen_at: now, revoked_at: null,
    });
  }
  const s = await startServer({ pool });
  const adminCookie = 'fde_session_dev=admin-enroll-token';
  const fdeCookie = 'fde_session_dev=fde-enroll-token';
  const userId = admin.id;
  try {
    const wrongMethod = await fetch(`${s.base}/api/admin/users/${userId}/totp-enroll`, {
      headers: { cookie: adminCookie },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error.code, 'method_not_allowed');

    const missing = await fetch(`${s.base}/api/admin/users/c0000000-0000-4000-8000-000000000003/totp-enroll`, {
      method: 'POST', headers: { cookie: adminCookie },
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error.code, 'not_found');

    const anonymous = await fetch(`${s.base}/api/admin/users/${userId}/totp-enroll`, { method: 'POST' });
    assert.equal(anonymous.status, 401);

    const forbidden = await fetch(`${s.base}/api/admin/users/${userId}/totp-enroll`, {
      method: 'POST', headers: { cookie: fdeCookie },
    });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'forbidden');
  } finally {
    await s.close();
  }
});

test('P5：POST /api/projects → 410 project_api_retired（项目注册制退役，写端点不再进 projects.js）', async () => {
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active',
  };
  const pool = new FakePool({ users: [user] });
  pool.sessions.push({
    id: 's1', user_id: user.id, token_hash: auth.hashToken('tok'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), last_seen_at: new Date(), revoked_at: null,
  });
  const s = await startServer({ pool });
  try {
    const response = await fetch(`${s.base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: 'fde_session_dev=tok' },
      body: JSON.stringify({ name: 'proj1', repo_url: 123 }),
    });
    assert.equal(response.status, 410);
    const body = await response.json();
    assert.equal(body.error.code, 'project_api_retired');
  } finally {
    await s.close();
  }
});

test('P5：PATCH/DELETE /api/projects/:id 与 GET .../ports → 410 project_api_retired（留档只读）', async () => {
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active',
  };
  const pool = new FakePool({ users: [user] });
  pool.sessions.push({
    id: 's1', user_id: user.id, token_hash: auth.hashToken('tok'),
    created_at: new Date(), expires_at: new Date(Date.now() + 3600000), last_seen_at: new Date(), revoked_at: null,
  });
  const s = await startServer({ pool });
  try {
    for (const [method, path] of [
      ['PATCH', '/api/projects/p1'],
      ['DELETE', '/api/projects/p1'],
      ['GET', '/api/projects/p1/ports'],
    ]) {
      const r = await fetch(`${s.base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: 'fde_session_dev=tok' },
        body: method === 'GET' ? undefined : JSON.stringify({ name: 'x' }),
      });
      assert.equal(r.status, 410, `${method} ${path} → 410`);
      const body = await r.json();
      assert.equal(body.error.code, 'project_api_retired');
    }
  } finally {
    await s.close();
  }
});

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
    // issue #50：仅口令通过（尚未完成第二因素）不得写「成功登录」审计。
    assert.equal(s.pool.audit.filter((a) => a.action === 'auth.login_success').length, 0);

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

    // issue #50：TOTP 分支写一条 auth.login_success，details 不含口令/TOTP 码/session token。
    const loginAudits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
    assert.equal(loginAudits.length, 1, 'TOTP 分支恰写一条成功登录审计');
    assert.equal(loginAudits[0].actor_id, 'u1');
    assert.equal(loginAudits[0].target, 'alice');
    const auditDetails = JSON.parse(loginAudits[0].details);
    assert.deepEqual(Object.keys(auditDetails).sort(), ['at', 'login', 'method'], 'details 只含 login/method/at');
    assert.equal(auditDetails.login, 'alice');
    assert.equal(auditDetails.method, 'totp');
    assert.ok(!Number.isNaN(Date.parse(auditDetails.at)), 'at 是合法时间戳');
    const auditJson = JSON.stringify(loginAudits[0]);
    assert.ok(!auditJson.includes(password), '审计不含口令');
    assert.ok(!auditJson.includes(token), '审计不含 session token');
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

    // issue #50：口令直通分支写一条 auth.login_success（method 区分于 TOTP 分支）。
    const loginAudits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
    assert.equal(loginAudits.length, 1, '口令直通分支恰写一条成功登录审计');
    assert.equal(loginAudits[0].actor_id, 'u1');
    assert.equal(loginAudits[0].target, 'alice');
    const auditDetails = JSON.parse(loginAudits[0].details);
    assert.deepEqual(Object.keys(auditDetails).sort(), ['at', 'login', 'method'], 'details 只含 login/method/at');
    assert.equal(auditDetails.login, 'alice');
    assert.equal(auditDetails.method, 'password_direct');
    assert.ok(!Number.isNaN(Date.parse(auditDetails.at)), 'at 是合法时间戳');
    assert.ok(!JSON.stringify(loginAudits[0]).includes(password), '审计不含口令');
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
    assert.equal(await ok.text(), 'SECRET_VUE_INDEX'); // issue #61 P2：/ 已翻转为 Vue SPA

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

test('forward-auth fail-closed：无预览凭证 403 / 未知 host 404（可操作提示）/ released 403', async () => {
  const allocs = new Map([
    ['alice-p-4016.fde.erix.vip', { id: 'pa1', fde_id: 'u1', state: 'allocated', fde_name: 'alice' }],
    ['bob-p-4016.fde.erix.vip', { id: 'pa2', fde_id: 'u2', state: 'released', fde_name: 'bob' }],
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
    const unknown = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'nope.fde.erix.vip' } });
    assert.equal(unknown.status, 404);
    // #57：404 文案换成可操作提示（错误码不变）。
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.error.code, 'not_found');
    assert.match(unknownBody.error.message, /preview host not found/);
    assert.match(unknownBody.error.message, /unassigned preview domain or stale bookmark/);

    const nocred = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'alice-p-4016.fde.erix.vip' } });
    assert.equal(nocred.status, 403);
    assert.equal((await nocred.json()).error.code, 'preview_ticket_required');

    const released = await fetch(`${s.base}/api/forward-auth`, { headers: { 'x-forwarded-host': 'bob-p-4016.fde.erix.vip' } });
    assert.equal(released.status, 403);
    assert.equal((await released.json()).error.code, 'allocation_released');
  } finally {
    await s.close();
  }
});

// #57 阶段2 Host 收口 + #58（fix-250923-01）回归：dev 公开入口带端口（:8090）时，
// 查表用剥端口 + 小写的 host（归一化唯一入口 = preview.normalizeHostHeader），
// 302 Location 仍保留**原始 Host（含端口）**。
test('forward-auth：Host 带端口（dev :8090）——cookie 已签发路径 2xx 放行（#57 Host 收口 + #58 回归）', async () => {
  const HOST = 'alice-p-4000.fde.erix.vip';
  const sessionToken = 's_steady_cookie_with_port';
  const grants = new Map([[hashToken(sessionToken), {
    id: 'g1', token_hash: hashToken(sessionToken), user_id: 'u1', allocation_id: 'pa1',
    kind: 'session', state: 'active', expires_at: new Date(Date.now() + 600_000), revoked_at: null,
  }]]);
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM port_allocations a')) {
        // 查表入参必须是**剥端口后**的 host（大小写也被归一）。
        const a = { id: 'pa1', fde_id: 'u1', state: 'active', exposure: 'private', hostname: HOST, fde_name: 'alice', user_status: 'active' };
        return { rows: params[0] === HOST.toLowerCase() ? [a] : [] };
      }
      if (sql.includes("FROM preview_grants WHERE token_hash = $1 AND kind = 'session'")) {
        const g = grants.get(params[0]);
        return { rows: g ? [g] : [] };
      }
      if (sql.includes('SELECT id, role, status FROM users WHERE id = $1')) {
        return { rows: [{ id: 'u1', role: 'fde', status: 'active' }] };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const s = await startServer({ pool, overrides: {
    previewSessionTtlSeconds: 900,
    previewCookie: { name: 'fde_preview_dev', secure: false, httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 900 },
  } });
  try {
    // ① cookie 已签发 + Host 带端口 → 2xx 放行（不因端口后缀查不到而 404）
    const allowed = await fetch(`${s.base}/api/forward-auth`, {
      headers: {
        'x-forwarded-host': `${HOST}:8090`,
        'x-forwarded-proto': 'http',
        Cookie: `fde_preview_dev=${sessionToken}`,
      },
    });
    assert.equal(allowed.status, 200, `带端口 Host 的 cookie 路径应放行，实际 ${allowed.status}`);
    assert.equal(allowed.headers.get('x-auth-user'), 'alice');

    // ② Host 大小写混写 + 带端口 → 仍能查到（归一化 = 剥端口 + 小写）
    const upper = await fetch(`${s.base}/api/forward-auth`, {
      headers: {
        'x-forwarded-host': 'Alice-P-4000.FDE.ERIX.VIP:8090',
        'x-forwarded-proto': 'http',
        Cookie: `fde_preview_dev=${sessionToken}`,
      },
    });
    assert.equal(upper.status, 200);

    // ③ ticket 路径的 302 Location 保留端口 → 在 test/preview.test.js 以函数级断言覆盖
    //（不起真服务器：node fetch keep-alive 会让 server.close() 挂住，见 #57 阶段2 实施记录）。
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
        return { rows: [{ id: 'pa1', fde_id: 'u1', state: 'allocated', exposure: 'private', hostname: 'alice-p-4000.fde.erix.vip', url: 'https://alice-p-4000.fde.erix.vip' }] };
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

test('F2：forward-auth 审计不记 query（含 ?preview_ticket=<明文>）', async () => {
  const pool = new FakePool({ users: [] });
  const s = await startServer({ pool });
  try {
    const secret = 'pt_S3CRET_TICKET_LEAK_CHECK';
    const res = await fetch(`${s.base}/api/forward-auth`, {
      headers: {
        'x-forwarded-host': 'alice-p-4000.fde.erix.vip',
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

// issue #61 P2 翻转：/ 与 /index.html 服务 Vue SPA（staticDir/app/index.html，dist 注入目录），
// 构建产物引用的 /assets/* 映射到注入目录；旧 index.html 保留文件但不再被 / 引用（P4 删）。
test('GET / 与 /assets/* → 服务 Vue SPA（P2 翻转；/app 挂载点已删除）', async () => {
  const s = await startServer();
  try {
    fs.mkdirSync(path.join(s.staticDir, 'app', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(s.staticDir, 'app', 'index.html'), 'SECRET_VUE_INDEX');
    fs.writeFileSync(path.join(s.staticDir, 'app', 'assets', 'app.js'), 'SECRET_ASSET');

    for (const p of ['/', '/index.html']) {
      const res = await fetch(`${s.base}${p}`);
      assert.equal(res.status, 200, `${p} → 200`);
      assert.equal(await res.text(), 'SECRET_VUE_INDEX');
    }
    const asset = await fetch(`${s.base}/assets/app.js`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), 'SECRET_ASSET');

    // P1 过渡期挂载点已删除：/app 不再特殊处理（staticDir/app 是目录 → 404）
    const legacy = await fetch(`${s.base}/app`);
    assert.equal(legacy.status, 404);

    // 路径穿越防护对 /assets 映射同样生效：/app/assets/../.. 仍在 staticRoot 内（与直接请求
    // 等价 → 404 不属逃逸）；再加一级 .. 逃逸出 staticRoot 才 403。
    const inside = await fetch(`${s.base}/assets/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(inside.status, 404);
    const traversal = await fetch(`${s.base}/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(traversal.status, 403);
  } finally {
    await s.close();
  }
});
