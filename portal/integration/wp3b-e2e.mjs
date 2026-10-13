// WP3b 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈（含 LiteLLM）→ 建用户 + 两步登录 → 建会话（P5「目录即项目」：POST /api/sessions 建目录）
//   + 重启 portal 触发物化写 config.json → provision FDE（真实 runner 镜像）→ agentd SSE 连接 + ping
//   → 发消息建 run（真实 API：同事务落 transcript 用户轮次 + run 入队，§4.3）
//   → worker 跑 erix-agent runToolLoop（LiteLLM mock model）→ 事件 seq 落库 → 终态 + run_end + usage 记账
//   → 崩溃恢复：run 进行中 docker kill FDE（SIGKILL，不给优雅 drain 机会）→ docker 依
//     RestartPolicy=unless-stopped 自动拉起 → 新 agentd re-claim（attempt+1、resume=true）→ 终态。
// 运行：npm run test:integration:wp3b
//
// 并行隔离用法（F8；#227.1 起先过 assertIsolatedEnvironment 硬护栏，不合规直接拒跑）：
// 不拆共享栈（station-*）的前提下跑隔离栈——所有固定名/端口经 env 派生，容器名/镜像 tag/FDE 名
// 必须含栈 id，端口/子网/IPAM 池必须区别于共享栈（判据在 lib/isolated-env.mjs）：
//   STATION_STACK_ID=e2e43 COMPOSE_PROJECT_NAME=e2e43 STATION_DB_DIR=/tmp/station-db-e2e43（必须不存在）\
//   STATION_DB_NAME=station-db-e2e43 STATION_PORTAL_NAME=station-portal-e2e43 \
//   STATION_LITELLM_NAME=station-litellm-e2e43 STATION_DOCKER_PROXY_NAME=station-docker-proxy-e2e43 \
//   STATION_EDGE_NAME=station-edge-e2e43 \
//   PORTAL_HOST_PORT=28080 LITELLM_HOST_PORT=24400 \
//   TRAEFIK_WEB_PORT=18090 TRAEFIK_WEBSECURE_PORT=18443 FDE_NAME=e2e43alice \
//   BACKEND_SUBNET=172.33.0.0/24 FDE_POOL=large FDE_DEV_MODE=1 \
//   IPAM_RESERVED_SUBNETS=10.200.0.0/29,10.200.0.32/29（可选；隔离模式未设时自动派生）\
//   FDE_IPAM_POOLS（#227.3：未设时由 deriveFdeIpamPools(栈 id) 派生本栈专用段，显式传入优先）\
//   PORTAL_PUBLIC_BASE_URL=http://station.localhost:18090 \
//   PORTAL_INTERNAL_HOSTS=station.localhost \
//   FDE_IMAGE=erix-station/fde:e2e43 STATION_PORTAL_IMAGE=erix-station/portal:e2e43 \
//   STATION_DOCKER_PROXY_IMAGE=erix-station/fde-proxy:e2e43 \
//   node portal/integration/wp3b-e2e.mjs
//
// —— 隔离栈必传 env 清单（每条一句为什么）——
//   STATION_LITELLM_NAME / STATION_DOCKER_PROXY_NAME / STATION_EDGE_NAME：compose 用它们做
//     **容器名**（deploy/docker-compose.yml:239/62/285），不派生会与共享栈撞名（container name already in use）。
//   BACKEND_SUBNET：compose backend 网络子网（deploy/docker-compose.yml:13，缺省 172.32.0.0/24），
//     不派生会 **Pool overlaps**。
//   IPAM_RESERVED_SUBNETS：portal 的 IPAM 池**硬编码**（portal/src/ipam.js:12-15，10.200.0.0/16，**非 env 可配**），
//     隔离栈 DB 是空的 → 会从池头分配 10.200.0.0/29，与共享栈已占段**重叠**（实测 403 Pool overlaps）；
//     必须把**其他栈已用的 fde-* 子网**列进来。
//   PORTAL_PUBLIC_BASE_URL：决定 FDE 容器内 ERIX_STATION_BASE_URL（portal/src/provisioner.js:183）；
//     .env 里是共享栈值（http://100.100.0.3:8090），不派生 → agentd 会去连**共享栈的 Traefik**；
//     本栈应为 http://station.<BASE_DOMAIN>:<TRAEFIK_WEB_PORT>（FDE 容器 /etc/hosts 已把该主机名
//     指向本 FDE 网络网关=宿主）。
//   PORTAL_INTERNAL_HOSTS：决定 internal 路由的 Host 白名单（portal/src/routes.js:170-176）；.env 里是
//     100.100.0.3，不含 station.<BASE_DOMAIN> → agentd 请求 **404 page not found**（实测）。
//   BASE_DOMAIN：隔离栈默认显式注入 localhost，若进程环境提供 BASE_DOMAIN 则使用该值；PORTAL_HOST / LLM_HOST、
//     public URL 与 internal Host 白名单由同一 helper 派生，避免 `--env-file` 恢复为共享伞域。
//   （⚠️ 除域名/端口/固定名外，**子网与三个容器名（litellm/docker-proxy/edge）也必须派生**——
//     否则与共享栈撞 subnet/container_name（compose 缺省 172.32.0.0/24 与 station-* 容器名）。）
//   （自动派生：**仅在隔离模式**（显式设了 STATION_STACK_ID 或任一入口端口/固定名 env）下，脚本对**未显式设置**的
//     BASE_DOMAIN/PORTAL_HOST/LLM_HOST/public URL/internal Host 白名单用 domain helper 派生；
//     IPAM_RESERVED_SUBNETS 扫其他 fde-* 子网补齐；显式进程 env 一律优先，**共享栈缺省零注入**
//     （见 isolationComposeEnv())。
//     fde 容器/网络名 = fde-<FDE_NAME>，由 portal provisioner 生成；compose() 已透传进程 env，
//     COMPOSE_PROJECT_NAME 自动生效。缺省（不带 env）= 18080/4100/8090/8443、station-*、alice。
//     TRAEFIK_STATIC_HOST 无需手传：脚本每次 up 前自动生成「仅替换入口端口」的临时 traefik.yml
//     并经 compose env 注入（Traefik v3 带 --configFile 时 CLI 覆盖不生效，必须整体替换配置文件）。）
//
//   HTTP_PROXY / HTTPS_PROXY：FDE 镜像从 runner/Dockerfile 下载 gh/tea/glab；本机直连 github.com 不通时，
//     会卡在该下载层重试约半小时。代理与构建口径见 lib/fde-image.mjs 文件头及 docs/env.md「本机重建 FDE 镜像」。
// ⚠️ 隔离栈须派生镜像 tag（`FDE_IMAGE`/`STATION_PORTAL_IMAGE`）：脚本**绝不删除共享镜像 tag**
//   （`erix-station/fde:local`/`erix-station/portal:local`）——曾实测 rmi 掉共享 fde 镜像后，
//   共享栈 provision FDE 报 `No such image`。重建走 build context 变更自动失效缓存，不靠删镜像。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';
import { ensureLlmBinding } from './lib/llm-binding.mjs';
import { DEFAULT_FDE_IMAGE, DEFAULT_PORTAL_IMAGE, buildFdeImage } from './lib/fde-image.mjs';
import { BASE_DOMAIN, LLM_HOST, composeDomainEnv } from './lib/compose-domain.mjs';
// issue #226：`writeTraefikStatic` 与隔离护栏本体一样收归公共模块（wp2a/wp3a/wp3b/wp5/wp6 共用一份）。
// #227.1：wp3b 隔离跑法从此也过硬护栏（assertIsolatedEnvironment），removeDbDir 同样收编。
import {
  SHARED_STACK, assertHostPortsAvailable, defaultFdeIpamPools, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
  writeDynamicStub, deriveIsolationComposeEnv, memoizeOnce,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：显式 -p（双模脚本）：隔离跑法必带 COMPOSE_PROJECT_NAME（=栈 id，护栏硬要求，#227.1 起）→
// -p 显式指向本栈；共享跑法（无任何隔离信号）显式 station——两种模式都写死在命令里，不留 `name:` 隐式兜底。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:-station}" --profile litellm --env-file deploy/.env -f deploy/docker-compose.yml';
// F8 并行隔离：固定名/端口全部 env 派生（缺省 = 现状值，共享栈零影响）。
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const LITELLM_HOST_PORT = process.env.LITELLM_HOST_PORT || '4100';
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const LLM_PUBLIC_BASE_URL = DOMAIN_COMPOSE_ENV.LLM_PUBLIC_BASE_URL.replace(/\/+$/, '');
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const STATION_LITELLM_NAME = process.env.STATION_LITELLM_NAME || 'station-litellm';
const FDE_NAME = process.env.FDE_NAME || 'alice';
const FDE_CONTAINER = `fde-${FDE_NAME}`; // provisioner 命名规则：fde-<fde_name>
const FDE_IMAGE = process.env.FDE_IMAGE || DEFAULT_FDE_IMAGE;
const PORTAL_IMAGE = process.env.STATION_PORTAL_IMAGE || DEFAULT_PORTAL_IMAGE;

// 隔离信号：显式设了栈标识 / 固定名 / 端口 / 子网 / DB / FDE 名任一 → 判定为隔离栈。
// 共享栈跑法（不带任何这些 env）→ 一个都不命中 → 零注入旧语义（与 #226 改造前一致）。
// #227.1：同一判据现在也决定护栏开关——隔离跑法必过硬护栏，共享跑法保持零注入旧语义。
const ISOLATION_SIGNAL_KEYS = [
  'STATION_STACK_ID', 'COMPOSE_PROJECT_NAME', 'STATION_DB_DIR', 'STATION_DB_NAME',
  'STATION_PORTAL_NAME', 'STATION_LITELLM_NAME', 'STATION_DOCKER_PROXY_NAME',
  'STATION_EDGE_NAME', 'BACKEND_SUBNET', 'FDE_NAME',
  'PORTAL_HOST_PORT', 'LITELLM_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT',
];
const ISOLATED_MODE = ISOLATION_SIGNAL_KEYS.some((k) => process.env[k]);

// #227.3：FDE_IPAM_POOLS 未显式传时按栈 id 派生本栈口径（派生段+portal large 池固定段；显式传入优先）。
if (!process.env.FDE_IPAM_POOLS && process.env.STATION_STACK_ID) {
  process.env.FDE_IPAM_POOLS = defaultFdeIpamPools(process.env.STATION_STACK_ID);
}

// #227.1：护栏参数按 wp3b 实际句柄传——栈含 LiteLLM；单 FDE 名（必须带栈 id、不得等于共享 alice）；
// 镜像不得沿用共享 :local tag（同 wp6 口径）。
function isolatedStackOptions() {
  return {
    litellm: true,
    fdeNames: [{ env: 'FDE_NAME', value: FDE_NAME, sharedDefault: 'alice' }],
    extraForbiddenEnv: [
      ['STATION_PORTAL_IMAGE', DEFAULT_PORTAL_IMAGE],
      ['STATION_DOCKER_PROXY_IMAGE', 'erix-station/fde-proxy:local'],
      ['FDE_IMAGE', DEFAULT_FDE_IMAGE],
    ],
  };
}

// F8（隔离栈必须整体替换 traefik 静态配置的原因见 lib/isolated-env.mjs:writeTraefikStatic）：
// Traefik v3 带 --configFile 时，静态文件里已定义的 entryPoints 会压过 CLI/env 覆盖（实测 file +
// --entrypoints.web.address=:19090 仍绑 :8090 → 抢共享 edge 端口）。#226：生成函数已提到公共模块（与
// wp2a/wp3a/wp5/wp6 共用一份），本脚本只传入自己的入口端口。

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

// #227.1（removeDbDir 收编单一来源，解析/删除本体在 lib/isolated-env.mjs）。语义迁移口径：
// • 隔离跑法 ⇒ 与 wp2a 完全同（缺 STATION_DB_DIR 硬失败 + 只允许删临时目录内的路径）；
// • 共享跑法（无任何隔离信号）⇒ 保留「重置共享 dev 库 /docker/station-db」的既定语义，但改为
//   **显式** env 注入（缺省补 STATION_DB_DIR + ERIX_E2E_ALLOW_DB_DIR=1 豁免），不再靠脚本内私有缺省。
//   （lib 的「共享重置」选项（resolveDbDir 第三参）只允许 wp2b 声明——wp3b 用上面的 env 形态表达同一语义，
//     选项出现处由 isolation-negative 的单一来源断言钉住。）
const { removeDbDir } = createDbDirCleaner({
  docker,
  env: ISOLATED_MODE
    ? process.env
    : { ...process.env, STATION_DB_DIR: process.env.STATION_DB_DIR || SHARED_STACK.dbDir, ERIX_E2E_ALLOW_DB_DIR: '1' },
});

function compose(args, env = {}) {
  // F8：隔离模式下注入自动派生 env（IPAM 保留段 / public base url / internal hosts）。
  // 共享栈缺省（isolationComposeEnv() 返回 {}）→ 注入零变化。派生值只进 compose 的 env 对象，
  // **不改 process.env 全局**；shell env 优先级高于 --env-file，故可覆盖 deploy/.env 的共享栈值。
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...isolationComposeEnv(), ...env },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// F8：隔离模式自动派生 env（仅在「隔离栈」下生效；共享栈缺省 = 零注入）。
// （ISOLATION_SIGNAL_KEYS / ISOLATED_MODE 的定义已上移到常量区，#227.1 护栏与 DB cleaner 共用。）
// ---------------------------------------------------------------------------

/**
 * 推导隔离栈应注入 compose 的 env（未显式设置时）。返回 {} 表示共享栈缺省、不注入任何值。
 * 两项均遵循「显式设置优先」：process.env 已有值则不动。
 * #268 M2：IPAM_RESERVED_SUBNETS 的扫描派生本体已提到 lib/isolated-env.mjs:deriveIsolationComposeEnv
 *（与 wp3a 共用一份；扫描行为与提 lib 前的内联实现逐字等价，含「排除本栈 fde-<FDE_NAME>」口径）。
 */
function deriveIsolationEnv() {
  if (!ISOLATION_SIGNAL_KEYS.some((k) => process.env[k])) return {};
  return deriveIsolationComposeEnv({
    docker,
    ownFdeNetwork: FDE_CONTAINER, // = fde-<FDE_NAME>，本栈自己的网络（扫描时排除）
    baseEnv: DOMAIN_COMPOSE_ENV,
    // 显式传了 IPAM_RESERVED_SUBNETS ⇒ 不扫描不注入（shell env 本就会压过注入，这里连查都不查）。
    skipIpamReserved: Boolean(process.env.IPAM_RESERVED_SUBNETS),
  });
}

// 惰性求值 + 记忆化：首个 compose 调用（预清理 down）时算一次即可，避免每次 compose 都查 docker。
const isolationComposeEnv = memoizeOnce(deriveIsolationEnv);

async function waitFor(fn, { timeoutMs = 120000, intervalMs = 500, label = 'condition' } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? `: ${lastErr.message}` : ''}`);
}

function readCookie(setCookie) {
  const first = (setCookie || '').split(',')[0];
  const nameVal = first.split(';')[0];
  const idx = nameVal.indexOf('=');
  return nameVal.slice(idx + 1);
}

function psql(query) {
  return docker(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  artifactsRoot: null,
  staticFile: null,
  userId: '00000000-0000-0000-0000-000000000001',
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
  sessionId: null,
  token: null,
  gateway: null,
  networkName: null,
  subnet: null,
  containerId: null,
};

const FDE_ENV = {
  FDE_IMAGE,
  FDE_CMD: '[]',
  FDE_DEV_USER: '',
  FDE_DEV_MODE: '1',
  FDE_AGENT_VERSION: '0.1.0',
};

async function insertUser() {
  const passwordHash = await auth.hashPassword(S.password);
  S.totpSecret = totp.generateSecret(20);
  const sql = `
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${S.userId}', 'alice', 'Alice', 'fde', '${FDE_NAME}', 'local', 'active',
            '${passwordHash}', '${S.totpSecret}');
  `;
  psqlStdin(sql);
}

async function login() {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'alice', password: S.password }),
  });
  assert.equal(step1.status, 200, 'login step1');
  const { pending_token } = await step1.json();
  const code = totp.totp(S.totpSecret);
  const step2 = await fetch(`${PORTAL}/api/auth/login/totp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pending_token, code }),
  });
  assert.equal(step2.status, 200, 'login step2');
  S.cookie = readCookie(step2.headers.get('set-cookie'));
  assert.ok(S.cookie, 'session cookie');
}

/**
 * 建会话（P5「目录即项目」）：`POST /api/sessions` 校验 cwd 形态（portal/src/sessions.js CWD_RE
 * `~/projects/<一级目录名>`）并按需 mkdir，同时落 chat_sessions 行。
 * 旧项目注册（POST /api/projects）已退役（410 project_api_retired），目录与「项目」由本端点自动创建。
 */
async function createSession() {
  const r = await fetch(`${PORTAL}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
    body: JSON.stringify({ cwd: '~/projects/proj1', title: 'wp3b' }),
  });
  const body = await r.json();
  assert.equal(r.status, 201, `create session: ${JSON.stringify(body)}`);
  S.sessionId = body.session.id;
  assert.ok(S.sessionId, 'session id');
}

/**
 * 真实写路径发用户消息（P3 起 transcript 为正文单一真相）：`POST /api/sessions/:id/messages`
 * 在同一事务内 appendUserInputTurn（引擎落 transcript 用户轮次）+ 建 run + 入队 run_queue
 * （portal/src/sessions.js postMessage）。
 * run id 由 portal 生成（§9.3-3 禁止 cwd 派生）——调用方只能从 202 响应体取，脚本不再自造 id。
 */
async function sendMessage(sessionId, content) {
  const r = await fetch(`${PORTAL}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
    body: JSON.stringify({ content }),
  });
  const body = await r.json();
  assert.equal(r.status, 202, `send message: ${JSON.stringify(body)}`);
  assert.equal(body.run?.status, 'queued', 'run 入队（queued）');
  assert.ok(body.run?.id, 'run id from response');
  return body.run.id;
}

/**
 * 重启 portal 触发启动全量重物化（user-space §8.1 rebuildAllFdes）。
 * 为什么必须做：P5 起 `POST /api/sessions` 只建目录+会话、**不再 enqueue materialize**
 * （退役的 `POST /api/projects` 曾同事务写 materialize outbox），而 worker 的模型 provider
 * 读 `~/.erix/config.json`（runner/worker.js:207）——不重启则 config.json 永不出现。
 * 口径与 wp5/wp6 e2e 一致。
 */
async function restartPortal() {
  docker(`restart ${STATION_PORTAL_NAME}`);
  await waitFor(async () => (await fetch(`${PORTAL}/healthz`).catch(() => null))?.status === 200,
    { label: 'portal healthz after restart', timeoutMs: 120000, intervalMs: 500 });
}

function readTokenFromContainer() {
  const inspect = JSON.parse(docker(`inspect ${FDE_CONTAINER}`));
  const env = inspect[0].Config.Env || [];
  const line = env.find((e) => e.startsWith('ERIX_STATION_TOKEN='));
  return line ? line.slice('ERIX_STATION_TOKEN='.length) : null;
}

function agentdLogs() {
  return docker(`logs ${FDE_CONTAINER} --tail 200 2>&1`);
}

// 全量 agentd 日志（不带 --tail）：用于跨「容器重启」边界仍能看到的证据（resume=true spawn、
// ping 计数切片）。--tail 窗口滚动会让早期行丢失，故这些口径必须用全量。
function agentdFullLogs() {
  return docker(`logs ${FDE_CONTAINER} 2>&1`);
}

// 崩溃恢复弱等待收紧（issue #180 报告遗留项 1）：`docker logs` 跨容器重启保留历史，且 agentd 的
// `sse ping received` 每个进程**只记一次**（runner/agentd.js:303-306 `state.sawPing` 单次守卫）——
// 所以「日志里出现过 ping」在 kill 后被【旧 agentd】的历史秒过（= 没等新 agentd 上线）。
// 改为切片比对：kill 前记录出现次数作基线，kill 后等待出现【更多】的那一条（次数 +1 = 新 agentd
// 进程已连上 SSE 并收到首个 ping）。用全量日志保证「次数只增不减」（--tail 滚动会破坏该前提）。
function countAgentdPings() {
  return (agentdFullLogs().match(/sse ping received/g) || []).length;
}

test('WP3b 端到端：真实 runner 镜像 + agentd/worker + mock LLM + 崩溃恢复', { timeout: 15 * 60 * 1000 }, async (t) => {
  // #227.1：隔离跑法起栈前必过硬护栏（此前 wp3b 无护栏：端口/容器名/子网与共享栈同值不会挡，
  // 漏 BACKEND_SUBNET 只得到 Pool overlaps 崩溃）。共享跑法（无任何隔离信号）保持旧语义、跳护栏。
  if (ISOLATED_MODE) {
    assertIsolatedEnvironment(isolatedStackOptions());
    await assertHostPortsAvailable([PORTAL_HOST_PORT, LITELLM_HOST_PORT, TRAEFIK_WEB_PORT,
      process.env.TRAEFIK_WEBSECURE_PORT || '8443']);
  }
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp3b-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp3b-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp3b-'));
  S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp3b-'));
  S.staticFile = writeTraefikStatic(S.staticRoot, {
    repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: process.env.TRAEFIK_WEBSECURE_PORT || '8443',
  });
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);
  fs.chmodSync(S.artifactsRoot, 0o755);
  // #268 M1：预写 edge watch 桩（坑见 lib/isolated-env.mjs:writeDynamicStub：edge 启动时没有 routes.yml
  // 则 watch 落空，materializer 原子替换永不被 reload）。必须在任何 compose up 之前。
  writeDynamicStub(S.dynamicRoot);

  const cleanup = () => {
    safe(() => docker(`rm -f ${FDE_CONTAINER} 2>/dev/null || true`));
    safe(() => docker(`network rm fde-${FDE_NAME} 2>/dev/null || true`));
    safe(() => compose('down -v', {
      ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
      TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
      TRAEFIK_STATIC_HOST: S.staticFile,
      ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
    }));
    // issue #178：**不删镜像**。镜像名已 env 派生（FDE_IMAGE/STATION_PORTAL_IMAGE）→ 隔离栈有自己的
    // tag；默认共享 tag 绝不能被 e2e 删除（曾把共享 fde 镜像删掉，共享栈 provision 报 No such image）。
    // compose up -d --build 与 docker build 按 build context 变更自动失效缓存，无需靠删镜像强制重建。
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.artifactsRoot, { recursive: true, force: true }));
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理
    safe(() => compose('down -v', {
      ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
      TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
      TRAEFIK_STATIC_HOST: S.staticFile,
      ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
    }));
    removeDbDir();
    console.log(`[wp3b] 镜像：FDE=${FDE_IMAGE} PORTAL=${PORTAL_IMAGE}（默认共享 tag 一律不动，issue #178）`);

    // 1) 构建真实 runner 镜像（build context runner/；带 proxy build args + 流式输出）
    buildFdeImage(FDE_IMAGE);

    // 2) 起栈（含 LiteLLM；FDE 用真实 runner 镜像：tag + dev-mode + 无 --user）。
    // MIGRATE_ON_START=1：启动迁移完成后，管理台 API 才能创建 credential/model/binding。
    compose('up -d --build', {
      ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
      TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
      TRAEFIK_STATIC_HOST: S.staticFile,
      ERIX_ARTIFACTS_ROOT_HOST: S.artifactsRoot,
      MIGRATE_ON_START: '1',
      LITELLM_HOST_PORT,
      LLM_GATEWAY_HOST: `http://127.0.0.1:${LITELLM_HOST_PORT}`,
      ...FDE_ENV,
    });

    await waitFor(async () => {
      const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
      return r && r.status === 200;
    }, { label: 'portal healthz', timeoutMs: 240000 });

    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${LITELLM_HOST_PORT}/health/readiness`).catch(() => null);
      return r && r.status === 200;
    }, { label: `LiteLLM readiness (${STATION_LITELLM_NAME})`, timeoutMs: 120000 });

    // 3) 建用户 + 两步登录 + 建会话（P5 目录即项目：自动建 ~/projects/proj1 + chat_sessions 行）
    await insertUser();
    await login();
    await createSession();

    // P5 起 POST /api/sessions 不再 enqueue materialize（退役的 POST /api/projects 才会）——
    // 经 portal 重启触发启动全量重物化，让 worker 读的 ~/.erix/config.json 落盘。
    await restartPortal();

    // 等 config.json 物化（materializer 250ms 循环；路径段 = fde_name）
    const configJsonPath = path.join(S.userspaceRoot, FDE_NAME, 'home', '.erix', 'config.json');
    await waitFor(() => (fs.existsSync(configJsonPath) ? fs.readFileSync(configJsonPath, 'utf8') : null), { label: 'config.json materialized' });
    const configJson = JSON.parse(fs.readFileSync(configJsonPath, 'utf8'));
    assert.equal(configJson.slots.default.endpoint, `${LLM_PUBLIC_BASE_URL}/v1`,
      `config.json endpoint 指向派生的 LLM 公共地址（BASE_DOMAIN=${BASE_DOMAIN}）`);
    assert.equal(configJson.slots.default.apiKey, 'erix-placeholder', '占位 key（零真实 LLM 凭据）');

    // 4) provision FDE（真实 runner 镜像）
    docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${FDE_NAME}`);

    await waitFor(() => {
      const st = safe(() => docker(`inspect ${FDE_CONTAINER} --format {{.State.Status}}`).trim());
      return st === 'running' ? st : null;
    }, { label: `${FDE_CONTAINER} running`, timeoutMs: 120000 });

    const netRow = psql(`SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id='${S.userId}'`);
    const [networkName, subnet, gateway] = netRow.split('|').map((s) => s.trim());
    S.networkName = networkName;
    S.subnet = subnet;
    S.gateway = gateway;
    assert.equal(networkName, `fde-${FDE_NAME}`);
    assert.ok(gateway, 'fde gateway .1');

    S.containerId = psql(`SELECT id FROM containers WHERE fde_name='${FDE_NAME}'`);
    assert.ok(S.containerId, 'containers row');
    S.token = readTokenFromContainer();
    assert.ok(S.token, 'ERIX_STATION_TOKEN 已注入容器');

    // issue #38 新语义（fail-closed）：LLM 路由按 fde_llm_bindings（必须有 api_key）生成，
    // 无 binding 即无 LLM 出口（worker LLM 调用 404 → run failed）。provision 之后、跑 run 之前补 binding。
    await ensureLlmBinding({
      docker,
      dynamicDir: S.dynamicRoot,
      fdeName: FDE_NAME,
      portal: PORTAL,
      portalContainerName: STATION_PORTAL_NAME,
      dbContainerName: STATION_DB_NAME,
      mockDelay: 5,
      adminLogin: `wp3b-admin-${FDE_NAME}`,
      adminPassword: 'wp3b-admin-pass-123',
    });
    // Binding model selection reaches a running FDE on heartbeat; wait two cycles so the
    // first run cannot race the pre-binding placeholder model (matching WP5/WP6 coverage).
    await sleep(2 * 15_000 + 5_000);

    // 5) agentd 连上 SSE 收 ping（§4.3）+ 首次心跳（containers.last_heartbeat）
    await waitFor(() => (agentdLogs().includes('sse ping received') ? true : null), { label: 'agentd SSE ping received', timeoutMs: 60000 });
    await waitFor(() => {
      const hb = psql(`SELECT last_heartbeat FROM containers WHERE id='${S.containerId}'`);
      return hb && hb !== '' ? hb : null;
    }, { label: 'containers.last_heartbeat set', timeoutMs: 60000 });

    // 6) 断言 UID：agentd 1001 / worker（跑 run 时 1002）——先验 agentd
    const agentdUid = docker(`exec ${FDE_CONTAINER} sh -c "ps -eo uid=,args= | grep 'node /opt/erix/agentd.js' | head -1"`).trim().split(/\s+/)[0];
    assert.equal(agentdUid, '1001', 'agentd 以 UID 1001 运行');

    // 7) run 1：真实发消息（POST /api/sessions/:id/messages → 同事务落 transcript 用户轮次 + run 入队）
    //    → agentd claim → worker runToolLoop（mock LLM）→ 事件 seq → 终态 + run_end + usage
    const run1 = await sendMessage(S.sessionId, '把登录按钮改成品牌色');
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run1}'`);
      return (st === 'finished' || st === 'failed') ? st : null;
    }, { label: 'run 1 terminal', timeoutMs: 120000 });

    assert.equal(psql(`SELECT status FROM runs WHERE id='${run1}'`), 'finished',
      `run 1 finished: ${psql(`SELECT termination::text FROM runs WHERE id='${run1}'`)}`);
    assert.equal(psql(`SELECT attempts FROM run_queue WHERE run_id='${run1}'`), '1', 'run 1 attempts=1');

    // 事件 seq 无空洞（session 内 messages 锚点行 + run_events 共享 last_seq 原子分配器；
    // transcript_rounds 用 round 而非 seq，不参与本口径）
    const sessionId = S.sessionId;
    const allSeq = psql(`SELECT string_agg(seq::text, ',' ORDER BY seq) FROM (SELECT seq FROM run_events WHERE session_id='${sessionId}' UNION SELECT seq FROM messages WHERE session_id='${sessionId}') x`);
    const seqList = allSeq.split(',').map(Number);
    assert.ok(seqList.length > 0 && seqList.every((v, i) => v === i + 1), `session seq 严格递增无空洞：${allSeq}`);

    // run_end 为 run 内最后一条 + usage 记账一 run 一条
    const runEndLast = psql(`SELECT type FROM run_events WHERE run_id='${run1}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(runEndLast, 'run_end', 'run_end 为 run 内最后一条事件');
    assert.equal(psql(`SELECT count(*) FROM usage_ledger WHERE run_id='${run1}' AND source='erix'`), '1', 'usage_ledger 一 run 一条');
    assert.equal(psql(`SELECT count(*) FROM messages WHERE run_id='${run1}' AND role='assistant'`), '1', 'assistant 消息回写');

    // issue #43（erix-agent 0.9.0 八方法契约）：saveRunState/loadRunState 全链路
    // （worker IPC → agentd → portal PUT /transcript/:key/runstate → chat_sessions.engine_run_state）。
    // 0.14.0 起快照与终态 status 分通道，且 store key = sessionId（runner/lib/store.js:12-18 映射表；
    // portal/src/internal.js:1242 选列 / 1299 注释）——故断言落在 chat_sessions 两列，
    // runs.run_state/run_state_status 是旧 run 作用域遗留列，新路径恒不写（dev 库实证：
    // runs.run_state_status 全 NULL，runs.run_state 最后写入停在 2026-09-24 的旧 runner 时代）。
    assert.equal(psql(`SELECT engine_run_state IS NOT NULL FROM chat_sessions WHERE id='${sessionId}'`), 't', 'run 1 快照落 chat_sessions.engine_run_state（saveRunState 链路通）');
    assert.equal(psql(`SELECT engine_run_state_status->>'status' FROM chat_sessions WHERE id='${sessionId}'`), 'succeeded', '引擎终态 status 落 chat_sessions.engine_run_state_status');
    assert.ok(psql(`SELECT engine_run_state->>'stateVersion' FROM chat_sessions WHERE id='${sessionId}'`), 'run-state 快照含 stateVersion');

    // 事件含 mock LLM 驱动的 delta + round 事件（worker 经 IPC 回 agentd 批量上报）
    const evTypes = psql(`SELECT string_agg(DISTINCT type, ',' ORDER BY type) FROM run_events WHERE run_id='${run1}'`);
    assert.ok(evTypes.includes('assistant_delta'), `含 assistant_delta 事件：${evTypes}`);
    assert.ok(evTypes.includes('round_start'), `含 round_start 事件：${evTypes}`);
    assert.ok(evTypes.includes('round_end'), `含 round_end 事件：${evTypes}`);

    // worker 以 UID 1002 运行过（run 1 期间 ps 取证：终态后 worker 已退出，取日志/agentd 记录的 pid 侧写）
    const workerUidLog = agentdLogs().match(/"msg":"worker spawned".*"pid":(\d+)/);
    assert.ok(workerUidLog, 'agentd 记录了 worker pid');

    // 8) token 不落盘：容器文件系统内无明文 token（仅 agentd 内存 /proc/<pid>/environ）
    const grepToken = docker(`exec ${FDE_CONTAINER} sh -c "grep -rl '${S.token}' /home /opt 2>/dev/null || true"`).trim();
    assert.equal(grepToken, '', '容器文件系统内无明文 token');

    // 9) 崩溃恢复：run 2（同一 session 第二轮，贴近真实多轮）进行中 docker kill（SIGKILL，硬崩溃）
    //    → docker 依 RestartPolicy 自动拉起 → 新 agentd re-claim（attempt+1、resume=true）→ 终态
    const run2 = await sendMessage(S.sessionId, '修复登录页的样式问题');

    // 等 run 2 进入 running（agentd 已 claim + spawn worker）
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run2}'`);
      const at = psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`);
      return st === 'running' && at === '1' ? st : null;
    }, { label: 'run 2 running attempts=1', timeoutMs: 60000, intervalMs: 50 });

    // 容器硬崩溃（run 进行中）：必须用 `docker kill`（缺省 SIGKILL），**不能改回 `docker restart`**。
    // 为什么：restart 走 SIGTERM → agentd **优雅停机**（"shutdown: draining runs" → abort run
    //   reason:agent_shutdown）→ portal 把 run abort 并**重排队**（attempt 2）；脚本随后再强制
    //   lease 过期 → claim 又 +1 → 最终 attempt=3（主 agent 真机实测：restart 路径 worker exit code:0
    //   + 新 agentd 直接 "worker spawned run2 attempt:3 resume:true"）。SIGKILL 不给 drain 机会 →
    //   run 仍是 running 且租约陈旧（run_queue.status=claimed + lease 过期，见 portal/src/internal.js:225
    //   可重领分支）→ 脚本强制 lease 过期 → re-claim 同一 run + resume=true。
    // ⚠️ 崩溃后 attempt 数**不是固定值**（issue #180）：旧 agentd 的悬挂长轮询 claim 请求在容器
    //   SIGKILL 后未被识别为断开，portal 重排队瞬间该请求立刻认领成功（attempts 只在 claim 处 +1，
    //   portal/src/internal.js:215；重排队不 +1，见同文件 :1567 注释）→ 响应写入死连接 → **ticket
    //   孤儿化**，run 只能等 90s 租约自然到期才被新 agentd 领走。真机实测时序：
    //     worker spawned attempt:1 → kill → 新 agentd 上线（~28s 后心跳监控重排队）→
    //     claim att=2（无 worker spawned，ticket 发给了死连接）→ 90s 租约到期 → attempt:3 resume:true 真恢复。
    //   即 attempt 数 = 2 还是 3 取决于竞态 → 下方断言一律用「语义口径」（attempts >= 2 且 <= max_attempts、
    //   动态 attempt 前缀、resume=true 痕迹），**不得写死**。
    // FDE 容器 RestartPolicy=unless-stopped（portal/src/provisioner.js:201；docker inspect fde-* 同值）
    //   → SIGKILL 后 docker 自动拉起 = 真「崩溃 + 重启」。请勿改回 restart。
    const pingsBeforeRestart = countAgentdPings(); // 新 agentd 上线的切片基线（见 countAgentdPings()）
    docker(`kill ${FDE_CONTAINER}`);
    await waitFor(() => {
      const st = safe(() => docker(`inspect ${FDE_CONTAINER} --format {{.State.Status}}`).trim());
      return st === 'running' ? st : null;
    }, { label: `${FDE_CONTAINER} restarted`, timeoutMs: 60000 });

    // 新 agentd 上线（SSE + ping）：必须等到**新增**的一条（次数 > kill 前基线），
    // 否则被旧 agentd 的历史 ping 秒过（等于没等新 agentd，issue #180 报告遗留项 1）。
    await waitFor(() => (countAgentdPings() > pingsBeforeRestart ? true : null),
      { label: 'agentd reconnect after restart（新增 sse ping）', timeoutMs: 60000 });

    // 强制租约过期（模拟 90s lease 到期），让 claim 立即 re-claim 同一 run
    psqlStdin(`UPDATE run_queue SET lease_until = now() - interval '1 second' WHERE run_id = '${run2}';`);

    // 等 re-claim（attempts 至少 +1）+ 终态。语义口径（issue #180）：崩溃后 attempt 数是 2 还是 3
    // 取决于 ticket 是否孤儿化（竞态），故只断言「确实发生了 re-claim」= attempts >= 2，不写死。
    // （`>= 2` 已足以证明崩溃后确实发生了 re-claim：run 2 进入 running 时已验证 attempts === 1。）
    // ⏱️ 超时给 300s（而非 120s）——issue #180 的孤儿化 claim 让真实恢复必然踩满 ~120s：
    //   SIGKILL → 旧 agentd 的悬挂长轮询 claim 请求未被识别为断开 → portal 重排队瞬间该请求
    //   立刻认领（attempt 2 白耗，响应写入死连接）→ 该租约只能 **90s 自然到期** 后才被新 agentd
    //   真正认领（attempt 3）。叠加 ~30s 重排队检测 ≈ 从 kill 到真恢复约 **120s**，之后 run 还需
    //   数秒跑完。真机实测：kill 04:25:56 → 新 agentd 04:25:59 → worker spawned run2 attempt:3
    //   resume:true 04:27:59（正好 +120s）→ 04:28:00 events stored。原 120000 会踩在等待窗口
    //   最后一刻（抖动即假红），故留 ~2.5x 余量。
    // TODO(#180): 已修复——portal 识别死连接（res 'close' + !writableEnded）后中断长轮询，并为写不出的
    //   claim 调 releaseUndeliveredClaim 还回 attempt；孤儿认领不再发生。保留 300s 作为失败路径余量（不调回
    //   120000：避免又踩边界抖动；该值只影响超时上限，不影响正常断言）。
    await waitFor(() => {
      const st = psql(`SELECT status FROM runs WHERE id='${run2}'`);
      const at = Number(psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`));
      return (st === 'finished' || st === 'failed') && at >= 2 ? { st, at } : null;
    }, { label: 'run 2 re-claimed attempts>=2 terminal', timeoutMs: 300000 });

    // 该 run 最终实际 attempts（恢复后真正执行的那次 = 最后一次 claim）→ 下方动态前缀 / resume 断言用。
    const rcAttempts = Number(psql(`SELECT attempts FROM run_queue WHERE run_id='${run2}'`));
    const rcMaxAttempts = Number(psql(`SELECT max_attempts FROM run_queue WHERE run_id='${run2}'`));
    assert.ok(rcAttempts >= 2, `崩溃恢复确实发生了 re-claim（attempts >= 2）：attempts=${rcAttempts}`);
    assert.ok(rcAttempts <= rcMaxAttempts, `attempts 未越界（<= max_attempts=${rcMaxAttempts}）：attempts=${rcAttempts}`);
    assert.equal(psql(`SELECT status FROM runs WHERE id='${run2}'`), 'finished', 'run 2 终态 finished');

    // resume=true：恢复走 resume 路径的**硬证据**（agentd 日志）——attempt >= 2 的那次 worker spawn
    // 必须带 resume:true（runner/agentd.js:1102；ctx.resume = run.resume === true，:1040）。
    // 用该 run 最终实际 attempts 精确匹配（区分 attempt:1 的 resume:false）。
    await waitFor(() => {
      const re = new RegExp(`"msg":"worker spawned","fde":"${FDE_NAME}","run_id":"${run2}","attempt":${rcAttempts},"resume":true`);
      return re.test(agentdFullLogs()) ? true : null;
    }, { label: `run 2 resume=true worker spawned（attempt=${rcAttempts}）`, timeoutMs: 30000 });

    // issue #43：resume 路径经 loadRunState 恢复（0.7.0 轮号/轮预算拆分语义），终态 status 仍落 session 列。
    // 同一 session 两轮 → 列本身不能区分轮次，故额外用 status 记录的 ts 晚于 run 2 入队时间，
    // 证明它是 **run 2 自己**的 markRunState 写入（否则 run 1 的旧值也能让断言假绿）。
    assert.equal(psql(`SELECT engine_run_state IS NOT NULL FROM chat_sessions WHERE id='${sessionId}'`), 't', 'run 2 快照仍在 chat_sessions.engine_run_state（resume + saveRunState 链路通）');
    assert.equal(psql(`SELECT engine_run_state_status->>'status' FROM chat_sessions WHERE id='${sessionId}'`), 'succeeded', 'run 2 引擎终态 status 落 chat_sessions.engine_run_state_status');
    assert.equal(psql(`SELECT (engine_run_state_status->>'ts')::timestamptz > (SELECT queued_at FROM runs WHERE id='${run2}') FROM chat_sessions WHERE id='${sessionId}'`), 't', 'run 2 终态 status 记录由 run 2 自己写入（ts 晚于入队）');

    // F3（issue #43 评审）sentinel：attempt1 崩溃前的 run_state 已在库中（attempt1 独有写）；
    // 断言恢复侧**确实发生了 loadRunState 读**——agentd 对该方法留痕（仅引擎 resume 路径调用，
    // attempt ≥ 2），read 痕迹与 write 痕迹（saveRunState）可区分：若无此读，说明恢复那次 attempt
    // 未走恢复路径（此时只剩它自己的写也能让上面的写侧断言假绿）。
    await waitFor(() => {
      // store key 已切 session 维度（runner/lib/store.js:12-18）：session 路径日志字段是 `session_key`
      // （runner/agentd.js:558），不再是旧 run 作用域的 `run_id`（:568）。restored=true = 真读到了快照。
      const trace = new RegExp(`"msg":"store loadRunState","fde":"${FDE_NAME}","session_key":"${sessionId}","restored":true`);
      return trace.test(agentdLogs()) ? true : null;
    }, { label: 'run 2 resume 经 loadRunState 恢复（agentd 读痕迹 + restored=true）', timeoutMs: 30000 });

    // 恢复后那次 attempt 的事件带**自身 attempt 号**：client_event_id = `<runId>:<attempt>:<n>`
    // （runner/worker.js:116）。attempt 号动态取自该 run 最终实际 attempts（issue #180：2 还是 3
    // 取决于竞态，写死 :2: 必假红）——不是「随便有个冒号」，而是精确匹配该 attempt 的前缀 + 首事件
    // 序号 0（每个 attempt 是全新 worker 进程，eventCounter 从 0 起 → 首事件即 `:<attempt>:0`）。
    const rcEvents = psql(`SELECT string_agg(client_event_id, ',' ORDER BY seq) FROM run_events WHERE run_id='${run2}' AND type <> 'run_end'`);
    assert.ok(rcEvents.includes(`:${rcAttempts}:0`), `恢复后 attempt=${rcAttempts} 的事件带自身 attempt 号（前缀 :${rcAttempts}:0）：${rcEvents}`);
    const rcRunEnd = psql(`SELECT type FROM run_events WHERE run_id='${run2}' ORDER BY seq DESC LIMIT 1`);
    assert.equal(rcRunEnd, 'run_end', '崩溃恢复后 run_end 仍为最后一条');

    // eslint-disable-next-line no-console
    console.log('\n[e2e] WP3b OK: 真实 runner 镜像 + agentd/worker + mock LLM + 崩溃恢复 全部通过');
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker(`logs ${STATION_PORTAL_NAME} --tail 80`));
      // eslint-disable-next-line no-console
      console.log(`\n[e2e] --- ${FDE_CONTAINER} (agentd) logs ---`);
      // eslint-disable-next-line no-console
      console.log(docker(`logs ${FDE_CONTAINER} --tail 120`));
    } catch {}
    throw err;
  }
});
