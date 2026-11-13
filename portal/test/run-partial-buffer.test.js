// issue #502 D-4：`run-partial-buffer.js` 的单测（纯内存，零依赖，docs/testing.md §2.1）。
//
// 这个模块是「delta 不落库之后，断线重连还能不能把那段未完稿正文补回来」的**唯一**内存来源，
// 所以四条口径各自有具名用例：
//   ① 档位判据来自引擎 `eventTierOf`（本站不手抄三个串）
//   ② 快照语义 = 「当前这段未完稿正文」，**跨轮累加不按轮切段**（前端只有一个 `deltaText` 气泡）
//   ③ `uptoSeq` = 该 run **已落库**事件的最大 seq（只增不减；碎片事件不参与）
//   ④ 内存有界：单 run 正文夹到 `textCap`、run 数夹到 `maxEntries`（LRU 逐出）
import test from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_TIERS, EVENT_TIER_STREAM } from 'erix-agent';

import {
  createPartialBuffer,
  isStreamTierType,
  partialOutputs,
  PARTIAL_TEXT_CAP_DEFAULT,
} from '../src/run-partial-buffer.js';

const ev = (n, type, payload, extra = {}) => ({
  client_event_id: `r1:1:${n}`, type, payload, session_id: 's1', ...extra,
});

test('D-4①：碎片名单来自引擎分级表（stream 档逐键一致，事实档一类都不认）', () => {
  const streamKeys = Object.keys(EVENT_TIERS).filter((k) => EVENT_TIERS[k] === EVENT_TIER_STREAM);
  assert.ok(streamKeys.includes('assistant_delta') && streamKeys.includes('reasoning_delta')
    && streamKeys.includes('tool_call_delta'), '引擎里这三类必须是 stream 档（否则本单的判据要重写）');
  for (const k of streamKeys) assert.equal(isStreamTierType(k), true);
  for (const t of ['tool_use', 'tool_result', 'round_start', 'round_end', 'usage', 'judge']) {
    assert.equal(isStreamTierType(t), false, `${t} 是事实档，不得被当碎片`);
  }
  assert.equal(isStreamTierType('unknown_new_event'), false, '引擎不认识 ⇒ 不许当碎片（宁留不丢）');
});

test('D-4②：正文/推理分别累加；跨轮不切段（快照 = 当前这段未完稿正文）', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'round_start', { round: 1 }, { seq: 1 }));
  b.observe('r1', ev(1, 'assistant_delta', { text: '第一段' }));
  b.observe('r1', ev(2, 'round_end', { round: 1 }, { seq: 2 }));
  b.observe('r1', ev(3, 'round_start', { round: 2 }, { seq: 3 }));
  b.observe('r1', ev(4, 'assistant_delta', { text: '第二段' }));
  b.observe('r1', ev(5, 'reasoning_delta', { text: '在想' }));
  const s = b.snapshot('r1');
  // 不按轮切段：与界面一致（前端 `deltaText` 在 round_start 被置 null，界面上从来只有一段）
  assert.equal(s.text, '第一段第二段', '跨轮必须累加成一段');
  assert.equal(s.reasoning, '在想', '推理单独一路，不混进正文');
  assert.equal(s.chunks, 3, '正文 2 片 + 推理 1 片');
  assert.equal(s.truncated, false);
});

test('D-4②：tool_call_delta 是工具入参，不进正文（成型副本在 tool_use.input）', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'tool_call_delta', { tool_call_id: 'c1', arguments_delta: '{"cmd":"ls"' }));
  const s = b.snapshot('r1');
  assert.ok(s, '碎片事件仍进缓冲（它证明这个 run 正在流式）');
  assert.equal(s.text, '', '入参碎片不得混进正文');
});

test('D-4③：uptoSeq = 已落库事件的最大 seq，只增不减；碎片事件不推进它', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'a' }));
  assert.equal(b.snapshot('r1').uptoSeq, null, '还没有任何落库事件 ⇒ null（补发侧据此判「无法证明客户端已看到」）');
  b.observe('r1', ev(1, 'tool_use', {}, { seq: 7 }));
  assert.equal(b.snapshot('r1').uptoSeq, 7);
  b.observe('r1', ev(2, 'assistant_delta', { text: 'b' }));
  assert.equal(b.snapshot('r1').uptoSeq, 7, '碎片不改水位线');
  b.observe('r1', ev(3, 'round_end', {}, { seq: 4 }));
  assert.equal(b.snapshot('r1').uptoSeq, 7, '乱序/更小的 seq 不得把水位线拉回去');
  b.observe('r1', ev(4, 'round_end', {}, { seq: 9 }));
  assert.equal(b.snapshot('r1').uptoSeq, 9);
  b.observe('r1', ev(5, 'usage', {}, {}));
  assert.equal(b.snapshot('r1').uptoSeq, 9, 'durable 事件没带 seq ⇒ 什么也不改');
});

test('D-4④：单 run 正文夹到 textCap，truncated 如实报告；推理同样有界', () => {
  const b = createPartialBuffer({ textCap: 10 });
  b.observe('r1', ev(0, 'assistant_delta', { text: '0123456789' }));
  assert.equal(b.snapshot('r1').text, '0123456789');
  assert.equal(b.snapshot('r1').truncated, false, '刚好等于上限 ⇒ 还没丢东西');
  b.observe('r1', ev(1, 'assistant_delta', { text: 'AB' }));
  assert.equal(b.snapshot('r1').text, '0123456789', '上限之后不再长');
  assert.equal(b.snapshot('r1').truncated, true, '上限之后仍到帐 ⇒ 必须报 truncated');
  assert.equal(b.snapshot('r1').chunks, 2, 'chunks 数的是**收到过**的片数（可观测性）');
  // 默认上限与读侧 `PARTIAL_OUTPUT_TEXT_CAP` 同口径（两处不等 = 刷新前后长度不一样）
  assert.equal(PARTIAL_TEXT_CAP_DEFAULT, 2000, '默认上限必须仍是 2000（与 http.js 同口径）');
  const big = createPartialBuffer();
  big.observe('r2', ev(0, 'assistant_delta', { text: 'x'.repeat(5000) }));
  assert.equal(big.snapshot('r2').text.length, 2000);
  assert.equal(big.snapshot('r2').truncated, true);
});

test('D-4④：LRU 上界（构造参数可注入），观测刷新位置，逐出的是最久未观测的那个', () => {
  const b = createPartialBuffer({ maxEntries: 3 });
  b.observe('a', ev(0, 'assistant_delta', { text: 'A' }));
  b.observe('b', ev(0, 'assistant_delta', { text: 'B' }));
  b.observe('c', ev(0, 'assistant_delta', { text: 'C' }));
  b.observe('a', ev(1, 'assistant_delta', { text: 'A2' })); // 刷新 a 的位置
  b.observe('d', ev(0, 'assistant_delta', { text: 'D' }));
  assert.equal(b.size(), 3, '上界是硬的');
  assert.equal(b.snapshot('b'), null, 'b 是最久未观测 ⇒ 被逐出');
  assert.equal(b.snapshot('a').text, 'AA2', 'a 刚被观测过 ⇒ 留着');
  assert.equal(b.snapshot('c').text, 'C');
  assert.equal(b.snapshot('d').text, 'D');
});

test('D-4：drop / clear / sessionRuns 与快照副本语义', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'x' }));
  b.observe('r2', ev(0, 'assistant_delta', { text: 'y' }, { session_id: 's2' }));
  assert.deepEqual(b.sessionRuns('s1'), ['r1'], '按会话取候选（补发侧用）');
  assert.deepEqual(b.sessionRuns('nope'), []);

  const snap = b.snapshot('r1');
  snap.text = '改'; // 调用方改写不得污染缓冲
  assert.equal(b.snapshot('r1').text, 'x', 'snapshot 返回副本');
  assert.equal(b.snapshot('nope'), null, '没有该 run ⇒ null（不是空对象）');

  assert.equal(b.drop('r1'), true);
  assert.equal(b.drop('r1'), false, '再删一次如实报 false');
  assert.equal(b.snapshot('r1'), null);
  assert.equal(b.clear(), 1, 'clear 返回清掉的条数');
  assert.equal(b.size(), 0);
});

test('D-4：at-least-once 重投不重复累加（同一 attempt 内计数的高水位判重投）', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'AB' }));
  b.observe('r1', ev(1, 'assistant_delta', { text: 'CD' }));
  // 整批重放（agentd 可重试路径把批次放回队首再发一遍）
  b.observe('r1', ev(0, 'assistant_delta', { text: 'AB' }));
  b.observe('r1', ev(1, 'assistant_delta', { text: 'CD' }));
  assert.equal(b.snapshot('r1').text, 'ABCD', '正文只拼一遍');
  assert.equal(b.snapshot('r1').chunks, 2, '被识别为重投的碎片不计数');
  // 不同 attempt 的计数从 0 重新开始 ⇒ 不得被当重投（`runner/worker.js:193` 按 attempt 编号）
  b.observe('r1', { client_event_id: 'r1:2:0', type: 'assistant_delta', payload: { text: 'E' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text, 'ABCDE', '新 attempt 不是重投');
  // 不是那个形状（合成事件 / 手工上报）⇒ 不当判据，宁重不漏
  b.observe('r1', { client_event_id: 'r1:final:run_end', type: 'assistant_delta', payload: { text: 'F' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text, 'ABCDEF');
});

test('D-4：脏输入一律不进缓冲（不拿脏值冒充正文）', () => {
  const b = createPartialBuffer();
  assert.equal(b.observe('', ev(0, 'assistant_delta', { text: 'x' })), false, '空 runId');
  assert.equal(b.observe('r1', null), false, '没有事件');
  assert.equal(b.observe('r1', { type: 'usage', payload: {} }), false, 'durable 且无 seq ⇒ 不进');
  b.observe('r1', ev(0, 'assistant_delta', { text: 42 }));
  b.observe('r1', ev(1, 'assistant_delta', { text: null }));
  b.observe('r1', ev(2, 'assistant_delta', undefined));
  const s = b.snapshot('r1');
  assert.equal(s.text, '', '数字/null/缺键都不许变成正文（String() 会写出 "42" 那种脏东西）');
  assert.equal(s.chunks, 0);
});

test('D-4：单例导出可用（写入侧与补发侧共用一份）', () => {
  partialOutputs.clear();
  partialOutputs.observe('rr', { client_event_id: 'rr:1:0', type: 'assistant_delta', payload: { text: 'hi' }, session_id: 'ss' });
  assert.equal(partialOutputs.snapshot('rr').text, 'hi');
  partialOutputs.clear();
  assert.equal(partialOutputs.snapshot('rr'), null);
});
