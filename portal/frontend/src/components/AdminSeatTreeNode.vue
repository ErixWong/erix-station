<script setup lang="ts">
// 管理台「工位内容」的目录树节点（issue #727 片 2，递归组件，按文件名自引用）。
// 结构参考 `DirTreeNode.vue`，但**不复用**它：那个组件把 URL 硬编码成 `/api/files/tree?cwd=`
// （用户面按 cwd 取数），而管理台是按 `fde` + 相对 `~/projects` 的 `path` 取数，
// 还多一件「该层被截断时用复合游标 `next_after` 翻页」的事。
// 状态（childMap/expanded/loading/truncated/highlight）由 AdminSeatContentView 持有并透传。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SeatTreeEntry } from '../stores/adminSeatContent';

// 行样式拆成两个常量（单行 ≤100 字节纪律）；高亮态用第三个，不新增颜色语义。
const CLS_NODE_ROW = 'flex w-full items-center gap-1 rounded px-1 py-[1px] text-left';
const CLS_NODE_TYPO = 'text-[12px] leading-[1.5] hover:bg-black/5';
const CLS_NODE_ON = 'bg-brand/10 font-semibold text-brand';

const props = defineProps<{
  entry: SeatTreeEntry;
  path: string; // 父路径（'' = 根层，实际根传 '.'）
  depth: number;
  childMap: Record<string, SeatTreeEntry[]>;
  expanded: Record<string, boolean>;
  loading: Record<string, boolean>;
  truncated: Record<string, boolean>;
  highlight: string | null;
  toggleDir: (key: string) => void;
  fileClick: (key: string) => void;
  loadMore: (key: string) => void;
  selectedFile: string | null;
}>();

const { t } = useI18n();

// 节点键 = 相对根（`~/projects`）的路径；根层子节点就是名字，嵌套为 a/b/c。
const nodeKey = computed(() => (props.path === '.' || props.path === ''
  ? props.entry.name
  : `${props.path}/${props.entry.name}`));
const isDir = computed(() => props.entry.type === 'dir');
const open = computed(() => props.expanded[nodeKey.value] === true);
const isHighlight = computed(() => props.highlight === nodeKey.value);
const isSelectedFile = computed(() => props.selectedFile === nodeKey.value);

function onClick(): void {
  if (isDir.value) props.toggleDir(nodeKey.value);
  else props.fileClick(nodeKey.value);
}
</script>

<template>
  <div>
    <button
      type="button"
      data-test="tree-node"
      :data-node-path="nodeKey"
      :data-highlight="isHighlight ? '1' : '0'"
      :class="[CLS_NODE_ROW, CLS_NODE_TYPO, isHighlight || isSelectedFile ? CLS_NODE_ON : '']"
      :style="{ paddingLeft: `${4 + props.depth * 14}px` }"
      @click="onClick"
    >
      <span class="shrink-0 text-[11px]">{{ isDir ? (open ? '📂' : '📁') : '📄' }}</span>
      <span class="truncate">{{ props.entry.name }}</span>
      <span v-if="props.loading[nodeKey]" class="text-[11px] text-black/50">…</span>
    </button>

    <div v-if="isDir && open">
      <p
        v-if="!props.loading[nodeKey] && !(props.childMap[nodeKey]?.length)"
        class="text-[11px] text-black/50"
        :style="{ paddingLeft: `${18 + props.depth * 14}px` }"
      >{{ t('admin.seatContent.files.empty') }}</p>
      <AdminSeatTreeNode
        v-for="child in props.childMap[nodeKey] ?? []"
        :key="`${nodeKey}/${child.name}`"
        :entry="child"
        :path="nodeKey"
        :depth="props.depth + 1"
        :child-map="props.childMap"
        :expanded="props.expanded"
        :loading="props.loading"
        :truncated="props.truncated"
        :highlight="props.highlight"
        :toggle-dir="props.toggleDir"
        :file-click="props.fileClick"
        :load-more="props.loadMore"
        :selected-file="props.selectedFile"
      />
      <!-- 该层被截断：用 `next_after` 复合游标续这一层（游标原样回传，不拆解） -->
      <button
        v-if="props.truncated[nodeKey]"
        type="button"
        data-test="tree-load-more"
        :data-node-path="nodeKey"
        class="text-[11px] underline"
        :style="{ paddingLeft: `${18 + props.depth * 14}px` }"
        @click="props.loadMore(nodeKey)"
      >{{ t('admin.seatContent.files.loadMore') }}</button>
    </div>
  </div>
</template>
