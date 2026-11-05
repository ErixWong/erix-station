// issue #449 后端切片：登录第二因素「邮箱验证码」——HTTP 端到端（FakePool + fake mailer provider）。
//
// 判据来源：docs/api/portal.md §2.2（第二因素选择规则）/§2.3a/§2.3b、issue #449 决策 1~6。
// 隔离约定（docs/testing.md §2.1）：注入 fake pool + fake provider，不碰真实 DB / 真实 SMTP。
//
// 12 条判据（编号与工单 §3 对齐，每条都能被打红）：
//   ① 口令对 + 无 TOTP + 有邮箱 + 邮件通道启用 ⇒ email_code_required，码能通过 verifyEmailCode
//   ② 口令错 ⇒ 不发信、401 invalid_credentials
//   ③ 无邮箱 + 邮件通道启用 ⇒ 409 email_not_registered，且没有建会话
//   ④ 邮件通道未启用 ⇒ 现状 authenticated，审计 method=password_direct_no_second_factor
//   ⑤ 正确码 ⇒ 200 + cookie + password_change_required；同码重放 ⇒ 401
//   ⑥ 错码 5 次 ⇒ 第 6 次给正确码也 401；attempts 落库正确
//   ⑦ 过期 ⇒ 401 email_code_invalid（模块层 reason='expired'）
//   ⑧ 发信失败 ⇒ 503 email_send_failed，且同一 pending_token 还能重试成功
//   ⑨ 重发冷却 ⇒ 429 + Retry-After；重发成功后旧码失效、新码可用
//   ⑩ 审计三条在册，details 序列化后搜不到明文码（正向有 code_hash_prefix）
//   ⑪ 接线判据：ctx 里有 mailerProvider，登录路径读 ctx.mailerProvider.get()（防 #331「没人读的光纤」）
//   ⑫ 选择规则纯函数四分支参数化

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import * as loginEmailCode from '../src/login-email-code.js';
import { maskEmail } from '../src/mailer.js';
import { FakePool } from './fake-pool.js';

const PASSWORD = 'correct horse battery staple';
let passwordHashCache = null;
async function passwordHash() {
  if (!passwordHashCache) passwordHashCache = await auth.hashPassword(PASSWORD);
  return passwordHashCache;
}

/** fake 邮件端口：记录发出的邮件；`state.fail` 可切换成「SMTP 发不出去」。 */
function fakeMailer({ enabled = true } = {}) {
  const state = { enabled, sent: [], fail: false, reason: 'smtp_unreachable' };
  const mailer = {
    get enabled() {
      return state.enabled;
    },
    async send(message) {
      if (!state.enabled) return { ok: false, reason: 'disabled' };
      if (state.fail) return { ok: false, reason: state.reason };
      state.sent.push(message);
      return { ok: true };
    },
  };
  return { mailer, state };
}

/** `createServer({ mailerProvider })` 的形状（生产是 `createMailProvider`，本文件不测那一层）。 */
function fakeProvider(mailer) {
  return { get: async () => mailer, invalidate() {} };
}

async function makeUser({ email = 'alice@example.com', totpSecret = null } = {}) {
  return {
    id: 'u1',
    login: 'alice',
    display_name: 'Alice',
    role: 'fde',
    fde_name: 'alice',
    auth_source: 'local',
    status: 'active',
    email,
    password_hash: await passwordHash(),
    totp_secret: totpSecret,
    last_totp_step: null,
  };
}

async function startServer({ users = [], mailer, loginEmailCodeOverrides = {} } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-emailcode-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
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
    // 生产里 `config.mail` 来自 loadConfig（只有急停开关）；SMTP 参数在 DB。
    mail: { killSwitch: false },
    loginEmailCode: {
      ttlSeconds: 600,
      maxAttempts: 5,
      resendCooldownSeconds: 60,
      maxResends: 3,
      ...loginEmailCodeOverrides,
    },
  };
  const pool = new FakePool({ users });
  const provider = fakeProvider(mailer);
  const server = createServer({ pool, config, mailerProvider: provider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    pool,
    config,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(base, pathname, body, headers = {}) {
  return fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function login(base, body = { login: 'alice', password: PASSWORD }) {
  return postJson(base, '/api/auth/login', body);
}

/** 从 fake mailer 的最后一封邮件里取 6 位码（正文是唯一出现明文码的地方）。 */
function lastCode(state) {
  const mail = state.sent[state.sent.length - 1];
  assert.ok(mail, '应当至少发出一封邮件');
  const match = String(mail.text).match(/\b(\d{6})\b/);
  assert.ok(match, `邮件正文里应有 6 位码：${mail.text}`);
  return match[1];
}

// ---------------------------------------------------------------------------
// ① email_code_required + 码真的落库（hash）且可用
// ---------------------------------------------------------------------------

test('#449① 口令对 + 无 TOTP + 有邮箱 + 邮件通道启用 ⇒ email_code_required，发出的 6 位码可通过校验', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'email_code_required');
    assert.ok(body.pending_token.startsWith('pt_'), 'pending_token 前缀与 TOTP 路径一致');
    assert.equal(body.expires_in, 600, 'expires_in = max(pending 120s, 码 600s)');
    assert.equal(body.email_hint, 'a***@e***.com');
    assert.equal(res.headers.get('set-cookie'), null, '第二步没走完不得发会话');

    assert.equal(state.sent.length, 1, '恰发一封');
    assert.equal(state.sent[0].to, 'alice@example.com');
    assert.match(String(state.sent[0].subject), /验证码/);

    assert.equal(s.pool.emailCodes.length, 1, '库里恰一条码');
    assert.equal(s.pool.emailCodes[0].consumed_at, null);
    const code = lastCode(state);
    assert.equal(s.pool.emailCodes[0].code_hash, loginEmailCode.hashEmailCode(code), '落库的是 sha256(码)，不是明文');
    assert.notEqual(s.pool.emailCodes[0].code_hash, code);

    const verified = await loginEmailCode.verifyEmailCode(s.pool, {
      pendingTokenHash: auth.hashToken(body.pending_token),
      code,
    });
    assert.deepEqual(verified, { ok: true });
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ② 口令错：不发信
// ---------------------------------------------------------------------------

test('#449② 口令错 ⇒ 401 invalid_credentials，且一封邮件都不发', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const res = await login(s.base, { login: 'alice', password: 'wrong password' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'invalid_credentials');
    assert.equal(state.sent.length, 0, '口令都没过，不许发信');
    assert.equal(s.pool.emailCodes.length, 0);
    assert.equal(s.pool.pending.length, 0, '也不许建 pending');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 无邮箱：409，且绝不静默退回口令
// ---------------------------------------------------------------------------

test('#449③ 有邮件通道但账号无邮箱 ⇒ 409 email_not_registered，且没有建会话', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser({ email: null })], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'email_not_registered');
    assert.equal(body.error.retryable, false);
    assert.match(body.error.message, /管理员/, 'message 要给出路（联系管理员补录邮箱）');
    assert.equal(res.headers.get('set-cookie'), null, '绝不能退回口令直通');
    assert.equal(state.sent.length, 0);
    assert.equal(s.pool.sessions.length, 0, '没有建会话');
    assert.equal(s.pool.pending.length, 0);
    assert.equal(
      s.pool.audit.filter((a) => a.action === 'auth.login_success').length,
      0,
      '没登录成功就不该有成功审计',
    );
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 邮件通道未启用：现状 authenticated，审计 method 标明没有第二因素
// ---------------------------------------------------------------------------

test('#449④ 邮件通道未启用 ⇒ 现状 authenticated（口令直通），审计 method=password_direct_no_second_factor', async () => {
  const { mailer, state } = fakeMailer({ enabled: false });
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'authenticated');
    assert.equal(body.password_change_required, false);
    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie?.startsWith('fde_session_dev='), '直通分支发 cookie');
    assert.equal(state.sent.length, 0);
    assert.equal(s.pool.emailCodes.length, 0);

    const audits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
    assert.equal(audits.length, 1);
    const details = JSON.parse(audits[0].details);
    assert.equal(details.method, 'password_direct_no_second_factor');
    assert.ok(!JSON.stringify(details).includes(PASSWORD), '审计不含口令');
    assert.ok(!JSON.stringify(details).includes(setCookie.split('=')[1].split(';')[0]), '审计不含 session token');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ 正确码建会话；同码重放 401
// ---------------------------------------------------------------------------

test('#449⑤ 正确码 ⇒ 200 + Set-Cookie + password_change_required（布尔）；同码重放 ⇒ 401', async () => {
  const { mailer, state } = fakeMailer();
  const user = await makeUser();
  user.must_change_password = true;
  const s = await startServer({ users: [user], mailer });
  try {
    const step1 = await (await login(s.base)).json();
    const code = lastCode(state);

    const step2 = await postJson(s.base, '/api/auth/login/email-code', { pending_token: step1.pending_token, code });
    assert.equal(step2.status, 200, await step2.clone().text());
    const setCookie = step2.headers.get('set-cookie');
    assert.ok(setCookie?.startsWith('fde_session_dev='));
    const body = await step2.json();
    assert.equal(typeof body.password_change_required, 'boolean', '必须出现且是布尔（与 §2.3 同口径）');
    assert.equal(body.password_change_required, true, '受限账号的旗标要在发会话的那一刻带出去');
    assert.deepEqual(Object.keys(body.user).sort(), ['auth_source', 'display_name', 'fde_name', 'id', 'login', 'role']);

    const token = setCookie.split(';')[0].split('=')[1];
    const me = await fetch(`${s.base}/api/me`, { headers: { cookie: `fde_session_dev=${token}` } });
    assert.equal(me.status, 200, '拿到的 cookie 真的能用');

    // 同码重放：这一步先命中「pending 已被消费」（成功校验会原子消费 pending）⇒ 401 pending_expired
    // （§2.3a：pending 无效/已用/过期一律这个码；「码被消费」由 §2.3a 的 email_code_invalid 兜另一半）。
    const replay = await postJson(s.base, '/api/auth/login/email-code', { pending_token: step1.pending_token, code });
    assert.equal(replay.status, 401);
    assert.equal((await replay.json()).error.code, 'pending_expired');
    assert.equal(s.pool.sessions.length, 1, '重放不得再建第二个会话');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ 尝试上限：5 次错码后即使给正确码也 401
// ---------------------------------------------------------------------------

test('#449⑥ 错码 5 次 ⇒ 第 6 次即使给正确码也 401（码已作废）；attempts 落库正确', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const step1 = await (await login(s.base)).json();
    const code = lastCode(state);

    for (let i = 0; i < 5; i += 1) {
      const res = await postJson(s.base, '/api/auth/login/email-code', {
        pending_token: step1.pending_token,
        code: '000000',
      });
      assert.equal(res.status, 401, `第 ${i + 1} 次错码应 401`);
      assert.equal((await res.json()).error.code, 'email_code_invalid');
      assert.equal(s.pool.emailCodes[0].attempts, i + 1, `第 ${i + 1} 次后 attempts 应为 ${i + 1}`);
    }
    assert.ok(s.pool.emailCodes[0].consumed_at, '达到上限时同一条语句作废该码');

    const sixth = await postJson(s.base, '/api/auth/login/email-code', {
      pending_token: step1.pending_token,
      code,
    });
    assert.equal(sixth.status, 401, '码已作废，正确码也不再接受');
    const body = await sixth.json();
    assert.equal(body.error.code, 'email_code_invalid');
    assert.equal(s.pool.sessions.length, 0);

    // too_many_attempts 的 message 口径：正常路径下第 6 次命中 not_found（第 5 次就把码作废了），
    // 所以这里直接构造「attempts 已到上限但还没消费」的库态，钉住「message 要说清重走第一步」。
    const step2 = await (await login(s.base)).json();
    const code2 = lastCode(state);
    s.pool.emailCodes[s.pool.emailCodes.length - 1].attempts = 5;
    const exhausted = await postJson(s.base, '/api/auth/login/email-code', { pending_token: step2.pending_token, code: code2 });
    assert.equal(exhausted.status, 401);
    const exhaustedBody = await exhausted.json();
    assert.equal(exhaustedBody.error.code, 'email_code_invalid');
    assert.match(exhaustedBody.error.message, /重新登录/, 'too_many_attempts 的 message 要说清要重走第一步');
    assert.ok(s.pool.emailCodes[s.pool.emailCodes.length - 1].consumed_at, '用尽的码顺手作废（幂等）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦ 过期
// ---------------------------------------------------------------------------

test('#449⑦ 码过期 ⇒ 401 email_code_invalid（模块层 reason=expired）', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const step1 = await (await login(s.base)).json();
    const code = lastCode(state);

    // 模块层：把 now 推到 TTL 之后 ⇒ expired（不用 sleep）
    const expiredAt = new Date(Date.now() + 601 * 1000);
    const moduleResult = await loginEmailCode.verifyEmailCode(s.pool, {
      pendingTokenHash: auth.hashToken(step1.pending_token),
      code,
      now: expiredAt,
    });
    assert.deepEqual(moduleResult, { ok: false, reason: 'expired' });

    // HTTP 层：把库里的 expires_at 改到过去（handler 用的是 new Date()）
    s.pool.emailCodes[0].expires_at = new Date(Date.now() - 1000);
    const res = await postJson(s.base, '/api/auth/login/email-code', { pending_token: step1.pending_token, code });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'email_code_invalid', '文档 §2.3a：过期与码错同一个码');
    assert.equal(s.pool.emailCodes[0].consumed_at, null, '过期不写 consumed_at（只是时间过了）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑧ 发信失败：503，pending 保留，同一 token 重试成功
// ---------------------------------------------------------------------------

test('#449⑧ 发信失败 ⇒ 503 email_send_failed，且同一 pending_token 还能重试成功', async () => {
  const { mailer, state } = fakeMailer();
  state.fail = true;
  const s = await startServer({ users: [await makeUser()], mailer, loginEmailCodeOverrides: { resendCooldownSeconds: 0 } });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'email_send_failed');
    assert.equal(body.error.retryable, true);
    assert.equal(res.headers.get('set-cookie'), null);
    // 503 的 details 必须带回 pending_token：否则「pending 不作废、点重试即可」在协议上不成立
    const pendingToken = body.error.details?.pending_token;
    assert.ok(pendingToken?.startsWith('pt_'), '503 details 要带 pending_token（客户端才能重发）');
    assert.equal(body.error.details.email_hint, 'a***@e***.com');
    assert.equal(s.pool.pending.length, 1, 'pending 必须保留（用户不必重输口令）');
    assert.equal(s.pool.pending[0].used_at, null);
    assert.equal(state.sent.length, 0);
    assert.ok(
      s.pool.audit.some((a) => a.action === 'auth.email_code_failed'),
      '发信失败要留审计',
    );

    // 修好 SMTP 后重发同一 pending ⇒ 成功，且新码能用
    state.fail = false;
    const resent = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: pendingToken });
    assert.equal(resent.status, 200, await resent.clone().text());
    const code = lastCode(state);
    const verified = await postJson(s.base, '/api/auth/login/email-code', { pending_token: pendingToken, code });
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.ok(verified.headers.get('set-cookie'), '重试成功后发会话');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑨ 重发冷却 / 旧码失效 / 新码可用 / 次数上限
// ---------------------------------------------------------------------------

test('#449⑨ 重发冷却 ⇒ 429 + Retry-After；重发成功后旧码失效、新码可用', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const step1 = await (await login(s.base)).json();
    const oldCode = lastCode(state);

    const cooling = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: step1.pending_token });
    assert.equal(cooling.status, 429);
    assert.equal((await cooling.json()).error.code, 'rate_limited');
    assert.ok(Number(cooling.headers.get('retry-after')) > 0, '429 必须带 Retry-After（秒）');
    assert.equal(state.sent.length, 1, '冷却期内不发信');

    // 把最近一条码的 created_at 拨回 61s 前（不 sleep）
    s.pool.emailCodes[0].created_at = new Date(Date.now() - 61 * 1000);
    const resent = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: step1.pending_token });
    assert.equal(resent.status, 200, await resent.clone().text());
    const resentBody = await resent.json();
    assert.equal(resentBody.expires_in, 600);
    assert.equal(resentBody.resend_after, 60);
    assert.equal(state.sent.length, 2, '重发成功 ⇒ 第二封');

    const newCode = lastCode(state);
    assert.notEqual(newCode, oldCode, '重发必须换新码');
    assert.equal(s.pool.emailCodes.length, 2);
    assert.ok(s.pool.emailCodes[0].consumed_at, '旧码被作废（consumed_at 置上）');

    // 旧码：已不是「最新未消费」⇒ 按 mismatch 拒绝（旧行已消费，新行 hash 不同）
    const oldResult = await loginEmailCode.verifyEmailCode(s.pool, {
      pendingTokenHash: auth.hashToken(step1.pending_token),
      code: oldCode,
    });
    assert.equal(oldResult.ok, false);
    assert.equal(oldResult.reason, 'mismatch');

    const verified = await postJson(s.base, '/api/auth/login/email-code', {
      pending_token: step1.pending_token,
      code: newCode,
    });
    assert.equal(verified.status, 200, await verified.clone().text());
  } finally {
    await s.close();
  }
});

test('#449⑨b 重发次数上限 ⇒ 429 rate_limited（Retry-After 仍在）', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({
    users: [await makeUser()],
    mailer,
    loginEmailCodeOverrides: { resendCooldownSeconds: 0, maxResends: 2 },
  });
  try {
    const step1 = await (await login(s.base)).json();
    for (let i = 0; i < 2; i += 1) {
      const ok = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: step1.pending_token });
      assert.equal(ok.status, 200, `第 ${i + 1} 次重发应成功`);
      assert.equal(ok.headers.get('retry-after'), null);
    }
    const blocked = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: step1.pending_token });
    assert.equal(blocked.status, 429);
    const body = await blocked.json();
    assert.equal(body.error.code, 'rate_limited');
    assert.match(body.error.message, /重发次数/);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1, '429 必须带 Retry-After');
    assert.equal(state.sent.length, 3, '初始 1 封 + 2 次重发');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑩ 审计：三条在册，且序列化后搜不到明文码
// ---------------------------------------------------------------------------

test('#449⑩ 审计 email_code_sent / verified / failed 在册，details 里搜不到明文码', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer, loginEmailCodeOverrides: { resendCooldownSeconds: 0 } });
  try {
    const step1 = await (await login(s.base)).json();
    const code = lastCode(state);
    const verified = await postJson(s.base, '/api/auth/login/email-code', { pending_token: step1.pending_token, code });
    assert.equal(verified.status, 200);

    const actions = s.pool.audit.map((a) => a.action);
    assert.ok(actions.includes('auth.email_code_sent'), '发信审计在册');
    assert.ok(actions.includes('auth.email_code_verified'), '校验成功审计在册');
    assert.ok(actions.includes('auth.login_success'));

    const sentAudit = s.pool.audit.find((a) => a.action === 'auth.email_code_sent');
    const sentDetails = JSON.parse(sentAudit.details);
    assert.equal(sentDetails.code_hash_prefix, loginEmailCode.hashEmailCode(code).slice(0, 12), '正向：有 12 位哈希前缀');
    assert.equal(sentDetails.code_hash_prefix.length, 12);
    assert.equal(sentDetails.email_hint, 'a***@e***.com');
    assert.ok(sentDetails.expires_at);

    // 反向：整个审计表序列化后不含明文码（也不含邮件正文/口令）
    const serialized = JSON.stringify(s.pool.audit);
    assert.ok(!serialized.includes(code), `审计里出现了明文码 ${code}`);
    assert.ok(!serialized.includes(PASSWORD), '审计里出现口令');
    assert.ok(!serialized.includes('登录验证码是'), '审计里出现邮件正文');

    // 发信失败也要留一条（reason 摘要，不含正文）：SMTP 坏掉后重发 ⇒ 503 + email_code_failed
    const step2 = await (await login(s.base)).json();
    assert.equal(step2.status, 'email_code_required');
    state.fail = true;
    const failedLogin = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: step2.pending_token });
    assert.equal(failedLogin.status, 503);
    assert.equal((await failedLogin.json()).error.code, 'email_send_failed');
    const failedAudit = s.pool.audit.find((a) => a.action === 'auth.email_code_failed');
    assert.ok(failedAudit, '发信失败审计在册');
    const failedDetails = JSON.parse(failedAudit.details);
    assert.equal(failedDetails.reason, 'smtp_unreachable');
    assert.ok(!JSON.stringify(failedAudit).includes('登录验证码是'));
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑪ 接线判据（源码级）：ctx 有 mailerProvider，登录路径读它（防 #331「没人读的光纤」）
// ---------------------------------------------------------------------------

test('#449⑪ 接线：ctx 里挂了 mailerProvider，登录/重发路径都经 ctx.mailerProvider.get() 取端口', () => {
  const src = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');

  assert.match(src, /import \{ createMailProvider \} from '\.\/mail-provider\.js'/, 'http.js 必须真的引入 provider');
  const ctxStart = src.indexOf('const ctx = {');
  assert.notEqual(ctxStart, -1);
  const ctxBlock = src.slice(ctxStart, src.indexOf('};', ctxStart));
  assert.match(ctxBlock, /mailerProvider: mailProvider/, 'ctx 里必须有 mailerProvider（否则 handler 读不到）');
  assert.ok(!/ctx\.mailer\b/.test(src), '不许再留模块级/单例式的 ctx.mailer 旧形态');

  const loginStart = src.indexOf('async function handleLoginStep1');
  const loginEnd = src.indexOf('async function handleEmailCodeRequired');
  assert.ok(loginStart !== -1 && loginEnd > loginStart);
  const loginSrc = src.slice(loginStart, loginEnd);
  assert.match(loginSrc, /ctx\.mailerProvider\.get\(\)/, '登录路径必须从 provider 取端口（SMTP 参数在 DB）');
  assert.ok(!/createMailer\(/.test(loginSrc), '登录路径不得自己拼 SMTP 配置');

  const resendStart = src.indexOf('async function handleLoginEmailCodeResend');
  const resendEnd = src.indexOf('async function handleLoginTotp');
  const resendSrc = src.slice(resendStart, resendEnd);
  assert.match(resendSrc, /ctx\.mailerProvider\.get\(\)/, '重发路径同样走 provider');
});

// ---------------------------------------------------------------------------
// ⑫ 选择规则纯函数：四分支参数化
// ---------------------------------------------------------------------------

test('#449⑫ chooseSecondFactor：TOTP 优先 / 邮箱码 / 409 / 口令直通 四分支', () => {
  const cases = [
    // [hasTotp, mailEnabled, email, 期望]
    [true, true, 'alice@example.com', 'totp_required'],
    [true, false, 'alice@example.com', 'totp_required'],
    [true, true, null, 'totp_required'],
    [false, true, 'alice@example.com', 'email_code_required'],
    [false, true, '  a@b.c  ', 'email_code_required'],
    [false, true, null, 'email_not_registered'],
    [false, true, '', 'email_not_registered'],
    [false, true, '   ', 'email_not_registered'],
    [false, false, 'alice@example.com', 'password_direct_no_second_factor'],
    [false, false, null, 'password_direct_no_second_factor'],
  ];
  for (const [hasTotpEnrollment, mailEnabled, email, expected] of cases) {
    assert.equal(
      loginEmailCode.chooseSecondFactor({ hasTotpEnrollment, mailEnabled, email }),
      expected,
      `hasTotp=${hasTotpEnrollment} mail=${mailEnabled} email=${JSON.stringify(email)}`,
    );
  }
});

test('#449⑫b 6 位码生成与 email_hint 脱敏口径', () => {
  assert.equal(loginEmailCode.generateEmailCode({ random: () => 0 }), '000000', '左补零');
  assert.equal(loginEmailCode.generateEmailCode({ random: () => 999_999 }), '999999');
  assert.equal(loginEmailCode.generateEmailCode({ random: () => 42 }), '000042');
  assert.throws(() => loginEmailCode.generateEmailCode({ random: () => 1_000_000 }), /RangeError|必须返回/, '越界不许静默发出 000000');

  assert.equal(maskEmail('alice@example.com'), 'a***@e***.com');
  assert.equal(maskEmail('a@ex.com'), 'a***@e***.com');
  assert.equal(maskEmail('bob@mail.example.co.uk'), 'b***@m***.example.co.uk');
  assert.equal(maskEmail('not-an-email'), '***');
  assert.equal(maskEmail(null), '***');
});
