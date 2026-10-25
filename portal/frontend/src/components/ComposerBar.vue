<script setup lang="ts">
// composer（旧 #composer 平移）：发送/停止/禁用逻辑、Enter 发送（Shift+Enter 换行）。
// 失败回填输入与 llm_not_configured 409 指引在 store.send() 内（逐行平移）。
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

// issue #101 P2：用户可见文案走 i18n（composer.*；占位符来自 store.inputPlaceholder）。
const { t } = useI18n();
const store = useWorkbenchStore();
// issue #370：运行中说话（转向 / 排队）与队列条。空值提交由 store 兜底，按钮 disable 只是体验层。

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return;
  if (e.altKey) {
    // issue #370：Alt+Enter = 排队（照 pi ChatInput 的 alt+Enter → followUp）。必须先于 Shift 判：
    // 三键组合里 Alt 的语义要唯一，否则 macOS 上 Option+Enter 会落进「换行」那一支。
    e.preventDefault();
    void store.sendQueued('follow_up');
    return;
  }
  if (e.shiftKey) return; // 原生换行
  e.preventDefault();
  // issue #370：运行中 Enter = 转向，空闲 Enter = 发送。⚠ 这里选的只是**动作**（调哪个 action），
  // 「入队还是直发」的最终裁决永远在后端那个事务里（见 store.sendQueued 的注释）——前端判错
  // 最坏结果是多一次网络往返，绝不会把消息判丢。
  if (store.running) void store.sendQueued('steer');
  else void store.send();
}
</script>

<template>
  <!-- 上沿分隔线：有选中会话时由上方 RunStatusBar 的 border-t 提供（两者读作一块，不叠两条线）；
       无会话时状态条不挂 ⇒ composer 自己带线，免得与流区粘在一起 -->
  <div class="flex gap-2 p-2" :class="store.sessionId ? '' : 'border-t border-black/10'">
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
    <!-- issue #370：运行中发送键分裂成两个动作（对齐 agegr/pi-web ChatInput.tsx:802-825 的
         steer / follow_up 双按钮与 pi 的 Enter=steer、Alt+Enter=follow_up）。
         文案叫「转向」而不是「打断并转向」：轮边界语义与 pi 的 steer 一致，但 5 个字会在用户
         最需要按下它的那一刻把人吓住（理由全文见 portal.md §4.3a）。 -->
    <template v-if="store.running">
      <button
        data-queued-kind="steer"
        class="rounded-md bg-brand hover:bg-brand-hover active:bg-brand-active text-white px-4 disabled:opacity-50"
        :disabled="!store.inputValue.trim() || store.sendDisabled"
        :title="t('composer.steerHint')"
        @click="store.sendQueued('steer')"
      >{{ t('composer.steer') }}</button>
      <button
        data-queued-kind="follow_up"
        class="rounded-md border border-black/20 text-sm px-2.5 py-1 hover:bg-black/5 disabled:opacity-50"
        :disabled="!store.inputValue.trim() || store.sendDisabled"
        :title="t('composer.followUpHint')"
        @click="store.sendQueued('follow_up')"
      >{{ t('composer.followUp') }}</button>
    </template>
    <button
      v-else
      data-queued-kind="send"
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
