// P3 PR②a：portal POST 事务内落盘后，worker 只决定 resume 或引擎种子路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planTranscriptSeed, buildEngineSeedOptions } from '../lib/transcript-seed.js';

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

// ---------------------------------------------------------------------------
// P3 PR③（issue #69 文本注入退役）：引擎种子选项回归
// ---------------------------------------------------------------------------

test('P3 PR③：resume 路径不传 initialMessages/initialUserMessage（对齐上游 repl.js:656 的 ...(resume ? {} : {...})）', () => {
  const opts = buildEngineSeedOptions({ resume: true, task: '继续上一轮' });
  assert.deepEqual(opts, {}, 'resume 时恢复记录即完整上文，种子片段必须为空');
  assert.equal('initialMessages' in opts, false, 'resume 不传 initialMessages');
  assert.equal('initialUserMessage' in opts, false, 'resume 不传 initialUserMessage');
});

test('P3 PR③：空本子只种 initialUserMessage=task，两个分支都永不出现 initialMessages', () => {
  const fresh = buildEngineSeedOptions({ resume: false, task: '把按钮改成品牌色' });
  assert.deepEqual(fresh, { initialUserMessage: '把按钮改成品牌色' });
  assert.equal('initialMessages' in fresh, false, '文本注入已退役：空本子也不注入历史');
  // task 非字符串（旧 ticket 缺字段）→ 空串，绝不注入 undefined
  assert.deepEqual(buildEngineSeedOptions({ resume: false }), { initialUserMessage: '' });
  assert.deepEqual(buildEngineSeedOptions({ resume: undefined, task: 'x' }), { initialUserMessage: 'x' },
    'resume 非严格 true 一律按空本子处理');
});

test('P3 PR③：runner/worker.js 源码不再出现 initialMessages / history 注入', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker.js'), 'utf8');
  assert.ok(!src.includes('initialMessages:'), 'worker 不再直接传 initialMessages');
  assert.ok(!src.includes('msg.history'), 'worker 不再读 RUN_START.history');
  assert.ok(!src.includes("from './lib/history.js'"), 'worker 不再 import 已退役的历史映射模块');
  assert.ok(!fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'history.js')),
    'runner/lib/history.js 已随链路退役');
});
