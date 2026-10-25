// issue #370：队列条（QueuedInputsBar）的渲染契约。
// 钉三件界面上真的会错的事：
//   1. 空队列且无暂停原因 ⇒ **整条不挂**（composer 上方不许长期挂着一条 0 的空条）；
//   2. `blocked` 必须**可见**——「周五排的队周一才发」不说清楚就是「消息丢了」；
//   3. 计数与条数一致，且「取回」在入队 POST 在途时禁用（防双击把同一句取回两次）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import QueuedInputsBar from './QueuedInputsBar.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

const setup = () => mount(QueuedInputsBar, { global: { plugins: [i18n] } });

describe('QueuedInputsBar（#370）', () => {
  it('空队列且无暂停原因 ⇒ 整条不渲染', () => {
    const wrapper = setup();
    expect(wrapper.find('[data-testid="queued-inputs-bar"]').exists()).toBe(false);
  });

  it('有队列时渲染条数与分组计数（转向/排队分别报数）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({
      steering: [{ id: 'a', content: '慢一点' }],
      follow_up: [{ id: 'b', content: '跑完改标题' }, { id: 'c', content: '再跑测试' }],
    });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('3 条待发送');
    expect(text).toContain('1 条转向');
    expect(text).toContain('2 条排队');
  });

  it('blocked 必须可见，且队列已空时也照样挂（容器没起来 = 有原因没条数也要说）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [], follow_up: [] }, 'container_not_running');
    await flushPromises();
    expect(wrapper.find('[data-testid="queued-inputs-bar"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('容器未运行');
  });

  it('blocked 的未知码不炸界面（服务端加新码是 additive，前端只少一句翻译）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [], follow_up: [] }, 'from_the_future');
    await flushPromises();
    expect(wrapper.find('[data-testid="queued-inputs-bar"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('from_the_future'); // vue-i18n 缺键回落键名，可见但不出错
  });

  it('点「全部取回」调 store.recallQueue；入队 POST 在途时禁用', async () => {
    const store = useWorkbenchStore();
    const spy = vi.spyOn(store, 'recallQueue').mockImplementation(async () => {});
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '慢一点' }], follow_up: [] });
    await flushPromises();
    await wrapper.get('button:last-of-type').trigger('click');
    expect(spy).toHaveBeenCalledTimes(1);

    store.queueSubmitting = true;
    await flushPromises();
    expect((wrapper.get('button:last-of-type').element as HTMLButtonElement).disabled).toBe(true);
  });

  it('切 English 后文案即时变英文（与全站 i18n 纪律一致）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [], follow_up: [{ id: 'b', content: 'x' }] }, 'deliver_failed');
    await flushPromises();
    setLocale('en');
    await flushPromises();
    expect(wrapper.text()).toContain('1 pending');
    expect(wrapper.text()).toContain('Last delivery failed');
  });
});
