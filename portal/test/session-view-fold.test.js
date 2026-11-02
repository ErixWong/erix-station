// issue #337 切片 A+B：0.23 读侧折叠的**行为门**——真 `runToolLoop` 产出 → 生产列形状的行 → `projectSessionMessages`。
//
// 为什么要有这个文件（上一片 §4.8 的四条证据，逐条对应这里的选择）：
//   · 站内所有 `session-view` 用例的 fixture 都停在 **0.22 账本形状**（`record.messages` 手写），
//     断言（`resultPreview` / `isError`）在、夹具却让它永不触雷；
//   · 站内**没有任何**用例把真引擎产出喂进展示面（`grep -rl runToolLoop portal/test` 与
//     `projectSessionMessages` 的交集为空）⇒ 0.23 把「一轮正文搬进 `kind:"message"` 行、轮行不再带
//     `messages`」之后，工具卡片的执行事实（`resultPreview` / `isError` / `executionStatus`）在刷新后
//     全丢，而三套基线全绿。
//
// 本文件因此**不手写账本**：真跑 `runToolLoop`（站内 `node_modules` 的 0.23.0），把 store 收到的行按
// **生产列形状**装成 `transcript_rounds` 行（`run_id: null` —— 迁移 0015 之后 session 作用域行恒如此，
// 这正是消息行被 `isSessionRound` 整行丢弃的那条路径），再喂 `projectSessionMessages`。
//
// 三个判据（工单要求的三条，缺一不可）：
//   ① 修复前红、修复后绿：`resultPreview` 存在、失败那条 `isError === true`；
//   ② **不新增重复条目**：`toolCalls.length` 与 0.22 形状一致（生产本来就不重复，别把「去重」当卖点）；
//   ③ **旧 0.22 账本（无消息行）走折叠后输出逐字节不变**（防误折 / 防过度归一）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from 'erix-agent';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareTranscriptRows, projectSessionMessages, recordForProjection } from '../src/session-view.js';
import { foldTranscriptRows } from '../src/transcript-fold.js';
import { assertCompactContext } from '../../runner/lib/compact-knobs.js';

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER_DIR = path.join(PORTAL_DIR, '..', 'runner');

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

/** 主模型：第 1 轮要两个 `readFile`（一个成功、一个抛错），第 2 轮给终稿。 */
function stubProvider() {
  let call = 0;
  return {
    async chat() {
      call += 1;
      if (call === 1) {
        return {
          content: [
            { type: 'text', text: '先读两个文件' },
            { type: 'tool_use', id: 'ok1', name: 'readFile', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'bad1', name: 'readFile', input: { path: 'missing.txt' } },
          ],
          stopReason: 'tool_use',
        };
      }
      return { content: text('收工'), stopReason: 'end_turn' };
    },
  };
}

const TOOLS = [{
  name: 'readFile',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

/** 真跑一次 0.23 `runToolLoop`，返回引擎经 `appendRound` 落下的原始行（= 生产 `record` 列）。 */
async function runRealLedger() {
  const records = {};
  await runToolLoop({
    provider: stubProvider(),
    tools: TOOLS,
    executeTool: async ({ input }) => {
      if (input.path === 'missing.txt') throw new Error('ENOENT: no such file');
      return 'file body line1\nline2';
    },
    store: makeStore(records),
    // erix-agent 0.28.0：数据只能写进 `config.<组>.<叶>`（扁平 `initialUserMessage` /
    // `completion` / `maxRounds` / `runId` 现在启动期就抛）；观察者/端口仍是顶层。
    config: {
      input: { initialUserMessage: '读文件' },
      run: { runId: SESSION_ID, maxRounds: 4, completion: false },
    },
  });
  const rows = records[SESSION_ID] ?? [];
  assert.ok(rows.some((row) => row.kind === 'message'), '前置条件：0.23 必须真的落出 kind:"message" 行');
  const carrierRows = rows.filter((row) => row.kind !== 'message' && /:round:\d+$/.test(row.dedupKey ?? ''));
  assert.ok(carrierRows.length > 0, '前置条件：账本里必须有轮行（折叠载体）');
  assert.ok(
    carrierRows.every((row) => (row.messages ?? []).length === 0),
    '前置条件：0.23 的轮行必须真的不再带正文（messages 为空/缺失）',
  );
  return rows;
}

/** 宿主 `appendUserTurn` 写的那条 `:input:` 行（`erix-agent/src/store/append-user-turn.js` 的形状：
 *  带 `messages`、**不带** `kind`/`seq`）——生产里每条用户输入都有一条，投影靠它按 messageId 精确认领。 */
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

/** 引擎原始 record → `transcript_rounds` 行（列形状与 `sessions.js` / `session-text.js` 的 SELECT 逐列一致）。 */
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
  {
    id: USER_MSG, run_id: RUN_ID, seq: 1, role: 'user', synthetic: false, content: '', attachments: [], created_at: at(1),
  },
  {
    id: ASSISTANT_MSG, run_id: RUN_ID, seq: 2, role: 'assistant', synthetic: false, content: '', attachments: [], created_at: at(2),
  },
];
const USER_ANCHORS = [{
  id: USER_MSG, run_id: RUN_ID, seq: 1, synthetic: false, anchor_text: '读文件', created_at: at(1),
}];

function project(transcriptRows) {
  return projectSessionMessages({
    sessionId: SESSION_ID, anchors: ANCHORS, userAnchors: USER_ANCHORS, transcriptRows,
  });
}

/** DTO 里助手那条锚点的 toolCalls，按 id 索引（顺序另断言）。 */
function callsById(dto) {
  const assistant = dto.find((message) => message.role === 'assistant');
  const map = new Map();
  for (const call of assistant?.toolCalls ?? []) map.set(call.id, call);
  return map;
}

test('#337 真 0.23 账本：刷新后工具执行事实（resultPreview / isError）必须在 DTO 里', async () => {
  const records = await runRealLedger();
  const dto = project([inputRow(), ...toTranscriptRows(records)]);

  const calls = callsById(dto);
  assert.deepEqual([...calls.keys()], ['ok1', 'bad1'], '两条工具调用都必须透传到 DTO');

  const ok = calls.get('ok1');
  assert.equal(typeof ok.resultPreview, 'string',
    'resultPreview 必须存在（修复前它是 absent ⇒ 前端卡片退化成 `…`）');
  assert.match(ok.resultPreview, /^file body line1/);
  assert.equal(ok.isError, undefined, '成功那条不应带 isError 键（有则出现、无则不写）');

  const bad = calls.get('bad1');
  assert.equal(typeof bad.resultPreview, 'string', '失败那条同样必须有 resultPreview');
  assert.match(bad.resultPreview, /ENOENT: no such file/);
  assert.equal(bad.isError, true, '失败那条必须 isError === true（前端据此渲染 ✗）');
});

test('#337 真 0.23 账本：折叠不新增重复条目（toolCalls.length 与 0.22 形状一致）', async () => {
  const records = await runRealLedger();
  const dto = project([inputRow(), ...toTranscriptRows(records)]);

  const assistant = dto.find((message) => message.role === 'assistant');
  // 生产形状（`run_id` 为 NULL）下消息行原本被 `isSessionRound` 整行丢弃 ⇒ 折叠前也不重复。
  // 这里钉住「折叠不会把它变成 3 条/4 条」：折叠是「把正文搬回轮行」，不是「去重」。
  assert.equal(assistant.toolCalls.length, 2, `toolCalls 必须恰好 2 条，实际 ${assistant.toolCalls.length}`);
  assert.equal(new Set(assistant.toolCalls.map((call) => call.key)).size, 2, 'toolCalls 的视图 key 必须互不相同');
  assert.equal(assistant.content, '收工', '助手终稿必须仍是最后一段正文（不重复、不拼接）');
  assert.equal(dto.length, 2, '锚点数不变 ⇒ DTO 条数不变');
  const user = dto.find((message) => message.role === 'user');
  assert.equal(user.content, '读文件', '用户输入正文必须仍按 messageId 精确认领（不漏、不重复）');
});

test('#337 旧 0.22 账本（无消息行）走折叠后输出逐字节不变', () => {
  // 0.22 形状：轮行自带 `messages`、账本里没有任何 `kind:"message"` 行。这份 fixture 的内容与上面
  // 真引擎那一轮同源，但**全部手写**（确定性：不含真耗时），期望值是本单改动**之前**实测的输出快照。
  const LEGACY_ROWS = [
    {
      run_id: null,
      round: 0,
      dedup_key: `${SESSION_ID}:input:${USER_MSG}`,
      created_at: at(1),
      record: {
        round: 0,
        dedupKey: `${SESSION_ID}:input:${USER_MSG}`,
        roundKey: `${SESSION_ID}:input:${USER_MSG}`,
        messages: [{ role: 'user', content: text('读文件') }],
      },
    },
    {
      run_id: null,
      round: 0,
      dedup_key: `${SESSION_ID}:engine:round:0:seed`,
      created_at: at(2),
      record: {
        round: 0,
        dedupKey: `${SESSION_ID}:engine:round:0:seed`,
        messages: [{ role: 'user', content: text('读文件') }],
        response: { stopReason: 'end_turn' },
      },
    },
    {
      run_id: null,
      round: 1,
      dedup_key: `${SESSION_ID}:engine:round:1`,
      created_at: at(3),
      record: {
        round: 1,
        dedupKey: `${SESSION_ID}:engine:round:1`,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '先读两个文件' },
              { type: 'tool_use', id: 'ok1', name: 'readFile', input: { path: 'a.txt' } },
              { type: 'tool_use', id: 'bad1', name: 'readFile', input: { path: 'missing.txt' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'ok1', content: 'file body line1\nline2' },
              { type: 'tool_result', tool_use_id: 'bad1', content: 'ENOENT: no such file', is_error: true },
            ],
          },
        ],
        response: {
          content: [
            { type: 'text', text: '先读两个文件' },
            { type: 'tool_use', id: 'ok1', name: 'readFile', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'bad1', name: 'readFile', input: { path: 'missing.txt' } },
          ],
          stopReason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        toolUses: 2,
      },
    },
    {
      run_id: null,
      round: 2,
      dedup_key: `${SESSION_ID}:engine:round:2`,
      created_at: at(4),
      record: {
        round: 2,
        dedupKey: `${SESSION_ID}:engine:round:2`,
        messages: [{ role: 'assistant', content: text('收工') }],
        response: { content: text('收工'), stopReason: 'end_turn', usage: { input_tokens: 20, output_tokens: 3 } },
      },
    },
  ];

  const snapshot = structuredClone(LEGACY_ROWS);
  const dto = project(LEGACY_ROWS);

  // 「逐字节不变」= 与本单改动之前实测的输出快照深比较相等（含字段顺序无关的整棵结构）。
  assert.deepEqual(dto, [
    {
      id: USER_MSG,
      run_id: RUN_ID,
      seq: 1,
      role: 'user',
      content: '读文件',
      synthetic: false,
      attachments: [],
      created_at: '2026-10-21T00:00:01.000Z',
    },
    {
      id: ASSISTANT_MSG,
      run_id: RUN_ID,
      seq: 2,
      role: 'assistant',
      content: '收工',
      synthetic: false,
      attachments: [],
      created_at: '2026-10-21T00:00:02.000Z',
      toolCalls: [
        {
          name: 'readFile', id: 'ok1', argsSummary: 'path=a.txt', resultPreview: 'file body line1\nline2', key: '1#0:0:t0',
        },
        {
          name: 'readFile', id: 'bad1', argsSummary: 'path=missing.txt', resultPreview: 'ENOENT: no such file', isError: true, key: '1#0:0:t1',
        },
      ],
      blocks: [
        { type: 'text', text: '先读两个文件' },
        { type: 'tool_use', id: 'ok1', name: 'readFile', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'bad1', name: 'readFile', input: { path: 'missing.txt' } },
        { type: 'text', text: '收工' },
      ],
      turnKeys: ['1#0:0', '2#0:0'],
    },
  ]);

  // 折叠必须是**纯**的：入参行一个字节都不许被改写（旧账本「原样透传」的另一半）。
  assert.deepEqual(LEGACY_ROWS, snapshot, '折叠不得改写入参行（纯函数）');
});

// ============================================================================
// #341（上游 erix-agent #415）：链式 `partOf` 的**投影面贯通**
// ============================================================================
//
// 一轮 ≥3 个并行工具调用时，0.23 写侧把 `partOf` 写成**链**（第 3 片指第 2 片）。本站折叠必须
// 解链，否则同一轮的聚合 `tool_result` 会被劈成多条 user 消息（形状 ≠ 0.22，引擎 resume 会
// `invalid_messages`）。
//
// ⚠ 诚实标注（实测，别拿「全绿」当解链生效的证据）：本用例的**第一半**（DTO 里 `resultPreview`
// 在不在）在解链前后**都是绿的** —— 上游 `projection.js#toolResultsOf(messages)` 扫整条 record 的
// 全部 messages（按 `tool_use_id` 建 Map），所以被劈出去那条 user 消息里的 `tool_result` 仍然配得上
// 对；纯 tool_result 消息 `textOf()` 为空串，也不会多出 user 气泡。**解链的行为判据是第二半**
// （折叠后该轮载体行必须恰好 1 条聚合 `tool_result`），它才是撤掉解链会红的那条。

/** 主模型：第 1 轮要三个 `readFile`（第三个抛错），第 2 轮给终稿。 */
function stubThreeToolProvider() {
  let call = 0;
  return {
    async chat() {
      call += 1;
      if (call === 1) {
        return {
          content: [
            { type: 'text', text: '先读三个文件' },
            { type: 'tool_use', id: 'ok1', name: 'readFile', input: { path: 'a.txt' } },
            { type: 'tool_use', id: 'ok2', name: 'readFile', input: { path: 'b.txt' } },
            { type: 'tool_use', id: 'bad1', name: 'readFile', input: { path: 'missing.txt' } },
          ],
          stopReason: 'tool_use',
        };
      }
      return { content: text('收工'), stopReason: 'end_turn' };
    },
  };
}

/**
 * 真跑一次 `runToolLoop`（3 个并行工具），返回引擎落下的原始行。
 *
 * ⚠ **erix-agent 0.25.0 起了结形状变了**：上游把**写侧**修好了（`orchestrator.js:3927`
 * `if (toolResultRowKey === undefined && …)` —— 只在**第一个**分片上登记 key），所以三片的
 * `partOf` 现在**都直指聚合首片**，不再串成链。本函数因此钉的是「新账本不再产链」。
 * 而**读侧** `message-rows.js` 的 `parts.set` 仍恰好一处（分片分支不登记）⇒ **存量 0.23 账本里的链
 * 上游依旧解不了** ⇒ 本站那份解链闸必须留着，判据见下面那条「存量链式形状」用例。
 */
async function runRealEngineLedger() {
  const records = {};
  await runToolLoop({
    provider: stubThreeToolProvider(),
    tools: TOOLS,
    executeTool: async ({ input }) => {
      if (input.path === 'missing.txt') throw new Error('ENOENT: no such file');
      return `body of ${input.path}`;
    },
    store: makeStore(records),
    config: {
      input: { initialUserMessage: '读文件' },
      run: { runId: SESSION_ID, maxRounds: 4, completion: false },
    },
  });
  const rows = records[SESSION_ID] ?? [];
  const shards = rows.filter((row) => typeof row.partOf === 'string');
  assert.equal(shards.length, 2, '前置条件：3 个工具结果里后两条必须带 partOf');
  // 0.25.0 的真形状：两片都指向**同一条**（聚合首片 `msg:<round>:1`），不是前一片。
  assert.equal(shards[1].partOf, shards[0].partOf,
    'erix-agent 0.25.0 写侧已修 #415：后一片必须与前一片指向同一个链头。'
    + '它若变回「指前一片」= 上游又写链了 ⇒ 本站解链正好兜住，但这条要先红给你看');
  return rows;
}

/** 把真账本改回 **0.23 存量形状**（第 3 片的 `partOf` 指前一片分片行）= 现网老会话的样子。 */
function chainify(rows) {
  const shards = rows.filter((row) => typeof row.partOf === 'string');
  const copy = rows.map((row) => ({ ...row }));
  const target = copy.find((row) => row.dedupKey === shards[1].dedupKey);
  target.partOf = shards[0].dedupKey;
  return copy;
}

test('#341 投影面贯通（0.25 新账本：partOf 直指链头）⇒ 工具卡片带 resultPreview，折叠后是 1 条聚合 tool_result', async () => {
  const rows = await runRealEngineLedger();
  const transcriptRows = [inputRow(), ...toTranscriptRows(rows)];

  // ① 用户可见面：三张工具卡片都要带执行事实（刷新后不该退化成 `…`）。
  const calls = callsById(project(transcriptRows));
  assert.deepEqual([...calls.keys()], ['ok1', 'ok2', 'bad1'], '三条工具调用都必须透传到 DTO');
  for (const id of ['ok1', 'ok2', 'bad1']) {
    assert.equal(typeof calls.get(id).resultPreview, 'string', `${id} 必须带 resultPreview`);
  }
  assert.match(calls.get('ok1').resultPreview, /^body of a\.txt/);
  assert.match(calls.get('ok2').resultPreview, /^body of b\.txt/);
  assert.match(calls.get('bad1').resultPreview, /ENOENT: no such file/);
  assert.equal(calls.get('bad1').isError, true, '失败那条必须 isError === true');

  // ② 解链判据（投影的**输入**形状）：该轮载体行折叠后必须恰好 2 条消息，
  //    第 2 条是含 3 个 tool_result 的**一条**聚合消息 —— 撤掉解链 ⇒ 这里是 3 条 ⇒ 红。
  const foldedRows = foldTranscriptRows([...transcriptRows].sort(compareTranscriptRows), {
    recordOf: (row) => recordForProjection(row).record,
  });
  const carrier = foldedRows.find((row) => row.dedup_key === `${SESSION_ID}:engine:round:1`);
  assert.ok(carrier, '折叠后该轮载体行必须还在（引擎轮行是载体）');
  assert.equal(carrier.record.messages.length, 2,
    `折叠后必须 2 条消息（1 assistant + 1 聚合 tool_result），实际 ${carrier.record.messages.length} 条`
    + ' —— 3 条 = 链没解开（第 3 片被当成独立消息）');
  assert.deepEqual(carrier.record.messages[1].content.map((block) => block.tool_use_id), ['ok1', 'ok2', 'bad1'],
    '聚合消息必须按 seq 含全部 3 个 tool_result');
});

test('#341 存量 0.23 链式账本（手工还原的形状）⇒ 本站解链闸仍必须把它折回 1 条聚合消息', async () => {
  // 为什么这条要单独存在：erix-agent 0.25.0 修的是**写侧**，**读侧 `parts.set` 仍恰好一处**
  // ⇒ 现网 0.23 时代落下的链式行，上游读侧依旧解不了（`portal/test/transcript-fold.test.js` 的
  // 「上游能否解链」哨兵钉着这件事）。撤掉本站的闸，这些老会话在下一次 resume 时就会
  // `invalid_messages`（§8.52 那类砖化）。所以判据必须由**合成夹具**驱动，不能依赖引擎版本。
  const rows = await runRealEngineLedger();
  const chained = chainify(rows);
  const shards = chained.filter((row) => typeof row.partOf === 'string');
  assert.equal(shards[1].partOf, shards[0].dedupKey, '夹具自证：第 3 片必须指前一片（真 0.23 的形状）');

  const foldedRows = foldTranscriptRows([inputRow(), ...toTranscriptRows(chained)].sort(compareTranscriptRows), {
    recordOf: (row) => recordForProjection(row).record,
  });
  const carrier = foldedRows.find((row) => row.dedup_key === `${SESSION_ID}:engine:round:1`);
  assert.ok(carrier, '载体行必须在');
  assert.equal(carrier.record.messages.length, 2,
    '解链后必须恰好 2 条消息（1 assistant + 1 条含三个 tool_result 的聚合 user）。'
    + '撤掉 `planFold` 里那行 `parts.set(key, partTargetIndex)` ⇒ 这里变 3 条，本用例红');
  const aggregate = carrier.record.messages[1];
  assert.equal(aggregate.role, 'user');
  assert.equal(aggregate.content.filter((block) => block.type === 'tool_result').length, 3,
    '三个 tool_result 必须并成**同一条** user 消息（分开就是 invalid_messages 的形状）');
  // 用户可见面同样不许退化
  const calls = callsById(project([inputRow(), ...toTranscriptRows(chained)]));
  assert.deepEqual([...calls.keys()].sort(), ['bad1', 'ok1', 'ok2']);
});

// ── issue #438 切片 B（M3.2）：DTO 侧 `folded` 在 **fold-llm 真折叠**下的形状 ───────────────
//
// 为什么这条必须在 portal 侧：横幅两态（`folded.hasSummary` / `foldedRoundRange`）是**读侧投影**
// 的事——引擎只负责把 `folded: true` / `foldedRoundRange` / `foldedPayload` 写进轮记录
// （`orchestrator.js:5401-5408`），"这两态长什么样"由 `session-view.js` 的 `foldedTurnFields` 决定。
// 手工喂 DTO 的单测证明不了接线（§8.67 的教训）⇒ 这里**真跑 `runToolLoop` + `fold-llm`**，把真账本行
// 按生产列形状装成 `transcript_rounds` 行，再喂 `projectSessionMessages`。
//
// 策略与尾窗**从 `runner/worker.js` 的真配置里抠**（不另抄）：切片 B 把生产策略翻成 `fold-llm` 之后，
// 这里如果还写 `fold-statistical`，证的就是一个已经不存在的配置。
const CTX_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;

function workerFoldingContext() {
  const src = readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const block = src.match(CTX_MARKERS);
  assert.ok(block, 'worker.js 的 #392:context-strategy 标记没了');
  // 注入真校验器（不换桩，§8.73）：本格顺带证明 worker 里那份真配置能过本站自己的白名单。
  return new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
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

/** 真跑一次 `fold-llm`（摘要那一发走同一个 provider，按 system prompt 认出来单独回）。 */
async function runRealFoldLlmLedger() {
  const records = {};
  const main = [];
  const events = [];
  const provider = {
    async chat(request) {
      if (typeof request?.system === 'string' && request.system.includes('对话历史压缩器')) {
        return { content: text('【LLM 摘要】已折走早期轮次，细节去 transcript 查。'), stopReason: 'end_turn' };
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
    onEvent: (event) => events.push(event),
    config: {
      input: { messages: foldHistory(14), initialUserMessage: '继续收尾' },
      run: { runId: SESSION_ID, maxRounds: 6, completion: false },
      folding: { context: workerFoldingContext() },
      metadata: { task: 't', modelMetadata: { contextWindowTokens: 6000, maxOutputTokens: 200 } },
      tuning: { maxTokens: 200 },
    },
  });
  const rows = records[SESSION_ID] ?? [];
  const foldRow = rows.find((row) => row.folded === true);
  assert.ok(foldRow, '前置：这一跑必须真的折过一次（否则下面的 DTO 断言全是空断言）');
  return { rows, foldRow, events };
}

test('#438-B4 DTO：fold-llm 真折叠 ⇒ folded.foldedRoundRange 是整数区间、hasSummary 两态可翻', async () => {
  const { rows, foldRow, events } = await runRealFoldLlmLedger();
  // 前置：真折叠的账本形状（引擎写侧，`orchestrator.js:5401`）
  assert.ok(Number.isSafeInteger(foldRow.foldedRoundRange?.from) && Number.isSafeInteger(foldRow.foldedRoundRange?.to),
    `折叠轮的 foldedRoundRange 必须是两个整数（实得 ${JSON.stringify(foldRow.foldedRoundRange)}）`);
  assert.ok(Array.isArray(foldRow.foldedPayload) && foldRow.foldedPayload.length > 0);

  const transcriptRows = [inputRow(), ...toTranscriptRows(rows)];
  const dto = project(transcriptRows);
  const assistant = dto.find((message) => message.role === 'assistant');
  assert.ok(assistant?.folded, 'DTO 必须带 folded（横幅两态的载体）；没有就说明投影没把折叠轮认出来');
  assert.deepEqual(assistant.folded.foldedRoundRange, foldRow.foldedRoundRange,
    'DTO 的 foldedRoundRange 必须与账本同源同值（#95 红线：逐字透传，不重推导）');
  assert.equal(assistant.folded.round, foldRow.round,
    'folded.round 必须是**该折叠行自己的轮号**（「查看原文」端点的查询键），不是被折区间');
  assert.equal(typeof assistant.folded.hasSummary, 'boolean',
    'hasSummary 必须是布尔（#390-A：轮号可定时才给得出「这次折叠有没有真摘要」）');
  // 本现场没有 wrapup 摘要 ⇒ 两态里的 false 那一态（真值，不是「不知道」）
  assert.equal(assistant.folded.hasSummary, false,
    '没有 wrapup 摘要的折叠轮必须报 false（报 true 就是许诺一份不存在的摘要）');

  // 另一态：给同一条真行补上引擎的 wrapup 摘要形状（`summary: {action, note}`）⇒ hasSummary 必须翻成 true。
  // ⚠ 这是**有意的单点变异**（真行 + 一处 documented 改动），用来证明两态**真的由数据驱动**，
  //   而不是恒 false 的死键。
  const withSummary = rows.map((row) => (row === foldRow ? { ...row, summary: { action: 'wrapup', note: '已收尾' } } : row));
  const dto2 = project([inputRow(), ...toTranscriptRows(withSummary)]);
  const assistant2 = dto2.find((message) => message.role === 'assistant');
  assert.equal(assistant2.folded.hasSummary, true,
    '同一条折叠行补上 {action,note} 摘要后 hasSummary 必须变 true ⇒ 否则这个键是恒 false 的死键');

  // 事件行那一半（M3.2 的另一条腿）：真 compaction 事件的实例策略名就是界面显示的字符串。
  const stat = events.find((event) => event?.type === 'compaction')?.compaction;
  assert.equal(stat?.strategyName, 'fold-llm',
    '事件里的 strategyName 必须是 fold-llm（`useEventStream.ts` 的 compaction 分支原样显示它）');
});

// ── issue #440（M1）：`foldedFacts` 进 DTO ────────────────────────────────────────────────
//
// 真机病症（会话 `e02d96cb…` 第 25 轮，`seq 8989`）：轮记录里明明躺着
// `foldedFacts = {source:'llm', origin:'semantic', strategy:'fold-llm', text:'## 阶段…（2048 B）',
// truncated:true, bytesBefore:3076}`，而 `GET /api/sessions/:id` 的 `folded.hasSummary === false`
// （fold-llm 写的是字面量 `"missing"`）⇒ 横幅显示「this fold produced no summary」，
// `foldedFacts.text` **压根没进 DTO** ⇒ 用户为语义折叠付的那份 token 一个字节也看不见。
//
// 三条判据的分工（每条都有「删掉/改坏就红」的方向）：
//   · D1 真 `fold-llm` 账本 ⇒ `summarySource:'llm'` + `summaryText` 非空 + `truncated` 反映真实值，
//     且 **`hasSummary` 仍是 false**（#390-A 的语义一字未改，这正是 #440 的两层病根之一）；
//   · D2 只有机械替代物（`fold-statistical`）⇒ `summarySource:'statistical'`，且**不冒充** `truncated`；
//   · D3 `foldedFacts` 缺席（旧账本）⇒ 三个新键**都不在**（不是 `null` / `false`）。
//
// 与 #438-B4 同一套取证：真跑 `runToolLoop`，把真账本行按生产列形状装成 `transcript_rounds` 再投影。
// 手工喂 DTO 的单测证明不了接线（§8.67 的教训）。

/** 真跑一次指定策略的折叠（`fold-statistical` 不需要摘要器那一发）。`summary` 可给长文本以便真夹断。 */
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

test('#440-D1 真 fold-llm 账本 ⇒ DTO 透传 summarySource/summaryText/truncated，而 hasSummary 仍是 false', async () => {
  const { rows, foldRow } = await runRealFoldLlmLedger();
  // 前置：账本侧的形状（引擎写侧 `orchestrator.js:5417` + `buildFoldedFacts`）
  assert.equal(foldRow.foldedFacts?.source, 'llm', '前置：真 fold-llm 的 foldedFacts.source 必须是 llm');
  assert.equal(typeof foldRow.foldedFacts?.text, 'string');
  assert.ok(foldRow.foldedFacts.text.length > 0);

  const dto = project([inputRow(), ...toTranscriptRows(rows)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.ok(folded, 'DTO 必须带 folded（横幅的载体）');

  assert.equal(folded.summarySource, 'llm',
    '`summarySource` 必须逐字等于账本 `foldedFacts.source`（#440 的 M1 主判据：删掉这个键就红）');
  assert.equal(folded.summaryText, foldRow.foldedFacts.text,
    '`summaryText` 必须与账本 `foldedFacts.text` **逐字同源**（#95 红线：不裁剪、不重推导）');
  assert.ok(folded.summaryText.length > 0, 'summaryText 不许是空串');
  // 本现场的摘要短于 `FOLDED_FACTS_MAX_BYTES` ⇒ 引擎不写 `truncated` ⇒ DTO 也不许造一个。
  // 真夹断那一格由 D1b 单独钉（两个方向都要有：不夹断 ⇒ 键缺席；夹断 ⇒ true）。
  assert.ok(!Object.hasOwn(folded, 'truncated'), '没有夹断时 DTO 不许出现 truncated（更不许写 false）');

  // #390-A 的语义**一字未动**：`hasSummary` 只读 `record.summary`（本现场是字面量 "missing"）。
  // 这一格就是 #440 的原文病症：`hasSummary === false` 与 `summarySource === 'llm'` **同时成立**，
  // 横幅必须靠后者说话，不许再说「没有生成摘要」。
  assert.equal(foldRow.summary, 'missing', '前置：fold-llm 仍把 record.summary 写成字面量 "missing"');
  assert.equal(folded.hasSummary, false,
    '`hasSummary` 不许被 #440 改成读 `foldedFacts.text`（#390-A 钉着；D1 与 D3 各从一个方向拦它）');
});

test('#440-D1b 语义摘要被 2048 B 上界真夹断 ⇒ DTO 的 truncated === true（横幅据此说「被夹断」）', async () => {
  // 真机标本（#440）就是这一格：`text` 2048 B、`truncated:true`、`bytesBefore:3076`。
  // ⚠ 用长 ASCII 正文而不是重复中文：`maxSummaryTokens` 会先把超预算的中文摘要「修剪」成恢复提示
  //   （`[已修剪]`），那样测到的是修剪层、不是 `buildFoldedFacts` 的字节夹断。ASCII 长文不会触发修剪。
  const { rows, foldRow } = await runRealFoldLedger('fold-llm', `【LLM 摘要】${'x'.repeat(3000)}`);
  assert.equal(foldRow.foldedFacts?.truncated, true,
    `前置：超长语义摘要必须被 FOLDED_FACTS_MAX_BYTES 夹断（实得 ${JSON.stringify(foldRow.foldedFacts?.truncated)}）`);
  assert.ok(Number.isSafeInteger(foldRow.foldedFacts.bytesBefore) && foldRow.foldedFacts.bytesBefore > foldRow.foldedFacts.bytes,
    '前置：夹断事实必须带 bytesBefore > bytes（引擎口径）');

  const dto = project([inputRow(), ...toTranscriptRows(rows)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.equal(folded.truncated, true, '账本 `truncated:true` ⇒ DTO 必须透传 true（删掉这一键 ⇒ 横幅不再提示被夹断）');
  assert.equal(folded.summarySource, 'llm');
  assert.equal(folded.summaryText, foldRow.foldedFacts.text, 'summaryText 仍是账本那份（夹断后的 2048 B 正文）');
});

test('#440-D2 只有机械替代物（fold-statistical）⇒ summarySource=statistical，且不冒充 truncated', async () => {
  const { rows, foldRow } = await runRealFoldLedger('fold-statistical');
  assert.equal(foldRow.foldedFacts?.source, 'statistical',
    '前置：真 fold-statistical 的 foldedFacts.source 必须是 statistical');

  const dto = project([inputRow(), ...toTranscriptRows(rows)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.ok(folded, 'DTO 必须带 folded');
  assert.equal(folded.summarySource, 'statistical',
    '机械替代物必须自报 statistical（横幅第二态：不许说它是 LLM 语义摘要）');
  assert.equal(typeof folded.summaryText, 'string');
  assert.ok(!Object.hasOwn(folded, 'truncated'),
    '账本没有 `truncated` 键时 DTO 也**不许**造一个（写 false 就是替引擎断言「我看过且没夹断」）');
});

test('#440-D4 两个折叠行（round 3 / 7）⇒ 各自取自己那一轮的 foldedFacts，不串号也不吃数组下标', async () => {
  // 主 agent 补的覆盖缺口：`foldedFactsByRound` 若用「第几条」当键（而不是 `row.round`），
  // 单折叠行夹具（round=1）恰好命中，D1/D2/D3 全绿也发现不了 —— 这条用 round 3 / 7 把它钉住。
  const { rows, foldRow } = await runRealFoldLlmLedger();
  const base = foldRow;
  // `runRealFoldLlmLedger` 返回的是**引擎 record** 数组（不是 `transcript_rounds` 行），行由 `toTranscriptRows` 造。
  const mk = (round, text) => ({
    ...base,
    round,
    dedupKey: `${SESSION_ID}:engine:round:${round}`,
    roundKey: `${SESSION_ID}:engine:round:${round}`,
    foldedFacts: { ...base.foldedFacts, text },
  });
  const rowsWithTwoFolds = rows
    .map((row) => (row === base ? mk(3, 'EARLIER-FOLD-TEXT') : row))
    .concat([mk(7, 'LATEST-FOLD-TEXT')]);

  const dto = project([inputRow(), ...toTranscriptRows(rowsWithTwoFolds)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.ok(folded, 'DTO 必须带 folded');
  assert.equal(folded.summaryText, 'LATEST-FOLD-TEXT',
    '必须取第 7 轮**自己**那份 foldedFacts：用数组下标/序号当键会在这里错位（round 7 取不到 ⇒ 键缺席）');
});

test('#440-D3 foldedFacts 缺席（旧账本）⇒ summaryText/summarySource/truncated 三个键**都不在**', async () => {
  const { rows, foldRow } = await runRealFoldLlmLedger();
  // 有意的单点变异：把真行上的 `foldedFacts` 摘掉（= 0.29 之前落盘的折叠行）。
  const withoutFacts = rows.map((row) => {
    if (row !== foldRow) return row;
    const { foldedFacts, ...rest } = row;
    return rest;
  });
  assert.equal(withoutFacts.find((row) => row.folded === true)?.foldedFacts, undefined, '夹具自证：键已摘掉');

  const dto = project([inputRow(), ...toTranscriptRows(withoutFacts)]);
  const folded = dto.find((message) => message.role === 'assistant')?.folded;
  assert.ok(folded, '折叠行本身还在 ⇒ folded 照旧出现（#189 的四项判据没被 #440 动过）');
  for (const key of ['summaryText', 'summarySource', 'truncated']) {
    assert.ok(!Object.hasOwn(folded, key),
      `\`foldedFacts\` 缺席时 DTO 不许出现 \`${key}\`（不是 null、不是 false、不是空串——`
      + '键缺席 = 不知道 = 前端保持现状，#390-A 那条纪律同样适用）');
  }
  // 反向对照：`hasSummary` 仍然由 `record.summary` 决定，与 `foldedFacts` 在不在无关。
  assert.equal(folded.hasSummary, false, 'hasSummary 与 foldedFacts 无关（它只读 record.summary）');
});
