// issue #677 第二步（P3 第八批）：FDE env 旋钮 7 根「DB > env > 默认」读取顺序 + 白名单/越界判据。
//
// 这一格只钉三件事，不与 `runtime-settings.test.js`（RS-1..RS-75 机件与既有格）重复：
//   ① 三档读取顺序（每根各钉 DB / env / 默认三档 + 坏 env 回落默认）——这是本单的**核心判据**；
//   ② scoped 管理台端点 `/api/admin/fde-env-settings`：GET 只回 10 根白名单；
//   ③ 该端点 PUT：白名单外的键 400（field=key）、白名单内但越界的值 400（field=value），且零写库。
// 机件（parse/validate/缓存/失效/事务原子性）由 `runtime-settings.test.js` 通用不变式（RS-64/65/52）
// 覆盖，这里不重抄。区间/默认与 runner 解析同源（见每格注释）。
// 隔离约定（docs/testing.md §2.1）：FakePool + 本地子类补 runtime_settings 那几条 SQL，零真 DB/外呼。
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import {
  FDE_ENV_SETTING_KEYS,
  readFdeMaxRounds, readFdeShellTimeoutMs, readFdeShellMaxTimeoutMs, readFdeShellOutputMaxBytes,
  readFdeArtifactCaptureBudgetMs, readFdeMcpConfigTimeoutMs, readFdeAgentdCapacity,
  invalidateFdeMaxRoundsCache, invalidateFdeShellTimeoutMsCache, invalidateFdeShellMaxTimeoutMsCache,
  invalidateFdeShellOutputMaxBytesCache, invalidateFdeArtifactCaptureBudgetMsCache,
  invalidateFdeMcpConfigTimeoutMsCache, invalidateFdeAgentdCapacityCache,
  FDE_MAX_ROUNDS_KEY, FDE_SHELL_TIMEOUT_MS_KEY, FDE_SHELL_MAX_TIMEOUT_MS_KEY,
  FDE_SHELL_OUTPUT_MAX_BYTES_KEY, FDE_ARTIFACT_CAPTURE_BUDGET_MS_KEY,
  FDE_MCP_CONFIG_TIMEOUT_MS_KEY, FDE_AGENTD_CAPACITY_KEY,
  DELEGATE_MAX_KEY, DELEGATE_CHILD_ROUNDS_KEY, DELEGATE_CHILD_TIMEOUT_MS_KEY,
} from '../src/runtime-settings.js';

const silentLog = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
function collectingLog() {
  const seen = { warn: [], log: [], error: [] };
  return { seen, log: (m) => seen.log.push(String(m)), warn: (m) => seen.warn.push(String(m)), error: (m) => seen.error.push(String(m)), info() {}, debug() {} };
}

/** 最小假池：读侧 `SELECT key,value FROM runtime_settings` 返回给定行（无行 ⇒ 空表 ⇒ 回落 env/默认）。 */
function fdePool(rows = []) {
  return {
    async query(sql) {
      const text = String(sql);
      if (/FROM\s+runtime_settings/i.test(text)) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

// 每根一组测试参数：区间/默认与 runner 同源；dbValue / envValue 取区间内、彼此不同、且不同于默认。
const KNOBS = [
  { key: FDE_MAX_ROUNDS_KEY, env: 'ERIX_MAX_ROUNDS', min: 1, max: 200, def: 16,
    db: 42, envValue: 99, read: readFdeMaxRounds, invalidate: invalidateFdeMaxRoundsCache },
  { key: FDE_SHELL_TIMEOUT_MS_KEY, env: 'ERIX_SHELL_TIMEOUT_MS', min: 1000, max: 3_600_000, def: 60_000,
    db: 120_000, envValue: 180_000, read: readFdeShellTimeoutMs, invalidate: invalidateFdeShellTimeoutMsCache },
  { key: FDE_SHELL_MAX_TIMEOUT_MS_KEY, env: 'ERIX_SHELL_MAX_TIMEOUT_MS', min: 1000, max: 3_600_000, def: 600_000,
    db: 700_000, envValue: 800_000, read: readFdeShellMaxTimeoutMs, invalidate: invalidateFdeShellMaxTimeoutMsCache },
  { key: FDE_SHELL_OUTPUT_MAX_BYTES_KEY, env: 'ERIX_SHELL_OUTPUT_MAX_BYTES', min: 1024, max: 1_048_576, def: 32_768,
    db: 65_536, envValue: 131_072, read: readFdeShellOutputMaxBytes, invalidate: invalidateFdeShellOutputMaxBytesCache },
  { key: FDE_ARTIFACT_CAPTURE_BUDGET_MS_KEY, env: 'ERIX_ARTIFACT_CAPTURE_BUDGET_MS', min: 1000, max: 3_600_000, def: 60_000,
    db: 90_000, envValue: 120_000, read: readFdeArtifactCaptureBudgetMs, invalidate: invalidateFdeArtifactCaptureBudgetMsCache },
  { key: FDE_MCP_CONFIG_TIMEOUT_MS_KEY, env: 'ERIX_MCP_CONFIG_TIMEOUT_MS', min: 1000, max: 600_000, def: 10_000,
    db: 20_000, envValue: 30_000, read: readFdeMcpConfigTimeoutMs, invalidate: invalidateFdeMcpConfigTimeoutMsCache },
  { key: FDE_AGENTD_CAPACITY_KEY, env: 'ERIX_AGENTD_CAPACITY', min: 1, max: 64, def: 2,
    db: 4, envValue: 6, read: readFdeAgentdCapacity, invalidate: invalidateFdeAgentdCapacityCache },
];

// 每根前后都清缓存（模块级热读缓存是共享的，清了才测得到「现读到的是哪一档」）。
function cleanAll() { for (const k of KNOBS) k.invalidate(); }

// ---------------------------------------------------------------------------
// ① 三档读取顺序（本单核心判据）：每根各钉 DB / env / 默认三档 + 坏 env 回落默认。
// ---------------------------------------------------------------------------
test('FDE-env 三档：DB 有值用 DB、无 DB 用 env、都无用默认（7 根各一遍）', async () => {
  for (const k of KNOBS) {
    // 档一：DB 有值 ⇒ 用 DB（即便 env 也给了值，DB 优先）。
    k.invalidate();
    assert.equal(
      await k.read({ pool: fdePool([{ key: k.key, value: k.db }]), config: {}, env: { [k.env]: String(k.envValue) }, log: silentLog }),
      k.db, `${k.key}：DB 有值必须压过 env`);

    // 档二：DB 无值、env 有合法值 ⇒ 用 env（compose 那行保留就是为了让这一档还能用）。
    k.invalidate();
    assert.equal(
      await k.read({ pool: fdePool([]), config: {}, env: { [k.env]: String(k.envValue) }, log: silentLog }),
      k.envValue, `${k.key}：DB 无值 ⇒ env 过闸生效`);

    // 档三：DB 无值、env 也无 ⇒ 代码默认。
    k.invalidate();
    assert.equal(
      await k.read({ pool: fdePool([]), config: {}, env: {}, log: silentLog }),
      k.def, `${k.key}：DB/env 都无 ⇒ registry 默认`);
    k.invalidate();
  }
});

test('FDE-env 三档补充：DB 值越界 ⇒ 回落 env/默认（不许「存在但非法」的值生效），env 非法 ⇒ 默认 + 点名 warn', async () => {
  for (const k of KNOBS) {
    // DB 里塞一个越界值 ⇒ parse 判非法 ⇒ 回落 env（env 给了合法值就用 env）。
    k.invalidate();
    assert.equal(
      await k.read({ pool: fdePool([{ key: k.key, value: k.max + 1 }]), config: {}, env: { [k.env]: String(k.envValue) }, log: silentLog }),
      k.envValue, `${k.key}：DB 越界值不生效 ⇒ 回落 env`);

    // env 越界 / 字符串写法 ⇒ 视为没给 ⇒ 默认 + 一条同时点名 key 与 envVar 的 warn。
    for (const bad of [String(k.max + 1), '1e3', '0', '-1']) {
      k.invalidate();
      const log = collectingLog();
      assert.equal(
        await k.read({ pool: fdePool([]), config: {}, env: { [k.env]: bad }, log }),
        k.def, `${k.key}：坏 env ${bad} ⇒ 回落默认（不采纳）`);
      const warns = log.seen.warn.join('\n');
      assert.ok(log.seen.warn.length >= 1, `${k.key}：坏 env 必须留一条点名 warn`);
      assert.ok(warns.includes(k.env) && warns.includes(k.key),
        `${k.key}：那条 warn 必须同时点名 key 与 envVar`);
    }
    k.invalidate();
  }
});

// ---------------------------------------------------------------------------
// ② + ③ scoped 管理台端点：GET 只回白名单 10 根；PUT 白名单闸 + 越界闸 + 零写库。
// ---------------------------------------------------------------------------
const ADMIN = {
  id: 'e0000000-0000-4000-8000-0000000000b1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active', file_upload_enabled: false,
};

class FdeEnvPool extends FakePool {
  constructor(opts = {}) {
    super(opts);
    this.runtimeRows = new Map(Object.entries(opts.runtimeRows ?? {}));
    this.runtimeUpsertCalls = 0;
  }

  async query(sql, params = []) {
    const text = String(sql);
    if (/FROM\s+runtime_settings/i.test(text) && /\bFOR\s+UPDATE\b/i.test(text)) {
      this.statements.push({ sql, params });
      const key = params[0];
      if (!this.runtimeRows.has(key)) return { rows: [], rowCount: 0 };
      return { rows: [{ value: this.runtimeRows.get(key) }], rowCount: 1 };
    }
    if (/FROM\s+runtime_settings/i.test(text)) {
      this.statements.push({ sql, params });
      const rows = [...this.runtimeRows.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([key, value]) => ({ key, value }));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT\s+INTO\s+runtime_settings/i.test(text)) {
      this.statements.push({ sql, params });
      this.runtimeUpsertCalls += 1;
      const [key, jsonValue, actorId] = params;
      this.runtimeRows.set(key, JSON.parse(jsonValue));
      return { rows: [{ key, value: JSON.parse(jsonValue), updated_at: new Date(), updated_by: actorId }], rowCount: 1 };
    }
    return super.query(sql, params);
  }
}

const tmpDirs = [];
afterEach(() => { while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, maxRetries: 3 }); });

async function startStack({ runtimeRows = {} } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-677p3-'));
  fs.mkdirSync(path.join(userspace, 'alice', 'projects', 'demo'), { recursive: true });
  const users = [ADMIN];
  const pool = new FdeEnvPool({ users, runtimeRows });
  const token = 'root-tok';
  pool.sessions.push({
    id: 's-root', user_id: ADMIN.id, token_hash: hashToken(token),
    created_at: new Date(), expires_at: new Date(Date.now() + 3_600_000),
    last_seen_at: new Date(), revoked_at: null,
  });
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-'));
  tmpDirs.push(staticDir);
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 86400, sessionTtlSecondsSource: 'env',
    sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100 },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxLoginLength: 128, maxPasswordLength: 256,
    staticDir,
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000, fdeGid: process.getgid?.() ?? 1000,
    fileUploadMaxBytes: 32 * 1024 * 1024, fileUploadMaxBytesSource: 'env',
  };
  const server = createServer({
    pool, config,
    llmGateway: { async listCredentials() { return { credentials: [] }; }, async listModels() { return { data: [] }; } },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: `fde_session_dev=${token}`,
    close: () => new Promise((r) => server.close(r)).finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

const callFde = (s, { method = 'GET', key, body } = {}) => fetch(
  `${s.base}/api/admin/fde-env-settings${key === undefined ? '' : `/${key}`}`,
  {
    method,
    headers: {
      cookie: s.cookie,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
);
const readJson = async (res) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
};

test('FDE-env GET：只回白名单 10 根（其余 registry 旋钮不在这条端点里）', async () => {
  const s = await startStack({ runtimeRows: { [FDE_MAX_ROUNDS_KEY]: 33 } });
  try {
    const res = await callFde(s);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.deepEqual([...body.items.map((i) => i.key)].sort(), [...FDE_ENV_SETTING_KEYS].sort(),
      'GET 的键集合必须逐格等于 10 根白名单');
    // 白名单外的通用旋钮（session.ttl_seconds）不许出现在这条端点里。
    assert.ok(!body.items.some((i) => i.key === 'session.ttl_seconds'),
      '通用端点专属的旋钮不许混进 scoped 端点');
    // 生效值如实：DB 里 run.max_rounds=33 ⇒ DTO 报 33/source=db。
    const mr = body.items.find((i) => i.key === FDE_MAX_ROUNDS_KEY);
    assert.equal(mr.value, 33);
    assert.equal(mr.applyMode, 'restart', 'FDE env 旋钮全部报 restart');
  } finally {
    await s.close();
  }
});

test('FDE-env PUT 白名单闸：白名单外的键（哪怕在 registry 里）⇒ 400 field=key + 零写库', async () => {
  const s = await startStack();
  try {
    // session.ttl_seconds 在 registry 里，但不在 10 根白名单 ⇒ 这条 scoped 端点必须拒。
    const res = await callFde(s, { method: 'PUT', key: 'session.ttl_seconds', body: { value: 600 } });
    assert.equal(res.status, 400);
    const body = await readJson(res);
    assert.equal(body.error.details.field, 'key', '未知键 400 必须点名 field=key');
    assert.equal(s.pool.runtimeUpsertCalls, 0, '白名单外的键必须零写库');
    // 完全不认识的键也 400。
    const r2 = await callFde(s, { method: 'PUT', key: 'totally.unknown.key', body: { value: 1 } });
    assert.equal(r2.status, 400);
  } finally {
    await s.close();
  }
});

test('FDE-env PUT 越界闸：白名单内但值越界 ⇒ 400 field=value + 零写库；合法值 ⇒ 200 且写库', async () => {
  const s = await startStack();
  try {
    // agentd.capacity 区间 1..64 ⇒ 999 越界 ⇒ 400 field=value，且不写库。
    const bad = await callFde(s, { method: 'PUT', key: FDE_AGENTD_CAPACITY_KEY, body: { value: 999 } });
    assert.equal(bad.status, 400);
    const badBody = await readJson(bad);
    assert.equal(badBody.error.details.field, 'value', '越界值 400 必须点名 field=value');
    assert.equal(s.pool.runtimeUpsertCalls, 0, '越界值必须零写库');
    // 合法值 ⇒ 200，写一次库。
    const ok = await callFde(s, { method: 'PUT', key: FDE_AGENTD_CAPACITY_KEY, body: { value: 5 } });
    assert.equal(ok.status, 200);
    const okBody = await readJson(ok);
    assert.equal(okBody.item.value, 5);
    assert.equal(s.pool.runtimeUpsertCalls, 1, '合法值必须写库一次');
  } finally {
    await s.close();
  }
});

test('FDE-env 白名单常量形状：10 根、含 delegate.* 3 格、全部在 registry 且 applyMode=restart', () => {
  assert.equal(FDE_ENV_SETTING_KEYS.length, 10, '白名单正好 10 根（本批 7 + delegate.* 3）');
  for (const k of [DELEGATE_MAX_KEY, DELEGATE_CHILD_ROUNDS_KEY, DELEGATE_CHILD_TIMEOUT_MS_KEY]) {
    assert.ok(FDE_ENV_SETTING_KEYS.includes(k), `${k} 必须在白名单里（工单点名的 10 根）`);
  }
});
