// issue #808：判断源四函数的边界。红线：null 不猜 0、白名单外不猜日/月、budget_duration 压过 budget_period、
// 超额钳 100、budget<=0 ⇒ percent null、overage 只在真超额时给值。
import { describe, expect, it } from 'vitest';
import { usageCadenceOf, usageKindOf, usageOverage, usagePercentUsed } from './usageLabel';

describe('usageKindOf：spend_scope 是唯一判据，缺读数 ⇒ unknown（不得当 0）', () => {
  it('row 为空 / spend==null / spend_scope==null ⇒ unknown', () => {
    expect(usageKindOf(null)).toBe('unknown');
    expect(usageKindOf(undefined)).toBe('unknown');
    expect(usageKindOf({})).toBe('unknown');
    expect(usageKindOf({ spend: null, spend_scope: 'period' })).toBe('unknown');
    expect(usageKindOf({ spend: 1, spend_scope: null })).toBe('unknown');
    expect(usageKindOf({ spend: null, spend_scope: null })).toBe('unknown');
  });

  it('spend==0 且有 scope ⇒ 是真 0，不是 unknown', () => {
    expect(usageKindOf({ spend: 0, spend_scope: 'period' })).toBe('period');
  });

  it('lifetime vs period', () => {
    expect(usageKindOf({ spend: 5.09, spend_scope: 'lifetime' })).toBe('lifetime');
    expect(usageKindOf({ spend: 2.05, spend_scope: 'period' })).toBe('period');
  });
});

describe('usageCadenceOf：网关 budget_duration 优先、白名单外不猜', () => {
  it('budget_duration 压过 budget_period（跟钱走不跟配置走）', () => {
    expect(usageCadenceOf({ budget_duration: '1d', budget_period: '1mo' })).toBe('1d');
    expect(usageCadenceOf({ budget_duration: '1mo', budget_period: '1d' })).toBe('1mo');
  });

  it('无 budget_duration 才回落 budget_period', () => {
    expect(usageCadenceOf({ budget_period: '1mo' })).toBe('1mo');
    expect(usageCadenceOf({ budget_period: '1d' })).toBe('1d');
  });

  it('白名单外 ⇒ null（不许猜成日/月）', () => {
    for (const bad of ['7d', '30d', '1m', '2mo', '']) {
      expect(usageCadenceOf({ budget_duration: bad, budget_period: '1mo' })).toBeNull();
    }
  });

  it('全空 / row 为空 ⇒ null', () => {
    expect(usageCadenceOf({})).toBeNull();
    expect(usageCadenceOf(null)).toBeNull();
    expect(usageCadenceOf(undefined)).toBeNull();
  });

  // `??` 链的边界：budget_duration 为空串也算「网关说了」，不回落到 DB（与既有 usageCell 逐字同口径）。
  it('budget_duration 空串不回落到 DB 的 1mo（仍白名单外 ⇒ null）', () => {
    expect(usageCadenceOf({ budget_duration: '', budget_period: '1mo' })).toBeNull();
  });
});

describe('usagePercentUsed：0–100、超额钳 100、无可用额度 ⇒ null（别画 0%）', () => {
  it('常规比例', () => {
    expect(usagePercentUsed(2.05, 10)).toBeCloseTo(20.5);
    expect(usagePercentUsed(0, 10)).toBe(0);
  });

  it('超额钳到 100（不溢出）', () => {
    expect(usagePercentUsed(10.09, 10)).toBe(100);
    expect(usagePercentUsed(999, 10)).toBe(100);
  });

  it('budget 空 / <=0 ⇒ null（调用方不画进度条）', () => {
    expect(usagePercentUsed(2, null)).toBeNull();
    expect(usagePercentUsed(2, 0)).toBeNull();
    expect(usagePercentUsed(2, -5)).toBeNull();
    expect(usagePercentUsed(2, undefined)).toBeNull();
  });

  it('spend 空 ⇒ null（没有读数就没有进度）', () => {
    expect(usagePercentUsed(null, 10)).toBeNull();
    expect(usagePercentUsed(undefined, 10)).toBeNull();
  });

  it('负 spend 钳到 0', () => {
    expect(usagePercentUsed(-1, 10)).toBe(0);
  });
});

describe('usageOverage：只有真超额才给正数，其余 null', () => {
  it('超额 ⇒ 正的超额度', () => {
    expect(usageOverage(10.09, 10)).toBeCloseTo(0.09);
  });

  it('未超 / 恰好等于 ⇒ null', () => {
    expect(usageOverage(2.05, 10)).toBeNull();
    expect(usageOverage(10, 10)).toBeNull();
  });

  it('没额度（空/<=0）⇒ null（终身累计不谈超额）', () => {
    expect(usageOverage(5.09, null)).toBeNull();
    expect(usageOverage(5.09, 0)).toBeNull();
  });

  it('spend 空 ⇒ null', () => {
    expect(usageOverage(null, 10)).toBeNull();
  });
});
