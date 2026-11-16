<script setup lang="ts">
// 宏入口（issue #528，`07` §3）：**同一个组件两个实例** ——
//   · `scope="session"` 挂在会话头右侧（可以订阅/取消）
//   · `scope="user"`    挂在顶栏（用户级模板只读展示，`07` §3.2：由管理员代配，不给第二个设置页）
//
// ⚠ 入口职责分开（`07` §3.1「一次点击只做一件事」）：
//   · chip 点击 ⇒ 打开**流水抽屉**（emit `open-runs`），**不**打开模板下拉
//   · 抽屉内的 `[配置 ▾]` ⇒ 打开**模板下拉**（assign / 取消）——那是本组件的 `variant="config"`
// 所以本文件里两种形态都有，但**同一时刻只渲染一种**，不会出现「点 chip 同时开两件事」。
//
// 形态照 `GitLightBadge.vue`：相对定位容器 + button + 绝对定位面板，点击外部关闭。
import { computed, onMounted, onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMacroStore } from '../stores/macro';
import { kindMessageKey, kindSuffixOf } from '../lib/macroView';
// 枚举单一真源（契约 `10` 篇 §1）：某个 kind 能不能在会话里订，看 `KIND_SCOPE`，
// 不拿模板自带的 `scope` 字段猜（后者可以被实例写歪，前者是定义）。
import { KIND_SCOPE } from '@shared/macro-kinds';

const props = withDefaults(defineProps<{
  /** `session`：会话头（可订阅）；`user`：顶栏（只读，管理员代配）。 */
  scope?: 'session' | 'user';
  /** `chip`：入口徽标；`config`：抽屉里的 `[配置 ▾]` 模板下拉。 */
  variant?: 'chip' | 'config';
  sessionId?: string | null;
}>(), {
  scope: 'session',
  variant: 'chip',
  sessionId: null,
});

const emit = defineEmits<{ (e: 'open-runs'): void; (e: 'close'): void }>();

const { t } = useI18n();
const macro = useMacroStore();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

/** 本实例该列哪些模板：会话面只列 `scope='session'`（`07` §3.2 的硬要求）。 */
const listed = computed(() => (props.scope === 'user' ? macro.userTemplates : macro.sessionTemplates));

const enabledCount = computed(() => macro.enabledAssignments.length);

const chipLabel = computed(() => (
  enabledCount.value > 0
    ? t('macro.chip.enabled', { count: enabledCount.value })
    : t('macro.chip.none')
));

/** 某个模板在当前会话的订阅状态（`user` scope 不做 assign，故不查）。 */
function assignmentOf(templateId: string) {
  return macro.assignmentByTemplate.get(templateId) ?? null;
}

function isSubscribed(templateId: string): boolean {
  const a = assignmentOf(templateId);
  return a !== null && a.effectiveEnabled;
}

/** 这个模板能不能在会话里订（`KIND_SCOPE` 是 kind 的定义，`scheduled-task` 只能 `user`）。 */
function assignableHere(template: { kind: string; scope: string }): boolean {
  if (props.scope !== 'session' || !props.sessionId) return false;
  // `KIND_SCOPE` 的键是枚举字面量（shared 真源的推导结果），而后端的 `kind` 是 `string`
  // ⇒ 这里做一次显式收窄，不在 shared 里把类型放宽成 `Record<string, string>`（那会丢掉
  // shared 自己的字面量类型，其他消费方就得不到穷尽检查）。
  const scopeOfKind = (KIND_SCOPE as Record<string, string | undefined>)[template.kind];
  return scopeOfKind === 'session' && template.scope === 'session';
}

/** 选中即生效（`07` §3.3：没有「保存」按钮，也不往消息流里插东西）。 */
async function toggle(templateId: string, subscribe: boolean): Promise<void> {
  if (props.scope !== 'session' || !props.sessionId) return;
  if (subscribe) {
    await macro.assign(props.sessionId, templateId);
  } else {
    const a = assignmentOf(templateId);
    if (a) await macro.unassign(props.sessionId, a.id);
  }
}

function onChipClick(): void {
  // chip 只做一件事：开流水抽屉。配置是抽屉里的二级入口。
  emit('open-runs');
}

function onConfigClick(): void {
  open.value = !open.value;
}

function onDocPointerDown(event: MouseEvent): void {
  if (!open.value) return;
  if (root.value && event.target instanceof Node && root.value.contains(event.target)) return;
  open.value = false;
}

onMounted(() => {
  void macro.loadTemplates();
  if (typeof document !== 'undefined') document.addEventListener('mousedown', onDocPointerDown);
});

onScopeDispose(() => {
  if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocPointerDown);
});
</script>

<template>
  <!-- config 形态：抽屉里的 [配置 ▾] + 模板下拉 -->
  <div v-if="variant === 'config'" ref="root" class="relative inline-block" data-test="macro-config">
    <button
      type="button"
      data-test="macro-config-button"
      class="rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
      :aria-expanded="open ? 'true' : 'false'"
      @click="onConfigClick"
    >{{ t('macro.config.title') }}</button>

    <div
      v-if="open"
      data-test="macro-config-panel"
      role="dialog"
      :aria-label="t('macro.config.title')"
      class="absolute left-0 z-40 mt-1 w-80 rounded-md border border-black/10 bg-white p-2.5 shadow-lg dark:border-white/15 dark:bg-neutral-900"
    >
      <p class="text-[11px] leading-[1.5] text-black/55 dark:text-white/55">{{ t('macro.config.intro') }}</p>

      <p
        v-if="macro.templatesFailed"
        data-test="macro-config-failed"
        class="mt-2 text-xs text-red-600"
      >{{ t('macro.loadFailed') }}</p>

      <ul v-else class="mt-2 space-y-1.5">
        <li
          v-for="tpl in listed"
          :key="tpl.id"
          data-test="macro-config-item"
          :data-template-id="tpl.id"
          :data-scope="tpl.scope"
          class="flex items-start gap-2"
        >
          <input
            type="checkbox"
            data-test="macro-config-check"
            class="mt-1"
            :checked="isSubscribed(tpl.id)"
            :disabled="!assignableHere(tpl)"
            :aria-label="t(kindMessageKey(tpl.kind))"
            @change="toggle(tpl.id, ($event.target as HTMLInputElement).checked)"
          />
          <span class="min-w-0">
            <span class="block truncate text-sm">{{ tpl.name || t(kindMessageKey(tpl.kind)) }}</span>
            <span class="block text-[11px] leading-[1.5] text-black/50 dark:text-white/50"
                  data-test="macro-config-desc">{{ t(`macro.kind.desc.${kindSuffixOf(tpl.kind)}`) }}</span>
            <!-- `user` scope 在会话面不出现；顶栏那份明确说「管理员代配」，避免用户找一个不存在的开关 -->
            <span v-if="scope === 'user'" class="block text-[11px] text-black/40 dark:text-white/40">
              {{ t('macro.config.userScopeHint') }}
            </span>
          </span>
        </li>
      </ul>
    </div>
  </div>

  <!-- chip 形态：会话头右侧 / 顶栏。点击 = 打开流水抽屉（唯一动作） -->
  <div v-else ref="root" class="relative" data-test="macro-menu" :data-scope="scope">
    <button
      type="button"
      data-test="macro-chip"
      class="flex items-center gap-1.5 rounded-md border border-black/10 px-2 py-0.5 text-sm hover:bg-black/5 dark:border-white/15 dark:hover:bg-white/10"
      :title="chipLabel"
      :aria-label="chipLabel"
      @click="onChipClick"
    >
      <span aria-hidden="true">⚙</span>
      <span data-test="macro-chip-label">{{ chipLabel }}</span>
    </button>
  </div>
</template>
