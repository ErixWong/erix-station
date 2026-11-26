// issue #808：`MetricChart` 的新可选 prop `formatX`（纯增量）。
// 这是 #650 管理台系统指标页在用的**共享组件**，所以本 spec 的重心是两件事：
//   1. 给了 `formatX` ⇒ 两端横轴标签用它（用量弹窗要 `MM-DD`，日粒度下 `HH:mm` 永远是 `00:00`）；
//   2. **不给** ⇒ 现有时间形态逐字不变（回归钉：默认行为不许被这个新 prop 影响）。
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
