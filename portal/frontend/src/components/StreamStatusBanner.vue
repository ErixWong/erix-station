<script setup lang="ts">
// issue #867：实时流（SSE）断线状态条。
//
// 要治的是「部分打开」：切会话时历史正文先上屏、实时流后开，开流这一步失败（网络抖、代理拦、
// portal 重启）时**正文照常在、界面看着一切正常**，但用户再也收不到新消息，而且没有任何提示。
// 所以这条面只回答一个问题：「现在还收得到新消息吗」。
//
// 中性面（判据 1）：不是弹窗、不是告警红——灰底灰字一句状态词。理由：历史正文仍在屏上、
// 用户没有丢任何东西，把界面打成故障色会说他没丢的东西丢了。措辞口径在 i18n（`stream.status.*`）。
//
// 正文不动（判据 1）：本组件**只读** `store.streamStatus`，不写任何消息态；重连走 store 的
// `reconnectStream()`（带本地水位重开，缺的那段由服务端补发接上，见 §5.2）。
//
// 落点：消息流下方、`RunStatusBar` 上方（读序「还收不收得到 → 在跑什么 → 排队说什么 → 输入框」）。
// 无选中会话时不挂（没有流可说）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore } from '../stores/workbench';

const { t } = useI18n();
const store = useWorkbenchStore();

const status = computed(() => store.streamStatus);
// `connected` 时整条面不渲染（正常态不该占一行）；其余两态都出，措辞与颜色分开：
// `reconnecting` = 浏览器/我们自己还在试；`disconnected` = 已经不再试了，要点那颗按钮。
const visible = computed(() => store.sessionId !== null && status.value !== 'connected');
const isReconnecting = computed(() => status.value === 'reconnecting');
</script>

<template>
  <div
    v-if="visible"
    data-testid="stream-status-banner"
    :data-stream-status="status"
    role="status"
    aria-live="polite"
    class="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-black/10 bg-slate-50 px-3 py-1.5 text-xs text-slate-600"
  >
    <!-- 状态点：中性灰，**不许**用红/黄（那不是告警，是状态） -->
    <span class="inline-block h-1.5 w-1.5 rounded-full bg-slate-400" aria-hidden="true" />
    <span data-testid="stream-status-text">{{ t(isReconnecting ? 'stream.status.reconnecting' : 'stream.status.disconnected') }}</span>
    <span data-testid="stream-status-hint" class="text-black/45">
      {{ t(isReconnecting ? 'stream.status.reconnectingHint' : 'stream.status.disconnectedHint') }}
    </span>
    <!-- 两个态都给手动入口：`reconnecting` 那一支浏览器的自动重试是固定间隔的平推，
         卡在代理/半开连接上时用户可以自己踢一脚（重开一条新流，不影响已渲染正文）。 -->
    <button
      type="button"
      data-testid="stream-status-reconnect"
      class="ml-auto rounded border border-black/20 px-1.5 py-0.5 text-slate-700 hover:bg-black/5"
      @click="store.reconnectStream()"
    >{{ t('stream.status.reconnect') }}</button>
  </div>
</template>
