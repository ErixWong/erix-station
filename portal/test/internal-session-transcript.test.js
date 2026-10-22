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
    // issue #338：`next_cursor` 不再是一个 round 号，而是不透明串 `<round>:<append_seq>`
    // （本页末行的全序断点）——旧契约 `1` 会丢掉同 round 的后继行。
    assert.equal(body.next_cursor, '1:3');
    assert.match(body.next_cursor, /^[0-9]+:[0-9]+$/, '游标形态：`<round>:<append_seq>`');
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

test('session runstate：快照与终态 status 分离，status API 回退 legacy state', async () => {
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
      method: 'PUT', headers: h, body: JSON.stringify({ run_state: { state: 'must-not-be-saved', stateVersion: 3, deterministic: { rounds: 2 } } }),
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
    assert.equal(Object.hasOwn(body.run_state, 'state'), false);
    assert.equal(body.run_state.stateVersion, 3);
    assert.deepEqual(body.run_state.deterministic, { rounds: 2 });
    assert.equal(body.run_state.runId, sessionId, 'blob runId = transcript key（引擎契约）');
    const statusResponse = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate/status${qs}`, { headers: h });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).status.status, 'succeeded');
    // 不动 runs 表（U2 仍是宿主终态唯一权威）
    assert.equal(pool.runs[0].status, 'queued');

    // session 快照与状态分别存储，runs 表仍不被写入。
    assert.equal(pool.runs[0].run_state, undefined);
    assert.equal(Object.hasOwn(pool.sessions[0].engine_run_state, 'state'), false);
    assert.equal(pool.sessions[0].engine_run_state_status.status, 'succeeded');

    // 无新 status 列值时兼容旧 JSONB 内嵌 state。
    pool.sessions[0].engine_run_state_status = null;
    pool.sessions[0].engine_run_state.state = 'legacy-succeeded';
    const legacyStatus = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate/status${qs}`, { headers: h });
    assert.equal(legacyStatus.status, 200);
    assert.equal((await legacyStatus.json()).status.status, 'legacy-succeeded');

    // 新 status 列格式损坏要显式报错，不静默回退 legacy state。
    pool.sessions[0].engine_run_state_status = { status: 7 };
    const corruptStatus = await fetch(`${s.base}/api/internal/transcript/${sessionId}/runstate/status${qs}`, { headers: h });
    assert.equal(corruptStatus.status, 500);
    assert.equal((await corruptStatus.json()).error.code, 'run_state_status_corrupt');
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

// ---------------------------------------------------------------------------
// issue #338：session transcript 游标从「单个 round 号」换成 `(round, append_seq)` 真 keyset。
//
// 缺陷本体（真库实测，会话 4becb332-…，7 行 3 轮、limit=3）：旧游标只带 round 且下一页过滤
// `round > cursor`（**严格大于**）⇒ 页边界切在一轮肚子里时，该轮剩余行被**永久跳过**
// （实测丢 `…:msg:1:2` 与 `…:engine:round:1`）。后果不是「静默变短」：引擎
// `foldLedgerMessages` 建出的序列里 assistant 的 `tool_use` 没结清 ⇒ `validateMessages` 抛
// `invalid_messages` ⇒ 该会话每次重建上下文都失败且切点稳定（重试无效）。
//
// ⚠ **判据形状是重点**：必须是**有序序列全等**（`[round, dedupKey]` 逐项 deepEqual）。
//   比条数会被「丢一行 + 多读一行」互相抵消；比集合会放过重复读。
// ---------------------------------------------------------------------------

const MSG_ROW = 'message';

/** 0.23 真形状账本：7 行 / 3 轮（一轮多行）。形状照 `transcript-fold.test.js` 的 fixture 口径。 */
function ledgerRealShape(key) {
  return [
    // round 0：宿主预写用户输入（一条）
    {
      round: 0,
      dedupKey: `${key}:input:m1`,
      messages: [{ role: 'user', content: [{ type: 'text', text: '跑一下测试' }] }],
      ts: '2026-10-22T00:00:00.000Z',
    },
    // round 1：assistant 一条（tool_use）+ 结果两条（其中一条带 partOf）+ 载体一条 = 4 行
    {
      round: 1,
      dedupKey: `${key}:msg:1:0`,
      kind: MSG_ROW,
      seq: 0,
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'bash', input: {} }] }],
      ts: '2026-10-22T00:01:00.000Z',
    },
    {
      round: 1,
      dedupKey: `${key}:msg:1:1`,
      kind: MSG_ROW,
      seq: 1,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] }],
      ts: '2026-10-22T00:01:01.000Z',
    },
    {
      round: 1,
      dedupKey: `${key}:msg:1:2`,
      kind: MSG_ROW,
      seq: 2,
      partOf: `${key}:msg:1:1`,
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'more' }] }],
      ts: '2026-10-22T00:01:02.000Z',
    },
    {
      round: 1,
      dedupKey: `${key}:engine:round:1`,
      response: { stopReason: 'end_turn' },
      ts: '2026-10-22T00:01:03.000Z',
    },
    // round 2：assistant 一条 + 载体一条 = 2 行
    {
      round: 2,
      dedupKey: `${key}:msg:2:0`,
      kind: MSG_ROW,
      seq: 0,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: '测试通过' }] }],
      ts: '2026-10-22T00:02:00.000Z',
    },
    {
      round: 2,
      dedupKey: `${key}:engine:round:2`,
      response: { stopReason: 'end_turn' },
      ts: '2026-10-22T00:02:01.000Z',
    },
  ];
}

/** 起服务 + claim + 逐行 PUT（append_seq 由 fake 的插入序模拟真库序列）。 */
async function seedRealShapeServer() {
  const { pool, token, runId, sessionId } = seedClaimable();
  const s = await startServer(pool);
  const ticket = await claimTicket(s, token);
  const h = {
    Authorization: `Bearer ${token}`,
    'X-Claim-Token': ticket.claim_token,
    'Content-Type': 'application/json',
  };
  const qs = `?run_id=${runId}`;
  const rows = ledgerRealShape(sessionId);
  for (const rec of rows) {
    const r = await fetch(`${s.base}/api/internal/transcript/${sessionId}/rounds/${rec.round}${qs}`, {
      method: 'PUT', headers: h, body: JSON.stringify(rec),
    });
    assert.equal(r.status, 200, `种行 ${rec.dedupKey} 应 200`);
  }
  return { s, h, qs, key: sessionId, rows };
}

/** 按 portal 给的 `next_cursor` 一路翻到底（与 `runner/agentd.js` 的 load 循环同构）。 */
async function readAllPages(s, h, key, qs, limit) {
  const pages = [];
  let cursor = null;
  for (;;) {
    const url = `${s.base}/api/internal/transcript/${key}?limit=${limit}${cursor == null ? '' : `&cursor=${encodeURIComponent(cursor)}`}${qs.replace('?', '&')}`;
    const res = await fetch(url, { headers: h });
    assert.equal(res.status, 200);
    const body = await res.json();
    pages.push(body);
    cursor = body.next_cursor;
    if (cursor == null) break;
    assert.ok(pages.length < 50, '分页不终止（游标没前进？）');
  }
  return pages;
}

const seqOf = (records) => records.map((r) => [r.round, r.dedupKey]);

test('#338 P1：limit 切在一轮肚子里也不丢行——分页并集与单页**有序序列全等**', async () => {
  const { s, h, qs, key } = await seedRealShapeServer();
  try {
    const single = await (await fetch(`${s.base}/api/internal/transcript/${key}${qs}`, { headers: h })).json();
    assert.deepEqual(seqOf(single.records), [
      [0, `${key}:input:m1`],
      [1, `${key}:msg:1:0`],
      [1, `${key}:msg:1:1`],
      [1, `${key}:msg:1:2`],
      [1, `${key}:engine:round:1`],
      [2, `${key}:msg:2:0`],
      [2, `${key}:engine:round:2`],
    ], '单页读回 7 行 0.23 真形状（round 1 四行按 append_seq 保序）');

    const pages = await readAllPages(s, h, key, qs, 3);
    assert.ok(pages.length >= 2, 'limit=3 / 7 行 ⇒ 必须真的翻页（否则本用例空转）');
    // 游标必须是「全序断点」，不是 round 号：两页游标必须不同（旧实现都是 `1`）。
    assert.notEqual(pages[0].next_cursor, pages[1].next_cursor,
      'page1/page2 的 next_cursor 必须不同（旧实现只回 round ⇒ 两页都是 1）');
    assert.match(pages[0].next_cursor, /^[0-9]+:[0-9]+$/, '游标形态 `<round>:<append_seq>`');

    const paged = pages.flatMap((p) => p.records);
    // 主判据：**有序序列全等**（不是条数、不是集合）。
    assert.deepEqual(seqOf(paged), seqOf(single.records), '分页并集必须与单页逐项全等（旧实现丢 :msg:1:2 与 :engine:round:1）');
    // 丢的那两行点名（M1 变异 = 把谓词改回 `round > $2` ⇒ 这两条消失）。
    assert.ok(paged.some((r) => r.dedupKey === `${key}:msg:1:2`), ':msg:1:2 不得被页边界跳过');
    assert.ok(paged.some((r) => r.dedupKey === `${key}:engine:round:1`), ':engine:round:1 不得被页边界跳过');
    // 无重复行（M2 变异 = next_cursor 只回 round ⇒ 同 round 行被重读）。
    const keys = paged.map((r) => r.dedupKey);
    assert.equal(new Set(keys).size, keys.length, '分页并集不得出现重复行');

    // 0.23 契约：`append_seq` 是分页内部列，绝不进返回集（宿主/引擎可见形状不变）。
    const expectedByKey = new Map(ledgerRealShape(key).map((rec) => [rec.dedupKey, new Set([...Object.keys(rec), 'round'])]));
    for (const rec of paged) {
      assert.equal(Object.prototype.hasOwnProperty.call(rec, 'append_seq'), false, 'records 不得泄漏 append_seq');
      assert.deepEqual(new Set(Object.keys(rec)), expectedByKey.get(rec.dedupKey),
        `${rec.dedupKey} 的 record 字段集与写入形状逐字相同`);
    }
    // 终止性：最后一页没取到行 ⇒ null；取到行的页必须给游标（哪怕切在一轮中间）。
    for (const page of pages.slice(0, -1)) assert.notEqual(page.next_cursor, null, '非末页必须给游标');
    assert.equal(pages.at(-1).next_cursor, null, '末页（0 行）才 null');
  } finally {
    await s.close();
  }
});

test('#338 P2：limit 恰好切在轮中间——允许半轮跨页，并集仍全等且游标可回灌', async () => {
  const { s, h, qs, key } = await seedRealShapeServer();
  try {
    const single = await (await fetch(`${s.base}/api/internal/transcript/${key}${qs}`, { headers: h })).json();
    // limit=4：page1 = [input, msg:1:0, msg:1:1, msg:1:2]（round 1 只切到一半）
    const p1 = await (await fetch(`${s.base}/api/internal/transcript/${key}?limit=4${qs.replace('?', '&')}`, { headers: h })).json();
    assert.deepEqual(seqOf(p1.records), [
      [0, `${key}:input:m1`],
      [1, `${key}:msg:1:0`],
      [1, `${key}:msg:1:1`],
      [1, `${key}:msg:1:2`],
    ], 'page1 恰切在 round 1 中间（半轮允许）');
    assert.equal(typeof p1.next_cursor, 'string', 'next_cursor 必须是字符串（append_seq 是 bigint，可能超 MAX_SAFE_INTEGER）');
    assert.equal(p1.next_cursor, '1:4', '游标 = 本页末行的 (round, append_seq)');

    // 回灌游标（不透明串原样回传，URL 编码）→ 下一页从断点之后开始，不重读、不跳行。
    const p2 = await (await fetch(`${s.base}/api/internal/transcript/${key}?limit=4&cursor=${encodeURIComponent(p1.next_cursor)}${qs.replace('?', '&')}`, { headers: h })).json();
    assert.deepEqual(seqOf(p2.records), [
      [1, `${key}:engine:round:1`],
      [2, `${key}:msg:2:0`],
      [2, `${key}:engine:round:2`],
    ], 'page2 从断点之后续读（同 round 的后继行必须在）');
    // 终止性：末页（不足 limit 行但**取到了行**）仍必须给游标；下一请求 0 行才 null。
    // 这不是浪费——只有「本页 0 行」是唯一无歧义的到底信号（`rows.length < limit` 在
    // 旧游标语义下判不出「这轮还有后继行」）。
    assert.equal(typeof p2.next_cursor, 'string', '非空末页必须给游标');
    const p3 = await (await fetch(`${s.base}/api/internal/transcript/${key}?limit=4&cursor=${encodeURIComponent(p2.next_cursor)}${qs.replace('?', '&')}`, { headers: h })).json();
    assert.deepEqual(p3.records, [], '断点之后无行 ⇒ 空页');
    assert.equal(p3.next_cursor, null, '空页才是到底（next_cursor=null）');

    assert.deepEqual(seqOf([...p1.records, ...p2.records]), seqOf(single.records), '两页并集与单页全等');
  } finally {
    await s.close();
  }
});

test('#338：cursor 形态非法 → 400 validation_failed + details.field=cursor（零新错误码）', async () => {
  const { s, h, qs, key } = await seedRealShapeServer();
  try {
    for (const bad of ['abc', '1', '1:2:3', '1:', ':2', '1:2x', '']) {
      const res = await fetch(`${s.base}/api/internal/transcript/${key}?cursor=${encodeURIComponent(bad)}${qs.replace('?', '&')}`, { headers: h });
      assert.equal(res.status, 400, `cursor=${JSON.stringify(bad)} 应 400`);
      const body = await res.json();
      assert.equal(body.error.code, 'validation_failed', `cursor=${JSON.stringify(bad)} 错误码`);
      assert.deepEqual(body.error.details, { field: 'cursor' }, `cursor=${JSON.stringify(bad)} details.field`);
    }
    // 合法游标（含超 MAX_SAFE_INTEGER 的 append_seq 段）必须被接受：JS 侧全程字符串。
    const big = await fetch(`${s.base}/api/internal/transcript/${key}?cursor=${encodeURIComponent('2:9007199254740993')}${qs.replace('?', '&')}`, { headers: h });
    assert.equal(big.status, 200, 'append_seq 超 MAX_SAFE_INTEGER 也不得报错（bigint 走字符串）');
    assert.deepEqual(seqOf((await big.json()).records), [], '该断点之后没有行 ⇒ 空页 + next_cursor=null');
    // 对照：同 round、断点略靠前（2:1）⇒ 该 round 的行还在（证明不是「round > 2」语义）。
    const mid = await (await fetch(`${s.base}/api/internal/transcript/${key}?cursor=${encodeURIComponent('2:1')}${qs.replace('?', '&')}`, { headers: h })).json();
    assert.deepEqual(seqOf(mid.records), [
      [2, `${key}:msg:2:0`],
      [2, `${key}:engine:round:2`],
    ], '同 round 的后继行按 append_seq 断点续读');
  } finally {
    await s.close();
  }
});
