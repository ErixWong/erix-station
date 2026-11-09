<script setup lang="ts">
// 子 run（delegation）**只读抽屉**（issue #delegate P3 交付 1；设计 §6.1）。
// 工具卡（StreamPanel.vue）本轮不做；分级尺规一律走 `lib/delegate.ts`（与卡片同源），
// 红色集合的唯一来源是 `lib/terminationReasons.ts#RUN_TERMINATION_SYSERR_REASONS`，
// 本文件**不另造**任何状态枚举。
//
// dialog 语义照抄 FilePreviewModal / SessionPickerModal：role+aria-modal、Esc 关闭、
// 打开焦点进 dialog、关闭归还触发元素、锁背景滚动。
//
// 轮询四条纪律（缺一不可，逐条有 spec 钉住）：
//   ① 单飞：`inFlight` 守卫，上一发没落定就不发第二发；
//   ② 只在 `document.visibilityState === 'visible'` 时发（后台标签页不打扰后端），
//      不可见时**只续排程不发请求**，重新可见立刻补一发；
//   ③ 终态即停：state ∈ 终态集（`lib/delegate.ts` 由 7 值封闭集减活态导出）⇒ 不再排程；
//      **打开时就已是终态 ⇒ 只拉一次**；
//   ④ `onUnmounted` 清 timer + abort 在途请求（abort 之后的 reject 不当故障，也不复活 timer）。
import { computed, nextTick, onMounted, onUnmounted, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { renderMarkdown } from '../lib/markdown';
import {
  DELEGATE_BADGE_CLASS,
  DELEGATE_POLL_MS,
  delegateBadgeKind,
  delegateStateKey,
  delegateToolCallText,
  delegateTranscriptUrl,
  isDelegateTerminal,
  shortRunId,
  type DelegateMessage,
  type DelegateToolCall,
} from '../lib/delegate';

const props = defineProps<{
  sessionId: string;
  parentRunId: string;
  childRunId: string;
  label?: string;
  /**
   * 卡片从名册/工具结果里拿到的引擎 termination（**字符串**）。
   * 抽屉自己的端点不带这个字段，而「`completed` + `persistence_failed` 仍要红」这条红线
   * （工单 §5 判据 7）在抽屉里也得成立 ⇒ 由调用方递进来；没给就只按 state 分级（不猜）。
   */
  termination?: string;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const { t } = useI18n();

/** P2 读侧响应体（每个字段都按脏值兜底：UI 不许假设后端一定给全）。 */
interface DelegateTranscriptDto {
  childRunId?: unknown;
  state?: unknown;
  termination?: unknown;
  messages?: unknown;
  truncated?: unknown;
  totalTurns?: unknown;
}

const messages = ref<DelegateMessage[]>([]);
const state = ref('');
const termination = ref('');
const truncated = ref(false);
const totalTurns = ref(0);
const errorMessage = ref('');
const inFlight = ref(false);

// ── 分级（唯一入口 delegateBadgeKind：syserr 判红 + aborted 琥珀都在它里面）────────────
const badgeKind = computed(() =>
  delegateBadgeKind(state.value, termination.value || props.termination || ''),
);
const badgeClass = computed(() => DELEGATE_BADGE_CLASS[badgeKind.value]);
const stateText = computed(() => t(`delegate.state.${delegateStateKey(state.value)}`));
const spinning = computed(() => badgeKind.value === 'running');

// ── 三态（error > 空活态 starting > 空终态 empty > 有内容）───────────────────────────
// 失败优先：一发都没成功过 ⇒ 错误 + 重试（死路页必须有出口）；已有内容时失败只在顶部挂条幅。
const showFatalError = computed(() => errorMessage.value !== '' && messages.value.length === 0);
const showBannerError = computed(() => errorMessage.value !== '' && messages.value.length > 0);
const showStarting = computed(
  () => !showFatalError.value && messages.value.length === 0 && !isDelegateTerminal(state.value),
);
const showEmpty = computed(
  () => !showFatalError.value && messages.value.length === 0 && isDelegateTerminal(state.value),
);
const polling = computed(() => !showFatalError.value && !isDelegateTerminal(state.value));

const title = computed(() =>
  t('delegate.viewerTitle', { id: shortRunId(props.childRunId) || props.childRunId }),
);
const subtitle = computed(() =>
  props.label ? `${props.label}${totalTurns.value ? ` · ${totalTurns.value}` : ''}` : '',
);

/** 消息的工具行：无 `argsSummary` 的调用整行不渲染（工单 §3.1）。 */
function toolRows(message: DelegateMessage): string[] {
  if (!Array.isArray(message.toolCalls)) return [];
  return (message.toolCalls as DelegateToolCall[])
    .map((call) => delegateToolCallText(call ?? {}))
    .filter((row): row is string => row !== null);
}

/** 正文取值：只认字符串（脏值 ⇒ 空串，不把 undefined/对象当正文渲染）。 */
function textOf(message: DelegateMessage): string {
  return typeof message.text === 'string' ? message.text : '';
}

function bodyHtml(message: DelegateMessage): string {
  return renderMarkdown(textOf(message));
}

// ── 拉取 + 轮询 ────────────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let unmounted = false;

function clearTimer(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** 终态即停（纪律 ③）：终态 / 已卸载 ⇒ 不再排程；否则固定 `DELEGATE_POLL_MS` 后补一发。 */
function schedule(): void {
  clearTimer();
  if (unmounted) return;
  if (isDelegateTerminal(state.value)) return;
  timer = setTimeout(() => {
    timer = null;
    void poll();
  }, DELEGATE_POLL_MS);
}

async function poll(): Promise<void> {
  if (inFlight.value) return; // 纪律 ①：单飞
  if (document.visibilityState !== 'visible') {
    schedule(); // 纪律 ②：后台标签页不发请求，只续排程
    return;
  }
  inFlight.value = true;
  // 新一发之前先把**上一发的 controller** 收掉：本轮有单飞守卫，走到这里时旧请求已 settle，
  // abort 它是幂等空操作 —— 但不能让 controller 变量被覆盖后留一个「没人持有、也就没人能打断」的
  // 孤儿（纪律 ④ 只能 abort 最后那一个，前头的就成幽灵了）。
  controller?.abort();
  controller = new AbortController();
  try {
    // 直接用 fetch 而非 api()：轮询要带 AbortController，且失败要静默进错误态而不是抛 ApiError。
    const res = await fetch(delegateTranscriptUrl(props.sessionId, props.childRunId, props.parentRunId), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const dto = (await res.json()) as DelegateTranscriptDto;
    if (unmounted) return;
    state.value = typeof dto.state === 'string' ? dto.state : '';
    termination.value = typeof dto.termination === 'string' ? dto.termination : '';
    messages.value = Array.isArray(dto.messages) ? (dto.messages as DelegateMessage[]) : [];
    truncated.value = dto.truncated === true;
    totalTurns.value = typeof dto.totalTurns === 'number' ? dto.totalTurns : 0;
    errorMessage.value = '';
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return; // 纪律 ④：卸载打断在途请求不算故障
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    inFlight.value = false;
    schedule(); // 打开时已终态 ⇒ 这里不排程 ⇒ 恰好只拉一次
  }
}

function refresh(): void {
  clearTimer();
  void poll();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible' && !inFlight.value) refresh();
}

// ── dialog 语义（对齐 FilePreviewModal）─────────────────────────────────────────────
const dialogEl = useTemplateRef<HTMLElement>('dialogEl');
let previousFocus: Element | null = null;
let previousOverflow = '';

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}

onMounted(async () => {
  previousFocus = document.activeElement;
  previousOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  await nextTick();
  dialogEl.value?.focus();
  void poll();
});

onUnmounted(() => {
  unmounted = true;
  clearTimer(); // 纪律 ④
  controller?.abort();
  controller = null;
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.body.style.overflow = previousOverflow;
  (previousFocus as HTMLElement | null)?.focus?.();
});

defineExpose({ refresh, poll });
</script>

<template>
  <div class="fixed inset-0 z-50">
    <div class="absolute inset-0 bg-black/40" @click="emit('close')"></div>
    <div
      ref="dialogEl"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      class="absolute inset-y-0 right-0 flex w-full max-w-xl flex-col bg-white shadow-xl outline-none dark:bg-neutral-900"
    >
      <!-- 头部：标题（带短码）+ 状态徽标 + 刷新 + 关闭 -->
      <header class="flex items-center gap-2 border-b border-black/10 px-4 py-3 dark:border-white/10">
        <span
          data-testid="delegate-badge"
          :class="['flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium', badgeClass]"
          :data-badge-kind="badgeKind"
        >
          <!-- 徒章不靠颜色承载语义：图标（spinner / 几何符号）+ 文字标签 + data-badge-kind 三路共存 -->
          <svg
            v-if="spinning"
            class="animate-spin"
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span v-else aria-hidden="true">{{ badgeKind === 'completed' ? '✓' : badgeKind === 'aborted' ? '■' : badgeKind === 'failed' ? '✗' : '·' }}</span>
          <span>{{ stateText }}</span>
        </span>
        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ title }}</span>
        <span v-if="subtitle" class="hidden shrink-0 text-xs text-black/50 sm:inline">{{ subtitle }}</span>
        <button
          type="button"
          data-testid="delegate-refresh"
          class="shrink-0 rounded px-2 py-1 text-xs text-brand hover:underline"
          :disabled="inFlight"
          @click="refresh"
        >{{ t('delegate.refresh') }}</button>
        <button
          type="button"
          data-testid="delegate-close"
          :aria-label="t('delegate.closeViewer')"
          class="shrink-0 rounded px-2 py-1 text-xs text-black/50 hover:underline dark:text-white/60"
          @click="emit('close')"
        >✕</button>
      </header>

      <p v-if="polling" class="px-4 py-1 text-xs text-black/40 dark:text-white/40">
        {{ t('delegate.polling') }}
      </p>
      <!-- 只在上游明说「切过尾」（`truncated`）时才说，数字是**屏上条数**（不是切尾前的全量） -->
      <p v-if="truncated" class="px-4 py-1 text-xs text-amber-600">
        {{ t('delegate.truncated', { n: messages.length }) }}
      </p>
      <p
        v-if="showBannerError"
        data-testid="delegate-error"
        class="px-4 py-1 text-xs text-red-600"
      >{{ errorMessage }}</p>

      <!-- 三态 -->
      <p
        v-if="showFatalError"
        data-testid="delegate-error"
        class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-6 text-sm text-red-600"
      >
        <span>{{ t('delegate.viewer.error') }}</span>
        <span class="text-xs text-black/40 dark:text-white/40">{{ errorMessage }}</span>
        <button
          type="button"
          data-testid="delegate-retry"
          class="rounded border border-black/20 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          @click="refresh"
        >{{ t('delegate.refresh') }}</button>
      </p>
      <p
        v-else-if="showStarting"
        data-testid="delegate-starting"
        class="flex flex-1 items-center justify-center px-4 py-6 text-sm text-black/50 dark:text-white/50"
      >
        {{ t('delegate.viewer.starting') }}
      </p>
      <p
        v-else-if="showEmpty"
        data-testid="delegate-empty"
        class="flex flex-1 items-center justify-center px-4 py-6 text-sm text-black/50 dark:text-white/50"
      >
        {{ t('delegate.viewer.empty') }}
      </p>

      <!-- 消息流：user 右对齐小字（原样，不渲染 Markdown）；其余走渲染器 + 工具行 -->
      <div v-else class="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div
          v-for="(message, index) in messages"
          :key="typeof message.id === 'string' ? message.id : index"
          data-testid="delegate-message"
        >
          <p
            v-if="message.role === 'user'"
            class="ml-auto max-w-[85%] rounded bg-black/5 px-2 py-1 text-xs text-black/70 dark:bg-white/10 dark:text-white/70"
          >{{ textOf(message) }}</p>
          <div v-else class="markdown-body min-w-0 text-sm" v-html="bodyHtml(message)"></div>
          <ul v-if="toolRows(message).length" class="mt-1 space-y-0.5">
            <li
              v-for="(row, rowKey) in toolRows(message)"
              :key="rowKey"
              class="truncate font-mono text-xs text-black/60 dark:text-white/60"
            >{{ row }}</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>
