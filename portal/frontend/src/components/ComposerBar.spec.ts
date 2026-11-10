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
  // issue #466：预算按视口高算比例，钉住 jsdom 的 768 不依赖它默认值（转屏/键盘弹起另说）。
  vi.stubGlobal('innerHeight', 768);
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

  // issue #370 改了本例断言（原为 `['发送', '■ 停止']`）：运行中发送键分裂成「转向 / 排队」两个
  // 动作，停止键照旧。判据用 `data-queued-kind` 而不是只比文案——文案会随翻译变，而「运行中有且
  // 只有这两个发送动作、且 idle 态那个键不存在」是本工单的行为契约。
  it('运行中：发送键分裂为「转向 / 排队」，并显示「■ 停止」', async () => {
    const { store, wrapper } = setup();
    store.es.activeRunId = 'r1';
    await flushPromises();
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['转向', '排队', '■ 停止']);
    expect(wrapper.find('[data-queued-kind="send"]').exists()).toBe(false);
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
    // 断言被 issue #370 改掉：运行中的占位符与发送键都是新三态之一（见 ComposerBar.vue 的双按钮）。
    expect(wrapper.get('textarea').attributes('placeholder'))
      .toBe('Type while it runs — Enter steers, Option/Alt+Enter queues');
    expect(wrapper.findAll('button').map((b) => b.text())).toEqual(['Steer', 'Queue', '■ Stop']);
  });

  // issue #370：三个发送动作的分派。判据是「点了之后 store 收到哪个 action」——
  // 界面文案会变，而「运行中 Enter=转向 / Alt+Enter=排队 / 空闲 Enter=直发」是本工单的行为契约。
  describe('issue #370：运行中说话的动作分派', () => {
    it('运行中点「转向」→ sendQueued("steer")，点「排队」→ sendQueued("follow_up")', async () => {
      const { store, wrapper } = setup();
      const spy = vi.spyOn(store, 'sendQueued').mockImplementation(async () => {});
      const sendSpy = vi.spyOn(store, 'send').mockImplementation(async () => {});
      store.es.activeRunId = 'r1';
      store.inputValue = '慢一点';
      await flushPromises();
      await wrapper.get('[data-queued-kind="steer"]').trigger('click');
      await wrapper.get('[data-queued-kind="follow_up"]').trigger('click');
      expect(spy.mock.calls.map((c) => c[0])).toEqual(['steer', 'follow_up']);
      expect(sendSpy).not.toHaveBeenCalled(); // 运行中绝不再走直发路
    });

    it('运行中 Enter=转向、Alt+Enter=排队、Shift+Enter 交回原生换行', async () => {
      const { store, wrapper } = setup();
      const spy = vi.spyOn(store, 'sendQueued').mockImplementation(async () => {});
      store.es.activeRunId = 'r1';
      await flushPromises();
      const ta = wrapper.get('textarea');
      await ta.trigger('keydown', { key: 'Enter' });
      await ta.trigger('keydown', { key: 'Enter', altKey: true });
      await ta.trigger('keydown', { key: 'Enter', shiftKey: true });
      expect(spy.mock.calls.map((c) => c[0])).toEqual(['steer', 'follow_up']);
    });

    it('空闲时仍是单发送键，Enter 走 send()（队列不许改变无 run 时的行为）', async () => {
      const { store, wrapper } = setup();
      const spy = vi.spyOn(store, 'sendQueued').mockImplementation(async () => {});
      const sendSpy = vi.spyOn(store, 'send').mockImplementation(async () => {});
      await wrapper.get('textarea').trigger('keydown', { key: 'Enter' });
      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
      expect(wrapper.find('[data-queued-kind="steer"]').exists()).toBe(false);
    });

    it('空输入时两个键都禁用（队列不许让空白提交溜过去）', async () => {
      const { store, wrapper } = setup();
      store.es.activeRunId = 'r1';
      store.inputValue = '   ';
      await flushPromises();
      expect((wrapper.get('[data-queued-kind="steer"]').element as HTMLButtonElement).disabled).toBe(true);
      expect((wrapper.get('[data-queued-kind="follow_up"]').element as HTMLButtonElement).disabled).toBe(true);
    });
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

// issue #466：composer 按内容自适应高度。
//
// ⚠ 本文件只验「算出来的高确实写进了 textarea 的 style」与「什么时候重算」；
// 夹逼算法本身（min/max/NaN 兜底）在 lib/composerHeight.spec.ts 用真数字钉。
//
// ⚠⚠ 这里的 scrollHeight 必须**建模**，不能直接接 jsdom：jsdom 不做布局，不管填多少字它都恒为 0，
// 不假造就只能测「恒等于最小高」这条恒真的废话。也不能图省事写成「固定返回 N」——那样就测不到
// 本单真正的坑：`scrollHeight` 的语义是 **max(内容高, 当前可视高)**，所以量高之前必须先把
// style.height 松开，否则框子只涨不落。下面这个模型就是按这条语义写的（不是随手编的数）。
describe('ComposerBar · issue #466 输入框按内容自适应高度', () => {
  const LINE_H = 20;   // px/行（模型参数，与真浏览器行高无关，只要自洽就能钉住行为）
  const PAD_V = 12;    // 上下 padding（py-1.5 × 2）

  /** 给 textarea 装一个最小的真实布局模型：scrollHeight = max(内容高, 当前盒高)。 */
  function installLayoutModel(el: HTMLElement) {
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => {
        const lines = Math.max(1, (el as HTMLTextAreaElement).value.split('\n').length);
        const content = lines * LINE_H + PAD_V;
        const h = el.style.height;
        const cur = !h || h === 'auto' ? 0 : Number.parseFloat(h) || 0;
        return Math.max(content, cur);
      },
    });
  }

  const taStyle = (wrapper: ReturnType<typeof mount>) =>
    (wrapper.get('textarea').element as HTMLElement).style;
  const MIN_PX = 51.2;   // 3.2rem × 16px，= 改动前钉死的 `height: 3.2rem`

  it('空内容 ⇒ 高度恰为改动前的 3.2rem（未输入时界面不跳）', async () => {
    const { wrapper } = setup();
    installLayoutModel(wrapper.get('textarea').element as HTMLElement);
    await flushPromises();
    expect(taStyle(wrapper).height).toBe(`${MIN_PX}px`);   // 内容高 32 < 51.2 ⇒ 夹到 min
  });

  it('内容变高 ⇒ 样式跟着变；超预算 ⇒ 钉在封顶并开纵向滚动', async () => {
    const { store, wrapper } = setup();
    installLayoutModel(wrapper.get('textarea').element as HTMLElement);
    await flushPromises();

    store.inputValue = Array(6).fill('行').join('\n');   // 6 行 → 132px
    await flushPromises();
    expect(taStyle(wrapper).height).toBe(`${6 * LINE_H + PAD_V}px`);
    expect(taStyle(wrapper).overflowY).toBe('hidden');     // 未超预算不许带滚动条

    store.inputValue = Array(200).fill('行').join('\n');  // 远超预算
    await flushPromises();
    expect(taStyle(wrapper).height).toBe('307.2px');        // = 768 × 40%，流区不被挤没
    expect(taStyle(wrapper).overflowY).toBe('auto');        // 封顶后必须能滚，否则内容被裁且看不见
  });

  // 本单最关键的判据：长文本进输入框有四条路是**程序改值**（发送失败回填 / 入队失败回填 /
  // 切会话恢复草稿 / 多条拼接，见 workbench.ts:1350 / :1475 / :904 / :1513）。
  // 变异 M1：把 watch 换成只听 DOM `input` 事件 ⇒ 本条与上面两条一起红（已亲跑）。
  it('只改 store 值（不触发 DOM input 事件）也重算——四条回填路的共同前提', async () => {
    const { store, wrapper } = setup();
    installLayoutModel(wrapper.get('textarea').element as HTMLElement);
    await flushPromises();

    store.inputValue = '发送失败后回填的原文\n第 2 行\n第 3 行';   // 全程不 trigger('input')
    await flushPromises();
    expect(taStyle(wrapper).height).toBe(`${3 * LINE_H + PAD_V}px`);
  });

  // 变异 M2：删掉 autosize 里 `ta.style.height = 'auto'` 那一行 ⇒ 本条必红（已亲跑）。
  // 钉的是 textarea 自适应真正的坑：scrollHeight 不低于当前盒高，不先松开就只涨不落。
  it('内容变短 / 清空 ⇒ 高度回落（发完长消息不许把空框一直撑在那）', async () => {
    const { store, wrapper } = setup();
    installLayoutModel(wrapper.get('textarea').element as HTMLElement);
    await flushPromises();

    store.inputValue = Array(11).fill('行').join('\n');   // 11 行 → 232px
    await flushPromises();
    expect(taStyle(wrapper).height).toBe(`${11 * LINE_H + PAD_V}px`);

    store.inputValue = '';                                // 发完清空
    await flushPromises();
    expect(taStyle(wrapper).height).toBe(`${MIN_PX}px`);
    expect(taStyle(wrapper).overflowY).toBe('hidden');
  });

  // 变异 M3：把封顶算成固定像素（不读视口）⇒ 第二段必红（已亲跑）。
  it('视口变矮（转屏 / 移动端键盘弹起）⇒ 重算封顶，已撑开的高度跟着收', async () => {
    const { store, wrapper } = setup();
    const el = wrapper.get('textarea').element as HTMLElement;
    installLayoutModel(el);
    store.inputValue = Array(200).fill('行').join('\n');   // 先撑到封顶
    await flushPromises();
    expect(taStyle(wrapper).height).toBe('307.2px');

    vi.stubGlobal('innerHeight', 400);   // 键盘弹起：视口从 768 塌到 400
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(taStyle(wrapper).height).toBe('160px');
  });

  // 结构锁：旧实现是内联 `style="height: 3.2rem"`，写死的值会永远压住 JS 算出来的高度
  // （内联样式优先级高于组件后写的 class），自适应会被静默失效。
  it('不再携带钉死的 height 内联样式（旧值会盖住自适应）', async () => {
    const { wrapper } = setup();
    await flushPromises();
    const raw = wrapper.get('textarea').attributes('style') ?? '';
    expect(raw).not.toContain('3.2rem');
    expect(wrapper.get('textarea').classes()).toEqual(expect.arrayContaining(['min-h-[3.2rem]']));
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
