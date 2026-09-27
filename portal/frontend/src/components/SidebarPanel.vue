<script setup lang="ts">
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段；issue #92 改 aside 内 flex-col 三段布局）：
//   ① 固定头：目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷 + 末项「＋ 新建目录」
//      内联表单）+ 「＋ 新会话」按钮 + 🔍 查找会话（issue #94 入口②）——不随列表滚动
//   ② 会话列表段：flex-1 min-h-0 overflow-y-auto，独立内部滚动（空态文案「先创建目录」/
//      「暂无会话」/平台管理员提示也放这里）——列表再长也不推挤头与树；列表尾渲染
//      「显示最近 20 个」+「查看全部会话 →」（issue #94 入口①，仅 sessionsNextCursor 存在）
//      列表段顶部：深链打开的会话不在当前列表（如被「最近 20 个」截断）时，置顶「当前会话」卡（issue #94）
//   ③ 目录树面板（DirectoryTree，默认收起，懒展开）：固定底部，任意会话数下恒可达
// issue #94：SessionPickerModal（通用会话选择器，三入口共用）挂在本组件与 WorkbenchView。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价），
// 三段结构在抽屉内同样成立（aside 高度由 max-md:inset-y-0 撑满，h-full 生效）。
import { computed, ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench';
import type { Session } from '../stores/workbench';
import DirSelect from './DirSelect.vue';
import DirectoryTree from './DirectoryTree.vue';
import SessionPickerModal from './SessionPickerModal.vue';

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

// ---- issue #94：会话选择 modal（入口① 查看全部 / 入口② 固定头 🔍）----
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

// ---- issue #94：「当前会话」置顶卡——深链打开的会话不在当前目录列表（被「最近 20 个」截断等）
// 时给上下文；点击重开当前会话（与 issue #55 B4 的重开语义一致，路由 push/跨目录由视图处理）。
const pinnedCurrent = computed(() =>
  !!store.sessionId
  && !store.noDir // 列表已加载（有目录上下文）才算「不在列表」；无目录时列表本就未加载
  && !store.sessions.some((s) => String(s.id) === String(store.sessionId)),
);
// 列表外会话的标题/updated_at 未在 store 留存（数据流零改动）：合成占位 Session 仅供 sessMeta 取 meta。
const pinnedSession = computed<Session>(() => ({ id: String(store.sessionId) }));
const pinnedMeta = computed(() => {
  const s = pinnedSession.value;
  // 无 meta 信息时不渲染 1970 占位时间：有 active_run_id / updated_at 才出 meta 行
  return s.active_run_id || s.updated_at ? store.sessMeta(s) : '';
});

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
      >管理台</router-link>

      <!-- 目录下拉 + ↻ 双刷（issue #84 P5：替换原项目 select + 新项目表单） -->
      <DirSelect @refresh="onRefresh" @new-dir="onNewDirIntent" />

      <!-- 「＋ 新建目录」内联表单（输入名字 → 以该 cwd 建会话，服务端校验 + mkdir） -->
      <form v-if="showNewDir" class="mt-2" novalidate @submit.prevent="onSubmitNewDir">
        <label class="muted" for="newDirName">目录名（小写字母/数字/连字符）</label>
        <input
          id="newDirName" v-model="newDirName" required maxlength="63" placeholder="例如 my-project"
          class="w-full mt-1 rounded-md border border-black/20 px-2 py-1 text-sm"
        >
        <div class="flex gap-2 mt-2">
          <button type="submit" class="flex-1 rounded-md bg-brand text-white text-sm px-2.5 py-1 hover:bg-brand-hover">创建</button>
          <button type="button" class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5" @click="onCancelNewDir">取消</button>
        </div>
        <p class="syserr mt-2" role="alert">{{ newDirError }}</p>
      </form>

      <!-- 「＋ 新会话」+ 🔍 查找会话（issue #94 入口②：默认当前目录，无目录时全量） -->
      <div class="mt-3 flex gap-2">
        <button
          class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
          :disabled="store.newSessDisabled"
          @click="emit('new-session')"
        >＋ 新会话</button>
        <button
          type="button"
          title="查找会话"
          aria-label="查找会话"
          class="shrink-0 rounded-md border border-black/20 px-2.5 py-1 text-sm hover:bg-black/5"
          @click="openPicker(store.dirCwd ? 'cwd' : 'all')"
        >🔍</button>
      </div>
    </div>

    <!-- ② 会话列表段（该目录）：flex-1 min-h-0 + 独立内部滚动；空态文案也放这里（issue #92） -->
    <div class="mt-2 min-h-0 flex-1 overflow-y-auto">
      <div v-if="store.noDir">
        <p v-if="store.isPlatformAdmin" class="muted">
          平台管理员：请到管理台创建 FDE 用户与分配资源<br><router-link to="/admin" class="underline">进入管理台</router-link>
        </p>
        <p v-else class="muted">先创建目录</p>
      </div>
      <div v-else>
        <!-- issue #94：置顶卡在 v-for 之外、位于列表段最顶；空态（暂无会话）时也显示——
             此时它可能是列表里唯一一张卡。样式复用选中态（border-brand bg-green-50）。 -->
        <div
          v-if="pinnedCurrent"
          data-testid="pinned-current"
          class="mt-2 cursor-pointer rounded-md border px-2 py-1.5 text-sm border-brand bg-green-50"
          @click="emit('select-session', String(store.sessionId))"
        >
          <div>📌 当前会话</div>
          <div v-if="pinnedMeta" class="text-black/50 text-xs">{{ pinnedMeta }}</div>
        </div>
        <p v-if="store.sessions.length === 0" class="muted">暂无会话</p>
        <div
          v-for="s in store.sessions"
          :key="String(s.id)"
          class="mt-2 cursor-pointer rounded-md border border-black/15 px-2 py-1.5 text-sm"
          :class="String(s.id) === String(store.sessionId) ? 'border-brand bg-green-50' : 'hover:bg-black/5'"
          @click="emit('select-session', String(s.id))"
        >
          <div>{{ s.title || '未命名会话' }}</div>
          <div class="text-black/50 text-xs">{{ store.sessMeta(s) }}</div>
        </div>
        <!-- issue #94 入口①：仅截断时渲染（next_cursor 存在 = 该目录还有未展示的会话） -->
        <div v-if="store.sessionsNextCursor" class="mt-2 mb-1">
          <p class="text-black/50 text-xs">显示最近 20 个</p>
          <button
            type="button"
            class="mt-1 w-full rounded-md border border-black/20 px-2 py-1.5 text-sm text-brand hover:bg-black/5"
            @click="openPicker('cwd')"
          >查看全部会话 →</button>
        </div>
      </div>
    </div>

    <!-- ③ 目录树面板（默认收起，懒展开；节点点击暂无动作，P6 预览后补）：固定底部恒可达 -->
    <!-- shrink-0 经属性透传合并到 DirectoryTree 根元素，树展开再多条目也不缩列表段为负 -->
    <DirectoryTree ref="treeRef" class="shrink-0" :cwd="store.dirCwd" />

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
