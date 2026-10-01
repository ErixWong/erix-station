<script setup lang="ts">
// 目录下拉（issue #84 P5.4）：替换原「项目下拉」。数据源 GET /api/dirs（~/projects/ 一级
// 目录 + running/queued 计数）；选项 = 目录名 + 运行态徽标（●N，N=running+queued，0 不显）；
// 末项「＋ 新建目录」选中即弹 NewDirectoryModal；↻ 一次双刷（/api/dirs + 目录树）。
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
    el.value = store.dirCwd ?? ''; // 下拉弹回当前选中，modal 由 SidebarPanel 挂载
    emit('new-dir');
    return;
  }
  if (v && v !== store.dirCwd) store.selectDir(v);
}
</script>

<template>
  <!-- issue #112：控件收敛——32px 高 / 7px 圆角 / 12px 字号（label 11px）；仅 class 变动，交互不动 -->
  <div class="flex items-center gap-1">
    <label class="shrink-0 text-[11px] text-black/50" for="dirSel">{{ t('sidebar.dirLabel') }}</label>
    <select
      id="dirSel"
      class="h-8 min-w-0 flex-1 rounded-[7px] border border-black/20 bg-white px-2 text-[12px]"
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
      class="h-8 w-8 shrink-0 rounded-[7px] border border-black/20 bg-black/[.03] text-[12px] hover:bg-black/10"
      @click="emit('refresh')"
    >↻</button>
  </div>
</template>
