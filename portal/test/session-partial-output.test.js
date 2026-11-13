// issue #300：GET /api/sessions/:id/events/history 的**合成项** `partial_output`（只读重建）。
// 缺陷：runner 的 catch 固定 `final_text:''` ⇒ 被停止/失败的 run 在 messages 里**零助手锚点**，
// 而正文区只从锚点渲染 ⇒ 界面上这次 run 一片空白。修法：本**只读**端点给该 run 下发**一条**
// 合成项 `partial_output`。
//
// **issue #502 D-7 改了取数来源，本文件的夹具跟着改（每处理由写在改动点旁边）**：
//   * 来源从「聚合该 run 全部 `assistant_delta`」改成「读终态事务写下的那一行 `type='partial_output'`」
//     （碎片已不再落库：`internal.js` 写入侧按引擎 `eventTierOf` 拦住，存量由迁移 0033 清掉）。
//   * 于是 `seedAbortedRun` 的 `deltas: [...]` 参数**语义变了但名字留着**：它现在写的是那一行的
//     `payload.text`（拼接这些片段）与 `chunks`（片段条数）——原来那些"几片拼成一句"的断言
//     因此仍然承重，只是断的是「写侧拼好、读侧原样取回」而不是「读侧自己拼」。
//   * 「不落库」这条旧断言**反过来**了（D-3 之后那一行就是库里的行），改成断「它不在下发白名单里，
//     所以仍只以合成项出现一次」——原断言的**意图**（不许出现两条正文）保留，换了一种钉法。
//   * 成本红线两条的 SQL 正则从 `assistant_delta` 改成 `partial_output`：不改就成了**恒真**的空断言
//     （regex 永不命中 ⇒ 「零额外查询」看着绿其实没测）。
// 判据三条（缺一不合成）：① 该 run 出现在本次响应窗口里；② runs.status IN ('finished','failed')
// 且该 run 零助手锚点（含 synthetic 行）；③ 聚合出非空文本。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
// ⚠ fake **按 SQL 文本真模拟库约束**（AGENTS §8.14）：状态过滤 / EXISTS 锚点 / ANY 数组 / ORDER BY
//   都在 fake 里照 SQL 语义实现，并用 `sqlLog` 记录每条 SQL 以钉「无 run ⇒ 零额外查询」这条成本红线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-2222-4222-8222-abcdefabcdef';
const TOKEN = 'tok-partial-output-test';

const RUN_TERMINAL = "r.status IN ('finished', 'failed')";

/**
 * 会话 / runs / messages / run_events 四张内存表 + 归属查询。
 * 分发按 SQL 特征（与 portal/test/fake-*.js 同口径）：**代码改了 SQL 语义，fake 的行为跟着变**，
 * 否则变异测试会因为「fake 好心兼平」而假绿。
 */
class PartialOutputPool extends FakePool {
  constructor() {
    super({ users: [USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.chatSessions = [{ id: SESSION_ID, user_id: USER.id, status: 'active' }];
    this.runs = []; // {id, session_id, status, termination}
    this.messages = []; // {id, session_id, run_id, role, content, synthetic}
    this.runEvents = []; // {session_id, run_id, seq, type, payload}
    this.sqlLog = []; // 每条查询的 SQL 文本（成本红线用）
  }

  seedRun(id, status, termination = null) {
    this.runs.push({ id, session_id: SESSION_ID, status, termination });
    return this;
  }

  seedMessage({ id, runId, role = 'assistant', content = '正文', synthetic = false }) {
    this.messages.push({ id, session_id: SESSION_ID, run_id: runId, role, content, synthetic });
    return this;
  }

  seedEvent({ seq, runId, type, payload = {}, sessionId = SESSION_ID }) {
    this.runEvents.push({ session_id: sessionId, run_id: runId, seq, type, payload });
    return this;
  }

  /** 该 run 的助手锚点数（SQL 里 EXISTS 的等价：role='assistant' 的任意行，**含 synthetic**）。 */
  assistantAnchors(runId) {
    return this.messages.filter((m) => m.run_id === runId && m.role === 'assistant');
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql);
    const flat = sql.replace(/\s+/g, ' ').trim();

    // 归属校验（status='active' 口径同 fetchSession）
    if (flat.includes('FROM chat_sessions WHERE id') && flat.includes("status = 'active'")) {
      return {
        rows: this.chatSessions.filter((s) => s.id === params[0] && s.user_id === params[1] && s.status === 'active'),
      };
    }

    // 终态查询（#300 的候选判定 + #236 的终态投影共用**同一条** SQL）：
    //   SELECT r.id AS run_id, r.status, r.termination,
    //          (SELECT MAX(e.seq) FROM run_events e WHERE e.run_id = r.id) AS last_seq,
    //          EXISTS(... FROM messages m WHERE m.run_id = r.id AND m.role='assistant') AS has_anchor
    //     FROM runs r WHERE r.id = ANY($1) AND r.status IN ('finished','failed')
    if (flat.includes('FROM runs r')) {
      const ids = params[0] ?? [];
      let rows = this.runs.filter((r) => ids.includes(r.id));
      // 真按 SQL 里的状态集合过滤：变异把这段删掉 ⇒ fake 就不再过滤 ⇒ 三态用例必须红（不是假绿）
      const statusClause = flat.match(/r\.status IN \(([^)]*)\)/);
      if (statusClause) {
        const allowed = statusClause[1].split(',').map((s) => s.trim().replace(/'/g, ''));
        rows = rows.filter((r) => allowed.includes(r.status));
      }
      return {
        rows: rows.map((r) => ({
          run_id: r.id,
          // 新列照 SQL 真算（#236 的终态投影要用 status/termination/last_seq）
          status: r.status,
          termination: r.termination ?? null,
          last_seq: this.runEvents
            .filter((e) => e.run_id === r.id)
            .reduce((max, e) => (e.seq > max ? e.seq : max), null),
          has_anchor: flat.includes('FROM messages m') ? this.assistantAnchors(r.id).length > 0 : null,
        })),
      };
    }

    // #502 D-7 的取数：SELECT run_id, seq, payload FROM run_events WHERE run_id = ANY($1) AND type='partial_output' ORDER BY run_id, seq
    if (flat.includes('run_events') && flat.includes("type = 'partial_output'")) {
      const ids = params[0] ?? [];
      // 「每 run 至多一行」在真库里由迁移 0033 的部分唯一索引兜，这里照真库**允许**多行返回
      // （代码若真的拿到两行，必须自己挑一条而不是静默拼起来 ⇒ 下面故意不去重）。
      const rows = this.runEvents.filter((e) => ids.includes(e.run_id) && e.type === 'partial_output');
      // **夹具兼容折算**（不是「好心兼平」，是把真写路径补上）：本文件是 HTTP 读侧用例，跑不到
      // `finishRun`/`insertPartialOutputRow`，而 #502 之前的老夹具只播 `assistant_delta` 行。
      // 这里按**真写路径的形状**把那些 delta 折算成终态那一行（拼接顺序 = seq 升序、脏值整条跳过、
      // `chunks` 只数真正参与拼接的、`seq` 取最后一条 delta 的 seq），读侧断言的原意一条不少：
      // 「whole-run 口径」「每批至多一条」「脏值不拼进正文」「合成项不占 limit」全都照旧承重。
      for (const id of ids) {
        if (rows.some((r) => r.run_id === id)) continue;
        const deltas = this.runEvents
          .filter((e) => e.run_id === id && e.type === 'assistant_delta')
          .sort((a, b) => a.seq - b.seq);
        const parts = deltas.filter((e) => typeof e.payload?.text === 'string' && e.payload.text !== '');
        if (parts.length === 0) continue;
        rows.push({
          run_id: id,
          seq: deltas[deltas.length - 1].seq,
          type: 'partial_output',
          payload: {
            text: parts.map((e) => e.payload.text).join(''),
            reasoning: '', uptoSeq: deltas[deltas.length - 1].seq,
            chunks: parts.length, truncated: false, source: 'legacy',
          },
        });
      }
      const ordered = /ORDER BY run_id, seq/.test(flat);
      if (ordered) rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : a.seq - b.seq));
      return { rows };
    }

    // 旧口径（#502 之前）：聚合整 run 的 assistant_delta。留着这条分支只为**变异测试**服务：
    // 产品代码若退回聚合 delta，它照样拿得到行，而合成项的 seq/chunks 形状会与新断言不符 ⇒ 用例红。
    if (flat.includes('run_events') && flat.includes("type = 'assistant_delta'")) {
      const ids = params[0] ?? [];
      const rows = this.runEvents.filter((e) => ids.includes(e.run_id) && e.type === 'assistant_delta');
      // **按 SQL 文本决定要不要排序**（AGENTS §8.14：fake 不得好心兼平）：代码删了 ORDER BY
      // 就得拿到插入序，而夹具的插入序与 seq 序故意不一致 ⇒ 拼接顺序用例会真红。
      const ordered = /ORDER BY run_id, seq/.test(flat);
      if (ordered) rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : a.seq - b.seq));
      return { rows };
    }

    // 主窗口（白名单 + keyset 分页）
    if (flat.includes('FROM run_events')) {
      const sessionId = params[0];
      const types = params[1];
      let rows = this.runEvents.filter((e) => e.session_id === sessionId && types.includes(e.type));
      const beforeIdx = seqClauseIdx(flat);
      if (beforeIdx != null) rows = rows.filter((e) => e.seq < params[beforeIdx]);
      const limit = params[params.length - 1];
      rows = rows.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);
      return { rows };
    }

    return super.query(sql, params);
  }
}

/** 分页 SQL 里 `seq < $n` 的参数字位（按 SQL 文本找，不假设参数顺序）；没这段 ⇒ null。 */
function seqClauseIdx(flatSql) {
  const m = flatSql.match(/seq < \$(\d+)/);
  return m ? Number(m[1]) : null;
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-partial-'));
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
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const pool = new PartialOutputPool();
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookieHeader = `${config.cookie.name}=${TOKEN}`;
  return {
    pool,
    base,
    cookieHeader,
    history: async (query = '') => {
      const res = await fetch(`${base}/api/sessions/${SESSION_ID}/events/history${query}`, {
        headers: { Cookie: cookieHeader },
      });
      assert.equal(res.status, 200, `history${query} 应 200`);
      return res.json();
    },
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

/**
 * 造一个「被停在半路」的 run：终态 + 零锚点 + **那一行 `partial_output`**（#502 D-3 的形状）。
 * `deltas` 参数的语义（改动点，理由见文件头）：这些片段模拟**写侧**累加器当初拼出来的正文，
 * 本函数把它们拼成 `payload.text`、把条数写成 `payload.chunks`——读侧只是原样取回，
 * 「拼了几片」仍是可断言的面（可观测性字段本来就是为了核对这个）。
 */
function seedAbortedRun(pool, { runId = 'r-partial', status = 'failed', deltas = [], anchor = null, startSeq = 1, extraEvents = [] }) {
  pool.seedRun(runId, status);
  let seq = startSeq;
  pool.seedEvent({ seq: seq++, runId, type: 'round_start', payload: { round: 1 } });
  const parts = deltas.filter((t) => typeof t === 'string' && t !== '');
  if (parts.length > 0) {
    pool.seedEvent({
      seq: seq++, runId, type: 'partial_output',
      payload: { text: parts.join(''), reasoning: '', uptoSeq: seq - 1, chunks: parts.length, truncated: false, source: 'terminal' },
    });
  }
  for (const extra of extraEvents) pool.seedEvent({ seq: seq++, runId, ...extra });
  if (anchor) pool.seedMessage({ id: `${runId}-msg`, runId, ...anchor });
  return { pool, lastSeq: seq - 1 };
}

const partialsOf = (body) => body.events.filter((e) => e.type === 'partial_output');
// 「真实事件」= 白名单里的落库事件。两个响应期合成项（#300 `partial_output` / #236 `run_termination`）
// 都不是 `run_events` 的行 ⇒ 一并排除（否则 #300 的既有断言会把合成项当真实事件数进去）。
const SYNTH_TYPES = new Set(['partial_output', 'run_termination']);
const realsOf = (body) => body.events.filter((e) => !SYNTH_TYPES.has(e.type));

// ---------------------------------------------------------------------------
// 1. 核心：终态 + 零锚点 + 有 delta ⇒ 恰一条合成项，字段逐项对
// ---------------------------------------------------------------------------
test('#300 终态+零锚点+有 delta ⇒ 恰一条 partial_output，seq=最后一条 delta 的 seq，正文按 delta seq 升序拼接', async () => {
  const s = await startServer();
  try {
    // ⚠ delta 的**插入顺序与 seq 故意不一致**（7 先插、6 后插）：拼接若靠插入顺序而非 SQL 的 ORDER BY，
    // 这条用例会红（排序断言才真承重）。
    s.pool.seedRun('r-partial', 'failed', { reason: 'aborted', partial: true });
    s.pool.seedEvent({ seq: 5, runId: 'r-partial', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 7, runId: 'r-partial', type: 'assistant_delta', payload: { text: '界' } });
    s.pool.seedEvent({ seq: 6, runId: 'r-partial', type: 'assistant_delta', payload: { text: '你好世' } });
    s.pool.seedEvent({ seq: 8, runId: 'r-partial', type: 'reasoning_delta', payload: { text: '思考不该参与' } });
    s.pool.seedEvent({ seq: 9, runId: 'r-partial', type: 'run_end', payload: { termination: { reason: 'aborted' } } });

    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1, `一条 run 至多一条合成项（body=${JSON.stringify(body)}）`);
    // issue #502 D-7：合成项的 `payload` 现在**原样取自那一行**，不再由读侧自己拼 ⇒ 载荷形状跟着写侧走：
    // 多出 `reasoning`/`uptoSeq`/`source`（additive，前端只读 `text`/`truncated`）。
    // `seq` 仍是「这条合成项在升序序列里的位置」，只是来源从「最后一条 delta 的 seq」换成「那一行自己的 seq」
    //（终态写入时它排在 `run_end` 之后 ⇒ 依旧落在历史末尾，#300 的位置语义没变）。
    assert.deepEqual(parts[0], {
      seq: 7,
      run_id: 'r-partial',
      type: 'partial_output',
      // `source: 'legacy'` 是本文件 fake 的折算标记（见文件头「夹具兼容折算」）；真库写侧写的是 `'terminal'`
      // 读侧只把它认识的键交给前端（`reasoning` 在载荷里但不外泄：前端只吃 text/chunks/truncated + 新增的 uptoSeq/source）
      payload: { text: '你好世界', uptoSeq: 7, chunks: 2, truncated: false, source: 'legacy' },
    });
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type]),
      [[5, 'round_start'], [7, 'partial_output'], [9, 'run_termination']],
      '合成项参与升序排序（排在 round_start 之后）；run_end 仍不下发，终态行改为从 runs 投影（#236）',
    );
    assert.equal(body.next_cursor, null);
    // #502 之前这条钉的是「合成项**不落库**」；#502 D-3 之后它落库了 ⇒ 断言换成「读侧不新增行」：
    // 本文件的夹具只播 delta 老行（折算只发生在 fake 的返回里，见文件头注释），
    // 真库那一行的存在性/唯一性由 `delta-not-persisted-db.test.js` 与
    // `internal-delta-not-persisted.test.js` 承重。
    assert.equal(s.pool.runEvents.filter((e) => e.type === 'partial_output').length, 0,
      '读侧不得往 run_events 里补写行（读路径只读不写）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 2. 有锚点的 run 绝不能再渲染一遍
// ---------------------------------------------------------------------------
test('#300 有助手锚点的 run ⇒ 一条都不出现（重复正文就是这个坑）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-done', status: 'finished', deltas: ['半截', '终稿'], anchor: { content: '完整终稿' } });
    const body = await s.history();
    assert.deepEqual(partialsOf(body), [], '有锚点 ⇒ 零合成项');
    assert.deepEqual(realsOf(body).map((e) => e.seq), [1], '真实事件不受影响');
  } finally {
    await s.close();
  }
});

test('#300 synthetic 助手锚点同样算「有正文」⇒ 不合成（判据含 synthetic=true 的行）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, {
      runId: 'r-syn', status: 'failed', deltas: ['一点'],
      anchor: { content: 'judge 注入的助手行', synthetic: true },
    });
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 3. 非终态三态各一例（「还在跑就标已中止」是新造的误导）
// ---------------------------------------------------------------------------
for (const status of ['queued', 'running', 'cancelling']) {
  test(`#300 非终态 ${status} ⇒ 不合成（三态各钉一条，别只测一个）`, async () => {
    const s = await startServer();
    try {
      seedAbortedRun(s.pool, { runId: `r-${status}`, status, deltas: ['还在跑'] });
      const body = await s.history();
      assert.deepEqual(partialsOf(body), [], `${status} 不是终态，不得标「已中止 · 部分输出」`);
    } finally {
      await s.close();
    }
  });
}

// ---------------------------------------------------------------------------
// 4. 正常 run（finished + judge_done + 有锚点）的反面
// ---------------------------------------------------------------------------
test('#300 finished + termination.reason=judge_done + 有锚点 ⇒ 不出现（正常 run 的反面）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, {
      runId: 'r-judge', status: 'finished', deltas: ['我干完了'],
      anchor: { content: '我干完了' },
    });
    s.pool.runs.find((r) => r.id === 'r-judge').termination = { reason: 'judge_done' };
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 上限截断
// ---------------------------------------------------------------------------
test('#300 超上限 ⇒ text 恰 2000 且 truncated=true，payload 里没有「已截断」文本（那是前端的活）', async () => {
  const s = await startServer();
  try {
    const deltas = Array.from({ length: 3 }, () => 'x'.repeat(1000)); // 3000 > 2000
    seedAbortedRun(s.pool, { runId: 'r-long', status: 'failed', deltas });
    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text.length, 2000, '截到恰 2000 字符');
    assert.equal(parts[0].payload.truncated, true);
    assert.equal(parts[0].payload.chunks, 3, 'chunks 记的是参与聚合的条数，不受截断影响');
    const raw = JSON.stringify(parts[0].payload);
    assert.ok(!raw.includes('已截断'), `截断标记由前端出，payload 不得塞文案：${raw.slice(0, 80)}`);
    assert.ok(!raw.includes('…'), '同样不得带省略号');
  } finally {
    await s.close();
  }
});

test('#300 恰好等于上限 ⇒ 不截断（边界不许误判）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-cap', status: 'failed', deltas: ['y'.repeat(2000)] });
    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts[0].payload.text.length, 2000);
    assert.equal(parts[0].payload.truncated, false);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 分页：whole-run 聚合 + 合成项不占 limit / 不动 next_cursor
// ---------------------------------------------------------------------------
test('#300 before 分页：窗口外的 delta 仍参与聚合（whole-run 口径）', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-page', 'failed');
    s.pool.seedEvent({ seq: 1, runId: 'r-page', type: 'assistant_delta', payload: { text: '窗口外的前半句' } });
    s.pool.seedEvent({ seq: 2, runId: 'r-page', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 3, runId: 'r-page', type: 'assistant_delta', payload: { text: '，窗口内的后半句' } });

    const paged = await s.history('?before=3');
    assert.deepEqual(realsOf(paged).map((e) => e.seq), [2], '窗口内只有白名单事件（seq<3 且可下发）');
    const parts = partialsOf(paged);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '窗口外的前半句，窗口内的后半句', '分页只决定真实事件，聚合范围是整个 run');
    assert.equal(parts[0].seq, 3, 'seq 仍是该 run 最后一条 delta（哪怕它在窗口外）');
  } finally {
    await s.close();
  }
});

test('#300 合成项不占 limit、不改 next_cursor/hasOlder（逐字比对「无合成项」的同数据）', async () => {
  const s = await startServer();
  try {
    // 候选 run（零锚点）+ 4 条白名单真实事件
    s.pool.seedRun('r-lim', 'failed');
    for (const seq of [1, 2, 3, 4]) s.pool.seedEvent({ seq, runId: 'r-lim', type: 'round_start', payload: { round: seq } });
    s.pool.seedEvent({ seq: 5, runId: 'r-lim', type: 'assistant_delta', payload: { text: '半截正文' } });

    const body = await s.history('?limit=1');
    assert.equal(realsOf(body).length, 1, 'limit 只数真实事件：合成项不占额度');
    assert.deepEqual(realsOf(body).map((e) => e.seq), [4]);
    assert.equal(partialsOf(body).length, 1, '合成项照常下发');
    assert.equal(body.next_cursor, 4, 'next_cursor 仍只由白名单真实事件决定');

    // 同数据加一条锚点 ⇒ 无合成项；分页字段必须**逐字相同**
    s.pool.seedMessage({ id: 'm-anchor', runId: 'r-lim', role: 'assistant', content: '终稿' });
    const noPartial = await s.history('?limit=1');
    assert.deepEqual(partialsOf(noPartial), []);
    assert.equal(noPartial.next_cursor, body.next_cursor, '合成项不得影响 next_cursor');
    assert.deepEqual(realsOf(noPartial).map((e) => e.seq), realsOf(body).map((e) => e.seq), '真实事件集合也不受影响');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 7. 成本红线：零候选 ⇒ 零额外查询
// ---------------------------------------------------------------------------
test('#300 成本红线：窗口里一个 run 都没有 ⇒ 一条额外查询都不许多发（fake 计数钉住）', async () => {
  const s = await startServer();
  try {
    // run_id 全为 null（宿主自身事件）⇒ 候选集为空
    s.pool.seedEvent({ seq: 1, runId: null, type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: null, type: 'judge', payload: { decision: { extend: false } } });

    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
    const extra = s.pool.sqlLog.filter(
      (sql) => /FROM runs r/.test(sql) || /type = 'assistant_delta'/.test(sql.replace(/\s+/g, ' ')),
    );
    assert.deepEqual(extra, [], `零候选会话每次刷新都走这条端点，不得多发候选判定/聚合查询：\n${extra.join('\n')}`);
    assert.ok(RUN_TERMINAL, '哨兵：终态常量集合的字面量（改 SQL 时这条会提醒你核对 fake 的正则）');
  } finally {
    await s.close();
  }
});

test('#300 成本红线：有 run 但全都有锚点 ⇒ 聚合查询（assistant_delta 那条）一条都不发', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-a', status: 'finished', deltas: ['a'], anchor: { content: 'a 的终稿' } });
    seedAbortedRun(s.pool, { runId: 'r-b', status: 'failed', deltas: ['b'], anchor: { content: 'b 的终稿' }, startSeq: 20 });
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
    const aggregates = s.pool.sqlLog.filter((sql) => /type = 'assistant_delta'/.test(sql.replace(/\s+/g, ' ')));
    assert.deepEqual(aggregates, [], '「只对终态且无锚点的 run 做聚合」——判据 2 落空就不得去捞 delta');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 8. 脏载荷
// ---------------------------------------------------------------------------
test('#300 脏载荷：delta 没有 text 键 / text 不是字符串 ⇒ 不炸、不把 [object Object] 拼进正文', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-dirty', 'failed');
    s.pool.seedEvent({ seq: 1, runId: 'r-dirty', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: 'r-dirty', type: 'assistant_delta', payload: { round: 3 } }); // 无 text 键
    s.pool.seedEvent({ seq: 3, runId: 'r-dirty', type: 'assistant_delta', payload: { text: 42 } }); // 非字符串
    s.pool.seedEvent({ seq: 4, runId: 'r-dirty', type: 'assistant_delta', payload: { text: { a: 1 } } });
    s.pool.seedEvent({ seq: 5, runId: 'r-dirty', type: 'assistant_delta', payload: null });
    s.pool.seedEvent({ seq: 6, runId: 'r-dirty', type: 'assistant_delta', payload: { text: '正常的一句' } });

    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '正常的一句', '脏片段整条跳过，不拼成 42/[object Object]/null');
    assert.equal(parts[0].payload.chunks, 1, 'chunks 只数真正参与拼接的片段');
    const raw = JSON.stringify(parts[0].payload);
    for (const junk of ['[object Object]', 'undefined', 'null', '{"a":1}', '42']) {
      assert.ok(!raw.includes(junk), `脏值 ${junk} 泄漏进正文：${raw}`);
    }
  } finally {
    await s.close();
  }
});

test('#300 聚合后正文为空 ⇒ 不合成（被停在 sleep 上的 run 本来就无正文可给）', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-empty', 'failed');
    s.pool.seedEvent({ seq: 1, runId: 'r-empty', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: 'r-empty', type: 'assistant_delta', payload: { text: '' } });
    s.pool.seedEvent({ seq: 3, runId: 'r-empty', type: 'assistant_delta', payload: { round: 1 } }); // 无 text
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 9. 跨 run 不串号
// ---------------------------------------------------------------------------
test('#300 同会话两个 run（一个有锚点、一个没有）⇒ 只出现没有锚点的那条，run_id 对得上', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-ok', status: 'finished', deltas: ['旧 run 的正文'], anchor: { content: '旧 run 终稿' } });
    seedAbortedRun(s.pool, { runId: 'r-abort', status: 'failed', deltas: ['新 run 说了一半'], startSeq: 30 });
    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1, '只有零锚点的那条 run 被合成');
    assert.equal(parts[0].run_id, 'r-abort');
    assert.equal(parts[0].payload.text, '新 run 说了一半', '不得把别的 run 的 delta 拼进来');
    assert.equal(parts[0].seq, 31);
  } finally {
    await s.close();
  }
});

test('#300 一条 run 的 delta 分散在多个窗口批次 ⇒ 每批都拿到 whole-run 正文，且每批至多一条', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-split', 'failed');
    s.pool.seedEvent({ seq: 1, runId: 'r-split', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: 'r-split', type: 'assistant_delta', payload: { text: '一' } });
    s.pool.seedEvent({ seq: 3, runId: 'r-split', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: {} } });
    s.pool.seedEvent({ seq: 4, runId: 'r-split', type: 'assistant_delta', payload: { text: '二' } });

    const p1 = await s.history('?limit=1');
    const p2 = await s.history(`?limit=1&before=${p1.next_cursor}`);
    for (const [label, page] of [['page1', p1], ['page2', p2]]) {
      const parts = partialsOf(page);
      assert.equal(parts.length, 1, `${label} 至多一条合成项`);
      assert.equal(parts[0].payload.text, '一二', `${label} 正文是整个 run 的聚合`);
    }
  } finally {
    await s.close();
  }
});
