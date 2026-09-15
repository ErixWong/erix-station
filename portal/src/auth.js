// 认证逻辑：session 只存 token_hash、timingSafeEqual 比较、过期与吊销。
// 依据：docs/api/portal.md §2.5（不透明 token，只存 sha256）、§2.9.4（口令哈希）。
// 口令哈希：P1 skeleton 用 Node 内置 crypto.scrypt（零依赖），自描述格式
//   scrypt$N$r$p$salt$hash；argon2id 待决策者确认后按自描述哈希平滑迁移（见 portal.md §2.9.4）。

import crypto from 'node:crypto';
import { promisify } from 'node:util';

const randomBytesAsync = promisify(crypto.randomBytes);
const scryptAsync = promisify(crypto.scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** sha256 hex：session cookie 只存这个，绝不存原文（portal.md §2.5）。 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function generateSessionToken() {
  return (await randomBytesAsync(32)).toString('base64url');
}

/** 自描述口令哈希：scrypt$N$r$p$salt$derivedHex。 */
export async function hashPassword(password, opts = {}) {
  const salt = opts.salt ?? (await randomBytesAsync(16)).toString('hex');
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${Buffer.from(derived).toString('hex')}`;
}

/** 校验口令（timingSafeEqual）；支持将来新增 algo 的可插拔解析。 */
export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, salt, expectedHex] = parts;
  let expected;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  const derived = await scryptAsync(password, salt, expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });
  return crypto.timingSafeEqual(derived, expected);
}

let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('erix-station-dummy-password-for-timing');
  return dummyHashPromise;
}

/**
 * 校验登录凭据。用户不存在时也跑一次 scrypt，拉平时序（防用户枚举，portal.md §2.2）。
 */
export async function authenticate(pool, login, password) {
  const res = await pool.query(
    `SELECT id, login, display_name, role, fde_name, auth_source, status, password_hash
       FROM users WHERE login = $1 AND status = 'active'`,
    [login],
  );
  const row = res.rows?.[0];
  let valid = false;
  if (row) {
    valid = await verifyPassword(password, row.password_hash);
  } else {
    await verifyPassword(password, await getDummyHash());
  }
  if (!valid) return { ok: false, reason: 'invalid_credentials' };
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
            s.id AS session_id, s.expires_at
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
    session: { id: row.session_id, expires_at: row.expires_at },
  };
}

/** 吊销单条会话（portal.md §2.4/§2.5）。 */
export async function revokeSession(pool, token) {
  if (!token || typeof token !== 'string') return;
  await pool.query(
    `UPDATE login_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
}
