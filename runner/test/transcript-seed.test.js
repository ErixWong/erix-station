// P3 PR②a：portal POST 事务内落盘后，worker 只决定 resume 或引擎种子路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTranscriptSeed } from '../lib/transcript-seed.js';

const KEY = 'sess-1';
const INPUT_KEY = `${KEY}:input:m1`;

test('已有本条 user 行 → resume，不返回/写入 runner transcript 记录', () => {
  const plan = planTranscriptSeed({
    records: [{ round: 5, dedupKey: INPUT_KEY }],
    transcriptKey: KEY,
    messageId: 'm1',
  });
  assert.deepEqual(plan, { resume: true });
  assert.equal('record' in plan, false);
});

test('空 transcript → 非 resume，由 runToolLoop 全新路径写 round 0 seed', () => {
  assert.deepEqual(
    planTranscriptSeed({ records: [], transcriptKey: KEY, messageId: 'm1' }),
    { resume: false },
  );
});

test('迁移前已发出的 ticket：已有 transcript 但无 :input: 行时沿用存档并 resume', () => {
  assert.deepEqual(
    planTranscriptSeed({
      records: [{ round: 4, dedupKey: `${KEY}:engine:round:4` }],
      transcriptKey: KEY,
      messageId: 'm1',
      legacyResume: false,
    }),
    { resume: true },
  );
});

test('旧 portal ticket 缺少 session/message 下行时，resume 仍以 ticket 标记为准', () => {
  assert.deepEqual(
    planTranscriptSeed({ records: [], transcriptKey: null, messageId: null, legacyResume: false }),
    { resume: false },
  );
  assert.deepEqual(
    planTranscriptSeed({ records: [], transcriptKey: null, messageId: null, legacyResume: true }),
    { resume: true },
  );
});
