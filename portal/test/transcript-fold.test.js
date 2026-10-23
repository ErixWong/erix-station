// issue #337 切片 A+B：`portal/src/transcript-fold.js` 与**上游真件**逐字段对拍（+ 折叠口径的行为钉）。
//
// 为什么对拍：本站那份折叠是「与上游同源的单一条尺」（先例 `portal/test/transcript-payload.test.js`）。
// 上游实现 `foldMessageRows` 在 `erix-agent/src/store/message-rows.js`，**不在包的 exports 面**里
// （只有 `.` / `./tools` / `./contract-tests`）⇒ 只能按**文件路径** import 发布物里的实体文件。
// 这条 import 本身就是 tripwire：上游挪走/改名那个文件 ⇒ 本文件报错，提示重新核对口径；
// 上游改了折叠口径（比如载体正则、`partOf` 合并规则、无载体时丢分片）⇒ 下面的对拍表红，
// 而不是两把尺各自漂移。
//
// ⚠ **对拍必须显式传 `keyOf`**：站内 record 带 `dedupKey`，而本站 `foldLedgerRecords` 的 `keyOf`
// 有缺省值——一旦缺省口径漂了（比如退化成 `round:<n>`），两边都认不出载体、整表对拍会变成
// 「两份原样返回」的假绿。这里每条 fixture 都传显式 `keyOf`，缺省值另有单独用例钉住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { foldLedgerRecords, isFoldableMessageRow, MESSAGE_ROW_KIND } from '../src/transcript-fold.js';

const UPSTREAM_PATH = new URL('../../node_modules/erix-agent/src/store/message-rows.js', import.meta.url);
let upstream;
try {
  upstream = await import(UPSTREAM_PATH);
} catch (err) {
  assert.fail(`拿不到上游折叠件 ${UPSTREAM_PATH.pathname}（${err.message}）`
    + ' —— 上游可能挪动/改名了 src/store/message-rows.js，请重新核对本站自实现是否还该存在');
}
const { foldMessageRows } = upstream;

const KEY = 'sess-1';
const keyOf = (record) => record?.dedupKey ?? record?.roundKey ?? '';
const clone = (value) => structuredClone(value);

/** 消息行（引擎写侧形状）：`<key>:msg:<round>:<seq>`。 */
const msg = (round, seq, messages, extra = {}) => ({
  dedupKey: `${KEY}:msg:${round}:${seq}`,
  round,
  kind: MESSAGE_ROW_KIND,
  seq,
  messages,
  ...extra,
});
/** 轮行（载体）：`<key>:engine:round:<n>`；0.23 起**不带** `messages`。 */
const carrier = (round, extra = {}) => ({
  dedupKey: `${KEY}:engine:round:${round}`,
  round,
  response: { stopReason: 'end_turn' },
  ...extra,
});
const userText = (value) => ({ role: 'user', content: [{ type: 'text', text: value }] });
const asstText = (value) => ({ role: 'assistant', content: [{ type: 'text', text: value }] });
const toolUse = (id, name) => ({ role: 'assistant', content: [{ type: 'tool_use', id, name, input: {} }] });
const toolResult = (id, content, isError = false) => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
});

/**
 * 对拍表。每条的 `expect` 说明这一条在测什么（`foldable` = 参与折叠的消息行数，
 * `kept` = 折叠后数组长度）。**`foldable > 0` 的条目必须真的减少行数**，否则对拍是空转。
 *
 * ⚠ **链式 `partOf` 的夹具故意不在本表里**（见下面 #341 那一组）：本表是「与上游逐字段一致」的对拍，
 * 而上游 `foldMessageRows` 到今天**仍未解链**（erix-agent #415）⇒ 把链式夹具塞进来会让对拍变成
 * 「要么把本站改回错的那一份、要么放宽对拍」。链式口径由 `#341 链式 partOf…` 那组用例独立钉住，
 * 对拍表**保持上游可比的子集**。
 */
const FIXTURES = [
  {
    name: '单工具轮：一条 assistant 正文 + 一条 tool_result，折回轮行',
    foldable: 2,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 0, [toolUse('c1', 'readFile')]),
      msg(1, 1, [toolResult('c1', 'file body')]),
    ],
  },
  {
    name: '一轮多工具：两个 tool_use 在同一 assistant 消息，两个结果各一条消息',
    foldable: 3,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 0, [{ role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'b', name: 'readFile', input: {} },
      ] }]),
      msg(1, 1, [toolResult('a', 'A')]),
      msg(1, 2, [toolResult('b', 'B')]),
    ],
  },
  {
    name: '一结果多片：第二条结果用 partOf 指认第一条，拼回**同一条**消息',
    foldable: 3,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 0, [{ role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'readFile', input: {} },
        { type: 'tool_use', id: 'b', name: 'readFile', input: {} },
      ] }]),
      msg(1, 1, [toolResult('a', 'A')]),
      msg(1, 2, [toolResult('b', 'B')], { partOf: `${KEY}:msg:1:1` }),
    ],
  },
  {
    // 主 agent 自己跑变异（拆掉 `row.messages.length === 1` 守卫）时发现 19 条全绿 ⇒ 真覆盖缺口：
    // **没有任何 fixture 走过这条判别支**（上游 `message-rows.js:137` 有同一个守卫）。
    // 分片行带**两条**消息 ⇒ 不满足单消息条件，**不算分片**，正文照排。补上后同一变异恰 1 条红。
    name: '`partOf` 指认了，但分片行带两条消息：不满足单消息条件 ⇒ 不当分片（上游同一支路）',
    foldable: 3,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 0, [asstText('先读')]),
      msg(1, 1, [toolResult('a', 'A')]),
      msg(1, 2, [toolResult('b', 'B'), toolResult('c', 'C')], { partOf: `${KEY}:msg:1:1` }),
    ],
  },
  {
    name: '控制行（`:control:<slot>`）与 seed 行都在场：控制行不是载体、seed 不是载体',
    foldable: 2,
    kept: 3,
    records: [
      { dedupKey: `${KEY}:engine:round:0:seed`, round: 0, messages: [userText('干活')] },
      carrier(1),
      msg(1, 0, [asstText('想一想')]),
      msg(1, 1, [toolResult('x', 'ok')]),
      { dedupKey: `${KEY}:engine:round:1:control:judge-nudge`, round: 1, messages: [userText('（评审）继续')] },
    ],
  },
  {
    name: '`:resume` 载体：`<key>:engine:round:<n>:resume` 也算载体',
    foldable: 1,
    kept: 1,
    records: [
      { dedupKey: `${KEY}:engine:round:2:resume`, round: 2, response: { stopReason: 'end_turn' } },
      msg(2, 0, [asstText('续写')]),
    ],
  },
  {
    name: '宿主默认键载体：`<key>:round:<n>` 也是载体',
    foldable: 1,
    kept: 1,
    records: [
      { dedupKey: `${KEY}:round:3`, round: 3 },
      msg(3, 0, [asstText('宿主键轮')]),
    ],
  },
  {
    name: '无消息行旧账本（0.22 形状）：原样透传，连数组引用都不换',
    foldable: 0,
    kept: 3,
    records: [
      { dedupKey: `${KEY}:engine:round:0:seed`, round: 0, messages: [userText('干活')] },
      { dedupKey: `${KEY}:engine:round:1`, round: 1, messages: [asstText('好的'), toolResult('x', 'ok')] },
      { dedupKey: `${KEY}:input:m-1`, round: 0, roundKey: `${KEY}:input:m-1`, messages: [userText('追问')] },
    ],
  },
  {
    name: '只有分片无载体（分页切在轮中间）：分片原样留着，key 与 round 都不动、内容一字不丢',
    foldable: 2,
    kept: 2,
    records: [
      msg(4, 0, [toolResult('a', 'A')]),
      msg(4, 1, [toolResult('b', 'B')], { partOf: `${KEY}:msg:4:0` }),
    ],
  },
  {
    name: 'seq 缺号乱序：按 seq 升序拼，不按落盘序',
    foldable: 3,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 2, [asstText('第三')]),
      msg(1, 0, [asstText('第一')]),
      msg(1, 1, [asstText('第二')]),
    ],
  },
  {
    name: '非整数 seq：`1.5` / 字符串 `"2"` 都不是可折叠行（谓词要求安全整数）',
    foldable: 1,
    kept: 3,
    records: [
      carrier(1),
      msg(1, 0, [asstText('真消息')]),
      msg(1, 1.5, [asstText('小数 seq')]),
      msg(1, '2', [asstText('字符串 seq')]),
    ],
  },
  {
    name: '空 messages：`messages: []` 不是可折叠行（谓词要求非空）',
    foldable: 1,
    kept: 2,
    records: [
      carrier(1),
      msg(1, 0, [asstText('真消息')]),
      msg(1, 1, []),
    ],
  },
  {
    name: '非消息行但带 seq 与 messages（宿主自有行）：`kind` 不是 message ⇒ 不折',
    foldable: 1,
    kept: 2,
    records: [
      carrier(1),
      msg(1, 0, [asstText('真消息')]),
      { dedupKey: `${KEY}:host:note:1`, round: 1, seq: 1, messages: [userText('宿主备注')] },
    ],
  },
  {
    name: '重复 dedupKey：两行同 key 同 seq 都参与折叠（不静默丢一条）',
    foldable: 2,
    kept: 1,
    records: [
      carrier(1),
      msg(1, 0, [asstText('甲')]),
      msg(1, 0, [asstText('乙')]),
    ],
  },
  {
    name: '跨轮多组：两轮各自折回自己的载体',
    foldable: 3,
    kept: 2,
    records: [
      carrier(1),
      msg(1, 0, [asstText('第一轮')]),
      msg(1, 1, [toolResult('a', 'A')]),
      carrier(2),
      msg(2, 0, [asstText('第二轮')]),
    ],
  },
  {
    name: '无 round 的消息行（无法分组）：不折，原样留着',
    foldable: 2,
    kept: 2,
    records: [
      carrier(1),
      msg(1, 0, [asstText('有轮号')]),
      { dedupKey: `${KEY}:msg:?`, kind: MESSAGE_ROW_KIND, seq: 9, messages: [asstText('无轮号')] },
    ],
  },
];

for (const fixture of FIXTURES) {
  test(`#337 折叠与上游逐字段一致：${fixture.name}`, () => {
    const ours = foldLedgerRecords(clone(fixture.records), { keyOf });
    const theirs = foldMessageRows(clone(fixture.records));
    assert.deepEqual(ours, theirs, '本站折叠输出必须与上游 foldMessageRows 逐字段相同');

    // 非空操作自证：这一条真的折了（或真的原样透传），且行数符合预期。
    const foldable = fixture.records.filter((record) => isFoldableMessageRow(record)).length;
    assert.equal(foldable, fixture.foldable, `${fixture.name}：可折叠行计数`);
    assert.equal(ours.length, fixture.kept, `${fixture.name}：折叠后行数`);
  });
}

test('#337 无可折叠行 ⇒ 返回输入本身（同一个数组引用，不是内容相等的副本）', () => {
  const legacy = clone(FIXTURES.find((fixture) => fixture.foldable === 0).records);
  const snapshot = clone(legacy);
  const folded = foldLedgerRecords(legacy, { keyOf });
  assert.equal(folded, legacy, '0.22 账本必须原样透传（`===` 同一引用）：旧账本逐字节不变是硬要求');
  assert.deepEqual(legacy, snapshot, '原样透传不得改写入参');
});

test('#337 非数组入参原样返回（不抛错，不造新数组）', () => {
  for (const value of [undefined, null, 'x', 42]) {
    assert.equal(foldLedgerRecords(value, { keyOf }), value);
  }
});

test('#337 折叠是纯函数：不改写入参行、也不改入参消息对象', () => {
  const records = clone(FIXTURES.find((fixture) => fixture.name.startsWith('一结果多片')).records);
  const snapshot = clone(records);
  const folded = foldLedgerRecords(records, { keyOf });
  assert.deepEqual(records, snapshot, '入参行必须一个字节都不变');
  // 折出来的载体是**新对象**，原载体行没被就地改写。
  assert.notEqual(folded[0], records[0]);
  assert.equal(records[0].messages, undefined, '原载体行仍不带 messages（未被就地写入）');
});

test('#337 `keyOf` 缺省口径 = `dedupKey ?? roundKey`（与上游 rowKey 同式）', () => {
  const records = clone(FIXTURES.find((fixture) => fixture.name.startsWith('单工具轮')).records);
  const byDefault = foldLedgerRecords(clone(records));
  const explicit = foldLedgerRecords(clone(records), { keyOf });
  assert.deepEqual(byDefault, explicit, '缺省 keyOf 必须与显式 keyOf 同结果（否则对拍是假绿）');

  // roundKey-only 的载体（宿主自有行）也必须认得出来。
  const roundKeyOnly = [
    { roundKey: `${KEY}:round:7`, round: 7 },
    { dedupKey: `${KEY}:msg:7:0`, round: 7, kind: MESSAGE_ROW_KIND, seq: 0, messages: [asstText('宿主键')] },
  ];
  const folded = foldLedgerRecords(clone(roundKeyOnly), { keyOf });
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].messages, [asstText('宿主键')]);
});

// ============================================================================
// #341（上游 erix-agent #415）：`partOf` 是**链**不是一跳 —— 分片行自己的 key 也必须登记
// ============================================================================
//
// 0.23 写侧（`erix-agent/src/loop/orchestrator.js`）每落一片就 `toolResultRowKey = persistedRowKey`
// （覆盖）⇒ 第 3 个并行工具调用起，`partOf` 指向的是**前一片分片行**，而不是聚合消息的首片。
// 本站 `planFold` 因此也把分片行的 key 登记进 `parts`（映射到它被接进去的那个同一消息下标）⇒
// 链自然解回链头。下面是这条口径的**行为门**；上游那份仍是错的，故这些用例**不与上游对拍**。

/** 一轮 3 个并行 `tool_use` + 3 条 `tool_result` 分片行（第 3 片指第 2 片 = 链）。 */
function chainRecords(ids) {
  const blocks = ids.map((id) => ({ type: 'tool_use', id, name: 'readFile', input: {} }));
  const rows = [carrier(1), msg(1, 0, [{ role: 'assistant', content: blocks }])];
  let previous = '';
  ids.forEach((id, offset) => {
    const seq = offset + 1;
    rows.push(msg(1, seq, [toolResult(id, id.toUpperCase())], previous === '' ? {} : { partOf: previous }));
    previous = `${KEY}:msg:1:${seq}`;
  });
  return rows;
}

/** 同一条轮内的 0.22 聚合形状（折叠的**目标**：一条 assistant + 一条含 N 个 tool_result 的 user）。 */
function aggregateMessages(ids) {
  return [
    { role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'readFile', input: {} })) },
    { role: 'user', content: ids.map((id) => toolResult(id, id.toUpperCase()).content[0]) },
  ];
}

test('#341 链式 partOf（三分片）⇒ 折回恰好 1 条聚合消息（含 3 个 tool_result）', () => {
  const records = chainRecords(['a', 'b', 'c']);
  // 前置：夹具必须真的是链（第 3 片指第 2 片，而不是指首片）。
  const shards = records.filter((record) => typeof record.partOf === 'string');
  assert.deepEqual(shards.map((record) => record.partOf), [`${KEY}:msg:1:1`, `${KEY}:msg:1:2`],
    '前置条件：第 3 片的 partOf 必须指向前一片（链），否则这条用例测不到解链');

  const folded = foldLedgerRecords(clone(records), { keyOf });
  assert.equal(folded.length, 1, '整轮必须折回**恰好 1 条**记录（载体行）');
  const messages = folded[0].messages;
  assert.equal(messages.length, 2, '折叠后必须是 2 条消息（1 assistant + 1 聚合 tool_result），'
    + `实际 ${messages.length} 条：${JSON.stringify(messages.map((message) => message.role))}`);
  const aggregate = messages[1];
  assert.equal(aggregate.role, 'user');
  assert.equal(aggregate.content.length, 3, '聚合消息必须含 3 个 tool_result block');
  assert.deepEqual(aggregate.content.map((block) => block.tool_use_id), ['a', 'b', 'c'], '分片顺序按 seq');
  // 与 0.22 那条聚合消息**逐字段相等**（引擎 `validateMessages` 要求的形状）。
  assert.deepEqual(messages, aggregateMessages(['a', 'b', 'c']),
    '折叠结果必须与 0.22 的聚合消息逐字段相等（否则 resume 会 invalid_messages）');
});

test('#341 链长 3（四分片）：链上任意一跳都能解回链头', () => {
  const folded = foldLedgerRecords(clone(chainRecords(['a', 'b', 'c', 'd'])), { keyOf });
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].messages, aggregateMessages(['a', 'b', 'c', 'd']));
});

test('#341 无链夹具输出与改前逐字节相同（sha256 快照）', () => {
  // 快照取自**改动前**的实现（`2970391` 的 `portal/src/transcript-fold.js`），逐条 `JSON.stringify`
  // 后 sha256。它是「解链这步只影响链」的**反向判据**：无链夹具里没有任何行的 key 被后来者
  // `partOf` 引用 ⇒ 多登记一个 key 不可能改变输出。
  // 红了怎么办：先确认是不是**故意的口径变更**（那就同步重算快照并在 PR 里说明），否则就是回归。
  const GOLDEN = {
    '单工具轮：一条 assistant 正文 + 一条 tool_result，折回轮行': '9512c48013c40dab77518dbf0d9497fdedd4660444b519b7d52487e4027401eb',
    '一轮多工具：两个 tool_use 在同一 assistant 消息，两个结果各一条消息': '4231053b011ad9f094c32d5322a9ff98b784bb06d3435b376b693efc05db1ca2',
    '一结果多片：第二条结果用 partOf 指认第一条，拼回**同一条**消息': '77482789d169e9b715b4e30962f06501c2aca67c1645060ff503c3880ed67759',
    '`partOf` 指认了，但分片行带两条消息：不满足单消息条件 ⇒ 不当分片（上游同一支路）': 'accb1fbb091feeef7363b4c283994c4ad9cb3a0b2d38d3814debac125b785f3b',
    '控制行（`:control:<slot>`）与 seed 行都在场：控制行不是载体、seed 不是载体': '698a3352254d38b8ed1056b0cd92b0500bc6105307e5d05b7d9763e20ce3d48a',
    '`:resume` 载体：`<key>:engine:round:<n>:resume` 也算载体': '1cf6cb65aa02eb3d269a1bb374e81313e76ed2698d4fd5613eabfbc44c0e5843',
    '宿主默认键载体：`<key>:round:<n>` 也是载体': 'a8808d214c0d823193ec9a9cff5d42c57a42c2a7de205783ed562ea784b3d377',
    '无消息行旧账本（0.22 形状）：原样透传，连数组引用都不换': '8641ad9d7ace6d1c543624baf953909540180b45a823e53c80ebc39af8d3e6d0',
    '只有分片无载体（分页切在轮中间）：分片原样留着，key 与 round 都不动、内容一字不丢': '26882a5a6e17c35eac506f45798a74a7c6fd95f0e6ec6a2170f10db64ed392f1',
    'seq 缺号乱序：按 seq 升序拼，不按落盘序': 'fe98379a8a15ac0d6208409e52f5b7d9579180e35ee96266d8f5613f56ae7331',
    '非整数 seq：`1.5` / 字符串 `"2"` 都不是可折叠行（谓词要求安全整数）': '2a8c5b5b0c51f53841decff2c19bc71bde44d5ceac128e0d0dc998352e2ac230',
    '空 messages：`messages: []` 不是可折叠行（谓词要求非空）': 'c42f83bd5a59f7655cc1042280e5f30622d1c6dc1d46bca6e8ba934e8d578108',
    '非消息行但带 seq 与 messages（宿主自有行）：`kind` 不是 message ⇒ 不折': 'd1f1755e38708987b8bbfa9f6fc854b1c159e45f0a7e23941609b981411545eb',
    '重复 dedupKey：两行同 key 同 seq 都参与折叠（不静默丢一条）': '013d1623585b9d36e4c62878c54d16dd56a3850050d9d5722f4d41bcd77b02c2',
    '跨轮多组：两轮各自折回自己的载体': '023c1ddaaad8ebe0ce9588c11dcf9a86756ca6a8deef2283d1c176b5e94fa52a',
    '无 round 的消息行（无法分组）：不折，原样留着': '20a8380036986c55c42a74e1cb7a9868b05cbab690d994f11205f54c9680e002',
  };
  assert.equal(Object.keys(GOLDEN).length, FIXTURES.length, '快照必须覆盖对拍表每一条（否则本条空转）');
  for (const fixture of FIXTURES) {
    const actual = createHash('sha256')
      .update(JSON.stringify(foldLedgerRecords(clone(fixture.records), { keyOf })))
      .digest('hex');
    assert.equal(actual, GOLDEN[fixture.name],
      `「${fixture.name}」折叠输出字节变了（改前快照不符）。实际输出=${JSON.stringify(foldLedgerRecords(clone(fixture.records), { keyOf }))}`);
  }
});

test('#341 源码级哨兵：上游 message-rows.js 仍未在分片分支登记 key（红了不是回归，是提示撤闸）', () => {
  // ⚠ **红了不是回归，是提示撤闸**：上游 erix-agent #415 修好（把 `parts.set` 挪到 `continue` 之前）
  // 并升 pin 之后，本站 `planFold` 里那行「分片行也登记 key」就是多余的一份 ⇒ 按 `transcript-fold.js`
  // 文件头的撤闸说明整体撤掉，并把本条哨兵按当时的真件重写（先例：§8.28 撤 #283 计时闸）。
  const source = fs.readFileSync(UPSTREAM_PATH, 'utf8');
  assert.ok(source.includes('export function foldMessageRows'), '上游仍应有 foldMessageRows（否则折叠口径整体重核）');
  const branchStart = source.indexOf('if (partTargetIndex >= 0 && row.messages.length === 1) {');
  assert.ok(branchStart >= 0,
    '上游分片分支的形状变了（找不到 `if (partTargetIndex >= 0 && row.messages.length === 1) {`）'
    + ' ⇒ 请重新核对上游折叠口径，并据此决定本闸是否该撤');
  const branchEnd = source.indexOf('continue;', branchStart);
  assert.ok(branchEnd > branchStart, '上游分片分支应仍以 `continue;` 结束');
  const branchBody = source.slice(branchStart, branchEnd);
  assert.doesNotMatch(branchBody, /parts\.set\s*\(/,
    '上游已在分片分支登记 key ⇒ #415 已落地：本站的解链闸该撤了（删 planFold 里那行 parts.set + 文件头注释）');
  // 非空操作自证：上游整个折叠函数里 `parts.set` 仍**恰好一处**（在分片分支之外）。
  const foldStart = source.indexOf('export function foldMessageRows');
  const foldBody = source.slice(foldStart);
  assert.equal(foldBody.match(/parts\.set\s*\(/g)?.length, 1,
    '上游 `foldMessageRows` 里 `parts.set` 应恰好一处；数量变了说明口径已动，请重核本闸');
});
