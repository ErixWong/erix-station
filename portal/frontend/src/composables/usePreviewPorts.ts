// 预览端口面板的数据层（#246 交付② 单 B；契约 docs/api/portal.md §4.7a / §2.8）。
// 三条不可让的语义（都在此实现，视图只负责画）：
//   ① 列端点吃 GET /api/me/ports（本人）或 GET /api/admin/fdes/:fdeName/ports（管理员代看）；
//   ② 预览 ticket **只在点击当场签**（60 秒过期且一次性 ⇒ 预取/缓存就是把它用废了），
//      并且绝不把 ticket 写进当前页 URL（新开标签是唯一出口）；#247 的批量签票同一条纪律：
//      只有 `openAllPreviews()`（点击「打开全部预览」）会调批量端点，挂载/折叠/刷新一律不签；
//   ③ 错误按结构化 {status, code, message, field} 往外抛，文案由视图走 i18n 组装
//      （服务端 message 原文透传，不翻译、不吞成「操作失败」）。
import { computed, onScopeDispose, ref } from 'vue';
import { api } from '../api';
import {
  adminFdePortsBlockPath,
  adminFdePortsPath,
  batchTicketsPath,
  currentBlockRange,
  myPortsPath,
  previewTargetUrl,
  previewTicketPath,
  toPreviewApiError,
  type PreviewApiError,
  type PreviewBatchTicketsResponse,
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
  /** #247 批量签票：整批进行中（按钮禁用 + 防重复点击）。 */
  const batchBusy = ref(false);
  const batchError = ref<PreviewApiError | null>(null);
  /** #247：批量签完但**部分**新标签被拦截 ⇒ 这些带票地址的兜底链接列表（不得静默）。 */
  const batchBlockedUrls = ref<string[]>([]);

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
    // 一次只签一张票（票是一次性的，并发签等于白签）；#247 批量在途时同样挡下单张。
    if (ticketBusyId.value || batchBusy.value) return 'failed';
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
   * 「打开全部预览」（issue #247）：一次点击 = **签 + 开**，无二次确认。
   *
   * 三条纪律：
   *  ① **只在点击时签**（票 60 秒过期且一次性）——本函数是批量端点唯一的调用点，
   *     挂载/折叠/刷新都不调它（单测钉「挂载时批量端点请求数 = 0」）。
   *  ② 新标签在**点击手势的同步段**一次性开完（await 之后再 open 必被弹窗拦截器吃掉）。
   *     浏览器仍可能只放行第一个（多标签拦截）⇒ 拿不到窗口的那些地址进 `batchBlockedUrls`，
   *     由视图给可点链接兜底，**不静默**。
   *  ③ 签票失败 ⇒ 把本轮开的空白标签全收回，不留僵尸标签；错误进 `batchError`。
   */
  async function openAllPreviews(): Promise<'opened' | 'blocked' | 'failed'> {
    if (batchBusy.value || ticketBusyId.value) return 'failed'; // 并发闸门：一次只允许一批
    if (items.value.length === 0) return 'failed';
    batchBusy.value = true;
    batchError.value = null;
    batchBlockedUrls.value = [];
    popupBlockedUrl.value = null; // 上一轮单张的兜底链接不再适用
    ticketError.value = null;
    const requested = items.value.map((item) => item.id);
    const tabs = items.value.map(() => openBlankTab());
    try {
      const signed = await api<PreviewBatchTicketsResponse>(batchTicketsPath, {
        method: 'POST',
        // 显式传 id 列表：前端看到的行 = 这次要签的行（不给该字段会变成「服务端重算全部活行」，
        // 列表与签票结果就可能不是同一组）。顺序即列表顺序。
        body: JSON.stringify({ allocation_ids: requested }),
      });
      const list = Array.isArray(signed?.items) ? signed.items : [];
      const blocked: string[] = [];
      // 按 id 对账（服务端保证顺序与请求一致，这里再按 id 回填，防止「票填到别的标签」）。
      const byId = new Map(list.map((item) => [item.id, item]));
      requested.forEach((id, index) => {
        const signedItem = byId.get(id);
        const tab = tabs[index] ?? null;
        if (!signedItem) {
          tab?.close(); // 服务端没给这一行（理论不可达）：不留空白标签
          return;
        }
        const target = previewTargetUrl(signedItem);
        if (tab) navigateTab(tab, target);
        else blocked.push(target);
      });
      batchBlockedUrls.value = blocked;
      return blocked.length > 0 ? 'blocked' : 'opened';
    } catch (err) {
      for (const tab of tabs) tab?.close();
      batchError.value = toPreviewApiError(err);
      return 'failed';
    } finally {
      batchBusy.value = false;
    }
  }

  /** 当前段起止（改块确认文案要点名旧段；空列表 → null）。 */
  const blockRange = computed(() => currentBlockRange(items.value));

  onScopeDispose(() => {
    reqSeq++; // 组件卸载：在途响应作废
  });

  return {
    items,
    loading,
    loaded,
    listError,
    ticketBusyId,
    ticketError,
    popupBlockedUrl,
    batchBusy,
    batchError,
    batchBlockedUrls,
    blockRange,
    load,
    openPreview,
    openAllPreviews,
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
