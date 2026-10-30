// 会话页动量状态条单测（issue #282 B 块 + #425 改版）。
// #282 验收：② 运行态计时递增（mock 定时器）、③ 速率估算与 `~` 标注、⑤ `run_end` 带 usage 显示真值 /
// 不带时**不显示 token 数字**、⑥ 卸载清定时器。
// #425 验收：运行中**常驻相位段**（等 LLM / 工具中 / 生成中）；标黄阈值从 5s 抬到 `RUN_STALL_THRESHOLD_MS`
// （旧口径几乎常亮，把「大上下文 prefill」报成故障）；本轮 token / 累计 token / 上下文占用运行中就显示。
// 另加双语（zh-CN / en 都不许把中文写死在模板里）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import RunStatusBar from './RunStatusBar.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';
import { RUN_FROZEN_THRESHOLD_MS, RUN_STALL_THRESHOLD_MS } from '../lib/runMomentum';

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
    // #425：运行中必须**一直有相位段**（最后一个事件是 tool_result ⇒ 回到「等模型回话」）。
    expect(text).toContain('等待模型回复中');
    // 整条的 tooltip = 硬刷新边界说明（#425 后边界缩小：token 与窗口不再丢）
    expect(wrapper.get('.run-status-bar').attributes('title')).toContain('不在历史回放白名单');
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

  // #425 重写原来那条「>5s 就标黄 + 上游已 Xs 无输出」的用例：
  //   * `RUN_FROZEN_THRESHOLD_MS`（5s）现在是「该提一句」的阈值（相位秒数上屏），**不再驱动颜色**；
  //   * 颜色改由 `RUN_STALL_THRESHOLD_MS`（60s）驱动——旧口径在真机 run 里几乎常亮（大上下文 prefill /
  //     长构建都是几十秒），把正常等待报成故障，对非专业用户是误导。
  it('#425 相位计时：跨 5s 就报秒但不标黄；到 stall 阈值才标黄、心跳才停', async () => {
    // 阈值钉死（防呆）：若两个常量被改成 0 / Infinity，先在这里快速具名红。
    expect(RUN_FROZEN_THRESHOLD_MS).toBe(5000);
    expect(RUN_STALL_THRESHOLD_MS).toBe(60_000);
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 3 }); // 相位起点 = T0
    const wrapper = mountBar();

    vi.advanceTimersByTime(RUN_FROZEN_THRESHOLD_MS);
    await nextTick();
    // #425：相位段**常驻**（不再是「超过 5s 才冒出来」）——界面安静时也要说清自己在等什么。
    expect(wrapper.text()).toContain('等待模型回复中 5s');

    vi.advanceTimersByTime(1000); // 6s：报秒，但**不黄**
    await nextTick();
    expect(wrapper.text()).toContain('等待模型回复中 6s');
    expect(wrapper.get('.run-status-bar').classes()).not.toContain('bg-amber-50');
    expect(wrapper.get('.run-status-dot').classes()).toContain('animate-pulse');

    vi.advanceTimersByTime(RUN_STALL_THRESHOLD_MS); // 真到了不对劲的量 ⇒ 黄 + 心跳停
    await nextTick();
    expect(wrapper.get('.run-status-bar').classes()).toContain('bg-amber-50');
    expect(wrapper.get('.run-status-dot').classes()).not.toContain('animate-pulse');
    expect(wrapper.text()).toContain('等待模型回复中'); // #425：不再说「上游无输出」，而是说在等什么
  });

  it('#425 工具执行中：相位段带工具名，不再让用户面对「安静 = 挂了」', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 4 });
    store.momentum.ingest('tool_use', { run_id: 'r1', tool_call_id: 'c1', name: 'shell' });
    const wrapper = mountBar();
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(wrapper.text()).toContain('正在执行工具 shell');
    expect(wrapper.text()).toContain('8s');
    expect(wrapper.get('.run-status-bar').classes()).not.toContain('bg-amber-50');
  });

  it('#425 本轮 token / 累计 token / 上下文占用：运行中就显示（全是上游真值，不带 ~）', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('round_start', { run_id: 'r1', round: 5 });
    store.momentum.ingest('usage', {
      run_id: 'r1',
      round: 5,
      usage: { input_tokens: 116_204, output_tokens: 512 },
      context_window: 262_144,
    });
    store.momentum.ingest('round_end', {
      run_id: 'r1',
      round: 5,
      usage: { input_tokens: 1_383_397, output_tokens: 38_082 },
    });
    const wrapper = mountBar();
    await nextTick();

    const text = wrapper.get('.run-status-bar').text();
    expect(text).toMatch(/本轮 tokens ↑116\.2k ↓512/);
    expect(text).toMatch(/累计 tokens ↑1\.4M ↓38\.1k/);
    expect(text).toContain('上下文 44%'); // 116204 / 262144
    // 真值段不许带估算记号（只有 tok/s 带 `~`）
    const segs = wrapper.findAll('.run-status-seg');
    const tokenSeg = segs.find((seg) => seg.text().includes('本轮 tokens'));
    expect(tokenSeg?.text()).not.toContain('~');
    // 上下文段的 tooltip 把分子/分母说清（百分比本身不是魔法数字）
    expect(tokenSeg?.attributes('title')).toContain('不是花费');
  });

  it('#425 没有 context_window（模型未配元数据）：上下文段整段不出，不拿 0% 冒充', async () => {
    const store = useWorkbenchStore();
    store.momentum.beginRun('r1', Date.now());
    store.momentum.ingest('usage', { run_id: 'r1', round: 1, usage: { input_tokens: 1000 } });
    const wrapper = mountBar();
    await nextTick();
    expect(wrapper.text()).not.toContain('上下文');
    expect(wrapper.text()).not.toMatch(/0%|NaN%/);
  });

  it('#425 硬刷新后：历史 round_end 的累计 token 仍显示（不谎报在跑，也不假装有时刻）', async () => {
    const store = useWorkbenchStore();
    store.sessionId = 's1';
    store.momentum.ingest('round_end', {
      run_id: 'r-old',
      round: 3,
      usage: { input_tokens: 4_096, output_tokens: 128 },
      context_window: 262_144,
    }, true);
    const wrapper = mountBar();
    await nextTick();

    expect(wrapper.get('.run-status-label').text()).toBe('空闲'); // 历史帧不得说成「运行中」
    const text = wrapper.get('.run-status-bar').text();
    expect(text).toMatch(/↑4096 ↓128/); // 空闲那一档保留全位数（计费要看的数）
    expect(text).not.toContain('上次 run'); // 起跑时刻未知 ⇒ 不假装有时刻
    expect(text).not.toMatch(/NaN|undefined/);
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
