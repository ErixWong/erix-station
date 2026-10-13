// issue #255（工单 feat-261013-03）**后端片**：首登强制改密。
//
// 覆盖四段（与提交一一对应）：
//   ① 旗标的**写入面**：管理员开户（新建 / 重新激活）与管理员重置口令 ⇒ `must_change_password=true`；
//      `cli.js bootstrap-admin` ⇒ **不置 true**（否则 dev/CI 的 bootstrap 账号被锁进改密屏，而本单不含前端）。
//   ② 自助改密端点 `POST /api/me/password`：错当前口令 401（复用 `invalid_credentials`）且哈希不变、
//      新==旧 400、成功 ⇒ 哈希变 + 旗标清 + **当前会话保留** + 只吊销其它会话、未登录 401、审计恰一条且不含口令。
//   ③ 受限会话门：`must_change_password=true` 时除放行清单外的 `/api/*` 一律 403 `password_change_required`；
//      清单里的 `GET /api/me`、`POST /api/me/password`、登出、`/api/forward-auth`、`/api/internal/*` 不受影响。
//   ④ 登录响应增字段 `password_change_required`（两个发会话的分支都有，纯 additive）。
//
// 隔离约定（docs/testing.md §2.1）：内存 fake pool + `server.listen(0)`，不碰真实 dev 库/容器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, RESTRICTED_SESSION_ALLOWLIST, restrictedSessionAllows } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as admin from '../src/admin.js';
import * as auth from '../src/auth.js';
import * as totp from '../src/totp.js';
import { FakePool } from './fake-pool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (name) => fs.readFileSync(path.join(HERE, '../src', name), 'utf8');

const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active', must_change_password: false,
};

// ---------------------------------------------------------------------------
// fake 的两个旗标判定 helper：**按 SQL 说的做**（AGENTS §8.14），不另写一套语义
// ---------------------------------------------------------------------------

/** `SET ... must_change_password = <literal>`：该列被赋成指定字面量吗？ */
function assignsMustChange(sql, literal) {
  return new RegExp(`must_change_password\\s*=\\s*${literal}\\b`).test(sql);
}

/** INSERT 是否把 must_change_password 显式写成 true（列清单里有它 **且** VALUES 对应位是 true）。 */
function insertSetsMustChange(sql) {
  const [columnsPart, valuesPart = ''] = sql.split(/VALUES/i);
  const columns = columnsPart.slice(columnsPart.lastIndexOf('(') + 1);
  if (!/must_change_password/.test(columns)) return false;
  return /,\s*true\s*\)/.test(valuesPart);
}

/**
 * 建用户 / 改密 / forward-auth 用的 fake pool：FakePool（会话、pending、audit）
 * + users CRUD + port_allocations 的 hostname 查表（forward-auth 用）。
 * 旗标一律从 SQL 文本读（见上面两个 helper），所以「实现里把 true 写成 false」会当场红。
 */
class MustChangePool extends FakePool {
  constructor({ users = [], allocations = [] } = {}) {
    super({ users: users.map((user) => ({ must_change_password: false, ...user })) });
    this.allocations = allocations;
    this.nextUser = 0;
    this.sqlLog = [];
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });

    // ---- users 查重 / 查行（createUser、resetUserPassword、自助改密）----
    if (sql.includes('SELECT id, status FROM users WHERE fde_name')) {
      const user = this.users.find((u) => u.fde_name === params[0]);
      return { rows: user ? [{ id: user.id, status: user.status }] : [] };
    }
    if (sql.includes('SELECT 1 FROM users WHERE login')) {
      return {
        rows: this.users
          .filter((u) => u.login === params[0] && (!sql.includes('id <>') || u.id !== params[1]))
          .map(() => ({ '?column?': 1 })),
      };
    }
    if (sql.includes('SELECT 1 FROM users WHERE email')) {
      return {
        rows: this.users
          .filter((u) => u.email === params[0] && (!sql.includes('id <>') || u.id !== params[1]))
          .map(() => ({ '?column?': 1 })),
      };
    }
    if (sql.includes('SELECT id, login FROM users WHERE id')) {
      const user = this.users.find((u) => u.id === params[0]);
      return { rows: user ? [{ id: user.id, login: user.login }] : [] };
    }
    // 自助改密取当前哈希（含 auth_source / must_change_password）
    if (sql.includes('SELECT id, login, password_hash')) {
      const user = this.users.find((u) => u.id === params[0] && u.status === 'active');
      if (!user) return { rows: [] };
      return {
        rows: [{
          id: user.id, login: user.login, password_hash: user.password_hash ?? null,
          auth_source: user.auth_source, must_change_password: user.must_change_password === true,
        }],
      };
    }

    // ---- 建用户（新建 INSERT / 同名 disabled 行重新激活 UPDATE）----
    // cli.js bootstrap-admin 的形状：列清单里**没有** must_change_password ⇒ 按真库语义吃 DEFAULT false。
    if (sql.includes('INSERT INTO users (login, display_name, role')) {
      this.nextUser += 1;
      const row = {
        id: `u-bootstrap-${this.nextUser}`, login: params[0], display_name: params[1], role: 'admin',
        auth_source: 'local', status: 'active', password_hash: params[2], totp_secret: params[3],
        email: null, fde_name: null, created_at: new Date(),
        must_change_password: insertSetsMustChange(sql),
      };
      this.users.push(row);
      return { rows: [{ id: row.id, login: row.login }] };
    }
    if (sql.includes('INSERT INTO users (login, email')) {
      if (!insertSetsMustChange(sql)) {
        assert.fail('MustChangePool: createUser 的 INSERT 必须显式写 must_change_password=true（#255）');
      }
      this.nextUser += 1;
      const row = {
        id: `u-new-${this.nextUser}`, login: params[0], email: params[1], display_name: params[2],
        role: 'fde', fde_name: params[5], auth_source: 'local', status: 'active',
        password_hash: params[3], totp_secret: params[4], created_at: new Date(),
        must_change_password: true,
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
    if (sql.includes('UPDATE users') && sql.includes('SET login = $2')) {
      const [id, login, email, displayName, passwordHash, totpSecret] = params;
      const user = this.users.find((u) => u.id === id && u.status === 'disabled');
      if (!user) return { rows: [] };
      Object.assign(user, {
        login, email, display_name: displayName, password_hash: passwordHash, totp_secret: totpSecret,
        last_totp_step: null, status: 'active', disabled_at: null,
        must_change_password: assignsMustChange(sql, 'true'),
      });
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name, role: user.role,
          fde_name: user.fde_name, auth_source: user.auth_source, status: user.status,
          created_at: user.created_at ?? new Date(), totp_enabled: user.totp_secret != null,
        }],
      };
    }

    // ---- 单语句 CTE：管理员重置（true + 全量吊销）/ 本人改密（false + 保留当前会话）----
    if (sql.includes('WITH target AS') && sql.includes('UPDATE users SET')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      if (sql.includes('password_hash')) user.password_hash = params[1];
      if (assignsMustChange(sql, 'true')) user.must_change_password = true;
      if (assignsMustChange(sql, 'false')) user.must_change_password = false;
      // 排除当前会话的谓词必须**从 SQL 里解析**（fake 不自己决定保留哪条）：
      //   `id <> $n` / `s.id <> $n` → 参数 n 就是当前会话的 login_sessions.id。
      const excludeMatch = sql.match(/\bs?\.?id\s*<>\s*\$(\d+)/);
      const keepId = excludeMatch ? params[Number(excludeMatch[1]) - 1] : undefined;
      let revoked = 0;
      for (const session of this.sessions) {
        if (session.user_id !== user.id || session.revoked_at !== null) continue;
        if (keepId !== undefined && session.id === keepId) continue;
        session.revoked_at = new Date();
        revoked += 1;
      }
      return { rows: [{ id: user.id, login: user.login, revoked_sessions: revoked }] };
    }

    // ---- forward-auth 的 hostname 查表（preview.js：活行优先 + INNER JOIN users）----
    if (sql.includes('FROM port_allocations a') && sql.includes('JOIN users u')) {
      const host = params[0];
      const allocation = this.allocations
        .filter((row) => row.hostname === host)
        .sort((a, b) => Number(b.state !== 'released') - Number(a.state !== 'released'))
        .map((row) => {
          const user = this.users.find((u) => u.id === row.fde_id);
          return user ? { ...row, fde_name: user.fde_name ?? null, user_status: user.status } : null;
        })
        .find(Boolean);
      return { rows: allocation ? [allocation] : [] };
    }
    if (sql.includes('UPDATE port_allocations SET state')) return { rows: [] };

    return super.query(sql, params);
  }
}

async function startServer({ pool, overrides = {} } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-255-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  fs.mkdirSync(path.join(staticDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'app', 'index.html'), 'SECRET_VUE_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    previewCookie: cookieSettings('dev-http', 3600),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: {
      maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000,
    },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
    userSpaceRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'station-255-space-')),
    ...overrides,
  };
  const server = createServer({ pool, config, llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, pool, config, base, close: () => new Promise((res) => server.close(res)) };
}

/** 建一个带口令的用户并（可选）铸一枚登录会话。 */
async function seedUser(pool, { login, password, role = 'fde', fdeName = null, mustChange = false, totpSecret = null }) {
  const user = {
    id: `u-${login}`, login, display_name: login, role, fde_name: fdeName,
    auth_source: 'local', status: 'active', email: `${login}@example.test`,
    password_hash: await auth.hashPassword(password), totp_secret: totpSecret,
    last_totp_step: null, must_change_password: mustChange, created_at: new Date(),
  };
  pool.users.push(user);
  return user;
}

async function loginCookieFor({ base, config, login, password }) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, password }),
  });
  assert.equal(res.status, 200, `登录应成功（实际 ${res.status}）`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = (setCookie.match(/([^=]+)=([^;]+)/) ?? [])[2];
  assert.ok(token, '登录响应必须带 session cookie');
  return { cookie: `${config.cookie.name}=${token}`, token, body: await res.json() };
}

// ---------------------------------------------------------------------------
// ① 旗标的写入面（提交 2）
// ---------------------------------------------------------------------------

const CREATE_ARGS = {
  login: 'carol', display_name: 'Carol', password: 'init-secret', email: 'carol@example.test',
  fde_name: 'carol',
};

test('#255① 管理员开户（createUser 新建分支）置 must_change_password=true', async () => {
  const pool = new MustChangePool({ users: [ADMIN] });
  const created = await admin.createUser(pool, { actorId: ADMIN.id, ...CREATE_ARGS });
  const row = pool.users.find((u) => u.login === 'carol');
  assert.ok(row, '用户已建');
  assert.equal(row.must_change_password, true, '管理员代设初始口令 ⇒ 必须要求本人改密');
  assert.ok(created.user.login, 'createUser 正常返回');
  // SQL 侧也钉住：写成参数或漏列都会让上面那条变红，这里再钉住「按字面量 true 写」这一形状。
  const insert = pool.sqlLog.find(({ sql }) => sql.includes('INSERT INTO users (login, email'));
  assert.ok(insert, '走的是 INSERT 分支');
  assert.match(insert.sql, /must_change_password[\s\S]*VALUES[^\n]*,\s*true\)/);
});

test('#255① 同名 disabled 行重新激活也置 true（漏这条 = 离职回来的人逃过改密）', async () => {
  const rehired = {
    id: 'u-rehired', login: 'alice-old', email: 'alice@x.test', display_name: 'Alice', role: 'fde',
    fde_name: 'alice', auth_source: 'local', status: 'disabled', password_hash: 'old-hash',
    totp_secret: null, must_change_password: false,
  };
  const pool = new MustChangePool({ users: [ADMIN, rehired] });
  const { reactivated } = await admin.createUser(pool, {
    actorId: ADMIN.id, login: 'alice-new', password: 'welcome-back', email: 'alice@x.test', fde_name: 'alice',
  });
  assert.equal(reactivated, true, '走的是重新激活分支');
  assert.equal(pool.users.find((u) => u.id === 'u-rehired').must_change_password, true);
});

test('#255① 管理员重置口令置 true 并吊销全部现存会话（对照：本人改密保留当前会话）', async () => {
  const pool = new MustChangePool({ users: [ADMIN] });
  const user = await seedUser(pool, { login: 'dave', password: 'old-secret', fdeName: 'dave' });
  const s1 = await auth.createSession(pool, user.id);
  const s2 = await auth.createSession(pool, user.id);
  assert.equal(user.must_change_password, false, '起手：未被要求改密');

  await admin.resetUserPassword(pool, user.id, 'admin-chosen', { actorId: ADMIN.id });

  assert.equal(user.must_change_password, true, '管理员重置后仍欠一次改密');
  assert.equal(pool.sessions.find((s) => s.token_hash === auth.hashToken(s1.token)).revoked_at !== null, true);
  assert.equal(pool.sessions.find((s) => s.token_hash === auth.hashToken(s2.token)).revoked_at !== null, true,
    '管理员重置是**全量**吊销（与自助改密的「保留当前会话」相反）');
});

test('#255① bootstrap-admin 不置 true：INSERT 不写这一列（吃 DEFAULT false），dev/CI 账号不被锁', async () => {
  // ① 把 cli.js 里**真实那条** bootstrap INSERT 抽出来，灌进按语义建模的 fake（列清单没有这一列 ⇒ false）。
  const cli = SRC('cli.js');
  const start = cli.indexOf('INSERT INTO users (login, display_name, role');
  assert.notEqual(start, -1, 'cli.js 里找得到 bootstrap-admin 的 INSERT INTO users');
  const stmt = cli.slice(start, cli.indexOf('`', start));
  assert.doesNotMatch(stmt, /must_change_password/,
    'bootstrap-admin 的 INSERT 一旦写这一列（尤其写 true），dev/CI 的 bootstrap 账号就会被锁进改密屏');
  // 决策依据必须留在代码里（否则下一个人会「顺手补上」）。
  assert.match(cli, /#255[\s\S]{0,400}不写 `?must_change_password/, 'cli.js 要注释「故意不写这一列」及其后果');

  const pool = new MustChangePool({ users: [] });
  await pool.query(stmt, ['bootstrap-root', 'Bootstrap', 'hash', 'secret']);
  assert.equal(pool.users[0].must_change_password, false,
    'bootstrap 账号必须落在 false（吃迁移 0021 的 DEFAULT false）——true 就等于把它锁进改密屏');

  // ② 同一份旗标在 admin.js 侧是 true：**两侧不对称是刻意的**，钉在同一条用例里防「顺手对齐」。
  // 注释里也提这个词 ⇒ 先剔行注释与块注释，只留代码（否则「解释」会被当成「实现」，计数虚高）。
  const adminSrc = SRC('admin.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((adminSrc.match(/must_change_password\s*=\s*true/g) ?? []).length, 2,
    'admin.js 里要恰有两处 `must_change_password = true`（重新激活 UPDATE + 管理员重置 CTE）');
  assert.match(adminSrc, /INSERT INTO users \([^)]*must_change_password\)\s*VALUES[^\n]*,\s*true\)/,
    'admin.js 的新建分支要在 INSERT 列清单里写这一列并给字面量 true');
});

test('#255① 迁移 0021 的默认值 = false ⇒ 存量行与新 bootstrap 行都不被要求改密（契约与实现对齐）', () => {
  const sql = fs.readFileSync(path.join(HERE, '../../deploy/migrations/0021-user-must-change-password.sql'), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false/);
  // 默认值守卫在（漂移即拒启）：bootstrap 与存量行都靠这个默认值保持 false。
  assert.match(sql, /默认值不是 false/);
});

// ---------------------------------------------------------------------------
// ② 自助改密端点 `POST /api/me/password`（提交 3）
// ---------------------------------------------------------------------------

const OLD_PW = 'old-secret-1';
const NEW_PW = 'new-secret-2';

/** 一个有两条现存会话的用户（当前 + 待吊销），返回 cookie 与 pool 里的用户行。 */
async function setupSelfService({ mustChange = true } = {}) {
  const pool = new MustChangePool({ users: [ADMIN] });
  const user = await seedUser(pool, {
    login: 'erin', password: OLD_PW, fdeName: 'erin', mustChange,
  });
  const s = await startServer({ pool });
  const current = await loginCookieFor({ ...s, login: 'erin', password: OLD_PW });
  const other = await auth.createSession(pool, user.id);
  return { pool, user, server: s.server, config: s.config, base: s.base, close: s.close,
    cookie: current.cookie, currentToken: current.token, otherToken: other.token };
}

function postPassword({ base, cookie, body }) {
  return fetch(`${base}/api/me/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

test('#255② 成功改密：哈希变、旗标清 false、当前会话保留、其它会话被吊销', async () => {
  const t = await setupSelfService();
  try {
    const before = t.user.password_hash;
    const res = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(res.status, 200, `应 200（实际 ${res.status}：${await res.clone().text()}）`);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, password_change_required: false, sessions_revoked: 1 });

    assert.notEqual(t.user.password_hash, before, 'password_hash 已换');
    assert.equal(t.user.must_change_password, false, '旗标已清（这就是改密屏的出口）');

    // 当前会话**必须还活着**：照抄管理员那条的全量吊销会把人当场踢下线 = 体感改密失败。
    const me = await fetch(`${t.base}/api/me`, { headers: { cookie: t.cookie } });
    assert.equal(me.status, 200, '当前会话改完仍可用（不得被吊销）');
    assert.equal((await me.json()).user.login, 'erin');

    // 其它会话必须被吊销（换口令的意义之一就是让别人的副本失效）。
    const stale = await fetch(`${t.base}/api/me`, { headers: { cookie: `${t.config.cookie.name}=${t.otherToken}` } });
    assert.equal(stale.status, 401, '该用户其它 login_sessions 已吊销');

    // 新口令真的能登录、旧口令真的不能。
    const reLogin = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'erin', password: NEW_PW }),
    });
    assert.equal(reLogin.status, 200, '新口令可登录');
    const oldLogin = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'erin', password: OLD_PW }),
    });
    assert.equal(oldLogin.status, 401, '旧口令已失效');
  } finally {
    await t.close();
  }
});

test('#255② 当前口令不对 → 401 invalid_credentials（复用登录码）且哈希与旗标一字不动', async () => {
  const t = await setupSelfService();
  try {
    const before = t.user.password_hash;
    const res = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: 'wrong-' + OLD_PW, new_password: NEW_PW } });
    assert.equal(res.status, 401);
    const body = await res.json();
    // 复用登录的错误码（不是新造码）——与 §1.2 里 `invalid_credentials` 的语义一致。
    assert.equal(body.error.code, 'invalid_credentials');
    assert.equal(t.user.password_hash, before, '哈希未变');
    assert.equal(t.user.must_change_password, true, '旗标未被误清');
    const me = await fetch(`${t.base}/api/me`, { headers: { cookie: t.cookie } });
    assert.equal(me.status, 200, '改密失败不得动当前会话');
  } finally {
    await t.close();
  }
});

test('#255② 新口令与当前相同 → 400 validation_failed + details.field=new_password（哈希不变）', async () => {
  const t = await setupSelfService();
  try {
    const before = t.user.password_hash;
    const res = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: OLD_PW, new_password: OLD_PW } });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.equal(body.error.details.field, 'new_password', '前端要靠 field 标红正确的那一格');
    assert.equal(t.user.password_hash, before);
    assert.equal(t.user.must_change_password, true, '被拒的改密不得清旗标');
  } finally {
    await t.close();
  }
});

test('#255② 字段缺失/畸形一律 400 validation_failed 且不消耗 scrypt；非 POST 405', async () => {
  const t = await setupSelfService();
  try {
    for (const [body, field] of [
      [{ new_password: NEW_PW }, 'current_password'],
      [{ current_password: OLD_PW }, 'new_password'],
      [{ current_password: OLD_PW, new_password: '' }, 'new_password'],
      [{ current_password: '', new_password: NEW_PW }, 'current_password'],
      [{ current_password: OLD_PW, new_password: 'x'.repeat(257) }, 'new_password'],
    ]) {
      const res = await postPassword({ base: t.base, cookie: t.cookie, body });
      assert.equal(res.status, 400, `${JSON.stringify(body)} 应 400`);
      const json = await res.json();
      assert.equal(json.error.code, 'validation_failed');
      assert.equal(json.error.details?.field, field, `details.field 必须是 ${field}`);
    }
    const get = await fetch(`${t.base}/api/me/password`, { headers: { cookie: t.cookie } });
    assert.equal(get.status, 405);
  } finally {
    await t.close();
  }
});

test('#255② 未登录 → 401 unauthorized（复用既有码，不新造）', async () => {
  const t = await setupSelfService();
  try {
    const res = await postPassword({ base: t.base, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'unauthorized');
    const badCookie = await postPassword({ base: t.base, cookie: `${t.config.cookie.name}=nope`, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(badCookie.status, 401, '会话不存在同样 401');
  } finally {
    await t.close();
  }
});

test('#255② 审计恰好一条 user.password_changed（actor=本人），details 绝不写口令明文', async () => {
  const t = await setupSelfService();
  try {
    const res = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(res.status, 200);
    const entries = t.pool.audit.filter((a) => a.action === 'user.password_changed');
    assert.equal(entries.length, 1, '恰一条（不多写噪声、不少写）');
    assert.equal(entries[0].actor_id, t.user.id, 'actor = 本人');
    assert.equal(entries[0].target, 'erin');
    const details = JSON.parse(entries[0].details);
    assert.equal(details.self_service, true);
    assert.equal(details.sessions_revoked, 1);
    const serialized = JSON.stringify(entries[0]);
    assert.ok(!serialized.includes(OLD_PW), '审计不得出现当前口令明文');
    assert.ok(!serialized.includes(NEW_PW), '审计不得出现新口令明文');
    assert.ok(!/password_hash|token_hash/i.test(serialized), '不得把哈希/令牌塞进审计');

    // 失败路径不写这条审计（否则爆破会把审计表刷满噪声）。
    await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: 'nope', new_password: 'another-3' } });
    assert.equal(t.pool.audit.filter((a) => a.action === 'user.password_changed').length, 1,
      '改密失败不得再写 user.password_changed');
  } finally {
    await t.close();
  }
});

test('#255② 当前口令被连续猜错会限流（防「会话 cookie 被偷后爆破当前口令」）', async () => {
  const t = await setupSelfService();
  try {
    let last = null;
    for (let i = 0; i < 6; i += 1) {
      last = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: `guess-${i}`, new_password: NEW_PW } });
    }
    assert.equal(last.status, 429, `第 6 次应 429（实际 ${last.status}）`);
    assert.equal((await last.json()).error.code, 'rate_limited');
    assert.ok(last.headers.get('retry-after'), '带 Retry-After');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 受限会话门（提交 4）：`must_change_password=true` ⇒ 除放行清单外的 `/api/*` 一律 403
// ---------------------------------------------------------------------------

const PREVIEW_HOST = 'erin-p-22000.fde.erix.vip';

/** 受限会话 + 一片预览端口（forward-auth 要用）。 */
async function setupGate({ mustChange = true, login = 'erin', role = 'fde' } = {}) {
  const pool = new MustChangePool({
    users: [ADMIN],
    allocations: [{
      id: 'pa-255', fde_id: `u-${login}`, state: 'active', exposure: 'public',
      hostname: PREVIEW_HOST, url: `https://${PREVIEW_HOST}`, port: 22000,
    }],
  });
  const s = await startServer({ pool });
  const user = await seedUser(pool, { login, password: OLD_PW, role, fdeName: login, mustChange });
  const { cookie } = await loginCookieFor({ ...s, login, password: OLD_PW });
  return { pool, user, ...s, cookie, loginAuditCount: pool.audit.length };
}

const get = (base, path, cookie) => fetch(`${base}${path}`, { headers: { cookie } });

/** 断言「这个 403 是 forward-auth 自己的判定，不是 #255 的门」——门的 403 一定带这个码。 */
function expectNotGate(body) {
  assert.notEqual(body?.error?.code, 'password_change_required',
    `被受限会话门挡了（清单漏了这一项）：${JSON.stringify(body)}`);
}

test('#255③ 放行清单是显式常量：每条都有 method/path/reason，必需端点一条不能少', () => {
  assert.ok(Array.isArray(RESTRICTED_SESSION_ALLOWLIST) && RESTRICTED_SESSION_ALLOWLIST.length >= 8,
    '清单必须是非空常量数组');
  for (const entry of RESTRICTED_SESSION_ALLOWLIST) {
    assert.ok(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', '*'].includes(entry.method), `method 非法：${entry.method}`);
    assert.ok(typeof entry.path === 'string' && entry.path.startsWith('/api/'), `path 必须是 /api/ 开头：${entry.path}`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.length >= 20,
      `${entry.method} ${entry.path} 缺理由——清单就是契约，没有理由的条目会被下一个人顺手删掉`);
    assert.ok(Object.isFrozen(entry), `${entry.method} ${entry.path} 必须冻结（防运行时被改）`);
  }
  // 必需项（工单判据）：少任何一条都是「把自己锁在门外」。
  for (const [method, path] of [
    ['GET', '/api/me'], ['POST', '/api/me/password'],
    ['POST', '/api/auth/logout'], ['POST', '/api/logout'],
    ['POST', '/api/auth/login'], ['POST', '/api/auth/login/totp'], ['POST', '/api/login'],
    ['GET', '/api/forward-auth'], ['POST', '/api/forward-auth'],
  ]) {
    assert.ok(restrictedSessionAllows(method, path), `放行清单少了 ${method} ${path}`);
  }
  assert.ok(restrictedSessionAllows('GET', '/api/internal/claim'), '/api/internal/* 必须整段放行（不带 cookie）');
  // forward-auth 的理由必须留在清单里（它不在浏览器语义里，最容易被「顺手收紧」）。
  const fa = RESTRICTED_SESSION_ALLOWLIST.find((e) => e.path === '/api/forward-auth');
  assert.match(fa.reason, /Traefik|预览/, 'forward-auth 的条目要写明「挡住 = 整片预览挂」');
});

test('#255③ 纯判据：清单外一律挡，清单内一律放（HEAD 按 GET 判）', () => {
  assert.equal(restrictedSessionAllows('GET', '/api/sessions'), false);
  assert.equal(restrictedSessionAllows('POST', '/api/sessions'), false);
  assert.equal(restrictedSessionAllows('GET', '/api/admin/users'), false);
  assert.equal(restrictedSessionAllows('GET', '/api/me/ports'), false);
  assert.equal(restrictedSessionAllows('GET', '/api/sessions/x/events'), false);
  assert.equal(restrictedSessionAllows('GET', '/api/me'), true);
  assert.equal(restrictedSessionAllows('HEAD', '/api/me'), true, 'HEAD 是 GET 的子集，同一份放行理由');
  assert.equal(restrictedSessionAllows('GET', '/api/me/password'), true, '不限方法：非 POST 该拿 405，不是 403');
  // `/api/me` 的前缀不能顺手写成 startsWith，否则 `/api/me/ports` 会被误放。
  assert.equal(restrictedSessionAllows('GET', '/api/meeee'), false);
});

test('#255③ 旗标为真 ⇒ 清单外的 GET /api/sessions 一律 403 password_change_required（且不写审计）', async () => {
  const t = await setupGate();
  try {
    const res = await get(t.base, '/api/sessions', t.cookie);
    assert.equal(res.status, 403, `应 403（实际 ${res.status}）`);
    const body = await res.json();
    assert.equal(body.error.code, 'password_change_required');
    assert.equal(body.error.retryable, false);
    assert.equal(body.error.details.endpoint, 'POST /api/me/password', 'details 要告诉前端去哪儿解锁');
    assert.equal(t.pool.audit.length, t.loginAuditCount,
      '门不写审计：受限会话下 SPA 每个轮询都会撞门，审计会被客户端重试刷成噪声（刻意的，理由写在 http.js）');

    const adminRes = await fetch(`${t.base}/api/admin/users`, { headers: { cookie: t.cookie } });
    assert.equal(adminRes.status, 403, '/api/admin/* 同样受限（本例用户不是 admin，但门排在鉴权之前）');
    assert.equal((await adminRes.json()).error.code, 'password_change_required');
  } finally {
    await t.close();
  }
});

test('#255③ 清单内不被挡：GET /api/me 200（旗标随 user 下发）', async () => {
  const t = await setupGate();
  try {
    const res = await get(t.base, '/api/me', t.cookie);
    assert.equal(res.status, 200, `应 200（实际 ${res.status}：${await res.clone().text()}）`);
    const body = await res.json();
    assert.equal(body.user.login, 'erin');
    // 前端就是靠这一列决定把用户弹到改密屏（§2.6）；挡掉 /api/me = SPA 只看见一片 403。
    assert.equal(body.user.must_change_password, true, 'findSessionUser 必须把旗标带出来');
  } finally {
    await t.close();
  }
});

test('#255③ 出口不被挡：POST /api/me/password 到得了 handler（删掉清单里这条 ⇒ 本例必须红）', async () => {
  const t = await setupGate();
  try {
    // 用「错当前口令」探：到得了 handler 就是 401 invalid_credentials；被门挡则是 403。
    const res = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: 'nope', new_password: NEW_PW } });
    const body = await res.json();
    assert.notEqual(body?.error?.code, 'password_change_required', '改密出口不得被门挡住（挡住 = 死锁）');
    assert.equal(res.status, 401, `handler 自己的 401 invalid_credentials（实际 ${res.status}：${JSON.stringify(body)}）`);
    assert.equal(body.error.code, 'invalid_credentials');
  } finally {
    await t.close();
  }
});

test('#255③ ⚠ forward-auth 不受限：带着受限会话的 cookie 也照常放行（把 forward-auth 纳入受限 ⇒ 本例必须红）', async () => {
  const t = await setupGate();
  try {
    // Traefik 的 authRequestHeaders 白名单里带 `Cookie`（routes.js），所以这枚受限会话的登录 cookie
    // 会原样出现在 forward-auth 请求上；本例故意把它发出去，模拟「portal 与预览共享 cookie 作用域」。
    const edge = { 'x-forwarded-host': PREVIEW_HOST, 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/', cookie: t.cookie };
    const res = await fetch(`${t.base}/api/forward-auth`, { headers: edge });
    const body = await res.json().catch(() => ({}));
    expectNotGate(body);
    assert.equal(res.status, 200, `public 预览应放行（实际 ${res.status}：${JSON.stringify(body)}）`);
    assert.equal(res.headers.get('x-auth-user'), 'erin', 'X-Auth-User 照旧下发');

    // 反向确认「不是所有 403 都算过」：private + 无凭证时的 403 必须是 forward-auth 自己的码（§2.7）。
    t.pool.allocations[0].exposure = 'private';
    const denied = await fetch(`${t.base}/api/forward-auth`, {
      headers: { 'x-forwarded-host': PREVIEW_HOST, 'x-forwarded-method': 'GET', 'x-forwarded-uri': '/' },
    });
    const deniedBody = await denied.json();
    expectNotGate(deniedBody);
    assert.equal(denied.status, 403);
    assert.equal(deniedBody.error.code, 'preview_ticket_required', 'deny 走 §2.7 自己的码，不是门的码');
  } finally {
    await t.close();
  }
});

test('#255③ 登录/登出新旧两条路径都不被挡（受限用户必须能退出、能重新登录）', async () => {
  const t = await setupGate();
  try {
    // 旧路径（307）：门在 307 重写**之前**，所以这两条也在清单里。
    const legacyLogin = await fetch(`${t.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: t.cookie },
      body: JSON.stringify({ login: 'erin', password: OLD_PW }),
      redirect: 'manual',
    });
    assert.equal(legacyLogin.status, 307, `旧登录路径不得被门挡（实际 ${legacyLogin.status}）`);
    assert.equal(legacyLogin.headers.get('location'), '/api/auth/login');

    const legacyLogout = await fetch(`${t.base}/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: t.cookie },
      body: '{}',
      redirect: 'manual',
    });
    assert.equal(legacyLogout.status, 307, `旧登出路径不得被门挡（实际 ${legacyLogout.status}）`);
    assert.equal(legacyLogout.headers.get('location'), '/api/auth/logout');

    // 新路径：登出真身 204 + 会话吊销；重新登录（同一条口令，旗标仍在）照样拿得到会话。
    const logout = await fetch(`${t.base}/api/auth/logout`, { method: 'POST', headers: { cookie: t.cookie } });
    assert.equal(logout.status, 204, '登出永远可达');
    assert.equal((await get(t.base, '/api/me', t.cookie)).status, 401, '会话已吊销');

    const again = await loginCookieFor({ ...t, login: 'erin', password: OLD_PW });
    assert.equal(again.body.status, 'authenticated', '重新登录不被门挡');
    assert.equal((await get(t.base, '/api/sessions', again.cookie)).status, 403, '新会话仍然受限（旗标没清）');
  } finally {
    await t.close();
  }
});

test('#255③ 旗标为假 ⇒ 一切照旧（不得把所有人挡在门外）', async () => {
  const t = await setupGate({ mustChange: false });
  try {
    const res = await get(t.base, '/api/sessions', t.cookie);
    assert.equal(res.status, 200, `flag=false 必须照旧 200（实际 ${res.status}：${await res.clone().text()}）`);
    assert.deepEqual(await res.json(), { items: [], next_cursor: null });
    assert.equal((await get(t.base, '/api/me', t.cookie)).status, 200);
    assert.equal((await fetch(`${t.base}/api/forward-auth`, {
      headers: { 'x-forwarded-host': PREVIEW_HOST, 'x-forwarded-method': 'GET', cookie: t.cookie },
    })).status, 200);
  } finally {
    await t.close();
  }
});

test('#255③ 门不改既有语义：无 cookie / 坏 cookie 仍是 401 unauthorized；静态资源与健康检查不受管', async () => {
  const t = await setupGate();
  try {
    for (const headers of [{}, { cookie: `${t.config.cookie.name}=nope` }]) {
      const res = await fetch(`${t.base}/api/sessions`, { headers });
      assert.equal(res.status, 401, `未认证仍走 handler 的 401（实际 ${res.status}）`);
      assert.equal((await res.json()).error.code, 'unauthorized');
    }
    // 门只管 `/api/*`：SPA 外壳必须照常（否则「改密屏」这个页面本身都打不开）；
    // /api/health 在 routeApi **之前**就被 `route()` 接走 ⇒ 根本进不了门（本 fake 的迁移台账不全，
    // 健康检查自己会回 503，那与门无关）⇒ 这里钉的是「不是 403」，不是 200。
    assert.equal((await fetch(`${t.base}/`, { headers: { cookie: t.cookie } })).status, 200);
    const health = await fetch(`${t.base}/api/health`, { headers: { cookie: t.cookie } });
    assert.notEqual(health.status, 403, '健康检查/探针绝不允许被受限会话门挡（挡了会把「全员欠改密」误判成站点故障）');
    assert.notEqual((await health.json()).error?.code, 'password_change_required');
  } finally {
    await t.close();
  }
});

test('#255③ 每请求恰查一次 login_sessions（门与 requireSession 共用请求内缓存，不是每请求两次）', async () => {
  const gated = await setupGate({ mustChange: false }); // flag=false ⇒ 走到 handler，两边都会要会话
  try {
    await get(gated.base, '/api/sessions', gated.cookie);
    const lookups = gated.pool.sqlLog.filter(({ sql }) => sql.includes('FROM login_sessions s')).length;
    assert.equal(lookups, 1, `放行清单外的请求应只查一次会话（实际 ${lookups} 次）`);
  } finally {
    await gated.close();
  }
  const blocked = await setupGate({ mustChange: true });
  try {
    await get(blocked.base, '/api/sessions', blocked.cookie);
    assert.equal(blocked.pool.sqlLog.filter(({ sql }) => sql.includes('FROM login_sessions s')).length, 1,
      '被挡的请求也只查一次（门查完就返回，不会再进 handler）');
  } finally {
    await blocked.close();
  }
});

test('#255③ 端到端闭环：改完密门立即解锁（清旗标后同一会话可用），错口令期间始终 403', async () => {
  const t = await setupGate({ mustChange: true });
  try {
    assert.equal((await get(t.base, '/api/sessions', t.cookie)).status, 403);
    const wrong = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: 'nope', new_password: NEW_PW } });
    assert.equal(wrong.status, 401);
    assert.equal((await get(t.base, '/api/sessions', t.cookie)).status, 403, '改密失败 ⇒ 仍然受限');

    const ok = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(ok.status, 200, `改密应成功（实际 ${ok.status}：${await ok.clone().text()}）`);
    const unlocked = await get(t.base, '/api/sessions', t.cookie);
    assert.equal(unlocked.status, 200, '旗标已清 ⇒ 同一会话立刻解锁（不得要求重新登录）');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 登录响应增字段 `password_change_required`（提交 5，纯 additive）
// ---------------------------------------------------------------------------

const USER_DTO_KEYS = ['id', 'login', 'display_name', 'role', 'fde_name', 'auth_source'].sort();

test('#255④ 口令直通分支：flag 真 / 假两种用户的 password_change_required 各为 true / false', async () => {
  for (const mustChange of [true, false]) {
    const t = await setupGate({ mustChange, login: mustChange ? 'flagged' : 'plain' });
    try {
      const res = await fetch(`${t.base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login: t.user.login, password: OLD_PW }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok('password_change_required' in body, '字段必须**存在**（false 也要出现，不能靠缺省省掉）');
      assert.equal(typeof body.password_change_required, 'boolean', '必须是布尔，不是 undefined/字符串');
      assert.equal(body.password_change_required, mustChange, `flag=${mustChange} 时字段必须是 ${mustChange}`);
      // 既有契约不回退（§2.2）：status 与 user DTO 形状一字未动。
      assert.equal(body.status, 'authenticated');
      assert.deepEqual(Object.keys(body.user).sort(), USER_DTO_KEYS, 'user DTO 不得被这次增字段改动');
      assert.ok(res.headers.get('set-cookie')?.includes(t.config.cookie.name), 'cookie 照旧下发');
    } finally {
      await t.close();
    }
  }
});

test('#255④ TOTP 分支（第二步才发会话）同样带该字段；中间的 totp_required 响应不受影响', async () => {
  for (const mustChange of [true, false]) {
    const pool = new MustChangePool({ users: [ADMIN] });
    const login = mustChange ? 'totp-flagged' : 'totp-plain';
    const secret = totp.generateSecret(20);
    await seedUser(pool, { login, password: OLD_PW, mustChange, totpSecret: secret });
    const s = await startServer({ pool });
    try {
      const step1 = await fetch(`${s.base}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ login, password: OLD_PW }),
      });
      const body1 = await step1.json();
      assert.equal(body1.status, 'totp_required');
      assert.equal(step1.headers.get('set-cookie'), null, '第一步尚未登录，不发 cookie');
      // 中间响应**不加**这一位：此刻还没有会话，谈不上受限（口径写进 §2.2/§2.3）。
      assert.deepEqual(Object.keys(body1).sort(), ['expires_in', 'pending_token', 'status']);

      const step2 = await fetch(`${s.base}/api/auth/login/totp`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pending_token: body1.pending_token, code: totp.totp(secret) }),
      });
      assert.equal(step2.status, 200, `第二步应成功（实际 ${step2.status}：${await step2.clone().text()}）`);
      const body2 = await step2.json();
      assert.equal(body2.password_change_required, mustChange,
        `注册了 TOTP 的受限账号必须在第二步就拿到旗标（否则只能靠第一个 403 发现自己要改密）`);
      assert.deepEqual(Object.keys(body2.user).sort(), USER_DTO_KEYS);
      assert.ok(step2.headers.get('set-cookie')?.includes(s.config.cookie.name));
    } finally {
      await s.close();
    }
  }
});

test('#255④ 闭环：改完密再登录 ⇒ 该位翻成 false（与受限会话门的解锁同一件事实在两处一致）', async () => {
  const t = await setupGate({ mustChange: true });
  try {
    assert.equal((await loginCookieFor({ ...t, login: 'erin', password: OLD_PW })).body.password_change_required, true);
    const changed = await postPassword({ base: t.base, cookie: t.cookie, body: { current_password: OLD_PW, new_password: NEW_PW } });
    assert.equal(changed.status, 200);
    const after = await loginCookieFor({ ...t, login: 'erin', password: NEW_PW });
    assert.equal(after.body.password_change_required, false, '改密后再登录 ⇒ 不再受限');
    assert.equal((await get(t.base, '/api/sessions', after.cookie)).status, 200, '登录响应与门的判定必须一致');
  } finally {
    await t.close();
  }
});

test('#255④ 登录失败路径不受影响：错口令仍 401 invalid_credentials（不新增错误码、不泄露旗标）', async () => {
  const t = await setupGate({ mustChange: true });
  try {
    const res = await fetch(`${t.base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'erin', password: 'wrong-' + OLD_PW }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'invalid_credentials');
    assert.equal('password_change_required' in body, false, '失败响应不发这一位（口令错的人本就还没会话）');
    assert.equal(res.headers.get('set-cookie'), null);
  } finally {
    await t.close();
  }
});
