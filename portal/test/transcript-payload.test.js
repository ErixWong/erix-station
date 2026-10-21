// issue #333：本站 payload 指纹与**上游真件**逐字对拍。
//
// 为什么要对拍：`portal/src/transcript-payload.js` 的头注释声称「与上游口径逐字对齐、漂移即红」。
// 上游那份判据（`erix-agent/src/store/transcript-dedup.js`）**不在包的 exports 面里**
// （只有 `.` / `./tools` / `./contract-tests`），所以只能按**文件路径** import 发布物里的实体文件。
// 这条 import 本身就是 tripwire：上游挪走/改名那个文件 ⇒ 本文件报错，提示重新核对口径；
// 上游改了指纹算法（比如把嵌套 `ts` 也排除掉）⇒ 下面的对拍表红，而不是两把尺各自漂移。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEDUP_CONFLICT_CODE,
  PAYLOAD_VOLATILE_FIELDS,
  payloadFingerprint,
  differingTopLevelFields,
  transcriptRecordKey,
} from '../src/transcript-payload.js';

const UPSTREAM_PATH = new URL(
  '../../node_modules/erix-agent/src/store/transcript-dedup.js',
  import.meta.url,
);
let upstream;
try {
  upstream = await import(UPSTREAM_PATH);
} catch (err) {
  assert.fail(`拿不到上游判据件 ${UPSTREAM_PATH.pathname}（${err.message}）`
    + ' —— 上游可能挪动/改名了 src/store/transcript-dedup.js，请重新核对本站自实现是否还该存在');
}

const RUN_ID = 'run-1';

/** 逐条 fixture：两侧指纹必须逐字相同；`expectSame` 说明这一对是否算同一份 payload。 */
const PAIRS = [
  {
    name: '字段顺序不同不是差异',
    a: { dedupKey: 'k1', round: 3, ts: 'T', messages: [{ role: 'user', content: 'hi' }] },
    b: { messages: [{ role: 'user', content: 'hi' }], ts: 'T', round: 3, dedupKey: 'k1' },
    expectSame: true,
  },
  {
    name: '崩溃重跑：顶层 ts 漂了仍判同一份',
    a: { dedupKey: 'k1', round: 3, ts: '2026-10-21T00:00:00.000Z', messages: [{ role: 'user', content: 'hi' }] },
    b: { dedupKey: 'k1', round: 3, ts: '2026-10-21T00:09:59.999Z', messages: [{ role: 'user', content: 'hi' }] },
    expectSame: true,
  },
  {
    name: '崩溃重跑：顶层 round 漂了仍判同一份',
    a: { dedupKey: 'k1', round: 3, ts: 'T', messages: [] },
    b: { dedupKey: 'k1', round: 9, ts: 'T', messages: [] },
    expectSame: true,
  },
  {
    name: 'dedupKey / roundKey 就是 key 本身，不进 payload',
    a: { dedupKey: 'k1', roundKey: 'r1', round: 1, ts: 'T', messages: [] },
    b: { dedupKey: 'k2', roundKey: 'r2', round: 1, ts: 'T', messages: [] },
    expectSame: true,
  },
  {
    name: '嵌套层的 ts 算内容（只剥顶层）',
    a: { dedupKey: 'k1', round: 1, ts: 'T', messages: [{ role: 'user', ts: 'inner-1' }] },
    b: { dedupKey: 'k1', round: 1, ts: 'T', messages: [{ role: 'user', ts: 'inner-2' }] },
    expectSame: false,
  },
  {
    name: '数组顺序是语义',
    a: { dedupKey: 'k1', round: 1, ts: 'T', messages: [{ c: 'a' }, { c: 'b' }] },
    b: { dedupKey: 'k1', round: 1, ts: 'T', messages: [{ c: 'b' }, { c: 'a' }] },
    expectSame: false,
  },
  {
    name: '宿主自有未知字段算 payload',
    a: { dedupKey: 'k1', round: 1, ts: 'T', messages: [], stationMeta: { a: 1 } },
    b: { dedupKey: 'k1', round: 1, ts: 'T', messages: [] },
    expectSame: false,
  },
  {
    name: '嵌套对象键顺序不同不是差异',
    a: { dedupKey: 'k1', round: 1, ts: 'T', usage: { input_tokens: 1, output_tokens: 2 } },
    b: { dedupKey: 'k1', round: 1, ts: 'T', usage: { output_tokens: 2, input_tokens: 1 } },
    expectSame: true,
  },
  {
    name: 'NaN / Infinity 与 null 的取舍两侧一致（JSON.stringify 同取舍）',
    a: { dedupKey: 'k1', round: 1, ts: 'T', usage: { input_tokens: NaN } },
    b: { dedupKey: 'k1', round: 1, ts: 'T', usage: { input_tokens: null } },
    expectSame: true,
  },
  {
    name: '对象成员里的 undefined / 函数被丢弃，两侧一致',
    a: { dedupKey: 'k1', round: 1, ts: 'T', f: () => 0, g: undefined },
    b: { dedupKey: 'k1', round: 1, ts: 'T' },
    expectSame: true,
  },
  {
    name: '有 toJSON() 的先走 toJSON，两侧一致',
    a: { dedupKey: 'k1', round: 1, ts: 'T', m: { toJSON: () => ({ x: 1 }) } },
    b: { dedupKey: 'k1', round: 1, ts: 'T', m: { x: 1 } },
    expectSame: true,
  },
];

test('#333 对拍常量面：冲突码与易变键表与上游同值', () => {
  assert.equal(DEDUP_CONFLICT_CODE, upstream.DEDUP_CONFLICT_CODE);
  assert.deepEqual([...PAYLOAD_VOLATILE_FIELDS], [...upstream.PAYLOAD_VOLATILE_FIELDS]);
});

for (const pair of PAIRS) {
  test(`#333 对拍：${pair.name}`, () => {
    const mineA = payloadFingerprint(pair.a);
    const mineB = payloadFingerprint(pair.b);
    const upA = upstream.payloadFingerprint(pair.a);
    const upB = upstream.payloadFingerprint(pair.b);

    // ① 本站与上游逐字相同（不是「都能跑」，是同一个字符串）
    assert.equal(mineA, upA, `A 侧指纹漂移：本站 ${mineA} vs 上游 ${upA}`);
    assert.equal(mineB, upB, `B 侧指纹漂移：本站 ${mineB} vs 上游 ${upB}`);
    // ② 判定结果与期望一致
    assert.equal(mineA === mineB, pair.expectSame, `本站判定错：${pair.name}`);
    assert.equal(upA === upB, pair.expectSame, `上游判定与 fixture 期望不符（fixture 该随上游更新）`);
    // ③ 摘要形状：`sha256:` + 24 hex（上游 message 里带它，运维会拿它 grep）
    assert.match(mineA, /^sha256:[0-9a-f]{24}$/);
  });
}

test('#333 对拍：循环引用与非对象 record 两侧都不抛且同结果', () => {
  const cycA = { dedupKey: 'k1', round: 1, ts: 'T' };
  cycA.self = cycA;
  const cycB = { dedupKey: 'k1', round: 1, ts: 'T' };
  cycB.self = cycB;
  assert.equal(payloadFingerprint(cycA), payloadFingerprint(cycB));
  assert.equal(payloadFingerprint(cycA), upstream.payloadFingerprint(cycB));

  for (const v of [null, undefined, 'text', 7, true, ['a', 1]]) {
    assert.equal(payloadFingerprint(v), upstream.payloadFingerprint(v), `非对象叶子漂移：${String(v)}`);
  }
});

test('#333 对拍：差异顶层字段名两侧同式（ts/round/dedupKey/roundKey 不算差异）', () => {
  const a = { dedupKey: 'k1', roundKey: 'r1', round: 1, ts: 'T', messages: [{ c: 'a' }] };
  const b = { dedupKey: 'k2', roundKey: 'r2', round: 5, ts: 'T2', messages: [{ c: 'b' }] };
  assert.deepEqual(differingTopLevelFields(a, b), upstream.differingTopLevelFields(a, b));
  assert.deepEqual(differingTopLevelFields(a, b), ['messages']);
});

test('#333 对拍：去重键推导同式（dedupKey 优先 → roundKey 回退 → 隐式 <runId>:round:<n>）', () => {
  const cases = [
    { dedupKey: 'explicit', roundKey: 'rk', round: 2 },
    { roundKey: 'rk', round: 2 },
    { round: 2 },
    { dedupKey: null, roundKey: null, round: 0 },
  ];
  for (const record of cases) {
    assert.equal(
      transcriptRecordKey(RUN_ID, record),
      upstream.recordKey(RUN_ID, record),
      `recordKey 漂移：${JSON.stringify(record)}`,
    );
  }
  // 隐式键的形状本身也钉住（引擎 resume 靠它重建现场）
  assert.equal(transcriptRecordKey(RUN_ID, { round: 2 }), `${RUN_ID}:round:2`);
});
