// 单测：issue #256 交付①——号池**占用总览**读端点 `GET /api/admin/preview-ports/usage`。
//
// 工单第「新增测试必须覆盖」5 条：
//   ① `released` 行**不占位**（一段内只有一条 released ⇒ 该段仍进 `free_blocks`）
//   ② `partial` / `occupied` 分类正确，且一段里**两个 FDE** 时 `fde_names` 给出两个名字
//   ③ 端点实现里**零端口字面量**（源码级断言：新函数体内不含 22000 / 29999 / 10）
//   ④ 非 admin ⇒ 403 且**不写审计**；admin ⇒ **恰好一行**审计且 `details` 不含整份响应体
//   ⑤ `has_more` 与 `limit` 语义（空闲段多于 limit ⇒ `has_more=true` 且 `items.length == limit`）
//
// 隔离约定（docs/testing.md §2.1）：内存 fake，不碰真库 / docker。fake 只按真 SQL 的**谓词**派发
// （`state <> 'released'` + `port BETWEEN $1 AND $2` + LEFT JOIN users 取 fde_name），
// 这样「released 不占位」这条断言测的是实现真的发出去的 SQL，而不是测试自己写的过滤条件。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import {
  PREVIEW_PORT_BLOCK_COUNT,
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_POOL_START,
  PREVIEW_USAGE_FREE_LIMIT_DEFAULT,
  previewPortPoolUsage,
} from '../src/portalloc.js';

const BASE = 'fde.erix.vip';
const PUBLIC_BASE = 'http://station.fde.erix.vip:8090';
const LOG = { log() {}, warn() {}, error() {} };
const SRC_DIR = path.dirname(fileURLToPath(new URL('../src/portalloc.js', import.meta.url)));

/** 第 n 段（n=0 ⇒ 池起点那一段）的起点。测试里**不用**端口字面量，避免自己变成第二套真相源。 */
function blockStart(nth) {
  return PREVIEW_PORT_POOL_START + nth * PREVIEW_PORT_COUNT;
}

/** 段内第 i 个端口。 */
function portIn(nth, i = 0) {
  return blockStart(nth) + i;
}

// ---------------------------------------------------------------------------
// fake：port_allocations（+ users 的 fde_name 用于 LEFT JOIN）
// ---------------------------------------------------------------------------
class UsageStore {
  /**
   * @param {{rows?: Array<{fde_id, port, state}>, users?: Array<{id, fde_name}>}} [seed]
   */
  constructor({ rows = [], users = [] } = {}) {
    this.rows = rows.map((row, i) => ({ id: `pa-${i + 1}`, state: 'allocated', ...row }));
    this.users = users;
    this.seq = [];
    this.writes = [];
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    this.seq.push(s.split(' ').slice(0, 3).join(' '));

    // 总览取数：谓词由 SQL 决定（fake 不另写一套），LEFT JOIN users 取 fde_name。
    if (s.startsWith('SELECT pa.port AS port, u.fde_name AS fde_name')) {
      const [start, end] = params;
      // **谓词由 SQL 决定**（fake 不另写一套）：实现把 `state <> 'released'` 去掉/放宽时，
      // 「released 不占位」那条断言就会真的红（这是本文件最重要一条判据的诚实性来源）。
      const liveOnly = /WHERE pa\.state <> 'released' AND/.test(s);
      const rows = this.rows
        .filter((row) => (!liveOnly || row.state !== 'released') && row.port >= start && row.port <= end)
        .sort((a, b) => a.port - b.port)
        .map((row) => ({
          port: row.port,
          fde_name: this.users.find((u) => u.id === row.fde_id)?.fde_name ?? null,
        }));
      return { rows, rowCount: rows.length };
    }

    // 审计行（`INSERT INTO audit_log`）交给 FakePool 记进 `pool.audit`，本 fake 不算作端口域写。
    if (s.startsWith('INSERT INTO audit_log')) return null;
    if (/^(INSERT|UPDATE|DELETE) /.test(s)) {
      this.writes.push(s);
      return { rows: [], rowCount: 0 };
    }
    return null;
  }

  pool() {
    return { query: (sql, params) => this.query(sql, params) };
  }
}

// ---------------------------------------------------------------------------
// ① released 不占位
// ---------------------------------------------------------------------------
test('#256① released 行不占位：只有一条 released 的段仍进 free_blocks；10 行里 1 条 released 的段算 partial(9)', async () => {
  const store = new UsageStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }],
    rows: [
      // 第 0 段：唯一一条行是 released（历史行）⇒ 号码可回收 ⇒ 该段整段空闲。
      { fde_id: 'u-alice', port: portIn(0, 0), state: 'released' },
      // 第 1 段：10 条行，其中 1 条 released ⇒ 活行 9 条 ⇒ partial，且**不是** occupied。
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({
        fde_id: 'u-alice', port: portIn(1, i), state: i === 0 ? 'released' : 'allocated',
      })),
    ],
  });

  const usage = await previewPortPoolUsage(store.pool());

  assert.equal(usage.free_blocks.items[0], blockStart(0), 'released 不占位 ⇒ 第 0 段必须是第一个空闲段');
  assert.deepEqual(usage.occupied_blocks.map((b) => b.start), [blockStart(1)], '第 0 段不进 occupied_blocks');
  assert.equal(usage.occupied_blocks[0].occupied_count, PREVIEW_PORT_COUNT - 1, 'released 那条不计入 occupied_count');
  assert.equal(usage.summary.partial, 1);
  assert.equal(usage.summary.occupied, 0, 'released 的那一条不得把该段算成占满');
  assert.equal(usage.summary.free, PREVIEW_PORT_BLOCK_COUNT - 1);
  assert.equal(usage.summary.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
  assert.equal(
    usage.summary.free + usage.summary.partial + usage.summary.occupied,
    PREVIEW_PORT_BLOCK_COUNT,
    '三类之和必须等于段总数（口径自洽）',
  );
  assert.equal(store.writes.length, 0, '总览是只读端点：一条写语句都不发');
});

// ---------------------------------------------------------------------------
// ② partial / occupied 分类 + 一段里两个 FDE
// ---------------------------------------------------------------------------
test('#256② partial 与 occupied 分类正确；一段里两个 FDE ⇒ fde_names 给出两个名字（升序、去重）', async () => {
  const store = new UsageStore({
    users: [
      { id: 'u-alice', fde_name: 'alice' },
      { id: 'u-bob', fde_name: 'bob' },
      { id: 'u-carol', fde_name: 'carol' },
    ],
    rows: [
      // 第 0 段：占满 10 个（两个 FDE 混住：单端口覆盖造出的 mixed 形状）。
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({
        fde_id: i % 2 === 0 ? 'u-bob' : 'u-alice', port: portIn(0, i),
      })),
      // 第 2 段：3 个活行（含一个 FDE 的 2 个 + 另一个 FDE 的 1 个）。
      { fde_id: 'u-carol', port: portIn(2, 0) },
      { fde_id: 'u-carol', port: portIn(2, 1) },
      { fde_id: 'u-bob', port: portIn(2, 2) },
    ],
  });

  const usage = await previewPortPoolUsage(store.pool());

  assert.equal(usage.summary.occupied, 1, '第 0 段占满 ⇒ occupied=1');
  assert.equal(usage.summary.partial, 1, '第 2 段占 3 个 ⇒ partial=1');
  assert.deepEqual(usage.occupied_blocks.map((b) => b.start), [blockStart(0), blockStart(2)], '只列有活行的段、升序');

  const [full, part] = usage.occupied_blocks;
  assert.deepEqual(full.fde_names, ['alice', 'bob'], '一段两个 FDE ⇒ 两个名字都在（不能只给第一个）');
  assert.equal(full.occupied_count, PREVIEW_PORT_COUNT);
  assert.equal(full.end, blockStart(0) + PREVIEW_PORT_COUNT - 1, 'end 用块几何算，不写死 +9');
  assert.deepEqual(part.fde_names, ['bob', 'carol'], '按名字升序、去重（carol 两行只出现一次）');
  assert.equal(part.occupied_count, 3);

  // 段边界用**整块**判定：占 1 个的段也不进 free_blocks（与 firstFreePreviewBlockStart 一致）。
  assert.equal(usage.free_blocks.items.includes(blockStart(2)), false, '有活行的段不得出现在空闲段里');
  assert.equal(usage.free_blocks.items[0], blockStart(1));
});

// ---------------------------------------------------------------------------
// ③ 源码级断言：新函数体内零端口字面量
// ---------------------------------------------------------------------------
test('#256③ 端点实现里零端口字面量：previewPortPoolUsage 函数体内不含 22000 / 29999 / 10（数字只从 previewpool.js 推导）', () => {
  const source = fs.readFileSync(path.join(SRC_DIR, 'portalloc.js'), 'utf8');
  const start = source.indexOf('export async function previewPortPoolUsage');
  assert.ok(start > 0, 'portalloc.js 里必须找得到 previewPortPoolUsage（名字变了就同步改本断言）');
  const rest = source.slice(start + 1);
  const end = rest.indexOf('\nexport ');
  const body = end >= 0 ? rest.slice(0, end) : rest;

  for (const literal of [String(PREVIEW_PORT_POOL_START), String(PREVIEW_PORT_POOL_END)]) {
    assert.equal(body.includes(literal), false, `函数体内不得出现端口字面量 ${literal}（号池边界只能来自 previewpool.js）`);
  }
  assert.equal(/\b10\b/.test(body), false, '函数体内不得出现块大小字面量 10');
  assert.equal(/\b800\b/.test(body), false, '函数体内不得出现段总数字面量 800');
  // 反证：体里确实用到了常量（否则上面几条「不含字面量」可以靠空函数通过）。
  for (const name of ['PREVIEW_PORT_POOL_START', 'PREVIEW_PORT_POOL_END', 'PREVIEW_PORT_COUNT', 'PREVIEW_PORT_BLOCK_COUNT']) {
    assert.ok(body.includes(name), `函数体必须引用 ${name}（口径唯一来源）`);
  }
});

// ---------------------------------------------------------------------------
// ⑤ has_more / limit
// ---------------------------------------------------------------------------
test('#256⑤ has_more 与 limit：空闲段多于 limit ⇒ has_more=true 且 items.length == limit；给够 ⇒ has_more=false', async () => {
  const store = new UsageStore();   // 全空号池：800 段全空闲
  const limited = await previewPortPoolUsage(store.pool(), { freeLimit: 3 });
  assert.equal(limited.free_blocks.limit, 3);
  assert.deepEqual(limited.free_blocks.items, [blockStart(0), blockStart(1), blockStart(2)], '空闲段起点升序');
  assert.equal(limited.free_blocks.has_more, true, '还有 797 段没列 ⇒ has_more=true');
  assert.equal(limited.summary.free, PREVIEW_PORT_BLOCK_COUNT, 'summary 数的是**全部**空闲段，不是列出来的那几条');

  const all = await previewPortPoolUsage(store.pool(), { freeLimit: PREVIEW_PORT_BLOCK_COUNT });
  assert.equal(all.free_blocks.items.length, PREVIEW_PORT_BLOCK_COUNT);
  assert.equal(all.free_blocks.has_more, false, '全给出来了 ⇒ has_more=false');

  const dflt = await previewPortPoolUsage(store.pool());
  assert.equal(dflt.free_blocks.limit, PREVIEW_USAGE_FREE_LIMIT_DEFAULT, '默认 limit = 50');
  assert.equal(dflt.free_blocks.items.length, PREVIEW_USAGE_FREE_LIMIT_DEFAULT);
  assert.equal(dflt.free_blocks.has_more, true);

  await assert.rejects(() => previewPortPoolUsage(store.pool(), { freeLimit: 0 }), /freeLimit/);
  await assert.rejects(() => previewPortPoolUsage(store.pool(), { freeLimit: 1.5 }), /freeLimit/);
});

test('#256 pool 信封：边界 / 块大小 / 段总数全部来自 previewpool.js（不是端点自己算的）', async () => {
  const usage = await previewPortPoolUsage(new UsageStore().pool());
  assert.deepEqual(usage.pool, {
    start: PREVIEW_PORT_POOL_START,
    end: PREVIEW_PORT_POOL_END,
    block_size: PREVIEW_PORT_COUNT,
    total_blocks: PREVIEW_PORT_BLOCK_COUNT,
  });
  assert.equal(usage.summary.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
});

// ---------------------------------------------------------------------------
// ④ HTTP 层：403 / 恰好一行审计 / details 不含整份响应体
// ---------------------------------------------------------------------------
const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const ALICE = {
  id: 'u-alice', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-usage-admin';
const ALICE_TOKEN = 'tok-usage-alice';

class UsageHttpPool extends FakePool {
  constructor({ store, users }) {
    super({ users: users.map((u) => ({ ...u })) });
    this.store = store;
    this.sqlLog = [];
    for (const token of [
      { id: 'ls-admin', user_id: ADMIN.id, token: ADMIN_TOKEN },
      { id: 'ls-alice', user_id: ALICE.id, token: ALICE_TOKEN },
    ]) {
      this.sessions.push({
        id: token.id, user_id: token.user_id, token_hash: auth.hashToken(token.token),
        created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000),
        last_seen_at: new Date(), revoked_at: null,
      });
    }
  }

  async query(sql, params = []) {
    this.sqlLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    const hit = await this.store.query(sql, params);
    if (hit) return hit;
    return super.query(sql, params);
  }

  async connect() {
    const self = this;
    return { query: (sql, params) => self.query(sql, params), release() {} };
  }
}

async function startUsageServer({ store, users = [ADMIN, ALICE] } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-usage-static-'));
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir,
    baseDomain: BASE,
    portalPublicBaseUrl: PUBLIC_BASE,
  };
  const pool = new UsageHttpPool({ store, users });
  const server = createServer({ pool, config, llmGateway: { async listModels() { return { data: [] }; } }, log: LOG });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    aliceCookie: `${config.cookie.name}=${ALICE_TOKEN}`,
    close: () => new Promise((res) => server.close(res)),
  };
}

test('#256④ GET /api/admin/preview-ports/usage：admin 200 + **恰好一行**审计（details 只放计数）；非 admin 403 且不写审计', async () => {
  const store = new UsageStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }],
    rows: [
      ...Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => ({ fde_id: 'u-alice', port: portIn(0, i) })),
      { fde_id: 'u-alice', port: portIn(3, 0) },
    ],
  });
  const { base, adminCookie, aliceCookie, pool, close } = await startUsageServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['free_blocks', 'occupied_blocks', 'pool', 'summary']);
    assert.equal(body.summary.occupied, 1);
    assert.equal(body.summary.partial, 1);
    assert.equal(body.free_blocks.items[0], blockStart(1), '第 1 段是第一个空闲段');
    assert.equal(body.occupied_blocks.length, 2);

    assert.equal(store.writes.length, 0, '只读端点：零写库（也不入队 outbox / revision）');
    const listed = pool.audit.filter((e) => e.action === 'admin.preview_ports_usage_listed');
    assert.equal(listed.length, 1, '审计**恰好一行**（多写也算失败）');
    assert.equal(pool.audit.length, 1, '整个请求只产生这一行审计');
    assert.equal(listed[0].actor_id, ADMIN.id);
    assert.equal(listed[0].target, 'preview_port_pool');
    const details = JSON.parse(listed[0].details);
    assert.deepEqual(Object.keys(details).sort(),
      ['free_count', 'limit', 'occupied_block_count', 'total_blocks'],
      'details 只放计数：不放整份响应体（那是一张号池快照）');
    assert.equal(details.free_count, body.summary.free);
    assert.equal(details.occupied_block_count, body.occupied_blocks.length);
    assert.equal(details.total_blocks, PREVIEW_PORT_BLOCK_COUNT);
    for (const forbidden of ['occupied_blocks', 'free_blocks', 'fde_names', 'items', 'ticket']) {
      assert.equal(JSON.stringify(details).includes(forbidden), false, `details 不得含 ${forbidden}`);
    }

    // 第二次读 ⇒ 不多不少再多一行。
    await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: adminCookie } });
    assert.equal(pool.audit.length, 2);

    // 非 admin ⇒ 403（既有 forbidden 路径，零新错误码）+ 不写审计。
    const forbidden = await fetch(`${base}/api/admin/preview-ports/usage`, { headers: { cookie: aliceCookie } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'forbidden');
    assert.equal(pool.audit.length, 2, '403 不写审计');

    // 未登录 ⇒ 401（既有口径）。
    const anon = await fetch(`${base}/api/admin/preview-ports/usage`);
    assert.equal(anon.status, 401);

    // 方法不对 ⇒ 405（与同族 admin 端点一致）。
    const wrongMethod = await fetch(`${base}/api/admin/preview-ports/usage`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(pool.audit.length, 2, '405 也不写审计');
  } finally {
    await close();
  }
});

test('#256④b ?limit= 合法时生效、非法时 400 validation_failed + details.field（复用既有错误码，不新造）', async () => {
  const store = new UsageStore();
  const { base, adminCookie, pool, close } = await startUsageServer({ store });
  try {
    const ok = await fetch(`${base}/api/admin/preview-ports/usage?limit=2`, { headers: { cookie: adminCookie } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.free_blocks.limit, 2);
    assert.equal(body.free_blocks.items.length, 2);
    assert.equal(body.free_blocks.has_more, true);
    assert.equal(pool.audit.length, 1);

    for (const raw of ['0', '-1', '1.5', 'abc', String(PREVIEW_PORT_BLOCK_COUNT + 1)]) {
      const bad = await fetch(`${base}/api/admin/preview-ports/usage?limit=${encodeURIComponent(raw)}`, {
        headers: { cookie: adminCookie },
      });
      assert.equal(bad.status, 400, `limit=${raw} 必须 400`);
      const err = await bad.json();
      assert.equal(err.error.code, 'validation_failed');
      assert.equal(err.error.details.field, 'limit');
    }
    assert.equal(pool.audit.length, 1, '400 不写审计');
    assert.equal(store.writes.length, 0);
  } finally {
    await close();
  }
});
