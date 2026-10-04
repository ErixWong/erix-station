// WP6 end-to-end: LiteLLM admin setup, per-FDE key injection, allow-listing, and lifecycle regression.
// Must run with unique compose/container names, temporary DB storage, and isolated host ports.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import { ensureLlmBinding } from './lib/llm-binding.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --profile litellm --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const LITELLM_HOST_PORT = process.env.LITELLM_HOST_PORT || '4100';
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const STATION_LITELLM_NAME = process.env.STATION_LITELLM_NAME || 'station-litellm';
const FDE_NAMES = {
  alice: process.env.WP6_FDE_ALICE || 'alice',
  bob: process.env.WP6_FDE_BOB || 'bob',
};
const FDE_IMAGE = process.env.FDE_IMAGE || 'erix-station/fde:local';
const TRAEFIK_DEFAULT_STATIC = path.join(REPO_ROOT, 'deploy/traefik/traefik.yml');
const ADMIN_PASSWORD = 'wp6-admin-pass-123';
const HEARTBEAT_MS = 15000;

const LLM_HOST = 'llm.localhost';

function assertIsolatedEnvironment() {
  const required = [
    'STATION_DB_DIR', 'COMPOSE_PROJECT_NAME', 'STATION_STACK_ID',
    'STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME',
    'STATION_EDGE_NAME', 'STATION_LITELLM_NAME', 'PORTAL_HOST_PORT',
    'LITELLM_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT',
    'STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE',
    'WP6_FDE_ALICE', 'WP6_FDE_BOB', 'BACKEND_SUBNET', 'FDE_POOL', 'FDE_IPAM_POOLS',
  ];
  for (const name of required) assert.ok(process.env[name], `${name} must be set for isolated e2e`);
  const dbRelativePath = path.relative(os.tmpdir(), path.resolve(process.env.STATION_DB_DIR));
  assert.ok(dbRelativePath && !dbRelativePath.startsWith('..') && !path.isAbsolute(dbRelativePath),
    'STATION_DB_DIR must be inside the OS temporary directory');
  assert.ok(!fs.existsSync(process.env.STATION_DB_DIR), 'STATION_DB_DIR must be a fresh, nonexistent directory');
  for (const [name, forbidden] of [
    ['COMPOSE_PROJECT_NAME', 'station'],
    ['STATION_STACK_ID', 'default'],
    ['STATION_DB_NAME', 'station-db'],
    ['STATION_PORTAL_NAME', 'station-portal'],
    ['STATION_DOCKER_PROXY_NAME', 'station-docker-proxy'],
    ['STATION_EDGE_NAME', 'station-edge'],
    ['STATION_LITELLM_NAME', 'station-litellm'],
    ['PORTAL_HOST_PORT', '18080'],
    ['LITELLM_HOST_PORT', '4100'],
    ['TRAEFIK_WEB_PORT', '8090'],
    ['TRAEFIK_WEBSECURE_PORT', '8443'],
    ['BACKEND_SUBNET', '172.32.0.0/24'],
    ['STATION_PORTAL_IMAGE', 'erix-station/portal:local'],
    ['STATION_DOCKER_PROXY_IMAGE', 'erix-station/fde-proxy:local'],
    ['FDE_IMAGE', 'erix-station/fde:local'],
    ['WP6_FDE_ALICE', 'alice'],
    ['WP6_FDE_BOB', 'bob'],
  ]) assert.notEqual(process.env[name], forbidden, `${name} must not target the shared stack`);
  assert.equal(process.env.FDE_POOL, 'large', 'isolated e2e must use the dedicated large FDE pool');
  const fdeIpamPools = process.env.FDE_IPAM_POOLS.split(',').map((pool) => pool.trim()).filter(Boolean);
  assert.deepEqual(fdeIpamPools, ['10.201.0.0/16'], 'proxy IPAM pool must match the isolated FDE pool');
  assert.equal(process.env.COMPOSE_PROJECT_NAME, process.env.STATION_STACK_ID,
    'compose project and stack label must use the same unique ID');
  for (const name of ['STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME', 'STATION_EDGE_NAME', 'STATION_LITELLM_NAME']) {
    assert.ok(process.env[name].endsWith(`-${process.env.STATION_STACK_ID}`), `${name} must include the unique stack ID`);
  }
  for (const name of ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE']) {
    assert.ok(process.env[name].endsWith(`:${process.env.STATION_STACK_ID}`), `${name} must use a unique image tag`);
  }
  assert.match(FDE_NAMES.alice, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.match(FDE_NAMES.bob, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.ok(FDE_NAMES.alice.includes(process.env.STATION_STACK_ID), 'WP6_FDE_ALICE must include the unique stack ID');
  assert.ok(FDE_NAMES.bob.includes(process.env.STATION_STACK_ID), 'WP6_FDE_BOB must include the unique stack ID');
  assert.notEqual(FDE_NAMES.alice, FDE_NAMES.bob, 'isolated FDE names must be distinct');
  const ports = ['PORTAL_HOST_PORT', 'LITELLM_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT']
    .map((name) => process.env[name]);
  assert.equal(new Set(ports).size, ports.length, 'isolated e2e ports must be distinct');
  for (const port of ports) {
    assert.match(port, /^\d{2,5}$/);
    assert.ok(Number(port) <= 65535);
    assert.ok(!['4000', '4001', '4100', '8090', '8443', '18080'].includes(port),
      `isolated e2e must not use a shared-stack port (${port})`);
  }
  assert.equal(process.env.LLM_GATEWAY_HOST, `http://127.0.0.1:${LITELLM_HOST_PORT}`,
    'LLM_GATEWAY_HOST must target the isolated LiteLLM publish port');
}

async function assertHostPortsAvailable() {
  for (const port of [PORTAL_HOST_PORT, LITELLM_HOST_PORT, TRAEFIK_WEB_PORT, process.env.TRAEFIK_WEBSECURE_PORT]) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), '127.0.0.1', () => server.close(resolve));
    }).catch((error) => {
      throw new Error(`isolated e2e port ${port} is unavailable: ${error.message}`);
    });
  }
}

function writeTraefikStatic(dir) {
  const source = fs.readFileSync(TRAEFIK_DEFAULT_STATIC, 'utf8');
  assert.ok(source.includes('address: ":8090"') && source.includes('address: ":8443"'),
    'Traefik static config has the expected entrypoint addresses');
  const output = source
    .replace('address: ":8090"', `address: ":${TRAEFIK_WEB_PORT}"`)
    .replace('address: ":8443"', `address: ":${process.env.TRAEFIK_WEBSECURE_PORT}"`);
  const target = path.join(dir, 'traefik.yml');
  fs.writeFileSync(target, output);
  return target;
}

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
  });
}

function dockerStdin(args, input) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: REPO_ROOT,
  });
}

const DB_DIR = (process.env.STATION_DB_DIR || '').replace(/\/+$/, '');

function removeDbDir() {
  const parent = path.posix.dirname(DB_DIR);
  const name = path.posix.basename(DB_DIR);
  safe(() => docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`));
}

function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn, { label, timeoutMs, intervalMs = 500 }) {
  const startedAt = Date.now();
  let lastError;
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

async function restartPortalAndWaitForConfigs(fdeNames) {
  // Test users are created after startup; use the documented DB+volume rebuild path for their files.
  docker(`restart ${STATION_PORTAL_NAME}`);
  await waitFor(async () => (await fetch(`${PORTAL}/healthz`).catch(() => null))?.status === 200,
    { label: 'portal healthz after materializer rebuild', timeoutMs: 120000, intervalMs: 500 });
  for (const fdeName of fdeNames) {
    const configPath = path.join(S.userspaceRoot, fdeName, 'home', '.erix', 'config.json');
    await waitFor(() => (fs.existsSync(configPath) ? configPath : null),
      { label: `${fdeName} config.json materialized`, timeoutMs: 60000, intervalMs: 250 });
  }
}

function psql(query) {
  return docker(`exec ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function readCookie(setCookie) {
  const match = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return match ? match[1] : null;
}

const readLlmRoutes = () =>
  safe(() => docker(`run --rm -v ${S.dynamicRoot}:/d:ro alpine cat /d/llm-routes.yml 2>/dev/null`)) ?? '';
const llmRoutesMode = () =>
  safe(() => docker(`run --rm -v ${S.dynamicRoot}:/d:ro alpine stat -c %a /d/llm-routes.yml 2>/dev/null`))?.trim() ?? '';

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  artifactsRoot: null,
  staticFile: null,
  password: 'correct horse battery staple',
  adminCookie: null,
  users: {},
};

const FDE_ENV = {
  FDE_IMAGE,
  FDE_CMD: '[]',
  FDE_DEV_USER: '',
  FDE_DEV_MODE: '1',
  FDE_AGENT_VERSION: '0.1.0',
};

function fdeContainer(alias) {
  return `fde-${FDE_NAMES[alias]}`;
}

async function login(loginName, secret, password = S.password) {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  assert.equal(step1.status, 200, `login step1 (${loginName})`);
  const { pending_token: pendingToken } = await step1.json();
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token: pendingToken, code: totp.totp(secret) }),
  });
  assert.equal(step2.status, 200, `login step2 (${loginName})`);
  const cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(cookie, `session cookie (${loginName})`);
  return cookie;
}

async function api(cookie, pathname, options = {}) {
  const response = await fetch(`${PORTAL}${pathname}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `fde_session_dev=${cookie}`,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function adminApi(pathname, options = {}) {
  return api(S.adminCookie, pathname, options);
}

function bootstrapAdmin(loginName) {
  const output = docker(
    `exec ${STATION_PORTAL_NAME} node portal/src/cli.js bootstrap-admin --login ${loginName} --password ${ADMIN_PASSWORD}`,
  );
  const seedMatch = /种子（[^\n]*）：([A-Z2-7]{16,})/.exec(output);
  assert.ok(seedMatch, 'bootstrap-admin output contains the one-time TOTP seed');
  return seedMatch[1];
}

async function createFdeUser(loginName) {
  const response = await adminApi('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      login: loginName,
      display_name: loginName,
      password: S.password,
      fde_name: FDE_NAMES[loginName],
    }),
  });
  assert.equal(response.status, 201, `create user ${loginName}`);
  assert.ok(response.body.totp_secret, 'totp_secret is returned once');
  return response.body.totp_secret;
}

async function createSession(alias) {
  const response = await api(S.users[alias].cookie, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ cwd: '~/projects/proj1', title: 'wp6' }),
  });
  assert.equal(response.status, 201, `create session (${alias}): ${JSON.stringify(response.body)}`);
  S.users[alias].sessionId = response.body.session.id;
}

async function provisionFde(alias) {
  const fdeName = FDE_NAMES[alias];
  const container = fdeContainer(alias);
  docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${fdeName}`);
  await waitFor(
    () => (docker(`inspect ${container} --format {{.State.Status}}`).trim() === 'running' ? true : null),
    { label: `${container} running`, timeoutMs: 120000 },
  );
  await waitFor(
    () => (docker(`logs ${container} 2>&1`).includes('sse ping received') ? true : null),
    { label: `${container} agentd SSE ping`, timeoutMs: 90000, intervalMs: 1000 },
  );
}

async function sendMessageAndWait(alias, content, timeoutMs = 180000) {
  const response = await api(S.users[alias].cookie, `/api/sessions/${S.users[alias].sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  assert.equal(response.status, 202, `send message (${alias}): ${JSON.stringify(response.body)}`);
  const runId = response.body.run.id;
  const status = await waitFor(() => {
    const value = psql(`SELECT status FROM runs WHERE id='${runId}'`);
    return value === 'finished' || value === 'failed' ? value : null;
  }, { label: `run ${runId} terminal`, timeoutMs, intervalMs: 500 });
  return { runId, status };
}

async function waitHeartbeatDownlink(cycles = 2) {
  await sleep(cycles * HEARTBEAT_MS + 5000);
}

function requestFromFde(alias, pathname, { method = 'GET', virtualKey, gatewayIp, body } = {}) {
  assert.ok(gatewayIp, 'FDE gateway IP is required for the Traefik probe');
  const request = {
    url: `http://${gatewayIp}:${TRAEFIK_WEB_PORT}${pathname}`,
    method,
    headers: {
      Host: LLM_HOST,
      Authorization: `Bearer ${virtualKey}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
  const script = [
    'const http=require("node:http");',
    `const req=${JSON.stringify(request)};`,
    'const outgoing=http.request(req.url,{method:req.method,headers:req.headers},response=>{',
    'let body="";response.setEncoding("utf8");response.on("data",chunk=>body+=chunk);',
    'response.on("end",()=>console.log(JSON.stringify({status:response.statusCode,body})));',
    '});',
    'outgoing.on("error",error=>{console.error(error.message);process.exitCode=1});',
    'if(req.body)outgoing.write(req.body);outgoing.end();',
  ].join('');
  const output = docker(`exec ${fdeContainer(alias)} node -e ${JSON.stringify(script)}`).trim();
  return JSON.parse(output);
}

async function createMockModel(providerId, modelName, responseText) {
  const created = await adminApi(`/api/admin/llm/providers/${encodeURIComponent(providerId)}/models`, {
    method: 'POST',
    body: JSON.stringify({
      model_id: modelName,
      name: modelName,
      type: 'text',
      tool_calling: true,
      model: 'openai/none',
      litellm_params: {
        model: 'openai/none',
        mock_response: responseText,
        mock_delay: 0,
        litellm_credential_name: providerId,
      },
    }),
  });
  assert.equal(created.status, 201, `create mock model (${modelName})`);
  const listed = await adminApi('/api/admin/llm/models');
  assert.equal(listed.status, 200, 'list models');
  const model = (listed.body.items ?? []).find(
    (item) => item.provider_id === providerId && item.model_name === modelName,
  );
  assert.ok(model?.id, `LiteLLM model ${modelName} is listed`);
  return model;
}

test('WP6 end-to-end: LiteLLM virtual key injection, model allow-list, and binding lifecycle', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  assertIsolatedEnvironment();
  await assertHostPortsAvailable();
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp6-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp6-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp6-'));
  S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp6-'));
  S.staticFile = writeTraefikStatic(S.staticRoot);
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);
  fs.chmodSync(S.artifactsRoot, 0o755);
  const composePaths = {
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
    ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
    BASE_DOMAIN: 'localhost',
    PORTAL_HOST: 'station.localhost',
    PORTAL_PUBLIC_BASE_URL: `http://station.localhost:${TRAEFIK_WEB_PORT}`,
    LLM_HOST: 'llm.localhost',
    LLM_PUBLIC_BASE_URL: `http://llm.localhost:${TRAEFIK_WEB_PORT}`,
  };

  const cleanup = () => {
    safe(() => docker(`rm -f ${fdeContainer('alice')} ${fdeContainer('bob')} 2>/dev/null || true`));
    safe(() => docker(`network rm fde-${FDE_NAMES.alice} fde-${FDE_NAMES.bob} 2>/dev/null || true`));
    safe(() => compose('down -v', composePaths));
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.artifactsRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    safe(() => compose('down -v', composePaths));
    removeDbDir();
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    docker(`build -t ${FDE_IMAGE} runner/`);
    compose('up -d --build', {
      ...composePaths,
      MIGRATE_ON_START: '1',
      LITELLM_HOST_PORT,
      LLM_GATEWAY_HOST: `http://127.0.0.1:${LITELLM_HOST_PORT}`,
      ...FDE_ENV,
    });
    await waitFor(async () => {
      const response = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return response?.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${LITELLM_HOST_PORT}/health/readiness`).catch(() => null);
      return response?.status === 200;
    }, { label: `LiteLLM readiness (${STATION_LITELLM_NAME})`, timeoutMs: 180000, intervalMs: 1000 });

    // Incremental migrations are the source of all post-baseline DDL.
    for (const version of ['0002-llm-config', '0010-litellm-bindings', '0011-git-hosts']) {
      assert.equal(
        psql(`SELECT count(*) FROM schema_migrations WHERE version='${version}'`),
        '1',
        `migration ${version} is applied`,
      );
    }
    for (const table of ['llm_providers', 'llm_models']) {
      assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='${table}'`), '0',
        `${table} is retired`);
      assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='${table}_retired'`), '1',
        `${table}_retired is retained`);
    }
    for (const table of ['git_hosts', 'fde_git_accounts']) {
      assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='${table}'`), '1',
        `${table} from migration 0011 exists`);
    }
    for (const column of ['provider_id', 'api_key', 'key_id', 'main_model_id', 'main_model_name']) {
      assert.equal(
        psql(`SELECT count(*) FROM information_schema.columns WHERE table_name='fde_llm_bindings' AND column_name='${column}'`),
        '1',
        `fde_llm_bindings.${column} exists`,
      );
    }

    const adminTotp = bootstrapAdmin('admin-wp6');
    S.adminCookie = await login('admin-wp6', adminTotp, ADMIN_PASSWORD);
    for (const alias of ['alice', 'bob']) {
      const secret = await createFdeUser(alias);
      S.users[alias] = {
        cookie: await login(alias, secret),
        fdeName: FDE_NAMES[alias],
      };
    }
    await restartPortalAndWaitForConfigs([FDE_NAMES.alice, FDE_NAMES.bob]);
    for (const alias of ['alice', 'bob']) {
      await provisionFde(alias);
    }

    // All resources, including the virtual key, are created through the product admin API.
    const binding = await ensureLlmBinding({
      docker,
      dynamicDir: S.dynamicRoot,
      fdeName: FDE_NAMES.alice,
      portal: PORTAL,
      portalContainerName: STATION_PORTAL_NAME,
      dbContainerName: STATION_DB_NAME,
      adminCookie: S.adminCookie,
      modelName: 'e2e-mock-model',
      modelResponse: 'E2E-MOCK-OK',
    });
    const virtualKey = binding.virtualKey;
    const keyMask = `sk-...${virtualKey.slice(-4)}`;
    assert.equal(binding.modelName, 'e2e-mock-model');
    assert.equal(binding.providerName, `e2e-cred-${FDE_NAMES.alice}`);
    assert.equal(binding.bindingConfig.api_key, keyMask, 'PUT response masks the virtual key');
    assert.ok(!JSON.stringify(binding.bindingConfig).includes(virtualKey), 'binding response does not echo the virtual key');
    const getEcho = await adminApi(`/api/admin/fdes/${FDE_NAMES.alice}/llm`);
    assert.equal(getEcho.status, 200);
    assert.equal(getEcho.body.config.api_key, keyMask, 'GET response also masks the virtual key');
    assert.equal(getEcho.body.active_run, false, 'there is no active run');

    const outsideModel = await createMockModel(binding.providerId, 'e2e-outside-model', 'OUTSIDE');
    const nextModel = await createMockModel(binding.providerId, 'e2e-mock-model-b', 'E2E-MOCK-B');
    assert.ok(outsideModel.id && nextModel.id);

    const networkRow = psql(
      `SELECT n.subnet, n.gateway FROM fde_networks n JOIN users u ON u.id=n.fde_id WHERE u.fde_name='${FDE_NAMES.alice}'`,
    );
    const [aliceSubnet, aliceGateway] = networkRow.split('|').map((value) => value.trim());
    assert.ok(aliceSubnet, 'alice subnet allocated');
    assert.ok(aliceGateway, 'alice network gateway allocated');
    await waitFor(() => {
      const text = readLlmRoutes();
      return text.includes(`llm-${FDE_NAMES.alice}:`) ? text : null;
    }, { label: `llm-routes.yml contains llm-${FDE_NAMES.alice}`, timeoutMs: 60000 });

    // Published LLM routes carry only ingress restrictions, key injection, and the shared gateway service.
    const routes1 = readLlmRoutes();
    assert.ok(routes1.includes(`llm-${FDE_NAMES.alice}:`), 'per-FDE router exists');
    assert.ok(routes1.includes(`Host(\`${LLM_HOST}\`)`), 'router matches configured llmHost');
    assert.ok(routes1.includes(`ClientIP(\`${aliceSubnet}\`)`), 'router restricts the exact FDE subnet');
    assert.ok(routes1.includes(`middlewares: [llm-key-${FDE_NAMES.alice}]`), 'router uses its paired key middleware');
    assert.ok(routes1.includes(`llm-key-${FDE_NAMES.alice}:`), 'per-FDE key middleware exists');
    assert.ok(routes1.includes(`Bearer ${virtualKey}`), 'middleware injects the virtual key');
    assert.ok(routes1.includes('service: llm-gateway'), 'router uses the shared llm-gateway service');
    assert.ok(routes1.includes(`- url: "http://127.0.0.1:${LITELLM_HOST_PORT}"`), 'shared service targets isolated LiteLLM');
    assert.equal(routes1.split('\n').filter((line) => line === '    llm-gateway:').length, 1,
      'exactly one shared service is emitted');
    assert.ok(!routes1.includes('e2e-mock-model'), 'model names do not enter the route file');
    assert.ok(!routes1.includes('e2e-cred-'), 'credential names do not enter the route file');
    assert.equal(llmRoutesMode(), '600', 'llm-routes.yml mode is 600');

    // The FDE's key can call only the selected model; another registered model is denied.
    await waitHeartbeatDownlink(2);
    const allowed = requestFromFde('alice', '/v1/chat/completions', {
      method: 'POST',
      virtualKey,
      gatewayIp: aliceGateway,
      body: { model: binding.modelName, messages: [{ role: 'user', content: 'allow-list check' }] },
    });
    assert.equal(allowed.status, 200, 'allow-listed model returns 200');
    assert.equal(JSON.parse(allowed.body).choices?.[0]?.message?.content, 'E2E-MOCK-OK',
      'LiteLLM native mock response is returned');
    const denied = requestFromFde('alice', '/v1/chat/completions', {
      method: 'POST',
      virtualKey,
      gatewayIp: aliceGateway,
      body: { model: 'e2e-outside-model', messages: [{ role: 'user', content: 'deny-list check' }] },
    });
    assert.equal(denied.status, 403, 'registered but non-allow-listed model returns 403');
    const visibleModels = requestFromFde('alice', '/v1/models', { virtualKey, gatewayIp: aliceGateway });
    assert.equal(visibleModels.status, 200, 'FDE models endpoint returns 200');
    assert.deepEqual(
      JSON.parse(visibleModels.body).data.map((model) => model.id),
      [binding.modelName],
      'GET /v1/models returns only the allow-listed model',
    );

    // Heartbeat downlink selects the model at run time; the run completes normally.
    await createSession('alice');
    const run1 = await sendMessageAndWait('alice', 'WP6 allow-listed model should reply normally');
    assert.equal(run1.status, 'finished', 'mock_response produces a finished run');
    assert.equal(
      psql(`SELECT count(*) FROM messages WHERE run_id='${run1.runId}' AND role='assistant' AND content LIKE '%E2E-MOCK-OK%'`),
      '1',
      'assistant message contains the LiteLLM mock response',
    );
    const keyIdBefore = psql(
      `SELECT b.key_id FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='${FDE_NAMES.alice}'`,
    );
    assert.ok(keyIdBefore, 'LiteLLM key id is stored on the binding');

    // Change the selected model; /key/update must preserve both the key and its key_id.
    const put2 = await adminApi(`/api/admin/fdes/${FDE_NAMES.alice}/llm`, {
      method: 'PUT',
      body: JSON.stringify({ provider_id: binding.providerId, main_model_id: nextModel.id }),
    });
    assert.equal(put2.status, 200, `update selected model: ${JSON.stringify(put2.body)}`);
    assert.equal(put2.body.config.api_key, keyMask, 'model update keeps the same masked key');
    await waitHeartbeatDownlink(2);
    const run2 = await sendMessageAndWait('alice', 'WP6 updated model should reply normally');
    assert.equal(run2.status, 'finished', 'updated mock model produces a finished run');
    assert.equal(
      psql(`SELECT count(*) FROM messages WHERE run_id='${run2.runId}' AND role='assistant' AND content LIKE '%E2E-MOCK-B%'`),
      '1',
      'heartbeat downlink selected the updated model',
    );
    assert.equal(
      psql(`SELECT b.key_id FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='${FDE_NAMES.alice}'`),
      keyIdBefore,
      'model update retains the existing LiteLLM key_id',
    );
    assert.equal(
      psql(`SELECT b.api_key FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='${FDE_NAMES.alice}'`),
      virtualKey,
      'model update retains the same virtual key',
    );
    const routes2 = readLlmRoutes();
    assert.ok(routes2.includes(`llm-${FDE_NAMES.alice}:`), 'router remains after model update');
    assert.ok(routes2.includes(`Bearer ${virtualKey}`), 'key injected after model update is unchanged');
    assert.ok(!routes2.includes('e2e-mock-model-b'), 'updated model name still does not enter the route file');

    // Non-admins cannot use the management API.
    const forbiddenGet = await api(S.users.alice.cookie, '/api/admin/llm/providers');
    assert.equal(forbiddenGet.status, 403, 'non-admin GET to the admin API is forbidden');
    const forbiddenPut = await api(S.users.alice.cookie, `/api/admin/fdes/${FDE_NAMES.alice}/llm`, {
      method: 'PUT',
      body: JSON.stringify({ provider_id: binding.providerId, main_model_id: binding.modelId }),
    });
    assert.equal(forbiddenPut.status, 403, 'non-admin PUT to the admin API is forbidden');

    // Deprovision revokes the binding and removes its published route.
    docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js deprovision-fde --fde-name ${FDE_NAMES.alice}`);
    await waitFor(
      () => (safe(() => docker(`inspect ${fdeContainer('alice')} --format {{.Id}}`).trim()) ? null : true),
      { label: `${fdeContainer('alice')} removed`, timeoutMs: 90000 },
    );
    await waitFor(
      () => (readLlmRoutes().includes(`llm-${FDE_NAMES.alice}`) ? null : true),
      { label: 'LLM route converges after deprovision', timeoutMs: 60000 },
    );
    assert.equal(
      psql(`SELECT state FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='${FDE_NAMES.alice}'`),
      'revoked',
      'deprovision revokes the LiteLLM binding',
    );

    // An FDE without a binding has no LLM router; message creation fails fast before queuing a run.
    await createSession('bob');
    const unboundMessage = await api(S.users.bob.cookie, `/api/sessions/${S.users.bob.sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'WP6 no-binding FDE must fail fast' }),
    });
    assert.equal(unboundMessage.status, 409, 'an FDE without an LLM binding cannot queue a run');
    assert.equal(unboundMessage.body.error.code, 'llm_not_configured');
    assert.equal(
      psql(`SELECT count(*) FROM runs WHERE session_id='${S.users.bob.sessionId}'`),
      '0',
      'unbound FDE rejection does not create a run',
    );
    assert.equal(docker(`inspect ${fdeContainer('bob')} --format {{.State.Status}}`).trim(), 'running',
      'unbound FDE container remains running');
    assert.ok(!readLlmRoutes().includes(`llm-${FDE_NAMES.bob}`), 'no route is published for an unbound FDE');

    console.log('[wp6] ✅ LiteLLM model allow-list, per-FDE key injection, mask, key stability, and deprovision checks passed');
  } catch (error) {
    try {
      console.log('\n[wp6] --- portal logs ---');
      console.log(docker(`logs ${STATION_PORTAL_NAME} --tail 80 2>&1`));
      console.log(`\n[wp6] --- ${fdeContainer('alice')} logs ---`);
      console.log(safe(() => docker(`logs ${fdeContainer('alice')} --tail 60 2>&1`)) ?? '(container gone)');
      console.log(`\n[wp6] --- ${STATION_LITELLM_NAME} logs ---`);
      console.log(safe(() => docker(`logs ${STATION_LITELLM_NAME} --tail 60 2>&1`)) ?? '(container gone)');
    } catch {
      // Keep the original test failure.
    }
    throw error;
  }
});
