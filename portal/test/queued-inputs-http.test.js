// issue #370：输入队列两个端点的 HTTP 层测试（createServer + 注入 pool，不碰真 DB）。
//
// 单元层（`queued-inputs.test.js`）钉的是判定表；这里钉的是 **HTTP 面**：
//   * 状态码与响应形状——尤其**直发那一路必须与 §4.3 同形**（前端复用同一段渲染，形状漂了就是
//     「消息发出去了但界面上没出现」）；
//   * `kind` 校验前置到幂等占位之前（否则首次非法体占了占位行，同 key 的合法重试会撞
//     `idempotency_key_reuse`——同一个坑 #261014 在 `/messages` 上踩过，F3 口径）；
//   * `queue_full` 409 的 code/httpStatus/details 完整到客户端；
//   * GET 会话详情带 `queued_messages`（additive，旧客户端不受影响）。
//
// pool 直接继承 `message-precheck.test.js` 那套（登录会话 + 幂等台账 + postMessage 事务 +
// transcript 仿真件），只补 `queued_inputs` 的内存表与活跃 run 开关——不复用它的事务形状，
// 就会在这里重新发明一遍「假池未覆盖的 SQL」那种脆测试。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { fakeTranscriptRounds } from './fake-transcript-rounds.js';
import { MAX_QUEUED_INPUTS_PER_SESSION } from '../src/queued-inputs.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-queue-test';

class QueuePool extends FakePool {
  constructor({ activeRun = null, llmUpstreamOk = true } = {}) {
    super({ users: [USER] });
    this.activeRun = activeRun;          // null ⇒ 无活跃 run（入队端点应降级为直发）
    this.llmUpstreamOk = llmUpstreamOk;
    this.queued = [];                    // queued_inputs 内存表
    this.cancelFlagged = [];             // 被打了 cancel_requested_at 的 run id
    this.idem = new Map();
    this.notifiedQueue = [];
    let pos = 0;
    this.nextPos = () => pos++;
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000),
      last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
  }

  async query(sql, params = []) {
    // ---- 幂等台账（照 message-precheck 的内存实现）----
    if (sql.includes('INSERT INTO idempotency_keys')) {
      const [userId, endpoint, key, hash, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      if (this.idem.has(k)) return { rows: [] };
      this.idem.set(k, { state: 'in_progress', request_hash: hash, claim_token: claimToken, status_code: null, response: null, created_at: new Date() });
      return { rows: [{ claimed: 1 }] };
    }
    if (sql.includes('FROM idempotency_keys') && sql.includes("state = 'done'")) {
      const row = this.idem.get(`${params[0]}|${params[1]}|${params[2]}`);
      return { rows: row && row.state === 'done' ? [row] : [] };
    }
    if (sql.includes('FROM idempotency_keys') && !sql.includes('DELETE FROM')) {
      const row = this.idem.get(`${params[0]}|${params[1]}|${params[2]}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes("UPDATE idempotency_keys") && sql.includes("SET state = 'done'")) {
      const [userId, endpoint, key, statusCode, response, claimToken] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      if (!row || row.state !== 'in_progress' || row.claim_token !== claimToken) return { rows: [], rowCount: 0 };
      Object.assign(row, { state: 'done', status_code: statusCode, response: JSON.parse(response) });
      return { rows: [{ state: 'done' }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM idempotency_keys') && params.length === 4) {
      const [userId, endpoint, key, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      const row = this.idem.get(k);
      if (row && row.state === 'in_progress' && row.claim_token === claimToken) this.idem.delete(k);
      return { rows: [] };
    }
    // ---- #370 队列 ----
    if (/COUNT\(\*\)::int/.test(sql) && sql.includes('queued_inputs')) {
      return { rows: [{ n: this.queued.filter((q) => q.status === 'pending' || q.status === 'delivering').length }] };
    }
    if (sql.includes('INSERT INTO queued_inputs')) {
      const [session_id, user_id, kind, content, attachments, interrupted_run_id] = params;
      const row = {
        id: `q${this.queued.length}`, session_id, user_id, kind, content,
        attachments: JSON.parse(attachments ?? '[]'), interrupted_run_id,
        position: this.nextPos(), status: 'pending', created_at: new Date('2026-10-25T00:00:00Z'),
      };
      this.queued.push(row);
      return { rows: [row] };
    }
    if (/UPDATE runs SET cancel_requested_at/.test(sql)) {
      this.cancelFlagged.push(params[0]);
      return { rows: [] };
    }
    if (sql.includes("UPDATE queued_inputs SET status = 'recalled'")) {
      const rows = this.queued.filter((q) => q.session_id === params[0] && q.status === 'pending');
      for (const q of rows) q.status = 'recalled';
      return { rows: rows.map((q) => ({ id: q.id, kind: q.kind, content: q.content })) };
    }
    if (/SELECT id, kind, content FROM queued_inputs/.test(sql)) {
      const rows = this.queued
        .filter((q) => q.session_id === params[0] && (q.status === 'pending' || q.status === 'delivering'))
        .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === 'steer' ? -1 : 1));
      return { rows: rows.map((q) => ({ id: q.id, kind: q.kind, content: q.content })) };
    }
    // ---- 会话 / 活跃 run / 容器 / LLM 绑定 ----
    if (sql.includes('FROM fde_llm_bindings')) return { rows: this.llmUpstreamOk ? [{ ok: 1 }] : [] };
    if (sql.includes('FROM chat_sessions s')) {
      // 会话详情那条带 message_count 子查询；这里给个常量即可
      return { rows: [{ ...this.sessionRow, message_count: 3 }] };
    }
    if (/FROM runs r/.test(sql) && /status IN \('queued', 'running', 'cancelling'\)/.test(sql)) {
      return { rows: this.activeRun ? [{ ...this.activeRun }] : [] };
    }
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
    if (sql.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 6 }] };
    if (sql.includes('INSERT INTO messages')) {
      return { rows: [{ id: 'm1', seq: 6, content: params[2], created_at: new Date('2026-10-25T00:00:00Z') }] };
    }
    const rounds = (this.rounds ??= fakeTranscriptRounds({ rows: this.transcript ?? [] }));
    const hit = rounds.query(sql, params);
    if (hit) return hit;
    if (sql.includes('INSERT INTO runs')) return { rows: [{ id: params[0], status: 'queued' }] };
    return super.query(sql, params);
  }

  async connect() {
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params), release() {} };
  }
}

function config() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-queue-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  return {
    staticDir,
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 900_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 900_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
  };
}

async function startServer(opts = {}) {
  const conf = config();
  const pool = new QueuePool(opts);
  const server = createServer({ pool, config: conf });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    pool, base, conf,
    cookie: `${conf.cookie.name}=${TOKEN}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(conf.staticDir, { recursive: true, force: true });
    },
  };
}

const queuedUrl = (s) => `${s.base}/api/sessions/${SESSION_ID}/queued-inputs`;
function post(s, body, headers = {}) {
  return fetch(queuedUrl(s), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookie, ...headers },
    body: JSON.stringify(body),
  });
}

test('#370 HTTP：有活跃 run ⇒ 202 {posted:null, queued:{...}}，且 steer 打停止意图但 run 仍 running', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const r = await post(s, { content: '慢一点', attachments: [], kind: 'steer' });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.posted, null);
    assert.equal(body.queued.kind, 'steer');
    assert.equal(body.queued.content, '慢一点');
    assert.equal(typeof body.queued.position, 'number');
    assert.deepEqual(s.pool.cancelFlagged, ['r1'], 'steer 要写停止意图（cancel_requested_at）');
    assert.equal(s.pool.activeRun.status, 'running', '⚠ 绝不进 cancelling——那是立刻 SIGKILL 正在跑的工具');
    assert.equal(s.pool.queued.length, 1);
    assert.equal(s.pool.queued[0].interrupted_run_id, 'r1', '「这次 abort 是转向」的判据必须经端点落库');
  } finally { await s.close(); }
});

test('#370 HTTP：直发那一路的响应体与 §4.3 同形（posted.message + posted.run.status=queued）', async () => {
  const s = await startServer({ activeRun: null });
  try {
    const r = await post(s, { content: '空档里发的', kind: 'follow_up' });
    assert.equal(r.status, 202);
    const body = await r.json();
    assert.equal(body.queued, null);
    assert.equal(body.posted.message.role, 'user');
    assert.equal(body.posted.run.status, 'queued', '形状必须与 POST /messages 一致，否则前端气泡不出现');
    assert.equal(s.pool.queued.length, 0, '直发不落队列行');
  } finally { await s.close(); }
});

test('#370 HTTP：kind 非法 400，且**不占幂等占位行**（F3 口径，同 /messages）', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const r = await post(s, { content: 'x', kind: 'queue' }, { 'Idempotency-Key': 'k-1' });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'validation_failed');
    assert.equal(s.pool.idem.size, 0, '占位行被非法体占掉 ⇒ 同 key 的合法重试会撞 idempotency_key_reuse，这是 #261014 踩过的坑');

    const ok = await post(s, { content: 'x', kind: 'steer' }, { 'Idempotency-Key': 'k-1' });
    assert.equal(ok.status, 202, '非法体之后同 key 的合法重试必须能成功');
  } finally { await s.close(); }
});

test('#370 HTTP：缺 kind 按 steer 处理（前端默认动作，旧客户端不传也要能用）', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const r = await post(s, { content: '没说 kind' });
    assert.equal(r.status, 202);
    assert.equal((await r.json()).queued.kind, 'steer');
  } finally { await s.close(); }
});

test('#370 HTTP：同 Idempotency-Key 重发 ⇒ 回放首次响应且形状完全一致、不落第二行', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const body = { content: '慢一点', attachments: [], kind: 'steer' };
    const first = await (await post(s, body, { 'Idempotency-Key': 'k-9' })).json();
    const again = await post(s, body, { 'Idempotency-Key': 'k-9' });
    assert.equal(again.status, 202, '回放要给出首次的 status_code，不是 201/200');
    assert.deepEqual(await again.json(), first, '台账里存的响应体经同一个映射函数 ⇒ 回放形状必须逐字相同');
    assert.equal(s.pool.queued.length, 1, '同 key 不得落第二行');
    assert.equal(s.pool.cancelFlagged.length, 1, '同 key 不得重复打停止意图');
  } finally { await s.close(); }
});

test('#370 HTTP：直发那一路的同 key 重发同样回放 `{posted, queued:null}`（不是 postMessage 的裸形状）', async () => {
  const s = await startServer({ activeRun: null });
  try {
    const body = { content: '空档里发的', kind: 'follow_up' };
    const first = await (await post(s, body, { 'Idempotency-Key': 'k-10' })).json();
    assert.deepEqual(Object.keys(first).sort(), ['posted', 'queued']);
    const again = await (await post(s, body, { 'Idempotency-Key': 'k-10' })).json();
    assert.deepEqual(again, first,
      '这一条钉的是本次修掉的 bug：record 转交 postMessage 时若不做形状映射，台账里会存成 {message,run} ⇒ 回放形状与首次不同');
  } finally { await s.close(); }
});

test('#370 HTTP：队列满 ⇒ 409 queue_full（code 与 details.limit 都要到客户端）', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    for (let i = 0; i < MAX_QUEUED_INPUTS_PER_SESSION; i++) {
      s.pool.queued.push({ id: `p${i}`, session_id: SESSION_ID, kind: 'follow_up', content: `第${i}条`, attachments: [], position: i, status: 'pending' });
    }
    const r = await post(s, { content: '挤不进', kind: 'follow_up' });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'queue_full');
    assert.equal(body.error.details.limit, MAX_QUEUED_INPUTS_PER_SESSION);
    assert.equal(s.pool.queued.length, MAX_QUEUED_INPUTS_PER_SESSION);
  } finally { await s.close(); }
});

test('#370 HTTP：DELETE 整队取回 ⇒ {recalled:{steering,follow_up}} 裸文本且 steering 在前', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const a = await post(s, { content: '后排', kind: 'follow_up' });
    const b = await post(s, { content: '前排', kind: 'steer' });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    const r = await fetch(queuedUrl(s), { method: 'DELETE', headers: { Cookie: s.cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.recalled, { steering: ['前排'], follow_up: ['后排'] });
    assert.ok(s.pool.queued.every((q) => q.status === 'recalled'), '取回不硬删，留行可查');
  } finally { await s.close(); }
});

test('#370 HTTP：GET 会话详情带 queued_messages（刷新/多端补齐的唯一来源）', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    await post(s, { content: '排一条', kind: 'follow_up' });
    const r = await fetch(`${s.base}/api/sessions/${SESSION_ID}`, { headers: { Cookie: s.cookie } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.deepEqual(body.session.queued_messages, { steering: [], follow_up: [{ id: 'q0', content: '排一条' }] });
  } finally { await s.close(); }
});

test('#370 HTTP：未登录 401；跨用户会话 404（不泄露存在性）', async () => {
  const s = await startServer({ activeRun: { id: 'r1', status: 'running' } });
  try {
    const anon = await fetch(queuedUrl(s), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x', kind: 'steer' }),
    });
    assert.equal(anon.status, 401);

    s.pool.sessionRow.user_id = 'another-user';
    const other = await post(s, { content: 'x', kind: 'steer' });
    assert.equal(other.status, 404);
    assert.equal((await other.json()).error.code, 'not_found');
  } finally { await s.close(); }
});
