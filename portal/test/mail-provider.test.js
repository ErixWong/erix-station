// issue #449：邮件通道的两层——`mailer.js`（发信端口）与 `mail-provider.js`（SMTP 配置的 DB 读取侧）。
//
// 决策者 2026-11-05 口径：SMTP 参数（含口令）**明文存 DB**（内网 relay，与 `git_hosts.admin_key` 同口径），
// 不做本地加密；但「口令/验证码不进日志」这条不变。env 只剩 `MAIL_TRANSPORT` 急停开关。
//
// 覆盖：
//   * provider：无行 ⇒ disabled / smtp 行 ⇒ enabled 且参数原样到达 createMailer / disabled 行 ⇒ disabled /
//     半套配置 ⇒ disabled + warn / killSwitch ⇒ disabled 且不查库 / 读取抛错 ⇒ disabled + warn 且不抛 /
//     60s TTL 缓存 + invalidate() 生效；
//   * mailer：disabled 不抛 / 发送失败不抛且只记脱敏收件人 + reason（口令与正文绝不进日志）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailProvider } from '../src/mail-provider.js';
import { createMailer, maskEmail } from '../src/mailer.js';

const SMTP_ROW = {
  transport: 'smtp',
  smtp_host: 'relay.internal',
  smtp_port: 2525,
  smtp_secure: false,
  smtp_user: 'station',
  smtp_password: 'relay-pass',
  smtp_from: 'no-reply@fde.local',
  connection_timeout_ms: 1000,
  greeting_timeout_ms: 2000,
  socket_timeout_ms: 3000,
};

/** 只认 `mail_settings` 的最小 fake pool：可数查询次数、可注入错误。 */
class MailSettingsPool {
  constructor(row = null) {
    this.row = row;
    this.queries = 0;
    this.fail = null;
  }

  async query(sql) {
    assert.match(sql, /FROM mail_settings/, 'provider 只该查 mail_settings');
    this.queries += 1;
    if (this.fail) throw this.fail;
    return { rows: this.row ? [{ ...this.row }] : [], rowCount: this.row ? 1 : 0 };
  }
}

function captureLog() {
  const logs = { warn: [], info: [], error: [] };
  const log = {
    warn: (m) => logs.warn.push(String(m)),
    info: (m) => logs.info.push(String(m)),
    error: (m) => logs.error.push(String(m)),
  };
  return { log, logs };
}

/** 注入的 createMailer 替身：把「读出来的配置拼成了什么」原样记下来。 */
function captureMailerFactory() {
  const calls = [];
  const factory = (args) => {
    calls.push(args);
    return { enabled: true, send: async () => ({ ok: true }) };
  };
  return { calls, factory };
}

test('#449 邮件通道：无 mail_settings 行 ⇒ disabled（第二因素不生效）', async () => {
  const pool = new MailSettingsPool(null);
  const { log, logs } = captureLog();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: false } }, log });

  const mailer = await provider.get();
  assert.equal(mailer.enabled, false);
  assert.deepEqual(await mailer.send({ to: 'a@b.c', subject: 's', text: 't' }), { ok: false, reason: 'disabled' });
  assert.equal(pool.queries, 1);
  assert.equal(logs.warn.length, 0, '「未配置」是默认形态，不该每条请求都告警');
});

test('#449 邮件通道：transport=smtp ⇒ enabled，DB 里的 SMTP 参数原样到达 createMailer（含明文口令）', async () => {
  const pool = new MailSettingsPool(SMTP_ROW);
  const { log } = captureLog();
  const { calls, factory } = captureMailerFactory();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: false } }, log, createMailerImpl: factory });

  const mailer = await provider.get();
  assert.equal(mailer.enabled, true);
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.equal(args.transport, 'smtp');
  assert.equal(args.from, 'no-reply@fde.local');
  assert.equal(args.smtp.host, 'relay.internal');
  assert.equal(args.smtp.port, 2525);
  assert.equal(args.smtp.secure, false);
  assert.equal(args.smtp.user, 'station');
  assert.equal(args.smtp.password, 'relay-pass', '明文口令（内网 relay 口径）原样传给发信端口');
  assert.equal(args.smtp.connectionTimeoutMs, 1000);
  assert.equal(args.smtp.greetingTimeoutMs, 2000);
  assert.equal(args.smtp.socketTimeoutMs, 3000);
});

test('#449 邮件通道：relay 不认证（user/password 为空）也能启用', async () => {
  const pool = new MailSettingsPool({ ...SMTP_ROW, smtp_user: null, smtp_password: null });
  const { calls, factory } = captureMailerFactory();
  const provider = createMailProvider({
    pool,
    config: { mail: { killSwitch: false } },
    log: captureLog().log,
    createMailerImpl: factory,
  });
  assert.equal((await provider.get()).enabled, true);
  assert.equal(calls[0].smtp.user, '');
  assert.equal(calls[0].smtp.password, '');
});

test('#449 邮件通道：transport=disabled 行 ⇒ disabled，且**不告警**（正常关闭态，评审返修 ④）', async () => {
  const pool = new MailSettingsPool({ ...SMTP_ROW, transport: 'disabled' });
  const { log, logs } = captureLog();
  let clock = 1_000_000;
  const provider = createMailProvider({
    pool,
    config: { mail: { killSwitch: false } },
    log,
    now: () => clock,
    createMailerImpl: captureMailerFactory().factory,
  });
  assert.equal((await provider.get()).enabled, false);
  // 缓存过期后重读也不许再 warn：默认就没配，每 60s 刷一行只会把日志变成噪声。
  clock += 61_000;
  assert.equal((await provider.get()).enabled, false);
  assert.equal(pool.queries, 2);
  assert.deepEqual(logs.warn, [], '正常关闭态必须静默');
});

test('#449 邮件通道：半套 SMTP 配置（有 host 无 from）⇒ disabled + warn，而不是拿半套去连', async () => {
  const pool = new MailSettingsPool({ ...SMTP_ROW, smtp_from: null });
  const { log, logs } = captureLog();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: false } }, log });
  assert.equal((await provider.get()).enabled, false);
  assert.match(logs.warn.join('\n'), /incomplete_settings/);
});

test('#449 邮件通道：MAIL_TRANSPORT=disabled 急停 ⇒ 一律 disabled，且**不查库**', async () => {
  const pool = new MailSettingsPool(SMTP_ROW);
  const { log, logs } = captureLog();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: true } }, log });
  assert.equal((await provider.get()).enabled, false);
  assert.equal((await provider.get()).enabled, false);
  assert.equal(pool.queries, 0, '急停必须能在不碰数据库的情况下生效');
  assert.deepEqual(logs.warn, [], '急停是正常运维动作，不该刷告警');
});

test('#449 邮件通道：读取失败（表不存在/DB 抖动）⇒ disabled + warn，绝不抛给登录路径', async () => {
  const pool = new MailSettingsPool(SMTP_ROW);
  pool.fail = Object.assign(new Error('relation "mail_settings" does not exist'), { code: '42P01' });
  const { log, logs } = captureLog();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: false } }, log });

  const mailer = await provider.get(); // 不抛
  assert.equal(mailer.enabled, false);
  assert.equal(logs.warn.length, 1);
  assert.match(logs.warn[0], /mail settings unavailable/);
  assert.match(logs.warn[0], /42P01|does not exist/);
  assert.ok(!logs.warn[0].includes('relay-pass'), '日志里不许出现口令');
});

test('#449 邮件通道：60s TTL 缓存 + invalidate() 立即失效', async () => {
  const pool = new MailSettingsPool(SMTP_ROW);
  const { log } = captureLog();
  let clock = 1_000_000;
  const provider = createMailProvider({
    pool,
    config: { mail: { killSwitch: false } },
    log,
    now: () => clock,
    createMailerImpl: captureMailerFactory().factory,
  });

  await provider.get();
  await provider.get();
  assert.equal(pool.queries, 1, 'TTL 内只读一次库（登录是热路径）');

  clock += 59_000;
  await provider.get();
  assert.equal(pool.queries, 1, '59s 仍在缓存内');

  clock += 2_000; // 61s
  await provider.get();
  assert.equal(pool.queries, 2, '超过 60s 必须重读');

  provider.invalidate();
  await provider.get();
  assert.equal(pool.queries, 3, 'invalidate() 之后立刻重读（写侧落库后不必等 TTL）');
});

test('#449 邮件通道：invalidate() 之前发起的读不会把旧配置写回缓存', async () => {
  const pool = new MailSettingsPool({ ...SMTP_ROW, smtp_host: 'old.internal' });
  const { log } = captureLog();
  const { calls, factory } = captureMailerFactory();
  const provider = createMailProvider({ pool, config: { mail: { killSwitch: false } }, log, createMailerImpl: factory });

  const pending = provider.get(); // 读进行中
  pool.row = { ...SMTP_ROW, smtp_host: 'new.internal' };
  provider.invalidate(); // 读还没回来就 invalidate
  await pending;
  await provider.get();
  assert.equal(calls.length, 2, '第二次 get 必须重读');
  assert.equal(calls[1].smtp.host, 'new.internal', '缓存里不许残留旧配置');
});

// ---------------------------------------------------------------------------
// mailer 本身：永不抛 + 日志不含口令/正文
// ---------------------------------------------------------------------------

test('#449 mailer：transport=disabled ⇒ send 返回 {ok:false,reason:disabled}，不抛', async () => {
  const mailer = createMailer({ transport: 'disabled' });
  assert.equal(mailer.enabled, false);
  assert.deepEqual(await mailer.send({ to: 'a@b.c', subject: 's', text: 't' }), { ok: false, reason: 'disabled' });
});

test('#449 mailer：SMTP 抛错 ⇒ {ok:false,reason}，日志只有脱敏收件人 + reason（无口令、无正文、无验证码）', async () => {
  const { log, logs } = captureLog();
  const mailer = createMailer({
    transport: 'smtp',
    from: 'no-reply@fde.local',
    smtp: { host: 'relay.internal', port: 25, user: 'station', password: 'relay-pass' },
    log,
    sendMailImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:25'), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(mailer.enabled, true);

  const result = await mailer.send({ to: 'alice@example.com', subject: '登录验证码', text: '你的登录验证码是 123456' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ECONNREFUSED/);

  const logged = logs.warn.join('\n');
  assert.match(logged, /a\*\*\*@e\*\*\*\.com/, '只记脱敏收件人');
  assert.ok(!logged.includes('alice@example.com'), '日志里不许出现完整邮箱');
  assert.ok(!logged.includes('relay-pass'), '日志里不许出现 SMTP 口令');
  assert.ok(!logged.includes('123456'), '日志里不许出现验证码（正文一律不入日志）');
});

test('#449 mailer：收件人缺失 ⇒ {ok:false,reason:missing_recipient}，不抛', async () => {
  const mailer = createMailer({ transport: 'smtp', sendMailImpl: async () => ({}) });
  assert.deepEqual(await mailer.send({ to: '   ', subject: 's', text: 't' }), {
    ok: false,
    reason: 'missing_recipient',
  });
});

test('#449 mailer：maskEmail 与 §2.3a 的 email_hint 同一口径', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***@e***.com');
  assert.equal(maskEmail('x@y.io'), 'x***@y***.io');
  assert.equal(maskEmail(''), '***');
});
