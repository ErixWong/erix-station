// 单测：issue #803 S2-B——从 **HTTP 面** 钉住 `portal/src/http.js` 经 `throw new HttpError`
// 抛给客户端的错误文案「双语 + 错误体形状」。仿 admin.test.js 的起服务方式（内存 fake pool，
// 不碰真实 DB / docker；docs/testing.md §2.1）。
//
// 每个 case 两腿：
//   · `Cookie: locale=en` ⇒ `error.message` **逐字**等于抛出点写的 `en`；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（既有行为不破的钉子）。
// 另钉两条：错误体键集合不变（`code`/`message`/`retryable`，给了才有 `details`）、`en` 不外泄。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001', login: 'root', display_name: 'root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-http-msg-i18n';

/** 最小 admin pool：FakePool（会话解析）+ 一条 active 管理员会话。 */
class Pool extends FakePool {
  constructor() {
    super({ users: [{ ...ADMIN }] });
    this.sessions.push({
      id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }
}

async function startServer() {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-http-msg-static-'));
  const config = {
    cookie: cookieSettings('dev-msg', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
  };
  const pool = new Pool();
  const server = createServer({
    pool, config, docker: null,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
    log: { error: () => {}, warn: () => {}, log: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${config.cookie.name}=${ADMIN_TOKEN}`;
  return { base, cookie, close: () => new Promise((res) => server.close(res)) };
}

/** 一次请求：返回 {status, error}（error = 响应体 error 信封）。cookieLocale 追加 locale 谈判 cookie。 */
async function hit(base, { method, p, cookie, ct = 'application/json', body }) {
  const headers = {};
  if (ct) headers['content-type'] = ct;
  if (cookie) headers['cookie'] = cookie;
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON：留 null */ }
  return { status: res.status, error: json?.error };
}

/**
 * 8 类最常撞的 http.js 抛错。每类给出一个「造请求」的工厂（接 base/cookie，locale 腿由外部拼），
 * 以及期望的 zh / en 文案（逐字，抄自抛出点）。`withCookie` 标记该路由需带管理员会话 cookie。
 */
const CASES = [
  {
    name: 'Content-Type 校验（机制样桩，本就有 en，作对照）',
    withCookie: false,
    req: (base) => ({ method: 'POST', p: '/api/auth/login', ct: 'text/plain', body: '{"x":1}' }),
    zh: 'Content-Type 必须为 application/json',
    en: 'Content-Type must be application/json',
  },
  {
    name: '登录体形状：login/password 必填',
    withCookie: false,
    req: (base) => ({ method: 'POST', p: '/api/auth/login', body: {} }),
    zh: 'login 与 password 均为必填',
    en: 'Both login and password are required',
  },
  {
    name: '退役端点：POST /api/projects（项目注册已退役）',
    withCookie: true,
    req: (base, cookie) => ({ method: 'POST', p: '/api/projects', cookie, body: {} }),
    zh: '项目注册已退役（P5 目录即项目）：目录经 POST /api/sessions 的 project_id（cwd）自动创建',
    en: 'Project registration is retired (P5: the directory is the project); directories are created automatically via project_id (cwd) on POST /api/sessions',
  },
  {
    name: '路径参数形状：用户 id 必须是 UUID',
    withCookie: true,
    req: (base, cookie) => ({ method: 'GET', p: '/api/admin/users/not-a-uuid', cookie }),
    zh: '用户 id 必须是 UUID',
    en: 'User id must be a UUID',
  },
  {
    name: '运行时配置项未知（模板串，英文用同名变量插值）',
    withCookie: true,
    req: (base, cookie) => ({ method: 'PUT', p: '/api/admin/runtime-settings/zzz.notakey', cookie, body: {} }),
    zh: '未知的运行时配置项：zzz.notakey',
    en: 'Unknown runtime setting: zzz.notakey',
  },
  {
    name: 'body 形状：请求体必须是 JSON 对象（数组被拒）',
    withCookie: true,
    req: (base, cookie) => ({ method: 'PUT', p: '/api/admin/runtime-settings/auth.max_password_length', cookie, body: [1, 2] }),
    zh: '请求体必须是 JSON 对象',
    en: 'Request body must be a JSON object',
  },
  {
    name: '文件预览 mode 参数只支持 json|stream|download',
    withCookie: true,
    req: (base, cookie) => ({ method: 'GET', p: '/api/file?mode=bogus', cookie }),
    zh: 'mode 只支持 json|stream|download',
    en: 'mode only supports json|stream|download',
  },
  {
    name: '管理台测试发信：to 必须是有效邮箱地址',
    withCookie: true,
    req: (base, cookie) => ({ method: 'POST', p: '/api/admin/mail/test', cookie, body: { to: 'not-an-email' } }),
    zh: 'to 必须是有效邮箱地址',
    en: 'to must be a valid email address',
  },
];

test('http.js 报错文案：locale=en 出英文逐字、缺省出中文逐字（8 类各两腿）', async () => {
  const { base, cookie, close } = await startServer();
  try {
    for (const c of CASES) {
      // en 腿：追加 locale=en cookie（需要会话的路由在会话 cookie 后拼接）
      const enCookie = c.withCookie ? `${cookie}; locale=en` : 'locale=en';
      const zhCookie = c.withCookie ? cookie : undefined;

      const enRes = await hit(base, { ...c.req(base, enCookie), cookie: enCookie });
      assert.ok(enRes.error, `${c.name}：en 腿应返回 error 信封（实际 status=${enRes.status}）`);
      assert.equal(enRes.error.message, c.en, `${c.name}：en 腿文案逐字`);

      const zhRes = await hit(base, { ...c.req(base, zhCookie), cookie: zhCookie });
      assert.ok(zhRes.error, `${c.name}：zh 腿应返回 error 信封（实际 status=${zhRes.status}）`);
      assert.equal(zhRes.error.message, c.zh, `${c.name}：zh 腿文案逐字`);
    }
  } finally {
    await close();
  }
});

test('错误体键集合不变（code/message/retryable，给了才有 details）且 en 不外泄', async () => {
  const { base, cookie, close } = await startServer();
  try {
    // 无 details 的一条（login 必填）：键集合恰为 {code,message,retryable}
    const noDetails = await hit(base, { method: 'POST', p: '/api/auth/login', body: {} });
    assert.deepEqual(Object.keys(noDetails.error).sort(), ['code', 'message', 'retryable']);
    assert.ok(!('en' in noDetails.error), 'en 不得出现在错误体里（缺省腿）');

    // 有 details 的一条（body 形状）：键集合恰为 {code,message,retryable,details}
    const withDetails = await hit(base, {
      method: 'PUT', p: '/api/admin/runtime-settings/auth.max_password_length', cookie, body: [1, 2],
    });
    assert.ok(withDetails.error.details, '给了 details 就必须出现在错误体里');
    assert.deepEqual(Object.keys(withDetails.error).sort(), ['code', 'details', 'message', 'retryable']);

    // en 腿同样不外泄：locale=en 时 keys 仍是那套，en 只是替了 message 的值
    const enLeg = await hit(base, {
      method: 'PUT', p: '/api/admin/runtime-settings/auth.max_password_length',
      cookie: `${cookie}; locale=en`, body: [1, 2],
    });
    assert.equal(enLeg.error.message, 'Request body must be a JSON object');
    assert.ok(!('en' in enLeg.error), 'en 不得出现在错误体里（en 腿）');
    assert.deepEqual(Object.keys(enLeg.error).sort(), ['code', 'details', 'message', 'retryable']);
  } finally {
    await close();
  }
});
