// issue #800：用户列表「周期 / 用量」列的金额格式化——窄列要**定长**，
// 不能借用 UserLlmPane 里的 fmtUsd（6 位小数截尾，会吐出 `$5.091148` 这种长串塞不进列）。
// 规则（工单定稿，逐条对应 spec）：
//   · null / 非有限（NaN、±Infinity）⇒ `—`
//   · value === 0                     ⇒ `$0.00`
//   · 非零但**量级** < 0.005            ⇒ `<$0.01`（小于最小可显示面额，但不谎报成 $0.00）
//   · 其余                            ⇒ `$` + 两位小数（四舍五入）；负数用 `-$0.20`（不是 `$-0.20`）
export function fmtUsdCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  // 极小非零（包括 −1e-9 这种网关修正）走「不足一分」：加负号会变成 `-$0.00`，那句同时说了
  // 「有」和「零」，是假数；这里的断言是**量级**，符号在这个宽度上没有信息量（评审 NIT）。
  if (Math.abs(value) < 0.005) return '<$0.01';
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}
