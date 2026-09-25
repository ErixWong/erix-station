// StreamPanel 工具卡片单测（issue #85）：折叠交互（默认收起/点击展开收起/chevron 旋转）、
// 单行语义摘要、ok/err 分级色（左边框 + 工具名/✗ 变红）、耗时显示、展开态跨重渲染不丢、
// clearExpandedToolCalls 复位。store 状态直填，不碰真实后端/SSE。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StreamPanel from './StreamPanel.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { clearExpandedToolCalls } from '../lib/toolCallExpansion';

beforeEach(() => {
  setActivePinia(createPinia());
  clearExpandedToolCalls();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

function setup(cards: Record<string, { name: string; dig: string; args: string; ok: boolean | null; out: string; dur?: number }>) {
  const store = useWorkbenchStore();
  for (const [callId, card] of Object.entries(cards)) {
    store.es.toolCards.set(callId, card);
    store.entries.push({ kind: 'tool', callId });
  }
  const wrapper = mount(StreamPanel);
  return { store, wrapper };
}

function cardBtn(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('button[aria-expanded]');
}

describe('消息渲染（pi-web 风格对齐）', () => {
  it('助手终稿与流式增量均为 .msg.assistant.md；助手无气泡（无背景类），用户消息右对齐气泡', () => {
    const store = useWorkbenchStore();
    store.renderedIds = new Set();
    store.addMessage({ id: 'm1', role: 'assistant', content: '# 标题\n正文' });
    store.addMessage({ id: 'm2', role: 'user', content: '用户输入' });
    store.entries.push({ kind: 'delta', text: '增量 **粗体**' });
    const wrapper = mount(StreamPanel);
    const assistant = wrapper.get('.msg.assistant.md');
    expect(assistant.html()).toContain('<h1>标题</h1>');
    const delta = wrapper.get('div.msg.assistant.md ~ div.msg.assistant.md');
    expect(delta.html()).toContain('<strong>粗体</strong>');
    expect(delta.classes()).toEqual(expect.arrayContaining(['msg', 'assistant', 'md']));
    const user = wrapper.get('.msg.user');
    expect(user.text()).toBe('用户输入');
    expect(user.classes()).not.toContain('md');
  });

  it('流式增量半截 ``` 容错：未闭合围栏吞到文末收尾，不产出未闭合标签', () => {
    const store = useWorkbenchStore();
    store.entries.push({ kind: 'delta', text: '说明\n```ts\nconst a = 1' });
    const wrapper = mount(StreamPanel);
    const delta = wrapper.get('.msg.assistant.md');
    expect(delta.find('.md-code').exists()).toBe(true);
    expect(delta.find('.md-lang').text()).toBe('ts');
    expect(delta.get('.md-code pre code').text()).toContain('const a = 1');
  });
});

describe('工具卡片折叠（issue #85）', () => {
  it('默认折叠：只有头部 button，无 pre 结果区', () => {
    const { wrapper } = setup({ c1: { name: 'bash', dig: '{}', args: '{"command":"ls"}', ok: null, out: '' } });
    const btn = cardBtn(wrapper);
    expect(btn.attributes('aria-expanded')).toBe('false');
    expect(btn.text()).toContain('bash');
    expect(wrapper.find('pre').exists()).toBe(false);
  });

  it('点击展开：显示完整 args 的 pre 块 + 结果行；chevron rotate-180；再点收起', async () => {
    const { wrapper } = setup({
      c1: { name: 'bash', dig: '', args: '{"command":"ls -la"}', ok: true, out: '✓ done（12ms）', dur: 12 },
    });
    await cardBtn(wrapper).trigger('click');
    expect(cardBtn(wrapper).attributes('aria-expanded')).toBe('true');
    expect(wrapper.get('pre').text()).toContain('{"command":"ls -la"}');
    // pre 防溢出三件套
    expect(wrapper.get('pre').classes()).toEqual(expect.arrayContaining(['whitespace-pre-wrap', 'break-all', 'overflow-auto']));
    expect(wrapper.text()).toContain('✓ done（12ms）');
    // chevron 旋转
    expect(cardBtn(wrapper).find('.rotate-180').exists()).toBe(true);
    expect(cardBtn(wrapper).find('.transition-transform').exists()).toBe(true);
    // 收起
    await cardBtn(wrapper).trigger('click');
    expect(wrapper.find('pre').exists()).toBe(false);
    expect(cardBtn(wrapper).find('.rotate-180').exists()).toBe(false);
  });

  it('展开状态跨组件重渲染不丢（SSE 补发/重挂载场景），clear 后回到默认收起', async () => {
    const store = useWorkbenchStore();
    store.es.toolCards.set('c1', { name: 'bash', dig: '', args: '{"command":"x"}', ok: null, out: '' });
    store.entries.push({ kind: 'tool', callId: 'c1' });
    const first = mount(StreamPanel);
    await first.get('button[aria-expanded]').trigger('click');
    expect(first.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
    first.unmount();
    // 模拟事件补发重建 entries + 组件重挂载：展开态应从模块记忆回灌
    store.entries = [{ kind: 'tool', callId: 'c1' }];
    const second = mount(StreamPanel);
    expect(second.get('button[aria-expanded]').attributes('aria-expanded')).toBe('true');
    // 离开会话路径（workbench 挂 clearExpandedToolCalls）的等价效果
    clearExpandedToolCalls();
    store.entries = [{ kind: 'tool', callId: 'c1' }];
    second.unmount();
    const third = mount(StreamPanel);
    expect(third.get('button[aria-expanded]').attributes('aria-expanded')).toBe('false');
  });

  it('单行摘要取语义键（command 等），折叠态头部可见工具名/摘要/状态', () => {
    const { wrapper } = setup({
      c1: { name: 'bash', dig: '{"command":"ls -la"}', args: '{"command":"ls -la","timeout":30}', ok: null, out: '' },
    });
    const btn = cardBtn(wrapper);
    expect(btn.text()).toContain('ls -la');
    expect(btn.text()).not.toContain('timeout');
    // 摘要 ellipsis 三件套 + 占满剩余宽
    const summary = btn.get('span.overflow-hidden');
    expect(summary.classes()).toEqual(expect.arrayContaining(['text-ellipsis', 'whitespace-nowrap', 'flex-1', 'min-w-0']));
  });

  it('args 解析失败回退 dig；args 为空显示「参数生成中」', () => {
    const { wrapper } = setup({
      c1: { name: 't', dig: 'dig-fallback', args: 'not json', ok: null, out: '' },
      c2: { name: 'u', dig: '', args: '', ok: null, out: '' },
    });
    const btns = wrapper.findAll('button[aria-expanded]');
    expect(btns[0].text()).toContain('dig-fallback');
    expect(btns[1].text()).toContain('（参数生成中…）');
  });

  it('ok/err 分级：左边框色 + 工具名/✗ 红 + 耗时；null 显示 …', () => {
    const { wrapper } = setup({
      ok1: { name: 'a', dig: '', args: '{}', ok: true, out: '', dur: 5 },
      err1: { name: 'b', dig: '', args: '{}', ok: false, out: '', dur: 7 },
      null1: { name: 'c', dig: '', args: '{}', ok: null, out: '' },
    });
    const cards = wrapper.findAll('.border-l-4');
    expect(cards[0].classes()).toContain('border-l-green-600');
    expect(cards[1].classes()).toContain('border-l-red-600');
    expect(cards[2].classes()).toContain('border-l-neutral-500');
    expect(cards[0].get('button').text()).toContain('✓ 5ms');
    expect(cards[1].get('button').text()).toContain('✗ 7ms');
    expect(cards[1].get('button').find('.text-red-600').exists()).toBe(true);
    expect(cards[2].get('button').text()).toContain('…');
  });
});
