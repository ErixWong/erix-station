// RFC 6238 TOTP（零依赖，node:crypto 自带 HMAC-SHA1 + base32 编解码自实现）。
// 依据：docs/api/portal.md §2.9.4（SHA-1 / 6 位 / 30s / ±1 窗口 / 单码防重放）。
// 说明：`digits`/`period`/`algorithm` 参数化，便于用 RFC 6238 附录 B（8 位 SHA-1）测试向量校验实现正确性；
//       业务侧固定 6 位 / 30s / SHA-1。

import crypto from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const DEFAULT_DIGITS = 6;
export const DEFAULT_PERIOD = 30;
export const DEFAULT_WINDOW = 1;
export const DEFAULT_ALGORITHM = 'sha1';

/** RFC 4648 base32 编码（去 padding，用于下发 TOTP 种子）。 */
export function base32Encode(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32 解码（兼容小写、空白与 padding）。非法字符抛错。 */
export function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[\s=]/g, '');
  const map = new Map([...BASE32_ALPHABET].map((c, i) => [c, i]));
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = map.get(c);
    if (idx === undefined) throw new Error(`invalid base32 character: ${c}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function hmac(secretBytes, data, algorithm = DEFAULT_ALGORITHM) {
  return crypto.createHmac(algorithm, secretBytes).update(data).digest();
}

/** RFC 4226 dynamic truncation → 31-bit 整数。 */
function dynamicTruncate(digest) {
  const offset = digest[digest.length - 1] & 0x0f;
  return (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  );
}

/** HOTP：给定 counter 生成 digits 位一次性口令（左补零）。 */
export function hotp(secret, counter, { digits = DEFAULT_DIGITS, algorithm = DEFAULT_ALGORITHM } = {}) {
  const key = typeof secret === 'string' ? base32Decode(secret) : Buffer.from(secret);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const code = dynamicTruncate(hmac(key, counterBuf, algorithm)) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** 按时间步（counter = floor(timeSeconds / period)）生成 TOTP。`time` 为毫秒时间戳。 */
export function totp(secret, { digits = DEFAULT_DIGITS, period = DEFAULT_PERIOD, algorithm = DEFAULT_ALGORITHM, time = Date.now() } = {}) {
  const step = Math.floor(time / 1000 / period);
  return hotp(secret, step, { digits, algorithm });
}

/** 直接按 step 生成（测试向量用，避免时间换算误差）。 */
export function totpAtStep(secret, step, { digits = DEFAULT_DIGITS, algorithm = DEFAULT_ALGORITHM } = {}) {
  return hotp(secret, step, { digits, algorithm });
}

function safeEqualString(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * 校验 TOTP（±window 步）。返回：
 *   { valid: true, step }      匹配到步长 step
 *   { valid: false, replay }   匹配但 step <= lastStep（单码防重放）
 *   { valid: false }           不匹配 / 格式非法
 */
export function verifyTotp(
  secret,
  code,
  { digits = DEFAULT_DIGITS, period = DEFAULT_PERIOD, window = DEFAULT_WINDOW, algorithm = DEFAULT_ALGORITHM, time = Date.now(), lastStep = null } = {},
) {
  if (typeof code !== 'string' || !/^\d+$/.test(code) || code.length !== digits) {
    return { valid: false };
  }
  const currentStep = Math.floor(time / 1000 / period);
  for (let s = currentStep - window; s <= currentStep + window; s++) {
    if (s < 0) continue;
    const expected = hotp(secret, s, { digits, algorithm });
    if (safeEqualString(expected, code)) {
      if (lastStep !== null && lastStep !== undefined && s <= lastStep) {
        return { valid: false, replay: true };
      }
      return { valid: true, step: s };
    }
  }
  return { valid: false };
}

/** 生成随机 TOTP 种子（默认 20 字节 → base32）。 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 生成 otpauth provisioning URI（认证器 App 扫码/录入用）。 */
export function otpauthUri(
  secret,
  { issuer, label, algorithm = 'SHA1', digits = DEFAULT_DIGITS, period = DEFAULT_PERIOD } = {},
) {
  const account = `${issuer}:${label}`;
  // 手工拼 query（encodeURIComponent → 空格 %20；URLSearchParams 会把空格转成表单风格的 +，部分认证器不认）。
  const q = [
    `secret=${encodeURIComponent(secret)}`,
    `issuer=${encodeURIComponent(String(issuer))}`,
    `algorithm=${encodeURIComponent(algorithm)}`,
    `digits=${encodeURIComponent(String(digits))}`,
    `period=${encodeURIComponent(String(period))}`,
  ].join('&');
  return `otpauth://totp/${encodeURIComponent(account)}?${q}`;
}
