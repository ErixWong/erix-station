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

  it('blocked 的未知码不炸界面，但**不许渲染裸键名**（#805）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [], follow_up: [] }, 'from_the_future');
    await flushPromises();
    // 条体本身还在（新后端加新码是 additive，不能把整块抹掉），但那一行原因必须消失：
    // vue-i18n 缺键会把 `queued.blocked.from_the_future` 回落成**键名**，那是把内部实现当文案递给用户。
    expect(wrapper.find('[data-testid="queued-inputs-bar"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('from_the_future');
    expect(wrapper.text()).not.toContain('queued.blocked.');
  });

  it('#805 not_deliverable_at_terminal 有文案（本次运行被中断结束 ⇒ 队列条要说出为什么这句没发）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [], follow_up: [{ id: 'b', content: '别烧在坏 run 上' }] }, 'not_deliverable_at_terminal');
    await flushPromises();
    expect(wrapper.text()).toContain('这句会等下一次正常收尾再发');
    expect(wrapper.text()).not.toContain('not_deliverable_at_terminal'); // 码本身不许露出来
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

  // issue #816：默认展开 + 每条 2 行 + 第三行编号按钮（点编号只展开那一条、hover 浮层看全文）。
  // 这里钉的不是「好看」，是**看不看得见**：收起态只给一个计数，用户会以为自己排的那几条丢了。
  // 断言只认 DOM（`data-test` / 类名 / 文本），不用 `w.emitted()`（仓内纪律）。
  const six = () => ({
    steering: [{ id: 's1', content: '转向一' }, { id: 's2', content: '转向二' }],
    follow_up: [
      { id: 'f1', content: '排队一' },
      { id: 'f2', content: '排队二——这一条的正文很长，收起时必须被截掉' },
      { id: 'f3', content: '排队三' },
      { id: 'f4', content: '排队四' },
    ],
  });

  it('默认展开：3 条 ⇒ 不用点任何按钮就能看到前 2 条的正文（#816）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({
      steering: [{ id: 'a', content: '把那个测试也改一下' }],
      follow_up: [{ id: 'b', content: '改完顺手跑 npm test' }, { id: 'c', content: '第三条' }],
    });
    await flushPromises();
    const rows = wrapper.findAll('[data-test="queued-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain('把那个测试也改一下');
    expect(rows[1]!.text()).toContain('改完顺手跑 npm test');
    // 每条正文最多 2 行（原来是 3 行 ⇒ 三条就能把 composer 顶出屏幕）
    expect(rows[0]!.classes()).toContain('line-clamp-2');
    expect(rows[0]!.classes()).not.toContain('line-clamp-3');
  });

  it('第 3 条起是编号按钮行：6 条 ⇒ 恰好 3/4/5/6 四个，**不是**一个「+N」（#816）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot(six());
    await flushPromises();
    const nums = wrapper.findAll('[data-test="queued-index"]');
    expect(nums).toHaveLength(4);
    // 1-based、**跨转向/排队统一编号**，顺序 = [...steering, ...follow_up]（与后端快照一致，前端不重排）
    expect(nums.map((n) => n.attributes('data-index'))).toEqual(['3', '4', '5', '6']);
    expect(nums.map((n) => n.text())).toEqual(['3', '4', '5', '6']);
    expect(wrapper.text()).not.toContain('+4');
    expect(wrapper.find('[data-test="queued-row-full"]').exists()).toBe(false);
  });

  it('≤ 2 条不画编号行（没东西可收就别留一行空按钮）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '甲' }], follow_up: [{ id: 'b', content: '乙' }] });
    await flushPromises();
    expect(wrapper.findAll('[data-test="queued-row"]')).toHaveLength(2);
    expect(wrapper.findAll('[data-test="queued-index"]')).toHaveLength(0);
  });

  it('点编号只展开那一条：点 4 ⇒ 第 4 条全文可见，前 2 行仍是 2 行且照旧截断（#816）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot(six());
    await flushPromises();
    await wrapper.get('[data-test="queued-index"][data-index="4"]').trigger('click');
    const full = wrapper.get('[data-test="queued-row-full"]');
    expect(full.text()).toContain('排队二——这一条的正文很长，收起时必须被截掉');
    expect(full.classes()).not.toContain('line-clamp-2');
    // 只展开那一条：行还是前 2 条，且没有被「顺手」一起解开
    const rows = wrapper.findAll('[data-test="queued-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.classes()).toContain('line-clamp-2');
    expect(rows[1]!.classes()).toContain('line-clamp-2');
    expect(wrapper.text()).not.toContain('排队一'); // 没点开的编号不该把正文铺出来

    // 再点同一条 = 收起；点另一条 = 切过去（单值 `expandedIndex`）
    await wrapper.get('[data-test="queued-index"][data-index="4"]').trigger('click');
    expect(wrapper.find('[data-test="queued-row-full"]').exists()).toBe(false);
    await wrapper.get('[data-test="queued-index"][data-index="6"]').trigger('click');
    expect(wrapper.findAll('[data-test="queued-row-full"]')).toHaveLength(1);
    expect(wrapper.get('[data-test="queued-row-full"]').text()).toContain('排队四');
  });

  it('hover 编号出浮层（绝对定位，不改布局）：含该条全文，移开即收（#816）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot(six());
    await flushPromises();
    expect(wrapper.find('[data-test="queued-hover-tip"]').exists()).toBe(false);
    const num6 = wrapper.get('[data-test="queued-index"][data-index="6"]');
    await num6.trigger('mouseenter');
    const tip = wrapper.get('[data-test="queued-hover-tip"]');
    expect(tip.text()).toContain('排队四');
    // 浮层必须**浮着**（`pointer-events-none` 不抢 hover）而不是插进文档流把下面顶一下
    expect(tip.classes()).toContain('pointer-events-none');
    expect(tip.classes().join(' ')).toContain('absolute');
    // hover 不算展开：底下那条全文行不该因此出现
    expect(wrapper.find('[data-test="queued-row-full"]').exists()).toBe(false);
    await num6.trigger('mouseleave');
    expect(wrapper.find('[data-test="queued-hover-tip"]').exists()).toBe(false);
  });

  it('换会话复位为展开（手动收起只在当前会话内有效，#816）', async () => {
    const store = useWorkbenchStore();
    const wrapper = setup();
    store.applyQueueSnapshot({ steering: [{ id: 'a', content: '甲' }], follow_up: [{ id: 'b', content: '乙' }] });
    await flushPromises();
    const collapseBtn = wrapper.findAll('button').find((b) => b.text() === '收起');
    expect(collapseBtn).toBeTruthy();
    await collapseBtn!.trigger('click');
    expect(wrapper.findAll('[data-test="queued-row"]')).toHaveLength(0);

    store.sessionId = 'another-session';
    await flushPromises();
    expect(wrapper.findAll('[data-test="queued-row"]')).toHaveLength(2);
  });
});
