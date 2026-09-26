// formatRelativeTime 单测（issue #94）：阈值边界 + 非法输入回退。
import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

const NOW = new Date('2026-09-26T12:00:00.000Z');

/** 以 NOW 为基准往前推 ms 的 ISO 串。 */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('formatRelativeTime（issue #94）', () => {
  it('未来时间/不足 1 分钟 → 刚刚', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('刚刚');
    expect(formatRelativeTime(ago(30_000), NOW)).toBe('刚刚');
    expect(formatRelativeTime(ago(-30_000), NOW)).toBe('刚刚');
  });

  it('分钟级：1–59 分钟 → N 分钟前（边界取整）', () => {
    expect(formatRelativeTime(ago(60_000), NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(ago(119_000), NOW)).toBe('1 分钟前');
    expect(formatRelativeTime(ago(3_599_999), NOW)).toBe('59 分钟前');
  });

  it('小时级：1–23 小时', () => {
    expect(formatRelativeTime(ago(3_600_000), NOW)).toBe('1 小时前');
    expect(formatRelativeTime(ago(23 * 3_600_000), NOW)).toBe('23 小时前');
  });

  it('天级：1–6 天', () => {
    expect(formatRelativeTime(ago(86_400_000), NOW)).toBe('1 天前');
    expect(formatRelativeTime(ago(6 * 86_400_000), NOW)).toBe('6 天前');
  });

  it('≥7 天回退本地日期', () => {
    expect(formatRelativeTime(ago(7 * 86_400_000), NOW)).toBe(
      new Date(NOW.getTime() - 7 * 86_400_000).toLocaleDateString('zh-CN'),
    );
  });

  it('非法/缺省输入回退空串', () => {
    expect(formatRelativeTime('', NOW)).toBe('');
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime(undefined, NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
