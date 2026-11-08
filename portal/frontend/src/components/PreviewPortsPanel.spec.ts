// PreviewPortsPanel 单测（#246 交付② 单 B）——纯展示组件（数据与动作在调用方），
// 钉四态渲染与「state 文案口径」：
//   ① 3 条 items ⇒ 3 行，且 port / hostname / state 都在 DOM 上；
//   ② state 文案**不得**出现「健康 / 运行中」（active 只代表首次放行过，§4.7a）；未知取值原样透传；
//   ③ 加载中 / 空（本人与代看两种口径）/ 失败（显示后端错误码 + 原文 + 重试）都有可见反馈；
//   ④ 「打开预览」只 emit 该行的 allocation id（签票时机由调用方决定，面板自己不碰网络）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import PreviewPortsPanel from './PreviewPortsPanel.vue';
import { i18n, setLocale } from '../i18n';
import type { PreviewApiError, PreviewPortItem } from '../lib/previewPorts';

function portItem(id: string, port: number, overrides: Partial<PreviewPortItem> = {}): PreviewPortItem {
  return {
    id,
    port,
    hostname: `alice-p-${port}.fde.erix.vip`,
    url: `http://alice-p-${port}.fde.erix.vip:8090`,
    state: 'allocated',
    scope: 'fde',
    role: 'spare',
    exposure: 'private',
    ...overrides,
  };
}

const ITEMS = [
  portItem('id-22000', 22000),
  portItem('id-22001', 22001, { state: 'active' }),
  portItem('id-22002', 22002, { state: 'active' }),
];

function mountPanel(overrides: Partial<Record<string, unknown>> = {}) {
  return mount(PreviewPortsPanel, {
    props: {
      items: ITEMS,
      loading: false,
      loaded: true,
      error: null,
      ticketBusyId: null,
      ticketError: null,
      popupBlockedUrl: null,
      scope: 'me',
      fdeName: null,
      ...overrides,
    },
    global: { plugins: [i18n] },
  });
}
function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('PreviewPortsPanel · 列表渲染', () => {
  it('3 条 items ⇒ 3 行，port / hostname / state 逐项可见', () => {
    wrapper = mountPanel();
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.get('[data-test="preview-port-value"]').text()))
      .toEqual(['22000', '22001', '22002']);
    expect(rows[1].get('[data-test="preview-port-hostname"]').text())
      .toBe('alice-p-22001.fde.erix.vip');
    expect(rows.map((row) => row.get('[data-test="preview-port-state"]').text()))
      .toEqual(['已分配 · 待首次访问', '已放行过（仅表示首次放行过）', '已放行过（仅表示首次放行过）']);
    // 每行一个「打开预览」，且带 title 说明点域名是复制完整 url
    expect(wrapper.findAll('[data-test="preview-port-open"]')).toHaveLength(3);
    expect(rows[0].get('[data-test="preview-port-hostname"]').attributes('title'))
      .toContain('http://alice-p-22000.fde.erix.vip:8090');
  });

  it('state 文案里不出现「健康 / 运行中」，并给出「仅代表首次放行过」的口径说明', () => {
    wrapper = mountPanel();
    const states = wrapper.findAll('[data-test="preview-port-state"]').map((node) => node.text());
    for (const text of states) {
      expect(text).not.toMatch(/健康/);
      expect(text).not.toMatch(/运行中/);
    }
    expect(wrapper.text()).toContain('「已放行过」只表示该端口首次凭证放行过');
  });

  it('工作台紧凑形态不渲染放行语义注释（用户裁定：监听事实由观测注解回答，向业务用户解释黑话是噪音）', () => {
    wrapper = mountPanel({ variant: 'list' });
    expect(wrapper.find('[data-test="preview-port-row"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('「已放行过」只表示');
  });

  it('未知 state 取值原样透传（不猜语义，也不误标成已放行过）', () => {
    wrapper = mountPanel({ items: [portItem('x', 22003, { state: 'released' })] });
    expect(wrapper.get('[data-test="preview-port-state"]').text()).toBe('未知状态（released）');
  });

  it('面板自己不碰网络：点「打开预览」只抛出该行的 item（签票时机由调用方决定）', async () => {
    // 事件断言走父级 onOpen 回调：emitted() 对本环境（vitest 5）的 script-setup 组件不记录，
    // 仓库先例（SessionPickerModal.spec）同样不用 emitted()。
    const onOpen = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    wrapper = mountPanel({ onOpen });
    await wrapper.findAll('[data-test="preview-port-open"]')[2].trigger('click');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ id: 'id-22002', port: 22002 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('签票进行中：该行显示「签发中…」并禁用全部按钮（一次只签一张票）', () => {
    wrapper = mountPanel({ ticketBusyId: 'id-22001' });
    const buttons = wrapper.findAll('[data-test="preview-port-open"]');
    expect(buttons.map((button) => (button.element as HTMLButtonElement).disabled)).toEqual([true, true, true]);
    expect(buttons[1].text()).toBe('签发通行票…');
    expect(buttons[0].text()).toBe('打开预览');
  });
});

describe('PreviewPortsPanel · 加载中 / 空 / 失败三态', () => {
  it('首屏加载中：骨架 + 加载文案，不渲染表格', () => {
    wrapper = mountPanel({ items: [], loading: true, loaded: false });
    expect(wrapper.find('[data-test="preview-ports-loading"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('加载中…');
    expect(wrapper.find('[data-test="preview-ports-table"]').exists()).toBe(false);
  });

  it('本人空列表 ⇒ 「你还没有预览端口」；代看空列表 ⇒ 「该 FDE 没有活着的预览端口」', () => {
    wrapper = mountPanel({ items: [] });
    expect(wrapper.find('[data-test="preview-ports-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="preview-ports-empty"]').text()).toContain('你还没有预览端口');
    wrapper.unmount();

    wrapper = mountPanel({ items: [], scope: 'fde', fdeName: 'alice' });
    expect(wrapper.get('[data-test="preview-ports-empty"]').text()).toContain('该 FDE 没有活着的预览端口');
    expect(wrapper.get('[data-test="preview-ports-panel-body"]').text()).toContain('alice 的预览端口');
  });

  it('失败：显示错误码 + 服务端 message 原文 + 可重试（admin 没有 FDE 是空列表，不是失败）', async () => {
    const error: PreviewApiError = {
      status: 401, code: 'unauthorized', message: '未登录或会话已过期', field: null,
    };
    wrapper = mountPanel({ items: [], loaded: true, error });
    const alert = wrapper.get('[data-test="preview-ports-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe('预览端口加载失败（unauthorized）：未登录或会话已过期');
    // 重试按钮已退场：列表自动轮询保鲜（usePreviewPorts 30s + 回前台即刷），错误无需人手点击
    expect(wrapper.find('[data-test="preview-ports-retry"]').exists()).toBe(false);
  });

  it('已有列表时失败：旧列表保留 + 错误条（不闪成空白）', () => {
    const error: PreviewApiError = { status: 500, code: 'internal_error', message: 'boom', field: null };
    wrapper = mountPanel({ error });
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(3);
    expect(wrapper.get('[data-test="preview-ports-error"]').text()).toContain('（internal_error）：boom');
  });
});

describe('PreviewPortsPanel · 复制与兜底反馈', () => {
  it('点域名复制的是完整 url（含 scheme 与 dev 端口），并给出已复制反馈', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    wrapper = mountPanel();
    await wrapper.findAll('[data-test="preview-port-hostname"]')[1].trigger('click');
    expect(writeText).toHaveBeenCalledWith('http://alice-p-22001.fde.erix.vip:8090');
    expect(wrapper.get('[data-test="preview-port-copied"]').text()).toContain('预览地址已复制');
  });

  it('剪贴板不可用时显示「复制失败：」而不是静默', async () => {
    stubClipboard(async () => { throw new Error('Document is not focused'); });
    wrapper = mountPanel();
    await wrapper.findAll('[data-test="preview-port-hostname"]')[0].trigger('click');
    expect(wrapper.get('[data-test="preview-port-copy-error"]').text()).toContain('复制失败：');
    expect(wrapper.get('[data-test="preview-port-copy-error"]').text()).toContain('Document is not focused');
  });

  it('签票失败显示错误码与原文；弹窗被拦给出带票的兜底链接（href 里带 ticket）', () => {
    wrapper = mountPanel({
      ticketError: { status: 429, code: 'rate_limited', message: '预览 ticket 签发过于频繁', field: null },
      popupBlockedUrl: 'http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_x',
    });
    expect(wrapper.get('[data-test="preview-ticket-error"]').text())
      .toBe('签发预览通行票失败（rate_limited）：预览 ticket 签发过于频繁');
    const link = wrapper.get('[data-test="preview-popup-fallback-link"]');
    expect(link.attributes('href')).toBe('http://alice-p-22000.fde.erix.vip:8090?preview_ticket=pt_x');
    expect(link.attributes('target')).toBe('_blank');
    expect(link.attributes('rel')).toBe('noopener');
  });

  it('#256② 429 带 Retry-After：签票失败文案说出秒数；缺头 / 非有限数退到不带秒数的文案（不演 undefined/NaN）', () => {
    wrapper = mountPanel({
      ticketError: { status: 429, code: 'rate_limited', message: '预览 ticket 签发过于频繁', field: null, retryAfter: 37 },
    });
    expect(wrapper.get('[data-test="preview-ticket-error"]').text())
      .toBe('签发预览通行票失败（rate_limited）：预览 ticket 签发过于频繁（约 37 秒后可重试）');

    wrapper.unmount();
    wrapper = mountPanel({
      ticketError: { status: 429, code: 'rate_limited', message: '预览 ticket 签发过于频繁', field: null, retryAfter: null },
    });
    const noHeader = wrapper.get('[data-test="preview-ticket-error"]').text();
    expect(noHeader).toBe('签发预览通行票失败（rate_limited）：预览 ticket 签发过于频繁');
    expect(noHeader).not.toContain('秒后可重试');

    wrapper.unmount();
    wrapper = mountPanel({
      // 头不可解 / 脏数据：仍不许把 NaN 演给用户
      ticketError: { status: 429, code: 'rate_limited', message: 'x', field: null, retryAfter: Number.NaN },
    });
    const dirty = wrapper.get('[data-test="preview-ticket-error"]').text();
    expect(dirty).not.toContain('NaN');
    expect(dirty).not.toContain('undefined');
  });

  it('切到 English：表头与 state 文案同步换英文（仍不出现 healthy/running）', async () => {
    wrapper = mountPanel();
    setLocale('en');
    await wrapper.vm.$nextTick();
    expect(wrapper.findAll('thead th').map((th) => th.text()))
      .toEqual(['Port', 'Preview host', 'State', 'Actions']);
    const states = wrapper.findAll('[data-test="preview-port-state"]').map((node) => node.text());
    expect(states[0]).toBe('Allocated · not opened yet');
    for (const text of states) expect(text).not.toMatch(/healthy|running/i);
    setLocale('zh-CN');
  });
});

// ---------------------------------------------------------------------------
// issue #308：variant='list'（左侧栏紧凑形态，内容宽约 163px）。
// 形态分叉只发生在行/表格模板上：状态口径、错误文案、空态、复制/签票语义仍只有一份
// ⇒ 这里钉「短标签 + 完整口径在 title/aria-label」「行内宽度可收缩」「图标按钮的语义与禁用态」。
// ---------------------------------------------------------------------------
describe('PreviewPortsPanel · 侧栏紧凑形态（variant=list，issue #308）', () => {
  const listPanel = (overrides: Partial<Record<string, unknown>> = {}) =>
    mountPanel({ variant: 'list', ...overrides });

  it('渲染紧凑行而不是 4 列表格：端口 + 短状态（完整口径在 title/aria-label）+ 可截断 hostname', () => {
    wrapper = listPanel();
    expect(wrapper.find('[data-test="preview-ports-table"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="preview-ports-list"]').element.tagName.toLowerCase()).toBe('ul');
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.get('[data-test="preview-port-value"]').text()))
      .toEqual(['22000', '22001', '22002']);
    const states = rows.map((row) => row.get('[data-test="preview-port-state"]'));
    expect(states.map((node) => node.text())).toEqual(['待首次访问', '已放行过', '已放行过']);
    expect(states.map((node) => node.attributes('title')))
      .toEqual(['已分配 · 待首次访问', '已放行过（仅表示首次放行过）', '已放行过（仅表示首次放行过）']);
    expect(states.map((node) => node.attributes('aria-label')))
      .toEqual(states.map((node) => node.attributes('title')));
    // 不得只靠颜色传达：文案里也不出现「健康/运行中」
    for (const node of states) {
      expect(node.text()).not.toMatch(/健康|运行中/);
      expect(node.attributes('title')).not.toMatch(/健康|运行中/);
    }
    // hostname：可见 hostname、title 完整 url、可截断（truncate + min-w-0 + w-full）
    const hostname = rows[0].get('[data-test="preview-port-hostname"]');
    expect(hostname.text()).toBe('alice-p-22000.fde.erix.vip');
    expect(hostname.attributes('title')).toBe('http://alice-p-22000.fde.erix.vip:8090（点击复制完整地址）');
    expect(hostname.classes()).toEqual(expect.arrayContaining(['truncate', 'min-w-0', 'w-full']));
    // 紧凑形态不重复区块标题（折叠条已经写了「预览端口」），也没有任何操作按钮
    expect(wrapper.text()).not.toContain('预览端口');
    expect(wrapper.find('[data-test="preview-ports-retry"]').exists()).toBe(false);
  });

  it('紧凑形态的「打开预览」是图标按钮：默认 title/aria-label=打开预览，签票中该行换「签发通行票…」且全部禁用', async () => {
    const onOpen = vi.fn();
    wrapper = listPanel({ onOpen });
    const buttons = wrapper.findAll('[data-test="preview-port-open"]');
    expect(buttons.map((b) => b.attributes('title'))).toEqual(['打开预览', '打开预览', '打开预览']);
    expect(buttons[0].text()).toBe(''); // 纯图标（宽度预算）
    expect(buttons[0].find('svg').exists()).toBe(true);
    await buttons[1].trigger('click');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen.mock.calls[0]![0]).toMatchObject({ id: 'id-22001' });
    wrapper.unmount();

    wrapper = listPanel({ ticketBusyId: 'id-22001' });
    const busy = wrapper.findAll('[data-test="preview-port-open"]');
    expect(busy.map((b) => (b.element as HTMLButtonElement).disabled)).toEqual([true, true, true]);
    expect(busy[1].attributes('title')).toBe('签发通行票…');
    expect(busy[1].find('svg.animate-spin').exists()).toBe(true);
    expect(busy[0].attributes('title')).toBe('打开预览');
  });

  it('紧凑形态：未知 state 走短标签兜底（原值仍在 title）；切 en 短标签对译且不出现 healthy/running', async () => {
    wrapper = listPanel({ items: [portItem('x', 22003, { state: 'released' })] });
    const state = wrapper.get('[data-test="preview-port-state"]');
    expect(state.text()).toBe('未知状态');
    expect(state.attributes('title')).toBe('未知状态（released）'); // 不猜语义、原值透传
    wrapper.unmount();

    wrapper = listPanel();
    setLocale('en');
    await wrapper.vm.$nextTick();
    const labels = wrapper.findAll('[data-test="preview-port-state"]').map((node) => node.text());
    expect(labels).toEqual(['Not opened', 'Admitted', 'Admitted']);
    for (const node of wrapper.findAll('[data-test="preview-port-state"]')) {
      expect(`${node.text()} ${node.attributes('title')}`).not.toMatch(/healthy|running/i);
    }
    setLocale('zh-CN');
  });

  it('紧凑形态复制：点 hostname 复制的是完整 url（含 scheme 与端口）', async () => {
    const writeText = vi.fn(async () => undefined);
    stubClipboard(writeText);
    wrapper = listPanel();
    await wrapper.findAll('[data-test="preview-port-hostname"]')[2].trigger('click');
    expect(writeText).toHaveBeenCalledWith('http://alice-p-22002.fde.erix.vip:8090');
    expect(wrapper.get('[data-test="preview-port-copied"]').text()).toContain('预览地址已复制');
  });
});

// ---------------------------------------------------------------------------
// #247「打开全部预览」与 #286 Cookie 告知双双退出人侧界面：
// 批量链是探测时代（分不清哪个口有服务 ⇒ 10 标签盲开）的遗产；Cookie 事实的读者是 agent。
// ---------------------------------------------------------------------------
describe('PreviewPortsPanel · 历史动作退场（#247 批量 / #286 Cookie 告知）', () => {
  it('不再渲染「打开全部预览」与重试按钮（列表自动保鲜，盲开无存在理由）', () => {
    wrapper = mountPanel();
    expect(wrapper.find('[data-test="preview-open-all"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="preview-ports-retry"]').exists()).toBe(false);
  });

  it('#286 Cookie 告知已退出人侧界面（技术事实只留在 agent 侧 ~/AGENTS.md，不进 UI）', () => {
    wrapper = mountPanel();
    expect(wrapper.find('[data-test="preview-cookie-notice"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Cookie');
  });
});

// ---------------------------------------------------------------------------
// 观测层 MVP（迁移 0022）：`observed` 注解 + 同目录多实例警告 + 本目录优先排序。
// 红线：无观测的行**不渲染任何反向文案**（null ≠ 空闲——旧 agentd/未跑迁移的部署也是 null）。
// ---------------------------------------------------------------------------
describe('观测层注解（observed）', () => {
  const OBS_SHOP = {
    pid: 412, cwd: '~/projects/shop', cmd: 'node vite.js', branch: 'feat-x',
    started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    observed_at: new Date().toISOString(),
  };
  const OBS_SHOP_FEAT = { ...OBS_SHOP, pid: 877, cwd: '~/projects/shop', branch: 'main' };
  const OBS_OTHER = { ...OBS_SHOP, cwd: '~/projects/other', branch: null };

  it('有观测 ⇒ 行内渲染 cwd/分支/起了多久；无观测的行不出现观测节点', async () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: OBS_SHOP }), portItem('b', 22001)],
    });
    const lines = wrapper.findAll('[data-test="preview-port-observed"]');
    expect(lines).toHaveLength(1);
    expect(lines[0].text()).toContain('~/projects/shop');
    expect(lines[0].text()).toContain('@feat-x');
    expect(lines[0].text()).toMatch(/已运行 3h/);
    expect(lines[0].attributes('title')).toContain('node vite.js');
  });

  it('同目录 ≥2 个监听 ⇒ 顶部警告点名两个端口（两个分支各占一口的现场）', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: OBS_SHOP }), portItem('b', 22001, { observed: OBS_SHOP_FEAT }), portItem('c', 22002, { observed: OBS_OTHER })],
    });
    const warn = wrapper.get('[data-test="preview-observed-duplicates"]').text();
    expect(warn).toContain('~/projects/shop');
    expect(warn).toContain('22000');
    expect(warn).toContain('22001');
    expect(warn).not.toContain('~/projects/other'); // 单实例目录不进警告
  });

  it('分组模式 ⇒ 按项目根分组：当前目录组排最前挂「当前目录」徽章，其余目录各成一组，池内未用收进「空闲」组', () => {
    wrapper = mountPanel({
      items: [
        portItem('a', 22000, { observed: null }),
        portItem('b', 22001, { observed: OBS_OTHER }),
        portItem('c', 22002, { observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    const headers = wrapper.findAll('[data-test="preview-port-group-header"]').map((h) => h.text());
    expect(headers).toEqual(['shop当前目录', 'other', '空闲（1）']);
    expect(wrapper.find('[data-test="preview-port-group-current"]').exists()).toBe(true);
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows.map((r) => r.get('[data-test="preview-port-value"]').text())).toEqual(['22002', '22001', '22000']);
    // 行文案：目录由分组头承担 ⇒ 行内只报 cmd/分支（能看出是 vite 还是后端）
    expect(rows[0].get('[data-test="preview-port-observed"]').text()).toContain('node vite.js');
    expect(rows[0].get('[data-test="preview-port-observed"]').text()).not.toContain('~/projects/shop');
  });

  it('当前目录无在用端口 ⇒ 不挂「当前目录」徽章、不谎报；空闲组照旧（池内未用 ≠ 无地址）', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: null }), portItem('b', 22001, { observed: OBS_OTHER })],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    expect(wrapper.find('[data-test="preview-port-group-current"]').exists()).toBe(false);
    const headers = wrapper.findAll('[data-test="preview-port-group-header"]').map((h) => h.text());
    expect(headers).toEqual(['other', '空闲（1）']);
  });

  it('旧后端（DTO 无 observed 键）⇒ **不过滤**，全量展示与改动前同形', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000), portItem('b', 22001)], // 无 observed 键 = 未跑 0022
      currentCwd: '~/projects/shop',
      variant: 'list',
    });
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(2);
    expect(wrapper.find('[data-test="preview-ports-others-toggle"]').exists()).toBe(false);
  });

  it('不传 currentCwd（管理台代看）⇒ 不过滤，只做「有观测优先」，组内维持 port ASC', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000), portItem('b', 22001, { observed: OBS_OTHER }), portItem('c', 22002)],
      scope: 'fde',
      fdeName: 'bob',
    });
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows.map((r) => r.get('[data-test="preview-port-value"]').text())).toEqual(['22001', '22000', '22002']);
    expect(wrapper.findAll('[data-test="preview-port-observed-here"]')).toHaveLength(0);
  });

  it('子目录归并：observed 在 ~/projects/shop/frontend 的行归进 shop 组并挂「当前目录」徽章', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: { ...OBS_SHOP, cwd: '~/projects/shop/frontend' } })],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    const headers = wrapper.findAll('[data-test="preview-port-group-header"]');
    expect(headers).toHaveLength(1);
    expect(headers[0].text()).toContain('shop');
    expect(headers[0].find('[data-test="preview-port-group-current"]').exists()).toBe(true);
  });

  it('端口池外的观测合成行（url=null）：可识别在用，但无打开/复制按钮，只有说明句', () => {
    wrapper = mountPanel({
      items: [portItem('observed:5173', 5173, {
        hostname: null, url: null, state: 'observed', observed: { ...OBS_SHOP, cwd: '~/projects/shop' },
      })],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    expect(wrapper.find("[data-test=\"preview-port-group-current\"]").exists()).toBe(true);
    const row = wrapper.get('[data-test="preview-port-row"]');
    expect(row.find('[data-test="preview-port-open"]').exists()).toBe(false);
    expect(row.find('[data-test="preview-port-hostname"]').exists()).toBe(false);
    expect(row.get('[data-test="preview-port-unrouted"]').text()).toContain('端口');
  });

  it('池外合成行（url=null）归进程面板：可识别在用，但无打开/复制按钮，只有说明句（#468 追加 A 后仍是这条分工）', () => {
    const all = [
      portItem('a', 22000, { observed: OBS_OTHER }),
      portItem('observed:5173', 5173, { hostname: null, url: null, state: 'observed', observed: OBS_SHOP }),
    ];
    // #468 追加 A：侧栏只剩「进程监听」这一个面板（端口池面板退役）⇒ 面板在侧栏的唯一用法就是有观测的行。
    // 池外合成行仍然归它，且仍然没有按钮、只有说明句（不出现「未知状态」徽章）。
    wrapper = mountPanel({ items: all, currentCwd: '~/projects/shop', variant: 'list', groupByProject: true });
    const headers = wrapper.findAll('[data-test="preview-port-group-header"]').map((h) => h.text());
    expect(headers).toEqual(['shop当前目录', 'other']);
    const unrouted = wrapper.get('[data-test="preview-port-unrouted"]');
    expect(unrouted.text()).toContain('端口');
    expect(wrapper.text()).not.toContain('未知状态');
  });
});

// ---------------------------------------------------------------------------
// #468 D2/D3/D7：反推不出项目的观测**单列成「未知项目（N）」组**（不丢、不只写在 tooltip 里），
// 且行内细节全不可读时给「进程细节不可读（跨用户）」而不是空白行。
// ---------------------------------------------------------------------------
describe('#468 · 未知项目组与不可读细节', () => {
  const OBS_SHOP = {
    pid: 412, cwd: '~/projects/shop', cmd: 'node vite.js', branch: 'feat-x',
    started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    observed_at: new Date().toISOString(),
  };
  const OBS_OTHER = { ...OBS_SHOP, pid: 555, cwd: '~/projects/other', branch: null };
  const OBS_HOME = {
    pid: 611, cwd: '~', cmd: 'python3 -m http.server 22002', branch: null,
    started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), observed_at: new Date().toISOString(),
  };
  const OBS_TMP = { ...OBS_HOME, pid: 612, cwd: '/tmp', cmd: 'python3 -m http.server' };
  const OBS_SHOP_SUB = { ...OBS_SHOP, cwd: '~/projects/shop/apps/web', pid: 900 };
  const OBS_CROSS_UID = { pid: null, cwd: null, cmd: null, branch: null, started_at: null, observed_at: new Date().toISOString() };

  it('#468 P1（D2）：cwd="~" 的观测 ⇒ 出现 preview-port-group-unknown，组头点名「未知项目」与数量，行在 DOM 里', () => {
    wrapper = mountPanel({
      items: [
        portItem('a', 22002, { hostname: null, url: null, state: 'observed', observed: OBS_HOME }),
        portItem('b', 22000, { observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    const unknown = wrapper.get('[data-test="preview-port-group-unknown"]');
    expect(unknown.text()).toContain('未知项目');
    expect(unknown.text()).toContain('1');
    // 行本身必须在 DOM 上（不是只留一个组头），且带着那台 http.server
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows).toHaveLength(2);
    expect(wrapper.text()).toContain('22002');
    expect(wrapper.text()).toContain('python3 -m http.server 22002');
    // 未知组也是「分组头 + 行」的形态 ⇒ 通用钩子同样能数到它（组头共 2 个：shop + 未知项目）
    expect(wrapper.findAll('[data-test="preview-port-group-header"]')).toHaveLength(2);
  });

  it('#468 P2（D2/D3）：组顺序 = 当前项目组 → 其它项目组 → **未知项目组** → 空闲组', () => {
    wrapper = mountPanel({
      items: [
        portItem('spare', 22003, { observed: null }),                       // 池内未用 → 空闲组
        portItem('home', 22002, { hostname: null, url: null, state: 'observed', observed: OBS_HOME }),
        portItem('other', 22001, { observed: OBS_OTHER }),
        portItem('shop-sub', 22005, { observed: OBS_SHOP_SUB }),            // 子目录 ⇒ 归 shop
        portItem('tmp', 8099, { hostname: null, url: null, state: 'observed', observed: OBS_TMP }),
        portItem('shop', 22000, { observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    expect(wrapper.findAll('[data-test="preview-port-group-header"]').map((h) => h.text()))
      .toEqual(['shop当前目录', 'other', '未知项目（2）', '空闲（1）']);
    // 行序（组内 port ASC）：shop 22000/22005 → other 22001 → 未知 8099/22002 → 空闲 22003
    expect(wrapper.findAll('[data-test="preview-port-value"]').map((v) => v.text()))
      .toEqual(['22000', '22005', '22001', '8099', '22002', '22003']);
    // 未知组不是「空闲」：两行都带观测文案，且组头数量 = 2（一条都不能少）
    expect(wrapper.findAll('[data-test="preview-port-observed"]')).toHaveLength(5);
  });

  it('#468 P3（D7）：pid/cwd/cmd/branch 全 null 的观测 ⇒ 行文案是「进程细节不可读（跨用户）」，不是空白/undefined', () => {
    wrapper = mountPanel({
      items: [portItem('x', 34107, { hostname: null, url: null, state: 'observed', observed: OBS_CROSS_UID })],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    const line = wrapper.get('[data-test="preview-port-observed"]');
    expect(line.text()).toBe('进程细节不可读（跨用户）');
    expect(line.text()).not.toContain('undefined');
    // 细节全不可读 ⇒ cwd 也读不到 ⇒ 这一行必然落进「未知项目」组（D2 与 D7 在这里是同一件事的两面）。
    expect(wrapper.text()).toContain('未知项目（1）');
    // 非分组/主区形态（else 支）同样不许空行
    wrapper.unmount();
    wrapper = mountPanel({ items: [portItem('y', 34108, { observed: OBS_CROSS_UID })] });
    expect(wrapper.get('[data-test="preview-port-observed"]').text()).toBe('进程细节不可读（跨用户）');
  });

  it('#468 P3b（D7，从 erix 线搬来）：表格形态（管理台）同样给「进程细节不可读（跨用户）」，不留空格', () => {
    // 管理台是 `variant='table'`：细节全 null 时同样不许空单元格（P3 只盖了 list / 平铺两种形态）。
    wrapper = mountPanel({ items: [portItem('x', 34107, { observed: OBS_CROSS_UID })], variant: 'table' });
    expect(wrapper.get('[data-test="preview-port-observed"]').text()).toBe('进程细节不可读（跨用户）');
  });

  it('#468 P5：未知项目组里的行挂黄色叹号（含完整 title/aria-label），已知项目的行不挂', () => {
    wrapper = mountPanel({
      items: [
        portItem('a', 22002, { hostname: null, url: null, state: 'observed', observed: OBS_HOME }),
        portItem('b', 22000, { observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,
    });
    const marks = wrapper.findAll('[data-test="preview-port-unknown-mark"]');
    expect(marks).toHaveLength(1); // 只有未知项目那一行
    expect(marks[0].text()).toBe('!');
    expect(marks[0].attributes('title')).toBe('这个进程不属于当前项目');
    expect(marks[0].attributes('aria-label')).toBe('这个进程不属于当前项目');
    // 已知项目那一行不许挂：叹号是「不是你的项目」的提示，不能变成每行装饰
    const shopRow = wrapper.findAll('[data-test="preview-port-row"]').find((r) => r.text().includes('22000'));
    expect(shopRow!.find('[data-test="preview-port-unknown-mark"]').exists()).toBe(false);
  });

  it('#468 P4：旧后端（DTO 无 observed 键）⇒ 平铺、无组头、行序与排序权重逐字不变', () => {
    wrapper = mountPanel({
      // 三条**都没有** `observed` 键 = 未跑 0022 的旧后端 ⇒ observationsAvailable=false ⇒ 分组自动失效。
      items: [portItem('a', 22000), portItem('b', 22001), portItem('c', 22002)],
      currentCwd: '~/projects/shop',
      variant: 'list',
      groupByProject: true,   // 即便要求分组，无观测可用 ⇒ 自动退回平铺（不出现任何组头）
    });
    expect(wrapper.findAll('[data-test="preview-port-group-header"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="preview-port-group-unknown"]').exists()).toBe(false);
    // 无观测 ⇒ rank 全为 2 ⇒ 只按 port ASC（与改动前逐字相同，没有新组、没有新排序权重）
    expect(wrapper.findAll('[data-test="preview-port-value"]').map((v) => v.text())).toEqual(['22000', '22001', '22002']);
  });
});
