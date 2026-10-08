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
import { i18n, setLocale } from '../i18n';

beforeEach(() => {
  // issue #101 P2：装配真实 i18n 单例（不 mock t()），每例重置为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

async function mountPanel(
  opts: { dirs?: DirInfo[]; sessions?: Session[]; noDir?: boolean; platformAdmin?: boolean; attachTo?: boolean } = {},
  attrs: Record<string, unknown> = {},
) {
  const store = useWorkbenchStore();
  store.dirs = opts.dirs ?? [];
  store.dirCwd = opts.dirs?.[0]?.cwd ?? null;
  store.sessions = opts.sessions ?? [];
  store.noDir = opts.noDir ?? false;
  if (opts.platformAdmin) store.isPlatformAdmin = true;
  const auth = useAuthStore();
  auth.user = opts.platformAdmin
    ? { id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: null, auth_source: 'local' }
    : { id: 'u1', login: 'alice', display_name: 'Alice', role: 'fde', fde_name: 'alice', auth_source: 'local' };
  // 已探测过：路由守卫不再打 /api/me（否则 fetch 桩的响应会把刚置的 user 覆写成 undefined）。
  auth.ready = true;
  const router = createAppRouter(createMemoryHistory());
  router.push('/');
  await router.isReady();
  // issue #107：重命名用例需断言 document.activeElement（autofocus 全选）——挂到真实文档才成立；
  // 这类用例自行 wrapper.unmount() 清理，避免残留在 body 里干扰后续用例。
  const wrapper = mount(SidebarPanel, {
    global: { plugins: [router, i18n] },
    attrs,
    attachTo: opts.attachTo ? document.body : undefined,
  });
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
    expect(kids[1].querySelectorAll('[data-session-row]').length).toBe(15); // 会话行全在列表段内（issue #112 扁平行）
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
// issue #112：左栏视觉收敛（会话列表扁平化 + 字号体系 12/11）——纯呈现层断言：
//   扁平行（无卡片边框/圆角/行间距）、选中 = 左 2px brand 竖条 + 浅绿底、hover 背景、
//   标题 12px（选中 500）/ 副行 11px、空态 11px、侧栏头控件 32px/7px/12px。
// ---------------------------------------------------------------------------
describe('SidebarPanel · 左栏视觉收敛（issue #112）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];
  /** 列表段内的会话行（扁平行；data-session-row 为呈现层测试钩子）。 */
  const rows = (wrapper: Awaited<ReturnType<typeof mountPanel>>) =>
    Array.from(paneEls(wrapper).list.querySelectorAll<HTMLElement>('[data-session-row]'));

  it('会话行为扁平行：无卡片边框/圆角/行间距，54px 最小行高 + 左 14 右 8 内边距', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }, { id: '2', title: 's2' }] });
    const [r1, r2] = rows(wrapper);
    expect(rows(wrapper)).toHaveLength(2);
    for (const r of [r1, r2]) {
      expect(r.classList).toContain('min-h-[54px]');
      expect(r.classList).toContain('pl-3.5'); // 左 14px
      expect(r.classList).toContain('pr-2'); // 右 8px
      expect(r.classList).toContain('border-l-2'); // 竖条常驻（未选中 transparent，避免布局跳动）
      expect(r.classList).not.toContain('border'); // 卡片边框已拆除
      expect(r.classList).not.toContain('rounded-md');
      expect(r.classList).not.toContain('mt-2'); // 扁平行之间无间距
    }
  });

  it('选中态 = 左 2px brand 竖条 + 浅绿底；非选中 = 透明竖条 + hover 浅灰底', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }, { id: '2', title: 's2' }] });
    useWorkbenchStore().sessionId = '2';
    await flushPromises();
    const [r1, r2] = rows(wrapper);
    expect(r2.classList).toContain('border-l-brand');
    expect(r2.classList).toContain('bg-green-50');
    expect(r2.classList).not.toContain('hover:bg-black/5');
    expect(r1.classList).toContain('border-l-transparent');
    expect(r1.classList).toContain('hover:bg-black/5');
    expect(r1.classList).not.toContain('border-l-brand');
  });

  it('字号体系：标题 12px（选中 font-medium）/ 副行 11px text-dim marginTop 2', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] });
    const store = useWorkbenchStore();
    store.sessionId = '1';
    await flushPromises();
    const [row] = rows(wrapper);
    const title = row.querySelector('span.truncate')!;
    expect(title.textContent).toBe('s1');
    expect(title.classList).toContain('font-medium'); // 选中 500（非选中无此权重类）
    expect(title.parentElement!.classList).toContain('text-[12px]');
    const meta = row.querySelector('div[class~="mt-0.5"]')!; // 副行：marginTop 2（pi-web 规格）
    expect(meta.classList).toContain('text-[11px]');
    expect(meta.classList).toContain('text-black/50');
    expect(meta.textContent).toBe(store.sessMeta(store.sessions[0]));
  });

  it('空态文案 11px（「暂无会话」/「先创建目录」/平台管理员提示）', async () => {
    const w1 = await mountPanel({ dirs: DIR });
    const p = paneEls(w1).list.querySelector('p')!;
    expect(p.textContent).toBe('暂无会话');
    expect(p.classList).toContain('text-[11px]');

    const w2 = await mountPanel({ noDir: true });
    const p2 = paneEls(w2).list.querySelector('p')!;
    expect(p2.textContent).toBe('先创建目录');
    expect(p2.classList).toContain('text-[11px]');

    const w3 = await mountPanel({ noDir: true, platformAdmin: true });
    const p3 = paneEls(w3).list.querySelector('p')!;
    expect(p3.textContent).toContain('平台管理员');
    expect(p3.classList).toContain('text-[11px]');
  });

  it('重命名输入收敛：12px / 30px 高 / 5px 圆角 / brand 边框（铅笔按钮仍 hover 浮现）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const btn = wrapper.get('button[aria-label="重命名"]');
    expect(btn.classes()).toContain('opacity-0'); // 默认隐藏
    expect(btn.classes()).toContain('group-hover:opacity-100'); // hover 浮现（交互不变）
    // issue #112：入口重做为「SVG 铅笔 + 方块按钮」——emoji 不再出现在按钮文本里
    expect(btn.find('svg').exists()).toBe(true);
    expect(btn.text()).toBe('');
    await btn.trigger('click');
    const input = wrapper.get('input[aria-label="重命名"]');
    expect(input.classes()).toContain('h-[30px]');
    expect(input.classes()).toContain('text-[12px]');
    expect(input.classes()).toContain('rounded-[5px]');
    expect(input.classes()).toContain('border-brand');
  });

  it('侧栏头控件统一 32px 高 / 7px 圆角 / 12px 字号（新会话、🔍、目录下拉、↻、管理台入口）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, platformAdmin: true });
    const { head } = paneEls(wrapper);
    const ctrl = (sel: string) => head.querySelector<HTMLElement>(sel)!;
    const newSess = Array.from(head.querySelectorAll('button')).find((b) => b.textContent?.includes('＋ 新会话'))!;
    expect(newSess.classList).toContain('h-8');
    expect(newSess.classList).toContain('rounded-[7px]');
    expect(newSess.classList).toContain('text-[12px]');
    expect(ctrl('button[aria-label="浏览会话"]').classList).toContain('h-8');
    expect(ctrl('select').classList).toContain('h-8');
    expect(ctrl('select').classList).toContain('text-[12px]');
    expect(ctrl('button[title="刷新目录列表与目录树"]').classList).toContain('h-8');
    expect(ctrl('a[href="/admin"]').classList).toContain('h-8');
    expect(ctrl('label[for="dirSel"]').classList).toContain('text-[11px]');
  });
});

// ---------------------------------------------------------------------------
// issue #94（评审裁决瘦身版）：会话浏览入口——固定头 🔍（title「浏览会话（Ctrl/⌘+K）」）
// ---------------------------------------------------------------------------
describe('SidebarPanel · issue #94 会话浏览入口', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  it('固定头 🔍 恒可见，title 为「浏览会话（Ctrl/⌘+K）」；有目录时 scope=cwd、无目录时 scope=all', async () => {
    const w1 = await mountPanel({ dirs: DIR });
    const btn1 = w1.find('button[aria-label="浏览会话"]');
    expect(btn1.exists()).toBe(true);
    expect(btn1.attributes('title')).toBe('浏览会话（Ctrl/⌘+K）');
    await btn1.trigger('click');
    expect(w1.findComponent(SessionPickerModal).props('scope')).toBe('cwd');

    const w2 = await mountPanel({ noDir: true });
    const btn2 = w2.find('button[aria-label="浏览会话"]');
    expect(btn2.exists()).toBe(true); // 无目录也恒可见
    await btn2.trigger('click');
    expect(w2.findComponent(SessionPickerModal).props('scope')).toBe('all');
  });

  it('无「查看全部会话」入口与「当前会话」置顶卡（评审裁决：已拆除）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] });
    expect(wrapper.text()).not.toContain('查看全部会话');
    expect(wrapper.text()).not.toContain('显示最近 20 个');
    expect(wrapper.find('[data-testid="pinned-current"]').exists()).toBe(false);
    // 深链会话不在列表：也不贴置顶卡（裁决：真出现不同步应修 store，不贴卡）
    useWorkbenchStore().sessionId = 'deep-99';
    await flushPromises();
    expect(wrapper.find('[data-testid="pinned-current"]').exists()).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// issue #101 P2：侧栏用户可见文案走 i18n（zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('SidebarPanel · i18n（issue #101 P2）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  it('zh-CN 基线：＋ 新会话 / 暂无会话 / 浏览会话入口 / 新建目录 modal 文案', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [] });
    expect(wrapper.text()).toContain('＋ 新会话');
    expect(wrapper.text()).toContain('暂无会话');
    expect(wrapper.get('button[aria-label="浏览会话"]').attributes('title')).toBe('浏览会话（Ctrl/⌘+K）');

    await wrapper.get('select').setValue('__new__'); // 末项「＋ 新建目录」→ modal（不再内联表单）
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('新建目录'); // modal 标题
    expect(wrapper.get('label[for="newDirName"]').text()).toBe('目录名（小写字母/数字/连字符）');
    expect(wrapper.get('#newDirName').attributes('placeholder')).toBe('例如 my-project');
    expect(wrapper.findAll('form button').map((b) => b.text())).toEqual(['创建', '取消']);
  });

  it('zh-CN 基线：平台管理员空态提示 + 管理台入口', async () => {
    const wrapper = await mountPanel({ noDir: true, platformAdmin: true });
    const { list } = paneEls(wrapper);
    expect(list.textContent).toContain('平台管理员：请到管理台创建 FDE 用户与分配资源');
    expect(list.textContent).toContain('进入管理台');
    expect(wrapper.get('a[href="/admin"]').text()).toBe('管理台');
  });

  it('切 English：侧栏（含 DirSelect 子组件）文案即时变英文', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [] });
    setLocale('en');
    await flushPromises();
    expect(wrapper.text()).toContain('＋ New session');
    expect(wrapper.text()).toContain('No sessions');
    expect(wrapper.get('button[aria-label="Browse sessions"]').attributes('title'))
      .toBe('Browse sessions (Ctrl/⌘+K)');
    expect(wrapper.get('label[for="dirSel"]').text()).toBe('Directory');
    expect(wrapper.get('select').find('option[value="__new__"]').text()).toBe('＋ New directory');

    await wrapper.get('select').setValue('__new__');
    await flushPromises();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('New directory'); // modal 标题
    expect(wrapper.get('label[for="newDirName"]').text())
      .toBe('Directory name (lowercase letters / digits / hyphens)');
    expect(wrapper.findAll('form button').map((b) => b.text())).toEqual(['Create', 'Cancel']);
  });

  it('切 English：平台管理员空态提示与管理台入口变英文', async () => {
    const wrapper = await mountPanel({ noDir: true, platformAdmin: true });
    setLocale('en');
    await flushPromises();
    expect(wrapper.text()).toContain('Platform admin: create FDE users and assign resources in the admin console');
    expect(wrapper.text()).toContain('Go to admin console');
    expect(wrapper.get('a[href="/admin"]').text()).toBe('Admin console');
  });
});

// ---------------------------------------------------------------------------
// issue #107：会话卡片内联重命名（hover 铅笔按钮 → 原地 input；Enter/blur 提交、Esc 取消、空串拦截）
// issue #112：入口由 emoji ✏️ 重做为内联 SVG 铅笔 + 浮现方块按钮（语义/交互不变，仅呈现层）
// 后端 PATCH /api/sessions/:id 已就绪（本 issue 零接口改动，只补一条 SSE）；本套件桩掉 fetch。
// ---------------------------------------------------------------------------
describe('SidebarPanel · 会话重命名（issue #107）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  /** 替换 fetch 桩：记录全部请求（url/method/body），统一返回给定结果。 */
  function stubRenameFetch(result: { status: number; body: unknown }) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return calls;
  }

  it('hover 出现铅笔按钮（title/aria-label「重命名」）；点击原地开 input（autofocus + 全选），不误触选中会话', async () => {
    const onSelectSession = vi.fn();
    const wrapper = await mountPanel(
      { dirs: DIR, sessions: [{ id: '7', title: '旧名' }], attachTo: true },
      { onSelectSession },
    );
    try {
      const btn = wrapper.get('button[aria-label="重命名"]');
      // issue #112：入口 = 内联 SVG 铅笔（stroke/currentColor）+ 浮现方块按钮形状；不再是 emoji 文本
      expect(btn.text()).toBe('');
      const svg = btn.get('svg');
      expect(svg.attributes('fill')).toBe('none');
      expect(svg.attributes('stroke')).toBe('currentColor');
      expect(svg.attributes('stroke-width')).toBe('2');
      expect(svg.attributes('viewBox')).toBe('0 0 24 24');
      expect(svg.attributes('aria-hidden')).toBe('true');
      expect(btn.classes()).toContain('h-6'); // 24px 方块按钮
      expect(btn.classes()).toContain('w-6');
      expect(btn.classes()).toContain('rounded-[5px]');
      expect(btn.classes()).toContain('border-black/15');
      expect(btn.classes()).toContain('bg-white');
      expect(btn.classes()).toContain('hover:bg-black/10');
      expect(btn.attributes('title')).toBe('重命名');
      expect(btn.classes()).toContain('opacity-0'); // 默认隐藏，hover 才浮现（group-hover:opacity-100）
      expect(btn.classes()).toContain('group-hover:opacity-100');

      await btn.trigger('click');
      await flushPromises();
      expect(onSelectSession).not.toHaveBeenCalled(); // @click.stop：重命名不触发「选中会话」

      const input = wrapper.get('input[aria-label="重命名"]');
      const el = input.element as HTMLInputElement;
      expect(el.value).toBe('旧名'); // 原地变 input（不弹 modal）
      expect(input.attributes('placeholder')).toBe('会话名称');
      expect(input.attributes('maxlength')).toBe('200'); // 与后端 ≤200 校验同口径
      expect(document.activeElement).toBe(el); // autofocus
      expect([el.selectionStart, el.selectionEnd]).toEqual([0, 2]); // 全选（改整个名字）
      expect(wrapper.find('button[aria-label="重命名"]').exists()).toBe(false); // 编辑态隐藏铅笔按钮
    } finally {
      wrapper.unmount();
    }
  });

  it('Enter 提交：PATCH /api/sessions/<id> {title}（trim），成功后 store 原地更新 title/title_source 并退出编辑态', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名', title_source: 'auto' }] });
    const store = useWorkbenchStore();
    const calls = stubRenameFetch({ status: 200, body: { session: { id: '7', title: '新名', title_source: 'manual' } } });
    try {
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      const input = wrapper.get('input[aria-label="重命名"]');
      await input.setValue('  新名  ');
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();

      expect(calls).toEqual([{ url: '/api/sessions/7', method: 'PATCH', body: { title: '新名' } }]);
      expect(store.sessions[0].title).toBe('新名'); // 原地更新（不整表 loadSessions）
      expect(store.sessions[0].title_source).toBe('manual');
      expect(wrapper.find('input[aria-label="重命名"]').exists()).toBe(false); // 退出编辑态
      expect(wrapper.text()).toContain('新名');
    } finally {
      wrapper.unmount();
    }
  });

  it('blur 提交：失焦即提交（与 Enter 同语义）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const store = useWorkbenchStore();
    const calls = stubRenameFetch({ status: 200, body: { session: { id: '7', title: '失焦改名', title_source: 'manual' } } });
    try {
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      const input = wrapper.get('input[aria-label="重命名"]');
      await input.setValue('失焦改名');
      await input.trigger('blur');
      await flushPromises();

      expect(calls).toHaveLength(1);
      expect(store.sessions[0].title).toBe('失焦改名');
      expect(wrapper.find('input[aria-label="重命名"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('Esc 取消：不发请求、标题不变、退出编辑态', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const store = useWorkbenchStore();
    const calls = stubRenameFetch({ status: 200, body: { session: { id: '7', title: '新名' } } });
    try {
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      const input = wrapper.get('input[aria-label="重命名"]');
      await input.setValue('新名');
      await input.trigger('keydown', { key: 'Escape' });
      await flushPromises();

      expect(calls).toEqual([]);
      expect(store.sessions[0].title).toBe('旧名');
      expect(wrapper.find('input[aria-label="重命名"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('旧名');
    } finally {
      wrapper.unmount();
    }
  });

  it('空串/纯空白：前端拦截不提交（空串落 manual 会永久关掉自动命名），静默回退旧标题', async () => {
    for (const blank of ['', '   ', '\t\n ']) {
      const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
      const store = useWorkbenchStore();
      const calls = stubRenameFetch({ status: 200, body: { session: { id: '7', title: '新名', title_source: 'manual' } } });
      try {
        await wrapper.get('button[aria-label="重命名"]').trigger('click');
        const input = wrapper.get('input[aria-label="重命名"]');
        await input.setValue(blank);
        await input.trigger('keydown', { key: 'Enter' });
        await flushPromises();

        expect(calls).toEqual([]);
        expect(store.sessions[0].title).toBe('旧名');
        expect(store.sessions[0].title_source).toBeUndefined(); // 未被置 manual
        expect(wrapper.text()).toContain('旧名');
        expect(wrapper.find('input[aria-label="重命名"]').exists()).toBe(false);
      } finally {
        wrapper.unmount();
      }
    }
  });

  it('超 200 字符：前端截断到 200 再提交（与后端校验口径一致，不把 400 抛给用户）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const store = useWorkbenchStore();
    const calls = stubRenameFetch({ status: 200, body: { session: { id: '7', title: '长'.repeat(200), title_source: 'manual' } } });
    try {
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      const input = wrapper.get('input[aria-label="重命名"]');
      await input.setValue('长'.repeat(250));
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();

      expect(calls[0].body).toEqual({ title: '长'.repeat(200) });
      expect(store.sessions[0].title).toBe('长'.repeat(200));
    } finally {
      wrapper.unmount();
    }
  });

  it('PATCH 失败（401）：原地回退旧标题 + 卡片内轻提示（.syserr role=alert）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const store = useWorkbenchStore();
    stubRenameFetch({ status: 401, body: { error: { code: 'unauthorized', message: '未登录' } } });
    try {
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      const input = wrapper.get('input[aria-label="重命名"]');
      await input.setValue('新名');
      await input.trigger('keydown', { key: 'Enter' });
      await flushPromises();

      expect(store.sessions[0].title).toBe('旧名'); // store 未被改动（原地回退旧标题）
      expect(wrapper.find('input[aria-label="重命名"]').exists()).toBe(false);
      expect(wrapper.text()).toContain('旧名');
      const alert = wrapper.get('[role="alert"]');
      expect(alert.text()).toBe('重命名失败：未登录');
      expect(alert.classes()).toContain('syserr'); // 沿用项目行内错误提示样式（无 toast 体系）

      // 再次进入编辑态：旧提示清掉，可重试
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('i18n：切 English 后铅笔按钮的 title/aria-label 与输入占位符变英文', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: 'old name' }] });
    try {
      setLocale('en');
      await flushPromises();
      const btn = wrapper.get('button[aria-label="Rename session"]');
      expect(btn.attributes('title')).toBe('Rename session');
      await btn.trigger('click');
      expect(wrapper.get('input[aria-label="Rename session"]').attributes('placeholder')).toBe('Session name');
    } finally {
      wrapper.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// issue #114：「AI 改名」按钮（铅笔旁同款 24px 浮现方块按钮）
//   点击 → 行内 loading（禁用 + 转圈）→ POST /api/sessions/:id/ai-title → 成功原地更新标题；
//   失败 .syserr 行内提示（沿用 #107 模式）；编辑态下两按钮都隐藏；@click.stop 不误触选中。
// ---------------------------------------------------------------------------
describe('SidebarPanel · AI 改名（issue #114）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];

  /** 替换 fetch 桩：记录请求（url/method/body）；传函数则用其返回值（做挂起/延迟用）。 */
  function stubAiFetch(result: { status: number; body: unknown } | (() => Promise<Response>)) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (typeof result === 'function') return result();
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    return calls;
  }

  it('铅笔旁同款浮现方块按钮：24px / 5px 圆角 / 细边框 / stroke 魔棒 SVG，默认隐藏 hover 浮现', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const btn = wrapper.get('button[aria-label="AI 改名"]');
    expect(btn.attributes('title')).toBe('AI 改名');
    expect(btn.classes()).toContain('h-6'); // 24px 方块（与铅笔同规格）
    expect(btn.classes()).toContain('w-6');
    expect(btn.classes()).toContain('rounded-[5px]');
    expect(btn.classes()).toContain('border-black/15');
    expect(btn.classes()).toContain('bg-white');
    expect(btn.classes()).toContain('hover:bg-black/10');
    expect(btn.classes()).toContain('opacity-0'); // 默认隐藏
    expect(btn.classes()).toContain('group-hover:opacity-100'); // hover 浮现
    const svg = btn.get('svg');
    expect(svg.attributes('fill')).toBe('none');
    expect(svg.attributes('stroke')).toBe('currentColor');
    expect(svg.attributes('stroke-width')).toBe('2');
    expect(svg.attributes('viewBox')).toBe('0 0 24 24');
    expect(svg.attributes('aria-hidden')).toBe('true');
    expect(btn.text()).toBe(''); // 纯图标，无文本
  });

  it('点击 → 行内 loading（禁用 + 转圈 + title 换「AI 命名中…」）→ 成功后原地更新 store 标题', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名', title_source: 'auto' }] });
    const store = useWorkbenchStore();
    let release!: (r: Response) => void;
    const calls = stubAiFetch(() => new Promise<Response>((res) => { release = res; }));
    try {
      await wrapper.get('button[aria-label="AI 改名"]').trigger('click');
      await flushPromises();

      const loadingBtn = wrapper.get('button[aria-label="AI 改名"]');
      expect((loadingBtn.element as HTMLButtonElement).disabled).toBe(true); // 禁用
      expect(loadingBtn.find('svg.animate-spin').exists()).toBe(true); // 转圈
      expect(loadingBtn.classes()).toContain('opacity-100'); // loading 态恒可见（不依赖 hover）
      expect(loadingBtn.attributes('title')).toBe('AI 命名中…');

      release(new Response(
        JSON.stringify({ session: { id: '7', title: 'AI 起的名字', title_source: 'manual' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      await flushPromises();

      expect(calls).toEqual([{ url: '/api/sessions/7/ai-title', method: 'POST', body: {} }]);
      expect(store.sessions[0].title).toBe('AI 起的名字'); // 原地更新（不整表 loadSessions）
      expect(store.sessions[0].title_source).toBe('manual');
      expect(wrapper.text()).toContain('AI 起的名字');
      expect((wrapper.get('button[aria-label="AI 改名"]').element as HTMLButtonElement).disabled).toBe(false);
      expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('失败（409 未配置 LLM）→ 标题不变 + 卡片内 .syserr 行内提示；再次点击清掉旧提示', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    const store = useWorkbenchStore();
    stubAiFetch({ status: 409, body: { error: { code: 'llm_not_configured', message: '未配置可用的 LLM 上游' } } });
    try {
      await wrapper.get('button[aria-label="AI 改名"]').trigger('click');
      await flushPromises();

      expect(store.sessions[0].title).toBe('旧名'); // store 未被改动
      expect(wrapper.text()).toContain('旧名');
      const alert = wrapper.get('[role="alert"]');
      expect(alert.text()).toBe('AI 改名失败：未配置可用的 LLM 上游');
      expect(alert.classes()).toContain('syserr');
      expect((wrapper.get('button[aria-label="AI 改名"]').element as HTMLButtonElement).disabled).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('失败（502 上游失败）→ 同样行内提示，且不误触「选中会话」', async () => {
    const onSelectSession = vi.fn();
    const wrapper = await mountPanel(
      { dirs: DIR, sessions: [{ id: '7', title: '旧名' }] },
      { onSelectSession },
    );
    stubAiFetch({ status: 502, body: { error: { code: 'llm_upstream_failed', message: 'LLM 调用失败：上游返回 HTTP 401' } } });
    try {
      await wrapper.get('button[aria-label="AI 改名"]').trigger('click');
      await flushPromises();
      expect(onSelectSession).not.toHaveBeenCalled(); // @click.stop
      expect(wrapper.get('[role="alert"]').text()).toBe('AI 改名失败：LLM 调用失败：上游返回 HTTP 401');
    } finally {
      wrapper.unmount();
    }
  });

  it('编辑态下两个按钮都隐藏（铅笔 + AI 改名互斥）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: '旧名' }] });
    try {
      expect(wrapper.find('button[aria-label="AI 改名"]').exists()).toBe(true);
      await wrapper.get('button[aria-label="重命名"]').trigger('click');
      await flushPromises();
      expect(wrapper.find('button[aria-label="重命名"]').exists()).toBe(false);
      expect(wrapper.find('button[aria-label="AI 改名"]').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  });

  it('i18n：切 English 后按钮 title/aria-label 与 loading 文案变英文', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '7', title: 'old name' }] });
    let release!: (r: Response) => void;
    stubAiFetch(() => new Promise<Response>((res) => { release = res; }));
    try {
      setLocale('en');
      await flushPromises();
      const btn = wrapper.get('button[aria-label="AI rename"]');
      expect(btn.attributes('title')).toBe('AI rename');
      await btn.trigger('click');
      await flushPromises();
      expect(wrapper.get('button[aria-label="AI rename"]').attributes('title')).toBe('Naming with AI…');
      release(new Response(
        JSON.stringify({ session: { id: '7', title: 'x', title_source: 'manual' } }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
      await flushPromises();
    } finally {
      wrapper.unmount();
    }
  });
});

// ---------------------------------------------------------------------------
// issue #197：会话列表项副行的每会话消息数（后端 listSessions 的 message_count，
// 口径同头部状态行：全量 messages 行含 synthetic）。渲染 = 「{meta} · N 条消息」同灰字；
// message_count 缺失或 0 → 不显示（无「0 条」、无占位，副行恒等于 sessMeta）。
// ---------------------------------------------------------------------------
describe('SidebarPanel · 会话消息数（issue #197）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];
  /** 第 i 个会话行的副行元素（11px 灰字 meta 行）。 */
  const metaOf = (wrapper: Awaited<ReturnType<typeof mountPanel>>, i = 0) =>
    Array.from(paneEls(wrapper).list.querySelectorAll<HTMLElement>('[data-session-row]'))[i]
      .querySelector('div[class~="mt-0.5"]')!;

  it('message_count > 0 → 副行追加「 · N 条消息」（i18n 中文，复用副行灰字样式）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1', message_count: 42 }] });
    const store = useWorkbenchStore();
    const meta = metaOf(wrapper);
    expect(meta.textContent).toBe(`${store.sessMeta(store.sessions[0])} · 42 条消息`);
    expect(meta.classList).toContain('text-[11px]'); // 不新增视觉层级：就是原副行
    expect(meta.classList).toContain('text-black/50');
  });

  it('message_count 缺失 / 0 → 不显示（无「0 条」无占位；副行逐字等于 sessMeta）', async () => {
    const wrapper = await mountPanel({
      dirs: DIR,
      sessions: [{ id: '1', title: 'a' }, { id: '2', title: 'b', message_count: 0 }],
    });
    const store = useWorkbenchStore();
    expect(metaOf(wrapper, 0).textContent).toBe(store.sessMeta(store.sessions[0])); // 字段缺失
    expect(metaOf(wrapper, 1).textContent).toBe(store.sessMeta(store.sessions[1])); // 计数为 0
    expect(paneEls(wrapper).list.textContent).not.toContain('条消息');
  });

  it('i18n：切 English 后消息数文案对译（禁止硬编码中文）', async () => {
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1', message_count: 3 }] });
    setLocale('en');
    await flushPromises();
    expect(metaOf(wrapper).textContent).toContain('· 3 messages');
    expect(metaOf(wrapper).textContent).not.toContain('条消息');
  });
});
