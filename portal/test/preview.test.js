// 单测：preview.js —— ticket 签发（存哈希）/ forward-auth 校验（有效→302/200、无效→401、过期→401、重放→403、无凭证→403、released→403）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  parsePreviewTicket,
  stripPreviewTicket,
  derivePreviewSessionToken,
  issuePreviewTicket,
  authorizeForwardAuth,
} from '../src/preview.js';
import { hashToken } from '../src/auth.js';

const KEY = 'test-signing-key';
const NOW = new Date('2026-09-16T00:00:00.000Z');
const later = (s) => new Date(NOW.getTime() + s * 1000);

/** in-memory preview pool：建模 port_allocations / users / preview_grants（含事务 client）。 */
class PreviewPool {
  constructor({ allocations = [], users = [], grants = [] } = {}) {
    this.allocations = allocations;
    this.users = users;
    this.grants = grants;
    this.grantSeq = 100;
  }
  dispatch(sql, params = []) {
    // 事务原语
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };

    if (sql.includes('FROM port_allocations a')) {
      const host = params[0];
      const a = this.allocations.find((x) => x.hostname === host);
      return { rows: a ? [{ ...a }] : [] };
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
  state: 'allocated',
  exposure: 'private',
  hostname: 'alice-p-proj1-4000.fde.localhost',
  url: 'https://alice-p-proj1-4000.fde.localhost',
  fde_name: 'alice',
  user_status: 'active',
};

function makePool(overrides = {}) {
  const allocations = overrides.allocations ?? [ALLOC];
  const users = overrides.users ?? [{ id: 'u1', role: 'fde', status: 'active' }];
  const pool = new PreviewPool({ allocations, users, grants: overrides.grants ?? [] });
  return { pool, grants: pool.grants };
}

const config = {
  previewTicketTtlSeconds: 60,
  previewSessionTtlSeconds: 900,
  previewSessionSigningKey: KEY,
};

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
  assert.equal(out.url, `https://alice-p-proj1-4000.fde.localhost?preview_ticket=${out.ticket}`);
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
  const { pool: p2 } = makePool({ allocations: [{ ...ALLOC, state: 'released' }] });
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

  const { pool: p2 } = makePool({ allocations: [{ ...ALLOC, state: 'released' }] });
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
  const allocB = { ...ALLOC, id: 'pa2', hostname: 'bob-p-proj1-4000.fde.localhost', url: 'https://bob-p-proj1-4000.fde.localhost' };
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
