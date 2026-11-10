// 登录组件交互单测：密码错误分支、TOTP 两步切换、afterLoginRoute 跳转、返回重登。
// issue #101 P1：装配真实 i18n（不 mock t()），默认注入 zh-CN，中文断言不变；新增切 en 的用例。
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, flushPromises, enableAutoUnmount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import LoginView from './LoginView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
// feat-261110-01：switch 的两档文案直接引用 locale（不手抄中英文），两边都改了才不会假绿。
import { zhCN } from '../i18n/locales/zh-CN';
import { en } from '../i18n/locales/en';
import type { AuthUser } from '../stores/auth';
import { nextRouteLanding } from '../test-utils/navigation';

// #473 family B：本文件每条用例都 mount 一个 LoginView，但历史上 **0 次 unmount** ⇒ 上一例的
// 登录处理器还在跑，其在途的 await 会落进下一条用例的 active pinia。enableAutoUnmount 另注册一个
// afterEach，与下面已有的那个并存，顺序无关。
enableAutoUnmount(afterEach);
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
    // A 类：导航由组件里的 router.replace(loginRedirect()) 触发 ⇒ **先订阅再触发**。
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    // 导航落地用显式判据（#473 family B：原 vi.waitFor 默认 1000ms 是墙钟，慢机上假红）。
    expect(await landed).toBe('/');
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
    // A 类：先订阅再提交（第二步成功后同样由 router.replace 落工作台）。
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(await landed).toBe('/');
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
    // B 类（实测结论，不是投机）：本例的提交**根本不产生导航** —— 桩把每个 URL（含 /api/site）都回成
    // 同一个 body ⇒ isAdminEntry 为假，而 ADMIN_USER 是无工位管理员 ⇒ LoginView 的 guardEntryRole()
    // 就地 logout 并 return false，`router.replace(loginRedirect())` 那行走不到。而 /admin/users 早在
    // 夹具那次**已 await** 的导航里就落地了（/login 已登录 ⇒ 守卫改写 / ⇒ #332 再改写 /admin/users）。
    // ⇒ 拿 nextRouteLanding 订阅会永远等不到（实测 5000ms 超时），直接断言当前路由才是这里的显式判据。
    expect(router.currentRoute.value.path).toBe('/admin/users');
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
    // A 类：先订阅再提交。
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    const call = fetchFn.mock.calls.find(([url]) => String(url).includes('/api/auth/login/email-code') && !String(url).endsWith('/resend'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call![1]?.body))).toEqual({ pending_token: 'ptok-mail', code: '654321' });
    expect(await landed).toBe('/');
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

  /**
   * 源码级判据（#449 的验收要求，feat-261110-01 **按新结构改写**）。
   *
   * 为什么必须改写（工单 §2.2 预见了这条）：原判据钉的是「TOTP 第二步整段（从注释行到 `</form>`、
   * 含缩进）逐字不动」。而本单把两行小字链接换成两档 switch 时，整块第二步必须挂进
   * `<template v-else>`——Vue 要求 `v-else` 与 `v-if` 紧邻，switch 又必须排在表单**上方**，
   * 插不进旧的三段 `v-if / v-else-if / v-else` 链中间 ⇒ 整块缩进 +2 ⇒ 旧判据必然红。
   *
   * 保留的意图原封不动，而且比原文更强：
   *   ① TOTP 表单**内部**的每一行仍逐字比对（内容、顺序、增删行都会红）；唯一放宽的是**缩进**
   *      ——那正是本次结构性改动本身，不是意图；
   *   ② 负向：TOTP 块里出现任何 `email` 字样 ⇒ 红（原意：TOTP 表单里不许混进邮箱码的东西）；
   *   ③ switch 必须在 TOTP 表单**外面**且在其**上方**（放进表单里会同时伤 ① 与 ②）。
   */
  it('源码级：TOTP 第二步表单内容逐行仍在（改一个字就红），且里面没混进邮箱码的东西', () => {
    const OPEN = '<form v-else @submit.prevent="onTotpSubmit">';
    const start = loginViewSource.indexOf(OPEN);
    expect(start, 'TOTP 第二步仍以 `<form v-else @submit.prevent="onTotpSubmit">` 开头').toBeGreaterThan(-1);
    const end = loginViewSource.indexOf('</form>', start);
    const totpForm = loginViewSource.slice(start, end);

    // ① 逐行比对表单内部（去掉行首缩进之后逐字相等，顺序也相等）。
    const EXPECTED_INNER = [
      '<p class="text-black/50 text-sm mb-3">{{ t(\'login.totpHint\') }}</p>',
      '<label class="block text-xs text-black/50 mb-1" for="totpCode">{{ t(\'login.totpLabel\') }}</label>',
      '<input',
      'id="totpCode" ref="totpInput" v-model="code"',
      'inputmode="numeric" maxlength="6" autocomplete="one-time-code"',
      'class="w-full rounded-md border border-black/20 px-3 py-1.5 mb-3 focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"',
      '>',
      '<button',
      'type="submit" :disabled="auth.loading"',
      'class="w-full rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white py-1.5 disabled:opacity-75"',
      '>{{ t(\'login.totpSubmit\') }}</button>',
      '<button',
      'type="button"',
      'class="w-full rounded-md border border-black/20 text-black/80 py-1.5 mt-2 hover:bg-black/5"',
      '@click="auth.backToLogin()"',
      '>{{ t(\'login.backToLogin\') }}</button>',
    ];
    const actualInner = totpForm
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(actualInner, 'TOTP 第二步表单的内部行变了').toEqual(EXPECTED_INNER);

    // ② 负向：TOTP 表单里不许出现邮箱码的东西（这条判据的本意）。
    expect(totpForm.toLowerCase(), 'TOTP 表单里混进了邮箱码的东西').not.toContain('email');
    expect(totpForm).not.toContain('factor-switch');

    // ③ switch 在表单外、且在表单上方（第二步的入口必须先于表单被看到）。
    const switchAt = loginViewSource.indexOf('data-test="factor-switch"');
    expect(switchAt, '两档 switch 必须在模板里').toBeGreaterThan(-1);
    expect(switchAt, 'switch 必须排在 TOTP 表单上方').toBeLessThan(start);
    expect(loginViewSource.indexOf('data-test="factor-option-email"')).toBeLessThan(start);
  });

  it('旧的两行小字链接确实被删了（`#useEmailCode` / `#emailUseTotp` 与它们的 i18n 键）', () => {
    expect(loginViewSource).not.toContain('id="useEmailCode"');
    expect(loginViewSource).not.toContain('id="emailUseTotp"');
    expect(loginViewSource).not.toContain('login.useEmailCode');
    expect(loginViewSource).not.toContain('login.useTotp');
    // 由 switch 取代（两个选择器 + 两个档）。
    expect(loginViewSource).toContain('data-test="factor-option-totp"');
    expect(loginViewSource).toContain('data-test="factor-option-email"');
  });
});

// ---------------------------------------------------------------------------
// 2026-11-06：**入口提示**。管理台是独立 host，登录 cookie host-only ⇒ 「在用户面登录管理员」会被送到
// 管理台登录页并要求再登录一次。不解释一句，用户看到的就是「我明明刚登录过」。
// ---------------------------------------------------------------------------
describe('LoginView 入口提示（管理台 vs 工作台）', () => {
  const SITE = { userBaseUrl: 'http://station.fde.erix.vip:8090', adminBaseUrl: 'https://admin.fde.erix.vip:9443' };

  function stubSite() {
    vi.stubGlobal('fetch', fetchMock((url) => (
      url.includes('/api/site') ? jsonResponse(200, SITE) : jsonResponse(404, {})
    )));
  }

  async function withHostname<T>(hostname: string, fn: () => Promise<T>): Promise<T> {
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, hostname },
    });
    try {
      return await fn();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  }

  it('管理台 host ⇒ 显示入口提示 + 工作台链接（href 就是 /api/site 的 userBaseUrl）', async () => {
    stubSite();
    const wrapper = await withHostname('admin.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    const notice = wrapper.find('[data-test="login-entry-notice"]');
    expect(notice.exists()).toBe(true);
    expect(notice.text()).toContain('管理台入口');
    expect(notice.text()).toContain('互不相通');
    expect(notice.find('a').attributes('href')).toBe(SITE.userBaseUrl);
  });

  it('用户面 host ⇒ **不显示**入口提示（工作台登录页不该有这段话）', async () => {
    stubSite();
    const wrapper = await withHostname('station.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    expect(wrapper.find('[data-test="login-entry-notice"]').exists()).toBe(false);
  });

  it('/api/site 拿不到 ⇒ 不显示提示（fail-open，与 host 闸同口径）', async () => {
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(500, {})));
    const wrapper = await withHostname('admin.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    expect(wrapper.find('[data-test="login-entry-notice"]').exists()).toBe(false);
  });
});

// 2026-11-06（真机环）：管理台 host 上用 **FDE 账号** 登录 ⇒ 会话 cookie 种在管理台 host（host-only），
// 而 FDE 落地页 `/` 在用户面 ⇒ 跳过去 401 ⇒ 回登录页 ⇒ 来回重定向。修法：登录页直接拦住 + 说清楚。
describe('LoginView 管理台入口拒绝非管理员（真机环回归）', () => {
  const SITE = { userBaseUrl: 'http://station.fde.erix.vip:8090', adminBaseUrl: 'https://admin.fde.erix.vip:9443' };

  async function withHostname<T>(hostname: string, fn: () => Promise<T>): Promise<T> {
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, hostname } });
    try { return await fn(); } finally { Object.defineProperty(window, 'location', { configurable: true, value: original }); }
  }

  it('管理台 host + FDE 账号登录成功 ⇒ 提示 + **不跳转**（会话被清掉，不再进入重定向环）', async () => {
    vi.stubGlobal('fetch', fetchMock((url) => {
      if (url.includes('/api/site')) return jsonResponse(200, SITE);
      if (url.includes('/api/auth/login')) return jsonResponse(200, { status: 'authenticated', user: FDE_USER });
      if (url.includes('/api/auth/logout')) return jsonResponse(204, {});
      return jsonResponse(404, {});
    }));
    const wrapper = await withHostname('admin.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('pw');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[data-test="login-entry-role-error"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="login-entry-role-error"]').text()).toContain('不是管理员');
    // 仍停在登录页（没有跳去 /）
    expect(wrapper.find('#loginName').exists()).toBe(true);
  });

  it('管理台 host + **管理员**登录 ⇒ 正常跳转（不误伤）', async () => {
    vi.stubGlobal('fetch', fetchMock((url) => {
      if (url.includes('/api/site')) return jsonResponse(200, SITE);
      if (url.includes('/api/auth/login')) return jsonResponse(200, { status: 'authenticated', user: ADMIN_USER });
      return jsonResponse(404, {});
    }));
    const wrapper = await withHostname('admin.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    await wrapper.find('#loginName').setValue('root');
    await wrapper.find('#loginPass').setValue('pw');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[data-test="login-entry-role-error"]').exists()).toBe(false);
  });

  it('用户面 host + FDE 账号 ⇒ 不拦（这条只针对管理台入口）', async () => {
    vi.stubGlobal('fetch', fetchMock((url) => {
      if (url.includes('/api/site')) return jsonResponse(200, SITE);
      if (url.includes('/api/auth/login')) return jsonResponse(200, { status: 'authenticated', user: FDE_USER });
      return jsonResponse(404, {});
    }));
    const wrapper = await withHostname('station.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      return wrapper;
    });
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('pw');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(wrapper.find('[data-test="login-entry-role-error"]').exists()).toBe(false);
  });
});

// 2026-11-06（真机蹦极，用户报「8443 登录进去在 admin console 来回跳」）：
// **无工位管理员**（role=admin + fde_name 空）在用户面登录 ⇒ 他在这里没有任何可用功能（#332 会把
// 每条工作台路径改写到管理台），而两个 host 的会话互不相通 ⇒ 让他登录成功再跳过去 = 登录两次 +
// 两个入口之间来回。修法：直接说清「去管理台登录」并撤掉这个用不上的会话。
describe('LoginView 用户面拒绝无工位管理员（真机蹦极回归）', () => {
  const SITE = { userBaseUrl: 'http://station.fde.erix.vip:8090', adminBaseUrl: 'https://admin.fde.erix.vip:9443' };
  const SEATLESS_ADMIN = { ...ADMIN_USER, fde_name: null };
  const ADMIN_WITH_SEAT = { ...ADMIN_USER, fde_name: 'ops' };

  async function withHostname<T>(hostname: string, fn: () => Promise<T>): Promise<T> {
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, hostname } });
    try { return await fn(); } finally { Object.defineProperty(window, 'location', { configurable: true, value: original }); }
  }

  async function loginAs(user: AuthUser) {
    vi.stubGlobal('fetch', fetchMock((url) => {
      if (url.includes('/api/site')) return jsonResponse(200, SITE);
      if (url.includes('/api/auth/login')) return jsonResponse(200, { status: 'authenticated', user });
      if (url.includes('/api/auth/logout')) return jsonResponse(204, {});
      return jsonResponse(404, {});
    }));
    return withHostname('station.fde.erix.vip', async () => {
      const { wrapper } = await mountLogin();
      await flushPromises();
      await wrapper.find('#loginName').setValue(user.login);
      await wrapper.find('#loginPass').setValue('pw');
      await wrapper.find('form').trigger('submit.prevent');
      await flushPromises();
      return wrapper;
    });
  }

  it('用户面 + 无工位管理员 ⇒ 提示 + 指向管理台的链接 + **不跳转**', async () => {
    const wrapper = await loginAs(SEATLESS_ADMIN);
    const err = wrapper.find('[data-test="login-entry-role-error"]');
    expect(err.exists()).toBe(true);
    expect(err.text()).toContain('没有工位');
    expect(err.find('a').attributes('href')).toBe(SITE.adminBaseUrl);
    expect(wrapper.find('#loginName').exists()).toBe(true); // 仍停在登录页
  });

  it('用户面 + **有工位**的管理员 ⇒ 不拦（他确实能用工位）', async () => {
    const wrapper = await loginAs(ADMIN_WITH_SEAT);
    expect(wrapper.find('[data-test="login-entry-role-error"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #449 二选一（`second_factor_choice`）+ 工单 feat-261110-01（两档 switch + 懒发信）
// 切换入口已从「TOTP 表单下面两行下划线小字」换成**真正的 switch**；邮箱码改成**懒发信**：
// 切到邮箱档那一刻才发第一封（走既有 §2.3b resend 端点，所以「发没发」在测试里就等价于
// 「打了几次 resend」）。
// 判据（工单 §3）：两条通道才渲染 switch / 默认选中 TOTP / 切到邮箱档**只发一次** resend /
// 切回 TOTP 零请求、再切回也不再发 / 单通道不渲染 / resend 失败不静默 / 503 `email_send_failed`
// 既有路径不回归 / 切换不重新登录（无新增 `POST /api/auth/login`，`pending_token` 不变）。
// ---------------------------------------------------------------------------

const SECOND_FACTOR_CHOICE = {
  status: 'second_factor_choice',
  pending_token: 'ptok-choice',
  expires_in: 600,
  methods: ['totp', 'email_code'],
  email_hint: 'e***@i***.com',
  // 懒发信的真实形状（工单 §1.3）：**不带 `email_sent`**，只有 `email_deferred: true`。
  // 「还没发」与「不可用」必须分得开 —— 前者的判据是 `email_sent === false`，混用就会把邮箱档
  // 在第一步剥掉（正是本单要修的「二选一在界面上不存在」）。
  email_deferred: true,
};

/** resend 的响应体（§2.3b）：新码有效期 + 下一次允许重发的冷却秒数。 */
const RESEND_OK = { expires_in: 600, resend_after: 60 };

/** 二选一的 fetch 桩：第一步回 `choice`；两条第二步端点回「登录成功」；resend 回 §2.3b 形状。 */
function choiceFetch(choice: Record<string, unknown> = SECOND_FACTOR_CHOICE) {
  return fetchMock((url) => {
    if (url.includes('/api/auth/login/email-code/resend')) return jsonResponse(200, RESEND_OK);
    if (url.includes('/api/auth/login/totp') || url.includes('/api/auth/login/email-code')) {
      return jsonResponse(200, { password_change_required: false, user: FDE_USER });
    }
    return jsonResponse(200, choice);
  });
}

/** 走完第一步，停在二选一的第二步（默认 TOTP）。 */
async function gotoChoiceStep(choice?: Record<string, unknown>) {
  const fetchFn = choiceFetch(choice);
  vi.stubGlobal('fetch', fetchFn);
  const ctx = await mountLogin();
  await ctx.wrapper.find('#loginName').setValue('alice');
  await ctx.wrapper.find('#loginPass').setValue('secret');
  await ctx.wrapper.find('form').trigger('submit.prevent');
  await flushPromises();
  return { ...ctx, fetchFn };
}

/** 打过几次 `POST /api/auth/login`（切换必须一次都不新增）。 */
function loginCalls(fetchFn: ReturnType<typeof choiceFetch>) {
  return fetchFn.mock.calls.filter(([url]) => String(url) === '/api/auth/login').length;
}

/** 打过几次 resend —— 懒发信唯一可观测的出口就是这一个端点。 */
function resendCalls(fetchFn: ReturnType<typeof choiceFetch>) {
  return fetchFn.mock.calls.filter(([url]) => String(url).includes('/api/auth/login/email-code/resend'));
}

const SWITCH = '[data-test="factor-switch"]';
const OPT_TOTP = '[data-test="factor-option-totp"]';
const OPT_EMAIL = '[data-test="factor-option-email"]';

describe('LoginView 二选一的 switch（feat-261110-01：两档 + 懒发信）', () => {
  it('两条通道 ⇒ 渲染 switch：radiogroup + 两个 radio、默认选中 TOTP（aria-checked 对得上）', async () => {
    const { wrapper, auth } = await gotoChoiceStep();

    const group = wrapper.find(SWITCH);
    expect(group.exists(), '两条通道必须给一个真的 switch（小字链接已被用户无视过）').toBe(true);
    expect(group.attributes('role')).toBe('radiogroup');
    expect(group.attributes('aria-label'), 'radiogroup 要有可读名字').toBe(zhCN.login.factorSwitchLabel);

    const totp = group.find(OPT_TOTP);
    const email = group.find(OPT_EMAIL);
    expect(totp.attributes('role')).toBe('radio');
    expect(email.attributes('role')).toBe('radio');
    expect(totp.attributes('aria-checked'), '默认停在较强的 TOTP').toBe('true');
    expect(email.attributes('aria-checked')).toBe('false');
    expect(totp.text()).toBe(zhCN.login.factorTotp);
    expect(email.text()).toBe(zhCN.login.factorEmail);
    // 切档之后 aria-checked 必须**跟着换**：只在默认档上断过一次的话，把它写死成 `aria-checked="true"`
    // 也能过（变异实验实证）。屏幕阅读器就靠这一对值念出「当前选中的是哪一档」。
    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();
    expect(wrapper.find(OPT_TOTP).attributes('aria-checked'), '选中的那档才是 true').toBe('false');
    expect(wrapper.find(OPT_EMAIL).attributes('aria-checked')).toBe('true');
    await wrapper.find(OPT_TOTP).trigger('click');
    await flushPromises();
    expect(wrapper.find(OPT_TOTP).attributes('aria-checked')).toBe('true');
    expect(wrapper.find(OPT_EMAIL).attributes('aria-checked')).toBe('false');

    // switch 是 `<button type="button">` ⇒ Tab 聚焦 + Enter/Space 原生可用（不必自己实现 tabindex 轮换）。
    expect(totp.attributes('type')).toBe('button');
    expect(email.attributes('type')).toBe('button');

    // 表单随档位变：默认只有 TOTP 表单。
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(wrapper.find('#emailCode').exists()).toBe(false);
    expect(auth.factor).toBe('totp');
    // switch 在表单**上方**（用户第一眼就看到有两档）。
    const html = wrapper.html();
    expect(html.indexOf('factor-switch')).toBeLessThan(html.indexOf('id="totpCode"'));
  });

  it('切到邮箱档 ⇒ 表单换掉、pending_token 不变、**只发一次 resend**（懒发信的第一封）', async () => {
    const { wrapper, router, auth, fetchFn } = await gotoChoiceStep();
    expect(loginCalls(fetchFn)).toBe(1);
    expect(resendCalls(fetchFn), '第一步不该有任何发信请求').toHaveLength(0);

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();

    expect(wrapper.find('#emailCode').exists(), '切换只换表单').toBe(true);
    expect(wrapper.find('#totpCode').exists()).toBe(false);
    expect(auth.factor).toBe('email');
    expect(auth.pendingToken, '同一枚 pending_token').toBe('ptok-choice');
    expect(loginCalls(fetchFn), '切换不得重新登录').toBe(1);
    const calls = resendCalls(fetchFn);
    expect(calls, '切过去恰好发一封，不多不少').toHaveLength(1);
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({ pending_token: 'ptok-choice' });
    // 发完之后：hint 说清发到哪了，并进入既有 60s 冷却。
    expect(wrapper.find('[data-test="emailSentHint"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('e***@i***.com');
    expect(wrapper.find('#emailResend').text()).toBe('60 秒后可重发');

    // 提交用的还是同一枚 pending（切档没换令牌）。
    await wrapper.find('#emailCode').setValue('654321');
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    const call = fetchFn.mock.calls.find(
      ([url]) => String(url).includes('/api/auth/login/email-code') && !String(url).endsWith('/resend'),
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ pending_token: 'ptok-choice', code: '654321' });
    expect(await landed).toBe('/');
    expect(auth.user?.login).toBe('alice');
  });

  it('切回 TOTP 零请求；再切回邮箱档**不再发**（emailSent 已 true）', async () => {
    const { wrapper, auth, fetchFn } = await gotoChoiceStep();

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();
    expect(resendCalls(fetchFn)).toHaveLength(1);

    await wrapper.find(OPT_TOTP).trigger('click');
    await flushPromises();
    expect(wrapper.find('#totpCode').exists(), '切换必须可逆').toBe(true);
    expect(wrapper.find('#emailCode').exists()).toBe(false);
    expect(resendCalls(fetchFn), '切回 TOTP 绝不发信').toHaveLength(1);

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();
    expect(resendCalls(fetchFn), '已经有码 ⇒ 反复切档不反复寄信（本单原缺陷就是寄太多）').toHaveLength(1);
    expect(auth.factor).toBe('email');
    expect(loginCalls(fetchFn)).toBe(1);
  });

  it('发送中：显示「正在发送验证码…」并禁用输入框与 switch（不让人对着空信箱打字）', async () => {
    let release: (() => void) | null = null;
    const fetchFn = fetchMock((url) => {
      if (url.includes('/api/auth/login/email-code/resend')) {
        return new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse(200, RESEND_OK));
        });
      }
      return jsonResponse(200, SECOND_FACTOR_CHOICE);
    });
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    await wrapper.find(OPT_EMAIL).trigger('click');
    await nextTick(); // resend 已在飞，但还没 release ⇒ 停在「发送中」

    expect(auth.emailSending).toBe(true);
    expect(wrapper.find('[data-test="emailSendingHint"]').text()).toContain('正在发送验证码');
    expect(wrapper.find('[data-test="emailSentHint"]').exists(), '还没发成就别写「已发送」').toBe(false);
    expect(wrapper.find('#emailCode').attributes('disabled'), '发送中输入框禁用').toBeDefined();
    expect(wrapper.find(OPT_TOTP).attributes('disabled'), '发送中 switch 禁用').toBeDefined();

    release!();
    await flushPromises();
    expect(auth.emailSending).toBe(false);
    expect(wrapper.find('#emailCode').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('[data-test="emailSentHint"]').exists()).toBe(true);
  });

  it('resend 失败 ⇒ **留在邮箱档** + 显示错误文案（不静默、不偷偷切回 TOTP）', async () => {
    const fetchFn = fetchMock((url) => {
      if (url.includes('/api/auth/login/email-code/resend')) {
        return jsonResponse(503, {
          error: { code: 'email_send_failed', message: '验证码邮件发送失败，请稍后重试', retryable: true },
        }, { 'Retry-After': '5' });
      }
      return jsonResponse(200, SECOND_FACTOR_CHOICE);
    });
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();

    expect(auth.factor, '发信失败不得把人踢回 TOTP（那是替他做决定）').toBe('email');
    expect(wrapper.find('#emailCode').exists()).toBe(true);
    expect(wrapper.find('[role="alert"]').text(), '错误必须说出来，不许静默')
      .toContain(zhCN.errors.emailSendFailed);
    expect(wrapper.find('#emailResend').text()).toBe('重新发送'); // 不受冷却限制，可立刻再试
  });

  it('可切回 TOTP 提交：TOTP 用的还是同一枚 pending_token', async () => {
    const { wrapper, router, auth, fetchFn } = await gotoChoiceStep();

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();
    await wrapper.find(OPT_TOTP).trigger('click');
    await flushPromises();
    expect(loginCalls(fetchFn)).toBe(1);
    expect(auth.pendingToken).toBe('ptok-choice');

    await wrapper.find('#totpCode').setValue('123456');
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    const call = fetchFn.mock.calls.find(([url]) => String(url).includes('/api/auth/login/totp'));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ pending_token: 'ptok-choice', code: '123456' });
    expect(await landed).toBe('/');
    expect(auth.user?.login).toBe('alice');
  });

  it('email_sent:false（降级）⇒ **不渲染 switch**，只给「邮件通道当前不可用」说明，TOTP 仍能登录', async () => {
    const { wrapper, router, auth, fetchFn } = await gotoChoiceStep({
      status: 'second_factor_choice',
      pending_token: 'ptok-choice',
      expires_in: 600,
      methods: ['totp'],
      email_hint: 'e***@i***.com',
      email_sent: false,
      email_unavailable: true,
      notice: '邮件通道当前不可用，本次仅可用验证器应用（TOTP）',
    });

    expect(wrapper.find(SWITCH).exists(), '只有一条通道就别摆个只有一档的 switch').toBe(false);
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(wrapper.find('#emailUnavailableNotice').text()).toContain('邮件通道当前不可用，请使用验证器应用');

    await wrapper.find('#totpCode').setValue('123456');
    const landed = nextRouteLanding(router);
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();
    expect(await landed).toBe('/');
    expect(auth.user?.login).toBe('alice');
    expect(loginCalls(fetchFn)).toBe(1);
    expect(resendCalls(fetchFn), '降级路径也不许偷发一封信').toHaveLength(0);
  });

  it('后端同时给 methods 两条 + email_sent:false ⇒ 仍不渲染 switch（不信 methods 单独说话）', async () => {
    const { wrapper } = await gotoChoiceStep({
      status: 'second_factor_choice',
      pending_token: 'ptok-choice',
      expires_in: 600,
      methods: ['totp', 'email_code'],
      email_hint: 'e***@i***.com',
      email_sent: false,
      email_unavailable: true,
    });
    expect(wrapper.find('#totpCode').exists()).toBe(true);
    expect(wrapper.find(SWITCH).exists(), '码没发出去就不许给邮箱档').toBe(false);
    expect(wrapper.find('#emailUnavailableNotice').exists()).toBe(true);
  });

  it('回归：单一通道（totp_required / email_code_required）都不渲染 switch，也无旧的小字链接', async () => {
    const totpOnly = await gotoChoiceStep({ status: 'totp_required', pending_token: 'ptok', expires_in: 120 });
    expect(totpOnly.wrapper.find('#totpCode').exists()).toBe(true);
    expect(totpOnly.wrapper.find(SWITCH).exists()).toBe(false);
    expect(totpOnly.wrapper.find('#emailUnavailableNotice').exists()).toBe(false);
    expect(totpOnly.auth.choiceMethods).toEqual([]);

    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(200, EMAIL_CODE_REQUIRED)));
    const { wrapper: mailWrapper } = await mountLogin();
    await gotoEmailStep(mailWrapper);
    expect(mailWrapper.find('#emailCode').exists()).toBe(true);
    expect(mailWrapper.find(SWITCH).exists(), '无 TOTP 的账号只有一条路 ⇒ 不该有 switch').toBe(false);
    expect(mailWrapper.find('#emailBack').exists()).toBe(true);
    // 旧的两行小字链接确实没了（它们由 switch 取代）。
    expect(mailWrapper.find('#emailUseTotp').exists()).toBe(false);
    expect(mailWrapper.find('#useEmailCode').exists()).toBe(false);
  });

  it('懒发信不回归 503 `email_send_failed`（第一步带 pending 的 patch 路径）', async () => {
    // `email_code_required` 那条仍是「第一步就发信」，发不出去 ⇒ 503 + details 带 pending（#449 既有语义）。
    vi.stubGlobal('fetch', fetchMock(() => jsonResponse(503, {
      error: {
        code: 'email_send_failed', message: '验证码邮件发送失败，请稍后重试', retryable: true,
        details: { pending_token: 'ptok-mail', expires_in: 600, email_hint: 'a***@e***.com' },
      },
    }, { 'Retry-After': '5' })));
    const { wrapper, auth } = await mountLogin();
    await gotoEmailStep(wrapper);
    expect(wrapper.find('#emailCode').exists()).toBe(true); // 没被踢回第一步
    expect(auth.emailSent, '这条路径算「已发过」⇒ 不再由 switch 偷发一封').toBe(true);
    expect(wrapper.find('#emailResend').text()).toBe('重新发送');
    expect(wrapper.find(SWITCH).exists()).toBe(false);
  });

  it('切到邮箱档后仍可重发：懒发信吃 60s 冷却，冷却过后手动重发不换 pending_token', async () => {
    vi.useFakeTimers();
    const fetchFn = choiceFetch();
    vi.stubGlobal('fetch', fetchFn);
    const { wrapper, auth } = await mountLogin();
    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('secret');
    await wrapper.find('form').trigger('submit.prevent');
    await flushPromises();

    await wrapper.find(OPT_EMAIL).trigger('click');
    await flushPromises();
    expect(resendCalls(fetchFn)).toHaveLength(1);
    expect(wrapper.find('#emailResend').text()).toBe('60 秒后可重发'); // 第一封也起算冷却（§2.3b）

    vi.advanceTimersByTime(60_000);
    await nextTick();
    expect(wrapper.find('#emailResend').text()).toBe('重发验证码');
    await wrapper.find('#emailResend').trigger('click');
    await flushPromises();
    expect(resendCalls(fetchFn), '手动重发走同一个端点').toHaveLength(2);
    expect(auth.pendingToken).toBe('ptok-choice');
    expect(loginCalls(fetchFn)).toBe(1);
    vi.useRealTimers();
    wrapper.unmount();
  });
});

describe('LoginView switch 的双语文案（feat-261110-01）', () => {
  it('en：switch 的两档、发送中、已发到 都有英文文案（不是中文交差）', async () => {
    setLocale('en');
    try {
      const { wrapper } = await gotoChoiceStep();
      const group = wrapper.find(SWITCH);
      expect(group.attributes('aria-label')).toBe(en.login.factorSwitchLabel);
      expect(group.find(OPT_TOTP).text()).toBe(en.login.factorTotp);
      expect(group.find(OPT_EMAIL).text()).toBe(en.login.factorEmail);
      expect(group.find(OPT_TOTP).attributes('aria-checked')).toBe('true');

      const degraded = await gotoChoiceStep({
        status: 'second_factor_choice',
        pending_token: 'ptok-choice',
        expires_in: 600,
        methods: ['totp'],
        email_hint: 'e***@i***.com',
        email_sent: false,
        email_unavailable: true,
      });
      expect(degraded.wrapper.find(SWITCH).exists()).toBe(false);
      expect(degraded.wrapper.find('#emailUnavailableNotice').text()).toContain('Email is unavailable right now');
    } finally {
      setLocale('zh-CN');
    }
  });
});