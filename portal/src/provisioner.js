// FDE 容器 provisioning：经自研 admission proxy 调 Docker API（DOCKER_HOST），创建/启动/停止/删除 FDE 容器。
// 依据：docs/design/deploy-contract.md §5（B6 创建字段 allowlist / socket-proxy 白名单）/§6（容器创建契约）、
//       docs/design/topology.md §3（每 FDE 一条 /29）、docs/design/user-space.md §2/§6（bind mount / UID / 权限）、
//       docs/data/schema.sql §2/§9（containers / fde_networks）。
//
// 三条不变式落地：
//   1. FDE 容器不 publish 端口（HostConfig.PortBindings 恒空）；
//   2. portal 不挂 docker.sock（只经 DOCKER_HOST=tcp://station-docker-proxy:2375 访问自研 admission proxy）；
//   3. DB 是状态真相（容器状态回写 containers；启动/定时对账 DB↔Docker）。
//
// 代码层 Docker API 白名单（DOCKER_ALLOWED_PATHS）：只允许下列路径，多余路径一律拒绝（B6 落地）。

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ensureDirSafe } from './fsutil.js';
import { parseCidr, intToIp, allocateNetwork } from './ipam.js';
import { hashToken } from './auth.js';
import { enqueueRouteChange } from './outbox.js';
import { provisionFdePreviewPorts } from './portalloc.js';
import { allocSeq } from './seq.js';
import { broadcastRevoke, drainQueueAfterRun } from './internal.js';
import { revokeFdeLlmConfigTx, syncFdeLlmBindingOnOnboard } from './llm.js';
import { removeGitCredentialFile, setGitCredential } from './git-credential.js';
import { mintGitAccount } from './git-mint.js';

// ---------------------------------------------------------------------------
// 代码层 Docker API 白名单（写死）
// ---------------------------------------------------------------------------
const NAME_RE = '[a-zA-Z0-9_.-]+';

export const DOCKER_ALLOWED_PATHS = [
  { method: 'GET', re: /^\/_ping$/ },
  { method: 'GET', re: /^\/version$/ },
  { method: 'GET', re: /^\/containers\/json$/ },
  { method: 'POST', re: /^\/containers\/create$/ },
  { method: 'GET', re: new RegExp(`^/containers/${NAME_RE}/json$`) },
  { method: 'POST', re: new RegExp(`^/containers/${NAME_RE}/start$`) },
  { method: 'POST', re: new RegExp(`^/containers/${NAME_RE}/stop$`) },
  { method: 'DELETE', re: new RegExp(`^/containers/${NAME_RE}$`) },
  { method: 'GET', re: /^\/networks$/ },
  { method: 'POST', re: /^\/networks\/create$/ },
  { method: 'GET', re: new RegExp(`^/networks/${NAME_RE}$`) },
  { method: 'DELETE', re: new RegExp(`^/networks/${NAME_RE}$`) },
];

/** 断言 method+path 在代码层白名单内；越界一律抛错（绝不透传到 socket-proxy）。 */
export function assertAllowedDockerPath(method, path) {
  const p = String(path).split('?')[0];
  for (const rule of DOCKER_ALLOWED_PATHS) {
    if (rule.method === method && rule.re.test(p)) return true;
  }
  const err = new Error(`docker API path not in code-level allowlist: ${method} ${path}`);
  err.code = 'docker_path_denied';
  throw err;
}

/** DOCKER_HOST（tcp://host:port）→ http base URL（portal 只经 socket-proxy，不接受 unix socket）。 */
export function dockerBaseUrl(dockerHost) {
  if (!dockerHost) throw new Error('DOCKER_HOST is required');
  if (dockerHost.startsWith('tcp://')) return `http://${dockerHost.slice('tcp://'.length)}`;
  if (dockerHost.startsWith('http://') || dockerHost.startsWith('https://')) return dockerHost;
  const err = new Error(`unsupported DOCKER_HOST (must be tcp:// via socket-proxy): ${dockerHost}`);
  err.code = 'docker_host_unsupported';
  throw err;
}

async function defaultRequest(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: res.status, data };
}

/** Docker 客户端（每次 call 前强制过代码层白名单）。 */
export function createDockerClient({ dockerHost, request = defaultRequest } = {}) {
  const baseUrl = dockerBaseUrl(dockerHost).replace(/\/+$/, '');
  async function call(method, path, body) {
    assertAllowedDockerPath(method, path);
    return request(baseUrl, method, path, body);
  }
  return {
    baseUrl,
    call,
    ping: () => call('GET', '/_ping'),
    listContainers: (filters) =>
      call('GET', filters ? `/containers/json?filters=${encodeURIComponent(JSON.stringify(filters))}` : '/containers/json'),
    createContainer: (body, name) =>
      call('POST', name ? `/containers/create?name=${encodeURIComponent(name)}` : '/containers/create', body),
    inspectContainer: (idOrName) => call('GET', `/containers/${idOrName}/json`),
    startContainer: (idOrName) => call('POST', `/containers/${idOrName}/start`),
    stopContainer: (idOrName) => call('POST', `/containers/${idOrName}/stop`),
    removeContainer: (idOrName) => call('DELETE', `/containers/${idOrName}`),
    listNetworks: (filters) =>
      call('GET', filters ? `/networks?filters=${encodeURIComponent(JSON.stringify(filters))}` : '/networks'),
    inspectNetwork: (idOrName) => call('GET', `/networks/${idOrName}`),
    createNetwork: (body) => call('POST', '/networks/create', body),
    removeNetwork: (idOrName) => call('DELETE', `/networks/${idOrName}`),
  };
}

// ---------------------------------------------------------------------------
// 纯函数：容器 / 网络创建 body（契约 §6.1/§6.2/§6.4）
// ---------------------------------------------------------------------------

/** 内存限额字符串（如 '512m' / '1g' / '0'）→ 字节数（0 = 不限）。 */
export function parseMemoryLimit(value) {
  if (value == null || value === '' || value === '0') return 0;
  if (typeof value === 'number') return Math.max(0, Math.floor(value));
  const m = String(value).trim().toLowerCase().match(/^(\d+)([kmg])?$/);
  if (!m) return 0;
  const n = Number(m[1]);
  const mult = { k: 1024, m: 1024 * 1024, g: 1024 * 1024 * 1024 }[m[2]] ?? 1;
  return Math.floor(n * mult);
}

/** 断言 bind source realpath 仍在 userSpaceRoot 内（防 symlink 逃逸；不存在则交给 docker 报错）。 */
function assertBindSourceInsideRoot(userSpaceRoot, bindSource) {
  let resolved;
  try {
    resolved = fs.realpathSync(bindSource);
  } catch {
    return; // 目录尚未物化：ensureUserSpaceMountDirs 之后才创建；交给 docker 报错。
  }
  const root = path.resolve(userSpaceRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    const err = new Error(`bind source escapes user space (symlink?): ${bindSource} -> ${resolved}`);
    err.code = 'bind_source_escaped';
    throw err;
  }
}

/**
 * FDE 容器的 Docker API create body（契约 §6.2/§6.4）。
 * 不变式：不 publish 端口（无 PortBindings）、不挂 docker.sock、bind mount 只允许本 FDE 用户空间。
 * @param user 容器内用户（erix）；user 兜底（--user）单独给。
 */
export function buildContainerConfig({
  fdeName,
  containerName,
  image,
  cmd,
  networkName,
  ip,
  gateway,
  baseDomain,
  llmHost,
  portalPublicBaseUrl,
  userSpaceRoot,
  homeUser = 'erix',
  env = [],
  labels = {},
  stackId = 'default', // F9：栈所有权标签（orphan 清扫按 station.stack 过滤；缺省 default）
  memoryLimit = '4g', // issue #27 已决 2026-09-18（B 档镜像下 dotnet build/chromium 峰值；0 不限）
  runUser = null, // '1001:1000' 等；镜像不具备双 UID 用户时用 --user 兜底（FDE_DEV_USER，⚠️ dev 偏差）
  capAdd = ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL'], // 契约 §6.2：root 启动→drop 1001、fork 1002 所需最小集（含跨 UID kill 的 CAP_KILL）
}) {
  const home = `/home/${homeUser}`;
  const hostRoot = path.join(path.resolve(userSpaceRoot), fdeName);
  const binds = [
    `${hostRoot}/home:${home}`,
    `${hostRoot}/projects:${home}/projects`,
    `${hostRoot}/cache:${home}/cache`,
  ];
  // P3 纵深防御：bind source realpath 后必须仍在 userSpaceRoot 内（防 symlink 逃逸）。
  for (const b of binds) assertBindSourceInsideRoot(userSpaceRoot, b.split(':')[0]);
  const body = {
    Image: image,
    Cmd: cmd,
    Env: [
      ...(env ?? []),
      // F4：容器内 agentd 依赖的 internal API base URL（契约 §6.2）。dev http + 高端口 / prod https + 443。
      `ERIX_STATION_BASE_URL=${String(portalPublicBaseUrl || `https://station.${baseDomain}`).replace(/\/+$/, '')}/api/internal`,
      // issue #84 P5：agentd/worker 可调参数下发（portal env → FDE 容器 env；改值重建容器即可，无需镜像）。
      `ERIX_MAX_ROUNDS=${Number(process.env.ERIX_MAX_ROUNDS) || 16}`,
      `ERIX_AGENTD_CAPACITY=${Number(process.env.ERIX_AGENTD_CAPACITY) || 2}`,
      `ERIX_ARTIFACT_MAX_BYTES=${Number(process.env.ERIX_ARTIFACT_MAX_BYTES) || (100 * 1024 * 1024)}`,
      `ERIX_ARTIFACT_CAPTURE_BUDGET_MS=${Number(process.env.ERIX_ARTIFACT_CAPTURE_BUDGET_MS) || 60000}`,
      `ERIX_SHELL_TIMEOUT_MS=${Number(process.env.ERIX_SHELL_TIMEOUT_MS) || 60000}`,
      `ERIX_SHELL_MAX_TIMEOUT_MS=${Number(process.env.ERIX_SHELL_MAX_TIMEOUT_MS) || 600000}`,
      `ERIX_SHELL_OUTPUT_MAX_BYTES=${Number(process.env.ERIX_SHELL_OUTPUT_MAX_BYTES) || 32768}`,
      // issue #88 / #114：会话标题生成在 worker 侧（worker 读 '0' 关；缺省/其它值开）。
      // #114 起**默认关**（默认标题 = 首条消息截断 / 手工改名 / AI 改名），显式设 1 才开回；
      // 与 portal 侧 config.sessionAutoTitle 同口径。字符串开关（非数值），只透传 '0'/'1'。
      `ERIX_SESSION_AUTO_TITLE=${process.env.ERIX_SESSION_AUTO_TITLE === '1' ? '1' : '0'}`,
    ],
    Labels: { 'station.managed': 'true', 'fde.name': fdeName, 'station.stack': stackId, ...labels },
    HostConfig: {
      Binds: binds,
      NetworkMode: networkName,
      RestartPolicy: { Name: 'unless-stopped' },
      SecurityOpt: ['no-new-privileges'],
      CapDrop: ['ALL'],
      CapAdd: capAdd,
      Init: true,
      Memory: parseMemoryLimit(memoryLimit),
      // 契约 §6.2：容器内 station.<base> / llm.<base> 解析到本 FDE bridge 网关（Traefik host 网络入口）。
      ExtraHosts: [`station.${baseDomain}:${gateway}`, `${llmHost}:${gateway}`],
      // 不变式一：不 publish 端口 —— 不携带 PortBindings 字段（proxy P1 字段级 allowlist 拒绝任何 PortBindings）。
    },
    // R2：不再携带 NetworkingConfig（--ip）——proxy 第三轮加固已直接拒绝该字段；
    // 单容器/单网络下默认 IPAM 顺序分配即固定位 .2（topology §3）。
  };
  if (runUser) body.User = runUser;
  return body;
}

/** FDE 网络的 Docker API create body（契约 §6.1：显式 subnet + gateway）。 */
export function buildNetworkConfig({ name, subnet, gateway, fdeName, stackId = 'default' }) {
  return {
    Name: name,
    Driver: 'bridge',
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet, Gateway: gateway }] },
    Labels: { 'station.managed': 'true', 'fde.name': fdeName, 'station.stack': stackId },
  };
}

/** 确保 FDE 用户空间 bind mount 宿主目录存在（mode 传 2770、落盘 0770 + uid/gid，user-space §2.4/§6.2）。
 *  setgid 位不会落盘也不承载行为（口径 0770，issue #273）——别补 CAP_FSETID，详见 fsutil.ensureDirSafe 注释。
 *  D8 修订：worktrees 挂载已拆除（#81 P2.5，cwd 直达项目目录）。 */
export function ensureUserSpaceMountDirs({ userSpaceRoot, fdeName, uid, gid, log = console }) {
  const root = path.resolve(userSpaceRoot);
  const fdeRoot = path.join(root, fdeName);
  for (const sub of ['home', 'projects', 'cache']) {
    ensureDirSafe(root, path.join(fdeRoot, sub), { mode: 0o2770, uid, gid, log });
  }
  return fdeRoot;
}

// ---------------------------------------------------------------------------
// Docker 编排（按 name 幂等；404 = 不存在）
// ---------------------------------------------------------------------------

/** 校验 inspect 返回的网络满足契约（managed + fde.name + subnet + gateway）。不满足抛错。 */
function assertNetworkContract(data, { name, subnet, gateway, fdeName }) {
  const labels = data?.Labels ?? {};
  const ipam = data?.IPAM?.Config?.[0] ?? {};
  const managedOk = labels['station.managed'] === 'true';
  const fdeNameOk = labels['fde.name'] === fdeName;
  const subnetOk = ipam.Subnet === subnet;
  const gatewayOk = ipam.Gateway === gateway;
  if (!managedOk || !fdeNameOk || !subnetOk || !gatewayOk) {
    throw new Error(
      `network ${name} exists but mismatches contract (managed=${labels['station.managed']}, fde.name=${labels['fde.name']}, subnet=${ipam.Subnet}, gateway=${ipam.Gateway}); expected managed=true, fde.name=${fdeName}, ${subnet}, ${gateway}`,
    );
  }
}

/** 确保 docker 网络存在（不存在则按契约创建）。返回 { created, id }。 */
export async function ensureFdeNetwork(docker, { name, subnet, gateway, fdeName, stackId = 'default', log = console }) {
  const existing = await docker.inspectNetwork(name);
  if (existing.status === 200) {
    // F11：inspect 200 后必须校验 managed label + fde.name + subnet/gateway 与 DB 一致；不一致 → 报错（不静默采用）。
    assertNetworkContract(existing.data ?? {}, { name, subnet, gateway, fdeName });
    return { created: false, id: existing.data?.Id ?? null };
  }
  if (existing.status !== 404) {
    throw new Error(`inspect network ${name} failed: HTTP ${existing.status}`);
  }
  const res = await docker.createNetwork(buildNetworkConfig({ name, subnet, gateway, fdeName, stackId }));
  if (res.status === 409) {
    // 并发下另一 reconcile/onboard 已创建 → 必须 re-inspect 并做同样契约校验（F11/P4）。
    const now = await docker.inspectNetwork(name);
    if (now.status !== 200) {
      throw new Error(`re-inspect network ${name} after 409 failed: HTTP ${now.status}`);
    }
    assertNetworkContract(now.data ?? {}, { name, subnet, gateway, fdeName });
    return { created: false, id: now.data?.Id ?? null };
  }
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`create network ${name} failed: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  log.log?.(`[provisioner] network created: ${name} (${subnet})`);
  return { created: true, id: res.data?.Id ?? null };
}

/** 生成 per-container token（原文只注入容器 env，DB 只存哈希，issue #12）。 */
export function generateRunnerToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

/** 从 Docker inspect 返回的 Config.Env 中读取 ERIX_STATION_TOKEN 原文（用于对账校验 hash 一致）。 */
export function readContainerEnv(inspectData, key = 'ERIX_STATION_TOKEN') {
  const env = inspectData?.Config?.Env ?? [];
  const prefix = `${key}=`;
  const line = env.find((e) => typeof e === 'string' && e.startsWith(prefix));
  return line ? line.slice(prefix.length) : null;
}

/**
 * 确保 FDE 容器存在并 running（不存在则创建+启动）。
 * @param opts.runnerToken 可选：单点生成的 token 原文；不传则内部新生成。
 * 返回 { created, started, id, token, envToken }（envToken = 容器内实际 ERIX_STATION_TOKEN 原文，供对账校验）。
 */
export async function ensureFdeContainer(docker, opts, { log = console } = {}) {
  const { containerName } = opts;
  const existing = await docker.inspectContainer(containerName);
  if (existing.status === 200) {
    const status = existing.data?.State?.Status;
    let started = false;
    if (status !== 'running') {
      const r = await docker.startContainer(containerName);
      // issue #404：**409 是 Docker 在说「它已经在跑了」**——这正是本函数要的终态，不是故障。
      // 原先只认 204/304，于是并发（reconcile 与 provision-fde 同时动同一个名字）时赢的那一方
      // 会拿到 409 并抛错，reconcile 因此每轮抱怨一条 `start container … failed: HTTP 409`，
      // 把真故障淹在噪音里。started 保持 false：我们确实没有把它"启动起来"，它本来就在跑。
      if (r.status !== 204 && r.status !== 304 && r.status !== 409) {
        throw new Error(`start container ${containerName} failed: HTTP ${r.status}`);
      }
      started = r.status !== 409;
    }
    // issue #404：adopt 路径必须把容器**实际**在跑的镜像引用带出去，供调用方把账写对
    //（写"期望值"是另一种说谎：容器可能是上一个版本遗留的）。
    return {
      created: false,
      started,
      id: existing.data?.Id ?? null,
      token: null,
      envToken: readContainerEnv(existing.data),
      image: existing.data?.Config?.Image ?? existing.data?.Image ?? null,
    };
  }
  if (existing.status !== 404) {
    throw new Error(`inspect container ${containerName} failed: HTTP ${existing.status}`);
  }

  // F6：单点生成——onboard 传入的 token 与 DB hash 同源；未传入则此处生成（reconcile 重建路径）。
  const token = opts.runnerToken ?? generateRunnerToken().token;
  const body = buildContainerConfig({
    ...opts,
    env: [...(opts.env ?? []), `ERIX_STATION_TOKEN=${token}`, `ERIX_FDE_NAME=${opts.fdeName}`],
  });
  const created = await docker.createContainer(body, containerName);
  if (created.status === 409) {
    // 并发下另一 reconcile/onboard 已创建同名容器 → 视为已存在，回退到 ensure running。
    const now = await docker.inspectContainer(containerName);
    if (now.status === 200) {
      const status = now.data?.State?.Status;
      if (status !== 'running') await docker.startContainer(containerName);
      return { created: false, started: status !== 'running', id: now.data?.Id ?? null, token: null, envToken: readContainerEnv(now.data) };
    }
  }
  if (created.status !== 201) {
    throw new Error(`create container ${containerName} failed: HTTP ${created.status} ${JSON.stringify(created.data)}`);
  }
  const id = created.data?.Id;
  const started = await docker.startContainer(id ?? containerName);
  if (started.status !== 204 && started.status !== 304) {
    throw new Error(`start container ${containerName} failed: HTTP ${started.status}`);
  }
  log.log?.(`[provisioner] container created: ${containerName} (${id})`);
  // issue #404：新建路径的"实际镜像"就是我们传进去的那个引用（body.Image），照样带出去——
  // 让调用方只有一条写法：拿 res.image 写账，不必自己区分 created/adopt。
  return { created: true, started: true, id, token, envToken: token, image: body?.Image ?? opts.image ?? null };
}

/** 停止并删除 FDE 容器（404 视为已删）。返回 { ok, stopped, removed }（F9：删除失败时 ok=false，供调用方保留 desired state）。 */
export async function removeFdeContainer(docker, containerName, { log = console } = {}) {
  const stop = await docker.stopContainer(containerName).catch((e) => ({ status: 500, error: e }));
  if (stop.status !== 204 && stop.status !== 304 && stop.status !== 404) {
    log.warn?.(`[provisioner] stop ${containerName} returned ${stop.status}`);
  }
  const rm = await docker.removeContainer(containerName).catch((e) => ({ status: 500, error: e }));
  if (rm.status !== 204 && rm.status !== 404) {
    log.warn?.(`[provisioner] rm ${containerName} returned ${rm.status}`);
  }
  return {
    ok: rm.status === 204 || rm.status === 404,
    stopped: stop.status === 204 || stop.status === 304 || stop.status === 404,
    removed: rm.status === 204 || rm.status === 404,
  };
}

/** 删除 FDE 网络（404 视为已删；不删仍被容器占用的网络）。返回 { ok, removed }。 */
export async function removeFdeNetwork(docker, networkName, { log = console } = {}) {
  const rm = await docker.removeNetwork(networkName).catch((e) => ({ status: 500, error: e }));
  if (rm.status !== 204 && rm.status !== 404) {
    log.warn?.(`[provisioner] rm network ${networkName} returned ${rm.status}`);
  }
  return { ok: rm.status === 204 || rm.status === 404, removed: rm.status === 204 || rm.status === 404 };
}

// ---------------------------------------------------------------------------
// DB 是状态真相：对账 / onboarding / offboarding
// ---------------------------------------------------------------------------

/** 该 FDE 应「有容器」的 desired state（fde_networks allocated/active + user 活 + fde_name）。
 *  issue #185：`awaiting_credential` 也是「活」状态（工位/容器/工作区都在，只是 Git 凭据待补），
 *  必须留在期望集内——否则删/换凭据把状态翻成 `awaiting_credential` 时，reconcileOnce 会把既有容器
 *  判为 orphan 删除重建（正在跑的 run 被杀）。口径与 materializer（#183）、llm.js:650、下方 onboard 一致。
 *  **`disabled` 仍必须排除**：offboarding 后不该再保容器（容器应被当孤儿清掉）。 */
export async function readFdeDesired(pool) {
  const r = await pool.query(
    `SELECT u.id AS user_id, u.fde_name,
            n.subnet, n.gateway, n.network_name,
            c.id AS container_id, c.container_name, c.status AS container_status, c.runner_token_hash
       FROM users u
       JOIN fde_networks n ON n.fde_id = u.id AND n.state IN ('allocated', 'active')
       LEFT JOIN containers c ON c.user_id = u.id
      WHERE u.status IN ('active', 'awaiting_credential') AND u.fde_name IS NOT NULL
      ORDER BY n.subnet`,
  );
  return r.rows;
}

/** 该 FDE 的主容器 IP = gateway+1（.2，topology §3）。 */
export function fdeContainerIp(subnet) {
  const parsed = parseCidr(subnet);
  return intToIp((parsed.base + 2) >>> 0);
}

/** per-fde advisory lock：串行化同一 FDE 的 Docker 变更（provision/reconcile/deprovision），F7/F10。
 *  单测 fake pool 无 connect 时跳过（进程内互斥仍靠 ON CONFLICT / 409）。 */
async function withFdeLock(pool, fdeName, fn, { requireLock = false } = {}) {
  let client;
  try {
    client = await pool.connect();
  } catch {
    // requireLock（评审 major）：孤儿网络清理的安全性依赖本锁——连接失败时**跳过**比无锁执行安全
    // （无锁执行会与 onboard/deprovision 并发，TOCTOU 防护失效）。默认保持旧 fallback 语义。
    if (requireLock) throw new Error(`fde lock ${fdeName}: pool connect failed (requireLock)`);
    return fn();
  }
  const key = `fde:${fdeName}`;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => {});
    client.release();
  }
}

/** Hold the same per-FDE lock used by provisioning while an offboarding workflow runs. */
export async function withFdeProvisioningLock(pool, fdeName, fn) {
  return withFdeLock(pool, fdeName, fn, { requireLock: true });
}

/** 同步 upsert containers 行（F7/F8：ON CONFLICT 幂等 + 含 token hash），消除 DB/容器分裂。 */
async function upsertContainerRow(pool, { userId, fdeName, containerName, tokenHash, image, agentVersion }) {
  await pool.query(
    `INSERT INTO containers (user_id, fde_name, container_name, runner_token_hash, token_generation, status, image, agent_version)
     VALUES ($1, $2, $3, $4, 1, 'creating', $5, $6)
     ON CONFLICT (fde_name) DO UPDATE SET
       container_name = EXCLUDED.container_name,
       runner_token_hash = EXCLUDED.runner_token_hash,
       token_generation = containers.token_generation + 1,
       status = 'creating',
       revoked_at = NULL,  -- issue #22 F1：deprovision→重新 provision 的同一行必须清吊销标记，否则新 agentd 永久 401 DOA
       image = EXCLUDED.image,
       agent_version = EXCLUDED.agent_version,
       rotated_at = now(),
       updated_at = now()`,
    [userId, fdeName, containerName, tokenHash, image, agentVersion],
  );
}

/**
 * 对账一轮：① DB 说该有而 Docker 没有 → 重建；② Docker 多出孤儿容器 → 按策略删除 + 告警。
 * 容器状态回写 DB（running/stopped/removed）。返回统计供测试/观测。
 */
export async function reconcileOnce(pool, config, { docker, log = console } = {}) {
  // F9：本栈所有权 id——孤儿清扫只清 station.stack === stackId 的资源（无标签视为 default）。
  const stackId = config.stackId ?? 'default';
  const desired = await readFdeDesired(pool);
  const stats = { ensured: 0, rebuilt: 0, orphansRemoved: 0, orphanNetworksRemoved: 0, statusUpdates: 0 };

  for (const row of desired) {
    const fdeName = row.fde_name;
    const containerName = `fde-${fdeName}`;
    const networkName = row.network_name;
    const subnet = row.subnet;
    const gateway = row.gateway;
    const ip = fdeContainerIp(subnet);

    try {
      await withFdeLock(pool, fdeName, async () => {
        // F10：锁内重新确认仍是 desired（deprovision 可能已 release，旧快照不再重建）。
        const still = await pool.query(
          `SELECT 1 FROM fde_networks WHERE fde_id = $1 AND state IN ('allocated','active')`,
          [row.user_id],
        );
        if (still.rows.length === 0) return;

        ensureUserSpaceMountDirs({
          userSpaceRoot: config.userSpaceRoot,
          fdeName,
          uid: config.fdeUid ?? 1000,
          gid: config.fdeGid ?? 1000,
          log,
        });
        await ensureFdeNetwork(docker, { name: networkName, subnet, gateway, fdeName, stackId, log });

        const opts = {
          fdeName,
          containerName,
          image: config.fdeImage,
          cmd: config.fdeCmd,
          networkName,
          ip,
          gateway,
          baseDomain: config.baseDomain,
          llmHost: config.llmHost,
          portalPublicBaseUrl: config.portalPublicBaseUrl,
          userSpaceRoot: config.userSpaceRootHost, // F3：bind source 用宿主路径（与容器内 userSpaceRoot 解耦）
          memoryLimit: config.fdeMemoryLimit,
          runUser: config.fdeDevUser ?? null, // F5：生产留空（镜像 entrypoint 降权）；dev 用 FDE_DEV_USER 兜底
          stackId, // F9：创建即打 station.stack 所有权标签
        };

        let res = await ensureFdeContainer(docker, opts, { log });

        // F6：容器 env token 与 DB hash 必须一致；缺失/失配 → 重建。
        const dbHash = row.runner_token_hash;
        if (!res.created && (res.envToken == null || !dbHash || hashToken(res.envToken) !== dbHash)) {
          await removeFdeContainer(docker, containerName, { log });
          res = await ensureFdeContainer(docker, opts, { log });
        }

        if (res.created) {
          // F8：对账创建容器时同步 upsert containers 行（含 token hash），消除 DB/容器分裂。
          await upsertContainerRow(pool, {
            userId: row.user_id,
            fdeName,
            containerName,
            tokenHash: hashToken(res.token),
            image: config.fdeImage,
            agentVersion: config.fdeAgentVersion ?? 'dev',
          });
          stats.rebuilt += 1;
        } else {
          // issue #404：adopt（容器已存在、本轮没创建）同样要让账跟上**实际**镜像。
          await pool.query(
            `UPDATE containers SET image = COALESCE($2, image), updated_at = now()
              WHERE user_id = $1 AND status <> 'removed'`,
            [row.user_id, res.image ?? null],
          );
          if (res.started) {
            await pool.query(
              `UPDATE containers SET status = 'running', updated_at = now()
                WHERE user_id = $1 AND status <> 'removed'`,
              [row.user_id],
            );
            stats.statusUpdates += 1;
          }
        }
        // 兑底：确保 status 收敛到 running。
        await pool.query(
          `UPDATE containers SET status = 'running', updated_at = now()
            WHERE user_id = $1 AND status IN ('creating','stopped','exited')`,
          [row.user_id],
        );
        stats.ensured += 1;
      });
    } catch (err) {
      log.warn?.(`[provisioner] reconcile fde=${fdeName} failed: ${err.message}`);
    }
  }

  // 审计 #36-3：孤儿判定改用**重新读取**的 desired 快照（此前用循环开始前的快照）——缩小
  // 「窗口内 onboard 的新容器被误删」与「deprovision 残留容器多等一轮」的抖动窗口。仍非严格锁内，
  // 属最终一致（残余记 #36）。
  const orphanDesired = await readFdeDesired(pool);
  const freshContainerNames = new Set(orphanDesired.map((r) => `fde-${r.fde_name}`));
  const freshNetworkNames = new Set(orphanDesired.map((r) => r.network_name));

  // 孤儿容器：带 station.managed 标签、但不在 desired 容器集合 → 删除 + 告警。
  const listed = await docker.listContainers({ label: ['station.managed=true'] }).catch(() => ({ status: 200, data: [] }));
  for (const c of listed.data ?? []) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name.startsWith('fde-')) continue;
    if (freshContainerNames.has(name)) continue;
    // F9：只清本栈孤儿——station.stack 缺失视为 default（既有资产兼容）；异栈标签一律跳过。
    if (((c.Labels ?? {})['station.stack'] ?? 'default') !== stackId) continue;
    log.warn?.(`[provisioner] orphan container detected: ${name} (removing)`);
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES (NULL, 'container.orphan_removed', $1, $2)`,
      [name, JSON.stringify({ reason: 'docker has managed container not present in DB desired state' })],
    ).catch(() => {});
    const rm = await removeFdeContainer(docker, name, { log }).catch(() => ({ ok: false }));
    if (rm.ok) {
      stats.orphansRemoved += 1;
      // F-B（审计 #34）：自愈收尾——容器已删，把对应 DB 行收敛为 removed（否则 status 停在 running，
      // 「DB 是状态真相」在失败路径上不成立）。deprovision 删除失败后的残留容器走的正是这条路
      // （前置事务已吊销 token 并释放网段 → 该 FDE 已不在 desired → 下一轮即被此处清理）。
      await pool.query(
        `UPDATE containers c SET status = 'removed', updated_at = now()
           FROM users u
          WHERE c.user_id = u.id AND u.fde_name = $1 AND c.status <> 'removed'`,
        [name.replace(/^fde-/, '')],
      ).catch(() => {});
    }
  }

  // 孤儿网络（审计 #36-1）：带 station.managed 标签、不在 desired 的 fde-* 网络 → 删除。
  // 背景：deprovision 的前置事务先释放网段（该 FDE 离开 desired），若删网络失败则残留——容器有孤儿
  // 分支自愈，**网络此前没有任何清理路径**；残留网络会让同 FDE re-onboard 时 allocateNetwork 分配
  // 新 subnet，而残留网络的旧 subnet 触发 assertNetworkContract 失配 → re-onboard 被阻断（需人工删）。
  // 安全性：只删不在 desired 的网络；仍被容器使用的网络 docker 会拒绝删除（记 warn，不重试风暴）。
  const nets = await docker.listNetworks({ label: ['station.managed=true'] })
    .catch(() => ({ status: 200, data: [] }));
  for (const n of nets.data ?? []) {
    const name = n?.Name;
    if (!name || !name.startsWith('fde-')) continue;
    if ((n?.Labels ?? {})['station.managed'] !== 'true') continue;
    // F9：只清本栈孤儿网络——station.stack 缺失视为 default；异栈标签一律跳过。
    if (((n?.Labels ?? {})['station.stack'] ?? 'default') !== stackId) continue;
    if (freshNetworkNames.has(name)) continue;
    // 审计 #37 评审（TOCTOU）：快照可能过期——onboardFde 持 FDE 锁期间创建的网络不能凭旧快照判死。
    // 与 deprovision/onboard 同锁串行化，并**锁内重读** desired 二次确认后才删。
    const fdeName = name.replace(/^fde-/, '');
    try {
      await withFdeLock(pool, fdeName, async () => {
        const still = await pool.query(
          `SELECT 1 FROM fde_networks n
            JOIN users u ON u.id = n.fde_id
           WHERE u.fde_name = $1 AND n.state IN ('allocated', 'active')`,
          [fdeName],
        );
        // （requireLock：连接失败时上方抛错 → 外层 catch 跳过该网络，本轮不清理）
        if (still.rows.length > 0) return; // 锁内确认：已是 desired → 不删
        log.warn?.(`[provisioner] orphan network detected: ${name} (removing)`);
        await pool.query(
          `INSERT INTO audit_log (actor_id, action, target, details)
           VALUES (NULL, 'network.orphan_removed', $1, $2)`,
          [name, JSON.stringify({ reason: 'managed network not present in DB desired state' })],
        ).catch(() => {});
        const rm = await removeFdeNetwork(docker, name, { log });
        if (rm.ok) stats.orphanNetworksRemoved += 1;
      }, { requireLock: true });
    } catch (err) {
      log.warn?.(`[provisioner] orphan network ${name} cleanup failed: ${err.message}`);
    }
  }

  return stats;
}

/** onboarding：分配子网（IPAM）→ 可选配置 Git host → 建网络 + 容器。幂等。 */
export async function onboardFde(pool, config, {
  fdeName, gitHostId = null, previousTokenRef = null, docker, log = console,
} = {}) {
  return withFdeLock(pool, fdeName, async () => {
    const stackId = config.stackId ?? 'default'; // F9：本栈所有权 id
    const user = await pool.query(
      `SELECT id, fde_name, login, status FROM users
        WHERE fde_name = $1 AND status IN ('active', 'awaiting_credential')`,
      [fdeName],
    );
    const u = user.rows[0];
    if (!u) throw new Error(`no active user with fde_name=${fdeName}`);
    const userId = u.id;

    let gitHost = null;
    let gitAccount = null;
    if (gitHostId) {
      const hostResult = await pool.query(
        `SELECT id, provider, base_url, admin_key, mode, enabled FROM git_hosts WHERE id = $1`,
        [gitHostId],
      );
      gitHost = hostResult.rows[0] ?? null;
      if (!gitHost) throw new Error('git host does not exist');
      if (!gitHost.enabled) throw new Error('git host is disabled');
      gitAccount = (await pool.query(
        `SELECT git_host_id, remote_login, token_ref FROM fde_git_accounts WHERE fde_id = $1`,
        [userId],
      )).rows[0] ?? null;
      if (gitAccount && gitAccount.git_host_id !== gitHost.id) {
        throw new Error('FDE is already assigned to another git host');
      }
    }

    const net = await allocateNetwork(pool, userId, fdeName, {
      poolName: config.fdePool ?? 'default',
      reservedSubnets: config.reservedSubnets ?? [],
      log,
    });

    const containerName = `fde-${fdeName}`;
    // F6：单点 token——检查既有 DB 行与既有容器 env token 是否一致，一致则复用（幂等，不轮换）。
    const dbRow = (await pool.query(`SELECT id, runner_token_hash, revoked_at FROM containers WHERE user_id = $1`, [userId])).rows[0];
    const existing = await docker.inspectContainer(containerName);
    const envToken = existing.status === 200 ? readContainerEnv(existing.data) : null;

    let token;
    let tokenHash;
    let containerId;
    let needRecreate;
    if (dbRow && existing.status === 200 && envToken && hashToken(envToken) === dbRow.runner_token_hash && dbRow.revoked_at == null) {
      // 复用条件含 revoked_at IS NULL（issue #22 评审硬化）：被吊销的行即使容器/env token 侥幸
      // 一致也不得复用——authenticateContainer 对 revoked_at!=null 一律 401，复用即 DOA。
      token = envToken;
      tokenHash = dbRow.runner_token_hash;
      containerId = dbRow.id;
      needRecreate = false;
      // issue #404（病根本体）：`image` 此前**只在「DB 没有行」那条 INSERT 上写一次**，此后
      // 无论换多少个镜像都不再更新 ⇒ `containers.image` 永远停在开户那一刻，运维问「这个 FDE
      // 在跑哪个 runner」只能人肉 `docker inspect`（实测：容器已是 v0.1.38 的 digest，库里还写着
      // v0.1.37 的）。复用路径就写**容器实际**的引用——期望值在这里可能是假话。
      await pool.query(
        `UPDATE containers SET image = COALESCE($2, image), updated_at = now()
          WHERE id = $1 AND status <> 'removed'`,
        [dbRow.id, existing.data?.Config?.Image ?? existing.data?.Image ?? null],
      );
    } else {
      ({ token, tokenHash } = generateRunnerToken());
      needRecreate = true;
      if (dbRow) {
        await pool.query(
          `UPDATE containers SET runner_token_hash = $2, token_generation = token_generation + 1,
              status = 'creating', revoked_at = NULL, rotated_at = now(),
              image = COALESCE($3, image), updated_at = now() WHERE id = $1`,
          // issue #404：这条 UPDATE 马上会跟一次 create（用的就是 config.fdeImage），所以此刻写
          // 期望值是真话；status='creating' 也已经把"还没起来"标了出来。
          [dbRow.id, tokenHash, config.fdeImage ?? null],
        );
        containerId = dbRow.id;
      } else {
        const row = await pool.query(
          `INSERT INTO containers
             (user_id, fde_name, container_name, runner_token_hash, token_generation, status, image, agent_version, git_provider)
           VALUES ($1, $2, $3, $4, 1, 'creating', $5, $6, $7)
           RETURNING id`,
          [userId, fdeName, containerName, tokenHash, config.fdeImage, config.fdeAgentVersion ?? 'dev', gitHost?.provider ?? null],
        );
        containerId = row.rows[0].id;
      }
    }

    ensureUserSpaceMountDirs({
      userSpaceRoot: config.userSpaceRoot,
      fdeName,
      uid: config.fdeUid ?? 1000,
      gid: config.fdeGid ?? 1000,
      log,
    });

    let accountStatus = u.status;
    if (gitHost) {
      const hostName = new URL(gitHost.base_url).host;
      if (gitHost.mode === 'minted') {
        if (!gitAccount?.token_ref) {
          const minted = await mintGitAccount({
            provider: gitHost.provider,
            mode: gitHost.mode,
            baseUrl: gitHost.base_url,
            adminKey: gitHost.admin_key,
            login: fdeName,
            previousTokenRef,
          });
          await setGitCredential({
            pool,
            config,
            fdeName,
            host: hostName,
            username: minted.remoteLogin,
            token: minted.tokenPlaintext,
          });
          await pool.query(
            `INSERT INTO fde_git_accounts (fde_id, git_host_id, remote_login, token_ref)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (fde_id) DO UPDATE
               SET git_host_id = EXCLUDED.git_host_id, remote_login = EXCLUDED.remote_login,
                   token_ref = EXCLUDED.token_ref, updated_at = now()`,
            [userId, gitHost.id, minted.remoteLogin, minted.tokenRef],
          );
        }
        await pool.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'awaiting_credential'`, [userId]);
        accountStatus = 'active';
      } else {
        if (!gitAccount) {
          await pool.query(
            `INSERT INTO fde_git_accounts (fde_id, git_host_id, remote_login, token_ref)
             VALUES ($1, $2, NULL, NULL)`,
            [userId, gitHost.id],
          );
          gitAccount = { remote_login: null, token_ref: null };
        }
        if (gitAccount.token_ref || gitAccount.remote_login) {
          await pool.query(`UPDATE users SET status = 'active' WHERE id = $1 AND status = 'awaiting_credential'`, [userId]);
          accountStatus = 'active';
        } else {
          await pool.query(`UPDATE users SET status = 'awaiting_credential' WHERE id = $1 AND status = 'active'`, [userId]);
          accountStatus = 'awaiting_credential';
        }
      }
      await pool.query(`UPDATE containers SET git_provider = $2, updated_at = now() WHERE id = $1`, [containerId, gitHost.provider]);
    }

    const subnet = net.subnet;
    const gateway = net.gateway;
    const ip = fdeContainerIp(subnet);
    await ensureFdeNetwork(docker, { name: net.network_name, subnet, gateway, fdeName, stackId, log });
    if (needRecreate) {
      await removeFdeContainer(docker, containerName, { log }); // 删除失配旧容器（若有）
    }
    const res = await ensureFdeContainer(
      docker,
      {
        fdeName,
        containerName,
        image: config.fdeImage,
        cmd: config.fdeCmd,
        networkName: net.network_name,
        ip,
        gateway,
        baseDomain: config.baseDomain,
        llmHost: config.llmHost,
        portalPublicBaseUrl: config.portalPublicBaseUrl,
        userSpaceRoot: config.userSpaceRootHost, // F3
        memoryLimit: config.fdeMemoryLimit,
        runUser: config.fdeDevUser ?? null, // F5
        stackId, // F9：创建即打 station.stack 所有权标签
        runnerToken: token,
      },
      { log },
    );

    await pool.query(`UPDATE containers SET status = 'running', updated_at = now() WHERE id = $1`, [containerId]);

    // issue #240：开户即预分配 FDE 级预览域名，**写库与 route outbox / materialize revision 入队
    // 同一事务** ⇒ Traefik 路由与容器内 ~/.erix/ports.json 自动跟上，不再需要人工
    // enqueueFullRebuild + runMaterializerOnce（此前 port_allocations 从没被产品代码写过，手工插完
    // 之后派生链一律不动）。
    // 位置：网络与容器都已落地之后（路由的 backend 依赖本 FDE 网段）、LLM 联动之前——预览域名
    // 的正确性不依赖 LiteLLM 是否可达，LiteLLM 挂了也先把预览域名与派生链交付出。
    // 端口：issue #246 交付①——不再是固定的 4000–4009，而是**全局号池 22000–29999 里最小的未占用
    // 对齐块**（每段 10 个）；跨 FDE 不重叠由迁移 0019 的全局部分唯一索引保证（抢号失败 ⇒
    // preview_port_block_taken，整笔开户回滚，调用方重试）。
    // 幂等：部分唯一索引 + ON CONFLICT DO NOTHING ⇒ `cli.js provision-fde` 重跑只补缺口（#240 裁决 7）；
    // 重跑时块起点也从已有活行反推，不会新开一段。
    const previewPorts = await provisionFdePreviewPorts(pool, config, { fdeId: userId, fdeName, log });

    // issue #38 Phase B1：复用分支（needRecreate=false）可恢复 revoked binding；
    // 需要重建时只发布 active binding，后续 onboarding 的 llm-binding 步骤负责创建/恢复选中配置。
    // 放在容器就绪之后：LLM 路由的 ClientIP 条件依赖本 FDE 网段，先保证网络/容器落地再发布。
    // F1（Round B 评审）：参数名必须叫 fdeId——llm.js 的 syncFdeLlmBindingOnOnboard 按
    // { fdeId, fdeName, restoreRevoked } 解构，传 userId 会被静默丢弃 → fde_id=NULL → 无行命中，
    // 恢复/重发布静默 no-op。此处 userId 即该 FDE 的 users.id（= fde_llm_bindings.fde_id）。
    await syncFdeLlmBindingOnOnboard(pool, { fdeId: userId, fdeName, restoreRevoked: !needRecreate });

    return {
      userId,
      containerId,
      networkName: net.network_name,
      subnet,
      gateway,
      containerName,
      gitProvider: gitHost?.provider ?? null,
      status: accountStatus,
      // issue #240：本次开户新写的预览域名条数（重跑时为 0 ⇒ 已齐备，派生链没动）。
      // issue #246：额外带上**分到的块**（`blockStart/blockEnd`），运维与面板都靠它看号段。
      previewPorts: {
        requested: previewPorts.requested,
        created: previewPorts.inserted.length,
        skipped: previewPorts.skipped,
        blockStart: previewPorts.blockStart,
        blockEnd: previewPorts.blockEnd,
        ports: previewPorts.ports,
      },
    };
  });
}

/**
 * offboard 时收敛该用户全部 active run（issue #33，源自 #22 评审 F6）。
 *
 * 为什么必须做：容器被删后无人上报 U2 终态；非 cancelling 的过期租约还会被 reaper 回退
 * `pending`（容器已删、无人能 claim）→ run 长期非终态；且 `sessions.js` 的 ACTIVE_RUN_STATES 会让
 * `deleteProject` 409。
 *
 * 口径**对齐 reaper A2**（internal.js reapExpiredRuns 的 cancelling 分支）：
 * `run_queue → cancelled`（清 claim 字段）＋ `runs → finished` + `termination.reason='aborted'`
 * ＋合成 `run_end`（client_event_id = `<runId>:final:run_end`，seq 用 §7.3 统一分配器）。
 * best-effort：失败只告警、不回滚已提交的吊销（安全优先）；返回合成的 run_end 供调用方推 SSE。
 */
/**
 * 锁顺序说明（评审 blocker，两轮）：三方事务必须同序才能避免 deadlock——
 *   reaper（internal.js）：runs → run_queue → chat_sessions(allocSeq)
 *   stopSession（sessions.js）：chat_sessions → runs
 *   postMessage（sessions.js）：chat_sessions → llm-binding advisory（#38 N3，与 LLM 配置写入全序）
 *                            → containers（FOR UPDATE，#37）→ runs（新插入）
 * offboard 若在一个事务里「锁 runs 再 allocSeq 锁 sessions」，与 stopSession 反序；若「先锁 sessions
 * 再锁 runs」，与 reaper 反序——**任何单事务全序都会与某一方成环**。
 * 解法：拆两步。事务 A 只按 reaper 同序（runs → queue）终态化，**不碰 sessions**；
 * run_end 合成放独立小事务 B（只碰 sessions 单行），锁持有时间极短、不与 runs 锁共存 → 无环。
 * 代价：A 与 B 之间存在「runs 已 finished 但 run_end 未合成」的毫秒级窗口——进程恰好死在中间则
 * run_end 缺失（DB 状态仍是 finished，前端刷新可见；offboard 场景罕见，记 #36 残余）。
 */
async function terminateActiveRuns(pool, { userId, log = console } = {}) {
  // 事务 A：终态化（锁序 runs → run_queue，与 reaper 完全同序；不碰 chat_sessions）
  const runEnds = [];
  let client;
  try {
    // 连接获取也要在 best-effort 范围内（评审 major）：池耗尽/连接失败时只告警，
    // 不得让 offboard 在「token 已吊销、资源未清理」的中间态抛出。
    client = await pool.connect();
    await client.query('BEGIN');
    const active = await client.query(
      `SELECT r.id, r.session_id, q.attempts
         FROM runs r
         JOIN run_queue q ON q.run_id = r.id
        WHERE r.session_id IN (SELECT id FROM chat_sessions WHERE user_id = $1)
          AND r.status IN ('queued', 'running', 'cancelling')
        FOR UPDATE OF r`,
      [userId],
    );
    for (const row of active.rows ?? []) {
      await client.query(
        `UPDATE run_queue SET status='cancelled', claim_token=NULL, owner_container_id=NULL,
                              lease_until=NULL, claimed_at=NULL
          WHERE run_id=$1`,
        [row.id],
      );
      await client.query(
        `UPDATE runs SET status='finished', termination='{"reason":"aborted"}'::jsonb,
                         cancel_requested_at=COALESCE(cancel_requested_at, now()), ended_at=now()
          WHERE id=$1 AND status IN ('queued', 'running', 'cancelling')`,
        [row.id],
      );
      runEnds.push({ session_id: row.session_id, run_id: row.id, attempt: Number(row.attempts ?? 1) });
    }
    await client.query('COMMIT');
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    // 不抛：offboard 的安全语义（token 已吊销）不因业务收敛失败而回滚。
    log.warn?.(`[provisioner] offboard terminate active runs failed (user ${userId}): ${err.message}`);
    return [];
  } finally {
    client?.release();
  }
  if (runEnds.length === 0) return [];

  // 事务 B：合成 run_end（每 run 一个小事务，只锁 chat_sessions 单行；不持 runs 锁 → 无环）
  const events = [];
  for (const e of runEnds) {
    let c2;
    try {
      c2 = await pool.connect();
      await c2.query('BEGIN');
      const seq = await allocSeq(c2, e.session_id);
      const payload = {
        termination: { reason: 'aborted' },
        usage: { input_tokens: 0, output_tokens: 0 },
        rounds: 0,
        attempt: e.attempt,
      };
      await c2.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload, ts)
         VALUES ($1, $2, $3, $4, 'run_end', $5, now())
         ON CONFLICT (run_id, client_event_id) DO NOTHING`,
        [e.run_id, e.session_id, seq, `${e.run_id}:final:run_end`, JSON.stringify(payload)],
      );
      await c2.query('COMMIT');
      events.push({ session_id: e.session_id, run_id: e.run_id, seq, payload });
    } catch (err) {
      await c2?.query('ROLLBACK').catch(() => {});
      // run_end 缺失不回滚终态（runs 已 finished 是真相）；记告警。
      log.warn?.(`[provisioner] offboard run_end synthesis failed (run ${e.run_id}): ${err.message}`);
    } finally {
      c2?.release();
    }
  }
  return events;
}

/** offboarding（容器+网络）：**先吊销 token + 释放网段（一个事务）→ 再删 Docker 资源 → status 收敛**。
 *
 * F-B（审计 #34，major）：安全优先——token 必须先于资源删除失效，否则「Docker 删除成功但 DB 写失败」
 * 的窗口里 DB 仍认为 token 有效，泄漏的旧 token 可继续访问 internal API（违反不变式三「DB 是状态真相」）。
 * 且「释放网段」必须与「吊销」同事务：readFdeDesired 按 `fde_networks.state IN ('allocated','active')`
 * 判定 desired，若只提吊销而不离开 desired，下一次 reconcile 会 ensure 容器 → upsertContainerRow
 * 重写 token 并清空 revoked_at（PR #32 的 F1 修复）→ **FDE 被复活**。
 *
 * 删除失败的收敛路径（不假装成功，但也不留垃圾）：容器已不在 desired → reconcile 的孤儿分支删除
 * 容器并把 DB 行收敛为 removed（自愈）；status 不提前标 removed（F9：删除失败不标 removed）。
 */
export async function deprovisionFde(pool, config, { fdeName, docker, log = console, notify } = {}) {
  return withFdeLock(pool, fdeName, async () => {
    const user = await pool.query(`SELECT id, fde_name FROM users WHERE fde_name = $1`, [fdeName]);
    const u = user.rows[0];
    if (!u) throw new Error(`no user with fde_name=${fdeName}`);
    const containerRow = await pool.query(`SELECT id FROM containers WHERE user_id = $1`, [u.id]);
    const containerId = containerRow.rows[0]?.id ?? null;

    const containerName = `fde-${fdeName}`;
    const networkName = `fde-${fdeName}`;

    // ① 前置事务（原子）：吊销 token + 释放网段 + 路由收敛。
    //    token 立即失效（后续心跳/claim 401 token_revoked）；FDE 立即脱离 reconcile 的 desired 集合。
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE containers SET revoked_at = now(), updated_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`,
        [u.id],
      );
      await client.query(
        `UPDATE fde_networks SET state = 'released', released_at = now()
          WHERE fde_id = $1 AND state IN ('allocated', 'active')`,
        [u.id],
      );
      // FDE 网络释放 → 触发路由 reconciler 重生成（internal ipAllowList 收敛）。
      await enqueueRouteChange(client, { aggregate: 'fde_network', aggregateId: u.id, op: 'delete', payload: { network_name: networkName } });
      // issue #38 Phase B1：LLM 配置吊销与容器/token 吊销**同事务**（revokeFdeLlmConfigTx 只吃本事务
      // client）——凭据失效必须原子发生，不允许「token 已吊销、Traefik 仍注入上游 key」的中间窗口。
      await revokeFdeLlmConfigTx(client, { fdeId: u.id, fdeName });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // ①b 收敛该用户全部 active run（issue #33）——offboard = 系统发起的 stop；口径对齐 reaper A2。
    //     放在吊销事务提交之后：业务收敛失败不回滚安全吊销（best-effort，失败仅告警）。
    const runEnds = await terminateActiveRuns(pool, { userId: u.id, log });
    // #370：offboard 也是终态产出点之一（五条出队接线里的第五条）。这里**几乎总是**被容器闸门挡下
    // ——步骤 ① 刚把 token 吊销（`revoked_at` 非空），闸门正是要认这个事实。接线的价值恰恰是
    // 「五处同一个判定」这条纪律：漏掉这一处，将来某条不吊销容器的收敛路径就会让队列静默卡死。
    for (const e of runEnds) {
      await drainQueueAfterRun(pool, e.run_id, log).catch(() => {});
    }
    if (runEnds.length > 0) {
      if (typeof notify === 'function') {
        for (const e of runEnds) {
          try {
            notify(e.session_id, [{ seq: e.seq, ts: new Date().toISOString(), run_id: e.run_id, type: 'run_end', payload: e.payload }]);
          } catch { /* 尽力推送；跨进程时 hub 为空，live SSE 不实时（重连/刷新后由 backlog 补发） */ }
        }
      } else {
        log.warn?.(`[provisioner] offboard closed ${runEnds.length} active run(s); SSE notify 未注入（离线 CLI：前端由 backlog 补发）`);
      }
    }

    // ② 删 Docker 资源。失败 → throw 供重试；token 已吊销、网段已释放，残留容器由 reconcile 孤儿分支自愈。
    const containerRm = await removeFdeContainer(docker, containerName, { log });
    if (!containerRm.ok) {
      log.warn?.(`[provisioner] deprovision ${fdeName}: container removal failed; token already revoked, container left for reconciler cleanup`);
      throw new Error(`deprovision ${fdeName}: container removal failed (token already revoked; container left for reconciler cleanup)`);
    }
    const networkRm = await removeFdeNetwork(docker, networkName, { log });
    if (!networkRm.ok) {
      // 注：容器有 reconcile 孤儿分支自愈，**网络没有**对账清理路径（评审 B）——需重跑 deprovision-fde
      // 或人工 `docker network rm`；且残留网络会因 `assertNetworkContract` 子网校验阻断同 FDE 的 re-onboard。
      log.warn?.(`[provisioner] deprovision ${fdeName}: network removal failed; token already revoked, rerun deprovision or remove the network manually`);
      throw new Error(`deprovision ${fdeName}: network removal failed (token already revoked)`);
    }

    // ②b 凭据不在 DB/materializer 对账集中：Docker 资源移除后显式清理；失败时保留状态以便重试。
    try {
      removeGitCredentialFile({ config, fdeName });
    } catch (err) {
      log.warn?.(`[provisioner] deprovision ${fdeName}: git credential file removal failed; Docker resources already removed`);
      throw new Error(`deprovision ${fdeName}: git credential file removal failed (Docker resources already removed)`, { cause: err });
    }

    // ③ 资源已清理 → status 收敛（F9：只有删干净才标 removed）。
    await pool.query(
      `UPDATE containers SET status = 'removed', updated_at = now()
        WHERE user_id = $1 AND status <> 'removed'`,
      [u.id],
    );
    // F7：进程内广播 revoke（agentd 收到即停领新任务并收敛退出）——**仅作低延迟提示，不是安全边界**
    // （安全边界是 ① 的 DB 吊销：agentd 心跳/claim 的 401 token_revoked）。当前唯一调用者是 CLI
    // 独立进程，内存 hub 跨进程不可达 → issue #22 方案②。
    if (containerId) broadcastRevoke(containerId, { reason: 'offboarded' });
    return { userId: u.id, containerName, networkName };
  });
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 启动常驻对账循环（由 cli serve 调用）。 */
export function startProvisionerLoop(pool, config, { docker, log = console, onPause } = {}) {
  if (!docker) docker = createDockerClient({ dockerHost: config.dockerHost });
  let stopped = false;
  let consecutiveFailures = 0;
  (async () => {
    while (!stopped) {
      try {
        await reconcileOnce(pool, config, { docker, log });
        consecutiveFailures = 0;
        await sleep(5000);
      } catch (err) {
        consecutiveFailures += 1;
        log.warn?.(`[provisioner] loop error: ${err.message}`);
        onPause?.('provisioner', err);
        const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
        await sleep(backoff);
      }
    }
  })();
  return {
    stop() {
      stopped = true;
    },
  };
}
