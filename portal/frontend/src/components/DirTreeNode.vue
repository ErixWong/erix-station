<script setup lang="ts">
// 目录树节点（递归组件，按文件名自引用）：行缩进按 depth；目录点击展开/收起下一层
// （懒加载由父级 DirectoryTree.toggleNode 触发：点一级出一层）；文件/目录图标区分；
// 文件节点点击暂无动作（P6 预览后补，设计文档 §4/§7）。状态（childMap/expandedSet/loadingSet）
// 由 DirectoryTree 持有并透传，保证 ↻ 与切目录时全树归位。
import type { TreeEntry } from '../lib/tree';

const props = defineProps<TreeEntry & {
  path: string; // 父路径（'' = 根层）
  depth: number;
  childMap: Map<string, TreeEntry[]>;
  expandedSet: Set<string>;
  loadingSet: Set<string>;
  toggleNode: (pathKey: string) => void;
}>();

// 节点键 = 相对路径（根层子节点即名字；嵌套为 a/b/c）。节点生命周期内静态。
const nodeKey = props.path ? `${props.path}/${props.name}` : props.name;
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-black/5"
      :style="{ paddingLeft: 4 + props.depth * 14 + 'px' }"
      @click="props.type === 'dir' ? props.toggleNode(nodeKey) : undefined"
    >
      <span class="shrink-0">{{ props.type === 'dir' ? (props.expandedSet.has(nodeKey) ? '📂' : '📁') : '📄' }}</span>
      <span class="truncate">{{ props.name }}</span>
      <span v-if="props.loadingSet.has(nodeKey)" class="muted text-xs">…</span>
    </button>
    <div v-if="props.type === 'dir' && props.expandedSet.has(nodeKey)">
      <template v-if="!props.loadingSet.has(nodeKey)">
        <p
          v-if="!props.childMap.get(nodeKey)?.length"
          class="muted text-xs"
          :style="{ paddingLeft: 18 + props.depth * 14 + 'px' }"
        >（空目录）</p>
        <DirTreeNode
          v-for="c in props.childMap.get(nodeKey) ?? []"
          :key="nodeKey + '/' + c.name"
          v-bind="c"
          :path="nodeKey"
          :depth="props.depth + 1"
          :child-map="props.childMap"
          :expanded-set="props.expandedSet"
          :loading-set="props.loadingSet"
          :toggle-node="props.toggleNode"
        />
      </template>
    </div>
  </div>
</template>
