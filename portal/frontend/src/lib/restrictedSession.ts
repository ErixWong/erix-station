// #255 受限会话门（§2.11a）的**前端兜底判据**与接线点。
//
// 为什么需要兜底：契约给了两个「知道受限」的入口（登录响应的 `password_change_required`、
// `GET /api/me` 的 `user.must_change_password`），但真实世界里还有第三种到达方式——
// 旗标在**会话中途**被置位（管理员在另一头点了「重置口令」并吊销其它会话；或前端在
// 升级前就登录着、`/api/me` 已缓存过一轮）。这时任何一次 `/api/*` 都会撞回
// `403 password_change_required`（§1.2），而视图层各自判码 = 第二个视图接入必漏。
//
// 落点分工（**不在视图里判码**）：
//   * 判据 = 本文件（纯函数，单测直接调）；
//   * 触发 = `api.ts` 的错误分支（任何请求失败都经过它，抛出前通知一声）；
//   * 后果 = `stores/auth.ts` 的 `markRestrictedSession()`（置旗标，唯一写点）
//            + `router.ts` 的监听器（把 URL 也改成 /change-password，别只换画面）。

/** 受限会话门的错误码（portal.md §1.2 / §2.11a）。 */
export const PASSWORD_CHANGE_REQUIRED_CODE = 'password_change_required';

/** 判据输入：只需要状态码与 code，不依赖 ApiError 类（便于单测与跨模块复用）。 */
export interface StatusAndCode {
  status: number;
  code?: string | null;
}

/** 兜底监听器（api.ts 抛出前调用）。 */
export type RestrictedSessionListener = (err: StatusAndCode) => void;

/**
 * 判据：**403 且 code 恰为 `password_change_required`**。
 *
 * ⚠ 两个方向都不许松：
 *  - 只判 HTTP 403 ⇒ #234 的 `cross_origin_forbidden`、越权的 `forbidden` 也会被当成「欠改密」，
 *    把无关的人关进改密屏（变异靶子：判据退化成 `status === 403` 必须红）；
 *  - 只判 code 而忽略状态码 ⇒ 理论上 2xx 响应体里带同名键也会触发切屏。
 */
export function isPasswordChangeRequired(err: StatusAndCode): boolean {
  return err.status === 403 && (err.code ?? '') === PASSWORD_CHANGE_REQUIRED_CODE;
}

let listener: RestrictedSessionListener | null = null;

/**
 * 接线（`router.ts` 在 `createAppRouter()` 里注册，因此 pinia 已可用）。
 * 单例语义：**最后一次注册生效**（测试里每个用例新建 router ⇒ 自然覆盖上一个），
 * 传 `null` 注销（用例收尾用）。
 */
export function setRestrictedSessionListener(next: RestrictedSessionListener | null): void {
  listener = next;
}

/** api.ts 的错误分支调用；没有接线时静默（库不该依赖应用外壳是否存在）。 */
export function notifyRestrictedSession(err: StatusAndCode): void {
  listener?.(err);
}
