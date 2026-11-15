// 管理台「上传上限」页（issue #485 片 A）的纯逻辑：DTO 归一化 + 保存请求体构造 + 字段名映射 + 字节显示。
// 契约唯一来源：`docs/api/portal.md` §4.15（`GET/PUT /api/admin/upload/settings`）。
//
// 为什么这些函数在 lib 里而不是组件里（AGENTS §8.14 同族）：jsdom 不做布局、也不做真网络，
// 但「服务端给了没点名的键怎么办」「空输入要不要发请求」「1048576 该显示成什么」都是**纯计算**，
// 放在组件里只能断言恒真的废话。
//
// 三条硬口径：
//   1. **归一化是显式白名单**：DTO 里没点名的键（例：日后服务端多塞了一个 `foo`）不进前端状态。
//      ⚠ 「键缺席」不是 `false`/`0`，而是 **`null`**（#390-A 的纪律）——本页 `maxFileBytes` 缺席的含义是
//      「服务端没告诉我生效值」，UI 必须显示「未知」而不是「0 字节」：后者会让人以为上限是 0。
//   2. **前端不做业务校验**（照 §4.12 邮件通道的口径）：数字框解析不出整数 ⇒ 不发请求（不发一个
//      必然 400 的垃圾体）；解析得出整数就**照发**，越界由服务端 `400 validation_failed` + `details.field`
//      回来标红。服务端才是闸，前端只是提前提示。
//   3. **生效值与来源要一起显示**：`source`（`db`/`env`/`default`）+ `reason` 是这一页的全部价值所在——
//      只显示一个数字，运维就不知道「我改的这个数到底听不听」。
import type { ApiError } from '../api';

/** 端点路径（唯一拼法，视图与 store 共用）。 */
export const UPLOAD_SETTINGS_PATH = '/api/admin/upload/settings';

export const UPLOAD_LIMIT_SOURCES = ['db', 'env', 'default'] as const;
export type UploadLimitSource = (typeof UPLOAD_LIMIT_SOURCES)[number];

/** 允许区间（服务端 §4.15-1 `limits`）。形状不认识 ⇒ `null`，**不猜**。 */
export interface UploadLimits {
  minBytes: number;
  maxBytes: number;
}

/** 读侧 DTO（GET 与 PUT 响应同一个形状）。所有值都可能是 `null` = 「服务端这次没告诉我」。 */
export interface UploadSettings {
  /** 当前生效值（= 下一次上传用的那个数）。`null` = 未知。 */
  maxFileBytes: number | null;
  /** 生效值的来源；认不出来 ⇒ `null`（不是 `'default'`——那是在编一个来源）。 */
  source: UploadLimitSource | null;
  /** `source ≠ db` 的原因（`no_row` / `invalid_db_value` / `read_failed`）；DB 生效时是 `null`。 */
  reason: string | null;
  dbMaxFileBytes: number | null;
  envMaxFileBytes: number | null;
  /** env 里是否真的显式写了 `FILE_UPLOAD_MAX_BYTES`（给了但非法 ⇒ false）。 */
  envIsExplicit: boolean;
  defaultMaxFileBytes: number | null;
  limits: UploadLimits | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 写侧请求体（§4.15-2）：只有一个字段，且必须是 JSON number。 */
export interface UploadSettingsPayload {
  maxFileBytes: number;
}

/** 服务端点名的字段名（本页只有一个可错字段，但映射仍然显式写：认不出就不标红，不猜）。 */
export type UploadFieldKey = 'maxFileBytes';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 正整数（字节数）才收；其它形状（字符串数字、小数、负数、`null`）一律 `null` = 未知。 */
function safeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sourceOrNull(value: unknown): UploadLimitSource | null {
  return UPLOAD_LIMIT_SOURCES.includes(value as UploadLimitSource) ? value as UploadLimitSource : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 归一化读侧 DTO。**永不抛**：任何形状都不让这一页白屏（服务端读失败时也回 200，见 §4.15-1）。
 * 逐键取值 ⇒ 服务端漏一个键只会让那一格显示「未知」，不会连带整页崩。
 */
export function normalizeUploadSettings(raw: unknown): UploadSettings {
  const src = asRecord(raw) ?? {};
  const limitsRaw = asRecord(src.limits);
  return {
    maxFileBytes: safeIntOrNull(src.maxFileBytes),
    source: sourceOrNull(src.source),
    reason: stringOrNull(src.reason),
    dbMaxFileBytes: safeIntOrNull(src.dbMaxFileBytes),
    envMaxFileBytes: safeIntOrNull(src.envMaxFileBytes),
    // `=== true`：缺键 = 未知 = 「env 没显式设」，不许 `Boolean()`（`Boolean('f') === true` 那一族）。
    envIsExplicit: src.envIsExplicit === true,
    defaultMaxFileBytes: safeIntOrNull(src.defaultMaxFileBytes),
    limits: limitsRaw === null
      ? null
      : { minBytes: safeIntOrNull(limitsRaw.minBytes) ?? 0, maxBytes: safeIntOrNull(limitsRaw.maxBytes) ?? 0 },
    updatedAt: stringOrNull(src.updatedAt),
    updatedBy: stringOrNull(src.updatedBy),
  };
}

/**
 * 数字框的一手值（DOM 里永远是字符串）→ 请求体。
 *
 * 解析不出**整数**（空串、`''`、`'1e7'`、`'1.5'`、负号、非数字）⇒ 返回 `null`，调用方**不发请求**：
 * 发一个 `maxFileBytes: null` 只是把「用户还没填」伪装成「用户填了个非法值」。
 * 解析得出整数就原样发（**包括越界的**）：区间是服务端的判断，前端不抢它的闸。
 */
export function buildUploadSettingsPayload(input: string | number): UploadSettingsPayload | null {
  const text = typeof input === 'number' ? String(input) : String(input ?? '').trim();
  if (text === '') return null;
  // 只接受纯十进制整数（可带前导 +/-）：`Number.isFinite(Number('1e7'))` 为真，但 `1e7` 这种写法
  // 是「用户在浏览器地址栏习惯里的科学计数法」，不是这里要收的形态——服务端也拒（§4.15-2），
  // 所以前端**不提前放行**它，否则会变成"前端说行、服务端说不行"的两头说法。
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? { maxFileBytes: value } : null;
}

/** 400 时把 `details.field` 映射到要标红的字段；认不出 ⇒ `null`（退化成整表一条错误，不猜是哪个框）。 */
export function uploadValidationFieldOf(error: unknown): UploadFieldKey | null {
  if (error === null || typeof error !== 'object') return null;
  const { status, details } = error as Partial<ApiError>;
  if (status !== 400) return null;
  const field = (details as Record<string, unknown> | undefined)?.field;
  return field === 'maxFileBytes' || field === 'body' ? 'maxFileBytes' : null;
}

/**
 * 字节数 → 人话（运维看的是 MiB，不是 7 位数字）。
 * 两位小数**向下取齐**（`Math.floor`）：显示成 `32.01 MiB` 而实际是 33554431 时，
 * 向上取整会让人以为「还有余量」，向下才是「不会超」。
 */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isSafeInteger(bytes) || bytes < 0) return null;
  const MIB = 1024 * 1024;
  const GIB = MIB * 1024;
  if (bytes >= GIB) return `${(Math.floor((bytes / GIB) * 100) / 100).toLocaleString('en-US')} GiB`;
  if (bytes >= MIB) return `${(Math.floor((bytes / MIB) * 100) / 100).toLocaleString('en-US')} MiB`;
  if (bytes >= 1024) return `${(Math.floor((bytes / 1024) * 100) / 100).toLocaleString('en-US')} KiB`;
  return `${bytes} B`;
}

/** 输入框旁边的「当前填写值」实时换算（无效输入 ⇒ `null`，UI 显示「不是整数」而不是 0）。 */
export function formatDraftBytes(draft: string | number): string | null {
  const payload = buildUploadSettingsPayload(draft);
  return payload === null ? null : formatBytes(payload.maxFileBytes);
}

/**
 * 越界的**提前提示**（不是拦截）：`source='db'` 且草稿是整数但在区间外 ⇒ 给出提示。
 * 判定不了（服务端没给 `limits`）⇒ `null`，此时以服务端的 400 为准。
 */
export function draftRangeHint(draft: string | number, settings: UploadSettings | null): 'below' | 'above' | null {
  const payload = buildUploadSettingsPayload(draft);
  const limits = settings?.limits ?? null;
  if (payload === null || limits === null || limits.minBytes <= 0 || limits.maxBytes <= 0) return null;
  if (payload.maxFileBytes < limits.minBytes) return 'below';
  if (payload.maxFileBytes > limits.maxBytes) return 'above';
  return null;
}
