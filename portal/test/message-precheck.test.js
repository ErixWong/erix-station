// HTTP 层测试（issue #41）：POST /api/sessions/:id/messages 建 run 前的 LLM 未绑定预检。
//   无 active 的 fde_llm_bindings（state='active' + gateway='litellm' + 虚拟 key + model）
//   → 409 llm_not_configured（fail-fast：不进幂等台账、不开业务事务、不入队 run）。
//   已配置 → 预检放行，正常走 postMessage 事务（202）。
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
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-llm-precheck-test';

/**
 * 内存 pool：登录会话 + LLM 预检开关 + postMessage 业务事务 + 幂等台账所需的全部 SQL。
 * llmUpstreamOk=false 模拟「无 active binding / api_key 空 / provider 停用」的 JOIN 空结果。
 */
class MessagePool extends FakePool {
  constructor({ llmUpstreamOk = false } = {}) {
    super({ users: [USER] });
    this.llmUpstreamOk = llmUpstreamOk;
    this.connected = 0; // 业务事务 connect 次数（预检 409 路径必须保持 0；回放路径不得增长）
    this.notified = [];
    this.idem = new Map(); // 幂等台账：`${userId}|${endpoint}|${key}` → 行（内存模拟 idempotency_keys）
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SESSION_ID, user_id: USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
  }

  async query(sql, params = []) {
    // ---- 幂等台账（内存模拟 idempotency_keys；行一旦写入恒新鲜，过期路径不在本测试范围） ----
    if (sql.includes('INSERT INTO idempotency_keys')) {
      const [userId, endpoint, key, hash, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      if (this.idem.has(k)) return { rows: [] }; // 已存在（in_progress 未超时 / done 未过期）→ 占位失败
      this.idem.set(k, { state: 'in_progress', request_hash: hash, claim_token: claimToken, status_code: null, response: null, created_at: new Date() });
      return { rows: [{ claimed: 1 }] };
    }
    if (sql.includes('FROM idempotency_keys') && sql.includes("state = 'done'")) {
      const [userId, endpoint, key] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      return { rows: row && row.state === 'done' ? [row] : [] };
    }
    if (sql.includes('FROM idempotency_keys') && !sql.includes('DELETE FROM')) { // findRow（claim 失败后的归属判定）
      const [userId, endpoint, key] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      return { rows: row ? [row] : [] };
    }
    if (sql.includes('UPDATE idempotency_keys') && sql.includes("SET state = 'done'")) { // writeDone（record）
      const [userId, endpoint, key, statusCode, response, claimToken] = params;
      const row = this.idem.get(`${userId}|${endpoint}|${key}`);
      if (!row || row.state !== 'in_progress' || row.claim_token !== claimToken) return { rows: [], rowCount: 0 };
      row.state = 'done';
      row.status_code = statusCode;
      row.response = JSON.parse(response);
      return { rows: [{ state: 'done' }], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM idempotency_keys') && params.length === 4) { // release（fn 抛错路径）
      const [userId, endpoint, key, claimToken] = params;
      const k = `${userId}|${endpoint}|${key}`;
      const row = this.idem.get(k);
      if (row && row.state === 'in_progress' && row.claim_token === claimToken) this.idem.delete(k);
      return { rows: [] };
    }
    // issue #117 precheck: active LiteLLM binding with virtual key and selected main model.
    if (sql.includes('FROM fde_llm_bindings')) {
      return { rows: this.llmUpstreamOk ? [{ ok: 1 }] : [] };
    }
    if (sql.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (sql.includes('FROM runs')) return { rows: [] }; // 无活跃 run
    if (sql.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
    if (sql.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 6 }] };
    if (sql.includes('INSERT INTO messages')) {
      return { rows: [{ id: 'm1', seq: 6, content: params[2], created_at: new Date('2026-09-22T00:00:00Z') }] };
    }
    if (sql.includes('INSERT INTO runs')) return { rows: [{ id: params[0], status: 'queued' }] };
    return super.query(sql, params);
  }

  async connect() {
    this.connected += 1;
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params), release() {} };
  }
}

async function startServer({ llmUpstreamOk = false } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-llm-'));
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
  const pool = new MessagePool({ llmUpstreamOk });
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

function postMessage(s, body) {
  return fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookieHeader },
    body: JSON.stringify(body),
  });
}

test('issue #41：FDE 未配置 LLM 上游（JOIN 空）→ 409 llm_not_configured，且不开业务事务', async () => {
  const s = await startServer({ llmUpstreamOk: false });
  try {
    const r = await postMessage(s, { content: 'hi', attachments: [] });
    assert.equal(r.status, 409);
    const body = await r.json();
    assert.equal(body.error.code, 'llm_not_configured');
    assert.match(body.error.message, /未配置 LLM 上游/);
    assert.match(body.error.message, /管理台/);
    assert.equal(s.pool.connected, 0, '预检 fail-fast：postMessage 业务事务不得开启');
  } finally {
    await s.close();
  }
});

test('issue #41：已配置（active LiteLLM binding + 虚拟 key + main model）→ 预检放行 → 202', async () => {
  const s = await startServer({ llmUpstreamOk: true });
  try {
    const r = await postMessage(s, { content: 'hi', attachments: [] });
    assert.equal(r.status, 202, '应通过预检并入队 run');
    const body = await r.json();
    assert.equal(body.message.role, 'user');
    assert.equal(body.run.status, 'queued');
    assert.equal(s.pool.connected, 1, '业务事务恰好开启一次');
  } finally {
    await s.close();
  }
});

test('issue #41：体校验 400 优先于 LLM 预检（未配置也先报 validation_failed，行为与预检引入前一致）', async () => {
  const s = await startServer({ llmUpstreamOk: false });
  try {
    const r = await postMessage(s, { content: '' });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.equal(s.pool.connected, 0);
  } finally {
    await s.close();
  }
});

test('issue #41：未登录 → 401（预检不绕开鉴权）', async () => {
  const s = await startServer({ llmUpstreamOk: false });
  try {
    const r = await fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    assert.equal(r.status, 401);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// 评审 MEDIUM-1 回归：幂等语义优先于 LLM 预检（预检在 executeWithIdempotency 的 fn 内）
// ---------------------------------------------------------------------------

function postMessageKeyed(s, key, body) {
  return fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookieHeader, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

test('评审 MEDIUM-1：预检 409（带幂等 key）→ 修好绑定 → 同 key 重试成功建 run（失败不留占位）', async () => {
  const s = await startServer({ llmUpstreamOk: false });
  try {
    const key = 'k-retry-after-llm-fix';
    const r1 = await postMessageKeyed(s, key, { content: 'hi', attachments: [] });
    assert.equal(r1.status, 409);
    assert.equal((await r1.json()).error.code, 'llm_not_configured');
    assert.equal(s.pool.idem.size, 0, 'fn 抛错路径必须 release 占位行（失败不占位）');

    s.pool.llmUpstreamOk = true; // 管理员在管理台配好 LLM 上游
    const r2 = await postMessageKeyed(s, key, { content: 'hi', attachments: [] });
    assert.equal(r2.status, 202, '同 key 原样重试应成功（占位已释放，可重新 claim）');
    const body2 = await r2.json();
    assert.equal(body2.message.role, 'user');
    assert.equal(body2.run.status, 'queued');
  } finally {
    await s.close();
  }
});

test('评审 MEDIUM-1：已完成请求的同 key 重试 → 回放首次结果（202 同 message/run，预检不再截断）', async () => {
  const s = await startServer({ llmUpstreamOk: true });
  try {
    const key = 'k-replay-after-done';
    const r1 = await postMessageKeyed(s, key, { content: 'hi', attachments: [] });
    assert.equal(r1.status, 202);
    const first = await r1.json();
    const connectedAfterFirst = s.pool.connected;

    s.pool.llmUpstreamOk = false; // 成功后上游被撤（不该影响回放）
    const r2 = await postMessageKeyed(s, key, { content: 'hi', attachments: [] });
    assert.equal(r2.status, 202, '回放优先：findDone 在 fn（含预检）之前返回首次结果');
    const second = await r2.json();
    assert.deepEqual(second, first, '回放体与首次结果逐字一致（同 message.id / run.id）');
    assert.equal(s.pool.connected, connectedAfterFirst, '回放路径不执行业务事务');
  } finally {
    await s.close();
  }
});
