<script setup lang="ts">
// composer（旧 #composer 平移）：发送/停止/禁用逻辑、Enter 发送（Shift+Enter 换行）。
// 失败回填输入与 llm_not_configured 409 指引在 store.send() 内（逐行平移）。
import { useWorkbenchStore } from '../stores/workbench';

const store = useWorkbenchStore();

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    store.send();
  }
}
</script>

<template>
  <div class="flex gap-2 border-t border-black/10 p-2">
    <textarea
      v-model="store.inputValue"
      class="flex-1 rounded-md border border-black/20 px-3 py-1.5 resize-none focus:outline-none focus:ring-2 focus:ring-brand/40 focus:border-brand"
      style="height: 3.2rem"
      :placeholder="store.inputPlaceholder"
      :disabled="store.noDir"
      @keydown="onKeydown"
    ></textarea>
    <button
      class="rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white px-4 disabled:opacity-50"
      :disabled="store.sendDisabled"
      @click="store.send()"
    >发送</button>
    <!-- 停止按钮：运行中显示（旧 setRunning(on) 的显隐语义） -->
    <button
      v-if="store.running"
      class="rounded-md border border-red-600 text-red-600 px-4 hover:bg-red-50"
      @click="store.stop()"
    >■ 停止</button>
  </div>
</template>
