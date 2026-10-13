// WP2a 真机端到端（需 docker；docker 命令经 `sg docker -c` 绕过，env §8.1）。
//
// **本脚本是工单 F（#268 决策第 2 条）重建后的形态**：按 P5（目录即项目）+ 迁移 0019（FDE 级端口块）
// 的现役语义重写，旧版里「POST /api/projects → 项目级 ports.json/manifest.json → DELETE 项目 → 端口回收」
// 那一半断言对象已从产品里消失（P5 把 POST /api/projects 打成 410、#240/#246 把预览端口改成 FDE 级预分配、
// 去置备走 deprovision-fde/offboarding）。
//
// 覆盖什么（幸存价值三样）：
//   ① 起栈全套公共件（护栏 + edge watch 桩 + 派生 env + FDE 镜像自建）
//   ② userspace 与端口下发：宿主 <ERIX_USERSPACE_ROOT_HOST>/<fde> 树的属主/权限合规（口径 = **真机现状**，
//      不是代码常量：工作区目录 0770 而非 2770，意图缺口逐字记在第④段注释里）+ 容器内
//      `~/.erix/ports.json`（宿主 bind 同一份）与 DB `port_allocations` 活行**逐条对账**
//      （scope=fde、号池内按 10 对齐的一块、hostname/url 与端口一致）
//   ③ 预览签票链路：`GET /api/me/ports` → `POST /api/ports/:id/preview-ticket` → `?preview_ticket=` 302
//      换预览 cookie → 带 cookie 命中 FDE 网络内的探针（Traefik backend = FDE 固定位 .2:<port>）
//      + 无票直连 fail-closed 403/`preview_ticket_required`（顺带守 #241 的 deny CORS 头）
//   ④ 去置备收敛：`deprovision-fde` ⇒ 容器/网络消失、fde_networks released、routes.yml 撤掉预览 host、
//      对该 host 直连 404；**端口不在此刻回收**（代码现状：`deprovisionFde` 只释放网段/吊销 token，
//      `port_allocations` 的 released 属 offboarding 的 `release-network-routes` 一步，见
//      portal/src/offboarding.js releaseNetworkRoutes）——工单写「deprovision 后 released」与代码不符，
//      以代码为准，因此另有第⑨段用 offboarding 把 released + 票据撤销这条路补齐。
// 不覆盖什么（别在这里加）：
//   · P5 建会话 + 物化写 config.json + 真 agentd SSE → **wp3b**
//   · LLM key 注入 / 模型白名单 / 生命周期 → **wp5**、**wp6**
//   · internal API + run 状态机 + LiteLLM mock_response → **wp3a**
//   · 管理员改端口块（搬迁事务）→ portal/test/preview-ports.test.js + 单 B 前端 spec
//
// 运行：npm run test:integration（⚠️ issue #226 起**必须带隔离 env**，见下；缺 env 直接硬失败，
//   不再默默对共享 dev 栈动手。）
//
// —— 隔离 env 清单（issue #226；与 wp3a/wp3b/wp5/wp6 同一套，判据集中在 lib/isolated-env.mjs）——
//   STATION_STACK_ID=<唯一栈 id> COMPOSE_PROJECT_NAME=<同一个栈 id>
//   STATION_DB_DIR=/tmp/station-db-<栈 id>（必须不存在；缺省会 rm -rf 共享 dev 库数据目录）
//   STATION_DB_NAME/STATION_PORTAL_NAME/STATION_DOCKER_PROXY_NAME/STATION_EDGE_NAME=station-*-<栈 id>
//   PORTAL_HOST_PORT=<非 18080> TRAEFIK_WEB_PORT=<非 8090> TRAEFIK_WEBSECURE_PORT=<非 8443>
//   FDE_NAME=<含栈 id 的 FDE 名>（`fde-<name>` 是全局 docker 网络/容器名，不派生会与共享栈互删）
//   BACKEND_SUBNET=<非 172.32.0.0/24> FDE_POOL=large（FDE_IPAM_POOLS 可不传：缺省由
//     defaultFdeIpamPools(栈 id) 派生；显式传入优先，#227.3）
//   STATION_PORTAL_IMAGE/STATION_DOCKER_PROXY_IMAGE/FDE_IMAGE=…:<栈 id>
//   FDE_DEV_MODE=1（#227.1 起必需：FDE_IMAGE 为 image:tag 形态时须显式声明 dev 模式；digest 形态豁免）
//   BASE_DOMAIN=…（**必须 export**，如 fde.erix.vip 或自建域，#268 M2 警示：不 export 时
//     composeDomainEnv 缺省 localhost ⇒ 路由 host 物化成 station.localhost，预览 host 也跟着变，
//     与真机口径不一致。本脚本对「没 export BASE_DOMAIN」直接硬失败。）
//   IPAM_RESERVED_SUBNETS 可不传：up 前自动扫其他栈的 fde-* 子网补齐（#268 M2，与 wp3a/wp3b 同源）
//   （本栈**不带** litellm profile ⇒ 不需要 LITELLM_HOST_PORT/STATION_LITELLM_NAME。）
//   TRAEFIK_STATIC_HOST 由脚本自动生成（只改入口端口的临时 traefik.yml，F8）；代理构建/镜像与
//   HTTP_PROXY 口径见 lib/fde-image.mjs。
//
// 真机跑之前要知道的事（交付报告里也有）：
//   · 预期时长：冷栈（portal/proxy 镜像 + FDE 镜像冷构建需联网下 gh/tea/glab，须先 export
//     HTTP_PROXY/HTTPS_PROXY）约 8–15 分钟；栈已热时约 3–5 分钟。整脚本 timeout 15 分钟。
//   · 预览票据 TTL 缺省 60s（PREVIEW_TICKET_TTL_SECONDS）⇒ 签完票立刻兑换，别在中间做长等待。
//   · 探针容器用 `--network container:fde-<name>`（共享 FDE 容器 netns），**必须**在 deprovision 前
//     显式 `docker rm -f`：netns 依赖会让 FDE 容器删除失败（→ deprovision 抛错）。
//     探针镜像 `node:22-alpine` 需已在本地（wp3a 已依赖同一个镜像）。
//   · 第⑨段依赖 portal 进程内的 offboarding 循环（间隔 5s）——不要把它关掉。
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
import { PREVIEW_PORT_COUNT, PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END } from '../src/previewpool.js';
import { BASE_DOMAIN, LLM_HOST, composeDomainEnv } from './lib/compose-domain.mjs';
import { DEFAULT_FDE_IMAGE, buildFdeImage } from './lib/fde-image.mjs';
import { reconcilePortsJsonWithDb } from './lib/ports-reconcile.mjs';
import {
  assertHostPortsAvailable, defaultFdeIpamPools, assertIsolatedEnvironment, createDbDirCleaner, writeTraefikStatic,
  writeDynamicStub, deriveIsolationComposeEnv, memoizeOnce,
} from './lib/isolated-env.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// #227.2：compose 一律显式 -p，且用 bash 的 `${VAR:?msg}`——未 export 时展开即非零退出并点名，
// 不再依赖「COMPOSE_PROJECT_NAME 环境变量压过 compose 文件 name: station」这条隐式优先级
// （忘 export 曾经会让脚本自己对共享 dev 栈 down -v）。
const COMPOSE = 'docker compose -p "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME required for isolated e2e}" --env-file deploy/.env -f deploy/docker-compose.yml';

// #227.3：FDE_IPAM_POOLS 未显式传时按栈 id 派生本栈口径（派生段+portal large 池固定段；显式传入优先）。
if (!process.env.FDE_IPAM_POOLS && process.env.STATION_STACK_ID) {
  process.env.FDE_IPAM_POOLS = defaultFdeIpamPools(process.env.STATION_STACK_ID);
}

// issue #226：入口句柄全部 env 派生（缺省值保留现状值只为可读，隔离跑法由护栏强制显式传）。
const PORTAL_HOST_PORT = process.env.PORTAL_HOST_PORT || '18080';
const PORTAL = `http://127.0.0.1:${PORTAL_HOST_PORT}`;
const TRAEFIK_WEB_PORT = process.env.TRAEFIK_WEB_PORT || '8090';
const TRAEFIK_WEBSECURE_PORT = process.env.TRAEFIK_WEBSECURE_PORT || '8443';
const TRAEFIK_WEB = `http://127.0.0.1:${TRAEFIK_WEB_PORT}`;
const DOMAIN_COMPOSE_ENV = composeDomainEnv(TRAEFIK_WEB_PORT);
const PUBLIC_BASE_URL = DOMAIN_COMPOSE_ENV.PORTAL_PUBLIC_BASE_URL;
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
const STATION_PORTAL_NAME = process.env.STATION_PORTAL_NAME || 'station-portal';
const FDE_NAME = process.env.FDE_NAME || 'alice';
const FDE_CONTAINER = `fde-${FDE_NAME}`; // provisioner/IPAM 命名规则：fde-<fde_name>
const FDE_IMAGE = process.env.FDE_IMAGE || DEFAULT_FDE_IMAGE;
const PROBE_CONTAINER = `${FDE_CONTAINER}-probe`;
const PROBE_IMAGE = process.env.WP2A_PROBE_IMAGE || 'node:22-alpine';
// 探针：共享 FDE 容器 netns 的最小 echo server。路由 backend 恒等于「FDE 容器固定位 .2:<port>」
// （routes.js readRouteDesiredState），所以在同一 /29 里另起一个容器**不会**被路由到（IP 不是 .2），
// 必须 --network container: 把监听落到 .2 上——这是工单「docker run --network fde-<name>」形态
// 在 P5/0019 之后的等价实现（见交付报告「与工单的差异」）。
const PROBE_SCRIPT = 'const h=require("http");h.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({method:q.method,url:q.url,headers:q.headers}))}).listen(process.env.PROBE_PORT,"0.0.0.0")';

// #268 M2：IPAM_RESERVED_SUBNETS 用公共派生件补齐（未显式传时扫**其他栈**的 fde-* 网络子网 →
// 保留段，不传会 Pool overlaps；派生本体在 lib/isolated-env.mjs，与 wp3a/wp3b 同一份）。
// 惰性求值 + 记忆化：首次 compose（预清理 down）时查一次 docker，之后不再查；显式传入一律优先。
const isolationComposeEnv = memoizeOnce(() => (process.env.IPAM_RESERVED_SUBNETS
  ? {}
  : deriveIsolationComposeEnv({ docker, ownFdeNetwork: FDE_CONTAINER })));

// 工单 F-6：命令串进容器要经**两层** shell——`execSync` 解析一次 `sg docker -c "…"`，sg 再把参数交给
// `sh -c` 解析第二次。命令里的**真实换行**在 JSON.stringify 这一步就变成字面 `\n` 两个字符，而双引号
// 内的 POSIX shell **不还原**它 ⇒ 下游收到的是 `run_id\n FROM` 这种带反斜杠的垃圾（psql 报
// `ERROR: syntax error at or near "\"`，工单 F-6 在真机 §⑤ 上撞的就是这个）。
// ⇒ 换行只许活在**走 stdin 的载荷**里（dockerStdin 的第二个实参、psqlStdin 的 SQL），命令串本身必须单行。
// 这里当场抛（带着命令原文），别让它跑到 psql 里变成一句看不出所以然的语法错。
function sgWrapped(cmd) {
  if (/\n|\r/.test(cmd)) {
    throw new Error(`经 sg/JSON.stringify 层的命令不得含换行（换行会变成字面 \\n 两字符，见工单 F-6）: ${JSON.stringify(cmd)}`);
  }
  return `sg docker -c ${JSON.stringify(cmd)}`;
}

function docker(args) {
  return execSync(sgWrapped(`docker ${args}`), {
    encoding: 'utf8',
    stdio: 'pipe',
    cwd: REPO_ROOT,
  });
}

function dockerStdin(args, input) {
  return execSync(sgWrapped(`docker ${args}`), {
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

/** **单行** SQL 的唯一正确通道：SQL 作为 `-tAc` 的实参进命令串，要过 sg/JSON.stringify 那两层引号
 *  （见 sgWrapped）。要跑多行 SQL 就用下面的 psqlStdin()——SQL 走 `docker exec -i` 的 stdin，
 *  不碰引号层，换行天然安全（§③ 的 insertUser 就是这条路，所以它从来没坏过）。 */
function psql(query) {
  if (/\n|\r/.test(query)) {
    throw new Error(`psql() 的 SQL 必须是单行（换行经 sg/JSON.stringify 会变成字面 \\n，psql 实收即 syntax error at or near "\\"；工单 F-6）: ${JSON.stringify(query)}`);
  }
  return docker(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`).trim();
}

/** 多行 SQL 走 stdin：`-v ON_ERROR_STOP=1` 让 psql 在首错即停（dockerStdin 不抛 = 语句全过）。 */
function psqlStdin(sql) {
  dockerStdin(`exec -i ${STATION_DB_NAME} psql -U station -d station -v ON_ERROR_STOP=1`, sql);
}

/** curl 一次并把响应头/响应体落到本脚本临时目录，返回 {status, headers, body}（用文件而不是解析管道，
 *  免得 -i 的正文/头分界与 302 空正文把解析搞糊）。 */
function curl({ url, host = null, headers = [], args = '', out = 'resp' }) {
  const headerFile = path.join(S.artifactsRoot, `${out}.hdr`);
  const bodyFile = path.join(S.artifactsRoot, `${out}.body`);
  const hostArg = host ? `-H ${JSON.stringify(`Host: ${host}`)} ` : '';
  const headerArgs = headers.map((h) => `-H ${JSON.stringify(h)} `).join('');
  const cmd = `curl -s -D ${JSON.stringify(headerFile)} -o ${JSON.stringify(bodyFile)} -w '%{http_code}' ${hostArg}${headerArgs}${args} ${JSON.stringify(url)}`;
  const status = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
  const headersText = fs.existsSync(headerFile) ? fs.readFileSync(headerFile, 'utf8') : '';
  const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
  return { status, headers: headersText, body };
}

// 状态（跨子测试共享；teardown 是套件级的，所以夹具句柄也放这里）
const S = {
  userspaceRoot: null,
  dynamicRoot: null,
  staticRoot: null,
  artifactsRoot: null,
  staticFile: null,
  password: 'correct horse battery staple',
  totpSecret: null,
  cookie: null,
  userId: '00000000-0000-0000-0000-000000000001',
  subnet: null,
  gateway: null,
  networkName: null,
  backendIp: null,
  portsJson: null,
  allocations: [],
  hostname: null,
  port: null,
  allocationId: null,
  spareHostname: null,
  spareAllocationId: null,
  spareTicket: null,
  cookieJar: null,
  routesFile: null,
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

/** 宿主 userspace 里 <root>/<fde> 下的相对路径。 */
function hostPathOf(...rel) {
  return path.join(S.userspaceRoot, FDE_NAME, ...rel);
}

function readRoutes() {
  return fs.existsSync(S.routesFile) ? fs.readFileSync(S.routesFile, 'utf8') : '';
}

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

function livePortRows() {
  // 工单 F-6：这一条**曾经**在 `run_id` 与 `FROM` 之间折了行 ⇒ 经 sg/JSON.stringify 后 psql 实收
  // `run_id\n FROM port_allocations`，真机 §⑤ 直接 `ERROR: syntax error at or near "\"`（首失败点）。
  // 整条压成单行；要折行请改写进 psqlStdin()（stdin 不经引号层）。
  const out = psql(`SELECT json_agg(t) FROM (SELECT port, hostname, url, scope, role, exposure, state, run_id FROM port_allocations WHERE fde_id='${S.userId}' AND state <> 'released' ORDER BY port) t`);
  return out && out !== 'null' ? JSON.parse(out) : [];
}

function countPorts(state) {
  return Number(psql(`SELECT count(*) FROM port_allocations WHERE fde_id='${S.userId}' AND state ${state}`));
}

test('WP2a 重建（P5+0019）：开户 → userspace/端口下发 → 预览签票可达 → 去置备与 offboarding 收敛',
  { timeout: 15 * 60 * 1000 }, async (t) => {
    // —— 套件级 teardown（#269/#224 口径：清场失败必须红、零残留复查；形态照 wp6 的 teardown()）——
    // 动作先查在不在再删：资源「本就不存在」不是清理失败（deprovision/offboarding 已删过）。
    const teardownFailures = [];
    const teardown = (action, fn) => {
      try {
        fn();
      } catch (error) {
        const detail = String(error?.stderr || error?.message || error).trim().split('\n')[0];
        // eslint-disable-next-line no-console
        console.warn(`[wp2a] teardown ${action} 失败:`, detail);
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
    const ownedNames = [FDE_CONTAINER, PROBE_CONTAINER];
    const ownedNetworks = [FDE_CONTAINER];
    // 护栏在起栈前就硬失败（如无隔离 env）时，本脚本**一条 docker 都不该发**：没有本栈资源，
    // 「顺手 down -v / 零残留复查」不仅多余，还在无 env 跑法里多了碰共享栈的机会。
    // ② 段开头置 true（预清理 down 之前），所以「起栈途中失败」仍会正常清场。
    let stackTouched = false;

    const residual = [];
    const cleanup = () => {
      // 本栈相关（需 docker）：只在真的动过栈之后才做。
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
        // lib 的 removeDbDir 对 docker 失败不抛（teardown 语义），以返回 null 记失败——这里翻译成显式失败。
        teardown('removeDbDir', () => {
          if (removeDbDir() === null) throw new Error('lib removeDbDir 返回 null（docker 删除执行失败，STATION_DB_DIR 未清掉）');
        });
        // 零残留复查（#224/#269）：本栈标签的容器/网络必须为 0；FDE 容器/网络由 provisioner 打
        // station.stack=<栈 id> 标签，compose 资源自带 com.docker.compose.project 标签。
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
          // eslint-disable-next-line no-console
          console.warn('[wp2a] teardown 零残留复查 执行失败:', detail);
          teardownFailures.push(`零残留复查执行失败：${detail}`);
        }
      }
      // 本脚本自己的临时目录（不碰 docker；护栏拦下时也一样要清）。
      // issue #178：不删镜像（共享 tag 绝不能被 e2e 删除；compose up --build 按需重建）。
      teardown('rm -rf userspace 临时目录', () => S.userspaceRoot && fs.rmSync(S.userspaceRoot, { recursive: true, force: true }));
      teardown('rm -rf dynamic 临时目录', () => S.dynamicRoot && fs.rmSync(S.dynamicRoot, { recursive: true, force: true }));
      teardown('rm -rf static 临时目录', () => S.staticRoot && fs.rmSync(S.staticRoot, { recursive: true, force: true }));
      teardown('rm -rf artifacts 临时目录', () => S.artifactsRoot && fs.rmSync(S.artifactsRoot, { recursive: true, force: true }));
      const problems = [
        ...teardownFailures.map((action) => `清理动作失败：${action}`),
        ...residual.map((item) => `残留资源：${item}`),
      ];
      assert.deepEqual(problems, [], `wp2a 清场未清干净（#224/#269，清理失败必须红、不允许静默）:\n${problems.join('\n')}`);
    };
    t.after(cleanup);

    // 子测试分段（#227 第 4 项：新脚本从第一行就用 t.test 分段；teardown 保持套件级）。
    // 前一段硬失败 ⇒ 后面的段整段 skip（它们的前置条件已经不成立），但**仍计入 tests 计数**，
    // 于是「跑了几段」在输出里是可数的。
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
      // wp2a 不起 litellm profile ⇒ litellm:false（不要求 LITELLM_HOST_PORT/STATION_LITELLM_NAME）。
      // 护栏放在第一个可执行语句：无 env 裸跑必须「一条 docker 都还没发」就硬失败。
      assertIsolatedEnvironment({
        litellm: false,
        fdeNames: [{ env: 'FDE_NAME', value: FDE_NAME, sharedDefault: 'alice' }],
      });
      await assertHostPortsAvailable([PORTAL_HOST_PORT, TRAEFIK_WEB_PORT, TRAEFIK_WEBSECURE_PORT]);
      // #268 M2：BASE_DOMAIN 没 export ⇒ composeDomainEnv 缺省 localhost，路由 host 与预览 host
      // 全物化成 *.localhost（真机口径不一致）——以前只有 agentd 404 时才被发现，这里起栈前就拦。
      assert.ok(process.env.BASE_DOMAIN, 'BASE_DOMAIN 必须 export（#268 M2：不 export 时缺省 localhost，路由 host 物化成 station.localhost）');
      if (BASE_DOMAIN === 'localhost') {
        // eslint-disable-next-line no-console
        console.warn('[wp2a] BASE_DOMAIN=localhost：预览 host 会退化成 *.localhost（能跑，但与真机口径不同）');
      }

      // 隔离目录（不碰真实 /srv/erix/users 与 repo 动态目录）。
      // mkdtemp 默认 0700；Traefik 容器（root + cap_drop ALL，无 DAC_OVERRIDE）需经 other 位读动态目录 → 0755。
      S.userspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-users-wp2a-'));
      S.dynamicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-dynamic-wp2a-'));
      S.staticRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-static-wp2a-'));
      S.artifactsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-artifacts-wp2a-'));
      S.routesFile = path.join(S.dynamicRoot, 'routes.yml');
      S.cookieJar = path.join(S.artifactsRoot, 'preview-cookies.txt');
      S.staticFile = writeTraefikStatic(S.staticRoot, {
        repoRoot: REPO_ROOT, webPort: TRAEFIK_WEB_PORT, websecurePort: TRAEFIK_WEBSECURE_PORT,
      });
      for (const dir of [S.userspaceRoot, S.dynamicRoot, S.staticRoot, S.artifactsRoot]) fs.chmodSync(dir, 0o755);

      // #268 M1：预写 edge watch 桩（坑见 lib/isolated-env.mjs:writeDynamicStub）。必须在任何 compose up 之前。
      const stub = writeDynamicStub(S.dynamicRoot);
      assert.equal(stub.created, true, '刚 mkdtemp 的动态目录里桩必须是「新写」');
      assert.equal(fs.readFileSync(stub.file, 'utf8'), 'http: {}\n', '桩正文必须是合法空配置 http: {}');
      assert.equal(writeDynamicStub(S.dynamicRoot).created, false, '幂等：对自己的桩再调一次不得重写');
    });

    await step('② 起栈（自建 FDE 镜像 + compose up + portal healthz）', async () => {
      stackTouched = true; // 从这里开始本栈可能已有资源，teardown 必须真的去清
      safe(() => compose('down -v'));
      removeDbDir();
      // #268 M2 同款：up 前自建 FDE_IMAGE（共享 tag 绝不删，issue #178，口径见 lib/fde-image.mjs）。
      buildFdeImage(FDE_IMAGE);
      compose('up -d --build', { MIGRATE_ON_START: '1', FDE_IMAGE });
      await waitFor(async () => (await fetch(`${PORTAL}/healthz`).catch(() => null))?.status === 200,
        { label: `portal healthz (${PORTAL})`, timeoutMs: 240000 });
    });

    await step('③ 建用户 + provision-fde（P5：不建项目；POST /api/projects 已 410）', async () => {
      S.totpSecret = await insertUser({ id: S.userId, login: 'alice', role: 'fde', fdeName: FDE_NAME });
      S.cookie = await login('alice', S.totpSecret);

      // P5「目录即项目」的正面取证：项目维度写口一律 410（旧 wp2a 的起点动作已从产品里消失）。
      const retired = await portalApi('/api/projects', {
        method: 'POST', cookie: S.cookie,
        body: { name: 'proj1', repo_url: 'https://git.example/alice/proj1.git', template: 'node' },
      });
      assert.equal(retired.status, 410, 'P5：POST /api/projects 必须 410（目录即项目）');
      assert.equal((await retired.json())?.error?.code, 'project_api_retired', '410 的错误码口径');

      docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js provision-fde --fde-name ${FDE_NAME}`);
      await waitFor(() => (safe(() => docker(`inspect ${FDE_CONTAINER} --format {{.State.Status}}`).trim()) === 'running' ? 'running' : null),
        { label: `${FDE_CONTAINER} running`, timeoutMs: 180000 });

      const netRow = psql(`SELECT network_name, subnet, gateway FROM fde_networks WHERE fde_id='${S.userId}'`);
      const [networkName, subnet, gateway] = netRow.split('|').map((s) => s.trim());
      assert.equal(networkName, `fde-${FDE_NAME}`, `fde_networks 行（命名规则 fde-<fde_name>）：${netRow}`);
      S.networkName = networkName;
      S.subnet = subnet;
      S.gateway = gateway;
      assert.ok(gateway, '网关 .1 存在');
      // 路由 backend 的唯一算法（routes.js readRouteDesiredState）：本 FDE /29 的固定位 .2。
      S.backendIp = intToIp((parseCidr(subnet).base + 2) >>> 0);
      const inspect = JSON.parse(docker(`inspect ${FDE_CONTAINER}`));
      assert.equal(inspect[0].NetworkSettings.Networks[S.networkName].IPAddress, S.backendIp,
        'FDE 容器 IP = 网段固定位 .2（预览路由的 backend 就是它）');
      assert.equal(psql(`SELECT status FROM containers WHERE fde_name='${FDE_NAME}'`), 'running',
        'containers.status 回写 running（DB 是状态真相）');
      assert.ok((inspect[0].Config.Env || []).some((e) => e.startsWith('ERIX_STATION_TOKEN=')),
        'per-container token 已注入（provision 写库 + 下发都到位）');
    });

    await step('④ 宿主 userspace 树：属主/权限合规（钉真机现状；意图缺口见段内注释）', async () => {
      const erixDir = hostPathOf('home', '.erix');
      const portsPath = path.join(erixDir, 'ports.json');
      const manifestPath = path.join(erixDir, 'manifest.json');
      await waitFor(() => (fs.existsSync(portsPath) && fs.existsSync(manifestPath) ? true : null),
        { label: 'FDE 级 ~/.erix/ports.json + manifest.json 落盘', timeoutMs: 120000 });

      const mode = (p) => fs.statSync(p).mode & 0o7777;
      // 工作区目录只取 permission 位：setgid 位单独谈（见下方「意图缺口」），不混进这条断言。
      const perm = (p) => fs.statSync(p).mode & 0o777;
      const octal = (p) => (fs.statSync(p).mode & 0o7777).toString(8);
      const owner = (p) => {
        const st = fs.statSync(p);
        return { uid: st.uid, gid: st.gid };
      };
      // 平台文件/目录的权限口径来自 portal/src/materializer.js（FILE_MODE 0644 / MANIFEST_MODE 0444 /
      // ERIX_DIR_MODE 0750 / 顶层 userspace root 0755），平台文件由 root 的 portal 进程写（root:root）。
      // 以下 0755/0750/0644/0444 四条已在真机逐路径复核（现役 FDE 的树：0755 root:root 顶层、
      // home/.erix=0750 erix:eric、ports.json/config.json/mcp.json=0644 root:root、manifest.json=0444 root:root、
      // ~/AGENTS.md=0644 root:root），不是照抄代码常量。
      assert.equal(mode(S.userspaceRoot), 0o0755, 'userspace 顶层根 0755（user-space §6.2）');

      // —— 工作区目录（<root>/<fde> 与 <root>/<fde>/home）：钉 **0770**，不是代码里的 2770 ——
      // 代码意图是 2770（portal/src/provisioner.js ensureUserSpaceMountDirs 与 materializer.js 的
      // WORKSPACE_DIR_MODE 都传 0o2770 给 fsutil.ensureDirSafe = mkdir → chmod → chown），但真机拿不到
      // setgid 位、稳定停在 0770（工单 F-5 取证：现役 4 个 FDE 的 <fde>/home 全是 0770 erix:eric）。
      // 机制（用 portal 镜像 + compose 里那套 cap 现场复现，不是推测）：
      //   1) ensureDirSafe 的 mkdirSync(dir,{recursive:true,mode:0o2770}) 这一步**永远交不出 setgid**
      //      （探针：umask 022 → 0750；umask 0002 → 0770）——位能不能落下，全看第 2 步的 chmod；
      //   2) fs.chmodSync(dir,0o2770) 只在**目录属主还是本进程**时落得下 setgid，也就是「portal 自己刚
      //      mkdir 出来的那一轮」（真机 /srv/erix/users/portsprobe=2770 正是这一轮的产物）；
      //   3) 第 3 步 chownSync(1000,1000) 把属主交给 erix 之后，portal（uid 0，deploy/docker-compose.yml
      //      的 cap_add=CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID，**缺 CAP_FSETID**）再 chmod 会被内核
      //      **静默清掉 setgid**：permission 位 770 原样保留、chmod 不抛错（所以 fsutil 的 catch 连告警都不会有）。
      //      对照组：同一镜像加 --cap-add FSETID，同一条 chmod 立刻得到 2770。
      //   ⇒ reconcile 从第 2 轮起必然把目录按回 0770（探针逐轮：2770 → 770 → 770 稳态）。
      // 意图缺口不静默：要真 setgid 得产品侧显式落地（候选 portal/src/provisioner.js 对已存在目录补一次
      // 以属主身份做的 chmod，或给 portal 容器补 cap_add: CAP_FSETID）。谁补谁回来把这条断言改严。
      // 这里取 &0o777 ⇒ 产品哪天真的落下 2770，这条也不会反过来误红。
      for (const dir of [hostPathOf(), hostPathOf('home')]) {
        assert.equal(perm(dir), 0o0770, `工作区目录 permission 位 0770（真机现状；setgid 意图缺口见上方注释）：${dir} 实=${octal(dir)}`);
        assert.deepEqual(owner(dir), { uid: 1000, gid: 1000 }, `工作区目录属主 erix(1000:1000)：${dir}`);
      }
      // .erix 由 materializer 的 files 清单带出来（config.json/mcp.json/ports.json 的父目录），
      // 「必须存在」只对**已物化过的 FDE**成立：上面那条 waitFor 就是它的前提；从未物化的用户树上
      // 本来就没有这一层（真机复核：<fde>/home/.erix=0750 erix:eric；少一层 home 的 `<fde>/.erix` 从来不存在，
      // 别拿它当「.erix 没生成」的证据）。0750 没有 setgid 位，也不含会被 umask 抹掉的位，所以与代码常量一致。
      assert.equal(mode(erixDir), 0o0750, '.erix 目录 0750（user-space §6.2）');
      assert.deepEqual(owner(erixDir), { uid: 1000, gid: 1000 }, '.erix 属主 erix(1000:1000)');
      for (const f of ['ports.json', 'config.json', 'mcp.json']) {
        assert.equal(mode(path.join(erixDir, f)), 0o0644, `平台文件 0644：${f}`);
      }
      assert.equal(mode(manifestPath), 0o0444, 'manifest 0444（提交点只读）');
      assert.equal(mode(hostPathOf('home', 'AGENTS.md')), 0o0644, '~/AGENTS.md 0644（#257/#258 平台约束单一真相）');

      // 真机验收取证：把实测权限原样打进日志（0770 vs 代码里的 2770 是这段最容易被反复误改的地方）。
      // 注：新一轮很完整的栈里这两个目录**可能**是 2770（首轮流只属于本进程时 chmod 能落下 setgid），
      // 随后就被回到 0770，所以这里只记录、不拿 setgid 位做断言。
      // eslint-disable-next-line no-console
      console.log('[wp2a] §④ userspace 实测权限:',
        `userspaceRoot=${octal(S.userspaceRoot)}`, `fde=${octal(hostPathOf())}`,
        `home=${octal(hostPathOf('home'))}`, `.erix=${octal(erixDir)}`, `manifest=${octal(manifestPath)}`,
        `工作区目录属主=${owner(hostPathOf()).uid}:${owner(hostPathOf()).gid}`);

      // 前 P5 目录形态必须已经消失（旧 wp2a 断言的对象）。
      assert.ok(!fs.existsSync(hostPathOf('projects', 'proj1', '.erix', 'ports.json')),
        '前 P5 的项目级 projects/proj1/.erix/ports.json 不再生成（端口清单只有 FDE 级一份）');
    });

    await step('⑤ ports.json（宿主=容器同一份）↔ DB port_allocations 逐条对账', async () => {
      const hostPortsPath = hostPathOf('home', '.erix', 'ports.json');
      const hostText = fs.readFileSync(hostPortsPath, 'utf8');
      // bind mount 一致性：容器内 `~/.erix/ports.json` 与宿主读到的必须是同一字节。
      const containerText = docker(`exec ${FDE_CONTAINER} cat /home/erix/.erix/ports.json`);
      assert.equal(containerText, hostText, '容器内 ~/.erix/ports.json 与宿主 bind 源同一份字节（D-6 直写）');

      S.portsJson = JSON.parse(hostText);
      S.allocations = livePortRows();
      const rec = reconcilePortsJsonWithDb({
        portsJson: S.portsJson,
        dbRows: S.allocations,
        fdeName: FDE_NAME,
        baseDomain: BASE_DOMAIN,
        publicBaseUrl: PUBLIC_BASE_URL,
        expectedCount: PREVIEW_PORT_COUNT,
      });
      // 从库 = 对账本体：条数/scope=fde/号池内按 10 对齐的一块/hostname+url 与端口一致/DB↔文件逐条相等。
      // （判据本体在 lib/ports-reconcile.mjs；isolation-negative.mjs 用夹具钉它「不是恒真」。）
      assert.deepEqual(rec.problems, [], `ports.json ↔ port_allocations 对账问题清单:\n${rec.problems.join('\n')}`);
      assert.equal(rec.summary.count, PREVIEW_PORT_COUNT, `清单必须是整块 ${PREVIEW_PORT_COUNT} 条（#246 交付①）`);
      assert.equal(rec.summary.blockStart % PREVIEW_PORT_COUNT, 0, `块起点必须按 ${PREVIEW_PORT_COUNT} 对齐`);
      assert.ok(rec.summary.blockStart >= PREVIEW_PORT_POOL_START && rec.summary.blockStart <= PREVIEW_PORT_POOL_END,
        `块起点必须落在号池 ${PREVIEW_PORT_POOL_START}–${PREVIEW_PORT_POOL_END} 内`);

      // 本段挑两条 host 给后面两段的预览链路用（块内第一条会被消费、第二条保持未用）。
      // allocation UUID 从产品读侧（GET /api/me/ports）取，不自己猜——签票端点要的就是它（#246 交付②）。
      const mine = await listMyPorts();
      const idByPort = new Map(mine.map((i) => [Number(i.port), i.id]));
      S.port = Number(S.allocations[0].port);
      S.hostname = S.allocations[0].hostname;
      S.allocationId = idByPort.get(S.port);
      assert.ok(S.allocationId, `块内第一条端口 ${S.port} 在 /api/me/ports 里找不到 allocation id`);
      S.spareAllocationId = idByPort.get(Number(S.allocations[1].port));
      S.spareHostname = S.allocations[1].hostname;
    });

    await step('⑥ 路由面 + 无票直连 fail-closed（403 preview_ticket_required + #241 deny CORS 头）', async () => {
      await waitFor(() => (readRoutes().includes(S.hostname) ? true : null),
        { label: 'routes.yml 含预览 router（edge watch 已 reload）', timeoutMs: 120000 });
      const routes = readRoutes();
      assert.match(routes, new RegExp(`Host\\(\\\`${S.hostname}\\\`\\)`), '预览 host 的 Host() 规则在');
      assert.ok(routes.includes(`fde-${S.hostname.split('.')[0]}:`), 'router/service 名 = fde-<hostname 首段>');
      assert.ok(routes.includes(`http://${S.backendIp}:${S.port}`), `backend = FDE 固定位 .2:${S.port}（routes.js）`);
      assert.ok(routes.includes(S.subnet) && !routes.includes('/16'), `internal ipAllowList 用精确 ${S.subnet}，禁止 /16 聚合`);
      assert.ok(!routes.includes(LLM_HOST), `routes.yml 不含 LLM 路由（${LLM_HOST}，LLM 段在独立文件且本栈零 binding）`);
      assert.ok(!fs.existsSync(path.join(S.dynamicRoot, 'llm-routes.yml')),
        '零 binding → llm-routes.yml 不存在（fail-closed；本体在 wp6 + portal/test/routes.test.js）');

      // 探针容器：共享 FDE 容器 netns（backend 就是 .2），先直连 backend 端口确认可达，
      // 这样后面 Traefik 的 502 只可能来自平台侧，不会和「没人在监听」混在一起。
      // 工单 F-6 附带的 desk-check（§⑤–⑨ 同类引号隐患）：PROBE_SCRIPT 用**单引号**包在命令里，两层解析
      // 之后那对单引号才是内层 shell 看到的引号 ⇒ 脚本里一旦出现单引号就当场截断命令，sg/JSON.stringify
      // 那一层救不回来（它只处理 `"` 与 `\`）。缺省脚本没有单引号，所以把它钉成前提而不是留着等人踩。
      assert.ok(!PROBE_SCRIPT.includes("'"), "PROBE_SCRIPT 不得含单引号：它在命令里由单引号包裹，出现单引号会截断（双引号/反斜杠会被 JSON.stringify 层正确处理，可以带）");
      docker(`run -d --rm --name ${PROBE_CONTAINER} -e PROBE_PORT=${S.port} --network container:${FDE_CONTAINER} ${PROBE_IMAGE} node -e '${PROBE_SCRIPT}'`);
      await waitFor(async () => (curl({ url: `http://${S.backendIp}:${S.port}/`, out: 'probe-direct' }).status === '200' ? '200' : null),
        { label: `探针在 FDE netns 内应答 ${S.backendIp}:${S.port}`, timeoutMs: 60000 });

      // 无票直连：Traefik 命中预览 router → forwardAuth deny → 原样透给客户端（403 + 信封）。
      const origin = `http://preview-consumer.invalid:${TRAEFIK_WEB_PORT}`;
      const r = await waitFor(async () => {
        const res = curl({
          url: `${TRAEFIK_WEB}/`, host: S.hostname, out: 'no-ticket',
          headers: [`Origin: ${origin}`, 'Access-Control-Request-Method: GET'],
        });
        return res.status === '403' ? res : null;
      }, { label: `无票直连 403 (${S.hostname})`, timeoutMs: 60000 });
      assert.match(r.body, /preview_ticket_required/, '403 信封里必须是 preview_ticket_required');
      // #241：deny 也必须带 CORS 头（回显 Origin + ACAC + Vary），否则浏览器只报 CORS 错、
      // 用户永远看不到「需要预览票据」这个真实原因。
      assert.ok(r.headers.includes(`Access-Control-Allow-Origin: ${origin}`), `deny 响应回显 Origin：${r.headers.split('\n').slice(0, 8).join(' | ')}`);
      assert.ok(r.headers.includes('Access-Control-Allow-Credentials: true'), 'deny 响应带 Access-Control-Allow-Credentials');
      assert.ok(/(^|\n)\s*Vary:\s*Origin/i.test(r.headers), 'deny 响应带 Vary: Origin（缓存不得复用）');
    });

    await step('⑦ 签票链路：/api/me/ports → preview-ticket → 302 换 cookie → 探针 200（allocated→active）', async () => {
      const mine = await listMyPorts();
      assert.equal(mine.length, PREVIEW_PORT_COUNT, `GET /api/me/ports 必须列出整块 ${PREVIEW_PORT_COUNT} 条（#246 交付②）`);
      assert.ok(mine.every((i) => /^[0-9a-f-]{36}$/i.test(i.id)), '每条都带 allocation UUID（签票端点要的就是它）');
      assert.ok(mine.every((i) => i.scope === 'fde' && i.state !== 'released'), '只列活行、scope=fde');
      assert.equal(mine.find((i) => i.hostname === S.hostname).port, S.port);

      const issued = await portalApi(`/api/ports/${S.allocationId}/preview-ticket`, { method: 'POST', cookie: S.cookie, body: {} });
      const ticket = await issued.json().catch(() => ({}));
      assert.equal(issued.status, 201, `签发预览票据：${JSON.stringify(ticket)}`);
      assert.match(ticket.ticket, /^pt_/, 'ticket 形态 pt_<base64url>');
      assert.ok(Number.isInteger(ticket.expires_in) && ticket.expires_in > 0, `expires_in 是正整数（缺省 60s ⇒ 签完立刻兑换）：${ticket.expires_in}`);
      assert.equal(ticket.url, `http://${S.hostname}:${TRAEFIK_WEB_PORT}/?preview_ticket=${ticket.ticket}`,
        '签票返回的 url = 该 host 的公开入口（scheme/端口从 PORTAL_PUBLIC_BASE_URL 派生，#57 阶段2）');

      const boot = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/?preview_ticket=${ticket.ticket}`, host: S.hostname, args: `-c ${JSON.stringify(S.cookieJar)}`, out: 'bootstrap' });
        return res.status === '302' ? res : null;
      }, { label: `带票据兑换 302 (${S.hostname})`, timeoutMs: 60000 });
      // Location 用原始 Host（含非默认端口时才带；这里 Host 头不带端口 ⇒ 与 hostname 一致）+ 票据已剥掉（B3）。
      const location = /^location:\s*(\S+)/im.exec(boot.headers)?.[1] ?? '';
      assert.equal(location, `http://${S.hostname}/`, '302 Location 指向同一 host 且已剔除 ?preview_ticket');
      assert.ok(!location.includes('preview_ticket'), '票据不进 Location（不进书签）');
      assert.match(boot.headers, /^set-cookie:\s*\S*fde_preview\S*=/im, 'Set-Cookie 种下预览 cookie（dev-http profile 名 fde_preview_dev / prod 为 __Host-fde_preview）');
      assert.match(boot.headers, /set-cookie:[^\n]*HttpOnly/i, '预览 cookie 是 HttpOnly');

      const ok200 = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/`, host: S.hostname, args: `-b ${JSON.stringify(S.cookieJar)}`, out: 'with-cookie' });
        return res.status === '200' ? res : null;
      }, { label: `带预览 cookie 命中探针 200 (${S.hostname})`, timeoutMs: 60000 });
      const echoed = JSON.parse(ok200.body);
      assert.equal(echoed.headers.host, S.hostname, '探针回显 Host = 该预览 host（确实代理到本 FDE 的 .2:<port>）');
      assert.equal(echoed.headers['x-auth-user'], FDE_NAME,
        'X-Auth-User 由 forwardAuth 放行后透传（authResponseHeaders）——证明走的是放行分支而不是绕过边缘');
      assert.equal(echoed.headers.cookie ?? '', '',
        '边缘把请求侧 Cookie 整头剥掉（#262/#263 by design：strip-cookie 中间件），应用看不到平台票据 cookie');

      // §8.6：首次凭证放行 ⇒ allocated→active 幂等升级。
      await waitFor(() => (psql(`SELECT state FROM port_allocations WHERE hostname='${S.hostname}'`) === 'active' ? 'active' : null),
        { label: 'allocated→active（首次 forward-auth 放行）', timeoutMs: 30000 });
    });

    await step('⑧ 去置备收敛（deprovision-fde）：容器/网络消失、路由撤、直连 404、端口此刻**不**释放', async () => {
      // 先签一张**未使用**的票（第⑨段要用它验 offboarding 的撤权）。
      const spareIssued = await portalApi(`/api/ports/${S.spareAllocationId}/preview-ticket`, { method: 'POST', cookie: S.cookie, body: {} });
      const spareBody = await spareIssued.json().catch(() => ({}));
      assert.equal(spareIssued.status, 201, `预签备用票据：${JSON.stringify(spareBody)}`);
      S.spareTicket = spareBody.ticket;

      // 拆探针：`--network container:` 的 netns 依赖会挡住 FDE 容器删除 → 必须先 rm。
      teardownProbe();

      docker(`exec ${STATION_PORTAL_NAME} node portal/src/cli.js deprovision-fde --fde-name ${FDE_NAME}`);
      await waitFor(() => (safe(() => docker(`inspect ${FDE_CONTAINER}`)) === null ? 'gone' : null),
        { label: `${FDE_CONTAINER} 容器已删除`, timeoutMs: 120000 });
      await waitFor(() => (networkNamesPresent(FDE_CONTAINER).length === 0 ? 'gone' : null),
        { label: `${FDE_CONTAINER} 网络已删除`, timeoutMs: 120000 });
      assert.equal(psql(`SELECT state FROM fde_networks WHERE fde_id='${S.userId}'`), 'released', 'fde_networks 释放');
      assert.equal(psql(`SELECT status FROM containers WHERE fde_name='${FDE_NAME}'`), 'removed', 'containers.status 收敛 removed');

      // **代码现状**（与工单口径的差异，头注已写）：deprovisionFde 只吊销 token + 释放网段 + 撤 LLM，
      // `port_allocations` 的 released 属 offboarding 的 release-network-routes 一步。这里把它钉住，
      // 免得有人「顺手」在 deprovision 里释放端口却没人发现口径变了。
      assert.equal(countPorts("<> 'released'"), PREVIEW_PORT_COUNT,
        '去置备后端口仍活（released 归 offboarding，见 portal/src/offboarding.js releaseNetworkRoutes）');

      await waitFor(() => (!readRoutes().includes(S.hostname) && !readRoutes().includes(`${FDE_NAME}-p-`) ? 'converged' : null),
        { label: 'routes.yml 撤掉本 FDE 全部预览 host', timeoutMs: 120000 });
      // `wp2a-conv-404` 是断言锚点 token：isolation-negative.mjs 拿它钉「去置备收敛的 404 断言仍在」
      //（删掉下面两条 404 断言 ⇒ 单一来源断言立刻红，不需要真机 docker）。
      const after = await waitFor(async () => {
        const res = curl({ url: `${TRAEFIK_WEB}/`, host: S.hostname, out: 'after-deprovision' });
        return res.status === '404' ? res : null;
      }, { label: `去置备后对该 host 直连 404（wp2a-conv-404：路由撤了 = 边缘无 router）`, timeoutMs: 60000 });
      assert.equal(after.status, '404', 'wp2a-conv-404 去置备后对该 host 直连必须 404');

      // 路由撤了 ⇒ 连 forward-auth 都到不了：未使用的票据在边缘侧同样不可兑换（404，而不是 302）。
      const viaEdge = curl({ url: `${TRAEFIK_WEB}/?preview_ticket=${S.spareTicket}`, host: S.spareHostname, out: 'spare-after-deprovision' });
      assert.equal(viaEdge.status, '404', 'wp2a-conv-404 未使用的票据经边缘同样 404（router 已撤）');
      // 但 portal 侧的授权判定仍认这张票（allocation 未 released、grant 未撤）——这正是「去置备 ≠
      // 端口回收」的可观测差别；第⑨段 offboarding 后同一请求会变成 403。
      const viaAuth = curl({
        url: `${PORTAL}/api/forward-auth`, out: 'spare-auth-deprovision',
        headers: [`X-Forwarded-Host: ${S.spareHostname}`, `X-Forwarded-Uri: /?preview_ticket=${S.spareTicket}`,
          'X-Forwarded-Method: GET', 'X-Forwarded-Proto: http'],
      });
      assert.equal(viaAuth.status, '302', `去置备后直连 portal forward-auth 兑换未用票据仍 302（实际 ${viaAuth.status}）`);
    });

    await step('⑨ offboarding 收敛：port_allocations released + active 票据撤销 + forward-auth 403', async () => {
      const adminSecret = await insertUser({ id: '00000000-0000-0000-0000-000000000002', login: 'wp2a-admin', role: 'admin' });
      const adminCookie = await login('wp2a-admin', adminSecret);
      const del = await portalApi(`/api/admin/users/${S.userId}`, { method: 'DELETE', cookie: adminCookie });
      const delBody = await del.json().catch(() => ({}));
      assert.equal(del.status, 202, `DELETE 有资源的用户 ⇒ 202 + offboarding 工作流：${JSON.stringify(delBody)}`);
      assert.ok(['pending', 'running'].includes(delBody.offboarding?.state), `offboarding 已入队：${JSON.stringify(delBody)}`);

      // portal 进程内的 offboarding 循环（间隔 5s）跑完 8 步。
      await waitFor(() => (psql(`SELECT state FROM fde_offboarding WHERE fde_id='${S.userId}'`) === 'done' ? 'done' : null),
        { label: 'fde_offboarding.state = done', timeoutMs: 180000 });

      assert.equal(countPorts("<> 'released'"), 0, 'release-network-routes：本 FDE 零活行');
      assert.equal(countPorts("= 'released'"), PREVIEW_PORT_COUNT, `整块 ${PREVIEW_PORT_COUNT} 条全部 released`);
      assert.equal(
        psql(`SELECT count(*) FROM port_allocations WHERE fde_id='${S.userId}' AND state='released' AND released_at IS NULL`),
        '0', 'released 行必须带 released_at（审计事实）');
      assert.equal(
        // 同样必须单行（工单 F-6 全文 grep 出来的第二处；§⑨ 在真机上从未执行到，所以它比 §⑤ 晚爆）。
        psql(`SELECT count(*) FROM preview_grants g JOIN port_allocations a ON a.id=g.allocation_id WHERE a.fde_id='${S.userId}' AND g.state='active'`),
        '0', 'active 预览凭证全部撤销（含第⑧段那张未用的票；used 行是历史事实，不撤销 = #252 口径）');

      // 「已签未用票据失效」的确定性证法：绕开 Traefik 直接问 portal（allocation 已 released ⇒
      // authorizeForwardAuth 第②步就 deny，与 releaseNetworkRoutes 的撤权形成双保险）。
      const afterOffboarding = curl({
        url: `${PORTAL}/api/forward-auth`, out: 'spare-auth-offboarded',
        headers: [`X-Forwarded-Host: ${S.spareHostname}`, `X-Forwarded-Uri: /?preview_ticket=${S.spareTicket}`,
          'X-Forwarded-Method: GET', 'X-Forwarded-Proto: http'],
      });
      assert.equal(afterOffboarding.status, '403', `offboarding 后同一张未用票据 ⇒ 403（实际 ${afterOffboarding.status}）`);
      assert.match(afterOffboarding.body, /allocation_released|preview_ticket_revoked/,
        'deny 码必须是 allocation_released / preview_ticket_revoked 之一');
      assert.ok(!readRoutes().includes(`${FDE_NAME}-p-`), '路由不再回来');

      // eslint-disable-next-line no-console
      console.log(`\n[wp2a] OK: fde=${FDE_NAME} block=${S.allocations[0].port}-${S.allocations.at(-1).port} subnet=${S.subnet} backend=${S.backendIp} 签票 302→cookie 200 → deprovision(404/端口仍活) → offboarding(released+撤票)`);
    });
  });

async function listMyPorts() {
  const res = await portalApi('/api/me/ports', { cookie: S.cookie });
  assert.equal(res.status, 200, 'GET /api/me/ports');
  const body = await res.json();
  assert.ok(Array.isArray(body.items), `items 是数组：${JSON.stringify(body).slice(0, 120)}`);
  return body.items;
}

/** 拆探针容器（不在 teardown 里算失败：段内清理，真删不掉时套件级 teardown 还会兜一次）。 */
function teardownProbe() {
  try {
    if (dockerOutSafe('ps -a --format {{.Names}}').includes(PROBE_CONTAINER)) docker(`rm -f ${PROBE_CONTAINER}`);
  } catch {
    /* 套件级 teardown 负责兜底与记账 */
  }
}

function dockerOutSafe(args) {
  return docker(args).split('\n').map((l) => l.trim()).filter(Boolean);
}
