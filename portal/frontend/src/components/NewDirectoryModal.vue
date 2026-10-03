<script setup lang="ts">
// 「＋ 新建目录」modal（自 SidebarPanel 内联表单迁出）：遮罩 + 居中 dialog，不再挤在侧栏头部。
// 逻辑不变：DIR_NAME_RE 客户端校验 + store.createDir（服务端校验 + mkdir + 建首个会话）。
// 契约：emits created(sessionId) / close；错误展示在 modal 内，失败不关窗（可改名字重试）。
// 交互对齐 SessionPickerModal：Esc/点遮罩关闭、焦点进 dialog 归还触发按钮、锁背景滚动。
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';
import ModalShell from './ModalShell.vue';

// issue #101 P2：用户可见文案走 i18n（sidebar.* / common.*；代码注释保持中文原文）。
const { t } = useI18n();
const store = useWorkbenchStore();
const emit = defineEmits<{
  (e: 'created', sessionId: string): void;
  (e: 'close'): void;
}>();

// ---- 表单状态（原 SidebarPanel 内联表单逐字平移）----
const newDirName = ref('');
const newDirError = ref('');
const submitting = ref(false);
async function onSubmit() {
  if (submitting.value) return;
  newDirError.value = '';
  submitting.value = true;
  try {
    const { error, session } = await store.createDir(newDirName.value.trim());
    if (error) {
      newDirError.value = error;
      return;
    }
    if (session) emit('created', String(session.id)); // 路由 push 由视图统一处理
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <ModalShell :label="t('sidebar.newDirOption')" @close="emit('close')">
    <!-- 头：标题 + 关闭 -->
    <div class="flex items-center gap-2 border-b border-black/10 px-3 py-2">
      <span class="text-sm font-medium">{{ t('sidebar.newDirTitle') }}</span>
      <button
        type="button"
        :aria-label="t('common.close')"
        class="ml-auto shrink-0 rounded-md px-2 py-1 text-sm hover:bg-black/5"
        @click="emit('close')"
      >✕</button>
    </div>

    <!-- 表单体（原内联表单样式平移）：输入名字 → 以该 cwd 建会话，服务端校验 + mkdir -->
    <form class="px-3 py-3" novalidate @submit.prevent="onSubmit">
      <label class="muted" for="newDirName">{{ t('sidebar.newDirLabel') }}</label>
      <input
        id="newDirName" v-model="newDirName" required maxlength="63" :placeholder="t('sidebar.newDirPlaceholder')"
        class="w-full mt-1 rounded-md border border-black/20 px-2 py-1 text-sm"
      >
      <div class="flex gap-2 mt-3">
        <button
          type="submit"
          :disabled="submitting"
          class="flex-1 rounded-md bg-brand text-white text-sm px-2.5 py-1 hover:bg-brand-hover disabled:opacity-50"
        >{{ t('common.create') }}</button>
        <button type="button" class="flex-1 rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5" @click="emit('close')">{{ t('common.cancel') }}</button>
      </div>
      <p class="syserr mt-2" role="alert">{{ newDirError }}</p>
    </form>
  </ModalShell>
</template>
