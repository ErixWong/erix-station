// issue #387：「查看原文」的重建面只说得出「调了什么」、说不出「返回了什么」。
//
// 真机读数（§8.62）：重建路上 `resultPreview` **0/98**。病根是**形状**而不是内容缺失：
// erix-agent 0.23+ 一轮落**多行**（`:msg:<n>:0` = assistant 的 `tool_use`、`:msg:<n>:1..k` = 每个
// `tool_result` 各一行、`:engine:round:<n>` 载体的 `messages` 是空数组），而 `rebuildFoldedRange`
// 把**每行各自一条记录**喂给 `projectTranscriptForDisplay`；上游的配对只扫**本条记录**的 `messages`
// ⇒ 调用块与结果块分家 ⇒ 每个 `toolCalls[]` 只剩 `name`/`argsSummary`。
// 主消息流没这个病：`session-view.js` 在投影前先过读侧折叠（`transcript-fold.js`）。
//
// 本片修法（纯读侧，零 DDL、零账本改写、不改上游）：`sessions.js#attachToolResultsToRecords`
// 按 `tool_use_id` 在本 range 内建结果索引，把缺的那些结果块**原样**挂回带 `tool_use` 的记录，
// **配对仍由上游做** ⇒ 预览长度/`isError`/`executionStatus` 与主消息流同一把尺。
//
// 判据两条：① 夹具里能配上的**全配上**（命中率 0 → 3/3）；② 配不上的**不得伪造**——
// 上游对配不上的调用是**缺键**，于是断言写成 `'resultPreview' in call === false`（不是空串、不是 null）。
// 变异自证（一轮一还原）：摘掉 `attachToolResultsToRecords(...)` 那层包裹 ⇒ 恰「命中率 + 反向对照 +
// 幂等」三格红；把「查不到就塞空串」写进去 ⇒ 恰反向对照那一格红。
//
// 夹具是**合成的**（手写 records，形状照真库 `:msg:` 行；真库读数），
// 隔离约定同 `session-folded-payload.test.js`：注入 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectTranscriptForDisplay } from '../src/display-projection.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-4444-4444-8444-abcdefabcdef';
const TOKEN = 'tok-folded-result-test';
const KEY = SESSION_ID; // 真库里 transcript_key === sessionId

const sessionRow = (id, userId) => ({
  id, user_id: userId, project_id: null, cwd: '~/projects/p1', title: 't', title_source: 'manual',
  model: null, status: 'active', last_seq: 3,
});

/**
 * 只模拟这个面用到的两条 SQL：`chat_sessions` 属主查、`transcript_rounds` 的折叠行取行与 range 重建。
 * ⚠ range 重建**必须真按 `messages <> '[]'::jsonb` 筛行**。
 */
class ResultPool extends FakePool {
  constructor() {
    super({ users: [USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.chatSessions = [sessionRow(SESSION_ID, USER.id)];
    this.transcriptRows = []; // [{transcript_key, round, dedup_key, folded, folded_payload, record, messages}]
  }

  seed(transcriptKey, round, dedupKey, messages, { folded = false, record = null } = {}) {
    this.transcriptRows.push({
      transcript_key: transcriptKey, round, dedup_key: dedupKey, folded,
      folded_payload: null, record, messages,
    });
  }

  async query(sql, params = []) {
    if (sql.includes('FROM chat_sessions s')) {
      const s = this.chatSessions.find((x) => x.id === params[0]);
      return { rows: s ? [s] : [] };
    }
    if (sql.includes('FROM transcript_rounds')) {
      if (sql.includes('BETWEEN')) {
        const [key, from, to, limit] = params;
        const rows = this.transcriptRows
          .filter((x) => x.transcript_key === key && x.round >= from && x.round <= to
            && Array.isArray(x.messages) && x.messages.length > 0)
          .sort((a, b) => a.round - b.round)
          .slice(0, limit)
          .map((x) => ({ round: x.round, messages: x.messages }));
        return { rows };
      }
      const [key, round, limit = 64] = params;
      return {
        rows: this.transcriptRows
          .filter((x) => x.transcript_key === key && x.round === round)
          .slice(0, limit)
          .map((x) => ({ round: x.round, folded: x.folded ?? false, folded_payload: x.folded_payload ?? null, record: x.record ?? null })),
      };
    }
    return super.query(sql, params);
  }
}

async function startServer({ log } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-folded-result-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const pool = new ResultPool();
  const server = createServer({ pool, config, ...(log ? { log } : {}) });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    base,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------
// 真库形状的合成夹具（形状 = 0.23+ 的 `:msg:` 多行；正文/结果文本是合成的）
// ---------------------------------------------------------------------------

const FOLD_ROUND = 7;
const RANGE = { from: 1, to: 6 };

/** 折叠行：差分归档为空（#375 之后必须走重建路）。 */
const seedFoldCarrier = (pool) => pool.seed(KEY, FOLD_ROUND, `${KEY}:engine:round:${FOLD_ROUND}`, [], {
  folded: true,
  record: { foldedRoundRange: RANGE, foldedPayloadMeta: { messages: 0, droppedMessages: 0 } },
});

// round 1：一条 assistant 消息带两个 `tool_use`，两个结果**各占一行**（`:msg:1:1` / `:msg:1:2`），
// 载体行 `messages` 是空数组 —— 这就是配不上对的那形状。
const round1Rows = [
  {
    dedup: `${KEY}:msg:1:0`,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'ROUND ONE BODY' },
        { type: 'tool_use', id: 'tu_a', name: 'readFile', input: { path: 'total.txt' } },
        { type: 'tool_use', id: 'tu_b', name: 'shell', input: { command: 'cat total.txt' } },
      ],
    }],
  },
  {
    dedup: `${KEY}:msg:1:1`,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_a', content: '1: 24' }] }],
  },
  {
    dedup: `${KEY}:msg:1:2`,
    messages: [{
      role: 'user',
      content: [{
        type: 'tool_result', tool_use_id: 'tu_b', content: 'exit_code: 0', is_error: true, erix: { durationMs: 7 },
      }],
    }],
  },
  { dedup: `${KEY}:engine:round:1`, messages: [] },
];

// round 2：反向对照——这次 `tool_use` 的结果落在 **range 之外**（真库里就是「折叠把结果折没了」那一类）。
const round2Rows = [
  {
    dedup: `${KEY}:msg:2:0`,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'ROUND TWO BODY' },
        { type: 'tool_use', id: 'tu_out_of_range', name: 'searchText', input: { pattern: 'needle' } },
      ],
    }],
  },
  { dedup: `${KEY}:engine:round:2`, messages: [] },
];
// 结果行本身在 round 9（> range.to）——它**不在重建取行范围内**，所以配不上是正确行为，不是 bug。
const outOfRangeResultRows = [
  {
    dedup: `${KEY}:msg:9:1`,
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_out_of_range', content: 'MUST NOT LEAK' }] }],
  },
];

// round 3：**老账本形状**（0.22：一轮一行、`tool_use` 与 `tool_result` 同一条消息数组里）。
// 上游本来就配得上 ⇒ 本片必须**一个字节都不改**（幂等），否则挂两遍会把预览截断规则走两次。
const round3LegacyRows = [
  {
    dedup: `${KEY}:engine:round:3`,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'LEGACY ROUND BODY' },
          { type: 'tool_use', id: 'tu_legacy', name: 'readFile', input: { path: 'old.txt' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_legacy', content: 'LEGACY RESULT' }] },
    ],
  },
];

function seedLedger(pool, { withLegacy = true } = {}) {
  seedFoldCarrier(pool);
  for (const row of round1Rows) pool.seed(KEY, 1, row.dedup, row.messages);
  for (const row of round2Rows) pool.seed(KEY, 2, row.dedup, row.messages);
  if (withLegacy) for (const row of round3LegacyRows) pool.seed(KEY, 3, row.dedup, row.messages);
  for (const row of outOfRangeResultRows) pool.seed(KEY, 9, row.dedup, row.messages);
}

async function fetchTurns(s) {
  const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/${FOLD_ROUND}`, { headers: { Cookie: s.cookieHeader } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.source, 'rebuilt', '夹具要走的是重建路（#375）');
  return body.turns;
}

const allCalls = (turns) => turns.flatMap((turn) => (Array.isArray(turn.toolCalls) ? turn.toolCalls : []));
const callById = (turns, id) => allCalls(turns).find((call) => call.id === id);

test('#387 判据①：range 内配得上结果的 `tool_use` 全都要带上 `resultPreview`（命中率 0 → 全中）', async () => {
  const s = await startServer();
  try {
    seedLedger(s.pool);
    const turns = await fetchTurns(s);

    // 夹具自证：结果文本确实在账本里（否则「配上了」可以是假话）
    const serialized = JSON.stringify(turns);
    assert.match(serialized, /ROUND ONE BODY/, 'assistant 正文照常要在（本片不许动正文）');

    const pairable = ['tu_a', 'tu_b', 'tu_legacy'];
    const withPreview = allCalls(turns).filter((call) => typeof call.resultPreview === 'string' && call.resultPreview !== '');
    assert.equal(withPreview.length, pairable.length,
      `带结果的调用要全部配上（实际 ${withPreview.length}/${pairable.length}；修复前真机是 0/98）`);
    for (const id of pairable) {
      const call = callById(turns, id);
      assert.ok(call, `${id} 的 toolCall 要在`);
      assert.ok(call.argsSummary, `${id} 的 argsSummary 上游本来就在给（#384 已画这一半）`);
    }
    assert.equal(callById(turns, 'tu_a').resultPreview, '1: 24');
    assert.equal(callById(turns, 'tu_b').resultPreview, 'exit_code: 0');
    assert.equal(callById(turns, 'tu_legacy').resultPreview, 'LEGACY RESULT', '老账本（同行内已有结果）不得因本片回归');

    // 同一把尺：`isError`/`durationMs` 也由**上游**从结果块给（本站不复制第二套规则）
    assert.equal(callById(turns, 'tu_b').isError, true);
    assert.equal(callById(turns, 'tu_b').durationMs, 7);
  } finally { await s.close(); }
});

test('#387 判据②：`tool_use_id` 在 range 内查不到结果 ⇒ **键都不许出现**（不得伪造空预览）', async () => {
  const s = await startServer();
  try {
    seedLedger(s.pool);
    const turns = await fetchTurns(s);

    const call = callById(turns, 'tu_out_of_range');
    assert.ok(call, '反向对照那条调用块本身要在');
    assert.equal('resultPreview' in call, false,
      `配不上就是缺键（拿到 ${JSON.stringify(call.resultPreview)} 就是伪造）`);
    assert.equal('isError' in call, false, '同一条纪律：isError 也不许凭空写');
    assert.ok(!JSON.stringify(turns).includes('MUST NOT LEAK'),
      'range 之外那条结果正文不得被塞进原文（取行范围就是判据，不许为配对放宽 WHERE）');
    assert.equal(call.argsSummary, 'pattern=needle', '「调了什么」那一半照旧要给（收窄≠删除）');
  } finally { await s.close(); }
});

test('#387 挂回**不多冒气泡**：turn 条数与角色分布必须等于「不挂」时的上游输出', async () => {
  const s = await startServer();
  try {
    seedLedger(s.pool);
    const turns = await fetchTurns(s);

    // 上游 `textOf()` 对「只有 tool_result 的消息」是空串 ⇒ 走的是 model-plumbing 那条 continue。
    // 这条判据钉的就是「挂进去的那条 user 消息不会变成一条假的用户发言」。
    const baseline = projectTranscriptForDisplay([
      { round: 1, messages: round1Rows[0].messages },
      { round: 2, messages: round2Rows[0].messages },
      { round: 3, messages: round3LegacyRows[0].messages },
    ]);
    assert.equal(turns.length, baseline.length,
      `turn 条数不变（挂上的是 tool_result-only 消息，不该产生 turn；实际 ${turns.length} vs ${baseline.length}）`);
    assert.deepEqual(turns.map((t) => t.role), baseline.map((t) => t.role), '角色分布不变');
    const emptyUser = turns.filter((t) => t.role === 'user' && !t.text && !t.reasoning && !(t.toolCalls ?? []).length);
    assert.deepEqual(emptyUser, [], '不许出现「空的 user turn」这种挂出来的残渣');
  } finally { await s.close(); }
});

test('#387 幂等：同一份 range 挂两遍（重复行 / 结果本来就在同一条记录里）⇒ 预览文本只算一次', async () => {
  const s = await startServer();
  try {
    seedLedger(s.pool);
    // 真库里同一轮的 assistant 行只有一条；这里再种一遍**完全相同**的结果行，模拟
    // 「结果既在 assistant 那一行里、又在自己的消息行里」（0.22 与 0.23 混合会话、或 resume 双载体）。
    s.pool.seed(KEY, 1, `${KEY}:msg:1:1:duplicate`, round1Rows[1].messages);
    const turns = await fetchTurns(s);
    const call = callById(turns, 'tu_a');
    assert.equal(call.resultPreview, '1: 24', '挂两遍不能把结果文本接成 `1: 241: 24`');
    assert.equal(allCalls(turns).filter((c) => c.resultPreview === '1: 24').length, 1,
      '带预览的 `tu_a` 只应有一条');
    // 同一条记录内已有结果 ⇒ 一条都不许多挂（`own` 集合那半边判据）
    assert.equal(callById(turns, 'tu_legacy').resultPreview, 'LEGACY RESULT');
  } finally { await s.close(); }
});

test('#387 同一条记录内已结清的调用 ⇒ 用**本记录**那份结果，不被别处的同 id 结果改写', async () => {
  const s = await startServer();
  try {
    seedFoldCarrier(s.pool);
    // 真机形状：崩溃恢复后同一轮同时存在 `…:round:<n>` 与 `…:round:<n>:resume`（§8.38 末），
    // 同一条 `tool_use` 会在两处各有一份结果 ⇒ 配对必须**就近**取本记录那一份。
    s.pool.seed(KEY, 5, `${KEY}:engine:round:5`, [{
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_dup', name: 'shell', input: { command: 'echo hi' } },
      ],
    }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_dup', content: 'IN-RECORD RESULT' }] }]);
    s.pool.seed(KEY, 5, `${KEY}:msg:5:1`, [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_dup', content: 'OTHER ROW RESULT' }] }]);
    const turns = await fetchTurns(s);
    const call = callById(turns, 'tu_dup');
    assert.equal(call.resultPreview, 'IN-RECORD RESULT',
      '本记录已有结果 ⇒ 不再从 range 里另寻一份挂上（`own` 去重那一半判据）');
  } finally { await s.close(); }
});

test('#387 只有 `tool_use` 没有 `id`（旧记录形状）⇒ 跳过，不猜不伪造', async () => {
  const s = await startServer();
  try {
    seedFoldCarrier(s.pool);
    s.pool.seed(KEY, 4, `${KEY}:msg:4:0`, [{
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'readFile', input: { path: 'no-id.txt' } }],
    }]);
    s.pool.seed(KEY, 4, `${KEY}:msg:4:1`, [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_orphan', content: 'ORPHAN' }] }]);
    const turns = await fetchTurns(s);
    const call = allCalls(turns).find((c) => c.name === 'readFile');
    assert.ok(call, '调用块本身要在');
    assert.equal('resultPreview' in call, false, '没有 `id` 就没有配对依据 ⇒ 缺键，不是空串');
    assert.ok(!JSON.stringify(turns).includes('ORPHAN'), '没有依据就不许把结果塞进原文');
  } finally { await s.close(); }
});

test('#387 源码级哨兵：配对必须发生在喂投影**之前**，且不得放宽重建取行范围去「凑」结果', () => {
  const src = fs.readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function rebuildFoldedRange');
  assert.ok(start > 0, '重建入口必须在（改名要同步本哨兵）');
  const body = src.slice(start, src.indexOf('/** PATCH /api/sessions/:id', start));

  const attachAt = body.search(/attachToolResultsToRecords\s*\(/);
  const projectAt = body.search(/projectTranscriptForDisplay\s*\(/);
  assert.ok(attachAt >= 0 && projectAt >= 0 && attachAt < projectAt,
    '必须先把结果挂回记录、再喂本仓投影（`portal/src/display-projection.js`，来源见文件头）（顺序反了等于没挂）');
  assert.ok(body.includes('WHERE transcript_key = $1 AND round BETWEEN $2 AND $3'),
    '取行范围仍是 range 本体：不许为了配对把 WHERE 放宽到 range 之外（反向对照判据的根）');
  assert.doesNotMatch(body, /resultPreview\s*[:=]/,
    '本站不得自己写 `resultPreview`（预览/截断的尺只在本仓 `portal/src/display-projection.js`，来源见文件头；这是防第二个写 `resultPreview` 处，写第二把必漂）');

  const helperAt = src.indexOf('function attachToolResultsToRecords');
  assert.ok(helperAt > 0, '挂回的实现要在（改名要同步本哨兵）');
  const helper = src.slice(helperAt, start);
  assert.doesNotMatch(helper, /slice\(0,\s*\d+\)|substring\(0,\s*\d+\)|\bpadStart\b/,
    '挂回去的必须是**原样的结果块引用**：站内再切一刀就是第二把预览尺');
});

// ---------------------------------------------------------------------------
// PR #541 第三方审计 MED：`tool_use_id` **跨轮复用**时挂错结果。
//
// 病根（审计原文 + 主 agent 裁决）：`attachToolResultsToRecords` 原来建的是 range 级 `Map`，
// `set` 是 last-write-wins，而 `own` 只挡「同一条记录里已结清」的 id ⇒ 两个 round 都用 id `x`
// （round A 得 A、round B 得 B）时，**第一个 round 会显示第二个 round 的结果**——错内容比缺内容
// 更难发现。这不是理论：上游明写 provider id 不保证 run 内唯一
// （`node_modules/erix-agent/src/tool-fact.js:209-210`「**跳轮不在这里继承**：provider id 不保证
// run 内唯一（issue #284）」），真库里也确有 6 个跨轮复用的 id（§8.132 取证读数）。
// 修法：配对按**位置**取「就近」——先取该调用**之后最近**的同 id 结果，之后一条都没有才回退
// 取**之前最近**的那条。「取第一条」不算修好：那只是把错的方向反过来。
// ---------------------------------------------------------------------------

/** 同一 id `tu_reuse` 在两个 round 各用一次、各有一份自己的结果（结果行紧贴自己的调用行）。 */
function seedReusedIdAcrossRounds(pool) {
  seedFoldCarrier(pool);
  pool.seed(KEY, 4, `${KEY}:msg:4:0`, [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'ROUND A BODY' },
      { type: 'tool_use', id: 'tu_reuse', name: 'readFile', input: { path: 'a-in.txt' } },
    ],
  }]);
  pool.seed(KEY, 4, `${KEY}:msg:4:1`, [{
    role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_reuse', content: 'RESULT OF ROUND A' }],
  }]);
  pool.seed(KEY, 6, `${KEY}:msg:6:0`, [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'ROUND B BODY' },
      { type: 'tool_use', id: 'tu_reuse', name: 'readFile', input: { path: 'b-in.txt' } },
    ],
  }]);
  pool.seed(KEY, 6, `${KEY}:msg:6:1`, [{
    role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_reuse', content: 'RESULT OF ROUND B' }],
  }]);
}

const callsOfRound = (turns, round) => allCalls(turns.filter((turn) => turn.round === round));

test('#541 MED 判据①：同一个 `tool_use_id` 跨轮复用 ⇒ 各轮拿**自己那一轮**的结果（不是都拿最后一条）', async () => {
  const s = await startServer();
  try {
    seedReusedIdAcrossRounds(s.pool);
    const turns = await fetchTurns(s);

    const callA = callsOfRound(turns, 4).find((call) => call.id === 'tu_reuse');
    const callB = callsOfRound(turns, 6).find((call) => call.id === 'tu_reuse');
    assert.ok(callA && callB, '两轮各自的 `tool_use` 都要在（夹具自证）');
    assert.equal(callA.argsSummary, 'path=a-in.txt', '两轮的入参不同 ⇒ 拿错轮一眼可见');
    assert.equal(callB.argsSummary, 'path=b-in.txt');

    assert.equal(callA.resultPreview, 'RESULT OF ROUND A',
      `round 4 的调用要拿 round 4 那份（拿到 ${JSON.stringify(callA.resultPreview)} 就是 range 级 last-write-wins 复发）`);
    assert.equal(callB.resultPreview, 'RESULT OF ROUND B',
      `round 6 的调用要拿 round 6 那份；「取第一条」会把这条打成 round 4 那份 ⇒ 本断言照样红`);
    assert.notEqual(callA.resultPreview, callB.resultPreview, '两份结果不许被并成一条');
  } finally { await s.close(); }
});

test('#541 MED 判据②：调用之后没有同 id 结果 ⇒ 回退取**之前最近**的那条（resume 复放的形状）', async () => {
  const s = await startServer();
  try {
    seedFoldCarrier(s.pool);
    // round 3：正常的一轮（调用 + 紧随其后的结果行）
    s.pool.seed(KEY, 3, `${KEY}:msg:3:0`, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'ROUND 3 BODY' }, { type: 'tool_use', id: 'tu_replay', name: 'shell', input: { command: 'pwd' } }],
    }]);
    s.pool.seed(KEY, 3, `${KEY}:msg:3:1`, [{
      role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_replay', content: 'RESULT FROM EARLIER ROUND' }],
    }]);
    // round 6：`:engine:round:6:resume` 载体**重发**旧调用，它后面没有任何结果行
    // （真库形状：`3dcab38b…` 的 round 56 resume 行重发了 round 8/13/20/29/45 的 `tool_use`）
    s.pool.seed(KEY, 6, `${KEY}:engine:round:6:resume`, [{
      role: 'assistant',
      content: [{ type: 'text', text: 'RESUMED' }, { type: 'tool_use', id: 'tu_replay', name: 'shell', input: { command: 'pwd' } }],
    }]);

    const turns = await fetchTurns(s);
    const replayed = callsOfRound(turns, 6).find((call) => call.id === 'tu_replay');
    assert.ok(replayed, '复放的 `tool_use` 要在');
    assert.equal(replayed.resultPreview, 'RESULT FROM EARLIER ROUND',
      '之后一条都没有 ⇒ 退到「之前最近」那条；只认「之后」的实现会把这条打成缺键 ⇒ 本断言红');
    assert.equal(callsOfRound(turns, 3).find((call) => call.id === 'tu_replay').resultPreview,
      'RESULT FROM EARLIER ROUND', '原来那一轮照样拿自己那份');
  } finally { await s.close(); }
});

test('#541 MED 判据③：同 id 出现多份结果 ⇒ **计数走现成日志通道**（无重复时必须不打，否则断言恒真）', async () => {
  const lines = [];
  const log = { warn: (m) => lines.push(String(m)), info: () => {}, error: (m) => lines.push(String(m)) };
  const s = await startServer({ log });
  try {
    seedReusedIdAcrossRounds(s.pool);
    await fetchTurns(s);
    const dup = lines.filter((line) => line.includes('tool_use_id'));
    assert.equal(dup.length, 1, `有重复时要恰好打一条（实际 ${dup.length} 条：${JSON.stringify(dup)}）`);
    assert.match(dup[0], /1 个 tool_use_id/, `那条要带条数读数：${dup[0]}`);
    assert.match(dup[0], /tu_reuse/, '要能指出是哪个 id（运维定位用）');
  } finally { await s.close(); }

  // 反向对照：同一份 range 里没有重复 id ⇒ 一条都不许多打（否则上面的断言是恒真的）
  const quiet = [];
  const s2 = await startServer({ log: { warn: (m) => quiet.push(String(m)), info: () => {}, error: () => {} } });
  try {
    seedLedger(s2.pool);
    await fetchTurns(s2);
    assert.deepEqual(quiet.filter((line) => line.includes('tool_use_id')), [],
      `没有重复就不许报（实际：${JSON.stringify(quiet)}）`);
  } finally { await s2.close(); }
});

test('#541 MED 源码级哨兵：多份结果必须交回 `duplicateIds` 并走 `log.warn`（不是 console、不是响应字段）', () => {
  const src = fs.readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function rebuildFoldedRange');
  const body = src.slice(start, src.indexOf('/** PATCH /api/sessions/:id', start));
  assert.match(body, /duplicateIds/, '重建路要接住「哪些 id 有多份结果」');
  assert.match(body, /log\?\.warn\?\.\(/, '可观测走调用方传进来的 `log`（现成通道），不新造事件类型、不加响应字段');
  assert.doesNotMatch(body, /console\.(warn|log|error)/, '不得绕过注入的 log 直接打 console');
  // 配对尺必须**看位置**：两个方向（之后 / 之前）都要在，只剩一个方向就是「取第一条」或「取最后一条」
  const helperAt = src.indexOf('function attachToolResultsToRecords');
  const helper = src.slice(helperAt, start);
  assert.match(helper, /seq > call\.seq/, '「取之后最近」那半边要在');
  assert.match(helper, /seq < call\.seq/, '「回退取之前最近」那半边要在');
  // 通道必须是通的：http 的 ctx.log → getFoldedPayload → rebuildFoldedRange（任何一环断了，上面那条
  // 日志判据就会变成「永不打」的假绿）。
  const httpSrc = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');
  assert.match(httpSrc, /getFoldedPayload\(ctx\.pool,\s*\{[^}]*log:\s*ctx\.log/,
    '端点必须把 ctx.log 递给 getFoldedPayload（否则 warn 永远打不出来）');
  const payloadBody = src.slice(src.indexOf('export async function getFoldedPayload'), src.indexOf('/** `foldedRoundRange` 形态校验'));
  assert.match(payloadBody, /rebuildFoldedRange\(pool,\s*\{\s*key:\s*sessionId,\s*range,\s*log\s*\}\)/,
    'getFoldedPayload 必须把 log 继续往重建路递');
});
