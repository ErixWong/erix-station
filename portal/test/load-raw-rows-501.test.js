// issue #501 判据：portal store 第三根探针 `loadRawRows`（erix-agent #714 锚点探针，
// 0.33.0 #765 起是 `appendUserTurn` 快路径结清悬空 `tool_use` 的唯一账本来源）。
//
// 三条判据（工单 #501 §要做的三件事 第 3 条）：
//   ① 同一来源：`foldLedgerRecords(await loadRawRows(key))` 与 `await load(key)` 逐字相等；
//   ② 只发一条查询：`loadRawRows` 与 `load` 各自调用时，对同一个 run 各发**恰好一条**、且
//      **SELECT 形状一致**的查询（用本仓既有的 sqlLog 写法钉）；
//   ③ 结清：账本尾部留一条真悬空的 `tool_use`，调引擎 `appendUserTurn` ⇒
//      `unsettledToolUses` **不再是** `{status:'refused', reason:'ledger_probe_absent'}`。
//
// 三条都用 `portal/test/fake-transcript-rounds.js`（真库行为仿真）跑，无需 `TEST_DATABASE_URL`；
// 判据 ③ 另配一根**正反对照**：同一份种子，摘掉探针 ⇒ 引擎报 `ledger_probe_absent`，
// 留着 ⇒ 不再是它，直接证明「探针本身就是把降级解掉的那根」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendUserTurn } from 'erix-agent';
import { createSessionTranscriptStore } from '../src/transcript-store.js';
import { foldLedgerRecords, MESSAGE_ROW_KIND } from '../src/transcript-fold.js';
import { fakeTranscriptRounds, sessionTranscriptSeedRow } from './fake-transcript-rounds.js';

const KEY = 'sess-501';
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
// `load()` 与 `loadRawRows()` 共用的那一条 SELECT（`readRoundRows`）规范化后的形状。
const FULL_LOAD_SQL = norm(
  'SELECT round, dedup_key, record FROM transcript_rounds WHERE transcript_key = $1 ORDER BY round, append_seq',
);

/** 包一层 fake-transcript-rounds：记录每条 SQL（sql + params），不认的 SQL 记为 {rows:[]}。 */
function instrumentedClient(rows) {
  const t = fakeTranscriptRounds({ rows });
  const log = [];
  return {
    log,
    state: t.state,
    async query(sql, params = []) {
      log.push({ sql: norm(sql), params });
      const hit = t.query(sql, params);
      return hit ?? { rows: [], rowCount: 0 };
    },
  };
}

/** 尾部一条真悬空的 `tool_use`（带 kind/seq 的引擎消息行，账本里没有任何对应 `tool_result`）。 */
function danglingToolUseSeed({ round = 5, toolUseId = 'toolu_dangling_501' } = {}) {
  const record = {
    round,
    roundKey: `${KEY}:round:${round}`,
    dedupKey: `${KEY}:engine:round:${round}`,
    kind: MESSAGE_ROW_KIND,
    seq: 0,
    messages: [{
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'sleep' } }],
    }],
    ts: '2026-11-01T00:00:00.000Z',
  };
  return sessionTranscriptSeedRow(KEY, {
    dedupKey: record.dedupKey, round, record, append_seq: 1,
  });
}

// ---------- 判据 ①：同一来源 ----------
test('#501 判据①：foldLedgerRecords(loadRawRows(key)) 与 load(key) 逐字相等（同一份 SELECT 的必然结果）', async () => {
  // 种一份会让折叠真正改变输出的账本：同 round 的聚合载体 + partOf 分片，确保不是空表恒等式。
  const round = 7;
  const aggRecord = {
    round, roundKey: `${KEY}:round:${round}`, dedupKey: `${KEY}:engine:round:${round}`,
    kind: MESSAGE_ROW_KIND, seq: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '聚合头' }] }],
    ts: '2026-11-01T00:00:00.000Z',
  };
  const partRecord = {
    round, roundKey: `${KEY}:round:${round}`, dedupKey: `${KEY}:engine:round:${round}:part:1`,
    kind: MESSAGE_ROW_KIND, seq: 1, partOf: aggRecord.dedupKey,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '分片尾' }] }],
    ts: '2026-11-01T00:00:01.000Z',
  };
  const client = instrumentedClient([
    sessionTranscriptSeedRow(KEY, { dedupKey: aggRecord.dedupKey, round, record: aggRecord, append_seq: 1 }),
    sessionTranscriptSeedRow(KEY, { dedupKey: partRecord.dedupKey, round, record: partRecord, append_seq: 2 }),
    // 一条宿主 :input: 行（不带 kind/seq，折不走，原样留在折叠输出里）——同源判据必须连它一起看到。
    sessionTranscriptSeedRow(KEY, {
      dedupKey: `${KEY}:input:m1`, round: 6, append_seq: 3,
      record: { round: 6, roundKey: `${KEY}:round:6`, dedupKey: `${KEY}:input:m1`,
        messages: [{ role: 'user', content: [{ type: 'text', text: '宿主预写' }] }],
        ts: '2026-11-01T00:00:02.000Z' },
    }),
  ]);
  const store = createSessionTranscriptStore(client);

  const raw = await store.loadRawRows(KEY);
  const foldedFromRaw = foldLedgerRecords(raw);
  const loaded = await store.load(KEY);

  // 折叠前 raw 必须比折叠后 load 更「原始」（分片未被吸走），且 loadRawRows 未过折叠。
  assert.ok(Array.isArray(raw));
  assert.ok(raw.length >= loaded.length, '未折叠的行数不应少于折叠后（否则 loadRawRows 被偷偷折过）');
  // 核心：折叠 raw 必须与 load **逐字相等**（同一份 SELECT、同一份映射、同一个折叠函数）。
  assert.deepEqual(foldedFromRaw, loaded);
});

// ---------- 判据 ②：只发一条查询、SELECT 形状一致 ----------
test('#501 判据②：loadRawRows 与 load 各发恰好一条、且 SELECT 形状一致（不许复制第二份 SQL）', async () => {
  const client = instrumentedClient([ danglingToolUseSeed() ]);
  const store = createSessionTranscriptStore(client);

  client.log.length = 0;
  await store.loadRawRows(KEY);
  const rawQueries = client.log.slice(); // 必须快照：client.log 是同一数组引用，不 slice 会被下一次清空污染

  client.log.length = 0;
  await store.load(KEY);
  const loadQueries = client.log.slice();

  // 各自**恰好一条**（不是 0 条、不是两条）。
  assert.equal(rawQueries.length, 1, `loadRawRows 应只发一条查询，实发 ${rawQueries.length} 条`);
  assert.equal(loadQueries.length, 1, `load 应只发一条查询，实发 ${loadQueries.length} 条`);
  // 两条查询的 SELECT **形状一致**（同一条 SQL）+ 同一份参数：探针与 load 看到的是同一本账。
  assert.equal(rawQueries[0].sql, FULL_LOAD_SQL);
  assert.equal(loadQueries[0].sql, FULL_LOAD_SQL);
  assert.equal(rawQueries[0].sql, loadQueries[0].sql, 'loadRawRows 与 load 必须共用同一条 SELECT');
  assert.deepEqual(rawQueries[0].params, [KEY]);
  assert.deepEqual(loadQueries[0].params, [KEY]);
});

// ---------- 判据 ③：结清真悬空的 tool_use（探针存在即不再 ledger_probe_absent） ----------
test('#501 判据③：账本尾部真悬空 tool_use → 有 loadRawRows 时 unsettledToolUses 不再是 ledger_probe_absent', async () => {
  const client = instrumentedClient([ danglingToolUseSeed({ round: 5 }) ]);
  const store = createSessionTranscriptStore(client);

  const result = await appendUserTurn(store, {
    key: KEY, text: '续跑用户输入', messageId: 'newturn-501',
  });

  // 引擎必须**看见**悬空并结清/降级，而非因缺探针而报 ledger_probe_absent。
  assert.ok(result.unsettledToolUses, '真悬空 tool_use 应产生 unsettledToolUses');
  const notAbsentProbe = !(result.unsettledToolUses.status === 'refused'
    && result.unsettledToolUses.reason === 'ledger_probe_absent');
  assert.ok(notAbsentProbe,
    `补上探针后不得再报 ledger_probe_absent，实得 ${JSON.stringify(result.unsettledToolUses)}`);
  assert.notEqual(result.unsettledToolUses.reason, 'ledger_probe_absent');
  // 悬空被引擎读到了：toolUseIds 指向种子那张桩。
  assert.ok(result.unsettledToolUses.toolUseIds?.includes('toolu_dangling_501'),
    '探针必须把决定行（悬空 tool_use）交给引擎');
});

test('#501 判据③（正反对照）：同一份种子摘掉 loadRawRows ⇒ 引擎退回 ledger_probe_absent（证明探针正是解药）', async () => {
  const client = instrumentedClient([ danglingToolUseSeed({ round: 5 }) ]);
  const store = createSessionTranscriptStore(client);
  delete store.loadRawRows; // 模拟探针缺席（0.33 之前的本站）。

  const result = await appendUserTurn(store, {
    key: KEY, text: '续跑用户输入', messageId: 'newturn-501',
  });

  assert.deepEqual(result.unsettledToolUses, {
    status: 'refused', reason: 'ledger_probe_absent', toolUseIds: [],
  }, '无探针时引擎必须报 ledger_probe_absent（与判据③形成对照）');
});
