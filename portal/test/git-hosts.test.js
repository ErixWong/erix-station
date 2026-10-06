import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGitHost,
  deleteGitHost,
  GitHostError,
  listGitHosts,
  updateGitHost,
} from '../src/git-hosts.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const ID = '00000000-0000-4000-8000-000000000118';
const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const FDE_ID = '00000000-0000-4000-8000-000000000002';
const ADMIN_TOKEN = 'git-host-admin-session';
const FDE_TOKEN = 'git-host-fde-session';

class GitHostPool {
  constructor() {
    this.hosts = [];
    this.accounts = [];
    this.calls = [];
  }

  async query(sql, params = []) {
    this.calls.push({ sql, params });
    if (sql.includes('FROM git_hosts ORDER BY name')) return { rows: [...this.hosts] };
    if (sql.includes('INSERT INTO git_hosts')) {
      const [name, provider, base_url, admin_key, mode, enabled] = params;
      const row = {
        id: `host-${this.hosts.length + 1}`, name, provider, base_url, admin_key, mode, enabled,
        created_at: new Date(), updated_at: new Date(),
      };
      this.hosts.push(row);
      return { rows: [row] };
    }
    if (sql.startsWith('DELETE FROM git_hosts')) {
      const i = this.hosts.findIndex((host) => host.id === params[0]);
      if (i < 0) return { rows: [] };
      const [row] = this.hosts.splice(i, 1);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('SELECT 1 FROM fde_git_accounts')) {
      return { rows: this.accounts.some((account) => account.git_host_id === params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.includes('FROM git_hosts WHERE id')) {
      return { rows: this.hosts.filter((host) => host.id === params[0]) };
    }
    if (sql.includes('UPDATE git_hosts')) {
      const [id, name, provider, base_url, admin_key, mode, enabled] = params;
      const row = this.hosts.find((host) => host.id === id);
      if (!row) return { rows: [] };
      Object.assign(row, { name, provider, base_url, admin_key, mode, enabled, updated_at: new Date() });
      return { rows: [row] };
    }
    return { rows: [] };
  }
}

class HttpGitHostPool extends FakePool {
  constructor() {
    super({
      users: [
        { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
        { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
      ],
    });
    this.hosts = [];
    this.accounts = [];
  }

  async query(sql, params = []) {
    if (sql.includes('FROM git_hosts ORDER BY name')) return { rows: [...this.hosts] };
    if (sql.includes('INSERT INTO git_hosts')) {
      const [name, provider, base_url, admin_key, mode, enabled] = params;
      const row = { id: ID, name, provider, base_url, admin_key, mode, enabled };
      this.hosts.push(row);
      return { rows: [row] };
    }
    if (sql.includes('SELECT 1 FROM fde_git_accounts')) {
      return { rows: this.accounts.some((account) => account.git_host_id === params[0]) ? [{ '?column?': 1 }] : [] };
    }
    if (sql.startsWith('DELETE FROM git_hosts')) {
      const index = this.hosts.findIndex((host) => host.id === params[0]);
      if (index < 0) return { rows: [] };
      this.hosts.splice(index, 1);
      return { rows: [{ id: params[0] }] };
    }
    if (sql.includes('FROM git_hosts WHERE id')) {
      return { rows: this.hosts.filter((host) => host.id === params[0]) };
    }
    if (sql.startsWith('UPDATE git_hosts')) {
      const [id, name, provider, base_url, admin_key, mode, enabled] = params;
      const row = this.hosts.find((host) => host.id === id);
      if (!row) return { rows: [] };
      Object.assign(row, { name, provider, base_url, admin_key, mode, enabled });
      return { rows: [row] };
    }
    return super.query(sql, params);
  }
}

async function startHttpServer() {
  const config = {
    cookie: cookieSettings('git-host-test', 600),
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
    staticDir: process.cwd(),
  };
  const pool = new HttpGitHostPool();
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`,
      user_id: id,
      token_hash: hashToken(token),
      created_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
      last_seen_at: new Date(),
      revoked_at: null,
    });
  }
  const server = createServer({ pool, config, log: { error() {}, warn() {} } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    pool,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('Git host CRUD derives mode, returns a key mask, and never echoes the admin key', async () => {
  const pool = new GitHostPool();
  const secret = 'gitea-admin-secret-7392';
  const created = await createGitHost(pool, {
    name: 'Internal Gitea',
    provider: 'gitea',
    base_url: 'https://git.example.test/',
    admin_key: secret,
  });
  assert.equal(created.mode, 'minted');
  assert.equal(created.base_url, 'https://git.example.test');
  assert.equal(created.admin_key, '****7392');
  assert.equal(created.admin_key_configured, true);
  assert.ok(!JSON.stringify(created).includes(secret));

  const list = await listGitHosts(pool);
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].admin_key, '****7392');
  assert.ok(!JSON.stringify(list).includes(secret));

  const updated = await updateGitHost(pool, 'host-1', { enabled: false });
  assert.equal(updated.enabled, false);
  assert.equal(updated.admin_key_configured, true, 'omitted key preserves existing key');
  assert.ok(!JSON.stringify(updated).includes(secret));

  const gitlab = await createGitHost(pool, {
    name: 'Internal GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.test',
  });
  assert.equal(gitlab.mode, 'per_fde_pat');
  assert.equal(gitlab.admin_key, null);
  assert.equal(gitlab.admin_key_configured, false);
});

test('Git host validation rejects Azure and GitHub, invalid URLs, and client-selected mode', async () => {
  const pool = new GitHostPool();
  await assert.rejects(
    createGitHost(pool, { name: 'Azure', provider: 'azure', base_url: 'https://dev.azure.com' }),
    (err) => err instanceof GitHostError && err.code === 'provider_unsupported' && err.httpStatus === 400,
  );
  await assert.rejects(
    createGitHost(pool, { name: 'GitHub', provider: 'github', base_url: 'https://github.com' }),
    (err) => {
      assert.ok(err instanceof GitHostError);
      assert.equal(err.code, 'provider_unsupported');
      assert.equal(err.httpStatus, 400);
      assert.deepEqual(err.details, { field: 'provider' });
      assert.match(err.message, /github.*暂不支持.*企业内部场景.*gitea\/gitlab.*代铸/);
      return true;
    },
  );
  await assert.rejects(
    createGitHost(pool, { name: 'Bad URL', provider: 'gitea', base_url: 'https://user:pass@git.example.test' }),
    (err) => err instanceof GitHostError && err.code === 'validation_failed' && err.details.field === 'base_url',
  );
  await assert.rejects(
    createGitHost(pool, { name: 'Bad object', provider: 'gitea', base_url: 'https://git.example.test', mode: 'minted' }),
    (err) => err instanceof GitHostError && err.code === 'validation_failed',
  );

  const host = await createGitHost(pool, {
    name: 'Gitea',
    provider: 'gitea',
    base_url: 'https://git.example.test',
    admin_key: 'valid-secret',
  });
  await assert.rejects(
    updateGitHost(pool, host.id, { provider: 'github' }),
    (err) => err instanceof GitHostError
      && err.code === 'provider_unsupported'
      && err.httpStatus === 400
      && err.details.field === 'provider',
  );

  pool.hosts.push({
    id: 'legacy-github',
    name: 'Legacy GitHub',
    provider: 'github',
    base_url: 'https://github.com',
    admin_key: null,
    mode: 'per_fde_pat',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const legacyUpdated = await updateGitHost(pool, 'legacy-github', {
    name: 'Legacy GitHub retained',
    provider: 'github',
    enabled: false,
  });
  assert.equal(legacyUpdated.provider, 'github');
  assert.equal(legacyUpdated.name, 'Legacy GitHub retained');
  assert.equal(legacyUpdated.enabled, false);

  await assert.rejects(
    updateGitHost(pool, host.id, { clear_admin_key: true, admin_key: 'new-secret' }),
    (err) => err instanceof GitHostError && err.code === 'validation_failed',
  );
  const cleared = await updateGitHost(pool, host.id, { clear_admin_key: true });
  assert.equal(cleared.mode, 'per_fde_pat');
  assert.equal(cleared.admin_key, null);
});

test('Git host delete refuses referenced hosts and reports missing ids', async () => {
  const pool = new GitHostPool();
  const host = await createGitHost(pool, {
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.test',
  });
  pool.accounts.push({ fde_id: 'fde-1', git_host_id: host.id });
  await assert.rejects(
    deleteGitHost(pool, host.id),
    (err) => err instanceof GitHostError && err.code === 'host_in_use' && err.httpStatus === 409,
  );
  pool.accounts = [];
  await deleteGitHost(pool, host.id);
  assert.equal(pool.hosts.length, 0);
  await assert.rejects(
    deleteGitHost(pool, ID),
    (err) => err instanceof GitHostError && err.code === 'not_found' && err.httpStatus === 404,
  );
});

test('admin Git host HTTP routes enforce requireAdmin and bind GET/POST/PATCH/DELETE', async () => {
  const { base, pool, adminCookie, fdeCookie, close } = await startHttpServer();
  try {
    const collection = `${base}/api/admin/git-hosts`;
    assert.equal((await fetch(collection)).status, 401);
    assert.equal((await fetch(collection, { headers: { cookie: fdeCookie } })).status, 403);
    assert.deepEqual(await (await fetch(collection, { headers: { cookie: adminCookie } })).json(), { items: [] });

    let response = await fetch(collection, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'GitHub',
        provider: 'github',
        base_url: 'https://github.com',
      }),
    });
    assert.equal(response.status, 400);
    const githubError = await response.json();
    assert.equal(githubError.error.code, 'provider_unsupported');
    assert.deepEqual(githubError.error.details, { field: 'provider' });
    assert.match(githubError.error.message, /github.*暂不支持.*企业内部场景.*gitea\/gitlab.*代铸/);
    assert.equal(pool.hosts.length, 0);

    const secret = 'never-return-this-git-host-key';
    response = await fetch(collection, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Gitea',
        provider: 'gitea',
        base_url: 'https://git.example.test',
        admin_key: secret,
      }),
    });
    assert.equal(response.status, 201);
    let body = await response.text();
    assert.ok(!body.includes(secret));
    assert.ok(body.includes('****-key'));

    response = await fetch(`${collection}/${ID}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).host.enabled, false);

    response = await fetch(`${collection}/${ID}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(response.status, 204);
    assert.equal(pool.hosts.length, 0);

    response = await fetch(collection, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'GitLab',
        provider: 'gitlab',
        base_url: 'https://gitlab.example.test',
      }),
    });
    assert.equal(response.status, 201);
    response = await fetch(`${collection}/${ID}`, { method: 'DELETE', headers: { cookie: adminCookie } });
    assert.equal(response.status, 204);
    assert.equal(pool.hosts.length, 0);
  } finally {
    await close();
  }
});
