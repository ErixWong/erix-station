<script setup lang="ts">
// 目录下拉（issue #84 P5.4）：替换原「项目下拉」。数据源 GET /api/dirs（~/projects/ 一级
// 目录 + running/queued 计数）；选项 = 目录名 + 运行态徽标（●N，N=running+queued，0 不显）；
// 末项「＋ 新建目录」选中即弹内联表单（SidebarPanel 承接）；↻ 一次双刷（/api/dirs + 目录树）。
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore, type DirInfo } from '../stores/workbench';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*）。
const { t } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: 'refresh'): void;
  (e: 'new-dir'): void;
}>();

/** 运行态徽标数：跨目录活跃感知的唯一入口（设计文档 §4）。 */
function badge(d: DirInfo): number {
  return (d.running_count ?? 0) + (d.queued_count ?? 0);
}

function onChange(e: Event) {
  const el = e.target as HTMLSelectElement;
  const v = el.value;
  if (v === '__new__') {
    el.value = store.dirCwd ?? ''; // 下拉弹回当前选中，表单位置由 SidebarPanel 渲染
    emit('new-dir');
    return;
  }
  if (v && v !== store.dirCwd) store.selectDir(v);
}
</script>

<template>
  <div class="flex items-center gap-1">
    <label class="muted shrink-0" for="dirSel">{{ t('sidebar.dirLabel') }}</label>
    <select
      id="dirSel"
      class="flex-1 min-w-0 rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
      :value="store.dirCwd ?? ''"
      @change="onChange"
    >
      <option v-if="store.dirs.length === 0" value="">{{ t('common.noDir') }}</option>
      <option v-for="d in store.dirs" :key="d.cwd" :value="d.cwd">
        {{ d.name }}<template v-if="badge(d) > 0"> ●{{ badge(d) }}</template>
      </option>
      <option value="__new__" :disabled="store.newDirDisabled">{{ t('sidebar.newDirOption') }}</option>
    </select>
    <!-- ↻ 单按钮双刷：store.refreshDirs()（/api/dirs）+ DirectoryTree.reload()（目录树），SidebarPanel 组装 -->
    <button
      type="button"
      :title="t('sidebar.refreshTitle')"
      class="shrink-0 rounded-md border border-black/20 px-2 py-1 text-sm hover:bg-black/5"
      @click="emit('refresh')"
    >↻</button>
  </div>
</template>
