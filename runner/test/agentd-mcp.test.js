// runner/test/agentd-mcp.test.js —— agentd 的 MCP 代理与进程组回收（issue #608 §11「runner」段）。
// 钉三件事：
//   ① `MCP_CONFIG_REQUEST` 真的**用 agentd 自己的 token** 发 `GET /api/internal/mcp/servers`
//      （假 fetch 看请求头）；值不落日志（§10.3 的 canary 口径）。
//   ② 取配置失败 ⇒ 回 `{ok:false}` 并**不打死 run**（不杀 worker、不置 dropped、不抛）。
//   ③ `MCP_PROCESS` 登记后，watchdog 那条终止路径必须补杀该 pgid（**反向：不登记就不杀**），
//      且顺序仍是「先 worker 组、再子进程组」（#288 的顺序红线不得回退）。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ERIX_STATION_TOKEN = 'container-token-CANARY';
process.env.ERIX_STATION_BASE_URL = 'https://station.test/api/internal';

const {
  makeRunCtx, sweepWatchdog, killChildGroups, applyMcpProcess,
  mcpConfigResponse, mcpToolsCacheAck, testInternalRequest, InternalError,
} = await import('../agentd.js');
import { MSG } from '../lib/ipc.js';

const RUN_ID = 'a0000000-0000-4000-8000-000000000608';

function fakeWorker() {
  const sent = [];
  return { sent, connected: true, send: (m) => { sent.push(m); return true; } };
}

/** 假 fetch：按脚本回 `{status, body}`，并把每次请求记下来（URL / 方法 / 头 / body）。 */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body });
    const step = script[calls.length - 1] ?? script.at(-1);
    const status = step?.status ?? 200;
    const body = step?.body ?? {};
    return { status, text: async () => JSON.stringify(body) };
  };
  return { impl, calls };
}

function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return (async () => {
    try {
      return await fn();
    } finally {
      globalThis.fetch = saved;
    }
  })();
}

function makeCtx({ mcpPgids = [], shellPgids = [], workerPid = 41001, lastIpcAt = 0 } = {}) {
  return {
    runId: RUN_ID,
    workerPid,
    worker: fakeWorker(),
    lastIpcAt,
    dropped: false,
    finishing: false,
    shellPgids: new Set(shellPgids),
    mcpPgids: new Set(mcpPgids),
  };
}

function killSpy() {
  const calls = [];
  return { calls, kill: (pid, sig) => { calls.push([pid, sig]); } };
}

// ---------------------------------------------------------------------------
// ① 配置代理（§6.1）
// ---------------------------------------------------------------------------

test('AM-1 MCP_CONFIG_REQUEST 用 agentd 自己的 token 打 /api/internal/mcp/servers，值不落日志', async () => {
  const logs = [];
  const f = fakeFetch([{ body: { servers: [{ name: 'github', values: { GITHUB_TOKEN: 'ghp_SECRET' } }], missing: [{ name: 'x', slots: ['K'] }] } }]);
  const ctx = makeCtx();
  const out = await withFetch(f.impl, () => mcpConfigResponse(
    ctx, { req_id: 7, run_id: RUN_ID },
    { request: testInternalRequest, logImpl: (lvl, msg, extra) => logs.push(`${lvl}:${msg}:${JSON.stringify(extra ?? {})}`) },
  ));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, 'https://station.test/api/internal/mcp/servers');
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].headers.Authorization, 'Bearer container-token-CANARY',
    'worker 没有 token（buildWorkerEnv 删了它）⇒ 这一头只能由 agentd 戴');
  assert.equal(out.ok, true);
  assert.deepEqual(out.servers, [{ name: 'github', values: { GITHUB_TOKEN: 'ghp_SECRET' } }]);
  assert.deepEqual(out.missing, [{ name: 'x', slots: ['K'] }]);
  assert.deepEqual(ctx.worker.sent, [{
    type: MSG.MCP_CONFIG_RESPONSE, req_id: 7, ok: true,
    servers: [{ name: 'github', values: { GITHUB_TOKEN: 'ghp_SECRET' } }],
    missing: [{ name: 'x', slots: ['K'] }],
  }], '值只走 IPC 内存：回包里有，日志里没有');
  assert.ok(logs.every((l) => !l.includes('ghp_SECRET')), `槽值进日志了（§10.3）：${logs.join('|')}`);
  assert.ok(logs.some((l) => l.includes('mcp config proxied')), '必须留一条记账');
});

test('AM-2 取配置失败 ⇒ ok:false、run 不被打死（不杀 worker、不置 dropped）', async () => {
  const logs = [];
  const f = fakeFetch([{ status: 503, body: { error: { code: 'mcp_pool_unavailable', message: 'no key' } } }]);
  const ctx = makeCtx({ workerPid: 42001, lastIpcAt: 5 });
  const out = await withFetch(f.impl, () => mcpConfigResponse(
    ctx, { req_id: 8 },
    { request: testInternalRequest, logImpl: (lvl, msg, extra) => logs.push(`${lvl}:${msg}:${JSON.stringify(extra ?? {})}`) },
  ));
  assert.equal(out.ok, false);
  assert.match(out.error, /mcp_pool_unavailable/);
  assert.equal(ctx.dropped, false, 'portal 503 与 run 的生死无关（§6.1「不打死 run」）');
  assert.equal(ctx.worker.sent[0].type, MSG.MCP_CONFIG_RESPONSE);
  assert.equal(ctx.worker.sent[0].ok, false);
  assert.ok(logs.some((l) => l.startsWith('warn:mcp config proxy failed')), '降级必须留痕');
});

test('AM-3 lease_lost 才算租约丢失；网络错误只是降级（两种 5xx/409 语义不得混）', async () => {
  const lostCtx = makeCtx();
  await withFetch(fakeFetch([{ status: 409, body: { error: { code: 'lease_lost', message: 'stolen' } } }]).impl,
    () => mcpConfigResponse(lostCtx, { req_id: 9 }, { request: testInternalRequest, logImpl: () => {} }));
  assert.equal(lostCtx.dropped, true);

  const netCtx = makeCtx();
  await withFetch(async () => { throw new Error('ECONNREFUSED'); },
    () => mcpConfigResponse(netCtx, { req_id: 10 }, { request: testInternalRequest, logImpl: () => {} }));
  assert.equal(netCtx.dropped, false);
  assert.match(netCtx.worker.sent[0].error, /network_error/);
});

test('AM-4 元数据回填：POST /api/internal/mcp/tools-cache；失败只记日志（§6.6）', async () => {
  const f = fakeFetch([{ body: { ok: true } }]);
  const ctx = makeCtx();
  const r = await withFetch(f.impl, () => mcpToolsCacheAck(
    ctx, { slug: 'github', tools: [{ name: 'create_issue', description: 'd' }] },
    { request: testInternalRequest, logImpl: () => {} },
  ));
  assert.equal(r, 'sent');
  assert.equal(f.calls[0].url, 'https://station.test/api/internal/mcp/tools-cache');
  assert.deepEqual(JSON.parse(f.calls[0].body), { slug: 'github', tools: [{ name: 'create_issue', description: 'd' }] });

  const boom = fakeFetch([{ status: 500, body: {} }]);
  const logs = [];
  const r2 = await withFetch(boom.impl, () => mcpToolsCacheAck(
    makeCtx(), { slug: 'github', tools: [{ name: 't' }] },
    { request: testInternalRequest, logImpl: (lvl, msg) => logs.push(`${lvl}:${msg}`) },
  ));
  assert.equal(r2, 'sent', '回填失败不许冒泡成 run 的错');
  assert.ok(logs.includes('warn:mcp tools cache backfill failed (ignored)'));
  assert.equal(await mcpToolsCacheAck(makeCtx(), { slug: '', tools: [] }, { request: testInternalRequest, logImpl: () => {} }),
    'ignored', '空回填不发请求（省一次 500）');
});

// ---------------------------------------------------------------------------
// ② 进程组账本（§6.8）
// ---------------------------------------------------------------------------

test('AM-5 MCP_PROCESS 登记后 watchdog 必须补杀该 pgid；【反向】不登记就不杀', () => {
  const spy = killSpy();
  const ctx = makeCtx({ workerPid: 6001, mcpPgids: [], lastIpcAt: 0 });
  assert.equal(applyMcpProcess(ctx, { phase: 'spawn', pgid: 6100, name: 'github' }), 'spawn');
  assert.equal(applyMcpProcess(ctx, { phase: 'spawn', pgid: 6101, name: 'hub' }), 'spawn');
  assert.deepEqual([...ctx.mcpPgids], [6100, 6101]);
  // 记账会顺手刷活动戳（这是它的正确行为），所以这里手动把戳归零才能走到 watchdog 分支。
  ctx.lastIpcAt = 0;
  sweepWatchdog({
    runs: [ctx], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill,
    refreshActivity: () => {}, logImpl: () => {},
  });
  assert.deepEqual(spy.calls, [[-6001, 'SIGKILL'], [-6100, 'SIGKILL'], [-6101, 'SIGKILL']],
    `顺序必须是「先 worker 组、再 MCP 组」：${JSON.stringify(spy.calls)}`);
  assert.equal(ctx.mcpPgids.size, 0, '登记集必须随 attempt 结束清空');

  // 反向：没有任何登记 ⇒ 只杀 worker 组（不得凭空闲杀 -0 组）
  const spy2 = killSpy();
  const bare = makeCtx({ workerPid: 6002, lastIpcAt: 0 });
  sweepWatchdog({
    runs: [bare], now: 10_000_000, watchdogMs: 300_000, kill: spy2.kill,
    refreshActivity: () => {}, logImpl: () => {},
  });
  assert.deepEqual(spy2.calls, [[-6002, 'SIGKILL']], '不登记就不杀');
});

test('AM-6 exit 相销登记；pgid 不合法 ⇒ ignored；两本账互不串门', () => {
  const ctx = makeCtx({ mcpPgids: [7000], shellPgids: [7100] });
  assert.equal(applyMcpProcess(ctx, { phase: 'exit', pgid: 7000 }), 'exit');
  assert.deepEqual([...ctx.mcpPgids], []);
  assert.deepEqual([...ctx.shellPgids], [7100], 'shell 的账不能被 MCP 消息动掉');
  assert.equal(applyMcpProcess(ctx, { phase: 'spawn', pgid: 0 }), 'ignored');
  assert.equal(applyMcpProcess(ctx, { phase: 'spawn' }), 'ignored');
  assert.equal(applyMcpProcess(ctx, { phase: 'heartbeat', pgid: 7001 }), 'ignored',
    '心跳是 SHELL_LIVENESS 的相，不该进这本账');
  assert.equal(typeof ctx.lastIpcAt, 'number', '记账顺手刷活动戳（与 shell 侧同口径）');
});

test('AM-7 killChildGroups 一次消费两本账且幂等；ESRCH 不阻断终止流程', () => {
  const spy = killSpy();
  const ctx = makeCtx({ workerPid: 8001, shellPgids: [8100], mcpPgids: [8200, 8201] });
  const first = killChildGroups(ctx, { kill: spy.kill, logImpl: () => {} });
  assert.deepEqual(first, { shell: [8100], mcp: [8200, 8201] });
  assert.deepEqual(spy.calls, [[-8100, 'SIGKILL'], [-8200, 'SIGKILL'], [-8201, 'SIGKILL']]);
  assert.deepEqual(killChildGroups(ctx, { kill: spy.kill, logImpl: () => {} }), { shell: [], mcp: [] },
    '同一次终止会走多条路径，登记集只能被消费一次');

  const logs = [];
  const esrch = makeCtx({ mcpPgids: [9000] });
  const killed = killChildGroups(esrch, {
    kill: () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); },
    logImpl: (lvl, msg) => logs.push(`${lvl}:${msg}`),
  });
  assert.deepEqual(killed.mcp, [], '杀不到就是已经自然退出（竞态），不算终止失败');
  assert.ok(logs.some((l) => l.startsWith('warn:mcp child group kill failed')));
});

test('AM-8 makeRunCtx 默认带 mcpPgids 账本（新 ctx 漏字段 = 终止路径静默不杀）', () => {
  const ctx = makeRunCtx(RUN_ID);
  assert.ok(ctx.mcpPgids instanceof Set);
  assert.equal(ctx.mcpPgids.size, 0);
  assert.ok(ctx.shellPgids instanceof Set, '#288 那本账不得被合并掉');
});
