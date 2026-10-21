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
