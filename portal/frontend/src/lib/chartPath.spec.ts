// `lib/chartPath` 的纯函数用例（issue #650 管理台「系统」面板）。四件事必须有用例（工单 §前端）：
//   1. 空数组 ⇒ 空 path 且不抛（否则调用方要自己防异常，而「该区间无数据」的文案就没了依据）；
//   2. 单点 ⇒ 给一条**可渲染**的短横线（`M x y` 只有一段时 SVG 什么都不画）；
//   3. 全等值 ⇒ `min === max` 会除零 ⇒ 必须退中线，且**结果里不许出现 NaN**
//      （`M NaN NaN` 不会抛错，只会让那条线悄悄消失 —— 正是本单最坏的失败形状）；
//   4. y 轴翻转正确（数学 y 向上、SVG y 向下）—— 画反了不报错，但每个读图的人都会读反。
import { describe, expect, it } from 'vitest';
import { chartPath, valueBounds, type ChartPoint } from './chartPath';

const W = 240;
const H = 60;

describe('chartPath：空 / 脏输入', () => {
  it('空数组 ⇒ 空 line/area、last:null，不抛', () => {
    const geo = chartPath([], W, H, 0, 100);
    expect(geo).toEqual({ line: '', area: '', last: null });
    expect(() => chartPath([], W, H)).not.toThrow();
  });

  it('null / undefined / 非数组 / 全脏点都不抛，一律等价于空', () => {
    for (const input of [null, undefined, 'nope', 42, [null, 1, { x: NaN, y: 1 }, { x: 1, y: 'a' }]]) {
      expect(() => chartPath(input as never, W, H)).not.toThrow();
      expect(chartPath(input as never, W, H).line).toBe('');
    }
  });

  it('脏点被丢弃而不是打死整张图（一个坏点不能让四条线全消失）', () => {
    const dirty = [{ x: 0, y: 10 }, null, { x: 5, y: NaN }, { x: 10, y: 30 }] as unknown as ChartPoint[];
    const geo = chartPath(dirty, W, H, 0, 40);
    const commands = geo.line.split('L').length;
    expect(commands, '两个可用点 ⇒ 一段 M + 一段 L').toBe(2);
    expect(geo.line).not.toContain('NaN');
  });

  it('视口不可用（0 / 负数 / NaN 宽高）⇒ 空 path，不抛也不出 Infinity', () => {
    for (const size of [0, -10, NaN, undefined]) {
      const geo = chartPath([{ x: 0, y: 1 }, { x: 1, y: 2 }], size as number, H, 0, 2);
      expect(geo.line).toBe('');
      expect(geo.area).toBe('');
    }
  });
});

describe('chartPath：单点', () => {
  it('单点 ⇒ 短横线（有 M 也有 L，宽度 > 0），不是空串', () => {
    const geo = chartPath([{ x: 1_700_000_000_000, y: 50 }], W, H, 0, 100);
    expect(geo.line).toMatch(/^M .* L /);
    expect(geo.last).not.toBeNull();
    const [fromX, toX] = [geo.line.split(' ')[1], geo.line.split('L')[1].trim().split(' ')[0]];
    expect(Number(toX) - Number(fromX)).toBeGreaterThan(0);
  });

  it('单点仍按真实界落位：值 80 / 界 0~100 ⇒ 横线在 20% 高度处（不是"只有一个点就摆中间"）', () => {
    const geo = chartPath([{ x: 5, y: 80 }], W, H, 0, 100);
    const y = Number(geo.line.split(' ')[2]);
    expect(y).toBeCloseTo(H * (1 - 80 / 100), 3);
  });

  it('单点 + 无可用的界（只有一个点、界没给）⇒ 中线，仍是一条看得见的横线', () => {
    const geo = chartPath([{ x: 5, y: 7 }], W, H);
    expect(Number(geo.line.split(' ')[2])).toBeCloseTo(H / 2, 3);
  });

  it('单点的横线被夹在视口内（x=0 时不画到负坐标去）', () => {
    const geo = chartPath([{ x: 0, y: 1 }], W, H, 0, 1);
    const fromX = Number(geo.line.split(' ')[1]);
    const toX = Number(geo.line.split('L')[1].trim().split(' ')[0]);
    expect(fromX).toBeGreaterThanOrEqual(0);
    expect(toX).toBeLessThanOrEqual(W);
  });
});

describe('chartPath：全等值（除零退中线）', () => {
  it('min === max ⇒ 所有点 y 都是中线，且整条 path 里没有 NaN / Infinity', () => {
    const geo = chartPath([{ x: 0, y: 42 }, { x: 1, y: 42 }, { x: 2, y: 42 }], W, H, 42, 42);
    expect(geo.line).not.toMatch(/NaN|Infinity/);
    for (const part of geo.line.slice(2).split('L')) {
      expect(Number(part.trim().split(' ')[1])).toBeCloseTo(H / 2, 6);
    }
    expect(geo.last?.y).toBeCloseTo(H / 2, 6);
  });

  it('全等值时不用调用方给界也一样（界从数据推 ⇒ 必然相等）', () => {
    const geo = chartPath([{ x: 0, y: 3 }, { x: 1, y: 3 }], W, H);
    expect(geo.line).not.toMatch(/NaN/);
    expect(Number(geo.line.split(' ')[2])).toBeCloseTo(H / 2, 6);
  });

  it('全等值不是"没有数据"：line 非空（页面据此照常画线，不走空态）', () => {
    expect(chartPath([{ x: 0, y: 5 }, { x: 1, y: 5 }], W, H, 5, 5).line).not.toBe('');
  });
});

describe('chartPath：y 轴翻转（数学 y 向上、SVG y 向下）', () => {
  it('最小值贴底（y=h）、最大值贴顶（y=0）', () => {
    const geo = chartPath([{ x: 0, y: 0 }, { x: 1, y: 100 }], W, H, 0, 100);
    const firstY = Number(geo.line.split(' ')[2]);
    const lastY = geo.last?.y ?? NaN;
    expect(firstY, '数学最小值必须画在**底部**').toBeCloseTo(H, 6);
    expect(lastY, '数学最大值必须画在**顶部**').toBeCloseTo(0, 6);
  });

  it('中间值线性：值 25 / 界 0~100 ⇒ y = 75% 高度', () => {
    const geo = chartPath([{ x: 0, y: 25 }, { x: 1, y: 100 }], W, H, 0, 100);
    expect(Number(geo.line.split(' ')[2])).toBeCloseTo(H * 0.75, 6);
  });

  it('x 轴等距：首点在 0、末点在 w', () => {
    const geo = chartPath([{ x: 10, y: 1 }, { x: 20, y: 2 }, { x: 30, y: 3 }], W, H, 0, 3);
    expect(Number(geo.line.split(' ')[1])).toBeCloseTo(0, 6);
    expect(geo.last?.x).toBeCloseTo(W, 6);
  });

  it('调用方给的界反了（min>max 的脏值）⇒ 整体不翻转', () => {
    const swapped = chartPath([{ x: 0, y: 0 }, { x: 1, y: 10 }], W, H, 10, 0);
    const plain = chartPath([{ x: 0, y: 0 }, { x: 1, y: 10 }], W, H, 0, 10);
    expect(swapped.line).toBe(plain.line);
  });

  it('area 是折线 + 落到视口底边封口（有"地面"，不在 min>0 时悬空）', () => {
    const geo = chartPath([{ x: 0, y: 20 }, { x: 1, y: 40 }], W, H, 0, 100);
    expect(geo.area.startsWith(geo.line)).toBe(true);
    expect(geo.area).toContain(` ${H} `);
    expect(geo.area.endsWith('Z')).toBe(true);
  });

  it('单点没有"下方"可言 ⇒ area 是空串（画一块贴底的假面积就是说谎）', () => {
    expect(chartPath([{ x: 0, y: 5 }], W, H, 0, 10).area).toBe('');
  });
});

describe('valueBounds：给坐标标注用', () => {
  it('脏值 / 空数组 ⇒ null，**不许**退成 {min:0,max:0}（那会把"没有数据"标成 0~0）', () => {
    expect(valueBounds([])).toBeNull();
    expect(valueBounds([null, undefined, NaN, 'x' as never])).toBeNull();
    expect(valueBounds(null)).toBeNull();
    expect(valueBounds([7, null, 3])).toEqual({ min: 3, max: 7 });
  });
});
