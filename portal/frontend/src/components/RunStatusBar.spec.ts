// 会话页动量状态条单测（issue #282 B）。
// 覆盖验收：② 运行态计时递增（mock 定时器）、③ 速率估算与 `~` 标注、④ 冻结标黄（跨过阈值那一刻）、
// ⑤ `run_end` 带 usage 显示真值 / 不带时**不显示 token 数字**、⑥ 卸载清定时器。
// 另加双语（zh-CN / en 都不许把中文写死在模板里）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import RunStatusBar from './RunStatusBar.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';
import { RUN_FROZEN_THRESHOLD_MS } from '../lib/runMomentum';

const CJK = /[\u4e00-\u9fff]/;
const T0 = new Date('2026-10-23T12:00:00.000Z').getTime();

function mountBar() {
  return mount(RunStatusBar, { global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('运行态状态条（● running · round · ↑ 输出量 · ~速率 · 本 run 时长 · 工具）', () => {
  it('运行中：各段齐全、心跳脉冲在、速率带 `~` 且 tooltip 说明是估算', async () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 12 });
    store.momentum.ingest('assistant_delta', { run_id: 'r1', text: 'a'.repeat(80) });
    const wrapper = mountBar();

    vi.advanceTimersByTime(2000); // 第二个样本落在 +2s（速率需要跨度 ≥1s）
    store.momentum.ingest('assistant_delta', { run_id: 'r1', text: 'a'.repeat(80) });
    store.momentum.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' });
    store.momentum.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c1', duration_ms: 12_000 });
    await nextTick();

    expect(wrapper.get('.run-status-label').text()).toBe('运行中');
    const text = wrapper.get('.run-status-bar').text();
    expect(text).toContain('round 12');
    expect(text).toContain('↑ 160 B');
    expect(text).toContain('~10 tok/s'); // 80 字符/4 ÷ 2s
    expect(text).toContain('本 run 00:02');
    expect(text).toContain('工具 1 次');
    expect(text).toContain('（均 12.0s）');
    // 心跳：运行中脉冲（复用既有 animate-pulse）
    expect(wrapper.get('.run-status-dot').classes()).toContain('animate-pulse');
    // 估算标注：`~` 在文案里，且该段带 tooltip
    const rateSeg = wrapper.findAll('.run-status-seg').find((seg) => seg.text().includes('tok/s'));
    expect(rateSeg).toBeDefined();
    expect(rateSeg!.text()).toContain('~');
    expect(rateSeg!.attributes('title')).toBe('速率是前端按字符数近似的估算值（非上游真值）');
    // 整条的 tooltip = 硬刷新边界说明
    expect(wrapper.get('.run-status-bar').attributes('title')).toContain('硬刷新后只保留消息时间戳');
  });

  it('运行态计时随 1s 时钟递增（mock 定时器），跨分钟走 03:42 格式', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    const wrapper = mountBar();
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.text()).toContain('本 run 00:01');
    vi.advanceTimersByTime(221_000); // 累计 222s
    await nextTick();
    expect(wrapper.text()).toContain('本 run 03:42');
  });

  it('冻结：恰好 5s 不标黄，跨过阈值那一刻标黄并出「上游已 Xs 无输出」', async () => {
    // 阈值钉死（防呆）：这条用例按秒推进时钟，若阈值被改成 0 / Infinity，先在这里**快速具名红**，
    // 而不是让 `advanceTimersByTime(Infinity)` 把整个套件挂死。常量本身的边界由 lib/runMomentum.spec 钉。
    expect(RUN_FROZEN_THRESHOLD_MS).toBe(5000);
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 3 }); // lastEventAt = T0
    const wrapper = mountBar();

    vi.advanceTimersByTime(RUN_FROZEN_THRESHOLD_MS);
    await nextTick();
    expect(wrapper.find('.run-status-frozen').exists()).toBe(false);
    expect(wrapper.get('.run-status-bar').classes()).not.toContain('bg-amber-50');
    expect(wrapper.get('.run-status-dot').classes()).toContain('animate-pulse');

    vi.advanceTimersByTime(1000); // 下一个 tick：距最后事件 6s > 5s
    await nextTick();
    expect(wrapper.get('.run-status-frozen').text()).toContain('上游已 6s 无输出');
    expect(wrapper.get('.run-status-bar').classes()).toContain('bg-amber-50');
    // 冻结时心跳停下（不再暗示「还活着」）
    expect(wrapper.get('.run-status-dot').classes()).not.toContain('animate-pulse');
  });

  it('终态带 usage：显示真值 tokens（↑输入 ↓输出），时长定格', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' });
    store.momentum.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c1', duration_ms: 12_000 });
    vi.advanceTimersByTime(222_000);
    store.momentum.ingest('run_end', {
      run_id: 'r1',
      termination: { reason: 'end_turn' },
      usage: { input_tokens: 15_230, output_tokens: 2_104 },
    });
    const wrapper = mountBar();
    vi.advanceTimersByTime(5000); // 终态后时钟继续走，但时长必须定格
    await nextTick();

    expect(wrapper.get('.run-status-label').text()).toBe('空闲');
    const text = wrapper.get('.run-status-bar').text();
    expect(text).toContain('上次 run 03:42');
    expect(text).toContain('tokens ↑15230 ↓2104');
    expect(text).toContain('工具 1 次');
    expect(text).not.toContain('~'); // 终态不出速率
    expect(wrapper.find('.run-status-frozen').exists()).toBe(false);
  });

  it('终态不带 usage：**不显示 token 数字**（这条是「伪装成 0」的哨兵）', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    vi.advanceTimersByTime(3000);
    store.momentum.ingest('run_end', { run_id: 'r1', termination: { reason: 'aborted' }, usage: null });
    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.get('.run-status-bar').text();
    expect(text).toContain('上次 run 00:03');
    expect(text).not.toMatch(/tokens/);
    expect(text).not.toMatch(/↑\s*0|↓\s*0|0 tokens/);
  });

  it('空闲且没有上次 run 观测（硬刷新后）：只剩「空闲」，不编数字', async () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1'; // 会话开着，但本页从未见过 run
    const wrapper = mountBar();
    expect(wrapper.get('.run-status-label').text()).toBe('空闲');
    expect(wrapper.findAll('.run-status-seg')).toHaveLength(0);
    expect(wrapper.text()).not.toMatch(/NaN|undefined|tokens|tok\/s/);
  });

  it('起跑时刻未知（页面中途打开）：不出时长，不假装 0:00', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', null);
    store.momentum.ingest('round_start', { run_id: 'r1', round: 5 });
    const wrapper = mountBar();
    vi.advanceTimersByTime(10_000);
    await nextTick();
    const text = wrapper.get('.run-status-bar').text();
    expect(text).toContain('round 5');
    expect(text).not.toMatch(/本 run/);
    expect(text).not.toMatch(/NaN/);
  });

  it('卸载清定时器：mount 后有 interval，unmount 后一个都不剩', () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    const wrapper = mountBar();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    wrapper.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('English：整条切英文（无中文残留），估算 tooltip 也是英文', async () => {
    setLocale('en');
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 7 });
    store.momentum.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1' });
    store.momentum.ingest('tool_result', { run_id: 'r1', tool_call_id: 'c1', duration_ms: 12_000 });
    const wrapper = mountBar();
    vi.advanceTimersByTime(65_000);
    await nextTick();

    expect(wrapper.get('.run-status-label').text()).toBe('running');
    const text = wrapper.get('.run-status-bar').text();
    expect(text).toContain('this run 01:05');
    expect(text).toContain('1 tool calls');
    expect(text).not.toMatch(CJK);
    const rateSeg = wrapper.findAll('.run-status-seg').find((seg) => seg.text().includes('tok/s'));
    if (rateSeg) expect(rateSeg.attributes('title')).not.toMatch(CJK);
    setLocale('zh-CN');
  });
});
