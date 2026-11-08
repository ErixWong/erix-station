// DelegateChildDrawer 的轮询纪律与三态（issue #delegate P3 交付 3）。
// 四条纪律各一条反证用例（终态只拉一次 / 活态按拍 / 转终态即停 / 单飞 / 卸载即停），
// 加上三态文案、分级颜色、dialog 语义与渲染形状。
// 时间全部走 fake timers，`fetch` 全部走桩：这里测的是**客户端纪律**，不是后端契约。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import DelegateChildDrawer from './DelegateChildDrawer.vue';
import { zhCN } from '../i18n/locales/zh-CN';
import { DELEGATE_POLL_MS, shortRunId } from '../lib/delegate';

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

function mountDrawer(props: Record<string, unknown> = {}, attach = false) {
  return mount(DelegateChildDrawer, {
    props: { sessionId: 'sess-1', parentRunId: 'parent-run-aaaa', childRunId: 'child-run-bbbb', ...props },
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

    // `close` 走父级回调而不是 `wrapper.emitted()`：本环境（vitest 5）对 script-setup 组件的
    // emitted() 不记录，仓库先例（FilePreviewModal.spec / SessionPickerModal.spec）一律用回调。
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
