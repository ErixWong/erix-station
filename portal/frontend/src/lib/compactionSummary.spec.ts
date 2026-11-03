// #451：`compactionStats` 观测面的前端读侧纯函数（`lib/compactionSummary.ts`）。
// 三条硬口径都在这里钉住：键缺席而非零（null 透传）、全零层不列、脏值一律当「没有」（绝不补 0）。
import { describe, expect, it } from 'vitest';
import {
  COMPACTION_LAYER_ORDER,
  compactionLayerSegments,
  formatSavedTokens,
  normalizeSessionCompaction,
} from './compactionSummary';

describe('#451 normalizeSessionCompaction：DTO 收窄（脏值一律当「没有」，绝不补 0）', () => {
  it('真形状：两层都保留，层序按规范序（不靠对象键序）', () => {
    const value = normalizeSessionCompaction({
      // 故意把 slidingWindow 写在 ttl 前面：JSON 往返后键序不是契约面
      layers: {
        slidingWindow: { triggered: 8, tokensSaved: 12345 },
        ttl: { triggered: 75, tokensSaved: 314518 },
      },
      tokensSaved: 326863,
      rounds: 82,
      lastRound: 57,
    });
    expect(value).toEqual({
      rounds: 82,
      tokensSaved: 326863,
      lastRound: 57,
      layers: {
        ttl: { triggered: 75, tokensSaved: 314518 },
        slidingWindow: { triggered: 8, tokensSaved: 12345 },
      },
    });
    expect(compactionLayerSegments(value).map((seg) => seg.id)).toEqual(['ttl', 'slidingWindow']);
  });

  it('键缺席（undefined/null/非对象）⇒ null（渲染侧一个字节都不出）', () => {
    for (const raw of [undefined, null, 'oops', 42, [], true]) {
      expect(normalizeSessionCompaction(raw), String(raw)).toBeNull();
    }
  });

  it('全零层不列：foldLlm.triggered === 0 ⇒ 分段里没有它', () => {
    const value = normalizeSessionCompaction({
      rounds: 1,
      tokensSaved: 100,
      lastRound: 3,
      layers: {
        ttl: { triggered: 2, tokensSaved: 100 },
        foldLlm: { triggered: 0, tokensSaved: 0 },
      },
    });
    expect(Object.keys(value!.layers)).toEqual(['ttl']);
    expect('foldLlm' in value!.layers).toBe(false);
  });

  it('一层都没有（全零）⇒ null（等价于「没有折叠」）', () => {
    expect(normalizeSessionCompaction({
      rounds: 4, tokensSaved: 0, layers: { ttl: { triggered: 0, tokensSaved: 0 } },
    })).toBeNull();
    expect(normalizeSessionCompaction({ rounds: 0, tokensSaved: 0, layers: {} })).toBeNull();
  });

  it('脏值不炸：缺 rounds / 负 tokensSaved / layers 非对象 / 层值脏 ⇒ null 或整层丢弃', () => {
    expect(normalizeSessionCompaction({ tokensSaved: 1, layers: { ttl: { triggered: 1, tokensSaved: 1 } } })).toBeNull();
    expect(normalizeSessionCompaction({ rounds: 1, tokensSaved: -5, layers: { ttl: { triggered: 1, tokensSaved: 1 } } })).toBeNull();
    expect(normalizeSessionCompaction({ rounds: 1, tokensSaved: 1, layers: 'oops' })).toBeNull();
    // 单层脏 ⇒ 丢那一层，其余照常（不是整条炸）
    const partial = normalizeSessionCompaction({
      rounds: 1,
      tokensSaved: 10,
      layers: {
        ttl: { triggered: 1, tokensSaved: 10 },
        slidingWindow: { triggered: 'abc', tokensSaved: 1 },
      },
    });
    expect(Object.keys(partial!.layers)).toEqual(['ttl']);
  });

  it('lastRound 缺失/脏值 ⇒ 键缺席（不是 0）', () => {
    const value = normalizeSessionCompaction({ rounds: 1, tokensSaved: 10, layers: { ttl: { triggered: 1, tokensSaved: 10 } } });
    expect('lastRound' in value!).toBe(false);
  });
});

describe('#451 展示辅助：层序与 token 可读单位', () => {
  it('COMPACTION_LAYER_ORDER 与引擎 COMPACTION_PIPELINE 的 id 顺序一致', () => {
    expect([...COMPACTION_LAYER_ORDER]).toEqual([
      'ttl', 'slidingWindow', 'foldStatistical', 'foldLlm', 'anchors', 'enforceSize',
    ]);
  });

  it('formatSavedTokens 复用站内 formatTokenCount（k/M 可读单位），0 与脏值都给空串', () => {
    expect(formatSavedTokens(314518)).toBe('314.5k');
    expect(formatSavedTokens(1_200_000)).toBe('1.2M');
    expect(formatSavedTokens(999)).toBe('999');
    expect(formatSavedTokens(0)).toBe('');
    expect(formatSavedTokens(-1)).toBe('');
    expect(formatSavedTokens(Number.NaN)).toBe('');
    expect(formatSavedTokens(undefined)).toBe('');
  });

  it('compactionLayerSegments(null) ⇒ 空数组（键缺席 ⇒ 不渲染）', () => {
    expect(compactionLayerSegments(null)).toEqual([]);
  });
});
