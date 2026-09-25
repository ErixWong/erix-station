// 单测：自研 admission proxy（deploy/fde-proxy/server.js）——方法+路径白名单 / create body 字段级 allowlist /
//       生命周期 API 资源 scope / bind source symlink 逃逸 / 重复 JSON 键 / 原型污染键 / 网络创建白名单 /
//       R3 绑定具体 FDE / R7 资源名编码绕过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  matchPath,
  validateCreateBody,
  validateNetworkBody,
  isManagedContainerInfo,
  isManagedNetworkInfo,
  parseJsonStrict,
  validateBindSource,
  validateContainerDest,
  mapBindSourceToContainer,
  decodeName,
  createHandler,
} from '../../deploy/fde-proxy/server.js';

const CFG = { userSpaceRoot: '/srv/erix/users', imageAllowlist: 'traefik/whoami', fdeName: 'alice', containerName: 'fde-alice' };

function okBody(overrides = {}) {
  const body = {
    Image: 'traefik/whoami',
    Cmd: ['-port', '4000'],
    Env: ['ERIX_FDE_NAME=alice'],
    Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
    HostConfig: {
      Binds: ['/srv/erix/users/alice/home:/home/erix'],
      NetworkMode: 'fde-alice',
      CapDrop: ['ALL'],
      CapAdd: ['SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL'],
      SecurityOpt: ['no-new-privileges'],
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
      Memory: 512 * 1024 * 1024,
    },
  };
  return { ...body, ...overrides };
}

function okNetworkBody(overrides = {}) {
  const body = {
    Name: 'fde-alice',
    Driver: 'bridge',
    IPAM: { Driver: 'default', Config: [{ Subnet: '10.200.1.0/29', Gateway: '10.200.1.1' }] },
    Labels: { 'station.managed': 'true', 'fde.name': 'alice' },
  };
  return { ...body, ...overrides };
}

test('proxy 路径白名单：12 条契约路径放行，其余（exec/images/system/volumes）403', () => {
  const allowed = [
    ['GET', '/_ping'],
    ['GET', '/version'],
    ['GET', '/containers/json'],
    ['POST', '/containers/create'],
    ['GET', '/containers/abc123/json'],
    ['POST', '/containers/abc123/start'],
    ['POST', '/containers/abc123/stop'],
    ['DELETE', '/containers/abc123'],
    ['GET', '/networks'],
    ['POST', '/networks/create'],
    ['GET', '/networks/fde-alice'],
    ['DELETE', '/networks/fde-alice'],
  ];
  for (const [m, p] of allowed) assert.equal(matchPath(m, p), true, `${m} ${p} 应放行`);

  const denied = [
    ['GET', '/exec'],
    ['POST', '/containers/abc/exec'],
    ['POST', '/containers/abc/attach'],
    ['GET', '/images/json'],
    ['GET', '/info'],
    ['GET', '/system/info'],
    ['POST', '/volumes/create'],
    ['DELETE', '/networks/../containers/x'],
    ['POST', '/containers/abc/rename'],
  ];
  for (const [m, p] of denied) assert.equal(matchPath(m, p), false, `${m} ${p} 应拒绝`);
});

test('P1 create 策略校验：契约 body 通过', () => {
  assert.deepEqual(validateCreateBody(okBody(), CFG), []);
});

test('P1 顶层字段 allowlist：未知字段 / WorkingDir / ExposedPorts / NetworkingConfig 全 403', () => {
  for (const key of ['WorkingDir', 'ExposedPorts', 'Hostname', 'Tty', 'NetworkingConfig']) {
    const body = okBody({ [key]: key === 'Tty' ? true : key === 'NetworkingConfig' ? { EndpointsConfig: { backend: {} } } : '/x' });
    const reasons = validateCreateBody(body, CFG);
    assert.ok(reasons.some((r) => r.includes(`unknown top-level field: ${key}`)), `${key} 应被拒`);
  }
  // Cmd / Entrypoint / User / Env / Labels 允许（deploy-contract §6.2 + env §10 dev 兜底）
  assert.deepEqual(validateCreateBody(okBody({ User: '1001:1000' }), CFG), []);
  assert.deepEqual(validateCreateBody(okBody({ Entrypoint: ['/bin/sh'] }), CFG), []);
});

test('P1 HostConfig 字段 allowlist：Mounts/Devices/VolumesFrom/Privileged/PortBindings/PublishMode/Links 全 403', () => {
  const forbidden = {
    Mounts: [{ Type: 'bind', Source: '/var/run/docker.sock', Target: '/var/run/docker.sock' }],
    Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }],
    VolumesFrom: ['other'],
    Privileged: true,
    PortBindings: {},
    PublishMode: 'host',
    Links: ['db'],
  };
  for (const [key, val] of Object.entries(forbidden)) {
    const body = okBody({ HostConfig: { ...okBody().HostConfig, [key]: val } });
    const reasons = validateCreateBody(body, CFG);
    assert.ok(reasons.some((r) => r.includes(`HostConfig field not allowed: ${key}`)), `${key} 应被拒`);
  }
});

test('ExtraHosts（--add-host）：合法 host:ipv4 允许，非法形态/超限 403', () => {
  // 契约 §6.2：容器内 station.<base>/llm.<base> → 本 FDE bridge 网关（合法）。
  const ok = okBody({ HostConfig: { ...okBody().HostConfig, ExtraHosts: ['station.localhost:10.200.1.1', 'llm.localhost:10.200.1.1'] } });
  assert.deepEqual(validateCreateBody(ok, CFG), []);

  const badForm = okBody({ HostConfig: { ...okBody().HostConfig, ExtraHosts: ['station.localhost'] } });
  assert.ok(validateCreateBody(badForm, CFG).some((r) => r.includes('ExtraHosts')));

  const badIp = okBody({ HostConfig: { ...okBody().HostConfig, ExtraHosts: ['station.localhost:999.1.1.1'] } });
  assert.ok(validateCreateBody(badIp, CFG).some((r) => r.includes('ExtraHosts')));

  const tooMany = okBody({ HostConfig: { ...okBody().HostConfig, ExtraHosts: ['a:1.1.1.1', 'b:1.1.1.1', 'c:1.1.1.1', 'd:1.1.1.1', 'e:1.1.1.1'] } });
  assert.ok(validateCreateBody(tooMany, CFG).some((r) => r.includes('ExtraHosts')));
});

test('P1 值校验：CapAdd=SYS_ADMIN / NetworkMode=bridge / CapDrop 多值 / SecurityOpt 多值 / Memory 超限 全 403', () => {
  const capSysAdmin = okBody({ HostConfig: { ...okBody().HostConfig, CapAdd: ['SYS_ADMIN'] } });
  assert.ok(validateCreateBody(capSysAdmin, CFG).some((r) => r.includes('CapAdd')));

  const netBridge = okBody({ HostConfig: { ...okBody().HostConfig, NetworkMode: 'bridge' } });
  assert.ok(validateCreateBody(netBridge, CFG).some((r) => r.includes('NetworkMode')));

  const capDropExtra = okBody({ HostConfig: { ...okBody().HostConfig, CapDrop: ['ALL', 'NET_ADMIN'] } });
  assert.ok(validateCreateBody(capDropExtra, CFG).some((r) => r.includes('CapDrop')));

  const secOptExtra = okBody({ HostConfig: { ...okBody().HostConfig, SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] } });
  assert.ok(validateCreateBody(secOptExtra, CFG).some((r) => r.includes('SecurityOpt')));

  const memOver = okBody({ HostConfig: { ...okBody().HostConfig, Memory: 2 * 1024 * 1024 * 1024 } });
  assert.ok(validateCreateBody(memOver, { ...CFG, maxMemory: 1024 * 1024 * 1024 }).some((r) => r.includes('Memory')));
});

test('R5 值级校验：MemorySwap>2x / PidsLimit 超限 / Init!=true / RestartPolicy 多字段 全 403', () => {
  const swapOver = okBody({ HostConfig: { ...okBody().HostConfig, MemorySwap: 3 * 512 * 1024 * 1024 } });
  assert.ok(validateCreateBody(swapOver, CFG).some((r) => r.includes('MemorySwap')));

  const pidsOver = okBody({ HostConfig: { ...okBody().HostConfig, PidsLimit: 1024 } });
  assert.ok(validateCreateBody(pidsOver, { ...CFG, maxPids: 512 }).some((r) => r.includes('PidsLimit')));

  const initFalse = okBody({ HostConfig: { ...okBody().HostConfig, Init: false } });
  assert.ok(validateCreateBody(initFalse, CFG).some((r) => r.includes('Init')));

  const restartBad = okBody({ HostConfig: { ...okBody().HostConfig, RestartPolicy: { Name: 'always' } } });
  assert.ok(validateCreateBody(restartBad, CFG).some((r) => r.includes('RestartPolicy')));

  const restartExtra = okBody({ HostConfig: { ...okBody().HostConfig, RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 5 } } });
  assert.ok(validateCreateBody(restartExtra, CFG).some((r) => r.includes('RestartPolicy')));
});

test('P5 image 全串精确匹配：traefik/whoami:malicious-tag 不得命中 traefik/whoami', () => {
  const body = okBody({ Image: 'traefik/whoami:malicious-tag' });
  assert.ok(validateCreateBody(body, CFG).some((r) => r.includes('allowlist')));
  const digestBody = okBody({ Image: 'traefik/whoami@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.ok(
    validateCreateBody(digestBody, {
      ...CFG,
      imageAllowlist: 'traefik/whoami@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }).length === 0,
  );
});

test('P1 重复 JSON 键：parseJsonStrict 抛 json_duplicate_key', () => {
  assert.throws(
    () => parseJsonStrict('{"Image":"traefik/whoami","HostConfig":{"NetworkMode":"fde-a"},"HostConfig":{"NetworkMode":"bridge"}}'),
    (e) => e.code === 'json_duplicate_key',
  );
  assert.throws(
    () => parseJsonStrict('{"HostConfig":{"NetworkMode":"fde-a","NetworkMode":"bridge"}}'),
    (e) => e.code === 'json_duplicate_key',
  );
  assert.deepEqual(parseJsonStrict('{"a":1,"b":[1,2,{"c":true}]}'), { a: 1, b: [1, 2, { c: true }] });
});

test('R4 原型污染键：parseJsonStrict 抛 json_forbidden_key（任何层）', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () => parseJsonStrict(`{"HostConfig":{"${key}":{"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"]}}}`),
      (e) => e.code === 'json_forbidden_key',
      `${key} 应被拒`,
    );
    // 顶层 + 数组内嵌套对象也拒
    assert.throws(() => parseJsonStrict(`{"${key}":{}}`), (e) => e.code === 'json_forbidden_key');
    assert.throws(() => parseJsonStrict(`[{"${key}":1}]`), (e) => e.code === 'json_forbidden_key');
  }
});

test('P2 资源 scope：容器/网络必须 station.managed=true 且名字 fde-<name>', () => {
  assert.equal(isManagedContainerInfo({ Name: '/fde-alice', Config: { Labels: { 'station.managed': 'true' } } }), true);
  assert.equal(isManagedContainerInfo({ Name: '/other', Config: { Labels: { 'station.managed': 'true' } } }), false);
  assert.equal(isManagedContainerInfo({ Name: '/fde-alice', Config: { Labels: {} } }), false);
  assert.equal(isManagedNetworkInfo({ Name: 'fde-alice', Labels: { 'station.managed': 'true' } }), true);
  assert.equal(isManagedNetworkInfo({ Name: 'bridge', Labels: { 'station.managed': 'true' } }), false);
  assert.equal(isManagedNetworkInfo({ Name: 'fde-alice', Labels: {} }), false);
});

test('P3 bind source：宿主路径→容器路径映射 + symlink 逃逸 → 403', () => {
  assert.equal(
    mapBindSourceToContainer('/srv/erix/users/alice/home', { userSpaceRootHost: '/srv/erix/users', userSpaceRoot: '/srv/erix/users' }),
    '/srv/erix/users/alice/home',
  );
  assert.equal(
    mapBindSourceToContainer('/tmp/erix-e2e-xxx/alice/home', { userSpaceRootHost: '/tmp/erix-e2e-xxx', userSpaceRoot: '/srv/erix/users' }),
    '/srv/erix/users/alice/home',
  );
  assert.equal(
    mapBindSourceToContainer('/etc/passwd', { userSpaceRootHost: '/tmp/erix-e2e-xxx', userSpaceRoot: '/srv/erix/users' }),
    null,
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-proxy-test-'));
  try {
    const alice = path.join(tmp, 'alice');
    fs.mkdirSync(alice, { recursive: true });
    fs.symlinkSync('/etc', path.join(alice, 'home'));
    const body = okBody({
      HostConfig: { ...okBody().HostConfig, Binds: [`${alice}/home:/home/erix`] },
    });
    const reasons = validateCreateBody(body, { userSpaceRootHost: tmp, userSpaceRoot: tmp, imageAllowlist: 'traefik/whoami' });
    assert.ok(reasons.some((r) => r.includes('escapes USERSPACE_ROOT')), `symlink 逃逸应被拒: ${JSON.stringify(reasons)}`);

    fs.rmSync(path.join(alice, 'home'));
    fs.mkdirSync(path.join(alice, 'home'));
    const okReasons = validateCreateBody(body, { userSpaceRootHost: tmp, userSpaceRoot: tmp, imageAllowlist: 'traefik/whoami' });
    assert.deepEqual(okReasons, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('validateBindSource：docker.sock / 越界 / 空 source', () => {
  assert.ok(validateBindSource('/etc/passwd', { userSpaceRootHost: '/srv/erix/users', userSpaceRoot: '/srv/erix/users' }).includes('not under USERSPACE_ROOT'));
  assert.ok(validateBindSource('', { userSpaceRootHost: '/srv/erix/users', userSpaceRoot: '/srv/erix/users' }).includes('empty'));
});

test('validateContainerDest：必须在 /home/erix 下，拒绝 .. / 其它路径', () => {
  assert.equal(validateContainerDest('/home/erix'), null);
  assert.equal(validateContainerDest('/home/erix/projects'), null);
  assert.ok(validateContainerDest('/mnt').includes('not under container home'));
  assert.ok(validateContainerDest('/home/erix/../etc').includes('..'));
});

test('R7 decodeName：拒绝 %2F / %2e / . / .. / 反斜杠 / 控制字符', () => {
  assert.equal(decodeName('fde-alice'), 'fde-alice');
  assert.equal(decodeName('a%2Fb'), null);
  assert.equal(decodeName('a%2fb'), null);
  assert.equal(decodeName('a%2Eb'), null);
  assert.equal(decodeName('.'), null);
  assert.equal(decodeName('..'), null);
  assert.equal(decodeName('a\\b'), null);
  assert.equal(decodeName('a%5Cb'), null);
  assert.equal(decodeName('a%00b'), null);
  assert.equal(decodeName(''), null);
  assert.equal(decodeName('%zz'), null);
});

test('R2 validateNetworkBody：合法通过 / CheckDuplicate 拒绝 / macvlan 拒绝 / 任意 subnet 拒绝', () => {
  const pools = ['10.200.0.0/16', '10.201.0.0/16'];
  assert.deepEqual(validateNetworkBody(okNetworkBody(), { ipamPools: pools }), []);

  const dup = okNetworkBody({ CheckDuplicate: true });
  assert.ok(validateNetworkBody(dup, { ipamPools: pools }).some((r) => r.includes('field not allowed: CheckDuplicate')));

  const macvlan = okNetworkBody({ Driver: 'macvlan' });
  assert.ok(validateNetworkBody(macvlan, { ipamPools: pools }).some((r) => r.includes('Driver')));

  const arbitrarySubnet = okNetworkBody({ IPAM: { Driver: 'default', Config: [{ Subnet: '172.32.99.0/29', Gateway: '172.32.99.1' }] } });
  assert.ok(validateNetworkBody(arbitrarySubnet, { ipamPools: pools }).some((r) => r.includes('Subnet')));

  const backendSubnet = okNetworkBody({ IPAM: { Driver: 'default', Config: [{ Subnet: '172.32.0.0/24', Gateway: '172.32.0.1' }] } });
  assert.ok(validateNetworkBody(backendSubnet, { ipamPools: pools }).some((r) => r.includes('Subnet')));

  const noLabel = okNetworkBody({ Labels: { 'fde.name': 'alice' } });
  assert.ok(validateNetworkBody(noLabel, { ipamPools: pools }).some((r) => r.includes('station.managed')));
});

test('R3 create 绑定具体 FDE：评审利用场景逐字段全拒', () => {
  const cfgAttacker = { ...CFG, fdeName: 'attacker', containerName: 'fde-attacker' };
  const exploit = {
    Image: 'traefik/whoami',
    Labels: { 'station.managed': 'true', 'fde.name': 'victim' },
    Env: ['ERIX_STATION_TOKEN=fake-token', 'ERIX_FDE_NAME=victim'],
    User: '0',
    HostConfig: {
      Binds: ['/srv/erix/users:/mnt:rw'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Init: true,
      // 省略 NetworkMode（默认 bridge）
    },
  };
  const reasons = validateCreateBody(exploit, cfgAttacker);
  assert.ok(reasons.some((r) => r.includes('Labels.fde.name must equal attacker')), `label 伪造应拒: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((r) => r.includes('bind source not under USERSPACE_ROOT')), `跨 FDE 根挂载应拒: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((r) => r.includes('Env ERIX_FDE_NAME must equal attacker')), `env 伪造应拒: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((r) => r.includes('User not in ALLOWED_USERS')), `User=0 应拒: ${JSON.stringify(reasons)}`);
  assert.ok(reasons.some((r) => r.includes('NetworkMode must be exactly fde-attacker')), `省略 NetworkMode 应拒: ${JSON.stringify(reasons)}`);

  // 跨 FDE bind（attacker 挂 victim 的 home）
  const crossFde = okBody({
    HostConfig: { ...okBody().HostConfig, Binds: ['/srv/erix/users/victim/home:/home/erix'] },
  });
  const crossReasons = validateCreateBody(crossFde, cfgAttacker);
  assert.ok(crossReasons.some((r) => r.includes('not under USERSPACE_ROOT')), `跨 FDE bind 应拒: ${JSON.stringify(crossReasons)}`);

  // 合规 body（fde-alice）通过
  assert.deepEqual(validateCreateBody(okBody(), CFG), []);
});

// ---------------------------------------------------------------------------
// 真机级 handler 探针（fake unix socket 模拟 docker daemon，验证真实 HTTP 状态码）
// ---------------------------------------------------------------------------
async function startFakeDocker() {
  const sock = path.join(os.tmpdir(), `erix-docker-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
  const received = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: raw });
      const p = req.url.split('?')[0];
      const send = (status, obj) => {
        const payload = JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload);
      };
      if (p === '/containers/evil/json') return send(200, { Name: '/evil', Config: { Labels: {} } });
      if (p === '/networks/bridge') return send(200, { Name: 'bridge', Labels: {} });
      if (p === '/containers/fde-alice/json') return send(200, { Name: '/fde-alice', Config: { Labels: { 'station.managed': 'true' } } });
      if (p === '/networks/fde-alice') return send(200, { Name: 'fde-alice', Labels: { 'station.managed': 'true' } });
      if (p === '/containers/create') return send(201, { Id: 'abc' });
      if (p === '/networks/create') return send(201, { Id: 'net' });
      return send(404, { message: 'not found' });
    });
  });
  await new Promise((r) => server.listen(sock, r));
  return { sock, server, received };
}

async function startProxy(sock) {
  const handler = createHandler({
    socketPath: sock,
    userSpaceRoot: '/srv/erix/users',
    imageAllowlist: 'traefik/whoami',
  });
  const server = http.createServer((req, res) =>
    handler(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{"error":"internal"}');
      } else res.destroy();
    }),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('handler 真机探针：R1 inspect scope / R2 NetworkingConfig / R3 利用场景 / R4 __proto__ 全 403，合规 201', async (t) => {
  const docker = await startFakeDocker();
  const proxy = await startProxy(docker.sock);
  t.after(() => {
    proxy.server.close();
    docker.server.close();
    try {
      fs.rmSync(docker.sock, { force: true });
    } catch {}
  });

  const post = async (pathname, body) => {
    const res = await fetch(`${proxy.base}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json() };
  };
  const get = async (pathname) => {
    const res = await fetch(`${proxy.base}${pathname}`);
    return { status: res.status, data: await res.json() };
  };

  // R1：非托管容器/网络 inspect → 403
  assert.equal((await get('/containers/evil/json')).status, 403, 'R1 非托管容器 inspect 403');
  assert.equal((await get('/networks/bridge')).status, 403, 'R1 非托管网络 inspect 403');
  assert.equal((await get('/containers/fde-alice/json')).status, 200, 'R1 托管容器 inspect 放行');
  assert.equal((await get('/networks/fde-alice')).status, 200, 'R1 托管网络 inspect 放行');

  // R2：NetworkingConfig 接 backend → 403
  const r2 = await post('/containers/create?name=fde-alice', okBody({ NetworkingConfig: { EndpointsConfig: { backend: { IPAMConfig: { IPv4Address: '172.32.0.9' } } } } }));
  assert.equal(r2.status, 403, 'R2 NetworkingConfig 403');

  // R2：networks/create macvlan / 任意 subnet → 403
  const macvlan = await post('/networks/create', okNetworkBody({ Driver: 'macvlan' }));
  assert.equal(macvlan.status, 403, 'R2 macvlan 403');
  const arbitrarySubnet = await post('/networks/create', okNetworkBody({ IPAM: { Driver: 'default', Config: [{ Subnet: '172.32.99.0/29', Gateway: '172.32.99.1' }] } }));
  assert.equal(arbitrarySubnet.status, 403, 'R2 任意 subnet 403');

  // R3：完整利用场景 → 403
  const r3 = await post('/containers/create?name=fde-attacker', {
    Image: 'traefik/whoami',
    Labels: { 'station.managed': 'true', 'fde.name': 'victim' },
    Env: ['ERIX_STATION_TOKEN=fake-token', 'ERIX_FDE_NAME=victim'],
    User: '0',
    HostConfig: {
      Binds: ['/srv/erix/users:/mnt:rw'],
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Init: true,
    },
  });
  assert.equal(r3.status, 403, 'R3 利用场景 403');

  // R4：__proto__ 污染 → 403
  const r4 = await fetch(`${proxy.base}/containers/create?name=fde-alice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"Image":"traefik/whoami","HostConfig":{"__proto__":{"CapDrop":["ALL"],"SecurityOpt":["no-new-privileges"]}}}',
  });
  assert.equal(r4.status, 403, 'R4 __proto__ 403');

  // 合规 create → 201（转发到 fake docker）
  const ok = await post('/containers/create?name=fde-alice', okBody());
  assert.equal(ok.status, 201, '合规 create 201');
  // 合规 network create → 201
  const okNet = await post('/networks/create', okNetworkBody());
  assert.equal(okNet.status, 201, '合规 network create 201');
});


test('env 白名单：P5 可调参数键放行（issue #84）', () => {
  const body = okBody({ Env: ['ERIX_STATION_TOKEN=t', 'ERIX_FDE_NAME=alice', 'ERIX_MAX_ROUNDS=16', 'ERIX_AGENTD_CAPACITY=2', 'ERIX_ARTIFACT_MAX_BYTES=104857600', 'ERIX_SHELL_TIMEOUT_MS=60000', 'ERIX_SHELL_MAX_TIMEOUT_MS=600000', 'ERIX_SHELL_OUTPUT_MAX_BYTES=32768', 'ERIX_ARTIFACT_CAPTURE_BUDGET_MS=60000'] });
  assert.deepEqual(validateCreateBody(body, CFG), []);
});
