// portal/src/transcript-store.js 单测：0.15.0 appendUserTurn 的最小 store 适配器。
// 红线断言：
//   ① load/appendRound 全部经**传入的事务 client**（不发到 pool——脱离事务即破坏原子性）；
//   ② 落库列形态与 PR②a 手搓时代逐列等价（run_id NULL / folded false / folded_payload NULL /
//      messages=record.messages 派生 / ON CONFLICT 保留）；
//   ③ 同 messageId 顺序重放 → 引擎幂等判据命中（load 可见既有 dedupKey），不发起第二笔 INSERT；
//   ④ dedup_key 列缺失（理论不该发生）时回退 record 内字段，幂等判据不失效。
// 隔离约定（docs/testing.md §2.1）：内存 fake client，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTranscriptStore, appendUserInputTurn } from '../src/transcript-store.js';

/** 记录 SQL 流水的内存 client；transcriptRows 模拟部分唯一索引 (transcript_key, dedup_key)。 */
function fakeClient(rows = []) {
  const state = { rows, insertAttempts: 0 };
  const order = [];
  const client = {
    async query(sql, params = []) {
      order.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('SELECT round, dedup_key, record')) {
        return { rows: state.rows.filter((r) => r.transcript_key === params[0]) };
      }
      if (s.startsWith('INSERT INTO transcript_rounds')) {
        state.insertAttempts += 1;
        const [transcript_key, dedup_key, round, record, messages] = params;
        if (state.rows.some((r) => r.transcript_key === transcript_key && r.dedup_key === dedup_key)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        state.rows.push({
          transcript_key, dedup_key, round,
          record: JSON.parse(record), messages: JSON.parse(messages),
        });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { client, order, state };
}

const KEY = 'session-uuid-1';

test('load：按 transcript_key 读权威列，round 数值化、dedupKey 取列并回退 record 字段', async () => {
  const { client } = fakeClient([
    { transcript_key: KEY, dedup_key: `${KEY}:input:m1`, round: 2, record: { round: 2, roundKey: `${KEY}:input:m1` } },
    { transcript_key: KEY, dedup_key: null, round: 3, record: { round: 3, dedupKey: `${KEY}:engine:round:3` } },
    { transcript_key: 'other', dedup_key: 'x', round: 9, record: {} },
  ]);
  const records = await createSessionTranscriptStore(client).load(KEY);
  assert.equal(records.length, 2, '只取本 key 的行');
  assert.deepEqual(records.map((r) => r.round), [2, 3], 'round 以列为权威并数值化');
  assert.equal(records[0].dedupKey, `${KEY}:input:m1`);
  assert.equal(records[1].dedupKey, `${KEY}:engine:round:3`, 'dedup_key 列缺失时回退 record.dedupKey');
});

test('appendRound：逐列形态与手搓时代等价（NULL run_id / folded=false / messages 派生 / ON CONFLICT 保留）', async () => {
  const { client, order, state } = fakeClient();
  const record = {
    round: 4,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    dedupKey: `${KEY}:input:m9`,
    roundKey: `${KEY}:input:m9`,
    ts: '2026-10-08T00:00:00.000Z',
  };
  await createSessionTranscriptStore(client).appendRound(KEY, record);
  const insert = order.at(-1);
  const s = insert.sql.replace(/\s+/g, ' ').trim();
  assert.match(s, /INSERT INTO transcript_rounds \(run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload\) VALUES \(NULL, \$1, \$2, \$3, \$4, false, \$5, NULL\)/);
  assert.match(s, /ON CONFLICT \(transcript_key, dedup_key\) WHERE transcript_key IS NOT NULL DO NOTHING/);
  assert.deepEqual(insert.params, [
    KEY, `${KEY}:input:m9`, 4, JSON.stringify(record), JSON.stringify(record.messages),
  ]);
  assert.deepEqual(state.rows[0].messages, record.messages, 'messages 派生列 = record.messages');

  await assert.rejects(
    () => createSessionTranscriptStore(client).appendRound(KEY, { round: 0 }),
    /dedupKey is required/,
  );
});

test('appendUserInputTurn：首轮预写 round=0，落库 dedupKey=<key>:input:<messageId>，record 形态即引擎 RoundRecord', async () => {
  const { client, state } = fakeClient();
  const result = await appendUserInputTurn(client, { key: KEY, text: '你好，引擎', messageId: 'm1' });
  assert.deepEqual(
    { key: result.key, dedupKey: result.dedupKey, round: result.round, written: result.written },
    { key: KEY, dedupKey: `${KEY}:input:m1`, round: 0, written: true },
  );
  assert.deepEqual(state.rows[0].record, {
    round: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: '你好，引擎' }] }],
    dedupKey: `${KEY}:input:m1`,
    roundKey: `${KEY}:input:m1`,
    ts: state.rows[0].record.ts,
  });
  assert.equal(new Date(state.rows[0].record.ts).toISOString(), state.rows[0].record.ts, 'ts 为 ISO-8601 字符串');
});

test('appendUserInputTurn：同 messageId 顺序重放（崩溃重跑）幂等命中，不产生第二笔 INSERT', async () => {
  const { client, state } = fakeClient();
  await appendUserInputTurn(client, { key: KEY, text: '首轮', messageId: 'm1' });
  const second = await appendUserInputTurn(client, { key: KEY, text: '首轮', messageId: 'm1' });
  assert.equal(second.written, false, '幂等判据：load 已见同 dedupKey → written=false 并回带既有 record');
  assert.deepEqual(second.record, state.rows[0].record);
  assert.equal(state.insertAttempts, 1, 'written=false 分支不再发起第二笔 INSERT');
  assert.equal(state.rows.length, 1);
});

test('appendUserInputTurn：round 复用现有最大 round（引擎 resume 续点），空 store 为 0', async () => {
  const { client, state } = fakeClient([
    { transcript_key: KEY, dedup_key: `${KEY}:engine:round:6`, round: 6, record: { round: 6 } },
    { transcript_key: KEY, dedup_key: `${KEY}:input:m1`, round: 2, record: { round: 2 } },
  ]);
  const r1 = await appendUserInputTurn(client, { key: KEY, text: '继续', messageId: 'm2' });
  assert.equal(r1.round, 6, '复用最大 round，不 +1');
  assert.equal(r1.written, true);
  assert.equal(state.rows.at(-1).round, 6);
});

test('appendUserInputTurn：纯空白 text 抛 TypeError（postMessage 的前置校验保证该路径 HTTP 侧不可达）', async () => {
  const { client } = fakeClient();
  await assert.rejects(
    () => appendUserInputTurn(client, { key: KEY, text: ' \n\t ', messageId: 'm1' }),
    (err) => err instanceof TypeError && /non-empty string/.test(err.message),
  );
});
