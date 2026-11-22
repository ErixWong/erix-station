// 运行时配置底座：`runtime_settings` 的**读侧 + 写侧 + config 覆盖层**（issue #677 P1）。
//
// 一句话：把「配置只有 env 一份真相、改一个数字要重建容器」换成「DB 是真相、env 是兜底」，
// 优先级 **`DB > env > 默认`**。env 一条都没少（那是 P5 的退役账），P1 只搬目的地与机制。
//
// 六条硬口径**照抄 `portal/src/upload-settings.js` 的头注释**（#485 那两片把它打磨过，
// 复 audit 的返修尤其别改回去）。为什么照抄而不是自己发明：那是同一形状（DB 存配置 + 读侧
// 永不抛 + 写侧保存配置）已经付过账的版本，第二套口径 = 第二本账。
// ⚠ **第 4/6 条现在比那边这一份新**：#698 返修把「保存 = 一条 CTE 语句」改成了「保存 = 一个
// 显式事务」（论证见下面第 6 条），本单直接按那个结论落地，不等它合进 main ⇒ 当前分支里的
// `upload-settings.js` 仍是旧的单语句形状，比对时不要把它当参照（那正是本条要修的口径）。
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
//   4. **单行 upsert**（`INSERT … ON CONFLICT (key) DO UPDATE … RETURNING`），响应 DTO 一律来自
//      `RETURNING`（不信输入）——「保存成功」说的是库里现在的值。⚠ 它**不再是「一条 SQL」**：
//      写与审计在**同一个显式事务**里（第 6 条），「一条语句」从来不是本模块的原子性来源。
//   5. **读侧带超时**（默认 1500ms，`RUNTIME_SETTINGS_READ_TIMEOUT_MS` 可覆盖；超时按
//      「读不到」处理 ⇒ 回落 + 只留 debug）。⚠ 「永不抛」必须同时覆盖**抛错**（`catch`）与
//      **不返回**（到点没回），只 `catch` 抛错是假口径 —— 不返回就永远进不了 catch
//      （`upload-settings.js` 头注释第 5 条有完整论证：那一单的病根是「每次上传都发的那次
//      读取」，本模块是「每次 `serve()` 都发的那次读取」，同一形状）。
//   6. **写与审计在同一个事务里**（`BEGIN` → `SELECT … FOR UPDATE` 取旧值 → upsert → 审计 →
//      **在事务内**检查审计行数 === 1 → `COMMIT`；任何一步失败 ⇒ `ROLLBACK` + 抛）。
//      ⇒ **「设置生效而审计没写」不可表示**：审计被静默抑制（trigger `RETURN NULL`、rule）时
//      连设置一起回滚，调用方拿到 500 而库里一格没改（判据：RS-6b 假库 + RS-11 真库 trigger）。
//      ⚠ 旧口径「一条 CTE 语句 = 同生共死」**已作废**（#677 P1 返修，独立审计的两条 MED）：
//        * 单语句里 `audit_rows` 只能在 `pool.query()` **返回之后**判，而那一刻语句**已经提交**
//          ⇒ 审计被抑制时是「报错但设置已生效」，检查不能撤销任何事。
//        * 同一形状的另一半是旧值：一条**含 data-modifying CTE** 的语句里 `FOR UPDATE`
//          **看不见本语句要改的那一行**（真库实测 ⇒ `prev` 恒空集 ⇒ `previous_value` 恒 `null`）
//          ⇒ 「拿行锁」与「写这一行」在一条语句里**不可兼得**（#698 在 `upload-settings.js` 上
//          撞的是同一堵墙，两轮读数都在那边文件头第 6 条里）。
//      ⇒ 与 #698 返修后的 `upload-settings.js#updateUploadSettings` **同形状**：`FOR UPDATE` 单独
//      一条语句，**原子性由事务保证**，不再由「一条语句」保证。
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

/** 孤儿行上报时一条 warn 里最多列几个 key（剩下的只报总数，不刷屏）。 */
const MAX_ORPHAN_KEYS_IN_WARN = 5;

/**
 * 读侧的一条 SELECT：**整表一次读**，不是 per-key 一次。
 * `value` 是 `jsonb` ⇒ node-pg 直接给 JS 值（对象/字符串/数字/布尔都可能是它）。
 * 整表而不是 `WHERE key = ANY($1)`：读侧要能看见「库里有一行但 registry 不认」这件事
 * （P3 逐批迁时，一行孤儿配置是必须能说出口的形态），而表只装旋钮、行数个位数。
 * ⚠ 既然整表读，**读到了就必须说话**（#677 P1 返修 MED①）：registry 不认的行走
 * `unknown_key`（见下面孤儿行那一段），不许只存进 `rowByKey` 然后从不遭提到。
 */
const SELECT_SQL = 'SELECT key, value FROM runtime_settings ORDER BY key';

/**
 * 保存 = **一个显式事务**（口径 6）：`BEGIN` → `PREVIOUS_SQL`（单独一条，带行锁）→ `UPSERT_SQL`
 * → `AUDIT_SQL` → **在事务内检查审计行数** → `COMMIT`。下面三个常量就是事务里的三条语句，
 * **顺序不可改**（形状照 #698 返修后的 `upload-settings.js`，不再照 0036 的单语句 CTE）。
 *
 * 为什么不是以前那条单语句 CTE（两个洞都是实测出来的，不是推想）：
 *   * **审计行数检查只能在语句返回之后做，而那一刻已经提交** ⇒ trigger `RETURN NULL` 把审计
 *     吃掉时，调用方拿到 500 但**设置已生效**（“报错但已生效”）。放进事务后检查在 `COMMIT`
 *     之前 ⇒ 不满足就 `ROLLBACK`，两边一起不落（真库判据：RS-11 的 trigger 那一段）。
 *   * **旧值取不到锁**：一条**含 data-modifying CTE** 的语句里所有 sub-statement 共用同一个
 *     语句级快照 ⇒ `FOR UPDATE` **看不见本语句要改的那一行**。2026-11-19 在 postgres:16.15 上
 *     实测（一次性容器，探针记录见工单报告与 RS-11）：带 `FOR UPDATE` 的 `prev` 恒为**空集**
 *     （有旧行、无旧行都是空）⇒ `previous_value` 恒 `null`。⇒ 单语句里「拿行锁」与「写这一行」
 *     **不可兼得**，只能拆事务：`FOR UPDATE` **单独一条**才既拿得到最新已提交值又拿得到行锁。
 *
 * 四个刻意的细节：
 *   1. `FOR UPDATE` **只能出现在 `PREVIOUS_SQL` 这一条独立语句里**（挪进 `UPSERT_SQL` 就是退回
 *      那个 `previous_value` 恒 `null` 的 500 形状）。它是并发口径的唯一支点：READ COMMITTED 下
 *      它读到的是**最新已提交**的值，并把行锁一直拿到 `COMMIT` ⇒ 并发第二条保存卡在这一句上，
 *      等到的就是前一个写完之后的值（真库判据：RS-11 的「拦路连接」那一段）。
 *   2. `previous_value` **现在由 JS 从 `PREVIOUS_SQL` 那一行取**（不再由 SQL 里的 CTE 算）：
 *      审计里写的与接口返回的是**同一个值**，不存在第二份派生逻辑可漂。
 *   3. `details` 的三个键（`key` / `value` / `previous_value`）与旧 CTE 版逐字相同 ⇒ 已有的审计
 *      查询不受影响；只是不再由 SQL 算出来。`value` 取 `RETURNING` 里那一个（不信输入）。
 *   4. `$2::jsonb`：值由 JS `JSON.stringify(标量)` 送来，SQL 侧不猜类型（口径 3 的另一半）。
 *
 * 已知残留（说在明处）：**同一 key 的首次并发写**（库里还没有那一行）锁不到任何行 ⇒ 两条都可能
 * 把 `previous_value` 记成 `null`（生效值仍由 `ON CONFLICT` 的行锁串行化，不丢）。0046 的头注释里
 * 也记着同一条残留 —— ⚠ 那一段写的是旧 `prev` CTE 的形状，而**已应用的迁移按 sha256 不可改**
 * （`deploy/migrations/README.md`：连注释都不能改）⇒ 它的措辞停在旧形状，**以这里为准**。
 * 要收它得给 key 加 advisory lock，别拿 `FOR UPDATE` 收（见上面第二条）。
 */

/** 事务第 1 条：单独一条锁定读写旧值（无旧行 ⇒ 空集，首写的 `previous_value` 就是 `null`）。 */
const PREVIOUS_SQL = 'SELECT value FROM runtime_settings WHERE key = $1 FOR UPDATE';

/** 事务第 2 条：单行 upsert（口径 4）。响应 DTO 一律来自 `RETURNING`（不信输入）。 */
const UPSERT_SQL = `INSERT INTO runtime_settings (key, value, updated_at, updated_by)
   VALUES ($1, $2::jsonb, now(), $3)
   ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
   RETURNING key, value, updated_at, updated_by`;

/** 事务第 3 条：审计。与 upsert 同一个事务 ⇒ 审计写不进去就**设置也没改**（口径 6）。 */
const AUDIT_SQL = 'INSERT INTO audit_log (actor_id, action, target, details)'
  + ' VALUES ($1, $2, $3, $4)';

/**
 * 读全部登记项：**永不抛、永不挂**（口径 1 + 5）。
 *
 * @param {object} opts `{ pool, registry, timeoutMs?, env?, log? }`
 *   `timeoutMs` 缺省时由 `readTimeoutMs()` 现算（读 `RUNTIME_SETTINGS_READ_TIMEOUT_MS`）。
 * @returns {Promise<{values:Record<string,unknown>, problems:Array<{key:string,reason:string}>}>}
 *   `values` 只放**可用**的 DB 值；不可用的 key 一条都不在 `values` 里，
 *   只在 `problems` 里点名（`read_failed` / `read_timeout` / `no_row` / `invalid_db_value` /
 *   `unknown_key`，五种理由分开：运维的处理动作不一样，报错了就不能互捣）。
 *   `unknown_key` = 库里有这一行但 registry 不认（孤儿行）：它不是某个登记项的回落理由，
 *   而是一行永不生效的配置 ⇒ 单独一个 reason，且只聚合 warn 一次（不逐行刷屏）。
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
  const orphans = new Set();
  for (const row of rows) {
    if (row && typeof row.key === 'string') {
      rowByKey.set(row.key, row);
      // 孤儿行：registry 不认的 key。必须**看得见**（P3 逐批往 registry 加/删条目 ⇒ 删完库里
      // 就剩孤儿行；一行永不生效的配置不说话就是运维的考古题）。
      if (!Object.hasOwn(registry, row.key)) orphans.add(row.key);
    }
    // 其余额外形状（`key` 不是字符串）刻意不当孤儿报：0046 里 `key` 是 `text PRIMARY KEY`（非空），
    // 真表里出不来这种行；拿不准的名字写进 problems 只会污染那份「能按 key 行动」的名单。
  }
  // 孤儿行：进 `problems`（reason=`unknown_key`，逐 key 点名），但**只 warn 一次**（聚合）。
  // 依旧不抛（口径 1）：一行孤儿配置不能把服务钉住；`values` 里也不出现它（不生效）。
  const orphanKeys = [...orphans].sort();
  for (const key of orphanKeys) problems.push({ key, reason: 'unknown_key' });
  if (orphanKeys.length > 0) {
    const shown = orphanKeys.slice(0, MAX_ORPHAN_KEYS_IN_WARN).join(', ');
    const rest = orphanKeys.length > MAX_ORPHAN_KEYS_IN_WARN
      ? `，其余 ${orphanKeys.length - MAX_ORPHAN_KEYS_IN_WARN} 个未列出` : '';
    log?.warn?.(
      `[runtime-settings] runtime_settings 里有 ${orphanKeys.length} 行 registry 不认的 key`
      + `（${shown}${rest}）⇒ 不进覆盖层、也不回落（它们压根没登记；`
      + 'P3 删 registry 条目后库里留下的就是这种行，要人清理）。',
    );
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
 * 写侧：校验 + **一个显式事务**（`BEGIN` → `SELECT … FOR UPDATE` 取旧值 → upsert → 审计 →
 * 事务内检查审计行数 → `COMMIT`，口径 6）。
 *
 * 三种情况一律**抛**（HTTP 层映射 400），且**一条 SQL 都不发、也不从池里借连接**：
 *   * `key` 不在 registry ⇒ `unknown_setting`（未登记的 key 写进去就是一行永不生效的配置）；
 *   * `value` 不是 JSON 标量 ⇒ `scalar_required`（口径 3）；
 *   * registry 的 `validate` 拒绝 ⇒ `validation_failed`。
 * 成功 ⇒ 返回**来自 `RETURNING`** 的那一行（`{ key, value, updatedAt, updatedBy, … }`）。
 *
 * 失败形状：事务里任何一步失败 ⇒ `ROLLBACK` ⇒ **设置一格没改**、审计零行（RS-6b 钉这一点）。
 * 审计被静默抑制（trigger `RETURN NULL` 那类）也算失败：审计行数在 `COMMIT` **之前**判，
 * 所以不存在「设置生效了而审计一行没有」那个窗口（真库判据：RS-11 的 trigger 那一段）。
 * `client.release()` 在 `finally`：报错也不许把连接漏在池外。
 *
 * ⚠ 事务里**不套**读侧超时（`withReadTimeout`）：那套服务的是「读侧永不抛、不许把启动挂住」；
 *   写侧失败本来就是 5xx，给它套超时只会把「已拿到行锁」的写挂成半途状态。
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

  // 事务必须钉在**同一条连接**上：`pool.query()` 每次另借一条连接，`FOR UPDATE` 拿到的行锁会随
  // 那条语句结束而放掉 ⇒ 并发第二条不必等 ⇒ 旧值又是「自己进来之前」的那个（#698 的病根）。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // ① 单独一条锁定读：并发第二条卡在这一句上，等到的就是前一个写完之后的值（口径 6 的支点）。
    const previous = await client.query(PREVIOUS_SQL, [key]);
    const previousValue = previous?.rows?.[0]?.value ?? null;
    // ② 写这一行；`RETURNING` 是响应的唯一真相（口径 4）。
    const written = await client.query(UPSERT_SQL, [key, JSON.stringify(value), actorId]);
    const row = written?.rows?.[0] ?? null;
    if (!row) {
      // upsert 带了 `RETURNING` 却不给行 = SQL 形状漂了（审计也在同一个事务里 ⇒ 一起回滚）。
      throw new RuntimeSettingsError('internal', `写入 ${key} 成功却没有 RETURNING 行`, {
        httpStatus: 500,
      });
    }
    // ③ 审计：与 upsert 同生共死。`details` 的三个键与旧 CTE 版逐字相同；`previous_value` 与接口
    //    返回的是**同一个值**（都由上面那一行锁定读派生 ⇒ 不可能漂）。
    const audited = await client.query(AUDIT_SQL, [
      actorId,
      AUDIT_ACTION,
      `${AUDIT_TARGET_PREFIX}:${key}`,
      JSON.stringify({ key: row.key, value: row.value, previous_value: previousValue }),
    ]);
    // ④ **在 `COMMIT` 之前**检查（这一行就是 MED② 的全部内容）：审计被 trigger/rule 静默抑制时
    //    设置也必须跟着回滚 —— 挪到 `COMMIT` 之后就只能「报错但已生效」了（M-2 两刀点名的就是它）。
    const auditRows = Number(audited?.rowCount ?? 0);
    if (auditRows !== 1) {
      throw new RuntimeSettingsError('internal',
        `保存 ${key} 成功但审计写了 ${audited?.rowCount ?? 0} 行（已 ROLLBACK ⇒ 设置未生效）`,
        { httpStatus: 500 });
    }
    await client.query('COMMIT');
    logger?.debug?.(`[runtime-settings] ${key} 已写入（actor=${String(actorId)}）`);
    return {
      key: row.key,
      value: row.value,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
      updatedBy: row.updated_by ?? null,
      previousValue: previousValue,
      auditRows,
    };
  } catch (error) {
    // `ROLLBACK` 自己失败（连接已断）不许盖掉真正的错误：要报给运维的是那一条。
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
