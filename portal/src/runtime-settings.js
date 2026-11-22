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
//   * `RUNTIME_SETTING_REGISTRY` 自 **P2a** 起有**第一格** `session.ttl_seconds`（其余旋钮仍归 P3 逐批填）。
//     ⇒ `applyRuntimeOverrides` 在真机上从此**每次 `serve()` 发一次读**（不再是零 SQL），
//     启动路径的那一次是**整表一次**、不是每 key 一次（第 3 条）。
//   * HTTP 端点（`GET/PUT /api/admin/runtime-settings`）自 **P2a** 起在 `http.js`（形状在下面的
//     `listRuntimeSettingsAdmin` / `updateRuntimeSettingAdmin`，http 层只做匹配 + 鉴权 + 转发）。
//   * 热读：P2a 只有 `readSessionTtlSeconds` 一格（其余旋钮的热读归 P3 逐批填）。
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
 * 旋钮登记表。P2a 起了第一格 `session.ttl_seconds`，其余归 P3 逐批填。
 *
 * 条目形状（P3 往里加，一格一条；键名同时是 DB 里的 `key`，受 0046 的 CHECK 约束
 * `^[a-z][a-z0-9_.]{2,63}$`）：
 *
 *   'demo.limit': {
 *     label: '演示上限',                     // 人话名字（管理台显示用）；**不是**第二份真相，
 *                                           //   只是 UI 文案，改了不影响行为
 *     configPath: 'demoLimit',              // 点分路径 ⇒ 只覆盖这一条 config 字段
 *     envVar: 'DEMO_LIMIT',                 // 只用于日志/文档点名，不在这里读 env
 *     defaultValue: 10,                     // 连 env 都没给时的兜底（第三档）
 *     applyMode: 'hot',                     // `'hot'` = 下一次读就生效；**其余一律按 `'restart'` 渲染**
 *                                           //   （未知值当 `'restart'` 是安全侧：多提醒一次重启，
 *                                           //   比让人以为已经生效好。渲染侧只认 `'hot'`）
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
 *
 * ⚠ **`applyMode: 'hot'` 的一格必须在这里显式声明**，且写路径要接上失效（见
 * `HOT_READ_INVALIDATORS`）：热读有 5s 缓存，保存后不失效就是「界面保存了、值没变」。
 */

/**
 * 第一格旋钮 `session.ttl_seconds` 的口径（P2a）。
 *
 * 区间两端都是**产品口径**，不是随手拍的数：
 *   * 下限 **60 秒**：比一个小于一分钟的会话更容易出事 —— 会话在每个 `/api/me` 上续期，
 *     续期节流间隔是 `SESSION_RENEW_INTERVAL_SECONDS`（默认 3600s），把 TTL 压到分钟级以下
 *     等于让用户在两次续期之间被踢下线（症状是「页面开着就掉登录」）。
 *   * 上限 **2592000 秒 = 30 天**：再长就是「事实上永不过期」，与 `sessions` 表存在的理由
 *     （可宽限吊销）相冲。
 * 默认 **604800 = 7 天**，与 `config.js` 的 `DEFAULT_SESSION_TTL_SECONDS` 同值（单测钉住同源，
 * 照 `upload-settings.test.js` 的「默认值三处同源」那一格）。
 */
export const SESSION_TTL_KEY = 'session.ttl_seconds';
export const SESSION_TTL_MIN_SECONDS = 60;
export const SESSION_TTL_MAX_SECONDS = 2592000; // 30 天
export const SESSION_TTL_DEFAULT_SECONDS = 604800; // 7 天，与 config.js / compose / docs/env.md 同源

/**
 * 读侧解析（口径 2）：只认「JSON number 里的安全正整数」或「纯十进制数字串」。
 *
 * ⚠ 判定**不靠** `Number(raw)` / `parseInt(raw)`（台账 §8.126）：`'1e4'`、`' 60 '`、`'60s'`、
 * `'0x10'`、`'1.5'`、`''` 全部当场拒。数字串先过 `/^[0-9]+$/` 再转数，转数只是搬运、不是裁决。
 * 区间外也拒（返回点名区间的 reason）：手工 `UPDATE` 成 `5` 的那种行宁可**回落**，
 * 也不要「会话 5 秒就过期」这种查半天的现象（口径照 `upload-settings.js#parseDbMaxFileBytes`：
 * 区间外 = 不可用 = 回落）。
 */
export function parseSessionTtlSeconds(raw) {
  let text;
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) return { ok: false, reason: 'not_a_ttl_seconds' };
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw;
  } else {
    return { ok: false, reason: 'not_a_ttl_seconds' }; // 布尔 / null / 对象 / 数组
  }
  if (!/^[0-9]+$/.test(text)) return { ok: false, reason: 'not_a_ttl_seconds' };
  const value = Number(text); // 上面已经只放纯数字进来 ⇒ 这里只是搬运
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'not_a_ttl_seconds' };
  if (value < SESSION_TTL_MIN_SECONDS || value > SESSION_TTL_MAX_SECONDS) {
    return { ok: false, reason: 'ttl_out_of_range' };
  }
  return { ok: true, value };
}

/**
 * 写侧校验：只收 `number` 类型的安全整数（`'86400'` 这种**字符串**照样拒 —— JSON 标量闸
 * 放得过字符串，真值闸必须拦下，否则界面里填一个带引号的值就静默换了一档）。
 * 合格 ⇒ `true`；不合格 ⇒ 返回点名的原因字符串（上层 `fail()` 负麦 `details.field='value'`）。
 */
export function validateSessionTtlSeconds(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return `必须是 ${SESSION_TTL_MIN_SECONDS}–${SESSION_TTL_MAX_SECONDS} 的整数秒（不接受字符串、小数、布尔）`;
  }
  if (value < SESSION_TTL_MIN_SECONDS || value > SESSION_TTL_MAX_SECONDS) {
    return `必须在 ${SESSION_TTL_MIN_SECONDS}–${SESSION_TTL_MAX_SECONDS} 秒之间（1 分钟 ~ 30 天）`;
  }
  return true;
}

export const RUNTIME_SETTING_REGISTRY = Object.freeze({
  [SESSION_TTL_KEY]: Object.freeze({
    key: SESSION_TTL_KEY,
    label: '登录会话有效期（秒）',
    configPath: 'sessionTtlSeconds',
    envVar: 'SESSION_TTL_SECONDS',
    defaultValue: SESSION_TTL_DEFAULT_SECONDS,
    applyMode: 'hot',
    parse: parseSessionTtlSeconds,
    validate: validateSessionTtlSeconds,
  }),
});

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
    // ⑤ **写完就失效热读缓存**（M-1 点名的就是这一行）。它在 `COMMIT` **之后**：事务 rolled back 时
    //    库里仍是旧值，先失效只会让下一次读再打一次 DB（无害），但会短暂把「写失败」说成
    //    「新值已生效」。查表而不是 `if (key === 'session.ttl_seconds')`：登记表在
    //    `HOT_READ_INVALIDATORS`，P3 加热读旋钮只改那一处。
    HOT_READ_INVALIDATORS.get(key)?.();
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

// ---------------------------------------------------------------------------
// 热读（P2a 第一格：`session.ttl_seconds`）
// ---------------------------------------------------------------------------

/**
 * 热读缓存的存活时间（毫秒）。**5 秒是口径，不是性能参数**：
 * 它定义的是「管理台改了 TTL 之后，最坏多久全部进程都看到新值」这个上界。
 * 不做成 0（每请求现读）是刻意的：`/api/me` 是每个登录用户每个页面加载都要打的一次，
 * 让一次纯配置读挂在那条路径上 = 让 `runtime_settings` 成为登录面的依赖（#520 那一单的病根）。
 */
export const SESSION_TTL_CACHE_TTL_MS = 5000;

/**
 * 单格模块级缓存（形状照 `llm.js` 的 `dataPlaneNameCache`，连**代际号**一起照）：
 * `{ pool, at, resolved }`。键到 pool 是刻意的：测试与多池场景下不许 A 池的读数喂给 B 池。
 */
const sessionTtlCache = { pool: null, at: 0, resolved: null };

/**
 * 缓存代际号，只在 `invalidateSessionTtlCache()` 里自增。为什么必须有（`llm.js` 那一单已经付过账）：
 * 本函数会 `await` 一次 DB 读，await 期间可能有人保存并失效了缓存；等这趟回来，**旧快照**会被
 * 无条件写回缓存 ⇒ 「失效」被这趟在飞的读撤销。读侧在 await **之前**记下代际号，写回时只有
 * 代际没变才落盘；变了就只把结果给当前调用方（它拿到的仍是它自己那趟的真实读数）。
 */
let sessionTtlCacheGeneration = 0;

/**
 * 丢弃 TTL 缓存。**只在写路径调用**（`saveRuntimeSetting` 的 `COMMIT` 之后）。
 *
 * ⚠ 失效只覆盖**本进程**：多副本时别的进程最坏还要吃 5 秒旧值（ TTL 到点自己恢复）。
 *   所以口径是「下一次读、最多 5 秒内生效」，**不是**强一致，也不是「每个请求都现读 DB」。
 */
export function invalidateSessionTtlCache() {
  sessionTtlCacheGeneration += 1;
  sessionTtlCache.pool = null;
  sessionTtlCache.at = 0;
  sessionTtlCache.resolved = null;
}

/**
 * `applyMode: 'hot'` 的旋钮 ⇒ 保存后要失效的缓存。P2a 只有一格；P3 加第二格热读旋钮时在这里
 * 多登记一行，**不要**在 `saveRuntimeSetting` 里堆 `if`（那会把「谁需要失效」摊到两处）。
 */
export const HOT_READ_INVALIDATORS = new Map([[SESSION_TTL_KEY, invalidateSessionTtlCache]]);

/** env 那一档的值：`config[configPath]`（`loadConfig` 已算成 `env > 字面默认`）⇒ 没有则 registry 默认。 */
function envTierValue(entry, config) {
  const tier = getPath(config, entry?.configPath ?? '');
  return tier === undefined ? entry?.defaultValue : tier;
}

/**
 * env 那一档的**来源**（`'env' | 'default'`），给管理台如实显示「当前生效值从哪来」。
 * 优先看 `config[<configPath>Source]`（#485 为 `FILE_UPLOAD_MAX_BYTES` 立的那格：判据是
 * 「env 里有没有显式写这个键」，而不是「它是否等于默认值」——显式写了恰好等于默认值，来源是 env）。
 * 没有这个标注字段（P3 的新条目可能没有）⇒ 退回 P1 的口径：`config` 里有值就算 env，没有算 default。
 */
function envTierSource(entry, config) {
  const flagPath = `${entry?.configPath ?? ''}Source`;
  if (config && Object.hasOwn(config, flagPath)) {
    return config[flagPath] === 'env' ? 'env' : 'default';
  }
  return getPath(config, entry?.configPath) === undefined ? 'default' : 'env';
}

/**
 * 会话 TTL 的**热读**入口（`http.js` 的建会话/续期路径调它）。
 *
 * 口径与 `readRuntimeSettings` 逐字相同（DB 有效值 > env > registry 默认，读侧永不抛），
 * 差别只有两件：① 结果进 5s 缓存；② 只回一个数（调用方是热路径，不关心回落理由）。
 *
 * ⚠ 注释里别写成「每请求现读 DB」：真实形状是**最多 5 秒一次**（同池内命中缓存不发 SQL）。
 *   多副本时最坏 5 秒内各副本读到的值可以不同（本进程保存会立刻失效，别的进程靠 TTL 到点）。
 *
 * @param {object} opts `{ pool, config, now?, log?, env?, registry?, ttlMs?, timeoutMs? }`
 *   `now` / `ttlMs` 可注入 ⇒ 缓存的两端（命中 / 过期）能在假库里判定，不用真等 5 秒。
 * @returns {Promise<number>} 生效的 TTL 秒数；三档都给不出值 ⇒ `SESSION_TTL_DEFAULT_SECONDS`
 *   （绝不回 `undefined`：调用方把它交给 `createSession`，`undefined` 会变成「库里没有 TTL」）
 */
export async function readSessionTtlSeconds({
  pool, config, now = Date.now, log = console, env = process.env,
  registry = RUNTIME_SETTING_REGISTRY, ttlMs = SESSION_TTL_CACHE_TTL_MS, timeoutMs,
} = {}) {
  const entry = registry?.[SESSION_TTL_KEY] ?? RUNTIME_SETTING_REGISTRY[SESSION_TTL_KEY];
  const fallback = () => {
    const value = envTierValue(entry, config);
    return value === undefined ? SESSION_TTL_DEFAULT_SECONDS : value;
  };
  const at = now();
  if (ttlMs > 0 && sessionTtlCache.resolved !== null
    && sessionTtlCache.pool === pool && at - sessionTtlCache.at <= ttlMs) {
    return sessionTtlCache.resolved;
  }
  const generationAtStart = sessionTtlCacheGeneration;
  let value;
  try {
    // 复用整表那一次读（同一份 SQL、同一份超时、同一份永不抛口径）——不另开一条 per-key 的 SELECT。
    const { values } = await readRuntimeSettings({ pool, registry, timeoutMs, env, log });
    const dbValue = values?.[SESSION_TTL_KEY];
    value = Number.isSafeInteger(dbValue) ? dbValue : fallback();
  } catch (err) {
    // 双保险：`readRuntimeSettings` 自己永不抛，但它上面还套着 registry 注入这条缝
    //（假库/假 registry 传进来就是这里的形状）⇒ 热路径一行都不许抛（抛了就是 `/api/me` 500）。
    log?.debug?.(`[runtime-settings] readSessionTtlSeconds 兜底 env/默认（${err?.message ?? err}）`);
    value = fallback();
  }
  if (generationAtStart === sessionTtlCacheGeneration) {
    sessionTtlCache.pool = pool;
    sessionTtlCache.at = at;
    sessionTtlCache.resolved = value;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 管理台读/写（`GET /api/admin/runtime-settings`、`PUT /api/admin/runtime-settings/:key`）
// ---------------------------------------------------------------------------

/**
 * 管理台专用的一条读：比读侧那条多取 `updated_at` / `updated_by`。
 *
 * 为什么不复用上面那条 `SELECT_SQL`：它只有 `key, value`，而管理台要能说「谁在什么时候改的」
 * （#659 那套「一行配置要能说出自己从哪来、被谁改过」的口径）。改它就得动 P1 已审计通过的
 * 读侧 SQL 与它的判据（RS-11 直接钉那条语句的形状），而这条读只在管理台一次点击里发生
 * ⇒ 宁可多一条语句，也不在热路径上多带两个列。**共用的是超时、`parse`、永不抛口径**，
 * 只有列清单不同。
 */
const SELECT_ADMIN_SQL = 'SELECT key, value, updated_at, updated_by FROM runtime_settings ORDER BY key';

/** `Date` ⇒ ISO 字符串（与其它 DTO 的时间字段同形状；拿不到就 `null`，不发明值）。 */
function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' && value ? value : null;
}

/** 一条登记项 ⇒ 响应 DTO（`source` 三档 `db | env | default`，`reason` 只在回落时有点名理由）。 */
function toSettingItem(entry, row, config, fallbackReason = null) {
  const raw = row?.value;
  let parsed = { ok: false, reason: 'no_row' };
  if (row) {
    try {
      parsed = entry?.parse ? entry.parse(raw) : { ok: false, reason: 'no_parse' };
    } catch (err) {
      parsed = { ok: false, reason: `parse_threw:${err?.message ?? err}` };
    }
  }
  const base = {
    key: entry.key,
    label: entry.label ?? entry.key,
    applyMode: entry.applyMode === 'hot' ? 'hot' : 'restart',
    updatedAt: row ? toIso(row.updated_at) : null,
    updatedBy: row?.updated_by ?? null,
  };
  if (parsed?.ok) {
    return { ...base, value: parsed.value, source: 'db', reason: null };
  }
  // 回落：值来自 env 那一档（或 registry 默认），`reason` 说清为什么不是 db。
  // `row` 存在但值非法 ⇒ 保留库里那行的 updated_at/by（它们是真发生过的事），只是值不用它。
  return {
    ...base,
    value: envTierValue(entry, config),
    source: envTierSource(entry, config),
    reason: row ? (parsed?.reason ?? 'invalid_db_value') : (fallbackReason ?? 'no_row'),
  };
}

/**
 * `GET /api/admin/runtime-settings` 的全部内容：**永不抛**（口径 1）。
 *
 * 表不存在 / DB 挂了 / 读超时 ⇒ 仍然 200，每一项的 `source` 落在 `env`/`default` 上并带
 * `reason`（`read_failed` / `read_timeout` / `no_row` / `not_a_ttl_seconds` / `ttl_out_of_range`）。
 * 「管理页打不开」不是配置面坏了该有的后果 —— 打不开就看不到当前用的是哪一档，正是要看的时候。
 *
 * @returns {Promise<{items:Array<object>}>} 顺序 = registry 的声明顺序（稳定，界面不跳）
 */
export async function listRuntimeSettingsAdmin({
  pool, config, registry = RUNTIME_SETTING_REGISTRY, timeoutMs, env = process.env, log = console,
} = {}) {
  const keys = Object.keys(registry);
  const entries = keys.map((key) => registry[key]).filter((entry) => entry?.configPath);
  if (entries.length === 0) return { items: [] };

  let fallbackReason = 'no_pool';
  let rowByKey = new Map();
  if (pool && typeof pool.query === 'function') {
    // 读到东西了 ⇒ 回落的理由是「库里没这一行 / 这一行的值不可用」（`toSettingItem` 里逐 key 定），
    // 不再是「没有池子」。两个理由必须分开：一个是「没配」，一个是「读不到」。
    fallbackReason = 'no_row';
    const budget = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs
      : readTimeoutMs({ env, log });
    let result;
    try {
      result = await withReadTimeout(pool.query(SELECT_ADMIN_SQL), budget);
    } catch (err) {
      fallbackReason = 'read_failed';
      const detail = [err?.code, err?.message].filter(Boolean).join(' ') || '未知错误';
      // 管理页读失败要 warn（有人在屏幕前等答案，不像启动路径那样只能靠 debug）。
      log?.warn?.(`[runtime-settings] 管理台读 runtime_settings 失败（${detail}）`
        + ` ⇒ 各项回落 env/默认并如实标 source（响应仍是 200）`);
    }
    if (result === READ_TIMEOUT) {
      fallbackReason = 'read_timeout';
      log?.debug?.(`[runtime-settings] 管理台读 runtime_settings 超过 ${budget}ms 未返回`
        + ' ⇒ 各项回落 env/默认并如实标 source');
    } else if (result && Array.isArray(result.rows)) {
      for (const row of result.rows) {
        if (row && typeof row.key === 'string') rowByKey.set(row.key, row);
      }
    }
  } else {
    log?.warn?.('[runtime-settings] 管理台读没有可用的 pool ⇒ 各项回落 env/默认并如实标 source');
  }
  return { items: entries.map((entry) => toSettingItem(entry, rowByKey.get(entry.key), config, fallbackReason)) };
}

/** 保存后的 DTO：值/时间/人**只来自 `RETURNING`**（口径 4），`label`/`applyMode` 是 registry 的静态元数据。 */
function toSavedItem(entry, saved) {
  return {
    key: saved.key,
    label: entry?.label ?? saved.key,
    value: saved.value,
    source: 'db',
    reason: null,
    applyMode: entry?.applyMode === 'hot' ? 'hot' : 'restart',
    updatedAt: saved.updatedAt ?? null,
    updatedBy: saved.updatedBy ?? null,
  };
}

/**
 * `PUT /api/admin/runtime-settings/:key` 的转发器（形状照 `platform-prompts.js#adminUpdatePrompt`：
 * **形状闸只有一份，全在这里，http 只是匹配 + 鉴权 + 转发**）。
 *
 * 返回 `{ item, previousValue }`：`item` 是给前端的 DTO，`previousValue` 只进 debug/日志，
 * 响应体里**刻意没有它**（前端不显示，而多一个字段就是多一个要维护的形状；库里与审计里都有）。
 *
 * 审计已由 `saveRuntimeSetting` 在同一个事务里写好 ⇒ **调用方不得再补 `auth.audit`**。
 */
export async function updateRuntimeSettingAdmin({
  pool, actorId = null, key, value, registry = RUNTIME_SETTING_REGISTRY, log = console,
} = {}) {
  const saved = await saveRuntimeSetting({ pool, actorId, key, value, registry, log });
  const entry = Object.hasOwn(registry, saved.key ?? key) ? registry[saved.key ?? key] : null;
  return { item: toSavedItem(entry, saved), previousValue: saved.previousValue };
}
