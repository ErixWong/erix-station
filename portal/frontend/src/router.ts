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

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
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
