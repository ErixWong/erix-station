// issue #800：`GET /api/admin/llm/key-usage` 的 HTTP 层判据（契约 `docs/api/portal.md`）。
//
// 只验**入口**这一层：鉴权（非 admin 403）、成功形状 `{ rows: [...] }`、网关不可达映射 `llm_gateway_error`。
// 「整表读 `/key/list` + 按 token 匹配 + spend_scope 判据」的业务逻辑在 `portal/test/llm.test.js`
// （listFdeKeyUsage 那 6 条），这里**不重复**——重复一份就是第二份真相。
//
// 隔离约定（docs/testing.md §2.1）：`FakePool`（认证/会话）+ 本地子类补「整表绑定」那一条 SQL，
// 网关用本地 stub（含 listKeys）；零真 HTTP 外呼、零真 DB。写法照 `admin-runtime-settings-api.test.js`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { LlmGatewayError } from '../src/llm-gateway.js';
import { FakePool } from './fake-pool.js';

const ADMIN = {
  id: 'e0000000-0000-4000-8000-0000000000b1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active', file_upload_enabled: false,
};
const FDE = {
  id: 'e0000000-0000-4000-8000-0000000000b2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', file_upload_enabled: true,
};

/**
 * `FakePool` 不认 `listFdeKeyUsage` 的整表绑定查询（`FROM fde_llm_bindings b JOIN users u`）。
 * 继承它、只补这一条：返回预置的绑定行（active + litellm，含 key_id）。认证/会话仍走基类。
 */
class KeyUsagePool extends FakePool {
  constructor(opts = {}) {
    super(opts);
    this.bindingRows = opts.bindingRows ?? [];
    this.bindingQueryCount = 0;
  }

  async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('FROM fde_llm_bindings b') && text.includes('JOIN users u ON u.id = b.fde_id')) {
      this.bindingQueryCount += 1;
      this.statements.push({ sql, params });
      return { rows: this.bindingRows };
    }
    return super.query(sql, params);
  }
}

/** 网关 stub：启动要的 listCredentials/listModels + 本单要的 listKeys（可分页、可注入抛错）。 */
function gatewayStub({ keys = [], totalPages = 1, error = null } = {}) {
  return {
    async listCredentials() { return { credentials: [] }; },
    async listModels() { return { data: [] }; },
    async listKeys(query) {
      if (error) throw error;
      const page = Number(query?.page) || 1;
      return page === 1
        ? { keys, total_count: keys.length, current_page: 1, total_pages: totalPages }
        : { keys: [], total_count: keys.length, current_page: page, total_pages: totalPages };
    },
  };
}

async function startStack({ bindingRows = [], gateway = gatewayStub() } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-800-keyusage-'));
  fs.mkdirSync(path.join(userspace, 'alice', 'projects', 'demo'), { recursive: true });
  const users = [ADMIN, FDE];
  const pool = new KeyUsagePool({ users, bindingRows });
  const tokens = new Map();
  for (const u of users) {
    const token = `${u.login}-tok`;
    tokens.set(u.login, token);
    pool.sessions.push({
      id: `s-${u.login}`, user_id: u.id, token_hash: hashToken(token),
      created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
  }
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 86400,
    sessionTtlSecondsSource: 'env',
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-')),
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
    fileUploadMaxBytes: 32 * 1024 * 1024,
    fileUploadMaxBytesSource: 'env',
  };
  const server = createServer({ pool, config, llmGateway: gateway });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookieFor: (login) => `fde_session_dev=${tokens.get(login)}`,
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

const call = (s, { login = 'root' } = {}) => fetch(`${s.base}/api/admin/llm/key-usage`, {
  method: 'GET', headers: { cookie: s.cookieFor(login) },
});
const readJson = async (res) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
};

// 一条 active 绑定：key_id == 网关 token（实测口径）。
const BINDING = { fde_name: 'alice', budget_usd: 5.04, budget_period: '1mo', key_id: 'tok-alice' };
const KEY = { token: 'tok-alice', key_alias: 'fde-alice', spend: 1.23, max_budget: 5.04, budget_duration: '1mo', budget_reset_at: '2026-12-01T00:00:00Z' };

test('KU-API-1 admin GET 200，响应形如 { rows: [...] }（含 spend_scope 判据字段）', async () => {
  const s = await startStack({ bindingRows: [BINDING], gateway: gatewayStub({ keys: [KEY] }) });
  try {
    const res = await call(s);
    assert.equal(res.status, 200, `admin 读 key-usage 必须 200（实际 ${res.status}）`);
    const body = await readJson(res);
    assert.ok(Array.isArray(body.rows), `响应必须是 { rows: [...] }（实际 ${JSON.stringify(body)?.slice(0, 200)}）`);
    assert.equal(body.rows.length, 1);
    const row = body.rows[0];
    assert.equal(row.fde_name, 'alice');
    assert.equal(row.spend, 1.23, '按 token 命中 ⇒ spend 来自网关读数');
    assert.equal(row.spend_scope, 'period', 'key 有 budget_duration ⇒ scope=period');
    assert.deepEqual(Object.keys(row).sort(), [
      'budget_duration', 'budget_period', 'budget_reset_at', 'budget_usd', 'fde_name', 'max_budget', 'remaining', 'spend', 'spend_scope',
    ]);
    assert.equal(s.pool.bindingQueryCount, 1, '整表一次读，不逐人');
  } finally {
    await s.close();
  }
});

test('KU-API-2 非 admin（FDE）GET ⇒ 403 forbidden', async () => {
  const s = await startStack({ bindingRows: [BINDING], gateway: gatewayStub({ keys: [KEY] }) });
  try {
    const res = await call(s, { login: 'alice' });
    assert.equal(res.status, 403, '非 admin 必须 403');
    const body = await readJson(res);
    assert.equal(body.error.code, 'forbidden');
  } finally {
    await s.close();
  }
});

test('KU-API-3 网关抛 LlmGatewayError ⇒ 既有映射回 5xx + llm_gateway_error', async () => {
  const s = await startStack({
    bindingRows: [BINDING],
    gateway: gatewayStub({ error: new LlmGatewayError(502, 'gateway unreachable') }),
  });
  try {
    const res = await call(s);
    assert.equal(res.status, 502, '网关错误状态透传（实际 ${res.status}）');
    const body = await readJson(res);
    assert.equal(body.error.code, 'llm_gateway_error', '映射成 llm_gateway_error（前端那一列据此降级）');
    assert.equal(s.pool.bindingQueryCount, 0, 'listKeys 先抛 ⇒ 绑定查询都不该发');
  } finally {
    await s.close();
  }
});
