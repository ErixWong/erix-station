// 子 run 活动徽标 + 面板的**渲染契约**（issue #592 交付 2/3，判据 13~16 的界面那一半）。
//
// 为什么有一个 `h(...)` 拼出来的宿主：徽标在 `RunStatusBar` 尾部、面板在 `WorkbenchView` 的状态条
// 下方、抽屉的**唯一挂载点在 `StreamPanel`**——判据 14（点「查看」出抽屉）要求这三样在**同一棵树**里
// 同时活着，才测得出「状态上提成共享状态」这件事真的生效（各自单挂一个组件就只会测到自己那块皮）。
//
// ⚠ 全部断言走 DOM 与 fetch 桩，**不用** `w.emitted()`（`NODE_ENV=production` 下恒空，AGENTS.md §4
//   / issue #496；静态闸 H3 `test/repo-hygiene.test.js` 钉着）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import DelegateActivityBar from './DelegateActivityBar.vue';
import DelegateChildDrawer from './DelegateChildDrawer.vue';
import RunStatusBar from './RunStatusBar.vue';
import StreamPanel from './StreamPanel.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { DELEGATE_ACTIVITY_FAIL_THRESHOLD } from '../composables/useDelegateActivity';
import { shortRunId } from '../lib/delegate';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';

const SESSION = 'sess-1';
const PARENT = 'run-parent-1';
const COPY = zhCN.delegate.activity;
const STATE = zhCN.delegate.state;

/** 名册一行（缺省 = 活着的 running 子；各用例只覆盖自己要的那格）。 */
function rosterItem(overrides: Record<string, unknown> = {}) {
  return {
    childRunId: 'sub-aaaa-1111',
    state: 'running',
    cwd: '~/projects/demo',
    model: 'gpt-6-luna',
    createdAt: 1_700_000_000_000,
    endedAt: null,
    updatedAt: null,
    termination: null,
    errorMessage: null,
    resultTruncated: false,
    hasTranscript: true,
    ...overrides,
  };
}

const fetchMock = vi.fn();

/**
 * 取**可见面**再断言：`html()` 会把**模板注释**一起返回，而注释里的字符不是界面内容。
 *
 * ⚠ 为什么必须剥注释：`NODE_ENV=development` 下 Vue 编译器**保留**模板注释，`production` 下**剔掉**它们
 * ——同一行断言会在两种 env 下一个绿一个红（实际踩过：模板注释里写了个「无 ⚠」，把「面板里不许出现 ⚠」
 * 那条判据当场打红，而在 `NODE_ENV=production` 的 shell 里却看不出来）。判据要的是「可见内容里没有告警
 * 图标」，所以先剔注释再比：以后谁在注释里写什么字符（⚠ / 🔧 / 颜色类）都不该误红。
 */
function visibleHtml(node: { html(): string }): string {
  return node.html().replace(/<!--[\s\S]*?-->/g, '');
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null }, // `api()` 会读 `Retry-After`（#255）⇒ 桩必须带 headers
    json: async () => body,
  };
}

/** 名册响应按调用序吐出（用尽后重复最后一个）；抽屉的账本端点恒回终态 ⇒ 抽屉只拉一次，不留 timer。 */
function stubRoster(...bodies: unknown[]) {
  let at = 0;
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (!url.includes('/delegates?')) {
      return jsonResponse(200, { childRunId: 'sub-aaaa-1111', state: 'completed', messages: [], truncated: false, totalTurns: 1 });
    }
    const body = bodies[Math.min(at, bodies.length - 1)];
    at += 1;
    return body instanceof Error ? jsonResponse(500, { error: { message: 'boom', code: 'internal_error' } }) : jsonResponse(200, body);
  });
}

/** 徽标 + 面板 + 抽屉（抽屉唯一挂载点在 StreamPanel 里）挂在同一棵树。 */
function mountSurface() {
  const Host = defineComponent({
    setup: () => () => h('div', [h(RunStatusBar), h(DelegateActivityBar), h(StreamPanel)]),
  });
  return mount(Host, { global: { plugins: [i18n] } });
}

/** 真实事件流建一张 delegate 卡（**不手搓卡片对象** ⇒ 测的是真建卡路径的产物，含 `card.runId`）。 */
function driveDelegateCard(store: ReturnType<typeof useWorkbenchStore>, callId = 'c1') {
  store.es.handleEvent('tool_use', { data: JSON.stringify({
    run_id: PARENT, tool_call_id: callId, name: 'delegate', input: { task: '做点事' }, seq: 1,
  }) } as MessageEvent);
}

async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  await nextTick();
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_042_000);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const store = useWorkbenchStore();
  store.sessionId = SESSION;
  store.es.activeRunId = PARENT;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('徽标（判据 13：数 = 活态子数；N=0 整段不出）', () => {
  it('2 活 2 终 ⇒ 徽标只数 2，且它真的挂在 RunStatusBar 里（不是第二条状态条）', async () => {
    stubRoster({ items: [
      rosterItem({ childRunId: 'sub-live-aaaa', state: 'running' }),
      rosterItem({ childRunId: 'sub-live-bbbb', state: 'queued' }),
      rosterItem({ childRunId: 'sub-done-cccc', state: 'completed' }),
      rosterItem({ childRunId: 'sub-bad-dddd', state: 'failed' }),
    ] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);

    const badge = wrapper.get('[data-testid="delegate-activity-badge"]');
    expect(badge.text()).toContain(COPY.title.replace('{count}', '2'));
    // 落点：徽标是状态条的**尾部一段**（判据「徽标必须在状态条里」）——从状态条里找得到它，
    // 而不是页面上多出了第二条状态条。
    expect(wrapper.get('.run-status-bar').find('[data-testid="delegate-activity-badge"]').exists()).toBe(true);
    expect(wrapper.findAll('.run-status-bar')).toHaveLength(1);
    expect(store.delegateLiveCount).toBe(2);
    expect(store.delegateRows).toHaveLength(4); // 面板行仍含终态子（徽标不数 ≠ 面板不画）
  });

  it('全部子终态 ⇒ 徽标整段不渲染（连容器都不留）', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-done-cccc', state: 'completed' })] });
    const store = useWorkbenchStore();
    // 结果已回但**卡片说子还活着**（后台子 `background:true` 的形状）⇒ 会拉一次名册。
    store.es.handleEvent('tool_use', { data: JSON.stringify({
      run_id: PARENT, tool_call_id: 'c1', name: 'delegate', input: {}, seq: 1,
    }) } as MessageEvent);
    store.es.handleEvent('tool_result', { data: JSON.stringify({
      run_id: PARENT, tool_call_id: 'c1', ok: true, seq: 2,
      result_digest: JSON.stringify({ ok: true, runId: 'sub-done-cccc', state: 'running', action: 'dispatch' }),
    }) } as MessageEvent);
    const wrapper = mountSurface();
    await tick(0);
    expect(store.delegateRows).toHaveLength(1);
    expect(wrapper.find('[data-testid="delegate-activity-badge"]').exists()).toBe(false);
    expect(store.delegateLiveCount).toBe(0);
  });

  it('没有 delegate 卡 ⇒ 徽标不出、一个请求都不发（判据 9 的界面面）', async () => {
    stubRoster({ items: [] });
    const wrapper = mountSurface();
    await tick(6_000);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="delegate-activity-badge"]').exists()).toBe(false);
  });
});

describe('展开/收起（共享状态：徽标与面板两个组件读写同一份）', () => {
  it('点徽标 ⇒ 面板出现、`aria-expanded` 翻 true；再点 ⇒ 收起', async () => {
    stubRoster({ items: [rosterItem()] });
    driveDelegateCard(useWorkbenchStore());
    const wrapper = mountSurface();
    await tick(0);

    const badge = wrapper.get('[data-testid="delegate-activity-badge"]');
    expect(badge.attributes('aria-expanded')).toBe('false');
    expect(wrapper.find('[data-testid="delegate-activity-panel"]').exists()).toBe(false);

    await badge.trigger('click');
    expect(wrapper.get('[data-testid="delegate-activity-panel"]').text()).toContain(COPY.panelTitle.replace('{count}', '1'));
    expect(wrapper.get('[data-testid="delegate-activity-badge"]').attributes('aria-expanded')).toBe('true');

    await wrapper.get('[data-testid="delegate-activity-collapse"]').trigger('click');
    expect(wrapper.find('[data-testid="delegate-activity-panel"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="delegate-activity-badge"]').attributes('aria-expanded')).toBe('false');
  });

  it('行内容：短码 + 状态文案 + 已跑时长；`activity` 缺席（旧后端 / 没带 `activity=1`）⇒ 那一格不渲染', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-6eda7fa1', state: 'running', createdAt: 1_700_000_000_000 })] });
    driveDelegateCard(useWorkbenchStore());
    const wrapper = mountSurface();
    await tick(0);
    useWorkbenchStore().toggleDelegatePanel();
    await nextTick();

    const row = wrapper.get('[data-testid="delegate-activity-panel"] li');
    expect(row.text()).toContain(shortRunId('sub-6eda7fa1'));
    expect(row.text()).toContain(STATE.running);
    expect(row.text()).toContain(COPY.elapsed.replace('{dur}', '42.0s')); // createdAt + 客户端时钟
    // 状态点颜色唯一来源 DELEGATE_BADGE_CLASS[delegateBadgeKind(...)]：running ⇒ text-brand
    expect(row.get('.delegate-activity-dot').classes()).toContain('text-brand');
    // `activity` 缺席（这一批 fixture 就没带）⇒ 那一格不渲染（不拿假摘要填空白）。
    expect(row.find('.delegate-activity-action').exists()).toBe(false);
    expect(row.text()).not.toContain('🔧');
  });

  it('Esc 收起面板（抽屉开着时让位，一次 Esc 只关最上层那一样）', async () => {
    stubRoster({ items: [rosterItem()] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);
    store.toggleDelegatePanel();
    await nextTick();
    expect(wrapper.find('[data-testid="delegate-activity-panel"]').exists()).toBe(true);

    store.openDelegateViewer({ parentRunId: PARENT, childRunId: 'sub-aaaa-1111', label: 'delegate' });
    await nextTick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(store.delegateViewer).toBeNull(); // 抽屉先关
    expect(wrapper.find('[data-testid="delegate-activity-panel"]').exists()).toBe(true); // 面板不跟着关
  });
});

describe('判据 14：点「查看」打开抽屉（DOM 断言，抽屉仍只有 StreamPanel 一个实例）', () => {
  it('点行上的「查看」⇒ DOM 里长出抽屉，标题是「子任务 <短码>」，且全树只有一个实例', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-6eda7fa1-dead' })] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);
    store.toggleDelegatePanel();
    await nextTick();
    expect(wrapper.findAllComponents(DelegateChildDrawer)).toHaveLength(0);

    await wrapper.get('.delegate-activity-view').trigger('click');
    await flushPromises();
    const drawers = wrapper.findAllComponents(DelegateChildDrawer);
    expect(drawers).toHaveLength(1); // 判据：不是「再挂一个抽屉实例」
    const dialog = wrapper.get('[role="dialog"]');
    expect(dialog.text()).toContain(zhCN.delegate.viewerTitle.replace('{id}', shortRunId('sub-6eda7fa1-dead')));
    expect(drawers[0].props()).toMatchObject({ sessionId: SESSION, parentRunId: PARENT, childRunId: 'sub-6eda7fa1-dead' });
  });

  it('工具卡那条老入口仍然打得开（上提之后两个入口写同一份状态）', async () => {
    stubRoster({ items: [] });
    const store = useWorkbenchStore();
    store.es.handleEvent('tool_use', { data: JSON.stringify({
      run_id: PARENT, tool_call_id: 'c1', name: 'delegate', input: {}, seq: 1,
    }) } as MessageEvent);
    store.es.handleEvent('tool_result', { data: JSON.stringify({
      run_id: PARENT, tool_call_id: 'c1', ok: true, seq: 2,
      result_digest: JSON.stringify({ ok: true, runId: 'sub-6eda7fa1', state: 'completed', action: 'dispatch' }),
    }) } as MessageEvent);
    const wrapper = mountSurface();
    await tick(0);
    await wrapper.get('.delegate-open-viewer').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').text()).toContain(zhCN.delegate.viewerTitle.replace('{id}', shortRunId('sub-6eda7fa1')));
  });
});

describe('必修 1：首次就失败 ⇒ 降级态必须可达（设计 §4.2「连续 N 次失败降级成一行中性提示」）', () => {
  it(`从未成功拉到过：连 ${DELEGATE_ACTIVITY_FAIL_THRESHOLD} 次 500 ⇒ 徒标以中性灰出现，点开面板看到那行灰字`, async () => {
    stubRoster(new Error('boom'));
    driveDelegateCard(useWorkbenchStore());
    const wrapper = mountSurface();

    // 第一发在 setup 当场，之后每 2s 一发 ⇒ 共 3 发之后才降级。
    await tick(0);
    expect(wrapper.find('[data-testid="delegate-activity-badge"]').exists()).toBe(false); // 1 次失败：还静默
    await tick(2_000);
    await tick(2_000);

    const badge = wrapper.get('[data-testid="delegate-activity-badge"]');
    expect(badge.text()).toContain(COPY.titleUnknown); // 「子任务 ?」而不是「子任务 0」
    expect(badge.attributes('data-degraded')).toBe('true');
    const klass = badge.classes().join(' ');
    expect(klass).toContain('text-black/50'); // 中性灰
    expect(klass).not.toContain('text-brand'); // 不拿品牌色冒充「在跑」
    expect(klass).not.toContain('text-red-600'); // 也不是故障红
    expect(badge.find('svg.animate-spin').exists()).toBe(false); // 读不到就不装转圈
    expect(badge.attributes('aria-label')).toBe(COPY.toggleUnknown);

    await badge.trigger('click'); // 徒标是唯一入口：它必须还能点开面板
    const panel = wrapper.get('[data-testid="delegate-activity-panel"]');
    expect(panel.text()).toContain(COPY.unreadable);
    expect(visibleHtml(panel)).not.toContain('text-red-600');
    expect(visibleHtml(panel)).not.toContain('⚠');
    // 降级态下标题也不拿 0 冒充「没有」。
    expect(panel.text()).toContain(COPY.titleUnknown);
  });

  it('拉到过东西之后的失败 ⇒ 徒标不进降级态（行还在就照旧报数，灰字只在面板里）', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-live-aaaa' })] }, new Error('boom'));
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);

    const badge = wrapper.get('[data-testid="delegate-activity-badge"]');
    expect(badge.attributes('data-degraded')).toBe('false');
    expect(badge.classes().join(' ')).toContain('text-brand');

    for (let i = 0; i < DELEGATE_ACTIVITY_FAIL_THRESHOLD; i += 1) {
      await tick(2_000);
    }
    // 仍报数（不是 `?`）、仍是蓝的：上次拉到的行没被失败洗掉。
    expect(wrapper.get('[data-testid="delegate-activity-badge"]').attributes('data-degraded')).toBe('false');
    expect(store.delegateDegraded).toBe(false);
    expect(store.delegateRowsUnavailable).toBe(true);
  });
});

describe('W3：「最近动作」那一格（#593 的 activity）与 stale 行', () => {
  /** 把面板展开并返回行容器（按 childRunId 认行，不靠顺序）。 */
  async function openPanel(store: ReturnType<typeof useWorkbenchStore>, wrapper: ReturnType<typeof mountSurface>) {
    await tick(0);
    store.toggleDelegatePanel();
    await nextTick();
    return { rows: wrapper.findAll('[data-testid="delegate-activity-panel"] li'), wrapper };
  }

  it('kind=tool ⇒ `🔧 {tool} · {args}`；args 缺席 ⇒ 只出 `🔧 {tool}`', async () => {
    stubRoster({ items: [
      rosterItem({ childRunId: 'sub-t1', activity: { kind: 'tool', tool: 'bash', args: 'npm test --silent', stale: false } }),
      rosterItem({ childRunId: 'sub-t2', activity: { kind: 'tool', tool: 'readFile', stale: false } }),
    ] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    const { rows } = await openPanel(store, wrapper);
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.delegate-activity-action').text()).toBe('🔧 bash · npm test --silent');
    expect(rows[1].find('.delegate-activity-action').text()).toBe('🔧 readFile');
  });

  it('kind=text ⇒ `💬 {text}`；kind=tool_result ⇒ `✓ {text}`', async () => {
    stubRoster({ items: [
      rosterItem({ childRunId: 'sub-x1', activity: { kind: 'text', text: '正在整理结论…', stale: false } }),
      rosterItem({ childRunId: 'sub-x2', activity: { kind: 'tool_result', text: '3 files changed', stale: false } }),
    ] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const { rows } = await openPanel(store, mountSurface());
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.delegate-activity-action').text()).toBe('💬 正在整理结论…');
    expect(rows[1].find('.delegate-activity-action').text()).toBe('✓ 3 files changed');
  });

  it('kind=none（终态子的形状）与**字段缺席**⇒ 整格不渲染：不出空框、不写「未知」也不写破折号', async () => {
    stubRoster({ items: [
      rosterItem({ childRunId: 'sub-n1', state: 'completed', activity: { kind: 'none', turns: null, stale: false } }),
      // kind 说自己是 tool，但 tool 没给（#593 允许缺键）⇒ 同样整格不出，不能出一个 `🔧 ?`。
      rosterItem({ childRunId: 'sub-n2', activity: { kind: 'tool', stale: false } }),
      // text 类但 text 缺席。
      rosterItem({ childRunId: 'sub-n3', activity: { kind: 'text', stale: false } }),
    ] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    const { rows } = await openPanel(store, wrapper);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.find('.delegate-activity-action').exists()).toBe(false);
    }
    // 整个面板里不许出现图标占位、破折号或「未知」（没内容就是没内容，不拿假字符填空）。
    const panelText = wrapper.get('[data-testid="delegate-activity-panel"]').text();
    expect(panelText).not.toContain('🔧');
    expect(panelText).not.toContain('💬');
    expect(panelText).not.toContain('—');
    expect(panelText).not.toContain(zhCN.delegate.state.unknown); // 这三行都没 stale
  });

  it('stale 行 ⇒ 状态点中性灰（不是红也不是绿）+ 一行说明 + **不计入徽标数**', async () => {
    stubRoster({ items: [
      rosterItem({ childRunId: 'sub-zombie', state: 'running', activity: { kind: 'tool', tool: 'bash', args: 'sleep 60', stale: true } }),
      rosterItem({ childRunId: 'sub-real', state: 'running' }),
    ] });
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);
    // 判据 ②：两条名册活态，只有 1 条算「在跑」。
    expect(wrapper.get('[data-testid="delegate-activity-badge"]').text()).toContain(COPY.title.replace('{count}', '1'));

    store.toggleDelegatePanel();
    await nextTick();
    const rows = wrapper.findAll('[data-testid="delegate-activity-panel"] li');
    const staleRow = rows[0];
    expect(staleRow.attributes('data-child-run-id')).toBe('sub-zombie');
    const dot = staleRow.get('.delegate-activity-dot');
    const dotClass = dot.classes().join(' ');
    expect(dotClass).toContain('text-black/50'); // 中性灰（DELEGATE_BADGE_CLASS.unknown）
    expect(dotClass).not.toContain('text-brand'); // 不拿蓝色冒充「在跑」
    expect(dotClass).not.toContain('text-green-600');
    expect(dotClass).not.toContain('text-red-600');
    expect(dot.attributes('data-badge-kind')).toBe('unknown');
    expect(staleRow.get('[data-testid="delegate-activity-stale"]').text()).toBe(COPY.staleParentEnded);
    // 状态文字也不拿旧 `running` 继续报「运行中」（那是谎报）。
    expect(staleRow.text()).toContain(zhCN.delegate.state.unknown);
    expect(staleRow.text()).not.toContain(STATE.running);
    // 另一行不受影响：仍蓝、仍计数。
    const liveDot = rows[1].get('.delegate-activity-dot');
    expect(liveDot.classes()).toContain('text-brand');
    expect(liveDot.attributes('data-badge-kind')).toBe('running');
  });

  it('全部行都 stale ⇒ 徽标整段不出（一堆「不知道」不等于「在跑」）', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-z1', state: 'running', activity: { kind: 'none', stale: true } })] });
    driveDelegateCard(useWorkbenchStore());
    const wrapper = mountSurface();
    await tick(0);
    expect(wrapper.find('[data-testid="delegate-activity-badge"]').exists()).toBe(false);
  });
});

describe('判据 15/16：pending 卡触发与失败静默', () => {
  // ⚠ **名字只声明它真正证明的东西**（独立验收复核指出旧名「刷新路径」名不副实）：这张卡是
  // `es.handleEvent('tool_use', …)` 建的（实时链路），**没走** `openSession` 的历史回放入口。
  // 本用例判的是**触发形状**（`ok:null` 且 `runId === activeRunId` 的 delegate 卡 ⇒ 轮询 + 出行），
  // 而该形状与硬刷新后回放重建出的那张**逐字段同形**（回放也填 `card.runId`，`#delegate` 已有
  // 专测钉住）；回放链路本身归 `StreamPanel.spec.ts` / `DelegateToolCard.spec.ts` 管，不在这里假装验过。
  it('pending 卡（`ok:null` 且 `runId === activeRunId`，与回放重建的那张同形）⇒ 触发轮询并渲染行', async () => {
    stubRoster({ items: [rosterItem({ childRunId: 'sub-live-aaaa', state: 'running' })] });
    const store = useWorkbenchStore();
    // 只有 `tool_use`、没有 `tool_result` ⇒ 卡片 `ok === null`，与硬刷新后由历史白名单重建出来的形状一致。
    driveDelegateCard(store);
    expect(store.es.toolCards.get(`${PARENT}:c1`)).toMatchObject({ name: 'delegate', ok: null, runId: PARENT });
    const wrapper = mountSurface();
    await tick(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    store.toggleDelegatePanel();
    await nextTick();
    const rows = wrapper.findAll('[data-testid="delegate-activity-panel"] li');
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain(shortRunId('sub-live-aaaa'));
  });

  it(`端点 500 ⇒ 保留上次的行；连续 ${DELEGATE_ACTIVITY_FAIL_THRESHOLD} 次才出一行灰字，且**不是红条**`, async () => {
    stubRoster(
      { items: [rosterItem({ childRunId: 'sub-live-aaaa' })] },
      new Error('boom'),
    );
    const store = useWorkbenchStore();
    driveDelegateCard(store);
    const wrapper = mountSurface();
    await tick(0);
    store.toggleDelegatePanel();
    await nextTick();
    expect(wrapper.findAll('li')).toHaveLength(1);

    await tick(2_000); // 第一次失败
    expect(store.delegateRows).toHaveLength(1); // 数据没被清空
    expect(wrapper.find('[data-testid="delegate-activity-unavailable"]').exists()).toBe(false);

    for (let i = 1; i < DELEGATE_ACTIVITY_FAIL_THRESHOLD; i += 1) {
      await tick(2_000);
      expect(wrapper.findAll('li'), `第 ${i} 次失败后行还在`).toHaveLength(1);
    }
    await tick(2_000);
    const note = wrapper.get('[data-testid="delegate-activity-unavailable"]');
    expect(note.text()).toBe(COPY.unreadable);
    expect(wrapper.findAll('li')).toHaveLength(1); // 行仍然保留（静默保留上次数据）
    // 灰字不是告警：整块面板里不许出现红色类（子 run 是加分项，读不到不该把父界面打成故障态）。
    const panel = wrapper.get('[data-testid="delegate-activity-panel"]');
    expect(visibleHtml(panel)).not.toContain('text-red-600');
    expect(visibleHtml(panel)).not.toContain('border-red');
    expect(visibleHtml(panel)).not.toContain('⚠');
  });
});
