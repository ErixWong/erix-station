// WP2a 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈 → 建用户 + 两步登录 → 建项目 → 检查宿主 ports.json/manifest.json + 权限
//   → 检查 Traefik 动态配置含 router → 手工 docker run whoami 接 FDE /29 → 经 Traefik curl 可达
//   → DELETE 项目 → 端口回收 + tombstone + 文件/路由收敛（curl 404）。
// 运行：npm run test:integration
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

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE = 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml';
const PORTAL = 'http://127.0.0.1:18080';
const TRAEFIK_WEB = 'http://127.0.0.1:8090';

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

// M6：DB 数据目录可参数化（STATION_DB_DIR，与 deploy/docker-compose.yml 的挂载一致），
// 不再硬删共享固定路径 /docker/station-db——并行跑/多栈场景互不误伤。
const DB_DIR = (process.env.STATION_DB_DIR || '/docker/station-db').replace(/\/+$/, '');
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

async function insertUser() {
  const passwordHash = await auth.hashPassword(S.password);
  S.totpSecret = totp.generateSecret(20);
  const sql = `
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('00000000-0000-0000-0000-000000000001', 'alice', 'Alice', 'fde', 'alice', 'local', 'active',
            '${passwordHash}', '${S.totpSecret}');
  `;
  dockerStdin('exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1', sql);
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
  assert.match(S.hostname, /^alice-p-proj1-\d{4}\.fde\.localhost$/);
}

function hostPathOf(...rel) {
  return path.join(S.userspaceRoot, 'alice', ...rel);
}

async function readDbNetwork() {
  const out = docker(
    `exec -i station-db psql -U station -d station -tAc "SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id = '00000000-0000-0000-0000-000000000001'"`,
  ).trim();
  const [networkName, subnet, gateway] = out.split('|').map((s) => s.trim());
  assert.ok(networkName && subnet && gateway, `fde_networks row: ${out}`);
  S.networkName = networkName;
  S.subnet = subnet;
  S.gateway = gateway;
}

test('WP2a 端到端：建项目 → 物化 + 路由 → whoami 可达 → 删除收敛', { timeout: 10 * 60 * 1000 }, async (t) => {

  // 隔离目录（不碰真实 /srv/erix/users 与 repo 动态目录）。
  // mkdtemp 默认 0700；Traefik 容器（root + cap_drop ALL，无 DAC_OVERRIDE）需经 other 位读动态目录 → 0755。
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-e2e-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-e2e-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker(`rm -f ${S.containerName ?? 'fde-alice-svc'} 2>/dev/null || true`));
    safe(() => docker(`network rm ${S.networkName ?? 'fde-alice'} 2>/dev/null || true`));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local 2>/dev/null || true'));
    // 工作区/动态目录由 materializer/reconciler 以 root 写文件，但目录属主仍为 eric → 直接删。
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    // DB 数据目录被 postgres 容器 chown 到 999 → 用临时 root 容器删（env §8.1 只读会话无法直接删）。
    removeDbDir();
  };
  t.after(cleanup);

  try {
    // 0) 预清理：确保干净起点（前次残留）。
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    removeDbDir();

    // 1) 起栈
    compose('up -d --build', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot });

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
    assert.equal(portsJson.fde, 'alice');
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
    // F3：每个 active FDE 生成 LLM 路由（Host(llm) && ClientIP(精确 subnet) → llm-hub，无兜底）。
    assert.ok(routesText.includes('llm.localhost'), 'routes.yml 含 llm 路由');
    assert.match(routesText, /ClientIP\(`10\.200\.\d+\.\d+\/2[89]`\)/, 'LLM ClientIP 精确 subnet');
    assert.ok(routesText.includes('service: llm-hub'), 'LLM service llm-hub');
    assert.ok(routesText.includes('fde-alice-llm'), 'fde-alice-llm router');

    // 7) 手工建 FDE 网络 + whoami 假 dev server
    await readDbNetwork();
    docker(`network create --subnet ${S.subnet} --gateway ${S.gateway} ${S.networkName}`);
    const subnetRange = parseCidr(S.subnet);
    const backendIp = intToIp((subnetRange.base + 2) >>> 0);
    S.containerName = 'fde-alice-svc';
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
    await waitFor(() => {
      const out = docker(
        `exec -i station-db psql -U station -d station -tAc "SELECT state FROM port_allocations WHERE hostname = '${S.hostname}'"`,
      ).trim();
      return out === 'released' ? out : null;
    }, { label: 'port released' });

    // tombstone 落库（route_outbox op=delete）
    await waitFor(() => {
      const out = docker(
        `exec -i station-db psql -U station -d station -tAc "SELECT op FROM route_outbox WHERE aggregate = 'port_allocation' AND op = 'delete' LIMIT 1"`,
      ).trim();
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
      `exec -i station-db psql -U station -d station -c "UPDATE fde_networks SET state='released', released_at=now() WHERE fde_id='00000000-0000-0000-0000-000000000001'"`,
    );
    const p2 = await fetch(`${PORTAL}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
      body: JSON.stringify({ name: 'proj2', repo_url: 'https://git.example/alice/proj2.git', template: 'node' }),
    });
    const p2body = await p2.json();
    assert.equal(p2.status, 201, `F4 re-create project: ${JSON.stringify(p2body)}`);
    const netRow = docker(
      `exec -i station-db psql -U station -d station -tAc "SELECT subnet, state FROM fde_networks WHERE fde_id='00000000-0000-0000-0000-000000000001'"`,
    ).trim();
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
      console.log(docker('logs station-portal --tail 60'));
    } catch {}
    throw err;
  }
});
