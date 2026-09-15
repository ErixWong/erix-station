// 单测：routes.js（来源规则派生 /29 与 /28、revision head 过滤 + tombstone 丢弃、显式 router+service）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSourceRanges,
  filterCurrentHead,
  generateTraefikConfig,
  validateTraefikConfig,
} from '../src/routes.js';

test('deriveSourceRanges：从 fde_networks 精确 subnet 派生（/29 与 /28），禁止 /16 池', () => {
  const ranges = deriveSourceRanges([
    { subnet: '10.200.1.0/29' },
    { subnet: '10.201.7.0/28' },
  ]);
  assert.deepEqual(ranges, ['10.200.1.0/29', '10.201.7.0/28']);
  // 池范围 ≠ 放行范围：不得出现 /16 聚合。
  assert.ok(!ranges.some((r) => r.endsWith('/16')));
});

test('filterCurrentHead：revision==head 发布；revision<head 晚到旧事件/旧 tombstone 丢弃', () => {
  const rows = [
    { aggregate: 'port_allocation', aggregate_id: 'a1', revision: 1, op: 'upsert' },
    { aggregate: 'port_allocation', aggregate_id: 'a1', revision: 2, op: 'delete' }, // 旧 tombstone 晚到（head 已 3）
    { aggregate: 'port_allocation', aggregate_id: 'a2', revision: 3, op: 'upsert' },
  ];
  const heads = new Map([['port_allocation:a1', 3], ['port_allocation:a2', 3]]);
  const { current, stale } = filterCurrentHead(rows, heads);
  assert.deepEqual(current.map((r) => r.revision), [3]);
  assert.deepEqual(stale.map((r) => r.revision), [1, 2]);
});

test('filterCurrentHead：head 缺失视为 current（防御）', () => {
  const rows = [{ aggregate: 'x', aggregate_id: 'y', revision: 1, op: 'upsert' }];
  const { current, stale } = filterCurrentHead(rows, new Map());
  assert.equal(current.length, 1);
  assert.equal(stale.length, 0);
});

test('generateTraefikConfig：portal 路由 + internal ipAllowList + 每 allocation 一条显式 router+service', () => {
  const text = generateTraefikConfig({
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [
      { id: 'pa1', hostname: 'alice-p-proj1-4016.fde.localhost', port: 4016, backendUrl: 'http://10.200.1.2:4016' },
    ],
    sourceRanges: ['10.200.1.0/29'],
  });
  // 显式 router（非通配）
  assert.match(text, /fde-alice-p-proj1-4016:/);
  assert.match(text, /Host\(`alice-p-proj1-4016\.fde\.localhost`\)/);
  // 每 allocation 一条 service，backend 为该容器 IP:port
  assert.match(text, /url: "http:\/\/10\.200\.1\.2:4016"/);
  // portal 路由沿用
  assert.match(text, /Host\(`station\.localhost`\)/);
  // forwardAuth 占位 + strip-cookie
  assert.match(text, /forwardAuth:/);
  assert.match(text, /api\/forward-auth/);
  assert.match(text, /strip-cookie/);
  // internal ipAllowList 精确 subnet（非 /16）
  assert.match(text, /sourceRange: \["10\.200\.1\.0\/29"\]/);
  assert.ok(!text.includes('10.200.0.0/16'));
  assert.ok(!text.includes('10.201.0.0/16'));
});

test('generateTraefikConfig：大 FDE /28 来源规则精确写入', () => {
  const text = generateTraefikConfig({
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [{ id: 'pa1', hostname: 'bob-p-proj1-4000.fde.localhost', port: 4000, backendUrl: 'http://10.201.7.2:4000' }],
    sourceRanges: ['10.201.7.0/28'],
  });
  assert.match(text, /sourceRange: \["10\.201\.7\.0\/28"\]/);
  assert.ok(!text.includes('/16'));
});

test('validateTraefikConfig：非空 / 关键节 / 重复 router 名拒绝', () => {
  const allocs = [{ hostname: 'alice-p-proj1-4016.fde.localhost' }];
  assert.equal(validateTraefikConfig('http:\n  routers:\n  services:\n', allocs), true);
  assert.throws(() => validateTraefikConfig('', allocs), /empty/);
  assert.throws(() => validateTraefikConfig('foo', allocs), /missing sections/);
  assert.throws(() => validateTraefikConfig('http:\n  routers:\n  services:\n', [allocs[0], allocs[0]]), /duplicate/);
});
