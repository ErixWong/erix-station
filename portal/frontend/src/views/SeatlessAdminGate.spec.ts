// issue #332：入口拦截的**挂载级**证据（工单 §二.2「拦截之后一条都不该发」）。
// 分工：`lib/workbenchGate.spec.ts` 钉判据算得对，`router.spec.ts` 钉守卫接对了地方，
// **本文件钉后果**：WorkbenchView 整棵子树根本没挂载 ⇒
// `GET /api/dirs` + `GET /api/sessions` + `GET /api/me/ports` 三趟一条都不发。
//
// 为什么必须挂 App 而不是 WorkbenchView：`WorkbenchView.spec.ts` / `WorkbenchPreviewPorts.spec.ts`
// 那两类用例是**直接 mount 视图组件**的，全局守卫压根不参与 ⇒ 它们验不到「不挂载」。
// 只有「真路由 + 真守卫 + 挂 App」这一条路径能证明「改写发生在挂载之前」。
// 挂载与否的标记取 `[data-test="preview-ports-toggle"]`（WorkbenchView 模板里无条件渲染的那条折叠条，
// `ForcePasswordChangeView.spec.ts` 也拿它当同一个「工作台是否挂载」的标记，#255 在用）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { useAuthStore, type AuthUser } from '../stores/auth';
import { i18n, setLocale } from '../i18n';

/** 第 ③ 类人：`role='admin'` 且 `fde_name` 为 null ⇒ 没有工位。 */
const SEATLESS_ADMIN = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;
/** 第 ② 类人：`role='admin'` 但 `fde_name` 有值 ⇒ 有工位，该照常挂在工作台里。 */
const ADMIN_WITH_SEAT = {
  ...SEATLESS_ADMIN, id: 'u9', login: 'root2', display_name: 'Root2', fde_name: 'root',
} as AuthUser;
/** 第 ① 类人：普通 FDE。 */
const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;

const WORKBENCH_MARKER = '[data-test="preview-ports-toggle"]';
/** 工单 §二.2 点名要省下的那三趟。 */
const WORKBENCH_FETCHES = ['/api/dirs', '/api/sessions', '/api/me/ports'];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** 真路由 + 真守卫 + 挂 App；返回全部被请求过的 URL（顺序即时间序）。 */
async function mountAppAt(initialPath: string, user: AuthUser) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    // ⚠ `/api/me/ports` 必须以 `/api/me` 之前判（前缀包含关系）。
    if (url.startsWith('/api/me/ports')) return jsonResponse(200, { items: [] });
    if (url.startsWith('/api/me')) return jsonResponse(200, { user });
    if (url.startsWith('/api/dirs')) {
      return jsonResponse(200, { dirs: [{ name: 'demo', cwd: '~/projects/demo', running_count: 0, queued_count: 0 }] });
    }
    // 深链的会话详情给 404 ⇒ 走 `resolveRouteSession` 的「静默回退」分支（workbench.ts:747-751）。
    // 给 200 但形状不对会踩到它未 catch 的 `session.cwd`（已另单的产品缺陷，见
    // `ForcePasswordErrors.spec.ts` 顶部那段）——本文件不想掺进与本单无关的 stderr 噪声。
    if (/^\/api\/sessions\//.test(url)) {
      return jsonResponse(404, { error: { code: 'not_found', message: 'not found' } });
    }
    if (url.startsWith('/api/sessions')) return jsonResponse(200, { items: [] });
    // 管理台侧（落在 /admin/users 时 AdminUsersView 会拉自己的列表）：形状对不对不影响本文件的判据，
    // 且 store 的 loadUsers 自己 catch，不会漏成 unhandled rejection。
    return jsonResponse(200, { items: [], users: [] });
  }));
  const auth = useAuthStore();
  auth.user = user;
  auth.ready = true; // 已探测过 ⇒ 守卫不再打 /api/me（本文件只数那三趟，多不多打 /api/me 无关）
  const router = createAppRouter(createMemoryHistory());
  router.push(initialPath);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
  await flushPromises();
  await new Promise((r) => setTimeout(r, 30));
  await flushPromises();
  return { wrapper, router, urls };
}

const countOf = (urls: string[], prefix: string) => urls.filter((u) => u.startsWith(prefix)).length;

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('#332 无工位平台管理员：工作台整棵子树不挂载（§二.2 零空请求）', () => {
  it('访问 / ⇒ 落地就是 #/admin/users，工作台标记不存在，三趟各 0 条', async () => {
    const { wrapper, router, urls } = await mountAppAt('/', SEATLESS_ADMIN);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/users'));
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
    for (const path of WORKBENCH_FETCHES) {
      expect(countOf(urls, path), `${path} 被请求了 ${countOf(urls, path)} 次（应为 0）`).toBe(0);
    }
  });

  it('深链 /session/:id（别人名下的会话）⇒ 同样落管理台，三趟各 0 条（§二.3 的新落点）', async () => {
    const { wrapper, router, urls } = await mountAppAt('/session/alice-session-1', SEATLESS_ADMIN);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/users'));
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
    for (const path of WORKBENCH_FETCHES) {
      expect(countOf(urls, path), `${path} 被请求了 ${countOf(urls, path)} 次（应为 0）`).toBe(0);
    }
  });

  // ↓↓ 反空操作对照：证明上面的「0 条」不是夹具坏了（fetch 桩没接上 / 标记选错也会得到 0）。
  it('对照：第 ② 类人（admin + 有工位）访 / ⇒ 工作台挂载，三趟各 ≥1 条', async () => {
    const { wrapper, router, urls } = await mountAppAt('/', ADMIN_WITH_SEAT);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(true);
    for (const path of WORKBENCH_FETCHES) {
      expect(countOf(urls, path), `${path} 一条都没打 ⇒ 对照失效（判据将失去意义）`).toBeGreaterThanOrEqual(1);
    }
  });

  it('对照：FDE 深链 /session/:id ⇒ 工作台照样挂载（本单零回归）', async () => {
    const { wrapper, router, urls } = await mountAppAt('/session/alice-session-1', FDE_USER);
    // 会话详情被测试桩回 404 ⇒ `resolveRouteSession` 的静默回退会把 URL 收回 `/`（既有语义），
    // 所以这里只断言「落在工作台这一侧」（`/` 或 `/session/:id`）+ 真的挂载了，不死盯具体地址。
    await vi.waitFor(() => expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(true));
    expect(['/', '/session/alice-session-1']).toContain(router.currentRoute.value.path);
    expect(countOf(urls, '/api/me/ports')).toBeGreaterThanOrEqual(1);
  });
});
