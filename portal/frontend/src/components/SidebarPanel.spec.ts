// SidebarPanel 单测（issue #92）：aside 内 flex-col 三段布局结构断言——
//   ① 固定头（shrink-0：DirSelect + ＋新会话按钮，不随列表滚动）
//   ② 会话列表段（flex-1 min-h-0 overflow-y-auto，独立内部滚动；空态文案在此段内）
//   ③ 目录树面板（DirectoryTree，固定底部、恒可达，shrink-0 透传到其根元素）
// 另覆盖：空态文案（「先创建目录」/「暂无会话」/平台管理员提示）、会话点击 emit 语义保持。
// store 状态直填、fetch 桩掉（不碰真实后端）；路由用 memory-history 的真实 router（router-link 渲染需要）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import SidebarPanel from './SidebarPanel.vue';
import SessionPickerModal from './SessionPickerModal.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench';
import type { DirInfo, Session } from '../stores/workbench';

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

async function mountPanel(
  opts: { dirs?: DirInfo[]; sessions?: Session[]; noDir?: boolean; platformAdmin?: boolean } = {},
  attrs: Record<string, unknown> = {},
) {
  const store = useWorkbenchStore();
  store.dirs = opts.dirs ?? [];
  store.dirCwd = opts.dirs?.[0]?.cwd ?? null;
  store.sessions = opts.sessions ?? [];
  store.noDir = opts.noDir ?? false;
  if (opts.platformAdmin) store.isPlatformAdmin = true;
  useAuthStore().user = opts.platformAdmin
    ? { id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local' }
    : { id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local' };
  const router = createAppRouter(createMemoryHistory());
  router.push('/');
  await router.isReady();
  const wrapper = mount(SidebarPanel, { global: { plugins: [router] }, attrs });
  await flushPromises();
  return wrapper;
}

// 三段定位助手：根容器 → 固定头 div（第 1 子）/ 列表段 div（第 2 子）/ DirectoryTree 根（末子）
function paneEls(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  const root = wrapper.element as HTMLElement; // 组件根 div（单根节点）
  const kids = Array.from(root.children) as HTMLElement[];
  return { root, kids, head: kids[0], list: kids[1], tree: kids[kids.length - 1] };
}

describe('SidebarPanel · 三段布局（issue #92）', () => {
  it('根元素为 flex-col 容器：h-full + min-h-0，三段按 固定头→列表→树 顺序排列', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    const { root, kids, tree } = paneEls(wrapper);
    expect(root.classList).toContain('flex');
    expect(root.classList).toContain('flex-col');
    expect(root.classList).toContain('h-full');
    expect(root.classList).toContain('min-h-0');
    expect(kids).toHaveLength(3); // 固定头 div + 列表段 div + DirectoryTree
    expect(tree.classList).toContain('mt-3'); // DirectoryTree 根自带上分隔线边距（确认末子是树面板）
    expect(tree.textContent).toContain('目录树');
  });

  it('固定头 shrink-0：含目录下拉（DirSelect）与「＋ 新会话」按钮', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    const { head } = paneEls(wrapper);
    expect(head.classList).toContain('shrink-0');
    expect(head.querySelector('select')).not.toBeNull(); // DirSelect 的目录下拉
    const newSess = Array.from(head.querySelectorAll('button')).find((b) => b.textContent?.includes('＋ 新会话'));
    expect(newSess).toBeDefined();
  });

  it('会话列表段：flex-1 + min-h-0 + overflow-y-auto，独立内部滚动', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
      sessions: [{ id: '1', title: 's1' }, { id: '2', title: 's2' }],
    });
    const { list } = paneEls(wrapper);
    expect(list.classList).toContain('flex-1');
    expect(list.classList).toContain('min-h-0');
    expect(list.classList).toContain('overflow-y-auto');
    expect(list.textContent).toContain('s1');
    expect(list.textContent).toContain('s2');
  });

  it('空态文案随列表段：「先创建目录」/「暂无会话」/平台管理员提示都在滚动段内', async () => {
    // 无目录普通用户：「先创建目录」
    const w1 = await mountPanel({ noDir: true });
    const { list: l1, head: h1 } = paneEls(w1);
    expect(l1.textContent).toContain('先创建目录');
    expect(h1.textContent).not.toContain('先创建目录');

    // 无目录平台管理员：管理台提示（含「进入管理台」链接）
    const w2 = await mountPanel({ noDir: true, platformAdmin: true });
    const { list: l2 } = paneEls(w2);
    expect(l2.textContent).toContain('平台管理员：请到管理台创建 FDE 用户与分配资源');
    const adminLink = Array.from(l2.querySelectorAll('a')).find((a) => a.textContent === '进入管理台');
    expect(adminLink).toBeDefined();
    expect(adminLink!.getAttribute('href')).toContain('/admin');

    // 有目录无会话：「暂无会话」
    const w3 = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    expect(paneEls(w3).list.textContent).toContain('暂无会话');
  });

  it('目录树面板固定底部：末子元素 + shrink-0（透传合并到 DirectoryTree 根元素）', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
      sessions: Array.from({ length: 15 }, (_, i) => ({ id: String(i), title: `s${i}` })), // 15 条也不改变结构
    });
    const { root, kids, tree } = paneEls(wrapper);
    expect(root.lastElementChild).toBe(tree);
    expect(tree.classList).toContain('shrink-0');
    expect(tree.classList).toContain('border-t'); // 树面板与列表段之间的分隔线（原样式保持）
    expect(kids[1].querySelectorAll('div.mt-2').length).toBe(15); // 会话卡全在列表段内
  });

  it('目录树面板限高 + 内部滚动：根元素含 max-h-[40vh] 与 overflow-y-auto（保留 shrink-0/mt-3/border-t）', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    const { tree } = paneEls(wrapper);
    expect(tree.classList).toContain('max-h-[40vh]');
    expect(tree.classList).toContain('overflow-y-auto');
    expect(tree.classList).toContain('shrink-0'); // 原透传类保留
    expect(tree.classList).toContain('mt-3'); // 自带分隔边距保留
    expect(tree.classList).toContain('border-t');
  });

  it('会话点击语义保持：emit select-session（session id）', async () => {
    const onSelectSession = vi.fn();
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
      sessions: [{ id: '42', title: '目标会话' }],
    }, { onSelectSession });
    const { list } = paneEls(wrapper);
    const card = Array.from(list.querySelectorAll('div.cursor-pointer')).find((d) => d.textContent?.includes('目标会话'));
    expect(card).toBeDefined();
    card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(onSelectSession).toHaveBeenCalledWith('42');
  });
});

// ---------------------------------------------------------------------------
// issue #94：会话选择入口——① 列表尾「查看全部 →」（仅 sessionsNextCursor 存在）② 固定头 🔍
// ---------------------------------------------------------------------------
describe('SidebarPanel · issue #94 会话选择入口', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  it('入口①：sessionsNextCursor 为 null → 列表尾不渲染「查看全部」相关文案', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] });
    expect(wrapper.text()).not.toContain('查看全部会话');
    expect(wrapper.text()).not.toContain('显示最近 20 个');
  });

  it('入口①：sessionsNextCursor 存在 → 渲染「显示最近 20 个」+「查看全部会话 →」，点击打开 modal（scope=cwd），选中后关闭并回传 select-session', async () => {
    const onSelectSession = vi.fn();
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] }, { onSelectSession });
    const store = useWorkbenchStore();
    store.sessionsNextCursor = 'cursor-x'; // 截断：还有未展示的会话
    await flushPromises();
    expect(wrapper.text()).toContain('显示最近 20 个');
    // modal 数据源：一条可点选的结果行
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [{ id: '99', title: '目标会话', cwd: '~/projects/a', updated_at: new Date().toISOString(), active_run_id: null }],
      next_cursor: null, total: 1,
    }), { status: 200 })));
    await wrapper.findAll('button').find((b) => b.text() === '查看全部会话 →')!.trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 20)); // composable 首屏 setTimeout(0)
    await flushPromises();
    const modal = wrapper.findComponent(SessionPickerModal);
    expect(modal.exists()).toBe(true);
    expect(modal.props('scope')).toBe('cwd');
    expect(modal.props('cwd')).toBe('~/projects/a');
    await modal.find('li[role="option"]').trigger('click');
    await flushPromises();
    expect(onSelectSession).toHaveBeenCalledWith('99'); // 复用视图层深链逻辑
    expect(wrapper.findComponent(SessionPickerModal).exists()).toBe(false); // modal 已关闭
  });

  it('入口②：固定头 🔍 恒可见；有目录时 scope=cwd、无目录时 scope=all', async () => {
    const w1 = await mountPanel({ dirs: DIR });
    const btn1 = w1.find('button[aria-label="查找会话"]');
    expect(btn1.exists()).toBe(true);
    await btn1.trigger('click');
    expect(w1.findComponent(SessionPickerModal).props('scope')).toBe('cwd');

    const w2 = await mountPanel({ noDir: true });
    const btn2 = w2.find('button[aria-label="查找会话"]');
    expect(btn2.exists()).toBe(true); // 无目录也恒可见
    await btn2.trigger('click');
    expect(w2.findComponent(SessionPickerModal).props('scope')).toBe('all');
  });
});

// ---------------------------------------------------------------------------
// issue #94：「当前会话」置顶卡——深链打开的会话不在侧栏列表时给上下文（重开语义同 #55 B4）
// ---------------------------------------------------------------------------
describe('SidebarPanel · issue #94 「当前会话」置顶卡', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  it('sessionId 在列表中 → 无置顶卡（列表卡自身以选中态高亮）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] });
    useWorkbenchStore().sessionId = '1';
    await flushPromises();
    expect(wrapper.find('[data-testid="pinned-current"]').exists()).toBe(false);
  });

  it('sessionId 不在列表中 → 置顶卡存在且含标题，样式带 border-brand bg-green-50，位于列表段最顶；点击 emit select-session', async () => {
    const onSelectSession = vi.fn();
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] }, { onSelectSession });
    useWorkbenchStore().sessionId = 'deep-99'; // 深链：不在当前目录列表（如被「最近 20 个」截断）
    await flushPromises();
    const card = wrapper.find('[data-testid="pinned-current"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain('📌 当前会话'); // 标题
    expect(card.classes()).toContain('border-brand'); // 复用选中态高亮
    expect(card.classes()).toContain('bg-green-50');
    // v-for 之外、位于列表段最顶部（其父容器即 v-else 列表容器，卡是其首个元素子节点）
    expect(card.element.parentElement!.firstElementChild).toBe(card.element);
    await card.trigger('click');
    expect(onSelectSession).toHaveBeenCalledWith('deep-99'); // 重开当前会话
  });

  it('空态（暂无会话）+ 深链 sessionId → 置顶卡仍显示（可能是唯一一张卡），与空态文案共存', async () => {
    const wrapper = await mountPanel({ dirs: DIR });
    useWorkbenchStore().sessionId = 'deep-7';
    await flushPromises();
    expect(wrapper.find('[data-testid="pinned-current"]').exists()).toBe(true);
    expect(paneEls(wrapper).list.textContent).toContain('暂无会话');
  });

  it('noDir（列表未加载）→ 不显示置顶卡', async () => {
    const wrapper = await mountPanel({ noDir: true });
    useWorkbenchStore().sessionId = 'deep-1';
    await flushPromises();
    expect(wrapper.find('[data-testid="pinned-current"]').exists()).toBe(false);
  });
});

