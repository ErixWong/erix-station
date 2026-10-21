// issue #332：FDE 工作台的**准入闸**（纯函数，零依赖 vue-router）。
//
// 判据（决策者 2026-10-21 拍定）：**没有工位的平台管理员不该待在 FDE 工作台**。
//   「没有工位」= `users.role === 'admin' && !users.fde_name`（三类人里的第 ③ 类）。
//   ⚠ `role` 的 CHECK 是 `('fde','admin')` 单值互斥（docs/data/schema.sql:80-81），而 `fde_name` 是
//   **独立列**（:82-83）⇒ 第 ② 类人（`role='admin'` 且 `fde_name` 有值：既有工位又有管理台）**必须照常
//   进得来**。本单挡的是「没工位」，不是「admin」——所以判据里 `!fde_name` 与 `role==='admin'` 缺一个
//   都错：只看 role 会把 ② 类人挡在门外，只看 fde_name 会把「fde 但 fde_name 为空」的畸形账号也挡掉。
//
// 为什么把它从 router.ts 的守卫里抽出来（照 lib/forcePasswordGuard.ts 的先例）：判据落在**不 import
// vue-router、不挂载组件**的模块里，单测直接调函数即可秒级变红；守卫只负责接线。
// 落地页仍走 stores/auth 的 `afterLoginRoute`（同一个判据、同一个去处），本模块**不抄第二份 /admin**。

/** 管理台入口地址（`/admin` 的默认子路由 redirect 到 `/admin/users`，见 router.ts 的路由表）。 */
export const ADMIN_CONSOLE_PATH = '/admin';

/** 工作台自身的地址集合：`/`（`name: 'workbench'`）与 `/session/:id`（`name: 'session'`）。 */
export function isWorkbenchPath(toPath: string): boolean {
  // 只认这两条：`/sessions`（前缀相似但不是工作台路由）、`/admin*`、`/login`、`/change-password` 都不算。
  return toPath === '/' || toPath.startsWith('/session/');
}

/**
 * 判据本体：`role === 'admin' && !fde_name` ⇒ 没有工位的平台管理员。
 * 参数取最小形状（不看 id/login），`user` 为 null（未登录）时为 false——「未登录」归守卫的 /login 规则管。
 */
export function isSeatlessAdmin(user: { role: string; fde_name: string | null } | null | undefined): boolean {
  return !!user && user.role === 'admin' && !user.fde_name;
}

/**
 * 「这个人该落地在哪」——`afterLoginRoute` 的同一条判据（登录后默认落点、被本闸拦下后的去处共用它）。
 * 没有工位 ⇒ 管理台；其余（含第 ② 类人 `admin` + 有 `fde_name`）⇒ 工作台。
 */
export function seatAwareLanding(user: { role: string; fde_name: string | null } | null | undefined): string {
  return isSeatlessAdmin(user) ? ADMIN_CONSOLE_PATH : '/';
}

/**
 * 两态结论（不需要 forcePasswordGuard 那种三态：本闸没有「目标就是放行去处」的自我指涉，
 * 第 ③ 类人访 `/admin` 时 `isWorkbenchPath` 直接返 `next`，构不成 rewrite→/admin→rewrite 的环）。
 */
export type WorkbenchGateDecision = { action: 'rewrite'; path: string } | { action: 'next' };

/**
 * 准入闸判据：第 ③ 类人（`admin` 且无 `fde_name`）访问工作台**任意**路由（`/`、`/session/:id`）
 * ⇒ 改写到管理台；其余一律 `next`（既有的「未登录→/login」「requiresRole」规则照旧）。
 *
 * 为什么必须在**守卫**里做而不是在 WorkbenchView 里做：视图里的 `onMounted` 会打
 * `GET /api/dirs` + `GET /api/sessions` + `GET /api/me/ports` 三趟去换一个空壳（#308 审计实测的形状）。
 * 守卫里改写 ⇒ 视图根本不挂载 ⇒ 三趟一条都不发（工单 §二.2）。
 */
export function workbenchGateDecision(input: {
  user: { role: string; fde_name: string | null } | null;
  toPath: string;
}): WorkbenchGateDecision {
  if (!isWorkbenchPath(input.toPath)) return { action: 'next' };
  if (!isSeatlessAdmin(input.user)) return { action: 'next' };
  return { action: 'rewrite', path: ADMIN_CONSOLE_PATH };
}
