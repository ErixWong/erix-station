// issue #474 M2：第二道（最终文本断言）+ 三态失败语义（合法空 / 有效配置 / 读取或校验失败）。
// 重点不是「抛错了」，而是**失败时盘上发生什么**：一个字节不写、一个文件不抹、审计只记元数据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRenderedRouteText } from '../src/routebackends.js';
import { generateTraefikConfig, generateLlmTraefikConfig, rebuildRoutes } from '../src/routes.js';

const CFG = {
  baseDomain: 'fde.test',
  portalHost: 'station.fde.test',
  adminHost: 'admin.fde.test',
  llmHost: 'llm.fde.test',
  portalBackendUrl: 'http://127.0.0.1:18080',
  llmGatewayUrl: 'http://station-litellm:4000',
  traefikEntryPoint: 'web',
  traefikAdminEntryPoint: 'adminsecure',
  traefikDynamicFile: 'routes.yml',
  traefikLlmDynamicFile: 'llm-routes.yml',
};

const ALLOC = [{
  id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, backendUrl: 'http://10.200.1.2:22000',
}];

function genText(allocs = ALLOC) {
  return generateTraefikConfig({
    portalHost: CFG.portalHost,
    portalBackendUrl: CFG.portalBackendUrl,
    entryPoint: CFG.traefikEntryPoint,
    adminHost: CFG.adminHost,
    adminEntryPoint: CFG.traefikAdminEntryPoint,
    adminIpAllowlist: [],
    allocations: allocs,
    sourceRanges: ['10.200.1.0/29'],
  });
}

function genLlm(key = 'sk-CANARY-4f1a2b3c') {
  return generateLlmTraefikConfig({
    entryPoint: CFG.traefikEntryPoint,
    llmHost: CFG.llmHost,
    llmGatewayUrl: CFG.llmGatewayUrl,
    llmBindings: [{ fdeName: 'alice', subnet: '10.200.1.0/29', apiKey: key }],
  });
}

// ---- 第二道：对最终文本的独立断言 -------------------------------------------

test('第二道正例：真实生成器产出的两份文本全部过关（含预览 url / Host / ClientIP）', () => {
  assert.equal(assertRenderedRouteText({ text: genText(), llmText: genLlm(), config: CFG }), true);
  // 合法空（llmText = null）不参与断言。
  assert.equal(assertRenderedRouteText({ text: genText([]), llmText: null, config: CFG }), true);
});

test('第二道负例：url 被换成 127.0.0.1:22 / file:///etc/passwd / 带 userinfo 的 host 混淆', () => {
  for (const bad of ['http://127.0.0.1:22', 'file:///etc/passwd', 'http://127.0.0.1:18080@evil.com']) {
    const text = genText().replace('http://10.200.1.2:22000', bad);
    assert.notEqual(text, genText(), `替换必须真的生效（${bad}）`);
    assert.throws(
      () => assertRenderedRouteText({ text, llmText: null, config: CFG }),
      (err) => err.code === 'route_url_not_allowlisted' || err.code === 'preview_backend_host_invalid' || err.code === 'preview_port_out_of_pool',
      `${bad} 必须被第二道拦下`,
    );
  }
});

test('第二道负例：预览 url 带路径 / 端口越界 / 主机不是 base+2', () => {
  const cases = [
    ['http://10.200.1.2:22000/evil', '带路径'],
    ['http://10.200.1.2:21999', '端口池下界外'],
    ['http://10.200.1.2:30000', '端口池上界外'],
    ['http://10.200.1.3:22000', '主机不是 subnetBase+2'],
    ['http://10.200.9.2:22000', '主机不是该 allocation 的网段（仍是池内对齐块的 .2 ⇒ 允许，见下）'],
  ];
  for (const [bad, why] of cases) {
    const text = genText().replace('http://10.200.1.2:22000', bad);
    if (why.includes('允许')) {
      assert.equal(assertRenderedRouteText({ text, llmText: null, config: CFG }), true, why);
      continue;
    }
    assert.throws(
      () => assertRenderedRouteText({ text, llmText: null, config: CFG }),
      (err) => ['route_url_not_allowlisted', 'preview_port_out_of_pool', 'preview_backend_host_invalid', 'route_url_not_quoted'].includes(err.code),
      `${why} ⇒ ${bad} 必须被拦`,
    );
  }
});

test('第二道负例：Host() 抢注 station.<伞域> / 池外域 / ClientIP 写 0.0.0.0/0', () => {
  // Host 抢注：把预览 router 的 Host 换成 portal 的 host（第一道若被改坏，这里仍拦）。
  const hostHijack = genText().replace('alice-p-22000.fde.test', 'station.fde.test');
  assert.notEqual(hostHijack, genText());
  // station 是**保留 host**，所以第二道放行（它本来就是允许集合成员）——抢注的正解是第一道；
  // 但「保留名之外、又不在伞域下」的 Host 必须红：
  const foreign = genText().replace('alice-p-22000.fde.test', 'alice-p-22000.evil.test');
  assert.throws(
    () => assertRenderedRouteText({ text: foreign, llmText: null, config: CFG }),
    (err) => err.code === 'route_host_not_allowlisted',
  );
  // 号池外端口的 Host（形状对、号不对）。
  const badPort = genText().replace('alice-p-22000.fde.test', 'alice-p-09999.fde.test');
  assert.throws(
    () => assertRenderedRouteText({ text: badPort, llmText: null, config: CFG }),
    (err) => err.code === 'preview_port_out_of_pool',
  );
  // LLM 段的 ClientIP 被换成宽网段：parseCidr 认，白名单不认。
  for (const wide of ['0.0.0.0/0', '127.0.0.0/8', '10.200.0.0/16', '10.200.0.3/29']) {
    const llm = genLlm().replace('ClientIP(`10.200.1.0/29`)', `ClientIP(\`${wide}\`)`);
    assert.notEqual(llm, genLlm(), `${wide} 替换必须生效`);
    assert.throws(
      () => assertRenderedRouteText({ text: genText([]), llmText: llm, config: CFG }),
      (err) => err.code === 'route_clientip_out_of_pool',
      `ClientIP(${wide}) 必须被拦`,
    );
  }
});

test('第二道负例：url 行的引号形态漂移（生成器恒加引号；裸值 = 有人手改/形状变了）', () => {
  const text = genText().replace('- url: "http://10.200.1.2:22000"', '- url: http://10.200.1.2:22000');
  assert.notEqual(text, genText());
  assert.throws(
    () => assertRenderedRouteText({ text, llmText: null, config: CFG }),
    (err) => err.code === 'route_url_not_quoted',
  );
});

test('第二道不引 YAML parser：管理员 ADMIN_IP_ALLOWLIST 的宽网段（sourceRange）不受池限', () => {
  const text = generateTraefikConfig({
    portalHost: CFG.portalHost,
    portalBackendUrl: CFG.portalBackendUrl,
    entryPoint: CFG.traefikEntryPoint,
    adminHost: CFG.adminHost,
    adminEntryPoint: CFG.traefikAdminEntryPoint,
    adminIpAllowlist: ['203.0.113.0/24', '10.0.0.0/8'],
    allocations: ALLOC,
    sourceRanges: ['10.200.1.0/29'],
  });
  assert.ok(text.includes('"10.0.0.0/8"'), 'allowlist 确实出现在文本里');
  assert.equal(assertRenderedRouteText({ text, llmText: null, config: CFG }), true);
});

// ---- 三态失败语义 -------------------------------------------------------------

function pubPool({ bindings = [], allocations = [], networks = [{ fde_id: 'u1', subnet: '10.200.1.0/29', fde_name: 'alice' }], failAlloc = false } = {}) {
  return {
    sqlLog: [],
    async query(sql, params = []) {
      this.sqlLog.push({ sql, params });
      if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
      if (sql.includes('FROM fde_networks')) return { rows: networks };
      if (sql.includes('FROM fde_llm_bindings b')) {
        if (failAlloc) throw new Error('db unavailable (injected)');
        return { rows: bindings };
      }
      if (sql.includes('FROM port_allocations')) return { rows: allocations };
      return { rows: [] };
    },
  };
}

const GOOD_ALLOC_ROW = {
  id: 'pa1', fde_id: 'u1', hostname: 'alice-p-22000.fde.test', port: 22000, subnet: '10.200.1.0/29', fde_name: 'alice',
};
const CANARY_KEY = 'sk-CANARY-4f1a2b3c5d6e';

function readPair(dir) {
  const snap = (f) => {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) return null;
    const st = fs.lstatSync(p);
    return { bytes: fs.readFileSync(p), mode: st.mode & 0o777 };
  };
  return { routes: snap('routes.yml'), llm: snap('llm-routes.yml') };
}

test('三态之「合法空」：零 binding ⇒ llm-routes.yml 被 unlink（这是唯一允许 unlink 的态）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-empty-'));
  const pool = pubPool({ bindings: [], allocations: [GOOD_ALLOC_ROW] });
  // 先造一份「上一轮留下的」含密文件。
  fs.writeFileSync(path.join(dir, 'llm-routes.yml'), `# stale\n${CANARY_KEY}\n`, { mode: 0o600 });
  const out = await rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir });
  assert.equal(out.llmPublished, false);
  assert.equal(fs.existsSync(path.join(dir, 'llm-routes.yml')), false, '合法空必须 unlink');
  assert.ok(fs.existsSync(path.join(dir, 'routes.yml')), '主文件照常发布');
  assert.ok(!pool.sqlLog.some((e) => e.sql.includes('INSERT INTO audit_log')), '合法空不是失败：不得记 rejected 审计');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('三态之「读取失败」：DB 抛错 ⇒ 保留 last-known-good（两文件字节不变、含密文件不被抬成空）+ 审计只记元数据', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-dbfail-'));
  const pool = pubPool({ bindings: [{ fde_id: 'u1', api_key: CANARY_KEY, fde_name: 'alice', subnet: '10.200.1.0/29' }], allocations: [GOOD_ALLOC_ROW] });
  const warns = [];
  const log = { warn: (m) => warns.push(m), error: (m) => warns.push(m) };
  await rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir }, { log });
  const before = readPair(dir);
  assert.ok(before.llm && before.llm.bytes.includes(CANARY_KEY), '第一轮已发布含密文件');

  const failing = pubPool({ bindings: [], allocations: [], failAlloc: true });
  await assert.rejects(() => rebuildRoutes(failing, { ...CFG, traefikDynamicDir: dir }, { log }));
  const after = readPair(dir);
  assert.deepEqual(after, before, '读取失败：字节 / mode 必须逐字节不变');
  assert.ok(after.llm.bytes.includes(CANARY_KEY), '含密文件必须还在（last-known-good）');
  const audits = failing.sqlLog.filter((e) => e.sql.includes('INSERT INTO audit_log'));
  assert.equal(audits.length, 1, '必须记一条 rejected 审计');
  assert.equal(audits[0].params[1], 'admin.routes_generation_rejected');
  const details = JSON.parse(audits[0].params[3]);
  assert.deepEqual(Object.keys(details).sort(), ['count', 'file', 'reason', 'stage'], '审计字段只能是元数据');
  assert.ok(['routes.yml', 'llm-routes.yml'].includes(details.file), 'file 是文件名');
  assert.equal(details.stage, 'read_desired_state');
  const serialized = JSON.stringify(details);
  assert.ok(!serialized.includes(CANARY_KEY) && !serialized.includes('Bearer'), '审计绝不含 key');
  assert.ok(!serialized.includes('http:'), '审计绝不含 YAML 正文');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('三态之「校验失败」：hostname 被污染 ⇒ 不写盘、不 unlink、审计 reason 是 code 且 warn 不含正文/key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-badhost-'));
  const pool = pubPool({ bindings: [{ fde_id: 'u1', api_key: CANARY_KEY, fde_name: 'alice', subnet: '10.200.1.0/29' }], allocations: [GOOD_ALLOC_ROW] });
  await rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir });
  const before = readPair(dir);

  const dirty = pubPool({
    bindings: [{ fde_id: 'u1', api_key: CANARY_KEY, fde_name: 'alice', subnet: '10.200.1.0/29' }],
    allocations: [{ ...GOOD_ALLOC_ROW, hostname: 'station.fde.test' }],
  });
  const warns = [];
  await assert.rejects(
    () => rebuildRoutes(dirty, { ...CFG, traefikDynamicDir: dir }, { log: { warn: (m) => warns.push(m), error: () => {} } }),
    (err) => err.code === 'preview_hostname_mismatch' && err.stage === 'read_desired_state',
  );
  assert.deepEqual(readPair(dir), before, '校验失败：一个字节不写');
  assert.ok(fs.existsSync(path.join(dir, 'llm-routes.yml')), '校验失败：绝不 unlink 含密文件');
  const audit = dirty.sqlLog.find((e) => e.sql.includes('INSERT INTO audit_log'));
  assert.equal(JSON.parse(audit.params[3]).reason, 'preview_hostname_mismatch');
  assert.ok(warns.some((m) => m.includes('stage=read_desired_state') && m.includes('last-known-good')));
  assert.ok(!warns.join('\n').includes(CANARY_KEY), 'warn 不含 canary key');
  assert.ok(!warns.join('\n').includes('http:'), 'warn 不含 YAML 正文');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('第二道真的在写盘前跑（测试缝注入一个必拒的断言）⇒ 两文件都不落盘、stage=assert_final_text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-gate2-'));
  const pool = pubPool({ bindings: [{ fde_id: 'u1', api_key: CANARY_KEY, fde_name: 'alice', subnet: '10.200.1.0/29' }], allocations: [GOOD_ALLOC_ROW] });
  const seen = [];
  const assertText = (args) => {
    seen.push({
      hasText: typeof args.text === 'string' && args.text.includes('http://10.200.1.2:22000'),
      hasLlm: typeof args.llmText === 'string' && args.llmText.includes('ClientIP('),
      file: args.file,
      llmFile: args.llmFile,
    });
    const err = new Error('injected: final text assertion refused');
    err.code = 'route_clientip_out_of_pool';
    throw err;
  };
  await assert.rejects(
    () => rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir }, { log: { warn: () => {}, error: () => {} }, assertText }),
    (err) => err.code === 'route_clientip_out_of_pool' && err.stage === 'assert_final_text',
  );
  assert.equal(seen.length, 1, '第二道必须被调到（恰好一次）');
  assert.deepEqual(seen[0], { hasText: true, hasLlm: true, file: 'routes.yml', llmFile: 'llm-routes.yml' }, '拿到的是最终两份文本');
  assert.equal(fs.existsSync(path.join(dir, 'routes.yml')), false, '第二道在写盘之前：主文件不得落盘');
  assert.equal(fs.existsSync(path.join(dir, 'llm-routes.yml')), false, '第二道在写盘之前：含密文件不得落盘');
  const audit = pool.sqlLog.find((e) => e.sql.includes('INSERT INTO audit_log'));
  assert.equal(JSON.parse(audit.params[3]).stage, 'assert_final_text');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('第二道默认就是真断言（不传 assertText 时正常发布）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-gate2-ok-'));
  const pool = pubPool({ bindings: [{ fde_id: 'u1', api_key: CANARY_KEY, fde_name: 'alice', subnet: '10.200.1.0/29' }], allocations: [GOOD_ALLOC_ROW] });
  const out = await rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir }, { log: { warn: () => {}, error: () => {} } });
  assert.equal(out.llmPublished, true);
  assert.equal(fs.statSync(path.join(dir, 'llm-routes.yml')).mode & 0o777, 0o600);
  assert.ok(fs.readFileSync(path.join(dir, 'routes.yml'), 'utf8').includes('http://10.200.1.2:22000'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('第二道独有的拦截（第一道不上场）：fde_networks.subnet = 0.0.0.0/0 且无 allocation/binding ⇒ internal-allow 的 sourceRange 被第二道拦下', async () => {
  // 这条专门给变异「删掉第二道断言」用：零 allocation / 零 binding 时第一道根本没有输入可判；
  // 而 deriveSourceRanges 把 subnet 直接搬进 internal-allow——宽网段 = 谁都能打 /api/internal。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r474-sr-'));
  const pool = pubPool({ networks: [{ fde_id: 'u1', subnet: '0.0.0.0/0', fde_name: 'alice' }] });
  await assert.rejects(
    () => rebuildRoutes(pool, { ...CFG, traefikDynamicDir: dir }, { log: { warn: () => {}, error: () => {} } }),
    (err) => err.code === 'route_source_range_out_of_pool' && err.stage === 'assert_final_text',
  );
  assert.equal(fs.existsSync(path.join(dir, 'routes.yml')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('第二道：admin-deny 的硬编码 192.0.2.0/24 与 admin-allow 的管理员宽网段都不受池限', () => {
  const text = generateTraefikConfig({
    portalHost: CFG.portalHost,
    portalBackendUrl: CFG.portalBackendUrl,
    entryPoint: CFG.traefikEntryPoint,
    adminHost: CFG.adminHost,
    adminEntryPoint: CFG.traefikAdminEntryPoint,
    adminIpAllowlist: ['203.0.113.0/24', '10.0.0.0/8', '0.0.0.0/0'],
    allocations: ALLOC,
    sourceRanges: ['10.200.1.0/29'],
  });
  assert.ok(text.includes('sourceRange: ["192.0.2.0/24"]'), 'admin-deny 的文档网段确实在文本里');
  assert.ok(text.includes('"0.0.0.0/0"'), '管理员 allowlist 的宽网段确实在文本里');
  assert.equal(assertRenderedRouteText({ text, llmText: null, config: CFG }), true);
});
