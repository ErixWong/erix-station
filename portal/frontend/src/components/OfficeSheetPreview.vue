<script setup lang="ts">
// xlsx / xls 前端渲染（issue #795）：SheetJS 解析成 workbook，当前表用 sheet_to_html 出表格。
// v-html 的依据（照抄进注释，别顺手改成字符串拼接）：SheetJS 的 sheet_to_html 对**每个单元格
// 文本做 HTML 转义**（内部 escapeHTML 处理 v/m/f），所以单元格里的 <script>/<img onerror>
// 只会显示成文本，不会成为标签——表格内容不是可信 HTML，这条转义是我们敢 v-html 的前提。
// 多 sheet 才显示标签栏：单 sheet 文件挂一个孤立标签是噪声。
import { computed, onMounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import * as XLSX from 'xlsx';
import { useFileBytes } from '../composables/useFileBytes';

const props = defineProps<{ cwd: string; path: string }>();
const emit = defineEmits<{ failed: [reason: 'too_large' | 'render_failed'] }>();
const { t } = useI18n();
const { load } = useFileBytes();
// shallowRef：workbook 是几千个 cell 对象的深层结构，深层响应式代理既慢又没必要。
const book = shallowRef<XLSX.WorkBook | null>(null);
const names = shallowRef<string[]>([]);
const active = ref(0);
const ready = computed(() => book.value !== null);
const tableHtml = computed(() => {
  const b = book.value;
  if (!b) return '';
  const sheet = b.Sheets[names.value[active.value]];
  // header/footer 传空串：只要 <table>，不要 SheetJS 默认包的 <html>/<head>。
  return sheet ? XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' }) : '';
});

/** 表格皮肤（v-html 的内容拿不到 scoped 样式，故走 tailwind 的任意变体选择器）。 */
const TABLE_CLASS = [
  'min-h-0 flex-1 overflow-auto',
  '[&_table]:w-max [&_table]:border-collapse [&_table]:text-xs',
  '[&_td]:border [&_td]:border-slate-200 [&_td]:px-2 [&_td]:py-1 [&_td]:align-top',
  '[&_th]:border [&_th]:border-slate-300 [&_th]:bg-slate-100 [&_th]:px-2 [&_th]:py-1',
].join(' ');

onMounted(async () => {
  const r = await load(props.cwd, props.path);
  if (!r.ok) {
    emit('failed', r.reason === 'too_large' ? 'too_large' : 'render_failed');
    return;
  }
  try {
    const parsed = XLSX.read(r.buffer, { type: 'array' });
    if (!parsed.SheetNames.length) {
      emit('failed', 'render_failed');
      return;
    }
    book.value = parsed;
    names.value = [...parsed.SheetNames];
    active.value = 0;
  } catch {
    emit('failed', 'render_failed');
  }
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="!ready" class="p-4 text-sm text-slate-500">{{ t('common.loading') }}</div>
    <template v-if="ready">
      <div
        v-if="names.length > 1"
        class="flex shrink-0 flex-wrap gap-1 border-b border-slate-200 bg-slate-50 px-2 pt-1"
        role="tablist"
      >
        <button
          v-for="(name, i) in names"
          :key="name"
          type="button"
          role="tab"
          :aria-selected="i === active"
          class="rounded-t border border-b-0 px-2 py-1 text-xs"
          :class="i === active
            ? 'border-slate-300 bg-white font-medium text-slate-900'
            : 'border-transparent text-slate-500 hover:text-slate-800'"
          @click="active = i"
        >{{ name }}</button>
      </div>
      <div :class="TABLE_CLASS" v-html="tableHtml"></div>
    </template>
  </div>
</template>
