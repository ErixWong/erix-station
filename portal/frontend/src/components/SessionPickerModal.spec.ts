// SessionPickerModal 单测（issue #94，评审裁决瘦身版）：dialog 语义与焦点管理、结果行渲染、
// 键盘导航（↑↓/Enter/Esc）、范围切换、三态（加载中/无结果/失败保留旧列表+重试）、
// 单次全量（limit=100）、绝对本地时间、移动端全屏层与滚动锁定。
// 事件断言用父级 onSelect/onClose 回调（emitted() 对本环境 script-setup 组件不记录，仓库先例亦不用）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import SessionPickerModal from './SessionPickerModal.vue';
import { i18n, setLocale } from '../i18n';

interface BodyItem {
  id: string;
  title?: string;
  cwd?: string;
  updated_at?: string;
  active_run_id?: string | null;
}

const T0 = '2026-09-20T08:00:00.000Z';
const ITEMS: BodyItem[] = [
  { id: 's1', title: '部署脚本', cwd: '~/projects/demo', updated_at: T0, active_run_id: null },
  { id: 's2', title: '数据库迁移', cwd: '~/projects/other', updated_at: T0, active_run_id: 'r1' },
];

function okBody(items: BodyItem[] = ITEMS) {
  return new Response(JSON.stringify({ items, next_cursor: null }), {
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
    global: { plugins: [i18n] }, // issue #101 P2：装配真实 i18n 单例（组件内 useI18n()）
    attachTo: document.body, // 焦点断言需要真实挂载
  });
}

beforeEach(() => {
  // 每例重置语言为 zh-CN（既有中文断言逐字不变）。
  localStorage.clear();
  setLocale('zh-CN');
  vi.stubGlobal('fetch', vi.fn(async () => okBody()));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.body.style.overflow = '';
});

describe('SessionPickerModal（issue #94 评审裁决瘦身版）', () => {
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

  it('单次全量：首屏一次请求 limit=100，无 cursor/total；选项外层 ul 带 role=listbox', async () => {
    const fetchMock = vi.mocked(fetch);
    const wrapper = mountModal();
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://x');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('cursor')).toBeNull();
    expect(url.searchParams.get('total')).toBeNull();
    const listbox = wrapper.find('ul[role="listbox"]');
    expect(listbox.exists()).toBe(true);
    expect(listbox.findAll('li[role="option"]')).toHaveLength(2);
    wrapper.unmount();
  });

  it('结果行：标题 + scope=all 必显目录短名 + 绝对本地时间（toLocaleString zh-CN）+ ●运行中徽标', async () => {
    const wrapper = mountModal({ scope: 'all' });
    await tick();
    const rows = wrapper.findAll('li[role="option"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain('部署脚本');
    expect(rows[0].text()).toContain('demo'); // scope=all：目录短名必显
    expect(rows[0].text()).toContain(new Date(T0).toLocaleString('zh-CN')); // 绝对本地时间
    expect(rows[0].text()).not.toContain('刚刚'); // 相对时间已拆除
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

  it('三态·无结果：空列表提示「该范围暂无会话」', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBody([])));
    const wrapper = mountModal();
    await tick();
    expect(wrapper.text()).toContain('该范围暂无会话');
    wrapper.unmount();
  });

  it('三态·失败：错误提示 + 「重试」按钮；重试重新拉全量并成功', async () => {
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

  it('无「共 N 个会话」总数显示、无「加载更多」按钮（评审裁决：选择器纯浏览）', async () => {
    const wrapper = mountModal();
    await tick();
    expect(wrapper.text()).not.toContain('共 2 个会话');
    expect(wrapper.text()).not.toContain('加载更多');
    wrapper.unmount();
  });
});

// ---------------------------------------------------------------------------
// issue #101 P2：会话浏览 modal 用户可见文案走 i18n（zh-CN 基线逐字不变，切 en 即时生效）
// ---------------------------------------------------------------------------
describe('SessionPickerModal · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：dialog 标签 / 范围分段 / 空态 / 重试 / 未命名会话 / 运行中徽标', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBody([])));
    const wrapper = mountModal();
    await tick();
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.attributes('aria-label')).toBe('浏览会话');
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('会话范围');
    expect(wrapper.text()).toContain('当前目录：demo');
    expect(wrapper.text()).toContain('全部目录');
    expect(wrapper.get('ul[role="listbox"]').attributes('aria-label')).toBe('会话列表');
    expect(wrapper.text()).toContain('该范围暂无会话');
    expect(wrapper.find('button[aria-label="关闭"]').exists()).toBe(true);
    wrapper.unmount();

    // 结果行：有活跃 run → 「● 运行中」
    vi.stubGlobal('fetch', vi.fn(async () => okBody()));
    const w2 = mountModal();
    await tick();
    expect(w2.text()).toContain('部署脚本');
    expect(w2.text()).toContain('● 运行中');
    w2.unmount();

    // 失败态：错误（服务端 message）+「（旧列表已保留）」+「重试」
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const w3 = mountModal();
    await tick();
    expect(w3.get('[role="alert"]').text()).toContain('（旧列表已保留）');
    expect(w3.text()).toContain('重试');
    w3.unmount();
  });

  it('切 English：标签/分段/空态/重试/徽标/未命名会话即时变英文', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okBody([
      { id: 's1', cwd: '~/projects/demo', updated_at: T0, active_run_id: 'r1' },
    ])));
    const wrapper = mountModal({ scope: 'all' });
    await tick();
    expect(wrapper.text()).toContain('未命名会话');

    setLocale('en');
    await flushPromises();

    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Browse sessions');
    expect(wrapper.get('[role="group"]').attributes('aria-label')).toBe('Session scope');
    expect(wrapper.text()).toContain('Current directory: demo');
    expect(wrapper.text()).toContain('All directories');
    expect(wrapper.get('ul[role="listbox"]').attributes('aria-label')).toBe('Session list');
    expect(wrapper.text()).toContain('Untitled session');
    expect(wrapper.text()).toContain('● Running');
    wrapper.unmount();

    // 空态 + 关闭 aria-label
    vi.stubGlobal('fetch', vi.fn(async () => okBody([])));
    const w2 = mountModal();
    await tick();
    expect(w2.text()).toContain('No sessions in this scope');
    expect(w2.find('button[aria-label="Close"]').exists()).toBe(true);
    w2.unmount();
  });
});
