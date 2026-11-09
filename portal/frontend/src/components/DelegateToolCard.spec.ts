// delegate 工具卡（issue #delegate 接线轮）：把已完成的 DelegateChildDrawer 接到 StreamPanel 上。
// 覆盖工单 §2/§3 的四个判据 + 「刷新后也打得开」这条（runId 必须在**投影建卡**路径上也填）。
// store 状态走真实事件流（`store.es.handleEvent`）/ 真实投影入口（`projectToolCard`）驱动，
// 不手搓窄类型卡片对象 ⇒ 测的是真实归并/建卡链路的产物。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import StreamPanel from './StreamPanel.vue';
import DelegateChildDrawer from './DelegateChildDrawer.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { parseDelegateResult, shortRunId } from '../lib/delegate';
import { i18n, setLocale } from '../i18n';
import { zhCN } from '../i18n/locales/zh-CN';

const VIEWER_LABEL = zhCN.delegate.openViewer;

function frame(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

/** 实时路：一次 delegate 调用 + 它的 tool_result（digest 就是工单里的 `{ok,runId,state,action}` 信封）。 */
function driveDelegate(store: ReturnType<typeof useWorkbenchStore>, result: unknown, toolResultOk = true, callId = 'c1') {
  store.es.handleEvent('tool_use', frame({
    run_id: 'run-1', tool_call_id: callId, name: 'delegate', input: { task: '做点事' }, seq: 1,
  }));
  store.es.handleEvent('tool_result', frame({
    run_id: 'run-1', tool_call_id: callId, ok: toolResultOk, seq: 2,
    result_digest: typeof result === 'string' ? result : JSON.stringify(result),
  }));
}

function mountPanel() {
  return mount(StreamPanel, { global: { plugins: [i18n] } });
}

/**
 * 真机形状：加载/刷新路径的 `toolCalls[].resultPreview` 是上游**截到 400 字**的结果预览（末尾 `…`）。
 * 前缀里 `ok`/`runId`/`state`/`action` 都在截断点之前，但引号不闭合 ⇒ `JSON.parse` 必抛（下面有用例钉住）。
 */
const TRUNCATED_PREVIEW = [
  '{',
  '  "ok": true,',
  '  "runId": "sub-6eda7fa1-03b2-4f36-b3f2-254662979dda",',
  '  "state": "completed",',
  '  "termination": "end_turn",',
  '  "action": "dispatch",',
  '  "text": "**结论：没有 .md 文件。**本轮只改了代码与测试，没有产出文档，改动清单见上面三个文件路径，其中两个是测试…',
].join('\n');

/** 刷新/加载路径建卡（与真机一致：卡片只有 400 字预览，没有实时 `out`），并补上宿主占位 entry。 */
function driveLoadedDelegate(store: ReturnType<typeof useWorkbenchStore>, resultPreview: string, callId = 'c1') {
  store.es.projectToolCard(`run-1:${callId}`, {
    name: 'delegate',
    argsSummary: 'task=做点事',
    resultPreview,
    isError: false,
  }, { key: `run-1:${callId}`, runId: 'run-1', roundToken: '?', callId });
  // 投影路径不产 entries ⇒ 宿主占位由 onToolCardCreated 负责，这里按同一键补一条（与实时路等价形状）。
  if (!store.entries.some((en) => en.kind === 'tool' && en.callId === `run-1:${callId}`)) {
    store.entries.push({ kind: 'tool', callId: `run-1:${callId}` });
  }
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  const store = useWorkbenchStore();
  store.sessionId = 'sess-1';
  // 抽屉一挂载就发请求；返回**终态**（completed）⇒ 只拉一次，用例尾部不留 timer。
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ childRunId: 'sub-child-aaaa', state: 'completed', messages: [], truncated: false, totalTurns: 1 }),
    { status: 200 },
  )));
});

describe('delegate 工具卡（接线到 DelegateChildDrawer）', () => {
  it('tool_result 是 {ok:true,runId,state:completed} ⇒ 头行出「查看子 run」按钮，摘要位是 action · 子runId 短码', async () => {
    const store = useWorkbenchStore();
    driveDelegate(store, { ok: true, runId: 'sub-child-aaaa', state: 'completed', action: 'dispatch' });
    const wrapper = mountPanel();
    const btn = wrapper.find('.delegate-open-viewer');
    expect(btn.exists()).toBe(true);
    expect(btn.attributes('aria-label')).toBe(VIEWER_LABEL);
    expect(btn.attributes('title')).toBe(VIEWER_LABEL);
    // 短码 = `lib/delegate.shortRunId`（后 8 位），不在测试里重造口径。
    expect(wrapper.get('.delegate-summary').text()).toBe(`dispatch · ${shortRunId('sub-child-aaaa')}`);
    // completed ⇒ ✓ 绿
    expect(wrapper.get('.delegate-state').classes()).toEqual(expect.arrayContaining(['delegate-state', 'text-green-600']));
    expect(wrapper.get('.delegate-state').text()).toBe('✓');
  });

  it('ok:false（capacity_full）⇒ 没有按钮，状态位也不谎报成功', () => {
    const store = useWorkbenchStore();
    // tool_result 本身 ok:true（调用成功了），但**载荷** ok:false ⇒ 按钮的闸看载荷，不看卡片 ok。
    driveDelegate(store, { ok: false, reason: 'capacity_full' });
    const wrapper = mountPanel();
    expect(wrapper.find('.delegate-open-viewer').exists()).toBe(false);
    expect(wrapper.find('.delegate-state').exists()).toBe(true);
  });

  it('state:failed ⇒ 红；state:completed + termination:persistence_failed ⇒ 仍红（不谎报成功）', () => {
    const store = useWorkbenchStore();
    driveDelegate(store, { ok: true, runId: 'sub-child-aaaa', state: 'failed', action: 'dispatch' }, true, 'c1');
    driveDelegate(store, {
      ok: true, runId: 'sub-child-bbbb', state: 'completed', action: 'dispatch', termination: 'persistence_failed',
    }, true, 'c2');
    const wrapper = mountPanel();
    const marks = wrapper.findAll('.delegate-state');
    expect(marks).toHaveLength(2);
    expect(marks[0].classes()).toContain('text-red-600');
    expect(marks[0].text()).toBe('✗');
    expect(marks[1].classes()).toContain('text-red-600');
    expect(marks[1].text()).toBe('✗');
  });

  it('点按钮 ⇒ 渲染 DelegateChildDrawer（props 带父/子 runId），close 后卸载', async () => {
    const store = useWorkbenchStore();
    driveDelegate(store, { ok: true, runId: 'sub-child-aaaa', state: 'running', action: 'dispatch' });
    const wrapper = mountPanel();
    expect(wrapper.findComponent(DelegateChildDrawer).exists()).toBe(false);
    // queued/running ⇒ spinner（蓝）而非 ✓
    const state = wrapper.get('.delegate-state');
    expect(state.classes()).toContain('text-brand');
    expect(state.find('svg.animate-spin').exists()).toBe(true);
    await wrapper.get('.delegate-open-viewer').trigger('click');
    const drawer = wrapper.findComponent(DelegateChildDrawer);
    expect(drawer.exists()).toBe(true);
    expect(drawer.props()).toMatchObject({
      sessionId: 'sess-1', parentRunId: 'run-1', childRunId: 'sub-child-aaaa', label: 'delegate',
    });
    drawer.vm.$emit('close');
    await flushPromises();
    expect(wrapper.findComponent(DelegateChildDrawer).exists()).toBe(false);
  });

  it('刷新/加载路径（projectToolCard）建的卡也带 runId ⇒ 抽屉照样打得开', async () => {
    const store = useWorkbenchStore();
    driveLoadedDelegate(store, JSON.stringify({ ok: true, runId: 'sub-child-cccc', state: 'completed', action: 'dispatch' }), 'c1');
    expect(store.es.toolCards.get('run-1:c1')?.runId).toBe('run-1');
    const wrapper = mountPanel();
    const btn = wrapper.find('.delegate-open-viewer');
    expect(btn.exists()).toBe(true);
    await btn.trigger('click');
    const drawer = wrapper.findComponent(DelegateChildDrawer);
    expect(drawer.exists()).toBe(true);
    expect(drawer.props()).toMatchObject({ parentRunId: 'run-1', childRunId: 'sub-child-cccc' });
  });

  // 真机回归（2026-12）：刷新后的 resultPreview 是**截到 400 字**的前缀 ⇒ 整体 JSON.parse 必抛。
  // 当时卡片走回退分支 ⇒ runId 为空 ⇒ 「查看子 run」按钮在刷新后整片消失（实时看起来却一切正常）。
  it('resultPreview 被上游截到 400 字（JSON.parse 必抛）⇒ 刷新后仍出按钮且 runId 完整', async () => {
    // 这条 fixture 必须真的是「截断到 parse 不回去」的形状，否则用例测的就不是那个 bug。
    expect(() => JSON.parse(TRUNCATED_PREVIEW)).toThrow();
    const store = useWorkbenchStore();
    driveLoadedDelegate(store, TRUNCATED_PREVIEW, 'c1');
    const wrapper = mountPanel();
    const btn = wrapper.find('.delegate-open-viewer');
    expect(btn.exists()).toBe(true);
    // 摘要位与分级也得从同一个前缀里拿得到（action + 后 8 位短码；completed/end_turn ⇒ ✓ 绿）。
    expect(wrapper.get('.delegate-summary').text()).toBe(`dispatch · ${shortRunId('sub-6eda7fa1-03b2-4f36-b3f2-254662979dda')}`);
    expect(wrapper.get('.delegate-state').text()).toBe('✓');
    await btn.trigger('click');
    // 抽屉拿到的必须是**完整**的子 runId（不是截断串里的半截）。
    expect(wrapper.findComponent(DelegateChildDrawer).props()).toMatchObject({
      parentRunId: 'run-1',
      childRunId: 'sub-6eda7fa1-03b2-4f36-b3f2-254662979dda',
    });
  });

  it('结果串完全不是 JSON（`not json at all`）⇒ 不出按钮、不抛、退回既有展示', () => {
    expect(parseDelegateResult('not json at all')).toBeNull();
    const store = useWorkbenchStore();
    driveLoadedDelegate(store, 'not json at all', 'c1');
    const wrapper = mountPanel();
    expect(wrapper.find('.delegate-open-viewer').exists()).toBe(false);
    // 解不出 ⇒ delegate 专属的两段都不渲染（摘要/状态位回到既有通用展示）。
    expect(wrapper.find('.delegate-summary').exists()).toBe(false);
    expect(wrapper.find('.delegate-state').exists()).toBe(false);
  });
});
