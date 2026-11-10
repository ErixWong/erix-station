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
//   ⑬ 二选一的 HTTP 响应逐字段 + 懒发信（status / methods / email_deferred / email_hint / expires_in；第一步零发信）
//   ⑭ 邮件通道不可用（未启用 / 发信限流占满）⇒ 200 降级仅 TOTP（绝不 503），且同一 pending_token 仍能过 /login/totp 建会话
//   ⑮ 同一 pending_token 单次消费：任一路径先成功后，另一路径 401 pending_expired
//   ⑯ 审计 method 三值各自可达且不串：totp / email_code / email_code_alt

import test, { after } from 'node:test';
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

async function makeUser({
  id = 'u1', login = 'alice', email = 'alice@example.com', totpSecret = null,
  mailOtpEnabled = true, totpLoginEnabled = true,
} = {}) {
  return {
    id,
    login,
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
    // feat-261110-02（迁移 0030）：「允许用 TOTP 登录」。默认 **true** = 该列的 DEFAULT，
    // 于是这个文件里所有既有用例（都没声明这一位）跑的就是升级后的存量形态：绑了就能用。
    totp_login_enabled: totpLoginEnabled,
  };
}

async function startServer({ users = [], mailer, loginEmailCodeOverrides = {}, emailSendRateLimit } = {}) {
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
    // #449 尾巴：「发信限流当下被占满」是二选一降级的那条预检判据，测试要能把这把闸单独调小。
    ...(emailSendRateLimit ? { emailSendRateLimit } : {}),
  };
  const pool = new FakePool({ users });
  const provider = fakeProvider(mailer);
  const server = createServer({ pool, config, mailerProvider: provider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  openServers.add(server); // 见上面的注册表注释：断言抛了也没人 close ⇒ 事件循环永不空
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    pool,
    config,
    base,
    close: () => closeServer(server),
  };
}

/**
 * 收摊一台服务器：先掐掉连接（含 fetch 的 keep-alive），否则 `close()` 会一直等不到回调。
 * 幂等（重复调用 / 已关掉都不抛）。
 */
async function closeServer(server) {
  openServers.delete(server);
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}

/**
 * **每个**开出来的 server 都登记在这里，`after` 一律收摊。
 * 为什么必须有：`choiceWithDisabledSmtp` / `choiceWithSaturatedSendLimiter` 这类夹具 helper 是
 * 「先开 server 再断言」的（夹具自己也要自证非空操作），而断言一抛就轮不到调用方的 `finally`
 * ⇒ server 泄漏 ⇒ `node --test` 跑完全部用例后事件循环仍不空 ⇒ **进程挂到超时才被杀**
 * （实测：变异把红打出来之后仍然挂满 300s，rc=124）。绿灯时看不出来，红灯时才要命。
 */
const openServers = new Set();
after(async () => {
  for (const server of [...openServers]) await closeServer(server);
});

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

/**
 * 懒发信（工单 feat-261110-01）之后的「拿一枚可用的码」：`second_factor_choice` 第一步**不发**，
 * 第一封由 resend 端点发出（= 前端 `switchFactor('email')` 走的那一步）。
 * 直发分支（`email_code_required`）第一步已经发过 ⇒ 不多调一次端点（否则白吃 60s 冷却）。
 */
async function emailCodeAt(base, body, state) {
  if (body.email_deferred === true) {
    const res = await postJson(base, '/api/auth/login/email-code/resend', { pending_token: body.pending_token });
    assert.equal(res.status, 200, '切到邮箱档时第一封必须发得出去');
  }
  return lastCode(state);
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
    // #472 片 A：登录响应的 user DTO 新增 `file_upload_enabled`（四条路径共用的构造点），
    // 键集因此多一项 —— 这一行就是「新增键必须同时改这条用例」的那一处（方案 A3 的注释）。
    assert.deepEqual(Object.keys(body.user).sort(), ['auth_source', 'display_name', 'fde_name', 'file_upload_enabled', 'id', 'login', 'role']);

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

// feat-261110-02：第二因素选择多了一维 —— `totp_login_enabled`（迁移 0030）。
// 「**绑过 TOTP**」与「**登录允许用 TOTP**」以前是同一位，于是「密钥留着、登录只走邮箱码」
// 在界面上根本表达不出来（想改只能重绑或删密钥）。这张表就是新语义的完整判据：
// 六行逐行一条，且**每一行都必须与工单表一致**（少一行 = 有一格没人钉）。
test('#449⑫c chooseSecondFactor：`totp_login_enabled` 那一维（迁移 0030，六行表逐行）', () => {
  const E = 'alice@example.com';
  const rows = [
    // [TOTP 已绑定, 允许 TOTP, 允许邮件码, 邮箱, 期望, 这一行钉的是哪一格]
    [false, undefined, false, E, 'password_direct_no_second_factor', '没绑、也没邮件码 ⇒ 口令直通（现状）'],
    [false, undefined, true, E, 'email_code_required', '没绑 + 邮件码 ⇒ email_code_required（现状）'],
    [true, true, false, E, 'totp_required', '绑了 + 允许 + 邮件码关 ⇒ totp_required（现状）'],
    // ★ 本单的新语义：密钥在（`totp_secret` 一字未动），但登录不碰它。
    [true, false, true, E, 'email_code_required', '绑了 + **不允许** + 邮件码开 ⇒ 邮箱码，密钥保留'],
    [true, true, true, E, 'second_factor_choice', '绑了 + 允许 + 邮件码开 ⇒ 二选一（现状）'],
    // ★ 另一格新语义：绑了 TOTP 却两条都不允许 ⇒ 真的只剩口令（管理台要红字警告的就是这一格）。
    [true, false, false, E, 'password_direct_no_second_factor', '绑了 + 两条都不允许 ⇒ 只剩口令'],
    // 边界：允许邮件码却没邮箱 ⇒ 409（与 TOTP 绑没绑无关，绝不静默退回口令）。
    [true, false, true, null, 'email_not_registered', '不允许 TOTP + 允许邮件码 + 没邮箱 ⇒ 409，不静默降级'],
    [true, false, true, '   ', 'email_not_registered', '空白邮箱同样算没登记'],
    // 兼容位：**不传** `totpLoginEnabled`（旧调用 / 缺键的旧响应）必须完全等于今天的形状。
    [true, undefined, false, E, 'totp_required', '缺参按 true ⇒ 存量 TOTP 用户行为一字不变'],
    [true, undefined, true, E, 'second_factor_choice', '缺参按 true ⇒ 二选一照旧'],
  ];
  for (const [hasTotpEnrollment, totpLoginEnabled, mailOtpEnabled, email, expected, why] of rows) {
    assert.equal(
      loginEmailCode.chooseSecondFactor({ hasTotpEnrollment, totpLoginEnabled, mailOtpEnabled, email }),
      expected,
      why,
    );
  }
  // `null` 也当「没读到」⇒ true（真库 NOT NULL，但 fake/旧 DTO 会给 null；这里不赌）
  assert.equal(
    loginEmailCode.chooseSecondFactor({ hasTotpEnrollment: true, totpLoginEnabled: null, mailOtpEnabled: false, email: E }),
    'totp_required',
    'null ≠ 被关掉',
  );
  // 只有**显式 false** 才算关掉（真值性折叠会把 `'f'` / `0` 当成关，那是另一种错）
  assert.equal(
    loginEmailCode.chooseSecondFactor({ hasTotpEnrollment: true, totpLoginEnabled: 'false', mailOtpEnabled: false, email: E }),
    'totp_required',
    '非布尔的假值不许当「管理员关掉了」',
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
//    懒发信（工单 feat-261110-01）：第一步**一封都不发**，第一封由「切到邮箱档」时的 resend 端点发出。
// ---------------------------------------------------------------------------

test('#449⑬ 已绑 TOTP + 开关开 + 有邮箱 ⇒ second_factor_choice，响应逐字段 + 第一步零发信', async () => {
  const { mailer, state } = fakeMailer();
  const secret = totp.generateSecret(20);
  const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      Object.keys(body).sort(),
      // 2026-11-10 新增 `email_code_ttl_seconds`（登录页「N 分钟内有效」的唯一来源）。
      ['email_code_ttl_seconds', 'email_deferred', 'email_hint', 'expires_in', 'methods', 'pending_token', 'status'],
      '响应字段就是懒发信那一组（不带 email_sent / email_unavailable / notice）',
    );
    assert.equal(body.status, 'second_factor_choice', '不再是 totp_required（否则开关是死开关）');
    assert.deepEqual(body.methods, ['totp', 'email_code']);
    assert.equal(body.email_deferred, true, '明示「这条路可走，但码还没发」');
    // 「还没发」用**缺席**表达，不许与「不可用」的 `email_sent:false` 混为一谈：前端的不可用判据是
    // `email_sent === false || email_unavailable === true`，这里带上 `email_sent` 任意一个值都会让
    // 邮箱档在第一步就被剥掉 ⇒ 二选一在界面上依旧不存在（正是本单要修的那个缺陷）。
    assert.ok(!('email_sent' in body), '懒发信不得带 `email_sent` 键');
    assert.equal(body.email_hint, maskEmail('alice@example.com'), 'hint 走既有脱敏');
    assert.ok(!JSON.stringify(body).includes('alice@example.com'), '响应不泄露完整邮箱');
    assert.equal(body.expires_in, 600, 'expires_in = max(pendingTokenTtlSeconds 120, EMAIL_CODE_TTL 600)');
    assert.ok(typeof body.pending_token === 'string' && body.pending_token.startsWith('pt_'));

    // 本单第一判据：**第一步一封都不发**。
    assert.equal(state.sent.length, 0, '懒发信：`mailer.send` 调用次数必须为 0');
    assert.equal(s.pool.emailCodes.length, 0, '零发信 ⇒ 零码行（不给用户一枚库里不存在的码）');
    assert.ok(
      !s.pool.audit.some((a) => a.action === 'auth.email_code_sent'),
      '没发信就不许写 auth.email_code_sent 审计',
    );
    assert.ok(
      !s.pool.audit.some((a) => a.action === 'auth.email_code_failed'),
      '什么都没尝试过 ⇒ 也不许写失败审计（假账）',
    );
    assert.equal(s.pool.pending.length, 1, '两条路共用一枚 pending：它照样要建');
    assert.equal(s.pool.sessions.length, 0, '第一步不建会话');
    assert.ok(!res.headers.get('set-cookie'), '第一步不下发会话 cookie');

    // 懒发信的落地：切到邮箱档 ⇒ 调既有 resend 端点发**第一封**（零码行 = 首次发信，不吃 60s 冷却）。
    const resent = await postJson(s.base, '/api/auth/login/email-code/resend', {
      pending_token: body.pending_token,
    });
    assert.equal(resent.status, 200, await resent.clone().text());
    assert.equal(state.sent.length, 1, '第一封由 resend 端点发出');
    assert.equal(s.pool.emailCodes.length, 1, '切过来才落码行');
    const verified = await postJson(s.base, '/api/auth/login/email-code', {
      pending_token: body.pending_token,
      code: lastCode(state),
    });
    assert.equal(verified.status, 200, '懒发出去的码必须能用');
  } finally {
    await s.close();
  }
});

// ⑬b 回归锁：懒发信只改**二选一**分支。无 TOTP 的 `email_code_required`（邮件码是唯一第二因素）
// 必须仍在第一步就发信，否则那个人根本拿不到码。
test('#449⑬b 回归锁：无 TOTP 的 email_code_required 仍然第一步就发信', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser({ totpSecret: null })], mailer });
  try {
    const body = await (await login(s.base)).json();
    assert.equal(body.status, 'email_code_required');
    assert.equal(state.sent.length, 1, '这一条不是懒发信：第一步必须发信');
    assert.equal(s.pool.emailCodes.length, 1);
    assert.ok(s.pool.audit.some((a) => a.action === 'auth.email_code_sent'), '发信审计仍在册');
    assert.ok(!('email_deferred' in body), '直发分支不沾 email_deferred');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑭ 邮件通道当下不可用 ⇒ 200 降级「仅 TOTP」，同一 pending_token 仍能靠 TOTP 进门（本单最重要判据）
// 懒发信之后，「不可用」只剩两个**能在第一步预判**的来源：SMTP 未启用 / 发信限流被占满。
// ---------------------------------------------------------------------------

async function choiceWithDisabledSmtp() {
  const { mailer, state } = fakeMailer({ enabled: false }); // 「未配置 / 急停」
  const secret = totp.generateSecret(20);
  const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
  return { s, state, secret, sentBaseline: 0, codeRowsBaseline: 0 };
}

/** 发信限流被占满：把闸调到 1 次/窗口，再用一次**真发信**（无 TOTP 账号的 §2.3a）把它烧掉。 */
async function choiceWithSaturatedSendLimiter() {
  const { mailer, state } = fakeMailer();
  const secret = totp.generateSecret(20);
  const s = await startServer({
    users: [
      await makeUser({ totpSecret: secret }),
      await makeUser({ id: 'u2', login: 'bob', totpSecret: null }),
    ],
    mailer,
    emailSendRateLimit: { maxFailures: 1, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 100 },
  });
  const bob = await login(s.base, { login: 'bob', password: PASSWORD });
  assert.equal(bob.status, 200, '夹具：bob 走 §2.3a，第一步真发一封 ⇒ 烧掉那唯一的配额');
  assert.equal(state.sent.length, 1, '夹具：那封信真的发出去了（才会 recordFailure）');
  // 下面那条用例断言的是「alice 第一步的**增量**为零发信」，所以把夹具那封记成基线。
  return { s, state, secret, sentBaseline: state.sent.length, codeRowsBaseline: s.pool.emailCodes.length };
}

for (const [label, make] of [
  ['SMTP 未启用（enabled=false）', choiceWithDisabledSmtp],
  ['发信限流被占满（email:<ip> 预检不允许）', choiceWithSaturatedSendLimiter],
]) {
  test(`#449⑭ 邮件通道不可用（${label}）⇒ 200 + methods:['totp'] + email_sent:false，TOTP 仍能登录`, async () => {
    const { s, state, secret, sentBaseline, codeRowsBaseline } = await make();
    try {
      const res = await login(s.base);
      assert.equal(res.status, 200, '绝不 503 / 500：TOTP 是离线可用的强因素');
      const body = await res.json();
      assert.equal(body.status, 'second_factor_choice');
      assert.deepEqual(body.methods, ['totp'], '邮件路不可用 ⇒ methods 只剩 totp');
      assert.equal(body.email_sent, false);
      assert.equal(body.email_unavailable, true);
      assert.ok(typeof body.notice === 'string' && body.notice.length > 0, '给人一句可读说明');
      assert.ok(!('email_deferred' in body), '不可用那条不沾 email_deferred（两者必须分得开）');
      assert.equal(state.sent.length, sentBaseline, '懒发信：降级路径同样零发信（夹具那封不算）');
      assert.equal(s.pool.emailCodes.length, codeRowsBaseline, '没发出去就不落码行（夹具那行不算）');
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
// ⑭b 懒发信的已知代价：「SMTP 配了但当下发不出去」在第一步**看不出来**（不再试发），所以那条
// 仍给两条通道 + `email_deferred`，失败推迟到切过去发第一封时（503 email_send_failed）。
// 本用例钉住这个取舍，别让后来人把「第一步不降级」当成回归。
// ---------------------------------------------------------------------------

test('#449⑭b SMTP 名义启用但当下发不出去 ⇒ 第一步仍给两条（deferred），切到邮箱档才暴露为 503', async () => {
  const { mailer, state } = fakeMailer();
  state.fail = true; // enabled=true + 当下发不出去（smtp_unreachable）
  const secret = totp.generateSecret(20);
  const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
  try {
    const body = await (await login(s.base)).json();
    assert.deepEqual(body.methods, ['totp', 'email_code'], '第一步不试发 ⇒ 预检不出来，照旧给两条');
    assert.equal(body.email_deferred, true);
    assert.equal(state.sent.length, 0);

    // 切到邮箱档 ⇒ resend 发第一封 ⇒ 此时才 503（pending 不作废，前端的「重新发送」路径接得住）。
    const resend = await postJson(s.base, '/api/auth/login/email-code/resend', {
      pending_token: body.pending_token,
    });
    assert.equal(resend.status, 503);
    assert.equal((await resend.json()).error.code, 'email_send_failed');
    // TOTP 完全不受影响（同一枚 pending）。
    const totpRes = await postJson(s.base, '/api/auth/login/totp', {
      pending_token: body.pending_token,
      code: totp.totp(secret),
    });
    assert.equal(totpRes.status, 200, 'SMTP 当下坏了不得影响 TOTP 第二步');
  } finally {
    await s.close();
  }
});

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
      const code = await emailCodeAt(s.base, body, state);
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
      const code = await emailCodeAt(s.base, body, state);
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

async function loginMethodOf({ totpSecret, use, totpLoginEnabled = true, mailOtpEnabled = true }) {
  const { mailer, state } = fakeMailer();
  const s = await startServer({
    users: [await makeUser({ totpSecret, totpLoginEnabled, mailOtpEnabled })],
    mailer,
  });
  try {
    const body = await (await login(s.base)).json();
    if (use === 'totp') {
      const res = await postJson(s.base, '/api/auth/login/totp', {
        pending_token: body.pending_token,
        code: totp.totp(totpSecret),
      });
      assert.equal(res.status, 200);
    } else {
      // 懒发信（feat-261110-01）：二选一分支的码要「切到邮箱档」（resend）才发得出来。
      const code = await emailCodeAt(s.base, body, state);
      const res = await postJson(s.base, '/api/auth/login/email-code', {
        pending_token: body.pending_token,
        code,
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

// feat-261110-02：把六行表里最要紧的两格推到 HTTP 层 —— 纯函数对了不等于接线对了。
// 只测纯函数的话，`http.js` 漏传 `totpLoginEnabled` 会绿着一片过去（前端勾了、服务端照旧走 TOTP，
// 而界面上写着「已保存」），所以这一条必须走真端点。
test('#449⑯b `totp_login_enabled:false` ⇒ 第一步真的给 email_code_required，审计记 email_code（不是 alt）', async () => {
  const secret = totp.generateSecret(20);

  // ① 绑了 TOTP 但不允许 ⇒ 第一步**不再**给二选一，也**不再**要 TOTP
  const off = await loginMethodOf({ totpSecret: secret, use: 'email_code', totpLoginEnabled: false });
  assert.equal(off.body.status, 'email_code_required',
    '关掉之后走的是「唯一第二因素 = 邮箱码」那条，不是二选一');
  assert.notEqual(off.body.status, 'second_factor_choice', '不许还给两条路（那等于勾选框没生效）');
  assert.equal(off.method, 'email_code',
    '这一格里邮件码是**唯一**被允许的第二因素，没有「放弃更强的那条」可言 ⇒ 不能记 alt');

  // ② 允许（现状）⇒ 仍是二选一 + `email_code_alt`（上面 ⑯ 已钉，这里只补一句对照）
  const on = await loginMethodOf({ totpSecret: secret, use: 'email_code', totpLoginEnabled: true });
  assert.equal(on.body.status, 'second_factor_choice');
  assert.equal(on.method, 'email_code_alt', '把 TOTP 留着可用时，口径一字不变');

  // ③ 绑了 TOTP、两条都不允许 ⇒ 口令直通（红字警告对应的那一格）
  const { mailer, state } = fakeMailer();
  const s = await startServer({
    users: [await makeUser({ totpSecret: secret, totpLoginEnabled: false, mailOtpEnabled: false })],
    mailer,
  });
  try {
    const body = await (await login(s.base)).json();
    assert.equal(body.status, 'authenticated', '两条都不允许 ⇒ 口令直通');
    const audits = s.pool.audit.filter((a) => a.action === 'auth.login_success');
    assert.equal(JSON.parse(audits[0].details).method, 'password_direct_no_second_factor',
      '审计必须说「这次没有第二因素」，别让人以为过了 TOTP');
    assert.equal(state.sent.length, 0, '口令直通不该发信');
  } finally {
    await s.close();
  }
});

test('#449⑯c 关掉 TOTP 登录**不清密钥**：`hasTotpEnrollment` 仍为真，再打开就回到二选一', async () => {
  const secret = totp.generateSecret(20);
  const u = await makeUser({ totpSecret: secret, totpLoginEnabled: false });
  // 这一位只是「允许/不允许」，`totp_secret` 一个字节都没动 ⇒ 绑定状态照旧为真。
  assert.equal(await auth.hasTotpEnrollment(new FakePool({ users: [u] }), u.id), true,
    '关掉登录开关不得等于解绑（否则管理员一关就把用户的密钥丢了）');
  assert.equal(u.totp_secret, secret, '夹具层面复核：密钥列原样');
});

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

// ---------------------------------------------------------------------------
// ⑰⑱ 2026-11-10 用户要求：「验证码邮件请使用双语」+「10 分钟有效这个写到 web 页面上」。
// 两条都是**显示面**的判据，但落点不同：⑰ 在邮件正文（服务端拼串），⑱ 在登录页（前端渲染，
// 数字来自服务端的 `email_code_ttl_seconds`——前端写死 10 分钟会在 `EMAIL_CODE_TTL_SECONDS` 一改时变成谎话）。
// ---------------------------------------------------------------------------

test('#449⑰ 验证码邮件双语：中英各写一次同一个码与同一个有效期', async () => {
  const { mailer, state } = fakeMailer();
  const s = await startServer({ users: [await makeUser()], mailer });
  try {
    const res = await login(s.base);
    assert.equal(res.status, 200);
    await res.json();
    assert.equal(state.sent.length, 1);
    const mail = state.sent[0];
    const code = lastCode(state);

    assert.match(String(mail.subject), /登录验证码/, '主题里要有中文');
    assert.match(String(mail.subject), /Sign-in verification code/, '主题里要有英文（收件人未必读中文）');

    const text = String(mail.text);
    assert.ok(text.includes(`你的登录验证码是 ${code}，10 分钟内有效。`), `中文行缺码或有效期：${text}`);
    assert.ok(
      text.includes(`Your sign-in verification code is ${code}. It is valid for 10 minutes.`),
      `英文行缺码或有效期：${text}`,
    );
    // 两段安全提示也要双语：只有中文的「如非本人操作」对英文收件人是零信息。
    assert.ok(text.includes('如非本人操作'), '中文提示在');
    assert.ok(text.includes("If you didn't try to sign in"), '英文提示在');
  } finally {
    await s.close();
  }
});

test('#449⑱ email_code_ttl_seconds 随第一步下发，分钟数跟着 EMAIL_CODE_TTL_SECONDS 走（不写死 10）', async () => {
  // 默认 600s ⇒ 10 分钟。
  {
    const { mailer, state } = fakeMailer();
    const s = await startServer({ users: [await makeUser()], mailer });
    try {
      const body = await (await login(s.base)).json();
      assert.equal(body.status, 'email_code_required');
      assert.equal(body.email_code_ttl_seconds, 600, '登录页靠这个字段渲染「N 分钟内有效」');
      assert.match(String(state.sent[0].text), /10 分钟内有效/, '邮件正文与字段同源');
    } finally {
      await s.close();
    }
  }
  // 覆盖成 120s ⇒ 字段与邮件正文一起变成 2 分钟（这条就是「前端不许写死 10」的判据）。
  {
    const { mailer, state } = fakeMailer();
    const s = await startServer({
      users: [await makeUser()],
      mailer,
      loginEmailCodeOverrides: { ttlSeconds: 120 },
    });
    try {
      const body = await (await login(s.base)).json();
      assert.equal(body.email_code_ttl_seconds, 120);
      assert.match(String(state.sent[0].text), /2 分钟内有效/, '邮件正文跟着配置走');
      assert.match(String(state.sent[0].text), /valid for 2 minutes/, '英文行同样跟着配置走');
    } finally {
      await s.close();
    }
  }
  // 二选一分支（有 TOTP + 邮件开关）同样要带这个字段：登录页在两档之间切换时不能丢掉有效期。
  {
    const secret = totp.generateSecret(20);
    const { mailer } = fakeMailer();
    const s = await startServer({ users: [await makeUser({ totpSecret: secret })], mailer });
    try {
      const body = await (await login(s.base)).json();
      assert.equal(body.status, 'second_factor_choice');
      assert.equal(body.email_code_ttl_seconds, 600, '二选一也要带，否则切到邮箱档就没有那句话');
    } finally {
      await s.close();
    }
  }
  // 503（发信失败但 pending 已建）的 details 也要带：前端收下 pending 直接进第二步，同样要能写出有效期。
  {
    const { mailer, state } = fakeMailer();
    state.fail = true;
    const s = await startServer({ users: [await makeUser()], mailer });
    try {
      const res = await login(s.base);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error.details.email_code_ttl_seconds, 600);
    } finally {
      await s.close();
    }
  }
});
