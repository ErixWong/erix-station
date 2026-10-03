// admin 用户管理（issue #38 Phase B2 admin UI 服务端）：建 FDE 用户 / 用户列表 / active run 判定。
//
// 密码 hash 与 TOTP 生成**复用** auth.js / totp.js 的既有逻辑（与 cli.js bootstrap-admin 同口径：
// scrypt 自描述哈希 + 20 字节 base32 种子）。totp_secret 只在创建响应出现一次（红线），
// 列表与任何其它端点不回显；密码哈希永不出现。

import * as auth from './auth.js';
import * as totp from './totp.js';
import { FDE_NAME_RE } from './projects.js';

export class AdminError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

const safeUser = (row) => ({
  id: row.id,
  login: row.login,
  display_name: row.display_name,
  role: row.role,
  fde_name: row.fde_name ?? null,
  git_host_id: row.git_host_id ?? null,
  auth_source: row.auth_source,
  status: row.status,
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

/** 用户列表（无敏感字段：无 password_hash / totp_secret / email）。 */
export async function listUsers(pool) {
  const r = await pool.query(
    `SELECT id, login, display_name, role, fde_name, auth_source, status, created_at,
            (SELECT git_host_id FROM fde_git_accounts a WHERE a.fde_id = users.id) AS git_host_id
       FROM users ORDER BY created_at ASC, login ASC`,
  );
  return { items: r.rows.map(safeUser) };
}

/**
 * 建 FDE 用户（role='fde'、auth_source='local'、status='active'，TOTP 强制）。
 * @returns { user, totp_secret, totp_uri } —— totp_secret 仅此一次下发（调用方不得再读/再显）。
 */
export async function createUser(pool, { actorId = null, login, display_name, password, fde_name, totpIssuer = 'erix-station', limits = {} } = {}) {
  const maxLogin = limits.maxLoginLength ?? 128;
  const maxPassword = limits.maxPasswordLength ?? 256;
  if (typeof login !== 'string' || login.trim() === '') {
    throw new AdminError('validation_failed', 'login 为必填字段', { details: { field: 'login' } });
  }
  const trimmedLogin = login.trim();
  if (trimmedLogin.length > maxLogin) {
    throw new AdminError('validation_failed', `login 长度超过上限 ${maxLogin}`, { details: { field: 'login' } });
  }
  if (typeof password !== 'string' || password.length === 0) {
    throw new AdminError('validation_failed', 'password 为必填字段', { details: { field: 'password' } });
  }
  if (password.length > maxPassword) {
    throw new AdminError('validation_failed', `password 长度超过上限 ${maxPassword}`, { details: { field: 'password' } });
  }
  if (fde_name !== undefined && fde_name !== null && !FDE_NAME_RE.test(fde_name)) {
    throw new AdminError('validation_failed', 'fde_name 非法（小写字母/数字/连字符，≤63）', { details: { field: 'fde_name' } });
  }

  const dup = await pool.query(`SELECT 1 FROM users WHERE login = $1`, [trimmedLogin]);
  if (dup.rows.length > 0) {
    throw new AdminError('login_conflict', `login ${trimmedLogin} 已存在`, { httpStatus: 409 });
  }
  if (fde_name != null) {
    const dupFde = await pool.query(`SELECT 1 FROM users WHERE fde_name = $1`, [fde_name]);
    if (dupFde.rows.length > 0) {
      throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { httpStatus: 409 });
    }
  }

  const passwordHash = await auth.hashPassword(password); // 与 bootstrap-admin 同口径（scrypt 自描述）
  const totpSecret = totp.generateSecret(20);
  const r = await pool.query(
    `INSERT INTO users (login, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)
     VALUES ($1, $2, 'fde', 'local', 'active', $3, $4, $5)
     RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at`,
    [trimmedLogin, typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : trimmedLogin, passwordHash, totpSecret, fde_name ?? null],
  );
  const user = safeUser(r.rows[0]);
  const totpUri = totp.otpauthUri(totpSecret, { issuer: totpIssuer, label: user.login });
  // 审计：details 不含口令/种子（红线）。
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, 'admin.user_created', $2, $3)`,
    [actorId, trimmedLogin, JSON.stringify({ login: trimmedLogin, fde_name: fde_name ?? null })],
  ).catch(() => {});
  return { user, totp_secret: totpSecret, totp_uri: totpUri };
}

/**
 * 该 FDE 是否有 queued/running/cancelling 的 run（口径同 sessions.js ACTIVE_RUN_STATES）。
 * admin UI 用它提示「换 provider 影响进行中的 run」。
 */
export async function fdeHasActiveRun(pool, userId) {
  const r = await pool.query(
    `SELECT 1
       FROM runs r
       JOIN chat_sessions s ON s.id = r.session_id
      WHERE s.user_id = $1 AND r.status IN ('queued', 'running', 'cancelling')
      LIMIT 1`,
    [userId],
  );
  return r.rows.length > 0;
}
