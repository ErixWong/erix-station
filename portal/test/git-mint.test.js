import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  GitMintError,
  mintGitAccount,
  mintGiteaAccount,
  mintGitlabAccount,
  disableGiteaAccount,
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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

async function assertGiteaReuse(loginName, expectedLoginName) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = {
      method: options.method,
      path: new URL(url).pathname,
      auth: options.headers.authorization,
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    if (call.method === 'POST' && call.path === '/api/v1/admin/users') {
      assert.match(call.auth, /^token gitea-admin-key$/);
      return jsonResponse(422, { message: 'user already exists' });
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice') {
      assert.match(call.auth, /^token gitea-admin-key$/);
      return jsonResponse(200, { id: 42, login: 'alice', login_name: loginName, source_id: 0 });
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/admin/users/alice') {
      assert.equal(call.body.login_name, expectedLoginName);
      assert.equal(call.body.source_id, 0);
      assert.equal(call.body.must_change_password, false);
      assert.equal(call.body.prohibit_login, false);
      assert.ok(call.body.password.length >= 32);
      return jsonResponse(200, {});
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice/tokens') {
      const credentials = Buffer.from(call.auth.slice('Basic '.length), 'base64').toString();
      assert.equal(credentials, `alice:${calls[2].body.password}`);
      return jsonResponse(200, []);
    }
    if (call.method === 'POST' && call.path === '/api/v1/users/alice/tokens') {
      const credentials = Buffer.from(call.auth.slice('Basic '.length), 'base64').toString();
      assert.equal(credentials, `alice:${calls[2].body.password}`);
      assert.deepEqual(call.body.scopes, ['write:user', 'write:repository', 'read:issue']);
      return jsonResponse(201, { id: 43, sha1: 'reused-user-token' });
    }
    assert.fail(`unexpected request: ${call.method} ${call.path}`);
  };

  const result = await mintGiteaAccount({
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
    fetchImpl,
  });

  assert.deepEqual(result, {
    remoteLogin: 'alice',
    tokenRef: '43',
    tokenPlaintext: 'reused-user-token',
  });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/admin/users',
    'GET /api/v1/users/alice',
    'PATCH /api/v1/admin/users/alice',
    'GET /api/v1/users/alice/tokens',
    'POST /api/v1/users/alice/tokens',
  ]);
}

test('Gitea reuses an existing user and preserves a non-empty login_name', async () => {
  await assertGiteaReuse('alice', 'alice');
});

test('Gitea falls back to username when the existing user login_name is empty', async () => {
  await assertGiteaReuse('', 'alice');
});

test('Gitea falls back to username when the existing user login_name is whitespace', async () => {
  await assertGiteaReuse('  ', 'alice');
});

test('Gitea reuse revokes only Station tokens by name before minting a replacement', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = {
      method: options.method,
      path: new URL(url).pathname,
      auth: options.headers.authorization,
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    if (call.method === 'POST' && call.path === '/api/v1/admin/users') {
      return jsonResponse(422, { message: 'user already exists' });
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice') {
      return jsonResponse(200, { id: 42, login: 'alice', login_name: 'alice', source_id: 0 });
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/admin/users/alice') {
      return jsonResponse(200, {});
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice/tokens') {
      const credentials = Buffer.from(call.auth.slice('Basic '.length), 'base64').toString();
      assert.equal(credentials, `alice:${calls[2].body.password}`);
      return jsonResponse(200, [
        { id: 91, name: 'erix-station-old-one' },
        { id: 92, name: 'legacy-platform-token' },
        { id: 93, name: 'tea-personal-token' },
      ]);
    }
    if (call.method === 'DELETE' && call.path === '/api/v1/users/alice/tokens/erix-station-old-one') {
      assert.equal(Buffer.from(call.auth.slice('Basic '.length), 'base64').toString(), `alice:${calls[2].body.password}`);
      return new Response(null, { status: 204 });
    }
    if (call.method === 'DELETE' && call.path === '/api/v1/users/alice/tokens/legacy-platform-token') {
      assert.equal(Buffer.from(call.auth.slice('Basic '.length), 'base64').toString(), `alice:${calls[2].body.password}`);
      return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && call.path === '/api/v1/users/alice/tokens') {
      return jsonResponse(201, { id: 94, sha1: 'new-platform-token' });
    }
    assert.fail(`unexpected request: ${call.method} ${call.path}`);
  };

  await mintGiteaAccount({
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
    previousTokenRef: '92',
    fetchImpl,
  });

  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/admin/users',
    'GET /api/v1/users/alice',
    'PATCH /api/v1/admin/users/alice',
    'GET /api/v1/users/alice/tokens',
    'DELETE /api/v1/users/alice/tokens/erix-station-old-one',
    'DELETE /api/v1/users/alice/tokens/legacy-platform-token',
    'POST /api/v1/users/alice/tokens',
  ]);
});

test('Gitea reuse without previousTokenRef still removes named Station tokens and preserves personal tokens', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = {
      method: options.method,
      path: new URL(url).pathname,
      auth: options.headers.authorization,
    };
    calls.push(call);
    if (call.method === 'POST' && call.path === '/api/v1/admin/users') {
      return jsonResponse(422, { message: 'user already exists' });
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice') {
      return jsonResponse(200, { id: 42, login: 'alice', login_name: 'alice', source_id: 0 });
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/admin/users/alice') return jsonResponse(200, {});
    if (call.method === 'GET' && call.path === '/api/v1/users/alice/tokens') {
      return jsonResponse(200, [
        { id: 95, name: 'erix-station-legacy' },
        { id: 96, name: 'tea-personal-token' },
      ]);
    }
    if (call.method === 'DELETE' && call.path === '/api/v1/users/alice/tokens/erix-station-legacy') {
      return new Response(null, { status: 204 });
    }
    if (call.method === 'POST' && call.path === '/api/v1/users/alice/tokens') {
      return jsonResponse(201, { id: 97, sha1: 'new-platform-token' });
    }
    assert.fail(`unexpected request: ${call.method} ${call.path}`);
  };

  await mintGiteaAccount({
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
    fetchImpl,
  });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/admin/users',
    'GET /api/v1/users/alice',
    'PATCH /api/v1/admin/users/alice',
    'GET /api/v1/users/alice/tokens',
    'DELETE /api/v1/users/alice/tokens/erix-station-legacy',
    'POST /api/v1/users/alice/tokens',
  ]);
});

test('Gitea offboarding prohibits login using a non-empty fallback login_name', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = {
      method: options.method,
      path: new URL(url).pathname,
      auth: options.headers.authorization,
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    if (call.method === 'GET' && call.path === '/api/v1/users/alice') {
      assert.match(call.auth, /^token gitea-admin-key$/);
      return jsonResponse(200, { id: 42, login: 'alice', login_name: '  ', source_id: 0 });
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/admin/users/alice') {
      assert.match(call.auth, /^token gitea-admin-key$/);
      return jsonResponse(200, {});
    }
    assert.fail(`unexpected request: ${call.method} ${call.path}`);
  };

  const result = await disableGiteaAccount({
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
    fetchImpl,
  });

  assert.deepEqual(result, { disabled: true, reason: 'prohibited' });
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'GET /api/v1/users/alice',
    'PATCH /api/v1/admin/users/alice',
  ]);
  assert.deepEqual(calls[1].body, {
    login_name: 'alice',
    source_id: 0,
    prohibit_login: true,
    must_change_password: false,
  });
});

test('Gitea offboarding treats an absent account as an idempotent success', async () => {
  const paths = [];
  const result = await disableGiteaAccount({
    baseUrl: 'https://gitea.example',
    adminKey: 'gitea-admin-key',
    login: 'alice',
    fetchImpl: async (url) => {
      paths.push(new URL(url).pathname);
      return new Response('Not Found', { status: 404 });
    },
  });

  assert.deepEqual(result, { disabled: false, reason: 'absent' });
  assert.deepEqual(paths, ['/api/v1/users/alice']);
});

test('Gitea offboarding surfaces non-404 API failures as GitMintError', async () => {
  await assert.rejects(
    disableGiteaAccount({
      baseUrl: 'https://gitea.example',
      adminKey: 'gitea-admin-key',
      login: 'alice',
      fetchImpl: async () => jsonResponse(503, { message: 'temporarily unavailable' }),
    }),
    (err) => err instanceof GitMintError && err.code === 'git_host_request_failed',
  );
});

test('Gitea does not delete a reused user when token minting fails', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const call = {
      method: options.method,
      path: new URL(url).pathname,
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    if (call.method === 'POST' && call.path === '/api/v1/admin/users') {
      return jsonResponse(422, { message: 'user already exists' });
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice') {
      return jsonResponse(200, { id: 42, login: 'alice', login_name: 'alice', source_id: 0 });
    }
    if (call.method === 'PATCH' && call.path === '/api/v1/admin/users/alice') {
      return jsonResponse(200, {});
    }
    if (call.method === 'GET' && call.path === '/api/v1/users/alice/tokens') {
      return jsonResponse(200, []);
    }
    if (call.method === 'POST' && call.path === '/api/v1/users/alice/tokens') {
      return jsonResponse(500, { message: 'token mint failed' });
    }
    assert.fail(`unexpected request: ${call.method} ${call.path}`);
  };

  await assert.rejects(
    mintGiteaAccount({
      baseUrl: 'https://gitea.example',
      adminKey: 'gitea-admin-key',
      login: 'alice',
      fetchImpl,
    }),
    (err) => err instanceof GitMintError && err.code === 'git_host_request_failed',
  );
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    'POST /api/v1/admin/users',
    'GET /api/v1/users/alice',
    'PATCH /api/v1/admin/users/alice',
    'GET /api/v1/users/alice/tokens',
    'POST /api/v1/users/alice/tokens',
  ]);
});

test('Gitea only reuses an account when the HTTP error body indicates a duplicate user', async () => {
  for (const [status, body] of [
    [500, { message: 'temporary server failure' }],
    [409, { message: 'unrelated conflict' }],
  ]) {
    const paths = [];
    await assert.rejects(
      mintGiteaAccount({
        baseUrl: 'https://gitea.example',
        adminKey: 'gitea-admin-key',
        login: 'alice',
        fetchImpl: async (url) => {
          paths.push(new URL(url).pathname);
          return jsonResponse(status, body);
        },
      }),
      (err) => err instanceof GitMintError && err.code === 'git_host_request_failed',
    );
    assert.deepEqual(paths, ['/api/v1/admin/users']);
  }

  let calls = 0;
  await assert.rejects(
    mintGiteaAccount({
      baseUrl: 'https://gitea.example',
      adminKey: 'gitea-admin-key',
      login: 'alice',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network unavailable');
      },
    }),
    (err) => err instanceof GitMintError && err.code === 'git_host_unreachable',
  );
  assert.equal(calls, 1);
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
