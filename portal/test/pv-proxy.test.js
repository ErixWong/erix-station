// HTTP 级集成测试（#366）：/api/file 的 mode 三形态、/api/preview-tickets 签发、
// /pv/<code> 反代闸门（会话/归属/过期/路径白名单/onlinePreview 重写/HTML 前缀改写）。
// 假 kk：真 http server 绑 127.0.0.1 随机口，config.kkInternalBaseUrl 注入——闸门到上游
// 这一段走真实 fetch，不 mock 网络层（mock fetch 会绕过 header 语义，正是本单要钉的东西）。
// 隔离约定：tmp userspace + FakePool + 手工 session，与 http.test.js 同套路。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { signPreviewCode } from '../src/previewproxy.js';
import { FakePool } from './fake-pool.js';

const SECRET = 'test-pv-signing-key';
const USER = {
  id: 'b0000000-0000-4000-8000-000000000002', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const OTHER = {
  id: 'b0000000-0000-4000-8000-000000000003', login: 'bob', display_name: 'Bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
};

async function startStack({ files = {}, kkHandler, kkDead = false } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-pv-'));
  const proj = path.join(userspace, 'alice', 'projects', 'demo');
  fs.mkdirSync(proj, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(proj, name), content);

  // 假 kk：回什么由用例给；记录每请求（path + headers）供断言。
  const kkReqs = [];
  const kk = http.createServer((req, res) => {
    kkReqs.push({ url: req.url, headers: req.headers });
    const fn = kkHandler ?? ((_req, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html><body>kk</body></html>'); });
    fn(req, res);
  });
  await new Promise((r) => kk.listen(0, '127.0.0.1', r));
  const kkPort = kk.address().port;
  if (kkDead) {
    // 把假 kk 直接关掉，留个没人听的端口给 portal（connect refused → 502 分支）。
    await new Promise((r) => kk.close(r));
  }

  const pool = new FakePool({ users: [USER, OTHER] });
  for (const [u, token] of [[USER, 'alice-tok'], [OTHER, 'bob-tok']]) {
    pool.sessions.push({
      id: `s-${u.login}`, user_id: u.id, token_hash: hashToken(token),
      created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-')),
    userSpaceRoot: userspace,
    previewSessionSigningKey: SECRET,
    kkInternalBaseUrl: `http://127.0.0.1:${kkPort}`,
  };
  const server = createServer({ pool, config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    userspace, proj, pool, kkReqs,
    cookie: 'fde_session_dev=alice-tok',
    bobCookie: 'fde_session_dev=bob-tok',
    close: async () => {
      await new Promise((r) => server.close(r));
      await new Promise((r) => kk.close(r));
      fs.rmSync(userspace, { recursive: true, force: true });
    },
  };
}

/** 签一枚码（走真实签发端点）。 */
async function issueTicket(s, body, cookie = s.cookie) {
  const r = await fetch(`${s.base}/api/preview-tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return r;
}

test('/api/file?mode=stream：PDF 200 内联；Range 206；mode=bogus 400；mode=download 附件', async () => {
  const s = await startStack({ files: { 'a.pdf': Buffer.from('%PDF-1.4 '.repeat(1000)) } });
  try {
    const r1 = await fetch(`${s.base}/api/file?cwd=${encodeURIComponent('~/projects/demo')}&path=a.pdf&mode=stream`, { headers: { cookie: s.cookie } });
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('content-type'), 'application/pdf');
    assert.match(r1.headers.get('content-disposition'), /^inline/);
    assert.equal(r1.headers.get('accept-ranges'), 'bytes');
    assert.ok((await r1.arrayBuffer()).byteLength === 9000);

    const r2 = await fetch(`${s.base}/api/file?cwd=${encodeURIComponent('~/projects/demo')}&path=a.pdf&mode=stream`, { headers: { cookie: s.cookie, range: 'bytes=0-8' } });
    assert.equal(r2.status, 206);
    assert.equal(r2.headers.get('content-range'), 'bytes 0-8/9000');
    assert.equal(await r2.text(), '%PDF-1.4 ');

    const r3 = await fetch(`${s.base}/api/file?cwd=${encodeURIComponent('~/projects/demo')}&path=a.pdf&mode=bogus`, { headers: { cookie: s.cookie } });
    assert.equal(r3.status, 400);
    assert.equal((await r3.json()).error.details.field, 'mode');

    const r4 = await fetch(`${s.base}/api/file?cwd=${encodeURIComponent('~/projects/demo')}&path=a.pdf&mode=download`, { headers: { cookie: s.cookie } });
    assert.match(r4.headers.get('content-disposition'), /^attachment; filename="a\.pdf"$/);

    // 无会话 → 401（闸门在最前面）。
    const r5 = await fetch(`${s.base}/api/file?cwd=${encodeURIComponent('~/projects/demo')}&path=a.pdf&mode=stream`);
    assert.equal(r5.status, 401);
  } finally {
    await s.close();
  }
});

test('/api/preview-tickets：签票 200 带 /pv/ URL；牢笼外路径同红线拒绝；未登录 401', async () => {
  const s = await startStack({ files: { 'doc.pdf': 'x' } });
  try {
    const r = await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.url, /^\/pv\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/onlinePreview$/);
    assert.equal(body.expires_in, 600);

    const bad = await issueTicket(s, { cwd: '~/projects/demo', path: '../secret' });
    assert.equal(bad.status, 400);

    const anon = await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' }, '');
    assert.equal(anon.status, 401);
  } finally {
    await s.close();
  }
});

test('/pv：闸门——无会话 401；B 持 A 的码 403；过期 403；垃圾码 404；白名单外 404', async () => {
  const s = await startStack({ files: { 'doc.pdf': 'x' } });
  try {
    const { url } = await (await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' })).json();

    // 登录了但没带码 → 404（码是路径的一部分）。带合法 cookie 但不存在的码 → 404。
    const junk = await fetch(`${s.base}/pv/not-a-real-code/onlinePreview`, { headers: { cookie: s.cookie } });
    assert.equal(junk.status, 404);

    // B 用 A 的码 → 403（隔离链③：码绑用户）。
    const bob = await fetch(`${s.base}${url}`, { headers: { cookie: s.bobCookie } });
    assert.equal(bob.status, 403);

    // 无会话 → 401（隔离链②在归属之前）。
    const anon = await fetch(`${s.base}${url}`);
    assert.equal(anon.status, 401);

    // 过期码（e 在过去）→ 403 preview_code_expired。
    const expiredCode = signPreviewCode(SECRET, { u: USER.id, p: 'alice/projects/demo/doc.pdf', m: 1, e: Math.floor(Date.now() / 1000) - 5 });
    const exp = await fetch(`${s.base}/pv/${expiredCode}/onlinePreview`, { headers: { cookie: s.cookie } });
    assert.equal(exp.status, 403);
    assert.equal((await exp.json()).error.code, 'preview_code_expired');

    // 白名单外路径（kk 的管理面）→ 404，根本不往上游发。
    const n = s.kkReqs.length;
    const outside = await fetch(`${s.base}/pv/${expiredCode}/admin/login`, { headers: { cookie: s.cookie } });
    assert.equal(outside.status, 404);
    // 过期码的 onlinePreview（上面那次 403）与白名单外的 admin/login（本次 404）都在闸门内耗尽——
    // 白名单判定在归属/时效之前（不泄露码状态给探探器），两者都零外发。
    assert.equal(s.kkReqs.length, n);
  } finally {
    await s.close();
  }
});

test('/pv/onlinePreview：载荷重写 url 参数（客户端伪造无效）；HTML 前缀改写；kk 挂 → 502', async () => {
  const s = await startStack({
    files: { 'doc.pdf': 'x' },
    kkHandler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'DENY', // kk 自己的 XFO 应被剥掉（portal 才是安全头所有者）
        'set-cookie': 'kk=sess; Path=/', // kk 的 cookie 不外溢
      });
      res.end('<html><head><link href="/css/kk.css"></head><body><script src="/js/kk.js"></script><a href="/onlinePreview?url=x">l</a></body></html>');
    },
  });
  try {
    const { url } = await (await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' })).json();
    // 客户端自作聪明塞 url=（伪造别人路径）——必须被载荷重写覆盖。
    const r = await fetch(`${s.base}${url}?url=${Buffer.from('evil/secret.txt').toString('base64')}`, { headers: { cookie: s.cookie } });
    assert.equal(r.status, 200);

    // 上游收到的 url 参数 = 载荷重写的 file:// URL（带命名 authority，base64+urlencode）——
    // SSRF 防线的根在代理层重写；命名 authority = KK_TRUST_HOST（5.0.3 空 host 一律 403，
    // 真机实证；TrustDirFilter 只看 path 部分不受影响）。客户端伪造值不存在。
    const kkUrl = new URL(s.kkReqs.at(-1).url, 'http://kk');
    assert.equal(
      decodeURIComponent(Buffer.from(kkUrl.searchParams.get('url'), 'base64').toString()),
      `file://station-preview.internal${s.userspace}/alice/projects/demo/doc.pdf`,
    );
    assert.ok(!kkUrl.search.includes('evil'));

    // HTML 改写：/css /js /onlinePreview 全部挂上 /pv/<码> 前缀。
    const html = await r.text();
    const code = url.split('/')[2];
    assert.ok(html.includes(`/pv/${code}/css/kk.css`), html);
    assert.ok(html.includes(`/pv/${code}/js/kk.js`), html);
    assert.ok(html.includes(`/pv/${code}/onlinePreview`), html);

    // 头消毒：XFO 换成 SAMEORIGIN、CSP 在场、kk 的 Set-Cookie 不外溢、no-store。
    assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.ok(String(r.headers.get('content-security-policy')).includes("base-uri 'none'"));
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  } finally {
    await s.close();
  }

  // kk 挂掉（端口没人听）→ 502 preview_backend_unavailable（可重试）。
  const dead = await startStack({ files: { 'doc.pdf': 'x' }, kkDead: true });
  try {
    const { url } = await (await issueTicket(dead, { cwd: '~/projects/demo', path: 'doc.pdf' })).json();
    const r = await fetch(`${dead.base}${url}`, { headers: { cookie: dead.cookie } });
    assert.equal(r.status, 502);
    assert.equal((await r.json()).error.code, 'preview_backend_unavailable');
  } finally {
    await dead.close();
  }
});

test('/pv：上游 5xx 透传状态与 body（不吞成 200）', async () => {
  const s = await startStack({
    files: { 'doc.pdf': 'x' },
    kkHandler: (req, res) => { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('kk boom'); },
  });
  try {
    const { url } = await (await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' })).json();
    const r = await fetch(`${s.base}${url}`, { headers: { cookie: s.cookie } });
    assert.equal(r.status, 502);
    assert.equal(await r.text(), 'kk boom');
  } finally {
    await s.close();
  }
});

test('/pv 产物透传：转换产物（1–2 段，尾缀限产物集）放行；穿越/未知尾缀/3 段 404', async () => {
  const s = await startStack({ files: { 'doc.docx': 'x' } });
  try {
    const { url } = await (await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.docx' })).json();
    const code = url.split('/')[2];
    for (const [p, want] of [
      ['/docdocx.pdf', 200],           // office → pdf 产物（真机形态）
      ['/docdocx/3.png', 200],         // pdf 图块两段
      ['/evil.exe', 404],              // 未知尾缀不透
      ['/a/b/c.pdf', 404],             // 3 段不透
      ['/%2e%2e/secret.pdf', 404],     // 点段穿越不透
      ['/x.pdf; charset=utf-8', 404],  // 分号/空格形态不猜，不透
    ]) {
      const r = await fetch(`${s.base}/pv/${code}${p}`, { headers: { cookie: s.cookie } });
      assert.equal(r.status, want, `${p} → ${r.status}（期望 ${want}）`);
    }
  } finally {
    await s.close();
  }
});

test('/pv 子资源：js/css 透传原 query，转发头带 x-forwarded-prefix（Thymeleaf 自产前缀）', async () => {
  const s = await startStack({ files: { 'doc.pdf': 'x' } });
  try {
    const { url } = await (await issueTicket(s, { cwd: '~/projects/demo', path: 'doc.pdf' })).json();
    const code = url.split('/')[2];
    const r = await fetch(`${s.base}/pv/${code}/js/app.js?v=1`, { headers: { cookie: s.cookie } });
    assert.equal(r.status, 200);
    const last = s.kkReqs.at(-1);
    assert.equal(last.url, '/js/app.js?v=1');
    assert.equal(last.headers['x-forwarded-prefix'], `/pv/${code}`);
    // X-Base-Url（BaseUrlFilter 优先级 1 钩子）：kk 生成的绝对产物链接落回闸门内。
    assert.equal(last.headers['x-base-url'], `${s.base}/pv/${code}/`);
    // ⚠ 不断言 host：fetch（undici）把 host 列为 forbidden header，按拨号目标重写——
    // 信任判定靠 url 的命名 authority（上面那条已钉），与转发 Host 无关。
    assert.equal(last.headers['x-forwarded-proto'], 'http');
  } finally {
    await s.close();
  }
});
