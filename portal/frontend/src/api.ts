// API 客户端：语义逐行对齐旧 portal/static/index.html 的 api() 内联实现——
// JSON 信封、错误 message 取自 body.error.message，兜底文案走 errors.requestFailed（issue #101 P2）。

import { i18n } from './i18n';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  /**
   * 服务端 `error.details`（#246 交付② 需要：400 validation_failed 的 `details.field` 用来把错误
   * 指到具体输入框，见 portal.md §4.7a）。此前被 api() 丢掉 ⇒ 前端只能显示「参数不合法」而不知道
   * 是哪个字段。纯增量：既有调用方只读 status/code/message，行为不变。
   */
  details: Record<string, unknown> | undefined;

  constructor(
    message: string,
    status: number,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

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
    throw new ApiError(
      body?.error?.message || i18n.global.t('errors.requestFailed', { status: r.status }),
      r.status,
      body?.error?.code,
      body?.error?.details,
    );
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
