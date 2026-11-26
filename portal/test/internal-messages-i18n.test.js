// 单测：issue #803 E 片——从 **HTTP 面**（内部通道 runner ↔ portal）钉住一批 `InternalError` 的
// 错误文案「双语 + 错误体形状」。内部通道的 locale 由请求自带的 `Cookie: locale=` /
// `Accept-Language` 决定（`http.js#resolveRequestLocale` 对所有路由通用，含 `/api/internal/*`），
// 鉴权则走 per-container Bearer token（`authenticateContainer`），**与会话 cookie 无关**——
// 所以 en 腿只追加一个独立的 `Cookie: locale=en`，不碰鉴权。
//
// 仿 `helper-messages-i18n.test.js`（S2-D3）的两腿写法：内存 FakeInternalPool（不碰真实 DB），
// 每个 case 两腿：
//   · `Cookie: locale=en` ⇒ `error.message` **逐字**等于 `InternalError` 新增 `en` 透出去的英文；
//   · 不带 locale cookie ⇒ **逐字**等于原中文（缺省 `en` 时行为逐字不变的回归钉子）。
// 另钉（由 `twoLeg` 统一执行）：错误体键集合不变、`en` 不外泄。
//
// 6 类内部通道最常撞的：鉴权失败 / run 不存在 / 参数形状错 / artifact（2 类）/ 幂等或配额（claim 容量）。
//   · 鉴权失败、run 不存在两类本就没有中文（`authenticateContainer` / `fetchRun` 早就是英文），
//     两腿逐字都英文 ⇒ 钉住「已是英文的内部消息随 locale 不变」这一现状（不是漏补，是本来就没有中文原文）。
//   · 其余四类都有中文原文，en 腿出英文、缺省腿出中文，逐字对照。
// 末条「现状钉」：不带任何语言信号 ⇒ 出中文（钉住 doc 里「runner 两者都不发 ⇒ 内部通道默认恒为中文」的事实）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { seedClaimable } from './fake-internal-pool.js';

async function startServer(pool) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-i18n-internal-static-'));
  const config = {
    cookie: cookieSettings('dev-i18n-internal', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir,
  };
  const server = createServer({ pool, config, log: { warn() {}, info() {}, error() {}, debug() {} } });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => {
      server.closeAllConnections?.();
      return new Promise((res) => server.close(res))
        .finally(() => fs.rmSync(staticDir, { recursive: true, force: true }));
    },
  };
}

// 发一次内部通道请求。`token` 走 per-container Bearer（缺省用种子里的 token）；
// `localeCookie` 为真时追加独立的 `Cookie: locale=en`（与鉴权无关）。
async function hit(base, { method, p, token, cookie, ct = 'application/json', body, headers: extra }) {
  const headers = { ...(extra || {}) };
  if (ct) headers['content-type'] = ct;
  headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const payload = body === undefined ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
  const res = await fetch(base + p, { method, headers, body: payload });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 204）：留 null */ }
  return { status: res.status, error: json?.error };
}

// 两腿钉子：en 腿逐字英文、缺省腿逐字中文；另钉错误体键集合不变 + `en` 不外泄。
// `req.token` 是裸容器 token；en 腿追加 `; ` 前已是空——这里直接把 `Cookie: locale=en` 挂上。
// `keys` 为该分支错误体的键集合（给了才含 details）。
async function twoLeg(s, req, { code, enMsg, zhMsg, keys }) {
  const en = await hit(s.base, { ...req, cookie: 'locale=en' });
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
const KEYSET_NO_DETAILS = ['code', 'message', 'retryable'];

// ── 1. 鉴权失败：坏 bearer token ⇒ 401 `token_invalid`（本无中文，两腿逐字都英文，钉 locale 不变）──
test('鉴权失败：坏 token ⇒ token_invalid（英文，locale 不变）', async () => {
  const { pool } = seedClaimable();
  const s = await startServer(pool);
  try {
    const req = { method: 'POST', p: '/api/internal/heartbeat', token: 'nope-not-a-real-token', ct: 'application/json', body: { runs: [] } };
    await twoLeg(s, req, {
      code: 'token_invalid',
      enMsg: 'invalid token',
      zhMsg: 'invalid token',
      keys: KEYSET_NO_DETAILS,
    });
  } finally { await s.close(); }
});

// ── 2. run 不存在：终态之外的 markRunState 找不到 run ⇒ 404 `run_not_found`（本无中文，两腿英文）──
test('run 不存在：markRunState 找不到 run ⇒ run_not_found（英文，locale 不变）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    // 种子里的 run 是 `run1`；这里用一个不存在的 run id ⇒ fetchRun 直接 404（早于任何 claim 校验）。
    const req = { method: 'PUT', p: '/api/internal/runs/00000000-0000-4000-8000-0000000000ff/state', token, ct: 'application/json', body: { state: 'running' } };
    await twoLeg(s, req, {
      code: 'run_not_found',
      enMsg: 'run not found',
      zhMsg: 'run not found',
      keys: KEYSET_NO_DETAILS,
    });
  } finally { await s.close(); }
});

// ── 3. 参数形状错：markRunState 的 state 非法 ⇒ 中文原文，en 腿出英文（本次新增 en 的对照）──
test('参数形状错：state 非法 ⇒ 双语（state must be running/finished/failed）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const req = { method: 'PUT', p: '/api/internal/runs/run1/state', token, ct: 'application/json', body: { state: 'bogus' } };
    await twoLeg(s, req, {
      code: 'validation_failed',
      enMsg: 'state must be running/finished/failed',
      zhMsg: 'state 必须为 running/finished/failed',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

// ── 4. artifact 类 1：空 body ⇒ 非空字节流校验（早于任何 DB / 落盘）──
test('artifact 空 body ⇒ 双语（the artifact body must be a non-empty byte stream）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const req = { method: 'PUT', p: '/api/internal/runs/run1/artifact', token, ct: null, body: Buffer.alloc(0) };
    await twoLeg(s, req, {
      code: 'validation_failed',
      enMsg: 'the artifact body must be a non-empty byte stream',
      zhMsg: 'artifact body 必须为非空字节流',
      keys: KEYSET_NO_DETAILS,
    });
  } finally { await s.close(); }
});

// ── 5. artifact 类 2：body 非空但 X-Sha-256 与真实摘要不符 ⇒ 摘要不一致（早于任何 DB / 落盘）──
test('artifact 摘要不一致 ⇒ 双语（the X-Sha-256 does not match the actual digest of the body）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const data = Buffer.from('not-a-real-bundle');
    const realSha = crypto.createHash('sha256').update(data).digest('hex');
    // 给一个**对不上**的 sha（把真实摘要末位改掉）⇒ 命中 sha256_mismatch，早于 own 查询与落盘。
    const wrongSha = realSha.slice(0, -1) + (realSha.endsWith('a') ? 'b' : 'a');
    const req = {
      method: 'PUT', p: '/api/internal/runs/run1/artifact', token, ct: null, body: data,
      headers: { 'x-sha-256': wrongSha },
    };
    await twoLeg(s, req, {
      code: 'sha256_mismatch',
      enMsg: 'the X-Sha-256 does not match the actual digest of the body',
      zhMsg: 'X-Sha-256 与 body 实际摘要不一致',
      keys: KEYSET_NO_DETAILS,
    });
  } finally { await s.close(); }
});

// ── 6. 幂等 / 配额类：claim 的 capacity 越界 ⇒ 400（早于任何认领 SQL）──
test('claim capacity 越界 ⇒ 双语（capacity out of range (1..64)）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    const req = { method: 'POST', p: '/api/internal/claim', token, ct: 'application/json', body: { capacity: 999 } };
    await twoLeg(s, req, {
      code: 'validation_failed',
      enMsg: 'capacity out of range (1..64)',
      zhMsg: 'capacity 越界（1..64）',
      keys: KEYSET,
    });
  } finally { await s.close(); }
});

// ── 现状钉：不带任何语言信号 ⇒ 出中文（钉住「runner 不发 locale cookie / Accept-Language ⇒ 内部通道默认恒为中文」）──
// 这条与 doc（docs/api/portal.md locale 契约段）同事实：补了英文对 ≠ 内部通道会自动出英文，
// 缺省语言是 `zh-CN`（`resolveRequestLocale` 的落回），故不带信号时**逐字中文**。
test('现状钉：内部通道不带任何语言信号 ⇒ 出中文（默认 locale 恒为 zh-CN）', async () => {
  const { pool, token } = seedClaimable();
  const s = await startServer(pool);
  try {
    // 既无 `Cookie: locale=`、也无 `Accept-Language`——正是 runner 出站的现状。
    const res = await hit(s.base, {
      method: 'PUT', p: '/api/internal/runs/run1/state', token, ct: 'application/json', body: { state: 'bogus' },
    });
    assert.ok(res.error, '应返回错误信封');
    assert.equal(res.error.code, 'validation_failed');
    assert.equal(res.error.message, 'state 必须为 running/finished/failed',
      'runner 不发 locale cookie / Accept-Language ⇒ 内部通道默认恒为中文（现状，非缺陷）');
  } finally { await s.close(); }
});
