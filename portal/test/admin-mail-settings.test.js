// issue #449 管理台切片：邮件通道写侧 API（`/api/admin/mail/*`）——HTTP 端到端。
//
// 判据来源：docs/api/portal.md §4.12、issue #449 管理台工单 §1~§3。
// 隔离约定（docs/testing.md §2.1）：注入 `FakePool`（按 SQL 文本真模拟 `mail_settings` 的单条 upsert）
// + 真 `createMailProvider`（只把 `createMailerImpl` 换成 fake）——不碰真实 DB / 真实 SMTP。
//
// 11 条判据（编号与工单 §3 对齐，每条都能被打红）：
//   ① 无行 ⇒ GET 200 + `transport:'disabled'` + `hasPassword:false`（不是 404）
//   ② PUT 配好 smtp ⇒ 200；再 GET ⇒ `hasPassword:true`，且**响应里 grep 不到口令明文**
//   ③ `password` 缺席 ⇒ 原口令保留（库里值不变）；`password:null` ⇒ 清除
//   ④ transport=smtp 时缺 host / 缺 from / port 越界 / from 非法 / 超时非正整数 ⇒ 各 400 + `details.field`
//   ⑤ `transport='disabled'` 允许 host 为空（不 400）
//   ⑥ PUT 成功后 `mailerProvider.invalidate()` 被调用，且紧接着一次 `get()` 读到的是新配置（不是缓存）
//   ⑦ 审计 `admin.mail_settings_updated` 在册：`details.changed` 含改动键名、`password_changed` 正确、
//      整条 details 序列化后搜不到口令明文
//   ⑧ 测试发信：成功 200 + 审计 / 未启用 409 `mail_not_configured` / 失败 502 `email_send_failed`（details 无口令）
//   ⑨ 非 admin ⇒ 403（走 `requireAdmin`）
//   ⑩ 测试发信限流 ⇒ 第 6 次 429 + `Retry-After`
//   ⑪ 接线判据（源码级）：`http.js` 的 PUT 成功路径必须调 `ctx.mailerProvider.invalidate()`（删掉那行要红）
//
// 另加两条不编号的守卫：邮箱正则与 `admin.js` 建号口径一字不差；审计/日志/响应里永不出现口令明文。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { createMailProvider } from '../src/mail-provider.js';
import { FakePool } from './fake-pool.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const FDE_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = 'mail-admin-session';
const FDE_TOKEN = 'mail-fde-session';
const PASSWORD = 'relay-pass-7392-secret';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

const SMTP_BODY = {
  transport: 'smtp',
  smtp: {
    host: 'relay.internal',
    port: 2525,
    secure: false,
    user: 'svc',
    from: 'noreply@example.com',
    timeouts: { connectionMs: 1000, greetingMs: 2000, socketMs: 3000 },
  },
  password: PASSWORD,
};

/**
 * fake 发信端口 + 真 provider 的计数包装：
 *   * `createMailerImpl` 只把「真发信」换掉（记下 provider 到底把什么配置交给了 mailer）；
 *   * `get()/invalidate()` 转发给**真** provider（60s 缓存是真的）⇒ 判据⑥才有牙：
 *     不调 invalidate() 时下一次 get() 仍然拿到缓存的旧配置。
 */
function makeProvider({ pool, fail = null }) {
  const state = { invalidations: 0, gets: 0, mailerArgs: [], sent: [], fail };
  const inner = createMailProvider({
    pool,
    config: { mail: { killSwitch: false } },
    log: { warn() {} },
    createMailerImpl: (args) => {
      state.mailerArgs.push(args);
      return {
        enabled: true,
        async send(message) {
          if (state.fail) return { ok: false, reason: state.fail };
          state.sent.push(message);
          return { ok: true };
        },
      };
    },
  });
  const provider = {
    async get() {
      state.gets += 1;
      return inner.get();
    },
    invalidate() {
      state.invalidations += 1;
      inner.invalidate();
    },
  };
  return { provider, state };
}

async function startServer({ mailSettings = null, fail = null } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-mailadmin-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('mail-admin-test', 600),
    sessionTtlSeconds: 600,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100,
    },
    kdfConcurrency: 1,
    kdfQueueLimit: 10,
    kdfQueueTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024,
    staticDir,
    mail: { killSwitch: false },
  };
  const pool = new FakePool({
    users: [
      { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
      { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
    ],
  });
  if (mailSettings) pool.mailSettings = mailSettings;
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`,
      user_id: id,
      token_hash: hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 600_000),
      last_seen_at: new Date(),
      revoked_at: null,
    });
  }
  const { provider, state } = makeProvider({ pool, fail });
  const server = createServer({ pool, config, log: { error() {}, warn() {} }, mailerProvider: provider });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    provider,
    state,
    config,
    base,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function call(base, method, pathname, { body, cookie } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res) {
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text === '' ? null : JSON.parse(text) };
}

const getSettings = async (srv, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'GET', '/api/admin/mail/settings', { cookie }));
const putSettings = async (srv, body, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'PUT', '/api/admin/mail/settings', { body, cookie }));
const postTest = async (srv, body, cookie = srv.adminCookie) =>
  json(await call(srv.base, 'POST', '/api/admin/mail/test', { body, cookie }));

const auditRows = (pool, action) => pool.audit.filter((row) => row.action === action);

// ---------------------------------------------------------------------------
// ① 无行 ⇒ 200 + 默认 DTO（未配置是正常态，不是 404）
// ---------------------------------------------------------------------------

test('#449管理台① 无 mail_settings 行 ⇒ GET 200 + transport=disabled + hasPassword=false', async () => {
  const srv = await startServer();
  try {
    const res = await getSettings(srv);
    assert.equal(res.status, 200, '未配置是正常态：200 而不是 404');
    assert.deepEqual(res.body, {
      transport: 'disabled',
      smtp: {
        host: '',
        port: 587,
        secure: true,
        user: '',
        from: '',
        timeouts: { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
      },
      hasPassword: false,
      updatedAt: null,
      updatedBy: null,
    });
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ② PUT 配好 smtp ⇒ 200；再 GET ⇒ hasPassword=true，且响应里没有口令明文
// ---------------------------------------------------------------------------

test('#449管理台② PUT 配好 smtp 后 GET 回 DTO（hasPassword=true，口令只写不读）', async () => {
  const srv = await startServer();
  try {
    const put = await putSettings(srv, SMTP_BODY);
    assert.equal(put.status, 200);
    assert.equal(put.body.transport, 'smtp');
    assert.equal(put.body.smtp.host, 'relay.internal');
    assert.equal(put.body.smtp.port, 2525);
    assert.equal(put.body.smtp.secure, false);
    assert.equal(put.body.smtp.user, 'svc');
    assert.equal(put.body.smtp.from, 'noreply@example.com');
    assert.deepEqual(put.body.smtp.timeouts, { connectionMs: 1000, greetingMs: 2000, socketMs: 3000 });
    assert.equal(put.body.hasPassword, true);
    assert.equal(put.body.updatedBy, ADMIN_ID, 'updated_by 记当前 admin');
    assert.ok(put.body.updatedAt, 'updated_at 由 DB 写入');

    const got = await getSettings(srv);
    assert.equal(got.status, 200);
    assert.deepEqual(got.body, put.body, 'GET 与 PUT 返回同一个 DTO');

    // 红线：两个响应体 + 整条响应文本里都搜不到口令明文（也不该有 password 键）。
    for (const res of [put, got]) {
      assert.ok(!res.text.includes(PASSWORD), '响应里绝不允许出现口令明文');
      assert.equal(Object.hasOwn(res.body, 'password'), false, 'DTO 里没有 password 键（只有 hasPassword）');
      assert.equal(Object.hasOwn(res.body.smtp, 'password'), false);
    }
    // 库里确实存了口令（只写不读 ≠ 不写）。
    assert.equal(srv.pool.mailSettings.smtp_password, PASSWORD);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ③ password 三态：缺席 = 不修改 / null = 清除 / 字符串 = 覆盖
// ---------------------------------------------------------------------------

test('#449管理台③ password 缺席保留原口令、null 清除、字符串覆盖', async () => {
  const srv = await startServer({ mailSettings: {
    transport: 'smtp',
    smtp_host: 'relay.internal',
    smtp_port: 2525,
    smtp_secure: false,
    smtp_user: 'svc',
    smtp_password: PASSWORD,
    smtp_from: 'noreply@example.com',
    connection_timeout_ms: 1000,
    greeting_timeout_ms: 2000,
    socket_timeout_ms: 3000,
    updated_at: new Date('2026-11-01T00:00:00.000Z'),
    updated_by: null,
  } });
  try {
    // ① 键缺席（编辑表单留空 = 不改）：改个端口，口令必须原样留着。
    const { password, ...withoutPassword } = SMTP_BODY;
    assert.equal(password, PASSWORD);
    const keep = await putSettings(srv, { ...withoutPassword, smtp: { ...withoutPassword.smtp, port: 2526 } });
    assert.equal(keep.status, 200);
    assert.equal(keep.body.hasPassword, true);
    assert.equal(keep.body.smtp.port, 2526);
    assert.equal(srv.pool.mailSettings.smtp_password, PASSWORD, '键缺席 ⇒ 库里的口令一字未动');

    // ② password: null ⇒ 清除。
    const cleared = await putSettings(srv, { ...withoutPassword, password: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.hasPassword, false);
    assert.equal(srv.pool.mailSettings.smtp_password, null);

    // ③ password: '' ⇒ 同样清除（空串与 null 同义）。
    await putSettings(srv, { ...withoutPassword, password: 'again-secret' });
    assert.equal(srv.pool.mailSettings.smtp_password, 'again-secret');
    const emptied = await putSettings(srv, { ...withoutPassword, password: '' });
    assert.equal(emptied.body.hasPassword, false);
    assert.equal(srv.pool.mailSettings.smtp_password, null);

    // ④ password 字符串 ⇒ 覆盖。
    const replaced = await putSettings(srv, { ...withoutPassword, password: 'brand-new-pass' });
    assert.equal(replaced.body.hasPassword, true);
    assert.equal(srv.pool.mailSettings.smtp_password, 'brand-new-pass');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ④ 校验矩阵：每条都 400 + details.field
// ---------------------------------------------------------------------------

test('#449管理台④ transport=smtp 的校验矩阵（缺 host/缺 from/port 越界/from 非法/超时非正整数）', async () => {
  const srv = await startServer();
  const base = { ...SMTP_BODY };
  const cases = [
    ['smtp.host', { ...base, smtp: { ...base.smtp, host: '' } }, '缺 host'],
    ['smtp.host', { ...base, smtp: { ...base.smtp, host: '   ' } }, 'host 全是空白'],
    ['smtp.from', { ...base, smtp: { ...base.smtp, from: '' } }, '缺 from'],
    ['smtp.from', { ...base, smtp: { ...base.smtp, from: 'not-an-email' } }, 'from 不是邮箱'],
    ['smtp.from', { ...base, smtp: { ...base.smtp, from: 'a@b' } }, 'from 缺 TLD'],
    ['smtp.port', { ...base, smtp: { ...base.smtp, port: 0 } }, 'port 下越界'],
    ['smtp.port', { ...base, smtp: { ...base.smtp, port: 65536 } }, 'port 上越界'],
    ['smtp.port', { ...base, smtp: { ...base.smtp, port: 25.5 } }, 'port 非整数'],
    ['smtp.port', { ...base, smtp: { ...base.smtp, port: '25' } }, 'port 是字符串'],
    ['smtp.secure', { ...base, smtp: { ...base.smtp, secure: 'yes' } }, 'secure 非布尔'],
    ['smtp.timeouts.connectionMs', { ...base, smtp: { ...base.smtp, timeouts: { connectionMs: 0 } } }, '超时 0'],
    ['smtp.timeouts.greetingMs', { ...base, smtp: { ...base.smtp, timeouts: { greetingMs: -1 } } }, '超时负数'],
    ['smtp.timeouts.socketMs', { ...base, smtp: { ...base.smtp, timeouts: { socketMs: 600001 } } }, '超时超上限'],
    ['smtp.timeouts.socketMs', { ...base, smtp: { ...base.smtp, timeouts: { socketMs: 1.5 } } }, '超时非整数'],
    ['transport', { ...base, transport: 'smtps' }, 'transport 不在枚举内'],
    ['transport', { ...base, transport: undefined }, 'transport 缺席'],
    ['smtp', { ...base, smtp: null }, 'smtp 不是对象'],
    ['password', { ...base, password: 12345 }, 'password 不是字符串/null'],
  ];
  try {
    for (const [field, body, label] of cases) {
      const res = await putSettings(srv, body);
      assert.equal(res.status, 400, `${label} ⇒ 400`);
      assert.equal(res.body.error.code, 'validation_failed', label);
      assert.equal(res.body.error.details.field, field, `${label} ⇒ details.field=${field}`);
      assert.equal(res.body.error.retryable, false);
    }
    assert.equal(srv.pool.mailSettings, null, '全部被拒 ⇒ 库里一行都没有（没有半截写入）');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ transport=disabled 不校验 host/from（允许保留半套配置）
// ---------------------------------------------------------------------------

test("#449管理台⑤ transport='disabled' 允许 host/from 为空（不 400）", async () => {
  const srv = await startServer();
  try {
    const res = await putSettings(srv, {
      transport: 'disabled',
      smtp: { host: '', port: 587, secure: true, user: '', from: '', timeouts: {} },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.transport, 'disabled');
    assert.equal(res.body.smtp.host, '');
    assert.equal(res.body.smtp.from, '');
    assert.deepEqual(res.body.smtp.timeouts, { connectionMs: 10000, greetingMs: 10000, socketMs: 20000 },
      'timeouts 缺省回落到默认值');
    assert.equal(srv.pool.mailSettings.transport, 'disabled');

    // 也允许「关掉但留着半套配置」（先关后配的日常形态）。
    const half = await putSettings(srv, {
      transport: 'disabled',
      smtp: { host: 'relay.internal', port: 25, secure: false, user: '', from: '', timeouts: {} },
    });
    assert.equal(half.status, 200);
    assert.equal(half.body.smtp.host, 'relay.internal');
    assert.equal(half.body.smtp.from, '', 'disabled 时 from 为空不拦');

    // 反过来：smtp 少了 host 就必须拦（证明 ⑤ 不是把校验整个关掉）。
    const smtp = await putSettings(srv, {
      transport: 'smtp',
      smtp: { host: '', port: 25, secure: false, user: '', from: 'a@b.co', timeouts: {} },
    });
    assert.equal(smtp.status, 400);
    assert.equal(smtp.body.error.details.field, 'smtp.host');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ invalidate() 被调用，且紧接着的 get() 读到新配置（不是 60s 缓存里的旧配置）
// ---------------------------------------------------------------------------

test('#449管理台⑥ PUT 成功后 invalidate() 生效：紧接着的 get() 读到新配置', async () => {
  const srv = await startServer();
  try {
    // 先让 provider 缓存「未配置」的 disabled 端口（= 启动探针那一步的形态）。
    assert.equal((await srv.provider.get()).enabled, false);
    const before = srv.state.invalidations;

    const put = await putSettings(srv, SMTP_BODY);
    assert.equal(put.status, 200);
    assert.equal(srv.state.invalidations, before + 1, 'PUT 成功路径必须调一次 invalidate()');

    // 缓存已失效 ⇒ 下一次 get() 重新读库，拿到的是**刚写进去的**配置。
    const mailer = await srv.provider.get();
    assert.equal(mailer.enabled, true, '不 invalidate 的话这里还是缓存的 disabled 端口');
    const lastArgs = srv.state.mailerArgs.at(-1);
    assert.equal(lastArgs.smtp.host, 'relay.internal');
    assert.equal(lastArgs.smtp.port, 2525);
    assert.equal(lastArgs.from, 'noreply@example.com');
    assert.equal(lastArgs.smtp.password, PASSWORD, '口令确实到达发信端口（只写不读 ≠ 不写）');

    // 反证：再改一次配置但不经过 PUT ⇒ 缓存的仍是上一次的（60s TTL 内不会自己刷新）。
    srv.pool.mailSettings = { ...srv.pool.mailSettings, smtp_host: 'relay2.internal' };
    const cached = srv.state.mailerArgs.length;
    await srv.provider.get();
    assert.equal(srv.state.mailerArgs.length, cached, 'TTL 内命中缓存，没有再建一次 mailer');
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑦ 审计：changed / password_changed 正确，且 details 里没有口令明文
// ---------------------------------------------------------------------------

test('#449管理台⑦ 审计 admin.mail_settings_updated 记改动键名与 password_changed，绝不含口令', async () => {
  const srv = await startServer();
  try {
    const created = await putSettings(srv, SMTP_BODY);
    assert.equal(created.status, 200);
    const [row] = auditRows(srv.pool, 'admin.mail_settings_updated');
    assert.ok(row, '审计 admin.mail_settings_updated 必须在册');
    assert.equal(row.actor_id, ADMIN_ID);
    assert.equal(row.target, 'mail_settings');
    const details = JSON.parse(row.details);
    assert.equal(details.transport, 'smtp');
    assert.equal(details.password_changed, true);
    assert.ok(Array.isArray(details.changed));
    for (const key of ['transport', 'smtp.host', 'smtp.port', 'smtp.secure', 'smtp.user', 'smtp.from',
      'smtp.timeouts.connectionMs', 'smtp.timeouts.greetingMs', 'smtp.timeouts.socketMs', 'password']) {
      assert.ok(details.changed.includes(key), `changed 应含 ${key}（实际 ${details.changed.join(',')}）`);
    }
    assert.ok(!row.details.includes(PASSWORD), '审计 details 里绝不允许出现口令明文');

    // 第二次：只改端口、口令缺席 ⇒ changed 只有 smtp.port，password_changed=false。
    const { password, ...withoutPassword } = SMTP_BODY;
    assert.equal(password, PASSWORD);
    await putSettings(srv, { ...withoutPassword, smtp: { ...withoutPassword.smtp, port: 2526 } });
    const rows = auditRows(srv.pool, 'admin.mail_settings_updated');
    assert.equal(rows.length, 2);
    const second = JSON.parse(rows[1].details);
    assert.deepEqual(second.changed, ['smtp.port'], '只有端口变了');
    assert.equal(second.password_changed, false, '口令没传 ⇒ 没改');
    assert.ok(!rows[1].details.includes(PASSWORD));

    // 第三次：什么都没变 ⇒ changed 为空（仍然是 200 + 一条审计：幂等保存不是错误）。
    const noop = await putSettings(srv, { ...withoutPassword, smtp: { ...withoutPassword.smtp, port: 2526 } });
    assert.equal(noop.status, 200);
    const third = JSON.parse(auditRows(srv.pool, 'admin.mail_settings_updated')[2].details);
    assert.deepEqual(third.changed, []);
    assert.equal(third.password_changed, false);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑧ 测试发信三态
// ---------------------------------------------------------------------------

test('#449管理台⑧-1 测试发信成功 ⇒ 200 {ok,to,at} + 审计 admin.mail_test_sent（正文无验证码）', async () => {
  const srv = await startServer({ mailSettings: {
    transport: 'smtp',
    smtp_host: 'relay.internal',
    smtp_port: 2525,
    smtp_secure: false,
    smtp_user: 'svc',
    smtp_password: PASSWORD,
    smtp_from: 'noreply@example.com',
    connection_timeout_ms: 1000,
    greeting_timeout_ms: 2000,
    socket_timeout_ms: 3000,
    updated_at: new Date(),
    updated_by: null,
  } });
  try {
    const res = await postTest(srv, { to: 'ops@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.to, 'ops@example.com');
    assert.ok(res.body.at && !Number.isNaN(Date.parse(res.body.at)), 'at 是 ISO 时间戳');

    assert.equal(srv.state.sent.length, 1);
    const message = srv.state.sent[0];
    assert.equal(message.to, 'ops@example.com');
    assert.equal(message.subject, 'FDE Station 邮件通道测试');
    assert.ok(message.text.includes(res.body.at), '正文带本次时间戳');
    assert.match(message.text, /测试邮件/, '正文说明这是测试信');
    assert.ok(!/\b\d{6}\b/.test(message.text), '测试信正文不含验证码');
    assert.ok(!res.text.includes(PASSWORD), '响应里没有口令');

    const [row] = auditRows(srv.pool, 'admin.mail_test_sent');
    assert.ok(row, '审计 admin.mail_test_sent 必须在册');
    assert.equal(row.actor_id, ADMIN_ID);
    assert.deepEqual(JSON.parse(row.details), { to: 'ops@example.com', at: res.body.at });
    assert.ok(!row.details.includes(PASSWORD));

    // to 非法 ⇒ 400（不烧配额、不发信）。
    for (const bad of [undefined, '', 'nope', 'a@b']) {
      const invalid = await postTest(srv, { to: bad });
      assert.equal(invalid.status, 400, `to=${String(bad)} ⇒ 400`);
      assert.equal(invalid.body.error.code, 'validation_failed');
      assert.equal(invalid.body.error.details.field, 'to');
    }
    assert.equal(srv.state.sent.length, 1, '非法 to 没有发信');
  } finally {
    await srv.close();
  }
});

test('#449管理台⑧-2 通道未启用 ⇒ 409 mail_not_configured（无行 / transport=disabled）', async () => {
  // ① 无行
  const empty = await startServer();
  try {
    const res = await postTest(empty, { to: 'ops@example.com' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'mail_not_configured');
    assert.equal(res.body.error.retryable, false);
    assert.match(res.body.error.message, /SMTP/, 'message 要指出「先去配置 SMTP」');
    assert.equal(empty.state.sent.length, 0);
    assert.equal(auditRows(empty.pool, 'admin.mail_test_sent').length, 0);
  } finally {
    await empty.close();
  }

  // ② transport='disabled'（有行但不发信）
  const disabled = await startServer({ mailSettings: {
    transport: 'disabled',
    smtp_host: '',
    smtp_port: 587,
    smtp_secure: true,
    smtp_user: '',
    smtp_password: null,
    smtp_from: '',
    connection_timeout_ms: 10000,
    greeting_timeout_ms: 10000,
    socket_timeout_ms: 20000,
    updated_at: new Date(),
    updated_by: null,
  } });
  try {
    const res = await postTest(disabled, { to: 'ops@example.com' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'mail_not_configured');
    assert.equal(disabled.state.sent.length, 0);
  } finally {
    await disabled.close();
  }
});

test('#449管理台⑧-3 发信失败 ⇒ 502 email_send_failed（details 只有 reason，无口令）', async () => {
  const srv = await startServer({
    mailSettings: {
      transport: 'smtp',
      smtp_host: 'relay.internal',
      smtp_port: 2525,
      smtp_secure: false,
      smtp_user: 'svc',
      smtp_password: PASSWORD,
      smtp_from: 'noreply@example.com',
      connection_timeout_ms: 1000,
      greeting_timeout_ms: 2000,
      socket_timeout_ms: 3000,
      updated_at: new Date(),
      updated_by: null,
    },
    fail: 'ECONNREFUSED: connect ECONNREFUSED 10.0.0.9:2525',
  });
  try {
    const res = await postTest(srv, { to: 'ops@example.com' });
    assert.equal(res.status, 502);
    assert.equal(res.body.error.code, 'email_send_failed');
    assert.equal(res.body.error.retryable, true);
    assert.deepEqual(Object.keys(res.body.error.details), ['reason'], 'details 只放 reason 摘要');
    assert.match(res.body.error.details.reason, /ECONNREFUSED/);
    assert.ok(!res.text.includes(PASSWORD), '响应里没有口令');

    const [row] = auditRows(srv.pool, 'admin.mail_test_failed');
    assert.ok(row, '审计 admin.mail_test_failed 必须在册');
    assert.equal(row.actor_id, ADMIN_ID);
    const details = JSON.parse(row.details);
    assert.equal(details.to, 'ops@example.com');
    assert.match(details.reason, /ECONNREFUSED/);
    assert.ok(!row.details.includes(PASSWORD), '审计里没有口令');
    assert.equal(auditRows(srv.pool, 'admin.mail_test_sent').length, 0);
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑨ 非 admin ⇒ 403（三个端点都走 requireAdmin）
// ---------------------------------------------------------------------------

test('#449管理台⑨ 非 admin 打三个端点一律 403 forbidden；未登录 401', async () => {
  const srv = await startServer({ mailSettings: {
    transport: 'smtp',
    smtp_host: 'relay.internal',
    smtp_port: 2525,
    smtp_secure: false,
    smtp_user: 'svc',
    smtp_password: PASSWORD,
    smtp_from: 'noreply@example.com',
    connection_timeout_ms: 1000,
    greeting_timeout_ms: 2000,
    socket_timeout_ms: 3000,
    updated_at: new Date(),
    updated_by: null,
  } });
  try {
    const fdeCalls = [
      await getSettings(srv, srv.fdeCookie),
      await putSettings(srv, SMTP_BODY, srv.fdeCookie),
      await postTest(srv, { to: 'ops@example.com' }, srv.fdeCookie),
    ];
    for (const res of fdeCalls) {
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'forbidden');
    }
    assert.equal(srv.state.sent.length, 0, '非 admin 不会真发信');
    assert.equal(auditRows(srv.pool, 'admin.mail_settings_updated').length, 0);

    const anon = [
      await json(await call(srv.base, 'GET', '/api/admin/mail/settings')),
      await json(await call(srv.base, 'POST', '/api/admin/mail/test', { body: { to: 'ops@example.com' } })),
    ];
    for (const res of anon) {
      assert.equal(res.status, 401);
      assert.equal(res.body.error.code, 'unauthorized');
    }
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑩ 测试发信限流：5 次/小时，第 6 次 429 + Retry-After
// ---------------------------------------------------------------------------

test('#449管理台⑩ 测试发信每管理员 5 次/小时 ⇒ 第 6 次 429 + Retry-After', async () => {
  const srv = await startServer({ mailSettings: {
    transport: 'smtp',
    smtp_host: 'relay.internal',
    smtp_port: 2525,
    smtp_secure: false,
    smtp_user: 'svc',
    smtp_password: PASSWORD,
    smtp_from: 'noreply@example.com',
    connection_timeout_ms: 1000,
    greeting_timeout_ms: 2000,
    socket_timeout_ms: 3000,
    updated_at: new Date(),
    updated_by: null,
  } });
  try {
    for (let i = 1; i <= 5; i += 1) {
      const res = await postTest(srv, { to: 'ops@example.com' });
      assert.equal(res.status, 200, `第 ${i} 次在额度内`);
    }
    assert.equal(srv.state.sent.length, 5);

    const blocked = await postTest(srv, { to: 'ops@example.com' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'rate_limited');
    assert.equal(blocked.body.error.retryable, true);
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, 'Retry-After 必须是正秒数');
    assert.equal(srv.state.sent.length, 5, '超限后不再发信');

    // 未启用的 409 不烧配额：换一个「没配置」的服务器打 6 次仍然是 409（不是 429）。
    const emptySrv = await startServer();
    try {
      for (let i = 1; i <= 6; i += 1) {
        const res = await postTest(emptySrv, { to: 'ops@example.com' });
        assert.equal(res.status, 409, `未启用时第 ${i} 次仍是 409（不占额度）`);
      }
    } finally {
      await emptySrv.close();
    }
  } finally {
    await srv.close();
  }
});

// ---------------------------------------------------------------------------
// ⑪ 接线判据（源码级）：PUT 成功路径必须调 ctx.mailerProvider.invalidate()
// ---------------------------------------------------------------------------

test('#449管理台⑪ 接线：http.js 的 PUT 成功路径调 ctx.mailerProvider.invalidate()，且先失效再审计', () => {
  const src = fs.readFileSync(path.join(SRC, 'http.js'), 'utf8');
  const start = src.indexOf("pathname === '/api/admin/mail/settings'");
  assert.ok(start > 0, 'http.js 里必须有 /api/admin/mail/settings 的分派');
  const end = src.indexOf("pathname === '/api/admin/mail/test'", start);
  assert.ok(end > start, '/api/admin/mail/test 的分派必须紧随其后（切片边界）');
  const block = src.slice(start, end);

  assert.match(block, /ctx\.mailerProvider\.invalidate\(\)/, 'PUT 成功路径必须让 60s 缓存失效（删掉这行 ⇒ 配好了要等一分钟）');
  assert.match(block, /mailSettings\.updateMailSettings\(/, 'PUT 走 mail-settings 模块落库');
  assert.match(block, /action: 'admin\.mail_settings_updated'/, 'PUT 成功必须写审计');

  const invalidateAt = block.indexOf('ctx.mailerProvider.invalidate()');
  const auditAt = block.indexOf("action: 'admin.mail_settings_updated'");
  const sendAt = block.indexOf('return sendJson(res, 200, result.settings)');
  assert.ok(invalidateAt < auditAt, '顺序：先 invalidate() 再写审计');
  assert.ok(auditAt < sendAt, '顺序：先写审计再回响应（§4.12 的成功三步）');

  // 测试发信端点：未启用必须是 409 mail_not_configured（不是 503/500），失败是 502 email_send_failed。
  const testSrc = fs.readFileSync(path.join(SRC, 'http.js'), 'utf8');
  assert.match(testSrc, /mail_not_configured/, '未启用用新错误码 mail_not_configured');
  assert.match(testSrc, /502,\s*\n?\s*'email_send_failed'/, '发信失败是 502 email_send_failed');
});

test('#449管理台 邮箱正则与 admin.js 建号口径一字不差', () => {
  const adminSrc = fs.readFileSync(path.join(SRC, 'admin.js'), 'utf8');
  const mailSrc = fs.readFileSync(path.join(SRC, 'mail-settings.js'), 'utf8');
  const pattern = '/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/';
  assert.ok(adminSrc.includes(pattern), 'admin.js 建号仍用同一个邮箱正则');
  assert.ok(mailSrc.includes(pattern), 'mail-settings.js 用同一个邮箱正则（smtp.from / to）');
});
