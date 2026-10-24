<script setup lang="ts">
// 预览端口列表（#246 交付② 单 B）：工作台「预览端口」区块与管理台 FDE 详情共用同一块 UI。
// 无状态：数据与动作全在调用方（工作台侧栏用 usePreviewPorts 在进视图时拉；管理台在打开面板时拉），
// 本组件只画四态（加载中 / 空 / 失败带错误码 / 列表）+ 每行的「打开预览」「复制域名」。
//
// state 文案口径（§4.7a + 工单红线）：`active` 只代表**首次凭证放行过**，不代表容器里有应用在监听
// ⇒ 一律不写「健康 / 运行中」，未知取值原样透传（不猜语义）。
//
// issue #308：两种形态共用本组件（**状态/错误/空态口径只有一份**，防漂移）：
//   variant='table'（默认，管理台 FdePreviewPortsPane 与 #246 原形态）= 4 列表格；
//   variant='list'（工作台左侧栏紧凑形态）= 每行「端口 + 短状态标签 + 打开按钮」+ 第二行可截断
//   hostname（点击复制完整 url）。侧栏最窄档内容宽约 163px，表格装不下（工单 §3.1）⇒ 紧凑形态里
//   状态用短标签，**完整口径以 title/aria-label 可达**（不得只靠颜色传达），错误仍给「码 + 服务端原文」。
import { onScopeDispose, computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  asPreviewPortState,
  duplicateObservedGroups,
  formatStartedAgo,
  retryAfterSeconds,
  type PreviewApiError,
  type PreviewObserved,
  type PreviewPortItem,
} from '../lib/previewPorts';

const props = withDefaults(defineProps<{
  items: PreviewPortItem[];
  loading: boolean;
  loaded: boolean;
  error?: PreviewApiError | null;
  ticketBusyId?: string | null;
  ticketError?: PreviewApiError | null;
  popupBlockedUrl?: string | null;
  /** #247：整批签票进行中（「打开全部预览」按钮禁用 + 转圈）。 */
  batchBusy?: boolean;
  batchError?: PreviewApiError | null;
  /** #247：批量签完但部分新标签被拦截 ⇒ 这些带票地址的兜底链接（不得静默）。 */
  batchBlockedUrls?: string[];
  /**
   * #247：是否渲染「打开全部预览」。批量端点**只签本人 FDE**（越界一律 404），
   * 所以管理台「代看别人端口」的形态不给这个动作（给了会是个点了没反应的按钮）。
   */
  showOpenAll?: boolean;
  /** 'me' = 本人端口（GET /api/me/ports）；'fde' = 管理员代看某个 FDE。 */
  scope?: 'me' | 'fde';
  fdeName?: string | null;
  /**
   * 形态：'table' = 宽容器（管理台，默认）；'list' = 侧栏紧凑行（#308，约 163px 宽）。
   * 两种形态共用状态文案、错误文案、空态与拦截兜底——只是行内布局分叉。
   */
  variant?: 'table' | 'list';
  /**
   * 观测层 MVP：当前目录（工作台 store.dirCwd，`~/projects/<name>` 形，与观测 cwd 同口径）。
   * 传了 ⇒ 本目录在用的端口排最前；不传（管理台代看）⇒ 只做「有观测优先」，组内维持后端 port ASC。
   */
  currentCwd?: string | null;
}>(), {
  error: null,
  ticketBusyId: null,
  ticketError: null,
  popupBlockedUrl: null,
  batchBusy: false,
  batchError: null,
  batchBlockedUrls: () => [],
  showOpenAll: true,
  scope: 'me',
  fdeName: null,
  variant: 'table',
  currentCwd: null,
});

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'open', item: PreviewPortItem): void;
  /** #247 一键开整组：签票时机由调用方（usePreviewPorts.openAllPreviews）决定，面板自己不碰网络。 */
  (e: 'open-all'): void;
}>();

const { t } = useI18n();

const copiedId = ref<string | null>(null);
const copyError = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** 复制的是完整 `url`（含 scheme 与 dev 端口后缀），显示的是 hostname（§4.7a 两字段各自用途）。 */
async function copyUrl(item: PreviewPortItem) {
  if (!item.url) return; // 观测合成行无地址可复制（本不该渲染按钮，防御性兜底）
  try {
    await navigator.clipboard.writeText(item.url);
    copiedId.value = item.id;
    copyError.value = '';
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copiedId.value = null; }, 1500);
  } catch (err) {
    copiedId.value = null;
    copyError.value = t('previewPorts.copyFailed') + (err instanceof Error ? err.message : String(err));
  }
}

function stateLabel(state: string): string {
  const known = asPreviewPortState(state);
  return known ? t(`previewPorts.state.${known}`) : t('previewPorts.stateUnknown', { state });
}

/**
 * 紧凑形态的**短**标签（#308 §3.1）：长口径「已放行过（仅表示首次放行过）」单格就 168px > 163px，
 * 装不进侧栏 ⇒ 行内只放短标签，完整口径挂在同一个元素的 title/aria-label 上（不靠颜色传达）。
 */
function stateShortLabel(state: string): string {
  const known = asPreviewPortState(state);
  return known ? t(`previewPorts.stateShort.${known}`) : t('previewPorts.stateShortUnknown');
}

/** 错误条文案：错误码 + 服务端 message 原文（不许吞成「操作失败」）。 */
function loadErrorText(error: PreviewApiError): string {
  return t('previewPorts.loadFailed', { code: error.code, message: error.message });
}

/**
 * 签票错误文案（issue #256 交付②）：`Retry-After` 拿得到秒数就说「约 N 秒后可重试」，
 * 拿不到（缺头 / 不可解 / 非 429）退到不带秒数的既有文案——**绝不**显示 `undefined 秒` / `NaN`。
 */
function ticketErrorText(error: PreviewApiError): string {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? t('previewPorts.ticketFailed', { code: error.code, message: error.message })
    : t('previewPorts.ticketFailedRetry', { code: error.code, message: error.message, seconds });
}

function batchErrorText(error: PreviewApiError): string {
  const seconds = retryAfterSeconds(error);
  return seconds === null
    ? t('previewPorts.batchFailed', { code: error.code, message: error.message })
    : t('previewPorts.batchFailedRetry', { code: error.code, message: error.message, seconds });
}

/** 批量兜底链接的文字 = 该票地址的 host（人一眼能看出是哪个端口），解析不出就回原串。 */
function blockedLinkLabel(url: string): string {
  const matched = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return matched ? matched[1]! : url;
}

// ---------------------------------------------------------------------------
// 观测层 MVP（迁移 0022）：`observed` 只回答「此刻真有没有进程在听、在哪个目录/分支、起了多久」。
// ⚠ null ≠ 空闲（旧 agentd / 未跑 0022 的部署也是 null）⇒ 无观测的行**不加任何反向文案**。
// ---------------------------------------------------------------------------

function observedHere(item: PreviewPortItem): boolean {
  const dir = props.currentCwd?.replace(/\/+$/, '');
  const cwd = item.observed?.cwd;
  if (!dir || !cwd) return false;
  // 精确或子目录命中：agent 常在项目子目录里起服务（frontend/、apps/web/），
  // 只比全串会把「这个项目起的」误判成「与本目录无关」。
  return cwd === dir || cwd.startsWith(`${dir}/`);
}

/**
 * 旧后端（未跑 0022）的 DTO 里**没有** `observed` 键 ⇒ undefined；新后端恒有（可能为 null）。
 * 据此判定「观测可用」：不可用 ⇒ 不过滤（全量展示，与改动前逐字节同形）。
 */
const observationsAvailable = computed(() => props.items.some((i) => 'observed' in i));

/**
 * 工作台（传了 currentCwd）且观测可用 ⇒ **过滤**：主区只画当前目录在用的端口；
 * 其余（别的目录在用 + 无观测）收进折叠区——用户不必关心别的目录开了什么口，但签票/复用入口不丢。
 * 管理台代看（不传）或旧后端无观测 ⇒ 不过滤，仅「有观测优先」排序（组内维持后端 port ASC）。
 */
const filterToDir = computed(() => !!props.currentCwd && observationsAvailable.value);
const primaryItems = computed<PreviewPortItem[]>(() => {
  const rank = (item: PreviewPortItem) => (observedHere(item) ? 0 : item.observed ? 1 : 2);
  const sorted = [...props.items].sort((a, b) => rank(a) - rank(b));
  return filterToDir.value ? sorted.filter(observedHere) : sorted;
});
const otherItems = computed<PreviewPortItem[]>(() => {
  if (!filterToDir.value) return [];
  return props.items.filter((i) => !observedHere(i));
});
const othersOpen = ref(false);

/**
 * 同目录 ≥2 个监听 = 「两个分支各占一口」的现场；面板顶部显性警告，不让人靠猜。
 * 过滤态下只保留与当前目录相关的组——别的目录的冲突不该出现在我眼前的清单里。
 */
const duplicateGroups = computed(() => {
  const groups = duplicateObservedGroups(props.items);
  if (!filterToDir.value) return groups;
  return groups.filter((g) => g.cwd === props.currentCwd);
});

function observedText(obs: PreviewObserved, hereContext = false): string {
  // 主区行（目录已定）：cmd 比 cwd 有信息量（vite 还是 uvicorn）；cwd 冗余就不重复报。
  const parts: string[] = [];
  if (hereContext) {
    if (obs.branch) parts.push(`@${obs.branch}`);
    if (obs.cmd) parts.push(obs.cmd);
    if (!parts.length) parts.push(obs.cwd ?? (obs.pid !== null ? `pid ${obs.pid}` : ''));
  } else {
    parts.push(obs.cwd ?? (obs.pid !== null ? `pid ${obs.pid}` : ''));
    if (obs.branch) parts.push(`@${obs.branch}`);
  }
  const ago = obs.started_at ? formatStartedAgo(obs.started_at) : null;
  if (ago) parts.push(t('previewPorts.observedUptime', { ago }));
  return parts.filter(Boolean).join(' ');
}

/** title 里给全量细节（紧凑行会被 truncate 掉）。 */
function observedTitle(obs: PreviewObserved): string {
  const bits = [t('previewPorts.observedTitle')];
  if (obs.cwd) bits.push(obs.cwd);
  if (obs.branch) bits.push(`@${obs.branch}`);
  if (obs.cmd) bits.push(obs.cmd);
  if (obs.started_at) bits.push(new Date(obs.started_at).toLocaleString());
  return bits.join(' · ');
}

// 卸载时收掉复制回显的定时器（复制提示是纯本地态，组件都没了就没必要再改 ref）
onScopeDispose(() => clearTimeout(copiedTimer));
</script>

<template>
  <div data-test="preview-ports-panel-body" class="min-w-0">
    <div class="mb-1.5 flex flex-wrap items-center gap-2">
      <!-- 侧栏紧凑形态（#308）：区块标题已由折叠条承担，这里不再重复一遍（约 163px 宽） -->
      <h3 v-if="props.variant === 'table'" class="text-sm font-semibold">{{ props.scope === 'fde' ? t('previewPorts.adminTitle', { fde: props.fdeName ?? '' }) : t('previewPorts.title') }}</h3>
      <button
        type="button"
        data-test="preview-ports-retry"
        class="rounded-md border border-black/15 px-2 py-0.5 text-xs hover:bg-black/5 disabled:opacity-50"
        :disabled="props.loading"
        @click="emit('retry')"
      >{{ t('common.retry') }}</button>
      <!-- #247 一键开整组：只在点击时签（一次点击 = 签 + 开，无二次确认——票 60 秒过期）。
           列表为空时不渲染（没东西可开）；签票中/批量中一律禁用（票是一次性的，并发签等于白签）。 -->
      <button
        v-if="props.showOpenAll && props.items.length > 0"
        type="button"
        data-test="preview-open-all"
        class="ml-auto rounded-md border border-brand/40 bg-brand/5 px-2 py-0.5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
        :disabled="props.batchBusy || props.ticketBusyId !== null"
        @click="emit('open-all')"
      >{{ props.batchBusy ? t('previewPorts.batchSigning') : t('previewPorts.openAllAction') }}</button>
    </div>

    <!-- 加载中（首屏骨架；已有列表时刷新不抽掉列表，只在按钮上体现） -->
    <div v-if="props.loading && !props.loaded" data-test="preview-ports-loading" role="status">
      <p class="muted text-sm">{{ t('common.loading') }}</p>
      <div v-for="n in 3" :key="n" class="my-1 h-6 animate-pulse rounded bg-black/[0.07]"></div>
    </div>

    <!-- 失败：错误码 + 服务端原文 + 重试（admin 无 FDE 不算失败，那是空列表） -->
    <p v-if="props.error" data-test="preview-ports-error" class="syserr mb-1.5 flex flex-wrap items-center gap-2" role="alert">
      <span>{{ loadErrorText(props.error) }}</span>
    </p>

    <!-- 空态：本人（还没分段 / admin 自己没有 FDE）与他人（已下线）两种口径 -->
    <p
      v-if="!props.error && props.loaded && props.items.length === 0"
      data-test="preview-ports-empty"
      class="muted py-2 text-sm"
      role="status"
    >{{ props.scope === 'fde' ? t('previewPorts.emptyFde') : t('previewPorts.emptySelf') }}</p>

    <template v-if="props.items.length > 0">
      <!-- 观测层 MVP：同一目录/仓库 ≥2 个监听（真机实证：两个分支的 dev server 各占一口）。
           不能阻止就显性呈现：哪个号上是哪个分支、起了多久，让人自己判断要点哪个。 -->
      <div
        v-if="duplicateGroups.length > 0"
        data-test="preview-observed-duplicates"
        class="mb-1.5 rounded-md border border-amber-500/60 bg-amber-50 px-2 py-1 text-[11px] leading-[1.5] text-amber-900"
        role="alert"
      >
        <p v-for="group in duplicateGroups" :key="group.cwd" data-test="preview-observed-duplicate-line">
          {{ t('previewPorts.duplicateWarn', { cwd: group.cwd, ports: group.ports.join(', ') }) }}
        </p>
      </div>
      <table v-if="props.variant === 'table'" data-test="preview-ports-table" class="w-full table-fixed text-left text-sm">
        <colgroup>
          <col class="w-[14%]">
          <col class="w-[52%]">
          <col class="w-[20%]">
          <col class="w-[14%]">
        </colgroup>
        <thead class="border-b border-black/10 text-xs text-black/55">
          <tr>
            <th scope="col" class="py-1 font-medium">{{ t('previewPorts.colPort') }}</th>
            <th scope="col" class="py-1 font-medium">{{ t('previewPorts.colHostname') }}</th>
            <th scope="col" class="py-1 font-medium">{{ t('previewPorts.colState') }}</th>
            <th scope="col" class="py-1 text-right font-medium">{{ t('previewPorts.colActions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in primaryItems" :key="item.id" data-test="preview-port-row" class="border-b border-black/10 last:border-b-0">
            <td class="py-1.5 font-medium" data-test="preview-port-value">{{ item.port }}</td>
            <td class="truncate py-1.5">
              <button
                v-if="item.url"
                type="button"
                data-test="preview-port-hostname"
                class="w-full truncate rounded px-1 py-0.5 text-left hover:bg-black/5"
                :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
                @click="copyUrl(item)"
              >{{ item.hostname }}</button>
              <span v-else data-test="preview-port-unrouted" class="text-black/45">—</span>
              <p
                v-if="item.observed"
                data-test="preview-port-observed"
                class="truncate px-1 text-[11px] text-black/55"
                :title="observedTitle(item.observed)"
              >{{ observedText(item.observed, observedHere(item)) }}</p>
            </td>
            <td class="py-1.5">
              <span
                data-test="preview-port-state"
                class="rounded-full border px-2 py-0.5 text-xs"
                :class="item.state === 'active'
                  ? 'border-sky-500/40 bg-sky-50 text-sky-800'
                  : 'border-black/20 bg-black/5 text-black/60'"
              >{{ stateLabel(item.state) }}</span>
            </td>
            <td class="py-1.5 text-right">
              <button
                v-if="item.url"
                type="button"
                data-test="preview-port-open"
                class="rounded-md bg-brand px-2 py-0.5 text-xs text-white hover:bg-brand-hover disabled:opacity-50"
                :disabled="props.ticketBusyId !== null"
                @click="emit('open', item)"
              >{{ props.ticketBusyId === item.id ? t('previewPorts.signing') : t('previewPorts.openAction') }}</button>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 紧凑形态（#308，左侧栏约 163px 宽）：一行 = 端口 + 短状态（完整口径在 title/aria-label）+ 打开按钮；
           第二行 = 可截断 hostname（点击复制**完整 url**，title 里也是完整 url）。
           宽度纪律：每一层都带 min-w-0，hostname 是 block w-full truncate ⇒ 再长的域名也不会横向撑破面板。 -->
      <ul v-else data-test="preview-ports-list" class="min-w-0">
        <li
          v-for="item in primaryItems"
          :key="item.id"
          data-test="preview-port-row"
          class="min-w-0 border-b border-black/10 py-1.5 last:border-b-0"
        >
          <div class="flex min-w-0 items-center gap-1.5">
            <span data-test="preview-port-value" class="shrink-0 text-[11px] font-medium leading-[1.4]">{{ item.port }}</span>
            <span
              v-if="item.url"
              data-test="preview-port-state"
              class="min-w-0 shrink truncate rounded-full border px-1.5 py-[1px] text-[10px] leading-[1.4]"
              :class="item.state === 'active'
                ? 'border-sky-500/40 bg-sky-50 text-sky-800'
                : 'border-black/20 bg-black/5 text-black/60'"
              :title="stateLabel(item.state)"
              :aria-label="stateLabel(item.state)"
            >{{ stateShortLabel(item.state) }}</span>
            <button
              v-if="item.url"
              type="button"
              data-test="preview-port-open"
              class="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-black/15 bg-white text-black/60 hover:bg-black/10 disabled:opacity-50"
              :disabled="props.ticketBusyId !== null"
              :title="props.ticketBusyId === item.id ? t('previewPorts.signing') : t('previewPorts.openAction')"
              :aria-label="props.ticketBusyId === item.id ? t('previewPorts.signing') : t('previewPorts.openAction')"
              @click="emit('open', item)"
            >
              <svg
                v-if="props.ticketBusyId === item.id"
                class="animate-spin"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <svg
                v-else
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
            </button>
          </div>
          <button
            v-if="item.url"
            type="button"
            data-test="preview-port-hostname"
            class="mt-0.5 block w-full min-w-0 truncate rounded px-0.5 py-0.5 text-left text-[11px] leading-[1.4] text-black/70 hover:bg-black/5"
            :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
            @click="copyUrl(item)"
          >{{ item.hostname }}</button>
          <p
            v-else
            data-test="preview-port-unrouted"
            class="mt-0.5 text-[10px] leading-[1.4] text-black/50"
          >{{ t('previewPorts.unroutedNote') }}</p>
          <!-- 观测注解（有则显，无观测不加任何反向文案——null ≠ 空闲）；本目录在用时挂徒章。 -->
          <p
            v-if="item.observed"
            data-test="preview-port-observed"
            class="mt-0.5 flex min-w-0 items-center gap-1 text-[10px] leading-[1.4] text-black/55"
            :title="observedTitle(item.observed)"
          >
            <span
              v-if="observedHere(item)"
              data-test="preview-port-observed-here"
              class="shrink-0 rounded-full border border-emerald-600/40 bg-emerald-50 px-1 text-emerald-800"
            >{{ t('previewPorts.observedHere') }}</span>
            <span class="min-w-0 truncate">{{ observedText(item.observed, observedHere(item)) }}</span>
          </p>
        </li>
        <!-- 过滤态下当前目录无在用端口：不谎报空列表（分配仍在），给一行说明。 -->
        <li
          v-if="filterToDir && primaryItems.length === 0"
          data-test="preview-port-none-here"
          class="muted py-2 text-[11px] leading-[1.5]"
          role="status"
        >{{ t('previewPorts.noneHere') }}</li>
      </ul>

      <!-- 过滤态的兑底折叠区：别的目录在用 + 无观测的冷余量。默认收起，签票/复用入口不丢。 -->
      <div v-if="filterToDir && otherItems.length > 0" class="mt-1">
        <button
          type="button"
          data-test="preview-ports-others-toggle"
          class="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10px] font-medium text-black/55 hover:bg-black/5"
          :aria-expanded="othersOpen"
          @click="othersOpen = !othersOpen"
        >
          <span aria-hidden="true">{{ othersOpen ? '▾' : '▸' }}</span>
          <span>{{ othersOpen ? t('previewPorts.othersCollapse') : t('previewPorts.othersExpand', { count: otherItems.length }) }}</span>
        </button>
        <ul v-if="othersOpen" data-test="preview-ports-others" class="min-w-0">
          <li
            v-for="item in otherItems"
            :key="item.id"
            data-test="preview-port-other-row"
            class="min-w-0 border-b border-black/10 py-1.5 last:border-b-0"
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <span data-test="preview-port-value" class="shrink-0 text-[11px] font-medium leading-[1.4]">{{ item.port }}</span>
              <span
                data-test="preview-port-state"
                class="min-w-0 shrink truncate rounded-full border px-1.5 py-[1px] text-[10px] leading-[1.4]"
                :class="item.state === 'active'
                  ? 'border-sky-500/40 bg-sky-50 text-sky-800'
                  : 'border-black/20 bg-black/5 text-black/60'"
                :title="stateLabel(item.state)"
                :aria-label="stateLabel(item.state)"
              >{{ stateShortLabel(item.state) }}</span>
              <button
                type="button"
                data-test="preview-port-open"
                class="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] border border-black/15 bg-white text-black/60 hover:bg-black/10 disabled:opacity-50"
                :disabled="props.ticketBusyId !== null"
                :title="props.ticketBusyId === item.id ? t('previewPorts.signing') : t('previewPorts.openAction')"
                :aria-label="props.ticketBusyId === item.id ? t('previewPorts.signing') : t('previewPorts.openAction')"
                @click="emit('open', item)"
              >↗</button>
            </div>
            <p
              v-if="item.observed"
              data-test="preview-port-observed"
              class="mt-0.5 min-w-0 truncate text-[10px] leading-[1.4] text-black/55"
              :title="observedTitle(item.observed)"
            >{{ observedText(item.observed) }}</p>
          </li>
        </ul>
      </div>

      <p class="muted mt-1" :class="props.variant === 'list' ? 'text-[11px] leading-[1.5]' : 'text-xs'">{{ t('previewPorts.stateHint') }}</p>
      <p v-if="copyError" data-test="preview-port-copy-error" class="syserr mt-1 text-xs" role="alert">{{ copyError }}</p>
      <p v-else-if="copiedId" data-test="preview-port-copied" class="mt-1 text-xs text-green-700" role="status">
        {{ t('previewPorts.copiedUrl') }}
      </p>
    </template>

    <!-- 签票失败（429 rate_limited / 404 等）：错误码 + 服务端原文 -->
    <p
      v-if="props.ticketError"
      data-test="preview-ticket-error"
      class="syserr mt-1.5 text-sm"
      role="alert"
    >{{ ticketErrorText(props.ticketError) }}</p>

    <!-- #247 批量签票失败（整批不返回半截）：错误码 + 服务端原文 -->
    <p
      v-if="props.batchError"
      data-test="preview-batch-error"
      class="syserr mt-1.5 text-sm"
      role="alert"
    >{{ batchErrorText(props.batchError) }}</p>

    <!-- 弹窗被拦截：给同一条带票地址的兜底链接（ticket 仍然只在这条链接里，不进当前页 URL） -->
    <p
      v-if="props.popupBlockedUrl"
      data-test="preview-popup-blocked"
      class="mt-1.5 rounded-md border border-amber-500/60 bg-amber-50 px-2 py-1 text-xs text-amber-900"
      role="status"
    >
      {{ t('previewPorts.popupBlocked') }}
      <a
        class="underline"
        :href="props.popupBlockedUrl"
        target="_blank"
        rel="noopener"
        data-test="preview-popup-fallback-link"
      >{{ t('previewPorts.popupBlockedLink') }}</a>
    </p>

    <!-- #247 批量：浏览器拦了部分新标签 ⇒ 逐个给可点链接兜底（**不得静默**）。
         样式复用上面那条告警（不新增 UI 结构），只是链接从 1 个变成 N 个。 -->
    <p
      v-if="props.batchBlockedUrls.length > 0"
      data-test="preview-batch-blocked"
      class="mt-1.5 rounded-md border border-amber-500/60 bg-amber-50 px-2 py-1 text-xs text-amber-900"
      role="status"
    >
      {{ t('previewPorts.batchBlocked') }}
      <template v-for="(url, index) in props.batchBlockedUrls" :key="url">
        <a
          class="underline"
          :href="url"
          target="_blank"
          rel="noopener"
          data-test="preview-batch-fallback-link"
        >{{ blockedLinkLabel(url) }}</a><span v-if="index < props.batchBlockedUrls.length - 1"> · </span>
      </template>
    </p>
  </div>
</template>
