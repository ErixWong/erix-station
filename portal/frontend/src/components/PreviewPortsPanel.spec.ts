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

  it('#286 Cookie 告知：双语成对、说的是「边缘剥 Cookie / 用 Authorization / 不是故障」', async () => {
    wrapper = mountPanel();
    const notice = wrapper.get('[data-test="preview-cookie-notice"]').text();
    expect(notice).toContain('Cookie');
    expect(notice).toContain('Authorization');
    expect(notice).toContain('不是故障');
    expect(notice).not.toMatch(/bug|缺陷/i);

    setLocale('en');
    await wrapper.vm.$nextTick();
    const english = wrapper.get('[data-test="preview-cookie-notice"]').text();
    expect(english).toContain('Cookie');
    expect(english).toContain('Authorization');
    expect(english).toMatch(/by design, not a bug/);
    expect(english).not.toMatch(/[\u4e00-\u9fff]/);
    setLocale('zh-CN');
  });
});
