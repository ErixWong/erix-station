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
import { onScopeDispose, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  asPreviewPortState,
  type PreviewApiError,
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
  /** 'me' = 本人端口（GET /api/me/ports）；'fde' = 管理员代看某个 FDE。 */
  scope?: 'me' | 'fde';
  fdeName?: string | null;
  /**
   * 形态：'table' = 宽容器（管理台，默认）；'list' = 侧栏紧凑行（#308，约 163px 宽）。
   * 两种形态共用状态文案、错误文案、空态与拦截兜底——只是行内布局分叉。
   */
  variant?: 'table' | 'list';
}>(), {
  error: null,
  ticketBusyId: null,
  ticketError: null,
  popupBlockedUrl: null,
  scope: 'me',
  fdeName: null,
  variant: 'table',
});

const emit = defineEmits<{
  (e: 'retry'): void;
  (e: 'open', item: PreviewPortItem): void;
}>();

const { t } = useI18n();

const copiedId = ref<string | null>(null);
const copyError = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

/** 复制的是完整 `url`（含 scheme 与 dev 端口后缀），显示的是 hostname（§4.7a 两字段各自用途）。 */
async function copyUrl(item: PreviewPortItem) {
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

function ticketErrorText(error: PreviewApiError): string {
  return t('previewPorts.ticketFailed', { code: error.code, message: error.message });
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
          <tr v-for="item in props.items" :key="item.id" data-test="preview-port-row" class="border-b border-black/10 last:border-b-0">
            <td class="py-1.5 font-medium" data-test="preview-port-value">{{ item.port }}</td>
            <td class="truncate py-1.5">
              <button
                type="button"
                data-test="preview-port-hostname"
                class="w-full truncate rounded px-1 py-0.5 text-left hover:bg-black/5"
                :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
                @click="copyUrl(item)"
              >{{ item.hostname }}</button>
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
          v-for="item in props.items"
          :key="item.id"
          data-test="preview-port-row"
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
            type="button"
            data-test="preview-port-hostname"
            class="mt-0.5 block w-full min-w-0 truncate rounded px-0.5 py-0.5 text-left text-[11px] leading-[1.4] text-black/70 hover:bg-black/5"
            :title="t('previewPorts.hostnameCopyTitle', { url: item.url })"
            @click="copyUrl(item)"
          >{{ item.hostname }}</button>
        </li>
      </ul>

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
  </div>
</template>
