<script setup lang="ts">
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
//   ① 固定头：目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷 + 末项「＋ 新建目录」
//      内联表单）+ 「＋ 新会话」按钮 + 🔍 浏览会话（issue #94 入口；Ctrl/⌘+K 同语义）——不随列表滚动
//   ② 会话列表段：flex-1 min-h-0 overflow-y-auto，独立内部滚动（空态文案「先创建目录」/
//      「暂无会话」/平台管理员提示也放这里）——列表再长也不推挤头与树
//   ③ 目录树面板（DirectoryTree，默认收起，懒展开）：固定底部，任意会话数下恒可达
// issue #94（评审裁决瘦身版）：SessionPickerModal（单次全量浏览）挂在本组件与 WorkbenchView。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价），
// 三段结构在抽屉内同样成立（aside 高度由 max-md:inset-y-0 撑满，h-full 生效）。
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useAuthStore } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench';
import DirSelect from './DirSelect.vue';
import DirectoryTree from './DirectoryTree.vue';
import FilePreviewModal from './FilePreviewModal.vue';
import SessionPickerModal from './SessionPickerModal.vue';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const auth = useAuthStore();
const emit = defineEmits<{
  (e: 'select-session', id: string): void;
  (e: 'new-session'): void;
}>();

// ---- ↻ 单按钮双刷：/api/dirs（store.refreshDirs）+ 目录树（组件 reload → 全折叠重载根层）----
const treeRef = ref<InstanceType<typeof DirectoryTree> | null>(null);
function onRefresh() {
  void store.refreshDirs().catch(() => { /* loadDirs 失败静默：下拉保留旧数据，下次刷新重试 */ });
  treeRef.value?.reload();
}

// ---- issue #84 P6：目录树文件点击 → 文件预览 modal（cwd 上下文 = store.dirCwd）----
const previewTarget = ref<{ cwd: string; path: string } | null>(null);
function onFileClick(path: string) {
  if (!store.dirCwd) return; // 无目录时树面板本不可交互，防御性兜底
  previewTarget.value = { cwd: store.dirCwd, path };
}

// ---- issue #94：会话选择 modal（固定头 🔍 入口；Ctrl/⌘+K 由 WorkbenchView 提供）----
const pickerOpen = ref(false);
const pickerScope = ref<'cwd' | 'all'>('cwd');
function openPicker(scope: 'cwd' | 'all') {
  pickerScope.value = scope;
  pickerOpen.value = true;
}
function onPickerSelect(id: string) {
  pickerOpen.value = false;
  emit('select-session', id); // 路由 push/跨目录逻辑由视图 onSelectSession 统一处理
}

// ---- 「＋ 新建目录」内联表单（DIR_NAME_RE 校验 + 错误展示；创建成功后打开新会话）----
const showNewDir = ref(false);
const newDirName = ref('');
const newDirError = ref('');
function onNewDirIntent() {
  showNewDir.value = true;
  newDirError.value = '';
}
function onCancelNewDir() {
  newDirName.value = '';
  showNewDir.value = false;
  newDirError.value = '';
}
async function onSubmitNewDir() {
  newDirError.value = '';
  const { error, session } = await store.createDir(newDirName.value.trim());
  if (error) {
    newDirError.value = error;
    return;
  }
  onCancelNewDir();
  if (session) emit('select-session', String(session.id)); // 新目录 + 首个会话：路由 push 由视图做
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- issue #92：aside 内 flex-col 三段（固定头 / 列表独立滚 / 树固定底）；h-full 铺满 aside 高 -->
    <!-- ⚠️ 根级不放注释：注释+元素会被 Vue 3 编成多根 fragment（禁用属性透传，也破坏单根断言） -->
    <!-- ① 固定头：不随会话列表滚动 -->
    <div class="shrink-0">
      <!-- 常驻「管理台」入口（旧 index.html header adminLink 的 SPA 等价；admin 角色才显示） -->
      <router-link
        v-if="auth.user?.role === 'admin'"
        to="/admin"
        class="mb-2 block rounded-md border border-black/20 px-2.5 py-1 text-center text-sm hover:bg-black/5"
      >{{ t('common.adminConsole') }}</router-link>

      <!-- 目录下拉 + ↻ 双刷（issue #84 P5：替换原项目 select + 新项目表单） -->
      <DirSelect @refresh="onRefresh" @new-dir="onNewDirIntent" />

      <!-- 「＋ 新建目录」内联表单（输入名字 → 以该 cwd 建会话，服务端校验 + mkdir） -->
      <form v-if="showNewDir" class="mt-2" novalidate @submit.prevent="onSubmitNewDir">
        <label class="muted" for="newDirName">{{ t('sidebar.newDirLabel') }}</label>
        <input
          id="newDirName" v-model="newDirName" required maxlength="63" :placeholder="t('sidebar.newDirPlaceholder')"
          class="w-full mt-1 rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <div class="flex gap-2 mt-2">
          <button type="submit" class="flex-1 rounded-md bg-brand text-white text-sm px-2.5 py-1 hover:bg-brand-hover">{{ t('common.create') }}</button>
          <button type="button" class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5" @click="onCancelNewDir">{{ t('common.cancel') }}</button>
        </div>
        <p class="syserr mt-2" role="alert">{{ newDirError }}</p>
      </form>

      <!-- 「＋ 新会话」+ 🔍 浏览会话（issue #94：默认当前目录，无目录时全量；Ctrl/⌘+K 同语义） -->
      <div class="mt-3 flex gap-2">
        <button
          class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
          :disabled="store.newSessDisabled"
          @click="emit('new-session')"
        >{{ t('sidebar.newSession') }}</button>
        <button
          type="button"
          :title="t('sidebar.browseTitle')"
          :aria-label="t('sidebar.browse')"
          class="shrink-0 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
          @click="openPicker(store.dirCwd ? 'cwd' : 'all')"
        >🔍</button>
      </div>
    </div>

    <!-- ② 会话列表段（该目录）：flex-1 min-h-0 + 独立内部滚动；空态文案也放这里（issue #92） -->
    <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
      <div v-if="store.noDir">
        <p v-if="store.isPlatformAdmin" class="muted">
          {{ t('common.platformAdminHint') }}<br><router-link to="/admin" class="underline">{{ t('common.goToAdmin') }}</router-link>
        </p>
        <p v-else class="muted">{{ t('common.createFirstDir') }}</p>
      </div>
      <div v-else>
        <p v-if="store.sessions.length === 0" class="muted">{{ t('sidebar.noSessions') }}</p>
        <div
          v-for="s in store.sessions"
          :key="String(s.id)"
          class="mt-2 cursor-pointer rounded-md border border-black/15 px-2 py-1.5 text-sm"
          :class="String(s.id) === String(store.sessionId) ? 'border-brand bg-green-50' : 'hover:bg-black/5'"
          @click="emit('select-session', String(s.id))"
        >
          <div>{{ s.title || t('common.unnamedSession') }}</div>
          <div class="text-black/50 text-xs">{{ store.sessMeta(s) }}</div>
        </div>
      </div>
    </div>

    <!-- ③ 目录树面板（默认收起，懒展开；文件点击 → P6 预览 modal）：固定底部恒可达 -->
    <!-- shrink-0 经属性透传合并到 DirectoryTree 根元素，树展开再多条目也不缩列表段为负；
         max-h-[40vh] + overflow-y-auto：树面板自身限高内部滚动，不无限侵占侧栏高度（issue #92） -->
    <DirectoryTree ref="treeRef" class="shrink-0 max-h-[40vh] overflow-y-auto" :cwd="store.dirCwd" @file-click="onFileClick" />

    <!-- issue #84 P6：文件预览 modal（v-if 挂载：打开才发 /api/file，关闭即卸载归还焦点） -->
    <FilePreviewModal
      v-if="previewTarget"
      :cwd="previewTarget.cwd"
      :path="previewTarget.path"
      @close="previewTarget = null"
    />

    <!-- issue #94：会话选择 modal（teleport 无必要——侧栏抽屉/桌面布局下 fixed 遮罩均覆盖全屏） -->
    <SessionPickerModal
      v-if="pickerOpen"
      :scope="pickerScope"
      :cwd="store.dirCwd ?? undefined"
      @select="onPickerSelect"
      @close="pickerOpen = false"
    />
  </div>
</template>
