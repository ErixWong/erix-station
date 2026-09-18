// 单测：idempotency.js（portal.md §1.4）——key 规范化 / requestHash / 命中回放 / hash 不一致 409 /
// 非法 key 400 / 并发冲突回查 / TTL 过期不命中 / purgeExpired。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool（模拟 idempotency_keys 表语义），不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdempotencyError,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  normalizeKey,
  requestHash,
  executeWithIdempotency,
  purgeExpired,
} from '../src/idempotency.js';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 内存 fake pool：模拟 idempotency_keys 的查询/插入/TTL 清理语义。
 * - jsonb 列（response）按 node-pg 真实行为解析为对象返回（不是字符串）。
 * - INSERT 按真实 SQL 的 `ON CONFLICT ... DO UPDATE ... WHERE created_at <= now() - interval '24 hours'` 语义：
 *   同名行仍新鲜 → 0 行（并发输者）；同名行已过期 → 覆盖并返回 1 行。
 * - `insertIgnored: true` 模拟「并发赢家已抢到新鲜同名行」：INSERT 恒返回 0 行。
 */
class FakeIdempotencyPool {
  constructor({ insertIgnored = false } = {}) {
    this.rows = [];
    this.insertIgnored = insertIgnored;
    this.insertAttempts = 0;
  }

  seed({ userId, endpoint, key, requestHash: hash, statusCode = 202, response = {}, createdAt = new Date() }) {
    this.rows.push({
      user_id: userId, endpoint, key, request_hash: hash,
      status_code: statusCode, response, created_at: createdAt,
    });
  }

  find({ userId, endpoint, key }) {
    return this.rows.find(
      (r) => r.user_id === userId && r.endpoint === endpoint && r.key === key
        && r.created_at.getTime() > Date.now() - TTL_MS,
    );
  }

  async query(sql, params = []) {
    if (sql.includes('SELECT request_hash, status_code, response')) {
      const [userId, endpoint, key] = params;
      const row = this.find({ userId, endpoint, key });
      if (!row) return { rows: [] };
      return { rows: [{ request_hash: row.request_hash, status_code: row.status_code, response: row.response }] };
    }
    if (sql.includes('INSERT INTO idempotency_keys')) {
      this.insertAttempts += 1;
      const [userId, endpoint, key, hash, statusCode, response] = params;
      if (this.insertIgnored) return { rows: [] }; // ON CONFLICT（同名行仍新鲜）DO UPDATE → 0 行
      const existing = this.rows.find((r) => r.user_id === userId && r.endpoint === endpoint && r.key === key);
      if (existing) {
        if (existing.created_at.getTime() >= Date.now() - TTL_MS) return { rows: [] }; // 仍新鲜 → 不覆盖
        // 已过期 → 本次结果覆盖（同一行，PK 不变）
        existing.request_hash = hash;
        existing.status_code = statusCode;
        existing.response = JSON.parse(response);
        existing.created_at = new Date();
        return { rows: [{ inserted: 1 }] };
      }
      this.rows.push({
        user_id: userId, endpoint, key, request_hash: hash,
        status_code: statusCode, response: JSON.parse(response), created_at: new Date(),
      });
      return { rows: [{ inserted: 1 }] };
    }
    if (sql.includes('DELETE FROM idempotency_keys')) {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => r.created_at.getTime() >= Date.now() - TTL_MS);
      return { rows: [], rowCount: before - this.rows.length };
    }
    throw new Error(`unexpected SQL in fake pool: ${sql}`);
  }
}

const ctx = (over = {}) => ({
  userId: 'u1', endpoint: 'POST /api/sessions/s1/messages', key: 'k-1',
  requestHash: requestHash({ content: 'hi', attachments: [] }), ...over,
});

test('normalizeKey：无头/空串 → null（无幂等语义）；合法 key 去空白返回', () => {
  assert.equal(normalizeKey(undefined), null);
  assert.equal(normalizeKey(null), null);
  assert.equal(normalizeKey(''), null);
  assert.equal(normalizeKey('   '), null); // 纯空白 = 无幂等语义
  assert.equal(normalizeKey('abc-123'), 'abc-123');
  assert.equal(normalizeKey('  abc-123  '), 'abc-123');
  assert.equal(normalizeKey('x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH)), 'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH));
});

test('normalizeKey：非字符串/超长/控制字符 → 400 validation_failed', () => {
  const bad = [
    123,
    ['a'],
    'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
    'abc\ndef',       // CR/LF 头注入
    'abc\u0000def',
    'abc\u007fdef',
  ];
  for (const v of bad) {
    assert.throws(
      () => normalizeKey(v),
      (e) => e instanceof IdempotencyError && e.code === 'validation_failed' && e.httpStatus === 400,
      `应拒绝：${JSON.stringify(v)}`,
    );
  }
});

test('requestHash：规范化 content + attachments（键序无关、无关字段忽略）', () => {
  const a = requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', name: 'a.txt' }] });
  const b = requestHash({ content: 'hi', attachments: [{ name: 'a.txt', path: '/a', kind: 'file' }] });
  assert.equal(a, b, 'attachment 对象键序不同 → 同一 hash');
  assert.notEqual(a, requestHash({ content: 'hi2', attachments: [{ kind: 'file', path: '/a', name: 'a.txt' }] }));
  assert.notEqual(a, requestHash({ content: 'hi', attachments: [] }));
  // 非幂等相关字段（UI 提示等）不参与 hash
  assert.equal(requestHash({ content: 'hi', attachments: [] }), requestHash({ content: 'hi', attachments: [], ui_hint: 'x' }));
  // 缺省 attachments ≡ 空数组；非字符串 content 规范化 ''
  assert.equal(requestHash({ content: 'hi' }), requestHash({ content: 'hi', attachments: [] }));
  assert.equal(requestHash({}), requestHash({ content: '', attachments: [] }));
});

test('executeWithIdempotency：无 key → 直通执行且不落台账', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx({ key: null }), async () => {
    calls += 1;
    return { statusCode: 202, response: { message: { id: 'm1' }, run: { id: 'r1' } } };
  });
  assert.equal(calls, 1);
  assert.equal(res.replayed, false);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(res.response, { message: { id: 'm1' }, run: { id: 'r1' } });
  assert.equal(pool.rows.length, 0, '无 key 不写台账');
  assert.equal(pool.insertAttempts, 0);
});

test('executeWithIdempotency：同 key 同载荷 → 回放首次结果（fn 只执行一次，同 message.id/run.id）', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  const fn = async () => {
    calls += 1;
    return { statusCode: 202, response: { message: { id: 'm1' }, run: { id: 'r1' } } };
  };

  const first = await executeWithIdempotency(pool, ctx(), fn);
  assert.equal(first.replayed, false);
  assert.equal(calls, 1);

  const second = await executeWithIdempotency(pool, ctx(), fn);
  assert.equal(second.replayed, true, '第二次为回放');
  assert.equal(calls, 1, '回放不重复执行 fn（不产生第二次副作用/notify）');
  assert.equal(second.statusCode, 202, '按首次 status_code 返回');
  assert.deepEqual(second.response, first.response, '按首次响应体原样返回');
  assert.equal(pool.rows.length, 1, '台账只有一行');
});

test('executeWithIdempotency：同 key 不同载荷 → 409 idempotency_key_reuse（不执行第二次副作用）', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  await executeWithIdempotency(pool, ctx(), async () => {
    calls += 1;
    return { statusCode: 202, response: { message: { id: 'm1' }, run: { id: 'r1' } } };
  });
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx({ requestHash: requestHash({ content: '别的载荷', attachments: [] }) }), async () => {
      calls += 1;
      return { statusCode: 202, response: {} };
    }),
    (e) => e instanceof IdempotencyError && e.httpStatus === 409 && e.code === 'idempotency_key_reuse',
  );
  assert.equal(calls, 1, '载荷不一致不得执行 fn');
  assert.equal(pool.rows.length, 1);
});

test('executeWithIdempotency：并发同 key —— 抢写失败者回查并回放首次结果（防双执行）', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async () => {
    calls += 1;
    // 模拟并发赢家在本请求 fn() 期间写入首次结果（本请求随后 INSERT 冲突）
    pool.seed({
      userId: 'u1', endpoint: ctx().endpoint, key: 'k-1',
      requestHash: ctx().requestHash, statusCode: 202,
      response: { message: { id: 'winner-msg' }, run: { id: 'winner-run' } },
    });
    return { statusCode: 202, response: { message: { id: 'loser-msg' }, run: { id: 'loser-run' } } };
  });
  assert.equal(calls, 1);
  assert.equal(res.replayed, true, '并发输者回放赢家结果');
  assert.deepEqual(res.response, { message: { id: 'winner-msg' }, run: { id: 'winner-run' } });
  assert.equal(pool.rows.length, 1);
});

test('executeWithIdempotency：并发抢写失败且回查无行 → 409 idempotency_conflict（可重试）', async () => {
  const pool = new FakeIdempotencyPool({ insertIgnored: true });
  let calls = 0;
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async () => {
      calls += 1;
      return { statusCode: 202, response: {} };
    }),
    (e) => e instanceof IdempotencyError && e.httpStatus === 409 && e.code === 'idempotency_conflict' && e.retryable === true,
  );
  assert.equal(calls, 1);
});

test('executeWithIdempotency：endpoint 含路径参数 —— 同 key 跨 session 不串号', async () => {
  const pool = new FakeIdempotencyPool();
  const s1 = await executeWithIdempotency(pool, ctx(), async () => ({ statusCode: 202, response: { run: { id: 'r-s1' } } }));
  const s2 = await executeWithIdempotency(
    pool,
    ctx({ endpoint: 'POST /api/sessions/s2/messages' }),
    async () => ({ statusCode: 202, response: { run: { id: 'r-s2' } } }),
  );
  assert.equal(s1.replayed, false);
  assert.equal(s2.replayed, false, '不同 endpoint 不命中');
  assert.deepEqual(s2.response, { run: { id: 'r-s2' } });
  assert.equal(pool.rows.length, 2);
});

test('executeWithIdempotency：TTL 24h —— 过期记录不命中（重新执行并原子覆盖台账）', async () => {
  const pool = new FakeIdempotencyPool();
  pool.seed({
    userId: 'u1', endpoint: ctx().endpoint, key: 'k-1', requestHash: ctx().requestHash,
    statusCode: 202, response: { message: { id: 'stale' } },
    createdAt: new Date(Date.now() - TTL_MS - 60_000), // 25h 前
  });
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async () => {
    calls += 1;
    return { statusCode: 202, response: { message: { id: 'fresh' } } };
  });
  assert.equal(calls, 1, '过期记录不构成命中');
  assert.equal(res.replayed, false);
  assert.deepEqual(res.response, { message: { id: 'fresh' } });
  // stale 行被原子覆盖（不是新增第二行，也不是 409 conflict）
  assert.equal(pool.rows.length, 1);
  assert.deepEqual(pool.rows[0].response, { message: { id: 'fresh' } });
});

test('executeWithIdempotency：hash 不一致但过期 → 不 409（视为未命中）', async () => {
  const pool = new FakeIdempotencyPool();
  pool.seed({
    userId: 'u1', endpoint: ctx().endpoint, key: 'k-1',
    requestHash: requestHash({ content: '旧载荷', attachments: [] }),
    statusCode: 202, response: {},
    createdAt: new Date(Date.now() - TTL_MS - 60_000),
  });
  const res = await executeWithIdempotency(pool, ctx(), async () => ({ statusCode: 202, response: { ok: true } }));
  assert.equal(res.replayed, false);
  assert.deepEqual(res.response, { ok: true });
});

test('purgeExpired：只清过期行，返回删除条数', async () => {
  const pool = new FakeIdempotencyPool();
  pool.seed({ userId: 'u1', endpoint: 'e', key: 'old-1', requestHash: 'h', createdAt: new Date(Date.now() - TTL_MS - 1000) });
  pool.seed({ userId: 'u1', endpoint: 'e', key: 'old-2', requestHash: 'h', createdAt: new Date(Date.now() - TTL_MS - 5000) });
  pool.seed({ userId: 'u1', endpoint: 'e', key: 'fresh', requestHash: 'h' });

  const purged = await purgeExpired(pool);
  assert.equal(purged, 2);
  assert.deepEqual(pool.rows.map((r) => r.key), ['fresh']);
  assert.equal(await purgeExpired(pool), 0);
});
