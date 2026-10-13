// WP6 end-to-end: LiteLLM admin setup, per-FDE key injection, allow-listing, and lifecycle regression.
// Must run with unique compose/container names, temporary DB storage, and isolated host ports.
// e2e 前置：必须导出 HTTP_PROXY/HTTPS_PROXY（FDE 镜像构建要联网下 gh/tea/glab）；隔离栈须派生
// 镜像 tag（FDE_IMAGE/STATION_PORTAL_IMAGE）并显式 FDE_DEV_MODE=1（#227.1：tag 形态不声明
// dev 模式会被护栏拒跑，digest 形态豁免）——本脚本绝不删除共享镜像 tag（issue #178，
// 口径集中在 lib/fde-image.mjs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import { ensureLlmBinding } from './lib/llm-binding.mjs';
import { DEFAULT_FDE_IMAGE, buildFdeImage } from './lib/fde-image.mjs';
import { LLM_HOST, composeDomainEnv } from './lib/compose-domain.mjs';
// issue #226：护栏/DB 目录解析/端口探测/Traefik 静态配置生成的唯一一副本在 lib/isolated-env.mjs。
import {
  assertHostPortsAvailable, defaultFdeIpamPools, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
  writeDynamicStub,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：compose 一律显式 -p，且用 bash 的 `${VAR:?msg}`——未 export 时展开即非零退出并点名，
// 不再依赖「COMPOSE_PROJECT_NAME 环境变量压过 compose 文件 name: station」这条隐式优先级
// （忘 export 曾经会让脚本自己对共享 dev 栈 down -v）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --profile litellm --env-file deploy/.env -f deploy/docker-compose.yml';

// #227.3：FDE_IPAM_POOLS 未显式传时按栈 id 派生本栈口径（派生段+portal large 池固定段；显式传入优先）。
if (!process.env.FDE_IPAM_POOLS && process.env.STATION_STACK_ID) {
  process.env.FDE_IPAM_POOLS = defaultFdeIpamPools(process.env.STATION_STACK_ID);
}

const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const LITELLM_HOST_PORT = process.env.LITELLM_HOST_PORT || '4100';
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const STATION_LITELLM_NAME = process.env.STATION_LITELLM_NAME || 'station-litellm';
const FDE_NAMES = {
  alice: process.env.WP6_FDE_ALICE || 'alice',
  bob: process.env.WP6_FDE_BOB || 'bob',
};
const FDE_IMAGE = process.env.FDE_IMAGE || DEFAULT_FDE_IMAGE;
const ADMIN_PASSWORD = 'wp6-admin-pass-123';
const HEARTBEAT_MS = 15000;

// #226：判据本体已提到 lib/isolated-env.mjs；本脚本的参数是两个 FDE 名（都得带栈 id）
// 与「镜像不得沿用共享栈的 :local 默认 tag」。
function isolatedStackOptions() {
  return {
    fdeNames: [
      { env: 'WP6_FDE_ALICE', value: FDE_NAMES.alice, sharedDefault: 'alice' },
      { env: 'WP6_FDE_BOB', value: FDE_NAMES.bob, sharedDefault: 'bob' },
    ],
    extraForbiddenEnv: [
      ['STATION_PORTAL_IMAGE', 'erix-station/portal:local'],
      ['STATION_DOCKER_PROXY_IMAGE', 'erix-station/fde-proxy:local'],
      ['FDE_IMAGE', 'erix-station/fde:local'],
    ],
  };
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

const { removeDbDir } = createDbDirCleaner({ docker });

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
  gitHostId: null,
  onboardingLlm: null,
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
  // 两步登录取证：已绑 TOTP 的账号 step1 必须回 pending_token（而非直接发 cookie）。
  console.log(`[wp6] login step1 ${loginName}: status=${step1.status} pending_token=${pendingToken ? 'present' : 'absent'}`);
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token: pendingToken, code: totp.totp(secret) }),
  });
  assert.equal(step2.status, 200, `login step2 (${loginName})`);
  const cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(cookie, `session cookie (${loginName})`);
  console.log(`[wp6] login step2 ${loginName}: status=${step2.status} totp accepted, session cookie issued`);
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
  assert.ok(S.onboardingLlm, 'onboarding LiteLLM model is configured before account creation');
  const response = await adminApi('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({
      login: loginName,
      display_name: loginName,
      password: S.password,
      email: `${loginName}@station.invalid`,
      fde_name: FDE_NAMES[loginName],
      git_host_id: S.gitHostId,
      // 管理台建号的 TOTP 是 opt-in（见 docs/api/portal.md §12 `POST /api/admin/users`）：
      // 本用例的 login() 走口令 + /api/auth/login/totp 两步，账号必须显式启用 TOTP 才有种子。
      totp_enabled: true,
      llm: {
        provider_id: S.onboardingLlm.providerId,
        main_model_id: S.onboardingLlm.modelId,
      },
    }),
  });
  assert.equal(response.status, 201, `create user ${loginName}`);
  assert.ok(response.body.totp_secret, 'opt-in TOTP：totp_enabled=true 时种子只在下发一次的创建响应里出现');
  assert.deepEqual(response.body.onboarding, {
    state: 'pending', step: 'provision', error: null, llm_binding: { state: 'pending', error: null },
  });
  const onboarding = await waitFor(async () => {
    const list = await adminApi('/api/admin/users');
    return list.body.items?.find((user) => user.login === loginName)?.onboarding?.state === 'awaiting_credential'
      ? true
      : null;
  }, { label: `${loginName} onboarding awaits Git credential`, timeoutMs: 240000, intervalMs: 1000 });
  assert.equal(onboarding, true);
  const credential = await adminApi(`/api/admin/fdes/${FDE_NAMES[loginName]}/git-credential`, {
    method: 'PUT',
    body: JSON.stringify({ host: 'github.com', username: loginName, token: `wp6-temporary-${loginName}` }),
  });
  assert.equal(credential.status, 200, `set Git credential ${loginName}`);
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

/**
 * 读某个 run 的助手正文（走**产品读路径** GET /api/sessions/:id）。
 * P3 PR②b B2（a3e732d）后 `messages` 降级为纯锚点行、`content` 恒为空串，终态正文真相在
 * `transcript_rounds`、由 `session-view.js` 投影到会话 DTO（产品口径，非测试可改项）；
 * 所以「助手真的用所选 mock 模型回了话」只能这样断言，查 `messages.content` 已无意义。
 */
async function assistantTextOfRun(alias, runId) {
  const anchor = psql(`SELECT count(*) FROM messages WHERE run_id='${runId}' AND role='assistant' AND synthetic = false`);
  assert.equal(anchor, '1', `assistant anchor row is written for run ${runId}`);
  const view = await api(S.users[alias].cookie, `/api/sessions/${S.users[alias].sessionId}`);
  assert.equal(view.status, 200, `read session view (${alias})`);
  const message = (view.body.messages ?? []).find(
    (item) => item.run_id === runId && item.role === 'assistant' && item.synthetic !== true,
  );
  assert.ok(message, `session view exposes the assistant message of run ${runId}`);
  const text = String(message.content ?? '');
  console.log(`[wp6] assistant text (${alias}) run=${runId}: ${JSON.stringify(text.slice(0, 120))}`);
  return text;
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

async function createOnboardingMockModel() {
  const providerName = `e2e-onboarding-${process.env.STATION_STACK_ID}`;
  const created = await adminApi('/api/admin/llm/providers', {
    method: 'POST',
    body: JSON.stringify({
      name: providerName,
      credential_info: { credential_name: providerName, description: 'WP6 onboarding mock' },
      credential_values: { api_base: 'http://mock.invalid' },
    }),
  });
  assert.equal(created.status, 201, `create onboarding LiteLLM credential: ${JSON.stringify(created.body)}`);
  const model = await createMockModel(created.body.provider.id, 'e2e-onboarding-model', 'E2E-ONBOARDING-OK');
  S.onboardingLlm = { providerId: created.body.provider.id, modelId: model.id };
}

test('WP6 end-to-end: LiteLLM virtual key injection, model allow-list, and binding lifecycle', {
  timeout: 20 * 60 * 1000,
}, async (t) => {
  assertIsolatedEnvironment(isolatedStackOptions());
  await assertHostPortsAvailable([PORTAL_HOST_PORT, LITELLM_HOST_PORT, TRAEFIK_WEB_PORT, process.env.TRAEFIK_WEBSECURE_PORT]);
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp6-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp6-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp6-'));
  S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp6-'));
  S.staticFile = writeTraefikStatic(S.staticRoot, {
    repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: process.env.TRAEFIK_WEBSECURE_PORT,
  });
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);
  fs.chmodSync(S.artifactsRoot, 0o755);
  // #268 M1：预写 edge watch 桩（坑见 lib/isolated-env.mjs:writeDynamicStub；必须早于 compose up）。
  writeDynamicStub(S.dynamicRoot);
  const composePaths = {
    ...DOMAIN_COMPOSE_ENV,
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
    ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
  };

  // #224：清场失败不再静默吞掉。每个动作失败都记名 + console.warn；末尾断言「本栈残留 = 0」——
  // 清理失败**必须**让测试变红（静默 = 隔离性假象：残留容器下次被复用会被误判成「隔离成功」）。
  // 动作顺序照工单口径：compose down -v → 散容器（fde-*）→ 网络 → removeDbDir。
  const teardownFailures = [];
  const teardown = (action, fn) => {
    try {
      fn();
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
      console.warn(`[wp6] teardown ${action} 失败:`, detail);
      teardownFailures.push(action);
    }
  };
  const dockerOut = (args) => docker(args).split('\n').map((line) => line.trim()).filter(Boolean);
  const containerNamesPresent = (...names) => {
    const wanted = new Set(names);
    return dockerOut('ps -a --format {{.Names}}').filter((n) => wanted.has(n));
  };
  const networkNamesPresent = (...names) => {
    const wanted = new Set(names);
    return dockerOut('network ls --format {{.Name}}').filter((n) => wanted.has(n));
  };
  const fdeContainers = [fdeContainer('alice'), fdeContainer('bob')];
  const fdeNetworks = [`fde-${FDE_NAMES.alice}`, `fde-${FDE_NAMES.bob}`];

  const cleanup = () => {
    teardown('compose down -v', () => compose('down -v', composePaths));
    teardown(`rm -f ${fdeContainers.join(' ')}`, () => {
      // 先查在不在再删：资源「本就不存在」不是清理失败（deprovision/上次清场已删）；真失败（daemon 报错）必须记名。
      const present = containerNamesPresent(...fdeContainers);
      if (present.length) docker(`rm -f ${present.join(' ')}`);
    });
    teardown(`network rm ${fdeNetworks.join(' ')}`, () => {
      const present = networkNamesPresent(...fdeNetworks);
      if (present.length) docker(`network rm ${present.join(' ')}`);
    });
    // issue #178：不删镜像（共享 tag 绝不能被 e2e 删除；compose/docker build 按需失效缓存）。
    teardown('rm -rf userspace 临时目录', () => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    teardown('rm -rf dynamic 临时目录', () => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    teardown('rm -rf static 临时目录', () => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    teardown('rm -rf artifacts 临时目录', () => fs.rmSync(S.artifactsRoot, { recursive: true, force: true }));
    // lib 的 removeDbDir 对 docker 失败不抛（teardown 语义），以返回 null 记失败——这里翻译成显式失败。
    teardown('removeDbDir', () => {
      if (removeDbDir() === null) throw new Error('lib removeDbDir 返回 null（docker 删除执行失败，STATION_DB_DIR 未清掉）');
    });
    // #224 零残留复查：本栈标签的容器/网络应为 0。FDE 容器/网络由 portal provisioner 创建时打
    // station.stack=<栈 id> 标签（portal/src/provisioner.js:198/225，栈 id 即护栏钉的 STATION_STACK_ID）；
    // compose 资源自带 com.docker.compose.project=<project> 标签。最后再按名复查兜底无标签散资源。
    // 复查本身跑不动（docker 挂了）同样记失败——不允许「查不了」=「当没残留」。
    const residual = [];
    try {
      const stackId = process.env.STATION_STACK_ID;
      const project = process.env.COMPOSE_PROJECT_NAME;
      residual.push(...dockerOut(`ps -a --filter label=station.stack=${stackId} -q`)
        .map((id) => `容器 ${id}（label station.stack=${stackId}）`));
      residual.push(...dockerOut(`network ls --filter label=station.stack=${stackId} -q`)
        .map((id) => `网络 ${id}（label station.stack=${stackId}）`));
      residual.push(...dockerOut(`ps -a --filter label=com.docker.compose.project=${project} -q`)
        .map((id) => `容器 ${id}（compose project ${project}）`));
      residual.push(...dockerOut(`network ls --filter label=com.docker.compose.project=${project} -q`)
        .map((id) => `网络 ${id}（compose project ${project}）`));
      residual.push(...containerNamesPresent(...fdeContainers).map((n) => `容器 ${n}（按名复查）`));
      residual.push(...networkNamesPresent(...fdeNetworks).map((n) => `网络 ${n}（按名复查）`));
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
      console.warn('[wp6] teardown 零残留复查 执行失败:', detail);
      teardownFailures.push(`零残留复查执行失败：${detail}`);
    }
    const problems = [
      ...teardownFailures.map((action) => `清理动作失败：${action}`),
      ...residual.map((item) => `残留资源：${item}`),
    ];
    assert.deepEqual(problems, [], `wp6 清场未清干净（#224，清理失败必须红、不允许静默）:\n${problems.join('\n')}`);
  };
  t.after(cleanup);

  try {
    safe(() => compose('down -v', composePaths));
    removeDbDir();
    buildFdeImage(FDE_IMAGE);
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
    for (const version of ['0002-llm-config', '0010-litellm-bindings', '0011-git-hosts', '0012-onboarding']) {
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
    for (const table of ['git_hosts', 'fde_git_accounts', 'fde_onboarding']) {
      assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='${table}'`), '1',
        `${table} from migrations 0011/0012 exists`);
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
    const gitHost = await adminApi('/api/admin/git-hosts', {
      method: 'POST',
      body: JSON.stringify({
        name: `wp6-github-${process.env.STATION_STACK_ID}`,
        provider: 'github',
        base_url: 'https://github.com',
      }),
    });
    assert.equal(gitHost.status, 201, `create Git host: ${JSON.stringify(gitHost.body)}`);
    S.gitHostId = gitHost.body.host.id;
    await createOnboardingMockModel();
    for (const alias of ['alice', 'bob']) {
      const secret = await createFdeUser(alias);
      S.users[alias] = {
        cookie: await login(alias, secret),
        fdeName: FDE_NAMES[alias],
      };
    }
    for (const alias of ['alice', 'bob']) {
      assert.equal(
        psql(`SELECT provider_id || '|' || main_model_id || '|' || state FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='${FDE_NAMES[alias]}'`),
        `${S.onboardingLlm.providerId}|${S.onboardingLlm.modelId}|active`,
        `${alias} received the model selected in the creation form`,
      );
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
    assert.match(await assistantTextOfRun('alice', run1.runId), /E2E-MOCK-OK/,
      'assistant message contains the LiteLLM mock response');
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
    assert.match(await assistantTextOfRun('alice', run2.runId), /E2E-MOCK-B/,
      'heartbeat downlink selected the updated model');
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

    // The second new account has a binding from its creation form and can start a first conversation.
    await createSession('bob');
    const firstBobRun = await sendMessageAndWait('bob', 'WP6 onboarding-selected model should reply normally');
    assert.equal(firstBobRun.status, 'finished', 'the onboarding-selected mock model supports the first conversation');
    assert.match(await assistantTextOfRun('bob', firstBobRun.runId), /E2E-ONBOARDING-OK/,
      'first conversation uses the model selected at account creation');
    assert.equal(docker(`inspect ${fdeContainer('bob')} --format {{.State.Status}}`).trim(), 'running',
      'FDE container remains running after the first conversation');
    assert.ok(readLlmRoutes().includes(`llm-${FDE_NAMES.bob}`), 'onboarding publishes the FDE LLM route');

    console.log('[wp6] ✅ onboarding model selection, LiteLLM key injection, allow-list, key stability, and deprovision checks passed');
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
