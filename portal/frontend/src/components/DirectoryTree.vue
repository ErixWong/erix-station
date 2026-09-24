<script setup lang="ts">
// 目录树面板（issue #84 P5.4，设计文档 §4 左下段）：默认收起（▸ 目录树）；展开后按
// GET /api/files/tree?cwd=&path= 懒加载单层列表——初始只有根一层，点某目录项展开下一层；
// 不跨刷新记忆，reload()（↻ 按钮路径）后回到全折叠；切换 cwd 时树自动归位。
// 根 = 选中目录（= 会话 cwd = jail root，三锚合一）；节点点击暂无动作（P6 预览后补）。
import { ref, shallowReactive, watch } from 'vue';
import { api } from '../api';
import type { TreeEntry } from '../lib/tree';
import DirTreeNode from './DirTreeNode.vue';

const props = defineProps<{ cwd: string | null }>();

const open = ref(false); // 面板展开开关（默认收起）
const childMap = shallowReactive(new Map<string, TreeEntry[]>()); // pathKey → 单层条目
const expandedSet = shallowReactive(new Set<string>()); // 已展开目录（pathKey）
const loadingSet = shallowReactive(new Set<string>()); // 加载中的 pathKey
const error = ref('');

async function load(path: string) {
  if (!props.cwd) return;
  loadingSet.add(path);
  try {
    const data = await api<{ entries?: TreeEntry[] }>(
      `/api/files/tree?cwd=${encodeURIComponent(props.cwd)}&path=${encodeURIComponent(path)}`,
    );
    childMap.set(path, data.entries ?? []);
  } catch (e) {
    expandedSet.delete(path); // 加载失败：展开态回滚，错误行留在面板顶部
    error.value = '目录树加载失败：' + (e instanceof Error ? e.message : String(e));
  } finally {
    loadingSet.delete(path);
  }
}

/** 目录节点点击：展开/收起；首次展开触发下一层懒加载（点一级出一层）。 */
function toggleNode(pathKey: string) {
  error.value = '';
  if (expandedSet.has(pathKey)) {
    expandedSet.delete(pathKey);
    return;
  }
  expandedSet.add(pathKey);
  if (!childMap.has(pathKey)) void load(pathKey);
}

/** ↻ 双刷之一：清缓存与展开态（全折叠）；面板若开着则重载根层。SidebarPanel 经 ref 调用。 */
function reload() {
  childMap.clear();
  expandedSet.clear();
  loadingSet.clear();
  error.value = '';
  if (open.value) void load('');
}
defineExpose({ reload });

// 切目录：树归位（全折叠 + 清缓存），新目录的根层在面板下次展开时加载。
watch(() => props.cwd, () => reload());
// 首次展开面板：加载根层（path=''）。
watch(open, (v) => { if (v && !childMap.has('') && !loadingSet.has('')) void load(''); });
</script>

<template>
  <div class="mt-3 border-t border-black/10 pt-2">
    <button
      type="button"
      class="w-full rounded px-1 py-1 text-left text-sm hover:bg-black/5"
      @click="open = !open"
    >{{ open ? '▾' : '▸' }} 目录树</button>
    <div v-if="open" class="mt-1 text-sm">
      <p v-if="!cwd" class="muted px-1 text-xs">先选择目录</p>
      <p v-else-if="error" class="syserr px-1 text-xs" role="alert">{{ error }}</p>
      <template v-else>
        <p v-if="loadingSet.has('')" class="muted px-1 text-xs">加载中…</p>
        <p v-else-if="!childMap.get('')?.length" class="muted px-1 text-xs">（空目录）</p>
        <DirTreeNode
          v-for="e in childMap.get('') ?? []"
          :key="e.name"
          v-bind="e"
          path=""
          :depth="0"
          :child-map="childMap"
          :expanded-set="expandedSet"
          :loading-set="loadingSet"
          :toggle-node="toggleNode"
        />
      </template>
    </div>
  </div>
</template>
