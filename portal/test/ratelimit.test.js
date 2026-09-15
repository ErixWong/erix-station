// 单测：ratelimit.js（限流器 prune 清理过期条目 / 最大条目淘汰 + KDF 信号量队列上限与超时）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, createSemaphore } from '../src/ratelimit.js';

test('限流器：封禁过期后 prune 同时清理过期条目（含已封禁者），Map 不再无界增长', () => {
  const rl = createRateLimiter({ maxFailures: 2, windowMs: 1000, blockMs: 1000 });
  const t0 = 1_000_000;
  rl.recordFailure('a', t0);
  rl.recordFailure('a', t0); // 达到阈值 → blockedUntil = t0 + 1000
  assert.equal(rl.size(), 1);

  // 封禁期内不清理
  rl.check('a', t0 + 500);
  assert.equal(rl.size(), 1);

  // 封禁已过期且超出窗口 → prune 清理
  rl.check('a', t0 + 2000);
  assert.equal(rl.size(), 0);
});

test('限流器：达到 maxEntries 按最旧淘汰，条目数不超上限', () => {
  const rl = createRateLimiter({ maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 2 });
  const t0 = 1_000_000;
  rl.recordFailure('a', t0);
  rl.recordFailure('b', t0 + 1);
  assert.equal(rl.size(), 2);

  // 插入第三个 key：最旧的 'a' 被淘汰
  rl.recordFailure('c', t0 + 2);
  assert.equal(rl.size(), 2);
  assert.equal(rl.check('a', t0 + 3).allowed, true); // 'a' 已淘汰
  assert.equal(rl.check('b', t0 + 3).allowed, true);
  assert.equal(rl.check('c', t0 + 3).allowed, true);
});

test('KDF 信号量：队列满时 acquire 快速失败（kdf_queue_full）', async () => {
  const sem = createSemaphore({ max: 1, maxQueue: 1, queueTimeoutMs: 5000 });
  await sem.acquire(); // active = 1
  const queued = sem.acquire(); // 占用队列唯一空位
  await assert.rejects(sem.acquire(), (err) => err.code === 'kdf_queue_full');

  sem.release();
  await queued;
  sem.release();
  assert.equal(sem.active(), 0);
  assert.equal(sem.pending(), 0);
});

test('KDF 信号量：排队超时快速失败（kdf_queue_timeout），不无限排队', async () => {
  const sem = createSemaphore({ max: 1, maxQueue: 5, queueTimeoutMs: 30 });
  await sem.acquire(); // active = 1
  await assert.rejects(sem.acquire(), (err) => err.code === 'kdf_queue_timeout');
  assert.equal(sem.pending(), 0);
  sem.release();
  assert.equal(sem.active(), 0);
});
