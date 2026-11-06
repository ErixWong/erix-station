// issue #466：composer 输入框按内容自适应高度。
//
// 这里只放**纯计算**，不碰 DOM。原因（工单口径，见 issue #466 / AGENTS §4）：jsdom 不做真实布局，
// `scrollHeight` 恒为 0，把「撑高」的逻辑写在组件里就只能断言一个恒真的 0，测了等于没测。
// 高度算法在本文件用真数字钉死，组件侧只负责「量一个数、写一个数」，DOM 层断言样式确实落到了
// textarea 上——两层各管一段，任何一段掉地上都看得见。

/**
 * 最小高度 = 改动前钉死的那句 `height: 3.2rem`（`ComposerBar.vue` 的历史内联样式）。
 * 空输入时算出来的就是它 ⇒ 视觉上「什么都不变」，本单不许改变未输入时的界面。
 */
export const COMPOSER_MIN_HEIGHT_REM = 3.2;

/**
 * 高度预算 = 视口高的 40%。
 *
 * ⚠ 刻意用**比例**而不是固定像素：composer 与流区（`WorkbenchView.vue` 的 `flex-1 overflow-auto`）
 * 抢同一屏，钉死像素就只在设计它的那块屏幕上成立。40% 的量级参照同仓库既有口径
 * （`SidebarPanel.vue` 的底部堆叠区 `max-h-[50vh]` 也是预算而非固定值）——composer 比它更低，
 * 因为对话区必须始终占大头。视口变化（转屏、移动端键盘弹起）时组件会重算。
 */
export const COMPOSER_MAX_VIEWPORT_RATIO = 0.4;

/** 解析不出根字号时的兜底（浏览器默认 16px）。 */
export const DEFAULT_ROOT_FONT_PX = 16;

/**
 * 把 `getComputedStyle(document.documentElement).fontSize` 的返回值解析成 px 数字。
 * 非 `px` 结尾 / NaN / ≤0 一律兜底到 16——用户把根字号调大（无障碍常见）时 rem 预算要跟着长，
 * 而解析失败时**宁可退回默认值，也不要算出 0**（0 会让输入框塌成一条线）。
 */
export function parseRootFontPx(cssFontSize: string | null | undefined): number {
  const raw = (cssFontSize ?? '').trim();
  // 只认 `<数字>px`：`getComputedStyle(…).fontSize` 永远回 px，其他单位（rem/%/pt）进不来，
  // 而 `parseFloat('1rem')` 会读出 1 —— 直接拿来算会把输入框塌成 3.2px 的一条线。
  if (!/^\d+(\.\d+)?px$/.test(raw)) return DEFAULT_ROOT_FONT_PX;
  const px = Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : DEFAULT_ROOT_FONT_PX;
}

export interface ComposerBudget {
  minPx: number;
  maxPx: number;
}

/**
 * border-box 下要补回的高度差：`scrollHeight` 只含 content + padding，**不含 border**；
 * 而 Tailwind preflight 把全站设成 `box-sizing: border-box`，`style.height` 写的却是含边框的盒子高。
 * 不补这两像素，长文本会莫名少两个像素而被裁（内容高与盒子高不同源的典型形状）。
 *
 * `content-box` 下不补（那时 height 本来就不含边框）。只算上下边框，左右不影响高。
 * jsdom 加载不到 Tailwind 生成的 CSS ⇒ 那边这些值就是空或 0，本函数在单测里恒返回 0（不掺假数字），
 * 真值靠真浏览器验收（工单 §3）。
 */
export function borderBoxExtraPx(
  style: Pick<CSSStyleDeclaration, 'boxSizing' | 'borderTopWidth' | 'borderBottomWidth'>,
): number {
  if ((style?.boxSizing ?? '') !== 'border-box') return 0;
  const top = Number.parseFloat(style.borderTopWidth ?? '');
  const bottom = Number.parseFloat(style.borderBottomWidth ?? '');
  return (Number.isFinite(top) && top > 0 ? top : 0)
    + (Number.isFinite(bottom) && bottom > 0 ? bottom : 0);
}

/** 由视口高与根字号（**已是 px 数字**，组件侧先用 `parseRootFontPx` 解析）算出高度区间。 */
export function composerBudgetPx(viewportHeightPx: number, rootFontPx: number): ComposerBudget {
  const font = Number.isFinite(rootFontPx) && rootFontPx > 0 ? rootFontPx : DEFAULT_ROOT_FONT_PX;
  const minPx = COMPOSER_MIN_HEIGHT_REM * font;
  const vh = Number.isFinite(viewportHeightPx) && viewportHeightPx > 0 ? viewportHeightPx : 0;
  const maxPx = Math.max(minPx, vh * COMPOSER_MAX_VIEWPORT_RATIO);
  return { minPx, maxPx };
}

/**
 * 内容实测高 → 实际要写进 `style.height` 的像素值（夹在 [min, max] 里）。
 *
 * `scrollHeight` 不可信（NaN / 负数 / jsdom 的 0）时按 0 处理 ⇒ 结果落在 min，
 * 也就是「量不出来就退回改动前的样子」，不会把输入框撑没、也不会撑爆。
 */
export function composerHeightPx(scrollHeightPx: number, budget: ComposerBudget): number {
  const content = Number.isFinite(scrollHeightPx) && scrollHeightPx > 0 ? scrollHeightPx : 0;
  const min = Number.isFinite(budget?.minPx) && budget.minPx > 0 ? budget.minPx : 0;
  const max = Number.isFinite(budget?.maxPx) && budget.maxPx > 0 ? budget.maxPx : Infinity;
  const clamped = Math.min(Math.max(content, min), max);
  // 两位小数取齐：预算是视口**比例**，不取齐就会写出 `307.20000000000005px` 这种鬼东西
  // （写进 style 无害，但每次重算都产生新字符串，快照/断言/调试全在喂浮点噪声）。
  return Math.round(clamped * 100) / 100;
}
