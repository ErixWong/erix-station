// issue #189：GET /api/sessions/:id/folded/:round —— 折叠原文只读端点测试：
//   属主命中 200（turns 来自上游投影、非空）；非属主/不存在 404 not_found（不泄露存在性）；
//   payload 缺失/为空 404 folded_payload_not_found；未登录 401。
// #375（erix-agent 0.25.0 / erix-agent#461 之后）：归档从「每次全量」变成「本轮新增的有界差分」
//   ⇒ 只读归档会残缺甚至为空，旧口径误 404 且文案说「上游未保留」。现口径：有 `foldedRoundRange`
//   就从同会话已有轮行重建（`source:'rebuilt'`），归档退成回退路（`source:'archive'`），404 语义收窄。
// 变异自证（一轮一还原，AGENTS 惯例）：① `range` 强制 null ⇒ 恰「空差分/夹断/取全」三格红（旧四格不受影响）；
//   ② `truncated` 写死 false ⇒ 恰「夹断」一格红；③ 末尾源码级哨兵钉住重建 SQL 的筛除与上限——fake pool
//   是**自己模拟**了 `messages <> '[]'::jsonb` 的，不钉就是假绿面（AGENTS §8.42「fake 必须模拟真库约束」）。
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

  seedFold(transcriptKey, round, foldedPayload, record) {
    this.transcriptRows.push({ transcript_key: transcriptKey, round, folded_payload: foldedPayload, record });
  }

  /** #375：重建路要吃的「各自轮行」——`messages` 有正文的普通轮行。 */
  seedRound(transcriptKey, round, messages) {
    this.transcriptRows.push({ transcript_key: transcriptKey, round, folded_payload: null, record: null, messages });
  }

  async query(sql, params = []) {
    if (sql.includes('FROM chat_sessions s')) {
      const s = this.chatSessions.find((x) => x.id === params[0]);
      return { rows: s ? [s] : [] };
    }
    if (sql.includes('FROM transcript_rounds')) {
      // #375 重建路：`round BETWEEN $2 AND $3 AND messages <> '[]'::jsonb ... LIMIT $4`
      if (sql.includes('BETWEEN')) {
        const [key, from, to, limit] = params;
        const rows = this.transcriptRows
          .filter((x) => x.transcript_key === key && x.round >= from && x.round <= to
            && Array.isArray(x.messages) && x.messages.length > 0)
          .sort((a, b) => a.round - b.round) // 同轮保持插入序（真库是 append_seq 保序）
          .slice(0, limit)
          .map((x) => ({ round: x.round, messages: x.messages }));
        return { rows };
      }
      // 对齐 #195 回退后的 SQL：无 IS NOT NULL 过滤，行面含 folded_payload 与 record（列 NULL 时靠 record 回退）。
      const [key, round] = params;
      const rows = this.transcriptRows
        .filter((x) => x.transcript_key === key && x.round === round)
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

test('payload 缺失（无行 / 列与 record 都无原文）→ 404 folded_payload_not_found', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 5, null); // 有行但列为 NULL、record 无 foldedPayload → 仍 404
    const miss = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/5`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(miss.status, 404);
    assert.equal((await miss.json()).error.code, 'folded_payload_not_found');

    const noRow = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/77`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(noRow.status, 404);
    assert.equal((await noRow.json()).error.code, 'folded_payload_not_found');
  } finally { await s.close(); }
});

test('#195 存量行回退：folded_payload 列为 NULL 但 record.foldedPayload 有原文 → 200 且 turns 非空', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 12, null, { foldedPayload: RAW }); // 列 NULL、原文在 record（与写侧 putSessionRound 同规则）
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/12`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200, '存量行不得误 404');
    const body = await res.json();
    assert.equal(body.round, 12);
    assert.ok(Array.isArray(body.turns) && body.turns.length >= 2, 'turns 非空（同一上游投影）');
    const all = JSON.stringify(body.turns);
    assert.match(all, /RAW FOLDED QUESTION/);
    assert.match(all, /RAW FOLDED ANSWER/);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// #375：erix-agent 0.25.0 把归档改成「本轮新增的有界差分」⇒ 只读归档会残缺/为空，
// 而旧口径一律 404 + 文案「上游未保留折叠前载荷」（假话）。现在按 foldedRoundRange 从账本重建。
// ---------------------------------------------------------------------------

const msg = (text) => ({ role: 'user', content: [{ type: 'text', text }] });

test('#375 差分归档为空（去重全吸收）但有 range → 从账本重建 200，不再假 404', async () => {
  const s = await startServer();
  try {
    // 折叠行：本轮差分被会话级去重吸空（`[]`），meta 留痕；原文在 round 1/2 自己的行里。
    s.pool.seedFold(SESSION_ID, 9, [], { foldedRoundRange: { from: 1, to: 8 }, foldedPayloadMeta: { messages: 0, droppedMessages: 0, dedupedMessages: 42 } });
    s.pool.seedRound(SESSION_ID, 1, [msg('ORIGINAL AT ROUND ONE')]);
    s.pool.seedRound(SESSION_ID, 2, [msg('ORIGINAL AT ROUND TWO')]);
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/9`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200, '空差分不得再当「没原文」');
    const body = await res.json();
    const all = JSON.stringify(body.turns);
    assert.match(all, /ORIGINAL AT ROUND ONE/);
    assert.match(all, /ORIGINAL AT ROUND TWO/);
    assert.equal(body.source, 'rebuilt', '来源口径要说真话');
    assert.equal(body.round, 9, 'round 回显仍是折叠行自己的 round（#189 口径不变）');
  } finally { await s.close(); }
});

test('#375 差分只有一段而横幅说的是整个 range → 重建给出 range 内全部，且 truncated 可判定', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 20, [msg('ARCHIVED TAIL ONLY')], {
      foldedRoundRange: { from: 1, to: 19 },
      foldedPayloadMeta: { messages: 1, bytes: 100, capBytes: 262144, droppedMessages: 317, droppedBytes: 900000 },
    });
    s.pool.seedRound(SESSION_ID, 3, [msg('HEAD THAT WAS DROPPED FROM ARCHIVE')]);
    s.pool.seedRound(SESSION_ID, 18, [msg('TAIL STILL IN ARCHIVE')]);
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/20`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const all = JSON.stringify(body.turns);
    assert.match(all, /HEAD THAT WAS DROPPED FROM ARCHIVE/, '被夹断丢掉的头部仍要给出来');
    assert.match(all, /TAIL STILL IN ARCHIVE/);
    assert.equal(body.truncated, true, '归档被夹断要置布尔位（截断标记由前端出，不塞省略号文本）');
    assert.equal(body.dropped_messages, 317);
    assert.equal(body.source, 'rebuilt');
  } finally { await s.close(); }
});

test('#375 404 语义收窄：range 内一行正文都没有且归档也为空 → 才叫「没原文」', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 30, [], { foldedRoundRange: { from: 1, to: 29 }, foldedPayloadMeta: { messages: 0 } });
    s.pool.seedRound(SESSION_ID, 5, []); // 无正文的事实行（真库靠 messages <> '[]'::jsonb 筛掉）
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/30`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error.code, 'folded_payload_not_found');
  } finally { await s.close(); }
});

test('#375 重建跨多轮多行不得只取一页（#338/#351 同根教训：按 round, append_seq 取全）', async () => {
  const s = await startServer();
  try {
    s.pool.seedFold(SESSION_ID, 40, [], { foldedRoundRange: { from: 1, to: 39 } });
    for (const r of [1, 12, 24, 39]) s.pool.seedRound(SESSION_ID, r, [msg(`R${r}`)]);
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}/folded/40`, { headers: { Cookie: s.cookieHeader } });
    const body = await res.json();
    const all = JSON.stringify(body.turns);
    for (const r of [1, 12, 24, 39]) assert.match(all, new RegExp(`R${r}`), `range 边缘的轮也要给出来（to=39 含端点）`);
    assert.equal(body.truncated, false);
  } finally { await s.close(); }
});

test('#375 源码级哨兵：重建 SQL 必须筛掉无正文行并带上限（fake 自己模拟了这个筛除，不钉就是假绿面）', () => {
  const src = fs.readFileSync(new URL('../src/sessions.js', import.meta.url), 'utf8');
  const start = src.indexOf('async function rebuildFoldedRange');
  assert.ok(start > 0, '重建入口必须在（改名要同步本哨兵）');
  const body = src.slice(start);
  assert.ok(body.includes("messages <> '[]'::jsonb"), '无正文事实行必须在 SQL 里筛掉（否则空 records 进投影）');
  assert.match(body, /LIMIT \$4/, '必须有行上限（range 可能跨上百轮）');
  assert.ok(body.includes('FOLDED_REBUILD_MAX_ROWS + 1'), '上限要"多取一条"才判得出截断');
  assert.ok(body.includes('ORDER BY round ASC, append_seq ASC'), '取行顺序必须与账本保序口径一致（#338 教训）');
});
