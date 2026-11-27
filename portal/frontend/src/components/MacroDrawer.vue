<script setup lang="ts">
// 宏流水抽屉（issue #528，`07` §11 / §12 / §13 / §15 / §17，`09` §3）。
//
// 形态**照抄** `DelegateChildDrawer.vue:217-225`：**`fixed inset-0` 全屏遮罩 + `right-0` 覆盖面板**，
// 不是「消息流变窄 + 右栏并排」（§11 把「并排」判成初稿 blocker：承诺只能有一个）。
// 宽度按 §21.2：≥1024px 取 520px（480–520 区间），768–1023px `w-full max-w-md`，
// <768px 全屏 + 返回箭头；**任何宽度都不并排**。
//
// 五类判据在这里落地（`07` §21.5，不做快照测试）：
//   ① 空态四选一 → `macro.panelStateValue` 驱动，各态各自的 `data-test` 节点
//   ② 跳过聚合 → `aggregateSkippedRuns`（连续同因一条汇总行，不同因不合并）
//   ③ 判决映射 → `verdictMessageKey`（五个 verdict 各自渲染成 §6.1 的词）
//   ④ 成本缺失 → `formatTokens(run.usage)` 为 null 就整段不渲染（不写 `↑0 ↓0`）
//   ⑤ 健康告警位置 → 水位线陈旧时渲染在**顶部状态条**（`data-test="macro-health"`），空态区不重复
import { computed, onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import MacroMenu from './MacroMenu.vue';
import { useMacroStore } from '../stores/macro';
// 健康告警文案要说「预期每 60 秒一次」（`07` §17.3 要求给「最后时刻 + 预期频率 + 下一步」）
// ⇒ 频率从 shared 真源拿，不在文案里写死数字。
import { EVAL_INTERVAL_MS, STALE_INTERVAL_MULTIPLE } from '@shared/macro-kinds';
import {
  aggregateSkippedRuns,
  emptyStateMessageKey,
  formatClock,
  formatCostEstimate,
  formatDuration,
  formatTokens,
  kindSuffixOf,
  minutesAgo,
  runReasonMessageKey,
  skipIsBudgetRisk,
  skipMessageKey,
  statusMessageKey,
  summarizeUsage,
  verdictMessageKey,
  verdictTone,
} from '../lib/macroView';

const props = withDefaults(defineProps<{
  /** `null` ⇒ 用户级全局面（issue #614：顶栏 chip，流水走 `/api/macro-runs`，卡片显示用户级模板）。 */
  sessionId: string | null;
  /** 单价（每 token）。未确认 ⇒ 只给 token 不给钱（`07` §15 第 1 条）。 */
  price?: { inputPerToken?: number | null; outputPerToken?: number | null } | null;
}>(), { price: null });

const emit = defineEmits<{ (e: 'close'): void }>();

const { t, te } = useI18n();
const macro = useMacroStore();

/** 判据①：面板该显示哪一态（技术态优先于业务态）。 */
const state = computed(() => macro.panelStateValue);
const emptyKey = computed(() => emptyStateMessageKey(state.value));

/** 判据②：连续同因跳过合成一条。 */
const feed = computed(() => aggregateSkippedRuns(macro.visibleRuns));

/** 判据⑤：水位线（时刻用 store 的注入时钟，测试可给固定值）。 */
const health = computed(() => macro.watermark(macro.now()));
const healthMinutes = computed(() => minutesAgo(health.value.last, macro.now()));
/** 预期频率（秒）：新鲜阈值 = 3 × 60s，文案里两个数字都给（§17.3）。 */
const expectedEverySeconds = computed(() => Math.round(EVAL_INTERVAL_MS / 1000));
const staleAfterSeconds = computed(() => Math.round(STALE_INTERVAL_MULTIPLE * EVAL_INTERVAL_MS / 1000));

/** 用户级形态（`sessionId === null`，issue #614）：卡片列用户级模板而不是会话订阅。 */
const isUserMode = computed(() => props.sessionId === null);

interface SubscriptionCard { key: string; name: string; last: string | null }
/** 订阅卡片区的数据源：会话面用生效订阅，用户面用 `scope='user'` 模板（`/api/macro-templates` 已只回 `audience='all'`）。 */
const subscriptionCards = computed<SubscriptionCard[]>(() => {
  if (isUserMode.value) {
    return macro.userTemplates.map((tpl) => ({ key: `user:${tpl.id}`, name: tpl.name, last: null }));
  }
  return macro.enabledAssignments.map((a) => ({
    key: a.id,
    name: macro.templates.find((x) => x.id === a.templateId)?.name ?? '',
    last: a.lastEvaluatedAt,
  }));
});
/** 卡片标题上的「启用 N 个」：会话数生效订阅，用户数用户级模板。 */
const subscriptionCount = computed(() => subscriptionCards.value.length);
/** 卡片右侧的「上次评估 …」：会话取订阅水位线，用户级无会话水位线⇒「尚未评估」。 */
function cardLastText(card: SubscriptionCard): string {
  return formatClock(card.last) ?? t('macro.card.notEvaluated');
}

/** 汇总：本会话（范围必须先声明，§15 第 2 条）。 */
const usageSummary = computed(() => summarizeUsage(macro.visibleRuns));
const summaryTokens = computed(() => formatTokens(
  usageSummary.value.measured > 0
    ? { inputTokens: usageSummary.value.inputTokens, outputTokens: usageSummary.value.outputTokens }
    : null,
));
const summaryMoney = computed(() => formatCostEstimate(
  usageSummary.value.measured > 0
    ? { inputTokens: usageSummary.value.inputTokens, outputTokens: usageSummary.value.outputTokens }
    : null,
  props.price,
));
/** 估算金额默认折叠（§15 第 3 条：常驻金额会变成账单警报）。 */
const estimateOpen = ref(false);

/** 链存在才显示深度（`07` §12：单条无链写 `深度 0` 是噪音）。 */
function hasChain(run: { parentMacroRunId?: string | null; childRunId: string | null; depth: number }): boolean {
  return run.depth > 0 || run.childRunId !== null;
}

/**
 * 分派失败 reason 的展示文案（A2/#850）：已知稳定机器码走 i18n；未知值（含运维要的
 * `dispatch_failed: <message>` 调试串）原样返回，**不吞、不渲染成空**（宏 run 对用户可读）。
 */
function reasonLabel(reason: string | null): string {
  if (!reason) return '';
  const key = runReasonMessageKey(reason);
  if (key && te(key)) return t(key);
  return reason;
}

/**
 * 宏 run「动作」行的文案：审查整改是人话 ⇒ 原样；没有它时这里落回原始 `reason` ⇒ 交给 `reasonLabel` 按码/原样处理。
 */
function actionLabel(run: { remediationText: string | null; reason: string | null }): string {
  if (run.remediationText) return run.remediationText;
  return reasonLabel(run.reason);
}

function close(): void {
  macro.closeDrawer();
  emit('close');
}

async function retry(): Promise<void> {
  await macro.refresh(props.sessionId);
}

// 抽屉卸载（父组件 `v-if` 直接销毁）也要停轮询：§16「面板关着的时候一个请求都不该发」。
onScopeDispose(() => macro.stopPolling());

defineExpose({ retry, estimateOpen });
</script>

<template>
  <div class="fixed inset-0 z-50" data-test="macro-drawer-root">
    <div data-test="macro-backdrop" class="absolute inset-0 bg-black/40" @click="close"></div>
    <div
      role="dialog"
      aria-modal="true"
      :aria-label="t('macro.title')"
      tabindex="-1"
      data-test="macro-drawer"
      class="absolute inset-y-0 right-0 flex w-full flex-col bg-white shadow-xl outline-none dark:bg-neutral-900 md:max-w-md lg:w-[520px] lg:max-w-[520px]"
    >
      <!-- 头部：< 768px 用返回箭头（§21.2），≥768px 用 ✕ -->
      <header class="flex items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <button
          type="button"
          data-test="macro-back"
          class="shrink-0 rounded px-2 py-1 text-sm text-black/60 hover:underline md:hidden dark:text-white/60"
          :aria-label="t('macro.action.back')"
          @click="close"
        >←</button>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ t('macro.title') }}</span>
        <!-- 二级入口：[配置 ▾] 打开模板下拉（chip 只做「开抽屉」，这里只做「开下拉」）。用户级抽屉里是只读的用户模板。 -->
        <MacroMenu variant="config" :scope="isUserMode ? 'user' : 'session'" :session-id="sessionId" />
        <button
          type="button"
          data-test="macro-refresh"
          class="shrink-0 rounded px-2 py-1 text-xs text-brand hover:underline"
          :aria-label="t('macro.action.refresh')"
          @click="retry"
        >↻</button>
        <button
          type="button"
          data-test="macro-close"
          class="hidden shrink-0 rounded px-2 py-1 text-xs text-black/50 hover:underline md:inline dark:text-white/60"
          :aria-label="t('macro.action.close')"
          @click="close"
        >✕</button>
      </header>

      <!-- 判据⑤：健康告警在**顶部状态条**（与流水列表分离，§17.3） -->
      <div
        v-if="health.stale"
        data-test="macro-health"
        role="status"
        class="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300"
      >
        <span data-test="macro-health-text">
          <span
            v-if="health.neverEvaluated"
            data-test="macro-health-never"
          >{{ t('macro.health.neverEvaluated') }}</span>
          <span v-else>{{ t('macro.health.stale', {
            minutes: healthMinutes ?? 0,
            everySeconds: expectedEverySeconds,
            staleAfterSeconds,
          }) }}</span>
          <span class="ml-1 text-amber-700/80 dark:text-amber-300/80">{{ t('macro.health.nextStep') }}</span>
        </span>
      </div>

      <!-- 订阅卡片（`09` §3.1）：每条订阅后面跟「上次评估 …」 -->
      <section class="border-b border-black/10 px-4 py-2 dark:border-white/10" data-test="macro-subscriptions">
        <p class="text-[11px] text-black/55 dark:text-white/55" data-test="macro-subscription-count">
          {{ t('macro.card.enabledCount', { count: subscriptionCount }) }}
        </p>
        <ul class="mt-1 space-y-1">
          <li
            v-for="card in subscriptionCards"
            :key="card.key"
            class="flex items-center justify-between gap-2 text-sm"
            data-test="macro-subscription-card"
          >
            <span class="min-w-0 truncate">{{ card.name }}</span>
            <span class="shrink-0 text-[11px] text-black/50 dark:text-white/50" data-test="macro-last-evaluated">
              {{ t('macro.card.lastEvaluated', { at: cardLastText(card) }) }}
            </span>
          </li>
        </ul>
      </section>

      <!-- 用户的筛选**只有两个**（`09` §3.2）：模板 / 判决 -->
      <section class="flex flex-wrap items-center gap-2 border-b border-black/10 px-4 py-2 dark:border-white/10">
        <label class="text-xs text-black/55 dark:text-white/55">{{ t('macro.filter.template') }}</label>
        <select
          data-test="macro-filter-template"
          class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
          :value="macro.filterTemplateId ?? ''"
          @change="macro.setTemplateFilter(($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">{{ t('macro.filter.allTemplates') }}</option>
          <option
            v-for="tpl in macro.sessionTemplates"
            :key="tpl.id"
            :value="tpl.id"
          >{{ tpl.name || t(`macro.kind.${kindSuffixOf(tpl.kind)}`) }}</option>
        </select>
        <label class="text-xs text-black/55 dark:text-white/55">{{ t('macro.filter.verdict') }}</label>
        <select
          data-test="macro-filter-verdict"
          class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
          :value="macro.filterVerdict ?? ''"
          @change="macro.setVerdictFilter(($event.target as HTMLSelectElement).value || null, sessionId)"
        >
          <option value="">{{ t('macro.filter.allVerdicts') }}</option>
          <option
            v-for="v in macro.verdictOptions"
            :key="v"
            :value="v"
          >{{ t(verdictMessageKey(v)) }}</option>
        </select>
        <button
          v-if="macro.filterActive"
          type="button"
          data-test="macro-filter-clear"
          class="rounded px-1.5 py-0.5 text-xs text-brand hover:underline"
          @click="macro.clearFilters()"
        >{{ t('macro.filter.clear') }}</button>
      </section>

      <!-- 判据①：技术态与业务态分开渲染，各态各自的节点 -->
      <p
        v-if="state === 'loading'"
        data-test="macro-loading"
        class="flex flex-1 items-center justify-center px-4 py-6 text-sm text-black/50 dark:text-white/50"
      >{{ t('macro.loading') }}</p>

      <div
        v-else-if="state === 'failed'"
        data-test="macro-error"
        class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-sm text-red-600"
      >
        <span>{{ t('macro.loadFailed') }}</span>
        <span class="text-xs text-black/40 dark:text-white/40" data-test="macro-error-detail">{{ macro.runsErrorText }}</span>
        <button
          type="button"
          data-test="macro-retry"
          class="rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          @click="retry"
        >{{ t('macro.retry') }}</button>
      </div>

      <!-- 判据⑤的另一半：空态区**不放**健康告警（所以这里没有 macro-health 节点） -->
      <div
        v-else-if="emptyKey"
        data-test="macro-empty"
        class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-center text-sm text-black/50 dark:text-white/50"
      >
        <span data-test="macro-empty-text">{{ state === 'neverTriggered'
          ? t(emptyKey, { count: macro.enabledAssignments.length, at: formatClock(health.last) ?? t('macro.card.notEvaluated') })
          : t(emptyKey) }}</span>
        <button
          v-if="state === 'noSubscription'"
          type="button"
          data-test="macro-empty-configure"
          class="rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          @click="macro.setTemplateFilter(null)"
        >{{ t('macro.empty.chooseTemplate') }}</button>
        <button
          v-else-if="state === 'filteredEmpty'"
          type="button"
          data-test="macro-empty-clear"
          class="rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          @click="macro.clearFilters()"
        >{{ t('macro.filter.clear') }}</button>
      </div>

      <!-- 流水：两行一条（`07` §12） -->
      <div v-else class="flex-1 space-y-2 overflow-y-auto px-4 py-3">
        <template v-for="item in feed" :key="item.key">
          <!-- 跳过汇总行（判据②：连续同因**一条**，展开才看每次时刻） -->
          <div
            v-if="item.kind === 'skippedGroup'"
            data-test="macro-skip-group"
            :data-reason="item.reason"
            :data-count="item.repeatCount"
            class="rounded border border-black/5 bg-black/[0.02] px-2.5 py-1.5 text-sm dark:border-white/10 dark:bg-white/5"
          >
            <div class="flex items-baseline gap-2">
              <span class="text-[11px] text-black/45 dark:text-white/45">{{ formatClock(item.latest.startedAt) }}</span>
              <span class="min-w-0 flex-1 truncate text-black/55 dark:text-white/55" data-test="macro-skip-text">
                {{ t(skipMessageKey(item.reason)) }}
                <span v-if="item.repeatCount > 1" data-test="macro-skip-repeat">
                  · {{ t('macro.skip.aggregate', { count: item.repeatCount }) }}
                </span>
              </span>
              <span
                class="shrink-0 text-[11px]"
                :class="skipIsBudgetRisk(item.reason) ? 'text-amber-600' : 'text-black/45 dark:text-white/45'"
              >{{ t('macro.status.skipped') }}</span>
            </div>
            <ul v-if="item.repeatCount > 1" class="mt-1 space-y-0.5 pl-2 text-[11px] text-black/45 dark:text-white/45">
              <li v-for="r in item.runs" :key="r.id" data-test="macro-skip-member">
                {{ formatClock(r.startedAt) }}
              </li>
            </ul>
          </div>

          <!-- 普通记录：两行（时间/锚/判据 + 动作与判决），附注按数据有无显示 -->
          <div
            v-else
            data-test="macro-run"
            :data-run-id="item.run.id"
            :data-status="item.run.status"
            :data-verdict="item.run.verdict ?? ''"
            class="rounded border border-black/5 px-2.5 py-1.5 text-sm dark:border-white/10"
          >
            <div class="flex items-baseline gap-2">
              <span class="text-[11px] text-black/45 dark:text-white/45">{{ formatClock(item.run.startedAt) }}</span>
              <span class="min-w-0 flex-1 truncate text-[11px] text-black/45 dark:text-white/45">
                {{ item.run.anchor ?? '' }}<span v-if="item.run.criterion"> · {{ item.run.criterion }}</span>
              </span>
              <span
                data-test="macro-status"
                class="shrink-0 text-[11px]"
                :class="{
                  'text-black/45 dark:text-white/45': item.run.status !== 'failed',
                  'text-red-600': item.run.status === 'failed',
                }"
              >{{ t(statusMessageKey(item.run.status)) }}</span>
            </div>
            <div class="mt-0.5 flex items-baseline gap-2">
              <span data-test="macro-run-action" class="min-w-0 flex-1 truncate">{{ actionLabel(item.run) || t('macro.detail.noAction') }}</span>
              <span
                v-if="item.run.verdict"
                data-test="macro-verdict"
                :data-verdict="item.run.verdict"
                class="shrink-0 text-xs"
                :class="{
                  'text-black/60 dark:text-white/60': verdictTone(item.run.verdict) === 'neutral',
                  'text-amber-600': verdictTone(item.run.verdict) === 'warn',
                  'text-red-600': verdictTone(item.run.verdict) === 'danger',
                }"
              >{{ t(verdictMessageKey(item.run.verdict)) }}</span>
            </div>
            <!-- 附注行：**按数据有无显示**，没成本就不写 `↑0 ↓0`（判据④） -->
            <p
              v-if="formatTokens(item.run.usage) || formatDuration(item.run.startedAt, item.run.finishedAt) || hasChain(item.run)"
              class="mt-0.5 text-[11px] text-black/45 dark:text-white/45"
              data-test="macro-run-note"
            >
              <span v-if="formatTokens(item.run.usage)" data-test="macro-run-cost">{{ formatTokens(item.run.usage) }}</span>
              <span v-if="formatDuration(item.run.startedAt, item.run.finishedAt)">
                · {{ formatDuration(item.run.startedAt, item.run.finishedAt) }}
              </span>
              <span v-if="hasChain(item.run)"> · {{ t('macro.detail.depth', { depth: item.run.depth }) }}</span>
            </p>
          </div>
        </template>
      </div>

      <!-- 成本汇总（`07` §15）：实测 token 常驻；金额是估算、默认折叠、单价未定就不显示 -->
      <footer
        v-if="state === 'ready'"
        class="border-t border-black/10 px-4 py-2 text-xs dark:border-white/10"
        data-test="macro-cost"
      >
        <span data-test="macro-cost-summary">
          {{ t('macro.cost.triggers', { count: usageSummary.triggers }) }}
          <span v-if="summaryTokens" data-test="macro-cost-tokens"> · {{ summaryTokens }}</span>
          <span v-else data-test="macro-cost-unknown"> · {{ t('macro.cost.unknown') }}</span>
        </span>
        <button
          v-if="summaryMoney"
          type="button"
          data-test="macro-cost-estimate-toggle"
          class="ml-2 text-brand hover:underline"
          @click="estimateOpen = !estimateOpen"
        >{{ t('macro.cost.estimateToggle') }}</button>
        <p v-if="summaryMoney && estimateOpen" data-test="macro-cost-estimate" class="mt-0.5 text-black/50 dark:text-white/50">
          {{ summaryMoney }} · {{ t('macro.cost.estimateHint') }}
        </p>
      </footer>
    </div>
  </div>
</template>
