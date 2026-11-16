// issue #500：恢复行三方法在 **runner 侧**（`runner/lib/store.js` + `runner/agentd.js`）的判据。
//
// 这个文件只管一件事：**账本里那条执行证据在路上不许被弄丢或说谎**。
// portal 侧的四条判据（幂等 / 冲突 / 清空 / 不进 load）在
// `portal/test/transcript-recovery-rows.test.js`，本文件不重复审那边，只审 runner↔agentd 这一段：
//
//   ① 返回值形状与**语义**：`true`/`false`/数组必须原样透出（`false` 是「幂等跳过」，
//      不是「失败」；把 `false` 吞成 `true` 就是把「没落账」说成「已落账」）。
//   ② 错误透传：agentd 抛出来的错**原样往外抛**——引擎靠它分三类
//      （`transient_persistence` 重试 / `recovery_rows_unreadable` 终局 / 按 `code` 定性）。
//      本层每吞一次或每改一次 code，引擎的分类就少一档。
//   ③ 两条 fail-closed（契约点名的那两条）：
//        · 读方法 **reject** ⇒ 往外抛（⇒ 引擎 `recovery_rows_unreadable`）；
//        · 读方法 **返回非数组** ⇒ 也往外抛（不许翻译成 `[]`）。
//      理由写在契约里：空数组是**唯一**可以静默兜底的回答，因为它的含义是「这条 run 没有恢复行」；
//      把「读坏了」伪装成「没有」，代价是下一次重放把已经发生的副作用再掀一遍。
//   ④ 端到端**文案**：真引擎 + 真 adapter + 真 agentd 路由，崩溃→resume 之后模型收到的那条
//      `tool_result` 必须落在契约允许的两种含义之一（「执行过了但结果没落盘」/「没执行」），
//      不许是第三种（「不知道有没有执行」）。这是本单存在的理由，必须有真机断言。
//
// 三层链（runner→agentd→portal→PG）在**本文件里**断在 agentd 的 `request` 边界：
// 那是一真 HTTP 边界（`portal/src/http.js` 的路由与 `?run_id=` / `X-Claim-Token` 判据
// 由 `agentd-store-route.test.js` 与本文件第 ④ 组共同覆盖），portal↔PG 那一格由真库用例覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeStore } from '../lib/store.js';
import { handleStoreRequest, InternalError } from '../agentd.js';

const KEY = 'sess-500-adapter';

/** 引擎 `buildToolExecutedRecoveryRow` 的产物形状（`src/store/recovery-rows.js`）。 */
const executedRow = (round, toolUseId, ts = '2026-11-16T00:00:00.000Z') => ({
  round,
  roundKey: `${KEY}:round:${round}`,
  dedupKey: `${KEY}:engine:round:${round}:recovery:tool-executed:${toolUseId}`,
  kind: 'recovery',
  recoveryEvent: 'tool-executed',
  toolUseId,
  messages: [],
  ts,
});

/**
 * agentd 那一格的桩：**真** `handleStoreRequest`（路由/键自检/fencing 都是产品代码），
 * 只有最外面的 HTTP 请求函数是假的——它模拟 portal 端点的应答语义。
 * 为什么不用 `makeStore` 直连假应答：那样就绕过了 agentd 的路由，第 ④ 组文案判据里
 * 「`?run_id=` 与 claim token 是否真带上了」就没人看（#748 R1 整场事故就是这一格）。
 */
function wire({ recoveryRows = [], respond = {} } = {}) {
  const calls = [];
  const rows = [...recoveryRows];
  const request = async (method, args = {}) => {
    calls.push({ method, args });
    return handleStoreRequest(
      { runId: 'run-500', sessionId: KEY, claimToken: 'ct-500' },
      method, args,
      { request: async (httpMethod, path, opts = {}) => {
        calls.at(-1).http = { httpMethod, path, opts };
        const override = respond[method];
        if (override) return override({ httpMethod, path, opts, rows });
        if (method === 'appendRecoveryRow') {
          const exists = rows.some((r) => r.dedupKey === opts.body?.dedupKey);
          if (!exists) rows.push(opts.body);
          return { data: { added: !exists } };
        }
        if (method === 'listRecoveryRows') return { data: { rows: [...rows] } };
        if (method === 'clearRecoveryRows') {
          const cleared = rows.length > 0;
          rows.length = 0;
          return { data: { cleared } };
        }
        return { data: {} };
      } },
    );
  };
  return { store: makeStore(KEY, { request, runId: 'run-500' }), calls, rows };
}

// ---------------------------------------------------------------------------
// ① 返回值形状与语义
// ---------------------------------------------------------------------------

test('#500 ① 三个方法的返回值语义原样透出（false 是幂等跳过，不是失败）', async () => {
  const { store, rows } = wire();
  assert.equal(await store.appendRecoveryRow(KEY, executedRow(3, 'call-a')), true, '首写 ⇒ true');
  assert.equal(await store.appendRecoveryRow(KEY, executedRow(3, 'call-a')), false,
    '同 dedupKey 同 payload ⇒ false：这一格被判成 true 就是「把幂等跳过说成新写了一行」');
  assert.equal(rows.length, 1);

  assert.deepEqual(await store.listRecoveryRows(KEY), [executedRow(3, 'call-a')],
    '返回**行本体**（不是包装对象、不是 {rows}）');
  assert.equal(await store.clearRecoveryRows(KEY), true, '删了至少一行 ⇒ true');
  assert.equal(await store.clearRecoveryRows(KEY), false, '本来就没有 ⇒ false');
  assert.deepEqual(await store.listRecoveryRows(KEY), [], '空表 ⇒ 空数组（唯一的静默合法回答）');
});

test('#500 ① 写侧只传 record，不夹带本站自己造的字段', async () => {
  const { store, calls } = wire();
  const row = executedRow(3, 'call-a');
  await store.appendRecoveryRow(KEY, row);
  const http = calls.find((c) => c.method === 'appendRecoveryRow').http;
  assert.deepEqual(http.opts.body, row, 'body 就是引擎那一行（重算 dedupKey / 剥字段都是第二把尺）');
  assert.equal(http.httpMethod, 'PUT');
  assert.equal(http.path, `/transcript/${KEY}/recovery-rows?run_id=run-500`);
  assert.equal(http.opts.claimToken, 'ct-500', 'writer fencing 与其余 session 端点同一套');
});

// ---------------------------------------------------------------------------
// ② 错误透传
// ---------------------------------------------------------------------------

test('#500 ② agentd 的错误原样往外抛（code / retryable 不许被改写或吞掉）', async () => {
  // 真冲突（portal 的 409 recovery_row_conflict ⇒ agentd 里是不可重试的 InternalError）
  const conflict = new InternalError(409, 'recovery_row_conflict', 'dedup conflict', false);
  const { store } = wire({ respond: { appendRecoveryRow: () => { throw conflict; } } });
  await assert.rejects(() => store.appendRecoveryRow(KEY, executedRow(3, 'call-a')), (err) => {
    assert.equal(err, conflict, '同一个错误对象（换一个新 Error 就丢了 code ⇒ 引擎分错类）');
    assert.equal(err.code, 'recovery_row_conflict');
    return true;
  });

  // 404（端点没有 / 权限不通过）同样不许被说成「空表」
  const missing = new InternalError(404, 'not_found', 'no such transcript', false);
  const lister = wire({ respond: { listRecoveryRows: () => { throw missing; } } });
  await assert.rejects(() => lister.store.listRecoveryRows(KEY), (err) => {
    assert.equal(err.code, 'not_found');
    return true;
  });
});

// ---------------------------------------------------------------------------
// ③ 两条 fail-closed
// ---------------------------------------------------------------------------

test('#500 ③ fail-closed A：读方法 reject ⇒ 往外抛（引擎才能给 recovery_rows_unreadable）', async () => {
  // 缺陷形状：本层把 reject 兜成 `[]` ⇒ 引擎认为「这条 run 没有恢复行」⇒
  // 把「已经执行过、只是结果没落盘」的那个副作用再掀一遍。
  const boom = new InternalError(500, 'db_unreachable', 'portal cannot read', false);
  const { store } = wire({ respond: { listRecoveryRows: () => { throw boom; } } });
  await assert.rejects(() => store.listRecoveryRows(KEY), (err) => {
    assert.equal(err, boom);
    return true;
  });
});

test('#500 ③ fail-closed B：读方法返回非数组 ⇒ 也往外抛（不许翻译成空数组）', async () => {
  for (const [label, data] of [
    ['null 应答', null],
    ['{rows:null}', { rows: null }],
    ['{rows:{}}（对象当成数组用）', { rows: {} }],
    ['204/无 body（undefined）', undefined],
  ]) {
    const { store } = wire({ recoveryRows: [executedRow(3, 'call-a')], respond: { listRecoveryRows: () => ({ data }) } });
    await assert.rejects(() => store.listRecoveryRows(KEY), /malformed listRecoveryRows response/,
      `${label}：把它当成「没有恢复行」就是 issue #500 红线 2 的缺陷形状`);
  }
});

test('#500 ③ 写/清两格只在「完全没有应答」时 fail-closed，缺布尔时取保守解释', async () => {
  // 应答是对象但缺 `added`/`cleared` ⇒ 读成 false（「没写成 / 没删动」），
  // 偏保守：不把「可能没落账」说成「已落账」。本站 portal 恒发这两个布尔，这一格只可能是老对端。
  const lenient = wire({ respond: { appendRecoveryRow: () => ({ data: {} }), clearRecoveryRows: () => ({ data: {} }) } });
  assert.equal(await lenient.store.appendRecoveryRow(KEY, executedRow(3, 'call-a')), false);
  assert.equal(await lenient.store.clearRecoveryRows(KEY), false);

  // 应答根本不存在（null）⇒ 抛：那是「做没做都不知道」，不是「没写成」。
  const silent = wire({ respond: { appendRecoveryRow: () => ({ data: null }), clearRecoveryRows: () => ({ data: null }) } });
  await assert.rejects(() => silent.store.appendRecoveryRow(KEY, executedRow(3, 'call-a')),
    /malformed appendRecoveryRow response/);
  await assert.rejects(() => silent.store.clearRecoveryRows(KEY), /malformed clearRecoveryRows response/);
});

// ---------------------------------------------------------------------------
// ④ 端到端文案：崩溃→resume 之后模型看到的那条 tool_result 必须有含义
// ---------------------------------------------------------------------------

/** 真引擎 + 真 adapter + 真 agentd 路由；只有 HTTP 那一格是桩（模拟 portal 端点语义）。 */
function fullWire() {
  const ledger = [];          // transcript_rounds 的 session 半边（引擎轮记录）
  const seen = new Map();
  const recoveryRows = [];    // transcript_recovery_rows（数组序 = append_seq）
  const httpCalls = [];
  const request = async (method, args = {}) => handleStoreRequest(
    { runId: 'run-500', sessionId: KEY, claimToken: 'ct-500' }, method, args,
    { request: async (httpMethod, path, opts = {}) => {
      httpCalls.push({ httpMethod, path });
      if (method === 'appendRound') {
        const record = structuredClone(args.record);
        const dedup = record.dedupKey ?? record.roundKey;
        const body = JSON.stringify(record.messages ?? null);
        if (seen.has(dedup) && seen.get(dedup) !== body) {
          throw new InternalError(409, 'dedup_payload_conflict', `dedup conflict: ${dedup}`, false);
        }
        if (!seen.has(dedup)) ledger.push(record);
        seen.set(dedup, body);
        return { data: { inserted: true } };
      }
      if (method === 'load') return { data: { records: structuredClone(ledger) } };
      if (method === 'markRunState' || method === 'saveRunState') return { data: {} };
      if (method === 'loadRunState') return { data: null };
      if (method === 'appendRecoveryRow') {
        const exists = recoveryRows.some((r) => r.dedupKey === opts.body?.dedupKey);
        if (!exists) recoveryRows.push(structuredClone(opts.body));
        return { data: { added: !exists } };
      }
      if (method === 'listRecoveryRows') return { data: { rows: structuredClone(recoveryRows) } };
      if (method === 'clearRecoveryRows') {
        const cleared = recoveryRows.length > 0;
        recoveryRows.length = 0;
        return { data: { cleared } };
      }
      return { data: {} };
    } },
  );
  return { store: makeStore(KEY, { request, runId: 'run-500' }), ledger, recoveryRows, httpCalls };
}

/** 把「挂起的 shell」推到 resume：返回送给模型的那条 tool_result。 */
async function resumeAndReadToolResult({ store, tools, toolCallId }) {
  const { runToolLoop } = await import('erix-agent');
  const providerReqs = [];
  const res = await runToolLoop({
    provider: { async chat(req) { providerReqs.push(req); return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }; } },
    tools, store,
    config: { run: { runId: KEY, resume: true, maxRounds: 6, completion: false, replayPolicy: 'per-tool-declaration' } },
    executeTool: async () => 'executor must not be called for a ledger-known call',
  }).catch((error) => ({ error }));
  if (res?.error) throw res.error;
  const blocks = (providerReqs[0]?.messages ?? []).flatMap((m) => (Array.isArray(m?.content) ? m.content : []));
  const toolResult = blocks.find((b) => b?.type === 'tool_result' && b.tool_use_id === toolCallId);
  return { toolResult, finalText: res?.finalText, httpCalls: undefined };
}

/**
 * ④-A 的文案，留给 ④-B 断言「给了证据之后文案必须**换**」。
 * 两条用例共用同一份挂起现场，唯一差别就是账本里那条 `tool-executed`，所以判据必须跨用例比。
 */
let NO_EVIDENCE_TEXT = '';

test('#500 ④ 真机文案（无执行证据）：引擎明说「没有证据」，且不伪装成「没执行」', async () => {
  const { runToolLoop } = await import('erix-agent');
  const { createShellTools } = await import('../lib/shell-tools.js');
  const shell = createShellTools({ worktreeRoot: process.cwd() }).schemas[0];
  const { store, recoveryRows } = fullWire();

  // 崩溃现场：唯一的 shell 调用死在 executeTool 里面 ⇒ 引擎一条 tool-executed 都没写成。
  const abort = new AbortController();
  await runToolLoop({
    provider: { async chat() { return { content: [{ type: 'tool_use', id: 'call-crash', name: 'shell', input: { command: 'sleep 240' } }], stopReason: 'tool_use' }; } },
    tools: [shell], store,
    executeTool: async () => { abort.abort(); return 'outcome never recorded'; },
    signal: abort.signal,
    config: { input: { initialUserMessage: 'go' }, run: { runId: KEY, maxRounds: 6, completion: false, replayPolicy: 'per-tool-declaration' } },
  }).catch(() => {});
  assert.deepEqual(recoveryRows, [], '前提自证：这条现场确实没有执行证据（否则文案判据测的是另一格）');

  const { toolResult } = await resumeAndReadToolResult({ store, tools: [shell], toolCallId: 'call-crash' });
  assert.ok(toolResult, 'resume 必须把缺失的结果补成一条 tool_result（悬空 tool_use 会让下一趟请求 400）');
  const text = typeof toolResult.content === 'string' ? toolResult.content
    : (toolResult.content ?? []).map((b) => b?.text ?? '').join('');
  // 引擎在这一格**故意**说「没有证据」而不是「没执行」（`pending-tool-result.js` 的无证据支路：
  // 「Do not read that as the call having not run」）。#500 要消灭的不是这句，而是
  // **明明有证据却被丢掉**还套这句。所以判据是两条：① 这一格必须仍是「无证据」支路（本站不撒谎），
  // ② 下一跳用例里给了证据之后文案必须**换**（证据真的进了判定 = 通道活着）。
  assert.match(text, /holds no evidence either way about whether it ran/,
    `账本里确实没有执行证据 ⇒ 引擎应说「没有证据」，实得：${text.slice(0, 200)}`);
  assert.match(text, /Do not read that as the call having not run/,
    '无证据支路不许伪装成「没执行」（那是另一种撒谎）');
  assert.equal(toolResult.is_error, true, '这条是错误结果（模型据此知道这一步没成）');
  NO_EVIDENCE_TEXT = text;
});

test('#500 ④ 真机文案（有执行证据）：账本里躺着 tool-executed ⇒ 文案说「执行过了，结果没落盘」', async () => {
  const { runToolLoop } = await import('erix-agent');
  const { createShellTools } = await import('../lib/shell-tools.js');
  const shell = createShellTools({ worktreeRoot: process.cwd() }).schemas[0];
  const { store, recoveryRows, ledger } = fullWire();

  // 同一种挂起形状，但账本里**有**该调用的 `tool-executed` 行（= 执行器返回过、结果行没写成）。
  // 直接用引擎的 builder 造那一行（本站不自己拼 dedupKey）。
  const { buildToolExecutedRecoveryRow } = await import(
    new URL('../../node_modules/erix-agent/src/store/recovery-rows.js', import.meta.url)
  );
  await store.appendRecoveryRow(KEY, buildToolExecutedRecoveryRow({ runId: KEY, round: 1, toolUseId: 'call-crash' }));
  await store.appendRound(KEY, {
    round: 1, dedupKey: `${KEY}:msg:1:0`, kind: 'message', seq: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '我去跑个长命令' }, { type: 'tool_use', id: 'call-crash', name: 'shell', input: { command: 'sleep 240' } }] }],
  });
  assert.equal(recoveryRows.length, 1, '前提自证：执行证据确实进了账本');
  assert.ok(ledger.length >= 1);

  const { toolResult } = await resumeAndReadToolResult({ store, tools: [shell], toolCallId: 'call-crash' });
  const text = typeof toolResult.content === 'string' ? toolResult.content
    : (toolResult.content ?? []).map((b) => b?.text ?? '').join('');
  assert.match(text, /the call was made, but its tool_result was never persisted/,
    `账本里有 tool-executed ⇒ 文案必须是「执行过了但结果没落盘」这一种含义，实得：${text.slice(0, 200)}`);
  assert.equal(toolResult.is_error, true);
  // ★ #500 的牙（本文件真正要钉的那一格）：同一份挂起现场，唯一差别就是账本里多了一条
  // `tool-executed` ⇒ 文案必须**换**。不换 = 恢复行读回来没进判定 = 通道是假接线
  //（「方法在而什么都不存」的镜像形状：方法在、行也在，但读侧没人用它）。
  assert.ok(NO_EVIDENCE_TEXT && text !== NO_EVIDENCE_TEXT,
    '有证据与无证据两条文案逐字相同 ⇒ 恢复行根本没参与判定（本单接线是假的）');
  assert.doesNotMatch(text, /holds no evidence either way/,
    '有正向证据时不许仍说「没有证据」——那等于把唯一的执行证据又丢了一次');
});
