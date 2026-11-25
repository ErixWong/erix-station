<script setup lang="ts">
// docx 前端渲染（issue #795）：docx-preview 把 OOXML 直接画成 HTML（字节走 mode=stream）。
// 字节由 useFileBytes 取（/api/file?mode=stream，>20MB 已在上游降级）。
// 组件只负责渲染：失败/超限一律 emit('failed', …)，提示文案与下载出口统一由 FilePreviewModal
// 出——组件自己不放下载按钮（否则同一屏会出现两个出口）。
// styleEl 是组件内的独立 div：docx-preview 的产物样式随之进、随组件卸载一起没，不污染全局 head。
import { onMounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { renderAsync } from 'docx-preview';
import { useFileBytes } from '../composables/useFileBytes';

const props = defineProps<{ cwd: string; path: string }>();
const emit = defineEmits<{ failed: [reason: 'too_large' | 'render_failed'] }>();
const { t } = useI18n();
const bodyEl = useTemplateRef<HTMLDivElement>('bodyEl');
const styleEl = useTemplateRef<HTMLDivElement>('styleEl');
const rendered = ref(false);
const { load } = useFileBytes();

onMounted(async () => {
  const r = await load(props.cwd, props.path);
  if (!r.ok) {
    // too_large 原样上报（模态框给「超限」专用文案）；http/network 归「无法渲染」，两条都指向下载。
    emit('failed', r.reason === 'too_large' ? 'too_large' : 'render_failed');
    return;
  }
  try {
    await renderAsync(r.buffer, bodyEl.value as HTMLElement, styleEl.value as HTMLElement,
      { inWrapper: true });
    rendered.value = true;
  } catch {
    emit('failed', 'render_failed');
  }
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="!rendered" class="p-4 text-sm text-slate-500">{{ t('common.loading') }}</div>
    <!-- 两个宿主都必须留在 DOM 里（v-show 不是 v-if）：renderAsync 开口就要拿这两个节点。 -->
    <div v-show="rendered" ref="bodyEl" class="min-h-0 flex-1 overflow-auto"></div>
    <div v-show="false" ref="styleEl" aria-hidden="true"></div>
  </div>
</template>
