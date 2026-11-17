// runner/test/mcp-tool.test.js —— MCP 工具面（issue #608 §11「runner」段 mcp-tool 条）。
// 标【反向】的：实现退化（改回 deferred / 摘掉 hidden 门禁 / 删缓存）时必须变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  MCP_GATEWAY_TOOL,
  MCP_GATEWAY_SCHEMA,
  MCP_TOOL_ERRORS,
  DIRECT_PREFIX,
  DIRECT_TOOL_BUDGET,
  directToolName,
  sanitizeToolNamePart,
  expandDirectTools,
  createMcpTool,
} from '../lib/mcp-tool.js';
import { createMcpPool, MCP_PROTOCOL_VERSION, MCP_ERRORS } from '../lib/mcp-client.js';

// ---------------------------------------------------------------------------
// 假 pool：形状与 createMcpPool 逐字同构（list/get/directTools/missing/registerTools/closeAll）
// ---------------------------------------------------------------------------

function fakeClient(server, { calls = [], onCall = null, listToolsImpl = null } = {}) {
  const client = {
    name: server.name,
    exposure: server.exposure === 'direct' ? 'direct' : 'deferred',
    lifecycle: server.lifecycle ?? 'run',
    tools: (server.tools ?? []).slice(),
    slug: server.slug ?? null,
    state: server.state ?? 'idle',
    listTools: async () => {
      if (listToolsImpl) return await listToolsImpl(client);
      throw new Error('不该被调');
    },
    callTool: async (tool, args, ctx = {}) => {
      calls.push({ server: server.name, tool, args, signal: ctx.signal ?? null });
      if (onCall) return await onCall(client, tool, args, ctx);
      return { text: `ok:${tool}`, isError: false, truncated: false, fullPath: null };
    },
    status: () => ({ state: client.state, toolsCached: client.tools.length > 0 }),
    close: async () => {},
  };
  return client;
}

function fakePool(specs, opts = {}) {
  const clients = new Map();
  for (const spec of specs) {
    clients.set(spec.server.name, fakeClient(spec.server, { calls: spec.calls ?? [], ...spec }));
  }
  const pool = {
    missing: opts.missing ?? [],
    calls: opts.calls ?? [],
    get: (n) => clients.get(String(n)) ?? null,
    list: () => [...clients.values()].map((c) => ({
      name: c.name,
      exposure: c.exposure,
      lifecycle: c.lifecycle,
      toolCount: c.tools.length,
      tools: c.tools,
      status: c.status(),
    })),
    directTools: () => {
      const out = [];
      for (const c of clients.values()) {
        if (c.exposure !== 'direct') continue;
        for (const t of c.tools) out.push({ server: c.name, tool: t?.name, description: t?.description ?? '', definition: t });
      }
      return out.filter((r) => typeof r.tool === 'string' && r.tool !== '');
    },
    registerTools: (n, tools) => {
      const c = clients.get(String(n));
      if (!c) return false;
      c.tools.length = 0;
      c.tools.push(...tools);
      return true;
    },
    closeAll: async () => {},
  };
  return pool;
}

const deferredServer = {
  name: 'github', exposure: 'deferred', lifecycle: 'run',
  tools: [{ name: 'create_issue', description: '创建 issue' }, { name: 'list_pr', description: '列 PR' }],
};
const directServer = {
  name: 'srch-hub', exposure: 'direct', lifecycle: 'run-keep-alive',
  tools: [{ name: 'search', description: '搜网页', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
};

// ---------------------------------------------------------------------------
// ① 网关 schema 与 direct 展开（§6.3 / §4.3）
// ---------------------------------------------------------------------------

test('MT-1 网关工具 schema 逐字对齐 §6.3：名字/四动作/required/描述', () => {
  assert.equal(MCP_GATEWAY_SCHEMA.name, MCP_GATEWAY_TOOL);
  assert.equal(MCP_GATEWAY_TOOL, 'mcp');
  assert.deepEqual(MCP_GATEWAY_SCHEMA.inputSchema.required, ['action']);
  assert.deepEqual(Object.keys(MCP_GATEWAY_SCHEMA.inputSchema.properties).sort(),
    ['action', 'args', 'query', 'server', 'tool']);
  assert.deepEqual(MCP_GATEWAY_SCHEMA.inputSchema.properties.action.enum,
    ['list', 'search', 'call', 'status']);
  assert.match(MCP_GATEWAY_SCHEMA.description, /server 没连也能搜/, '描述要教会模型 search 不依赖连接');
});

test('MT-2 direct 展开成独立 schema `mcp__<server>__<tool>` 且带完整 inputSchema', () => {
  const tool = createMcpTool({ pool: fakePool([{ server: directServer }]) });
  const names = tool.schemas.map((s) => s.name);
  assert.ok(names.includes(`${DIRECT_PREFIX}srch_hub__search`), `实得 ${JSON.stringify(names)}`);
  const direct = tool.schemas.find((s) => s.name === `${DIRECT_PREFIX}srch_hub__search`);
  assert.deepEqual(direct.inputSchema.properties.q.type, 'string',
    'direct 的意义就是把 inputSchema 交给模型，省掉一次 search 往返（§4.3）');
  assert.equal(sanitizeToolNamePart('a-b.c/d'), 'a_b_c_d');
  assert.equal(directToolName('srch hub', 't.x'), 'mcp__srch_hub__t_x');
});

test('MT-3【反向】deferred 不展开（只有网关）、hidden 不展开', () => {
  const t1 = createMcpTool({ pool: fakePool([{ server: deferredServer }]) });
  assert.deepEqual(t1.schemas.map((s) => s.name), ['mcp'],
    '把 exposure 判据改回「一律展开」这条就红（§4.3 的旋钮不能是死配置）');
  const t2 = createMcpTool({
    pool: fakePool([{ server: { ...directServer, exposure: 'hidden' } }]),
  });
  assert.deepEqual(t2.schemas.map((s) => s.name), ['mcp']);
});

test('MT-4 direct 预算 ≤8 个、名字冲突双方都降级、单 server schema 超限整体降级（§4.3）', () => {
  const logs = [];
  const many = {
    name: 'many', exposure: 'direct',
    tools: Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, description: 'd' })),
  };
  const out = expandDirectTools(
    many.tools.map((t) => ({ server: 'many', tool: t.name, description: t.description, definition: t })),
    { log: (l, m, f) => logs.push(`${l}:${m}`) },
  );
  assert.equal(out.tools.length, DIRECT_TOOL_BUDGET, `实得 ${out.tools.length}`);
  assert.ok(out.downgraded.some((d) => d.reason === 'tool_budget'));
  assert.ok(logs.length > 0, '降级必须留痕，否则管理台与工具面永远对不上号');

  const clash = expandDirectTools([
    { server: 'a-b', tool: 'x', definition: {} },
    { server: 'a_b', tool: 'x', definition: {} },
  ]);
  assert.deepEqual(clash.tools, [], '清洗后撞名就两边都不留：留一半等于让同一个工具名有两个落点');
  assert.ok(clash.downgraded.every((d) => d.reason === 'name_conflict'));

  const big = expandDirectTools([{
    server: 's', tool: 't', definition: { inputSchema: { big: 'x'.repeat(70 * 1024) } },
  }], { schemaBudgetBytes: 64 * 1024 });
  assert.deepEqual(big.tools, []);
  assert.equal(big.downgraded[0].reason, 'schema_budget');
});

// ---------------------------------------------------------------------------
// ② 四个动作（§6.3）
// ---------------------------------------------------------------------------

test('MT-5 list：列 name/exposure/state/工具数，缓存为空的 server 触发一次发现并回填（§6.6）', async () => {
  const backfill = [];
  const empty = { name: 'fresh', exposure: 'deferred', tools: [] };
  const pool = fakePool([{
    server: empty,
    listToolsImpl: async () => [{ name: 'echo', description: '回声' }],
  }, { server: deferredServer }]);
  const tool = createMcpTool({ pool, onToolsCache: (slug, tools) => backfill.push([slug, tools.length]) });
  const res = await tool.executeTool('mcp', { action: 'list' });
  assert.match(res.content, /github — exposure=deferred state=idle 工具 2 个/);
  assert.match(res.content, /fresh — exposure=deferred state=idle 工具 1 个 \[已发现 1 个工具\]/,
    `懒启动没生效或没回填：${res.content}`);
  assert.deepEqual(backfill, [['fresh', 1]], '发现到的元数据必须回填（否则下次物化还是没有缓存可搜）');
  assert.deepEqual(pool.get('fresh').tools.map((t) => t.name), ['echo']);
});

test('MT-6 list 的单 server 失败只影响那一条，且 missing（缺槽）要能解释为什么少一个', async () => {
  const pool = fakePool([
    { server: { name: 'down', exposure: 'deferred', tools: [] }, listToolsImpl: async () => { throw new Error('连不上'); } },
    { server: deferredServer },
  ], { missing: [{ name: 'github2', slots: ['TOKEN'] }] });
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool('mcp', { action: 'list' });
  assert.match(res.content, /down .*发现失败：连不上/);
  assert.match(res.content, /github — .*工具 2 个/, '一条失败不许把整份清单带崩');
  assert.match(res.content, /github2 — 未注册（缺配置槽：TOKEN）/);
});

test('MT-7 server 全挂时 search 仍从本地缓存命中；【反向】删缓存则无命中（§6.3/§6.6）', async () => {
  const pool = fakePool([{ server: deferredServer }, { server: directServer }]);
  const tool = createMcpTool({ pool });
  const hit = await tool.executeTool('mcp', { action: 'search', query: 'ISSUE' });
  assert.match(hit.content, /github\.create_issue — 创建 issue/, '零连接也要搜得到（缓存的意义就在这）');
  assert.equal(hit.metadata.hits, 1);
  assert.ok(!/hidden/.test(hit.content));

  // 反向：把缓存清空 ⇒ 必须无命中（说明命中真的来自缓存而不是现场连接）
  pool.get('github').tools.length = 0;
  const miss = await tool.executeTool('mcp', { action: 'search', query: 'issue' });
  assert.equal(miss.metadata.hits, 0);
  assert.match(miss.content, /无命中；若该 server 从未连过，先 mcp\(\{action:"list"\}\) 触发发现/);
});

test('MT-8 search 不返回 hidden 工具（§10.7；反向：摘掉 hidden 门禁就会被搜到）', async () => {
  const pool = fakePool([{ server: { ...deferredServer, name: 'danger', exposure: 'deferred' } }]);
  const open = await createMcpTool({ pool }).executeTool('mcp', { action: 'search', query: 'issue' });
  assert.equal(open.metadata.hits, 1, '前置：不加 hidden 名单时确实搜得到（github.create_issue）');
  const gated = await createMcpTool({ pool, hidden: ['danger'] })
    .executeTool('mcp', { action: 'search', query: 'issue' });
  assert.equal(gated.metadata.hits, 0, `hidden 泄漏进 search：${gated.content}`);
  const listed = await createMcpTool({ pool, hidden: ['danger'] }).executeTool('mcp', { action: 'list' });
  assert.match(listed.content, /danger — exposure=hidden/, 'list 要说明它在，但不可调用');
});

test('MT-9 status 不触发连接（§6.3）', async () => {
  const pool = fakePool([{ server: deferredServer, listToolsImpl: async () => { throw new Error('不该连'); } }]);
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool('mcp', { action: 'status' });
  assert.match(res.content, /github — state=idle toolsCached=true/);
});

test('MT-10 未知 action ⇒ mcp_bad_request 并给出允许值', async () => {
  const tool = createMcpTool({ pool: fakePool([{ server: deferredServer }]) });
  const res = await tool.executeTool('mcp', { action: 'destroy' });
  assert.equal(res.metadata.mcpError, MCP_TOOL_ERRORS.BAD_REQUEST);
  assert.deepEqual(res.metadata.allowed, ['list', 'search', 'call', 'status']);
});

// ---------------------------------------------------------------------------
// ③ call 的三种拒绝 + 成功路径（§6.3 / §6.7 / §10.7）
// ---------------------------------------------------------------------------

test('MT-11 call 缺 server ⇒ mcp_tool_ambiguous 并带 candidates（§6.3：本站不猜）', async () => {
  const pool = fakePool([{ server: deferredServer }, { server: { ...deferredServer, name: 'other' } }]);
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool('mcp', { action: 'call', tool: 'create_issue' });
  assert.equal(res.metadata.mcpError, MCP_TOOL_ERRORS.AMBIGUOUS);
  assert.deepEqual(res.metadata.candidates, ['github', 'other']);
});

test('MT-12 call 未知工具 ⇒ mcp_tool_unknown（缓存门禁，防越权）', async () => {
  const calls = [];
  const pool = fakePool([{ server: deferredServer, calls }]);
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool('mcp', { action: 'call', server: 'github', tool: 'drop_tables' });
  assert.equal(res.metadata.mcpError, MCP_TOOL_ERRORS.UNKNOWN);
  assert.deepEqual(res.metadata.known, ['create_issue', 'list_pr']);
  assert.equal(calls.length, 0, '门禁没拦住就会真的把调用打到 server 上');
});

test('MT-13【反向】hidden 工具 call ⇒ mcp_tool_hidden（不连接、不执行，§9 fail-closed）', async () => {
  const calls = [];
  const pool = fakePool([{ server: { ...deferredServer, name: 'danger' }, calls }]);
  const tool = createMcpTool({ pool, hidden: ['danger'] });
  const res = await tool.executeTool('mcp', { action: 'call', server: 'danger', tool: 'create_issue' });
  assert.equal(res.metadata.mcpError, MCP_TOOL_ERRORS.HIDDEN, '把 hidden 门禁摘掉这条就红（P1 没审批通道）');
  assert.equal(calls.length, 0);
});

test('MT-14 call 成功：args 原样透传，metadata 带 server/tool（§6.7），signal 传到传输层', async () => {
  const calls = [];
  const pool = fakePool([{ server: deferredServer, calls }]);
  const controller = new AbortController();
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool('mcp',
    { action: 'call', server: 'github', tool: 'create_issue', args: { title: 'T' } },
    { signal: controller.signal, runId: 'run-1' });
  assert.equal(res.content, 'ok:create_issue');
  assert.deepEqual(res.metadata, {
    server: 'github', tool: 'create_issue', isError: false, truncated: false, fullPath: null,
  });
  assert.deepEqual(calls[0].args, { title: 'T' }, 'args 原样透传，不加工不补默认值');
  assert.equal(calls[0].signal, controller.signal);
});

test('MT-15 传输层错误码原样上抛（mcp_call_timeout / mcp_unreachable），值不进详情', async () => {
  const pool = fakePool([{
    server: deferredServer,
    onCall: async () => { throw Object.assign(new Error('超时'), { code: MCP_ERRORS.TIMEOUT }); },
  }, {
    server: { ...deferredServer, name: 'dead' },
    onCall: async () => { throw Object.assign(new Error('进程退出'), { code: MCP_ERRORS.UNREACHABLE }); },
  }]);
  const tool = createMcpTool({ pool });
  const a = await tool.executeTool('mcp', { action: 'call', server: 'github', tool: 'create_issue' });
  assert.equal(a.metadata.mcpError, 'mcp_call_timeout');
  const b = await tool.executeTool('mcp', { action: 'call', server: 'dead', tool: 'create_issue' });
  assert.equal(b.metadata.mcpError, 'mcp_unreachable');
});

test('MT-16 isError=true 透传成 metadata.isError（宿主不许把失败塌成成功）', async () => {
  const pool = fakePool([{
    server: deferredServer,
    onCall: async () => ({ text: 'boom', isError: true, truncated: false, fullPath: null }),
  }]);
  const res = await createMcpTool({ pool })
    .executeTool('mcp', { action: 'call', server: 'github', tool: 'create_issue' });
  assert.equal(res.content, 'boom');
  assert.equal(res.metadata.isError, true);
});

test('MT-17 >20 KiB 的结果把 fullPath 带到 metadata（全文路径给模型，§6.7）', async () => {
  const pool = fakePool([{
    server: deferredServer,
    onCall: async () => ({ text: 'x', isError: false, truncated: true, fullPath: '/tmp/erix-mcp/r-1-a.txt' }),
  }]);
  const res = await createMcpTool({ pool })
    .executeTool('mcp', { action: 'call', server: 'github', tool: 'create_issue' });
  assert.equal(res.metadata.truncated, true);
  assert.equal(res.metadata.fullPath, '/tmp/erix-mcp/r-1-a.txt');
});

test('MT-18 direct 工具 executeTool 能路由到同一 call 通路（反向：改回 deferred 就不通）', async () => {
  const calls = [];
  const pool = fakePool([{ server: directServer, calls }]);
  const tool = createMcpTool({ pool });
  const res = await tool.executeTool(`${DIRECT_PREFIX}srch_hub__search`, { q: 'erix' }, { runId: 'r' });
  assert.equal(res.content, 'ok:search');
  assert.deepEqual(calls[0], { server: 'srch-hub', tool: 'search', args: { q: 'erix' }, signal: null });
  assert.equal(res.metadata.server, 'srch-hub');
  const bogus = await tool.executeTool('mcp__nope__nope', {});
  assert.equal(bogus.metadata.mcpError, MCP_TOOL_ERRORS.UNKNOWN);
});

// ---------------------------------------------------------------------------
// ⑨ 与真 pool + 假 stdio server 的合流：signal 取消真的发出 notifications/cancelled
// ---------------------------------------------------------------------------

function fakeSpawn(log) {
  return (command, args, options) => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter();
    child.pid = 70001;
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr;
    const send = (m) => stdout.write(`${JSON.stringify(m)}\n`);
    let buf = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line !== '') {
          const msg = JSON.parse(line);
          log.push(msg);
          if (msg.method === 'initialize') {
            send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: MCP_PROTOCOL_VERSION } });
          } else if (msg.method === 'tools/list') {
            send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'slow', description: '慢活' }] } });
          }
          // tools/call 装死 ⇒ 只能靠 signal 掐断
        }
        i = buf.indexOf('\n');
      }
    });
    return child;
  };
}

test('MT-19 options.signal 一路传到传输层：取消真的发出 notifications/cancelled（§1）', async () => {
  const frames = [];
  const pool = createMcpPool({
    servers: [{
      name: 'mock', transport: 'stdio', command: 'node', args: [], exposure: 'deferred',
      timeout_ms: 5_000, slots: [], tools: [{ name: 'slow', description: '慢活' }],
      resolved: { values: {} },
    }],
    spawnImpl: fakeSpawn(frames),
    onProcess: () => {},
    killImpl: () => {},
  });
  const tool = createMcpTool({ pool });
  const controller = new AbortController();
  const inflight = tool.executeTool('mcp', { action: 'call', server: 'mock', tool: 'slow' },
    { signal: controller.signal, runId: 'run-x' });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const res = await inflight;
  assert.equal(res.metadata.mcpError, 'mcp_aborted');
  const cancelled = frames.find((m) => m.method === 'notifications/cancelled');
  assert.ok(cancelled, `用户点停止必须通知 server（§1）：${JSON.stringify(frames.map((f) => f.method))}`);
  assert.equal(typeof cancelled.params.requestId, 'number');
  await pool.closeAll();
});

test('MT-20 pool.closeAll 之后再 call ⇒ mcp_unreachable（收尾之后不留活口）', async () => {
  const frames = [];
  const pool = createMcpPool({
    servers: [{
      name: 'mock', transport: 'stdio', command: 'node', exposure: 'deferred', timeout_ms: 1_000,
      slots: [], tools: [{ name: 'slow' }], resolved: { values: {} },
    }],
    spawnImpl: fakeSpawn(frames),
    onProcess: () => {},
    killImpl: () => {},
  });
  const tool = createMcpTool({ pool });
  await pool.closeAll();
  const res = await tool.executeTool('mcp', { action: 'call', server: 'mock', tool: 'slow' });
  assert.equal(res.metadata.mcpError, 'mcp_unreachable');
});
