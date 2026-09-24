// agentd store_request 路由单测（issue #81 P2）：session 维度端点映射 + markRunState 双路拆分。
// 注入 request 桩捕获 (method, path, opts)，不断言 portal 行为（portal 侧有独立单测），
// 只锁 agentd 的接线契约：七方法走 /transcript/:key（?run_id= writer fencing）、
// markRunState('running') 走 U2 真 runId、终态标记走 session runstate、键一致性自检、
// 旧 portal（ctx.sessionId = null）回退 run 作用域旧端点。
// 隔离约定：agentd 经 direct-run 守卫被 import（不启动主循环）。
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.ERIX_STATION_TOKEN = 'test-token';
const { handleStoreRequest } = await import('../agentd.js');

function makeCtx({ sessionId = 'sess-1', runId = 'run-1', claimToken = 'ct-1' } = {}) {
  return { runId, sessionId, claimToken, attempt: 1 };
}

/** 捕获请求的桩 transport。 */
function makeStub() {
  const calls = [];
  const request = async (method, p, opts = {}) => {
    calls.push({ method, p, opts });
    return { data: { ok: true } };
  };
  return { calls, request };
}

test('appendRound/load/saveRunState/loadRunState/checkpoint 走 session 端点（键 + writer run_id 透传）', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();

  await handleStoreRequest(ctx, 'appendRound', { runId: 'sess-1', record: { round: 1, dedupKey: 'k:input:m1', messages: [] } }, { request });
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).p, '/transcript/sess-1/rounds/1?run_id=run-1');
  assert.equal(calls.at(-1).opts.claimToken, 'ct-1');
  assert.equal(calls.at(-1).opts.body.dedupKey, 'k:input:m1', 'RoundRecord 原样转发');

  await handleStoreRequest(ctx, 'load', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).p, '/transcript/sess-1?limit=10000&run_id=run-1');

  await handleStoreRequest(ctx, 'saveRunState', { runId: 'sess-1', runState: { stateVersion: 1 } }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate?run_id=run-1');
  assert.deepEqual(calls.at(-1).opts.body, { run_state: { stateVersion: 1 } });

  await handleStoreRequest(ctx, 'loadRunState', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate?run_id=run-1');

  await handleStoreRequest(ctx, 'saveCheckpoint', { runId: 'sess-1', revision: 2, snapshot: { round: 1 } }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/checkpoint?run_id=run-1');
  assert.deepEqual(calls.at(-1).opts.body, { revision: 2, snapshot: { round: 1 } });

  await handleStoreRequest(ctx, 'loadLatestCheckpoint', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/checkpoint/latest?run_id=run-1');

  assert.equal(calls.length, 6);
});

test("markRunState 双路拆分：'running' → U2 真 runId；终态标记 → session runstate", async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();

  await handleStoreRequest(ctx, 'markRunState', { runId: 'sess-1', state: 'running' }, { request });
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).p, '/runs/run-1/state', "'running' 必须真 runId（runs 表生命周期）");
  assert.deepEqual(calls.at(-1).opts.body, { state: 'running' });

  await handleStoreRequest(ctx, 'markRunState', { runId: 'sess-1', state: 'succeeded' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate?run_id=run-1', '终态标记走 session');
  assert.deepEqual(calls.at(-1).opts.body, { state: 'succeeded' });

  await handleStoreRequest(ctx, 'markRunState', { runId: 'sess-1', state: 'unverified_error' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate?run_id=run-1');
});

test('键一致性自检：worker 传来的引擎 key ≠ RUN_START sessionId → 抛错（fencing 防串会话）', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();
  await assert.rejects(
    () => handleStoreRequest(ctx, 'load', { runId: 'sess-OTHER' }, { request }),
    /transcript key mismatch/,
  );
  await assert.rejects(
    () => handleStoreRequest(ctx, 'saveRunState', { runId: 'run-1', runState: {} }, { request }),
    /transcript key mismatch/,
  );
  assert.equal(calls.length, 0, '自检失败不得发出任何请求');
});

test('旧 portal 回退（ctx.sessionId = null）：全部走 run 作用域旧端点（向后兼容）', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx({ sessionId: null });

  await handleStoreRequest(ctx, 'appendRound', { runId: 'run-1', record: { round: 0, dedupKey: 'd', messages: [] } }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/transcript/rounds/0');

  await handleStoreRequest(ctx, 'load', { runId: 'run-1' }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/transcript?limit=10000');

  await handleStoreRequest(ctx, 'markRunState', { runId: 'run-1', state: 'succeeded' }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/runstate');

  await handleStoreRequest(ctx, 'saveCheckpoint', { runId: 'run-1', revision: 1, snapshot: {} }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/checkpoint');

  await handleStoreRequest(ctx, 'loadLatestCheckpoint', { runId: 'run-1' }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/checkpoint/latest');
});
