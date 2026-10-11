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
  normalizeHostHeader,
  isCorsPreflight,
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
    this.queries = [];
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
  state: 'allocated',
  exposure: 'private',
  // #57 阶段2 伞域 grammar：<fde>-p-<port4>.<BASE_DOMAIN>（BASE_DOMAIN = fde.<可注册域>）。
  hostname: 'alice-p-4000.fde.erix.vip',
  url: 'https://alice-p-4000.fde.erix.vip',
  fde_name: 'alice',
  user_status: 'active',
};

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

  const { pool: p2 } = makePool({ allocations: [{ ...ALLOC, state: 'released' }] });
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
