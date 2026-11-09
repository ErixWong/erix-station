// issue #474 S2：路由后端白名单（routebackends.js）+ readRouteDesiredState 的构造期判据。
// 每条负例都必须是「去掉对应判据就变红」的（工单 §4 的变异清单）——所以断言打到 **err.code**，
// 而不是只打「抛错了」：同一句 assert.throws(/invalid/) 会让四条不同判据互相顶包。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPreviewBackend,
  assertFdeSubnet,
  reservedPlatformHosts,
  FDE_IPAM_POOLS,
  PREVIEW_BACKEND_HOST_OFFSET,
} from '../src/routebackends.js';
import { readRouteDesiredState } from '../src/routes.js';
import { PREVIEW_PORT_POOL_START, PREVIEW_PORT_POOL_END } from '../src/previewpool.js';

const BASE = 'fde.test';

function code(fn) {
  try {
    fn();
  } catch (err) {
    return err.code ?? `no-code:${err.message}`;
  }
  return 'no-throw';
}

// ---- 正例：四类后端 + 号池边界 -------------------------------------------------

test('S2 正例：预览后端 = subnetBase+2 与端口；/29 与 /28 两个池都对', () => {
  assert.equal(
    buildPreviewBackend({ subnet: '10.200.1.0/29', prefix: 29, port: 22000 }),
    'http://10.200.1.2:22000',
  );
  assert.equal(
    buildPreviewBackend({ subnet: '10.201.7.0/28', prefix: 28, port: 29999 }),
    'http://10.201.7.2:29999',
  );
  assert.equal(PREVIEW_BACKEND_HOST_OFFSET, 2, '后端固定位是 base+2');
  assert.deepEqual(FDE_IPAM_POOLS.map((p) => p.cidr).sort(), ['10.200.0.0/16', '10.201.0.0/16'], '池与 ipam.js 同源');
});

test('S2 边界：号池两端 22000 / 29999 必须放行（闭区间）', () => {
  assert.equal(PREVIEW_PORT_POOL_START, 22000);
  assert.equal(PREVIEW_PORT_POOL_END, 29999);
  assert.equal(buildPreviewBackend({ subnet: '10.200.1.0/29', prefix: 29, port: PREVIEW_PORT_POOL_START }), 'http://10.200.1.2:22000');
  assert.equal(buildPreviewBackend({ subnet: '10.200.1.0/29', prefix: 29, port: PREVIEW_PORT_POOL_END }), 'http://10.200.1.2:29999');
});

test('S2 负例：端口 21999 / 30000 / 非整数 被拒（池外闭区间）', () => {
  const base = { subnet: '10.200.1.0/29', prefix: 29 };
  assert.equal(code(() => buildPreviewBackend({ ...base, port: 21999 })), 'preview_port_out_of_pool');
  assert.equal(code(() => buildPreviewBackend({ ...base, port: 30000 })), 'preview_port_out_of_pool');
  assert.equal(code(() => buildPreviewBackend({ ...base, port: '22000.5' })), 'preview_port_out_of_pool');
  assert.equal(code(() => buildPreviewBackend({ ...base, port: 'abc' })), 'preview_port_out_of_pool');
});

test('S2 负例：127.0.0.1 / 池外网段 / 带路径的 URL 都进不了预览后端构造', () => {
  // 「127.0.0.1:22」这类后端在 S2 之前是**拼出来的**，所以它的等价负例是「网段根本不是 FDE 网段」。
  assert.equal(code(() => buildPreviewBackend({ subnet: '127.0.0.1/32', port: 22 })), 'fde_subnet_out_of_pool');
  assert.equal(code(() => buildPreviewBackend({ subnet: '192.168.0.0/29', port: 22000 })), 'fde_subnet_out_of_pool');
  assert.equal(code(() => buildPreviewBackend({ subnet: '10.200.1.0/29/path', port: 22000 })), 'fde_subnet_invalid');
});

// ---- CIDR 侧（评审 F2）：四条判据各打一条 ------------------------------------

test('S2 CIDR 判据①：parseCidr 只验语法 ⇒ 0.0.0.0/0 与 127.0.0.0/8 必须在池归属这一层被拒', () => {
  // 工单 §0 的实测事实：parseCidr('0.0.0.0/0') 放行。这里锁住「它仍被白名单拒」这条差集。
  assert.equal(code(() => assertFdeSubnet('0.0.0.0/0')), 'fde_subnet_out_of_pool');
  assert.equal(code(() => assertFdeSubnet('127.0.0.0/8')), 'fde_subnet_out_of_pool');
  // 池内的宽网段（前缀不是 29/28）同样被拒：这条是**池归属之外**的第二层，去掉前缀判据就红。
  assert.equal(code(() => assertFdeSubnet('10.200.0.0/16')), 'fde_subnet_prefix_mismatch');
});

test('S2 CIDR 判据②：网络地址规范（10.200.0.3/29 被拒，parseCidr 会静默 mask 成 base）', () => {
  assert.equal(code(() => assertFdeSubnet('10.200.0.3/29')), 'fde_subnet_not_canonical');
  assert.equal(code(() => assertFdeSubnet('10.200.1.7/29')), 'fde_subnet_not_canonical');
  assert.equal(assertFdeSubnet('10.200.1.0/29').base, assertFdeSubnet('10.200.1.0/29').ipInt);
});

test('S2 CIDR 判据③④：前缀必须等于该 FDE 的分配前缀；/29 段配 /28 前缀被拒', () => {
  assert.equal(assertFdeSubnet('10.201.7.0/28', { expectedPrefix: 28 }).prefixLen, 28);
  assert.equal(code(() => assertFdeSubnet('10.200.1.0/29', { expectedPrefix: 28 })), 'fde_subnet_prefix_mismatch');
  assert.equal(code(() => assertFdeSubnet('10.201.7.0/28', { expectedPrefix: 29 })), 'fde_subnet_prefix_mismatch');
  assert.equal(code(() => assertFdeSubnet('not a cidr')), 'fde_subnet_invalid');
});

// ---- hostname 侧（评审 F1）：保留集 + 重算逐字相等 ----------------------------

test('S2 hostname：保留集来自 config（portalHost/adminHost/llmHost/portalInternalHosts）', () => {
  const reserved = reservedPlatformHosts({
    portalHost: 'station.fde.test',
    adminHost: 'admin.fde.test',
    llmHost: 'llm.fde.test',
    portalInternalHosts: ['127.0.0.1', 'portal.internal'],
  });
  assert.deepEqual(
    [...reserved].sort(),
    ['127.0.0.1', 'admin.fde.test', 'llm.fde.test', 'portal.internal', 'station.fde.test'],
  );
});

test('S2 hostname 负例：station.<伞域> 这种保留名被拒（预览 priority 200 会抢赢 portal 100）', () => {
  const reserved = reservedPlatformHosts({ portalHost: 'station.fde.test', adminHost: 'admin.fde.test', llmHost: 'llm.fde.test' });
  // 逐字相等判据单独可红：把保留名当成「重算结果」喂进去（fdeName=station-p-22000 拼出保留名）。
  assert.equal(
    code(() => buildPreviewBackend({
      subnet: '10.200.1.0/29', prefix: 29, port: 22000,
      hostname: 'station.fde.test', fdeName: 'station', baseDomain: BASE, reservedHosts: reserved,
    })),
    'preview_hostname_mismatch',
  );
  // 保留集判据单独可红：重算值**恰好**落在保留集里（fde 名就叫 station，拼出来正好是保留名）。
  assert.equal(
    code(() => buildPreviewBackend({
      subnet: '10.200.1.0/29', prefix: 29, port: 22000,
      hostname: 'station-p-22000.fde.test', fdeName: 'station', baseDomain: BASE,
      reservedHosts: new Set(['station-p-22000.fde.test']),
    })),
    'preview_hostname_reserved',
  );
  assert.equal(
    buildPreviewBackend({
      subnet: '10.200.1.0/29', prefix: 29, port: 22000,
      hostname: 'alice-p-22000.fde.test', fdeName: 'alice', baseDomain: BASE, reservedHosts: reserved,
    }),
    'http://10.200.1.2:22000',
  );
});

test('S2 hostname 负例：hostname 与 (fdeName,port,伞域) 重算值差一个字符也被拒', () => {
  const common = { subnet: '10.200.1.0/29', prefix: 29, port: 22000, fdeName: 'alice', baseDomain: BASE };
  assert.equal(buildPreviewBackend({ ...common, hostname: 'alice-p-22000.fde.test' }), 'http://10.200.1.2:22000', '逐字相等时放行');
  assert.equal(code(() => buildPreviewBackend({ ...common, hostname: 'alice-p-22001.fde.test' })), 'preview_hostname_mismatch');
  assert.equal(code(() => buildPreviewBackend({ ...common, hostname: 'alice-p-22000.other.test' })), 'preview_hostname_mismatch');
  assert.equal(code(() => buildPreviewBackend({ ...common, hostname: 'ALICE-p-22000.fde.test' })), 'preview_hostname_mismatch');
  // 缺重算输入 = 无法判 = 拒（不许静默跳过）。
  assert.equal(
    code(() => buildPreviewBackend({ ...common, hostname: 'alice-p-22000.fde.test', fdeName: undefined })),
    'preview_hostname_unverifiable',
  );
  assert.equal(
    code(() => buildPreviewBackend({ ...common, hostname: 'alice-p-22000.fde.test', baseDomain: '' })),
    'preview_hostname_unverifiable',
  );
});

// ---- 构造期（readRouteDesiredState）：fake pool 主动返回污染行 ----------------

function fakePool({ networks = [], bindings = [], allocations = [] } = {}) {
  return {
    sqlLog: [],
    async query(sql) {
      this.sqlLog.push(sql);
      if (sql.includes('FROM fde_networks')) return { rows: networks };
      if (sql.includes('FROM fde_llm_bindings b')) return { rows: bindings };
      if (sql.includes('FROM port_allocations')) return { rows: allocations };
      return { rows: [] };
    },
  };
}

const NET = [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }];
const GOOD_ALLOC = [{
  id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, subnet: '10.200.1.0/29', fde_name: 'alice',
}];
const CFG = { baseDomain: BASE, portalHost: 'station.fde.test', adminHost: 'admin.fde.test', llmHost: 'llm.fde.test' };

test('S2 构造期正例：正常行拼出 http://<base+2>:<port>，hostname 重算通过', async () => {
  const state = await readRouteDesiredState(fakePool({ networks: NET, allocations: GOOD_ALLOC }), CFG);
  assert.deepEqual(state.allocations, [{
    id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, backendUrl: 'http://10.200.1.2:22000',
  }]);
});

test('S2 构造期负例：port_allocations.hostname 被改成 station.<伞域> ⇒ 抛错（不落半截配置）', async () => {
  const pool = fakePool({
    networks: NET,
    allocations: [{ ...GOOD_ALLOC[0], hostname: 'station.fde.test' }],
  });
  await assert.rejects(() => readRouteDesiredState(pool, CFG), (err) => err.code === 'preview_hostname_mismatch');
});

test('S2 构造期负例：allocation.subnet 与该 FDE 分配网段不一致（错误 FDE 关联）⇒ 抛错', async () => {
  const wrongFde = fakePool({
    networks: NET,
    allocations: [{ ...GOOD_ALLOC[0], subnet: '10.200.9.0/29' }],
  });
  await assert.rejects(() => readRouteDesiredState(wrongFde, CFG), (err) => err.code === 'fde_subnet_association_mismatch');

  const noNetwork = fakePool({ networks: [], allocations: GOOD_ALLOC });
  await assert.rejects(() => readRouteDesiredState(noNetwork, CFG), (err) => err.code === 'fde_subnet_association_missing');
});

test('S2 构造期负例：allocation.subnet = 0.0.0.0/0 / 127.0.0.0/8 / 池外网段 ⇒ 抛错', async () => {
  for (const subnet of ['0.0.0.0/0', '127.0.0.0/8', '192.168.0.0/29']) {
    const pool = fakePool({
      networks: [{ ...NET[0], subnet }],
      allocations: [{ ...GOOD_ALLOC[0], subnet }],
    });
    await assert.rejects(
      () => readRouteDesiredState(pool, CFG),
      (err) => err.code === 'fde_subnet_out_of_pool' || err.code === 'fde_subnet_prefix_mismatch',
      `${subnet} 必须被拒`,
    );
  }
});

test('S2 构造期负例：有 LLM binding 但无 preview allocation ⇒ LLM 的 subnet 判据照样红（不被 preview 路径掩盖）', async () => {
  const pool = fakePool({
    networks: [{ fde_id: 'u1', subnet: '0.0.0.0/0', fde_name: 'alice' }],
    bindings: [{ fde_id: 'u1', api_key: 'sk-x', fde_name: 'alice', subnet: '0.0.0.0/0' }],
    allocations: [],
  });
  await assert.rejects(() => readRouteDesiredState(pool, CFG), (err) => err.code === 'fde_subnet_out_of_pool');
});

test('S2 构造期：LLM binding 的 subnet 必须等于该 FDE 的分配前缀（前缀判据在 LLM 路径也生效）', async () => {
  const pool = fakePool({
    networks: NET,
    bindings: [{ fde_id: 'u1', api_key: 'sk-x', fde_name: 'alice', subnet: '10.200.1.0/28' }],
    allocations: [],
  });
  await assert.rejects(() => readRouteDesiredState(pool, CFG), (err) => err.code === 'fde_subnet_prefix_mismatch');
});

test('S2 构造期：错误消息不含 YAML 正文与 api key（红线预检）', async () => {
  const pool = fakePool({
    networks: NET,
    bindings: [{ fde_id: 'u1', api_key: 'sk-CANARYKEY-9e2f', fde_name: 'alice', subnet: '0.0.0.0/0' }],
    allocations: [{ ...GOOD_ALLOC[0], port: 30000 }],
  });
  await assert.rejects(
    () => readRouteDesiredState(pool, CFG),
    (err) => !String(err.message).includes('sk-CANARYKEY-9e2f') && !String(err.message).includes('\n'),
  );
});
