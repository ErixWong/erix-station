<script setup lang="ts">
// issue #808：工作台顶栏「账周期 + 本周期用量」徽标 + 点开的明细弹窗（含 30 天 chart）。
// **组件自己不发请求**：数据全由 WorkbenchView 传入（composable `useMyUsage`），点徽标 emit('open')
// 让调用方去 `loadUsage()`。判断全在 `lib/usageLabel.ts`；金额全在 `lib/money.ts`；文案全走 i18n。
//
// 与收工灯同族：徽标一瞥就够，完整口径在 title/aria-label（#800 教训：窄标签黑话不进 hover，
// 英文读成 "mo used"——这里 title/aria-label 用完整词「本日/本月/this day/this month」）。
import { computed, onScopeDispose, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import ModalShell from './ModalShell.vue';
import MetricChart from './MetricChart.vue';
import { fmtUsdCompact } from '../lib/money';
import { usageCadenceOf, usageKindOf, usageOverage, usagePercentUsed } from '../lib/usageLabel';
import type { MyQuota, MyUsageDay } from '../composables/useMyUsage';

const props = defineProps<{
  quota: MyQuota | null;
  reason: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  days: MyUsageDay[];
  usageLoading: boolean;
  usageError: string | null;
}>();

const emit = defineEmits<{
  (e: 'refresh'): void; // 重拉额度（弹窗空态「重试」）
  (e: 'open'): void;    // 打开弹窗 ⇒ 调用方去 loadUsage()
  (e: 'refreshUsage'): void; // 弹窗打开期间每 60s 再拉一次用量（由本组件负责，见下方 watch 注释）
}>();

const { t } = useI18n();
const open = ref(false);

// 徽标状态机（判断委托 usageKindOf；空态/待载/无读数各占一态）。
// 优先级：no_binding（空态，整块不渲染）> 待载（!loaded && !error）> 之后一律按 quota 判。
// 注意「失败保留旧值」：刷新失败时 loaded 仍为 true，走 quota 判（显旧值，不闪成「没有」）；
// 首次就失败（loaded=false 且有 error）才落 'unknown' 显「—」。
const state = computed<'hidden' | 'pending' | 'unknown' | 'lifetime' | 'period'>(() => {
  if (props.quota == null && props.reason === 'no_binding') return 'hidden';
  if (!props.loaded && !props.error) return 'pending';
  const kind = usageKindOf(props.quota);
  if (kind === 'unknown') return 'unknown';
  return kind; // 'lifetime' | 'period'
});

const cadence = computed(() => usageCadenceOf(props.quota));
const spendText = computed(() => fmtUsdCompact(props.quota?.spend));
const budgetText = computed(() => fmtUsdCompact(props.quota?.max_budget));
const percent = computed(() => usagePercentUsed(props.quota?.spend, props.quota?.max_budget));
const overage = computed(() => usageOverage(props.quota?.spend, props.quota?.max_budget));
// 超额时剩余是负的 ⇒ 不显示（也不显示成负数）；只在不超额且 remaining>=0 时显。
const showRemaining = computed(
  () => overage.value == null && props.quota?.remaining != null && (props.quota?.remaining ?? 0) >= 0,
);

/** 下次清零时刻：本地时区 `MM-DD HH:mm`（脏值/空 ⇒ null，调用方不显示该行）。绝不写「已清零」。 */
function formatReset(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const resetText = computed(() => formatReset(props.quota?.budget_reset_at));

// 徽标窄标签（短，进得去顶栏；whitespace-nowrap 防换行）。
const badgeText = computed(() => {
  switch (state.value) {
    case 'pending':
      return t('workbench.usage.loading');
    case 'unknown':
      return '—';
    case 'lifetime':
      return `${t('workbench.usage.shortLifetime')} ${spendText.value}`;
    default: { // period
      const short = cadence.value === '1d'
        ? t('workbench.usage.shortDay')
        : cadence.value === '1mo'
          ? t('workbench.usage.shortMonth')
          : t('workbench.usage.shortUnknown');
      return `${short} ${spendText.value}/${budgetText.value}`;
    }
  }
});

// title / aria-label：一句完整话（周期、已用、额度、剩余、下次清零）——用**完整词**，不复用窄黑话。
const badgeTitle = computed(() => {
  if (state.value === 'pending') return t('workbench.usage.loading');
  if (state.value === 'unknown') {
    // 标题始终给「暂时拿不到读数」这句完整话；有具体错因时附在后面（不拿原始 Error 当标题）。
    return props.error
      ? `${t('workbench.usage.badgeUnknownTitle')}（${props.error}）`
      : t('workbench.usage.badgeUnknownTitle');
  }
  const parts: string[] = [];
  if (state.value === 'lifetime') {
    parts.push(t('workbench.usage.tipLifetime', { spend: spendText.value }));
    return parts.join(' · ');
  }
  const cad = cadence.value;
  parts.push(cad === '1d' || cad === '1mo'
    ? t('workbench.usage.tipUsed', {
      period: cad === '1d' ? t('workbench.usage.fullDay') : t('workbench.usage.fullMonth'),
      spend: spendText.value,
    })
    : t('workbench.usage.tipUsedUnknown', { spend: spendText.value }));
  if (props.quota?.max_budget != null) parts.push(t('workbench.usage.tipBudget', { budget: budgetText.value }));
  if (showRemaining.value) parts.push(t('workbench.usage.tipRemaining', { remaining: fmtUsdCompact(props.quota?.remaining) }));
  if (resetText.value) parts.push(t('workbench.usage.tipReset', { reset: resetText.value }));
  return parts.join(' · ');
});

// 30 天 chart 点：date 解析为 epoch，spend 非有限值丢掉（脏点不画）。空 ⇒ MetricChart 显空态。
const chartPoints = computed(() => props.days
  .map((d) => ({ x: Date.parse(d.date), y: d.spend }))
  .filter((p) => Number.isFinite(p.x) && p.y != null && Number.isFinite(p.y as number))
  .map((p) => ({ x: p.x, y: p.y as number })));

// 弹窗打开时的数据保鲜：
//   · open 变 true ⇒ emit('open')，调用方去 loadUsage()（首次拉）。
//   · 打开期间每 60s emit('refreshUsage')，调用方再拉一次用量。**由本组件负责**——它是唯一知道
//     `open` 状态的一方（WorkbenchView 只持有 composable，不知道弹窗开没开）。
let openTimer: ReturnType<typeof setInterval> | null = null;
watch(open, (v) => {
  if (v) {
    emit('open');
    openTimer = setInterval(() => emit('refreshUsage'), 60_000);
  } else if (openTimer) {
    clearInterval(openTimer);
    openTimer = null;
  }
});
onScopeDispose(() => {
  if (openTimer) clearInterval(openTimer);
});

// MetricChart 的 note：用量在途/失败时优先于空态文案（「该区间无数据」只在真的空数组时出现）。
const chartNote = computed(() => {
  if (props.usageError) return props.usageError;
  if (props.usageLoading && chartPoints.value.length === 0) return t('workbench.usage.loading');
  return null;
});
</script>

<template>
  <!-- no_binding 空态：整块不渲染（用户拍板：空就是空，不占位） -->
  <template v-if="state !== 'hidden'">
    <button
      type="button"
      data-test="usage-badge"
      class="rounded-md border px-2 py-0.5 text-sm whitespace-nowrap"
      :class="state === 'lifetime' || state === 'unknown' || state === 'pending' ? 'border-black/10 text-black/50 hover:bg-black/5' : 'border-black/20 hover:bg-black/5'"
      :title="badgeTitle"
      :aria-label="badgeTitle"
      @click="open = true"
    >{{ badgeText }}</button>

    <ModalShell
      v-if="open"
      :label="t('workbench.usage.title')"
      dialog-class="md:w-[30rem]"
      @close="open = false"
    >
      <div class="p-4 grid gap-3">
        <div class="flex items-center justify-between">
          <h2 class="text-lg font-medium">{{ t('workbench.usage.title') }}</h2>
          <button
            type="button"
            data-test="usage-close"
            class="text-sm text-black/50 hover:text-black"
            @click="open = false"
          >{{ t('workbench.usage.close') }}</button>
        </div>

        <!-- 无读数 / 网关不可达：整块空态 + 一句「暂时拿不到读数」 + 重试（绝不往消息流弹系统错误行） -->
        <div v-if="state === 'unknown'" data-test="usage-empty" class="grid gap-2 py-4 text-center">
          <p class="text-sm text-black/60">{{ t('workbench.usage.noReading') }}</p>
          <div>
            <button
              type="button"
              data-test="usage-retry"
              class="rounded-md border border-black/20 px-3 py-1 text-sm hover:bg-black/5"
              @click="emit('refresh')"
            >{{ t('workbench.usage.retry') }}</button>
          </div>
        </div>

        <!-- 有额度（周期） -->
        <div v-else-if="state === 'period'" class="grid gap-2">
          <p data-test="usage-used" class="text-sm">{{ t('workbench.usage.usedOf', { spend: spendText, budget: budgetText }) }}</p>
          <div v-if="percent != null" data-test="usage-progress" class="h-2 rounded bg-black/10 overflow-hidden">
            <div class="h-full bg-blue-600" :style="{ width: `${percent}%` }"></div>
          </div>
          <p v-if="overage != null" data-test="usage-overage" class="text-sm text-red-600">
            {{ t('workbench.usage.overage', { amount: fmtUsdCompact(overage) }) }}
          </p>
          <p v-else-if="showRemaining" data-test="usage-remaining" class="text-sm text-black/60">
            {{ t('workbench.usage.remaining', { remaining: fmtUsdCompact(props.quota?.remaining) }) }}
          </p>
          <p v-if="resetText" data-test="usage-reset" class="text-xs text-black/50">
            {{ t('workbench.usage.resetAt', { reset: resetText }) }}
          </p>
        </div>

        <!-- 未设额度（终身累计）：不出进度/剩余两段 -->
        <div v-else data-test="usage-lifetime" class="text-sm">
          {{ t('workbench.usage.noBudget', { spend: spendText }) }}
        </div>

        <!-- 30 天每日用量 chart：空数组 ⇒ MetricChart 显「该区间无数据」（不画贴底假线） -->
        <div class="grid gap-1">
          <p class="text-xs text-black/50">{{ t('workbench.usage.chartLabel') }}</p>
          <MetricChart
            :points="chartPoints"
            :empty-text="t('workbench.usage.noData')"
            :note="chartNote"
            :format-y="fmtUsdCompact"
            :label="t('workbench.usage.chartLabel')"
          />
        </div>
      </div>
    </ModalShell>
  </template>
</template>
