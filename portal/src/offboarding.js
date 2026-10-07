// Durable FDE offboarding queue and delayed workspace/database purge.
import fs from 'node:fs';
import path from 'node:path';
import { enqueueMaterializeChange, enqueueRouteChange } from './outbox.js';
import { removeFdeContainer, removeFdeNetwork, createDockerClient, withFdeProvisioningLock } from './provisioner.js';
import { revokeFdeLlmConfigTx } from './llm.js';
import { removeGitCredentialFile } from './git-credential.js';
import { assertSafePath } from './fsutil.js';
import { validateFdeName } from './projects.js';

const STEPS = [
  'disable-user',
  'stop-container',
  'revoke-runner-token',
  'revoke-llm-key',
  'delete-git-credential',
  'release-network-routes',
  'schedule-workspace-purge',
];
const LOOP_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const LOOP_INTERVAL_MS = 5000;
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

async function releaseNetworkRoutes(pool, row, config, docker, log) {
  const changed = await withTransaction(pool, async (client) => {
    const allocations = await client.query(
      `UPDATE port_allocations
          SET state = 'released', released_at = COALESCE(released_at, now())
        WHERE fde_id = $1 AND state <> 'released'
        RETURNING id`,
      [row.fde_id],
    );
    if (allocations.rows.length > 0) {
      await client.query(
        `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
          WHERE allocation_id = ANY($1::uuid[]) AND state IN ('active', 'used')`,
        [allocations.rows.map((allocation) => allocation.id)],
      );
    }
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
      return true;
    }
    return false;
  });

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
  await pool.query(
    `UPDATE fde_offboarding
        SET workspace_purge_after = COALESCE(workspace_purge_after, now() + ($2 * interval '1 day')),
            updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, retentionDays],
  );
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
  releaseRoutes = releaseNetworkRoutes,
  retentionDays = config.workspaceRetentionDays ?? 30,
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

const USER_PURGE_QUERIES = [
  `DELETE FROM idempotency_keys WHERE user_id = $1`,
  `DELETE FROM api_tokens WHERE user_id = $1`,
  `DELETE FROM login_sessions WHERE user_id = $1`,
  `DELETE FROM login_pending WHERE user_id = $1`,
  `DELETE FROM preview_grants
    WHERE kind = 'session' AND parent_ticket_id IN (
      SELECT id FROM preview_grants
       WHERE user_id = $1 OR allocation_id IN (SELECT id FROM port_allocations WHERE fde_id = $1)
    )`,
  `DELETE FROM preview_grants
    WHERE user_id = $1 OR allocation_id IN (SELECT id FROM port_allocations WHERE fde_id = $1)`,
  `UPDATE preview_grants SET issuer_id = NULL WHERE issuer_id = $1`,
  `UPDATE approvals SET decided_by = NULL WHERE decided_by = $1`,
  `DELETE FROM run_queue
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM run_queue
    WHERE container_id IN (SELECT id FROM containers WHERE user_id = $1)
       OR owner_container_id IN (SELECT id FROM containers WHERE user_id = $1)`,
  `DELETE FROM tool_outputs
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM approvals
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM tool_calls
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM judge_decisions
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM run_checkpoints
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM transcript_rounds
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM run_events
    WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM artifacts
  WHERE run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)`,
  `DELETE FROM messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = $1)`,
  `DELETE FROM usage_ledger
    WHERE user_id = $1
       OR run_id IN (SELECT r.id FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE s.user_id = $1)
       OR project_id IN (SELECT id FROM projects WHERE user_id = $1)`,
  `DELETE FROM port_allocations WHERE fde_id = $1`,
  `DELETE FROM runs
    WHERE session_id IN (SELECT id FROM chat_sessions WHERE user_id = $1)`,
  `DELETE FROM chat_sessions WHERE user_id = $1`,
  `DELETE FROM projects WHERE user_id = $1`,
  `DELETE FROM materialize_outbox WHERE fde_id = $1`,
  `DELETE FROM materialize_revisions WHERE fde_id = $1`,
  `DELETE FROM fde_llm_bindings WHERE fde_id = $1`,
  `DELETE FROM fde_git_accounts WHERE fde_id = $1`,
  `DELETE FROM fde_onboarding WHERE fde_id = $1`,
  `DELETE FROM fde_networks WHERE fde_id = $1`,
  `DELETE FROM containers WHERE user_id = $1`,
  `UPDATE audit_log SET actor_id = NULL WHERE actor_id = $1`,
];

async function purgeUserRows(pool, row, now) {
  for (const sql of USER_PURGE_QUERIES) {
    await pool.query(sql, [row.fde_id]);
  }
  await pool.query(`DELETE FROM users WHERE id = $1`, [row.fde_id]);
  await pool.query(
    `INSERT INTO audit_log (actor_id, action, target, details)
     VALUES (NULL, 'admin.user_offboarded', $1, $2::jsonb)`,
    [row.fde_name, JSON.stringify({
      fde_id: row.fde_id,
      workspace_purge_after: isoDate(row.workspace_purge_after),
    })],
  );
  await pool.query(
    `DELETE FROM fde_offboarding
      WHERE fde_id = $1 AND state = 'done' AND workspace_purge_after <= $2`,
    [row.fde_id, now],
  );
}

/**
 * Remove only completed, expired offboarding workspaces. Every DB statement commits
 * independently so a failure can resume from the same done row on the next sweep.
 */
export async function sweepOffboardedWorkspaces(pool, config, {
  log = console,
  now = new Date(),
  limit = PURGE_BATCH_SIZE,
  removeWorkspace = deleteWorkspaceDirectory,
  lockFde = withFdeProvisioningLock,
} = {}) {
  if ((config.workspaceRetentionDays ?? 30) === 0) return { disabled: true, purged: 0, failed: 0 };
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
        await purgeUserRows(pool, row, now);
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startOffboardingLoop(pool, config, { docker, log = console, onPause } = {}) {
  if (!docker) docker = createDockerClient({ dockerHost: config.dockerHost });
  let stopped = false;
  let consecutiveFailures = 0;
  let recoveredInterruptedWork = false;
  let lastSweepAt = 0;
  (async () => {
    while (!stopped) {
      try {
        if (!recoveredInterruptedWork) {
          const recovered = await recoverInterruptedOffboardings(pool);
          if (recovered > 0) log.warn?.(`[offboarding] recovered ${recovered} interrupted task(s)`);
          recoveredInterruptedWork = true;
        }
        await runOffboardingOnce(pool, config, { docker, log });
        if (Date.now() - lastSweepAt >= SWEEP_INTERVAL_MS) {
          await sweepOffboardedWorkspaces(pool, config, { log });
          lastSweepAt = Date.now();
        }
        consecutiveFailures = 0;
        await sleep(LOOP_INTERVAL_MS);
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[offboarding] loop error: ${err.message}`);
        onPause?.('offboarding', err);
        const backoff = LOOP_BACKOFF_MS[Math.min(consecutiveFailures - 1, LOOP_BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
