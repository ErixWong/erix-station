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
  // 共享栈在宿主回环上占用的端口（含 LiteLLM 容器内 4000/4001 的惯例值）。
  forbiddenPorts: ['4000', '4001', '4100', '8090', '8443', '18080'],
};

/**
 * `STATION_DB_DIR` 解析（issue #226 修法第 4 条：缺省即抛，不再回退 `/docker/station-db`）。
 *
 * 两条硬失败分支（同修于每一支用到 teardown 的 e2e）：
 *  1. 未设置 ⇒ 抛错，并点名「缺省会 rm -rf 共享 dev 库数据目录」；
 *  2. 设了但不在 OS 临时目录内 ⇒ 也抛（`ERIX_E2E_ALLOW_DB_DIR=1` 是显式豁免，用于真机有意复用某路径）。
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string} 去掉尾斜杠后的 DB 数据目录（绝对路径）
 */
export function resolveDbDir(env = process.env) {
  const raw = env.STATION_DB_DIR;
  if (!raw) {
    throw new Error(
      `STATION_DB_DIR must be set for isolated e2e：缺省值 ${SHARED_STACK.dbDir} 是共享 dev 栈 station-db 的 `
      + 'bind 源，teardown 的 rm -rf 会直接清掉共享 dev 库的数据目录（issue #226）。'
      + '请显式传 STATION_DB_DIR=<临时目录>/station-db-<栈 id>。',
    );
  }
  const dbDir = String(raw).replace(/\/+$/, '');
  const relative = path.relative(os.tmpdir(), path.resolve(dbDir));
  const insideTempDir = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!insideTempDir && env.ERIX_E2E_ALLOW_DB_DIR !== '1') {
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
 */
export function removeDbDir(docker, env = process.env) {
  assert.ok(typeof docker === 'function', 'removeDbDir: docker executor is required');
  const dbDir = resolveDbDir(env);
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
 * @param {{ docker: (args: string) => unknown, env?: Record<string, string | undefined> }} opts
 * @returns {{ removeDbDir: () => void, dbDir: () => string }}
 */
export function createDbDirCleaner({ docker, env = process.env }) {
  assert.ok(typeof docker === 'function', 'createDbDirCleaner: docker executor is required');
  return {
    dbDir: () => resolveDbDir(env),
    removeDbDir: () => removeDbDir(docker, env),
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
  const fdeIpamPools = String(env.FDE_IPAM_POOLS).split(',').map((pool) => pool.trim()).filter(Boolean);
  assert.deepEqual(fdeIpamPools, ['10.201.0.0/16'], 'proxy IPAM pool must match the isolated FDE pool');
  assert.equal(env.COMPOSE_PROJECT_NAME, env.STATION_STACK_ID,
    'compose project and stack label must use the same unique ID');
  for (const name of containerNames) {
    assert.ok(env[name].endsWith(`-${env.STATION_STACK_ID}`), `${name} must include the unique stack ID`);
  }
  for (const name of ['STATION_PORTAL_IMAGE', 'STATION_DOCKER_PROXY_IMAGE', 'FDE_IMAGE']) {
    assert.ok(env[name].endsWith(`:${env.STATION_STACK_ID}`), `${name} must use a unique image tag`);
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
