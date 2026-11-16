<script setup lang="ts">
// 子 run（delegation）**活跃徽标**（issue #592 交付 2 的收起态；设计 §4.3）。
//
// 落点：`RunStatusBar.vue` 的**尾部一段**（不是新开一条状态条）——#282 早已定下「run 级状态只有
// 这一条常驻位」，子 run 是 run 级事实，另起一条就是第二条状态条。
//
// 数字的尺规**只有一处**：`store.delegateLiveCount` ← `lib/delegate.ts#DELEGATE_LIVE_STATES`。
// 本组件**不**判 state 字符串（写了就是第二份分级，#236 那一类「两处不同颜色」的起源）。
//
// **N 为 0 时整段不出**：面板是「有儿子在跑才说话」的加分项，常驻一个 `子任务 0` 是噪音
// （终态后的历史子 run 归工具卡，设计 §4.3 末段）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

const store = useWorkbenchStore();
const { t } = useI18n();

const liveCount = computed(() => store.delegateLiveCount);
/** 判据 5 的可见面：活态数为 0 ⇒ 整段不渲染（连容器都不留）。 */
const visible = computed(() => liveCount.value > 0);
/** 展开态与面板共用 store 里那一份（徽标在状态条、面板在它下方，两个组件必须同步）。 */
const expanded = computed(() => store.delegatePanelOpen);
</script>

<template>
  <button
    v-if="visible"
    type="button"
    data-testid="delegate-activity-badge"
    class="delegate-activity-badge inline-flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-medium text-brand hover:bg-black/5 dark:hover:bg-white/10"
    :aria-expanded="expanded ? 'true' : 'false'"
    :aria-label="t('delegate.activity.toggle', { count: liveCount })"
    :title="t('delegate.activity.hint')"
    @click="store.toggleDelegatePanel()"
  >
    <!-- 转圈照 RunStatusBar / DelegateChildDrawer 的手法（复用 Tailwind animate-spin，不新造动画）；
         活态才转：静止的徽标 = 已经没有子在跑了。 -->
    <svg class="h-3 w-3 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
    </svg>
    <span aria-hidden="true">🤖</span>
    <span>{{ t('delegate.activity.title', { count: liveCount }) }}</span>
  </button>
</template>
