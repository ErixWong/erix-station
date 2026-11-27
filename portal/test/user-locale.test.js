// issue #828 P1：账号级语言偏好 users.locale 的读写、归一化、审计。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool，不碰真实 DB / docker。
// 前端落 cookie 是 P2（portal/frontend/**），本文件只钉后端契约。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as admin from '../src/admin.js';
import { FakePool } from './fake-pool.js';
import { normalizeUserLocale } from '../src/db.js';

// ---- 夹具生命周期：mkdtemp 与注册 rm 必须在同一条用例内闭环（#880）----
// 本文件建的每一个 /tmp 目录都进 tmpDirs；漏一个就会在 /tmp 留下 station-locale-*，
// 而 scripts/check-tmp-hygiene.mjs 正是数这个名字（增量口径：本轮新增必须为 0）。
const tmpDirs = [];
function trackTmp(dir) {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    // rmSync 必须是真语句：注释掉它 while 就空转成死循环（#880 批一踩过）。
    fs.rmSync(tmpDirs.pop(), { recursive: true, maxRetries: 3 });
  }
});

// ---- normalizeUserLocale：归一化表的逐字钉（白名单在应用侧，DB 不锁）----
test('normalizeUserLocale 归一化表逐字符合契约', () => {
  // 清空：null / 空串 → null
  assert.deepEqual(normalizeUserLocale(null), { ok: true, value: null });
  assert.deepEqual(normalizeUserLocale(''), { ok: true, value: null });
  assert.deepEqual(normalizeUserLocale('   '), { ok: true, value: null });
  // 英文族（含地区/书写体后缀、大小写、下划线）→ en
  for (const v of ['en', 'EN', ' en ', 'en-US', 'en-GB', 'en_gb', 'en-us']) {
    assert.deepEqual(normalizeUserLocale(v), { ok: true, value: 'en' }, `${v} → en`);
  }
  // 中文族（本服务只一档中文）→ zh-CN
  for (const v of ['zh', 'zh-CN', 'zh-Hans', 'zh_CN', 'ZH-cn', 'zh-hans', 'zh-TW', 'zh-Hant']) {
    assert.deepEqual(normalizeUserLocale(v), { ok: true, value: 'zh-CN' }, `${v} → zh-CN`);
  }
  // 其余语言 / 非字符串 → 拒绝
  for (const bad of ['fr', 'es', 'de-DE', 'ja', 0, 1, true, {}, [], ['en'], undefined]) {
    assert.deepEqual(normalizeUserLocale(bad), { ok: false }, `${JSON.stringify(bad)} 应拒绝`);
  }
});

// ---- fake pool：补 setUserLocale / updateUser 的 UPDATE CTE / INSERT users（create 不收 locale）----
class LocalePool extends FakePool {
  constructor(options) {
    super(options);
    this.sqlLog = [];
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });
    // 本人 PATCH /api/me/locale：写库并回归一化后的值。
    if (sql.includes('UPDATE users SET locale = $2 WHERE id = $1') && sql.includes('RETURNING locale')) {
      const [userId, value] = params;
      const user = this.users.find((u) => u.id === userId);
      if (!user) return { rows: [] };
      user.locale = value;
      return { rows: [{ locale: value }] };
    }
    // 管理台 updateUser 的 UPDATE CTE（不是重激活的 `SET login = $2`）。按 SQL 的列清单落，不另写一套。
    if (sql.includes('WITH updated AS') && sql.includes('UPDATE users SET') && !sql.includes('SET login = $2')) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) return { rows: [] };
      const field = (name) => {
        const m = sql.match(new RegExp(`${name} = \\$([0-9]+)`));
        return m ? params[Number(m[1]) - 1] : undefined;
      };
      for (const name of ['display_name', 'email', 'role', 'fde_name', 'file_upload_enabled', 'totp_login_enabled', 'mail_otp_enabled', 'locale']) {
        const v = field(name);
        if (v !== undefined) user[name] = v;
      }
      const status = field('status');
      if (status !== undefined) { user.status = status; user.disabled_at = status === 'disabled' ? new Date() : null; }
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name,
          email: user.email ?? null, mail_otp_enabled: user.mail_otp_enabled ?? false,
          file_upload_enabled: user.file_upload_enabled ?? false,
          totp_login_enabled: user.totp_login_enabled ?? false,
          role: user.role, fde_name: user.fde_name ?? null, auth_source: user.auth_source,
          status: user.status, created_at: user.created_at ?? new Date(),
          last_activity_at: user.last_activity_at ?? null, locale: user.locale ?? null,
        }],
      };
    }
    // 建用户预检 / 唯一性（create 面不收 locale）。
    if (sql.includes('SELECT 1 FROM users WHERE login') || sql.includes('SELECT 1 FROM users WHERE email')
        || sql.includes('SELECT 1 FROM users WHERE fde_name')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT id, status FROM users WHERE fde_name')
        || sql.includes('SELECT state FROM fde_offboarding')
        || sql.includes('SELECT git_host_id, token_ref FROM fde_git_accounts')) {
      return { rows: [] };
    }
    // 建用户的 INSERT：列清单里没有 locale（create 面结构性忽略它），按 SQL 列清单落，locale 保持未设 = null。
    if (sql.includes('INSERT INTO users')) {
      const [colsPart, valuesPart = ''] = sql.split(/VALUES/i);
      const cols = colsPart.slice(colsPart.lastIndexOf('(') + 1, colsPart.lastIndexOf(')'))
        .split(',').map((c) => c.trim());
      const user = { id: `new-${this.users.length + 1}` };
      cols.forEach((c, i) => { user[c] = params[i]; });
      // 归一化后的 locale 列不在 INSERT 里 ⇒ 显式钉成 null（跟随浏览器）。
      user.locale = cols.includes('locale') ? params[cols.indexOf('locale')] : null;
      this.users.push(user);
      return {
        rows: [{
          id: user.id, login: user.login, display_name: user.display_name, email: user.email ?? null,
          mail_otp_enabled: false, file_upload_enabled: false, totp_login_enabled: false,
          role: user.role ?? 'fde', fde_name: user.fde_name ?? null, auth_source: 'local',
          status: 'active', created_at: new Date(), last_activity_at: null,
        }],
      };
    }
    // updateUser 的存在性预检。
    if (sql.includes('SELECT id, login, fde_name FROM users WHERE id = $1')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ id: u.id, login: u.login, fde_name: u.fde_name ?? null }] : [] };
    }
    if (sql.includes('SELECT email, mail_otp_enabled FROM users WHERE id = $1')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ email: u.email ?? null, mail_otp_enabled: u.mail_otp_enabled ?? false }] : [] };
    }
    return super.query(sql, params);
  }
}

async function startServer({ users = [], pool: customPool } = {}) {
  const staticDir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'station-locale-')));
  fs.mkdirSync(path.join(staticDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'app', 'index.html'), 'IDX');
  const config = {
    cookie: cookieSettings('dev-locale', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256, staticDir,
  };
  const pool = customPool || new LocalePool({ users });
  const server = createServer({ pool, config, log: { error: () => {}, warn: () => {}, log: () => {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { pool, config, base, close: () => new Promise((res) => server.close(res)) };
}

// 登录（口令直通，无 TOTP/邮件码）并返回 { cookie, loginBody }。
async function login(s, loginName, password) {
  const res = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  const body = await res.json();
  const setCookie = res.headers.get('set-cookie');
  const token = setCookie ? setCookie.split(';')[0].split('=')[1] : null;
  return { status: res.status, body, cookie: token ? `${s.config.cookie.name}=${token}` : null };
}

async function makeUser(s, { login: name, role = 'fde', locale = undefined }) {
  const password = 'correct-horse-1';
  const id = `u-${name}`;
  s.pool.users.push({
    id, login: name, display_name: name, role, fde_name: name, auth_source: 'local', status: 'active',
    password_hash: await auth.hashPassword(password), totp_secret: null, last_totp_step: null,
    ...(locale !== undefined ? { locale } : {}),
  });
  return { id, password };
}

// ---- PATCH /api/me/locale 与 GET /api/me ----
test('PATCH /api/me/locale：写 en → GET /api/me 回 en；写 null → 回 null', async () => {
  const s = await startServer({ users: [] });
  try {
    const { password } = await makeUser(s, { login: 'alice', locale: null });
    const { cookie, body } = await login(s, 'alice', password);
    assert.equal(body.status, 'authenticated');
    assert.equal(body.user.locale, null, '未设过 = null');

    let me = await (await fetch(`${s.base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.user.locale, null);

    let r = await fetch(`${s.base}/api/me/locale`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { locale: 'en' }, '成功回归一化后的值');
    me = await (await fetch(`${s.base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.user.locale, 'en');

    r = await fetch(`${s.base}/api/me/locale`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: null }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { locale: null });
    me = await (await fetch(`${s.base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.user.locale, null);
  } finally { await s.close(); }
});

test('PATCH /api/me/locale：归一化 en-US→en、zh_CN→zh-CN、""→null', async () => {
  const s = await startServer({ users: [] });
  try {
    const { password } = await makeUser(s, { login: 'bob', locale: null });
    const { cookie } = await login(s, 'bob', password);
    for (const [sent, expected] of [['en-US', 'en'], ['zh_CN', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['', null]]) {
      const r = await fetch(`${s.base}/api/me/locale`, {
        method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: sent }),
      });
      assert.equal(r.status, 200, `${JSON.stringify(sent)} 应 200`);
      assert.deepEqual(await r.json(), { locale: expected }, `${JSON.stringify(sent)} → ${expected}`);
    }
  } finally { await s.close(); }
});

test('PATCH /api/me/locale：fr / 数字 / 缺键 → 400 validation_failed + details.field=locale', async () => {
  const s = await startServer({ users: [] });
  try {
    const { password } = await makeUser(s, { login: 'carol', locale: null });
    const { cookie } = await login(s, 'carol', password);
    for (const body of [{ locale: 'fr' }, { locale: 42 }, { locale: { a: 1 } }, {}]) {
      const r = await fetch(`${s.base}/api/me/locale`, {
        method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400, `${JSON.stringify(body)} 应 400`);
      const err = await r.json();
      assert.equal(err.error.code, 'validation_failed', '错误码逐字');
      assert.equal(err.error.details.field, 'locale', 'details.field 逐字');
    }
  } finally { await s.close(); }
});

test('PATCH /api/me/locale：错误体走 #803 双语（locale=en 时错误消息出英文）', async () => {
  const s = await startServer({ users: [] });
  try {
    const { password } = await makeUser(s, { login: 'dave', locale: null });
    const { cookie } = await login(s, 'dave', password);
    const r = await fetch(`${s.base}/api/me/locale`, {
      method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json', 'Accept-Language': 'en' },
      body: JSON.stringify({ locale: 'fr' }),
    });
    assert.equal(r.status, 400);
    const err = (await r.json()).error;
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.details.field, 'locale');
    assert.equal(err.message, "locale must be 'zh-CN', 'en', or null", '英文文案');
  } finally { await s.close(); }
});

test('PATCH /api/me/locale：未登录 401', async () => {
  const s = await startServer({ users: [] });
  try {
    const r = await fetch(`${s.base}/api/me/locale`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: 'en' }),
    });
    assert.equal(r.status, 401);
  } finally { await s.close(); }
});

test('登录响应与 GET /api/me 带 locale；NULL 用户响应除新增键外逐字不变', async () => {
  const s = await startServer({ users: [] });
  try {
    const { password } = await makeUser(s, { login: 'erin', locale: null });
    const { body } = await login(s, 'erin', password);
    // 登录响应含 locale（值为 null）
    assert.ok(Object.hasOwn(body.user, 'locale'), '登录 user 含 locale 键');
    assert.equal(body.user.locale, null);
    // user DTO 形状：除新增 locale 外与既有契约逐字一致（无 password_hash / totp_secret / must_change_password）
    assert.deepEqual(Object.keys(body.user).sort(), [
      'auth_source', 'display_name', 'fde_name', 'file_upload_enabled', 'id', 'locale', 'login', 'role',
    ].sort());
  } finally { await s.close(); }
});

// ---- 管理台 ----
test('管理台 PATCH /api/admin/users/:id：locale 生效、审计留一条且值非 "null"', async () => {
  const adminToken = 'tok-locale-admin';
  const ADMIN_ID = 'a0000000-0000-4000-8000-0000000000a1';
  const TGT_ID = 'b0000000-0000-4000-8000-0000000000b2';
  const adminUser = {
    id: ADMIN_ID, login: 'root', display_name: 'root', role: 'admin', fde_name: null,
    auth_source: 'local', status: 'active', password_hash: 'x', totp_secret: null, last_totp_step: null,
  };
  const target = {
    id: TGT_ID, login: 'fde1', display_name: 'fde1', role: 'fde', fde_name: 'fde1',
    auth_source: 'local', status: 'active', password_hash: 'x', totp_secret: null, last_totp_step: null, locale: 'en',
  };
  const s = await startServer({ pool: new LocalePool({ users: [adminUser, target] }) });
  try {
    s.pool.sessions.push({
      id: 'ls-adm', user_id: ADMIN_ID, token_hash: auth.hashToken(adminToken),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    const cookie = `${s.config.cookie.name}=${adminToken}`;
    const H = { cookie, 'Content-Type': 'application/json' };

    let r = await fetch(`${s.base}/api/admin/users/${TGT_ID}`, { method: 'PATCH', headers: H, body: JSON.stringify({ locale: 'zh-CN' }) });
    let payload = await r.json();
    assert.equal(r.status, 200);
    assert.equal(payload.user.locale, 'zh-CN');
    assert.equal(s.pool.users.find((u) => u.id === TGT_ID).locale, 'zh-CN');

    // 清除：值应写「跟随浏览器」而不是字符串 "null"
    r = await fetch(`${s.base}/api/admin/users/${TGT_ID}`, { method: 'PATCH', headers: H, body: JSON.stringify({ locale: null }) });
    payload = await r.json();
    assert.equal(r.status, 200);
    assert.equal(payload.user.locale, null);

    const audits = s.pool.audit.filter((a) => a.action === 'admin.user_locale_updated');
    assert.equal(audits.length, 2, '两次 locale 改动各留一条审计');
    const first = JSON.parse(audits[0].details);
    assert.equal(first.locale, 'zh-CN');
    const second = JSON.parse(audits[1].details);
    assert.equal(second.locale, '跟随浏览器');
    assert.notEqual(JSON.stringify(second.locale), 'null', '清除值不得记成字符串 "null"');
  } finally { await s.close(); }
});

test('管理台建用户不接受 locale：admin.createUser 的 INSERT 不带 locale 列', async () => {
  const pool = new LocalePool({ users: [] });
  await admin.createUser(pool, {
    login: 'gina', display_name: 'Gina', password: 'secret-pass-9', email: 'gina@example.test',
    fde_name: 'gina', locale: 'zh-CN',
  }, { actorId: null });
  // 持久化行：locale 被结构性忽略（保持 null = 跟随浏览器），body 里的 zh-CN 没落库
  assert.notEqual(pool.users.find((u) => u.login === 'gina').locale, 'zh-CN');
  const insert = pool.sqlLog.find((e) => e.sql.includes('INSERT INTO users'));
  assert.ok(insert, '确有一条 INSERT INTO users');
  assert.ok(!/\blocale\b/.test(insert.sql), 'INSERT 列清单不含 locale（与 file_upload_enabled 同「不在创建面」先例）');
});
