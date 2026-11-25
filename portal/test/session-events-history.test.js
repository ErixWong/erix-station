// issue #89：GET /api/sessions/:id/events/history —— run_events 展示类事件历史端点测试：
//   白名单过滤（运行态语义事件不下发）、seq 升序 + 字段形状、keyset 分页（limit/before/
//   next_cursor）、limit 上限钳制与参数校验、payload 字符串叶值截断、鉴权（未登录 401 /
//   非属主 404，不泄露存在性）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
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
const OTHER_USER = {
  id: '00000000-0000-4000-8000-0000000000b2', login: 'bob', display_name: 'bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-2222-4222-8222-abcdefabcdef';
const OTHER_SESSION_ID = 'a1b2c3d4-3333-4333-8333-abcdefabcdef';
const TOKEN = 'tok-events-history-test';

/** run_events 内存表 + 归属查询（按 SQL 特征分发，白名单/分页由被测 SQL 语义在 JS 侧复刻）。 */
class EventsHistoryPool extends FakePool {
  constructor() {
    super({ users: [USER, OTHER_USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.chatSessions = [
      { id: SESSION_ID, user_id: USER.id, status: 'active' },
      { id: OTHER_SESSION_ID, user_id: OTHER_USER.id, status: 'active' },
    ];
    this.runEvents = [];
    // issue #236：runs 表（终态分隔条的投影源；messages 本文件不种，恒空 ⇒ #300 的锚点判据恒 false）
    this.runs = []; // {id, session_id, status, termination}
    this.sqlLog = []; // 每条查询的 SQL 文本（#236 成本红线用）
  }

  seed(ev) { this.runEvents.push({ run_id: 'r1', payload: {}, ...ev }); }

  /** issue #236：种一条 run（status/termination 是终态投影的唯一真值源）。 */
  seedRun(id, status, termination = null) {
    this.runs.push({ id, session_id: SESSION_ID, status, termination });
    return this;
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql);
    const flat = sql.replace(/\s+/g, ' ').trim();
    // 归属校验（status='active' 口径同 fetchSession）
    if (sql.includes('FROM chat_sessions WHERE id') && sql.includes("status = 'active'")) {
      return {
        rows: this.chatSessions.filter((s) => s.id === params[0] && s.user_id === params[1] && s.status === 'active'),
      };
    }
    // issue #236：窗口内 run 的终态信息（#300 的候选判定与终态投影**共用同一条** SQL）：
    //   SELECT r.id AS run_id, r.status, r.termination,
    //          (SELECT MAX(e.seq) FROM run_events e WHERE e.run_id = r.id) AS last_seq,
    //          EXISTS(...) AS has_anchor
    //     FROM runs r WHERE r.id = ANY($1) AND r.status IN ('finished','failed')
    if (flat.includes('FROM runs r')) {
      const ids = params[0] ?? [];
      let rows = this.runs.filter((r) => ids.includes(r.id));
      // 真按 SQL 里的状态集合过滤（变异把这段删掉 ⇒ 三态用例必红，不是假绿）
      const statusClause = flat.match(/r\.status IN \(([^)]*)\)/);
      if (statusClause) {
        const allowed = statusClause[1].split(',').map((s) => s.trim().replace(/'/g, ''));
        rows = rows.filter((r) => allowed.includes(r.status));
      }
      return {
        rows: rows.map((r) => ({
          run_id: r.id,
          status: r.status,
          termination: r.termination ?? null,
          // MAX(seq) 真算：run_events 里**所有**行都算（含白名单外的 run_end / assistant_delta）
          last_seq: this.runEvents
            .filter((e) => e.run_id === r.id && e.session_id === SESSION_ID)
            .reduce((max, e) => (max === null || e.seq > max ? e.seq : max), null),
          has_anchor: flat.includes('FROM messages m') ? false : null,
        })),
      };
    }
    // issue #514：**候选发现**（页内的终态行只用来发现 run id 与分页游标，那一行本身不下发）：
    //   SELECT run_id, seq FROM run_events
    //    WHERE session_id = $1 AND type = 'run_end' AND seq >= $2 [AND seq < $n]
    //    ORDER BY seq DESC LIMIT $k        // k = limit + 1（多取一行探针，探「窗口之下还有没有」）
    // ⚠ 必须排在下面的「主窗口」分支之前（主窗口也含 FROM run_events）。
    // 照 SQL 文本真算：产品代码撤掉 `seq >= $2` 这道页界，fake 就不夹下界；撤掉
    // ORDER BY 就拿插入序；把 LIMIT 的 `+1` 探针改成 `limit`，fake 就多返一行 ⇒ 都别心平。
    if (/FROM run_events/.test(flat) && flat.includes("type = 'run_end'")) {
      const sessionId = params[0];
      const lowMatch = flat.match(/seq >= \$(\d+)/);
      const low = lowMatch ? params[Number(lowMatch[1]) - 1] : null;
      const beforeMatch = flat.match(/seq < \$(\d+)/);
      const upper = beforeMatch ? params[Number(beforeMatch[1]) - 1] : null;
      const limitMatch = flat.match(/LIMIT \$(\d+)/);
      const cap = limitMatch ? params[Number(limitMatch[1]) - 1] : null;
      let rows = this.runEvents.filter((e) => e.session_id === sessionId && e.type === 'run_end');
      if (low != null) rows = rows.filter((e) => e.seq >= low);
      if (upper != null) rows = rows.filter((e) => e.seq < upper);
      if (/ORDER BY seq DESC/.test(flat)) rows = rows.slice().sort((a, b) => b.seq - a.seq);
      if (cap != null) rows = rows.slice(0, cap);
      return { rows: rows.map((e) => ({ run_id: e.run_id, seq: e.seq })) };
    }
    if (sql.includes('FROM run_events')) {
      const sessionId = params[0];
      const types = params[1]; // ANY($2) 数组
      let rows = this.runEvents.filter((e) => e.session_id === sessionId && types.includes(e.type));
      let idx = 2;
      if (sql.includes('seq < $3')) { rows = rows.filter((e) => e.seq < params[idx]); idx += 1; }
      const limit = params[params.length - 1];
      rows = rows.slice().sort((a, b) => b.seq - a.seq).slice(0, limit);
      return { rows };
    }
    return super.query(sql, params);
  }
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-events-hist-'));
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
  const pool = new EventsHistoryPool();
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool,
    base,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

/** 造一个展示类事件的最小合法 payload。 */
function ev(seq, type, payload = {}, sessionId = SESSION_ID) {
  return { session_id: sessionId, seq, type, payload };
}

test('白名单过滤 + seq 升序 + 字段形状：运行态语义事件（run_end/usage/checkpoint/assistant_delta）不下发', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'round_start', { round: 1 }));
    s.pool.seed(ev(2, 'tool_use', { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } }));
    s.pool.seed(ev(3, 'assistant_delta', { text: '半截' })); // 白名单外
    s.pool.seed(ev(4, 'checkpoint', { round: 1 })); // 白名单外
    s.pool.seed(ev(5, 'tool_result', { tool_call_id: 'c1', ok: true, result_digest: 'ok', duration_ms: 7 }));
    s.pool.seed(ev(6, 'judge', { decision: { extend: false, extendReason: '够用了' } }));
    s.pool.seed(ev(7, 'usage', { usage: { input_tokens: 1 } })); // 白名单外
    s.pool.seed(ev(8, 'run_end', { run_id: 'r1', termination: { reason: 'end_turn' } })); // 白名单外（状态机安全）
    s.pool.seed(ev(9, 'compaction', { round: 2, compaction: { foldedRounds: 1, tokensBefore: 9, tokensAfter: 3 } }));

    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type]),
      [[1, 'round_start'], [2, 'tool_use'], [5, 'tool_result'], [6, 'judge'], [9, 'compaction']],
      '仅展示类事件、按 seq 升序',
    );
    const tu = body.events.find((e) => e.type === 'tool_use');
    assert.equal(tu.seq, 2);
    assert.equal(tu.run_id, 'r1');
    assert.deepEqual(tu.payload, { tool_call_id: 'c1', name: 'bash', input: { cmd: 'ls' } });
    assert.equal(body.next_cursor, null, '无更早批次');
  } finally {
    await s.close();
  }
});

test('鉴权：未登录 401；非属主/不存在 404（不泄露存在性）', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'tool_use', { tool_call_id: 'c1', name: 'bash', input: {} }));

    const noAuth = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`);
    assert.equal(noAuth.status, 401);

    const foreign = await fetch(`${s.base}/api/sessions/${OTHER_SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader }, // alice 的 cookie 查 bob 的 session
    });
    assert.equal(foreign.status, 404);

    const missing = await fetch(`${s.base}/api/sessions/00000000-0000-4000-8000-000000000000/events/history`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test('分页：limit 取最新 N 条（升序返回）+ next_cursor；before 游标取更早批次', async () => {
  const s = await startServer();
  try {
    for (let i = 1; i <= 5; i++) s.pool.seed(ev(i, 'tool_use', { tool_call_id: `c${i}`, name: 't', input: {} }));

    const page1 = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history?limit=2`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(page1.events.map((e) => e.seq), [4, 5], '默认取最新一批、升序返回');
    assert.equal(page1.next_cursor, 4);

    const page2 = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history?limit=2&before=${page1.next_cursor}`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(page2.events.map((e) => e.seq), [2, 3]);
    assert.equal(page2.next_cursor, 2);

    const page3 = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history?limit=2&before=${page2.next_cursor}`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(page3.events.map((e) => e.seq), [1]);
    assert.equal(page3.next_cursor, null, '批次不满 limit → 无更早批次');
  } finally {
    await s.close();
  }
});

test('参数校验：limit/before 非正整数 → 400 validation_failed；超大 limit 钳到上限', async () => {
  const s = await startServer();
  try {
    for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'before=0', 'before=xyz']) {
      const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history?${q}`, {
        headers: { Cookie: s.cookieHeader },
      });
      assert.equal(res.status, 400, q);
      assert.equal((await res.json()).error.code, 'validation_failed', q);
    }

    // 2001 条展示类事件：limit=99999 钳到 2000 上限，next_cursor 指向最早一条
    for (let i = 1; i <= 2001; i++) s.pool.seed(ev(i, 'judge', { decision: { extend: true } }));
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history?limit=99999`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.events.length, 2000);
    assert.equal(body.events[0].seq, 2, '最新 2000 条（seq 2..2001），升序');
    assert.equal(body.events[1999].seq, 2001);
    assert.equal(body.next_cursor, 2);
  } finally {
    await s.close();
  }
});

// erix-agent #182（0.18.0）：新增诊断事件 `model_metadata_missing` 已在历史回放白名单里
// （SSE 实时能看到、刷新后也必须在），且它不会把运行态语义事件带进回放。
test('白名单含 model_metadata_missing（erix-agent 0.18.0 #182）：历史回放不丢该诊断事件', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'model_metadata_missing', { model: 'gpt-x', reason: 'no_static_metadata' }));
    s.pool.seed(ev(2, 'run_end', { run_id: 'r1', termination: { reason: 'end_turn' } })); // 仍白名单外
    s.pool.seed(ev(3, 'model_metadata_missing', { model: 'gpt-y' }));

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type, e.payload]),
      [[1, 'model_metadata_missing', { model: 'gpt-x', reason: 'no_static_metadata' }],
       [3, 'model_metadata_missing', { model: 'gpt-y' }]],
      '诊断事件可回放，payload 原样下发；run_end 仍不下发',
    );
  } finally {
    await s.close();
  }
});

// issue #288（缺陷 B）：`attempt_killed` 是 portal 在 release-requeue 分支**自己合成**的宿主事件，
// SSE 实时推了就必须能回放（否则刷新后「第 N 次重试」这条消失，而它正是本单要用户看见的东西）。
test('白名单含 attempt_killed（#288）：历史回放不丢「attempt 被杀并重排」，且不把 run_end 带进来', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(4, 'attempt_killed', { attempt: 1, max_attempts: 3, reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301584 }));
    s.pool.seed(ev(5, 'run_end', { run_id: 'r1', termination: { reason: 'end_turn' } })); // 仍白名单外
    s.pool.seed(ev(6, 'attempt_killed', { attempt: 2, max_attempts: 3, reason: 'worker_crashed', killed_by: 'crash' }));

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type, e.payload]),
      [[4, 'attempt_killed', { attempt: 1, max_attempts: 3, reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301584 }],
       [6, 'attempt_killed', { attempt: 2, max_attempts: 3, reason: 'worker_crashed', killed_by: 'crash' }]],
      'attempt_killed 可回放且 payload 原样下发（silent_ms 有则出现，没给就不是 null/0）；run_end 仍不下发',
    );
  } finally {
    await s.close();
  }
});

// issue #288（缺陷 C）：崩溃恢复时「挂起工具没被重放」必须刷新后仍在——它出现的时机正是用户
// 刷新页面来看「我这条 run 怎么了」的时刻，不可回放比不推更坑。
test('白名单含 tool_replay_decision_required（#288 缺陷 C）：历史回放不丢「未重放」事件', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(7, 'tool_replay_decision_required', {
      tool_call_id: 'call-1', engine_run_id: SESSION_ID, round: 3, name: 'shell',
      replay: 'unsafe', requires_host_decision: true, partial_output_available: false,
    }));
    s.pool.seed(ev(8, 'usage', { round: 3, usage: { input_tokens: 10, output_tokens: 2 } })); // 仍白名单外
    s.pool.seed(ev(9, 'tool_replay_decision_required', {
      tool_call_id: 'call-9', round: 4, name: 'writeFile', requires_host_decision: true,
    }));

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type, e.payload]),
      [[7, 'tool_replay_decision_required', {
        tool_call_id: 'call-1', engine_run_id: SESSION_ID, round: 3, name: 'shell',
        replay: 'unsafe', requires_host_decision: true, partial_output_available: false,
      }],
      // 缺位字段就是**没有这个键**：不补 null/false 冒充「引擎说没有部分输出」
       [9, 'tool_replay_decision_required', {
         tool_call_id: 'call-9', round: 4, name: 'writeFile', requires_host_decision: true, }]],
      '事件可回放且 payload 原样下发（runner 侧没给的键不得被补成 null/0/false）；usage 仍不下发',
    );
  } finally {
    await s.close();
  }
});

test('#371-A 白名单含 persistence_error：落盘失败事件刷新后必须还在（致命与非致命一视同仁）', async () => {
  const s = await startServer();
  try {
    // payload 一律是 runner `loopEventPayload` 的产物（形状与字段口径见 portal.md §5.3 第 16 行）：
    // `fatal` 已归一成布尔、`stack` 不在、`engine_run_id` 而非 `run_id`。
    s.pool.seed(ev(11, 'persistence_error', {
      port: 'transcript', phase: 'write', operation: 'appendRound', engine_run_id: SESSION_ID,
      fatal: false, sideEffect: 'strip-fold-archive-retry',
      error: { name: 'Error', message: 'round 请求体超过 1048576 字节上限' }, ts: '2026-10-24T10:00:00.000Z',
    }));
    s.pool.seed(ev(12, 'persistence_error', {
      port: 'transcript', phase: 'write', operation: 'appendRound', fatal: true,
      error: { name: 'Error', message: 'boom' },
    }));
    s.pool.seed(ev(13, 'checkpoint', { round: 4 })); // 运行态语义事件：仍在白名单外

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.deepEqual(body.events.map((e) => [e.seq, e.type]), [[11, 'persistence_error'], [12, 'persistence_error']],
      '两类都要可回放：非致命那条是「降级但继续」的唯一线索，刷新后消失就等于从未发生（#371-A 缺陷本体）。'
      + '致命那条也留库是为了可审计——界面刷不刷由前端决定，不在这里丢数据');
    assert.equal(body.events[0].payload.fatal, false, 'fatal 必须原样下发（前端靠它分中性/红面，丢了就把降级刷成失败）');
    assert.equal(body.events[0].payload.error.message, 'round 请求体超过 1048576 字节上限');
  } finally {
    await s.close();
  }
});

test('payload 大小防护：字符串叶值截 2000 字符 + 标记（JSON 形状保持合法）', async () => {
  const s = await startServer();
  try {
    // issue #502 D-7：`tool_call_delta` 不再落库，也不再进白名单 ⇒ 它**不该出现在响应里**。
    // 本条用例的载荷大小防护原意保留：截断断言搬到仍在册的 `tool_use` 上（一条同样长的叶值），
    // `tool_call_delta` 这条种子留着，改成断言「它被白名单挡掉了」——这是 #502 新增的那半边事实。
    s.pool.seed(ev(1, 'tool_call_delta', { tool_call_id: 'c1', name: 'write', arguments_delta: 'x'.repeat(5000) }));
    s.pool.seed(ev(2, 'tool_use', { tool_call_id: 'c2', name: 'write', input: { content: 'y'.repeat(3000), meta: { note: '短' } } }));

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    assert.equal(body.events.find((e) => e.type === 'tool_call_delta'), undefined,
      '#502：`tool_call_delta` 不落库也不下发（白名单里已摘）');
    const input = body.events.find((e) => e.type === 'tool_use').payload.input;
    assert.equal(input.content.length, 2000 + '…（已截断）'.length);
    assert.equal(input.meta.note, '短', '短字符串不动');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// issue #236 §1 第 2 条：终态分隔条从 `runs` 终态字段**投影**（合成项 `run_termination`）。
// 红线：`run_end` 不进白名单（本文件首条用例仍钉着）；合成项也不进白名单——它只在响应期存在。
// ---------------------------------------------------------------------------
const historyOf = async (s, q = '') => {
  const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history${q}`, {
    headers: { Cookie: s.cookieHeader },
  });
  assert.equal(res.status, 200);
  return res.json();
};
const terminationsOf = (body) => body.events.filter((e) => e.type === 'run_termination');
const runsQueries = (pool) => pool.sqlLog.filter((sql) => sql.replace(/\s+/g, ' ').includes('FROM runs r'));

test('#236 终态 run ⇒ 恰一条 run_termination：seq = 该 run 最后一条事件（含白名单外的 run_end），payload 原样投影', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'round_start', { round: 1 }));
    s.pool.seed(ev(2, 'assistant_delta', { text: '半截' })); // 白名单外
    s.pool.seed(ev(3, 'run_end', { termination: { reason: 'aborted' } })); // 白名单外（状态机安全）
    s.pool.seedRun('r1', 'finished', { reason: 'aborted', detail: 'stopped by user' });

    const body = await historyOf(s);
    const terms = terminationsOf(body);
    assert.equal(terms.length, 1, `一条 run 至多一条终态项（body=${JSON.stringify(body.events)}）`);
    assert.deepEqual(terms[0], {
      seq: 3, // = MAX(run_events.seq)：run_end 行就在表里 ⇒ 分隔条天然排在本次 run 的内容之后
      run_id: 'r1',
      type: 'run_termination',
      payload: { status: 'finished', termination: { reason: 'aborted', detail: 'stopped by user' } },
    });
    // 真实事件仍只有白名单那一条；run_end 仍不下发。
    // **形态 M 的连带改动**（本用例的数据是「终态 + 零锚点 + 两处都没有正文」，正是占位的判据面）：
    // 现在同 seq 还会多出一条 `partial_output` 的**占位项**（#278 底线：中止态不许留空白，占位从
    // SSE 补发通路搬进了历史投影）。它不影响本用例的意图（终态分隔条恰一条、payload 原样透传），
    // 所以**加进期望而不是删断言**：分隔条那条逐项 deepEqual 一条没少，只是列表里多了一个邻居。
    // 占位自己的逐项形状由 `session-partial-output.test.js` 的占位用例承重。
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type]),
      [[1, 'round_start'], [3, 'partial_output'], [3, 'run_termination']],
      'run_end 不下发；终态分隔条改为从 runs 投影（#236 的红线）；同 seq 的占位项排在分隔条之前',
    );
    // 不落库：run_events 里不得出现 run_termination 行
    assert.equal(s.pool.runEvents.filter((e) => e.type === 'run_termination').length, 0);
  } finally {
    await s.close();
  }
});

// issue #442（erix-agent 0.30.0 / 上游 #476）：兜底标记（`termination.finalTextFallback`）必须**穿过**
// 这条响应期投影——它是界面那条中性标记的唯一数据源（刷新后仍在，靠的就是本端点原样透传 termination）。
test('#442 终态 termination 里的 finalTextFallback 原样进 run_termination 合成项（界面标记的数据源）', async () => {
  const s = await startServer();
  try {
    // ⚠ 窗口里必须有**白名单内**的事件：合成项只对「本次响应窗口里出现过的 run」投影
    //（`distinctWindowRunIds`），只种一条 run_end（白名单外）会连一条合成项都没有。
    s.pool.seed(ev(1, 'round_start', { round: 1 }));
    s.pool.seed(ev(2, 'run_end', { termination: { reason: 'end_turn' } }));
    s.pool.seedRun('r1', 'finished', { reason: 'end_turn', forcedFinal: true, finalTextFallback: true });
    const terms = terminationsOf(await historyOf(s));
    assert.equal(terms.length, 1);
    assert.equal(terms[0].payload.termination.finalTextFallback, true,
      '宿主 additive 键被投影吞了 ⇒ 刷新后界面把引擎兜底文案当成模型正文');
    // 引擎自己的键一个不少（投影是「原样透传」，不是白名单）
    assert.equal(terms[0].payload.termination.forcedFinal, true);
    assert.equal(terms[0].payload.termination.reason, 'end_turn');
  } finally {
    await s.close();
  }
});

test('#442 没有兜底标记 ⇒ 合成项里一个字节都不多（不是 false，是根本没有这个键）', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'round_start', { round: 1 }));
    s.pool.seed(ev(2, 'run_end', { termination: { reason: 'end_turn' } }));
    s.pool.seedRun('r1', 'finished', { reason: 'end_turn' });
    const terms = terminationsOf(await historyOf(s));
    assert.equal(terms.length, 1);
    assert.equal(Object.hasOwn(terms[0].payload.termination, 'finalTextFallback'), false,
      '不是兜底时多出了 finalTextFallback 键 ⇒ 界面会误报「这是兜底文案」');
  } finally {
    await s.close();
  }
});

for (const status of ['queued', 'running', 'cancelling']) {
  test(`#236 非终态 ${status} ⇒ 不合成（「还在跑就标已中止」是新造的误导，三态各钉一条）`, async () => {
    const s = await startServer();
    try {
      s.pool.seed(ev(1, 'round_start', { round: 1 }));
      s.pool.seedRun('r1', status, { reason: 'aborted' });
      const body = await historyOf(s);
      assert.deepEqual(terminationsOf(body), [], `${status} 不是终态`);
    } finally {
      await s.close();
    }
  });
}

test('#236 终态但 termination 缺失/脏 ⇒ 不合成（绝不拿 status 编一个 reason）', async () => {
  const s = await startServer();
  try {
    // 四个 run 都要真出现在窗口里（否则候选集为空，这条用例什么都没测）
    const cases = [
      ['r1', 'finished', null], // 旧数据 / 没有 termination
      ['r2', 'failed', { detail: 'x' }], // 有对象但没有 reason
      ['r3', 'failed', { reason: '' }], // 空串
      ['r4', 'failed', { reason: 42 }], // 非字符串
    ];
    for (const [i, [runId, status, termination]] of cases.entries()) {
      s.pool.seed({ ...ev(i + 1, 'round_start', { round: i + 1 }), run_id: runId });
      s.pool.seedRun(runId, status, termination);
    }

    const body = await historyOf(s);
    assert.equal(body.events.filter((e) => e.type === 'round_start').length, 4, '四个 run 都在窗口里');
    assert.deepEqual(terminationsOf(body), [], `脏载荷不得渲染（body=${JSON.stringify(terminationsOf(body))}）`);
  } finally {
    await s.close();
  }
});

test('#236 一条 run 多条事件 ⇒ 仍只一条终态项；两个 run 各一条且 run_id 不串号', async () => {
  const s = await startServer();
  try {
    s.pool.seed({ ...ev(1, 'round_start', { round: 1 }), run_id: 'r1' });
    s.pool.seed({ ...ev(2, 'round_start', { round: 2 }), run_id: 'r1' }); // 同一 run 的第二条事件
    s.pool.seedRun('r1', 'finished', { reason: 'aborted' });
    s.pool.seed({ ...ev(10, 'round_start', { round: 1 }), run_id: 'r2' });
    s.pool.seed({ ...ev(11, 'tool_use', { tool_call_id: 'c1', name: 'bash', input: {} }), run_id: 'r2' });
    s.pool.seedRun('r2', 'failed', { reason: 'failed', errorCode: 'timeout' });

    const body = await historyOf(s);
    const terms = terminationsOf(body);
    assert.deepEqual(terms.map((t) => [t.seq, t.run_id, t.payload.termination.reason]), [
      [2, 'r1', 'aborted'],
      [11, 'r2', 'failed'],
    ]);
    assert.equal(terms[1].payload.termination.errorCode, 'timeout', 'errorCode 原样透传（前端横幅要用）');
  } finally {
    await s.close();
  }
});

test('#236 红线：库里即使真有一行 type=run_termination 也不下发（合成项只在响应期，不进白名单）', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(1, 'run_termination', { status: 'finished', termination: { reason: 'aborted' } }));
    s.pool.seed(ev(2, 'run_end', { termination: { reason: 'aborted' } }));
    s.pool.seedRun('r1', 'running', { reason: 'aborted' }); // 非终态 ⇒ 投影侧也不合成

    const body = await historyOf(s);
    assert.deepEqual(body.events, [], 'run_end / run_termination 都不是可下发类型；非终态 run 也不投影');
  } finally {
    await s.close();
  }
});

test('#236 成本红线：窗口无 run ⇒ 一条 runs 查询都不发；有 run（哪怕全非终态）⇒ 恰好一条（不重查）', async () => {
  const s = await startServer();
  try {
    // ① 窗口里 run_id 全为 null（宿主自身事件）⇒ 零 runs 查询
    s.pool.seed({ seq: 1, run_id: null, type: 'judge', payload: { decision: { extend: false } } });
    await historyOf(s);
    assert.deepEqual(runsQueries(s.pool), [], '零候选会话每次刷新都走这条端点，不得多发查询');

    // ② 有 run 但非终态 ⇒ 恰好一条（#300 的候选判定与 #236 的投影共用它，不许打第二条）
    s.pool.sqlLog.length = 0;
    s.pool.seed(ev(2, 'round_start', { round: 1 }));
    s.pool.seedRun('r1', 'running', { reason: 'aborted' });
    const body = await historyOf(s);
    assert.deepEqual(terminationsOf(body), []);
    assert.equal(runsQueries(s.pool).length, 1, `同一次响应里只允许一条 runs 查询：\n${runsQueries(s.pool).join('\n')}`);
  } finally {
    await s.close();
  }
});

test('#236 终态项不占 limit、不改 next_cursor（分页字段仍只由白名单真实事件决定）', async () => {
  const s = await startServer();
  try {
    for (const seq of [1, 2, 3, 4]) s.pool.seed(ev(seq, 'round_start', { round: seq }));
    s.pool.seed(ev(5, 'assistant_delta', { text: '白名单外' }));
    s.pool.seedRun('r1', 'finished', { reason: 'judge_done' });

    const body = await historyOf(s, '?limit=2');
    // **形态 M 的连带改动**：本夹具的 run 是「终态 + 零锚点 + 两处正文都没有」⇒ 除终态项外还会有一条
    // **占位**合成项（seq 同为 5）。过滤集合必须把两类响应期合成项都排除，否则「limit 只数真实事件」
    // 会被占位项污染成假红（这不是放宽断言：真实事件的集合仍是 [3, 4]）。
    const SYNTH = new Set(['run_termination', 'partial_output']);
    assert.deepEqual(body.events.filter((e) => !SYNTH.has(e.type)).map((e) => e.seq), [3, 4], 'limit 只数真实事件');
    assert.equal(body.next_cursor, 3, 'next_cursor 仍只由白名单真实事件决定');
    assert.equal(terminationsOf(body).length, 1, '终态项照常下发（seq=5 落在窗口外也照发：MAX(seq) 是整 run 口径）');
    assert.equal(terminationsOf(body)[0].seq, 5);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// issue #514：**「queued 从未开始就被取消」的 run 只写一行 `run_end`**（sessions.js 的 killedQueued
// 分支），而 `run_end` 不在下发白名单（红线，它驱动前端运行态状态机）⇒ 这条 run 在白名单行里
// **零影子**：旧实现的候选集只来自 `distinctWindowRunIds(白名单行)`，于是它永远进不了候选 ⇒
// 既没有 `run_termination` 分隔条、也没有 `partial_output` 占位项 ⇒ 刷新后正文区**完全空白**
// （连「它存在过、并且已经终态」都看不出来）。
// 修法（工单候选 ①）：把**页内**的 `run_end` 行纳入**候选发现**——只发现 run id，那一行本身
// 仍不作为回放事件下发；后面的终态投影与占位全部复用 #236/#300/#502 的既有通路。
// ---------------------------------------------------------------------------
const partialsOf = (body) => body.events.filter((e) => e.type === 'partial_output');
const runEndsOf = (body) => body.events.filter((e) => e.type === 'run_end');
const KILLED = { reason: 'aborted', detail: 'cancelled_before_start' };
// 发现查询的识别别拿 `SELECT run_id` 的列名单当锚（#514 返修后它多带了一列 `seq`）——
// 按「只查 run_end 行」这条谓词认，才是它的身份。
const discoveryQueries = (pool) => pool.sqlLog.filter((sql) => {
  const flat = sql.replace(/\s+/g, ' ');
  return /FROM run_events/.test(flat) && flat.includes("type = 'run_end'");
});

/** 种一次「从未开始就被取消」：库里只有那一行 `run_end`（载荷形状照 sessions.js 的 killedQueued）。 */
function seedKilledQueuedRun(pool, runId, seq, termination = KILLED) {
  pool.seed({
    ...ev(seq, 'run_end', { termination, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, attempt: 1 }),
    run_id: runId,
  });
  pool.seedRun(runId, 'finished', termination);
  return pool;
}

test('#514 判据①：本页零白名单行 + 页内只有 run_end ⇒ 恰一条 run_termination（aborted / cancelled_before_start）', async () => {
  const s = await startServer();
  try {
    seedKilledQueuedRun(s.pool, 'r-killed', 7);
    const body = await historyOf(s);
    assert.deepEqual(terminationsOf(body), [{
      seq: 7, // = 该 run 的唯一一行（run_end）的 seq ⇒ 分隔条落在它该在的位置
      run_id: 'r-killed',
      type: 'run_termination',
      payload: { status: 'finished', termination: { reason: 'aborted', detail: 'cancelled_before_start' } },
    }], '从未开始就被取消的 run，刷新后必须留一条终态分隔条（旧实现这里返回空 ⇒ 正文区全空白）');
    assert.deepEqual(runEndsOf(body), [],
      '红线：run_end 只参与候选发现，绝不下发（它会驱动前端运行态状态机，#217/#236）');
    assert.equal(body.next_cursor, null);
  } finally {
    await s.close();
  }
});

test('#514 判据②：同一格 ⇒ 正文区不空白 —— 恰一条 partial_output 占位项（text 空 + placeholder:true）', async () => {
  const s = await startServer();
  try {
    seedKilledQueuedRun(s.pool, 'r-killed', 7);
    const body = await historyOf(s);
    assert.deepEqual(partialsOf(body), [{
      seq: 7,
      run_id: 'r-killed',
      type: 'partial_output',
      payload: { text: '', chunks: 0, truncated: false, placeholder: true, source: 'none' },
    }], '无锚点 + 两处 durable 正文都没有 ⇒ 一行中性提示（#278「不许留空白」，前端 StreamPanel 的 v-if="en.placeholder"）');
    assert.deepEqual(body.events.map((e) => [e.seq, e.type]), [[7, 'partial_output'], [7, 'run_termination']],
      '正文区一个字节都不许多于这两条：占位在终态分隔条之前（同 seq 的稳定序）');
  } finally {
    await s.close();
  }
});

test('#514 候选发现不止补空页：页里有别的 run 的白名单行时，只写 run_end 的那条同样要有分隔条', async () => {
  const s = await startServer();
  try {
    // r-a：正常跑完并有白名单行；r-killed：从未开始就被取消（库里只有 run_end，seq 更大 = 更新）
    s.pool.seed({ ...ev(1, 'round_start', { round: 1 }), run_id: 'r-a' });
    s.pool.seed({ ...ev(2, 'round_start', { round: 2 }), run_id: 'r-a' });
    s.pool.seed({ ...ev(3, 'run_end', { termination: { reason: 'end_turn' } }), run_id: 'r-a' });
    s.pool.seedRun('r-a', 'finished', { reason: 'end_turn' });
    seedKilledQueuedRun(s.pool, 'r-killed', 9);

    const body = await historyOf(s);
    assert.deepEqual(
      terminationsOf(body).map((t) => [t.seq, t.run_id, t.payload.termination.reason]),
      [[3, 'r-a', 'end_turn'], [9, 'r-killed', 'aborted']],
      '「会话里有历史内容」不是把这次取消吞掉的理 —— 候选发现不能只在空页时兜底（工单候选 ② 的形状）',
    );
    assert.equal(terminationsOf(body)[1].payload.termination.detail, 'cancelled_before_start');
    assert.deepEqual(runEndsOf(body), [], '红线同上一条');
  } finally {
    await s.close();
  }
});

test('#514 页界：发现查询被「本页最小 seq」与 before 夹住 ⇒ 同一根分隔条不在每一页重演一次（M-6④ 同形）', async () => {
  const s = await startServer();
  try {
    s.pool.seed({ ...ev(10, 'round_start', { round: 1 }), run_id: 'r-old' });
    s.pool.seed({ ...ev(11, 'round_start', { round: 2 }), run_id: 'r-old' });
    s.pool.seed({ ...ev(12, 'run_end', { termination: { reason: 'end_turn' } }), run_id: 'r-old' });
    s.pool.seedRun('r-old', 'finished', { reason: 'end_turn' });
    seedKilledQueuedRun(s.pool, 'r-killed', 5); // 更老的、只写 run_end 的那条

    const p1 = await historyOf(s, '?limit=1'); // 最新一条白名单行（seq 11）⇒ 本页下界 11
    assert.deepEqual(terminationsOf(p1).map((t) => [t.seq, t.run_id]), [[12, 'r-old']]);
    assert.equal(p1.next_cursor, 11);

    const p2 = await historyOf(s, '?limit=1&before=11'); // 白名单行 seq 10 ⇒ 本页下界 10
    assert.deepEqual(terminationsOf(p2).map((t) => [t.seq, t.run_id]), [],
      'run_end 在 seq 5 < 本页下界 10 ⇒ 它属于更老的那一页，这页不许再放一次');

    const p3 = await historyOf(s, '?limit=1&before=10'); // 白名单行空 ⇒ 尾巴页：下界 0、上界 10
    assert.deepEqual(terminationsOf(p3).map((t) => [t.seq, t.run_id]), [[5, 'r-killed']],
      '它最终仍要出现一次（不是被页界挤没了）');
    assert.equal(p3.next_cursor, null, '空页 ⇒ 分页到头');
  } finally {
    await s.close();
  }
});

test('#514 成本：发现查询每次响应至多一条、被页边界与 LIMIT 夹住；runs 查询仍恰好一条', async () => {
  const s = await startServer();
  try {
    s.pool.seed({ ...ev(1, 'round_start', { round: 1 }), run_id: 'r-a' });
    s.pool.seedRun('r-a', 'finished', { reason: 'end_turn' });
    seedKilledQueuedRun(s.pool, 'r-killed-1', 2);
    seedKilledQueuedRun(s.pool, 'r-killed-2', 3);

    s.pool.sqlLog.length = 0;
    const body = await historyOf(s);
    assert.equal(terminationsOf(body).length, 3, '三条终态 run 都要有分隔条（两条是只写 run_end 的）');
    const disc = discoveryQueries(s.pool);
    assert.equal(disc.length, 1, `一次响应至多一条发现查询：\n${disc.join('\n')}`);
    assert.match(disc[0], /seq >= \$\d+/, '页下界必须写在 SQL 里（否则旧页的分隔条会在每一页重演）');
    assert.match(disc[0], /LIMIT \$\d+/, '候选数必须被页大小夹住');
    assert.equal(runsQueries(s.pool).length, 1,
      `发现出来的 id 要并进既有那条批量 runs 查询，不许为它再打第二条：\n${runsQueries(s.pool).join('\n')}`);
  } finally {
    await s.close();
  }
});

// 红线闸（源码钉）：把 run_end 塞进任一个集合，本文件的运行时用例**也会**红，但那条红说的是
// 「这一格返回了什么」；这条钉的是「集合里到底有没有它」——两者不是同一件事（后者在
// 有人「顺手加白名单图省事」时给出直白的名字与位置）。
test('#514 红线：run_end 既不在后端下发白名单，也不在前端回放集合（它驱动运行态状态机，#217/#236）', () => {
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const http = strip(fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8'));
  const backend = http.match(/const HISTORY_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(backend, '锚点：后端下发白名单的字面量还在');
  assert.ok(!backend[1].includes("'run_end'"), 'run_end 进后端白名单 = 刷新时把运行态事件回放给前端');
  const fe = strip(fs.readFileSync(new URL('../frontend/src/composables/useEventStream.ts', import.meta.url), 'utf8'));
  const replay = fe.match(/const HISTORY_REPLAY_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(replay, '锚点：前端回放集合的字面量还在');
  assert.ok(!replay[1].includes("'run_end'"), '前端回放集合里出现 run_end = 拿历史帧驱动停止按钮 / 终态状态机');
});

test('#514 发现查询的上界（before）承重：不夹上界就会被更新的终态行挤掉 LIMIT ⇒ 这条 run 在每一页都露不了面', async () => {
  const s = await startServer();
  try {
    // r-a 的白名单行在 200 / 210，它自己的 run_end 在 215；r-killed 只有 run_end 在 205。
    s.pool.seed({ ...ev(200, 'round_start', { round: 1 }), run_id: 'r-a' });
    s.pool.seed({ ...ev(210, 'round_start', { round: 2 }), run_id: 'r-a' });
    s.pool.seed({ ...ev(215, 'run_end', { termination: { reason: 'end_turn' } }), run_id: 'r-a' });
    s.pool.seedRun('r-a', 'finished', { reason: 'end_turn' });
    seedKilledQueuedRun(s.pool, 'r-killed', 205);

    const p1 = await historyOf(s, '?limit=1'); // 页 [210, ∞) ⇒ 下界 210
    assert.deepEqual(terminationsOf(p1).map((t) => [t.seq, t.run_id]), [[215, 'r-a']]);
    assert.equal(p1.next_cursor, 210);

    // 页 [200, 210)：本页自己的终态行是 seq 205 那条。若发现查询不夹上界，`ORDER BY seq DESC LIMIT 1`
    // 会先取到 215（属于更新的那一页），随后被 M-6④ 的 `seq < before` 拦掉 ⇒ 本页什么都不剩，
    // 而 205 那条也在更新的那一页被页下界拦住 ⇒ **它在哪一页都不出现**（工单说的「看不见」）。
    const p2 = await historyOf(s, '?limit=1&before=210');
    assert.deepEqual(terminationsOf(p2).map((t) => [t.seq, t.run_id, t.payload.termination.detail]),
      [[205, 'r-killed', 'cancelled_before_start']]);
    assert.deepEqual(partialsOf(p2).map((p) => [p.seq, p.run_id, p.payload.placeholder]), [[205, 'r-killed', true]],
      '这一页同样不许空白');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// issue #514 **返修**（copilot 二次审计第 1 条，主 agent 复核成立）：
// 尾巴区（游标之下**零白名单行**、只有 `run_end` 行）的分隔条会**静默丢失，且没有游标可续**。
// 旧口径 `next_cursor` 只由白名单行算 ⇒ 空页上恒 null，而「空页」恰恰意味着「游标之下还有内容，
// 只是全不是白名单事件」⇒ 被发现的 `LIMIT` 截掉的那批 run **永远没有页可达**（不是晚点出现，
// 是永远看不见）。触发条件：会话尾巴上有多过一页的「从未开始就被取消」的 run（连点取消、批量清队列）。
// 修法：发现查询多带 `seq` 并按主窗口同一口径多取一行探针（`LIMIT limit + 1`）；**本页零白名单行**
// 且探针证实窗口被截断时，`next_cursor` 取**已发现行里最小的 seq**（同向、与本页严格不重叠、
// 不倒退）。非空页不动游标：那种页的游标属于白名单行，压到页下界之外会跳过**真实事件**。
// ---------------------------------------------------------------------------

/** 沿游标把整条翻页链拉完（客户端就是这条循环），返回每一页的 events / next_cursor。 */
async function walkPages(s, limit, maxPages = 6) {
  const pages = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i += 1) {
    const q = cursor == null ? `?limit=${limit}` : `?limit=${limit}&before=${cursor}`;
    const body = await historyOf(s, q);
    pages.push(body);
    const next = body.next_cursor;
    if (next == null) return pages;
    assert.ok(Number.isSafeInteger(next) && next >= 1 && (cursor == null || next < cursor),
      `游标必须为正整数且严格递减（否则客户端要么停住、要么无限循环）：第 ${i + 1} 页给的是 ${next}`);
    cursor = next;
  }
  assert.fail(`翻页链在 ${maxPages} 页内没有收敛（游标不回 null = 客户端会一直拉）：${JSON.stringify(
    pages.map((p) => [p.next_cursor, p.events.map((e) => e.seq)]))}`);
  return pages;
}

test('#514 返修 判据：游标之下零白名单行、只有 limit+2 条 run_end ⇒ 第一页 limit 条且游标非 null、续页拿到剩下的', async () => {
  const s = await startServer();
  try {
    // 会话尾巴：4 条从未开始就被取消的 run（每条库里只有那一行 run_end），页大小 2 ⇒ limit + 2。
    const LIMIT = 2;
    const tail = [1, 2, 3, 4]; // seq 递增 = 由老到新
    tail.forEach((seq) => seedKilledQueuedRun(s.pool, `r-${seq}`, seq));

    const p1 = await historyOf(s, `?limit=${LIMIT}`);
    assert.deepEqual(terminationsOf(p1).map((t) => t.seq), [3, 4],
      '第一页只许带出最新的 limit 条分隔条（升序返回）；探针那一行不算候选');
    assert.ok(Number.isSafeInteger(p1.next_cursor) && p1.next_cursor >= 1,
      '尾巴被截断时游标必须非 null（旧实现在这里给 null ⇒ 客户端不再翻页，剩下的永远看不见）');
    assert.equal(p1.next_cursor, 3, '游标 = 已发现行里最小的 seq（3），不是最大的（4 = 会把已展示的那条重演）');

    const p2 = await historyOf(s, `?limit=${LIMIT}&before=${p1.next_cursor}`);
    assert.deepEqual(terminationsOf(p2).map((t) => t.seq), [1, 2],
      '续页必须拿到剩下的 2 条（旧实现：这一页根本不会被请求）');
    assert.equal(p2.next_cursor, null,
      '窗口之下真的没有更老的了 ⇒ 游标必须回到 null（探针承重：拿「恰好返了 limit 条」当截断就会多跑一趟空页）');

    const seen = [...terminationsOf(p1), ...terminationsOf(p2)].map((t) => t.seq).sort((a, b) => a - b);
    assert.deepEqual(seen, tail, '两页合起来不多不少：每条 run_end 恰好露面一次');
    assert.deepEqual(runEndsOf(p1).concat(runEndsOf(p2)), [], '红线同前：run_end 始终不下发');
  } finally {
    await s.close();
  }
});

test('#514 返修：尾巴长过两页 ⇒ 三页翻完，每条 run_end 恰好露面一次（游标驱动整条翻页链，不重不漏）', async () => {
  const s = await startServer();
  try {
    const LIMIT = 2;
    const tail = [1, 2, 3, 4, 5, 6]; // 2 * limit + 2 条：必须翻三页才翻得完
    tail.forEach((seq) => seedKilledQueuedRun(s.pool, `r-${seq}`, seq));

    const pages = await walkPages(s, LIMIT);
    assert.equal(pages.length, 3, `应当恰好三页翻完，实际 ${pages.length} 页`);
    // 每条被取消的 run 出**两项**（`partial_output` 占位 + `run_termination` 分隔条，#236/#300 同格）
    assert.deepEqual(pages.map((p) => terminationsOf(p).length), [2, 2, 2],
      '每页至多 limit 条候选（探针那一行不进响应）');
    assert.deepEqual(pages.map((p) => p.events.length), [4, 4, 4],
      '每页事件数 = 候选数 × 2（占位 + 分隔条），没有第三条、也没有少一条');
    const seen = pages.flatMap((p) => terminationsOf(p).map((t) => t.seq));
    assert.deepEqual(seen.slice().sort((a, b) => a - b), tail,
      '三页合起来不多不少：六条 run_end 各露面一次（少了 = 静默丢失，多了 = 重叠重演）');
    assert.equal(new Set(seen).size, tail.length, '三页合起来不重复（游标不重叠：下一页窗口是 [0, 游标) 严格小于）');
    assert.deepEqual(pages.map((p) => p.next_cursor), [5, 3, null],
      '游标逐页递减且最后一页归 null（客户端据此停手）');
  } finally {
    await s.close();
  }
});

test('#514 返修：非空页的游标所有权仍归白名单行——即使发现被截断也不许压到页界之外（那会跳过真实事件）', async () => {
  const s = await startServer();
  try {
    // 白名单行只有 seq 10 这一条；尾巴上三条只写 run_end 的 run（20/21/22）。
    s.pool.seed({ ...ev(10, 'round_start', { round: 1 }), run_id: 'r-a' });
    s.pool.seedRun('r-a', 'finished', { reason: 'end_turn' });
    seedKilledQueuedRun(s.pool, 'r-20', 20);
    seedKilledQueuedRun(s.pool, 'r-21', 21);
    seedKilledQueuedRun(s.pool, 'r-22', 22);

    const p1 = await historyOf(s, '?limit=1');
    assert.deepEqual(p1.events.filter((e) => e.type === 'round_start').map((e) => e.seq), [10],
      '真实事件照常下发');
    // r-a 自己也是「终态 + 零锚点」⇒ 它那条分隔条在 seq 10（来自白名单候选），尾巴那条来自**发现**候选
    assert.deepEqual(terminationsOf(p1).map((t) => t.seq), [10, 22],
      '本页窗口内的尾巴照样带出候选（候选上界 = limit，因此这页只带出一条尾巴行 22）');
    assert.equal(p1.next_cursor, null,
      '非空页 ⇒ 游标不许改成「已发现的最小 seq」（22）：那会让下一页 [0,22) 把 seq 10 那条真实事件'
      + '再放一遍。尾巴上比 limit 更老的那几条是**非空页**的已接受边界（§4.4a-2 残余①），'
      + '不是这一格该改的东西');

    // 尾巴被截断掉的那两条（20/21）确实还在库里，但按现口径没有任何页能拿到它们——
    // 这一句把「残余①」钉成**读数**而不是文档里的一句话（要修它得把发现并进主窗口查询）。
    const p2 = await historyOf(s, '?limit=1&before=10');
    assert.deepEqual(p2.events, [], '白名单游标之下确实没有页可达这些尾巴行了（残余①的形状）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// issue #243（工单 fix-261116-03）：`textualized_tool_call` 刷新后必须仍在
//
// 这条事件说的是「这次终局正文是一段被文本化的工具调用 —— 交付报告可能没生成」，
// 而它**出现的时机恰恰就是用户刷新页面来看这次交付了什么**的那一刻。
// 上游 erix-agent #182 的教训（诊断事件实时可见、刷新后消失）正是本白名单要消灭的
// 那种可见性不一致；#288 的 `attempt_killed` 是本站第一次踩，判据写法照它。
// 写入侧（`internal.js#finishRun` 在终态事务里合成这一行）的判据在
// `portal/test/textualized-toolcall.test.js`；这里只钉「下发」这一半。
// ---------------------------------------------------------------------------

test('#243 白名单含 textualized_tool_call：刷新后仍返回它，payload 原样，且不把 run_end 带进来', async () => {
  const s = await startServer();
  try {
    // 载荷形状与写入侧严格一致：{chars, marker}（marker 是命中的特征，含全角竖线，多字节）。
    s.pool.seed(ev(4, 'textualized_tool_call', { chars: 1830, marker: '<｜｜DSML｜｜' }));
    s.pool.seed(ev(5, 'run_end', { termination: { reason: 'end_turn' }, final_text: '<｜｜DSML｜｜…' })); // 仍白名单外
    const body = await historyOf(s);
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type, e.payload]),
      [[4, 'textualized_tool_call', { chars: 1830, marker: '<｜｜DSML｜｜' }]],
      '刷新后必须还返回这条事件，且 payload 一字不改（`marker` 含全角字符，截断逻辑不许切坏它）；'
      + '白名单外的 run_end 照常不下发（本改动是 additive，没有将终态行提升为下发项）',
    );
    assert.equal(body.events.some((e) => e.type === 'run_end'), false);
  } finally {
    await s.close();
  }
});

test('#243 缺 marker 的历史行也照发（前端要能对「没有 marker」也出同一句话）', async () => {
  const s = await startServer();
  try {
    s.pool.seed(ev(9, 'textualized_tool_call', { chars: 44 }));
    const body = await historyOf(s);
    assert.deepEqual(body.events.map((e) => [e.seq, e.type, e.payload]),
      [[9, 'textualized_tool_call', { chars: 44 }]],
      '没给 marker 就不是 null/空串——形状与写入侧一致（键缺席）');
  } finally {
    await s.close();
  }
});
