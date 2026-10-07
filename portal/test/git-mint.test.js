import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  GitMintError,
  mintGitAccount,
  mintGiteaAccount,
  mintGitlabAccount,
} from '../src/git-mint.js';

async function withServer(handler, run) {
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (chunk) => { text += chunk; });
    req.on('end', () => handler(req, res, text));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('Gitea creates FDE user and a repository-creation/push/PR token using the generated user password', async () => {
  const calls = [];
  await withServer((req, res, text) => {
    calls.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : null });
    if (req.url === '/api/v1/admin/users' && req.method === 'POST') {
      assert.match(calls[0].auth, /^token gitea-admin-key$/);
      assert.equal(calls[0].body.username, 'alice');
      assert.ok(calls[0].body.password.length >= 32);
      assert.match(calls[0].body.email, /@users\.invalid$/);
      return json(res, 201, { login: 'alice' });
    }
    if (req.url === '/api/v1/users/alice/tokens' && req.method === 'POST') {
      assert.match(calls[1].auth, /^Basic /);
      assert.deepEqual(calls[1].body.scopes, ['write:user', 'write:repository', 'read:issue']);
      const credentials = Buffer.from(calls[1].auth.slice('Basic '.length), 'base64').toString();
      assert.equal(credentials.split(':')[0], 'alice');
      return json(res, 201, { id: 42, sha1: 'gitea-token-secret' });
    }
    res.writeHead(404).end();
  }, async (baseUrl) => {
    const result = await mintGiteaAccount({ baseUrl, adminKey: 'gitea-admin-key', login: 'alice' });
    assert.deepEqual(result, {
      remoteLogin: 'alice',
      tokenRef: '42',
      tokenPlaintext: 'gitea-token-secret',
    });
  });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/admin/users',
    'POST /api/v1/users/alice/tokens',
  ]);
});

test('GitLab creates FDE user and a write_repository-only impersonation token', async () => {
  const calls = [];
  await withServer((req, res, text) => {
    calls.push({ method: req.method, path: req.url, token: req.headers['private-token'], body: text ? JSON.parse(text) : null });
    if (req.url === '/api/v4/users' && req.method === 'POST') {
      assert.equal(calls[0].token, 'gitlab-admin-key');
      assert.equal(calls[0].body.username, 'bob');
      assert.ok(calls[0].body.password.length >= 32);
      return json(res, 201, { id: 77, username: 'bob' });
    }
    if (req.url === '/api/v4/users/77/impersonation_tokens' && req.method === 'POST') {
      assert.deepEqual(calls[1].body.scopes, ['write_repository']);
      return json(res, 201, { id: 93, token: 'gitlab-token-secret' });
    }
    res.writeHead(404).end();
  }, async (baseUrl) => {
    const result = await mintGitlabAccount({ baseUrl, adminKey: 'gitlab-admin-key', login: 'bob' });
    assert.deepEqual(result, {
      remoteLogin: 'bob',
      tokenRef: '93',
      tokenPlaintext: 'gitlab-token-secret',
    });
  });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v4/users',
    'POST /api/v4/users/77/impersonation_tokens',
  ]);
});

test('mint failures do not echo credentials and Gitea user creation is compensated', async () => {
  const adminKey = 'do-not-echo-this-admin-key';
  const requests = [];
  await withServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/v1/admin/users' && req.method === 'POST') return json(res, 201, { login: 'alice' });
    if (req.url === '/api/v1/users/alice/tokens') return json(res, 500, { message: adminKey });
    if (req.url === '/api/v1/admin/users/alice' && req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    res.writeHead(404).end();
  }, async (baseUrl) => {
    await assert.rejects(
      mintGiteaAccount({ baseUrl, adminKey, login: 'alice' }),
      (err) => err instanceof GitMintError && err.code === 'git_host_request_failed'
        && !err.message.includes(adminKey),
    );
  });
  assert.ok(requests.includes('DELETE /api/v1/admin/users/alice'));

  await withServer((req, res) => json(res, 401, { message: adminKey }), async (baseUrl) => {
    await assert.rejects(
      mintGitlabAccount({ baseUrl, adminKey, login: 'bob' }),
      (err) => err instanceof GitMintError && !err.message.includes(adminKey),
    );
  });
});

test('unsupported modes/providers fail explicitly; requests have an abort timeout', async () => {
  await assert.rejects(
    mintGitAccount({ provider: 'github', mode: 'per_fde_pat' }),
    (err) => err instanceof GitMintError && err.code === 'mint_unsupported',
  );
  await assert.rejects(
    mintGitAccount({ provider: 'azure', mode: 'minted' }),
    (err) => err instanceof GitMintError && err.code === 'mint_unsupported',
  );

  await withServer((req) => {
    req.on('close', () => {});
  }, async (baseUrl) => {
    await assert.rejects(
      mintGiteaAccount({ baseUrl, adminKey: 'secret', login: 'alice', timeoutMs: 20 }),
      (err) => err instanceof GitMintError && err.code === 'git_host_timeout',
    );
  });
});
