// issue #808：用户面「我自己的额度/用量」数据层。形状照 `useGitLight.ts`（那里又照 `usePreviewPorts.ts`）：
// 每次调用新建（不是模块级单例）、闭包 `reqSeq` 竞态守卫、`onScopeDispose` 收摊、失败**保留旧值** + 记错误。
//
// 显示口径全在 `lib/usageLabel.ts`（判断）+ `UsageBadge.vue`（文案）；本层只管取数与作废。
// 与 useGitLight 的差异：额度是**人**的维度（不随目录变），故没有 `cwd` 依赖、切目录不 reset。
import { onScopeDispose, ref } from 'vue';
import { api, toDisplayText } from '../api';

/** `GET /api/me/llm-quota` 的 `quota`（字段逐字同 §4.10 GET budget；查不到/无读数一律 `null`）。 */
export interface MyQuota {
  budget_usd: number | null;
  budget_period: string | null;
  max_budget: number | null;
  budget_duration: string | null;
  budget_reset_at: string | null;
  spend: number | null;
  remaining: number | null;
  spend_scope: 'period' | 'lifetime' | null;
}

/** `GET /api/me/llm-usage` 的日聚合行（形状逐字同 §4.10 usage）。 */
export interface MyUsageDay {
  date: string;
  spend: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  api_requests: number | null;
}

/** `GET /api/me/llm-usage` 的 `totals`（§2.15：区间内日行的求和）。**可空**：响应里没带 /
 *  字段脏 ⇒ `null`（调用方不出那一行，**不许**拿 0 冒充「没花钱」）。 */
export interface MyUsageTotals {
  spend: number;
  total_tokens: number;
}

/** 额度轮询周期：60s（**不是 30s**）——网关把 key 花费写回聚合态默认 60s 一拍（§2.14 缓存口径），
 *  比这更快的轮询只会放大网关压力而不增加信息。 */
const QUOTA_POLL_MS = 60_000;

function toMessage(err: unknown): string {
  // `api()` 抛的 ApiError.message 已是可显示句子（服务端 error.message 透传，或兜底「请求失败（HTTP n）」）。
  const text = err instanceof Error ? err.message : toDisplayText(err);
  return text || 'unavailable';
}

export function useMyUsage() {
  const quota = ref<MyQuota | null>(null);
  const reason = ref<string | null>(null);
  const loading = ref(false);
  const loaded = ref(false);
  /** 一句可显示的话（别把 Error 对象塞进模板）。`no_binding` 是空态**不是**错误 ⇒ 这里保持 null。 */
  const error = ref<string | null>(null);

  const days = ref<MyUsageDay[]>([]);
  /** 近 30 天合计（来自响应的 `totals`）；拿不到 ⇒ `null`（弹窗就不出那一行）。 */
  const totals = ref<MyUsageTotals | null>(null);
  const usageLoading = ref(false);
  const usageError = ref<string | null>(null);

  let reqSeq = 0; // 迟到的额度响应不得覆盖新一轮（run 结束刷 vs 轮询撞车时，认最新一次）
  let usageReqSeq = 0;

  /** 作废在途请求并清掉旧读数（登出/换账号时可调用）。 */
  function reset(): void {
    reqSeq++;
    usageReqSeq++;
    quota.value = null;
    reason.value = null;
    loaded.value = false;
    loading.value = false;
    error.value = null;
    days.value = [];
    totals.value = null;
    usageLoading.value = false;
    usageError.value = null;
  }

  /** 拉额度。成功含 `{ quota: null, reason: 'no_binding' }`（空态，error 保持 null）。 */
  async function load(): Promise<void> {
    const mySeq = ++reqSeq;
    loading.value = true;
    error.value = null;
    try {
      const data = await api<{ quota?: MyQuota | null; reason?: string | null }>('/api/me/llm-quota');
      if (mySeq !== reqSeq) return; // 已被更新的一轮（或已卸载）作废
      quota.value = data?.quota ?? null;
      reason.value = data?.reason ?? null;
      loaded.value = true;
    } catch (err) {
      if (mySeq !== reqSeq) return;
      error.value = toMessage(err);
      // 失败**保留旧 quota**（与 useGitLight 同口径）：徽标不会一闪变成「没有」，
      // 但 loaded 不变 ⇒ 视图仍能给出「上次结果 + 本次失败」。
    } finally {
      if (mySeq === reqSeq) loading.value = false;
    }
  }

  /** 拉近 30 天用量。**只在弹窗打开时被调用**（不在挂载预取）。 */
  async function loadUsage(): Promise<void> {
    const mySeq = ++usageReqSeq;
    usageLoading.value = true;
    usageError.value = null;
    try {
      const data = await api<{ days?: MyUsageDay[] | null; totals?: MyUsageTotals | null }>('/api/me/llm-usage?days=30');
      if (mySeq !== usageReqSeq) return;
      days.value = Array.isArray(data?.days) ? data.days : [];
      // totals 只在**形状可用**（对象且 spend 是有限数）时存；否则 `null`（宁可不显示，不出 $0.00 假数）。
      const rawTotals = data?.totals;
      totals.value = rawTotals && typeof rawTotals === 'object' && Number.isFinite(rawTotals.spend)
        ? { spend: rawTotals.spend, total_tokens: Number.isFinite(rawTotals.total_tokens) ? rawTotals.total_tokens : 0 }
        : null;
    } catch (err) {
      if (mySeq !== usageReqSeq) return;
      usageError.value = toMessage(err);
      // 失败保留旧 days（弹窗重开也不闪空）。
    } finally {
      if (mySeq === usageReqSeq) usageLoading.value = false;
    }
  }

  // 额度自动保鲜：60s 轮询 + 回前台立即刷；页面隐藏时不轮询（不打扰网关、不给睡眠标签攒请求）。
  const pollTimer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') void load();
  }, QUOTA_POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void load();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  onScopeDispose(() => {
    reqSeq++; // 卸载：在途响应作废
    usageReqSeq++;
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  });

  return { quota, reason, loading, loaded, error, days, totals, usageLoading, usageError, load, loadUsage, reset };
}
