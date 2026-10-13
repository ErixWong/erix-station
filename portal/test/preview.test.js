// 单测：preview.js —— ticket 签发（存哈希）/ forward-auth 校验（有效→302/200、无效→401、过期→401、重放→403、无凭证→403、released→403）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {
  parsePreviewTicket,
  stripPreviewTicket,
  derivePreviewSessionToken,
  issuePreviewTicket,
  authorizeForwardAuth,
  normalizeHostHeader,
  isCorsPreflight,
} from '../src/preview.js';
import { hashToken } from '../src/auth.js';

const KEY = 'test-signing-key';
const NOW = new Date('2026-09-16T00:00:00.000Z');
const later = (s) => new Date(NOW.getTime() + s * 1000);

// ---------------------------------------------------------------------------
// #275：port_allocations 的「部分唯一索引 + 读侧排序」在 fake 里的等价模拟。
//
// 为什么要专门做：#275 那个「预览恒定 403」能在单测全绿的情况下活到真机（v0.1.5 已发布版本），
// 根因就是这里的 fake 用 `allocations.find(hostname 相等)` 取第一行 —— 它**结构上不可能**同时存在
// 「同名的活行 + released 行」，而真库的 `port_allocations_live_hostname_key` 是**部分**唯一索引
// （`WHERE state <> 'released'`，`docs/data/schema.sql` §4）⇒ released 行**不占位**、两行能共存。
// 照 AGENTS §8.14 的约定（先例 `./preview-grant-checks.js`）：fake 必须**按 SQL 说的做**，
// 不得自己另写一套谓词/优先级——所以下面既建索引（种子级），也**从 SQL 文本里解析 ORDER BY 再执行**。
// ---------------------------------------------------------------------------

/** baseline 里 port_allocations 的**表级** CHECK（PG 自动命名 = 表名 + `_check` / `_check1` …，按定义序）。 */
const PORT_ALLOCATION_TABLE_CHECKS = [
  { name: 'port_allocations_check', label: "(scope = 'run') = (run_id IS NOT NULL)", ok: (r) => (r.scope === 'run') === (r.run_id != null) },
  { name: 'port_allocations_check1', label: "(state = 'released') = (released_at IS NOT NULL)", ok: (r) => (r.state === 'released') === (r.released_at != null) },
];
/** 与真库同名的 23514 / 23505（`err.code` + 原文案），让调用方走同一条错误路径。 */
function sqlError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 种子的 port_allocations 行逐条过 baseline CHECK + **部分**唯一索引。
 * 部分索引的模拟就是「只对 `state <> 'released'` 的行判重」：released 行不占位 ⇒ 同 hostname
 * 的多条 released 行合法（真库现状即 1 活行 + 1 released），而两条同名活行必报 23505。
 */
function assertPortAllocationSeeds(rows) {
  const live = [];
  for (const row of rows) {
    const violation = PORT_ALLOCATION_TABLE_CHECKS.find((check) => !check.ok(row));
    if (violation) {
      throw sqlError('23514', `new row for relation "port_allocations" violates check constraint "${violation.name}"（${violation.label}）：${JSON.stringify(row)}`);
    }
    if (row.state === 'released') continue;                      // 部分索引：released 不占位
    const clash = live.find((r) => r.hostname === row.hostname);
    if (clash) {
      throw sqlError('23505', `duplicate key value violates unique constraint "port_allocations_live_hostname_key"`
        + ` DETAIL: Key (hostname)=(${row.hostname}) already exists. [与行 id=${clash.id} 同为 state=${row.state} 的活行]`);
    }
    live.push(row);
  }
}

/** 支持的 ORDER BY 表达式（名字与实现里的 SQL 逐字对齐；解析不出来就直接红，防两侧静默漂移）。 */
const ORDER_BY_EXPRS = [
  { re: /^\(\s*a\.state\s*<>\s*'released'\s*\)$/i, value: (row) => row.state !== 'released' },
  { re: /^a\.released_at$/i, value: (row) => row.released_at ?? null },
  { re: /^a\.created_at$/i, value: (row) => row.created_at ?? null },
  { re: /^a\.hostname$/i, value: (row) => row.hostname },
  { re: /^a\.id$/i, value: (row) => row.id },
];

/**
 * 把 forward-auth 那条 SELECT 当真库那样执行：WHERE 谓词 → INNER JOIN users → ORDER BY → LIMIT。
 * fake **不自己另写一套谓词/优先级**，语义全从 SQL 文本里解析（同 `./preview-grant-checks.js` 的口径）：
 *   - `a.hostname = $n`：精确匹配（调用方已剥端口 + 小写）；
 *   - `a.state <> 'released'` / `a.state = 'x'`：可选，写了就照它筛 ⇒ 若实现退化成「只加状态过滤」，
 *     「只有 released 行的 host」就会变成 404，被下面的 released 用例当场拦下（契约：那是 403）；
 *   - 无 ORDER BY ⇒ 保留**物理序**（种子序；真库对应 Seq Scan 扫到的序）——这正是 #275 的形状，
 *     所以把实现里的 ORDER BY 删掉（变异测试）就会退化成「先扫到 released 行」⇒ 新用例必红；
 *   - `JOIN users u` 是 INNER JOIN ⇒ fde_id 查不到用户行就掉行（与真库一致），`fde_name` 取自 users。
 * 解析不出的 WHERE 残片 / ORDER BY 表达式 ⇒ assert.fail（不默不作声地多过）。
 */
function selectPortAllocations({ sql, params, allocations, users }) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  const where = (flat.match(/\bWHERE\b(.+?)(?:\bORDER BY\b|\bLIMIT\b|$)/i) ?? [])[1] ?? '';

  const hostMatch = where.match(/\ba\.hostname\s*=\s*\$(\d+)/i);
  if (!hostMatch) assert.fail(`preview fake 解析不出 hostname 谓词（WHERE：${where.trim()}）`);
  const host = params[Number(hostMatch[1]) - 1];

  const statePredicates = [...where.matchAll(/\ba\.state\s*(<>|=)\s*'([a-z-]+)'/gi)]
    .map(([, op, value]) => (row) => (op === '<>' ? row.state !== value : row.state === value));
  const residue = where
    .replace(/\ba\.hostname\s*=\s*\$\d+/gi, ' ')
    .replace(/\ba\.state\s*(<>|=)\s*'[a-z-]+'/gi, ' ')
    .replace(/\band\b/gi, ' ');
  if (residue.trim() !== '') {
    assert.fail(`preview fake 解析不出 WHERE 里的剩余谓词「${residue.trim()}」（完整 WHERE：${where.trim()}）——实现改了查询而 fake 没跟上`);
  }

  const joined = allocations
    .filter((row) => row.hostname === host && statePredicates.every((keep) => keep(row)))
    .map((row) => {
      const user = users.find((u) => u.id === row.fde_id);
      return user ? { ...row, fde_name: user.fde_name ?? row.fde_name ?? null, user_status: user.status } : null;
    })
    .filter(Boolean);

  return applyOrderByAndLimit(flat, joined).map((row) => ({ ...row }));
}

/** 把 ORDER BY 子句拆成项（括号内的逗号不算分隔符）。 */
function splitOrderByTerms(clause) {
  const terms = [];
  let depth = 0;
  let current = '';
  for (const ch of clause) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      terms.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') terms.push(current.trim());
  return terms;
}

/** 一项 ORDER BY → { 表达式, DESC?, NULLS? }：括号表达式整块取，尾部的 ASC/DESC/NULLS 归修饰词。 */
function parseOrderTerm(term, clause) {
  let rest = term.trim();
  let expression;
  if (rest.startsWith('(')) {
    let depth = 0;
    for (let index = 0; index < rest.length; index += 1) {
      if (rest[index] === '(') depth += 1;
      if (rest[index] === ')') depth -= 1;
      if (depth === 0) {
        expression = rest.slice(0, index + 1);
        rest = rest.slice(index + 1).trim();
        break;
      }
    }
    if (expression === undefined) assert.fail(`preview fake：ORDER BY 括号不闭合「${term}」`);
  } else {
    [expression, rest = ''] = rest.split(/\s+/);
  }
  const expr = ORDER_BY_EXPRS.find((candidate) => candidate.re.test(expression));
  if (!expr) assert.fail(`preview fake 解析不出 ORDER BY 表达式「${expression}」（完整子句：${clause.trim()}）——实现改了排序而 fake 没跟上`);
  const modifiers = rest.toUpperCase();
  return {
    expr,
    desc: /\bDESC\b/.test(modifiers),
    nulls: /\bNULLS\s+FIRST\b/.test(modifiers) ? 'first' : /\bNULLS\s+LAST\b/.test(modifiers) ? 'last' : null,
  };
}

/** 从 SQL 里解析 `ORDER BY … LIMIT n`（无 ORDER BY ⇒ 物理序，即种子序）。 */
function parseOrderByAndLimit(flatSql) {
  const order = flatSql.match(/\bORDER BY\b(.+?)\bLIMIT\s+(\d+)\s*$/i) ?? flatSql.match(/\bORDER BY\b(.+?)$/i);
  const limit = flatSql.match(/\bLIMIT\s+(\d+)/i);
  const keys = order ? splitOrderByTerms(order[1]).map((term) => parseOrderTerm(term, order[1])) : [];
  return { keys, limit: limit ? Number(limit[1]) : null };
}

function compareOrderKey(left, right, { desc, nulls }) {
  const nullLeft = left === null || left === undefined;
  const nullRight = right === null || right === undefined;
  if (nullLeft || nullRight) {
    if (nullLeft && nullRight) return 0;
    const nullsFirst = nulls ? nulls === 'first' : desc;          // PG 默认：DESC ⇒ NULLS FIRST
    return (nullLeft ? -1 : 1) * (nullsFirst ? 1 : -1);
  }
  const a = typeof left === 'boolean' ? Number(left) : left;
  const b = typeof right === 'boolean' ? Number(right) : right;
  const at = a instanceof Date ? a.getTime() : a;
  const bt = b instanceof Date ? b.getTime() : b;
  const cmp = at < bt ? -1 : at > bt ? 1 : 0;
  return desc ? -cmp : cmp;
}

/** 照 SQL 的 ORDER BY + LIMIT 执行（fake 不自己发明优先级）。 */
function applyOrderByAndLimit(flatSql, rows) {
  const { keys, limit } = parseOrderByAndLimit(flatSql);
  const sorted = keys.length === 0
    ? rows                                                // 无 ORDER BY ⇒ 物理序（真库 = Seq Scan 扫到的序）
    : [...rows].sort((left, right) => {
      for (const key of keys) {
        const cmp = compareOrderKey(key.expr.value(left), key.expr.value(right), key);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
  return limit === null ? sorted : sorted.slice(0, limit);
}

/** in-memory preview pool：建模 port_allocations / users / preview_grants（含事务 client）。 */
class PreviewPool {
  constructor({ allocations = [], users = [], grants = [] } = {}) {
    assertPortAllocationSeeds(allocations);                // 种子自己先过真库约束（不合约束的种子测的是不存在的状态）
    this.allocations = allocations;
    this.users = users;
    this.grants = grants;
    this.grantSeq = 100;
    this.queries = [];
  }
  dispatch(sql, params = []) {
    // 事务原语
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

    if (sql.includes('FROM port_allocations a')) {
      // forward-auth 的 hostname 查表（#275）：WHERE / JOIN / ORDER BY / LIMIT 全按 SQL 说的做。
      return { rows: selectPortAllocations({ sql, params, allocations: this.allocations, users: this.users }) };
    }
    if (sql.includes('FROM port_allocations WHERE id = $1')) {
      const a = this.allocations.find((x) => x.id === params[0]);
      return { rows: a ? [{ ...a }] : [] };
    }
    if (sql.includes('FROM users WHERE id = $1')) {
      const u = this.users.find((x) => x.id === params[0]);
      return { rows: u ? [{ ...u }] : [] };
    }

    if (sql.includes("kind = 'ticket'")) {
      const h = params[0];
      const g = this.grants.find((x) => x.token_hash === h && x.kind === 'ticket');
      return { rows: g ? [{ ...g }] : [] };
    }
    if (sql.includes("kind = 'session'") && sql.includes('token_hash = $1')) {
      const h = params[0];
      const g = this.grants.find((x) => x.token_hash === h && x.kind === 'session');
      return { rows: g ? [{ ...g }] : [] };
    }
    if (sql.includes('parent_ticket_id = $1')) {
      const parent = params[0];
      const g = this.grants.find((x) => x.parent_ticket_id === parent && x.kind === 'session');
      return { rows: g ? [{ ...g }] : [] };
    }

    // ticket 原子消费（事务内）
    if (sql.includes("SET state = 'used', used_at = now()")) {
      const id = params[0];
      const g = this.grants.find((x) => x.id === id);
      if (g && g.state === 'active' && g.used_at == null) {
        g.state = 'used';
        g.used_at = NOW;
        return { rows: [{ id: g.id }] };
      }
      return { rows: [] };
    }
    // 签发 / 派生 session 插入
    if (sql.includes('INSERT INTO preview_grants')) {
      const kind = sql.includes("'session'") ? 'session' : 'ticket';
      let g;
      if (kind === 'ticket') {
        const [token_hash, user_id, issuer_id, allocation_id, expires_at] = params;
        g = { id: `g${this.grantSeq++}`, token_hash, user_id, issuer_id, allocation_id, parent_ticket_id: null, kind, state: 'active', expires_at, used_at: null, revoked_at: null, last_seen_at: null };
      } else {
        // preview.js session 插入：VALUES ($1 token_hash, $2 user_id, NULL issuer, $3 allocation_id, $4 parent_ticket_id, 'session', 'active', $5 expires_at, $5)
        const [token_hash, user_id, allocation_id, parent_ticket_id, expires_at] = params;
        g = { id: `g${this.grantSeq++}`, token_hash, user_id, issuer_id: null, allocation_id, parent_ticket_id, kind, state: 'active', expires_at, used_at: null, revoked_at: null, last_seen_at: null };
      }
      this.grants.push(g);
      return { rows: [] };
    }
    // session 滚动续期
    if (sql.includes('UPDATE preview_grants SET expires_at = $2')) {
      const [id, expires_at, last_seen_at] = params;
      const g = this.grants.find((x) => x.id === id);
      if (g) {
        g.expires_at = expires_at;
        g.last_seen_at = last_seen_at;
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
  async query(sql, params) {
    this.queries.push(sql); // #241：部分断言需要「有没有发过这条 SQL」（预检不写 grant / 不滚动续期）
    return this.dispatch(sql, params);
  }
  async connect() {
    return { query: (s, p) => this.dispatch(s, p), release() {} };
  }
  async end() {}
}

const ALLOC = {
  id: 'pa1',
  fde_id: 'u1',
  scope: 'fde',
  run_id: null,
  state: 'allocated',
  exposure: 'private',
  // #57 阶段2 伞域 grammar：<fde>-p-<port4>.<BASE_DOMAIN>（BASE_DOMAIN = fde.<可注册域>）。
  hostname: 'alice-p-4000.fde.erix.vip',
  url: 'https://alice-p-4000.fde.erix.vip',
  // #275：种子行补齐到与真库同形（`released_at` 存不存与 `state` 双向绑定是 baseline CHECK；
  // `port` 的按状态分支 CHECK 不在本 fake 建模——写侧的端口约束由 `portalloc.test.js` 的 fake 负责）。
  created_at: NOW,
  released_at: null,
  fde_name: 'alice',
  user_status: 'active',
};

/** #275：一条合法的 released 历史行（`released ⇔ released_at` 是 baseline CHECK，缺 released_at 的种子真库进不了表）。 */
const releasedAlloc = (overrides = {}) => ({ ...ALLOC, state: 'released', released_at: NOW, ...overrides });

function makePool(overrides = {}) {
  const allocations = overrides.allocations ?? [ALLOC];
  const users = overrides.users ?? [{ id: 'u1', role: 'fde', status: 'active' }];
  const pool = new PreviewPool({ allocations, users, grants: overrides.grants ?? [] });
  return { pool, grants: pool.grants, queries: pool.queries };
}

const config = {
  previewTicketTtlSeconds: 60,
  previewSessionTtlSeconds: 900,
  previewSessionSigningKey: KEY,
};

// #57：无 portalPublicBaseUrl 时 previewUrl 退化为 https 无端口（与旧 buildUrl 行为等价）；
// 带公开入口时按入口派生 scheme/端口（dev http:8090 与生产 https 同一代码路径）。
const devConfig = { ...config, portalPublicBaseUrl: 'http://station.fde.erix.vip:8090' };

// ---- 纯函数 ----
test('parsePreviewTicket / stripPreviewTicket：解析与脱敏', () => {
  assert.equal(parsePreviewTicket('/?preview_ticket=abc&x=1'), 'abc');
  assert.equal(parsePreviewTicket('/?a=1&preview_ticket=zz'), 'zz');
  assert.equal(parsePreviewTicket('/no-ticket'), null);
  assert.equal(stripPreviewTicket('/?preview_ticket=abc'), '/');
  assert.equal(stripPreviewTicket('/?preview_ticket=abc&b=2'), '/?b=2');
  assert.equal(stripPreviewTicket('/path'), '/path');
});

test('derivePreviewSessionToken：确定性派生（重放可重放同一 token）', () => {
  const t1 = derivePreviewSessionToken('ticket-x', KEY);
  const t2 = derivePreviewSessionToken('ticket-x', KEY);
  assert.equal(t1, t2);
  assert.ok(t1.startsWith('s_'));
  assert.notEqual(derivePreviewSessionToken('ticket-y', KEY), t1);
});

// ---- 签发 ----
test('issuePreviewTicket：private owner 可签、存哈希不存明文、他人 404、released 404', async () => {
  const { pool, grants } = makePool();
  const out = await issuePreviewTicket(pool, config, {
    allocationId: 'pa1',
    session: { user: { id: 'u1', role: 'fde' } },
    now: NOW,
  });
  assert.ok(out.ticket.startsWith('pt_'));
  assert.equal(out.expires_in, 60);
  assert.equal(out.url, `https://alice-p-4000.fde.erix.vip?preview_ticket=${out.ticket}`);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].token_hash, hashToken(out.ticket)); // 只存哈希
  assert.notEqual(grants[0].token_hash, out.ticket);

  // 他人（非 owner、非 admin）→ 404（不泄露存在性）
  const other = await issuePreviewTicket(pool, config, {
    allocationId: 'pa1',
    session: { user: { id: 'u2', role: 'fde' } },
    now: NOW,
  });
  assert.deepEqual(other, { error: { status: 404, code: 'not_found' } });

  // released 视同不存在 → 404
  const { pool: p2 } = makePool({ allocations: [releasedAlloc()] });
  const rel = await issuePreviewTicket(p2, config, {
    allocationId: 'pa1',
    session: { user: { id: 'u1', role: 'fde' } },
    now: NOW,
  });
  assert.equal(rel.error.status, 404);
});

test('issuePreviewTicket：admin 代签他人 private 放行（issuer=subject=admin）', async () => {
  const { pool } = makePool({ users: [{ id: 'u1', role: 'fde', status: 'active' }, { id: 'u9', role: 'admin', status: 'active' }] });
  const out = await issuePreviewTicket(pool, config, {
    allocationId: 'pa1',
    session: { user: { id: 'u9', role: 'admin' } },
    now: NOW,
  });
  assert.ok(out.ticket);
});

// ---- forward-auth ----
test('authorizeForwardAuth：无凭证 403 / 未知 host 404 / released 403', async () => {
  const { pool } = makePool();
  assert.equal((await authorizeForwardAuth(pool, config, { hostname: 'nope.fde.localhost', now: NOW })).outcome, 'deny');
  assert.equal((await authorizeForwardAuth(pool, config, { hostname: 'nope.fde.localhost', now: NOW })).status, 404);

  const nocred = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, now: NOW });
  assert.equal(nocred.outcome, 'deny');
  assert.equal(nocred.status, 403);
  assert.equal(nocred.code, 'preview_ticket_required');

  const { pool: p2 } = makePool({ allocations: [releasedAlloc()] });
  const rel = await authorizeForwardAuth(p2, config, { hostname: ALLOC.hostname, now: NOW });
  assert.equal(rel.status, 403);
  assert.equal(rel.code, 'allocation_released');
});

test('authorizeForwardAuth：有效 ticket → 302 换 session（消费 ticket + 派生 session）', async () => {
  const { pool, grants } = makePool();
  const ticket = 'pt_valid_ticket';
  grants.push({
    id: 'g1', token_hash: hashToken(ticket), user_id: 'u1', issuer_id: 'u1', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'active', expires_at: later(60), used_at: null, revoked_at: null,
  });
  const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, uri: `/?preview_ticket=${ticket}`, scheme: 'http', now: NOW });
  assert.equal(res.outcome, 'redirect');
  assert.equal(res.status, 302);
  assert.equal(res.sessionToken, derivePreviewSessionToken(ticket, KEY));
  assert.equal(res.location, `http://${ALLOC.hostname}/`);
  // ticket 已消费
  const g = grants.find((x) => x.id === 'g1');
  assert.equal(g.state, 'used');
  // 派生 session 已落库（只存哈希）
  const sess = grants.find((x) => x.kind === 'session');
  assert.ok(sess);
  assert.equal(sess.token_hash, hashToken(res.sessionToken));
  assert.equal(sess.parent_ticket_id, 'g1');
});

test('authorizeForwardAuth：无效 ticket 401 / 过期 401 / 重放（无活跃 session）403', async () => {
  const { pool, grants } = makePool();
  // 无效
  let res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, uri: '/?preview_ticket=not-exist', now: NOW });
  assert.equal(res.status, 401);
  assert.equal(res.code, 'preview_ticket_invalid');

  // 过期
  grants.push({
    id: 'g2', token_hash: hashToken('expired-ticket'), user_id: 'u1', issuer_id: 'u1', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'active', expires_at: later(-1), used_at: null, revoked_at: null,
  });
  res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, uri: '/?preview_ticket=expired-ticket', now: NOW });
  assert.equal(res.status, 401);
  assert.equal(res.code, 'preview_ticket_expired');

  // 已消费且无活跃派生 session → 真·重放 403
  grants.push({
    id: 'g3', token_hash: hashToken('used-ticket'), user_id: 'u1', issuer_id: 'u1', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'used', expires_at: later(60), used_at: NOW, revoked_at: null,
  });
  res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, uri: '/?preview_ticket=used-ticket', now: NOW });
  assert.equal(res.status, 403);
  assert.equal(res.code, 'preview_ticket_used');
});

test('authorizeForwardAuth：有效预览 cookie → 200 放行 + 滚动续期', async () => {
  const cookie = 's_valid_cookie';
  const { pool, grants } = makePool();
  grants.push({
    id: 'g4', token_hash: hashToken(cookie), user_id: 'u1', issuer_id: null, allocation_id: 'pa1',
    parent_ticket_id: 'g-parent', kind: 'session', state: 'active', expires_at: later(600), used_at: null, revoked_at: null,
  });
  const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, cookieValue: cookie, now: NOW });
  assert.equal(res.outcome, 'allow');
  assert.equal(res.status, 200);
  assert.equal(res.cookieToken, cookie); // 重发同一 cookie（续期）
  assert.equal(res.fdeName, 'alice');
  // 续期：expires_at 刷新
  const g = grants.find((x) => x.id === 'g4');
  assert.equal(g.expires_at.getTime(), later(900).getTime());
});

test('authorizeForwardAuth：private 越权（非 owner 主体）→ 403', async () => {
  const { pool, grants } = makePool({
    users: [
      { id: 'u1', role: 'fde', status: 'active' },
      { id: 'u2', role: 'fde', status: 'active' },
    ],
  });
  const ticket = 'pt_other_subject';
  grants.push({
    id: 'g5', token_hash: hashToken(ticket), user_id: 'u2', issuer_id: 'u2', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'active', expires_at: later(60), used_at: null, revoked_at: null,
  });
  const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, uri: `/?preview_ticket=${ticket}`, now: NOW });
  assert.equal(res.status, 403);
  assert.equal(res.code, 'forbidden');
});

test('F13：已消费 ticket 跨 hostname 重放 → 403 preview_ticket_mismatch（先于安全重放，不派发 session 到别的 allocation）', async () => {
  const allocB = { ...ALLOC, id: 'pa2', hostname: 'bob-p-4000.fde.erix.vip', url: 'https://bob-p-4000.fde.erix.vip' };
  const { pool, grants } = makePool({ allocations: [ALLOC, allocB] });
  const ticket = 'pt_cross_host';
  // 已消费 ticket（allocation_id=pa1）+ 已派生活跃 session（安全重放分支的诱饵）
  grants.push({
    id: 'g1', token_hash: hashToken(ticket), user_id: 'u1', issuer_id: 'u1', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'used', expires_at: later(60), used_at: NOW, revoked_at: null,
  });
  const sessionToken = derivePreviewSessionToken(ticket, KEY);
  grants.push({
    id: 'g-sess', token_hash: hashToken(sessionToken), user_id: 'u1', issuer_id: null,
    allocation_id: 'pa1', parent_ticket_id: 'g1', kind: 'session', state: 'active', expires_at: later(600), used_at: null, revoked_at: null,
  });

  const res = await authorizeForwardAuth(pool, config, {
    hostname: allocB.hostname, uri: `/?preview_ticket=${ticket}`, scheme: 'http', now: NOW,
  });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.status, 403);
  assert.equal(res.code, 'preview_ticket_mismatch');
});

// ---- #57 阶段2：伞域接入的三条口径（Host 归一化 / 可操作 404 / URL 按公开入口派生）----
test('#57 normalizeHostHeader：剥端口 + 小写（查表口径唯一实现）', async () => {
  assert.equal(normalizeHostHeader('eric-p-8001.fde.erix.vip:8090'), 'eric-p-8001.fde.erix.vip');
  assert.equal(normalizeHostHeader('Eric-P-8001.FDE.ERIX.VIP'), 'eric-p-8001.fde.erix.vip');
  assert.equal(normalizeHostHeader('[::1]:8443'), '[::1]');
  assert.equal(normalizeHostHeader(' eric-p-8001.fde.erix.vip:80 '), 'eric-p-8001.fde.erix.vip');
  // 非字符串 / 缺失 → 空串（调用方据此走 404，不抛）
  assert.equal(normalizeHostHeader(undefined), '');
  assert.equal(normalizeHostHeader(null), '');
});

test('#57 authorizeForwardAuth：查表用剥端口 host 能放行，且 cookie 已签发路径 200', async () => {
  const cookie = 's_cookie_port_host';
  const { pool, grants } = makePool();
  grants.push({
    id: 'g-p1', token_hash: hashToken(cookie), user_id: 'u1', issuer_id: null, allocation_id: 'pa1',
    parent_ticket_id: 'g-parent', kind: 'session', state: 'active', expires_at: later(600), used_at: null, revoked_at: null,
  });
  // 浏览器 Host 带端口（dev 8090）：http.js 先 normalizeHostHeader 再传入，这里同口径。
  const res = await authorizeForwardAuth(pool, config, {
    hostname: normalizeHostHeader(`${ALLOC.hostname}:8090`),
    hostHeader: `${ALLOC.hostname}:8090`,
    cookieValue: cookie,
    now: NOW,
  });
  assert.equal(res.outcome, 'allow');
  assert.equal(res.status, 200);
  assert.equal(res.fdeName, 'alice');
});

test('#58 回归：302 Location 保留原始 Host 的端口（归一化只用于查表，不影响 Location）', async () => {
  const { pool, grants } = makePool();
  const ticket = 'pt_port_in_location';
  grants.push({
    id: 'g-p2', token_hash: hashToken(ticket), user_id: 'u1', issuer_id: 'u1', allocation_id: 'pa1',
    parent_ticket_id: null, kind: 'ticket', state: 'active', expires_at: later(60), used_at: null, revoked_at: null,
  });
  const res = await authorizeForwardAuth(pool, config, {
    hostname: normalizeHostHeader(`${ALLOC.hostname}:8090`),
    hostHeader: `${ALLOC.hostname}:8090`,
    uri: `/?preview_ticket=${ticket}`,
    scheme: 'http',
    now: NOW,
  });
  assert.equal(res.outcome, 'redirect');
  assert.equal(res.location, `http://${ALLOC.hostname}:8090/`, 'Location 必须带非默认端口，否则浏览器跳 :80 拒连');
});

test('#57 authorizeForwardAuth：未分配预览域 / 失效书签 → 404 且提示可操作（错误码不变）', async () => {
  const { pool } = makePool();
  const res = await authorizeForwardAuth(pool, config, { hostname: 'stale-p-9000.fde.erix.vip', now: NOW });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.status, 404);
  assert.equal(res.code, 'not_found', '错误码不变');
  assert.match(res.message, /preview host not found/, '可操作提示替代 bare not found');
  assert.match(res.message, /unassigned preview domain or stale bookmark/);
});

test('#57 issuePreviewTicket：返回的预览 URL 按公开入口派生（dev http:8090 / 生产 https）', async () => {
  const session = { user: { id: 'u1', role: 'fde' } };
  // dev：http + 高端口 → 端口进 URL
  const dev = await issuePreviewTicket(makePool().pool, devConfig, { allocationId: 'pa1', session, now: NOW });
  assert.equal(
    dev.url,
    `http://alice-p-4000.fde.erix.vip:8090?preview_ticket=${dev.ticket}`,
    'dev 公开入口的 scheme/端口必须透传到预览 URL',
  );
  // 生产：https 默认端口 → 端口不进 URL
  const prodConfig = { ...config, portalPublicBaseUrl: 'https://station.fde.erix.vip' };
  const prod = await issuePreviewTicket(makePool().pool, prodConfig, { allocationId: 'pa1', session, now: NOW });
  assert.equal(prod.url, `https://alice-p-4000.fde.erix.vip?preview_ticket=${prod.ticket}`);
  // https 带非标端口（dev websecure 8443）→ 端口进 URL
  const tlsConfig = { ...config, portalPublicBaseUrl: 'https://station.fde.erix.vip:8443' };
  const tls = await issuePreviewTicket(makePool().pool, tlsConfig, { allocationId: 'pa1', session, now: NOW });
  assert.equal(tls.url, `https://alice-p-4000.fde.erix.vip:8443?preview_ticket=${tls.ticket}`);
});

// ---- #241：CORS 预检免凭证（预检按规范不带凭据，要凭证就等于封死一切需自定义头的跳端口请求）----
test('#241 isCorsPreflight：仅 OPTIONS + 非空 Access-Control-Request-Method 算预检', () => {
  assert.equal(isCorsPreflight({ method: 'OPTIONS', accessControlRequestMethod: 'POST' }), true);
  assert.equal(isCorsPreflight({ method: 'options', accessControlRequestMethod: 'GET' }), true, '方法大小写不敏感');
  // 非预检（fail-closed 面不扩大）：无 ACRM 的 OPTIONS / 非 OPTIONS 带 ACRM / 空 ACRM / 缺 ACRM
  assert.equal(isCorsPreflight({ method: 'OPTIONS' }), false);
  assert.equal(isCorsPreflight({ method: 'OPTIONS', accessControlRequestMethod: '   ' }), false);
  assert.equal(isCorsPreflight({ method: 'GET', accessControlRequestMethod: 'POST' }), false);
  assert.equal(isCorsPreflight({ method: 'POST', accessControlRequestMethod: 'POST' }), false);
  assert.equal(isCorsPreflight(), false);
});

test('#241 authorizeForwardAuth：预检无凭证→放行（grantKind=preflight，不查凭证、不升级状态）', async () => {
  const { pool, queries } = makePool();
  const res = await authorizeForwardAuth(pool, config, {
    hostname: ALLOC.hostname,
    uri: '/api/leaderboard',
    method: 'OPTIONS',
    accessControlRequestMethod: 'POST',
    scheme: 'http',
    now: NOW,
  });
  assert.equal(res.outcome, 'allow');
  assert.equal(res.status, 200);
  assert.equal(res.grantKind, 'preflight');
  assert.equal(res.preflight, true);
  assert.equal(res.subjectId, null, '预检无主体');
  assert.equal(res.grantId, null);
  assert.equal(res.fdeName, 'alice');
  // 预检不碰凭证表、不做 allocated→active 升级（升级语义仍是「首次凭证放行」）
  assert.ok(!queries.some((q) => /INSERT INTO preview_grants/.test(q)), '预检不得写 grant');
  assert.ok(!queries.some((q) => /SET expires_at/.test(q)), '预检不得滚动续期');
});

test('#241 authorizeForwardAuth：预检**不能**绕过 hostname/state 两条 fail-closed 校验', async () => {
  const { pool } = makePool();
  const pre = { method: 'OPTIONS', accessControlRequestMethod: 'POST', now: NOW };
  const unknown = await authorizeForwardAuth(pool, config, { hostname: 'nope.fde.localhost', ...pre });
  assert.equal(unknown.outcome, 'deny');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.code, 'not_found');

  const { pool: p2 } = makePool({ allocations: [releasedAlloc()] });
  const rel = await authorizeForwardAuth(p2, config, { hostname: ALLOC.hostname, ...pre });
  assert.equal(rel.outcome, 'deny');
  assert.equal(rel.status, 403);
  assert.equal(rel.code, 'allocation_released');

  // 非预检的裸 OPTIONS（无 ACRM）仍必须 403 preview_ticket_required：安全底线不放宽。
  const bare = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, method: 'OPTIONS', now: NOW });
  assert.equal(bare.outcome, 'deny');
  assert.equal(bare.status, 403);
  assert.equal(bare.code, 'preview_ticket_required');
});

// ---------------------------------------------------------------------------
// issue #275：预览访问恒定 403 `allocation_released`——released 历史行遮蔽了活行。
//
// 真机形状（主 agent 在 dev 库 + 已发布的 v0.1.5 镜像上亲手复现）：管理员改块把预览段**搬回曾用号段**
// （22000→22030→22000）⇒ 新活行的 hostname 与上一轮遗留的 released 行**逐字相同**；
// `port_allocations_live_hostname_key` 是**部分**唯一索引（`WHERE state <> 'released'`）⇒ 两行合法共存，
// 而 hostname 上没有全表索引 ⇒ 无 ORDER BY 的 `LIMIT 1` 拿到的是 released ⇒ 第 2 步直接判死：
// 审计 `result=deny`、`grant_kind=NULL`（ticket 分支根本没走到），而面板显示 Allocated、签票返 201。
// ⇒ 下面的种子把 released 行放在**物理序前面**、created_at/released_at 也更晚，就是真机那个形状。
// ---------------------------------------------------------------------------

/** #275 的真机形状：released 历史行（新）在物理序上排在活行（旧）前面。 */
function shadowedAllocations({ history = [], liveOverrides = {} } = {}) {
  const live = { ...ALLOC, id: 'pa-live', created_at: new Date('2026-10-11T15:57:00.000Z'), ...liveOverrides };
  return [...history.map((row) => releasedAlloc(row)), live];
}

// 真库实测的两列时刻：released 由 01:50 的改块留下，活行是 01:52 搬回来的。
const SHADOW_HISTORY = [{
  id: 'pa-hist',
  released_at: new Date('2026-10-13T01:50:00.000Z'),
  created_at: new Date('2026-10-13T01:50:00.000Z'),
}];

test('#275 回归：同 hostname 的 released(较新) 遮蔽 allocated(较旧) ⇒ forward-auth 放行活行（ticket 302、选中 id = 活行）', async () => {
  const { pool, grants } = makePool({ allocations: shadowedAllocations({ history: SHADOW_HISTORY }) });
  // 先复现真机的「签票 201」：面板给出的是**活行 id**，签票本身必成。
  const issued = await issuePreviewTicket(pool, config, {
    allocationId: 'pa-live',
    session: { user: { id: 'u1', role: 'fde' } },
    now: NOW,
  });
  assert.ok(issued.ticket, '签票必须成功（真机 201，坏在下一步的 forward-auth）');

  const res = await authorizeForwardAuth(pool, config, {
    hostname: ALLOC.hostname,
    uri: `/?preview_ticket=${issued.ticket}`,
    scheme: 'http',
    now: NOW,
  });
  assert.notEqual(res.code, 'allocation_released', 'released 历史行不得遮蔽活行（#275 的症状本体）');
  assert.equal(res.outcome, 'redirect');
  assert.equal(res.status, 302);
  assert.equal(res.allocation.id, 'pa-live', '选中的 allocation 必须是活行');
  assert.equal(res.allocation.state, 'allocated');
  assert.equal(res.fdeName, 'alice');
  // 凭证判定真的走到了（而不是被第 2 步短路）：ticket 已消费。
  assert.equal(grants.find((g) => g.kind === 'ticket').state, 'used');
});

test('#275 回归：同一 shadow 形状下稳态预览 cookie 也照样放行（200 + 活行）', async () => {
  const cookie = 's_cookie_under_shadow';
  const { pool, grants } = makePool({ allocations: shadowedAllocations({ history: SHADOW_HISTORY }) });
  grants.push({
    id: 'g-shadow', token_hash: hashToken(cookie), user_id: 'u1', issuer_id: null, allocation_id: 'pa-live',
    parent_ticket_id: 'g-parent', kind: 'session', state: 'active', expires_at: later(600), used_at: null, revoked_at: null,
  });
  const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, cookieValue: cookie, now: NOW });
  assert.equal(res.outcome, 'allow');
  assert.equal(res.status, 200);
  assert.equal(res.allocation.id, 'pa-live');
});

test('#275 契约锁：hostname 只有 released 行（两行）⇒ 仍 403 allocation_released（不得变 404 / 不得变死代码）', async () => {
  // 两条 released 历史行：部分唯一索引对 released **不判重** ⇒ 共存合法；
  // 种子序故意把「旧的」排前面，选到哪条全看排序子句（AGENTS §8.5：不得依赖偶然行序）。
  const history = [
    { id: 'pa-hist-old', released_at: new Date('2026-10-11T06:44:00.000Z'), created_at: new Date('2026-10-11T06:44:00.000Z') },
    { id: 'pa-hist-new', released_at: new Date('2026-10-13T01:50:00.000Z'), created_at: new Date('2026-10-13T01:50:00.000Z') },
  ];
  const { pool } = makePool({ allocations: history.map((row) => releasedAlloc(row)) });
  const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, now: NOW });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.status, 403, '只有 released 行⇒403（若实现退化成「只在 WHERE 里过滤 released」，这里会变成 404）');
  assert.equal(res.code, 'allocation_released');
  assert.equal(res.allocation.id, 'pa-hist-new', 'released 多行时靠 `released_at DESC NULLS LAST` 定序');
});

test('#275 契约锁：released_at 同值的两条 released 行 ⇒ 靠 `a.id` 兼容成全序（两种种子序都选出同一行）', async () => {
  const at = new Date('2026-10-13T01:50:00.000Z');
  for (const ids of [['pa-h-1', 'pa-h-2'], ['pa-h-2', 'pa-h-1']]) {
    const { pool } = makePool({ allocations: ids.map((id) => releasedAlloc({ id, released_at: at, created_at: at })) });
    const res = await authorizeForwardAuth(pool, config, { hostname: ALLOC.hostname, now: NOW });
    assert.equal(res.status, 403);
    assert.equal(res.allocation.id, 'pa-h-1', `种子序 [${ids}] 下也必须选出同一行`);
  }
});

test('#275 契约锁：hostname 一行都查不到 ⇒ 404 not_found（不得被挤成 403）', async () => {
  const { pool } = makePool({ allocations: shadowedAllocations({ history: SHADOW_HISTORY }) });
  const res = await authorizeForwardAuth(pool, config, { hostname: 'nobody-p-22999.fde.erix.vip', now: NOW });
  assert.equal(res.outcome, 'deny');
  assert.equal(res.status, 404);
  // 契约码：§1.2 与 §2.7 第 1 步定的是 `not_found`（#57 已钉「错误码不变」）。
  // ⚠ issue #275 工单把它叫 `allocation_not_found`，仓内从无此码 ⇒ **不新造错误码**，沿用既有契约。
  assert.equal(res.code, 'not_found');
});

test('#275 fake 自证：部分唯一索引真的建模了（released 不占位；两条同名活行 ⇒ 23505 真库原文）', () => {
  assert.throws(
    () => new PreviewPool({ allocations: [{ ...ALLOC, id: 'a' }, { ...ALLOC, id: 'b' }] }),
    (err) => {
      assert.equal(err.code, '23505', '错误形状必须与真库一致（SQLSTATE）');
      assert.match(err.message, /duplicate key value violates unique constraint "port_allocations_live_hostname_key"/);
      assert.match(err.message, /already exists/);
      return true;
    },
    'fake 必须拦同名活行，否则它测的是真库不存在的形状（§8.14）',
  );
  // released 行不占位 ⇒ 同名两行 released + 一行活行能共存（不靠这个形状，#275 在读侧根本测不出来）。
  const ok = new PreviewPool({ allocations: [releasedAlloc({ id: 'h1' }), releasedAlloc({ id: 'h2' }), { ...ALLOC, id: 'live' }] });
  assert.equal(ok.allocations.length, 3, 'released 不占位 ⇒ 三条同名行合法共存');
});

test('#275 读侧护栏（源码级）：hostname 查表必须自带「活行优先 + 全序」，不得退化成 WHERE 里过滤 released', async () => {
  const source = await fs.readFile(new URL('../src/preview.js', import.meta.url), 'utf8');
  const start = source.indexOf('FROM port_allocations a');
  const lookup = source.slice(start, source.indexOf('const allocation = r.rows', start));
  assert.ok(lookup.length > 80, '查表 SQL 块可定位');
  assert.match(lookup, /WHERE a\.hostname = \$1/, '谓词仍是 hostname 精确匹配');
  assert.match(
    lookup,
    /ORDER BY \(a\.state <> 'released'\) DESC, a\.released_at DESC NULLS LAST, a\.id/,
    '活行优先 + 确定全序（AGENTS §8.5）',
  );
  assert.match(lookup, /\bLIMIT 1\b/, '取单行');
  const whereClause = lookup.slice(lookup.indexOf('WHERE'), lookup.indexOf('ORDER BY'));
  assert.doesNotMatch(whereClause, /a\.state\s*<>\s*'released'/, 'WHERE 里不得过滤 released：那会让 allocation_released 变死代码、把 403 改写成 404');
});
