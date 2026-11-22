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
  SESSION_TTL_CACHE_TTL_MS, parseSessionTtlSeconds, validateSessionTtlSeconds,
  readSessionTtlSeconds, invalidateSessionTtlCache, HOT_READ_INVALIDATORS,
  listRuntimeSettingsAdmin,
} from '../src/runtime-settings.js';
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
  assert.equal(values['demo.limit'], undefined, '"1e4" 不许被收成 1（parseInt 那一族，台账 §8.126）');
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
    assert.deepEqual(Object.keys(out).sort(), ['demo', 'demoLimit'], '覆盖层只动 registry 声明过的字段');
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

test('RS-7 P2a 边界：产品 registry 只有**第一格** session.ttl_seconds（其余旋钮仍归 P3）', async () => {
  // P1 时这一格钉的是「registry 是空对象」；P2a 迁了第一格 ⇒ 判据改成「只迁了这一格」。
  // 它红了的读法不变：有人在 P2a 里顺手多迁了一格（或把热读口径弄丢了）。
  assert.deepEqual(Object.keys(RUNTIME_SETTING_REGISTRY), ['session.ttl_seconds'],
    'P2a 只许迁 `session.ttl_seconds`（其余旋钮 P3 逐批填）');
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
  assert.equal(SESSION_TTL_DEFAULT_SECONDS, loadConfig({ MAX_BODY_BYTES: '1024' }).sessionTtlSeconds,
    'registry 默认值必须等于 loadConfig 在干净 env 下算出的那个数');
  const compose = fs.readFileSync(new URL('../../deploy/docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /SESSION_TTL_SECONDS:\s*\$\{SESSION_TTL_SECONDS:-604800\}/,
    'compose 的默认值与本模块同源（P5 退役 env 之前两边不许漂）');

  // 写路径的失效钩子必须接上（M-1 的形状闸那一半：光在 registry 里写 `applyMode: 'hot'` 不算）。
  assert.equal(HOT_READ_INVALIDATORS.get('session.ttl_seconds'), invalidateSessionTtlCache,
    'applyMode=hot 的旋钮必须在 HOT_READ_INVALIDATORS 里登记，否则保存完本进程还要吃 5s 旧值');

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
      `${bad} 必须判为非法 ⇒ 用默认（不许 Number(raw) 了事：Number('1e3') === 1000 是台账 §8.126 那族）`);
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
  // 拒：`Number()` / `parseInt()` 会放进来或算错的那一族（台账 §8.126），加区间外的。
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
  const fromDb = await listRuntimeSettingsAdmin({ pool: dbPool, config: CONFIG_ENV, log: silentLog });
  assert.equal(fromDb.items.length, 1);
  assert.deepEqual(Object.keys(fromDb.items[0]).sort(),
    ['applyMode', 'key', 'label', 'reason', 'source', 'updatedAt', 'updatedBy', 'value'].sort());
  assert.deepEqual(fromDb.items[0], {
    key: SESSION_TTL_KEY, label: '登录会话有效期（秒）', value: 3600, source: 'db', reason: null,
    applyMode: 'hot', updatedAt: at.toISOString(), updatedBy: ACTOR,
  });
  assert.match(dbPool.sqlLog[0], /updated_at/, '管理台那条读要带 updated_*（要能说「谁改的」）');

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
  assert.equal(dead.items.length, 1);
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
