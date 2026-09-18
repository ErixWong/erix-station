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
 * 内存 fake pool：模拟 idempotency_keys 的真实语义（含 state 机 + **claim_token owner fencing**）。
 * - findDone：`state='done'` 且未过期（TTL 24h）才命中；
 * - claim：无同名行 → 插入 in_progress（写入本次 claim_token）；同名行仍「新鲜」→ 0 行；
 *   同名 done 行已过期 → 原子覆盖为 in_progress（并改写 claim_token）；
 * - takeOverStale：仅 state='in_progress' 且 ≥ 5 分钟（崩溃残留）→ 抢回（**改写 claim_token**）；
 * - writeDone（转 done）：`state='in_progress' AND claim_token=$` 双条件，失配 → 0 行（fencing）；
 * - release：`state='in_progress' AND claim_token=$` 双条件（不删别人/新持有者的占位）；
 * - jsonb 列（response）按 node-pg 真实行为解析为对象返回（不是字符串）。
 * `claimMisses` 用于模拟「占位被别人抢到」的窗口（前 N 次 claim 强制 0 行），`onClaimMiss` 可在该窗口 seed 赢家结果。
 * `ledgerWrites` 计数台账 done 写入的来源（tx = 业务事务 client 内，pool = 幂等层补记），用于断言
 * 「record 路径不再补记」（同事务记账生效）。
 */
class FakeIdempotencyPool {
  constructor({ claimMisses = 0, onClaimMiss = null } = {}) {
    this.rows = [];
    this.claimAttempts = 0;
    this.claimMisses = claimMisses;
    this.onClaimMiss = onClaimMiss;
    this.ledgerWrites = { tx: 0, pool: 0 };
    // 由 FakeTxClient 在代执行期间置位：用于区分「客户端的同事务记账」与「幂等层的补记」
    this.inTxClient = null;
  }

  seed({ userId, endpoint, key, requestHash: hash, state = 'done', statusCode = 202, response = {}, createdAt = new Date(), claimToken = null }) {
    this.rows = this.rows.filter((r) => !(r.user_id === userId && r.endpoint === endpoint && r.key === key));
    this.rows.push({
      user_id: userId, endpoint, key, request_hash: hash,
      state, status_code: state === 'done' ? statusCode : null, response: state === 'done' ? response : null,
      claim_token: claimToken, created_at: createdAt,
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
      const [userId, endpoint, key, hash, claimToken] = params;
      if (this.claimMisses > 0) { // 模拟并发赢家已抢到占位（本请求 DO UPDATE 的 WHERE 不成立 → 0 行）
        this.claimMisses -= 1;
        this.onClaimMiss?.(this);
        return { rows: [] };
      }
      const existing = this.row({ userId, endpoint, key });
      if (existing) {
        if (existing.state === 'done' && existing.created_at.getTime() <= Date.now() - TTL_MS) {
          Object.assign(existing, { request_hash: hash, state: 'in_progress', status_code: null, response: null, claim_token: claimToken, created_at: new Date() });
          return { rows: [{ claimed: 1 }] };
        }
        return { rows: [] };
      }
      this.rows.push({
        user_id: userId, endpoint, key, request_hash: hash,
        state: 'in_progress', status_code: null, response: null, claim_token: claimToken, created_at: new Date(),
      });
      return { rows: [{ claimed: 1 }] };
    }
    if (s.startsWith('UPDATE idempotency_keys SET request_hash = $4')) { // takeOverStale（抢回：改写 claim_token）
      const [userId, endpoint, key, hash, claimToken] = params;
      const row = this.row({ userId, endpoint, key });
      if (!row || row.state !== 'in_progress' || row.created_at.getTime() > Date.now() - STALE_MS) return { rows: [] };
      Object.assign(row, { request_hash: hash, state: 'in_progress', status_code: null, response: null, claim_token: claimToken, created_at: new Date() });
      return { rows: [{ claimed: 1 }] };
    }
    if (s.startsWith(`UPDATE idempotency_keys SET state = 'done'`)) { // writeDone（state + claim_token 双条件）
      const [userId, endpoint, key, statusCode, response, claimToken] = params;
      this.ledgerWrites[this.inTxClient ? 'tx' : 'pool'] += 1;
      const row = this.row({ userId, endpoint, key });
      if (!row || row.state !== 'in_progress' || row.claim_token !== claimToken) return { rows: [], rowCount: 0 };
      Object.assign(row, { state: 'done', status_code: statusCode, response: JSON.parse(response) });
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    if (s.startsWith('DELETE FROM idempotency_keys WHERE user_id') && s.includes(`state = 'in_progress'`)) { // release（state + claim_token 双条件）
      const [userId, endpoint, key, claimToken] = params;
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(r.user_id === userId && r.endpoint === endpoint && r.key === key && r.state === 'in_progress' && r.claim_token === claimToken));
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

/**
 * 业务事务 fake client（模拟 `sessions.postMessage` 的连接）：
 * BEGIN → 业务写入 → `record(client, 202, payload)` → COMMIT/ROLLBACK。
 * 台账写写入**真的落到 pool**（故 record 能立即看到 fencing 的 0 行），ROLLBACK 则回滚到 BEGIN 时的快照
 * （模拟 Postgres 事务回滚）——用于验证「记账与业务写入同事务」。
 * 台账写入计到 `pool.ledgerWrites.tx`（幂等层的补记计到 `.pool`），供断言「record 路径不再补记」。
 */
class FakeTxClient {
  constructor(pool) {
    this.pool = pool;
    this.snapshot = structuredClone(pool.rows);
    this.committed = false;
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s === 'BEGIN') return { rows: [] };
    if (s === 'COMMIT') { this.snapshot = null; this.committed = true; return { rows: [] }; }
    if (s === 'ROLLBACK') {
      if (this.snapshot) this.pool.rows = this.snapshot;
      this.snapshot = null;
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO messages')) return { rows: [{ id: 'm-tx', seq: 1 }] }; // 业务写入（fake）
    if (s.startsWith('UPDATE idempotency_keys')) {
      const prev = this.pool.inTxClient;
      this.pool.inTxClient = this;
      try { return await this.pool.query(sql, params); } finally { this.pool.inTxClient = prev; }
    }
    throw new Error(`unexpected SQL in fake tx client: ${sql}`);
  }
}

/**
 * 模拟 sessions.postMessage 的业务事务：BEGIN → 写消息 → record(client,…) → COMMIT/ROLLBACK。
 * 与真实实现同构：record 抛错（占位被接管）→ ROLLBACK → 原样 rethrow（业务写入与记账一起回滚）。
 */
async function businessTx(pool, record, payload = { message: { id: 'm-new' }, run: { id: 'r-new' } }) {
  const client = new FakeTxClient(pool);
  await client.query('BEGIN');
  try {
    await client.query(`INSERT INTO messages (session_id, seq, role) VALUES ($1, $2, $3)`, ['s1', 1, 'user']);
    if (record) await record(client, 202, payload);
    await client.query('COMMIT');
    return { client, payload };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
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

// ---------------------------------------------------------------------------
// PR #26 修复轮 2（G2）：记账并入业务事务（record）+ claim_token owner fencing
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('G2 record 路径：fn 在自身事务内记账（同 client）→ 台账 done 不再由幂等层补记', async () => {
  const pool = new FakeIdempotencyPool();
  let calls = 0;
  const res = await executeWithIdempotency(pool, ctx(), async (record) => {
    calls += 1;
    const { payload } = await businessTx(pool, record);
    return { statusCode: 202, response: payload };
  });
  assert.equal(calls, 1);
  assert.equal(res.replayed, false);
  assert.equal(pool.rows.length, 1);
  assert.equal(pool.rows[0].state, 'done', 'record 已把台账转 done');
  assert.equal(pool.rows[0].status_code, 202);
  assert.deepEqual(pool.rows[0].response, { message: { id: 'm-new' }, run: { id: 'r-new' } });
  assert.match(pool.rows[0].claim_token, UUID_RE, '占位时写入 claim_token（UUID），done 后保留');
  assert.deepEqual(pool.ledgerWrites, { tx: 1, pool: 0 }, '记账恰好一次且经业务事务 client（幂等层不再补记）');

  // 同 key 重发 → 回放（不执行 fn，也不再记账）
  const again = await executeWithIdempotency(pool, ctx(), async (record) => {
    calls += 1;
    const { payload } = await businessTx(pool, record);
    return { statusCode: 202, response: payload };
  });
  assert.equal(again.replayed, true);
  assert.equal(calls, 1);
  assert.deepEqual(again.response, { message: { id: 'm-new' }, run: { id: 'r-new' } });
  assert.deepEqual(pool.ledgerWrites, { tx: 1, pool: 0 });
});

test('G2 同事务：fn 的事务 ROLLBACK → 台账不留 done（记账与业务写入同事务）', async () => {
  const pool = new FakeIdempotencyPool();
  const res = await executeWithIdempotency(pool, ctx(), async (record) => {
    const client = new FakeTxClient(pool);
    await client.query('BEGIN');
    await record(client, 202, { message: { id: 'm-rollback' } });
    await client.query('ROLLBACK');
    return { statusCode: 202, response: { message: { id: 'm-rollback' } } };
  });
  assert.equal(res.replayed, false);
  assert.equal(pool.rows[0].state, 'in_progress', '业务事务回滚 → 台账不得留 done（无幻影结果）');
  assert.equal(pool.rows[0].response, null);
  assert.equal(pool.rows[0].status_code, null);
});

test('G2 向后兼容：fn 不调用 record → 幂等层补记（业务提交后才写台账，既有残余窗口）', async () => {
  const pool = new FakeIdempotencyPool();
  const res = await executeWithIdempotency(pool, ctx(), ok('m-legacy', 'r-legacy'));
  assert.equal(res.replayed, false);
  assert.deepEqual(pool.ledgerWrites, { tx: 0, pool: 1 }, '补记路径经 pool（非 fn 事务）');
  assert.equal(pool.rows[0].state, 'done');
  assert.deepEqual(pool.rows[0].response, { message: { id: 'm-legacy' }, run: { id: 'r-legacy' } });
});

test('G2 fencing：record 在占位被接管后调用 → 409 idempotency_conflict(retryable)，业务事务回滚且不写 done', async () => {
  const pool = new FakeIdempotencyPool();
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async (record) => {
      pool.rows[0].claim_token = 'other-owner-token'; // 模拟占位已被其它请求抢回（owner 变更）
      const { payload } = await businessTx(pool, record);
      return { statusCode: 202, response: payload };
    }),
    (e) => e instanceof IdempotencyError
      && e.code === 'idempotency_conflict' && e.httpStatus === 409 && e.retryable === true,
  );
  assert.equal(pool.ledgerWrites.tx, 1, 'record 尝试了一次 UPDATE');
  assert.equal(pool.rows[0].state, 'in_progress', '输者不得把台账写成 done');
  assert.equal(pool.rows[0].claim_token, 'other-owner-token', '新持有者的 token 未被覆写');
  assert.equal(pool.rows[0].response, null);
});

test('G2 fencing：release 带 claim_token —— 占位被接管后旧 owner 的释放不删新占位', async () => {
  const pool = new FakeIdempotencyPool();
  const boom = new Error('postMessage failed');
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async () => {
      pool.rows[0].claim_token = 'other-owner-token'; // fn 执行期间占位被抢回
      throw boom;
    }),
    (e) => e === boom,
  );
  assert.equal(pool.rows.length, 1, '不得删掉新持有者的占位行');
  assert.equal(pool.rows[0].claim_token, 'other-owner-token');
  assert.equal(pool.rows[0].state, 'in_progress');
});

test('G2 fencing：补记路径同样带 claim_token —— 占位被接管后补记 0 行（告警但不改写台账）', async () => {
  const pool = new FakeIdempotencyPool();
  const warns = [];
  const res = await executeWithIdempotency(pool, ctx({ log: { warn: (m) => warns.push(m) } }), async () => {
    pool.rows[0].claim_token = 'other-owner-token'; // fn 执行期间占位被抢回
    return { statusCode: 202, response: { message: { id: 'm-loser' } } };
  });
  assert.equal(res.statusCode, 202, '业务已提交 → 按 fn 结果返回（该路径的残余窗口见 portal.md §1.4）');
  assert.equal(pool.rows[0].state, 'in_progress', '不得覆写新持有者的占位');
  assert.equal(pool.rows[0].claim_token, 'other-owner-token');
  assert.equal(warns.length, 1, '补记失配必须告警（不静默）');
  assert.match(warns[0], /claim_token 失配/);
});

test('G2 fencing：stale 抢回后旧 owner 的迟到记账不生效（token 失配，行仍属新 owner）', async () => {
  const pool = new FakeIdempotencyPool();
  // 崩溃残留：6 分钟前的 in_progress 占位，持有者 token = old-token
  pool.seed({
    userId: 'u1', endpoint: ctx().endpoint, key: 'k-1', requestHash: ctx().requestHash,
    state: 'in_progress', createdAt: new Date(Date.now() - (STALE_MS + 60_000)), claimToken: 'old-token',
  });
  let takenToken = null;
  let lateRowCount = null;
  const res = await executeWithIdempotency(pool, ctx(), async (record) => {
    takenToken = pool.rows[0].claim_token;
    // 旧 owner（崩溃后苏醒）此刻迟到补记：state='in_progress' 成立、仅 claim_token 失配 → 必须 0 行
    const late = await pool.query(
      `UPDATE idempotency_keys
          SET state = 'done', status_code = $4, response = $5
        WHERE user_id = $1 AND endpoint = $2 AND key = $3
          AND state = 'in_progress' AND claim_token = $6`,
      ['u1', ctx().endpoint, 'k-1', 202, JSON.stringify({ message: { id: 'stale-ghost' } }), 'old-token'],
    );
    lateRowCount = late.rowCount;
    assert.equal(pool.rows[0].state, 'in_progress', '迟到记账后行仍为 in_progress（未被旧 owner 写死）');
    const { payload } = await businessTx(pool, record);
    return { statusCode: 202, response: payload };
  });
  assert.notEqual(takenToken, 'old-token', '抢回后 token 已改写为本次请求');
  assert.equal(lateRowCount, 0, '旧 owner 迟到记账 0 行（state 匹配、claim_token 失配 → fencing 生效）');
  assert.equal(res.replayed, false);
  assert.equal(pool.rows[0].state, 'done');
  assert.deepEqual(pool.rows[0].response, { message: { id: 'm-new' }, run: { id: 'r-new' } },
    '台账是新 owner 的结果（迟到写入未覆写）');
});

test('G2 record：未传业务事务 client → TypeError（编程错误，不落台账）', async () => {
  const pool = new FakeIdempotencyPool();
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx(), async (record) => {
      await record(undefined, 202, {});
      return ok()();
    }),
    (e) => e instanceof TypeError,
  );
  assert.equal(pool.rows.length, 0, 'fn 抛错 → 释放本 owner 的占位行');
});

test('G2 release 的 DB 错误不再静默吞：告警后照旧 rethrow 原错误（M-5）', async () => {
  const pool = new FakeIdempotencyPool();
  const origQuery = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (sql.replace(/\s+/g, ' ').trim().startsWith('DELETE FROM idempotency_keys')) {
      throw new Error('connection terminated');
    }
    return origQuery(sql, params);
  };
  const warns = [];
  const boom = new Error('postMessage failed');
  await assert.rejects(
    () => executeWithIdempotency(pool, ctx({ log: { warn: (m) => warns.push(m) } }), async () => { throw boom; }),
    (e) => e === boom, // 原错误原样 rethrow（不被 release 的 DB 错误替换）
  );
  assert.equal(warns.length, 1, '释放失败必须告警');
  assert.match(warns[0], /占位释放失败/);
  assert.equal(pool.rows[0].state, 'in_progress', '释放失败 → 占位残留，等 stale 窗口被后续请求抢回');
});
