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

import { projectSessionMessages } from '../src/session-view.js';

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
    initialUserMessage: '读文件',
    completion: false,
    tools: TOOLS,
    executeTool: async ({ input }) => {
      if (input.path === 'missing.txt') throw new Error('ENOENT: no such file');
      return 'file body line1\nline2';
    },
    maxRounds: 4,
    store: makeStore(records),
    runId: SESSION_ID,
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
