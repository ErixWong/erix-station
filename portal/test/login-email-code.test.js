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
//   ⑫ 选择规则纯函数五分支参数化（#449 二选一）
//   ⑬ 二选一的 HTTP 响应逐字段（status / methods / email_sent / email_hint / expires_in）
//   ⑭ SMTP 不可用 ⇒ 200 降级仅 TOTP（绝不 503），且同一 pending_token 仍能过 /login/totp 建会话
//   ⑮ 同一 pending_token 单次消费：任一路径先成功后，另一路径 401 pending_expired
//   ⑯ 审计 method 三值各自可达且不串：totp / email_code / email_code_alt

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
import * as totp from '../src/totp.js';
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

async function makeUser({ email = 'alice@example.com', totpSecret = null, mailOtpEnabled = true } = {}) {
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
    // 2026-11-06：per-user 邮件验证码开关（迁移 0028）现在是**唯一**判据 ⇒ 夹具默认开，
    // 否则这个文件里所有「走邮箱码」的用例都会退化成口令直通（那是夹具问题，不是产品行为）。
    mail_otp_enabled: mailOtpEnabled,
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

// 2026-11-06 口径变更：判据从「全局 transport 开没开」变成「**per-user 开关**开没开」（迁移 0028）。
// 全局 transport 退化成 SMTP 连接配置，不再是否决条件 —— 下面两条分别钉这两半。
test('#449④ per-user 开关关闭 ⇒ 口令直通（审计 method=password_direct_no_second_factor）', async () => {
  const { mailer, state } = fakeMailer({ enabled: true });
  const s = await startServer({ users: [await makeUser({ mailOtpEnabled: false })], mailer });
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

test('#449④b per-user 开关打开但邮件通道不可用 ⇒ 503 email_channel_unavailable（**绝不静默降级到口令**）', async () => {
  // 这是「全局 transport 不再是功能闸」的代价：开关开着就必须能发信，发不了要明说，
  // 不能让用户以为自己过了第二因素（静默降级是安全洞）。
  const { mailer, state } = fakeMailer({ enabled: false });
  const s = await startServer({ users: [await makeUser({ mailOtpEnabled: true })], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.code, 'email_channel_unavailable');
    assert.equal(state.sent.length, 0);
    assert.equal(s.pool.emailCodes.length, 0, '没发信就不许留下码');
    assert.equal(res.headers.get('set-cookie'), null, '更不许发会话 cookie');
  } finally {
    await s.close();
  }
});

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

test('#449⑧ 发信失败 ⇒ 503 email_send_failed，**立刻**重发即成功（不吃 60s 冷却）', async () => {
  // ⚠ 本用例**不覆盖 `resendCooldownSeconds`**（生产默认 60s）：旧实现「先插码再发信」会让
  // 503 之后的重试撞上自己插的那行的 created_at ⇒ 429，本用例当场红（评审返修 ①）。
  const { mailer, state } = fakeMailer();
  state.fail = true;
  const s = await startServer({ users: [await makeUser()], mailer });
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
    // 顺序契约：发信失败时**库里一条码行都没有**（冷却起算点不该由「没收到的那封信」产生）
    assert.equal(s.pool.emailCodes.length, 0, '发信失败不得留下码行（否则重试被自己的 created_at 卡 60s）');
    assert.ok(
      s.pool.audit.some((a) => a.action === 'auth.email_code_failed'),
      '发信失败要留审计',
    );

    // 修好 SMTP 后**立刻**重发同一 pending ⇒ 成功（生产默认 60s 冷却不适用于「首次发信的重试」）
    state.fail = false;
    const resent = await postJson(s.base, '/api/auth/login/email-code/resend', { pending_token: pendingToken });
    assert.equal(resent.status, 200, await resent.clone().text());
    assert.equal(s.pool.emailCodes.length, 1, '重发成功后才落一行');
    const code = lastCode(state);
    const verified = await postJson(s.base, '/api/auth/login/email-code', { pending_token: pendingToken, code });
    assert.equal(verified.status, 200, await verified.clone().text());
    assert.ok(verified.headers.get('set-cookie'), '重试成功后发会话');
  } finally {
    await s.close();
  }
});

test('#449⑧b 初次发信也过发信限流（`email:<ip>` 同一把闸）：超限 ⇒ 429 且不发信', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    // 默认 20 次 / 15 分钟：第 21 次第一步必须被挡，且不产生第 21 封信 / 第 21 个 pending。
    const attempts = 20;
    for (let i = 0; i < attempts; i += 1) {
      const ok = await login(s.base);
      assert.equal(ok.status, 200, `第 ${i + 1} 次第一步应成功`);
    }
    const blocked = await login(s.base);
    assert.equal(blocked.status, 429, '初次发信必须与重发共用同一把闸');
    const body = await blocked.json();
    assert.equal(body.error.code, 'rate_limited');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0, '429 必须带 Retry-After');
    assert.equal(state.sent.length, attempts, '被挡的那次不发信');
    assert.equal(s.pool.pending.length, attempts, '被挡的那次也不留 pending');
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
// ⑬ 模块层重放保护：同一 pending + 同一码，第二次必须被拒（钉住成功分支 UPDATE 的谓词）
// ---------------------------------------------------------------------------

/**
 * 模拟「两个请求都在消费前读到了同一行」：第一次 SELECT 的结果缓存下来，后续 SELECT 原样回放。
 * 这样第二次 `verifyEmailCode` 一定会走到那条 `UPDATE … WHERE consumed_at IS NULL …`——
 * 少了谓词它就会**再消费一次并返回 ok:true**，用例当场红（纯串行调用测不到这一点：
 * 串行时第二次的 SELECT 已经查不到未消费行，走的是 `not_found` 短路）。
 */
class StaleReadPool extends FakePool {
  constructor(options) {
    super(options);
    this.cachedLatest = null;
    this.servedCache = 0;
  }

  async query(sql, params = []) {
    const isLatestUnconsumed = sql.includes('FROM login_email_codes')
      && sql.includes('pending_token_hash = $1 AND consumed_at IS NULL');
    if (!isLatestUnconsumed) return super.query(sql, params);
    if (this.cachedLatest) {
      this.servedCache += 1;
      return { rows: this.cachedLatest, rowCount: this.cachedLatest.length };
    }
    const result = await super.query(sql, params);
    this.cachedLatest = result.rows;
    return result;
  }
}

test('#449⑬ 模块层重放保护：同一 pending + 同一码，第二次 verifyEmailCode 必须 ok:false', async () => {
  const pendingTokenHash = 'a'.repeat(64);
  const code = '123456';

  // ① 串行（真实请求序列）：第二次连「未消费行」都查不到 ⇒ not_found。
  const serial = new FakePool({});
  await loginEmailCode.createEmailCode(serial, { pendingTokenHash, code, ttlSeconds: 600, maxAttempts: 5 });
  assert.deepEqual(await loginEmailCode.verifyEmailCode(serial, { pendingTokenHash, code }), { ok: true });
  const second = await loginEmailCode.verifyEmailCode(serial, { pendingTokenHash, code });
  assert.equal(second.ok, false, '同一枚码只能消费一次');
  assert.ok(serial.emailCodes[0].consumed_at, '第一次成功即写 consumed_at');

  // ② 并发（两个请求都在消费前读到同一行）：靠 UPDATE 的 `AND consumed_at IS NULL` 只放行一个。
  const racy = new StaleReadPool({});
  await loginEmailCode.createEmailCode(racy, { pendingTokenHash, code, ttlSeconds: 600, maxAttempts: 5 });
  const first = await loginEmailCode.verifyEmailCode(racy, { pendingTokenHash, code });
  const replay = await loginEmailCode.verifyEmailCode(racy, { pendingTokenHash, code });
  assert.equal(racy.servedCache >= 1, true, '第二次读必须走缓存回放（否则这条断言测不到 UPDATE 谓词）');
  assert.deepEqual(first, { ok: true });
  assert.deepEqual(replay, { ok: false, reason: 'not_found' }, '并发重放只能有一个成功（UPDATE 谓词）');
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

test('#449⑫ chooseSecondFactor：二选一 / TOTP 兼容 / 邮箱码 / 409 / 口令直通（判据是 per-user 开关）', () => {
  // 2026-11-06 口径变更（用户拍板）：**唯一的「用不用邮件码」判据是 per-user 开关**（迁移 0028）。
  // 全局 `transport` 只是 SMTP 连接配置，不再一票否决 —— 原来那一维会让开关变成死光纤。
  const cases = [
    // [hasTotp, mailOtpEnabled, email, 期望]
    // #449 二选一后首行变了：有 TOTP + 开关开 + 有邮箱 ⇒ `second_factor_choice`（不再是 totp_required）。
    [true, true, 'alice@example.com', 'second_factor_choice'],
    [true, false, 'alice@example.com', 'totp_required'],
    // 边界（工单 §六判据 1）：有 TOTP + 开关开但**没邮箱** ⇒ 仍走 totp_required，绝不挡在门外。
    [true, true, null, 'totp_required'],
    [true, true, '', 'totp_required'],
    [true, true, '   ', 'totp_required'],
    [false, true, 'alice@example.com', 'email_code_required'],
    [false, true, '  a@b.c  ', 'email_code_required'],
    [false, true, null, 'email_not_registered'],
    [false, true, '', 'email_not_registered'],
    [false, true, '   ', 'email_not_registered'],
    [false, false, 'alice@example.com', 'password_direct_no_second_factor'],
    [false, false, null, 'password_direct_no_second_factor'],
  ];
  for (const [hasTotpEnrollment, mailOtpEnabled, email, expected] of cases) {
    assert.equal(
      loginEmailCode.chooseSecondFactor({ hasTotpEnrollment, mailOtpEnabled, email }),
      expected,
      `hasTotp=${hasTotpEnrollment} mailOtp=${mailOtpEnabled} email=${JSON.stringify(email)}`,
    );
  }
  // 反向钉住：**传了 mailEnabled 也不该影响判定**（旧的全局维已经退场；留着它当判据就是死光纤）。
  assert.equal(
    loginEmailCode.chooseSecondFactor({ hasTotpEnrollment: false, mailOtpEnabled: true, mailEnabled: false, email: 'a@b.c' }),
    'email_code_required',
    '全局 transport 不再是否决条件',
  );
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

// ---------------------------------------------------------------------------
// ⑬ 二选一（#449）：TOTP 与邮箱码并存 ⇒ status='second_factor_choice'，两路共用一枚 pending_token
// ---------------------------------------------------------------------------

test('#449⑬ 已绑 TOTP + 开关开 + 有邮箱 ⇒ second_factor_choice，响应逐字段', async () => {
  const { mailer, state } = fakeMailer();
  const secret = totp.generateSecret(20);
  const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      Object.keys(body).sort(),
      ['email_hint', 'email_sent', 'expires_in', 'methods', 'pending_token', 'status'],
      '响应字段就是工单 §一.2 那一组（成功路径不带 email_unavailable/notice）',
    );
    assert.equal(body.status, 'second_factor_choice', '不再是 totp_required（否则开关是死开关）');
    assert.deepEqual(body.methods, ['totp', 'email_code']);
    assert.equal(body.email_sent, true);
    assert.equal(body.email_hint, maskEmail('alice@example.com'), 'hint 走既有脱敏');
    assert.ok(!JSON.stringify(body).includes('alice@example.com'), '响应不泄露完整邮箱');
    assert.equal(body.expires_in, 600, 'expires_in = max(pendingTokenTtlSeconds 120, EMAIL_CODE_TTL 600)');
    assert.ok(typeof body.pending_token === 'string' && body.pending_token.startsWith('pt_'));
    assert.equal(state.sent.length, 1, '恰好发出一封码（开关真发信，不是死开关）');
    assert.equal(s.pool.emailCodes.length, 1, '码行落库');
    assert.equal(s.pool.sessions.length, 0, '第一步不建会话');
    assert.ok(!res.headers.get('set-cookie'), '第一步不下发会话 cookie');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑭ SMTP 不可用 ⇒ 200 降级「仅 TOTP」，同一 pending_token 仍能靠 TOTP 进门（本单最重要判据）
// ---------------------------------------------------------------------------

async function choiceWithBrokenSmtp({ enabled }) {
  const { mailer, state } = fakeMailer({ enabled });
  // enabled=true 代「SMTP 配了但当下发不出去」（smtp_unreachable）；enabled=false 代「未配置 / 急停」。
  if (enabled) state.fail = true;
  const secret = totp.generateSecret(20);
  const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
  return { s, state, secret };
}

for (const [label, enabled] of [['SMTP 发信失败（smtp_unreachable）', true], ['SMTP 未配置（enabled=false）', false]]) {
  test(`#449⑭ SMTP 不可用（${label}）⇒ 200 + methods:['totp'] + email_sent:false，TOTP 仍能登录`, async () => {
    const { s, state, secret } = await choiceWithBrokenSmtp({ enabled });
    try {
      const res = await login(s.base);
      assert.equal(res.status, 200, '绝不 503 / 500：TOTP 是离线可用的强因素');
      const body = await res.json();
      assert.equal(body.status, 'second_factor_choice');
      assert.deepEqual(body.methods, ['totp'], '邮件路不可用 ⇒ methods 只剩 totp');
      assert.equal(body.email_sent, false);
      assert.equal(body.email_unavailable, true);
      assert.ok(typeof body.notice === 'string' && body.notice.length > 0, '给人一句可读说明');
      assert.equal(state.sent.length, 0);
      assert.equal(s.pool.emailCodes.length, 0, '没发出去就不落码行（不给用户一枚库里不存在的码）');
      assert.ok(s.pool.audit.some((a) => a.action === 'auth.email_code_failed'), '降级要留审计痕');

      // 同一枚 pending_token 必须还能过 TOTP —— 这条挂了就是「SMTP 抖一下，人登不进去」。
      const totpRes = await postJson(s.base, '/api/auth/login/totp', {
        pending_token: body.pending_token,
        code: totp.totp(secret),
      });
      assert.equal(totpRes.status, 200, 'SMTP 不可用不得影响 TOTP 第二步');
      assert.ok((totpRes.headers.get('set-cookie') ?? '').includes('fde_session_dev'));
      assert.equal(s.pool.sessions.length, 1);
      const loginAudits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
      assert.equal(JSON.parse(loginAudits[0].details).method, 'totp');
    } finally {
      await s.close();
    }
  });
}

// ---------------------------------------------------------------------------
// ⑮ 单次消费：两路共用一枚 pending_token，谁先成功谁建会话，另一条自然失效
// ---------------------------------------------------------------------------

test('#449⑮ 同一 pending_token：先 TOTP 成功 ⇒ 邮件码 401 pending_expired；反向同理', async () => {
  // 正向：TOTP 先成功。
  {
    const { mailer, state } = fakeMailer();
    const secret = totp.generateSecret(20);
    const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
    try {
      const body = await (await login(s.base)).json();
      const code = lastCode(state);
      const ok = await postJson(s.base, '/api/auth/login/totp', { pending_token: body.pending_token, code: totp.totp(secret) });
      assert.equal(ok.status, 200);
      const late = await postJson(s.base, '/api/auth/login/email-code', { pending_token: body.pending_token, code });
      assert.equal(late.status, 401);
      assert.equal((await late.json()).error.code, 'pending_expired');
      assert.equal(s.pool.sessions.length, 1, '只建了一次会话');
    } finally {
      await s.close();
    }
  }
  // 反向：邮件码先成功。
  {
    const { mailer, state } = fakeMailer();
    const secret = totp.generateSecret(20);
    const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
    try {
      const body = await (await login(s.base)).json();
      const code = lastCode(state);
      const ok = await postJson(s.base, '/api/auth/login/email-code', { pending_token: body.pending_token, code });
      assert.equal(ok.status, 200);
      const late = await postJson(s.base, '/api/auth/login/totp', { pending_token: body.pending_token, code: totp.totp(secret) });
      assert.equal(late.status, 401);
      assert.equal((await late.json()).error.code, 'pending_expired');
      assert.equal(s.pool.sessions.length, 1);
    } finally {
      await s.close();
    }
  }
});

// ---------------------------------------------------------------------------
// ⑯ 审计 method 三值：totp / email_code / email_code_alt 各自可达且互不串
// ---------------------------------------------------------------------------

async function loginMethodOf({ totpSecret, use }) {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser({ totpSecret })], mailer });
  try {
    const body = await (await login(s.base)).json();
    if (use === 'totp') {
      const res = await postJson(s.base, '/api/auth/login/totp', {
        pending_token: body.pending_token,
        code: totp.totp(totpSecret),
      });
      assert.equal(res.status, 200);
    } else {
      const res = await postJson(s.base, '/api/auth/login/email-code', {
        pending_token: body.pending_token,
        code: lastCode(state),
      });
      assert.equal(res.status, 200);
    }
    const audits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
    assert.equal(audits.length, 1);
    return { method: JSON.parse(audits[0].details).method, body };
  } finally {
    await s.close();
  }
}

test('#449⑯ 审计 method：有 TOTP 走邮件码 = email_code_alt；无 TOTP 走邮件码 = email_code；走 TOTP = totp', async () => {
  const secret = totp.generateSecret(20);

  const alt = await loginMethodOf({ totpSecret: secret, use: 'email_code' });
  assert.equal(alt.body.status, 'second_factor_choice');
  assert.equal(alt.method, 'email_code_alt', '有 TOTP 却用邮件码 ⇒ 运维必须查得到这条弱因素路径');

  const plain = await loginMethodOf({ totpSecret: null, use: 'email_code' });
  assert.equal(plain.body.status, 'email_code_required', '无 TOTP 仍是现状分支（回归面）');
  assert.equal(plain.method, 'email_code', '现状值不改');

  const totpWay = await loginMethodOf({ totpSecret: secret, use: 'totp' });
  assert.equal(totpWay.method, 'totp', '现状值不改');
});
