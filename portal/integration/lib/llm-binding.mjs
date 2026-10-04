// Set up an FDE's LiteLLM credential, mock model, and virtual-key binding through the admin API.
import assert from 'node:assert/strict';
import path from 'node:path';
import * as totp from '../../src/totp.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { timeoutMs = 60000, intervalMs = 500, label = 'condition' } = {}) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function readCookie(setCookie) {
  const match = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return match ? match[1] : null;
}

/**
 * Create or reuse LiteLLM resources for an FDE, bind the selected model, and wait for its route.
 * The returned virtual key is read from the binding row because the admin API masks it on output.
 *
 * @param {object} opts
 * @param {string} [opts.portal] portal base URL
 * @param {(args: string) => string} opts.docker docker executor
 * @param {string} opts.dynamicDir host-side Traefik dynamic directory
 * @param {string} [opts.llmDynamicFile]
 * @param {string} opts.fdeName safe FDE name used in the DB and route
 * @param {string} [opts.portalContainerName]
 * @param {string} [opts.dbContainerName]
 * @param {string} [opts.adminCookie] existing admin session cookie
 * @param {string} [opts.adminLogin] break-glass admin login when no cookie is supplied
 * @param {string} [opts.adminPassword] break-glass admin password when no cookie is supplied
 * @param {string} [opts.modelName]
 * @param {string} [opts.modelResponse]
 * @param {number} [opts.mockDelay] LiteLLM mock_delay, in seconds
 */
export async function ensureLlmBinding({
  portal = 'http://127.0.0.1:18080',
  docker,
  dynamicDir,
  llmDynamicFile = 'llm-routes.yml',
  fdeName,
  portalContainerName = 'station-portal',
  dbContainerName = 'station-db',
  adminCookie,
  adminLogin,
  adminPassword,
  modelName = 'e2e-mock-model',
  modelResponse = 'E2E-MOCK-OK',
  mockDelay = 0,
} = {}) {
  assert.ok(typeof docker === 'function', 'ensureLlmBinding: docker executor is required');
  assert.ok(dynamicDir, 'ensureLlmBinding: dynamicDir is required');
  assert.match(fdeName ?? '', /^[a-z0-9][a-z0-9-]{0,62}$/, 'ensureLlmBinding: invalid fdeName');
  assert.match(modelName, /^[a-z0-9][a-z0-9-]{0,62}$/, 'ensureLlmBinding: invalid modelName');
  assert.ok(Number.isFinite(mockDelay) && mockDelay >= 0, 'ensureLlmBinding: mockDelay must be non-negative');
  assert.ok(adminCookie || (adminLogin && adminPassword), 'ensureLlmBinding: admin session or credentials are required');
  if (!adminCookie) assert.ok(!/\s/.test(adminPassword), 'adminPassword must not contain spaces');

  let sessionCookie = adminCookie;
  let resolvedAdminLogin = adminLogin ?? null;
  if (!sessionCookie) {
    const bootOutput = docker(
      `exec ${portalContainerName} node portal/src/cli.js bootstrap-admin --allow-extra --login ${adminLogin} --password ${adminPassword}`,
    );
    const seedMatch = /种子（[^\n]*）：([A-Z2-7]{16,})/.exec(bootOutput);
    assert.ok(seedMatch, 'bootstrap-admin output contains the one-time TOTP seed');

    const step1 = await fetch(`${portal}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: adminLogin, password: adminPassword }),
    });
    assert.equal(step1.status, 200, `admin login step1 (${adminLogin})`);
    const { pending_token: pendingToken } = await step1.json();
    const step2 = await fetch(`${portal}/api/auth/login/totp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_token: pendingToken, code: totp.totp(seedMatch[1]) }),
    });
    assert.equal(step2.status, 200, `admin login step2 (${adminLogin})`);
    sessionCookie = readCookie(step2.headers.get('set-cookie'));
    assert.ok(sessionCookie, 'admin session cookie');
  }

  const adminApi = async (pathname, options = {}) => {
    const response = await fetch(`${portal}${pathname}`, {
      method: options.method ?? 'GET',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `fde_session_dev=${sessionCookie}`,
      },
      body: options.body,
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  };

  const providerName = `e2e-cred-${fdeName}`;
  let provider = (await adminApi('/api/admin/llm/providers')).body.items
    ?.find((item) => item.id === providerName || item.name === providerName);
  if (!provider) {
    const created = await adminApi('/api/admin/llm/providers', {
      method: 'POST',
      body: JSON.stringify({
        name: providerName,
        credential_info: { credential_name: providerName, description: `e2e credential for ${fdeName}` },
        credential_values: { api_base: 'http://mock.invalid' },
      }),
    });
    if (created.status === 201) {
      provider = created.body.provider;
    } else {
      assert.equal(created.status, 409, `create credential ${providerName}: ${JSON.stringify(created.body)}`);
      provider = (await adminApi('/api/admin/llm/providers')).body.items
        ?.find((item) => item.id === providerName || item.name === providerName);
    }
  }
  assert.ok(provider, `LiteLLM credential ${providerName} exists`);
  const providerId = provider.id;

  const findModel = async () => {
    const response = await adminApi('/api/admin/llm/models');
    assert.equal(response.status, 200, 'list LiteLLM models');
    return (response.body.items ?? []).find(
      (item) => item.provider_id === providerId && item.model_name === modelName,
    );
  };
  let model = await findModel();
  if (!model) {
    const created = await adminApi(`/api/admin/llm/providers/${encodeURIComponent(providerId)}/models`, {
      method: 'POST',
      body: JSON.stringify({
        model_id: modelName,
        name: 'E2E Mock',
        type: 'text',
        tool_calling: true,
        model: 'openai/none',
        litellm_params: {
          model: 'openai/none',
          mock_response: modelResponse,
          mock_delay: mockDelay,
          litellm_credential_name: providerId,
        },
      }),
    });
    assert.equal(created.status, 201, `create LiteLLM mock model ${modelName}: ${JSON.stringify(created.body)}`);
    model = await findModel();
  }
  assert.ok(model?.id, `LiteLLM model ${modelName} exists under ${providerId}`);

  const put = await adminApi(`/api/admin/fdes/${encodeURIComponent(fdeName)}/llm`, {
    method: 'PUT',
    body: JSON.stringify({ provider_id: providerId, main_model_id: model.id }),
  });
  assert.equal(put.status, 200, `put FDE LLM binding (${fdeName}): ${JSON.stringify(put.body)}`);

  const keyOutput = docker(
    `exec ${dbContainerName} psql -U station -d station -tAc ${JSON.stringify(
      `SELECT b.api_key FROM fde_llm_bindings b JOIN users u ON u.id = b.fde_id WHERE u.fde_name = '${fdeName}' AND b.state = 'active'`,
    )}`,
  ).trim();
  assert.match(keyOutput, /^sk-[A-Za-z0-9_-]+$/, 'active binding has a LiteLLM virtual key');

  const routesPath = path.posix.join('/d', llmDynamicFile);
  const readLlmRoutes = () => {
    try {
      return docker(`run --rm -v ${JSON.stringify(dynamicDir)}:/d:ro alpine cat ${routesPath} 2>/dev/null`);
    } catch {
      return '';
    }
  };
  await waitFor(() => {
    const text = readLlmRoutes();
    return text.includes(`llm-${fdeName}:`) ? text : null;
  }, { label: `llm-routes.yml contains llm-${fdeName}` });

  return {
    virtualKey: keyOutput,
    modelName,
    model_name: modelName,
    modelId: model.id,
    providerId,
    providerName,
    provider_name: providerName,
    bindingConfig: put.body.config,
    adminLogin: resolvedAdminLogin,
  };
}
