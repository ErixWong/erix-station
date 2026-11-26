// issue #816 第①步：`record.foldedFacts` 的结构化键以**嵌套键 `folded.facts`** 透传进会话 DTO（纯加法）。
//
// 手法照搬 `portal/test/session-view-fold.test.js` 的 #440 系列（**不另造第二套投影**）：真跑一次
// `runToolLoop` + `fold-llm` 得到真折叠载体行，再**逐例覆写**那条真行的 `foldedFacts`（= 有意的单点变异，
// 因为 0.33.0 的引擎不会给出 #897 那几个键，全键在场只能手工喂），喂 `projectSessionMessages`，读 DTO 里
// `assistant.folded.facts`。判据钉的是 `session-view.js#foldedFactsFields` 的**加法**：新增 `facts` 嵌套键、
// 每个子键「取不到就不写」、非对象 ⇒ 整个 `facts` 不出现，同时既有三键 `summaryText`/`summarySource`/
// `truncated` 与 `hasSummary` 一字不动。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from 'erix-agent';

import { projectSessionMessages } from '../src/session-view.js';
import { assertCompactContext } from '../../runner/lib/compact-knobs.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const USER_MSG = '30000000-0000-4000-8000-000000000001';
const ASSISTANT_MSG = '40000000-0000-4000-8000-000000000001';

const at = (second) => new Date(Date.UTC(2026, 9, 21, 0, 0, second));
const text = (value) => [{ type: 'text', text: value }];

/** 生产 store 桩：只记账，不折叠（与 `runner/lib/ipc.js` 的 `appendRound` 转发同语义）。 */
function makeStore(records) {
  return {
    async appendRound(key, record) { (records[key] ??= []).push(record); },
    async load(key) { return [...(records[key] ?? [])]; },
    async saveRunSnapshot() {},
    async loadLatestRunSnapshot() { return undefined; },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
  };
}

/** 造 n 轮真形态历史（user → tool_use → tool_result），文本足够长以便真折得动。 */
function foldHistory(n) {
  const messages = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'user', content: text(`第 ${i} 轮任务 ${'u'.repeat(500)}`) });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `h-t${i}`, name: 'noop', input: { round: i } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `h-t${i}`, content: `第 ${i} 轮结果 ${'r'.repeat(700)}` }] });
  }
  return messages;
}

/** 真跑一次 `fold-llm`，返回引擎经 `appendRound` 落下的原始行 + 那条折叠载体行（= 生产 `record`）。 */
async function runRealFoldLedger(strategyName, summary = '【LLM 摘要】已折走早期轮次，细节去 transcript 查。') {
  const records = {};
  const main = [];
  const provider = {
    async chat(request) {
      if (typeof request?.system === 'string' && request.system.includes('对话历史压缩器')) {
        return { content: text(summary), stopReason: 'end_turn' };
      }
      main.push(request);
      return main.length <= 2
        ? { content: [{ type: 'tool_use', id: `c${main.length}`, name: 'noop', input: {} }], stopReason: 'tool_use' }
        : { content: text('收尾'), stopReason: 'end_turn' };
    },
  };
  await runToolLoop({
    provider,
    store: makeStore(records),
    executeTool: async () => 'ok',
    config: {
      input: { messages: foldHistory(14), initialUserMessage: '继续收尾' },
      run: { runId: SESSION_ID, maxRounds: 6, completion: false },
      folding: { context: assertCompactContext({ strategy: strategyName, keepRounds: 6 }) },
      metadata: { task: 't', modelMetadata: { contextWindowTokens: 6000, maxOutputTokens: 200 } },
      tuning: { maxTokens: 200 },
    },
  });
  const rows = records[SESSION_ID] ?? [];
  const foldRow = rows.find((row) => row.folded === true);
  assert.ok(foldRow, `${strategyName} 前置：这一跑必须真的折过一次（否则下面的 DTO 断言全是空断言）`);
  return { rows, foldRow };
}

/** 宿主 `appendUserTurn` 写的那条 `:input:` 行（投影靠它按 messageId 精确认领用户输入）。 */
function inputRow() {
  const dedupKey = `${SESSION_ID}:input:${USER_MSG}`;
  return {
    run_id: null,
    round: 0,
    dedup_key: dedupKey,
    created_at: at(0),
    record: {
      round: 0,
      dedupKey,
      roundKey: dedupKey,
      messages: [{ role: 'user', content: text('读文件') }],
    },
  };
}

/** 引擎原始 record → `transcript_rounds` 行（列形状与生产 SELECT 逐列一致）。 */
function toTranscriptRows(records) {
  let tick = 1;
  return records.map((record) => ({
    run_id: null,
    round: record.round ?? 0,
    dedup_key: record.dedupKey ?? null,
    record,
    created_at: at(tick++),
  }));
}

const ANCHORS = [
  { id: USER_MSG, run_id: RUN_ID, seq: 1, role: 'user', synthetic: false, content: '', attachments: [], created_at: at(1) },
  { id: ASSISTANT_MSG, run_id: RUN_ID, seq: 2, role: 'assistant', synthetic: false, content: '', attachments: [], created_at: at(2) },
];
const USER_ANCHORS = [{
  id: USER_MSG, run_id: RUN_ID, seq: 1, synthetic: false, anchor_text: '读文件', created_at: at(1),
}];

function project(transcriptRows) {
  return projectSessionMessages({
    sessionId: SESSION_ID, anchors: ANCHORS, userAnchors: USER_ANCHORS, transcriptRows,
  });
}

// 整轮只跑一次真账本（`project` 对入参是纯函数，逐例只换 `foldedFacts`）。
let basePromise = null;
function base() {
  basePromise ??= runRealFoldLedger('fold-llm');
  return basePromise;
}

const ABSENT = Symbol('foldedFacts-absent');

/** 把真折叠行的 `foldedFacts` 覆写成 `factsValue`（`ABSENT` ⇒ 摘掉这个键），投影后返回 `assistant.folded`。 */
async function foldedWith(factsValue) {
  const { rows, foldRow } = await base();
  const mapped = rows.map((row) => {
    if (row !== foldRow) return row;
    if (factsValue === ABSENT) {
      const { foldedFacts, ...rest } = row;
      return rest;
    }
    return { ...row, foldedFacts: factsValue };
  });
  const dto = project([inputRow(), ...toTranscriptRows(mapped)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.ok(folded, '前置：折叠行必须仍然产出 DTO 的 `folded`（本单不动 #189 的四项判据）');
  return folded;
}

// ── 用例 1：全键在场 ⇒ `folded.facts` 逐字相等（含 toolCalls 顺序） ──────────────────────────
test('#816-1 全键在场 ⇒ folded.facts 逐字相等（title/summary/origin/区间/rounds/toolCalls，含顺序）', async () => {
  const fixture = {
    text: '替代物正文',
    title: '调研 store 层',
    summary: '模型给的 description',
    origin: 'semantic',
    from: 1,
    to: 5,
    rounds: 3,
    toolCalls: [
      { name: 'readFile', argsSummary: 'path=a' },
      { name: 'exec' },
    ],
  };
  const folded = await foldedWith(fixture);
  assert.deepEqual(folded.facts, {
    title: '调研 store 层',
    summary: '模型给的 description',
    origin: 'semantic',
    from: 1,
    to: 5,
    rounds: 3,
    toolCalls: [
      { name: 'readFile', argsSummary: 'path=a' },
      { name: 'exec' },
    ],
  });
  // 加法性：既有 `summaryText` 仍在（= 替代物正文），与新增的 facts 并存。
  assert.equal(folded.summaryText, '替代物正文');
});

// ── 用例 2：`titleFallback` / `summaryDropped` 只在 === true 时给 ────────────────────────────
test('#816-2 titleFallback/summaryDropped 只在 === true 时给；false ⇒ 键不出现（不是 false）', async () => {
  const off = await foldedWith({ title: 't', titleFallback: false, summaryDropped: false });
  assert.ok(!Object.hasOwn(off.facts, 'titleFallback'), 'titleFallback:false ⇒ 键不出现（不写 false）');
  assert.ok(!Object.hasOwn(off.facts, 'summaryDropped'), 'summaryDropped:false ⇒ 键不出现（不写 false）');

  const on = await foldedWith({ title: 't', titleFallback: true, summaryDropped: true });
  assert.equal(on.facts.titleFallback, true, 'titleFallback:true ⇒ 键出现且为 true');
  assert.equal(on.facts.summaryDropped, true, 'summaryDropped:true ⇒ 键出现且为 true');
});

// ── 用例 3：origin 白名单（白名单外不给键，其余照常） ───────────────────────────────────────
test('#816-3 origin 白名单：白名单外（llm）⇒ facts.origin 不出现，其余键照常', async () => {
  const folded = await foldedWith({ title: 't', origin: 'llm', from: 2 });
  assert.ok(!Object.hasOwn(folded.facts, 'origin'), '`origin:\'llm\'` 不在白名单 ⇒ 不给键（不是原样透传）');
  assert.deepEqual(folded.facts, { title: 't', from: 2 }, '白名单外的 origin 不影响其余子键');
});

// ── 用例 4：toolCalls 逐项清洗（trim name、空 argsSummary 不带键、非对象丢弃） ───────────────
test('#816-4 toolCalls 逐项清洗 ⇒ 只留两条、name 已 trim、空 argsSummary 不带键', async () => {
  const folded = await foldedWith({
    toolCalls: [null, { name: '' }, { name: ' exec ', argsSummary: '' }, { name: 'readFile', argsSummary: 'path=a' }],
  });
  assert.deepEqual(folded.facts.toolCalls, [
    { name: 'exec' },
    { name: 'readFile', argsSummary: 'path=a' },
  ]);
});

// ── 用例 5：toolCalls 全脏 ⇒ facts.toolCalls 不出现（不是 []） ───────────────────────────────
test('#816-5 toolCalls 全脏 ⇒ facts.toolCalls 键不出现（不是空数组）', async () => {
  // #816 补刀后：无任何认得子键时整个 `facts` 键会缺席；故本夹具额外带一个有效兄弟键 `from`，
  // 使 `facts` 非空、下面「facts 键必出」前提仍成立（本例判的是 toolCalls 清洗，不受 `from` 影响）。
  const folded = await foldedWith({ from: 2, toolCalls: [null, { name: '' }, 42, { name: '   ' }] });
  assert.ok(Object.hasOwn(folded, 'facts'), 'foldedFacts 仍是对象 ⇒ facts 键必出');
  assert.ok(!Object.hasOwn(folded.facts, 'toolCalls'), '清洗后为空 ⇒ 不给 toolCalls 键（不是 []）');
  assert.ok(!Object.hasOwn(folded.facts, 'title'),
    '本夹具没有 title ⇒ 缺省即不知道，facts 里不许冒出 title 键（尤其不许写空串占位）');
});

// ── 用例 6：foldedFacts 是数组 / 字符串 / null ⇒ 整个 facts 键不出现，既有三键行为不变 ───────
test('#816-6 foldedFacts 是数组/字符串/null ⇒ 整个 facts 键不出现，既有三键也不冒出', async () => {
  for (const dirty of [[], 'a string', null]) {
    const label = JSON.stringify(dirty) ?? String(dirty);
    const folded = await foldedWith(dirty);
    assert.ok(!Object.hasOwn(folded, 'facts'), `foldedFacts=${label} ⇒ 整个 facts 键不出现`);
    for (const key of ['summaryText', 'summarySource', 'truncated']) {
      assert.ok(!Object.hasOwn(folded, key),
        `foldedFacts=${label} 非对象 ⇒ 既有键 ${key} 逐字不变（仍缺席，不是 null/false/空串）`);
    }
  }
});

// ── 用例 7：summaryText（替代物正文）与 facts.summary（模型 description）并存且不同值 ────────
test('#816-7 summaryText 与 facts.summary 并存且不同值（防被合并成一个键）', async () => {
  const folded = await foldedWith({ text: '替代物正文ABC', summary: '模型descriptionXYZ' });
  assert.equal(folded.summaryText, '替代物正文ABC', 'summaryText = foldedFacts.text（替代物正文）');
  assert.equal(folded.facts.summary, '模型descriptionXYZ', 'facts.summary = 模型给的 description');
  assert.notEqual(folded.summaryText, folded.facts.summary,
    '两者是两份不同的东西，不许被合并成同一个值');
});

// ── 用例 8：无认得子键 ⇒ 整个 facts 键不出现（空壳 ≠ 有事实）；title 纯空白 ⇒ 取不到 ────────
test('#816-8 foldedFacts 是空对象 / 只含未认得的键 ⇒ 整个 facts 键不出现（空壳不等于有事实）', async () => {
  for (const empty of [{}, { someUnknownKey: 1 }, { title: '   ' }]) {
    const folded = await foldedWith(empty);
    const label = JSON.stringify(empty);
    assert.ok(!Object.hasOwn(folded, 'facts'),
      `foldedFacts=${label} 没有任何认得子键 ⇒ 整个 facts 键不出现（不是空壳 {}）`);
  }
  const trimmed = await foldedWith({ title: '  调研 store 层  ' });
  assert.equal(trimmed.facts.title, '调研 store 层', 'title 前后空白被 trim 后作为有效值写入 facts.title');
});
