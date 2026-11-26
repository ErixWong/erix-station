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
import type { MyQuota, MyUsageDay, MyUsageTotals } from '../composables/useMyUsage';

const props = defineProps<{
  quota: MyQuota | null;
  reason: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  days: MyUsageDay[];
  totals: MyUsageTotals | null;
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

// 30 天 chart 点：**补齐成完整 30 天窗口再喂图**（issue #808 实测缺陷 1）。
//
// 为什么不直接喂 `days`：LiteLLM 的日聚合**只给有活动的那几天**行（常态：30 天里只有 1 行），
// 旧实现只喂那一行 ⇒ 图上只有一个点，弹窗里看起来就像「没数据」；补齐后每一天一个点，线总画得出来。
//
// **缺行 ⇒ 0 是诚实的**：日聚合里「没有这一天」= 那天没有请求 = 当天花费 0，不是「读数缺失」。
// 这与 `spend == null ⇒ 不猜 0` 是两回事：那是**行存在但字段空**（读数脏 ⇒ 丢掉该行的金额），
// 这里是**整天没有活动**。所以 30 天全 0 ⇒ 一条贴底 0 线就是「真的没花钱」的正确结论，
// **不**退化成空态；空态只留给「拿不到数据」（失败 / 首次还在读），那两种情形下面直接不喂点走 `note`。
const CHART_WINDOW_DAYS = 30;

/** 本地时区（部署环境 UTC+8）的 `YYYY-MM-DD`：与服务端日行的 `date` 用同一把钥匙对齐。 */
function localDayKey(y: number, m: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(m + 1)}-${p(d)}`;
}

/** 横轴端点标签：只要日期 `MM-DD`（日粒度下 `HH:mm` 永远是 `00:00`，零信息量）。 */
function formatDayAxis(x: number): string {
  const d = new Date(x);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const chartPoints = computed(() => {
  // 拿不到数据（失败 / 首次还在读）⇒ 不喂点：宁可走 note，也不画一条把「未知」说成 0 的贴底线。
  if (props.days.length === 0 && (props.usageError || props.usageLoading)) return [];
  const byDay = new Map<string, number>();
  for (const row of props.days ?? []) {
    const key = typeof row?.date === 'string' ? row.date.slice(0, 10) : '';
    if (!key) continue;
    const spend = typeof row.spend === 'number' && Number.isFinite(row.spend) ? row.spend : 0;
    byDay.set(key, (byDay.get(key) ?? 0) + spend);
  }
  const today = new Date();
  const out: { x: number; y: number }[] = [];
  for (let back = CHART_WINDOW_DAYS - 1; back >= 0; back--) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back); // 本地零点
    if (!Number.isFinite(day.getTime())) continue;
    out.push({ x: day.getTime(), y: byDay.get(localDayKey(day.getFullYear(), day.getMonth(), day.getDate())) ?? 0 });
  }
  return out;
});

// 近 30 天合计（响应里的 `totals.spend`）：拿不到 / 脏 ⇒ null ⇒ 那一行不渲染（不出 $0.00 假数）。
const totalsSpend = computed(() => {
  const value = props.totals?.spend;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
});

// 30 天窗口里的「单日最高」：取 `chartPoints` 里 y 的最大值；最大值 ≤ 0 ⇒ null（不出「最高 $0.00」假数）。
// 同值多天取**最近的一天**（从旧到新遍历，`>=` 让更靠右的相等值覆盖 ⇒ 留下最近那天）。
const chartPeak = computed<{ amount: number; day: string } | null>(() => {
  let best: { x: number; y: number } | null = null;
  for (const point of chartPoints.value) {
    if (!best || point.y >= best.y) best = point;
  }
  if (!best || !(best.y > 0)) return null;
  return { amount: best.y, day: formatDayAxis(best.x) };
});

// 紧贴 chart 上方的一句摘要（同一行、`·` 分隔）：替代原先那行会被读反的 y 轴左右标签。
//   · 合计段：`totals.spend` 拿不到 ⇒ 整段不出（**不拿 $0.00 冒充**）。
//   · 单日最高段：仅当最大值 > 0 才出，带那天（`MM-DD`）。
//   · 全 0（合计恰为 0 且最大为 0）⇒ 只说「近 30 天无花费」，不写「最高 $0.00」。
// 绝不用「峰值/平均」这类黑话：只有日聚合，平均无意义。
const chartSummary = computed(() => {
  const total = totalsSpend.value;
  const peak = chartPeak.value;
  if (total === 0 && peak === null) return t('workbench.usage.chartSummaryNoSpend');
  const parts: string[] = [];
  if (total != null) parts.push(t('workbench.usage.chartSummaryTotal', { spend: fmtUsdCompact(total) }));
  if (peak) parts.push(t('workbench.usage.chartSummaryMax', { amount: fmtUsdCompact(peak.amount), day: peak.day }));
  return parts.join(' · ');
});

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

// MetricChart 的 note：一个点都没有时顶上来（「该区间无数据」不再由数据形状触发：窗口永远被补满，
// 有读数就有真线，缺行是 0 而不是「无数据」）。
const chartNote = computed(() => {
  if (chartPoints.value.length > 0) return null;
  if (props.usageError) return props.usageError;
  if (props.usageLoading) return t('workbench.usage.loading');
  return null;
});
</script>

<template>
  <!-- no_binding 空态：整块不渲染（用户拍板：空就是空，不占位） -->
  <template v-if="state !== 'hidden'">
    <!-- 窄屏（≤767px，Tailwind max-md:）隐藏徽标：实测顶栏在 900px 起就在换行，徽标再顶出一行
         （760px 高 83→143）；顶栏本就拥挤，额度也不是手机首要信息——要看用宽屏。勿删此行（钉在 spec）。 -->
    <button
      type="button"
      data-test="usage-badge"
      class="rounded-md border px-2 py-0.5 text-sm whitespace-nowrap max-md:hidden"
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
            <!-- 与 MetricChart 的蓝色族同色（折线 rgb(37 99 235)）：别改成 `bg-brand`（品牌绿），
                 绿进度条 + 蓝折线是两个色族拼在一起（#808 实测回滚）。轨道保持 bg-black/10。 -->
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
        <div v-else-if="state === 'lifetime'" data-test="usage-lifetime" class="text-sm">
          {{ t('workbench.usage.noBudget', { spend: spendText }) }}
        </div>

        <!-- 待载（pending）：徽标还是 … 时点开，只说「正在读取…」，绝不出现金额或未设额度文案 -->
        <div v-else data-test="usage-pending" class="py-4 text-center text-sm text-black/60">
          {{ t('workbench.usage.reading') }}
        </div>

        <!-- 30 天每日用量 chart：点已由本组件补成完整 30 天窗口（缺行 = 0）；
             空态文案只留给「拿不到数据」（走 note）；横轴只要日期（`format-x`）。
             y 轴上下界被左右排在同一行会被读反（#808 真机实测），故 `hide-axis-values` 隐数值，
             改由紧贴 chart 上方的一句「合计 + 单日最高（日期）」承担金额信息。 -->
        <div class="grid gap-1">
          <p class="text-xs text-black/50">{{ t('workbench.usage.chartLabel') }}</p>
          <p v-if="chartSummary" data-test="usage-totals" class="text-sm text-black/60">{{ chartSummary }}</p>
          <MetricChart
            :points="chartPoints"
            :empty-text="t('workbench.usage.noData')"
            :note="chartNote"
            :format-y="fmtUsdCompact"
            :format-x="formatDayAxis"
            hide-axis-values
            :label="t('workbench.usage.chartLabel')"
          />
        </div>
      </div>
    </ModalShell>
  </template>
</template>
