// issue #81 P2：planTranscriptSeed 三分支 + 幂等红线单测（docs/design/conversation-state.md §4.1）。
// ① 空本子 → 不 resume 不预写；② 新消息未入档 → 预写（dedupKey=`<key>:input:<msgId>`，round=latestRound）；
// ③ 消息已入档（含崩溃重跑两种来源）→ 直接 resume 不重复写（绝不产生重复 user 消息）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { planTranscriptSeed } from '../lib/transcript-seed.js';

const KEY = 'sess-1';
const TASK = '把 server.js 的端口改成 4008';
const userMsg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const engineRound = (n, extra = '') => ({
  round: n, dedupKey: `${KEY}:engine:round:${n}${extra}`, messages: [{ role: 'assistant', content: [{ type: 'text', text: `a${n}` }] }],
});
const seedRecord = (task) => ({
  round: 0, dedupKey: `${KEY}:engine:round:0:seed`, summary: 'missing', messages: [userMsg(task)],
});

test('分支①：空本子（会话首条）→ resume=false、不预写（initialUserMessage 全新路径）', () => {
  const plan = planTranscriptSeed({ records: [], transcriptKey: KEY, messageId: 'm1', attempt: 1, task: TASK });
  assert.equal(plan.resume, false);
  assert.equal(plan.record, null);
});

test('分支②：正常下一轮（有历史、新消息未入档）→ 预写 round=latestRound + resume=true', () => {
  const records = [seedRecord('第一条'), engineRound(1), { round: 2, dedupKey: `${KEY}:input:m1`, messages: [userMsg('第二条')] }, engineRound(3)];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm2', attempt: 1, task: TASK });
  assert.equal(plan.resume, true);
  assert.equal(plan.record.round, 3, 'round = latestRound（CLI 模式行号复用）');
  assert.equal(plan.record.dedupKey, `${KEY}:input:m2`);
  assert.equal(plan.record.roundKey, plan.record.dedupKey);
  assert.deepEqual(plan.record.messages, [userMsg(TASK)]);
  assert.ok(typeof plan.record.ts === 'string');
});

test('分支③a：崩溃重跑 attempt>1，消息已按宿主 dedupKey 入档 → 直接 resume，不重复写', () => {
  const records = [seedRecord('第一条'), engineRound(1), { round: 1, dedupKey: `${KEY}:input:m2`, messages: [userMsg(TASK)] }];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm2', attempt: 2, task: TASK });
  assert.equal(plan.resume, true);
  assert.equal(plan.record, null, '幂等红线：已入档绝不重复预写');
});

test('分支③b：attempt 1 走空本子后崩溃（引擎种子已含本条消息，宿主 dedupKey 未命中）→ resume 不重复写', () => {
  // attempt 1：transcript 为空 → 全新路径 → 引擎写 round 0 种子（含本条 task）→ 崩溃。
  // attempt 2：档案无宿主 :input: 行，round 0 种子末条 = task → 识别为已入档。
  const records = [seedRecord(TASK), engineRound(1)];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm1', attempt: 2, task: TASK });
  assert.equal(plan.resume, true);
  assert.equal(plan.record, null, '不得重复预写：resume 后 user 消息会出现两次');
});

test('分支②b：上一轮正常完成（档案有宿主行），attempt>1 崩在预写前 → 必须补预写（消息不丢）', () => {
  const records = [seedRecord('第一条'), engineRound(1), { round: 1, dedupKey: `${KEY}:input:m1`, messages: [userMsg('第一条')] }, engineRound(2)];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm2', attempt: 2, task: TASK });
  assert.equal(plan.resume, true);
  assert.ok(plan.record, '档案有宿主行 → 属「崩在预写前」，必须补预写');
  assert.equal(plan.record.dedupKey, `${KEY}:input:m2`);
  assert.equal(plan.record.round, 2, 'round = latestRound');
});

test('分支②c：attempt 1 崩在预写前（无宿主行但种子末条 ≠ task，即上一轮的消息）→ 补预写', () => {
  // 会话上一轮（run R1）空本子后 max attempts 耗尽：档案 = R1 引擎种子（task 是 R1 的，非本条）。
  const records = [seedRecord('R1 的任务'), engineRound(1)];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm9', attempt: 1, task: TASK });
  assert.equal(plan.resume, true);
  assert.ok(plan.record);
  assert.equal(plan.record.dedupKey, `${KEY}:input:m9`);
});

test('幂等红线：同一条消息重放任意次，至多一次预写（dedupKey 命中后不再写）', () => {
  const prewritten = { round: 2, dedupKey: `${KEY}:input:m5`, messages: [userMsg(TASK)] };
  for (const attempt of [1, 2, 3]) {
    const plan = planTranscriptSeed({
      records: [seedRecord('第一条'), engineRound(1), prewritten, engineRound(2)],
      transcriptKey: KEY, messageId: 'm5', attempt, task: TASK,
    });
    assert.equal(plan.resume, true);
    assert.equal(plan.record, null);
  }
});

test('seed 末条文本比对：history 里同文 user 消息不误判（只认 round 0 种子末条）', () => {
  // 历史注入的种子 = [...history, user(task)]；若 history 末条恰与 task 同文，种子里 task 仍最后。
  const historyTail = userMsg(TASK);
  const records = [{
    round: 0, dedupKey: `${KEY}:engine:round:0:seed`, summary: 'missing',
    messages: [userMsg(' earlier '), historyTail, userMsg(TASK)],
  }, engineRound(1)];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm1', attempt: 2, task: TASK });
  assert.equal(plan.record, null, '种子末条 = task → 已入档');
});

test('旧链路回退：无 session/message 下行 → 不预写，resume 以 ticket 为准（向后兼容旧 portal）', () => {
  assert.deepEqual(
    planTranscriptSeed({ records: [], transcriptKey: null, messageId: null, attempt: 1, task: TASK, legacyResume: false }),
    { resume: false, record: null },
  );
  assert.deepEqual(
    planTranscriptSeed({ records: [], transcriptKey: null, messageId: null, attempt: 2, task: TASK, legacyResume: true }),
    { resume: true, record: null },
  );
});

test('latestRound 计算：忽略非法 round 值，空档案/全零保底 0', () => {
  const records = [
    { round: 'x', dedupKey: `${KEY}:engine:round:0:seed` },
    { round: 5, dedupKey: `${KEY}:engine:round:5` },
    { round: null, dedupKey: `${KEY}:engine:round:null` },
  ];
  const plan = planTranscriptSeed({ records, transcriptKey: KEY, messageId: 'm1', attempt: 1, task: TASK });
  assert.equal(plan.record.round, 5);
});
