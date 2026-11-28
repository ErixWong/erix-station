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
import { normalizeUserLocale } from './db.js'; // #828 P1：语言偏好写侧归一化（纯函数，db.js 只依 pg，无环）

export class AdminError extends Error {
  constructor(code, message, { httpStatus = 400, details, en } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
    this.en = en;
  }
}

const safeUser = (row) => ({
  id: row.id,
  login: row.login,
  display_name: row.display_name,
  // 2026-11-06：email 进 DTO。它**不是**秘密（管理员开户时就填过），而列表里看不到它导致
  // 「管理台无法维护邮箱」——`admin` / `<fde_name>` 至今没有邮箱，一旦启用 `transport=smtp` 就会被
  // 409 `email_not_registered` 锁在门外，而管理员连在哪儿补都不知道。
  // 仍**不**进 DTO 的：`password_hash` / `totp_secret`（真正的秘密）。
  email: row.email ?? null,
  // 2026-11-06：per-user「邮件验证码」开关（迁移 0028）。默认 false = 不启用，
  // 由管理员在 Edit → Security 里显式打开（与 TOTP 对称）。全局 transport=disabled 仍压过它。
  mail_otp_enabled: Boolean(row.mail_otp_enabled),
  // 2026-11-09（#472 片 A）：per-user「文件上传」开关（迁移 0029）。**必须 `=== true`，不是 `Boolean(...)`**：
  // `Boolean('f') === true`（非空字符串都是真值），而 fake/旧驱动可能给 `'f'` / `0` / `undefined` 这些形状，
  // 消费方（片 B 的 403 闸门、管理台三态）判据都是 `=== true` ⇒ 这里折叠成两态就是把陷阱留给下游。
  // `mail_otp_enabled` 用 `Boolean()` 是既有形状，**不动**（改它会顺手改变既有行为）。
  file_upload_enabled: row.file_upload_enabled === true,
  // 工单 feat-261110-02（迁移 0030）：**允许用 TOTP 登录**，与「绑过 TOTP」（`totp_enabled`）是两件事。
  // 关掉它**不清 `totp_secret`** ⇒ `totp_enabled` 仍为 true，随时可以再打开。
  // 口径按要求用 `=== true`（不是 `Boolean()`）：fake/旧驱动给 `'f'` / `0` / `undefined` 时
  // `Boolean()` 会把非空字符串折成 true，而下游判据全是 `=== true`。
  // ⚠ 代价是「SELECT 漏列 ⇒ DTO 说 false」，所以五个 safeUser 生产点的列清单都必须带上这一列
  //    （portal/test/user-totp-login-enabled.test.js 的 T-3 逐个钉）。
  totp_login_enabled: row.totp_login_enabled === true,
  // #828 P1：账号级语言偏好（迁移 0048，可空）。`null` = 未设过 = 跟随浏览器；fake/旧驱动缺列也给 `null`。
  // 与管理台用户表单的「默认语言」三档下拉对应（跟随浏览器/简体中文/English）。
  locale: row.locale ?? null,
  role: row.role,
  fde_name: row.fde_name ?? null,
  git_host_id: row.git_host_id ?? null,
  auth_source: row.auth_source,
  status: row.status,
  totp_enabled: Boolean(row.totp_enabled),
  last_login_at: row.last_login_at instanceof Date ? row.last_login_at.toISOString() : row.last_login_at ?? null,
  // issue #497（工单 feat-261112-01，迁移 0031）：「最近一次用户输入」——与 `last_login_at`（最近一次登录）
  // 是**两条独立时间线**：本列只由 `sessions.js#postMessage` 与 `queued-inputs.js#enqueueQueuedInput` 写，
  // 所以它**允许比 `last_login_at` 旧**（登录了但一句话没说）。形状与上一行刻意同形：两侧都可能是
  // `Date`（真驱动）/ ISO 串（旧驱动与 fake）/ `null`（从未活动）——新开户与从未发言的账号就该是 `null`，
  // 界面上「从未活动」与「从未登录」是两个措辞（`docs/api/portal.md` §12）。
  last_activity_at: row.last_activity_at instanceof Date
    ? row.last_activity_at.toISOString()
    : row.last_activity_at ?? null,
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
    throw new AdminError('validation_failed', `${field} 为必填字段`, { en: `${field} is required`, details: { field } });
  }
  if (password.length > maxPassword) {
    throw new AdminError('validation_failed', `${field} 长度超过上限 ${maxPassword}`, { en: `${field} exceeds the limit of ${maxPassword} characters`, details: { field } });
  }
}

export function recordAdminAudit(pool, actorId, action, target, details = {}) {
  return pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details) VALUES ($1, $2, $3, $4)`,
    [actorId, action, target, JSON.stringify(details)],
  ).catch(() => {});
}

/** 用户列表（无**秘密**字段：无 password_hash / totp_secret；email 是管理员可维护的运维信息，已在 DTO 里）。 */
export async function listUsers(pool) {
  const r = await pool.query(
    `SELECT users.id, users.login, users.display_name, users.email, users.mail_otp_enabled,
            users.file_upload_enabled, users.totp_login_enabled, users.locale,
            users.role, users.fde_name,
            users.auth_source, users.status, users.created_at,
            (users.totp_secret IS NOT NULL) AS totp_enabled,
            -- issue #497：本列就在 users 表上，直接选它（不像 last_login_at 那样要从 login_sessions 聚合）
            users.last_activity_at,
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

/**
 * 号池占用总览（issue #256 交付①）的读审计：`GET /api/admin/preview-ports/usage` 只读全池快照，
 * 也算「读他人的资源」⇒ 照 `recordFdePortsListedAudit` 的先例显式留一行。
 * `details` **只放计数**（`free_count` / `occupied_block_count` 等）：整份响应体是一张号池快照，
 * 抄进审计表等于多一份会漂移的副本。
 */
export async function recordPreviewPortsUsageListedAudit(pool, {
  actorId = null, totalBlocks = 0, freeCount = 0, occupiedBlockCount = 0, limit = 0,
} = {}) {
  await recordAdminAudit(pool, actorId, 'admin.preview_ports_usage_listed', 'preview_port_pool', {
    total_blocks: totalBlocks,
    free_count: freeCount,
    occupied_block_count: occupiedBlockCount,
    limit,
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
    throw new AdminError('validation_failed', 'login 为必填字段', { en: 'login is required', details: { field: 'login' } });
  }
  const trimmedLogin = login.trim();
  if (trimmedLogin.length > maxLogin) {
    throw new AdminError('validation_failed', `login 长度超过上限 ${maxLogin}`, { en: `login exceeds the limit of ${maxLogin} characters`, details: { field: 'login' } });
  }
  validatePassword(password, { maxPasswordLength: maxPassword });
  if (typeof email !== 'string' || email.trim() === '' || email.trim().length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AdminError('validation_failed', 'email 必须是有效邮箱地址', { en: 'email must be a valid email address', details: { field: 'email' } });
  }
  const trimmedEmail = email.trim();
  if (typeof fde_name !== 'string' || !projects.validateFdeName(fde_name).ok) {
    throw new AdminError('validation_failed', 'fde_name 非法（小写字母/数字/连字符，≤63）', { en: 'invalid fde_name (lowercase letters, digits, hyphens, ≤63)', details: { field: 'fde_name' } });
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
    // #803 返修①：`validateFdeNameForHostname` 是 **return** 一个 `{ok,message,en}`，不是 throw；
    // 早先按 `throw new XError` 扫的批次看不见它 ⇒ 这里没给 `en` ⇒ `locale=en` 直出中文。
    // 现在把校验器算好的英文对原样透传（中文仍是 `message`，既有断言钉着）。
    throw new AdminError('validation_failed', hostnameCheck.message, { en: hostnameCheck.en, details: { field: 'fde_name' } });
  }

  const existingResult = await pool.query(
    `SELECT id, status FROM users WHERE fde_name = $1 FOR UPDATE`,
    [fde_name],
  );
  const existing = existingResult.rows[0] ?? null;
  if (existing && existing.status !== 'disabled') {
    throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { en: `fde_name ${fde_name} is already taken`, httpStatus: 409 });
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
      throw new AdminError('user_offboarding', '用户下线任务仍在运行，不能重新激活', { en: 'the user offboarding task is still running, so reactivation is not allowed', httpStatus: 409 });
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
    throw new AdminError('login_conflict', `login ${trimmedLogin} 已被占用`, { en: `login ${trimmedLogin} is already taken`,
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
    throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { en: `email ${trimmedEmail} is already taken`, httpStatus: 409 });
  }

  const passwordHash = await auth.hashPassword(password); // 与 bootstrap-admin 同口径（scrypt 自描述）
  const totpSecret = totp_enabled === true ? totp.generateSecret(20) : null;
  // #255（首登强制改密）：**两条分支都写 must_change_password = true**，且写成 SQL 字面量而不是参数
  //（这条语句永远代表「管理员代设初始口令」，不该由调用方选择要不要置）。新建与「同名 disabled 行
  // 重新激活」是同一个场景：两条都往 password_hash 里塞了一个**别人知道**的口令，差别只在是否复用旧行
  // ⇒ 只治新建会漏掉「离职回来重新开户」那条路。
  // ⚠ 与 `cli.js bootstrap-admin` 的**不对称是刻意的**：bootstrap 的 INSERT 不写这一列（吃 DEFAULT false），
  //    否则 dev/CI 的 bootstrap 账号会一登录就被锁进改密屏（AGENTS §4.1）。默认值契约由迁移 0021 的守卫钉住。
  //
  // #472 片 A：重激活分支**显式 `file_upload_enabled = false`**（评审 blocker 2）。这条分支走的是 UPDATE，
  // 列默认值根本碰不到它 ⇒ 不写零就会让「曾开过上传 → 被停用 → 重新开户」的账号**继承旧权限**。
  // 口径：重新开户 = 重新授权，不许继承旧权限（与上面 must_change_password 置 true 同一个理由：
  // 复用旧行不等于复用旧授权）。
  // 新建分支不需要（INSERT 不带该列 ⇒ 吃 `DEFAULT false`），且 `createUser` **不接受** `file_upload_enabled`
  // 入参：开户是批量/脚本路径，多一个可选参数就多一条「脚本写错把上传开给所有人」的路。
  let r;
  try {
    if (existing) {
      r = await pool.query(
        `UPDATE users
            SET login = $2, email = $3, display_name = $4, password_hash = $5,
                totp_secret = $6, last_totp_step = NULL, status = 'active', disabled_at = NULL,
                must_change_password = true, file_upload_enabled = false
          WHERE id = $1 AND status = 'disabled'
          RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at, file_upload_enabled,
                    totp_login_enabled, last_activity_at,
                    (totp_secret IS NOT NULL) AS totp_enabled`,
        [
          existing.id, trimmedLogin, trimmedEmail,
          typeof display_name === 'string' && display_name.trim() !== '' ? display_name.trim() : trimmedLogin,
          passwordHash, totpSecret,
        ],
      );
      if (!r.rows[0]) {
        throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { en: `fde_name ${fde_name} is already taken`, httpStatus: 409 });
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
         RETURNING id, login, display_name, email, mail_otp_enabled, file_upload_enabled, totp_login_enabled, role, fde_name, auth_source, status, created_at, last_activity_at,
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
        throw new AdminError('login_conflict', `login ${trimmedLogin} 已被占用`, { en: `login ${trimmedLogin} is already taken`,
          httpStatus: 409, details: { field: 'login' },
        });
      }
      if (err.constraint === 'users_email_key' || String(err.detail ?? '').includes('(email)')) {
        throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { en: `email ${trimmedEmail} is already taken`, httpStatus: 409 });
      }
      if (err.constraint === 'users_fde_name_key' || String(err.detail ?? '').includes('(fde_name)')) {
        throw new AdminError('fde_name_conflict', `fde_name ${fde_name} 已被占用`, { en: `fde_name ${fde_name} is already taken`, httpStatus: 409 });
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
    throw new AdminError('validation_failed', '请求体必须是对象', { en: 'the request body must be an object' });
  }
  // #648 B：`confirm_last_admin` 是**控制位**，不是可更新列（API 纯增量：旧客户端不传 ⇒ 行为一字不变）。
  // 必须在「至少一格」与「允许字段」两道校验**之前**摘掉：
  //   - 不摘 ⇒ 它会被当成未知字段 400（`{confirm_last_admin:true}` 明明该报「至少一格」）；
  //   - 摘了但只摘不判 ⇒ `{confirm_last_admin:'true'}` 这种「看起来像布尔」会一路走到 SQL。
  const fields = Object.keys(updates).filter((field) => field !== 'confirm_last_admin');
  const confirmLastAdmin = Object.hasOwn(updates, 'confirm_last_admin')
    ? updates.confirm_last_admin
    : false;
  if (fields.length === 0) {
    throw new AdminError('validation_failed', '至少提供一个可更新字段', { en: 'provide at least one updatable field' });
  }
  const allowed = new Set(['display_name', 'email', 'mail_otp_enabled', 'file_upload_enabled',
    'totp_login_enabled', 'role', 'fde_name', 'status', 'locale']);
  for (const field of fields) {
    if (field === 'login') {
      throw new AdminError('validation_failed', 'login 不可修改', { en: 'login cannot be modified', details: { field: 'login' } });
    }
    if (!allowed.has(field)) {
      throw new AdminError('validation_failed', `不支持更新字段 ${field}`, { en: `updating field ${field} is not supported`, details: { field } });
    }
  }
  // 控制位只认真布尔（与 `mail_otp_enabled` / `file_upload_enabled` 同形状的既有红线）。
  if (Object.hasOwn(updates, 'confirm_last_admin') && typeof confirmLastAdmin !== 'boolean') {
    throw new AdminError('validation_failed', 'confirm_last_admin 必须是布尔值', { en: 'confirm_last_admin must be a boolean', details: { field: 'confirm_last_admin' } });
  }

  // email 可改可清（`null` / 空串 ⇒ 清空）。校验口径与 createUser 同源（同一正则、同一长度上限）——
  // #449 的邮箱验证码通道吃这一列，格式错了到登录时才炸，代价比这里拦下大得多。
  let trimmedEmail = null;
  if (Object.hasOwn(updates, 'email')) {
    if (updates.email === null || (typeof updates.email === 'string' && updates.email.trim() === '')) {
      trimmedEmail = null;
    } else if (typeof updates.email !== 'string' || updates.email.trim().length > 320
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email.trim())) {
      throw new AdminError('validation_failed', 'email 必须是有效邮箱地址', { en: 'email must be a valid email address', details: { field: 'email' } });
    } else {
      trimmedEmail = updates.email.trim();
    }
  }
  if (Object.hasOwn(updates, 'mail_otp_enabled') && typeof updates.mail_otp_enabled !== 'boolean') {
    throw new AdminError('validation_failed', 'mail_otp_enabled 必须是布尔值', { en: 'mail_otp_enabled must be a boolean', details: { field: 'mail_otp_enabled' } });
  }
  // #472 片 A：上传开关同样是布尔（照上面那条的形状）。`'true'` / `1` / `null` 都是「看起来像布尔但不是」，
  // 放进 PG 的 boolean 列会在驱动层报 22P02（人不话），这里当场 400 并点名 field。
  if (Object.hasOwn(updates, 'file_upload_enabled') && typeof updates.file_upload_enabled !== 'boolean') {
    throw new AdminError('validation_failed', 'file_upload_enabled 必须是布尔值', { en: 'file_upload_enabled must be a boolean', details: { field: 'file_upload_enabled' } });
  }
  // feat-261110-02：「允许用 TOTP 登录」同样是布尔（同一形状）。**没有**「必须已绑 TOTP」的交叉防护：
  // 没绑时这一位本来就不起作用（`chooseSecondFactor` 的 `totpUsable` 还要看 `hasTotpEnrollment`），
  // 拒绝一个无害的值只会把「先绑 TOTP 再打开」这个顺序变成两次往返。
  if (Object.hasOwn(updates, 'totp_login_enabled') && typeof updates.totp_login_enabled !== 'boolean') {
    throw new AdminError('validation_failed', 'totp_login_enabled 必须是布尔值', { en: 'totp_login_enabled must be a boolean', details: { field: 'totp_login_enabled' } });
  }
  // #828 P1：语言偏好。`null` / 空串 = 清除（跟随浏览器），其余走白名单归一化（`en-US`→`en`、
  // `zh_CN`→`zh-CN` …）；非法值（`fr`、数字）当场 400 并点名 field（与 `file_upload_enabled` 同形状）。
  let nextLocale;
  if (Object.hasOwn(updates, 'locale')) {
    const norm = normalizeUserLocale(updates.locale);
    if (!norm.ok) {
      throw new AdminError('validation_failed', "locale 只允许 'zh-CN'、'en' 或 null（清除）", { en: "locale must be 'zh-CN', 'en', or null (to clear)", details: { field: 'locale' } });
    }
    nextLocale = norm.value;
  }
  // 两条交叉防护（都在写库之前）：开了开关却没邮箱 / 清空邮箱却还开着开关 ⇒ 都会让人**登不进去**
  // （`chooseSecondFactor` 走 `email_not_registered` 那条 409）。这里拒绝保存，而不是让它在登录时才炸。
  if (Object.hasOwn(updates, 'mail_otp_enabled') || Object.hasOwn(updates, 'email')) {
    const current = await pool.query(
      `SELECT email, mail_otp_enabled FROM users WHERE id = $1`,
      [userId],
    );
    const row = current.rows[0];
    if (row) {
      const nextEnabled = Object.hasOwn(updates, 'mail_otp_enabled')
        ? updates.mail_otp_enabled
        : Boolean(row.mail_otp_enabled);
      const nextEmail = Object.hasOwn(updates, 'email') ? trimmedEmail : (row.email ?? null);
      if (nextEnabled === true && (typeof nextEmail !== 'string' || nextEmail.trim() === '')) {
        throw new AdminError('validation_failed', '启用邮件验证码前必须先填写邮箱', { en: 'an email address is required before enabling email verification codes',
          details: { field: 'mail_otp_enabled' },
        });
      }
    }
  }
  if (Object.hasOwn(updates, 'role') && !['fde', 'admin'].includes(updates.role)) {
    throw new AdminError('validation_failed', "role 只允许 'fde' 或 'admin'", { en: "role must be 'fde' or 'admin'", details: { field: 'role' } });
  }
  if (Object.hasOwn(updates, 'status') && !['active', 'disabled'].includes(updates.status)) {
    throw new AdminError('validation_failed', "status 只允许 'active' 或 'disabled'", { en: "status must be 'active' or 'disabled'", details: { field: 'status' } });
  }
  if (Object.hasOwn(updates, 'fde_name')
      && updates.fde_name !== null
      && !projects.validateFdeName(updates.fde_name).ok) {
    throw new AdminError('validation_failed', 'fde_name 非法（小写字母/数字/连字符，≤63）', { en: 'invalid fde_name (lowercase letters, digits, hyphens, ≤63)', details: { field: 'fde_name' } });
  }
  if (Object.hasOwn(updates, 'display_name') && typeof updates.display_name !== 'string') {
    throw new AdminError('validation_failed', 'display_name 必须是字符串', { en: 'display_name must be a string', details: { field: 'display_name' } });
  }

  const existing = await pool.query(`SELECT id, login, fde_name FROM users WHERE id = $1`, [userId]);
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
  const current = existing.rows[0];
  const changesFdeName = Object.hasOwn(updates, 'fde_name') && updates.fde_name !== current.fde_name;

  if (changesFdeName && updates.fde_name != null) {
    const duplicate = await pool.query(
      `SELECT 1 FROM users WHERE fde_name = $1 AND id <> $2`,
      [updates.fde_name, userId],
    );
    if (duplicate.rows.length > 0) {
      throw new AdminError('fde_name_conflict', `fde_name ${updates.fde_name} 已被占用`, { en: `fde_name ${updates.fde_name} is already taken`, httpStatus: 409 });
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
  if (Object.hasOwn(updates, 'email')) {
    if (trimmedEmail !== null) {
      const duplicate = await pool.query(
        `SELECT 1 FROM users WHERE lower(email) = lower($1) AND id <> $2`,
        [trimmedEmail, userId],
      );
      if (duplicate.rows.length > 0) {
        throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { en: `email ${trimmedEmail} is already taken`, httpStatus: 409 });
      }
    }
    setField('email', trimmedEmail);
  }
  if (Object.hasOwn(updates, 'mail_otp_enabled')) setField('mail_otp_enabled', updates.mail_otp_enabled);
  if (Object.hasOwn(updates, 'file_upload_enabled')) setField('file_upload_enabled', updates.file_upload_enabled);
  if (Object.hasOwn(updates, 'totp_login_enabled')) setField('totp_login_enabled', updates.totp_login_enabled);
  if (Object.hasOwn(updates, 'locale')) setField('locale', nextLocale);
  if (Object.hasOwn(updates, 'role')) setField('role', updates.role);
  if (Object.hasOwn(updates, 'fde_name')) setField('fde_name', updates.fde_name);
  if (Object.hasOwn(updates, 'status')) {
    params.push(updates.status);
    assignments.push(`status = $${params.length}`);
    assignments.push(`disabled_at = CASE WHEN $${params.length} = 'disabled' THEN now() ELSE NULL END`);
  }

  let result;
  // #648 B（判据来自 issue #648）：**最后一名 active admin 不能消失**。
  //   本次更新会把这一行移出「role='admin' AND status='active'」集合时——**降级与停用同一条判据**（关心的是
  //   “改完之后还有没有 active admin”，与它是被降级还是被停用无关）——必须还有第二名 active admin 留下。
  //   按**目标账号**判，不按 actor：actor 自己是不是 admin 与本判据无关（既有的 `self_delete` 在 deleteUser
  //   里、只管“不能停用自己”；这里新增的是“不能把最后一名 admin 改没了”，两条互不干涉）。
  // ⚠ **同一条 SQL**：「还有没有别人」写在 UPDATE 的 WHERE 里，而不是先 SELECT 数一遍再 UPDATE。
  //   先查后改在并发下会双双通过（两个请求各自降级一名 admin，数的时候对方都还活着）；写进 WHERE 后
  //   判定与写入共用同一语句快照，不留下跨往返的窗口。
  //   `users.role`/`users.status` 在 UPDATE 的 WHERE 里看到的是**改前值**（PG 语义），子查询里那个同名表
  //   同理——所以子查询必须 `id <> users.id` 把目标行本身排掉，否则“它自己”会被当成“还有别人”。
  // 两个触发条件**分开留名**：错误里的 `details.field` 必须指到**真正在改的那一格**
  // （`docs/api/portal.md` PATCH 用户端点写的就是这个口径）。只看「请求里有没有 role」会指错：
  // `{role:'admin', status:'disabled'}` 里 role 根本没离开集合，触发者是 status。
  const leavesByRole = Object.hasOwn(updates, 'role') && updates.role !== 'admin';
  const leavesByStatus = Object.hasOwn(updates, 'status') && updates.status !== 'active';
  const leavesActiveAdminSet = leavesByRole || leavesByStatus;
  // #648 D：actor 自己就是目标 ⇒ 自降级/自停用。最后一名 active admin 把自己改没了以后，
  //   管理台只有 admin 进得去 ⇒ 再没人能把他升回来，这一刀不可逆。`confirm_last_admin` 是为
  //   「另一名 admin 处置最后一名 admin」设计的，救不了自锁死 ⇒ 对**自**降级确认位不生效，
  //   护栏照旧（即使 confirmLastAdmin === true 也必须把自降级拦下）。
  const isSelf = actorId != null && String(actorId) === String(userId);
  const lastAdminGuard = leavesActiveAdminSet && (confirmLastAdmin !== true || isSelf)
    ? `AND (users.role <> 'admin' OR users.status <> 'active'
            OR EXISTS (SELECT 1 FROM users last_admin_guard
                        WHERE last_admin_guard.role = 'admin'
                          AND last_admin_guard.status = 'active'
                          AND last_admin_guard.id <> users.id))`
    : '';
  try {
    const offboardingGuard = updates.status === 'active' || changesFdeName
      ? `AND NOT EXISTS (SELECT 1 FROM fde_offboarding WHERE fde_id = users.id)`
      : '';
    // #648 A：工位（seat）一旦实体化，`fde_name` 就是它的物理身份——`containers.fde_name`
    //   （schema.sql:148 冗余列）、`containers.container_name = fde-<name>`、`fde_networks.network_name = fde-<name>`、
    //   家目录 `userSpaceRoot/<fde_name>`、以及 docker 容器/网络本体，全部钉在旧名上。portal 事务里只改
    //   `users.fde_name` 一列会留下新旧名并存的静默不一致；要诚实连带就得改 docker + 文件系统，那是
    //   runner/deploy 的范畴（本单红线），不是这一列能原子带走的 ⇒ 对已实体化的工位**拒绝改名**。
    //   未实体化（无容器/无网络，例如尚未 provisioning 的账号）时名字还没绑到任何物理资源 ⇒ 允许，
    //   `fde_name_conflict` 查重路径原样不变。判据写进 UPDATE 的 WHERE（与 offboarding 护栏同法），
    //   判定与写入共用同一语句快照，不留跨往返窗口。
    const immutableGuard = changesFdeName
      ? `AND NOT EXISTS (SELECT 1 FROM containers WHERE user_id = users.id)
             AND NOT EXISTS (SELECT 1 FROM fde_networks WHERE fde_id = users.id)`
      : '';
    result = await pool.query(
      `WITH updated AS (
         UPDATE users SET ${assignments.join(', ')}
          WHERE id = $1 ${offboardingGuard} ${immutableGuard} ${lastAdminGuard}
          RETURNING id, login, display_name, email, mail_otp_enabled, file_upload_enabled, totp_login_enabled, role, fde_name, auth_source, status, created_at, last_activity_at, locale,
                    (totp_secret IS NOT NULL) AS totp_enabled
       ), revoked AS (
         UPDATE login_sessions SET revoked_at = now()
          WHERE user_id = (SELECT id FROM updated)
            AND revoked_at IS NULL
            AND EXISTS (SELECT 1 FROM updated WHERE status = 'disabled')
          RETURNING id
       )
       -- issue #497：last_activity_at 已在上面 RETURNING 的列清单里（它是 users 的真列 ⇒ 拿真实值）。
       -- 这里不许再补 NULL::timestamptz AS last_activity_at：同名列会赢过真值
       --   （node-pg 里重复列名后者覆盖前者）⇒ DTO 永远报「从未活动」，而库里明明存着时刻。
       --   last_login_at 必须继续写 NULL：它不是列，是 listUsers 里从 login_sessions 聚合出来的派生量。
       SELECT updated.*, NULL::timestamptz AS last_login_at FROM updated`,
      params,
    );
  } catch (err) {
    if (err?.code === '23505' && err?.constraint === 'users_fde_name_key') {
      throw new AdminError('fde_name_conflict', `fde_name ${updates.fde_name} 已被占用`, { en: `fde_name ${updates.fde_name} is already taken`, httpStatus: 409 });
    }
    // 并发下「先查后写」会漏（两个请求同时通过上面的 SELECT）⇒ 唯一索引是最后一道，映射成同一个错误码。
    if (err?.code === '23505' && err?.constraint === 'users_email_key') {
      throw new AdminError('email_conflict', `email ${trimmedEmail} 已被占用`, { en: `email ${trimmedEmail} is already taken`, httpStatus: 409 });
    }
    throw err;
  }
  if (!result.rows[0]) {
    const offboarding = updates.status === 'active' || changesFdeName
      ? await pool.query(`SELECT 1 FROM fde_offboarding WHERE fde_id = $1`, [userId])
      : { rows: [] };
    if (offboarding.rows.length > 0) {
      throw new AdminError('user_offboarding', '用户正在下线或处于保留期，不能重新启用或修改 FDE 名称', { en: 'the user is being offboarded or in the retention period, so re-enabling or changing the FDE name is not allowed', httpStatus: 409 });
    }
    // #648 A：改名一格未命中且不是下线中 ⇒ 是因为工位已实体化（容器/网络存在）。
    //   回查只为选对错误码（判据本身已在上面 UPDATE 的 WHERE 里跑过，与 offboarding 同法）。
    if (changesFdeName) {
      const seat = await pool.query(
        `SELECT 1 AS hit FROM containers WHERE user_id = $1
         UNION ALL
         SELECT 1 AS hit FROM fde_networks WHERE fde_id = $1
         LIMIT 1`,
        [userId],
      );
      if (seat.rows.length > 0) {
        throw new AdminError('fde_name_immutable',
          '工位名不可改，需新建（改名要连带迁移 docker 容器/网络与家目录，本端点不跨 runner/deploy）',
          { en: 'the workstation (FDE) name cannot be renamed once provisioned—renaming it would have to migrate the Docker container/network and home directory, which this endpoint does not do across runner/deploy; create a new one instead',
            httpStatus: 409, details: { field: 'fde_name' } });
      }
    }
    // UPDATE 一行没命中 ⇒ 回查一次，只为**选对错误码**（判据本身已经在上面那条语句里跑过了，
    // 与 offboarding 那条既有写法同法）。护栏没参与时不多花这一次查询。
    if (lastAdminGuard) {
      const lastOne = await pool.query(
        `SELECT 1 FROM users guarded
          WHERE guarded.id = $1
            AND guarded.role = 'admin' AND guarded.status = 'active'
            AND NOT EXISTS (SELECT 1 FROM users other
                             WHERE other.role = 'admin' AND other.status = 'active'
                               AND other.id <> guarded.id)`,
        [userId],
      );
      if (lastOne.rows.length > 0) {
        if (isSelf) {
          throw new AdminError('last_admin_self',
            '这是最后一名 active 管理员，不能把自己降级或停用（降完无人能把你升回管理台，确认位也救不了）',
            { en: 'this is the last active administrator, so you cannot demote or disable your own account (no one would be left to restore it; confirm_last_admin does not override)',
              httpStatus: 409,
              details: { field: leavesByRole ? 'role' : 'status' } });
        }
        throw new AdminError('last_admin',
          '这是最后一名 active 管理员，降级或停用后无人在管理台（确认请带 confirm_last_admin: true）',
          { en: 'this is the last active administrator, so demoting or disabling the account would leave no one in the admin console (send confirm_last_admin: true to override)',
            httpStatus: 409,
            details: { field: leavesByRole ? 'role' : 'status' } });
      }
    }
    throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
  }
  await recordAdminAudit(pool, actorId, 'admin.user_updated', current.login, {
    fields: fields.filter((field) => field !== 'login'),
  });
  // #648 B：显式确认位**真的救下了一次拦截**才多落这一行（沿用 `recordAdminAudit` 的既有写法：写失败只
  // warn，不阻断保存）。事实取**更新之后**的存量数，不拿请求体当事实：带确认位但本来就没拦住
  //（库里还有别人）时不多写一行假台账。
  if (confirmLastAdmin === true && leavesActiveAdminSet) {
    const remaining = await pool.query(
      `SELECT count(*)::int AS active_admins FROM users WHERE role = 'admin' AND status = 'active'`,
    );
    if (Number(remaining.rows[0]?.active_admins ?? 0) === 0) {
      await recordAdminAudit(pool, actorId, 'admin.user_last_admin_confirmed', current.login, {
        confirm_last_admin: true,
        remaining_active_admins: 0,
        role: result.rows[0].role,
        status: result.rows[0].status,
      });
    }
  }
  // #828 P1：语言偏好单独留一条台账。值写**人读**名称：`null` 记成「跟随浏览器」而不是字符串
  // "null"——否则审计里「清除」与「设成字符串 null」分不清，运维考古会读错。
  if (Object.hasOwn(updates, 'locale')) {
    await recordAdminAudit(pool, actorId, 'admin.user_locale_updated', current.login, {
      locale: nextLocale === null ? '跟随浏览器' : nextLocale,
    });
  }
  return { user: safeUser(result.rows[0]) };
}

/** 有 FDE 资源时排队下线；无资源用户立即禁用。用户行永久保留。 */
export async function deleteUser(pool, { actorId, userId, config, log = console } = {}) {
  if (actorId === userId) {
    throw new AdminError('self_delete', '管理员不能停用自己的账号', { en: 'an admin is not allowed to disable their own account', httpStatus: 409 });
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
    if (!target.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
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
        throw new AdminError('user_fde_name_missing', '有关联资源的用户缺少有效 fde_name，无法安全下线', { en: 'the user has associated resources but no valid fde_name, so it cannot be safely offboarded', httpStatus: 409 });
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
      throw new AdminError('user_has_related_data', '用户仍有关联记录，无法直接删除', { en: 'the user still has related records, so it cannot be deleted directly', httpStatus: 409 });
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
  if (!existing.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
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
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
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
 *   - 新口令不合规 / 与当前相同 → `validation_failed` + `details.field='new_password'`；
 *   - `confirm_password` 带了但与 `new_password` 不同 → `validation_failed` + `details.field='confirm_password'`。
 *
 * `confirmPassword`（#255 收尾）：**可选**的客户端一致性校验，见下面 `changeOwnPassword` 体内的注释。
 * 判定与 `new_password` 走**同一组**（旧口令校验之后的那一组），不另起一套路径。
 *
 * 口令明文**绝不入审计**（details 只有 login / 计数）。
 *
 * @returns {{ok: true, password_change_required: false, sessions_revoked: number}}
 */
export async function changeOwnPassword(pool, userId, currentPassword, newPassword, {
  currentSessionId = null, confirmPassword, limits = {}, log = console,
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
    throw new AdminError('invalid_credentials', '用户名或口令错误', { en: 'invalid username or password', httpStatus: 401 });
  }
  // ---- 新口令那一组（**旧口令校验之后**才走到，顺序是有意的，见下）----
  // 客户端一致性校验（#255 收尾）：请求体**带了** `confirm_password` 就必须与 `new_password` 相同。
  // 「带了」= 传进来的值不是 `undefined`（JSON 里没这个键 ⇒ `undefined` ⇒ 完全不参与）；
  // `null` / 数字 / 任何不相等的字符串都算「带了且不等」⇒ 400。反向**不要求必填**：
  // 契约 §2.6a 过去只有两个字段，已有绕过前端的调用方（脚本/集成测试），变成必填就是把它们打挂。
  //
  // 为什么挂在这一组（旧口令校验之后），而不是像形状校验那样放在最前面：
  //   ① 不泄露——这一条比较的两个值都是调用方自己给的，跟库里那枚哈希无关；放在旧口令校验
  //      **之前**会让「旧口令填错 + 两次新口令也没对齐」的人拿到 400 `validation_failed` 而不是
  //      401 `invalid_credentials`，即一个还没通过旧口令校验的人因为这条新规则看到了一种新响应，
  //      而这条新规则本身（「confirm 不等」）成了他唯一能撬开的信号。
  //   ② 既有语义零漂移——挂在之后 ⇒ 「旧口令错误」那条响应（状态码、code、details、限流计数、
  //      哈希、旗标、会话）**一字不变**，无论请求带不带 `confirm_password`、带的是什么值。
  //   ③ 与「新口令不得等于当前口令」同组：两条都是「新口令这一格合不合规」，错误形态同一个口径
  //      （`validation_failed` + `details.field`，前端靠 field 决定标红哪一格）。
  // 这条放在 `newPassword === currentPassword` **之前**：它只依赖请求自身，不依赖库里状态，
  // 先报它泄露的信息最少（「你自己两格打得不一样」是纯客户端事实）。
  if (confirmPassword !== undefined && confirmPassword !== newPassword) {
    throw new AdminError('validation_failed', '两次输入的新口令不一致', { en: 'the new password and its confirmation do not match', details: { field: 'confirm_password' } });
  }
  if (newPassword === currentPassword) {
    throw new AdminError('validation_failed', '新口令不得与当前口令相同', { en: 'the new password must not be the same as the current password', details: { field: 'new_password' } });
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
        RETURNING id, login, display_name, role, fde_name, auth_source, status, created_at, file_upload_enabled,
                  totp_login_enabled, last_activity_at,
                  (totp_secret IS NOT NULL) AS totp_enabled
     ), revoked AS (
       UPDATE login_sessions SET revoked_at = now()
        WHERE user_id = (SELECT id FROM target)
          AND revoked_at IS NULL
        RETURNING id
     )
     -- issue #497：同 updateUser——真列在 RETURNING 里拿，NULL 补位只留给派生量 last_login_at。
     -- 写成 NULL::timestamptz AS last_activity_at 会把真值覆盖成「从未活动」（重绑不该改活动时间）。
     SELECT target.*, NULL::timestamptz AS last_login_at FROM target`,
    [userId, totpSecret],
  );
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
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
  if (!result.rows[0]) throw new AdminError('not_found', '用户不存在', { en: 'user does not exist', httpStatus: 404 });
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
