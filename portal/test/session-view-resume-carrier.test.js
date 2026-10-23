// issue #339：崩溃恢复共存行（同轮 `…:engine:round:<n>` 与 `…:engine:round:<n>:resume`）的**夹具哨兵**。
//
// 背景（§8.38 留下的待查事项，登记为 #339）：0.23 之后一轮 = 多行——载体行 `<key>:engine:round:<n>`（正文已搬
// 进 `:msg:` 行、`messages` 为空）+ 正文行 `<key>:msg:<n>:<seq>`，崩溃恢复还会多写一行
// `<key>:engine:round:<n>:resume`。原判断是「同轮双载体 ⇒ 逐行投影给同一条 `tool_use` 出两张卡（一张有结果
// 一张没有）」。**本文件把复核后的现状钉住**（证据与实测见报告 M1；探针脚本不进仓库）。
//
// 三条判据（工单要求，缺一不可）：
//   ① **0.23 真实形状不产生重复卡片**——「现在是对的」的正向钉。⚠ 这条将来若变红，**先去看上游
//      `node_modules/erix-agent/src/loop/orchestrator.js` 写 `:resume` 行的那一处**
//      （0.23.0 是 `messages: cloneState(resumeEngineText)`，`resumeEngineText` 只收方向提示 / 达成 advisory
//      两种**引擎控制文本**、不含任何 `tool_use`）。上游一旦开始往 `:resume` 行里塞 `toolUses`，卡片就会翻倍
//      （下面 `:resume 行塞 tool_use` 那条用例正是那个形状的可执行模型）⇒ 该文件红 = 上游写侧形状变了。
//   ② **形状 A（0.22 假设形状）的实际行为按实测原样钉住**：同轮两个候选行**都带同一条 `tool_use`** 时，
//      逐行投影确实给 **2 张卡**（`call_id` 相同、视图 key 也相同；A2 就是工单原话的「一张有结果一张没有」）。
//      ⚠ 这是**已知退化面**的哨兵，**不是待修缺陷**：写侧目前产生不出这个形状（0.22 的 `resume-manager.js`
//      有同轮互斥守卫；0.23 的 `:resume` 只写控制文本）。本片零产品代码 ⇒ 不去「修」它，也不许拿它当回归。
//   ③ **载体选择口径**：同轮存在多个候选行时，折叠取的是**按行序第一个**载体（生产行序 = SQL 的
//      `ORDER BY round, append_seq`；`projectSessionMessages` 内部再用 `compareTranscriptRows`
//      的 `(round, created_at)` 稳定重排，两者一致时即 append_seq 序的第一个）。折叠/投影两侧都钉。
//
// 纪律（照工单与 AGENTS §8.24）：
//   · **判据一律不按 `run_id` 分组**：session 作用域行的 `run_id` 恒 **NULL**（迁移 0015，`putSessionRound`
//     写 `VALUES (NULL, …)`），按它分组会把不相关的行判成同组 ⇒ 假绿。本文件所有夹具行 `run_id: null`，
//     并且**显式钉住「分组键是 round 不是 run_id」**（第 9 条用例）。
//   · 全部经真 `projectSessionMessages`（`session-view.js` 的咽喉点），不手搓投影。
import test from 'node:test';
import assert from 'node:assert/strict';

import { compareTranscriptRows, projectSessionMessages, recordForProjection } from '../src/session-view.js';
import { foldTranscriptRows } from '../src/transcript-fold.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';
const RUN_ID = '20000000-0000-4000-8000-000000000001';
const USER_MSG = '30000000-0000-4000-8000-000000000001';
const ASSISTANT_MSG = '40000000-0000-4000-8000-000000000001';

const at = (second) => new Date(Date.UTC(2026, 9, 21, 0, 0, second));
const text = (value) => [{ type: 'text', text: value }];

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

/** `transcript_rounds` 行（列形状与 `sessions.js` / `session-text.js` 的 SELECT 一致；`run_id` 恒 NULL）。 */
function row({ round, key, messages, createdAt, appendSeq }) {
  return {
    run_id: null,
    round,
    dedup_key: key,
    created_at: createdAt,
    append_seq: appendSeq,
    record: { round, dedupKey: key, messages },
  };
}

/** 0.23 正文行：`<key>:msg:<round>:<seq>`，带 `kind`/`seq`。 */
function messageRow({ round, seq, messages, createdAt, appendSeq }) {
  const key = `${SESSION_ID}:msg:${round}:${seq}`;
  return {
    run_id: null,
    round,
    dedup_key: key,
    created_at: createdAt,
    append_seq: appendSeq,
    record: { round, dedupKey: key, kind: 'message', seq, messages },
  };
}

/** 宿主 `appendUserTurn` 写的 `:input:` 行（带 messages、不带 kind/seq；投影靠它按 messageId 精确认领）。 */
function inputRow() {
  return row({
    round: 0,
    key: `${SESSION_ID}:input:${USER_MSG}`,
    messages: [{ role: 'user', content: text('读文件') }],
    createdAt: at(0),
    appendSeq: 1,
  });
}

const toolUseMessage = () => ({ role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'readFile', input: { path: 'a.txt' } }] });
const toolResultMessage = () => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file body line1\nline2' }] });
/** 0.23 崩溃恢复写进 `:resume` 行的那一类正文：**只有引擎控制文本**（方向提示 / 达成 advisory），
 *  形状照 `orchestrator.js:3155-3166` 的真件（`role:"user"` + `meta.source:"judge-control"` + 纯 text 块）。 */
const engineControlMessages = () => [{
  role: 'user',
  meta: { source: 'judge-control' },
  content: [{ type: 'text', text: '方向提示：先看 README' }],
}];

/** 收尾轮（round 2）：0.23 形状的载体 + 一条 assistant 正文行。 */
const closingRows = () => [
  row({ round: 2, key: `${SESSION_ID}:engine:round:2`, messages: [], createdAt: at(4), appendSeq: 6 }),
  messageRow({
    round: 2, seq: 0, messages: [{ role: 'assistant', content: text('收工') }], createdAt: at(4), appendSeq: 7,
  }),
];

/**
 * 形状 B（**0.23 真实形状**）：载体行 `messages: []`、正文在 `:msg:` 行、`:resume` 行只有引擎控制文本。
 * `resumeFirst` = 把 `:resume` 行的追加序排到载体行之前（两种真实落盘序都覆盖）。
 */
function shapeB({ resumeFirst = false } = {}) {
  const carrier = row({
    round: 1, key: `${SESSION_ID}:engine:round:1`, messages: [], createdAt: resumeFirst ? at(3) : at(2), appendSeq: resumeFirst ? 3 : 2,
  });
  const resume = row({
    round: 1,
    key: `${SESSION_ID}:engine:round:1:resume`,
    messages: engineControlMessages(),
    createdAt: resumeFirst ? at(2) : at(3),
    appendSeq: resumeFirst ? 2 : 3,
  });
  return [
    inputRow(),
    ...(resumeFirst ? [resume, carrier] : [carrier, resume]),
    messageRow({ round: 1, seq: 0, messages: [toolUseMessage()], createdAt: at(2), appendSeq: 4 }),
    messageRow({ round: 1, seq: 1, messages: [toolResultMessage()], createdAt: at(2), appendSeq: 5 }),
    ...closingRows(),
  ];
}

/** 形状 A（**0.22 假设形状**：同轮两行都自带 `messages`）：两行都带同一条 `tool_use`。
 *  `withResult` = `:resume` 行是否也带那条 `tool_result`（`false` 即 #339 原话的「一张有结果一张没有」）。 */
function shapeA({ withResult = true } = {}) {
  const resumeMessages = [toolUseMessage()];
  if (withResult) resumeMessages.push(toolResultMessage());
  return [
    inputRow(),
    row({
      round: 1,
      key: `${SESSION_ID}:engine:round:1`,
      messages: [toolUseMessage(), toolResultMessage()],
      createdAt: at(2),
      appendSeq: 2,
    }),
    row({
      round: 1, key: `${SESSION_ID}:engine:round:1:resume`, messages: resumeMessages, createdAt: at(3), appendSeq: 3,
    }),
    row({
      round: 2, key: `${SESSION_ID}:engine:round:2`, messages: [{ role: 'assistant', content: text('收工') }], createdAt: at(4), appendSeq: 4,
    }),
  ];
}

const assistantOf = (dto) => dto.find((message) => message.role === 'assistant');

// ─────────────────────────────────────────────────────────────────────────────
// ① 0.23 真实形状：不产生重复卡片（「现在是对的」的正向钉）
// ─────────────────────────────────────────────────────────────────────────────
test('#339 0.23 真实形状（载体空 + :resume 只有控制文本）：同轮双载体不产生重复卡片', () => {
  const dto = project(shapeB());
  const assistant = assistantOf(dto);

  assert.equal(dto.length, 2, '锚点数不变 ⇒ DTO 条数不变');
  assert.equal(assistant.toolCalls.length, 1,
    `同轮双载体下工具卡片必须恰好 1 张，实际 ${assistant.toolCalls.length} 张 —— 变红说明上游开始往 `
    + '`:resume` 行里塞正文，先看 node_modules/erix-agent/src/loop/orchestrator.js 写 `:resume` 的那处');
  assert.equal(assistant.toolCalls[0].id, 'c1');
  assert.match(String(assistant.toolCalls[0].resultPreview), /^file body line1/,
    '唯一那张卡必须带着工具结果（不许退化成 `…`）');
  assert.equal(assistant.toolCalls[0].isError, undefined, '成功那条不写 isError 键');
  assert.equal(assistant.content, '收工', '助手终稿仍是最后一段正文（不重复、不拼接）');
  assert.equal(dto.find((message) => message.role === 'user').content, '读文件',
    '用户输入仍按 messageId 精确认领（`:resume` 行的控制文本不许抢认锚点）');
  assert.ok(
    !dto.some((message) => typeof message.content === 'string' && message.content.includes('方向提示')),
    '引擎控制文本不许漏进对话流',
  );

  // 唯一性判据：按 `(round, call_id)` 与视图 key 各算一遍（**不按 `run_id` 分组** —— 生产行 run_id 恒 NULL）。
  assert.equal(new Set(assistant.toolCalls.map((call) => call.id)).size, 1, '`(round, call_id)` 唯一');
  assert.equal(new Set(assistant.toolCalls.map((call) => call.key)).size, 1, '投影视图 key 唯一');
});

test('#339 0.23 真实形状：`:resume` 先落盘（追加序在载体之前）同样只有 1 张卡', () => {
  // 生产上两种落盘序都可能（崩溃轮的轮行可能晚于 resume 行落盘）。载体选择会跟着换，但卡片数不许变。
  const dto = project(shapeB({ resumeFirst: true }));
  const assistant = assistantOf(dto);
  assert.equal(assistant.toolCalls.length, 1, '换落盘序不许把卡片变成 2 张');
  assert.equal(assistant.toolCalls[0].id, 'c1');
  assert.match(String(assistant.toolCalls[0].resultPreview), /^file body line1/, '结果仍必须配上对');
  assert.equal(assistant.content, '收工');
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 形状 A（0.22 假设形状）：按 M1 实测原样钉住 —— 已知退化面，不是待修缺陷
// ─────────────────────────────────────────────────────────────────────────────
test('#339 形状 A（两行都带同一条 tool_use）：实测出 2 张同 id 同 key 的卡（已知退化面）', () => {
  // ⚠ 这条钉的是**现状**，不是期望：写侧目前产生不出形状 A（0.22 互斥 / 0.23 只写控制文本）。
  // 它存在的意义是「上游写侧一旦放宽，后果是什么」有可执行答案（2 张卡、视图 key 也撞车）。
  const dto = project(shapeA());
  const assistant = assistantOf(dto);

  assert.equal(assistant.toolCalls.length, 2, '形状 A 实测就是 2 张卡（本片不改产品代码，只钉住）');
  assert.deepEqual(assistant.toolCalls.map((call) => call.id), ['c1', 'c1'],
    '同一个 provider `tool_use.id` 出现两次 —— 卡片身份按 callId 归并的前端也救不回来');
  assert.equal(new Set(assistant.toolCalls.map((call) => call.key)).size, 1,
    '投影视图 key 是位置型（`round#recordIndex:entryIndex:t<i>`），跨行会撞 —— 所以它不能当去重判据');
  assert.equal(assistant.content, '收工');
});

test('#339 形状 A（:resume 行只带 tool_use 不带结果）：一张有结果、一张没有（工单原话的症状）', () => {
  const dto = project(shapeA({ withResult: false }));
  const assistant = assistantOf(dto);
  const calls = assistant.toolCalls;

  assert.equal(calls.length, 2);
  assert.equal(typeof calls[0].resultPreview, 'string', '第一张（轮行那条）有结果');
  assert.equal(calls[1].resultPreview, undefined, '第二张（`:resume` 那条）没有结果 ⇒ 前端退化成 `…`');
  assert.deepEqual(calls.map((call) => call.id), ['c1', 'c1'], '两条的 callId 相同');
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 载体选择口径：每轮取**行序第一个**载体（可执行判据，折叠侧 + 投影侧各钉一遍）
// ─────────────────────────────────────────────────────────────────────────────
test('#339 载体选择：同轮多候选行时取行序第一个载体（正文挂它身上，后一个候选行原样留着）', () => {
  const rows = shapeB();
  const folded = foldTranscriptRows([...rows], { recordOf: (item) => recordForProjection(item).record });

  // 7 行入参 = `:input:` + 两个候选载体 + 两条 `:msg:`（轮 1）+ 收尾轮载体 + 一条 `:msg:`（轮 2）。
  // 折后被吸收的只有 3 条 `:msg:` 正文行 ⇒ 剩 4 行，其余行一条不少。
  assert.equal(folded.length, rows.length - 3, '三条 `:msg:` 正文行被吸收，其余行一条不少');
  const carrier = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1`);
  const resume = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1:resume`);
  assert.ok(carrier && resume, '两个候选行都必须还在（折叠不吞行）');
  assert.deepEqual(carrier.record.messages, [toolUseMessage(), toolResultMessage()],
    '第一个载体接到该轮正文（按 `seq` 升序：tool_use 在前、tool_result 在后）');
  assert.deepEqual(resume.record.messages, engineControlMessages(),
    '第二个候选行原样保留自己的控制文本（不吞、不并、不改写）');
  assert.equal(resume.record.messages.length, 1, '没有被追加正文');

  // 换序：`:resume` 排到前面 ⇒ 它成为载体，第一个候选行退回「空载体」。
  const swapped = shapeB({ resumeFirst: true });
  const foldedSwapped = foldTranscriptRows([...swapped], { recordOf: (item) => recordForProjection(item).record });
  const carrierSwapped = foldedSwapped.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1`);
  const resumeSwapped = foldedSwapped.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1:resume`);
  assert.deepEqual(resumeSwapped.record.messages, [...engineControlMessages(), toolUseMessage(), toolResultMessage()],
    '先落盘的候选行成为载体：自己的控制文本在前、该轮正文按 seq 接在后面');
  assert.deepEqual(carrierSwapped.record.messages, [], '后落盘的候选行保持空载体（正文不挂它身上）');
});

test('#339 载体选择：投影侧看 `toolCalls[].key` 的 entryIndex —— 载体换了，键跟着换', () => {
  // `projectSessionMessages` 逐行调用官方投影 ⇒ `key = <round>#0:<entryIndex>:t<i>`，
  // entryIndex 就是「该轮正文在该行里的第几个 turn」。载体是第一个候选行（自身 messages 为空）⇒ entry 0；
  // 载体换成带一条控制文本的 `:resume` 行 ⇒ 控制文本占 entry 0，正文的 assistant turn 退到 entry 1。
  const first = assistantOf(project(shapeB())).toolCalls;
  const second = assistantOf(project(shapeB({ resumeFirst: true }))).toolCalls;
  assert.deepEqual(first.map((call) => call.key), ['1#0:0:t0'], '载体 = 第一个候选行（空 messages）');
  assert.deepEqual(second.map((call) => call.key), ['1#0:1:t0'], '载体 = `:resume` 行（控制文本占 entry 0）');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// 崩溃轮常态：`:resume` 是**唯一**载体（轮行还没落盘就崩了）—— 不许因此丢卡
// ─────────────────────────────────────────────────────────────────────────────
test('#339 只有 `:resume` 载体（崩溃轮常态）：正文仍折回它，卡片与结果都在', () => {
  const rows = [
    inputRow(),
    row({
      round: 1, key: `${SESSION_ID}:engine:round:1:resume`, messages: engineControlMessages(), createdAt: at(2), appendSeq: 2,
    }),
    messageRow({ round: 1, seq: 0, messages: [toolUseMessage()], createdAt: at(2), appendSeq: 3 }),
    messageRow({ round: 1, seq: 1, messages: [toolResultMessage()], createdAt: at(2), appendSeq: 4 }),
    ...closingRows(),
  ];
  const assistant = assistantOf(project(rows));
  assert.equal(assistant.toolCalls.length, 1);
  assert.equal(assistant.toolCalls[0].id, 'c1');
  assert.match(String(assistant.toolCalls[0].resultPreview), /^file body line1/,
    '崩溃轮的工具结果必须还在（不许因为缺轮行就退化成 `…`）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 底线：载体不在场时**不许静默丢内容**（与上游 `foldMessageRows` 同构）
// ─────────────────────────────────────────────────────────────────────────────
test('#339 无载体（分页切在轮中间 / 崩溃早于轮行）：消息行原样留在数组里，一个字节不改', () => {
  const rows = [
    inputRow(),
    messageRow({ round: 1, seq: 0, messages: [toolUseMessage()], createdAt: at(2), appendSeq: 2 }),
    messageRow({ round: 1, seq: 1, messages: [toolResultMessage()], createdAt: at(2), appendSeq: 3 }),
  ];
  const snapshot = structuredClone(rows);
  const folded = foldTranscriptRows([...rows], { recordOf: (item) => recordForProjection(item).record });

  assert.equal(folded.length, rows.length, '一条都不许少（无载体 ⇒ 消息行各自留在数组里）');
  assert.deepEqual(folded.map((item) => item.dedup_key), rows.map((item) => item.dedup_key),
    '行 key 仍是各自的 `<key>:msg:<n>:<seq>`（不合并、不改名）');
  assert.deepEqual(folded.map((item) => item.round), [0, 1, 1], 'round 也保持各自的值');
  assert.deepEqual(folded.map((item) => item.record.seq), [undefined, 0, 1], '`seq` 保持各自的值（不重编号）');
  assert.deepEqual(rows, snapshot, '折叠是纯函数：入参一个字节都不许被改写');

  // 诚实记录投影侧的现状（本片不改）：这些行会在 `isSessionRound` 守卫处被丢弃 ⇒ 该轮不出卡。
  // 底线的措辞因此是「不丢内容」而不是「一定能出卡」（正文仍在库里，翻到带载体的那一页就能折回来）。
  const assistant = assistantOf(project(rows));
  assert.equal(assistant.toolCalls, undefined, '无载体时投影确实出不了卡（既有 #337 已知面，不是本片新增）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 判据纪律：分组键是 `round`，**不是** `run_id`（session 作用域行的 `run_id` 恒 NULL）
// ─────────────────────────────────────────────────────────────────────────────
test('#339 分组键是 round 不是 run_id：run_id 全 NULL 时两轮各自折回自己的载体', () => {
  const rows = [
    inputRow(),
    row({ round: 1, key: `${SESSION_ID}:engine:round:1`, messages: [], createdAt: at(2), appendSeq: 2 }),
    messageRow({ round: 1, seq: 0, messages: [{ role: 'assistant', content: text('第一轮') }], createdAt: at(2), appendSeq: 3 }),
    row({ round: 2, key: `${SESSION_ID}:engine:round:2`, messages: [], createdAt: at(3), appendSeq: 4 }),
    messageRow({ round: 2, seq: 0, messages: [{ role: 'assistant', content: text('第二轮') }], createdAt: at(3), appendSeq: 5 }),
  ];
  assert.ok(rows.every((item) => item.run_id === null), '前置条件：生产形状的 session 行 run_id 恒 NULL');

  const folded = foldTranscriptRows([...rows], { recordOf: (item) => recordForProjection(item).record });
  const first = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1`);
  const second = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:2`);
  assert.deepEqual(first.record.messages, [{ role: 'assistant', content: text('第一轮') }],
    '第一轮只拿到第一轮自己的正文（按 round 分组）');
  assert.deepEqual(second.record.messages, [{ role: 'assistant', content: text('第二轮') }],
    '第二轮只拿到第二轮自己的正文 —— 若按 run_id 分组（全 NULL）两轮会被并成一组，这里就红');
});

// ─────────────────────────────────────────────────────────────────────────────
// 行序的二级键是 `created_at`（不是 `append_seq`）—— 载体的「第一个」按这个序取
// ─────────────────────────────────────────────────────────────────────────────
test('#339 行序二级键是 created_at 不是 append_seq：时钟回拨时载体跟着 created_at 走', () => {
  // 生产读路径的行序由 SQL 的 `ORDER BY round ASC, append_seq ASC` 给出，而 `projectSessionMessages`
  // 内部再用 `compareTranscriptRows`（round → created_at）**稳定**重排。两者一致时「第一个载体」=
  // append_seq 序的第一个；**不一致**（created_at 与 append_seq 相反，例如时钟回拨）时以 created_at 为准。
  // 本用例把后者钉成可执行事实（口径已写进 docs/design/conversation-state.md §6）。
  const rows = [
    inputRow(),
    // append_seq 更小、但 created_at 更晚 ⇒ 排序后落在 `:resume` 之后
    row({
      round: 1, key: `${SESSION_ID}:engine:round:1`, messages: [], createdAt: at(9), appendSeq: 2,
    }),
    // append_seq 更大、但 created_at 更早 ⇒ 排序后是第一个候选
    row({
      round: 1, key: `${SESSION_ID}:engine:round:1:resume`, messages: engineControlMessages(), createdAt: at(2), appendSeq: 3,
    }),
    messageRow({ round: 1, seq: 0, messages: [toolUseMessage()], createdAt: at(9), appendSeq: 4 }),
    messageRow({ round: 1, seq: 1, messages: [toolResultMessage()], createdAt: at(9), appendSeq: 5 }),
    ...closingRows(),
  ];

  // ⚠ `foldTranscriptRows` **自己不排序**：排序是调用方的责任（生产调用方 `projectSessionMessages`
  // 先 `[...transcriptRows].sort(compareTranscriptRows)` 再折）⇒ 这里必须照同一口径先排，否则钉的是
  // 一个生产上不存在的行序。
  const ordered = [...rows].sort(compareTranscriptRows);
  const folded = foldTranscriptRows(ordered, { recordOf: (item) => recordForProjection(item).record });
  const carrier = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1`);
  const resume = folded.find((item) => item.dedup_key === `${SESSION_ID}:engine:round:1:resume`);
  assert.deepEqual(resume.record.messages, [...engineControlMessages(), toolUseMessage(), toolResultMessage()],
    '载体 = created_at 更早的 `:resume` 行（不是 append_seq 更小的轮行）');
  assert.deepEqual(carrier.record.messages, [], 'append_seq 更小但 created_at 更晚的轮行保持空载体');

  // 投影侧同一事实：entryIndex 1（控制文本占 entry 0）⇒ 载体是带控制文本的那一行。
  const calls = assistantOf(project(rows)).toolCalls;
  assert.deepEqual(calls.map((call) => call.key), ['1#0:1:t0']);
  assert.equal(calls.length, 1, '序变了卡片数仍必须是 1 张');
});
