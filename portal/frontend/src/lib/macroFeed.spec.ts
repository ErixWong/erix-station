// 判据②：跳过聚合（`07` §13.2）。**连续同因跳过 = 一条汇总行；不同因不合并。**
//
// ⚠ 这条判据在 W5 首版里是**真空**（`aggregateSkippedRuns` 一条用例都没有），
// 主 agent 复验时把「连续同因合并」的分支改成 `if (false)` 跑测试 —— **15 条全绿**。
// 本文件就是补那个洞。反向自证：把那行改回 `if (false)` ⇒ 本文件第 1/2 条必须红。
import { describe, expect, it } from 'vitest';
import { aggregateSkippedRuns, type MacroRun } from './macroView';

/** 造一条 run；只填聚合会读的字段，其余给安全的默认值。 */
function run(over: Partial<MacroRun> & { id: string }): MacroRun {
  return {
    assignmentId: 'a1',
    anchor: null,
    status: 'done',
    criterion: null,
    verdict: null,
    skippedReason: null,
    actionText: null,
    startedAt: '2026-11-16T02:00:00.000Z',
    finishedAt: '2026-11-16T02:01:00.000Z',
    depth: 0,
    childSessionId: null,
    childRunId: null,
    usage: null,
    pending: false,
    ...over,
  };
}

const skipped = (id: string, reason: string): MacroRun =>
  run({ id, status: 'skipped', skippedReason: reason });

describe('aggregateSkippedRuns（判据②）', () => {
  it('连续同因跳过合成一条汇总行，repeatCount 记对', () => {
    const items = aggregateSkippedRuns([
      skipped('s1', 'quiet_hours'),
      skipped('s2', 'quiet_hours'),
      skipped('s3', 'quiet_hours'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('skippedGroup');
    if (items[0].kind !== 'skippedGroup') throw new Error('unreachable');
    expect(items[0].repeatCount).toBe(3);
    expect(items[0].reason).toBe('quiet_hours');
    // 最新一条在首位（API 是 started_at DESC）
    expect(items[0].latest.id).toBe('s1');
  });

  it('不同因不合并（静默时段 ×2 与额度用完 ×2 是两件事）', () => {
    const items = aggregateSkippedRuns([
      skipped('s1', 'quiet_hours'),
      skipped('s2', 'quiet_hours'),
      skipped('s3', 'budget_exhausted'),
      skipped('s4', 'budget_exhausted'),
    ]);
    expect(items).toHaveLength(2);
    const [g1, g2] = items;
    if (g1.kind !== 'skippedGroup' || g2.kind !== 'skippedGroup') throw new Error('unreachable');
    expect(g1.reason).toBe('quiet_hours');
    expect(g1.repeatCount).toBe(2);
    expect(g2.reason).toBe('budget_exhausted');
    expect(g2.repeatCount).toBe(2);
  });

  it('中间夹一条非跳过记录 ⇒ 断成两组（「连续」是真连续）', () => {
    const items = aggregateSkippedRuns([
      skipped('s1', 'quiet_hours'),
      run({ id: 'r1', status: 'done', verdict: 'pass' }),
      skipped('s2', 'quiet_hours'),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['skippedGroup', 'run', 'skippedGroup']);
    expect(items[0].kind === 'skippedGroup' && items[0].repeatCount).toBe(1);
    expect(items[2].kind === 'skippedGroup' && items[2].repeatCount).toBe(1);
  });

  it('skipped 但没有 reason 的不并进组（`skipped_reason` 是必填，缺了就是脏数据）', () => {
    const items = aggregateSkippedRuns([
      skipped('s1', 'quiet_hours'),
      run({ id: 's2', status: 'skipped', skippedReason: null }),
    ]);
    expect(items).toHaveLength(2);
    expect(items[1].kind).toBe('run');
  });
});
