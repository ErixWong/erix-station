// 消息时刻格式化单测（issue #282 A）。
// 验收点 ①：有 `created_at` 时显示、缺失时不显示，且**永不出** `undefined` / `Invalid Date` / `NaN`。
import { describe, expect, it } from 'vitest';
import { formatMessageTime } from './messageTime';

const ISO = '2026-10-23T13:42:07.000Z';
const OPTS = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } as const;

describe('formatMessageTime（issue #282 A：消息时刻）', () => {
  it('ISO 串 → HH:MM:SS（按当前 locale，zh-CN / en 都是数字时刻）', () => {
    const zh = formatMessageTime(ISO, 'zh-CN');
    expect(zh).toBe(new Date(ISO).toLocaleTimeString('zh-CN', OPTS));
    expect(zh).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(formatMessageTime(ISO, 'en')).toBe(new Date(ISO).toLocaleTimeString('en', OPTS));
  });

  it('缺失/空值一律空串（调用方据此整段不出），且绝不出现 undefined / Invalid Date / NaN', () => {
    for (const value of [undefined, null, ''] as const) {
      const out = formatMessageTime(value, 'zh-CN');
      expect(out).toBe('');
      expect(out).not.toMatch(/undefined|Invalid Date|NaN/);
    }
  });

  it('非字符串形状不猜（DTO 契约是字符串）—— 空值分支的变异哨兵', () => {
    // 数字时间戳是可被 `new Date()` 解析的：若把 `typeof value !== 'string'` 分支删掉，
    // 这里会渲染出一个**看起来正确**的时刻（正是工单要防的「把错误形状演成正确数据」）。
    expect(formatMessageTime(1700000000000, 'zh-CN')).toBe('');
    expect(formatMessageTime(new Date(ISO), 'zh-CN')).toBe('');
    expect(formatMessageTime({ at: ISO }, 'zh-CN')).toBe('');
  });

  it('解析不出的脏串 → 空串（不是 "Invalid Date"）', () => {
    for (const value of ['not-a-date', 'undefined', 'Invalid Date', '2026-13-45T99:99:99Z']) {
      const out = formatMessageTime(value, 'zh-CN');
      expect(out).toBe('');
      expect(out).not.toMatch(/undefined|Invalid Date|NaN/);
    }
  });

  it('非法 locale 不抛（降级为空串，绝不把异常漏给渲染路径）', () => {
    expect(formatMessageTime(ISO, 'not a locale !!')).toBe('');
  });
});
