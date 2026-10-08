// issue #189：GET /api/sessions/:id/folded/:round —— 折叠原文只读端点测试：
//   属主命中 200（turns 来自上游投影、非空）；非属主/不存在 404 not_found（不泄露存在性）；
//   payload 缺失/为空 404 folded_payload_not_found；未登录 401。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB（harness 同 session-events-history.test.js）。
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
const OTHER_USER = {
  id: '00000000-0000-4000-8000-0000000000b2', login: 'bob', display_name: 'bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-4444-4444-8444-abcdefabcdef';
const OTHER_SESSION_ID = 'a1b2c3d4-5555-4555-8555-abcdefabcdef';
const TOKEN = 'tok-folded-payload-test';

const sessionRow = (id, userId) => ({
  id, user_id: userId, project_id: null, cwd: '~/projects/p1', title: 't', title_source: 'manual',
  model: null, status: 'active', last_seq: 3,
});

/** chat_sessions（fetchSession 列面）+ transcript_rounds.folded_payload 内存表。 */
class FoldedPayloadPool extends FakePool {
  constructor() {
    super({ users: [USER, OTHER_USER] });
    this.sessions.push({
      id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.chatSessions = [sessionRow(SESSION_ID, USER.id), sessionRow(OTHER_SESSION_ID, OTHER_USER.id)];
    this.transcriptRows = []; // [{ transcript_key, round, folded_payload }]
  }

  seedFold(transcriptKey, round, foldedPayload) {
    this.transcriptRows.push({ transcript_key: transcriptKey, round, folded_payload: foldedPayload });
  }

  async query(sql, params = []) {
    if (sql.includes('FROM chat_sessions s')) {
      const s = this.chatSessions.find((x) => x.id === params[0]);
      return { rows: s ? [s] : [] };
    }
    if (sql.includes('FROM transcript_rounds')) {
      const [key, round] = params;
      const rows = this.transcriptRows
        .filter((x) => x.transcript_key === key && x.round === round && x.folded_payload != null)
        .slice(0, 1);
      return { rows };
    }
    return super.query(sql, params);
  }
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-folded-'));
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
  const pool = new FoldedPayloadPool();
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

const RAW = [
  { role: 'user', content: [{ type: 'text', text: 'RAW FOLDED QUESTION' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'RAW FOLDED ANSWER' }] },
];

test('属主命中 → 200：turns 非空且来自上游投影（原文正文可检索，round 回显）', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 9, RAW);
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/9`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.round, 9);
    assert.ok(Array.isArray(body.turns) && body.turns.length >= 2, 'turns 非空（同一上游投影 projectTranscriptForDisplay）');
    const all = JSON.stringify(body.turns);
    assert.match(all, /RAW FOLDED QUESTION/);
    assert.match(all, /RAW FOLDED ANSWER/);
  } finally { await s.close(); }
});

test('非属主 → 404 not_found（不泄露存在性）；未登录 → 401', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(OTHER_SESSION_ID, 1, RAW);
    const res = await fetch(`${s.base}/api/sessions/${OTHER_SESSION_ID}/folded/1`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 404);
    const err = await res.json();
    assert.equal(err.error.code, 'not_found');

    const anon = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/1`);
    assert.equal(anon.status, 401);
  } finally { await s.close(); }
});

test('payload 缺失（无行 / 列为 NULL）→ 404 folded_payload_not_found', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 5, null); // 有行但列为 NULL → 被 IS NOT NULL 过滤
    const miss = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/5`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.code, 'folded_payload_not_found');

    const noRow = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/77`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(noRow.status, 404);
    assert.equal((await noRow.json()).error.code, 'folded_payload_not_found');
  } finally { await s.close(); }
});
