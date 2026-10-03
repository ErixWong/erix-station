// 登录组件交互单测：密码错误分支、TOTP 两步切换、afterLoginRoute 跳转、返回重登。
// issue #101 P1：装配真实 i18n（不 mock t()），默认注入 zh-CN，中文断言不变；新增切 en 的用例。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import LoginView from './LoginView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import type { AuthUser } from '../stores/auth';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function fetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  });
}

async function mountLogin() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  router.push('/login');
  await router.isReady();
  const wrapper = mount(LoginView, {
    global: { plugins: [pinia, router, i18n] },
  });
  return { wrapper, router, auth: useAuthStore() };
}

// 每个用例重置语言环境：清掉上个用例写入的 localStorage 偏好，并固定为默认 zh-CN。
beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('LoginView 交互', () => {
  it('初始渲染第一步表单（登录名/口令/下一步）', async () => {
    const { wrapper } = await mountLogin();
    expect(wrapper.find('#loginName').exists()).toBe(true);
    expect(wrapper.find('#loginPass').exists()).toBe(true);
    expect(wrapper.text()).toContain('下一步');
    expect(wrapper.find('#totpCode').exists()).toBe(false);
  });

  it('密码错误：展示服务端错误，停留在第一步', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(401, { error: { code: 'invalid_credentials', message: '用户名或口令错误' } })));
    const { wrapper, router } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('wrong');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('用户名或口令错误');
    expect(wrapper.find('#loginName').exists()).toBe(true);
    expect(router.currentRoute.value.path).toBe('/login');
  });

  it('未注册 TOTP 直通：跳到工作台 /', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, { status: 'authenticated', user: FDE_USER })));
    const { wrapper, router, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    // 懒加载组件解析 + 导航确认：轮询等待落地（避免数 tick 的脆弱写法）。
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(auth.user?.login).toBe('alice');
  });

  it('TOTP 两步：pending_token → 切第二步；验证成功 → 登录态', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/auth/login/totp')) {
        expect(JSON.parse(String(init?.body))).toEqual({ pending_token: 'ptok', code: '123456' });
        return jsonResponse(200, { user: FDE_USER });
      }
      return jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 });
    });
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, router, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    // 第二步出现、第一步隐藏
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(wrapper.find('#loginName').exists()).toBe(false);
    expect(wrapper.text()).toContain('输入认证器 6 位码');

    await wrapper.find('#totpCode').setValue('123456');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    // 懒加载组件解析 + 导航确认：轮询等待落地（避免数 tick 的脆弱写法）。
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(auth.user?.login).toBe('alice');
  });

  it('TOTP 校验失败：错误展示且仍在第二步（pendingToken 保留可重试）', async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/auth/login/totp')) {
        return jsonResponse(401, { error: { code: 'totp_invalid', message: 'TOTP 校验失败' } });
      }
      return jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 });
    });
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    await wrapper.find('#totpCode').setValue('000000');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toBe('TOTP 校验失败');
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(auth.pendingToken).toBe('ptok');
  });

  it('返回重新登录：回到第一步且可重新提交', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const { wrapper, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    // 限定 form 内：卡片头部的 LocaleSwitch 触发按钮也是 type="button"
    await wrapper.find('form button[type="button"]').trigger('click');
    expect(wrapper.find('#loginName').exists()).toBe(true);
    expect(auth.pendingToken).toBeNull();
  });

  it('平台管理员直通：跳到 /admin/users（afterLoginRoute + 默认管理台路由）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, { status: 'authenticated', user: ADMIN_USER })));
    const { wrapper, router } = await mountLogin();
    await wrapper.find('#loginName').setValue('root');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    // 懒加载组件解析 + 导航确认：轮询等待落地（避免数 tick 的脆弱写法）。
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/admin/users'));
  });

  it('语言切换到 English：登录页文案全量变英文并持久化', async () => {
    const { wrapper } = await mountLogin();
    // 切换前：中文（默认 locale）
    expect(wrapper.find('h2').text()).toBe('FDE Station 登录');
    expect(wrapper.find('label[for="loginName"]').text()).toBe('登录名');

    const sw = wrapper.findComponent(LocaleSwitch);
    await sw.find('button').trigger('click');
    const items = sw.findAll('[role="menuitem"]');
    expect(items.map((i) => i.text())).toEqual(['中文', 'English']);
    await items[1].trigger('click');

    // 切换后：同一视图内文案即时变英文（响应式生效），无重新挂载
    expect(wrapper.find('h2').text()).toBe('Sign in to FDE Station');
    expect(wrapper.find('label[for="loginName"]').text()).toBe('Login name');
    expect(wrapper.find('label[for="loginPass"]').text()).toBe('Password');
    expect(wrapper.find('button[type="submit"]').text()).toBe('Next');
    expect(sw.find('button').text()).toContain('English');
    // 持久化 + <html lang> 同步
    expect(localStorage.getItem('locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('切换到 English 后第二步（TOTP）文案同样变英文', async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const { wrapper } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.text()).toContain('输入认证器 6 位码');

    const sw = wrapper.findComponent(LocaleSwitch);
    await sw.find('button').trigger('click');
    await sw.findAll('[role="menuitem"]')[1].trigger('click');

    expect(wrapper.text()).toContain('Enter the 6-digit code from your authenticator app');
    expect(wrapper.find('button[type="submit"]').text()).toBe('Verify & sign in');
    expect(wrapper.find('form button[type="button"]').text()).toBe('← Back to login');
  });
});
