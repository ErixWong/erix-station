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

  // issue #332：这里原有「平台管理员：占位符引导进管理台」一条。入口拦截（router 守卫的
  // workbenchGateDecision）落地后，`admin && !fde_name` 的人**根本进不到工作台**，`store.isPlatformAdmin`
  // 与 `common.platformAdminHint` 一并拆除 ⇒ 占位符只剩「有目录 / 无目录」两态（上面两条已钉）。

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

// issue #261B：「重试上一条」按钮的三态渲染（显示条件三要素 + in-flight 禁用 + 点击转发）。
// store 侧状态机（何时点亮 retryAvailable）由 stores/workbench.spec.ts 负责，这里只装配真状态。
describe('ComposerBar · issue #261B「重试上一条」按钮', () => {
  /** 点亮重试面（等价「上一条发送以失败终局收场」后的 store 状态）。 */
  function armRetry(store: ReturnType<typeof useWorkbenchStore>) {
    store.lastSend = { sessionId: 's1', content: '很长的任务描述' };
    store.retryAvailable = true;
  }

  function retryButton(wrapper: ReturnType<typeof mount>) {
    return wrapper.findAll('button').find((b) => b.text().includes('重试'));
  }

  it('输入框空 + 无活跃 run + retryAvailable ⇒ 显示「重试上一条」', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    await flushPromises();
    const btn = retryButton(wrapper);
    expect(btn, '三条件全满足时按钮必须出现').toBeDefined();
    expect(btn!.text()).toBe('重试上一条');
  });

  it('输入框非空 ⇒ 隐藏（不做覆盖草稿的歧义行为）', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    store.inputValue = '我正在打的草稿';
    await flushPromises();
    expect(retryButton(wrapper)).toBeUndefined();
    expect(wrapper.text()).not.toContain('重试上一条');
  });

  it('有活跃 run ⇒ 隐藏（正在跑的时候没有「上一条」可重发）', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    store.es.activeRunId = 'r1';
    await flushPromises();
    expect(retryButton(wrapper)).toBeUndefined();
  });

  it('retryAvailable=false ⇒ 隐藏（默认态，含只有 lastSend 的半截状态）', async () => {
    const { store, wrapper } = setup();
    await flushPromises();
    expect(retryButton(wrapper)).toBeUndefined();
    store.lastSend = { sessionId: 's1', content: 'x' };
    await flushPromises();
    expect(retryButton(wrapper)).toBeUndefined();
    // 且默认态下发送/停止按钮文案与顺序一字不动（既有基线）
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['发送']);
  });

  it('点击 ⇒ 转发 store.retryLast（不自己发请求）', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    const spy = vi.spyOn(store, 'retryLast').mockImplementation(async () => {});
    await flushPromises();
    await retryButton(wrapper)!.trigger('click');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('in-flight（POST 往返窗口）期间禁用：防双击双发', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    store.retryInFlight = true;
    await flushPromises();
    const btn = retryButton(wrapper)!;
    expect(btn.attributes('disabled')).toBeDefined();
  });

  it('English：按钮文案 Retry last（双语齐全）', async () => {
    const { store, wrapper } = setup();
    armRetry(store);
    setLocale('en');
    await flushPromises();
    const btn = wrapper.findAll('button').find((b) => b.text().includes('Retry last'));
    expect(btn, '英文界面必须有 Retry last').toBeDefined();
    expect(btn!.text()).toBe('Retry last');
  });
});
