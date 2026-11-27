// agentd store_request 路由单测（issue #81 P2）：session 维度端点映射 + markRunState 双路拆分。
// 注入 request 桩捕获 (method, path, opts)，不断言 portal 行为（portal 侧有独立单测），
// 只锁 agentd 的接线契约：store 方法走 /transcript/:key（?run_id= writer fencing）、
// markRunState('running') 走 U2 真 runId、状态写入走 status 通道、键一致性自检、
// 旧 portal（ctx.sessionId = null）回退 run 作用域旧端点。
// 隔离约定：agentd 经 direct-run 守卫被 import（不启动主循环）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeStore } from '../lib/store.js';
import { foldLedgerRecords } from '../lib/transcript-fold.js';
import { STORE_METHODS } from '../lib/ipc.js';
import {
  RETIRED_STORE_METHODS, LEGACY_STORE_METHODS, declaredStoreMethods,
} from './store-contract-surface.js';

process.env.ERIX_STATION_TOKEN = 'test-token';
const { handleStoreRequest, InternalError } = await import('../agentd.js');

const AGENTD_SRC_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agentd.js');

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

  // ⚠ 旧 `saveRunSnapshot` / `loadLatestRunSnapshot`（session 端点 `/transcript/:key/checkpoint{,/latest}`）
  //   已随 issue #640 整条删除 ⇒ 反向断言在末尾那条用例里（方法不存在 ⇒ 不发请求 + 报 unknown）。

  await handleStoreRequest(ctx, 'loadRunStateStatus', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).p, '/transcript/sess-1/runstate/status?run_id=run-1');

  assert.equal(calls.length, 5);
});

test('快照两面已退役（#640）：saveRunSnapshot / loadLatestRunSnapshot 不得再被转发（0.33.0 引擎不再调）', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();
  for (const method of ['saveRunSnapshot', 'loadLatestRunSnapshot']) {
    await assert.rejects(
      () => handleStoreRequest(ctx, method, { runId: 'sess-1', revision: 1, snapshot: {} }, { request }),
      new RegExp(`unknown store method: ${method}`),
      `${method} 必须当场报 unknown（旧 portal 404 不如 here fail fast）`,
    );
  }
  assert.equal(calls.length, 0, '退役方法不得发出任何 HTTP 请求');
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

// ---------------------------------------------------------------------------
// issue #500：账本恢复行三条路由（只走 session 端点，writer fencing 与其余 S 端点逐字一致）
// ---------------------------------------------------------------------------

const EXECUTED_ROW = {
  round: 3,
  roundKey: 'sess-1:round:3',
  dedupKey: 'sess-1:engine:round:3:recovery:tool-executed:call-7f',
  kind: 'recovery',
  recoveryEvent: 'tool-executed',
  toolUseId: 'call-7f',
  messages: [],
  ts: '2026-11-16T00:00:00.000Z',
};

test('#500 恢复行三方法走 session 端点（PUT/GET/DELETE + ?run_id= + X-Claim-Token）', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();

  await handleStoreRequest(ctx, 'appendRecoveryRow', { runId: 'sess-1', record: EXECUTED_ROW }, { request });
  assert.equal(calls.at(-1).method, 'PUT');
  assert.equal(calls.at(-1).p, '/transcript/sess-1/recovery-rows?run_id=run-1');
  assert.equal(calls.at(-1).opts.claimToken, 'ct-1', 'writer fencing 与其余 session 端点同一套');
  assert.deepEqual(calls.at(-1).opts.body, EXECUTED_ROW, 'record 原样转发（本站不重算 dedupKey、不剥字段）');

  await handleStoreRequest(ctx, 'listRecoveryRows', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).method, 'GET');
  assert.equal(calls.at(-1).p, '/transcript/sess-1/recovery-rows?run_id=run-1');

  await handleStoreRequest(ctx, 'clearRecoveryRows', { runId: 'sess-1' }, { request });
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).p, '/transcript/sess-1/recovery-rows?run_id=run-1');

  assert.equal(calls.length, 3);
});

test('#500 恢复行的键一致性自检：引擎传来的 key ≠ RUN_START sessionId ⇒ 抛错且零请求', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx();
  for (const [method, args] of [
    ['appendRecoveryRow', { runId: 'sess-OTHER', record: EXECUTED_ROW }],
    ['listRecoveryRows', { runId: 'sess-OTHER' }],
    ['clearRecoveryRows', { runId: 'sess-OTHER' }],
  ]) {
    await assert.rejects(() => handleStoreRequest(ctx, method, args, { request }),
      /transcript key mismatch/, method);
  }
  assert.equal(calls.length, 0, '自检失败不得发出任何请求（防串会话）');
});

test('#500 没有 run 作用域回退面：旧 portal（ctx.sessionId=null）下三方法一律抛错', async () => {
  const { calls, request } = makeStub();
  const ctx = makeCtx({ sessionId: null });
  // 与其余方法的「旧 portal 回退 run 端点」**故意不同**：transcript_recovery_rows 只有一个键列，
  // 没有 run 作用域这一格 ⇒ 编一个 `/runs/:id/recovery-rows` 就是发一个注定 404 的请求。
  for (const [method, args] of [
    ['appendRecoveryRow', { runId: 'run-1', record: EXECUTED_ROW }],
    ['listRecoveryRows', { runId: 'run-1' }],
    ['clearRecoveryRows', { runId: 'run-1' }],
  ]) {
    await assert.rejects(() => handleStoreRequest(ctx, method, args, { request }),
      /require a session transcript key/, method);
  }
  assert.equal(calls.length, 0, '没发请求（抛错在发请求之前）');
});

test('#500 红线：读/清两个方法不许无限重试（portal 持续 5xx ⇒ 有限次后把错误原样抛给引擎）', async () => {
  // 缺陷形状（issue #500 红线 2）：`withRetry` 缺省 `maxRetries = Infinity`，而 5xx 在 agentd 里
  // 被标 `retryable` ⇒ portal 一直挂时这条请求**永远重试**，引擎收不到 reject ⇒
  // `recovery_rows_unreadable` / `recovery_rows_clear` 那两个终局根本不会发生
  //（现场从「run 以明确原因失败」变成「resume 无声卡死 + 每 30s 一条 retry 日志」）。
  // 错误必须是**真的** `InternalError`：判据是 `instanceof && retryable`，长得像不算（否则假绿）。
  for (const method of ['listRecoveryRows', 'clearRecoveryRows']) {
    const seen = [];
    const request = async (m, p, opts = {}) => {
      seen.push({ m, p, opts });
      throw new InternalError(503, 'http_503', 'portal down', true);
    };
    await assert.rejects(
      () => handleStoreRequest(makeCtx(), method, { runId: 'sess-1' }, { request }),
      /portal down/, `${method}：portal 持续不可用时必须把错误抛出去（不许吞成空结果）`,
    );
    assert.ok(seen.length >= 2, `${method}：至少重试一次（一次抖一下就放弃太脆）`);
    assert.ok(seen.length <= 6, `${method}：重试必须**有限**（实得 ${seen.length} 次 = 又在走无限退避）`);
    assert.ok(seen.every((c) => c.p === '/transcript/sess-1/recovery-rows?run_id=run-1'),
      `${method}：重试打的是同一个端点，没有偷偷换路径`);
  }
});

test('#500 写方法（appendRecoveryRow）仍与其余账本写同口径：可重试错误交给上层退避', async () => {
  // 本站**不给**写侧单独设有限重试：引擎 `persistClassified` 那一层已经有 retryAttempts + 退避，
  // 并在耗尽时给出 `phase: transcript` 的终局。中间再加一层就是两层各重试一轮 ⇒ 排障时看不出谁在等。
  let calls = 0;
  const request = async (m, p, opts = {}) => {
    calls += 1;
    if (calls === 1) throw new InternalError(502, 'http_502', 'flaky', true);
    return { data: { added: true } };
  };
  const out = await handleStoreRequest(makeCtx(), 'appendRecoveryRow',
    { runId: 'sess-1', record: EXECUTED_ROW }, { request });
  assert.deepEqual(out, { added: true }, '一次抖动后重试成功，调用方无感');
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------
// issue #501：`loadRawRows` 在 **agentd** 这一层必须有 case。
//
// 病（主 agent 验收 #501 时逐行验出来）：`runner/lib/store.js` 已实现这根探针、
// `runner/lib/ipc.js:85` 的 `STORE_METHODS` 已放行，但 agentd 的 store switch 里没有这一支
// ⇒ 落到 switch 末尾的 `default: throw new Error('unknown store method: …')`（现 :771）
// ⇒ **生产里每次预写都抛**（引擎每次 MISS 都调它：`append-user-turn.js:310-313`），
//    而「探针缺席」只是软降级 `ledger_probe_absent` ⇒ 抛比缺席更糟。
// 三条判据分别堵：① 路由本身（与 `load` 同端点同分页、返回未折叠行）；② 白名单↔路由一致性
// （以后加方法忘了路由 ⇒ 当场红）；③ 声明=实现（引擎 0.33.0 的契约套件按**实现**判，
// 「实现了却没申报」它不判红 ⇒ 本站自己钉；申报在 `./store-contract-surface.js`）。
// ---------------------------------------------------------------------------

const K501 = 'sess-1';
const text501 = (s) => ({ type: 'text', text: s });
/** 轮记录（载体行）：0.23 起只有元数据、`messages` 为空 ⇒ 天生是折叠载体。 */
const carrier501 = (round) => ({
  round, dedupKey: `${K501}:engine:round:${round}`, roundKey: `${K501}:round:${round}`, messages: [],
});
/** 消息行（`kind:'message'` + 轮内 `seq`）：**折叠时会被吸进载体** ⇒ 只出现在未折叠输出里。 */
const msg501 = (round, seq, body) => ({
  round, kind: 'message', seq, dedupKey: `${K501}:msg:${round}:${seq}`, roundKey: `${K501}:round:${round}`,
  messages: [{ role: 'assistant', content: [text501(body)] }],
});
/** 宿主 `appendUserTurn` 预写的 `:input:` 行（有正文但无 `kind`/`seq` ⇒ 不参与折叠）。 */
const input501 = (round, id, body) => ({
  round, dedupKey: `${K501}:input:${id}`, roundKey: `${K501}:input:${id}`,
  messages: [{ role: 'user', content: [text501(body)] }],
});

/** 一份「折叠真的会改变输出」的原始账本（4 行 ⇒ 折叠后 2 行）。 */
const RAW_ROWS_501 = [input501(7, 'm1', '用户话'), carrier501(7), msg501(7, 0, '头'), msg501(7, 1, '尾')];

/**
 * 假 portal：把 `rows` 按 `pageSize` 分页回 `{records,next_cursor}`。
 * 桩里的游标是「偏移量字符串」，真 portal 是不透明串 `<round>:<append_seq>`——agentd 两者都只
 * 认「原样回传 + encodeURIComponent」，本桩照样能验翻页与端点/ query 逐字一致。
 */
function makePortalStub(rows, pageSize = 2) {
  const calls = [];
  const request = async (method, p, opts = {}) => {
    calls.push({ method, p, opts });
    const hit = /(?:^|[?&])cursor=([^&]*)/.exec(p);
    const offset = hit ? Number(decodeURIComponent(hit[1])) : 0;
    const page = rows.slice(offset, offset + pageSize);
    return { data: { records: page, next_cursor: offset + pageSize < rows.length ? String(offset + pageSize) : null } };
  };
  return { calls, request };
}

test('#501 判据①：loadRawRows 与 load 同端点同分页 query，返回未折叠原始行（同一条分页读）', async () => {
  const ctx = makeCtx(); // sessionId = sess-1 = K501

  const viaLoad = makePortalStub(RAW_ROWS_501);
  const loaded = await handleStoreRequest(ctx, 'load', { runId: K501 }, { request: viaLoad.request });
  const viaRaw = makePortalStub(RAW_ROWS_501);
  const raw = await handleStoreRequest(ctx, 'loadRawRows', { runId: K501 }, { request: viaRaw.request });

  // ① 路由：两条 method 打的是**同一串 URL**（分页 query 逐字相同），没有第二条读路径。
  assert.deepEqual(viaRaw.calls.map((c) => `${c.method} ${c.p}`), viaLoad.calls.map((c) => `${c.method} ${c.p}`),
    'loadRawRows 必须复用 load 的端点与分页 query');
  assert.deepEqual(viaRaw.calls.map((c) => c.p), [
    '/transcript/sess-1?limit=10000&run_id=run-1',
    '/transcript/sess-1?limit=10000&cursor=2&run_id=run-1',
  ], 'session 端点 + writer fencing（?run_id=）+ 不透明游标翻页（与 load 同一支）');
  assert.ok(viaRaw.calls.every((c) => c.opts.claimToken === 'ct-1'), 'writer fencing 与其余 session 端点同一套');

  // ② 返回的是**折叠前**的原始行：4 行全在（含两条会被吸进载体的 `kind:'message'` 行）。
  assert.deepEqual(raw.records, RAW_ROWS_501, '原始行逐字段原样（agentd 不折叠、不剥字段）');
  assert.ok(raw.records.length === 4 && foldLedgerRecords(RAW_ROWS_501).length === 2,
    '本标本折叠真的会少行 ⇒ 「原样返回」不是空断言');

  // ③ 整条 runner 链（store.js 探针 → IPC → agentd）：上游同源等式 `fold(loadRawRows) ≡ load`，
  //    且引擎 `appendUserTurn` 拿到的 rawRows 比 load 多（多出来的正是折叠吃掉的行）。
  const portal2 = makePortalStub(RAW_ROWS_501);
  const store = makeStore(K501, {
    runId: 'run-1',
    request: (method, args) => handleStoreRequest(ctx, method, args, { request: portal2.request }),
  });
  const chainRaw = await store.loadRawRows(K501);
  const chainFolded = await store.load(K501);
  assert.deepEqual(chainRaw, RAW_ROWS_501, 'store.loadRawRows 拿到的是未折叠原始行');
  assert.deepEqual(foldLedgerRecords(chainRaw), chainFolded, 'foldMessageRows(loadRawRows(r)) 逐字等于 load(r)');
  assert.equal(chainFolded.length, 2, 'store.load 折回载体行（2 行），store.loadRawRows 不折（4 行）');
  assert.ok(chainRaw.length > chainFolded.length, '两根探针的差 = 折叠吃掉的行（不是巧合等长）');
});

test('#501 判据①b：loadRawRows 与 load 共用同一套自检与旧 portal 回退（抽 helper 不等于少一半护栏）', async () => {
  const mismatch = makePortalStub(RAW_ROWS_501);
  await assert.rejects(
    () => handleStoreRequest(makeCtx(), 'loadRawRows', { runId: 'sess-OTHER' }, { request: mismatch.request }),
    /transcript key mismatch/, '键一致性自检必须与 load 同口径（fencing 防串会话）',
  );
  assert.equal(mismatch.calls.length, 0, '自检失败不得发出任何请求');

  const legacy = makePortalStub(RAW_ROWS_501);
  const out = await handleStoreRequest(
    makeCtx({ sessionId: null }), 'loadRawRows', { runId: 'run-1' }, { request: legacy.request },
  );
  assert.deepEqual(legacy.calls.map((c) => c.p), [
    '/runs/run-1/transcript?limit=10000',
    '/runs/run-1/transcript?limit=10000&cursor=2',
  ], '旧 portal（无 session key）回退 run 作用域端点，与 load 一致（分页同样拉齐全量）');
  assert.deepEqual(out.records, RAW_ROWS_501);
});

test('#501 判据②：STORE_METHODS 每一项在 agentd 的 store switch 里都有 case（白名单↔路由一致性闸）', () => {
  // 今天的漏网形状就是「白名单加了、路由忘了」⇒ 本条直接从 agentd 源码抽出 case 名单比对。
  const src = fs.readFileSync(AGENTD_SRC_PATH, 'utf8');
  const start = src.indexOf('async function handleStoreRequest(');
  assert.ok(start >= 0, 'agentd.js 应仍有 handleStoreRequest（白名单↔路由闸的比对对象）');
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start, 'handleStoreRequest 函数体要能定位（本判据只比这一支 switch）');
  const body = src.slice(start, end);
  const caseNames = [...body.matchAll(/^\s*case '([A-Za-z][A-Za-z0-9]*)':/gm)].map((m) => m[1]);
  const caseSet = new Set(caseNames);
  assert.equal(caseNames.length, caseSet.size, '同一个 method 不得有两个 case（switch 到不了第二支）');

  const exempt = new Set([...RETIRED_STORE_METHODS, ...LEGACY_STORE_METHODS]);
  const missing = [...STORE_METHODS].filter((m) => !exempt.has(m) && !caseSet.has(m));
  assert.deepEqual(missing, [],
    `IPC 白名单放行了却没有 agentd case：${missing.join(', ')} ⇒ 请求会落到 default 抛 `
    + 'unknown store method（引擎每次 MISS 都调 loadRawRows ⇒ 抛比缺席更糟）');

  // 反向两面：退役方法不得回流；legacy 两侧都得在（今天 recall 白名单与路由都还留着）。
  for (const retired of RETIRED_STORE_METHODS) {
    assert.equal(caseSet.has(retired), false, `${retired} 已随 #640 退役，agentd 不得再留 case`);
  }
  assert.ok(caseSet.has('recall'), 'legacy recall 的路由还在（白名单也在，见 store-contract.test.js）');
  // 镜像空档：有 case 但白名单没放行 = 死路由（worker 发不出），同样得红。
  const orphans = caseNames.filter((m) => !STORE_METHODS.has(m) && !RETIRED_STORE_METHODS.includes(m));
  assert.deepEqual(orphans, [], 'agentd 里有 case 而 IPC 白名单没放行 = 到不了的路由');
});

test('#501 判据③：store 实际暴露的方法集合 = 契约申报的能力方法集合（逐项相等，多报/少报都红）', () => {
  // 引擎 0.33.0 的契约套件按**实现**判：「实现了却没申报」它静默跳过 ⇒ 本站自己钉这条。
  // 申报面只有一个来源（`./store-contract-surface.js`），`store-contract.test.js` 拿同一份去申报。
  const store = makeStore('decl-501', {
    request: async () => { throw new Error('判据③ 只枚举方法面，不该发出任何请求'); },
  });
  const actual = Object.keys(store).filter((k) => typeof store[k] === 'function').sort();
  const declared = [...declaredStoreMethods()].sort();
  assert.deepEqual(actual, declared,
    'store 方法面与申报面逐项相等：多报（申报了没实现 = 引擎按名探测后落空）与少报（实现了没申报 = '
    + '上游套件静默跳过，删实现无人知）都红');
  for (const retired of RETIRED_STORE_METHODS) {
    assert.equal(store[retired], undefined, `${retired} 已随 #640 退役，adapter 不得再暴露`);
  }
});
