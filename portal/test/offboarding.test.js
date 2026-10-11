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
// #252 的回归保护：preview_grants 的 baseline CHECK（含双向的 `used ⇔ used_at`）在 fake 里的等价模拟
// （与 portal/test/preview-ports.test.js 共用一份规则；旧 fake 只模拟 revoked ⇔ revoked_at，
// 于是「把 used ticket 一并抓 revoked」在单测里结构上不可能红）。
import { applyRevokeGrantsSql, seedPreviewGrant } from './preview-grant-checks.js';

const FDE_ID = 'b0000000-0000-4000-8000-000000000002';
const FDE_NAME = 'alice';

class OffboardingPool {
  constructor({
    state = 'pending',
    steps = initialOffboardingSteps(),
    purgeAfter = null,
    llmBinding = null,
    gitAccount = null,
    allocations = [],
    grants = [],
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
    this.user = { id: FDE_ID, status: state === 'done' ? 'disabled' : 'active' };
    this.sessions = [{ user_id: FDE_ID }];
    this.pending = [{ user_id: FDE_ID }];
    this.runs = [{ user_id: FDE_ID, status: 'running' }];
    this.containers = [{ user_id: FDE_ID, runner_token_hash: 'old-hash', status: 'running' }];
    this.llmBinding = llmBinding;
    this.gitAccount = gitAccount;
    this.queryLog = [];
    this.auditRows = [];
    // #252 的靶面：本 FDE 的端口与预览凭证。**默认两张空表** ⇒ 不传这两个参数的既有用例行为一字不变。
    // 种子自己先过 port_allocations 的双向 CHECK（released ⇔ released_at）：「released 但 released_at 为空」
    // 这种种子测的是真库不存在的状态。
    this.allocations = allocations.map((row, index) => {
      const seed = { fde_id: FDE_ID, state: 'allocated', released_at: null, id: `pa-${index + 1}`, ...row };
      assert.equal((seed.state === 'released') === (seed.released_at != null), true,
        `offboarding fake 种子的 port_allocations 行违反 CHECK ((state='released') = (released_at IS NOT NULL))：${JSON.stringify(seed)}`);
      return seed;
    });
    this.grants = grants.map((grant, index) => seedPreviewGrant(
      { id: `pg-${index + 1}`, ...grant },
      { subject: FDE_ID, issuer: FDE_ID },
    ));
    this.snapshot = null;
    this.routeRev = 0;
    this.matRev = 0;
    this.outbox = { route: [], materialize: [] };   // 派生链留档（断言「空转不重复入队」）
  }

  cloneTables() {
    return {
      allocations: JSON.parse(JSON.stringify(this.allocations)),
      grants: JSON.parse(JSON.stringify(this.grants)),
    };
  }

  /** 拿某张 preview_grants 行（测试断言用）。 */
  grant(id) {
    const found = this.grants.find((grant) => grant.id === id);
    if (!found) assert.fail(`offboarding fake：没有 preview_grants 行 ${id}`);
    return found;
  }

  /** 某条 SQL 在整次运行里出现了几次（幂等/无条件发的断言用）。 */
  countQuery(matcher) {
    return this.queryLog.filter(({ sql }) => (typeof matcher === 'string' ? sql.includes(matcher) : matcher.test(sql))).length;
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  async query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.queryLog.push({ sql: normalized, params });
    if (/^DELETE FROM (?:users|fde_git_accounts|fde_offboarding)\b/.test(normalized)) {
      assert.fail(`offboarding must retain database records: ${normalized}`);
    }
    // 真事务快照（#252：“撤权挂在「本次释放了行」上”与“整笔回滚”都要能真的演出来）。
    if (normalized === 'BEGIN') {
      this.snapshot = this.cloneTables();
      return { rows: [] };
    }
    if (normalized === 'COMMIT') {
      this.snapshot = null;
      return { rows: [] };
    }
    if (normalized === 'ROLLBACK') {
      if (this.snapshot) Object.assign(this, this.snapshot);
      this.snapshot = null;
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT pg_advisory')) {
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
    if (normalized.includes('FROM fde_git_accounts a')) {
      return { rows: this.gitAccount ? [this.gitAccount] : [] };
    }
    if (normalized.startsWith('UPDATE fde_llm_bindings')) {
      if (this.llmBinding) {
        this.llmBinding.state = 'revoked';
        this.llmBinding.api_key = null;
      }
      return { rowCount: this.llmBinding ? 1 : 0, rows: [] };
    }
    // 两条派生链（本次真释放了行才会入队）：返真 revision，并留档供测试断言「重试空转不重复入队」。
    // （`bumpMaterializeRevision` 读 `rows[0].revision`，这里回空行会把 offboarding 当场炸掉。）
    if (normalized.startsWith('INSERT INTO route_revisions')) {
      this.routeRev = (this.routeRev ?? 0) + 1;
      this.outbox.route.push({ aggregate: params[0], aggregateId: params[1], revision: this.routeRev });
      return { rows: [{ revision: this.routeRev }] };
    }
    if (normalized.startsWith('INSERT INTO route_outbox')) {
      const last = this.outbox.route.at(-1);
      if (last) { last.op = params[2]; last.payload = JSON.parse(params[4]); }
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO materialize_revisions')) {
      this.matRev = (this.matRev ?? 0) + 1;
      this.outbox.materialize.push({ fdeId: params[0], revision: this.matRev });
      return { rows: [{ revision: this.matRev }] };
    }
    if (normalized.startsWith('INSERT INTO materialize_outbox')) {
      const last = this.outbox.materialize.at(-1);
      if (last) { last.op = params[1]; last.payload = JSON.parse(params[3]); }
      return { rows: [] };
    }
    if (normalized.startsWith('UPDATE port_allocations') && normalized.includes("SET state = 'released'")) {
      // 真发 RETURNING id（幂等与“本次释放了几条”的判据都靠它）。
      const rows = this.allocations
        .filter((allocation) => allocation.fde_id === params[0] && allocation.state !== 'released')
        .map((allocation) => {
          allocation.state = 'released';
          allocation.released_at = allocation.released_at ?? new Date().toISOString();
          return { id: allocation.id };
        });
      return { rows, rowCount: rows.length };
    }
    if (normalized.startsWith('SELECT id FROM port_allocations WHERE fde_id')) {
      // 撤权的 id 集合 = 本 FDE 的**全部** allocation（含早已 released 的）——#252 重试路径的机关。
      return { rows: this.allocations.filter((allocation) => allocation.fde_id === params[0]).map((allocation) => ({ id: allocation.id })) };
    }
    if (normalized.startsWith('UPDATE preview_grants')) {
      // 谓词由 SQL 决定（fake 不另写一套）；命中的每一行都要过 baseline CHECK，任何一条违反
      // ⇒ **整条语句**抛 23514、零行改动（PG 的语句级原子性）。
      return applyRevokeGrantsSql({ sql: normalized, grants: this.grants, allocationIds: params[0] });
    }
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
    if (normalized.startsWith('INSERT INTO audit_log')) {
      this.auditRows.push(params);
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
  assert.deepEqual(Object.keys(initialOffboardingSteps()), [
    'disable-user',
    'stop-container',
    'revoke-runner-token',
    'revoke-llm-key',
    'delete-git-credential',
    'revoke-git-account-access',
    'release-network-routes',
    'schedule-workspace-purge',
  ]);
  assert.deepEqual(Object.values(pool.job.steps).map((step) => step.state), Array(8).fill('done'));
  assert.equal(pool.job.steps['revoke-git-account-access'].note, 'No linked Git account');
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

test('offboarding disables minted Gitea accounts but leaves user-managed accounts and GitLab untouched', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = {
    remote_login: 'alice',
    provider: 'gitea',
    mode: 'minted',
    base_url: 'https://gitea.example',
    admin_key: 'gitea-admin-key',
  };
  const giteaPool = new OffboardingPool({ gitAccount: account });
  const calls = [];
  const options = {
    docker: fakeDocker(),
    lockFde: async (_pool, _name, work) => work(),
    disableGitAccount: async (input) => {
      calls.push(input);
      return { disabled: true, reason: 'prohibited' };
    },
    log: { warn() {} },
  };
  const config = { userSpaceRoot: root, workspaceRetentionDays: 0, dockerHost: 'unused' };
  await runOffboardingOnce(giteaPool, config, options);
  assert.deepEqual(calls, [{
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
  }]);
  assert.match(giteaPool.job.steps['revoke-git-account-access'].note, /prohibit_login/);

  const missingHostPool = new OffboardingPool({
    gitAccount: { remote_login: 'alice', provider: null, mode: null },
  });
  calls.length = 0;
  await runOffboardingOnce(missingHostPool, config, options);
  assert.deepEqual(calls, []);
  assert.equal(missingHostPool.job.steps['revoke-git-account-access'].state, 'done');
  assert.match(missingHostPool.job.steps['revoke-git-account-access'].note, /host is absent/);

  for (const mode of ['per_fde_pat', 'self_token']) {
    const personalPool = new OffboardingPool({
      gitAccount: { ...account, mode },
    });
    calls.length = 0;
    await runOffboardingOnce(personalPool, config, options);
    assert.deepEqual(calls, [], `${mode} must not disable the employee-owned account`);
    assert.match(personalPool.job.steps['revoke-git-account-access'].note, /user-managed/);
  }

  const gitlabPool = new OffboardingPool({
    gitAccount: { ...account, provider: 'gitlab' },
  });
  calls.length = 0;
  await runOffboardingOnce(gitlabPool, config, options);
  assert.deepEqual(calls, [], 'GitLab upstream revocation is deferred');
  assert.match(gitlabPool.job.steps['revoke-git-account-access'].note, /GitLab.*deferred/);
});

test('offboarding retries a failed upstream Gitea access revocation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-git-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new OffboardingPool({
    gitAccount: {
      remote_login: 'alice',
      provider: 'gitea',
      mode: 'minted',
      base_url: 'https://gitea.example',
      admin_key: 'gitea-admin-key',
    },
  });
  let attempts = 0;
  const options = {
    docker: fakeDocker(),
    lockFde: async (_pool, _name, work) => work(),
    disableGitAccount: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Gitea unavailable');
      return { disabled: true, reason: 'prohibited' };
    },
    log: { warn() {} },
  };
  const config = { userSpaceRoot: root, workspaceRetentionDays: 0, dockerHost: 'unused' };

  const failed = await runOffboardingOnce(pool, config, options);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.step, 'revoke-git-account-access');
  assert.equal(pool.job.steps['revoke-git-account-access'].state, 'failed');

  await retryOffboarding(pool, FDE_ID);
  const completed = await runOffboardingOnce(pool, config, options);
  assert.equal(completed.state, 'done');
  assert.equal(attempts, 2);
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
  assert.equal(futurePool.user.status, 'disabled');
  assert.equal(futurePool.job.state, 'done');

  const expiredPool = new OffboardingPool({
    state: 'done',
    purgeAfter: new Date(now.getTime() - 1),
    gitAccount: {
      remote_login: 'alice',
      provider: 'gitea',
      mode: 'minted',
      base_url: 'https://gitea.example',
      admin_key: 'gitea-admin-key',
    },
  });
  result = await sweepOffboardedWorkspaces(expiredPool, {
    userSpaceRoot: root, workspaceRetentionDays: 30,
  }, { now, lockFde: async (_pool, _name, work) => work() });
  assert.deepEqual(result, { disabled: false, purged: 1, failed: 0 });
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(expiredPool.user.status, 'disabled');
  assert.equal(expiredPool.gitAccount.remote_login, 'alice');
  assert.equal(expiredPool.job.state, 'done');
  assert.equal(expiredPool.job.workspace_purge_after.getTime(), now.getTime() - 1);
  assert.deepEqual(expiredPool.auditRows, []);
  assert.equal(expiredPool.queryLog.some(({ sql }) => /DELETE FROM (?:users|fde_git_accounts|fde_offboarding)/.test(sql)), false);

  fs.mkdirSync(workspace);
  const disabledPool = new OffboardingPool({ state: 'done', purgeAfter: new Date(now.getTime() - 1) });
  result = await sweepOffboardedWorkspaces(disabledPool, {
    userSpaceRoot: root, workspaceRetentionDays: 0,
  }, { now, lockFde: async (_pool, _name, work) => work() });
  assert.deepEqual(result, { disabled: true, purged: 0, failed: 0 });
  assert.equal(fs.existsSync(workspace), true);
  assert.equal(disabledPool.user.status, 'disabled');
  assert.equal(disabledPool.job.state, 'done');
  assert.equal(disabledPool.queryLog.some(({ sql }) => sql.includes('SELECT fde_id, fde_name, workspace_purge_after')), false);
});

test('retention 0 leaves workspace_purge_after NULL and both startup/hourly sweeps idle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-workspace-retention-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pool = new OffboardingPool();
  const result = await runOffboardingOnce(pool, {
    userSpaceRoot: root, workspaceRetentionDays: 0, dockerHost: 'unused',
  }, {
    docker: fakeDocker(),
    lockFde: async (_pool, _name, work) => work(),
    log: { warn() {} },
  });
  assert.equal(result.state, 'done');
  assert.equal(pool.job.workspace_purge_after, null);
  assert.equal(pool.queryLog.some(({ sql }) => sql.includes('workspace_purge_after = COALESCE')), false);

  pool.job.state = 'done';
  const sweep = await sweepOffboardedWorkspaces(pool, { userSpaceRoot: root }, {
    lockFde: async (_pool, _name, work) => work(),
  });
  assert.deepEqual(sweep, { disabled: true, purged: 0, failed: 0 });
  assert.equal(pool.queryLog.some(({ sql }) => sql.includes('SELECT fde_id, fde_name, workspace_purge_after')), false);
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
  assert.equal(pool.user.status, 'disabled');
  assert.ok(pool.job.last_error);
  assert.equal(warnings.length, 1);
});

// ---------------------------------------------------------------------------
// #252（工单 fix-261011-B）：撤预览 grant 只撤 `active`，且**不许挂在「本次释放了行」上**。
// 真机形状：PR #251 验收时 `state IN ('active','used')` 撞 `preview_grants_check3` ⇒ 整笔事务回滚，
// 但步骤被记 `done`、`last_error` 为空；此后重试时本 FDE 已无活行 ⇒ 撤权整段被守卫跳过，
// 已释放 allocation 上永远留着 `session|active` / `ticket|used` 残渣（实测 21 条）。
// ---------------------------------------------------------------------------

/** 只留 `release-network-routes` 待跑（= 上一次尝试失败后的重试形状）。 */
function stepsPendingOnlyRelease() {
  const steps = initialOffboardingSteps();
  for (const [name, value] of Object.entries(steps)) {
    if (name !== 'release-network-routes') steps[name] = { ...value, state: 'done' };
  }
  return steps;
}

function offboardingOptions(t, infos = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-offboarding-grants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    config: { userSpaceRoot: root, workspaceRetentionDays: 0, dockerHost: 'unused' },
    options: {
      docker: fakeDocker(),
      lockFde: async (_pool, _name, work) => work(),
      log: { warn() {}, info: (message) => infos.push(message) },
    },
  };
}

test('#252① offboarding 只撤 active：used ticket 原样保留（used_at 不动）、同批 active session 被撤、步骤全 done', async (t) => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const pool = new OffboardingPool({
    allocations: [
      { fde_id: FDE_ID, state: 'allocated' },
      { fde_id: FDE_ID, state: 'allocated' },
    ],
    grants: [
      { id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt },            // ticket|used（真机 45 条那一类）
      { id: 'pg-2', allocation_id: 'pa-1', kind: 'session', state: 'active', parent_ticket_id: 'pg-1' },
      { id: 'pg-3', allocation_id: 'pa-2', state: 'active' },
      { id: 'pg-4', allocation_id: 'pa-2', state: 'expired' },                          // 已过期 ⇒ 不打扰
      { id: 'pg-5', allocation_id: 'pa-2', state: 'revoked', revoked_at: new Date('2026-10-01T00:00:00Z').toISOString() },
    ],
  });
  const infos = [];
  const { config, options } = offboardingOptions(t, infos);

  const result = await runOffboardingOnce(pool, config, options);

  assert.equal(result.state, 'done', '撞 CHECK 的 500 修掉后本步必须正常收尾');
  assert.equal(pool.job.steps['release-network-routes'].state, 'done');
  assert.equal(pool.job.last_error, null);
  assert.deepEqual(pool.allocations.map((a) => a.state), ['released', 'released']);
  assert.ok(pool.allocations.every((a) => a.released_at), 'released ⇔ released_at（baseline CHECK）');
  for (const id of ['pg-2', 'pg-3']) {
    assert.equal(pool.grant(id).state, 'revoked', `${id}（active）必须被撤`);
    assert.ok(pool.grant(id).revoked_at, 'revoked ⇔ revoked_at（baseline CHECK）');
  }
  assert.equal(pool.grant('pg-1').state, 'used', '#252：used 是历史事实，不撤（撤了必撞 preview_grants_check3）');
  assert.equal(pool.grant('pg-1').used_at, usedAt, 'used_at 不得被清成 NULL（那是篡改历史）');
  assert.equal(pool.grant('pg-1').revoked_at, null, 'used ticket 压根没被碰');
  assert.equal(pool.grant('pg-4').state, 'expired', 'expired 已不授予访问 ⇒ 由 reaper 清，不打扰');
  assert.equal(pool.grant('pg-5').revoked_at.startsWith('2026-10-01'), true, 'COALESCE 不覆盖既有 revoked_at');
  // 两个数分开打（工单第 2 条）：本次释放 2 条、撤权命中 2 条。
  assert.equal(infos.filter((m) => m.includes('release-network-routes')).length, 1);
  assert.match(infos.find((m) => m.includes('release-network-routes')), /释放 allocation 2 条、撤预览 grant（仅 active）2 条/);
});

test('#252③ 重试路径（真机残渣的最小复现）：allocation 已 released、grant 仍 active ⇒ 再跑一次必须把它撤掉', async (t) => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const pool = new OffboardingPool({
    steps: stepsPendingOnlyRelease(),          // 上一次尝试：本步没做完，其余 done
    allocations: [{ fde_id: FDE_ID, state: 'released', released_at: '2026-10-10T09:05:00.000Z' }],
    grants: [
      { id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt },
      { id: 'pg-2', allocation_id: 'pa-1', kind: 'session', state: 'active', parent_ticket_id: 'pg-1' },
    ],
  });
  const infos = [];
  const { config, options } = offboardingOptions(t, infos);

  const result = await runOffboardingOnce(pool, config, options);

  assert.equal(result.state, 'done');
  assert.equal(pool.grant('pg-2').state, 'revoked',
    '#252 的核心：本次一条行都没释放（上次已释放），旧写法在这里会**静默跳过**撤权');
  assert.ok(pool.grant('pg-2').revoked_at);
  assert.equal(pool.grant('pg-1').state, 'used', 'used 仍原样保留');
  assert.equal(pool.countQuery('UPDATE preview_grants'), 1, '撤权语句必须照发（无条件、幂等）');
  assert.equal(pool.countQuery('SELECT id FROM port_allocations WHERE fde_id'), 1, 'id 集合取本 FDE 全部 allocation（含已 released 的）');
  assert.match(
    infos.find((m) => m.includes('release-network-routes')),
    /释放 allocation 0 条、撤预览 grant（仅 active）1 条/,
    'released=0 而 revoked>0 正是「重试补上了上次漏掉的撤权」的形状',
  );
  assert.deepEqual(pool.outbox.route, [], '什么都没释放 ⇒ 不重复入队派生链（撤权与入队是两件事）');
});

test('#252④ 撤 0 行（这个 FDE 一张 grant 都没有）⇒ 撤权照发、正常返回、不报错', async (t) => {
  const pool = new OffboardingPool({ allocations: [{ fde_id: FDE_ID, state: 'allocated' }] });
  const infos = [];
  const { config, options } = offboardingOptions(t, infos);

  const result = await runOffboardingOnce(pool, config, options);

  assert.equal(result.state, 'done');
  assert.equal(pool.countQuery('UPDATE preview_grants'), 1, '撤 0 行也是成功：语句照发，不靠条件跳过');
  assert.match(infos.find((m) => m.includes('release-network-routes')), /撤预览 grant（仅 active）0 条/);
  assert.deepEqual(pool.grants, []);
});

test('#252⑤ offboarding 侧的 fake 也拦得住：旧谓词（把 used 一起撤）⇒ 语句级抛 23514 preview_grants_check3', async () => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const pool = new OffboardingPool({
    allocations: [{ fde_id: FDE_ID, state: 'released', released_at: '2026-10-10T09:05:00.000Z' }],
    grants: [
      { id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt },
      { id: 'pg-2', allocation_id: 'pa-1', kind: 'session', state: 'active', parent_ticket_id: 'pg-1' },
    ],
  });
  // #252 之前的实现写法（工单第 3 件事要求它「在单测里就红」）。
  await assert.rejects(
    () => pool.query(
      `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
        WHERE allocation_id = ANY($1::uuid[]) AND state IN ('active', 'used')`,
      [['pa-1']],
    ),
    (err) => {
      assert.equal(err.code, '23514');
      assert.match(err.message, /new row for relation "preview_grants" violates check constraint "preview_grants_check3"/);
      return true;
    },
  );
  assert.equal(pool.grant('pg-1').state, 'used', '语句级失败 ⇒ 一行都没改');
  assert.equal(pool.grant('pg-2').state, 'active', '同语句里合法的那条也不许落盘');
  assert.equal(pool.grant('pg-2').revoked_at, null);

  // 新写法在真库形状（used 行就在那儿）下必须正常通过——fake 不是「凡 UPDATE 都抛」。
  const out = await pool.query(
    `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
      WHERE allocation_id = ANY($1::uuid[]) AND state = 'active'
      RETURNING id`,
    [['pa-1']],
  );
  assert.deepEqual(out.rows, [{ id: 'pg-2' }]);
  assert.equal(pool.grant('pg-2').state, 'revoked');
  assert.equal(pool.grant('pg-1').state, 'used');
});

test('#252⑥ 整笔回滚不留下半成品：撤权撞 CHECK ⇒ ROLLBACK 后 allocation 仍活、grant 一字未改', async () => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const pool = new OffboardingPool({
    allocations: [{ fde_id: FDE_ID, state: 'allocated' }],
    grants: [{ id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt }],
  });
  const before = pool.cloneTables();
  await pool.query('BEGIN');
  await pool.query(
    `UPDATE port_allocations SET state = 'released', released_at = COALESCE(released_at, now())
      WHERE fde_id = $1 AND state <> 'released' RETURNING id`,
    [FDE_ID],
  );
  assert.equal(pool.allocations[0].state, 'released', '事务内看得见');
  await assert.rejects(() => pool.query(
    `UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
      WHERE allocation_id = ANY($1::uuid[]) AND state IN ('active', 'used')`,
    [['pa-1']],
  ), (err) => err.code === '23514');
  await pool.query('ROLLBACK');
  assert.deepEqual(pool.cloneTables(), before, '回滚 = 整笔还原（真机就是这个形状：500 之后旧行仍活）');
});
