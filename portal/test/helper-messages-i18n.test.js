// 单测：issue #803 S2-D3——从 **HTTP 面** 钉住一批「消息喂给本文件 `fail()` 助手」这一类的错误文案
// 「双语 + 错误体形状」。这一类不是 `throw` 语句，前几批扫 `throw new *Error` 的写法对它完全失明
// （真机探针：`POST /api/admin/git-hosts` 空 `name` 在 `locale=en` 下仍出中文）。
//
// 仿 `small-modules-messages-i18n.test.js`（S2-D）的起服务与两腿写法：内存 FakePool + 手工 session
// （不碰真实 DB / docker），假 llmGateway（`getGatewayClient` 原样返回带 `listModels/listCredentials`
// 的对象，用于命中 llm.js `validateSlotModel` 的「模型已停用」fail 点）。
//
// 每个 case 两腿：
//   · `Cookie: locale=en` ⇒ `error.message` **逐字**等于助手新增 `en` 形参透传出去的英文；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（助手省略 `en` 时行为逐字不变的回归钉子）。
// 另钉（由 `twoLeg` 统一执行）：错误体键集合不变、`en` 不外泄。
//
// 覆盖 8 类：git-hosts 空 name、mail-settings transport / smtp.host 必填、git-credential 坏 host、
// platform-prompts text 必填 / text 非字符串、upload-settings 缺 maxFileBytes、llm main 模型已停用。
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

// admin：跑所有 `/api/admin/*`（`requireAdmin` 只校验 `role === 'admin'`）。
const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
// alice：有工位（`/api/admin/fdes/alice/*` 的 fdeName 由路径给出，管理员代其操作）。
const FDE = {
  id: 'b0000000-0000-4000-8000-00000000000b', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-s2d3-admin';

function makePool() {
  const base = new FakePool({ users: [ADMIN, FDE] });
  base.sessions.push({
    id: 'ls-admin', user_id: ADMIN.id, token_hash: auth.hashToken(ADMIN_TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
  });
  return base;
}

async function startServer() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d3-userspace-'));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d3-static-'));
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d3-tls-'));
  const pool = makePool();
  const config = {
    cookie: cookieSettings('dev-s2d3', 604800),
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
  // 假网关：`listModels` 回一个**已停用**（`model_info.blocked = true`）的 model（id=`m1`）。
  // `PUT /api/admin/fdes/alice/llm` 带 `main_model_id=m1` ⇒ `selectGatewayModels` 找到它 ⇒
  // `validateSlotModel` 首个检查 `isModelBlocked` 命中 ⇒ `main 模型已停用`（该 fail 点在 `pool.connect` 之前）。
  const gateway = {
    async listCredentials() { return { credentials: [] }; },
    async listModels() { return { data: [{ model_info: { id: 'm1', blocked: true } }] }; },
  };
  const server = createServer({
    pool, config, docker: null, llmGateway: gateway,
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

// 两腿钉子：en 腿逐字英文、缺省腿逐字中文；另钉错误体键集合不变 + `en` 不外泄。
// `req.cookie` 是裸会话 cookie；en 腿追加 `; locale=en`。`keys` 为该分支错误体的键集合（给了才含 details）。
async function twoLeg(s, req, { code, enMsg, zhMsg, keys }) {
  const en = await hit(s.base, { ...req, cookie: `${req.cookie}; locale=en` });
  assert.ok(en.error, `en 腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(en.error.code, code, `en 腿 code 不符：${req.p}`);
  assert.equal(en.error.message, enMsg, `en 腿文案不符：${req.p}`);
  assert.ok(!('en' in en.error), `en 不得出现在错误体（en 腿）：${req.p}`);
  if (keys) assert.deepEqual(Object.keys(en.error).sort(), keys, `en 腿错误体键集合变了：${req.p}`);

  const zh = await hit(s.base, { ...req });
  assert.ok(zh.error, `缺省腿应返回错误信封：${req.method} ${req.p}`);
  assert.equal(zh.error.code, code, `缺省腿 code 不符：${req.p}`);
  assert.equal(zh.error.message, zhMsg, `缺省腿文案不符：${req.p}`);
  assert.ok(!('en' in zh.error), `en 不得出现在错误体（缺省腿）：${req.p}`);
  if (keys) assert.deepEqual(Object.keys(zh.error).sort(), keys, `缺省腿错误体键集合变了：${req.p}`);
}

const KEYSET = ['code', 'details', 'message', 'retryable'];

// ── 8 类「助手型」报错文案，各两腿 ─────────────────────────────────────────────

test('git-hosts.js fail：create 空 name（cleanName 先于 provider 与 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/git-hosts', cookie: s.adminCookie,
      body: { name: '', provider: 'gitea', base_url: 'https://example.com' },
    }, {
      code: 'validation_failed',
      enMsg: 'name must be 1–120 characters',
      zhMsg: 'name 必须是 1–120 个字符',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('mail-settings.js fail：transport 非法（cleanTransport 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/mail/settings', cookie: s.adminCookie,
      body: { transport: 'bogus', smtp: {} },
    }, {
      code: 'validation_failed',
      enMsg: 'transport must be disabled or smtp',
      zhMsg: 'transport 必须是 disabled 或 smtp',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('mail-settings.js fail：transport=smtp 但 smtp.host 空（必填校验先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/mail/settings', cookie: s.adminCookie,
      body: { transport: 'smtp', smtp: { host: '', from: '' } },
    }, {
      code: 'validation_failed',
      enMsg: 'smtp.host is required when transport=smtp',
      zhMsg: 'transport=smtp 时 smtp.host 为必填字段',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('git-credential.js fail：坏 host（validateHost 先于其余校验与 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/fdes/alice/git-credential', cookie: s.adminCookie,
      body: { host: 'not a host', username: 'u', token: 't' },
    }, {
      code: 'validation_failed',
      enMsg: 'host must be a valid DNS hostname',
      zhMsg: 'host 必须是有效 DNS 主机名',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('platform-prompts.js fail：text 缺失（cleanTextField 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/prompts/addendum', cookie: s.adminCookie, body: {},
    }, {
      code: 'validation_failed',
      enMsg: 'text is required (a string; `""` = follow the built-in)',
      zhMsg: 'text 是必填字段（字符串，`""` = 跟随内置）',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('platform-prompts.js fail：text 非字符串（cleanTextField 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/prompts/addendum', cookie: s.adminCookie, body: { text: 123 },
    }, {
      code: 'validation_failed',
      enMsg: 'text must be a string (numbers / objects / null are not accepted)',
      zhMsg: 'text 必须是字符串（不接受数字 / 对象 / null）',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('upload-settings.js fail：缺 maxFileBytes（cleanMaxFileBytes 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/upload/settings', cookie: s.adminCookie, body: {},
    }, {
      code: 'validation_failed',
      enMsg: 'maxFileBytes is required (a JSON integer, in bytes)',
      zhMsg: 'maxFileBytes 是必填字段（JSON 整数，单位字节）',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

test('llm.js fail：main 模型已停用（validateSlotModel 先于 pool.connect）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/fdes/alice/llm', cookie: s.adminCookie,
      body: { provider_id: 'p1', main_model_id: 'm1' },
    }, {
      code: 'validation_failed',
      enMsg: 'the main model is disabled',
      zhMsg: 'main 模型已停用',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});
