// 预览端口面板的数据层（#246 交付② 单 B；契约 docs/api/portal.md §4.7a / §2.8）。
// 不可让的语义（都在此实现，视图只负责画）：
//   ① 列端点吃 GET /api/me/ports（本人）或 GET /api/admin/fdes/:fdeName/ports（管理员代看）；
//   ② 预览 ticket **只在点击当场签**（60 秒过期且一次性 ⇒ 预取/缓存就是把它用废了），
//      并且绝不把 ticket 写进当前页 URL（新开标签是唯一出口）；
//   ③ 错误按结构化 {status, code, message, field} 往外抛，文案由视图走 i18n 组装
//      （服务端 message 原文透传，不翻译、不吞成「操作失败」）。
//   ④ 列表自动保鲜：观测层每 15s 刷新服务端，前端 30s 轮询 + 回到前台即刷——
//      「重试」按钮因此退场（业务用户不该为新鲜数据手动点击）。
// #247 批量链（openAllPreviews/batch*）已随「打开全部预览」下线：票只在点击当场签的纪律没变，
// 变的是产品前提——观测层已能回答「哪个口真有服务」，10 标签页盲开没有存在理由（后端批量端点保留）。
import { computed, onScopeDispose, ref } from 'vue';
import { api } from '../api';
import {
  adminFdePortsBlockPath,
  adminFdePortsPath,
  currentBlockRange,
  myPortsPath,
  previewTargetUrl,
  previewTicketPath,
  toPreviewApiError,
  type PreviewApiError,
  type PreviewBlockMoveResult,
  type PreviewPortItem,
  type PreviewTicketResponse,
} from '../lib/previewPorts';

export interface UsePreviewPortsOptions {
  /**
   * 要列谁的端口：返回 FDE 名 = 管理员面端点；返回 null/undefined = 本人端点。
   * 用 getter 而不是 Ref：调用方（面板/管理台）自己决定何时重载，composable 不猜。
   */
  fdeName?: () => string | null | undefined;
}

/** 列表端点的响应信封（§4.7a：两个列端点同形 `{ items: [...] }`）。 */
interface PortsResponse {
  items?: PreviewPortItem[];
}

export function usePreviewPorts(options: UsePreviewPortsOptions = {}) {
  const items = ref<PreviewPortItem[]>([]);
  const loading = ref(false);
  const loaded = ref(false);
  const listError = ref<PreviewApiError | null>(null);
  /** 正在签票的行 id（行内「签发中…」反馈，兼当并发闸门）。 */
  const ticketBusyId = ref<string | null>(null);
  const ticketError = ref<PreviewApiError | null>(null);
  /** 新标签被浏览器拦截时的兜底链接（ticket 不在当前页 URL 上，只在这个链接里）。 */
  const popupBlockedUrl = ref<string | null>(null);

  let reqSeq = 0; // 请求序号守卫：迟到响应不得覆盖新目标（换 FDE / 重试）的列表

  function portsPath(): string {
    const fdeName = options.fdeName?.();
    return fdeName ? adminFdePortsPath(fdeName) : myPortsPath;
  }

  /** 拉列表。加载中重复调用直接忽略（重试按钮连点不打第二条 GET）。 */
  async function load(): Promise<void> {
    const mySeq = ++reqSeq;
    loading.value = true;
    listError.value = null;
    try {
      const data = await api<PortsResponse>(portsPath());
      if (mySeq !== reqSeq) return;
      items.value = Array.isArray(data?.items) ? data.items : [];
      loaded.value = true;
    } catch (err) {
      if (mySeq !== reqSeq) return;
      listError.value = toPreviewApiError(err);
      // 失败保留旧列表（与 useSessionBrowser 同口径）：错误条 + 重试，不闪成空白。
    } finally {
      if (mySeq === reqSeq) loading.value = false;
    }
  }

  /**
   * 「打开预览」：点击当场签票 → 新标签打开 `<url>/?preview_ticket=<ticket>`。
   * 新标签**同步**开（点击手势内）、地址**异步**填：await 之后再 window.open 会被弹窗拦截器吃掉。
   * 返回结果供视图决定要不要给额外反馈（拦截兜底已由 popupBlockedUrl 承载）。
   */
  async function openPreview(item: PreviewPortItem): Promise<'opened' | 'blocked' | 'failed'> {
    // 一次只签一张票（票是一次性的，并发签等于白签）。
    if (ticketBusyId.value) return 'failed';
    ticketBusyId.value = item.id;
    ticketError.value = null;
    popupBlockedUrl.value = null;
    const tab = openBlankTab();
    try {
      const signed = await api<PreviewTicketResponse>(previewTicketPath(item.id), {
        method: 'POST',
        body: '{}', // 后端 requireJson：空 JSON 体（无业务字段）
      });
      const target = previewTargetUrl(signed);
      if (tab) navigateTab(tab, target);
      else popupBlockedUrl.value = target;
      return tab ? 'opened' : 'blocked';
    } catch (err) {
      tab?.close(); // 签票失败 ⇒ 收回那张空白标签，不留「僵尸标签」
      ticketError.value = toPreviewApiError(err);
      return 'failed';
    } finally {
      ticketBusyId.value = null;
    }
  }

  /**
   * 自动保鲜（观测层时代：服务端每 15s 刷新观测，手动「重试」退场）：
   * 30s 轮询 + 回到前台立即刷一次。load() 自带 reqSeq 守卫与加载中去重，轮询不会打穿。
   */
  const pollTimer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
  }, 30_000);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void load();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  /** 当前段起止（改块确认文案要点名旧段；空列表 → null）。 */
  const blockRange = computed(() => currentBlockRange(items.value));

  onScopeDispose(() => {
    reqSeq++; // 组件卸载：在途响应作废
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  });

  return {
    items,
    loading,
    loaded,
    listError,
    ticketBusyId,
    ticketError,
    popupBlockedUrl,
    blockRange,
    load,
    openPreview,
  };
}

/** 改块结果 + 结构化错误的判返回（视图按 code/field 分支，文案一律走 i18n）。 */
export type PreviewBlockMoveOutcome =
  | { ok: true; result: PreviewBlockMoveResult }
  | { ok: false; error: PreviewApiError };

/**
 * 发一次改块请求（**只在二次确认之后**由调用方调用——确认闸门在视图层，
 * 单测钉「未确认不得发出 POST」）。body 恒为 `{ block_start: <整数> }`。
 */
export async function requestBlockMove(
  fdeName: string,
  blockStart: number,
): Promise<PreviewBlockMoveOutcome> {
  try {
    const result = await api<PreviewBlockMoveResult>(adminFdePortsBlockPath(fdeName), {
      method: 'POST',
      body: JSON.stringify({ block_start: blockStart }),
    });
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: toPreviewApiError(err) };
  }
}

// ---------------------------------------------------------------------------
// 新标签开合（jsdom 里 window.open 返回 null ⇒ 走拦截兜底，单测用 vi.stubGlobal('open', …) 驱动）
// ---------------------------------------------------------------------------

interface PreviewTab {
  location: { href: string };
  opener?: unknown;
  close(): void;
}

/**
 * 同步开一张空白标签（必须在点击手势的同步段里调用，否则会被弹窗拦截）。
 * 不带 `noopener`：要拿住句柄才能事后填地址；随即把 `opener` 置空（见 navigateTab），
 * 预览应用拿不到本站句柄，等价于 noopener。
 */
function openBlankTab(): PreviewTab | null {
  if (typeof window === 'undefined' || typeof window.open !== 'function') return null;
  const tab = window.open('', '_blank');
  return tab as unknown as PreviewTab | null;
}

/** 把签好的票地址填进那张空白标签，同时断掉 `opener`（防预览页反向操纵 portal 标签）。 */
function navigateTab(tab: PreviewTab, url: string): void {
  try {
    tab.location.href = url;
    tab.opener = null;
  } catch {
    /* 标签已被用户手动关掉：静默（票仍在 popupBlockedUrl 之外，不重复签） */
  }
}
