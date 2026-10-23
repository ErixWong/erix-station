// 动量纯计算层单测（issue #282 B）：格式化 / UTF-8 字节 / 滑窗速率估算 / 派生视图（含冻结边界）。
// 验收点 ③（速率估算）、④（冻结标黄的**跨阈值那一刻**）、⑤（usage 真值 vs 缺失）都在这一层钉死。
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  createEmptyMomentumState,
  deriveMomentumView,
  estimateTokensPerSec,
  formatByteSize,
  formatElapsed,
  RUN_FROZEN_THRESHOLD_MS,
  TPS_WINDOW_MS,
  utf8ByteLength,
  type RunMomentumState,
} from './runMomentum';

function runningState(patch: Partial<RunMomentumState> = {}): RunMomentumState {
  return { ...createEmptyMomentumState(), runId: 'r1', startedAt: 0, ...patch };
}

describe('formatElapsed（时长 → 03:42 / 1:02:03）', () => {
  it('秒级向下取整，分:秒 / 时:分:秒两档', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(999)).toBe('00:00');
    expect(formatElapsed(222_000)).toBe('03:42');
    expect(formatElapsed(3_723_000)).toBe('1:02:03');
  });

  it('拿不到就不出（null / NaN / 负数 → 空串，绝不渲染 NaN:NaN）', () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1] as const) {
      expect(formatElapsed(value)).toBe('');
    }
  });
});

describe('formatByteSize（812 B / 4.1 KB / 2.3 MB）', () => {
  it('三档单位 + 一位小数', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(812)).toBe('812 B');
    expect(formatByteSize(4200)).toBe('4.1 KB');
    expect(formatByteSize(2_411_724)).toBe('2.3 MB');
  });

  it('拿不到就不出（null / NaN / 负数 → 空串）', () => {
    for (const value of [null, undefined, Number.NaN, -5] as const) {
      expect(formatByteSize(value)).toBe('');
    }
  });
});

describe('utf8ByteLength（↑ 4.1 KB 的字节口径）', () => {
  it('ASCII=1 / 中文=3 / emoji=4', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('中文')).toBe(6);
    expect(utf8ByteLength('a中')).toBe(4);
    expect(utf8ByteLength('😀')).toBe(4);
  });
});

describe('estimateTokensPerSec（前端滑窗估算，非上游真值）', () => {
  it('窗口内增量 / 跨度 → token/s（保留一位小数）', () => {
    const samples = [{ t: 0, chars: 0 }, { t: 2000, chars: 80 }];
    // 80 字符 / 4 = 20 token，2s ⇒ 10 tok/s
    expect(estimateTokensPerSec(samples, 2000)).toBe(10);
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it('样本不足 / 跨度太短 / 无增量 ⇒ null（宁可不显示，也不出一个凭一个 chunk 算出来的数）', () => {
    expect(estimateTokensPerSec([], 1000)).toBeNull();
    expect(estimateTokensPerSec([{ t: 0, chars: 10 }], 1000)).toBeNull();
    expect(estimateTokensPerSec([{ t: 0, chars: 0 }, { t: 999, chars: 40 }], 999)).toBeNull();
    expect(estimateTokensPerSec([{ t: 0, chars: 40 }, { t: 2000, chars: 40 }], 2000)).toBeNull();
  });

  it('只看最近一个窗口（TPS_WINDOW_MS）的增量：老样本被窗口甩掉后速率反映「现在」', () => {
    const samples = [
      { t: 0, chars: 0 },
      { t: 1000, chars: 4000 }, // 老的高产段（若拿整段均值会算出 ~90 tok/s）
      { t: 9000, chars: 4000 },
      { t: 11_000, chars: 4080 }, // 窗口内只多了 80 字符
    ];
    const now = 11_000;
    const inWindow = samples.filter((s) => s.t >= now - TPS_WINDOW_MS);
    expect(inWindow[0]?.t).toBe(1000); // 窗口左界 = now - TPS_WINDOW_MS
    // 80 字符 / 4 = 20 token，跨度 10s ⇒ 2 tok/s（整段均值会是 4080/4/11 ≈ 92.7）
    expect(estimateTokensPerSec(samples, now)).toBe(2);
  });
});

describe('deriveMomentumView（派生视图：拿不到就是 null，不是 0）', () => {
  it('运行中：时长按 now - startedAt 递增（假时钟驱动）', () => {
    const state = runningState({ startedAt: 1_000 });
    expect(deriveMomentumView(state, 1_000).elapsedMs).toBe(0);
    expect(deriveMomentumView(state, 223_000).elapsedMs).toBe(222_000);
    expect(formatElapsed(deriveMomentumView(state, 223_000).elapsedMs)).toBe('03:42');
  });

  it('起跑时刻未知（页面中途打开）⇒ elapsedMs = null，不假装 0:00', () => {
    const state = runningState({ startedAt: null });
    const view = deriveMomentumView(state, 223_000);
    expect(view.running).toBe(true);
    expect(view.elapsedMs).toBeNull();
    expect(formatElapsed(view.elapsedMs)).toBe('');
  });

  it('终态后时长定格（不再随时钟增长）', () => {
    const state = runningState({ startedAt: 1_000, endedAt: 61_000 });
    expect(deriveMomentumView(state, 61_000).elapsedMs).toBe(60_000);
    expect(deriveMomentumView(state, 999_999).elapsedMs).toBe(60_000);
    expect(deriveMomentumView(state, 999_999).running).toBe(false);
    expect(deriveMomentumView(state, 999_999).hasLastRun).toBe(true);
  });

  it('冻结边界：恰好阈值不冻结，跨过阈值那一刻冻结（阈值取自单一常量）', () => {
    const state = runningState({ startedAt: 0, lastEventAt: 1_000 });
    const atThreshold = deriveMomentumView(state, 1_000 + RUN_FROZEN_THRESHOLD_MS);
    expect(atThreshold.frozenMs).toBe(RUN_FROZEN_THRESHOLD_MS);
    expect(atThreshold.frozen).toBe(false); // 「> 5s」而不是「>= 5s」
    const justAfter = deriveMomentumView(state, 1_000 + RUN_FROZEN_THRESHOLD_MS + 1);
    expect(justAfter.frozenMs).toBe(RUN_FROZEN_THRESHOLD_MS + 1);
    expect(justAfter.frozen).toBe(true);
  });

  it('没有任何流式/工具事件（lastEventAt=null）⇒ 冻结信号为 null（没观测就不下结论）', () => {
    const state = runningState({ startedAt: 0 });
    const view = deriveMomentumView(state, 10 * RUN_FROZEN_THRESHOLD_MS);
    expect(view.frozenMs).toBeNull();
    expect(view.frozen).toBe(false);
  });

  it('终态后不再判冻结（黄色警示只属于运行中的 run）', () => {
    const state = runningState({ startedAt: 0, lastEventAt: 1_000, endedAt: 2_000 });
    expect(deriveMomentumView(state, 999_999).frozen).toBe(false);
  });

  it('usage：真值原样透出；缺失保持 null（调用方据此不出 token 数字）', () => {
    const withUsage = runningState({ usage: { input_tokens: 15_230, output_tokens: 2_104 }, endedAt: 5 });
    expect(deriveMomentumView(withUsage, 5).usage).toEqual({ input_tokens: 15_230, output_tokens: 2_104 });
    const withoutUsage = runningState({ usage: null, endedAt: 5 });
    expect(deriveMomentumView(withoutUsage, 5).usage).toBeNull();
  });

  it('工具均值：只有带时长的结果参与；一个都没有 ⇒ null（不拿 0ms 冒充）', () => {
    const state = runningState({ toolCount: 8, toolDurTotalMs: 96_000, toolDurCount: 8 });
    expect(deriveMomentumView(state, 0).toolAvgMs).toBe(12_000);
    const noDur = runningState({ toolCount: 3, toolDurTotalMs: 0, toolDurCount: 0 });
    expect(deriveMomentumView(noDur, 0).toolAvgMs).toBeNull();
  });

  it('速率只在运行中出（终态残留的滑窗值会误导成「还在跑」）', () => {
    const samples = [{ t: 0, chars: 0 }, { t: 2000, chars: 80 }];
    const running = runningState({ startedAt: 0, samples });
    expect(deriveMomentumView(running, 2000).tokensPerSec).toBe(10);
    const ended = runningState({ startedAt: 0, endedAt: 2000, samples });
    expect(deriveMomentumView(ended, 2000).tokensPerSec).toBeNull();
  });
});
