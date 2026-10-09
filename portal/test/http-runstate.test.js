// HTTP 层路由测试：internal runstate 端点（PUT/GET /api/internal/runs/:id/runstate，issue #43）。
// 0.14.0 status 与快照分列（runs.run_state / runs.run_state_status）：写入需有效租约 + 非终态；
// 终态后写 409 run_terminal、读放宽（同 U9 口径）。fake pool，不碰真实 DB。
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
      maxFailures: 5,
      windowMs: 15 * 60 * 1000,
      blockMs: 60 * 1000,
      perTokenMaxFailures: 5,
      maxEntries: 10000,
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
  return { server, base, staticDir, close: () => new Promise((res) => server.close(res)) };
}

test('runstate 路由：PUT/GET 往返、租约校验、终态后写 409/读放宽', async () => {
  const { pool, runId, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const auth = { Authorization: `Bearer ${token}` };

    // U1 claim 拿租约（经 HTTP 路由）
    const claim = await fetch(`${s.base}/api/internal/claim`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 1, hold_ms: 10 }),
    });
    assert.equal(claim.status, 200);
    const ticket = await claim.json();
    const claimHeaders = { ...auth, 'X-Claim-Token': ticket.claim_token, 'Content-Type': 'application/json' };

    // 未落库前 GET → 204
    const empty = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, { headers: claimHeaders });
    assert.equal(empty.status, 204);
    const emptyStatus = await fetch(`${s.base}/api/internal/runs/${runId}/runstate/status`, { headers: claimHeaders });
    assert.equal(emptyStatus.status, 204);

    // PUT saveRunState（引擎形态 {run_state}）
    const put = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, {
      method: 'PUT',
      headers: claimHeaders,
      body: JSON.stringify({ run_state: { stateVersion: 3, deterministic: { rounds: 2 } } }),
    });
    assert.equal(put.status, 200);

    // PUT markRunState（引擎终态标记形态 {state}）
    const mark = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, {
      method: 'PUT',
      headers: claimHeaders,
      body: JSON.stringify({ state: 'succeeded' }),
    });
    assert.equal(mark.status, 200);

    // GET 往返：快照不包含终态 status。
    const got = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, { headers: claimHeaders });
    assert.equal(got.status, 200);
    const body = await got.json();
    assert.equal(Object.hasOwn(body.run_state, 'state'), false);
    assert.equal(body.run_state.stateVersion, 3);
    assert.deepEqual(body.run_state.deterministic, { rounds: 2 });
    assert.equal(body.run_state.runId, runId);
    const statusResponse = await fetch(`${s.base}/api/internal/runs/${runId}/runstate/status`, { headers: claimHeaders });
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).status.status, 'succeeded');
    assert.equal(pool.runs[0].status, 'queued', 'mark 不触碰 runs.status');

    // 无租约写 → 409 lease_lost
    const noLease = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ run_state: { stateVersion: 4 } }),
    });
    assert.equal(noLease.status, 409);

    // 终态：先经 U2 置 running（§6.1 真实时序），再收敛 finished 后写 409 run_terminal、读仍 200
    const running = await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT',
      headers: claimHeaders,
      body: JSON.stringify({ state: 'running' }),
    });
    assert.equal(running.status, 200);
    const fin = await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT',
      headers: claimHeaders,
      body: JSON.stringify({
        state: 'finished',
        termination: { reason: 'end_turn' },
        usage: { input_tokens: 1, output_tokens: 2 },
        rounds: 1,
        final_text: 'ok',
      }),
    });
    assert.equal(fin.status, 200);
    const putAfter = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, {
      method: 'PUT',
      headers: claimHeaders,
      body: JSON.stringify({ run_state: { stateVersion: 5 } }),
    });
    assert.equal(putAfter.status, 409);
    const gotAfter = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, { headers: auth });
    assert.equal(gotAfter.status, 200);
    assert.equal((await gotAfter.json()).run_state.stateVersion, 3);
    const statusAfter = await fetch(`${s.base}/api/internal/runs/${runId}/runstate/status`, { headers: auth });
    assert.equal(statusAfter.status, 200, '终态后 status 仍可读');
    assert.equal((await statusAfter.json()).status.status, 'succeeded');

    // 旧版快照内嵌 state 无需迁移，由新 status reader 回退读取。
    pool.runs[0].run_state_status = null;
    pool.runs[0].run_state.state = 'legacy-succeeded';
    const legacyStatus = await fetch(`${s.base}/api/internal/runs/${runId}/runstate/status`, { headers: auth });
    assert.equal(legacyStatus.status, 200);
    assert.equal((await legacyStatus.json()).status.status, 'legacy-succeeded');
    pool.runs[0].run_state_status = { status: 7 };
    const corruptStatus = await fetch(`${s.base}/api/internal/runs/${runId}/runstate/status`, { headers: auth });
    assert.equal(corruptStatus.status, 500, '损坏的新状态不可静默回退');
    assert.equal((await corruptStatus.json()).error.code, 'run_state_status_corrupt');

    // 方法白名单：POST → 405
    const post = await fetch(`${s.base}/api/internal/runs/${runId}/runstate`, {
      method: 'POST',
      headers: claimHeaders,
      body: '{}',
    });
    assert.equal(post.status, 405);
  } finally {
    await s.close();
    fs.rmSync(s.staticDir, { recursive: true, force: true });
  }
});

// issue #220：用户 stop 把 runs.status 置 cancelling 后，引擎那次正常的 markRunState('running')
// 走 U2 必须拿到 2xx ack（否则被引擎渲染成 persistence_failed 的落盘失败）。
// 口径：200 + {state:"cancelling", idempotent:true}，runs.status 不回 running，且**不校验租约**
// （该 ack 零写入、无可 fence 的对象；若去断言租约，claim_token 已被停止路径清空就会变成 409 lease_lost
// ——清理时机与本次写入无关，口径见 portal.md §9.6）。
test('U2 /state：cancelling 期间的 running 写入 → 200 幂等 ack（不依赖租约、不回 running）', async () => {
  const { pool, runId, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const auth = { Authorization: `Bearer ${token}` };
    const claim = await fetch(`${s.base}/api/internal/claim`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 1, hold_ms: 10 }),
    });
    assert.equal(claim.status, 200);
    const ticket = await claim.json();

    // 正常落一次 running（拿 started_at 基线），再模拟停止 + 租约清空。
    const headers = { ...auth, 'X-Claim-Token': ticket.claim_token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT', headers, body: JSON.stringify({ state: 'running' }),
    })).status, 200);
    const startedAt = pool.runs[0].started_at;
    pool.runs[0].status = 'cancelling';
    pool.runs[0].cancel_requested_at = Date.now();
    Object.assign(pool.queue[0], { status: 'cancelled', claim_token: null, lease_until: null, claimed_at: null, owner_container_id: null });

    const ack = await fetch(`${s.base}/api/internal/runs/${runId}/state`, {
      method: 'PUT',
      // 故意带已被清空的旧 claim_token：证明这条 ack 不靠租约成立。
      headers,
      body: JSON.stringify({ state: 'running' }),
    });
    assert.equal(ack.status, 200, `cancelling + running 必须 2xx，得 ${ack.status}: ${JSON.stringify(await ack.clone().json().catch(() => null))}`);
    assert.deepEqual(await ack.json(), { state: 'cancelling', idempotent: true });
    assert.equal(pool.runs[0].status, 'cancelling', 'runs.status 不得被改回 running');
    assert.equal(pool.runs[0].started_at, startedAt, 'started_at 不得再次前移');
    assert.equal(pool.queue[0].status, 'cancelled');
    assert.equal(pool.queue[0].claim_token, null, 'ack 不得回填租约');
  } finally {
    await s.close();
    fs.rmSync(s.staticDir, { recursive: true, force: true });
  }
});
