// #255 首登强制改密（前端 ①）单测：受限会话旗标的三个入口、强制改密屏的「关不掉」、改密成功链路。
// 约定（照 LoginView.spec / WorkbenchView.spec 先例）：装配真实 i18n 单例，不 mock t()；
// 每例 localStorage.clear() + setLocale('zh-CN')；导航落地用 vi.waitFor 轮询，不数 tick。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import type { AuthUser } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import { en } from '../i18n/locales/en';
import { zhCN } from '../i18n/locales/zh-CN';

const CJK = /[\u4e00-\u9fff]/;

/** 被管理员代设过口令的账号（§2.2 登录响应 password_change_required=true 的那一位）。 */
const RESTRICTED_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
  auth_source: 'local', must_change_password: true,
} as AuthUser;
/** 正常账号（旗标 false ⇒ 一切照旧的对照组）。 */
const NORMAL_USER = {
  id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: 'bob',
  auth_source: 'local', must_change_password: false,
} as AuthUser;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 真实推进 macrotask（jsdom Response.json）后再冲刷微任务。 */
const tick = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

interface StubOptions {
  /** 登录响应里的 password_change_required（undefined ⇒ 完全不带你字段，模拟旧后端）。 */
  loginFlag?: boolean;
  /** GET /api/me 回答的 must_change_password（undefined ⇒ 走 401 未登录）。 */
  meFlag?: boolean;
  /** /api/me/password 的响应（默认 200 ok）。 */
  changeResponse?: { status: number; body: unknown };
  /** POST 改密成功后，后续的 GET /api/me 是否改口回答 false（默认 true；false = 服务端没清旗标）。 */
  clearFlagOnChange?: boolean;
}

/** 按 URL 分派的 fetch 桩 + 调用序列记录（顺序本身就是判据：改密后必须先 GET /api/me 再放行）。 */
function stubFetch(opts: StubOptions) {
  // 可变的 meFlag：POST /api/me/password 成功 ⇒ 服务端清了旗标 ⇒ 后续 /api/me 回答 false。
  let meFlag = opts.meFlag;
  const calls: Array<{ url: string; method: string; body: string | undefined; contentType: string | null }> = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : String(init.body),
      contentType: headers['Content-Type'] ?? null,
    });
    if (url.startsWith('/api/me/password')) {
      const r = opts.changeResponse ?? { status: 200, body: { ok: true, password_change_required: false, sessions_revoked: 1 } };
      if (r.status === 200 && opts.clearFlagOnChange !== false) meFlag = false;
      return jsonResponse(r.status, r.body);
    }
    if (url.startsWith('/api/me')) {
      if (meFlag === undefined) {
        return jsonResponse(401, { error: { code: 'unauthorized', message: 'unauthorized' } });
      }
      // 身份恒定是 alice（受限与否只改旗标）：否则断言「会话保留」会被桩换人，假红。
      return jsonResponse(200, { user: { ...RESTRICTED_USER, must_change_password: meFlag } });
    }
    if (url.startsWith('/api/auth/login/totp')) {
      const body: Record<string, unknown> = {
        user: { ...(opts.loginFlag === true ? RESTRICTED_USER : NORMAL_USER) },
      };
      if (opts.loginFlag !== undefined) body.password_change_required = opts.loginFlag;
      return jsonResponse(200, body);
    }
    if (url.startsWith('/api/auth/login')) {
      const body: Record<string, unknown> = {
        status: 'authenticated',
        user: { ...(opts.loginFlag === true ? RESTRICTED_USER : NORMAL_USER) },
      };
      // 后端口径：只有**发会话**的分支带这个键（undefined ⇒ 不带，模拟升级前的旧后端）。
      if (opts.loginFlag !== undefined) body.password_change_required = opts.loginFlag;
      return jsonResponse(200, body);
    }
    if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs: [] });
    if (url.startsWith('/api/sessions')) return jsonResponse(200, { items: [] });
    return jsonResponse(200, {});
  });
  vi.stubGlobal('fetch', fetchFn);
  return calls;
}

/** 挂载整个 App 外壳（只有挂 App 才能验「工作台整棵子树没挂载」）。 */
async function mountApp(initialPath: string) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  router.push(initialPath);
  await router.isReady();
  const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
  return { wrapper, router, auth: useAuthStore() };
}

// 工作台独有的标记（issue #246 的预览端口折叠条）：它在 ⇒ 工作台真的挂载了。
const WORKBENCH_MARKER = '[data-test="preview-ports-toggle"]';
const FORCE_SCREEN = '[data-test="force-password"]';

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('#255 登录响应旗标（auth store，三个服务端入口）', () => {
  it('登录响应 password_change_required=true ⇒ 旗标为真（变异靶子：删掉这条分支必须红）', async () => {
    setActivePinia(createPinia());
    stubFetch({ loginFlag: true });
    const auth = useAuthStore();
    await auth.login('alice', 'pw');
    expect(auth.user?.login).toBe('alice');
    expect(auth.passwordChangeRequired).toBe(true);
  });

  it('登录响应 password_change_required=false ⇒ 旗标为假（绝不能把正常人挡在门外）', async () => {
    setActivePinia(createPinia());
    stubFetch({ loginFlag: false });
    const auth = useAuthStore();
    await auth.login('bob', 'pw');
    expect(auth.passwordChangeRequired).toBe(false);
  });

  it('登录响应压根不带该键（旧后端）⇒ 旗标为假，纯 additive 不改变既有行为', async () => {
    setActivePinia(createPinia());
    stubFetch({});
    const auth = useAuthStore();
    await auth.login('bob', 'pw');
    expect(auth.passwordChangeRequired).toBe(false);
  });

  it('TOTP 第二步（§2.3 发会话的分支）带 true ⇒ 旗标为真', async () => {
    setActivePinia(createPinia());
    stubFetch({ loginFlag: true });
    const auth = useAuthStore();
    await auth.submitTotp('123456');
    expect(auth.passwordChangeRequired).toBe(true);
  });

  it('GET /api/me 的 must_change_password ⇒ 刷新后重建改密屏（§2.11a 唯一数据源）', async () => {
    setActivePinia(createPinia());
    stubFetch({ meFlag: true });
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(auth.passwordChangeRequired).toBe(true);
  });

  it('未登录（/api/me 401）⇒ 旗标为假，不阻塞守卫跳 /login', async () => {
    setActivePinia(createPinia());
    stubFetch({});
    const auth = useAuthStore();
    await auth.ensureMe();
    expect(auth.user).toBeNull();
    expect(auth.passwordChangeRequired).toBe(false);
  });

  it('登出后清旗标（否则 App 的闸门会把登录页也挡死）', async () => {
    setActivePinia(createPinia());
    stubFetch({ loginFlag: true });
    const auth = useAuthStore();
    await auth.login('alice', 'pw');
    expect(auth.passwordChangeRequired).toBe(true);
    await auth.logout();
    expect(auth.passwordChangeRequired).toBe(false);
  });
});

describe('#255 强制改密屏 · 闸门（挂 App 验「工作台没挂载」）', () => {
  it('登录返回 password_change_required=true ⇒ 渲染改密屏，且工作台/导航不渲染', async () => {
    stubFetch({ loginFlag: true });
    const { wrapper, router } = await mountApp('/login');
    expect(wrapper.find('#loginName').exists()).toBe(true);

    await wrapper.find('#loginName').setValue('alice');
    await wrapper.find('#loginPass').setValue('pw');
    await wrapper.find('form').trigger('submit.prevent');
    await tick();

    // 改密屏出现 + 落地路由被守卫改写到 /change-password
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
    expect(wrapper.text()).toContain('请先修改初始口令');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/change-password'));
    // 工作台与会话视图**没挂载**：预览端口折叠条、顶栏、☰ 导航、登出按钮全都不存在
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
    expect(wrapper.find('header').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('☰ 导航');
    expect(wrapper.text()).not.toContain('登出');
  });

  it('登录返回 false ⇒ 一切照旧（正常进工作台，没有改密屏）', async () => {
    stubFetch({ loginFlag: false });
    const { wrapper, router } = await mountApp('/login');
    await wrapper.find('#loginName').setValue('bob');
    await wrapper.find('#loginPass').setValue('pw');
    await wrapper.find('form').trigger('submit.prevent');
    await tick();

    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(false);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    await vi.waitFor(() => expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(true));
  });

  it('刷新（深链 #/session/<id> + /api/me 回答 true）⇒ 直接落在改密屏，会话视图没挂载', async () => {
    stubFetch({ meFlag: true });
    const { wrapper, router } = await mountApp('/session/s1');
    await tick();
    expect(router.currentRoute.value.path).toBe('/change-password');
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
  });

  it('关不掉（不是 modal）：无对话框/遮罩/关闭按钮，且改完 URL 也进不去工作台', async () => {
    stubFetch({ meFlag: true });
    const { wrapper, router } = await mountApp('/change-password');
    await tick();
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
    // 不是可关闭的 modal：既没有 role=dialog，也没有 ModalShell 的遮罩
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="modal-backdrop"]').exists()).toBe(false);
    // 屏上唯一的按钮是「改口令」与「换个账号 / 退出登录」，没有任何「关闭 / 取消 / 稍后」
    const buttons = wrapper.findAll('button').map((b) => b.text());
    expect(buttons.some((t) => /关闭|取消|稍后|以后/.test(t))).toBe(false);

    // 手改 URL（等价于在地址栏敲 #/session/s1 或 #/admin）：守卫改写回改密屏
    await router.push('/session/s1');
    await router.push('/admin');
    await tick();
    expect(router.currentRoute.value.path).toBe('/change-password');
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
    expect(wrapper.find('aside').exists()).toBe(false);
  });

  it('已登录且受限的人访问 /login 也被改写到改密屏（登录页不是绕过口）', async () => {
    stubFetch({ meFlag: true });
    const { router } = await mountApp('/login');
    await tick();
    expect(router.currentRoute.value.path).toBe('/change-password');
  });
});

describe('#255 改密表单与成功链路', () => {
  /**
   * 挂**整个 App**（不挂改密屏本体）：否则「改密屏消失 / 工作台出现」这类断言只能验到我自己手动挂的
   * 组件，验不到 App 闸门。进路：/api/me 回答 true ⇒ 守卫把 /change-password 放行且闸门落下。
   */
  async function mountForce(opts: StubOptions) {
    const calls = stubFetch(opts);
    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createAppRouter(createMemoryHistory());
    router.push('/change-password');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
    await tick();
    const auth = useAuthStore();
    expect(wrapper.find(FORCE_SCREEN).exists(), '前置：已进入受限态改密屏').toBe(true);
    return { wrapper, router, auth, calls };
  }

  async function fillAndSubmit(wrapper: { find(s: string): any }) {
    await wrapper.find('#currentPassword').setValue('admin-set');
    await wrapper.find('#newPassword').setValue('mine-chosen');
    await wrapper.find('#confirmPassword').setValue('mine-chosen');
    await wrapper.find('form').trigger('submit.prevent');
    await tick();
  }

  it('成功链路：POST /api/me/password 三字段齐全 + Content-Type application/json ⇒ 先 GET /api/me 才进正常界面', async () => {
    const { wrapper, router, auth, calls } = await mountForce({ meFlag: true });
    await fillAndSubmit(wrapper);

    const post = calls.find((c) => c.url === '/api/me/password');
    expect(post, '必须打 POST /api/me/password').toBeDefined();
    expect(post?.method).toBe('POST');
    expect(post?.contentType).toBe('application/json');
    expect(JSON.parse(post!.body!)).toEqual({
      current_password: 'admin-set',
      new_password: 'mine-chosen',
      confirm_password: 'mine-chosen',
    });

    // ⚠ 顺序判据：POST 之后**确实**又打了一次 GET /api/me（拿真实旗标），不是本地改旗标放行。
    const postIndex = calls.findIndex((c) => c.url === '/api/me/password');
    const meIndex = calls.findIndex((c, i) => i > postIndex && c.url === '/api/me' && c.method === 'GET');
    expect(meIndex, 'POST 成功后必须重新 GET /api/me').toBeGreaterThan(postIndex);
    expect(auth.passwordChangeRequired).toBe(false);

    // 之后才进正常界面（工作台挂载、改密屏消失、落在工作台而不是登录页）
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(false);
    await vi.waitFor(() => expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(true));
    // §2.6a：当前会话保留 ⇒ 绝不能调登出把人踢回登录页
    expect(calls.some((c) => c.url.startsWith('/api/auth/logout'))).toBe(false);
    expect(auth.user?.login).toBe('alice');
  });

  it('改密后 /api/me 仍回答 true ⇒ 留在改密屏（禁止本地把旗标改 false 就放行）', async () => {
    // /api/me/password 返回 200，但 /api/me 依旧回答 must_change_password=true（服务端没清旗标）。
    const { wrapper, router, auth, calls } = await mountForce({ meFlag: true, clearFlagOnChange: false });
    await fillAndSubmit(wrapper);

    expect(auth.passwordChangeRequired).toBe(true);
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
    expect(wrapper.find(WORKBENCH_MARKER).exists()).toBe(false);
    expect(router.currentRoute.value.path).toBe('/change-password');
    expect(calls.some((c) => c.url.startsWith('/api/me/password'))).toBe(true);
  });

  it('失败态：服务端 error.code 与 error.message 原样渲染成字符串（不出现 [object Object]）', async () => {
    const { wrapper } = await mountForce({
      meFlag: true,
      changeResponse: {
        status: 400,
        body: { error: { code: 'validation_failed', message: '新口令不得与当前口令相同', details: { field: 'new_password' } } },
      },
    });
    await fillAndSubmit(wrapper);

    const alert = wrapper.find('[role="alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain('validation_failed');
    expect(alert.text()).toContain('新口令不得与当前口令相同');
    expect(alert.text()).not.toContain('[object Object]');
    // 失败绝不放行
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
  });

  it('服务端 message 是个对象（畸形信封）⇒ 退化成 JSON 文本，仍然没有 [object Object]', async () => {
    const { wrapper } = await mountForce({
      meFlag: true,
      changeResponse: { status: 400, body: { error: { code: 'validation_failed', message: { field: 'new_password' } } } },
    });
    await fillAndSubmit(wrapper);
    const text = wrapper.find('[role="alert"]').text();
    expect(text).not.toContain('[object Object]');
    expect(text).toContain('validation_failed');
    expect(text).toContain('new_password');
  });

  it('两次新口令不一致 ⇒ 本地拦住不发请求（服务端没有 confirm 字段，一致性只能前端判）', async () => {
    const { wrapper, calls } = await mountForce({ meFlag: true });
    await wrapper.find('#currentPassword').setValue('admin-set');
    await wrapper.find('#newPassword').setValue('one');
    await wrapper.find('#confirmPassword').setValue('two');
    await wrapper.find('form').trigger('submit.prevent');
    await tick();

    expect(wrapper.find('[role="alert"]').text()).toBe('两次输入的新口令不一致');
    expect(calls.some((c) => c.url.startsWith('/api/me/password'))).toBe(false);
  });

  it('登出出口可用（§2.11a 放行清单含 logout）：清会话后回到 /login', async () => {
    const { wrapper, router, auth } = await mountForce({ meFlag: true });
    await wrapper.findAll('button').find((b) => b.text().includes('换个账号'))!.trigger('click');
    await tick();
    expect(auth.user).toBeNull();
    expect(auth.passwordChangeRequired).toBe(false);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'));
  });
});

describe('#255 forcePassword.* 双语文案', () => {
  const paths = (v: unknown, prefix = ''): string[] =>
    v !== null && typeof v === 'object'
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, c]) => paths(c, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  // 叶子值按完整路径从根对象取（路径自带 'forcePassword.' 前缀，所以不切段）。
  const read = (root: object, path: string) =>
    path.split('.').reduce<unknown>((n, s) => (n as Record<string, unknown>)[s], root) as string;

  it('zh-CN 与 en 的 forcePassword 键集完全一致，且中英各写各的（不许拿中文交差）', () => {
    const zhKeys = paths(zhCN.forcePassword, 'forcePassword').sort();
    const enKeys = paths(en.forcePassword, 'forcePassword').sort();
    expect(zhKeys.length).toBeGreaterThan(10);
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      const zh = read(zhCN, key);
      const english = read(en, key);
      expect(typeof zh, key).toBe('string');
      expect(zh.length, key).toBeGreaterThan(0);
      expect(english.length, key).toBeGreaterThan(0);
      expect(zh, key).toMatch(CJK);
      expect(english, key).not.toMatch(CJK);
      expect(english, key).not.toBe(zh);
    }
  });

  it('文案不硬编码端口 / 域名 / 协议（部署形态可变）', () => {
    const banned = [/localhost/i, /127\.0\.0\.1/, /:\d{2,5}\b/, /https?:\/\//, /\.fde\./i, /example\.(com|test)/i];
    for (const [locale, root] of [['zh-CN', zhCN], ['en', en]] as const) {
      for (const key of paths((root as Record<string, unknown>).forcePassword, 'forcePassword')) {
        const value = read(root as object, key);
        for (const re of banned) {
          expect(`${locale} forcePassword.${key} = ${value}`, `${locale} ${key}`).not.toMatch(re);
        }
      }
    }
  });

  it('会话语义照 §2.6a：说「本次登录继续有效」，不说「需要重新登录」', () => {
    for (const text of [zhCN.forcePassword.sessionHint, en.forcePassword.sessionHint]) {
      expect(text).not.toMatch(/重新登录|重新登陆|sign in again|log in again|re-login/i);
    }
    expect(zhCN.forcePassword.sessionHint).toMatch('本次登录继续有效');
  });
});
