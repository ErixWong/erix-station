// issue #283「工具调用时长恒显 0s」的 runner 侧回归锁。
//
// 三层断言：
//   A. 适配器自身形态（lib/tool-duration.js）：非结构化返回 ⇒ `{ content, metadata: {} }`；
//      引擎契约面形态（自有 content / 自有 data / Error）⇒ **同一个对象**（不二次包装）。
//   B. 真引擎行为（跑真 `runToolLoop` + 桩 provider，零 LLM）：
//      ① 包装前后**模型看到的正文逐字节相同**（比对的两侧都是引擎自己产出的块，不引入本地复刻）；
//      ② 不包 ⇒ `duration === undefined`（钉住引擎 0.18.0 的缺口本身 = 本适配器存在的理由；
//         上游 erix-agent #285 落地并升版后这条会红 = 「可以撤适配器」的信号，见 lib 头注释）；
//      ③ 包了 ⇒ `duration` 是有限非负数（带延时的用例再钉 `>= 延时`）。
//   C. worker.js 的 executeTool 出口真的过适配器（源码级，防「顺手清理包装函数」把回归锁拆了），
//      以及事件 payload 的 `duration_ms` 口径：有时长 ⇒ 有限数，没时长 ⇒ `null`（**不是 0**）。
//
// 隔离约定：桩 provider 在内存里，不打真实 LLM、不碰 DB/容器/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop } from 'erix-agent';
import { wrapToolResultForDuration } from '../lib/tool-duration.js';
import { loopEventPayload } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// 最小 runToolLoop 现场：第 1 轮发一个 tool_use，第 2 轮收尾（形状取自上游
// erix-agent `test/contract/execute-tool.js` 的桩 provider，`completion:false` 关掉收尾守卫）。
// ---------------------------------------------------------------------------
function createStubProvider() {
  const requests = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      return requests.length === 1
        ? { content: [{ type: 'tool_use', id: 'call-1', name: 'noop', input: {} }], stopReason: 'tool_use' }
        : { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
}

/** 模型实际看到的 tool_result 块（第 2 次请求的 messages 里）。 */
function modelVisibleToolResult(request) {
  const blocks = (request?.messages ?? [])
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []));
  return blocks.find((block) => block?.type === 'tool_result');
}

/** 跑一次「一个工具调用」的 run，返回引擎 LoopEvent 的 tool_result 块与模型看到的块。 */
async function runOneToolCall(executeTool) {
  const provider = createStubProvider();
  const toolResultEvents = [];
  await runToolLoop({
    provider,
    initialUserMessage: 'noop please',
    completion: false,
    executeTool,
    onEvent: (event) => {
      if (event?.type === 'tool_result') toolResultEvents.push(event);
    },
  });
  assert.equal(toolResultEvents.length, 1, '桩 run 必须恰好产生一次 tool_result 事件');
  return {
    block: toolResultEvents[0].toolResult,
    modelBlock: modelVisibleToolResult(provider.requests[1]),
  };
}

/** 延时执行器（输出仍过适配器）：让「时长不是 0」这件事有可断言的下界。 */
function delayedExecutor(value, ms = 20) {
  return async () => {
    await new Promise((resolve) => { setTimeout(resolve, ms); });
    return wrapToolResultForDuration(value);
  };
}

// ---------------------------------------------------------------------------
// A. 适配器自身形态
// ---------------------------------------------------------------------------

const UNSTRUCTURED = [
  ['string', 'plain text'],
  ['number', 5],
  ['number 0（falsy 也要包）', 0],
  ['boolean', false],
  ['裸对象', { a: 1 }],
  ['数组', [1, 2]],
  ['null', null],
  ['undefined', undefined],
];

test('issue #283 适配器：非结构化返回一律包成 { content, metadata: {} }（metadata 必须是空对象）', () => {
  for (const [label, value] of UNSTRUCTURED) {
    const wrapped = wrapToolResultForDuration(value);
    assert.ok(wrapped && typeof wrapped === 'object', `${label}：必须返回对象`);
    assert.ok(Object.prototype.hasOwnProperty.call(wrapped, 'content'),
      `${label}：必须带自有 content 键（引擎 :91 的判定条件，缺了就走不写时长的 :111 分支）`);
    assert.equal(wrapped.content, value, `${label}：content 必须是原值（不预序列化、不加工）`);
    assert.deepEqual(wrapped.metadata, {}, `${label}：metadata 必须是空对象——不自己塞 duration，单一真相是引擎`);
  }
});

test('issue #283 适配器：自有 content / 自有 data / Error 一律**原对象透传**（不二次包装）', () => {
  const structured = { content: 'x', metadata: { duration: 4321 } };
  const withData = { data: { x: 1 } };
  const err = new Error('boom');
  assert.equal(wrapToolResultForDuration(structured), structured, '自有 content 键：必须同一个对象');
  assert.equal(wrapToolResultForDuration(withData), withData, '自有 data 键：必须同一个对象');
  assert.equal(wrapToolResultForDuration(err), err,
    'Error 实例必须透传：包了会把 success:false 翻成 true、把 content 从 message 变成 "{}"');
  // 原型链上的 content/data 不算自有键（与引擎 hasOwnProperty 判定同形）
  const protoBacked = Object.create({ content: 'inherited' });
  assert.notEqual(wrapToolResultForDuration(protoBacked), protoBacked,
    'content 只在原型链上时不算结构化形态，仍须包装');
});

// ---------------------------------------------------------------------------
// B. 真引擎行为：包装前后模型看到的正文逐字节相同 + 时长出现
// ---------------------------------------------------------------------------

test('issue #283 回归锁：非结构化返回经适配器后 tool_result 带上有限非负 duration（不包则引擎根本不给）', async () => {
  for (const [label, value] of UNSTRUCTURED) {
    const without = await runOneToolCall(async () => value);
    const withAdapter = await runOneToolCall(async () => wrapToolResultForDuration(value));

    // ① 模型看到的正文逐字节相同（两侧都取引擎自己的产出物比对，不引入本地复刻口径）
    assert.equal(withAdapter.block.content, without.block.content,
      `${label}：LoopEvent 的 tool_result.content 必须逐字节不变`);
    assert.equal(withAdapter.modelBlock?.content, without.modelBlock?.content,
      `${label}：送给模型的 tool_result 块正文必须逐字节不变`);
    assert.equal(withAdapter.modelBlock?.is_error, without.modelBlock?.is_error,
      `${label}：成败位不得被包装篡改`);

    // ② 不包 ⇒ 引擎不给时长（钉住上游缺口本身）
    assert.equal(without.block.duration, undefined,
      `${label}：erix-agent 0.18.0 对非结构化返回不写 duration（:111 分支）。`
      + '本断言变红 = 上游 erix-agent #285 已落地 ⇒ 该删掉 runner/lib/tool-duration.js 与 worker.js 的包装了');

    // ③ 包了 ⇒ 时长出现，且是有限非负数
    assert.ok(Number.isFinite(withAdapter.block.duration) && withAdapter.block.duration >= 0,
      `${label}：包装后 duration 必须是有限非负数，实际=${String(withAdapter.block.duration)}`);
  }
});

test('issue #283：包装不改变正文口径（number 5 → "5"、裸对象 → 缩进 JSON、null → "null"）', async () => {
  const cases = [[5, '5'], [{ a: 1 }, '{\n  "a": 1\n}'], [null, 'null'], [[1, 2], '[\n  1,\n  2\n]']];
  for (const [value, expected] of cases) {
    const { block } = await runOneToolCall(async () => wrapToolResultForDuration(value));
    assert.equal(block.content, expected, `包装后模型看到的正文必须是 ${JSON.stringify(expected)}`);
  }
});

test('issue #283：适配器只开闸不编数——时长是真实耗时（延时 20ms 的执行器 duration >= 15）', async () => {
  const { block } = await runOneToolCall(delayedExecutor('slept', 20));
  assert.ok(Number.isFinite(block.duration), `duration 必须是数字，实际=${String(block.duration)}`);
  assert.ok(block.duration >= 15, `真实耗时下界丢失：期望 >=15，实际=${block.duration}`);
});

test('issue #283：结构化返回原样透传且仍有时长（自有 content 走引擎 :102、自有 data 走 :119）', async () => {
  const structured = await runOneToolCall(async () => ({ content: 'structured', metadata: { duration: 4321 } }));
  assert.ok(Number.isFinite(structured.block.duration) && structured.block.duration >= 0,
    '自有 content 键的返回：引擎 :102 必须写时长');
  assert.ok(structured.block.duration < 4321,
    `metadata.duration 是 executor 自报的谎值，引擎 :102 必须无条件覆盖成真实耗时（实际=${structured.block.duration}）`);
  assert.equal(structured.block.content, 'structured');

  const withData = await runOneToolCall(async () => ({ data: { x: 1 }, isError: false }));
  assert.ok(Number.isFinite(withData.block.duration) && withData.block.duration >= 0,
    '自有 data 键的返回：引擎 :119 必须写时长');
  assert.equal(withData.block.content, '{\n  "x": 1\n}', 'data 通道正文由引擎拆解，宿主不碰');
});

test('issue #283：返回 Error 对象 / 抛异常都不写时长（适配器不篡改语义，前端应显示「没有时长」）', async () => {
  const returned = await runOneToolCall(async () => new Error('tool blew up'));
  const returnedWrapped = await runOneToolCall(async () => wrapToolResultForDuration(new Error('tool blew up')));
  assert.equal(returned.block.content, 'tool blew up', 'Error 返回：content 取 message（引擎 :80-86 分支）');
  assert.equal(returnedWrapped.block.content, returned.block.content, 'Error 透传 ⇒ 正文一字不变');
  assert.equal(returnedWrapped.block.is_error, true, 'Error 透传 ⇒ 成败位仍是失败');
  assert.equal(returned.block.duration, undefined, '返回 Error 对象：引擎不写时长（已知边界，不伪装成 0）');
  assert.equal(returnedWrapped.block.duration, undefined, '经适配器后仍不写时长（Error 走透传分支）');

  const thrown = await runOneToolCall(async () => { throw new Error('thrown boom'); });
  assert.equal(thrown.block.content, 'thrown boom', '抛异常：引擎 catch 兜住（worker 侧不许自己 catch）');
  assert.equal(thrown.block.is_error, true);
  assert.equal(thrown.block.duration, undefined, '抛异常/被中止的调用无时长（已知边界，不伪装成 0）');
});

// ---------------------------------------------------------------------------
// C. worker.js 出口与事件 payload 口径
// ---------------------------------------------------------------------------

/** 抠出 `const executeTool = async (options) => {` 的函数体（与 abort-signal.test.js 同一技法）。 */
function executeToolWrapperBody() {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const start = src.indexOf('const executeTool = async (options) =>');
  assert.notEqual(start, -1, 'worker.js 必须仍有 `const executeTool = async (options) =>` 包装');
  const end = src.indexOf('\n  };', start);
  assert.notEqual(end, -1, 'executeTool 包装函数体收尾没找到');
  return src.slice(start, end);
}

test('issue #283：worker.js executeTool 的**两个**出口都过适配器，且不在 worker 里 catch', () => {
  const body = executeToolWrapperBody();
  const hits = body.match(/wrapToolResultForDuration\(/g) ?? [];
  assert.equal(hits.length, 2,
    'note_* 分支与 registry 分支都必须过 wrapToolResultForDuration（漏一个 = 那半工具面仍然没有时长）');
  assert.doesNotMatch(body, /\bcatch\b/,
    'worker 不得在 executeTool 里 catch：抛异常要走引擎 catch（保持「无时长」语义，不在这里造数）');
});

test('issue #283：tool_result 事件 payload 的 duration_ms——有时长是有限数，没时长是 null（不是 0）', async () => {
  const timed = await runOneToolCall(async () => wrapToolResultForDuration('ok'));
  const payload = loopEventPayload({ type: 'tool_result', round: 1, toolResult: timed.block });
  assert.equal(typeof payload.duration_ms, 'number', '有时长 ⇒ 有限数');
  assert.ok(Number.isFinite(payload.duration_ms) && payload.duration_ms >= 0);
  assert.equal(payload.tool_call_id, 'call-1');

  const untimed = await runOneToolCall(async () => 'plain text'); // 不包 ⇒ 引擎不给 duration
  const missing = loopEventPayload({ type: 'tool_result', round: 1, toolResult: untimed.block });
  assert.equal(missing.duration_ms, null,
    '没有时长 ⇒ null（前端据此不渲染时长）；伪装成 0 就是 issue #283 的「恒显 0s」');
  assert.notEqual(missing.duration_ms, 0);
});
