// issue #736：API 令牌（`st_` 前缀，admin 代签，只存 SHA-256 hash）。
// 契约：docs/api/portal.md §2.13；认证缝设计：docs/api/portal.md §2.2。
// 判据 = 工单 §4 M2 的 ①..⑬ + 登出配对（⑭）+ 零邮件动机用例（⑮）。
//
// 为什么起真 server：判据大半在 HTTP 边界（③不吐 `Set-Cookie`、
// ②`X-Auth-Method` 由派发层写、④错误信封、⑭登出守卫）——
// 直接调 seam 会绕过派发层。
// 假库不校列名 ⇒ 四条 SQL 已在真库事务对账并 ROLLBACK（见 M2 交棒）。
// 隔离约定（docs/testing.md §2.1）：注入 `FakePool`，不碰真实 DB。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as apiTokens from '../src/api-tokens.js';
import { FakePool } from './fake-pool.js';

const PASSWORD = 'correct horse battery staple';
let passwordHashCache = null;
async function passwordHash() {
  if (!passwordHashCache) passwordHashCache = await auth.hashPassword(PASSWORD);
  return passwordHashCache;
}

const openServers = new Set();
async function closeServer(server) {
  openServers.delete(server);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}
after(async () => {
  for (const server of [...openServers]) await closeServer(server);
});

/**
 * 记录型假 provider（形状同 login-email-code 测试）。
 * `enabled:false` = 通道不可用；口令步若想寄信会落进 `sent`
 * ⇒ 「用令牌 = 零邮件」可直接断言。
 */
function fakeProvider() {
  const sent = [];
  const mailer = {
    enabled: false,
    async send(m) {
      sent.push(m);
      return { ok: false, reason: 'disabled' };
    },
  };
  return { sent, get: async () => mailer, invalidate() {} };
}

async function makeUser({ id, login, role = 'fde', fde_name = login, mailOtp = false }) {
  return {
    id,
    login,
    display_name: login,
    role,
    fde_name,
    auth_source: 'local',
    status: 'active',
    email: `${login}@example.com`,
    password_hash: await passwordHash(),
    totp_secret: null,
    last_totp_step: null,
    // 工单动机：开邮箱码的账号口令步必寄真邮件
    // ⇒ ⑮ 用 `mailOtp:true` 专测；其余用例关邮箱码，
    // 只为 cookie 登录在假库里确定性直达。
    mail_otp_enabled: mailOtp,
    totp_login_enabled: false,
    must_change_password: false,
    file_upload_enabled: false,
  };
}

async function startServer({ users }) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-apitokens-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: {
      maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000,
    },
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
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
    mail: { killSwitch: false },
    loginEmailCode: { ttlSeconds: 600, maxAttempts: 5, resendCooldownSeconds: 60, maxResends: 3 },
  };
  const pool = new FakePool({ users });
  const provider = fakeProvider();
  const server = createServer({ pool, config, mailerProvider: provider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server); // 断言抛了也要收摊，否则事件循环永不空
  const base = `http://127.0.0.1:${server.address().port}`;
  return { pool, provider, base, close: () => closeServer(server) };
}

async function req(base, { method = 'GET', pathname = '/api/me', body, cookie, authz } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (authz) headers.authorization = authz;
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：调用方自己断言 text */ }
  return {
    status: res.status,
    json,
    text,
    setCookie: res.headers.get('set-cookie'),
    headers: res.headers,
  };
}

/** 口令登录取 cookie（夹具账号无 TOTP、通道不可用 ⇒ 口令步直达）。 */
async function loginCookie(base, login) {
  const res = await req(base, {
    method: 'POST', pathname: '/api/auth/login', body: { login, password: PASSWORD },
  });
  assert.equal(res.status, 200, `登录应直达: ${res.text}`);
  assert.ok(res.setCookie, '登录响应应带会话 cookie');
  return res.setCookie.split(';')[0];
}

async function harness({ logins = ['root', 'eric'], extraUsers = [] } = {}) {
  const users = [...extraUsers];
  for (const login of logins) {
    const role = login === 'root' ? 'admin' : 'fde';
    users.push(await makeUser({ id: `u-${login}`, login, role }));
  }
  const env = await startServer({ users });
  env.cookies = {};
  for (const login of logins) env.cookies[login] = await loginCookie(env.base, login);
  const tokenPath = (login, id) => `/api/admin/users/${login}/tokens${id ? `/${id}` : ''}`;
  env.mint = (actor, target, body) => req(env.base, {
    method: 'POST', pathname: tokenPath(target), cookie: env.cookies[actor], body,
  });
  env.list = (actor, target) => req(env.base, {
    method: 'GET', pathname: tokenPath(target), cookie: env.cookies[actor],
  });
  env.revoke = (actor, target, id) => req(env.base, {
    method: 'DELETE', pathname: tokenPath(target, id), cookie: env.cookies[actor],
  });
  // `touchToken` 是 fire-and-forget（设计点 8）：断言前让微任务/定时器落地。
  env.settle = () => new Promise((resolve) => setTimeout(resolve, 25));
  env.row = (name) => env.pool.apiTokens.find((t) => t.name === name);
  return env;
}

// ① 签发返回明文一次；库中只存 hash。
test('① 签发返回明文一次；库中只存 hash', async () => {
  const env = await harness();
  const res = await env.mint('root', 'eric', { name: 'ci' });
  assert.equal(res.status, 201, res.text);
  assert.deepEqual(Object.keys(res.json).sort(), ['created_at', 'id', 'name', 'scopes', 'token']);
  const { token, id, name, scopes, created_at: createdAt } = res.json;
  assert.match(token, /^st_[A-Za-z0-9_-]{43}$/, 'st_ + 32B base64url');
  assert.equal(name, 'ci');
  assert.deepEqual(scopes, []);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.match(id, UUID, '库列面 id 是 uuid');
  assert.equal(typeof createdAt, 'string');
  assert.notEqual(createdAt, 'null');

  assert.equal(env.pool.apiTokens.length, 1);
  const row = env.pool.apiTokens[0];
  assert.equal(row.token_hash, apiTokens.hashApiToken(token), '库里存 hash，不存明文');
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.token_hash, token);
  assert.doesNotMatch(JSON.stringify(env.pool.apiTokens), new RegExp(token), '明文绝不落库');
  await env.close();
});

// ② cookie 与 Bearer 解析出的 user **逐字段相等**（设计点 3：同一个对象）。
// 代码事实（以代码为准）：`findApiTokenUser` 折的 `user.auth_source`
// 是**账号自己的来源**（`local`），不是工单 §2.7 说的派生值
// `api_token` ⇒ 两路径 user 零差异；「令牌来的」由
// `X-Auth-Method` 头（仅令牌路径）与 `session.viaToken` 承担。
// 真库 user 列面（对账 SQL ③，见 M2 交棒）含 email/password_hash/totp_secret/
// last_totp_step/mail_otp_enabled 等 15+3 列；两路径都只投影 8 列
// {id,login,display_name,role,fde_name,auth_source,must_change_password,
// file_upload_enabled} ⇒ 秘密列全在 user 之外——深比较守的就是这个。
test('② 两条认证路径的 user 逐字段一致', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  assert.equal(mint.status, 201, mint.text);
  const bearer = `Bearer ${mint.json.token}`;

  const viaCookie = await req(env.base, { cookie: env.cookies.eric });
  const sessionsBeforeToken = env.pool.sessions.length;
  const viaToken = await req(env.base, { authz: bearer });
  assert.equal(viaCookie.status, 200);
  assert.equal(viaToken.status, 200);
  assert.deepEqual(
    Object.keys(viaToken.json.user).sort(),
    ['auth_source', 'display_name', 'fde_name', 'file_upload_enabled', 'id', 'login',
      'must_change_password', 'role'],
    '令牌路径的 user 键集 = cookie 路径的键集（秘密列不许混进来）',
  );
  assert.deepEqual(viaToken.json.user, viaCookie.json.user,
    '两路径 user 逐字段相等（auth_source 是账号自己的 local）');
  assert.equal(viaToken.headers.get('x-auth-method'), 'api_token', '令牌路径发 X-Auth-Method');
  assert.equal(viaCookie.headers.get('x-auth-method'), null, 'cookie 路径不发该头');
  // agent 不登录：令牌请求前后会话数不变（设计点 1 的构造性证据）。
  assert.equal(env.pool.sessions.length, sessionsBeforeToken, '令牌请求不落新会话');
  assert.equal(env.provider.sent.length, 0, '全程零邮件');
  await env.close();
});

// ③ 令牌请求不吐 Set-Cookie（连续 3 次）。
test('③ 令牌请求绝不触发 Set-Cookie', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  const bearer = `Bearer ${mint.json.token}`;
  for (let i = 1; i <= 3; i += 1) {
    const res = await req(env.base, { authz: bearer });
    assert.equal(res.status, 200);
    assert.equal(res.setCookie, null, `第 ${i} 次令牌请求不应吐 Set-Cookie`);
  }
  await env.close();
});

// ④ cookie + Bearer 同时 ⇒ 400 `ambiguous_credential`（先于 scheme 判定）。
test('④ cookie 与 Bearer 同时出现 ⇒ 400 ambiguous_credential', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  const res = await req(env.base, { cookie: env.cookies.eric, authz: `Bearer ${mint.json.token}` });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'ambiguous_credential');
  // 反证：只给其中一个都正常。
  assert.equal((await req(env.base, { cookie: env.cookies.eric })).status, 200);
  assert.equal((await req(env.base, { authz: `Bearer ${mint.json.token}` })).status, 200);
  await env.close();
});

// ⑤ `Authorization: Basic ...`（无 cookie）⇒ 401 `unsupported_scheme`。
test('⑤ 非 Bearer scheme ⇒ 401 unsupported_scheme', async () => {
  const env = await harness();
  const basic = Buffer.from('eric:pw').toString('base64');
  const res = await req(env.base, { authz: `Basic ${basic}` });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'unsupported_scheme');
  await env.close();
});

// ⑥ 未知/错哈希/空 Bearer ⇒ 401（不落行、不建会话）。
test('⑥ 未知令牌 / 空 Bearer ⇒ 401 unauthorized', async () => {
  const env = await harness();
  const unknown = await req(env.base, { authz: 'Bearer st_this_token_does_not_exist_00000' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.json.error.code, 'unauthorized');

  const fresh = apiTokens.generateApiToken();
  const wrongHash = await req(env.base, { authz: `Bearer ${fresh}` });
  assert.equal(wrongHash.status, 401);
  assert.equal(wrongHash.json.error.code, 'unauthorized');

  const empty = await req(env.base, { authz: 'Bearer' });
  assert.equal(empty.status, 401);
  assert.equal(empty.json.error.code, 'unauthorized');
  assert.equal(env.pool.apiTokens.length, 0, '失败的令牌尝试不落任何行');
  await env.close();
});

// ⑦ 吊销：立即 401、只一行带 revoked_at（不删行）、重复吊销仍 200。
test('⑦ 吊销：立即失效、revoked_at 恰一行、重复吊销幂等', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  const { id, token } = mint.json;
  assert.equal((await req(env.base, { authz: `Bearer ${token}` })).status, 200);

  const first = await env.revoke('root', 'eric', id);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { status: 'revoked', already_revoked: false });
  assert.notEqual(env.row('ci').revoked_at, null);

  const dead = await req(env.base, { authz: `Bearer ${token}` });
  assert.equal(dead.status, 401);
  assert.equal(dead.json.error.code, 'unauthorized');

  const second = await env.revoke('root', 'eric', id);
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { status: 'revoked', already_revoked: true });
  const revokedRows = env.pool.apiTokens.filter((t) => t.revoked_at !== null);
  assert.equal(revokedRows.length, 1, '吊销是 UPDATE 不是删行');
  assert.equal(env.pool.apiTokens.length, 1);
  await env.close();
});

// ⑧ FDE 调签发/列表 ⇒ 403 `insufficient_role`（非 blanket 的 forbidden）。
test('⑧ FDE 调令牌管理 ⇒ 403 insufficient_role 且零签发', async () => {
  const env = await harness();
  const post = await env.mint('eric', 'eric', { name: 'self-serve' });
  assert.equal(post.status, 403);
  assert.equal(post.json.error.code, 'insufficient_role');
  const get = await env.list('eric', 'eric');
  assert.equal(get.status, 403);
  assert.equal(get.json.error.code, 'insufficient_role');
  assert.equal(env.pool.apiTokens.length, 0);
  await env.close();
});

// ⑨ scopes 非空 ⇒ 400；边界 `scopes: []` ⇒ 201 且落库 `[]`。
test('⑨ scopes 非空 ⇒ 400 scopes_unsupported；空数组边界通过', async () => {
  const env = await harness();
  const bad = await env.mint('root', 'eric', { name: 'scoped', scopes: ['read'] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'scopes_unsupported');
  assert.equal(env.pool.apiTokens.length, 0, '被拒的签发不留行');

  const ok = await env.mint('root', 'eric', { name: 'ci', scopes: [] });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual(ok.json.scopes, []);
  assert.deepEqual(env.row('ci').scopes, []);
  await env.close();
});

// ⑩ `last_used_at` 节流（产品窗口 = 5 分钟，`TOUCH_INTERVAL_SQL`）：
// 窗内第二次认证**不**再写，窗外才写。判据 = 假库流水里
// 该 UPDATE 路由次数 + 行值（「总是写」第2格红、「从不写」第1格红）。
test('⑩ last_used_at 窗内只写一次（假库 UPDATE 计数 + 行值）', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  const bearer = `Bearer ${mint.json.token}`;
  const touched = () => env.pool.statements
    .filter((s) => s.sql.includes('UPDATE api_tokens SET last_used_at')).length;

  assert.equal((await req(env.base, { authz: bearer })).status, 200);
  await env.settle();
  assert.equal(touched(), 1, '第 1 次认证写一次 last_used_at');
  const first = env.row('ci').last_used_at;
  assert.notEqual(first, null);

  assert.equal((await req(env.base, { authz: bearer })).status, 200);
  await env.settle();
  assert.equal(touched(), 2, '第 2 次认证仍触达节流判定（路由在 seam）');
  assert.equal(env.row('ci').last_used_at, first, '但 5 分钟窗口内不再真写');

  env.row('ci').last_used_at = new Date(Date.now() - 6 * 60 * 1000); // 拨回窗口外
  assert.equal((await req(env.base, { authz: bearer })).status, 200);
  await env.settle();
  assert.equal(touched(), 3);
  const third = env.row('ci').last_used_at;
  assert.notEqual(third, first, '窗口外应真写');
  assert.ok(new Date(third) > new Date(first));
  await env.close();
});

// ⑪ 跨用户吊销 ⇒ 404，且不误吊销目标令牌。
test('⑪ 跨用户吊销 ⇒ 404 且不误伤他人令牌', async () => {
  const env = await harness();
  const rootMint = await env.mint('root', 'root', { name: 'root-token' });
  assert.equal(rootMint.status, 201, rootMint.text);
  const cross = await env.revoke('root', 'eric', rootMint.json.id);
  assert.equal(cross.status, 404);
  assert.equal(cross.json.error.code, 'not_found');
  assert.equal(env.row('root-token').revoked_at, null, '别人的令牌不该被顺手动到');
  assert.equal(env.row('root-token').user_id, 'u-root');
  await env.close();
});

// ⑫ 审计：create/revoke 各一次且只含 {token_id,name,user}，无 hash/明文；
// 列表零审计。
test('⑫ 审计不含 hash/明文，列表不审计', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'audit-ci' });
  const { id, token } = mint.json;
  const hash = apiTokens.hashApiToken(token);

  assert.equal((await req(env.base, { authz: `Bearer ${token}` })).status, 200);
  await env.settle();
  assert.equal((await env.list('root', 'eric')).status, 200);
  const revoke = await env.revoke('root', 'eric', id);
  assert.equal(revoke.status, 200);

  const created = env.pool.audit.filter((a) => a.action === 'auth.token_created');
  const revoked = env.pool.audit.filter((a) => a.action === 'auth.token_revoked');
  assert.equal(created.length, 1, '签发恰记一次');
  assert.equal(revoked.length, 1, '吊销恰记一次');
  assert.equal((await env.list('root', 'eric')).status, 200);
  const tokenAudit = env.pool.audit.filter((a) => a.action.startsWith('auth.token_'));
  assert.equal(tokenAudit.length, 2, '列表不审计');

  for (const entry of [...created, ...revoked]) {
    const dump = JSON.stringify(entry);
    assert.ok(dump.includes(String(id)), '记 token_id');
    assert.ok(dump.includes('audit-ci'), '记 name');
    assert.ok(dump.includes('eric'), '记 user');
    assert.ok(!dump.includes(token), `审计绝不含明文: ${dump}`);
    assert.ok(!dump.includes(hash), `审计绝不含 hash: ${dump}`);
    assert.ok(!dump.includes('token_hash'));
  }
  assert.equal(created[0].actor_id, 'u-root', '审计记的是签发者（admin）');
  await env.close();
});

// ⑬ 同 (user,name) 重名 ⇒ 409；吊销后同名仍 409（不删行 ⇒ 不释放名字）。
test('⑬ 重名 409；吊销后同名仍 409', async () => {
  const env = await harness();
  const first = await env.mint('root', 'eric', { name: 'ci' });
  assert.equal(first.status, 201);
  const dup = await env.mint('root', 'eric', { name: 'ci' });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.error.code, 'token_name_taken');

  const rev = await env.revoke('root', 'eric', first.json.id);
  assert.equal(rev.status, 200);
  const afterRevoke = await env.mint('root', 'eric', { name: 'ci' });
  assert.equal(afterRevoke.status, 409, 'UNIQUE(user_id,name) 含已吊销行');
  assert.equal(env.pool.apiTokens.length, 1, '被拒的签发不落第二行');

  // 对照：不重名可在已吊销同名旁签（UNIQUE 只卡名字不卡账号）。
  const other = await env.mint('root', 'eric', { name: 'ci-2' });
  assert.equal(other.status, 201);
  await env.close();
});

// ⑭（设计点 12）登出守卫：Bearer ⇒ 400 且令牌仍活着；cookie ⇒ 204 照旧
// （配对断言防「守卫写反」的变异）。
test('⑭ 登出对 Bearer 400、对 cookie 204', async () => {
  const env = await harness();
  const mint = await env.mint('root', 'eric', { name: 'ci' });
  const bearer = `Bearer ${mint.json.token}`;

  const bad = await req(env.base, {
    method: 'POST', pathname: '/api/auth/logout', authz: bearer,
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'logout_not_applicable_for_tokens');
  assert.equal(env.row('ci').revoked_at, null, '登出尝试不该把令牌吊销');
  assert.equal((await req(env.base, { authz: bearer })).status, 200, '令牌仍可用');

  const ok = await req(env.base, {
    method: 'POST', pathname: '/api/auth/logout', cookie: env.cookies.eric,
  });
  assert.equal(ok.status, 204);
  await env.close();
});

// ⑮（工单动机本体）：开了邮箱验证码的账号**从不登录**也能用 API——
// 口令步一封都不寄（记录型发信器在场），且名下零会话。
test('⑮ 邮箱码账号用令牌：零邮件、零会话', async () => {
  const mailOtpUser = await makeUser({ id: 'u-bob', login: 'bob', mailOtp: true });
  const env = await harness({ logins: ['root', 'eric'], extraUsers: [mailOtpUser] });
  assert.equal(env.provider.sent.length, 0, 'bob 没登录过，口令步一封都没寄');

  const mint = await env.mint('root', 'bob', { name: 'agent' });
  assert.equal(mint.status, 201, mint.text);
  const res = await req(env.base, { authz: `Bearer ${mint.json.token}` });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.login, 'bob');
  assert.equal(env.provider.sent.length, 0, '令牌路径全程零发信');
  const bobSessions = env.pool.sessions.filter((s) => s.user_id === 'u-bob');
  assert.deepEqual(bobSessions, [], 'bob 名下无会话');
  await env.close();
});
