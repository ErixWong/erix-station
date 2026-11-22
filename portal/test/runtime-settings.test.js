// issue #677 P1：`runtime_settings` 底座（DB > env > 默认 的覆盖层）的单测。
//
// 这一单**不迁任何真实旋钮**（那是 P3），所以 `RUNTIME_SETTING_REGISTRY` 在真机上是空对象。
// 于是机制本身只能靠**注入的测试 registry** 来验：每张格子都自带一份 registry，
// 传进 `readRuntimeSettings` / `applyRuntimeOverrides` / `saveRuntimeSetting` 的 `registry` 参数。
// 空 registry 本身也有一格（RS-7）钉住「P1 未迁旋钮」这件事——它红了就说明有人在 P1 里偷迁了。
//
// 判据取自工单 §1④ 的六格（RS-1…RS-6），另加四格钉住 P1 的边界：
//   RS-7 空 registry（P1 现状：一格未迁、启动路径零 SQL）
//   RS-8 迁移 0046 的形状（jsonb / key 形状 CHECK / 零值域 CHECK / 无 BEGIN / 无 FK / baseline 冻结）
//   RS-9 `serve()` 接线（覆盖层在 migrate 之后、createServer 之前，且**所有循环**都用它）
//   RS-10 读侧超时旋钮（`RUNTIME_SETTINGS_READ_TIMEOUT_MS`：只收正整数、且真的传给 setTimeout）
//
// 隔离约定（docs/testing.md §2.1）：本地 fake pool，不碰真实 DB；不起 HTTP。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  RUNTIME_SETTING_REGISTRY, RuntimeSettingsError, isKnownSetting,
  readRuntimeSettings, applyRuntimeOverrides, saveRuntimeSetting,
  readTimeoutMs, DEFAULT_READ_TIMEOUT_MS, READ_TIMEOUT_ENV_VAR,
  AUDIT_ACTION, AUDIT_TARGET_PREFIX,
} from '../src/runtime-settings.js';

const ACTOR = 'd0000000-0000-4000-8000-0000000000a1';

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
 * `sqlLog` / `queryCount` 是给「零写库」「只发一条」那两条判据数的。
 */
class FakeRuntimePool {
  constructor({
    rows = [], throwOnSelect = null, hangOnSelect = false, hangOnWrite = false, returning = null,
    auditRows = 1,
  } = {}) {
    this.rows = rows;
    this.throwOnSelect = throwOnSelect;
    this.hangOnSelect = hangOnSelect;
    this.hangOnWrite = hangOnWrite;
    this.returning = returning;
    this.auditRows = auditRows;
    this.sqlLog = [];
    this.queryCount = 0;
    this.selectCount = 0;
    this.writeCount = 0;
  }

  query(sql, params = []) {
    this.queryCount += 1;
    this.sqlLog.push({ sql, params });
    const isWrite = /\bINSERT\b/i.test(sql);
    if (isWrite) {
      this.writeCount += 1;
      if (this.hangOnWrite) return new Promise(() => {});
      const row = this.returning ?? {
        key: params[1],
        value: JSON.parse(params[2]),
        updated_at: new Date('2026-11-19T00:00:00.000Z'),
        updated_by: params[0],
        previous_value: null,
        audit_rows: this.auditRows,
      };
      return Promise.resolve({ rows: [row] });
    }
    if (/\bruntime_settings\b/i.test(sql)) {
      this.selectCount += 1;
      if (this.hangOnSelect) return new Promise(() => {});
      if (this.throwOnSelect) return Promise.reject(this.throwOnSelect);
      return Promise.resolve({ rows: this.rows });
    }
    return Promise.reject(new Error(`FakeRuntimePool：未预期的 SQL：${sql.slice(0, 80)}`));
  }

  /** 写库那条语句里是否出现 `INSERT`（RS-5 的「零写库」判据）。 */
  insertStatements() {
    return this.sqlLog.filter((s) => /\bINSERT\b/i.test(s.sql));
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
// 3. 写侧：严格 + 一条 SQL + 审计同生共死（口径 3 + 4 + 6）
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
    assert.deepEqual(pool.sqlLog, [], `${name}：sqlLog 必须空`);
    assert.deepEqual(pool.insertStatements(), [], `${name}：零写库（未登记的 key 落库就是永不生效的幽灵行）`);
  }
});

test('RS-6 写 = 一条 SQL：单次 pool.query，DTO 来自 RETURNING，审计与写同一条语句', async () => {
  const pool = new FakeRuntimePool({
    // 故意让 RETURNING 与输入不同 ⇒ DTO 取输入的话必红（口径 4：不信输入）。
    returning: {
      key: 'demo.limit', value: 4242,
      updated_at: new Date('2026-11-19T00:00:00.000Z'),
      updated_by: ACTOR, previous_value: 7, audit_rows: 1,
    },
  });
  const dto = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: silentLog,
  });

  assert.equal(pool.queryCount, 1, `保存必须只发一条 SQL，实发 ${pool.queryCount} 条`);
  assert.equal(pool.selectCount, 0, '保存路径不该再单独发一次 SELECT（旧值在同一条语句里取）');
  const { sql, params } = pool.sqlLog[0];
  for (const fragment of [
    /WITH\s+prev\s+AS\s*\(/i, /FOR\s+UPDATE/i,           // 旧值快照 + 行锁
    /INSERT\s+INTO\s+runtime_settings\b/i,               // upsert
    /ON\s+CONFLICT\s*\(key\)\s+DO\s+UPDATE/i,            // 单行 upsert
    /RETURNING\b/i,                                      // DTO 的来源
    /INSERT\s+INTO\s+audit_log\b/i,                      // 审计与写同生共死
  ]) {
    assert.match(sql, fragment, `那条 SQL 必须含 ${fragment}（缺一样就退回"两个 await"的洞）`);
  }
  assert.equal(params[0], ACTOR, 'actor 是第一个参数（审计的 actor_id）');
  assert.equal(params[1], 'demo.limit', 'key 作为参数送进去（不拼 SQL 文本）');
  assert.equal(params[2], '20', '值以 JSON 文本 + `$3::jsonb` 送进去（SQL 侧不猜类型）');
  assert.equal(params[3], AUDIT_ACTION, '审计动作名必须是 admin.runtime_settings_updated');
  assert.equal(params[4], `${AUDIT_TARGET_PREFIX}:demo.limit`, '审计 target 点名到 key');

  assert.equal(dto.value, 4242, 'DTO 的 value 来自 RETURNING（不是回显输入的 20）');
  assert.equal(dto.key, 'demo.limit');
  assert.equal(dto.updatedAt, '2026-11-19T00:00:00.000Z', 'Date 出参要成 ISO 字符串');
  assert.equal(dto.updatedBy, ACTOR);
  assert.equal(dto.previousValue, 7, '旧值也来自同一条语句的快照');
});

test('RS-6b 审计行不为 1 ⇒ 抛（审计与设置同生共死，不许"设置生效而审计没写"）', async () => {
  const pool = new FakeRuntimePool({ auditRows: 0 });
  const err = await saveRuntimeSetting({
    pool, actorId: ACTOR, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: silentLog,
  }).then(() => null, (e) => e);
  assert.ok(err, 'audit_rows=0 必须抛（那条 CTE 存在的理由就是这件事不可表示）');
  assert.equal(err.httpStatus, 500, '它是内部不一致，不是用户输入错');

  const noRow = new FakeRuntimePool({ returning: null, auditRows: 0 });
  noRow.returning = undefined;
  const err2 = await saveRuntimeSetting({
    pool: { query: () => Promise.resolve({ rows: [] }) },
    actorId: ACTOR, key: 'demo.limit', value: 20, registry: TEST_REGISTRY, log: silentLog,
  }).then(() => null, (e) => e);
  assert.ok(err2, 'RETURNING 空集也必须抛（语句级原子被破坏的形状）');
});

// ---------------------------------------------------------------------------
// 4. P1 的边界：一格未迁、迁移形状、serve() 接线、超时旋钮
// ---------------------------------------------------------------------------

test('RS-7 P1 边界：产品 registry 是**空对象**且冻结 ⇒ 启动路径一格未迁、零 SQL', async () => {
  assert.deepEqual(Object.keys(RUNTIME_SETTING_REGISTRY), [],
    'P1 不许迁任何真实旋钮（P3 才逐批填；这一格红 = 有人在 P1 里偷迁了）');
  assert.ok(Object.isFrozen(RUNTIME_SETTING_REGISTRY), 'registry 必须冻结（运行期没人能塞旋钮进来）');
  assert.equal(isKnownSetting('demo.limit'), false, '真实 registry 里没有 demo.limit');
  assert.equal(isKnownSetting('constructor'), false,
    '`in` 会把 Object 原型上的名字算成已登记 ⇒ 必须走 hasOwn');

  const config = { port: 8080, demo: { intervalMs: 1 } };
  const pool = new FakeRuntimePool();
  const out = await applyRuntimeOverrides(config, { pool, log: silentLog });
  assert.equal(pool.queryCount, 0, '空 registry ⇒ 一次 DB 都不发（P1 的接线不能给启动加往返）');
  assert.deepEqual(out, config, '内容与 config 相同');
  assert.notEqual(out, config, '但仍是新对象');
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
