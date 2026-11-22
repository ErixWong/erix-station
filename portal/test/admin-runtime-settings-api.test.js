// issue #677 P2a：管理台「运行时设置」HTTP 层判据（契约 `docs/api/portal.md` §4.21）。
//
// 这一层只验**入口**：鉴权、状态码、DTO 形状、`details.field` 四档（`key` / `value` / `body`）、
// 以及「非法值零写库」。值的解析/区间/回落/缓存/事务原子性都在
// `portal/test/runtime-settings.test.js`（RS-1..RS-21），这里**不重复**那些判据 —— 重复一份就是第二份真相。
//
// 隔离约定（docs/testing.md §2.1）：`FakePool`（认证/会话）+ 本地子类补 `runtime_settings`
// 那几条 SQL，零真 HTTP 外呼、零真 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import {
  SESSION_TTL_KEY, RUNTIME_SETTING_REGISTRY, isKnownSetting,
} from '../src/runtime-settings.js';

const ADMIN = {
  id: 'e0000000-0000-4000-8000-0000000000b1', login: 'root', display_name: 'Root',
  role: 'admin', fde_name: null, auth_source: 'local', status: 'active', file_upload_enabled: false,
};
const FDE = {
  id: 'e0000000-0000-4000-8000-0000000000b2', login: 'alice', display_name: 'Alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active', file_upload_enabled: true,
};

const BASE_TTL = 86400;

/**
 * `FakePool` 不认 `runtime_settings` 那几条 SQL（P1 的单测用的是文件内私有 `FakeRuntimePool`）。
 * 这里**继承**它而不是复制一份：认证/会话/审计那些分支照旧走基类，只补本单要用的四条：
 *   · 整表读（`listRuntimeSettingsAdmin` 的 `SELECT … FROM runtime_settings`）
 *   · 事务里的 `SELECT … FOR UPDATE`（取旧值）
 *   · upsert（`INSERT INTO runtime_settings … ON CONFLICT`）
 *   · 审计插入（基类已有 `audit_log` 分支，这里只确认它被走到）
 */
class RuntimeSettingsPool extends FakePool {
  constructor(opts = {}) {
    super(opts);
    this.runtimeRows = new Map(Object.entries(opts.runtimeRows ?? {}));
    this.runtimeSelectThrows = opts.runtimeSelectThrows ?? null;
    this.runtimeUpsertCalls = 0;
    this.runtimeAuditCalls = 0;
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
      if (this.runtimeSelectThrows) throw this.runtimeSelectThrows;
      const rows = [...this.runtimeRows.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([key, value]) => ({ key, value }));
      return { rows, rowCount: rows.length };
    }
    if (/INSERT\s+INTO\s+runtime_settings/i.test(text)) {
      this.statements.push({ sql, params });
      this.runtimeUpsertCalls += 1;
      const [key, jsonValue, actorId] = params;
      const value = JSON.parse(jsonValue);
      this.runtimeRows.set(key, value);
      return {
        rows: [{ key, value, updated_at: new Date('2026-11-19T03:00:00.000Z'), updated_by: actorId }],
        rowCount: 1,
      };
    }
    if (/INSERT\s+INTO\s+audit_log/i.test(text)) {
      this.runtimeAuditCalls += 1;
    }
    return super.query(sql, params);
  }
}

async function startStack({ runtimeRows = {}, runtimeSelectThrows = null } = {}) {
  const userspace = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-677p2a-'));
  fs.mkdirSync(path.join(userspace, 'alice', 'projects', 'demo'), { recursive: true });
  const users = [ADMIN, FDE];
  const pool = new RuntimeSettingsPool({ users, runtimeRows, runtimeSelectThrows });
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
    sessionTtlSeconds: BASE_TTL,
    sessionTtlSecondsSource: 'env',
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'T', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
    totpRateLimit: {
      maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 100,
    },
    kdfConcurrency: 2, kdfQueueLimit: 10, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-static-')),
    userSpaceRoot: userspace,
    fdeUid: process.getuid?.() ?? 1000,
    fdeGid: process.getgid?.() ?? 1000,
    fileUploadMaxBytes: 32 * 1024 * 1024,
    fileUploadMaxBytesSource: 'env',
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
    pool,
    base: `http://127.0.0.1:${server.address().port}`,
    cookieFor: (login) => `fde_session_dev=${tokens.get(login)}`,
    close: () => new Promise((r) => server.close(r))
      .finally(() => fs.rmSync(userspace, { recursive: true, force: true })),
  };
}

const call = (s, { method = 'GET', key, body, login = 'root' } = {}) => fetch(
  `${s.base}/api/admin/runtime-settings${key === undefined ? '' : `/${key}`}`,
  {
    method,
    headers: {
      cookie: s.cookieFor(login),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  },
);

const readJson = async (res) => {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
};

// ---------------------------------------------------------------------------
// ① 鉴权：非管理员两向都 403，且**零写库**
// ---------------------------------------------------------------------------

/**
 * 「零写库」的**唯一量尺**（#701 返修 LOW①）：数捕获到的**所有 DML**，而不是某两个计数器。
 *
 * 为什么不能只盯 `runtimeUpsertCalls` / `runtimeAuditCalls`：那两个各自只在对应分支自增
 *（一个只数 `INSERT INTO runtime_settings`，一个只数 `INSERT INTO audit_log`）⇒「403 之后其实
 * 发了另一形写语句」（`UPDATE runtime_settings` / `DELETE …` / 写别的表）在旧判据下**绿着过**。
 * 现在改成「凡是写就不许有」：`INSERT` / `UPDATE` / `DELETE` 一律算，鉴权自身那些 `SELECT` 不算；
 * 只有 `idempotency_keys` 那族例外（框架层的幂等记账，不是业务写，与 TLS 那块同口径）。
 */
function dmlStatements(statements) {
  return (statements ?? [])
    .map((s) => String(typeof s === 'string' ? s : (s?.sql ?? '')))
    .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))
    .filter((sql) => !/\bidempotency_keys\b/i.test(sql));
}

test('RS-API-1 非管理员 GET / PUT 都 403，且 PUT 一条写语句都不发', async () => {
  // 量尺自证（判据自己也得有牙）：旧口径看不见的那三形，新的必须抱住。
  assert.deepEqual(dmlStatements([
    'SELECT * FROM runtime_settings', '  SELECT 1 FROM sessions',
    'INSERT INTO idempotency_keys (a) VALUES (1)',
  ]), [], '鉴权的 SELECT 与幂等记账不算写');
  assert.equal(dmlStatements([
    'UPDATE runtime_settings SET value = $1',
    'DELETE FROM runtime_settings',
    'INSERT INTO whatever (a) VALUES (1)',
  ]).length, 3, '旧判据会漏的三形（UPDATE / DELETE / 写别的表）都必须算写');

  const s = await startStack();
  try {
    const got = await call(s, { login: 'alice' });
    assert.equal(got.status, 403, 'FDE 读管理台运行时设置必须 403');

    const put = await call(
      s, { method: 'PUT', key: SESSION_TTL_KEY, body: { value: 60 }, login: 'alice' });
    assert.equal(put.status, 403, 'FDE 写管理台运行时设置必须 403');
    const writes = dmlStatements(s.pool.statements);
    assert.equal(writes.length, 0,
      `403 之后**任何一形写语句**都不许发（实发 ${writes.length} 条：${writes.join(' | ')}）`);
    assert.equal(s.pool.runtimeUpsertCalls, 0, '403 之后不许有任何 runtime_settings 写（鉴权在写之前）');
    assert.equal(s.pool.runtimeAuditCalls, 0, '也不许写审计');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ② GET：三档 source 各造一次（db / env / default）
// ---------------------------------------------------------------------------

test('RS-API-2 GET 的 source 三档如实：DB 有合法值 ⇒ db；无行 ⇒ env；config 也没来源 ⇒ default', async () => {
  // 档一：DB 有值
  const withDb = await startStack({ runtimeRows: { [SESSION_TTL_KEY]: 3600 } });
  try {
    const res = await call(withDb);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    const item = (body.items ?? []).find((i) => i.key === SESSION_TTL_KEY);
    assert.ok(item, `GET 必须列出 ${SESSION_TTL_KEY}（实际 ${JSON.stringify(body)?.slice(0, 200)}）`);
    assert.equal(item.value, 3600, 'DB 值优先');
    assert.equal(item.source, 'db', 'source 必须说清「这一档从哪来」');
    assert.equal(item.applyMode, 'hot', 'session.ttl_seconds 是 hot（下一次读即生效）');
  } finally {
    await withDb.close();
  }

  // 档二 / 档三：无行 ⇒ env；config 没来源 ⇒ default
  const noRow = await startStack();
  try {
    const body = await readJson(await call(noRow));
    const item = (body.items ?? []).find((i) => i.key === SESSION_TTL_KEY);
    assert.equal(item.value, BASE_TTL, '无行 ⇒ 回落 config 的值');
    assert.equal(item.source, 'env', 'config 标了 env 来源 ⇒ source=env');
  } finally {
    await noRow.close();
  }
});

// ---------------------------------------------------------------------------
// ③ 表不存在 / 读失败：仍 200 + 如实回落（不许把管理台读成 500）
// ---------------------------------------------------------------------------

test('RS-API-3 读失败（表不存在 42P01）仍回 200，source 如实回落而不是 500', async () => {
  const boom = Object.assign(new Error('relation "runtime_settings" does not exist'), { code: '42P01' });
  const s = await startStack({ runtimeSelectThrows: boom });
  try {
    const res = await call(s);
    assert.equal(res.status, 200, '读失败也是 200（回落 env/默认）——运维故障不许把管理台锁死');
    const body = await readJson(res);
    const item = (body.items ?? []).find((i) => i.key === SESSION_TTL_KEY);
    assert.equal(item.value, BASE_TTL, '回落 config 的值');
    assert.equal(item.source, 'env', '回落时 source 不许谎报 db');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ④ PUT 合法值：200 + DTO 来自 RETURNING + 库里真改了 + 审计一行
// ---------------------------------------------------------------------------

test('RS-API-4 PUT 合法值：200、DTO 来自 RETURNING（不是回显请求）、落库、审计一行', async () => {
  const s = await startStack();
  try {
    const res = await call(s, { method: 'PUT', key: SESSION_TTL_KEY, body: { value: 7200 } });
    assert.equal(res.status, 200, `PUT 必须 200（实际 ${res.status}）`);
    const body = await readJson(res);
    assert.equal(body.item.key, SESSION_TTL_KEY);
    assert.equal(body.item.value, 7200);
    assert.equal(body.item.source, 'db', '写完 source 必须是 db');
    assert.equal(body.item.updatedBy, ADMIN.id, 'updatedBy 来自 RETURNING（落库那个 actor），不是请求体');
    assert.equal(body.previousValue, undefined, 'previousValue 只进日志，响应体里刻意没有它');

    assert.equal(s.pool.runtimeRows.get(SESSION_TTL_KEY), 7200, '值必须真落库');
    assert.equal(s.pool.runtimeAuditCalls, 1, '一次保存恰好一条审计（调用方不许再补 auth.audit）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑤ / ⑥ 两类 400：`details.field` 点名是 key 还是 value，且**零写库**
// ---------------------------------------------------------------------------

test('RS-API-5 PUT 未知 key ⇒ 400 details.field=key，且零写库', async () => {
  const s = await startStack();
  try {
    const res = await call(s, { method: 'PUT', key: 'session.nope', body: { value: 60 } });
    assert.equal(res.status, 400, '未登记的 key 必须 400');
    const body = await readJson(res);
    assert.equal(body.error?.code, 'validation_failed');
    assert.equal(body.error?.details?.field, 'key', 'field 必须点名是 key 不对');
    assert.ok(
      Array.isArray(body.error?.details?.known) && body.error.details.known.includes(SESSION_TTL_KEY),
      'details.known 要列可用 key（前端据此提示）',
    );
    assert.equal(dmlStatements(s.pool.statements).length, 0,
      `未登记的 key 不许发**任何一形**写语句（实发 ${dmlStatements(s.pool.statements).join(' | ')}）`);
    assert.equal(s.pool.runtimeUpsertCalls, 0, '未登记的 key 不许发 upsert');
    assert.equal(s.pool.runtimeAuditCalls, 0, '也不许写审计');
  } finally {
    await s.close();
  }
});

test('RS-API-6 PUT 非法值（形状/区间）⇒ 400 details.field=value，且零写库', async () => {
  const bad = [
    ['字符串数字', { value: '1e4' }],
    ['零', { value: 0 }],
    ['负数', { value: -1 }],
    ['超上界', { value: 2592001 }],
    ['对象', { value: { a: 1 } }],
  ];
  for (const [label, body] of bad) {
    const s = await startStack();
    try {
      const res = await call(s, { method: 'PUT', key: SESSION_TTL_KEY, body });
      assert.equal(res.status, 400, `${label} 必须 400（实际 ${res.status}）`);
      const json = await readJson(res);
      assert.equal(json.error?.code, 'validation_failed', `${label}: 错误码`);
      assert.equal(json.error?.details?.field, 'value', `${label}: field 必须点名 value`);
      assert.equal(dmlStatements(s.pool.statements).length, 0,
        `${label}: 非法值不许发**任何一形**写语句（实发 ${dmlStatements(s.pool.statements).join(' | ')}）`);
      assert.equal(s.pool.runtimeUpsertCalls, 0, `${label}: 非法值不许发 upsert`);
      assert.equal(s.pool.runtimeAuditCalls, 0, `${label}: 更不许写审计`);
    } finally {
      await s.close();
    }
  }
});

// ---------------------------------------------------------------------------
// ⑦ registry 自证：本文件用到的 key 真在登记表里（防止「测试写了个不存在的 key」假绿）
// ---------------------------------------------------------------------------

test('RS-API-7 自证：SESSION_TTL_KEY 真在 registry 里，且 applyMode=hot / env 名对得上', () => {
  assert.equal(isKnownSetting(SESSION_TTL_KEY), true, 'P2a 的第一格旋钮必须在 registry 里');
  const entry = RUNTIME_SETTING_REGISTRY[SESSION_TTL_KEY];
  assert.equal(entry.applyMode, 'hot', '这一格是 hot，否则「改完立即生效」这条判据不成立');
  assert.equal(entry.envVar, 'SESSION_TTL_SECONDS', 'env 兜底名必须与 docs/env.md 一致');
});

// ---------------------------------------------------------------------------
// ⑧ body 本身不是对象 ⇒ `details.field='body'`（#701 返修 LOW②）
// ---------------------------------------------------------------------------

test("RS-API-8 PUT 的 body 是 null / 数组 / 字符串 ⇒ 400 details.field=body，且零写库", async () => {
  // 实现一直是对的（独立审计拿临时 HTTP 探针验过），但**没有防回归格**：形状闸只长在 `http.js`
  // 那一处，有人把「不是对象」那一支删掉、或退化成直接取 `body.value`，旧格子一格都不会红。
  // ⚠ 必须发**合法但不是对象**的 JSON：空体 PUT 会被 `readJsonBody` 兼平成 `{}` ⇒ 判的是
  //   `field=value` 那一格（RS-API-6），不是这一格。
  for (const [label, rawBody] of [['null', 'null'], ['数组', '[1,2]'], ['字符串', '"86400"']]) {
    const s = await startStack();
    try {
      const res = await fetch(`${s.base}/api/admin/runtime-settings/${SESSION_TTL_KEY}`, {
        method: 'PUT',
        headers: { cookie: s.cookieFor('root'), 'content-type': 'application/json' },
        body: rawBody,
      });
      assert.equal(res.status, 400, `${label} 当请求体必须 400（实得 ${res.status}）`);
      const json = await readJson(res);
      assert.equal(json.error?.code, 'validation_failed', `${label}：错误码`);
      assert.equal(json.error?.details?.field, 'body',
        `${label}：field 必须点名是 **body** 不对（实得 ${JSON.stringify(json.error?.details)}）`);
      const writes = dmlStatements(s.pool.statements);
      assert.equal(writes.length, 0, `${label}：形状都不对的请求不许留下一形写（${writes.join(' | ')}）`);
      assert.equal(s.pool.runtimeUpsertCalls, 0, `${label}：更不许发 upsert`);
      assert.equal(s.pool.runtimeAuditCalls, 0, `${label}：也不许写审计`);
    } finally {
      await s.close();
    }
  }
});
