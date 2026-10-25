import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { createMaterializer } from '../src/materializer.js';
import {
  deleteGitCredential,
  GitCredentialError,
  listGitCredentials,
  setGitCredential,
} from '../src/git-credential.js';
import { FakePool } from './fake-pool.js';

// 宿主侧属主跟随进程身份（同 portal/test/git-cli-config.test.js 顶部注释与
// runner/test/run-data.test.js:28）：非特权进程 chown 只能落在自己的 euid/所属组上，
// 硬编码 1000 在 uid≠1000 的 runner 上会 EPERM（GitHub Actions run 38041183692）。
// 生产 portal 是 root（portal/Dockerfile:37），所以产品代码 (`config.fdeUid ?? 1000`) 不动。
const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001',
  login: 'admin',
  display_name: 'Admin',
  role: 'admin',
  fde_name: null,
  auth_source: 'local',
  status: 'active',
};
const FDE_USER = {
  id: 'b0000000-0000-4000-8000-000000000002',
  login: 'alice',
  display_name: 'Alice',
  role: 'fde',
  fde_name: 'alice',
  auth_source: 'local',
  status: 'active',
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-git-credential-'));
  const home = path.join(root, 'alice', 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o2770 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home,
    target: path.join(home, '.git-credentials'),
    config: { userSpaceRoot: root, fdeUid: SELF_UID, fdeGid: SELF_GID },
  };
}

function recordingPool(gitHostBaseUrls = []) {
  const calls = [];
  const pool = {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql === 'SELECT base_url, provider FROM git_hosts') {
        return { rows: gitHostBaseUrls.map((base_url) => ({ base_url, provider: null })) };
      }
      return { rows: [] };
    },
    async connect() {
      return { query: (sql, params) => pool.query(sql, params), release() {} };
    },
  };
  return pool;
}

/**
 * issue #395 改了这条契约：明文 token 从「**永不进 DB**」变成「只进 `fde_git_accounts.token` 一列」。
 * 所以这里断言的不再是「DB 调用里没有明文」，而是「**除了那一列，哪儿都不能有**」：
 *   ① SQL 文本里永远不得内插明文（拼串 = 泄进 `pg_stat_activity` / 日志）；
 *   ② 参数里只允许出现在 `UPDATE fde_git_accounts … SET token` 那一条；
 *      `audit_log` 的 INSERT 参数（details JSON）里出现明文就是回归——`admin.git_credential_set`
 *      历史上就只记 host/username，这个口径不能因为多了个副本列就被抹掉。
 */
function assertNoTokenInDbCalls(pool, ...tokens) {
  for (const call of pool.calls) {
    const serialized = JSON.stringify(call.params);
    const isTokenColumnWrite = /UPDATE fde_git_accounts/i.test(call.sql) && /\bSET token\b/i.test(call.sql);
    for (const token of tokens) {
      assert.ok(!call.sql.includes(token), 'token 不得出现在 SQL 文本（拼接 = 泄进 pg_stat_activity 与日志）');
      if (isTokenColumnWrite) continue;
      assert.ok(!serialized.includes(token), `token 不得写入 ${call.sql.slice(0, 60)} 的参数（明文副本只住 fde_git_accounts.token）`);
    }
  }
}

/** 抽出一组调用里对 `fde_git_accounts.token` 列的写（#395 的断言靶子）。 */
const tokenColumnWrites = (pool) => pool.calls.filter(
  (call) => /UPDATE fde_git_accounts/i.test(call.sql) && /\bSET token\b/i.test(call.sql),
);

/**
 * issue #183：投放/删除 per-FDE PAT 的 fake pool——记录状态翻转与物化入队。
 * `flip` 控制 UPDATE users 是否返回受影响行（模拟状态确实发生翻转）。
 */
function assignedAccountPool({ baseUrl = 'https://github.com', flip = true } = {}) {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'SELECT base_url, provider FROM git_hosts') return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          calls.push({ sql, params });
          // issue #395：明文副本的 host 匹配查询（与下方状态翻转共用同一事务）
          if (sql.includes('a.fde_id, a.git_host_id')) {
            return { rows: [{ fde_id: 'fde-1', git_host_id: 'host-1', base_url: baseUrl }] };
          }
          if (sql.includes('SELECT u.id AS fde_id')) {
            return { rows: [{ fde_id: 'fde-1', git_host_id: 'host-1', base_url: baseUrl }] };
          }
          if (sql.includes('UPDATE users SET status')) {
            return { rows: flip ? [{ id: params[0] }] : [] };
          }
          if (sql.includes('INSERT INTO materialize_revisions')) return { rows: [{ revision: 2 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return pool;
}

const materializeOutboxInserts = (pool) => pool.calls.filter((call) => call.sql.includes('INSERT INTO materialize_outbox'));
const materializeRevisionInserts = (pool) => pool.calls.filter((call) => call.sql.includes('INSERT INTO materialize_revisions'));

test('write merges hosts, replaces only the target host, and installs 0640 FDE-owned file', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const common = { pool, actorId: 'admin-id', config: f.config, fdeName: 'alice' };

  await setGitCredential({ ...common, host: 'GitHub.com', username: 'x-access-token', token: 'ghp:secret@A/?#%' });
  await setGitCredential({ ...common, host: 'gitlab.example.com', username: 'oauth2', token: 'glpat-gitlab-B-4567' });
  let lines = fs.readFileSync(f.target, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.includes('https://x-access-token:ghp%3Asecret%40A%2F%3F%23%25@github.com'));
  assert.ok(lines.includes('https://oauth2:glpat-gitlab-B-4567@gitlab.example.com'));

  await setGitCredential({ ...common, host: 'github.com', username: 'x-access-token', token: 'ghp-new-token-9876' });
  lines = fs.readFileSync(f.target, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.includes('https://x-access-token:ghp-new-token-9876@github.com'));
  assert.ok(lines.includes('https://oauth2:glpat-gitlab-B-4567@gitlab.example.com'));
  assert.ok(!fs.readFileSync(f.target, 'utf8').includes('ghp:secret@A'));

  const stat = fs.statSync(f.target);
  assert.equal(stat.mode & 0o777, 0o640);
  assert.equal(stat.uid, SELF_UID, '落盘属主必须等于 config.fdeUid');
  assert.equal(stat.gid, SELF_GID, '落盘属组必须等于 config.fdeGid');
  assertNoTokenInDbCalls(pool, 'ghp:secret@A/?#%', 'glpat-gitlab-B-4567', 'ghp-new-token-9876');
  assert.deepEqual(pool.calls.filter((call) => call.sql.includes('INSERT INTO audit_log')).map((call) => call.params[1]), [
    'admin.git_credential_set',
    'admin.git_credential_set',
    'admin.git_credential_set',
  ]);
});

test('delete removes only the selected host and retains an empty 0640 file', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const common = { pool, actorId: 'admin-id', config: f.config, fdeName: 'alice' };
  await setGitCredential({ ...common, host: 'github.com', username: 'x-access-token', token: 'ghp-github-secret' });
  await setGitCredential({ ...common, host: 'gitlab.com', username: 'oauth2', token: 'glpat-gitlab-secret' });
  fs.writeFileSync(f.target, `\n${fs.readFileSync(f.target, 'utf8')}`);

  assert.deepEqual(await deleteGitCredential({ ...common, host: 'github.com' }), { host: 'github.com', deleted: true });
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'https://oauth2:glpat-gitlab-secret@gitlab.com\n');
  assert.deepEqual(await deleteGitCredential({ ...common, host: 'gitlab.com' }), { host: 'gitlab.com', deleted: true });
  assert.ok(fs.existsSync(f.target));
  assert.equal(fs.readFileSync(f.target, 'utf8'), '');
  const stat = fs.statSync(f.target);
  assert.equal(stat.mode & 0o777, 0o640);
  assert.equal(stat.uid, SELF_UID, '空凭据文件仍由 config.fdeUid 持有');
  assert.equal(stat.gid, SELF_GID);
  assertNoTokenInDbCalls(pool, 'ghp-github-secret', 'glpat-gitlab-secret');
});

test('atomic replacement leaves the old credential intact on rename failure', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const common = { pool, actorId: 'admin-id', config: f.config, fdeName: 'alice' };
  await setGitCredential({ ...common, host: 'github.com', username: 'x-access-token', token: 'old-secret-token' });
  const previous = fs.readFileSync(f.target, 'utf8');
  const auditCount = pool.calls.filter((call) => call.sql.includes('INSERT INTO audit_log')).length;
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (to === f.target) throw new Error('injected rename failure');
    return originalRename(from, to, ...args);
  };
  try {
    await assert.rejects(
      setGitCredential({ ...common, host: 'github.com', username: 'x-access-token', token: 'new-secret-token' }),
      /injected rename failure/,
    );
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(f.target, 'utf8'), previous);
  assert.equal(
    pool.calls.filter((call) => call.sql.includes('INSERT INTO audit_log')).length,
    auditCount,
    'failed writes are not audited as successful',
  );
  assert.deepEqual(fs.readdirSync(f.home), ['.git-credentials'], 'temporary file is removed');
});

test('credential protocol follows matching git_hosts configuration and defaults to HTTPS without a match', async (t) => {
  const f = fixture(t);
  const cases = [
    {
      host: 'gitea.example.test:3000',
      baseUrls: ['https://gitea.example.test:3001', 'http://gitea.example.test:3000'],
      protocol: 'http',
    },
    {
      host: 'secure.example.test:8443',
      baseUrls: ['https://secure.example.test:8443'],
      protocol: 'https',
    },
    {
      host: 'unlisted.example.test:3000',
      baseUrls: ['http://another.example.test:3000'],
      protocol: 'https',
    },
  ];

  for (const [index, { host, baseUrls, protocol }] of cases.entries()) {
    await setGitCredential({
      pool: recordingPool(baseUrls),
      config: f.config,
      fdeName: 'alice',
      host,
      username: `user-${index}`,
      token: `token-${index}`,
    });
    const lines = fs.readFileSync(f.target, 'utf8').trimEnd().split('\n');
    const line = lines.find((entry) => new URL(entry).host === host);
    assert.ok(line?.startsWith(`${protocol}://`), `${host} should use ${protocol}`);
  }
});

test('explicit protocol overrides git_hosts and invalid protocol is rejected', async (t) => {
  const f = fixture(t);
  const pool = recordingPool(['http://git.example.test:3000']);
  await setGitCredential({
    pool,
    config: f.config,
    fdeName: 'alice',
    host: 'git.example.test:3000',
    username: 'alice',
    token: 'secret',
    protocol: 'https',
  });
  assert.ok(fs.readFileSync(f.target, 'utf8').startsWith('https://'));

  const invalidPool = recordingPool(['http://git.example.test:3000']);
  await assert.rejects(
    setGitCredential({
      pool: invalidPool,
      config: f.config,
      fdeName: 'alice',
      host: 'invalid.example.test',
      username: 'alice',
      token: 'secret',
      protocol: 'ftp',
    }),
    (err) => err instanceof GitCredentialError && err.code === 'validation_failed' && err.details.field === 'protocol',
  );
  assert.equal(invalidPool.calls.length, 0);
});

test('changing protocol replaces the existing host line without leaving a duplicate', async (t) => {
  const f = fixture(t);
  const common = {
    config: f.config,
    fdeName: 'alice',
    host: 'git.example.test:3000',
    username: 'alice',
    token: 'secret',
  };
  await setGitCredential({ ...common, pool: recordingPool(['https://git.example.test:3000']) });
  assert.ok(fs.readFileSync(f.target, 'utf8').startsWith('https://'));

  await setGitCredential({ ...common, pool: recordingPool(['http://git.example.test:3000']) });
  const lines = fs.readFileSync(f.target, 'utf8').trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(new URL(lines[0]).host, common.host);
  assert.equal(new URL(lines[0]).protocol, 'http:');
});

test('GET returns a masked credential view and DB audit calls never contain token text', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const token = 'github-pat-secret-123456';
  await setGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice',
    host: 'github.com', username: 'x-access-token', token,
  });
  const response = await listGitCredentials({ config: f.config, fdeName: 'alice' });
  assert.deepEqual(response, {
    hosts: [{ host: 'github.com', protocol: 'https', username: 'x-access-token', token: '****3456' }],
  });
  assert.ok(!JSON.stringify(response).includes(token));
  assertNoTokenInDbCalls(pool, token);
});

test('setting or deleting the assigned per-FDE PAT updates remote login and awaiting status', async (t) => {
  const f = fixture(t);
  const state = { userStatus: 'awaiting_credential', remoteLogin: null };
  const pool = {
    calls: [],
    async query(sql, params = []) {
      this.calls.push({ sql, params });
      if (sql.includes('SELECT u.id AS fde_id')) {
        return { rows: [{ fde_id: 'fde-1', git_host_id: 'host-1', base_url: 'https://github.com' }] };
      }
      if (sql.includes('UPDATE fde_git_accounts')) {
        state.remoteLogin = params[2];
        return { rows: [] };
      }
      if (sql.includes('UPDATE users SET status')) {
        state.userStatus = params[1];
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() {
      return { query: (sql, params) => pool.query(sql, params), release() {} };
    },
  };
  const common = { pool, config: f.config, fdeName: 'alice', host: 'github.com' };
  await setGitCredential({ ...common, username: 'alice-gh', token: 'github-pat-secret' });
  assert.equal(state.remoteLogin, 'alice-gh');
  assert.equal(state.userStatus, 'active');
  await deleteGitCredential({ ...common });
  assert.equal(state.remoteLogin, null);
  assert.equal(state.userStatus, 'awaiting_credential');
  assertNoTokenInDbCalls(pool, 'github-pat-secret');
});

test('投放 per-FDE PAT 把 awaiting_credential→active 时同事务入队一次 materialize revision（issue #183）', async (t) => {
  const f = fixture(t);
  const pool = assignedAccountPool({ flip: true });
  await setGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice',
    host: 'github.com', username: 'alice-gh', token: 'github-pat-secret',
  });
  const outbox = materializeOutboxInserts(pool);
  assert.equal(outbox.length, 1, '凭据到达必须补一次物化');
  assert.deepEqual(outbox[0].params, ['fde-1', 'upsert', 2, '{}']);
  assert.equal(materializeRevisionInserts(pool).length, 1, 'revision head 必须前进');
  const begin = pool.calls.findIndex((call) => call.sql === 'BEGIN');
  const commit = pool.calls.findIndex((call) => call.sql === 'COMMIT');
  const outboxIdx = pool.calls.findIndex((call) => call.sql.includes('INSERT INTO materialize_outbox'));
  assert.ok(begin >= 0 && begin < outboxIdx && outboxIdx < commit, '入队必须与状态翻转在同一事务');
  assertNoTokenInDbCalls(pool, 'github-pat-secret');
});

test('删除 per-FDE PAT（active→awaiting_credential）不触发物化（issue #183）', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.target, 'https://x-access-token:old-secret@github.com\n', { mode: 0o640 });
  const pool = assignedAccountPool({ flip: true });
  const result = await deleteGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice', host: 'github.com',
  });
  assert.equal(result.deleted, true);
  assert.equal(materializeOutboxInserts(pool).length, 0, '删除凭据不得入队物化');
  assert.equal(materializeRevisionInserts(pool).length, 0);
});

test('invalid FDE names and symlinked user-space paths are rejected', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const params = {
    pool, actorId: 'admin-id', config: f.config, host: 'github.com',
    username: 'x-access-token', token: 'must-not-be-written',
  };
  await assert.rejects(
    setGitCredential({ ...params, fdeName: '../outside' }),
    (err) => err instanceof GitCredentialError && err.code === 'validation_failed' && err.details.field === 'fde_name',
  );
  assert.equal(pool.calls.length, 0);

  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.rmSync(f.home, { recursive: true });
  fs.symlinkSync(outside, f.home, 'dir');
  await assert.rejects(
    setGitCredential({ ...params, fdeName: 'alice' }),
    (err) => err instanceof GitCredentialError && err.code === 'credential_path_unsafe',
  );
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(pool.calls.length, 0);
});

test('credential inputs reject whitespace-only values and tokens above the length limit', async (t) => {
  const f = fixture(t);
  const pool = recordingPool();
  const common = { pool, config: f.config, fdeName: 'alice', host: 'github.com' };
  await assert.rejects(
    setGitCredential({ ...common, username: '  ', token: 'valid-token' }),
    (err) => err instanceof GitCredentialError && err.details.field === 'username',
  );
  await assert.rejects(
    setGitCredential({ ...common, username: 'alice', token: ' '.repeat(2) }),
    (err) => err instanceof GitCredentialError && err.details.field === 'token',
  );
  await assert.rejects(
    setGitCredential({ ...common, username: 'alice', token: 't'.repeat(4097) }),
    (err) => err instanceof GitCredentialError && err.details.field === 'token',
  );
  assert.equal(pool.calls.length, 0);
});

test('materializer stale cleanup never removes the out-of-manifest credential file', async (t) => {
  const f = fixture(t);
  const contents = 'https://x-access-token:secret-token@github.com\n';
  fs.writeFileSync(f.target, contents, { mode: 0o640 });
  const materializer = createMaterializer({
    root: f.root, uid: SELF_UID, gid: SELF_GID, log: { warn() {} },
  });
  await materializer.materialize({
    fdeName: 'alice',
    baseDomain: 'example.test',
    llmBaseUrl: 'https://llm.example.test/v1',
    allocations: [],
    generation: 1,
    prevManifest: {
      files: {
        '/home/erix/.git-credentials': { sha256: 'stale', revision: 1 },
      },
    },
  });
  assert.equal(fs.readFileSync(f.target, 'utf8'), contents);
});

test('admin HTTP endpoints require admin auth and never echo the submitted token', async (t) => {
  const f = fixture(t);
  const pool = new FakePool({ users: [ADMIN, FDE_USER] });
  const adminToken = 'git-credential-admin-session';
  const fdeToken = 'git-credential-fde-session';
  for (const [id, token] of [[ADMIN.id, adminToken], [FDE_USER.id, fdeToken]]) {
    pool.sessions.push({
      id: `session-${id}`,
      user_id: id,
      token_hash: auth.hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      last_seen_at: new Date(),
      revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('git-credential-test', 600),
    sessionTtlSeconds: 600,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100,
    },
    kdfConcurrency: 1,
    kdfQueueLimit: 10,
    kdfQueueTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024,
    userSpaceRoot: f.root,
    fdeUid: SELF_UID,
    fdeGid: SELF_GID,
  };
  const server = createServer({ pool, config, log: { error() {}, warn() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const endpoint = `${base}/api/admin/fdes/alice/git-credential`;
  const adminCookie = `${config.cookie.name}=${adminToken}`;
  const fdeCookie = `${config.cookie.name}=${fdeToken}`;

  assert.equal((await fetch(endpoint)).status, 401);
  assert.equal((await fetch(endpoint, { headers: { cookie: fdeCookie } })).status, 403);
  const token = 'ghp-http-secret-value';
  const invalidHost = await fetch(endpoint, {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com/path', username: 'x-access-token', token }),
  });
  assert.equal(invalidHost.status, 400);
  const emptyToken = await fetch(endpoint, {
    method: 'PUT',
    headers: { cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com', username: 'x-access-token', token: '' }),
  });
  assert.equal(emptyToken.status, 400);
  const set = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      cookie: adminCookie,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ host: 'github.com', username: 'x-access-token', token }),
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.deepEqual(setBody, { host: 'github.com', username: 'x-access-token', configured: true });
  assert.ok(!JSON.stringify(setBody).includes(token));

  const get = await fetch(endpoint, { headers: { cookie: adminCookie } });
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.deepEqual(getBody, {
    hosts: [{ host: 'github.com', protocol: 'https', username: 'x-access-token', token: '****alue' }],
  });
  assert.ok(!JSON.stringify(getBody).includes(token));

  const remove = await fetch(`${endpoint}?host=github.com`, {
    method: 'DELETE',
    headers: { cookie: adminCookie },
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), { host: 'github.com', deleted: true });
  assert.ok(pool.audit.every((entry) => !entry.details.includes(token)));
});

test('FDE self-service credentials use login ownership, write atomically, and never store or echo plaintext token', async (t) => {
  const f = fixture(t);
  const noFdeUser = {
    ...ADMIN,
    id: 'c0000000-0000-4000-8000-000000000003',
    login: 'unassigned',
    role: 'fde',
  };
  const pool = new FakePool({ users: [FDE_USER, noFdeUser] });
  const calls = [];
  const query = pool.query.bind(pool);
  pool.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === 'SELECT base_url, provider FROM git_hosts') {
      return { rows: [{ base_url: 'http://github.com', provider: 'github' }] };
    }
    return query(sql, params);
  };
  const fdeToken = 'git-credential-self-session';
  const unassignedToken = 'git-credential-unassigned-session';
  for (const [id, token] of [[FDE_USER.id, fdeToken], [noFdeUser.id, unassignedToken]]) {
    pool.sessions.push({
      id: `session-${id}`,
      user_id: id,
      token_hash: auth.hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      last_seen_at: new Date(),
      revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('git-credential-self', 600),
    sessionTtlSeconds: 600,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100,
    },
    kdfConcurrency: 1,
    kdfQueueLimit: 10,
    kdfQueueTimeoutMs: 1000,
    maxBodyBytes: 64 * 1024,
    userSpaceRoot: f.root,
    fdeUid: SELF_UID,
    fdeGid: SELF_GID,
  };
  const server = createServer({ pool, config, log: { error() {}, warn() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/me/git-credential`;
  const cookie = (token) => `${config.cookie.name}=${token}`;

  assert.equal((await fetch(endpoint)).status, 401);
  const noFde = await fetch(endpoint, { headers: { cookie: cookie(unassignedToken) } });
  assert.equal(noFde.status, 400);
  assert.deepEqual((await noFde.json()).error, {
    code: 'fde_name_required',
    message: '当前用户未分配 fde_name，无法管理 Git 凭据',
    retryable: false,
  });

  const initial = await fetch(endpoint, { headers: { cookie: cookie(fdeToken) } });
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { items: [] });

  const secret = 'github-pat-self-service-super-secret';
  const set = await fetch(endpoint, {
    method: 'PUT',
    headers: { cookie: cookie(fdeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com', username: 'alice-token', token: secret }),
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.deepEqual(setBody, { host: 'github.com', username: 'alice-token', configured: true });
  assert.ok(!JSON.stringify(setBody).includes(secret));
  assert.equal(fs.statSync(f.target).mode & 0o777, 0o640);
  // 测试名声称「use login ownership」，此处真的锤一下属主（跟 config.fdeUid，非特权环境下即登录身份）。
  assert.equal(fs.statSync(f.target).uid, SELF_UID, 'FDE 自助写入的凭据文件必须属于该 FDE 的属主');
  assert.equal(fs.statSync(f.target).gid, SELF_GID, 'FDE 自助写入的凭据文件必须属于该 FDE 的属组');
  let initialContents = fs.readFileSync(f.target, 'utf8');
  assert.ok(initialContents.startsWith('http://alice-token:'));
  assert.ok(initialContents.includes(secret));
  assert.deepEqual(fs.readdirSync(f.home), ['.config', '.git-credentials'], 'atomic rename leaves no temporary file');

  const get = await fetch(endpoint, { headers: { cookie: cookie(fdeToken) } });
  assert.equal(get.status, 200);
  const getBody = await get.json();
  assert.deepEqual(getBody, {
    items: [{ host: 'github.com', protocol: 'http', username: 'alice-token', token: '****cret' }],
  });
  assert.ok(!JSON.stringify(getBody).includes(secret));

  const override = await fetch(endpoint, {
    method: 'PUT',
    headers: { cookie: cookie(fdeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com', username: 'alice-token', token: secret, protocol: 'https' }),
  });
  assert.equal(override.status, 200);
  initialContents = fs.readFileSync(f.target, 'utf8');
  assert.ok(initialContents.startsWith('https://alice-token:'));

  const invalidProtocol = await fetch(endpoint, {
    method: 'PUT',
    headers: { cookie: cookie(fdeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com', username: 'alice-token', token: secret, protocol: 'ftp' }),
  });
  assert.equal(invalidProtocol.status, 400);
  assert.deepEqual((await invalidProtocol.json()).error, {
    code: 'validation_failed',
    message: 'protocol 必须是 http 或 https',
    retryable: false,
    details: { field: 'protocol' },
  });
  assert.equal(fs.readFileSync(f.target, 'utf8'), initialContents);

  const originalRename = fs.renameSync;
  fs.renameSync = (from, to, ...args) => {
    if (to === f.target) throw new Error('injected rename failure');
    return originalRename(from, to, ...args);
  };
  try {
    const failedReplace = await fetch(endpoint, {
      method: 'PUT',
      headers: { cookie: cookie(fdeToken), 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'github.com', username: 'alice-token', token: 'replacement-secret' }),
    });
    assert.equal(failedReplace.status, 500);
    assert.ok(!(await failedReplace.text()).includes('replacement-secret'));
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(f.target, 'utf8'), initialContents, 'failed rename preserves old credential');
  assert.deepEqual(fs.readdirSync(f.home), ['.config', '.git-credentials']);

  const deleteResponse = await fetch(endpoint, {
    method: 'DELETE',
    headers: { cookie: cookie(fdeToken), 'content-type': 'application/json' },
    body: JSON.stringify({ host: 'github.com' }),
  });
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { host: 'github.com', deleted: true });

  for (const call of calls) {
    // ⚠ 本例的假库把 `github.com` 建模成**未在 `git_hosts` 注册**（无分配账号行），所以 issue #395 的
    //   明文副本写入不会发生，此处「明文不进 DB 参数」成立。它在生产里的完整契约是
    //   「除 `fde_git_accounts.token` 一列外哪儿都不能有」（见本文件 `assertNoTokenInDbCalls` 与
    //   下方 #395 用例）——不要把本例当成那条全局契约的证人。
    assert.ok(!JSON.stringify(call.params).includes(secret), 'plaintext token must not reach DB parameters');
    assert.ok(!JSON.stringify(call.params).includes('replacement-secret'), 'failed-write token must not reach DB parameters');
  }
  assert.ok(pool.audit.every((entry) => !entry.details.includes(secret)));
});

// ---------------------------------------------------------------------------
// issue #395：明文 token 落库（`fde_git_accounts.token`）
//
// 起因（现网 2026-10-25）：minted 模式铸出的明文只投放到 `~/.git-credentials` 就丢弃，库里
// `token_ref` 只是远端 token ID。FDE `eric` 的 agent 整文件重写该文件，gitea 那行消失——平台作为
// 铸币方既无副本、也不会自愈（存在性判据是 `token_ref` 非空）。以下用例钉住修好的那半边：
// ① 投放即留副本；② 删除必须清副本（否则自愈会把用户刚删的凭据投回去）；③ 副本只住那一列。
// ---------------------------------------------------------------------------

/**
 * 建模 `fde_git_accounts` 的有状态假库（#395）。按 SQL 文本真筛，不做"来者不拒返回空"的
 * 安慰剂 fake（AGENTS §8.14）。`registered=false` = host 不在 `git_hosts` 里（FDE 自己配的
 * github.com 这类），此时一条副本都不该写。
 */
function tokenReplicaPool({ baseUrl = 'https://git.erix.vip', registered = true } = {}) {
  const calls = [];
  const state = { token: null, remoteLogin: null, userStatus: 'awaiting_credential' };
  const accountRows = registered ? [{ fde_id: 'fde-1', git_host_id: 'host-1', base_url: baseUrl }] : [];
  const run = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql === 'SELECT base_url, provider FROM git_hosts') {
      return { rows: registered ? [{ base_url: baseUrl, provider: 'gitea' }] : [] };
    }
    if (sql.includes('a.fde_id, a.git_host_id')) return { rows: accountRows };
    if (/UPDATE fde_git_accounts/i.test(sql) && /\bSET token\b/i.test(sql)) {
      state.token = params[2];
      return { rowCount: accountRows.length };
    }
    if (sql.includes('UPDATE fde_git_accounts')) {
      state.remoteLogin = params[2];
      return { rows: [] };
    }
    if (sql.includes('SELECT u.id AS fde_id')) return { rows: accountRows };
    if (sql.includes('UPDATE users SET status')) {
      state.userStatus = params[1];
      return { rows: [{ id: params[0] }] };
    }
    if (sql.includes('INSERT INTO materialize_revisions')) return { rows: [{ revision: 2 }] };
    return { rows: [] };
  };
  const pool = {
    calls,
    state,
    query: run,
    async connect() {
      return { query: run, release() {} };
    },
  };
  return pool;
}

test('#395 投放凭据把明文写进 fde_git_accounts.token，且与审计/状态翻转同事务', async (t) => {
  const f = fixture(t);
  const pool = tokenReplicaPool();
  const secret = 'gitea-minted-secret-7788';
  await setGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice',
    host: 'git.erix.vip', username: 'eric', token: secret,
  });

  assert.equal(pool.state.token, secret, '平台必须持有明文副本，否则文件一丢就无从重投');
  assert.equal(pool.state.remoteLogin, 'eric');
  assert.equal(pool.state.userStatus, 'active');

  const writes = tokenColumnWrites(pool);
  assert.equal(writes.length, 1, '一次投放只写一次副本列');
  const begin = pool.calls.findIndex((call) => call.sql === 'BEGIN');
  const commit = pool.calls.findIndex((call) => call.sql === 'COMMIT');
  const tokenIdx = pool.calls.indexOf(writes[0]);
  assert.ok(begin >= 0 && begin < tokenIdx && tokenIdx < commit, '副本写入必须与审计/状态翻转同事务（分开提交会出现"库里有副本但用户还挂在 awaiting_credential"）');

  // 副本只住那一列：审计的 details 里只有 host/fde_name，没有明文。
  const audits = pool.calls.filter((call) => call.sql.includes('INSERT INTO audit_log'));
  assert.ok(audits.length >= 1);
  for (const audit of audits) {
    assert.ok(!JSON.stringify(audit.params).includes(secret), 'audit_log 不得记明文（历史上它只记 host/username）');
  }
  assertNoTokenInDbCalls(pool, secret);

  // 出参面不变：列表端点仍是掩码。
  const listed = await listGitCredentials({ config: f.config, fdeName: 'alice' });
  assert.deepEqual(listed.hosts.map((h) => h.token), ['****7788']);
  assert.ok(!JSON.stringify(listed).includes(secret));
});

test('#395 删除凭据必须把库里的副本一起置 NULL（否则自愈会把刚删掉的凭据投回去）', async (t) => {
  const f = fixture(t);
  const pool = tokenReplicaPool();
  const secret = 'gitea-to-be-deleted-1122';
  await setGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice',
    host: 'git.erix.vip', username: 'eric', token: secret,
  });
  assert.equal(pool.state.token, secret);

  const result = await deleteGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice', host: 'git.erix.vip',
  });
  assert.equal(result.deleted, true);
  assert.equal(pool.state.token, null, '文件里的凭据删了，库里的副本必须同步消失');
  assert.equal(pool.state.userStatus, 'awaiting_credential');
});

test('#395 轮换（同 host 再投一次）覆盖旧副本而不是留着旧的', async (t) => {
  const f = fixture(t);
  const pool = tokenReplicaPool();
  const common = { pool, actorId: 'admin-id', config: f.config, fdeName: 'alice', host: 'git.erix.vip', username: 'eric' };
  await setGitCredential({ ...common, token: 'old-minted-aaaa' });
  await setGitCredential({ ...common, token: 'new-minted-bbbb' });
  assert.equal(pool.state.token, 'new-minted-bbbb');
  assert.equal(tokenColumnWrites(pool).length, 2, '两次投放各写一次');
  // 文件侧同 host 只留一行（既有契约），副本侧 likewise 只有一个值。
  const lines = fs.readFileSync(f.target, 'utf8').trimEnd().split('\n');
  assert.equal(lines.filter((line) => line.includes('@git.erix.vip')).length, 1);
  assertNoTokenInDbCalls(pool, 'old-minted-aaaa', 'new-minted-bbbb');
});

test('#395 host 未在 git_hosts 注册 ⇒ 一条副本都不写，但审计不丢、不报错', async (t) => {
  const f = fixture(t);
  const pool = tokenReplicaPool({ registered: false });
  const secret = 'self-configured-github-pat';
  const result = await setGitCredential({
    pool, actorId: 'admin-id', config: f.config, fdeName: 'alice',
    host: 'github.com', username: 'x-access-token', token: secret,
  });
  assert.equal(result.configured, true, '未注册 host 照常投放文件（FDE 自己配的 github 凭据也走这条端点）');
  assert.equal(tokenColumnWrites(pool).length, 0, '平台不知道这枚 token 属于哪个受管账号 ⇒ 不凭空造副本');
  assert.equal(pool.state.token, null);
  assert.ok(pool.calls.some((call) => call.sql.includes('INSERT INTO audit_log')));
  assertNoTokenInDbCalls(pool, secret);
});
