// issue #234（工单 feat-261013-01）：跨站写请求防线（Origin / Sec-Fetch-Site 同源校验）。
// 两层：① `checkSameOrigin` / `csrfGateFor` 纯判据（判据 a/b/c/d 逐支 + 归一化 + 畸形）；
// ② createServer + FakePool 的 HTTP 层（403 `cross_origin_forbidden`、CORS deny 头、审计、豁免端点、GET/SSE 不受影响）。
// 口径的单一真相：docs/api/portal.md §2.11。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, checkSameOrigin, csrfGateFor } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

// ---------------------------------------------------------------------------
// ① 纯判据：判据 a/b/c/d 逐支
// ---------------------------------------------------------------------------

const PORTAL_HOST = 'station.fde.erix.vip';
const PORTAL_ORIGIN = `https://${PORTAL_HOST}`;
// dev 形态：现网入口带非默认端口（station.fde.erix.vip:8090 / 100.100.0.3:8090）
const DEV_HOST = 'station.fde.erix.vip:8090';
const DEV_ORIGIN = `http://${DEV_HOST}`;

test('#234 判据 a：Sec-Fetch-Site=cross-site / cross-origin 一律拒（fail-closed 优先于 Origin）', () => {
  for (const sfs of ['cross-site', 'cross-origin', 'CROSS-SITE', ' cross-site ']) {
    // Origin 缺失也拒（旧写法「没 Origin 就放行」在这里必须红）
    const bare = checkSameOrigin({ method: 'POST', secFetchSiteHeader: sfs, hostHeader: DEV_HOST });
    assert.equal(bare.allow, false, `${sfs} 无 Origin 也必须拒`);
    assert.equal(bare.verdict, 'cross_site');
    // Origin 看起来同源也拒（SFS 是浏览器给的，不可伪造，优先级高于 Origin）
    const withSameOrigin = checkSameOrigin({
      method: 'DELETE', secFetchSiteHeader: sfs, originHeader: DEV_ORIGIN, hostHeader: DEV_HOST,
    });
    assert.equal(withSameOrigin.allow, false, `${sfs} 即使 Origin 同源也必须拒`);
    assert.equal(withSameOrigin.verdict, 'cross_site');
  }
});

test('#234 判据 b：Sec-Fetch-Site=same-origin / same-site 放行（即使 Origin 缺失或畸形）', () => {
  for (const sfs of ['same-origin', 'same-site', 'SAME-ORIGIN']) {
    assert.equal(checkSameOrigin({ method: 'POST', secFetchSiteHeader: sfs, hostHeader: DEV_HOST }).allow, true);
    // 无 Origin（Safari 旧版、部分隐私模式）⇒ 判据 b 已定论，不进 Origin 判据
    assert.equal(
      checkSameOrigin({ method: 'PUT', secFetchSiteHeader: sfs, hostHeader: DEV_HOST }).verdict,
      'same_site',
    );
    // Origin 畸形也不影响：b 在 c 之前定论
    assert.equal(
      checkSameOrigin({ method: 'PATCH', secFetchSiteHeader: sfs, originHeader: 'http://a b', hostHeader: DEV_HOST }).allow,
      true,
    );
  }
});

test('#234 判据 c：Origin 的 authority 与请求自身 authority 比对（相等放行、不等拒）', () => {
  const allow = checkSameOrigin({ method: 'POST', originHeader: PORTAL_ORIGIN, hostHeader: PORTAL_HOST });
  assert.equal(allow.allow, true);
  assert.equal(allow.verdict, 'origin_match');

  const deny = checkSameOrigin({
    method: 'POST', originHeader: 'https://evil.example', hostHeader: PORTAL_HOST,
  });
  assert.equal(deny.allow, false);
  assert.equal(deny.verdict, 'origin_mismatch');
  // details 三件套（不含 cookie）
  assert.deepEqual(Object.keys(deny.details).sort(), ['method', 'origin', 'sec_fetch_site']);
  assert.equal(deny.details.origin, 'https://evil.example');
  assert.equal(deny.details.sec_fetch_site, null);
  assert.equal(deny.details.method, 'POST');
});

test('#234 判据 c：只比 authority 不比 scheme（http/https 混合部署期不得误杀）', () => {
  // Origin 是 http、Host 不带 scheme（Traefik 卸载 TLS 的常态）⇒ 同源
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://station.fde.erix.vip', hostHeader: PORTAL_HOST }).allow,
    true,
    'scheme 不参与比对',
  );
  // 默认端口归一化：Origin 的 :80（http）/ :443（https）与 Host 的无端口等价
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'https://station.fde.erix.vip:443', hostHeader: PORTAL_HOST }).allow,
    true,
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://station.fde.erix.vip:80', hostHeader: 'station.fde.erix.vip:80' }).allow,
    true,
  );
  // 非默认端口必须保留：Origin 的 :443 在 http 形态下不是默认端口 ⇒ 与无端口 Host 不等 ⇒ 拒
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://station.fde.erix.vip:443', hostHeader: PORTAL_HOST }).allow,
    false,
    '非默认端口不得被当成默认端口剥掉',
  );
});

test('#234 判据 c：X-Forwarded-Host 优先于 Host（Traefik trustForwardHeader=false 会按真实连接覆写）', () => {
  // 容器内部视角的 Host 是 service 名，真实入口在 XFH
  assert.equal(
    checkSameOrigin({
      method: 'POST', originHeader: PORTAL_ORIGIN, hostHeader: 'station-portal:8080', forwardedHostHeader: PORTAL_HOST,
    }).allow,
    true,
    '取 XFH 而非 Host ⇒ 放行',
  );
  assert.equal(
    checkSameOrigin({
      method: 'POST', originHeader: 'https://evil.example', hostHeader: PORTAL_HOST, forwardedHostHeader: 'other.example',
    }).allow,
    false,
    '有 XFH 时不得回落到 Host',
  );
  // XFH 空串视为「没有」⇒ 回落 Host
  assert.equal(
    checkSameOrigin({
      method: 'POST', originHeader: PORTAL_ORIGIN, hostHeader: PORTAL_HOST, forwardedHostHeader: '   ',
    }).allow,
    true,
  );
});

test('#234 判据 c（dev 形态）：Host 带 :8090 与 Origin :8090 匹配；Origin 端口不同则拒', () => {
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: DEV_ORIGIN, hostHeader: DEV_HOST }).allow,
    true,
    'station.fde.erix.vip:8090 ↔ http://station.fde.erix.vip:8090',
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://station.fde.erix.vip:8091', hostHeader: DEV_HOST }).allow,
    false,
    '端口是 origin 的一部分，不得忽略',
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: DEV_ORIGIN, hostHeader: 'station.fde.erix.vip' }).allow,
    false,
    'Host 没端口而 Origin 有 :8090 ⇒ 不等 ⇒ 拒',
  );
  // 第二个入口（IP 形态）同样天然支持，无需配置项
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://100.100.0.3:8090', hostHeader: '100.100.0.3:8090' }).allow,
    true,
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: DEV_ORIGIN, hostHeader: '100.100.0.3:8090' }).allow,
    false,
    '两个入口互不充当对方的同源基线',
  );
});

test('#234 判据 c：大小写不敏感 + 首尾空白归一化 + IPv6 字面量', () => {
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'HTTPS://Station.FDE.erix.vip', hostHeader: 'station.fde.erix.vip' }).allow,
    true,
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: `  ${DEV_ORIGIN}  `, hostHeader: DEV_HOST }).allow,
    true,
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://[::1]:8090', hostHeader: '[::1]:8090' }).allow,
    true,
    'IPv6 字面量的端口不得被当成 host 的一部分',
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', originHeader: 'http://[::1]:8090', hostHeader: '[::1]:8091' }).allow,
    false,
  );
});

test('#234 判据 d：Origin 与 Sec-Fetch-Site 都没有 ⇒ 放行（curl / CLI / 容器内脚本）', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const r = checkSameOrigin({ method, hostHeader: DEV_HOST });
    assert.equal(r.allow, true, `${method} 无 Origin 无 SFS 必须放行`);
    assert.equal(r.verdict, 'no_evidence');
  }
  // 空串形态（部分客户端发 `Origin:`）同判「没有」
  assert.equal(checkSameOrigin({ method: 'POST', originHeader: '', hostHeader: DEV_HOST }).allow, true);
  assert.equal(checkSameOrigin({ method: 'POST', originHeader: '  ', hostHeader: DEV_HOST }).allow, true);
  // SFS 的未知值不当结论（`none` = 本地发起；拼错的值）⇒ 继续走 Origin/无证据
  assert.equal(
    checkSameOrigin({ method: 'POST', secFetchSiteHeader: 'none', hostHeader: DEV_HOST }).verdict,
    'no_evidence',
  );
  assert.equal(
    checkSameOrigin({ method: 'POST', secFetchSiteHeader: 'whatever', hostHeader: DEV_HOST }).verdict,
    'no_evidence',
  );
});

test('#234 判据①：只有写方法参与校验（GET/HEAD/OPTIONS 一律放行）', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'Trace']) {
    const r = checkSameOrigin({
      method, originHeader: 'https://evil.example', secFetchSiteHeader: 'cross-site', hostHeader: PORTAL_HOST,
    });
    assert.equal(r.allow, true, `${method} 不得被防线打断`);
    assert.equal(r.verdict, 'read_method');
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.equal(
      checkSameOrigin({ method, originHeader: 'https://evil.example', hostHeader: PORTAL_HOST }).allow,
      false,
      `${method} 必须参与校验（方法名大小写不敏感）`,
    );
  }
  // 方法缺失（异常形态）⇒ 不是写方法 ⇒ 放行（不误杀）
  assert.equal(checkSameOrigin({ originHeader: 'https://evil.example', hostHeader: PORTAL_HOST }).allow, true);
});

test('#234 畸形 Origin 一律拒：多值 / 含空格 / 含 CR-LF / 不可解析 / 带路径 / null', () => {
  const malformed = [
    'http://a.test, http://b.test', // Node 把重复 Origin 头拼成这个形状
    'http://a.test http://b.test',
    'http://a b',
    'http://a.test\r\nX-Evil: 1',
    'http://a.test\thttp://c.test',
    'garbage',
    'http://a.test/path', // Origin 不带路径（与 #241 CORS_ORIGIN_RE 同口径）
    'null', // opaque origin（sandboxed iframe / file:）
    'javascript:alert(1)',
    'http://',
    `http://${'a'.repeat(2100)}`,
  ];
  for (const originHeader of malformed) {
    const r = checkSameOrigin({ method: 'POST', originHeader, hostHeader: DEV_HOST });
    assert.equal(r.allow, false, `畸形 Origin 必须拒，绝不「解析失败当同源」：${JSON.stringify(originHeader)}`);
    assert.equal(r.verdict, 'malformed_origin');
    assert.equal(r.details.origin, originHeader, 'details 里原样留原文（可观测）');
  }
});

test('#234 有 Origin 但没有任何可比对的 Host ⇒ 拒（不默认放行）', () => {
  assert.equal(checkSameOrigin({ method: 'POST', originHeader: PORTAL_ORIGIN }).allow, false);
  assert.equal(checkSameOrigin({ method: 'POST', originHeader: PORTAL_ORIGIN }).verdict, 'missing_request_authority');
  // Host 本身畸形（多值 / 空白 / 带 scheme）⇒ 同样拒，不回落
  for (const hostHeader of ['a.test, b.test', 'a b', 'https://a.test', '']) {
    const r = checkSameOrigin({ method: 'POST', originHeader: PORTAL_ORIGIN, hostHeader });
    assert.equal(r.allow, false, `畸形 Host 必须拒：${JSON.stringify(hostHeader)}`);
  }
});

// ---- 豁免端点（纯函数层） ----
const req = (over = {}) => ({ method: 'POST', headers: { host: DEV_HOST, origin: 'https://evil.example', ...over } });

test('#234 豁免：/api/internal/* 与 /api/forward-auth 不进防线（无 cookie 语义 / Origin 天然是被代理页面的）', () => {
  for (const pathname of ['/api/internal/claim', '/api/internal/runs/r1/events', '/api/internal/stream']) {
    assert.equal(csrfGateFor(req(), pathname).allow, true, `${pathname} 必须豁免`);
    assert.equal(csrfGateFor(req({ 'sec-fetch-site': 'cross-site' }), pathname).allow, true);
  }
  assert.equal(csrfGateFor(req(), '/api/forward-auth').allow, true, 'forward-auth 的 Origin 是被代理页面的 origin');
  assert.equal(csrfGateFor(req({ 'sec-fetch-site': 'cross-site' }), '/api/forward-auth').allow, true);
  // 其余端点进防线
  for (const pathname of ['/api/sessions', '/api/auth/login', '/api/internal', '/api/forward-auth/x']) {
    assert.equal(csrfGateFor(req(), pathname).allow, false, `${pathname} 必须进防线`);
  }
  // 读方法放行（豁免之外的第二道「不受影响」）
  assert.equal(csrfGateFor({ method: 'GET', headers: req().headers }, '/api/sessions/x/events').allow, true);
  assert.equal(csrfGateFor({ method: 'HEAD', headers: req().headers }, '/api/me').allow, true);
  assert.equal(csrfGateFor({ method: 'OPTIONS', headers: req().headers }, '/api/sessions').allow, true);
});

// ---------------------------------------------------------------------------
// ② HTTP 层集成（createServer + FakePool）
// ---------------------------------------------------------------------------

async function startServer({ pool: customPool, users = [] } = {}) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-csrf-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  fs.mkdirSync(path.join(staticDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(staticDir, 'app', 'index.html'), 'SECRET_VUE_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 20, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: {
      maxFailures: 20, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 20, maxEntries: 10000,
    },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  const pool = customPool || new FakePool({ users });
  const server = createServer({ pool, config, log: { error() {}, warn() {}, log() {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server, pool, config, base, staticDir,
    close: () => new Promise((res) => server.close(res)),
  };
}

/** 用「dev 入口」的形态发请求：XFH + Origin 都写 station.fde.erix.vip:8090（Host 由 undici 定，防线取 XFH）。 */
function devHeaders(extra = {}) {
  return { 'x-forwarded-host': DEV_HOST, origin: DEV_ORIGIN, ...extra };
}

async function loginWithPassword(s, { password = 'correct horse battery staple', extra = {} } = {}) {
  const r = await fetch(`${s.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify({ login: 'alice', password }),
  });
  return r;
}

function csrfDenials(pool) {
  return pool.audit.filter((a) => a.action === 'auth.csrf_denied');
}

/** 读错误信封里的 code（非 JSON / 无体 → null）。 */
async function errorCode(res) {
  try {
    return (await res.json())?.error?.code ?? null;
  } catch {
    return null;
  }
}

// SSE 用的会话池（照搬 session-http.test.js 的 SessionSsePool 口径）：GET /api/sessions/:id/events 要真过通。
const SSE_USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SSE_SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const SSE_TOKEN = 'csrf-sse-token';

class CsrfSsePool extends FakePool {
  constructor() {
    super({ users: [SSE_USER] });
    this.sessions.push({
      id: 'sse-login-session', user_id: SSE_USER.id, token_hash: auth.hashToken(SSE_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.sessionRow = {
      id: SSE_SESSION_ID, user_id: SSE_USER.id, project_id: 'p1', title: 't', model: null,
      status: 'active', last_seq: 5, project_name: 'proj1',
    };
  }

  async query(sql, params = []) {
    if (sql.includes('FROM chat_sessions s')) return { rows: [this.sessionRow] };
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM run_events')) return { rows: [] };
    return super.query(sql, params);
  }
}

test('#234 用例①（issue 明写）：跨站 POST 带 session cookie ⇒ 403 cross_origin_forbidden，且不落到底层副作用', async () => {
  const s = await startServer();
  const password = 'correct horse battery staple';
  const user = {
    id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
    auth_source: 'local', status: 'active', password_hash: await auth.hashPassword(password),
    totp_secret: null, last_totp_step: null,
  };
  s.pool.users.push(user);
  const token = 'csrf-test-token';
  s.pool.sessions.push({
    id: 'csrf-session', user_id: 'u1', token_hash: auth.hashToken(token),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000), last_seen_at: new Date(), revoked_at: null,
  });
  try {
    const res = await fetch(`${s.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `${s.config.cookie.name}=${token}`, origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403, '跨站带 cookie 的写请求必须 403');
    const body = await res.json();
    assert.equal(body.error.code, 'cross_origin_forbidden');
    assert.equal(body.error.retryable, false);
    assert.deepEqual(body.error.details, { origin: 'https://evil.example', sec_fetch_site: null, method: 'POST' });
    // 关键：防线在 handler 之前 ⇒ 登出这个副作用根本没发生（cookie 仍有效）
    assert.equal(s.pool.sessions[0].revoked_at, null, '拒绝必须发生在副作用之前');
    assert.equal(csrfDenials(s.pool).length, 1);
    assert.equal(csrfDenials(s.pool)[0].actor_id, null);
    assert.equal(csrfDenials(s.pool)[0].target, '/api/auth/logout');
    assert.ok(!JSON.stringify(csrfDenials(s.pool)[0]).includes(token), '审计不含 cookie');

    // 同源形态（浏览器同源 POST 必带 Origin）不受影响：登出真的发生
    const same = await fetch(`${s.base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: `${s.config.cookie.name}=${token}`, origin: `http://127.0.0.1:${new URL(s.base).port}` },
    });
    assert.equal(same.status, 204, '同源 POST 正常走完 handler');
    assert.ok(s.pool.sessions[0].revoked_at, '同源登出副作用已发生');
  } finally {
    await s.close();
  }
});

test('#234 用例②/③/④/⑤：同源 200 / 无 Origin 放行 / cross-site 无 Origin 拒 / same-origin 无 Origin 放行', async () => {
  const password = 'correct horse battery staple';
  const s = await startServer({
    users: [{
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
      auth_source: 'local', status: 'active', password_hash: await auth.hashPassword(password),
      totp_secret: null, last_totp_step: null,
    }],
  });
  try {
    // ② 同源 POST（Origin == 请求自身 authority）⇒ 200
    const same = await loginWithPassword(s, { extra: devHeaders() });
    assert.equal(same.status, 200);
    assert.equal((await same.json()).status, 'authenticated');

    // ③ 无 Origin 无 SFS（curl / CLI / 现有 e2e）⇒ 放行
    const bare = await loginWithPassword(s);
    assert.equal(bare.status, 200);

    // ④ cross-site 且无 Origin ⇒ 拒（旧写法「没 Origin 就放行」在这里红）
    const crossNoOrigin = await loginWithPassword(s, { extra: { 'x-forwarded-host': DEV_HOST, 'sec-fetch-site': 'cross-site' } });
    assert.equal(crossNoOrigin.status, 403);
    assert.equal((await crossNoOrigin.json()).error.code, 'cross_origin_forbidden');

    // ⑤ same-origin 且无 Origin ⇒ 放行
    const sameNoOrigin = await loginWithPassword(s, { extra: { 'x-forwarded-host': DEV_HOST, 'sec-fetch-site': 'same-origin' } });
    assert.equal(sameNoOrigin.status, 200);

    // 登录端点也在防线之内（登录 CSRF ⇒ 用户被种成攻击者的会话）
    const crossTotp = await fetch(`${s.base}/api/auth/login/totp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ pending_token: 'x', code: '000000' }),
    });
    assert.equal(crossTotp.status, 403);
    assert.equal((await crossTotp.json()).error.code, 'cross_origin_forbidden');
    assert.equal(csrfDenials(s.pool).length, 2);
  } finally {
    await s.close();
  }
});

test('#234 用例⑥：GET（含 SSE）与 HEAD/OPTIONS 不受影响', async () => {
  const s = await startServer({ pool: new CsrfSsePool() });
  const token = SSE_TOKEN;
  const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
  try {
    const me = await fetch(`${s.base}/api/me`, {
      headers: { cookie: `${s.config.cookie.name}=${token}`, ...crossSite },
    });
    assert.equal(me.status, 200, 'GET 即使 cross-site 也放行');

    const sse = await fetch(`${s.base}/api/sessions/${SSE_SESSION_ID}/events`, {
      headers: { cookie: `${s.config.cookie.name}=${token}`, accept: 'text/event-stream', ...crossSite },
    });
    assert.equal(sse.status, 200, 'SSE GET 不得被打断');
    assert.match(sse.headers.get('content-type') ?? '', /text\/event-stream/);
    await sse.body?.cancel().catch(() => {});

    const head = await fetch(`${s.base}/api/me`, { method: 'HEAD', headers: { cookie: `${s.config.cookie.name}=${token}`, ...crossSite } });
    assert.notEqual(head.status, 403);
    const options = await fetch(`${s.base}/api/sessions`, { method: 'OPTIONS', headers: crossSite });
    assert.notEqual(options.status, 403, 'OPTIONS（含 CORS 预检）一律放行');

    const health = await fetch(`${s.base}/api/health`, { headers: crossSite });
    assert.notEqual(await errorCode(health), 'cross_origin_forbidden', '/api/health（route 层，不经 routeApi）同样不受影响');
    const projects = await fetch(`${s.base}/api/projects`, {
      headers: { cookie: `${s.config.cookie.name}=${token}`, ...crossSite },
    });
    assert.notEqual(await errorCode(projects), 'cross_origin_forbidden', 'routeApi 里的 GET 一律不得被这道防线拒');
    assert.notEqual(projects.status, 403);
    assert.equal(csrfDenials(s.pool).length, 0, 'GET/HEAD/OPTIONS 一条审计都不许写');
  } finally {
    await s.close();
  }
});

test('#234 用例⑦/⑧：/api/internal/* 与 /api/forward-auth 不受影响（即便带跨站 Origin）', async () => {
  const internalCalls = [];
  const pool = {
    audit: [],
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO audit_log')) {
        this.audit.push({ actor_id: params[0], action: params[1], target: params[2], details: params[3] });
        return { rows: [] };
      }
      if (sql.includes('FROM containers c')) {
        internalCalls.push(params[0]);
        return {
          rows: [{
            container_id: 'c1', user_id: 'u1', revoked_at: null, container_status: 'running',
            fde_name: 'alice', container_name: 'erix_fde_alice', token_generation: 1,
            login: 'alice', display_name: 'Alice', email: 'a@a.test', user_status: 'active',
          }],
        };
      }
      if (sql.includes('FROM port_allocations a')) {
        return {
          rows: [{
            id: 'pa1', fde_id: 'u1', state: 'allocated', exposure: 'private',
            hostname: 'alice-p-4100.fde.erix.vip', fde_name: 'alice', user_status: 'active',
          }],
        };
      }
      return { rows: [] };
    },
    async end() {},
  };
  const s = await startServer({ pool });
  // 内部端点的容器 token（hashToken 后可被上面的 fake 查到）
  const containerToken = 'container-runner-token';
  const crossSite = { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' };
  try {
    // 用真 hashToken 反查：把 token 直接塞进 header，fake pool 不按 hash 比对，直接命中
    const claim = await fetch(`${s.base}/api/internal/heartbeat`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${containerToken}`,
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ run_id: '00000000-0000-4000-8000-000000000002', status: 'ok' }),
    });
    assert.notEqual(claim.status, 403, `/api/internal/* 不得被 CSRF 拦成 403（实际 ${claim.status}）`);
    assert.notEqual((await claim.json()).error?.code, 'cross_origin_forbidden');
    assert.ok(internalCalls.length > 0, '内部端点确实进到了 token 鉴权（不是被 CSRF 提前拦掉）');

    const internalStream = await fetch(`${s.base}/api/internal/stream`, { headers: crossSite });
    assert.notEqual(internalStream.status, 403, 'GET /api/internal/stream 同理不受影响');

    // /api/forward-auth：它的 Origin 是被代理页面的 origin（天然 ≠ portal host），必须豁免
    const fa = await fetch(`${s.base}/api/forward-auth`, {
      method: 'POST',
      headers: { 'x-forwarded-host': 'alice-p-4100.fde.erix.vip:8090', 'x-forwarded-method': 'POST', ...crossSite },
    });
    const faBody = await fa.json();
    assert.equal(faBody.error.code, 'preview_ticket_required', 'forward-auth 仍走自己的票据判定，不是 CSRF');
    assert.notEqual(faBody.error.code, 'cross_origin_forbidden');
    assert.equal(csrfDenials(pool).length, 0, '两类豁免端点不得写 csrf_denied 审计');
  } finally {
    await s.close();
  }
});

test('#234 用例⑨（dev 形态）：XFH/Host 带 :8090 与 Origin :8090 匹配；Origin 端口不同则拒', async () => {
  const password = 'correct horse battery staple';
  const s = await startServer({
    users: [{
      id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
      auth_source: 'local', status: 'active', password_hash: await auth.hashPassword(password),
      totp_secret: null, last_totp_step: null,
    }],
  });
  try {
    const match = await loginWithPassword(s, { extra: { 'x-forwarded-host': DEV_HOST, origin: DEV_ORIGIN } });
    assert.equal(match.status, 200, 'station.fde.erix.vip:8090 ↔ http://station.fde.erix.vip:8090');

    const portMismatch = await loginWithPassword(s, {
      extra: { 'x-forwarded-host': DEV_HOST, origin: 'http://station.fde.erix.vip:8091' },
    });
    assert.equal(portMismatch.status, 403, 'Origin 端口不同 ⇒ 拒');
    assert.equal((await portMismatch.json()).error.code, 'cross_origin_forbidden');

    const noPort = await loginWithPassword(s, {
      extra: { 'x-forwarded-host': DEV_HOST, origin: 'http://station.fde.erix.vip' },
    });
    assert.equal(noPort.status, 403, '非默认端口不得被当默认端口剥掉');

    // 第二个入口（IP 形态）同样放行 —— 同源基线从 Host 派生，无需配置项
    const ipEntry = await loginWithPassword(s, {
      extra: { 'x-forwarded-host': '100.100.0.3:8090', origin: 'http://100.100.0.3:8090' },
    });
    assert.equal(ipEntry.status, 200);
    assert.equal(csrfDenials(s.pool).length, 2);
  } finally {
    await s.close();
  }
});

test('#234 用例⑩：畸形 Origin（多值 / 含空格）在 HTTP 层就被拒', async () => {
  const s = await startServer();
  try {
    for (const origin of ['http://a.test, http://b.test', 'http://a.test http://c.test', 'http://a b', 'null', 'http://a.test/path']) {
      const res = await fetch(`${s.base}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-host': DEV_HOST, origin },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 403, `畸形 Origin 必须 403：${origin}`);
      const body = await res.json();
      assert.equal(body.error.code, 'cross_origin_forbidden');
      assert.equal(body.error.details.origin, origin, 'details 原样留原文，便于排障');
    }
    assert.equal(csrfDenials(s.pool).length, 5);
  } finally {
    await s.close();
  }
});

test('#234 用例⑪：拒绝响应带 ACAO/ACAC/Vary（#241 口径），状态码仍是 403', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': DEV_HOST, origin: 'https://evil.example' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403, '加 CORS 头不得改状态码（安全底线）');
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://evil.example', '回显 Origin（带凭据不能用 *）');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(res.headers.get('vary'), 'Origin');
    const body = await res.json();
    assert.equal(body.error.code, 'cross_origin_forbidden', '错误信封形状不变（§1.1）');
    assert.equal(body.error.retryable, false);

    // 无 Origin（curl）⇒ 不凭空造 CORS 头，但防线仍按 SFS 生效
    const noOriginCross = await fetch(`${s.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': DEV_HOST, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({}),
    });
    assert.equal(noOriginCross.status, 403);
    assert.equal(noOriginCross.headers.get('access-control-allow-origin'), null, '无 Origin 不回显（同 #241）');
    assert.equal(noOriginCross.headers.get('vary'), null);

    // 畸形 Origin（含空格）⇒ 不回显（防响应头注入），状态码仍 403
    const malformed = await fetch(`${s.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': DEV_HOST, origin: 'http://a b' },
      body: JSON.stringify({}),
    });
    assert.equal(malformed.status, 403);
    assert.equal(malformed.headers.get('access-control-allow-origin'), null);
  } finally {
    await s.close();
  }
});

test('#234 审计：details 恰为 {origin, sec_fetch_site, method}，actor_id NULL，target 剥离 query', async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/sessions?preview_ticket=SECRET&TOKEN`, {
      method: 'DELETE',
      headers: { 'x-forwarded-host': DEV_HOST, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(res.status, 403);
    const denials = csrfDenials(s.pool);
    assert.equal(denials.length, 1);
    assert.equal(denials[0].actor_id, null);
    assert.equal(denials[0].target, '/api/sessions', 'F2 口径：target 只记 path，query 绝不入审计');
    const details = JSON.parse(denials[0].details);
    assert.deepEqual(details, { origin: 'https://evil.example', sec_fetch_site: 'cross-site', method: 'DELETE' });
    assert.ok(!denials[0].details.includes('SECRET'), 'query 里的 ticket 明文不得入审计');
  } finally {
    await s.close();
  }
});

test('#234 审计写失败（DB 挂）不影响 403 响应', async () => {
  const pool = new FakePool({ users: [] });
  pool.query = async (sql, params = []) => {
    if (sql.includes('INSERT INTO audit_log')) throw new Error('db down');
    return FakePool.prototype.query.call(pool, sql, params);
  };
  const s = await startServer({ pool });
  try {
    const res = await fetch(`${s.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-host': DEV_HOST, origin: 'https://evil.example' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 403, '审计失败必须被吞掉，响应照常 403');
    assert.equal((await res.json()).error.code, 'cross_origin_forbidden');
  } finally {
    await s.close();
  }
});
