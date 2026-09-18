// 单测：idempotency.js（portal.md §1.4）——key 规范化（含控制字符原始值校验）/ requestHash（attachments 裁剪）/
// **先占位后执行**语义：回放 / hash 不一致 409 / 占位并发 409 conflict(retryable) / stale in_progress 覆盖后执行 /
// fn 抛错释放占位 / TTL 过期不命中 / purgeExpired。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool（忠实模拟 idempotency_keys 的 state 机与条件 SQL），不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdempotencyError,
  IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  normalizeKey,
  requestHash,
  executeWithIdempotency,
  purgeExpired,
} from '../src/idempotency.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const STALE_MS = IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES * 60 * 1000;

/**
 * 内存 fake pool：模拟 idempotency_keys 的真实语义（含 state 机）。
 * - findDone：`state='done'` 且未过期（TTL 24h）才命中；
 * - claim：无同名行 → 插入 in_progress；同名行仍「新鲜」（done 未过期 / in_progress 未超时）→ 0 行（并发输者）；
 *   同名 done 行已过期 → 原子覆盖为 in_progress（1 行）；
 * - takeOverStale：仅 state='in_progress' 且 ≥ 5 分钟（崩溃残留）→ 抢回（1 行）；
 * - complete / release：按 state 守卫改/删行；
 * - jsonb 列（response）按 node-pg 真实行为解析为对象返回（不是字符串）。
 * `claimMisses` 用于模拟「占位被别人抢到」的窗口（前 N 次 claim 强制 0 行），`onClaimMiss` 可在该窗口 seed 赢家结果。
 */
class FakeIdempotencyPool {
  constructor({ claimMisses = 0, onClaimMiss = null } = {}) {
    this.rows = [];
    this.claimAttempts = 0;
    this.claimMisses = claimMisses;
    this.onClaimMiss = onClaimMiss;
  }

  seed({ userId, endpoint, key, requestHash: hash, state = 'done', statusCode = 202, response = {}, createdAt = new Date() }) {
    this.rows = this.rows.filter((r) => !(r.user_id === userId && r.endpoint === endpoint && r.key === key));
    this.rows.push({
      user_id: userId, endpoint, key, request_hash: hash,
      state, status_code: state === 'done' ? statusCode : null, response: state === 'done' ? response : null,
      created_at: createdAt,
    });
  }

  row({ userId, endpoint, key }) {
    return this.rows.find((r) => r.user_id === userId && r.endpoint === endpoint && r.key === key);
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT request_hash, status_code, response, created_at')) {
      const [userId, endpoint, key] = params;
      const row = this.row({ userId, endpoint, key });
      if (!row || row.state !== 'done' || row.created_at.getTime() <= Date.now() - TTL_MS) return { rows: [] };
      return { rows: [{ request_hash: row.request_hash, status_code: row.status_code, response: row.response, created_at: row.created_at }] };
    }
    if (s.startsWith('SELECT request_hash, state, status_code, response, created_at')) {
      const row = this.row({ userId: params[0], endpoint: params[1], key: params[2] });
      return { rows: row ? [{ ...row }] : [] };
    }
    if (s.startsWith('INSERT INTO idempotency_keys')) {
      this.claimAttempts += 1;
      const [userId, endpoint, key, hash] = params;
      if (this.claimMisses > 0) { // 模拟并发赢家已抢到占位（本请求 DO UPDATE 的 WHERE 不成立 → 0 行）
        this.claimMisses -= 1;
        this.onClaimMiss?.(this);
        return { rows: [] };
      }
      const existing = this.row({ userId, endpoint, key });
      if (existing) {
        if (existing.state === 'done' && existing.created_at.getTime() <= Date.now() - TTL_MS) {
          Object.assign(existing, { request_hash: hash, state: 'in_progress', status_code: null, response: null, created_at: new Date() });
          return { rows: [{ claimed: 1 }] };
        }
        return { rows: [] };
      }
      this.rows.push({
        user_id: userId, endpoint, key, request_hash: hash,
        state: 'in_progress', status_code: null, response: null, created_at: new Date(),
      });
      return { rows: [{ claimed: 1 }] };
    }
    if (s.startsWith('UPDATE idempotency_keys SET request_hash = $4')) { // takeOverStale
      const [userId, endpoint, key, hash] = params;
      const row = this.row({ userId, endpoint, key });
      if (!row || row.state !== 'in_progress' || row.created_at.getTime() > Date.now() - STALE_MS) return { rows: [] };
      Object.assign(row, { request_hash: hash, state: 'in_progress', status_code: null, response: null, created_at: new Date() });
      return { rows: [{ claimed: 1 }] };
    }
    if (s.startsWith(`UPDATE idempotency_keys SET state = 'done'`)) { // complete
      const [userId, endpoint, key, statusCode, response] = params;
      const row = this.row({ userId, endpoint, key });
      if (!row || row.state !== 'in_progress') return { rows: [] };
      Object.assign(row, { state: 'done', status_code: statusCode, response: JSON.parse(response) });
      return { rows: [{ ok: 1 }] };
    }
    if (s.startsWith('DELETE FROM idempotency_keys WHERE user_id') && s.includes(`state = 'in_progress'`)) { // release
      const [userId, endpoint, key] = params;
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(r.user_id === userId && r.endpoint === endpoint && r.key === key && r.state === 'in_progress'));
      return { rows: [], rowCount: before - this.rows.length };
    }
    if (s.startsWith('DELETE FROM idempotency_keys WHERE created_at')) { // purgeExpired
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
const ok = (id = 'm1', run = 'r1') => async () => ({ statusCode: 202, response: { message: { id }, run: { id: run } } });

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

test('normalizeKey：控制字符按**原始值**判定（trim 之前，F6）——只在两侧也不放过', () => {
  for (const v of ['abc\n', '\nabc', ' abc\u0000', '\t', ' a\r\n']) {
    assert.throws(
      () => normalizeKey(v),
      (e) => e instanceof IdempotencyError && e.code === 'validation_failed',
      `trim 前即应拒绝：${JSON.stringify(v)}`,
    );
  }
  // 注：纯空白（仅空格）依旧是「无 key」——空格不是控制字符
  assert.equal(normalizeKey('   '), null, '仅空格的原始值 → 无幂等语义');
});

test('normalizeKey：空格填充的合法 key 仍照常 trim（回归）', () => {
  assert.equal(normalizeKey('  spaced-key  '), 'spaced-key');
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

test('requestHash：attachments 元素裁剪为 {kind,path,name} 子集（F3 / M-7）', () => {
  const baseline = requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', name: 'a.txt' }] });
  // 多送 UI 字段（size/preview_url/id…）不改变 hash
  assert.equal(
    requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', name: 'a.txt', size: 999, preview_url: 'http://x', ui_id: 'z' }] }),
    baseline,
  );
  // 无 name ≡ 不参与（不在 hash 载荷里凭空补字段）
  assert.equal(
    requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', extra: 1 }] }),
    requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a' }] }),
  );
  // 实际消费字段仍参与 hash
  assert.notEqual(requestHash({ content: 'hi', attachments: [{ kind: 'image', path: '/a' }] }), baseline);
  assert.notEqual(requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/b' }] }), baseline);
  assert.notEqual(requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', name: 'b.txt' }] }), baseline);
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
  assert.equal(pool.claimAttempts, 0);
});

test('executeWithIdempotency：同 key 同载荷 → 回放首次结果（fn 只执行一次，台账 state=done）', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  const fn = async () => { calls += 1; return ok()(); };

  const first = await executeWithIdempotency(pool, ctx(), fn);
  assert.equal(first.replayed, false);
  assert.equal(calls, 1);
  assert.equal(pool.rows[0].state, 'done', '执行完成后占位转 done');
  assert.equal(pool.rows[0].status_code, 202);
  assert.deepEqual(pool.rows[0].response, { message: { id: 'm1' }, run: { id: 'r1' } });

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
  await executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); });
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx({ requestHash: requestHash({ content: '别的载荷', attachments: [] }) }), async () => {
      calls += 1;
      return { statusCode: 202, response: {} };
    }),
    (e) => e instanceof IdempotencyError && e.httpStatus === 409 && e.code === 'idempotency_key_reuse' && e.retryable === false,
  );
  assert.equal(calls, 1, '载荷不一致不得执行 fn');
  assert.equal(pool.rows.length, 1);
});

test('executeWithIdempotency：先占位后执行 —— 占位成功后并发第二请求 409 idempotency_conflict(retryable)，fn 调用次数=1', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  let openGate;
  const gate = new Promise((r) => { openGate = r; });
  const fn = async () => { calls += 1; await gate; return ok()(); };

  const first = executeWithIdempotency(pool, ctx(), fn);
  await new Promise((r) => setImmediate(r)); // 让首个请求完成占位并进入 fn()
  assert.equal(calls, 1);
  assert.equal(pool.rows[0].state, 'in_progress', '执行中台账为 in_progress 占位行');

  // 并发第二请求（同 key）：占位已被抢到 → 不等回放、直接 409 conflict（先到先得）
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), fn),
    (e) => e instanceof IdempotencyError && e.httpStatus === 409 && e.code === 'idempotency_conflict' && e.retryable === true,
  );
  assert.equal(calls, 1, '输者不执行 fn（旧「输者回查回放」语义已按新裁决改写）');
  assert.equal(pool.rows.length, 1);

  openGate();
  const r1 = await first;
  assert.equal(r1.replayed, false, '赢家正常返回首次结果');
  assert.equal(pool.rows[0].state, 'done');

  // 赢家完成后，同 key 重发 → 回放（不再 409，也不再执行 fn）
  const third = await executeWithIdempotency(pool, ctx(), fn);
  assert.equal(third.replayed, true);
  assert.equal(calls, 1);
});

test('executeWithIdempotency：占位 0 行但现有行已完成 → 回放赢家结果（不执行 fn）', async () => {
  const pool = new FakeIdempotencyPool({
    claimMisses: 1,
    // 模拟「占位那一瞬赢家刚完成」：claim 0 行时台账里已是 done 行
    onClaimMiss: (p) => p.seed({
      userId: 'u1', endpoint: ctx().endpoint, key: 'k-1', requestHash: ctx().requestHash,
      statusCode: 202, response: { message: { id: 'winner-msg' }, run: { id: 'winner-run' } },
    }),
  });
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); });
  assert.equal(calls, 0, '占位失败且已有完成行 → 只回放');
  assert.equal(res.replayed, true);
  assert.deepEqual(res.response, { message: { id: 'winner-msg' }, run: { id: 'winner-run' } });
  assert.equal(pool.rows.length, 1);
});

test('executeWithIdempotency：占位 0 行且现有行是新鲜 in_progress → 409 conflict（失败者不执行 fn）', async () => {
  const pool = new FakeIdempotencyPool();
  pool.seed({
    userId: 'u1', endpoint: ctx().endpoint, key: 'k-1', requestHash: ctx().requestHash,
    state: 'in_progress', createdAt: new Date(Date.now() - 1000), // 1 秒前（未超 5 分钟）
  });
  let calls = 0;
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); }),
    (e) => e instanceof IdempotencyError && e.code === 'idempotency_conflict' && e.retryable === true,
  );
  assert.equal(calls, 0);
  assert.equal(pool.rows[0].state, 'in_progress', '不得覆写新鲜占位');
});

test('executeWithIdempotency：stale in_progress（≥5 分钟，崩溃残留）→ 覆盖为本次占位后执行 fn', async () => {
  const pool = new FakeIdempotencyPool();
  pool.seed({
    userId: 'u1', endpoint: ctx().endpoint, key: 'k-1', requestHash: 'stale-hash',
    state: 'in_progress', createdAt: new Date(Date.now() - (STALE_MS + 60_000)), // 6 分钟前
  });
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok('m-new', 'r-new')(); });
  assert.equal(calls, 1, 'stale 占位视同可覆盖 → 本次执行');
  assert.equal(res.replayed, false);
  assert.deepEqual(res.response, { message: { id: 'm-new' }, run: { id: 'r-new' } });
  assert.equal(pool.rows.length, 1, '同一行被覆盖（不是新增第二行）');
  assert.equal(pool.rows[0].state, 'done');
  assert.equal(pool.rows[0].request_hash, ctx().requestHash, 'request_hash 更新为本次载荷');
});

test('executeWithIdempotency：fn 抛错 → 删除占位行（原样 rethrow），同 key 可重试', async () => {
  const pool = new FakeIdempotencyPool();
  const boom = new Error('postMessage failed');
  let calls = 0;
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async () => { calls += 1; throw boom; }),
    (e) => e === boom,
  );
  assert.equal(calls, 1);
  assert.equal(pool.rows.length, 0, '占位行被释放（不把瞬时错误钉成永久结果）');

  // 释放后同 key 可再次执行（客户端重试）
  const retry = await executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); });
  assert.equal(calls, 2);
  assert.equal(retry.replayed, false);
  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].state, 'done');
});

test('executeWithIdempotency：占位持续 0 行且无行可观（并发方释放/回滚）→ 重试后仍不可占 → 409 conflict(retryable)', async () => {
  const pool = new FakeIdempotencyPool({ claimMisses: 10 }); // 恒 0 行、也不 seed 任何行
  let calls = 0;
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); }),
    (e) => e instanceof IdempotencyError && e.httpStatus === 409 && e.code === 'idempotency_conflict' && e.retryable === true,
  );
  assert.equal(calls, 0, '从未占到占位 → 绝不执行 fn');
  assert.ok(pool.claimAttempts >= 2, `占位失败会重试后放弃（实际 ${pool.claimAttempts} 次）`);
});

test('executeWithIdempotency：占位 0 行但占位行已被并发方释放 → 重试占到并执行（不误报 conflict）', async () => {
  const pool = new FakeIdempotencyPool({ claimMisses: 1 }); // 第 1 次 claim 落空（无行），第 2 次成功
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async () => { calls += 1; return ok()(); });
  assert.equal(calls, 1, '重试占到占位 → 正常执行');
  assert.equal(res.replayed, false);
  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].state, 'done');
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

test('executeWithIdempotency：TTL 24h —— 过期完成行不命中（重新执行并原子覆盖台账）', async () => {
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
  assert.equal(pool.rows[0].state, 'done');
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
