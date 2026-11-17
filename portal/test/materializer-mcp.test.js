// portal/test/materializer-mcp.test.js —— MCP 物化产物的判据（issue #608，契约 §5）
//
// 为什么单独一支：`materializer.test.js` 已经 1000 行且只覆盖 skill 面；MCP 的判据重点在
// **「哪些东西不许出现在文件里」**（值、工具名进 capabilities.json、hidden 条目），
// 混进那支会让「文件里没有密钥」这条断言被淹没。
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { MCP_MAX_SCHEMA_BYTES, renderCapabilitiesJson, renderMcpJson } from '../src/materializer.js';

const SERVER = (over = {}) => ({
  name: 'erix-search', description: '内部搜索', transport: 'stdio', command: 'node',
  args: ['server.mjs'], exposure: 'deferred', lifecycle: 'run', timeout_ms: 30000,
  slots: [{ name: 'TOKEN', inject: 'env', required: true }],
  tools: [{ name: 'search', description: '搜一下', inputSchema: { type: 'object' } }],
  values: { TOKEN: '明文值' },        // 故意塞进来：物化产物里**必须看不到**
  ...over,
});

test('MM-1 mcp.json 是自定义 `{version,servers[]}` 形状（不是标准 mcpServers），且不含值', () => {
  const raw = renderMcpJson([SERVER()]);
  const obj = JSON.parse(raw);
  assert.equal(obj.version, 1);
  assert.ok(Array.isArray(obj.servers));
  assert.equal('mcpServers' in obj, false, '故意不用标准形状（平台要带 exposure/slots，标准形状装不下）');
  assert.equal(raw.includes('明文值'), false, '槽值绝不许进文件（值只在 run 内存里活一次）');
  assert.equal(obj.servers[0].slots[0].name, 'TOKEN', '槽位**声明**要进文件（runner 据此判断缺哪个）');
});

test('MM-2 direct 档带 inputSchema；deferred 档不带（工具名/描述仍给，供检索）', () => {
  const d = JSON.parse(renderMcpJson([SERVER({ exposure: 'direct' })])).servers[0];
  assert.equal(d.exposure, 'direct');
  assert.deepEqual(d.tools[0].inputSchema, { type: 'object' });
  const f = JSON.parse(renderMcpJson([SERVER({ exposure: 'deferred' })])).servers[0];
  assert.equal(f.tools[0].inputSchema, undefined, 'deferred 不送 schema（那是网关按需取的）');
  assert.equal(f.tools[0].description, '搜一下');
});

test('MM-3 direct 但 schema 超 64 KiB ⇒ 降级 deferred 且丢掉 schema（反向：小的不降级）', () => {
  const big = { type: 'object', properties: { x: { description: 'y'.repeat(MCP_MAX_SCHEMA_BYTES) } } };
  const s = JSON.parse(renderMcpJson([SERVER({ exposure: 'direct', tools: [{ name: 'a', description: 'd', inputSchema: big }] })])).servers[0];
  assert.equal(s.exposure, 'deferred', '超限必须降级（否则 64 KiB 的 schema 会被塞进容器）');
  assert.equal(s.tools[0].inputSchema, undefined);

  const small = JSON.parse(renderMcpJson([SERVER({ exposure: 'direct' })])).servers[0];
  assert.equal(small.exposure, 'direct');
});

test('MM-4 传输面：stdio 只出 command/args、http 只出 url；缺字段补空串不补 undefined', () => {
  const stdio = JSON.parse(renderMcpJson([SERVER()])).servers[0];
  assert.equal(stdio.command, 'node');
  assert.deepEqual(stdio.args, ['server.mjs']);
  assert.equal('url' in stdio, false);
  const http = JSON.parse(renderMcpJson([SERVER({ transport: 'http', url: 'https://x/mcp' })])).servers[0];
  assert.equal(http.url, 'https://x/mcp');
  assert.equal('command' in http, false);
  const broken = JSON.parse(renderMcpJson([SERVER({ command: undefined })])).servers[0];
  assert.equal(broken.command, '', '缺 command 补空串（runner 侧据此报「配置坏了」而不是崩在 undefined）');
});

test('MM-5 排序稳定 + 非法条目被剔除（name 空 / 非数组输入）', () => {
  const obj = JSON.parse(renderMcpJson([
    SERVER({ name: 'zeta' }), SERVER({ name: 'alpha' }), { name: '' }, null,
  ]));
  assert.deepEqual(obj.servers.map((s) => s.name), ['alpha', 'zeta']);
  assert.deepEqual(JSON.parse(renderMcpJson(undefined)), { version: 1, servers: [] });
});

test('MM-6 capabilities.json 的 mcp 段只放路由信号：没有工具名、没有值、hidden 不出现', () => {
  const raw = renderCapabilitiesJson([], [
    SERVER({ name: 'zeta', exposure: 'direct' }),
    SERVER({ name: 'alpha' }),
    SERVER({ name: 'ghost', exposure: 'hidden' }),
  ]);
  const obj = JSON.parse(raw);
  assert.deepEqual(obj.mcp.map((m) => m.name), ['alpha', 'zeta'], 'hidden 整条不进清单');
  assert.deepEqual(Object.keys(obj.mcp[0]).sort(), ['description', 'exposure', 'name', 'tool_count']);
  assert.equal(raw.includes('search'), false, '工具名不进 capabilities.json（几百 token，mcp.json 里有）');
  assert.equal(raw.includes('明文值'), false, '值绝不许进文件');
  assert.equal(obj.mcp[0].tool_count, 1);
});

test('MM-7 skills 永不被 mcp 挤掉（同一份 capabilities.json 里两段各自独立）', () => {
  const skills = [{ id: 's1', name: '技能一', summary: 's', when_to_use: 'w', tools: ['t'] }];
  const obj = JSON.parse(renderCapabilitiesJson(skills, [SERVER()]));
  assert.equal(obj.skills.length, 1, 'skills 段不受 mcp 段影响');
  assert.equal(obj.mcp.length, 1);
  assert.deepEqual(Object.keys(obj).sort(), ['mcp', 'skills', 'version']);
});
