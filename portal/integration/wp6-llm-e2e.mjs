// WP6 端到端（issue #38 Phase C）：LLM 注入链路 + admin 配置面全链路验证。
// 链路：FDE 容器 agentd/worker（占位 config.json，endpoint=llm.<baseDomain>）→ Traefik
//   （llm-routes.yml：per-FDE router Host(llmHost)+ClientIP(精确 subnet)，middleware 注入真 key）
//   → provider service url（http://127.0.0.1:4000，Traefik host 网络回环可达）→ mock-llm。
// 另验证：迁移 0002 生效、admin API 掩码回显、心跳下行模型集（run 边界生效）、
//   换模型 key 保留、非 admin 403、deprovision 收敛、无 LLM 配置 FDE（bob）旧格式兼容。
// 骨架与起栈方式同 wp2b-e2e/wp5-e2e（docker/psql/api helper、STATION_DB_DIR、compose up/down）。
// ⚠️ 不可与其它 e2e 并行（独占本机 station 栈 + DB 目录）。key 只进断言/配置，不进日志输出。
// 运行：npm run test:integration:wp6
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const MOCK = 'http://127.0.0.1:4000';
const FDE_IMAGE = 'erix-station/fde:local';
// e2e 专用上游 key（形态有意非 erix-*：mock 虚拟 key 校验按设计 401——注入断言靠
// __debug/last-request 记录而非响应；run 因此以 failed 终态完成属预期，见各断言注释）。
const API_KEY = 'sk-e2e-abcdef123456';
const API_KEY_MASK = `sk-...${API_KEY.slice(-4)}`;
// agentd 心跳周期 15s（runner/agentd.js CFG.heartbeatMs 默认）：下行模型集至少等 2 个周期 + 余量。
const HEARTBEAT_MS = 15000;

// llmHost 唯一口径 = config.llmHost（portal/src/config.js）：env.LLM_HOST || `llm.${BASE_DOMAIN}`；
// compose 以 LLM_HOST=llm.${BASE_DOMAIN:-localhost} 注入 → 与本函数同源于 deploy/.env 的 BASE_DOMAIN。
function resolveLlmHost() {
  let baseDomain = 'localhost';
  try {
    const envText = fs.readFileSync(path.join(REPO_ROOT, 'deploy/.env'), 'utf8');
    const m = /^BASE_DOMAIN=(.+)$/m.exec(envText);
    if (m && m[1].trim()) baseDomain = m[1].trim();
  } catch { /* 缺 .env → 用 compose 默认 localhost */ }
  return `llm.${baseDomain}`;
}
const LLM_HOST = resolveLlmHost();

function docker(args) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}
function dockerStdin(args, input) {
  return execSync(`sg docker -c ${JSON.stringify(`docker ${args}`)}`, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
}
const DB_DIR = (process.env.STATION_DB_DIR || '/docker/station-db').replace(/\/+$/, '');
function removeDbDir() {
  const parent = path.posix.dirname(DB_DIR);
  const name = path.posix.basename(DB_DIR);
  safe(() => docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`));
}
function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT, env: { ...process.env, ...env } });
}
function safe(fn) { try { return fn(); } catch { return null; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, { label, timeoutMs, intervalMs = 500 }) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}
function psql(query) {
  return docker(`exec station-db psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}
function readCookie(setCookie) {
  const m = /fde_session_dev=([^;]+)/.exec(setCookie ?? '');
  return m ? m[1] : null;
}
// llm-routes.yml 是 root:root 0600（portal 容器内写入），e2e 进程非 root 无法直读——
// 经 docker（root）读宿主 bind mount 目录：既拿到内容也拿到真实权限位。
const readLlmRoutes = () => safe(() => docker(`run --rm -v ${S.dynamicRoot}:/d:ro alpine cat /d/llm-routes.yml 2>/dev/null`)) ?? '';
const llmRoutesMode = () => safe(() => docker(`run --rm -v ${S.dynamicRoot}:/d:ro alpine stat -c %a /d/llm-routes.yml 2>/dev/null`))?.trim() ?? '';
async function mockLastRequest() {
  const r = await fetch(`${MOCK}/__debug/last-request`);
  if (r.status === 204) return null;
  assert.equal(r.status, 200, 'debug 端点 200');
  return r.json();
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  password: 'correct horse battery staple',
  adminCookie: null,
  adminTotp: null,
  users: {}, // name -> { cookie, totpSecret, projectId, sessionId }
};

const FDE_ENV = {
  FDE_IMAGE,
  FDE_CMD: '[]',
  FDE_DEV_USER: '',
  FDE_DEV_MODE: '1',
  FDE_AGENT_VERSION: '0.1.0',
  MOCK_LATENCY_MS: '0',
};

async function login(loginName, secret, password = S.password) {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  assert.equal(step1.status, 200, `login step1 (${loginName})`);
  const { pending_token } = await step1.json();
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code: totp.totp(secret) }),
  });
  assert.equal(step2.status, 200, `login step2 (${loginName})`);
  const cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(cookie, `session cookie (${loginName})`);
  return cookie;
}

async function api(cookie, p, opts = {}) {
  const r = await fetch(`${PORTAL}${p}`, {
    method: opts.method ?? 'GET',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${cookie}`, ...(opts.headers ?? {}) },
    body: opts.body,
  });
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
}

/** admin API（S.adminCookie 会话）。 */
async function adminApi(p, opts = {}) {
  return api(S.adminCookie, p, opts);
}

/** bootstrap-admin CLI（口令不含空格，避开 shell 引号传递歧义）→ 解析一次性 TOTP 种子。 */
const ADMIN_PASSWORD = 'wp6-admin-pass-123';
function bootstrapAdmin(loginName) {
  const out = docker(`exec station-portal node portal/src/cli.js bootstrap-admin --login ${loginName} --password ${ADMIN_PASSWORD}`);
  const m = /种子（[^\n]*）：([A-Z2-7]{16,})/.exec(out);
  assert.ok(m, 'bootstrap-admin 输出含 TOTP 种子行（输出不入日志）');
  return m[1];
}

/** 经 admin API 建 FDE 用户（响应一次性下发 totp_secret）。 */
async function createFdeUser(loginName) {
  const r = await adminApi('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify({ login: loginName, display_name: loginName, password: S.password, fde_name: loginName }),
  });
  assert.equal(r.status, 201, `create user ${loginName}: ${JSON.stringify(r.body)}`);
  assert.ok(r.body.totp_secret, 'totp_secret 一次性下发');
  return r.body.totp_secret;
}

async function createProject(name) {
  const r = await api(S.users[name].cookie, '/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'proj1', repo_url: `https://git.example/${name}/proj1.git`, template: 'node' }),
  });
  assert.equal(r.status, 201, `create project (${name}): ${JSON.stringify(r.body)}`);
  S.users[name].projectId = r.body.project.id;
}

async function createSession(name) {
  const r = await api(S.users[name].cookie, '/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ project_id: S.users[name].projectId, title: 'wp6' }),
  });
  assert.equal(r.status, 201, `create session (${name}): ${JSON.stringify(r.body)}`);
  S.users[name].sessionId = r.body.session.id;
}

/** 发消息建 run → 等终态（finished/failed）。mock 对非 erix-* key 按设计 401 → run 以 failed
 *  终态完成属预期：本 e2e 的注入证据是 mock 记录的请求头/模型，不是 run 成败。 */
async function sendMessageAndWait(name, content, timeoutMs = 180000) {
  const sent = await api(S.users[name].cookie, `/api/sessions/${S.users[name].sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content }),
  });
  assert.equal(sent.status, 202, `send message (${name}): ${JSON.stringify(sent.body)}`);
  const runId = sent.body.run.id;
  const st = await waitFor(() => {
    const s = psql(`SELECT status FROM runs WHERE id='${runId}'`);
    return s === 'finished' || s === 'failed' ? s : null;
  }, { label: `run ${runId} terminal`, timeoutMs, intervalMs: 500 });
  return { runId, status: st };
}

async function provisionFde(name) {
  docker(`exec station-portal node portal/src/cli.js provision-fde --fde-name ${name}`);
  await waitFor(() => (docker(`inspect fde-${name} --format {{.State.Status}}`).trim() === 'running' ? true : null),
    { label: `fde-${name} running`, timeoutMs: 90000 });
  await waitFor(() => (docker(`logs fde-${name} 2>&1`).includes('sse ping received') ? true : null),
    { label: `fde-${name} agentd sse ping`, timeoutMs: 90000, intervalMs: 1000 });
}

/** 等心跳下行模型集落 agentd 内存（2 个心跳周期 + 余量；下行无文件/日志可观测，固定等待）。 */
async function waitHeartbeatDownlink(cycles = 2) {
  await sleep(cycles * HEARTBEAT_MS + 5000);
}

test('WP6 端到端：LLM 注入链路（config → admin API → Traefik 注入 → 心跳下行 → run 生效）+ 全量回归', { timeout: 20 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp6-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp6-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker('rm -f fde-alice fde-bob 2>/dev/null || true'));
    safe(() => docker('network rm fde-alice fde-bob 2>/dev/null || true'));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local erix-station/mock-llm:local 2>/dev/null || true'));
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理 + 重建 runner 镜像（含真实 agentd/worker）
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    removeDbDir();
    safe(() => docker(`rmi -f ${FDE_IMAGE} 2>/dev/null || true`));
    docker(`build -t ${FDE_IMAGE} runner/`);

    // 1) 起栈（build 含 mock-gateway 重建；MIGRATE_ON_START=1 真实迁移 runner）
    compose('up -d --build', {
      ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
      TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
      MIGRATE_ON_START: '1',
      ...FDE_ENV,
    });
    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000, intervalMs: 1000 });

    // 2) 迁移 0002 已应用 + 三表/新列存在（baseline schema.sql 冻结，只能来自增量迁移）
    assert.equal(psql(`SELECT count(*) FROM schema_migrations WHERE version='0002-llm-config'`), '1',
      '增量迁移 0002 已落 schema_migrations');
    assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='llm_providers'`), '1', 'llm_providers 存在');
    assert.equal(psql(`SELECT count(*) FROM information_schema.tables WHERE table_name='llm_models'`), '1', 'llm_models 存在');
    for (const col of ['provider_id', 'api_key', 'main_model_id', 'embedding_model_id', 'vision_model_id']) {
      assert.equal(
        psql(`SELECT count(*) FROM information_schema.columns WHERE table_name='fde_llm_bindings' AND column_name='${col}'`),
        '1',
        `fde_llm_bindings.${col} 存在`,
      );
    }

    // 3) admin（bootstrap CLI）+ FDE 用户（admin API，totp_secret 一次性下发）
    S.adminTotp = bootstrapAdmin('admin-wp6');
    S.adminCookie = await login('admin-wp6', S.adminTotp, ADMIN_PASSWORD);
    for (const name of ['alice', 'bob']) {
      const secret = await createFdeUser(name);
      S.users[name] = { cookie: await login(name, secret), totpSecret: secret };
    }

    // 4) admin API：provider（base_url 宿主回环 mock；Traefik host network 可达）+ 模型 A + alice 绑定
    const provider = await adminApi('/api/admin/llm/providers', {
      method: 'POST',
      body: JSON.stringify({ name: 'mock-e2e', base_url: `${MOCK}` }),
    });
    assert.equal(provider.status, 201, `create provider: ${JSON.stringify(provider.body)}`);
    const providerId = provider.body.provider.id;
    const modelA = await adminApi(`/api/admin/llm/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify({ model_id: 'mock-model-a', name: 'Mock A', type: 'text', tool_calling: true }),
    });
    assert.equal(modelA.status, 201, `create model A: ${JSON.stringify(modelA.body)}`);
    const modelAId = modelA.body.model.id;
    const put1 = await adminApi('/api/admin/fdes/alice/llm', {
      method: 'PUT',
      body: JSON.stringify({ provider_id: providerId, api_key: API_KEY, main_model_id: modelAId }),
    });
    assert.equal(put1.status, 200, `put fde llm: ${JSON.stringify(put1.body)}`);
    // 红线 ②：响应只给掩码，绝不回显真 key
    assert.equal(put1.body.config.api_key, API_KEY_MASK, 'api_key 掩码回显（sk-...last4）');
    assert.ok(!JSON.stringify(put1.body).includes(API_KEY), '响应体不含真 key');
    const getEcho = await adminApi('/api/admin/fdes/alice/llm');
    assert.equal(getEcho.status, 200);
    assert.equal(getEcho.body.config.api_key, API_KEY_MASK, 'GET 回显同掩码');
    assert.ok(getEcho.body.active_run === false, '无 active run');

    // 5) provision alice（CLI 真建容器/网络）→ 等路由发布
    await createProject('alice');
    await provisionFde('alice');
    const aliceSubnet = psql(`SELECT subnet FROM fde_networks n JOIN users u ON u.id=n.fde_id WHERE u.fde_name='alice'`);
    assert.ok(aliceSubnet, 'alice subnet 分配');
    await waitFor(() => {
      const txt = readLlmRoutes();
      return txt.includes('llm-alice:') ? txt : null;
    }, { label: 'llm-routes.yml 含 llm-alice', timeoutMs: 60000 });

    // 6) 发布物断言：per-FDE router + 精确 subnet + key 注入 + mode 600 + 模型名不进 Traefik
    const routes1 = readLlmRoutes();
    assert.ok(routes1.includes(`llm-alice:`), 'router llm-alice 存在');
    assert.ok(routes1.includes(`Host(\`${LLM_HOST}\`)`), `Host 规则用 llmHost=${LLM_HOST}（config 同源）`);
    assert.ok(routes1.includes(`ClientIP(\`${aliceSubnet}\`)`), 'ClientIP 精确 subnet（alice /29）');
    assert.ok(routes1.includes(`llm-key-alice`), 'key middleware 成对');
    assert.ok(routes1.includes(`Bearer ${API_KEY}`), 'llm-routes.yml 含注入的上游 key（明文仅在此 mode 600 文件）');
    assert.ok(!routes1.includes('mock-model-a'), '模型名不进 Traefik 配置（不进路由文件）');
    assert.equal(llmRoutesMode(), '600', 'llm-routes.yml mode 600（宿主侧权限位）');

    // 7) 心跳下行模型集 → run 边界生效：注入链路实测（authorization + model 双证据）
    await waitHeartbeatDownlink(2);
    await createSession('alice');
    const run1 = await sendMessageAndWait('alice', 'WP6 注入链路验收：请回复任意内容');
    assert.equal(run1.status, 'failed', 'mock 按设计 401 非 erix-* key → run failed 终态（注入证据见下）');
    const seen1 = await mockLastRequest();
    assert.ok(seen1, 'mock 收到经 Traefik 注入的请求（FDE 容器 → Traefik → 127.0.0.1:4000 链路成立）');
    // 注入成功：Authorization 被换成真 key（掩码后四位 3456）；下行生效：model 用真模型名
    assert.ok(seen1.authorization === `Bearer ${API_KEY}`, `注入 key 命中（掩码 …${API_KEY.slice(-4)}）`);
    assert.equal(seen1.model, 'mock-model-a', '心跳下行模型集生效：run 请求体 model=mock-model-a');

    // 8) 换模型（不传 api_key = 保留旧值）→ 心跳刷新 → 新 run：model 变、key 不变
    const modelB = await adminApi(`/api/admin/llm/providers/${providerId}/models`, {
      method: 'POST',
      body: JSON.stringify({ model_id: 'mock-model-b', name: 'Mock B', type: 'text', tool_calling: true }),
    });
    assert.equal(modelB.status, 201, `create model B: ${JSON.stringify(modelB.body)}`);
    const put2 = await adminApi('/api/admin/fdes/alice/llm', {
      method: 'PUT',
      body: JSON.stringify({ provider_id: providerId, main_model_id: modelB.body.model.id }),
    });
    assert.equal(put2.status, 200, `put fde llm (model B, no api_key): ${JSON.stringify(put2.body)}`);
    assert.equal(put2.body.config.api_key, API_KEY_MASK, 'api_key 未重传 = 保留旧值（掩码不变）');
    await waitHeartbeatDownlink(2);
    const run2 = await sendMessageAndWait('alice', 'WP6 换模型验收：请回复任意内容');
    assert.equal(run2.status, 'failed', 'run2 同样 401 终态（预期）');
    const seen2 = await mockLastRequest();
    assert.equal(seen2.model, 'mock-model-b', '换模型生效：新 run 的 model=mock-model-b');
    assert.ok(seen2.authorization === `Bearer ${API_KEY}`, `key 未重传仍保留（掩码 …${API_KEY.slice(-4)}）`);
    const routes2 = readLlmRoutes();
    assert.ok(routes2.includes('llm-alice:') && routes2.includes(`Bearer ${API_KEY}`), '换模型后路由仍在且 key 不变');
    assert.ok(!routes2.includes('mock-model-b'), '模型名仍不进 Traefik 配置');

    // 9) 非 admin 403：FDE 用户会话调 admin API
    const forbiddenGet = await api(S.users.alice.cookie, '/api/admin/llm/providers');
    assert.equal(forbiddenGet.status, 403, `非 admin GET admin API → 403（得 ${forbiddenGet.status}）`);
    const forbiddenPut = await api(S.users.alice.cookie, '/api/admin/fdes/alice/llm', {
      method: 'PUT',
      body: JSON.stringify({ provider_id: providerId, api_key: 'sk-should-not-work', main_model_id: modelAId }),
    });
    assert.equal(forbiddenPut.status, 403, `非 admin PUT admin API → 403（得 ${forbiddenPut.status}）`);

    // 10) deprovision alice：路由收敛（llm-alice 消失、binding revoked）+ mock 不再收到新请求
    const tsBeforeDeprovision = (await mockLastRequest())?.ts ?? 0;
    docker('exec station-portal node portal/src/cli.js deprovision-fde --fde-name alice');
    await waitFor(() => {
      const gone = safe(() => docker('inspect fde-alice --format {{.Id}}').trim());
      return gone ? null : true;
    }, { label: 'fde-alice container removed', timeoutMs: 90000 });
    await waitFor(() => {
      const txt = readLlmRoutes();
      return !txt.includes('llm-alice') ? true : null;
    }, { label: 'llm-routes.yml 收敛（无 llm-alice）', timeoutMs: 60000 });
    assert.equal(psql(`SELECT state FROM fde_llm_bindings b JOIN users u ON u.id=b.fde_id WHERE u.fde_name='alice'`), 'revoked',
      'offboard 同事务吊销 binding（revoked）');
    await sleep(3000);
    const seenAfter = await mockLastRequest();
    assert.ok(!seenAfter || seenAfter.ts === tsBeforeDeprovision, 'deprovision 后 mock 无新请求（last-request ts 不变）');

    // 11) 旧格式兼容：无 LLM 配置的 FDE（bob）provision + run 正常收敛（占位模型名路径不崩）
    await createProject('bob');
    await provisionFde('bob');
    await waitFor(() => {
      const txt = readLlmRoutes();
      return !txt.includes('llm-bob') ? true : null;
    }, { label: 'llm-routes.yml 无 llm-bob（fail-closed 不发布）', timeoutMs: 60000 });
    await createSession('bob');
    const tsBeforeBob = (await mockLastRequest())?.ts ?? 0;
    const runBob = await sendMessageAndWait('bob', 'WP6 旧格式兼容验收：无 LLM 配置的 FDE');
    assert.ok(['finished', 'failed'].includes(runBob.status), `bob run 终态收敛（得 ${runBob.status}）`);
    const seenBob = await mockLastRequest();
    assert.ok(!seenBob || seenBob.ts === tsBeforeBob,
      'bob 无 LLM 路由：请求未达 mock（fail-closed，last-request ts 不变）');
    // bob 容器/agentd 仍健康（心跳链路不受无配置影响）
    assert.equal(docker(`inspect fde-bob --format {{.State.Status}}`).trim(), 'running', 'bob 容器仍 running');
    const routesFinal = readLlmRoutes();
    assert.ok(!routesFinal.includes('llm-bob'), 'llm-routes.yml 始终无 llm-bob');

    // eslint-disable-next-line no-console
    console.log(`\n[wp6] ✅ LLM 注入链路全绿：llmHost=${LLM_HOST} subnet=${aliceSubnet} ` +
      `注入=Bearer…${API_KEY.slice(-4)} model=mock-model-a→mock-model-b（心跳下行） key 保留 掩码=${API_KEY_MASK} ` +
      '非 admin 403 / deprovision 收敛 / bob 旧格式兼容');
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[wp6] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-portal --tail 80 2>&1'));
      // eslint-disable-next-line no-console
      console.log('\n[wp6] --- fde-alice logs ---');
      // eslint-disable-next-line no-console
      console.log(safe(() => docker('logs fde-alice --tail 60 2>&1')) ?? '(container gone)');
    } catch { /* 尽力 */ }
    throw err;
  }
});
