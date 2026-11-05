// 邮件通道（issue #449 后端切片 M1）：登录第二因素「邮箱验证码」的发信出口。
//
// 契约（docs/api/portal.md §2.3a/§2.3b）：
//   * `send()` **永不抛错**——成功 `{ok:true}`，失败 `{ok:false, reason}`。handler 把失败映射成
//     `503 email_send_failed`（retryable），且**不作废** pending_token（用户点重发即可，不必重输口令）。
//   * **日志里绝不出现验证码 / 口令 / session token**：只记收件人的脱敏形态 + reason 摘要。
//   * **不在模块顶层读 env**：配置由 `config.js` 读好后注入（`createMailer({ ...config.mail })`）。
//     `transport` 默认 `'disabled'` = 本单上线时的形态（邮件通道未配置 ⇒ 第二因素不生效）。
//   * `sendMailImpl` 仅供测试注入 fake；生产不传，走 nodemailer。
//
// 依赖：`nodemailer`（根 package.json dependencies，零传递依赖）。

import nodemailer from 'nodemailer';

const DEFAULT_TIMEOUT_MS = 10 * 1000;

/**
 * 脱敏邮箱（登录响应的 `email_hint` 与日志共用同一个口径，避免两处各写一套）：
 * 本地部分保留首字符 + `***`；域名首段保留首字符 + `***`，TLD 及后续标签原样。
 *   `alice@example.com`   → `a***@e***.com`
 *   `a@ex.com`            → `a***@e***.com`
 *   非法/空串              → `***`
 */
export function maskEmail(email) {
  if (typeof email !== 'string') return '***';
  const value = email.trim();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return '***';
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  const labels = domain.split('.');
  const head = labels[0] ?? '';
  const tail = labels.slice(1).join('.');
  const maskedLocal = `${local.slice(0, 1)}***`;
  const maskedHead = `${head.slice(0, 1)}***`;
  return tail ? `${maskedLocal}@${maskedHead}.${tail}` : `${maskedLocal}@${maskedHead}`;
}

/** 把底层错误压成一行可入日志的 reason（截断 + 去换行），绝不回传邮件正文。 */
function summarizeError(err) {
  const code = typeof err?.code === 'string' ? err.code : '';
  const responseCode = err?.responseCode != null ? `smtp_${err.responseCode}` : '';
  const message = typeof err?.message === 'string' ? err.message : String(err ?? 'unknown');
  const flat = message.replace(/\s+/g, ' ').trim().slice(0, 120);
  const parts = [code || responseCode, flat].filter(Boolean);
  return parts.join(': ') || 'send_failed';
}

export function createMailer({ transport = 'disabled', from = null, smtp = {}, log = console, sendMailImpl } = {}) {
  const enabled = transport !== 'disabled';
  const smtpCfg = smtp ?? {};
  let transportImpl = null;

  function getTransport() {
    if (transportImpl) return transportImpl;
    const timeoutMs = Number(smtpCfg.connectionTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    transportImpl = nodemailer.createTransport({
      host: smtpCfg.host || '127.0.0.1',
      port: Number(smtpCfg.port ?? 587),
      secure: smtpCfg.secure === true,
      auth: smtpCfg.user ? { user: smtpCfg.user, pass: smtpCfg.password ?? '' } : undefined,
      connectionTimeout: timeoutMs,
      greetingTimeout: Number(smtpCfg.greetingTimeoutMs ?? timeoutMs),
      socketTimeout: Number(smtpCfg.socketTimeoutMs ?? timeoutMs),
    });
    return transportImpl;
  }

  async function send({ to, subject, text } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (typeof to !== 'string' || to.trim() === '') return { ok: false, reason: 'missing_recipient' };
    try {
      const impl = sendMailImpl ? { sendMail: sendMailImpl } : getTransport();
      await impl.sendMail({ from: from ?? undefined, to: to.trim(), subject, text });
      return { ok: true };
    } catch (err) {
      const reason = summarizeError(err);
      // 只记脱敏收件人 + reason：正文里有验证码，任何情况下都不进日志。
      log?.warn?.(`[mail] send failed to=${maskEmail(to)} reason=${reason}`);
      return { ok: false, reason };
    }
  }

  return { enabled, send };
}
