// issue #677 P1：`runtime_settings` 底座（DB > env > 默认 的覆盖层）的单测。
//
// P1 那一片一格旋钮都没迁（机制靠**注入的测试 registry** 验）；**P2a 迁了第一格**
// `session.ttl_seconds` ⇒ 本文件现在两类格子都有：
//   * RS-1…RS-11：底座本身（仍全部用注入的 registry，与真旋钮无关，红法不变）；
//   * RS-7：产品 registry 的**边界**（P2a 起从「空对象」改成「只有这一格」，红法不变：
//     有人顺手多迁一格、或把热读/失效钩子弄丢，它就红）；
//   * RS-12…RS-17：第一格本身（解析/校验/热读三档/5s 缓存/写后失效/管理台读侧/真库）。
//     HTTP 那几格在 `portal/test/admin-runtime-settings-api.test.js`（那里才能判「PUT 完
//     下一次登录就生效」）。
//
// 判据取自工单 §1④ 的六格（RS-1…RS-6），另加几格钉住边界与返修：
//   RS-4b 孤儿行（registry 不认的 key）⇒ problems 点名 + 只聚合 warn 一次 + 不抛（MED①）
//   RS-6  写 = **一个事务**（BEGIN → FOR UPDATE → upsert → 审计 → COMMIT）+ RS-6b 审计被抑制
//         ⇒ 抛 500 且设置没落库（MED②；检查必须在 COMMIT 之前）
//   RS-7 registry 的边界（P2a：只迁了第一格；启动路径那一次是整表一次而不是 per-key 一次）
//   RS-8 迁移 0046 的形状（jsonb / key 形状 CHECK / 零值域 CHECK / 无 BEGIN / 无 FK / baseline 冻结）
//   RS-9 `serve()` 接线（覆盖层在 migrate 之后、createServer 之前，且**所有循环**都用它）
//   RS-10 读侧超时旋钮（`RUNTIME_SETTINGS_READ_TIMEOUT_MS`：只收正整数、且真的传给 setTimeout）
//   RS-11 真库：一个事务真的落库 + 审计被 trigger 抑制时设置没改 + 行锁真的拦人 + key CHECK
//   RS-12…RS-16 第一格的解析/校验、热读三档、5s 缓存的两端、保存后失效、管理台读侧三档来源
//   RS-17 真库：保存后热读**不等 5 秒**就是新值 + 管理台读侧报 source=db + 非法值写不进库
//   RS-18…RS-20 **PR #701 返修 MED**：冷缓存并发只发一条 SQL（in-flight 合并）/ 那趟失败必清槽 /
//         在飞期间保存成功也要清槽（三条各钉一条红法，见 §7 的注释）
//   RS-21   **PR #701 返修 LOW③**：env 兜底值也必须过 registry 的 `parse`/`validate`
//           （坏值 ⇒ 回落默认 + 点名 warn；好值照收；DB 优先级不许因为这道闸漂移）
//   RS-22   **PR #701 二审 LOW②**：DB 读失败**叠加**坏 env ⇒ 同一次热读只 warn 一条，
//           且那一条同时点名两件事（DB 侧原因 + env 侧被拒的理由）；单件事的文案不许被改形
//
// 隔离约定（docs/testing.md §2.1）：本地 fake pool，不碰真实 DB；不起 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createPgFixture } from './pg-fixture.js';

import {
  RUNTIME_SETTING_REGISTRY, RuntimeSettingsError, isKnownSetting,
  readRuntimeSettings, applyRuntimeOverrides, saveRuntimeSetting,
  readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, READ_TIMEOUT_ENV_VAR,
  AUDIT_ACTION, AUDIT_TARGET_PREFIX,
  SESSION_TTL_KEY, SESSION_TTL_MIN_SECONDS, SESSION_TTL_MAX_SECONDS, SESSION_TTL_DEFAULT_SECONDS,
  SESSION_TTL_CACHE_TTL_MS, HOT_READ_CACHE_TTL_MS,
  parseSessionTtlSeconds, validateSessionTtlSeconds,
  readSessionTtlSeconds, invalidateSessionTtlCache, HOT_READ_INVALIDATORS,
  WORKSPACE_RETENTION_KEY, WORKSPACE_RETENTION_MAX_DAYS, WORKSPACE_RETENTION_DEFAULT_DAYS,
  parseWorkspaceRetentionDays, validateWorkspaceRetentionDays,
  readWorkspaceRetentionDays, invalidateWorkspaceRetentionCache,
  listRuntimeSettingsAdmin, updateRuntimeSettingAdmin, WORKSPACE_RETENTION_HINT,
  PREVIEW_TICKET_TTL_KEY, PREVIEW_TICKET_TTL_MIN_SECONDS, PREVIEW_TICKET_TTL_MAX_SECONDS,
  PREVIEW_TICKET_TTL_DEFAULT_SECONDS, parsePreviewTicketTtlSeconds, validatePreviewTicketTtlSeconds,
  readPreviewTicketTtlSeconds, invalidatePreviewTicketTtlCache,
  AUTO_TITLE_MIN_NEW_KEY, AUTO_TITLE_MIN_NEW_MIN, AUTO_TITLE_MIN_NEW_MAX,
  AUTO_TITLE_MIN_NEW_DEFAULT, parseAutoTitleMinNew, validateAutoTitleMinNew,
  AUTO_TITLE_MIN_NEW_HINT,
  readAutoTitleMinNew, invalidateAutoTitleMinNewCache,
  PREVIEW_SESSION_TTL_KEY, PREVIEW_SESSION_TTL_MIN_SECONDS, PREVIEW_SESSION_TTL_MAX_SECONDS,
  PREVIEW_SESSION_TTL_DEFAULT_SECONDS, parsePreviewSessionTtlSeconds,
  validatePreviewSessionTtlSeconds, PREVIEW_SESSION_TTL_HINT,
  readPreviewSessionTtlSeconds, invalidatePreviewSessionTtlCache,
  ONBOARDING_IDLE_BACKOFF_MS_KEY, OFFBOARDING_IDLE_BACKOFF_MS_KEY, PROVISIONER_IDLE_BACKOFF_MS_KEY,
  IDLE_BACKOFF_MS_MIN, IDLE_BACKOFF_MS_SHARED_MAX, PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP,
  ONBOARDING_IDLE_BACKOFF_MS_DEFAULT, OFFBOARDING_IDLE_BACKOFF_MS_DEFAULT,
  PROVISIONER_IDLE_BACKOFF_MS_DEFAULT,
  ONBOARDING_IDLE_BACKOFF_MS_HINT, OFFBOARDING_IDLE_BACKOFF_MS_HINT, PROVISIONER_IDLE_BACKOFF_MS_HINT,
  parseOnboardingIdleBackoffMs, validateOnboardingIdleBackoffMs,
  parseOffboardingIdleBackoffMs, validateOffboardingIdleBackoffMs,
  parseProvisionerIdleBackoffMs, validateProvisionerIdleBackoffMs,
  readOnboardingIdleBackoffMaxMs, invalidateOnboardingIdleBackoffCache,
  readOffboardingIdleBackoffMaxMs, invalidateOffboardingIdleBackoffCache,
  readProvisionerIdleBackoffMaxMs, invalidateProvisionerIdleBackoffCache,
  PENDING_TOKEN_TTL_SECONDS_KEY, SESSION_RENEW_INTERVAL_SECONDS_KEY,
  MAX_PASSWORD_LENGTH_KEY, MAX_LOGIN_LENGTH_KEY,
  PENDING_TOKEN_TTL_SECONDS_MIN, PENDING_TOKEN_TTL_SECONDS_MAX, PENDING_TOKEN_TTL_SECONDS_DEFAULT,
  SESSION_RENEW_INTERVAL_SECONDS_MIN, SESSION_RENEW_INTERVAL_SECONDS_MAX,
  SESSION_RENEW_INTERVAL_SECONDS_DEFAULT,
  MAX_PASSWORD_LENGTH_MIN, MAX_PASSWORD_LENGTH_MAX, MAX_PASSWORD_LENGTH_DEFAULT,
  MAX_LOGIN_LENGTH_MIN, MAX_LOGIN_LENGTH_MAX, MAX_LOGIN_LENGTH_DEFAULT,
  PENDING_TOKEN_TTL_SECONDS_HINT, SESSION_RENEW_INTERVAL_SECONDS_HINT,
  MAX_PASSWORD_LENGTH_HINT, MAX_LOGIN_LENGTH_HINT,
  parsePendingTokenTtlSeconds, validatePendingTokenTtlSeconds,
  parseSessionRenewIntervalSeconds, validateSessionRenewIntervalSeconds,
  parseMaxPasswordLength, validateMaxPasswordLength,
  parseMaxLoginLength, validateMaxLoginLength,
  readPendingTokenTtlSeconds, invalidatePendingTokenTtlCache,
  readSessionRenewIntervalSeconds, invalidateSessionRenewIntervalCache,
  readMaxPasswordLength, invalidateMaxPasswordLengthCache,
  readMaxLoginLength, invalidateMaxLoginLengthCache,
} from '../src/runtime-settings.js';
import { MAX_BACKOFF_MS_SAFE } from '../src/loop-timing.js';
import {
  IDLE_BACKOFF_MAX_MS_DEFAULT as ONBOARDING_LOOP_DEFAULT,
} from '../src/onboarding.js';
import {
  IDLE_BACKOFF_MAX_MS_DEFAULT as OFFBOARDING_LOOP_DEFAULT,
} from '../src/offboarding.js';
import {
  IDLE_BACKOFF_MAX_MS_DEFAULT as PROVISIONER_LOOP_DEFAULT,
  IDLE_BACKOFF_MAX_MS_BUSINESS_CAP as PROVISIONER_LOOP_CAP,
  resolveIdleBackoffMaxMs,
} from '../src/provisioner.js';
import { loadConfig } from '../src/config.js';

const ACTOR = 'd0000000-0000-4000-8000-0000000000a1';

// RS-11 是**真库**格子（环境门口径同 `migrate-fresh-db.test.js`：无 PG 就整体 skip，不假通过）。
const SUPER_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const PG_SKIP = SUPER_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL 未设置：RS-11 需一次性 postgres:16（docs/testing.md §2.2.1）';
const pgFixture = SUPER_DATABASE_URL
  ? createPgFixture(SUPER_DATABASE_URL, { prefix: 'w677' }) : null;
const pgSilent = { log() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 正整数解析：只认 JSON number 的正整数，或**纯十进制数字串**（`'1e4'` / `' 10 '` 一律拒）。 */
function parseCount(raw) {
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw > 0
      ? { ok: true, value: raw } : { ok: false, reason: 'not_a_count' };
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0
      ? { ok: true, value: n } : { ok: false, reason: 'not_a_count' };
  }
  return { ok: false, reason: 'not_a_count' };
}

/** 测试用的 registry（**不是**产品真相；P1 的产品 registry 是空的，见 RS-7）。 */
const TEST_REGISTRY = {
  'demo.limit': {
    configPath: 'demoLimit',
    envVar: 'DEMO_LIMIT',
    defaultValue: 5,
    parse: parseCount,
    validate: (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? true : '必须是正整数'),
  },
  'demo.interval_ms': {
    configPath: 'demo.intervalMs',   // 点分路径：验 `setPath` 不污染入参的嵌套对象
    envVar: 'DEMO_INTERVAL_MS',
    defaultValue: 1000,
    parse: parseCount,
    validate: (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? true : '必须是正整数'),
  },
};

const silentLog = { debug() {}, warn() {}, error() {}, log() {} };

/** 收 log 的假 logger（点名式断言用：回落必须**点名是哪个 key**）。 */
function collectingLog() {
  const seen = { warn: [], debug: [] };
  return {
    seen,
    debug: (m) => seen.debug.push(String(m)),
    warn: (m) => seen.warn.push(String(m)),
    error: (m) => seen.warn.push(String(m)),
    log: () => {},
  };
}

/**
 * 本地 fake pool（形状照 `portal/test/fake-pool.js` 的口径：**SQL 里没写的东西不好心补**，
 * 未预期的语句直接抛，而不是放行造成假绿）。
 * `sqlLog` / `queryCount` 是给「零写库」「事务形状」那两条判据数的。
 *
 * `connect()` 的**提交/回滚语义**照 `fake-pool.js` 给 git-credential（#183）与 upload-settings
 * （#698）用的那一套：`BEGIN` 开账 → `ROLLBACK` 逐条撤销 → `COMMIT` 落账。本 fake 的「账」是
 * `pending`（事务内的 upsert/审计）与 `committed`（已提交状态）两层：这样「审计被抑制 ⇒
 * 设置也没落库」在 fake 上也能真判（不是只盯 SQL 文本的形状闸）。
 * ⚠ fake **不模拟 MVCC / 行锁**（并发链那部分只有真库能判，见 RS-11）。
 */
class FakeRuntimePool {
  constructor({
    rows = [], throwOnSelect = null, hangOnSelect = false, hangOnWrite = false, returning = null,
    auditRowCount = 1, upsertReturnsRow = true,
  } = {}) {
    this.throwOnSelect = throwOnSelect;
    this.hangOnSelect = hangOnSelect;
    this.hangOnWrite = hangOnWrite;
    this.returning = returning;
    // 审计影响行数：0 = 模拟「审计被静默抑制」（真库里就是 trigger `RETURN NULL`）。
    this.auditRowCount = auditRowCount;
    this.upsertReturnsRow = upsertReturnsRow;
    this.committed = new Map(rows.map((r) => [r.key, r.value]));   // 已提交的 runtime_settings
    this.auditCommitted = [];                                       // 已提交的审计行
    this.pending = null;                                            // 事务内未提交的 upsert
    this.auditPending = null;                                       // 事务内未提交的审计
    this.inTx = false;
    this.sqlLog = [];
    this.queryCount = 0;
    this.connectCount = 0;
    this.releaseCount = 0;
  }

  query(sql, params = []) {
    this.queryCount += 1;
    this.sqlLog.push({ sql: String(sql), params });
    const text = String(sql);
    if (/^\s*BEGIN\b/i.test(text)) {
      this.inTx = true;             // 重复 BEGIN：PG 只给 warning ⇒ fake 也不许比真库更严
      this.pending = this.pending ?? new Map();
      this.auditPending = this.auditPending ?? [];
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/^\s*COMMIT\b/i.test(text)) {
      for (const [k, v] of (this.pending ?? new Map())) this.committed.set(k, v);
      this.auditCommitted.push(...(this.auditPending ?? []));
      this.pending = null;
      this.auditPending = null;
      this.inTx = false;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/^\s*ROLLBACK\b/i.test(text)) {
      this.pending = null;          // 逐条撤销：事务里的 upsert 与审计一起消失
      this.auditPending = null;
      this.inTx = false;
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (/\bINSERT\b/i.test(text)) return this.#write(text, params);
    if (/\bruntime_settings\b/i.test(text)) {
      if (/\bFOR\s+UPDATE\b/i.test(text)) {
        const key = params[0];
        const missing = !this.committed.has(key) && !(this.pending ?? new Map()).has(key);
        if (missing) return Promise.resolve({ rows: [], rowCount: 0 });   // 首写：无旧行
        const value = this.pending?.has(key) ? this.pending.get(key) : this.committed.get(key);
        return Promise.resolve({ rows: [{ value }], rowCount: 1 });
      }
      // 整表读（`SELECT_SQL`）：已提交 + 事务内未提交的改动（未提交的部分只有本连接看得见）。
      const merged = new Map(this.committed);
      for (const [k, v] of (this.pending ?? new Map())) merged.set(k, v);
      if (this.hangOnSelect) return new Promise(() => {});
      if (this.throwOnSelect) return Promise.reject(this.throwOnSelect);
      const rows = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([key, value]) => ({ key, value }));
      return Promise.resolve({ rows, rowCount: rows.length });
    }
    return Promise.reject(new Error(`FakeRuntimePool：未预期的 SQL：${text.slice(0, 80)}`));
  }

  // 事务里的两条写：upsert 进 pending（提交才落账），审计按 `auditRowCount` 决定写不写得进。
  #write(text, params) {
    if (this.hangOnWrite) return new Promise(() => {});
    if (/INSERT\s+INTO\s+audit_log\b/i.test(text)) {
      if (this.auditRowCount === 0) return Promise.resolve({ rows: [], rowCount: 0 });
      (this.auditPending ??= []).push(JSON.parse(params[3]));
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    const [key, jsonValue, actorId] = params;
    const stored = this.returning?.value ?? JSON.parse(jsonValue);
    (this.pending ??= new Map()).set(key, stored);
    if (!this.upsertReturnsRow) return Promise.resolve({ rows: [], rowCount: 0 });
    return Promise.resolve({
      rows: [this.returning ?? {
        key,
        value: stored,
        updated_at: new Date('2026-11-19T00:00:00.000Z'),
        updated_by: actorId,
      }],
      rowCount: 1,
    });
  }

  /** 当前「库里」的值（已提交那一层 —— 没 COMMIT 的不算落库）。 */
  storedValue(key) {
    return this.committed.get(key);
  }

  /** 把 sqlLog 归成角色序列（事务形状判据用）。 */
  roles() {
    return this.sqlLog.map(({ sql }) => {
      if (/^\s*BEGIN\b/i.test(sql)) return 'BEGIN';
      if (/^\s*COMMIT\b/i.test(sql)) return 'COMMIT';
      if (/^\s*ROLLBACK\b/i.test(sql)) return 'ROLLBACK';
      if (/INSERT\s+INTO\s+audit_log\b/i.test(sql)) return 'AUDIT';
      if (/INSERT\s+INTO\s+runtime_settings\b/i.test(sql)) return 'UPSERT';
      if (/\bFOR\s+UPDATE\b/i.test(sql)) return 'SELECT_FOR_UPDATE';
      return 'OTHER';
    });
  }

  /** 写库那条语句里是否出现 `INSERT`（RS-5 的「零写库」判据）。 */
  insertStatements() {
    return this.sqlLog.filter((s) => /\bINSERT\b/i.test(s.sql));
  }

  /** 事务必须钉在同一条连接上 ⇒ `pool.connect()` + `release()`（#698 的同形病根）。 */
  connect() {
    this.connectCount += 1;
    const self = this;
    return {
      query: (sql, params) => self.query(sql, params),
      release: () => { self.releaseCount += 1; },
    };
  }
}

const missingTable = () => Object.assign(
  new Error('relation "runtime_settings" does not exist'), { code: '42P01' },
);

// ---------------------------------------------------------------------------
// 1. 读侧永不抛：抛错与不返回，两种都要回落（口径 1 + 5）
// ---------------------------------------------------------------------------

test('RS-1 读侧永不抛·表不存在（pool 抛 42P01）⇒ values 空 + problems 点名，覆盖层原样返回 config', async () => {
  const pool = new FakeRuntimePool({ throwOnSelect: missingTable() });
  const log = collectingLog();
  const { values, problems } = await readRuntimeSettings({
    pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log,
  });

  assert.deepEqual(values, {}, '读失败时一格 DB 值都不许有（有值就是"猜出来的"）');
  assert.deepEqual(
    problems.map((p) => [p.key, p.reason]).sort(),
    [['demo.interval_ms', 'read_failed'], ['demo.limit', 'read_failed']],
    '每个登记 key 都要有一条 read_failed（运维要能知道**哪些**旋钮回落了）',
  );
  assert.equal(log.seen.warn.length, 1, '抛错这一档必须 warn 一次（超时那一档才只留 debug）');
  assert.match(log.seen.warn[0], /demo\.limit/, 'warn 必须点名 key（否则运维不知道去哪里改）');

  const config = { demoLimit: 10, demo: { intervalMs: 2000 }, port: 8080 };
  const out = await applyRuntimeOverrides(config, { pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log });
  assert.deepEqual(out, config, '读失败 ⇒ 覆盖层内容与 config 相同（DB 那一档整档不可用）');
  assert.notEqual(out, config, '但必须是**新对象**（不许原地改 loadConfig 的返回值）');
  assert.deepEqual(config, { demoLimit: 10, demo: { intervalMs: 2000 }, port: 8080 },
    '入参 config 一字节未动');
});

test('RS-2 读侧永不抛·查询不返回（永不 settle 的 pool）⇒ 到 timeoutMs 回落，只留 debug 不刷 warn', async () => {
  const pool = new FakeRuntimePool({ hangOnSelect: true });
  const log = collectingLog();
  const started = Date.now();
  const { values, problems } = await readRuntimeSettings({
    pool, registry: TEST_REGISTRY, timeoutMs: 30, env: {}, log,
  });
  const elapsed = Date.now() - started;

  assert.deepEqual(values, {}, '挂住的读取不许贡献任何 DB 值');
  assert.deepEqual(
    problems.map((p) => [p.key, p.reason]).sort(),
    [['demo.interval_ms', 'read_timeout'], ['demo.limit', 'read_timeout']],
    '「不返回」必须是 read_timeout —— 与 read_failed 混成一个 reason 就是假口径',
  );
  assert.ok(elapsed < 1000, `到点就要给答案，实测 ${elapsed}ms（超过 1s 说明超时没生效、测试在等驱动）`);
  assert.ok(elapsed >= 25, `也不许提前给答案（实测 ${elapsed}ms < 30ms 的预算 ⇒ 定时器没起作用）`);
  assert.deepEqual(log.seen.warn, [], '超时是常态兜底 ⇒ 不 warn（一个慢 DB 不该把日志刷满，#520 同族）');
  assert.equal(log.seen.debug.length, 1, '但要留一条 debug（值班的人仍能查到发生过什么）');

  const config = { demoLimit: 10 };
  const out = await applyRuntimeOverrides(config, { pool, registry: TEST_REGISTRY, timeoutMs: 30, env: {}, log });
  assert.equal(out.demoLimit, 10, '超时那一档照样回落 env（config 里的值）');
});

// ---------------------------------------------------------------------------
// 2. 优先级与非法值（口径 1 + 2）
// ---------------------------------------------------------------------------

test('RS-3 DB > env > 默认：三档各行使一次，且 env 那一档就是传进来的 config', async () => {
  const rows = [{ key: 'demo.limit', value: 20 }];  // 只有 limit 有 DB 行；interval_ms 无行
  const pool = new FakeRuntimePool({ rows });
  const config = { demoLimit: 10, demo: { intervalMs: 2000 } };
  const out = await applyRuntimeOverrides(config, {
    pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log: silentLog,
  });

  assert.equal(out.demoLimit, 20, 'DB 有合法行 ⇒ 用 DB 的 20，压过 env 的 10');
  assert.equal(out.demo.intervalMs, 2000, '无行的那一格保留 config（env 那一档）');
  assert.equal(out.demoLimit !== config.demoLimit, true, 'env 值没被当成最终答案');

  // 第三档：env 也没给（config 里没这个字段）⇒ registry 的 defaultValue。
  const out2 = await applyRuntimeOverrides({}, {
    pool: new FakeRuntimePool({ rows: [] }), registry: TEST_REGISTRY, timeoutMs: 200, env: {},
    log: silentLog,
  });
  assert.equal(out2.demoLimit, 5, 'DB 无行 + config 无字段 ⇒ 用 registry 的默认 5');
  assert.equal(out2.demo.intervalMs, 1000, '嵌套路径的默认值也要补得上');

  // 反向自证：DB 值与 env 值**都**在场时，如果实现写成 env 优先，第一格就红（变异表里那一刀）。
  assert.equal(config.demoLimit, 10, '入参 config 未被改写（覆盖层只改新对象）');
  assert.deepEqual(config.demo, { intervalMs: 2000 }, '嵌套那一层也没被改写（setPath 要浅拷贝沿途）');
});

test('RS-4 非法值回落 + 点名 warn：DB 行是字符串 "1e4" ⇒ 回落 env，problems 点名该 key', async () => {
  const pool = new FakeRuntimePool({ rows: [{ key: 'demo.limit', value: '1e4' }] });
  const log = collectingLog();
  const { values, problems } = await readRuntimeSettings({
    pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log,
  });
  assert.equal(values['demo.limit'], undefined, '"1e4" 不许被收成 1');
  assert.deepEqual(
    problems.find((p) => p.key === 'demo.limit'),
    { key: 'demo.limit', reason: 'not_a_count' },
    'problems 必须点名是哪个 key、为什么不可用',
  );
  assert.equal(log.seen.warn.length, 1, '非法值是「绕过写侧进来的坏行」⇒ 必须 warn');
  assert.match(log.seen.warn[0], /demo\.limit/, 'warn 点名 key');

  const out = await applyRuntimeOverrides({ demoLimit: 10 }, {
    pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log: collectingLog(),
  });
  assert.equal(out.demoLimit, 10, '非法值 ⇒ 回落 env 的 10（既不是 1 也不是 10000，也不是 500）');

  // 形状全家福：逐个都不许按半个值生效（口径 2 的红线）。
  for (const bad of [-1, 0, ' 10 ', '1.5', 1.5, true, false, null, NaN, Infinity, {}, [], '0x10']) {
    const p = new FakeRuntimePool({ rows: [{ key: 'demo.limit', value: bad }] });
    const r = await readRuntimeSettings({
      pool: p, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log: silentLog,
    });
    assert.equal(r.values['demo.limit'], undefined, `${JSON.stringify(bad)} 必须判为不可用`);
  }
});

// ---------------------------------------------------------------------------
// 2b. 孤儿行：registry 不认的 key 必须说话（#677 返修 MED①）
// ---------------------------------------------------------------------------

test('RS-4b 孤儿行（库里有行但 registry 不认）⇒ problems 逐 key 点名 + 只聚合 warn 一次 + 不抛',
  async () => {
    // 真实可发生的形状：P3 逐批往 registry 加/删条目，**删完条目库里就剩孤儿行**。
    // `SELECT_SQL` 是整表一次读 ⇒ 读到了就必须说话（旧实现只存进 rowByKey 从不遭提
    // ⇒ 运维完全看不见，独立审计 MED①）。
    const pool = new FakeRuntimePool({ rows: [
      { key: 'demo.limit', value: 20 },
      { key: 'ghost.old_limit', value: 3 },
      { key: 'demo.removed_in_p3', value: 4 },
    ] });
    const log = collectingLog();
    let threw = null;
    const r = await readRuntimeSettings({
      pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log,
    }).catch((e) => { threw = e; return null; });

    assert.equal(threw, null, '孤儿行不许把读侧弄抛（硬口径 1：配置面不承重）');
    assert.deepEqual(
      r.problems.filter((p) => p.reason === 'unknown_key').map((p) => p.key).sort(),
      ['demo.removed_in_p3', 'ghost.old_limit'],
      '两个孤儿 key 必须各进一条 problems（reason=unknown_key、**点名 key**）',
    );
    assert.deepEqual(Object.keys(r.values), ['demo.limit'],
      '孤儿 key 不许出现在 values（它压根没登记 ⇒ 不生效）');
    assert.equal(r.values['ghost.old_limit'], undefined, '同上，逐 key 钉住');
    assert.deepEqual(
      r.problems.filter((p) => p.key === 'demo.interval_ms').map((p) => p.reason), ['no_row'],
      '登记项自己的理由不许被孤儿行污染（no_row 就是 no_row，不能碎成 unknown_key）',
    );
    assert.equal(log.seen.warn.length, 1,
      `整张表只允许**一条**聚合 warn（实得 ${log.seen.warn.length} 条：${log.seen.warn.join(' | ')}）`);
    assert.match(log.seen.warn[0], /ghost\.old_limit/, '聚合 warn 必须点到名');
    assert.match(log.seen.warn[0], /demo\.removed_in_p3/, '两个 key 都要在里面');
    assert.match(log.seen.warn[0], /2/, '必须报总数（运维要知道有多少行要清）');

    // 覆盖层：孤儿行既不进 config，也不影响登记项那一格走 DB 值。
    const out = await applyRuntimeOverrides({ demoLimit: 10 }, {
      pool, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log: collectingLog(),
    });
    assert.equal(out.demoLimit, 20, '孤儿行不许干扰登记项走 DB 那一档');
    assert.equal(out['ghost.old_limit'], undefined, '孤儿 key 不许被塞进 config');
    // 只有 registry 声明过的两个 configPath 会被写（`demo.interval_ms` 无行 ⇒ 走默认 1000）。
    // #709 MED①：DB 覆盖进来的那一格会额外带一个 `<path>Source='db'` 标注（供热读器回落时
    // 如实定来源）；这是从 registry 声明字段派生的合法标注，不是孤儿键。
    assert.deepEqual(Object.keys(out).sort(), ['demo', 'demoLimit', 'demoLimitSource'],
      '覆盖层只动 registry 声明过的字段（外加它派生的 <path>Source 标注）');
    assert.ok(!JSON.stringify(out).includes('ghost'), '孤儿 key 连名字都不许出现在结果里');

    // 聚合上限：孤儿很多时仍然只一条 warn，只列前 5 个 + 总数（一行一条就是刷屏）。
    const many = new FakeRuntimePool({ rows: [
      ...Array.from({ length: 7 }, (_, i) => ({ key: `ghost.k${i + 1}`, value: i })),
      { key: 'demo.limit', value: 1 },
    ] });
    const manyLog = collectingLog();
    const manyRead = await readRuntimeSettings({
      pool: many, registry: TEST_REGISTRY, timeoutMs: 200, env: {}, log: manyLog,
    });
    assert.equal(manyRead.problems.filter((p) => p.reason === 'unknown_key').length, 7,
      'problems 逐 key 一条不少（只有 warn 会聚合）');
    assert.equal(manyLog.seen.warn.length, 1, '七个孤儿行也只许一条 warn');
    const shown = manyLog.seen.warn[0].match(/ghost\.k\d/g) ?? [];
    assert.equal(shown.length, 5,
      `一条 warn 最多列 5 个 key（实得 ${shown.length}：${manyLog.seen.warn[0]}）`);
    assert.match(manyLog.seen.warn[0], /7/, '但总数要说得出（7 行）');
    assert.match(manyLog.seen.warn[0], /2 个未列出/, '未列出的个数也要说清');
  });

// ---------------------------------------------------------------------------
// 3. 写侧：严格 + 一个事务 + 审计同生共死（口径 3 + 4 + 6）
// ---------------------------------------------------------------------------

test('RS-5 写侧严格：未知 key / 非 JSON 标量 / validate 不过 ⇒ 抛，且这三种都零 SQL（更不许发 INSERT）', async () => {
  const cases = [
    ['未知 key', { key: 'nope.unknown', value: 1 }, 'unknown_setting'],
    ['对象值', { key: 'demo.limit', value: { a: 1 } }, 'scalar_required'],
    ['数组值', { key: 'demo.limit', value: [1, 2] }, 'scalar_required'],
    ['null 值', { key: 'demo.limit', value: null }, 'scalar_required'],
    ['undefined 值', { key: 'demo.limit', value: undefined }, 'scalar_required'],
    ['非有限数', { key: 'demo.limit', value: Number.NaN }, 'scalar_required'],
    ['validate 不过（0）', { key: 'demo.limit', value: 0 }, 'validation_failed'],
    ['validate 不过（-3）', { key: 'demo.limit', value: -3 }, 'validation_failed'],
    ['validate 不过（字符串数字）', { key: 'demo.limit', value: '20' }, 'validation_failed'],
  ];
  for (const [name, arg, code] of cases) {
    const pool = new FakeRuntimePool();
    const err = await saveRuntimeSetting({
      pool, actorId: ACTOR, registry: TEST_REGISTRY, log: silentLog, ...arg,
    }).then(() => null, (e) => e);
    assert.ok(err, `${name}：必须抛（HTTP 层据此回 400）`);
    assert.ok(err instanceof RuntimeSettingsError, `${name}：必须是 RuntimeSettingsError`);
    assert.equal(err.code, code, `${name}：错误码必须是 ${code}，实得 ${err.code}`);
    assert.equal(err.httpStatus, 400, `${name}：必须映射成 400`);
    assert.equal(pool.queryCount, 0, `${name}：一条 SQL 都不许发（校验在发 SQL 之前）`);
    assert.equal(pool.connectCount, 0, `${name}：也不许从池里借连接（事务都不能开）`);
    assert.deepEqual(pool.sqlLog, [], `${name}：sqlLog 必须空`);
    assert.deepEqual(pool.insertStatements(), [], `${name}：零写库（未登记的 key 落库就是永不生效的幽灵行）`);
  }
});

test('RS-6 写 = 一个事务：BEGIN → FOR UPDATE 取旧值 → upsert → 审计 → COMMIT，DTO 来自 RETURNING',
  async () => {
    const pool = new FakeRuntimePool({
      // 故意让 RETURNING 与输入不同 ⇒ DTO 取输入的话必红（口径 4：不信输入）。
      returning: {
        key: 'demo.limit', value: 4242,
        updated_at: new Date('2026-11-19T00:00:00.000Z'),
        updated_by: ACTOR,
      },
    });
    const dto = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: silentLog,
    });

    // ① 事务形状（硬口径 6）。旧版那格叫「写 = 一条 SQL」，口径已作废（#677 返修 MED②）。
    assert.deepEqual(pool.roles(), ['BEGIN', 'SELECT_FOR_UPDATE', 'UPSERT', 'AUDIT', 'COMMIT'],
      `保存必须是那五步（实得 ${JSON.stringify(pool.roles())}）—— 少一步就是「两个 await」或「自动提交」的洞`);
    assert.equal(pool.connectCount, 1, '必须从池里借**一条**连接（pool.query 每次另借一条 ⇒ 锁会提前放）');
    assert.equal(pool.releaseCount, 1, '连接必须归还（finally 里 release）');
    assert.ok(!pool.roles().includes('ROLLBACK'), '成功路径不许回滚');

    const byRole = (role) => pool.sqlLog[pool.roles().indexOf(role)];
    const prev = byRole('SELECT_FOR_UPDATE');
    const upsert = byRole('UPSERT');
    const audit = byRole('AUDIT');
    // ② 取旧值那条必须是**单独一条**带锁语句：旧版的 500 就是因为 `FOR UPDATE` 待在
    //    含 data-modifying CTE 的语句里（真库上锁定读看不见本语句要改的那行）。
    assert.match(prev.sql, /^\s*SELECT\b[\s\S]*\bFOR\s+UPDATE\s*$/i, '旧值必须是单独一条锁定读');
    assert.doesNotMatch(prev.sql, /\bINSERT\b/i, '取旧值那条自己不许写库（写写在 UPSERT 里）');
    assert.deepEqual(prev.params, ['demo.limit'], 'key 走参数，不拼 SQL 文本');
    assert.ok(pool.roles().indexOf('SELECT_FOR_UPDATE') < pool.roles().indexOf('UPSERT'),
      '锁必须在写之前拿（否则并发第二条不必等 ⇒ 旧值又是「自己进来之前」那个）');
    // ③ upsert：单行 ON CONFLICT，且**不许带 `FOR UPDATE`**（那是要 500 的那个形状）。
    for (const fragment of [
      /INSERT\s+INTO\s+runtime_settings\b/i, /ON\s+CONFLICT\s*\(key\)\s+DO\s+UPDATE/i,
      /RETURNING\b/i,
    ]) {
      assert.match(upsert.sql, fragment, `upsert 必须含 ${fragment}`);
    }
    assert.doesNotMatch(upsert.sql, /\bFOR\s+UPDATE\b/i,
      'upsert 里不许出现 FOR UPDATE（真库上那会让旧值变成空集 ⇒ previous_value 恒 null）');
    assert.equal(upsert.params[0], 'demo.limit', 'key 是第一个参数');
    assert.equal(upsert.params[1], '20', '值以 JSON 文本 + `$2::jsonb` 送进去（SQL 侧不猜类型）');
    assert.equal(upsert.params[2], ACTOR, 'actor 进 updated_by');
    // ④ 审计：与写同一个事务（在 BEGIN…COMMIT 之间），action/target 不许漂。
    assert.ok(pool.roles().indexOf('AUDIT') < pool.roles().indexOf('COMMIT'),
      '审计必须在 COMMIT 之前（事务外写审计 = 「设置已生效而审计一行没有」那个窗口）');
    assert.equal(audit.params[0], ACTOR, '审计的 actor_id');
    assert.equal(audit.params[1], AUDIT_ACTION, '审计动作名必须是 admin.runtime_settings_updated');
    assert.equal(audit.params[2], `${AUDIT_TARGET_PREFIX}:demo.limit`, '审计 target 点名到 key');
    assert.deepEqual(JSON.parse(audit.params[3]),
      { key: 'demo.limit', value: 4242, previous_value: null },
      'details 三个键逐字不变，且 value 取 RETURNING 里那个（不信输入）');
    assert.equal(pool.auditCommitted.length, 1, '提交后库里恰好一行审计');

    // ⑤ DTO 来自 RETURNING，不是回显输入。
    assert.equal(dto.value, 4242, 'DTO 的 value 来自 RETURNING（不是回显输入的 20）');
    assert.equal(dto.key, 'demo.limit');
    assert.equal(dto.updatedAt, '2026-11-19T00:00:00.000Z', 'Date 出参要成 ISO 字符串');
    assert.equal(dto.updatedBy, ACTOR);
    assert.equal(dto.previousValue, null, '无旧行 ⇒ previousValue 是 null（不是报错）');
    assert.equal(dto.auditRows, 1);
    assert.equal(pool.storedValue('demo.limit'), 4242, 'COMMIT 之后设置才真的落账');
  });

test('RS-6b 审计被抑制 ⇒ 抛 500 且**设置没落库**（检查在 COMMIT 之前，不许「报错但已生效」）',
  async () => {
    // 假库里的「审计被抑制」= 审计那句 rowCount 0（真库那一版是 BEFORE INSERT trigger
    // `RETURN NULL`，见 RS-11）。关键是：抛错之外，**设置必须一格没改**。
    const pool = new FakeRuntimePool({ auditRowCount: 0 });
    const err = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: silentLog,
    }).then(() => null, (e) => e);
    assert.ok(err, '审计 0 行必须抛（否则就是静默的「设置生效而审计无痕」）');
    assert.ok(err instanceof RuntimeSettingsError, '必须是 RuntimeSettingsError');
    assert.equal(err.code, 'internal', '它是内部不一致，不是用户输入错');
    assert.equal(err.httpStatus, 500);
    assert.equal(pool.storedValue('demo.limit'), undefined,
      '设置必须一格没改（检查在 COMMIT **之前**；把检查挪到 COMMIT 之后就是 M-2 那一刀）');
    assert.deepEqual(pool.auditCommitted, [], '审计也没落账');
    assert.ok(!pool.roles().includes('COMMIT'),
      `这条路径上**不许**出现 COMMIT（实得 ${JSON.stringify(pool.roles())}）`);
    assert.deepEqual(pool.roles(),
      ['BEGIN', 'SELECT_FOR_UPDATE', 'UPSERT', 'AUDIT', 'ROLLBACK'], '失败路径必须显式 ROLLBACK');
    assert.equal(pool.releaseCount, 1, '报错也要把连接还回池子');

    // RETURNING 空集（SQL 形状漂了）同样：抛 500 + 回滚 + 不落库。
    const noRow = new FakeRuntimePool({ upsertReturnsRow: false });
    const err2 = await saveRuntimeSetting({
      pool: noRow, actorId: ACTOR, key: 'demo.limit', value: 20,
      registry: TEST_REGISTRY, log: silentLog,
    }).then(() => null, (e) => e);
    assert.ok(err2, 'RETURNING 空集也必须抛');
    assert.equal(err2.httpStatus, 500);
    assert.equal(noRow.storedValue('demo.limit'), undefined, '同样不许落库');
    assert.ok(!noRow.roles().includes('COMMIT'), '同样不许提交');

    // 事务里某一步直接报错（驱动抛错）也要 ROLLBACK + 归还连接。
    const boom = new FakeRuntimePool();
    boom.query = ((orig) => (sql, params) => (/INSERT\s+INTO\s+audit_log\b/i.test(String(sql))
      ? Promise.reject(new Error('boom')) : orig.call(boom, sql, params)))(boom.query);
    const err3 = await saveRuntimeSetting({
      pool: boom, actorId: ACTOR, key: 'demo.limit', value: 20,
      registry: TEST_REGISTRY, log: silentLog,
    }).then(() => null, (e) => e);
    assert.equal(err3?.message, 'boom', '原错误必须原样往上招（不许被 ROLLBACK 盖掉）');
    assert.equal(boom.releaseCount, 1, 'finally 里必须 release');
    assert.equal(boom.storedValue('demo.limit'), undefined, '抛错那一档设置也没落库');
  });

// ---------------------------------------------------------------------------
// 4. P1 的边界：一格未迁、迁移形状、serve() 接线、超时旋钮
// ---------------------------------------------------------------------------

test('RS-7 P3 边界：registry 有 session.ttl_seconds + workspace.retention_days'
  + ' + preview.ticket_ttl_seconds + session.auto_title_min_new + preview.session_ttl_seconds'
  + ' + 三个退避旋钮 + 四个认证旋钮（#677 Tier 2A）', async () => {
  // P1 时这一格钉的是「registry 是空对象」；P2a 迁了第一格 ⇒ 判据改成「只迁了这一格」；
  // P3 各批逐格迁到八格；#677 Tier 2A 一次迁四个「无状态、每请求读」的认证旋钮
  // ⇒ 判据改成「就这十二格，不多不少」。
  // 它红了的读法不变：有人顺手多迁了一格（或把热读口径弄丢了）。
  assert.deepEqual(Object.keys(RUNTIME_SETTING_REGISTRY),
    ['session.ttl_seconds', 'workspace.retention_days', 'preview.ticket_ttl_seconds',
      'session.auto_title_min_new', 'preview.session_ttl_seconds',
      'loop.onboarding_idle_backoff_ms', 'loop.offboarding_idle_backoff_ms',
      'loop.provisioner_idle_backoff_ms',
      'auth.pending_token_ttl_seconds', 'auth.session_renew_interval_seconds',
      'auth.max_password_length', 'auth.max_login_length'],
    '只许迁这十二格（其余旋钮逐批填）');
  assert.ok(Object.isFrozen(RUNTIME_SETTING_REGISTRY), 'registry 必须冻结（运行期没人能塞旋钮进来）');
  const entry = RUNTIME_SETTING_REGISTRY['session.ttl_seconds'];
  assert.ok(Object.isFrozen(entry), '条目也必须冻结');
  // 端点 DTO 与热读靠这几个字段说话：`applyMode` 决定界面提不提醒重启，`configPath`/`envVar` 决定
  // 回落去哪、日志点名谁。少一个就是管理页上多一处「说不清楚」。
  assert.equal(entry.key, 'session.ttl_seconds');
  assert.equal(entry.configPath, 'sessionTtlSeconds', 'config 字段名（覆盖层只改这一格）');
  assert.equal(entry.envVar, 'SESSION_TTL_SECONDS', '只用于日志/文档点名，不在这里读 env');
  assert.equal(entry.applyMode, 'hot', '本旋钮的全部意义就是不用重启');
  assert.equal(typeof entry.label, 'string');
  assert.ok(entry.label.length > 0, 'label 是管理台显示的人话名字');
  // 默认值**同源**：三处（本模块 / config.js 的字面默认 / compose 的 `${...:-604800}`）必须同数。
  // 漂了的后果不是报错而是管理台显示一个机器实际不会用的数（口径照 `upload-settings.test.js` US-13）。
  assert.equal(entry.defaultValue, SESSION_TTL_DEFAULT_SECONDS);
  assert.equal(SESSION_TTL_DEFAULT_SECONDS, loadConfig({ MAX_LOGIN_LENGTH: '128' }).sessionTtlSeconds,
    'registry 默认值必须等于 loadConfig 在干净 env 下算出的那个数');
  const compose = fs.readFileSync(new URL('../../deploy/docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /SESSION_TTL_SECONDS:\s*\$\{SESSION_TTL_SECONDS:-604800\}/,
    'compose 的默认值与本模块同源（P5 退役 env 之前两边不许漂）');

  // 写路径的失效钩子必须接上（M-1 的形状闸那一半：光在 registry 里写 `applyMode: 'hot'` 不算）。
  assert.equal(HOT_READ_INVALIDATORS.get('session.ttl_seconds'), invalidateSessionTtlCache,
    'applyMode=hot 的旋钮必须在 HOT_READ_INVALIDATORS 里登记，否则保存完本进程还要吃 5s 旧值');

  // ---- P3 第一批的第二格：同一套口径，逐字段再钉一次（少一个字段在管理页上就是「说不清楚」）----
  const retEntry = RUNTIME_SETTING_REGISTRY[WORKSPACE_RETENTION_KEY];
  assert.ok(retEntry, '第二格必须在 registry 里');
  assert.ok(Object.isFrozen(retEntry), '条目也必须冻结');
  assert.equal(retEntry.key, WORKSPACE_RETENTION_KEY);
  assert.equal(retEntry.configPath, 'workspaceRetentionDays', 'config 字段名（与 config.js:343 同名）');
  assert.equal(retEntry.envVar, 'ERIX_WORKSPACE_RETENTION_DAYS', '只用于日志/文档点名，不在这里读 env');
  assert.equal(retEntry.applyMode, 'hot', '本批的全部意义就是改这个数不用重建容器');
  assert.ok(typeof retEntry.label === 'string' && retEntry.label.length > 0);
  assert.match(retEntry.label, /0/, 'label 要把「0 = 不自动清理」写进去：这一格的 0 是个有效值，'
    + '界面上不解释就会被人当成「没填」');
  // 默认值**同源**：本模块 / `config.js` 的字面默认 / compose 的 `${...:-0}` 三处同数（漂了的后果
  // 不是报错，而是管理台显示一个机器实际不会用的数 —— 口径照 RS-7 上半与 US-13）。
  assert.equal(retEntry.defaultValue, WORKSPACE_RETENTION_DEFAULT_DAYS);
  assert.equal(WORKSPACE_RETENTION_DEFAULT_DAYS, 0, '默认必须是 0 = 关（与 docs/env.md、compose 同一句话）');
  assert.equal(loadConfig({ MAX_LOGIN_LENGTH: '128' }).workspaceRetentionDays,
    WORKSPACE_RETENTION_DEFAULT_DAYS,
    'registry 默认值必须等于 loadConfig 在干净 env 下算出的那个数');
  assert.match(compose, /ERIX_WORKSPACE_RETENTION_DAYS:\s*\$\{ERIX_WORKSPACE_RETENTION_DAYS:-0\}/,
    'compose 的默认值与本模块同源（P5 退役 env 之前两边不许漂）');
  // 上界要能说清为什么是这个数（它是产品口径，不是算术溢出；理由在源码注释里）。
  assert.equal(WORKSPACE_RETENTION_MAX_DAYS, 3650);
  assert.equal(parseWorkspaceRetentionDays(WORKSPACE_RETENTION_MAX_DAYS).ok, true, '上界内（含端点）');
  assert.equal(parseWorkspaceRetentionDays(WORKSPACE_RETENTION_MAX_DAYS + 1).ok, false, '越界 ⇒ 回落');
  // 热读旋钮的失效钩子：**漏这一行是 P3 那族最典型的坑**（保存能落库、DTO 也回填，
  // 但本进程的热读还是旧值）。登记必须是导出的那一个函数本身（不是间接层）。
  assert.equal(HOT_READ_INVALIDATORS.get(WORKSPACE_RETENTION_KEY),
    invalidateWorkspaceRetentionCache,
    '第二格也必须登记失效钩子，否则管理台保存完 offboarding 还是拿旧值');
  assert.notEqual(HOT_READ_INVALIDATORS.get(WORKSPACE_RETENTION_KEY),
    HOT_READ_INVALIDATORS.get(SESSION_TTL_KEY),
    '两格各有各的缓存 ⇒ 各有各的失效函数（共用一个就是「保存 TTL 把保留天数也抹了」）');
  // 第四格（P3 第三批）：同一套口径，失效钩子也必须是导出的那一个函数本身（漏登记 = 保存后本进程
  // 还要吃旧值）；与其余格各有各的缓存、各有各的失效函数。
  assert.equal(HOT_READ_INVALIDATORS.get(AUTO_TITLE_MIN_NEW_KEY), invalidateAutoTitleMinNewCache,
    '第四格也必须登记失效钩子，否则管理台保存完下一轮评估标题还是拿旧值');
  assert.notEqual(HOT_READ_INVALIDATORS.get(AUTO_TITLE_MIN_NEW_KEY),
    HOT_READ_INVALIDATORS.get(PREVIEW_TICKET_TTL_KEY),
    '第四格不许共用第三格的失效函数（保存标题阈值不该抹掉预览票缓存）');
  // 第五格（P3 第五批）：同一套口径，失效钩子也必须是导出的那一个函数本身（漏登记 = 保存后本进程
  // 还要吃旧值）；与其余格各有各的缓存、各有各的失效函数。
  const pstEntry = RUNTIME_SETTING_REGISTRY[PREVIEW_SESSION_TTL_KEY];
  assert.ok(pstEntry, '第五格必须在 registry 里');
  assert.ok(Object.isFrozen(pstEntry), '条目也必须冻结');
  assert.equal(pstEntry.key, PREVIEW_SESSION_TTL_KEY);
  assert.equal(pstEntry.configPath, 'previewSessionTtlSeconds', 'config 字段名（与 config.js:411 同名）');
  assert.equal(pstEntry.envVar, 'PREVIEW_SESSION_TTL_SECONDS', '只用于日志/文档点名，不在这里读 env');
  assert.equal(pstEntry.applyMode, 'hot', '签发/续期预览会话时现读，本批的全部意义就是改这个数不用重建');
  assert.ok(typeof pstEntry.label === 'string' && pstEntry.label.length > 0);
  // 默认值**同源**：本模块 / `config.js` 的字面默认（15*60=900）/ compose 的 `${...:-900}` 三处同数。
  assert.equal(pstEntry.defaultValue, PREVIEW_SESSION_TTL_DEFAULT_SECONDS);
  assert.equal(PREVIEW_SESSION_TTL_DEFAULT_SECONDS, 900, '默认必须 900 = 15 分钟（三处同源）');
  assert.equal(loadConfig({ MAX_LOGIN_LENGTH: '128' }).previewSessionTtlSeconds,
    PREVIEW_SESSION_TTL_DEFAULT_SECONDS,
    'registry 默认值必须等于 loadConfig 在干净 env 下算出的那个数');
  assert.match(compose, /PREVIEW_SESSION_TTL_SECONDS:\s*\$\{PREVIEW_SESSION_TTL_SECONDS:-900\}/,
    'compose 的默认值与本模块同源（P5 退役 env 之前两边不许漂）');
  assert.equal(PREVIEW_SESSION_TTL_MIN_SECONDS, 60);
  assert.equal(PREVIEW_SESSION_TTL_MAX_SECONDS, 86400);
  assert.equal(parsePreviewSessionTtlSeconds(PREVIEW_SESSION_TTL_MAX_SECONDS).ok, true, '上界内（含端点）');
  assert.equal(
    parsePreviewSessionTtlSeconds(PREVIEW_SESSION_TTL_MAX_SECONDS + 1).ok, false, '越界 ⇒ 回落');
  assert.equal(HOT_READ_INVALIDATORS.get(PREVIEW_SESSION_TTL_KEY), invalidatePreviewSessionTtlCache,
    '第五格也必须登记失效钩子，否则管理台保存完下一个预览请求还是拿旧值');
  assert.notEqual(HOT_READ_INVALIDATORS.get(PREVIEW_SESSION_TTL_KEY),
    HOT_READ_INVALIDATORS.get(PREVIEW_TICKET_TTL_KEY),
    '第五格不许共用第三格的失效函数（会话 TTL 与票 TTL 各有各的缓存）');
  assert.equal(HOT_READ_INVALIDATORS.size, 12, '登记表里就是十二格（热读旋钮数 = 失效钩子数）');

  // P3 第六批的三格：同一个口径再钉一次（各自一个导出的失效函数，且互相不许共用）。
  assert.equal(HOT_READ_INVALIDATORS.get(ONBOARDING_IDLE_BACKOFF_MS_KEY),
    invalidateOnboardingIdleBackoffCache);
  assert.equal(HOT_READ_INVALIDATORS.get(OFFBOARDING_IDLE_BACKOFF_MS_KEY),
    invalidateOffboardingIdleBackoffCache);
  assert.equal(HOT_READ_INVALIDATORS.get(PROVISIONER_IDLE_BACKOFF_MS_KEY),
    invalidateProvisionerIdleBackoffCache);
  assert.equal(new Set([...HOT_READ_INVALIDATORS.values()]).size, HOT_READ_INVALIDATORS.size,
    '一格一个失效函数：共用就是「保存开户那格把对账那格的缓存也抹了」（RS-51 钉另一面）');
  assert.equal(HOT_READ_INVALIDATORS.size, 12, '登记表里就是十二格（热读旋钮数 = 失效钩子数）');

  assert.equal(isKnownSetting('demo.limit'), false, '真实 registry 里没有 demo.limit');
  assert.equal(isKnownSetting('constructor'), false,
    '`in` 会把 Object 原型上的名字算成已登记 ⇒ 必须走 hasOwn');

  // 启动路径的形状变了，要说清：P1 是「零 SQL」，P2a 起是**整表一次**（不是 per-key 一次）。
  const config = { port: 8080, sessionTtlSeconds: 1234, sessionTtlSecondsSource: 'env' };
  const pool = new FakeRuntimePool();      // 库里一格都没有 ⇒ 全部回落 env 那一档
  const out = await applyRuntimeOverrides(config, { pool, log: silentLog });
  assert.equal(pool.queryCount, 1, 'P2a 起每次 serve() 发**一次**整表读（一格旋钮 = 一次 SQL，不是两次）');
  assert.match(pool.sqlLog[0].sql, /FROM runtime_settings ORDER BY key/, '那一次是整表读');
  assert.equal(out.sessionTtlSeconds, 1234, '库里没行 ⇒ 保留 env 那一档的值');
  assert.notEqual(out, config, '仍是新对象（不改入参）');

  // 旋钮一格都没登记时仍然**零 SQL**：P1 那条口径没被删，只是要显式注入空 registry 才验得到。
  const pool2 = new FakeRuntimePool();
  const out2 = await applyRuntimeOverrides({ port: 8080 }, { pool: pool2, registry: {}, log: silentLog });
  assert.equal(pool2.queryCount, 0, '空 registry ⇒ 一次 DB 都不发（接线不给启动加往返）');
  assert.deepEqual(out2, { port: 8080 });
});

test('RS-8 迁移 0046 的形状：key-value + jsonb + key 形状 CHECK + 零值域 CHECK + 无 BEGIN + baseline 冻结', () => {
  const url = new URL('../../deploy/migrations/0046-runtime-settings.sql', import.meta.url);
  const sql = fs.readFileSync(url, 'utf8');
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');

  assert.match(executable, /CREATE TABLE IF NOT EXISTS runtime_settings\b/,
    'IF NOT EXISTS（重放是零 DDL 空操作，README 单文件约定）');
  assert.match(executable, /key\s+text PRIMARY KEY/, 'key 是 text 主键（key-value 表形）');
  assert.match(executable, /value\s+jsonb NOT NULL/, 'value 是 jsonb（P3 加旋钮 = 一条 INSERT，零 DDL）');
  assert.match(executable, /updated_at\s+timestamptz NOT NULL DEFAULT now\(\)/, 'updated_at');
  assert.match(executable, /updated_by\s+uuid/, 'updated_by 存在（谁改的要留名）');
  assert.doesNotMatch(executable, /\bREFERENCES\b/, 'updated_by 不建 FK（照 0026/0036/0043）');
  // key 形状写成 DB 事实：拼错的 key 会静默多出一行永不生效的配置（读侧只按 registry 取）。
  assert.match(executable, /CHECK \(key ~ '\^\[a-z\]\[a-z0-9_\.\]\{2,63\}\$'\)/,
    'key 形状 CHECK 必须逐字是 `^[a-z][a-z0-9_.]{2,63}$`');
  // 值域是**策略**：写进 DB CHECK 的话，「DB 值非法 ⇒ 读侧回落」这条判据在真机上进不去（同 0036）。
  assert.doesNotMatch(executable, /CHECK \(value/, '值域不许写成 DB CHECK（分层：值域归写侧 validate）');
  // 事务边界归 runner；DO 块里那个 BEGIN 是 PL/pgSQL 的块开始，先整块剥掉。
  const noDo = executable.replace(/DO\s+\$do\$[\s\S]*?\$do\$;/gi, '');
  assert.doesNotMatch(noDo, /\b(BEGIN|COMMIT|ROLLBACK)\b/i, '迁移不许自己开事务');
  assert.match(executable, /SET lock_timeout/, 'SET lock_timeout（照 0016 的纪律）');
  assert.doesNotMatch(executable, /\bVACUUM\b/, 'VACUUM 不进迁移（不在事务块里跑）');
  assert.doesNotMatch(noDo, /\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i, '本支只建新表，不许回头改别的对象');
  // baseline 冻结：新表只走增量迁移。
  const baseline = fs.readFileSync(new URL('../../docs/data/schema.sql', url), 'utf8');
  assert.ok(!baseline.includes('runtime_settings'),
    'docs/data/schema.sql 是冻结 baseline（它的 sha256 在迁移台账里，改一字节现存库全部拒启）');
});

test('RS-9 serve() 接线：覆盖层在 migrate 之后、createServer 之前，且**每个循环**都用 effectiveConfig', () => {
  const src = fs.readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
  const serve = src.slice(src.indexOf('async function serve()'), src.indexOf('async function runMigrate'));
  assert.ok(serve.length > 200, '切出 serve() 失败了（serve 或 runMigrate 的名字变了）');

  const at = (re) => {
    const i = serve.search(re);
    assert.notEqual(i, -1, `serve() 里必须出现 ${re}`);
    return i;
  };
  const iMigrate = at(/await migrate\(migratePool/);
  const iOverlay = at(/await applyRuntimeOverrides\(config,\s*\{[^}]*pool/);
  const iCreate = at(/createServer\(\{\s*pool,\s*config:\s*effectiveConfig\s*\}\)/);
  assert.ok(iMigrate < iOverlay, '覆盖层必须在 migrate() **之后**（表得先存在，否则每次启动都回落一次）');
  assert.ok(iOverlay < iCreate, '覆盖层必须在 createServer **之前**');

  // 工单点名的坑：只改 createServer = 覆盖层只对 HTTP 生效，循环还用旧值。逐个点名。
  for (const re of [
    /startMaterializerLoop\(pool,\s*effectiveConfig\)/,
    /startOnboardingLoop\(pool,\s*effectiveConfig\)/,
    /startOffboardingLoop\(pool,\s*effectiveConfig\)/,
    /startRoutesLoop\(pool,\s*effectiveConfig\)/,
    /startRouteDriftMonitor\(pool,\s*effectiveConfig\)/,
    /createIntentDispatcher\(\{\s*pool,\s*config:\s*effectiveConfig\s*\}\)/,
    /startMacroEvalLoop\(pool,\s*effectiveConfig/,
    /startPendingSweepLoop\(pool,\s*effectiveConfig\)/,
    /startProvisionerLoop\(pool,\s*effectiveConfig\)/,
    /startMetricsSampler\(\{\s*pool,\s*config:\s*effectiveConfig,\s*log:\s*console\s*\}\)/,
    /systemMetricsRetentionDays:\s*effectiveConfig\.systemMetrics\?\.retentionDays/,
    /effectiveConfig\.onMacroIntents\s*=/,
    /effectiveConfig\.metricsSampler\s*=/,
  ]) {
    assert.match(serve, re, `接线漏了这一处：${re}`);
  }
  // serve() 里除了 `loadConfig()` 那一份与覆盖层本身，不许再有把旧 `config` 交给消费者的写法。
  const leftovers = [...serve.matchAll(/(?:start[A-Za-z]+Loop|startMetricsSampler|createServer|createIntentDispatcher)\([^)]*\bconfig\b[^)]*\)/g)]
    .map((m) => m[0]).filter((s) => !/effectiveConfig/.test(s));
  assert.deepEqual(leftovers, [], `serve() 里还有人把旧 config 递给消费者：${leftovers.join(' | ')}`);

  // 其它子命令**不**接覆盖层（它们不服务请求；接了就是给 migrate 加一次无谓的 DB 往返）。
  const outsideServe = src.replace(serve, '');
  assert.ok(!/applyRuntimeOverrides\(/.test(outsideServe),
    '只有 serve() 接覆盖层：migrate / bootstrap-admin / deprovision-fde 等不接');
});

test('RS-10 读侧超时旋钮：RUNTIME_SETTINGS_READ_TIMEOUT_MS 只收正整数，且真的交给 setTimeout', async () => {
  assert.equal(DEFAULT_READ_TIMEOUT_MS, 1500);
  assert.equal(READ_TIMEOUT_ENV_VAR, 'RUNTIME_SETTINGS_READ_TIMEOUT_MS');
  assert.equal(readTimeoutMs({ env: {}, log: silentLog }), DEFAULT_READ_TIMEOUT_MS);
  assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: '800' }, log: silentLog }), 800);
  for (const bad of ['1e3', ' 800 ', '+5', '0', '-5', 'abc', '800.5']) {
    const log = collectingLog();
    assert.equal(readTimeoutMs({ env: { [READ_TIMEOUT_ENV_VAR]: bad }, log }), DEFAULT_READ_TIMEOUT_MS,
      `${bad} 必须判为非法 ⇒ 用默认（不许 Number(raw) 了事：Number('1e3') === 1000 是 那族）`);
    assert.equal(log.seen.warn.length, 1, `${bad} 被判非法时必须 warn 一次`);
    assert.match(log.seen.warn[0], new RegExp(READ_TIMEOUT_ENV_VAR), 'warn 要点名这个旋钮');
  }

  // 第三腿：旋钮是**活的**——喂一个不同于缺省的值 ⇒ 实际交给定时器的等待跟着变。
  const pool = new FakeRuntimePool({ hangOnSelect: true });
  const started = Date.now();
  const { problems } = await readRuntimeSettings({
    pool, registry: TEST_REGISTRY, env: { [READ_TIMEOUT_ENV_VAR]: '40' }, log: silentLog,
  });
  const elapsed = Date.now() - started;
  assert.equal(problems[0].reason, 'read_timeout', 'env 旋钮驱动的等待也必须报 read_timeout');
  assert.ok(elapsed >= 35 && elapsed < 1400,
    `env 给 40ms 就必须在 40ms 附近给答案（实测 ${elapsed}ms；若接近 1500ms = 旋钮没接上）`);
});

// ---------------------------------------------------------------------------
// 5. 真库那一腿（RS-11）：只有真的 postgres 才能给的答案
//
// 为什么必须有这一格（2026-11-19 实测，不是假想敌）：旧实现的 `prev` 原先照 0036 带了
// `FOR UPDATE`。**fake pool 里全绿**（它按 SQL 文本分支，不会模拟 PG 的可见性规则），而真库上
// 「一条含 data-modifying CTE 的语句里，锁定读看不见本语句自己改的那一行」⇒ `prev` 恒空集
// ⇒ `previous_value` 恒 `null`。⇒ 「旧值必须拿得到锁」这条口径在真机上其实**没成立**，而单测看不见。
//
// 本轮返修（MED②）把写侧从「一条语句」改成「一个显式事务」后，真库那一腿多丁两件 fake
// 给不出的事（两件都是本单的灵魂，fake 只能下形状闸）：
//   * ⑦ **审计被静默抑制 ⇒ 抛 500 且 `runtime_settings` 的值一格没改**（BEFORE INSERT trigger
//     `RETURN NULL`）。这是 MED② 从「理论」变成「机器判据」的那一步：在旧实现（检查在语句
//     返回之后 = 已提交之后）上跑这一格必红 —— 审计审计抑制而设置照旧生效。
//   * ⑧ **`FOR UPDATE` 单独一条语句真的拿得到行锁**（拦路连接占住那一行 ⇒ 保存必须卡住）。
//     fake 不模拟 MVCC ⇒ 它只能断言「SQL 里有 FOR UPDATE」，锁不锁得住只有真库能判。
// 无 PG 时整体 skip，不参与假通过。
// ---------------------------------------------------------------------------

test('RS-11 真库：写=一个事务真的落库 + previous_value 是真旧值 + 审计被抑制则设置不回滚不了'
  + ' + 行锁真的拦人 + key CHECK 真挡人',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    // 夹具自己建库、跑完整条迁移链（含 0046）、并把迁移好的 pool 交进来；收尾它负责。
    // poolMax=3 是为了⑧：拦路连接 + 被检的保存之外还要留一条**空余连接**，否则「保存卡住」
    // 可能只是卡在**池子排队**上而不是卡在行锁上（那就是假绿）。
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const table = await pool.query(`SELECT to_regclass('public.runtime_settings') AS reg`);
      assert.notEqual(table.rows[0].reg, null, '迁移链跑完 runtime_settings 必须存在');
      const cols = await pool.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = 'runtime_settings' ORDER BY ordinal_position`);
      assert.deepEqual(
        cols.rows.map((r) => `${r.column_name}:${r.data_type}`),
        ['key:text', 'value:jsonb', 'updated_at:timestamp with time zone', 'updated_by:uuid'],
        '表形必须是 key-value + jsonb（P3 加旋钮 = 一条 INSERT，零 DDL）',
      );

      // ① 首写（表里没有那一行）：审计必须**照写**（事务里 `PREVIOUS_SQL` 大然空集 ⇒
      //    `previous_value` 记 null，而不是「没旧行就没审计」）。审计行数 1 现在来自
      //    `INSERT … rowCount`（不再来自 CTE 里那个 count）。
      const first = await saveRuntimeSetting({
        pool, actorId: null, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: pgSilent,
      });
      assert.equal(first.value, 20, 'RETURNING 回的就是刚写入的值');
      assert.equal(first.previousValue, null, '首写没有旧值 ⇒ null（不是报错）');
      assert.equal(first.auditRows, 1, 'rowCount 就是 1（检查在 COMMIT 之前拿到的那个数）');
      assert.equal(await auditCount(pool), 1, '首写也必须留下一行审计');

      // ② 再写：`previous_value` 必须是**真旧值**。这一条就是 fake pool 测不出来的那个洞
      //    （旧版靠 `prev` CTE 拿，带锁就恒 null；现在靠事务里单独一条锁定读）。
      const second = await saveRuntimeSetting({
        pool, actorId: null, key: 'demo.limit', value: 31, registry: TEST_REGISTRY, log: pgSilent,
      });
      assert.equal(second.value, 31, 'upsert 走的是 DO UPDATE（库里只有一行）');
      assert.equal(second.previousValue, 20,
        'previous_value 必须是紧邻的前一个值 20（拿到 null = 锁定读又变成空集）');
      assert.equal(await auditCount(pool), 2, '两次保存 = 两行审计（一条不多一条不少）');
      const auditChain = await pool.query(
        `SELECT details ->> 'previous_value' AS prev, details -> 'value' AS val
           FROM audit_log WHERE action = $1 ORDER BY id`, [AUDIT_ACTION]);
      // jsonb 的 `null` 经 `->>` 出来就是 SQL NULL（node-pg 给 JS null）—— 不是“没这个键”。
      assert.deepEqual(auditChain.rows.map((r) => r.prev), [null, '20'],
        '审计里的 previous_value 必须与接口返回的同一个数（首写 null，次写 20）');
      assert.deepEqual(auditChain.rows.map((r) => r.val), [20, 31],
        'details.value 取的是 RETURNING 里那个（jsonb 直接给 JS 数）');
      const only = await pool.query('SELECT count(*)::int AS n FROM runtime_settings');
      assert.equal(only.rows[0].n, 1, '同一 key 两次保存只许有一行（ON CONFLICT (key) 生效）');

      // ③ 读侧 + 覆盖层：真库上的 jsonb 值（这里 node-pg 直接给 JS number）。
      const read = await readRuntimeSettings({ pool, registry: TEST_REGISTRY, log: pgSilent });
      assert.deepEqual(read.values, { 'demo.limit': 31 }, '读侧拿到的是真库里的 jsonb 值');
      assert.deepEqual(read.problems, [{ key: 'demo.interval_ms', reason: 'no_row' }],
        '有行且合法的那格不许报问题；**没行**的那格必须报 no_row（未配置是常态 ⇒ 只登记不 warn）');
      const cfg = await applyRuntimeOverrides({ demoLimit: 10 },
        { pool, registry: TEST_REGISTRY, log: pgSilent });
      assert.equal(cfg.demoLimit, 31, '覆盖层在真库上也是 DB > env');

      // ③b 孤儿行在真库上也必须说话（MED① 的读侧判据）：手工塞一行 registry 不认的 key。
      await pool.query(
        `INSERT INTO runtime_settings (key, value) VALUES ('ghost.old_limit', '9'::jsonb)`);
      const orphanLog = collectingLog();
      const orphan = await readRuntimeSettings({ pool, registry: TEST_REGISTRY, log: orphanLog });
      assert.deepEqual(
        orphan.problems.filter((p) => p.reason === 'unknown_key').map((p) => p.key),
        ['ghost.old_limit'], '真库上的孤儿行也必须进 problems 并点名 key');
      assert.equal(orphanLog.seen.warn.length, 1, '只聚合 warn 一次');
      assert.match(orphanLog.seen.warn[0], /ghost\.old_limit/, 'warn 点名 key');
      assert.equal(orphan.values['ghost.old_limit'], undefined, '孤儿行进不了 values（不生效）');
      await pool.query(`DELETE FROM runtime_settings WHERE key = 'ghost.old_limit'`);

      // ④ 手工绕过写侧塞一个非法值 ⇒ 读侧必须回落并点名（这一条在真机上要真的能进去，
      //    所以才刻意**没**给 value 写值域 CHECK，见迁移 0046 头注释）。
      await pool.query(
        `UPDATE runtime_settings SET value = '\"1e4\"'::jsonb WHERE key = 'demo.limit'`);
      const badLog = collectingLog();
      const bad = await readRuntimeSettings({ pool, registry: TEST_REGISTRY, log: badLog });
      assert.deepEqual(bad.values, {}, '"1e4" 不许被收成 1');
      assert.equal(bad.problems[0].reason, 'not_a_count', '回落理由要点名');
      assert.match(badLog.seen.warn[0], /demo\.limit/, 'warn 要点名 key');
      assert.equal(
        (await applyRuntimeOverrides({ demoLimit: 10 },
          { pool, registry: TEST_REGISTRY, log: pgSilent })).demoLimit,
        10, '非法值 ⇒ 回落 env（真库版）');
      await pool.query(
        `UPDATE runtime_settings SET value = '{\"a\":1}'::jsonb WHERE key = 'demo.limit'`);
      assert.deepEqual(
        (await readRuntimeSettings({ pool, registry: TEST_REGISTRY, log: pgSilent })).values, {},
        'jsonb 里是对象 ⇒ 同样判非法（口径 3 的读侧对应面）');

      // ⑤ key 形状是 DB 事实：拼错/大写的 key 当场被 CHECK 拒（不是静默多出一行幽灵配置）。
      const rejected = await pool
        .query(`INSERT INTO runtime_settings (key, value) VALUES ('X', '1'::jsonb)`)
        .then(() => null, (e) => e);
      assert.ok(rejected, '坏 key 必须被拒');
      assert.equal(rejected.code, '23514', `坏 key 应触发 check_violation(23514)，实得 ${rejected.code}`);

      // ⑥ 迁移可整体重放：再跑一遍 0046 的 SQL，表与行数都不许变。
      const mig = fs.readFileSync(
        new URL('../../deploy/migrations/0046-runtime-settings.sql', import.meta.url), 'utf8');
      await pool.query(mig);
      const after = await pool.query('SELECT count(*)::int AS n FROM runtime_settings');
      assert.equal(after.rows[0].n, 1, '重放 0046 不许多出/丢掉任何一行');

      // ⑦ **本单的灵魂（MED②）**：审计被静默抑制 ⇒ 抛 500 且**设置一格没改**。
      //    `BEFORE INSERT … RETURN NULL` 是 PG 里最静默的抑制方式（不报错，就是那一行消失了），
      //    旧实现（单语句 + 语句返回后才检查）在这一格上是「报错但设置已生效」。
      const valueBefore = (await pool.query(
        `SELECT value FROM runtime_settings WHERE key = 'demo.limit'`)).rows[0].value;
      const auditsBefore = await auditCount(pool);
      await pool.query(`CREATE FUNCTION w677_suppress_audit() RETURNS trigger AS $$
         BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);
      await pool.query(`CREATE TRIGGER w677_audit_suppressed BEFORE INSERT ON audit_log
         FOR EACH ROW EXECUTE FUNCTION w677_suppress_audit()`);
      try {
        const armed = await pool.query(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'w677_audit_suppressed'`);
        assert.equal(armed.rows[0].n, 1, 'trigger 没装上 ⇒ 下面那堆断言是在空转');
        const err = await saveRuntimeSetting({
          pool, actorId: null, key: 'demo.limit', value: 77, registry: TEST_REGISTRY, log: pgSilent,
        }).then(() => null, (e) => e);
        assert.ok(err, '审计被抑制必须抛（否则就是静默的「设置生效而审计无痕」）');
        assert.ok(err instanceof RuntimeSettingsError, '必须是 RuntimeSettingsError');
        assert.equal(err.httpStatus, 500, `必须映射 500，实得 ${err.httpStatus}`);
        assert.equal(err.code, 'internal', `code 必须是 internal，实得 ${err.code}`);
        assert.match(err.message, /审计写了 0 行/, `错误要说出写了 0 行，实得：${err.message}`);
        const valueAfter = (await pool.query(
          `SELECT value FROM runtime_settings WHERE key = 'demo.limit'`)).rows[0].value;
        assert.deepEqual(valueAfter, valueBefore,
          `设置必须一格没改（ROLLBACK 生效）：前 ${JSON.stringify(valueBefore)}`
          + ` 后 ${JSON.stringify(valueAfter)}（旧实现这里是 77 ⇒ MED② 的洞）`);
        assert.equal(await auditCount(pool), auditsBefore,
          '审计一行也不许多出（被抑制的那笔不许“补”在事务外）');
      } finally {
        await pool.query(
          'DROP TRIGGER IF EXISTS w677_audit_suppressed ON audit_log').catch(() => {});
        await pool.query('DROP FUNCTION IF EXISTS w677_suppress_audit()').catch(() => {});
      }
      assert.equal((await pool.query(
        `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'w677_audit_suppressed'`))
        .rows[0].n, 0, '测完必须拆干净（否则后面每一格都写不进审计）');

      // ⑧ `FOR UPDATE` 单独一条语句**真的拦人**：拿另一条连接占住那一行，保存必须卡住
      //    （fake 不模拟 MVCC，只能验 SQL 里有这几个字；锁住与不锁住只有真库能分）。
      await pool.query(`UPDATE runtime_settings SET value = '20'::jsonb WHERE key = 'demo.limit'`);
      const blocker = await pool.connect();
      let pending = true;
      let outcome = null;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT value FROM runtime_settings WHERE key = 'demo.limit' FOR UPDATE`);
        const saving = saveRuntimeSetting({
          pool, actorId: null, key: 'demo.limit', value: 40, registry: TEST_REGISTRY, log: pgSilent,
        }).then((r) => { pending = false; outcome = { ok: r }; },
          (e) => { pending = false; outcome = { err: e }; });
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.ok(pending,
          '别人持有那一行的行锁时，保存必须还卡着（拿不到锁 = 旧值会是「自己进来之前」那个 ⇒ '
          + '#698 的审计链洞；卡住也证明 poolMax 够用，不是卡在池子排队）');
        await blocker.query('COMMIT');
        await saving;
        assert.ok(outcome?.ok, `放行后保存必须成功，实得 ${JSON.stringify(outcome?.err?.message)}`);
        assert.equal(outcome.ok.previousValue, 20,
          '放行后读到的旧值必须是锁里最新已提交的那一个（20）');
        assert.equal(outcome.ok.value, 40);
        assert.equal(await auditCount(pool), auditsBefore + 1, '放行后那一笔审计正常落下');
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        blocker.release();
      }
    }, { poolMax: 3 });
  });

/** 本单那个动作的审计行数（RS-11 用；别的动作的审计行不算进来）。 */
async function auditCount(pool) {
  const r = await pool.query(
    'SELECT count(*)::int AS n FROM audit_log WHERE action = $1', [AUDIT_ACTION]);
  return r.rows[0].n;
}

// ---------------------------------------------------------------------------
// 6. P2a：第一格真实旋钮 `session.ttl_seconds`（解析/校验 + 热读 + 缓存 + 管理台读侧）
//
// 判据取自工单 §2①②③：解析/校验、DB 优先、回落、缓存命中、写后失效。
// 前两格是纯函数，后面几格都用**假库 + 注入的 `now`**（不真等 5 秒，也不真起 HTTP —— HTTP 那几格
// 在 `portal/test/admin-runtime-settings-api.test.js`，那里才能判「PUT 完下一次登录就生效」）。
//
// ⚠ 本节的格子彼此共享**模块级**热读缓存与 in-flight 槽 ⇒ 每段前后都 `invalidateSessionTtlCache()`。
// ---------------------------------------------------------------------------

/** 一条能同时服务「整表读」与「管理台读（带 updated_*）」的假池子；按 SQL 里有没有 updated_at 分流。 */
function ttlPool({ rows = [], throwOnSelect = null, hang = false } = {}) {
  const pool = {
    queryCount: 0,
    sqlLog: [],
    rows,
    async query(sql) {
      pool.queryCount += 1;
      pool.sqlLog.push(String(sql));
      if (hang) return new Promise(() => {});
      if (throwOnSelect) throw throwOnSelect;
      const withMeta = /updated_at/.test(String(sql));
      return {
        rows: pool.rows.map((r) => (withMeta
          ? r
          : { key: r.key, value: r.value })),
        rowCount: pool.rows.length,
      };
    },
  };
  return pool;
}

test('RS-12 session.ttl_seconds 的解析与校验：严格十进制正整数 + 区间 60..2592000', () => {
  assert.equal(SESSION_TTL_MIN_SECONDS, 60);
  assert.equal(SESSION_TTL_MAX_SECONDS, 2592000, '30 天');
  assert.equal(SESSION_TTL_DEFAULT_SECONDS, 604800, '7 天（与 config.js / compose / docs/env.md 同源）');

  // 收：两端点与中间值，JSON number 与纯数字串都要收（jsonb 里存 number，手工塞的可能是串）。
  // `'060'` 也收：纯十进制数字串，`Number('060') === 60` 没有歧义（这里从不按八进制解释，
  // 而 `parseInt('060')` 也是 60 ⇒ 两种写法同一个数，不构成「半个值静默生效」那一族）。
  for (const good of [60, 86400, 2592000, '60', '86400', '2592000', '060']) {
    const r = parseSessionTtlSeconds(good);
    assert.equal(r.ok, true, `${JSON.stringify(good)} 必须收`);
    assert.equal(r.value, Number(good));
  }
  // 拒：`Number()` / `parseInt()` 会放进来或算错的那一族，加区间外的。
  for (const bad of [
    '1e4', ' 60 ', '60s', '', '0x10', '1.5', '6e5', '0', '-1', '-60', '2592001',
    0, -1, 59, 2592001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21,
    true, false, null, undefined, {}, [], ['60'],
  ]) {
    assert.equal(parseSessionTtlSeconds(bad).ok, false, `${JSON.stringify(bad) ?? String(bad)} 必须拒`);
  }
  // 区间外与「压根不是数」要能说清是哪回事（运维的处理动作不同）。
  assert.equal(parseSessionTtlSeconds(2592001).reason, 'ttl_out_of_range');
  assert.equal(parseSessionTtlSeconds('1e4').reason, 'not_a_ttl_seconds');

  // 写侧：只收 number 类型的安全整数。`'86400'`（字符串）必须拒 —— 否则界面上多一种「看着对其实换了档」。
  for (const good of [60, 86400, 2592000]) {
    assert.equal(validateSessionTtlSeconds(good), true, `${good} 必须放行`);
  }
  for (const bad of ['86400', '', '60', 59, 2592001, 0, -1, 1.5, true, null, {}, [], Number.NaN]) {
    const why = validateSessionTtlSeconds(bad);
    assert.notEqual(why, true, `${JSON.stringify(bad) ?? String(bad)} 写侧必须拒`);
    assert.equal(typeof why, 'string', '拒绝必须返回点名的原因字符串（上层拿去填 400 的 message）');
  }
});

test('RS-13 热读三档优先级：DB 有效值 > config（env 那一档）> registry 默认；读失败绝不抛', async () => {
  invalidateSessionTtlCache();
  const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };

  // ① DB 有有效值 ⇒ 用它，不是 env 的那个（这一格红 = DB 被绕过，M-2 点名的就是这个形状）。
  const dbPool = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
  assert.equal(await readSessionTtlSeconds({ pool: dbPool, config: CONFIG, log: silentLog }), 3600);
  assert.equal(dbPool.queryCount, 1, '确实发了那次读（不是凭空有个数）');

  // ② DB 里的值非法（手工 UPDATE 成 '1e4'）⇒ 回落 env，且**点名这个 key** warn（口径 2）。
  invalidateSessionTtlCache();
  const log = collectingLog();
  const badPool = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: '1e4' }] });
  assert.equal(await readSessionTtlSeconds({ pool: badPool, config: CONFIG, log }), 777);
  assert.equal(log.seen.warn.length, 1, 'DB 值非法必须 warn 一次');
  assert.match(log.seen.warn[0], new RegExp(SESSION_TTL_KEY), 'warn 要点名是哪个 key');

  // ③ 库里压根没这一行（未配置是常态）⇒ env 那一档，不 warn。
  invalidateSessionTtlCache();
  const log2 = collectingLog();
  assert.equal(await readSessionTtlSeconds({ pool: ttlPool(), config: CONFIG, log: log2 }), 777);
  assert.equal(log2.seen.warn.length, 0, '没有行不是故障，不许刷屏');

  // ④ 表不存在 / DB 挂了 ⇒ 回落 env，**绝不抛**（抛了就是 `/api/me` 与登录一起 500）。
  invalidateSessionTtlCache();
  const dead = ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) });
  assert.equal(await readSessionTtlSeconds({ pool: dead, config: CONFIG, log: silentLog }), 777);

  // ⑤ 连 pool 都没有 ⇒ 还是回落（不抛），口径同 `readRuntimeSettings` 的 `no_pool`。
  invalidateSessionTtlCache();
  assert.equal(await readSessionTtlSeconds({ pool: null, config: CONFIG, log: silentLog }), 777);

  // ⑥ env 那一档也没有（手递的 config 缺这一格）⇒ registry 的默认值，绝不回 undefined。
  invalidateSessionTtlCache();
  assert.equal(await readSessionTtlSeconds({ pool: ttlPool(), config: {}, log: silentLog }),
    SESSION_TTL_DEFAULT_SECONDS, 'undefined 交给 createSession 就是「库里没有 TTL」');

  // ⑦ 读挂住不返回 ⇒ 按读不到处理（超时口径由 RS-10 那条共用同一个哨兵，这里只验不挂）。
  invalidateSessionTtlCache();
  const hung = ttlPool({ hang: true });
  assert.equal(await readSessionTtlSeconds({
    pool: hung, config: CONFIG, log: silentLog, timeoutMs: 30,
  }), 777, '挂住也必须按时给答案');
});

test('RS-14 热读缓存：同池 5s 内命中不发 SQL；过期后重读；换池子不串读数', async () => {
  assert.equal(SESSION_TTL_CACHE_TTL_MS, 5000, '5 秒是口径：它定义「全集群最坏多久看到新值」的上界');
  const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
  const pool = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
  let clock = 1_000_000;
  const now = () => clock;
  const read = () => readSessionTtlSeconds({ pool, config: CONFIG, now, log: silentLog });

  invalidateSessionTtlCache();
  assert.equal(await read(), 3600);
  assert.equal(pool.queryCount, 1);

  // 命中：同池 + TTL 内 ⇒ **一条 SQL 都不发**（注释里写「每请求现读 DB」就是没读懂这一格）。
  clock += 4_999;
  assert.equal(await read(), 3600);
  assert.equal(await read(), 3600);
  assert.equal(pool.queryCount, 1, '4.999s 内三次调用只发一次读');

  // 过期：到点之后必须重读 —— 这是多副本之间追上新值的唯一路径（本进程另有写路径失效）。
  clock += 2;                       // 累计 5001ms > 5000
  assert.equal(await read(), 3600);
  assert.equal(pool.queryCount, 2, 'TTL 到点必须再发一次读，否则缓存就成了永久快照');

  // 库里改了（别的副本写的）⇒ 过期后读到的是新值。
  pool.rows = [{ key: SESSION_TTL_KEY, value: 120 }];
  clock += 5_001;
  assert.equal(await read(), 120);

  // 换一个池子 ⇒ 不许拿上一个池子的读数（测试与多池场景下那会串成假绿）。
  const other = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 900 }] });
  assert.equal(await readSessionTtlSeconds({ pool: other, config: CONFIG, now, log: silentLog }), 900);
  assert.equal(other.queryCount, 1);
  invalidateSessionTtlCache();
});

test('RS-15 保存成功后缓存立即失效（M-1 点名的形状：PUT 完下一次读就是新值，不用等 5 秒）', async () => {
  const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
  const pool = new FakeRuntimePool();          // 有事务形状的那个假库：save 走的 BEGIN/…/COMMIT 它接得住
  invalidateSessionTtlCache();

  // 先读一次：库里没行 ⇒ env 那一档 777 被缓存住。
  assert.equal(await readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog }), 777);
  const afterFirst = pool.queryCount;

  // 保存（同进程写路径）⇒ 缓存必须被失效。
  const saved = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: SESSION_TTL_KEY, value: 3600, log: silentLog,
  });
  assert.equal(saved.value, 3600);
  assert.equal(pool.storedValue(SESSION_TTL_KEY), 3600, '库里真的是新值');

  const next = await readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog });
  assert.equal(next, 3600, '保存之后**下一次读**就是新值（还读到 777 = 写路径没失效缓存）');
  assert.ok(pool.queryCount > afterFirst, '这次读必须真的再发一次 SQL（命中旧缓存就是假绿）');

  // 失效只此一次：紧接着的第二次读重新命中缓存。
  const afterSecond = pool.queryCount;
  assert.equal(await readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog }), 3600);
  assert.equal(pool.queryCount, afterSecond, '失效之后的那一读已经把新值填回缓存');
  invalidateSessionTtlCache();
});

test('RS-16 管理台读侧 listRuntimeSettingsAdmin：source 三档如实 + 读失败也要给得出一整份 items', async () => {
  const CONFIG_ENV = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
  const CONFIG_DEFAULT = { sessionTtlSeconds: 604800, sessionTtlSecondsSource: 'default' };

  // ① db：值、更新时间、更新人都出自那一行。
  const at = new Date('2026-11-19T03:04:05.000Z');
  const dbPool = ttlPool({
    rows: [{ key: SESSION_TTL_KEY, value: 3600, updated_at: at, updated_by: ACTOR }],
  });
  const fromDb = await listRuntimeSettingsAdmin({
    pool: dbPool, config: CONFIG_ENV, env: {}, log: silentLog,
  });
  assert.equal(fromDb.items.length, 12);
  assert.deepEqual(Object.keys(fromDb.items[0]).sort(),
    ['applyMode', 'key', 'label', 'reason', 'source', 'updatedAt', 'updatedBy', 'value'].sort());
  assert.deepEqual(fromDb.items[0], {
    key: SESSION_TTL_KEY, label: '登录会话有效期（秒）', value: 3600, source: 'db', reason: null,
    applyMode: 'hot', updatedAt: at.toISOString(), updatedBy: ACTOR,
  });
  assert.match(dbPool.sqlLog[0], /updated_at/, '管理台那条读要带 updated_*（要能说「谁改的」）');

  // ①b 第二格：库里没它的行 ⇒ 不报 db，而是如实报 env/默认（即使**同一份响应里**第一格是 db）。
  // 「一格里有值、另一格说不清」是真形状，不许被第一格的 db 带着写成 db。
  const retItem = fromDb.items.find((i) => i.key === WORKSPACE_RETENTION_KEY);
  assert.ok(retItem, '第二格必须出现在管理台响应里（界面是列表驱动，不列出来 = 没迁）');
  assert.equal(retItem.source, 'default');
  assert.equal(retItem.value, 0, 'env 也没给 ⇒ 第三档就是 0 = 不自动清理（不是 undefined、不是 null）');
  assert.equal(retItem.reason, 'no_row');
  assert.equal(retItem.applyMode, 'hot', '不提醒重启 = 本批的对外承诺（写错就是界面撒谎）');

  // ①c 第三格（preview.ticket_ttl_seconds）：库里没它的行 ⇒ 如实报默认 60（不被第一格的 db 带着写）。
  const ttlItem = fromDb.items.find((i) => i.key === 'preview.ticket_ttl_seconds');
  assert.ok(ttlItem, '第三格必须出现在管理台响应里（列表驱动，不列出来 = 没迁）');
  assert.equal(ttlItem.source, 'default');
  assert.equal(ttlItem.value, 60, 'env 也没给 ⇒ 默认 60（与 config.js 同源）');
  assert.equal(ttlItem.applyMode, 'hot', '预览票也是热生效旋钮');

  // ①d 第四格（session.auto_title_min_new）：库里没它的行 ⇒ 如实报默认 3（不被别的格带着写）。
  const atItem = fromDb.items.find((i) => i.key === AUTO_TITLE_MIN_NEW_KEY);
  assert.ok(atItem, '第四格必须出现在管理台响应里（列表驱动，不列出来 = 没迁）');
  assert.equal(atItem.source, 'default');
  assert.equal(atItem.value, 3, 'env 也没给 ⇒ 默认 3（与 config.js / session-title.js 同源）');
  assert.equal(atItem.applyMode, 'hot', '自动标题阈值也是热生效旋钮');

  // ⚠e 第五格（preview.session_ttl_seconds）：库里没它的行 ⇒ 如实报默认 900（不被别的格带着写）。
  const pstItem = fromDb.items.find((i) => i.key === 'preview.session_ttl_seconds');
  assert.ok(pstItem, '第五格必须出现在管理台响应里（列表驱动，不列出来 = 没迁）');
  assert.equal(pstItem.source, 'default');
  assert.equal(pstItem.value, 900, 'env 也没给 ⇒ 默认 900（与 config.js / compose 同源）');
  assert.equal(pstItem.applyMode, 'hot', '预览会话有效期也是热生效旋钮');

  // ② env：库里没行，且 env 显式给了值 ⇒ source=env、值就是 config 里那个。
  const fromEnv = await listRuntimeSettingsAdmin({ pool: ttlPool(), config: CONFIG_ENV, log: silentLog });
  assert.deepEqual(fromEnv.items[0].source, 'env');
  assert.equal(fromEnv.items[0].value, 777);
  assert.equal(fromEnv.items[0].reason, 'no_row', '回落理由要能点名（界面上要说「库里没有这一行」）');
  assert.equal(fromEnv.items[0].updatedAt, null);

  // ③ default：env 也没显式给 ⇒ 第三档。**没有 `...Source` 就分不清 env 与默认**，这正是
  //    `config.js` 里必须有 `sessionTtlSecondsSource` 的原因（这一格红 = 那格被删了）。
  const fromDefault = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: CONFIG_DEFAULT, log: silentLog,
  });
  assert.equal(fromDefault.items[0].source, 'default');
  assert.equal(fromDefault.items[0].value, 604800);

  // ④ 表不存在 ⇒ 仍然给得出整份 items（端点靠这个才能「200 + 回落」，而不是管理页打不开）。
  const deadLog = collectingLog();
  const dead = await listRuntimeSettingsAdmin({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('relation "runtime_settings" does not exist'), { code: '42P01' }) }),
    config: CONFIG_ENV, log: deadLog,
  });
  assert.equal(dead.items.length, 12, '读失败时十二格都要给得出来（不是只给前几格）');
  assert.equal(dead.items[0].source, 'env');
  assert.equal(dead.items[0].reason, 'read_failed');
  assert.equal(deadLog.seen.warn.length, 1, '有人在屏幕前等答案 ⇒ 读失败要 warn（不像启动路径只能 debug）');

  // ⑤ 挂住不返回 ⇒ 也按时给答案（不许把管理页挂成一个转圈的 404）。
  const hung = await listRuntimeSettingsAdmin({
    pool: ttlPool({ hang: true }), config: CONFIG_DEFAULT, log: silentLog, timeoutMs: 30,
  });
  assert.equal(hung.items[0].reason, 'read_timeout');
  assert.equal(hung.items[0].source, 'default');

  // ⑥ 库里有一行但值是手工写坏的 ⇒ 值回落，**时间/人保留**（那是真发生过的事），reason 点名坏值。
  const withBadRow = await listRuntimeSettingsAdmin({
    pool: ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: '1e4', updated_at: at, updated_by: ACTOR }] }),
    config: CONFIG_ENV, log: silentLog,
  });
  assert.equal(withBadRow.items[0].value, 777);
  assert.equal(withBadRow.items[0].source, 'env');
  assert.equal(withBadRow.items[0].reason, 'not_a_ttl_seconds');
  assert.equal(withBadRow.items[0].updatedAt, at.toISOString());
});

test('RS-17 真库那一腿：保存后热读**立刻**是新值 + 管理台读侧报 source=db（无 PG 则 skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
      invalidateSessionTtlCache();

      // 真库前置：`audit_log.actor_id` 上有 FK（`audit_log_actor_id_fkey`）⇒ 要往审计里落一个
      // 真 actor，就必须先有这个人。**这一格是 P2a 的真库腿在本单第一次真跑才跑出来的红**
      //（之前每一轮都因为没设 `TEST_DATABASE_URL` 而 skip ⇒ `INSERT` 直接吃 23503）。
      // RS-11 全程 `actorId: null` 所以看不见这一格；本格要判的恰恰是「`updated_by` 是真的
      // 那个 actor」⇒ 不许改成 `null` 绕过，只能把人立出来。
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-p2a-actor'],
      );

      // 库里没行 ⇒ env 那一档。真表由迁移 0046 建好（夹具跑完整条迁移链）。
      assert.equal(await readSessionTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 777);

      // 真库保存（一个显式事务：FOR UPDATE → upsert → 审计 → COMMIT）。
      const saved = await saveRuntimeSetting({
        pool, actorId: ACTOR, key: SESSION_TTL_KEY, value: 120, log: pgSilent,
      });
      assert.equal(saved.value, 120);
      assert.equal(saved.updatedBy, ACTOR, 'RETURNING 里的 updated_by 是真的那个 actor');

      // 同进程热读：不等 5 秒，下一次读就是新值（写路径失效 + 真库整表读）。
      assert.equal(await readSessionTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 120);

      // 管理台读侧：source=db + jsonb 数字回读成 number + updated_at 是 DB 的 now()。
      const list = await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent });
      assert.equal(list.items[0].source, 'db');
      assert.equal(list.items[0].value, 120, 'jsonb 里的 120 回读成 JS number 120');
      assert.equal(list.items[0].updatedBy, ACTOR);
      assert.ok(Date.parse(list.items[0].updatedAt) > 0, 'updated_at 是可解析的时间');

      // 非法值走不进库里（写侧闸在 SQL 之前）⇒ 库里还是 120。
      await assert.rejects(
        () => saveRuntimeSetting({ pool, actorId: ACTOR, key: SESSION_TTL_KEY, value: '1e4', log: pgSilent }),
        (err) => err.code === 'validation_failed' && err.details.field === 'value',
      );
      assert.equal((await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent })).items[0].value, 120);

      // #701 返修 MED 在**真驱动**上也算一次：冷缓存四路并发 ⇒ 只许发一条 SELECT。
      // 假库里那一格（RS-18）只能判「形状」，这里判的是真 node-pg 连接上会不会被放大成 4 条往返。
      invalidateSessionTtlCache();
      let selects = 0;
      const counted = {
        query: (sql, args) => { selects += 1; return pool.query(sql, args); },
        connect: () => pool.connect(),
      };
      const concurrent = await Promise.all(Array.from({ length: 4 }, () => readSessionTtlSeconds({
        pool: counted, config: CONFIG, log: pgSilent,
      })));
      assert.deepEqual(concurrent, [120, 120, 120, 120], '真库上四路也必须拿同一个值');
      assert.equal(selects, 1, `真库上四路并发也只许一条 SQL（实发 ${selects} 条）`);
      invalidateSessionTtlCache();
    }, { log: pgSilent.log });
  });

// ---------------------------------------------------------------------------
// 7. #701 返修：热读的 in-flight 合并（MED）+ env 兜底与 DB 同一套闸（LOW③）
//
//   RS-18 冷缓存并发 ⇒ 只发一条 SQL（形状照 `llm.js` 的 TTL 缓存「按 client 身份分槽」）
//   RS-19 在飞那趟**失败** ⇒ 槽必须清掉（不许把之后所有读钉在同一个已落定的 promise 上）
//   RS-20 在飞期间 `saveRuntimeSetting` 成功 ⇒ 放行后的下一次读必须重发 SQL（失效器也清槽）
//   RS-21 env 兜底值也过 registry 的 `parse`/`validate` ⇒ 坏值回落默认 + 点名 warn；好值照收
// ---------------------------------------------------------------------------

/**
 * 「整表读要先等在飞闸门上」的假库（RS-18 / RS-20 要判的是**在飞期间**那个时间窗：并发第二路
 * 必须挤进来，才知道它到底有没有复用那一趟）。继承 `FakeRuntimePool` ⇒ 事务/审计/回滚那套语义
 * 照旧，只给整表读加一道闸，并在**进入时**取快照（在飞期间库里改了也看不见，同形于真库
 * READ COMMITTED 下一条语句自己的快照）。
 */
class GatingRuntimePool extends FakeRuntimePool {
  constructor(opts = {}) {
    super(opts);
    this.gate = null;               // 非 null ⇒ 下一条整表读挂在它上面（= 那一趟「在飞」）
    this.releaseThrows = false;     // 放行时让这趟抛 ⇒ RS-19 的「在飞那趟挂了」
  }

  query(sql, params = []) {
    const text = String(sql);
    const isTableRead = /\bruntime_settings\b/i.test(text) && !/\bINSERT\b/i.test(text)
      && !/\bFOR\s+UPDATE\b/i.test(text);
    if (!isTableRead || !this.gate) return super.query(sql, params);
    this.queryCount += 1;
    this.sqlLog.push({ sql: text, params });
    const merged = new Map(this.committed);
    for (const [k, v] of (this.pending ?? new Map())) merged.set(k, v);
    const rows = [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, value]) => ({ key, value }));
    const gate = this.gate;
    return gate.then(() => {
      if (this.releaseThrows) {
        throw Object.assign(new Error('connection terminated unexpectedly'), { code: '08006' });
      }
      return { rows, rowCount: rows.length };
    });
  }
}

/** 可在跑测中途翻转「这条读坏不坏」的假库（RS-19 要的是**抖动 → 恢复**那一段时间形状）。 */
function flakyPool({ rows = [] } = {}) {
  const pool = {
    queryCount: 0,
    sqlLog: [],
    rows,
    broken: true,
    async query(sql) {
      pool.queryCount += 1;
      pool.sqlLog.push(String(sql));
      if (pool.broken) {
        throw Object.assign(
          new Error('relation "runtime_settings" does not exist'), { code: '42P01' });
      }
      const withMeta = /updated_at/.test(String(sql));
      return {
        rows: pool.rows.map((r) => (withMeta ? r : { key: r.key, value: r.value })),
        rowCount: pool.rows.length,
      };
    },
  };
  return pool;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('RS-18 冷缓存的并发热读只发一条 SQL（MED：续期热路径不许被并发放大成 N 条读 + 各等 1.5s）',
  async () => {
    invalidateSessionTtlCache();
    const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
    const pool = new GatingRuntimePool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    let release;
    pool.gate = new Promise((resolve) => { release = () => resolve(); });

    // 冷缓存（刚失效）+ 四路同时进来 = 一波登录/续期撞上同一刻的读。
    const four = Array.from({ length: 4 }, () => readSessionTtlSeconds({
      pool, config: CONFIG, log: silentLog,
    }));
    await tick();                          // 让第一路真的把 SQL 发出去（进入「在飞」）
    assert.equal(pool.queryCount, 1,
      `四路并发必须合并成 **1 条** SQL（实发 ${pool.queryCount} 条 = 没有 in-flight 合并）`);

    // 槽是按 **pool 身份**分的：B 池不许蹭 A 池那一趟（照 `llm.js#dataPlaneNameCache` 的口径）。
    const other = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 900 }] });
    assert.equal(await readSessionTtlSeconds({ pool: other, config: CONFIG, log: silentLog }), 900,
      '另一个池子必须自己发（拿 A 池在飞那趟的结果就是跨池串读数）');
    assert.equal(other.queryCount, 1, 'B 池那一读是真的发的');

    release();
    assert.deepEqual(await Promise.all(four), [3600, 3600, 3600, 3600],
      '四路必须拿到同一趟的同一个值');
    assert.equal(pool.queryCount, 1, '合并之后仍然只有一条 SQL（不许补发）');

    // 合并不许把缓存弄丢：那一趟的结果照样回填 ⇒ 紧接着的读零 SQL。
    assert.equal(await readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog }), 3600);
    assert.equal(pool.queryCount, 1, '在飞那趟必须照常回填缓存（否则每次都重新发一条）');
    invalidateSessionTtlCache();
  });

test('RS-19 在飞那趟失败 ⇒ 清槽，之后的读重新发 SQL（不许被钉在同一个已落定的 promise 上）',
  async () => {
    invalidateSessionTtlCache();
    const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
    const pool = flakyPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    let clock = 1_000_000;
    const read = () => readSessionTtlSeconds({
      pool, config: CONFIG, now: () => clock, log: silentLog,
    });

    // ① 第一趟：DB 抛（表不在 = 最真实的抖动形状）⇒ 读侧照旧给回落值，**绝不抛**（口径 1）。
    assert.equal(await read(), 777, '失败那趟也要给答案（抛了就是 /api/me 与登录一起 500）');
    assert.equal(pool.queryCount, 1);

    // ② 缓存里钉着的是失败那趟填的回落值 ⇒ 先让 TTL 到点（多副本追上就靠这一条路）。
    pool.broken = false;                     // DB 恢复
    clock += SESSION_TTL_CACHE_TTL_MS + 1;
    assert.equal(await read(), 3600, '恢复后必须读到**库里**的值，不是被钉住的 777');
    assert.equal(pool.queryCount, 2, '必须重新发 SQL（复用已落定那一趟 = 失败路径没清槽，变异 M-2）');

    // ③ 在飞那趟**挂掉**时挤进来的共享者：不许抛、不许自己再发一条，并且槽也不能留下。
    invalidateSessionTtlCache();
    const gate = new GatingRuntimePool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    let release;
    gate.gate = new Promise((resolve) => { release = () => resolve(); });
    gate.releaseThrows = true;               // 放行时那一趟抛
    const first = readSessionTtlSeconds({
      pool: gate, config: CONFIG, now: () => clock, log: silentLog,
    });
    await tick();
    const second = readSessionTtlSeconds({
      pool: gate, config: CONFIG, now: () => clock, log: silentLog,
    });
    assert.equal(gate.queryCount, 1, '第二路必须复用那一趟（共享者不许自己再发一条）');
    release();
    assert.equal(await first, 777, '那一趟挂了 ⇒ 发起方按回落给答案');
    assert.equal(await second, 777, '共享者也按回落给答案（共享一个 rejected promise 不许把读弄抛）');
    gate.gate = null;
    clock += SESSION_TTL_CACHE_TTL_MS + 1;
    assert.equal(await readSessionTtlSeconds({
      pool: gate, config: CONFIG, now: () => clock, log: silentLog,
    }), 3600, '挂掉那一趟之后必须重新发一条读，拿到真值 3600（槽被钉住就永远是 777）');
    assert.equal(gate.queryCount, 2, `失败之后必须重发（实发 ${gate.queryCount} 条）`);
    invalidateSessionTtlCache();
  });

test('RS-20 在飞期间保存成功 ⇒ 放行后的下一次读重发 SQL（写路径失效也要清 in-flight 槽）',
  async () => {
    invalidateSessionTtlCache();
    const CONFIG = { sessionTtlSeconds: 777, sessionTtlSecondsSource: 'env' };
    const pool = new GatingRuntimePool({ rows: [{ key: SESSION_TTL_KEY, value: 60 }] });
    let release;
    pool.gate = new Promise((resolve) => { release = () => resolve(); });

    const inFlight = readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog });
    await tick();
    assert.equal(pool.queryCount, 1, '第一路已经把读发出去了（它在飞）');

    // 在飞期间完成一次保存（同进程写路径：COMMIT 之后调失效器）。
    const saved = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: SESSION_TTL_KEY, value: 3600, log: silentLog,
    });
    assert.equal(saved.value, 3600);
    assert.equal(pool.storedValue(SESSION_TTL_KEY), 3600, '库里真的是新值');
    const afterSave = pool.queryCount;

    // 失效之后、放行**之前**发起下一次读：那一刻槽必须已经是空的，它只能自己发一条。
    const nextRead = readSessionTtlSeconds({ pool, config: CONFIG, log: silentLog });
    release();
    assert.equal(await inFlight, 60, '在飞那一趟拿的是它发起那一刻的库（不是 PUT 之后的值）');
    assert.equal(await nextRead, 3600,
      'PUT 完的下一次读必须是新值（拿到 60 = 复用了 PUT 之前就发起的那一趟）');
    assert.equal(pool.queryCount, afterSave + 1,
      `下一次读必须真的重发一条（实发 ${pool.queryCount - afterSave} 条；0 = 失效器没清槽）`);
    invalidateSessionTtlCache();
  });

test('RS-21 env 兜底也过 registry 那套闸（LOW③：不留「DB 严格、env 宽松」两套真相）', async () => {
  const BAD = [
    ['低于下限', '30', 'ttl_out_of_range'],
    ['高于上限', '2592001', 'ttl_out_of_range'],
    ['小数', '60.5', 'not_a_ttl_seconds'],
    ['压根不是数', 'abc', 'not_a_ttl_seconds'],
  ];
  for (const [label, raw, reason] of BAD) {
    // `loadConfig` 走通用 `intEnv`（`Number()` 语义）⇒ 它照样收下 `30` / `2592001` / `60.5`。
    // 这一格钉的正是「config 收下了，但运行时那一层**不认**」——只钉 config 是假绿。
    const cfg = loadConfig({ COOKIE_PROFILE: 'dev-http', SESSION_TTL_SECONDS: raw });
    const env = { SESSION_TTL_SECONDS: raw };
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    invalidateSessionTtlCache();
    const hotLog = collectingLog();
    const hot = await readSessionTtlSeconds({
      pool: ttlPool(), config: cfg, env, log: hotLog,   // 库里没这一行 ⇒ 落到 env 那一档
    });
    assert.equal(hot, SESSION_TTL_DEFAULT_SECONDS,
      `${label}：env SESSION_TTL_SECONDS=${raw} 过不了闸 ⇒ 必须回落默认 604800（实得 ${hot}）`);
    const named = hotLog.seen.warn.filter((m) => m.includes(SESSION_TTL_KEY)
      && m.includes('SESSION_TTL_SECONDS'));
    assert.equal(named.length, 1,
      `坏 env 值必须点名 warn 一次（key + env 名），实得 ${JSON.stringify(hotLog.seen.warn)}`);
    assert.match(named[0], new RegExp(escaped), 'warn 要带上那个坏值本身（运维要看得见它没生效）');
    assert.match(named[0], new RegExp(reason), 'warn 要带上被拒的理由（越界与不是数是两种处理动作）');

    const listLog = collectingLog();
    const list = await listRuntimeSettingsAdmin({
      pool: ttlPool(), config: cfg, env, log: listLog,
    });
    assert.equal(list.items[0].value, SESSION_TTL_DEFAULT_SECONDS,
      `${label}：管理台报的值必须与热读用的是同一个数`);
    assert.equal(list.items[0].source, 'default',
      '来源必须如实报 default —— env 那个值压根没生效，报 env 就是指着不生效的数（#485 那格口径）');
    assert.ok(listLog.seen.warn.some((m) => m.includes('SESSION_TTL_SECONDS') && m.includes(raw)),
      `管理台那一路也要点名（实得 ${JSON.stringify(listLog.seen.warn)}）`);
  }

  // 好值：正常采用，且来源如实报 env、一条 warn 都不许有（不许把闸做成「env 一律不信」。）
  invalidateSessionTtlCache();
  const okEnv = { SESSION_TTL_SECONDS: '86400' };
  const okCfg = loadConfig({ COOKIE_PROFILE: 'dev-http', SESSION_TTL_SECONDS: '86400' });
  const okLog = collectingLog();
  assert.equal(await readSessionTtlSeconds({
    pool: ttlPool(), config: okCfg, env: okEnv, log: okLog,
  }), 86400, '合法 env 值照旧采用（这一格红 = 闸被做成了「env 全不信」）');
  const okList = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: okCfg, env: okEnv, log: okLog,
  });
  assert.equal(okList.items[0].value, 86400);
  assert.equal(okList.items[0].source, 'env', '合法值来源仍是 env（不是被误降成 default）');
  assert.deepEqual(okLog.seen.warn, [], `合法值不许 warn（实得 ${JSON.stringify(okLog.seen.warn)}）`);

  // 没有 env 原话、坏值**只在 config 里**（手递的 config、或别的进程算出来的）⇒ 同一把闸照样拦。
  invalidateSessionTtlCache();
  const configOnlyLog = collectingLog();
  assert.equal(await readSessionTtlSeconds({
    pool: ttlPool(), config: { sessionTtlSeconds: 2592001, sessionTtlSecondsSource: 'env' },
    env: {}, log: configOnlyLog,
  }), SESSION_TTL_DEFAULT_SECONDS, '坏值只长在 config 里也必须回落默认（不许只判 env 原话）');
  assert.ok(configOnlyLog.seen.warn.some((m) => m.includes('config.sessionTtlSeconds')),
    `来源要点名是 config 那一档（实得 ${JSON.stringify(configOnlyLog.seen.warn)}）`);

  // 优先级不许因为这道闸漂移：DB 有合法行时照样用 DB 的（env 坏不坏都一样）。
  invalidateSessionTtlCache();
  assert.equal(await readSessionTtlSeconds({
    pool: ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 120 }] }),
    config: loadConfig({ COOKIE_PROFILE: 'dev-http', SESSION_TTL_SECONDS: '30' }),
    env: { SESSION_TTL_SECONDS: '30' }, log: silentLog,
  }), 120, 'DB > env > 默认：闸只作用在 env 那一档，不许把 DB 也压下去');

  // 闸是**条目自己声明**的：条目没写 parse/validate（P3 的新旋钮形状）⇒ 原样通过，不凭空发明。
  const NO_GATE_REGISTRY = {
    'demo.plain': {
      key: 'demo.plain', configPath: 'demoPlain', envVar: 'DEMO_PLAIN', defaultValue: 5,
    },
  };
  const plain = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: { demoPlain: 99 }, registry: NO_GATE_REGISTRY,
    env: { DEMO_PLAIN: '99' }, log: silentLog,
  });
  assert.equal(plain.items[0].value, 99, '没声明闸的条目不许被这一层的区间裁决拦住');
  assert.equal(plain.items[0].source, 'env');

  // 启动那一路（覆盖层）必须走**同一把**闸：否则「界面说 30、启动算的是 30、热读用的是默认」。
  invalidateSessionTtlCache();
  const overlaid = await applyRuntimeOverrides(
    loadConfig({ COOKIE_PROFILE: 'dev-http', SESSION_TTL_SECONDS: '30' }),
    { pool: new FakeRuntimePool(), env: { SESSION_TTL_SECONDS: '30' }, log: silentLog },
  );
  assert.equal(overlaid.sessionTtlSeconds, SESSION_TTL_DEFAULT_SECONDS,
    '覆盖层也必须把坏 env 值降回默认（两套真相的另一半就在这条路上）');
  invalidateSessionTtlCache();
});

// ---------------------------------------------------------------------------
// PR #701 二审 LOW②：DB 读失败**叠加**坏 env 时，一次热读只许 warn 一条
//
// 修的是「刷屏 + 半边真相」：DB 抖动期间每个请求都走「读失败 ⇒ 回落」这条路，而回落里还要过
// env 那道闸。旧形状下一次热读会 warn **三条**（`readRuntimeSettings` 一条 DB 故障 + 本趟
// 算 env 兜底一条 + 外层接住 `read_unavailable` 后又把同一条 env 文案重播一条），而
// `docs/api/portal.md` §4.21 / `docs/env.md` 的口径是「坏 env 留一条点名 warn」。
// 现在：**同一趟最多一条**，且那一条必须同时说清两件事（缺一半 = 运维少一半真相）。
// ---------------------------------------------------------------------------

test('RS-22 DB 读失败叠加坏 env ⇒ 同一次热读只 warn 一条，且一条里同时说清两件事（二审 LOW②）',
  async () => {
    const BAD_ENV = { SESSION_TTL_SECONDS: '30' };   // 区间 60..2592000 之外 ⇒ 必须被拒
    const BAD_CFG = { sessionTtlSeconds: 30, sessionTtlSecondsSource: 'env' };

    // ① 判据本体（变异 M-2 点名的就是这一格：把 warn 拆回两条 ⇒ 这里以「3 条 ≠ 1 条」点名红）。
    invalidateSessionTtlCache();
    const log = collectingLog();
    const dead = flakyPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });   // broken=true
    assert.equal(await readSessionTtlSeconds({ pool: dead, config: BAD_CFG, env: BAD_ENV, log }),
      SESSION_TTL_DEFAULT_SECONDS, '两档都不可用 ⇒ 回落 registry 默认（数值口径不许因为 warn 合并漂移）');
    assert.equal(dead.queryCount, 1, '那一趟必须真的发过读（红要红在「warn 几条」，不是「没跑到」）');
    assert.equal(log.seen.warn.length, 1,
      `同一次热读**最多一条** warn（实得 ${log.seen.warn.length} 条：${JSON.stringify(log.seen.warn)}）`);
    const [both] = log.seen.warn;
    assert.match(both, /42P01/, '那一条里必须带 DB 侧的原因（驱动给的 code，不带就是要人猜）');
    assert.match(both, /读 runtime_settings 失败/, 'DB 侧：要说清是「读失败」，不是「库里没值」');
    assert.match(both, new RegExp(SESSION_TTL_KEY.replace(/\./g, '\\.')), '必须点名是哪个旋钮');
    assert.match(both, /SESSION_TTL_SECONDS/, 'env 侧：要点名是哪个环境变量');
    assert.match(both, /"30"/, 'env 侧：要带上被拒的那个坏值原话');
    assert.match(both, /ttl_out_of_range/, 'env 侧：要带上被拒的理由（区间外与不是数是两种处理动作）');

    // ② 反向：只 DB 故障、env 合法 ⇒ 仍然恰好一条，且**不许**冒出 env 那半截（合并 ≠ 一律加一句），
    //    也不许把值一起回落成默认（env 是好的，就该用 env 的）。
    invalidateSessionTtlCache();
    const dbOnly = collectingLog();
    const dead2 = flakyPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    assert.equal(await readSessionTtlSeconds({
      pool: dead2, config: { sessionTtlSeconds: 86400, sessionTtlSecondsSource: 'env' },
      env: { SESSION_TTL_SECONDS: '86400' }, log: dbOnly,
    }), 86400, 'DB 挂了但 env 合法 ⇒ 用 env 的值（合并 warn 不许顺手把值也回落掉）');
    assert.equal(dbOnly.seen.warn.length, 1,
      `只坏 DB 也只许一条（实得 ${JSON.stringify(dbOnly.seen.warn)}）`);
    assert.doesNotMatch(dbOnly.seen.warn[0], /env 兜底被拒/, 'env 没坏就不许说 env 被拒（拼盘式合并）');
    assert.doesNotMatch(dbOnly.seen.warn[0], /同时撞上有/, '只有一件事 ⇒ **原文照播**（RS-13 ② 钉的是原话）');

    // ③ 反向：只坏 env（DB 正常、库里没行）⇒ 一条，且必须是 RS-21 那条原话，不许被重新措辞。
    invalidateSessionTtlCache();
    const envOnly = collectingLog();
    assert.equal(await readSessionTtlSeconds({
      pool: ttlPool(), config: BAD_CFG, env: BAD_ENV, log: envOnly,
    }), SESSION_TTL_DEFAULT_SECONDS);
    assert.equal(envOnly.seen.warn.length, 1,
      `只坏 env 也只许一条（实得 ${JSON.stringify(envOnly.seen.warn)}）`);
    assert.match(envOnly.seen.warn[0], /env 兜底被拒/);
    assert.doesNotMatch(envOnly.seen.warn[0], /同时撞上有/, '单件事不许被改形（否则 RS-21 那批原话判据全废）');

    // ④ 抖动期的真实形状：一波并发热读共享同一趟**失败**的在飞读 ⇒ 整波只许一条。
    //    旧形状这里是 1（DB）+ 5（每个调用方各重算一遍 env）= 6 条；共享者必须只留 debug。
    invalidateSessionTtlCache();
    const wave = collectingLog();
    const gate = new GatingRuntimePool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    let release;
    gate.gate = new Promise((resolve) => { release = () => resolve(); });
    gate.releaseThrows = true;                     // 放行时那一趟抛 = 抖动最真实的形状
    const five = Array.from({ length: 5 }, () => readSessionTtlSeconds({
      pool: gate, config: BAD_CFG, env: BAD_ENV, log: wave,
    }));
    await tick();
    release();
    assert.deepEqual(await Promise.all(five),
      Array.from({ length: 5 }, () => SESSION_TTL_DEFAULT_SECONDS),
      '五路都按回落给答案（共享一个 rejected promise 不许把读弄抛，RS-19 同口径）');
    assert.equal(gate.queryCount, 1, '整波只发一条 SQL（MED 的合并口径不许因为这次动 warn 而漂移）');
    assert.equal(wave.seen.warn.length, 1,
      `一波并发热读**整波**只许一条 warn（实得 ${wave.seen.warn.length} 条：${JSON.stringify(wave.seen.warn)}）`);

    // ⑤ 预算是**每一趟**，不是进程级 once：缓存到点的下一趟照样得再说一次（否则故障被静音）。
    invalidateSessionTtlCache();
    const twice = collectingLog();
    const stillBroken = flakyPool({ rows: [{ key: SESSION_TTL_KEY, value: 3600 }] });
    let clock = 5_000_000;
    const readAgain = () => readSessionTtlSeconds({
      pool: stillBroken, config: BAD_CFG, env: BAD_ENV, now: () => clock, log: twice,
    });
    assert.equal(await readAgain(), SESSION_TTL_DEFAULT_SECONDS);
    clock += SESSION_TTL_CACHE_TTL_MS + 1;         // 缓存到点 ⇒ 又热读一趟（DB 还坏着）
    assert.equal(await readAgain(), SESSION_TTL_DEFAULT_SECONDS);
    assert.equal(stillBroken.queryCount, 2, '第二趟必须真的重新发读（否则这一格只数到一条是假绿）');
    assert.equal(twice.seen.warn.length, 2,
      `两趟热读**各一条**（合并是「每趟一条」，不是「进程里只播一次」；实得 ${twice.seen.warn.length}）`);
    invalidateSessionTtlCache();
  });

// ---------------------------------------------------------------------------
// 8. P3 第一批：第二格真实旋钮 `workspace.retention_days`
//
// 判据取自工单 §2②：registry 解析/校验（含 **`0` 是有效值** 与上界理由）、热读三档、缓存、
// 写后失效、并发只发一条、在飞失败清槽、env 也过闸、一次热读最多一条 warn、真库腿。
// 形状逐格照抄第 6/7 节（同一套机件 ⇒ 判据形状也必须一样，否则第二格是「另一套口径」）。
//
// ⚠ 这一节的格子共享**模块级**的两份热读缓存/槽 ⇒ 每段前后都 `invalidateWorkspaceRetentionCache()`
//   （要牵扯 TTL 那格时两把一起失效）。
// ---------------------------------------------------------------------------

const CFG = { workspaceRetentionDays: 30, workspaceRetentionDaysSource: 'env' };

test('RS-23 workspace.retention_days 的解析与校验：非负整数、0 是有效值、上界 3650', () => {
  assert.equal(WORKSPACE_RETENTION_DEFAULT_DAYS, 0,
    '默认 0 = 不自动清理（config.js / compose / docs/env.md 同源）');
  assert.equal(WORKSPACE_RETENTION_MAX_DAYS, 3650, '上界 = 10 年（产品口径，理由在源码注释里）');

  // 收：**0 必须收**（它是「关掉清理」这个有效值，不是「没填」—— 这是这一格与 TTL 那格唯一的下界差异，
  // 也是 `if (!raw)` 那一族最容易顺手写错的地方），加两端点与中间值。
  for (const good of [0, 1, 7, 30, 3650, '0', '7', '3650', '007']) {
    const r = parseWorkspaceRetentionDays(good);
    assert.equal(r.ok, true, `${JSON.stringify(good)} 必须收`);
    assert.equal(r.value, Number(good));
  }
  assert.deepEqual(parseWorkspaceRetentionDays(0), { ok: true, value: 0 },
    '0 不许被当成假值丢掉（丢了就变成「库里写了不清理，读出来却回落」）');
  // 拒：`Number()` / `parseInt()` 会放进来或算错的那一族+ 负数 + 越界。
  for (const bad of [
    '1e3', ' 7 ', '7s', '', '0x10', '7.0', '1.5', '3651', '-1', '-0',
    -1, 3651, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21,
    true, false, null, undefined, {}, [], ['7'],
  ]) {
    assert.equal(parseWorkspaceRetentionDays(bad).ok, false,
      `${JSON.stringify(bad) ?? String(bad)} 必须拒`);
  }
  assert.equal(parseWorkspaceRetentionDays(3651).reason, 'retention_days_out_of_range');
  assert.equal(parseWorkspaceRetentionDays('1e3').reason, 'not_a_retention_days');

  // 写侧：只收 number 类型的安全整数。`'7'`（字符串）必须拒 —— 否则界面上多一种「看着对其实换了档」。
  for (const good of [0, 7, 3650]) {
    assert.equal(validateWorkspaceRetentionDays(good), true, `${good} 必须放行（0 也是）`);
  }
  for (const bad of ['7', '', 3651, -1, 1.5, true, null, {}, [], Number.NaN]) {
    const why = validateWorkspaceRetentionDays(bad);
    assert.notEqual(why, true, `${JSON.stringify(bad) ?? String(bad)} 写侧必须拒`);
    assert.equal(typeof why, 'string', '拒绝必须返回点名的原因字符串');
  }
  // 负数与越界要各说各话（一个要问「是不是想写 0」，一个要问「是不是单位填错了」）。
  assert.match(String(validateWorkspaceRetentionDays(-1)), /0/);
  assert.match(String(validateWorkspaceRetentionDays(3651)), /3650/);
});

test('RS-24 第二格热读三档：DB > env（过闸）> 默认 0；任何一档坏了都绝不抛', async () => {
  invalidateWorkspaceRetentionCache();

  // ① DB 有有效值 ⇒ 用它，不是 env 的那个（红 = DB 被绕过 = 界面是装饰品）。
  const dbPool = ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 7 }] });
  assert.equal(await readWorkspaceRetentionDays({
    pool: dbPool, config: CFG, env: {}, log: silentLog,
  }), 7);
  assert.equal(dbPool.queryCount, 1, '确实发了那次读');

  // ①b 库里写的是 **0** ⇒ 读出来必须是 0，不许「顺手回落」成 env 的 30。
  invalidateWorkspaceRetentionCache();
  const zeroPool = ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 0 }] });
  assert.equal(await readWorkspaceRetentionDays({
    pool: zeroPool, config: CFG, env: {}, log: silentLog,
  }), 0, '0 是「关掉清理」这个真值：回落成 30 就是「库里说不清理、实际清 30 天」');

  // ② 库里值非法（手工 UPDATE 成 '1e3'）⇒ 回落 env，且点名 warn 一次。
  invalidateWorkspaceRetentionCache();
  const log = collectingLog();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: '1e3' }] }),
    config: CFG, env: {}, log,
  }), 30);
  assert.equal(log.seen.warn.length, 1, `恰好一条（实得 ${JSON.stringify(log.seen.warn)}）`);
  assert.match(log.seen.warn[0], new RegExp(WORKSPACE_RETENTION_KEY.replace(/\./g, '\\.')),
    'warn 要点名是哪个 key');

  // ③ 库里没这一行（未配置是常态）⇒ env 那一档，不 warn。
  invalidateWorkspaceRetentionCache();
  const log2 = collectingLog();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool(), config: CFG, env: {}, log: log2,
  }), 30);
  assert.deepEqual(log2.seen.warn, [], '没有行不是故障，不许刷屏');

  // ④ 表不存在 / DB 挂了 ⇒ 回落，**绝不抛**（抛了就是整个 offboarding 循环停摆）。
  invalidateWorkspaceRetentionCache();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) }),
    config: CFG, env: {}, log: silentLog,
  }), 30);

  // ⑤ 连 pool 都没有 ⇒ 还是回落（不抛）。
  invalidateWorkspaceRetentionCache();
  assert.equal(await readWorkspaceRetentionDays({
    pool: null, config: CFG, env: {}, log: silentLog,
  }), 30);

  // ⑥ 三档全空 ⇒ registry 默认 0，且**绝不是 undefined**（undefined 交给 `=== 0` 判据就是「清」）。
  invalidateWorkspaceRetentionCache();
  const none = await readWorkspaceRetentionDays({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  });
  assert.equal(none, WORKSPACE_RETENTION_DEFAULT_DAYS);
  assert.notEqual(none, undefined, 'undefined === 0 是 false ⇒ 循环会以为「清理开着」');

  // ⑦ 读挂住不返回 ⇒ 按时给答案（不许把循环那一拍挂死）。
  invalidateWorkspaceRetentionCache();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool({ hang: true }), config: CFG, env: {}, log: silentLog, timeoutMs: 30,
  }), 30);

  // ⑧ 上界外的值（`config.js` 的 `nonNegativeIntEnv` 收得下 4000，registry 不收）⇒ 回落**默认 0**
  //    = 更保守的一档（少删目录，不会误删），并点名是哪一档没生效。
  invalidateWorkspaceRetentionCache();
  const overLog = collectingLog();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool(), config: { workspaceRetentionDays: 4000, workspaceRetentionDaysSource: 'env' },
    env: {}, log: overLog,
  }), 0, '越界 ⇒ 回落默认 0（不是 4000，也不是 undefined）');
  assert.ok(overLog.seen.warn.some((m) => m.includes('config.workspaceRetentionDays')
    && m.includes('retention_days_out_of_range')),
    `要点名是哪一档、为什么（实得 ${JSON.stringify(overLog.seen.warn)}）`);

  // ⑨ 两格读的是同一张表 ⇒ 一格有行、另一格没行时互不干扰（不许「有一格能读」就把另一格也当有值）。
  invalidateWorkspaceRetentionCache();
  invalidateSessionTtlCache();
  const mixed = ttlPool({ rows: [{ key: SESSION_TTL_KEY, value: 120 }] });
  assert.equal(await readSessionTtlSeconds({ pool: mixed, config: CFG, env: {}, log: silentLog }),
    120);
  invalidateWorkspaceRetentionCache();
  assert.equal(await readWorkspaceRetentionDays({
    pool: mixed, config: CFG, env: {}, log: silentLog,
  }), 30, 'TTL 那格有行不许让保留天数那格凭空读出一个数');
  invalidateWorkspaceRetentionCache();
});

test('RS-25 第二格缓存：同池 5s 内命中不发 SQL、过期后重读、换池不串、两格各有各的缓存', async () => {
  assert.equal(HOT_READ_CACHE_TTL_MS, 5000, '5 秒是口径（两格共用同一个数，别给第二格单独拍一个）');
  assert.equal(SESSION_TTL_CACHE_TTL_MS, HOT_READ_CACHE_TTL_MS,
    'TTL 那格的 5s 与这一格必须是同一个数：「改完最多 5 秒生效」是对外的一句话');
  invalidateWorkspaceRetentionCache();
  const pool = ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 7 }] });
  let clock = 2_000_000;
  const now = () => clock;
  const read = () => readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, now, log: silentLog,
  });

  assert.equal(await read(), 7);
  assert.equal(pool.queryCount, 1);
  clock += HOT_READ_CACHE_TTL_MS;           // 边界内（`<=`）⇒ 命中
  assert.equal(await read(), 7);
  assert.equal(pool.queryCount, 1, '5s 内命中缓存 ⇒ 不许发第二条 SQL（每拍一条 = 给空闲循环加往返）');

  pool.rows = [{ key: WORKSPACE_RETENTION_KEY, value: 14 }];
  clock += 1;                               // 过界 ⇒ 重读
  assert.equal(await read(), 14, '过期后必须重读（钉住旧值 = 改了不清理，30 天后目录还在）');
  assert.equal(pool.queryCount, 2);

  // 换池子不串读数（键到 pool 身份）。
  const other = ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 21 }] });
  assert.equal(await readWorkspaceRetentionDays({
    pool: other, config: CFG, env: {}, now, log: silentLog,
  }), 21, 'B 池必须自己读（拿 A 池的缓存就是跨池串读数）');
  assert.equal(other.queryCount, 1);

  // **两格各有各的缓存**：读 TTL 不许把保留天数的缓存顶掉（共用一份工厂状态就是这里的红）。
  // （先把 A 池的槽重新填回 —— 上面那一次 B 池的读合法地顶掉了它，键到池身份就是要顶。）
  assert.equal(await read(), 14);
  const before = pool.queryCount;
  invalidateSessionTtlCache();
  await readSessionTtlSeconds({ pool, config: CFG, env: {}, now, log: silentLog });
  assert.equal(await read(), 14);
  assert.equal(pool.queryCount, before + 1,
    '只有 TTL 那一格该发 SQL（这里 +2 = 保留天数的缓存被 TTL 的读顶掉了）');
  // 反向也要成：保留天数的读不许顶掉 TTL 那一格的缓存。
  const beforeTtl = pool.queryCount;
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, now, log: silentLog,
  }), 14);
  assert.equal(await readSessionTtlSeconds({ pool, config: CFG, env: {}, now, log: silentLog }),
    SESSION_TTL_DEFAULT_SECONDS,
    '这一份 config 里没有 sessionTtlSeconds ⇒ TTL 读到的就是第三档（604800）');
  assert.equal(pool.queryCount, beforeTtl,
    '两格都不许重新发 SQL（保留天数命中自己的缓存，TTL 也命中它自己那一份）');
  invalidateWorkspaceRetentionCache();
});

test('RS-25b 保存后缓存立即失效（M-3 点名的形状：删掉失效登记那一行就必须红）', async () => {
  invalidateWorkspaceRetentionCache();
  invalidateSessionTtlCache();
  const pool = new FakeRuntimePool();
  // 先读一次：库里没行 ⇒ env 那一档 30 被缓存住。
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }), 30);
  assert.equal(pool.queryCount, 1, '第一读真的发了读');

  const saved = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 7, log: silentLog,
  });
  assert.equal(saved.value, 7, '写侧收 7');
  assert.equal(pool.storedValue(WORKSPACE_RETENTION_KEY), 7, '库里真的是新值');
  // 从**保存之后**开始数 SQL：否则保存自己那五条（BEGIN/…/COMMIT）会把「没重发」掩盖成「重发了」。
  const afterSave = pool.queryCount;

  const next = await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  });
  assert.equal(next, 7, '保存之后**下一次读**就是新值（读到 30 = HOT_READ_INVALIDATORS 少登记这一行）');
  assert.equal(pool.queryCount, afterSave + 1, '这次读必须真的再发一次 SQL（命中旧缓存就是假绿）');

  const afterSecond = pool.queryCount;
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }), 7);
  assert.equal(pool.queryCount, afterSecond, '失效后那一读已把新值填回缓存');

  // 写侧收 **0**（管理台要能把「关掉清理」写回去），并且 0 也要立刻生效。
  const off = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 0, log: silentLog,
  });
  assert.equal(off.value, 0, 'validate 的下界是 0：不许写成 1（那会让「关掉清理」存不进去）');
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }), 0, '写 0 之后下一次读就是 0（不是缓存里的 7）');

  // 反向：保存**另一格**旋钮不许把这一格的缓存抹掉（各格各一份；红 = 工厂里共享了槽）。
  await saveRuntimeSetting({
    pool, actorId: ACTOR, key: SESSION_TTL_KEY, value: 3600, log: silentLog,
  });
  const afterTtlSave = pool.queryCount;
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }), 0);
  assert.equal(pool.queryCount, afterTtlSave,
    '保存 TTL 之后本格仍应**命中缓存**（+1 = 工厂里两格共用了缓存，TTL 的失效把本格也抹了）');
  invalidateWorkspaceRetentionCache();
  invalidateSessionTtlCache();
});

test('RS-26 第二格并发：冷缓存四路只发一条 SQL，另一池自己发，合并后照常回填缓存', async () => {
  invalidateWorkspaceRetentionCache();
  const pool = new GatingRuntimePool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 14 }] });
  let release;
  pool.gate = new Promise((resolve) => { release = () => resolve(); });

  const four = Array.from({ length: 4 }, () => readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }));
  await tick();
  assert.equal(pool.queryCount, 1,
    `四路并发必须合并成 **1 条** SQL（实发 ${pool.queryCount} 条 = 没有 in-flight 合并）`);

  const other = ttlPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 21 }] });
  assert.equal(await readWorkspaceRetentionDays({
    pool: other, config: CFG, env: {}, log: silentLog,
  }), 21, 'B 池不许蹭 A 池在飞那一趟');

  release();
  assert.deepEqual(await Promise.all(four), [14, 14, 14, 14], '四路必须拿到同一趟的同一个值');
  assert.equal(pool.queryCount, 1, '合并之后仍然只有一条 SQL（不许补发）');
  assert.equal(await readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, log: silentLog,
  }), 14);
  assert.equal(pool.queryCount, 1, '在飞那趟必须照常回填缓存');
  invalidateWorkspaceRetentionCache();
});

test('RS-26b 第二格在飞那趟失败 ⇒ 清槽；在飞期间保存 ⇒ 也清槽（两条都不许把读钉死）', async () => {
  invalidateWorkspaceRetentionCache();
  const pool = flakyPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 14 }] });
  let clock = 3_000_000;
  const read = () => readWorkspaceRetentionDays({
    pool, config: CFG, env: {}, now: () => clock, log: silentLog,
  });

  // ① 第一趟 DB 抛 ⇒ 读侧照旧给回落值（绝不抛），缓存里钉的是回落值。
  assert.equal(await read(), 30, '失败那趟也要给答案（抛了就是 offboarding 循环停摆）');
  assert.equal(pool.queryCount, 1);

  // ② DB 恢复 + TTL 到点 ⇒ 必须重发 SQL 读到库里的值（复用已落定那一趟 = 失败没清槽）。
  pool.broken = false;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await read(), 14, '恢复后必须读到**库里**的值，不是被钉住的 30');
  assert.equal(pool.queryCount, 2, '必须重新发 SQL（失败路径没清槽就红在这里）');

  // ③ 在飞那趟**挂掉**时挤进来的共享者：不许抛、不许自己再发一条，槽也不许留下。
  invalidateWorkspaceRetentionCache();
  const gate = new GatingRuntimePool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 14 }] });
  let release;
  gate.gate = new Promise((resolve) => { release = () => resolve(); });
  gate.releaseThrows = true;
  const first = readWorkspaceRetentionDays({
    pool: gate, config: CFG, env: {}, now: () => clock, log: silentLog,
  });
  await tick();
  const second = readWorkspaceRetentionDays({
    pool: gate, config: CFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(gate.queryCount, 1, '第二路必须复用那一趟');
  release();
  assert.equal(await first, 30, '那一趟挂了 ⇒ 发起方按回落给答案');
  assert.equal(await second, 30, '共享者也按回落给答案（共享 rejected promise 不许把读弄抛）');
  gate.gate = null;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await readWorkspaceRetentionDays({
    pool: gate, config: CFG, env: {}, now: () => clock, log: silentLog,
  }), 14, '失败落定后槽必须空着 ⇒ 下一次重新发读');

  // ④ 在飞期间**保存**（真写路径 ⇒ 经 `HOT_READ_INVALIDATORS` 失效并清槽）。
  invalidateWorkspaceRetentionCache();
  const g2 = new GatingRuntimePool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 60 }] });
  let release2;
  g2.gate = new Promise((resolve) => { release2 = () => resolve(); });
  const inFlight = readWorkspaceRetentionDays({
    pool: g2, config: CFG, env: {}, now: () => clock, log: silentLog,
  });
  await tick();
  const saved = await saveRuntimeSetting({
    pool: g2, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 90, log: silentLog,
  });
  assert.equal(saved.value, 90, '写路径真的把库里改成了 90');
  const afterSave = g2.queryCount;

  // 失效之后、放行**之前**发起下一次读：那一刻槽必须已经是空的，它只能自己发一条。
  const nextRead = readWorkspaceRetentionDays({
    pool: g2, config: CFG, env: {}, now: () => clock, log: silentLog,
  });
  release2();
  assert.equal(await inFlight, 60, '在飞那一趟拿的是它发起那一刻的库（不是 PUT 之后的值）');
  assert.equal(await nextRead, 90,
    'PUT 完的下一次读必须是新值（拿到 60 = 复用了 PUT 之前就发起的那一趟 ⇒ 失效器没清槽）');
  assert.equal(g2.queryCount, afterSave + 1,
    `下一次读必须真的重发一条（实发 ${g2.queryCount - afterSave} 条）`);
  invalidateWorkspaceRetentionCache();
});

test('RS-27 第二格 env 也过 registry 那套闸 + 一次热读最多一条 warn', async () => {
  const BAD = [
    ['上界外', '4000', 'retention_days_out_of_range'],
    ['小数', '7.5', 'not_a_retention_days'],
    ['压根不是数', 'abc', 'not_a_retention_days'],
    ['科学计数', '1e3', 'not_a_retention_days'],
  ];
  for (const [label, raw, reason] of BAD) {
    // `config.js` 走通用 `nonNegativeIntEnv`（`Number()` 语义）⇒ `1e3` 它照样收成 1000。
    // 这一格钉的正是「config 收下了，但运行时那一层不认」（RS-21 同形）。
    const cfg = loadConfig({ COOKIE_PROFILE: 'dev-http', ERIX_WORKSPACE_RETENTION_DAYS: raw });
    const env = { ERIX_WORKSPACE_RETENTION_DAYS: raw };
    invalidateWorkspaceRetentionCache();
    const hotLog = collectingLog();
    const hot = await readWorkspaceRetentionDays({
      pool: ttlPool(), config: cfg, env, log: hotLog,
    });
    assert.equal(hot, WORKSPACE_RETENTION_DEFAULT_DAYS,
      `${label}：env=${raw} 过不了闸 ⇒ 必须回落默认 0（实得 ${hot}）`);
    const named = hotLog.seen.warn.filter((m) => m.includes(WORKSPACE_RETENTION_KEY)
      && m.includes('ERIX_WORKSPACE_RETENTION_DAYS'));
    assert.equal(named.length, 1,
      `坏 env 值必须点名 warn 一次（key + env 名），实得 ${JSON.stringify(hotLog.seen.warn)}`);
    assert.match(named[0], new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'warn 要带上那个坏值本身');
    assert.match(named[0], new RegExp(reason), 'warn 要带上被拒的理由');
  }

  // 合法值照收，且不 warn：`0` 也在这一列（它是**显式关掉**，不是「没配」）。
  for (const raw of ['0', '14', '3650']) {
    invalidateWorkspaceRetentionCache();
    const log = collectingLog();
    const cfg = loadConfig({ COOKIE_PROFILE: 'dev-http', ERIX_WORKSPACE_RETENTION_DAYS: raw });
    assert.equal(await readWorkspaceRetentionDays({
      pool: ttlPool(), config: cfg, env: { ERIX_WORKSPACE_RETENTION_DAYS: raw }, log,
    }), Number(raw), `env ${raw} 必须照收`);
    assert.deepEqual(log.seen.warn, [], `合法值不许 warn（实得 ${JSON.stringify(log.seen.warn)}）`);
  }

  // 来源如实：compose 的 `ERIX_WORKSPACE_RETENTION_DAYS: ${...:-0}` 在真机上**永远会把这个键具象出来**
  //（没配也是字符串 `"0"`）⇒ 热读与管理台报 `source=env` 是真话；而 `env` 里压根没这个键时
  //（本机直跑、手递 config）必须报 `default`，不许拿「config 里有 0」当 env。
  invalidateWorkspaceRetentionCache();
  const zeroEnvCfg = loadConfig({
    COOKIE_PROFILE: 'dev-http', ERIX_WORKSPACE_RETENTION_DAYS: '0',
  });
  const zeroList = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: zeroEnvCfg,
    env: { ERIX_WORKSPACE_RETENTION_DAYS: '0' }, log: silentLog,
  });
  const zeroItem = zeroList.items.find((i) => i.key === WORKSPACE_RETENTION_KEY);
  assert.equal(zeroItem.value, 0, '显式写了 0 ⇒ 值就是 0（不许因为「等于默认」就被当成没配）');
  assert.equal(zeroItem.source, 'env', '显式写了 0 ⇒ 来源是 env（#485 的口径：判据是「显式写了没有」）');
  invalidateWorkspaceRetentionCache();
  const bareList = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  });
  assert.equal(bareList.items.find((i) => i.key === WORKSPACE_RETENTION_KEY).source, 'default',
    '压根没配 ⇒ 管理台不许说「env 配的」');

  // ⚠ 这一格钉的是 `configTierSource` 在 P3 第一批的**收窄**：条目没有 `<configPath>Source` 标注、
  //   而 `config` 里那个值又恰好**等于 registry 默认** ⇒ 不许报 `env`。旧口径（「config 里有值就算
  //   env」）在这一格永远是假话：`loadConfig` 无论有没有配都会给 `workspaceRetentionDays` 写个数。
  const bareZero = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: { workspaceRetentionDays: 0 }, env: {}, log: silentLog,
  });
  assert.equal(bareZero.items.find((i) => i.key === WORKSPACE_RETENTION_KEY).source, 'default',
    '值等于默认 ⇒ 分不清就不声称是 env 配的（宁可少报一档）');
  // 收窄不等于一律降 default：值与默认不同 ⇒ 确实有人给了那一档，仍报 env。
  const notDefault = await listRuntimeSettingsAdmin({
    pool: ttlPool(), config: { workspaceRetentionDays: 14 }, env: {}, log: silentLog,
  });
  assert.equal(notDefault.items.find((i) => i.key === WORKSPACE_RETENTION_KEY).source, 'env',
    '值与默认不同 ⇒ 不许被收窄误伤成 default');

  // 管理台报的来源必须与热读真正用的那个数是同一套（RS-21 LOW③ 同口径）。
  invalidateWorkspaceRetentionCache();
  const badListLog = collectingLog();
  const badList = await listRuntimeSettingsAdmin({
    pool: ttlPool(),
    config: loadConfig({ COOKIE_PROFILE: 'dev-http', ERIX_WORKSPACE_RETENTION_DAYS: '1e3' }),
    env: { ERIX_WORKSPACE_RETENTION_DAYS: '1e3' }, log: badListLog,
  });
  const badItem = badList.items.find((i) => i.key === WORKSPACE_RETENTION_KEY);
  assert.equal(badItem.value, 0, '坏 env ⇒ 界面显示默认 0，不是显示那个不会生效的 1000');
  assert.equal(badItem.source, 'default');
  assert.ok(badListLog.seen.warn.some((m) => m.includes('ERIX_WORKSPACE_RETENTION_DAYS')),
    '界面这条路也要点名 warn（不能只在热读那条路上说）');

  // 一次热读最多一条 warn：DB 抖动**叠加**坏 env ⇒ 一条里同时说清两件事（RS-22 同形）。
  invalidateWorkspaceRetentionCache();
  const bothLog = collectingLog();
  const dead = flakyPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 14 }] });
  assert.equal(await readWorkspaceRetentionDays({
    pool: dead, config: { workspaceRetentionDays: 4000, workspaceRetentionDaysSource: 'env' },
    env: {}, log: bothLog,
  }), 0);
  assert.equal(dead.queryCount, 1, '那一趟必须真的发过读');
  assert.equal(bothLog.seen.warn.length, 1,
    `同一次热读**最多一条** warn（实得 ${bothLog.seen.warn.length} 条：${JSON.stringify(bothLog.seen.warn)}）`);
  assert.match(bothLog.seen.warn[0], /42P01/, '一条里要带 DB 侧原因');
  assert.match(bothLog.seen.warn[0], /retention_days_out_of_range/, '一条里要带 env 侧理由');
  assert.match(bothLog.seen.warn[0], /同时撞上有/, '两件事 ⇒ 走合并那条文案');

  // 只有一件事时**原文照播**，不许被合并文案改形。
  invalidateWorkspaceRetentionCache();
  const envOnly = collectingLog();
  assert.equal(await readWorkspaceRetentionDays({
    pool: ttlPool(), config: { workspaceRetentionDays: 4000, workspaceRetentionDaysSource: 'env' },
    env: {}, log: envOnly,
  }), 0);
  assert.equal(envOnly.seen.warn.length, 1);
  assert.doesNotMatch(envOnly.seen.warn[0], /同时撞上有/, '单件事不许被改形');

  // 预算是**每一趟**：缓存到点的下一趟照样再说一次（故障不许被静音）。
  invalidateWorkspaceRetentionCache();
  const twice = collectingLog();
  const stillBroken = flakyPool({ rows: [{ key: WORKSPACE_RETENTION_KEY, value: 14 }] });
  let clock = 9_000_000;
  const readAgain = () => readWorkspaceRetentionDays({
    pool: stillBroken, config: CFG, env: {}, now: () => clock, log: twice,
  });
  assert.equal(await readAgain(), 30);
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await readAgain(), 30);
  assert.equal(stillBroken.queryCount, 2, '第二趟必须真的重新发读');
  assert.equal(twice.seen.warn.length, 2, `两趟各一条（实得 ${twice.seen.warn.length}）`);
  invalidateWorkspaceRetentionCache();
});

test('RS-28 真库那一腿（第二格）：写 7 ⇒ 热读 7、不等 5 秒；删行 ⇒ 回落 env（无 PG 则 skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const CONFIG = { workspaceRetentionDays: 30, workspaceRetentionDaysSource: 'env' };
      invalidateWorkspaceRetentionCache();
      // 真库前置：`audit_log.actor_id` 有 FK ⇒ 要落审计就得先有这个人（RS-17 真跑才红出来的那一格）。
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-p3-actor'],
      );

      // 库里没行 ⇒ env 那一档。
      assert.equal(await readWorkspaceRetentionDays({ pool, config: CONFIG, log: pgSilent }), 30);

      // 真库保存 7 ⇒ 同进程下一次读立刻是 7（写路径失效 + 真库整表读）。
      const saved = await saveRuntimeSetting({
        pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 7, log: pgSilent,
      });
      assert.equal(saved.value, 7);
      assert.equal(saved.updatedBy, ACTOR);
      assert.equal(await readWorkspaceRetentionDays({ pool, config: CONFIG, log: pgSilent }), 7,
        '真库上「保存完下一拍就用新值」必须是事实（假库那条只判形状）');

      // **0** 也能存能读（这一格的关键有效值；jsonb 的 0 回读成 JS number 0）。
      await saveRuntimeSetting({
        pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 0, log: pgSilent,
      });
      assert.equal(await readWorkspaceRetentionDays({ pool, config: CONFIG, log: pgSilent }), 0,
        'jsonb 的 0 回读成 0，不许被当成「库里没值」');

      // 管理台：第二格报 source=db（第一格的 source 不许带它）。
      const list = await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent });
      const item = list.items.find((i) => i.key === WORKSPACE_RETENTION_KEY);
      assert.equal(item.source, 'db');
      assert.equal(item.value, 0);
      assert.equal(item.updatedBy, ACTOR);

      // 手工删行 ⇒ 回到 env 那一档（30），并且不抛。
      await pool.query('DELETE FROM runtime_settings WHERE key = $1', [WORKSPACE_RETENTION_KEY]);
      invalidateWorkspaceRetentionCache();
      assert.equal(await readWorkspaceRetentionDays({ pool, config: CONFIG, log: pgSilent }), 30);

      // 手工写一个绕过写侧闸的坏行 ⇒ 读侧回落 + 绝不抛（口径 2 在真库上算一次）。
      await pool.query(
        `INSERT INTO runtime_settings (key, value) VALUES ($1, $2::jsonb)`,
        [WORKSPACE_RETENTION_KEY, '"1e3"'],
      );
      invalidateWorkspaceRetentionCache();
      assert.equal(await readWorkspaceRetentionDays({ pool, config: CONFIG, log: pgSilent }), 30,
        '手工写的坏值 ⇒ 回落 env，不抛');
      invalidateWorkspaceRetentionCache();
    });
  });

// ---------------------------------------------------------------------------
// #677 P3 收尾批：把「`0` 的语义」这件事的**另一半**钉住 —— 运维在界面上看得见那句人话，
// 而那句话在文档里有对应的契约（口径见 docs/api/portal.md §4.21「`0` 的语义」那一小节）。
//   RS-29 registry 的 `hint` + DTO 只在登记了的那格带它（GET 与 PUT 两路都要带）。
//   RS-30 文档契约在场，且它点名的三条判据真的存在（契约不许空指一个不存在的判据）。
// ---------------------------------------------------------------------------

test('RS-29 第二格的 hint：registry 登记了才进 DTO，没登记的那格连键都没有', async () => {
  const entry = RUNTIME_SETTING_REGISTRY[WORKSPACE_RETENTION_KEY];
  assert.equal(typeof entry.hint, 'string', '这一格必须登记 hint（0 的边界不写在行面上就会被误用）');
  assert.ok(entry.hint.length > 0 && entry.hint.length <= 120,
    `hint 是界面里的一行小字：实得 ${entry.hint.length} 字（太长 = 页面里变成一段）`);
  assert.match(entry.hint, /不会取消已排定的删除/,
    'hint 必须点名那个反直觉的边界（这句与 §4.21 那句是同一件事的两种说法，RS-30 钉它们不漂）');
  assert.match(entry.hint, /^0/, '这一格最常被误读的就是 0 那一档 ⇒ hint 必须从 0 说起');

  // GET 两格：登记了的那格原样带出，没登记的那格**不许**出现这个键（缺席 ≠ null ≠ 空串）。
  const cfg = { workspaceRetentionDays: 30, workspaceRetentionDaysSource: 'env' };
  const list = await listRuntimeSettingsAdmin({ pool: ttlPool(), config: cfg, env: {}, log: silentLog });
  assert.equal(list.items.length, 12);
  const retItem = list.items.find((i) => i.key === WORKSPACE_RETENTION_KEY);
  assert.equal(retItem.hint, WORKSPACE_RETENTION_HINT,
    'DTO 必须逐字透出 registry 那句话（前端自己另写一份 = 第二份真相）');
  assert.equal(Object.hasOwn(list.items[0], 'hint'), false,
    'session.ttl_seconds 没登记 hint ⇒ 这个键必须缺席（RS-16 那句「一项就是那八个键」也靠这一半成立）');
  // 第三格也登记了 hint ⇒ DTO 必须逐字透出（否则管理台看不到范围提示）。
  assert.equal(list.items.find((i) => i.key === 'preview.ticket_ttl_seconds').hint,
    '一次预览票从签出到过期的秒数；1..3600（默认 60）');
  // 第四格也登记了 hint ⇒ DTO 逐字透出（防抖阈值的 1..100 不写在行面上会被误填）。
  // 文案本身以 registry 常量为真相（不在判据里抄一份，否则改文案就要改两处）；
  // #710 LOW① 那句「上界不是硬关闭」就在文案里 ⇒ 下面两行钉它不许退回去。
  const atHint = list.items.find((i) => i.key === AUTO_TITLE_MIN_NEW_KEY).hint;
  assert.equal(atHint, AUTO_TITLE_MIN_NEW_HINT, 'DTO 必须逐字透出 registry 那句 hint');
  assert.match(atHint, /1\.\.100/, 'hint 必须带值域（界面不写就会被误填 0 / 1e2）');
  assert.match(atHint, /不是硬关闭/, 'hint 必须带上「上界不是硬关闭」（#710 LOW① 的口径）');
  assert.ok(atHint.length <= 120, `hint 是界面一行小字：实得 ${atHint.length} 字`);

  // 第五格也登记了 hint ⇒ DTO 逐字透出（预览会话 TTL 的 60..86400 不写在行面上会被误填）。
  const pstHint = list.items.find((i) => i.key === 'preview.session_ttl_seconds').hint;
  assert.equal(pstHint, PREVIEW_SESSION_TTL_HINT, 'DTO 必须逐字透出 registry 那句 hint');
  assert.match(pstHint, /60\.\.86400/, 'hint 必须带值域（界面不写就会被误填 0 / 1e3）');
  assert.ok(pstHint.length <= 120, `hint 是界面一行小字：实得 ${pstHint.length} 字`);

  // 回落那一档也带（表不存在时界面更要看得见这句：那一档下 0 同样是「不自动清理」）。
  const dead = await listRuntimeSettingsAdmin({
    pool: ttlPool({ throwOnSelect: Object.assign(
      new Error('relation "runtime_settings" does not exist'), { code: '42P01' }) }),
    config: cfg, log: collectingLog(),
  });
  assert.equal(dead.items.find((i) => i.key === WORKSPACE_RETENTION_KEY).hint, WORKSPACE_RETENTION_HINT,
    '读失败回落那一档也必须带 hint（界面正是要在那时解释 0 是什么意思）');

  // PUT 的 DTO 也带：前端拿响应里那个 item 直接替掉界面上的那一行 ⇒ 漏了它，保存完提示就消失。
  const pool = new FakeRuntimePool({
    returning: {
      key: WORKSPACE_RETENTION_KEY, value: 7,
      updated_at: new Date('2026-11-23T00:00:00.000Z'), updated_by: ACTOR,
    },
  });
  const { item } = await updateRuntimeSettingAdmin({
    pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 7, log: silentLog,
  });
  assert.equal(item.value, 7, '写侧本身不许被 hint 这件事带偏');
  assert.equal(item.hint, WORKSPACE_RETENTION_HINT,
    '保存后的 item 也要带 hint（否则「一保存提示就没了」，而那正是最需要它的时候）');
  assert.equal(Object.hasOwn(item, 'hint'), true);
});

test('RS-30 文档契约在场：§4.21 那一小节 + env 那一行 + 它点名的三条判据真的存在', () => {
  const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
  const envDoc = fs.readFileSync(new URL('../../docs/env.md', import.meta.url), 'utf8');
  const offFile = fs.readFileSync(new URL('./offboarding.test.js', import.meta.url), 'utf8');

  // ① §4.21 里那一小节在，且两个方向都写到了（只写一个方向 = 契约还是半个）。
  const section = apiDoc.slice(
    apiDoc.indexOf('的语义：关掉的是「清理动作」'),
    apiDoc.indexOf('#### 与 §4.15 / §4.19 的关系'),
  );
  assert.ok(section.length > 200, '§4.21 里那一小节被删了或挪走了（切片切出来是空的）');
  assert.match(section, /A 方向/, 'A 方向（0 期间完成离职 ⇒ 不补期限）必须在契约里');
  assert.match(section, /B 方向/, 'B 方向（已过期 ⇒ 改回正数下一拍兑现）必须在契约里');
  assert.match(section, /不重新等 N 天|不重新等 7 天/, 'B 方向那句「不重新等」是不许被改形的口径');
  assert.match(section, /刻意不对称/, '不对称是刻意的 —— 这句没了，下一个人就会「顺手补齐」另一半');
  assert.match(section, /#677 P3⑤[\s\S]*#677 P3⑥/, '契约必须点名判据（否则它是条无法执行的口头口径）');

  // ② 契约点名的那三条判据真的存在（红法：改名/删掉判据 ⇒ 这里红，而不是文档空指）。
  for (const name of ['#677 P3⑤', '#677 P3⑥', '#677 P3⑦']) {
    assert.ok(offFile.includes(name), `契约点名的判据在 offboarding.test.js 里找不到：${name}`);
  }

  // ③ env 那一行同步（运维只看 env 口径表也必须看到「停清理 ≠ 撤销已排期限」），
  //    且它与 registry 的 hint 用的是同一个关键词 ⇒ 两处文案不许各说一套。
  assert.match(envDoc, /关掉清理 ≠ 取消已排定的删除/,
    'docs/env.md 的 ERIX_WORKSPACE_RETENTION_DAYS 行必须同步这一句');
  assert.match(envDoc, /§4\.21/, 'env 那一行要给出契约的落点（否则它只是第二份没有出处的口径）');
  assert.ok(
    WORKSPACE_RETENTION_HINT.includes('不会取消已排定的删除')
      && envDoc.includes('取消已排定的删除') && section.includes('取消已排定的删除'),
    'hint / env 行 / §4.21 三处必须说同一件事（关键词漂开 = 有人在偷偷改其中一处的口径）',
  );
});

// ---------------------------------------------------------------------------
// 9. P3 第二批：第三格真实旋钮 `preview.ticket_ttl_seconds`（#677）。
//   RS-31 解析/校验（严格正整数 + 区间 1..3600）；RS-32 热读三档；RS-33 缓存；
//   RS-34 写后失效（M-2 去登记 ⇒ 红）；RS-35 并发只发一条 SQL；RS-36 在飞失败清槽；
//   RS-37 env 也过闸 + 一次热读最多一条 warn；RS-38 真库腿。
// ⚠ 本节格子共享**模块级**热读缓存/槽 ⇒ 每段前后都 `invalidatePreviewTicketTtlCache()`。
// ---------------------------------------------------------------------------

// env 那一档用 45（与默认 60 不同 ⇒ 能分清「用的到底是 env 还是默认」）。
const PCFG = { previewTicketTtlSeconds: 45, previewTicketTtlSecondsSource: 'env' };

test('RS-31 preview.ticket_ttl_seconds 的解析与校验：严格十进制正整数 + 区间 1..3600', () => {
  assert.equal(PREVIEW_TICKET_TTL_MIN_SECONDS, 1);
  assert.equal(PREVIEW_TICKET_TTL_MAX_SECONDS, 3600, '1 小时');
  assert.equal(PREVIEW_TICKET_TTL_DEFAULT_SECONDS, 60, '与 config.js 同源');
  assert.equal(loadConfig({ MAX_LOGIN_LENGTH: '128' }).previewTicketTtlSeconds,
    PREVIEW_TICKET_TTL_DEFAULT_SECONDS, 'registry 默认必须等于 loadConfig 干净 env 算出的数');

  for (const good of [1, 60, 3600, '1', '60', '3600', '060']) {
    const r = parsePreviewTicketTtlSeconds(good);
    assert.equal(r.ok, true, `${JSON.stringify(good)} 必须收`);
    assert.equal(r.value, Number(good));
  }
  for (const bad of [
    '1e3', ' 60 ', '60s', '', '0x10', '1.5', '6e5', '0', '-1', '-60', '3601', '+5',
    0, -1, 60.5, 3601, Number.NaN, Number.POSITIVE_INFINITY, 1e21,
    true, false, null, undefined, {}, [], ['60'],
  ]) {
    assert.equal(parsePreviewTicketTtlSeconds(bad).ok, false,
      `${JSON.stringify(bad) ?? String(bad)} 必须拒`);
  }
  // 0 是「签出来即过期」的非法值（与保留天数那格的 0-有效相反）；上界外是 out_of_range。
  assert.equal(parsePreviewTicketTtlSeconds(0).reason, 'ticket_ttl_out_of_range',
    '0 是合法数字但区间外 ⇒ out_of_range（不是 not_a_...）');
  assert.equal(parsePreviewTicketTtlSeconds(3601).reason, 'ticket_ttl_out_of_range');
  assert.equal(parsePreviewTicketTtlSeconds('1e3').reason, 'not_a_ticket_ttl_seconds');
  assert.equal(parsePreviewTicketTtlSeconds(' 60 ').reason, 'not_a_ticket_ttl_seconds',
    '带空白的串必须拒（Number() 会收成 60，那是第二套真相）');
  assert.equal(parsePreviewTicketTtlSeconds('+5').ok, false, '带符号的串必须拒');

  for (const good of [1, 60, 3600]) {
    assert.equal(validatePreviewTicketTtlSeconds(good), true, `${good} 必须放行`);
  }
  for (const bad of ['60', '', '3600', 0, -1, 3601, 60.5, true, null, {}, [], Number.NaN]) {
    const why = validatePreviewTicketTtlSeconds(bad);
    assert.notEqual(why, true, `${JSON.stringify(bad) ?? String(bad)} 写侧必须拒`);
    assert.equal(typeof why, 'string', '拒绝必须返回点名的原因字符串');
  }
  // 上界与下界的拒绝要能说清是哪个数（M-3：去掉 validate 上界 ⇒ 这一条红）。
  assert.match(String(validatePreviewTicketTtlSeconds(3601)), /3600/);
  assert.match(String(validatePreviewTicketTtlSeconds(0)), /1/);
});

test('RS-31b 写侧的 1e3 两侧之分：JSON number 1e3 收并规整成 1000（不拒），字符串 "1e3" 仍拒', async () => {
  // 裁定（#709 unproven）：写侧接受**任何合法 JSON number**；科学记数法在 JSON 解析时已塌成普通整数，
  // 故 1e3 与 1000 是同一个值 ⇒ 必须收、库里存的是 1000；只有**字符串** "1e3" 才判非法。
  // （env 侧相反：`PREVIEW_TICKET_TTL_SECONDS=1e3` 过不了 `/^[0-9]+$/` ⇒ 视为没给，见 RS-37 / env.md。）
  // ① parse/validate：number 走 safe-integer 支 ⇒ 收成 1000；string 走正则支 ⇒ 挡掉。
  const num = parsePreviewTicketTtlSeconds(1e3);
  assert.equal(num.ok, true, 'number 1e3（=1000）必须收（写侧接受任何合法 JSON number）');
  assert.equal(num.value, 1000, '1e3 必须规整成 1000（同一个值，不是两套真相）');
  assert.equal(validatePreviewTicketTtlSeconds(1e3), true, 'validate 也放行 number 1e3');
  assert.equal(parsePreviewTicketTtlSeconds('1e3').ok, false, '字符串 "1e3" 必须判非法');
  assert.notEqual(validatePreviewTicketTtlSeconds('1e3'), true, '写侧 validate 必须拒字符串 "1e3"');
  // ② 落库侧：save(value:1e3) 必须真把 1000 写进库（不是原样存 '1e3'，也不是被拒）。
  invalidatePreviewTicketTtlCache();
  const pool = new FakeRuntimePool();
  const saved = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: 1e3, log: silentLog,
  });
  assert.equal(saved.value, 1000, 'DTO 值必须是 1000（RETURNING 真相）');
  assert.equal(pool.storedValue(PREVIEW_TICKET_TTL_KEY), 1000, '库里真的是 1000（不是 1e3 文本）');
  // ③ 落库侧反向：字符串 "1e3" 走 save ⇒ validation_failed（HTTP 400），零 SQL。
  const pool2 = new FakeRuntimePool();
  const err = await saveRuntimeSetting({
    pool: pool2, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: '1e3', log: silentLog,
  }).then(() => null, (e) => e);
  assert.ok(err instanceof RuntimeSettingsError, '字符串 "1e3" 必须抛 RuntimeSettingsError');
  assert.equal(err.code, 'validation_failed', '字符串 "1e3" ⇒ validation_failed（HTTP 400）');
  assert.equal(err.httpStatus, 400, '必须映射成 400');
  assert.equal(pool2.queryCount, 0, '字符串 "1e3" 校验在发 SQL 之前 ⇒ 零 SQL');
  invalidatePreviewTicketTtlCache();
});

test('RS-32 第三格热读三档：DB > env（过闸）> 默认 60；任何一档坏了都绝不抛', async () => {
  invalidatePreviewTicketTtlCache();
  const dbPool = ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: dbPool, config: PCFG, env: {}, log: silentLog,
  }), 30);
  assert.equal(dbPool.queryCount, 1, '确实发了那次读');

  // 库里非法值 ⇒ 回落 env 45，点名 warn 一次。
  invalidatePreviewTicketTtlCache();
  const log = collectingLog();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: '1e3' }] }),
    config: PCFG, env: {}, log,
  }), 45);
  assert.equal(log.seen.warn.length, 1, `恰好一条（实得 ${JSON.stringify(log.seen.warn)}）`);
  assert.match(log.seen.warn[0], new RegExp(PREVIEW_TICKET_TTL_KEY.replace(/\./g, '\\.')),
    'warn 要点名是哪个 key');

  // 库里没行 ⇒ env 45，不 warn。
  invalidatePreviewTicketTtlCache();
  const log2 = collectingLog();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: ttlPool(), config: PCFG, env: {}, log: log2,
  }), 45);
  assert.deepEqual(log2.seen.warn, [], '没有行不是故障，不许刷屏');

  // 表不存在 ⇒ 回落 env，绝不抛。
  invalidatePreviewTicketTtlCache();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) }),
    config: PCFG, env: {}, log: silentLog,
  }), 45);

  // 连 pool 都没有 ⇒ 回落 env，不抛。
  invalidatePreviewTicketTtlCache();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: null, config: PCFG, env: {}, log: silentLog,
  }), 45);

  // 三档全空 ⇒ 默认 60，绝不 undefined（undefined 交给 expires_at 算术就是 NaN）。
  invalidatePreviewTicketTtlCache();
  const none = await readPreviewTicketTtlSeconds({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  });
  assert.equal(none, PREVIEW_TICKET_TTL_DEFAULT_SECONDS);
  assert.notEqual(none, undefined, 'undefined 交给 expires_at 算术就是 NaN');

  // 读挂住 ⇒ 按时给答案（timeoutMs 注入）。
  invalidatePreviewTicketTtlCache();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: ttlPool({ hang: true }), config: PCFG, env: {}, log: silentLog, timeoutMs: 30,
  }), 45);

  // env 越界（config.js 的 intEnv 收得下 4000，registry 不收）⇒ 回落默认 60，点名档与理由。
  invalidatePreviewTicketTtlCache();
  const overLog = collectingLog();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: ttlPool(),
    config: { previewTicketTtlSeconds: 4000, previewTicketTtlSecondsSource: 'env' },
    env: {}, log: overLog,
  }), 60, '越界 ⇒ 回落默认 60（不是 4000，也不是 undefined）');
  assert.ok(overLog.seen.warn.some((m) => m.includes('config.previewTicketTtlSeconds')
    && m.includes('ticket_ttl_out_of_range')),
    `要点名是哪一档、为什么（实得 ${JSON.stringify(overLog.seen.warn)}）`);

  // 本格有行不许让另两格凭空读数（同一张表；各格独立）。
  invalidatePreviewTicketTtlCache();
  invalidateWorkspaceRetentionCache();
  const mixed = ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: mixed, config: PCFG, env: {}, log: silentLog,
  }), 30);
  invalidateWorkspaceRetentionCache();
  assert.equal(await readWorkspaceRetentionDays({
    pool: mixed, config: PCFG, env: {}, log: silentLog,
  }), 0, '票那格有行不许让保留天数那格凭空读出一个数');
  invalidatePreviewTicketTtlCache();
  invalidateWorkspaceRetentionCache();
});

test('RS-33 第三格缓存：同池 5s 内命中不发 SQL、过期重读、换池不串、本格不被另两格顶掉',
  async () => {
    invalidatePreviewTicketTtlCache();
    const pool = ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
    let clock = 4_000_000;
    const now = () => clock;
    const read = () => readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, now, log: silentLog,
    });
    assert.equal(await read(), 30);
    assert.equal(pool.queryCount, 1);
    clock += HOT_READ_CACHE_TTL_MS;
    assert.equal(await read(), 30);
    assert.equal(pool.queryCount, 1, '5s 内命中 ⇒ 不发第二条 SQL');
    pool.rows = [{ key: PREVIEW_TICKET_TTL_KEY, value: 15 }];
    clock += 1;
    assert.equal(await read(), 15, '过期后必须重读');
    assert.equal(pool.queryCount, 2);
    const other = ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 20 }] });
    assert.equal(await readPreviewTicketTtlSeconds({
      pool: other, config: PCFG, env: {}, now, log: silentLog,
    }), 20, 'B 池必须自己读');
    assert.equal(other.queryCount, 1);
    // 本格缓存不被 TTL/保留天数的读顶掉（各格各一份工厂状态）。
    assert.equal(await read(), 15);
    const before = pool.queryCount;
    invalidateSessionTtlCache();
    await readSessionTtlSeconds({ pool, config: PCFG, env: {}, now, log: silentLog });
    assert.equal(await read(), 15);
    assert.equal(pool.queryCount, before + 1,
      '只有 TTL 那格该发 SQL（+2 = 本格缓存被 TTL 顶掉了）');
    invalidatePreviewTicketTtlCache();
  });

test('RS-34 第三格保存后立即失效：PUT 完下一次读就是新值（M-2 去登记 ⇒ 这一格红）',
  async () => {
    invalidatePreviewTicketTtlCache();
    const pool = new FakeRuntimePool();
    // 先读一次：库里没行 ⇒ env 那一档 45 被缓存住。
    assert.equal(await readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    }), 45);
    const saved = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: 30, log: silentLog,
    });
    assert.equal(saved.value, 30);
    assert.equal(pool.storedValue(PREVIEW_TICKET_TTL_KEY), 30, '库里真的是新值');
    const afterSave = pool.queryCount;
    const next = await readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    });
    assert.equal(next, 30, '保存后下一次读就是新值（读到 45 = 失效钩子少登记）');
    assert.equal(pool.queryCount, afterSave + 1, '这次读必须真的再发一次 SQL');
    // 失效只此一次：紧接着的第二次读重新命中缓存。
    const afterSecond = pool.queryCount;
    assert.equal(await readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    }), 30);
    assert.equal(pool.queryCount, afterSecond, '失效后那一读已把新值填回缓存');
    // 反向：保存另一格不许抹掉本格缓存。
    await saveRuntimeSetting({
      pool, actorId: ACTOR, key: WORKSPACE_RETENTION_KEY, value: 7, log: silentLog,
    });
    const afterOtherSave = pool.queryCount;
    assert.equal(await readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    }), 30);
    assert.equal(pool.queryCount, afterOtherSave, '保存保留天数之后本格仍应命中缓存');
    invalidatePreviewTicketTtlCache();
    invalidateWorkspaceRetentionCache();
  });

test('RS-35 第三格并发：冷缓存四路只发一条 SQL，另一池自己发，合并后照常回填缓存',
  async () => {
    invalidatePreviewTicketTtlCache();
    const pool = new GatingRuntimePool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
    let release;
    pool.gate = new Promise((resolve) => { release = () => resolve(); });
    const four = Array.from({ length: 4 }, () => readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    }));
    await tick();
    assert.equal(pool.queryCount, 1,
      `四路并发必须合并成 **1 条** SQL（实发 ${pool.queryCount} 条）`);
    const other = ttlPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 20 }] });
    assert.equal(await readPreviewTicketTtlSeconds({
      pool: other, config: PCFG, env: {}, log: silentLog,
    }), 20, 'B 池不许蹭 A 池在飞那一趟');
    release();
    assert.deepEqual(await Promise.all(four), [30, 30, 30, 30]);
    assert.equal(pool.queryCount, 1, '合并之后仍只有一条 SQL');
    assert.equal(await readPreviewTicketTtlSeconds({
      pool, config: PCFG, env: {}, log: silentLog,
    }), 30);
    assert.equal(pool.queryCount, 1, '在飞那趟必须照常回填缓存');
    invalidatePreviewTicketTtlCache();
  });

test('RS-36 第三格在飞那趟失败 ⇒ 清槽（不许把之后所有读钉在失败那一趟上）', async () => {
  invalidatePreviewTicketTtlCache();
  const pool = flakyPool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
  let clock = 5_000_000;
  const read = () => readPreviewTicketTtlSeconds({
    pool, config: PCFG, env: {}, now: () => clock, log: silentLog,
  });
  // ① 第一趟 DB 抛 ⇒ 回落 env 45，绝不抛。
  assert.equal(await read(), 45, '失败那趟也要给答案（抛了就是签票请求 500）');
  assert.equal(pool.queryCount, 1);
  // ② DB 恢复 + TTL 到点 ⇒ 必须重发 SQL 读到库里的 30。
  pool.broken = false;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await read(), 30, '恢复后必须读到库里的值，不是被钉住的 45');
  assert.equal(pool.queryCount, 2, '必须重新发 SQL（失败路径没清槽就红在这里）');
  // ③ 在飞那趟挂掉时挤进来的共享者：不许抛、不许自己再发、槽不留。
  invalidatePreviewTicketTtlCache();
  const gate = new GatingRuntimePool({ rows: [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }] });
  let release;
  gate.gate = new Promise((resolve) => { release = () => resolve(); });
  gate.releaseThrows = true;
  const first = readPreviewTicketTtlSeconds({
    pool: gate, config: PCFG, env: {}, now: () => clock, log: silentLog,
  });
  await tick();
  const second = readPreviewTicketTtlSeconds({
    pool: gate, config: PCFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(gate.queryCount, 1, '第二路必须复用那一趟');
  release();
  assert.equal(await first, 45, '那一趟挂了 ⇒ 发起方按回落给答案');
  assert.equal(await second, 45, '共享者也按回落给答案');
  gate.gate = null;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: gate, config: PCFG, env: {}, now: () => clock, log: silentLog,
  }), 30, '挂掉之后必须重新发读拿到真值');
  invalidatePreviewTicketTtlCache();
});

test('RS-37 第三格 env 也过 registry 那套闸 + 一次热读最多一条 warn', async () => {
  const BAD = [
    ['上界外', '4000', 'ticket_ttl_out_of_range'],
    ['下界外', '0', 'ticket_ttl_out_of_range'],
    ['小数', '7.5', 'not_a_ticket_ttl_seconds'],
    ['科学计数', '1e3', 'not_a_ticket_ttl_seconds'],
    ['压根不是数', 'abc', 'not_a_ticket_ttl_seconds'],
  ];
  for (const [label, raw, reason] of BAD) {
    const cfg = loadConfig({ COOKIE_PROFILE: 'dev-http', PREVIEW_TICKET_TTL_SECONDS: raw });
    const env = { PREVIEW_TICKET_TTL_SECONDS: raw };
    invalidatePreviewTicketTtlCache();
    const hotLog = collectingLog();
    const hot = await readPreviewTicketTtlSeconds({
      pool: ttlPool(), config: cfg, env, log: hotLog,
    });
    assert.equal(hot, PREVIEW_TICKET_TTL_DEFAULT_SECONDS,
      `${label}：env=${raw} 过不了闸 ⇒ 回落默认 60（实得 ${hot}）`);
    const named = hotLog.seen.warn.filter((m) => m.includes(PREVIEW_TICKET_TTL_KEY)
      && m.includes('PREVIEW_TICKET_TTL_SECONDS'));
    assert.equal(named.length, 1,
      `坏 env 值必须点名 warn 一次，实得 ${JSON.stringify(hotLog.seen.warn)}`);
    assert.match(named[0], new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'warn 要带上那个坏值本身');
    assert.match(named[0], new RegExp(reason), 'warn 要带上被拒的理由');
  }
  for (const raw of ['1', '30', '3600']) {
    invalidatePreviewTicketTtlCache();
    const log = collectingLog();
    const cfg = loadConfig({ COOKIE_PROFILE: 'dev-http', PREVIEW_TICKET_TTL_SECONDS: raw });
    assert.equal(await readPreviewTicketTtlSeconds({
      pool: ttlPool(), config: cfg, env: { PREVIEW_TICKET_TTL_SECONDS: raw }, log,
    }), Number(raw), `env ${raw} 必须照收`);
    assert.deepEqual(log.seen.warn, [], `合法值不许 warn（实得 ${JSON.stringify(log.seen.warn)}）`);
  }
  invalidatePreviewTicketTtlCache();
});

test('RS-38 真库那一腿（第三格）：写 30 ⇒ 热读 30、不等 5 秒；删行 ⇒ 回落 env（无 PG skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const CONFIG = { previewTicketTtlSeconds: 45, previewTicketTtlSecondsSource: 'env' };
      invalidatePreviewTicketTtlCache();
      // 真库前置：audit_log.actor_id 有 FK ⇒ 先插这个人。
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-p3b2-actor'],
      );
      // 库里没行 ⇒ env 那一档 45。
      assert.equal(await readPreviewTicketTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 45);
      // 真库保存 30 ⇒ 同进程下一次读立刻 30（写路径失效 + 真库整表读）。
      const saved = await saveRuntimeSetting({
        pool, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: 30, log: pgSilent,
      });
      assert.equal(saved.value, 30);
      assert.equal(saved.updatedBy, ACTOR);
      assert.equal(await readPreviewTicketTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 30,
        '真库上「保存完下一拍就用新值」必须是事实');
      // 管理台：第三格报 source=db。
      const list = await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent });
      const item = list.items.find((i) => i.key === PREVIEW_TICKET_TTL_KEY);
      assert.equal(item.source, 'db');
      assert.equal(item.value, 30);
      assert.equal(item.updatedBy, ACTOR);
      // 手工删行 ⇒ 回到 env 那一档 45。
      await pool.query('DELETE FROM runtime_settings WHERE key = $1', [PREVIEW_TICKET_TTL_KEY]);
      invalidatePreviewTicketTtlCache();
      assert.equal(await readPreviewTicketTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 45);
      // 手工写坏行 ⇒ 回落 env，不抛。
      await pool.query(
        `INSERT INTO runtime_settings (key, value) VALUES ($1, $2::jsonb)`,
        [PREVIEW_TICKET_TTL_KEY, '"1e3"'],
      );
      invalidatePreviewTicketTtlCache();
      assert.equal(await readPreviewTicketTtlSeconds({ pool, config: CONFIG, log: pgSilent }), 45,
        '手工写的坏值 ⇒ 回落 env，不抛');
      invalidatePreviewTicketTtlCache();
    });
  });

// ---------------------------------------------------------------------------
// #709 MED①：启动时 DB 覆盖后的 effectiveConfig 不能被骗成「env 回退」
// ---------------------------------------------------------------------------

// 造一个「启动时从 DB 覆盖进来」的 effectiveConfig：DB 有合法行 ⇒ applyRuntimeOverrides
// 必须把那一格标成 `<path>Source='db'`（MED① 根因：以前只改值不标来源）。
function bootOverlaidConfig(rows, base) {
  return applyRuntimeOverrides(base, {
    pool: ttlPool({ rows }), env: {}, log: silentLog,
  });
}

test('#709 MED① applyRuntimeOverrides 把 DB 覆盖进来的那一格标成 <path>Source=db', async () => {
  const boot = await bootOverlaidConfig(
    [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }],
    { previewTicketTtlSeconds: 60, sessionTtlSeconds: 604800, workspaceRetentionDays: 0 },
  );
  assert.equal(boot.previewTicketTtlSeconds, 30, 'DB 行压过默认 60');
  assert.equal(boot.previewTicketTtlSecondsSource, 'db',
    'MED① 根因：从 DB 覆盖进来的值必须标 db（旧实现不标 ⇒ 热读器回落时只能凭值猜 env）');
  // 没走 DB 的那两格（env/默认）不许被误标成 db。
  assert.notEqual(boot.sessionTtlSecondsSource, 'db', '未走 DB 的那格不盖 db 标注');
  assert.notEqual(boot.workspaceRetentionDaysSource, 'db', '未走 DB 的那格不盖 db 标注');
});

test('#709 MED① DB 读失败⇒热读用启动时 DB 快照且 source 如实报 db + 点名 boot snapshot',
  async () => {
    const boot = await bootOverlaidConfig(
      [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }],
      { previewTicketTtlSeconds: 60 },
    );
    const dead = ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) });
    // ① 热读回落值：DB 挂了仍用启动时的 DB 快照 30（而不是 env/默认的 60）。
    invalidatePreviewTicketTtlCache();
    assert.equal(await readPreviewTicketTtlSeconds({ pool: dead, config: boot, env: {}, log: silentLog }),
      30, 'DB 读失败 ⇒ 继续用启动时的 DB 快照 30（不谎改成 env/默认 60）');
    // ② 报告面（管理台 GET）：这一档 source 必须如实报 db（不是 env）+ reason 点名 boot snapshot。
    const adminLog = collectingLog();
    const { items } = await listRuntimeSettingsAdmin({ pool: dead, config: boot, env: {}, log: adminLog });
    const pv = items.find((i) => i.key === PREVIEW_TICKET_TTL_KEY);
    assert.equal(pv.source, 'db', 'MED①：DB 读失败用的是旧 DB 值 ⇒ 不许谎报 source=env');
    assert.notEqual(pv.source, 'env', '旧行为就是这里谎报 env（M-1 改回一律 env ⇒ 这一条红）');
    assert.equal(pv.reason, 'db_read_failed_using_boot_snapshot',
      'source=db 时 reason 必须点明用的是启动时快照');
    assert.equal(pv.value, 30);
    assert.ok(adminLog.seen.warn.some((m) => m.includes(PREVIEW_TICKET_TTL_KEY)
      && /启动时.*快照|boot_snapshot|DB 快照/.test(m)),
      `warn 要说清「DB 读失败、暂用启动时快照」（实得 ${JSON.stringify(adminLog.seen.warn)}）`);
  });

test('#709 MED① 工厂统一：session/workspace/preview 三格 DB 读失败都报 db + boot snapshot',
  async () => {
    const boot = await bootOverlaidConfig(
      [
        { key: SESSION_TTL_KEY, value: 3600 },
        { key: WORKSPACE_RETENTION_KEY, value: 7 },
        { key: PREVIEW_TICKET_TTL_KEY, value: 30 },
      ],
      { sessionTtlSeconds: 604800, workspaceRetentionDays: 0, previewTicketTtlSeconds: 60 },
    );
    for (const path of ['sessionTtlSeconds', 'workspaceRetentionDays', 'previewTicketTtlSeconds']) {
      assert.equal(boot[`${path}Source`], 'db', `${path} 从 DB 覆盖进来必须标 db（工厂同一循环）`);
    }
    const dead = ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) });
    const { items } = await listRuntimeSettingsAdmin({ pool: dead, config: boot, env: {}, log: silentLog });
    for (const key of [SESSION_TTL_KEY, WORKSPACE_RETENTION_KEY, PREVIEW_TICKET_TTL_KEY]) {
      const it = items.find((i) => i.key === key);
      assert.equal(it.source, 'db', `${key}: DB 读失败用旧 DB 快照 ⇒ 如实报 db`);
      assert.equal(it.reason, 'db_read_failed_using_boot_snapshot', `${key}: reason 点名 boot snapshot`);
    }
    // 对照：标 env 的那一格 DB 读失败时仍报 env（没被 over-correct 成 db）。
    const envCfg = { previewTicketTtlSeconds: 45, previewTicketTtlSecondsSource: 'env' };
    const { items: envItems } = await listRuntimeSettingsAdmin({
      pool: dead, config: envCfg, env: {}, log: silentLog,
    });
    const envPv = envItems.find((i) => i.key === PREVIEW_TICKET_TTL_KEY);
    assert.equal(envPv.source, 'env', '标 env 且 DB 读失败 ⇒ 仍报 env（没被改成 db）');
    assert.equal(envPv.reason, 'read_failed', '标 env 那一格的 reason 仍是 read_failed（不是 boot snapshot）');
  });

// ---------------------------------------------------------------------------
// #709b LOW①：「查询成功但没有这一行」不是「读失败」
// ---------------------------------------------------------------------------

test('#709b LOW① 查询成功 + 无那一行 ⇒ reason 不是读失败（no_row_using_boot_snapshot）',
  async () => {
    // 二审 LOW①：`toSettingItem()` 以前只用 `envTier.source === 'db' && !row` 判「启动快照」，
    // 于是「SELECT 成功、表里没有这一行」（**正常状态**：还没人配过）也被说成读失败
    // ⇒ 运维拿着「DB 读失败」去查一根好端端的库。这一格钉两种理由必须可区分。
    // M-1（变异）：把 `no_row` 那一支改回一律 `db_read_failed_using_boot_snapshot` ⇒ ①②③ 红。
    const boot = await bootOverlaidConfig(
      [{ key: PREVIEW_TICKET_TTL_KEY, value: 30 }],   // 启动时 DB 里**有**这行 ⇒ 值被标成 db 快照
      { previewTicketTtlSeconds: 60 },
    );
    // ① 报告面：库里那一行现在没了（SELECT 成功、零行）⇒ DB 通着，只是没人配过。
    const emptyRead = ttlPool({ rows: [] });
    const adminLog = collectingLog();
    const { items } = await listRuntimeSettingsAdmin({
      pool: emptyRead, config: boot, env: {}, log: adminLog,
    });
    const pv = items.find((i) => i.key === PREVIEW_TICKET_TTL_KEY);
    assert.equal(pv.source, 'db', '值仍是启动时的 DB 快照 ⇒ source 仍如实报 db（不是 env）');
    assert.equal(pv.value, 30, '手里那个数仍是启动时快照 30（LOW① 只改理由，不改值）');
    assert.equal(pv.reason, 'no_row_using_boot_snapshot',
      `查询成功 + 无行 ⇒ reason 点名「没这一行」，实得 ${pv.reason}`);
    // ② 反面对：不许再顶着那条「读失败」的理由。
    assert.notEqual(pv.reason, 'db_read_failed_using_boot_snapshot',
      '「查询成功但没有这一行」不许说成「读失败」');
    // ③ warn 跟着分叉：要说「查询成功、表里没有这一行」，不许播故障那条。
    const said = adminLog.seen.warn.filter((m) => m.includes(PREVIEW_TICKET_TTL_KEY));
    assert.ok(said.some((m) => /查询成功、但表里没有这一行|还没有人配过/.test(m)),
      `warn 要说清是「没这一行」而不是故障（实得 ${JSON.stringify(said)}）`);
    assert.ok(!said.some((m) => /读不到 DB 行|DB 恢复前/.test(m)),
      `不许播「DB 读失败」那条故障文案（实得 ${JSON.stringify(said)}）`);
    // ④ 对照：真的读失败（SELECT 抛错）时仍是故障口径 ⇒ 两档不许塌成同一个值。
    const dead = ttlPool({
      throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }),
    });
    const { items: deadItems } = await listRuntimeSettingsAdmin({
      pool: dead, config: boot, env: {}, log: collectingLog(),
    });
    assert.equal(deadItems.find((i) => i.key === PREVIEW_TICKET_TTL_KEY).reason,
      'db_read_failed_using_boot_snapshot', '真读失败仍是 db_read_failed_using_boot_snapshot');
    // ⑤ 对照：没有启动快照那一档（值来自 env）时，查询成功 + 无行仍是既有的 `no_row`（未受影响）。
    const { items: envItems } = await listRuntimeSettingsAdmin({
      pool: emptyRead,
      config: { previewTicketTtlSeconds: 45, previewTicketTtlSecondsSource: 'env' },
      env: {}, log: collectingLog(),
    });
    assert.equal(envItems.find((i) => i.key === PREVIEW_TICKET_TTL_KEY).reason, 'no_row',
      'env 那一档的 reason 逐字不变（LOW① 只动 boot snapshot 那一档的分叉）');
  });

// ---------------------------------------------------------------------------
// 10. P3 第三批：第四格真实旋钮 `session.auto_title_min_new`（#677）。
// ---------------------------------------------------------------------------

// env/config 那一档的固定值：5（与默认 3 拉开距离，才能验「回落用的是哪一档」）。
const ATCFG = { sessionAutoTitleMinNew: 5, sessionAutoTitleMinNewSource: 'env' };

test('RS-40 session.auto_title_min_new 的解析与校验：严格十进制正整数 + 区间 1..100', () => {
  assert.equal(AUTO_TITLE_MIN_NEW_MIN, 1);
  assert.equal(AUTO_TITLE_MIN_NEW_MAX, 100);
  assert.equal(AUTO_TITLE_MIN_NEW_DEFAULT, 3, '与 config.js 同源');
  assert.equal(loadConfig({ MAX_LOGIN_LENGTH: '128' }).sessionAutoTitleMinNew,
    AUTO_TITLE_MIN_NEW_DEFAULT, 'registry 默认必须等于 loadConfig 干净 env 算出的数');

  for (const good of [1, 3, 100, '1', '3', '100', '003']) {
    const r = parseAutoTitleMinNew(good);
    assert.equal(r.ok, true, `${JSON.stringify(good)} 必须收`);
    assert.equal(r.value, Number(good));
  }
  for (const bad of [
    '1e2', ' 3 ', '3x', '', '0x10', '2.5', '6e2', '0', '-1', '-3', '101', '+2',
    0, -1, 2.5, 101, Number.NaN, Number.POSITIVE_INFINITY, 1e21,
    true, false, null, undefined, {}, [], ['3'],
  ]) {
    assert.equal(parseAutoTitleMinNew(bad).ok, false,
      `${JSON.stringify(bad) ?? String(bad)} 必须拒`);
  }
  // 0 是「每拍重算标题」的非法值（与保留天数那格的 0-有效相反）；上界外是 out_of_range。
  assert.equal(parseAutoTitleMinNew(0).reason, 'auto_title_min_new_out_of_range',
    '0 是合法数字但区间外 ⇒ out_of_range（不是 not_a_...）');
  assert.equal(parseAutoTitleMinNew(101).reason, 'auto_title_min_new_out_of_range');
  assert.equal(parseAutoTitleMinNew('1e2').reason, 'not_a_auto_title_min_new');
  assert.equal(parseAutoTitleMinNew(' 3 ').reason, 'not_a_auto_title_min_new',
    '带空白的串必须拒（Number() 会收成 3，那是第二套真相）');
  assert.equal(parseAutoTitleMinNew('+2').ok, false, '带符号的串必须拒');

  for (const good of [1, 3, 100]) {
    assert.equal(validateAutoTitleMinNew(good), true, `${good} 必须放行`);
  }
  for (const bad of ['3', '', '100', 0, -1, 101, 2.5, true, null, {}, [], Number.NaN]) {
    const why = validateAutoTitleMinNew(bad);
    assert.notEqual(why, true, `${JSON.stringify(bad) ?? String(bad)} 写侧必须拒`);
    assert.equal(typeof why, 'string', '拒绝必须返回点名的原因字符串');
  }
  // 上界与下界的拒绝要能说清是哪个数（M-3：去掉 validate 上界 ⇒ 这一条红）。
  assert.match(String(validateAutoTitleMinNew(101)), /100/);
  assert.match(String(validateAutoTitleMinNew(0)), /1/);
});

test('RS-40b 写侧的 1e2 两侧之分：JSON number 1e2 收并规整成 100，字符串 "1e2" 仍拒', async () => {
  const num = parseAutoTitleMinNew(1e2);
  assert.equal(num.ok, true, 'number 1e2（=100）必须收（写侧接受任何合法 JSON number）');
  assert.equal(num.value, 100, '1e2 必须规整成 100');
  assert.equal(validateAutoTitleMinNew(1e2), true, 'validate 也放行 number 1e2');
  assert.equal(parseAutoTitleMinNew('1e2').ok, false, '字符串 "1e2" 必须判非法');
  assert.notEqual(validateAutoTitleMinNew('1e2'), true, '写侧 validate 必须拒字符串 "1e2"');
  invalidateAutoTitleMinNewCache();
  const pool = new FakeRuntimePool();
  const saved = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: AUTO_TITLE_MIN_NEW_KEY, value: 1e2, log: silentLog,
  });
  assert.equal(saved.value, 100, 'DTO 值必须是 100（RETURNING 真相）');
  assert.equal(pool.storedValue(AUTO_TITLE_MIN_NEW_KEY), 100, '库里真的是 100');
  const pool2 = new FakeRuntimePool();
  const err = await saveRuntimeSetting({
    pool: pool2, actorId: ACTOR, key: AUTO_TITLE_MIN_NEW_KEY, value: '1e2', log: silentLog,
  }).then(() => null, (e) => e);
  assert.ok(err instanceof RuntimeSettingsError, '字符串 "1e2" 必须抛 RuntimeSettingsError');
  assert.equal(err.code, 'validation_failed', '字符串 "1e2" ⇒ validation_failed（HTTP 400）');
  assert.equal(err.httpStatus, 400, '必须映射成 400');
  assert.equal(pool2.queryCount, 0, '字符串校验在发 SQL 之前 ⇒ 零 SQL');
  invalidateAutoTitleMinNewCache();
});

test('RS-41 第四格热读三档：DB > env（过闸）> 默认 3；任何一档坏了都绝不抛', async () => {
  invalidateAutoTitleMinNewCache();
  const dbPool = ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
  assert.equal(await readAutoTitleMinNew({
    pool: dbPool, config: ATCFG, env: {}, log: silentLog,
  }), 8);
  assert.equal(dbPool.queryCount, 1, '确实发了那次读');

  // 库里非法值 ⇒ 回落 env 5，点名 warn 一次。
  invalidateAutoTitleMinNewCache();
  const log = collectingLog();
  assert.equal(await readAutoTitleMinNew({
    pool: ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: '1e2' }] }),
    config: ATCFG, env: {}, log,
  }), 5);
  assert.equal(log.seen.warn.length, 1, `恰好一条（实得 ${JSON.stringify(log.seen.warn)}）`);
  assert.match(log.seen.warn[0], new RegExp(AUTO_TITLE_MIN_NEW_KEY.replace(/\./g, '\\.')),
    'warn 要点名是哪个 key');

  // 库里没行 ⇒ env 5，不 warn。
  invalidateAutoTitleMinNewCache();
  const log2 = collectingLog();
  assert.equal(await readAutoTitleMinNew({
    pool: ttlPool(), config: ATCFG, env: {}, log: log2,
  }), 5);
  assert.deepEqual(log2.seen.warn, [], '没有行不是故障，不许刷屏');

  // 表不存在 ⇒ 回落 env，绝不抛。
  invalidateAutoTitleMinNewCache();
  assert.equal(await readAutoTitleMinNew({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) }),
    config: ATCFG, env: {}, log: silentLog,
  }), 5);

  // 连 pool 都没有 ⇒ 回落 env，不抛。
  invalidateAutoTitleMinNewCache();
  assert.equal(await readAutoTitleMinNew({
    pool: null, config: ATCFG, env: {}, log: silentLog,
  }), 5);

  // 三档全空 ⇒ 默认 3，绝不 undefined。
  invalidateAutoTitleMinNewCache();
  const none = await readAutoTitleMinNew({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  });
  assert.equal(none, AUTO_TITLE_MIN_NEW_DEFAULT);
  assert.notEqual(none, undefined, 'undefined 交给防抖比较就是 NaN');

  // 读挂住 ⇒ 按时给答案（timeoutMs 注入）。
  invalidateAutoTitleMinNewCache();
  assert.equal(await readAutoTitleMinNew({
    pool: ttlPool({ hang: true }), config: ATCFG, env: {}, log: silentLog, timeoutMs: 30,
  }), 5);

  // env 越界（config.js 的 intEnv 收得下 101，registry 不收）⇒ 回落默认 3，点名档与理由。
  invalidateAutoTitleMinNewCache();
  const overLog = collectingLog();
  assert.equal(await readAutoTitleMinNew({
    pool: ttlPool(),
    config: { sessionAutoTitleMinNew: 101, sessionAutoTitleMinNewSource: 'env' },
    env: {}, log: overLog,
  }), 3, '越界 ⇒ 回落默认 3（不是 101，也不是 undefined）');
  assert.ok(overLog.seen.warn.some((m) => m.includes('config.sessionAutoTitleMinNew')
    && m.includes('auto_title_min_new_out_of_range')),
    `要点名是哪一档、为什么（实得 ${JSON.stringify(overLog.seen.warn)}）`);

  // 本格有行不许让另一格凭空读数（同一张表；各格独立）。
  invalidateAutoTitleMinNewCache();
  invalidatePreviewTicketTtlCache();
  const mixed = ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
  assert.equal(await readAutoTitleMinNew({
    pool: mixed, config: ATCFG, env: {}, log: silentLog,
  }), 8);
  invalidatePreviewTicketTtlCache();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: mixed, config: PCFG, env: {}, log: silentLog,
  }), 45, '标题阈值那格有行不许让预览票那格凭空读出一个数');
  invalidateAutoTitleMinNewCache();
  invalidatePreviewTicketTtlCache();
});

test('RS-42 第四格缓存：同池 5s 内命中不发 SQL、过期重读、换池不串、本格不被另格顶掉',
  async () => {
    invalidateAutoTitleMinNewCache();
    const pool = ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
    let clock = 4_000_000;
    const now = () => clock;
    const read = () => readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, now, log: silentLog,
    });
    assert.equal(await read(), 8);
    assert.equal(pool.queryCount, 1);
    clock += HOT_READ_CACHE_TTL_MS;
    assert.equal(await read(), 8);
    assert.equal(pool.queryCount, 1, '5s 内命中 ⇒ 不发第二条 SQL');
    pool.rows = [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 2 }];
    clock += 1;
    assert.equal(await read(), 2, '过期后必须重读');
    assert.equal(pool.queryCount, 2);
    const other = ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 6 }] });
    assert.equal(await readAutoTitleMinNew({
      pool: other, config: ATCFG, env: {}, now, log: silentLog,
    }), 6, 'B 池必须自己读');
    assert.equal(other.queryCount, 1);
    // 本格缓存不被别格的读顶掉（各格各一份工厂状态）。
    assert.equal(await read(), 2);
    const before = pool.queryCount;
    invalidatePreviewTicketTtlCache();
    await readPreviewTicketTtlSeconds({ pool, config: PCFG, env: {}, now, log: silentLog });
    assert.equal(await read(), 2);
    assert.equal(pool.queryCount, before + 1,
      '只有预览票那格该发 SQL（+2 = 本格缓存被预览票顶掉了）');
    invalidateAutoTitleMinNewCache();
  });

test('RS-43 第四格保存后立即失效：PUT 完下一次评估就是新值（M-2 去登记 ⇒ 这一格红）',
  async () => {
    invalidateAutoTitleMinNewCache();
    const pool = new FakeRuntimePool();
    assert.equal(await readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    }), 5);
    const saved = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: AUTO_TITLE_MIN_NEW_KEY, value: 8, log: silentLog,
    });
    assert.equal(saved.value, 8);
    assert.equal(pool.storedValue(AUTO_TITLE_MIN_NEW_KEY), 8, '库里真的是新值');
    const afterSave = pool.queryCount;
    const next = await readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    });
    assert.equal(next, 8, '保存后下一次读就是新值（读到 5 = 失效钩子少登记）');
    assert.equal(pool.queryCount, afterSave + 1, '这次读必须真的再发一次 SQL');
    const afterSecond = pool.queryCount;
    assert.equal(await readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    }), 8);
    assert.equal(pool.queryCount, afterSecond, '失效后那一读已把新值填回缓存');
    // 反向：保存另一格不许抹掉本格缓存。
    await saveRuntimeSetting({
      pool, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: 30, log: silentLog,
    });
    const afterOtherSave = pool.queryCount;
    assert.equal(await readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    }), 8);
    assert.equal(pool.queryCount, afterOtherSave, '保存预览票之后本格仍应命中缓存');
    invalidateAutoTitleMinNewCache();
    invalidatePreviewTicketTtlCache();
  });

test('RS-44 第四格并发：冷缓存四路只发一条 SQL，另一池自己发，合并后照常回填缓存',
  async () => {
    invalidateAutoTitleMinNewCache();
    const pool = new GatingRuntimePool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
    let release;
    pool.gate = new Promise((resolve) => { release = () => resolve(); });
    const four = Array.from({ length: 4 }, () => readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    }));
    await tick();
    assert.equal(pool.queryCount, 1,
      `四路并发必须合并成 **1 条** SQL（实发 ${pool.queryCount} 条）`);
    const other = ttlPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 6 }] });
    assert.equal(await readAutoTitleMinNew({
      pool: other, config: ATCFG, env: {}, log: silentLog,
    }), 6, 'B 池不许蹭 A 池在飞那一趟');
    release();
    assert.deepEqual(await Promise.all(four), [8, 8, 8, 8]);
    assert.equal(pool.queryCount, 1, '合并之后仍只有一条 SQL');
    assert.equal(await readAutoTitleMinNew({
      pool, config: ATCFG, env: {}, log: silentLog,
    }), 8);
    assert.equal(pool.queryCount, 1, '在飞那趟必须照常回填缓存');
    invalidateAutoTitleMinNewCache();
  });

test('RS-45 第四格在飞那趟失败 ⇒ 清槽（不许把之后所有读钉在失败那一趟上）', async () => {
  invalidateAutoTitleMinNewCache();
  const pool = flakyPool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
  let clock = 5_000_000;
  const read = () => readAutoTitleMinNew({
    pool, config: ATCFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(await read(), 5, '失败那趟也要给答案（抛了就是评估标题链路 500）');
  assert.equal(pool.queryCount, 1);
  pool.broken = false;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await read(), 8, '恢复后必须读到库里的值，不是被钉住的 5');
  assert.equal(pool.queryCount, 2, '必须重新发 SQL（失败路径没清槽就红在这里）');
  invalidateAutoTitleMinNewCache();
  const gate = new GatingRuntimePool({ rows: [{ key: AUTO_TITLE_MIN_NEW_KEY, value: 8 }] });
  let release;
  gate.gate = new Promise((resolve) => { release = () => resolve(); });
  gate.releaseThrows = true;
  const first = readAutoTitleMinNew({
    pool: gate, config: ATCFG, env: {}, now: () => clock, log: silentLog,
  });
  await tick();
  const second = readAutoTitleMinNew({
    pool: gate, config: ATCFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(gate.queryCount, 1, '第二路必须复用那一趟');
  release();
  assert.equal(await first, 5, '那一趟挂了 ⇒ 发起方按回落给答案');
  assert.equal(await second, 5, '共享者也按回落给答案');
  gate.gate = null;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await readAutoTitleMinNew({
    pool: gate, config: ATCFG, env: {}, now: () => clock, log: silentLog,
  }), 8, '挂掉之后必须重新发读拿到真值');
  invalidateAutoTitleMinNewCache();
});

test('RS-46 第四格 env 也过 registry 那套闸 + 一次热读最多一条 warn', async () => {
  const BAD = [
    ['上界外', '101', 'auto_title_min_new_out_of_range'],
    ['下界外', '0', 'auto_title_min_new_out_of_range'],
    ['小数', '2.5', 'not_a_auto_title_min_new'],
    ['科学计数', '1e2', 'not_a_auto_title_min_new'],
    ['压根不是数', 'abc', 'not_a_auto_title_min_new'],
  ];
  for (const [label, raw, reason] of BAD) {
    const cfg = loadConfig({ MAX_LOGIN_LENGTH: '128', ERIX_SESSION_AUTO_TITLE_MIN_NEW: raw });
    const env = { ERIX_SESSION_AUTO_TITLE_MIN_NEW: raw };
    invalidateAutoTitleMinNewCache();
    const hotLog = collectingLog();
    const hot = await readAutoTitleMinNew({
      pool: ttlPool(), config: cfg, env, log: hotLog,
    });
    assert.equal(hot, AUTO_TITLE_MIN_NEW_DEFAULT,
      `${label}：env=${raw} 过不了闸 ⇒ 回落默认 3（实得 ${hot}）`);
    const named = hotLog.seen.warn.filter((m) => m.includes(AUTO_TITLE_MIN_NEW_KEY)
      && m.includes('ERIX_SESSION_AUTO_TITLE_MIN_NEW'));
    assert.equal(named.length, 1,
      `坏 env 值必须点名 warn 一次，实得 ${JSON.stringify(hotLog.seen.warn)}`);
    assert.match(named[0], new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'warn 要带上那个坏值本身');
    assert.match(named[0], new RegExp(reason), 'warn 要带上被拒的理由');
  }
  for (const raw of ['1', '2', '100']) {
    invalidateAutoTitleMinNewCache();
    const log = collectingLog();
    const cfg = loadConfig({ MAX_LOGIN_LENGTH: '128', ERIX_SESSION_AUTO_TITLE_MIN_NEW: raw });
    assert.equal(await readAutoTitleMinNew({
      pool: ttlPool(), config: cfg, env: { ERIX_SESSION_AUTO_TITLE_MIN_NEW: raw }, log,
    }), Number(raw), `env ${raw} 必须照收`);
    assert.deepEqual(log.seen.warn, [], `合法值不许 warn（实得 ${JSON.stringify(log.seen.warn)}）`);
  }
  invalidateAutoTitleMinNewCache();
});

test('RS-47 真库那一腿（第四格）：写 8 ⇒ 热读 8、不等 5 秒；删行 ⇒ 回落 env（无 PG skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const CONFIG = { sessionAutoTitleMinNew: 5, sessionAutoTitleMinNewSource: 'env' };
      invalidateAutoTitleMinNewCache();
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-p3b3-actor'],
      );
      assert.equal(await readAutoTitleMinNew({ pool, config: CONFIG, log: pgSilent }), 5);
      const saved = await saveRuntimeSetting({
        pool, actorId: ACTOR, key: AUTO_TITLE_MIN_NEW_KEY, value: 8, log: pgSilent,
      });
      assert.equal(saved.value, 8);
      assert.equal(saved.updatedBy, ACTOR);
      assert.equal(await readAutoTitleMinNew({ pool, config: CONFIG, log: pgSilent }), 8,
        '真库上「保存完下一轮评估就用新值」必须是事实');
      const list = await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent });
      const item = list.items.find((i) => i.key === AUTO_TITLE_MIN_NEW_KEY);
      assert.equal(item.source, 'db');
      assert.equal(item.value, 8);
      assert.equal(item.updatedBy, ACTOR);
      await pool.query('DELETE FROM runtime_settings WHERE key = $1', [AUTO_TITLE_MIN_NEW_KEY]);
      invalidateAutoTitleMinNewCache();
      assert.equal(await readAutoTitleMinNew({ pool, config: CONFIG, log: pgSilent }), 5);
      await pool.query(
        `INSERT INTO runtime_settings (key, value) VALUES ($1, $2::jsonb)`,
        [AUTO_TITLE_MIN_NEW_KEY, '"1e2"'],
      );
      invalidateAutoTitleMinNewCache();
      assert.equal(await readAutoTitleMinNew({ pool, config: CONFIG, log: pgSilent }), 5,
        '手工写的坏值 ⇒ 回落 env，不抛');
      invalidateAutoTitleMinNewCache();
    });
  });

// ---------------------------------------------------------------------------
// 10. #710 MED：文档格数与 registry 一致（M-1 的落点：删掉 §4.21 表里第四行 ⇒ 这一格点名红）。
//   为什么钉这条：§4.21 那张表是运维唯一的「哪些旋钮能改、改到哪」的清单。少一行不是排版问题，
//   而是「已经能改的旋钮在契约里不存在」⇒ 运维照表操作会漏掉一格，管理台却真的听它。
//   判据取**双向**（表 ⊆ registry 且 registry ⊆ 表），只钉一侧的话「文档多写一格」也照样漂。
// ---------------------------------------------------------------------------

test('RS-48 §4.21 的旋钮表与 registry 键集合逐格一致（表头列数也一致；M-1 删行 ⇒ 这一格红）',
  () => {
    const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
    const start = apiDoc.indexOf('### 4.21 管理台运行时设置');
    assert.ok(start >= 0, '§4.21 那一节被删了或改标题了（判据切不到片）');
    const end = apiDoc.indexOf('#### `GET /api/admin/runtime-settings`', start);
    assert.ok(end > start, '§4.21 的 GET 小节标题被改名 ⇒ 切片切到整篇文档');
    const region = apiDoc.slice(start, end);

    const rows = region.split('\n').filter((l) => l.startsWith('|'));
    assert.ok(rows.length >= 2, '§4.21 里那张旋钮表不见了（连表头都没有）');
    const splitCells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
    const header = splitCells(rows[0]);
    assert.equal(header[0], 'key', '表第一列必须是 key（判据按第一列取 key）');
    const dataRows = rows.slice(2).map(splitCells); // 第 2 行是 | --- | 分隔行

    // 表头列数与每一行的格数一致（列数漂了 = 有人加了列却没给旧行补值）。
    for (const cells of dataRows) {
      assert.equal(cells.length, header.length,
        `§4.21 表格有一行的格数是 ${cells.length}，表头是 ${header.length}：${cells[0]}`);
    }

    const tableKeys = dataRows.map((cells) => cells[0].replace(/`/g, ''));
    assert.deepEqual(
      [...tableKeys].sort(), Object.keys(RUNTIME_SETTING_REGISTRY).sort(),
      '§4.21 的表行集合必须与 registry 键集合逐格一致：少一行 = 已能改的旋钮在契约里不存在，'
      + '多一行 = 契约承诺了一个机器上根本没有的旋钮',
    );

    // 每一行必须把 registry 那一格的 envVar / applyMode 原样写出来（值域与默认在 RS-31/RS-40 钉）。
    for (const [key, entry] of Object.entries(RUNTIME_SETTING_REGISTRY)) {
      const cells = dataRows.find((c) => c[0].replace(/`/g, '') === key);
      assert.ok(cells, `registry 有 ${key}，但 §4.21 的表里没有那一行`);
      const rowText = cells.join(' ');
      assert.ok(rowText.includes(entry.envVar),
        `${key} 那一行必须写出 registry 登记的 envVar ${entry.envVar}（env 兜底位的名）`);
      assert.ok(rowText.includes(entry.applyMode),
        `${key} 那一行的 applyMode 必须是 registry 登记的那个（${entry.applyMode}）`);
    }

    // 本批那一格多钉一层（#710 MED 直接要求的四件：key / 默认 / 值域 / 生效点）：
    // 只钉「行在」不够，行里没写默认与值域的话，运维仍然无从知道能改到哪。
    const atRow = dataRows.find((c) => c[0].replace(/`/g, '') === AUTO_TITLE_MIN_NEW_KEY);
    const atText = atRow.join(' ');
    assert.match(atText, /1\.\.100/, '第四格那一行必须写出值域 `1..100`（与 RS-40 钉的同一区间）');
    assert.match(atText, /默认 `?3`?/, '第四格那一行必须写出默认 3（三处同源）');
    assert.match(atText, /evaluateAutoTitle/, '第四格那一行必须写出生效点（谁在什么时候读它）');
  });

// ---------------------------------------------------------------------------
// 11. P3 第五批：第五格真实旋钮 `preview.session_ttl_seconds`（#677）。
//   RS-49 解析/校验（严格正整数 + 区间 60..86400）；RS-49b 写侧 1e3 两侧之分；
//   RS-50 热读三档；RS-51 缓存；RS-52 写后失效（M-2 去登记 ⇒ 红）；RS-53 并发只发一条 SQL；
//   RS-54 在飞失败清槽；RS-55 env 也过闸 + 一次热读最多一条 warn；RS-56 真库腿；
//   RS-57 §4.21 第五行多钉一层（值域/默认/生效点）。
// ⚠ 本节格子共享**模块级**热读缓存/槽 ⇒ 每段前后都 `invalidatePreviewSessionTtlCache()`。
// ---------------------------------------------------------------------------

// env/config 那一档的固定值：1800（与默认 900 拉开距离，才能验「回落用的是哪一档」）。
const PSCFG = { previewSessionTtlSeconds: 1800, previewSessionTtlSecondsSource: 'env' };

test('RS-49 preview.session_ttl_seconds 的解析与校验：严格十进制正整数 + 区间 60..86400', () => {
  assert.equal(PREVIEW_SESSION_TTL_MIN_SECONDS, 60);
  assert.equal(PREVIEW_SESSION_TTL_MAX_SECONDS, 86400);
  assert.equal(PREVIEW_SESSION_TTL_DEFAULT_SECONDS, 900, '与 config.js / compose 同源');
  assert.equal(loadConfig({ MAX_LOGIN_LENGTH: '128' }).previewSessionTtlSeconds,
    PREVIEW_SESSION_TTL_DEFAULT_SECONDS, 'registry 默认必须等于 loadConfig 干净 env 算出的数');

  for (const good of [60, 900, 86400, '60', '900', '86400', '0900']) {
    const r = parsePreviewSessionTtlSeconds(good);
    assert.equal(r.ok, true, `${JSON.stringify(good)} 必须收`);
    assert.equal(r.value, Number(good));
  }
  for (const bad of [
    '1e3', ' 900 ', '900x', '', '0x10', '90.5', '86401', '0', '-1', '+60',
    0, -1, 90.5, 86401, Number.NaN, Number.POSITIVE_INFINITY, 1e21,
    true, false, null, undefined, {}, [], ['900'],
  ]) {
    assert.equal(parsePreviewSessionTtlSeconds(bad).ok, false,
      `${JSON.stringify(bad) ?? String(bad)} 必须拒`);
  }
  // 0 / 59 是区间外的合法数字（与保留天数那格的 0-有效相反）；上界外也是 out_of_range。
  assert.equal(parsePreviewSessionTtlSeconds(0).reason, 'session_ttl_seconds_out_of_range',
    '0 是合法数字但区间外 ⇒ out_of_range（不是 not_a_...）');
  assert.equal(parsePreviewSessionTtlSeconds(86401).reason, 'session_ttl_seconds_out_of_range');
  assert.equal(parsePreviewSessionTtlSeconds('1e3').reason, 'not_a_session_ttl_seconds');
  assert.equal(parsePreviewSessionTtlSeconds(' 900 ').reason, 'not_a_session_ttl_seconds',
    '带空白的串必须拒（Number() 会收成 900，那是第二套真相）');
  assert.equal(parsePreviewSessionTtlSeconds('+60').ok, false, '带符号的串必须拒');

  for (const good of [60, 900, 86400]) {
    assert.equal(validatePreviewSessionTtlSeconds(good), true, `${good} 必须放行`);
  }
  for (const bad of ['900', '', '86400', 0, -1, 86401, 90.5, true, null, {}, [], Number.NaN]) {
    const why = validatePreviewSessionTtlSeconds(bad);
    assert.notEqual(why, true, `${JSON.stringify(bad) ?? String(bad)} 写侧必须拒`);
    assert.equal(typeof why, 'string', '拒绝必须返回点名的原因字符串');
  }
  assert.match(String(validatePreviewSessionTtlSeconds(86401)), /86400/);
  assert.match(String(validatePreviewSessionTtlSeconds(0)), /60/);
});

test('RS-49b 写侧的 1e3 两侧之分：JSON number 1e3 收并规整成 1000，字符串 "1e3" 仍拒', async () => {
  const num = parsePreviewSessionTtlSeconds(1e3);
  assert.equal(num.ok, true, 'number 1e3（=1000）必须收（写侧接受任何合法 JSON number）');
  assert.equal(num.value, 1000, '1e3 必须规整成 1000');
  assert.equal(validatePreviewSessionTtlSeconds(1e3), true, 'validate 也放行 number 1e3');
  assert.equal(parsePreviewSessionTtlSeconds('1e3').ok, false, '字符串 "1e3" 必须判非法');
  assert.notEqual(validatePreviewSessionTtlSeconds('1e3'), true, '写侧 validate 必须拒字符串 "1e3"');
  invalidatePreviewSessionTtlCache();
  const pool = new FakeRuntimePool();
  const saved = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: PREVIEW_SESSION_TTL_KEY, value: 1e3, log: silentLog,
  });
  assert.equal(saved.value, 1000, 'DTO 值必须是 1000（RETURNING 真相）');
  assert.equal(pool.storedValue(PREVIEW_SESSION_TTL_KEY), 1000, '库里真的是 1000');
  const pool2 = new FakeRuntimePool();
  const err = await saveRuntimeSetting({
    pool: pool2, actorId: ACTOR, key: PREVIEW_SESSION_TTL_KEY, value: '1e3', log: silentLog,
  }).then(() => null, (e) => e);
  assert.ok(err instanceof RuntimeSettingsError, '字符串 "1e3" 必须抛 RuntimeSettingsError');
  assert.equal(err.code, 'validation_failed', '字符串 "1e3" ⇒ validation_failed（HTTP 400）');
  assert.equal(pool2.queryCount, 0, '字符串校验在发 SQL 之前 ⇒ 零 SQL');
  invalidatePreviewSessionTtlCache();
});

test('RS-50 第五格热读三档：DB > env（过闸）> 默认 900；任何一档坏了都绝不抛', async () => {
  invalidatePreviewSessionTtlCache();
  const dbPool = ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: dbPool, config: PSCFG, env: {}, log: silentLog,
  }), 7200);
  assert.equal(dbPool.queryCount, 1, '确实发了那次读');

  // 库里非法值 ⇒ 回落 env 1800，点名 warn 一次。
  invalidatePreviewSessionTtlCache();
  const log = collectingLog();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: '1e3' }] }),
    config: PSCFG, env: {}, log,
  }), 1800);
  assert.equal(log.seen.warn.length, 1, `恰好一条（实得 ${JSON.stringify(log.seen.warn)}）`);
  assert.match(log.seen.warn[0], new RegExp(PREVIEW_SESSION_TTL_KEY.replace(/\./g, '\\.')),
    'warn 要点名是哪个 key');

  // 库里没行 ⇒ env 1800，不 warn。
  invalidatePreviewSessionTtlCache();
  const log2 = collectingLog();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: ttlPool(), config: PSCFG, env: {}, log: log2,
  }), 1800);
  assert.deepEqual(log2.seen.warn, [], '没有行不是故障，不许刷屏');

  // 表不存在 ⇒ 回落 env，绝不抛。
  invalidatePreviewSessionTtlCache();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) }),
    config: PSCFG, env: {}, log: silentLog,
  }), 1800);

  // 连 pool 都没有 ⇒ 回落 env，不抛。
  invalidatePreviewSessionTtlCache();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: null, config: PSCFG, env: {}, log: silentLog,
  }), 1800);

  // 三档全空 ⇒ 默认 900，绝不 undefined。
  invalidatePreviewSessionTtlCache();
  const none = await readPreviewSessionTtlSeconds({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  });
  assert.equal(none, PREVIEW_SESSION_TTL_DEFAULT_SECONDS);
  assert.notEqual(none, undefined, 'undefined 交给 cookie maxAge / expires_at 就是 NaN');

  // 读挂住 ⇒ 按时给答案（timeoutMs 注入）。
  invalidatePreviewSessionTtlCache();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: ttlPool({ hang: true }), config: PSCFG, env: {}, log: silentLog, timeoutMs: 30,
  }), 1800);

  // env 越界（config.js 的 intEnv 收得下 86401，registry 不收）⇒ 回落默认 900，点名档与理由。
  invalidatePreviewSessionTtlCache();
  const overLog = collectingLog();
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: ttlPool(),
    config: { previewSessionTtlSeconds: 86401, previewSessionTtlSecondsSource: 'env' },
    env: {}, log: overLog,
  }), 900, '越界 ⇒ 回落默认 900（不是 86401，也不是 undefined）');
  assert.ok(overLog.seen.warn.some((m) => m.includes('config.previewSessionTtlSeconds')
    && m.includes('session_ttl_seconds_out_of_range')),
    `要点名是哪一档、为什么（实得 ${JSON.stringify(overLog.seen.warn)}）`);

  // 本格有行不许让另一格凭空读数（同一张表；各格独立）。
  invalidatePreviewSessionTtlCache();
  invalidatePreviewTicketTtlCache();
  const mixed = ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: mixed, config: PSCFG, env: {}, log: silentLog,
  }), 7200);
  invalidatePreviewTicketTtlCache();
  assert.equal(await readPreviewTicketTtlSeconds({
    pool: mixed, config: PCFG, env: {}, log: silentLog,
  }), 45, '会话 TTL 那格有行不许让预览票那格凭空读出一个数');
  invalidatePreviewSessionTtlCache();
  invalidatePreviewTicketTtlCache();
});

test('RS-51 第五格缓存：同池 5s 内命中不发 SQL、过期重读、换池不串、本格不被另格顶掉',
  async () => {
    invalidatePreviewSessionTtlCache();
    const pool = ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
    let clock = 4_000_000;
    const now = () => clock;
    const read = () => readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, now, log: silentLog,
    });
    assert.equal(await read(), 7200);
    assert.equal(pool.queryCount, 1);
    clock += HOT_READ_CACHE_TTL_MS;
    assert.equal(await read(), 7200);
    assert.equal(pool.queryCount, 1, '5s 内命中 ⇒ 不发第二条 SQL');
    pool.rows = [{ key: PREVIEW_SESSION_TTL_KEY, value: 120 }];
    clock += 1;
    assert.equal(await read(), 120, '过期后必须重读');
    assert.equal(pool.queryCount, 2);
    const other = ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 60 }] });
    assert.equal(await readPreviewSessionTtlSeconds({
      pool: other, config: PSCFG, env: {}, now, log: silentLog,
    }), 60, 'B 池必须自己读');
    assert.equal(other.queryCount, 1);
    // 本格缓存不被别格的读顶掉（各格各一份工厂状态）。
    assert.equal(await read(), 120);
    const before = pool.queryCount;
    invalidatePreviewTicketTtlCache();
    await readPreviewTicketTtlSeconds({ pool, config: PCFG, env: {}, now, log: silentLog });
    assert.equal(await read(), 120);
    assert.equal(pool.queryCount, before + 1,
      '只有预览票那格该发 SQL（+2 = 本格缓存被预览票顶掉了）');
    invalidatePreviewSessionTtlCache();
  });

test('RS-52 第五格保存后立即失效：PUT 完下一个预览请求就是新值（M-2 去登记 ⇒ 这一格红）',
  async () => {
    invalidatePreviewSessionTtlCache();
    const pool = new FakeRuntimePool();
    assert.equal(await readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    }), 1800);
    const saved = await saveRuntimeSetting({
      pool, actorId: ACTOR, key: PREVIEW_SESSION_TTL_KEY, value: 7200, log: silentLog,
    });
    assert.equal(saved.value, 7200);
    assert.equal(pool.storedValue(PREVIEW_SESSION_TTL_KEY), 7200, '库里真的是新值');
    const afterSave = pool.queryCount;
    const next = await readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    });
    assert.equal(next, 7200, '保存后下一次读就是新值（读到 1800 = 失效钩子少登记）');
    assert.equal(pool.queryCount, afterSave + 1, '这次读必须真的再发一次 SQL');
    const afterSecond = pool.queryCount;
    assert.equal(await readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    }), 7200);
    assert.equal(pool.queryCount, afterSecond, '失效后那一读已把新值填回缓存');
    // 反向：保存另一格不许抹掉本格缓存。
    await saveRuntimeSetting({
      pool, actorId: ACTOR, key: PREVIEW_TICKET_TTL_KEY, value: 30, log: silentLog,
    });
    const afterOtherSave = pool.queryCount;
    assert.equal(await readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    }), 7200);
    assert.equal(pool.queryCount, afterOtherSave, '保存预览票之后本格仍应命中缓存');
    invalidatePreviewSessionTtlCache();
    invalidatePreviewTicketTtlCache();
  });

test('RS-53 第五格并发：冷缓存四路只发一条 SQL，另一池自己发，合并后照常回填缓存',
  async () => {
    invalidatePreviewSessionTtlCache();
    const pool = new GatingRuntimePool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
    let release;
    pool.gate = new Promise((resolve) => { release = () => resolve(); });
    const four = Array.from({ length: 4 }, () => readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    }));
    await tick();
    assert.equal(pool.queryCount, 1,
      `四路并发必须合并成 **1 条** SQL（实发 ${pool.queryCount} 条）`);
    const other = ttlPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 60 }] });
    assert.equal(await readPreviewSessionTtlSeconds({
      pool: other, config: PSCFG, env: {}, log: silentLog,
    }), 60, 'B 池不许蹭 A 池在飞那一趟');
    release();
    assert.deepEqual(await Promise.all(four), [7200, 7200, 7200, 7200]);
    assert.equal(pool.queryCount, 1, '合并之后仍只有一条 SQL');
    assert.equal(await readPreviewSessionTtlSeconds({
      pool, config: PSCFG, env: {}, log: silentLog,
    }), 7200);
    assert.equal(pool.queryCount, 1, '在飞那趟必须照常回填缓存');
    invalidatePreviewSessionTtlCache();
  });

test('RS-54 第五格在飞那趟失败 ⇒ 清槽（不许把之后所有读钉在失败那一趟上）', async () => {
  invalidatePreviewSessionTtlCache();
  const pool = flakyPool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
  let clock = 5_000_000;
  const read = () => readPreviewSessionTtlSeconds({
    pool, config: PSCFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(await read(), 1800, '失败那趟也要给答案（抛了就是预览放行链路 500）');
  assert.equal(pool.queryCount, 1);
  pool.broken = false;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await read(), 7200, '恢复后必须读到库里的值，不是被钉住的 1800');
  assert.equal(pool.queryCount, 2, '必须重新发 SQL（失败路径没清槽就红在这里）');
  invalidatePreviewSessionTtlCache();
  const gate = new GatingRuntimePool({ rows: [{ key: PREVIEW_SESSION_TTL_KEY, value: 7200 }] });
  let release;
  gate.gate = new Promise((resolve) => { release = () => resolve(); });
  gate.releaseThrows = true;
  const first = readPreviewSessionTtlSeconds({
    pool: gate, config: PSCFG, env: {}, now: () => clock, log: silentLog,
  });
  await tick();
  const second = readPreviewSessionTtlSeconds({
    pool: gate, config: PSCFG, env: {}, now: () => clock, log: silentLog,
  });
  assert.equal(gate.queryCount, 1, '第二路必须复用那一趟');
  release();
  assert.equal(await first, 1800, '那一趟挂了 ⇒ 发起方按回落给答案');
  assert.equal(await second, 1800, '共享者也按回落给答案');
  gate.gate = null;
  clock += HOT_READ_CACHE_TTL_MS + 1;
  assert.equal(await readPreviewSessionTtlSeconds({
    pool: gate, config: PSCFG, env: {}, now: () => clock, log: silentLog,
  }), 7200, '挂掉之后必须重新发读拿到真值');
  invalidatePreviewSessionTtlCache();
});

test('RS-55 第五格 env 也过 registry 那套闸 + 一次热读最多一条 warn', async () => {
  const BAD = [
    ['上界外', '86401', 'session_ttl_seconds_out_of_range'],
    ['下界外', '59', 'session_ttl_seconds_out_of_range'],
    ['小数', '90.5', 'not_a_session_ttl_seconds'],
    ['科学计数', '1e3', 'not_a_session_ttl_seconds'],
    ['压根不是数', 'abc', 'not_a_session_ttl_seconds'],
  ];
  for (const [label, raw, reason] of BAD) {
    const cfg = loadConfig({ MAX_LOGIN_LENGTH: '128', PREVIEW_SESSION_TTL_SECONDS: raw });
    const env = { PREVIEW_SESSION_TTL_SECONDS: raw };
    invalidatePreviewSessionTtlCache();
    const hotLog = collectingLog();
    const hot = await readPreviewSessionTtlSeconds({
      pool: ttlPool(), config: cfg, env, log: hotLog,
    });
    assert.equal(hot, PREVIEW_SESSION_TTL_DEFAULT_SECONDS,
      `${label}：env=${raw} 过不了闸 ⇒ 回落默认 900（实得 ${hot}）`);
    const named = hotLog.seen.warn.filter((m) => m.includes(PREVIEW_SESSION_TTL_KEY)
      && m.includes('PREVIEW_SESSION_TTL_SECONDS'));
    assert.equal(named.length, 1,
      `坏 env 值必须点名 warn 一次，实得 ${JSON.stringify(hotLog.seen.warn)}`);
    assert.match(named[0], new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      'warn 要带上那个坏值本身');
    assert.match(named[0], new RegExp(reason), 'warn 要带上被拒的理由');
  }
  for (const raw of ['60', '900', '86400']) {
    invalidatePreviewSessionTtlCache();
    const log = collectingLog();
    const cfg = loadConfig({ MAX_LOGIN_LENGTH: '128', PREVIEW_SESSION_TTL_SECONDS: raw });
    assert.equal(await readPreviewSessionTtlSeconds({
      pool: ttlPool(), config: cfg, env: { PREVIEW_SESSION_TTL_SECONDS: raw }, log,
    }), Number(raw), `env ${raw} 必须照收`);
    assert.deepEqual(log.seen.warn, [], `合法值不许 warn（实得 ${JSON.stringify(log.seen.warn)}）`);
  }
  invalidatePreviewSessionTtlCache();
});

test('RS-56 真库那一腿（第五格）：写 7200 ⇒ 热读 7200、不等 5 秒；删行 ⇒ 回落 env（无 PG skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      const CONFIG = { previewSessionTtlSeconds: 1800, previewSessionTtlSecondsSource: 'env' };
      const read = () => readPreviewSessionTtlSeconds({ pool, config: CONFIG, log: pgSilent });
      invalidatePreviewSessionTtlCache();
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-p3b5-actor'],
      );
      assert.equal(await read(), 1800);
      const saved = await saveRuntimeSetting({
        pool, actorId: ACTOR, key: PREVIEW_SESSION_TTL_KEY, value: 7200, log: pgSilent,
      });
      assert.equal(saved.value, 7200);
      assert.equal(saved.updatedBy, ACTOR);
      assert.equal(await read(), 7200,
        '真库上「保存完下一个预览请求就用新值」必须是事实');
      const list = await listRuntimeSettingsAdmin({ pool, config: CONFIG, log: pgSilent });
      const item = list.items.find((i) => i.key === PREVIEW_SESSION_TTL_KEY);
      assert.equal(item.source, 'db');
      assert.equal(item.value, 7200);
      assert.equal(item.updatedBy, ACTOR);
      await pool.query('DELETE FROM runtime_settings WHERE key = $1', [PREVIEW_SESSION_TTL_KEY]);
      invalidatePreviewSessionTtlCache();
      assert.equal(await read(), 1800);
      await pool.query(
        `INSERT INTO runtime_settings (key, value) VALUES ($1, $2::jsonb)`,
        [PREVIEW_SESSION_TTL_KEY, '"1e3"'],
      );
      invalidatePreviewSessionTtlCache();
      assert.equal(await read(), 1800,
        '手工写的坏值 ⇒ 回落 env，不抛');
      invalidatePreviewSessionTtlCache();
    });
  });

test('RS-57 §4.21 第五格那一行多钉一层：值域 / 默认 / 生效点都写出来', () => {
  const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
  const start = apiDoc.indexOf('### 4.21 管理台运行时设置');
  assert.ok(start >= 0, '§4.21 那一节被删了或改标题了（判据切不到片）');
  const sliceEnd = apiDoc.indexOf('#### `GET /api/admin/runtime-settings`', start);
  const region = apiDoc.slice(start, sliceEnd);
  const dataRows = region.split('\n').filter((l) => l.startsWith('|')).slice(2)
    .map((line) => line.split('|').slice(1, -1).map((c) => c.trim()));
  const row = dataRows.find((c) => c[0].replace(/`/g, '') === PREVIEW_SESSION_TTL_KEY);
  assert.ok(row, '§4.21 的旋钮表里没有 preview.session_ttl_seconds 那一行');
  const text = row.join(' ');
  assert.match(text, /60\.\.86400/, '第五格那一行必须写出值域 `60..86400`（与 RS-49 同一区间）');
  assert.match(text, /默认 `?900`?/, '第五格那一行必须写出默认 900（三处同源）');
  assert.match(text, /handleForwardAuth|Set-Cookie|preview\.js/,
    '第五格那一行必须写出生效点（谁在什么时候读它）');
});

// 11. #677 P3 第六批：三个循环空闲退避旋钮（loop.*_idle_backoff_ms）一起迁。
//   这一族的形状与前面四格不同：**一次迁三格，且三格是同一类旋钮**。于是这里要钉的是三件事：
//     · 值域不许自己发明（RS-49）—— 上界必须引用 `loop-timing.js` 的共享上限 / 对账的业务上限，
//       且 provisioner 那条「env=60000 ⇒ 生效 15000」的既有钳位行为必须原样存在（新旧同值）；
//     · 三格各自一份热读实例（RS-51）—— 共用一个实例就是「保存开户那格把对账那格的缓存抹掉」，
//       那一刀（变异②）在这格点名红；
//     · registry 登记 / 写路径失效 / 契约文档三处都齐全（RS-50 / RS-52 / RS-53）。
//   「现读位置在每一拍决定 sleep 之前」那一半在 `portal/test/idle-backoff-hot-677.test.js`
//   （循环侧的夹具在那里；变异①「改回启动快照」在那里点名红）。
// ---------------------------------------------------------------------------

test('RS-49 三个退避旋钮的闸：值域全部来自循环侧既有钳位逻辑（自己发明上界 ⇒ 这一格红）', () => {
  // 上界的来历必须**可追**：开户 / 销号 = 共享的 `MAX_BACKOFF_MS_SAFE`（Node timer 语义边界），
  // 对账 = 本循环的业务上限（漂移发现延迟是业务承诺）。两个数都不许在 registry 里各写一份。
  assert.equal(IDLE_BACKOFF_MS_SHARED_MAX, MAX_BACKOFF_MS_SAFE,
    '开户/销号的上界必须引用 loop-timing 的共享上限，不是 registry 里另抄一个数');
  assert.equal(IDLE_BACKOFF_MS_SHARED_MAX, 60_000);
  assert.equal(PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP, PROVISIONER_LOOP_CAP,
    '对账的上界必须与 provisioner.js 的 IDLE_BACKOFF_MAX_MS_BUSINESS_CAP 同源');
  assert.equal(PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP, 15_000, '对账的业务上限是 15000');
  assert.ok(PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP < IDLE_BACKOFF_MS_SHARED_MAX,
    '这一族的意义所在：对账的默认 < 共享上限 ⇒ 越界回落与钳位必须落到同一个数');
  assert.equal(IDLE_BACKOFF_MS_MIN, 1, '0ms = 每拍空转（#506 修掉的形状）⇒ 和非法值一样不进闸');

  // 三格的默认值与各自循环模块同源（漂了的后果不是报错，是管理台显示一个不会生效的数）。
  assert.equal(ONBOARDING_IDLE_BACKOFF_MS_DEFAULT, ONBOARDING_LOOP_DEFAULT);
  assert.equal(OFFBOARDING_IDLE_BACKOFF_MS_DEFAULT, OFFBOARDING_LOOP_DEFAULT);
  assert.equal(PROVISIONER_IDLE_BACKOFF_MS_DEFAULT, PROVISIONER_LOOP_DEFAULT);
  assert.equal(RUNTIME_SETTING_REGISTRY[PROVISIONER_IDLE_BACKOFF_MS_KEY].defaultValue,
    PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP,
    '对账那一格「默认 == 业务上限」是钳位语义等价的前提，漂开就要重新论证');

  // 三条 registry 条目逐字段（envVar 必须是循环真正直读的那个名字，不是 registry 起的新名）。
  const loopKeys = Object.keys(RUNTIME_SETTING_REGISTRY).filter((k) => k.startsWith('loop.'));
  assert.equal(loopKeys.length, 3, '本批只迁三个 loop.* 退避旋钮');
  for (const key of loopKeys) {
    const entry = RUNTIME_SETTING_REGISTRY[key];
    assert.equal(entry.key, key);
    assert.ok(Object.isFrozen(entry), `${key} 的条目必须冻结`);
    assert.equal(entry.applyMode, 'hot', `${key} 的全部意义就是不用重启`);
    assert.equal(typeof entry.hint, 'string', `${key} 必须在界面行面上写清值域`);
    assert.ok(entry.hint.length <= 120, `${key} 的 hint 是界面一行小字：实得 ${entry.hint.length} 字`);
  }
  assert.equal(RUNTIME_SETTING_REGISTRY[ONBOARDING_IDLE_BACKOFF_MS_KEY].envVar,
    'ONBOARDING_IDLE_BACKOFF_MAX_MS');
  assert.equal(RUNTIME_SETTING_REGISTRY[OFFBOARDING_IDLE_BACKOFF_MS_KEY].envVar,
    'OFFBOARDING_IDLE_BACKOFF_MAX_MS');
  assert.equal(RUNTIME_SETTING_REGISTRY[PROVISIONER_IDLE_BACKOFF_MS_KEY].envVar,
    'PROVISIONER_IDLE_BACKOFF_MAX_MS');

  // 形状闸（三格同口径）：只认纯十进制数字；`'1e4'` / `' 30000 '` / `'-1'` / 小数 / 布尔都不收。
  for (const bad of ['1e4', ' 30000 ', '-1', '0', '30000.0', '', 30.5, true, null, undefined]) {
    assert.equal(parseOnboardingIdleBackoffMs(bad).ok, false, `开户格收了 ${JSON.stringify(bad)}`);
    assert.equal(parseOffboardingIdleBackoffMs(bad).ok, false, `销号格收了 ${JSON.stringify(bad)}`);
    assert.equal(parseProvisionerIdleBackoffMs(bad).ok, false, `对账格收了 ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(parseOnboardingIdleBackoffMs(60_000), { ok: true, value: 60_000 },
    '上界端点必须收（注释里写了「要更激进就配 60000」）');
  assert.deepEqual(parseProvisionerIdleBackoffMs(5_000), { ok: true, value: 5_000 },
    '5000 = 逃生口（不退避）必须收');
  // 越界拒，且 reason **点名是哪一格**（三格同族 ⇒ 共用 reason 会让人查错循环）。
  assert.equal(parseOnboardingIdleBackoffMs(60_001).reason, 'onboarding_idle_backoff_out_of_range');
  assert.equal(parseOffboardingIdleBackoffMs(60_001).reason,
    'offboarding_idle_backoff_out_of_range');
  assert.equal(parseProvisionerIdleBackoffMs(15_001).reason,
    'provisioner_idle_backoff_out_of_range');
  assert.equal(parseProvisionerIdleBackoffMs(60_000).ok, false,
    '对账格的 60000 是越界（它的上限是业务上限 15000，不是共享上限）');

  // 写侧原因必须点名上界与来历（运维看到「60000」要知道是谁定的）。
  assert.match(validateOnboardingIdleBackoffMs(60_001), /60000/);
  assert.match(validateOffboardingIdleBackoffMs(60_001), /60000/);
  assert.match(validateProvisionerIdleBackoffMs(16_000), /15000/);
  assert.match(validateProvisionerIdleBackoffMs(16_000), /业务承诺|漂移/);
  assert.equal(validateOnboardingIdleBackoffMs(30_000), true);
  assert.equal(validateProvisionerIdleBackoffMs(15_000), true);
  assert.match(validateProvisionerIdleBackoffMs(0), /空转/);

  // **钳位行为保留**（工单点名的一条）：env=60000 走旧路径 ⇒ warn + 钳到 15000；
  // 走新的 registry 闸 ⇒ 拒 + 回落默认 15000。生效值必须**同一个数**，旧路径那条 warn 不许消失。
  const oldWarns = [];
  assert.equal(
    resolveIdleBackoffMaxMs({ log: { warn: (m) => oldWarns.push(String(m)) },
      env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '60000' } }),
    15_000, '旧路径（env 单用）必须仍然钳到业务上限');
  assert.equal(oldWarns.length, 1, `旧路径那条 warn 必须还在（实得 ${JSON.stringify(oldWarns)}）`);
  assert.match(oldWarns[0], /PROVISIONER_IDLE_BACKOFF_MAX_MS/);
  assert.match(oldWarns[0], /15000/);
});

test('RS-50 三个退避旋钮的热读三档：DB > env（过闸）> 默认；越界不绕过钳位', async () => {
  // 好值：env 生效（每格用自己的 env 名，名字写错就是「配了个空气」那一族）。
  invalidateOnboardingIdleBackoffCache();
  assert.equal(await readOnboardingIdleBackoffMaxMs({
    pool: ttlPool(), config: {}, env: { ONBOARDING_IDLE_BACKOFF_MAX_MS: '7500' }, log: silentLog,
  }), 7_500);
  invalidateOffboardingIdleBackoffCache();
  assert.equal(await readOffboardingIdleBackoffMaxMs({
    pool: ttlPool(), config: {}, env: { OFFBOARDING_IDLE_BACKOFF_MAX_MS: '8000' }, log: silentLog,
  }), 8_000);
  // 三档全空 ⇒ 各自默认（30000 / 30000 / 15000），绝不 undefined。
  invalidateProvisionerIdleBackoffCache();
  assert.equal(await readProvisionerIdleBackoffMaxMs({
    pool: ttlPool(), config: {}, env: {}, log: silentLog,
  }), PROVISIONER_IDLE_BACKOFF_MS_DEFAULT);

  // env 越界 ⇒ 回落**本格默认** + 点名 warn：开户 60001 ⇒ 30000（旧路径也是 30000，口径没漂）。
  invalidateOnboardingIdleBackoffCache();
  const overLog = collectingLog();
  assert.equal(await readOnboardingIdleBackoffMaxMs({
    pool: ttlPool(), config: {}, env: { ONBOARDING_IDLE_BACKOFF_MAX_MS: '60001' }, log: overLog,
  }), ONBOARDING_IDLE_BACKOFF_MS_DEFAULT);
  assert.ok(overLog.seen.warn.some((m) => m.includes(ONBOARDING_IDLE_BACKOFF_MS_KEY)
    && m.includes('ONBOARDING_IDLE_BACKOFF_MAX_MS')),
    `要点名是哪一格、哪个 env（实得 ${JSON.stringify(overLog.seen.warn)}）`);

  // 对账那一格是这一族的关键：env=60000 ⇒ **15000**（业务上限），既不是 60000 也不是 30000。
  invalidateProvisionerIdleBackoffCache();
  const capLog = collectingLog();
  assert.equal(await readProvisionerIdleBackoffMaxMs({
    pool: ttlPool(), config: {}, env: { PROVISIONER_IDLE_BACKOFF_MAX_MS: '60000' }, log: capLog,
  }), PROVISIONER_IDLE_BACKOFF_MS_BUSINESS_CAP,
    'env 侧的钳位不许因为搬进 registry 就被绕过（放宽到 4 倍 = 漂移发现延迟被静默改掉）');
  assert.ok(capLog.seen.warn.some((m) => m.includes('PROVISIONER_IDLE_BACKOFF_MAX_MS')),
    `被闸拒了要说话（实得 ${JSON.stringify(capLog.seen.warn)}）`);

  // DB 值优先于 env；DB 值越界 ⇒ 落 env 那一档的好值（不是直接跳默认）。
  invalidateOffboardingIdleBackoffCache();
  const bad = ttlPool({ rows: [{ key: OFFBOARDING_IDLE_BACKOFF_MS_KEY, value: 90_000 }] });
  assert.equal(await readOffboardingIdleBackoffMaxMs({
    pool: bad, config: {}, env: { OFFBOARDING_IDLE_BACKOFF_MAX_MS: '8000' }, log: silentLog,
  }), 8_000, 'DB 坏值 ⇒ 回落 env 那一档（与前面几格同一套 fallback 口径）');
  invalidateOffboardingIdleBackoffCache();
  const good = ttlPool({ rows: [{ key: OFFBOARDING_IDLE_BACKOFF_MS_KEY, value: 12_000 }] });
  assert.equal(await readOffboardingIdleBackoffMaxMs({
    pool: good, config: {}, env: { OFFBOARDING_IDLE_BACKOFF_MAX_MS: '8000' }, log: silentLog,
  }), 12_000, 'DB 好值必须压过 env');
  invalidateOffboardingIdleBackoffCache();

  // 表不在 / 连 pool 都没有 ⇒ 回落 env，绝不抛（循环不许因为配置面坏了停摆）。
  invalidateOnboardingIdleBackoffCache();
  assert.equal(await readOnboardingIdleBackoffMaxMs({
    pool: ttlPool({ throwOnSelect: Object.assign(new Error('no such table'), { code: '42P01' }) }),
    config: {}, env: { ONBOARDING_IDLE_BACKOFF_MAX_MS: '9000' }, log: silentLog,
  }), 9_000);
  assert.equal(await readOnboardingIdleBackoffMaxMs({
    pool: null, config: {}, env: {}, log: silentLog,
  }), ONBOARDING_IDLE_BACKOFF_MS_DEFAULT);
  invalidateOnboardingIdleBackoffCache();
});

test('RS-51 三格各自一份热读实例：值不串、缓存不串、失效不串（共用实例 ⇒ 这一格红）',
  async () => {
    invalidateOnboardingIdleBackoffCache();
    invalidateOffboardingIdleBackoffCache();
    invalidateProvisionerIdleBackoffCache();
    // 同一张表、三个 key、三个不同的数：共用一份实例（同一个 key + 同一份缓存）必拿错数。
    const pool = ttlPool({ rows: [
      { key: ONBOARDING_IDLE_BACKOFF_MS_KEY, value: 11_111 },
      { key: OFFBOARDING_IDLE_BACKOFF_MS_KEY, value: 22_222 },
      { key: PROVISIONER_IDLE_BACKOFF_MS_KEY, value: 12_222 },
    ] });
    const readOn = () => readOnboardingIdleBackoffMaxMs({
      pool, config: {}, env: {}, log: silentLog,
    });
    const readOff = () => readOffboardingIdleBackoffMaxMs({
      pool, config: {}, env: {}, log: silentLog,
    });
    const readProv = () => readProvisionerIdleBackoffMaxMs({
      pool, config: {}, env: {}, log: silentLog,
    });
    assert.equal(await readOn(), 11_111, '开户格读到自己的那一行');
    assert.equal(await readOff(), 22_222, '销号格读到自己的那一行（串到开户那行 = 共用实例）');
    assert.equal(await readProv(), 12_222, '对账格读到自己的那一行');

    // 缓存：同一池 5s 内命中自己那一格，不再发 SQL。
    const afterThree = pool.queryCount;
    assert.equal(await readOn(), 11_111);
    assert.equal(pool.queryCount, afterThree, '5s 内重复读不许再发 SQL');

    // 失效只抹自己那一格：保存销号不该让开户那格重读（「保存 TTL 抹掉保留天数」的同型坑）。
    invalidateOffboardingIdleBackoffCache();
    assert.equal(await readOff(), 22_222);
    assert.equal(pool.queryCount, afterThree + 1, '只有被失效那一格该发 SQL');
    const beforeOther = pool.queryCount;
    assert.equal(await readOn(), 11_111);
    assert.equal(await readProv(), 12_222);
    assert.equal(pool.queryCount, beforeOther,
      '别格被失效不许把这两格的缓存一起抹掉（+N = 三格共用了一份缓存槽）');

    // 换池不串：B 池必须自己读，不吃 A 池的缓存。
    const poolB = ttlPool({ rows: [{ key: PROVISIONER_IDLE_BACKOFF_MS_KEY, value: 6_000 }] });
    assert.equal(await readProvisionerIdleBackoffMaxMs({
      pool: poolB, config: {}, env: {}, log: silentLog,
    }), 6_000);
    assert.equal(poolB.queryCount, 1, 'B 池必须自己发一条');
    invalidateOnboardingIdleBackoffCache();
    invalidateOffboardingIdleBackoffCache();
    invalidateProvisionerIdleBackoffCache();
  });

test('RS-52 三格都登记了写路径失效（HOT_READ_INVALIDATORS 少一行 ⇒ 这一格点名红）', () => {
  assert.equal(HOT_READ_INVALIDATORS.get(ONBOARDING_IDLE_BACKOFF_MS_KEY),
    invalidateOnboardingIdleBackoffCache);
  assert.equal(HOT_READ_INVALIDATORS.get(OFFBOARDING_IDLE_BACKOFF_MS_KEY),
    invalidateOffboardingIdleBackoffCache);
  assert.equal(HOT_READ_INVALIDATORS.get(PROVISIONER_IDLE_BACKOFF_MS_KEY),
    invalidateProvisionerIdleBackoffCache);
  // 通用不变式：每个 `applyMode:'hot'` 的格子都必须有一行失效登记（漏的那一格保存后本进程还吃旧值）。
  const hotKeys = Object.entries(RUNTIME_SETTING_REGISTRY)
    .filter(([, e]) => e.applyMode === 'hot').map(([k]) => k).sort();
  assert.deepEqual([...HOT_READ_INVALIDATORS.keys()].sort(), hotKeys,
    'hot 旋钮的集合必须与失效登记表逐格一致');
});

test('RS-53 §4.21 的三行必须写出默认 / 值域 / 生效点（本批的文档契约，删行或含糊其辞 ⇒ 红）',
  () => {
    const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
    const start = apiDoc.indexOf('### 4.21 管理台运行时设置');
    const end = apiDoc.indexOf('#### `GET /api/admin/runtime-settings`', start);
    assert.ok(start >= 0 && end > start, '§4.21 切片切不到（标题被改了？）');
    const rows = apiDoc.slice(start, end).split('\n').filter((l) => l.startsWith('|'));
    const splitCells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
    const dataRows = rows.slice(2).map(splitCells);
    const rowOf = (key) => {
      const cells = dataRows.find((c) => c[0].replace(/`/g, '') === key);
      assert.ok(cells, `§4.21 少了 ${key} 那一行`);
      return cells.join(' ');
    };
    const onb = rowOf(ONBOARDING_IDLE_BACKOFF_MS_KEY);
    assert.match(onb, /1\.\.60000/, '开户那行必须写值域 1..60000（与 RS-49 同一区间）');
    assert.match(onb, /默认 `?30000`?/, '开户那行必须写默认 30000');
    assert.match(onb, /每一拍|每一 拍/, '开户那行必须写生效点：每一拍决定 sleep 之前现读');
    const off = rowOf(OFFBOARDING_IDLE_BACKOFF_MS_KEY);
    assert.match(off, /1\.\.60000/);
    assert.match(off, /默认 `?30000`?/);
    assert.match(off, /每一拍/);
    const prov = rowOf(PROVISIONER_IDLE_BACKOFF_MS_KEY);
    assert.match(prov, /1\.\.15000/, '对账那行必须写 1..15000（上界是业务上限，不是 60000）');
    assert.match(prov, /默认 `?15000`?/);
    assert.match(prov, /业务上限|业务承诺/, '对账那行必须说明上界是业务上限（不是算术溢出）');
    assert.match(prov, /每一拍/);
  });

// ---------------------------------------------------------------------------
// 13. #677 Tier 2A：四个「无状态、每请求读」的认证旋钮。
//   RS-58 解析/校验（严格十进制正整数 + 各自区间）；RS-59 热读三档 + 坏 env 点名 warn；
//   RS-60 四格各自独立实例（值不串）；RS-61 写路径失效登记齐；RS-62 §4.21 文档行；
//   RS-63 真库腿（无 PG skip）。共享模块级热读缓存 ⇒ 每段前后 invalidate。
// ---------------------------------------------------------------------------
const AUTH_KNOBS = [
  {
    key: PENDING_TOKEN_TTL_SECONDS_KEY, env: 'PENDING_TOKEN_TTL_SECONDS',
    parse: parsePendingTokenTtlSeconds, validate: validatePendingTokenTtlSeconds,
    read: readPendingTokenTtlSeconds, invalidate: invalidatePendingTokenTtlCache,
    min: PENDING_TOKEN_TTL_SECONDS_MIN, max: PENDING_TOKEN_TTL_SECONDS_MAX,
    def: PENDING_TOKEN_TTL_SECONDS_DEFAULT, notReason: 'not_a_pending_token_ttl_seconds',
    envValue: 200, dbValue: 300,
  },
  {
    key: SESSION_RENEW_INTERVAL_SECONDS_KEY, env: 'SESSION_RENEW_INTERVAL_SECONDS',
    parse: parseSessionRenewIntervalSeconds, validate: validateSessionRenewIntervalSeconds,
    read: readSessionRenewIntervalSeconds, invalidate: invalidateSessionRenewIntervalCache,
    min: SESSION_RENEW_INTERVAL_SECONDS_MIN, max: SESSION_RENEW_INTERVAL_SECONDS_MAX,
    def: SESSION_RENEW_INTERVAL_SECONDS_DEFAULT,
    notReason: 'not_a_session_renew_interval_seconds', envValue: 2000, dbValue: 3000,
  },
  {
    key: MAX_PASSWORD_LENGTH_KEY, env: 'MAX_PASSWORD_LENGTH',
    parse: parseMaxPasswordLength, validate: validateMaxPasswordLength,
    read: readMaxPasswordLength, invalidate: invalidateMaxPasswordLengthCache,
    min: MAX_PASSWORD_LENGTH_MIN, max: MAX_PASSWORD_LENGTH_MAX,
    def: MAX_PASSWORD_LENGTH_DEFAULT, notReason: 'not_a_max_password_length',
    envValue: 200, dbValue: 300,
  },
  {
    key: MAX_LOGIN_LENGTH_KEY, env: 'MAX_LOGIN_LENGTH',
    parse: parseMaxLoginLength, validate: validateMaxLoginLength,
    read: readMaxLoginLength, invalidate: invalidateMaxLoginLengthCache,
    min: MAX_LOGIN_LENGTH_MIN, max: MAX_LOGIN_LENGTH_MAX,
    def: MAX_LOGIN_LENGTH_DEFAULT, notReason: 'not_a_max_login_length',
    envValue: 100, dbValue: 200,
  },
];

test('RS-58 Tier 2A 解析/校验：四格严格正整数 + 各自区间；越界拒、垃圾点名 not_*', () => {
  for (const k of AUTH_KNOBS) {
    assert.equal(k.parse(k.min).value, k.min, `${k.key} 下界内`);
    assert.equal(k.parse(k.max).value, k.max, `${k.key} 上界内`);
    assert.equal(k.parse(k.def).value, k.def, `${k.key} 默认值合法`);
    assert.equal(k.parse(k.max + 1).ok, false, `${k.key} 上界+1 拒`);
    assert.equal(k.parse(k.min - 1).ok, false, `${k.key} 下界-1 拒`);
    assert.equal(typeof k.parse(k.max + 1).reason, 'string', `${k.key} 越界给原因`);
    for (const bad of ['1e4', ' 30 ', '-1', '1.5', '', 'abc', true, null, {}, [], NaN]) {
      assert.equal(k.parse(bad).ok, false, `${k.key} 垃圾 ${String(bad)} 拒`);
      assert.equal(k.parse(bad).reason, k.notReason, `${k.key} 类型不符点名 ${k.notReason}`);
    }
    assert.equal(k.validate(k.def), true, `${k.key} 默认合法`);
    assert.equal(typeof k.validate(k.min - 1), 'string', `${k.key} 越下界返原因`);
    assert.equal(typeof k.validate(k.max + 1), 'string', `${k.key} 越上界返原因`);
    assert.equal(typeof k.validate('12'), 'string', `${k.key} 字符串非法`);
    assert.ok(String(k.validate(k.max + 1)).includes(String(k.max)), `${k.key} 越界点名上界`);
  }
});

test('RS-59 Tier 2A 热读三档：DB > env（过闸）> 默认；坏 env ⇒ 默认 + 点名 warn', async () => {
  for (const k of AUTH_KNOBS) {
    k.invalidate();
    const db = await k.read({
      pool: ttlPool({ rows: [{ key: k.key, value: k.dbValue }] }), config: {}, env: {},
      log: silentLog,
    });
    assert.equal(db, k.dbValue, `${k.key} 取 DB 值`);
    k.invalidate();
    const ev = await k.read({
      pool: ttlPool({}), config: {}, env: { [k.env]: String(k.envValue) }, log: silentLog,
    });
    assert.equal(ev, k.envValue, `${k.key} env 过闸生效`);
    k.invalidate();
    const log = collectingLog();
    const dv = await k.read({
      pool: ttlPool({}), config: {}, env: { [k.env]: String(k.max + 1) }, log,
    });
    assert.equal(dv, k.def, `${k.key} 越界 env ⇒ 默认（不采纳坏值）`);
    assert.ok(log.seen.warn.length >= 1, `${k.key} 坏 env 必须点名 warn`);
    k.invalidate();
    assert.equal(
      await k.read({ pool: ttlPool({}), config: {}, env: {}, log: silentLog }),
      k.def, `${k.key} 无 DB 无 env ⇒ 默认`);
    k.invalidate();
  }
});

test('RS-60 Tier 2A 四格各自独立实例：同表四行各读各的、值不串', async () => {
  const rows = AUTH_KNOBS.map((k) => ({ key: k.key, value: k.dbValue }));
  const pool = ttlPool({ rows });
  for (const k of AUTH_KNOBS) k.invalidate();
  for (const k of AUTH_KNOBS) {
    assert.equal(
      await k.read({ pool, config: {}, env: {}, log: silentLog }), k.dbValue,
      `${k.key} 不被别格串值`);
  }
  for (const k of AUTH_KNOBS) k.invalidate();
});

test('RS-61 Tier 2A 四格都登记了写路径失效（少一行 ⇒ 这一格点名红）', () => {
  for (const k of AUTH_KNOBS) {
    assert.equal(HOT_READ_INVALIDATORS.get(k.key), k.invalidate, `${k.key} 必须登记失效钩子`);
  }
  const fns = AUTH_KNOBS.map((k) => HOT_READ_INVALIDATORS.get(k.key));
  assert.equal(new Set(fns).size, 4, '四格必须是四个不同的失效函数（共用 ⇒ 串缓存）');
});

test('RS-62 Tier 2A §4.21 四行必须写出 envVar / 默认 / 值域 / 生效点', () => {
  const apiDoc = fs.readFileSync(new URL('../../docs/api/portal.md', import.meta.url), 'utf8');
  const start = apiDoc.indexOf('### 4.21 管理台运行时设置');
  const end = apiDoc.indexOf('#### `GET /api/admin/runtime-settings`', start);
  const rows = apiDoc.slice(start, end).split('\n').filter((l) => l.startsWith('|')).slice(2);
  for (const k of AUTH_KNOBS) {
    const row = rows.find((r) => r.includes('`' + k.key + '`'));
    assert.ok(row, `§4.21 缺 ${k.key} 那一行`);
    assert.ok(row.includes(k.env), `${k.key} 行必须写 envVar`);
    assert.ok(row.includes('`hot`'), `${k.key} 行必须写 applyMode=hot`);
    assert.ok(new RegExp('默认 `?' + k.def + '`?').test(row), `${k.key} 行必须写默认`);
    assert.ok(new RegExp(k.min + '\\.\\.\\.?' + k.max).test(row), `${k.key} 行必须写值域`);
    assert.ok(/现读/.test(row), `${k.key} 行必须写生效点（现读）`);
  }
});

test('RS-63 Tier 2A 真库腿：保存⇒热读立即新值、删行⇒回落 env、坏行⇒回落不抛（无 PG skip）',
  { skip: PG_SKIP }, async () => {
    assert.ok(pgFixture, 'TEST_DATABASE_URL 给了却没有夹具');
    await pgFixture.withFreshDatabase(async ({ pool }) => {
      await pool.query(
        `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
        [ACTOR, 'w677-t2a-actor'],
      );
      for (const k of AUTH_KNOBS) {
        k.invalidate();
        const envCfg = { [k.env]: String(k.envValue) };
        const read = () => k.read({ pool, config: {}, env: envCfg, log: pgSilent });
        assert.equal(await read(), k.envValue, `${k.key} 无 DB 行 ⇒ env 档`);
        const saved = await saveRuntimeSetting({
          pool, actorId: ACTOR, key: k.key, value: k.dbValue, log: pgSilent,
        });
        assert.equal(saved.value, k.dbValue);
        assert.equal(await read(), k.dbValue, `${k.key} 保存后立即新值（不等 5 秒）`);
        await pool.query('DELETE FROM runtime_settings WHERE key = $1', [k.key]);
        k.invalidate();
        assert.equal(await read(), k.envValue, `${k.key} 删行 ⇒ 回落 env`);
        await pool.query(
          `INSERT INTO runtime_settings (key, value) VALUES ($1, $2::jsonb)`,
          [k.key, '"abc"'],
        );
        k.invalidate();
        assert.equal(await read(), k.envValue, `${k.key} 坏 DB 值 ⇒ 回落 env、不抛`);
        await pool.query('DELETE FROM runtime_settings WHERE key = $1', [k.key]);
        k.invalidate();
      }
    });
  });
