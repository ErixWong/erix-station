<script setup lang="ts">
// 宏流水筛选组件（issue #529，事件平台 W6）。与 W5 的 `MacroDrawer` 共用同一套筛选语义，
// 但**两个 API 各自独立**：本组件只负责「把用户选的条件收集成一个 filters 对象」，
// 不发请求——权限判断留在调用方的两个端点里（红线：不做「一个 API 带 scope 参数」）。
//
// `props.scope`：
//   - `'user'`  → 只有 模板 / 判决 两个（口径同 `MacroDrawer.vue`，`09` §3.2）。
//   - `'admin'` → 模板 / 状态 / 判决 / 时间 / 用户 共 5 个，全部落在 `macro_runs` 的索引列上。
//
// 判据（单源自检）：状态、判决的取值一律从 `@shared/macro-kinds` 迭代，绝不在此抄字面量。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { STATUS, VERDICT } from '@shared/macro-kinds';
import { statusMessageKey, verdictMessageKey } from '../lib/macroView';

/** 一个筛选项：空串 = 不设置该条件（发送时会被丢弃，不写进 query）。 */
export interface MacroRunFilters {
  templateId: string;
  status: string;
  verdict: string;
  from: string;
  to: string;
  userId: string;
}

const props = withDefaults(defineProps<{
  scope?: 'admin' | 'user';
  /** 模板下拉的候选（调用方从各自的 API 取来，本组件不自己拉，避免把权限口径漏进组件）。 */
  templates?: Array<{ id: string; name: string }>;
}>(), { scope: 'admin', templates: () => [] });

// 单一 filters 对象模型：每次改动都**整体重新赋值**，保证父级 deep watch 能拿到新引用。
const filters = defineModel<MacroRunFilters>({ required: true });

const { t } = useI18n();

const isAdminScope = computed(() => props.scope === 'admin');

function set(key: keyof MacroRunFilters, value: string): void {
  filters.value = { ...filters.value, [key]: value };
}

/** 「清除」把所有条件重置为空（保留模板候选，只清已选值）。 */
function clearAll(): void {
  filters.value = { templateId: '', status: '', verdict: '', from: '', to: '', userId: '' };
}
</script>

<template>
  <div class="flex flex-wrap items-end gap-2" data-test="macro-run-filter" :data-scope="props.scope">
    <!-- 模板（admin 与 user 都有） -->
    <label class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55">
      {{ t('macro.filter.template') }}
      <select
        data-test="filter-template"
        class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
        :value="filters.templateId"
        @change="set('templateId', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('macro.filter.allTemplates') }}</option>
        <option v-for="tpl in props.templates" :key="tpl.id" :value="tpl.id">{{ tpl.name }}</option>
      </select>
    </label>

    <!-- 状态（仅 admin，落索引列 r.status） -->
    <label
      v-if="isAdminScope"
      class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55"
      data-test="filter-wrap-status"
    >
      {{ t('macro.filter.status') }}
      <select
        data-test="filter-status"
        class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
        :value="filters.status"
        @change="set('status', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('macro.filter.allStatuses') }}</option>
        <option v-for="s in STATUS" :key="s" :value="s">{{ t(statusMessageKey(s)) }}</option>
      </select>
    </label>

    <!-- 判决（admin 与 user 都有） -->
    <label class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55">
      {{ t('macro.filter.verdict') }}
      <select
        data-test="filter-verdict"
        class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
        :value="filters.verdict"
        @change="set('verdict', ($event.target as HTMLSelectElement).value)"
      >
        <option value="">{{ t('macro.filter.allVerdicts') }}</option>
        <option v-for="v in VERDICT" :key="v" :value="v">{{ t(verdictMessageKey(v)) }}</option>
      </select>
    </label>

    <!-- 时间区间（仅 admin，落 r.started_at） -->
    <template v-if="isAdminScope">
      <label class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55" data-test="filter-wrap-from">
        {{ t('macro.filter.from') }}
        <input
          data-test="filter-from"
          type="datetime-local"
          class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
          :value="filters.from"
          @change="set('from', ($event.target as HTMLInputElement).value)"
        >
      </label>
      <label class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55" data-test="filter-wrap-to">
        {{ t('macro.filter.to') }}
        <input
          data-test="filter-to"
          type="datetime-local"
          class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
          :value="filters.to"
          @change="set('to', ($event.target as HTMLInputElement).value)"
        >
      </label>

      <!-- 用户（仅 admin，落 a.user_id；管理员手填 userId） -->
      <label class="flex flex-col gap-0.5 text-xs text-black/55 dark:text-white/55" data-test="filter-wrap-user">
        {{ t('macro.filter.user') }}
        <input
          data-test="filter-user"
          type="text"
          class="rounded border border-black/15 px-1.5 py-0.5 text-xs dark:border-white/20"
          :value="filters.userId"
          @change="set('userId', ($event.target as HTMLInputElement).value)"
        >
      </label>
    </template>

    <button
      type="button"
      data-test="filter-clear"
      class="rounded border border-black/15 px-2 py-0.5 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
      @click="clearAll"
    >{{ t('macro.filter.clear') }}</button>
  </div>
</template>
