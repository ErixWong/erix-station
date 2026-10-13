// 隔离 e2e 的公共护栏（issue #226：把 wp5-e2e.mjs:35 的实现提到公共模块，wp2a/wp3a/wp5/wp6 共用一份）。
// 唯一职责：把「这条 e2e 会不会动到共享 dev 栈」变成**硬失败**断言——外部句柄（栈名/容器名/端口/
// DB 数据目录/入口 URL）必须由 env 显式派生，且每一个都不像共享栈的既定值。
//
// 判据口径（#215 立、#226 复核）：宁可拒绝起跑，也不能默默对共享栈动手——
// 缺省 STATION_DB_DIR = `/docker/station-db`，正是共享 dev 栈 station-db 的 bind 源（#226 取证：
// `docker inspect station-db` → `/docker/station-db -> /var/lib/postgresql/data`），
// 一旦按缺省跑 teardown，就是 `rm -rf` 真机 dev 库的数据目录。
//
// ⚠️ 本文件是 assertIsolatedEnvironment / resolveDbDir / writeTraefikStatic 的**唯一定义处**；
// 新增 e2e 一律 import，禁止再复制第二份（`node portal/integration/isolation-negative.mjs`
// 里的单一来源断言会把它钉住）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（本文件位于 portal/integration/lib/）。 */
export const REPO_ROOT = path.resolve(LIB_DIR, '..', '..', '..');
export const TRAEFIK_DEFAULT_STATIC = path.join(REPO_ROOT, 'deploy/traefik/traefik.yml');

/** 共享 dev 栈的既定句柄（e2e 未派生就会命中的那些值，#226 取证行号即指向它们）。 */
export const SHARED_STACK = {
  dbDir: '/docker/station-db',
  composeProjectName: 'station',
  stackId: 'default',
  dbContainer: 'station-db',
  portalContainer: 'station-portal',
  dockerProxyContainer: 'station-docker-proxy',
  edgeContainer: 'station-edge',
  litellmContainer: 'station-litellm',
  portalHostPort: '18080',
  litellmHostPort: '4100',
  traefikWebPort: '8090',
  traefikWebSecurePort: '8443',
  backendSubnet: '172.32.0.0/24',
  // #227.3：共享栈在用的 FDE IPAM 段（portal 缺省池；隔离栈的池不得等于它）。
  fdeIpamPool: '10.200.0.0/16',
  // 宿主回环上占用的端口（含 LiteLLM 容器内 4000/4001 的惯例值）。
  forbiddenPorts: ['4000', '4001', '4100', '8090', '8443', '18080'],
};

/**
 * portal 侧 IPAM「large 池」钉死的分配段（`portal/src/ipam.js:14`，**非 env 可配**，且 portal/src/**
 * 在护栏脚本的改动范围外）。fde-proxy 对 `network create` 的 subnet 做白名单校验
 * （deploy/fde-proxy/server.js:343-350/400），因此隔离栈的 FDE_IPAM_POOLS **必须包含这段**，
 * 否则 provision 建 fde-* 网络会被 proxy 拒（`IPAM.Subnet not in allowed pools`）——#227.3 落地时
 * 发现的口径冲突，详见交付报告「遗留问题」。
 */
export const PORTAL_LARGE_POOL = '10.201.0.0/16';

/**
 * 由栈 id 确定性派生本隔离栈专用的 FDE IPAM 段（#227.3：两套隔离栈并行时不共用同一段）。
 *
 * 规则：取栈 id 里全部数字拼接后 mod 99 ⇒ 段 = `10.(201 + n%99).0.0/16`（族 10.201–10.299，
 * **天然排除共享段 10.200.0.0/16**）；无数字则用 FNV-1a 短哈希。按段号可判定：段号 ≡ 数字 mod 99，
 * 不同余数必不同段；同 id 永远同段（幂等）。派生值相同≠一定撞（仅当两栈真的并行分配同一子网段才撞，
 * 那时用显式覆盖 FDE_IPAM_POOLS 拆开，护栏允许族内显式覆盖）。
 *
 * @param {string} stackId STATION_STACK_ID
 * @returns {string} 形如 `10.229.0.0/16` 的单段 CIDR
 */
export function deriveFdeIpamPools(stackId) {
  const id = String(stackId ?? '');
  const digits = id.replace(/\D+/g, '');
  let n;
  if (digits) {
    // BigInt 防长数字精度丢失；前导零不影响十进制解析。
    n = Number(BigInt(digits) % 99n);
  } else {
    let h = 2166136261; // FNV-1a 32bit
    for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
    n = Math.abs(h) % 99;
  }
  return `10.${201 + n}.0.0/16`;
}

/**
 * 脚本默认注入的 FDE_IPAM_POOLS（未显式传时）：派生段 + portal large 池固定段（去重，逗号分隔）。
 * 包含 PORTAL_LARGE_POOL 的原因见其定义处注释（proxy 白名单必须覆盖 portal 实际分配的段）。
 *
 * @param {string} stackId STATION_STACK_ID
 * @returns {string}
 */
export function defaultFdeIpamPools(stackId) {
  return [...new Set([deriveFdeIpamPools(stackId), PORTAL_LARGE_POOL])].join(',');
}

/**
 * `STATION_DB_DIR` 解析（issue #226 修法第 4 条：缺省即抛，不再回退 `/docker/station-db`）。
 *
 * 两条硬失败分支（同修于每一支用到 teardown 的 e2e）：
 *  1. 未设置 ⇒ 抛错，并点名「缺省会 rm -rf 共享 dev 库数据目录」；
 *  2. 设了但不在 OS 临时目录内 ⇒ 也抛（`ERIX_E2E_ALLOW_DB_DIR=1` 是显式豁免，用于真机有意复用某路径）。
 *
 * `allowSharedReset`（#227.1，**只允许 wp2b 用**）：调用方**显式声明「我就是要重置共享 dev 库」**——
 * 未设置时不抛、直接解析为共享栈的 `/docker/station-db`；解析结果恰等于该路径时豁免临时目录检查，
 * 其余路径照旧严格（不把豁免面扩大成「任意非临时路径」）。确认这个重置语义前不要复制到别的脚本
 * （`isolation-negative.mjs` 的单一来源断言把出现处钉在 lib + wp2b）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {{ allowSharedReset?: boolean }} [options]
 * @returns {string} 去掉尾斜杠后的 DB 数据目录（绝对路径）
 */
export function resolveDbDir(env = process.env, { allowSharedReset = false } = {}) {
  const raw = env.STATION_DB_DIR;
  if (!raw) {
    if (allowSharedReset) return SHARED_STACK.dbDir;
    throw new Error(
      `STATION_DB_DIR must be set for isolated e2e：缺省值 ${SHARED_STACK.dbDir} 是共享 dev 栈 station-db 的 `
      + 'bind 源，teardown 的 rm -rf 会直接清掉共享 dev 库的数据目录（issue #226）。'
      + '请显式传 STATION_DB_DIR=<临时目录>/station-db-<栈 id>。',
    );
  }
  const dbDir = String(raw).replace(/\/+$/, '');
  const relative = path.relative(os.tmpdir(), path.resolve(dbDir));
  const insideTempDir = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  const waived = env.ERIX_E2E_ALLOW_DB_DIR === '1' || (allowSharedReset && dbDir === SHARED_STACK.dbDir);
  if (!insideTempDir && !waived) {
    throw new Error(
      `STATION_DB_DIR=${dbDir} 不在临时目录（os.tmpdir()=${os.tmpdir()}）内：`
      + `非临时路径（例如共享栈的 ${SHARED_STACK.dbDir}）被 rm -rf 会带走真实数据。`
      + '确认该路径可以被删就显式设 ERIX_E2E_ALLOW_DB_DIR=1。',
    );
  }
  return dbDir;
}

/**
 * 删除 DB 数据目录：先解析路径（缺省/越界 ⇒ 抛，见 resolveDbDir），再经临时 root 容器删
 *（postgres 会把目录 chown 到 999，宿主用户删不动）。docker 调用失败**不**抛（teardown 语义），
 * 但 env 缺省错误一定抛（且在调用 docker **之前**抛——不会先把 rm -rf 发出去）。
 *
 * @param {(args: string) => unknown} docker 该脚本的 docker 执行器
 * @param {Record<string, string | undefined>} [env]
 * @param {{ allowSharedReset?: boolean }} [options] 见 resolveDbDir（只允许 wp2b 声明）
 */
export function removeDbDir(docker, env = process.env, options = {}) {
  assert.ok(typeof docker === 'function', 'removeDbDir: docker executor is required');
  const dbDir = resolveDbDir(env, options);
  const parent = path.posix.dirname(dbDir);
  const name = path.posix.basename(dbDir);
  try {
    docker(`run --rm -v ${JSON.stringify(parent)}:/host alpine rm -rf ${JSON.stringify(`/host/${name}`)}`);
  } catch {
    return null;
  }
  return undefined;
}

/**
 * 生成该脚本专用的 `removeDbDir()` 闭包（各 e2e 的 docker 执行器是本地函数，这样调用点保持零参数）。
 *
 * @param {{ docker: (args: string) => unknown, env?: Record<string, string | undefined>, allowSharedReset?: boolean }} opts
 *   allowSharedReset 只允许 wp2b（共享栈重置）传，见 resolveDbDir 与单一来源断言。
 * @returns {{ removeDbDir: () => void, dbDir: () => string }}
 */
export function createDbDirCleaner({ docker, env = process.env, allowSharedReset = false }) {
  assert.ok(typeof docker === 'function', 'createDbDirCleaner: docker executor is required');
  const options = { allowSharedReset };
  return {
    dbDir: () => resolveDbDir(env, options),
    removeDbDir: () => removeDbDir(docker, env, options),
  };
}

/**
 * 硬隔离护栏。判据与 #215/#224 定稿的 wp5/wp6 版本逐条一致（在此放宽 = 退回假绿）。
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env] 默认 process.env
 * @param {boolean} [options.litellm=true] 该栈是否含 LiteLLM（wp2a 不带 litellm profile ⇒ false）
 * @param {{ env: string, value: string, sharedDefault?: string }[]} [options.fdeNames]
 *   该脚本使用的 FDE 名：env 名 + 实际取值 + 共享栈既定名（默认 alice）。必须含唯一栈 id，
 *   否则 `fde-<name>` 容器/网络会与共享栈同名互删。
 * @param {string[]} [options.extraRequiredEnv] 脚本专属必需 env
 * @param {[string, string][]} [options.extraForbiddenEnv] 脚本专属「不得等于共享栈值」对
 */
export function assertIsolatedEnvironment(options = {}) {
  const {
    env = process.env,
    litellm = true,
    fdeNames = [],
    extraRequiredEnv = [],
    extraForbiddenEnv = [],
  } = options;

  const containerNames = ['STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME', 'STATION_EDGE_NAME'];
  const portEnvs = ['PORTAL_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT'];
  if (litellm) {
    containerNames.push('STATION_LITELLM_NAME');
    portEnvs.unshift('LITELLM_HOST_PORT');
  }

  const required = [
    'STATION_DB_DIR', 'COMPOSE_PROJECT_NAME', 'STATION_STACK_ID',
    'STATION_DB_NAME', 'STATION_PORTAL_NAME', 'STATION_DOCKER_PROXY_NAME', 'STATION_EDGE_NAME',
    'PORTAL_HOST_PORT', 'TRAEFIK_WEB_PORT', 'TRAEFIK_WEBSECURE_PORT',
    'STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE',
    'BACKEND_SUBNET', 'FDE_POOL', 'FDE_IPAM_POOLS',
    ...(litellm ? ['STATION_LITELLM_NAME', 'LITELLM_HOST_PORT'] : []),
    ...fdeNames.map((fde) => fde.env),
    ...extraRequiredEnv,
  ];
  for (const name of required) assert.ok(env[name], `${name} must be set for isolated e2e`);

  const dbRelativePath = path.relative(os.tmpdir(), path.resolve(env.STATION_DB_DIR));
  assert.ok(dbRelativePath && !dbRelativePath.startsWith('..') && !path.isAbsolute(dbRelativePath),
    'STATION_DB_DIR must be inside the OS temporary directory');
  assert.ok(!fs.existsSync(env.STATION_DB_DIR), 'STATION_DB_DIR must be a fresh, nonexistent directory');

  const forbidden = [
    ['COMPOSE_PROJECT_NAME', SHARED_STACK.composeProjectName],
    ['STATION_STACK_ID', SHARED_STACK.stackId],
    ['STATION_DB_NAME', SHARED_STACK.dbContainer],
    ['STATION_PORTAL_NAME', SHARED_STACK.portalContainer],
    ['STATION_DOCKER_PROXY_NAME', SHARED_STACK.dockerProxyContainer],
    ['STATION_EDGE_NAME', SHARED_STACK.edgeContainer],
    ['PORTAL_HOST_PORT', SHARED_STACK.portalHostPort],
    ['TRAEFIK_WEB_PORT', SHARED_STACK.traefikWebPort],
    ['TRAEFIK_WEBSECURE_PORT', SHARED_STACK.traefikWebSecurePort],
    ['BACKEND_SUBNET', SHARED_STACK.backendSubnet],
    ...(litellm ? [['STATION_LITELLM_NAME', SHARED_STACK.litellmContainer], ['LITELLM_HOST_PORT', SHARED_STACK.litellmHostPort]] : []),
    ...fdeNames.map((fde) => [fde.env, fde.sharedDefault ?? 'alice']),
    ...extraForbiddenEnv,
  ];
  for (const [name, sharedValue] of forbidden) {
    assert.notEqual(env[name], sharedValue, `${name} must not target the shared stack`);
  }

  assert.equal(env.FDE_POOL, 'large', 'isolated e2e must use the dedicated large FDE pool');
  // #227.3：从「等值 10.201.0.0/16」改为按栈派生。fail-closed 口径：每一段都必须在隔离族
  // 10.201.0.0/16–10.299.0.0/16 内；共享段 10.200.0.0/16（portal 缺省池/共享栈 FDE 网络所在地）一律拒。
  // 正规值 = deriveFdeIpamPools(STATION_STACK_ID)；显式覆盖（仍在族内）同样放行——并行撞段时的逃生口。
  const fdeIpamPools = String(env.FDE_IPAM_POOLS).split(',').map((pool) => pool.trim()).filter(Boolean);
  assert.ok(fdeIpamPools.length > 0, `FDE_IPAM_POOLS=${env.FDE_IPAM_POOLS} 不含任何有效 CIDR`);
  for (const pool of fdeIpamPools) {
    assert.notEqual(pool, SHARED_STACK.fdeIpamPool,
      `FDE_IPAM_POOLS 含共享栈在用的段 ${pool}（portal 缺省池/共享栈 fde-* 网络在此，并行必撞）；本栈应用派生段 deriveFdeIpamPools(STATION_STACK_ID)=${deriveFdeIpamPools(env.STATION_STACK_ID)}`);
    assert.match(pool, /^10\.2(?:0[1-9]|[1-9][0-9])\.0\.0\/16$/,
      `FDE_IPAM_POOLS=${pool} 必须留在隔离族 10.201.0.0/16–10.299.0.0/16 内（正规值=派生段 ${deriveFdeIpamPools(env.STATION_STACK_ID)}）`);
  }
  assert.equal(env.COMPOSE_PROJECT_NAME, env.STATION_STACK_ID,
    'compose project and stack label must use the same unique ID');
  for (const name of containerNames) {
    assert.ok(env[name].endsWith(`-${env.STATION_STACK_ID}`), `${name} must include the unique stack ID`);
  }
  for (const name of ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE']) {
    // #227.1：digest 钉定的 FDE 镜像不适用唯一 tag 要求（内容寻址，天然不撞共享 tag）。
    if (name === 'FDE_IMAGE' && env[name].includes('@sha256:')) continue;
    assert.ok(env[name].endsWith(`:${env.STATION_STACK_ID}`), `${name} must use a unique image tag`);
  }
  // #227.1（主 agent 真跑 #226 踩的坑）：`image:tag` 形态的 FDE 镜像必须显式 FDE_DEV_MODE=1——
  // portal 在非 dev 模式只接受 digest 形态（portal/src/config.js:83-86/122），没显式声明 provision 直接拒；
  // digest（@sha256:）形态是生产铉定，不要求。
  if (!String(env.FDE_IMAGE).includes('@sha256:')) {
    assert.equal(env.FDE_DEV_MODE, '1',
      'FDE_DEV_MODE must be 1 when FDE_IMAGE is image:tag（tag 形态不显式声明 dev 模式会被 portal 生产门拒跑；digest 形态豁免）');
  }
  for (const fde of fdeNames) {
    assert.match(fde.value, /^[a-z0-9][a-z0-9-]{0,62}$/, `${fde.env} must be a safe FDE name`);
    assert.ok(fde.value.includes(env.STATION_STACK_ID), `${fde.env} must include the unique stack ID`);
  }
  assert.equal(new Set(fdeNames.map((fde) => fde.value)).size, fdeNames.length,
    'isolated FDE names must be distinct');

  const ports = portEnvs.map((name) => env[name]);
  assert.equal(new Set(ports).size, ports.length, 'isolated e2e ports must be distinct');
  for (const port of ports) {
    assert.match(port, /^\d{2,5}$/);
    assert.ok(Number(port) <= 65535);
    assert.ok(!SHARED_STACK.forbiddenPorts.includes(port),
      `isolated e2e must not use a shared-stack port (${port})`);
  }
  if (litellm) {
    assert.equal(env.LLM_GATEWAY_HOST, `http://127.0.0.1:${env.LITELLM_HOST_PORT}`,
      'LLM_GATEWAY_HOST must target the isolated LiteLLM publish port');
  }
}

/**
 * 宿主回环端口可用性预探（#224 带来，#226 一并提到公共模块，wp2a/wp3a/wp5/wp6 共用一份）：
 * 撞共享栈入口端口时 compose 只会报 EADDRINUSE 或——更坑——curl 打到**共享 edge** 上假绿。
 *
 * @param {string[]} ports 待验证的宿主端口
 * @param {{ host?: string }} [options]
 */
export async function assertHostPortsAvailable(ports, { host = '127.0.0.1' } = {}) {
  for (const port of ports) {
    const server = net.createServer();
    // eslint-disable-next-line no-await-in-loop -- 串行探测才能给出第一个被占的端口名
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), host, () => server.close(resolve));
    }).catch((error) => {
      throw new Error(`isolated e2e port ${port} is unavailable: ${error.message}`);
    });
  }
}

/**
 * 生成「只改入口端口」的临时 Traefik 静态配置并返回其宿主路径（F8：`--configFile` 在场时
 * CLI 覆盖不生效，必须整体替换静态文件，否则隔离栈的 edge 仍会去抢共享栈的 8090/8443）。
 *
 * @param {string} dir 目标目录（调用方的临时目录）
 * @param {{ repoRoot?: string, webPort: string, websecurePort: string }} opts
 * @returns {string} 生成的 traefik.yml 路径
 */
export function writeTraefikStatic(dir, { repoRoot = REPO_ROOT, webPort, websecurePort }) {
  assert.ok(webPort, 'writeTraefikStatic: webPort is required');
  assert.ok(websecurePort, 'writeTraefikStatic: websecurePort is required');
  const source = fs.readFileSync(path.join(repoRoot, 'deploy/traefik/traefik.yml'), 'utf8');
  assert.ok(source.includes('address: ":8090"') && source.includes('address: ":8443"'),
    'Traefik static config has the expected entrypoint addresses');
  const output = source
    .replace('address: ":8090"', `address: ":${webPort}"`)
    .replace('address: ":8443"', `address: ":${websecurePort}"`);
  const target = path.join(dir, 'traefik.yml');
  fs.writeFileSync(target, output);
  return target;
}

/**
 * compose up **之前**在 Traefik 动态目录预写 `routes.yml` 桩（issue #268 决策 4：edge watch 存量坑修法）。
 *
 * 为什么必须预写：Traefik v3 file provider 在**启动时刻**对目录内已存在的文件建立 watch；
 * 启动时动态目录里没有 `routes.yml`，watch 就落在那个「尚不存在的 inode」上，之后 materializer
 * 的原子替换（tmp 写 → rename，见 portal/src/routes.js 头部注释）产生的是**新 inode**，
 * inotify 永远不会把这次替换报给 watch → 整栈健康、DB 有路由、但 internal/预览全 404，
 * `docker restart <edge>` 立刻通（e2e262 实测复现，AGENTS §8.18「edge file-provider watch 坑」）。
 * 预写一份 `http: {}` 空桩让启动即有文件可 watch，之后 materializer 的替换就能被 reload 捕获。
 *
 * ⚠️ 幂等红线：`routes.yml` **已存在则一字不动**——桩绝不能覆盖 materializer 的产物（把真实路由
 * 压回 `http: {}` 就等于亲手制造 404）。「存在不覆盖」由 `isolation-negative.mjs` 的桩语义断言钉住
 * （改成无条件覆盖即红）。
 *
 * @param {string} dynamicDir 该脚本的 Traefik 动态临时目录（mkdtemp 之后、任何 compose up 之前调用）
 * @returns {{ file: string, created: boolean }} 桩路径 + 是否新写（存在而未动 ⇒ created=false）
 */
export function writeDynamicStub(dynamicDir) {
  assert.ok(dynamicDir, 'writeDynamicStub: dynamicDir is required');
  const target = path.join(dynamicDir, 'routes.yml');
  if (fs.existsSync(target)) return { file: target, created: false };
  fs.writeFileSync(target, 'http: {}\n');
  return { file: target, created: true };
}
