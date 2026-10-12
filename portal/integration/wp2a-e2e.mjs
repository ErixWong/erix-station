// WP2a 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈 → 建用户 + 两步登录 → 建项目 → 检查宿主 ports.json/manifest.json + 权限
//   → 检查 Traefik 动态配置含 router → 手工 docker run whoami 接 FDE /29 → 经 Traefik curl 可达
//   → DELETE 项目 → 端口回收 + tombstone + 文件/路由收敛（curl 404）。
// 运行：npm run test:integration（⚠️ issue #226 起**必须带隔离 env**，见下；缺 env 直接硬失败，
//   不再默默对共享 dev 栈动手。）
//
// —— 隔离 env 清单（issue #226；与 wp3b/wp5/wp6 同一套，判据集中在 lib/isolated-env.mjs）——
//   入口 URL 与容器名一律 env 派生（缺省值 = 共享栈现状，便于人读，但**护栏要求显式传**）：
//   STATION_STACK_ID=<唯一栈 id> COMPOSE_PROJECT_NAME=<同一个栈 id>
//   STATION_DB_DIR=/tmp/station-db-<栈 id>（必须不存在；缺省会 rm -rf 共享 dev 库数据目录）
//   STATION_DB_NAME=station-db-<栈 id> STATION_PORTAL_NAME=station-portal-<栈 id>
//   STATION_DOCKER_PROXY_NAME=station-docker-proxy-<栈 id> STATION_EDGE_NAME=station-edge-<栈 id>
//   PORTAL_HOST_PORT=<非 18080> TRAEFIK_WEB_PORT=<非 8090> TRAEFIK_WEBSECURE_PORT=<非 8443>
//   FDE_NAME=<含栈 id 的 FDE 名>（`fde-<name>` 是全局 docker 网络/容器名，不派生会与共享栈互删）
//   BACKEND_SUBNET=<非 172.32.0.0/24> FDE_POOL=large FDE_IPAM_POOLS=10.201.0.0/16
//   STATION_PORTAL_IMAGE/STATION_DOCKER_PROXY_IMAGE/FDE_IMAGE=…:<栈 id>
//   （本栈**不带** litellm profile ⇒ 不需要 LITELLM_HOST_PORT/STATION_LITELLM_NAME。）
//   TRAEFIK_STATIC_HOST 由脚本自动生成（只改入口端口的临时 traefik.yml）——Traefik v3 带 --configFile
//   时 CLI 端口覆盖不生效，不替换就会去抢共享 edge 的 8090/8443（F8 实测）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as totp from '../src/totp.js';
import * as auth from '../src/auth.js';
import { parseCidr, intToIp } from '../src/ipam.js';
import { BASE_DOMAIN, LLM_HOST, composeDomainEnv } from './lib/compose-domain.mjs';
import {
  assertHostPortsAvailable, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：compose 一律显式 -p，且用 bash 的 `${VAR:?msg}`——未 export 时展开即非零退出并点名，
// 不再依赖「COMPOSE_PROJECT_NAME 环境变量压过 compose 文件 name: station」这条隐式优先级
// （忘 export 曾经会让脚本自己对共享 dev 栈 down -v）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --env-file deploy/.env -f deploy/docker-compose.yml';
// issue #226：入口句柄全部 env 派生（缺省值保留现状值只为可读，隔离跑法由护栏强制显式传）。
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const TRAEFIK_WEBSECURE_PORT = process.env.TRAEFIK_WEBSECURE_PORT || '8443';
const TRAEFIK_WEB = `http://127.0.0.1:${TRAEFIK_WEB_PORT}`;
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const FDE_NAME = process.env.FDE_NAME || 'alice';
const FDE_CONTAINER = `fde-${FDE_NAME}`; // provisioner/IPAM 命名规则：fde-<fde_name>

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

// M6/#226：DB 数据目录可参数化（与 deploy/docker-compose.yml 的挂载一致）。**缺省不再回退**
// /docker/station-db——共享 dev 栈库容器的 bind 源，按缺省 teardown 等于 rm -rf 真机库数据。
const { removeDbDir } = createDbDirCleaner({ docker });

function compose(args, env = {}) {
  return execSync(`sg docker -c ${JSON.stringify(`${COMPOSE} ${args}`)}`, {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...DOMAIN_COMPOSE_ENV, ...stackPaths(), ...env },
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

// 状态（跨步骤共享）
const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  staticFile: null,
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
  projectId: null,
  port: null,
  hostname: null,
  subnet: null,
  gateway: null,
  networkName: null,
  containerName: null,
};

/** compose 需要的宿主路径（静态配置在 mkdtemp 之前尚未生成 ⇒ 只注入已就绪的键）。 */
function stackPaths() {
  const paths = {
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
  };
  return Object.fromEntries(Object.entries(paths).filter(([, value]) => value !== undefined && value !== null));
}

function psql(query) {
  return docker(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}

async function insertUser() {
  const passwordHash = await auth.hashPassword(S.password);
  S.totpSecret = totp.generateSecret(20);
  const sql = `
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('00000000-0000-0000-0000-000000000001', 'alice', 'Alice', 'fde', '${FDE_NAME}', 'local', 'active',
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

async function createProject() {
  const r = await fetch(`${PORTAL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
    body: JSON.stringify({ name: 'proj1', repo_url: 'https://git.example/alice/proj1.git', template: 'node' }),
  });
  const body = await r.json();
  assert.equal(r.status, 201, `create project: ${JSON.stringify(body)}`);
  S.projectId = body.project.id;
  S.port = body.ports[0].port;
  S.hostname = body.ports[0].hostname;
  assert.equal(body.ports[0].state, 'allocated');
  assert.match(S.hostname, new RegExp(`^${FDE_NAME}-p-proj1-\\d{4}\\.fde\\.`), `hostname 前缀用派生的 FDE_NAME=${FDE_NAME}: ${S.hostname}`);
  assert.ok(S.hostname.endsWith(`.${BASE_DOMAIN}`), `hostname uses BASE_DOMAIN=${BASE_DOMAIN}: ${S.hostname}`);
}

function hostPathOf(...rel) {
  return path.join(S.userspaceRoot, FDE_NAME, ...rel);
}

async function readDbNetwork() {
  const out = psql(
    `SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id = '00000000-0000-0000-0000-000000000001'`,
  );
  const [networkName, subnet, gateway] = out.split('|').map((s) => s.trim());
  assert.ok(networkName && subnet && gateway, `fde_networks row: ${out}`);
  S.networkName = networkName;
  S.subnet = subnet;
  S.gateway = gateway;
}

test('WP2a 端到端：建项目 → 物化 + 路由 → whoami 可达 → 删除收敛', { timeout: 10 * 60 * 1000 }, async (t) => {
  // issue #226：本脚本以前不具备隔离运行能力——入口 URL/容器名写死共享栈、DB 数据目录缺省指向
  // 共享 dev 库，无论带不带 env 跑都会动共享栈。现按 wp5/wp6 的形态先过硬隔离护栏。
  // wp2a 不起 litellm profile ⇒ litellm:false（不要求 LITELLM_HOST_PORT/STATION_LITELLM_NAME）。
  assertIsolatedEnvironment({
    litellm: false,
    fdeNames: [{ env: 'FDE_NAME', value: FDE_NAME, sharedDefault: 'alice' }],
  });
  await assertHostPortsAvailable([PORTAL_HOST_PORT, TRAEFIK_WEB_PORT, TRAEFIK_WEBSECURE_PORT]);

  // 隔离目录（不碰真实 /srv/erix/users 与 repo 动态目录）。
  // mkdtemp 默认 0700；Traefik 容器（root + cap_drop ALL，无 DAC_OVERRIDE）需经 other 位读动态目录 → 0755。
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-e2e-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-e2e-'));
  S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-e2e-'));
  S.staticFile = writeTraefikStatic(S.staticRoot, {
    repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: TRAEFIK_WEBSECURE_PORT,
  });
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);
  fs.chmodSync(S.staticRoot, 0o755);

  const cleanup = () => {
    safe(() => docker(`rm -f ${S.containerName ?? `${FDE_CONTAINER}-svc`} 2>/dev/null || true`));
    safe(() => docker(`network rm ${S.networkName ?? FDE_CONTAINER} 2>/dev/null || true`));
    safe(() => compose('down -v'));
    // issue #178：不删镜像（共享 tag 绝不能被 e2e 删除；compose up --build 按需重建）。
    // 工作区/动态目录由 materializer/reconciler 以 root 写文件，但目录属主仍为 eric → 直接删。
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.staticRoot, { recursive: true, force: true }));
    // DB 数据目录被 postgres 容器 chown 到 999 → 用临时 root 容器删（env §8.1 只读会话无法直接删）。
    // STATION_DB_DIR 缺省/越界会在 removeDbDir() 里抛错（不会 rm -rf 共享 dev 库数据目录）。
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理：确保干净起点（前次残留）。
    safe(() => compose('down -v'));
    removeDbDir();

    // 1) 起栈（栈名/容器名/端口/子网/镜像 tag 经 process.env 透传给 compose）
    compose('up -d --build');

    // 2) 等 portal 就绪
    await waitFor(
      async () => {
        const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
        return r && r.status === 200;
      },
      { label: 'portal healthz', timeoutMs: 180000 },
    );

    // 3) 建用户 + 两步登录
    await insertUser();
    await login();

    // 4) 建项目
    await createProject();

    // F10：GET /api/projects/:id/ports（portal.md §4.7）
    const portsList = await fetch(`${PORTAL}/api/projects/${S.projectId}/ports`, {
      headers: { Cookie: `fde_session_dev=${S.cookie}` },
    });
    assert.equal(portsList.status, 200, 'GET ports list');
    const portsBody = await portsList.json();
    assert.equal(portsBody.items.length, 1);
    assert.equal(portsBody.items[0].hostname, S.hostname);

    // 5) 等物化落盘 + 权限
    const portsPath = hostPathOf('projects', 'proj1', '.erix', 'ports.json');
    const manifestPath = hostPathOf('home', '.erix', 'manifest.json');
    await waitFor(() => fs.existsSync(portsPath) && fs.existsSync(manifestPath), { label: 'ports.json/manifest.json 落盘' });

    const portsStat = fs.statSync(portsPath);
    const manifestStat = fs.statSync(manifestPath);
    assert.equal(portsStat.mode & 0o777, 0o644, 'ports.json 0644');
    assert.equal(manifestStat.mode & 0o777, 0o444, 'manifest.json 0444');
    // 工作区目录 2770（setgid + 组 rwx）；.erix 0750。
    const projDirStat = fs.statSync(hostPathOf('projects', 'proj1'));
    assert.equal(projDirStat.mode & 0o777, 0o770, 'project dir 2770');
    const erixDirStat = fs.statSync(hostPathOf('projects', 'proj1', '.erix'));
    assert.equal(erixDirStat.mode & 0o777, 0o750, '.erix dir 0750');

    // ports.json 内容含分配端口与 hostname
    const portsJson = JSON.parse(fs.readFileSync(portsPath, 'utf8'));
    assert.equal(portsJson.fde, FDE_NAME);
    assert.equal(portsJson.project, 'proj1');
    assert.equal(portsJson.allocations[0].port, S.port);

    // 6) 等 Traefik 动态配置含该 router（reconciler 生成）
    const routesFile = path.join(S.dynamicRoot, 'routes.yml');
    await waitFor(() => fs.existsSync(routesFile) && fs.readFileSync(routesFile, 'utf8').includes(S.hostname), {
      label: 'routes.yml 含 router',
    });
    const routesText = fs.readFileSync(routesFile, 'utf8');
    assert.match(routesText, new RegExp(`fde-${S.hostname.split('.')[0]}:`));
    assert.ok(!routesText.includes('10.200.0.0/16'), '禁止 /16 聚合进放行范围');
    // F3（2026-09-20 修订，issue #38）：LLM 段已拆到独立文件 llm-routes.yml（mode 0600），
    // 主文件 routes.yml 不再含任何 LLM 段。fail-closed：无 binding = 无 LLM 出口，
    // 零 binding 时 rebuildRoutes 直接 unlink llm-routes.yml（Traefik v3 file provider 拒绝空形态）。
    // wp2a 场景本 FDE 不配任何 binding → 断言「文件不存在」。ClientIP 精确 subnet 的覆盖
    // 在 wp6（文件存在但无 llm-bob）+ 单测 portal/test/routes.test.js:157/375，本脚本不再重复。
    assert.ok(!fs.existsSync(path.join(S.dynamicRoot, 'llm-routes.yml')), '零 binding → llm-routes.yml 不存在');
    assert.ok(!routesText.includes(LLM_HOST), `routes.yml 不含 LLM 路由（${LLM_HOST}）`);
    assert.ok(!routesText.includes('llm-hub'), 'routes.yml 不含 llm-hub service');
    assert.ok(!routesText.includes(`fde-${FDE_NAME}-llm`), `routes.yml 不含 fde-${FDE_NAME}-llm router`);

    // 7) 手工建 FDE 网络 + whoami 假 dev server
    await readDbNetwork();
    docker(`network create --subnet ${S.subnet} --gateway ${S.gateway} ${S.networkName}`);
    const subnetRange = parseCidr(S.subnet);
    const backendIp = intToIp((subnetRange.base + 2) >>> 0);
    S.containerName = `${FDE_CONTAINER}-svc`;
    docker(`run -d --rm --name ${S.containerName} --network ${S.networkName} --ip ${backendIp} traefik/whoami -port ${S.port}`);

    // 8) 经 Traefik curl：无预览凭证 → fail-closed 403（F2）；不再因 hostname 存在即放行。
    const curl = `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${S.hostname}' ${TRAEFIK_WEB}/`;
    const code = await waitFor(async () => {
      const c = execSync(curl, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '403' ? c : null;
    }, { label: `curl 403 via Traefik (${S.hostname})`, timeoutMs: 30000 });
    assert.equal(code, '403');

    // 9) DELETE 项目 → 端口回收 + tombstone + 收敛
    const del = await fetch(`${PORTAL}/api/projects/${S.projectId}`, {
      method: 'DELETE',
      headers: { Cookie: `fde_session_dev=${S.cookie}` },
    });
    assert.equal(del.status, 204, 'delete project');

    // 端口回收（DB state → released）
    await waitFor(() => psql(`SELECT state FROM port_allocations WHERE hostname = '${S.hostname}'`) === 'released' ? 'released' : null, { label: 'port released' });

    // tombstone 落库（route_outbox op=delete）
    await waitFor(() => {
      const out = psql(`SELECT op FROM route_outbox WHERE aggregate = 'port_allocation' AND op = 'delete' LIMIT 1`);
      return out === 'delete' ? out : null;
    }, { label: 'route tombstone' });

    // 路由与文件收敛：routes.yml 不再含该 router；ports.json 被清理。
    await waitFor(() => {
      const txt = fs.existsSync(routesFile) ? fs.readFileSync(routesFile, 'utf8') : '';
      return !txt.includes(S.hostname) && !fs.existsSync(portsPath);
    }, { label: 'route + file convergence' });

    // curl 变 404（路由表里没有 = 不可达）
    const afterCode = await waitFor(async () => {
      const c = execSync(curl, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '404' ? c : null;
    }, { label: 'curl 404 after delete', timeoutMs: 30000 });
    assert.equal(afterCode, '404');

    // 10) F4：释放网络 → 再建项目成功且子网正确（released 行复用，不 500）。
    await docker(
      `exec -i ${STATION_DB_NAME} psql -U station -d station -c "UPDATE fde_networks SET state='released', released_at=now() WHERE fde_id='00000000-0000-0000-0000-000000000001'"`,
    );
    const p2 = await fetch(`${PORTAL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
      body: JSON.stringify({ name: 'proj2', repo_url: 'https://git.example/alice/proj2.git', template: 'node' }),
    });
    const p2body = await p2.json();
    assert.equal(p2.status, 201, `F4 re-create project: ${JSON.stringify(p2body)}`);
    const netRow = psql(
      `SELECT subnet, state FROM fde_networks WHERE fde_id='00000000-0000-0000-0000-000000000001'`,
    );
    const [netSubnet, netState] = netRow.split('|').map((s) => s.trim());
    assert.equal(netState, 'allocated', 'F4 network reallocated');
    assert.notEqual(netSubnet, S.subnet, 'F4 new subnet differs');
    // 清理 proj2（网络回收由 cleanup 负责）
    await fetch(`${PORTAL}/api/projects/${p2body.project.id}`, {
      method: 'DELETE',
      headers: { Cookie: `fde_session_dev=${S.cookie}` },
    });

    // eslint-disable-next-line no-console
    console.log(`\n[e2e] OK: project=${S.projectId} hostname=${S.hostname} port=${S.port} subnet=${S.subnet} curl 403 (无凭证) → delete → curl 404 → F4 重分配 ${netSubnet}`);
  } catch (err) {
    // 失败时打印 portal 日志便于定位，再交给 cleanup。
    try {
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker(`logs ${STATION_PORTAL_NAME} --tail 60`));
    } catch {}
    throw err;
  }
});
