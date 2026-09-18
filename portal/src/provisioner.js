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
import { broadcastRevoke } from './internal.js';

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
    listNetworks: () => call('GET', '/networks'),
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
  memoryLimit = '4g', // issue #27 已决 2026-09-18（B 档镜像下 dotnet build/chromium 峰值；0 不限）
  runUser = null, // '1001:1000' 等；镜像不具备双 UID 用户时用 --user 兜底（FDE_DEV_USER，⚠️ dev 偏差）
  capAdd = ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL'], // 契约 §6.2：root 启动→drop 1001、fork 1002 所需最小集（含跨 UID kill 的 CAP_KILL）
}) {
  const home = `/home/${homeUser}`;
  const hostRoot = path.join(path.resolve(userSpaceRoot), fdeName);
  const binds = [
    `${hostRoot}/home:${home}`,
    `${hostRoot}/projects:${home}/projects`,
    `${hostRoot}/worktrees:${home}/worktrees`,
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
    ],
    Labels: { 'station.managed': 'true', 'fde.name': fdeName, ...labels },
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
export function buildNetworkConfig({ name, subnet, gateway, fdeName }) {
  return {
    Name: name,
    Driver: 'bridge',
    IPAM: { Driver: 'default', Config: [{ Subnet: subnet, Gateway: gateway }] },
    Labels: { 'station.managed': 'true', 'fde.name': fdeName },
  };
}

/** 确保 FDE 用户空间 4 个 bind mount 宿主目录存在（2770 + uid/gid，user-space §2.4/§6.2）。 */
export function ensureUserSpaceMountDirs({ userSpaceRoot, fdeName, uid, gid, log = console }) {
  const root = path.resolve(userSpaceRoot);
  const fdeRoot = path.join(root, fdeName);
  for (const sub of ['home', 'projects', 'worktrees', 'cache']) {
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
export async function ensureFdeNetwork(docker, { name, subnet, gateway, fdeName, log = console }) {
  const existing = await docker.inspectNetwork(name);
  if (existing.status === 200) {
    // F11：inspect 200 后必须校验 managed label + fde.name + subnet/gateway 与 DB 一致；不一致 → 报错（不静默采用）。
    assertNetworkContract(existing.data ?? {}, { name, subnet, gateway, fdeName });
    return { created: false, id: existing.data?.Id ?? null };
  }
  if (existing.status !== 404) {
    throw new Error(`inspect network ${name} failed: HTTP ${existing.status}`);
  }
  const res = await docker.createNetwork(buildNetworkConfig({ name, subnet, gateway, fdeName }));
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
      if (r.status !== 204 && r.status !== 304) {
        throw new Error(`start container ${containerName} failed: HTTP ${r.status}`);
      }
      started = true;
    }
    return { created: false, started, id: existing.data?.Id ?? null, token: null, envToken: readContainerEnv(existing.data) };
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
  return { created: true, started: true, id, token, envToken: token };
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

/** 该 FDE 应「有容器」的 desired state（fde_networks allocated/active + user active + fde_name）。 */
export async function readFdeDesired(pool) {
  const r = await pool.query(
    `SELECT u.id AS user_id, u.fde_name,
            n.subnet, n.gateway, n.network_name,
            c.id AS container_id, c.container_name, c.status AS container_status, c.runner_token_hash
       FROM users u
       JOIN fde_networks n ON n.fde_id = u.id AND n.state IN ('allocated', 'active')
       LEFT JOIN containers c ON c.user_id = u.id
      WHERE u.status = 'active' AND u.fde_name IS NOT NULL
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
async function withFdeLock(pool, fdeName, fn) {
  let client;
  try {
    client = await pool.connect();
  } catch {
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
  const desired = await readFdeDesired(pool);
  const desiredNames = new Set(desired.map((r) => `fde-${r.fde_name}`));
  const stats = { ensured: 0, rebuilt: 0, orphansRemoved: 0, statusUpdates: 0 };

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
        await ensureFdeNetwork(docker, { name: networkName, subnet, gateway, fdeName, log });

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
        } else if (res.started) {
          await pool.query(
            `UPDATE containers SET status = 'running', updated_at = now()
              WHERE user_id = $1 AND status <> 'removed'`,
            [row.user_id],
          );
          stats.statusUpdates += 1;
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

  // 孤儿容器：带 station.managed 标签、但 DB 无对应非 removed 容器 → 删除 + 告警。
  const listed = await docker.listContainers({ label: ['station.managed=true'] }).catch(() => ({ status: 200, data: [] }));
  for (const c of listed.data ?? []) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name.startsWith('fde-')) continue;
    if (desiredNames.has(name)) continue;
    log.warn?.(`[provisioner] orphan container detected: ${name} (removing)`);
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, target, details)
       VALUES (NULL, 'container.orphan_removed', $1, $2)`,
      [name, JSON.stringify({ reason: 'docker has managed container not present in DB desired state' })],
    ).catch(() => {});
    const rm = await removeFdeContainer(docker, name, { log }).catch(() => ({ ok: false }));
    if (rm.ok) stats.orphansRemoved += 1;
  }

  return stats;
}

/** onboarding：分配子网（IPAM）→ 单点生成 token（hash 入 DB + 明文只进 create env）→ 建网络 + 容器 → status running。幂等。 */
export async function onboardFde(pool, config, { fdeName, docker, log = console } = {}) {
  return withFdeLock(pool, fdeName, async () => {
    const user = await pool.query(
      `SELECT id, fde_name, status FROM users WHERE fde_name = $1 AND status = 'active'`,
      [fdeName],
    );
    const u = user.rows[0];
    if (!u) throw new Error(`no active user with fde_name=${fdeName}`);
    const userId = u.id;

    const net = await allocateNetwork(pool, userId, fdeName, {
      poolName: config.fdePool ?? 'default',
      reservedSubnets: config.reservedSubnets ?? [],
      log,
    });

    const containerName = `fde-${fdeName}`;
    // F6：单点 token——检查既有 DB 行与既有容器 env token 是否一致，一致则复用（幂等，不轮换）。
    const dbRow = (await pool.query(`SELECT id, runner_token_hash FROM containers WHERE user_id = $1`, [userId])).rows[0];
    const existing = await docker.inspectContainer(containerName);
    const envToken = existing.status === 200 ? readContainerEnv(existing.data) : null;

    let token;
    let tokenHash;
    let containerId;
    let needRecreate;
    if (dbRow && existing.status === 200 && envToken && hashToken(envToken) === dbRow.runner_token_hash) {
      token = envToken;
      tokenHash = dbRow.runner_token_hash;
      containerId = dbRow.id;
      needRecreate = false;
    } else {
      ({ token, tokenHash } = generateRunnerToken());
      needRecreate = true;
      if (dbRow) {
        await pool.query(
          `UPDATE containers SET runner_token_hash = $2, token_generation = token_generation + 1,
              status = 'creating', rotated_at = now(), updated_at = now() WHERE id = $1`,
          [dbRow.id, tokenHash],
        );
        containerId = dbRow.id;
      } else {
        const row = await pool.query(
          `INSERT INTO containers (user_id, fde_name, container_name, runner_token_hash, token_generation, status, image, agent_version)
           VALUES ($1, $2, $3, $4, 1, 'creating', $5, $6)
           RETURNING id`,
          [userId, fdeName, containerName, tokenHash, config.fdeImage, config.fdeAgentVersion ?? 'dev'],
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

    const subnet = net.subnet;
    const gateway = net.gateway;
    const ip = fdeContainerIp(subnet);
    await ensureFdeNetwork(docker, { name: net.network_name, subnet, gateway, fdeName, log });
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
        runnerToken: token,
      },
      { log },
    );

    await pool.query(`UPDATE containers SET status = 'running', updated_at = now() WHERE id = $1`, [containerId]);

    return {
      userId,
      containerId,
      networkName: net.network_name,
      subnet,
      gateway,
      containerName,
    };
  });
}

/** offboarding（容器+网络）：停/删容器 → 删网络 → DB 状态收敛（removed / released）。F9：删除失败不标 removed。 */
export async function deprovisionFde(pool, config, { fdeName, docker, log = console } = {}) {
  return withFdeLock(pool, fdeName, async () => {
    const user = await pool.query(`SELECT id, fde_name FROM users WHERE fde_name = $1`, [fdeName]);
    const u = user.rows[0];
    if (!u) throw new Error(`no user with fde_name=${fdeName}`);
    const containerRow = await pool.query(`SELECT id FROM containers WHERE user_id = $1`, [u.id]);
    const containerId = containerRow.rows[0]?.id ?? null;

    const containerName = `fde-${fdeName}`;
    const networkName = `fde-${fdeName}`;
    const containerRm = await removeFdeContainer(docker, containerName, { log });
    if (!containerRm.ok) {
      // F9：Docker 删除失败 → 不更新 DB（保留 desired state 供下次对账重试）+ 告警。
      log.warn?.(`[provisioner] deprovision ${fdeName}: container removal failed; desired state preserved for retry`);
      throw new Error(`deprovision ${fdeName}: container removal failed (status preserved for retry)`);
    }
    const networkRm = await removeFdeNetwork(docker, networkName, { log });
    if (!networkRm.ok) {
      log.warn?.(`[provisioner] deprovision ${fdeName}: network removal failed; desired state preserved for retry`);
      throw new Error(`deprovision ${fdeName}: network removal failed (status preserved for retry)`);
    }

    await pool.query(`UPDATE containers SET status = 'removed', updated_at = now() WHERE user_id = $1 AND status <> 'removed'`, [u.id]);
    // F7：offboarding 吊销 token → 进程内广播 revoke（agentd 收到即停领新任务并收敛退出）。
    // 排序语义（评审 PR#23 M2）：广播放在 desired state 提交之后——F9 删除失败保留现场时不广播，
    // 避免容器保留但 agentd 已被叫停的坏状态。已知限制：当前唯一调用者是 CLI 独立进程，
    // 内存 hub 跨进程不可达（收敛靠心跳 token_revoked 兜底）→ issue #22 统一解决。
    if (containerId) broadcastRevoke(containerId, { reason: 'offboarded' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE fde_networks SET state = 'released', released_at = now()
          WHERE fde_id = $1 AND state IN ('allocated', 'active')`,
        [u.id],
      );
      // FDE 网络释放 → 触发路由 reconciler 重生成（internal ipAllowList / llm 路由收敛）。
      await enqueueRouteChange(client, { aggregate: 'fde_network', aggregateId: u.id, op: 'delete', payload: { network_name: networkName } });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
