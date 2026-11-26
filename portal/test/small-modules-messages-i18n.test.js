// 单测：issue #803 S2-D——从 **HTTP 面** 钉住一批中小模块经 `throw`/`return` 抛给客户端的错误文案
// 「双语 + 错误体形状」，并钉住 http.js 出口的两处映射（llm 网关分支 / RuntimeSettingsError 分支）
// 确实改走 `pickMessage`。仿 `session-dir-messages-i18n.test.js`（S2-C）的起服务与两腿写法：内存
// FakePool + 手工 session（不碰真实 DB / docker），假 llmGateway（`getGatewayClient` 会原样返回带
// listModels/listCredentials 的对象）。
//
// 每个 case 两腿：
//   · `Cookie: locale=en` ⇒ `error.message` **逐字**等于抛出点写的 `en`；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（既有行为不破的钉子）。
// 另钉：错误体键集合不变（`code`/`message`/`retryable`，给了才有 `details`）、`en` 不外泄。
//
// ⚠ 同文案多处抛（本片已全部补同一英文对，任一腿无论命中哪处都出英文）：
//   `git host 不存在`（git-hosts.js 三处）、`仍有 FDE 使用该 host，不能删除`（两处）、
//   `provider_id / main_model_id 为必填字段`（llm.js 各两处）、`tls.yml 未发布`（tls-cert.js 两处）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { LlmGatewayError } from '../src/llm-gateway.js';
import { FakePool } from './fake-pool.js';

const SELF_UID = process.getuid?.() ?? 1000;
const SELF_GID = process.getgid?.() ?? 1000;

// admin：跑所有 `/api/admin/*`（`requireAdmin` 只校验 `role === 'admin'`）。
const ADMIN = {
  id: 'a0000000-0000-4000-8000-00000000000a', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active',
};
// alice：有工位（`/api/me/llm-usage` 的 days 校验要 `fde_name`；`/api/sessions/:id/queued-inputs` 走属主会话）。
const FDE = {
  id: 'b0000000-0000-4000-8000-00000000000b', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const ADMIN_TOKEN = 'tok-s2d-admin';
const FDE_TOKEN = 'tok-s2d-fde';
const SOME_UUID = '11111111-1111-4111-8111-111111111111';

// 包一层 FakePool：
//   · `capability_params` 读固定回一个已声明槽（让 `market.setSlotValues` 走到 `normalizeValue`，
//     从而命中 `secrets.js` 的空串 `SecretError`，否则默认空声明会先被 `MarketError` 拦下）。
//   · `INSERT INTO upload_settings` 回一个 `max_file_bytes=null` 的行 ⇒ `resolveFromRow` 判
//     `source !== 'db'` ⇒ 命中 `upload-settings.js` 的「读回后不可用」`internal`。
function makePool() {
  const base = new FakePool({ users: [ADMIN, FDE] });
  for (const [u, tok, id] of [[ADMIN, ADMIN_TOKEN, 'ls-admin'], [FDE, FDE_TOKEN, 'ls-fde']]) {
    base.sessions.push({
      id, user_id: u.id, token_hash: auth.hashToken(tok),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
  }
  const wrapClient = (c) => ({
    query: (sql, params) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO upload_settings')) {
        return Promise.resolve({ rows: [{ max_file_bytes: null, updated_at: null, updated_by: null }], rowCount: 1 });
      }
      return c.query(sql, params);
    },
    release: () => c.release(),
  });
  return {
    query: (sql, params) => {
      if (typeof sql === 'string' && /FROM\s+capability_params\b/.test(sql)) {
        return Promise.resolve({ rows: [{ name: 'API_TOKEN', kind: 'secret' }], rowCount: 1 });
      }
      return base.query(sql, params);
    },
    connect: async () => wrapClient(await base.connect()),
  };
}

async function startServer() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d-userspace-'));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d-static-'));
  const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-s2d-tls-')); // 空目录 ⇒ 无 certs/prev ⇒ tls_no_previous
  const pool = makePool();
  const config = {
    cookie: cookieSettings('dev-s2d', 604800),
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
  const gateway = {
    async listCredentials() { return { credentials: [] }; },
    async listModels() {
      const e = new LlmGatewayError(503, '网关未就绪');
      e.en = 'gateway not ready';
      throw e;
    },
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
    fdeCookie: `${config.cookie.name}=${FDE_TOKEN}`,
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

// ── 8 类中小模块的 client-facing 文案，各两腿 ─────────────────────────────────────

test('llm.js LlmError：POST 建 provider 缺 name（createProvider 先于网关）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/llm/providers', cookie: s.adminCookie, body: {},
    }, {
      code: 'validation_failed',
      enMsg: 'name is required',
      zhMsg: 'name 为必填字段',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('git-hosts.js GitHostError：create 用 azure provider（cleanProvider 先于 DB）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/git-hosts', cookie: s.adminCookie,
      body: { name: 'host-azure', provider: 'azure', base_url: 'https://example.com' },
    }, {
      code: 'provider_unsupported',
      enMsg: 'the azure provider is not yet supported',
      zhMsg: 'azure provider 尚不支持',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('runtime-settings 未知键（http.js 路由级 HttpError）：PUT 未登记 key', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/runtime-settings/nosuchkey', cookie: s.adminCookie, body: { value: 1 },
    }, {
      code: 'validation_failed',
      enMsg: 'Unknown runtime setting: nosuchkey',
      zhMsg: '未知的运行时配置项：nosuchkey',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('secrets.js SecretError：写槽值为空串（wrapper 声明槽后走 normalizeValue）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: `/api/admin/market/items/${SOME_UUID}/secrets`, cookie: s.adminCookie,
      body: { scope: 'global', values: { API_TOKEN: '' } },
    }, {
      code: 'capability_slot_invalid',
      enMsg: 'the value must not be an empty string (pass null to delete, not an empty string)',
      zhMsg: '值不能为空字符串（要删除请传 null，不要传空串）',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('tls-cert.js TlsCertError：回滚但无上一代（空 tls 目录 ⇒ tls_no_previous）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'POST', p: '/api/admin/tls/rollback', cookie: s.adminCookie, body: {},
    }, {
      code: 'tls_no_previous',
      enMsg: 'there is no previous certificate generation to roll back to (certs/prev/ does not exist or is incomplete)',
      zhMsg: '没有可回滚的上一代证书（certs/prev/ 不存在或不完整）',
      keys: ['code', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('upload-settings.js UploadSettingsError：写成功但读回不可用（wrapper 回空值行）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/upload/settings', cookie: s.adminCookie, body: { maxFileBytes: 5242880 },
    }, {
      code: 'internal',
      enMsg: 'the written max_file_bytes=5242880 is unavailable after read-back',
      zhMsg: '写入的 max_file_bytes=5242880 读回后不可用',
      keys: ['code', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('queued-inputs.js SessionError：POST kind 非法（validateQueuedKind 先于入库）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'POST', p: `/api/sessions/${SOME_UUID}/queued-inputs`, cookie: s.fdeCookie,
      body: { kind: 'bogus', content: 'hi' },
    }, {
      code: 'validation_failed',
      enMsg: "kind must be 'steer' or 'follow_up'",
      zhMsg: "kind 必须是 'steer' 或 'follow_up'",
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

test('http.js days 校验：GET /api/me/llm-usage?days=999（B 批漏网补的 en）', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'GET', p: '/api/me/llm-usage?days=999', cookie: s.fdeCookie, ct: null,
    }, {
      code: 'validation_failed',
      enMsg: 'days must be an integer between 1 and 90',
      zhMsg: 'days 必须为 1–90 的整数',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

// ── 两处出口映射的钉子（第 2 件事）：改走 pickMessage 才生效 ──────────────────────

// 1083：llm 网关分支。LlmGatewayError 本身不带 en（上游英文透传），这里给它挂一个 en，
// 证明该分支确实经 `pickMessage(err, locale)` 而不是裸 `err.message`。
test('出口映射·llm 网关分支走 pickMessage：locale=en 出 LlmGatewayError 的 en', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'GET', p: '/api/admin/llm/providers', cookie: s.adminCookie, ct: null,
    }, {
      code: 'llm_gateway_error',
      enMsg: 'gateway not ready',
      zhMsg: '网关未就绪',
      keys: ['code', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

// 1113：RuntimeSettingsError 分支。已知键 + 坏值（对象）⇒ scalar_required（400，映成 validation_failed），
// 该分支此前直出 err.message，补的 en 不生效；改走 pickMessage 后 en 腿出 err.en。
test('出口映射·RuntimeSettingsError 分支走 pickMessage：已知键坏值 locale=en 出 err.en', async () => {
  const s = await startServer();
  try {
    await twoLeg(s, {
      method: 'PUT', p: '/api/admin/runtime-settings/session.ttl_seconds', cookie: s.adminCookie, body: { value: {} },
    }, {
      code: 'validation_failed',
      enMsg: 'value only accepts a JSON scalar; objects / arrays / null / undefined are not accepted',
      zhMsg: 'value 只接受 JSON 标量，不接受对象 / 数组 / null / undefined',
      keys: ['code', 'details', 'message', 'retryable'],
    });
  } finally { await s.close(); }
});

// 错误类自带字段语义 + super(message) 中文不变（补 en 是纯加法）。
test('错误类补 en 是纯加法：super(message) 仍中文、this.en 独立、LlmError.retryable 解耦', async () => {
  const mod = await import('../src/llm.js');
  const e = new mod.LlmError('validation_failed', '名称是中文原文', { retryable: true, en: 'the name is the original Chinese' });
  assert.equal(e.message, '名称是中文原文', 'super(message) 仍传中文原文');
  assert.equal(e.en, 'the name is the original Chinese');
  assert.equal(e.retryable, true, 'retryable 语义不因补 en 而变');
});
