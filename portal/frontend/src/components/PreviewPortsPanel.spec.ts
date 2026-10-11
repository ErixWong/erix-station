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
