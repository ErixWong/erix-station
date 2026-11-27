// issue #332 + #648：FDE 工作台的**准入闸**（纯函数，零依赖 vue-router）。
//
// 判据（#648 修正 #332 的口径）：**没有工位的人不该停在 FDE 工作台**——「没有工位」= `!users.fde_name`，
//   **与 `role` 无关**。
//   四类人（`role` 的 CHECK 是 `('fde','admin')` 单值互斥，而 `fde_name` 是**独立列**，
//   见 docs/data/schema.sql:80-83 ⇒ 四个组合都真存在）：
//     ① `fde` + 有 `fde_name`：工作台（本闸放行）。
//     ② `admin` + 有 `fde_name`：既管台又有工位 ⇒ **必须照常进得来**（#332 钉死的一条）。
//     ③ `admin` + 无 `fde_name`：没工位的管理员 ⇒ 送管理台（#332）。
//     ④ `fde` + 无 `fde_name`：没工位的 FDE ⇒ **同样送管理台**（#648 新增；#332 当年放他过去是错的）。
//   ④ 为什么必须挡：他的工作台每一趟 API 都是错的（不是「没数据」，是服务端直接报错）——
//     `GET /api/dirs` ⇒ 500 `internal`（`portal/src/dirs.js:57`、`:123`、`:266` 拿 `userSpaceRoot`/`fde_name`
//     拼家目录，缺列即抛）；`GET /api/sessions` ⇒ `validation_failed`「当前用户未配置 fde_name，无法确定家目录」
//     （`portal/src/sessions.js:333`）。守卫里改写 ⇒ 视图根本不挂载 ⇒ 这些错一条都不会打到用户脸上。
//   ⚠ 与 `role` 无关，但**落点不变**：没工位 ⇒ 管理台，有工位 ⇒ 工作台（`seatAwareLanding` 与登录后
//     默认落点共用同一个判据，本模块不抄第二份 `/admin`）。
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
 * 判据本体：**没有工位**（`!fde_name`）⇒ 不该停在工作台。#648 起与 `role` 无关（③④ 两类都算）。
 * 参数取最小形状（不看 id/login），`user` 为 null（未登录）时为 false——「未登录」归守卫的 /login 规则管。
 * 空串也算没工位（真库里未开户的账号可能是空串而不是 null）。
 */
export function hasNoSeat(user: { role: string; fde_name: string | null } | null | undefined): boolean {
  return !!user && !user.fde_name;
}

/**
 * 「这个人该落地在哪」——`afterLoginRoute` 的同一条判据（登录后默认落点、被本闸拦下后的去处共用它）。
 * 没有工位 ⇒ 管理台；其余（含第 ② 类人 `admin` + 有 `fde_name`）⇒ 工作台。
 */
export function seatAwareLanding(user: { role: string; fde_name: string | null } | null | undefined): string {
  return hasNoSeat(user) ? ADMIN_CONSOLE_PATH : '/';
}

/**
 * 两态结论（不需要 forcePasswordGuard 那种三态：本闸没有「目标就是放行去处」的自我指涉，
 * 第 ③ 类人访 `/admin` 时 `isWorkbenchPath` 直接返 `next`，构不成 rewrite→/admin→rewrite 的环）。
 */
export type WorkbenchGateDecision = { action: 'rewrite'; path: string } | { action: 'next' };

/**
 * 准入闸判据：**没有工位**的人（③ `admin`+无 `fde_name` / ④ `fde`+无 `fde_name`）访问工作台
 * **任意**路由（`/`、`/session/:id`）⇒ 改写到管理台；其余一律 `next`（既有的「未登录→/login」
 * 「requiresRole」规则照旧）。
 *
 * 为什么必须在**守卫**里做而不是在 WorkbenchView 里做：视图里的 `onMounted` 会打
 * `GET /api/dirs` + `GET /api/sessions` + `GET /api/me/ports` 三趟去换一个空壳（#308 审计实测的形状），
 * 而 ④ 类人拿到的不是空壳是 500/400（见本文件顶部）。
 * 守卫里改写 ⇒ 视图根本不挂载 ⇒ 三趟一条都不发（#332 工单 §二.2）。
 */
export function workbenchGateDecision(input: {
  user: { role: string; fde_name: string | null } | null;
  toPath: string;
}): WorkbenchGateDecision {
  if (!isWorkbenchPath(input.toPath)) return { action: 'next' };
  if (!hasNoSeat(input.user)) return { action: 'next' };
  return { action: 'rewrite', path: ADMIN_CONSOLE_PATH };
}
