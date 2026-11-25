<script setup lang="ts">
// zip 只列目录（issue #795）：jszip.loadAsync 读中央目录 ⇒ 名字/是否目录/未压缩大小/时间。
// 刻意**不提供解压或单独下载某一项**：那需要第二个后端出口（单项流式解出），本阶段不做。
// 空压缩包给一行 t('preview.zipEmpty')（空列表和「读不出来」必须能区分开）。
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import JSZip from 'jszip';
import { useFileBytes } from '../composables/useFileBytes';

interface ZipEntryRow {
  name: string;
  dir: boolean;
  size: number | null;
  date: string;
}

const props = defineProps<{ cwd: string; path: string }>();
const emit = defineEmits<{ failed: [reason: 'too_large' | 'render_failed'] }>();
const { t } = useI18n();
const { load } = useFileBytes();
const entries = ref<ZipEntryRow[]>([]);
const parsed = ref(false);

/** 未压缩大小：jszip 的 d.ts 没公开 _data（运行时 loadAsync 会填），拿不到就 null。 */
function sizeOf(file: JSZip.JSZipObject): number | null {
  const raw = (file as unknown as { _data?: { uncompressedSize?: number } })._data;
  return typeof raw?.uncompressedSize === 'number' ? raw.uncompressedSize : null;
}

/** ISO 而非 toLocaleString：显示稳定、可断言，不受运行环境 locale 影响。 */
function dateOf(file: JSZip.JSZipObject): string {
  if (!file.date) return '';
  return file.date.toISOString().slice(0, 19).replace('T', ' ');
}

function fmtSize(n: number | null): string {
  if (n === null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

onMounted(async () => {
  const r = await load(props.cwd, props.path);
  if (!r.ok) {
    emit('failed', r.reason === 'too_large' ? 'too_large' : 'render_failed');
    return;
  }
  try {
    const zip = await JSZip.loadAsync(r.buffer);
    const rows: ZipEntryRow[] = [];
    zip.forEach((relPath, file) => {
      rows.push({ name: relPath, dir: file.dir, size: sizeOf(file), date: dateOf(file) });
    });
    rows.sort((a, b) => a.name.localeCompare(b.name));
    entries.value = rows;
    parsed.value = true;
  } catch {
    emit('failed', 'render_failed');
  }
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div v-if="!parsed" class="p-4 text-sm text-slate-500">{{ t('common.loading') }}</div>
    <div v-else-if="entries.length === 0" class="p-4 text-sm text-slate-500">
      {{ t('preview.zipEmpty') }}
    </div>
    <div v-else class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-xs">
        <thead>
          <tr class="bg-slate-100 text-left text-slate-600">
            <th class="border-b border-slate-200 px-3 py-1 font-medium">name</th>
            <th class="border-b border-slate-200 px-3 py-1 font-medium">
              {{ t('preview.zipSize') }}
            </th>
            <th class="border-b border-slate-200 px-3 py-1 font-medium">
              {{ t('preview.zipDate') }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in entries" :key="row.name" class="hover:bg-slate-50">
            <td class="border-b border-slate-100 px-3 py-1 font-mono break-all">
              {{ row.name }}<span v-if="row.dir" class="text-slate-400">/</span>
            </td>
            <td class="border-b border-slate-100 px-3 py-1 text-slate-500">
              {{ row.dir ? '—' : fmtSize(row.size) }}
            </td>
            <td class="border-b border-slate-100 px-3 py-1 text-slate-500">{{ row.date }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
