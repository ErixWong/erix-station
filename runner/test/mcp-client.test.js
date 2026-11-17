// runner/test/mcp-client.test.js —— MCP 传输层（issue #608 §11「runner」段第一条）
//
// 全假传输：stdio 用「内存里的假 server」（PassThrough 拼一条换行分隔 JSON-RPC 对话），
// http 用注入的假 fetch（并**照实现尊重 AbortSignal**）。
// ⇒ 零进程、零网络、零端口，可以确定性断言**帧顺序**、**重试次数**与**信号序列**。
// 标【反向】的用例是 §11 要求的退化自证：实现被改坏（改回 follow 重定向 / 给 call 加重试）时必须红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  MCP_PROTOCOL_VERSION,
  MCP_ERRORS,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  RESULT_INLINE_BYTES,
  STDIO_ENV_ALLOWLIST,
  STDERR_KEEP_BYTES,
  appendStderrTail,
  buildStdioEnv,
  buildHttpHeaders,
  resolveTimeoutMs,
  assertHttpUrl,
  flattenToolContent,
  clipLargeResult,
  createMcpClient,
  createMcpPool,
} from '../lib/mcp-client.js';

// ---------------------------------------------------------------------------
// 假 stdio server（每次 spawn 造一个新的，因为**重试路径**必然重新 spawn）
// ---------------------------------------------------------------------------

/**
 * @param {{onRequest?: (msg,send)=>boolean, hangMethods?: string[], stderrChunks?: string[],
 *   pidBase?: number}} [behaviour]
 */
function fakeStdioSpawn(behaviour = {}) {
  const frames = [];          // 全部 spawn 收到的帧（含通知），按到达顺序
  const children = [];
  const pidBase = behaviour.pidBase ?? 424200;

  function defaultReply(msg, send) {
    if (msg.method === 'initialize') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          protocolVersion: behaviour.protocolVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: {}, serverInfo: { name: 'fake', version: '1' },
        },
      });
      return;
    }
    if (msg.method === 'tools/list') {
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object' } }] },
      });
      return;
    }
    if (msg.method === 'tools/call') {
      if (behaviour.hangMethods?.includes('tools/call')) return;   // 装死 ⇒ 触发超时
      send({
        jsonrpc: '2.0', id: msg.id,
        result: { content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }] },
      });
      return;
    }
    if (msg.method && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} });
  }

  const spawnCalls = [];
  const spawnImpl = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter();
    child.pid = pidBase + children.length;
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    const send = (msg) => {
      stdout.write(`${JSON.stringify(msg)}\n`);
    };
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
          // 账上记的是**收到的帧**（请求与通知）：重试次数、握手顺序、取消通知全靠它数。
          frames.push(msg);
          const handled = behaviour.onRequest ? behaviour.onRequest(msg, send) : false;
          if (!handled) defaultReply(msg, send);
        }
        i = buf.indexOf('\n');
      }
    });
    for (const chunk of behaviour.stderrChunks ?? []) stderr.write(chunk);
    children.push(child);
    return child;
  };

  return {
    spawnImpl,
    spawnCalls,
    frames,
    children,
    /** 某一帧类型出现的次数（跨全部 spawn）——重试类断言的口径。 */
    countOf: (method) => frames.filter((m) => m.method === method).length,
    methods: () => frames.filter((m) => m.method).map((m) => m.method),
    first: (method) => frames.find((m) => m.method === method) ?? null,
    lastChild: () => children.at(-1),
  };
}

const stdioServer = {
  name: 'mock', transport: 'stdio', command: 'node', args: ['mock-mcp.js'],
  exposure: 'deferred', lifecycle: 'run', timeout_ms: 2_000,
  slots: [{ name: 'ECHO_PREFIX', inject: 'env', required: true }],
  tools: [],
};

const httpServer = {
  name: 'hub', transport: 'http', url: 'https://srch.erix.vip/mcp',
  exposure: 'direct', lifecycle: 'run-keep-alive', timeout_ms: 2_000,
  slots: [{ name: 'AUTHORIZATION', inject: 'header', required: true }],
  tools: [{ name: 'search', description: '搜索', inputSchema: { type: 'object' } }],
};

const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// ① 握手与调用（stdio）
// ---------------------------------------------------------------------------

test('MC-1 stdio 握手顺序逐帧钉死：initialize → notifications/initialized → tools/list', async () => {
  const srv = fakeStdioSpawn();
  const client = createMcpClient({
    server: stdioServer, resolved: { values: { ECHO_PREFIX: 'P' } }, spawnImpl: srv.spawnImpl,
  });
  const tools = await client.listTools();
  assert.deepEqual(srv.methods(), ['initialize', 'notifications/initialized', 'tools/list'],
    `握手顺序错了服务端会直接拒（§1）：${JSON.stringify(srv.methods())}`);
  const init = srv.first('initialize');
  assert.equal(init.params.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(init.params.clientInfo.name, 'station-runner');
  assert.deepEqual(tools.map((t) => t.name), ['echo'], 'tools/list 的结果必须进本地缓存视图');
  assert.equal(client.tools.length, 1);
  assert.equal(client.exposure, 'deferred');
  assert.equal(client.lifecycle, 'run-keep-alive' === 'x' ? '' : 'run',
    '§6.4：P1 里 run 与 run-keep-alive 行为相同，字段只为 P2 预留');
});

test('MC-2 callTool 成功 + isError 透传 + 非文本块塌成 [image omitted]', async () => {
  const srv = fakeStdioSpawn({
    onRequest: (msg, send) => {
      if (msg.method !== 'tools/call') return false;
      send({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: 'A' }, { type: 'image', data: 'zzz' }, { type: 'text', text: 'B' }],
          isError: true,
        },
      });
      return true;
    },
  });
  const client = createMcpClient({ server: stdioServer, spawnImpl: srv.spawnImpl });
  const out = await client.callTool('echo', { text: 'hi' });
  assert.equal(out.text, 'A\n[image omitted]\nB', 'image/resource 不许把 base64 灌进上下文（§6.7）');
  assert.equal(out.isError, true, 'isError 必须透传：宿主不许把失败塌成成功');
  assert.equal(out.truncated, false);
  assert.equal(out.fullPath, null);
  assert.deepEqual(srv.first('tools/call').params, { name: 'echo', arguments: { text: 'hi' } });
});

test('MC-3 env 白名单（§10.9）：只给 PATH/HOME/LANG/TZ/TMPDIR + 槽位值，ERIX_*/STATION_* 一律不传', async () => {
  const srv = fakeStdioSpawn();
  const client = createMcpClient({
    server: stdioServer,
    resolved: { values: { ECHO_PREFIX: 'CANARY_v' } },
    spawnImpl: srv.spawnImpl,
    baseEnv: {
      PATH: '/usr/bin', HOME: '/home/erix', LANG: 'C.UTF-8', TZ: 'UTC', TMPDIR: '/tmp',
      ERIX_STATION_TOKEN: 'tok', STATION_MASKED: 'm', FDE_NAME: 'alice', SHELL: '/bin/bash',
    },
  });
  await client.listTools();
  const options = srv.spawnCalls[0].options;
  const env = options.env;
  assert.deepEqual(Object.keys(env).sort(), ['ECHO_PREFIX', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ'],
    `多传一个键就是多送一份平台身份：${JSON.stringify(Object.keys(env))}`);
  assert.equal(env.ECHO_PREFIX, 'CANARY_v', '槽位值必须真的注入（e2e 的 PREFIX:hello 全靠它）');
  assert.equal(options.detached, true, 'detached:true 是进程组回收的前提（§6.8）');
  assert.equal(STDIO_ENV_ALLOWLIST.includes('SHELL'), false, '白名单不许被顺手扩大');
  assert.deepEqual(buildStdioEnv({ server: stdioServer, values: {}, baseEnv: {} }), {},
    '白名单项缺失时不得凭空造键（传空串会让子进程拿到 undefined→"undefined"）');
});

test('MC-4 子进程 spawn/exit 必须上报 pgid（§6.8；反向：摘掉 onProcess 则 agentd 那本账永远挂着）', async () => {
  const events = [];
  const srv = fakeStdioSpawn();
  const client = createMcpClient({
    server: stdioServer, spawnImpl: srv.spawnImpl, onProcess: (e) => events.push(e),
  });
  await client.listTools();
  assert.deepEqual(events, [{ phase: 'spawn', pgid: 424200, name: 'mock' }]);
  srv.lastChild().emit('exit', 0, null);
  assert.deepEqual(events.map((e) => e.phase), ['spawn', 'exit'], 'exit 不报 = 补杀会打一个已复用的 pid');
});

test('MC-5 close() 幂等且信号序列 = stdin.end → SIGTERM(-pgid) → SIGKILL(-pgid)（§6.8）', async () => {
  const seq = [];
  const srv = fakeStdioSpawn();
  const client = createMcpClient({
    server: stdioServer,
    spawnImpl: (...args) => {
      const child = srv.spawnImpl(...args);
      const realEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = (...a) => { seq.push('stdin.end'); return realEnd(...a); };
      return child;
    },
    killImpl: (pid, sig) => { seq.push(`${sig}(${pid})`); },
    delay: () => Promise.resolve(),
  });
  await client.listTools();
  await client.close();
  await client.close();
  await client.close();
  assert.deepEqual(seq, ['stdin.end', 'SIGTERM(-424200)', 'SIGKILL(-424200)'],
    `负 pid = 打整个进程组；漏 SIGKILL 就留下常驻孤儿（§6.8）：${JSON.stringify(seq)}`);
});

test('MC-6 子进程已自然退出时 close() 不再补刀（pid 可能被 OS 复用），状态离开 ready', async () => {
  const kills = [];
  const srv = fakeStdioSpawn();
  const client = createMcpClient({
    server: stdioServer, spawnImpl: srv.spawnImpl,
    killImpl: (pid, sig) => kills.push([pid, sig]), delay: () => Promise.resolve(),
  });
  await client.listTools();
  srv.lastChild().emit('exit', 1, null);
  await client.close();
  assert.deepEqual(kills, [], '已自然退出的组不该再杀');
  assert.match(client.status().error ?? '', /退出/, '死因要留在 status 里（运维只看得见这个）');
});

// ---------------------------------------------------------------------------
// ② 超时 / 重试 / 熔断（§1 + §10.4 + §6.4）
// ---------------------------------------------------------------------------

test('MC-7 超时钳制与单请求超时（默认 60 s、≤300 s）；超时后不重试（§1）', async () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(999_999), MAX_TIMEOUT_MS, '§10.8：timeout_ms ≤ 300 s');
  assert.equal(resolveTimeoutMs(0), DEFAULT_TIMEOUT_MS, '非法值退回默认，不炸 run');
  assert.equal(resolveTimeoutMs('abc'), DEFAULT_TIMEOUT_MS);
  const srv = fakeStdioSpawn({ hangMethods: ['tools/call'] });
  const client = createMcpClient({
    server: { ...stdioServer, timeout_ms: 40 }, spawnImpl: srv.spawnImpl,
  });
  await assert.rejects(() => client.callTool('echo', {}), (err) => {
    assert.equal(err.code, MCP_ERRORS.TIMEOUT);
    return true;
  });
  assert.equal(srv.countOf('tools/call'), 1, '超时后 abort 连接、不重试（§1 明写）');
});

test('MC-8【反向】initialize 允许重试一次；tools/call 一次都不重试（§0 结论 6）', async () => {
  // 握手永远回 JSON-RPC error（每次 spawn 一个新假 server，所以重试真的会再发一帧）。
  const down = fakeStdioSpawn({
    onRequest: (msg, send) => {
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'nope' } });
        return true;
      }
      return false;
    },
  });
  const client = createMcpClient({ server: stdioServer, spawnImpl: down.spawnImpl });
  await assert.rejects(() => client.callTool('echo', {}));
  assert.equal(down.countOf('initialize'), 2, `握手 = 一次重试（2 次尝试）：实得 ${down.countOf('initialize')}`);
  assert.equal(down.countOf('tools/call'), 0, '握手没成就不该发出调用');

  // 握手成功、调用失败：`tools/call` 必须**恰好 1 次**（把「call 也重试」实现回去，这条就红）。
  const boom = fakeStdioSpawn({
    onRequest: (msg, send) => {
      if (msg.method !== 'tools/call') return false;
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'boom' } });
      return true;
    },
  });
  const client2 = createMcpClient({ server: stdioServer, spawnImpl: boom.spawnImpl });
  await assert.rejects(() => client2.callTool('echo', {}));
  assert.equal(boom.countOf('tools/call'), 1,
    `tools/call 永不重试（副作用可能已发生）：实得 ${boom.countOf('tools/call')} 次`);
});

test('MC-9 连续失败 3 次熔断到 run 结束（§6.4）；熔断后不再 spawn、不再烧超时', async () => {
  const srv = fakeStdioSpawn({
    onRequest: (msg, send) => {
      if (msg.method === 'initialize') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'down' } });
        return true;
      }
      return false;
    },
  });
  const client = createMcpClient({ server: stdioServer, spawnImpl: srv.spawnImpl });
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => client.callTool('echo', {}));
  }
  const spawnedAfterThree = srv.spawnCalls.length;
  const code = await client.callTool('echo', {}).then(() => 'ok', (err) => err.code);
  assert.equal(code, MCP_ERRORS.UNREACHABLE, '熔断后直接 mcp_unreachable（不再白烧一次握手超时）');
  assert.equal(srv.spawnCalls.length, spawnedAfterThree, '熔断后不得再 spawn 子进程');
  assert.equal(client.status().state, 'fused');
});

test('MC-10 signal 取消发出 notifications/cancelled（§1）并把请求落定', async () => {
  const srv = fakeStdioSpawn({ hangMethods: ['tools/call'] });
  const controller = new AbortController();
  const client = createMcpClient({
    server: { ...stdioServer, timeout_ms: 5_000 }, spawnImpl: srv.spawnImpl,
  });
  const p = client.callTool('echo', { text: 'x' }, { signal: controller.signal });
  await tick();
  controller.abort();
  const err = await p.then(() => null, (e) => e);
  assert.equal(err?.code, MCP_ERRORS.ABORTED);
  const cancelled = srv.first('notifications/cancelled');
  assert.ok(cancelled, `用户点停止必须通知服务端（§1）：${JSON.stringify(srv.methods())}`);
  assert.equal(typeof cancelled.params.requestId, 'number');
  assert.equal(cancelled.params.reason, 'host abort');
});

// ---------------------------------------------------------------------------
// ③ stderr 与结果处理（§1 + §6.7）
// ---------------------------------------------------------------------------

test('MC-11 stderr 只留末 4 KiB（§1），死因带退出码与这段尾巴', async () => {
  const chunks = [];
  for (let i = 0; i < 40; i += 1) chunks.push(`${String(i).padStart(3, '0')}${'x'.repeat(200)}\n`);
  const joined = chunks.join('');
  assert.ok(Buffer.byteLength(joined) > STDERR_KEEP_BYTES, '前置：stderr 必须大于 4 KiB');
  assert.equal(appendStderrTail('', joined).length <= STDERR_KEEP_BYTES, false, '按字节裁，不是按字符');
  const tail = appendStderrTail('', joined, STDERR_KEEP_BYTES);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= STDERR_KEEP_BYTES, `裁完必须 ≤ ${STDERR_KEEP_BYTES} 字节`);
  assert.ok(tail.includes('039'), '留的必须是**尾部**（头部那几百行没有诊断价值）');
  assert.equal(tail.startsWith('000xxx'), false);

  const srv = fakeStdioSpawn({ hangMethods: ['tools/call'] });
  const client = createMcpClient({
    server: { ...stdioServer, timeout_ms: 5_000 }, spawnImpl: srv.spawnImpl,
  });
  const inFlight = client.callTool('echo', {}).then(() => null, (e) => e);
  await tick();
  srv.lastChild().emit('exit', 7, 'SIGTERM');
  const err = await inFlight;
  assert.match(err.message, /code=7/, '进程退出必须把退出码写进错误（否则运维只能猜）');
});

test('MC-12 >20 KiB 掐中间 + 全文落 /tmp/erix-mcp/<runId>-<rand>.txt（§6.7）', () => {
  const writes = [];
  const fsStub = { mkdirSync: () => {}, writeFileSync: (p, body) => writes.push([p, body]) };
  const big = `HEAD${'z'.repeat(RESULT_INLINE_BYTES * 2)}TAIL`;
  const out = clipLargeResult(big, {
    runId: 'run-abc', tmpRoot: '/tmp/erix-mcp', fsImpl: fsStub, rand: () => 'deadbeef',
  });
  assert.equal(out.truncated, true);
  assert.equal(out.fullPath, '/tmp/erix-mcp/run-abc-deadbeef.txt');
  assert.equal(writes[0][1], big, '全文必须逐字节落盘（掐中间是**显示**层的取舍，不是数据层的）');
  assert.match(out.text, /^HEAD/);
  assert.match(out.text, /TAIL$/);
  assert.match(out.text, /…\d+ chars truncated…/, '必须写明掐掉多少（静默截断 = 模型以为结果就这么长）');
  assert.ok(out.text.includes(out.fullPath), '结果里必须给全文路径');
  assert.deepEqual(clipLargeResult('short', { runId: 'r', fsImpl: fsStub }),
    { text: 'short', truncated: false, fullPath: null }, '短结果一个字节都不动');
  // 落盘失败不许丢结果
  const broken = clipLargeResult(big, {
    runId: 'r', fsImpl: { mkdirSync: () => { throw new Error('ro'); }, writeFileSync: () => {} },
  });
  assert.equal(broken.truncated, true);
  assert.equal(broken.fullPath, null);
});

test('MC-13 flattenToolContent：只有 text 进正文，image/resource 占位（§6.7）', () => {
  assert.equal(flattenToolContent({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
  assert.equal(flattenToolContent({ content: [{ type: 'resource', resource: {} }] }), '[image omitted]');
  assert.equal(flattenToolContent({}), '');
});

// ---------------------------------------------------------------------------
// ④ HTTP 传输（§1）
// ---------------------------------------------------------------------------

/** 假 fetch：按脚本回响应；**尊重 AbortSignal**（否则超时类用例永远挂住）。 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, options) => {
    const record = { url, options, body: JSON.parse(options.body) };
    calls.push(record);
    const step = script[calls.length - 1] ?? script.at(-1);
    const outcome = typeof step === 'function' ? step(record) : step;
    if (!options?.signal) return outcome;
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve(outcome).then(
        (v) => { options.signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { options.signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  };
  return { impl, calls };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/** 重定向响应（假 fetch：Location 头）。 */
function redirectResponse(location) {
  return {
    ok: false, status: 302,
    headers: { get: (k) => (String(k).toLowerCase() === 'location' ? location : null) },
    text: async () => '',
  };
}

/** SSE 响应：逐帧喂（`for await` 可迭代），命中请求 id 的那帧在中间。 */
function sseResponse(frames, { headers = {} } = {}) {
  const map = new Map(Object.entries({ 'content-type': 'text/event-stream', ...headers }));
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => map.get(String(k).toLowerCase()) ?? null },
    body: {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () => (i < frames.length
            ? { value: frames[i++], done: false }
            : { value: undefined, done: true }),
        };
      },
    },
  };
}

const okInit = () => ({ body }) => jsonResponse({
  jsonrpc: '2.0', id: body.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} },
}, { headers: { 'mcp-session-id': 'sess-1' } });
const okNotify = () => () => jsonResponse('', { status: 202 });
const listResult = (tools = [{ name: 'search', description: '搜索' }]) => ({ body }) => jsonResponse({
  jsonrpc: '2.0', id: body.id, result: { tools },
});
const httpError = (status) => () => jsonResponse({ error: { code: status, message: 'x' } }, { status });

test('MC-14 HTTP 请求头（§1）：content-type + accept 双值 + 注入头 + 握手后带 mcp-session-id', async () => {
  const { impl, calls } = fakeFetch([okInit(), okNotify(), listResult()]);
  const client = createMcpClient({
    server: httpServer, resolved: { values: { AUTHORIZATION: 'Bearer CANARY' } }, fetchImpl: impl,
  });
  await client.listTools();
  assert.deepEqual(calls.map((c) => c.body.method),
    ['initialize', 'notifications/initialized', 'tools/list']);
  const initHeaders = calls[0].options.headers;
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(initHeaders['content-type'], 'application/json');
  assert.equal(initHeaders.accept, 'application/json, text/event-stream',
    '只写 json 会被按旧协议回的 server 拒（§1）');
  assert.equal(initHeaders.authorization, 'Bearer CANARY', 'AUTHORIZATION → authorization');
  assert.equal(initHeaders['mcp-session-id'], undefined, '握手请求自己还没有会话号');
  assert.equal(calls[2].options.headers['mcp-session-id'], 'sess-1', '会话号必须缓存并回带（§1）');
});

test('MC-15 HTTP 404 ⇒ 清会话号**重握手一次**（§1：仅此一处重试）', async () => {
  let listAttempts = 0;
  const { impl, calls } = fakeFetch([
    okInit(), okNotify(), httpError(404), okInit(), okNotify(),
    () => { listAttempts += 1; return listResult()({ body: { id: 9 } }); },
  ]);
  const client = createMcpClient({
    server: httpServer, resolved: { values: { AUTHORIZATION: 'Bearer x' } }, fetchImpl: impl,
  });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search']);
  assert.equal(listAttempts, 1, '重握手后只再试一次（第二次还 404 就报错，不进循环）');
  assert.deepEqual(calls.map((c) => c.body.method),
    ['initialize', 'notifications/initialized', 'tools/list',
      'initialize', 'notifications/initialized', 'tools/list']);
});

test('MC-16【反向】跨 origin 重定向丢弃注入头；同 origin 保留（§1）', async () => {
  const cross = fakeFetch([
    okInit(), okNotify(), redirectResponse('https://evil.example.org/x'), listResult([]),
  ]);
  const client = createMcpClient({
    server: httpServer, resolved: { values: { AUTHORIZATION: 'Bearer SECRET' } }, fetchImpl: cross.impl,
  });
  await client.listTools();
  const after = cross.calls.at(-1).options.headers;
  assert.equal(after.authorization, undefined,
    '凭据跟着重定向跑到别人域名就是白送：把实现改回 redirect:"follow" 这条必须红');
  assert.equal(after['content-type'], 'application/json', '协议必需头不能丢，否则下一跳直接 400');
  assert.equal(cross.calls.at(-1).url, 'https://evil.example.org/x');

  const same = fakeFetch([
    okInit(), okNotify(), redirectResponse('/mcp/v2'), listResult([]),
  ]);
  const client2 = createMcpClient({
    server: httpServer, resolved: { values: { AUTHORIZATION: 'Bearer SECRET' } }, fetchImpl: same.impl,
  });
  await client2.listTools();
  assert.equal(same.calls.at(-1).options.headers.authorization, 'Bearer SECRET',
    '同 origin 跳转丢头就是自断（服务端会 401）');
  assert.equal(same.calls.at(-1).url, 'https://srch.erix.vip/mcp/v2', '相对 Location 要按当前 url 解析');
});

test('MC-17 SSE 逐帧解析：忽略 event: 行与不匹配的帧，命中请求 id 即结束（§1）', async () => {
  const frames = [
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
    'data: {"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"search","description":"命中"}]}}\n\n',
    'data: {"jsonrpc":"2.0","method":"notifications/status","params":{}}\n\n',
  ];
  const { impl } = fakeFetch([okInit(), okNotify(), () => sseResponse(frames)]);
  const client = createMcpClient({ server: httpServer, resolved: { values: {} }, fetchImpl: impl });
  const tools = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search']);
});

test('MC-18 URL 策略：只允许 http/https（§1）；私网/回环允许', () => {
  assert.equal(assertHttpUrl('https://a/b').protocol, 'https:');
  assert.equal(assertHttpUrl('http://127.0.0.1:8080/mcp').protocol, 'http:', '内部 hub 就是私网');
  for (const bad of ['file:///etc/passwd', 'gopher://x', 'data:text/plain,x', 'not a url']) {
    assert.throws(() => assertHttpUrl(bad), (err) => {
      assert.equal(err.code, MCP_ERRORS.UNREACHABLE);
      return true;
    }, `协议没挡：${bad}`);
  }
  assert.throws(() => createMcpClient({ server: { name: 'x', transport: 'http', url: 'file:///e' } }),
    (err) => err.code === MCP_ERRORS.UNREACHABLE);
});

test('MC-19 HTTP 超时报 mcp_call_timeout（不重试）；网络失败报 mcp_unreachable', async () => {
  const hang = fakeFetch([okInit(), okNotify(), () => new Promise(() => {})]);
  const client = createMcpClient({
    server: { ...httpServer, timeout_ms: 40 }, resolved: { values: {} }, fetchImpl: hang.impl,
  });
  await assert.rejects(() => client.listTools(), (err) => {
    assert.equal(err.code, MCP_ERRORS.TIMEOUT);
    return true;
  });
  assert.equal(hang.calls.filter((c) => c.body.method === 'tools/list').length, 1, '超时不重试（§1）');

  const boom = fakeFetch([
    okInit(), okNotify(), listResult(),
    () => Promise.reject(Object.assign(new Error('ECONNRESET'), { name: 'TypeError' })),
  ]);
  const client2 = createMcpClient({ server: httpServer, resolved: { values: {} }, fetchImpl: boom.impl });
  await client2.listTools();
  const err = await client2.callTool('search', {}).then(() => null, (e) => e);
  assert.equal(err?.code, MCP_ERRORS.UNREACHABLE);
  assert.equal(boom.calls.filter((c) => c.body.method === 'tools/call').length, 1,
    'HTTP 侧的 tools/call 同样永不重试');
});

test('MC-19b 服务端协商了别的 protocolVersion ⇒ 接受并记日志，不重试（§1）', async () => {
  const logs = [];
  const { impl } = fakeFetch([
    ({ body }) => jsonResponse({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05' } }),
    okNotify(), listResult(),
  ]);
  const client = createMcpClient({
    server: httpServer, resolved: { values: {} }, fetchImpl: impl,
    log: (level, msg) => logs.push(`${level}:${msg}`),
  });
  await client.listTools();
  assert.ok(logs.some((l) => l.includes('different protocolVersion')), `必须留痕：${logs.join('|')}`);
  assert.equal(logs.filter((l) => l.includes('protocolVersion')).length, 1);
});

// ---------------------------------------------------------------------------
// ⑤ pool（§6.2）
// ---------------------------------------------------------------------------

test('MC-20 pool：懒启动、directTools 只给 direct、closeAll 幂等覆盖没连过的 client', async () => {
  const spawned = [];
  const srv = fakeStdioSpawn();
  const pool = createMcpPool({
    servers: [
      { ...stdioServer, name: 'a', resolved: { values: {} } },
      {
        ...stdioServer, name: 'b', exposure: 'direct',
        tools: [{ name: 't1', description: 'D', inputSchema: { type: 'object' } }],
        resolved: { values: {} },
      },
    ],
    spawnImpl: (...args) => { spawned.push(args[0]); return srv.spawnImpl(...args); },
    onProcess: () => {},
  });
  assert.deepEqual(spawned, [], 'run 启动不得拉起任何 server（形态① = 懒启，§13）');
  assert.equal(pool.get('a').tools.length, 0);
  assert.deepEqual(pool.directTools().map((d) => `${d.server}.${d.tool}`), ['b.t1'],
    'deferred 的工具不得出现在 direct 展开里（否则 §4.3 的旋钮又是死配置）');
  await pool.get('b').listTools();
  assert.deepEqual(pool.list().map((s) => s.name), ['a', 'b']);
  assert.equal(pool.get('nope'), null);
  await pool.closeAll();
  await pool.closeAll();
  assert.equal(pool.get('a').status().state, 'closed', 'closeAll 必须覆盖**没连过**的 client（幂等）');
});

test('MC-21 pool 透传 missing（缺槽 server 不注册，但 `list` 要能解释为什么少一个）', () => {
  const pool = createMcpPool({ servers: [], missing: [{ name: 'github', slots: ['GITHUB_TOKEN'] }] });
  assert.deepEqual(pool.missing, [{ name: 'github', slots: ['GITHUB_TOKEN'] }]);
  assert.deepEqual(pool.list(), []);
});

test('MC-22 组合矩阵的传输侧（§4.2）：http 只把 header 槽变头，env 槽不变成头', () => {
  assert.equal(buildHttpHeaders({ server: httpServer, values: { AUTHORIZATION: 'v' } }).authorization, 'v');
  assert.deepEqual(buildHttpHeaders({
    server: { slots: [{ name: 'X_API_KEY', inject: 'header' }, { name: 'PLAIN', inject: 'env' }] },
    values: { X_API_KEY: 'k', PLAIN: 'p' },
  }), { 'x-api-key': 'k' }, 'env 槽在 http 传输里不得变成头');
});

test('MC-24【反向】发现到的工具必须进外部可见视图（原地改，不重新赋值）', async () => {
  const srv = fakeStdioSpawn();
  const client = createMcpClient({ server: stdioServer, spawnImpl: srv.spawnImpl });
  assert.equal(client.tools.length, 0, '创建时没有工具（懒启动）');
  const list = await client.listTools();
  assert.ok(list.length > 0, '服务端给了工具');
  assert.equal(client.tools.length, list.length,
    '`tools` 属性停在旧数组 ⇒ pool.list() 永远报「工具 0 个」、`call` 报 mcp_tool_unknown（真机症状）');
  assert.deepEqual(client.tools.map((t) => t.name), list.map((t) => t.name));
  assert.equal(client.status().toolsCached, true);
  await client.close();
});

test('MC-25 pool.registerTools 之后 pool.list() 与 status 都反映新工具', async () => {
  const srv = fakeStdioSpawn();
  const pool = createMcpPool({
    servers: [{ ...stdioServer, exposure: 'deferred' }], spawnImpl: srv.spawnImpl,
  });
  const c = pool.get(stdioServer.name);
  const list = await c.listTools();
  assert.equal(pool.list()[0].toolCount, list.length);
  assert.equal(pool.registerTools(stdioServer.name, []), true);
  assert.equal(pool.list()[0].toolCount, 0, 'registerTools 必须能清空（缓存回填是覆盖语义）');
  await pool.closeAll();
});
