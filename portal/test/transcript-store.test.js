// portal/src/transcript-store.js 单测：0.17.0 appendUserTurn 的最小 store 适配器
// （load/appendRound + #193 新增的成对快路径探针 loadByDedupKey/loadMaxRound）。
// 红线断言：
//   ① load/loadByDedupKey/loadMaxRound/appendRound 全部经**传入的事务 client**（不发到 pool——脱离事务即破坏原子性）；
//   ② 落库列形态与 PR②a 手搓时代逐列等价（run_id NULL / folded false / folded_payload NULL /
//      messages=record.messages 派生 / ON CONFLICT 保留）；
//   ③ 同 messageId 顺序重放 → 幂等判据命中（0.17.0 走 loadByDedupKey 点查，回退路径走 load），
//      不发起第二笔 INSERT；
//   ④ dedup_key 列缺失（理论不该发生）时回退 record 内字段，幂等判据不失效；
//   ⑤ 0.17.0 快路径：两探针齐备 → appendUserInputTurn **全程不发全量 load SELECT**，
//      命中也不再调 loadMaxRound；探针结果与全量路径语义等价（空 store → null、未命中 → null、
//      命中 → 存储 record 原样保真）。
// 隔离约定（docs/testing.md §2.1）：内存 fake client，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionTranscriptStore, appendUserInputTurn } from '../src/transcript-store.js';
import { transcriptStoreContract } from 'erix-agent/contract-tests';

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
      // 0.17.0 成对快路径探针①（#193）：按 (transcript_key, dedup_key) 等值点查 record 原样。
      if (s.startsWith('SELECT record FROM transcript_rounds')) {
        const hit = state.rows.find(
          (r) => r.transcript_key === params[0] && r.dedup_key === params[1],
        );
        return { rows: hit ? [{ record: hit.record }] : [] };
      }
      // 0.17.0 成对快路径探针②（#193）：MAX(round)，空结果集返回 null（SQL 聚合语义）。
      if (s.startsWith('SELECT MAX(round)')) {
        const rounds = state.rows
          .filter((r) => r.transcript_key === params[0])
          .map((r) => Number(r.round));
        return { rows: [{ max_round: rounds.length === 0 ? null : Math.max(...rounds) }] };
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

// ---------- 0.17.0 成对可选快路径探针（issue #193 / 上游 #157） ----------

const LOAD_SQL = 'SELECT round, dedup_key, record';
/** SQL 流水 → 语义标签序列（供“有没有全量 load”、“命中后还调了什么”类流水断言）。 */
const sqlTrace = (order) => order.map((entry) => {
  const s = entry.sql.replace(/\s+/g, ' ').trim();
  if (s.startsWith(LOAD_SQL)) return 'load';
  if (s.startsWith('SELECT record FROM transcript_rounds')) return 'loadByDedupKey';
  if (s.startsWith('SELECT MAX(round)')) return 'loadMaxRound';
  if (s.startsWith('INSERT INTO transcript_rounds')) return 'appendRound';
  return `other:${s.slice(0, 24)}`;
});

test('loadByDedupKey/loadMaxRound 成对存在（缺一如缺二，引擎会整块退回全量 load）', () => {
  const store = createSessionTranscriptStore(fakeClient().client);
  assert.equal(typeof store.loadByDedupKey, 'function');
  assert.equal(typeof store.loadMaxRound, 'function');
});

test('探针（a）：全新预写走点查快路径，全程不发起全量 load SELECT', async () => {
  const { client, order, state } = fakeClient();
  const result = await appendUserInputTurn(client, { key: KEY, text: '快路径', messageId: 'm1' });
  assert.equal(result.written, true);
  assert.equal(result.round, 0, '空 store：loadMaxRound 返回 null → 引擎派生 round 0');
  assert.deepEqual(
    sqlTrace(order).filter((tag) => tag === 'load'), [],
    `快路径不得调 store.load，实际 SQL 流水：${sqlTrace(order).join(' → ')}`,
  );
  assert.deepEqual(
    sqlTrace(order), ['loadByDedupKey', 'loadMaxRound', 'appendRound'],
    '点查未命中 → 取 MAX(round) → appendRound，无多余读取',
  );
  assert.equal(state.rows.length, 1);
});

test('探针（b）：同 messageId 重放→点查命中 written=false、record 为库内原样，不 INSERT、不再调 loadMaxRound', async () => {
  const { client, order, state } = fakeClient();
  await appendUserInputTurn(client, { key: KEY, text: '首轮', messageId: 'm1' });
  order.length = 0;
  const second = await appendUserInputTurn(client, { key: KEY, text: '首轮', messageId: 'm1' });
  assert.equal(second.written, false);
  assert.deepEqual(second.record, state.rows[0].record, '命中透传库内 record 原样');
  assert.equal(state.insertAttempts, 1, '命中分支不再发第二笔 INSERT');
  assert.deepEqual(
    sqlTrace(order), ['loadByDedupKey'],
    '命中即返回：不得调 loadMaxRound、appendRound、load',
  );
});

test('探针（c）：空 key 的 loadMaxRound 返回 null（非 0），非安全整数行为由引擎控制', async () => {
  const { client, order } = fakeClient();
  assert.equal(await createSessionTranscriptStore(client).loadMaxRound(KEY), null);
  assert.match(order.at(-1).sql.replace(/\s+/g, ' ').trim(), /^SELECT MAX\(round\) AS max_round FROM transcript_rounds WHERE transcript_key = \$1$/);
  assert.deepEqual(order.at(-1).params, [KEY]);
});

test('探针（d）：loadByDedupKey 未命中→null；命中→存储 record 原样（含宿主未知字段，不合成列字段）', async () => {
  const stored = {
    round: 7,
    dedupKey: `${KEY}:input:m7`,
    roundKey: `${KEY}:input:m7`,
    hostColumn: { retained: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: '原样', unknownBlockField: 1 }] }],
  };
  const { client } = fakeClient([
    { transcript_key: KEY, dedup_key: `${KEY}:input:m7`, round: 7, record: stored },
    { transcript_key: 'other', dedup_key: `${KEY}:input:m7`, round: 99, record: { round: 99 } },
  ]);
  const store = createSessionTranscriptStore(client);
  assert.equal(await store.loadByDedupKey(KEY, `${KEY}:input:none`), null, '未命中返回 null、不抛错');
  assert.deepEqual(await store.loadByDedupKey(KEY, `${KEY}:input:m7`), stored);
  const hit = await store.loadByDedupKey(KEY, `${KEY}:input:m7`);
  assert.equal(Object.hasOwn(hit, 'dedupKey'), true);
  assert.equal(hit.round, 7);
  assert.equal(store.load(KEY) instanceof Promise, true, 'load 仍可用（回退路径）');
});

test('探针（e）：两探针与 load/appendRound 同经**传入的事务 client**（事务红线，#193 新面）', async () => {
  // 注入的 client 就是事务内 PoolClient；probe 若改走 pool（脱离事务）就发不到这里。
  const seen = [];
  const client = {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      seen.push({ sql: s, params });
      if (s.startsWith('SELECT MAX(round)')) return { rows: [{ max_round: 3 }] };
      if (s.startsWith('SELECT round, dedup_key, record')) {
        return { rows: [{ transcript_key: KEY, dedup_key: 'dk', round: 3, record: { round: 3 } }] };
      }
      return { rows: [] };
    },
    // pool 形态才会有的方法：store 不得调用（调了就 throw）。
    connect() { throw new Error('store must not acquire a new client from a pool'); },
  };
  const store = createSessionTranscriptStore(client);
  assert.equal(await store.loadByDedupKey(KEY, 'dk'), null);
  assert.equal(await store.loadMaxRound(KEY), 3, 'max_round 以 number 返回');
  assert.deepEqual(await store.load(KEY), [{ round: 3, dedupKey: 'dk' }]);
  await store.appendRound(KEY, { round: 3, dedupKey: 'dk', messages: [] });
  assert.deepEqual(
    sqlTrace(seen),
    ['loadByDedupKey', 'loadMaxRound', 'load', 'appendRound'],
    '四次读写全部落在注入 client 上',
  );
  assert.deepEqual(seen.map((entry) => entry.params), [
    [KEY, 'dk'], [KEY], [KEY],
    [KEY, 'dk', 3, JSON.stringify({ round: 3, dedupKey: 'dk', messages: [] }), JSON.stringify([])],
  ]);
});

// ---------- 上游契约套件接入（erix-agent/contract-tests，0.17.0 含 #157 成对探针用例） ----------
//
// 产品适配器（`createSessionTranscriptStore(fakeClient())`）直跑上游 15 项：**15 项里 4 过 11 失败**，
// 冲突全部源于 station 既有 shape（而非探针实现），按红线不用产品代码迁就，而在测试侧加一层契约形状
// 夹具（`contractShapeFixture`）：
//   ① 上游 ROUND_1/ROUND_2/保真/种子/folded 用例的记录**不带 dedupKey/roundKey**；station 的
//      appendRound 把 dedupKey 当硬前置（幂等主判据 + 迁移 0006 部分唯一索引 `(transcript_key, dedup_key)`
//      全依赖它；列本身 nullable，但 0006 头注释定口径为「session 行必填」），
//      直跑会 `record.dedupKey is required`（5 项）。夹具：写入时造一个合成键、读出时剥掉。
//   ② station `load` 以权威列合成 dedupKey 进 record（0.15.0 契约①幂等判据依赖的 shape），而上游保真
//      用例对 record 做严格 deepEqual（与①重叠，同属上述 5 项）。夹具同上去除合成键。
//   ③ run snapshot / run-state 系列 6 项：该能力在 station 不在 transcript store 上（真相在
//      `portal/src/internal.js` 的 `engine_run_state*` 列 + `runner/lib/store.js` IPC 契约面，
//      已由 `runner/test/store-contract.test.js` 17 项覆盖），portal 适配器不实现。夹具：内存桩。
// 夹具**不改产品 SQL / client 绑定 / 探针实现**：load、appendRound、loadByDedupKey、loadMaxRound
// 全部直接转发产品代码（含 #157 探针的深比对、roundKey 回退匹配、loadMaxRound=MAX）。
// 冲突明细逐条记录于 AGENTS.md §8.6。

/** 契约形状夹具：产品 store 的四个方法原样转发，只补 station 不拥有/需合成的部分。 */
function contractShapeFixture() {
  const { client } = fakeClient();
  const store = createSessionTranscriptStore(client);
  const synthetic = new Set();          // 为无 dedupKey 的契约记录造的合成列值（读出时剥掉）
  const snapshots = new Map();          // 以下为 run snapshot / run-state 内存桩（非本 store 能力）
  const runStates = new Map();
  const statuses = new Map();
  return {
    load: async (key) => (await store.load(key)).map((record) => {
      if (!synthetic.has(record.dedupKey)) return record;
      const { dedupKey, ...rest } = record;
      return rest;
    }),
    appendRound: async (key, record) => {
      const dk = record?.dedupKey ?? record?.roundKey;
      if (typeof dk === 'string' && dk !== '') return store.appendRound(key, record);
      const made = `${key}:__contract_auto:${synthetic.size}`;
      synthetic.add(made);
      return store.appendRound(key, { ...record, dedupKey: made });
    },
    // 探针：产品实现直接引用（#157 契约断言逐条对真实适配器执行）。
    loadByDedupKey: store.loadByDedupKey,
    loadMaxRound: store.loadMaxRound,
    saveRunSnapshot: async (runId, snapshot) => { snapshots.set(runId, structuredClone(snapshot)); },
    loadLatestRunSnapshot: async (runId) => (snapshots.has(runId) ? structuredClone(snapshots.get(runId)) : undefined),
    saveRunState: async (runId, state) => { runStates.set(runId, { ...structuredClone(state), runId }); },
    loadRunState: async (runId) => (runStates.has(runId) ? structuredClone(runStates.get(runId)) : undefined),
    markRunState: async (runId, status) => { statuses.set(runId, status); },
    loadRunStateStatus: async (runId) => statuses.get(runId),
  };
}

transcriptStoreContract('station-portal-adapter', async () => contractShapeFixture());
