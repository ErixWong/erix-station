// #255 受限会话的**导航判据**（纯函数，零依赖 vue-router）。
//
// 为什么要把它从 router.ts 的守卫里抽出来（前端 ② 的主 agent 实测要求）：
// 守卫里「受限判定必须排在 meta.public 之前」这条回归**在挂载式测试里的失败模式是挂死进程**——
// 把条件写成 `restricted && !to.meta.public`（让 /login 变成绕过口）之后，
// `/login → / → /change-password → /` 会构成**微任务里的重定向环**，vitest 的 testTimeout
// （以及任何 Promise.race + setTimeout 的兜底）都会被微任务饥饿吃掉：实测 200 秒无输出、
// exit 124、零用例完成，CI 里白烧一整段预算。
// ⇒ 判据落在这个**不 import vue-router、不挂载组件**的模块里，单测直接调函数即可秒级变红。
// 挂载式用例（views/ForcePasswordChangeView.spec.ts）继续留着验「真的进不去工作台」，
// 但它不是这条回归的守门人。
//
// 只 import stores/auth 的 `afterLoginRoute`（落地页口径的**唯一真相**，不在这里抄第二份），
// 不 import vue-router / 任何组件 ⇒ 单测不需要挂载、不需要 jsdom 组件生命周期。
import { afterLoginRoute } from '../stores/auth';

/** #255 强制改密屏的路径（守卫与 App 闸门的唯一合法去处）。 */
export const FORCE_PASSWORD_PATH = '/change-password';

/** 判据输入：只取「守卫真正需要的三个事实」，不传 RouteLocation / Router 实例。 */
export interface RestrictedNavigationInput {
  /** `auth.passwordChangeRequired`（服务端旗标）。 */
  restricted: boolean;
  /** 有没有会话（`!!auth.user`）。没有会话就谈不上受限。 */
  signedIn: boolean;
  /** 本次导航的目标路径。 */
  toPath: string;
  /** 目标路由的 `meta.public`。⚠ **本判据刻意不看它**——看它就等于给 /login 开绕过口。 */
  metaPublic: boolean;
  /** 当前用户（用于「非受限态访改密屏」的落地页计算）；null = 未登录。 */
  user: Parameters<typeof afterLoginRoute>[0] | null;
}

/**
 * 三态结论（⚠ 不能退化成「返回路径或 null」两态）：受限态下访**改密屏本身**必须是
 * `allow`（立刻放行），而不是「不改写、继续跑后面的规则」——后面的 `meta.public` 分支
 * 会把「已登录访 public 路由」改写成落地页，与「受限态改写去改密屏」互为对手，
 * 两态写法会当场构成 /change-password ⇄ / 的**重定向死循环**（本仓的实测教训：
 * 这种循环在微任务里转，vitest 的 testTimeout 会被饥饿吃掉，表现为整块测试挂死）。
 */
export type RestrictedNavigationDecision =
  | { action: 'rewrite'; path: string }
  | { action: 'allow' }
  | { action: 'next' };

/**
 * 受限态判据。三条规则（顺序即优先级，第一条**不受 `metaPublic` 影响**）：
 *  1. 已登录且受限 ⇒ 除改密屏本身（`allow`），一切目标（**含 `meta.public` 的 /login**）都改写到 /change-password；
 *  2. 非受限/未登录 访改密屏 ⇒ 改写回落地页（已登录按角色回 /admin 或 /，未登录回 /login）——
 *     本屏对正常用户没有存在意义，且 App 闸门也不会渲染它；
 *  3. 其余 `next`（登录页的「未登录→/login」、requiresRole 等规则由守卫后半段处理）。
 */
export function restrictedNavigationDecision(input: RestrictedNavigationInput): RestrictedNavigationDecision {
  // ⚠ 变异靶子（M1）：这里若被改成 `input.restricted && input.signedIn && !input.metaPublic`，
  // 本模块的单测必须**秒红**（见 forcePasswordGuard.spec.ts 的「metaPublic 不参与判定」用例）。
  if (input.restricted && input.signedIn) {
    return input.toPath === FORCE_PASSWORD_PATH
      ? { action: 'allow' }
      : { action: 'rewrite', path: FORCE_PASSWORD_PATH };
  }
  if (input.toPath === FORCE_PASSWORD_PATH) {
    // 落地页口径直接取 stores/auth 的 afterLoginRoute（admin 无 fde_name → /admin，其余 → /）。
    return { action: 'rewrite', path: input.user ? afterLoginRoute(input.user) : '/login' };
  }
  return { action: 'next' };
}
