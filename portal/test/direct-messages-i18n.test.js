// 单测：issue #803 最后一片——**不经 `throw` 直发**的两条服务端文案的双语。
//
// 为什么单独一个文件（与 http-messages-i18n.test.js 的区别）：
//   · 那一个钉的是「`throw new *Error` ⇒ 出口 `pickMessage(err, locale)` 挑 `err.en`」这条路；
//   · 本文件钉的是另一条**根本没有 `err.en` 可挑**的路——这两条文案是在发送点**就地**用
//     `resolveRequestLocale` / 同作用域 `locale` 直接选字符串，不经过任何业务错误类：
//       ① 受限会话门（`routeApi` 内，`must_change_password=true` 撞门 ⇒ 403）：
//          `errorBody('password_change_required', resolveRequestLocale(req) === 'en' ? EN : ZH, ...)`；
//       ② 500 兜底（`createServer` 的 catch 末尾）：
//          `errorBody('internal', locale === 'en' ? 'internal error' : '服务器内部错误')`。
//     ⇒ 这是 i18n 的**第二种形态**：就地按请求语言挑，而非「抛出带 en、出口挑」。
//   · 500 兜底原实现**恒英文**（`errorBody('internal', 'internal error')`），中文用户看到的 500 是英文；
//     本片把它也按语言挑 ⇒ 中文用户现在拿到中文，英文用户行为逐字不变。
//
// 隔离约定（docs/testing.md §2.1）：内存 fake pool + `server.listen(0)`，不碰真实 dev 库 / 容器。
// 语言信号：`Cookie: locale=en` 走英文腿；中文腿不带 locale cookie（`resolveRequestLocale` 缺省即非 'en' ⇒ 当中文）。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

// ---- 夹具生命周期：mkdtemp 与注册 rm 必须在同一条用例内闭环（#880）----
// 本文件建的每一个 /tmp 目录都进 tmpDirs；漏一个就会在 /tmp 留下 station-direct-msg-static-*，
// 而 scripts/check-tmp-hygiene.mjs 正是数这个名字（增量口径：本轮新增必须为 0）。
const tmpDirs = [];
function trackTmp(dir) {
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    // rmSync 必须是真语句：注释掉它 while 就空转成死循环（#880 批一踩过）。
    fs.rmSync(tmpDirs.pop(), { recursive: true, maxRetries: 3 });
  }
});

// 四条期望文案，逐字抄自 http.js 的两处发送点（精确等值，不用 includes/match，避免假绿）。
const GATE_ZH = '当前口令由管理员代设，请先修改口令后再使用其它功能';
const GATE_EN = 'The current password was set by an administrator; change your password before using other features';
const FALLBACK_ZH = '服务器内部错误';
const FALLBACK_EN = 'internal error';

const USER = {
  id: 'd0000000-0000-4000-8000-000000000001', login: 'dana', display_name: 'dana',
  role: 'fde', fde_name: 'dana-host', auth_source: 'local', status: 'active',
};
const TOKEN = 'tok-direct-i18n';

/** 最小 pool：一条 active 会话 + 可控 `must_change_password` 旗标；`boom=true` 时任何查询抛裸 Error。 */
class Pool extends FakePool {
  constructor({ mustChange = false, boom = false } = {}) {
    super({ users: [{ ...USER, must_change_password: mustChange }] });
    this.sessions.push({
      id: 'ls-direct', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
    });
    this.boom = boom;
  }

  // 500 兜底触发器：boom 时**任何** pool 查询（含 findSessionUser）抛裸 Error——它不是任何业务错误类，
  // 必然落到 http.js catch 的最后兜底。
  async query(sql, params = []) {
    if (this.boom) throw new Error('boom: not a business error');
    return super.query(sql, params);
  }
}

async function startServer(poolOpts) {
  const staticDir = trackTmp(fs.mkdtempSync(path.join(os.tmpdir(), 'station-direct-msg-static-')));
  const config = {
    cookie: cookieSettings('dev-direct', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    loginRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 100, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 100, maxEntries: 10000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30000,
    maxLoginLength: 128, maxPasswordLength: 256,
    totp: { issuer: 'erix-station-test', digits: 6, period: 30, window: 1 },
    dockerHost: 'tcp://127.0.0.1:1', staticDir,
  };
  const pool = new Pool(poolOpts);
  const server = createServer({
    pool, config, docker: null,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
    log: { error: () => {}, warn: () => {}, log: () => {} },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = `${config.cookie.name}=${TOKEN}`;
  return { base, cookie, close: () => new Promise((res) => server.close(res)) };
}

/** 发一条 GET /api/sessions（受限清单外、需会话、GET 属安全方法）；返回 {status, error}。 */
async function getSessions(base, cookie) {
  const res = await fetch(`${base}/api/sessions`, {
    method: 'GET',
    headers: { cookie, Origin: base }, // GET 安全方法本就不过 CSRF；Origin 照骨架写法带上（CSRF 门会看它）
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 留 null */ }
  return { status: res.status, error: json?.error };
}

// ---------------------------------------------------------------------------
// ① 受限会话门：must_change_password=true ⇒ 403，文案就地按请求语言挑
// ---------------------------------------------------------------------------

test('受限会话门 403：中文腿（不带 locale cookie）文案逐字 = 中文直发文案', async () => {
  const { base, cookie, close } = await startServer({ mustChange: true });
  try {
    const { status, error } = await getSessions(base, cookie);
    assert.equal(status, 403, `应 403（实际 ${status}）`);
    assert.equal(error.code, 'password_change_required', '错误码必须是受限会话门码');
    assert.equal(error.message, GATE_ZH, '中文腿文案逐字');
  } finally {
    await close();
  }
});

test('受限会话门 403：英文腿（Cookie: locale=en）文案逐字 = 英文直发文案', async () => {
  const { base, cookie, close } = await startServer({ mustChange: true });
  try {
    const { status, error } = await getSessions(base, `${cookie}; locale=en`);
    assert.equal(status, 403, `应 403（实际 ${status}）`);
    assert.equal(error.code, 'password_change_required', '错误码必须是受限会话门码');
    assert.equal(error.message, GATE_EN, '英文腿文案逐字');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// ② 500 兜底：handler 抛裸 Error ⇒ 500，文案按请求语言挑（原实现恒英文）
// ---------------------------------------------------------------------------

test('500 兜底：中文腿（不带 locale cookie）文案逐字 = 服务器内部错误（原恒英文，本片修）', async () => {
  const { base, cookie, close } = await startServer({ mustChange: false, boom: true });
  try {
    const { status, error } = await getSessions(base, cookie);
    assert.equal(status, 500, `应 500（实际 ${status}）`);
    assert.equal(error.code, 'internal', '错误码必须是兜底 internal');
    assert.equal(error.message, FALLBACK_ZH, '中文腿文案逐字（不再是英文 internal error）');
  } finally {
    await close();
  }
});

test('500 兜底：英文腿（Cookie: locale=en）文案逐字 = internal error（行为逐字不变）', async () => {
  const { base, cookie, close } = await startServer({ mustChange: false, boom: true });
  try {
    const { status, error } = await getSessions(base, `${cookie}; locale=en`);
    assert.equal(status, 500, `应 500（实际 ${status}）`);
    assert.equal(error.code, 'internal', '错误码必须是兜底 internal');
    assert.equal(error.message, FALLBACK_EN, '英文腿文案逐字');
  } finally {
    await close();
  }
});
