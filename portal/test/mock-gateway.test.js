// 单测：mock LLM 网关（零真实凭据）——虚拟 key 校验 + 流式 SSE + 非流式。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayServer, createDebugServer } from '../mock-gateway/server.mjs';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function post(port, path, { body, key } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body ?? { model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
  });
  return res;
}

test('mock 网关：/__debug/last-request（Phase C dev 调试端点，F4 起独立调试端口）', async (t) => {
  const server = createGatewayServer();
  const debug = createDebugServer();
  const port = await listen(server);
  const debugPort = await listen(debug);
  t.after(() => { server.close(); debug.close(); });

  // F4 回归锚点：数据面端口对 /__debug/* 一律 404（该端点含全局 Authorization，同端口 = 跨 FDE 泄露）
  const dataPlane = await fetch(`http://127.0.0.1:${port}/__debug/last-request`);
  assert.equal(dataPlane.status, 404, '数据面端口不得提供 /__debug/last-request');

  // 无请求 → 204（调试端口）
  const empty = await fetch(`http://127.0.0.1:${debugPort}/__debug/last-request`);
  assert.equal(empty.status, 204);

  // 401 路径（真 key 形态过不了虚拟 key 校验）也记录 authorization + model——注入断言依赖此行为
  const bad = await post(port, '/v1/chat/completions', { key: 'sk-e2e-abcdef123456', body: { model: 'mock-model-a', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(bad.status, 401);
  const seen = await fetch(`http://127.0.0.1:${debugPort}/__debug/last-request`);
  assert.equal(seen.status, 200);
  const seenBody = await seen.json();
  assert.equal(seenBody.authorization, 'Bearer sk-e2e-abcdef123456');
  assert.equal(seenBody.model, 'mock-model-a');
  assert.equal(typeof seenBody.ts, 'number');

  // 数据面再次确认：记录已存在时数据面端口仍 404（不是「无记录 → 204」的误读）
  const dataPlane2 = await fetch(`http://127.0.0.1:${port}/__debug/last-request`);
  assert.equal(dataPlane2.status, 404, '记录存在后数据面端口仍必须 404');

  // 合法请求覆盖记录
  const ok = await post(port, '/v1/chat/completions', { key: 'erix-placeholder', body: { model: 'mock-model-b', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(ok.status, 200);
  const seen2 = await (await fetch(`http://127.0.0.1:${debugPort}/__debug/last-request`)).json();
  assert.equal(seen2.authorization, 'Bearer erix-placeholder');
  assert.equal(seen2.model, 'mock-model-b');

  // 调试面其它路径也 404
  const nf = await fetch(`http://127.0.0.1:${debugPort}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(nf.status, 404, '调试面不提供数据面路径');
});

test('mock 网关：虚拟 key 校验（erix-* 通过，其它 401）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const ok = await post(port, '/v1/chat/completions', { key: 'erix-placeholder' });
  assert.equal(ok.status, 200);

  const ok2 = await post(port, '/v1/chat/completions', { key: 'erix-mock' });
  assert.equal(ok2.status, 200);

  const bad = await post(port, '/v1/chat/completions', { key: 'sk-real-key' });
  assert.equal(bad.status, 401);
  const badBody = await bad.json();
  assert.equal(badBody.error.code, 'invalid_api_key');

  const none = await post(port, '/v1/chat/completions', {});
  assert.equal(none.status, 401);
});

test('mock 网关：非流式返回 OpenAI 形状（回显 + 固定 token 计数）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'hello world' }], stream: false },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.ok(body.choices[0].message.content.includes('hello world'));
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.ok(body.usage.total_tokens > 0);
});

test('mock 网关：流式 SSE（分块 + [DONE]）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'stream me' }], stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const text = await res.text();
  assert.ok(text.includes('data: '), 'SSE data 行存在');
  assert.ok(text.includes('[DONE]'), '流式以 [DONE] 结束');
  const chunks = text.split('data: ').filter((s) => s.trim() && !s.trim().startsWith('[DONE]'));
  assert.ok(chunks.length >= 2, `至少两段 chunk：${text}`);
  for (const c of chunks) {
    const obj = JSON.parse(c.trim().split('\n')[0]);
    assert.equal(obj.object, 'chat.completion.chunk');
  }
});

test('mock 网关：/healthz 与未知路径', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);

  const nf = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(nf.status, 404);
});

const TOOL_RESULT_MSGS = (toolName) => [
  { role: 'user', content: 'USE_SHELL' },
  { role: 'assistant', tool_calls: [{ id: 'call_x', type: 'function', function: { name: toolName, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'call_x', content: 'exit_code: 0\nduration_ms: 12\ntruncated: false\nv22.0.0' },
];

test('mock 网关：USE_TOOL 触发 → tree tool_call（WP5 回归锚点，行为不变）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: '帮我看看目录，用工具' }], stream: false },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const tc = body.choices[0].message.tool_calls;
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(tc.length, 1);
  assert.equal(tc[0].function.name, 'tree');
  assert.equal(tc[0].function.arguments, '{"path":"."}');

  // 第二轮：对话含 tool 结果 → tree 固定收尾文本
  const final = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: TOOL_RESULT_MSGS('tree'), stream: false },
  });
  const finalBody = await final.json();
  assert.equal(finalBody.choices[0].finish_reason, 'stop');
  assert.ok(finalBody.choices[0].message.content.includes('已执行 tree 工具'));
});

test('mock 网关：USE_SHELL 触发 → shell tool_call（issue #72/#64 真机 e2e 探针）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'USE_SHELL' }], stream: false },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const tc = body.choices[0].message.tool_calls;
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(tc.length, 1);
  assert.equal(tc[0].function.name, 'shell');
  const args = JSON.parse(tc[0].function.arguments);
  // 命令既验证 shell 真执行（node --version），又在项目目录留下 untracked 探针文件（issue #64 产物回收）
  assert.ok(args.command.includes('node --version'));
  assert.ok(args.command.includes('shell-probe.txt'));

  // 第二轮：对话含 tool 结果 → shell 专属固定收尾文本（区分于 tree）
  const final = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: TOOL_RESULT_MSGS('shell'), stream: false },
  });
  const finalBody = await final.json();
  assert.equal(finalBody.choices[0].finish_reason, 'stop');
  assert.ok(finalBody.choices[0].message.content.includes('已执行 shell 工具'));
  assert.ok(finalBody.choices[0].message.content.includes('shell-probe.txt'));
});

test('mock 网关：USE_SHELL 优先级高于 USE_TOOL（同消息两者并存按 shell 处理）', async (t) => {
  const server = createGatewayServer();
  const port = await listen(server);
  t.after(() => server.close());

  const res = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'USE_TOOL 和 USE_SHELL 都有' }], stream: false },
  });
  const body = await res.json();
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'shell');

  // 流式路径同样优先 shell
  const sres = await post(port, '/v1/chat/completions', {
    key: 'erix-placeholder',
    body: { model: 'mock-model', messages: [{ role: 'user', content: 'use_tool use_shell' }], stream: true },
  });
  const text = await sres.text();
  assert.ok(text.includes('"name":"shell"'), `流式 tool_call 应为 shell：${text}`);
});
