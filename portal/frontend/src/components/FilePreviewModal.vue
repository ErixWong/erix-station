<script setup lang="ts">
// 文件预览 modal（issue #84 P6 预览第一版）：目录树文件节点点击 → 本 modal。
// 三种渲染：Markdown 复用既有 lib/markdown.ts（v-html，渲染器先整体转义后格式化，XSS 安全，
// 与 StreamPanel 同一渲染器）；其余文本走 <pre> 等宽 + overflow-auto（**不引代码高亮库**）；
// 图片 <img>（后端 base64 data URL，零新端点）。
// 三态：加载中 / 失败（含 413 超限与 415 二进制，错误 message 直接展示）/ 成功。
// 交互对齐 SessionPickerModal 既有模式：dialog 语义（role/aria-modal）、Esc 关闭、
// 打开焦点进 dialog、关闭归还触发按钮、锁背景滚动；git 变更标记与 run 终态刷新不在本版范围。
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import { renderMarkdown } from '../lib/markdown';

// issue #101 P2：用户可见文案走 i18n（preview.* / common.*）；错误 message 来自后端（原样展示）。
const { t } = useI18n();

const props = defineProps<{ cwd: string; path: string }>(); // path = 相对 tree 根（= cwd）的路径
const emit = defineEmits<{ (e: 'close'): void }>();

interface FilePreview {
  name: string;
  path: string;
  kind: 'image' | 'text';
  data: string;
}

const loading = ref(true);
const error = ref('');
const preview = ref<FilePreview | null>(null);

// Markdown 分支（.md/.markdown）复用既有渲染器；其余文本原样 <pre>。
const isMarkdown = computed(() => /\.(md|markdown)$/i.test(preview.value?.name ?? ''));
const html = computed(() =>
  preview.value && isMarkdown.value ? renderMarkdown(preview.value.data) : '',
);

onMounted(async () => {
  // 焦点管理 + 背景滚动锁定：打开焦点进 dialog，关闭归还触发按钮（对齐 SessionPickerModal）。
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  dialogEl.value?.focus();
  try {
    preview.value = await api<FilePreview>(
      `/api/file?cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(props.path)}`,
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
onUnmounted(() => {
  document.body.style.overflow = previousOverflow;
  (previousFocus as HTMLElement | null)?.focus?.();
});

const dialogEl = useTemplateRef<HTMLElement>('dialogEl');
let previousFocus: Element | null = null;
let previousOverflow = '';

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
</script>

<template>
  <!-- 遮罩 + dialog 同一固定容器：移动端全屏层、桌面居中 dialog（对齐 SessionPickerModal 布局） -->
  <div class="fixed inset-0 z-50" @keydown="onKeydown">
    <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      :aria-label="t('preview.title', { path: props.path })"
      tabindex="-1"
      class="absolute inset-x-0 top-10 bottom-0 flex flex-col bg-white shadow-xl outline-none max-md:rounded-t-lg md:inset-auto md:left-1/2 md:top-1/2 md:bottom-auto md:w-[42rem] md:max-w-[90vw] md:max-h-[80vh] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-lg"
    >
      <!-- 头：文件名 + 相对路径 + 关闭 -->
      <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
        <span class="shrink-0 text-sm">📄 {{ preview?.name ?? props.path.split('/').pop() }}</span>
        <span class="muted min-w-0 truncate text-xs" :title="props.path">{{ props.path }}</span>
        <button
          type="button"
          :aria-label="t('common.close')"
          class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
          @click="emit('close')"
        >✕</button>
      </div>

      <!-- 三态：加载中 / 失败 / 成功（三种渲染分支） -->
      <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
        <p v-if="loading" class="muted py-6 text-center text-sm">{{ t('common.loading') }}</p>
        <p v-else-if="error" class="syserr py-6 text-center text-sm" role="alert">{{ error }}</p>
        <template v-else-if="preview">
          <img v-if="preview.kind === 'image'" :src="preview.data" :alt="preview.name" class="mx-auto max-h-full max-w-full">
          <!-- Markdown：渲染器输出走 v-html（先转义后格式化，无注入面），.md 类复用全局样式 -->
          <div v-else-if="isMarkdown" class="md text-sm" v-html="html"></div>
          <pre v-else class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{{ preview.data }}</pre>
        </template>
      </div>
    </div>
  </div>
</template>
