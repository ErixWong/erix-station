// issue #816 第②步：会话级折叠索引 `session.folds[]` —— 从**同一趟**整会话 transcript 扫描派生，
// **不受 `messages` 的 LIMIT 窗口限制**（零新增 SQL）。
//
// 手法照搬 `portal/test/folded-facts-passthrough.test.js`（**不另造第二套投影**）：真跑一次
// `runToolLoop` + `fold-llm` 得到真折叠载体行（`folded === true` 那条真 record），再以它为模板逐例覆写
// `round` / `foldedFacts`（区间 from/to 等），喂 `getSession`（内存 fake pool，隔离约定 docs/testing.md §2.1），
// 读 DTO 的 `session.folds`。判据钉的是 `session-view.js#collectTranscriptFacts` 新增的 `folds` 派生 +
// `sessions.js#getSession` 的**恒在**挂载：恒在（无折叠 `[]`）、排序（from 升序）、去重（同 (from,to) 留
// round 最大）、缺区间剔除、字段口径复用 `foldedFactsFields`。会话级 `compaction` 的缺席语义一并钉住不变。
import test from 'node:test';
import assert from 'node:assert/strict';

import { runToolLoop } from 'erix-agent';

import { getSession } from '../src/sessions.js';
import { assertCompactContext } from '../../runner/lib/compact-knobs.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'c0ffee00-2222-4222-8222-abcdefabcdef';
const at = (second) => new Date(Date.UTC(2026, 10, 2, 0, 0, second));
const text = (value) => [{ type: 'text', text: value }];

/** 生产 store 桩：只记账，不折叠（与 `folded-facts-passthrough.test.js` 同语义）。 */
function makeStore(records) {
  return {
    async appendRound(key, record) { (records[key] ??= []).push(record); },
    async load(key) { return [...(records[key] ?? [])]; },
    async saveRunSnapshot() {},
    async loadLatestRunSnapshot() { return undefined; },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
  };
}

/** 造 n 轮真形态历史（user → tool_use → tool_result），文本足够长以便真折得动。 */
function foldHistory(n) {
  const messages = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'user', content: text(`第 ${i} 轮任务 ${'u'.repeat(500)}`) });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `h-t${i}`, name: 'noop', input: { round: i } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `h-t${i}`, content: `第 ${i} 轮结果 ${'r'.repeat(700)}` }] });
  }
  return messages;
}

/** 真跑一次 `fold-llm`，返回引擎经 `appendRound` 落下的真折叠载体行（= 生产 `record`，`folded === true`）。 */
async function runRealFoldRow() {
  const records = {};
  const main = [];
  const provider = {
    async chat(request) {
      if (typeof request?.system === 'string' && request.system.includes('对话历史压缩器')) {
        return { content: text('【LLM 摘要】已折走早期轮次，细节去 transcript 查。'), stopReason: 'end_turn' };
      }
      main.push(request);
      return main.length <= 2
        ? { content: [{ type: 'tool_use', id: `c${main.length}`, name: 'noop', input: {} }], stopReason: 'tool_use' }
        : { content: text('收尾'), stopReason: 'end_turn' };
    },
  };
  await runToolLoop({
    provider,
    store: makeStore(records),
    executeTool: async () => 'ok',
    config: {
      input: { messages: foldHistory(14), initialUserMessage: '继续收尾' },
      run: { runId: SESSION_ID, maxRounds: 6, completion: false },
      folding: { context: assertCompactContext({ strategy: 'fold-llm', keepRounds: 6 }) },
      metadata: { task: 't', modelMetadata: { contextWindowTokens: 6000, maxOutputTokens: 200 } },
      tuning: { maxTokens: 200 },
    },
  });
  const rows = records[SESSION_ID] ?? [];
  const foldRow = rows.find((row) => row.folded === true);
  assert.ok(foldRow, '前置：这一跑必须真的折过一次（否则下面的 folds 断言全是空断言）');
  return foldRow;
}

// 整轮只跑一次真账本（模板对入参是纯函数，逐例只换 round / foldedFacts）。
let templatePromise = null;
function foldTemplate() {
  templatePromise ??= runRealFoldRow();
  return templatePromise;
}

/** 一条 transcript 行（真列名形状；`round` 列同时决定 `collectTranscriptFacts` 的记账键）。 */
function transcriptRow(round, record) {
  return {
    run_id: null,
    round,
    dedup_key: `${SESSION_ID}:engine:round:${round}`,
    record: { roundKey: `${SESSION_ID}:round:${round}`, dedupKey: `${SESSION_ID}:engine:round:${round}`, ...record },
    created_at: at(Math.max(0, round)),
  };
}

/** 以真折叠行为模板造一条折叠 transcript 行：保住引擎原始形状（`folded === true`），只覆写 round + foldedFacts。 */
function foldRowFrom(template, round, foldedFacts) {
  return transcriptRow(round, { ...template, round, foldedFacts });
}

/** 一条用户锚点（`getSession` 只有在 anchors 非空时才会去读 transcript_rounds）。 */
function anchorRow(seq = 1) {
  return {
    id: 'm1', run_id: null, seq, role: 'user', content: '第一句',
    synthetic: false, attachments: [], created_at: at(1),
  };
}

/** `getSession` 用到的 SQL 面（照 `session-compaction-stats.test.js#CompactionPool`；其余落回 FakePool）。 */
class FoldPool extends FakePool {
  constructor(transcriptRows = []) {
    super({ users: [USER] });
    this.transcriptRows = transcriptRows;
    this.sqlLog = [];
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql);
    if (sql.includes('FROM chat_sessions s')) {
      return {
        rows: [{
          id: SESSION_ID, user_id: USER.id, project_id: null, cwd: '~/projects/demo',
          title: 'fold me', title_source: 'auto', model: null, status: 'active',
          last_seq: 9, message_count: 1,
        }],
      };
    }
    if (sql.includes('FROM messages') && sql.includes("role = 'user'")) {
      return {
        rows: [{ id: 'm1', run_id: null, seq: 1, synthetic: false, anchor_text: '第一句', created_at: at(1) }],
      };
    }
    if (sql.includes('FROM messages')) {
      return { rows: [anchorRow()] };
    }
    if (sql.includes('FROM transcript_rounds')) {
      return { rows: this.transcriptRows };
    }
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM tool_calls')) return { rows: [] };
    return super.query(sql, params);
  }
}

/** 喂一批折叠 transcript 行进 `getSession`，返回 `result.session`。 */
async function sessionOf(transcriptRows) {
  const pool = new FoldPool(transcriptRows);
  const result = await getSession(pool, { userId: USER.id, sessionId: SESSION_ID, limit: 20 });
  return { session: result.session, pool };
}

// ── 用例 1：无折叠 ⇒ `folds: []`（恒在，不是缺键）；`compaction` 的缺席语义不变 ──────────────
test('#816-1 无折叠 ⇒ session.folds === []（恒在，不是缺键），且 session.compaction 仍按缺席语义不给键', async () => {
  const { session } = await sessionOf([transcriptRow(1, { messages: [{ role: 'assistant', content: text('普通轮，无折叠') }] })]);
  assert.ok(Object.hasOwn(session, 'folds'), 'folds 键恒在（列表空 = 完整答案，与 compaction 的缺席不同）');
  assert.deepEqual(session.folds, [], '无折叠 ⇒ 空数组，不是 undefined / 不是缺键');
  assert.ok(JSON.stringify(session).includes('"folds":[]'), '序列化后 folds 仍在（空列表本身就是答案）');
  // 反向钉住：compaction 的既有缺席语义一字不动（一条 compactionStats 都没有 ⇒ 整个键不给）。
  assert.equal('compaction' in session, false, 'compaction 仍是「键缺席而非零」，没被本单连带改动');
});

// ── 用例 2：单次折叠 ⇒ 一条，round/from/to/rounds/title/origin 逐字相等 ──────────────────────
test('#816-2 单次折叠 ⇒ folds 一条，round/from/to/rounds/title/summary/origin 逐字相等', async () => {
  const template = await foldTemplate();
  const { session } = await sessionOf([foldRowFrom(template, 10, {
    text: '替代物正文',
    source: 'llm',
    title: '调研 store 层',
    summary: '模型给的 description',
    origin: 'semantic',
    from: 1,
    to: 5,
    rounds: 3,
  })]);
  assert.equal(session.folds.length, 1);
  // 区间字段用折叠事实自己的 from/to/rounds（经 foldedFactsFields 的安全整数口径），round 用落账轮号。
  assert.deepEqual(session.folds[0], {
    round: 10,
    title: '调研 store 层',
    summary: '模型给的 description',
    origin: 'semantic',
    from: 1,
    to: 5,
    rounds: 3,
  });
});

// ── 用例 3：多次折叠 ⇒ 按 from 升序（喂乱序 transcript 行，输出必有序） ────────────────────────
test('#816-3 多次折叠 ⇒ 按 from 升序（最旧在前），同 from 按 round 升序（喂乱序行也必有序）', async () => {
  const template = await foldTemplate();
  const { session } = await sessionOf([
    foldRowFrom(template, 7, { from: 8, to: 10, title: '晚' }),
    foldRowFrom(template, 3, { from: 2, to: 4, title: '早' }),
    foldRowFrom(template, 5, { from: 5, to: 6, title: '中' }),
  ]);
  assert.deepEqual(session.folds.map((f) => f.from), [2, 5, 8], 'from 严格升序');
  assert.deepEqual(session.folds.map((f) => f.round), [3, 5, 7], '各自带回落账轮号');
  // 同 from 的次级排序：两条 from 相同（to 不同以免被 (from,to) 去重合并）⇒ round 升序。
  const tie = await sessionOf([
    foldRowFrom(template, 9, { from: 4, to: 9, rounds: 2 }),
    foldRowFrom(template, 2, { from: 4, to: 4, rounds: 1 }),
  ]);
  assert.deepEqual(tie.session.folds.map((f) => f.round), [2, 9], '同 from 按 round 升序');
});

// ── 用例 4：同 (from,to) 重复 ⇒ 只留 round 最大的那条（最新落账 = 累计真值） ────────────────────
test('#816-4 同 (from,to) 重复 ⇒ 只留 round 最大的那条（喂顺序不影响结果）', async () => {
  const template = await foldTemplate();
  for (const order of [[4, 11], [11, 4]]) {
    const { session } = await sessionOf(order.map((round) => foldRowFrom(template, round, {
      from: 2, to: 4, rounds: round, title: `落账 r${round}`,
    })));
    assert.equal(session.folds.length, 1, `(from=2,to=4) 重复只应留一条，实得 ${session.folds.length}`);
    assert.equal(session.folds[0].round, 11, '留下的是 round 最大（最新落账）那条');
    assert.equal(session.folds[0].title, '落账 r11', '整项都是 round=11 那份，不是被半截覆盖');
  }
});

// ── 用例 5：from/to 取不到（非安全整数）⇒ 该项不进数组（其余项照常） ───────────────────────────
test('#816-5 from/to 缺失或非安全整数 ⇒ 该项不进数组，其余项照常', async () => {
  const template = await foldTemplate();
  const { session } = await sessionOf([
    foldRowFrom(template, 1, { from: 2, to: 3, title: '有效' }),
    foldRowFrom(template, 2, { from: 'x', to: 9, title: 'from 非数' }),        // from 非整数 → 剔
    foldRowFrom(template, 3, { to: 9, title: '缺 to' }),                          // 缺 from → 剔
    foldRowFrom(template, 4, { from: 2 ** 53, to: 2 ** 53 + 1, title: '溢出' }), // from 非安全整数 → 剔
    foldRowFrom(template, 5, { from: 4, title: '缺 to 值' }),                     // 有 from 缺 to → 剔
  ]);
  assert.equal(session.folds.length, 1, '只有区间两头都是安全整数的那条进数组');
  assert.deepEqual(session.folds[0], { round: 1, from: 2, to: 3, title: '有效' });
});

// ── 用例 6：口径复用 foldedFactsFields（title 空白 / origin 白名单外 ⇒ 子键缺席但项仍在） ──────
test('#816-6 口径复用：title 纯空白 / origin 白名单外 ⇒ 该子键缺席但项本身仍在（区间够），有效子键原样带出', async () => {
  const template = await foldTemplate();
  const { session } = await sessionOf([
    // 区间够、但 title 纯空白 + origin 白名单外 ⇒ 这两个子键被 foldedFactsFields 剔成缺席，项仍在。
    foldRowFrom(template, 6, { title: '   ', origin: 'llm', from: 3, to: 7 }),
    // 有效 title/origin/toolCalls/truncated 必须原样带出（证明复用的是同一把尺，没照抄第二份）。
    foldRowFrom(template, 8, {
      title: '  调研 store 层  ', origin: 'semantic', from: 1, to: 2, truncated: true,
      toolCalls: [{ name: 'readFile', argsSummary: 'path=a' }],
    }),
  ]);
  const blank = session.folds.find((f) => f.round === 6);
  assert.ok(blank, '区间够 ⇒ 即便 title/origin 都不可认，折叠项本身仍在');
  assert.ok(!Object.hasOwn(blank, 'title'), 'title 纯空白 ⇒ 子键缺席（不写空串）');
  assert.ok(!Object.hasOwn(blank, 'origin'), 'origin 白名单外 ⇒ 子键缺席（不原样透传）');
  assert.deepEqual(blank, { round: 6, from: 3, to: 7 });

  const rich = session.folds.find((f) => f.round === 8);
  assert.ok(rich, '第二条照常进数组');
  assert.equal(rich.title, '调研 store 层', 'title 复用 foldedFactsFields 的 trim');
  assert.equal(rich.origin, 'semantic', '白名单内 origin 原样带出');
  assert.deepEqual(rich.toolCalls, [{ name: 'readFile', argsSummary: 'path=a' }], 'toolCalls 复用逐项清洗');
  assert.equal(rich.truncated, true, 'truncated 从 foldedFacts.truncated === true 取（口径同 foldedFactsFields）');
});
