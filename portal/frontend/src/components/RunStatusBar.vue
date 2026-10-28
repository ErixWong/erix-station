<script setup lang="ts">
// 输入框上方常驻状态条（issue #282 B 块，落点后续调整：原来在窗口顶部，容易被忽略，现紧贴 composer 上沿）。
//
// 为什么是「一条常驻状态条」而不是每条消息内嵌动量数字：消息级只负责**时刻**（StreamPanel 的
// `<time>`），动量是 run 级概念；塞进每条消息会让每次增量重渲染都带着它一起抖（工单「落点」明确）。
//
// 数据全部来自 store 持有的 `momentum` 状态机（`composables/useRunMomentum.ts`，由 SSE 逐帧喂），
// 本组件**只渲染**：所有「拿不到」在派生视图里就是 null，这里一律整段不出——不显示 0、不显示
// `NaN`/`undefined`/`0.0 KB`。
//
// 硬刷新边界：`run_end` 不在历史回放白名单 ⇒ 运行中的速率/时长拿不回来；#425 开的那唯一的口子
// 是历史 `round_end` 的累计用量（见 `useRunMomentum.ts` 的 `historyUsageOnly`），所以刷新后
// 「上次 run 用了多少 token / 窗口多大」还在。整条 tooltip 说清剩余边界。
//
// issue #425（用户体验）：本条从「只有出事才说话」改成「**一直在说话**」：
//   * 运行中始终有一段**相位**（等待 LLM 中 12s / 工具 shell 执行中 8s / 正在生成），
//     让「界面安静」不再等于「可能挂了」——非专业用户判不了这两件事，也不该由界面误导他们；
//   * 颜色只在真到了 `RUN_STALL_THRESHOLD_MS` 才变黄（旧的 5s 标黄把「大上下文 prefill」报成故障）；
//   * token 从「只有终态才有一个数」变成运行中就显示：本轮用量 / 累计用量 / 上下文占用百分比，
//     全部是上游真值（`usage` / `round_end` 事件），只有 tok/s 是前端估算并带 `~`。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';
import { useRunMomentum } from '../composables/useRunMomentum';
import {
  formatByteSize,
  formatElapsed,
  formatTokenCount,
  RUN_FROZEN_THRESHOLD_MS,
  type RunUsage,
} from '../lib/runMomentum';
import { formatDuration } from '../lib/toolSummary';

const { t } = useI18n();
const store = useWorkbenchStore();
const { view } = useRunMomentum(store.momentum);

const label = computed(() => (view.value.running ? t('runStatus.running') : t('runStatus.idle')));

/** 有限数才认（`NaN`/字符串/`undefined` 一律当「没有」，不显示成 0）。 */
function num(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 紧凑 token 数（`116.2k`）；脏值 ⇒ null ⇒ 整段不出。 */
function tok(value: number | undefined): string | null {
  const text = formatTokenCount(value);
  return text === '' ? null : text;
}

/**
 * token 段（**只出真值**）：`usage` 对象为 null 就是空串 ⇒ 整段不出。
 * 变异哨兵：把这里的 `usage === null` 换成 `usage ?? {input_tokens: 0, output_tokens: 0}`，
 * 「没有 usage ⇒ 不出 token 数字」那条用例必须红。
 *
 * `compact`：状态条位置很窄，运行中那两个数（本轮 / 累计）走紧凑写法（`116.2k`）；
 * 终态「上次 run」那一档保留全位数（#282 原有口径，也是计费时真正要看的数）。
 * 两者只是**写法**不同，数值都是上游真值；没有任何一边做估算。
 */
function usageText(usage: RunUsage | null, compact = false): string {
  if (usage === null) return '';
  const fmt = (value: number | undefined) => (compact ? tok(value) : String(value ?? ''));
  const hasInput = typeof usage.input_tokens === 'number';
  const hasOutput = typeof usage.output_tokens === 'number';
  if (hasInput && hasOutput) {
    return t('runStatus.tokens', { input: fmt(usage.input_tokens), output: fmt(usage.output_tokens) });
  }
  if (hasInput) return t('runStatus.tokensInput', { input: fmt(usage.input_tokens) });
  if (hasOutput) return t('runStatus.tokensOutput', { output: fmt(usage.output_tokens) });
  return '';
}

/** 工具段（次数 + 有耗时的均值）：一个带时长的结果都没收到时只出次数。 */
function toolsText(count: number, avgMs: number | null): string {
  if (count <= 0) return '';
  const head = t('runStatus.tools', { count });
  return avgMs === null ? head : head + t('runStatus.toolsAvg', { dur: formatDuration(avgMs) });
}

/** 秒数（相位计时用；向下取整，粒度与 1s 时钟一致）。 */
function wholeSeconds(ms: number | null): number | null {
  return ms === null ? null : Math.floor(ms / 1000);
}

/**
 * 相位段（#425 的核心）：运行中**一直在**——`round_start` ⇒ 等待 LLM；`assistant_delta` ⇒ 正在生成；
 * `tool_use` ⇒ 工具执行中（带工具名，工具名不是中文文案所以不 i18n：它是上游给的数据）。
 * 相位未知（旧后端 / 首帧前）退回旧的静默时长文案，并且仍只在阈值后出现（不改变既有可见性）。
 */
const phaseSegment = computed<{ text: string; title?: string } | null>(() => {
  const v = view.value;
  if (!v.running) return null;
  const sec = wholeSeconds(v.phaseMs ?? v.frozenMs);
  if (sec === null) return null;
  // 相位已知 ⇒ 立刻可见（0s 起就写「等待 LLM 中」，这正是 #425 要的「一直在说话」）。
  if (v.phase === 'awaiting_llm') {
    return { text: t('runStatus.phaseAwaiting', { sec }), title: t('runStatus.phaseAwaitingHint') };
  }
  if (v.phase === 'tool_running') {
    const tool = v.activeToolName;
    return {
      text: tool ? t('runStatus.phaseTool', { tool, sec }) : t('runStatus.phaseToolNoName', { sec }),
      title: t('runStatus.phaseToolHint'),
    };
  }
  if (v.phase === 'streaming') return { text: t('runStatus.phaseStreaming') };
  // 相位未知：保持旧行为——静默超过阈值才出一句，措辞也不再是「上游无输出」。
  const silent = wholeSeconds(v.frozenMs);
  if (silent === null || (v.frozenMs ?? 0) <= RUN_FROZEN_THRESHOLD_MS) return null;
  return { text: t('runStatus.phaseSilent', { sec: silent }) };
});

/** 本轮 token 段（`usage` 事件真值：本轮发给模型多少、模型回了多少）。 */
const roundUsageSegment = computed<{ text: string; title?: string } | null>(() => {
  const usage = view.value.roundUsage;
  if (usage === null) return null;
  const input = tok(usage.input_tokens);
  const output = tok(usage.output_tokens);
  if (input === null && output === null) return null;
  if (input !== null && output !== null) {
    return { text: t('runStatus.roundTokens', { input, output }), title: t('runStatus.roundTokensHint') };
  }
  if (input !== null) return { text: t('runStatus.roundTokensInput', { input }), title: t('runStatus.roundTokensHint') };
  return { text: t('runStatus.roundTokensOutput', { output: output as string }), title: t('runStatus.roundTokensHint') };
});

/** 上下文占用段：分子 = 本轮输入 token（上游真值），分母 = 模型窗口（runner 下行）。缺一边就整段不出。 */
const contextSegment = computed<{ text: string; title?: string } | null>(() => {
  const v = view.value;
  const pct = v.contextPct;
  const used = num(v.roundUsage?.input_tokens);
  const window = v.contextWindow;
  if (pct === null || used === null || window === null) return null;
  return {
    text: t('runStatus.context', { pct, used: formatTokenCount(used), window: formatTokenCount(window) }),
    title: t('runStatus.contextHint', { used, window }),
  };
});

/** 累计用量段（`round_end.usage` 的本 run 累计真值；运行中就有，不必等终态）。写法走紧凑。 */
const runUsageSegment = computed<string>(() => usageText(view.value.runUsage ?? null, true));

/**
 * 空闲段的 token：`run_end.usage` 优先（终态真值），没给则退回 `round_end` 的累计值
 * （同一个口径的两个写入点，不是两套算法）。两个都没有 ⇒ 空串 ⇒ 整段不出。
 */
const idleUsage = computed<RunUsage | null>(() => view.value.usage ?? view.value.runUsage ?? null);

/** 状态条正文分段（`·` 分隔）。顺序：round · 相位 · 上下文 · 本轮 tokens · 累计 tokens · 输出量 · 速率 · 时长 · 工具。 */
const segments = computed<Array<{ text: string; title?: string }>>(() => {
  const v = view.value;
  const parts: Array<{ text: string; title?: string }> = [];
  // 一个字节都没收到 ⇒ 整段不出（`↑ 0 B` 是噪音，不是信息）。
  const size = v.outputBytes > 0 ? formatByteSize(v.outputBytes) : '';
  const elapsed = formatElapsed(v.elapsedMs);
  const tools = toolsText(v.toolCount, v.toolAvgMs);

  if (v.running) {
    if (v.round !== null) parts.push({ text: t('runStatus.round', { round: v.round }) });
    const phase = phaseSegment.value;
    if (phase !== null) parts.push(phase);
    const context = contextSegment.value;
    if (context !== null) parts.push(context);
    const roundUsage = roundUsageSegment.value;
    if (roundUsage !== null) parts.push(roundUsage);
    const runUsage = runUsageSegment.value;
    if (runUsage !== '') parts.push({ text: t('runStatus.runTokens', { tokens: runUsage }) });
    if (size !== '') parts.push({ text: t('runStatus.output', { size }) });
    // 估算速率：`~` 与 tooltip 都在（i18n `runStatus.rate` / `runStatus.rateHint`），不许裸数字。
    if (v.tokensPerSec !== null) {
      parts.push({ text: t('runStatus.rate', { rate: v.tokensPerSec }), title: t('runStatus.rateHint') });
    }
    if (elapsed !== '') parts.push({ text: t('runStatus.runElapsed', { dur: elapsed }) });
    if (tools !== '') parts.push({ text: tools });
  } else if (v.hasLastRun) {
    // 空闲态：上次 run 概况，能拿到什么显示什么。#425 之后「tokens」这一段即使硬刷新也还在
    // （来源 = 历史 `round_end` 的累计真值）；真的没数据（旧 run / 没配元数据）时仍然一段都不出。
    if (elapsed !== '') parts.push({ text: t('runStatus.lastRunElapsed', { dur: elapsed }) });
    if (size !== '') parts.push({ text: t('runStatus.output', { size }) });
    const tokens = usageText(idleUsage.value);
    if (tokens !== '') parts.push({ text: tokens });
    if (tools !== '') parts.push({ text: tools });
  }
  return parts;
});
</script>

<template>
  <div
    class="run-status-bar flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t px-3 py-1 text-xs"
    :class="view.stalled
      ? 'border-amber-300 bg-amber-50 text-amber-800'
      : 'border-black/10 bg-black/[0.02] text-black/60'"
    role="status"
    :aria-live="view.running ? 'polite' : 'off'"
    :aria-label="t('runStatus.aria')"
    :title="t('runStatus.refreshBoundary')"
  >
    <!-- 心跳：运行中脉冲（复用既有 Tailwind animate-pulse，不新造动画）。#425：只要还在收流/还在等
         工具就继续脉冲——它表达的是「进程活着」，不再是「5 秒内有输出」；只有整体 stall 才停。 -->
    <span
      class="run-status-dot shrink-0"
      :class="view.running && !view.stalled ? 'animate-pulse text-brand' : 'text-black/30'"
      aria-hidden="true"
    >●</span>
    <span class="run-status-label shrink-0 font-medium">{{ label }}</span>
    <span v-for="(seg, i) in segments" :key="i" class="run-status-seg" :class="seg === segments[1] ? 'run-status-phase' : ''" :title="seg.title">· {{ seg.text }}</span>
    <span v-if="view.stalled && phaseSegment === null" class="run-status-frozen shrink-0 font-medium">
      · {{ t('runStatus.frozen', { sec: wholeSeconds(view.frozenMs) ?? 0 }) }}
    </span>
  </div>
</template>
