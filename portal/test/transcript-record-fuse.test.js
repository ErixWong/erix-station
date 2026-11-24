// issue #261123-20：`transcript_rounds` 唯一写入口（`transcript-store.js#appendRound`）的体积保险丝判据。
//
// 五条判据（工单 M3）：
//   ① record 体积 > MAX_ROUND_BYTES ⇒ `appendRound` 抛 `err.code === 'transcript_record_too_large'`，
//      且 fake client **一次 INSERT 都没收到**（先判后写的硬证据）。
//   ② record 体积 == MAX_ROUND_BYTES 整 ⇒ 正常写入（`>` 判据不许误伤边界）。
//   ③ 不误伤合法路径：10 万汉字正文走真实 HTTP `POST /api/sessions/:id/messages` ⇒ 202
//      （桩形状复刻 `message-body-limit.test.js` 的同款 pool，同一套 postMessage 路径）。
//   ④ 映射存在性哨兵（源码级）：`sessions.js` 里 `transcript_record_too_large` ⇒
//      `SessionError('validation_failed', …, details.max_bytes)` 的处理分支不许被删
//      （端到端触发要放宽业务闸，正常情况下该分支不可达，故用哨兵钉住）。
//   ⑤ 变异在工单流程里手工做（注释掉保险丝两行 ⇒ 判据 ① 必须红 ⇒ 改回），本文件即它的判据载体。
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
import { createSessionTranscriptStore } from '../src/transcript-store.js';
import { MAX_ROUND_BYTES } from '../src/transcript-limits.js';

// ---------------------------------------------------------------------------
// ① / ② 直打唯一写入口：记录体积超限 ⇒ 抛错且零 INSERT；恰好等于上限 ⇒ 正常写入。
// ---------------------------------------------------------------------------

/** 只记账的假事务 client：记录每条 SQL，INSERT 一律成功回一行。 */
class RecordingClient {
  constructor() {
    this.queries = [];
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (sql.includes('INSERT INTO transcript_rounds')) return { rows: [{ id: 1 }] };
    return { rows: [] };
  }

  /** `transcript_rounds` 的 INSERT 条数（先判后写的硬证据应恒为 0）。 */
  insertCount() {
    return this.queries.filter((q) => q.sql.includes('INSERT INTO transcript_rounds')).length;
  }
}

test('#261123-20① 超限记录 ⇒ appendRound 抛 transcript_record_too_large，且 fake client 一次 INSERT 都没收到', async () => {
  const record = {
    dedupKey: 'sess-fuse:input:msg-oversize',
    round: 0,
    kind: 'message',
    messages: [],
    text: 'x'.repeat(MAX_ROUND_BYTES + 1024), // 单 text 字段就把整条记录顶过 1 MiB
  };
  const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
  assert.ok(bytes > MAX_ROUND_BYTES, `前提自证：record 必须 > ${MAX_ROUND_BYTES}（实为 ${bytes}），否则本用例证明不了任何事`);

  const client = new RecordingClient();
  const store = createSessionTranscriptStore(client);
  await assert.rejects(
    () => store.appendRound('sess-fuse', record),
    (err) => {
      assert.equal(err instanceof Error, true, '必须是 Error（与 dedupKey 守卫同形状）');
      assert.equal(err.code, 'transcript_record_too_large', '错误必须可按 code 识别');
      return true;
    },
  );
  assert.equal(client.insertCount(), 0, '先判后写：超限路径一条 INSERT 都不许发到 client');
  assert.equal(client.queries.length, 0, '更强一格：保险丝在任何查询之前，client 一条 SQL 都不该收到');
});

test('#261123-20② record 恰好 == MAX_ROUND_BYTES ⇒ 正常写入（边界不误伤）', async () => {
  const record = { dedupKey: 'sess-fuse:input:msg-exact', round: 0, kind: 'message', messages: [], text: '' };
  // 用 ASCII 填充把 JSON 体积精确顶到上限整：'x' 每字符恰 1 字节，可确定性命中 `bytes === MAX_ROUND_BYTES`。
  const pad = MAX_ROUND_BYTES - Buffer.byteLength(JSON.stringify(record), 'utf8');
  assert.ok(pad > 0, '前提自证：空壳 record 必须留有余量放填充');
  record.text = 'x'.repeat(pad);
  assert.equal(
    Buffer.byteLength(JSON.stringify(record), 'utf8'),
    MAX_ROUND_BYTES,
    '构造必须恰好等于上限（`>` 判据的边界格）',
  );

  const client = new RecordingClient();
  const store = createSessionTranscriptStore(client);
  const res = await store.appendRound('sess-fuse', record);
  assert.deepEqual(res, { inserted: true }, '恰好等于上限必须照写不误');
  assert.equal(client.insertCount(), 1, 'INSERT 必须真发到 client');
});

// ---------------------------------------------------------------------------
// ③ 真实 HTTP：10 万汉字（业务闸最大合法输入）⇒ 202，保险丝不误伤合法路径。
//    桩形状复刻 message-body-limit.test.js（同款 SQL 分支 + transcript 仿真件）。
// ---------------------------------------------------------------------------

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-record-fuse';

class FusePool extends FakePool {
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

function fuseConfig() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-recordfuse-'));
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
  const conf = fuseConfig();
  const pool = new FusePool();
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

test('#261123-20③ 不误伤合法路径：10 万汉字正文 POST /messages ⇒ 202（预写记录 ≈300 KB < 1 MiB 保险丝）', async () => {
  const content = '中'.repeat(MAX_MESSAGE_CONTENT_LENGTH); // 业务闸最大合法输入
  assert.equal(content.length, 100_000);
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/api/sessions/${SESSION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify({ content, attachments: [] }),
    });
    const body = await r.json();
    assert.equal(r.status, 202, `合法消息必须 202（实得 ${r.status}：${JSON.stringify(body).slice(0, 200)}）`);
    assert.equal(body.message.role, 'user', '必须真跑完业务路径（appendRound 已过保险丝并写入），不是空 202');
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// ④ 映射存在性哨兵：sessions.js 的 catch 分支里 `transcript_record_too_large` ⇒ 400 的映射不许被删。
//    端到端触发这条映射要把业务闸 MAX_MESSAGE_CONTENT_LENGTH 放宽到 >349_000 字符（记录 > 1 MiB），
//    而工单红线不许改闸值 ⇒ 正常情况下分支不可达，只能源码级钉住。
// ---------------------------------------------------------------------------

test('#261123-20④ 源码级哨兵：sessions.js 存在 transcript_record_too_large ⇒ validation_failed(400) 的映射分支', () => {
  const src = fs.readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  assert.match(src, /err\?\.code === 'transcript_record_too_large'/,
    'catch 分支必须按 code 识别保险丝拒绝（删了它，超限会升格成 500）');
  const branch = src.slice(src.indexOf("err?.code === 'transcript_record_too_large'"));
  assert.match(branch.slice(0, 600), /new SessionError\('validation_failed'/,
    '映射目标必须是 validation_failed（SessionError 默认 400，不许 500）');
  assert.match(branch.slice(0, 600), /details: \{ field: 'content', max_bytes: MAX_ROUND_BYTES \}/,
    'details 必须点名 field=content 与 max_bytes 真值');
});
