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
    maxBodyBytes: 64 * 1024,
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
    s.pool.seed(ev(1, 'tool_call_delta', { tool_call_id: 'c1', name: 'write', arguments_delta: 'x'.repeat(5000) }));
    s.pool.seed(ev(2, 'tool_use', { tool_call_id: 'c2', name: 'write', input: { content: 'y'.repeat(3000), meta: { note: '短' } } }));

    const body = await (await fetch(`${s.base}/api/sessions/${SESSION_ID}/events/history`, {
      headers: { Cookie: s.cookieHeader },
    })).json();
    const d = body.events.find((e) => e.type === 'tool_call_delta').payload.arguments_delta;
    assert.equal(d.length, 2000 + '…（已截断）'.length);
    assert.ok(d.endsWith('…（已截断）'));
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
    // 真实事件仍只有白名单那一条；run_end 仍不下发
    assert.deepEqual(
      body.events.map((e) => [e.seq, e.type]),
      [[1, 'round_start'], [3, 'run_termination']],
      'run_end 不下发；终态分隔条改为从 runs 投影（#236 的红线）',
    );
    // 不落库：run_events 里不得出现 run_termination 行
    assert.equal(s.pool.runEvents.filter((e) => e.type === 'run_termination').length, 0);
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
    assert.deepEqual(body.events.filter((e) => e.type !== 'run_termination').map((e) => e.seq), [3, 4], 'limit 只数真实事件');
    assert.equal(body.next_cursor, 3, 'next_cursor 仍只由白名单真实事件决定');
    assert.equal(terminationsOf(body).length, 1, '终态项照常下发（seq=5 落在窗口外也照发：MAX(seq) 是整 run 口径）');
    assert.equal(terminationsOf(body)[0].seq, 5);
  } finally {
    await s.close();
  }
});
