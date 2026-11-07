// SidebarPanel 单测（issue #92）：aside 内 flex-col 三段布局结构断言——
//   ① 固定头（shrink-0：DirSelect + ＋新会话按钮，不随列表滚动）
//   ② 会话列表段（flex-1 min-h-0 overflow-y-auto，独立内部滚动；空态文案在此段内）
//   ③ 底部堆叠区（issue #308：data-test="sidebar-bottom-stack"，max-h-[50vh] overflow-y-auto 是**唯一**
//      的底部滚动层，内含「预览端口段（默认折叠）+ 目录树面板（默认折叠、恒在末位）」，两段各自折叠）
// 定位一律走稳定钩子（sidebar-aside / sidebar-session-list / sidebar-bottom-stack），不靠「根下第 N 子」。
// 另覆盖：空态文案（「先创建目录」/「暂无会话」）、会话点击 emit 语义保持。
// issue #332：这里原有「平台管理员提示 + 进入管理台链接」的空态分支已随**入口拦截**拆除（`admin && !fde_name` 的人被路由守卫送去 /admin，走不到工作台）；本文件里的 admin 夹具因此换成第 ② 类人（admin **且**有 fde_name）——他才是能站上工作台的管理员。
// store 状态直填、fetch 桩掉（不碰真实后端）；路由用 memory-history 的真实 router（router-link 渲染需要）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory } from 'vue-router';
import SidebarPanel from './SidebarPanel.vue';
import SessionPickerModal from './SessionPickerModal.vue';
import { createAppRouter } from '../router';
import { useAuthStore } from '../stores/auth';
import { useSiteStore } from '../stores/site';
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
  opts: { dirs?: DirInfo[]; sessions?: Session[]; noDir?: boolean; adminUser?: boolean; attachTo?: boolean } = {},
  attrs: Record<string, unknown> = {},
) {
  const store = useWorkbenchStore();
  store.dirs = opts.dirs ?? [];
  store.dirCwd = opts.dirs?.[0]?.cwd ?? null;
  store.sessions = opts.sessions ?? [];
  store.noDir = opts.noDir ?? false;
  // issue #332：isPlatformAdmin 已从 store 拆除；「是不是管理员」只影响顶栏那个「管理台」入口
  // （判据 `auth.user?.role === 'admin'`），而能站上工作台的 admin 必然**同时有工位** ⇒ 夹具给第 ② 类人。
  const auth = useAuthStore();
  auth.user = opts.adminUser
    ? { id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local' }
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

// 三段定位助手（issue #308：按稳定 data-test 钩子定位，不再靠「根下第 N 个子节点」）：
//   head = 根下第 1 子（固定头，它没有独立钩子——顺序断言已钉它是第一个）
//   list = [data-test="sidebar-session-list"]；stack = [data-test="sidebar-bottom-stack"]（底部堆叠区）
//   tree = 底部栈的末子（「树在最后」的意图保留：端口段在前，树在最后）
function paneEls(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
  const root = wrapper.element as HTMLElement; // 组件根 div（单根节点，data-test="sidebar-aside"）
  const kids = Array.from(root.children) as HTMLElement[];
  const list = root.querySelector<HTMLElement>('[data-test="sidebar-session-list"]')!;
  const stack = root.querySelector<HTMLElement>('[data-test="sidebar-bottom-stack"]')!;
  return { root, kids, head: kids[0], list, stack, tree: stack.lastElementChild as HTMLElement };
}

describe('SidebarPanel · 三段布局（issue #92）', () => {
  it('根元素为 flex-col 容器：h-full + min-h-0，三段按 固定头→列表→底部栈 顺序排列', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    const { root, kids, list, stack, tree } = paneEls(wrapper);
    expect(root.classList).toContain('flex');
    expect(root.classList).toContain('flex-col');
    expect(root.classList).toContain('h-full');
    expect(root.classList).toContain('min-h-0');
    // issue #308：三段仍是 3 个直接子节点（固定头 / 列表段 / 底部栈），但**底部栈是第三段**，
    // 树与端口段都在栈内 ⇒ 用钩子定位，顺序断言保留（head 第一、stack 末一）。
    expect(kids).toHaveLength(3);
    expect(kids[0]).toBe(paneEls(wrapper).head);
    expect(kids[1]).toBe(list);
    expect(kids[2]).toBe(stack);
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

  it('空态文案随列表段：「先创建目录」/「暂无会话」都在滚动段内', async () => {
    // 无目录普通用户：「先创建目录」
    const w1 = await mountPanel({ noDir: true });
    const { list: l1, head: h1 } = paneEls(w1);
    expect(l1.textContent).toContain('先创建目录');
    expect(h1.textContent).not.toContain('先创建目录');

    // issue #332：原本这里还钉「无目录的平台管理员 ⇒ 管理台提示 + 进入管理台链接」。
    // 入口拦截后他到不了工作台 ⇒ 分支与文案一起删；这里改钉「有工位的人（含第 ② 类人 admin）只看到建目录引导」。
    const w2 = await mountPanel({ noDir: true, adminUser: true });
    const { list: l2 } = paneEls(w2);
    expect(l2.textContent).toContain('先创建目录');
    expect(l2.textContent).not.toContain('请到管理台');
    expect(Array.from(l2.querySelectorAll('a'))).toHaveLength(0);

    // 有目录无会话：「暂无会话」
    const w3 = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    expect(paneEls(w3).list.textContent).toContain('暂无会话');
  });

  it('目录树面板在底部栈末位：末子元素 + shrink-0（透传合并到 DirectoryTree 根元素）', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
      sessions: Array.from({ length: 15 }, (_, i) => ({ id: String(i), title: `s${i}` })), // 15 条也不改变结构
    });
    const { stack, tree } = paneEls(wrapper);
    expect(stack.lastElementChild).toBe(tree); // 「树在最后」的意图保留（端口段在它之前）
    expect(tree.classList).toContain('shrink-0');
    expect(tree.classList).toContain('border-t'); // 树面板与端口段之间的分隔线（原样式保持）
    expect(paneEls(wrapper).list.querySelectorAll('[data-session-row]').length).toBe(15); // 会话行全在列表段内（issue #112 扁平行）
  });

  // issue #308：高度/滚动预算只留一层——底部栈是**唯一**的底部滚动容器，
  // 树与端口面板都不再自带 max-h/overflow（否则三层嵌套滚动会抢滚轮）。
  it('底部栈是唯一的底部滚动容器：max-h-[50vh] + overflow-y-auto；树自己那层 max-h-[40vh] 已撤', async () => {
    const wrapper = await mountPanel({
      dirs: [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }],
    });
    const { stack, tree } = paneEls(wrapper);
    expect(stack.classList).toContain('max-h-[50vh]'); // 高度预算（50vh）
    expect(stack.classList).toContain('overflow-y-auto'); // 唯一滚动层
    expect(stack.classList).toContain('shrink-0'); // 栈不缩列表段为负
    expect(tree.classList).toContain('shrink-0'); // 原透传类保留
    expect(tree.classList).toContain('mt-3'); // 自带分隔边距保留
    expect(tree.classList).toContain('border-t');
    // 负面断言：树不再自带滚动/限高（否则与底部栈嵌套抢滚轮）
    expect(tree.classList).not.toContain('overflow-y-auto');
    expect(tree.classList).not.toContain('max-h-[40vh]');
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

    // issue #332：第 ② 类人（admin 且有工位）的空态与普通 FDE 同一条文案，字号同 11px。
    const w3 = await mountPanel({ noDir: true, adminUser: true });
    const p3 = paneEls(w3).list.querySelector('p')!;
    expect(p3.textContent).toBe('先创建目录');
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
    const wrapper = await mountPanel({ dirs: DIR, adminUser: true });
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
    expect(ctrl('[data-test="admin-console-link"]').classList).toContain('h-8');
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
    // issue #284：label 补上「下划线」并写全首尾/长度规则（旧文案只说连字符，与后端口径不符）
    expect(wrapper.get('label[for="newDirName"]').text())
      .toBe('目录名（小写字母、数字、下划线、连字符；不能以连字符或下划线开头/结尾；最长 63 字符）');
    expect(wrapper.get('#newDirName').attributes('placeholder')).toBe('例如 my-project');
    expect(wrapper.findAll('form button').map((b) => b.text())).toEqual(['创建', '取消']);
  });

  it('zh-CN 基线：管理员（第 ② 类人：有工位）看得到「管理台」入口，但空态只剩建目录引导', async () => {
    // issue #332：「平台管理员：请到管理台…」+「进入管理台」两句随入口拦截删除（不可达）；
    // 顶栏那个「管理台」入口保留——它的判据是 role==='admin'，服务的是**有工位**的管理员。
    const wrapper = await mountPanel({ noDir: true, adminUser: true });
    const { list } = paneEls(wrapper);
    expect(list.textContent).not.toContain('请到管理台');
    expect(wrapper.get('[data-test="admin-console-link"]').text()).toBe('管理台');
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
      .toBe('Directory name (lowercase letters, digits, underscores, hyphens; must not start or end with a hyphen or underscore; max 63 characters)');
    expect(wrapper.findAll('form button').map((b) => b.text())).toEqual(['Create', 'Cancel']);
  });

  it('#450 A2：管理台入口是**跨 host 的绝对地址**（site 有值 ⇒ adminBaseUrl#/admin；无值 ⇒ 退回相对 hash）', async () => {
    const wrapper = await mountPanel({ noDir: true, adminUser: true });
    const link = () => wrapper.get('[data-test="admin-console-link"]');
    // fetch 桩对 /api/site 回 `{"items":[]}` ⇒ 形状不对 ⇒ site 不可用 ⇒ fail-open 退回相对 hash。
    expect(link().attributes('href')).toBe('#/admin');
    useSiteStore().info = {
      userBaseUrl: 'http://station.fde.erix.vip:8090',
      adminBaseUrl: 'https://admin.fde.erix.vip:9443',
    };
    await flushPromises();
    expect(link().attributes('href')).toBe('https://admin.fde.erix.vip:9443#/admin');
  });

  it('切 English：管理台入口变英文，且被删掉的两句指路文案不会以任何形态回潮', async () => {
    // issue #332：zh / en 两侧的 `common.platformAdminHint`、`common.goToAdmin` 必须**成对消失**
    // （键集对齐另有 localeParity.spec 兜底，这里钉渲染结果）。
    const wrapper = await mountPanel({ noDir: true, adminUser: true });
    setLocale('en');
    await flushPromises();
    expect(wrapper.text()).toContain('Create a directory first');
    expect(wrapper.text()).not.toContain('Platform admin');
    expect(wrapper.text()).not.toContain('Go to admin console');
    expect(wrapper.get('[data-test="admin-console-link"]').text()).toBe('Admin console');
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

// ---------------------------------------------------------------------------
// issue #308（预览端口段搬进左栏底部，与目录树**各自独立**折叠）+ #468 追加 A（端口池面板退役）。
// 本套件钉四件事：
//   ① 三个几何钩子存在且位置正确（sidebar-aside / sidebar-session-list / sidebar-bottom-stack）；
//   ② 默认折叠态（进程监听段与目录树都收起、面板不占位、树不请求、但端口列表**照样拉一次**）；
//   ③ 进程监听折叠条与目录树互不影响（不共用总开关）；
//   ④ 几何/滚动预算：底部栈是唯一的底部滚动层，hostname 溢出不撑破 163px 宽（截断 + title 可达）。
//   另钉作用域（§3.4）：切目录不重发 GET /api/me/ports、列表不清空（端口跟工位走，不跟 cwd 走）。
// ⚠ #468 追加 A 改写点（原「双面板各自折叠」→ 只剩一个折叠条）：**断言一条没删**，只是把
//   「端口池折叠条」换成「进程监听折叠条」，并新增 S4（池面板段的两条钩子必须已消失）。
// ---------------------------------------------------------------------------
describe('SidebarPanel · 端口区块与底部堆叠区（issue #308 + #468 追加 A）', () => {
  const DIR: DirInfo[] = [{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }];
  const DIR_B: DirInfo[] = [{ name: 'b', cwd: '~/projects/b', running_count: 0, queued_count: 0 }];
  const UUID = (n: number) => `aaaaaaaa-0000-4000-8000-00000000220${n}`;

  /** 观测注解夹具（DTO 形）：`cwd` 传 null 表示跨 uid 读不到。 */
  function obs(cwd: string | null, pid: number | null = 412) {
    return {
      pid, cwd, cmd: cwd === null ? null : 'node vite', branch: null,
      started_at: null, observed_at: new Date().toISOString(),
    };
  }

  /** 行形状照 §4.7a：新后端**恒带** `observed` 键（值可为 null ⇒ 「池内没人听」，不是旧后端）。 */
  function portRow(n: number, state: string, observed: ReturnType<typeof obs> | null = null) {
    return {
      id: UUID(n),
      port: 22000 + n,
      hostname: `alice-p-${22000 + n}.fde.erix.vip`,
      url: `http://alice-p-${22000 + n}.fde.erix.vip:8090`,
      state,
      scope: 'fde',
      role: 'spare',
      exposure: 'private',
      observed,
    };
  }

  const THREE_PORTS = [portRow(0, 'allocated'), portRow(1, 'active'), portRow(2, 'active')];

  /** 按 URL 分派的 fetch 桩（记录 url/method）：/api/me/ports 给 items，其余给空列表。 */
  function stubRoutes(items: unknown[] = THREE_PORTS, portsStatus = 200) {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('/api/me/ports')) {
        const body = portsStatus === 200 ? { items } : { error: { code: 'db_unavailable', message: '数据库暂时不可用' } };
        return new Response(JSON.stringify(body), { status: portsStatus, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    return calls;
  }

  /** jsdom 的 Response.json 走 macrotask ⇒ 端口列表的落地要真推一次宏任务再冲微任务。 */
  const tick = async (ms = 30) => {
    await new Promise((r) => setTimeout(r, ms));
    await flushPromises();
  };

  const portsCalls = (calls: Array<{ url: string }>) =>
    calls.filter((c) => c.url.startsWith('/api/me/ports'));

  /** #468 追加 A：侧栏唯一的端口折叠条（旧的 preview-ports-toggle 已退役，见 S4）。 */
  const toggleOf = (wrapper: Awaited<ReturnType<typeof mountPanel>>) =>
    wrapper.get('[data-test="process-watch-toggle"]');
  /** 折叠面板本体（v-show ⇒ 恒在 DOM，收起时 display:none ⇒ 展开后才有可见行）。 */
  const procDisclosure = (wrapper: Awaited<ReturnType<typeof mountPanel>>) =>
    wrapper.get('#process-watch-disclosure');

  it('三个几何钩子存在且位置正确：根 = sidebar-aside，底部栈是根的末子，树在栈内末位', async () => {
    stubRoutes();
    const wrapper = await mountPanel({ dirs: DIR });
    const { root, kids, list, stack, tree } = paneEls(wrapper);
    expect(root.getAttribute('data-test')).toBe('sidebar-aside');
    expect(list.getAttribute('data-test')).toBe('sidebar-session-list');
    expect(stack.getAttribute('data-test')).toBe('sidebar-bottom-stack');
    expect(kids[2]).toBe(stack); // 固定头 → 列表 → 底部栈
    expect(stack.contains(tree)).toBe(true); // 树在栈内（端口段之后）
    expect(stack.contains(toggleOf(wrapper).element)).toBe(true); // 进程监听折叠条也在栈内（已离开顶栏）
    // 面板本体钩子保持（#246 既有契约，不许改名）
    expect(wrapper.find('[data-test="preview-ports-panel-body"]').exists()).toBe(true);
  });

  it('#468 S4（追加 A）：端口池面板整块退役 ⇒ preview-ports-toggle 与 preview-ports-disclosure 都不存在', async () => {
    stubRoutes();
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    expect(wrapper.find('[data-test="preview-ports-toggle"]').exists()).toBe(false);
    expect(wrapper.find('#preview-ports-disclosure').exists()).toBe(false);
    // 退役 ≠ 少一块就完事：折叠条上必须换成池用量两个数（见 S5）
    expect(wrapper.find('[data-test="pool-usage"]').exists()).toBe(true);
    // 全页只此一个端口折叠条（不留旧的一份）
    expect(wrapper.findAll('[data-test="process-watch-toggle"]')).toHaveLength(1);
  });

  it('默认折叠：进程监听段与目录树都收起；面板不占位；但端口列表照样拉一次（折叠也拉）', async () => {
    const calls = stubRoutes();
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();

    // 进程监听段：aria-expanded=false + v-show 收起（display:none ⇒ 不占垂直空间）
    expect(toggleOf(wrapper).attributes('aria-expanded')).toBe('false');
    expect((procDisclosure(wrapper).element as HTMLElement).style.display).toBe('none');

    // 目录树：折叠标记 ▸ + 树根层不请求（折叠不等于已加载）
    const { tree } = paneEls(wrapper);
    expect(tree.textContent).toContain('▸');
    expect(calls.filter((c) => c.url.startsWith('/api/files/tree'))).toHaveLength(0);

    // 折叠也拉：进视图即一次 GET /api/me/ports（#246 语义逐字保持）
    expect(portsCalls(calls)).toHaveLength(1);
    // 折叠态零签票（票 60 秒过期且一次性，绝不预取）
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // 折叠条收起态也给可用信息：条数 +（#468 追加 A）池用量
    expect(toggleOf(wrapper).text()).toContain('进程监听情况');
    expect(wrapper.get('[data-test="pool-usage"]').text()).toBe('端口池 3/3'); // 三条都没观测 ⇒ 全空闲
  });

  it('#468 折叠条计数 = 面板行数：池外观测合成行（url=null）不进池数、只进进程面板', async () => {
    stubRoutes([
      portRow(0, 'allocated', obs('~/projects/a')),
      portRow(1, 'active'),
      portRow(2, 'active'),
      { id: 'observed:5173', port: 5173, hostname: null, url: null, state: 'observed',
        scope: 'fde', role: 'unrouted', exposure: 'private',
        observed: obs('~/projects/a') },
    ]);
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    // total 只数 url 非空的行（合成行不算池成员），idle 只数其中无观测的
    expect(wrapper.get('[data-test="pool-usage"]').text()).toBe('端口池 3/2');
    expect(toggleOf(wrapper).text()).toContain('进程监听（2 个）'); // 当前项目 a 的两行（池内 1 + 池外合成 1）
    await toggleOf(wrapper).trigger('click');
    await tick();
    // 同一项目组内按 port ASC ⇒ 池外口 5173 排在 22000 前面（不是「池内的先说」）
    expect(wrapper.findAll('[data-test="preview-port-value"]').map((v) => v.text())).toEqual(['5173', '22000']);
  });

  it('#468 S5（追加 A）：夹具 10 行、其中 2 行有 observed ⇒ pool-usage 文本逐字 = 「端口池 10/8」', async () => {
    stubRoutes(Array.from({ length: 10 }, (_, n) => portRow(n, 'allocated', n < 2 ? obs('~/projects/a') : null)));
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    expect(wrapper.get('[data-test="pool-usage"]').text()).toBe('端口池 10/8');
  });

  it('#468 S7（追加 A）：pool-usage 的 title 与 aria-label 逐字相同，且给完整口径（含「空闲」与两个数字）', async () => {
    stubRoutes(Array.from({ length: 10 }, (_, n) => portRow(n, 'allocated', n < 2 ? obs('~/projects/a') : null)));
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    const usage = wrapper.get('[data-test="pool-usage"]');
    expect(usage.attributes('title')).toBe('端口池共 10 个，其中 8 个空闲（没有进程在监听）');
    expect(usage.attributes('aria-label')).toBe(usage.attributes('title'));
    expect(usage.attributes('aria-label')).toContain('空闲');
    expect(usage.attributes('title')).toContain('10');
    expect(usage.attributes('title')).toContain('8');
    // 可见文本是短形态（侧栏 163px 宽），完整口径靠 title/aria-label 可达
    expect(usage.text()).toBe('端口池 10/8');
  });

  it('#468 S6（追加 A）：未 loaded / 加载失败 ⇒ 池用量整段不渲染（绝不显示 0/0）', async () => {
    // ① 未 loaded：让 /api/me/ports 挂起（列表还没落地）
    const calls: Array<{ url: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url });
      if (url.startsWith('/api/me/ports')) return new Promise<Response>(() => {}); // 永不落地
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }));
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    expect(wrapper.find('[data-test="pool-usage"]').exists()).toBe(false);
    wrapper.unmount();

    // ② 加载失败：折叠条要在（错误必须有个地方说），但**不带**用量数字
    stubRoutes(THREE_PORTS, 503);
    const failed = await mountPanel({ dirs: DIR });
    await tick();
    expect(failed.find('[data-test="pool-usage"]').exists()).toBe(false);
    expect(failed.find('[data-test="process-watch-toggle"]').exists()).toBe(true);
    await toggleOf(failed).trigger('click');
    await tick();
    expect(failed.get('[data-test="preview-ports-error"]').text())
      .toContain('预览端口加载失败（db_unavailable）：数据库暂时不可用');
  });

  it('进程监听折叠条与目录树互不影响（不共用总开关）：展开端口不动树，收起端口不影响已展开的树', async () => {
    const calls = stubRoutes();
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    const { tree } = paneEls(wrapper);
    const treeToggle = Array.from(tree.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('目录树'))!;

    // 展开端口段：树仍然收起（▸），且没触发树的请求
    await toggleOf(wrapper).trigger('click');
    await tick();
    expect(toggleOf(wrapper).attributes('aria-expanded')).toBe('true');
    expect(treeToggle.textContent).toContain('▸');
    expect(calls.filter((c) => c.url.startsWith('/api/files/tree'))).toHaveLength(0);

    // 展开目录树：端口段仍展开（两个独立状态，不是二选一）
    treeToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(treeToggle.textContent).toContain('▾');
    expect(toggleOf(wrapper).attributes('aria-expanded')).toBe('true');
    expect(calls.filter((c) => c.url.startsWith('/api/files/tree')).length).toBeGreaterThan(0);

    // 收起端口段：树保持展开
    await toggleOf(wrapper).trigger('click');
    expect(toggleOf(wrapper).attributes('aria-expanded')).toBe('false');
    expect(treeToggle.textContent).toContain('▾');
  });

  it('只有一个滚动容器负责滚：底部栈是栈内唯一 overflow-y-auto，面板/树/端口行都不带滚动', async () => {
    stubRoutes([portRow(0, 'allocated', obs('~/projects/a'))]);
    const wrapper = await mountPanel({ dirs: DIR, sessions: [{ id: '1', title: 's1' }] });
    await tick();
    await toggleOf(wrapper).trigger('click');
    await tick();

    const { list, stack } = paneEls(wrapper);
    // 底部栈：唯一的高度/滚动预算层
    expect(stack.classList).toContain('max-h-[50vh]');
    expect(stack.classList).toContain('overflow-y-auto');
    // 栈内再没有第二个滚动容器（嵌套滚动会互相抢滚轮）
    const scrollersInStack = Array.from(stack.querySelectorAll<HTMLElement>('*'))
      .filter((el) => el.classList.contains('overflow-y-auto') || el.classList.contains('overflow-auto')
        || el.classList.contains('overflow-scroll'));
    expect(scrollersInStack.map((el) => el.getAttribute('data-test') ?? el.className)).toEqual([]);
    // 面板本体（list 形态）与目录树都不自带滚动/限高
    const body = wrapper.get('[data-test="preview-ports-panel-body"]').element as HTMLElement;
    for (const el of [body, body.querySelector('[data-test="preview-ports-list"]') as HTMLElement, paneEls(wrapper).tree]) {
      expect(el.classList.contains('overflow-y-auto')).toBe(false);
      expect(el.classList.contains('overflow-auto')).toBe(false);
      expect(el.classList.contains('max-h-72')).toBe(false);
    }
    // 列表段是另一处（互不嵌套的）独立滚动区
    expect(list.classList).toContain('overflow-y-auto');
    expect(stack.contains(list)).toBe(false);
  });

  it('hostname 溢出不撑破布局：紧凑行每层 min-w-0、hostname 是 block w-full truncate、title 是完整 url', async () => {
    // 侧栏现在只有进程面板 ⇒ 要有行可测，就得让行**带观测**（无观测的行不进事实面板，见 #468 D1）
    stubRoutes([
      portRow(0, 'allocated', obs('~/projects/a')),
      portRow(1, 'active', obs('~/projects/a')),
      portRow(2, 'active', obs('~/projects/a')),
    ]);
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    await toggleOf(wrapper).trigger('click');
    await tick();

    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows).toHaveLength(3);
    const row = rows[0];
    const hostname = row.get('[data-test="preview-port-hostname"]');
    // 可见文本是 hostname，完整 url 在 title 里（截断后可恢复 + 复制的是完整 url）
    expect(hostname.text()).toBe('alice-p-22000.fde.erix.vip');
    expect(hostname.attributes('title')).toContain('http://alice-p-22000.fde.erix.vip:8090');
    // 截断纪律：hostname 自己是 block w-full truncate，且它的祖先链都允许收缩（min-w-0）
    expect(hostname.classes()).toContain('truncate');
    expect(hostname.classes()).toContain('w-full');
    expect(hostname.classes()).toContain('min-w-0');
    expect(row.classes()).toContain('min-w-0');
    expect(row.element.firstElementChild!.classList).toContain('min-w-0');
    const body = wrapper.get('[data-test="preview-ports-panel-body"]');
    expect(body.classes()).toContain('min-w-0');
    // 4 列表格形态不进侧栏（163px 装不下，会把面板撑破）
    expect(wrapper.find('[data-test="preview-ports-table"]').exists()).toBe(false);
    // 短状态标签也允许收缩，完整口径在 title 上
    const state = row.get('[data-test="preview-port-state"]');
    expect(state.classes()).toContain('truncate');
    expect(state.classes()).toContain('min-w-0');
    expect(state.attributes('title')).toBe('已分配 · 待首次访问');
    // scopeHint 前言已删（用户裁定：列表只画在用端口，空态自己会说话，不需要解说行）
    expect(wrapper.text()).not.toContain('跟着你的工位走');
  });

  it('作用域：切目录不重发 GET /api/me/ports、池用量不变（端口跟工位走，不跟 cwd 走）', async () => {
    const calls = stubRoutes([
      portRow(0, 'allocated', obs('~/projects/a')),
      portRow(1, 'active', obs('~/projects/b')),
      portRow(2, 'active'),
    ]);
    const wrapper = await mountPanel({ dirs: DIR });
    await tick();
    await toggleOf(wrapper).trigger('click');
    await tick();
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(1); // 当前项目 a 那一行

    const store = useWorkbenchStore();
    store.dirs = [DIR[0], DIR_B[0]];
    store.dirCwd = DIR_B[0].cwd; // 切到另一个目录（树会 reload，端口列表数据不该动）
    await tick();

    expect(portsCalls(calls)).toHaveLength(1); // 仍然是进视图那一次
    // 池用量是**工位级**的：切目录不变（它跟列表走，不跟 cwd 走）
    expect(wrapper.get('[data-test="pool-usage"]').text()).toBe('端口池 3/1');
    // 面板行跟着项目换：a 的行换成 b 的行（不是清空、也不是原样不动）
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="preview-port-hostname"]').text()).toBe('alice-p-22001.fde.erix.vip');
  });

  // -------------------------------------------------------------------------
  // #468 D1/D2/D6：进程监听面板**跟随当前项目**（只显示当前项目 + 未知项目）。
  // 病根（真机取证）：当前项目是 hello-station 时，面板里同时躺着 probe-451 的 22001，
  // 而家目录里起的 22002 两处都不出现 ⇒ 既看不清现状，又丢了「有进程在听」这件事。
  // -------------------------------------------------------------------------
  describe('进程监听面板跟随当前项目（issue #468 S1–S3）', () => {
    /** 四个项目 + 两个未知项目形状的观测，端口互不重叠，便于按端口断言行集。 */
    const ROWS = [
      portRow(0, 'active', obs('~/projects/a')),                 // 项目 a 本体
      portRow(1, 'active', obs('~/projects/b')),                 // 项目 b
      { id: 'observed:5173', port: 5173, hostname: null, url: null, state: 'observed' as const,
        scope: 'fde', role: 'unrouted', exposure: 'private', observed: obs('~/projects/a/apps/web') }, // a 的子目录 + 池外
      { id: 'observed:8099', port: 8099, hostname: null, url: null, state: 'observed' as const,
        scope: 'fde', role: 'unrouted', exposure: 'private', observed: obs('~') },                      // 未知项目（家目录）
      { id: 'observed:8098', port: 8098, hostname: null, url: null, state: 'observed' as const,
        scope: 'fde', role: 'unrouted', exposure: 'private', observed: obs('/tmp') },                   // 未知项目（/tmp）
      { id: 'observed:34107', port: 34107, hostname: null, url: null, state: 'observed' as const,
        scope: 'fde', role: 'unrouted', exposure: 'private', observed: obs(null, null) },               // 未知项目（跨 uid）
      portRow(2, 'allocated'),                                    // 池内没人听 ⇒ 不进事实面板
    ];

    /** 展开进程面板并取当前可见端口（按出现顺序）。 */
    async function visiblePorts(wrapper: Awaited<ReturnType<typeof mountPanel>>) {
      const toggle = wrapper.get('[data-test="process-watch-toggle"]');
      if (toggle.attributes('aria-expanded') !== 'true') {
        await toggle.trigger('click');
        await tick();
      }
      return wrapper.findAll('#process-watch-disclosure [data-test="preview-port-value"]').map((v) => v.text());
    }

    it('#468 S1：dirCwd=~/projects/a ⇒ 只有 a（含子目录）与未知项目，b 不出现', async () => {
      stubRoutes(ROWS);
      const wrapper = await mountPanel({ dirs: DIR });
      await tick();
      // 组内 port ASC ⇒ 池外合成口 5173 排在 22000 前；未知组排最后（但仍在已知项目组之后、无空闲组）
      expect(await visiblePorts(wrapper)).toEqual(['5173', '22000', '8098', '8099', '34107']);
      // 别的项目真的不在（不是被排到后面）
      expect(wrapper.text()).not.toContain('22001');
      // 未知项目单列成一组并点名数量（三条：~、/tmp、cwd=null）
      expect(wrapper.get('[data-test="preview-port-group-unknown"]').text()).toContain('未知项目（3）');
    });

    it('#468 S2：切到 ~/projects/b ⇒ 行集随之变化（不是只换个徽章位置）', async () => {
      stubRoutes(ROWS);
      const wrapper = await mountPanel({ dirs: DIR });
      await tick();
      const store = useWorkbenchStore();
      store.dirs = [DIR[0], DIR_B[0]];

      const before = await visiblePorts(wrapper);
      store.dirCwd = DIR_B[0].cwd;
      await tick();
      const after = await visiblePorts(wrapper);

      expect(before).toContain('22000');
      expect(before).not.toContain('22001');
      expect(after).toContain('22001');
      expect(after).not.toContain('22000');
      expect(after).not.toContain('5173'); // a 的子目录口也不再沾光
      // 当前目录徽章确实跟着搬（原来挂在 a 组，现在挂 b 组）
      const headers = wrapper.findAll('#process-watch-disclosure [data-test="preview-port-group-header"]');
      expect(headers[0].text()).toContain('b');
      expect(headers[0].find('[data-test="preview-port-group-current"]').exists()).toBe(true);
      expect(headers[1].text()).toContain('未知项目（3）');
    });

    it('#468 S3：未知项目行在任何当前项目下都始终可见（一条都不许丢）', async () => {
      stubRoutes(ROWS);
      const store = useWorkbenchStore();
      store.dirs = [DIR[0], DIR_B[0]];
      for (const cwd of ['~/projects/a', '~/projects/b', '~', null]) {
        const wrapper = await mountPanel({ dirs: DIR });
        await tick();
        store.dirCwd = cwd;
        await tick();
        const ports = await visiblePorts(wrapper);
        expect(ports.filter((p) => ['8098', '8099', '34107'].includes(p)), `dirCwd=${cwd}`)
          .toEqual(['8098', '8099', '34107']);
        wrapper.unmount();
      }
    });

    it('#468 D6：未选项目（dirCwd=null）⇒ 不过滤（当前项目判不出来），未知组照旧单列', async () => {
      stubRoutes(ROWS);
      const wrapper = await mountPanel({ dirs: [], noDir: true });
      await tick();
      expect(await visiblePorts(wrapper)).toEqual(['5173', '22000', '22001', '8098', '8099', '34107']);
    });
  });
});
