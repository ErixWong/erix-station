// admin 用户管理（issue #38 Phase B2 / issue #128）：用户 CRUD / 凭据重置 / active run 判定。
//
// 密码 hash 与 TOTP 生成**复用** auth.js / totp.js 的既有逻辑（与 cli.js bootstrap-admin 同口径：
// scrypt 自描述哈希 + 20 字节 base32 种子）。totp_secret 只在创建响应出现一次（红线），
// 列表与任何其它端点不回显；密码哈希永不出现。

import * as auth from './auth.js';
import * as totp from './totp.js';
import * as projects from './projects.js';
import { onboardingStatus } from './onboarding.js';
import { enqueueOffboarding, offboardingStatus, workspaceExists } from './offboarding.js';
import { removeGitCredentialFile } from './git-credential.js';

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
  onboarding: row.onboarding_state
    ? onboardingStatus({
      state: row.onboarding_state,
      steps: row.onboarding_steps,
      last_error: row.onboarding_error,
    })
    : null,
  offboarding: row.offboarding_state
    ? offboardingStatus({
      state: row.offboarding_state,
      steps: row.offboarding_steps,
      last_error: row.offboarding_error,
      workspace_purge_after: row.workspace_purge_after,
    })
    : null,
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
            (SELECT git_host_id FROM fde_git_accounts a WHERE a.fde_id = users.id) AS git_host_id,
            onboarding.state AS onboarding_state, onboarding.steps AS onboarding_steps,
            onboarding.last_error AS onboarding_error,
            offboarding.state AS offboarding_state, offboarding.steps AS offboarding_steps,
            offboarding.last_error AS offboarding_error,
            offboarding.workspace_purge_after
       FROM users
       LEFT JOIN fde_onboarding onboarding ON onboarding.fde_id = users.id
       LEFT JOIN fde_offboarding offboarding ON offboarding.fde_id = users.id
       LEFT JOIN (
         SELECT user_id, MAX(created_at) AS last_login_at
           FROM login_sessions
          GROUP BY user_id
       ) sessions ON sessions.user_id = users.id
      ORDER BY users.created_at ASC, users.login ASC`,
  );
  return { items: r.rows.map(safeUser) };
}

export async function writeUserCreatedAudit(pool, {
  actorId = null, login, fde_name, reactivated = false,
} = {}) {
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
    [
      actorId,
      reactivated ? 'admin.user_reactivated' : 'admin.user_created',
      login,
      JSON.stringify({ login, fde_name, ...(reactivated ? { reactivated: true } : {}) }),
    ],
  ).catch(() => {});
}

/**
 * 建 FDE 用户，或复用同名 disabled 用户行重新激活；默认不启用 TOTP，见 issue #139。
 * @returns { { user, reactivated } | { user, reactivated, totp_secret, totp_uri } }
 * —— 启用时种子仅此一次下发（调用方不得再读/再显）。
 */
export async function createUser(pool, { actorId = null, login, display_name, password, email, fde_name, totp_enabled = false, totpIssuer = 'erix-station', limits = {}, deferAudit = false } = {}) {
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
  if (typeof email !== 'string' || email.trim() === '' || email.trim().length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AdminError('validation_failed', 'email 必须是有效邮箱地址', { details: { field: 'email' } });
  }
  const trimmedEmail = email.trim();
  if (typeof fde_name !== 'string' || !projects.validateFdeName(fde_name).ok) {
    throw new AdminError('validation_failed', 'fde_name 非法（小写字母/数字/连字符，≤63）', { details: { field: 'fde_name' } });
  }

  const existingResult = await pool.query(
    `SELECT id, status FROM users WHERE fde_name = $1 FOR UPDATE`,
    [fde_name],
  );
  const existing = existingResult.rows[0] ?? null;
  if (existing && existing.status !== 'disabled') {
    throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { httpStatus: 409 });
  }
  let previousGitAccount = null;
  if (existing) {
    const offboarding = await pool.query(
      `SELECT state FROM fde_offboarding
        WHERE fde_id = $1 AND state IN ('pending', 'running')
        FOR UPDATE`,
      [existing.id],
    );
    if (offboarding.rows.length > 0) {
      throw new AdminError('user_offboarding', '用户下线任务仍在运行，不能重新激活', { httpStatus: 409 });
    }
    const gitAccount = await pool.query(
      `SELECT git_host_id, token_ref FROM fde_git_accounts WHERE fde_id = $1`,
      [existing.id],
    );
    previousGitAccount = gitAccount.rows[0] ?? null;
  }

  const duplicateLogin = await pool.query(
    existing
      ? `SELECT 1 FROM users WHERE login = $1 AND id <> $2`
      : `SELECT 1 FROM users WHERE login = $1`,
    existing ? [trimmedLogin, existing.id] : [trimmedLogin],
  );
  if (duplicateLogin.rows.length > 0) {
    throw new AdminError('login_conflict', `login ${trimmedLogin} 已被占用`, {
      httpStatus: 409, details: { field: 'login' },
    });
  }
  const duplicateEmail = await pool.query(
    existing
      ? `SELECT 1 FROM users WHERE email = $1 AND id <> $2`
      : `SELECT 1 FROM users WHERE email = $1`,
    existing ? [trimmedEmail, existing.id] : [trimmedEmail],
  );
  if (duplicateEmail.rows.length > 0) {
    throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { httpStatus: 409 });
  }

  const passwordHash = await auth.hashPassword(password); // 与 bootstrap-admin 同口径（scrypt 自描述）
  const totpSecret = totp_enabled === true ? totp.generateSecret(20) : null;
  let r;
  try {
    if (existing) {
      r = await pool.query(
        `UPDATE users
            SET login = $2, email = $3, display_name = $4, password_hash = $5,
                totp_secret = $6, last_totp_step = NULL, status = 'active', disabled_at = NULL
          WHERE id = $1 AND status = 'disabled'
          RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at,
                    (totp_secret IS NOT NULL) AS totp_enabled`,
        [
          existing.id, trimmedLogin, trimmedEmail,
          typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : trimmedLogin,
          passwordHash, totpSecret,
        ],
      );
      if (!r.rows[0]) {
        throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { httpStatus: 409 });
      }
      await pool.query(`DELETE FROM login_sessions WHERE user_id = $1`, [existing.id]);
      await pool.query(`DELETE FROM login_pending WHERE user_id = $1`, [existing.id]);
      await pool.query(`DELETE FROM api_tokens WHERE user_id = $1`, [existing.id]);
      await pool.query(
        `UPDATE fde_git_accounts
            SET remote_login = NULL, token_ref = NULL, updated_at = now()
          WHERE fde_id = $1`,
        [existing.id],
      );
    } else {
      r = await pool.query(
        `INSERT INTO users (login, email, display_name, role, auth_source, status, password_hash, totp_secret, fde_name)
         VALUES ($1, $2, $3, 'fde', 'local', 'active', $4, $5, $6)
         RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at,
                   (totp_secret IS NOT NULL) AS totp_enabled`,
        [
          trimmedLogin, trimmedEmail,
          typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : trimmedLogin,
          passwordHash, totpSecret, fde_name,
        ],
      );
    }
  } catch (err) {
    if (err instanceof AdminError) throw err;
    if (err?.code === '23505') {
      if (err.constraint === 'users_login_key' || String(err.detail ?? '').includes('(login)')) {
        throw new AdminError('login_conflict', `login ${trimmedLogin} 已被占用`, {
          httpStatus: 409, details: { field: 'login' },
        });
      }
      if (err.constraint === 'users_email_key' || String(err.detail ?? '').includes('(email)')) {
        throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { httpStatus: 409 });
      }
      if (err.constraint === 'users_fde_name_key' || String(err.detail ?? '').includes('(fde_name)')) {
        throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { httpStatus: 409 });
      }
    }
    throw err;
  }
  const user = safeUser(r.rows[0]);
  const totpUri = totpSecret ? totp.otpauthUri(totpSecret, { issuer: totpIssuer, label: user.login }) : null;
  // 审计：details 不含口令/种子（红线）。
  if (!deferAudit) {
    await writeUserCreatedAudit(pool, { actorId, login: trimmedLogin, fde_name, reactivated: Boolean(existing) });
  }
  return {
    user,
    reactivated: Boolean(existing),
    ...(previousGitAccount?.token_ref != null ? {
      previousTokenRef: previousGitAccount.token_ref,
      previousGitHostId: previousGitAccount.git_host_id,
    } : {}),
    ...(totpSecret ? { totp_secret: totpSecret, totp_uri: totpUri } : {}),
  };
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

  const existing = await pool.query(`SELECT id, login, fde_name FROM users WHERE id = $1`, [userId]);
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  const current = existing.rows[0];
  const changesFdeName = Object.hasOwn(updates, 'fde_name') && updates.fde_name !== current.fde_name;

  if (changesFdeName && updates.fde_name != null) {
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
    const offboardingGuard = updates.status === 'active' || changesFdeName
      ? `AND NOT EXISTS (SELECT 1 FROM fde_offboarding WHERE fde_id = users.id)`
      : '';
    result = await pool.query(
      `WITH updated AS (
         UPDATE users SET ${assignments.join(', ')}
          WHERE id = $1 ${offboardingGuard}
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
  if (!result.rows[0]) {
    const offboarding = updates.status === 'active' || changesFdeName
      ? await pool.query(`SELECT 1 FROM fde_offboarding WHERE fde_id = $1`, [userId])
      : { rows: [] };
    if (offboarding.rows.length > 0) {
      throw new AdminError('user_offboarding', '用户正在下线或处于保留期，不能重新启用或修改 FDE 名称', { httpStatus: 409 });
    }
    throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  }
  await recordAdminAudit(pool, actorId, 'admin.user_updated', current.login, {
    fields: fields.filter((field) => field !== 'login'),
  });
  return { user: safeUser(result.rows[0]) };
}

/** 有 FDE 资源时排队下线；无资源用户立即禁用。用户行永久保留。 */
export async function deleteUser(pool, { actorId, userId, config, log = console } = {}) {
  if (actorId === userId) {
    throw new AdminError('self_delete', '管理员不能停用自己的账号', { httpStatus: 409 });
  }

  let userLogin;
  let fdeName;
  let offboarding = null;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const target = await client.query(
      `SELECT id, login, fde_name FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (!target.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
    userLogin = target.rows[0].login;
    fdeName = target.rows[0].fde_name;

    const resources = await client.query(
      `SELECT (
         EXISTS (SELECT 1 FROM containers WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM fde_networks WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM port_allocations WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM fde_llm_bindings WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM fde_git_accounts WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM fde_onboarding WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM fde_offboarding WHERE fde_id = $1)
         OR EXISTS (SELECT 1 FROM projects WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM chat_sessions WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM usage_ledger WHERE user_id = $1)
         OR EXISTS (SELECT 1 FROM materialize_revisions WHERE fde_id = $1)
       ) AS has_resources`,
      [userId],
    );

    if (resources.rows[0]?.has_resources || workspaceExists(config, fdeName)) {
      if (!fdeName || !projects.validateFdeName(fdeName).ok) {
        throw new AdminError('user_fde_name_missing', '有关联资源的用户缺少有效 fde_name，无法安全下线', { httpStatus: 409 });
      }
      offboarding = await enqueueOffboarding(client, { fdeId: userId, fdeName });
      await client.query(
        `UPDATE users SET status = 'disabled', disabled_at = COALESCE(disabled_at, now()) WHERE id = $1`,
        [userId],
      );
      await client.query(`DELETE FROM login_sessions WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM login_pending WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM api_tokens WHERE user_id = $1`, [userId]);
      await client.query(
        `UPDATE preview_grants
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()), used_at = NULL
          WHERE state IN ('active', 'used')
            AND (user_id = $1 OR issuer_id = $1
              OR allocation_id IN (SELECT id FROM port_allocations WHERE fde_id = $1))`,
        [userId],
      );
    } else {
      await client.query(
        `UPDATE users SET status = 'disabled', disabled_at = COALESCE(disabled_at, now()) WHERE id = $1`,
        [userId],
      );
      await client.query(`DELETE FROM login_sessions WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM login_pending WHERE user_id = $1`, [userId]);
      await client.query(`DELETE FROM api_tokens WHERE user_id = $1`, [userId]);
      await client.query(
        `UPDATE preview_grants
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()), used_at = NULL
          WHERE state IN ('active', 'used') AND (user_id = $1 OR issuer_id = $1)`,
        [userId],
      );
    }
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
  if (offboarding) {
    await recordAdminAudit(pool, actorId, 'admin.user_offboarding_started', userLogin, {
      user_id: userId,
      fde_name: fdeName,
    });
    return { ok: true, offboarding };
  }
  if (fdeName) {
    try {
      removeGitCredentialFile({ config, fdeName });
    } catch (err) {
      log.warn?.(`[admin] disabled user git credential cleanup failed for ${fdeName}: ${String(err?.message ?? err)}`);
    }
  }
  await recordAdminAudit(pool, actorId, 'admin.user_disabled', userLogin, { user_id: userId });
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
