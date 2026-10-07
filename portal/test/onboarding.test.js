import test from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueOnboarding,
  recoverInterruptedOnboardings,
  retryOnboarding,
  runOnboardingOnce,
} from '../src/onboarding.js';

const FDE_ID = 'b0000000-0000-4000-8000-000000000002';
const GIT_HOST_ID = 'c0000000-0000-4000-8000-000000000011';
const LLM_SELECTION = {
  provider_id: 'mock-provider',
  main_model_id: 'mock-main',
  embedding_model_id: null,
  vision_model_id: null,
};

class OnboardingPool {
  constructor({ state = 'pending', steps, userStatus = 'active', offboardingState = null } = {}) {
    this.onboarding = {
      fde_id: FDE_ID,
      state,
      steps: steps ?? {
        provision: { state: 'pending' },
        materialize: { state: 'pending' },
        'llm-binding': { state: 'pending', models: structuredClone(LLM_SELECTION) },
      },
      last_error: null,
      attempt: 0,
    };
    this.user = { id: FDE_ID, fde_name: 'alice', status: userStatus };
    this.offboardingState = offboardingState;
    this.gitAccount = { fde_id: FDE_ID, git_host_id: GIT_HOST_ID };
    this.outbox = [];
    this.revision = 0;
    this.stepWrites = [];
    this.queries = [];
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };

    if (sql.includes('INSERT INTO fde_onboarding')) {
      this.onboarding.steps = JSON.parse(params[1]);
      this.onboarding.state = 'pending';
      this.onboarding.last_error = null;
      this.onboarding.attempt = 0;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO fde_git_accounts')) {
      if (this.gitAccount.git_host_id !== params[1]) {
        this.gitAccount.remote_login = null;
        this.gitAccount.token_ref = null;
      }
      this.gitAccount.git_host_id = params[1];
      return { rows: [] };
    }
    if (sql.includes('SELECT o.fde_id, o.steps, u.fde_name, a.git_host_id')) {
      return this.onboarding.state === 'pending'
        && !['pending', 'running'].includes(this.offboardingState)
        ? { rows: [{
          fde_id: FDE_ID,
          steps: structuredClone(this.onboarding.steps),
          fde_name: this.user.fde_name,
          git_host_id: this.gitAccount.git_host_id,
        }] }
        : { rows: [] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes("SET state = 'running'")) {
      this.onboarding.state = 'running';
      this.onboarding.attempt += 1;
      return { rows: [{ attempt: this.onboarding.attempt }] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes("SET state = 'pending', last_error = NULL")) {
      if (this.onboarding.state !== 'running') return { rows: [] };
      this.onboarding.state = 'pending';
      this.onboarding.last_error = null;
      return { rows: [{ fde_id: FDE_ID }] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes("SET state = 'failed'")) {
      const [, stepName, value, message] = params;
      this.onboarding.state = 'failed';
      this.onboarding.steps[stepName] = JSON.parse(value);
      this.onboarding.last_error = message;
      return { rows: [] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes('SET steps = jsonb_set')) {
      const [, stepName, value] = params;
      const step = JSON.parse(value);
      this.onboarding.steps[stepName] = step;
      this.stepWrites.push([stepName, step.state]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO materialize_revisions')) {
      this.revision += 1;
      return { rows: [{ revision: this.revision }] };
    }
    if (sql.includes('INSERT INTO materialize_outbox')) {
      const [fdeId, op, revision, payload] = params;
      this.outbox.push({ fde_id: fdeId, op, revision, payload: JSON.parse(payload), state: 'pending' });
      return { rows: [] };
    }
    if (sql.includes('SELECT state, last_error FROM materialize_outbox')) {
      const row = this.outbox.find((entry) => entry.fde_id === params[0] && entry.revision === params[1]);
      return { rows: row ? [{ state: row.state, last_error: row.last_error ?? null }] : [] };
    }
    if (sql.includes('SELECT status FROM users WHERE id')) {
      return { rows: [{ status: this.user.status }] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes('SET state = $2')) {
      this.onboarding.state = params[1];
      this.onboarding.last_error = null;
      return { rows: [] };
    }
    if (sql.includes('SELECT state, steps, last_error FROM fde_onboarding')) {
      return { rows: [{
        state: this.onboarding.state,
        steps: structuredClone(this.onboarding.steps),
        last_error: this.onboarding.last_error,
      }] };
    }
    if (sql.includes('UPDATE fde_onboarding') && sql.includes("SET state = 'pending'")) {
      this.onboarding.state = 'pending';
      this.onboarding.steps = JSON.parse(params[1]);
      this.onboarding.last_error = null;
      return { rows: [{
        state: this.onboarding.state,
        steps: structuredClone(this.onboarding.steps),
        last_error: null,
      }] };
    }
    throw new Error(`Unexpected onboarding test query: ${sql}`);
  }
}

function workflow(pool, { provision, materialize, bindLlm, log = { warn() {} } } = {}) {
  return runOnboardingOnce(pool, {}, {
    docker: {},
    log,
    provision: provision ?? (async () => {}),
    bindLlm: bindLlm ?? (async () => {}),
    materialize: materialize ?? (async (targetPool) => {
      targetPool.outbox.at(-1).state = 'published';
    }),
  });
}

test('enqueueOnboarding 幂等写入待办步骤并更新 Git host 映射', async () => {
  const pool = new OnboardingPool({ state: 'failed' });
  pool.onboarding.attempt = 3;
  pool.gitAccount.remote_login = 'old-login';
  pool.gitAccount.token_ref = 'old-token-ref';
  await enqueueOnboarding(pool, { fdeId: FDE_ID, gitHostId: GIT_HOST_ID, llm: LLM_SELECTION });
  assert.equal(pool.gitAccount.remote_login, 'old-login');
  assert.equal(pool.gitAccount.token_ref, 'old-token-ref');
  await enqueueOnboarding(pool, {
    fdeId: FDE_ID, gitHostId: 'c0000000-0000-4000-8000-000000000012', llm: LLM_SELECTION,
  });

  assert.equal(pool.onboarding.state, 'pending');
  assert.deepEqual(pool.onboarding.steps, {
    provision: { state: 'pending' },
    materialize: { state: 'pending' },
    'llm-binding': { state: 'pending', models: LLM_SELECTION },
  });
  assert.equal(pool.onboarding.attempt, 0);
  assert.equal(pool.gitAccount.git_host_id, 'c0000000-0000-4000-8000-000000000012');
  assert.equal(pool.gitAccount.remote_login, null);
  assert.equal(pool.gitAccount.token_ref, null);
  assert.equal(pool.queries.filter(({ sql }) => sql.includes('INSERT INTO fde_onboarding')).length, 2);
});

test('runOnboardingOnce 按序执行并在每步后持久化，materialize 写入 outbox', async () => {
  const pool = new OnboardingPool();
  const calls = [];
  const result = await workflow(pool, {
    provision: async (_pool, _config, options) => {
      calls.push(['provision', options.fdeName, options.gitHostId]);
    },
    materialize: async (targetPool) => {
      calls.push(['materialize']);
      targetPool.outbox.at(-1).state = 'published';
    },
  });

  assert.deepEqual(calls, [
    ['provision', 'alice', GIT_HOST_ID],
    ['materialize'],
  ]);
  assert.deepEqual(pool.stepWrites, [
    ['provision', 'running'], ['provision', 'done'],
    ['materialize', 'running'], ['materialize', 'done'],
    ['llm-binding', 'running'], ['llm-binding', 'done'],
  ]);
  assert.deepEqual(pool.outbox.map(({ op, state }) => ({ op, state })), [{ op: 'upsert', state: 'published' }]);
  assert.deepEqual(result, { claimed: true, fdeId: FDE_ID, state: 'done' });
  assert.equal(pool.onboarding.attempt, 1);
});

test('provision 成功后消费并清除一次性的旧 Git token 引用', async () => {
  const pool = new OnboardingPool({
    steps: {
      provision: { state: 'pending', previousTokenRef: 'old-token-id' },
      materialize: { state: 'pending' },
      'llm-binding': { state: 'pending', models: structuredClone(LLM_SELECTION) },
    },
  });
  let previousTokenRef;
  const result = await workflow(pool, {
    provision: async (_pool, _config, options) => { previousTokenRef = options.previousTokenRef; },
  });

  assert.equal(result.state, 'done');
  assert.equal(previousTokenRef, 'old-token-id');
  assert.equal(Object.hasOwn(pool.onboarding.steps.provision, 'previousTokenRef'), false);
});

test('重激活后保留的 done offboarding 历史不阻止 onboarding；活动中的 offboarding 仍阻止认领', async () => {
  const completedHistory = new OnboardingPool({ offboardingState: 'done' });
  const result = await workflow(completedHistory);
  assert.equal(result.claimed, true);
  assert.equal(result.state, 'done');

  for (const offboardingState of ['pending', 'running']) {
    const activeTask = new OnboardingPool({ offboardingState });
    assert.deepEqual(await workflow(activeTask), { claimed: false });
  }
});

test('provision 失败记录步骤与错误且不继续执行 materialize', async () => {
  const pool = new OnboardingPool();
  const result = await workflow(pool, {
    provision: async () => { throw new Error('Docker image pull failed'); },
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.step, 'provision');
  assert.equal(pool.onboarding.state, 'failed');
  assert.deepEqual(pool.onboarding.steps.provision, {
    state: 'failed', error: 'Docker image pull failed',
  });
  assert.equal(pool.onboarding.last_error, 'Docker image pull failed');
  assert.equal(pool.outbox.length, 0);
});

test('续跑会跳过已完成步骤，只执行失败步骤之后的工作', async () => {
  const pool = new OnboardingPool({
    steps: {
      provision: { state: 'done' },
      materialize: { state: 'pending' },
    },
  });
  let provisionCalls = 0;
  let materializeCalls = 0;
  const result = await workflow(pool, {
    provision: async () => { provisionCalls += 1; },
    materialize: async (targetPool) => {
      materializeCalls += 1;
      targetPool.outbox.at(-1).state = 'published';
    },
  });

  assert.equal(provisionCalls, 0);
  assert.equal(materializeCalls, 1);
  assert.deepEqual(pool.stepWrites, [
    ['materialize', 'running'], ['materialize', 'done'],
    ['llm-binding', 'running'], ['llm-binding', 'done'],
  ]);
  assert.deepEqual(pool.onboarding.steps['llm-binding'], { state: 'done', skipped: true });
  assert.equal(result.state, 'done');
});

test('materialize 有待处理批次时继续消费，直到开户对应 revision 已发布', async () => {
  const pool = new OnboardingPool();
  let rounds = 0;
  const result = await workflow(pool, {
    materialize: async (targetPool) => {
      rounds += 1;
      if (rounds === 2) targetPool.outbox.at(-1).state = 'published';
    },
  });

  assert.equal(rounds, 2);
  assert.equal(result.state, 'done');
});

test('所有步骤完成后，awaiting_credential 用户进入对应终态', async () => {
  const pool = new OnboardingPool();
  const result = await workflow(pool, {
    provision: async () => { pool.user.status = 'awaiting_credential'; },
    materialize: async (targetPool) => { targetPool.outbox.at(-1).state = 'published'; },
  });

  assert.equal(result.state, 'awaiting_credential');
  assert.equal(pool.onboarding.state, 'awaiting_credential');
  assert.equal(pool.onboarding.steps['llm-binding'].state, 'done');
});

test('LLM binding 失败只标记独立步骤，不阻断开户；可单独重试且保留表单模型', async () => {
  const pool = new OnboardingPool({
    userStatus: 'awaiting_credential',
    steps: {
      provision: { state: 'done' },
      materialize: { state: 'done' },
      'llm-binding': { state: 'pending', models: structuredClone(LLM_SELECTION) },
    },
  });
  const warnings = [];
  const failed = await workflow(pool, {
    bindLlm: async () => { throw new Error('gateway error included sk-never-log-this'); },
    log: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(failed, { claimed: true, fdeId: FDE_ID, state: 'awaiting_credential' });
  assert.equal(pool.onboarding.state, 'awaiting_credential');
  assert.deepEqual(pool.onboarding.steps['llm-binding'], {
    state: 'failed',
    models: LLM_SELECTION,
    error: 'LLM binding setup failed; check LiteLLM and database availability before retrying',
  });
  assert.ok(!warnings.join('\n').includes('sk-never-log-this'));

  const retry = await retryOnboarding(pool, FDE_ID);
  assert.equal(retry.state, 'pending');
  assert.equal(retry.step, 'llm-binding');
  assert.deepEqual(pool.onboarding.steps['llm-binding'], {
    state: 'pending',
    models: LLM_SELECTION,
  });

  let bindCalls = 0;
  const completed = await workflow(pool, {
    bindLlm: async (_targetPool, options) => {
      bindCalls += 1;
      assert.deepEqual({
        provider_id: options.provider_id,
        main_model_id: options.main_model_id,
        embedding_model_id: options.embedding_model_id,
        vision_model_id: options.vision_model_id,
        allowAwaitingCredential: options.allowAwaitingCredential,
        onlyIfMissing: options.onlyIfMissing,
      }, {
        ...LLM_SELECTION,
        allowAwaitingCredential: true,
        onlyIfMissing: true,
      });
    },
  });
  assert.equal(completed.state, 'awaiting_credential');
  assert.equal(bindCalls, 1);
  assert.equal(pool.onboarding.steps['llm-binding'].state, 'done');
});

test('retryOnboarding 只把 failed 任务重新排队并跳过已完成步骤', async () => {
  const pool = new OnboardingPool({
    state: 'failed',
    steps: {
      provision: { state: 'done' },
      materialize: { state: 'failed', error: 'write failed' },
    },
  });
  pool.onboarding.last_error = 'write failed';
  const result = await retryOnboarding(pool, FDE_ID);

  assert.deepEqual(result, { state: 'pending', step: 'materialize', error: null });
  assert.equal(pool.onboarding.steps.provision.state, 'done');
  assert.equal(pool.onboarding.steps.materialize.state, 'pending');
  assert.equal(pool.onboarding.last_error, null);
});

test('portal 重启只恢复中断的 running 任务，不自动重试 failed', async () => {
  const interrupted = new OnboardingPool({ state: 'running' });
  const failed = new OnboardingPool({ state: 'failed' });

  assert.equal(await recoverInterruptedOnboardings(interrupted), 1);
  assert.equal(interrupted.onboarding.state, 'pending');
  assert.equal(await recoverInterruptedOnboardings(failed), 0);
  assert.equal(failed.onboarding.state, 'failed');
});
