// runner/test/mcp-servers.test.js —— MCP 组装层（issue #608 §11「runner」段 mcp-servers 条）。
// 覆盖：读 `~/.erix/mcp.json` + 经 IPC 取值的**成功/失败两态**、缺必填槽 ⇒ 不注册 + `missing`、
// **保留名在 runner 侧二次拒绝（反向）**、hidden 二道防线、值不落日志（§10.3 canary 口径）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_CONFIG_REL_PATH,
  RESERVED_SLOT_NAMES,
  isReservedSlotName,
  readMcpConfig,
  combineServers,
  normalizeConfigResponse,
  createMcpConfigFetcher,
  loadMcpServers,
  createProcessReporter,
} from '../lib/mcp-servers.js';
import { MSG } from '../lib/ipc.js';

function fakeFs(files) {
  return {
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    readFileSync: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
      const v = files[p];
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const HOME = '/home/erix';
const CONF = `${HOME}/${MCP_CONFIG_REL_PATH}`;

const githubDecl = {
  name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'],
  exposure: 'deferred', lifecycle: 'run', timeout_ms: 60000,
  slots: [{ name: 'GITHUB_TOKEN', inject: 'env', required: true }],
  tools: [{ name: 'create_issue', description: '创建 issue' }],
};
const hubDecl = {
  name: 'srch-hub', transport: 'http', url: 'https://srch.erix.vip/mcp',
  exposure: 'direct', lifecycle: 'run-keep-alive', timeout_ms: 60000,
  slots: [{ name: 'AUTHORIZATION', inject: 'header', required: true }],
  tools: [{ name: 'search', description: '搜索', inputSchema: { type: 'object' } }],
};
const noSlotDecl = {
  name: 'local', transport: 'stdio', command: 'node', args: ['s.js'],
  exposure: 'deferred', lifecycle: 'run', slots: [], tools: [],
};

// ---------------------------------------------------------------------------
// ① 读物化文件
// ---------------------------------------------------------------------------

test('MS-1 读 ~/.erix/mcp.json：ok 态按 name 升序给出声明（§5.1）', () => {
  const out = readMcpConfig({ home: HOME, fsImpl: fakeFs({ [CONF]: JSON.stringify({ version: 1, servers: [hubDecl, githubDecl] }) }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.servers.map((s) => s.name), ['github', 'srch-hub']);
});

test('MS-2 四种失败各有 status，且**都不抛**（§6.1「不打死 run」）', () => {
  assert.equal(readMcpConfig({ home: HOME, fsImpl: fakeFs({}) }).status, 'missing');
  assert.equal(readMcpConfig({ home: HOME, fsImpl: fakeFs({ [CONF]: '{oops' }) }).status, 'bad_json');
  assert.equal(readMcpConfig({ home: HOME, fsImpl: fakeFs({ [CONF]: '{"version":1}' }) }).status, 'bad_shape');
  assert.equal(readMcpConfig({ home: HOME, fsImpl: fakeFs({ [CONF]: new Error('EIO') }) }).status, 'unreadable');
  // fsImpl 只给一半也要能用（降级层不许因为 stub 形状而抛）
  assert.equal(readMcpConfig({ home: '/nonexistent-erix', fsImpl: { readFileSync: () => '{}' } }).status, 'missing');
});

// ---------------------------------------------------------------------------
// ② 取值 + 组装（成功 / 失败两态）
// ---------------------------------------------------------------------------

test('MS-3 成功态：槽值注进 resolved，两条都注册（§6.1 值只经 IPC 内存传递）', async () => {
  const logs = [];
  const fetcher = createMcpConfigFetcher({
    runId: 'r1',
    request: async () => ({
      req_id: 1, ok: true,
      servers: [
        { name: 'github', values: { GITHUB_TOKEN: 'ghp_CANARY' } },
        { name: 'srch-hub', slots: [{ name: 'AUTHORIZATION', value: 'Bearer CANARY2' }] },
      ],
      missing: [],
    }),
    log: (lvl, msg, f) => logs.push(`${lvl}:${msg}:${JSON.stringify(f)}`),
  });
  const out = await loadMcpServers({
    home: HOME,
    fsImpl: fakeFs({ [CONF]: JSON.stringify({ version: 1, servers: [githubDecl, hubDecl, noSlotDecl] }) }),
    fetchConfig: fetcher.fetch,
    log: (lvl, msg, f) => logs.push(`${lvl}:${msg}:${JSON.stringify(f)}`),
  });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.servers.map((s) => s.name), ['github', 'local', 'srch-hub']);
  assert.deepEqual(out.servers[0].resolved, { values: { GITHUB_TOKEN: 'ghp_CANARY' } });
  assert.deepEqual(out.missing, []);
  assert.ok(logs.every((l) => !l.includes('CANARY')), `值进了日志（§10.3）：${logs.join('|')}`);
});

test('MS-4【反向】取值失败 ⇒ 整体降级为「本次 run 无 MCP」，不抛、不注册（§6.1）', async () => {
  const boom = await loadMcpServers({
    home: HOME,
    fsImpl: fakeFs({ [CONF]: JSON.stringify({ version: 1, servers: [githubDecl] }) }),
    fetchConfig: async () => ({ ok: false, valuesByName: {}, missing: [], error: 'portal 503' }),
  });
  assert.equal(boom.status, 'config_unavailable');
  assert.deepEqual(boom.servers, [], '拿不到值还注册 server 就是让它带空凭据去撞 401');
  assert.equal(boom.note, 'portal 503');

  const thrown = await loadMcpServers({
    home: HOME,
    fsImpl: fakeFs({ [CONF]: JSON.stringify({ version: 1, servers: [githubDecl] }) }),
    fetchConfig: async () => { throw new Error('ipc_closed'); },
  });
  assert.equal(thrown.status, 'config_unavailable');
  assert.equal(thrown.note, 'ipc_closed');
});

test('MS-5 没有任何槽位声明 ⇒ 不发起取值请求（省一次 IPC，也不误降级）', async () => {
  let requested = 0;
  const out = await loadMcpServers({
    home: HOME,
    fsImpl: fakeFs({ [CONF]: JSON.stringify({ version: 1, servers: [noSlotDecl] }) }),
    fetchConfig: async () => { requested += 1; return { ok: true, valuesByName: {}, missing: [] }; },
  });
  assert.equal(requested, 0);
  assert.deepEqual(out.servers.map((s) => s.name), ['local']);
});

test('MS-6 缺必填槽 ⇒ 不注册 + `missing[{name,slots}]`；agentd 报的 missing 也并进来（§6.1）', () => {
  const out = combineServers({
    servers: [githubDecl, hubDecl],
    valuesByName: { 'srch-hub': { AUTHORIZATION: 'Bearer x' } },
    missingFromAgent: [{ name: 'other', slots: ['K'] }],
  });
  assert.deepEqual(out.registered.map((s) => s.name), ['srch-hub']);
  assert.deepEqual(out.missing, [{ name: 'github', slots: ['GITHUB_TOKEN'], reason: 'missing_slots' },
    { name: 'other', slots: ['K'], reason: 'agent_missing' }]);
  assert.equal(out.missing.length, 2, 'list 必须能解释「为什么少一个」，否则用户只能猜');
});

test('MS-7【反向】保留名在 runner 侧二次拒绝：值不注入、必填 ⇒ 进 missing（§10.6）', () => {
  const declared = { ...githubDecl, slots: [{ name: 'PATH', inject: 'env', required: true }] };
  const out = combineServers({ servers: [declared], valuesByName: { github: { PATH: '/evil/bin' } } });
  assert.deepEqual(out.registered, [], '一个槽就能改掉 PATH —— 第二道门就是为此存在');
  assert.deepEqual(out.missing, [{ name: 'github', slots: ['PATH'], reason: 'missing_slots' }]);
  assert.deepEqual(out.rejected, [{ server: 'github', slot: 'PATH', reason: 'reserved_name' }]);

  for (const n of RESERVED_SLOT_NAMES) assert.equal(isReservedSlotName(n), true, n);
  for (const n of ['ERIX_STATION_TOKEN', 'STATION_MASKED', 'SKILL_X', 'MCP_PORT', 'erix_token']) {
    assert.equal(isReservedSlotName(n), true, `前缀命名空间漏了：${n}`);
  }
  assert.equal(isReservedSlotName('GITHUB_TOKEN'), false);
  assert.equal(isReservedSlotName(''), true);
});

test('MS-8 非必填槽没值也注册；hidden 条目走第二道门（§5.1 物化器本不该写它）', () => {
  const optional = { ...githubDecl, slots: [{ name: 'OWNER', inject: 'env', required: false }] };
  const ok = combineServers({ servers: [optional], valuesByName: {} });
  assert.deepEqual(ok.registered.map((s) => s.name), ['github']);
  assert.deepEqual(ok.registered[0].resolved, { values: {} });

  const withHidden = combineServers({
    servers: [{ ...hubDecl, exposure: 'hidden' }, githubDecl],
    valuesByName: { github: { GITHUB_TOKEN: 'v' }, 'srch-hub': { AUTHORIZATION: 'v' } },
  });
  assert.deepEqual(withHidden.hidden, ['srch-hub']);
  assert.deepEqual(withHidden.registered.map((s) => s.name), ['github'], 'hidden 不得进 pool（§10.7）');
});

test('MS-9 agentd 回值的三种形状都认（values / env / slots[]）', () => {
  const n = normalizeConfigResponse({
    ok: true,
    servers: [
      { name: 'a', values: { A: '1' } },
      { name: 'b', env: { B: '2' } },
      { name: 'c', slots: [{ name: 'C', value: '3' }, { name: 'D' }] },
      { name: 'x' },
    ],
    missing: [],
  });
  assert.deepEqual(n.valuesByName, { a: { A: '1' }, b: { B: '2' }, c: { C: '3' }, x: {} });
  assert.equal(n.ok, true);
  assert.equal(normalizeConfigResponse({ ok: false, error: 'boom' }).error, 'boom');
});

test('MS-10 一次 run 只取一次（§6.1：改了市场配置要下一个 run 才生效）', async () => {
  let calls = 0;
  const fetcher = createMcpConfigFetcher({
    runId: 'r',
    request: async () => { calls += 1; return { ok: true, servers: [], missing: [] }; },
  });
  await fetcher.fetch();
  await fetcher.fetch();
  assert.equal(calls, 1);
  fetcher.reset();
  await fetcher.fetch();
  assert.equal(calls, 2, 'reset 只为「同一 worker 进程接下一个 run」服务；不 reset 就永远只取一次');
});

// ---------------------------------------------------------------------------
// ③ MCP_PROCESS 上行形状（§6.8）
// ---------------------------------------------------------------------------

test('MS-11 createProcessReporter 发的是 MSG.MCP_PROCESS，且只认 spawn/exit 两相', () => {
  const sent = [];
  const report = createProcessReporter({ runId: 'r9', send: (m) => { sent.push(m); return true; } });
  assert.equal(report({ phase: 'spawn', pgid: 4242, name: 'github' }), true);
  assert.equal(report({ phase: 'exit', pgid: 4242, name: 'github' }), true);
  assert.equal(report({ phase: 'heartbeat', pgid: 4242 }), false, '心跳不是进程记账（那是 SHELL_LIVENESS 的活）');
  assert.deepEqual(sent, [
    { type: MSG.MCP_PROCESS, run_id: 'r9', phase: 'spawn', pgid: 4242, name: 'github' },
    { type: MSG.MCP_PROCESS, run_id: 'r9', phase: 'exit', pgid: 4242, name: 'github' },
  ]);
});
