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
  }

  seed(ev) { this.runEvents.push({ run_id: 'r1', payload: {}, ...ev }); }

  async query(sql, params = []) {
    // 归属校验（status='active' 口径同 fetchSession）
    if (sql.includes('FROM chat_sessions WHERE id') && sql.includes("status = 'active'")) {
      return {
        rows: this.chatSessions.filter((s) => s.id === params[0] && s.user_id === params[1] && s.status === 'active'),
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
