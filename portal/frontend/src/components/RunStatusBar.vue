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
// 硬刷新边界：`run_end` / `usage` 不在历史回放白名单 ⇒ 刷新后运行态数字拿不回来，条上只剩「空闲」，
// 由 `title` 的 `runStatus.refreshBoundary` 说清这一点（不在条上塞一行常驻免责声明）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';
import { useRunMomentum } from '../composables/useRunMomentum';
import { formatByteSize, formatElapsed, type RunUsage } from '../lib/runMomentum';
import { formatDuration } from '../lib/toolSummary';

const { t } = useI18n();
const store = useWorkbenchStore();
const { view } = useRunMomentum(store.momentum);

const label = computed(() => (view.value.running ? t('runStatus.running') : t('runStatus.idle')));

/**
 * token 段（**只出真值**）：`run_end.usage` 没给就是 null ⇒ 返回空串 ⇒ 整段不出。
 * 变异哨兵：把这里的 `usage === null` 换成 `usage ?? {input_tokens: 0, output_tokens: 0}`，
 * 「run_end 不带 usage ⇒ 不出 token 数字」那条用例必须红。
 */
function usageText(usage: RunUsage | null): string {
  if (usage === null) return '';
  const hasInput = typeof usage.input_tokens === 'number';
  const hasOutput = typeof usage.output_tokens === 'number';
  if (hasInput && hasOutput) {
    return t('runStatus.tokens', { input: usage.input_tokens, output: usage.output_tokens });
  }
  if (hasInput) return t('runStatus.tokensInput', { input: usage.input_tokens });
  if (hasOutput) return t('runStatus.tokensOutput', { output: usage.output_tokens });
  return '';
}

/** 工具段（次数 + 有耗时的均值）：一个带时长的结果都没收到时只出次数。 */
function toolsText(count: number, avgMs: number | null): string {
  if (count <= 0) return '';
  const head = t('runStatus.tools', { count });
  return avgMs === null ? head : head + t('runStatus.toolsAvg', { dur: formatDuration(avgMs) });
}

/** 状态条正文分段（`·` 分隔）。顺序照工单示例：round · 输出量 · 速率 · 本 run 时长 · 工具。 */
const segments = computed<Array<{ text: string; title?: string }>>(() => {
  const v = view.value;
  const parts: Array<{ text: string; title?: string }> = [];
  // 一个字节都没收到 ⇒ 整段不出（`↑ 0 B` 是噪音，不是信息）。
  const size = v.outputBytes > 0 ? formatByteSize(v.outputBytes) : '';
  const elapsed = formatElapsed(v.elapsedMs);
  const tools = toolsText(v.toolCount, v.toolAvgMs);

  if (v.running) {
    if (v.round !== null) parts.push({ text: t('runStatus.round', { round: v.round }) });
    if (size !== '') parts.push({ text: t('runStatus.output', { size }) });
    // 估算速率：`~` 与 tooltip 都在（i18n `runStatus.rate` / `runStatus.rateHint`），不许裸数字。
    if (v.tokensPerSec !== null) {
      parts.push({ text: t('runStatus.rate', { rate: v.tokensPerSec }), title: t('runStatus.rateHint') });
    }
    if (elapsed !== '') parts.push({ text: t('runStatus.runElapsed', { dur: elapsed }) });
    if (tools !== '') parts.push({ text: tools });
  } else if (v.hasLastRun) {
    // 空闲态：上次 run 概况，能拿到什么显示什么（刷新后这里什么都没有 ⇒ 只剩「空闲」）。
    if (elapsed !== '') parts.push({ text: t('runStatus.lastRunElapsed', { dur: elapsed }) });
    if (size !== '') parts.push({ text: t('runStatus.output', { size }) });
    const tokens = usageText(v.usage);
    if (tokens !== '') parts.push({ text: tokens });
    if (tools !== '') parts.push({ text: tools });
  }
  return parts;
});

/** 冻结秒数（`上游已 Xs 无输出` 的 X）：向下取整，秒级粒度与 1s 时钟一致。 */
const frozenSeconds = computed(() =>
  view.value.frozen && view.value.frozenMs !== null ? Math.floor(view.value.frozenMs / 1000) : null,
);
</script>

<template>
  <div
    class="run-status-bar flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t px-3 py-1 text-xs"
    :class="view.frozen
      ? 'border-amber-300 bg-amber-50 text-amber-800'
      : 'border-black/10 bg-black/[0.02] text-black/60'"
    role="status"
    aria-live="off"
    :aria-label="t('runStatus.aria')"
    :title="t('runStatus.refreshBoundary')"
  >
    <!-- 心跳：运行中脉冲（复用既有 Tailwind animate-pulse，不新造动画）；空闲/冻结时静止 -->
    <span
      class="run-status-dot shrink-0"
      :class="view.running && !view.frozen ? 'animate-pulse text-brand' : 'text-black/30'"
      aria-hidden="true"
    >●</span>
    <span class="run-status-label shrink-0 font-medium">{{ label }}</span>
    <span v-for="(seg, i) in segments" :key="i" class="run-status-seg" :title="seg.title">· {{ seg.text }}</span>
    <span v-if="frozenSeconds !== null" class="run-status-frozen shrink-0 font-medium">
      · {{ t('runStatus.frozen', { sec: frozenSeconds }) }}
    </span>
  </div>
</template>
