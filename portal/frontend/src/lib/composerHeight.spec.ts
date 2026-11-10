// issue #466：composer 自适应高度的**纯计算**判据。
// 为什么单独一层：jsdom 不做真实布局，textarea 的 scrollHeight 恒为 0，「按内容变高」在 DOM 层
// 直接断言会是一条恒真的假绿（工单 §3 点名的坑）。所以夹逼算法在这里用真数字钉死，
// DOM 层（ComposerBar.spec.ts）只断言「算出来的数确实写进了 textarea 的 style」。
import { describe, expect, it } from 'vitest';
import {
  COMPOSER_MAX_VIEWPORT_RATIO,
  COMPOSER_MIN_HEIGHT_REM,
  DEFAULT_ROOT_FONT_PX,
  borderBoxExtraPx,
  composerBudgetPx,
  composerHeightPx,
  parseRootFontPx,
} from './composerHeight';

const cs = (over: Partial<CSSStyleDeclaration> = {}) =>
  ({ boxSizing: 'border-box', borderTopWidth: '0px', borderBottomWidth: '0px', ...over }) as CSSStyleDeclaration;

describe('parseRootFontPx（rem 预算的换算基准）', () => {
  it('正常 px 值照取（无障碍用户把根字号调大时预算要跟着长）', () => {
    expect(parseRootFontPx('16px')).toBe(16);
    expect(parseRootFontPx('20.5px')).toBe(20.5);
  });

  it('解析不出 / 非正数 ⇒ 兜底 16，绝不返回 0（0 会让输入框塌成一条线）', () => {
    for (const bad of ['', 'auto', '1rem', 'NaNpx', undefined, null]) {
      expect(parseRootFontPx(bad as string), `bad=${String(bad)}`).toBe(DEFAULT_ROOT_FONT_PX);
    }
    expect(parseRootFontPx('0px')).toBe(DEFAULT_ROOT_FONT_PX);
    expect(parseRootFontPx('-4px')).toBe(DEFAULT_ROOT_FONT_PX);
  });
});

describe('composerBudgetPx（最小高 = 改动前的 3.2rem；封顶 = 视口比例预算）', () => {
  it('最小高就是改动前钉死的那句 3.2rem ⇒ 空输入时视觉一字不变', () => {
    expect(composerBudgetPx(768, 16).minPx).toBeCloseTo(COMPOSER_MIN_HEIGHT_REM * 16, 3);
    expect(composerBudgetPx(768, 20).minPx).toBeCloseTo(COMPOSER_MIN_HEIGHT_REM * 20, 3);
  });

  it('封顶按视口高算比例，不按固定像素（同 SidebarPanel 用 max-h-[50vh] 当预算的口径）', () => {
    expect(composerBudgetPx(768, 16).maxPx).toBeCloseTo(768 * COMPOSER_MAX_VIEWPORT_RATIO, 3);
    expect(composerBudgetPx(1200, 16).maxPx).toBeCloseTo(1200 * COMPOSER_MAX_VIEWPORT_RATIO, 3);
  });

  it('视口极矮时 max 不低于 min（否则夹出来是个负区间，输入框会被压没）', () => {
    const b = composerBudgetPx(40, 16); // 40 * 0.4 = 16px < 51.2px
    expect(b.maxPx).toBe(b.minPx);
    for (const vh of [0, -1, NaN, Infinity]) {
      const bb = composerBudgetPx(vh, 16);
      expect(bb.maxPx, `vh=${vh}`).toBeGreaterThanOrEqual(bb.minPx);
    }
  });
});

describe('composerHeightPx（内容高 → 写进 style.height 的值）', () => {
  const budget = { minPx: 51.2, maxPx: 307.2 };

  it('短内容夹到最小高（= 改动前的固定高，未输入时界面不跳）', () => {
    expect(composerHeightPx(0, budget)).toBe(51.2);
    expect(composerHeightPx(24, budget)).toBe(51.2);
  });

  it('长内容随内容增长，且不超过封顶', () => {
    expect(composerHeightPx(120, budget)).toBe(120);
    expect(composerHeightPx(307.2, budget)).toBe(307.2);
    expect(composerHeightPx(5000, budget)).toBe(307.2); // 顶到预算，靠 overflow-y 内部滚
  });

  it('量不出来（NaN / 负数 / 非有限）⇒ 按 0 处理落到最小高，绝不写 NaNpx 或 0px', () => {
    for (const bad of [NaN, -100, Infinity, undefined]) {
      expect(composerHeightPx(bad as number, budget), `bad=${String(bad)}`).toBe(51.2);
    }
  });

  it('预算残缺（min/max 不是正数）也不产出 NaNpx', () => {
    expect(Number.isFinite(composerHeightPx(120, { minPx: NaN, maxPx: 307.2 }))).toBe(true);
    expect(composerHeightPx(120, { minPx: 0, maxPx: 0 })).toBe(120);
  });
});

describe('borderBoxExtraPx（内容高与盒子高同源）', () => {
  it('border-box：补上下边框（scrollHeight 不含 border，而 height 写的是含边框的盒子高）', () => {
    expect(borderBoxExtraPx(cs({ borderTopWidth: '1px', borderBottomWidth: '1px' }))).toBe(2);
    expect(borderBoxExtraPx(cs({ borderTopWidth: '2.5px', borderBottomWidth: '1px' }))).toBe(3.5);
  });

  it('content-box 不补；边框解析不出也不补（jsdom 就落这里，保证 DOM 层不掺假数字）', () => {
    expect(borderBoxExtraPx(cs({ boxSizing: 'content-box', borderTopWidth: '1px', borderBottomWidth: '1px' }))).toBe(0);
    expect(borderBoxExtraPx(cs({ borderTopWidth: '', borderBottomWidth: undefined as unknown as string }))).toBe(0);
  });
});
