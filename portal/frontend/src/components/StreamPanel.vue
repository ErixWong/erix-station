<script setup lang="ts">
// 消息流（旧 #stream 的渲染语义平移）：addMessage 三分（user/assistant/synthetic）、
// 助手终稿 markdown（v-html，渲染器本身先转义后格式化，XSS 安全）、工具卡片、
// roundsep/syserr 分隔行、流式增量气泡。自动跟随/「↓ 最新」由父级持有（scroll 容器也在父级）。
import { reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore, type StreamEntry } from '../stores/workbench';
import type { ToolCardState } from '../composables/useEventStream';
// issue #85：卡片折叠（默认收起）+ 单行摘要防溢出，方案对齐 pi web ToolCallBlock。
import { getToolPreview } from '../lib/toolSummary';
import { isToolCallExpanded, setToolCallExpanded } from '../lib/toolCallExpansion';
// pi-web 风格：流式增量也走 markdown 渲染（渲染器先转义后格式化，半截 ``` 容错收尾）。
import { renderMarkdown } from '../lib/markdown';

const { t } = useI18n();
const store = useWorkbenchStore();

// 展开态：组件内 reactive Set 驱动重渲染，模块级 Set（toolCallExpansion）做跨重渲染记忆，
// 二者双向镜像；entries 重建（SSE 补发/历史重放）后从模块 Set 回灌，展开状态不丢。
const expandedIds = reactive(new Set<string>());

watch(
  () => store.entries,
  () => {
    for (const en of store.entries) {
      if (en.kind === 'tool' && isToolCallExpanded(en.callId) && !expandedIds.has(en.callId)) {
        expandedIds.add(en.callId);
      }
    }
  },
  { immediate: true },
);

function isExpanded(callId: string): boolean {
  return expandedIds.has(callId);
}

function toggleCard(callId: string): void {
  const next = !expandedIds.has(callId);
  setToolCallExpanded(callId, next);
  if (next) expandedIds.add(callId);
  else expandedIds.delete(callId);
}

// 单行摘要：优先 args 里的语义键（command/path/...），解析失败回退 dig（§旧 toolCard 原样）。
function summaryText(card: ToolCardState): string {
  return getToolPreview(card.args) || card.dig || (card.args ? '' : t('stream.argsPending'));
}

// 折叠态状态位：✓/✗（出错变红）+ 耗时；尚无结果（null）显示 …。
function statusMark(card: ToolCardState): string {
  if (card.ok === true) return '✓' + (card.dur != null ? ` ${card.dur}ms` : '');
  if (card.ok === false) return '✗' + (card.dur != null ? ` ${card.dur}ms` : '');
  return '…';
}

// issue #188：展开区取数——事件流卡片有完整 args/out；投影卡片（加载/刷新路径）只有上游摘要/预览
// （argsSummary 120 字 / resultPreview 400 字，全文在 DTO blocks，不在此重建）。
function cardArgs(card: ToolCardState): string {
  return card.args || card.argsSummary || '';
}

function cardOut(card: ToolCardState): string {
  if (card.out) return card.out;
  return [card.executionStatus, card.resultPreview].filter((part) => !!part).join(' · ');
}

// issue #188：推理块展开态（组件内，默认收起）——与工具卡片同一按钮+chevron 交互风格，不新造一套。
// 仅加载/刷新路径产出推理块（实时推理增量不展示），entries 不会被流式事件重建，故局部状态足够。
const expandedReasoning = reactive(new Set<string>());

function isReasoningExpanded(id: string): boolean {
  return expandedReasoning.has(id);
}

function toggleReasoning(id: string): void {
  if (expandedReasoning.has(id)) expandedReasoning.delete(id);
  else expandedReasoning.add(id);
}

// 收起时的单行摘要：取推理文本首行截 120 字（与卡片摘要同口径，防溢出）。
function reasoningSummary(text: string): string {
  return text.split('\n')[0].slice(0, 120);
}

function entryKey(en: StreamEntry, i: number): string {
  switch (en.kind) {
    case 'msg': return 'm' + en.id;
    case 'tool': return 't' + en.callId;
    case 'reasoning': return 'r' + en.id;
    case 'delta': return 'd' + i;
    default: return 's' + i;
  }
}

function msgClass(en: Extract<StreamEntry, { kind: 'msg' }>): string {
  // 旧 div.className = `msg ${m.role}${m.synthetic ? ' synthetic' : ''}`（+ .md 仅助手终稿）
  let cls = 'msg ' + en.role;
  if (en.synthetic) cls += ' synthetic';
  if (en.html) cls += ' md';
  return cls;
}
</script>

<template>
  <!-- 空态：旧版「选择或新建会话」默认文案（平台管理员进管理台引导） -->
  <div v-if="store.entries.length === 0">
    <p v-if="store.noDir && store.isPlatformAdmin" class="muted">
      {{ t('common.platformAdminHint') }}<br><router-link to="/admin" class="underline">{{ t('common.goToAdmin') }}</router-link>
    </p>
    <p v-else class="muted">{{ t('stream.chooseOrNewSession') }}</p>
  </div>

  <template v-for="(en, i) in store.entries" :key="entryKey(en, i)">
    <!-- 消息气泡：终稿 markdown 走 v-html；其余纯文本（{{ }} 插值等价 textContent） -->
    <div v-if="en.kind === 'msg'" :class="msgClass(en)">
      <div v-if="en.html" v-html="en.html"></div>
      <template v-else>{{ en.text }}</template>
    </div>
    <!-- 流式增量：markdown 容错渲染（v-html，渲染器先转义后格式化 XSS 安全），
         类名与助手终稿一致（.msg assistant .md），pi-web 风格下增量与终稿视觉无跳变 -->
    <div v-else-if="en.kind === 'delta'" class="msg assistant md" v-html="renderMarkdown(en.text)"></div>
    <!-- roundsep / 系统分隔行（judge 事件以 variant='judge' 走黄色面板样式） -->
    <div v-else-if="en.kind === 'sep'" :class="en.variant === 'judge' ? 'roundsep judge-panel' : 'roundsep'">{{ en.text }}</div>
    <!-- issue #42：红色系统错误行 -->
    <div v-else-if="en.kind === 'syserr'" class="syserr">{{ en.text }}</div>
    <!-- 工具卡片（issue #85：可折叠，默认收起；ok/err 左边框分级；头部整行 button 防溢出） -->
    <div
      v-else-if="en.kind === 'tool' && store.es.toolCards.get(en.callId)"
      class="my-1.5 max-w-[46rem] rounded-md border border-black/10 border-l-4 bg-black/[0.03] px-3 py-1.5 text-sm"
      :class="store.es.toolCards.get(en.callId)!.ok === true ? 'border-l-green-600'
        : store.es.toolCards.get(en.callId)!.ok === false ? 'border-l-red-600' : 'border-l-neutral-500'"
    >
      <button
        type="button"
        class="flex w-full min-w-0 items-center gap-2 text-left"
        :aria-expanded="isExpanded(en.callId)"
        @click="toggleCard(en.callId)"
      >
        <span
          class="shrink-0 font-semibold"
          :class="store.es.toolCards.get(en.callId)!.ok === false ? 'text-red-600' : ''"
        >🔧 {{ store.es.toolCards.get(en.callId)!.name }}</span>
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-black/50">
          {{ summaryText(store.es.toolCards.get(en.callId)!) }}
        </span>
        <span
          class="shrink-0 font-normal"
          :class="store.es.toolCards.get(en.callId)!.ok === false ? 'text-red-600' : 'text-black/50'"
        >{{ statusMark(store.es.toolCards.get(en.callId)!) }}</span>
        <span
          class="shrink-0 text-black/50 transition-transform duration-150"
          :class="{ 'rotate-180': isExpanded(en.callId) }"
        >▾</span>
      </button>
      <!-- 展开态：完整 args（pre 块永不溢出）+ 结果摘要行（tool_result 只带 digest，不虚构全文） -->
      <template v-if="isExpanded(en.callId)">
        <pre class="mt-1 overflow-auto whitespace-pre-wrap break-all font-normal text-black/70">{{ cardArgs(store.es.toolCards.get(en.callId)!) }}</pre>
        <div class="font-normal text-black/50">{{ cardOut(store.es.toolCards.get(en.callId)!) }}</div>
      </template>
    </div>
    <!-- issue #188：推理块（与正文分离、默认收起、可展开）——沿用工具卡片的按钮+chevron 折叠风格 -->
    <div
      v-else-if="en.kind === 'reasoning'"
      class="my-1.5 max-w-[46rem] rounded-md border border-black/10 border-l-4 border-l-neutral-400 bg-black/[0.02] px-3 py-1.5 text-sm"
    >
      <button
        type="button"
        class="flex w-full min-w-0 items-center gap-2 text-left"
        :aria-expanded="isReasoningExpanded(en.id)"
        @click="toggleReasoning(en.id)"
      >
        <span class="shrink-0 font-semibold text-black/60">🧠 {{ t('stream.reasoning') }}</span>
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-black/40">
          {{ reasoningSummary(en.text) }}
        </span>
        <span
          class="shrink-0 text-black/50 transition-transform duration-150"
          :class="{ 'rotate-180': isReasoningExpanded(en.id) }"
        >▾</span>
      </button>
      <pre v-if="isReasoningExpanded(en.id)" class="mt-1 overflow-auto whitespace-pre-wrap break-all font-normal text-black/70">{{ en.text }}</pre>
    </div>
  </template>
</template>
