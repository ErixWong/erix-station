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

/**
 * #255 熔断预算的默认趟数（`createRedirectBudget()` 缺省值；单测钉住它 == 12）。
 *
 * 为什么是 12（默认值既不能太小也不能太大，也不能是 Infinity）：
 * - **语义**：它数的是「同一次导航链里守卫 `beforeEach` 被进来的趟数」。`afterEach` 只在导航
 *   真正落地时跑，所以重定向期间预算是**连续累计**的——正常链条最多 3~4 趟
 *   （典型最深：未登录深链 `/session/x` → `/login?redirect=…` → 登录成功回跳 → requiresRole
 *   不满足再回退 `/`；受限态则是「目标 → /change-password」两趟）。
 * - **太小会误熔断正常跳转**：取 2~4 会让上面那条合法的三跳深链被判成环，用户表现为
 *   「深链偶尔进不去 + 一条 warn」，比原 bug 更难查（它是**间歇性**的，且只在链条深的入口出现）。
 * - **太大就失去熔断意义**：环每趟只是一次微任务，预算 N 就是烧 N 次同步开销——单看一次导航
 *   N=12 和 N=1000 都不卡人，真正的差别在**测试**：环一旦能被预算掐断，vitest 就会在几秒内
 *   拿到一条断言失败（本模块单测实测 <3s），而不是像改造前那样微任务饥饿吃掉 testTimeout、
 *   200 秒零输出 exit 124。所以「有限」比「具体多大」重要，但 12 已经足够贴近「正常链条的 3 倍」
 *   这个既不误伤、又一眼能读懂的刻度。
 * - **必须是有限数**：Infinity 会让 spec 里那个 `while (budget.notePass())` 白名单式的循环
 *   永远转下去——「默认值退化成无界」本身就是一种挂死，与本模块要消灭的失败模式同源。
 */
export const REDIRECT_BUDGET_DEFAULT_LIMIT = 12;

/** `createRedirectBudget` 的返回值（守卫只用到这三个成员，故不导出更多表面积）。 */
export interface RedirectBudget {
  /**
   * 记一趟「守卫被进来」。**返回 true = 预算内，正常继续本次导航；false = 已超预算**，
   * 调用方必须终止本次导航（`return false`）并 `reset()`，绝不能再返回一个重定向目标
   * ——那正是把「红」变成「挂死」的地方。超预算后恒为 false（直到 `reset()`）。
   */
  notePass(): boolean;
  /** 归零：导航落地（`router.afterEach`）/ 出错（`router.onError`）时调用，保证正常多次跳转不被误熔断。 */
  reset(): void;
  /** 当前已用趟数（只读观测口，给断言与调试用；恒 ≤ 预算）。 */
  readonly used: number;
}

/**
 * #255 守卫重定向链条的**熔断器**：把「守卫 A→B→A 的环」从挂死变成可终止。
 *
 * 为什么需要它（vue-router 自带的检测不够用）：它的无限重定向保护只认「目标与当前路由相同」的
 * **自环**，认不出 `/login → / → /change-password → /` 这种**多节点环**——环跑在微任务里，
 * testTimeout / Promise.race+setTimeout 全被饥饿吃掉，实测 200 秒零输出（exit 124）。
 * 于是这里自己数趟数：超预算 ⇒ 守卫返回 `false` 掐断链条 ⇒ 测试几秒内变红、线上停在原地留一条 warn。
 *
 * 形状（与 `forcePasswordGuard.spec.ts` 的三条用例逐字对齐）：预算内连续 `notePass()` 恒 true，
 * 越过预算后恒 false；`reset()` 后 `used === 0` 且可继续使用；缺省参数用 {@link REDIRECT_BUDGET_DEFAULT_LIMIT}。
 *
 * @param limit 允许的趟数上限；缺省 12（理由见 REDIRECT_BUDGET_DEFAULT_LIMIT）。传入非有限数或负数
 *              同样退回缺省值——**故意不接受 Infinity/NaN**：那等于没有熔断，而「以为有熔断」比
 *              「没有熔断」更难排查。`0` 是合法值（一趟都不许过，用于「守卫直接拒绝一切导航」的测试）。
 */
export function createRedirectBudget(limit: number = REDIRECT_BUDGET_DEFAULT_LIMIT): RedirectBudget {
  const maxBudget = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : REDIRECT_BUDGET_DEFAULT_LIMIT;
  let used = 0;
  return {
    notePass(): boolean {
      // 先判后加 ⇒ used 恒 ≤ maxBudget，且超限后不再累加（超预算的趟数已经不再产生副作用）。
      if (used >= maxBudget) return false;
      used += 1;
      return true;
    },
    reset(): void {
      used = 0;
    },
    get used(): number {
      return used;
    },
  };
}
