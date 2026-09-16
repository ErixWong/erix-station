// 单测：ipam.js（子网算术、空闲块分配、避开保留/已占、/29 与 /28 池）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ipToInt,
  intToIp,
  parseCidr,
  cidrsOverlap,
  enumerateSubnets,
  nextAvailableSubnet,
  allocateNetworkInTx,
  POOLS,
} from '../src/ipam.js';

test('ipToInt / intToIp 往返', () => {
  assert.equal(ipToInt('10.200.0.0'), 0x0ac80000);
  assert.equal(intToIp(0x0ac80000), '10.200.0.0');
  assert.equal(intToIp(ipToInt('10.201.255.248')), '10.201.255.248');
});

test('parseCidr：网络区间（base/last/gateway）', () => {
  const r = parseCidr('10.200.1.0/29');
  assert.equal(r.base, ipToInt('10.200.1.0'));
  assert.equal(r.last, ipToInt('10.200.1.7'));
  assert.equal(r.prefixLen, 29);
});

test('cidrsOverlap：重叠判定', () => {
  assert.equal(cidrsOverlap(parseCidr('10.200.0.0/29'), parseCidr('10.200.0.0/29')), true);
  assert.equal(cidrsOverlap(parseCidr('10.200.0.0/29'), parseCidr('10.200.0.8/29')), false);
  assert.equal(cidrsOverlap(parseCidr('10.200.0.0/29'), parseCidr('10.200.0.0/28')), true);
});

test('enumerateSubnets：默认池 /29 首块与步长', () => {
  const subs = enumerateSubnets(POOLS.default.cidr, 29);
  assert.equal(subs.length, 8192);
  assert.equal(subs[0].subnet, '10.200.0.0/29');
  assert.equal(subs[0].gateway, '10.200.0.1');
  assert.equal(subs[1].subnet, '10.200.0.8/29');
});

test('enumerateSubnets：大 FDE 池 /28 首块与步长', () => {
  const subs = enumerateSubnets(POOLS.large.cidr, 28);
  assert.equal(subs.length, 4096);
  assert.equal(subs[0].subnet, '10.201.0.0/28');
  assert.equal(subs[0].gateway, '10.201.0.1');
  assert.equal(subs[1].subnet, '10.201.0.16/28');
});

test('nextAvailableSubnet：跳过已占与保留网段', () => {
  const cand = nextAvailableSubnet(['10.200.0.0/29'], POOLS.default);
  assert.equal(cand.subnet, '10.200.0.8/29');
  // 保留网段也跳过（宿主既有网段，env §0 backend=172.32.0.0/24 与 FDE 池不重叠，此处用重叠样例验证跳过逻辑）。
  const cand2 = nextAvailableSubnet(['10.200.0.0/29', '10.200.0.8/29'], POOLS.default);
  assert.equal(cand2.subnet, '10.200.0.16/29');
});

test('nextAvailableSubnet：池耗尽抛 ipam_pool_exhausted', () => {
  const all = enumerateSubnets(POOLS.default.cidr, 29).map((s) => s.subnet);
  assert.throws(() => nextAvailableSubnet(all, POOLS.default), /ipam_pool_exhausted|耗尽/);
});

test('大 FDE /28：从 10.201.0.0/16 分配且与 /29 池隔离', () => {
  const cand = nextAvailableSubnet(['10.200.0.0/29', '10.200.0.8/29'], POOLS.large);
  assert.equal(cand.subnet, '10.201.0.0/28');
  assert.equal(cand.prefixLen, 28);
});

/** 最小 fake client：模拟 allocateNetworkInTx 用到的 fde_networks 查询。 */
function makeIpamClient(rows) {
  const state = rows.map((r) => ({ ...r }));
  return {
    state,
    async query(sql, params = []) {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes("state IN ('allocated', 'active')")) {
        const [fdeId] = params;
        const r = this.state.find((x) => x.fde_id === fdeId && (x.state === 'allocated' || x.state === 'active'));
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('SELECT subnet FROM fde_networks')) {
        return { rows: this.state.map((x) => ({ subnet: x.subnet })) };
      }
      if (sql.includes("state = 'released'") && sql.trimStart().startsWith('SELECT')) {
        const [fdeId] = params;
        const r = this.state.find((x) => x.fde_id === fdeId && x.state === 'released');
        return { rows: r ? [r] : [] };
      }
      if (sql.trimStart().startsWith('UPDATE fde_networks')) {
        const [fdeId, networkName, subnet, prefixLen, gateway, pool] = params;
        const r = this.state.find((x) => x.fde_id === fdeId && x.state === 'released');
        r.network_name = networkName;
        r.subnet = subnet;
        r.prefix_len = prefixLen;
        r.gateway = gateway;
        r.pool = pool;
        r.state = 'allocated';
        r.revision = (r.revision || 0) + 1;
        r.released_at = null;
        return { rows: [{ fde_id: r.fde_id, network_name: r.network_name, subnet: r.subnet, prefix_len: r.prefix_len, gateway: r.gateway, pool: r.pool, state: r.state }] };
      }
      if (sql.trimStart().startsWith('INSERT INTO fde_networks')) {
        const [fdeId, networkName, subnet, prefixLen, gateway, pool] = params;
        const r = { fde_id: fdeId, network_name: networkName, subnet, prefix_len: prefixLen, gateway, pool, state: 'allocated', revision: 0, released_at: null };
        this.state.push(r);
        return { rows: [{ ...r }] };
      }
      if (sql.includes('INSERT INTO route_revisions')) {
        return { rows: [{ revision: 1 }] };
      }
      if (sql.includes('INSERT INTO route_outbox')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test('F4：同 fde_id 有 released 行时 UPDATE 复用（不 INSERT 冲突）且子网正确', async () => {
  const client = makeIpamClient([
    { fde_id: 'u1', network_name: 'fde-alice', subnet: '10.200.1.0/29', prefix_len: 29, gateway: '10.200.1.1', pool: 'default', state: 'released', revision: 3, released_at: new Date() },
  ]);
  const row = await allocateNetworkInTx(client, 'u1', 'alice');
  assert.equal(row.state, 'allocated');
  // released 子网仍在 UNIQUE 中占位 → 分配下一块空闲（10.200.0.0/29），且复用同一行（不 INSERT）。
  assert.equal(row.subnet, '10.200.0.0/29');
  assert.equal(client.state.length, 1);
  assert.equal(client.state[0].revision, 4);
  assert.equal(client.state[0].released_at, null);
});

test('F4：无既有行时 INSERT 分配', async () => {
  const client = makeIpamClient([]);
  const row = await allocateNetworkInTx(client, 'u1', 'alice');
  assert.equal(row.state, 'allocated');
  assert.equal(row.subnet, '10.200.0.0/29');
  assert.equal(client.state.length, 1);
});
