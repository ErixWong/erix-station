// Async FDE onboarding queue and its durable, step-by-step progress.
import { enqueueMaterializeChange } from './outbox.js';
import { runMaterializerOnce } from './materializer.js';
import { createDockerClient, onboardFde } from './provisioner.js';
import { LlmError, LlmGatewayError, setFdeLlmConfig } from './llm.js';
import { attachLoopWatch, envInt, idleDelayMs, MAX_BACKOFF_MS_SAFE, sleepCancellable } from './loop-timing.js';

const STEPS = ['provision', 'materialize', 'llm-binding'];
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const MATERIALIZE_TIMEOUT_MS = 120000;

// issue #520：空闲退避（#506 同族，那是 outbox 两个循环，本单是其余轮询器）。
// **改前**：`await sleep(5000)` 是固定节拍，与「本轮有没有认领到活」无关 —— 平台空闲时
// `claimOne()`（BEGIN + SELECT ... FOR UPDATE SKIP LOCKED + COMMIT）每 5s 白跑一次。
// **改后**：`runOnboardingOnce()` 返回 `claimed:false`（认领 0 行）⇒ 5000 → 10000 → 20000 →
// `ONBOARDING_IDLE_BACKOFF_MAX_MS`（默认 30000）封顶；认领到活立刻回 5000。
// 代价与理由（要改这个默认值请连这段一起改）：空闲后新入队的开户任务**最坏 30s 后才开始**
// （改前最坏 5s）。开户本身是**人在管理台点出来的**多步长任务（provision → materialize →
// llm-binding，单步超时 120s，见 `MATERIALIZE_TIMEOUT_MS`），30s 的排队等待相对它的总时长是
// 噪声级；而 30s 上限换来的空闲收益是这条循环的表扫降到 1/6。要更激进就配 60000（上限
// `MAX_BACKOFF_MS_SAFE`=60s，再大就越过 Node timer 的语义边界，理由见 `loop-timing.js`）。
export const LOOP_INTERVAL_MS = 5000;
/** 代码缺省（运维面用例钉的就是它：`deploy/docker-compose.yml` 的插值缺省必须与此逐字相等）。 */
export const IDLE_BACKOFF_MAX_MS_DEFAULT = 30000;

function parseSteps(value) {
  const steps = typeof value === 'string' ? JSON.parse(value) : value;
  if (steps === null || typeof steps !== 'object' || Array.isArray(steps)) {
    throw new TypeError('onboarding steps must be an object');
  }
  return steps;
}

function currentStep(steps) {
  return STEPS.find((name) => steps[name]?.state !== 'done') ?? null;
}

export function onboardingStatus(row) {
  if (!row?.state) return null;
  const steps = parseSteps(row.steps ?? {});
  return {
    state: row.state,
    step: ['done', 'awaiting_credential'].includes(row.state) ? null : currentStep(steps),
    error: row.last_error ?? null,
    ...(steps['llm-binding'] ? {
      llm_binding: {
        state: steps['llm-binding'].state,
        error: steps['llm-binding'].error ?? null,
      },
    } : {}),
  };
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

/** Enqueue a user and persist its host assignment and selected models in the caller's transaction. */
export async function enqueueOnboarding(client, { fdeId, gitHostId, llm, previousTokenRef = null }) {
  const steps = {
    provision: {
      state: 'pending',
      ...(previousTokenRef == null ? {} : { previousTokenRef }),
    },
    materialize: { state: 'pending' },
    'llm-binding': {
      state: 'pending',
      models: {
        provider_id: llm.provider_id,
        main_model_id: llm.main_model_id,
        embedding_model_id: llm.embedding_model_id ?? null,
        vision_model_id: llm.vision_model_id ?? null,
      },
    },
  };
  await client.query(
    `INSERT INTO fde_onboarding (fde_id, state, steps)
     VALUES ($1, 'pending', $2::jsonb)
     ON CONFLICT (fde_id) DO UPDATE
       SET state = 'pending', steps = EXCLUDED.steps, last_error = NULL, attempt = 0, updated_at = now()`,
    [fdeId, JSON.stringify(steps)],
  );
  await client.query(
    `INSERT INTO fde_git_accounts (fde_id, git_host_id)
     VALUES ($1, $2)
     ON CONFLICT (fde_id) DO UPDATE
       SET git_host_id = EXCLUDED.git_host_id,
           remote_login = CASE WHEN fde_git_accounts.git_host_id = EXCLUDED.git_host_id
                               THEN fde_git_accounts.remote_login ELSE NULL END,
           token_ref = CASE WHEN fde_git_accounts.git_host_id = EXCLUDED.git_host_id
                            THEN fde_git_accounts.token_ref ELSE NULL END,
           updated_at = now()`,
    [fdeId, gitHostId],
  );
  return onboardingStatus({ state: 'pending', steps, last_error: null });
}

async function claimOne(pool) {
  return withTransaction(pool, async (client) => {
    const selected = await client.query(
      `SELECT o.fde_id, o.steps, u.fde_name, a.git_host_id
         FROM fde_onboarding o
         JOIN users u ON u.id = o.fde_id
         JOIN fde_git_accounts a ON a.fde_id = o.fde_id
        WHERE o.state = 'pending'
          AND u.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM fde_offboarding off
             WHERE off.fde_id = o.fde_id AND off.state IN ('pending', 'running')
          )
        ORDER BY o.created_at, o.fde_id
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) return null;
    const claimed = await client.query(
      `UPDATE fde_onboarding
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
    `UPDATE fde_onboarding
        SET steps = jsonb_set(steps, ARRAY[$2]::text[], $3::jsonb, true), updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, stepName, JSON.stringify(value)],
  );
}

async function saveFailure(pool, fdeId, stepName, value, error) {
  const message = String(error?.message ?? error);
  await pool.query(
    `UPDATE fde_onboarding
        SET state = 'failed',
            steps = jsonb_set(steps, ARRAY[$2]::text[], $3::jsonb, true),
            last_error = $4, updated_at = now()
      WHERE fde_id = $1`,
    [fdeId, stepName, JSON.stringify(value), message],
  );
}

function safeLlmBindingError(error) {
  if (error instanceof LlmError) return error.message;
  if (error instanceof LlmGatewayError) return `LiteLLM virtual-key setup failed (HTTP ${error.status})`;
  return 'LLM binding setup failed; check LiteLLM and database availability before retrying';
}

async function publishMaterializeRevision(pool, config, fdeId, revision, { log, materialize }) {
  const deadline = Date.now() + MATERIALIZE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await materialize(pool, config, { log, workerId: `onboarding-${fdeId}` });
    const result = await pool.query(
      `SELECT state, last_error FROM materialize_outbox WHERE fde_id = $1 AND revision = $2`,
      [fdeId, revision],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`materialize revision ${revision} disappeared`);
    if (row.state === 'published') return;
    if (row.state === 'failed' || row.last_error) {
      throw new Error(row.last_error || `materialize revision ${revision} failed`);
    }
    if (row.state === 'processing') await sleep(100);
  }
  throw new Error(`materialize revision ${revision} did not publish within ${MATERIALIZE_TIMEOUT_MS}ms`);
}

/**
 * Claim and execute at most one onboarding item. Optional function overrides keep
 * the workflow testable without a Docker daemon or a filesystem materializer.
 */
export async function runOnboardingOnce(pool, config, {
  docker,
  log = console,
  provision = onboardFde,
  materialize = runMaterializerOnce,
  bindLlm = setFdeLlmConfig,
} = {}) {
  const row = await claimOne(pool);
  if (!row) return { claimed: false };

  const steps = parseSteps(row.steps);
  let activeStep = null;
  try {
    for (const step of STEPS) {
      if (steps[step]?.state === 'done') continue;
      activeStep = step;
      const stepValue = { ...steps[step], state: 'running' };
      await saveStep(pool, row.fde_id, step, stepValue);

      if (step === 'provision') {
        if (!row.fde_name || !row.git_host_id) {
          throw new Error('onboarding requires fde_name and git host assignment');
        }
        // Keep provision's LLM sync: it republishes active routes after container recreation.
        // With no binding it is a no-op; this later step enqueues an upsert when it creates/restores the selection.
        await provision(pool, config, {
          fdeName: row.fde_name,
          gitHostId: row.git_host_id,
          previousTokenRef: stepValue.previousTokenRef,
          docker,
          log,
        });
      } else if (step === 'materialize') {
        const revision = await withTransaction(pool, (client) =>
          enqueueMaterializeChange(client, { fdeId: row.fde_id, op: 'upsert' }));
        await publishMaterializeRevision(pool, config, row.fde_id, revision, { log, materialize });
      } else if (!stepValue.models) {
        steps[step] = { ...stepValue, state: 'done', skipped: true };
        await saveStep(pool, row.fde_id, step, steps[step]);
        continue;
      } else {
        try {
          await bindLlm(pool, {
            actorId: null,
            fdeName: row.fde_name,
            ...stepValue.models,
            allowAwaitingCredential: true,
            onlyIfMissing: true,
            gateway: config,
          });
        } catch (err) {
          const message = safeLlmBindingError(err);
          steps[step] = { ...stepValue, state: 'failed', error: message };
          await saveStep(pool, row.fde_id, step, steps[step]);
          log.warn?.(`[onboarding] failed fde=${row.fde_id} step=${step}: ${message}`);
          activeStep = null;
          continue;
        }
      }

      steps[step] = { ...stepValue, state: 'done' };
      if (step === 'provision') delete steps[step].previousTokenRef;
      delete steps[step].error;
      await saveStep(pool, row.fde_id, step, steps[step]);
    }

    activeStep = null;
    const user = await pool.query(`SELECT status FROM users WHERE id = $1`, [row.fde_id]);
    const state = user.rows[0]?.status === 'awaiting_credential' ? 'awaiting_credential' : 'done';
    await pool.query(
      `UPDATE fde_onboarding SET state = $2, last_error = NULL, updated_at = now() WHERE fde_id = $1`,
      [row.fde_id, state],
    );
    return { claimed: true, fdeId: row.fde_id, state };
  } catch (err) {
    const failedStep = activeStep ?? currentStep(steps) ?? STEPS.at(-1);
    const message = failedStep === 'llm-binding' ? safeLlmBindingError(err) : String(err?.message ?? err);
    const value = { ...steps[failedStep], state: 'failed', error: message };
    await saveFailure(pool, row.fde_id, failedStep, value, message);
    log.warn?.(`[onboarding] failed fde=${row.fde_id} step=${failedStep}: ${message}`);
    return { claimed: true, fdeId: row.fde_id, state: 'failed', step: failedStep, error: message };
  }
}

/** Re-queue failed workflow steps, including an independent LLM failure on a terminal onboarding. */
export async function retryOnboarding(pool, fdeId) {
  return withTransaction(pool, async (client) => {
    const result = await client.query(
      `SELECT state, steps, last_error FROM fde_onboarding WHERE fde_id = $1 FOR UPDATE`,
      [fdeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const steps = parseSteps(row.steps);
    const hasFailedLlmBinding = steps['llm-binding']?.state === 'failed';
    if (row.state !== 'failed' && !(
      hasFailedLlmBinding && ['done', 'awaiting_credential'].includes(row.state)
    )) return onboardingStatus(row);

    const failedStep = STEPS.find((step) => steps[step]?.state === 'failed');
    if (failedStep) {
      steps[failedStep] = { ...steps[failedStep], state: 'pending' };
      delete steps[failedStep].error;
    }
    const updated = await client.query(
      `UPDATE fde_onboarding
          SET state = 'pending', steps = $2::jsonb, last_error = NULL, updated_at = now()
        WHERE fde_id = $1
        RETURNING state, steps, last_error`,
      [fdeId, JSON.stringify(steps)],
    );
    return onboardingStatus(updated.rows[0] ?? { state: 'pending', steps, last_error: null });
  });
}

/**
 * Re-queue work left running when the previous portal process exited.
 *
 * 单实例假设（决策者 2026-10-06：本平台限定单实例，内部使用，不做多实例/HA）：
 * 本函数会把**所有** running 行改回 pending，故不能与另一个共享同一 DB 的 portal 实例并存
 * （多实例下会把对方在跑的开户任务重排；实际执行仍有 pg_advisory_lock 串行化 + onboardFde 幂等兜底，
 * 不会损坏数据，但会重复执行）。若将来真要多实例：给 fde_onboarding 加 lease_until/worker_id
 * （照抄 materialize_outbox），启动恢复只回收租约过期的行。
 */
export async function recoverInterruptedOnboardings(pool) {
  const result = await pool.query(
    `UPDATE fde_onboarding
        SET state = 'pending', last_error = NULL, updated_at = now()
      WHERE state = 'running'
      RETURNING fde_id`,
  );
  return result.rows.length;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start the independent background loop that executes queued user onboarding. */
/**
 * 启动常驻后台循环，执行排队中的用户开户。
 *
 * issue #520：节拍由**认领结果**驱动（见上面 `LOOP_INTERVAL_MS` 的注释）。同时把句柄补成
 * 与 #506 的 `startRoutesLoop` 同形（`stop` / `done` / `settled` / `failure`）：改前只有
 * `stop()`，`stopLoopsAndWait` 对它只能记账跳过 ⇒ 优雅关闭既等不到它收尾、也等不到它从退避睡眠里
 * 醒来（最多白等一个节拍）。现在 `stop()` 会 abort 掉正在睡的那一拍，`done` 立刻落定。
 * 注入缝（`sleep` / 退避上限）照 #506：生产不传 ⇒ 真 `setTimeout` 与 env 默认值。
 */
export function startOnboardingLoop(pool, config, {
  docker,
  log = console,
  onPause,
  sleep = sleepCancellable,
  env = process.env, // 单测注入旋钮用；生产不传 ⇒ process.env
  idleBackoffMaxMs = envInt('ONBOARDING_IDLE_BACKOFF_MAX_MS', IDLE_BACKOFF_MAX_MS_DEFAULT, { max: MAX_BACKOFF_MS_SAFE, log, env }),
} = {}) {
  if (!docker) docker = createDockerClient({ dockerHost: config.dockerHost });
  let consecutiveFailures = 0;
  let recoveredInterruptedWork = false;
  let idleTicks = 0; // 连续空闲拍数（认领到活就清 0）
  const abort = new AbortController();
  const done = (async () => {
    while (!abort.signal.aborted) {
      try {
        if (!recoveredInterruptedWork) {
          const recovered = await recoverInterruptedOnboardings(pool);
          if (recovered > 0) log.warn?.(`[onboarding] recovered ${recovered} interrupted task(s)`);
          recoveredInterruptedWork = true;
        }
        const { claimed = false } = (await runOnboardingOnce(pool, config, { docker, log })) ?? {};
        consecutiveFailures = 0;
        idleTicks = claimed ? 0 : idleTicks + 1;
        if (!(await sleep(idleDelayMs(idleTicks, { baseMs: LOOP_INTERVAL_MS, maxMs: idleBackoffMaxMs }), abort.signal))) break;
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[onboarding] loop error: ${err.message}`);
        onPause?.('onboarding', err);
        const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
        // 异常分支不退避到 30s：那是**失败重试**节拍，与空闲退避两回事（#506 同口径：`BACKOFF_MS` 没动）。
        // 空闲计数保持：失败说明 DB 在抖，退避阶梯不该被清零。
        if (!(await sleep(backoff, abort.signal))) break;
      }
    }
  })();
  // #506 评审③同款：`done` 是裸 IIFE 的 Promise，没人 catch 就是未捕获拒绝（本仓「摘要全绿但 rc=1」陷阱）。
  const { settled, failure } = attachLoopWatch(done, (msg) => log.warn?.(`[onboarding] ${msg}`));
  return {
    stop() {
      abort.abort(); // 可中断：正在睡的那一拍必须立刻断开，否则关闭最多白等一个退避窗口
    },
    done, // 循环真正退出时 resolve（优雅关闭与单测 await 它；拒绝照原样冒）
    settled, // 已挂拒绝处理器的那份（`stopLoopsAndWait` 用它也不会制造未捕获拒绝）
    failure, // 循环异常退出时的错误（正常退出为 null）
  };
}
