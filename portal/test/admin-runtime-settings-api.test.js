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
    maxLoginLength: 128, maxPasswordLength: 256,
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

// `locale` 可选：传了就往 cookie 前面拼上 `locale=<x>; `（#803 S1：验服务端按 cookie 语言出 label/hint）；
// 不传 ⇒ cookie 逐字等于 `s.cookieFor(login)`，既有请求行为一字不变。
const call = (s, { method = 'GET', key, body, login = 'root', locale } = {}) => fetch(
  `${s.base}/api/admin/runtime-settings${key === undefined ? '' : `/${key}`}`,
  {
    method,
    headers: {
      cookie: `${locale ? `locale=${locale}; ` : ''}${s.cookieFor(login)}`,
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
 * 「零写库」的**唯一量尺**（#701 返修 LOW① + 二审 LOW①）：数**写动词出现在语句的任何位置**，
 * 而不是「语句以什么开头」。
 *
 * 为什么不能只盯 `runtimeUpsertCalls` / `runtimeAuditCalls`：那两个各自只在对应分支自增
 *（一个只数 `INSERT INTO runtime_settings`，一个只数 `INSERT INTO audit_log`）⇒「403 之后其实
 * 发了另一形写语句」（`UPDATE runtime_settings` / `DELETE …` / 写别的表）在旧判据下**绿着过**。
 *
 * 为什么**不能看开头**（二审 LOW①，独立审计实测：`WITH … INSERT` 计数 0）：
 * `WITH x AS (…) INSERT INTO …` 这种 data-modifying CTE 是**真写**，但开头是 `WITH`
 * ⇒ 旧的 `/^\s*(INSERT|UPDATE|DELETE)/` 直接漏掉。本仓的写路径就有这一族形状（`upload-settings.js`
 * 的旧 `SAVE_SQL`、CTE 里记账的写法），所以「这条 SQL 以 SELECT 开头」根本不能当成「它不写」。
 *
 * 现在的形状（三种写形，位置无关）：`INSERT INTO <表>` / `UPDATE <表> … SET` / `DELETE FROM <表>`。
 * ⚠ 反向的「别把读判成写」同样必须有，否则鉴权自己那些 SELECT 会把判据刷成假红：
 *   · `WITH x AS (SELECT 1) SELECT * FROM x` —— **纯读 CTE** 一形都不占；
 *   · `SELECT … FOR UPDATE` —— 锁定读，后面没有 `SET` ⇒ 不算写（`UPDATE` 必须跟 `SET` 才算）。
 *
 * `idempotency_keys` 那族例外按**写入目标**判，不按「语句里出现过这个名字」判（二审 §2 点名的第二
 * 个漏）：`INSERT INTO runtime_settings … SELECT … FROM idempotency_keys` 写的仍是业务表 ⇒ 算写；
 * 只有「这条语句写的全是 `idempotency_keys`」（框架层的幂等记账，与 TLS 那块同口径）才免。
 */
const FRAMEWORK_ONLY_TABLE = 'idempotency_keys';

/** 三种写形的「动词 + 目标表」。`UPDATE` 要求同句里跟着 `SET`（把 `FOR UPDATE` 这种锁定读排除掉）。 */
const WRITE_TARGET_RES = [
  /\bINSERT\s+INTO\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/gi,
  /\bDELETE\s+FROM\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)/gi,
  /\bUPDATE\s+("?[A-Za-z_][\w$]*"?(?:\."?[A-Za-z_][\w$]*"?)?)[\s\S]*?\bSET\b/gi,
];

/** 目标表名：去引号、去掉 schema 前缀、小写（`public."Idempotency_Keys"` ⇒ `idempotency_keys`）。 */
function targetName(raw) {
  return String(raw).replace(/"/g, '').split('.').pop().toLowerCase();
}

/** 这条语句写了**哪些**表（认三种写形的动词 + 目标，位置无关；一条都不写 ⇒ 空数组）。 */
function writeTargets(sql) {
  const out = [];
  // `matchAll` 内部会复制正则（不把 `lastIndex` 留在共享对象上），所以这里可以复用常量。
  for (const re of WRITE_TARGET_RES) for (const m of sql.matchAll(re)) out.push(targetName(m[1]));
  return out;
}

function dmlStatements(statements) {
  return (statements ?? [])
    .map((s) => String(typeof s === 'string' ? s : (s?.sql ?? '')))
    .filter((sql) => {
      const targets = writeTargets(sql);
      // 有写目标，且**至少一个不是**幂等记账表 ⇒ 这条是真写（混合形状也算：CTE 记账 + 主体写业务表）。
      return targets.length > 0 && targets.some((t) => t !== FRAMEWORK_ONLY_TABLE);
    });
}

test('RS-API-1 非管理员 GET / PUT 都 403，且 PUT 一条写语句都不发', async () => {
  // 量尺自证（判据自己也得有牙）：二审 LOW① 的红法就是这一格 —— 把量尺改回「只看语句开头」，
  // `WITH … INSERT` 那条必须点名红。**四种写形都必须算写**，一条都不许漏（漏 = 「零写库」假绿）。
  for (const [label, sql] of [
    ['裸 INSERT', 'INSERT INTO whatever (a) VALUES (1)'],
    ['WITH … INSERT（data-modifying CTE）',
      'WITH s AS (SELECT 1 AS n) INSERT INTO runtime_settings (key, value) SELECT \'k\', n FROM s'],
    ['UPDATE … SET', 'UPDATE runtime_settings SET value = $1'],
    ['WITH … UPDATE（CTE 里改）',
      'WITH s AS (SELECT 1 AS n) UPDATE runtime_settings SET value = (SELECT n FROM s)'],
    ['DELETE FROM', 'DELETE FROM runtime_settings'],
    ['WITH … DELETE FROM（CTE 里删）',
      'WITH s AS (SELECT 1 AS n) DELETE FROM runtime_settings WHERE value = (SELECT n FROM s)'],
  ]) {
    assert.deepEqual(dmlStatements([sql]), [sql], `${label} 必须算写（漏掉它 = 「零写库」是假绿）`);
  }
  // 反向：这些**必须不算写**（把读判成写 = 判据天天红，等于没有判据）。
  assert.deepEqual(dmlStatements([
    'SELECT * FROM runtime_settings',
    '  SELECT 1 FROM sessions',
    'WITH x AS (SELECT 1) SELECT * FROM x',                          // 纯读 CTE：一形都不占
    'SELECT value FROM runtime_settings WHERE key = $1 FOR UPDATE',   // 锁定读：UPDATE 后没有 SET
    'INSERT INTO idempotency_keys (a) VALUES (1)',                    // 框架幂等记账（目标就是它）
    'WITH d AS (DELETE FROM idempotency_keys WHERE k = $1 RETURNING 1) SELECT 1', // 只记幂等账
  ]), [], '鉴权的 SELECT / 纯读 CTE / 锁定读 / 只写幂等表的记账都不算写');
  // 例外只按**目标**免：「语句里提到 idempotency_keys」不是免检牌（旧口径在这里计数 0）。
  assert.deepEqual(dmlStatements([
    'INSERT INTO runtime_settings (key, value) SELECT key, value FROM idempotency_keys',
  ]).length, 1, '写的是业务表、只是**提到**幂等表 ⇒ 仍算写（旧口径整条排除 = 漏真写）');

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

// ---------------------------------------------------------------------------
// ⑤ #803 S1：请求语言决定服务端下发文案的语言（`Cookie: locale=`）
// ---------------------------------------------------------------------------

const CJK_RE_803 = /[\u2E80-\u2EFF\u3000-\u303F\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

test('RS-API-9 Cookie locale=en ⇒ GET 的 label/hint 全英文且不含 CJK；缺 labelEn 也不该出现', async () => {
  const s = await startStack();
  try {
    const res = await call(s, { locale: 'en' });
    assert.equal(res.status, 200);
    const body = await readJson(res);
    assert.equal(body.items.length, 12, '12 条都要在');
    // 逐条：label 必须等于 registry 的 labelEn，且不含 CJK。
    for (const item of body.items) {
      const entry = RUNTIME_SETTING_REGISTRY[item.key];
      assert.ok(entry, `响应里冒出未知 key：${item.key}`);
      assert.equal(item.label, entry.labelEn, `${item.key}: locale=en 时 label 必须是英文 labelEn`);
      assert.ok(!CJK_RE_803.test(item.label), `${item.key}: 英文 label 不许含 CJK：${item.label}`);
      if (typeof entry.hint === 'string' && entry.hint !== '') {
        assert.equal(item.hint, entry.hintEn, `${item.key}: locale=en 时 hint 必须是英文 hintEn`);
        assert.ok(!CJK_RE_803.test(item.hint), `${item.key}: 英文 hint 不许含 CJK：${item.hint}`);
      }
    }
    // 点名单条（万一上面循环被写空，这两条兜底钉死）。
    const sess = body.items.find((i) => i.key === SESSION_TTL_KEY);
    assert.equal(sess.label, 'Login session lifetime (seconds)');
    assert.ok(!('hint' in sess), 'session.ttl_seconds 无 hint ⇒ 连键都不带');
  } finally {
    await s.close();
  }
});

test('RS-API-10 不带 locale cookie ⇒ GET 的 label/hint 仍是中文（缺省 zh-CN 不许漂）', async () => {
  const s = await startStack();
  try {
    const res = await call(s);
    assert.equal(res.status, 200);
    const body = await readJson(res);
    for (const item of body.items) {
      const entry = RUNTIME_SETTING_REGISTRY[item.key];
      assert.equal(item.label, entry.label, `${item.key}: 缺省 label 必须是中文`);
      assert.ok(CJK_RE_803.test(item.label), `${item.key}: 缺省 label 应仍是中文：${item.label}`);
      if (typeof entry.hint === 'string' && entry.hint !== '') {
        assert.equal(item.hint, entry.hint, `${item.key}: 缺省 hint 必须是中文`);
      }
    }
    const sess = body.items.find((i) => i.key === SESSION_TTL_KEY);
    assert.equal(sess.label, '登录会话有效期（秒）');
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// ⑥ #803 返修 M1：**保存成功的那一行**也按请求语言出。
// 为什么必须单独一格：前端 `stores/admin.ts#replaceRuntimeSetting` 拿 PUT 回的 `item`
// **顶掉表格里的那一行**，不是重新 GET——所以「PUT 恒中文」在界面上的形状是「英文页面
// 保存一次，那一行的名称与小字当场变回中文」，而 GET 那一格（RS-API-9/10）绿着抓不到。
// ---------------------------------------------------------------------------

test('RS-API-11 PUT locale=en ⇒ 回包 item 的 label/hint 是英文（前端会顶掉整行，恒中文会当场变回中文）', async () => {
  const s = await startStack();
  try {
    // 无 hint 的一格：只钉 label。
    const r1 = await call(s, { method: 'PUT', key: SESSION_TTL_KEY, body: { value: 7200 }, locale: 'en' });
    assert.equal(r1.status, 200, `PUT 必须 200（实际 ${r1.status}）`);
    const b1 = await readJson(r1);
    assert.equal(b1.item.label, RUNTIME_SETTING_REGISTRY[SESSION_TTL_KEY].labelEn,
      'locale=en 时回包 label 必须是 labelEn');
    assert.ok(!CJK_RE_803.test(b1.item.label), `英文 label 不许含 CJK：${b1.item.label}`);
    assert.ok(!('hint' in b1.item), '这一格没登记 hint ⇒ 连键都不带（与 GET 同形）');
    // 上面循环万一被写空，这一条兜底钉死逐字。
    assert.equal(b1.item.label, 'Login session lifetime (seconds)');
    // 有 hint 的一格：hint 也要跟着翻（两个字段在两个地方，只改一个会一半中一半英）。
    const r2 = await call(s, { method: 'PUT', key: 'workspace.retention_days', body: { value: 30 }, locale: 'en' });
    assert.equal(r2.status, 200, `PUT 必须 200（实际 ${r2.status}）`);
    const b2 = await readJson(r2);
    const entry2 = RUNTIME_SETTING_REGISTRY['workspace.retention_days'];
    assert.equal(b2.item.label, entry2.labelEn, 'locale=en 时 label 出英文');
    assert.equal(b2.item.hint, entry2.hintEn, 'locale=en 时 hint 也必须出英文');
    assert.ok(!CJK_RE_803.test(b2.item.hint), `英文 hint 不许含 CJK：${b2.item.hint}`);
  } finally {
    await s.close();
  }
});

test('RS-API-12 PUT 不带 locale cookie ⇒ 回包 item 的 label/hint 逐字中文（缺省不许漂成 en）', async () => {
  const s = await startStack();
  try {
    const r1 = await call(s, { method: 'PUT', key: SESSION_TTL_KEY, body: { value: 7200 } });
    assert.equal(r1.status, 200);
    const b1 = await readJson(r1);
    assert.equal(b1.item.label, '登录会话有效期（秒）', '缺省 label 必须逐字中文');
    assert.ok(CJK_RE_803.test(b1.item.label), `缺省 label 必须含中文：${b1.item.label}`);
    const r2 = await call(s, { method: 'PUT', key: 'workspace.retention_days', body: { value: 30 } });
    const b2 = await readJson(r2);
    const entry2 = RUNTIME_SETTING_REGISTRY['workspace.retention_days'];
    assert.equal(b2.item.label, entry2.label, '缺省 label 必须是 registry 的中文');
    assert.equal(b2.item.hint, entry2.hint, '缺省 hint 必须是 registry 的中文');
    assert.ok(CJK_RE_803.test(b2.item.hint), `缺省 hint 应仍是中文：${b2.item.hint}`);
    // 写侧裁决与语言无关：两种 locale 存的都是同一个值、都恰好一条审计。
    assert.equal(s.pool.runtimeRows.get(SESSION_TTL_KEY), 7200);
    assert.equal(s.pool.runtimeRows.get('workspace.retention_days'), 30);
  } finally {
    await s.close();
  }
});
