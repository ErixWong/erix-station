// toolCallExpansion 单测（issue #85）：模块级展开记忆 is/set/clear 三函数语义。
import { beforeEach, describe, expect, it } from 'vitest';
import { clearExpandedToolCalls, isToolCallExpanded, setToolCallExpanded } from './toolCallExpansion';

beforeEach(() => clearExpandedToolCalls());

describe('toolCallExpansion（工具卡片展开记忆）', () => {
  it('默认收起：未 set 过返回 false', () => {
    expect(isToolCallExpanded('c1')).toBe(false);
  });

  it('set true 后记忆展开，set false 取消', () => {
    setToolCallExpanded('c1', true);
    expect(isToolCallExpanded('c1')).toBe(true);
    setToolCallExpanded('c1', false);
    expect(isToolCallExpanded('c1')).toBe(false);
  });

  it('undefined callId：is 恒 false，set 为 no-op（不抛）', () => {
    expect(isToolCallExpanded(undefined)).toBe(false);
    setToolCallExpanded(undefined, true);
    setToolCallExpanded('', true);
    // 非法键不会污染记忆
    expect(isToolCallExpanded('c1')).toBe(false);
  });

  it('clear 清空全部记忆', () => {
    setToolCallExpanded('c1', true);
    setToolCallExpanded('c2', true);
    clearExpandedToolCalls();
    expect(isToolCallExpanded('c1')).toBe(false);
    expect(isToolCallExpanded('c2')).toBe(false);
  });
});
