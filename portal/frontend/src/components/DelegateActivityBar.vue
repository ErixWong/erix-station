<script setup lang="ts">
// 子 run（delegation）**活动面板**（issue #592 交付 2 的展开态；设计 §4.3）。
//
// 落点：`RunStatusBar` **下方**、`QueuedInputsBar` **上方**（`WorkbenchView` 的读序
// 「现在在跑什么 → 还排队说什么 → 输入框」正好容得下这一段）。收起态那颗徽标在状态条里
// （`DelegateActivityBadge.vue`），两边读写 store 里的同一个 `delegatePanelOpen`。
//
// 三处口径不许在这里重写：
//   * 分级/颜色：`delegateBadgeKind` + `DELEGATE_BADGE_CLASS`（`lib/delegate.ts` 唯一入口）；
//   * 短码：`shortRunId`；状态文案：`delegateStateKey` → i18n `delegate.state.*`（已存在，复用）；
//   * 时长：`formatDuration`（`lib/toolSummary.ts`）+ store 的 1s 时钟（`createdAt` + 客户端时钟，
//     §2 的结论：名册没有 `deadlineAt` ⇒ 画不了预算进度条，只能画「已跑多久」）。
//
// **「最近动作」这一格本单不渲染**：字段（`activity`）是阶段 1（#593/W2）才有的东西，
// 现在后端压根不给 ⇒ 留一个空位比留一句假话好（设计 §4.3 行内容与「不许拿假数据填空白」的仓规）。
//
// 失败面：只有**一行灰字**（`delegate.activity.unreadable`），**不许**渲染 ⚠ 告警底色——
// 子 run 是加分项，读不到不该把父界面打成故障态（设计 §4.2 末段）。
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';
import {
  DELEGATE_BADGE_CLASS,
  delegateBadgeKind,
  delegateStateKey,
  shortRunId,
} from '../lib/delegate';
import { formatDuration } from '../lib/toolSummary';
import type { DelegateActivityItem } from '../composables/useDelegateActivity';

const store = useWorkbenchStore();
const { t } = useI18n();

const rows = computed(() => store.delegateRows);
const unavailable = computed(() => store.delegateRowsUnavailable);
/** 挂不挂：徽标点开了且有内容，或者已经降级成「暂不可读」那一行（那时徽标可能已经没了）。 */
const visible = computed(() => store.delegatePanelOpen && (rows.value.length > 0 || unavailable.value));

/**
 * 没有活态子了就自己收起来：徽标在 `liveCount === 0` 时整段不出，面板要是继续挂着就成了
 * 「关不掉的孤儿」（它的唯一开关就是那颗徽标）。终态子 run 的归属是工具卡，不是这里。
 */
const liveCount = computed(() => store.delegateLiveCount);
watch(liveCount, (n) => {
  if (n === 0) store.collapseDelegatePanel();
});
/** 读不到且一行都没有 ⇒ 标题也说「子任务 ?」（与徒标同一说法，不拿 0 冒充「没有」）。 */
const unknown = computed(() => store.delegateDegraded && rows.value.length === 0);
const panelTitle = computed(() =>
  unknown.value ? t('delegate.activity.titleUnknown') : t('delegate.activity.panelTitle', { count: liveCount.value }),
);

function dotClass(item: DelegateActivityItem): string {
  return DELEGATE_BADGE_CLASS[delegateBadgeKind(item.state, item.termination)];
}

function badgeKind(item: DelegateActivityItem) {
  return delegateBadgeKind(item.state, item.termination);
}

function stateText(item: DelegateActivityItem): string {
  return t(`delegate.state.${delegateStateKey(item.state)}`);
}

/** 「已跑 42s」；`createdAt` 缺席 ⇒ 整段不出（不写 0s 假时长）。 */
function elapsedText(item: DelegateActivityItem): string {
  const ms = store.delegateElapsedMs(item);
  const dur = formatDuration(ms ?? NaN);
  return dur === '' ? '' : t('delegate.activity.elapsed', { dur });
}

/** 「查看」⇒ 打开**共享的**只读抽屉（挂载点只有 StreamPanel 那一处；这里只写状态）。 */
function openViewer(item: DelegateActivityItem): void {
  store.openDelegateViewer({
    // 面板行是**当前**父 run 的儿子 ⇒ parentRunId 取活跃 run（与端点入参同源，不从行里猜）。
    parentRunId: typeof store.es.activeRunId === 'string' ? store.es.activeRunId : '',
    childRunId: item.childRunId,
    label: 'delegate',
    termination: item.termination === '' ? undefined : item.termination,
  });
}

function collapse(): void {
  store.collapseDelegatePanel();
}

// Esc 收起（照 MacroMenu / 抽屉的键盘出口）。⚠ 抽屉也听 Esc ⇒ 抽屉开着时**让位**给它，
// 一次 Esc 只该关掉最上层那一样。
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || !visible.value) return;
  if (store.delegateViewer !== null) return;
  collapse();
}

onMounted(() => {
  if (typeof document !== 'undefined') document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  if (typeof document !== 'undefined') document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <section
    v-if="visible"
    data-testid="delegate-activity-panel"
    class="delegate-activity-bar border-t border-black/10 bg-black/[0.02] px-3 py-1 text-xs dark:border-white/10 dark:bg-white/[0.03]"
    :aria-label="panelTitle"
  >
    <header class="flex items-center gap-2">
      <span aria-hidden="true">🤖</span>
      <span class="min-w-0 flex-1 truncate font-medium">{{ panelTitle }}</span>
      <span class="hidden shrink-0 text-black/40 sm:inline dark:text-white/40">{{ t('delegate.activity.hint') }}</span>
      <button
        type="button"
        data-testid="delegate-activity-collapse"
        class="shrink-0 rounded px-1.5 py-0.5 text-brand hover:bg-black/5 dark:hover:bg-white/10"
        :aria-expanded="'true'"
        :aria-label="t('delegate.activity.toggle', { count: liveCount })"
        @click="collapse()"
      >{{ t('delegate.activity.collapse') }}</button>
    </header>

    <p
      v-if="unavailable"
      data-testid="delegate-activity-unavailable"
      class="mt-0.5 text-black/40 dark:text-white/40"
    >{{ t('delegate.activity.unreadable') }}</p>

    <ul v-if="rows.length" class="mt-0.5 space-y-0.5">
      <li
        v-for="item in rows"
        :key="item.childRunId"
        class="delegate-activity-row flex min-w-0 items-center gap-2"
        :data-child-run-id="item.childRunId"
      >
        <!-- 状态点：颜色唯一来源 DELEGATE_BADGE_CLASS[delegateBadgeKind(...)]；形状（●）+ data 属性
             与颜色三路共存，不靠颜色单独承载语义（同抽屉徽标的口径）。 -->
        <span
          class="delegate-activity-dot shrink-0"
          :class="dotClass(item)"
          :data-badge-kind="badgeKind(item)"
          aria-hidden="true"
        >●</span>
        <span class="shrink-0 font-mono">{{ shortRunId(item.childRunId) || item.childRunId }}</span>
        <span class="shrink-0 text-black/50 dark:text-white/50">{{ stateText(item) }}</span>
        <span v-if="elapsedText(item)" class="shrink-0 text-black/50 dark:text-white/50">{{ elapsedText(item) }}</span>
        <!-- 「最近动作」这一格（🔧 bash · npm test / 💬 正文）**等阶段 1 的 `activity` 字段**；
             本单后端不给 ⇒ 这里什么都不渲染（不写「—」也不写假摘要）。 -->
        <span class="min-w-0 flex-1"></span>
        <button
          type="button"
          class="delegate-activity-view shrink-0 rounded px-1.5 py-0.5 text-brand hover:bg-black/5 dark:hover:bg-white/10"
          :aria-label="t('delegate.activity.viewAria', { id: shortRunId(item.childRunId) || item.childRunId })"
          @click="openViewer(item)"
        >{{ t('delegate.activity.view') }}</button>
      </li>
    </ul>
  </section>
</template>
