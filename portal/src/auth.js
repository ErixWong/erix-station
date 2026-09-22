// 认证逻辑：两步登录（口令 → pending_token → TOTP → session）、session 只存 token_hash、
// timingSafeEqual 比较、过期/吊销/滚动续期。
// 依据：docs/api/portal.md §2.2/§2.3/§2.5（不透明 token 只存 sha256、强制 TOTP、滚动续期）、§2.9.4（口令哈希）。
// 口令哈希：P1 用 Node 内置 crypto.scrypt（零依赖），自描述格式 scrypt$N$r$p$salt$hash；
//   argon2id 待决策者确认后按自描述哈希平滑迁移。解析失败一律按认证失败处理（绝不 500、绝不跑 scrypt）。

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import * as totpLib from './totp.js';

const randomBytesAsync = promisify(crypto.randomBytes);
const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// 存储格式允许范围（防畸形/恶意参数触发 OOM 或 500）。N 必须为 2 的幂且在区间内。
const SCRYPT_N_MIN = 1 << 14; // 16384
const SCRYPT_N_MAX = 1 << 17; // 131072
const SCRYPT_R_MAX = 16;
const SCRYPT_P_MAX = 8;
const SCRYPT_SALT_HEX_MAX = 128; // 64 字节
const SCRYPT_SALT_HEX_MIN = 8; // 4 字节

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const INT_RE = /^\d+$/;
const HEX_RE = /^[0-9a-fA-F]+$/;

/** sha256 hex：session cookie / pending token 只存这个，绝不存原文（portal.md §2.5）。 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function generateSessionToken() {
  return (await randomBytesAsync(32)).toString('base64url');
}

export async function generatePendingToken() {
  return `pt_${(await randomBytesAsync(32)).toString('base64url')}`;
}

/**
 * 严格解析自描述口令哈希。任何非法 → 返回 null（调用方按认证失败处理）。
 * 校验项：算法名白名单、N/r/p 允许范围内整数、salt/hash 偶数长度合法 hex、
 *        keylen 固定 64（不由 DB 内容决定）。
 */
export function parseStoredHash(stored) {
  if (typeof stored !== 'string' || stored.length === 0 || stored.length > 512) return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [algo, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (algo !== 'scrypt') return null; // 算法名白名单（当前仅 scrypt）
  if (!INT_RE.test(nStr) || !INT_RE.test(rStr) || !INT_RE.test(pStr)) return null;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return null;
  if (N < SCRYPT_N_MIN || N > SCRYPT_N_MAX || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > SCRYPT_R_MAX) return null;
  if (p < 1 || p > SCRYPT_P_MAX) return null;
  if (!HEX_RE.test(saltHex) || saltHex.length % 2 !== 0) return null;
  if (saltHex.length < SCRYPT_SALT_HEX_MIN || saltHex.length > SCRYPT_SALT_HEX_MAX) return null;
  // 固定 keylen=64：hash 必须恰为 64 字节（128 hex），不允许由 DB 内容决定输出长度。
  if (!HEX_RE.test(hashHex) || hashHex.length !== SCRYPT_KEYLEN * 2) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return null;
  return { algo, N, r, p, salt, expected };
}

/** 用已解析参数派生并常量时间比对。仅在参数已通过 parseStoredHash 校验后调用。 */
async function deriveAndCompare(password, parsed) {
  const derived = await scryptAsync(password, parsed.salt, SCRYPT_KEYLEN, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: 128 * parsed.N * parsed.r * 2,
  });
  if (derived.length !== parsed.expected.length) return false; // timingSafeEqual 前显式核对长度
  return crypto.timingSafeEqual(derived, parsed.expected);
}

/** 自描述口令哈希：scrypt$N$r$p$salt$derivedHex。salt 以 hex 存储，派生时用二进制。 */
export async function hashPassword(password, opts = {}) {
  const saltBuf = opts.salt ? Buffer.from(opts.salt, 'hex') : await randomBytesAsync(16);
  const derived = await scryptAsync(password, saltBuf, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${saltBuf.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

/** 校验口令。解析失败/口令不符一律 false（不抛错、不 500）。 */
export async function verifyPassword(password, stored, { log } = {}) {
  const parsed = parseStoredHash(stored);
  if (!parsed) {
    log?.warn?.('[auth] malformed password_hash rejected (auth failed)');
    return false;
  }
  return deriveAndCompare(password, parsed);
}

let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('erix-station-dummy-password-for-timing');
  return dummyHashPromise;
}

/**
 * 校验登录凭据（第一步：口令）。用户不存在时也跑一次 scrypt 拉平时序（防用户枚举）。
 * 返回 { ok, user } 或 { ok:false, reason: 'invalid_credentials' | 'malformed_hash' }。
 */
export async function authenticate(pool, login, password, { log } = {}) {
  const res = await pool.query(
    `SELECT id, login, display_name, role, fde_name, auth_source, status, password_hash
       FROM users WHERE login = $1 AND status = 'active'`,
    [login],
  );
  const row = res.rows?.[0];
  let valid = false;
  let malformed = false;
  if (row) {
    const parsed = parseStoredHash(row.password_hash);
    if (!parsed) {
      malformed = true;
      log?.warn?.(`[auth] malformed password_hash for login=${JSON.stringify(login)} (treated as auth failure)`);
      await verifyPassword(password, await getDummyHash()); // 拉平时序，但绝不按坏参数跑 scrypt
    } else {
      valid = await deriveAndCompare(password, parsed);
    }
  } else {
    await verifyPassword(password, await getDummyHash());
  }
  if (!valid) return { ok: false, reason: malformed ? 'malformed_hash' : 'invalid_credentials' };
  return {
    ok: true,
    user: {
      id: row.id,
      login: row.login,
      display_name: row.display_name,
      role: row.role,
      fde_name: row.fde_name,
      auth_source: row.auth_source,
    },
  };
}

/** 建立第一步的待决令牌：只存 sha256(token)，短期、绑定 user、单次消费。 */
export async function createPendingToken(
  pool,
  userId,
  { ip = null, userAgent = null, ttlSeconds = 120, now = new Date() } = {},
) {
  const token = await generatePendingToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO login_pending (user_id, token_hash, created_at, expires_at, created_ip, created_ua)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, tokenHash, now, expiresAt, ip, userAgent],
  );
  return { token, tokenHash, expiresAt };
}

/**
 * 非消费读取待决令牌（TOTP 失败可重试，不烧 token）：返回 userId 或 null（过期/已用/不存在）。
 */
export async function findPendingUser(pool, token, { now = new Date() } = {}) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `SELECT user_id FROM login_pending
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
    [tokenHash, now],
  );
  return res.rows?.[0]?.user_id ?? null;
}

/**
 * 单次原子消费待决令牌：`UPDATE ... WHERE used_at IS NULL AND expires_at > now()`。
 * 仅在 TOTP 校验成功后调用；返回 userId；过期/已用/不存在 → null。
 */
export async function consumePendingToken(pool, token, { now = new Date() } = {}) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `UPDATE login_pending SET used_at = $2
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
      RETURNING user_id`,
    [tokenHash, now],
  );
  return res.rows?.[0]?.user_id ?? null;
}

/**
 * 校验某用户的 TOTP（窗口 ±1 + 单码防重放 + last_totp_step 原子推进）。
 * 返回 { ok, user } 或 { ok:false, reason: 'totp_invalid' | 'totp_replay' }。
 * 畸形 totp_secret（非法 base32）一律按认证失败处理（不 500）。
 */
export async function verifyTotpForUser(
  pool,
  userId,
  code,
  {
    now = new Date(),
    digits = totpLib.DEFAULT_DIGITS,
    period = totpLib.DEFAULT_PERIOD,
    window = totpLib.DEFAULT_WINDOW,
    log,
  } = {},
) {
  const res = await pool.query(
    `SELECT id, login, display_name, role, fde_name, auth_source, totp_secret, last_totp_step
       FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const row = res.rows?.[0];
  if (!row || !row.totp_secret) return { ok: false, reason: 'totp_invalid' };
  const lastStep = row.last_totp_step == null ? null : Number(row.last_totp_step);
  let result;
  try {
    result = totpLib.verifyTotp(row.totp_secret, code, {
      digits,
      period,
      window,
      time: now.getTime(),
      lastStep,
    });
  } catch (err) {
    // 非法 base32 等畸形种子：按认证失败处理，绝不 500。
    log?.warn?.(`[auth] malformed totp_secret for user=${userId} (treated as totp_invalid)`);
    return { ok: false, reason: 'totp_invalid' };
  }
  if (!result.valid) {
    return { ok: false, reason: result.replay ? 'totp_replay' : 'totp_invalid' };
  }
  // 原子推进 last_totp_step（并发下仅一次成功，其余按重放拒绝）。
  const upd = await pool.query(
    `UPDATE users SET last_totp_step = $2
      WHERE id = $1 AND (last_totp_step IS NULL OR last_totp_step < $2)
      RETURNING id`,
    [userId, result.step],
  );
  if (!upd.rows?.[0]) return { ok: false, reason: 'totp_replay' };
  return {
    ok: true,
    user: {
      id: row.id,
      login: row.login,
      display_name: row.display_name,
      role: row.role,
      fde_name: row.fde_name,
      auth_source: row.auth_source,
    },
  };
}

/** 建立会话：生成不透明 token，只把 sha256(token) 写入 login_sessions。 */
/** 用户是否已注册 TOTP（totp_secret 非空）。未注册 → 登录口令直通建会话（跳过第二因素）。 */
export async function hasTotpEnrollment(pool, userId) {
  const { rows } = await pool.query(
    'SELECT 1 FROM users WHERE id = $1 AND totp_secret IS NOT NULL',
    [userId],
  );
  return rows.length > 0;
}

export async function createSession(
  pool,
  userId,
  { ip = null, userAgent = null, ttlSeconds = DEFAULT_SESSION_TTL_SECONDS, now = new Date() } = {},
) {
  const token = await generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  await pool.query(
    `INSERT INTO login_sessions (user_id, token_hash, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $3, $5, $6)`,
    [userId, tokenHash, now, expiresAt, ip, userAgent],
  );
  return { token, tokenHash, expiresAt };
}

/** 按 token 哈希查活跃会话，返回 { user, session } 或 null（过期/吊销均拒绝）。 */
export async function findSessionUser(pool, token, { now = new Date() } = {}) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashToken(token);
  const res = await pool.query(
    `SELECT u.id, u.login, u.display_name, u.role, u.fde_name, u.auth_source, u.status,
            s.id AS session_id, s.expires_at, s.last_seen_at
       FROM login_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > $2
        AND u.status = 'active'`,
    [tokenHash, now],
  );
  const row = res.rows?.[0];
  if (!row) return null;
  return {
    user: {
      id: row.id,
      login: row.login,
      display_name: row.display_name,
      role: row.role,
      fde_name: row.fde_name,
      auth_source: row.auth_source,
    },
    session: {
      id: row.session_id,
      expires_at: row.expires_at,
      last_seen_at: row.last_seen_at,
    },
  };
}

/**
 * 滚动续期：距上次续期超过 renewIntervalMs 才写库（避免每个请求都写）。
 * 滚动语义（portal.md §2.5）：last_seen_at = 本次活动时间，expires_at = 本次活动 + TTL。
 * 返回新的 expires_at（Date）表示已续期，否则 null。
 */
export async function renewSession(
  pool,
  sessionId,
  { ttlSeconds = DEFAULT_SESSION_TTL_SECONDS, renewIntervalMs = 60 * 60 * 1000, now = new Date() } = {},
) {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
  const cutoff = new Date(now.getTime() - renewIntervalMs);
  const res = await pool.query(
    `UPDATE login_sessions
        SET expires_at = $2, last_seen_at = $3
      WHERE id = $1
        AND revoked_at IS NULL
        AND last_seen_at < $4
      RETURNING expires_at`,
    [sessionId, expiresAt, now, cutoff],
  );
  return res.rows?.[0]?.expires_at ?? null;
}

/** 吊销单条会话（portal.md §2.4/§2.5）。 */
export async function revokeSession(pool, token) {
  if (!token || typeof token !== 'string') return;
  await pool.query(
    `UPDATE login_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}

/** 写审计（best-effort，失败不阻断主流程）。 */
export async function audit(pool, { actorId = null, action, target = '', details = {} } = {}) {
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
    [actorId, action, target, JSON.stringify(details)],
  );
}
