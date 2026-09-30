// API 客户端：语义逐行对齐旧 portal/static/index.html 的 api() 内联实现——
// JSON 信封、错误 message 取自 body.error.message，兜底文案走 errors.requestFailed（issue #101 P2）。

import { i18n } from './i18n';

export class ApiError extends Error {
  status: number;
  code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

// 401/403 之外的非预期错误（网络断开等）也会带兜底文案，便于登录页直接展示。
export async function api<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = (await r.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  } & T;
  if (!r.ok) {
    // 兜底文案在抛出时取词（非组件上下文：i18n.global.t）；服务端 error.message 原样透传（不在前端翻译范围）。
    throw new ApiError(
      body?.error?.message || i18n.global.t('errors.requestFailed', { status: r.status }),
      r.status,
      body?.error?.code,
    );
  }
  return body;
}
