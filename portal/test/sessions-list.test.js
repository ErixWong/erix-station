// 单测：issue #94 会话列表分页 API——listSessions 的复合 keyset 游标（真缺陷修复，评审裁决保留）。
// 覆盖：同 updated_at 多条不跳过、复合游标 round-trip、末页终止、旧格式/非法游标一律 validation_failed。
// 评审裁决瘦身：q/total 已拆除（对应用例已删）。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool 按 SQL 标记 emulate 过滤/排序/LIMIT 语义，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSessions, encodeSessionCursor, decodeSessionCursor,
  SessionError,
} from '../src/sessions.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const UID = 'u1';
const T0 = '2026-09-26T00:00:00.000Z';

const HTTP_USER = {
  id: UID, login: 'alice', display_name: 'alice', role: 'fde', fde_name: 'alice',
  auth_source: 'local', status: 'active',
};
const TOKEN = 'tok-sessions-list-test';

/** 造一行会话（updated_at 可传 ISO 字符串，fake pool 内转 Date 比较；message_count 为 #197 列表内嵌子查询列）。 */
function row(id, { title = `会话 ${id}`, cwd = '~/projects/a', updated_at = T0, status = 'active', active_run_id = null, message_count = 0 } = {}) {
  return {
    id, user_id: UID, project_id: null, cwd, title, title_source: 'auto', model: null,
    status, last_seq: 0, created_at: updated_at, updated_at,
    active_run_id, message_count,
  };
}

/**
 * 内存 fake pool：解析 listSessions 拼出的 SQL 标记，emulate 语义：
 *   WHERE 过滤（user_id/status/cwd/复合游标行值比较）+ ORDER BY updated_at DESC, id DESC + LIMIT。
 * 正则按「参数占位符 $N」取参——与参数拼接顺序解耦，只依赖 SQL 结构（换拼接顺序不脆断）。
 * 继承 FakePool：登录会话/用户查询走父类真语义（HTTP 层测试可鉴权）。
 */
class ListPool extends FakePool {
  constructor(rows) {
    super({ users: [HTTP_USER] });
    this.rows = rows;
    this.queries = [];
  }

  #filter(sql, params) {
    const pick = (re) => {
      const m = re.exec(sql);
      return m ? Number(m[1]) : null;
    };
    let out = this.rows.filter((r) => r.user_id === params[0] && r.status === 'active');
    const cwdIdx = pick(/AND cwd = \$(\d+)/);
    if (cwdIdx) out = out.filter((r) => r.cwd === params[cwdIdx - 1]);
    const cur = /\(\$(\d+), \$(\d+)\)/.exec(sql); // 复合游标行值比较（唯一成对占位处）
    if (cur) {
      const [u, i] = [params[Number(cur[1]) - 1], params[Number(cur[2]) - 1]];
      const uMs = Date.parse(u);
      out = out.filter((r) => {
        const rMs = Date.parse(r.updated_at);
        return rMs < uMs || (rMs === uMs && String(r.id) < String(i));
      });
    }
    return out;
  }

  async query(sql, params = []) {
    this.queries.push({ sql, params });
    if (sql.includes('FROM chat_sessions s')) {
      const limitIdx = /LIMIT \$(\d+)/.exec(sql);
      const limit = limitIdx ? Number(params[limitIdx[1] - 1]) : 100;
      const sorted = this.#filter(sql, params).sort((a, b) => {
        const d = Date.parse(b.updated_at) - Date.parse(a.updated_at);
        return d !== 0 ? d : (String(a.id) > String(b.id) ? -1 : String(a.id) < String(b.id) ? 1 : 0);
      });
      return { rows: sorted.slice(0, limit) };
    }
    return super.query(sql, params);
  }
}

// ---------------------------------------------------------------------------
// 复合游标编解码
// ---------------------------------------------------------------------------

test('encodeSessionCursor/decodeSessionCursor：round-trip（u=updated_at ISO，i=id）', () => {
  const r = row('11111111-1111-4111-8111-111111111111', { updated_at: '2026-09-26T01:02:03.456Z' });
  const cursor = encodeSessionCursor(r);
  assert.equal(typeof cursor, 'string');
  assert.doesNotMatch(cursor, /[+/=]/, 'base64url 形态（不透明串）');
  const back = decodeSessionCursor(cursor);
  assert.equal(back.updatedAt, '2026-09-26T01:02:03.456Z');
  assert.equal(back.id, r.id);
});

test('decodeSessionCursor：旧格式（纯 UUID）/ 非法值一律 validation_failed', () => {
  for (const bad of [
    '11111111-1111-4111-8111-111111111111', // issue #94 前旧游标格式：严格拒绝
    'not-a-cursor',
    Buffer.from('{"u":"x","i":"y"}', 'utf8').toString('base64url'), // 形状对但 i 非 UUID
    Buffer.from('{"i":"11111111-1111-4111-8111-111111111111"}', 'utf8').toString('base64url'), // 缺 u
    '',
    123,
  ]) {
    assert.throws(
      () => decodeSessionCursor(bad),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cursor',
      `应拒绝：${JSON.stringify(bad)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 分页：复合排序 + 同 updated_at 不跳过
// ---------------------------------------------------------------------------

test('listSessions：排序 updated_at DESC, id DESC（SQL 复合 ORDER BY 落字）', async () => {
  const pool = new ListPool([row('a'), row('b')]);
  const { items } = await listSessions(pool, { userId: UID });
  assert.match(pool.queries[0].sql, /ORDER BY s\.updated_at DESC, s\.id DESC/);
  assert.equal(items.length, 2);
});

test('listSessions：message_count（#197）——列表 SQL 内嵌 messages 相关子查询，零额外往返，逐项透传', async () => {
  const pool = new ListPool([
    row('11111111-1111-4111-8111-111111111111', { updated_at: '2026-09-26T03:00:00.000Z', message_count: 7 }),
    row('22222222-2222-4222-8222-222222222222', { updated_at: '2026-09-26T02:00:00.000Z', message_count: 0 }),
  ]);
  const { items } = await listSessions(pool, { userId: UID });
  // 子查询内嵌在同一条列表 SQL 里（口径：全量 messages 行含 synthetic，与头部状态行同源），不多发一次查询
  assert.match(pool.queries[0].sql, /\(SELECT COUNT\(\*\) FROM messages m WHERE m\.session_id = s\.id\) AS message_count/);
  assert.equal(pool.queries.length, 1, '仅一条 SQL（子查询非独立往返）');
  assert.deepEqual(items.map((i) => i.message_count), [7, 0]);
  assert.equal(Number.isInteger(items[0].message_count), true, '整数（真实 pg 下 COUNT 为 bigint 字符串，映射层 Number() 归一）');
});

test('listSessions：同 updated_at 多条——keyset 翻页不跳过、不重复', async () => {
  // 5 条同时间戳（旧实现按 updated_at 翻页会整体跳过），limit=2：3 页取齐 5 条。
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
  const pool = new ListPool(ids.map((id) => row(id)));
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await listSessions(pool, { userId: UID, limit: 2, cursor: cursor ?? undefined });
    seen.push(...res.items.map((i) => i.id));
    cursor = res.next_cursor;
    pages++;
    assert.ok(pages <= 4, '翻页应终止（cursor 推进）');
  } while (cursor);
  assert.deepEqual([...seen].sort(), [...ids].sort(), '5 条全部取到（同时间戳不跳过）');
  assert.equal(new Set(seen).size, seen.length, '无重复');
});

test('listSessions：复合游标 round-trip——跨不同 updated_at + 同 updated_at 混合翻页保序', async () => {
  const rows = [
    row('11111111-1111-4111-8111-111111111111', { updated_at: '2026-09-26T03:00:00.000Z' }),
    row('22222222-2222-4222-8222-222222222222', { updated_at: '2026-09-26T02:00:00.000Z' }),
    row('33333333-3333-4333-8333-333333333333', { updated_at: '2026-09-26T02:00:00.000Z' }),
    row('44444444-4444-4444-8444-444444444444', { updated_at: '2026-09-26T01:00:00.000Z' }),
  ];
  const pool = new ListPool(rows);
  const expected = ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333',
    '22222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444'];
  const collected = [];
  let cursor = null;
  let pages = 0;
  do {
    const res = await listSessions(pool, { userId: UID, limit: 2, cursor: cursor ?? undefined });
    collected.push(...res.items.map((i) => i.id));
    cursor = res.next_cursor;
    pages++;
    assert.ok(pages <= 3, '翻页应终止（cursor 推进）');
  } while (cursor);
  assert.deepEqual(collected, expected, '(updated_at DESC, id DESC) 全序翻页');
});

test('listSessions：末页无更多 → next_cursor 为 null', async () => {
  const pool = new ListPool([row('11111111-1111-4111-8111-111111111111')]);
  const res = await listSessions(pool, { userId: UID, limit: 20 });
  assert.equal(res.next_cursor, null);
});

// ---------------------------------------------------------------------------
// HTTP 层：GET /api/sessions 响应组装（真实 server + 内存 pool；评审裁决：q/total 透传已删）
// ---------------------------------------------------------------------------

test('listSessions：非法游标（旧格式/垃圾串）→ 400 validation_failed，不发查询', async () => {
  const pool = new ListPool([row('11111111-1111-4111-8111-111111111111')]);
  const before = pool.queries.length;
  for (const bad of ['11111111-1111-4111-8111-111111111111', 'garbage']) {
    await assert.rejects(
      () => listSessions(pool, { userId: UID, cursor: bad }),
      (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'cursor',
    );
  }
  assert.equal(pool.queries.length, before, '校验失败不发 SQL');
});

/** HTTP 层 fake pool：登录会话（真 token 哈希校验）+ 列表语义。 */
function httpServerRows(rows) {
  const pool = new ListPool(rows);
  pool.sessions.push({
    id: 'ls1', user_id: HTTP_USER.id, token_hash: auth.hashToken(TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000),
    last_seen_at: new Date(), revoked_at: null,
  });
  return pool;
}

async function startHttp(rows) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-list-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
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
  const pool = httpServerRows(rows);
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => { await new Promise((res) => server.close(res)); fs.rmSync(staticDir, { recursive: true, force: true }); },
  };
}

test('HTTP：GET /api/sessions → 200，响应组装 items+next_cursor，无 total 字段、无 COUNT 查询', async () => {
  const rows = [
    row('11111111-1111-4111-8111-111111111111', { title: '部署脚本', updated_at: '2026-09-26T03:00:00.000Z', message_count: 5 }),
    row('22222222-2222-4222-8222-222222222222', { title: '部署计划', updated_at: '2026-09-26T02:00:00.000Z', message_count: 3 }),
    row('33333333-3333-4333-8333-333333333333', { title: '别的', updated_at: '2026-09-26T01:00:00.000Z' }),
  ];
  const s = await startHttp(rows);
  try {
    const res = await fetch(`${s.base}/api/sessions?limit=2`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.items[0].title, '部署脚本');
    assert.notEqual(body.next_cursor, null, '还有第 3 条 → 有 next_cursor');
    assert.equal(body.total, undefined, '响应无 total 字段（评审裁决已拆除）');
    assert.equal(
      s.pool.queries.some((q) => /^\s*SELECT\s+COUNT/i.test(q.sql.trim())), false,
      '无独立 COUNT 往返查询（#197：message_count 为列表 SQL 内嵌相关子查询，不是另发的 COUNT）',
    );
    assert.deepEqual(body.items.map((i) => i.message_count), [5, 3], '#197：每项带 message_count（fake 行直供子查询列）');

    // 翻页：cursor 透传到复合行值比较
    s.pool.queries.length = 0;
    const res2 = await fetch(`${s.base}/api/sessions?limit=2&cursor=${encodeURIComponent(body.next_cursor)}`, {
      headers: { Cookie: s.cookieHeader },
    });
    const body2 = await res2.json();
    assert.deepEqual(body2.items.map((i) => i.title), ['别的'], 'cursor 之后只剩第 3 条');
    assert.equal(body2.next_cursor, null);
  } finally {
    await s.close();
  }
});

test('HTTP：GET /api/sessions?cursor=<旧格式纯 UUID> → 400 validation_failed', async () => {
  const s = await startHttp([row('11111111-1111-4111-8111-111111111111')]);
  try {
    const res = await fetch(`${s.base}/api/sessions?cursor=11111111-1111-4111-8111-111111111111`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'validation_failed');
    assert.match(body.error.message, /cursor/);
  } finally {
    await s.close();
  }
});
