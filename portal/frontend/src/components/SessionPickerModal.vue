<script setup lang="ts">
// 会话选择 modal（issue #94，架构评审裁决瘦身版）：单次全量浏览（limit=100 一次拉全，弹窗内滚动）。
// 入口：① 侧栏固定头 🔍（无目录时 all）② Ctrl/⌘+K（scope='all' 跨目录找回）。
// 契约：props { scope: 'cwd'|'all', cwd? }；emits select(sessionId) / close。
// 交互（评审裁决：去搜索/分页/总数——搜索待 #88 标题自动生成后再评估）：
// 范围 segmented 恒可改；三态（加载中/无结果/失败保留旧列表+重试）；
// 键盘 ↑↓ 高亮、Enter 进入、Esc 关闭；焦点进 dialog 容器并归还触发按钮；
// dialog 语义（role/aria-modal）；移动端 max-md 全屏层锁背景滚动，桌面居中 dialog。
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionBrowser, type PickerSession } from '../composables/useSessionBrowser';

// issue #101 P2：用户可见文案走 i18n（picker.* / common.*）；issue #105 ③：时间戳亦随 locale。
const { t, locale } = useI18n();

const props = withDefaults(defineProps<{ scope: 'cwd' | 'all'; cwd?: string }>(), { cwd: undefined });
const emit = defineEmits<{
  (e: 'select', sessionId: string): void;
  (e: 'close'): void;
}>();

// 范围 segmented：入口只给默认值，modal 内恒可改（扩大/缩小到当前目录）。
const scope = ref(props.scope);
const cwdRef = computed(() => props.cwd ?? null);
const dirShortName = computed(() => props.cwd?.split('/').pop() ?? '');
const { items, loading, error, empty, retry } = useSessionBrowser({ scope, cwd: cwdRef });

// ---- 键盘高亮（↑↓ 移动、Enter 进入；列表刷新后回第一条）----
const activeIndex = ref(-1);
watch(items, (list) => {
  activeIndex.value = list.length > 0 ? 0 : -1;
});

function pick(s: PickerSession) {
  emit('select', String(s.id));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  const n = items.value.length;
  if (n === 0) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const delta = e.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + n) % n;
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const item = items.value[activeIndex.value];
    if (item) pick(item);
  }
}

// ---- 焦点管理 + 背景滚动锁定：打开焦点进 dialog，关闭归还触发按钮 ----
const dialogEl = useTemplateRef<HTMLElement>('dialogEl');
let previousFocus: Element | null = null;
let previousOverflow = '';

onMounted(async () => {
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden'; // 锁背景滚动（移动端全屏层）
  await nextTick();
  dialogEl.value?.focus();
});
onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  (previousFocus as HTMLElement | null)?.focus?.();
});

// 绝对本地时间（与侧栏 store.sessMeta 一致：按当前 locale 格式化；'zh-CN' 输出逐字不变，en 走英文格式）。
// locale 为响应式 ref → 模板内调用 abs() 时读取，切语言即时重渲染。
const abs = (iso?: string) => new Date(iso ?? 0).toLocaleString(locale.value);
</script>

<template>
  <!-- 遮罩 + dialog 同一固定容器：移动端全屏层、桌面居中 dialog -->
  <!-- keydown 挂容器：焦点在 dialog 内时 ↑↓/Enter/Esc 经冒泡到达 -->
  <div class="fixed inset-0 z-50" @keydown="onKeydown">
    <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      :aria-label="t('picker.title')"
      tabindex="-1"
      class="absolute inset-x-0 top-10 bottom-0 flex flex-col bg-white shadow-xl outline-none max-md:rounded-t-lg md:inset-auto md:left-1/2 md:top-1/2 md:bottom-auto md:w-[32rem] md:max-h-[72vh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
    >
      <!-- 头：范围 segmented（恒可改）+ 关闭 -->
      <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
        <div class="flex min-w-0 rounded-md border border-black/20 text-sm" role="group" :aria-label="t('picker.scopeLabel')">
          <button
            type="button"
            class="min-w-0 truncate rounded-l-md px-2 py-1 disabled:opacity-40"
            :class="scope === 'cwd' ? 'bg-brand text-white' : 'hover:bg-black/5'"
            :disabled="!cwd"
            :title="cwd ? t('picker.currentDirTitle', { cwd }) : t('picker.noDirSelected')"
            @click="scope = 'cwd'"
          >{{ t('picker.currentDir', { name: dirShortName || '—' }) }}</button>
          <button
            type="button"
            class="rounded-r-md border-l border-black/20 px-2 py-1"
            :class="scope === 'all' ? 'bg-brand text-white' : 'hover:bg-black/5'"
            @click="scope = 'all'"
          >{{ t('picker.allDirs') }}</button>
        </div>
        <button
          type="button"
          :aria-label="t('common.close')"
          class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
          @click="emit('close')"
        >✕</button>
      </div>

      <!-- 结果列表：独立滚动（单次全量，无分页）；px-2 与侧栏 aside 内边距对齐，使行样式与侧栏同构 -->
      <div class="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ul role="listbox" :aria-label="t('picker.listLabel')">
          <!-- issue #112：条目与侧栏同一套扁平行样式（无边框卡、左 2px brand 竖条 + 浅绿底、12/11px） -->
          <li
            v-for="(s, i) in items"
            :key="String(s.id)"
            class="flex min-h-[54px] cursor-pointer items-center border-l-2 pl-3.5 pr-2"
            :class="i === activeIndex ? 'border-l-brand bg-green-50' : 'border-l-transparent hover:bg-black/5'"
            role="option"
            :aria-selected="i === activeIndex"
            @click="pick(s)"
            @mouseenter="activeIndex = i"
          >
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-1.5 text-[12px] leading-[1.4]">
                <span class="truncate">{{ s.title || t('common.unnamedSession') }}</span>
                <span v-if="s.active_run_id" class="shrink-0 text-[11px] text-brand">{{ t('common.runningBadge') }}</span>
              </div>
              <div class="mt-0.5 truncate text-[11px] leading-[1.4] text-black/50">
                <span v-if="scope === 'all'">{{ s.cwd?.split('/').pop() ?? t('common.noDir') }} · </span>{{ abs(s.updated_at) }}
              </div>
            </div>
          </li>
        </ul>

        <!-- 三态：加载中 / 无结果 / 失败（保留旧列表 + 重试）；空态文案 11px（issue #112） -->
        <p v-if="loading" class="py-4 text-center text-[11px] text-black/50">{{ t('common.loading') }}</p>
        <p v-else-if="empty" class="py-6 text-center text-[11px] text-black/50">{{ t('picker.empty') }}</p>
        <div v-if="error" class="py-4 text-center">
          <p class="syserr" role="alert">{{ error }}{{ t('picker.staleListKept') }}</p>
          <button
            type="button"
            class="mt-2 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
            @click="retry"
          >{{ t('common.retry') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>
