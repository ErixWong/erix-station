// session-scoped transcript 端点测试（issue #81 P2，conversation-state.md §4.1；迁移 0006）。
// 覆盖：portal/src/internal.js 新函数（fake pool）+ http.js 路由（真 HTTP，Bearer + X-Claim-Token
// + ?run_id= writer fencing）。核心红线：崩溃重跑幂等（同 dedupKey 重放不产生重复 user 消息）、
// 多 session key 隔离、writer run 必须属于该 session 且持有效租约。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { FakeInternalPool, seedClaimable } from './fake-internal-pool.js';

async function startServer(pool) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: {
      maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000,
    },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((res) => server.close(res)) };
}

/** claim 拿票 → 返回会话键与请求头帮手。 */
async function claimTicket(s, token) {
  const claim = await fetch(`${s.base}/api/internal/claim`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ capacity: 1, hold_ms: 10 }),
  });
  assert.equal(claim.status, 200);
  return claim.json();
}

const INPUT = (key, msgId) => `${key}:input:${msgId}`;
const ENGINE_ROUND = (key, n, suffix = '') => `${key}:engine:round:${n}${suffix}`;

test('session transcript：预写入 → 读回 → 同 dedupKey 幂等重放不重复（崩溃重跑红线）', async () => {
  const { pool, token, runId, sessionId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const qs = `?run_id=${runId}`;
    const key = sessionId;

    // 空本子：load 返回空
    const empty = await fetch(`${s.base}/api/internal/transcript/${key}${qs}`, { headers: h });
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).records, []);

    // 宿主预写入用户消息（round = latestRound = 0，dedupKey 幂等）
    const rec = {
      round: 0, roundKey: INPUT(key, 'm1'), dedupKey: INPUT(key, 'm1'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ts: '2026-09-24T00:00:00.000Z',
    };
    const put = await fetch(`${s.base}/api/internal/transcript/${key}/rounds/0${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { inserted: true });

    // 引擎轮记录（round 1）+ 下一轮宿主预写（round = latestRound = 1，行号复用给下一轮让位前先看 2）
    const r1 = {
      round: 1, roundKey: ENGINE_ROUND(key, 1), dedupKey: ENGINE_ROUND(key, 1),
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }],
      ts: '2026-09-24T00:01:00.000Z',
    };
    assert.equal((await fetch(`${s.base}/api/internal/transcript/${key}/rounds/1${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify(r1),
    })).status, 200);

    // 崩溃重跑：同 dedupKey 重放 → 幂等命中，不重复入档
    const replay = await fetch(`${s.base}/api/internal/transcript/${key}/rounds/0${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { inserted: false });
    const loaded = await fetch(`${s.base}/api/internal/transcript/${key}${qs}`, { headers: h });
    const body = await loaded.json();
    assert.equal(body.records.length, 2);
    assert.deepEqual(body.records.map((r) => r.round), [0, 1]);
    // user 消息只有一条（红线）
    const userMsgs = body.records.flatMap((r) => r.messages ?? []).filter((m) => m.role === 'user');
    assert.equal(userMsgs.length, 1);

    // 同 dedupKey 不同 body → 409 round_conflict
    const conflict = await fetch(`${s.base}/api/internal/transcript/${key}/rounds/0${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ ...rec, messages: [] }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'round_conflict');
  } finally {
    await s.close();
  }
});

test('session transcript：行号复用——下一轮宿主预写与上轮引擎记录同 round 共存，按入档时序读回', async () => {
  const { pool, token, runId, sessionId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const qs = `?run_id=${runId}`;
    const key = sessionId;

    // 上一轮：round 0 种子 + round 1 引擎记录
    const seed = {
      round: 0, dedupKey: `${key}:engine:round:0:seed`, messages: [{ role: 'user', content: [{ type: 'text', text: 't1' }] }],
      ts: '2026-09-24T00:00:00.000Z',
    };
    const engine1 = {
      round: 1, dedupKey: ENGINE_ROUND(key, 1), messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }],
      ts: '2026-09-24T00:01:00.000Z',
    };
    for (const [n, rec] of [[0, seed], [1, engine1]]) {
      const r = await fetch(`${s.base}/api/internal/transcript/${key}/rounds/${n}${qs}`, {
        method: 'PUT', headers: h, body: JSON.stringify(rec),
      });
      assert.equal(r.status, 200);
    }
    // 下一轮宿主预写：round = latestRound = 1（与引擎 round 1 同行号，dedupKey 不同 → 合法共存）
    const prewrite = {
      round: 1, roundKey: INPUT(key, 'm2'), dedupKey: INPUT(key, 'm2'),
      messages: [{ role: 'user', content: [{ type: 'text', text: 't2' }] }],
      ts: '2026-09-24T00:02:00.000Z',
    };
    const pw = await fetch(`${s.base}/api/internal/transcript/${key}/rounds/1${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify(prewrite),
    });
    assert.equal(pw.status, 200);
    assert.deepEqual(await pw.json(), { inserted: true });

    const loaded = await fetch(`${s.base}/api/internal/transcript/${key}${qs}`, { headers: h });
    const body = await loaded.json();
    // 行序：round 0 → round 1（引擎，先入档）→ round 1（宿主预写，后入档）
    assert.deepEqual(
      body.records.map((r) => [r.round, r.dedupKey]),
      [
        [0, seed.dedupKey],
        [1, engine1.dedupKey],
        [1, prewrite.dedupKey],
      ],
    );
    // 引擎 resume 语义：max(round) = 1 → 续跑从 round 2 起，行号无空洞
    assert.equal(Math.max(...body.records.map((r) => r.round)), 1);
    assert.equal(body.next_cursor, 1);
  } finally {
    await s.close();
  }
});

test('session transcript：多 session key 隔离（不同会话互不可见）', async () => {
  const { pool, token, runId, sessionId, userId, containerId } = seedClaimable();
  // 同用户第二个 session + run（排队中，暂不被 claim）
  pool.sessions.push({ id: 's2', user_id: userId, project_id: 'p1', model: 'mock-model', last_seq: 0 });
  pool.runs.push({ id: 'run2', session_id: 's2', status: 'queued' });
  pool.queue.push({ id: 'q2', run_id: 'run2', status: 'pending', attempts: 0, max_attempts: 3, created_at: 2 });
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const rec = {
      round: 0, dedupKey: INPUT(sessionId, 'm1'), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ts: '2026-09-24T00:00:00.000Z',
    };
    const put = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/0?run_id=${runId}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(put.status, 200);

    // 其他 session 读不到
    const other = await fetch(`${s.base}/api/internal/transcript/s2?run_id=${runId}`, { headers: h });
    assert.equal(other.status, 400, 'writer run 不属于 s2 → transcript_key_mismatch');

    // 不存在的 session → 404
    const missing = await fetch(`${s.base}/api/internal/transcript/nope?run_id=${runId}`, { headers: h });
    assert.equal(missing.status, 404);

    // 其他用户的 session → 403
    pool.sessions.push({ id: 's3', user_id: 'u-other', project_id: 'p1', model: 'm', last_seq: 0 });
    const forbidden = await fetch(`${s.base}/api/internal/transcript/s3?run_id=${runId}`, { headers: h });
    assert.equal(forbidden.status, 403);
  } finally {
    await s.close();
  }
});

test('session transcript：fencing——writer run 属主/租约校验、缺 run_id 400、终态后写 409 lease_lost', async () => {
  const { pool, token, runId, sessionId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const rec = {
      round: 0, dedupKey: INPUT(sessionId, 'm1'), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ts: '2026-09-24T00:00:00.000Z',
    };

    // 缺 run_id → 400
    const noRunId = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/0`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(noRunId.status, 400);

    // 错 claim token → 409 lease_lost
    const badToken = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/0?run_id=${runId}`, {
      method: 'PUT',
      headers: { ...h, 'X-Claim-Token': 'forged' },
      body: JSON.stringify(rec),
    });
    assert.equal(badToken.status, 409);
    assert.equal((await badToken.json()).error.code, 'lease_lost');

    // 正常写入 → U2 收敛终态（queue 释放 claim_token）→ 再写 409 lease_lost
    const ok = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/0?run_id=${runId}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(ok.status, 200);
    const running = await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT', headers: h, body: JSON.stringify({ state: 'running' }),
    });
    assert.equal(running.status, 200);
    const fin = await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT',
      headers: h,
      body: JSON.stringify({ state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 1, final_text: 'ok' }),
    });
    assert.equal(fin.status, 200);
    const afterTerminal = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/0?run_id=${runId}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(afterTerminal.status, 409);
    assert.equal((await afterTerminal.json()).error.code, 'lease_lost');
  } finally {
    await s.close();
  }
});

test('session checkpoint：CAS 前进 / 旧 revision 409 / 跨 run 同 key revision 续增', async () => {
  const { pool, token, runId, sessionId, userId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const qs = `?run_id=${runId}`;

    // 无 checkpoint → 204
    const none = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint/latest${qs}`, { headers: h });
    assert.equal(none.status, 204);

    const cp1 = { round: 1, status: 'pending', messages: [] };
    const cp2 = { round: 2, status: 'executed', messages: [] };
    const put1 = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ revision: 1, snapshot: cp1 }),
    });
    assert.equal(put1.status, 200);
    const put2 = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ revision: 2, snapshot: cp2 }),
    });
    assert.equal(put2.status, 200);

    // 旧 revision → 409 checkpoint_stale
    const stale = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ revision: 1, snapshot: cp1 }),
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'checkpoint_stale');

    // 读回最新
    const got = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint/latest${qs}`, { headers: h });
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(body.checkpoint.revision, 2);
    assert.deepEqual(body.checkpoint.snapshot, cp2);

    // 同 session 换 run（re-claim 场景）：revision 从读回值续增，不重置
    pool.runs.push({ id: 'run2', session_id: sessionId, status: 'queued' });
    pool.queue.push({ id: 'q2', run_id: 'run2', status: 'pending', attempts: 0, max_attempts: 3, created_at: 2 });
    // 先让 run1 终态释放（直接改 fake 现场）
    pool._run(runId).status = 'finished';
    pool._queue(runId).status = 'done';
    pool._queue(runId).claim_token = null;
    const claim2 = await fetch(`${s.base}/api/internal/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 1, hold_ms: 10 }),
    });
    const ticket2 = await claim2.json();
    assert.equal(ticket2.run.id, 'run2');
    const h2 = { Authorization: `Bearer ${token}`, 'X-Claim-Token': ticket2.claim_token, 'Content-Type': 'application/json' };
    const put3 = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint?run_id=run2`, {
      method: 'PUT', headers: h2, body: JSON.stringify({ revision: 3, snapshot: { round: 3 } }),
    });
    assert.equal(put3.status, 200);
    const got2 = await fetch(`${s.base}/api/internal/transcript/${sessionId}/checkpoint/latest?run_id=run2`, { headers: h2 });
    assert.equal((await got2.json()).checkpoint.revision, 3);
  } finally {
    await s.close();
  }
});

test('session runstate：saveRunState 合并 + markRunState 终态标记 + loadRunState 往返（runId=key 并 blob）', async () => {
  const { pool, token, runId, sessionId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    const qs = `?run_id=${runId}`;

    // 未落库 → 204
    const empty = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate${qs}`, { headers: h });
    assert.equal(empty.status, 204);

    // saveRunState（引擎形态）
    const put = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ run_state: { stateVersion: 3, deterministic: { rounds: 2 } } }),
    });
    assert.equal(put.status, 200);

    // markRunState 终态标记（引擎形态）
    const mark = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify({ state: 'succeeded' }),
    });
    assert.equal(mark.status, 200);

    const got = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate${qs}`, { headers: h });
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(body.run_state.state, 'succeeded');
    assert.equal(body.run_state.stateVersion, 3);
    assert.deepEqual(body.run_state.deterministic, { rounds: 2 });
    assert.equal(body.run_state.runId, sessionId, 'blob runId = transcript key（引擎契约）');
    // 不动 runs 表（U2 仍是宿主终态唯一权威）
    assert.equal(pool.runs[0].status, 'queued');

    // runs 表不被写入（session runstate 落 chat_sessions.engine_run_state）
    assert.equal(pool.runs[0].run_state, undefined);
    assert.equal(pool.sessions[0].engine_run_state.state, 'succeeded');
  } finally {
    await s.close();
  }
});

test('session transcript：旧 run 作用域端点不受影响（向后兼容旧 runner）', async () => {
  const { pool, token, runId } = seedClaimable();
  const s = await startServer(pool);
  try {
    const ticket = await claimTicket(s, token);
    const h = {
      Authorization: `Bearer ${token}`,
      'X-Claim-Token': ticket.claim_token,
      'Content-Type': 'application/json',
    };
    // U5 run 作用域照旧：UNIQUE(run_id, round) 语义
    const rec = {
      round: 0, dedupKey: `${runId}:engine:round:0:seed`, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      ts: '2026-09-24T00:00:00.000Z',
    };
    const put = await fetch(`${s.base}/api/internal/runs/${runId}/transcript/rounds/0`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(put.status, 200);
    const loaded = await fetch(`${s.base}/api/internal/runs/${runId}/transcript`, { headers: h });
    assert.equal((await loaded.json()).records.length, 1);
    // 与 session 表互不干扰：session transcript 仍是空（该 run 无 session 写入）
    const sessionView = await fetch(`${s.base}/api/internal/transcript/${pool.runs[0].session_id}?run_id=${runId}`, { headers: h });
    assert.deepEqual((await sessionView.json()).records, []);
  } finally {
    await s.close();
  }
});
