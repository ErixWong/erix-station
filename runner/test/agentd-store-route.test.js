// agentd store_request 路由单测（issue #81 P2）：session 维度端点映射 + markRunState 双路拆分。
// 注入 request 桩捕获 (method, path, opts)，不断言 portal 行为（portal 侧有独立单测），
// 只锁 agentd 的接线契约：store 方法走 /transcript/:key（?run_id= writer fencing）、
// markRunState('running') 走 U2 真 runId、状态写入走 status 通道、键一致性自检、
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

test('appendRound/load/run-state/snapshot 方法走 session 端点（键 + writer run_id 透传）', async () => {
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

  await handleStoreRequest(ctx, 'saveRunSnapshot', { runId: 'sess-1', revision: 2, snapshot: { round: 1 } }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/checkpoint?run_id=run-1');
  assert.deepEqual(calls.at(-1).opts.body, { revision: 2, snapshot: { round: 1 } });

  await handleStoreRequest(ctx, 'loadLatestRunSnapshot', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/checkpoint/latest?run_id=run-1');

  await handleStoreRequest(ctx, 'loadRunStateStatus', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate/status?run_id=run-1');

  assert.equal(calls.length, 7);
});

test("markRunState 双路拆分：'running' → U2 真 runId；终态标记 → session status 通道", async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();

  await handleStoreRequest(ctx, 'markRunState', { runId: 'sess-1', state: 'running' }, { request });
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).p, '/runs/run-1/state', "'running' 必须真 runId（runs 表生命周期）");
  assert.deepEqual(calls.at(-1).opts.body, { state: 'running' });

  await handleStoreRequest(ctx, 'markRunState', { runId: 'sess-1', state: 'succeeded' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate?run_id=run-1', '状态标记走 session status 通道');
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
  await assert.rejects(
    () => handleStoreRequest(ctx, 'loadRunStateStatus', { runId: 'run-1' }, { request }),
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

  await handleStoreRequest(ctx, 'saveRunSnapshot', { runId: 'run-1', revision: 1, snapshot: {} }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/checkpoint');

  await handleStoreRequest(ctx, 'loadLatestRunSnapshot', { runId: 'run-1' }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/checkpoint/latest');

  await handleStoreRequest(ctx, 'loadRunStateStatus', { runId: 'run-1' }, { request });
  assert.equal(calls.at(-1).p, '/runs/run-1/runstate/status');
});

// ---------------------------------------------------------------------------
// issue #338 P3：`load` 的分页循环必须真的按 portal 给的**不透明游标**翻页。
//
// 缺陷背景：session 游标从「单个 round 号」换成 `(round, append_seq)` 真 keyset（0.23 账本一轮
// 多行）。agentd 侧两个致命点：① 回传时必须原样字符串 + `encodeURIComponent`（`Number('1:1070')`
// = NaN ⇒ 第二页从「从头」重读 ⇒ 死循环）；② 循环不能只取一页（否则丢页）。
// 本用例的两页**故意让 page1 末行与 page2 首行同 round 不同 append_seq**——这正是旧游标
// `round > cursor` 丢行的现场。
// ---------------------------------------------------------------------------

test('#338 P3：load 按不透明游标翻页拉全量（两页同 round 不同 append_seq，不丢行）', async () => {
  const pages = [
    {
      records: [{ round: 1, dedupKey: 'k:msg:1:0' }, { round: 1, dedupKey: 'k:msg:1:1' }],
      next_cursor: '1:1071',
    },
    {
      records: [
        { round: 1, dedupKey: 'k:msg:1:2' },
        { round: 1, dedupKey: 'k:engine:round:1' },
        { round: 2, dedupKey: 'k:msg:2:0' },
      ],
      next_cursor: '2:1074',
    },
    { records: [{ round: 2, dedupKey: 'k:engine:round:2' }], next_cursor: null },
  ];
  const calls = [];
  const request = async (method, p, opts = {}) => {
    calls.push({ method, p, opts });
    return { data: pages[calls.length - 1] ?? { records: [], next_cursor: null } };
  };
  const ctx = makeCtx();

  const out = await handleStoreRequest(ctx, 'load', { runId: 'sess-1' }, { request });

  assert.deepEqual(out.records.map((r) => [r.round, r.dedupKey]), [
    [1, 'k:msg:1:0'],
    [1, 'k:msg:1:1'],
    [1, 'k:msg:1:2'],
    [1, 'k:engine:round:1'],
    [2, 'k:msg:2:0'],
    [2, 'k:engine:round:2'],
  ], '分页并集 = 全量（有序，不丢页）');

  assert.equal(calls.length, 3, '三页 ⇒ 三次请求（含末页 0 行的收尾请求）');
  assert.equal(calls[0].p, '/transcript/sess-1?limit=10000&run_id=run-1', '首页不带 cursor');
  assert.equal(calls[1].p, '/transcript/sess-1?limit=10000&cursor=1%3A1071&run_id=run-1',
    '第二页 URL 必须带首页的 next_cursor，且 `:` 要 encodeURIComponent（%3A）');
  assert.equal(calls[2].p, '/transcript/sess-1?limit=10000&cursor=2%3A1074&run_id=run-1',
    '第三页带第二页的 next_cursor');
  // 不透明串原样透传：绝不 Number()（NaN ⇒ 第二页从头重读 ⇒ 死循环）。
  assert.ok(!/cursor=NaN/.test(calls.map((c) => c.p).join(' ')), '游标不得被 Number() 化成 NaN');
});

test('#338 P3b：单页即到底时不发多余请求（pages=1 不触发分页路径）', async () => {
  const calls = [];
  const request = async (method, p, opts = {}) => {
    calls.push({ method, p, opts });
    return { data: { records: [{ round: 0, dedupKey: 'k:input:m1' }], next_cursor: null } };
  };
  const out = await handleStoreRequest(makeCtx(), 'load', { runId: 'sess-1' }, { request });
  assert.equal(calls.length, 1, '单页到底 ⇒ 一次请求');
  assert.deepEqual(out.records.map((r) => r.dedupKey), ['k:input:m1']);
});
