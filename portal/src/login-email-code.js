// 登录第二因素「邮箱验证码」的纯业务层（issue #449 后端切片 M1）。
//
// 边界（刻意收窄，便于单测与变异）：
//   * **不发邮件**——发信走 `ctx.mailer`（`portal/src/mailer.js`），本模块只产出/校验码；
//   * **不读 `process.env`**——配置由 `config.js` 注入（`loginEmailCode` 段）；
//   * **不碰 HTTP**——`now` / `random` 可注入 ⇒ 过期与重发冷却不需要 sleep、不需要真 SMTP。
//
// 表：`login_email_codes`（迁移 `deploy/migrations/0026-login-email-codes.sql`）。
// 一行一枚码；同一 pending 下「最新一条未消费」才是当前有效码（重发 = 插新行 + 作废旧行）。
//
// 口径（docs/api/portal.md §2.3a/§2.3b）：
//   * 码 = 6 位数字（`crypto.randomInt(0, 1_000_000)` 左补零），TTL 600s，单 pending 最多 5 次校验尝试；
//   * 只存 `sha256(code)`；比对用 `timingSafeEqual`（等长 hex buffer，长度不等先返回 false）；
//   * 校验成功是**一条** `UPDATE … WHERE consumed_at IS NULL AND expires_at > $now AND code_hash = $h
//     AND attempts < max_attempts … RETURNING id` ⇒ 并发/重放只会有一次成功；
//   * 码错 = `attempts + 1`（达到上限同时 `consumed_at = now` 作废），**pending 不失效**（用户可继续试）；
//   * 重发冷却 60s、单 pending 最多 3 次重发，都由本模块给出判据（HTTP 层只做映射）。

import crypto from 'node:crypto';

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_MODULUS = 1_000_000;

/**
 * 生成 6 位数字验证码（左补零）。`random` 可注入（测试用固定序列；签名同 `crypto.randomInt(max)`）。
 */
export function generateEmailCode({ random } = {}) {
  const draw = typeof random === 'function' ? random : (max) => crypto.randomInt(0, max);
  const n = draw(EMAIL_CODE_MODULUS);
  if (!Number.isInteger(n) || n < 0 || n >= EMAIL_CODE_MODULUS) {
    // 编程错误（注入的 random 违约）：宁可炸，也不要悄悄发出一枚「000000」。
    throw new RangeError(`random(${EMAIL_CODE_MODULUS}) 必须返回 [0, ${EMAIL_CODE_MODULUS}) 内的整数，收到 ${n}`);
  }
  return String(n).padStart(EMAIL_CODE_LENGTH, '0');
}

/** `sha256(code)` hex —— 与 `auth.hashToken` 同一写法（同一份 crypto 口径，不引入第二套哈希）。 */
export function hashEmailCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

/** 等长 hex 常量时间比对；长度不等/非 hex 先返回 false（绝不让 timingSafeEqual 抛长度错误）。 */
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || a.length !== b.length) return false;
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 写一枚验证码。返回 `{ id, codeHash, expiresAt }`（`id` 供重发时「作废旧码但保留新码」定位）。
 * `resendCount` 由 `recordResend` 给出（同一 pending 的累计重发次数）。
 */
export async function createEmailCode(
  pool,
  {
    pendingTokenHash,
    code,
    ttlSeconds = 600,
    maxAttempts = 5,
    resendCount = 0,
    ip = null,
    userAgent = null,
    now = new Date(),
  } = {},
) {
  const codeHash = hashEmailCode(code);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const res = await pool.query(
    `INSERT INTO login_email_codes
       (pending_token_hash, code_hash, created_at, expires_at, max_attempts, resend_count, created_ip, created_ua)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [pendingTokenHash, codeHash, now, expiresAt, maxAttempts, resendCount, ip, userAgent],
  );
  return { id: res.rows?.[0]?.id ?? null, codeHash, expiresAt };
}

/** 该 pending 下最新一条**未消费**的码（没有 = `not_found`）。 */
const SELECT_LATEST_UNCONSUMED = `SELECT id, code_hash, expires_at, attempts, max_attempts
   FROM login_email_codes
  WHERE pending_token_hash = $1 AND consumed_at IS NULL
  ORDER BY created_at DESC, id DESC
  LIMIT 1`;

/**
 * 校验验证码。返回 `{ok:true}` 或 `{ok:false, reason}`：
 *   `not_found`（不存在/已消费/并发重放）| `expired` | `mismatch` | `too_many_attempts`
 * HTTP 层把前三种与 `too_many_attempts` 一律映射成 `401 email_code_invalid`（不区分，防探测），
 * 只是 `too_many_attempts` 的 message 会说明「要重走第一步」。
 */
export async function verifyEmailCode(pool, { pendingTokenHash, code, now = new Date() } = {}) {
  if (typeof pendingTokenHash !== 'string' || pendingTokenHash === '') return { ok: false, reason: 'not_found' };
  const { rows } = await pool.query(SELECT_LATEST_UNCONSUMED, [pendingTokenHash]);
  const row = rows?.[0];
  if (!row) return { ok: false, reason: 'not_found' };

  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  if (!(expiresAt.getTime() > now.getTime())) return { ok: false, reason: 'expired' };

  const attempts = Number(row.attempts ?? 0);
  const maxAttempts = Number(row.max_attempts ?? 0);
  if (!(attempts < maxAttempts)) {
    // 已经用尽：顺手作废（幂等），别让这条码继续占着「最新未消费」的位置被反复探测。
    await pool.query(
      `UPDATE login_email_codes SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL`,
      [row.id, now],
    );
    return { ok: false, reason: 'too_many_attempts' };
  }

  const expected = hashEmailCode(code);
  if (!safeEqualHex(expected, row.code_hash)) {
    // 码错：必须落 attempts；达到上限时同一条语句作废（否则第 6 次还能接着试）。
    await pool.query(
      `UPDATE login_email_codes
          SET attempts = attempts + 1,
              consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN $2 ELSE consumed_at END
        WHERE id = $1 AND consumed_at IS NULL`,
      [row.id, now],
    );
    return { ok: false, reason: 'mismatch' };
  }

  // 成功：单条原子消费（并发/重放只有一个能占到；`rowCount === 0` ⇒ 已被人消费/过期）。
  const upd = await pool.query(
    `UPDATE login_email_codes
        SET consumed_at = $2
      WHERE pending_token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2
        AND code_hash = $3
        AND attempts < max_attempts
      RETURNING id`,
    [pendingTokenHash, now, expected],
  );
  const affected = upd.rowCount ?? upd.rows?.length ?? 0;
  if (affected === 0) return { ok: false, reason: 'not_found' };
  return { ok: true };
}

/**
 * 重发闸门（冷却 + 次数上限）。**只读判据 + 给出下一次的 `resendCount`**；写动作留给调用方
 * （先 `createEmailCode` 插新码，再 `invalidateOtherCodes` 作废旧码——先插后废保证「插失败」不会留下
 * 「一枚可用码都没有」的死状态；而校验只认最新未消费一条，所以这段窗口里旧码本来也不会被接受）。
 *
 * 返回：`{ok:true, resendCount, nextAllowedAt}` |
 *       `{ok:false, reason:'cooldown'|'max_resends', retryAfterSeconds}` |
 *       `{ok:false, reason:'not_found'}`（该 pending 下没有任何码 ⇒ HTTP 层按 `401 pending_expired`）。
 */
export async function recordResend(
  pool,
  { pendingTokenHash, cooldownSeconds = 60, maxResends = 3, now = new Date() } = {},
) {
  const { rows } = await pool.query(
    `SELECT id, resend_count, created_at
       FROM login_email_codes
      WHERE pending_token_hash = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [pendingTokenHash],
  );
  const row = rows?.[0];
  if (!row) return { ok: false, reason: 'not_found', retryAfterSeconds: 0 };

  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const elapsedSeconds = (now.getTime() - createdAt.getTime()) / 1000;
  if (elapsedSeconds < cooldownSeconds) {
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterSeconds: Math.max(1, Math.ceil(cooldownSeconds - elapsedSeconds)),
    };
  }

  const resendCount = Number(row.resend_count ?? 0);
  if (resendCount >= maxResends) {
    // 没有「再等一会儿就好了」的语义：次数用尽只能重走第一步（重试时间给 0，handler 仍会发 Retry-After 头）。
    return { ok: false, reason: 'max_resends', retryAfterSeconds: 0 };
  }

  return {
    ok: true,
    resendCount: resendCount + 1,
    nextAllowedAt: new Date(now.getTime() + cooldownSeconds * 1000),
  };
}

/**
 * 作废同一 pending 下**除新码之外**的所有未消费码（重发语义：旧码立即失效）。
 * `keepCodeHash` 必填：没有它就会把刚发出去的那枚也废掉（那是一个静默的「谁都登不进去」）。
 */
export async function invalidateOtherCodes(pool, { pendingTokenHash, keepCodeHash, now = new Date() } = {}) {
  if (typeof keepCodeHash !== 'string' || keepCodeHash === '') {
    throw new Error('invalidateOtherCodes 需要 keepCodeHash（否则会把新码一起作废）');
  }
  await pool.query(
    `UPDATE login_email_codes
        SET consumed_at = $2
      WHERE pending_token_hash = $1
        AND consumed_at IS NULL
        AND code_hash <> $3`,
    [pendingTokenHash, now, keepCodeHash],
  );
}

/**
 * 第二因素选择规则（纯函数，HTTP 层唯一的判据来源）。四分支：
 *   `totp_required`                    已注册 TOTP（现状一字不改）
 *   `email_code_required`              未注册 TOTP + 邮件通道启用 + 有邮箱
 *   `email_not_registered`             未注册 TOTP + 邮件通道启用 + **无邮箱** ⇒ 409，绝不静默退回口令
 *   `password_direct_no_second_factor` 邮件通道未启用（默认形态）⇒ 口令直通（审计 method 标明没有第二因素）
 */
export function chooseSecondFactor({ hasTotpEnrollment, mailEnabled, email } = {}) {
  if (hasTotpEnrollment === true) return 'totp_required';
  if (mailEnabled !== true) return 'password_direct_no_second_factor';
  if (typeof email === 'string' && email.trim() !== '') return 'email_code_required';
  return 'email_not_registered';
}
