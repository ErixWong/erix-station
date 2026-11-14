// issue #300：GET /api/sessions/:id/events/history 的**合成项** `partial_output`（只读重建）。
// 缺陷：runner 的 catch 固定 `final_text:''` ⇒ 被停止/失败的 run 在 messages 里**零助手锚点**，
// 而正文区只从锚点渲染 ⇒ 界面上这次 run 一片空白。修法：本**只读**端点给该 run 下发**一条**
// 合成项 `partial_output`。
//
// **issue #502 形态 M 改了取数来源，本文件的夹具跟着改（每处理由写在改动点旁边）**：
//   * 来源 = **两处已有的 durable 正文**，按顺序拼：
//       ① `type='round_end'` 行的 `payload.final_text`（**已完成轮次**的终稿，按 seq 升序）；
//       ② `type='run_end'` 行的 `payload.partial_text`（**停止时那半轮**，由终态事务写进既有那一行）。
//     上一版（D-7）读的「那一行 `type='partial_output'`」在形态 M 里**根本不存在了**（不新增行类型），
//     于是 fake 里那条分派与「夹具兼容折算」一起删掉。
//   * `seedAbortedRun` 的 `deltas` 参数**语义跟着来源走**：它现在播的是若干条 `round_end` 行
//     （每片 = 一轮的 `final_text`），另有 `partial` 参数播 `run_end.partial_text`。
//     「几片拼成一句」的断言仍然承重，只是断的是「读侧按 seq 升序拼两处」而不是「读一行」。
//   * 上限从 2000 抬到 **65536**（`PARTIAL_PROJECTION_TEXT_CAP`）：2000 会咬「刷新后逐字完整」
//     这条红线（真库现查 `round_end.final_text` 最长 31,707）⇒ 原「恰 2000」两条用例换成 65536 口径。
//   * **占位搬进本文件**（原来在 SSE 补发通路）：两处正文都没有 ⇒ 合成项带 `placeholder: true`
//     （#278 底线：中止态不许留空白）。
//   * 成本红线的 SQL 正则从 `type = 'partial_output'` / `type = 'assistant_delta'` 改成
//     `type IN ('round_end', 'run_end')`：不改就成了**恒真**的空断言（regex 永不命中 ⇒ 看着绿其实没测）。
//   * **M-6④ 新增**：合成项只许在它 `seq` 所属的那一页出现（`before` 分页不重复给）。
// 判据（缺一不合成）：① 该 run 出现在本次响应窗口里；② runs.status IN ('finished','failed')
// 且该 run 零助手锚点（含 synthetic 行）；③ 两处正文拼出非空文本，否则出占位。
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
const PROJECTION_SQL = /type IN \('round_end', 'run_end'\)/;

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

    // 形态 M 的取数：SELECT run_id, seq, type, payload FROM run_events
    //   WHERE run_id = ANY($1) AND type IN ('round_end', 'run_end') ORDER BY run_id, seq
    // ⚠ 这条分派必须排在下面的「主窗口」之前（主窗口也含 FROM run_events）。
    if (flat.includes('run_events') && PROJECTION_SQL.test(flat)) {
      const ids = params[0] ?? [];
      // `run_end` 每 run 至多一行由库面既有约束 `run_events_run_end_key` 兜（不是本单新增的索引）；
      // fake 照真库**允许**多行返回 ⇒ 代码若真拿到两行 `run_end`，行为要由用例承重（见下面那一条）。
      const rows = this.runEvents.filter((e) => ids.includes(e.run_id) && (e.type === 'round_end' || e.type === 'run_end'));
      // **按 SQL 文本决定要不要排序**（AGENTS §8.14：fake 不得好心兼平）：代码删了 ORDER BY
      // 就得拿到插入序，而夹具的插入序与 seq 序故意不一致 ⇒ 拼接顺序用例会真红。
      const ordered = /ORDER BY run_id, seq/.test(flat);
      if (ordered) rows.sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : a.seq - b.seq));
      return { rows };
    }

    // 上一版（#502 D-7）的取数：读那一行 `partial_output`。形态 M 不再发这条 SQL，留着分派只为
    // **变异测试**服务：产品代码若退回「读那一行」，它照样能拿到行（旧库里确实还有存量），
    // 但 `payload` 里没有 `partial_text`/`final_text` 那两个键 ⇒ 本文件的断言会红。
    if (flat.includes('run_events') && flat.includes("type = 'partial_output'")) {
      const ids = params[0] ?? [];
      return { rows: this.runEvents.filter((e) => ids.includes(e.run_id) && e.type === 'partial_output') };
    }

    // 最早那版（#502 之前）：聚合整 run 的 assistant_delta。同样只为变异测试留着（理由同上）。
    if (flat.includes('run_events') && flat.includes("type = 'assistant_delta'")) {
      const ids = params[0] ?? [];
      return { rows: this.runEvents.filter((e) => ids.includes(e.run_id) && e.type === 'assistant_delta') };
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
 * 造一个「被停在半路」的 run：终态 + 零锚点 + **两处 durable 正文**（形态 M 的形状）。
 * `deltas` 的语义（改动点，理由见文件头）：每一项 = **一条已完成轮次**的 `round_end.payload.final_text`
 * （播成独立一行，按 seq 升序 ⇒ 「按 seq 拼」与「按插入序拼」在夹具里可区分）。
 * `partial` = `run_end.payload.partial_text`（停止时那半轮，同一行里带 `termination`）。
 */
function seedAbortedRun(pool, {
  runId = 'r-partial', status = 'failed', deltas = [], partial = null,
  anchor = null, startSeq = 1, extraEvents = [], termination = { reason: 'aborted' },
}) {
  pool.seedRun(runId, status, termination);
  let seq = startSeq;
  pool.seedEvent({ seq: seq++, runId, type: 'round_start', payload: { round: 1 } });
  deltas.forEach((text, i) => {
    pool.seedEvent({ seq: seq++, runId, type: 'round_end', payload: { round: i + 1, final_text: text } });
  });
  for (const extra of extraEvents) pool.seedEvent({ seq: seq++, runId, ...extra });
  const runEndPayload = { termination };
  if (typeof partial === 'string' && partial !== '') runEndPayload.partial_text = partial;
  pool.seedEvent({ seq: seq++, runId, type: 'run_end', payload: runEndPayload });
  if (anchor) pool.seedMessage({ id: `${runId}-msg`, runId, ...anchor });
  return { pool, lastSeq: seq - 1 };
}

const partialsOf = (body) => body.events.filter((e) => e.type === 'partial_output');
// 「真实事件」= 白名单里的落库事件。两个响应期合成项（#300 `partial_output` / #236 `run_termination`）
// 都不是 `run_events` 的行 ⇒ 一并排除（否则 #300 的既有断言会把合成项当真实事件数进去）。
const SYNTH_TYPES = new Set(['partial_output', 'run_termination']);
const realsOf = (body) => body.events.filter((e) => !SYNTH_TYPES.has(e.type));

// ---------------------------------------------------------------------------
// 1. 核心：终态 + 零锚点 + 有正文 ⇒ 恰一条合成项，字段逐项对
// ---------------------------------------------------------------------------
test('#300 终态+零锚点+有 round_end 终稿 ⇒ 恰一条 partial_output，seq=该 run 的最大 seq，正文按 seq 升序拼接', async () => {
  const s = await startServer();
  try {
    // ⚠ 两条 round_end 的**插入顺序与 seq 故意不一致**（7 先插、6 后插）：拼接若靠插入顺序而非
    // SQL 的 ORDER BY，这条用例会红（排序断言才真承重）。
    s.pool.seedRun('r-partial', 'failed', { reason: 'aborted', partial: true });
    s.pool.seedEvent({ seq: 5, runId: 'r-partial', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 7, runId: 'r-partial', type: 'round_end', payload: { round: 2, final_text: '界' } });
    s.pool.seedEvent({ seq: 6, runId: 'r-partial', type: 'round_end', payload: { round: 1, final_text: '你好世' } });
    s.pool.seedEvent({ seq: 8, runId: 'r-partial', type: 'reasoning_delta', payload: { text: '思考不该参与' } });
    s.pool.seedEvent({ seq: 9, runId: 'r-partial', type: 'run_end', payload: { termination: { reason: 'aborted' } } });

    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1, `一条 run 至多一条合成项（body=${JSON.stringify(body)}）`);
    // 形态 M：载荷由**两处**拼成 ⇒ 键也跟着变（`chunks` 现在数的是「拼了几轮终稿」，
    // `source` 说清来源；上一版的 `uptoSeq`/`reasoning` 随水位线一起删除）。
    assert.deepEqual(parts[0], {
      seq: 9, // 该 run 的最大 seq（`loadWindowRuns` 的 `last_seq`，**不新分配**）⇒ 排在本次 run 内容之后
      run_id: 'r-partial',
      type: 'partial_output',
      payload: { text: '你好世界', chunks: 2, truncated: false, source: 'round_end' },
    });
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type]),
      [[5, 'round_start'], [6, 'round_end'], [7, 'round_end'], [9, 'partial_output'], [9, 'run_termination']],
      '合成项参与升序排序（排在两轮 round_end 之后）；run_end 仍不下发，终态行改为从 runs 投影（#236）。'
      + '两个合成项同 seq（都取该 run 的 MAX(seq)）⇒ 同 seq 时正文在前、分隔条在后（mergeSynthItemsBySeq 的插入序）',
    );
    assert.equal(body.next_cursor, null);
    // 「读侧不落库」这条红线不变：形态 M 里连 `partial_output` 那种行都不再有。
    assert.equal(s.pool.runEvents.filter((e) => e.type === 'partial_output').length, 0,
      '读侧不得往 run_events 里补写行（读路径只读不写）');
  } finally {
    await s.close();
  }
});

test('#502 判据 5（形态 M 的核心）：两处都读 —— round_end 终稿在前、run_end.partial_text 拼在后面', async () => {
  const s = await startServer();
  try {
    // 真机形态：跑了 2 轮（都有终稿），第 3 轮正在输出时被停止 ⇒ 半截只在 `run_end.partial_text` 里。
    seedAbortedRun(s.pool, { runId: 'r-two', deltas: ['第一轮说完。', '第二轮说完。'], partial: '第三轮说到一半' });
    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '第一轮说完。第二轮说完。第三轮说到一半',
      '顺序不能反：已说完的话 + 说到一半的话（反了就是界面上从没出现过的顺序）');
    assert.equal(parts[0].payload.chunks, 2, 'chunks = 拼了几轮终稿（碎片级计数已随 #502 消失）');
    assert.equal(parts[0].payload.source, 'round_end+run_end');
    assert.equal(parts[0].payload.truncated, false);
  } finally {
    await s.close();
  }
});

test('#502：只有 run_end.partial_text（第一轮就被停止）⇒ 也合成，source=run_end', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-e1', deltas: [], partial: '刚开口就被打断' });
    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '刚开口就被打断');
    assert.equal(parts[0].payload.source, 'run_end');
    assert.equal(parts[0].payload.chunks, 0);
  } finally {
    await s.close();
  }
});

test('#502：run_end 只认 partial_text 键 —— 不拿 termination/error 的文案当正文', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-keys', 'failed', { reason: 'aborted', detail: '用户点了停止' });
    s.pool.seedEvent({ seq: 1, runId: 'r-keys', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({
      seq: 2, runId: 'r-keys', type: 'run_end',
      payload: { termination: { reason: 'aborted', detail: '用户点了停止' }, error: { message: 'aborted by user' }, partial_text: '说到一半' },
    });
    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '说到一半', '只取 partial_text；reason/detail/error 都不是正文（拿它们填正文就是编内容）');
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
    assert.deepEqual(realsOf(body).map((e) => e.seq), [1, 2, 3], '真实事件不受影响');
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
      anchor: { content: '我干完了' }, termination: { reason: 'judge_done' },
    });
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 5. 上限截断（形态 M：投影上限 65536，不是旧的 2000）
// ---------------------------------------------------------------------------
test('#502 判据 3：停止前 5000 字符（> 旧上限 2000）刷新后**逐字完整**，不被截成 2000', async () => {
  const s = await startServer();
  try {
    const long = '甲'.repeat(5000); // 中文取三字节字符，顺带钉住"按字符切而不是按字节切"
    seedAbortedRun(s.pool, { runId: 'r-5k', status: 'failed', deltas: [], partial: long });
    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text.length, 5000, '旧上限 2000 会把这段砍掉（#278 红线：刷新后不许比停止前少）');
    assert.equal(parts[0].payload.text, long, '逐字完整');
    assert.equal(parts[0].payload.truncated, false);
  } finally {
    await s.close();
  }
});

test('#502 投影上限 65536 ⇒ 超了才截，text 恰 65536 且 truncated=true（payload 里没有「已截断」文案）', async () => {
  const s = await startServer();
  try {
    const partsIn = Array.from({ length: 3 }, () => 'x'.repeat(30_000)); // 90,000 > 65,536
    seedAbortedRun(s.pool, { runId: 'r-long', status: 'failed', deltas: partsIn });
    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text.length, 65536, '截到恰 65536 字符');
    assert.equal(parts[0].payload.truncated, true);
    assert.equal(parts[0].payload.chunks, 3, 'chunks 记参与拼接的轮次数，不受截断影响');
    const raw = JSON.stringify(parts[0].payload);
    assert.ok(!raw.includes('已截断'), `截断标记由前端出，payload 不得塞文案：${raw.slice(0, 80)}`);
    assert.ok(!raw.includes('…'), '同样不得带省略号');
  } finally {
    await s.close();
  }
});

test('#502 边界：恰好 65536 ⇒ 不截断（边界不许误判）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-cap', status: 'failed', deltas: [], partial: 'y'.repeat(65536) });
    const parts = partialsOf(await s.history());
    assert.equal(parts[0].payload.text.length, 65536);
    assert.equal(parts[0].payload.truncated, false);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 6. 分页：whole-run 口径 + 合成项不占 limit / 不动 next_cursor / 只出现在所属页
// ---------------------------------------------------------------------------
test('#502 M-6④：合成项只在它 seq 所属的那一页出现（before 分页不跨页重复给同一个 run）', async () => {
  const s = await startServer();
  try {
    // 一个 run 的事件横跨两页：seq 1..5（合成项的 seq = 5 = 该 run 的最大 seq）
    s.pool.seedRun('r-page', 'failed', { reason: 'aborted' });
    s.pool.seedEvent({ seq: 1, runId: 'r-page', type: 'round_end', payload: { round: 1, final_text: '前半句' } });
    for (const seq of [2, 3, 4]) s.pool.seedEvent({ seq, runId: 'r-page', type: 'round_start', payload: { round: seq } });
    s.pool.seedEvent({ seq: 5, runId: 'r-page', type: 'round_end', payload: { round: 4, final_text: '后半句' } });

    const newest = await s.history('?limit=2');
    assert.equal(partialsOf(newest).length, 1, '最新那一页（含 seq 5）拿到合成项');
    assert.equal(partialsOf(newest)[0].payload.text, '前半句后半句', '正文仍是 whole-run 口径（取数不受分页影响）');

    const older = await s.history(`?limit=2&before=${newest.next_cursor}`);
    assert.ok(realsOf(older).length > 0, '上一页仍有真实事件');
    assert.deepEqual(partialsOf(older), [],
      '同一 run 的合成项不得在上一页再给一份：它的 seq(=5) 属于更新的那一页（#502 审计第 4 条 —— '
      + '`last_seq` 是 MAX(seq)，不受 before 约束，不拦就是往上翻一页正文重演一遍）');
  } finally {
    await s.close();
  }
});

test('#300 before 分页：窗口外的 round_end 仍参与拼接（whole-run 口径）', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-win', 'failed', { reason: 'aborted' });
    s.pool.seedEvent({ seq: 1, runId: 'r-win', type: 'round_end', payload: { round: 1, final_text: '窗口外的前半句' } });
    s.pool.seedEvent({ seq: 2, runId: 'r-win', type: 'round_start', payload: { round: 2 } });
    s.pool.seedEvent({ seq: 3, runId: 'r-win', type: 'round_end', payload: { round: 2, final_text: '，窗口内的后半句' } });

    const paged = await s.history('?before=4');
    assert.deepEqual(realsOf(paged).map((e) => e.seq), [1, 2, 3], '窗口内只有白名单事件（seq<4）');
    const parts = partialsOf(paged);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '窗口外的前半句，窗口内的后半句', '分页只决定真实事件，取数范围是整个 run');
    assert.equal(parts[0].seq, 3, 'seq 仍是该 run 的最大 seq（哪怕合成项落在窗口外那条的后面）');
  } finally {
    await s.close();
  }
});

test('#300 合成项不占 limit、不改 next_cursor/hasOlder（逐字比对「无合成项」的同数据）', async () => {
  const s = await startServer();
  try {
    // 候选 run（零锚点）+ 4 条白名单真实事件 + 一处正文
    s.pool.seedRun('r-lim', 'failed', { reason: 'aborted' });
    for (const seq of [1, 2, 3, 4]) s.pool.seedEvent({ seq, runId: 'r-lim', type: 'round_start', payload: { round: seq } });
    // 正文改用 `round_end`（形态 M 的取数源），它**本来就在**下发白名单里 ⇒ 最新一条真实事件是 seq 5
    //（旧夹具的正文是 `assistant_delta`，不在白名单 ⇒ 那时是 4。断言跟着数据走，意图没变：
    //  limit 只数真实事件、next_cursor 不受合成项影响）。
    s.pool.seedEvent({ seq: 5, runId: 'r-lim', type: 'round_end', payload: { round: 4, final_text: '半截正文' } });

    const body = await s.history('?limit=1');
    assert.equal(realsOf(body).length, 1, 'limit 只数真实事件：合成项不占额度');
    assert.deepEqual(realsOf(body).map((e) => e.seq), [5]);
    assert.equal(partialsOf(body).length, 1, '合成项照常下发');
    assert.equal(body.next_cursor, 5, 'next_cursor 仍只由白名单真实事件决定');

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
      (sql) => {
        const flat = sql.replace(/\s+/g, ' ');
        return /FROM runs r/.test(flat) || /type = 'assistant_delta'/.test(flat) || PROJECTION_SQL.test(flat);
      },
    );
    assert.deepEqual(extra, [], `零候选会话每次刷新都走这条端点，不得多发候选判定/取数查询：\n${extra.join('\n')}`);
    assert.ok(RUN_TERMINAL, '哨兵：终态常量集合的字面量（改 SQL 时这条会提醒你核对 fake 的正则）');
  } finally {
    await s.close();
  }
});

test('#502 成本红线：有候选 run ⇒ 取数恰好**一条**查询（走 run_id = ANY，零新索引）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-a', status: 'failed', deltas: ['a'], startSeq: 1 });
    seedAbortedRun(s.pool, { runId: 'r-b', status: 'failed', deltas: ['b'], startSeq: 20 });
    const body = await s.history();
    assert.equal(partialsOf(body).length, 2);
    const fetches = s.pool.sqlLog.filter((sql) => PROJECTION_SQL.test(sql.replace(/\s+/g, ' ')));
    assert.equal(fetches.length, 1, `两个候选 run 也只打一条 run_id = ANY(...) 的查询：\n${fetches.join('\n')}`);
    assert.match(fetches[0], /run_id = ANY\(\$1\)/, '成本口径：批量取数，不是每 run 一枪');
  } finally {
    await s.close();
  }
});

test('#300 成本红线：有 run 但全都有锚点 ⇒ 取数查询一条都不发', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-a', status: 'finished', deltas: ['a'], anchor: { content: 'a 的终稿' } });
    seedAbortedRun(s.pool, { runId: 'r-b', status: 'failed', deltas: ['b'], anchor: { content: 'b 的终稿' }, startSeq: 20 });
    const body = await s.history();
    assert.deepEqual(partialsOf(body), []);
    const fetches = s.pool.sqlLog.filter((sql) => PROJECTION_SQL.test(sql.replace(/\s+/g, ' ')));
    assert.deepEqual(fetches, [], '「只对终态且无锚点的 run 做取数」——判据落空就不得去捞正文');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 8. 脏载荷
// ---------------------------------------------------------------------------
test('#300 脏载荷：final_text 缺键 / 不是字符串 ⇒ 不炸、不把 [object Object] 拼进正文', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-dirty', 'failed', { reason: 'aborted' });
    s.pool.seedEvent({ seq: 1, runId: 'r-dirty', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: 'r-dirty', type: 'round_end', payload: { round: 2 } }); // 无 final_text 键
    s.pool.seedEvent({ seq: 3, runId: 'r-dirty', type: 'round_end', payload: { final_text: 42 } }); // 非字符串
    s.pool.seedEvent({ seq: 4, runId: 'r-dirty', type: 'round_end', payload: { final_text: { a: 1 } } });
    s.pool.seedEvent({ seq: 5, runId: 'r-dirty', type: 'round_end', payload: null });
    s.pool.seedEvent({ seq: 6, runId: 'r-dirty', type: 'round_end', payload: { final_text: '正常的一句' } });

    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1);
    assert.equal(parts[0].payload.text, '正常的一句', '脏片段整条跳过，不拼成 42/[object Object]/null');
    assert.equal(parts[0].payload.chunks, 1, 'chunks 只数真正参与拼接的轮次');
    const raw = JSON.stringify(parts[0].payload);
    for (const junk of ['[object Object]', 'undefined', 'null', '{"a":1}', '42']) {
      assert.ok(!raw.includes(junk), `脏值 ${junk} 泄漏进正文：${raw}`);
    }
  } finally {
    await s.close();
  }
});

test('#502 占位（#278 底线，从 SSE 通路搬来）：两处正文都没有 ⇒ placeholder:true，不是空白也不是空气泡', async () => {
  const s = await startServer();
  try {
    // 被停在 `sleep` 上的 run：一轮都没说完（round_end 的 final_text 是空串），也没有 partial_text
    s.pool.seedRun('r-empty', 'failed', { reason: 'aborted' });
    s.pool.seedEvent({ seq: 1, runId: 'r-empty', type: 'round_start', payload: { round: 1 } });
    s.pool.seedEvent({ seq: 2, runId: 'r-empty', type: 'round_end', payload: { round: 1, final_text: '' } });
    s.pool.seedEvent({ seq: 3, runId: 'r-empty', type: 'round_end', payload: { round: 2 } });
    s.pool.seedEvent({ seq: 4, runId: 'r-empty', type: 'run_end', payload: { termination: { reason: 'aborted' } } });

    const parts = partialsOf(await s.history());
    assert.equal(parts.length, 1, '旧行为是「不合成」⇒ 界面一片空白（#278 那条红线就是在这里输的）');
    assert.deepEqual(parts[0], {
      seq: 4, run_id: 'r-empty', type: 'partial_output',
      payload: { text: '', chunks: 0, truncated: false, placeholder: true, source: 'none' },
    });
  } finally {
    await s.close();
  }
});

test('#502：有锚点的 run 就算两处都没正文 ⇒ 也不出占位（不拿提示冒充内容）', async () => {
  const s = await startServer();
  try {
    seedAbortedRun(s.pool, { runId: 'r-anchor-empty', status: 'failed', deltas: [], anchor: { content: '完整终稿' } });
    assert.deepEqual(partialsOf(await s.history()), []);
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
    seedAbortedRun(s.pool, { runId: 'r-abort', status: 'failed', deltas: [], partial: '新 run 说了一半', startSeq: 30 });
    const body = await s.history();
    const parts = partialsOf(body);
    assert.equal(parts.length, 1, '只有零锚点的那条 run 被合成');
    assert.equal(parts[0].run_id, 'r-abort');
    assert.equal(parts[0].payload.text, '新 run 说了一半', '不得把别的 run 的正文拼进来');
    assert.equal(parts[0].seq, 31, 'seq = 该 run 的最大 seq（run_end 那一行 = 31，不新分配）');
  } finally {
    await s.close();
  }
});

test('#502 M-6④：一条 run 的事件分散在多个窗口批次 ⇒ **只有所属那一批**给正文（每批至多一条）', async () => {
  const s = await startServer();
  try {
    s.pool.seedRun('r-split', 'failed', { reason: 'aborted' });
    s.pool.seedEvent({ seq: 1, runId: 'r-split', type: 'round_end', payload: { round: 1, final_text: '一' } });
    s.pool.seedEvent({ seq: 2, runId: 'r-split', type: 'tool_use', payload: { tool_call_id: 'c1', name: 'bash', input: {} } });
    s.pool.seedEvent({ seq: 3, runId: 'r-split', type: 'round_end', payload: { round: 2, final_text: '二' } });

    const p1 = await s.history('?limit=1');
    const p2 = await s.history(`?limit=1&before=${p1.next_cursor}`);
    // 改写的旧断言：两页都断「拿到 whole-run 正文」。形态 M 反过来（审计第 4 条）：
    // 合成项的 seq = MAX(seq) = 3 ⇒ 属于**最新那一页**；旧版在两页都发 ⇒ 往上翻一页正文重演一遍。
    assert.equal(partialsOf(p1).length, 1, 'page1（含 seq 3）给正文');
    assert.equal(partialsOf(p1)[0].payload.text, '一二', '正文仍是 whole-run 口径');
    assert.equal(partialsOf(p2).length, 0, 'page2 不再重复给同一个 run 的合成项');
  } finally {
    await s.close();
  }
});
