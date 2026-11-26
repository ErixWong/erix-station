// WorkbenchView 顶栏 i18n 单测（issue #101 P2）：
//   ① zh-CN 基线：顶栏文案（☰ 导航 / cwd 徽标 title / who 拼接 / 登出 / ↓ 最新）与
//      aria-label（打开导航 / 调整侧栏宽度）走 i18n 后取值逐字不变；
//   ② 顶栏语言切换菜单（LocaleSwitch）挂载在登出旁（#821 后顶栏不再有「管理台」入口）；切 English 后顶栏（含嵌套的侧栏
//      子组件）文案即时变英文，who 拼接改半角括号。
// 约定（照 LoginView.spec 先例）：装配真实 i18n 单例，不 mock t()；每例 localStorage.clear() + setLocale('zh-CN')。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import WorkbenchView from './WorkbenchView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import SidebarPanel from '../components/SidebarPanel.vue';
import { createAppRouter } from '../router';
import { setUserScopeResetListener } from '../lib/userScope';
import { useAuthStore, type AuthUser } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench'; // issue #281：断言消息流里的可见错误行要用 store
// issue #816：折叠常驻条的数据侧（窄类型 + 把 compaction.lastRound 塞进 store 供竖串当分母）。
import type { FoldEntry } from '../lib/foldIndex';
import { normalizeSessionCompaction } from '../lib/compactionSummary';
import { i18n, setLocale } from '../i18n';

// issue #472：`file_upload_enabled: true` 是**故意**给真的 —— `/api/me` 桩里若全都没有这个键，
// 「上传按钮显示」这条分支就是零覆盖（B-13 的三态只有「隐藏」两态被测到，实现怎么写都绿）。
const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
  file_upload_enabled: true,
} as AuthUser;
// issue #308（M3）：原夹具是「无工位管理员」（`admin` 且 `fde_name=null`）——#334 的准入闸
// （lib/workbenchGate.ts）之后这个形状进不到工作台（会被改写到 /admin），拿它当夹具等于给不可达
// 状态做覆盖。换成第 ② 类人：`admin` **且**有工位（闸放行，可站上工作台）。
const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
} as AuthUser;
// `who` 的无 fde_name 分支仍然可达：闸只挡「admin 且无工位」，`role='fde'` + `fde_name=null` 的畸形
// 账号照常进得来（lib/workbenchGate.spec.ts:82 钉着 next）⇒ 这条分支的覆盖改用它，不删。
const FDE_NO_SEAT = {
  id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: null, auth_source: 'local',
} as AuthUser;
const DIRS = [{ name: 'demo', cwd: '~/projects/demo', running_count: 0, queued_count: 0 }];
// issue #359 P0b：收工灯的默认夹具（已收工）。脏载荷由个别用例自己传进 mountWorkbench 第三参。
const GIT_LIGHT_GREEN = {
  light: 'green', reason: 'synced', primary: null, cwd: '~/projects/demo',
  repos: [{ rel: '', repo: 'demo', light: 'green', reason: 'synced', shell: false, branch: 'main',
    no_commits: false, tracked_count: 0, untracked_count: 0, truncated: false, push_state: 'synced' }],
  counts: { red: 0, yellow: 0, grey: 0, green: 1 }, partial: false, git_available: true,
  truncated_repos: 0, checked_at: '2026-10-24T08:00:00.000Z',
};

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
async function mountWorkbench(
  user: AuthUser = FDE_USER,
  dirs = DIRS,
  gitLightBody: unknown = GIT_LIGHT_GREEN,
  macroTemplatesBody: unknown = { items: [] },
  quotaBody: unknown = { quota: null, reason: 'no_binding' },
  usageBody: unknown = { days: [], totals: { spend: 0, total_tokens: 0 } },
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  // 按 URL 分派的 fetch 桩（先于 router.push：导航守卫会打 /api/me）。
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    // issue #808：额度/用量必须排在 `/api/me` 兵项**之前**（否则被 `{ user }` 吐掉）。
    // 默认 no_binding ⇒ 徽标不渲染，既有用例的 who / button 序列断言不受影响。
    if (url.startsWith('/api/me/llm-quota')) return jsonResponse(quotaBody);
    if (url.startsWith('/api/me/llm-usage')) return jsonResponse(usageBody);
    if (url.startsWith('/api/me')) return jsonResponse({ user });
    if (url.startsWith('/api/dirs')) return jsonResponse({ dirs });
    if (url.startsWith('/api/sessions')) return jsonResponse({ items: [] });
    // issue #359 P0b：收工灯（默认给"已收工"，个别用例自己换成脏载荷）
    if (url.startsWith('/api/git-light')) return jsonResponse(gitLightBody);
    // issue #614：用户级抽屉要能拉到模板与全局流水
    if (url.startsWith('/api/macro-templates')) return jsonResponse(macroTemplatesBody);
    if (url.startsWith('/api/macro-runs')) return jsonResponse({ items: [], nextCursor: null });
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
    expect(wrapper.find('header [data-test="who"]').text()).toBe('alice（fde / alice）');
    // 普通 FDE 无「管理台」入口（用户面入口已整体拆除，见 fix-261126-03）；登出按钮 + 语言切换菜单在位
    expect(wrapper.find('header [data-test="admin-console-link"]').exists()).toBe(false);
    // header 直系 button：☰ 导航 / cwd 徽标 / 登出（LocaleSwitch 自身按钮在子 div 内，不计入）
    expect(wrapper.findAll('header > button').at(-1)!.text()).toBe('登出');
    expect(wrapper.findComponent(LocaleSwitch).exists()).toBe(true);
    // 侧栏拖拽把手无障碍标签
    expect(wrapper.find('[role="separator"]').attributes('aria-label')).toBe('调整侧栏宽度');
  });

  it('平台管理员（第 ② 类人：admin 且有工位）：who 带 fde_name（全角括号）', async () => {
    const wrapper = await mountWorkbench(ADMIN_WITH_SEAT);
    expect(wrapper.find('header [data-test="who"]').text()).toBe('root（admin / root）');
    // 管理台入口在 #804 fix-261126-03 里已从用户面整体拆除（谁有 fde_name 都不再给入口）
    expect(wrapper.find('header [data-test="admin-console-link"]').exists()).toBe(false);
  });

  it('who 的无 fde_name 分支（fde 账号缺 fde_name）：只显示 role（全角括号）', async () => {
    const wrapper = await mountWorkbench(FDE_NO_SEAT);
    expect(wrapper.find('header [data-test="who"]').text()).toBe('bob（fde）');
    expect(wrapper.find('header [data-test="admin-console-link"]').exists()).toBe(false);
  });

  it('「↓ 最新」悬浮按钮文案走 i18n（离开底部时出现）', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.find('section > button').exists()).toBe(false);
    await triggerScrollAway(wrapper);
    expect(wrapper.find('section > button').text()).toBe('↓ 最新');
  });

  it('切 English：顶栏 + 嵌套侧栏文案即时变英文（who 改半角括号），并持久化', async () => {
    const wrapper = await mountWorkbench(ADMIN_WITH_SEAT);
    expect(wrapper.find('header [data-test="who"]').text()).toBe('root（admin / root）');

    await switchToEnglish(wrapper);

    expect(wrapper.find('header button').text()).toBe('☰ Navigation');
    expect(wrapper.find('header button').attributes('aria-label')).toBe('Open navigation');
    expect(wrapper.find('header button[title]').attributes('title')).toBe('~/projects/demo (click to copy)');
    // who 改半角括号：用稳定钩子（顶栏 flex 布局在 #808 里调过，class 选择器不再唯一）
    expect(wrapper.find('header [data-test="who"]').text()).toBe('root (admin / root)');
    expect(wrapper.find('header [data-test="admin-console-link"]').exists()).toBe(false);
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

// ---- issue #359（决策 §7 D9）P0b：顶栏收工灯的**接线**（判色与文案在各自 spec，这里只钉"接没接上"）----
describe('顶栏收工灯接线（#359 P0b）', () => {
  const lightCalls = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
      .filter((u) => u.startsWith('/api/git-light'));

  it('选了目录 ⇒ 顶栏出现灯，且打的是 /api/git-light?cwd=<当前目录>', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.find('[data-test="git-light"]').exists()).toBe(true);
    expect(lightCalls()).toEqual(['/api/git-light?cwd=' + encodeURIComponent('~/projects/demo')]);
  });

  it('没选目录 ⇒ 灯不出现，也一个 git-light 请求都不发', async () => {
    const wrapper = await mountWorkbench(FDE_USER, []);
    expect(wrapper.find('[data-test="git-light"]').exists()).toBe(false);
    expect(lightCalls()).toEqual([]);
  });

  it('一个 run 结束（running 从 true 落 false）⇒ 立刻重判——用户刚让 AI 干完活，不能等 30s 轮询', async () => {
    const wrapper = await mountWorkbench();
    const store = useWorkbenchStore();
    const before = lightCalls().length;
    store.es.activeRunId = 'run-1';
    await tick();
    expect(lightCalls().length).toBe(before); // 起跑本身不重判（跑的过程中判了也是脏结果）
    store.es.activeRunId = null;
    await tick();
    expect(lightCalls().length).toBeGreaterThan(before);
    void wrapper;
  });

  it('切目录 ⇒ 先作废旧结论再按新目录发（旧目录的绿不得顶到新目录头上）', async () => {
    const wrapper = await mountWorkbench();
    const store = useWorkbenchStore();
    expect(wrapper.get('[data-test="git-light-label"]').text()).toBe('已收工'); // 夹具是"已收工"
    const before = lightCalls().length;
    // 新目录的请求**故意挂住不回**：这时界面上该看见"没结论"，而不是旧目录的绿
    // （变异取证：把接线里的 `gitLight.reset()` 删掉，这条会红——标签仍是"已收工"）。
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/git-light')) return new Promise<Response>(() => {});
      return jsonResponse({});
    }));
    store.dirCwd = '~/projects/other';
    await tick();
    expect(wrapper.get('[data-test="git-light-label"]').text()).not.toContain('已收工');
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls[urls.length - 1]).toBe('/api/git-light?cwd=' + encodeURIComponent('~/projects/other'));
    void before;
    void wrapper;
  });

  it('「让 AI 收尾」只把话填进输入框，**不发送**（发送 = 一次 run）', async () => {
    const wrapper = await mountWorkbench(FDE_USER, DIRS, {
      ...GIT_LIGHT_GREEN,
      light: 'red', reason: 'untracked',
      repos: [{ rel: 'svc', repo: 'svc', light: 'red', reason: 'untracked', shell: false, branch: 'main',
        no_commits: false, tracked_count: 0, untracked_count: 2, truncated: false, push_state: 'unknown' }],
    });
    const store = useWorkbenchStore();
    await wrapper.get('[data-test="git-light-badge"]').trigger('click');
    await wrapper.get('[data-test="git-light-finish"]').trigger('click');
    const text = store.inputValue;
    expect(text).toContain('svc');
    expect(text.length).toBeGreaterThan(10);
    expect(store.entries.length).toBe(0); // 没往消息流里塞任何东西 = 没发送
  });
});

// ---- issue #282 落点修正：状态条从窗口顶部移到输入框上沿（顶部那行没人看）----
describe('状态条落点：紧贴输入框上方（#282 落点调整）', () => {
  /** 取 <section>（会话区）直系子元素的 class 序列——落点是**结构**问题，只能按兄弟顺序钉。 */
  async function sectionKids(sessionId: string | null) {
    const wrapper = await mountWorkbench();
    const store = useWorkbenchStore();
    store.sessionId = sessionId; // 状态条只在有选中会话时挂载（没有 run 可报）
    await flushPromises();
    const section = wrapper.find('main section');
    expect(section.exists(), '会话区 <section> 必须在').toBe(true);
    return Array.from(section.element.children).map((el) => el.className.toString());
  }

  it('顺序 = 消息流 → 状态条 → composer（状态条夹在两者之间，不再在窗口顶部）', async () => {
    const classes = await sectionKids('s1');
    const stream = classes.findIndex((c) => c.includes('overflow-auto'));
    const status = classes.findIndex((c) => c.includes('run-status-bar'));
    const composer = classes.length - 1; // composer 是会话区最后一个兄弟（modal / 悬浮按钮都是绝对定位的 v-if）
    expect(status, '状态条必须渲染在会话区里').toBeGreaterThan(-1);
    expect(status, '状态条在消息流**下方**').toBe(stream + 1);
    expect(status, '状态条紧贴 composer 上方').toBe(composer - 1);
    // 分隔线方向跟着落点翻转：贴输入框后分隔线在上沿（border-t），不再是压着消息流的 border-b
    const bar = classes[status].split(/\s+/);
    expect(bar).toContain('border-t');
    expect(bar).not.toContain('border-b'); // 整类名比对：`border-black/10` 里含子串 `border-b`，不能用 includes
    expect(bar).toContain('border-black/10');
    // 状态条与输入框读作**一块**：两者之间不得再叠第二条线
    expect(classes[composer].split(/\s+/)).not.toContain('border-t');
  });

  it('无选中会话（状态条不挂）⇒ composer 自己补上沿分隔线，不与流区粘连', async () => {
    const classes = await sectionKids(null);
    expect(classes.some((c) => c.includes('run-status-bar')), '无会话时不挂状态条').toBe(false);
    const composer = classes[classes.length - 1].split(/\s+/);
    expect(composer).toContain('border-t');
    expect(composer).toContain('border-black/10');
  });
});

// ---- issue #428：换账号后首页对话窗口还挂着上一个账号的对话 ----
// 登出是 `auth.logout()` + `router.replace('/login')`：SPA 不重载页面 ⇒ workbench store 这个全局
// 单例跨账号存活。本组用例钉的是**视图接线**（store 侧复位本身在 stores/workbench.spec.ts）：
// ① 挂载第一步按当前登录者认领，身份变了必须先复位；② 登出当场收回归属，不等下一个账号来擦。
describe('#428 换账号时的视图接线', () => {
  // 卫生（#431 评审建议）：本文件在用例里注册 setUserScopeResetListener 且**故意不在组件卸载时注销**
  // （产品语义如此）。单测侧仍要在收尾注销，否则将来同文件新增「不挂载却调 auth.logout()」的用例会被
  // 上一个 pinia 的旧 store listener 干扰（口径同 stores/auth.spec.ts）。
  afterEach(() => setUserScopeResetListener(null));

  const USER_B = {
    id: 'u2', login: 'bob', display_name: 'Bob', role: 'fde', fde_name: 'bob', auth_source: 'local',
  } as AuthUser;

  /** jsdom 的 EventSource 是「一 new 就抛」的桩，openSession 会 connect ⇒ 自己给一个可断言的假类。 */
  class FakeES {
    static instances: FakeES[] = [];
    closed = false;
    listeners = new Map<string, ((e: MessageEvent) => void)[]>();
    constructor(public url: string) { FakeES.instances.push(this); }
    addEventListener(type: string, fn: (e: MessageEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    close() { this.closed = true; }
  }

  /**
   * 挂载一次工作台。**pinia 由调用方建一次、两次挂载共用**——「store 跨账号存活」正是本单的前提，
   * 每次新建 pinia 的装配等于把 bug 一起重建掉，用例会变成空对空。
   */
  async function mountWorkbenchWith(pinia: ReturnType<typeof createPinia>, user: AuthUser) {
    setActivePinia(pinia);
    vi.stubGlobal('EventSource', FakeES);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith('/api/me')) return jsonResponse({ user });
      if (url.startsWith('/api/dirs')) return jsonResponse({ dirs: DIRS });
      if (url.includes('/events/history')) return jsonResponse({ events: [], next_cursor: null });
      if (url.includes('/api/sessions/s1')) {
        return jsonResponse({
          session: { id: 's1', active_run_id: null, message_count: 1 },
          messages: [{ id: 'm1', role: 'user', content: '上一个账号的对话', seq: 1 }],
          last_seq: 1,
        });
      }
      if (url.startsWith('/api/sessions')) return jsonResponse({ items: [] });
      if (url.startsWith('/api/git-light')) return jsonResponse(GIT_LIGHT_GREEN);
      return jsonResponse({});
    }));
    const auth = useAuthStore();
    auth.user = user;
    auth.ready = true;
    const router = createAppRouter(createMemoryHistory());
    router.push('/');
    await router.isReady();
    const wrapper = mount(WorkbenchView, { global: { plugins: [pinia, router, i18n] } });
    await tick();
    return { wrapper, auth, store: useWorkbenchStore(), router };
  }

  it('A 开着会话登出 ⇒ 消息流当场清空、SSE 当场断开（不等下一个账号）', async () => {
    FakeES.instances = [];
    const pinia = createPinia();
    const { wrapper, store } = await mountWorkbenchWith(pinia, FDE_USER);
    await store.openSession('s1');
    expect(store.entries.length, '前置自检：A 的对话已渲染进消息流').toBeGreaterThan(0);
    expect(store.sessionId).toBe('s1');
    const conn = FakeES.instances.at(-1)!;
    expect(conn.closed).toBe(false);

    await wrapper.findAll('header > button').at(-1)!.trigger('click'); // 登出
    await tick();

    expect(store.entries).toEqual([]);
    expect(store.sessionId).toBeNull();
    expect(conn.closed, 'SSE 必须跟着登出断开').toBe(true);
    wrapper.unmount();
  });

  it('换 B 登录重挂载（同一个 pinia）⇒ 看到的是空窗口，不是 A 的对话', async () => {
    const pinia = createPinia();
    const first = await mountWorkbenchWith(pinia, FDE_USER);
    await first.store.openSession('s1');
    first.store.inputValue = 'A 打了一半的话';
    first.wrapper.unmount(); // 直接卸载（不经登出按钮）＝会话过期 / 直接粘 /login 这类**不经过 logout()** 的路径

    const { wrapper, store } = await mountWorkbenchWith(pinia, USER_B);
    expect(store.entries, 'B 不得看见 A 的消息流').toEqual([]);
    expect(store.sessionId).toBeNull();
    expect(store.inputValue, 'A 的草稿不得出现在 B 的输入框').toBe('');
    expect(store.dirCwd, 'B 自己的目录照常加载（复位不是把工作台弄坏）').toBe(DIRS[0].cwd);
    wrapper.unmount();
  });
  it('#431 工作台挂载过之后在**别处**登出（管理台顶栏 / 强制改密屏）同样断流并清空', async () => {
    const pinia = createPinia();
    const first = await mountWorkbenchWith(pinia, FDE_USER);
    await first.store.openSession('s1');
    const conn = FakeES.instances.at(-1)!;
    expect(conn.closed).toBe(false);
    first.wrapper.unmount(); // 去 /admin：工作台卸载，但 SSE 不归它管（没有 onUnmounted 关流）

    // 这就是 AdminLayout.vue 那颗登出按钮做的事——它只调 auth.logout()，不知道 workbench 的存在。
    await first.auth.logout();

    expect(conn.closed, 'SSE 必须跟着登出断掉：会话已死而 EventSource 会自动重连，'
      + '不关就是浏览器后台一直替别人的会话要事件流，挂到标签页关掉为止').toBe(true);
    expect(first.store.entries).toEqual([]);
    expect(first.store.sessionId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// issue #472 片 B（B-15 的另一半）：上传成功 ⇒ 收工灯重判
//   组件侧（DirectoryTree.spec）钉的是「emit files-changed」；这里钉的是「视图真的拿它去 load()」。
//   两侧各钉一半：漏了 emit 组件侧红，漏了接线本文件红。
//   为什么必须重判：上传落一个新文件 = 未跟踪 = 灯该从绿变红（D9「红是进度不是警报」）。
//   不重判就是骗人——灯还说「已收工」，而磁盘上刚多了没跟踪的东西。
// ---------------------------------------------------------------------------
describe('WorkbenchView · 上传后重判收工灯（issue #472）', () => {
  const gitLightCalls = () => vi.mocked(fetch).mock.calls
    .map(([u]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url))
    .filter((u) => u.startsWith('/api/git-light')).length;

  it('侧栏 emit files-changed ⇒ 立刻再发一次 /api/git-light（不是等 30s 轮询）', async () => {
    const wrapper = await mountWorkbench();
    const before = gitLightCalls();
    expect(before, '挂载时至少拉过一次灯').toBeGreaterThanOrEqual(1);

    wrapper.findComponent(SidebarPanel).vm.$emit('files-changed');
    await tick();

    expect(gitLightCalls()).toBe(before + 1);
  });

  it('反向守卫：没有任何 files-changed 时，灯不会被凭空多发（判据不是「只要变多就算过」）', async () => {
    await mountWorkbench();
    const before = gitLightCalls();
    await tick();
    expect(gitLightCalls()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// issue #614：顶栏用户级 MacroMenu 的 chip 以前没人接 `@open-runs` ⇒ 点了静默丢弃。
//   这里钉：点了顶栏 chip ⇒ 用户级流水抽屉真打开，且拉的是 `/api/macro-runs`（不是会话级）。
//   DOM 断言（不用 w.emitted()，NODE_ENV=production 下恒空）。
// ---------------------------------------------------------------------------
describe('WorkbenchView · 顶栏用户级 chip 开抽屉（issue #614）', () => {
  const USER_TPL = {
    id: 't-daily', kind: 'scheduled-task', name: '每日 9 点 · 用户级', params: {}, scope: 'user', audience: 'all',
  };

  const fetchUrls = () => vi.mocked(fetch).mock.calls
    .map(([u]) => (typeof u === 'string' ? u : u instanceof URL ? u.href : u.url));

  it('没选会话时点顶栏 chip ⇒ 抽屉仍打开，卡片出现用户级模板名，且请求 /api/macro-runs', async () => {
    const wrapper = await mountWorkbench(FDE_USER, DIRS, GIT_LIGHT_GREEN, { items: [USER_TPL] });
    // 默认挂载未选会话（会话列表空）——旧代码此时 openMacroDrawer 直接 return，点了没反应
    expect(useWorkbenchStore().sessionId).toBeFalsy();

    const topChip = wrapper.find('[data-test="macro-menu"][data-scope="user"] [data-test="macro-chip"]');
    expect(topChip.exists()).toBe(true);
    await topChip.trigger('click');
    await flushPromises();

    expect(wrapper.find('[data-test="macro-drawer"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('每日 9 点 · 用户级');
    // 走的是用户级全局端点，不是会话级（没会话也没有 /api/sessions/.../macro-runs）
    expect(fetchUrls().some((u) => u.startsWith('/api/macro-runs'))).toBe(true);
    expect(fetchUrls().some((u) => /\/macro-runs$/.test(u.split('?')[0]) && u.includes('/sessions/'))).toBe(false);
  });

  it('反向：会话级 chip 不存在时（无会话）顶栏那颗仍是用户级、仍接了 open-runs', async () => {
    // 无会话 ⇒ 会话头那份 MacroMenu 不渲染（v-if store.sessionId），只剩顶栏用户级那颗
    const wrapper = await mountWorkbench(FDE_USER, DIRS, GIT_LIGHT_GREEN, { items: [USER_TPL] });
    const chips = wrapper.findAll('[data-test="macro-menu"]');
    expect(chips).toHaveLength(1);
    expect(chips[0].attributes('data-scope')).toBe('user');
  });
});

// ===========================================================================
// issue #808：顶栏「账周期 + 本周期用量」徽标 + 明细弹窗。
// ===========================================================================
describe('issue #808：顶栏账周期/用量徽标', () => {
  const QUOTA_PERIOD = {
    quota: {
      budget_usd: 10, budget_period: '1mo', max_budget: 10, budget_duration: '1mo',
      budget_reset_at: '2026-12-01T00:00:00Z', spend: 2.05, remaining: 7.95, spend_scope: 'period',
    },
    reason: null,
  };
  const USAGE_30 = {
    days: [
      { date: '2026-11-28', spend: 0.4, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1 },
      { date: '2026-11-29', spend: 1.65, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, api_requests: 1 },
    ],
    totals: { spend: 2.05, total_tokens: 4 },
  };

  it('no_binding（默认）：徽标整块不渲染', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.find('[data-test="usage-badge"]').exists()).toBe(false);
  });

  it('有额度：徽标文案正确（月 + $2.05）、且在登出之前；点开弹窗有进度/剩余/清零与 30 天 chart 区', async () => {
    const wrapper = await mountWorkbench(FDE_USER, DIRS, GIT_LIGHT_GREEN, { items: [] }, QUOTA_PERIOD, USAGE_30);
    const badge = wrapper.find('[data-test="usage-badge"]');
    expect(badge.exists()).toBe(true);
    expect(badge.text()).toContain('月');
    expect(badge.text()).toContain('$2.05');
    // 徽标是 header > button，且「登出」仍是最后一颗
    expect(wrapper.findAll('header > button').at(-1)!.text()).toBe('登出');

    await badge.trigger('click');
    await tick();
    expect(wrapper.find('[data-test="usage-used"]').text()).toContain('已用 $2.05');
    expect(wrapper.find('[data-test="usage-progress"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="usage-remaining"]').text()).toContain('$7.95');
    expect(wrapper.find('[data-test="usage-reset"]').text()).toContain('清零');
    // chart 区在（有数据 ⇒ svg 对阅读器可见）
    expect(wrapper.find('[data-test="metric-chart"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="metric-chart-svg"]').attributes('aria-hidden')).toBe('false');
  });
});

// ===========================================================================
// issue #816 第③⑥步：折叠常驻条 + 展开面板 + 右侧竖串（数据源 = store.sessionFolds）。
// 断言只认 DOM（`data-test` 选择器），不用 `w.emitted()`（NODE_ENV=production 下恒空 ⇒ 假红）。
// 竖串位置只认 `style` 里的 `top: N%`——它是纯数学 `to / max(lastRound, maxTo)` 的产物，
// 本文件里没有任何布局可量（jsdom 也没有），所以这些数字是可以直接逐字钉的。
// ===========================================================================
describe('WorkbenchView · 折叠常驻条 / 展开面板 / 右侧竖串（issue #816）', () => {
  /** 真机形状（dev 库实测：前 5 条 mechanical、最后 1 条 semantic；这里取 4 条代表四种口径）。 */
  const FOLDS: FoldEntry[] = [
    {
      round: 12,
      from: 1,
      to: 6,
      rounds: 6,
      origin: 'mechanical',
      // 实测 mechanical 的 title 就是把范围又念一遍的模板句 ⇒ 行内不许出现它
      title: '早期第 1–6 轮（共 6 轮）已折叠。工具足迹：readFile×40 / shell×1。需要原文请重读文件…',
      toolCalls: [
        ...Array.from({ length: 40 }, () => ({ name: 'readFile' })),
        { name: 'shell' },
        { name: 'writeFile' },
      ],
    },
    { round: 18, from: 7, to: 12, rounds: 6, origin: 'mechanical', title: '早期第 7–12 轮（共 6 轮）已折叠。' },
    { round: 24, from: 13, to: 17, rounds: 5, origin: 'semantic', title: '## 调研 store 层与投影边界' },
    { round: 30, from: 18, to: 21, rounds: 4, origin: 'semantic', title: '## 阶段', truncated: true },
  ];

  /** 挂载后把折叠索引塞进 store（真实路径是 openSession/refreshSession 里 normalize 出来的）。 */
  async function mountWithFolds(folds: FoldEntry[] = FOLDS) {
    const wrapper = await mountWorkbench();
    const store = useWorkbenchStore();
    store.sessionId = 's1'; // 竖串与常驻条都只读 sessionFolds，但会话区其它面按有会话装配
    store.sessionFolds = folds;
    await flushPromises();
    return { wrapper, store };
  }

  /** 读节点 `style` 里的 `top: N%`（竖串定位的唯一落点）。 */
  function topPcts(wrapper: Awaited<ReturnType<typeof mountWorkbench>>): number[] {
    return wrapper.findAll('[data-test="fold-node"]').map((node) => {
      const match = /top:\s*([\d.]+)%/.exec(node.attributes('style') ?? '');
      expect(match, `节点没有 top：${node.attributes('style')}`).not.toBeNull();
      return Number(match![1]);
    });
  }

  it('无折叠（sessionFolds = []）⇒ 常驻条 / 面板 / 竖串一个字节都不出', async () => {
    const wrapper = await mountWorkbench(); // 默认没有任何 folds
    expect(wrapper.find('[data-test="fold-bar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="fold-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="fold-rail"]').exists()).toBe(false);
  });

  it('有折叠 ⇒ 常驻条出现；最新那条没有可读标题 ⇒ 只说「已折叠 N 轮」，不再把范围重念一遍（#816②）', async () => {
    const { wrapper } = await mountWithFolds();
    // 真机 bug：`🗜 Folded 22 rounds · 第 22 轮` —— `22 rounds` 与范围说的是同一件事。
    // 末条是 semantic `## 阶段`（剥完 2 字 ⇒ foldHeadline 给 null）⇒ 走 summaryBare。
    const bar = wrapper.get('[data-test="fold-bar"]').text();
    expect(wrapper.get('[data-test="fold-bar-text"]').text()).toBe('🗜 已折叠 21 轮');
    expect(bar).not.toContain('·'); // 去重：没有可说的标题就不拼「 · …」
    expect(bar).not.toContain('第 18–21 轮');
    expect(bar).toContain('▸'); // 收起态的箭头（展开后换 ▾）
    expect(bar).not.toContain('已折叠。'); // mechanical 的模板句不在这行里
    expect(wrapper.get('[data-test="fold-bar"]').attributes('aria-expanded')).toBe('false');
  });

  it('常驻条：最新那条**有**可读标题 ⇒ 才拼「 · {headline}」（summary 带 {headline} 的分支不是死代码）', async () => {
    const { wrapper } = await mountWithFolds([
      { round: 24, from: 22, to: 22, rounds: 1, origin: 'semantic', title: '## 调研 store 层与投影边界' },
    ]);
    expect(wrapper.get('[data-test="fold-bar-text"]').text()).toBe('🗜 已折叠 22 轮 · 调研 store 层与投影边界');
  });

  it('常驻条去重的第二道闸：标题正好与范围同字 ⇒ 也不拼第二遍，面板行也不画 headline', async () => {
    const { wrapper } = await mountWithFolds([
      { round: 21, from: 18, to: 21, rounds: 4, origin: 'semantic', title: '第 18–21 轮' },
    ]);
    expect(wrapper.get('[data-test="fold-bar-text"]').text()).toBe('🗜 已折叠 21 轮');
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.find('[data-test="fold-row-headline"]').exists()).toBe(false);
  });

  it('点常驻条 ⇒ 面板展开、行数 = 折叠数；再点收起（面板整个从 DOM 摘掉）', async () => {
    const { wrapper } = await mountWithFolds();
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    const rows = wrapper.findAll('[data-test="fold-row"]');
    expect(rows).toHaveLength(FOLDS.length);
    expect(wrapper.get('[data-test="fold-bar"]').attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('[data-test="fold-panel"]').text()).toContain('全部折叠（4 条）');
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.find('[data-test="fold-panel"]').exists()).toBe(false);
  });

  it('面板逐行：范围 + 足迹；mechanical 行内不出现它的 title；semantic 长 title 剥掉 `##`，短 title 不出现', async () => {
    const { wrapper } = await mountWithFolds();
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    const rows = wrapper.findAll('[data-test="fold-row"]');
    // 第 1 行 mechanical：范围 + 足迹聚合，title 的模板句一个字都不许漏进界面
    expect(rows[0].get('[data-test="fold-row-range"]').text()).toBe('第 1–6 轮');
    expect(rows[0].get('[data-test="fold-row-footprint"]').text()).toBe('readFile×40 / shell×1 / writeFile×1');
    expect(rows[0].text()).not.toContain('已折叠。');
    expect(rows[0].find('[data-test="fold-row-headline"]').exists()).toBe(false);
    // 第 2 行 mechanical：没有 toolCalls ⇒ 连足迹这一格都不画（不是空 span）
    // #816④a 之后行尾多一个「查看原文」按钮 ⇒ 改按「行内到底有几格文字」逐字钉（仍不许长出别的格）
    expect(rows[1].findAll('span').map((s) => s.text())).toEqual(['第 7–12 轮']);
    expect(rows[1].find('[data-test="fold-row-footprint"]').exists()).toBe(false);
    // 第 3 行 semantic 长 title ⇒ 剥 markdown 前缀后原样给（不带 `#`）
    expect(rows[2].get('[data-test="fold-row-range"]').text()).toBe('第 13–17 轮');
    expect(rows[2].get('[data-test="fold-row-headline"]').text()).toBe('调研 store 层与投影边界');
    expect(rows[2].text()).not.toContain('##');
    // 第 4 行 semantic `## 阶段`（剥完 2 字）⇒ 退回范围 + truncated 标注
    expect(rows[3].find('[data-test="fold-row-headline"]').exists()).toBe(false);
    expect(rows[3].text()).toContain('第 18–21 轮');
    expect(rows[3].get('[data-test="fold-row-truncated"]').text()).toBe('（摘要被夹断）');
  });

  // issue #816 第④步a：面板行也要能「查看原文」——渲染与旧横幅**同一个组件**（FoldOriginalTurns，单一实现）。
  // 断言只认 DOM（`data-test` / 组件类名）与真 fetch，不用 `w.emitted()`。
  it('面板行「查看原文」：点下去才懒加载并在该行下方渲染原文；再点收起且**不清缓存**（#816④a）', async () => {
    const { wrapper, store } = await mountWithFolds();
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    // 每行一颉按钮（四条折叠的 round 都是安全整数），但**没点过就一个字节都不出**
    expect(wrapper.findAll('[data-test="fold-row-original"]')).toHaveLength(FOLDS.length);
    expect(wrapper.find('.folded-original-turn').exists()).toBe(false);
    expect(wrapper.find('.folded-original-missing').exists()).toBe(false);
    const baseFetch = globalThis.fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;
    const foldedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/folded/')) {
        foldedUrls.push(url);
        return jsonResponse({ round: 12, turns: [{ role: 'user', text: '第 12 轮原文' }] });
      }
      return baseFetch(input);
    }));
    const btns = () => wrapper.findAll('[data-test="fold-row-original"]');
    await btns()[0].trigger('click');
    await tick();
    expect(foldedUrls).toHaveLength(1);
    expect(foldedUrls[0]).toContain('/api/sessions/s1/folded/12'); // 查询键 = **落账轮号**（不是 from/to 范围）
    const turn = wrapper.get('.folded-original-turn');
    expect(turn.text()).toContain('第 12 轮原文');
    expect(turn.get('.folded-original-role').text()).toBe('用户');
    // 再点一次 = 收起（原文整块从 DOM 摘掉），但缓存**不删**（与旧横幅 #388 同口径）
    await btns()[0].trigger('click');
    expect(wrapper.find('.folded-original-turn').exists()).toBe(false);
    expect(store.getFoldedOriginal('s1', 12)?.status).toBe('loaded');
    // 再展开 ⇒ 命中缓存，**不重发**（总次数恒为 1）
    await btns()[0].trigger('click');
    await tick();
    expect(wrapper.find('.folded-original-turn').exists()).toBe(true);
    expect(foldedUrls).toHaveLength(1);
  });

  it('折叠的 round 不是安全整数（或根本没有）⇒ 该行**没有**「查看原文」按钮（拿范围去查必然 404）', async () => {
    const { wrapper } = await mountWithFolds([
      { from: 1, to: 6, rounds: 6, origin: 'mechanical' },
      { round: 2.5, from: 7, to: 12, rounds: 6, origin: 'mechanical' },
      { round: Number.MAX_SAFE_INTEGER + 2, from: 13, to: 17, rounds: 5, origin: 'semantic', title: '## 调研' },
    ]);
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.findAll('[data-test="fold-row"]')).toHaveLength(3);
    expect(wrapper.findAll('[data-test="fold-row-original"]')).toHaveLength(0);
    // 面板文本里也不许出现这个词（按钮不是靠 CSS 隐着的）
    expect(wrapper.get('[data-test="fold-panel"]').text()).not.toContain('查看原文');
  });

  it('竖串：节点数 = 折叠数、恰有一颗实心 active（最新那条）、顺序与 `to` 跟着后端（from 升序）', async () => {
    const { wrapper } = await mountWithFolds();
    const nodes = wrapper.findAll('[data-test="fold-node"]');
    expect(nodes).toHaveLength(FOLDS.length);
    expect(nodes.map((n) => n.attributes('data-fold-to'))).toEqual(['6', '12', '17', '21']);
    expect(wrapper.findAll('[data-test="fold-node-active"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="fold-node-active"]').attributes('data-test')).toBe('fold-node-active');
    expect(nodes.at(-1)!.attributes('data-active')).toBe('true');
    expect(nodes[0].attributes('data-active')).toBe('false');
    // 移动端（<768px）整条竖串隐藏：类名里同时有 hidden 与 md:block（jsdom 无媒体查询，只钉结构）
    const railClasses = wrapper.get('[data-test="fold-rail"]').classes();
    expect(railClasses).toContain('hidden');
    expect(railClasses).toContain('md:block');
  });

  // #816 评审缺陷②：契约只保证 `from` 升序，**没**保证区间不重叠 / `to` 单调
  // ⇒ 「竖串末项」不等于「覆盖最远那条」，active 不能按 `i === length - 1` 给。
  it('重叠区间（末项被包住）⇒ active 落在 **to 最大**那条，不是 `from` 升序的末项', async () => {
    const { wrapper } = await mountWithFolds([
      { round: 5, from: 1, to: 20, rounds: 20, origin: 'mechanical' },
      { round: 9, from: 10, to: 15, rounds: 6, origin: 'semantic', title: '## 中途一次小折叠' },
    ]);
    const nodes = wrapper.findAll('[data-test="fold-node"]');
    expect(nodes.map((n) => n.attributes('data-fold-to'))).toEqual(['20', '15']);
    // 实心恰好一颗（同 to 多条也只标第一个命中的）
    expect(wrapper.findAll('[data-test="fold-node-active"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="fold-node-idle"]')).toHaveLength(1);
    // data-test 在圆点 span 上 ⇒ 沿父级 `fold-node` 读它覆盖到哪一轮
    const active = wrapper.get('[data-test="fold-node-active"]').element.parentElement as HTMLElement;
    expect(active.getAttribute('data-fold-to'), 'active 必须是覆盖到 20 那条').toBe('20');
    expect(nodes[0].attributes('data-active')).toBe('true');
    expect(nodes[1].attributes('data-active')).toBe('false');
    // 常驻条那个数跟着一起修：也是 max(to)，不是末项的 15
    expect(wrapper.get('[data-test="fold-bar-text"]').text()).toBe('🗜 已折叠 20 轮');
  });

  // #816 评审缺陷①：面板是 `streamEl` 的**兄弟**（`shrink-0`）⇒ 展开只改可视高度、**不产生滚动事件**，
  // 贴底的用户会被顶出视口且 `↓ 最新` 也不会亮 ⇒ 开关面板后必须主动复算一次。
  it('贴底时展开面板 ⇒ 面板抢走高度后仍重新贴底（没有滚动事件也要复算）', async () => {
    const { wrapper } = await mountWithFolds();
    // 面板未展开 ⇒ 第一个 `section > div` 就是 `streamEl`（refs 在展开前抓住，展开后该选择器会先命中面板）
    const el = wrapper.find('section > div').element as HTMLElement;
    // jsdom 无布局：只桩三个几何量（scrollHeight/clientHeight 只读 ⇒ defineProperty；scrollTop 直接赋）
    Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 300, configurable: true });
    el.scrollTop = 700; // 贴底（gap = 1000 - 700 - 300 = 0）⇒ autoFollow 仍为 true
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="fold-panel"]').exists(), '面板真的展开了').toBe(true);
    expect(el.scrollTop, '展开面板后必须把流重新贴底').toBe(el.scrollHeight);
  });

  it('竖串定位是纯数学：lastRound 拿不到 ⇒ 末条落在 100%；compaction.lastRound=40 ⇒ 整串按 40 轮压上去', async () => {
    const { wrapper, store } = await mountWithFolds();
    expect(topPcts(wrapper)).toEqual([28.6, 57.1, 81, 100]); // to / maxTo(21)
    store.sessionCompaction = normalizeSessionCompaction({
      rounds: 6, tokensSaved: 1, lastRound: 40, layers: { ttl: { triggered: 1, tokensSaved: 1 } },
    });
    await flushPromises();
    expect(topPcts(wrapper)).toEqual([15, 30, 42.5, 52.5]); // to / max(40, 21)
    expect(topPcts(wrapper).every((pct, i, all) => i === 0 || pct >= all[i - 1])).toBe(true);
  });

  it('hover 卡（CSS group-hover，不跟随鼠标）：范围 / headline（与范围不同才给）/ 足迹 / 夹断标注', async () => {
    const { wrapper } = await mountWithFolds();
    const tips = wrapper.findAll('[data-test="fold-tip"]');
    expect(tips).toHaveLength(FOLDS.length);
    // mechanical：只有范围 + 足迹，没有 headline（那半句与范围相同 ⇒ 不重复一遍）
    expect(tips[0].text()).toContain('第 1–6 轮');
    expect(tips[0].text()).toContain('readFile×40 / shell×1 / writeFile×1');
    expect(tips[0].find('[data-test="fold-tip-headline"]').exists()).toBe(false);
    // semantic 长 title ⇒ headline 在；truncated ⇒ 夹断标注在
    expect(tips[2].get('[data-test="fold-tip-headline"]').text()).toBe('调研 store 层与投影边界');
    expect(tips[3].get('[data-test="fold-tip-truncated"]').text()).toBe('（摘要被夹断）');
  });

  it('点竖串节点 ⇒ 打开面板并滚到那一行（scrollIntoView({block:"nearest"})；跳到流里对应位置是第④步）', async () => {
    const original = Element.prototype.scrollIntoView;
    const spy = vi.fn();
    Element.prototype.scrollIntoView = spy as unknown as typeof original;
    try {
      const { wrapper } = await mountWithFolds();
      expect(wrapper.find('[data-test="fold-panel"]').exists()).toBe(false);
      await wrapper.findAll('[data-test="fold-node"]')[2].trigger('click');
      await flushPromises();
      expect(wrapper.find('[data-test="fold-panel"]').exists(), '点节点要顺手把面板打开').toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('换会话 ⇒ 展开面板复位（不把上一个会话的展开态留给下一个会话）', async () => {
    const { wrapper, store } = await mountWithFolds();
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.find('[data-test="fold-panel"]').exists()).toBe(true);
    store.sessionId = 's2';
    await flushPromises();
    expect(wrapper.find('[data-test="fold-panel"]').exists()).toBe(false);
  });

  // ---- #816①：范围文本来自 i18n，不是 lib 里的中文字面量（真机 `html lang=en` 下拼出了中英混排）----
  /** 中日韩汉字 + 全角标点（后端**数据**里的中文 title 不在断言范围内，所以它只用在固定几格上）。 */
  const CJK = /[\u3400-\u9fff\u3000-\u303f\uff01-\uff60]/;

  it('en 语言下范围 / 常驻条 / 面板 / 竖串卡不得出现中文（以前是 `Folded 22 rounds · 第 22 轮`）', async () => {
    const { wrapper } = await mountWithFolds();
    await switchToEnglish(wrapper);
    expect(document.documentElement.lang).toBe('en');
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    // 常驻条：英文外壳 + 去重（末条无标题 ⇒ 不拼范围）
    const barText = wrapper.get('[data-test="fold-bar-text"]').text();
    expect(barText).toBe('🗜 Folded 21 rounds');
    expect(barText).not.toMatch(CJK);
    // 面板：标题行 / 四行范围 / 夹断标注全英文
    expect(wrapper.get('[data-test="fold-panel"]').text()).toContain('All folds (4)');
    expect(wrapper.findAll('[data-test="fold-row-range"]').map((row) => row.text()))
      .toEqual(['rounds 1–6', 'rounds 7–12', 'rounds 13–17', 'rounds 18–21']);
    expect(wrapper.findAll('[data-test="fold-row-truncated"]').at(-1)!.text()).toBe('(summary clipped)');
    // 竖串卡（mechanical 那张只有范围 + 足迹 ⇒ 整张卡不得带一个中文字）
    const tip = wrapper.findAll('[data-test="fold-tip"]')[0];
    expect(tip.text()).toContain('rounds 1–6');
    expect(tip.text()).not.toMatch(CJK);
    // 唯一允许出现中文的地方 = 后端数据本身（semantic 的中文 title 当 headline）
    expect(wrapper.findAll('[data-test="fold-row-headline"]')[0].text()).toBe('调研 store 层与投影边界');
  });

  it('en：single / tail / unknown 三种范围各有英文写法（单轮不写 `rounds 22–22`）', async () => {
    const { wrapper } = await mountWithFolds([
      { from: 22, to: 22 }, { to: 12 } as FoldEntry, {} as FoldEntry,
    ]);
    await switchToEnglish(wrapper);
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.findAll('[data-test="fold-row-range"]').map((row) => row.text()))
      .toEqual(['round 22', 'through round 12', 'earlier rounds']);
  });

  it('zh：同三种范围仍是原来的中文写法（文案搬进 i18n 后零漂移）', async () => {
    const { wrapper } = await mountWithFolds([
      { from: 22, to: 22 }, { to: 12 } as FoldEntry, {} as FoldEntry,
    ]);
    await wrapper.get('[data-test="fold-bar"]').trigger('click');
    expect(wrapper.findAll('[data-test="fold-row-range"]').map((row) => row.text()))
      .toEqual(['第 22 轮', '到第 12 轮', '更早的轮次']);
  });
});
