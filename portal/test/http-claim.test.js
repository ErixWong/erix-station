// HTTP 层测试：/api/internal/claim 的「孤儿化 claim」修复（issue #180）。
// 客户端（agentd）在响应写出前断开 → portal 识别死连接（res 'close' + !writableEnded）并中断长轮询，
// 不为死连接领 ticket；否则 reaper 重排队唤醒会白耗一次 attempt 且占租约到自然到期。
// fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hubStats, notifyRunEnqueued } from '../src/internal.js';
import { seedClaimable } from './fake-internal-pool.js';

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
  const server = createServer({ pool, config, log: { warn() {}, info() {}, error() {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    base,
    close: () => {
      // 客户端 abort 后 socket 可能仍被 server 追踪，直接 close 会等到 keep-alive 超时。
      server.closeAllConnections?.();
      return new Promise((res) => server.close(res));
    },
  };
}

async function until(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('until: condition not met within timeout');
}

test('#180 HTTP：claim 长轮询期间客户端断开 → 服务端立即退出等待，不为死连接领 ticket', async () => {
  const { pool, runId, token, userId } = seedClaimable();
  // 行已被（死掉的）agentd 持有且租约未过期 → 首次 tryClaim 失败，服务端进入长轮询。
  const q = pool.queue[0];
  q.status = 'claimed';
  q.claim_token = 'dead-agent-token';
  q.owner_container_id = 'dead-container';
  q.claimed_at = Date.now();
  q.lease_until = Date.now() + 90000;
  q.attempts = 1;
  pool.runs[0].status = 'running';

  const s = await startServer(pool);
  try {
    const ac = new AbortController();
    const pending = fetch(`${s.base}/api/internal/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity: 1, hold_ms: 5000 }),
      signal: ac.signal,
    }).catch(() => null);

    // 等 handler 挂起在长轮询（claimWaiters 注册）。
    await until(() => hubStats().claimWaiters === 1);

    // 客户端断开（模拟容器 SIGKILL：连接被 OS 关闭）。
    ac.abort();
    // 服务端识别死连接并退出等待（否则 waiter 会一直挂到 hold_ms=5000）。
    await until(() => hubStats().claimWaiters === 0);
    await pending; // 客户端侧已 abort → null

    // 模拟 reaper 把 run 重排队 + 唤醒（孤儿化 claim 的触发时序）。
    q.status = 'pending';
    q.claim_token = null;
    q.lease_until = null;
    q.claimed_at = null;
    notifyRunEnqueued(userId, { run_id: runId, queue_id: q.id });
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(q.attempts, 1, '死连接的悬挂 claim 未消耗 attempt');
    assert.equal(q.status, 'pending', '未被死连接认领（仍 pending）');
    assert.equal(q.claim_token, null, '无 claim_token 占用');
  } finally {
    await s.close();
  }
});
