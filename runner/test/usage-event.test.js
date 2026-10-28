// issue #387：`usage` 事件的**展示面**（此前被 onEvent 整条丢弃 ⇒ 界面上永远看不到 token 数）。
//
// 口径钉子（三条，逐条对应一种会静默发生的回归）：
//   ① 引擎给的 `round` + `usage` 原样透出，**不拍平**（docs/api/portal.md §5.3 第 5 行：宿主若拍平成
//      顶层 input_tokens/output_tokens 属宿主侧改写，必须显式注明——本站不改写）；
//   ② `context_window` 是**宿主侧 additive 字段**，来源是 RUN_START 下行的模型元数据（与喂给引擎
//      `modelMetadata.contextWindowTokens` 同一个数，#309）。**没配/脏值 ⇒ 整个键不写**：
//      前端据此整段不出，而不是画一个「0 / 0%」的假进度条（#283/#299「绝不伪装成 0」同口径）；
//   ③ 放行 usage 只放开**展示**，记账面一字未动（`onUsage` 仍是空实现、终态只吃 U2 载荷）。
//      这条在本文件的 ③ 与 system-prompt.test.js 各钉一次：前者钉 payload 形状，后者钉接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loopEventPayload } from '../worker.js';

test('#387 ①：引擎的 usage 形状原样透出（round + 嵌套 usage，不拍平、不补键）', () => {
  const payload = loopEventPayload({
    type: 'usage', round: 12, usage: { input_tokens: 116_204, output_tokens: 5_560 },
  });
  assert.deepEqual(payload, { round: 12, usage: { input_tokens: 116_204, output_tokens: 5_560 } });
  assert.equal(payload.input_tokens, undefined, '不得把 usage 拍平到顶层');
});

test('#387 ②：context_window 只在**正整数**时出现；缺字段 / 脏值 / ≤0 一律不写键', () => {
  const event = { type: 'usage', round: 1, usage: { input_tokens: 10, output_tokens: 2 } };

  assert.equal(loopEventPayload(event, { contextWindow: 262_144 }).context_window, 262_144);

  for (const bad of [undefined, null, 0, -1, Number.NaN, '262144', 1.5]) {
    const payload = loopEventPayload(event, { contextWindow: bad });
    assert.equal(Object.hasOwn(payload, 'context_window'), false,
      `contextWindow=${String(bad)} 属于「没有窗口」，必须整键缺席（写进去就是伪装成有）`);
  }
  // 不传第二个入参（旧调用形状）也必须照旧可用
  assert.equal(Object.hasOwn(loopEventPayload(event), 'context_window'), false);
});

test('#387 ③：非 usage 事件的 payload 形状不受影响（本单只动 usage 一个 case）', () => {
  assert.deepEqual(loopEventPayload({ type: 'round_start', round: 3 }, { contextWindow: 128_000 }), { round: 3 });
  assert.deepEqual(loopEventPayload({ type: 'tool_result', toolResult: { tool_use_id: 'c1', erix: { durationMs: 25 } } }),
    { tool_call_id: 'c1', round: undefined, name: null, result_digest: '', duration_ms: 25, ok: true });
});
