<script setup lang="ts">
// issue #816 第④步a：折叠「查看原文」的**渲染本体**——从 `StreamPanel.vue` 的 folded 横幅里
// **原样搬出**（类名 / 结构 / 文案一字未改），于是旧横幅与 #816 的折叠面板共用**同一份实现**：
// 可见性与「查看原文 / 收起原文」按钮仍归宿主（横幅的展开态、面板的逐行展开态各不相同），
// 这里只画「有 state 之后那段原文」。**不许**在这里改文案或加第二份渲染逻辑（#384/#387 的口径见下方注释）。
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { renderMarkdown } from '../lib/markdown';
import { getToolResultSummary } from '../lib/toolSummary';
import type { FoldedInfo, FoldedOriginalState, FoldedOriginalTurn } from '../stores/workbench';
import type { FoldEntry } from '../lib/foldIndex';

// `fold` 是那条折叠本身（横幅的 FoldedInfo / 面板行的 FoldEntry 两种来源）：渲染只吃 `state`，
// 带着它是为了让宿主少造上下文、也让这段渲染将来要按折叠分级时不必再改签名。
const props = defineProps<{ state: FoldedOriginalState; fold?: FoldedInfo | FoldEntry | null }>();

// 错误分支里的「重试」：怎么重拉是宿主的事（横幅拿 entry 的 sessionId/轮号，面板拿 store.sessionId）。
const emit = defineEmits<{ (e: 'retry'): void }>();

const { t } = useI18n();

// 变体收窄留在 script：模板里只留插值，四态判断与可选键（#375 的 truncated/droppedMessages）都在此归一。
const turns = computed<FoldedOriginalTurn[]>(() => (props.state.status === 'loaded' ? props.state.turns : []));
const truncated = computed(() => props.state.status === 'loaded' && props.state.truncated === true);
const droppedMessages = computed(() => (props.state.status === 'loaded' ? props.state.droppedMessages : undefined));
const errorMessage = computed(() => (props.state.status === 'error' ? props.state.message : ''));

// issue #387：原文里工具行的「返回了什么」。走 `getToolResultSummary` 而不是直接拼字符串：
// 上游结果有三套形态（string / `{content, metadata}` / number），#228 已把这条归一收进那个函数
// （`0` 不能被当「没结果」吞掉、对象不能渲成 `[object Object]`）；**缺键就是空串 ⇒ 一行都不许多画**。
function foldedToolResult(tc: { resultPreview?: unknown }): string {
  return getToolResultSummary(tc.resultPreview);
}
</script>

<template>
  <div v-if="state.status === 'loading'" class="text-xs text-black/40">{{ t('common.loading') }}</div>
  <div v-else-if="state.status === 'missing'" class="folded-original-missing text-xs text-black/40">{{ t('stream.folded.originalMissing') }}</div>
  <template v-else-if="state.status === 'loaded'">
    <!-- #375：归档只是本轮差分且被上游夹断时，要说清「下面的正文是从账本按轮号补齐的」 -->
    <div
      v-if="truncated"
      class="folded-original-truncated text-xs text-black/40"
    >{{ t('stream.folded.originalTruncated', { count: droppedMessages ?? '?' }) }}</div>
    <!--
      原文渲染口径（#384，真机验出来的一条「假占位」）：
      账本里的 turn 有四类内容——`text` / `reasoning` / `toolCalls[]`（+ user 身份）。旧实现只画 `text`，
      于是**真的干了活的那几轮**（只有 reasoning + 工具调用、没有正文）整片渲染成「（无文本内容）」——
      真机 round 100 的 112 条里有 40 条是这样，用户看到的是满屏空行，而原文其实全在。
      现在：四类都画；只有四类**都空**才给占位（占位的语义收窄成「这一条真的什么都没有」）。
      #387：工具行下半句——「返回了什么」。后端重建路（`sessions.js#attachToolResultsToRecords`）
      现在会把 `tool_result` 挂回 `tool_use` 再喂上游投影，于是 `toolCalls[].resultPreview` 有值了。
      **配不上时那个键缺席**（不是空串），所以这里用 `foldedToolResult()` 归一后**空串就不画**：
      宁可少一行，也不能在原文里凭空造出一个「↳ （空）」——那是原文里从来没说过的话。
    -->
    <div
      v-for="(turn, ti) in turns"
      :key="ti"
      class="folded-original-turn"
    >
      <div v-if="turn.role === 'user'" class="folded-original-role text-xs text-black/35">{{ t('stream.folded.originalRoleUser') }}</div>
      <!-- #389：正文走 markdown（与助手气泡同一路径/样式）；reasoning 与工具行**刻意保持纯文本**
           （模型独白/命令行里 `*` `_` 反引号遍地，格式化会出错），绝不 v-html。 -->
      <div v-if="turn.reasoning" class="folded-original-reasoning overflow-auto whitespace-pre-wrap break-all text-black/40 italic">{{ turn.reasoning }}</div>
      <div v-if="turn.text" class="folded-original-text md overflow-auto text-black/70" v-html="renderMarkdown(turn.text)"></div>
      <div
        v-for="(tc, ci) in (turn.toolCalls ?? [])"
        :key="ci"
        class="folded-original-tool overflow-auto whitespace-pre-wrap break-all text-xs text-black/45"
      >{{ t('stream.folded.originalTool', { name: tc.name ?? '?', args: tc.argsSummary ?? '' }) }}{{ tc.isError ? t('stream.folded.originalToolFailed') : '' }}<div
          v-if="foldedToolResult(tc)"
          class="folded-original-tool-result pl-3"
        >↳ {{ foldedToolResult(tc) }}</div></div>
      <div v-if="!turn.text && !turn.reasoning && !(turn.toolCalls && turn.toolCalls.length)" class="text-xs text-black/40">{{ t('stream.folded.originalEmpty') }}</div>
    </div>
    <div v-if="turns.length === 0" class="text-xs text-black/40">{{ t('stream.folded.originalEmpty') }}</div>
  </template>
  <div v-else-if="state.status === 'error'" class="folded-original-error flex items-center gap-2 text-xs text-red-600">
    <span>{{ t('stream.folded.originalError', { message: errorMessage }) }}</span>
    <button type="button" class="retry-original rounded-md border border-black/20 px-2 py-0.5 hover:bg-black/5" @click="emit('retry')">{{ t('common.retry') }}</button>
  </div>
</template>
