// 手写 SVG 折线图的路径计算（issue #650 管理台「系统」面板）。**不引任何图表库**（issue 决定 5：
// 现依赖只有 vue/pinia/vue-i18n/vue-router/mermaid/qrcode，为四条折线引一份 Chart.js 不划算）。
//
// 本文件只做**数学**：数据点 → `d` 字符串。渲染（渐变、坐标标注、空态文案）在 `MetricChart.vue`。
//
// 三条会让图「说谎」的形状，都在这里显式处理（每条都有 `chartPath.spec.ts` 用例钉住）：
//   1. **空数组** ⇒ 空 path。没有点就没有线，绝不能画一条贴底的假线（那会被读成「一直是 0」）。
//   2. **单点** ⇒ 一条可渲染的短横线。`M x y` 后面没有第二段是**什么都不画**的，
//      而「一个点」在 30d 区间刚开始采样时是常态，画不出来就等于「没数据」。
//   3. **全等值**（`min === max`）⇒ 除以零 ⇒ 曾经会得到 `NaN`，整条 path 变 `M NaN NaN`
//      直接不渲染。这里退成**中线**：值是有意义的（恒等于常数），只是没有可画的幅度。
//
// y 轴方向：数学坐标 **y 向上**，SVG 坐标 **y 向下**，所以映射里必须翻转（判据 4）。
// 忘了翻转的图不会报错，只会「负载越高越贴底」——一眼看不出，但每个读图的人都会读反。

/** 一个数据点。`x` 通常是 epoch 毫秒（调用方自己从 ISO 串解析），`y` 是量值。 */
export interface ChartPoint {
  x: number;
  y: number;
}

export interface ChartGeometry {
  /** 折线的 `d`（`<path stroke>`）。没有可画的东西 ⇒ `''`（调用方据此走空态）。 */
  line: string;
  /** 面积填充的 `d`（`<path fill>`）。单点与空数组 ⇒ `''`（一条线没有「下方」可言）。 */
  area: string;
  /** 最后一个点的 **SVG 坐标**（画「当前值」圆点用）。无可画点 ⇒ `null`。 */
  last: ChartPoint | null;
}

/** 单点时短横线的半宽（像素）。画不出这条横线就是本文件存在的理由之一，取值只要「看得见」。 */
const SINGLE_POINT_DASH_HALF = 6;

/**
 * 坐标取整到 2 位小数：path 字符串会进 DOM 属性，`12.34567890123` 这种长度只让 diff 和
 * 快照噪音四倍化，视觉差别为零（视口宽度本来就是几十到几百像素的量级）。
 */
function r(value: number): number {
  return Math.round(value * 100) / 100;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 只保留 `x`/`y` 都是有限数的点；脏元素（`null`、`NaN`、`'abc'`、非对象）丢弃而不是打死整张图。 */
function usable(points: ChartPoint[] | null | undefined): ChartPoint[] {
  if (!Array.isArray(points)) return [];
  const out: ChartPoint[] = [];
  for (const point of points) {
    if (point === null || typeof point !== 'object') continue;
    const x = finiteOrNull(point.x);
    const y = finiteOrNull(point.y);
    if (x === null || y === null) continue;
    out.push({ x, y });
  }
  return out;
}

const EMPTY: ChartGeometry = { line: '', area: '', last: null };

/**
 * 数据点 → SVG path。
 *
 * @param points 数据点（**调用方保证 x 升序**；本函数不排序，因为「按时间」是调用方的口径）
 * @param width  视口宽度（SVG `viewBox` 的宽，不是 CSS 像素）
 * @param height 视口高度
 * @param min    y 轴下界；缺省 / 脏值 ⇒ 从数据推（`Math.min`）
 * @param max    y 轴上界；缺省 / 脏值 ⇒ 从数据推（`Math.max`）
 * @returns 空数组 / 视口不可用 ⇒ `{ line:'', area:'', last:null }`（**不抛**）
 *
 * ⚠ 上界**下界相等**（全等值）时不画贴底线也不画贴顶线，而是退到**中线**：
 * 贴顶/贴底会把「恒等于 40」渲染成「拉满」，而中线至少不撒谎说它碰到了边界。
 */
export function chartPath(
  points: ChartPoint[] | null | undefined,
  width: number,
  height: number,
  min?: number | null,
  max?: number | null,
): ChartGeometry {
  const givenMin = finiteOrNull(min);
  const givenMax = finiteOrNull(max);
  if (givenMin === null && givenMax === null) {
    // 缺界时先筛掉脏点再推（`usable()` 的结果）：让**同一个函数**决定「哪些点是点」。
    const given = usable(points);
    if (given.length === 0) return EMPTY;
    const ys = given.map((p) => p.y);
    return build(given, width, height, Math.min(...ys), Math.max(...ys));
  }
  return build(usable(points), width, height, givenMin, givenMax);
}

function build(
  pts: ChartPoint[],
  width: number,
  height: number,
  minIn: number | null,
  maxIn: number | null,
): ChartGeometry {
  const w = finiteOrNull(width);
  const h = finiteOrNull(height);
  if (pts.length === 0 || w === null || h === null || w <= 0 || h <= 0) return EMPTY;

  const xs = pts.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xSpan = Math.max(...xs) - xMin;
  // 界脏值 ⇒ 从数据推（只在一个方向脏时另一个方向照用调用方给的界）。
  const ys = pts.map((p) => p.y);
  const lo = minIn ?? Math.min(...ys);
  const hi = maxIn ?? Math.max(...ys);
  // 调用方给的界可能是「下界 > 上界」（脏值）：交换它，否则下面所有映射整体反掉。
  const yMin = Math.min(lo, hi);
  const yMax = Math.max(lo, hi);
  const ySpan = yMax - yMin;

  // x：等距映射到 [0, w]；所有点 x 相同（单点之外仍可能，比如只有一个桶）⇒ 居中。
  const sx = (x: number): number => (xSpan === 0 ? w / 2 : ((x - xMin) / xSpan) * w);
  // y：**翻转**（数学 y 向上、SVG y 向下）。`ySpan === 0` ⇒ 中线（判据 3：不许出 NaN）。
  const sy = (y: number): number => (ySpan === 0 ? midOfHeight(h) : h - ((y - yMin) / ySpan) * h);

  if (pts.length === 1) {
    // 单点：`M x y` 后面没有第二段是**什么都不画**的（而「只有一个桶」在刚开始采样时是常态）。
    // ⇒ 以该点为中心给一条短横线，y 仍按真实界走（调用方给了 0~100 而值是 80 ⇒ 横线在 20% 处，
    // 不是「只有一个点就摆中间」；没有界可走时才是中线）。
    const only = pts[0];
    const cx = r(sx(only.x));
    const cy = r(sy(only.y));
    const from = r(Math.max(0, cx - SINGLE_POINT_DASH_HALF));
    const to = r(Math.min(w, cx + SINGLE_POINT_DASH_HALF));
    return { line: `M ${from} ${cy} L ${to} ${cy}`, area: '', last: { x: cx, y: cy } };
  }

  const moves = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${r(sx(p.x))} ${r(sy(p.y))}`);
  const line = moves.join(' ');
  const firstX = r(sx(pts[0].x));
  const lastPoint = pts[pts.length - 1];
  const lastX = r(sx(lastPoint.x));
  // 面积：沿折线走到最右后落到基线（y = h），再回到最左封口。基线用**视口底边**而不是 min
  // 对应的行——渐变填充要有个「地面」，否则 `min > 0` 时底部会悬空一条缝。
  const area = `${line} L ${lastX} ${r(h)} L ${firstX} ${r(h)} Z`;
  return { line, area, last: { x: lastX, y: r(sy(lastPoint.y)) } };
}

/** `ySpan === 0` 的退路：中线（不是贴底、不是贴顶）。 */
function midOfHeight(height: number): number {
  return height / 2;
}

/**
 * 从一组量值推 y 轴上下界（`MetricChart` 的调用方用它算标注文字）。
 * 空 / 全脏 ⇒ `null`（调用方走空态，**不许**退成 `{min:0,max:0}` —— 那会把「没有数据」
 * 标成「0 ~ 0」，正是本单禁止的「把未知渲染成 0」）。
 */
export function valueBounds(values: (number | null | undefined)[] | null | undefined): { min: number; max: number } | null {
  if (!Array.isArray(values)) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const n = finiteOrNull(value);
    if (n === null) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return Number.isFinite(min) ? { min, max } : null;
}
