// issue #431：**「这一轮用户结束了」**的应用级信号（#428 的收口半片）。
//
// 为什么需要它：`claimOwnership(null)`（把工作台从当前登录者名下收回：断 SSE + 清整个用户的可见面）
// 原本只接在工作台顶栏那颗登出按钮上，而全站有**三颗**登出按钮——`WorkbenchView.onLogout`、
// `AdminLayout`（管理台顶栏）、`ForcePasswordChangeView`（强制改密屏的出口）。后两颗是裸
// `auth.logout()` ⇒ 从管理台登出时上一个账号的 `EventSource` 不会被关，而 `useEventStream.ts:467`
// 的注释写得很明白：「EventSource 自动重连，带 Last-Event-ID」——服务端会话一死，它不会当成终态，
// 而是**无限重连**，于是浏览器后台一直替别人的会话要事件流，挂到标签页关掉为止。
//
// 落点分工（形状照本仓既有的 `lib/restrictedSession.ts`，不另发明一套接线）：
//   * 触发 = `stores/auth.ts` 的 `logout()` / `forgetExpiredSession()`（「会话没了」只有它知道，
//     而且三颗登出按钮最终都汇到这两处）；
//   * 后果 = `views/WorkbenchView.vue` 注册进来的 `store.claimOwnership(null)`。
//
// ⚠ 为什么不走 `auth` 直接 import `workbench` store：那会把整个工作台面
// （`useEventStream` / `useRunMomentum` / `lib/markdown`）拖进登录页的首屏 chunk——路由是懒加载的
// （`router.ts` 里 `() => import('./views/WorkbenchView.vue')`），不该被一个登出信号拽回主包。
//
// ⚠ 注册**只装不卸**（`WorkbenchView` 的 setup 里注册，`onUnmounted` 不注销）：只有工作台挂载过
// 一次才有东西要清；卸载后 listener 仍指向同一个 pinia 全局单例，这正是需要的语义（注销就等于
// 把「从管理台登出」这条路径重新漏掉）。没有注册时 `notify` 静默——没进过工作台就没有要收的摊。

/** 用户 scope 结束时要做的事（由 `WorkbenchView` 注册）。 */
export type UserScopeResetListener = () => void;

let listener: UserScopeResetListener | null = null;

/**
 * 接线。**最后一次注册生效**（每次挂载重新注册，捕获的是同一个 store 单例 ⇒ 幂等），
 * 传 `null` 注销（单测收尾用）。
 */
export function setUserScopeResetListener(next: UserScopeResetListener | null): void {
  listener = next;
}

/** `auth.logout()` / `forgetExpiredSession()` 调用；没有接线时静默。 */
export function notifyUserScopeReset(): void {
  listener?.();
}
