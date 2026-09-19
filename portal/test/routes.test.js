// 单测：routes.js（来源规则派生 /29 与 /28、revision head 过滤 + tombstone 丢弃、显式 router+service、
//       issue #38 Phase B1 LLM 段发布：generateLlmTraefikConfig 幂等/tombstone/service 去重/权限 600）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deriveSourceRanges,
  filterCurrentHead,
  generateTraefikConfig,
  generateLlmTraefikConfig,
  validateTraefikConfig,
  validateLlmTraefikConfig,
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

// ---------------------------------------------------------------------------
// issue #38 Phase B1：LLM 段发布（generateLlmTraefikConfig，纯函数渲染）
// ---------------------------------------------------------------------------

const BINDING_ALICE = {
  fdeName: 'alice',
  subnet: '10.200.1.0/29',
  providerId: 'deadbeef-1111-2222-3333-444444444444',
  baseUrl: 'https://api.upstream.example.com/v1',
  apiKey: 'sk-test-1234567890', // 假 key（红线：测试断言不得出现真 key）
};
const BINDING_BOB = {
  fdeName: 'bob',
  subnet: '10.201.7.0/28',
  providerId: 'cafebabe-aaaa-bbbb-cccc-dddddddddddd',
  baseUrl: 'https://api.other.example.com',
  apiKey: 'sk-test-0987654321',
};

// 同 provider 的第二个 FDE（service 共享用）。
const BINDING_CAROL = { ...BINDING_ALICE, fdeName: 'carol', subnet: '10.202.3.0/29' };

function llmArgs(bindings) {
  return { entryPoint: 'web', llmHost: 'llm.localhost', llmBindings: bindings };
}

test('B1：LLM 段渲染——per-FDE router + key 注入 middleware + per-provider service（Host 唯一口径 llmHost）', () => {
  const text = generateLlmTraefikConfig(llmArgs([BINDING_ALICE]));
  // router：llm-<fdeName>，Host(llmHost) && ClientIP(精确 subnet)，无兜底路由
  assert.match(text, /    llm-alice:/);
  assert.ok(text.includes('rule: "Host(`llm.localhost`) && ClientIP(`10.200.1.0/29`)"'));
  assert.ok(!text.includes('rule: "Host(`llm.localhost`)"'), '禁止无 ClientIP 条件的兜底路由（fail-closed）');
  assert.ok(text.includes('      middlewares: [llm-key-alice]'));
  assert.ok(text.includes('      service: llm-provider-deadbeef'));
  // middleware：llm-key-<fdeName> 注入明文 key（v3 headers.request.set）
  assert.match(text, /    llm-key-alice:/);
  assert.ok(text.includes('            Authorization: "Bearer sk-test-1234567890"'));
  assert.ok(text.includes('        request:') && text.includes('          set:'));
  // service：llm-provider-<providerId 前 8 位> → provider base_url（直连上游，无 llm-hub）
  assert.match(text, /    llm-provider-deadbeef:/);
  assert.ok(text.includes('          - url: "https://api.upstream.example.com/v1"'));
  assert.ok(!text.includes('llm-hub'), 'Phase B1 起直连 provider base_url，不再经过 llm-hub 占位');
});

test('B1：发布幂等——同 DB 状态两次渲染字节相同（纯函数 + 排序）', () => {
  const bindings = [BINDING_BOB, BINDING_ALICE]; // 乱序输入也应产出确定排序
  const t1 = generateLlmTraefikConfig(llmArgs(bindings));
  const t2 = generateLlmTraefikConfig(llmArgs(bindings));
  assert.equal(t1, t2);
  // 排序：alice 在 bob 前
  assert.ok(t1.indexOf('llm-alice:') < t1.indexOf('llm-bob:'));
  validateLlmTraefikConfig(t1, bindings);
});

test('B1：tombstone——delete/revoke 后产物不含该 FDE 的 llm-<name> router/middleware', () => {
  const before = generateLlmTraefikConfig(llmArgs([BINDING_ALICE, BINDING_BOB]));
  assert.ok(before.includes('llm-alice:') && before.includes('llm-key-alice:'));
  // 消费 delete tombstone 后等价于「渲染时该行已不在 active 集合」——全量重建天然幂等收敛
  const after = generateLlmTraefikConfig(llmArgs([BINDING_BOB]));
  assert.ok(!after.includes('llm-alice:'), 'router 必须摘除');
  assert.ok(!after.includes('llm-key-alice:'), 'middleware 必须摘除');
  assert.ok(!after.includes('sk-test-1234567890'), 'key 注入必须随 FDE 一起消失');
  assert.ok(after.includes('llm-bob:') && after.includes('llm-key-bob:'), '其它 FDE 不受影响');
  validateLlmTraefikConfig(after, [BINDING_BOB]);
});

test('B1：service 共享——两个 FDE 同 provider 只一份 service；最后一个 FDE 删除 → service 摘除', () => {
  const shared = generateLlmTraefikConfig(llmArgs([BINDING_ALICE, BINDING_CAROL]));
  assert.equal(shared.split('\n').filter((l) => l === '    llm-provider-deadbeef:').length, 1, '同 provider 的 service 必须去重为一份');
  assert.ok(shared.includes('      service: llm-provider-deadbeef'));
  // 最后一个引用者删除 → service 段整体为空 → 产物为 http: {}
  const empty = generateLlmTraefikConfig(llmArgs([]));
  assert.equal(empty, 'http: {}\n');
  assert.ok(!empty.includes('llm-provider-'));
});

test('B1：fail-closed——api_key 为 NULL（未配置）的 binding 不生成路由、不注入空凭据', () => {
  const text = generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, apiKey: null }]));
  assert.equal(text, 'http: {}\n');
});

test('B1：注入面拒绝——api_key/baseUrl 含控制字符、fdeName 非法、providerId 非法（不落盘）', () => {
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, apiKey: 'sk-test\ninjected: yes' }])),
    /apiKey contains control characters/,
  );
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, baseUrl: 'https://api.example.com\nx' }])),
    /control characters/,
  );
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, baseUrl: 'ftp://api.example.com' }])),
    /http\/https/,
  );
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, fdeName: 'Alice' }])),
    /invalid fde name/,
  );
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, providerId: '-bad-id' }])),
    /invalid provider id/,
  );
  assert.throws(
    () => generateLlmTraefikConfig(llmArgs([BINDING_ALICE, BINDING_BOB]).llmHost = null) , /undefined|\./, // noop guard
  );
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

test('M4：LLM provider service 含 responseForwarding.flushInterval ≤ 100ms（流式必需）', () => {
  const text = generateLlmTraefikConfig(llmArgs([BINDING_ALICE]));
  assert.ok(text.includes('    llm-provider-deadbeef:'));
  assert.ok(text.includes('        responseForwarding:'));
  assert.match(text, /flushInterval: 100ms/);
});

test('M3：含换行/控制字符的 portalBackendUrl/entryPoint 拒绝（不落盘）', () => {
  const base = {
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    entryPoint: 'web',
    allocations: [],
    sourceRanges: [],
  };
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

test('M3：含换行/控制字符的 LLM 发布事实（base_url）在发布路径被拒绝且两份文件都不落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-m3-'));
  const pool = {
    async query(sql) {
      if (sql.includes('FROM fde_networks')) {
        return { rows: [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }] };
      }
      if (sql.includes('FROM fde_llm_bindings b')) {
        return {
          rows: [{
            fde_id: 'u1', api_key: 'sk-test-1234567890',
            provider_id: 'deadbeef-1111-2222-3333-444444444444',
            base_url: 'https://api.upstream.example.com\ninjected: yes',
            fde_name: 'alice', subnet: '10.200.1.0/29',
          }],
        };
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
    traefikDynamicDir: dir,
    traefikDynamicFile: 'routes.yml',
    traefikLlmDynamicFile: 'llm-routes.yml',
  };
  await assert.rejects(() => rebuildRoutes(pool, config), /control characters/);
  assert.equal(fs.existsSync(path.join(dir, 'routes.yml')), false, '渲染失败时主文件也不得落盘');
  assert.equal(fs.existsSync(path.join(dir, 'llm-routes.yml')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// issue #38 Phase B1：rebuildRoutes 文件发布——拆分（routes.yml 0644 / llm-routes.yml 0600）
// ---------------------------------------------------------------------------

function makePublishPool({ bindings = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM fde_networks')) {
        return { rows: [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }] };
      }
      if (sql.includes('FROM fde_llm_bindings b')) {
        return { rows: bindings };
      }
      if (sql.includes('FROM port_allocations')) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

const PUBLISH_CONFIG_BASE = {
  portalHost: 'station.localhost',
  portalBackendUrl: 'http://127.0.0.1:18080',
  traefikEntryPoint: 'web',
  llmHost: 'llm.localhost',
  traefikDynamicFile: 'routes.yml',
  traefikLlmDynamicFile: 'llm-routes.yml',
};

test('B1：rebuildRoutes 拆两份发布——routes.yml 0644 无密钥 / llm-routes.yml 0600 含 key 注入', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-b1-'));
  const pool = makePublishPool({
    bindings: [{
      fde_id: 'u1', api_key: 'sk-test-1234567890',
      provider_id: 'deadbeef-1111-2222-3333-444444444444',
      base_url: 'https://api.upstream.example.com/v1',
      fde_name: 'alice', subnet: '10.200.1.0/29',
    }],
  });
  const config = { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir };
  const out = await rebuildRoutes(pool, config);
  assert.equal(out.target, path.join(dir, 'routes.yml'));
  assert.equal(out.llmTarget, path.join(dir, 'llm-routes.yml'));

  const mainText = fs.readFileSync(out.target, 'utf8');
  const llmText = fs.readFileSync(out.llmTarget, 'utf8');
  // 权限红线：含 api_key 明文的文件必须 600；主文件保持 644
  assert.equal(fs.statSync(out.target).mode & 0o777, 0o644, 'routes.yml 无密钥，0644');
  assert.equal(fs.statSync(out.llmTarget).mode & 0o777, 0o600, 'llm-routes.yml 含明文 key，必须 0600');
  // 密钥隔离：key 只出现在 llm 文件
  assert.ok(llmText.includes('Authorization: "Bearer sk-test-1234567890"'));
  assert.ok(!mainText.includes('sk-test-1234567890'), '主文件不得含任何 api_key 明文');
  assert.ok(!mainText.includes('llm-alice'), '主文件不再携带 LLM 段');
  // llm 文件内容来自 fde_llm_bindings + llm_providers + fde_networks 的 DB 事实
  assert.ok(llmText.includes('Host(`llm.localhost`) && ClientIP(`10.200.1.0/29`)'));
  assert.ok(llmText.includes('      service: llm-provider-deadbeef'));

  // 幂等：同状态二次发布字节相同（含权限不变）
  const out2 = await rebuildRoutes(pool, config);
  assert.equal(fs.readFileSync(out2.target, 'utf8'), mainText);
  assert.equal(fs.readFileSync(out2.llmTarget, 'utf8'), llmText);
  assert.equal(fs.statSync(out2.llmTarget).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('B1：无 LLM 配置的 FDE 发布——llm 产物为 http: {}、主文件正常、权限仍 600/644', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-b1-none-'));
  const config = { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir };
  const out = await rebuildRoutes(makePublishPool({ bindings: [] }), config);
  const mainText = fs.readFileSync(out.target, 'utf8');
  const llmText = fs.readFileSync(out.llmTarget, 'utf8');
  assert.equal(llmText, 'http: {}\n');
  assert.ok(mainText.includes('Host(`station.localhost`)'), '无 LLM 配置不影响主路由发布');
  assert.equal(fs.statSync(out.llmTarget).mode & 0o777, 0o600, '即使空 LLM 段文件也保持 600（下一版可能含 key）');
  fs.rmSync(dir, { recursive: true, force: true });
});
