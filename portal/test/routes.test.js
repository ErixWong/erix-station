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
  LLM_EMPTY_CONFIG,
  validateTraefikConfig,
  validateLlmTraefikConfig,
  rebuildRoutes,
  startRoutesLoop,
  FULL_REBUILD_AGGREGATE_ID,
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
  // middleware：llm-key-<fdeName> 注入明文 key（Traefik v3 headers.customRequestHeaders，e2e 实测口径）
  assert.match(text, /    llm-key-alice:/);
  assert.ok(text.includes('          Authorization: "Bearer sk-test-1234567890"'));
  assert.ok(text.includes('        customRequestHeaders:'));
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
  // 最后一个引用者删除 → service 段整体为空 → 产物为 null（调用方 unlink；任何空文件形态都被 Traefik 拒且连坐目录）
  const empty = generateLlmTraefikConfig(llmArgs([]));
  assert.equal(empty, LLM_EMPTY_CONFIG);
  assert.equal(empty, null);
});

test('B1：fail-closed——api_key 为 NULL（未配置）的 binding 不生成路由、不注入空凭据', () => {
  const text = generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, apiKey: null }]));
  assert.equal(text, LLM_EMPTY_CONFIG);
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
  const pool = {
    sqlLog: [],
    async query(sql, params = []) {
      this.sqlLog.push({ sql, params });
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
  return pool;
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

test('B1：无 LLM 配置的 FDE 发布——llm 文件不存在（null 契约）、主文件正常、权限仍 644', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-b1-none-'));
  const config = { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir };
  const out = await rebuildRoutes(makePublishPool({ bindings: [] }), config);
  const mainText = fs.readFileSync(out.target, 'utf8');
  assert.equal(out.llmPublished, false, '零 binding → 不写 llm 文件');
  assert.equal(fs.existsSync(out.llmTarget), false, 'llm 文件不得存在（空文件形态被 Traefik 拒且连坐目录）');
  assert.ok(mainText.includes('Host(`station.localhost`)'), '无 LLM 配置不影响主路由发布');
  assert.equal(fs.statSync(out.target).mode & 0o777, 0o644, '主文件 644（无密钥）');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F5：providerId / entryPoint YAML 注入面收口（评审复现串：a: bad / a,foo / a#foo / a foo）
// ---------------------------------------------------------------------------

test('F5：providerId 注入面——YAML 元字符串（: , # 空格）一律拒绝，先校验后写', () => {
  for (const bad of ['a: bad', 'a,foo', 'a#foo', 'a foo']) {
    assert.throws(
      () => generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, providerId: bad }])),
      /invalid provider id/,
      `providerId=${JSON.stringify(bad)} 必须拒绝（评审复现串）`,
    );
  }
  // 合法：UUID（DB 主键形态）与安全短 token 均通过
  assert.ok(generateLlmTraefikConfig(llmArgs([BINDING_ALICE])).includes('llm-provider-deadbeef'));
  const short = generateLlmTraefikConfig(llmArgs([{ ...BINDING_ALICE, providerId: 'abc_123-XY' }]));
  assert.ok(short.includes('llm-provider-abc_123-'), 'service key = llm-provider-<providerId 前 8 位>');
  assert.ok(short.includes('      service: llm-provider-abc_123-'));
});

test('F5：entryPoint 注入面——仅安全 token（^[a-zA-Z0-9_-]+$），非法即抛（LLM 段 + 主配置同口径）', () => {
  for (const bad of ['web,internal', 'web: x', 'web#x', 'web x', 'web]x']) {
    assert.throws(
      () => generateLlmTraefikConfig({ ...llmArgs([BINDING_ALICE]), entryPoint: bad }),
      /entryPoint/,
      `entryPoint=${JSON.stringify(bad)} 必须拒绝`,
    );
  }
  // 控制字符仍由 assertSafeString 先行拒绝（报错信息区分两层原因）
  assert.throws(
    () => generateLlmTraefikConfig({ ...llmArgs([BINDING_ALICE]), entryPoint: 'web\nx' }),
    /control characters/,
  );
  assert.ok(
    generateLlmTraefikConfig({ ...llmArgs([BINDING_ALICE]), entryPoint: 'web_secure-1' }).includes('entryPoints: [web_secure-1]'),
    '合法安全 token 通过',
  );
  // 主配置同一白名单（entryPoint 裸拼进 entryPoints flow list，同注入面）
  const base = {
    portalHost: 'station.localhost',
    portalBackendUrl: 'http://127.0.0.1:18080',
    allocations: [],
    sourceRanges: [],
  };
  assert.throws(() => generateTraefikConfig({ ...base, entryPoint: 'web,internal' }), /entryPoint/);
  assert.throws(() => generateTraefikConfig({ ...base, entryPoint: 'web: x' }), /entryPoint/);
  assert.ok(generateTraefikConfig({ ...base, entryPoint: 'web-1' }).includes('entryPoints: [web-1]'));
});

// ---------------------------------------------------------------------------
// F3：发布 fail-closed——先发含密文件、再无密主文件；任一步失败按红线处置
// ---------------------------------------------------------------------------

test('F3：零 binding → 摘除残留 llm-routes.yml（unlink 成功路径），主文件正常发布', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-f3-unlink-'));
  const llmTarget = path.join(dir, 'llm-routes.yml');
  // 预置旧含密文件（上一代 key 仍在盘上 = 评审发现的残留场景）
  fs.writeFileSync(llmTarget, 'http:\n  routers:\n    llm-alice:\n      # stale secret-bearing content\n', { mode: 0o600 });
  const out = await rebuildRoutes(makePublishPool({ bindings: [] }), { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir });
  assert.equal(out.llmPublished, false);
  assert.equal(fs.existsSync(llmTarget), false, '零 binding 时残留含密文件必须被摘除');
  assert.ok(fs.existsSync(out.target), '主文件正常发布');
  assert.equal(fs.statSync(out.target).mode & 0o777, 0o644);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F3：零 binding 但 unlink 失败（EACCES）→ 抛错并明示「含密文件可能残留」，绝不静默', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-f3-unlink-fail-'));
  const llmTarget = path.join(dir, 'llm-routes.yml');
  fs.writeFileSync(llmTarget, 'stale-secret-bearing-content', { mode: 0o600 });
  fs.chmodSync(dir, 0o000); // 目录只读：unlink 必然 EACCES
  const errors = [];
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: (m) => errors.push(m) };
  try {
    await assert.rejects(
      () => rebuildRoutes(makePublishPool({ bindings: [] }), { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log }),
      /含密文件可能残留/,
      'unlink 失败必须抛出含「可能残留」语义的错',
    );
  } finally {
    fs.chmodSync(dir, 0o700); // 恢复权限供清理（也供下方断言读到残留文件）
  }
  assert.ok(errors.some((m) => m.includes('含密文件可能残留')), '日志必须明示异常态（旧 key 可能仍被 Traefik 使用）');
  assert.ok(warns.length === 0, '摘除失败不是 warn 级，必须 error 级');
  assert.ok(fs.existsSync(llmTarget), '摘除失败时旧含密文件确实仍在盘上（正是要报告的异常态）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('F3：有 binding 先发密后发明——主文件发布失败时新版含密文件已发布，随后 fail-closed 摘除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-f3-rollback-'));
  const llmTarget = path.join(dir, 'llm-routes.yml');
  // 预置旧含密文件（旧 key 代）+ 把 routes.yml 预置为目录：第 2 步 rename 目标非法 → 主文件发布失败
  fs.writeFileSync(llmTarget, 'old-generation-secret', { mode: 0o600 });
  fs.mkdirSync(path.join(dir, 'routes.yml'));
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: () => {} };
  const pool = makePublishPool({
    bindings: [{
      fde_id: 'u1', api_key: 'sk-test-1234567890',
      provider_id: 'deadbeef-1111-2222-3333-444444444444',
      base_url: 'https://api.upstream.example.com/v1',
      fde_name: 'alice', subnet: '10.200.1.0/29',
    }],
  });
  await assert.rejects(
    () => rebuildRoutes(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log }),
    /ENOTDIR|EISDIR|rename/i,
    '主文件发布失败必须把 rename 错误向上抛',
  );
  // fail-closed 回滚：含密文件被摘除——旧 key 不得在新主文件缺位的情况下继续被 Traefik 使用
  assert.equal(fs.existsSync(llmTarget), false, '主文件失败 → 含密文件必须 fail-closed 摘除');
  assert.ok(
    warns.some((m) => m.includes('fail-closed') && m.includes('已摘除 llm-routes.yml')),
    '日志必须能看出「已按 fail-closed 摘除含密文件」',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('N4（Round C 评审）：主文件发布失败 + 含密文件摘除失败 → error 级日志明示「可能残留」+ 抛出含「可能残留」的错误，绝不谎称已摘除', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-n4-rollback-unlink-fail-'));
  const llmTarget = path.join(dir, 'llm-routes.yml');
  // 有 binding → 第 1 步成功写含密文件；routes.yml 预置为目录 → 第 2 步 rename 失败；
  // 注入 unlink 失败（仅 llm-routes.yml）→ 回滚摘除失败（旧代码会吞掉并谎称「已摘除」）。
  fs.mkdirSync(path.join(dir, 'routes.yml'));
  const pool = makePublishPool({
    bindings: [{
      fde_id: 'u1', api_key: 'sk-test-1234567890',
      provider_id: 'deadbeef-1111-2222-3333-444444444444',
      base_url: 'https://api.upstream.example.com/v1',
      fde_name: 'alice', subnet: '10.200.1.0/29',
    }],
  });
  const errors = [];
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: (m) => errors.push(m) };
  const fsp = fs.promises;
  const origUnlink = fsp.unlink;
  fsp.unlink = async (p) => {
    if (String(p) === llmTarget) {
      const e = new Error('EPERM: injected unlink failure');
      e.code = 'EPERM';
      throw e;
    }
    return origUnlink(p);
  };
  try {
    await assert.rejects(
      () => rebuildRoutes(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log }),
      /含密文件可能残留/,
      '摘除失败必须把「可能残留」事实带进抛出的错误',
    );
  } finally {
    fsp.unlink = origUnlink; // 恢复，避免影响其它用例
  }
  assert.ok(fs.existsSync(llmTarget), '含密文件确实残留在盘上（正是要报告的异常态）');
  assert.ok(
    errors.some((m) => m.includes('含密文件可能残留') && m.includes('Traefik')),
    '必须 error 级日志明示「含密文件可能残留，旧 api_key 可能仍被 Traefik 使用」',
  );
  assert.ok(
    warns.every((m) => !m.includes('已摘除 llm-routes.yml')),
    '摘除失败时绝不谎称「已摘除」（旧代码的撒谎行为）',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('D3（Round D 评审）：回滚摘除遇 ENOENT（含密文件本就不在）→ 视为 fail-closed 达成，不误报「可能残留」', async () => {
  // 场景 1（第 2 步回滚分支）：零 binding + 主文件 publish 失败（routes.yml 预置为目录），
  // llm-routes.yml 本就不存在 → 回滚 unlink 必然 ENOENT = fail-closed 已达成。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-d3-rollback-enoent-'));
    fs.mkdirSync(path.join(dir, 'routes.yml'));
    const errors = [];
    const log = { warn: () => {}, error: (m) => errors.push(m) };
    try {
      await assert.rejects(
        () => rebuildRoutes(makePublishPool({ bindings: [] }), { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log }),
        /ENOTDIR|EISDIR|rename/,
        '只抛原始的主文件发布错误（不得带「可能残留」后缀）',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(errors.length, 0, 'ENOENT 不是异常态：不得 error 级日志、不得报「含密文件可能残留」');
  }

  // 场景 2（第 1 步回滚分支）：有 binding 但含密文件写失败（目录只读 → EACCES），
  // 回滚摘除遇 ENOENT（文件本就不在；stub 注入以摆脱目录权限对 unlink 错误码的干扰）。
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-d3-step1-enoent-'));
    fs.chmodSync(dir, 0o000);
    const errors = [];
    const log = { warn: () => {}, error: (m) => errors.push(m) };
    const pool = makePublishPool({
      bindings: [{
        fde_id: 'u1', api_key: 'sk-test-1234567890',
        provider_id: 'deadbeef-1111-2222-3333-444444444444',
        base_url: 'https://api.upstream.example.com/v1',
        fde_name: 'alice', subnet: '10.200.1.0/29',
      }],
    });
    const fsp = fs.promises;
    const origUnlink = fsp.unlink;
    fsp.unlink = async (p) => {
      if (String(p) === path.join(dir, 'llm-routes.yml')) {
        const e = new Error("ENOENT: no such file or directory, unlink 'llm-routes.yml'");
        e.code = 'ENOENT';
        throw e;
      }
      return origUnlink(p);
    };
    try {
      await assert.rejects(
        () => rebuildRoutes(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log }),
        (e) => /llm-routes.yml publish failed/.test(e.message) && !/含密文件可能残留/.test(e.message),
        'ENOENT 摘除不得把「可能残留」带进错误',
      );
    } finally {
      fsp.unlink = origUnlink; // 恢复，避免影响其它用例
      fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    assert.equal(errors.length, 0, 'ENOENT 不得 error 级误报「含密文件可能残留」');
  }
});

// ---------------------------------------------------------------------------
// F2：desired-state 过滤 p.enabled = true（与心跳查询同口径）；停用 provider → 无 LLM 路由
// ---------------------------------------------------------------------------

test('F2：readRouteDesiredState 的 LLM JOIN 必须过滤 p.enabled = true（停用 provider 的 binding 不进路由输入）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-f2-enabled-'));
  const pool = makePublishPool({ bindings: [] });
  await rebuildRoutes(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir });
  const llmSql = pool.sqlLog.find((e) => e.sql.includes('FROM fde_llm_bindings b'));
  assert.ok(llmSql, '应发起 LLM desired-state 查询');
  assert.ok(
    llmSql.sql.includes('p.enabled = true'),
    'desired-state 必须过滤停用 provider（与 getFdeLlmHeartbeatModels 心跳查询同口径）',
  );
  // 过滤后零 binding 的渲染输入 → 无 LLM 路由（fail-closed，与 generateLlmTraefikConfig b?.apiKey 口径一致）
  assert.equal(generateLlmTraefikConfig(llmArgs([])), LLM_EMPTY_CONFIG);
  assert.equal(fs.existsSync(path.join(dir, 'llm-routes.yml')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// F3-5：启动重建失败 → 写 full_rebuild outbox 行作为循环重试信号（不改成高频轮询）
// ---------------------------------------------------------------------------

class LoopFakePool {
  constructor() {
    this.sqlLog = [];
  }

  #dispatch(sql) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('INSERT INTO route_revisions')) return { rows: [{ revision: 1 }] };
    return { rows: [] };
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });
    return this.#dispatch(sql);
  }

  async connect() {
    const self = this;
    return {
      query: async (sql, params = []) => { self.sqlLog.push({ sql, params }); return self.#dispatch(sql); },
      release: () => {},
    };
  }
}

// F3'（Round B 评审）：aggregate_id 是 uuid NOT NULL（schema.sql §9），必须断言 UUID 形态，
// 不得断言非 UUID 字面量（'startup' 曾把真实 DB 上的类型错误写成单测期望）。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('F3-5：startRoutesLoop 启动重建失败 → 写 full_rebuild outbox 行（循环消费到即重试全量重建）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-f3-loop-'));
  fs.chmodSync(dir, 0o000); // 发布必然失败 → 触发启动重建失败分支
  const pool = new LoopFakePool();
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: () => {} };
  const loop = startRoutesLoop(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log });
  await new Promise((r) => setTimeout(r, 300));
  loop.stop();
  assert.equal(FULL_REBUILD_AGGREGATE_ID, '00000000-0000-0000-0000-000000000000', '哨兵为固定 nil UUID');
  assert.ok(warns.some((m) => m.includes('startup rebuild failed')), '启动重建失败必须告警');
  assert.ok(
    pool.sqlLog.some((e) => e.sql.includes('INSERT INTO route_revisions') && e.params[0] === 'full_rebuild' && UUID_RE.test(String(e.params[1]))),
    '必须写 full_rebuild 的 revisions head（aggregate_id 满足 uuid 形态）',
  );
  assert.ok(
    pool.sqlLog.some((e) => e.sql.includes('INSERT INTO route_outbox') && e.params[0] === 'full_rebuild' && UUID_RE.test(String(e.params[1]))),
    '必须写 full_rebuild pending outbox 行（循环消费到即重试全量重建；aggregate_id 满足 uuid 形态）',
  );
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});

// N5（Round C 评审）：入队也失败（DB 抖动）→ 内存标记置位，此后每轮循环（消费 outbox 前）重试入队。
class N5LoopFakePool {
  constructor() {
    this.sqlLog = [];
    this.fullRebuildEnqueueAttempts = 0; // fake 记录的调用序列（供断言）
    this.failEnqueueTimes = 1;           // 首次入队（启动路径）失败，其后成功
  }

  #dispatch(sql, params) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('INSERT INTO route_revisions') && params?.[0] === 'full_rebuild') {
      this.fullRebuildEnqueueAttempts += 1;
      if (this.fullRebuildEnqueueAttempts <= this.failEnqueueTimes) throw new Error('db unavailable (injected)');
      return { rows: [{ revision: this.fullRebuildEnqueueAttempts }] };
    }
    if (sql.includes('INSERT INTO route_revisions')) return { rows: [{ revision: 1 }] };
    return { rows: [] };
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql, params });
    return this.#dispatch(sql, params);
  }

  async connect() {
    const self = this;
    return {
      query: async (sql, params = []) => { self.sqlLog.push({ sql, params }); return self.#dispatch(sql, params); },
      release: () => {},
    };
  }
}

test('N5（Round C 评审）：启动重建失败 + 入队也失败 → needsFullRebuild 标记置位；下一轮重试入队成功 → 清位（fake 记录调用序列）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-n5-loop-'));
  fs.chmodSync(dir, 0o000); // 发布必然失败 → 触发启动重建失败分支
  const pool = new N5LoopFakePool();
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: () => {} };
  const loop = startRoutesLoop(pool, { ...PUBLISH_CONFIG_BASE, traefikDynamicDir: dir }, { log });
  await new Promise((r) => setTimeout(r, 900)); // 循环 250ms/轮，足够跑过「重试成功」轮
  loop.stop();

  // 调用序列：启动路径 1 次（失败，置标记）+ 循环重试 1 次（成功，清位）——之后不再重试。
  assert.equal(pool.fullRebuildEnqueueAttempts, 2, '启动 1 次失败 + 循环重试 1 次成功，共 2 次');
  const enqueues = pool.sqlLog.filter((e) => e.sql.includes('INSERT INTO route_revisions') && e.params?.[0] === 'full_rebuild');
  assert.equal(enqueues.length, 2);
  assert.ok(warns.some((m) => m.includes('startup rebuild failed')), '启动重建失败必须告警');
  assert.ok(warns.some((m) => m.includes('enqueue full_rebuild row failed') && m.includes('needsFullRebuild')), '入队失败必须置位并告警');
  assert.ok(warns.some((m) => m.includes('入队重试成功')), '重试成功必须清位并告知');
  assert.ok(
    warns.filter((m) => m.includes('入队重试仍失败')).length === 0,
    '重试成功后不得再无谓重试（标记已清）',
  );
  fs.chmodSync(dir, 0o700);
  fs.rmSync(dir, { recursive: true, force: true });
});
