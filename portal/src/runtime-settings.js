// 运行时配置底座：`runtime_settings` 的**读侧 + 写侧 + config 覆盖层**（issue #677 P1）。
//
// 一句话：把「配置只有 env 一份真相、改一个数字要重建容器」换成「DB 是真相、env 是兜底」，
// 优先级 **`DB > env > 默认`**。env 一条都没少（那是 P5 的退役账），P1 只搬目的地与机制。
//
// 六条硬口径**逐条照抄 `portal/src/upload-settings.js` 的头注释**（#485 那两片把它打磨过，
// 复 audit 的返修尤其别改回去）。为什么照抄而不是自己发明：那是同一形状（DB 存配置 + 读侧
// 永不抛 + 写侧一条 CTE）已经付过账的版本，第二套口径 = 第二本账。
//   1. **优先级 `DB > env > 默认`**，且**读侧永不抛**：表不存在 / DB 抖动 / 值非法 ⇒
//      回落 env（env 也没有 ⇒ registry 的 `defaultValue`）+ 一条**点名 key** 的 `warn`。
//      配置面坏了不许把功能锁死（与 `mail-provider`「读取失败绝不 500」、`upload-settings`
//      口径 1 同一决策）。
//   2. **回落是有意的选择，不是"报错太麻烦"**：写侧（`saveRuntimeSetting`）才是严格闸
//      （非法值当场拒）；读侧遇到"绕过写侧进来的坏行"（手工 `UPDATE`、别的库搬来的行）
//      必须**继续工作**并说清用的是哪个值。⚠ 一律**不许** `Number(raw)` / `parseInt(raw)`
//      了事：`parseInt('1e4') === 1` 那一族（台账 §8.126），半个值静默生效比报错难查十倍。
//   3. **写侧只接受 JSON 标量**（`typeof value` 是 `'number' | 'boolean' | 'string'`）：
//      对象 / 数组 / `null` / `NaN` / `Infinity` / 函数 / `undefined` 一律拒。表是 `jsonb`，
//      存进 `{"a":1}` 读出来就是个对象 —— 类型纪律从列类型退化成 jsonb 之后，这道闸是承重墙。
//   4. **单行 upsert 一条 SQL**（`INSERT … ON CONFLICT (key) DO UPDATE … RETURNING`），
//      响应 DTO 一律来自 `RETURNING`（不信输入）——「保存成功」说的是库里现在的值。
//   5. **读侧带超时**（默认 1500ms，`RUNTIME_SETTINGS_READ_TIMEOUT_MS` 可覆盖；超时按
//      「读不到」处理 ⇒ 回落 + 只留 debug）。⚠ 「永不抛」必须同时覆盖**抛错**（`catch`）与
//      **不返回**（到点没回），只 `catch` 抛错是假口径 —— 不返回就永远进不了 catch
//      （`upload-settings.js` 头注释第 5 条有完整论证：那一单的病根是「每次上传都发的那次
//      读取」，本模块是「每次 `serve()` 都发的那次读取」，同一形状）。
//   6. **写操作与审计同生共死**：一条 CTE 语句里读旧值 + upsert + 写审计（动作名
//      `admin.runtime_settings_updated`），照 `upload-settings.js` 的 `SAVE_SQL` 形状。
//      ⇒ **调用方不得再补 `auth.audit`**（那会把原子性退回成两个 await，还多写一笔审计）。
//
// P1 的边界（别在代码里假装已完成，判据在 `portal/test/runtime-settings.test.js`）：
//   * `RUNTIME_SETTING_REGISTRY` 是**空对象**：一格真实旋钮都没迁（P3 逐批填），机制本身用
//     注入的测试 registry 验。所以 `applyRuntimeOverrides` 在真机上目前一条 SQL 都不发。
//   * 没有 HTTP 端点（`GET/PUT /api/admin/runtime-settings` 与它一起在 P3 落地）。
//   * 迁移 0046 建表；接线在 `cli.js` 的 `serve()`（`migrate()` 之后、`createServer` 之前，
//     且**所有 `start*Loop` 也用覆盖后的 config**，否则覆盖层只对 HTTP 生效）。
//
// env 侧为什么不在这里读：`loadConfig()` 必须保持同步纯函数（口径：DB 读取不许塞进它）。
// env 那一档的值就是**传进来的 `config`**（它已经由 `loadConfig` 算成 `env > 字面默认`）；
// 本模块只负责「DB 可用就压过它」，所以 `env` 参数只是给超时哨兵读的，不是第二份真相。

/** 读侧超时的默认值（毫秒）。口径照 `upload-settings.js` / `platform-prompts.js`：1500ms。 */
export const DEFAULT_READ_TIMEOUT_MS = 1500;

/** 超时可旋钮的名字。⚠ 刻意**没**登记进 compose 的 `station-portal.environment`。 */
export const READ_TIMEOUT_ENV_VAR = 'RUNTIME_SETTINGS_READ_TIMEOUT_MS';

/** 审计动作名（写侧唯一出口；`docs` 的登记随 P3 的端点一起做）。 */
export const AUDIT_ACTION = 'admin.runtime_settings_updated';

/** 审计 target：`runtime_settings:<key>`，一 key 一条 target（照 0046 一行一 key 的表形）。 */
export const AUDIT_TARGET_PREFIX = 'runtime_settings';

/**
 * 旋钮登记表。**P1 保持空对象** —— 一格真实旋钮都没迁（那是 P3）。
 *
 * 条目形状（P3 往里加，一格一条；键名同时是 DB 里的 `key`，受 0046 的 CHECK 约束
 * `^[a-z][a-z0-9_.]{2,63}$`）：
 *
 *   'demo.limit': {
 *     configPath: 'demoLimit',              // 点分路径 ⇒ 只覆盖这一条 config 字段
 *     envVar: 'DEMO_LIMIT',                 // 只用于日志/文档点名，不在这里读 env
 *     defaultValue: 10,                     // 连 env 都没给时的兜底（第三档）
 *     parse(raw) {                          // 读侧：DB 里的 jsonb → 可用值
 *       …return { ok: true, value: n };     //   不可用 ⇒ { ok: false, reason: 'not_a_count' }
 *     },                                    //   ⚠ 不许抛，也不许 `Number(raw)` 了事
 *     validate(value) {                     // 写侧：真值校验（先过 JSON 标量闸）
 *       …return true;                       //   不合格 ⇒ 返回点名的原因字符串
 *     },                                    //   ⇒ 抛 `RuntimeSettingsError`（HTTP 400）
 *   }
 *
 * 三档从哪来（口径 1）：`parse` 出来的 DB 值 > `config[configPath]`（env 那一档，
 * 由 `loadConfig` 算过）> `defaultValue`。
 */
export const RUNTIME_SETTING_REGISTRY = Object.freeze({});

/** 校验/状态类错误：`httpStatus` + `code` + `details.field`（HTTP 层按此映射 400）。 */
export class RuntimeSettingsError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.name = 'RuntimeSettingsError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message, details) {
  throw new RuntimeSettingsError('validation_failed', message, {
    httpStatus: 400,
    details: { field, ...details },
  });
}

/**
 * 每次调用都现读 env（测试能在运行中改；也让超时档位可单独单测）。
 * 只接受**严格十进制正整数**：`1e3` / `' 800 '` / `+5` / `0` / `-5` 一律算非法 ⇒ 默认 + 一条
 * 点名本旋钮的 warn（口径照 `platform-prompts.js`；`Number('1e3') === 1000` 是台账 §8.126 那族）。
 */
export function readTimeoutMs({ env = process.env, log = console } = {}) {
  const raw = env?.[READ_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_READ_TIMEOUT_MS;
  const text = typeof raw === 'string' ? raw : String(raw);
  const parsed = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log?.warn?.(
      `[runtime-settings] ${READ_TIMEOUT_ENV_VAR}=${JSON.stringify(raw)} 不是正整数 ⇒ `
      + `用默认 ${DEFAULT_READ_TIMEOUT_MS}ms（只决定「等多久算读不到」，不改优先级 DB > env > 默认）`,
    );
    return DEFAULT_READ_TIMEOUT_MS;
  }
  return parsed;
}

/** 超时哨兵：与「驱动抛错」**分开**（`reason` 不同 ⇒ 要不要 warn 也不同，见口径 5）。 */
const READ_TIMEOUT = Symbol('runtime-settings-read-timeout');

/**
 * 给一次查询套上截止时间。**只有 race，没有取消**：node-pg 没有「中断一条已发出的查询」的
 * API（真中断要另开连接发 `pg_cancel_backend`），所以超时后那条查询继续挂着，我们不再等它。
 * 定时器**不 `unref()`**：它是「读不到也要按时给答案」的唯一保证（`unref` 过的定时器在事件
 * 循环空了之后不会响 ⇒ promise 永远挂在那儿，测试会挂而不是红）。必 `clearTimeout`。
 */
function withReadTimeout(queryPromise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
  });
  // 传进来的 promise 先包一层：`pool.query` **同步**抛错（连接池已关）也要走 catch。
  return Promise.race([Promise.resolve(queryPromise), deadline])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** 取 config 里点分路径的值（缺段 ⇒ `undefined`，不抛）。 */
function getPath(source, dottedPath) {
  let cursor = source;
  for (const seg of String(dottedPath).split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = cursor[seg];
  }
  return cursor;
}

/** 写点分路径：沿途每一层浅拷贝（不改调用方那个对象），缺段补空对象。 */
function setPath(target, dottedPath, value) {
  const segs = String(dottedPath).split('.');
  let cursor = target;
  for (let i = 0; i < segs.length - 1; i += 1) {
    const prev = Object.prototype.hasOwnProperty.call(cursor, segs[i]) ? cursor[segs[i]] : {};
    cursor[segs[i]] = prev !== null && typeof prev === 'object' ? { ...prev } : {};
    cursor = cursor[segs[i]];
  }
  cursor[segs[segs.length - 1]] = value;
  return target;
}

/**
 * 只认 registry 里的 key。`Object.hasOwn` 而不是 `key in registry`：
 * `registry` 是普通对象，`'constructor' in {}` 为真 ⇒ 未登记的保留名会混进读侧。
 */
export function isKnownSetting(key, registry = RUNTIME_SETTING_REGISTRY) {
  return typeof key === 'string' && Object.hasOwn(registry, key);
}

/**
 * 读侧的一条 SELECT：**整表一次读**，不是 per-key 一次。
 * `value` 是 `jsonb` ⇒ node-pg 直接给 JS 值（对象/字符串/数字/布尔都可能是它）。
 * 整表而不是 `WHERE key = ANY($1)`：读侧要能看见「库里有一行但 registry 不认」这件事
 * （P3 逐批迁时，一行孤儿配置是必须能说出口的形态），而表只装旋钮、行数个位数。
 */
const SELECT_SQL = 'SELECT key, value FROM runtime_settings ORDER BY key';

/**
 * 保存 = **一条**语句做完三件事：读旧值 → upsert → 写审计（口径 6，形状照 0036 的 `SAVE_SQL`）。
 *
 *   1. `prev` **不带 `FOR UPDATE`** —— 这一处**刻意偏离 0036**，理由是 2026-11-19 在
 *      postgres:16.15 上实测的（同一台一次性容器，探针记录见 `portal/test/runtime-settings.test.js`
 *      的 RS-11 与工单报告）：一条**含 data-modifying CTE** 的语句里，锁定读**看不见本语句自己改的
 *      那一行** ⇒ 带上 `FOR UPDATE` 的 `prev` 在真库上恒为**空集**（有旧行、无旧行都是空）。
 *      后果不是「少了个锁」而是**少了一整段**：`previous_value` 恒 `null`，
 *      而 0036 那个形状的主查询是 `FROM upd, prev_eff`（内连接）⇒ 主 SELECT 零行
 *      ⇒ `aud` 那一支也零行 ⇒ 「设置写进去了、审计一行没有」。去掉 `FOR UPDATE` 之后实测
 *      `previous_value` = 真旧值、`audit_log` 恰好 1 行。
 *      ⇒ 谁要把 `FOR UPDATE` 加回来，必须先在真库上证明它不是空集（RS-11 就是那条判据）。
 *   2. `LEFT JOIN prev`（两处）：首写没有旧行（`prev` 天然是空集）。写成内连接的话，审计那一支
 *      会跟着 `upd` 一起空掉 ⇒ 「保存成功但零审计行」，而审计与设置同生共死是这条语句的存在理由。
 *      （实测：无旧行 + 内连接 = `audit_log` 0 行，见上面那组探针的 D 组。）
 *   3. `$3::jsonb`：值由 JS `JSON.stringify(标量)` 送来，SQL 侧不猜类型（口径 3 的另一半）。
 *   4. `RETURNING` 出真落库的那一行 ⇒ 响应 DTO 不信输入（口径 4）。
 *   5. 已知残留（0046 头注释里也记了）：**同一 key 并发写**时 `prev` 取的是本语句快照，
 *      第二写的 `previous_value` 可能是「自己进来之前」的值（写入本身由 `ON CONFLICT` 的行锁串行化，
 *      生效值不受影响）。要收它得给 key 加 advisory lock，别拿 `FOR UPDATE` 收（见第 1 条）。
 */
const SAVE_SQL = `WITH prev AS (
   SELECT value FROM runtime_settings WHERE key = $2
 ), upd AS (
   INSERT INTO runtime_settings (key, value, updated_at, updated_by)
   VALUES ($2, $3::jsonb, now(), $1)
   ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
   RETURNING key, value, updated_at, updated_by
 ), aud AS (
   INSERT INTO audit_log (actor_id, action, target, details)
   SELECT $1, $4::text, $5::text, jsonb_build_object(
            'key', upd.key,
            'value', upd.value,
            'previous_value', prev.value)
     FROM upd LEFT JOIN prev ON true
   RETURNING 1 AS audit_row
 )
SELECT upd.key, upd.value, upd.updated_at, upd.updated_by,
       prev.value AS previous_value,
       (SELECT count(*) FROM aud)::int AS audit_rows
  FROM upd LEFT JOIN prev ON true`;

/**
 * 读全部登记项：**永不抛、永不挂**（口径 1 + 5）。
 *
 * @param {object} opts `{ pool, registry, timeoutMs?, env?, log? }`
 *   `timeoutMs` 缺省时由 `readTimeoutMs()` 现算（读 `RUNTIME_SETTINGS_READ_TIMEOUT_MS`）。
 * @returns {Promise<{values:Record<string,unknown>, problems:Array<{key:string,reason:string}>}>}
 *   `values` 只放**可用**的 DB 值；不可用的 key 一条都不在 `values` 里，
 *   只在 `problems` 里点名（`read_failed` / `read_timeout` / `no_row` / `invalid_db_value`，
 *   四种理由分开：运维的处理动作不一样，报错了就不能互捣）。
 */
export async function readRuntimeSettings({
  pool, registry = RUNTIME_SETTING_REGISTRY, timeoutMs, env = process.env, log = console,
} = {}) {
  const keys = Object.keys(registry);
  const problems = [];
  const values = {};
  if (keys.length === 0) return { values, problems };
  if (!pool || typeof pool.query !== 'function') {
    // 没有池子 = 「读不到」而不是「抛出去」：口径 1，启动路径不许被配置面锁死。
    for (const key of keys) problems.push({ key, reason: 'no_pool' });
    log?.warn?.(`[runtime-settings] 没有可用的 pool ⇒ ${keys.length} 个旋钮全走 env/默认`);
    return { values, problems };
  }
  const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs
    : readTimeoutMs({ env, log });

  let result;
  try {
    result = await withReadTimeout(pool.query(SELECT_SQL), budget);
  } catch (err) {
    // 点名是哪几个 key：值班的人要能一眼看出「现在生效的是哪个来源的值、去哪里改」。
    const detail = [err?.code, err?.message].filter(Boolean).join(' ') || '未知错误';
    log?.warn?.(
      `[runtime-settings] 读 runtime_settings 失败（${detail}）⇒ `
      + `${keys.join(', ')} 回落 env/默认（服务照常起，配置面不承重）`,
    );
    for (const key of keys) problems.push({ key, reason: 'read_failed' });
    return { values, problems };
  }
  if (result === READ_TIMEOUT) {
    // 不 warn：超时是这条路径的常态兜底（服务照常起），一个慢 DB 不该把日志刷满（#520 同族）。
    log?.debug?.(
      `[runtime-settings] 读 runtime_settings 超过 ${budget}ms 未返回 ⇒ `
      + `${keys.join(', ')} 按读不到处理（回落 env/默认）`,
    );
    for (const key of keys) problems.push({ key, reason: 'read_timeout' });
    return { values, problems };
  }

  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const rowByKey = new Map();
  for (const row of rows) {
    if (row && typeof row.key === 'string') rowByKey.set(row.key, row);
  }
  for (const key of keys) {
    if (!rowByKey.has(key)) {
      problems.push({ key, reason: 'no_row' }); // 未配置是常态：不 warn，只登记
      continue;
    }
    const entry = registry[key];
    const raw = rowByKey.get(key).value;
    let parsed;
    try {
      // 注册表的 `parse` 是第三方代码（P3 会写十几份）⇒ 它抛了也不许把读侧弄抛。
      parsed = entry?.parse ? entry.parse(raw) : { ok: false, reason: 'no_parse' };
    } catch (err) {
      parsed = { ok: false, reason: `parse_threw:${err?.message ?? err}` };
    }
    if (parsed?.ok) {
      values[key] = parsed.value;
      continue;
    }
    problems.push({ key, reason: parsed?.reason ?? 'invalid_db_value' });
    // 点名这个 key + 用了哪个值：「DB 有一行但值非法」是运维手工改库的标准后果。
    log?.warn?.(
      `[runtime-settings] runtime_settings 里 ${key} 的值不可用（${parsed?.reason ?? 'invalid_db_value'}）`
      + ` ⇒ 回落 env/默认（config.${String(entry?.configPath ?? '?')}）`,
    );
  }
  return { values, problems };
}

/**
 * 把 DB 侧的值盖到 config 上 ⇒ 返回**新对象**（不改入参：`loadConfig` 的返回值还要被
 * 其它子命令/日志当作「env 真相」看）。
 *
 * 只覆盖 registry 声明过的 config 字段（`configPath`），其余一格一格原样带过去。
 * 读不到（表不存在 / 抖 / 挂住 / 值非法）⇒ 那一格保留 config 里已有的值，
 * config 里也没有 ⇒ 用 registry 的 `defaultValue`。整次读取失败 ⇒ 结果与入参同值。
 *
 * @param {object} config `loadConfig()` 的返回值
 * @param {object} opts   `{ pool, registry?, timeoutMs?, env?, log? }`
 * @returns {Promise<object>} 新的 config（P1 的 registry 为空 ⇒ 内容与入参相同）
 */
export async function applyRuntimeOverrides(config, opts = {}) {
  const { registry = RUNTIME_SETTING_REGISTRY } = opts;
  // 先做一层**顶层**浅拷贝：即使一次覆盖都没发生，返回的也不是入参那个对象引用。
  const next = { ...(config ?? {}) };
  const keys = Object.keys(registry);
  if (keys.length === 0) return next;

  const { values, problems } = await readRuntimeSettings({ ...opts, registry });
  const logger = opts.log;
  const tierByKey = new Map();
  for (const key of keys) {
    const entry = registry[key];
    const path = entry?.configPath;
    if (!path) continue;
    let value;
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      value = values[key];
      tierByKey.set(key, 'db');
    } else {
      // env 那一档 = `config[path]`（`loadConfig` 已算成 `env > 字面默认`）；它也没有 ⇒
      // registry 的 `defaultValue`（第三档）。回落的理由已在 `readRuntimeSettings` 里点过名。
      const envTier = getPath(config, path);
      value = envTier === undefined ? entry?.defaultValue : envTier;
      tierByKey.set(key, envTier === undefined ? 'default' : 'env');
    }
    if (value === undefined) continue; // 三档都给不出值 ⇒ 这一格不动，别发明 undefined
    setPath(next, path, value);
  }
  // 「哪几格走了哪一档」要说得出口（口径 2：回落必须说清用的是哪个值）。`problems` 是回落的
  // 具体理由（表不存在 / 挂住 / 值非法），与档位一起进同一条 debug，排查时一条就够用。
  if (logger?.debug) {
    const why = problems.map((p) => `${p.key}=${p.reason}`).join(', ');
    logger.debug(
      `[runtime-settings] 覆盖层：${tierByKey.size}/${keys.length} 格定了档`
      + (why ? `，回落理由：${why}` : '，无回落'),
    );
  }
  return next;
}

/**
 * 写侧：校验 + **一条** CTE 语句（读旧值 → upsert → 写审计，口径 6）。
 *
 * 三种情况一律**抛**（HTTP 层映射 400），且**一条 SQL 都不发**：
 *   * `key` 不在 registry ⇒ `unknown_setting`（未登记的 key 写进去就是一行永不生效的配置）；
 *   * `value` 不是 JSON 标量 ⇒ `scalar_required`（口径 3）；
 *   * registry 的 `validate` 拒绝 ⇒ `validation_failed`。
 * 成功 ⇒ 返回**来自 `RETURNING`** 的那一行（`{ key, value, updatedAt, updatedBy, … }`）。
 *
 * @param {object} opts `{ pool, actorId?, key, value, registry?, log? }`
 */
export async function saveRuntimeSetting({
  pool, actorId = null, key, value, registry = RUNTIME_SETTING_REGISTRY, log: logger = console,
} = {}) {
  if (!isKnownSetting(key, registry)) {
    throw new RuntimeSettingsError('unknown_setting', `未知的运行时配置项：${String(key)}`, {
      httpStatus: 400,
      details: { field: 'key', known: Object.keys(registry) },
    });
  }
  const entry = registry[key];
  // 标量闸（口径 3）：先于 registry 的 `validate`，且**在发 SQL 之前**——未通过的写一条 SQL 都不发。
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new RuntimeSettingsError('scalar_required',
      `value 只接受 JSON 标量（number / boolean / string），收到 ${typeof value}`, {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  if (value === null || value === undefined || typeof value === 'object') {
    throw new RuntimeSettingsError('scalar_required',
      'value 只接受 JSON 标量，不接受对象 / 数组 / null / undefined', {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new RuntimeSettingsError('scalar_required',
      `value 必须是有限数（收到 ${String(value)}；JSON 也装不下它）`, {
      httpStatus: 400, details: { field: 'value' },
    });
  }
  const why = typeof entry?.validate === 'function' ? entry.validate(value) : true;
  if (why !== true) {
    fail('value', `value 不合格：${String(why ?? '校验失败')}`);
  }

  const written = await pool.query(SAVE_SQL, [
    actorId, key, JSON.stringify(value),
    AUDIT_ACTION, `${AUDIT_TARGET_PREFIX}:${key}`,
  ]);
  const row = written?.rows?.[0] ?? null;
  if (!row) {
    // 语句级原子：没有 `upd` 行就没有审计行。走到这里说明 SQL 形状漂了。
    throw new RuntimeSettingsError('internal', `写入 ${key} 成功却没有 RETURNING 行`, {
      httpStatus: 500,
    });
  }
  if (Number(row.audit_rows) !== 1) {
    // 理论上到不了：`aud` 与 `upd` 在同一条语句里。真出现 = 有人把审计那一支改成可跳过的形状。
    throw new RuntimeSettingsError('internal',
      `保存 ${key} 成功但审计写了 ${row?.audit_rows ?? 0} 行`, { httpStatus: 500 });
  }
  logger?.debug?.(`[runtime-settings] ${key} 已写入（actor=${String(actorId)}）`);
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    updatedBy: row.updated_by ?? null,
    previousValue: row.previous_value ?? null,
    auditRows: Number(row.audit_rows),
  };
}
