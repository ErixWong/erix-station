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
    const onRetry = vi.fn();
    const error: PreviewApiError = {
      status: 401, code: 'unauthorized', message: '未登录或会话已过期', field: null,
    };
    wrapper = mountPanel({ items: [], loaded: true, error, onRetry });
    const alert = wrapper.get('[data-test="preview-ports-error"]');
    expect(alert.attributes('role')).toBe('alert');
    expect(alert.text()).toBe('预览端口加载失败（unauthorized）：未登录或会话已过期');
    await wrapper.get('[data-test="preview-ports-retry"]').trigger('click');
    expect(onRetry).toHaveBeenCalledTimes(1);
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

  it('#256② 批量签票 429 同样带秒数（双语成对：en 也有对应键）', () => {
    wrapper = mountPanel({
      batchError: { status: 429, code: 'rate_limited', message: '预览 ticket 签发过于频繁', field: null, retryAfter: 5 },
    });
    expect(wrapper.get('[data-test="preview-batch-error"]').text())
      .toBe('批量签发预览通行票失败（rate_limited）：预览 ticket 签发过于频繁（约 5 秒后可重试）');
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
    // 紧凑形态不重复区块标题（折叠条已经写了「预览端口」），但保留重试入口
    expect(wrapper.text()).not.toContain('预览端口');
    expect(wrapper.find('[data-test="preview-ports-retry"]').exists()).toBe(true);
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
    // 空态/错误文案与 table 形态同源（同一组件、同一份 i18n 键）
    expect(wrapper.get('[data-test="preview-ports-retry"]').text()).toBe('Retry');
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
// issue #247 / #286：「打开全部预览」动作 + 面向人的 Cookie 告知 + 批量拦截兜底。
// 判据：① 动作按钮双语成对、只在有行且允许时渲染、点击只 emit（面板不碰网络）；
// ② 批量拦截兜底是**可点链接列表**（N 个 href 都带票，不静默）；
// ③ 批量错误显示错误码 + 服务端原文；④ Cookie 告知双语成对、说的是「by design」不是 bug。
// ---------------------------------------------------------------------------
describe('PreviewPortsPanel · 一键开整组（#247）与 Cookie 告知（#286）', () => {
  it('「打开全部预览」渲染且只 emit open-all（面板自己不碰网络）', async () => {
    const onOpenAll = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    wrapper = mountPanel({ onOpenAll });
    const button = wrapper.get('[data-test="preview-open-all"]');
    expect(button.text()).toBe('打开全部预览');
    await button.trigger('click');
    expect(onOpenAll).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('列表为空或管理台代看形态（showOpenAll=false）⇒ 不渲染该动作', () => {
    wrapper = mountPanel({ items: [] });
    expect(wrapper.find('[data-test="preview-open-all"]').exists()).toBe(false);
    wrapper.unmount();

    wrapper = mountPanel({ showOpenAll: false });
    expect(wrapper.find('[data-test="preview-open-all"]').exists()).toBe(false);
  });

  it('批量签发中：按钮换成「批量签发中…」并禁用（防连点签两批）', () => {
    wrapper = mountPanel({ batchBusy: true });
    const button = wrapper.get('[data-test="preview-open-all"]');
    expect(button.text()).toBe('批量签发中…');
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('弹窗拦截兜底：每个被拦的地址都给一个可点链接（href 带票，target=_blank/rel=noopener）', () => {
    wrapper = mountPanel({
      batchBlockedUrls: [
        'http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_B',
        'http://alice-p-22002.fde.erix.vip:8090/?preview_ticket=pt_C',
      ],
    });
    const block = wrapper.get('[data-test="preview-batch-blocked"]');
    expect(block.attributes('role')).toBe('status');
    expect(block.text()).toContain('浏览器拦截了部分新标签');
    const links = wrapper.findAll('[data-test="preview-batch-fallback-link"]');
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.attributes('href'))).toEqual([
      'http://alice-p-22001.fde.erix.vip:8090/?preview_ticket=pt_B',
      'http://alice-p-22002.fde.erix.vip:8090/?preview_ticket=pt_C',
    ]);
    expect(links.map((link) => link.text())).toEqual([
      'alice-p-22001.fde.erix.vip:8090',
      'alice-p-22002.fde.erix.vip:8090',
    ]);
    for (const link of links) {
      expect(link.attributes('target')).toBe('_blank');
      expect(link.attributes('rel')).toBe('noopener');
    }
  });

  it('批量失败：错误码 + 服务端原文（不吞成「操作失败」）', () => {
    wrapper = mountPanel({
      batchError: { status: 400, code: 'validation_failed', message: '一次最多签发 10 张预览票', field: 'allocation_ids' },
    });
    expect(wrapper.get('[data-test="preview-batch-error"]').text())
      .toBe('批量签发预览通行票失败（validation_failed）：一次最多签发 10 张预览票');
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

  it('传 currentCwd + 观测可用 ⇒ **只显示**本目录在用的端口；其余整行不画也不给展开入口（用户裁定：10 端口全量是干扰项）', () => {
    wrapper = mountPanel({
      items: [
        portItem('a', 22000, { observed: null }),
        portItem('b', 22001, { observed: OBS_OTHER }),
        portItem('c', 22002, { observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/shop',
      variant: 'list',
    });
    const rows = wrapper.findAll('[data-test="preview-port-row"]');
    expect(rows.map((r) => r.get('[data-test="preview-port-value"]').text())).toEqual(['22002']);
    expect(wrapper.findAll('[data-test="preview-port-observed-here"]')).toHaveLength(1);
    // 主区行文案：目录已定 ⇒ 不重复报 cwd，改报 cmd（能看出是 vite 还是后端）。
    expect(rows[0].get('[data-test="preview-port-observed"]').text()).toContain('node vite.js');
    // 无折叠区：其余端口（22000/22001）整行不可见，也没有展开入口
    expect(wrapper.text()).not.toContain('22000');
    expect(wrapper.text()).not.toContain('22001');
    expect(wrapper.find('[data-test="preview-ports-others-toggle"]').exists()).toBe(false);
  });

  it('传 currentCwd 但本目录无在用端口 ⇒ 主区给「无在用」说明，不谎报空列表', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: null }), portItem('b', 22001, { observed: OBS_OTHER })],
      currentCwd: '~/projects/shop',
      variant: 'list',
    });
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(0);
    expect(wrapper.find('[data-test="preview-port-none-here"]').exists()).toBe(true);
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

  it('子目录命中：observed 在 ~/projects/shop/frontend 也算「当前目录（shop）在用」', () => {
    wrapper = mountPanel({
      items: [portItem('a', 22000, { observed: { ...OBS_SHOP, cwd: '~/projects/shop/frontend' } })],
      currentCwd: '~/projects/shop',
      variant: 'list',
    });
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(1);
    expect(wrapper.findAll('[data-test="preview-port-observed-here"]')).toHaveLength(1);
  });

  it('端口池外的观测合成行（url=null）：可识别在用，但无打开/复制按钮，只有说明句', () => {
    wrapper = mountPanel({
      items: [portItem('observed:5173', 5173, {
        hostname: null, url: null, state: 'observed', observed: { ...OBS_SHOP, cwd: '~/projects/shop' },
      })],
      currentCwd: '~/projects/shop',
      variant: 'list',
    });
    const row = wrapper.get('[data-test="preview-port-row"]');
    expect(row.find('[data-test="preview-port-observed-here"]').exists()).toBe(true);
    expect(row.find('[data-test="preview-port-open"]').exists()).toBe(false);
    expect(row.find('[data-test="preview-port-hostname"]').exists()).toBe(false);
    expect(row.get('[data-test="preview-port-unrouted"]').text()).toContain('端口');
  });

  it('非当前目录的端口（含池外合成行）整行不画（用户实证「未知状态+↗」干扰项的根治：不再渲染）', () => {
    wrapper = mountPanel({
      items: [
        portItem('a', 22000, { observed: OBS_OTHER }),
        portItem('observed:5173', 5173, { hostname: null, url: null, state: 'observed', observed: OBS_SHOP }),
      ],
      currentCwd: '~/projects/nowhere', // 两行都不命中 ⇒ 都不画，只剩「无在用」说明
      variant: 'list',
    });
    expect(wrapper.findAll('[data-test="preview-port-row"]')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('5173');
    expect(wrapper.text()).not.toContain('未知状态');
    expect(wrapper.find('[data-test="preview-port-none-here"]').exists()).toBe(true);
  });
});
