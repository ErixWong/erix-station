<script setup lang="ts">
// 管理台「工位内容」的对话渲染（issue #727 片 2，契约 §4.22）。
//
// 只读红线：本文件**没有任何**输入框 / 发送 / 停止 / 审批按钮，也不建 EventSource。
// 它只做两件事——把 `GET .../sessions/:id` 的 DTO 与 `events/history` 的事件渲染出来，
// 以及「加载更早」（`before` 游标）和「查看折叠原文」（`folded/:round`）两个只读懒加载。
//
// 不复用 StreamPanel：那个组件挂在 workbench store 的实时流状态机上（SSE + 发送），
// 管理台要的正是「没有实时流」的那一半。
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import { renderMarkdown } from '../lib/markdown';
import { formatDuration, getToolPreview, getToolResultSummary } from '../lib/toolSummary';
import {
  PERSISTENCE_TERMINATION_REASON,
  RUN_END_LABEL_REASONS,
  RUN_TERMINATION_SYSERR_REASONS,
} from '../lib/terminationReasons';
import { useAdminSeatContentStore } from '../stores/adminSeatContent';
import type { SeatHistoryEvent, SeatMessage, SeatSessionDetail } from '../stores/adminSeatContent';

const props = defineProps<{
  fde: string;
  sessionId: string;
  detail: SeatSessionDetail | null;
  includeArchived: boolean;
}>();

const { t } = useI18n();

// 长 class / 长文案路径常量化（单行 ≤100 字节纪律；语义零变化，只是把字面量搬进脚本）。
const CLS_PRE = 'overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]';
const CLS_PRE_RESULT = CLS_PRE + ' text-black/70';
const CLS_ORIGINAL = 'max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]';
const CLS_TRUNC = 'min-w-0 flex-1 truncate text-black/55';
const CLS_SUMMARY = 'cursor-pointer';
const CLS_MSG_USER = 'rounded-md border border-black/10 px-2 py-1.5 text-sm whitespace-pre-wrap';
const CLS_MSG_SYNTH = 'rounded-md bg-black/5 px-2 py-1 text-xs whitespace-pre-wrap text-black/60';
const K_REASONING = 'admin.seatContent.transcript.reasoning';
const store = useAdminSeatContentStore();

// ── 历史事件（`events/history`）：初始一页 + 「加载更早」往前翻 ──
const events = ref<SeatHistoryEvent[]>([]);
const historyCursor = ref<number | null>(null);
const historyLoading = ref(false);
const historyError = ref('');

// ── 折叠原文：按消息 id 记账（loading / ready / missing / error 四态）──
type FoldedState =
  | { status: 'loading' }
  | { status: 'ready'; turns: Array<Record<string, unknown>>; truncated?: boolean }
  | { status: 'missing' }
  | { status: 'error'; message: string };
const foldedState = ref<Record<string, FoldedState>>({});
const foldedOpen = ref<Record<string, boolean>>({});

// ── 工具卡展开态（默认全部收起）──
const expanded = ref<Record<string, boolean>>({});

function reset(): void {
  events.value = [];
  historyCursor.value = null;
  historyError.value = '';
  foldedState.value = {};
  foldedOpen.value = {};
  expanded.value = {};
}

async function loadHistory(before?: number | null): Promise<void> {
  if (!props.fde || !props.sessionId) return;
  historyLoading.value = true;
  historyError.value = '';
  try {
    const page = await store.loadHistory(props.fde, props.sessionId, {
      before: before ?? undefined,
      includeArchived: props.includeArchived,
    });
    const incoming = page.events ?? [];
    // 「加载更早」= 前插（升序列表里更早的在头上）；游标原样保存，不拆解不改写。
    events.value = before == null ? incoming : [...incoming, ...events.value];
    historyCursor.value = page.next_cursor ?? null;
  } catch (e) {
    historyError.value = e instanceof Error ? e.message : String(e);
  } finally {
    historyLoading.value = false;
  }
}

watch(
  () => [props.fde, props.sessionId, props.includeArchived],
  () => {
    reset();
    void loadHistory();
  },
  { immediate: true },
);

/** 「加载更早」：只把服务端给的 `next_cursor` 原样当 `before` 用。 */
function loadEarlier(): void {
  if (historyCursor.value == null || historyLoading.value) return;
  void loadHistory(historyCursor.value);
}

// ── 条目归并：messages 与 events 共用 seq 轴（升序），同 seq 时消息在前 ──
type Entry =
  | { kind: 'msg'; seq: number; key: string; msg: SeatMessage }
  | { kind: 'event'; seq: number; key: string; ev: SeatHistoryEvent };

const entries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  for (const msg of props.detail?.messages ?? []) {
    out.push({ kind: 'msg', seq: Number(msg.seq ?? 0), key: `m:${msg.id}`, msg });
  }
  for (const ev of events.value) {
    out.push({ kind: 'event', seq: Number(ev.seq ?? 0), key: `e:${ev.seq}:${ev.type}`, ev });
  }
  // 稳定排序：只按 seq，同 seq 保持「消息先入列」的相对顺序（Array#sort 在 V8 里是稳定的）。
  return out.sort((a, b) => a.seq - b.seq);
});

/** 这条会话是否还有可翻的历史（决定「加载更早」按钮的可见性）。 */
const canLoadEarlier = computed(() => historyCursor.value != null);

// ── 工具卡：事件流按 tool_call_id 配对，投影路径直接读 messages[].toolCalls ──
interface ToolCard {
  name: string;
  args: string;
  result: string;
  ok: boolean | null;
  dur?: number;
}

/** 事件序列 → `tool_call_id` → 卡片（`tool_result` 回填同一张卡，不新建）。 */
const cardsByCallId = computed<Map<string, ToolCard>>(() => {
  const map = new Map<string, ToolCard>();
  for (const ev of events.value) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const callId = String(p.tool_call_id ?? `${ev.seq}`);
    if (ev.type === 'tool_use') {
      const input = p.input;
      map.set(callId, {
        name: typeof p.name === 'string' ? p.name : '',
        args: typeof input === 'object' ? JSON.stringify(input ?? {}) : String(input ?? ''),
        result: '',
        ok: null,
      });
    } else if (ev.type === 'tool_result') {
      const card = map.get(callId) ?? { name: '', args: '', result: '', ok: null };
      card.ok = p.ok === true;
      const digest = getToolResultSummary(p.result_digest);
      card.result = card.result ? `${card.result}\n${digest}` : digest;
      if (typeof p.duration_ms === 'number' && Number.isFinite(p.duration_ms)) {
        card.dur = p.duration_ms;
      }
      map.set(callId, card);
    }
  }
  return map;
});

/** 这条 `tool_use` 事件对应卡片（`tool_result` 事件本身不再出一张卡）。 */
function cardFor(ev: SeatHistoryEvent): ToolCard | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  return cardsByCallId.value.get(String(p.tool_call_id ?? `${ev.seq}`)) ?? null;
}

/** 模板用：永远返回一张卡（缺卡时是空卡），避开模板里的非空断言。 */
const EMPTY_CARD: ToolCard = { name: '', args: '', result: '', ok: null };
function cardOrEmpty(ev: SeatHistoryEvent): ToolCard {
  return cardFor(ev) ?? EMPTY_CARD;
}

/** 投影路径（`messages[].toolCalls`）的卡片视图模型：上游已截断，直接沿用。 */
function pCard(call: NonNullable<SeatMessage['toolCalls']>[number]): ToolCard {
  return {
    name: call.name,
    args: call.argsSummary ?? '',
    result: call.resultPreview ?? '',
    ok: call.isError === undefined ? null : !call.isError,
    dur: call.durationMs,
  };
}

/** 卡片头的一行摘要：优先语义摘要（command/path/…），否则参数原文截断。 */
function summary(card: ToolCard): string {
  return getToolPreview(card.args) || card.args.slice(0, 120);
}

function cardStatusMark(card: ToolCard): string {
  return card.ok === null ? '…' : card.ok ? '✓' : '✗';
}

/** 时长缺失就整段不渲染（`formatDuration` 给空串，绝不写 `0ms`）。 */
function durText(card: ToolCard): string {
  const dur = card.dur === undefined ? '' : formatDuration(card.dur);
  return dur === '' ? '' : t('admin.seatContent.transcript.toolDuration', { duration: dur });
}

function toggleCard(key: string): void {
  expanded.value = { ...expanded.value, [key]: !expanded.value[key] };
}

// ── Markdown（助手正文）与纯文本 ──
function markdownHtml(text: string): string {
  return renderMarkdown(text);
}

// ── 终态条（合成项 `run_termination`）：红/中性口径与工作台同源 ──
const REASON_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  RUN_END_LABEL_REASONS.map((reason) => [reason, `stream.event.runEndReason.${reason}`]),
);

function terminationInfo(payload: Record<string, unknown>): { text: string; syserr: boolean } {
  const termination = (payload.termination ?? {}) as Record<string, unknown>;
  const reason = typeof termination.reason === 'string' ? termination.reason : '';
  let text = reason === 'end_turn' ? t('stream.event.runEndNormal') : reason;
  const labelKey = REASON_LABEL_KEYS[reason];
  if (labelKey) text = `${text} — ${t(labelKey)}`;
  if (reason === PERSISTENCE_TERMINATION_REASON && typeof termination.phase === 'string') {
    text += ` · phase=${termination.phase}`;
  }
  return { text, syserr: RUN_TERMINATION_SYSERR_REASONS.has(reason) };
}

// ── 折叠原文（懒加载；404 `folded_payload_not_found` 是「无原文」而不是错误）──
function foldedRound(msg: SeatMessage): number | null {
  const round = msg.folded?.round;
  return typeof round === 'number' ? round : null;
}

function toggleFoldedOriginal(msg: SeatMessage): void {
  const open = !foldedOpen.value[msg.id];
  foldedOpen.value = { ...foldedOpen.value, [msg.id]: open };
  if (open && !foldedState.value[msg.id]) void loadOriginal(msg);
}

async function loadOriginal(msg: SeatMessage): Promise<void> {
  const round = foldedRound(msg);
  if (round == null) return;
  foldedState.value = { ...foldedState.value, [msg.id]: { status: 'loading' } };
  try {
    const payload = await store.loadFolded(props.fde, props.sessionId, round, {
      includeArchived: props.includeArchived,
    });
    foldedState.value = {
      ...foldedState.value,
      [msg.id]: { status: 'ready', turns: payload.turns ?? [], truncated: payload.truncated },
    };
  } catch (e) {
    // 「这个范围真的没有正文」不是故障：友好提示，不刷红（§4.22 folded 语义）。
    const missing = e instanceof ApiError && e.code === 'folded_payload_not_found';
    foldedState.value = {
      ...foldedState.value,
      [msg.id]: missing
        ? { status: 'missing' }
        : { status: 'error', message: e instanceof Error ? e.message : String(e) },
    };
  }
}

/** 模板用：错误态的文案（避开内联断言）。 */
function foldedErrorMessage(messageId: string): string {
  const state = foldedState.value[messageId];
  return state && state.status === 'error' ? state.message : '';
}

/** 模板用：已就绪的原文 turn 列表（同样避开内联断言）。 */
function originalTurns(messageId: string): Array<Record<string, unknown>> {
  const state = foldedState.value[messageId];
  return state && state.status === 'ready' ? state.turns : [];
}

/** 原文 turn 的正文（只取 `text`，其余键不解读——与用户面同一边界）。 */
function originalText(turn: Record<string, unknown>): string {
  return typeof turn.text === 'string' ? turn.text : '';
}

function foldedBannerText(msg: SeatMessage): string {
  const round = foldedRound(msg) ?? 0;
  return t('admin.seatContent.transcript.foldedBanner', { round });
}

function partialNotice(payload: Record<string, unknown>): string {
  if (payload.placeholder === true) return t('admin.seatContent.transcript.partialPlaceholder');
  return payload.truncated === true ? t('admin.seatContent.transcript.partialTruncated') : '';
}

function partialText(payload: Record<string, unknown>): string {
  return typeof payload.text === 'string' ? payload.text : '';
}

/** `reasoning` 事件（若上游给了）与消息上的 `reasoning` 键一样，只做纯文本折叠块。 */
function reasoningOfEvent(ev: SeatHistoryEvent): string {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  const value = p.reasoning ?? p.text;
  return typeof value === 'string' ? value : '';
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 分页：「加载更早」只认服务端给的 next_cursor（到底就整段不渲染） -->
    <div class="shrink-0 border-b border-black/10 px-3 py-1.5 text-xs">
      <button
        v-if="canLoadEarlier"
        type="button"
        data-test="load-earlier"
        class="rounded-md border border-black/15 px-2 py-1 hover:bg-black/5 disabled:opacity-50"
        :disabled="historyLoading"
        @click="loadEarlier"
      >{{ t('admin.seatContent.transcript.loadEarlier') }}</button>
      <span v-else data-test="no-earlier" class="text-black/40">
        {{ t('admin.seatContent.transcript.noEarlier') }}
      </span>
      <span
        v-if="historyError"
        data-test="history-error"
        class="syserr ml-2"
      >{{ historyError }}</span>
    </div>

    <div class="min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2">
      <p
        v-if="!entries.length"
        data-test="transcript-empty"
        class="py-6 text-center text-sm text-black/45"
      >
        {{ t('admin.seatContent.transcript.empty') }}
      </p>

      <template v-for="en in entries" :key="en.key">
        <!-- ── 消息 ── -->
        <template v-if="en.kind === 'msg'">
          <!-- synthetic：纯文本 + 灰底（不喂 Markdown：它是系统注入的行，不是助手正文） -->
          <div
            v-if="en.msg.synthetic === true"
            data-test="msg-synthetic"
            :class="CLS_MSG_SYNTH"
          >{{ en.msg.content }}</div>

          <template v-else-if="en.msg.role === 'user'">
            <div
              data-test="msg-user"
              :class="CLS_MSG_USER"
            >
              {{ en.msg.content }}
            </div>
          </template>

          <template v-else>
            <!-- 助手正文：Markdown（复用 lib/markdown.ts，先转义再格式化） -->
            <div
              data-test="msg-assistant"
              class="md rounded-md border border-black/10 px-2 py-1.5 text-sm"
              v-html="markdownHtml(en.msg.content)"
            ></div>

            <!-- 折叠横幅 + 「查看原文」懒加载 -->
            <div
              v-if="en.msg.folded"
              data-test="folded-banner"
              class="rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1 text-xs"
            >
              <span>{{ foldedBannerText(en.msg) }}</span>
              <button
                type="button"
                data-test="folded-toggle"
                class="ml-2 rounded border border-black/15 px-1.5 py-0.5 hover:bg-black/5"
                @click="toggleFoldedOriginal(en.msg)"
              >{{ foldedOpen[en.msg.id] ? t('admin.seatContent.transcript.hideOriginal')
                : t('admin.seatContent.transcript.viewOriginal') }}</button>

              <div v-if="foldedOpen[en.msg.id]" class="mt-1">
                <p
                  v-if="foldedState[en.msg.id]?.status === 'loading'"
                  data-test="folded-loading"
                  class="text-black/45"
                >
                  {{ t('admin.seatContent.transcript.originalLoading') }}
                </p>
                <p
                  v-else-if="foldedState[en.msg.id]?.status === 'missing'"
                  data-test="folded-missing"
                  class="text-black/50"
                >
                  {{ t('admin.seatContent.transcript.originalUnavailable') }}
                </p>
                <p
                  v-else-if="foldedState[en.msg.id]?.status === 'error'"
                  data-test="folded-error"
                  class="syserr"
                >
                  {{ t('admin.seatContent.transcript.originalFailed', {
                    message: foldedErrorMessage(en.msg.id),
                  }) }}
                </p>
                <pre
                  v-else-if="foldedState[en.msg.id]?.status === 'ready'"
                  data-test="folded-original"
                  :class="CLS_ORIGINAL"
                ><template
                  v-for="(turn, ti) in originalTurns(en.msg.id)"
                  :key="`${en.msg.id}-${ti}`"
                >{{ originalText(turn) }}
</template></pre>
              </div>
            </div>

            <!-- 推理（有则给一个纯文本折叠块，不做富文本） -->
            <details
              v-if="en.msg.reasoning"
              data-test="msg-reasoning"
              class="rounded-md bg-black/5 px-2 py-1 text-xs"
            >
              <summary :class="CLS_SUMMARY">{{ t(K_REASONING) }}</summary>
              <pre :class="CLS_PRE_RESULT">{{ en.msg.reasoning }}</pre>
            </details>

            <!-- 投影路径的工具卡（刷新后卡片来自 messages[].toolCalls） -->
            <div
              v-for="(call, ci) in en.msg.toolCalls ?? []"
              :key="`${en.msg.id}-call-${ci}`"
              data-test="tool-card"
              class="rounded-md border border-black/10"
            >
              <button
                type="button"
                data-test="tool-card-head"
                class="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-black/5"
                :aria-label="t('admin.seatContent.transcript.toolDetails')"
                @click="toggleCard(`${en.msg.id}-call-${ci}`)"
              >
                <span class="shrink-0">{{ cardStatusMark(pCard(call)) }}</span>
                <span class="shrink-0 font-mono">{{ call.name }}</span>
                <span :class="CLS_TRUNC">{{ summary(pCard(call)) }}</span>
                <span class="shrink-0 text-black/40">{{ durText(pCard(call)) }}</span>
              </button>
              <div
                v-if="expanded[`${en.msg.id}-call-${ci}`]"
                data-test="tool-card-body"
                class="border-t border-black/10 px-2 py-1"
              >
                <pre :class="CLS_PRE">{{ pCard(call).args }}</pre>
                <pre :class="CLS_PRE_RESULT">{{ pCard(call).result }}</pre>
              </div>
            </div>
          </template>
        </template>

        <!-- ── 事件 ── -->
        <template v-else-if="en.ev.type === 'tool_use'">
          <div
            v-if="cardFor(en.ev)"
            data-test="tool-card"
            class="rounded-md border border-black/10"
          >
            <button
              type="button"
              data-test="tool-card-head"
              class="flex w-full items-center gap-1 px-2 py-1 text-left text-xs hover:bg-black/5"
              :aria-label="t('admin.seatContent.transcript.toolDetails')"
              @click="toggleCard(en.key)"
            >
              <span class="shrink-0">{{ cardStatusMark(cardOrEmpty(en.ev)) }}</span>
              <span class="shrink-0 font-mono">{{ cardOrEmpty(en.ev).name }}</span>
              <span :class="CLS_TRUNC">{{ summary(cardOrEmpty(en.ev)) }}</span>
              <span class="shrink-0 text-black/40">{{ durText(cardOrEmpty(en.ev)) }}</span>
            </button>
            <div
              v-if="expanded[en.key]"
              data-test="tool-card-body"
              class="border-t border-black/10 px-2 py-1"
            >
              <pre :class="CLS_PRE">{{ cardOrEmpty(en.ev).args }}</pre>
              <pre :class="CLS_PRE_RESULT">{{ cardOrEmpty(en.ev).result }}</pre>
            </div>
          </div>
        </template>

        <!-- 半截正文：中性提示（不是错误），带「被截断/占位」口径 -->
        <div
          v-else-if="en.ev.type === 'partial_output'"
          data-test="event-partial"
          class="rounded-md bg-black/5 px-2 py-1.5 text-sm"
        >
          <div class="whitespace-pre-wrap break-words">{{ partialText(en.ev.payload) }}</div>
          <p v-if="partialNotice(en.ev.payload)" class="mt-1 text-xs text-black/50">
            {{ partialNotice(en.ev.payload) }}
          </p>
        </div>

        <!-- 终态条：红/中性按 lib/terminationReasons 的同一张集合判（与工作台刷新后同色） -->
        <div
          v-else-if="en.ev.type === 'run_termination'"
          data-test="run-termination"
          class="rounded-md px-2 py-1 text-xs"
          :class="terminationInfo(en.ev.payload).syserr ? 'syserr' : 'text-black/50'"
          :data-syserr="terminationInfo(en.ev.payload).syserr ? '1' : '0'"
        >{{ terminationInfo(en.ev.payload).text }}</div>

        <details
          v-else-if="en.ev.type === 'reasoning' && reasoningOfEvent(en.ev)"
          data-test="event-reasoning"
          class="rounded-md bg-black/5 px-2 py-1 text-xs"
        >
          <summary :class="CLS_SUMMARY">{{ t(K_REASONING) }}</summary>
          <pre :class="CLS_PRE_RESULT">{{ reasoningOfEvent(en.ev) }}</pre>
        </details>
      </template>
    </div>
  </div>
</template>
