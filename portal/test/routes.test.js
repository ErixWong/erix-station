// 单测：routes.js（来源规则派生 /29 与 /28、revision head 过滤 + tombstone 丢弃、显式 router+service）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveSourceRanges,
  filterCurrentHead,
  generateTraefikConfig,
  validateTraefikConfig,
  rebuildRoutes,
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

test('internal router：priority > portal（200 > 100）+ PathPrefix + ipAllowList 精确 subnet', () => {
  const text = generateTraefikConfig({
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: ['10.200.1.0/29', '10.201.7.0/28'],
  });
  // internal 前缀 + Host(station) 双条件；priority 200 > portal 100
  assert.ok(text.includes('Host(`station.localhost`) && PathPrefix(`/api/internal`)'));
  assert.match(text, /    internal:\n      entryPoints: \[web\]\n      rule: "Host\(`station\.localhost`\) && PathPrefix\(`\/api\/internal`\)"\n      priority: 200/);
  // portal 路由 priority 100 < internal 200
  assert.match(text, /    portal:\n      entryPoints: \[web\]\n      rule: "Host\(`station\.localhost`\)"\n      priority: 100/);
  // ipAllowList 精确 /29 与 /28，不含 /16 池
  assert.match(text, /sourceRange: \["10\.200\.1\.0\/29", "10\.201\.7\.0\/28"\]/);
  assert.ok(!text.includes('10.200.0.0/16'));
  assert.ok(!text.includes('10.201.0.0/16'));
  // internal 挂 internal-allow 中间件（ipAllowList），无 forwardAuth
  assert.ok(text.includes('middlewares: [internal-allow]'));
  assert.ok(!/    internal:\n(?:.*\n)*?forwardAuth:/.test(text));
});

test('deriveSourceRanges：非 FDE 网段（backend 等）不在 allowlist（只取传入的 fde_networks 行）', () => {
  // deriveSourceRanges 只投影 fde_networks 行；backend 子网不进入（由 readRouteDesiredState 从 fde_networks 表过滤）。
  const ranges = deriveSourceRanges([{ subnet: '10.200.1.0/29' }]);
  assert.deepEqual(ranges, ['10.200.1.0/29']);
  assert.ok(!ranges.includes('172.32.0.0/24'));
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

test('validateTraefikConfig：结构断言 / 控制字符 / 重复 router 名拒绝', () => {
  const allocs = [{ hostname: 'alice-p-proj1-4016.fde.localhost' }];
  const name = 'fde-alice-p-proj1-4016';
  const good = ['http:', '  routers:', `    ${name}:`, '  middlewares:', '  services:', `    ${name}:`].join('\n');
  assert.equal(validateTraefikConfig(good, allocs), true);
  assert.throws(() => validateTraefikConfig('', allocs), /empty/);
  assert.throws(() => validateTraefikConfig('foo', allocs), /missing sections/);
  assert.throws(() => validateTraefikConfig(`${good}\n\u0000`, allocs), /control/);
  assert.throws(() => validateTraefikConfig(good, [allocs[0], allocs[0]]), /duplicate/);
});

test('generateTraefikConfig：每 active FDE 生成 LLM 路由（Host(llm) && ClientIP(精确 subnet) → llm-hub，无兜底）', () => {
  const text = generateTraefikConfig({
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: ['10.200.1.0/29'],
    llmHost: 'llm.localhost',
    llmGatewayUrl: 'http://127.0.0.1:4000',
    llmNetworks: [{ subnet: '10.200.1.0/29', fdeName: 'alice' }],
  });
  assert.match(text, /fde-alice-llm:/);
  assert.ok(text.includes('Host(`llm.localhost`) && ClientIP(`10.200.1.0/29`)'));
  assert.match(text, /alice-llm-auth/);
  assert.ok(text.includes('Authorization: "Bearer erix-placeholder"'));
  assert.ok(text.includes('X-FDE-Identity: "alice"'));
  assert.ok(text.includes('service: llm-hub'));
  assert.ok(text.includes('url: "http://127.0.0.1:4000"'));
  // 禁止无 ClientIP 条件的兜底路由
  assert.ok(!text.includes('rule: "Host(`llm.localhost`)"'));
});

test('generateTraefikConfig：hostname/router key 注入面拒绝（换行/控制字符/非法字符）', () => {
  const base = {
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: [],
  };
  assert.throws(
    () => generateTraefikConfig({ ...base, allocations: [{ id: 'pa1', hostname: 'alice-p-proj1-4016.fde.localhost\nbad', port: 4016, backendUrl: 'http://10.200.1.2:4016' }] }),
    /invalid allocation hostname/,
  );
  assert.throws(
    () => generateTraefikConfig({ ...base, allocations: [{ id: 'pa1', hostname: 'ALICE.fde.localhost', port: 4016, backendUrl: 'http://10.200.1.2:4016' }] }),
    /invalid allocation hostname/,
  );
  assert.throws(() => generateTraefikConfig({ ...base, portalHost: 'station.localhost\n' }), /invalid portal hostname/);
});

test('M4：llm-hub service 含 responseForwarding.flushInterval ≤ 100ms', () => {
  const text = generateTraefikConfig({
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: ['10.200.1.0/29'],
    llmHost: 'llm.localhost',
    llmGatewayUrl: 'http://127.0.0.1:4000',
    llmNetworks: [{ subnet: '10.200.1.0/29', fdeName: 'alice' }],
  });
  assert.ok(text.includes('    llm-hub:'));
  assert.ok(text.includes('        responseForwarding:'));
  assert.match(text, /flushInterval: 100ms/);
});

test('M3：含换行/控制字符的 llmGatewayUrl/portalBackendUrl/entryPoint 拒绝（不落盘）', () => {
  const base = {
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: [],
  };
  assert.throws(
    () => generateTraefikConfig({ ...base, llmHost: 'llm.localhost', llmGatewayUrl: 'http://127.0.0.1:4000\ninjected: yes', llmNetworks: [{ subnet: '10.200.1.0/29', fdeName: 'alice' }] }),
    /control characters/,
  );
  assert.throws(() => generateTraefikConfig({ ...base, portalBackendUrl: 'http://127.0.0.1:18080\nx' }), /control characters/);
  assert.throws(() => generateTraefikConfig({ ...base, entryPoint: 'web\t' }), /control characters/);
  assert.throws(() => generateTraefikConfig({ ...base, portalBackendUrl: 'ftp://127.0.0.1:8080' }), /http\/https/);
});

test('validateTraefikConfig：tab/CR 控制字符拒绝（不含合法换行分隔符）', () => {
  const allocs = [{ hostname: 'alice-p-proj1-4016.fde.localhost' }];
  const name = 'fde-alice-p-proj1-4016';
  const good = ['http:', '  routers:', `    ${name}:`, '  middlewares:', '  services:', `    ${name}:`].join('\n');
  assert.equal(validateTraefikConfig(good, allocs), true);
  assert.throws(() => validateTraefikConfig(`${good}\n\t`, allocs), /control/);
  assert.throws(() => validateTraefikConfig(good.replace(/\n/g, '\r\n'), allocs), /control/);
});

test('M3：含换行的 LLM_GATEWAY_HOST 在发布路径被拒绝且不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-m3-'));
  const pool = {
    async query(sql) {
      if (sql.includes('FROM fde_networks')) {
        return { rows: [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }] };
      }
      if (sql.includes('FROM port_allocations')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  const config = {
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    traefikEntryPoint: 'web',
    llmHost: 'llm.localhost',
    llmGatewayUrl: 'http://127.0.0.1:4000\ninjected: yes',
    traefikDynamicDir: dir,
    traefikDynamicFile: 'routes.yml',
  };
  await assert.rejects(() => rebuildRoutes(pool, config), /control characters/);
  assert.equal(fs.existsSync(path.join(dir, 'routes.yml')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
