// Durable FDE offboarding workflow and optional workspace-directory cleanup.
import fs from 'node:fs';
import path from 'node:path';
import { enqueueMaterializeChange, enqueueRouteChange } from './outbox.js';
import { removeFdeContainer, removeFdeNetwork, createDockerClient, withFdeProvisioningLock } from './provisioner.js';
import { revokeFdeLlmConfigTx } from './llm.js';
import { removeGitCredentialFile } from './git-credential.js';
import { assertSafePath } from './fsutil.js';
import { validateFdeName } from './projects.js';
import { disableGiteaAccount } from './git-mint.js';
import { attachLoopWatch, envInt, idleDelayMs, MAX_BACKOFF_MS_SAFE, sleepCancellable } from './loop-timing.js';

const STEPS = [
  'disable-user',
  'stop-container',
  'revoke-runner-token',
  'revoke-llm-key',
  'delete-git-credential',
  'revoke-git-account-access',
  'release-network-routes',
  'schedule-workspace-purge',
];
const LOOP_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
export const LOOP_INTERVAL_MS = 5000;
// issue #520：`LOOP_INTERVAL_MS` 现在是**有活时的基准节拍**；认领 0 行 ⇒ 5000 → 10000 → 20000 →
// `OFFBOARDING_IDLE_BACKOFF_MAX_MS`（缺省 30000）封顶，认领到活立刻回 5000（形状与 #506 一致）。
// 代价：空闲后新入队的销号**最坏 30s 才开始**（改前 5s）。销号是管理台显式动作后的多步长流程，
// 且它的用户可见承诺是「已停用 + 已吊 token」（在那之前同步做完）而不是「几秒内开始」。
/** 代码缺省（运维面用例钉的就是它：`deploy/docker-compose.yml` 的插值缺省必须与此逐字相等）。 */
export const IDLE_BACKOFF_MAX_MS_DEFAULT = 30000;
// 工作区目录清理的**阈值**是定时语义，不是退避对象（issue #520 判据 2 的“有明确定时语义”那一支）：
// 它的阈值就是产品语义（「离队满 1 小时才清」），而且它已经与主拍解耦（下面那个
// `tickAt - lastSweepAt >= SWEEP_INTERVAL_MS` 闸门）；反而若把它改成“没活就不跑”，
// 一个全部 FDE 已处理完的平台就永远不会清盘。
// ⚠ 口径说准（PR #552 审计 LOW-3）：闸门本身是**在每一拍上检查**的，不是独立定时器
// ⇒ 1h 这个**阈值**一个字没动，但**节拍**受空闲拍影响：典型比原定时刻晚 ~max/2（默认 ≈ 15s），
// 最坏晚一整个空闲拍 ≤ max（默认 30s）。对 1h 粒度是噪声，但不是「完全不受影响」。
// 量级对照：`OFFBOARDING_IDLE_BACKOFF_MAX_MS=3600000`（1h）那种配法会把清理拖到最坏晚 1h ——
// 那已经是拿旋钮改业务语义，不是本注释放行的范围。
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const PURGE_BATCH_SIZE = 20;

function parseSteps(value) {
  const steps = typeof value === 'string' ? JSON.parse(value) : value;
  if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) {
    throw new TypeError('offboarding steps must be an object');
  }
  return steps;
}

function currentStep(steps) {
  return STEPS.find((name) => steps[name]?.state !== 'done') ?? null;
}

function isoDate(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function offboardingStatus(row) {
  if (!row?.state) return null;
  const steps = parseSteps(row.steps ?? {});
  return {
    state: row.state,
    step: row.state === 'done' ? null : currentStep(steps),
    error: row.last_error ?? null,
    workspace_purge_after: isoDate(row.workspace_purge_after),
  };
}

export function initialOffboardingSteps() {
  return Object.fromEntries(STEPS.map((step) => [step, { state: 'pending' }]));
}

/** Insert once; duplicate DELETE requests return the existing durable workflow state. */
export async function enqueueOffboarding(client, { fdeId, fdeName } = {}) {
  const steps = initialOffboardingSteps();
  await client.query(
    `INSERT INTO fde_offboarding (fde_id, fde_name, state, steps)
     VALUES ($1, $2, 'pending', $3::jsonb)
     ON CONFLICT (fde_id) DO NOTHING`,
    [fdeId, fdeName, JSON.stringify(steps)],
  );
  const result = await client.query(
    `SELECT state, steps, last_error, workspace_purge_after
       FROM fde_offboarding WHERE fde_id = $1`,
    [fdeId],
  );
  return offboardingStatus(result.rows[0]);
}

/** Detect an existing workspace without following a possibly hostile FDE-name symlink. */
export function workspaceExists(config, fdeName) {
  if (!validateFdeName(fdeName).ok || typeof config?.userSpaceRoot !== 'string' || !config.userSpaceRoot) {
    return false;
  }
  const root = path.resolve(config.userSpaceRoot);
  try {
    fs.lstatSync(root);
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
  try {
    fs.lstatSync(path.join(root, fdeName));
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function claimOne(pool) {
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT o.fde_id, o.fde_name, o.steps,
              (SELECT c.container_name FROM containers c WHERE c.user_id = o.fde_id LIMIT 1) AS container_name,
              (SELECT n.network_name FROM fde_networks n WHERE n.fde_id = o.fde_id) AS network_name
         FROM fde_offboarding o
        WHERE o.state = 'pending'
        ORDER BY o.created_at, o.fde_id
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) return null;
    const claimed = await client.query(
      `UPDATE fde_offboarding
          SET state = 'running', attempt = attempt + 1, last_error = NULL, updated_at = now()
        WHERE fde_id = $1
        RETURNING attempt`,
      [row.fde_id],
    );
    return { ...row, attempt: claimed.rows[0]?.attempt };
  });
}

async function saveStep(pool, fdeId, stepName, value) {
  await pool.query(
    `UPDATE fde_offboarding
        SET steps = jsonb_set(steps, ARRAY[$2]::text[], $3::jsonb, true), updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, stepName, JSON.stringify(value)],
  );
}

async function saveFailure(pool, fdeId, stepName, value, error) {
  const message = String(error?.message ?? error);
  await pool.query(
    `UPDATE fde_offboarding
        SET state = 'failed',
            steps = jsonb_set(steps, ARRAY[$2]::text[], $3::jsonb, true),
            last_error = $4, updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, stepName, JSON.stringify(value), message],
  );
}

async function disableUser(pool, fdeId) {
  await pool.query(
    `UPDATE users SET status = 'disabled', disabled_at = COALESCE(disabled_at, now())
      WHERE id = $1`,
    [fdeId],
  );
  await pool.query(`DELETE FROM login_sessions WHERE user_id = $1`, [fdeId]);
  await pool.query(`DELETE FROM login_pending WHERE user_id = $1`, [fdeId]);
  await pool.query(
    `UPDATE runs r
        SET status = 'cancelling', cancel_requested_at = COALESCE(cancel_requested_at, now())
       FROM chat_sessions s
      WHERE r.session_id = s.id AND s.user_id = $1
        AND r.status IN ('queued', 'running', 'cancelling')`,
    [fdeId],
  );
}

async function stopContainer(pool, row, docker, log) {
  const containerName = row.container_name || (row.fde_name ? `fde-${row.fde_name}` : null);
  if (containerName) {
    const removed = await removeFdeContainer(docker, containerName, { log });
    if (!removed.ok) throw new Error(`container removal failed for ${containerName}`);
  }
  await pool.query(
    `UPDATE containers SET status = 'removed', updated_at = now()
      WHERE user_id = $1 AND status <> 'removed'`,
    [row.fde_id],
  );
}

async function revokeRunnerToken(pool, fdeId) {
  await pool.query(
    `UPDATE containers
        SET runner_token_hash = NULL, token_generation = token_generation + 1,
            revoked_at = COALESCE(revoked_at, now()), updated_at = now()
      WHERE user_id = $1 AND runner_token_hash IS NOT NULL`,
    [fdeId],
  );
}

async function revokeLlmKey(pool, row, gateway) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`llm-binding:${row.fde_name}`]);
    await revokeFdeLlmConfigTx(client, { fdeId: row.fde_id, fdeName: row.fde_name, gateway });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * `release-network-routes` 一步：释放本 FDE 的端口/网络行 + 撤销预览凭证（issue #252 修正后口径）。
 *
 * 两条口径（都是真机踩出来的，别再改回去）：
 *  1. **只撤 `state = 'active'`**。`used` 是历史事实（ticket 已消费 ⇒ `used_at` 非空），它本身不再授予
 *     访问，派生出的 `session` 行才是活的东西、而 session 会在同一批里被撤。把 `used` 也塞进 `revoked`
 *     会当场撞 baseline 的双向 CHECK `(state = 'used') = (used_at IS NOT NULL)`（`preview_grants_check3`，
 *     真机即 `moveFdePreviewBlock` 的 500）；而「顺手 `used_at = NULL`」虽然过 CHECK，却是**篡改历史**。
 *     同理 `expired` / `revoked` 也不再授予访问，不打扰（reaper 负责清）。
 *  2. **撤权不许依赖「本次是否释放了行」**。重试路径上本 FDE 的 allocation 已是 `released`（上一次事务
 *     里释放成功、撤权撞 CHECK 整笔回滚 ⇒ 步骤被记 `done`），守卫为假 ⇒ 撤权整段**静默跳过**，真机
 *     因此留下 21 条 `active`/`used` 残渣。所以：id 集合取**本 FDE 的全部 allocation**（含早已 released 的），
 *     撤权**无条件发**（撤 0 行本来就是成功），两个数分别打日志（见函数末尾），别合成一个条件。
 */
async function releaseNetworkRoutes(pool, row, config, docker, log) {
  const { releasedCount, revokedCount, changed } = await withTransaction(pool, async (client) => {
    const allocations = await client.query(
      `UPDATE port_allocations
          SET state = 'released', released_at = COALESCE(released_at, now())
        WHERE fde_id = $1 AND state <> 'released'
        RETURNING id`,
      [row.fde_id],
    );
    // 撤权的 id 集合 = 本 FDE 的**全部** allocation（本次释放的 + 历史已 released 的），
    // 否则残渣正好落在「本次没释放行 ⇒ 不撤权」这个守卫选不到的那一侧（#252 的静默丢失）。
    const allocationsAll = await client.query(
      `SELECT id FROM port_allocations WHERE fde_id = $1`,
      [row.fde_id],
    );
    const revoked = await client.query(
      `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
        WHERE allocation_id = ANY($1::uuid[]) AND state = 'active'
        RETURNING id`,
      [allocationsAll.rows.map((allocation) => allocation.id)],
    );
    const network = await client.query(
      `UPDATE fde_networks
          SET state = 'released', released_at = COALESCE(released_at, now())
        WHERE fde_id = $1 AND state <> 'released'
        RETURNING network_name`,
      [row.fde_id],
    );
    if (allocations.rows.length > 0 || network.rows.length > 0) {
      await enqueueRouteChange(client, {
        aggregate: 'fde_network',
        aggregateId: row.fde_id,
        op: 'delete',
        payload: { network_name: network.rows[0]?.network_name ?? row.network_name ?? `fde-${row.fde_name}` },
      });
      await enqueueMaterializeChange(client, { fdeId: row.fde_id, op: 'delete' });
      return {
        releasedCount: allocations.rows.length,
        revokedCount: revoked.rows.length,
        changed: true,
      };
    }
    return {
      releasedCount: allocations.rows.length,
      revokedCount: revoked.rows.length,
      changed: false,
    };
  });
  // 两个数分开打：`released=0` 而 `revoked>0` 正是「重试补上了上次漏掉的撤权」的形状（#252 的残渣）。
  log.info?.(
    `[offboarding] fde=${row.fde_name} release-network-routes: 本次释放 allocation ${releasedCount} 条、`
    + `撤预览 grant（仅 active）${revokedCount} 条`,
  );

  const networkName = row.network_name || (row.fde_name ? `fde-${row.fde_name}` : null);
  if (networkName) {
    const removed = await removeFdeNetwork(docker, networkName, { log });
    if (!removed.ok) {
      log.warn?.(`[offboarding] network removal failed for ${networkName}; DB routes are released`);
    }
  }
  return changed;
}

async function scheduleWorkspacePurge(pool, fdeId, retentionDays) {
  if (retentionDays === 0) return;
  await pool.query(
    `UPDATE fde_offboarding
        SET workspace_purge_after = COALESCE(workspace_purge_after, now() + ($2 * interval '1 day')),
            updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, retentionDays],
  );
}

async function revokeGitAccountAccess(pool, fdeId, disableAccount = disableGiteaAccount) {
  const result = await pool.query(
    `SELECT a.remote_login, h.provider, h.base_url, h.admin_key, h.mode
       FROM fde_git_accounts a
       LEFT JOIN git_hosts h ON h.id = a.git_host_id
      WHERE a.fde_id = $1`,
    [fdeId],
  );
  const account = result.rows[0];
  if (!account) return { note: 'No linked Git account' };
  if (!account.provider) return { note: 'Git host is absent; no upstream access to revoke' };
  if (account.mode !== 'minted') {
    return { note: 'Skipped: user-managed Git account remains enabled' };
  }
  if (account.provider === 'gitlab') {
    return { note: 'Skipped: GitLab account revocation is deferred' };
  }
  if (account.provider !== 'gitea') {
    return { note: `Skipped: upstream account revocation is unsupported for ${account.provider}` };
  }
  if (!account.remote_login) return { note: 'No minted Git account exists' };

  const outcome = await disableAccount({
    baseUrl: account.base_url,
    adminKey: account.admin_key,
    login: account.remote_login,
  });
  return {
    note: outcome.reason === 'absent'
      ? 'Gitea account is already absent'
      : 'Gitea account access disabled with prohibit_login',
  };
}

/**
 * Claim and execute at most one offboarding task. Function overrides make the queue
 * testable without Docker, LiteLLM, or a production user-space root.
 */
export async function runOffboardingOnce(pool, config, {
  docker,
  log = console,
  lockFde = withFdeProvisioningLock,
  stop = stopContainer,
  revokeKey = revokeLlmKey,
  removeCredential = removeGitCredentialFile,
  disableGitAccount = disableGiteaAccount,
  releaseRoutes = releaseNetworkRoutes,
  retentionDays = config.workspaceRetentionDays ?? 0,
} = {}) {
  const row = await claimOne(pool);
  if (!row) return { claimed: false };

  const steps = parseSteps(row.steps);
  let activeStep = null;
  try {
    if (!docker) docker = createDockerClient({ dockerHost: config.dockerHost });
    await lockFde(pool, row.fde_name, async () => {
      for (const step of STEPS) {
        if (steps[step]?.state === 'done') continue;
        activeStep = step;
        const stepValue = { ...steps[step], state: 'running' };
        await saveStep(pool, row.fde_id, step, stepValue);

        if (step === 'disable-user') {
          await disableUser(pool, row.fde_id);
        } else if (step === 'stop-container') {
          await stop(pool, row, docker, log);
        } else if (step === 'revoke-runner-token') {
          await revokeRunnerToken(pool, row.fde_id);
        } else if (step === 'revoke-llm-key') {
          await revokeKey(pool, row, config);
        } else if (step === 'delete-git-credential') {
          removeCredential({ config, fdeName: row.fde_name });
        } else if (step === 'revoke-git-account-access') {
          const outcome = await revokeGitAccountAccess(pool, row.fde_id, disableGitAccount);
          if (outcome.note) stepValue.note = outcome.note;
        } else if (step === 'release-network-routes') {
          await releaseRoutes(pool, row, config, docker, log);
        } else if (step === 'schedule-workspace-purge') {
          await scheduleWorkspacePurge(pool, row.fde_id, retentionDays);
        }

        steps[step] = { ...stepValue, state: 'done' };
        delete steps[step].error;
        await saveStep(pool, row.fde_id, step, steps[step]);
      }
    });
    await pool.query(
      `UPDATE fde_offboarding SET state = 'done', last_error = NULL, updated_at = now() WHERE fde_id = $1`,
      [row.fde_id],
    );
    return { claimed: true, fdeId: row.fde_id, state: 'done' };
  } catch (err) {
    const failedStep = activeStep ?? currentStep(steps) ?? STEPS.at(-1);
    const message = String(err?.message ?? err);
    const value = { ...steps[failedStep], state: 'failed', error: message };
    await saveFailure(pool, row.fde_id, failedStep, value, message);
    log.warn?.(`[offboarding] failed fde=${row.fde_id} step=${failedStep}: ${message}`);
    return { claimed: true, fdeId: row.fde_id, state: 'failed', step: failedStep, error: message };
  }
}

export async function retryOffboarding(pool, fdeId) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT state, steps, last_error, workspace_purge_after
         FROM fde_offboarding WHERE fde_id = $1 FOR UPDATE`,
      [fdeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.state !== 'failed') return offboardingStatus(row);
    const steps = parseSteps(row.steps);
    const failedStep = STEPS.find((step) => steps[step]?.state === 'failed');
    if (failedStep) {
      steps[failedStep] = { ...steps[failedStep], state: 'pending' };
      delete steps[failedStep].error;
    }
    const updated = await client.query(
      `UPDATE fde_offboarding
          SET state = 'pending', steps = $2::jsonb, last_error = NULL, updated_at = now()
        WHERE fde_id = $1
        RETURNING state, steps, last_error, workspace_purge_after`,
      [fdeId, JSON.stringify(steps)],
    );
    return offboardingStatus(updated.rows[0] ?? { state: 'pending', steps });
  });
}

export async function recoverInterruptedOffboardings(pool) {
  const result = await pool.query(
    `UPDATE fde_offboarding
        SET state = 'pending', last_error = NULL, updated_at = now()
      WHERE state = 'running'
      RETURNING fde_id`,
  );
  return result.rows.length;
}

function safeWorkspaceDirectory(root, fdeName) {
  if (!validateFdeName(fdeName).ok) {
    throw new Error(`invalid offboarding fde_name: ${String(fdeName)}`);
  }
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error('workspace root must not be a filesystem root');
  }
  let realRoot;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  const target = path.join(resolvedRoot, fdeName);
  assertSafePath(resolvedRoot, target);
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
  if (targetStat.isSymbolicLink()) {
    assertSafePath(resolvedRoot, target);
  }
  const realTarget = fs.realpathSync(target);
  assertSafePath(realRoot, realTarget);
  const relative = path.relative(realRoot, realTarget);
  if (relative !== fdeName || path.isAbsolute(relative)) {
    throw new Error(`workspace path escapes root: ${target}`);
  }
  return realTarget;
}

function deleteWorkspaceDirectory(root, fdeName) {
  const target = safeWorkspaceDirectory(root, fdeName);
  if (!target) return false;
  fs.rmSync(target, { recursive: true, force: true });
  return true;
}

/**
 * Remove only completed, explicitly scheduled offboarding workspaces. User and
 * offboarding database rows remain as permanent account and audit records.
 */
export async function sweepOffboardedWorkspaces(pool, config, {
  log = console,
  now = new Date(),
  limit = PURGE_BATCH_SIZE,
  removeWorkspace = deleteWorkspaceDirectory,
  lockFde = withFdeProvisioningLock,
} = {}) {
  if ((config.workspaceRetentionDays ?? 0) === 0) return { disabled: true, purged: 0, failed: 0 };
  const expired = await pool.query(
    `SELECT fde_id, fde_name, workspace_purge_after
       FROM fde_offboarding
      WHERE state = 'done' AND workspace_purge_after IS NOT NULL AND workspace_purge_after <= $1
      ORDER BY workspace_purge_after, fde_id
      LIMIT $2`,
    [now, limit],
  );
  let purged = 0;
  let failed = 0;
  for (const row of expired.rows) {
    try {
      await lockFde(pool, row.fde_name, async () => {
        removeWorkspace(config.userSpaceRoot, row.fde_name);
      });
      purged += 1;
    } catch (err) {
      failed += 1;
      const message = String(err?.message ?? err);
      log.warn?.(`[offboarding] workspace purge failed fde=${row.fde_id}: ${message}`);
      await pool.query(
        `UPDATE fde_offboarding SET last_error = $2, updated_at = now()
          WHERE fde_id = $1 AND state = 'done'`,
        [row.fde_id, message],
      ).catch((updateError) => {
        log.error?.(`[offboarding] could not record purge failure fde=${row.fde_id}: ${updateError.message}`);
      });
    }
  }
  return { disabled: false, purged, failed };
}

/**
 * 常驻销号循环。
 *
 * issue #520 的三件事，分开记：
 *  1. **主拍退避**（本单改的）：`runOffboardingOnce()` 认领 0 行 ⇒ 5000 → 10000 → 20000 →
 *     `OFFBOARDING_IDLE_BACKOFF_MAX_MS`（默认 30000）封顶；认领到活立刻回 5000。
 *  2. **1h 工作区清理的阈值不跟着退避**（判据 2 的「定时语义」那一支）：它的阈值就是它的语义
 *     （「离队满 1 小时才清盘」），而且它不靠拍频驱动，靠的是 `now() - lastSweepAt >= SWEEP_INTERVAL_MS`
 *     这个闸门——把它挂到「有活才跑」上，一个已全部处理完的平台就永远不会清盘。
 *     ⚠ 但闸门是**每拍检查**的，不是独立定时器 ⇒ 空闲拍变长会把它**拖后**：典型 ~max/2，最坏 ≤ max
 *     （默认 30s）。说「完全不影响日程」是错的，说「会被退避饿死」也是错的（判据：用例 C1）。
 *  3. 句柄补成 #506 同形（`stop`/`done`/`settled`/`failure`）：`stop()` 现在会 abort 正在睡的那一拍。
 * `now` 也是注入缝（生产仍是 `Date.now()`）——闸门必须能在假时钟下被测到，否则只能真等 1h。
 */
export function startOffboardingLoop(pool, config, {
  docker,
  log = console,
  onPause,
  sleep = sleepCancellable,
  now = () => Date.now(),
  env = process.env, // 单测注入旋钮用；生产不传 ⇒ process.env
  idleBackoffMaxMs = envInt('OFFBOARDING_IDLE_BACKOFF_MAX_MS', IDLE_BACKOFF_MAX_MS_DEFAULT, { max: MAX_BACKOFF_MS_SAFE, log, env }),
} = {}) {
  if (!docker) docker = createDockerClient({ dockerHost: config.dockerHost });
  let consecutiveFailures = 0;
  let recoveredInterruptedWork = false;
  let lastSweepAt = 0;
  let idleTicks = 0; // 连续空闲拍数（认领到活就清 0）
  const abort = new AbortController();
  const done = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (!recoveredInterruptedWork) {
          const recovered = await recoverInterruptedOffboardings(pool);
          if (recovered > 0) log.warn?.(`[offboarding] recovered ${recovered} interrupted task(s)`);
          recoveredInterruptedWork = true;
        }
        const { claimed = false } = (await runOffboardingOnce(pool, config, { docker, log })) ?? {};
        // 清理闸门与「有没有活」无关（语义见上面注释第 2 条）；`Date.now()` → `now()` 只是可测缝，不是行为改动。
        // ⚠ 它是**每拍检查一次**的时间门：空闲拍退到 30s ⇒ 清理最坏比原定时刻晚一个拍（≤ max），不是按秒准时。
        const tickAt = now();
        if (tickAt - lastSweepAt >= SWEEP_INTERVAL_MS) {
          await sweepOffboardedWorkspaces(pool, config, { log });
          lastSweepAt = tickAt;
        }
        consecutiveFailures = 0;
        idleTicks = claimed ? 0 : idleTicks + 1;
        if (!(await sleep(idleDelayMs(idleTicks, { baseMs: LOOP_INTERVAL_MS, maxMs: idleBackoffMaxMs }), abort.signal))) break;
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[offboarding] loop error: ${err.message}`);
        onPause?.('offboarding', err);
        const backoff = LOOP_BACKOFF_MS[Math.min(consecutiveFailures - 1, LOOP_BACKOFF_MS.length - 1)];
        if (!(await sleep(backoff, abort.signal))) break;
      }
    }
  })();
  const { settled, failure } = attachLoopWatch(done, (msg) => log.warn?.(`[offboarding] ${msg}`));
  return {
    stop() {
      abort.abort();
    },
    done,
    settled,
    failure,
  };
}
