// 路由：hash 模式（createWebHashHistory）——portal 静态服务无 pathname 通配，
// 子路径由 hash 承担（与旧 index.html #/session/<id> 深链同一先例，issue #55 B1）。
import {
  createRouter,
  createWebHashHistory,
  type Router,
  type RouterHistory,
  type RouteRecordRaw,
} from 'vue-router';
import { afterLoginRoute, useAuthStore } from './stores/auth';

/** #255 强制改密屏的路径（守卫与 App 闸门的唯一合法去处）。 */
export const FORCE_PASSWORD_PATH = '/change-password';

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  // #255 首登强制改密（受限会话唯一出口）。`forcePassword` 不在 meta 上控制（它靠 store 旗标驱动，
  // 而旗标只能在服务端回答上变），这里只给路由一个名字，便于守卫判定与直链。meta.public：不受
  // 「未登录→/login」规则管辖（本屏自己处理无会话情形，见下方守卫）。
  {
    path: FORCE_PASSWORD_PATH,
    name: 'change-password',
    component: () => import('./views/ForcePasswordChangeView.vue'),
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
  router.beforeEach(async (to) => {
    const auth = useAuthStore();
    if (!auth.ready) {
      try {
        await auth.ensureMe();
      } catch {
        // /api/me 网络级失败：按未登录处理（登录页内重试语义更清晰）。
        auth.user = null;
      }
    }
    // 受限态（服务端旗标）：除改密屏本身，其余一律拦回去。注意这条**排在 public 判定之前**，
    // 所以 /login 也不能成为绕过口（登录后访问 /login 会被改写到改密屏）。
    if (auth.user && auth.passwordChangeRequired) {
      return to.path === FORCE_PASSWORD_PATH ? true : { path: FORCE_PASSWORD_PATH };
    }
    // 非受限态访 /change-password：本屏没有存在意义（且 App 闸门也不渲染它），回落地页。
    if (to.path === FORCE_PASSWORD_PATH) {
      return auth.user ? { path: afterLoginRoute(auth.user) } : { path: '/login' };
    }
    if (to.meta.public) {
      // 已登录访问 /login → 回工作台（带 redirect 时优先回跳原目标）。
      if (!auth.user) return true;
      const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/';
      return { path: redirect.startsWith('/') ? redirect : '/' };
    }
    // 未登录访问受保护路由 → /login，并带 redirect 回跳（登录后恢复原目标，如深链会话）。
    if (!auth.user) return { path: '/login', query: { redirect: to.fullPath } };
    if (to.meta.requiresRole && auth.user.role !== to.meta.requiresRole) return { path: '/' };
    return true;
  });

  return router;
}

export const router = createAppRouter();
