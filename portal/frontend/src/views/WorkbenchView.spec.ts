// WorkbenchView 顶栏 i18n 单测（issue #101 P2）：
//   ① zh-CN 基线：顶栏文案（☰ 导航 / cwd 徽标 title / who 拼接 / 管理台 / 登出 / ↓ 最新）与
//      aria-label（打开导航 / 调整侧栏宽度）走 i18n 后取值逐字不变；
//   ② 顶栏语言切换菜单（LocaleSwitch）挂载在管理台/登出旁；切 English 后顶栏（含嵌套的侧栏
//      子组件）文案即时变英文，who 拼接改半角括号。
// 约定（照 LoginView.spec 先例）：装配真实 i18n 单例，不 mock t()；每例 localStorage.clear() + setLocale('zh-CN')。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import WorkbenchView from './WorkbenchView.vue';
import LocaleSwitch from '../components/LocaleSwitch.vue';
import { createAppRouter } from '../router';
import { useAuthStore, type AuthUser } from '../stores/auth';
import { i18n, setLocale } from '../i18n';

const FDE_USER = {
  id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local',
} as AuthUser;
const ADMIN_USER = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local',
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

  it('平台管理员：顶栏「管理台」入口；who 无 fde_name 时只显示 role（全角括号）', async () => {
    const wrapper = await mountWorkbench(ADMIN_USER);
    expect(wrapper.find('header span.flex-1').text()).toBe('root（admin）');
    expect(wrapper.find('header a[href="/admin"]').text()).toBe('管理台');
  });

  it('「↓ 最新」悬浮按钮文案走 i18n（离开底部时出现）', async () => {
    const wrapper = await mountWorkbench();
    expect(wrapper.find('section > button').exists()).toBe(false);
    await triggerScrollAway(wrapper);
    expect(wrapper.find('section > button').text()).toBe('↓ 最新');
  });

  it('切 English：顶栏 + 嵌套侧栏文案即时变英文（who 改半角括号），并持久化', async () => {
    const wrapper = await mountWorkbench(ADMIN_USER);
    expect(wrapper.find('header span.flex-1').text()).toBe('root（admin）');

    await switchToEnglish(wrapper);

    expect(wrapper.find('header button').text()).toBe('☰ Navigation');
    expect(wrapper.find('header button').attributes('aria-label')).toBe('Open navigation');
    expect(wrapper.find('header button[title]').attributes('title')).toBe('~/projects/demo (click to copy)');
    expect(wrapper.find('header span.flex-1').text()).toBe('root (admin)');
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
