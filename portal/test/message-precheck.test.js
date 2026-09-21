// HTTP 层测试（issue #41）：POST /api/sessions/:id/messages 建 run 前的 LLM 未绑定预检。
//   无 active 的 fde_llm_bindings（state='active' + api_key 非空 + JOIN llm_providers enabled）
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
 * 内存 pool：登录会话 + LLM 预检开关 + postMessage 业务事务所需的全部 SQL。
 * llmUpstreamOk=false 模拟「无 active binding / api_key 空 / provider 停用」的 JOIN 空结果。
 */
class MessagePool extends FakePool {
  constructor({ llmUpstreamOk = false } = {}) {
    super({ users: [USER] });
    this.llmUpstreamOk = llmUpstreamOk;
    this.connected = 0; // 业务事务 connect 次数（预检 409 路径必须保持 0）
    this.notified = [];
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
    // issue #41 预检：JOIN 结果（routes.js llmRows 口径）
    if (sql.includes('FROM fde_llm_bindings') && sql.includes('llm_providers')) {
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

test('issue #41：已配置（active binding + enabled provider + 非空 key）→ 预检放行 → 202', async () => {
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
