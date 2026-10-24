// 单测：issue #246 **交付②**——预览端口列端点 + 管理员「改块 = 搬迁」+ 自动选块的冲突重算。
//
// 覆盖工单第「测试要求（至少覆盖）」12 条：
//   ① GET /api/me/ports                     → 本文件 HTTP 段第 1 组
//   ② GET /api/admin/fdes/:fdeName/ports     → HTTP 段第 2 组（含「审计恰好一行」）
//   ③ 搬迁成功（旧行 released / grant revoked / 新行 hostname·url / 两条派生链）
//   ④ 搬迁事务顺序（逐序 deepEqual，手法照 portal/test/portalloc.test.js）
//   ⑤ 搬迁冲突 → 409 preview_port_block_taken 且**零残留**
//   ⑥ 池外 / 非对齐 / 非整数 → 400 validation_failed（三种各一例，且零 SQL 写）
//   ⑦ 超预算 FDE 名 → 400 preview_hostname_invalid
//   ⑧ 幂等：目标块 == 当前块 → {changed:false} 且零 SQL 写
//   ⑨ 号码回收：搬出去再搬回同一块要成功（released 不占位）
//   ⑩ 插入数 ≠ 10（并发抢号）→ 回滚、不部分提交
//   ⑪ 自动选块重算：前 2 次占用第 3 次成功；连 3 次冲突 → 抛错且第 4 次不再试
//   ⑫ 显式指定 blockStart 冲突 → 不重算（只尝试一次）
//
// 以及 **#252**（工单 fix-261011-B）的三条：① 撤权只碰 active（used 保留原状）、② 谓词源码断言、
// ⑤ fake 必须**真**模拟双向 CHECK（手工发一条「把 used ticket 改 revoked」的 UPDATE 要报 23514）。
//
// 隔离约定（docs/testing.md §2.1）：内存 fake，不碰真库/docker。
// fake 必须**真做事务快照**（BEGIN 打快照 / ROLLBACK 还原），否则「零残留」与「不部分提交」
// 两句断言就只是在读测试自己写的假数据；同时照真库两条部分唯一索引 + port CHECK 的语义派发
// （与 portalloc.test.js 的 fake 同口径，注释从简）。
// **preview_grants 的 CHECK 一律走 `./preview-grant-checks.js`**（baseline 五条 CHECK 逐条同名模拟，
// 含 `(state='used') = (used_at IS NOT NULL)`，违反 ⇒ 语句级抛 23514）——旧 fake 只模拟
// `revoked ⇔ revoked_at`，所以上面那个 bug 在单测里**结构上不可能**被发现（#252 的根因）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';
// #252 的回归保护：preview_grants 的 baseline CHECK（**双向**的那两条）在 fake 里的等价模拟。
// 两侧 fake（本文件与 offboarding.test.js）共用一份规则，避免「一边补了、另一边还是摆设」。
import {
  applyRevokeGrantsSql,
  previewGrantCheckError,
  previewGrantCheckViolation,
  seedPreviewGrant,
} from './preview-grant-checks.js';
import {
  PREVIEW_PORT_COUNT,
  PREVIEW_PORT_POOL_END,
  PREVIEW_PORT_POOL_START,
  previewBlockPorts,
  listFdePreviewPorts,
  resolveFdeByName,
  moveFdePreviewBlock,
  provisionFdePreviewPorts,
  PREVIEW_BLOCK_MAX_ATTEMPTS,
} from '../src/portalloc.js';
import { previewUrl } from '../src/projects.js';
import { alignedPreviewBlockStart } from '../src/previewpool.js';

const BASE = 'fde.erix.vip';
const PUBLIC_BASE = 'http://station.fde.erix.vip:8090';
const CONFIG = { baseDomain: BASE, portalPublicBaseUrl: PUBLIC_BASE };
const LOG = { log() {}, warn() {}, error() {} };
const FIRST_BLOCK = previewBlockPorts(PREVIEW_PORT_POOL_START);      // 22000–22009
const SECOND_BLOCK = previewBlockPorts(PREVIEW_PORT_POOL_START + 10); // 22010–22019

function sqlError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// fake：port_allocations / preview_grants / users 内存表 + **真事务快照** + 两条部分唯一索引
//        + **preview_grants 全部 baseline CHECK**（含 `(state='used') = (used_at IS NOT NULL)`）
// ---------------------------------------------------------------------------

/**
 * 种子补齐成「真库里真能存在的一行」（剩下的由共享规则兜）：
 * ticket 必有 issuer_id、session 必带 parent_ticket_id、`used` 必带 used_at、`revoked` 必带 revoked_at。
 * 种子本身就违反 CHECK 的话，测的就是一种真库不存在的状态 ⇒ 当场炸，不往下游传。
 */
function seedGrant(grant) {
  return seedPreviewGrant(grant, { subject: 'u-alice', issuer: 'u-alice' });
}

class PortsStore {
  constructor({ users = [], rows = [], grants = [] } = {}) {
    this.users = users;                                     // [{id, fde_name}]
    this.rows = rows.map((row, i) => ({ run_id: null, released_at: null, id: `pa-${i + 1}`, ...row }));
    this.grants = grants.map((grant, i) => seedGrant({ id: `pg-${i + 1}`, ...grant }));
    this.seq = [];                                          // SQL 前 3 段，逐序（④ 的顺序断言）
    this.writes = [];                                       // 真正改过库的语句（⑥⑧ 的「零 SQL 写」）
    this.outbox = { route: [], materialize: [] };
    this.routeRev = 0;
    this.matRev = 0;
    this.seqNo = rows.length;
    this.grantSeq = grants.length;
    this.snapshot = null;
    // 测试注入的并发窗口
    this.occupiedOverride = null;   // 覆盖「全局活行端口」的返回（算候选与真插入之间的窗口）
    this.takenFailuresLeft = 0;     // 前 N **笔事务**的 INSERT 直接 23505（⑪ 用）
    this.txBlewUp = false;
    this.doNothingPorts = new Set();// 指定端口命中冲突目标 ⇒ DO NOTHING 吃掉（⑩ 用）
    this.ticketFailAt = 0;          // #247：第 N 张票的 INSERT 直接炸（验证「失败补偿」不留残票）
    this.ticketAttempts = 0;
    // 观测层 MVP（迁移 0022 port_observations）：读端点 DTO 的 `observed` 数据源。
    // 新鲜度窗口（SQL 里的 now() - interval '45 seconds'）fake 无法求值，用 JS 近似同口径过滤。
    this.observations = [];
  }

  clone() {
    return { rows: JSON.parse(JSON.stringify(this.rows)), grants: JSON.parse(JSON.stringify(this.grants)) };
  }

  countTx(label) {
    return this.seq.filter((x) => x === label).length;
  }

  /** 只数「碰端口域那张表的语句」（HTTP 测试里会话取数也会进 seq，所以上面的 seq 不能直接当写次数用）。 */
  portSql() {
    return this.seq.filter((x) => /port_allocations|preview_grants|route_revisions|route_outbox|materialize_/.test(x));
  }

  live(fdeId = null) {
    return this.rows.filter((r) => r.state !== 'released' && (fdeId === null || r.fde_id === fdeId));
  }

  /** 手工改一行 preview_grants（#252 的「fake 真会拦」断言用）：改完必须仍过 baseline CHECK。 */
  setGrant(id, patch) {
    const grant = this.grants.find((g) => g.id === id);
    if (!grant) throw new Error(`fake: 没有 preview_grants 行 ${id}`);
    const violation = previewGrantCheckViolation({ ...grant, ...patch });
    if (violation) throw previewGrantCheckError(grant, violation);
    Object.assign(grant, patch);
    return grant;
  }

  /** 返回 null = 本 fake 不管这条 SQL（HTTP pool 交给 FakePool 继续派发）。 */
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim();
    const head = s.split(' ').slice(0, 3).join(' ');
    this.seq.push(head);

    if (s === 'BEGIN') { this.snapshot = this.clone(); this.txBlewUp = false; return { rows: [] }; }
    if (s === 'COMMIT') { this.snapshot = null; return { rows: [] }; }
    if (s === 'ROLLBACK') {
      if (this.snapshot) { this.rows = this.snapshot.rows; this.grants = this.snapshot.grants; }
      this.snapshot = null;
      return { rows: [] };
    }

    if (s.startsWith('SELECT id, fde_name FROM users')) {
      const u = this.users.find((x) => x.fde_name === params[0]);
      return { rows: u ? [{ id: u.id, fde_name: u.fde_name }] : [] };
    }

    // 列端点的取数（portalloc.listFdePreviewPorts）
    if (s.startsWith('SELECT id, port, hostname, url, state, scope, role, exposure FROM port_allocations')) {
      const rows = this.rows
        .filter((r) => r.fde_id === params[0] && r.state !== 'released')
        .sort((a, b) => a.port - b.port)
        .map(({ id, port, hostname, url, state, scope, role, exposure }) => ({ id, port, hostname, url, state, scope, role, exposure }));
      return { rows, rowCount: rows.length };
    }

    // 观测注解取数（portalloc.listFdePreviewPorts 的旁路查询，只读）：新鲜度窗口按 45s 近似。
    if (s.startsWith('SELECT port, pid, cwd, cmd, branch, proc_started_at, observed_at FROM port_observations')) {
      const freshMs = Date.now() - 45_000;
      const rows = this.observations
        .filter((o) => o.fde_id === params[0] && new Date(o.observed_at).getTime() > freshMs)
        .map(({ port, pid, cwd, cmd, branch, proc_started_at, observed_at }) => ({ port, pid, cwd, cmd, branch, proc_started_at, observed_at }));
      return { rows, rowCount: rows.length };
    }

    // 占用取数（portalloc.listOccupiedPreviewPorts）
    if (s.startsWith('SELECT DISTINCT port FROM port_allocations')) {
      if (this.occupiedOverride) return { rows: this.occupiedOverride.map((port) => ({ port })) };
      const [start, end, fdeId] = params;
      const rows = this.live(fdeId ?? null)
        .filter((r) => r.port >= start && r.port <= end)
        .map((r) => ({ port: r.port }));
      return { rows, rowCount: rows.length };
    }

    // #247 批量签票：目标行解析（归属 / 活行判定在 http 层，fake 只按 SQL 说的做）。
    // 放在「释放旧行 / 撤 grant」之前：下面那两条 UPDATE 分支按前缀匹配，不会误吞本分支的 SELECT。
    if (s.startsWith('SELECT id, fde_id, state, port, hostname FROM port_allocations')) {
      const ids = (params[0] ?? []).map((x) => String(x).toLowerCase());
      const rows = this.rows
        .filter((r) => ids.includes(String(r.id).toLowerCase()))
        .map(({ id, fde_id, state, port, hostname }) => ({ id, fde_id, state, port, hostname }));
      return { rows, rowCount: rows.length };
    }

    // preview.issuePreviewTicket 的单行取数（签发本体复用产品实现，fake 只喂它要的那几列）
    if (s.startsWith('SELECT id, fde_id, state, exposure, hostname, url FROM port_allocations')) {
      const row = this.rows.find((r) => String(r.id).toLowerCase() === String(params[0]).toLowerCase());
      return { rows: row ? [row] : [] };
    }

    // #247 批量签票的失败补偿：按 token_hash 集合收回本批已签的票。
    // **必须排在下面那条「按 allocation_id 撤 grant」之前**——两者前缀相同（`UPDATE preview_grants SET state = `）。
    if (s.startsWith('UPDATE preview_grants SET state = ') && s.includes('token_hash = ANY')) {
      const hashes = new Set(params[0] ?? []);
      const matched = this.grants.filter((g) => hashes.has(g.token_hash) && g.kind === 'ticket' && g.state === 'active');
      const proposed = matched.map((g) => ({ ...g, state: 'revoked', revoked_at: g.revoked_at ?? new Date().toISOString() }));
      for (const row of proposed) {
        const violation = previewGrantCheckViolation(row);
        if (violation) throw previewGrantCheckError(row, violation);
      }
      for (const [index, grant] of matched.entries()) {
        grant.state = proposed[index].state;
        grant.revoked_at = proposed[index].revoked_at;
      }
      this.writes.push(s);
      return { rows: matched.map((g) => ({ id: g.id })), rowCount: matched.length };
    }

    // 释放旧行（照 offboarding.js:217-224 的写法；fake 必须回 RETURNING id）
    if (s.startsWith('UPDATE port_allocations SET state = ') && s.includes('released_at = COALESCE')) {
      this.writes.push(s);
      const fdeId = params[0];
      const rows = this.live(fdeId).map((row) => {
        row.state = 'released';
        row.released_at = row.released_at ?? new Date().toISOString();
        return { id: row.id };
      });
      return { rows, rowCount: rows.length };
    }

    // 撤 grant（口径同实现）：**谓词由 SQL 决定**（fake 不另写一套），命中的每一行都要过 baseline
    // CHECK——任何一条违反 ⇒ **整条语句**抛 23514、零行改动（PG 的语句级原子性）。
    // #252 的根因就是旧 fake 只认 `revoked ⇔ revoked_at`，「顺带把 used 也撤了」在单测里不会红。
    if (s.startsWith('UPDATE preview_grants SET state = ') && s.includes("state = 'revoked'")) {
      const out = applyRevokeGrantsSql({ sql: s, grants: this.grants, allocationIds: params[0] });
      this.writes.push(s);
      return out;
    }

    if (s.startsWith('INSERT INTO preview_grants')) {
      // preview.issuePreviewTicket 的 INSERT（逐列同真库形状；fake 必须真落行，否则「N 张票 = N 行」
      // 与「失败不留残票」两句断言都只是在读测试自己的空气）。
      assert.match(s, /kind, state, expires_at/, '签票 INSERT 的列形状变了？');
      const [tokenHash, userId, issuerId, allocationId, expiresAt, ip, ua] = params;
      if (this.ticketFailAt > 0 && ++this.ticketAttempts >= this.ticketFailAt) {
        throw sqlError('57014', 'canceling statement due to statement timeout');
      }
      const grant = seedGrant({
        id: `pg-${++this.grantSeq}`,
        token_hash: tokenHash,
        user_id: userId,
        issuer_id: issuerId,
        allocation_id: allocationId,
        kind: 'ticket',
        state: 'active',
        expires_at: expiresAt,
        created_ip: ip,
        created_ua: ua,
      });
      this.grants.push(grant);
      this.writes.push(s);
      return { rows: [], rowCount: 1 };
    }

    if (s.startsWith('INSERT INTO port_allocations')) {
      assert.match(s, /ON CONFLICT \(fde_id, port\) WHERE state <> 'released' DO NOTHING/, '冲突目标必须带谓词');
      const [fdeId, scope, port, role, hostname, url, exposure] = params;
      assert.equal(scope, 'fde');
      assert.equal(role, 'spare');
      assert.equal(exposure, 'private');
      if (this.takenFailuresLeft > 0 && !this.txBlewUp) {
        this.takenFailuresLeft -= 1;
        this.txBlewUp = true;
        throw sqlError('23505', 'duplicate key value violates unique constraint "port_allocations_live_global_port_key"');
      }
      if (port < PREVIEW_PORT_POOL_START || port > PREVIEW_PORT_POOL_END) {
        throw sqlError('23514', `new row violates check constraint "port_allocations_port_check": port ${port}`);
      }
      if (this.doNothingPorts.has(port)) { this.writes.push(s); return { rows: [], rowCount: 0 }; }
      const sameFde = this.rows.find((r) => r.fde_id === fdeId && r.port === port && r.state !== 'released');
      if (sameFde) return { rows: [], rowCount: 0 };
      const foreign = this.rows.find((r) => r.port === port && r.state !== 'released');
      if (foreign) throw sqlError('23505', `duplicate key value violates unique constraint "port_allocations_live_global_port_key": port ${port}`);
      const row = {
        id: `pa-${++this.seqNo}`, fde_id: fdeId, scope, port, role, hostname, url, exposure,
        state: 'allocated', run_id: null, released_at: null,
      };
      this.rows.push(row);
      this.writes.push(s);
      return { rows: [{ id: row.id, port }], rowCount: 1 };
    }

    if (s.includes('INSERT INTO route_revisions')) {
      this.outbox.route.push({ aggregate: params[0], aggregateId: params[1], revision: ++this.routeRev });
      return { rows: [{ revision: this.routeRev }] };
    }
    if (s.includes('INSERT INTO route_outbox')) {
      this.outbox.route.at(-1).op = params[2];
      this.outbox.route.at(-1).payload = JSON.parse(params[4]);
      return { rows: [] };
    }
    if (s.includes('INSERT INTO materialize_revisions')) {
      this.outbox.materialize.push({ fdeId: params[0], revision: ++this.matRev });
      return { rows: [{ revision: this.matRev }] };
    }
    if (s.includes('INSERT INTO materialize_outbox')) {
      this.outbox.materialize.at(-1).op = params[1];
      this.outbox.materialize.at(-1).payload = JSON.parse(params[3]);
      return { rows: [] };
    }
    return null;
  }

  client() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  pool() {
    const store = this;
    return {
      async connect() { return store.client(); },
      async query(sql, params) { return (await store.query(sql, params)) ?? { rows: [] }; },
    };
  }
}

/** 一条活行（hostname/url 与 projects.buildHostname 的产物同形，读侧断言要用）。 */
function liveRow(fdeName, fdeId, port, over = {}) {
  const hostname = `${fdeName}-p-${port}.${BASE}`;
  return {
    fde_id: fdeId, scope: 'fde', port, role: 'spare', hostname,
    url: previewUrl(hostname, { publicBaseUrl: PUBLIC_BASE }),
    exposure: 'private', state: 'allocated', ...over,
  };
}

function aliceSeed(extraRows = [], extraGrants = []) {
  return new PortsStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }, { id: 'u-bob', fde_name: 'bob' }],
    rows: [...FIRST_BLOCK.map((port) => liveRow('alice', 'u-alice', port)), ...extraRows],
    grants: extraGrants,
  });
}

// ---------------------------------------------------------------------------
// ③⑤⑧⑨⑩ 搬迁事务（portalloc.moveFdePreviewBlock）
// ---------------------------------------------------------------------------
test('③ 搬迁成功：旧 10 行全 released（released_at 非空）、其活凭证全 revoked、新 10 行 hostname/url 与新端口一致、两条派生链各入队', async () => {
  const usedAt = new Date('2026-09-30T10:00:00Z').toISOString();
  const store = aliceSeed([], [
    { id: 'pg-1', allocation_id: 'pa-1', state: 'active' },
    // 已消费的 ticket（used_at 非空）：#252 前会被一起抓进 revoked 而撞 preview_grants_check3。
    { id: 'pg-2', allocation_id: 'pa-2', state: 'used', used_at: usedAt },
    // 它派生的 session 仍活 ⇒ 这才是「本次要抓的东西」（portal.md §2.8）。
    { id: 'pg-5', allocation_id: 'pa-2', kind: 'session', state: 'active', parent_ticket_id: 'pg-2' },
    { id: 'pg-3', allocation_id: 'pa-3', state: 'expired' },   // 不打扰（口径同 offboarding）
    { id: 'pg-4', allocation_id: 'pa-4', state: 'revoked', revoked_at: new Date('2026-10-01T00:00:00Z').toISOString() },
  ]);
  const out = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });

  assert.equal(out.changed, true);
  assert.equal(out.blockStart, 22010);
  assert.equal(out.blockEnd, 22019);
  assert.deepEqual(out.ports, SECOND_BLOCK);
  assert.equal(out.releasedAllocations, PREVIEW_PORT_COUNT);
  assert.equal(out.revokedGrants, 2, '只撤 active（#252 口径：used 是历史事实、expired/revoked 本就不授予访问）');
  assert.equal(out.inserted, PREVIEW_PORT_COUNT);
  assert.equal(out.materializeRevision, 1);
  assert.deepEqual(out.routeRevisions, Array.from({ length: PREVIEW_PORT_COUNT }, (_, i) => i + 1));

  const oldRows = store.rows.filter((r) => FIRST_BLOCK.includes(r.port) && r.fde_id === 'u-alice');
  assert.equal(oldRows.length, PREVIEW_PORT_COUNT);
  for (const row of oldRows) {
    assert.equal(row.state, 'released', '旧行必须 released（否则 20 条活行、旧域名仍可访问）');
    assert.ok(row.released_at, 'released_at 必须非空（CHECK ((state=\'released\') = (released_at IS NOT NULL))）');
  }
  for (const id of ['pg-1', 'pg-5']) {
    const grant = store.grants.find((g) => g.id === id);
    assert.equal(grant.state, 'revoked', `${id}（active）必须被抓`);
    assert.ok(grant.revoked_at, 'revoked 必带 revoked_at（CHECK ((state=\'revoked\') = (revoked_at IS NOT NULL))）');
  }
  const usedTicket = store.grants.find((g) => g.id === 'pg-2');
  assert.equal(usedTicket.state, 'used', '#252：used ticket 保持原状——它已不再授予访问，拓 revoked 必撞双向 CHECK');
  assert.equal(usedTicket.used_at, usedAt, 'used_at 是历史事实，不得被清成 NULL');
  assert.equal(store.grants.find((g) => g.id === 'pg-3').state, 'expired', 'expired grant 不动');
  assert.equal(store.grants.find((g) => g.id === 'pg-4').revoked_at.startsWith('2026-10-01'), true, 'COALESCE 不覆盖既有 revoked_at');

  const newRows = store.live('u-alice');
  assert.equal(newRows.length, PREVIEW_PORT_COUNT, '活行总数仍是一块（不是 20）');
  assert.deepEqual(newRows.map((r) => r.port), SECOND_BLOCK);
  for (const row of newRows) {
    assert.equal(row.hostname, `alice-p-${row.port}.${BASE}`, 'hostname 跟着新端口走');
    assert.equal(row.url, previewUrl(row.hostname, { publicBaseUrl: PUBLIC_BASE }), 'url 与新 hostname 同源');
    assert.equal(row.scope, 'fde');
    assert.equal(row.role, 'spare');
    assert.equal(row.exposure, 'private');
    assert.equal(row.state, 'allocated');
  }

  assert.equal(store.outbox.route.length, PREVIEW_PORT_COUNT, '派生链①：每条新 allocation 一条 route outbox');
  assert.deepEqual(store.outbox.route.map((r) => r.aggregate), Array(PREVIEW_PORT_COUNT).fill('port_allocation'));
  assert.deepEqual(store.outbox.route.map((r) => r.op), Array(PREVIEW_PORT_COUNT).fill('upsert'));
  assert.deepEqual(store.outbox.route.map((r) => r.aggregateId), newRows.map((r) => r.id));
  assert.deepEqual(store.outbox.route[0].payload, { fde_name: 'alice', hostname: 'alice-p-22010.fde.erix.vip', port: 22010, scope: 'fde' });
  assert.equal(store.outbox.materialize.length, 1, '派生链②：materialize 聚合每 FDE 一条');
  assert.equal(store.outbox.materialize[0].fdeId, 'u-alice');
  assert.deepEqual(store.outbox.materialize[0].payload.ports, SECOND_BLOCK);
});

test('④ 搬迁事务顺序：BEGIN < 旧行 UPDATE < grant UPDATE < INSERT×10 < route_revisions < route_outbox < materialize_revisions < materialize_outbox < COMMIT', async () => {
  const store = aliceSeed([], [{ allocation_id: 'pa-1', state: 'active' }]);
  await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  assert.deepEqual(store.seq, [
    'BEGIN',
    'SELECT DISTINCT port',
    'SELECT DISTINCT port',
    'UPDATE port_allocations SET',
    'UPDATE preview_grants SET',
    ...Array.from({ length: PREVIEW_PORT_COUNT }, () => 'INSERT INTO port_allocations'),
    ...Array.from({ length: PREVIEW_PORT_COUNT }, () => ['INSERT INTO route_revisions', 'INSERT INTO route_outbox']).flat(),
    'INSERT INTO materialize_revisions',
    'INSERT INTO materialize_outbox',
    'COMMIT',
  ], '事务内语句必须逐条同序（route 先、materialize 后；派生链在 COMMIT 之前）');
});

test('④ 旧行被释放但未命中任何 grant：撤权语句**无条件照发**（#252：不再挂在「本次释放了行」上）、命中 0 行、不报错', async () => {
  const store = aliceSeed();
  const out = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  assert.equal(out.revokedGrants, 0, '撤 0 行本来就是成功（不是跳过、也不是错）');
  assert.equal(store.seq.filter((x) => x.startsWith('UPDATE preview_grants')).length, 1);
  assert.equal(store.outbox.materialize.length, 1);
  const releaseIdx = store.seq.findIndex((x) => x.startsWith('UPDATE port_allocations'));
  const grantIdx = store.seq.findIndex((x) => x.startsWith('UPDATE preview_grants'));
  const insertIdx = store.seq.findIndex((x) => x.startsWith('INSERT INTO port_allocations'));
  assert.ok(releaseIdx > 0 && releaseIdx < grantIdx && grantIdx < insertIdx, '旧行 UPDATE < grant UPDATE < INSERT');
});

// ---------------------------------------------------------------------------
// #252（issue #252 / 工单 fix-261011-B）：撤预览 grant 只撤 `active`，且 fake 必须**真**模拟双向 CHECK
// ---------------------------------------------------------------------------

/** 抽出源文件里每一条 `UPDATE preview_grants …` 的**模板字符串**（要求以反引号开头，否则会误抽文档注释里的伪 SQL）。 */
function grantStatementsFrom(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/`UPDATE preview_grants[\s\S]*?`/g)].map((m) => m[0].slice(1, -1));
}

test('#252① 撤权只碰 active：used ticket 原样保留（used_at 不动）、同批 active session 被撤、整笔搬迁不报错', async () => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const store = aliceSeed([], [
    { id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt },          // ticket|used（真机 45 条那一类）
    { id: 'pg-2', allocation_id: 'pa-1', kind: 'session', state: 'active', parent_ticket_id: 'pg-1' }, // session|active
  ]);
  const out = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  assert.equal(out.revokedGrants, 1, '只抓那条 active session（used ticket 不算「还在授予访问」）');
  assert.equal(store.grants.find((g) => g.id === 'pg-1').state, 'used');
  assert.equal(store.grants.find((g) => g.id === 'pg-1').used_at, usedAt, 'used_at 是历史事实，不得被动');
  assert.equal(store.grants.find((g) => g.id === 'pg-1').revoked_at, null, 'used ticket 没被改过');
  assert.equal(store.grants.find((g) => g.id === 'pg-2').state, 'revoked');
  assert.ok(store.grants.find((g) => g.id === 'pg-2').revoked_at);
  assert.equal(store.countTx('COMMIT'), 1, '不撞 CHECK ⇒ 本笔搬迁正常提交（真机就是在这里 500 回滚的）');
});

test('#252② 谓词源码断言：三处撤权 SQL 只出现 active，不再出现 \'used\'、不清 used_at', () => {
  const targets = [
    ['撤权（offboarding release-network-routes）', new URL('../src/offboarding.js', import.meta.url)],
    ['撤权（portalloc moveFdePreviewBlock）', new URL('../src/portalloc.js', import.meta.url)],
    // 工单只点了两处，但 admin 的「停用用户」路径是**同一条口径**的第三处（旧写法正是工单禁的
    // 「顺手清 used_at」），一并钉住，否则文档与代码会打架。
    ['撤权（admin 停用用户 / 写 admin.user_offboarding_started）', new URL('../src/admin.js', import.meta.url)],
  ];
  for (const [label, file] of targets) {
    const statements = grantStatementsFrom(file);
    assert.ok(statements.length >= 1, `${label}：找不到 UPDATE preview_grants 语句（被删了？）`);
    for (const sql of statements) {
      assert.match(sql, /state = 'active'/, `${label}：撤权谓词必须是 state = 'active'`);
      assert.doesNotMatch(sql, /'used'/, `${label}：撤权谓词里不得出现 'used'（#252 口径：used 是历史事实）`);
      assert.doesNotMatch(sql, /used_at\s*=\s*NULL/, `${label}：不得靠清 used_at 把 used 塞进 revoked（篡改历史）`);
      assert.match(sql, /revoked_at = COALESCE\(revoked_at, now\(\)\)/, `${label}：revoked ⇔ revoked_at 要靠 COALESCE 满足`);
    }
  }
  // 「静默跳过」的守卫也钉住：offboarding 里不得再出现 `if (allocations.rows.length > 0)` 这种括在撤权外的条件。
  const offboarding = fs.readFileSync(targets[0][1], 'utf8');
  assert.doesNotMatch(offboarding, /if \(allocations\.rows\.length > 0\)/,
    '#252：撤权不得再挂在「本次真的释放了行」上（重试路径会静默跳过）');
});

test('#252⑤ fake 的双向 CHECK 断言：手工把 used ticket 改 revoked ⇒ 像真库一样语句级抛 23514（不是摆设）', async () => {
  const usedAt = new Date('2026-10-10T09:00:00Z').toISOString();
  const store = aliceSeed([], [
    { id: 'pg-1', allocation_id: 'pa-1', state: 'used', used_at: usedAt },
    { id: 'pg-2', allocation_id: 'pa-2', state: 'active' },
  ]);
  // 旧写法（#252 的谓词）：把 used 一起塞进 revoked ⇒ 真库报 preview_grants_check3。
  const oldPredicate = `UPDATE preview_grants
                           SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
                         WHERE allocation_id = ANY($1::uuid[]) AND state IN ('active', 'used')
                     RETURNING id`;
  await assert.rejects(
    () => store.query(oldPredicate, [['pa-1', 'pa-2']]),
    (err) => {
      assert.equal(err.code, '23514', '必须是 check_violation 的 SQLSTATE，调用方才走同一条错误路径');
      assert.match(err.message, /violates check constraint "preview_grants_check3"/, 'constraint 名要与真机一致');
      assert.match(err.message, /new row for relation "preview_grants"/);
      return true;
    },
  );
  assert.equal(store.grants.find((g) => g.id === 'pg-1').state, 'used', '语句级失败 = 一行都没改');
  assert.equal(store.grants.find((g) => g.id === 'pg-2').state, 'active', '同语句里本来合法的那条也不得落盘');
  assert.deepEqual(store.writes.filter((x) => x.startsWith('UPDATE preview_grants')), [], '失败的语句不算写过库');

  // 同一张表上「只撤 active」必须照旧成功——证明 fake 不是「凡 UPDATE 都抛」。
  const fixed = `UPDATE preview_grants
                    SET state = 'revoked', revoked_at = COALESCE(revoked_at, now())
                  WHERE allocation_id = ANY($1::uuid[]) AND state = 'active'
              RETURNING id`;
  const out = await store.query(fixed, [['pa-1', 'pa-2']]);
  assert.deepEqual(out.rows, [{ id: 'pg-2' }]);
  assert.equal(store.grants.find((g) => g.id === 'pg-2').state, 'revoked');
  assert.equal(store.grants.find((g) => g.id === 'pg-1').state, 'used');

  // 「把 used 塞进 revoked 顺手清 used_at」能过 CHECK（假能改），但它是篡改历史 ⇒ 口径上禁，fake 也拦。
  await assert.rejects(
    () => store.query(`UPDATE preview_grants SET state = 'revoked', revoked_at = COALESCE(revoked_at, now()), used_at = NULL
                        WHERE allocation_id = ANY($1::uuid[]) AND state IN ('active', 'used')`, [['pa-1']]),
    /used_at/,
  );

  // fake 的种子也过 CHECK：造一个「used 但没有 used_at」的种子要当场炸（否则测的是真库不存在的状态）。
  assert.throws(() => aliceSeed([], [{ allocation_id: 'pa-1', state: 'used' }]), /baseline CHECK/);
  // `setGrant` 同样拦得住（测试自己也不许造非法状态）。
  const guard = aliceSeed([], [{ id: 'pg-9', allocation_id: 'pa-1', state: 'active' }]);
  assert.throws(() => guard.setGrant('pg-9', { state: 'revoked' }), /preview_grants_check4/);
  assert.equal(previewGrantCheckViolation({ kind: 'session', state: 'active', parent_ticket_id: null }).name,
    'preview_grants_check2', '不只 used 那一条：kind/父票相关的三条 CHECK 也在同一份规则里');
  assert.equal(previewGrantCheckViolation({ kind: 'session', state: 'active', parent_ticket_id: 'pg-1', used_at: new Date().toISOString() })?.name,
    'preview_grants_check', 'session 永不可 used（baseline 第一条 CHECK）');
});

test('⑤ 搬迁冲突（块内有外来活行）→ preview_port_block_taken，且零残留（旧行没被释放、无新行、两条 outbox 都没有新行）', async () => {
  const store = aliceSeed([liveRow('bob', 'u-bob', 22014)]);
  const before = store.clone();
  await assert.rejects(
    () => moveFdePreviewBlock(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
    }),
    (err) => {
      assert.equal(err.code, 'preview_port_block_taken');
      assert.match(err.message, /22010-22019/, '文案要指名是哪一段被占');
      assert.match(err.message, /22014/, '文案要给出**是哪个号**被外来行占着（可操作）');
      assert.match(err.message, /外来活行/);
      assert.match(err.message, /对齐起点/, '要给出下一步动作（换一个整块空闲起点）');
      return true;
    },
  );
  assert.equal(store.countTx('COMMIT'), 0, '必须回滚，不得提交');
  assert.equal(store.countTx('ROLLBACK'), 1);
  assert.equal(store.rows.find((r) => r.port === 22000).state, 'allocated', '旧行仍活（没有被释放）');
  assert.deepEqual(store.clone(), before, '零残留：整张表与调用前逐字段一致');
  assert.deepEqual(store.outbox.route, [], '零残留：route outbox 无新行');
  assert.deepEqual(store.outbox.materialize, [], '零残留：materialize outbox 无新行');
  assert.equal(store.rows.length, before.rows.length);
});

test('⑤ 冲突判据只看**外来**活行：本 FDE 自己的活行不算冲突（块内自己的号随后被释放）', async () => {
  // alice 的活行散落在目标块内（历史手工插行）：目标块 22010 里 22010 是 alice 自己的号。
  const store = new PortsStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }],
    rows: [liveRow('alice', 'u-alice', 22010), liveRow('alice', 'u-alice', 22017)],
  });
  const out = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  assert.equal(out.changed, true, '部分行不算「已经是这一块」，走完整搬迁顺手补齐');
  assert.equal(out.releasedAllocations, 2);
  assert.equal(store.live('u-alice').length, PREVIEW_PORT_COUNT, '补齐后仍是一块（旧的两条已 released）');
});

test('⑧ 幂等：目标块 == 当前块 → changed:false 且零 SQL 写（没有 UPDATE/INSERT、不入队、不写库）', async () => {
  const store = aliceSeed();
  const out = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: FIRST_BLOCK[0], log: LOG,
  });
  assert.equal(out.changed, false);
  assert.equal(out.blockStart, 22000);
  assert.equal(out.blockEnd, 22009);
  assert.deepEqual(out.ports, FIRST_BLOCK);
  assert.equal(out.releasedAllocations, 0);
  assert.equal(out.inserted, 0);
  assert.equal(out.materializeRevision, null);
  assert.deepEqual(store.writes, [], '零 SQL 写：不得有任何 UPDATE/INSERT');
  assert.deepEqual(store.outbox.route, [], '零入队');
  assert.deepEqual(store.outbox.materialize, [], '零入队');
  assert.equal(store.seq.filter((x) => x.startsWith('UPDATE')).length, 0);
  assert.equal(store.seq.filter((x) => x.startsWith('INSERT')).length, 0);
  assert.equal(store.countTx('COMMIT'), 1, '幂等路径也要正常收尾（BEGIN + 两条占用取数 + COMMIT）');
  assert.deepEqual(store.seq, ['BEGIN', 'SELECT DISTINCT port', 'SELECT DISTINCT port', 'COMMIT']);
  assert.equal(store.rows.length, PREVIEW_PORT_COUNT, '总行数不变');
});

test('⑨ 号码回收：搬出去再搬回**同一块**要成功（released 行不占位）', async () => {
  const store = aliceSeed();
  const out1 = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  const out2 = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: FIRST_BLOCK[0], log: LOG,
  });
  assert.equal(out1.blockStart, 22010);
  assert.equal(out2.changed, true, '搬回 22000 必须成功：那 10 个号只是 released，不占位');
  assert.deepEqual(store.live('u-alice').map((r) => r.port), FIRST_BLOCK);
  assert.equal(store.rows.filter((r) => r.state === 'released').length, PREVIEW_PORT_COUNT * 2, '两次搬迁的旧行都留档');
  // 第三次再搬回 22010：仍然成功（可反复回收，reaper 之前 released 行只是留档）
  const out3 = await moveFdePreviewBlock(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
  });
  assert.equal(out3.changed, true);
});

test('⑩ 插入数 ≠ 10（并发抢号被 DO NOTHING 吃掉一条）→ 整笔回滚，不部分提交', async () => {
  const store = aliceSeed();
  store.doNothingPorts = new Set([22015]);
  const before = store.clone();
  await assert.rejects(
    () => moveFdePreviewBlock(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: LOG,
    }),
    (err) => {
      assert.equal(err.code, 'preview_port_block_taken');
      assert.match(err.message, /只插入 9\/10/, '文案要说清是「插入数不足」这条判据触发的');
      assert.match(err.message, /回滚/);
      return true;
    },
  );
  assert.equal(store.countTx('COMMIT'), 0, '不许部分提交');
  assert.equal(store.countTx('ROLLBACK'), 1);
  assert.deepEqual(store.clone(), before, '回滚后旧行仍活、新行一条不剩');
  assert.equal(store.outbox.route.length, 9, '入队确实发生过（同事务内），但事务未提交 ⇒ 外部看不见');
  assert.deepEqual(store.live('u-alice').map((r) => r.port), FIRST_BLOCK);
});

test('搬迁的 400 类校验前置到开事务之前：块非法 / 名超预算都**零 SQL**（不 BEGIN、不取连接）', async () => {
  const store = aliceSeed();
  await assert.rejects(
    () => moveFdePreviewBlock(store.pool(), CONFIG, { fdeId: 'u-alice', fdeName: 'alice', blockStart: 22005, log: LOG }),
    (err) => err.code === 'preview_port_block_invalid',
  );
  await assert.rejects(
    () => moveFdePreviewBlock(store.pool(), CONFIG, { fdeId: 'u-alice', fdeName: 'alice', blockStart: '22010', log: LOG }),
    (err) => err.code === 'preview_port_block_invalid',
  );
  await assert.rejects(
    () => moveFdePreviewBlock(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'a'.repeat(56), base: BASE, blockStart: SECOND_BLOCK[0], log: LOG,
    }),
    (err) => err.code === 'preview_hostname_invalid' && /55/.test(err.message),
  );
  assert.deepEqual(store.seq, [], '校验不过连 BEGIN 都不该发（400 路径零 SQL）');
});

// ---------------------------------------------------------------------------
// ⑪⑫ 自动选块的冲突重算（portalloc.provisionFdePreviewPorts）
// ---------------------------------------------------------------------------
test('⑪ 未指定 blockStart：前 2 次抢号失败、第 3 次成功（上限 3 次，含首试）', async () => {
  const store = new PortsStore({ users: [{ id: 'u-alice', fde_name: 'alice' }] });
  store.takenFailuresLeft = 2;
  const warns = [];
  const out = await provisionFdePreviewPorts(store.pool(), CONFIG, {
    fdeId: 'u-alice', fdeName: 'alice', log: { log() {}, warn: (m) => warns.push(m) },
  });
  assert.equal(store.countTx('BEGIN'), 3, '首试 + 两次重算 = 3 笔事务');
  assert.equal(store.countTx('ROLLBACK'), 2);
  assert.equal(store.countTx('COMMIT'), 1);
  assert.deepEqual(out.inserted.map((r) => r.port), FIRST_BLOCK);
  assert.equal(warns.length, 2, '每次重算都要在日志里看得见（重试只覆盖端口分配这一小段）');
  assert.match(warns[0], /第 1\/3 次抢号冲突/);
});

test('⑪ 连 3 次冲突 → 抛 preview_port_block_taken 且**第 4 次不再试**（文案可操作）', async () => {
  const store = new PortsStore({ users: [{ id: 'u-alice', fde_name: 'alice' }] });
  store.takenFailuresLeft = 99;
  await assert.rejects(
    () => provisionFdePreviewPorts(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'alice', log: { log() {}, warn() {} },
    }),
    (err) => {
      assert.equal(err.code, 'preview_port_block_taken', '用尽后仍是同一可操作错误码');
      assert.match(err.message, /已尝试 3 次 = 首试 \+ 自动重算 2 次/);
      assert.match(err.message, /\/api\/admin\/fdes\/:fdeName\/ports\/block/, '兜底动作要指给管理员改块');
      return true;
    },
  );
  assert.equal(PREVIEW_BLOCK_MAX_ATTEMPTS, 3);
  assert.equal(store.countTx('BEGIN'), 3, '第 4 次不得再试');
  assert.equal(store.countTx('COMMIT'), 0);
  assert.equal(store.rows.length, 0, '三次都回滚 ⇒ 一条不留');
});

test('⑫ 显式指定 blockStart：冲突时**不重算**（只尝试一次，原样冒错）', async () => {
  const store = new PortsStore({ users: [{ id: 'u-alice', fde_name: 'alice' }] });
  store.takenFailuresLeft = 99;
  await assert.rejects(
    () => provisionFdePreviewPorts(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'alice', blockStart: SECOND_BLOCK[0], log: { log() {}, warn() {} },
    }),
    (err) => {
      assert.equal(err.code, 'preview_port_block_taken');
      assert.equal(err.cause?.code, '23505', '原始 23505 留在 cause 里');
      assert.doesNotMatch(err.message, /已尝试/, '未走重算路径 ⇒ 不加「已尝试 N 次」的尾巴');
      return true;
    },
  );
  assert.equal(store.countTx('BEGIN'), 1, '显式块起点 ⇒ 一次都不重算（管理员指定的段被占就是要人看一眼）');
});

test('⑪ 非「抢号」类错误不重算（号池耗尽只试一次）', async () => {
  // 800 段 × 10 个全被**另一个 FDE** 的活行占满 ⇒ choosePreviewBlockStart 抛 preview_port_pool_exhausted。
  const everyone = Array.from({ length: 8000 }, (_, i) => liveRow('everyone', 'u-all', PREVIEW_PORT_POOL_START + i));
  const store = new PortsStore({ users: [{ id: 'u-alice', fde_name: 'alice' }], rows: everyone });
  await assert.rejects(
    () => provisionFdePreviewPorts(store.pool(), CONFIG, {
      fdeId: 'u-alice', fdeName: 'alice', log: { log() {}, warn() {} },
    }),
    (err) => err.code === 'preview_port_pool_exhausted',
  );
  assert.equal(store.countTx('BEGIN'), 1, '重试只针对 preview_port_block_taken');
});

// ---------------------------------------------------------------------------
// 读端点：portalloc.listFdePreviewPorts / resolveFdeByName（纯取数口径）
// ---------------------------------------------------------------------------
test('listFdePreviewPorts：只列活行、port ASC、DTO 含 id（签票端点吃 UUID）', async () => {
  const store = aliceSeed([
    liveRow('alice', 'u-alice', PREVIEW_PORT_POOL_START + 12),
    liveRow('alice', 'u-alice', PREVIEW_PORT_POOL_START + 13, { state: 'released', released_at: new Date().toISOString() }),
    liveRow('bob', 'u-bob', PREVIEW_PORT_POOL_START + 1),
  ]);
  const items = await listFdePreviewPorts(store.pool(), { fdeId: 'u-alice' });
  assert.deepEqual(items.map((i) => i.port), [22000, 22001, 22002, 22003, 22004, 22005, 22006, 22007, 22008, 22009, 22012]);
  assert.deepEqual(
    [...items].map((i) => i.port),
    [...items].map((i) => i.port).sort((a, b) => a - b),
    'port ASC',
  );
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['exposure', 'hostname', 'id', 'observed', 'port', 'role', 'scope', 'state', 'url']);
    assert.equal(item.observed, null, '无观测行时 observed 恒 null（无观测 ≠ 无进程，旧 agentd/未跑 0022 同样形状）');
    assert.ok(item.id, 'id 必给——没有它本单白做（POST /api/ports/:id/preview-ticket 要 UUID）');
    assert.match(item.hostname, /^alice-p-\d+\.fde\.erix\.vip$/);
    assert.equal(item.url, previewUrl(item.hostname, { publicBaseUrl: PUBLIC_BASE }));
    assert.notEqual(item.state, 'released');
    assert.equal(item.scope, 'fde');
    assert.equal(item.role, 'spare');
    assert.equal(item.exposure, 'private');
  }
  await assert.rejects(() => listFdePreviewPorts(store.pool(), { fdeId: null }), /fdeId required/);
});

// 观测层 MVP（迁移 0022）：列端点 DTO 附 `observed`（同端口新鲜观测行），陈旧观测不附。
test('listFdePreviewPorts：observed 只附新鲜观测行；陈旧（>45s 窗口）/他人/池外端口的观测都不附', async () => {
  const store = aliceSeed();
  const fresh = new Date().toISOString();
  const stale = new Date(Date.now() - 46_000).toISOString();
  store.observations.push(
    { fde_id: 'u-alice', port: 22001, pid: 412, cwd: '~/projects/shop', cmd: 'node vite', branch: 'feat-x', proc_started_at: fresh, observed_at: fresh },
    { fde_id: 'u-alice', port: 22002, pid: 9, cwd: null, cmd: null, branch: null, proc_started_at: null, observed_at: stale },
    { fde_id: 'u-bob', port: 22003, pid: 1, cwd: '~/projects/other', cmd: 'x', branch: null, proc_started_at: fresh, observed_at: fresh },
  );
  const items = await listFdePreviewPorts(store.pool(), { fdeId: 'u-alice' });
  const byPort = new Map(items.map((i) => [i.port, i]));
  assert.deepEqual(byPort.get(22001).observed, {
    pid: 412, cwd: '~/projects/shop', cmd: 'node vite', branch: 'feat-x', started_at: fresh, observed_at: fresh,
  }, '新鲜观测逐字段附到对应端口（started_at/observed_at 改名后的 DTO 形）');
  assert.equal(byPort.get(22002).observed, null, '超出新鲜度窗口的观测不附（僵尸注解自动消失的读侧一半）');
  assert.equal(byPort.get(22003).observed, null, '别人的观测不混进本 FDE');
});

test('listFdePreviewPorts：观测表读失败（旧部署无表）⇒ 降级为全 null，列表照常', async () => {
  const store = aliceSeed();
  const pool = store.pool();
  const orig = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (/port_observations/.test(sql)) { const err = new Error('no such table'); err.code = '42P01'; throw err; }
    return orig(sql, params);
  };
  const items = await listFdePreviewPorts(pool, { fdeId: 'u-alice' });
  assert.equal(items.length, PREVIEW_PORT_COUNT);
  for (const item of items) assert.equal(item.observed, null);
});

test('resolveFdeByName：命中回 {id, fde_name}，未知回 null（HTTP 层据此给 404 not_found）', async () => {
  const store = aliceSeed();
  assert.deepEqual(await resolveFdeByName(store.pool(), 'alice'), { id: 'u-alice', fde_name: 'alice' });
  assert.equal(await resolveFdeByName(store.pool(), 'nobody'), null);
});

// ---------------------------------------------------------------------------
// HTTP 层（①②⑥⑦ + 409/200 的线上形态）
// ---------------------------------------------------------------------------
const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const ALICE = {
  id: 'u-alice', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const BOB = {
  id: 'u-bob', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
};
// 56 字符的 FDE 名：过 FDE_NAME_RE（≤63）但超预览域名预算 55（#246）⇒ ⑦ 的靶子。
const LONG_FDE = {
  id: 'u-longfde', login: 'looooong', display_name: 'Long',
  role: 'fde', fde_name: 'a'.repeat(56), auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-ports-admin';
const ALICE_TOKEN = 'tok-ports-alice';

class PortsHttpPool extends FakePool {
  constructor({ users, store }) {
    super({ users: users.map((u) => ({ ...u })) });
    this.store = store;
    this.sqlLog = [];
    store.users.push({ id: ADMIN.id, fde_name: null });
    for (const u of users) if (u.fde_name) store.users.push({ id: u.id, fde_name: u.fde_name });
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessions.push({
      id: 'ls-alice', user_id: ALICE.id, token_hash: auth.hashToken(ALICE_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
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

async function startPortsServer({ store, users = [ADMIN, ALICE, BOB, LONG_FDE], rateLimit = null } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-ports-static-'));
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
    // #247 批量签票：TTL 与限流必须显式给（前者缺了 `expires_at` 会算成 Invalid Date，
    // 后者是「一次点击 = N 张票，放大倍数计入配额」那条断言的旋钮）。
    previewTicketTtlSeconds: 60,
    ...(rateLimit ? { previewTicketRateLimit: rateLimit } : {}),
  };
  const pool = new PortsHttpPool({ users, store });
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

test('① GET /api/me/ports：只返回自己的活行、含 id、port ASC；admin 无 FDE → 空数组（不是 404）；未登录 401', async () => {
  const store = aliceSeed([liveRow('bob', 'u-bob', 22020)]);
  const { base, adminCookie, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await fetch(`${base}/api/me/ports`, { headers: { cookie: aliceCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['items'], '信封照既有列表端点 {items:[...]}');
    assert.equal(body.items.length, PREVIEW_PORT_COUNT);
    assert.deepEqual(body.items.map((i) => i.port), FIRST_BLOCK, 'port ASC，且不含别人的行');
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['exposure', 'hostname', 'id', 'observed', 'port', 'role', 'scope', 'state', 'url']);
      assert.match(item.id, /.*/, 'id 必给（前端签票用）');
    }
    assert.equal(pool.audit.length, 0, '本人读自己的端口不写 admin 审计');

    const adminRes = await fetch(`${base}/api/me/ports`, { headers: { cookie: adminCookie } });
    assert.equal(adminRes.status, 200, 'admin 自己通常没有 FDE ⇒ 200 + 空列表');
    assert.deepEqual(await adminRes.json(), { items: [] });

    const anon = await fetch(`${base}/api/me/ports`);
    assert.equal(anon.status, 401, '未登录走既有 401 口径');
    assert.equal((await anon.json()).error.code, 'unauthorized');

    const other = await fetch(`${base}/api/me/ports`, { headers: { cookie: 'nonsense=1' } });
    assert.equal(other.status, 401);
  } finally {
    await close();
  }
});

test('② GET /api/admin/fdes/:fdeName/ports：admin 可读 + **审计恰好一行**；非 admin 403；未知 FDE 404；非法名 400', async () => {
  const store = aliceSeed();
  const { base, adminCookie, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/fdes/alice/ports`, { headers: { cookie: adminCookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.items.map((i) => i.port), FIRST_BLOCK);

    assert.equal(store.outbox.route.length, 0, '读端点不得写派生链');
    assert.equal(store.writes.length, 0, '读端点零写库');
    const listed = pool.audit.filter((e) => e.action === 'admin.fde_ports_listed');
    assert.equal(listed.length, 1, '审计**恰好一行**（读他人资源要留痕；多写也算失败）');
    assert.equal(listed[0].actor_id, ADMIN.id, 'actor = admin');
    assert.equal(listed[0].target, 'alice', 'target = 被读的 FDE');
    assert.equal(JSON.parse(listed[0].details).item_count, PREVIEW_PORT_COUNT);
    assert.equal(pool.audit.length, 1, '整个请求只产生这一行审计');
    await fetch(`${base}/api/admin/fdes/alice/ports`, { headers: { cookie: adminCookie } });
    assert.equal(pool.audit.length, 2, '第二次读不多不少再多一行');

    const forbidden = await fetch(`${base}/api/admin/fdes/alice/ports`, { headers: { cookie: aliceCookie } });
    assert.equal(forbidden.status, 403);
    assert.equal((await forbidden.json()).error.code, 'forbidden');
    assert.equal(pool.audit.length, 2, '403 不写审计');

    const missing = await fetch(`${base}/api/admin/fdes/nobody/ports`, { headers: { cookie: adminCookie } });
    assert.equal(missing.status, 404, '未知 fdeName → 404');
    assert.equal((await missing.json()).error.code, 'not_found', '复用 admin 面现有错误码，不新造');

    const bad = await fetch(`${base}/api/admin/fdes/Bad%20Name/ports`, { headers: { cookie: adminCookie } });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'validation_failed');

    const wrongMethod = await fetch(`${base}/api/admin/fdes/alice/ports`, {
      method: 'DELETE', headers: { cookie: adminCookie },
    });
    assert.equal(wrongMethod.status, 405);
  } finally {
    await close();
  }
});

test('⑥ POST …/ports/block：池外 / 非对齐 / 非整数 → 400 validation_failed（三种各一例，且零 SQL 写）', async () => {
  const cases = [
    [PREVIEW_PORT_POOL_START - 10, '池外起点'],
    [PREVIEW_PORT_POOL_END, '池内但整块越界'],
    [22005, '非 10 对齐'],
    ['22010', '字符串（非整数）'],
    [22010.5, '小数（非整数）'],
    [null, '缺字段'],
  ];
  const store = aliceSeed();
  const { base, adminCookie, pool, close } = await startPortsServer({ store });
  try {
    for (const [value, label] of cases) {
      const res = await fetch(`${base}/api/admin/fdes/alice/ports/block`, {
        method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ block_start: value }),
      });
      assert.equal(res.status, 400, `${label} 必须 400`);
      const body = await res.json();
      assert.equal(body.error.code, 'validation_failed', `${label} 的错误码是 validation_failed（工单第 3 节①）`);
      assert.equal(body.error.details.field, 'block_start');
      assert.match(body.error.message, /22000/, `文案要给出合法起点示例（${label}）`);
      assert.equal(store.writes.length, 0, `${label}：零 SQL 写`);
      assert.deepEqual(store.portSql(), [], `${label}：校验前置于开事务之前，一条端口域 SQL 都不发`);
      assert.equal(store.countTx('BEGIN'), 0, `${label}：也不得先开事务再报错`);
    }
    assert.deepEqual(store.outbox.route, []);
    assert.deepEqual(store.outbox.materialize, []);
    assert.equal(pool.audit.length, 0, '400 不写审计');
  } finally {
    await close();
  }
});

test('⑦ 超预算 FDE 名 → 400 preview_hostname_invalid（沿用交付① 口径，不降级为 warn）', async () => {
  const store = aliceSeed();
  const { base, adminCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/fdes/${LONG_FDE.fde_name}/ports/block`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ block_start: 22010 }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'preview_hostname_invalid');
    assert.match(body.error.message, /55/);
    assert.deepEqual(store.portSql(), [], '预算校验在开事务之前 ⇒ 零 SQL 写');
    assert.equal(store.countTx('BEGIN'), 0);
    assert.equal(pool.audit.length, 0);
  } finally {
    await close();
  }
});

test('⑤(线上形态) 409 preview_port_block_taken + retryable=false + 零残留；**禁止**偷偷换成第一个空闲块', async () => {
  const store = aliceSeed([liveRow('bob', 'u-bob', 22010)]);
  const { base, adminCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/fdes/alice/ports/block`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ block_start: 22010 }),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'preview_port_block_taken');
    assert.equal(body.error.retryable, false, '管理员显式指定的块被占 ⇒ 盲试必败，retryable=false（口径见 portal.md §4.7a）');
    assert.match(body.error.message, /22010-22019/);
    assert.deepEqual(store.live('u-alice').map((r) => r.port), FIRST_BLOCK, '旧块保持不变（没有被换到别处、也没被释放）');
    assert.deepEqual(store.outbox.route, []);
    assert.deepEqual(store.outbox.materialize, []);
    assert.equal(pool.audit.length, 0, '失败的改块不写「搬了」的审计');
  } finally {
    await close();
  }
});

test('③(线上形态) 改块成功：200 + changed:true + 列表跟着搬 + 审计恰好一行；再发一次 → changed:false 且零写零审计', async () => {
  const store = aliceSeed();
  const { base, adminCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await fetch(`${base}/api/admin/fdes/alice/ports/block`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ block_start: 22010 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      changed: true,
      fde_name: 'alice',
      block_start: 22010,
      block_end: 22019,
      ports: SECOND_BLOCK,
      released_allocations: PREVIEW_PORT_COUNT,
      revoked_grants: 0,
      inserted_allocations: PREVIEW_PORT_COUNT,
    });
    assert.deepEqual(store.live('u-alice').map((r) => r.port), SECOND_BLOCK);
    const moved = pool.audit.filter((e) => e.action === 'admin.fde_ports_block_moved');
    assert.equal(moved.length, 1);
    assert.equal(moved[0].actor_id, ADMIN.id);
    assert.equal(moved[0].target, 'alice');
    assert.deepEqual(JSON.parse(moved[0].details), {
      fde_name: 'alice', from_block_start: 22000, to_block_start: 22010,
      released_allocations: 10, inserted_allocations: 10, revoked_grants: 0,
    });

    const writesBefore = store.writes.length;
    const again = await fetch(`${base}/api/admin/fdes/alice/ports/block`, {
      method: 'POST', headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ block_start: 22010 }),
    });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).changed, false, '幂等：目标块 == 当前块');
    assert.equal(store.writes.length, writesBefore, '⑧ 幂等路径零 SQL 写');
    assert.equal(pool.audit.filter((e) => e.action === 'admin.fde_ports_block_moved').length, 1, '空操作不写审计（契约：不写库）');

    const listAgain = await fetch(`${base}/api/admin/fdes/alice/ports`, { headers: { cookie: adminCookie } });
    assert.deepEqual((await listAgain.json()).items.map((i) => i.port), SECOND_BLOCK, '列端点跟着搬到新块');
    assert.equal(alignedPreviewBlockStart(22010), 22010);

    const fdeSelf = await fetch(`${base}/api/admin/fdes/alice/ports/block`, {
      method: 'POST', headers: { cookie: 'nonsense=1', 'content-type': 'application/json' },
      body: JSON.stringify({ block_start: 22020 }),
    });
    assert.equal(fdeSelf.status, 401, 'admin 面未登录仍走 401；普通 FDE 的 403 见上一条测试');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// #247（issue #247，工单 feat-261023-04）：一键放行整组 —— POST /api/me/ports/batch-tickets
//
// 八条判据（工单「必测」①~⑤ + 三条本单自加）：
//   ① 批量 = N 张票：每张各落一行 preview_grants、响应顺序与请求一致、url 带票且与 ticket 对得上
//   ② 越界（别人的 / 未知的 / 已 released）⇒ 404 not_found，且**一张都不签**（零残票、零审计）
//   ③ 上限 = 号池块大小（10）：第 11 个 ⇒ 400 validation_failed + details.field='allocation_ids'
//   ④ 不给 allocation_ids ⇒ 该 FDE 全部活行（含 scope='project' 遗留行）、port ASC
//   ⑤ 审计逐张各一行、details 不含 ticket 明文（也不含带票的 url）
//   ⑥ 限流按**张**计数（一次点击 = N 张票，不得把 20/60s 放大 10 倍）
//   ⑦ 失败补偿：签发中途炸 ⇒ 本批已签的票全部收回（不留半截可用票），响应不返回半截 items
//   ⑧ admin 无 FDE ⇒ 201 空列表（与 GET /api/me/ports 同口径）；未登录 401
// ---------------------------------------------------------------------------
const BATCH_PATH = '/api/me/ports/batch-tickets';

function postBatch(base, cookie, body) {
  return fetch(`${base}${BATCH_PATH}`, {
    method: 'POST',
    headers: cookie ? { cookie, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// #247 批量签票的种子：行 id 必须是**真 UUID 形状**（端点对请求体里的 id 先判形状再交给
// `= ANY($1::uuid[])`，`pa-1` 这种 fake 内部 id 会被 400 挡在签发之前）。
const batchUuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function batchSeed({ extraRows = [] } = {}) {
  return new PortsStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }, { id: 'u-bob', fde_name: 'bob' }],
    rows: [
      ...FIRST_BLOCK.map((port, i) => ({ ...liveRow('alice', 'u-alice', port), id: batchUuid(i + 1) })),
      ...extraRows,
    ],
  });
}

test('#247① 批量 = N 张票：每张各落一行 preview_grants、响应顺序与请求一致、url 带票且与 ticket 对得上', async () => {
  const store = batchSeed();
  const { base, aliceCookie, close } = await startPortsServer({ store });
  try {
    const ids = [batchUuid(1), batchUuid(3), batchUuid(2)];
    const res = await postBatch(base, aliceCookie, { allocation_ids: ids });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(Object.keys(body), ['items'], '信封照既有列表端点 {items:[...]}');
    assert.equal(body.items.length, 3);
    assert.deepEqual(body.items.map((i) => i.id), ids, '顺序与请求一致（前端按序开标签页）');
    assert.deepEqual(body.items.map((i) => i.port), [22000, 22002, 22001], 'port 跟着 id 走（不按 port 重排）');
    for (const item of body.items) {
      assert.deepEqual(Object.keys(item).sort(), ['expires_at', 'id', 'port', 'ticket', 'url']);
      assert.match(item.ticket, /^pt_[A-Za-z0-9_-]+$/);
      assert.ok(item.url.endsWith(`?preview_ticket=${item.ticket}`), '§2.8：url 已带票，前端不得自行拼接');
      assert.match(item.url, new RegExp(`^http://alice-p-${item.port}\\.fde\\.erix\\.vip:8090\\?preview_ticket=`));
    }
    // 整批同一个 expires_at（同一个 now + 同一份 TTL 配置），且落在 60s 之后
    assert.equal(new Set(body.items.map((i) => i.expires_at)).size, 1, '同一批票共用一个 expires_at');
    const ttlMs = new Date(body.items[0].expires_at).getTime() - Date.now();
    assert.ok(ttlMs > 50_000 && ttlMs <= 60_000, `expires_at 应为 now+60s（实际 ${ttlMs}ms）`);

    const tickets = store.grants.filter((g) => g.kind === 'ticket');
    assert.equal(tickets.length, 3, '每张票各落一行 preview_grants');
    assert.equal(new Set(tickets.map((g) => g.token_hash)).size, 3, '三张票三个不同哈希（没有复用同一张）');
    for (const item of body.items) {
      const grant = tickets.find((g) => g.allocation_id === item.id);
      assert.ok(grant, `${item.id} 必须有自己那行 grant`);
      assert.equal(grant.token_hash, auth.hashToken(item.ticket), '只存 sha256，不存明文');
      assert.equal(grant.user_id, ALICE.id, '主体 = 本人');
      assert.equal(grant.issuer_id, ALICE.id, 'issuer = 主体（普通 FDE 自签）');
      assert.equal(grant.state, 'active');
      assert.ok(grant.expires_at, 'expires_at 必须落库（TTL 生效）');
    }
  } finally {
    await close();
  }
});

test('#247② 越界（别人的 / 未知的 / 已 released）⇒ 404 not_found 且一张都不签（零残票、零审计、同一句响应）', async () => {
  const store = batchSeed({
    extraRows: [
      { ...liveRow('bob', 'u-bob', 22020), id: batchUuid(11) },
      { ...liveRow('alice', 'u-alice', 22011, { state: 'released', released_at: new Date().toISOString() }), id: batchUuid(12) },
    ],
  });
  const bobRow = store.rows.find((r) => r.fde_id === 'u-bob');
  const releasedRow = store.rows.find((r) => r.state === 'released');
  const { base, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const before = store.grants.length;
    const foreign = await postBatch(base, aliceCookie, { allocation_ids: [batchUuid(1), bobRow.id] });
    const unknown = await postBatch(base, aliceCookie, { allocation_ids: [batchUuid(1), '00000000-0000-4000-8000-0000000000ff'] });
    const released = await postBatch(base, aliceCookie, { allocation_ids: [releasedRow.id] });

    assert.equal(foreign.status, 404);
    assert.equal(foreign.status, 404, '别人的 allocation ⇒ 404（与单据端点同码）');
    assert.equal(unknown.status, 404);
    assert.equal(released.status, 404, '已 released 视同不存在（单据端点同口径）');
    const bodies = [await foreign.json(), await unknown.json(), await released.json()];
    for (const body of bodies) assert.equal(body.error.code, 'not_found', '复用既有码，不新造');
    assert.deepEqual(bodies[0], bodies[1], '「存在但不属于你」与「根本不存在」必须回同一句（否则是存在性探针）');
    assert.deepEqual(bodies[0], bodies[2]);

    assert.equal(store.grants.length, before, '预检在签发之前 ⇒ 一张都没签（不存在「先签 pa-1 再撞 404」的半截）');
    assert.equal(pool.audit.length, 0, '失败的批量不写审计');
    assert.deepEqual(store.portSql().filter((x) => x.startsWith('INSERT')), [], '零 INSERT');
  } finally {
    await close();
  }
});

test('#247③ 上限 = 号池块大小：第 11 个 ⇒ 400 validation_failed + details.field；形状类错误同样 400 且零写', async () => {
  const store = aliceSeed();
  const { base, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const tooMany = Array.from({ length: PREVIEW_PORT_COUNT + 1 }, (_, i) => uuid(i + 1));
    const cases = [
      [{ allocation_ids: tooMany }, '超过上限（第 11 个）'],
      [{ allocation_ids: [] }, '空数组'],
      [{ allocation_ids: 'pa-1' }, '不是数组'],
      [{ allocation_ids: ['not-a-uuid'] }, '不是 UUID'],
      [{ allocation_ids: [uuid(1), uuid(1).toUpperCase()] }, '重复（大小写归一后同一条）'],
    ];
    for (const [body, label] of cases) {
      const res = await postBatch(base, aliceCookie, body);
      assert.equal(res.status, 400, `${label} 必须 400`);
      const err = await res.json();
      assert.equal(err.error.code, 'validation_failed', `${label}：复用 validation_failed（零新错误码）`);
      assert.equal(err.error.details.field, 'allocation_ids', `${label}：details.field 供前端定位`);
      assert.equal(store.grants.length, 0, `${label}：零签发`);
      assert.equal(pool.audit.length, 0, `${label}：零审计`);
    }
    assert.match((await (await postBatch(base, aliceCookie, { allocation_ids: tooMany })).json()).error.message, /10/,
      '文案要点明上限是 10（与号池块大小同源）');
  } finally {
    await close();
  }
});

test('#247④ 不给 allocation_ids ⇒ 该 FDE 全部活行（含 scope=\'project\' 遗留行），port ASC', async () => {
  const store = new PortsStore({
    users: [{ id: 'u-alice', fde_name: 'alice' }, { id: 'u-bob', fde_name: 'bob' }],
    rows: [
      { ...liveRow('alice', 'u-alice', 22000), id: batchUuid(1) },
      // 遗留形态（P5 前的 project 维度行）：一键放行整组必须也覆盖它
      { ...liveRow('alice', 'u-alice', 22012, { scope: 'project', role: 'primary' }), id: batchUuid(2) },
      { ...liveRow('alice', 'u-alice', 22001), id: batchUuid(3) },
      { ...liveRow('bob', 'u-bob', 22002), id: batchUuid(4) },
    ],
  });
  const { base, aliceCookie, close } = await startPortsServer({ store });
  try {
    const res = await postBatch(base, aliceCookie, {});
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(body.items.map((i) => i.port), [22000, 22001, 22012], 'port ASC；含遗留行、不含别人的行');
    assert.deepEqual(body.items.map((i) => i.id), [batchUuid(1), batchUuid(3), batchUuid(2)]);
    assert.equal(store.grants.filter((g) => g.kind === 'ticket').length, 3);
    assert.deepEqual(
      store.grants.filter((g) => g.kind === 'ticket').map((g) => g.allocation_id).sort(),
      [batchUuid(1), batchUuid(2), batchUuid(3)].sort(),
      '遗留 project 行也要覆盖（否则「一键放行整组」在存量 FDE 上永远少一个）',
    );
  } finally {
    await close();
  }
});

test('#247⑤ 审计逐张各一行、details 不含 ticket 明文（也不含带票的 url）', async () => {
  const store = batchSeed();
  const { base, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const ids = [batchUuid(1), batchUuid(2), batchUuid(3)];
    const body = await (await postBatch(base, aliceCookie, { allocation_ids: ids })).json();
    const rows = pool.audit.filter((e) => e.action === 'auth.preview_ticket_issued');
    assert.equal(rows.length, 3, '逐张各写一行（「整批写一行」是变异靶子，必须具名红）');
    assert.equal(pool.audit.length, 3, '整个请求只产生这三行（不多不少）');

    const blob = JSON.stringify(pool.audit);
    for (const item of body.items) {
      assert.ok(!blob.includes(item.ticket), '审计里绝不入 ticket 明文（http.js:385 的既有纪律）');
      assert.ok(!blob.includes(item.url), '带票的 url 同样不得入审计');
    }
    const seen = new Set();
    for (const row of rows) {
      const details = JSON.parse(row.details);
      assert.deepEqual(Object.keys(details).sort(),
        ['allocation_id', 'expires_at', 'grant_kind', 'port', 'token_hash_prefix']);
      assert.equal(details.grant_kind, 'ticket', '§2.8 B3：审计只记 grant_kind + 标识，不记明文');
      assert.match(details.token_hash_prefix, /^[0-9a-f]{12}$/, '可关联的只有哈希前缀');
      assert.equal(row.actor_id, ALICE.id);
      assert.match(row.target, /^alice-p-\d+\.fde\.erix\.vip$/, 'target = 预览 host（同 auth.forward_auth 口径）');
      seen.add(details.allocation_id);
    }
    assert.deepEqual([...seen].sort(), ids, '每行对应不同的 allocation（不是同一行写三遍）');
  } finally {
    await close();
  }
});

test('#247⑥ 限流按**张**计数：一次点击签 N 张就吃掉 N 个配额（不得把 20/60s 放大 10 倍）', async () => {
  const store = batchSeed();
  const { base, aliceCookie, close } = await startPortsServer({
    store,
    rateLimit: { maxFailures: 3, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
  });
  try {
    const first = await postBatch(base, aliceCookie, { allocation_ids: [batchUuid(1), batchUuid(2), batchUuid(3)] });
    assert.equal(first.status, 201);
    const second = await postBatch(base, aliceCookie, { allocation_ids: [batchUuid(4)] });
    assert.equal(second.status, 429, '3 张票已经吃满 3 个配额 ⇒ 第 4 张被限流');
    const err = await second.json();
    assert.equal(err.error.code, 'rate_limited');
    assert.equal(err.error.retryable, true);
    assert.equal(store.grants.filter((g) => g.kind === 'ticket').length, 3, '被限流的那次一张都没签');
  } finally {
    await close();
  }
});

test('#247⑦ 失败补偿：签发中途炸 ⇒ 本批已签的票全部收回（不留半截可用票），不返回半截 items', async () => {
  const store = batchSeed();
  store.ticketFailAt = 3; // 第 3 张票的 INSERT 炸（前两张已落库）
  const { base, aliceCookie, pool, close } = await startPortsServer({ store });
  try {
    const res = await postBatch(base, aliceCookie, { allocation_ids: [batchUuid(1), batchUuid(2), batchUuid(3)] });
    assert.equal(res.status, 500, '意外失败照既有 500 口径（不新造码）');
    assert.ok(!('items' in (await res.json())), '不返回半截 items');
    const tickets = store.grants.filter((g) => g.kind === 'ticket');
    assert.equal(tickets.length, 2, '前两张确实签过（不是「一张都没签」的假绿）');
    for (const grant of tickets) {
      assert.equal(grant.state, 'revoked', '已签的票必须被收回——否则它们 60 秒内还能换预览 cookie，等于悄悄放行了半个面板');
      assert.ok(grant.revoked_at, 'revoked ⇔ revoked_at（baseline CHECK）');
    }
    assert.equal(pool.audit.length, 0, '整批失败不写审计（没有成功签发的行）');
  } finally {
    await close();
  }
});

test('#247⑧ admin 没有 FDE ⇒ 201 空列表（同 GET /api/me/ports 口径）；未登录 401', async () => {
  const store = batchSeed();
  const { base, adminCookie, close } = await startPortsServer({ store });
  try {
    const res = await postBatch(base, adminCookie, {});
    assert.equal(res.status, 201);
    assert.deepEqual(await res.json(), { items: [] });
    assert.equal(store.grants.length, 0, '零签发');

    const anon = await postBatch(base, null, {});
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, 'unauthorized', '未登录走既有 401 口径');
  } finally {
    await close();
  }
});
