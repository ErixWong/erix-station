// WP4 验收（#661 收窄重写）：保留 wp4 **真正独有**的四条真机断言。
//
// 为什么收窄：旧版 6 条断言里只有 3 条没被其它脚本覆盖，其余是重复造轮子（且旧版用硬编码端口
// PORTAL=127.0.0.1:18080 / TRAEFIK_WEB=127.0.0.1:8090 与共享栈 compose 形态，在隔离栈 28080/18090 上
// 必然 401/打错栈）。这版**登录 / 种子 / 起栈 / provision-fde 全部照抄 wp2a-e2e.mjs 那套已跑通的实现**
// （readCookie / insertUser / login / assertIsolatedEnvironment + writeTraefikStatic + writeDynamicStub +
//  派生 env + compose up + provision-fde），不另写第二套。
//
// 保留的三条（wp4 的独有价）：
//   ① 跨 FDE 隔离（D3「每 FDE 一网」）：provision 两个栈内 FDE（alice=FDE_NAME / bob=<栈id>bob），
//      双向都有真实 echo 监听的前提下，从一侧容器打另一侧 backend IP:port ⇒ 必须是**网络不可达类**
//      失败（BLOCKED / 超时），**不许**是 ECONNREFUSED（被拒=包已到达对端=隔离失败）；且两 FDE 网络
//      不同、各是池内一块独占小网段、且都不 publish 端口（D4）。
//   ② 预览 cookie 不透传上游（strip-cookie）：带预览 cookie 命中 200 时，上游 echo 探针**收不到**
//      `cookie` 头（边缘 forwardAuth 放行 + strip-cookie 中间件把请求侧 Cookie 整头剥掉）。
//   ③ 未路由 Host ⇒ 404：一个没被分配的 Host 打到边缘必须 404（不是 403、不是 200）。
//   ④ 吊销收敛：`containers.status='removed'` ⇒ agentd 下一次 claim/heartbeat 得 401
//      `token_revoked` ⇒ 优雅退出（`docker logs` 里 `"msg":"agentd exiting"` + `"revoke":"token_revoked"`）
//      ⇒ deprovision 回收容器，**另一个 FDE 仍 running**（隔离回收）。
//      ⚠ 这条是 261118 收窄重写时被误删、由独立审计 MED③ 指出才补回的：它是全仓**唯一**覆盖
//      `token_revoked` 收敛退出的 e2e（`grep -rn 'token_revoked' portal/integration/` 之前只剩注释）。
//      原来的覆盖对照表把它错记到「wp2a ⑧ / wp3b」——那两个**都不验** agentd 的退出日志。
//
// 删掉的断言 → 由谁覆盖（不静默删）：
//   · 未认证 403 + `preview_ticket_required`（含 deny CORS 头）→ **wp2a ⑥**
//   · 同块未分配端口 → 404、路由 backend 恒 .2:port、routes.yml 精确 subnet → **wp3a**
//   · 签票 302→cookie、allocated→active、事件落 DB（run_events）→ **wp2a ⑦ / wp3a**
//   · SSE 下行 ping → **wp2a ⑧**；`token_revoked` 收敛退出 + deprovision 隔离回收 → **本文件断言④**
//     （不是 wp2a/wp3b：那两个脚本都不读 agentd 退出日志，261118 二审 LOW② 纠正了这条错记）
//   · POST /api/projects 410（项目 API 退役）、userspace/端口下发 → **wp2a ①②③**
//   · LLM binding / mock LLM runner（旧 ⑤⑥ 的前置）→ **wp5 / wp6**
//
// 运行（必须带隔离 env，否则护栏在第一条 docker 之前硬失败；见 lib/isolated-env.mjs）：
//   rm -rf /tmp/station-db-<栈id>        # 必清：上一轮 alice 残留会撞 users_login_key + 旧 TOTP 让 step2 401
//   source <隔离 env>
//   node portal/integration/wp4-acceptance.mjs

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
import { BASE_DOMAIN, composeDomainEnv } from './lib/compose-domain.mjs';
import { DEFAULT_FDE_IMAGE, buildFdeImage } from './lib/fde-image.mjs';
import {
  assertHostPortsAvailable, applyStackIpamPoolEnv, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
  writeDynamicStub, deriveIsolationComposeEnv, deriveFdeIpamPools, memoizeOnce,
} from './lib/isolated-env.mjs';
import { COMPOSE_ENV_FILE, assertComposeEnvFile } from './lib/e2e-preflight.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// compose 一律显式 -p（${VAR:?} 未 export 即非零退出点名），env-file + compose 文件同 wp2a。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --env-file deploy/.env -f deploy/docker-compose.yml';
// 模块加载即检 env-file 在场（先于本文件任何一次 docker/compose）。
assertComposeEnvFile({ envFile: COMPOSE_ENV_FILE, cwd: REPO_ROOT, label: 'wp4-acceptance' });
// 两腿一次派生（放行面 + 分配段同值）。
applyStackIpamPoolEnv(process.env);

// —— 入口句柄全部 env 派生（缺省值只为可读，隔离跑法由护栏强制显式传）——
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const TRAEFIK_WEBSECURE_PORT = process.env.TRAEFIK_WEBSECURE_PORT || '8443';
const TRAEFIK_WEB = `http://127.0.0.1:${TRAEFIK_WEB_PORT}`;
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const FDE_IMAGE = process.env.FDE_IMAGE || DEFAULT_FDE_IMAGE;

// 两个**栈内** FDE（命名含栈 id，避免与共享栈 fde-alice/fde-bob 互删）：
//   alice = env.FDE_NAME（起栈 env 提供，如 e2e587alice）；bob = `<栈id>bob`（本脚本自造）。
const STACK_ID = process.env.STATION_STACK_ID;
const FDE_A = process.env.FDE_NAME || 'alice';
const FDE_B = `${STACK_ID}bob`;
// bob 也要进护栏的 fdeNames 校验：护栏对每个 entry 要求 value 含栈 id + 唯一 + 安全名，并要求其
// `env` 键在环境里存在（不要求 env 键值==value）。故显式注入一个合成键。
process.env.FDE_B_NAME = FDE_B;
const FDE_CONTAINER_A = `fde-${FDE_A}`;
const FDE_CONTAINER_B = `fde-${FDE_B}`;

// 本栈 FDE 网段必须落在派生保留段内（如 10.201.N.0/24）；FDE_POOL=large ⇒ 每 FDE 一块 /28。
const POOL_SEGMENT = STACK_ID ? deriveFdeIpamPools(STACK_ID) : null;
const POOL_PREFIX = POOL_SEGMENT ? POOL_SEGMENT.split('.').slice(0, 3).join('.') : null;

const isolationComposeEnv = memoizeOnce(() => (process.env.IPAM_RESERVED_SUBNETS
  ? {}
  : deriveIsolationComposeEnv({ docker, ownFdeNetwork: FDE_CONTAINER_A })));

// —— 下列辅助函数与 wp2a-e2e.mjs 同一份实现（换行/引号坑见 wp2a F-6 注释）——
function sgWrapped(cmd) {
  if (/\n|\r/.test(cmd)) {
    throw new Error(`经 sg/JSON.stringify 层的命令不得含换行: ${JSON.stringify(cmd)}`);
  }
  return `sg docker -c ${JSON.stringify(cmd)}`;
}

function docker(args) {
  return execSync(sgWrapped(`docker ${args}`), { encoding: 'utf8', stdio: 'pipe', cwd: REPO_ROOT });
}

function dockerStdin(args, input) {
  return execSync(sgWrapped(`docker ${args}`), { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], cwd: REPO_ROOT });
}

const { removeDbDir } = createDbDirCleaner({ docker });

function compose(args, env = {}) {
  return execSync(sgWrapped(`${COMPOSE} ${args}`), {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
    env: { ...process.env, ...DOMAIN_COMPOSE_ENV, ...isolationComposeEnv(), ...stackPaths(), ...env },
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

function psql(query) {
  if (/\n|\r/.test(query)) {
    throw new Error(`psql() 的 SQL 必须是单行（换行经 sg/JSON.stringify 会变成字面 \\n）: ${JSON.stringify(query)}`);
  }
  return docker(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}

function curl({ url, host = null, headers = [], args = '', out = 'resp' }) {
  const headerFile = path.join(S.artifactsRoot, `${out}.hdr`);
  const bodyFile = path.join(S.artifactsRoot, `${out}.body`);
  const hostArg = host ? `-H ${JSON.stringify(`Host: ${host}`)} ` : '';
  const headerArgs = headers.map((h) => `-H ${JSON.stringify(h)} `).join('');
  // `--ipv4`：宿主把 *.localhost 解析成 ::1，隔离栈 Traefik/FDE 只监听 IPv4 ⇒ 不强制 IPv4 会超时。
  const cmd = `curl -s --ipv4 -D ${JSON.stringify(headerFile)} -o ${JSON.stringify(bodyFile)} -w '%{http_code}' ${hostArg}${headerArgs}${args} ${JSON.stringify(url)}`;
  const status = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  const headersText = fs.existsSync(headerFile) ? fs.readFileSync(headerFile, 'utf8') : '';
  const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
  return { status, headers: headersText, body };
}

const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  artifactsRoot: null,
  staticFile: null,
  routesFile: null,
  cookieJar: null,
  password: 'correct horse battery staple',
  users: {
    alice: { login: 'alice', fdeName: FDE_A, container: FDE_CONTAINER_A, userId: '00000000-0000-0000-0000-000000000001' },
    bob: { login: 'bob', fdeName: FDE_B, container: FDE_CONTAINER_B, userId: '00000000-0000-0000-0000-000000000002' },
  },
};

function stackPaths() {
  const paths = {
    ERIX_USERSPACE_ROOT_HOST: S.userspaceRoot,
    TRAEFIK_DYNAMIC_DIR_HOST: S.dynamicRoot,
    TRAEFIK_STATIC_HOST: S.staticFile,
  };
  return Object.fromEntries(Object.entries(paths).filter(([, value]) => value !== undefined && value !== null));
}

function readRoutes() {
  return S.routesFile && fs.existsSync(S.routesFile) ? fs.readFileSync(S.routesFile, 'utf8') : '';
}

// —— 种子 + 登录（照抄 wp2a insertUser / login）——
async function insertUser({ id, login, role = 'fde', fdeName = null }) {
  const passwordHash = await auth.hashPassword(S.password);
  const secret = totp.generateSecret(20);
  psqlStdin(`
    INSERT INTO users (id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret)
    VALUES ('${id}', '${login}', '${login}', '${role}', ${fdeName ? `'${fdeName}'` : 'NULL'}, 'local', 'active',
            '${passwordHash}', '${secret}');
  `);
  return secret;
}

async function login(loginName, secret) {
  const step1 = await fetch(`${PORTAL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: loginName, password: S.password }),
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

function portalApi(pathname, { method = 'GET', cookie, body } = {}) {
  return fetch(`${PORTAL}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: `fde_session_dev=${cookie}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function containerIp(name) {
  return docker(`inspect ${name} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`).trim();
}

function containerNetIp(container, networkName) {
  return docker(`inspect ${container} --format '{{index .NetworkSettings.Networks "${networkName}" "IPAddress"}}'`).trim();
}

// provision 一个栈内 FDE 并采集其网段 / 后端 IP / 一块预览端口（口径与 wp2a 一致：端口从
// GET /api/me/ports 读，不自己猜）。
async function provisionAndCollect(u) {
  u.totpSecret = await insertUser({ id: u.userId, login: u.login, role: 'fde', fdeName: u.fdeName });
  u.cookie = await login(u.login, u.totpSecret);

  docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${u.fdeName}`);
  await waitFor(() => (safe(() => docker(`inspect ${u.container} --format {{.State.Status}}`).trim()) === 'running' ? 'running' : null),
    { label: `${u.container} running`, timeoutMs: 180000 });

  const netRow = psql(`SELECT network_name||'|'||subnet||'|'||gateway FROM fde_networks WHERE fde_id='${u.userId}'`);
  const [networkName, subnet, gateway] = netRow.split('|');
  assert.ok(networkName && subnet && gateway, `${u.login}: fde_networks 行不完整（${netRow}）`);
  assert.equal(networkName, `fde-${u.fdeName}`, `${u.login}: 网络名必须 = fde-<fdeName>（D3 每 FDE 一网）`);
  u.networkName = networkName;
  u.subnet = subnet;
  u.gateway = gateway;
  u.backendIp = intToIp((parseCidr(subnet).base + 2) >>> 0);
  // 容器在 fde 网络里的地址必须 = 后端固定位 .2（路由 backend 恒等于它，见 routes.js）。
  assert.equal(containerNetIp(u.container, networkName), u.backendIp, `${u.login}: 容器 IP 必须 = 后端固定位 .2`);

  const mine = await portalApi('/api/me/ports', { cookie: u.cookie });
  const raw = await mine.json().catch(() => null);
  assert.equal(mine.status, 200, `GET /api/me/ports (${u.login}): ${JSON.stringify(raw).slice(0, 200)}`);
  // /api/me/ports 返回 {"items":[…]}（不是裸数组）——两种形态都接住，端口仍从产品读侧取（不自己猜）。
  const ports = Array.isArray(raw) ? raw : (Array.isArray(raw?.items) ? raw.items : []);
  assert.ok(ports.length > 0, `${u.login}: 应有一块预览端口（实际 ${JSON.stringify(raw).slice(0, 200)}）`);
  const first = ports[0];
  u.portId = first.id;
  u.port = Number(first.port);
  u.hostname = first.hostname;
  assert.ok(u.port && u.hostname, `${u.login}: port/hostname 必须非空（实际 ${JSON.stringify(first)}）`);
}

// —— 断言① 用的三个 node 内联脚本（都不得含会在 sg/JSON 层出问题的字符；单引号可，双引号会被正确转义）——
const echoJs = (port) => `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify(q.headers))}).listen(${port})`;
const selfProbeJs = (port) => `fetch('http://127.0.0.1:${port}/',{signal:AbortSignal.timeout(3000)}).then(r=>{console.log('SELF_OK',r.status);process.exit(0)}).catch(e=>{console.log('SELF_FAIL',e.cause?.code||e.name);process.exit(1)})`;
const crossProbeJs = (ip, port) => `fetch('http://${ip}:${port}/',{signal:AbortSignal.timeout(4000)}).then(r=>{console.log('REACHED',r.status);process.exit(3)}).catch(e=>{console.log('BLOCKED',e.cause?.code||e.name);process.exit(0)})`;
// 「网络不可达 / DROP」类失败码：跨 FDE 隔离被 DROP ⇒ 不可达/超时；**不含 ECONNREFUSED**
// （ECONNREFUSED = 包已到达对端端口但端口关 = 隔离失败，对端拒绝而非被防火墙丢掉）。
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'TimeoutError', 'AbortError']);

test('WP4 验收（收窄）：跨 FDE 隔离 / strip-cookie 不透传 / 未路由 Host→404',
  { timeout: 15 * 60 * 1000 }, async (t) => {
    // —— 套件级 teardown（照 wp2a：清理失败必须红、零残留复查）——
    const teardownFailures = [];
    const teardown = (action, fn) => {
      try {
        fn();
      } catch (error) {
        const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
        console.warn(`[wp4] teardown ${action} 失败:`, detail);
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
    const ownedNames = [FDE_CONTAINER_A, FDE_CONTAINER_B];
    const ownedNetworks = [FDE_CONTAINER_A, FDE_CONTAINER_B];
    let stackTouched = false;

    const residual = [];
    const cleanup = () => {
      if (stackTouched) {
        teardown('compose down -v', () => compose('down -v'));
        teardown(`rm -f ${ownedNames.join(' ')}`, () => {
          const present = containerNamesPresent(...ownedNames);
          if (present.length) docker(`rm -f ${present.join(' ')}`);
        });
        teardown(`network rm ${ownedNetworks.join(' ')}`, () => {
          const present = networkNamesPresent(...ownedNetworks);
          if (present.length) docker(`network rm ${present.join(' ')}`);
        });
        teardown('removeDbDir', () => {
          if (removeDbDir() === null) throw new Error('lib removeDbDir 返回 null（STATION_DB_DIR 未清掉）');
        });
        try {
          const stackId = process.env.STATION_STACK_ID;
          const project = process.env.COMPOSE_PROJECT_NAME;
          if (stackId) {
            residual.push(...dockerOut(`ps -a --filter label=station.stack=${stackId} -q`).map((id) => `容器 ${id}（label station.stack=${stackId}）`));
            residual.push(...dockerOut(`network ls --filter label=station.stack=${stackId} -q`).map((id) => `网络 ${id}（label station.stack=${stackId}）`));
          }
          if (project) {
            residual.push(...dockerOut(`ps -a --filter label=com.docker.compose.project=${project} -q`).map((id) => `容器 ${id}（compose project ${project}）`));
            residual.push(...dockerOut(`network ls --filter label=com.docker.compose.project=${project} -q`).map((id) => `网络 ${id}（compose project ${project}）`));
          }
          residual.push(...containerNamesPresent(...ownedNames).map((n) => `容器 ${n}（按名复查）`));
          residual.push(...networkNamesPresent(...ownedNetworks).map((n) => `网络 ${n}（按名复查）`));
        } catch (error) {
          const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
          console.warn('[wp4] teardown 零残留复查 执行失败:', detail);
          teardownFailures.push(`零残留复查执行失败：${detail}`);
        }
      }
      const rmTree = (dir) => {
        if (!dir || !fs.existsSync(dir)) return;
        const fix = (d) => {
          let ents = [];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { /* 读不了就直接 chmod */ }
          try { fs.chmodSync(d, 0o700); } catch { /* 非属主时交给下面的 rm 报 */ }
          for (const e of ents) if (e.isDirectory()) fix(path.join(d, e.name));
        };
        fix(dir);
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
          const image = process.env.FDE_IMAGE || process.env.STATION_PORTAL_IMAGE;
          if (!image) throw error;
          execSync(`docker run --rm --user 0 --entrypoint sh -v ${JSON.stringify(`${dir}:/x`)} ${image} -c 'rm -rf /x/* /x/.[!.]* 2>/dev/null; exit 0'`, { stdio: 'pipe' });
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        }
      };
      teardown('rm -rf userspace 临时目录', () => S.userspaceRoot && rmTree(S.userspaceRoot));
      teardown('rm -rf dynamic 临时目录', () => S.dynamicRoot && rmTree(S.dynamicRoot));
      teardown('rm -rf static 临时目录', () => S.staticRoot && rmTree(S.staticRoot));
      teardown('rm -rf artifacts 临时目录', () => S.artifactsRoot && rmTree(S.artifactsRoot));
      const problems = [
        ...teardownFailures.map((action) => `清理动作失败：${action}`),
        ...residual.map((item) => `残留资源：${item}`),
      ];
      assert.deepEqual(problems, [], `wp4 清场未清干净（清理失败必须红）:\n${problems.join('\n')}`);
    };
    t.after(cleanup);

    let fatal = null;
    const step = (name, fn) => t.test(name, async (st) => {
      if (fatal) {
        st.skip(`前置段已失败，跳过（首个失败：${fatal.message}）`);
        return;
      }
      try {
        await fn(st);
      } catch (err) {
        if (!fatal) fatal = err;
        throw err;
      }
    });

    await step('① 隔离护栏 + 临时夹具 + edge watch 桩（必须早于 compose up）', async () => {
      // 两个 FDE 都进护栏：都必须是含栈 id 的栈内名，否则 fde-<name> 会与共享栈同名互删。
      assertIsolatedEnvironment({
        litellm: false,
        fdeNames: [
          { env: 'FDE_NAME', value: FDE_A, sharedDefault: 'alice' },
          { env: 'FDE_B_NAME', value: FDE_B, sharedDefault: 'bob' },
        ],
      });
      await assertHostPortsAvailable([PORTAL_HOST_PORT, TRAEFIK_WEB_PORT, TRAEFIK_WEBSECURE_PORT]);
      assert.ok(process.env.BASE_DOMAIN, 'BASE_DOMAIN 必须 export（不 export 缺省 localhost，预览 host 口径不一致）');

      S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp4-'));
      S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp4-'));
      S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp4-'));
      S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp4-'));
      S.routesFile = path.join(S.dynamicRoot, 'routes.yml');
      S.cookieJar = path.join(S.artifactsRoot, 'preview-cookies.txt');
      S.staticFile = writeTraefikStatic(S.staticRoot, {
        repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: TRAEFIK_WEBSECURE_PORT,
        adminPort: process.env.TRAEFIK_ADMIN_PORT || '19443',
      });
      for (const dir of [S.userspaceRoot, S.dynamicRoot, S.staticRoot, S.artifactsRoot]) fs.chmodSync(dir, 0o755);

      const stub = writeDynamicStub(S.dynamicRoot);
      assert.equal(stub.created, true, '刚 mkdtemp 的动态目录里桩必须是「新写」');
      assert.equal(fs.readFileSync(stub.file, 'utf8'), 'http: {}\n', '桩正文必须是合法空配置 http: {}');
      assert.equal(writeDynamicStub(S.dynamicRoot).created, false, '幂等：对自己的桩再调一次不得重写');
    });

    await step('② 起栈（自建 FDE 镜像 + compose up + portal healthz）', async () => {
      stackTouched = true;
      safe(() => compose('down -v'));
      removeDbDir();
      buildFdeImage(FDE_IMAGE);
      compose('up -d --build', { MIGRATE_ON_START: '1', FDE_IMAGE });
      await waitFor(async () => (await fetch(`${PORTAL}/healthz`).catch(() => null))?.status === 200,
        { label: `portal healthz (${PORTAL})`, timeoutMs: 240000 });
    });

    await step('③ provision 两个栈内 FDE（alice + bob）：登录、网段、后端 IP、一块预览端口', async () => {
      await provisionAndCollect(S.users.alice);
      await provisionAndCollect(S.users.bob);

      // 两端各起 echo 监听（真实监听 ⇒ 后面的跨向失败才是「隔离 DROP」证据，不是「没人监听」）。
      for (const u of [S.users.alice, S.users.bob]) {
        docker(`exec -d ${u.container} node -e ${JSON.stringify(echoJs(u.port))}`);
      }
      // echo 就绪自证（exec -d 返回 ≠ 端口已监听）。
      for (const u of [S.users.alice, S.users.bob]) {
        await waitFor(() => {
          const out = safe(() => docker(`exec ${u.container} node -e ${JSON.stringify(selfProbeJs(u.port))}`)) ?? '';
          return out.includes('SELF_OK') ? out : null;
        }, { label: `echo 就绪 ${u.container}:${u.port}`, timeoutMs: 30000 });
      }
    });

    await step('④ 断言①：跨 FDE 隔离——双向真实监听下跨向必须不可达（非 ECONNREFUSED）；两网不同、各池内独占小段、不 publish', async () => {
      const { alice, bob } = S.users;

      // 两个 FDE 网络不同（D3 每 FDE 一网）。
      assert.notEqual(alice.networkName, bob.networkName, `两 FDE 网络必须不同：${alice.networkName} vs ${bob.networkName}`);
      assert.notEqual(alice.subnet, bob.subnet, `两 FDE 网段必须不同：${alice.subnet} vs ${bob.subnet}`);

      // 每 FDE 一块**独占小段**：本栈 FDE_POOL=large ⇒ /28（拓扑 §3 的缺省 /29 在 large 池放宽为 /28）；
      // 都落在派生保留段（POOL_PREFIX）内，绝非整段 /24 或 /16。
      for (const u of [alice, bob]) {
        const prefix = parseCidr(u.subnet).prefixLen;
        assert.ok(prefix >= 28, `${u.login}: 网段必须 ≤ /28 的独占小段（FDE_POOL=large ⇒ /28），实际 /${prefix}`);
        assert.ok(u.backendIp.startsWith(POOL_PREFIX + '.'), `${u.login}: 后端 IP ${u.backendIp} 必须在派生保留段 ${POOL_SEGMENT} 内`);
      }
      assert.notEqual(alice.backendIp, bob.backendIp, '两后端 IP 必须不同');

      // D4：FDE 容器不 publish 任何端口。
      for (const u of [alice, bob]) {
        const pb = docker(`inspect ${u.container} --format '{{json .HostConfig.PortBindings}}'`).trim();
        assert.equal(pb, '{}', `${u.login}: fde 容器不得 publish 端口（D4），得到 ${pb}`);
      }

      // 双向跨向探测：from 容器打 to 后端 IP:port，必须 BLOCKED 且失败码属「网络不可达」类。
      for (const [from, to] of [['alice', 'bob'], ['bob', 'alice']]) {
        const f = S.users[from];
        const o = S.users[to];
        const out = docker(`exec ${f.container} node -e ${JSON.stringify(crossProbeJs(o.backendIp, o.port))}`);
        assert.match(out, /BLOCKED/, `断言① 跨 FDE 隔离：${f.container} → ${o.backendIp}:${o.port} 必须不可达（得到 ${out.trim()}）`);
        const code = (out.match(/BLOCKED (\S+)/) ?? [])[1] ?? '';
        assert.ok(UNREACHABLE.has(code), `断言① 失败码必须是网络不可达类而非 ECONNREFUSED（隔离被 DROP，非对端拒绝）：${code}`);
      }
      console.log(`[wp4] ① 跨 FDE 隔离 OK（${alice.networkName}/${bob.networkName} 不同网、各 ≤/28 且在 ${POOL_SEGMENT}、不 publish、双向 DROP 非 ECONNREFUSED）`);
    });

    await step('⑤ 断言②：strip-cookie——带预览 cookie 命中 200，上游 echo 收不到 cookie 头（用 alice）', async () => {
      const { alice } = S.users;
      // 路由必须先物化（reconciler 异步写 routes.yml）。
      await waitFor(() => (readRoutes().includes(alice.hostname) ? 'routed' : null),
        { label: `routes.yml 含 ${alice.hostname}`, timeoutMs: 120000 });

      const issued = await portalApi(`/api/ports/${alice.portId}/preview-ticket`, { method: 'POST', cookie: alice.cookie, body: {} });
      const ticket = await issued.json().catch(() => ({}));
      assert.equal(issued.status, 201, `签发 alice 预览票据：${JSON.stringify(ticket)}`);
      assert.match(ticket.ticket, /^pt_/, 'ticket 形态 pt_<base64url>');

      const boot = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/?preview_ticket=${ticket.ticket}`, host: alice.hostname, args: `-c ${JSON.stringify(S.cookieJar)}`, out: 'bootstrap' });
        return res.status === '302' ? res : null;
      }, { label: `带票据兑换 302 (${alice.hostname})`, timeoutMs: 60000 });
      assert.match(boot.headers, /^set-cookie:\s*\S*fde_preview\S*=/im, 'Set-Cookie 种下预览 cookie');

      const ok200 = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/`, host: alice.hostname, args: `-b ${JSON.stringify(S.cookieJar)}`, out: 'with-cookie' });
        return res.status === '200' ? res : null;
      }, { label: `带预览 cookie 命中 echo 200 (${alice.hostname})`, timeoutMs: 60000 });
      const echoed = JSON.parse(ok200.body);
      // 本脚本的 echo 直接回显 q.headers（不像 wp2a 的探针包一层 {headers}），所以字段就在顶层。
      assert.equal(echoed.host, alice.hostname, 'echo 回显 Host = 该预览 host（确实代理到本 FDE 后端）');
      assert.equal(echoed['x-auth-user'], alice.fdeName, 'X-Auth-User 由 forwardAuth 放行后透传（证明走放行分支而非绕过边缘）');
      assert.equal(echoed.cookie ?? '', '', '断言② strip-cookie：边缘把请求侧 Cookie 整头剥掉，应用看不到平台 cookie');
      console.log('[wp4] ② strip-cookie OK（带预览 cookie 200，上游 echo 无 cookie 头）');
    });

    await step('⑥ 断言③：未路由 Host → 404（不是 403、不是 200）', async () => {
      const suffix = S.users.alice.hostname.slice(S.users.alice.hostname.indexOf('.')); // 如 .fde.localhost
      const strayHost = `wp4-stray-${Date.now()}${suffix}`;
      const stray = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/`, host: strayHost, out: 'stray-host' });
        return res.status === '404' ? res : null;
      }, { label: `未路由 Host ${strayHost} → 404`, timeoutMs: 60000 });
      assert.equal(stray.status, '404', `断言③ 未分配 Host 必须 404（不是 403、不是 200）`);
      console.log(`[wp4] ③ 未路由 Host → 404 OK（${strayHost}）`);
    });

    // ---------------------------------------------------------------------
    // 断言④ 吊销收敛：token 被吊销 → agentd 优雅退出 → deprovision 回收容器，另一个 FDE 不受影响
    //
    // ⚠ 这条是**旧 wp4 的 ⑥**，261118 收窄重写时被我连同 463 行一起删掉了，独立审计（MED③）
    // 指出它是全仓**唯一**覆盖（`grep -rn 'token_revoked' portal/integration/` 只剩注释）。
    // 现按 `docker logs` 读（agentd 是容器主进程，JSON 直接进 stdout，不再需要老版的日志文件通道）。
    // 语义：置 `containers.status='removed'`（offboard 的 DB 信号）⇒ agentd 下一次 claim/heartbeat
    // 得 401 token_revoked ⇒ 双循环收敛退出；随后 deprovision 回收容器/网络。
    // ---------------------------------------------------------------------
    await t.test('断言④ token 吊销 → agentd 优雅退出 → 回收只影响本 FDE', async () => {
      const { alice, bob } = S.users;
      // psql() 只收单行 SQL（换行经 sg/JSON.stringify 会变字面 \n）
      psql(`UPDATE containers SET status = 'removed', updated_at = now() WHERE fde_name = '${alice.fdeName}' AND status <> 'removed'`);
      await waitFor(() => {
        const out = safe(() => docker(`logs ${alice.container} 2>&1`)) ?? '';
        return out.includes('"msg":"agentd exiting"') && out.includes('"revoke":"token_revoked"') ? out : null;
      }, { label: 'agentd 收 token_revoked 并优雅退出', timeoutMs: 120000, intervalMs: 1000 });

      docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js deprovision-fde --fde-name ${alice.fdeName}`);
      await waitFor(() => (safe(() => docker(`inspect ${alice.container} --format {{.Id}}`).trim()) ? null : true),
        { label: `${alice.container} 已回收`, timeoutMs: 90000 });

      assert.equal(docker(`inspect ${bob.container} --format {{.State.Status}}`).trim(), 'running',
        `断言④ deprovision ${alice.fdeName} 不得影响 ${bob.fdeName}（隔离回收）`);
      console.log(`[wp4] ④ token_revoked → agentd 优雅退出 → 回收 ${alice.fdeName}，${bob.fdeName} 不受影响 OK`);
    });

    console.log('\n[wp4] ✅ 四条断言全部通过：跨 FDE 隔离 / strip-cookie 不透传 / 未路由 Host→404 / 吊销收敛');
  });
