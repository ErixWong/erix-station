// #255 前端 ②：**错误码 → 可行动文案**的映射表（唯一落点，视图只做渲染）。
//
// 契约依据：`docs/api/portal.md` §1.2（通用码）、§2.6a（本端点会返回的六种失败）、
// §2.11（#234 `cross_origin_forbidden`）、§2.11a（受限会话门）。
//
// 判据顺序是**先 code、后 status**，且 code 优先到不给 status 兜底留机会：
// §2.6a 明确 `401 invalid_credentials`（旧口令不对）与 `401 unauthorized`（会话过期）**共用 401**，
// 只看状态码就会把「旧口令打错了」演成「会话过期、请重新登录」——用户白丢一次输入。
//
// 兜底口径：**未知 code 不许静默成通用错误**。命中不了的 code 走 `unknown_code`，
// 句子里原样带出 HTTP 状态码与 `code` 本身（前端不认识它，人得能拿它去报障）。

import { i18n } from '../i18n';
import { toDisplayText } from '../api';

/** 映射表需要的最小错误形状（`ApiError` 与 store 里的 `ChangePasswordError` 都满足）。 */
export interface ChangePasswordErrorLike {
  status: number;
  /** 已经过 `toDisplayText` 的 code（非字符串退化成 JSON 文本）。 */
  code?: string | null;
  /** 服务端 `error.message`（已收成字符串，原样透传，不在前端翻译）。 */
  message?: string | null;
  /** 服务端 `error.details`（`validation_failed` 带 `field`）。 */
  details?: unknown;
  /** `Retry-After` 头里的秒数（429 / 503 带，§2.6a）。 */
  retryAfter?: number | null;
}

/** 解析结果：文案键 + 注入参数 + 是否必须回登录页。 */
export interface ResolvedErrorCopy {
  /** `forcePassword.errors.` 下的小写键名（与 zh/en 两份 locale 逐字一致）。 */
  key: string;
  params: Record<string, string | number>;
  /**
   * `true` ⇒ 手上这枚会话已经没了（401 `unauthorized`），改密屏留着也没东西可改
   * ⇒ 视图必须把人送回 /login，而不是停在改密屏反复撞 401。
   * ⚠ 与 `invalid_credentials` 的区别全在 code 上（两者都是 401）。
   */
  relogin: boolean;
}

/** `error.code` → locale 键（键名与码名逐字相同，读表就能对上门禁）。 */
export const ERROR_CODE_KEYS: Readonly<Record<string, string>> = {
  invalid_credentials: 'invalid_credentials',
  validation_failed: 'validation_failed',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  cross_origin_forbidden: 'cross_origin_forbidden',
  method_not_allowed: 'method_not_allowed',
  rate_limited: 'rate_limited',
  kdf_busy: 'kdf_busy',
  // 409 `llm_model_not_found`（#289 切片 B2，§1.2 / §4.3）：发消息预检把「绑定的模型 id 已不在网关里」
  // 报成用户看得见的失败（`details` = `{slot, model_id}`，服务端 `retryable: true`）。
  llm_model_not_found: 'llm_model_not_found',
  internal: 'internal',
};

/**
 * **只在 code 缺失时**才用的状态码兜底（§1.2）。
 * code 存在但不认识 ⇒ 一律 `unknown_code`，绝不拿状态码猜出一个更具体的解释来盖掉它。
 */
export const STATUS_KEYS: Readonly<Record<number, string>> = {
  401: 'unauthorized',
  403: 'forbidden',
  405: 'method_not_allowed',
  429: 'rate_limited',
  503: 'kdf_busy',
  500: 'internal',
};

/** `error.details.field` → 字段名的本地化（§4.7a 口径：把错误指到具体输入框）。 */
const FIELD_KEYS: Readonly<Record<string, string>> = {
  current_password: 'current_password',
  new_password: 'new_password',
  confirm_password: 'confirm_password',
};

/** 会话已死、只能重登的那些键（401 unauthorized 是本屏唯一的「离开改密屏」出口）。 */
const RELOGIN_KEYS: ReadonlySet<string> = new Set(['unauthorized']);

/** 带 Retry-After 语义、需要注入秒数的那两个键（429 / 503）。 */
const RETRY_AFTER_KEYS: ReadonlySet<string> = new Set(['rate_limited', 'kdf_busy']);

/**
 * 取词入口。`i18n.global.t` 的签名是把所有合法键拼成字面量联合的强类型，
 * 而本模块的键是**查表算出来的字符串** ⇒ 这里做一次局部放宽（只放宽「键是 string」这一点，
 * 参数仍受约束），并把失败面锁在本行：真写错了键，vue-i18n 会原样回显键名，
 * 单测里的「渲染结果不许包含键名」断言会红（见 forcePasswordErrors.spec.ts）。
 */
const tGlobal = i18n.global.t as unknown as (key: string, named?: Record<string, string | number>) => string;

/**
 * 把 `error.details.field` 收成「人能看懂这是哪个框」。
 * 认得出的字段名走本地化标签；认不出来（含深嵌套 / 非字符串的畸形 details）就原样带出去，
 * 一律经 `toDisplayText` ⇒ 无论服务端塞什么都不会出现 `[object Object]`。
 */
export function describeField(details: unknown, field?: unknown): string {
  const raw = field ?? (details && typeof details === 'object'
    ? (details as Record<string, unknown>).field
    : undefined);
  const text = toDisplayText(raw).trim();
  // 没有 field（或 details 本身是 null/非对象）：给一个明说的占位，别渲染成空引号。
  if (!text) return tGlobal('forcePassword.errors.field.missing');
  const known = FIELD_KEYS[text];
  return known ? tGlobal(`forcePassword.errors.field.${known}`) : tGlobal('forcePassword.errors.field.other', { field: text });
}

/**
 * 纯解析（不出文案）：给单测直接断言「code → 键」的映射，也供 `describeError` 复用。
 */
export function resolveErrorCode(err: ChangePasswordErrorLike): ResolvedErrorCopy {
  const code = toDisplayText(err.code).trim();
  const status = Number.isFinite(err.status) ? err.status : 0;

  let key: string;
  if (code && ERROR_CODE_KEYS[code]) {
    key = ERROR_CODE_KEYS[code];
  } else if (!code && STATUS_KEYS[status]) {
    key = STATUS_KEYS[status];
  } else {
    key = 'unknown_code';
  }

  const params: Record<string, string | number> = {};
  if (key === 'unknown_code') {
    params.status = status;
    params.code = code || tGlobal('forcePassword.errors.no_code');
  }
  if (key === 'validation_failed') {
    params.field = describeField(err.details);
  }
  if (RETRY_AFTER_KEYS.has(key)) {
    // Retry-After 缺失 ⇒ 换不带秒数的键，避免把 "undefined 秒" 这类噪声演给人看。
    const seconds = typeof err.retryAfter === 'number' && Number.isFinite(err.retryAfter) ? Math.max(0, Math.round(err.retryAfter)) : null;
    if (seconds === null) key = `${key}_no_retry`;
    else params.seconds = seconds;
  }

  return { key, params, relogin: RELOGIN_KEYS.has(key) };
}

/**
 * 完整文案：可行动的主句（映射表）+ 句尾的原始证据（服务端 message 与 code，原样不翻译）。
 *
 * 证据段是 `[object Object]` 的最后一道保险：`message` 与 `code` 进 i18n 之前**再**过一次
 * `toDisplayText`（api.ts 已过一次，这里防的是别的入口塞进来的未消毒值）。
 */
export function describeError(err: ChangePasswordErrorLike): string {
  const resolved = resolveErrorCode(err);
  const main = tGlobal(`forcePassword.errors.${resolved.key}`, resolved.params);
  const message = toDisplayText(err.message).trim() || tGlobal('forcePassword.errors.no_message');
  const code = toDisplayText(err.code).trim() || tGlobal('forcePassword.errors.no_code');
  const detail = tGlobal('forcePassword.errors.detail', { message, code });
  return `${main} ${detail}`;
}

/** 会话是否已经没了（视图据此回 /login）。 */
export function errorMeansRelogin(err: ChangePasswordErrorLike): boolean {
  return resolveErrorCode(err).relogin;
}
