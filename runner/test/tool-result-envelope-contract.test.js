// erix-agent 0.20.0 工具事实信封（上游 #284 / #285，host-upgrade-guide-0.20.0 §2/§3/§6/§7）。
//
// 两半：
//  A. **随包契约套件 `toolResultEnvelopeContract`**（0.20.0 新增，`test/contract/index.js:12` 导出、
//     在发布 `files` 白名单里）——station 的装配层自己转交 `tool_result`（`runner/worker.js`
//     的 `executeTool` 把引擎 options 改写成 registry 位置参数 + 转交 abort signal），
//     所以必须跟着跑一遍（接法与 portal/test/engine-api-contract.test.js、
//     runner/test/file-tools-contract.test.js 同款：把**我们的**入口命名空间交给套件）。
//     ⚠ 套件里 21 条断言全部通过 ⇒ 我们没有把信封形状改坏；如果上游改形状，这里先红。
//  B. station 自己的面：
//     ① **防回装**（#283 的临时闸已撤）：引擎自己写 `erix.durationMs`，宿主不得再包一层计时；
//     ② 顶层退役名单里的名字**不得再出现**在我们产出的块上；
//     ③ `loopEventPayload` 的 `duration_ms` 读点：`erix.durationMs` 优先、**顶层 `duration` 只作
//        旧记录的一代回退**、两者都没有 ⇒ `null`（不是 0）；
//     ④ 普通结果块上 `executionStatus` **缺席**（guide §7），我们的读法不得依赖「字段在不在」。
//
// 隔离约定：桩 provider + 内存 store + 真 `runToolLoop`，零 LLM / DB / 容器 / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop, createMemoryTranscriptStore, TOOL_RESULT_CONTRACT } from 'erix-agent';
import { toolResultEnvelopeContract } from 'erix-agent/contract-tests';

import { loopEventPayload } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// A. 随包契约套件（原样转交我们的引擎入口）
// ---------------------------------------------------------------------------
toolResultEnvelopeContract('station-runner', async () => import('erix-agent'));

// ---------------------------------------------------------------------------
// 最小 run 现场（与 replay-policy.test.js 同款技法：桩 provider + 内存 store + 真 runToolLoop）
// ---------------------------------------------------------------------------
function stubProvider() {
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

/** 跑一次「一个工具调用」的 run，交回 LoopEvent 的 tool_result 块与落盘记录里的块。 */
async function runOneToolCall(executeTool) {
  const provider = stubProvider();
  const store = createMemoryTranscriptStore();
  const events = [];
  await runToolLoop({
    provider,
    initialUserMessage: 'noop please',
    completion: false,
    executeTool,
    store,
    runId: 'envelope-run',
    onEvent: (event) => { if (event?.type === 'tool_result') events.push(event); },
  });
  assert.equal(events.length, 1, '桩 run 必须恰好产生一次 tool_result 事件');
  const rounds = await store.load('envelope-run');
  const persisted = rounds
    .flatMap((round) => (round.messages ?? []).flatMap((message) => (Array.isArray(message.content) ? message.content : [])))
    .find((block) => block?.type === 'tool_result');
  return { block: events[0].toolResult, persisted };
}

// ---------------------------------------------------------------------------
// B① 防回装：引擎自己写时长，宿主不得再包一层
// ---------------------------------------------------------------------------

test('防回装：真引擎对四种返回形态都写 erix.durationMs（宿主不再包计时），且块上没有任何退役顶层键', async () => {
  const SHAPES = [
    ['string', 'plain text'],
    ['number（writeFile 字节数）', 5],
    ['number 0（空文件 = 成功）', 0],
    ['{content,metadata}（searchText）', { content: 'hits', metadata: { a: 1 } }],
    ['裸对象', { a: 1 }],
    ['null', null],
  ];
  for (const [label, value] of SHAPES) {
    const { block, persisted } = await runOneToolCall(async () => value);
    assert.ok(Number.isFinite(block.erix?.durationMs),
      `${label}：erix-agent 0.20.0 必须自己写 erix.durationMs。红在这里 = 上游把 #285 收回去了，`
      + '那时才需要重装宿主侧计时闸（#283 的临时闸），并同步改本文件');
    assert.ok(Number.isFinite(persisted?.erix?.durationMs), `${label}：落盘侧也必须带时长（事件与盘上一致）`);
    // 退役名单（TOOL_RESULT_CONTRACT.legacy.aliases 的键）一个都不许回到顶层
    for (const retired of Object.keys(TOOL_RESULT_CONTRACT.legacy.aliases)) {
      if (retired.includes('@')) continue;
      assert.ok(!Object.hasOwn(block, retired), `${label}：退役顶层键 ${retired} 又出现了`);
      assert.ok(!Object.hasOwn(persisted, retired), `${label}：落盘块上退役顶层键 ${retired} 又出现了`);
    }
    assert.equal(block.erix?.success, true, `${label}：erix.success 必须恒定存在且为 true`);
  }
});

test('防回装（源码级）：worker.js 不再包 wrapToolResultForDuration，也不自己起计时器', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  // 只禁**调用/导入**（注释里允许提到这个名字——撤闸的理由就得写在撤闸的地方）
  assert.doesNotMatch(src, /wrapToolResultForDuration\s*\(|import[^\n]*wrapToolResultForDuration/,
    '#283 的临时计时闸已因上游 #285 撤除：装配层再包一层 = 与引擎的 erix.durationMs 争单一真相');
  assert.doesNotMatch(src, /from '\.\/lib\/tool-duration\.js'/,
    'lib/tool-duration.js 已删除，不得再被引回');
  assert.ok(!fs.existsSync(path.join(RUNNER_DIR, 'lib', 'tool-duration.js')),
    'lib/tool-duration.js 必须保持删除状态（引擎自己写 erix.durationMs）');
  const start = src.indexOf('const executeTool = async (options) =>');
  assert.notEqual(start, -1, 'worker.js 必须仍有 executeTool 包装（note_* 路由 + abort signal 转交）');
  const body = src.slice(start, src.indexOf('\n  };', start));
  assert.doesNotMatch(body, /Date\.now\(|performance\.now\(|setTimeout\(/,
    '装配层不得自己起计时器：时长的单一真相是引擎（#283 → #299 撤闸）');
  // issue #211 的 signal 转交不能被撤闸顺手删掉
  assert.match(body, /signal:\s*options\.signal/, 'abort signal 必须仍然转交（issue #211）');
});

test('抛异常/返回 Error：引擎给的是真实观测（不是把未知塌成 0），正文与成败位不被宿主篡改', async () => {
  const thrown = await runOneToolCall(async () => { throw new Error('thrown boom'); });
  assert.equal(thrown.block.content, 'thrown boom');
  assert.equal(thrown.block.is_error, true, '抛异常仍是失败（引擎 catch，worker 不自己 catch）');
  assert.equal(thrown.block.erix?.success, false);

  const errored = await runOneToolCall(async () => new Error('returned boom'));
  assert.equal(errored.block.content, 'returned boom', '返回 Error：content 取 message');
  assert.equal(errored.block.is_error, true);
  assert.equal(errored.block.erix?.success, false);
});

// ---------------------------------------------------------------------------
// B③ loopEventPayload 的 duration_ms 读点（新记录 / 旧记录回退 / 两者都缺）
// ---------------------------------------------------------------------------

test('loopEventPayload：erix.durationMs 优先，且两值并存时以引擎命名空间为准', () => {
  const payload = loopEventPayload({
    type: 'tool_result',
    round: 3,
    toolResult: { type: 'tool_result', tool_use_id: 'c1', content: 'ok', erix: { durationMs: 1234 }, duration: 99 },
  });
  assert.equal(payload.duration_ms, 1234,
    '两拼法同时存在时必须读 erix.*（guide §3：别读顶层来看引擎怎么想）');
  assert.equal(payload.tool_call_id, 'c1');
  assert.equal(payload.ok, true);
});

test('loopEventPayload：旧记录回退——只有顶层 duration 时仍要拿得到时长（盘上有 740+ 条这种行）', () => {
  const legacy = loopEventPayload({
    type: 'tool_result',
    round: 1,
    // 0.19 及更早落盘的真实形状：erix 里没有 durationMs，时长只在顶层
    toolResult: { type: 'tool_result', tool_use_id: 'old-1', content: 'x', erixRound: 1, duration: 777, success: true },
  });
  assert.equal(legacy.duration_ms, 777,
    '删掉 `?? tr.duration` 回退就会红在这里：老记录会退化成「没有时长」');
});

test('loopEventPayload：两者都缺 ⇒ null（禁止写 0），is_error 仍决定 ok', () => {
  const missing = loopEventPayload({
    type: 'tool_result',
    round: 1,
    toolResult: { type: 'tool_result', tool_use_id: 'c2', content: 'x', erix: { round: 1, success: true } },
  });
  assert.equal(missing.duration_ms, null, '缺失 = 不知道（guide §2：写 ?? 0 会把未知渲染成瞬间完成）');
  assert.notEqual(missing.duration_ms, 0);

  const aborted = loopEventPayload({
    type: 'tool_result',
    round: 2,
    // judge 拦截 / 未 settle 即中止：引擎**不写** durationMs（三种无值状态之一）
    toolResult: { type: 'tool_result', tool_use_id: 'c3', content: 'blocked', is_error: true, erix: { executionStatus: 'intercepted', success: false } },
  });
  assert.equal(aborted.duration_ms, null);
  assert.equal(aborted.ok, false);
});

// ---------------------------------------------------------------------------
// B④ executionStatus 只在特殊状态存在（guide §7）
// ---------------------------------------------------------------------------

test('普通成功块上 erix.executionStatus 缺席（不是空串、不是 ok 占位）；特殊状态才给值', async () => {
  const { block } = await runOneToolCall(async () => 'plain text');
  assert.equal(Object.hasOwn(block.erix, 'executionStatus'), false,
    '常量说 writtenFor="special states only"，普通块上必须是**缺席**');
  assert.equal(block.erix.executionStatus, undefined);
  assert.deepEqual(TOOL_RESULT_CONTRACT.engine.fields.executionStatus.presentValues,
    ['intercepted', 'interrupted']);

  // 我们的 payload 映射不得因为「字段不在」就报错或造出异常值
  const payload = loopEventPayload({ type: 'tool_result', round: 1, toolResult: block });
  assert.equal(payload.ok, true, '普通块不能因为 executionStatus 缺席就被判成异常');
  assert.equal(payload.result_digest, 'plain text');

  // 反向：真特殊状态（值比对，不看存在性）
  const special = loopEventPayload({
    type: 'tool_result', round: 1,
    toolResult: { type: 'tool_result', tool_use_id: 'c9', content: 'x', is_error: true, erix: { executionStatus: 'interrupted' } },
  });
  assert.equal(special.ok, false);
});
