// 邮件通道的**读取侧**（issue #449，决策者 2026-11-04：SMTP 参数由管理台维护、存 DB）。
//
// 分工：
//   * `mail_settings`（迁移 `0026-login-email-codes.sql`，单行表）是**唯一真相**：transport / host / port /
//     secure / user / 口令 / 发件人 / 三档超时；
//   * 本模块把它读出来、组装成 `createMailer(...)`（`portal/src/mailer.js`）。
//     口令是**明文**列（内网 relay，与 `git_hosts.admin_key` 同口径）——本模块只负责「不把它泄到
//     日志/响应里」，不做加密（决策者 2026-11-05）。
//   * 管理 API（写侧 + UI）留给下一片，本切片只提供 `invalidate()`：下一片的 PUT 落库后调一次，
//     缓存立刻失效（不然「配好了却要等 60s」会被当成配置没生效）。
//
// 三条硬口径：
//   1. **60s TTL 缓存**：登录是热路径，不能每个请求都读一行 DB；`now` 可注入（单测不 sleep）。
//   2. **读取失败绝不 500**：表不存在 / DB 抖动 ⇒ 返回 `{enabled:false}` + 一条 warn。
//      登录路径要 fail-open 到「没有第二因素」（退回纯口令），而不是 fail-closed 到「所有人登不进」
//      ——与决策 D3b 同一口径（运维故障不该把整站锁死）。
//   3. **急停优先**：`config.mail.killSwitch`（`MAIL_TRANSPORT=disabled`）为真时**不读 DB、不看缓存**，
//      直接 disabled。运维要能在不碰数据库的情况下把发信关掉。

import { createMailer } from './mailer.js';

const CACHE_TTL_MS = 60 * 1000;

const SETTINGS_SQL = `SELECT transport, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_password,
       smtp_from, connection_timeout_ms, greeting_timeout_ms, socket_timeout_ms
  FROM mail_settings WHERE id = 1`;

/** 「没有邮件通道」的端口形态：`send()` 不抛、返回 disabled（与 createMailer 的 disabled 分支同形）。 */
function disabledMailer() {
  return { enabled: false, send: async () => ({ ok: false, reason: 'disabled' }) };
}

/**
 * @returns {{ get: () => Promise<{enabled:boolean, send:Function}>, invalidate: () => void }}
 */
export function createMailProvider({
  pool,
  config = {},
  log = console,
  now = () => Date.now(),
  ttlMs = CACHE_TTL_MS,
  // 仅供测试注入：把「读出来的配置到底拼成了什么」钉住（生产不传）。
  createMailerImpl = createMailer,
} = {}) {
  let cached = null; // { mailer, at, version }
  let version = 0; // 写侧 invalidate() 递增：并发读不会把旧配置写回缓存

  function killSwitchOn() {
    return config?.mail?.killSwitch === true;
  }

  async function load() {
    if (killSwitchOn()) return { mailer: disabledMailer(), reason: 'kill_switch' };
    const { rows } = await pool.query(SETTINGS_SQL);
    const row = rows?.[0];
    if (!row) return { mailer: disabledMailer(), reason: 'not_configured' };
    if (row.transport !== 'smtp') return { mailer: disabledMailer(), reason: 'transport_disabled' };
    if (!row.smtp_host || !row.smtp_from) return { mailer: disabledMailer(), reason: 'incomplete_settings' };

    // 口令：明文列，直接透传（relay 不需要认证时为空串 ⇒ createMailer 不建 auth）。
    const password = typeof row.smtp_password === 'string' ? row.smtp_password : '';

    const mailer = createMailerImpl({
      transport: 'smtp',
      from: row.smtp_from,
      log,
      smtp: {
        host: row.smtp_host,
        port: Number(row.smtp_port ?? 587),
        secure: row.smtp_secure === true,
        user: row.smtp_user ?? '',
        password,
        connectionTimeoutMs: Number(row.connection_timeout_ms ?? 10000),
        greetingTimeoutMs: Number(row.greeting_timeout_ms ?? 10000),
        socketTimeoutMs: Number(row.socket_timeout_ms ?? 20000),
      },
    });
    return { mailer, reason: null };
  }

  async function get() {
    if (killSwitchOn()) return disabledMailer(); // 急停：连缓存都不看（改了 env 不必等 TTL）
    const at = now();
    if (cached && cached.version === version && at - cached.at < ttlMs) return cached.mailer;

    const startedVersion = version;
    let result;
    try {
      result = await load();
    } catch (err) {
      // 表不存在（迁移没跑）/ DB 抖动 / 口令解不开：**不抛**，降级成 disabled + warn（口径 2）。
      log?.warn?.(
        `[mail] mail settings unavailable (${summarize(err)}); email second factor disabled`,
      );
      return disabledMailer();
    }
    // 只对**配置异常**告警（评审返修 ④）：
    //   * `not_configured` / `transport_disabled` / `kill_switch` 都是正常状态（默认就没配），
    //     60s 缓存每过期一次就 warn 一行只会把日志刷成噪声；
    //   * `incomplete_settings`（配了一半：有 host 没 from）才是运维真的做错了事。
    if (result.reason === 'incomplete_settings') {
      log?.warn?.(`[mail] email second factor disabled (${result.reason})`);
    }
    // 只有「读成功」才写缓存；读的这段时间里被 invalidate() 了就不回写（防旧配置盖住新配置）。
    if (startedVersion === version) cached = { mailer: result.mailer, at, version };
    return result.mailer;
  }

  /** 写侧（下一片的管理 PUT）落库后调用：让下一次 get() 重新读库。 */
  function invalidate() {
    version += 1;
    cached = null;
  }

  return { get, invalidate };
}

function summarize(err) {
  const message = typeof err?.message === 'string' ? err.message : String(err ?? 'unknown');
  return message.replace(/\s+/g, ' ').trim().slice(0, 160);
}
