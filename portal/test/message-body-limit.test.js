// issue #677：消息端点请求体上限的两层口径（业务闸 vs 传输闸）——真实 HTTP 边界用例。
//
// 全部走真实 `createServer` + `fetch`（不测纯函数）：证明「传输层不再挡在业务闸前面」这件事
// 真的在 HTTP 面上成立——这是 64 KiB 传输闸时代永远验不出来的一组形状。
//
//   ① 中文正文 100,000 字符（≈300 KB UTF-8）⇒ 202：业务上限内，传输层不误伤。
//   ② 中文正文 100,001 字符 ⇒ 400 validation_failed + details.field='content'
//      （业务闸**可达了**，不再被 64 KiB 传输闸提前 413 掉）。
//   ③ 正文 > MESSAGE_BODY_LIMIT（1 MiB）⇒ 413 payload_too_large + details.max_bytes = MESSAGE_BODY_LIMIT。
//   ④ 控制面端点（POST /api/auth/login）发 > 64 KiB body ⇒ 仍 413 + details.max_bytes = 65536
//      （全站默认没被放大，DEFAULT_JSON_BODY_LIMIT 仍是 64 KiB）。
//   ⑤ 用例 ③ 的 413 **不占幂等占位**：同 Idempotency-Key 随后发合法体 ⇒ 不是 409 idempotency_key_reuse。
//
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
import { fakeTranscriptRounds } from './fake-transcript-rounds.js';
import { MAX_MESSAGE_CONTENT_LENGTH } from '../src/sessions.js';

// `MESSAGE_BODY_LIMIT` 是 http.js 的模块内常量（未导出）。这里按契约值声明，作为断言基准：
// 值必须 > `MAX_MESSAGE_CONTENT_LENGTH × 3`（中文 UTF-8 最坏 ≈300 KB）且 ≤ `MAX_ROUND_BYTES`（1 MiB）。
const MESSAGE_BODY_LIMIT = 1024 * 1024;
// 全站默认 JSON 请求体上限（DEFAULT_JSON_BODY_LIMIT）。
const DEFAULT_JSON_BODY_LIMIT = 64 * 1024;

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-msg-body-limit';

/**
 * 内存 pool：登录会话 + 幂等台账 + POST /messages 直发事务（activeRun=null ⇒ 无活跃 run，走直发）
 * + transcript 仿真件。SQL 分支形状与 `queued-inputs-http.test.js` 同源（同一套 postMessage 路径）。
 */
class MessageLimitPool extends FakePool {
  constructor() {
    super({ users: [USER] });
    this.idem = new Map();
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
    // ---- 幂等台账 ----
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
    if (sql.includes('UPDATE idempotency_keys') && sql.includes("SET state = 'done'")) {
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
    // ---- 会话 / 活跃 run / 容器 / LLM 绑定 ----
    if (sql.includes('FROM fde_llm_bindings')) return { rows: [{ ok: 1 }] };
    if (sql.includes('FROM chat_sessions s')) return { rows: [{ ...this.sessionRow, message_count: 3 }] };
    if (/FROM runs r/.test(sql) && /status IN \('queued', 'running', 'cancelling'\)/.test(sql)) return { rows: [] };
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
    if (sql.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 6 }] };
    if (sql.includes('INSERT INTO messages')) {
      return { rows: [{ id: 'm1', seq: 6, content: params[2], created_at: new Date('2026-10-25T00:00:00Z') }] };
    }
    const rounds = (this.rounds ??= fakeTranscriptRounds({ rows: [] }));
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
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-msglimit-'));
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
    maxLoginLength: 128, maxPasswordLength: 256,
  };
}

async function startServer() {
  const conf = config();
  const pool = new MessageLimitPool();
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

const messagesUrl = (s) => `${s.base}/api/sessions/${SESSION_ID}/messages`;
function postMessage(s, content, headers = {}) {
  return fetch(messagesUrl(s), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: s.cookie, ...headers },
    body: JSON.stringify({ content, attachments: [] }),
  });
}

// ---------------------------------------------------------------------------
// ① 业务上限内的中文正文（≈300 KB）⇒ 202：传输层不误伤。
// ---------------------------------------------------------------------------
test('#677 中文正文 100,000 字符（≈300 KB UTF-8，> 64 KiB 传输闸）⇒ 202：业务上限内，传输层不误伤', async () => {
  const content = '中'.repeat(MAX_MESSAGE_CONTENT_LENGTH); // 100,000 字符，UTF-8 每字符 3 字节 ≈ 300 KB
  assert.equal(content.length, 100_000);
  assert.ok(Buffer.byteLength(content, 'utf8') > DEFAULT_JSON_BODY_LIMIT,
    '前提自证：这条正文已超过旧 64 KiB 传输闸（否则这条用例证明不了任何事）');
  const s = await startServer();
  try {
    const r = await postMessage(s, content);
    const body = await r.json();
    assert.equal(r.status, 202, `业务上限内的合法正文不该被传输层 413（实得 ${r.status}：${JSON.stringify(body).slice(0, 200)}）`);
    assert.equal(body.message.role, 'user', '直发成功必须回显 user 消息（证明它真的跑完了业务路径，不是空 202）');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// ② 业务上限 + 1 字符 ⇒ 400 validation_failed（业务闸可达，不再 413）。
// ---------------------------------------------------------------------------
test('#677 中文正文 100,001 字符 ⇒ 400 validation_failed + details.field=content（业务闸可达，非 413）', async () => {
  const content = '中'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1);
  assert.equal(content.length, 100_001);
  // 前提自证：这条正文仍 < 1 MiB 传输上限，故它一定走到业务校验，而不是被传输层先 413。
  assert.ok(Buffer.byteLength(JSON.stringify({ content, attachments: [] }), 'utf8') < MESSAGE_BODY_LIMIT);
  const s = await startServer();
  try {
    const r = await postMessage(s, content);
    const body = await r.json();
    assert.notEqual(r.status, 413, '业务闸超长的正文不许先被传输层 413 掉');
    assert.equal(r.status, 400);
    assert.equal(body.error.code, 'validation_failed');
    assert.equal(body.error.details.field, 'content', '错误必须点名 content，用户才看得懂是正文过长');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// ③ 正文 > MESSAGE_BODY_LIMIT ⇒ 413 payload_too_large + details.max_bytes = MESSAGE_BODY_LIMIT。
// ---------------------------------------------------------------------------
test('#677 正文 > MESSAGE_BODY_LIMIT（1 MiB）⇒ 413 payload_too_large + details.max_bytes=MESSAGE_BODY_LIMIT', async () => {
  // 序列化后刚好超过 1 MiB 的正文（多给 100 字节余量，确保稳超上限）。
  const content = 'x'.repeat(MESSAGE_BODY_LIMIT + 100);
  const s = await startServer();
  try {
    const r = await postMessage(s, content);
    const body = await r.json();
    assert.equal(r.status, 413);
    assert.equal(body.error.code, 'payload_too_large');
    assert.equal(body.error.details.max_bytes, MESSAGE_BODY_LIMIT,
      '消息端点的传输上限必须是 1 MiB（MESSAGE_BODY_LIMIT）');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// ④ 控制面端点仍受 64 KiB 默认闸约束（证明全站默认没被放大）。
// ---------------------------------------------------------------------------
test('#677 控制面 POST /api/auth/login 发 > 65536 字节 body ⇒ 仍 413 + details.max_bytes=65536（默认未放大）', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: 'alice', password: 'x'.repeat(70 * 1024) }), // ≈71 KB > 64 KiB
    });
    const body = await r.json();
    assert.equal(r.status, 413);
    assert.equal(body.error.code, 'payload_too_large');
    assert.equal(body.error.details.max_bytes, DEFAULT_JSON_BODY_LIMIT,
      '全站默认上限必须仍是 64 KiB（不许被消息端点的放宽带偏）');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// ⑤ 413 不占幂等占位：同 Idempotency-Key 随后发合法体 ⇒ 不是 409 idempotency_key_reuse。
// ---------------------------------------------------------------------------
test('#677 超限 413 不占幂等占位：同 Idempotency-Key 随后发合法体 ⇒ 非 409（F3 口径）', async () => {
  const s = await startServer();
  const key = 'k-body-limit';
  try {
    const big = await postMessage(s, 'x'.repeat(MESSAGE_BODY_LIMIT + 100), { 'Idempotency-Key': key });
    assert.equal(big.status, 413, '前置：超限请求先 413');
    // 同 key 的合法重试：若 413 曾占幂等位，这里会撞 409 idempotency_key_reuse。
    const ok = await postMessage(s, '正常正文', { 'Idempotency-Key': key });
    const okBody = await ok.json();
    assert.notEqual(ok.status, 409, `合法重试不许因 413 曾占位而 409（实得 ${ok.status}：${JSON.stringify(okBody).slice(0, 200)}）`);
    assert.notEqual(okBody.error?.code, 'idempotency_key_reuse');
    assert.equal(ok.status, 202, '合法重试必须正常 202');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// 防回潮哨兵（源码级）：`maxBodyBytes` 字段已从 config.js 删，http.js 再读它就是读 undefined
// 然后靠 readJsonBody 的默认参数碰巧落到 64 KiB（假绿：没有任何测试能抓“传 undefined 落默认”）。
// ---------------------------------------------------------------------------
test('#677 防回潮哨兵：http.js 不许再引用已删的 config.maxBodyBytes，且 readJsonBody 第二实参只认白名单', () => {
  const src = fs.readFileSync(new URL('../src/http.js', import.meta.url), 'utf8');

  // ① 死引用：字段已从 config.js 删，任何 `config.maxBodyBytes` 都是假绿。
  const deadHits = src.match(/config\.maxBodyBytes/g) || [];
  assert.equal(deadHits.length, 0,
    `http.js 里不许再出现 config.maxBodyBytes（该字段已删，读它 = 读 undefined ⇒ 靠默认参数假绿），实得 ${deadHits.length} 处`);

  // ② readJsonBody 的第二实参只允许：无实参 / 白名单常量。函数定义行 `function readJsonBody(req, limit = ...)` 单独放行。
  const ALLOWED = new Set([
    'MESSAGE_BODY_LIMIT', 'TLS_UPLOAD_BODY_LIMIT', 'market.BUNDLE_MAX_BODY_BYTES',
    'INTERNAL_EVENTS_LIMIT', 'INTERNAL_ROUND_LIMIT', 'INTERNAL_RECOVERY_ROW_LIMIT', 'INTERNAL_LARGE_BODY_LIMIT',
  ]);
  const re = /(function\s+)?readJsonBody\(\s*req\s*,\s*([A-Za-z0-9_.]+)/g;
  const tokens = [...src.matchAll(re)].filter((m) => !m[1]).map((m) => m[2]); // 排除定义行
  const bad = [...new Set(tokens.filter((t) => !ALLOWED.has(t)))];
  assert.deepEqual(bad, [],
    `readJsonBody 出现白名单外的第二实参：${JSON.stringify(bad)}（默认走 64 KiB 就写 readJsonBody(req)，别塞已删字段名）`);

  // 自证：上面的白名单检查不是空断言——源码里确有真实调用形态被它放行。
  assert.ok(tokens.includes('MESSAGE_BODY_LIMIT'), '夹具自证：源码里确有 readJsonBody(req, MESSAGE_BODY_LIMIT)');
  assert.ok(tokens.some((t) => t.startsWith('INTERNAL_')), '夹具自证：源码里确有 readJsonBody(req, INTERNAL_*)');
});
