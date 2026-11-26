// issue #736：API 令牌。长期 runner / 脚本 / agent 用它访问 API，
// 不再「登录换 cookie」、不再寄邮件。
// 依据：docs/api/portal.md §2.13（签发/吊销/认证缝）、docs/data/model.md §1.3、
// DDL docs/data/schema.sql:128。
// 口径：明文只在签发响应里出现一次；库里只存 sha256(明文) 的 hex
// （与会话 token_hash 同口径，auth.js）。
// 不设过期（表里没有 expires_at），靠吊销；scopes 本期只支持空数组。

import crypto from 'node:crypto';

// 明文格式：`st_` + base64url(32 字节随机)，约 45 字符（§2.13 设计口径）。
const TOKEN_PREFIX = 'st_';
const TOKEN_BYTES = 32;

// last_used_at 节流窗口（§2.13 设计点 8：只在超窗时用一条条件 UPDATE 写，
// 不许先读再写）。
const TOUCH_INTERVAL_SQL = "now() - interval '5 minutes'";

/** sha256 hex：与会话 token_hash 同口径（auth.js:34 createHash('sha256')…hex）。 */
export function hashApiToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 生成一枚新令牌明文（不落库；调用方负责写库与「只出一次」）。 */
export function generateApiToken() {
  return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 签发：INSERT 一条 api_tokens（id/scopes/created_at 走 DDL 默认）。
 * `ON CONFLICT (user_id, name) DO NOTHING` ⇒ 同账号重名（含已吊销，
 * 因吊销不删行）返回空 rows，
 * 调用方据此转 409 `token_name_taken`（§2.13，别让它冒 500）。
 * @returns {Promise<{id,name,scopes,created_at}|null>} null = 撞名。
 */
export async function mintToken(pool, { userId, name, tokenHash }) {
  const res = await pool.query(
    `INSERT INTO api_tokens (user_id, name, token_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO NOTHING
     RETURNING id, name, scopes, created_at`,
    [userId, name, tokenHash],
  );
  return res.rows?.[0] ?? null;
}

/**
 * 认证查表：按明文 sha256 找「未吊销令牌 + 活跃用户」。
 * SELECT 出与 `findSessionUser` 同一片用户列（含 must_change_password /
 * file_upload_enabled），
 * 好让下游 handler 拿到**同一个形状**（§2.13 设计点 10）。
 * @returns {Promise<object|null>} 令牌行联用户列，或 null（未知/吊销/非活跃）。
 */
export async function findActiveByToken(pool, token) {
  if (!token || typeof token !== 'string') return null;
  const tokenHash = hashApiToken(token);
  const res = await pool.query(
    `SELECT t.id AS token_id, t.name, t.scopes, t.created_at, t.last_used_at,
            u.id, u.login, u.display_name, u.role, u.fde_name, u.auth_source,
            u.status, u.must_change_password, u.file_upload_enabled, u.locale
       FROM api_tokens t
       JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND u.status = 'active'`,
    [tokenHash],
  );
  return res.rows?.[0] ?? null;
}

/**
 * 认证缝入口：把令牌行折成**与 cookie 会话同一个对象**（下游不改），
 * 只多挂 `viaToken:true`（供审计/日志区分，§2.13 设计点 10）。
 * `session.id = null`：api_tokens 无 login_sessions 行 ⇒ 续期 `WHERE id = $1`
 * 命中 0 行 ⇒
 * 不发 `Set-Cookie`（§2.13 设计点 7），无需下游特判。
 * @returns {Promise<object|null>} `{ user, token, session, viaToken:true }` 或 null。
 */
export async function findApiTokenUser(pool, token) {
  const row = await findActiveByToken(pool, token);
  if (!row) return null;
  return {
    user: {
      id: row.id,
      login: row.login,
      display_name: row.display_name,
      role: row.role,
      fde_name: row.fde_name,
      auth_source: row.auth_source,
      // 与会话同口径：判据 `=== true`，显式收布尔（旧驱动可能给 'f'）。
      file_upload_enabled: row.file_upload_enabled === true,
      // 受限会话门（#255）读这一项：`must_change_password` 的账号拿 token
      // 同样受限（设计点 11）。
      must_change_password: row.must_change_password === true,
      // #828 P1：账号级语言偏好。token 认证路径打的 `GET /api/me` 与 cookie 路径是同一个端点
      // ⇒ DTO 必须同形（少一键就是缺陷，被 api-tokens.test.js②「两条认证路径 user 逐字段一致」抓）。
      locale: row.locale ?? null,
    },
    token: {
      id: row.token_id,
      name: row.name,
      scopes: row.scopes ?? [],
      created_at: row.created_at,
      last_used_at: row.last_used_at,
    },
    session: {
      id: null,
      expires_at: null,
      last_seen_at: row.last_used_at,
    },
    viaToken: true,
  };
}

/**
 * 节流写 last_used_at：只在「从未用过」或「距上次超 5 分钟」时写，
 * 用一条条件 UPDATE 完成
 * （§2.13 设计点 8：不许先读再写）。best-effort：调用方 `.catch(() => {})`。
 */
export async function touchToken(pool, tokenId) {
  if (!tokenId) return null;
  const res = await pool.query(
    `UPDATE api_tokens SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < ${TOUCH_INTERVAL_SQL})
      RETURNING id`,
    [tokenId],
  );
  return res.rows?.[0]?.id ?? null;
}

/**
 * 列某用户的令牌（不返 hash；含已吊销；按创建时间升序，§2.13）。
 * @returns {Promise<Array<{id,name,scopes,created_at,last_used_at,revoked_at}>>}
 */
export async function listTokens(pool, userId) {
  const res = await pool.query(
    `SELECT id, name, scopes, created_at, last_used_at, revoked_at
       FROM api_tokens
      WHERE user_id = $1
      ORDER BY created_at ASC`,
    [userId],
  );
  return res.rows ?? [];
}

/**
 * 吊销（幂等，§2.13 设计点 9）：按 user_id 过滤（防横向吊销 ⇒ 404）。
 * @returns {Promise<{outcome:'revoked'|'already'|'missing', name:string|null}>}
 *   'revoked' 本次置吊销（name 供审计）；'already' 早已吊销（幂等 200，
 *   already_revoked:true）；'missing' 该账号下查无此令牌（404）。
 */
export async function revokeToken(pool, { userId, tokenId }) {
  const upd = await pool.query(
    `UPDATE api_tokens SET revoked_at = now()
      WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL
      RETURNING id, name`,
    [userId, tokenId],
  );
  const row = upd.rows?.[0];
  if (row) return { outcome: 'revoked', name: row.name ?? null };
  const exists = await pool.query(
    'SELECT 1 FROM api_tokens WHERE user_id = $1 AND id = $2',
    [userId, tokenId],
  );
  if (exists.rows?.length) return { outcome: 'already', name: null };
  return { outcome: 'missing', name: null };
}

/** 按 login 解析目标用户 id（管理员代签用）；不存在 → null（404）。 */
export async function findUserIdByLogin(pool, login) {
  if (!login || typeof login !== 'string') return null;
  const res = await pool.query(
    'SELECT id FROM users WHERE login = $1',
    [login],
  );
  return res.rows?.[0]?.id ?? null;
}
