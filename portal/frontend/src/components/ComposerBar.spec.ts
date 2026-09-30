// ComposerBar i18n 单测（issue #101 P2）：发送/停止按钮与输入占位符三处用户可见文案，
// 中文基线逐字不变 + 切 English 后即时变英文（占位符来自 store.inputPlaceholder 计算属性）。
// 约定（照 LoginView.spec 先例）：装配真实 i18n 单例，不 mock t()；每例 localStorage.clear() + setLocale('zh-CN')。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import ComposerBar from './ComposerBar.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

function setup() {
  const store = useWorkbenchStore();
  const wrapper = mount(ComposerBar, { global: { plugins: [i18n] } });
  return { store, wrapper };
}

describe('ComposerBar · i18n（issue #101 P2）', () => {
  it('zh-CN 基线：发送按钮 + 默认占位符；无运行态时不显示停止按钮', () => {
    const { wrapper } = setup();
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('输入任务，Enter 发送（Shift+Enter 换行）');
    expect(wrapper.get('button').text()).toBe('发送');
    expect(wrapper.text()).not.toContain('停止');
  });

  it('运行中：显示「■ 停止」按钮', async () => {
    const { store, wrapper } = setup();
    store.es.activeRunId = 'r1';
    await flushPromises();
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['发送', '■ 停止']);
  });

  it('无目录：占位符引导建目录 + 输入框禁用', async () => {
    const { store, wrapper } = setup();
    store.noDir = true;
    await flushPromises();
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('先创建目录');
    expect(wrapper.get('textarea').attributes('disabled')).toBeDefined();
  });

  it('平台管理员：占位符引导进管理台', async () => {
    const { store, wrapper } = setup();
    store.isPlatformAdmin = true;
    await flushPromises();
    expect(wrapper.get('textarea').attributes('placeholder'))
      .toBe('平台管理员：请到管理台创建 FDE 用户与分配资源');
  });

  it('切 English：发送/停止/占位符即时变英文', async () => {
    const { store, wrapper } = setup();
    store.es.activeRunId = 'r1';
    await flushPromises();
    setLocale('en');
    await flushPromises();
    expect(wrapper.get('textarea').attributes('placeholder'))
      .toBe('Type a task, Enter to send (Shift+Enter for a newline)');
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['Send', '■ Stop']);
  });

  it('切 English 后无目录占位符同样变英文（store 计算属性响应式）', async () => {
    const { store, wrapper } = setup();
    store.noDir = true;
    await flushPromises();
    setLocale('en');
    await flushPromises();
    expect(wrapper.get('textarea').attributes('placeholder')).toBe('Create a directory first');
  });
});
