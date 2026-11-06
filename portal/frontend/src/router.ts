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
import { useSiteStore } from './stores/site';
import { FORCE_PASSWORD_PATH, createRedirectBudget, restrictedNavigationDecision } from './lib/forcePasswordGuard';
// #332：工作台准入闸（admin 且无 fde_name ⇒ 送管理台）。判据本体在 lib/workbenchGate.ts，这里只接线。
import { workbenchGateDecision } from './lib/workbenchGate';
// #450 A2：host 闸（在错的 host 上就跳到对的 host）。判据本体在 lib/hostGate.ts，这里只接线。
import { hashUrl, hostGateDecision } from './lib/hostGate';
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
      // issue #449 管理台切片：邮件通道配置（§4.12）。照 `admin-repos` 的写法（懒加载 + requiresRole）。
      // 请求只在本视图挂载时发（`AdminMailView` 的 onMounted 是唯一触发点）。
      {
        path: 'mail',
        name: 'admin-mail',
        component: () => import('./views/AdminMailView.vue'),
        meta: { requiresRole: 'admin' },
      },
      // issue #456 M2：证书页（§4.13）。导航顺序：users → llm → repos → mail → **certs** → pool。
      // 请求只在本视图挂载时发（`AdminTlsView` 的 onMounted 是唯一触发点）。
      {
        path: 'tls',
        name: 'admin-tls',
        component: () => import('./views/AdminTlsView.vue'),
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
// #450 A2：`deps` 只为一件事存在——**跨 origin 跳转的两个副作用**（换地址、读当前 origin）必须可在单测里
// 打桩：`window.location.replace()` 在 jsdom 里是「未实现」的导航（静默无效），而真跳会让用例跑出进程。
// 生产路径两个缺省值就是 `window.location.replace` / `window.location.origin`，没有别的分支。
export interface RouterDeps {
  /** 跳转落点（缺省 `window.location.replace`）。**跨 origin**：vue-router 管不到。 */
  navigate?: (url: string) => void;
  /** 当前页面 origin（缺省 `window.location.origin`）。 */
  currentOrigin?: () => string;
}

/**
 * 跨 host 跳转熔断（2026-11-06）。
 *
 * 为什么需要它：`hostGate` 的每一跳单看都合法，但**两个 host 的登录 cookie 是 host-only ⇒ 可以是不同账号**
 * （8443=admin、9443=eric 是真实状态），于是「各自把自己认为不该在这里的路径送走」会互相撞成一个环。
 * 根因已在 `hostGate.ts` 修掉（管理台 host 不再跨 host 跳转），这里是**与具体路径无关的上界**：
 * 10 秒窗口内超过 3 次跨 host 跳转就停住 + console.error（诊断能截图给运维）。
 *
 * 存 `sessionStorage` 的理由：跨 host 是**整页导航**，内存变量会清零；而 sessionStorage 按 tab 保留。
 * 拿不到（隐私模式 / 被禁）⇒ fail-open，不拦（宁可多跳，也不要因为存储不可用而白屏）。
 */
const HOST_HOP_KEY = 'station.hostGate.hops';
const HOST_HOP_LIMIT = 3;
const HOST_HOP_WINDOW_MS = 10_000;

/** `scheme://host[:port]` 的 hostname（解析失败 ⇒ null）。判「我在哪个面」用它（与 hostGate 同口径）。 */
function hostnameOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** `url` 与 `origin` 是否同源（用 URL 解析比，不做字符串前缀比较——443 与显式端口是同一 origin）。 */
function sameOriginAs(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function allowHostHop(now = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(HOST_HOP_KEY);
    const prev = raw ? JSON.parse(raw) : null;
    const inWindow = prev && typeof prev.at === 'number' && now - prev.at < HOST_HOP_WINDOW_MS;
    const n = inWindow ? prev.n + 1 : 1;
    sessionStorage.setItem(HOST_HOP_KEY, JSON.stringify({ n, at: now }));
    return n <= HOST_HOP_LIMIT;
  } catch {
    return true;
  }
}

function resetHostHopBudget(): void {
  try {
    sessionStorage.removeItem(HOST_HOP_KEY);
  } catch {
    /* 存储不可用：本来就没计数，无需复位 */
  }
}

export function createAppRouter(
  history: RouterHistory = createWebHashHistory(),
  deps: RouterDeps = {},
): Router {
  const navigate = deps.navigate ?? ((url: string) => { window.location.replace(url); });
  const currentOrigin = deps.currentOrigin ?? (() => window.location.origin);
  const router = createRouter({
    history,
    routes,
  });

  // 全局守卫（auth = session cookie；/api/me 401/403 → /login）：
  //   ⓪ #450 A2 host 闸：发现自己在错的 host 上 ⇒ 换 origin（跳完 `return false`，本次导航终止）；
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
    // #450 A2：**host 闸排在最前面**（在 `auth.ensureMe()` 之前）——「我在哪个 host 上」与「我是谁」
    // 是两件事，前者不该先花一次 `/api/me` 的往返（错的 host 上那个请求也会白跑一趟）。
    // 判据本体在 lib/hostGate.ts（六行矩阵 + 防环 + fail-open 都有单测），这里只负责接线：
    //  · `ensureSite()` **永不抛**：拿不到 `/api/site` ⇒ null ⇒ 判据 fail-open（不跳）。
    //  · 命中 redirect 时用 `navigate`（= `window.location.replace`）换地址，并 **`return false` 终止本次导航**。
    //    ⚠ 绝不能 `return { path }`：那是「在**当前** origin 上继续导航」，而我们刚刚决定这个 origin 是错的。
    // ⚠ 唯一例外：`/admin*` 的跨 host 决策**需要登录态**——「未登录 / 非管理员访管理台」应当**留在本 host**
    // 处理（跨 host 登录必然丢会话：cookie host-only ⇒ 送过去、登进去、再被踢回来的环，2026-11-06 真机复现）。
    // 只有这条路径值得多花一次 `/api/me`；其它路径仍保持「先判 host、不白跑」的既有口径。
    const auth = useAuthStore();
    const adminTarget = to.path.startsWith('/admin');
    if (adminTarget && !auth.ready) {
      try {
        await auth.ensureMe();
      } catch {
        auth.user = null;
      }
    }
    const siteInfo = await useSiteStore().ensureSite();
    const hostGate = hostGateDecision({
      currentOrigin: currentOrigin(),
      userBaseUrl: siteInfo?.userBaseUrl,
      adminBaseUrl: siteInfo?.adminBaseUrl,
      // `fullPath`（路径 + query）原样进 hash：`#/session/<id>?tab=x` 的深链不能被吃掉。
      toPath: to.fullPath,
    });
    if (hostGate.action === 'redirect') {
      // 跨 host 跳转熔断（2026-11-06 真机「8443 ↔ 9443 疯狂跳转」的兜底）。
      // 任何单侧判据都可能自洽却互相对撞（两个 host 的会话可以是不同账号），所以除了修根因，
      // 还要有一条**与具体路径无关**的上界：10 秒内跨 host 跳转超过 3 次 ⇒ 停住并留诊断。
      // 判据用 sessionStorage（同一 tab 内跨整页导航仍在），拿不到就 fail-open（不拦）。
      if (!allowHostHop()) {
        console.error('[router] host 闸跳转熔断：10s 内已跨 host 跳转 3 次，停在当前页', {
          from: currentOrigin(),
          to: hostGate.url,
          path: to.fullPath,
        });
        return false;
      }
      // ① 未登录 + 目标是管理路径 ⇒ 就在**本 host** 登录（登录后是管理员再跨过去）。
      if (adminTarget && !auth.user) return { path: '/login', query: { redirect: to.fullPath } };
      // ② 已登录但**不是管理员** + 管理路径 ⇒ 回工作台（不把人送去一个他进不去的入口）。
      if (adminTarget && auth.user && auth.user.role !== 'admin') return { path: '/' };
      // 同 host 改道（如管理台 host 的 `/` ⇒ `/admin/users`）走 **hash 内导航**，不整页重载：
      // 跨 host 才需要 `window.location.replace`（那是换 origin 的唯一办法）。
      // 判据用 `new URL().origin`（443 与显式端口的等价性靠它，不靠字符串前缀）。
      const sameHost = sameOriginAs(hostGate.url, currentOrigin());
      if (sameHost) {
        const target = new URL(hostGate.url);
        return { path: target.hash.replace(/^#/, '') || '/' };
      }
      navigate(hostGate.url);
      return false;
    }
    resetHostHopBudget();
    if (!auth.ready) {
      try {
        await auth.ensureMe();
      } catch {
        // /api/me 网络级失败：按未登录处理（登录页内重试语义更清晰）。
        auth.user = null;
      }
    }
    // 「身份 × 入口」不符 ⇒ **就地登出**（2026-11-06 真机无限环的第二个来源）。
    //
    // 两个 host 的登录 cookie 是 host-only ⇒ 它们可以是**不同账号**。管理台上挂着一个 FDE 会话时：
    // 每条 `/admin*` 都被 requiresRole 踢回 `/`，而 `/` 又被 hostGate 改道回 `/admin/users` ⇒ 环；
    // 用户面上挂着一个无工位 admin 会话同理（`/` ⇄ `/admin/users`）。这类会话在本入口**毫无用处**
    // （管理台入口对非 admin 的所有 API 都是 403/404），留着只会让守卫把它推来推去。
    // 登出后 `auth.user` 变 null，下一跳就是干净的登录页，环自然断掉。
    if (siteInfo && auth.user) {
      const hereHost = hostnameOf(currentOrigin());
      const adminHost = hostnameOf(siteInfo.adminBaseUrl);
      const userHost = hostnameOf(siteInfo.userBaseUrl);
      const onAdmin = !!(hereHost && adminHost && hereHost === adminHost);
      const onUser = !!(hereHost && userHost && hereHost === userHost);
      // ① 管理台上挂着非管理员会话 ⇒ 登出，停在登录页（他在管理台没有目的地，任何跳转都会成环）。
      if (onAdmin && auth.user.role !== 'admin') {
        await auth.logout();
        return { path: '/login' };
      }
      // ② 用户面上挂着**无工位管理员**会话 ⇒ 登出后送去管理台（他唯一的入口，目标明确）。
      //    先登出是必须的：不清掉用户面这份会话，管理台那边若挂着别人又会互相送回。
      if (onUser && auth.user.role === 'admin' && !auth.user.fde_name) {
        await auth.logout();
        const adminTarget = hashUrl(siteInfo.adminBaseUrl, '/admin/users');
        if (adminTarget !== null) {
          navigate(adminTarget);
          return false;
        }
        return { path: '/login' };
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
