import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initialOffboardingSteps,
  retryOffboarding,
  runOffboardingOnce,
  startOffboardingLoop,
  sweepOffboardedWorkspaces,
} from '../src/offboarding.js';
// #677 P3 第一批：`workspace.retention_days` 的写路径失效钩子（判据用它演「管理台刚保存」）。
import { invalidateWorkspaceRetentionCache } from '../src/runtime-settings.js';
// #677 P3 收尾批：B 方向要真时间语义 ⇒ 那里挂一条真库腿（环境门与文案共用同一入口）。
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
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
    // #677 P3⑤ 的靶面：假库也要能演「给还没期限的行补一个期限」这条写（真库里它是
    // `SET workspace_purge_after = now() + ($k * interval '1 day') … IS NULL`）。
    // **今天的产品不发这条语句**（`0` 的语义 = 不补期限，口径见 docs/api/portal.md §4.21）；
    // 它在这里存在的唯一理由：变异 M-A（把 A 方向改成「改回正数时补 now+N」）必须能把 P3⑤
    // 跑红，而假库不模拟 = 那条变异只改了个没人执行的字符串 = 假绿。
    if (normalized.includes('UPDATE fde_offboarding')
      && normalized.includes('workspace_purge_after = now() +')
      && normalized.includes('workspace_purge_after IS NULL')) {
      const days = params.find((p) => typeof p === 'number' && p > 0);
      if (this.job?.state === 'done' && this.job.workspace_purge_after == null && days) {
        this.job.workspace_purge_after = new Date(Date.now() + days * 86_400_000);
      }
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

// ---------------------------------------------------------------------------
// issue #677 P3 第一批：`workspace.retention_days` 成了**热读旋钮** ⇒ 消费者的开关判据
// 不许再吃启动期的 `config` 快照。两格判据分工：
//   · sweep 本体：`=== 0 ⇒ disabled` 必须按**传进来的那个数**判（变异 M-2）。
//   · 循环本体：清理那一拍的现读值必须真的落到 sweep 上（变异 M-1），且**下一拍**就是新值。
// 循环那两格走**真热读**（`readWorkspaceRetentionDays` 未替换）+ 真 `sweepOffboardedWorkspaces`，
// 只在假库里换掉 `runtime_settings` 那一读 ⇒ 红的是接线，不是夹具。
//
// 假睡眠/`waitUntil` 的口径照 `idle-backoff-520.test.js`（假睡眠不自己醒，由测试 `pass()` 推进；
// 等「停在某一拍」用截止时刻而不是轮次预算，#531 的假红就出在轮次预算上）。
// ---------------------------------------------------------------------------

/** 认得 `runtime_settings` 整表读的销号假库：库里那一行写什么，由测试中途翻。 */
class OffboardingPoolWithSettings extends OffboardingPool {
  constructor(opts = {}) {
    super(opts);
    this.retentionRow = undefined;   // `undefined` = 库里没有这一行（未配置）
    this.retentionReads = 0;
  }

  async query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    if (/\bFROM runtime_settings\b/i.test(normalized) && !/\bINSERT\b/i.test(normalized)) {
      this.retentionReads += 1;
      const rows = this.retentionRow === undefined
        ? [] : [{ key: 'workspace.retention_days', value: this.retentionRow }];
      return { rows, rowCount: rows.length };
    }
    return super.query(sql, params);
  }
}

/** 那条清理 SELECT 发了几次（`disabled` 的形状 = 一次都不发）。 */
function sweepSelects(pool) {
  const marker = 'SELECT fde_id, fde_name, workspace_purge_after';
  return pool.queryLog.filter(({ sql }) => sql.includes(marker)).length;
}

function makeParkedSleep() {
  const sleeps = [];
  let pending = null;
  const sleep = (ms, signal) => new Promise((resolve) => {
    sleeps.push(ms);
    const entry = { done: false };
    entry.finish = (ok) => {
      if (entry.done) return;
      entry.done = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (pending === entry) pending = null;
      resolve(ok);
    };
    const onAbort = () => entry.finish(false);
    if (signal?.aborted) { entry.finish(false); return; }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    pending = entry;
  });
  return {
    sleeps,
    sleep,
    pass() {
      if (!pending) throw new Error('循环没停在 sleep 上（夹具用错）');
      pending.finish(true);
    },
  };
}

async function waitUntil(cond, label, deadlineMs = 15_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (cond()) return;
    if (Date.now() > deadline) {
      for (let i = 0; i < 5 && !cond(); i += 1) await new Promise((r) => setImmediate(r));
      if (cond()) return;
      assert.fail(`等超时（${deadlineMs}ms + 5 轮宽限，同机负载？）：${label}`);
    }
    await new Promise((r) => setImmediate(r));
  }
}

async function parkedTick(fake, n) {
  await waitUntil(() => fake.sleeps.length >= n,
    `循环应已走到第 ${n} 拍 sleep；实际 ${fake.sleeps.length} 拍`);
}

const HOUR_MS = 60 * 60 * 1000;
const quietLog = { warn() {}, error() {}, debug() {}, log() {} };

test('#677 P3① sweep 的开关判据按**传入的** retentionDays，不按 config 快照（变异 M-2）', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-sweep-value-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, FDE_NAME);
  const now = new Date('2026-10-07T00:00:00Z');
  const expired = () => new Date(now.getTime() - 1);
  const passthrough = { lockFde: async (_pool, _name, work) => work(), now };

  // ① config 说 30（开着），传进来 **0** ⇒ 必须 disabled 且**一条清理 SQL 都不发**。
  //    变异 M-2（判据改回读 `config.workspaceRetentionDays`）在这里以「purged:1 / 目录没了」点名红。
  fs.mkdirSync(workspace);
  const p1 = new OffboardingPool({ state: 'done', purgeAfter: expired() });
  const r1 = await sweepOffboardedWorkspaces(
    p1, { userSpaceRoot: root, workspaceRetentionDays: 30 }, { ...passthrough, retentionDays: 0 },
  );
  assert.deepEqual(r1, { disabled: true, purged: 0, failed: 0 },
    '传进来 0 就是关了：config 里那个 30 不许再算数');
  assert.equal(sweepSelects(p1), 0, 'disabled ⇒ 一条 SQL 都不发');
  assert.equal(fs.existsSync(workspace), true, '目录必须还在');

  // ② 反向：config 说 0（关着），传进来 14 ⇒ 必须真的清（缺省从 config 取，显式值压过它）。
  const p2 = new OffboardingPool({ state: 'done', purgeAfter: expired() });
  const r2 = await sweepOffboardedWorkspaces(
    p2, { userSpaceRoot: root, workspaceRetentionDays: 0 }, { ...passthrough, retentionDays: 14 },
  );
  assert.deepEqual(r2, { disabled: false, purged: 1, failed: 0 });
  assert.equal(fs.existsSync(workspace), false, '按**传入值**清理了');

  // ③ 不传 ⇒ 缺省仍取 config（既有调用方与既有单测的形状不许变）。
  fs.mkdirSync(workspace);
  const p3 = new OffboardingPool({ state: 'done', purgeAfter: expired() });
  const r3 = await sweepOffboardedWorkspaces(
    p3, { userSpaceRoot: root, workspaceRetentionDays: 0 }, passthrough,
  );
  assert.deepEqual(r3, { disabled: true, purged: 0, failed: 0 }, '不传 ⇒ 用 config（0 = 关）');
  const p4 = new OffboardingPool({ state: 'done', purgeAfter: expired() });
  const r4 = await sweepOffboardedWorkspaces(
    p4, { userSpaceRoot: root, workspaceRetentionDays: 30 }, passthrough,
  );
  assert.deepEqual(r4, { disabled: false, purged: 1, failed: 0 }, '不传 ⇒ 用 config（30 = 开）');
});

test('#677 P3② 循环：清理那一拍**现读**保留天数 ⇒ 下一拍用的就是新值（变异 M-1，真热读+真清理）',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-loop-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, FDE_NAME);
    fs.mkdirSync(workspace);
    // 到期时刻按**墙钟**判（`sweepOffboardedWorkspaces` 的 `now` 缺省是 `new Date()`，循环没换它）。
    const pool = new OffboardingPoolWithSettings({
      state: 'done', purgeAfter: new Date(Date.now() - 60_000),
    });
    pool.retentionRow = 0;              // 库里说「不清理」，而启动期快照 config 是 7
    invalidateWorkspaceRetentionCache();

    const fake = makeParkedSleep();
    let clock = 1_700_000_000_000;
    const loop = startOffboardingLoop(pool, { userSpaceRoot: root, workspaceRetentionDays: 7 }, {
      docker: {}, log: quietLog, sleep: fake.sleep, now: () => clock,
    });

    // ① 第一拍：闸门开（`lastSweepAt=0`），但现读到的是 **0** ⇒ 这一拍不许清。
    //    红法：`purged:1` + 目录没了 = 循环还在吃启动快照（M-1）。
    await parkedTick(fake, 1);
    assert.equal(sweepSelects(pool), 0, '库里写 0 ⇒ 这一拍不清（config 的 7 是启动期快照，不算数）');
    assert.equal(fs.existsSync(workspace), true);
    assert.ok(pool.retentionReads >= 1, '这一拍确实现读过（一次都没读 = 压根没接线）');

    // ② 管理台把它改成 14（本进程的写路径在 COMMIT 后失效缓存 = 下面这一行干的事）
    //    ⇒ 跨过 1h 闸门的**下一拍**必须按新值清。
    pool.retentionRow = 14;
    invalidateWorkspaceRetentionCache();
    clock += HOUR_MS + 1000;
    fake.pass();
    await parkedTick(fake, 2);
    assert.equal(sweepSelects(pool), 1, '下一拍必须真的发清理那条 SQL（0 = 现读值没交给 sweep）');
    assert.equal(fs.existsSync(workspace), false, '按新值（14 天）真的把目录清了');

    // ③ 再翻回 0 ⇒ 再下一拍又关掉（两个方向都必须是现读的，红一次就说得清是哪一半）。
    pool.retentionRow = 0;
    fs.mkdirSync(workspace);            // 再放一个目录，让「清没清」可观察
    invalidateWorkspaceRetentionCache();
    clock += HOUR_MS + 1000;
    fake.pass();
    await parkedTick(fake, 3);
    assert.equal(sweepSelects(pool), 1, '关掉之后不再发清理 SQL');
    assert.equal(fs.existsSync(workspace), true, '0 = 不清：目录必须还在');

    loop.stop();
    await loop.settled;
    assert.equal(loop.failure(), null, '循环本体不许因为现读而挂掉（现读永不抛）');
  });

test('#677 P3③ 循环：现读到的值也交给 schedule-workspace-purge（同一个旋钮不许两种新鲜度）',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-deadline-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));

    // ① 库里写 0 ⇒ 即便启动快照是 7，也不许给这次销号写下 purge deadline（`0 = 不清理`）。
    const offPool = new OffboardingPoolWithSettings({ state: 'pending' });
    offPool.retentionRow = 0;
    invalidateWorkspaceRetentionCache();
    const fakeOff = makeParkedSleep();
    let clock = 1_700_000_000_000;
    const offCfg = { userSpaceRoot: root, workspaceRetentionDays: 7 };
    const offLoop = startOffboardingLoop(offPool, offCfg, {
      docker: fakeDocker(), log: quietLog, sleep: fakeOff.sleep, now: () => clock,
    });
    await parkedTick(fakeOff, 1);
    offLoop.stop();
    await offLoop.settled;
    assert.equal(offPool.job.state, 'done', '这一拍确实把活干完了');
    assert.equal(offPool.job.workspace_purge_after, null,
      '库里 0 ⇒ 不写 purge deadline（写了 = 还在用启动快照的 7）');

    // ② 库里写 14 ⇒ deadline 必须按 14 天算，不是启动快照的 7 天。
    const onPool = new OffboardingPoolWithSettings({ state: 'pending' });
    onPool.retentionRow = 14;
    invalidateWorkspaceRetentionCache();
    const fakeOn = makeParkedSleep();
    const onCfg = { userSpaceRoot: root, workspaceRetentionDays: 7 };
    const onLoop = startOffboardingLoop(onPool, onCfg, {
      docker: fakeDocker(), log: quietLog, sleep: fakeOn.sleep, now: () => clock,
    });
    await parkedTick(fakeOn, 1);
    onLoop.stop();
    await onLoop.settled;
    assert.equal(onPool.job.state, 'done');
    const days = (onPool.job.workspace_purge_after.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 13.9 && days < 14.1,
      `purge deadline 必须按现读的 14 天算（实得 ${days.toFixed(2)} 天 = 还在吃启动快照）`);
  });

test('#677 P3④ 循环递给 sweep 的就是现读到的那个数（直接看参数，两格旋钮各用一次注入缝）', async () => {
  // 与 P3② 的分工：那一格判**效果**（真清理真删目录），这一格判**参数本身**——
  // 红法不同：M-1（循环改回读 config）会让 `seen` 停在启动快照 `[7, 7]` 而不是 `[30, 0]`。
  const fake = makeParkedSleep();
  let hot = 30;
  const seen = [];
  let clock = 1_700_000_000_000;
  const pool = new OffboardingPoolWithSettings({ state: 'done' });
  const loop = startOffboardingLoop(
    pool,
    { userSpaceRoot: '/tmp/station-p3-seam', workspaceRetentionDays: 7 },
    {
      docker: {}, log: quietLog, sleep: fake.sleep, now: () => clock,
      readRetention: async () => hot,
      sweep: async (_pool, _config, opts) => {
        seen.push(opts?.retentionDays);
        return { disabled: false, purged: 0, failed: 0 };
      },
    },
  );
  await parkedTick(fake, 1);
  assert.deepEqual(seen, [30],
    `第一拍 sweep 收到的必须是现读到的 30，不是启动快照的 7（实得 ${JSON.stringify(seen)}）`);
  hot = 0;
  clock += HOUR_MS + 1000;
  fake.pass();
  await parkedTick(fake, 2);
  assert.deepEqual(seen, [30, 0],
    `改完之后下一拍必须是新值 0（实得 ${JSON.stringify(seen)}）`);
  loop.stop();
  await loop.settled;
  assert.equal(loop.failure(), null);
});

// ---------------------------------------------------------------------------
// #677 P3 收尾批：`workspace.retention_days = 0` 的**语义契约**（口径见
// `docs/api/portal.md` §4.21「`0` 的语义」那一小节 + `docs/env.md` 那一行）。
//
// 为什么这三格在**本文件**而不是 `runtime-settings.test.js`：这两个方向判的是**消费者**
//（写期限那一步 + 清理那一拍）对 `0` 的反应；`runtime-settings.test.js` 守的是旋钮本身
//（registry / 解析 / 三档来源 / 缓存 / 失效）。判据要挂在「行为被改时会红」的那一侧，
// 红法才解释得通 —— 把 M-A/M-B 放进 registry 那一侧，改 sweep 的谓词压根不会红。
//
// 三格的红法各不同（缺一半就说得出是哪一半坏了）：
//   P3⑤ A 方向（假库）  ：`0` 期间完成离职 ⇒ 期限留 NULL；改回 7 也**不补、不追删**（变异 M-A）。
//   P3⑥ B 方向（假库）  ：已过期的旧期限在 `0` 那一拍只是暂停；改回 7 的下一拍**直接兑现**（变异 M-B）。
//   P3⑦ B 方向（真库腿）：同一件事交给**真的 Postgres** 判时间（真 `timestamptz` + 真墙钟 + 真谓词）。
//
// ⚠ 为什么 B 方向**必须**多一条真库腿（不是加戏）：假库那条清理 SELECT 是按 **SQL 文本匹配**
//   再在 JS 里比时间的（`OffboardingPool` 里 `WHERE state = 'done' AND workspace_purge_after
//   IS NOT NULL` 那一支），所以「把谓词改成 `workspace_purge_after + ($3 * interval '1 day')
//   <= $1`」这类变异在假库里**压根不红** —— 而那恰好是 M-B（重新等 N 天）最自然的写法。
//   P3⑥ 守的是「循环 + 真 sweep + 真目录」那条效果链，P3⑦ 守的是那句 SQL 的时间语义本身。
// ---------------------------------------------------------------------------

const PG_URL = (process.env.TEST_DATABASE_URL || '').trim();
const PG_SKIP = PG_URL ? false : SKIP_WITHOUT_PG;
const pgFixture = PG_URL ? createPgFixture(PG_URL, { prefix: 'w677p3' }) : null;

/** 有没有谁写了 `workspace_purge_after`（补期限、顺延期限都得走这条写）。 */
function deadlineWrites(pool) {
  return pool.queryLog.filter(({ sql }) => /SET\s+workspace_purge_after\s*=/i.test(sql)).length;
}

const passthroughLock = async (_pool, _name, work) => work();
const DAY_MS = 86_400_000;

test('#677 P3⑤ A 方向：0 期间完成离职 ⇒ 期限留 NULL，改回 7 也不补、不追删（变异 M-A）',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-a-dir-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, FDE_NAME);
    fs.mkdirSync(workspace);           // 目录先存在，「还在不在」才是可观察的效果

    // ① 离职在**库里写着 0** 的那一拍做完（启动快照 config 是 30 = 干扰项，现读必须压过它）。
    const pool = new OffboardingPoolWithSettings({ state: 'pending' });
    pool.retentionRow = 0;
    invalidateWorkspaceRetentionCache();
    const fake = makeParkedSleep();
    let clock = 1_700_000_000_000;
    const loop = startOffboardingLoop(pool, { userSpaceRoot: root, workspaceRetentionDays: 30 }, {
      docker: fakeDocker(), log: quietLog, sleep: fake.sleep, now: () => clock,
    });
    await parkedTick(fake, 1);
    assert.equal(pool.job.state, 'done', '这一拍确实把活干完了（否则后半段在测空案）');
    assert.equal(pool.job.workspace_purge_after, null, '0 那一拍不许写期限');
    assert.equal(deadlineWrites(pool), 0, '0 那一拍连那条 UPDATE 都不许发');

    // ② 管理台把它改成 7（下面这一行就是生产里写路径在 COMMIT 后调的那个失效钩子），
    //    再把假时钟推过 1h 闸门 ⇒ 清理那一拍是**开着**的：它必须真的去查，但 NULL 不在候选集。
    pool.retentionRow = 7;
    invalidateWorkspaceRetentionCache();
    clock += HOUR_MS + 1000;
    fake.pass();
    await parkedTick(fake, 2);
    assert.equal(sweepSelects(pool), 1,
      '清理那一拍真的发了 SQL（拿 disabled 蒙过去 = 这一格压根没在判 A 方向）');
    assert.equal(pool.job.workspace_purge_after, null,
      'A 方向：改回正数**不许**给「0 期间完成离职」的工位补一个 now+7 天 的期限');
    assert.equal(deadlineWrites(pool), 0,
      '补期限/顺延期限都要发那条 UPDATE；发了就是改了语义（口径：改旋钮不写这一列）');
    assert.equal(fs.existsSync(workspace), true, '0 期间完成离职 ⇒ 目录不许被清');

    loop.stop();
    await loop.settled;
    assert.equal(loop.failure(), null);

    // ③ 把墙钟推到「假如当年补的是 7 天」之后：那条**补出来的**期限此刻已过期，所以这一拍
    //    会把它删掉 ⇒ 真语义（压根没期限）必须仍然一动不动。
    //    红法：M-A 在 ② 那一拍把期限写成 now+7 天，到这里就是 purged:1 + 目录没了。
    const later = await sweepOffboardedWorkspaces(
      pool, { userSpaceRoot: root, workspaceRetentionDays: 7 },
      {
        retentionDays: 7, now: new Date(Date.now() + 8 * DAY_MS),
        lockFde: passthroughLock, log: quietLog,
      },
    );
    assert.deepEqual(later, { disabled: false, purged: 0, failed: 0 },
      'NULL 行永远不进清理候选集（过了 8 天也一样）');
    assert.equal(fs.existsSync(workspace), true, 'A 方向：过了 8 天也不许被追删');
    assert.equal(pool.job.workspace_purge_after, null);
  });

test('#677 P3⑥ B 方向：已过期的旧期限在 0 那一拍只是暂停，改回 7 的下一拍直接兑现（变异 M-B）',
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-b-dir-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, FDE_NAME);
    fs.mkdirSync(workspace);
    // 期限按**墙钟**排（`sweepOffboardedWorkspaces` 的 `now` 缺省是 `new Date()`，循环没换它）。
    const purgeAt = new Date(Date.now() - 30 * DAY_MS);
    const pool = new OffboardingPoolWithSettings({ state: 'done', purgeAfter: purgeAt });
    pool.retentionRow = 0;
    invalidateWorkspaceRetentionCache();

    const fake = makeParkedSleep();
    let clock = 1_700_000_000_000;
    const loop = startOffboardingLoop(pool, { userSpaceRoot: root, workspaceRetentionDays: 30 }, {
      docker: {}, log: quietLog, sleep: fake.sleep, now: () => clock,
    });
    // ① `0` 那一拍：不查、不删、也不许抹期限（暂停 = 什么都不动）。
    await parkedTick(fake, 1);
    assert.equal(sweepSelects(pool), 0, '0 = 这一拍压根不发清理 SQL');
    assert.equal(fs.existsSync(workspace), true, '暂停期间目录必须还在');
    assert.equal(pool.job.workspace_purge_after.getTime(), purgeAt.getTime(), '暂停不许抹期限');

    // ② 改回 7 ⇒ 下一拍**当场兑现**那条已过期的旧期限（这里没有「再等 7 天」这一步）。
    //    红法：M-B 把这一拍变成「先顺延 7 天再收工」⇒ 目录还在 + 期限被改写 + 多一条 UPDATE。
    pool.retentionRow = 7;
    invalidateWorkspaceRetentionCache();
    clock += HOUR_MS + 1000;
    fake.pass();
    await parkedTick(fake, 2);
    assert.equal(sweepSelects(pool), 1, '改回正数的下一拍必须真的去查');
    assert.equal(fs.existsSync(workspace), false,
      'B 方向：改回正数的下一拍必须**直接兑现**那条已过期的旧期限（重新等 7 天 = 把止血阀当延期器）');
    assert.equal(pool.job.workspace_purge_after.getTime(), purgeAt.getTime(),
      '兑现旧期限 = 原样兑现，不许把它顺延成 now+7 天');
    assert.equal(deadlineWrites(pool), 0, '兑现旧期限不需要重写那一行');

    loop.stop();
    await loop.settled;
    assert.equal(loop.failure(), null);
  });

test('#677 P3⑦ B 方向真库腿：真 timestamptz + 真墙钟下，0 只是暂停，改回 7 当场兑现且不重排期限',
  { skip: PG_SKIP }, async (t) => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-p3-b-db-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const CONFIG = { userSpaceRoot: root, workspaceRetentionDays: 30 };  // 快照 30 = 干扰项
    const EXPIRED = 'w677p3-expired';   // B 方向：30 天前就该删
    const FUTURE = 'w677p3-future';     // 对照：还没到期，顺手删掉就是「清理不看期限」
    const NULLY = 'w677p3-null';        // A 方向的真库对照：压根没期限

    await pgFixture.withFreshDatabase(async ({ pool }) => {
      for (const name of [EXPIRED, FUTURE, NULLY]) {
        fs.mkdirSync(path.join(root, name));   // 真的目录 ⇒ 「没删」是可观察的事实
      }
      // 期限由**真库**算（`now() ± interval`），不由 JS 时钟喂：这一格要判的就是那句谓词。
      await pool.query(
        `INSERT INTO fde_offboarding (fde_id, fde_name, state, steps, workspace_purge_after)
         VALUES ($1::uuid, $2, 'done', '{}'::jsonb, now() - interval '30 days')`,
        ['b0000000-0000-4000-8000-0000000000b1', EXPIRED],
      );
      await pool.query(
        `INSERT INTO fde_offboarding (fde_id, fde_name, state, steps, workspace_purge_after)
         VALUES ($1::uuid, $2, 'done', '{}'::jsonb, now() + interval '5 days')`,
        ['b0000000-0000-4000-8000-0000000000b2', FUTURE],
      );
      await pool.query(
        `INSERT INTO fde_offboarding (fde_id, fde_name, state, steps, workspace_purge_after)
         VALUES ($1::uuid, $2, 'done', '{}'::jsonb, NULL)`,
        ['b0000000-0000-4000-8000-0000000000b3', NULLY],
      );
      const before = await purgeDeadlines(pool, [EXPIRED, FUTURE, NULLY]);
      assert.ok(before[EXPIRED] < Date.now(), '种子确实是已过期的（真库算出来的）');
      assert.equal(before[NULLY], null);

      // ① 旋钮 = 0 ⇒ 暂停：一条查询都不发（`disabled` 在发 SQL 之前就 return），三行原样。
      assert.deepEqual(
        await sweepOffboardedWorkspaces(pool, CONFIG, { retentionDays: 0, log: quietLog }),
        { disabled: true, purged: 0, failed: 0 },
      );
      for (const name of [EXPIRED, FUTURE, NULLY]) {
        assert.equal(fs.existsSync(path.join(root, name)), true, `0 期间 ${name} 不许被删`);
      }
      assert.deepEqual(await purgeDeadlines(pool, [EXPIRED, FUTURE, NULLY]), before,
        '暂停期间不许动任何一行的期限（不抹、不顺延、不补）');

      // ② 改回 7 ⇒ **当场**兑现那条已过期的；未到期与 NULL 那两行原样。
      //    红法：M-B（先顺延再收工）⇒ `purged:0` + 目录还在 + `before/after` 不等。
      assert.deepEqual(
        await sweepOffboardedWorkspaces(pool, CONFIG, { retentionDays: 7, log: quietLog }),
        { disabled: false, purged: 1, failed: 0 },
        '只兑现已过期的那一条（顺手多删 = 谓词没看期限；一条都没删 = 重新等了 N 天）',
      );
      assert.equal(fs.existsSync(path.join(root, EXPIRED)), false, 'B 方向：旧期限当场被兑现');
      assert.equal(fs.existsSync(path.join(root, FUTURE)), true, '未到期的那条不许被牵连');
      assert.equal(fs.existsSync(path.join(root, NULLY)), true, 'A 方向：NULL 那条永远不动');
      const after = await purgeDeadlines(pool, [EXPIRED, FUTURE, NULLY]);
      assert.deepEqual(after, before, '兑现期限 = 原样兑现：三条期限一个字节都没被改写过');

      // 行本身一条不少：DB 是真相，清理只删目录。
      const rows = await pool.query(`SELECT count(*)::int AS n FROM fde_offboarding`);
      assert.equal(rows.rows[0].n, 3, '清理销号目录，不销 fde_offboarding 的行');
    });
  });

/** 读回这几行的期限（`null` = 没排过）；用真库返回值本身，不做任何 JS 侧换算。 */
async function purgeDeadlines(pool, names) {
  const { rows } = await pool.query(
    `SELECT fde_name, workspace_purge_after FROM fde_offboarding
      WHERE fde_name = ANY($1::text[]) ORDER BY fde_name`,
    [names],
  );
  return Object.fromEntries(rows.map((row) => [
    row.fde_name, row.workspace_purge_after ? new Date(row.workspace_purge_after).getTime() : null,
  ]));
}
