<script setup lang="ts">
// 手写 SVG 迷你折线图（issue #650）。**没有引任何图表库**（issue 决定 5：为四条折线引 Chart.js 不划算，
// 而本仓的依赖面是刻意守着的），数学全在 `lib/chartPath`（那里有用例钉住空/单点/全等值三种形状）。
//
// 三条渲染红线（工单 §检查点 B 第 3 条）：
//   1. **无数据显式说「该区间无数据」**，不画一条贴底的假线 —— 贴底线会被读成「一直是 0」，
//      而这里的空可能只是「DB 读不到」或「这个区间还没采到点」，两者都不是 0。
//   2. **Y 轴只标 min/max**（标刻度会诱使人拿像素量斜率，而 sparkline 的横轴本来就不等距可比）。
//   3. **props 变化时不闪白**：SVG 与文案**都常驻 DOM**（只切 opacity），不用 `v-if` 挂载/卸载。
//      `v-if` 换 DOM 节点 = 每 5s 轮询一次就重挂一次 = 看得见地闪。
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { chartPath, type ChartPoint } from '../lib/chartPath';
import { formatAxisTime } from '../lib/systemMetrics';

const props = withDefaults(defineProps<{
  /** 数据点（`x` = epoch 毫秒）。空数组 ⇒ 走空态。 */
  points?: ChartPoint[] | null;
  /** `viewBox` 尺寸（CSS 上仍然 `w-full`，这里只是坐标空间）。 */
  width?: number;
  height?: number;
  /** y 轴上下界；缺省 ⇒ 从数据推（`chartPath` 里做）。 */
  min?: number | null;
  max?: number | null;
  /** 空态文案（由调用方给本地化串：组件自己不碰 i18n 文案表，方便复用与单测）。 */
  emptyText?: string;
  /** 「历史不可用：<原因>」这类只属于图区的一句话（非空 ⇒ 优先于空态文案显示）。 */
  note?: string | null;
  formatY?: ((value: number) => string) | null;
  /** 横轴跨度 ≥24h ⇒ 端点标签带上日期（否则两端都叫「08:00」，读不出是哪天）。 */
  withDate?: boolean;
  /**
   * 横轴端点标签的**可选**替换（issue #808 纯增量）：给了就用它（例如按日聚合的用量只要日期
   * `MM-DD`，`HH:mm` 对日粒度毫无意义），缺省 `null` ⇒ 现有 `formatAxisTime` 行为**逐字不变**。
   * 本组件是 #650 管理台系统指标页在用的共享组件，默认行为与既有断言不许动。
   */
  formatX?: ((x: number) => string) | null;
  /**
   * 隐藏 y 轴上下界数值（issue #808 纯增量，缺省 `false` ⇒ 现有行为逐字不变）。本弹窗里 y 的
   * min/max 被左右排在同一行，会被读成「左端那天 = max、右端那天 = min」而正好读反（真机实测），
   * 所以这里改由调用方的一句「合计 + 单日最高（日期）」承担金额信息。**只把两个 y span 的文本置空**
   * （节点常驻、只切状态，不破「常驻 DOM 不用 v-if」的既有口径），x 轴两端日期照常显示。
   */
  hideAxisValues?: boolean;
  /** 无障碍名（每张卡的图用自己的指标名，屏幕阅读器不至于念出四个「chart」）。 */
  label?: string;
}>(), {
  points: () => [],
  width: 240,
  height: 56,
  min: null,
  max: null,
  emptyText: 'no data',
  note: null,
  formatY: null,
  withDate: false,
  formatX: null,
  hideAxisValues: false,
  label: '',
});

const { locale } = useI18n();
// 渐变 id 必须**每个实例唯一**：两张卡共用 `#fade` 时，后插入的那份会盖掉前一份（多卡页面必踩）。
// `useId()` 给的是组件实例级唯一串（Vue 3.5+）。
const gradientId = `metric-fade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

const points = computed<ChartPoint[]>(() => (props.points ?? []).filter(
  (point) => point !== null && typeof point === 'object'
    && Number.isFinite(point.x) && Number.isFinite(point.y),
));

const geometry = computed(() => chartPath(points.value, props.width, props.height, props.min, props.max));
const hasData = computed(() => geometry.value.line !== '');

/**
 * Y 轴标注用的上下界：调用方给了一对可用的界就用它（那是页面选的口径，比如 CPU 的 0~100），
 * 否则从点推。**一个都没有 ⇒ 空串**（不许拿 `min:0/max:0` 去标——那是把「没数据」标成「0 ~ 0」）。
 */
const bounds = computed<{ min: number; max: number } | null>(() => {
  const given = [props.min, props.max].filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  );
  if (given.length === 2) return { min: Math.min(...given), max: Math.max(...given) };
  if (points.value.length === 0) return null;
  const ys = points.value.map((point) => point.y);
  return { min: Math.min(...ys), max: Math.max(...ys) };
});

/** Y 轴只标 min / max（不画刻度：sparkline 的像素高度不可量，标了刻度会诱使人去量斜率）。 */
function axisY(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  return props.formatY ? props.formatY(value) : String(Math.round(value * 100) / 100);
}
const yMaxText = computed(() => (hasData.value ? axisY(bounds.value?.max) : ''));
const yMinText = computed(() => (hasData.value ? axisY(bounds.value?.min) : ''));

/** X 轴：两端各标一个本地时间（`formatAxisTime` 里脏值 ⇒ 原样，不猜）。
 *  给了 `formatX` ⇒ 由它出文案（调用方负责时区与形态，例如日粒度的 `MM-DD`）。 */
function axisX(raw: number | undefined): string {
  if (raw === undefined || !Number.isFinite(raw)) return '';
  if (props.formatX) return props.formatX(raw);
  const at = formatAxisTime(new Date(raw).toISOString(), locale.value, props.withDate);
  if (at.kind === 'unknown') return '';
  return at.text;
}
const xStartText = computed(() => axisX(points.value[0]?.x));
const xEndText = computed(() => axisX(points.value[points.value.length - 1]?.x));
</script>

<template>
  <figure data-test="metric-chart" class="grid gap-1" :aria-label="label || undefined">
    <div class="relative" :style="{ minHeight: `${Math.round(height * 0.6)}px` }">
      <!-- SVG 常驻（只切 opacity）：轮询到新数据时是**改属性**，不是重挂节点 ⇒ 不闪白 -->
      <svg
        data-test="metric-chart-svg"
        :viewBox="`0 0 ${width} ${height}`"
        preserveAspectRatio="none"
        class="block h-14 w-full transition-opacity duration-300"
        :class="hasData ? 'opacity-100' : 'opacity-0'"
        :aria-hidden="hasData ? 'false' : 'true'"
        role="img"
      >
        <defs>
          <linearGradient :id="gradientId" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgb(59 130 246)" stop-opacity="0.32" />
            <stop offset="100%" stop-color="rgb(59 130 246)" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <path
          v-if="geometry.area"
          data-test="metric-chart-area"
          :d="geometry.area"
          :fill="`url(#${gradientId})`"
          stroke="none"
          style="transition: d 300ms linear"
        />
        <path
          data-test="metric-chart-line"
          :d="geometry.line"
          fill="none"
          stroke="rgb(37 99 235)"
          stroke-width="1.5"
          stroke-linejoin="round"
          stroke-linecap="round"
          vector-effect="non-scaling-stroke"
          style="transition: d 300ms linear"
        />
        <circle
          v-if="geometry.last"
          data-test="metric-chart-last"
          :cx="geometry.last.x"
          :cy="geometry.last.y"
          r="2"
          fill="rgb(30 64 175)"
          style="transition: cx 300ms linear, cy 300ms linear"
        />
      </svg>
      <!-- 空态 / 提示：同一段 DOM 常驻（`v-show` 会摘节点，这里用 opacity + aria-hidden） -->
      <p
        data-test="metric-chart-empty"
        class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-black/55 transition-opacity duration-300"
        :class="hasData ? 'opacity-0' : 'opacity-100'"
        :aria-hidden="hasData ? 'true' : 'false'"
      >
        {{ note || emptyText }}
      </p>
    </div>

    <div class="flex items-baseline justify-between text-[11px] text-black/50">
      <span data-test="metric-chart-y-max" class="font-mono">{{ hideAxisValues ? '' : (hasData ? yMaxText : '') }}</span>
      <span data-test="metric-chart-y-min" class="font-mono">{{ hideAxisValues ? '' : (hasData ? yMinText : '') }}</span>
    </div>
    <div class="flex items-baseline justify-between text-[11px] text-black/45">
      <span data-test="metric-chart-x-start" class="font-mono">{{ xStartText }}</span>
      <span data-test="metric-chart-x-end" class="font-mono">{{ xEndText }}</span>
    </div>
  </figure>
</template>
