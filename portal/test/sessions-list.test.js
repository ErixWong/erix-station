// 单测：issue #94 会话列表分页/过滤 API——listSessions 的复合 keyset 游标 / q 过滤 / total 计数。
// 覆盖：同 updated_at 多条不跳过、复合游标 round-trip、q（ILIKE contains + 长度上限）、
//       total 与条件一致、旧格式/非法游标一律 validation_failed。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool 按 SQL 标记 emulate 过滤/排序/LIMIT 语义，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listSessions, encodeSessionCursor, decodeSessionCursor,
  SessionError, MAX_SESSION_QUERY_LENGTH,
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

/** 造一行会话（updated_at 可传 ISO 字符串，fake pool 内转 Date 比较）。 */
function row(id, { title = `会话 ${id}`, cwd = '~/projects/a', updated_at = T0, status = 'active', active_run_id = null } = {}) {
  return {
    id, user_id: UID, project_id: null, cwd, title, title_source: 'auto', model: null,
    status, last_seq: 0, created_at: updated_at, updated_at,
    active_run_id,
  };
}

/**
 * 内存 fake pool：解析 listSessions 拼出的 SQL 标记，emulate 语义：
 *   WHERE 过滤（user_id/status/cwd/title ILIKE/复合游标行值比较）+ ORDER BY updated_at DESC, id DESC + LIMIT。
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
    const qIdx = pick(/AND title ILIKE \$(\d+)/);
    if (qIdx) {
      const needle = String(params[qIdx - 1]).replaceAll('%', '').toLowerCase();
      out = out.filter((r) => String(r.title ?? '').toLowerCase().includes(needle));
    }
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
    if (/SELECT COUNT\(\*\)/.test(sql)) {
      return { rows: [{ total: this.#filter(sql, params).length }] };
    }
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
  let page1 = null;
  let lastPage = null;
  do {
    const res = await listSessions(pool, { userId: UID, limit: 2, cursor: cursor ?? undefined, total: true });
    page1 ??= res;
    lastPage = res;
    collected.push(...res.items.map((i) => i.id));
    cursor = res.next_cursor;
  } while (cursor);
  assert.deepEqual(collected, expected, '(updated_at DESC, id DESC) 全序翻页');
  assert.equal(page1.total, expected.length, 'total 与过滤条件一致');
  assert.equal(lastPage.total, expected.length, '翻页后 total 不变');
});

test('listSessions：末页无更多 → next_cursor 为 null', async () => {
  const pool = new ListPool([row('11111111-1111-4111-8111-111111111111')]);
  const res = await listSessions(pool, { userId: UID, limit: 20 });
  assert.equal(res.next_cursor, null);
});

// ---------------------------------------------------------------------------
// q 过滤 / total 计数
// ---------------------------------------------------------------------------

test('listSessions：q = 标题 contains（ILIKE，大小写不敏感）', async () => {
  const pool = new ListPool([
    row('11111111-1111-4111-8111-111111111111', { title: 'Meeting ASR 方案' }),
    row('22222222-2222-4222-8222-222222222222', { title: '数据库迁移' }),
    row('33333333-3333-4333-8333-333333333333', { title: 'meeting notes' }),
  ]);
  const res = await listSessions(pool, { userId: UID, q: 'meeting', total: true });
  assert.match(pool.queries.find((q) => q.sql.includes('FROM chat_sessions s')).sql, /title ILIKE/);
  assert.deepEqual(res.items.map((i) => i.title).sort(), ['Meeting ASR 方案', 'meeting notes']);
  assert.equal(res.total, 2, 'total 与 q 条件一致');
});

test('listSessions：q 与 cwd 叠加过滤，total 与叠加条件一致', async () => {
  const pool = new ListPool([
    row('11111111-1111-4111-8111-111111111111', { title: '部署脚本', cwd: '~/projects/a' }),
    row('22222222-2222-4222-8222-222222222222', { title: '部署计划', cwd: '~/projects/b' }),
    row('33333333-3333-4333-8333-333333333333', { title: '别的', cwd: '~/projects/a' }),
    row('44444444-4444-4444-8444-444444444444', { title: '部署文档', cwd: '~/projects/a', status: 'archived' }),
  ]);
  const res = await listSessions(pool, { userId: UID, cwd: '~/projects/a', q: '部署', total: true });
  assert.deepEqual(res.items.map((i) => i.id), ['11111111-1111-4111-8111-111111111111']);
  assert.equal(res.total, 1, 'total 只计 user_id+cwd+q+active 命中');
});

test('listSessions：q 超长 → 400 validation_failed（field=q）；不传 total → 无 COUNT 查询', async () => {
  const pool = new ListPool([row('11111111-1111-4111-8111-111111111111')]);
  await assert.rejects(
    () => listSessions(pool, { userId: UID, q: 'x'.repeat(MAX_SESSION_QUERY_LENGTH + 1) }),
    (e) => e instanceof SessionError && e.code === 'validation_failed' && e.details?.field === 'q',
  );
  const res = await listSessions(pool, { userId: UID });
  assert.equal(res.total, undefined, '未请求 total 不返回该字段');
  assert.equal(pool.queries.some((q) => /SELECT COUNT\(\*\)/.test(q.sql)), false, '未请求 total 不发 COUNT');
});

test('listSessions：total 含游标时不被游标边界收窄（计数=全条件命中数）', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`${String(i + 1).repeat(8)}-${String(i + 1).repeat(4)}-4${String(i + 1).repeat(3)}-8${String(i + 1).repeat(3)}-${String(i + 1).repeat(12)}`));
  const pool = new ListPool(rows);
  const page1 = await listSessions(pool, { userId: UID, limit: 2, total: true });
  assert.equal(page1.total, 5, '第一页 total=全量命中');
  const page2 = await listSessions(pool, { userId: UID, limit: 2, cursor: page1.next_cursor, total: true });
  assert.equal(page2.total, 5, '翻页后 total 仍=全量命中（不含游标边界）');
});

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

// ---------------------------------------------------------------------------
// HTTP 层：GET /api/sessions?q=&total= 参数透传 + 响应组装（真实 server + 内存 pool）
// ---------------------------------------------------------------------------

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

test('HTTP：GET /api/sessions?q=&total=1 → 200，SQL 带 ILIKE/COUNT，响应组装 items+next_cursor+total', async () => {
  const rows = [
    row('11111111-1111-4111-8111-111111111111', { title: '部署脚本' }),
    row('22222222-2222-4222-8222-222222222222', { title: '部署计划' }),
    row('33333333-3333-4333-8333-333333333333', { title: '别的' }),
  ];
  const s = await startHttp(rows);
  try {
    const res = await fetch(`${s.base}/api/sessions?q=${encodeURIComponent('部署')}&total=1`, {
      headers: { Cookie: s.cookieHeader },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.total, 2, 'total 与 q 条件一致');
    const listSql = s.pool.queries.find((q) => q.sql.includes('FROM chat_sessions s'));
    assert.match(listSql.sql, /title ILIKE/, 'q 落到 ILIKE 过滤');
    assert.ok(s.pool.queries.some((q) => /SELECT COUNT\(\*\)/.test(q.sql)), 'total=1 触发 COUNT');

    // 不带 total：响应无 total 字段、无 COUNT 查询
    s.pool.queries.length = 0;
    const res2 = await fetch(`${s.base}/api/sessions`, { headers: { Cookie: s.cookieHeader } });
    const body2 = await res2.json();
    assert.equal(body2.total, undefined);
    assert.equal(s.pool.queries.some((q) => /SELECT COUNT\(\*\)/.test(q.sql)), false);
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
