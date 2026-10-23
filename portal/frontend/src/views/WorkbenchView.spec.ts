// WorkbenchView 顶栏 i18n 单测（issue #101 P2）：
//   ① zh-CN 基线：顶栏文案（☰ 导航 / cwd 徽标 title / who 拼接 / 管理台 / 登出 / ↓ 最新）与
//      aria-label（打开导航 / 调整侧栏宽度）走 i18n 后取值逐字不变；
//   ② 顶栏语言切换菜单（LocaleSwitch）挂载在管理台/登出旁；切 English 后顶栏（含嵌套的侧栏
//      子组件）文案即时变英文，who 拼接改半角括号。
// 约定（照 LoginView.spec 先例）：装配真实 i18n 单例，不 mock t()；每例 localStorage.clear() + setLocale('zh-CN')。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import WorkbenchView from './WorkbenchView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { createAppRouter } from '../router';
import { useAuthStore, type AuthUser } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench'; // issue #281：断言消息流里的可见错误行要用 store
import { i18n, setLocale } from '../i18n';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
// issue #308（M3）：原夹具是「无工位管理员」（`admin` 且 `fde_name=null`）——#334 的准入闸
// （lib/workbenchGate.ts）之后这个形状进不到工作台（会被改写到 /admin），拿它当夹具等于给不可达
// 状态做覆盖。换成第 ② 类人：`admin` **且**有工位（闸放行，顶栏仍有「管理台」入口）。
const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
} as AuthUser;
// `who` 的无 fde_name 分支仍然可达：闸只挡「admin 且无工位」，`role='fde'` + `fde_name=null` 的畸形
// 账号照常进得来（lib/workbenchGate.spec.ts:82 钉着 next）⇒ 这条分支的覆盖改用它，不删。
const FDE_NO_SEAT = {
  id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: null, auth_source: 'local',
} as AuthUser;
const DIRS = [{ name: 'demo', cwd: '~/projects/demo', running_count: 0, queued_count: 0 }];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 真实推进 macrotask（jsdom Response.json）后再冲刷微任务。 */
const tick = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

/** 挂载工作台（目录列表经 fetch 桩注入；会话列表恒为空）。 */
async function mountWorkbench(user: AuthUser = FDE_USER, dirs = DIRS) {
  const pinia = createPinia();
  setActivePinia(pinia);
  // 按 URL 分派的 fetch 桩（先于 router.push：导航守卫会打 /api/me）。
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/me')) return jsonResponse({ user });
    if (url.startsWith('/api/dirs')) return jsonResponse({ dirs });
    if (url.startsWith('/api/sessions')) return jsonResponse({ items: [] });
    return jsonResponse({});
  }));
  const auth = useAuthStore();
  auth.user = user;
  auth.ready = true; // 已探测过：守卫不再打 /api/me
  const router = createAppRouter(createMemoryHistory());
  router.push('/');
  await router.isReady();
  const wrapper = mount(WorkbenchView, { global: { plugins: [pinia, router, i18n] } });
  await tick(); // initWorkspace（/api/dirs → loadSessions）真实落地
  return wrapper;
}

/** 「↓ 最新」悬浮按钮：jsdom 无真实布局，手工造出「距底 > AUTO_FOLLOW_GAP」并派发 scroll。 */
async function triggerScrollAway(wrapper: Awaited<ReturnType<typeof mountWorkbench>>) {
  const el = wrapper.find('section > div').element as HTMLElement;
  Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
  el.scrollTop = 0;
  await wrapper.find('section > div').trigger('scroll');
}

/** 切语言：点顶栏 LocaleSwitch 的 English 菜单项。 */
async function switchToEnglish(wrapper: Awaited<ReturnType<typeof mountWorkbench>>) {
  const sw = wrapper.findComponent(LocaleSwitch);
  await sw.find('button').trigger('click');
  await sw.findAll('[role="menuitem"]')[1].trigger('click');
  await flushPromises();
}

describe('WorkbenchView 顶栏 · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：导航/徽标 title/who/登出/aria-label 文案与 P1 前逐字一致', async () => {
    const wrapper = await mountWorkbench();
    const nav = wrapper.find('header button');
    expect(nav.text()).toBe('☰ 导航');
    expect(nav.attributes('aria-label')).toBe('打开导航');
    // cwd 徽标：hover 全路径 + 点击复制提示
    const badge = wrapper.find('header button[title]');
    expect(badge.attributes('title')).toBe('~/projects/demo（点击复制）');
    expect(badge.text()).toContain('📁 demo');
    // who 拼接：login（role / fde_name）
    expect(wrapper.find('header span.flex-1').text()).toBe('alice（fde / alice）');
    // 普通 FDE 无「管理台」入口；登出按钮 + 语言切换菜单在位
    expect(wrapper.find('header a[href="/admin"]').exists()).toBe(false);
    // header 直系 button：☰ 导航 / cwd 徽标 / 登出（LocaleSwitch 自身按钮在子 div 内，不计入）
    expect(wrapper.findAll('header > button').at(-1)!.text()).toBe('登出');
    expect(wrapper.findComponent(LocaleSwitch).exists()).toBe(true);
    // 侧栏拖拽把手无障碍标签
    expect(wrapper.find('[role="separator"]').attributes('aria-label')).toBe('调整侧栏宽度');
  });

  it('平台管理员（第 ② 类人：admin 且有工位）：顶栏「管理台」入口；who 带 fde_name（全角括号）', async () => {
    const wrapper = await mountWorkbench(ADMIN_WITH_SEAT);
    expect(wrapper.find('header span.flex-1').text()).toBe('root（admin / root）');
    expect(wrapper.find('header a[href="/admin"]').text()).toBe('管理台');
  });

  it('who 的无 fde_name 分支（fde 账号缺 fde_name）：只显示 role（全角括号）', async () => {
    const wrapper = await mountWorkbench(FDE_NO_SEAT);
    expect(wrapper.find('header span.flex-1').text()).toBe('bob（fde）');
    expect(wrapper.find('header a[href="/admin"]').exists()).toBe(false);
  });

  it('「↓ 最新」悬浮按钮文案走 i18n（离开底部时出现）', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.find('section > button').exists()).toBe(false);
    await triggerScrollAway(wrapper);
    expect(wrapper.find('section > button').text()).toBe('↓ 最新');
  });

  it('切 English：顶栏 + 嵌套侧栏文案即时变英文（who 改半角括号），并持久化', async () => {
    const wrapper = await mountWorkbench(ADMIN_WITH_SEAT);
    expect(wrapper.find('header span.flex-1').text()).toBe('root（admin / root）');

    await switchToEnglish(wrapper);

    expect(wrapper.find('header button').text()).toBe('☰ Navigation');
    expect(wrapper.find('header button').attributes('aria-label')).toBe('Open navigation');
    expect(wrapper.find('header button[title]').attributes('title')).toBe('~/projects/demo (click to copy)');
    expect(wrapper.find('header span.flex-1').text()).toBe('root (admin / root)');
    expect(wrapper.find('header a[href="/admin"]').text()).toBe('Admin console');
    expect(wrapper.findAll('header > button').at(-1)!.text()).toBe('Sign out');
    expect(wrapper.find('[role="separator"]').attributes('aria-label')).toBe('Resize sidebar');
    // 嵌套子组件（SidebarPanel/DirSelect）同样响应（全局 locale 向子树传播）
    expect(wrapper.text()).toContain('＋ New session');
    expect(wrapper.text()).toContain('＋ New directory');
    // 持久化 + <html lang> 同步
    expect(localStorage.getItem('locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('切 English 后「↓ 最新」同样变英文', async () => {
    const wrapper = await mountWorkbench();
    await triggerScrollAway(wrapper);
    expect(wrapper.find('section > button').text()).toBe('↓ 最新');
    await switchToEnglish(wrapper);
    expect(wrapper.find('section > button').text()).toBe('↓ Latest');
  });
});

// ===========================================================================
// issue #281：`WorkbenchView.onMounted` 是 `async` 钩子，而 **Vue 不等它返回的 Promise** ⇒
// 里面任何没人 catch 的 `await` 都直接演成 Unhandled Rejection。这条真金白银咬过两次：
//   ① v0.1.7 打 tag 时 CI 步骤④ 红（`ApiError: nope` 从 `loadDirs` 飘出来，AGENTS §4/§8.20）；
//   ② `resolveRouteSession` 读 `session.cwd` 在回包缺 `session` 时抛 TypeError（§8.20 记的同一处）。
// 本组用例做两件事：把「**零未捕获拒绝**」钉成断言（自检钩子照 views/ForcePasswordErrors.spec.ts 的
// 先例），以及钉住「失败必须在**界面上**看得见」（不是白屏、不是只有控制台）。
// 准入闸语义（#332/#334 的 lib/workbenchGate）不由本组用例改动 ⇒ 另跑 SeatlessAdminGate/router 两组。
// ===========================================================================
describe('issue #281：onMounted 的 await 失败 ⇒ 零未捕获拒绝 + 界面上看得见', () => {
  const leaked: unknown[] = [];
  const onRejection = (reason: unknown) => { leaked.push(reason); };
  const describeRejection = (reason: unknown) =>
    reason instanceof Error ? `${reason.constructor?.name ?? 'Error'}: ${reason.message}` : String(reason);

  beforeAll(() => {
    expect(
      typeof process !== 'undefined' && typeof process.on === 'function',
      '自检钩子依据：vitest 的 jsdom 跑在 Node 里，process.on("unhandledRejection") 可用',
    ).toBe(true);
    process.on('unhandledRejection', onRejection);
  });
  afterAll(async () => {
    await tick(60); // 最后一条用例里在途的 promise 也要在本文件落地，否则又变成机器快慢决定的偶发红
    const stragglers = leaked.splice(0);
    expect(stragglers.map(describeRejection), '文件收尾：仍有未捕获拒绝飘在本文件里').toEqual([]);
    process.off('unhandledRejection', onRejection);
  });
  beforeEach(() => {
    leaked.splice(0);
  });

  type Reply = { status: number; body: unknown };
  /** 成功基线：只有 special 点名的端点允许非 2xx / 缺形状（「所有请求一律失败」那种夹具正是 CI 红灯的来源）。 */
  function defaultReply(url: string): Reply {
    if (url.startsWith('/api/me')) return { status: 200, body: { user: FDE_USER } };
    if (url.startsWith('/api/dirs')) return { status: 200, body: { dirs: DIRS } };
    if (url.startsWith('/api/me/ports')) return { status: 200, body: { items: [] } };
    if (/^\/api\/sessions\?/.test(url)) return { status: 200, body: { items: [] } };
    if (/\/events\/history$/.test(url)) return { status: 200, body: { events: [], next_cursor: null } };
    if (/\/api\/files\//.test(url)) return { status: 200, body: { entries: [] } };
    return { status: 200, body: {} };
  }
  /** 按 URL 分派的挂载夹具：只有 `special` 里点名的端点允许非 2xx / 缺形状，其余一律给成功形状。 */
  async function mountFailing(special: (url: string) => Reply | undefined, path = '/') {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const reply = special(url) ?? defaultReply(url);
      // 本文件的 jsonResponse 助手写死 200，这里要能回 5xx ⇒ 自己造 Response（同一套头）。
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const auth = useAuthStore();
    auth.user = FDE_USER;
    auth.ready = true; // 守卫不再打 /api/me：本组只关心 initWorkspace / resolveRouteSession
    const router = createAppRouter(createMemoryHistory());
    await router.push(path);
    await router.isReady();
    const wrapper = mount(WorkbenchView, { global: { plugins: [pinia, router, i18n] } });
    await tick(60); // 让 onMounted 里在途的 promise 在**本条用例内**落地
    return { wrapper, store: useWorkbenchStore() };
  }

  const syserrTexts = (store: ReturnType<typeof useWorkbenchStore>) =>
    store.entries.filter((e) => e.kind === 'syserr').map((e) => ('text' in e ? e.text : ''));

  it('initWorkspace 失败（GET /api/dirs 500）⇒ 零未捕获拒绝，且消息流里有可见错误行', async () => {
    const { wrapper, store } = await mountFailing((url) =>
      // 错误信封按契约给（`api.ts` 取 `body.error.message`，兜底才是 `请求失败（HTTP 500）`）
      url.startsWith('/api/dirs') ? { status: 500, body: { error: { code: 'internal', message: 'db down' } } } : undefined);
    const errs = syserrTexts(store);
    expect(errs.length, '初始化失败必须落一条可见错误行（不是只进控制台）').toBeGreaterThan(0);
    expect(errs.join('\n')).toContain('工作台初始化失败');
    // 详情串 = `api()` 抛的 ApiError.message（它对 5xx 优先取信封里的 `body.error.message`，
    // 没给才兜底成 `请求失败（HTTP 500）`）⇒ 服务端说明要能原样进界面供报障。
    expect(errs.join('\n')).toContain('db down');
    expect(errs.join('\n')).not.toContain('[object Object]');
    expect(errs.join('\n')).not.toContain('undefined');
    // **界面上真看得见**：错误行必须进 DOM（不是只进 store、更不是只进 console）。
    // 不拿 `.muted` 当判据——侧栏另有同名样式类；空态默认文案的那一支在 StreamPanel 的
    // `entries.length === 0` 里，推进错误行之后它自然不再出现。
    const errNode = wrapper.find('.syserr');
    expect(errNode.exists(), '错误行必须渲染进 DOM').toBe(true);
    expect(errNode.text()).toContain('工作台初始化失败');
    // 不是白屏：顶栏仍在（用户还能看见自己是谁、还能刷新重试）
    expect(wrapper.find('header').exists()).toBe(true);
    await tick(60);
    expect(leaked.map(describeRejection), `泄漏 ${leaked.length} 条未捕获拒绝`).toEqual([]);
  });

  it('深链会话详情回包缺 `session` 键 ⇒ 不再抛 `.cwd` TypeError，且报可见错误', async () => {
    // 判空与「视图兜底」都能让界面不白屏，所以只断言可见错误分不开两层：**store 侧判空到位时根本
    // 不会产生 TypeError**，也就不会走视图那条 console.error。删掉 store 的判空（变异 N3）时这条
    // 会红在 console.error 上——那才是「判空不是吞掉真实错误，而是不拿 TypeError 代替它」的可检查形状。
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store } = await mountFailing(
      (url) => (/\/api\/sessions\/s1$/.test(url) ? { status: 200, body: { messages: [] } } : undefined),
      '/session/s1',
    );
    const errs = syserrTexts(store);
    expect(errs.join('\n')).toContain('会话加载失败');
    expect(leaked.map(describeRejection), `泄漏 ${leaked.length} 条未捕获拒绝`).toEqual([]);
    const logged = errSpy.mock.calls.map((c) => c.map(describeRejection).join(' ')).join('\n');
    expect(logged, 'store 侧判空到位 ⇒ 不该有 TypeError 冒到视图的 console.error').not.toContain('TypeError');
    errSpy.mockRestore();
  });

  it('深链会话详情 500 ⇒ store 自己那条 syserr 仍在，且零未捕获拒绝', async () => {
    const { store } = await mountFailing(
      (url) => (/\/api\/sessions\/s1$/.test(url) ? { status: 500, body: { code: 'internal', message: 'boom' } } : undefined),
      '/session/s1',
    );
    expect(syserrTexts(store).join('\n')).toContain('会话加载失败');
    expect(leaked.map(describeRejection), `泄漏 ${leaked.length} 条未捕获拒绝`).toEqual([]);
  });

  // 变异取证补的用例：删掉 onMounted 里**第二个** try/catch（深链那一个）时，前 4 条 #281 用例
  // 全绿（store 自己已经 catch 掉了 ApiError）⇒ 那道闸当时没有主。补这条把「深链后半段炸」的形状
  // 钉上去：会话详情拿到了，但 openSession 收尾要 new EventSource（环境级意外，如 webview 里没有）。
  it('深链后半段抛错（EventSource 不可用）⇒ 视图那道 catch 兜住：零未捕获拒绝 + 可见错误', async () => {
    vi.stubGlobal('EventSource', vi.fn(() => { throw new TypeError('EventSource is not a constructor'); }));
    const { store } = await mountFailing(
      (url) => (/\/api\/sessions\/s1$/.test(url)
        ? { status: 200, body: { session: { id: 's1', title: '深链会话', cwd: DIRS[0].cwd }, messages: [], last_seq: 0 } }
        : undefined),
      '/session/s1',
    );
    expect(syserrTexts(store).join('\n')).toContain('会话加载失败');
    expect(leaked.map(describeRejection), `泄漏 ${leaked.length} 条未捕获拒绝`).toEqual([]);
  });

  it('成功路径不受影响：有目录就不推错误行（修复没把正常态改成报错）', async () => {
    const { store } = await mountFailing(() => undefined);
    expect(syserrTexts(store)).toEqual([]);
    expect(store.dirCwd).toBe(DIRS[0].cwd);
    expect(leaked.map(describeRejection)).toEqual([]);
  });

  it('脏失败（reject 一个非 Error 的对象）⇒ 文案过 toDisplayText，不退化成 [object Object]', async () => {
    // 信封里 message 是空串 ⇒ api 层兜底成 `请求失败（HTTP 500）`；本条钉的是兜底串也不许演脏。
    const { store } = await mountFailing((url) =>
      url.startsWith('/api/dirs') ? { status: 500, body: { error: { code: 'internal', message: '' } } } : undefined);
    const line = syserrTexts(store).join('\n');
    expect(line).toContain('工作台初始化失败');
    expect(line).toContain('HTTP 500');
    expect(line).not.toContain('[object Object]');
    expect(leaked.map(describeRejection), `泄漏 ${leaked.length} 条未捕获拒绝`).toEqual([]);
  });
});
