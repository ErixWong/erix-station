// 路由：hash 模式（createWebHashHistory）——portal 静态服务无 pathname 通配，
// 子路径由 hash 承担（与旧 index.html #/session/<id> 深链同一先例，issue #55 B1）。
import {
  createRouter,
  createWebHashHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router';
import { useAuthStore } from './stores/auth';
import { FORCE_PASSWORD_PATH, createRedirectBudget, restrictedNavigationDecision } from './lib/forcePasswordGuard';
// #332：工作台准入闸（admin 且无 fde_name ⇒ 送管理台）。判据本体在 lib/workbenchGate.ts，这里只接线。
import { workbenchGateDecision } from './lib/workbenchGate';
import { setRestrictedSessionListener } from './lib/restrictedSession';

// #255 强制改密屏的路径：唯一真相在 lib/forcePasswordGuard.ts（守卫判据与它同处）。
// 这里原样再导一次，保住既有调用方的 `import { FORCE_PASSWORD_PATH } from './router'` 写法。
export { FORCE_PASSWORD_PATH } from './lib/forcePasswordGuard';

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  // #255 首登强制改密（受限会话唯一出口）。`forcePassword` 不在 meta 上控制（它靠 store 旗标驱动，
  // 而旗标只能在服务端回答上变），这里只给路由一个名字，便于守卫判定与直链。meta.public：不受
  // 「未登录→/login」规则管辖（本屏自己处理无会话情形，见下方守卫）。
  // #255 首登强制改密（受限会话的唯一出口）。本屏的**画面**由 App.vue 的闸门渲染（唯一渲染点），
  // 路由表里这里挂的是一个空壳 ForcePasswordRouteShim——只需要这个地址存在（守卫改写 / 深链 /
  // router.replace 的落点）。不在这里再挂一次本体的理由见那个文件顶部的注释（① 的残余风险）。
  {
    path: FORCE_PASSWORD_PATH,
    name: 'change-password',
    component: () => import('./views/ForcePasswordRouteShim.vue'),
    meta: { public: true },
  },
  { path: '/', name: 'workbench', component: () => import('./views/WorkbenchView.vue') },
  // issue #55 B1 深链迁入路由层：#/session/<id>（hash 模式下与旧版 URL 形态一致，刷新/分享安全）。
  { path: '/session/:id', name: 'session', component: () => import('./views/WorkbenchView.vue') },
  {
    path: '/admin',
    component: () => import('./views/AdminLayout.vue'),
    meta: { requiresRole: 'admin' },
    children: [
      { path: '', redirect: { name: 'admin-users' }, meta: { requiresRole: 'admin' } },
      {
        path: 'users',
        name: 'admin-users',
        component: () => import('./views/AdminUsersView.vue'),
        meta: { requiresRole: 'admin' },
      },
      {
        path: 'llm',
        name: 'admin-llm',
        component: () => import('./views/AdminView.vue'),
        meta: { requiresRole: 'admin' },
      },
      {
        path: 'repos',
        name: 'admin-repos',
        component: () => import('./views/AdminReposView.vue'),
        meta: { requiresRole: 'admin' },
      },
      // issue #350：预览号池占用总览（只读）。懒加载组件 + 照邻居写 requiresRole；
      // 请求只在本视图挂载时发（判据①：进管理台不请求，切到这一 tab 才恰好 1 次）。
      {
        path: 'preview-pool',
        name: 'admin-preview-pool',
        component: () => import('./views/PreviewPoolUsageView.vue'),
        meta: { requiresRole: 'admin' },
      },
    ],
  },
];

// history 可注入（单测用 createMemoryHistory）；默认 hash 模式。
export function createAppRouter(history: RouterHistory = createWebHashHistory()): Router {
  const router = createRouter({
    history,
    routes,
  });

  // 全局守卫（auth = session cookie；/api/me 401/403 → /login）：
  //   ① 首次导航先探测 /api/me；② 已登录访问 /login → 回工作台；
  //   ③ 未登录访问受保护路由 → /login；④ requiresRole 不满足 → 工作台（旧版 /admin 403 的 SPA 等价）。
  //   ⑤ #255 受限会话：一切导航先被改写到 /change-password（「绕不过」的第二道机制，第一道在 App.vue）：
  //      手改 URL、深链 #/session/<id>、前进/后退、已登录访问 /login 全部算「别处」；
  //      旗标清掉后再访 /change-password 则送回落地页（不给正常用户留一个空屏）。
  // 死循环熔断（判据与理由见 lib/forcePasswordGuard.createRedirectBudget）：环转不起来 ⇒ 测试变红、
  // 线上停住 + 一条 warn，而不是把 CPU 与 CI 预算一起烧掉。
  const budget = createRedirectBudget();
  router.beforeEach(async (to) => {
    if (!budget.notePass()) {
      budget.reset();
      console.warn(`[router] 守卫重定向链条超过预算，已终止本次导航（目标 ${to.fullPath}）`);
      return false;
    }
    const auth = useAuthStore();
    if (!auth.ready) {
      try {
        await auth.ensureMe();
      } catch {
        // /api/me 网络级失败：按未登录处理（登录页内重试语义更清晰）。
        auth.user = null;
      }
    }
    // 受限态（服务端旗标）：除改密屏本身，其余一律拦回去。判据本体在 lib/forcePasswordGuard.ts
    // （可直接单测，不靠挂载），这里只负责接线。**它排在 public 判定之前**，
    // 所以 /login 也不能成为绕过口（登录后访问 /login 会被改写到改密屏）。
    const decision = restrictedNavigationDecision({
      restricted: auth.passwordChangeRequired,
      signedIn: !!auth.user,
      toPath: to.path,
      // ⚠ 送进去仅供「它不参与判定」这一事实可被断言；改这条判据请同步改 lib 的单测。
      metaPublic: to.meta.public === true,
      user: auth.user,
    });
    if (decision.action === 'rewrite') return { path: decision.path };
    // `allow` = 受限态下改密屏本身（它 meta.public，交给下面的分支会被当成「已登录访 public ⇒ 回落地页」）。
    if (decision.action === 'allow') return true;
    if (to.meta.public) {
      // 已登录访问 /login → 回工作台（带 redirect 时优先回跳原目标）。
      if (!auth.user) return true;
      const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/';
      return { path: redirect.startsWith('/') ? redirect : '/' };
    }
    // 未登录访问受保护路由 → /login，并带 redirect 回跳（登录后恢复原目标，如深链会话）。
    if (!auth.user) return { path: '/login', query: { redirect: to.fullPath } };
    // #332：没有工位的平台管理员（`role==='admin' && !fde_name`）不得停留在工作台（`/`、`/session/:id`）
    // ⇒ 一律改写去管理台。接在「未登录 → /login」之后、「requiresRole」之前：
    //  • 排在这里 ⇒ 拦在**挂载前**，WorkbenchView 的 onMounted（GET /api/dirs + /api/sessions + /api/me/ports）
    //    根本不跑，三趟空请求一条都不发（工单 §二.2）；深链 `#/session/<id>`（别人的会话）也因此
    //    不再先踢回 `#/` 再被工作台空转一次（§二.3）。
    //  • 与 requiresRole 互不干扰：/admin* 不是工作台路由（判据直接 next），而 fde 访 /admin 的回退仍走下面那条。
    const gate = workbenchGateDecision({ user: auth.user, toPath: to.path });
    if (gate.action === 'rewrite') return { path: gate.path };
    if (to.meta.requiresRole && auth.user.role !== to.meta.requiresRole) return { path: '/' };
    return true;
  });

  // 链条只在「一次导航真正落地」后归零（重定向期间 beforeEach 反复进来，afterEach 不会跑）。
  router.afterEach(() => budget.reset());
  router.onError(() => budget.reset());

  // #255 全局兜底的导航侧（§2.11a）：任意请求返回 403 password_change_required ⇒ 除了 store 置旗标
  // （App 闸门负责换画面），这里把 URL 也改到改密屏，否则地址栏会停在 #/session/<id> 上骗人。
  // 判据在 lib/restrictedSession.ts（**不散在视图里**）；旗标的唯一写点是 store 的动作。
  setRestrictedSessionListener(() => {
    const auth = useAuthStore();
    auth.markRestrictedSession();
    if (router.currentRoute.value.path !== FORCE_PASSWORD_PATH) {
      // 改写后的导航同样会过一遍上面的守卫（受限 ⇒ 正是改密屏）；重复导航当成功处理。
      void router.replace(FORCE_PASSWORD_PATH).catch(() => undefined);
    }
  });

  return router;
}

export const router = createAppRouter();
