<script setup lang="ts">
// 子 run（delegation）**活跃徽标**（issue #592 交付 2 的收起态；设计 §4.3）。
//
// 落点：`RunStatusBar.vue` 的**尾部一段**（不是新开一条状态条）——#282 早已定下「run 级状态只有
// 这一条常驻位」，子 run 是 run 级事实，另起一条就是第二条状态条。
//
// 数字的尺规**只有一处**：`store.delegateLiveCount` ← `lib/delegate.ts#DELEGATE_LIVE_STATES`。
// 本组件**不**判 state 字符串（写了就是第二份分级，#236 那一类「两处不同颜色」的起源）。
//
// **N 为 0 且读到了 ⇒ 整段不出**：面板是「有儿子在跑才说话」的加分项，常驻一个 `子任务 0` 是噪音
// （终态后的历史子 run 归工具卡，设计 §4.3 末段）。
//
// ⚠ 但**「读到过且真的没有」≠「读不到」**：后者（`store.delegateDegraded` = 连续失败到阈值且一次
// 都没成功过）时徽标必须照样出现，只是画**中性灰 + `?`**——它是徽标唯一的入口，徽标不出面板就
// 永远打不开，设计 §4.2 要的那句「子任务状态暂不可读」就成了不可达的死文案（独立验收复核抓到的
// 真缺陷）。把「我不知道」演成「没有」，与 D9 的「⚪ 不得渲染成绿」是同一条口径。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

const store = useWorkbenchStore();
const { t } = useI18n();

const liveCount = computed(() => store.delegateLiveCount);
const degraded = computed(() => store.delegateDegraded);
/** 一个数都报不出来（读不到且没有行）⇒ 中性灰 + 静止的 `·`，**不**转圈、不拿 0 冒充「没有」。 */
const unknown = computed(() => degraded.value && liveCount.value === 0);
/** 判据 5 的可见面：活态数为 0 **且真的读到了** ⇒ 整段不渲染；读不到时仍要说话（见头注 ⚠ 段）。 */
const visible = computed(() => liveCount.value > 0 || degraded.value);
/** 展开态与面板共用 store 里那一份（徽标在状态条、面板在它下方，两个组件必须同步）。 */
const expanded = computed(() => store.delegatePanelOpen);
</script>

<template>
  <button
    v-if="visible"
    type="button"
    data-testid="delegate-activity-badge"
    :data-degraded="unknown ? 'true' : 'false'"
    class="delegate-activity-badge inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-medium hover:bg-black/5 dark:hover:bg-white/10"
    :class="unknown ? 'text-black/50 dark:text-white/50' : 'text-brand'"
    :aria-expanded="expanded ? 'true' : 'false'"
    :aria-label="unknown ? t('delegate.activity.toggleUnknown') : t('delegate.activity.toggle', { count: liveCount })"
    :title="t('delegate.activity.hint')"
    @click="store.toggleDelegatePanel()"
  >
    <!-- 转圈照 RunStatusBar / DelegateChildDrawer 的手法（复用 Tailwind animate-spin，不新造动画）；
         **活态才转**：静止的徽标 = 已经没有子在跑了；降级态画 `·`（拿转圈冒充「在跑」就是谎报）。 -->
    <svg
      v-if="!unknown"
      class="h-3 w-3 shrink-0 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <span v-else class="shrink-0" aria-hidden="true">·</span>
    <span aria-hidden="true">🤖</span>
    <span>{{ unknown ? t('delegate.activity.titleUnknown') : t('delegate.activity.title', { count: liveCount }) }}</span>
  </button>
</template>
