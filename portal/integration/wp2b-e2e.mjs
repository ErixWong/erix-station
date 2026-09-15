// WP2b 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
// 流程：起栈 → 建用户 + 两步登录 → provision-fde（经 socket-proxy 真建容器+网络，接入 /29）
//   → 建项目（端口 4000 + 物化 + 路由）→ 无 ticket 经 Traefik curl 403
//   → 签发 ticket → 带 ticket curl 302 换预览 cookie → 带 cookie curl 200（whoami）
//   → allocated→active 生效 → 删项目 + deprovision-fde → 容器/网络/端口回收 → curl 404。
// 运行：npm run test:integration:wp2b
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

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
  projectId: null,
  portId: null,
  port: null,
  hostname: null,
  subnet: null,
  gateway: null,
  networkName: null,
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
  S.portId = body.ports[0].id;
  S.port = body.ports[0].port;
  S.hostname = body.ports[0].hostname;
  assert.equal(body.ports[0].state, 'allocated');
  assert.equal(S.port, 4000, '首个项目端口 = 块首 4000（whoami 站台默认监听）');
}

test('WP2b 端到端：provision 容器 → 建项目 → ticket 换预览 cookie → curl 200 → 回收', { timeout: 10 * 60 * 1000 }, async (t) => {
  S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-e2e-'));
  S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-e2e-'));
  fs.chmodSync(S.userspaceRoot, 0o755);
  fs.chmodSync(S.dynamicRoot, 0o755);

  const cleanup = () => {
    safe(() => docker(`rm -f fde-alice 2>/dev/null || true`));
    safe(() => docker(`network rm fde-alice 2>/dev/null || true`));
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('rmi -f erix-station/portal:local 2>/dev/null || true'));
    safe(() => fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
    safe(() => fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
    safe(() => docker('run --rm -v /docker:/docker alpine rm -rf /docker/station-db'));
  };
  t.after(cleanup);

  try {
    // 0) 预清理
    safe(() => compose('down -v', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot }));
    safe(() => docker('run --rm -v /docker:/docker alpine rm -rf /docker/station-db'));

    // 1) 起栈（socket-proxy 已 POST=1）
    compose('up -d --build', { ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot, TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot });

    // 2) 等 portal 就绪
    await waitFor(
      async () => {
        const r = await fetch(`${PORTAL}/healthz`).catch(() => null);
        return r && r.status === 200;
      },
      { label: 'portal healthz', timeoutMs: 180000 },
    );

    // 3) 建用户 + 登录
    await insertUser();
    await login();

    // 4) provision-fde：经 socket-proxy 真建网络 + 容器（接入 /29）
    docker('exec station-portal node portal/src/cli.js provision-fde --fde-name alice');

    // 容器 running + 接入 fde-alice 网络（固定位 .2）
    await waitFor(() => {
      const inspect = safe(() => docker('inspect fde-alice --format {{.State.Status}}').trim());
      return inspect === 'running' ? inspect : null;
    }, { label: 'fde-alice container running' });

    const netRow = docker(
      `exec -i station-db psql -U station -d station -tAc "SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id='00000000-0000-0000-0000-000000000001'"`,
    ).trim();
    const [networkName, subnet, gateway] = netRow.split('|').map((s) => s.trim());
    assert.ok(networkName && subnet && gateway, `fde_networks row: ${netRow}`);
    S.networkName = networkName;
    S.subnet = subnet;
    S.gateway = gateway;
    assert.equal(networkName, 'fde-alice');

    // 容器固定位 .2（topology §3）
    const parsed = parseCidr(S.subnet);
    const backendIp = intToIp((parsed.base + 2) >>> 0);
    const inspect = JSON.parse(docker('inspect fde-alice'));
    const cidr = inspect[0].NetworkSettings.Networks[S.networkName].IPAddress;
    assert.equal(cidr, backendIp, '容器 IP = .2');

    // DB 状态真相：containers.status = running
    const cstat = docker(
      `exec -i station-db psql -U station -d station -tAc "SELECT status FROM containers WHERE fde_name='alice'"`,
    ).trim();
    assert.equal(cstat, 'running', 'containers.status 回写 running');

    // 5) 建项目 → 端口 4000 + 物化 + 路由
    await createProject();

    const portsPath = path.join(S.userspaceRoot, 'alice', 'projects', 'proj1', '.erix', 'ports.json');
    await waitFor(() => fs.existsSync(portsPath), { label: 'ports.json 落盘' });

    const routesFile = path.join(S.dynamicRoot, 'routes.yml');
    await waitFor(() => fs.existsSync(routesFile) && fs.readFileSync(routesFile, 'utf8').includes(S.hostname), {
      label: 'routes.yml 含 router',
    });

    // 6) 无 ticket 经 Traefik → 403（fail-closed）
    const curlNo = `curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${S.hostname}' ${TRAEFIK_WEB}/`;
    const codeNo = await waitFor(async () => {
      const c = execSync(curlNo, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '403' ? c : null;
    }, { label: 'curl 403 无凭证', timeoutMs: 30000 });
    assert.equal(codeNo, '403');

    // 7) 签发 ticket
    const issue = await fetch(`${PORTAL}/api/ports/${S.portId}/preview-ticket`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `fde_session_dev=${S.cookie}` },
      body: '{}',
    });
    assert.equal(issue.status, 201, '签发 ticket');
    const issueBody = await issue.json();
    assert.ok(issueBody.ticket, 'ticket 返回');
    assert.equal(issueBody.expires_in, 60);

    // 8) 带 ticket curl → 302（换预览 cookie）+ Set-Cookie；带 cookie curl → 200
    const cj = path.join(os.tmpdir(), `erix-preview-cj-${Date.now()}`);
    const curlTicket = `curl -s -o /dev/null -w '%{http_code}' -c ${cj} -H 'Host: ${S.hostname}' '${TRAEFIK_WEB}/?preview_ticket=${issueBody.ticket}'`;
    const code302 = await waitFor(async () => {
      const c = execSync(curlTicket, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '302' ? c : null;
    }, { label: 'curl 302 ticket bootstrap', timeoutMs: 30000 });
    assert.equal(code302, '302');

    const code200 = await waitFor(async () => {
      const c = execSync(
        `curl -s -o /dev/null -w '%{http_code}' -b ${cj} -H 'Host: ${S.hostname}' ${TRAEFIK_WEB}/`,
        { encoding: 'utf8', stdio: 'pipe' },
      ).trim();
      return c === '200' ? c : null;
    }, { label: 'curl 200 带预览 cookie', timeoutMs: 30000 });
    assert.equal(code200, '200');

    // whoami 内容确实来自 FDE 容器（经 Traefik forwardAuth 放行后代理到 .2:4000）
    const whoamiBody = execSync(
      `curl -s -b ${cj} -H 'Host: ${S.hostname}' ${TRAEFIK_WEB}/`,
      { encoding: 'utf8', stdio: 'pipe' },
    );
    assert.ok(whoamiBody.includes('Host'), `whoami 回显 Host 头: ${whoamiBody.slice(0, 120)}`);
    safe(() => fs.rmSync(cj, { force: true }));

    // 9) allocated → active 生效（首次 forward-auth 放行触发，fde-platform §8.6）
    await waitFor(() => {
      const st = docker(
        `exec -i station-db psql -U station -d station -tAc "SELECT state FROM port_allocations WHERE hostname='${S.hostname}'"`,
      ).trim();
      return st === 'active' ? st : null;
    }, { label: 'allocated→active' });

    // 10) 回收：删项目 → 端口/路由收敛；deprovision-fde → 容器/网络回收
    const del = await fetch(`${PORTAL}/api/projects/${S.projectId}`, {
      method: 'DELETE',
      headers: { Cookie: `fde_session_dev=${S.cookie}` },
    });
    assert.equal(del.status, 204, 'delete project');

    await waitFor(() => {
      const txt = fs.existsSync(routesFile) ? fs.readFileSync(routesFile, 'utf8') : '';
      return !txt.includes(S.hostname) ? true : null;
    }, { label: 'routes.yml 收敛（不含 hostname）' });

    const afterDel = await waitFor(async () => {
      const c = execSync(curlNo, { encoding: 'utf8', stdio: 'pipe' }).trim();
      return c === '404' ? c : null;
    }, { label: 'curl 404 after delete', timeoutMs: 30000 });
    assert.equal(afterDel, '404');

    // deprovision：容器 + 网络回收 + DB 状态收敛
    docker('exec station-portal node portal/src/cli.js deprovision-fde --fde-name alice');
    await waitFor(() => {
      const gone = safe(() => docker('inspect fde-alice --format {{.Id}}').trim());
      return gone ? null : true;
    }, { label: 'fde-alice container removed' });
    const netGone = safe(() => docker('network inspect fde-alice --format {{.Id}}').trim());
    assert.equal(netGone, null, 'fde-alice network removed');

    const cstatus = docker(
      `exec -i station-db psql -U station -d station -tAc "SELECT status FROM containers WHERE fde_name='alice'"`,
    ).trim();
    assert.equal(cstatus, 'removed', 'containers.status removed');
    const nstate = docker(
      `exec -i station-db psql -U station -d station -tAc "SELECT state FROM fde_networks WHERE fde_id='00000000-0000-0000-0000-000000000001'"`,
    ).trim();
    assert.equal(nstate, 'released', 'fde_networks released');

    // eslint-disable-next-line no-console
    console.log(`\n[e2e] OK: fde=alice subnet=${S.subnet} port=${S.port} hostname=${S.hostname} ticket→302→cookie→200 → active → 回收 404`);
  } catch (err) {
    try {
      // eslint-disable-next-line no-console
      console.log('\n[e2e] --- portal logs ---');
      // eslint-disable-next-line no-console
      console.log(docker('logs station-portal --tail 80'));
    } catch {}
    throw err;
  }
});
