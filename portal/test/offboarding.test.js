import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initialOffboardingSteps,
  retryOffboarding,
  runOffboardingOnce,
  sweepOffboardedWorkspaces,
} from '../src/offboarding.js';

const FDE_ID = 'b0000000-0000-4000-8000-000000000002';
const FDE_NAME = 'alice';

class OffboardingPool {
  constructor({
    state = 'pending',
    steps = initialOffboardingSteps(),
    purgeAfter = null,
    llmBinding = null,
  } = {}) {
    this.job = {
      fde_id: FDE_ID,
      fde_name: FDE_NAME,
      state,
      steps: structuredClone(steps),
      last_error: null,
      attempt: 0,
      workspace_purge_after: purgeAfter,
    };
    this.user = { id: FDE_ID, status: 'active' };
    this.sessions = [{ user_id: FDE_ID }];
    this.pending = [{ user_id: FDE_ID }];
    this.runs = [{ user_id: FDE_ID, status: 'running' }];
    this.containers = [{ user_id: FDE_ID, runner_token_hash: 'old-hash', status: 'running' }];
    this.llmBinding = llmBinding;
    this.queryLog = [];
    this.purgedUser = false;
    this.auditRows = [];
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queryLog.push({ sql: normalized, params });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized) || normalized.startsWith('SELECT pg_advisory')) {
      return { rows: [] };
    }
    if (normalized.includes('FROM fde_offboarding o') && normalized.includes("o.state = 'pending'")) {
      if (this.job?.state !== 'pending') return { rows: [] };
      return {
        rows: [{
          fde_id: this.job.fde_id,
          fde_name: this.job.fde_name,
          steps: structuredClone(this.job.steps),
          container_name: null,
          network_name: null,
        }],
      };
    }
    if (normalized.includes('UPDATE fde_offboarding') && normalized.includes("SET state = 'running'")) {
      this.job.state = 'running';
      this.job.attempt += 1;
      return { rows: [{ attempt: this.job.attempt }] };
    }
    if (normalized.includes("SET state = 'failed'") && normalized.includes('UPDATE fde_offboarding')) {
      const [, key, json, message] = params;
      this.job.state = 'failed';
      this.job.steps[key] = JSON.parse(json);
      this.job.last_error = message;
      return { rows: [] };
    }
    if (normalized.includes('jsonb_set(steps')) {
      const [, key, json] = params;
      this.job.steps[key] = JSON.parse(json);
      return { rows: [] };
    }
    if (normalized.includes("UPDATE fde_offboarding SET state = 'done'")) {
      this.job.state = 'done';
      this.job.last_error = null;
      return { rows: [] };
    }
    if (normalized.includes('workspace_purge_after = COALESCE')) {
      const [, retentionDays] = params;
      this.job.workspace_purge_after = new Date(Date.now() + retentionDays * 86_400_000);
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE users SET status')) {
      this.user.status = 'disabled';
      return { rows: [] };
    }
    if (normalized.startsWith('DELETE FROM login_sessions')) {
      this.sessions = [];
      return { rows: [] };
    }
    if (normalized.startsWith('DELETE FROM login_pending')) {
      this.pending = [];
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE runs r')) {
      this.runs.forEach((run) => { run.status = 'cancelling'; });
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE containers SET status')) {
      this.containers.forEach((container) => { container.status = 'removed'; });
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE containers') && normalized.includes('runner_token_hash = NULL')) {
      this.containers.forEach((container) => {
        container.runner_token_hash = null;
        container.token_generation = (container.token_generation ?? 1) + 1;
      });
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT api_key, key_alias, gateway FROM fde_llm_bindings')) {
      return { rows: this.llmBinding?.state === 'active' ? [this.llmBinding] : [] };
    }
    if (normalized.startsWith('UPDATE fde_llm_bindings')) {
      if (this.llmBinding) {
        this.llmBinding.state = 'revoked';
        this.llmBinding.api_key = null;
      }
      return { rowCount: this.llmBinding ? 1 : 0, rows: [] };
    }
    if (normalized.startsWith('INSERT INTO route_revisions')) {
      return { rows: [{ revision: 1 }] };
    }
    if (normalized.startsWith('UPDATE port_allocations')) return { rows: [] };
    if (normalized.startsWith('UPDATE fde_networks')) return { rows: [] };
    if (normalized.startsWith('SELECT state, steps, last_error, workspace_purge_after FROM fde_offboarding')) {
      return this.job ? {
        rows: [{
          state: this.job.state,
          steps: structuredClone(this.job.steps),
          last_error: this.job.last_error,
          workspace_purge_after: this.job.workspace_purge_after,
        }],
      } : { rows: [] };
    }
    if (normalized.includes("SET state = 'pending', steps = $2::jsonb")) {
      const [fdeId, steps] = params;
      if (!this.job || this.job.fde_id !== fdeId) return { rows: [] };
      this.job.state = 'pending';
      this.job.steps = JSON.parse(steps);
      this.job.last_error = null;
      return {
        rows: [{
          state: this.job.state,
          steps: structuredClone(this.job.steps),
          last_error: this.job.last_error,
          workspace_purge_after: this.job.workspace_purge_after,
        }],
      };
    }
    if (normalized.includes("WHERE state = 'done' AND workspace_purge_after IS NOT NULL")) {
      const [now, limit] = params;
      if (this.job?.state !== 'done' || !this.job.workspace_purge_after
        || new Date(this.job.workspace_purge_after) > new Date(now)) return { rows: [] };
      return {
        rows: [{
          fde_id: this.job.fde_id,
          fde_name: this.job.fde_name,
          workspace_purge_after: this.job.workspace_purge_after,
        }].slice(0, limit),
      };
    }
    if (normalized.startsWith('UPDATE fde_offboarding SET last_error')) {
      if (this.job) this.job.last_error = params[1];
      return { rows: [] };
    }
    if (normalized.startsWith('DELETE FROM users')) {
      this.purgedUser = true;
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO audit_log')) {
      this.auditRows.push(params);
      return { rows: [] };
    }
    if (normalized.startsWith('DELETE FROM fde_offboarding')) {
      this.job = null;
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function fakeDocker() {
  const calls = [];
  return {
    calls,
    async stopContainer(name) {
      calls.push(['stop', name]);
      return { status: 404 };
    },
    async removeContainer(name) {
      calls.push(['remove-container', name]);
      return { status: 404 };
    },
    async removeNetwork(name) {
      calls.push(['remove-network', name]);
      return { status: 500 };
    },
  };
}

test('offboarding runs every step idempotently when external resources are already absent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new OffboardingPool();
  const docker = fakeDocker();
  const warnings = [];
  const result = await runOffboardingOnce(pool, {
    userSpaceRoot: root, workspaceRetentionDays: 30, dockerHost: 'unused',
  }, {
    docker,
    lockFde: async (_pool, _name, work) => work(),
    log: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result, { claimed: true, fdeId: FDE_ID, state: 'done' });
  assert.equal(pool.user.status, 'disabled');
  assert.deepEqual(pool.sessions, []);
  assert.deepEqual(pool.pending, []);
  assert.equal(pool.runs[0].status, 'cancelling');
  assert.equal(pool.containers[0].runner_token_hash, null);
  assert.equal(pool.containers[0].status, 'removed');
  assert.deepEqual(Object.values(pool.job.steps).map((step) => step.state), Array(7).fill('done'));
  assert.ok(pool.job.workspace_purge_after instanceof Date);
  assert.deepEqual(docker.calls, [
    ['stop', 'fde-alice'], ['remove-container', 'fde-alice'], ['remove-network', 'fde-alice'],
  ]);
  assert.ok(warnings.length > 0, 'failed Docker network removal is non-fatal and logged');
  assert.ok(pool.queryLog.some(({ sql }) => sql.includes("SET state = 'done'")));
});

test('offboarding persists the failed step and retry resumes without repeating completed steps', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new OffboardingPool();
  const docker = fakeDocker();
  let credentialAttempts = 0;
  const options = {
    docker,
    lockFde: async (_pool, _name, work) => work(),
    removeCredential() {
      credentialAttempts += 1;
      if (credentialAttempts === 1) throw new Error('credential filesystem unavailable');
    },
    log: { warn() {} },
  };
  const config = { userSpaceRoot: root, workspaceRetentionDays: 30, dockerHost: 'unused' };

  const failed = await runOffboardingOnce(pool, config, options);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'delete-git-credential');
  assert.equal(pool.job.state, 'failed');
  assert.equal(pool.job.steps['delete-git-credential'].state, 'failed');
  assert.match(pool.job.last_error, /credential filesystem unavailable/);

  const retried = await retryOffboarding(pool, FDE_ID);
  assert.equal(retried.state, 'pending');
  assert.equal(pool.job.steps['delete-git-credential'].state, 'pending');
  const completed = await runOffboardingOnce(pool, config, options);
  assert.equal(completed.state, 'done');
  assert.equal(pool.job.attempt, 2);
  assert.equal(credentialAttempts, 2);
  assert.equal(docker.calls.filter(([action]) => action === 'stop').length, 1);
});

test('offboarding revokes an active LiteLLM key and retries a gateway failure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-llm-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new OffboardingPool({
    llmBinding: {
      gateway: 'litellm',
      api_key: 'virtual-key',
      key_alias: 'fde-alice',
      state: 'active',
    },
  });
  const keyDeletes = [];
  const config = {
    userSpaceRoot: root,
    workspaceRetentionDays: 30,
    dockerHost: 'unused',
    async deleteKey({ keys }) {
      keyDeletes.push(keys);
      if (keyDeletes.length === 1) throw new Error('LiteLLM unavailable');
    },
  };
  const options = {
    docker: fakeDocker(),
    lockFde: async (_pool, _name, work) => work(),
    log: { warn() {} },
  };

  const failed = await runOffboardingOnce(pool, config, options);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'revoke-llm-key');
  assert.equal(pool.llmBinding.state, 'active');
  assert.deepEqual(keyDeletes, [['virtual-key']]);

  await retryOffboarding(pool, FDE_ID);
  const completed = await runOffboardingOnce(pool, config, options);
  assert.equal(completed.state, 'done');
  assert.equal(pool.llmBinding.state, 'revoked');
  assert.equal(pool.llmBinding.api_key, null);
  assert.deepEqual(keyDeletes, [['virtual-key'], ['virtual-key']]);
  assert.equal(pool.job.steps['stop-container'].state, 'done');
});

test('workspace sweep leaves future jobs untouched, purges expired jobs, and honors retention 0', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-workspace-purge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, FDE_NAME);
  fs.mkdirSync(workspace);
  const now = new Date('2026-10-07T00:00:00Z');
  const futurePool = new OffboardingPool({
    state: 'done', purgeAfter: new Date(now.getTime() + 60_000),
  });
  let result = await sweepOffboardedWorkspaces(futurePool, {
    userSpaceRoot: root, workspaceRetentionDays: 30,
  }, { now, lockFde: async (_pool, _name, work) => work() });
  assert.deepEqual(result, { disabled: false, purged: 0, failed: 0 });
  assert.equal(fs.existsSync(workspace), true);
  assert.equal(futurePool.purgedUser, false);

  const expiredPool = new OffboardingPool({ state: 'done', purgeAfter: new Date(now.getTime() - 1) });
  result = await sweepOffboardedWorkspaces(expiredPool, {
    userSpaceRoot: root, workspaceRetentionDays: 30,
  }, { now, lockFde: async (_pool, _name, work) => work() });
  assert.deepEqual(result, { disabled: false, purged: 1, failed: 0 });
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(expiredPool.purgedUser, true);
  assert.equal(expiredPool.job, null);
  assert.equal(expiredPool.auditRows.length, 1);

  fs.mkdirSync(workspace);
  const disabledPool = new OffboardingPool({ state: 'done', purgeAfter: new Date(now.getTime() - 1) });
  result = await sweepOffboardedWorkspaces(disabledPool, {
    userSpaceRoot: root, workspaceRetentionDays: 0,
  }, { now, lockFde: async (_pool, _name, work) => work() });
  assert.deepEqual(result, { disabled: true, purged: 0, failed: 0 });
  assert.equal(fs.existsSync(workspace), true);
  assert.equal(disabledPool.purgedUser, false);
});

test('workspace sweep rejects a symlink escape and retains the DB job for retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-workspace-symlink-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'station-workspace-outside-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  const sentinel = path.join(outside, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  fs.symlinkSync(outside, path.join(root, FDE_NAME), 'dir');
  const pool = new OffboardingPool({ state: 'done', purgeAfter: new Date('2026-10-06T00:00:00Z') });
  const warnings = [];
  const result = await sweepOffboardedWorkspaces(pool, {
    userSpaceRoot: root, workspaceRetentionDays: 30,
  }, {
    now: new Date('2026-10-07T00:00:00Z'),
    lockFde: async (_pool, _name, work) => work(),
    log: { warn: (message) => warnings.push(message) },
  });

  assert.deepEqual(result, { disabled: false, purged: 0, failed: 1 });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  assert.equal(pool.purgedUser, false);
  assert.ok(pool.job.last_error);
  assert.equal(warnings.length, 1);
});
