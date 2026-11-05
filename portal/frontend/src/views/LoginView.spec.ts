// 登录组件交互单测：密码错误分支、TOTP 两步切换、afterLoginRoute 跳转、返回重登。
// issue #101 P1：装配真实 i18n（不 mock t()），默认注入 zh-CN，中文断言不变；新增切 en 的用例。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import LoginView from './LoginView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import type { AuthUser } from '../stores/auth';
// #449 结构判据：同一份源码文本（vite `?raw` 构建期读盘，jsdom 下不依赖 node 内建）。
import loginViewSource from './LoginView.vue?raw';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
} as AuthUser;

// #449：第三个参数（可选）用来造带 `Retry-After` 的 429/503 响应。
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
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

// ---- issue #449：第二步的另一条通道——邮箱验证码（portal.md §2.2/§2.3a/§2.3b）----
// 断言口径：行为（渲染什么、发什么请求、按钮可用性）为主；末尾另有一条**源码级**判据钉住
// 「TOTP 分支一字未改」（行为用例测不出「同效果的重写」，见 terminationReasons.spec 的同一手法）。
const EMAIL_CODE_REQUIRED = {
  status: 'email_code_required', pending_token: 'ptok-mail', expires_in: 600, email_hint: 'a***@e***.com',
};

/** 第一步走邮箱验证码的 fetch 桩；`resend` 决定重发端点的回答。 */
function emailStepFetch(resend: () => Response | Promise<Response>, submit?: () => Response | Promise<Response>) {
  return fetchMock((url) => {
    if (url.includes('/api/auth/login/email-code/resend')) return resend();
    if (url.includes('/api/auth/login/email-code')) {
      if (submit) return submit();
      return jsonResponse(200, { password_change_required: false, user: FDE_USER });
    }
    return jsonResponse(200, EMAIL_CODE_REQUIRED);
  });
}

/** 走完第一步，停在邮箱验证码第二步。 */
async function gotoEmailStep(wrapper: Awaited<ReturnType<typeof mountLogin>>['wrapper']) {
  await wrapper.find('#loginName').setValue('alice');
  await wrapper.find('#loginPass').setValue('secret');
  await wrapper.find('form').trigger('submit.prevent');
  await flushPromises();
}

describe('LoginView 邮箱验证码第二步（#449）', () => {
  afterEach(() => vi.useRealTimers());

  it('渲染脱敏收件人 + 6 位码输入框（属性齐全）并自动聚焦；TOTP 分支不在场', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, EMAIL_CODE_REQUIRED)));
    // 自动聚焦：VTU 默认不把根节点挂进 document（jsdom 里对游离元素 focus() 无效），
    // 故直接在原型上盯「谁被 focus 了」，而不是读 document.activeElement。
    const focusSpy = vi.spyOn(HTMLInputElement.prototype, 'focus');
    const { wrapper } = await mountLogin();
    await gotoEmailStep(wrapper);

    expect(wrapper.find('#loginName').exists()).toBe(false); // 已离开第一步
    expect(wrapper.find('#totpCode').exists()).toBe(false); // 不是 TOTP 通道
    const input = wrapper.find('#emailCode');
    expect(input.exists()).toBe(true);
    expect(input.attributes('inputmode')).toBe('numeric');
    expect(input.attributes('maxlength')).toBe('6');
    expect(input.attributes('autocomplete')).toBe('one-time-code');
    expect(wrapper.text()).toContain('a***@e***.com'); // 「验证码已发送到 …」
    expect(wrapper.text()).toContain('没收到可以重发');
    expect(focusSpy.mock.instances.at(-1)).toBe(input.element); // 自动聚焦
    expect(wrapper.find('#emailResend').text()).toBe('重发验证码');
    focusSpy.mockRestore();
  });

  it('输入 6 位码提交：POST /api/auth/login/email-code 并落地工作台', async () => {
    const fetchFn = emailStepFetch(() => jsonResponse(200, { expires_in: 600, resend_after: 60 }));
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, router, auth } = await mountLogin();
    await gotoEmailStep(wrapper);

    await wrapper.find('#emailCode').setValue('654321');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    const call = fetchFn.mock.calls.find(([url]) => String(url).includes('/api/auth/login/email-code') && !String(url).endsWith('/resend'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]?.body))).toEqual({ pending_token: 'ptok-mail', code: '654321' });
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(auth.user?.login).toBe('alice');
  });

  it('重发按钮冷却倒计时（假定时器）：60 秒禁用 → 每秒递减 → 归零恢复', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.stubGlobal('fetch', emailStepFetch(() => jsonResponse(200, { expires_in: 600, resend_after: 60 })));
    const { wrapper } = await mountLogin();
    await gotoEmailStep(wrapper);

    const resend = wrapper.find('#emailResend');
    expect(resend.attributes('disabled')).toBeUndefined(); // 冷却前可用
    await resend.trigger('click');
    await flushPromises();

    expect(resend.text()).toBe('60 秒后可重发');
    expect(resend.attributes('disabled')).toBeDefined(); // 冷却中禁用

    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.find('#emailResend').text()).toBe('59 秒后可重发');

    vi.advanceTimersByTime(59_000);
    await nextTick();
    expect(wrapper.find('#emailResend').text()).toBe('重发验证码');
    expect(wrapper.find('#emailResend').attributes('disabled')).toBeUndefined(); // 自动恢复
    wrapper.unmount();
  });

  it('第一步发信失败（503）：留在第二步、按钮文案「重新发送」且不受冷却限制', async () => {
    // 第一步直接 503（details 里带 pending_token，另带 Retry-After: 5——服务端给的那个值不许卡住重发）
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(503, {
      error: {
        code: 'email_send_failed', message: '验证码邮件发送失败，请稍后重试', retryable: true,
        details: { pending_token: 'ptok-mail', expires_in: 600, email_hint: 'a***@e***.com' },
      },
    }, { 'Retry-After': '5' })));
    const { wrapper, auth } = await mountLogin();
    await gotoEmailStep(wrapper);

    expect(wrapper.find('#emailCode').exists()).toBe(true); // 没有被踢回第一步
    expect(wrapper.text()).toContain('a***@e***.com');
    const resend = wrapper.find('#emailResend');
    expect(resend.text()).toBe('重新发送');
    expect(resend.attributes('disabled')).toBeUndefined(); // 服务端此时还没有码行 ⇒ 不受冷却限制

    // 点一下：走重发端点（带手上这枚 pending），成功后回到冷却倒计时
    vi.stubGlobal('fetch', emailStepFetch(() => jsonResponse(200, { expires_in: 600, resend_after: 60 })));
    await resend.trigger('click');
    await flushPromises();
    expect(auth.sendFailed).toBe(false);
    expect(wrapper.find('#emailResend').text()).toBe('60 秒后可重发');
    wrapper.unmount();
  });

  it('返回上一步：清 pending 回口令输入', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, EMAIL_CODE_REQUIRED)));
    const { wrapper, auth } = await mountLogin();
    await gotoEmailStep(wrapper);
    expect(wrapper.find('#emailCode').exists()).toBe(true);

    await wrapper.find('#emailBack').trigger('click');
    expect(wrapper.find('#loginName').exists()).toBe(true);
    expect(wrapper.find('#emailCode').exists()).toBe(false);
    expect(auth.pendingToken).toBeNull();
    expect(auth.factor).toBeNull();
  });

  it('码错（401 email_code_invalid）：错误展示且仍在第二步', async () => {
    vi.stubGlobal('fetch', emailStepFetch(
      () => jsonResponse(200, { expires_in: 600, resend_after: 60 }),
      () => jsonResponse(401, { error: { code: 'email_code_invalid', message: '验证码错误或已失效' } }),
    ));
    const { wrapper, auth } = await mountLogin();
    await gotoEmailStep(wrapper);
    await wrapper.find('#emailCode').setValue('000000');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').text()).toContain('验证码不对或已失效');
    expect(wrapper.find('#emailCode').exists()).toBe(true);
    expect(auth.pendingToken).toBe('ptok-mail');
  });
});

// ---- 结构判据（#449 的验收要求）：TOTP 分支**一字未改** ----
describe('#449 TOTP 分支未被改动', () => {
  it("factor==='totp' 时仍渲染 #totpCode、不渲染 #emailCode", async () => {
    vi.stubGlobal('fetch', fetchMock(() =>
      jsonResponse(200, { status: 'totp_required', pending_token: 'ptok', expires_in: 120 })));
    const { wrapper, auth } = await mountLogin();
    await gotoEmailStep(wrapper);
    expect(auth.factor).toBe('totp');
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(wrapper.find('#emailCode').exists()).toBe(false);
    expect(wrapper.text()).toContain('输入认证器 6 位码');
  });

  it('源码级：TOTP 第二步的模板片段逐字仍在（改一个字就红）', () => {
    const TOTP_STEP = `        <!-- 第二步：TOTP（pending_token 已换取） -->
        <form v-else @submit.prevent="onTotpSubmit">
          <p class="text-black/50 text-sm mb-3">{{ t('login.totpHint') }}</p>
          <label class="block text-xs text-black/50 mb-1" for="totpCode">{{ t('login.totpLabel') }}</label>
          <input
            id="totpCode" ref="totpInput" v-model="code"
            inputmode="numeric" maxlength="6" autocomplete="one-time-code"
            class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
          >
          <button
            type="submit" :disabled="auth.loading"
            class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"
          >{{ t('login.totpSubmit') }}</button>
          <button
            type="button"
            class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5"
            @click="auth.backToLogin()"
          >{{ t('login.backToLogin') }}</button>
        </form>`;
    expect(loginViewSource).toContain(TOTP_STEP);
  });
});
