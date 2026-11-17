// `macroView.ts` 的水位线判据单测（issue #615，`09` §1.1）。
//
// 病根：老代码对 `lastEvaluatedAt === null` 直接判 stale，于是**每个新订阅**都会闪一次
// 顶部 ⚠「macros may not be firing」，用户学会无视它 ⇒ 真正的水位线陈旧被藏起来。
// 修后：首次订阅 ≠ 陈旧；只有过了宽限窗（`createdAt + 3 × 间隔`）仍没推进过才算陈旧。
import { describe, expect, it } from 'vitest';
import { WATERMARK_STALE_MS, watermarkState, type MacroAssignment } from './macroView';

const NOW = Date.parse('2026-11-16T06:40:00.000Z');
const MIN = 60_000;

function assignment(over: Partial<MacroAssignment> = {}): MacroAssignment {
  return {
    id: 'a-1', templateId: 't-1', sessionId: 's-1', until: null,
    enabled: true, expired: false, effectiveEnabled: true,
    lastEvaluatedAt: null, createdAt: null,
    ...over,
  };
}

describe('#615 水位线：首次订阅 vs 水位线陈旧（两件事分开）', () => {
  it('判据①：lastEvaluatedAt=null 且 createdAt=now ⇒ stale=false、neverEvaluated=true', () => {
    const s = watermarkState([assignment({ lastEvaluatedAt: null, createdAt: new Date(NOW).toISOString() })], NOW);
    expect(s.stale).toBe(false);
    expect(s.neverEvaluated).toBe(true);
  });

  it('判据②：lastEvaluatedAt=null 且 createdAt=now-10min ⇒ stale=true（宽限窗过了仍要报）', () => {
    const s = watermarkState([assignment({ lastEvaluatedAt: null, createdAt: new Date(NOW - 10 * MIN).toISOString() })], NOW);
    expect(s.stale).toBe(true);
    expect(s.neverEvaluated).toBe(true);
  });

  it('判据③：lastEvaluatedAt=now-10min ⇒ stale=true（既有行为不变，与 createdAt 无关）', () => {
    const s = watermarkState([assignment({ lastEvaluatedAt: new Date(NOW - 10 * MIN).toISOString(), createdAt: new Date(NOW).toISOString() })], NOW);
    expect(s.stale).toBe(true);
    expect(s.neverEvaluated).toBe(false);
    expect(s.last).toBe(new Date(NOW - 10 * MIN).toISOString());
  });

  it('刚建订阅虽 null 但在宽限窗边缘之内 ⇒ 不报（间隔 3× 内）', () => {
    const justInside = new Date(NOW - (WATERMARK_STALE_MS - 1000)).toISOString();
    const s = watermarkState([assignment({ lastEvaluatedAt: null, createdAt: justInside })], NOW);
    expect(s.stale).toBe(false);
  });

  it('createdAt=null 的 null 订阅：无法度量宽限窗 ⇒ 不误报（宁旧勿错），但仍标尚未评估', () => {
    const s = watermarkState([assignment({ lastEvaluatedAt: null, createdAt: null })], NOW);
    expect(s.stale).toBe(false);
    expect(s.neverEvaluated).toBe(true);
  });

  it('多条订阅：只要有一条过了宽限窗仍 null ⇒ 整体报陈旧（不因取 max 藏坏掉的那条）', () => {
    const healthy = assignment({
      id: 'a-ok', lastEvaluatedAt: new Date(NOW - 5_000).toISOString(), createdAt: new Date(NOW - 1 * MIN).toISOString(),
    });
    const deadNew = assignment({
      id: 'a-dead', lastEvaluatedAt: null, createdAt: new Date(NOW - 10 * MIN).toISOString(),
    });
    const s = watermarkState([healthy, deadNew], NOW);
    expect(s.stale).toBe(true);
    expect(s.last).toBe(new Date(NOW - 5_000).toISOString());
  });

  it('没有生效订阅 ⇒ 三态全阴', () => {
    expect(watermarkState([], NOW)).toEqual({ last: null, stale: false, neverEvaluated: false });
  });
});
