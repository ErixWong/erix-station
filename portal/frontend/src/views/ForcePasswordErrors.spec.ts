// #255 前端 ②：错误语义与兜底的**渲染侧**单测（挂整个 App，看人真正看到什么）。
// 分工：「码 → 键」的映射本体在 lib/forcePasswordErrors.spec.ts，这里只验进 DOM 后的形状。
// 装配风格照 ①（views/ForcePasswordChangeView.spec.ts）：真实 i18n 单例、不 mock t()、
// 每例 localStorage.clear() + setLocale('zh-CN')、导航落地用 vi.waitFor 轮询而不数 tick。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import App from '../App.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import type { AuthUser } from '../stores/auth';
import { setLocale } from '../i18n';
import { i18n } from '../i18n';
import { en } from '../i18n/locales/en';
import { zhCN } from '../i18n/locales/zh-CN';

const RESTRICTED_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice',
  auth_source: 'local', must_change_password: true,
} as AuthUser;

/** 从 fetch 的第一参数里取 URL 字符串（Request 与 URL 两种形状都要认，tsc 会按类型收窄）。 */
function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

const FORCE_SCREEN = '[data-test="force-password"]';
const ALERT = '[role="alert"]';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const tick = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

/**
 * 进改密屏的**唯一进路**：`GET /api/me` 回答 must_change_password=true（§2.11a：刷新后重建改密屏
 * 的唯一数据源）。`changeResponse` 决定改密那次 POST 的回包，`sideResponse` 决定其它 `/api/*`
 * 的回包（任务 2 的「任意请求撞上受限会话门」就从这里造）。
 */
interface Opts {
  changeResponse?: { status: number; body: unknown; headers?: Record<string, string> };
  /** 除 /api/me 与 /api/me/password 之外的请求（工作台会打的 /api/dirs、/api/sessions 等）的回包。 */
  sideResponse?: { status: number; body: unknown };
  /** 服务端是否照回答清旗标（默认 true）。 */
  clearFlagOnChange?: boolean;
}

async function enterForceScreen(opts: Opts) {
  let meFlag = true;
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push(`${(init?.method ?? 'GET')} ${url}`);
    if (url.startsWith('/api/me/password')) {
      const r = opts.changeResponse ?? { status: 200, body: { ok: true, password_change_required: false, sessions_revoked: 1 } };
      if (r.status === 200 && opts.clearFlagOnChange !== false) meFlag = false;
      return jsonResponse(r.status, r.body, r.headers ?? {});
    }
    if (url.startsWith('/api/me')) {
      return jsonResponse(200, { user: { ...RESTRICTED_USER, must_change_password: meFlag } });
    }
    if (opts.sideResponse) return jsonResponse(opts.sideResponse.status, opts.sideResponse.body);
    if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs: [] });
    if (url.startsWith('/api/sessions')) return jsonResponse(200, { items: [] });
    return jsonResponse(200, {});
  }));

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

/** 直接以「服务端回包」驱动一次失败提交（表单填对，让请求真的发出去）。 */
async function submitWrongButWellFormed(wrapper: { find(s: string): any }) {
  await wrapper.find('#currentPassword').setValue('whatever');
  await wrapper.find('#newPassword').setValue('mine-chosen');
  await wrapper.find('#confirmPassword').setValue('mine-chosen');
  await wrapper.find('form').trigger('submit.prevent');
  await tick();
}

/** 屏上那条 role=alert 的文本（渲染断言的唯一入口）。 */
function alertText(wrapper: { find(s: string): any }): string {
  const alert = wrapper.find(ALERT);
  expect(alert.exists(), '失败态必须有一条 role=alert').toBe(true);
  return alert.text();
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  vi.unstubAllGlobals();
});
afterEach(() => vi.unstubAllGlobals());

describe('#255 前端② 错误码 → 文案的渲染（每个码一条断言）', () => {
  it('invalid_credentials（401 旧口令不对）⇒ 说「重输当前口令」，且**留在改密屏**、没回登录页', async () => {
    const { wrapper, router } = await enterForceScreen({
      changeResponse: { status: 401, body: { error: { code: 'invalid_credentials', message: 'invalid credentials' } } },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('当前口令');
    expect(text).toContain('invalid_credentials'); // 原始码始终附在句尾（报障要用）
    expect(text).not.toMatch('重新登录');
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/change-password'));
  });

  it('validation_failed + details.field ⇒ 文案点名到具体输入框（new_password → 「新口令」）', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: {
        status: 400,
        body: { error: { code: 'validation_failed', message: '新口令不得与当前口令相同', details: { field: 'new_password' } } },
      },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('新口令');
    expect(text).toContain('新口令不得与当前口令相同');
    expect(text).toContain('validation_failed');
  });

  it('cross_origin_forbidden（#234）⇒ 给出「在浏览器地址栏直接打开本站再重试」这一步', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: {
        status: 403,
        body: { error: { code: 'cross_origin_forbidden', message: 'cross-site request', details: { origin: 'https://evil', sec_fetch_site: 'cross-site', method: 'POST' } } },
      },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('地址栏');
    expect(text).toContain('cross_origin_forbidden');
    expect(text).not.toContain('[object Object]');
  });

  it('rate_limited（429 + Retry-After 头）⇒ 把 Retry-After 的秒数演成人能读的等待时长', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: {
        status: 429,
        body: { error: { code: 'rate_limited', message: 'too many attempts' } },
        headers: { 'Retry-After': '37' },
      },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('37');
    expect(text).toContain('rate_limited');
    expect(text).not.toMatch('undefined');
  });

  it('429 但**没有** Retry-After 头 ⇒ 退到不带秒数的说法，不演 "undefined 秒"', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: { status: 429, body: { error: { code: 'rate_limited', message: 'too many attempts' } } },
    });
    await submitWrongButWellFormed(wrapper);
    const text = alertText(wrapper);
    expect(text).not.toMatch('undefined');
    expect(text).toContain('rate_limited');
  });

  it('kdf_busy（503 + Retry-After）⇒ 明说「不是你的口令有问题」并给出等待秒数', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: {
        status: 503,
        body: { error: { code: 'kdf_busy', message: 'kdf busy' } },
        headers: { 'Retry-After': '6' },
      },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('不是你的口令有问题');
    expect(text).toContain('6');
    expect(text).toContain('kdf_busy');
  });

  it('405（method_not_allowed）⇒ 给出「强制刷新后重试，仍失败拿错误码报障」', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: { status: 405, body: { error: { code: 'method_not_allowed', message: 'method not allowed' } } },
    });
    await submitWrongButWellFormed(wrapper);
    const text = alertText(wrapper);
    expect(text).toContain('强制刷新');
    expect(text).toContain('method_not_allowed');
  });

  it('未知 code ⇒ 兜底文案**原样附上 code**（不许静默成通用错误）', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: { status: 409, body: { error: { code: 'teapot_surprise', message: 'something new' } } },
    });
    await submitWrongButWellFormed(wrapper);

    const text = alertText(wrapper);
    expect(text).toContain('teapot_surprise');
    expect(text).toContain('409');
    expect(text).toContain('something new');
    // 没被某个已知码的说法冒充（例如被演成「旧口令不对」）。
    expect(text).not.toMatch('当前口令');
    // 也不许把 i18n 键名演出来。
    expect(text).not.toContain('forcePassword.errors');
  });

  it('401 unauthorized（会话过期）⇒ 回登录页，**不**停在改密屏反复撞 401', async () => {
    const { wrapper, router, auth } = await enterForceScreen({
      changeResponse: { status: 401, body: { error: { code: 'unauthorized', message: 'unauthorized' } } },
    });
    await submitWrongButWellFormed(wrapper);

    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'));
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(false);
    expect(auth.user).toBeNull();
    // 登录页必须能解释「为什么人被送回来」：只剩一个空表单会让人以为凭空掉线（#255 前端② 的可行动性要求）。
    await tick();
    expect(wrapper.find(ALERT).text()).toMatch('登录已过期');
    expect(wrapper.find(ALERT).text()).toMatch('重新登录');
    // 没有会话就谈不上受限：旗标必须清掉，否则 App 闸门会把登录页也挡死。
    expect(auth.passwordChangeRequired).toBe(false);
  });

  it('同一条错误切到 en 语言时说法跟着切（映射表双语都有，不是只写了中文）', async () => {
    const { wrapper } = await enterForceScreen({
      changeResponse: { status: 429, body: { error: { code: 'rate_limited', message: 'too many attempts' } }, headers: { 'Retry-After': '37' } },
    });
    await submitWrongButWellFormed(wrapper);
    expect(alertText(wrapper)).toContain('37');

    setLocale('en');
    await tick();
    const english = alertText(wrapper);
    expect(english).toMatch(/rate limit/i);
    expect(english).toContain('37');
    expect(english).not.toMatch(/[\u4e00-\u9fff]/);
    setLocale('zh-CN');
  });
});

describe('#255 前端② [object Object] 反证（五种畸形形态都要渲染成可读字符串）', () => {
  const cases: Array<[string, unknown, string]> = [
    // 1) details 深嵌套：field 本身是个对象/数组，而不是契约上的字符串。
    ['details 深嵌套', { error: { code: 'validation_failed', message: 'bad', details: { field: { deep: { nested: [{ x: 1 }] } } } } }, 'deep'],
    // 2) message 是数组。
    ['message 是数组', { error: { code: 'validation_failed', message: ['first', 'second'] } }, 'first'],
    // 3) code 不是字符串（对象）。
    ['code 不是字符串', { error: { code: { nested: 'obj' }, message: 'weird code' } }, 'nested'],
    // 4) null：整条 error 是 null（§1.2 只保证形状，前端不赌它）。
    ['error 是 null', { error: null }, ''],
    // 5) 字段全为 null（有信封但每个值都是 null）。
    ['字段全是 null', { error: { code: null, message: null, details: null } }, ''],
  ];

  for (const [name, body, needle] of cases) {
    it(`${name} ⇒ 渲染成可读字符串且不含 [object Object]`, async () => {
      const { wrapper } = await enterForceScreen({ changeResponse: { status: 400, body } });
      await submitWrongButWellFormed(wrapper);

      const text = alertText(wrapper);
      expect(text).not.toContain('[object Object]');
      expect(text.trim().length, name).toBeGreaterThan(0);
      // 必须还是「映射表 + 原始证据」那句话：认得出的码仍然给出可行动文案，认不出的走 unknown_code。
      expect(text).toMatch(/校验|未收录|服务端|错误码|当前口令|管理员/);
      expect(text).not.toContain('forcePassword.errors');
      if (needle) expect(text, name).toContain(needle);
    });
  }

  it('没有 error 信封的纯文本 500（网关/反向代理原文）⇒ 渲染成可读字符串', async () => {
    // 专门绕开 jsonResponse：非 JSON 的 text/plain 让 api() 的 r.json() 直接 reject。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.startsWith('/api/me/password')) {
        return new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
      }
      if (url.startsWith('/api/me')) {
        return jsonResponse(200, { user: { ...RESTRICTED_USER, must_change_password: true } });
      }
      return jsonResponse(200, { dirs: [], items: [] });
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createAppRouter(createMemoryHistory());
    router.push('/change-password');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
    await tick();
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);

    await submitWrongButWellFormed(wrapper);
    const text = alertText(wrapper);
    expect(text).not.toContain('[object Object]');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toContain('forcePassword.errors');
    // 状态码要带出来（报障要用）。
    expect(text).toContain('502');
  });
});

describe('#255 前端② 全局 403 password_change_required 兜底（不在视图里判码）', () => {
  it('任意请求返回该码 ⇒ 集中置旗标 + 切到改密屏（进路是工作台，不是改密屏自己）', async () => {
    // 形状：会话本来**不受限**（/api/me 回答 false，人好好在工作台），**中途**任意一次 /api/*
    // 撞上 §2.11a 的门（管理员在另一头点了「重置口令」）⇒ 前端必须自己发现并把人送到改密屏。
    let gated = false;
    let meFlag = false;
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      seen.push(url);
      if (url.startsWith('/api/me')) return jsonResponse(200, { user: { ...RESTRICTED_USER, must_change_password: meFlag } });
      if (gated) {
        // 清单外的端点一律 403 password_change_required（§2.11a 的放行清单里没有 /api/sessions）。
        meFlag = true;
        return jsonResponse(403, {
          error: { code: 'password_change_required', message: '请先修改初始口令', details: { action: 'change_password', endpoint: '/api/me/password' } },
        });
      }
      if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs: [] });
      return jsonResponse(200, { items: [] });
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createAppRouter(createMemoryHistory());
    router.push('/session/s1');
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router, i18n] } });
    await tick();

    // 前置：不受限 ⇒ 工作台正常挂载（没有改密屏），并且确实已经打过业务请求。
    const auth = useAuthStore();
    expect(auth.passwordChangeRequired, '前置：还没撞上受限会话门').toBe(false);
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(false);
    expect(seen.some((u) => u.startsWith('/api/dirs')), '前置：工作台自己打过 /api/dirs').toBe(true);

    // 撞门：下一次任意请求（这里直接调 api()，代表任何一个视图的调用）返回该码。
    gated = true;
    const { api } = await import('../api');
    await expect(api('/api/sessions')).rejects.toBeTruthy();
    await tick(60);

    expect(auth.passwordChangeRequired, '兜底必须集中置旗标').toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/change-password'));
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
  });

  it('403 但 code 是别的（forbidden / cross_origin_forbidden）⇒ **不许**误置旗标（变异靶子）', async () => {
    for (const code of ['forbidden', 'cross_origin_forbidden']) {
      const pinia = createPinia();
      setActivePinia(pinia);
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.startsWith('/api/me')) return jsonResponse(200, { user: RESTRICTED_USER_OK });
        return jsonResponse(403, { error: { code, message: 'nope' } });
      }));
      const router = createAppRouter(createMemoryHistory());
      router.push('/');
      await router.isReady();
      mount(App, { global: { plugins: [pinia, router, i18n] } });
      await tick(80);
      expect(useAuthStore().passwordChangeRequired, code).toBe(false);
      expect(router.currentRoute.value.path, code).toBe('/');
      vi.unstubAllGlobals();
    }
  });

  it('200 响应体里带一个同名 code（理论上不该出现）⇒ 同样不许触发（判据要同时看状态码）', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.startsWith('/api/me')) return jsonResponse(200, { user: RESTRICTED_USER_OK });
      return jsonResponse(200, { code: 'password_change_required', dirs: [] });
    }));
    const router = createAppRouter(createMemoryHistory());
    router.push('/');
    await router.isReady();
    mount(App, { global: { plugins: [pinia, router, i18n] } });
    await tick(80);
    expect(useAuthStore().passwordChangeRequired).toBe(false);
  });
});

describe('#255 前端② 改密成功瞬间不把同一个组件重挂一帧', () => {
  it('改密成功的形状：旗标已清、路由还停在 /change-password ⇒ 屏上**没有表单**（不重挂）', async () => {
    const { wrapper, router } = await enterForceScreen({});
    expect(router.currentRoute.value.path).toBe('/change-password');
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);

    // 手动重演「成功的那一刻」：store 从 /api/me 拿到 false（闸门随即关闭），
    // 而 router.replace(落地页) 还在后面一帧 ⇒ 路由仍停在 /change-password。
    // 路由表若挂本体，router-view 这一帧会**再挂一个** ForcePasswordChangeView（表单闪一下）。
    const auth = useAuthStore();
    auth.passwordChangeRequired = false;
    await tick();
    expect(router.currentRoute.value.path, '本例故意让路由还停在改密屏').toBe('/change-password');
    expect(wrapper.find(FORCE_SCREEN).exists(), '路由层不得再渲染一份本体').toBe(false);
    expect(wrapper.findAll('#currentPassword').length).toBe(0);

    // 本体自己挂上去（闸门的用法）仍然正常：确认这不是「删了渲染点」带来的假绿。
    auth.passwordChangeRequired = true;
    await tick();
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);
  });

  it('路由表里 /change-password 的组件是个空壳（不渲染任何文本）', async () => {
    const shim = (await import('./ForcePasswordRouteShim.vue')).default;
    const shimWrapper = mount(shim);
    expect(shimWrapper.find(FORCE_SCREEN).exists()).toBe(false);
    expect(shimWrapper.text()).toBe('');
    shimWrapper.unmount();
  });

  it('成功链路照旧：清旗标后被 router.replace 送到落地页，改密屏不再在场', async () => {
    const { wrapper, auth, router } = await enterForceScreen({});
    await submitWrongButWellFormed(wrapper);
    await vi.waitFor(() => expect(auth.passwordChangeRequired).toBe(false));
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'));
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(false);
  });
});

/** 正常账号（不受限）：兜底用例的对照组。 */
const RESTRICTED_USER_OK = {
  id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: 'bob',
  auth_source: 'local', must_change_password: false,
} as AuthUser;

/** 双语键集：errors.* 两侧逐字一致（照 ① 的 forcePassword.* 断言口径，只覆盖新增子树）。 */
describe('#255 前端② forcePassword.errors.* 双语键集', () => {
  const paths = (v: unknown, prefix = ''): string[] =>
    v !== null && typeof v === 'object'
      ? Object.entries(v as Record<string, unknown>).flatMap(([k, c]) => paths(c, prefix ? `${prefix}.${k}` : k))
      : [prefix];
  const read = (root: object, path: string) =>
    path.split('.').reduce<unknown>((n, s) => (n as Record<string, unknown>)[s], root) as string;

  it('zh 与 en 的 forcePassword.errors.* 叶子键集完全一致，且中英各写各的', () => {
    const zh = paths(zhCN.forcePassword.errors, 'forcePassword.errors').sort();
    const enKeys = paths(en.forcePassword.errors, 'forcePassword.errors').sort();
    expect(zh.length).toBeGreaterThan(12);
    expect(enKeys).toEqual(zh);
    for (const key of zh) {
      const zhText = read(zhCN, key);
      const enText = read(en, key);
      expect(zhText.length, key).toBeGreaterThan(0);
      expect(enText.length, key).toBeGreaterThan(0);
      expect(zhText, key).toMatch(/[\u4e00-\u9fff]/);
      expect(enText, key).not.toMatch(/[\u4e00-\u9fff]/);
      expect(enText, key).not.toBe(zhText);
    }
  });

  it('① 的临时兜底键（serverError / genericError）已随映射表落地而移除', () => {
    const root = zhCN.forcePassword as unknown as Record<string, unknown>;
    expect(root.serverError).toBeUndefined();
    expect(root.genericError).toBeUndefined();
    expect((en.forcePassword as unknown as Record<string, unknown>).serverError).toBeUndefined();
  });
});
