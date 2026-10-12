<script setup lang="ts">
// composer（旧 #composer 平移）：发送/停止/禁用逻辑、Enter 发送（Shift+Enter 换行）。
// 失败回填输入与 llm_not_configured 409 指引在 store.send() 内（逐行平移）。
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

// issue #101 P2：用户可见文案走 i18n（composer.*；占位符来自 store.inputPlaceholder）。
const { t } = useI18n();
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
    <!-- issue #261B：一键「重试上一条」（R-2 演练 8 次 provider 超时杀 run，用户全部手打重发长消息）。
         三个条件全满足才出现（工单口径）：① 输入框为空——有草稿时绝不出现，避免「重试会不会吞我打的字」
         的歧义行为（store.retryLast() 同源再守一道）；② 无活跃 run；③ store.retryAvailable——上一条
         发送以 RUN_FAIL_REASONS 终局收场。in-flight（POST 往返窗口，此时 running 仍 false）禁用防双击双发。 -->
    <button
      v-if="!store.inputValue.trim() && !store.running && store.retryAvailable"
      class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
      :disabled="store.retryInFlight"
      @click="store.retryLast()"
    >{{ t('composer.retry') }}</button>
    <button
      class="rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white px-4 disabled:opacity-50"
      :disabled="store.sendDisabled"
      @click="store.send()"
    >{{ t('composer.send') }}</button>
    <!-- 停止按钮：运行中显示（旧 setRunning(on) 的显隐语义） -->
    <button
      v-if="store.running"
      class="rounded-md border border-red-600 text-red-600 px-4 hover:bg-red-50"
      @click="store.stop()"
    >{{ t('composer.stop') }}</button>
  </div>
</template>
