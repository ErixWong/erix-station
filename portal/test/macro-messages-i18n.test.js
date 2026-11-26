// 单测：issue #803 S2-F——从 **HTTP 面** 钉住「宏族」（共用 `MacroError` 的 macros.js /
// macro-routes.js / notifications.js）一批错误文案的「双语 + 错误体形状 + httpStatus 语义」。
//
// 仿 `helper-messages-i18n.test.js`（S2-D3）的起服务与两腿写法：内存 FakePool + 手工 session
// （不碰真实 DB / docker）。空库（FakePool 对未识别 SELECT 默认回空行）即可命中各 `not_found`，
// 而校验类错误全在 `pool.query` 之前抛出 ⇒ 无需为每种宏表造行。
//
// 每个 case 两腿：
//   · `Cookie: <session>; locale=en` ⇒ `error.message` **逐字**等于 `MacroError` 新增 `en` 透出的英文；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（`this.en` 缺省时行为逐字不变的回归钉子）。
// `twoLeg` 统一再钉：错误体键集合不变、`en` 不外泄、`httpStatus` 语义不变（断言 status 码）。
//
// 覆盖 8 类（按文件铺开）：宏模板不存在 / kind 必填 / 执行记录不存在 / templateId 必填 /
// kind 不可修改 / 通知不存在 / 通知游标无法解析 / 时刻参数非法。
// 注：macro-review.js（W4b）与 macro-scheduled.js（W7）的 finish 校验只被 dispatcher 后台调用、
// 不经 http.js 任何路由 ⇒ 无法从 HTTP 面两腿命中，故不在本文件（其 `en` 已在源里补齐，只是无 HTTP 探针）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

// admin：既跑 `/api/admin/*`（requireAdmin 只校验 role === 'admin'），也满足用户面的 requireSession。
const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-s2f-admin';
const UUID = '00000000-0000-4000-8000-000000000001';

function makePool() {
  const base = new FakePool({ users: [ADMIN] });
  base.sessions.push({
    id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
  });
  return base;
}

async function startServer() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2f-userspace-'));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2f-static-'));
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2f-tls-'));
  const pool = makePool();
  const config = {
    cookie: cookieSettings('dev-s2f', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
    userSpaceRoot: userspace, fdeUid: SELF_UID, fdeGid: SELF_GID, fileUploadMaxBytes: 32 * 1024 * 1024,
    traefikDynamicDir: tlsDir,
  };
  const server = createServer({
    pool, config, docker: null, llmGateway: null,
    log: { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    adminCookie: `${config.cookie.name}=${ADMIN_TOKEN}`,
    close: () => new Promise((res) => server.close(res))
      .finally(() => { fs.rmSync(userspace, { recursive: true, force: true }); fs.rmSync(staticDir, { recursive: true, force: true }); fs.rmSync(tlsDir, { recursive: true, force: true }); }),
  };
}

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

// 两腿钉子：en 腿逐字英文、缺省腿逐字中文；另钉错误体键集合不变 + `en` 不外泄 + httpStatus 语义不变。
// `req.cookie` 是裸会话 cookie；en 腿追加 `; locale=en`。`http` 为该分支期望的 HTTP 状态码。
const KEYSET = ['code', 'details', 'message', 'retryable'];
async function twoLeg(s, req, { code, enMsg, zhMsg, http, keys = KEYSET }) {
  const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
  assert.ok(en.error, `en 腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(en.status, http, `en 腿 httpStatus 语义变了：${req.p}`);
  assert.equal(en.error.code, code, `en 腿 code 不符：${req.p}`);
  assert.equal(en.error.message, enMsg, `en 腿文案不符：${req.p}`);
  assert.ok(!('en' in en.error), `en 不得出现在错误体（en 腿）：${req.p}`);
  assert.deepEqual(Object.keys(en.error).sort(), keys, `en 腿错误体键集合变了：${req.p}`);

  const zh = await hit(s.base, { ...req });
  assert.ok(zh.error, `缺省腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(zh.status, http, `缺省腿 httpStatus 语义变了：${req.p}`);
  assert.equal(zh.error.code, code, `缺省腿 code 不符：${req.p}`);
  assert.equal(zh.error.message, zhMsg, `缺省腿文案不符：${req.p}`);
  assert.ok(!('en' in zh.error), `en 不得出现在错误体（缺省腿）：${req.p}`);
  assert.deepEqual(Object.keys(zh.error).sort(), keys, `缺省腿错误体键集合变了：${req.p}`);
}

// ── 8 类宏族报错文案，各两腿 ──────────────────────────────────────────────────

test('macros.js deleteTemplate：模板不存在（not_found 404，先于任何写库）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'DELETE', p: `/api/admin/macro-templates/${UUID}`, cookie: s.adminCookie }, {
      code: 'not_found', http: 404,
      enMsg: 'template does not exist', zhMsg: '模板不存在',
    });
  } finally { await s.close(); }
});

test('macros.js createTemplate：kind 必填（validateMacroEnum 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'POST', p: '/api/admin/macro-templates', cookie: s.adminCookie, body: {} }, {
      code: 'validation_failed', http: 400,
      enMsg: 'kind is required', zhMsg: 'kind 必填',
    });
  } finally { await s.close(); }
});

test('macro-routes.js adminMacroRunDetail：执行记录不存在（not_found 404）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'GET', p: `/api/admin/macro-runs/${UUID}`, cookie: s.adminCookie }, {
      code: 'not_found', http: 404,
      enMsg: 'the run does not exist', zhMsg: '执行记录不存在',
    });
  } finally { await s.close(); }
});

test('macro-routes.js putUserAssignment：templateId 必填（先于 cwd 与 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'PUT', p: '/api/macro-assignments', cookie: s.adminCookie, body: {} }, {
      code: 'validation_failed', http: 400,
      enMsg: 'templateId is required', zhMsg: 'templateId 必填',
    });
  } finally { await s.close(); }
});

test('macro-routes.js adminPatchTemplate：kind 不可修改（白名单先于 updateTemplate）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'PATCH', p: `/api/admin/macro-templates/${UUID}`, cookie: s.adminCookie, body: { kind: 'idle-notify' } }, {
      code: 'validation_failed', http: 400,
      enMsg: 'kind cannot be modified', zhMsg: 'kind 不可修改',
    });
  } finally { await s.close(); }
});

test('notifications.js markRead：通知不存在（not_found 404）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'POST', p: `/api/notifications/${UUID}/read`, cookie: s.adminCookie }, {
      code: 'not_found', http: 404,
      enMsg: 'the notification does not exist', zhMsg: '通知不存在',
    });
  } finally { await s.close(); }
});

test('notifications.js decodeNotificationCursor：cursor 无法解析（base64url→JSON 抛 ⇒ 400）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'GET', p: '/api/notifications?cursor=zzz', cookie: s.adminCookie }, {
      code: 'validation_failed', http: 400,
      enMsg: 'the cursor cannot be parsed', zhMsg: 'cursor 无法解析',
    });
  } finally { await s.close(); }
});

test('macro-routes.js toTimeParam：from 参数非法时刻（列表筛选先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, { method: 'GET', p: '/api/admin/macro-runs?from=not-a-time', cookie: s.adminCookie }, {
      code: 'validation_failed', http: 400,
      enMsg: 'from is not a valid timestamp', zhMsg: 'from 不是合法时刻',
    });
  } finally { await s.close(); }
});
