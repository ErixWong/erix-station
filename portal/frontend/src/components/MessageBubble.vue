<script setup lang="ts">
// issue #816 第④b步：**消息气泡的渲染本体**——从 `StreamPanel.vue` 的 `en.kind === 'msg'` 那一块
// **逐字搬出**（类名 / 时刻 / markdown 路径一字未改），于是**主对话的流**与**折叠「查看原文」**共用
// 同一份实现。口径（#816）：历史呈现的**永远是未折叠原文**，折叠只作用于模型上下文 ⇒ 展开原文的
// 正文必须与主对话同款气泡，而不是「角色标签 + 一段文本块」。
// `msgClass` / `msgTime` 两个纯函数只有这一份（宿主不许再各写一份）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
// issue #282 A：消息时刻（`created_at` 缺失/脏值 ⇒ 整段 `<time>` 不出，见 lib 的注释）。
import { formatMessageTime } from '../lib/messageTime';
// mermaid 图渲染（参考 pi-web MermaidBlock）：v-html 落定后对 ```mermaid 块做 DOM 后处理。
import { vMermaid } from '../directives/mermaid';

// `html` = 已渲染好的 markdown（**调用方渲染**，本组件不引入第二套 markdown 逻辑）；
// `text` = 纯文本兜底（`{{ }}` 插值等价 textContent，XSS 由 Vue 转义负责）。
const props = defineProps<{
  role: string;              // 'user' | 'assistant' | 'system'
  synthetic?: boolean;
  createdAt?: string;        // 有就画时刻（口径同 issue #282 A）
  html?: string | null;      // 已渲染好的 markdown（主对话走这条）
  text?: string;             // 纯文本兜底
  // issue #243：终局正文是被文本化的工具调用（run 仍正常结束）⇒ 气泡上带一行**中性**状态词。
  // 中性而非报错：不抢 .syserr 红底、不说「错误/失败」；run 正常结束，这是「报告可能不完整」。
  textualized?: boolean;
}>();

const { t, locale } = useI18n();

// 旧 StreamPanel 的 `msgClass`：`msg ${role}`（+ ` synthetic`、+ ` md` 仅当有 markdown）
const bubbleClass = computed(() => {
  let cls = 'msg ' + props.role;
  if (props.synthetic) cls += ' synthetic';
  if (props.html) cls += ' md';
  return cls;
});

/**
 * issue #282 A：消息时刻文本。`createdAt` 缺失/脏值 ⇒ `''`（模板 `v-if` 整段不出），
 * 绝不把 `undefined` / `Invalid Date` / `NaN` 渲染上屏（格式化规则见 `lib/messageTime.ts`）。
 */
const timeText = computed(() => formatMessageTime(props.createdAt, locale.value));
</script>

<template>
  <div :class="bubbleClass">
    <!-- issue #282 A：每条消息（用户与助手都算）显示时刻；DTO 没给 created_at 就整段不出 -->
    <time
      v-if="timeText"
      class="msg-time block text-right text-[11px] leading-none text-black/35"
      :datetime="createdAt"
      :title="t('runStatus.messageTimeTitle')"
    >{{ timeText }}</time>
    <div v-if="html" v-mermaid v-html="html"></div>
    <template v-else>{{ text }}</template>
    <!-- issue #243：中性状态行（有 textualized 才出）。非红、非告警底色，只一句「机器标记 / 可能不完整」的状态词，
         与 .partial 那行同一视觉等级（text-black/45），不进红色 .syserr 语义。 -->
    <div
      v-if="textualized"
      class="msg-textualized mt-0.5 text-xs text-black/45"
      data-test="textualized-notice"
      :title="t('stream.textualized.hint')"
    >{{ t('stream.textualized.label') }}</div>
  </div>
</template>
