// issue #808：额度/用量的**判断源**（唯一）。管理台「周期 / 用量」列与用户面徽标共用同一套判断，
// 避免「已用标签」在两处各写一遍而漂移。这里只放**判断**，不放文案——文案各自面用自己的 i18n key
// （管理台措辞不搬到用户面）。金额格式化统一在 `lib/money.ts` 的 `fmtUsdCompact`，本模块不碰。
//
// `UsageRowLike` 是**结构化最小类型**：不 import stores 里的 `KeyUsageRow`/`MyQuota`，否则 lib 反向依赖 store。
// 两个来源（admin bulk 行、`/api/me/llm-quota` 的 quota）都结构兼容它。
export interface UsageRowLike {
  spend?: number | null;
  spend_scope?: string | null;
  budget_duration?: string | null;
  budget_period?: string | null;
  max_budget?: number | null;
  budget_usd?: number | null;
  budget_reset_at?: string | null;
}

export type UsageKind = 'unknown' | 'period' | 'lifetime';

/**
 * 一行额度数据 ⇒ 该格属于哪种语义。
 * row 为空 / `spend == null` / `spend_scope == null` ⇒ `'unknown'`（**不得当成 0**——无读数与 0 花费是两回事）。
 * `spend_scope === 'lifetime'` ⇒ `'lifetime'`（终身累计，措辞里绝不能出现「本周期/本月」）；其余非空 ⇒ `'period'`。
 */
export function usageKindOf(row: UsageRowLike | null | undefined): UsageKind {
  if (!row || row.spend == null || row.spend_scope == null) return 'unknown';
  if (row.spend_scope === 'lifetime') return 'lifetime';
  return 'period';
}

/**
 * 周期归一化：**网关 `budget_duration` 优先**（`spend` 就是按它归零的，跟钱走不跟配置走），
 * 没有才回落 DB `budget_period`。白名单（`'1d'` / `'1mo'`）外（`'7d'`/`'30d'`/`'1m'`/空串/其它）⇒ `null`，
 * **不许猜成日/月**——猜错就是把一周的钱当成一个月的钱。
 * 用 `??` 链（与既有 `usageCell` 逐字同口径）：`budget_duration` 为空串也算「网关说了」，不回落到 DB。
 */
export function usageCadenceOf(row: UsageRowLike | null | undefined): '1d' | '1mo' | null {
  const cadence = row?.budget_duration ?? row?.budget_period ?? null;
  return cadence === '1d' || cadence === '1mo' ? cadence : null;
}

/**
 * 进度百分比（0–100，超额也钳到 100）。`budget` 为空 / `<= 0` ⇒ `null`（调用方**不画进度条**，别画成 0%）。
 * `spend` 为空 ⇒ 同样 `null`（没有读数就没有进度，别拿 0 冒充）。
 */
export function usagePercentUsed(
  spend: number | null | undefined,
  budget: number | null | undefined,
): number | null {
  if (budget == null || !(budget > 0)) return null;
  if (spend == null || !Number.isFinite(spend)) return null;
  const pct = (spend / budget) * 100;
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/**
 * 超额金额（`> 0` 表示超了）。没额度（budget 空/`<=0`）或没超 ⇒ `null`（调用方不显示超额句）。
 * `spend` 为空 ⇒ `null`（无读数不谈超额）。
 */
export function usageOverage(
  spend: number | null | undefined,
  budget: number | null | undefined,
): number | null {
  if (budget == null || !(budget > 0)) return null;
  if (spend == null || !Number.isFinite(spend)) return null;
  const over = spend - budget;
  return over > 0 ? over : null;
}
