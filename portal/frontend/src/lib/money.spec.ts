// `lib/money` 的用例（issue #800 用户列表「周期 / 用量」列）。
// 这一列的唯一风险是「定长」被破坏（长串塞不进窄列）与「把不知道演成 0」。
// 断言围两件事写：形状必须是短串、null/非有限必须是 `—` 而不是 `$0.00`。
import { describe, expect, it } from 'vitest';
import { fmtUsdCompact } from './money';

describe('fmtUsdCompact', () => {
  it('null / undefined / 非有限一律是「—」（无读数不得渲染成 $0.00）', () => {
    for (const v of [null, undefined, NaN, Infinity, -Infinity]) {
      expect(fmtUsdCompact(v)).toBe('—');
    }
  });

  it('恰好 0 ⇒ $0.00（与「小于最小面额」区分开）', () => {
    expect(fmtUsdCompact(0)).toBe('$0.00');
  });

  it('0 < value < 0.005 ⇒ <$0.01（不谎报成 $0.00）', () => {
    expect(fmtUsdCompact(0.001)).toBe('<$0.01');
    expect(fmtUsdCompact(0.004)).toBe('<$0.01');
    expect(fmtUsdCompact(0.0049)).toBe('<$0.01');
  });

  it('到达 0.005 起改走两位小数', () => {
    expect(fmtUsdCompact(0.005)).toBe('$0.01');
    expect(fmtUsdCompact(0.0051)).toBe('$0.01');
  });

  it('其余 ⇒ $ + 两位小数（四舍五入）', () => {
    expect(fmtUsdCompact(0.3)).toBe('$0.30');
    expect(fmtUsdCompact(5.04)).toBe('$5.04');
    expect(fmtUsdCompact(5.09)).toBe('$5.09');
    expect(fmtUsdCompact(5.091148)).toBe('$5.09');
    expect(fmtUsdCompact(1.234)).toBe('$1.23');
    expect(fmtUsdCompact(1.236)).toBe('$1.24');
  });

  it('负数 ⇒ -$x.xx（不是 $-x.xx）', () => {
    expect(fmtUsdCompact(-0.2)).toBe('-$0.20');
    expect(fmtUsdCompact(-5.04)).toBe('-$5.04');
    expect(fmtUsdCompact(-5.04)).not.toContain('$-');
  });

  // 评审 NIT：`toFixed(2)` 会把 −0.004 变成 `-$0.00`——那句同时说「有」和「零」，是假数。
  // 极小非零（不论正负）只能说「不足一分」：这里的断言是**量级**。
  it('极小非零（含极小负数）⇒ <$0.01，绝不出现 -$0.00', () => {
    expect(fmtUsdCompact(0.0001)).toBe('<$0.01');
    expect(fmtUsdCompact(-0.0001)).toBe('<$0.01');
    expect(fmtUsdCompact(-0.004)).toBe('<$0.01');
    expect(fmtUsdCompact(-0.004)).not.toBe('-$0.00');
    expect(fmtUsdCompact(0.004)).toBe('<$0.01');
    // 到得了一分的仍照实带符号：
    expect(fmtUsdCompact(-0.02)).toBe('-$0.02');
  });

  it('输出恒为短串（定长列的硬约束：长度远小于 6 位小数的 fmtUsd）', () => {
    for (const v of [5.091148, 1234.5678, 0.00001, -42.999]) {
      expect(fmtUsdCompact(v).length).toBeLessThanOrEqual(11);
    }
  });
});
