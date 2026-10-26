// 单测：provisioner.js —— 代码层 Docker API 白名单 / 容器创建 body（不 publish / bind mount / 网络）/
//       Docker API 调用序列（fake server）/ 对账逻辑（重建 + 孤儿清理）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAllowedDockerPath,
  dockerBaseUrl,
  createDockerClient,
  buildContainerConfig,
  buildNetworkConfig,
  parseMemoryLimit,
  ensureFdeNetwork,
  ensureFdeContainer,
  fdeContainerIp,
  reconcileOnce,
  deprovisionFde,
  DOCKER_ALLOWED_PATHS,
} from '../src/provisioner.js';
import { hashToken } from '../src/auth.js';
import { syncFdeLlmBindingOnOnboard } from '../src/llm.js';

// 宿主侧属主跟随进程身份（同 portal/test/git-cli-config.test.js 顶部口径）：
// config.fdeUid/fdeGid 会进 ensureDirSafe 的 chown，硬编码 1000 在 uid≠1000 的 runner 上
// 只会刷 best-effort 告警（不抛错，但拿不到真实属主）；取自身后 chown 真正成立。
// ⚠ 容器侧属主（`fdeDevUser: '1001:1000'`、`runUser`）不跟随进程——那是产品口径，不得改。
const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

const DEPROVISION_USER_SPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'station-provisioner-users-'));
test.after(() => fs.rmSync(DEPROVISION_USER_SPACE_ROOT, { recursive: true, force: true }));

// 测试隔离（§2.1）：reconcileOnce 用例会 ensureUserSpaceMountDirs → mkdir 真实 userSpaceRoot。
// 此前写死真实 /srv/erix/users（root:root 0755）→ 非 root 单测 EACCES（仅靠残留测试目录可写才偶然过）。
// 照拄上方 DEPROVISION 模式注入临时根；userSpaceRootHost（bind source 断言用）保持原值不动。
const RECONCILE_USER_SPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'station-provisioner-users-'));
test.after(() => fs.rmSync(RECONCILE_USER_SPACE_ROOT, { recursive: true, force: true }));

function deprovisionForTest(pool, config, options) {
  const useInjectedRoot = typeof config?.userSpaceRoot === 'string';
  const userSpaceRoot = useInjectedRoot
    ? config.userSpaceRoot
    : fs.mkdtempSync(path.join(os.tmpdir(), 'station-provisioner-users-'));
  return deprovisionFde(pool, { ...config, userSpaceRoot }, options)
    .finally(() => {
      if (!useInjectedRoot) fs.rmSync(userSpaceRoot, { recursive: true, force: true });
    });
}

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', res));
}

test('代码层白名单：允许清单内的路径 / 拒绝多余路径（含 exec/images/system）', () => {
  assert.equal(assertAllowedDockerPath('GET', '/_ping'), true);
  assert.equal(assertAllowedDockerPath('GET', '/containers/json'), true);
  assert.equal(assertAllowedDockerPath('POST', '/containers/create'), true);
  assert.equal(assertAllowedDockerPath('GET', '/containers/abc123/json'), true);
  assert.equal(assertAllowedDockerPath('POST', '/containers/abc123/start'), true);
  assert.equal(assertAllowedDockerPath('POST', '/containers/abc123/stop'), true);
  assert.equal(assertAllowedDockerPath('DELETE', '/containers/abc123'), true);
  assert.equal(assertAllowedDockerPath('POST', '/networks/create'), true);
  assert.equal(assertAllowedDockerPath('GET', '/networks/fde-alice'), true);

  // 多余路径一律拒绝（B6：纵向提权面 EXEC/SYSTEM/IMAGES 等）
  for (const [m, p] of [
    ['GET', '/exec'],
    ['POST', '/containers/abc/exec'],
    ['GET', '/images/json'],
    ['GET', '/info'],
    ['GET', '/system/info'],
    ['POST', '/volumes/create'],
    ['DELETE', '/networks/../containers/x'],
    ['POST', '/containers/abc/rename'],
  ]) {
    assert.throws(() => assertAllowedDockerPath(m, p), (e) => e.code === 'docker_path_denied', `${m} ${p} 应被拒`);
  }
});

test('dockerBaseUrl：tcp:// 转 http；拒绝 unix socket（portal 只经 socket-proxy）', () => {
  assert.equal(dockerBaseUrl('tcp://station-docker-socket-proxy:2375'), 'http://station-docker-socket-proxy:2375');
  assert.throws(() => dockerBaseUrl('unix:///var/run/docker.sock'), (e) => e.code === 'docker_host_unsupported');
});

test('parseMemoryLimit：512m/1g/0/数字', () => {
  assert.equal(parseMemoryLimit('512m'), 512 * 1024 * 1024);
  assert.equal(parseMemoryLimit('1g'), 1024 * 1024 * 1024);
  assert.equal(parseMemoryLimit('0'), 0);
  assert.equal(parseMemoryLimit(''), 0);
  assert.equal(parseMemoryLimit(2048), 2048);
});

test('fdeContainerIp：gateway+1 = .2（topology §3）', () => {
  assert.equal(fdeContainerIp('10.200.1.0/29'), '10.200.1.2');
  assert.equal(fdeContainerIp('10.201.7.0/28'), '10.201.7.2');
});

test('buildContainerConfig：不 publish 端口 / bind mount 只允许本 FDE / 网络+IP / --user 兜底 / 资源限额', () => {
  const body = buildContainerConfig({
    fdeName: 'alice',
    containerName: 'fde-alice',
    image: 'traefik/whoami',
    cmd: ['-port', '4000'],
    networkName: 'fde-alice',
    ip: '10.200.1.2',
    gateway: '10.200.1.1',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
    userSpaceRoot: '/srv/erix/users',
    memoryLimit: '512m',
    runUser: '1001:1000',
  });
  assert.equal(body.Image, 'traefik/whoami');
  assert.deepEqual(body.Cmd, ['-port', '4000']);
  assert.equal(body.User, '1001:1000'); // 镜像无双 UID 用户 → --user 兜底
  assert.equal(body.Labels['station.managed'], 'true');
  assert.equal(body.Labels['fde.name'], 'alice');
  // 不变式一：不 publish 端口（proxy P1 字段级 allowlist 拒绝任何 PortBindings 字段）
  assert.equal('PortBindings' in body.HostConfig, false);
  // bind mount 只允许本 FDE 用户空间（user-space §2.4）；D8 修订：worktrees 挂载已拆除（#81 P2.5）
  assert.deepEqual(body.HostConfig.Binds, [
    '/srv/erix/users/alice/home:/home/erix',
    '/srv/erix/users/alice/projects:/home/erix/projects',
    '/srv/erix/users/alice/cache:/home/erix/cache',
  ]);
  // 只接自己的 /29
  assert.equal(body.HostConfig.NetworkMode, 'fde-alice');
  // R2：不再携带 NetworkingConfig（--ip 已移除，默认 IPAM 顺序分配固定位 .2）
  assert.equal('NetworkingConfig' in body, false);
  assert.equal(body.HostConfig.Memory, 512 * 1024 * 1024);
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(body.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal(body.HostConfig.Init, true);
  // 契约 §6.2：容器内 station.<base>/llm.<base> → 本 FDE bridge 网关（--add-host）。
  assert.deepEqual(body.HostConfig.ExtraHosts, ['station.localhost:10.200.1.1', 'llm.localhost:10.200.1.1']);
  assert.ok(body.Env.some((e) => e.startsWith('ERIX_STATION_BASE_URL=https://station.localhost/api/internal')), '默认 portal base url');
  // issue #84 P5：agentd/worker 可调参数下发（默认值随 portal env）。
  assert.ok(body.Env.includes('ERIX_MAX_ROUNDS=16'), 'ERIX_MAX_ROUNDS 默认下发');
  assert.ok(body.Env.includes('ERIX_AGENTD_CAPACITY=2'), 'ERIX_AGENTD_CAPACITY 默认下发');
  assert.ok(body.Env.includes('ERIX_ARTIFACT_MAX_BYTES=104857600'), 'ERIX_ARTIFACT_MAX_BYTES 默认下发');
  assert.ok(body.Env.includes('ERIX_ARTIFACT_CAPTURE_BUDGET_MS=60000'), 'ERIX_ARTIFACT_CAPTURE_BUDGET_MS 默认下发');
  assert.ok(body.Env.includes('ERIX_SHELL_TIMEOUT_MS=60000'), 'ERIX_SHELL_TIMEOUT_MS 默认下发');
  assert.ok(body.Env.includes('ERIX_SHELL_MAX_TIMEOUT_MS=600000'), 'ERIX_SHELL_MAX_TIMEOUT_MS 默认下发');
  assert.ok(body.Env.includes('ERIX_SHELL_OUTPUT_MAX_BYTES=32768'), 'ERIX_SHELL_OUTPUT_MAX_BYTES 默认下发');
  // issue #88 / #114 修订：worker 侧会话标题生成开关（字符串开关；#114 起**默认下发 '0'**——
  // 默认标题改由首条消息截断/手工/AI 改名承担，省 token；显式设 1 才开回 #88 行为）。
  assert.ok(body.Env.includes('ERIX_SESSION_AUTO_TITLE=0'), 'ERIX_SESSION_AUTO_TITLE 默认下发 0（#114 默认关）');
});

test('issue #114：ERIX_SESSION_AUTO_TITLE 显式设 1 → 下发 1（开回 #88 自动起名）；其它值 → 0', () => {
  const cfg = {
    fdeName: 'alice',
    containerName: 'fde-alice',
    image: 'traefik/whoami',
    cmd: ['-port', '4000'],
    networkName: 'fde-alice',
    ip: '10.200.1.2',
    gateway: '10.200.1.1',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
    userSpaceRoot: '/srv/erix/users',
    memoryLimit: '512m',
    runUser: '1001:1000',
  };
  const prev = process.env.ERIX_SESSION_AUTO_TITLE;
  try {
    process.env.ERIX_SESSION_AUTO_TITLE = '1';
    assert.ok(buildContainerConfig(cfg).Env.includes('ERIX_SESSION_AUTO_TITLE=1'), '显式 1 → 下发 1');
    process.env.ERIX_SESSION_AUTO_TITLE = 'yes';
    assert.ok(buildContainerConfig(cfg).Env.includes('ERIX_SESSION_AUTO_TITLE=0'), '非 1 值 → 下发 0');
  } finally {
    if (prev === undefined) delete process.env.ERIX_SESSION_AUTO_TITLE;
    else process.env.ERIX_SESSION_AUTO_TITLE = prev;
  }
});

test('buildNetworkConfig：显式 subnet + gateway', () => {
  const body = buildNetworkConfig({ name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' });
  assert.equal(body.Name, 'fde-alice');
  // R2：不再携带 CheckDuplicate（proxy 网络创建白名单只允许 Name/Driver/IPAM/Labels）
  assert.equal('CheckDuplicate' in body, false);
  assert.deepEqual(body.IPAM.Config, [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }]);
  assert.equal(body.Labels['station.managed'], 'true');
});

test('Docker API 调用序列（fake server）：建网络 + 建容器 + 启动', async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: raw ? JSON.parse(raw) : null });
      const p = req.url.split('?')[0];
      if (p === '/networks/fde-alice') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"not found"}');
      } else if (p === '/networks/create') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'nid1' }));
      } else if (p === '/containers/fde-alice/json') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"message":"not found"}');
      } else if (p === '/containers/create') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ Id: 'cid1' }));
      } else if (p === '/containers/cid1/start') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      }
    });
  });
  await listen(server);
  const port = server.address().port;
  const docker = createDockerClient({ dockerHost: `http://127.0.0.1:${port}` });
  try {
    const net = await ensureFdeNetwork(docker, { name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' });
    assert.equal(net.created, true);
    assert.equal(net.id, 'nid1');
    const ctr = await ensureFdeContainer(
      docker,
      {
        fdeName: 'alice',
        containerName: 'fde-alice',
        image: 'traefik/whoami',
        cmd: ['-port', '4000'],
        networkName: 'fde-alice',
        ip: '10.200.1.2',
        gateway: '10.200.1.1',
        baseDomain: 'localhost',
        llmHost: 'llm.localhost',
        userSpaceRoot: '/srv/erix/users',
      },
      {},
    );
    assert.equal(ctr.created, true);
    assert.equal(ctr.id, 'cid1');
    assert.ok(ctr.token, '新建容器应生成 per-container token');

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.path}`),
      [
        'GET /networks/fde-alice',
        'POST /networks/create',
        'GET /containers/fde-alice/json',
        'POST /containers/create?name=fde-alice',
        'POST /containers/cid1/start',
      ],
    );
    // create body 必须无端口发布字段（proxy P1 拒绝任何 PortBindings 字段）
    const createCall = calls.find((c) => c.path.startsWith('/containers/create'));
    assert.equal('PortBindings' in createCall.body.HostConfig, false);
    assert.ok(createCall.body.Env.some((e) => e.startsWith('ERIX_STATION_TOKEN=')), '容器 env 注入 per-container token');
    assert.ok(createCall.body.Env.some((e) => e === 'ERIX_FDE_NAME=alice'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('reconcileOnce：DB 说该有而 Docker 没有 → 重建；孤儿容器 → 删除 + 审计', async () => {
  const pool = {
    audit: [],
    containerUpserts: [],
    orphanRemovedRows: [],
    async query(sql, params = []) {
      if (sql.includes('FROM users u') && sql.includes('JOIN fde_networks n')) {
        return {
          rows: [
            {
              user_id: 'u1',
              fde_name: 'alice',
              subnet: '10.200.1.0/29',
              gateway: '10.200.1.1',
              network_name: 'fde-alice',
              container_id: null,
              container_name: 'fde-alice',
              container_status: null,
              runner_token_hash: null,
            },
          ],
        };
      }
      // F10：锁内重新确认仍是 desired
      if (sql.includes('SELECT 1 FROM fde_networks WHERE fde_id')) {
        return { rows: [{ '?column?': 1 }] };
      }
      // F8：对账创建容器时同步 upsert containers 行（含 token hash）
      if (sql.includes('INSERT INTO containers') && sql.includes('ON CONFLICT (fde_name)')) {
        this.containerUpserts.push({ user_id: params[0], fde_name: params[1], token_hash: params[3] });
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        // provisioner 的 SQL 把 action 作为字面量，target/details 为参数（容器/网络两条孤儿路径）。
        const action = sql.includes('network.orphan_removed') ? 'network.orphan_removed' : 'container.orphan_removed';
        this.audit.push({ action, target: params[0] });
        return { rows: [] };
      }
      // 审计 #34 F-B：孤儿容器删除后的 DB 自愈收尾（status → removed）
      if (sql.includes("UPDATE containers c SET status = 'removed'")) {
        this.orphanRemovedRows.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] };
    },
    // 审计 #37：孤儿网络清理现走 withFdeLock(requireLock)——connect 需可用（advisory lock +
    // 锁内重读复用上方 query 分支）；锁内重读的 JOIN 形式 SQL 返回空行 → 判孤儿 → 清理路径照走。
    async connect() {
      return { query: (sql, params) => this.query(sql, params), release() {} };
    },
    async end() {},
  };
  const calls = [];
  const docker = {
    async inspectNetwork(name) {
      calls.push(`inspectNetwork:${name}`);
      return { status: 404, data: null };
    },
    async createNetwork() {
      calls.push('createNetwork');
      return { status: 201, data: { Id: 'nid1' } };
    },
    async inspectContainer(name) {
      calls.push(`inspectContainer:${name}`);
      return { status: 404, data: null };
    },
    async createContainer() {
      calls.push('createContainer');
      return { status: 201, data: { Id: 'cid1' } };
    },
    async startContainer() {
      calls.push('startContainer');
      return { status: 204 };
    },
    async stopContainer(name) {
      calls.push(`stopContainer:${name}`);
      return { status: 204 };
    },
    async removeContainer(name) {
      calls.push(`removeContainer:${name}`);
      return { status: 204 };
    },
    async listContainers() {
      calls.push('listContainers');
      return { status: 200, data: [{ Names: ['/fde-bob'], Id: 'orphan1' }] };
    },
    async listNetworks() {
      calls.push('listNetworks');
      // 审计 #36-1：一个孤儿网络（不在 desired）+ 一个 desired 网络（fde-alice，不得删）
      return {
        status: 200,
        data: [
          { Name: 'fde-bob-net', Id: 'nid-orphan', Labels: { 'station.managed': 'true' } },
          { Name: 'fde-alice', Id: 'nid-desired', Labels: { 'station.managed': 'true' } },
        ],
      };
    },
    async removeNetwork(name) {
      calls.push(`removeNetwork:${name}`);
      return { status: 204 };
    },
  };
  const config = {
    userSpaceRoot: RECONCILE_USER_SPACE_ROOT,
    userSpaceRootHost: '/tmp/erix-users-test',
    fdeUid: SELF_UID,
    fdeGid: SELF_GID,
    fdeImage: 'traefik/whoami',
    fdeCmd: ['-port', '4000'],
    fdeMemoryLimit: '512m',
    fdeAgentVersion: 'dev',
    fdeDevUser: '1001:1000',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
  };
  const stats = await reconcileOnce(pool, config, { docker });
  assert.equal(stats.rebuilt, 1);
  assert.equal(stats.orphansRemoved, 1);
  assert.ok(calls.includes('createContainer'), '重建缺失容器');
  assert.ok(calls.includes('removeContainer:fde-bob'), '删除孤儿容器');
  assert.ok(pool.audit.some((a) => a.action === 'container.orphan_removed' && a.target === 'fde-bob'));
  // 审计 #34 F-B：孤儿清理后 DB 行收敛为 removed（「DB 是状态真相」在删除失败路径上仍成立）
  assert.deepEqual(pool.orphanRemovedRows, ['bob'], '孤儿容器删除后必须把对应 containers 行标 removed');
  // 审计 #36-1：孤儿网络清理 + 审计日志；desired 网络不得被删
  assert.equal(stats.orphanNetworksRemoved, 1, '孤儿网络必须被清理');
  assert.ok(calls.includes('removeNetwork:fde-bob-net'), '孤儿网络被删除');
  assert.ok(!calls.includes('removeNetwork:fde-alice'), 'desired 网络不得被删除');
  assert.ok(pool.audit.some((a) => a.action === 'network.orphan_removed' && a.target === 'fde-bob-net'),
    '孤儿网络清理必须写审计日志');
  // F8：重建时同步 upsert containers 行（含 token hash）
  assert.equal(pool.containerUpserts.length, 1);
  assert.ok(pool.containerUpserts[0].token_hash, 'upsert 含 runner_token_hash');
  assert.equal(pool.containerUpserts[0].fde_name, 'alice');
});

test('DOCKER_ALLOWED_PATHS 白名单表只含 containers/networks 生命周期（不含 exec/images/system）', () => {
  const paths = DOCKER_ALLOWED_PATHS.map((r) => `${r.method} ${r.re.source.replace(/\\\//g, '/')}`);
  assert.ok(paths.some((p) => p.includes('containers/create')));
  assert.ok(paths.some((p) => p.includes('networks/create')));
  assert.ok(!paths.some((p) => p.includes('exec') || p.includes('images') || p.includes('system') || p.includes('volumes')));
});

test('F6：create 成功 + DB update 失败 → 重试重建后容器 env token 与 DB hash 一致', async () => {
  let dbTokenHash = null; // 模拟 containers.runner_token_hash（DB 真相）
  let upsertFailures = 1; // 首次 upsert 抛错（模拟 create 成功后 DB 写失败）
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM users u') && sql.includes('JOIN fde_networks n')) {
        return {
          rows: [{
            user_id: 'u1', fde_name: 'alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1',
            network_name: 'fde-alice', container_id: dbTokenHash ? 'c1' : null,
            container_name: 'fde-alice', container_status: 'running', runner_token_hash: dbTokenHash,
          }],
        };
      }
      if (sql.includes('SELECT 1 FROM fde_networks WHERE fde_id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO containers') && sql.includes('ON CONFLICT (fde_name)')) {
        if (upsertFailures > 0) { upsertFailures -= 1; throw new Error('simulated DB update failure after create'); }
        dbTokenHash = params[3];
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() { throw new Error('no real pool in unit test'); },
    async end() {},
  };

  let containerEnvToken = null;
  const docker = {
    async inspectNetwork() { return { status: 404, data: null }; },
    async createNetwork() { return { status: 201, data: { Id: 'nid' } }; },
    async inspectContainer() {
      if (containerEnvToken === null) return { status: 404, data: null };
      return { status: 200, data: { Id: 'cid', State: { Status: 'running' }, Config: { Env: [`ERIX_STATION_TOKEN=${containerEnvToken}`, 'ERIX_FDE_NAME=alice'] } } };
    },
    async createContainer(body) {
      const line = body.Env.find((e) => e.startsWith('ERIX_STATION_TOKEN='));
      containerEnvToken = line.split('=')[1];
      return { status: 201, data: { Id: 'cid' } };
    },
    async startContainer() { return { status: 204 }; },
    async stopContainer() { return { status: 204 }; },
    async removeContainer() { containerEnvToken = null; return { ok: true, stopped: true, removed: true }; },
    async listContainers() { return { status: 200, data: [] }; },
    async listNetworks() { return { status: 200, data: [] }; },
  };
  const config = {
    userSpaceRoot: RECONCILE_USER_SPACE_ROOT,
    userSpaceRootHost: '/tmp/erix-users-f6',
    fdeUid: SELF_UID, fdeGid: SELF_GID, fdeImage: 'traefik/whoami', fdeCmd: ['-port', '4000'],
    fdeMemoryLimit: '512m', fdeAgentVersion: 'dev', fdeDevUser: '1001:1000',
    baseDomain: 'localhost', llmHost: 'llm.localhost',
  };

  // 第 1 轮：create 成功，但 DB upsert 抛错（token 未入 DB）→ 容器 env 有 token、DB 无 token。
  const s1 = await reconcileOnce(pool, config, { docker });
  assert.equal(s1.rebuilt, 0, '第 1 轮 upsert 失败不应计入 rebuilt（异常被捕获）');
  assert.notEqual(containerEnvToken, null);
  assert.equal(dbTokenHash, null, '模拟 DB 写失败后 runner_token_hash 仍未写入');

  // 第 2 轮：检测到 DB token 缺失/失配 → 重建，upsert 成功 → env token 与 DB hash 一致。
  const s2 = await reconcileOnce(pool, config, { docker });
  assert.equal(s2.rebuilt, 1, '第 2 轮应重建');
  assert.ok(containerEnvToken, '重建后容器有 env token');
  assert.equal(dbTokenHash, hashToken(containerEnvToken), 'DB hash 与容器 env token 一致');
});

test('F7：reconcile 幂等——两轮后第二轮不重建（同一容器）', async () => {
  let dbTokenHash = null;
  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM users u') && sql.includes('JOIN fde_networks n')) {
        return {
          rows: [{
            user_id: 'u1', fde_name: 'alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1',
            network_name: 'fde-alice', container_id: dbTokenHash ? 'c1' : null,
            container_name: 'fde-alice', container_status: 'running', runner_token_hash: dbTokenHash,
          }],
        };
      }
      if (sql.includes('SELECT 1 FROM fde_networks WHERE fde_id')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO containers') && sql.includes('ON CONFLICT (fde_name)')) {
        dbTokenHash = params[3];
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() { throw new Error('no real pool'); },
    async end() {},
  };
  let containerEnvToken = null;
  let createCount = 0;
  const docker = {
    async inspectNetwork() { return { status: 404, data: null }; },
    async createNetwork() { return { status: 201, data: { Id: 'nid' } }; },
    async inspectContainer() {
      if (containerEnvToken === null) return { status: 404, data: null };
      return { status: 200, data: { Id: 'cid', State: { Status: 'running' }, Config: { Env: [`ERIX_STATION_TOKEN=${containerEnvToken}`] } } };
    },
    async createContainer(body) {
      createCount += 1;
      containerEnvToken = body.Env.find((e) => e.startsWith('ERIX_STATION_TOKEN=')).split('=')[1];
      return { status: 201, data: { Id: 'cid' } };
    },
    async startContainer() { return { status: 204 }; },
    async stopContainer() { return { status: 204 }; },
    async removeContainer() { containerEnvToken = null; return { ok: true, stopped: true, removed: true }; },
    async listContainers() { return { status: 200, data: [] }; },
    async listNetworks() { return { status: 200, data: [] }; },
  };
  const config = {
    userSpaceRoot: RECONCILE_USER_SPACE_ROOT, userSpaceRootHost: '/tmp/erix-users-f7',
    fdeUid: SELF_UID, fdeGid: SELF_GID, fdeImage: 'traefik/whoami', fdeCmd: ['-port', '4000'],
    fdeMemoryLimit: '512m', fdeAgentVersion: 'dev', fdeDevUser: '1001:1000',
    baseDomain: 'localhost', llmHost: 'llm.localhost',
  };
  const s1 = await reconcileOnce(pool, config, { docker });
  assert.equal(s1.rebuilt, 1);
  assert.equal(createCount, 1);
  const s2 = await reconcileOnce(pool, config, { docker });
  assert.equal(s2.rebuilt, 0, '第二轮 token 一致 → 不重建');
  assert.equal(createCount, 1, '同一容器，不重复创建');
  assert.equal(dbTokenHash, hashToken(containerEnvToken));
});

test('F11：ensureFdeNetwork inspect 200 但 managed/subnet/gateway 失配 → 报错（不静默采用）', async () => {
  const docker = {
    async inspectNetwork() {
      return { status: 200, data: { Id: 'nid', Labels: {}, IPAM: { Config: [{ Subnet: '10.200.9.0/29', Gateway: '10.200.9.1' }] } } };
    },
  };
  await assert.rejects(
    () => ensureFdeNetwork(docker, { name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' }),
    /mismatches contract/,
  );
});

test('P4：ensureFdeNetwork inspect 200 但 fde.name label 失配 → 报错；409 分支 re-inspect 同样校验', async () => {
  // inspect 200 但 fde.name 不一致
  const dockerBad = {
    async inspectNetwork() {
      return { status: 200, data: { Id: 'nid', Labels: { 'station.managed': 'true', 'fde.name': 'bob' }, IPAM: { Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] } } };
    },
  };
  await assert.rejects(
    () => ensureFdeNetwork(dockerBad, { name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' }),
    /mismatches contract/,
  );

  // 409 后 re-inspect 仍失配 → 报错
  let createCalled = false;
  const docker409 = {
    async inspectNetwork(name) {
      if (!createCalled) return { status: 404, data: null };
      return { status: 200, data: { Id: 'nid2', Labels: { 'station.managed': 'true', 'fde.name': 'bob' }, IPAM: { Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] } } };
    },
    async createNetwork() {
      createCalled = true;
      return { status: 409, data: null };
    },
  };
  await assert.rejects(
    () => ensureFdeNetwork(docker409, { name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' }),
    /mismatches contract/,
  );

  // 409 后 re-inspect 通过 → 视为已存在
  let createCalledOk = false;
  const dockerOk = {
    async inspectNetwork(name) {
      if (name === 'fde-alice' && createCalledOk) {
        return { status: 200, data: { Id: 'nid3', Labels: { 'station.managed': 'true', 'fde.name': 'alice' }, IPAM: { Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] } } };
      }
      return { status: 404, data: null };
    },
    async createNetwork() {
      createCalledOk = true;
      return { status: 409, data: null };
    },
  };
  const r = await ensureFdeNetwork(dockerOk, { name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' });
  assert.equal(r.created, false);
  assert.equal(r.id, 'nid3');
});

test('F9 + 审计 #34 F-B：deprovision 容器删除失败 → 不标 removed，但 token 已吊销 + 网段已释放（安全优先 + 自愈路径）', async () => {
  const calls = [];
  const pool = {
    async query(sql, params = []) {
      calls.push(sql.replace(/\s+/g, ' ').trim());
      if (sql.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM containers WHERE user_id')) return { rows: [{ id: 'c1' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          calls.push(sql.replace(/\s+/g, ' ').trim());
          if (sql.includes('RETURNING revision')) return { rows: [{ revision: 1 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  const docker = {
    async stopContainer() { return { status: 204 }; },
    async removeContainer() { return { status: 500 }; }, // 删除失败
    async removeNetwork() { return { ok: true, removed: true }; },
  };
  await assert.rejects(
    () => deprovisionForTest(pool, {}, { fdeName: 'alice', docker }),
    /container removal failed/,
  );
  // F9（保留）：删除失败不得假装成功
  assert.ok(!calls.some((c) => c.includes("status = 'removed'")), '容器删除失败不得标 removed');
  // F-B（新语义）：安全与「离开 desired」必须前置且已提交
  assert.ok(calls.some((c) => c.includes('UPDATE containers SET revoked_at = now()')),
    'token 必须先于资源删除吊销（否则 DB 写失败窗口内旧 token 仍有效）');
  assert.ok(calls.some((c) => c.includes("UPDATE fde_networks SET state = 'released'")),
    '网段必须同事务释放——否则该 FDE 仍在 reconcile 的 desired 集合，会被重建并清空 revoked_at（复活）');
});

test('审计 #34 F-B：前置事务失败 → 不做任何 Docker 删除（fail-closed，不产生「容器已删但 token 有效」窗口）', async () => {
  const dockerCalls = [];
  const pool = {
    async query(sql) {
      if (sql.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM containers WHERE user_id')) return { rows: [{ id: 'c1' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('UPDATE containers SET revoked_at')) throw new Error('db down');
          if (sql.includes('RETURNING revision')) return { rows: [{ revision: 1 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  const docker = {
    async stopContainer() { dockerCalls.push('stop'); return { status: 204 }; },
    async removeContainer() { dockerCalls.push('remove'); return { status: 204 }; },
    async removeNetwork() { dockerCalls.push('removeNetwork'); return { status: 204 }; },
  };
  await assert.rejects(() => deprovisionForTest(pool, {}, { fdeName: 'alice', docker }), /db down/);
  assert.deepEqual(dockerCalls, [], '吊销事务未提交前不得碰 Docker（否则失败窗口内 token 仍有效而资源已删）');
});

test('issue #22 方案②：deprovision 成功 → revoked_at 落 DB（心跳/claim 的 401 token_revoked 即显式信号）', async () => {
  const sqls = [];
  const containerUpdParams = [];
  // 评审 B：SQL 顺序断言拦不住「把吊销挪到 Docker 删除之后」——把 docker 调用也纳入同一序列。
  const seq = [];
  const noteSeq = (sql) => {
    if (sql.includes('UPDATE containers SET revoked_at')) seq.push('sql:revoke');
    if (sql.includes("UPDATE containers SET status = 'removed'")) seq.push('sql:removed');
  };
  const pool = {
    async query(sql, params = []) {
      sqls.push(sql);
      noteSeq(sql);
      if (sql.includes('UPDATE containers') && sql.includes('WHERE user_id = $1')) containerUpdParams.push(params);
      if (sql.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM containers WHERE user_id')) return { rows: [{ id: 'c1' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          sqls.push(sql);
          noteSeq(sql);
          if (sql.includes('RETURNING revision')) return { rows: [{ revision: 1 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
  const docker = {
    async stopContainer() { return { status: 204 }; },
    async removeContainer() { seq.push('docker:removeContainer'); return { status: 204 }; },
    async removeNetwork() { seq.push('docker:removeNetwork'); return { status: 204 }; },
  };
  await deprovisionForTest(pool, {}, { fdeName: 'alice', docker });
  const revokeUpd = sqls.find((s) => s.includes('UPDATE containers SET revoked_at'));
  const removedUpd = sqls.find((s) => s.includes("UPDATE containers SET status = 'removed'"));
  assert.ok(revokeUpd, '必须先写 revoked_at（跨进程 revoke 信号，issue #22）');
  assert.ok(revokeUpd.includes('WHERE user_id = $1'), '必须按 user_id 限定（防全表 UPDATE）');
  assert.ok(removedUpd, '资源清理成功后必须标 removed');
  assert.ok(removedUpd.includes('WHERE user_id = $1'), '必须按 user_id 限定');
  // 审计 #34 F-B：顺序语义——吊销必须发生在**删除 Docker 资源之前**（把 docker 调用纳入同一序列，
  // 否则「吊销挪到删除之后」这种变异拦不住——评审 B 实测）。
  assert.deepEqual(seq, ['sql:revoke', 'docker:removeContainer', 'docker:removeNetwork', 'sql:removed'],
    '顺序必须是：吊销 → 删容器 → 删网络 → 标 removed');
  assert.deepEqual(containerUpdParams.at(-1), ['u1'], 'user_id 参数必须绑定 $1（评审 F5）');
});


// ---------------------------------------------------------------------------
// issue #33（源自 #22 F6）：offboard = 系统发起的 stop —— 收敛该用户全部 active run，
// 口径对齐 reaper A2（queue cancelled + runs finished/aborted + 合成 run_end）。
// ---------------------------------------------------------------------------
function makeDeprovisionPool({ runRows = [], failOnRunsQuery = false, sqls = [] } = {}) {
  return {
    async query(sql) {
      sqls.push(sql);
      if (sql.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM containers WHERE user_id')) return { rows: [{ id: 'c1' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql) {
          sqls.push(sql);
          if (sql.includes('FROM runs r') && sql.includes('JOIN run_queue')) {
            if (failOnRunsQuery) throw new Error('runs query exploded');
            return { rows: runRows };
          }
          if (sql.includes('RETURNING revision')) return { rows: [{ revision: 1 }] };
          if (sql.includes('RETURNING last_seq')) return { rows: [{ last_seq: 7 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
}
const DEPROVISION_DOCKER_OK = {
  async stopContainer() { return { status: 204 }; },
  async removeContainer() { return { status: 204 }; },
  async removeNetwork() { return { status: 204 }; },
};

test('issue #33：deprovision 收敛 active run（queue cancelled + runs finished/aborted + 合成 run_end）+ 推 SSE', async () => {
  const sqls = [];
  const notified = [];
  const home = path.join(DEPROVISION_USER_SPACE_ROOT, 'alice', 'home');
  fs.mkdirSync(home, { recursive: true });
  const credentialFile = path.join(home, '.git-credentials');
  fs.writeFileSync(credentialFile, 'https://x-access-token:secret@github.com\n', { mode: 0o640 });
  const pool = makeDeprovisionPool({ runRows: [{ id: 'run-1', session_id: 'sess-1', attempts: 2 }], sqls });
  await deprovisionForTest(pool, { userSpaceRoot: DEPROVISION_USER_SPACE_ROOT }, {
    fdeName: 'alice', docker: DEPROVISION_DOCKER_OK,
    notify: (sid, evts) => notified.push({ sid, evts }),
  });
  assert.equal(fs.existsSync(credentialFile), false, 'offboarding 必须删除 FDE HOME 中的 git 凭据文件');
  const joined = sqls.join('\n');
  assert.ok(/UPDATE run_queue SET status='cancelled'/.test(joined), 'queue 必须置 cancelled（对齐 reaper A2）');
  assert.ok(/UPDATE runs SET status='finished'/.test(joined), 'run 必须置 finished');
  assert.ok(joined.includes('"reason":"aborted"'), 'termination.reason 必须为 aborted（与 reaper A2 一致）');
  assert.ok(sqls.some((q) => q.includes("'run_end'")), '必须合成 run_end 事件');
  assert.deepEqual(
    notified.map((n) => [n.sid, n.evts[0].type, n.evts[0].seq, n.evts[0].payload.termination.reason]),
    [['sess-1', 'run_end', 7, 'aborted']],
    'run_end 必须以 §7.3 分配的 seq 推给 SSE',
  );
});

test('issue #33：run 收敛失败不回滚 offboard（best-effort：token 仍吊销、资源仍删除）', async () => {
  const sqls = [];
  const dockerCalls = [];
  const pool = makeDeprovisionPool({ failOnRunsQuery: true, sqls });
  const docker = {
    async stopContainer() { dockerCalls.push('stop'); return { status: 204 }; },
    async removeContainer() { dockerCalls.push('remove'); return { status: 204 }; },
    async removeNetwork() { dockerCalls.push('removeNetwork'); return { status: 204 }; },
  };
  const out = await deprovisionForTest(pool, {}, { fdeName: 'alice', docker, log: { warn() {} } });
  assert.equal(out.containerName, 'fde-alice', 'offboard 必须成功返回（收敛失败不阻断）');
  assert.ok(sqls.some((q) => q.includes('UPDATE containers SET revoked_at = now()')), 'token 仍必须吊销（安全优先）');
  assert.deepEqual(dockerCalls, ['stop', 'remove', 'removeNetwork'], '资源清理必须照常执行');
});

test('offboarding 凭据路径不安全时拒绝标记 removed，避免误删用户空间外文件', async () => {
  const home = path.join(DEPROVISION_USER_SPACE_ROOT, 'alice', 'home');
  fs.rmSync(path.join(DEPROVISION_USER_SPACE_ROOT, 'alice'), { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const outside = path.join(DEPROVISION_USER_SPACE_ROOT, 'outside-credential');
  fs.writeFileSync(outside, 'https://x-access-token:secret@github.com\n');
  fs.symlinkSync(outside, path.join(home, '.git-credentials'));
  const sqls = [];
  const pool = makeDeprovisionPool({ sqls });

  await assert.rejects(
    deprovisionForTest(pool, { userSpaceRoot: DEPROVISION_USER_SPACE_ROOT }, {
      fdeName: 'alice', docker: DEPROVISION_DOCKER_OK, log: { warn() {} },
    }),
    /git credential file removal failed/,
  );
  assert.equal(fs.readFileSync(outside, 'utf8'), 'https://x-access-token:secret@github.com\n');
  assert.ok(!sqls.some((sql) => sql.includes("UPDATE containers SET status='removed'")),
    '路径清理失败不得把 offboarding 标成完成');
});

// ---------------------------------------------------------------------------
// issue #22 评审 F1（blocker 回归锚点）：revoked_at 必须有「清」路径。
// deprovision 写 revoked_at=now() 后，同一 containers 行被重新 provision 复用时
// （upsertContainerRow 的 DO UPDATE / onboardFde 的 token 轮换 UPDATE）必须重置 revoked_at=NULL，
// 否则新容器 agentd 永久 401 token_revoked（DOA）。
// 说明：onboardFde 全链 docker/pool fake 成本高，此处以源码契约锚点断言（评审 F1 修复的两条
// UPDATE）防回归；端到端语义由 db-integration/探针覆盖。
// ---------------------------------------------------------------------------
test('issue #22 评审 F1：重新 provision 的两条 UPDATE 必须重置 revoked_at = NULL', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/provisioner.js', import.meta.url), 'utf8'));
  // SQL 模板串（反引号内）为块：含 token_generation 递增的块 = token 轮换 UPDATE
  const blocks = src.split('`').filter((b) => b.includes('token_generation') && (b.includes('DO UPDATE SET') || b.includes('UPDATE containers')));
  assert.ok(blocks.length >= 2, `应有 ≥2 处 token 轮换 UPDATE（upsert DO UPDATE + onboard 轮换），实际 ${blocks.length}`);
  for (const b of blocks) {
    assert.ok(b.includes('revoked_at = NULL'), `token 轮换 UPDATE 必须重置 revoked_at：\n${b}`);
  }
});

// ---------------------------------------------------------------------------
// issue #38 Phase B1：LLM 配置 offboard/onboard 联动。
// 评审重点：LLM 吊销必须与 containers/token 吊销**同一事务**（revokeFdeLlmConfigTx 只吃调用方
// 事务的 client）——seq 断言把 outbox 写入也纳入同一序列，防「挪到事务外/挪到 Docker 删除后」变异。
// ---------------------------------------------------------------------------

function makeB1Pool({ llmRowCount = 1, seq, paramsLog }) {
  return {
    async query(sql) {
      if (sql.includes('FROM users WHERE fde_name')) return { rows: [{ id: 'u1', fde_name: 'alice' }] };
      if (sql.includes('FROM containers WHERE user_id')) return { rows: [{ id: 'c1' }] };
      return { rows: [] };
    },
    async connect() {
      return {
        async query(sql, params = []) {
          paramsLog.push({ sql, params });
          if (sql === 'BEGIN') seq.push('tx:begin');
          if (sql === 'COMMIT') seq.push('tx:commit');
          if (sql.includes('SELECT api_key, key_alias, gateway FROM fde_llm_bindings')) {
            return {
              rows: llmRowCount > 0
                ? [{ api_key: 'sk-test-retired', key_alias: 'fde-alice', gateway: 'direct' }]
                : [],
            };
          }
          if (sql.includes('UPDATE containers SET revoked_at')) seq.push('sql:revoke-token');
          if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET state = 'revoked'")) {
            seq.push(llmRowCount > 0 ? 'sql:revoke-llm' : 'sql:revoke-llm-noop');
          }
          if (sql.includes('INSERT INTO route_outbox')) seq.push(`sql:outbox:${params[0]}:${params[2]}`);
          if (sql.includes('UPDATE fde_llm_bindings')) return { rows: [], rowCount: llmRowCount };
          if (sql.includes('RETURNING revision')) return { rows: [{ revision: 1 }] };
          return { rows: [] };
        },
        release() {},
      };
    },
    async end() {},
  };
}

function makeB1Docker(seq) {
  return {
    async stopContainer() { seq.push('docker:stop'); return { status: 204 }; },
    async removeContainer() { seq.push('docker:rm'); return { status: 204 }; },
    async removeNetwork() { seq.push('docker:rmnet'); return { status: 204 }; },
  };
}

test('issue #38 Phase B1：deprovision 前置事务内吊销 LLM（state=revoked + outbox delete，与 token 吊销同事务、先于 Docker）', async () => {
  const seq = [];
  const paramsLog = [];
  const pool = makeB1Pool({ llmRowCount: 1, seq, paramsLog });
  await deprovisionForTest(pool, {}, { fdeName: 'alice', docker: makeB1Docker(seq) });

  assert.deepEqual(
    seq,
    [
      // ① 前置事务（原子）：token 吊销 → 网段释放 → LLM 吊销 + 双 outbox tombstone
      'tx:begin', 'sql:revoke-token',
      'sql:outbox:fde_network:delete', 'sql:revoke-llm', 'sql:outbox:llm_binding:delete',
      'tx:commit',
      // ①b terminateActiveRuns 事务 A（无 active run → 立即提交的空事务）
      'tx:begin', 'tx:commit',
      // ② Docker 资源删除
      'docker:stop', 'docker:rm', 'docker:rmnet',
    ],
    'LLM 吊销必须发生在吊销事务（BEGIN..COMMIT）内、且在一切 Docker 操作之前',
  );

  const llmIns = paramsLog.find((e) => e.sql.includes('INSERT INTO route_outbox') && e.params[0] === 'llm_binding');
  assert.ok(llmIns, '必须写 aggregate=llm_binding 的 tombstone');
  assert.equal(llmIns.params[1], 'u1', 'aggregate_id = fde id');
  assert.equal(llmIns.params[2], 'delete');
  const payloadStr = JSON.stringify(llmIns.params[4]);
  assert.ok(payloadStr.includes('alice'), 'payload 带 fde_name 供 reconciler 收敛');
  assert.ok(!payloadStr.includes('sk-test'), 'payload 不得含 api_key 明文（红线 ③）');
});

test('issue #117：无 LLM binding 的 FDE deprovision skips the update/outbox and still cleans Docker', async () => {
  const seq = [];
  const paramsLog = [];
  const pool = makeB1Pool({ llmRowCount: 0, seq, paramsLog });
  await deprovisionForTest(pool, {}, { fdeName: 'alice', docker: makeB1Docker(seq) });
  assert.ok(!seq.includes('sql:revoke-llm'), '无 active binding 不得产生实际吊销');
  assert.ok(!seq.includes('sql:revoke-llm-noop'), 'missing active binding skips the UPDATE');
  assert.ok(!seq.some((s) => s.includes('outbox:llm_binding')), '无 active binding 不得写 llm outbox');
  assert.ok(seq.includes('sql:revoke-token') && seq.includes('docker:rm'), 'token 吊销与 Docker 清理照常');
});

test('issue #38 Phase B1：provision 按容器复用状态同步 LLM + deprovision 吊销在事务块内', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/provisioner.js', import.meta.url), 'utf8'));
  // onboardFde：LLM 联动必须挂在容器就绪之后，且 restoreRevoked 与复用判定（needRecreate）绑定。
  // F1（Round B 评审）：参数名必须叫 fdeId 且值必须是该 FDE 的 id（userId = users.id =
  // fde_llm_bindings.fde_id）——传 userId 键会被 llm.js 的解构静默丢弃 → fde_id=NULL → 无行命中，
  // 恢复/重发布静默 no-op（曾因此复用容器时 revoked binding 不恢复）。
  const onboardCall = 'syncFdeLlmBindingOnOnboard(pool, { fdeId: userId, fdeName, restoreRevoked: !needRecreate })';
  assert.ok(src.includes(onboardCall), `onboardFde 必须调用 LLM 恢复联动且参数名为 fdeId：${onboardCall}`);
  assert.ok(!src.includes('skipLlmSync'), 'onboardFde 不得跳过 LLM sync：容器重建时 active route 必须重新发布');
  assert.ok(src.indexOf(onboardCall) > src.indexOf('const res = await ensureFdeContainer('),
    'LLM 路由发布必须等容器与 FDE 网络就绪');
  // 跨模块契约锚点：llm.js 侧按 { fdeId, ... } 解构——两侧参数名漂移会被此断言拦截。
  const llmSrc = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/llm.js', import.meta.url), 'utf8'));
  assert.ok(
    llmSrc.includes('syncFdeLlmBindingOnOnboard(pool, { fdeId, fdeName, restoreRevoked = false, gateway } = {})'),
    'llm.js 的 syncFdeLlmBindingOnOnboard 必须按 fdeId 解构（与 provisioner 调用点参数名一致）',
  );
  // deprovisionFde：① 前置事务块内、COMMIT 之前必须调 revokeFdeLlmConfigTx（同事务是评审重点）。
  const txStart = src.indexOf('① 前置事务');
  const commitIdx = src.indexOf("await client.query('COMMIT')", txStart);
  const revokeIdx = src.indexOf('revokeFdeLlmConfigTx(client, { fdeId: u.id, fdeName })', txStart);
  assert.ok(txStart > 0 && revokeIdx > txStart && revokeIdx < commitIdx,
    'LLM 吊销必须位于 ① 前置事务块内、COMMIT 之前（不得挪到独立连接/独立事务）');
});

// ---------------------------------------------------------------------------
// F1（Round B 评审）：走真实函数链路验证 onboard 联动的参数语义——
// syncFdeLlmBindingOnOnboard 收到的 fdeId 必须命中 fde_llm_bindings.fde_id（WHERE fde_id = $1），
// 否则 revoked → active 恢复与 outbox upsert 静默 no-op（fake pool 真按 params 过滤行）。
// ---------------------------------------------------------------------------
test('F1（Round B 评审）：syncFdeLlmBindingOnOnboard（真实函数）restoreRevoked=true → revoked→active + outbox upsert 命中该 FDE 的 id', async () => {
  const seq = [];
  const paramsLog = [];
  const state = {
    u1: {
      state: 'revoked', provider_id: 'deepseek', api_key: null, key_id: null, key_alias: null,
      gateway: 'litellm', gateway_user_id: null, main_model_id: 'deepseek-flash',
      embedding_model_id: null, vision_model_id: null, revokeParams: null,
    },
  }; // 内存态：binding 行按 fde_id 索引
  const gateway = {
    async listModels() {
      return { data: [{
        model_name: 'deepseek-flash',
        litellm_params: { model: 'deepseek-flash', litellm_credential_name: 'deepseek' },
        model_info: { id: 'deepseek-flash', type: 'text', tool_calling: true },
      }] };
    },
    async createUser() { return { user_id: 'gateway-user-alice' }; },
    async generateKey(body) { return { key: 'sk-test-onboard-virtual', key_id: 'key-onboard', key_alias: body.key_alias }; },
    async deleteKey() { return { deleted: true }; },
  };
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          paramsLog.push({ sql, params });
          if (sql === 'BEGIN') seq.push('tx:begin');
          if (sql === 'COMMIT') seq.push('tx:commit');
          if (sql.includes('SELECT state, provider_id, api_key, key_id, key_alias, gateway, gateway_user_id')) {
            const row = state[params[0]];
            return { rows: row ? [{ ...row }] : [] };
          }
          if (sql.includes('UPDATE fde_llm_bindings') && sql.includes("SET gateway = 'litellm'")) {
            const row = state[params[0]];
            if (!row) return { rows: [], rowCount: 0 };
            row.state = 'active';
            row.revokeParams = params;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO route_revisions')) {
            seq.push(`rev:${params[0]}:${params[1]}`);
            return { rows: [{ revision: 7 }] };
          }
          if (sql.includes('INSERT INTO route_outbox')) {
            seq.push(`outbox:${params[0]}:${params[2]}`);
            return { rows: [] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };

  // 等价于 onboardFde 复用分支的调用（provisioner 侧参数名修复后即此形状）：
  const out = await syncFdeLlmBindingOnOnboard(pool, { fdeId: 'u1', fdeName: 'alice', restoreRevoked: true, gateway });
  assert.deepEqual(out, { restored: true, republished: true }, 'revoked binding 必须被恢复且重发布 outbox');

  // 命中的是「该 FDE 的 id」：所有 WHERE/SET fde_id = $1 的参数都是 u1（若为 NULL 则无行命中 → 静默 no-op）。
  const hit = paramsLog.find((e) => e.sql.includes('SELECT state, provider_id, api_key, key_id, key_alias, gateway, gateway_user_id'));
  assert.equal(hit.params[0], 'u1', 'FOR UPDATE 锁行参数必须是该 FDE 的 id');
  assert.equal(state.u1.state, 'active', 'revoked → active 已发生');
  assert.equal(state.u1.revokeParams[0], 'u1', 'UPDATE fde_id = 该 FDE 的 id');

  assert.deepEqual(seq, ['tx:begin', 'rev:llm_binding:u1', 'outbox:llm_binding:upsert', 'tx:commit'],
    '事务内顺序：BEGIN → revision head → outbox upsert → COMMIT');
  const outbox = paramsLog.find((e) => e.sql.includes('INSERT INTO route_outbox'));
  assert.equal(outbox.params[0], 'llm_binding');
  assert.equal(outbox.params[1], 'u1', 'outbox aggregate_id = 该 FDE 的 id（revision head 同键）');
  assert.equal(outbox.params[2], 'upsert');
  assert.ok(outbox.params[4].includes('alice') && outbox.params[4].includes('"restored":true'), 'payload 带 fde_name + restored 标记');
});

test('F1（Round B 评审）：传错参数名（userId 键）→ 真实函数静默 no-op（回归锚点：bug 形态演示）', async () => {
  // 若调用点退回传 { userId }，解构得到 fdeId=undefined → WHERE fde_id = NULL 无行命中，
  // 返回 {restored:false, republished:false} 且不发任何 UPDATE/outbox——本用例把该失效形态钉死。
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql.includes('SELECT state FROM fde_llm_bindings WHERE fde_id = $1 FOR UPDATE')) {
            return { rows: [] }; // fde_id=NULL 永不命中
          }
          if (sql.includes('INSERT INTO route_outbox')) {
            assert.fail('静默 no-op 形态不得写 outbox');
          }
          if (sql.includes('UPDATE fde_llm_bindings')) {
            assert.fail('静默 no-op 形态不得发 UPDATE');
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const out = await syncFdeLlmBindingOnOnboard(pool, { userId: 'u1', fdeName: 'alice', restoreRevoked: true });
  assert.deepEqual(out, { restored: false, republished: false });
});

// F9：栈所有权标签（station.stack）——并行隔离栈的 reconcile 互删对方 FDE 是真回归根因
// （wp3b-e2e 隔离栈实测：两套 portal 的 orphan 清扫互删）。本组断言过滤语义：
//  labels['station.stack'] ?? 'default' === stackId 才清理；异栈/跨栈（无标签且非 default 栈）一律跳过。
function makeOrphanPool() {
  const state = { audit: [], orphanRemovedRows: [] };
  return {
    state,
    async query(sql, params) {
      if (sql.includes('orphan_removed')) {
        state.audit.push({ action: sql.includes('network.') ? 'network.orphan_removed' : 'container.orphan_removed', target: params[0] });
        return { rows: [] };
      }
      if (sql.includes('UPDATE containers c SET status')) {
        state.orphanRemovedRows.push(params[0]);
        return { rows: [] };
      }
      return { rows: [] }; // readFdeDesired / 锁内重读 → 空 = 全部判孤儿
    },
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
    async end() {},
  };
}

function makeStackFilterDocker({ containers, networks }) {
  const removed = { containers: [], networks: [] };
  return {
    removed,
    async listContainers() {
      return { status: 200, data: containers };
    },
    async listNetworks() {
      return { status: 200, data: networks };
    },
    async stopContainer() { return { status: 204 }; },
    async removeContainer(name) { removed.containers.push(name); return { status: 204 }; },
    async removeNetwork(name) { removed.networks.push(name); return { status: 204 }; },
  };
}

test('F9：create body 打 station.stack 所有权标签（缺省 default）', () => {
  const base = {
    fdeName: 'alice',
    containerName: 'fde-alice',
    image: 'img',
    cmd: ['x'],
    networkName: 'fde-alice',
    ip: '10.0.0.2',
    gateway: '10.0.0.1',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
    portalPublicBaseUrl: 'http://station.localhost:8090',
    userSpaceRoot: '/tmp/erix-users',
  };
  const c = buildContainerConfig(base);
  assert.equal(c.Labels['station.stack'], 'default', '容器标签缺省 default');
  assert.equal(buildContainerConfig({ ...base, stackId: 'station-e2e-43' }).Labels['station.stack'], 'station-e2e-43');
  assert.equal(
    buildNetworkConfig({ name: 'fde-x', subnet: '10.0.0.0/24', gateway: '10.0.0.1', fdeName: 'x', stackId: 's1' }).Labels['station.stack'],
    's1',
    '网络标签跟随 stackId',
  );
});

test('F9：default 栈 orphan 清扫——无标签=本栈资产（删）、异栈标签跳过、显式 default 删', async () => {
  const pool = makeOrphanPool();
  const docker = makeStackFilterDocker({
    containers: [
      { Names: ['/fde-old'], Id: 'c1' }, // 无标签 → 视为 default → 删
      { Names: ['/fde-other'], Id: 'c2', Labels: { 'station.managed': 'true', 'fde.name': 'other', 'station.stack': 'other' } },
      { Names: ['/fde-exp'], Id: 'c3', Labels: { 'station.stack': 'exp' } }, // 异栈标签 → 不删
      { Names: ['/fde-explicit'], Id: 'c4', Labels: { 'station.stack': 'default' } }, // 显式 default → 删
    ],
    networks: [
      { Name: 'fde-old-net', Id: 'n1', Labels: { 'station.managed': 'true' } }, // 有 managed、无 station.stack → default → 删
      { Name: 'fde-other-net', Id: 'n2', Labels: { 'station.managed': 'true', 'station.stack': 'other' } }, // 异栈 → 不删
    ],
  });
  const stats = await reconcileOnce(pool, {}, { docker }); // config 无 stackId → default
  assert.deepEqual(docker.removed.containers.sort(), ['fde-explicit', 'fde-old'], '只删本栈（default）孤儿容器');
  assert.deepEqual(docker.removed.networks, ['fde-old-net'], '只删本栈孤儿网络');
  assert.equal(stats.orphansRemoved, 2);
  assert.equal(stats.orphanNetworksRemoved, 1);
  assert.ok(pool.state.audit.some((a) => a.action === 'container.orphan_removed' && a.target === 'fde-old'));
});

test('F9：隔离栈（stackId=station-e2e-43）只清本栈——无标签与 default 标签资产均跳过', async () => {
  const pool = makeOrphanPool();
  const docker = makeStackFilterDocker({
    containers: [
      { Names: ['/fde-alice43'], Id: 'c1', Labels: { 'station.managed': 'true', 'fde.name': 'alice43', 'station.stack': 'station-e2e-43' } },
      { Names: ['/fde-eric'], Id: 'c2', Labels: { 'station.managed': 'true', 'fde.name': 'eric' } }, // 共享栈无标签资产 → 不删
      { Names: ['/fde-reviewer'], Id: 'c3', Labels: { 'station.managed': 'true', 'fde.name': 'reviewer', 'station.stack': 'default' } }, // 显式 default → 不删
    ],
    networks: [
      { Name: 'fde-alice43', Id: 'n1', Labels: { 'station.managed': 'true', 'station.stack': 'station-e2e-43' } },
      { Name: 'fde-eric', Id: 'n2', Labels: { 'station.managed': 'true' } }, // 共享栈网络 → 不删
    ],
  });
  const stats = await reconcileOnce(pool, { stackId: 'station-e2e-43' }, { docker });
  assert.deepEqual(docker.removed.containers, ['fde-alice43'], '隔离栈只删本栈容器，不碰共享 fde-eric/fde-reviewer');
  assert.deepEqual(docker.removed.networks, ['fde-alice43']);
  assert.equal(stats.orphansRemoved, 1);
  assert.equal(stats.orphanNetworksRemoved, 1);
});

// ---------------------------------------------------------------------------
// issue #185：readFdeDesired 的「活」状态口径——awaiting_credential 必须留在期望集内（否则删/换 git
// 凭据把状态翻成 awaiting_credential 时，既有容器被判 orphan 删除重建，正在跑的 run 被杀）；
// disabled 仍必须排除（offboarding 后容器应被清）。与 #183 的 materializer 用例同手法：允许集合从 SQL
// 里解析，同时锁住「行为」与「SQL 契约」——一旦退回 `status = 'active'`，awaiting_credential 用例即失败。
// ---------------------------------------------------------------------------
const FDE185_TOKEN = 'tok-185-existing';

function statusFilterPool185({ userStatus }) {
  // 该 FDE 的网段是否仍分配：disabled = offboarding 已释放（与用户状态无关的独立事实）。
  const networkAllocated = userStatus !== 'disabled';
  const allowedStatuses = (sql) => (sql.includes("'awaiting_credential'") ? ['active', 'awaiting_credential'] : ['active']);
  const state = { audit: [], orphanRemovedRows: [], desiredSql: null };
  const query = async (sql, params = []) => {
    // readFdeDesired（FROM users u … JOIN fde_networks n）——按 SQL 里的状态集合过滤用户。
    if (sql.includes('FROM users u') && sql.includes('JOIN fde_networks n')) {
      state.desiredSql = sql;
      if (!allowedStatuses(sql).includes(userStatus)) return { rows: [] };
      return {
        rows: [{
          user_id: 'u1', fde_name: 'alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1',
          network_name: 'fde-alice', container_id: 'cid-existing', container_name: 'fde-alice',
          container_status: 'running', runner_token_hash: hashToken(FDE185_TOKEN),
        }],
      };
    }
    // reconcile 锁内重确认（SELECT 1 FROM fde_networks WHERE fde_id …）——只看网段是否仍分配，不看 status。
    if (sql.includes('SELECT 1 FROM fde_networks WHERE fde_id')) return { rows: networkAllocated ? [{ '?column?': 1 }] : [] };
    // 孤儿网络锁内重读（JOIN users u，按 fde_name + n.state）——同样不看 users.status。
    if (sql.includes('FROM fde_networks n') && sql.includes('JOIN users u')) return { rows: networkAllocated ? [{ '?column?': 1 }] : [] };
    if (sql.includes('orphan_removed')) {
      state.audit.push({ action: sql.includes('network.') ? 'network.orphan_removed' : 'container.orphan_removed', target: params[0] });
      return { rows: [] };
    }
    if (sql.includes('UPDATE containers c SET status')) {
      state.orphanRemovedRows.push(params[0]);
      return { rows: [] };
    }
    return { rows: [] };
  };
  return {
    state,
    query,
    async connect() { return { query: (s, p) => query(s, p), release() {} }; },
    async end() {},
  };
}

function make185Docker() {
  const removed = { containers: [], networks: [] };
  return {
    removed,
    async inspectContainer() {
      // 既有容器：running + env token 与 DB hash 一致 → 对账不应重建（正对应「凭据轮换不该换容器 id」）。
      return { status: 200, data: { Id: 'cid-existing', State: { Status: 'running' }, Config: { Env: [`ERIX_STATION_TOKEN=${FDE185_TOKEN}`] } } };
    },
    async inspectNetwork() {
      // 既有网络：契约一致（managed + fde.name + subnet/gateway）→ 不重建。
      return {
        status: 200,
        data: {
          Id: 'nid-existing',
          Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
          IPAM: { Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] },
        },
      };
    },
    async startContainer() { return { status: 304 }; },
    async stopContainer() { return { status: 204 }; },
    async removeContainer(name) { removed.containers.push(name); return { status: 204 }; },
    async listContainers() {
      return { status: 200, data: [{ Names: ['/fde-alice'], Id: 'cid-existing', Labels: { 'station.managed': 'true', 'fde.name': 'alice' } }] };
    },
    async listNetworks() {
      return { status: 200, data: [{ Name: 'fde-alice', Id: 'nid-existing', Labels: { 'station.managed': 'true' } }] };
    },
    async removeNetwork(name) { removed.networks.push(name); return { status: 204 }; },
  };
}

const CONFIG185 = (root) => ({
  userSpaceRoot: root,
  fdeUid: SELF_UID,
  fdeGid: SELF_GID,
  fdeImage: 'img',
  fdeAgentVersion: 'dev',
  baseDomain: 'localhost',
  llmHost: 'llm.localhost',
});

test('issue #185：awaiting_credential 的 FDE 仍在 desired → 既有容器/网络不被判 orphan（删/换凭据不拆容器）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-prov-185-'));
  try {
    const pool = statusFilterPool185({ userStatus: 'awaiting_credential' });
    const docker = make185Docker();
    const stats = await reconcileOnce(pool, CONFIG185(root), { docker });
    assert.match(pool.state.desiredSql, /u\.status IN \('active', 'awaiting_credential'\)/,
      'readFdeDesired 必须把 awaiting_credential 当「活」状态');
    assert.equal(stats.ensured, 1, 'awaiting_credential 的 FDE 仍须被纳入对账');
    assert.equal(stats.orphansRemoved, 0, 'awaiting_credential 的容器不得被当孤儿删除');
    assert.equal(stats.rebuilt, 0, '凭据待补不应触发容器重建');
    assert.deepEqual(docker.removed.containers, [], '容器不得被删除/重建（容器 id 必须保持不变）');
    assert.deepEqual(docker.removed.networks, [], 'desired 网络不得被删');
    assert.equal(stats.orphanNetworksRemoved, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('issue #185 回归：disabled 的 FDE 仍在 desired 之外 → 容器/网络照常被清（offboarding 后）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'station-prov-185-'));
  try {
    const pool = statusFilterPool185({ userStatus: 'disabled' });
    const docker = make185Docker();
    const stats = await reconcileOnce(pool, CONFIG185(root), { docker });
    assert.equal(stats.ensured, 0, 'disabled 不得进入期望集');
    assert.equal(stats.orphansRemoved, 1, 'disabled 的容器必须仍被清理');
    assert.deepEqual(docker.removed.containers, ['fde-alice']);
    assert.equal(stats.orphanNetworksRemoved, 1);
    assert.deepEqual(docker.removed.networks, ['fde-alice']);
    assert.deepEqual(pool.state.orphanRemovedRows, ['alice']);
    assert.ok(pool.state.audit.some((a) => a.action === 'container.orphan_removed' && a.target === 'fde-alice'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// issue #404：`containers.image` 必须跟上现实，而不是停在开户那一刻。
// 现网实测：容器已是 v0.1.38 的 digest，库里 `image` 还写着 v0.1.37 的；`agent_version` 停在
// `0.1.32-088e41e`。后果是「这个 FDE 到底在跑哪个 runner」这个问题在 DB 里问不出答案——
// 我这两天的部署核对全是人肉 `docker inspect` 对出来的。
// 病根是写面的形状：`image` 只出现在「DB 没有行」那条 INSERT 上，其余路径（复用 / 重建 / reconcile
// adopt）一律不写 ⇒ 一次开户定终身。下面三条分别钉住三条写路径 + 一个 409 幂等。
// onboardFde 全链 fake 成本高的口径沿用本文件既有做法（源码契约锚点）；`ensureFdeContainer`
// 是纯 docker 交互，直接真跑。
// ---------------------------------------------------------------------------
test('#404 ensureFdeContainer：adopt 时 start 撞 409 当幂等成功（Docker 说"它已经在跑了"）', async () => {
  const calls = [];
  const docker = {
    async inspectContainer() {
      calls.push('inspect');
      return {
        status: 200,
        data: {
          Id: 'ctr-actual',
          State: { Status: 'created' }, // inspect 说不在线 → 会去 start，而并发的另一方已经把它起来了
          Config: { Env: ['ERIX_STATION_TOKEN=tok-x'], Image: 'ghcr.io/x/fde@sha256:newdigest' },
        },
      };
    },
    async startContainer() { calls.push('start'); return { status: 409, data: { message: 'container already started' } }; },
  };
  const res = await ensureFdeContainer(docker, { containerName: 'fde-a', fdeName: 'a', image: 'img:desired' }, { log: { log() {}, warn() {} } });
  assert.deepEqual(calls, ['inspect', 'start'], '必须先查后起（409 是并发窗口的产物，不是可跳过的步骤）');
  assert.equal(res.created, false);
  assert.equal(res.started, false, '409 = 它本来就在跑，不是我们启动的 ⇒ 不许谎报 started=true');
  assert.equal(res.image, 'ghcr.io/x/fde@sha256:newdigest', 'adopt 必须把**实际**镜像带回调用方，账才写得对');
});

test('#404 ensureFdeContainer：新建路径也回报实际镜像（created/adopt 同一条写账写法）', async () => {
  let last;
  const docker = {
    async inspectContainer() { return { status: 404, data: null }; },
    async createContainer(body) { last = body; return { status: 201, data: { Id: 'ctr-new' } }; },
    async startContainer() { return { status: 204 }; },
  };
  const res = await ensureFdeContainer(docker, {
    fdeName: 'b',
    containerName: 'fde-b',
    image: 'img:desired',
    cmd: ['-port', '4000'],
    networkName: 'fde-b',
    ip: '10.200.1.2',
    gateway: '10.200.1.1',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
    userSpaceRoot: '/srv/erix/users',
  }, { log: { log() {}, warn() {} } });
  assert.equal(res.created, true);
  assert.equal(res.image, last.Image, '新建路径的实际镜像 = 传进 create body 的那个引用');
  assert.equal(res.image, 'img:desired');
});

test('#404 写面：三条容器写路径都必须更新 image（复用写实际、重建/reconcile 跟随实际）', async () => {
  const src = await import('node:fs').then((fs) => fs.promises.readFile(
    new URL('../src/provisioner.js', import.meta.url), 'utf8'));
  const blocks = src.split('`').map((b) => b.replace(/\s+/g, ' ').trim());

  // ① onboardFde 复用路径：写 `Config.Image`（实际值）。这一条是病根本体——此前这里一个 image 都不写。
  const reuse = blocks.filter((b) => b.includes('UPDATE containers SET image = COALESCE($2, image)'));
  assert.ok(reuse.length >= 1, 'onboardFde 复用路径必须写 image（否则换镜像后库里永远是开户那一刻的值）');
  const reuseWithActual = src.includes('existing.data?.Config?.Image');
  assert.ok(reuseWithActual, '复用路径必须写**容器实际**镜像（写期望值在 adopt 场景里可能是假话）');

  // ② onboardFde 重建路径：token 轮换那条 UPDATE 必须同时带 image（它紧接着就是 create(config.fdeImage)）。
  const rotate = blocks.filter((b) => b.includes('UPDATE containers SET runner_token_hash') && b.includes('token_generation'));
  assert.ok(rotate.length >= 1);
  assert.ok(rotate.some((b) => b.includes('image = COALESCE($3, image)')),
    '重建路径的 token 轮换 UPDATE 必须同时更新 image：#404 的账实不一致就是从"这条只动 token"来的');
  assert.ok(rotate.every((b) => b.includes('revoked_at = NULL')), '不得回退 #22 F1（复用时必须清吊销）');

  // ③ reconcile adopt 分支：不能只在 created / started 时写，未创建的 adopt 也要跟实际对齐。
  const adopt = blocks.filter((b) => b.includes('UPDATE containers SET image = COALESCE($2, image)') && b.includes('user_id = $1'));
  assert.ok(adopt.length >= 1, 'reconcile 的 adopt 分支必须写实际镜像（res.image）');
  assert.ok(src.includes('res.image ?? null'), 'reconcile 必须用 ensureFdeContainer 带回的 res.image，而不是自己猜期望值');
});

// ---------------------------------------------------------------------------
// issue #404 结案：`FDE_AGENT_VERSION` 从"版本的来源"降级成"显式 override"。
// 版本的真相在镜像里（build-info.json，见 runner/lib/build-info.js 与 runner/Dockerfile）。
// 判据钉三种情形：不设 ⇒ 不注入（容器自己读构建产物）；设成 'dev'（docs/env.md 的开发期占位）
// ⇒ **仍不注入**（占位冒充上报值正是本次要清除的形状）；显式钉一个真值 ⇒ 注入覆盖。
// ---------------------------------------------------------------------------
test('#404 FDE_AGENT_VERSION 只是 override：默认不注入、dev 占位不注入、钉值才注入', async () => {
  const base = {
    fdeName: 'alice',
    containerName: 'fde-alice',
    image: 'traefik/whoami',
    cmd: ['-port', '4000'],
    networkName: 'fde-alice',
    ip: '10.200.1.2',
    gateway: '10.200.1.1',
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
    userSpaceRoot: '/srv/erix/users',
  };
  const hasOverride = (body) => body.Env.some((e) => e.startsWith('ERIX_AGENT_VERSION='));
  assert.equal(hasOverride(buildContainerConfig(base)), false, '不设 ⇒ 让容器读构建产物');
  assert.equal(hasOverride(buildContainerConfig({ ...base, agentVersion: null })), false);
  assert.equal(hasOverride(buildContainerConfig({ ...base, agentVersion: 'dev' })), false,
    'dev 是占位，注进容器就等于让占位冒充上报值（账上那个 0.1.32-088e41e 就是这么来的）');
  const pinned = buildContainerConfig({ ...base, agentVersion: '0.27.0-rc1' });
  assert.ok(pinned.Env.includes('ERIX_AGENT_VERSION=0.27.0-rc1'), '显式钉值必须真的落到容器 env');
});

// ---------------------------------------------------------------------------
// 交叉核对（issue #404 结案的补漏）：**注入方（provisioner）与放行方（fde-proxy 白名单）是两个模块**。
// #416 加了 `ERIX_AGENT_VERSION` 注入却没同步白名单，现网 `provision-fde` 直接
// `create_policy_denied: Env key not allowed: ERIX_AGENT_VERSION`，而两个 FDE 容器当时已被 provision
// 流程删掉 ⇒ 短暂全停。单侧的测试（"我确实注了这个键"）永远不会发现这件事，因为它两边都"对"。
// ---------------------------------------------------------------------------
test('交叉核对：buildContainerConfig 能注入的每个 Env 键，都必须在 fde-proxy 白名单里', async () => {
  const fs = await import('node:fs');
  const src = await fs.promises.readFile(new URL('../src/provisioner.js', import.meta.url), 'utf8');
  const start = src.indexOf('export function buildContainerConfig');
  const end = src.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start, 'buildContainerConfig 源码边界没定位到（判据不能空转）');
  const injected = [...new Set([...src.slice(start, end).matchAll(/`([A-Z][A-Z0-9_]{2,})=/g)].map((m) => m[1]))].sort();
  assert.ok(injected.length >= 5, `只解析到 ${injected.length} 个注入键，多半是解析失效而非真的少`);

  const proxy = await fs.promises.readFile(new URL('../../deploy/fde-proxy/server.js', import.meta.url), 'utf8');
  const m = /const ENV_KEY_ALLOW = new Set\(\[(.*?)\]\)/s.exec(proxy);
  assert.ok(m, 'fde-proxy 的 ENV_KEY_ALLOW 定义没找到（改名了？那这条判据得同步改）');
  const allowed = new Set([...m[1].matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((x) => x[1]));

  const missing = injected.filter((k) => !allowed.has(k));
  assert.deepEqual(missing, [], `provisioner 会注入但 proxy 不放行的键：${missing.join(', ')} ⇒ 现网 create_policy_denied，容器建不出来`);
});
