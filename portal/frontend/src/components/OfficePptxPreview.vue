<script setup lang="ts">
// pptx 前端渲染（issue #795）：pptx-preview 的 init(el, {width,height}) + preview(ArrayBuffer)。
// ⚠ 卸载时只能清空容器：库的 d.ts 声明了 destroy()，但 1.0.7 的**运行时产物里没有这个实现**
//   （dist/pptx-preview.es.js 中 "destroy" 只作为内部事件名出现，prototype 上没挂方法），
//   调用会 TypeError ⇒ 该库对我们等同「无 destroy API」，容器 innerHTML 清空即随组件一起没。
// 排版保真度不承诺（复杂母版/动画可能走形）：渲染不了或结果不对时由模态框统一降级到下载。
import { onBeforeUnmount, onMounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { init } from 'pptx-preview';
import { useFileBytes } from '../composables/useFileBytes';

const props = defineProps<{ cwd: string; path: string }>();
const emit = defineEmits<{ failed: [reason: 'too_large' | 'render_failed'] }>();
const { t } = useI18n();
const hostEl = useTemplateRef<HTMLDivElement>('hostEl');
const rendered = ref(false);
const { load } = useFileBytes();
// 只留住句柄以便卸载时断引用；不碰它的其它方法（见顶部关于 destroy 的结论）。
let viewer: ReturnType<typeof init> | null = null;

onMounted(async () => {
  const r = await load(props.cwd, props.path);
  if (!r.ok) {
    emit('failed', r.reason === 'too_large' ? 'too_large' : 'render_failed');
    return;
  }
  const el = hostEl.value;
  if (!el) return;
  try {
    viewer = init(el, { width: 960, height: 540 });
    await viewer.preview(r.buffer);
    rendered.value = true;
  } catch {
    emit('failed', 'render_failed');
  }
});

onBeforeUnmount(() => {
  if (hostEl.value) hostEl.value.innerHTML = '';
  viewer = null;
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="!rendered" class="p-4 text-sm text-slate-500">{{ t('common.loading') }}</div>
    <!-- 宿主留在 DOM 里（v-show）：init 要拿这个节点建 wrapper。 -->
    <div v-show="rendered" ref="hostEl" class="min-h-0 flex-1 overflow-auto"></div>
  </div>
</template>
