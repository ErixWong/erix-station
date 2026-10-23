// 消息级时间戳 + 流式气泡「已运行 Xs」单测（issue #282 A 块 + B 块在 StreamPanel 的唯一落点）。
// 验收点 ①：有 `created_at` 时显示、缺失时不显示，且永不出 `undefined` / `Invalid Date` / `NaN`。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import StreamPanel from './StreamPanel.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';
import { formatMessageTime } from '../lib/messageTime';

const ISO = '2026-10-23T13:42:07.000Z';
const T0 = new Date('2026-10-23T13:42:07.000Z').getTime();

function mountPanel() {
  return mount(StreamPanel, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

function seed(createdAt?: string) {
  const store = useWorkbenchStore();
  store.renderedIds = new Set();
  store.addMessage({ id: 'm1', role: 'user', content: '跑一下测试', created_at: createdAt });
  store.addMessage({ id: 'm2', role: 'assistant', content: '好', created_at: createdAt });
  return { store, wrapper: mountPanel() };
}

describe('issue #282 A：消息时刻', () => {
  it('DTO 带 created_at ⇒ 用户与助手消息都出 <time>，文本是 HH:MM:SS', () => {
    const { wrapper } = seed(ISO);
    const times = wrapper.findAll('.msg-time');
    expect(times).toHaveLength(2); // 用户与助手都算（工单要求）
    const expected = formatMessageTime(ISO, 'zh-CN');
    expect(expected).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    for (const time of times) {
      expect(time.text()).toBe(expected);
      expect(time.attributes('datetime')).toBe(ISO);
      expect(time.attributes('title')).toBe('消息时刻');
    }
    // 时刻挂在消息气泡内部（不是另起一个气泡）
    expect(wrapper.get('.msg.user').find('.msg-time').exists()).toBe(true);
    expect(wrapper.get('.msg.assistant').find('.msg-time').exists()).toBe(true);
  });

  it('DTO 没带 created_at ⇒ 整段不出（无 <time>，也绝不出现 undefined / Invalid Date / NaN）', () => {
    const { wrapper } = seed(undefined);
    expect(wrapper.findAll('.msg-time')).toHaveLength(0);
    expect(wrapper.text()).not.toMatch(/undefined|Invalid Date|NaN/);
  });

  it('created_at 是脏串 ⇒ 同样整段不出（不把 Invalid Date 画上屏）', () => {
    const { wrapper } = seed('not-a-date');
    expect(wrapper.findAll('.msg-time')).toHaveLength(0);
    expect(wrapper.text()).not.toMatch(/undefined|Invalid Date|NaN/);
  });

  it('空串 created_at ⇒ 不出时刻（空串不是时刻）', () => {
    const { wrapper } = seed('');
    expect(wrapper.findAll('.msg-time')).toHaveLength(0);
  });
});

describe('issue #282 B：流式气泡上的「已运行 Xs」+ 心跳', () => {
  it('运行中：气泡头部出计时（随 1s 时钟递增）与脉冲心跳', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.entries.push({ kind: 'delta', text: '增量正文' });
    const wrapper = mountPanel();

    expect(wrapper.get('.delta-meta').text()).toContain('已运行 00:00');
    expect(wrapper.get('.heartbeat').classes()).toContain('animate-pulse');
    vi.advanceTimersByTime(3000);
    await nextTick();
    expect(wrapper.get('.delta-meta').text()).toContain('已运行 00:03');
    // 增量正文仍走既有 markdown 渲染路径（没被计时行挤掉）
    expect(wrapper.get('.msg.assistant.md').text()).toContain('增量正文');
  });

  it('起跑时刻未知（页面中途打开）⇒ 只出「运行中」，不出假时长', () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', null);
    store.entries.push({ kind: 'delta', text: 'x' });
    const wrapper = mountPanel();
    const text = wrapper.get('.delta-meta').text();
    expect(text).toContain('运行中');
    expect(text).not.toMatch(/\d{2}:\d{2}/);
  });

  it('非运行态（没有 run）⇒ 计时行不出，但心跳容器仍在（气泡本身就是运行中的产物）', () => {
    const store = useWorkbenchStore();
    store.entries.push({ kind: 'delta', text: 'x' });
    const wrapper = mountPanel();
    expect(wrapper.get('.delta-meta').text()).toBe('');
    expect(wrapper.find('.heartbeat').exists()).toBe(true);
  });
});
