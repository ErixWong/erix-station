// 单文件上传上限的**读侧 + 写侧**（issue #485 片 A，契约 docs/api/portal.md §4.14 / §4.15）。
//
// 一句话：`FILE_UPLOAD_MAX_BYTES` 从「启动期 env」降级成「兜底值」，真相搬到 `upload_settings` 单行表
// （迁移 0035），管理台可改，**每次上传现读** ⇒ 改完立即生效，不需要重启 portal。
//
// 形状照 `mail_settings`（迁移 0026 + `portal/src/mail-settings.js`）这个先例，两点刻意不同：
//   1. **没有 60s 缓存**。`mail-provider` 要缓存是因为登录是热路径；上传不是——一次上传多一次
//      `SELECT` 单行主键查（<1ms）换「改完立即生效」这条判据，是划算的。加了缓存就等于把
//      「必须重启」换成「必须等一分钟」，判据没被满足，只是换了个等待理由。
//   2. 因此写侧**不需要** `invalidate()`：没有缓存可失效。
//
// 四条硬口径（都有对应用例，别改回去）：
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

const UPSERT_SQL = `INSERT INTO upload_settings (id, max_file_bytes, updated_at, updated_by)
VALUES (1, $1, now(), $2)
ON CONFLICT (id) DO UPDATE
   SET max_file_bytes = EXCLUDED.max_file_bytes,
       updated_at = now(),
       updated_by = EXCLUDED.updated_by
RETURNING max_file_bytes::text AS max_file_bytes, updated_at, updated_by`;

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
 * @param {object} [opts] `{ config, readError }`；`readError` 是真库读失败时调用方带上的错，
 *   它只影响 `reason`（`'read_failed'` 与 `'no_row'` 要分开：一个是表/连接坏了，一个是真的未配置）。
 * @returns {{ maxBytes:number, source:'db'|'env'|'default', reason:string|null, dbMaxFileBytes:number|null }}
 *   `source` 就是管理台要显示的「来源」。
 */
export function resolveFromRow(row, { config = {}, readError = null } = {}) {
  const dbMaxFileBytes = parseDbMaxFileBytes(row?.max_file_bytes);
  if (dbMaxFileBytes !== null) {
    return { maxBytes: dbMaxFileBytes, source: 'db', reason: null, dbMaxFileBytes };
  }
  const fallback = envFallbackBytes(config);
  const source = envIsExplicit(config) ? 'env' : 'default';
  const reason = readError ? 'read_failed' : (row ? 'invalid_db_value' : 'no_row');
  return { maxBytes: fallback, source, reason, dbMaxFileBytes: null };
}

/** 读 DB 一行；**永不抛**（`reason:'read_failed'` 与「无行」区分开，运维要知道是哪种）。 */
async function readRow({ pool, log = console } = {}) {
  try {
    const result = await pool.query(SELECT_SQL);
    return { row: result?.rows?.[0] ?? null };
  } catch (err) {
    // 点名两个旋钮：值班的人要能一眼看出「现在生效的是哪个来源的值、去哪里改」。
    log?.warn?.(
      '[upload-settings] 读 upload_settings.max_file_bytes 失败，回落 FILE_UPLOAD_MAX_BYTES/默认值（上传不受影响）：'
      + `${err?.message ?? err}`,
    );
    return { row: null, error: err?.code ?? err?.message ?? 'read_failed' };
  }
}

/**
 * 上传端点的取数入口：**每次上传现读**（无缓存 ⇒ 管理台改完立即生效）。
 *
 * @returns {Promise<{maxBytes:number, source:'db'|'env'|'default', reason:string|null}>}
 */
export async function resolveEffectiveMaxFileBytes({ pool, config = {}, log = console } = {}) {
  const { row, error } = await readRow({ pool, log });
  return resolveFromRow(row, { config, readError: error });
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
  const { row, error } = await readRow({ pool, log });
  return toUploadSettingsDto({ resolved: resolveFromRow(row, { config, readError: error }), row, config });
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
 * `PUT /api/admin/upload/settings`：校验 + 单条 upsert。
 *
 * 顺序刻意：先读**当前生效值**（给审计当 `previous_*`），再写，再从 `RETURNING` 出 DTO。
 * 反过来的话「保存成功」就等于"我写的值"，而不是"库里现在的值"——#485 要的是后者。
 *
 * @returns {Promise<{settings:object, previous:{maxFileBytes:number, source:string}}>}
 *   写审计是调用方（`http.js`）成功路径的下一步，本函数不写审计（与 `updateMailSettings` 同分工）。
 */
export async function updateUploadSettings({ pool, config = {}, log = console, actorId = null, fields } = {}) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    fail('body', '请求体必须是对象');
  }
  const maxFileBytes = cleanMaxFileBytes(fields.maxFileBytes);
  const before = await readRow({ pool, log });
  const previous = resolveFromRow(before.row, { config, readError: before.error });
  const written = await pool.query(UPSERT_SQL, [maxFileBytes, actorId]);
  const row = written?.rows?.[0] ?? null;
  const resolved = resolveFromRow(row, { config });
  if (resolved.source !== 'db') {
    // 写进去的值读回来却不可用 = 我们的区间常量与写侧校验漂移了（例：日后只改了一处）。
    // 不能静默回落到 env：那会让管理台显示"保存成功但生效值是别的数"这种不可调试的形态。
    throw new UploadSettingsError('internal', `写入的 max_file_bytes=${maxFileBytes} 读回后不可用`, { httpStatus: 500 });
  }
  return {
    settings: toUploadSettingsDto({ resolved, row, config }),
    previous: { maxFileBytes: previous.maxBytes, source: previous.source },
  };
}
