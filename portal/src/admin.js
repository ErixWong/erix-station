// admin 用户管理（issue #38 Phase B2 / issue #128）：用户 CRUD / 凭据重置 / active run 判定。
//
// 密码 hash 与 TOTP 生成**复用** auth.js / totp.js 的既有逻辑（与 cli.js bootstrap-admin 同口径：
// scrypt 自描述哈希 + 20 字节 base32 种子）。totp_secret 只在创建响应出现一次（红线），
// 列表与任何其它端点不回显；密码哈希永不出现。

import * as auth from './auth.js';
import * as totp from './totp.js';
import * as projects from './projects.js';

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
  totp_enabled: Boolean(row.totp_enabled),
  last_login_at: row.last_login_at instanceof Date ? row.last_login_at.toISOString() : row.last_login_at ?? null,
  created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
});

function validatePassword(password, limits = {}) {
  const maxPassword = limits.maxPasswordLength ?? 256;
  if (typeof password !== 'string' || password.length === 0) {
    throw new AdminError('validation_failed', 'password 为必填字段', { details: { field: 'password' } });
  }
  if (password.length > maxPassword) {
    throw new AdminError('validation_failed', `password 长度超过上限 ${maxPassword}`, { details: { field: 'password' } });
  }
}

function recordAdminAudit(pool, actorId, action, target, details = {}) {
  return pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
    [actorId, action, target, JSON.stringify(details)],
  ).catch(() => {});
}

/** 用户列表（无敏感字段：无 password_hash / totp_secret / email）。 */
export async function listUsers(pool) {
  const r = await pool.query(
    `SELECT users.id, users.login, users.display_name, users.role, users.fde_name,
            users.auth_source, users.status, users.created_at,
            (users.totp_secret IS NOT NULL) AS totp_enabled,
            sessions.last_login_at,
            (SELECT git_host_id FROM fde_git_accounts a WHERE a.fde_id = users.id) AS git_host_id
       FROM users
       LEFT JOIN (
         SELECT user_id, MAX(created_at) AS last_login_at
           FROM login_sessions
          GROUP BY user_id
       ) sessions ON sessions.user_id = users.id
      ORDER BY users.created_at ASC, users.login ASC`,
  );
  return { items: r.rows.map(safeUser) };
}

/**
 * 建 FDE 用户（role='fde'、auth_source='local'、status='active'；默认不启用 TOTP，见 issue #139）。
 * @returns { { user } | { user, totp_secret, totp_uri } } —— 启用时种子仅此一次下发（调用方不得再读/再显）。
 */
export async function createUser(pool, { actorId = null, login, display_name, password, fde_name, totp_enabled = false, totpIssuer = 'erix-station', limits = {} } = {}) {
  const maxLogin = limits.maxLoginLength ?? 128;
  const maxPassword = limits.maxPasswordLength ?? 256;
  if (typeof login !== 'string' || login.trim() === '') {
    throw new AdminError('validation_failed', 'login 为必填字段', { details: { field: 'login' } });
  }
  const trimmedLogin = login.trim();
  if (trimmedLogin.length > maxLogin) {
    throw new AdminError('validation_failed', `login 长度超过上限 ${maxLogin}`, { details: { field: 'login' } });
  }
  validatePassword(password, { maxPasswordLength: maxPassword });
  if (fde_name !== undefined && fde_name !== null && !projects.validateFdeName(fde_name).ok) {
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
  const totpSecret = totp_enabled === true ? totp.generateSecret(20) : null;
  const r = await pool.query(
    `INSERT INTO users (login, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)
     VALUES ($1, $2, 'fde', 'local', 'active', $3, $4, $5)
     RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at,
               (totp_secret IS NOT NULL) AS totp_enabled`,
    [trimmedLogin, typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : trimmedLogin, passwordHash, totpSecret, fde_name ?? null],
  );
  const user = safeUser(r.rows[0]);
  const totpUri = totpSecret ? totp.otpauthUri(totpSecret, { issuer: totpIssuer, label: user.login }) : null;
  // 审计：details 不含口令/种子（红线）。
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, 'admin.user_created', $2, $3)`,
    [actorId, trimmedLogin, JSON.stringify({ login: trimmedLogin, fde_name: fde_name ?? null })],
  ).catch(() => {});
  return totpSecret
    ? { user, totp_secret: totpSecret, totp_uri: totpUri }
    : { user };
}

/** 更新管理员允许编辑的用户字段；禁用时原子吊销已有登录会话。 */
export async function updateUser(pool, userId, updates, { actorId = null } = {}) {
  if (updates === null || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new AdminError('validation_failed', '请求体必须是对象');
  }
  const fields = Object.keys(updates);
  if (fields.length === 0) {
    throw new AdminError('validation_failed', '至少提供一个可更新字段');
  }
  const allowed = new Set(['display_name', 'role', 'fde_name', 'status']);
  for (const field of fields) {
    if (field === 'login') {
      throw new AdminError('validation_failed', 'login 不可修改', { details: { field: 'login' } });
    }
    if (!allowed.has(field)) {
      throw new AdminError('validation_failed', `不支持更新字段 ${field}`, { details: { field } });
    }
  }

  if (Object.hasOwn(updates, 'role') && !['fde', 'admin'].includes(updates.role)) {
    throw new AdminError('validation_failed', "role 只允许 'fde' 或 'admin'", { details: { field: 'role' } });
  }
  if (Object.hasOwn(updates, 'status') && !['active', 'disabled'].includes(updates.status)) {
    throw new AdminError('validation_failed', "status 只允许 'active' 或 'disabled'", { details: { field: 'status' } });
  }
  if (Object.hasOwn(updates, 'fde_name')
      && updates.fde_name !== null
      && !projects.validateFdeName(updates.fde_name).ok) {
    throw new AdminError('validation_failed', 'fde_name 非法（小写字母/数字/连字符，≤63）', { details: { field: 'fde_name' } });
  }
  if (Object.hasOwn(updates, 'display_name') && typeof updates.display_name !== 'string') {
    throw new AdminError('validation_failed', 'display_name 必须是字符串', { details: { field: 'display_name' } });
  }

  const existing = await pool.query(`SELECT id, login FROM users WHERE id = $1`, [userId]);
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  const current = existing.rows[0];

  if (Object.hasOwn(updates, 'fde_name') && updates.fde_name != null) {
    const duplicate = await pool.query(
      `SELECT 1 FROM users WHERE fde_name = $1 AND id <> $2`,
      [updates.fde_name, userId],
    );
    if (duplicate.rows.length > 0) {
      throw new AdminError('fde_name_conflict', `fde_name ${updates.fde_name} 已被占用`, { httpStatus: 409 });
    }
  }

  const params = [userId];
  const assignments = [];
  const setField = (column, value) => {
    params.push(value);
    assignments.push(`${column} = $${params.length}`);
  };
  if (Object.hasOwn(updates, 'display_name')) {
    const value = updates.display_name.trim();
    setField('display_name', value || current.login);
  }
  if (Object.hasOwn(updates, 'role')) setField('role', updates.role);
  if (Object.hasOwn(updates, 'fde_name')) setField('fde_name', updates.fde_name);
  if (Object.hasOwn(updates, 'status')) {
    params.push(updates.status);
    assignments.push(`status = $${params.length}`);
    assignments.push(`disabled_at = CASE WHEN $${params.length} = 'disabled' THEN now() ELSE NULL END`);
  }

  let result;
  try {
    result = await pool.query(
      `WITH updated AS (
         UPDATE users SET ${assignments.join(', ')}
          WHERE id = $1
          RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at,
                    (totp_secret IS NOT NULL) AS totp_enabled
       ), revoked AS (
         UPDATE login_sessions SET revoked_at = now()
          WHERE user_id = (SELECT id FROM updated)
            AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM updated WHERE status = 'disabled')
          RETURNING id
       )
       SELECT updated.*, NULL::timestamptz AS last_login_at FROM updated`,
      params,
    );
  } catch (err) {
    if (err?.code === '23505' && err?.constraint === 'users_fde_name_key') {
      throw new AdminError('fde_name_conflict', `fde_name ${updates.fde_name} 已被占用`, { httpStatus: 409 });
    }
    throw err;
  }
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  await recordAdminAudit(pool, actorId, 'admin.user_updated', current.login, {
    fields: fields.filter((field) => field !== 'login'),
  });
  return { user: safeUser(result.rows[0]) };
}

/** 删除用户；活动资源与 run 先 fail closed，登录令牌因 FK 无级联而显式清理。 */
export async function deleteUser(pool, { actorId, userId } = {}) {
  if (actorId === userId) {
    throw new AdminError('self_delete', '管理员不能删除自己的账号', { httpStatus: 409 });
  }

  let deletedLogin;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT id, login FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!target.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
    deletedLogin = target.rows[0].login;

    const container = await client.query(
      `SELECT 1 FROM containers WHERE user_id = $1 AND status <> 'removed' LIMIT 1`,
      [userId],
    );
    const activeRun = await client.query(
      `SELECT 1
         FROM runs r
         JOIN chat_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1 AND r.status IN ('queued', 'running', 'cancelling')
        LIMIT 1`,
      [userId],
    );
    if (container.rows.length > 0 || activeRun.rows.length > 0) {
      throw new AdminError(
        'user_has_active_fde',
        '用户仍有关联的 FDE 容器或未终结 run，请先完成下线',
        { httpStatus: 409 },
      );
    }

    await client.query(`DELETE FROM login_sessions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM login_pending WHERE user_id = $1`, [userId]);
    const deleted = await client.query(`DELETE FROM users WHERE id = $1 RETURNING id`, [userId]);
    if (!deleted.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
    await client.query('COMMIT');
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (err instanceof AdminError) throw err;
    if (err?.code === '23503') {
      throw new AdminError('user_has_related_data', '用户仍有关联记录，无法直接删除', { httpStatus: 409 });
    }
    throw err;
  } finally {
    client?.release();
  }
  await recordAdminAudit(pool, actorId, 'admin.user_deleted', deletedLogin, { user_id: userId });
  return { ok: true };
}

/** 重置口令并吊销全部现存登录会话。 */
export async function resetUserPassword(pool, userId, password, { actorId = null, limits = {} } = {}) {
  validatePassword(password, limits);
  const existing = await pool.query(`SELECT id, login FROM users WHERE id = $1`, [userId]);
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  const passwordHash = await auth.hashPassword(password);
  const result = await pool.query(
    `WITH target AS (
       UPDATE users SET password_hash = $2 WHERE id = $1 RETURNING id, login
     ), revoked AS (
       UPDATE login_sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM target) AND revoked_at IS NULL
        RETURNING id
     )
     SELECT id, login FROM target`,
    [userId, passwordHash],
  );
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  await recordAdminAudit(pool, actorId, 'admin.user_password_reset', result.rows[0].login);
  return { ok: true };
}

/** 铸造新的 TOTP 绑定并吊销全部现存登录会话；种子仅在本次响应下发。 */
export async function enrollUserTotp(pool, userId, { actorId = null, totpIssuer = 'erix-station' } = {}) {
  const totpSecret = totp.generateSecret(20);
  const result = await pool.query(
    `WITH target AS (
       UPDATE users SET totp_secret = $2, last_totp_step = NULL
        WHERE id = $1
        RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at,
                  (totp_secret IS NOT NULL) AS totp_enabled
     ), revoked AS (
       UPDATE login_sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM target)
          AND revoked_at IS NULL
        RETURNING id
     )
     SELECT target.*, NULL::timestamptz AS last_login_at FROM target`,
    [userId, totpSecret],
  );
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  const user = safeUser(result.rows[0]);
  const totpUri = totp.otpauthUri(totpSecret, { issuer: totpIssuer, label: user.login });
  await recordAdminAudit(pool, actorId, 'admin.user_totp_enroll', user.login);
  return { user, totp_secret: totpSecret, totp_uri: totpUri };
}

/** 清除 TOTP 绑定并吊销全部现存登录会话，不返回种子。 */
export async function resetUserTotp(pool, userId, { actorId = null } = {}) {
  const result = await pool.query(
    `WITH target AS (
       UPDATE users SET totp_secret = NULL, last_totp_step = NULL
        WHERE id = $1 RETURNING id, login
     ), revoked AS (
       UPDATE login_sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM target) AND revoked_at IS NULL
        RETURNING id
     )
     SELECT id, login FROM target`,
    [userId],
  );
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  await recordAdminAudit(pool, actorId, 'admin.user_totp_reset', result.rows[0].login);
  return { ok: true };
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
