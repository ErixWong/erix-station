// FDE 容器 provisioning：经 socket-proxy 调 Docker API（DOCKER_HOST），创建/启动/停止/删除 FDE 容器。
// 依据：docs/design/deploy-contract.md §5（B6 创建字段 allowlist / socket-proxy 白名单）/§6（容器创建契约）、
//       docs/design/topology.md §3（每 FDE 一条 /29）、docs/design/user-space.md §2/§6（bind mount / UID / 权限）、
//       docs/data/schema.sql §2/§9（containers / fde_networks）。
//
// 三条不变式落地：
//   1. FDE 容器不 publish 端口（HostConfig.PortBindings 恒空）；
//   2. portal 不挂 docker.sock（只经 DOCKER_HOST=tcp://station-docker-socket-proxy:2375 访问）；
//   3. DB 是状态真相（容器状态回写 containers；启动/定时对账 DB↔Docker）。
//
// 代码层 Docker API 白名单（DOCKER_ALLOWED_PATHS）：只允许下列路径，多余路径一律拒绝（B6 落地）。

import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDirSafe } from './fsutil.js';
import { parseCidr, intToIp, allocateNetwork } from './ipam.js';
import { hashToken } from './auth.js';

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
  userSpaceRoot,
  homeUser = 'erix',
  env = [],
  labels = {},
  memoryLimit = '512m',
  runUser = null, // '1001:1000' 等；镜像不具备双 UID 用户时用 --user 兜底
  capAdd = [],
}) {
  const home = `/home/${homeUser}`;
  const hostRoot = path.join(path.resolve(userSpaceRoot), fdeName);
  const binds = [
    `${hostRoot}/home:${home}`,
    `${hostRoot}/projects:${home}/projects`,
    `${hostRoot}/worktrees:${home}/worktrees`,
    `${hostRoot}/cache:${home}/cache`,
  ];
  const body = {
    Image: image,
    Cmd: cmd,
    Env: env,
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
      ExtraHosts: [`station.${baseDomain}:${gateway}`, `llm.${baseDomain}:${gateway}`],
      // 不变式一：不 publish 端口。
      PortBindings: {},
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [networkName]: { IPAMConfig: { IPv4Address: ip } },
      },
    },
  };
  if (runUser) body.User = runUser;
  return body;
}

/** FDE 网络的 Docker API create body（契约 §6.1：显式 subnet + gateway）。 */
export function buildNetworkConfig({ name, subnet, gateway, fdeName }) {
  return {
    Name: name,
    CheckDuplicate: true,
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

/** 确保 docker 网络存在（不存在则按契约创建）。返回 { created, id }。 */
export async function ensureFdeNetwork(docker, { name, subnet, gateway, fdeName, log = console }) {
  const existing = await docker.inspectNetwork(name);
  if (existing.status === 200) return { created: false, id: existing.data?.Id ?? null };
  if (existing.status !== 404) {
    throw new Error(`inspect network ${name} failed: HTTP ${existing.status}`);
  }
  const res = await docker.createNetwork(buildNetworkConfig({ name, subnet, gateway, fdeName }));
  if (res.status === 409) {
    // 并发下另一 reconcile/onboard 已创建 → 视为已存在。
    return { created: false, id: null };
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

/**
 * 确保 FDE 容器存在并 running（不存在则创建+启动）。
 * 返回 { created, started, id, token }（token 仅在新建时生成并注入容器 env）。
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
    return { created: false, started, id: existing.data?.Id ?? null, token: null };
  }
  if (existing.status !== 404) {
    throw new Error(`inspect container ${containerName} failed: HTTP ${existing.status}`);
  }

  const { token } = generateRunnerToken();
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
      return { created: false, started: status !== 'running', id: now.data?.Id ?? null, token: null };
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
  return { created: true, started: true, id, token };
}

/** 停止并删除 FDE 容器（404 视为已删）。 */
export async function removeFdeContainer(docker, containerName, { log = console } = {}) {
  const stop = await docker.stopContainer(containerName).catch(() => ({ status: 404 }));
  if (stop.status !== 204 && stop.status !== 304 && stop.status !== 404) {
    log.warn?.(`[provisioner] stop ${containerName} returned ${stop.status}`);
  }
  const rm = await docker.removeContainer(containerName).catch(() => ({ status: 404 }));
  if (rm.status !== 204 && rm.status !== 404) {
    log.warn?.(`[provisioner] rm ${containerName} returned ${rm.status}`);
  }
  return rm.status === 204 || rm.status === 404;
}

/** 删除 FDE 网络（404 视为已删；不删仍被容器占用的网络）。 */
export async function removeFdeNetwork(docker, networkName, { log = console } = {}) {
  const rm = await docker.removeNetwork(networkName).catch(() => ({ status: 404 }));
  if (rm.status !== 204 && rm.status !== 404) {
    log.warn?.(`[provisioner] rm network ${networkName} returned ${rm.status}`);
  }
  return rm.status === 204 || rm.status === 404;
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
      ensureUserSpaceMountDirs({
        userSpaceRoot: config.userSpaceRoot,
        fdeName,
        uid: config.fdeUid ?? 1000,
        gid: config.fdeGid ?? 1000,
        log,
      });
      await ensureFdeNetwork(docker, { name: networkName, subnet, gateway, fdeName, log });

      const res = await ensureFdeContainer(
        docker,
        {
          fdeName,
          containerName,
          image: config.fdeImage,
          cmd: config.fdeCmd,
          networkName,
          ip,
          gateway,
          baseDomain: config.baseDomain,
          llmHost: config.llmHost,
          userSpaceRoot: config.userSpaceRoot,
          memoryLimit: config.fdeMemoryLimit,
          runUser: `${config.agentdUid ?? 1001}:${config.fdeGid ?? 1000}`,
        },
        { log },
      );

      // 容器状态回写 DB（DB 是真相）；重建时同步写入 runner_token_hash（轮换，issue #12）。
      if (res.created) {
        stats.rebuilt += 1;
        if (res.token) {
          await pool.query(
            `UPDATE containers
                SET status = 'running', runner_token_hash = $2, token_generation = token_generation + 1,
                    rotated_at = now(), updated_at = now()
              WHERE user_id = $1`,
            [row.user_id, hashToken(res.token)],
          );
        } else {
          await pool.query(
            `UPDATE containers SET status = 'running', updated_at = now()
              WHERE user_id = $1 AND status <> 'removed'`,
            [row.user_id],
          );
        }
      } else if (res.started) {
        await pool.query(
          `UPDATE containers SET status = 'running', updated_at = now()
            WHERE user_id = $1 AND status <> 'removed'`,
          [row.user_id],
        );
        stats.statusUpdates += 1;
      }
      stats.ensured += 1;
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
    await removeFdeContainer(docker, name, { log }).catch(() => {});
    stats.orphansRemoved += 1;
  }

  return stats;
}

/** onboarding：分配子网（IPAM）→ 写 containers 行 → 建网络 + 容器 → status running。幂等。 */
export async function onboardFde(pool, config, { fdeName, docker, log = console } = {}) {
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

  const existing = await pool.query(`SELECT id FROM containers WHERE user_id = $1`, [userId]);
  let containerId;
  if (existing.rows[0]) {
    containerId = existing.rows[0].id;
  } else {
    const { tokenHash } = generateRunnerToken();
    const row = await pool.query(
      `INSERT INTO containers (user_id, fde_name, container_name, runner_token_hash, token_generation, status, image, agent_version)
       VALUES ($1, $2, $3, $4, 1, 'creating', $5, $6)
       RETURNING id`,
      [userId, fdeName, `fde-${fdeName}`, tokenHash, config.fdeImage, config.fdeAgentVersion ?? 'dev'],
    );
    containerId = row.rows[0].id;
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
  const res = await ensureFdeContainer(
    docker,
    {
      fdeName,
      containerName: `fde-${fdeName}`,
      image: config.fdeImage,
      cmd: config.fdeCmd,
      networkName: net.network_name,
      ip,
      gateway,
      baseDomain: config.baseDomain,
      llmHost: config.llmHost,
      userSpaceRoot: config.userSpaceRoot,
      memoryLimit: config.fdeMemoryLimit,
      runUser: `${config.agentdUid ?? 1001}:${config.fdeGid ?? 1000}`,
    },
    { log },
  );

  if (res.created && res.token) {
    await pool.query(
      `UPDATE containers SET status = 'running', runner_token_hash = $2, token_generation = token_generation + 1,
          rotated_at = now(), updated_at = now() WHERE id = $1`,
      [containerId, hashToken(res.token)],
    );
  } else {
    await pool.query(`UPDATE containers SET status = 'running', updated_at = now() WHERE id = $1`, [containerId]);
  }

  return {
    userId,
    containerId,
    networkName: net.network_name,
    subnet,
    gateway,
    containerName: `fde-${fdeName}`,
  };
}

/** offboarding（容器+网络）：停/删容器 → 删网络 → DB 状态收敛（removed / released）。 */
export async function deprovisionFde(pool, config, { fdeName, docker, log = console } = {}) {
  const user = await pool.query(`SELECT id, fde_name FROM users WHERE fde_name = $1`, [fdeName]);
  const u = user.rows[0];
  if (!u) throw new Error(`no user with fde_name=${fdeName}`);

  const containerName = `fde-${fdeName}`;
  const networkName = `fde-${fdeName}`;
  await removeFdeContainer(docker, containerName, { log }).catch((err) => log.warn?.(`[provisioner] ${err.message}`));
  await removeFdeNetwork(docker, networkName, { log }).catch((err) => log.warn?.(`[provisioner] ${err.message}`));

  await pool.query(`UPDATE containers SET status = 'removed', updated_at = now() WHERE user_id = $1 AND status <> 'removed'`, [u.id]);
  await pool.query(
    `UPDATE fde_networks SET state = 'released', released_at = now()
      WHERE fde_id = $1 AND state IN ('allocated', 'active')`,
    [u.id],
  );
  return { userId: u.id, containerName, networkName };
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
