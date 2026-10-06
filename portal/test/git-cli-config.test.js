import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import {
  deleteGitCredential,
  removeGitCredentialFile,
  setGitCredential,
} from '../src/git-credential.js';

const UID = 1000;
const GID = 1000;
const WORKER_UID = 1002;
const CONFIG_PATHS = {
  gitea: ['.config', 'tea', 'config.yml'],
  github: ['.config', 'gh', 'hosts.yml'],
  gitlab: ['.config', 'glab-cli', 'config.yml'],
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-git-cli-config-'));
  const homeDir = path.join(root, 'alice', 'home');
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o2770 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    homeDir,
    config: { userSpaceRoot: root, fdeUid: UID, fdeGid: GID, workerUid: WORKER_UID },
  };
}

function makePool(gitHosts) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'SELECT base_url, provider FROM git_hosts') return { rows: gitHosts };
      return { rows: [] };
    },
  };
}

function cliPath(homeDir, provider) {
  return path.join(homeDir, ...CONFIG_PATHS[provider]);
}

function captureWorkerChown(t) {
  const requests = [];
  // Rootless test hosts cannot chown to the worker UID; capture the requested owner instead.
  if (process.getuid() !== 0 && (process.getuid() !== WORKER_UID || process.getgid() !== GID)) {
    const fchownSync = fs.fchownSync;
    t.mock.method(fs, 'fchownSync', (fd, uid, gid) => {
      if (uid === WORKER_UID && gid === GID) {
        requests.push({ uid, gid });
        return;
      }
      return fchownSync(fd, uid, gid);
    });
  }
  return requests;
}

function assertCliFile(filePath, provider, workerChownRequests = []) {
  const stat = fs.statSync(filePath);
  assert.equal(stat.mode & 0o777, provider === 'gitlab' ? 0o600 : 0o640);
  if (provider === 'gitlab' && workerChownRequests.length > 0) {
    assert.ok(workerChownRequests.some(({ uid, gid }) => uid === WORKER_UID && gid === GID));
    assert.equal(stat.uid, process.getuid());
  } else {
    assert.equal(stat.uid, provider === 'gitlab' ? WORKER_UID : UID);
  }
  assert.equal(stat.gid, GID);
}

function assertFdeDirectory(dirPath) {
  const stat = fs.statSync(dirPath);
  assert.equal(stat.mode & 0o777, 0o750);
  assert.equal(stat.uid, UID);
  assert.equal(stat.gid, GID);
}

function hostConfig(provider, host, username, token) {
  if (provider === 'gitea') {
    return {
      logins: [{
        name: host,
        url: `https://${host}`,
        token,
        user: username,
      }],
    };
  }
  if (provider === 'github') {
    return {
      [host]: {
        user: username,
        oauth_token: token,
        users: { [username]: { oauth_token: token } },
      },
    };
  }
  return { hosts: { [host]: { token, user: username } } };
}

test('set writes escaped provider-specific YAML with FDE ownership and permissions', async (t) => {
  const f = fixture(t);
  const workerChownRequests = captureWorkerChown(t);
  const hosts = [
    { base_url: 'https://gitea.example.test', provider: 'gitea' },
    { base_url: 'https://github.example.test', provider: 'github' },
    { base_url: 'https://gitlab.example.test', provider: 'gitlab' },
  ];
  const pool = makePool(hosts);
  const username = 'fde: "alice" #1';
  const token = 'pat: "special" # [value]';

  for (const { base_url: baseUrl, provider } of hosts) {
    const host = new URL(baseUrl).host;
    await setGitCredential({
      pool, config: f.config, fdeName: 'alice', host, username, token,
    });

    const file = cliPath(f.homeDir, provider);
    assert.ok(fs.existsSync(file), `${provider} config is written to its documented location`);
    assert.deepEqual(parse(fs.readFileSync(file, 'utf8')), hostConfig(provider, host, username, token));
    assertCliFile(file, provider, workerChownRequests);
    assertFdeDirectory(path.join(f.homeDir, '.config'));
    assertFdeDirectory(path.dirname(file));
  }

  assert.ok(fs.readFileSync(path.join(f.homeDir, '.git-credentials'), 'utf8').includes(encodeURIComponent(token)));
  for (const call of pool.calls) assert.ok(!JSON.stringify(call.params).includes(token));
});

test('set upserts each provider host on rotation and delete removes only that host', async (t) => {
  const f = fixture(t);
  const workerChownRequests = captureWorkerChown(t);
  const hosts = [
    { provider: 'gitea', first: 'gitea-one.example.test', second: 'gitea-two.example.test' },
    { provider: 'github', first: 'github-one.example.test', second: 'github-two.example.test' },
    { provider: 'gitlab', first: 'gitlab-one.example.test', second: 'gitlab-two.example.test' },
  ];
  const rows = hosts.flatMap(({ provider, first, second }) => [
    { base_url: `https://${first}`, provider },
    { base_url: `https://${second}`, provider },
  ]);
  const pool = makePool(rows);
  const common = { pool, config: f.config, fdeName: 'alice', username: 'alice' };

  for (const { first, second } of hosts) {
    await setGitCredential({ ...common, host: first, token: `old-${first}` });
    await setGitCredential({ ...common, host: second, token: `keep-${second}` });
    await setGitCredential({ ...common, host: first, token: `rotated-${first}` });

    const provider = hosts.find((entry) => entry.first === first).provider;
    const file = cliPath(f.homeDir, provider);
    assertCliFile(file, provider, workerChownRequests);
    const document = parse(fs.readFileSync(file, 'utf8'));
    if (provider === 'gitea') {
      assert.equal(document.logins.length, 2);
      assert.equal(document.logins.find((login) => login.url.endsWith(first)).token, `rotated-${first}`);
      assert.equal(document.logins.find((login) => login.url.endsWith(second)).token, `keep-${second}`);
    } else if (provider === 'github') {
      assert.equal(Object.keys(document).length, 2);
      assert.equal(document[first].users.alice.oauth_token, `rotated-${first}`);
      assert.equal(document[second].users.alice.oauth_token, `keep-${second}`);
    } else {
      assert.equal(Object.keys(document.hosts).length, 2);
      assert.equal(document.hosts[first].token, `rotated-${first}`);
      assert.equal(document.hosts[second].token, `keep-${second}`);
    }

    assert.deepEqual(await deleteGitCredential({ ...common, host: first }), { host: first, deleted: true });
    assertCliFile(file, provider, workerChownRequests);
    const afterDelete = parse(fs.readFileSync(file, 'utf8'));
    if (provider === 'gitea') {
      assert.deepEqual(afterDelete.logins.map((login) => login.url), [`https://${second}`]);
    } else if (provider === 'github') {
      assert.deepEqual(Object.keys(afterDelete), [second]);
    } else {
      assert.deepEqual(Object.keys(afterDelete.hosts), [second]);
    }
  }
});

test('unregistered hosts and providers without a supported CLI only write git credentials', async (t) => {
  const f = fixture(t);
  const pool = makePool([{ base_url: 'https://azure.example.test', provider: 'azure' }]);

  await setGitCredential({
    pool, config: f.config, fdeName: 'alice',
    host: 'unregistered.example.test', username: 'alice', token: 'fake-unregistered-token',
  });
  await setGitCredential({
    pool, config: f.config, fdeName: 'alice',
    host: 'azure.example.test', username: 'alice', token: 'fake-azure-token',
  });

  assert.ok(fs.existsSync(path.join(f.homeDir, '.git-credentials')));
  assert.equal(fs.existsSync(path.join(f.homeDir, '.config')), false);
});

test('symlinked CLI config directories are rejected without writing outside the FDE home', async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.homeDir, '.config'), 'dir');
  const pool = makePool([{ base_url: 'https://gitea.example.test', provider: 'gitea' }]);
  const token = 'fake-path-guard-token';

  await assert.rejects(
    setGitCredential({
      pool, config: f.config, fdeName: 'alice',
      host: 'gitea.example.test', username: 'alice', token,
    }),
    (err) => {
      assert.ok(!err.message.includes(token));
      return true;
    },
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('offboarding removes all CLI configs, including when git credentials are already absent', async (t) => {
  const f = fixture(t);
  captureWorkerChown(t);
  const hosts = [
    { base_url: 'https://gitea.example.test', provider: 'gitea' },
    { base_url: 'https://github.example.test', provider: 'github' },
    { base_url: 'https://gitlab.example.test', provider: 'gitlab' },
  ];
  const pool = makePool(hosts);
  for (const { base_url: baseUrl } of hosts) {
    await setGitCredential({
      pool,
      config: f.config,
      fdeName: 'alice',
      host: new URL(baseUrl).host,
      username: 'alice',
      token: 'fake-offboarding-token',
    });
  }

  assert.equal(removeGitCredentialFile({ config: f.config, fdeName: 'alice' }), true);
  for (const provider of Object.keys(CONFIG_PATHS)) {
    assert.equal(fs.existsSync(cliPath(f.homeDir, provider)), false);
  }

  for (const provider of Object.keys(CONFIG_PATHS)) {
    const file = cliPath(f.homeDir, provider);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
    fs.writeFileSync(file, stringify(hostConfig(provider, 'stale.example.test', 'alice', 'fake-stale-token')));
  }
  assert.equal(removeGitCredentialFile({ config: f.config, fdeName: 'alice' }), false);
  for (const provider of Object.keys(CONFIG_PATHS)) {
    assert.equal(fs.existsSync(cliPath(f.homeDir, provider)), false);
  }
  fs.rmSync(path.join(f.homeDir, '.config'), { recursive: true, force: true });
  assert.equal(removeGitCredentialFile({ config: f.config, fdeName: 'alice' }), false);
});
