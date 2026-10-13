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

/**
 * 口令策略：**只校验「非空 + ≤上限」，没有最小长度**（现状保持——本单不引入最小长度，
 * 引入会让所有既有 e2e/账号的口令突然不合法，是另一件事）。
 *
 * `field` 只改错误信封里的 `details.field`（默认 `'password'` ⇒ admin 面行为一字不变）。
 * #255 的自助改密端点要用 `'new_password'` / `'current_password'`：同一个约束在两个字段上，
 * 前端要靠 field 决定标红哪一格，写死 `'password'` 会让人去改错的那一格。
 */
export function validatePassword(password, limits = {}, { field = 'password' } = {}) {
  const maxPassword = limits.maxPasswordLength ?? 256;
  if (typeof password !== 'string' || password.length === 0) {
    throw new AdminError('validation_failed', `${field} 为必填字段`, { details: { field } });
  }
  if (password.length > maxPassword) {
    throw new AdminError('validation_failed', `${field} 长度超过上限 ${maxPassword}`, { details: { field } });
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
 * 预览端口列端点（issue #246 交付②）的读审计：**admin 读别人的资源必须留痕**。
 * 不假定框架已自动写——评审已查实现有 admin GET（`/api/admin/users`、`/api/admin/fdes/:name/llm` 等）
 * 并未一致落实审计，所以本端点显式调一次 helper（**恰好一行**，多写也算噪声）。
 * action 命名照本文件既有风格（`admin.user_*`），target = 被读的 FDE 名（同 `writeUserCreatedAudit` 用 login）。
 */
export async function recordFdePortsListedAudit(pool, { actorId = null, fdeName, itemCount = 0 } = {}) {
  await recordAdminAudit(pool, actorId, 'admin.fde_ports_listed', fdeName, {
    fde_name: fdeName, item_count: itemCount,
  });
}

/** 预览端口改块（搬迁）的写审计；只在**真的搬了**时写（幂等空操作按契约零写库，portal.md §4.7a）。 */
export async function recordFdePortsBlockMovedAudit(pool, {
  actorId = null, fdeName, fromBlockStart = null, toBlockStart, releasedAllocations = 0, inserted = 0, revokedGrants = 0,
} = {}) {
  await recordAdminAudit(pool, actorId, 'admin.fde_ports_block_moved', fdeName, {
    fde_name: fdeName,
    from_block_start: fromBlockStart,
    to_block_start: toBlockStart,
    released_allocations: releasedAllocations,
    inserted_allocations: inserted,
    revoked_grants: revokedGrants,
  });
}

/**
 * 建 FDE 用户，或复用同名 disabled 用户行重新激活；默认不启用 TOTP，见 issue #139。
 * @returns { { user, reactivated } | { user, reactivated, totp_secret, totp_uri } }
 * —— 启用时种子仅此一次下发（调用方不得再读/再显）。
 */
export async function createUser(pool, { actorId = null, login, display_name, password, email, fde_name, totp_enabled = false, totpIssuer = 'erix-station', limits = {}, baseDomain = null, deferAudit = false } = {}) {
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
  // #202：开户口径提前到与路由生成（routes.js isValidHostname）同源——按 buildHostname 语法拼出
  // 最终预览 hostname 后**整体**校验（逐标签 ≤63 + 总长 ≤253），不是只验各段。
  // 不改 FDE_NAME_RE（≤63）本身：它还被目录名/容器名/git-credential 路径复用，那些不受 DNS 标签
  // 约束；预览域名预算只适用于「参与拼域名」——首标签固定段 `-p-<port>` 占 **8** 字符（#246 起端口
  // 在号池 22000–29999，5 位；#240 时代是 4 位 ⇒ 7 字符）⇒ **FDE 名预算 55**（63 − 8；两个数都从
  // portal/src/previewpool.js 的池边界推导，不在这里写死，理由详见 projects.js #202 注释）。
  // 56..63 字符的名字过去要等到路由生成阶段才爆（用户只见「预览打不开」），现在开户即 400，文案可操作。
  // baseDomain 缺省时退化为只校验首标签（预算与 base 无关）。
  const hostnameCheck = projects.validateFdeNameForHostname(fde_name, { baseDomain });
  if (!hostnameCheck.ok) {
    throw new AdminError('validation_failed', hostnameCheck.message, { details: { field: 'fde_name' } });
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
  // #255（首登强制改密）：**两条分支都写 must_change_password = true**，且写成 SQL 字面量而不是参数
  //（这条语句永远代表「管理员代设初始口令」，不该由调用方选择要不要置）。新建与「同名 disabled 行
  // 重新激活」是同一个场景：两条都往 password_hash 里塞了一个**别人知道**的口令，差别只在是否复用旧行
  // ⇒ 只治新建会漏掉「离职回来重新开户」那条路。
  // ⚠ 与 `cli.js bootstrap-admin` 的**不对称是刻意的**：bootstrap 的 INSERT 不写这一列（吃 DEFAULT false），
  //    否则 dev/CI 的 bootstrap 账号会一登录就被锁进改密屏（AGENTS §4.1）。默认值契约由迁移 0021 的守卫钉住。
  let r;
  try {
    if (existing) {
      r = await pool.query(
        `UPDATE users
            SET login = $2, email = $3, display_name = $4, password_hash = $5,
                totp_secret = $6, last_totp_step = NULL, status = 'active', disabled_at = NULL,
                must_change_password = true
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
        `INSERT INTO users (login, email, display_name, role, auth_source, status, password_hash, totp_secret, fde_name, must_change_password)
         VALUES ($1, $2, $3, 'fde', 'local', 'active', $4, $5, $6, true)
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
      // 撤预览 grant 的口径与 offboarding / 改块**完全一致**（#252）：只撤 `state = 'active'`。
      // 旧写法把 `used` 一起抓并顺手 `used_at = NULL`：能过双向 CHECK，但抹掉了「这张票何时被消费」
      // 的审计事实（篡改历史）；而 used 本身早已不授予访问（forwardAuth 只认 active），抓它没有收益。
      await client.query(
        `UPDATE preview_grants
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE state = 'active'
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
      // 同上：只撤 active，不动 used（#252 口径）。
      await client.query(
        `UPDATE preview_grants
            SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE state = 'active' AND (user_id = $1 OR issuer_id = $1)`,
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

/**
 * 重置口令并吊销全部现存登录会话。
 * #255：同时置 `must_change_password = true`——管理员重置的口令是「管理员选一个、转告本人」的，
 * 不经过本人之手 ⇒ 重置后仍欠一次改密（清旗标的唯一出口是 `POST /api/me/password`，portal.md §2.6a）。
 * 对照：同文件的 `enrollUserTotp`/`resetUserTotp` 不动口令 ⇒ 不置旗标。
 */
export async function resetUserPassword(pool, userId, password, { actorId = null, limits = {} } = {}) {
  validatePassword(password, limits);
  const existing = await pool.query(`SELECT id, login FROM users WHERE id = $1`, [userId]);
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { httpStatus: 404 });
  const passwordHash = await auth.hashPassword(password);
  const result = await pool.query(
    `WITH target AS (
       UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 RETURNING id, login
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

/**
 * 本人自助改密（#255 首登强制改密的唯一出口，portal.md §2.6a）。与 `resetUserPassword` 的三点差别：
 *   ① 要先验**当前口令**（复用 `auth.verifyPassword`——它才是校验 scrypt 自描述哈希的那把尺子，
 *      自己再写一份就等于给同一个凭据两套判据）；
 *   ② **保留当前会话**，只吊销该用户**其它** `login_sessions`（`id <> 当前会话`）——
 *      管理员那条是全量吊销，本端点照抄会把人当场踢下线，「改完密又要重新登录」= 体感改密失败，
 *      而受限会话门此时已经放行（旗标刚清），用户只会看到「登录又过期了」；
 *   ③ 成功后清 `must_change_password=false`（这就是改密屏的出口）。
 *
 * 错误码复用（**不新造**）：
 *   - 当前口令不对 → `invalid_credentials` + 401，与登录失败同一个码：语义完全相同
 *     （同一个主体、同一份凭据、同一个失败原因），新造一个码只会让前端多一条分支、
 *     并额外泄露「会话有效但口令错」这个此前不存在的事实；
 *   - 新口令不合规 / 与当前相同 → `validation_failed` + `details.field='new_password'`。
 *
 * 口令明文**绝不入审计**（details 只有 login / 计数）。
 *
 * @returns {{ok: true, password_change_required: false, sessions_revoked: number}}
 */
export async function changeOwnPassword(pool, userId, currentPassword, newPassword, {
  currentSessionId = null, limits = {}, log = console,
} = {}) {
  // 形状先校验：不合规就不该去跑 scrypt（失败路径也便宜）。
  validatePassword(newPassword, limits, { field: 'new_password' });
  if (!currentSessionId) {
    // 没有会话 id 就没法「保留当前会话」——宁可不改，也不要退化成把人踢下线。
    throw new AdminError('unauthorized', 'unauthorized', { httpStatus: 401 });
  }
  const existing = await pool.query(
    `SELECT id, login, password_hash, auth_source FROM users WHERE id = $1 AND status = 'active'`,
    [userId],
  );
  const row = existing.rows[0];
  // `password_hash IS NULL`（OIDC 账号 / 未设口令）也落这里：verifyPassword 对 NULL 返回 false。
  if (!row || !(await auth.verifyPassword(currentPassword, row.password_hash, { log }))) {
    throw new AdminError('invalid_credentials', '用户名或口令错误', { httpStatus: 401 });
  }
  if (newPassword === currentPassword) {
    throw new AdminError('validation_failed', '新口令不得与当前口令相同', { details: { field: 'new_password' } });
  }
  const passwordHash = await auth.hashPassword(newPassword);
  // 单语句（CTE）⇒ 「换哈希 + 清旗标 + 吊销其它会话」原子完成，不存在「哈希已换但会话没吊销」的中间态。
  const result = await pool.query(
    `WITH target AS (
       UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1 RETURNING id, login
     ), revoked AS (
       UPDATE login_sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM target)
          AND revoked_at IS NULL
          AND id <> $3
        RETURNING id
     )
     SELECT id, login, (SELECT count(*) FROM revoked) AS revoked_sessions FROM target`,
    [userId, passwordHash, currentSessionId],
  );
  if (!result.rows[0]) throw new AdminError('unauthorized', 'unauthorized', { httpStatus: 401 });
  const sessionsRevoked = Number(result.rows[0].revoked_sessions ?? 0);
  await recordAdminAudit(pool, userId, 'user.password_changed', result.rows[0].login, {
    login: result.rows[0].login, self_service: true, sessions_revoked: sessionsRevoked,
  });
  return { ok: true, password_change_required: false, sessions_revoked: sessionsRevoked };
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
