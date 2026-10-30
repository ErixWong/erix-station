// 管理台外壳（顶栏 + tab 导航）的单测——**只钉一件事**：那颗登出按钮确实汇到 `auth.logout()`。
//
// 为什么值得单独一个文件（issue #431）：登出的收口判据是「**全站有几颗登出按钮**」，不是「哪个视图
// 想到了要收摊」。全站三颗——`WorkbenchView` / 本文件 / `ForcePasswordChangeView`，而 `stores/auth.spec.ts`
// 钉的是 `logout()` ⇒ `notifyUserScopeReset()`、`WorkbenchView.spec.ts` 钉的是 `notify` ⇒ 断流清空，
// 中间一直缺「AdminLayout 这颗按钮 = `auth.logout()`」这段胶水（本组件此前**没有任何 spec**）。
// 现在 #429 又把预览凭证的回收也挂在同一条 logout 上 ⇒ 这颗按钮漏接就是「换个平面继续穿越」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AdminLayout from './AdminLayout.vue';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import { setUserScopeResetListener } from '../lib/userScope';

const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
};

/** 不带应用守卫的裸路由：本组件只用 useRoute/useRouter，守卫的 /api/me 与本单无关。 */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: AdminLayout },
      { path: '/login', component: { template: '<div>login</div>' } },
      // 顶栏四个 tab 用的是 `{ name: ... }` 形式的 :to ⇒ 路由表里没有这些名字，挂载当场就
      // "No match for {name:'admin-users'}" 抛错（不是断言失败）。给桩即可，本单不测 tab。
      ...['admin-users', 'admin-llm', 'admin-repos', 'admin-preview-pool']
        .map((name) => ({ path: `/${name}`, name, component: { template: '<div />' } })),
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  setUserScopeResetListener(null);
  vi.unstubAllGlobals();
});

describe('AdminLayout 顶栏登出（#431 收口链路的那颗按钮）', () => {
  it('点「登出」：打 /api/auth/logout、跳 /login，并触发用户 scope 复位', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(null, { status: 204 });
    }));
    let notified = 0;
    setUserScopeResetListener(() => { notified += 1; }); // 工作台侧注册的就是这个（此处用 spy 代替）

    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    const logout = wrapper.findAll('header button').at(-1)!;
    expect(logout.text()).toBe('登出');
    await logout.trigger('click');
    await flushPromises();

    expect(calls.filter((u) => u.startsWith('/api/auth/logout'))).toHaveLength(1);
    expect(router.currentRoute.value.path).toBe('/login');
    expect(notified, '这颗按钮必须汇到 auth.logout()——否则从管理台登出时上一账号的 SSE 没人关').toBe(1);
  });
});
