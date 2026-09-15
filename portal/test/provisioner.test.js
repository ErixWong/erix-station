// 单测：provisioner.js —— 代码层 Docker API 白名单 / 容器创建 body（不 publish / bind mount / 网络）/
//       Docker API 调用序列（fake server）/ 对账逻辑（重建 + 孤儿清理）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
  DOCKER_ALLOWED_PATHS,
} from '../src/provisioner.js';

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
  // 不变式一：不 publish 端口
  assert.deepEqual(body.HostConfig.PortBindings, {});
  // bind mount 只允许本 FDE 用户空间（user-space §2.4）
  assert.deepEqual(body.HostConfig.Binds, [
    '/srv/erix/users/alice/home:/home/erix',
    '/srv/erix/users/alice/projects:/home/erix/projects',
    '/srv/erix/users/alice/worktrees:/home/erix/worktrees',
    '/srv/erix/users/alice/cache:/home/erix/cache',
  ]);
  // 只接自己的 /29
  assert.equal(body.HostConfig.NetworkMode, 'fde-alice');
  assert.equal(body.NetworkingConfig.EndpointsConfig['fde-alice'].IPAMConfig.IPv4Address, '10.200.1.2');
  assert.equal(body.HostConfig.Memory, 512 * 1024 * 1024);
  assert.deepEqual(body.HostConfig.CapDrop, ['ALL']);
  assert.deepEqual(body.HostConfig.SecurityOpt, ['no-new-privileges']);
  assert.equal(body.HostConfig.Init, true);
  assert.deepEqual(body.HostConfig.ExtraHosts, ['station.localhost:10.200.1.1', 'llm.localhost:10.200.1.1']);
});

test('buildNetworkConfig：显式 subnet + gateway', () => {
  const body = buildNetworkConfig({ name: 'fde-alice', subnet: '10.200.1.0/29', gateway: '10.200.1.1', fdeName: 'alice' });
  assert.equal(body.Name, 'fde-alice');
  assert.equal(body.CheckDuplicate, true);
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
    // create body 必须无端口发布
    const createCall = calls.find((c) => c.path.startsWith('/containers/create'));
    assert.deepEqual(createCall.body.HostConfig.PortBindings, {});
    assert.ok(createCall.body.Env.some((e) => e.startsWith('ERIX_STATION_TOKEN=')), '容器 env 注入 per-container token');
    assert.ok(createCall.body.Env.some((e) => e === 'ERIX_FDE_NAME=alice'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('reconcileOnce：DB 说该有而 Docker 没有 → 重建；孤儿容器 → 删除 + 审计', async () => {
  const pool = {
    audit: [],
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
              container_id: 'c1',
              container_name: 'fde-alice',
              container_status: 'creating',
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        // provisioner 的 SQL 把 action 作为字面量（'container.orphan_removed'），target/details 为参数。
        this.audit.push({ action: 'container.orphan_removed', target: params[0] });
        return { rows: [] };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('unexpected connect in this test');
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
  };
  const config = {
    userSpaceRoot: '/tmp/erix-users-test',
    fdeUid: 1000,
    fdeGid: 1000,
    fdeImage: 'traefik/whoami',
    fdeCmd: ['-port', '4000'],
    fdeMemoryLimit: '512m',
    agentdUid: 1001,
    baseDomain: 'localhost',
    llmHost: 'llm.localhost',
  };
  const stats = await reconcileOnce(pool, config, { docker });
  assert.equal(stats.rebuilt, 1);
  assert.equal(stats.orphansRemoved, 1);
  assert.ok(calls.includes('createContainer'), '重建缺失容器');
  assert.ok(calls.includes('removeContainer:fde-bob'), '删除孤儿容器');
  assert.ok(pool.audit.some((a) => a.action === 'container.orphan_removed' && a.target === 'fde-bob'));
});

test('DOCKER_ALLOWED_PATHS 白名单表只含 containers/networks 生命周期（不含 exec/images/system）', () => {
  const paths = DOCKER_ALLOWED_PATHS.map((r) => `${r.method} ${r.re.source.replace(/\\\//g, '/')}`);
  assert.ok(paths.some((p) => p.includes('containers/create')));
  assert.ok(paths.some((p) => p.includes('networks/create')));
  assert.ok(!paths.some((p) => p.includes('exec') || p.includes('images') || p.includes('system') || p.includes('volumes')));
});
