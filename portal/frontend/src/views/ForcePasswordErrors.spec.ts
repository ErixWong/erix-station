// #255 前端 ②：错误语义与兜底的**渲染侧**单测（挂整个 App，看人真正看到什么）。
// 分工：「码 → 键」的映射本体在 lib/forcePasswordErrors.spec.ts，这里只验进 DOM 后的形状。
// 装配风格照 ①（views/ForcePasswordChangeView.spec.ts）：真实 i18n 单例、不 mock t()、
// 每例 localStorage.clear() + setLocale('zh-CN')、导航落地用 vi.waitFor 轮询而不数 tick。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ==================== 「零未捕获拒绝」自检（CI 步骤④ 时序敏感红灯的收口）====================
// 症状（tag v0.1.7 / CI job 115468434538：本地 33 文件 488 用例全绿、CI 红）：
//   ApiError: nope              ❯ api src/api.ts:94  ❯ loadDirs src/stores/workbench.ts:428  ❯ WorkbenchView.vue:112
//   TypeError: … reading 'cwd'  ❯ resolveRouteSession src/stores/workbench.ts:691  ❯ WorkbenchView.vue:114
//   This error originated in "src/views/ForcePasswordErrors.spec.ts" test file
// 机制（那两个 await 缺 catch 是产品侧问题，已另单，**本单不碰产品代码**）：
//   `WorkbenchView.vue:109-114` 的 onMounted 里 `await store.initWorkspace()`（#332 后不再接 user）与
//   `await store.resolveRouteSession(...)` 都没有 catch ⇒ 夹具只要让 /api/dirs、/api/sessions* 失败或
//   缺形状，那个 async 钩子的 promise 就拒绝；Vue 的 callWithAsyncErrorHandling 把它交给
//   handleError → logError(throwInDev=true) **再 throw**（@vue/runtime-core 的 logError），于是 catch
//   自己派生出的那条 promise 无人处理 ⇒ Node 报 unhandledRejection ⇒ vitest 把整个文件判失败。
//   它落在哪一帧由机器快慢决定 —— 这就是「本地全绿、CI 慢机红」的根因。修法不是重试、不是加大超时，
//   而是①夹具不再制造这种拒绝（见下面确定成功夹具）＋②收尾强制落地（closeApps）＋③把「零泄漏」钉成断言。
// 自检钩子依据：vitest 的 jsdom 环境跑在 Node 进程里 ⇒ `process.on('unhandledRejection')` 可用
//   （`npx vitest` 在本机挂死，故可用性在 beforeAll 里先断言再注册：真不可用就让这条自检明确红，
//   而不是静默退化成摆设）。我们只是**加**一条有名有姓的断言，不替代 vitest 自己的处理。
const leakedRejections: unknown[] = [];
function onUnhandledRejection(reason: unknown): void {
  leakedRejections.push(reason);
}
function describeRejection(reason: unknown): string {
  return reason instanceof Error ? `${reason.constructor?.name ?? 'Error'}: ${reason.message}` : String(reason);
}
/** 断言「本例没留下任何未捕获的 promise 拒绝」，并消费掉计数（不串给下一条用例）。 */
function expectNoLeakedRejections(label: string): void {
  const leaked = leakedRejections.splice(0);
  expect(leaked.map(describeRejection), `${label}：泄漏了 ${leaked.length} 条未捕获拒绝（onMounted 里没人 catch 的 await）`).toEqual([]);
}
beforeAll(() => {
  expect(
    typeof process !== 'undefined' && typeof process.on === 'function',
    '自检钩子依据：vitest 的 jsdom 环境跑在 Node 里，process.on("unhandledRejection") 可用',
  ).toBe(true);
  process.on('unhandledRejection', onUnhandledRejection);
});
afterAll(async () => {
  // 文件收尾再兜一层：最后一条用例的 afterEach 之后才飘出来的拒绝也算红（否则又得靠机器快慢）。
  await closeApps();
  const stragglers = leakedRejections.splice(0);
  expect(stragglers.map(describeRejection), '文件收尾：仍有未捕获拒绝飘在本文件里').toEqual([]);
  process.off('unhandledRejection', onUnhandledRejection);
});

// ---- 挂载登记与收尾冲刷：让 onMounted 里在途的 promise 在**本条用例内**落地 ----
type MountHandle = { unmount: () => void };
const liveMounts: MountHandle[] = [];
/** 挂载 App 外壳并登记（收尾一律卸载，见 closeApps）。 */
function mountApp(opts: { pinia: ReturnType<typeof createPinia>; router: ReturnType<typeof createAppRouter> }) {
  const wrapper = mount(App, { global: { plugins: [opts.pinia, opts.router, i18n] } });
  liveMounts.push(wrapper);
  return wrapper;
}
/** 真实推进宏任务（jsdom 的 Response.json 要它）+ 冲刷微任务，成对来两轮。 */
async function settlePending(): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await new Promise((r) => setTimeout(r, 20));
    await flushPromises();
  }
}
/**
 * 用例收尾：冲刷 → 卸载全部挂载 → **再冲刷一轮**。
 * 卸载后仍要在本例内落地：否则 onMounted 里那些没人 catch 的 promise 会把拒绝飘到下一条用例
 * 甚至文件收尾，变成机器快慢决定的偶发红灯（CI 那条 `ApiError: nope` 就是这个形状）。
 */
async function closeApps(): Promise<void> {
  await settlePending();
  for (const wrapper of liveMounts.splice(0)) {
    try {
      wrapper.unmount();
    } catch {
      /* 用例自己已经 unmount 过：无害 */
    }
  }
  await settlePending();
}

// ==================== 确定成功夹具：只有「本次要测的那一个」端点允许失败 ====================
// 工作台挂载会打的每一个端点都给形状正确的最小成功回包：/api/me、/api/me/ports（顶栏预览端口）、
// /api/dirs、/api/files/tree、/api/sessions[?cwd=…]、/api/sessions/:id、/api/sessions/:id/events/history。
// 「所有请求一律 403」那种夹具正是 CI 红灯的来源（机制见本节开头注记），本文件不再使用它。
const WORKBENCH_DIR = { name: 'demo', cwd: '~/projects/demo', running_count: 0, queued_count: 0 };
/** 完整会话数据：深链 /session/s1 由此走 resolveRouteSession 的正路（不撞 session 为 undefined 时读 .cwd 的那条产品侧路径）。 */
const SESSION_S1 = { id: 's1', title: '会话一', title_source: 'manual', cwd: WORKBENCH_DIR.cwd, message_count: 0, active_run_id: null };

/** 强制回包：本次要测的那一个端点专用。 */
interface Forced {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}
interface StubOptions {
  /** /api/me 回答的用户（默认受限的 alice）。 */
  user?: AuthUser;
  /** 服务端受限旗标的真相（可变对象：改密成功、或撞门后由本桩照实回答）。 */
  meFlag?: { value: boolean };
  /** 改密那次 POST 的回包（默认 200 成功）。 */
  change?: Forced;
  /** 服务端是否照回答清旗标（默认 true）。 */
  clearFlagOnChange?: boolean;
  /** 命中即按给定回包应答 —— **只有这里**允许非 2xx / 特殊形状。 */
  special?: (url: string) => Forced | undefined;
  dirs?: unknown[];
  sessions?: unknown[];
  onCall?: (url: string, init?: RequestInit) => void;
}

function makeApiFetchStub(o: StubOptions) {
  const user = o.user ?? RESTRICTED_USER;
  const meFlag = o.meFlag ?? { value: true };
  const dirs = o.dirs ?? [];
  const sessions = o.sessions ?? [];
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    o.onCall?.(url, init);
    const forced = o.special?.(url);
    if (forced) return jsonResponse(forced.status, forced.body, forced.headers ?? {});
    if (url.startsWith('/api/me/password')) {
      const r = o.change ?? { status: 200, body: { ok: true, password_change_required: false, sessions_revoked: 1 } };
      if (r.status === 200 && o.clearFlagOnChange !== false) meFlag.value = false;
      return jsonResponse(r.status, r.body, r.headers ?? {});
    }
    // /api/me/ports 必须排在 /api/me 前（同前缀，先长后短）。
    if (url.startsWith('/api/me/ports')) return jsonResponse(200, { items: [] });
    if (url.startsWith('/api/me')) return jsonResponse(200, { user: { ...user, must_change_password: meFlag.value } });
    if (url.startsWith('/api/files/tree')) return jsonResponse(200, { entries: [] });
    if (url.startsWith('/api/dirs')) return jsonResponse(200, { dirs });
    if (/^\/api\/sessions\/[^/]+\/events\/history/.test(url)) return jsonResponse(200, { events: [] });
    if (/^\/api\/sessions\//.test(url)) {
      const sid = decodeURIComponent(url.slice('/api/sessions/'.length).split('?')[0] ?? '');
      return jsonResponse(200, { session: { ...SESSION_S1, id: sid }, messages: [], last_seq: 0 });
    }
    if (url.startsWith('/api/sessions')) return jsonResponse(200, { items: sessions });
    return jsonResponse(200, {});
  });
}

/** EventSource 桩（口径同 stores/workbench.spec.ts）：openSession 末尾会 es.connect()，而 jsdom 不提供 EventSource（实测 typeof window.EventSource === 'undefined'）。 */
class FakeEventSource {
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.closed = true;
  }
}

/** 只给「真的会走到 es.connect()」的用例装（卸载后 afterEach 的 unstubAllGlobals 收尾）。 */
function stubEventSource(): void {
  vi.stubGlobal('EventSource', FakeEventSource);
}

/**
 * 进改密屏的**唯一进路**：`GET /api/me` 回答 must_change_password=true（§2.11a：刷新后重建改密屏
 * 的唯一数据源）。`changeResponse` 决定改密那次 POST 的回包 —— 它才是**本次要测的端点**；
 * 其余端点（含工作台会打的 /api/dirs、/api/sessions、/api/me/ports）一律走确定成功的最小回包。
 */
interface Opts {
  changeResponse?: { status: number; body: unknown; headers?: Record<string, string> };
  /** 服务端是否照回答清旗标（默认 true）。 */
  clearFlagOnChange?: boolean;
}

async function enterForceScreen(opts: Opts) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', makeApiFetchStub({
    user: RESTRICTED_USER,
    change: opts.changeResponse,
    clearFlagOnChange: opts.clearFlagOnChange,
    onCall: (url, init) => {
      calls.push(`${(init?.method ?? 'GET')} ${url}`);
    },
  }));

  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createAppRouter(createMemoryHistory());
  // 先 await 导航（守卫那发 /api/me 要落地）再挂载 + 冲刷：挂载时机确定，不拿机器快慢赌。
  await router.push('/change-password');
  await router.isReady();
  const wrapper = mountApp({ pinia, router });
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
afterEach(async () => {
  // 收尾一律卸载 + 冲刷，然后把「零未捕获拒绝」当作**被断言的行为**收口：
  // 泄漏不再取决于它坨在哪一帧（= CI 偶发红的根因），而是本例直接红。
  await closeApps();
  expectNoLeakedRejections('用例收尾');
  vi.unstubAllGlobals();
});

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
    // 只接管被测那一个端点；其余端点照用确定成功夹具（不让无关请求掺进形状不对的回包）。
    const ok = makeApiFetchStub({ user: RESTRICTED_USER });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = urlOf(input);
      if (url.startsWith('/api/me/password')) {
        return new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
      }
      return ok(input, init);
    }));

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createAppRouter(createMemoryHistory());
    await router.push('/change-password');
    await router.isReady();
    const wrapper = mountApp({ pinia, router });
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
    // 不确定性已拆掉：① 挂载期（gated=false）工作台会打的每个端点都是确定成功，且深链 s1 在会话
    // 列表里、详情回包形状完整 ⇒ resolveRouteSession 走正路，不会碰到 session 为 undefined 再读
    // .cwd 的那条产品侧路径（产品侧已另单，本单不许碰）；② 只有 gated=true 之后的请求才吃 403，
    // 而那一次是**本例自己发出并 await 住的**。
    let gated = false;
    const meFlag = { value: false };
    const seen: string[] = [];
    const GATE: Forced = {
      status: 403,
      body: {
        error: { code: 'password_change_required', message: '请先修改初始口令', details: { action: 'change_password', endpoint: '/api/me/password' } },
      },
    };
    vi.stubGlobal('fetch', makeApiFetchStub({
      user: RESTRICTED_USER,
      meFlag,
      dirs: [WORKBENCH_DIR],
      sessions: [SESSION_S1],
      special: (url) => {
        if (!gated || url === '/api/me') return undefined;
        // 清单外的端点一律 403 password_change_required（§2.11a 的放行清单里没有 /api/sessions）；
        // 撞过门之后 /api/me 也照实回答「仍受限」（与旧夹具一致）。
        meFlag.value = true;
        return GATE;
      },
      onCall: (url) => {
        seen.push(url);
      },
    }));
    stubEventSource(); // openSession 末尾会 es.connect()：jsdom 无 EventSource

    const pinia = createPinia();
    setActivePinia(pinia);
    const router = createAppRouter(createMemoryHistory());
    await router.push('/session/s1');
    await router.isReady();
    const wrapper = mountApp({ pinia, router });
    await tick();

    // 前置：不受限 ⇒ 工作台正常挂载（没有改密屏），并且确实已经打过业务请求。
    const auth = useAuthStore();
    expect(auth.passwordChangeRequired, '前置：还没撞上受限会话门').toBe(false);
    expect(wrapper.find(FORCE_SCREEN).exists(), '前置：人在工作台').toBe(false);
    expect(seen.some((u) => u.startsWith('/api/dirs')), '前置：工作台自己打过 /api/dirs').toBe(true);

    // 撞门：下一次任意请求（这里直接调 api()，代表任何一个视图的调用）返回该码。
    gated = true;
    const { api } = await import('../api');
    await expect(api('/api/sessions')).rejects.toBeTruthy(); // 拒绝由本例接住，不许飘出去
    await tick(60);

    expect(auth.passwordChangeRequired, '兜底必须集中置旗标').toBe(true);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/change-password'));
    expect(wrapper.find(FORCE_SCREEN).exists()).toBe(true);

    await closeApps(); // 卸载工作台，再冲刷一轮
    expectNoLeakedRejections('工作台撞门 → 改密屏');
  });

  it('403 但 code 是别的（forbidden / cross_origin_forbidden）⇒ **不许**误置旗标（变异靶子）', async () => {
    for (const code of ['forbidden', 'cross_origin_forbidden']) {
      const pinia = createPinia();
      setActivePinia(pinia);
      // **只有要测的那个码**失败：拿顶栏预览端口面板（自己 catch 得住）与工作台会话列表（本例显式
      // await）两个样本。其余端点一律确定成功 ⇒ onMounted 不会产出无人处理的拒绝。
      // 旧写法「非 /api/me 一律 403」就是 CI 那条 `ApiError: nope` 的制造者（initWorkspace 没人 catch）。
      const denied: Forced = { status: 403, body: { error: { code, message: 'nope' } } };
      vi.stubGlobal('fetch', makeApiFetchStub({
        user: RESTRICTED_USER_OK,
        meFlag: { value: false },
        dirs: [], // 空目录 ⇒ initWorkspace 在 loadSessions 前返回，/api/sessions 只由本例显式发起
        special: (url) => (url === '/api/me/ports' || url.startsWith('/api/sessions') ? denied : undefined),
      }));
      const router = createAppRouter(createMemoryHistory());
      await router.push('/');
      await router.isReady();
      const wrapper = mountApp({ pinia, router });
      await tick(80);
      expect(useAuthStore().passwordChangeRequired, code).toBe(false);
      expect(router.currentRoute.value.path, code).toBe('/');
      // 再拿一个工作台端点显式撞一次（本例接住拒绝）：两个方向都不许误置旗标。
      const { api } = await import('../api');
      await expect(api('/api/sessions')).rejects.toBeTruthy();
      expect(useAuthStore().passwordChangeRequired, code).toBe(false);
      expect(router.currentRoute.value.path, code).toBe('/');
      wrapper.unmount(); // 收尾：卸载后再冲刷一次，让 onMounted 在途的 promise 全部落地
      await tick();
      expectNoLeakedRejections(`403 code=${code}`);
      vi.unstubAllGlobals();
    }
  });

  it('200 响应体里带一个同名 code（理论上不该出现）⇒ 同样不许触发（判据要同时看状态码）', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    // 同名 code 只挂在**工作台真的会打**的那个端点（会话列表）上，其余端点保持确定成功。
    vi.stubGlobal('fetch', makeApiFetchStub({
      user: RESTRICTED_USER_OK,
      meFlag: { value: false },
      dirs: [WORKBENCH_DIR], // 有目录 ⇒ initWorkspace 真的打 /api/sessions?cwd=…，本例才有东西可判
      special: (url) => (url.startsWith('/api/sessions')
        ? { status: 200, body: { code: 'password_change_required', items: [] } }
        : undefined),
    }));
    const router = createAppRouter(createMemoryHistory());
    await router.push('/');
    await router.isReady();
    mountApp({ pinia, router }); // 卸载交给 closeApps（见 afterEach）
    await tick(80);
    expect(useAuthStore().passwordChangeRequired).toBe(false);
    expect(router.currentRoute.value.path).toBe('/');
    await closeApps();
    expectNoLeakedRejections('200 响应体带同名 code');
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
