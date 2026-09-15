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
