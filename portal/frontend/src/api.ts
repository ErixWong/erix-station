// API 客户端：语义逐行对齐旧 portal/static/index.html 的 api() 内联实现——
// JSON 信封、错误 message 取自 body.error.message，兜底文案走 errors.requestFailed（issue #101 P2）。

import { i18n } from './i18n';
import { isPasswordChangeRequired, notifyRestrictedSession } from './lib/restrictedSession';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  /**
   * 服务端 `error.details`（#246 交付② 需要：400 validation_failed 的 `details.field` 用来把错误
   * 指到具体输入框，见 portal.md §4.7a）。此前被 api() 丢掉 ⇒ 前端只能显示「参数不合法」而不知道
   * 是哪个字段。纯增量：既有调用方只读 status/code/message，行为不变。
   */
  details: Record<string, unknown> | undefined;
  /**
   * `Retry-After` 头里的**秒数**（#255：429 `rate_limited` 与 503 `kdf_busy` 都带它，portal.md §2.6a）。
   * 没带头 / 头不可解 ⇒ `null`（文案退到不带秒数的版本，而不是显示 "undefined 秒"）。
   * 纯 additive：既有调用方不读它。
   */
  retryAfter: number | null;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: Record<string, unknown>,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

/**
 * 把服务端错误信封里的**任意**值收成展示字符串（#255）。
 *
 * 契约上 `error.message` / `error.code` 是字符串，但前端不赌它：`new Error(非字符串)` 在构造函数里
 * 就被 ToString 成 `[object Object]`，事后救不回来 ⇒ 必须在**进 Error 之前**退化。
 * 对象/数组 ⇒ JSON 文本（宁可难看也不丢信息）；无 JSON 表示时 String 兜底。
 */
export function toDisplayText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * `Retry-After` 头 → 秒数（#255）。契约上 429/503 带的是「秒」（portal.md §2.6a），
 * 但 §1.2 的通用口径允许 HTTP-date ⇒ 两种都收，不可解一律 `null`（宁可少说一个数字，不说假数字）。
 */
export function parseRetryAfter(value: string | null | undefined): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds : null;
  }
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

/**
 * #255 全局兜底（§2.11a）：任意请求撞上受限会话门 ⇒ 在抛出前先把旗标交给集中的监听器
 * （接线见 lib/restrictedSession.ts + router.ts），于是调用方的 catch 看到的是「旗标已置位」之后的
 * 世界——切屏不靠每个视图自己判码。监听器里出错绝不能吞掉真正的请求失败，故 try/catch 包住。
 */

// 401/403 之外的非预期错误（网络断开等）也会带兜底文案，便于登录页直接展示。
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = (await r.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string; details?: Record<string, unknown> };
  } & T;
  if (!r.ok) {
    // 兜底文案在抛出时取词（非组件上下文：i18n.global.t）；服务端 error.message 原样透传（不在前端翻译范围）。
    const code = body?.error?.code === undefined ? undefined : toDisplayText(body.error.code);
    const error = new ApiError(
      toDisplayText(body?.error?.message) || i18n.global.t('errors.requestFailed', { status: r.status }),
      r.status,
      code,
      body?.error?.details,
      parseRetryAfter(r.headers.get('Retry-After')),
    );
    // #255 全局兜底（§2.11a）：先置旗标再抛出（上面那段注释说明了为什么顺序不能倒）。
    if (isPasswordChangeRequired(error)) {
      try {
        notifyRestrictedSession(error);
      } catch {
        /* 接线方的异常不许掩盖真正的 403 */
      }
    }
    throw error;
  }
  return body;
}

/**
 * issue #107：会话重命名（PATCH /api/sessions/:id，body `{ title }`）。
 * 成功返回 `{ session }`（含落库后的 title/title_source）；失败抛 ApiError（400 validation_failed /
 * 404 not_found / 401 未登录）。后端 ≥200 字符拒绝、成功后置 title_source='manual'（手工优先守卫）。
 */
export function patchSessionTitle(
  sessionId: string,
  title: string,
): Promise<{ session: { id: string; title: string | null; title_source?: string | null } }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/**
 * issue #114：「AI 改名」——POST /api/sessions/:id/ai-title（空体 `{}`）。
 * 服务端取该会话前 3 条 user 消息调**一次** LLM 生成 ≤30 字标题，落库 title_source='manual'。
 * 失败抛 ApiError：409 llm_not_configured（未配置 provider）/ 502 llm_upstream_failed（上游失败）/ 404。
 */
export function postSessionAiTitle(
  sessionId: string,
): Promise<{ session: { id: string; title: string | null; title_source?: string | null } }> {
  return api(`/api/sessions/${encodeURIComponent(sessionId)}/ai-title`, { method: 'POST', body: '{}' });
}
