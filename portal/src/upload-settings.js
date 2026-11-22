// 单文件上传上限的**读侧 + 写侧**（issue #485 片 A，契约 docs/api/portal.md §4.14 / §4.15）。
//
// 一句话：`FILE_UPLOAD_MAX_BYTES` 从「启动期 env」降级成「兜底值」，真相搬到 `upload_settings` 单行表
// （迁移 0035），管理台可改，**每次上传现读** ⇒ 改完立即生效，不需要重启 portal。
//
// 形状照 `mail_settings`（迁移 0026 + `portal/src/mail-settings.js`）这个先例，两点刻意不同：
//   1. **没有 60s 缓存**。`mail-provider` 要缓存是因为登录是热路径；上传不是——一次上传多一次
//      `SELECT`（按 `id = 1` 取一行：无 JOIN、无扫描、命中主键）换「改完立即生效」这条判据，是划算的。
//      加了缓存就等于把「必须重启」换成「必须等一分钟」，判据没被满足，只是换了个等待理由。
//      ⚠ 这条论证**不带毫秒数**：本仓没量过这条查询的耗时，写死数字就是代码证明不了的声称（台账 §8.136）。
//      取舍也不依赖它——要判断的是「一次额外的单行查询」换「改完立即生效」值不值，不是「几毫秒够不够快」。
//   2. 因此写侧**不需要** `invalidate()`：没有缓存可失效。
//
// 六条硬口径（都有对应用例，别改回去；5/6 是 2026-11-17 复 audit 的返修，1–4 是原片）：
//   1. **优先级 `DB > env > 默认 32 MiB`**，且**读侧永不抛**：表不存在 / DB 抖动 / 值非法 ⇒
//      回落 env（env 也没有 ⇒ 默认）+ 一条**点名两个旋钮**的 warn。上传不许因为配置面而变 500
//      （与 `mail-provider` 口径 2「读取失败绝不 500」同一决策：运维故障不该把功能锁死）。
//   2. **回落是有意的选择，不是"报错太麻烦"**：写侧（管理台保存）才是严格闸（区间外当场 400）；
//      读侧遇到"绕过写侧进来的坏行"（手工 `UPDATE`、别的库搬来的行、以后放宽了区间）必须**继续工作**
//      并说清楚用的是哪个值。所以：`0` / 负数 → DB 的 `CHECK (max_file_bytes > 0)` 当场拒；
//      区间外的值（例：手工设成 8 TiB）→ 读侧回落 + warn；`'1e7'` / `' 100 '` / 非纯数字字符串 →
//      同样回落（列类型是 bigint，出现这种形状说明 schema 漂了，不能猜它想表达什么）。
//      ⚠ 一律**不许** `Number(raw)` / `parseInt(raw)` 了事：`parseInt('1e4') === 1` 那族（台账 §8.126）。
//   3. **写侧只接受 JSON number**（`typeof === 'number'` + `Number.isSafeInteger`），字符串一律 400：
//      HTML `number` input 空值给的是 `''`，`Number('') === 0` ⇒ 不拦就是把「没填」存成 1 字节上限。
//   4. **单行 upsert**（`INSERT … ON CONFLICT (id) DO UPDATE`，id 恒 1），与 0026 同一手法；
//      响应 DTO 一律来自 `RETURNING`（不信输入），所以「当前生效值」说的是**真落库的那个数**。
//   5. **那次读取带超时**（`UPLOAD_SETTINGS_READ_TIMEOUT_MS`，默认 1500ms ⇒ `docs/env.md` §10.1）。片 A 的取舍是
//      「每次上传现读、不缓存」，于是「查询发出去而**不返回**」= 每次上传都挂住（前端逐文件上传 ⇒ N 文件
//      N 次读）。「永不抛」必须同时覆盖**抛错**（`catch` → `read_failed`）与**不返回**（超时 → `read_timeout`），
//      少后者那条硬口径就是假的。超时按「读不到」处理：回落 env/默认、上传照常、只留 debug 不刷 warn。
//   6. **保存 = 一条 SQL 语句**（`SAVE_SQL` 那条 CTE：读旧值 + upsert + 写审计）。审计与设置必须同生共死，
//      旧值必须来自同一语句的快照：分开发就是「并发保存记错 `previous_*`」与「设置已生效而审计没写」两个洞。
//      ⇒ 调用方（`http.js`）**不得**再补 `auth.audit`。用例：US-15/16/17（活一）、US-18/19/20/21（活二）。

/** 与 `config.js` 的 `fileUploadMaxBytes` 默认值必须同数（32 MiB）；compose 里第三处同值。 */
export const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;

/** 管理台允许的区间下限：1 MiB（再小就传不动任何真实素材）。 */
export const MIN_MAX_FILE_BYTES = 1024 * 1024;

/**
 * 管理台允许的区间上限：1 GiB。
 * ⚠ 工单原文写的是「`≤ MAX_BODY_BYTES 上限`」，那条**照字面不可满足**：`MAX_BODY_BYTES` 默认
 * 64 KiB（`docs/env.md`），比 1 MiB 的下限还小 ⇒ 区间是空集。原因不是笔误而是口径错配——
 * 上传**根本不走** `readJsonBody`（`http.js#handleFileUpload` 的注释：走它任何真实文件都会 413），
 * 两个旋钮量的是不同的东西。这里取一个明确的产品天花板（1 GiB = 32 × 默认值），并在文档里写明
 * 它与 `MAX_BODY_BYTES` 无关；要放宽就改这一个常量。
 */
export const MAX_MAX_FILE_BYTES = 1024 * 1024 * 1024;

// `::text` 是刻意的：node-pg 对 int8 本来就回字符串，显式转 text 让「我们拿到的是字符串、要自己严格解析」
// 这件事写在 SQL 里，而不是靠驱动行为（口径同 #390-A：不靠默认行为兜住语义）。
const SELECT_SQL = 'SELECT max_file_bytes::text AS max_file_bytes, updated_at, updated_by FROM upload_settings WHERE id = 1';

/**
 * 读侧超时（复 audit 活一）：`upload_settings` 那次读取**每次上传都发**（无缓存是片 A 的取舍），
 * 所以一次「查询发出去但永远不返回」的 DB 会把**每一次上传**挂住 —— 只 `catch` 抛错是不够的：
 * 不返回就永远进不了 catch。#520 刚为降 DB 负载做了一整单，这条路径的挂载面比看起来大得多
 * （前端逐文件上传 ⇒ N 个文件 N 次读取）。
 *
 * 默认 1500ms 是**定性**选的：远大于一次正常读取（按 `id = 1` 取一行）所需的往返，又小于一次可接受的
 * 上传等待，量级对齐 `mail-provider` 那几个 `*_TIMEOUT_MS`。要改它就照这两条边界重估（别拿旧值凑倍数），
 * 也**别顺手补一个「单次查询 <Xms」**——本仓没量过（台账 §8.136）。
 * 超时**不是错误**：按「读不到」回落 env/默认，上传照常（与既有 `read_failed` 完全同口径，见 `resolveFromRow`）。
 */
export const DEFAULT_READ_TIMEOUT_MS = 1500;

/** 超时可旋钮（`docs/env.md` §10.1 已登记）。只接受正整数，给了别的形状 ⇒ 默认 + 一条 warn。 */
export const READ_TIMEOUT_ENV_VAR = 'UPLOAD_SETTINGS_READ_TIMEOUT_MS';

/**
 * 超时哨兵：和「驱动抛错」**分开**——两者的 `reason` 不同（`read_timeout` / `read_failed`），
 * 要不要 warn 也不同（抛错是运维故障，值得 warn；超时是这条路径的**常态兜底**，只留 debug，
 * 否则一个慢 DB 会把日志刷满，而 #520 那一单要的正是少发消息）。
 */
const READ_TIMEOUT = Symbol('upload-settings-read-timeout');

/** 每次调用都现读 env（测试要能在运行中改；也让 `readTimeoutMs` 可单独单测）。 */
export function readTimeoutMs({ env = process.env, log = console } = {}) {
  const raw = env?.[READ_TIMEOUT_ENV_VAR];
  if (raw === undefined || raw === '') return DEFAULT_READ_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    log?.warn?.(
      `[upload-settings] ${READ_TIMEOUT_ENV_VAR}=${JSON.stringify(raw)} 不是正整数 ⇒ 用默认 ${DEFAULT_READ_TIMEOUT_MS}ms`
      + '（只影响等多久算「读不到」，不改优先级 DB > env > 默认）',
    );
    return DEFAULT_READ_TIMEOUT_MS;
  }
  return parsed;
}

/**
 * 给一次查询套上截止时间。**只有 race，没有取消**：node-pg 没有「中断一条已发出的查询」的 API
 * （真要中断得发 `pg_cancel_backend`，那是另一个连接、另一笔账），所以超时后那条查询继续挂着，
 * 我们只是不再等它。这是刻意的取舍，不是漏了 cancel —— 判据是「上传不许被挂住」，不是「连接必须回收」。
 * 定时器 `unref()` 且必 `clearTimeout`：不给进程留尾巴（测试里挂一个未 ref 的定时器就够拖住退出）。
 */
function withReadTimeout(queryPromise, timeoutMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    // ⚠ **不 `unref()`**：这个定时器是「读不到也要按时给答案」的唯一保证，事件循环空了它也得能响
    // （`unref` 过的定时器会让整个等待在事件循环里没有句柄 ⇒ `Promise` 永远挂在那儿）。
    // 代价只是「读挂住时进程多活最多 `timeoutMs`」，而那正是我们要的语义。
    timer = setTimeout(() => resolve(READ_TIMEOUT), timeoutMs);
  });
  // ⚠ 传进去的 promise 先包一层 `Promise.resolve`：`pool.query` 同步抛错（连接池已关）也要走 catch。
  return Promise.race([Promise.resolve(queryPromise), deadline])
    .finally(() => { if (timer) clearTimeout(timer); });
}

/** 审计：action/target 与 `docs/api/portal.md` §4.15-4 登记的必须一致（改这里就要改文档）。 */
export const AUDIT_ACTION = 'admin.upload_settings_updated';
export const AUDIT_TARGET = 'upload_settings';

/**
 * 保存 = **一条**语句做完三件事：读旧值 → upsert → 写审计（复 audit 活二）。
 *
 * 为什么必须是一条：原来 `updateUploadSettings` 里 `SELECT` → `UPSERT`，`http.js` 再 `await auth.audit()`，
 * 三个 await 之间谁都可能插进来：
 *   * 两个管理员同时保存 ⇒ 两边都先读到同一个旧值 ⇒ 后写那条的 `previous_*` 记的是**它进来之前**的数，
 *     事后看审计就看不出「谁把谁改成了谁」——审计存在的唯一理由。
 *   * 审计 `INSERT` 失败（连接断、`audit_log` 被锁、迁移没跑）⇒ 设置**已经生效**而审计一行没有，
 *     而且响应是 200（`audit` 在 `sendJson` 之前抛的话是 500，但设置照样已经改了 —— 更糟）。
 * 一条语句就同时收掉这两个洞：语句级原子（要么全生效要么全不生效），旧值取的是**本语句的快照**。
 *
 * 三个刻意的细节：
 *   1. `prev` **不许**带 `FOR UPDATE`（#698 真库实测，别改回去）。理由不是「不需要锁」，而是**加了也拿不到
 *      旧值**：同一条语句里所有 sub-statement 共用**同一个语句级快照**，而这条语句自己含 data-modifying
 *      CTE（`upd`）——带锁的 `prev` 因此看不见 `upd` 正要改的那一行，实测 `prev` **恒空集**（postgres:16：
 *      二写 `previous_raw=null`、`rowCount=0`、`audit_rows=0` ⇒ 管理台恒 500 而值已落库）。真要行级串行化
 *      得把「读旧值」拆成独立语句 + 显式事务，那是另一套口径（且会退回「设置改了而审计没写」的窗口）。
 *      接受的代价：两条**真重叠**的保存可能都记同一个 `previous_*`（快照语义）；US-19 在 fake 里测的串行
 *      链不等于真库并发语义，真库侧的判据是 `portal/test/upload-settings-real-db.test.js`。
 *   2. `aud` 与主查询都必须 `LEFT JOIN prev_eff ON true`（#698 的另一半，与上面那条**各自独立**）：
 *      首写时 `upload_settings` 里没有旧行 ⇒ `prev_eff` 是空集，写成 `FROM upd, prev_eff`（内连接）会把
 *      `upd` 那一行一起吃掉 ⇒ 主查询 0 行（调用方按「读回不可用」判 500）、审计一行不写，而**值已落库**。
 *      `prev` 至多一行（`WHERE id = 1` 命中主键）⇒ `LEFT JOIN … ON true` 不会把行数放大成多行。
 *   3. 「DB 旧值可用不可用」的判定在 SQL 里只做**区间比较**（`BETWEEN $5 AND $6`，两个数字是参数，
 *      由 JS 常量传进来 ⇒ 常量仍然只有一处）。旧值取自 `bigint` 列 ⇒ 文本必是纯数字，所以这条比较与
 *      JS 侧 `parseDbMaxFileBytes` 在这条路径上等价；等价性由 `portal/test/upload-settings.test.js`
 *      的 US-20 钉住（SQL 派生的 previous_* 与 JS 派生的必须逐值相同），不是靠注释声明。
 *      ⚠ 首写（无旧行）时 SQL 侧走的是 `LEFT JOIN` 出来的 NULL（审计记 `previous_max_bytes=null`），
 *      而 JS 侧 `previous` 回的是兜底值（`env`/`default`）—— 这一格两边**刻意不同形**，由真库用例第 1 格钉住。
 *   4. `details` 的键与旧实现（`http.js` 里手写的 `auth.audit`）逐字相同，事后审计查询不受影响。
 */
const SAVE_SQL = `WITH prev AS (
   SELECT max_file_bytes::text AS raw FROM upload_settings WHERE id = 1
 ), prev_eff AS (
   SELECT prev.raw AS raw,
          CASE WHEN prev.raw IS NOT NULL AND prev.raw::bigint BETWEEN $5 AND $6
               THEN prev.raw::bigint ELSE $3 END AS max_bytes,
          CASE WHEN prev.raw IS NOT NULL AND prev.raw::bigint BETWEEN $5 AND $6
               THEN 'db' ELSE $4 END AS source
     FROM prev
 ), upd AS (
   INSERT INTO upload_settings (id, max_file_bytes, updated_at, updated_by)
   VALUES (1, $1, now(), $2)
   ON CONFLICT (id) DO UPDATE
      SET max_file_bytes = EXCLUDED.max_file_bytes,
          updated_at = now(),
          updated_by = EXCLUDED.updated_by
   RETURNING max_file_bytes::text AS max_file_bytes, updated_at, updated_by
 ), aud AS (
   INSERT INTO audit_log (actor_id, action, target, details)
   SELECT $2, $7::text, $8::text, jsonb_build_object(
            'max_file_bytes', upd.max_file_bytes::bigint,
            'previous_max_bytes', prev_eff.max_bytes,
            'previous_source', prev_eff.source)
     FROM upd LEFT JOIN prev_eff ON true
   RETURNING 1 AS audit_row
 )
SELECT upd.max_file_bytes::text AS max_file_bytes, upd.updated_at, upd.updated_by,
       prev_eff.raw AS previous_raw,
       (SELECT count(*) FROM aud)::int AS audit_rows
  FROM upd LEFT JOIN prev_eff ON true`;

/** 校验/状态类错误：`httpStatus` + `details.field`（`http.js` 的统一信封按此映射）。 */
export class UploadSettingsError extends Error {
  constructor(code, message, { httpStatus = 400, details } = {}) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function fail(field, message, details) {
  throw new UploadSettingsError('validation_failed', message, {
    httpStatus: 400,
    details: { field, min_bytes: MIN_MAX_FILE_BYTES, max_bytes: MAX_MAX_FILE_BYTES, ...details },
  });
}

function isoOrNull(value) {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/** env 侧是否**显式**给了这个变量（给了但非法也算给了 ⇒ 见 `envFallback`）。 */
export function envIsExplicit(config = {}) {
  return config?.fileUploadMaxBytesSource === 'env';
}

/**
 * env / 默认这一档的兜底值。**永远返回一个区间外的原始值也照用的正整数**：
 * `config.fileUploadMaxBytes` 本身已由 `intEnv` 保证「正整数或默认」，这里只再挡一次非有限值
 * （config 被调用方少传时不能回出 `undefined`，那会让上传的 `maxBytes` 变成 undefined ⇒ 无上限）。
 */
export function envFallbackBytes(config = {}) {
  const raw = Number(config?.fileUploadMaxBytes);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_BYTES;
}

/**
 * DB 里的值 → 可用的字节数；**不可用返回 `null`**（不抛）。
 *
 * 只接受「纯十进制数字串」且落在产品区间内。以下一律 `null`：
 * `null` / `''` / `'1e7'` / `' 100 '` / `'-1'` / `'0'` / `1.5` / `NaN` / 超过 `Number.MAX_SAFE_INTEGER`
 * / 区间外的值（例：手工 UPDATE 成一个比管理台天花板还大的数）。
 * 数字入参也走同一条路（`String(1048576)` 命中纯数字），所以 fake pool 直接给 number 与真库给字符串同形。
 */
export function parseDbMaxFileBytes(raw) {
  if (raw === null || raw === undefined) return null;
  const text = typeof raw === 'number' ? (Number.isInteger(raw) ? String(raw) : '') : String(raw);
  if (!/^[0-9]+$/.test(text)) return null; // '1e7' / ' 100 ' / '0x10' / '1.5' / '-1' 全在这里挡掉
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null; // int8 存得下但 JS 已不精确 ⇒ 不猜
  if (value < MIN_MAX_FILE_BYTES || value > MAX_MAX_FILE_BYTES) return null; // 区间外 = 不可用
  return value;
}

/**
 * 从「已读到的行」算生效值（纯函数，不含 IO ⇒ 单测直接钉优先级）。
 *
 * @param {object} [opts] `{ config, readError, timedOut }`：`readError` 是真库**抛错**时带上的错，
 *   `timedOut` 是「查询发出去了但到点没回」。三种回落理由必须分开（`read_failed` / `read_timeout` / `no_row`）：
 *   表/连接坏了、DB 卡住、真的未配置——运维的处理动作不一样，报错了就不能互捣。
 * @returns {{ maxBytes:number, source:'db'|'env'|'default', reason:string|null, dbMaxFileBytes:number|null }}
 *   `source` 就是管理台要显示的「来源」。
 */
export function resolveFromRow(row, { config = {}, readError = null, timedOut = false } = {}) {
  const dbMaxFileBytes = parseDbMaxFileBytes(row?.max_file_bytes);
  if (dbMaxFileBytes !== null) {
    return { maxBytes: dbMaxFileBytes, source: 'db', reason: null, dbMaxFileBytes };
  }
  const fallback = envFallbackBytes(config);
  const source = envIsExplicit(config) ? 'env' : 'default';
  // 超时排在 `no_row` 前面：到点没回时 `row` 也是 `null`，报 `no_row` 就是把「DB 卡住」说成
  // 「管理台还没配过」（运维会去配一个值，而真故障在连接上）。
  const reason = timedOut ? 'read_timeout' : readError ? 'read_failed' : (row ? 'invalid_db_value' : 'no_row');
  return { maxBytes: fallback, source, reason, dbMaxFileBytes: null };
}

/**
 * 读 DB 一行；**永不抛、永不挂**。
 *
 * 两层兜底缺一不可（复 audit 活一）：
 *   * `catch`：驱动**抛错**（表不存在、连接拒绍）——旧实现只有这一层。
 *   * **超时**：驱动**不返回**（连接挂住、服务端不答）——旧实现没有，而这是**每次上传都发**的那次读取
 *     （前端逐文件上传 ⇒ N 个文件 N 次读取），一次挂住就是把上传挂住。没有这一层，「永不抛」是假的。
 * 两种情况的 `reason` 不同（`read_failed` / `read_timeout`），要不要 warn 也不同（抛错 warn，超时只 debug）。
 */
async function readRow({ pool, log = console, timeoutMs = readTimeoutMs({ log }) } = {}) {
  let result;
  try {
    result = await withReadTimeout(pool.query(SELECT_SQL), timeoutMs);
  } catch (err) {
    // 点名两个旋钮：值班的人要能一眼看出「现在生效的是哪个来源的值、去哪里改」。
    log?.warn?.(
      '[upload-settings] 读 upload_settings.max_file_bytes 失败，回落 FILE_UPLOAD_MAX_BYTES/默认值（上传不受影响）：'
      + `${err?.message ?? err}`,
    );
    return { row: null, error: err?.code ?? err?.message ?? 'read_failed' };
  }
  if (result === READ_TIMEOUT) {
    // 不 warn：超时是这条路径的常态兜底（上传照常），一个慢 DB 不该把日志刷满（#520 同族）。
    log?.debug?.(
      `[upload-settings] 读 upload_settings.max_file_bytes 超过 ${timeoutMs}ms 未返回，`
      + '按读不到处理（回落 FILE_UPLOAD_MAX_BYTES/默认值，上传不受影响）',
    );
    return { row: null, error: 'read_timeout', timedOut: true };
  }
  return { row: result?.rows?.[0] ?? null };
}

/**
 * 上传端点的取数入口：**每次上传现读**（无缓存 ⇒ 管理台改完立即生效）。
 *
 * @returns {Promise<{maxBytes:number, source:'db'|'env'|'default', reason:string|null}>}
 */
export async function resolveEffectiveMaxFileBytes({ pool, config = {}, log = console } = {}) {
  const { row, error, timedOut } = await readRow({ pool, log });
  return resolveFromRow(row, { config, readError: error, timedOut });
}

/**
 * 管理台 DTO。`maxFileBytes` 是**生效值**（不是"我以为的值"），`source`/`reason` 解释它从哪来；
 * `dbMaxFileBytes` / `envMaxFileBytes` / `defaultMaxFileBytes` 让三个来源同时可见（排查时不用猜）。
 * 表不存在/读失败也回 200：配置面坏了不该让管理台这一页白屏（与 GET mail/settings 的「未配置是 200」同口径）。
 */
export function toUploadSettingsDto({ resolved, row = null, config = {} }) {
  return {
    maxFileBytes: resolved.maxBytes,
    source: resolved.source,
    reason: resolved.reason ?? null,
    dbMaxFileBytes: resolved.dbMaxFileBytes ?? null,
    envMaxFileBytes: envFallbackBytes(config),
    envIsExplicit: envIsExplicit(config),
    defaultMaxFileBytes: DEFAULT_MAX_FILE_BYTES,
    limits: { minBytes: MIN_MAX_FILE_BYTES, maxBytes: MAX_MAX_FILE_BYTES },
    updatedAt: isoOrNull(row?.updated_at ?? null),
    updatedBy: row?.updated_by ?? null,
  };
}

/** `GET /api/admin/upload/settings`。 */
export async function getUploadSettings({ pool, config = {}, log = console } = {}) {
  const { row, error, timedOut } = await readRow({ pool, log });
  return toUploadSettingsDto({
    resolved: resolveFromRow(row, { config, readError: error, timedOut }), row, config,
  });
}

/** 写侧校验：只接受**区间内的 JSON number**（口径 3：字符串一律 400，`''` 与 `'1e7'` 都不许存成半个值）。 */
function cleanMaxFileBytes(value) {
  if (value === undefined || value === null) {
    fail('maxFileBytes', 'maxFileBytes 是必填字段（JSON 整数，单位字节）');
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    fail('maxFileBytes', 'maxFileBytes 必须是整数（JSON number，不接受字符串）');
  }
  if (value < MIN_MAX_FILE_BYTES || value > MAX_MAX_FILE_BYTES) {
    fail('maxFileBytes', `maxFileBytes 必须在 ${MIN_MAX_FILE_BYTES}–${MAX_MAX_FILE_BYTES} 字节之间`);
  }
  return value;
}

/**
 * `PUT /api/admin/upload/settings`：校验 + **一条** CTE 语句（读旧值 → upsert → 写审计）。
 *
 * 两件事分开说清：
 *   * **响应里的生效值来自 `RETURNING`**（不是回显输入）——「保存成功」说的是库里现在的值。
 *   * **旧值与审计在同一语句里**（复 audit 活二）：本函数自己写审计，调用方（`http.js`）**不得**
 *     再补一笔 `auth.audit`——那会把原子性退回成两个 await，而且多写一条审计（US-18 钉的就是这两点）。
 *     与 `updateMailSettings`「审计归调用方」的分工在这里刻意不同：那一单没有「旧值必须与写入同快照」的要求。
 *
 * 失败形状：审计写不进去 ⇒ 整条语句失败 ⇒ **设置没改**（语句级原子）；错误带 `httpStatus` 往上招。
 *
 * @returns {Promise<{settings:object, previous:{maxFileBytes:number, source:string}}>}
 */
export async function updateUploadSettings({ pool, config = {}, log = console, actorId = null, fields } = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    fail('body', '请求体必须是对象');
  }
  const maxFileBytes = cleanMaxFileBytes(fields.maxFileBytes);
  // 「DB 旧值不可用时用什么顶」仍然只由 JS 这一套算（envFallbackBytes / envIsExplicit），
  // 以**参数**形式送进 SQL ⇒ 区间常量也只有一处（`MIN/MAX_MAX_FILE_BYTES`），SQL 里不抄数字。
  const written = await pool.query(SAVE_SQL, [
    maxFileBytes, actorId,
    envFallbackBytes(config), envIsExplicit(config) ? 'env' : 'default',
    MIN_MAX_FILE_BYTES, MAX_MAX_FILE_BYTES,
    AUDIT_ACTION, AUDIT_TARGET,
  ]);
  const row = written?.rows?.[0] ?? null;
  const resolved = resolveFromRow(row, { config });
  if (resolved.source !== 'db') {
    // 写进去的值读回来却不可用 = 我们的区间常量与写侧校验漂移了（例：日后只改了一处）。
    // 不能静默回落到 env：那会让管理台显示"保存成功但生效值是别的数"这种不可调试的形态。
    throw new UploadSettingsError('internal', `写入的 max_file_bytes=${maxFileBytes} 读回后不可用`, { httpStatus: 500 });
  }
  if (Number(row?.audit_rows) !== 1) {
    // 理论上到不了：同一条语句里 `aud` 与 `upd` 同生共死。留着是因为它正是本条 SQL 存在的理由——
    // 「设置生效了而审计没写」在这条语句里不可表示；真出现 = 有人把 `aud` 改成了可跳过的形状。
    throw new UploadSettingsError('internal', `保存成功但审计写了 ${row?.audit_rows ?? 0} 行`, { httpStatus: 500 });
  }
  // `previous` 走 JS 侧同一套解析（策略只一处）；SQL 里那份 CASE 只为审计的 `details` 服务，
  // 两者的等价性由单测逐值钉住（US-20），不是靠注释声明。
  const previousRaw = row?.previous_raw ?? null;
  const previous = resolveFromRow(previousRaw == null ? null : { max_file_bytes: previousRaw }, { config });
  return {
    settings: toUploadSettingsDto({ resolved, row, config }),
    previous: { maxFileBytes: previous.maxBytes, source: previous.source },
  };
}
