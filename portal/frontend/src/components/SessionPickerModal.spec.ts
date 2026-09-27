// SessionPickerModal 单测（issue #94）：dialog 语义与焦点管理、结果行渲染、键盘导航（↑↓/Enter/Esc）、
// 范围切换、三态（加载中/无结果/失败保留旧列表+重试）、总数显示、移动端全屏层与滚动锁定。
// 事件断言用父级 onSelect/onClose 回调（emitted() 对本环境 script-setup 组件不记录，仓库先例亦不用）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SessionPickerModal from './SessionPickerModal.vue';

interface BodyItem {
  id: string;
  title?: string;
  cwd?: string;
  updated_at?: string;
  active_run_id?: string | null;
}

const ITEMS: BodyItem[] = [
  { id: 's1', title: '部署脚本', cwd: '~/projects/demo', updated_at: new Date().toISOString(), active_run_id: null },
  { id: 's2', title: '数据库迁移', cwd: '~/projects/other', updated_at: new Date().toISOString(), active_run_id: 'r1' },
];

function okBody(items: BodyItem[] = ITEMS, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ items, next_cursor: null, total: items.length, ...extra }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

/** 真实推进 macrotask（jsdom Response.json）后再冲刷微任务。 */
const tick = async (ms = 30) => {
  await new Promise((r) => setTimeout(r, ms));
  await flushPromises();
};

function mountModal(
  props: { scope?: 'cwd' | 'all'; cwd?: string } = {},
  handlers: { onSelect?: (id: string) => void; onClose?: () => void } = {},
) {
  return mount(SessionPickerModal, {
    props: { scope: props.scope ?? 'cwd', cwd: props.cwd ?? '~/projects/demo', ...handlers },
    attachTo: document.body, // 焦点断言需要真实挂载
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => okBody()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('SessionPickerModal（issue #94）', () => {
  it('dialog 语义：role=dialog + aria-modal + 「浏览会话」标签，打开焦点进 dialog 容器', async () => {
    const wrapper = mountModal();
    await tick();
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-label')).toBe('浏览会话');
    expect(dialog.attributes('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(dialog.element);
    wrapper.unmount();
  });

  it('移动端全屏层：dialog 带 max-md 变体；打开锁背景滚动，卸载还原并归还焦点', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const wrapper = mountModal();
    await tick();
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.classes().join(' ')).toContain('max-md:rounded-t-lg');
    expect(document.body.style.overflow).toBe('hidden');
    wrapper.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
  });

  it('结果行：标题 + scope=all 必显目录短名 + 相对时间 + ●运行中徽标', async () => {
    const wrapper = mountModal({ scope: 'all' });
    await tick();
    const rows = wrapper.findAll('li[role="option"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('部署脚本');
    expect(rows[0].text()).toContain('demo'); // scope=all：目录短名必显
    expect(rows[0].text()).toContain('刚刚'); // 相对时间
    expect(rows[1].text()).toContain('● 运行中'); // active_run_id 徽标
    // scope=cwd：行内不渲染目录短名
    const wrapperCwd = mountModal({ scope: 'cwd' });
    await tick();
    expect(wrapperCwd.find('li[role="option"]').text()).not.toContain('demo');
    wrapper.unmount();
    wrapperCwd.unmount();
  });

  it('键盘导航：↑↓ 高亮（aria-selected），Enter 进入选中项，Esc 关闭', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const wrapper = mountModal({}, { onSelect, onClose });
    await tick();
    const dialog = wrapper.find('[role="dialog"]');
    const rows = () => wrapper.findAll('li[role="option"]');
    expect(rows()[0].attributes('aria-selected')).toBe('true'); // 默认高亮首条
    await dialog.trigger('keydown', { key: 'ArrowDown' });
    expect(rows()[1].attributes('aria-selected')).toBe('true');
    await dialog.trigger('keydown', { key: 'ArrowDown' }); // 环形回绕
    expect(rows()[0].attributes('aria-selected')).toBe('true');
    await dialog.trigger('keydown', { key: 'ArrowUp' });
    expect(rows()[1].attributes('aria-selected')).toBe('true');
    await dialog.trigger('keydown', { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('s2');
    await dialog.trigger('keydown', { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('范围 segmented 恒可改：切「全部目录」后请求不再带 cwd', async () => {
    const fetchMock = vi.mocked(fetch);
    const wrapper = mountModal({ scope: 'cwd' });
    await tick();
    expect(new URL(String(fetchMock.mock.calls[0][0]), 'http://x').searchParams.get('cwd')).toBe('~/projects/demo');
    await wrapper.findAll('button').find((b) => b.text() === '全部目录')!.trigger('click');
    await tick();
    const last = new URL(String(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0]), 'http://x');
    expect(last.searchParams.get('cwd')).toBeNull();
    wrapper.unmount();
  });

  it('头部显示「共 N 个会话」（total 就绪后）', async () => {
    const wrapper = mountModal();
    await tick();
    expect(wrapper.text()).toContain(`共 ${ITEMS.length} 个会话`);
    wrapper.unmount();
  });

  it('三态·无结果：空列表提示「该范围暂无会话」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBody([])));
    const wrapper = mountModal();
    await tick();
    expect(wrapper.text()).toContain('该范围暂无会话');
    wrapper.unmount();
  });

  it('三态·失败：错误提示 + 「重试」按钮；首次失败后可重试成功', async () => {
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (fail) return new Response('{"error":{"code":"x","message":"网络错误"}}', { status: 500 });
      return okBody();
    }));
    const wrapper = mountModal();
    await tick();
    expect(wrapper.text()).toContain('网络错误');
    expect(wrapper.text()).toContain('重试');
    fail = false;
    await wrapper.findAll('button').find((b) => b.text() === '重试')!.trigger('click');
    await tick();
    expect(wrapper.findAll('li[role="option"]')).toHaveLength(2);
    expect(wrapper.text()).not.toContain('网络错误');
    wrapper.unmount();
  });

  it('加载更多：hasMore 时渲染按钮，点击追加下一批', async () => {
    let page = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const cursor = new URL(String(url), 'http://x').searchParams.get('cursor');
      page++;
      return okBody([{ id: cursor ? 's2' : 's1', title: `会话${page}` }], { next_cursor: cursor ? null : 'CUR' });
    }));
    const wrapper = mountModal();
    await tick();
    const more = wrapper.findAll('button').find((b) => b.text() === '加载更多')!;
    await more.trigger('click');
    await tick();
    expect(wrapper.findAll('li[role="option"]')).toHaveLength(2);
    expect(wrapper.text()).not.toContain('加载更多'); // 第二页 next_cursor=null → 按钮消失
    wrapper.unmount();
  });
});
