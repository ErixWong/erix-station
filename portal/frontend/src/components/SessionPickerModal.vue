<script setup lang="ts">
// 会话选择 modal（issue #94）：通用组件，三入口共用——
//   ① 侧栏列表尾「查看全部 →」（默认 scope='cwd'）② 侧栏固定头 🔍（无目录时 all）
//   ③ 顶栏 🔍 / Ctrl·⌘+K（scope='all' 跨目录找回）。
// 契约：props { scope: 'cwd'|'all', cwd? }；emits select(sessionId) / close。
// 交互（issue #94 修订：去搜索改纯浏览——搜索待 #88 标题自动生成后再加回）：
// 范围 segmented 恒可改；浏览（20/批 keyset，触底+按钮加载更多）；
// 三态（加载中/无结果/失败保留旧列表+重试）；键盘 ↑↓ 高亮、Enter 进入、Esc 关闭、
// 焦点进 dialog 容器并归还触发按钮；dialog 语义（role/aria-modal）；移动端 max-md 全屏层锁背景滚动，桌面居中 dialog。
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { useSessionSearch, type PickerSession } from '../composables/useSessionSearch';
import { formatRelativeTime } from '../lib/relativeTime';

const props = withDefaults(defineProps<{ scope: 'cwd' | 'all'; cwd?: string }>(), { cwd: undefined });
const emit = defineEmits<{
  (e: 'select', sessionId: string): void;
  (e: 'close'): void;
}>();

// 范围 segmented：入口只给默认值，modal 内恒可改（扩大/缩小到当前目录）。
const scope = ref(props.scope);
const cwdRef = computed(() => props.cwd ?? null);
const dirShortName = computed(() => props.cwd?.split('/').pop() ?? '');
const { items, loading, loadingMore, error, total, hasMore, empty, loadMore, retry } =
  useSessionSearch({ scope, cwd: cwdRef });

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

// ---- 触底加载（显式「加载更多」按钮在下方兜底，含键盘/失败重试路径）----
const listEl = useTemplateRef<HTMLElement>('listEl');
function onListScroll() {
  const el = listEl.value;
  if (!el) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  if (gap < 80) loadMore();
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

const rel = (iso?: string) => formatRelativeTime(iso);
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
      aria-label="浏览会话"
      tabindex="-1"
      class="absolute inset-x-0 top-10 bottom-0 flex flex-col bg-white shadow-xl outline-none max-md:rounded-t-lg md:inset-auto md:left-1/2 md:top-1/2 md:bottom-auto md:w-[32rem] md:max-h-[72vh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
    >
      <!-- 头：范围 segmented（恒可改）+ 总数 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
        <div class="flex min-w-0 rounded-md border border-black/20 text-sm" role="group" aria-label="会话范围">
          <button
            type="button"
            class="min-w-0 truncate rounded-l-md px-2 py-1 disabled:opacity-40"
            :class="scope === 'cwd' ? 'bg-brand text-white' : 'hover:bg-black/5'"
            :disabled="!cwd"
            :title="cwd ? `当前目录：${cwd}` : '未选择目录'"
            @click="scope = 'cwd'"
          >当前目录：{{ dirShortName || '—' }}</button>
          <button
            type="button"
            class="rounded-r-md border-l border-black/20 px-2 py-1"
            :class="scope === 'all' ? 'bg-brand text-white' : 'hover:bg-black/5'"
            @click="scope = 'all'"
          >全部目录</button>
        </div>
        <span v-if="total != null" class="ml-auto shrink-0 text-xs text-black/50">共 {{ total }} 个会话</span>
        <button
          type="button"
          aria-label="关闭"
          class="shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
          @click="emit('close')"
        >✕</button>
      </div>

      <!-- 结果列表：独立滚动 + 触底加载 -->
      <div ref="listEl" class="min-h-0 flex-1 overflow-y-auto px-3 py-2" @scroll="onListScroll">
        <ul>
          <li
            v-for="(s, i) in items"
            :key="String(s.id)"
            class="mt-1 cursor-pointer rounded-md border px-2 py-1.5 text-sm"
            :class="i === activeIndex ? 'border-brand bg-green-50' : 'border-black/15 hover:bg-black/5'"
            role="option"
            :aria-selected="i === activeIndex"
            @click="pick(s)"
            @mouseenter="activeIndex = i"
          >
            <div class="flex items-baseline gap-2">
              <span class="truncate">{{ s.title || '未命名会话' }}</span>
              <span v-if="s.active_run_id" class="shrink-0 text-xs text-brand">● 运行中</span>
            </div>
            <div class="text-xs text-black/50">
              <span v-if="scope === 'all'">{{ s.cwd?.split('/').pop() ?? '（无目录）' }} · </span>{{ rel(s.updated_at) }}
            </div>
          </li>
        </ul>

        <!-- 三态：加载中 / 无结果 / 失败（保留旧列表 + 重试） -->
        <p v-if="loading" class="muted py-4 text-center text-sm">加载中…</p>
        <p v-else-if="empty" class="muted py-6 text-center text-sm">该范围暂无会话</p>
        <div v-if="error" class="py-4 text-center">
          <p class="syserr text-sm" role="alert">{{ error }}（旧列表已保留）</p>
          <button
            type="button"
            class="mt-2 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
            @click="retry"
          >重试</button>
        </div>

        <!-- 显式「加载更多」：键盘可达，兼作失败重试兜底 -->
        <button
          v-if="hasMore && !loading && !error"
          type="button"
          class="mt-2 w-full rounded-md border border-black/20 px-2 py-1.5 text-sm hover:bg-black/5"
          @click="loadMore"
        >{{ loadingMore ? '加载中…' : '加载更多' }}</button>
      </div>
    </div>
  </div>
</template>
