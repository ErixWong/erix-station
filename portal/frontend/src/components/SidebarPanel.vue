<script setup lang="ts">
// 侧栏（portal/static/index.html 的 aside 平移）：项目 select、新项目表单（PROJECT_NAME_RE
// 校验 + 错误展示 + repo_url 可选）、＋新会话、会话列表（.sess/.active/.meta 语义 → Tailwind）。
// 移动端抽屉（≤768px）由父级 WorkbenchView 以 Tailwind max-md: 变体实现（旧 offcanvas 桥接的等价）。
import { ref } from 'vue';
import { useWorkbenchStore } from '../stores/workbench';

const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: 'select-session', id: string): void;
  (e: 'new-session'): void;
}>();

const showForm = ref(false); // 旧 newProjForm 的 display 开关
const name = ref('');
const repo = ref('');
const error = ref(''); // 旧 newProjErr

function onToggleForm() {
  showForm.value = true;
  error.value = '';
}
function onCancelForm() {
  name.value = '';
  repo.value = '';
  showForm.value = false;
  error.value = '';
}
async function onSubmitForm() {
  error.value = '';
  const err = await store.createProject(name.value.trim(), repo.value.trim());
  if (err) {
    error.value = err;
    return;
  }
  onCancelForm(); // 旧版 projectForm.reset() + 收起（含清除错误）
}
</script>

<template>
  <div>
    <!-- 项目区（旧 #projBox） -->
    <label class="muted" for="projectSel">项目</label>
    <select
      id="projectSel"
      class="w-full mt-1 rounded-md border border-black/20 bg-white px-2 py-1 text-sm"
      :value="String(store.projectId ?? '')"
      @change="store.switchProject(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="p in store.projects" :key="p.id" :value="String(p.id)">{{ p.name }}</option>
    </select>
    <div class="muted mt-1">{{ store.projectMeta }}</div>
    <button
      class="w-full mt-2 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
      :disabled="store.newProjDisabled"
      @click="onToggleForm"
    >＋ 新项目</button>

    <!-- 新项目表单（旧 #newProjForm；错误文案逐字保留） -->
    <form v-if="showForm" class="mt-2" novalidate @submit.prevent="onSubmitForm">
      <label class="muted" for="newProjName">项目名（小写字母/数字/连字符）</label>
      <input
        id="newProjName" v-model="name" required maxlength="63" placeholder="例如 my-project"
        class="w-full mt-1 rounded-md border border-black/20 px-2 py-1 text-sm"
      >
      <label class="muted mt-2" for="newProjRepo">关联仓库（可选）</label>
      <input
        id="newProjRepo" v-model="repo" placeholder="https://git.example/org/project.git"
        class="w-full mt-1 rounded-md border border-black/20 px-2 py-1 text-sm"
      >
      <div class="flex gap-2 mt-2">
        <button type="submit" class="flex-1 rounded-md bg-brand text-white text-sm px-2.5 py-1 hover:bg-brand-hover">创建</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5" @click="onCancelForm">取消</button>
      </div>
      <p class="syserr mt-2" role="alert">{{ error }}</p>
    </form>
  </div>

  <button
    class="w-full mt-3 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
    :disabled="store.newSessDisabled"
    @click="emit('new-session')"
  >＋ 新会话</button>

  <!-- 会话列表（旧 renderSessions 的 DOM → 声明式渲染） -->
  <div v-if="store.noProject" class="mt-2">
    <p v-if="store.isPlatformAdmin" class="muted">
      平台管理员：请到管理台创建 FDE 用户与分配资源<br><router-link to="/admin" class="underline">进入管理台</router-link>
    </p>
    <p v-else class="muted">先创建项目</p>
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
</template>
