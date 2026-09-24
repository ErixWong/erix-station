<script setup lang="ts">
// 侧栏（issue #84 P5.4，设计文档 §4 左栏竖排三段）：
//   ① 目录下拉（DirSelect：目录名 + ●N 运行态徽标 + ↻ 双刷 + 末项「＋ 新建目录」内联表单）
//   ② 会话列表（沿用现状组件语义，数据源改为 WHERE cwd = 选中目录）
//   ③ 目录树面板（DirectoryTree，默认收起，懒展开）
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价）。
import { ref } from 'vue';
import { useAuthStore } from '../stores/auth';
import { useWorkbenchStore } from '../stores/workbench';
import DirSelect from './DirSelect.vue';
import DirectoryTree from './DirectoryTree.vue';

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
  <!-- 常驻「管理台」入口（旧 index.html header adminLink 的 SPA 等价；admin 角色才显示） -->
  <router-link
    v-if="auth.user?.role === 'admin'"
    to="/admin"
    class="mb-2 block rounded-md border border-black/20 px-2.5 py-1 text-center text-sm hover:bg-black/5"
  >管理台</router-link>

  <!-- ① 目录下拉 + ↻ 双刷（issue #84 P5：替换原项目 select + 新项目表单） -->
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

  <!-- ② 会话列表（该目录） -->
  <button
    class="w-full mt-3 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
    :disabled="store.newSessDisabled"
    @click="emit('new-session')"
  >＋ 新会话</button>

  <div v-if="store.noDir" class="mt-2">
    <p v-if="store.isPlatformAdmin" class="muted">
      平台管理员：请到管理台创建 FDE 用户与分配资源<br><router-link to="/admin" class="underline">进入管理台</router-link>
    </p>
    <p v-else class="muted">先创建目录</p>
  </div>
  <div v-else>
    <p v-if="store.sessions.length === 0" class="muted mt-2">暂无会话</p>
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
  </div>

  <!-- ③ 目录树面板（默认收起，懒展开；节点点击暂无动作，P6 预览后补） -->
  <DirectoryTree ref="treeRef" :cwd="store.dirCwd" />
</template>
