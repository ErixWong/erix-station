// `MetricChart` 的单测 —— **两条单子共用这一份**（分支上曾各自新建同名 spec，rebase 时按
// 「两边用例都保留」并过来，所以这里既有 #808 的增量钉，也有 #814 的显示口径钉）。
//
// issue #808：新可选 prop `formatX` / `hideAxisValues`（纯增量）。
//   1. 给了 `formatX` ⇒ 两端横轴标签用它（用量弹窗要 `MM-DD`，日粒度下 `HH:mm` 永远是 `00:00`）；
//   2. **不给** ⇒ 现有时间形态逐字不变（回归钉：默认行为不许被这个新 prop 影响）；
//   3. `hideAxisValues` ⇒ 只把两个 y span 的文本置空（节点常驻），改由调用方的一句摘要承担金额信息。
//
// issue #814：钉两条已拍板的显示口径 —— 每条线上方一行可见小标题（`caption` + `data-metric`），
//   以及字节类图 y 轴下界**钉 0**（只给 `min` 时标注必须是 0，缓存 80→82 不许画成暴涨）。
//
// mount + i18n 的写法照 `GitLightBadge.spec.ts`（真实 i18n 单例 + `setLocale`，不用 `emitted()`）。
import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import MetricChart from './MetricChart.vue';
import { i18n, setLocale } from '../i18n';

// 三小时跨度（<24h ⇒ 默认走「只有时分」那一支），点本身升序。
const T0 = Date.UTC(2026, 10, 20, 8, 0, 0);
const POINTS = [
  { x: T0, y: 1 },
  { x: T0 + 3_600_000, y: 2 },
  { x: T0 + 2 * 3_600_000, y: 3 },
];
// #814 用例用的两个时刻（同 5 分钟跨度，字节量级用 80/82 才看得出「钉 0」与「从数据推」的差别）。
const X0 = Date.parse('2026-11-17T07:30:00.000Z');
const X1 = Date.parse('2026-11-17T07:35:00.000Z');

function mountChart(props: Record<string, unknown> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(MetricChart, { props: props as any, global: { plugins: [i18n] } });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
});

describe('MetricChart 的 formatX（issue #808 纯增量）', () => {
  it('给了 formatX ⇒ 两端标签都用它的返回值', () => {
    const w = mountChart({
      points: POINTS,
      formatX: (x: number) => {
        const d = new Date(x);
        const p = (n: number) => String(n).padStart(2, '0');
        return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      },
    });
    const start = w.get('[data-test="metric-chart-x-start"]').text();
    const end = w.get('[data-test="metric-chart-x-end"]').text();
    // 断言的是「由 formatX 决定」这两句话本身：本地月日，不是时间
    expect(start).toMatch(/^\d{2}-\d{2}$/);
    expect(end).toMatch(/^\d{2}-\d{2}$/);
    expect(start).not.toContain(':');
  });

  it('不给 formatX ⇒ 端点标签仍是时间（默认行为逐字不变的回归钉）', () => {
    const w = mountChart({ points: POINTS });
    const start = w.get('[data-test="metric-chart-x-start"]').text();
    const end = w.get('[data-test="metric-chart-x-end"]').text();
    expect(start).toMatch(/\d{1,2}:\d{2}/);
    expect(end).toMatch(/\d{1,2}:\d{2}/);
    expect(start).not.toMatch(/^\d{2}-\d{2}$/);
  });

  it('formatX=null 与不传等价；且脏 x 不会把 formatX 叫去（不拿 NaN 喂它）', () => {
    const calls: number[] = [];
    const w = mountChart({ points: [{ x: Number.NaN, y: 1 }], formatX: (x: number) => { calls.push(x); return 'x'; } });
    expect(calls).toEqual([]);
    expect(w.get('[data-test="metric-chart-x-start"]').text()).toBe('');
    expect(w.get('[data-test="metric-chart-x-end"]').text()).toBe('');
  });
});

// issue #808：新可选 prop `hideAxisValues`（纯增量）。本弹窗里 y 的 min/max 被左右排在同一行，
// 会被读成「左端那天=max、右端那天=min」而读反 ⇒ 调用方开开关隐数值，改由一句摘要承担金额信息。
describe('MetricChart 的 hideAxisValues（issue #808 纯增量）', () => {
  it('hideAxisValues=true ⇒ 两个 y span 文本为空（节点常驻、只切状态），x 两端仍照常', () => {
    const w = mountChart({ points: POINTS, hideAxisValues: true });
    // 节点必须常驻（不用 v-if 摘节点，否则「常驻 DOM 只切状态」的既有口径会破）
    expect(w.find('[data-test="metric-chart-y-max"]').exists()).toBe(true);
    expect(w.find('[data-test="metric-chart-y-min"]').exists()).toBe(true);
    expect(w.get('[data-test="metric-chart-y-max"]').text()).toBe('');
    expect(w.get('[data-test="metric-chart-y-min"]').text()).toBe('');
    // x 轴两端仍显示（POINT 跨度 <24h ⇒ 默认时间形态），唯一无歧义的信息不能一并抹掉
    expect(w.get('[data-test="metric-chart-x-start"]').text()).toMatch(/\d{1,2}:\d{2}/);
    expect(w.get('[data-test="metric-chart-x-end"]').text()).toMatch(/\d{1,2}:\d{2}/);
  });

  it('缺省（不传）⇒ y 两端仍有值（回归钉：新 prop 不许影响默认排法）', () => {
    const w = mountChart({ points: POINTS });
    // POINTS 的 y 为 1/2/3 ⇒ 上界 3、下界 1（formatY 缺省 ⇒ 取整原值）
    expect(w.get('[data-test="metric-chart-y-max"]').text()).toBe('3');
    expect(w.get('[data-test="metric-chart-y-min"]').text()).toBe('1');
  });
});

// 口径 1（#814）：每条线上方一行可见小标题；`metricId` 落成 `data-metric` 给用例点名。
describe('MetricChart：可见小标题与 data-metric', () => {
  it('caption 出现在线上、data-metric 落在 <figure> 上', () => {
    const w = mountChart({
      points: [{ x: X0, y: 50 }, { x: X1, y: 80 }],
      caption: '缓存趋势',
      metricId: 'mem-cached',
    });
    const caption = w.find('[data-test="metric-chart-caption"]');
    expect(caption.exists(), '每条线要有可见小标题').toBe(true);
    expect(caption.text()).toBe('缓存趋势');
    expect(w.get('[data-test="metric-chart"]').attributes('data-metric')).toBe('mem-cached');
  });

  it('没给 caption / metricId ⇒ 没有小标题、figure 不带 data-metric', () => {
    const w = mountChart({ points: [{ x: X0, y: 1 }, { x: X1, y: 2 }] });
    expect(w.find('[data-test="metric-chart-caption"]').exists()).toBe(false);
    expect(w.get('[data-test="metric-chart"]').attributes('data-metric'), 'metricId 缺省不参与显示').toBeUndefined();
  });
});

// 口径 2：字节类图 y 轴下界钉 0——只给 min 时标注必须是 0（缓存 80→82 不许画成暴涨）。
describe('MetricChart：单边界 y 轴（钉 0 口径）', () => {
  it('只给 min=0（不给 max）⇒ y 轴下界标注是 0（而非数据最小值），且线仍渲染', () => {
    const w = mountChart({ points: [{ x: X0, y: 80 }, { x: X1, y: 82 }], min: 0 });
    expect(w.get('[data-test="metric-chart-y-min"]').text(), '钉 0 而不是 80').toBe('0');
    const line = w.find('[data-test="metric-chart-line"]');
    expect(line.exists()).toBe(true);
    expect(line.attributes('d'), '有数据就要画出线').not.toBe('');
  });
});

// 现有红线：空态不许被这次改动破坏。
describe('MetricChart：空态红线不被单边界破坏', () => {
  it('空点 ⇒ 走空态文案且 y-min 是空串（不许把没数据标成 0 ~ 0）', () => {
    const w = mountChart({ points: [], min: 0, emptyText: '该区间无数据' });
    expect(w.get('[data-test="metric-chart-empty"]').text()).toContain('该区间无数据');
    expect(w.get('[data-test="metric-chart-y-min"]').text()).toBe('');
  });
});
