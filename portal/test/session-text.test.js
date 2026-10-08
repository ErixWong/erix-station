// 单测：portal/src/session-text.js —— transcript 投影取文本的共享读取层（P3 PR②b B1）。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchInputTextByMessageId,
  fetchUserTextTurns,
  fetchRunAssistantText,
  fetchConversationTurns,
} from '../src/session-text.js';
import { createSessionTextHandler, inputTranscriptRow, engineTranscriptRow } from './fake-session-text.js';

const SESSION_ID = '40000000-0000-4000-8000-000000000001';
const RUN_1 = '50000000-0000-4000-8000-000000000001';
const RUN_2 = '50000000-0000-4000-8000-000000000002';

function textPool({ messages = [], transcriptRows = [] } = {}) {
  const handle = createSessionTextHandler({ messages, transcriptRows, sessionId: SESSION_ID });
  const sqls = [];
  return {
    sqls,
    async query(sql, params = []) {
      sqls.push(sql.replace(/\s+/g, ' ').trim());
      const hit = handle(sql, params);
      if (hit) return hit;
      return { rows: [] };
    },
  };
}

const userAnchor = (id, seq, content, runId = RUN_1) => ({
  id, session_id: SESSION_ID, run_id: runId, seq, role: 'user', content, synthetic: false, attachments: [],
});
const assistantAnchor = (id, seq, content, runId = RUN_1) => ({
  id, session_id: SESSION_ID, run_id: runId, seq, role: 'assistant', content, synthetic: false, attachments: [],
});

test('fetchInputTextByMessageId：命中 :input:<messageId> 行取投影正文；未命中返回 null', async () => {
  const pool = textPool({
    messages: [userAnchor('m1', 1, '锚点正文')],
    transcriptRows: [inputTranscriptRow({ sessionId: SESSION_ID, messageId: 'm1', text: 'transcript 正文' })],
  });
  assert.equal(await fetchInputTextByMessageId(pool, { sessionId: SESSION_ID, messageId: 'm1' }), 'transcript 正文');
  assert.equal(await fetchInputTextByMessageId(pool, { sessionId: SESSION_ID, messageId: 'missing' }), null);
  assert.equal(await fetchInputTextByMessageId(pool, { sessionId: SESSION_ID, messageId: '' }), null, '缺 messageId 不发查询');
  assert.ok(pool.sqls.some((s) => s.includes('dedup_key = $2')), '按 dedupKey 单行精确命中（不整会话读）');
});

test('fetchUserTextTurns：升序 / limit / desc 取最新 N 条，正文来源可判定', async () => {
  const messages = [userAnchor('m1', 1, '锚点1'), userAnchor('m2', 2, '锚点2'), userAnchor('m3', 3, '锚点3')];
  const transcriptRows = [
    inputTranscriptRow({ sessionId: SESSION_ID, messageId: 'm1', text: '正文一', round: 1 }),
    inputTranscriptRow({ sessionId: SESSION_ID, messageId: 'm2', text: '正文二', round: 2 }),
    // m3 无 transcript 行 → legacy 兜底
  ];
  const pool = textPool({ messages, transcriptRows });

  const all = await fetchUserTextTurns(pool, { sessionId: SESSION_ID });
  assert.deepEqual(all.map((t) => [t.seq, t.text, t.source]), [
    [1, '正文一', 'transcript'],
    [2, '正文二', 'transcript'],
    [3, '锚点3', 'legacy'],
  ], '投影有证据取 transcript，无证据才 legacy 回退锚点正文');

  const first2 = await fetchUserTextTurns(pool, { sessionId: SESSION_ID, limit: 2 });
  assert.deepEqual(first2.map((t) => t.text), ['正文一', '正文二'], 'limit 取最早 N 条');

  const last2 = await fetchUserTextTurns(pool, { sessionId: SESSION_ID, limit: 2, desc: true });
  assert.deepEqual(last2.map((t) => t.text), ['正文二', '锚点3'], 'desc 取最新 N 条，返回仍按 seq 升序');
});

test('fetchRunAssistantText：按 run 取 assistant 终态正文；无锚点行返回 null', async () => {
  const pool = textPool({
    messages: [assistantAnchor('a1', 2, '锚点答复', RUN_1), assistantAnchor('a2', 4, '别的 run', RUN_2)],
    transcriptRows: [engineTranscriptRow({ sessionId: SESSION_ID, runId: RUN_1, round: 3, assistantText: 'transcript 答复' })],
  });
  const hit = await fetchRunAssistantText(pool, { sessionId: SESSION_ID, runId: RUN_1 });
  assert.equal(hit.text, 'transcript 答复');
  assert.equal(hit.source, 'transcript');

  const legacy = await fetchRunAssistantText(pool, { sessionId: SESSION_ID, runId: RUN_2 });
  assert.deepEqual([legacy.text, legacy.source], ['别的 run', 'legacy'], '该 run 无 transcript 证据 → legacy 兜底');

  assert.equal(await fetchRunAssistantText(pool, { sessionId: SESSION_ID, runId: 'nope' }), null);
});

test('fetchConversationTurns：排除当前 message、返回升序、正文取 transcript（预算仍归 truncateHistory）', async () => {
  const pool = textPool({
    messages: [
      userAnchor('m1', 1, '锚点问一'),
      assistantAnchor('a1', 2, '锚点答一', RUN_1),
      userAnchor('m2', 3, '当前这条'),
    ],
    transcriptRows: [
      inputTranscriptRow({ sessionId: SESSION_ID, messageId: 'm1', text: 'transcript 问一', round: 1 }),
      engineTranscriptRow({ sessionId: SESSION_ID, runId: RUN_1, round: 2, assistantText: 'transcript 答一' }),
    ],
  });
  const turns = await fetchConversationTurns(pool, { sessionId: SESSION_ID, maxMessages: 20, excludeMessageId: 'm2' });
  assert.deepEqual(turns.map((t) => [t.role, t.content]), [
    ['user', 'transcript 问一'],
    ['assistant', 'transcript 答一'],
  ], '升序 + 排除当前 message');
});

// ---------------------------------------------------------------------------
// P3 PR②b B2：`messages.content` 降级为锚点行（停写正文）后的读侧语义
// ---------------------------------------------------------------------------

test('P3 PR②b B2：新行 content=\'\' → 读侧仍取 transcript；老行（content 有值）走 legacy 兜底', async () => {
  const pool = textPool({
    messages: [
      userAnchor('new-user', 1, ''),            // B2 之后的新行：锚点无正文
      userAnchor('legacy-user', 3, '老行正文'),  // 迁移 0015/B2 之前入档：锚点仍带正文
    ],
    transcriptRows: [inputTranscriptRow({ sessionId: SESSION_ID, messageId: 'new-user', text: '新行正文', round: 1 })],
  });
  const turns = await fetchUserTextTurns(pool, { sessionId: SESSION_ID });
  assert.deepEqual(turns.map((t) => [t.seq, t.text, t.source]), [
    [1, '新行正文', 'transcript'],
    [3, '老行正文', 'legacy'],
  ], '新行不写正文也不掉文本；兜底只对老数据生效');
});

test('P3 PR②b B2：content=\'\' 且投影无证据 → 空串（新行不报错、不回填假正文）', async () => {
  const pool = textPool({ messages: [userAnchor('m-new', 1, '')], transcriptRows: [] });
  const turns = await fetchUserTextTurns(pool, { sessionId: SESSION_ID });
  assert.deepEqual(turns.map((t) => [t.text, t.source]), [['', 'empty']]);
});

test('P3 PR②b B2 前瞻规则：synthetic=true 的注入行必须仍写正文，读侧取锚点自身文本', async () => {
  // judge/wrapup 之类宿主注入行在 transcript 里没有对应轮次，正文只能落在 `messages.content`。
  // 当前无此类写入点（全库 synthetic 恒 false），本用例以构造行钉住这条约束：
  // 写侧将来实现注入时若误写空串，本用例的读侧形状会先给出可诊断的空正文。
  const injected = {
    id: 'judge-1', session_id: SESSION_ID, run_id: RUN_1, seq: 2, role: 'user',
    content: 'judge 方向提示正文', synthetic: true, attachments: [],
  };
  const pool = textPool({ messages: [injected], transcriptRows: [] });

  const turns = await fetchUserTextTurns(pool, { sessionId: SESSION_ID });
  assert.deepEqual(turns.map((t) => [t.text, t.source]), [['judge 方向提示正文', 'anchor']],
    '合成行正文来自锚点自身（不经投影、不算 legacy）');

  const history = await fetchConversationTurns(pool, { sessionId: SESSION_ID, maxMessages: 20, excludeMessageId: 'none' });
  assert.deepEqual(history.map((t) => [t.role, t.content]), [['user', 'judge 方向提示正文']],
    '历史上行同样保留合成行正文');
});
