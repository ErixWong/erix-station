// issue #787：`GET /api/preview-backend` 的 HTTP 层判据（契约 `docs/api/portal.md` §4.11 附近）。
//
// 只验入口：鉴权（无会话 401）、状态码（探针失败也 200）、响应体形状（三字段、**不含 baseUrl**）。
// 探针本体的分槽/超时/缓存判据在 `preview-backend.test.js`，这里不重复。
//
// 隔离：FakePool（认证/会话）+ 本地子类补 `runtime_settings` 整表读（返回空行 ⇒ 热读回落
// 默认 kk 地址）；`globalThis.fetch` 换成桩（探针的真实出网口）；`resetProbeCache()` 每例前清槽。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { KK_BASE_URL_DEFAULT, KK_BASE_URL_KEY } from '../src/runtime-settings.js';
import { resetProbeCache } from '../src/preview-backend.js';

// import 时就抢下真实 fetch：`hit()` 要真打本地 server，而探针（`handlePreviewBackend`
// → `probePreviewBackend`）读的是 `globalThis.fetch`——两者同名会互相顶掉（桩 fetch 让
// `hit()` 拿到一个假对象而非 Response）。以故：hit 固定用 `REAL_FETCH`，探针用被桩替换的 `globalThis.fetch`。
const REAL_FETCH = globalThis.fetch;

const FDE = {
  id: 'e0000000-0000-4000-8000-0000000000b2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', file_upload_enabled: true,
};

/** FakePool 不认 runtime_settings 整表读 ⇒ 补一条：无行 ⇒ 热读回落 registry 默认 kk 地址。 */
class PreviewBackendPool extends FakePool {
  async query(sql, params = []) {
    if (/FROM\s+runtime_settings/i.test(String(sql))) {
      this.statements.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
    return super.query(sql, params);
  }
}

async function startStack() {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-787-pb-'));
  fs.mkdirSync(path.join(userspace, 'alice', 'projects', 'demo'), { recursive: true });
  const users = [FDE];
  const pool = new PreviewBackendPool({ users });
  const token = 'alice-tok';
  pool.sessions.push({
    id: 's-alice', user_id: FDE.id, token_hash: hashToken(token),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
    last_seen_at: new Date(), revoked_at: null,
  });
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 86400,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100,
    },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-')),
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
    fileUploadMaxBytes: 32 * 1024 * 1024,
  };
  const server = createServer({
    pool,
    config,
    llmGateway: {
      async listCredentials() { return { credentials: [] }; },
      async listModels() { return { data: [] }; },
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: `fde_session_dev=${token}`,
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

const hit = (s, cookie) => REAL_FETCH(`${s.base}/api/preview-backend`,
  { method: 'GET', headers: cookie ? { cookie } : {} });

const readJson = async (res) => {
  const text = await res.text();
  try {
    return { json: text ? JSON.parse(text) : null, text };
  } catch {
    return { json: null, text };
  }
};

/** 把探针的出网口（`globalThis.fetch`）换成桩：`mode` = 'ok' | 'notok' | 'throw'，并计数。 */
function stubFetch(mode) {
  const original = globalThis.fetch;
  const state = { count: 0 };
  globalThis.fetch = async () => {
    state.count += 1;
    if (mode === 'throw') throw new Error('ECONNREFUSED');
    return { ok: mode === 'ok', status: mode === 'ok' ? 200 : 502 };
  };
  return { state, restore: () => { globalThis.fetch = original; } };
}

test('PB-HTTP-1 无会话 ⇒ 401（探针端点要登录）', async () => {
  const s = await startStack();
  const { restore } = stubFetch('ok');
  try {
    const res = await hit(s, null);
    assert.equal(res.status, 401);
  } finally {
    restore();
    await s.close();
  }
});

test('PB-HTTP-2 有会话 + 后端不可达 ⇒ 200 且 {configured:true,available:false}，体不含 baseUrl', async () => {
  resetProbeCache();
  const s = await startStack();
  const { state, restore } = stubFetch('throw');
  try {
    const res = await hit(s, s.cookie);
    assert.equal(res.status, 200, '探针失败也必须 200（状态查询，不是错误）');
    const { json, text } = await readJson(res);
    assert.equal(json.configured, true, '热读回落默认 kk 地址 ⇒ configured 应为 true');
    assert.equal(json.available, false);
    assert.equal(typeof json.checkedAt, 'string');
    assert.deepEqual(Object.keys(json).sort(), ['available', 'checkedAt', 'configured']);
    assert.ok(!text.includes(KK_BASE_URL_DEFAULT), `响应体不得出现 baseUrl 字面值：${text}`);
    assert.ok(!text.includes('kkfileview'), `响应体不得出现 kk 主机名：${text}`);
    assert.ok(state.count >= 1, '必须真的发过一次探针请求');
  } finally {
    restore();
    await s.close();
  }
});

test('PB-HTTP-3 有会话 + 后端可达 ⇒ 200 available:true', async () => {
  resetProbeCache();
  const s = await startStack();
  const { restore } = stubFetch('ok');
  try {
    const res = await hit(s, s.cookie);
    assert.equal(res.status, 200);
    const { json } = await readJson(res);
    assert.equal(json.configured, true);
    assert.equal(json.available, true);
  } finally {
    restore();
    await s.close();
  }
});

test('PB-HTTP-4 非 2xx（kk 起来但 /index 返 502）⇒ 200 available:false', async () => {
  resetProbeCache();
  const s = await startStack();
  const { restore } = stubFetch('notok');
  try {
    const res = await hit(s, s.cookie);
    assert.equal(res.status, 200);
    const { json } = await readJson(res);
    assert.equal(json.available, false, '非 2xx ⇒ 不可达，但 HTTP 仍 200');
  } finally {
    restore();
    await s.close();
  }
});

test('PB-HTTP-5 登记名 sanity：preview.kk_base_url 键常量与默认同源', () => {
  assert.equal(KK_BASE_URL_KEY, 'preview.kk_base_url');
  assert.equal(KK_BASE_URL_DEFAULT, 'http://kkfileview:8012');
});
