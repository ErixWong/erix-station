// DelegateChildDrawer 的轮询纪律与三态（issue #delegate P3 交付 3）。
// 四条纪律各一条反证用例（终态只拉一次 / 活态按拍 / 转终态即停 / 单飞 / 卸载即停），
// 加上三态文案、分级颜色、dialog 语义与渲染形状。
// 时间全部走 fake timers，`fetch` 全部走桩：这里测的是**客户端纪律**，不是后端契约。
//
// issue #602 加了**第五条前置**：轮询还要求「父 run 仍是当前活跃 run」（`store.es.activeRunId`）。
// 于是本文件的装配多了一件事：抽屉现在要读 store ⇒ 每个用例都要 `setActivePinia`，而
// 「父 run 活跃」是上面那些既有纪律的**前提**，所以 `mountDrawer` 默认把 `activeRunId` 置成
// `parentRunId`（那些用例测的仍是「父 run 在跑时按 2s 拍」，一字未改），
// 要测「父 run 已结束」那一面传 `{ parentActive: false }`。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { createPinia, setActivePinia } from 'pinia';
import DelegateChildDrawer from './DelegateChildDrawer.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { zhCN } from '../i18n/locales/zh-CN';
import { DELEGATE_POLL_MS, DELEGATE_UNKNOWN_MARK, shortRunId } from '../lib/delegate';

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zhCN } });
const COPY = zhCN.delegate;

interface StubResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

const OK_BODY = {
  childRunId: 'child-run-bbbb',
  state: 'running',
  messages: [{ id: 'm1', seq: 1, run_id: 'child-run-bbbb', created_at: 1, role: 'assistant', text: 'hello' }],
  truncated: false,
  totalTurns: 2,
};

function response(overrides: Partial<StubResponse> = {}): StubResponse {
  const body = overrides.body === undefined ? OK_BODY : overrides.body;
  return { ok: overrides.ok ?? true, status: overrides.status ?? 200, body };
}

/** 依次吐出给定响应；用尽后重复最后一个（避免用例尾部拿到 undefined）。 */
function stubFetch(...responses: StubResponse[]) {
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const res = responses.length > 1 ? responses.shift()! : responses[0];
    return {
      ok: res.ok,
      status: res.status,
      json: async () => res.body,
      signal: init?.signal ?? null,
    };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * 装配抽屉。**默认「父 run 就是当前活跃 run」**（#602 之前这就是唯一世界；#602 之后它成了一条
 * 需要写出来的前提）——抽屉现在只读 `store.es.activeRunId` 来判这条，所以每个用例都得有 pinia。
 *
 * @param props 覆盖抽屉 props（`parentRunId` 缺省 `parent-run-aaaa`）
 * @param attach 挂到 `document.body`（dialog 焦点类用例用）
 * @param options.parentActive `false` ⇒ 把 `es.activeRunId` 置 null（父 run 已结束，#602）
 */
function mountDrawer(props: Record<string, unknown> = {}, attach = false, options: { parentActive?: boolean } = {}) {
  const store = useWorkbenchStore();
  const parentRunId = typeof props.parentRunId === 'string' ? props.parentRunId : 'parent-run-aaaa';
  // 只动这一个 store 字段：`sessionId` 留给空串 ⇒ store 里那个名册面板（`useDelegateActivity`）
  // 自己不会起轮询，不会往下面的 `fetch` 计数里混请求。
  store.es.activeRunId = options.parentActive === false ? null : parentRunId;
  return mount(DelegateChildDrawer, {
    props: { sessionId: 'sess-1', parentRunId, childRunId: 'child-run-bbbb', ...props },
    global: { plugins: [i18n] },
    attachTo: attach ? document.body : undefined,
  });
}

/** 推进 fake timers 并冲刷微任务队列（fetch 桩是 promise，纯 advanceTimers 不够）。 */
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.style.overflow = '';
});

describe('DelegateChildDrawer 轮询四条纪律', () => {
  it('③ 打开时已是终态 ⇒ 恰好拉一次，前进 10s 仍然一次', async () => {
    const fetchMock = stubFetch(response({ body: { ...OK_BODY, state: 'completed' } }));
    const wrapper = mountDrawer();
    await tick(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/api/sessions/sess-1/delegates/child-run-bbbb');
    expect(url).toContain('runId=parent-run-aaaa');
    expect(url).toContain('tail=100');

    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it('活态 ⇒ 到 DELEGATE_POLL_MS 就发第二发', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    wrapper.unmount();
  });

  it('③ 第二发转终态 ⇒ 之后不再增长', async () => {
    const fetchMock = stubFetch(
      response({ body: { ...OK_BODY, state: 'running' } }),
      response({ body: { ...OK_BODY, state: 'completed' } }),
    );
    const wrapper = mountDrawer();
    await tick(0);
    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await tick(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('① 单飞：上一发挂住时到点也不并发第二发', async () => {
    let release: (value: StubResponse) => void = () => {};
    const fn = vi.fn(
      () => new Promise((resolve) => { release = (value) => resolve(value); }),
    );
    global.fetch = fn as unknown as typeof fetch;
    const wrapper = mountDrawer();
    await tick(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await tick(DELEGATE_POLL_MS);
    await tick(DELEGATE_POLL_MS);
    expect(fn).toHaveBeenCalledTimes(1); // 挂住期间一次都没多发

    release(response());
    await tick(0);
    await tick(DELEGATE_POLL_MS);
    expect(fn).toHaveBeenCalledTimes(2); // 落定之后恢复按拍
    wrapper.unmount();
  });

  it('④ 卸载 ⇒ timer 清掉、在途请求 abort，前进 10s 次数不增', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer();
    await tick(0);
    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const signal = (fetchMock.mock.calls.at(-1)![1] as RequestInit).signal as AbortSignal;
    wrapper.unmount();
    const at = fetchMock.mock.calls.length;
    expect(signal.aborted).toBe(true);

    await tick(10_000);
    expect(fetchMock.mock.calls.length).toBe(at);
  });

  it('② 标签页不可见 ⇒ 到点不发请求；重新可见立刻补一发', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick(DELEGATE_POLL_MS * 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    spy.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

describe('DelegateChildDrawer 三态与分级', () => {
  it('空 + 活态 ⇒ starting', async () => {
    stubFetch(response({ body: { ...OK_BODY, state: 'running', messages: [] } }));
    const wrapper = mountDrawer();
    await tick(0);
    expect(wrapper.find('[data-testid="delegate-starting"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(COPY.viewer.starting);
    expect(wrapper.find('[data-testid="delegate-empty"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('空 + 终态 ⇒ empty', async () => {
    stubFetch(response({ body: { ...OK_BODY, state: 'completed', messages: [] } }));
    const wrapper = mountDrawer();
    await tick(0);
    expect(wrapper.find('[data-testid="delegate-empty"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(COPY.viewer.empty);
    expect(wrapper.find('[data-testid="delegate-starting"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('请求失败（500）⇒ error 文案 + 重试按钮，点重试再发一次', async () => {
    const fetchMock = stubFetch(response({ ok: false, status: 500 }));
    const wrapper = mountDrawer();
    await tick(0);
    expect(wrapper.find('[data-testid="delegate-error"]').exists()).toBe(true);
    expect(wrapper.text()).toContain(COPY.viewer.error);
    expect(wrapper.text()).toContain('HTTP 500');

    await wrapper.find('[data-testid="delegate-retry"]').trigger('click');
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('XSS：助手正文里的 `<img src=x onerror=…>` 只能当文本，DOM 里不得出现 img（工单 §5 判据 9）', async () => {
    stubFetch(response({
      body: {
        ...OK_BODY,
        state: 'completed',
        messages: [
          { id: 'x1', seq: 1, run_id: 'child-run-bbbb', created_at: 1, role: 'assistant', text: '<img src=x onerror=alert(1)>' },
          { id: 'x2', seq: 2, run_id: 'child-run-bbbb', created_at: 2, role: 'user', text: '<img src=x onerror=alert(2)>' },
        ],
      },
    }));
    const wrapper = mountDrawer();
    await tick(0);
    // 助手正文走 renderMarkdown（先转义后格式化），用户正文走 `{{ }}` 插值（等价 textContent）
    // ⇒ 两路都不可能凭空长出一个真 img。这里拿 DOM 说话，不比字符串（v-html 裸插会直接输出标签）。
    expect(wrapper.findAll('img')).toHaveLength(0);
    expect(wrapper.text()).toContain('<img src=x onerror=alert(1)>');
    expect(wrapper.text()).toContain('<img src=x onerror=alert(2)>');
    wrapper.unmount();
  });

  it('分级：completed 绿 / running 蓝 / aborted 琥珀 / failed 红；completed + syserr termination ⇒ 红', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ state: 'completed' }, 'completed', 'text-green-600'],
      [{ state: 'running' }, 'running', 'text-brand'],
      [{ state: 'aborted' }, 'aborted', 'text-amber-600'],
      [{ state: 'failed' }, 'failed', 'text-red-600'],
      [{ state: 'completed', termination: 'persistence_failed' }, 'failed', 'text-red-600'],
    ];
    for (const [patch, kind, klass] of cases) {
      stubFetch(response({ body: { ...OK_BODY, ...patch } }));
      const wrapper = mountDrawer();
      await tick(0);
      const badge = wrapper.find('[data-testid="delegate-badge"]');
      expect(badge.attributes('data-badge-kind'), JSON.stringify(patch)).toBe(kind);
      expect(badge.classes().join(' '), JSON.stringify(patch)).toContain(klass);
      wrapper.unmount();
    }
  });

  it('user 右对齐小字原样、助手走 Markdown、工具行只在有 argsSummary 时出现', async () => {
    stubFetch(response({
      body: {
        ...OK_BODY,
        state: 'completed',
        truncated: true,
        messages: [
          { id: 'u1', role: 'user', text: '**bold?** 原文' },
          {
            id: 'a1',
            role: 'assistant',
            text: '**hi**',
            toolCalls: [{ name: 'readFile', argsSummary: 'path=a.ts' }, { name: 'grep' }],
          },
        ],
      },
    }));
    const wrapper = mountDrawer();
    await tick(0);

    const items = wrapper.findAll('[data-testid="delegate-message"]');
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain('**bold?** 原文'); // 用户输入不按 Markdown 解释
    expect(items[1].find('.markdown-body').html()).toContain('<strong>hi</strong>');
    const rows = items[1].findAll('li');
    expect(rows).toHaveLength(1); // 无 argsSummary 的那条不渲染
    expect(rows[0].text()).toContain('🔧 readFile · path=a.ts');
    expect(wrapper.text()).toContain(COPY.truncated);
    wrapper.unmount();
  });
});

describe('DelegateChildDrawer dialog 语义', () => {
  it('role/aria-modal、焦点进 dialog、Esc 关闭、卸载归还焦点与滚动锁', async () => {
    stubFetch(response());
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();

    // `close` 走父级回调而不是 test-utils 的 `emitted()`：后者靠 Vue 的 devtools hook 取事件，
    // `NODE_ENV=production` 下不发 devtools 事件 ⇒ 恒空假红（AGENTS.md §4 / issue #496）。
    // 仓库先例（FilePreviewModal.spec / SessionPickerModal.spec）一律用回调；
    // 静态闸 H3（test/repo-hygiene.test.js）钉住了这条口径，别再写回带点的调用形状。
    const onClose = vi.fn();
    const wrapper = mountDrawer({ onClose }, true);
    await tick(0);
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(dialog.attributes('aria-label')).toContain(COPY.viewerTitle.replace('{id}', shortRunId('child-run-bbbb')));
    expect(document.activeElement).toBe(dialog.element);
    expect(document.body.style.overflow).toBe('hidden');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(0);
    expect(onClose).toHaveBeenCalledTimes(1);

    wrapper.unmount();
    expect(document.body.style.overflow).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(fetch).toHaveBeenCalledTimes(1);
    trigger.remove();
  });

  it('头部有标题（带短码）与刷新按钮，点刷新立刻多发一次', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer({ childRunId: 'run-child-ccccdddd' });
    await tick(0);
    expect(wrapper.text()).toContain(COPY.viewerTitle.replace('{id}', shortRunId('run-child-ccccdddd'))); // 短码 = 后 8 位
    expect(wrapper.find('[data-testid="delegate-badge"]').text()).toBe(COPY.state.running);

    await wrapper.find('[data-testid="delegate-refresh"]').trigger('click');
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});

// issue #602：后台子 run 随父 worker 进程消失 ⇒ 引擎那句 `finishRun` 永不执行 ⇒ 名册**永久**停在
// `running`，而旧代码的「终态即停」永不触发 ⇒ 抽屉开了就是永久 2s 一发（真机：10s 内 5 发）。
// 修法的前置：轮询只服务于「父 run 仍是当前活跃 run」（`store.es.activeRunId`）。
describe('DelegateChildDrawer 父 run 结束后停止轮询（issue #602）', () => {
  it('父 run 已结束 ⇒ 首发之后零请求（推进 10 拍也不多发一发）', async () => {
    const fetchMock = stubFetch(response()); // 名册 state 仍是 running（就是真机那个卡死形状）
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 打开抽屉该读到的一次还是要有（只读账本仍然有价值）

    await tick(DELEGATE_POLL_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 之后一发都不发
    wrapper.unmount();
  });

  it('父 run 已结束 ⇒ 出现那行中性说明，且不是告警（无 ⚠ / 无 text-red-600）', async () => {
    stubFetch(response());
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);

    const note = wrapper.get('[data-testid="delegate-parent-ended"]');
    expect(note.text()).toBe(COPY.viewer.parentEnded);
    expect(note.classes()).toContain('text-black/40'); // 与 `delegate.polling` 那行同一中性小字
    expect(wrapper.text()).not.toContain('⚠');
    expect(wrapper.html()).not.toContain('text-red-600');
    // 「运行中，自动刷新」那句不再挂着（真机上它就是永久轮询的自供状）
    expect(wrapper.text()).not.toContain(COPY.polling);
    wrapper.unmount();
  });

  it('父 run 已结束 ⇒ 徒章不再转圈，按 `unknown` 中性档收（不拿旧 running 谎报「运行中」）', async () => {
    stubFetch(response());
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);

    const badge = wrapper.get('[data-testid="delegate-badge"]');
    expect(badge.find('svg.animate-spin').exists()).toBe(false);
    expect(badge.attributes('data-badge-kind')).toBe('unknown');
    expect(badge.classes().join(' ')).toContain('text-black/50');
    expect(badge.text()).toBe(`${DELEGATE_UNKNOWN_MARK}${COPY.state.unknown}`); // 中性点 + 「状态未知」
    wrapper.unmount();
  });

  it('不误伤：父 run 已结束而名册**已终态** ⇒ 不出那句说明（那是已知答案，不是未知）', async () => {
    stubFetch(response({ body: { ...OK_BODY, state: 'completed' } }));
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);

    expect(wrapper.find('[data-testid="delegate-parent-ended"]').exists()).toBe(false);
    const badge = wrapper.get('[data-testid="delegate-badge"]');
    expect(badge.attributes('data-badge-kind')).toBe('completed');
    expect(badge.classes().join(' ')).toContain('text-green-600'); // ✓ 绿照常（#602 只动「活态卡死」）
    wrapper.unmount();
  });

  it('不误伤：手动「刷新」在父 run 结束后仍可用（停的是自动轮询，不是用户的出口）', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await wrapper.find('[data-testid="delegate-refresh"]').trigger('click');
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(DELEGATE_POLL_MS * 3); // 手动那一发之后也不得把自动链子救活
    expect(fetchMock).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });

  it('抽屉开着时父 run 收尾（`activeRunId` 变 null）⇒ 当场停：已排的那一发跑完就不再续', async () => {
    const store = useWorkbenchStore();
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer(); // 默认父 run 活跃
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await tick(DELEGATE_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    store.es.activeRunId = null; // run_end 到了
    await nextTick();
    await tick(DELEGATE_POLL_MS * 5);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 一条新请求都不许发
    expect(wrapper.find('[data-testid="delegate-parent-ended"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('父 run 已结束 ⇒ 标签页重新可见也不补一发（自动刷新全停，不只是 timer）', async () => {
    const fetchMock = stubFetch(response());
    const wrapper = mountDrawer({}, false, { parentActive: false });
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick(0);
    spy.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });
});
