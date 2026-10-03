import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLlmGatewayClient, LlmGatewayError } from '../src/llm-gateway.js';

async function startStub(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      resolve({ raw, body: raw ? JSON.parse(raw) : undefined });
    });
    req.on('error', reject);
  });
}

test('LiteLLM admin API request contract: all client methods, paths, verbs, auth, query and JSON bodies', async () => {
  const calls = [];
  const stub = await startStub(async (req, res) => {
    const { raw, body } = await readRequest(req);
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, raw, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, key: 'sk-generated-test' }));
  });
  const client = createLlmGatewayClient({
    adminUrl: stub.url,
    masterKey: 'master-secret-test',
    timeoutMs: 500,
  });
  try {
    const userBody = { user_email: 'fde-alice@station.invalid' };
    const keyBody = { models: ['deepseek-flash'], user_id: 'u1', key_alias: 'fde-alice', metadata: { fde_name: 'alice' } };
    const updateKeyBody = { key: 'sk-existing-test-key', models: ['deepseek-flash'] };
    const modelBody = {
      model_name: 'deepseek-flash',
      litellm_params: { model: 'deepseek/deepseek-chat', litellm_credential_name: 'deepseek' },
      model_info: { display_name: 'DeepSeek Flash' },
    };
    const credentialBody = {
      credential_name: 'deepseek',
      credential_info: { description: 'DeepSeek' },
      credential_values: { api_base: 'https://api.example.test/v1', api_key: 'provider-secret-test' },
    };

    await client.createUser(userBody);
    await client.generateKey(keyBody);
    await client.updateKey(updateKeyBody);
    await client.deleteKey({ keys: ['sk-delete-test'] });
    await client.blockKey({ key: 'sk-block-test' });
    await client.unblockKey({ key: 'sk-unblock-test' });
    await client.keyInfo('sk info/+');
    await client.listModels();
    await client.createModel(modelBody);
    await client.updateModel({
      model_id: 'model-id-1',
      model_info: { display_name: 'Renamed' },
      litellm_params: { model: 'openai/new-model' },
    });
    await client.deleteModel('model-id-2');
    await client.blockModel('model-id-3');
    await client.unblockModel('model-id-4');
    await client.listCredentials();
    await client.createCredential(credentialBody);
    await client.updateCredential('deepseek / prod', { credential_values: { api_base: 'https://new.example.test' } });
    await client.deleteCredential('deepseek / prod');

    assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
      ['POST', '/user/new'],
      ['POST', '/key/generate'],
      ['POST', '/key/update'],
      ['POST', '/key/delete'],
      ['POST', '/key/block'],
      ['POST', '/key/unblock'],
      ['GET', '/key/info?key=sk+info%2F%2B'],
      ['GET', '/model/info'],
      ['POST', '/model/new'],
      ['PATCH', '/model/model-id-1/update'],
      ['POST', '/model/delete'],
      ['POST', '/model/block'],
      ['POST', '/model/unblock'],
      ['GET', '/credentials'],
      ['POST', '/credentials'],
      ['PUT', '/credentials/deepseek%20%2F%20prod'],
      ['DELETE', '/credentials/deepseek%20%2F%20prod'],
    ]);
    assert.deepEqual(calls[0].body, userBody);
    assert.deepEqual(calls[1].body, keyBody);
    assert.deepEqual(calls[2].body, updateKeyBody);
    assert.deepEqual(calls[8].body, modelBody);
    assert.deepEqual(calls[9].body, {
      model_info: { display_name: 'Renamed' },
      litellm_params: { model: 'openai/new-model' },
    });
    assert.deepEqual(calls[10].body, { id: 'model-id-2' });
    assert.deepEqual(calls[11].body, { model_id: 'model-id-3' });
    assert.deepEqual(calls[12].body, { model_id: 'model-id-4' });
    assert.deepEqual(calls[14].body, credentialBody);
    assert.deepEqual(calls[15].body, { credential_values: { api_base: 'https://new.example.test' } });
    assert.ok(calls.every((call) => call.authorization === 'Bearer master-secret-test'));
    assert.equal(
      calls.find((call) => call.method === 'POST' && call.path === '/credentials').raw.includes('provider-secret-test'),
      true,
    );
  } finally {
    await stub.close();
  }
});

test('LiteLLM key-update errors preserve status and redact the supplied virtual key', async () => {
  const virtualKey = 'sk-virtual-update-secret';
  const stub = await startStub(async (req, res) => {
    const { body } = await readRequest(req);
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/key/update');
    assert.deepEqual(body, { key: virtualKey, models: ['deepseek-flash'] });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: `Virtual key ${virtualKey} not found` }));
  });
  const client = createLlmGatewayClient({ adminUrl: stub.url, masterKey: 'master-secret-key-update' });
  try {
    await assert.rejects(
      () => client.updateKey({ key: virtualKey, models: ['deepseek-flash'] }),
      (err) => err instanceof LlmGatewayError
        && err.status === 404
        && !err.message.includes(virtualKey)
        && !err.upstreamMessage.includes(virtualKey)
        && err.message.includes('[redacted]'),
    );
  } finally {
    await stub.close();
  }
});

test('LiteLLM errors preserve status and redact master and upstream keys', async () => {
  const state = { status: 422 };
  const masterKey = 'master-secret-error';
  const upstreamKey = 'sk-provider-secret-error';
  const stub = await startStub(async (req, res) => {
    await readRequest(req);
    res.writeHead(state.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: { message: `rejected ${masterKey} and ${upstreamKey}` },
    }));
  });
  const client = createLlmGatewayClient({ adminUrl: stub.url, masterKey });
  try {
    await assert.rejects(
      () => client.createCredential({
        credential_name: 'deepseek',
        credential_info: {},
        credential_values: { api_key: upstreamKey },
      }),
      (err) => err instanceof LlmGatewayError
        && err.status === 422
        && !err.message.includes(masterKey)
        && !err.message.includes(upstreamKey)
        && err.message.includes('[redacted]'),
    );
    state.status = 401;
    await assert.rejects(
      () => client.listCredentials(),
      (err) => err instanceof LlmGatewayError
        && err.status === 401
        && !err.message.includes(masterKey)
        && !err.message.includes(upstreamKey),
    );
  } finally {
    await stub.close();
  }
});

test('LiteLLM key-info errors redact the virtual key supplied in the query string', async () => {
  const virtualKey = 'sk-virtual-query-secret';
  const stub = await startStub(async (req, res) => {
    await readRequest(req);
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ detail: `invalid key ${new URL(req.url, 'http://stub').searchParams.get('key')}` }));
  });
  const client = createLlmGatewayClient({ adminUrl: stub.url, masterKey: 'master-secret-query' });
  try {
    await assert.rejects(
      () => client.keyInfo(virtualKey),
      (err) => err instanceof LlmGatewayError
        && err.status === 401
        && !err.message.includes(virtualKey)
        && !err.upstreamMessage.includes(virtualKey)
        && err.message.includes('[redacted]'),
    );
  } finally {
    await stub.close();
  }
});

test('LiteLLM requests abort at timeout without exposing credentials', async () => {
  let signalAborted = false;
  const stub = await startStub(async () => new Promise(() => {}));
  const client = createLlmGatewayClient({
    adminUrl: stub.url,
    masterKey: 'master-secret-timeout',
    fetchImpl: (url, init) => {
      init.signal.addEventListener('abort', () => { signalAborted = true; });
      return fetch(url, init);
    },
    timeoutMs: 25,
  });
  try {
    await assert.rejects(
      () => client.createUser({ user_email: 'timeout@station.invalid' }),
      (err) => err instanceof LlmGatewayError
        && err.status === 504
        && /timed out/.test(err.message)
        && !err.message.includes('master-secret-timeout'),
    );
    assert.equal(signalAborted, true);
  } finally {
    await stub.close();
  }

  const bodyStub = await startStub((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
  });
  const bodyClient = createLlmGatewayClient({
    adminUrl: bodyStub.url,
    masterKey: 'master-secret-body-timeout',
    timeoutMs: 25,
  });
  try {
    await assert.rejects(
      () => bodyClient.listModels(),
      (err) => err instanceof LlmGatewayError && err.status === 504 && /timed out/.test(err.message),
    );
  } finally {
    await bodyStub.close();
  }
});
