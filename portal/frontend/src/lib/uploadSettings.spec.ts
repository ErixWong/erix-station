// issue #485 片 A：`lib/uploadSettings.ts` 的纯函数单测。
//
// 为什么这一层必须单独有文件（不是"顺手补一条"）：三个形状只有在这里才测得到——
//   * `'1e7'` / `'1e4'` 这类**字符串**形态：视图里 `<input type=number>` 会先把它们归一成整数
//     （jsdom 与浏览器同行为，实测），于是字符串永远到不了 lib。真正会送字符串进来的是**服务端 DTO**
//     与将来的调用方，所以这一族只能在纯函数层钉。
//   * 「键缺席 = 未知，不是 0」（#390-A）：视图里只能看到渲染结果，看不出归一化有没有把好值丢掉。
//   * 字节换算的取整方向：显示给人看的数**只许向下取齐**，向上会让人以为还有余量。
import { describe, expect, it } from 'vitest';
import {
  buildUploadSettingsPayload,
  draftRangeHint,
  formatBytes,
  formatDraftBytes,
  normalizeUploadSettings,
  uploadValidationFieldOf,
} from './uploadSettings';

const LIMITS = { minBytes: 1024 * 1024, maxBytes: 1024 * 1024 * 1024 };
const DTO = {
  maxFileBytes: 8 * 1024 * 1024,
  source: 'db',
  reason: null,
  dbMaxFileBytes: 8 * 1024 * 1024,
  envMaxFileBytes: 32 * 1024 * 1024,
  envIsExplicit: true,
  defaultMaxFileBytes: 32 * 1024 * 1024,
  limits: LIMITS,
  updatedAt: '2026-11-16T02:00:00.000Z',
  updatedBy: 'u-1',
};

describe('buildUploadSettingsPayload：只放行纯十进制整数，其余一律 null（= 不发请求）', () => {
  it('放行整数（含负数，交给服务端判区间）', () => {
    expect(buildUploadSettingsPayload('1048576')).toEqual({ maxFileBytes: 1048576 });
    expect(buildUploadSettingsPayload(' 2097152 ')).toEqual({ maxFileBytes: 2097152 });
    expect(buildUploadSettingsPayload(1048576)).toEqual({ maxFileBytes: 1048576 });
    expect(buildUploadSettingsPayload('-5')).toEqual({ maxFileBytes: -5 });
  });

  // 本仓先例：`parseInt('1e4') === 1`。科学计数法在**这里**就不是整数形态，前端不许提前放行，
  // 否则变成「前端说行、服务端说不行」的两头说法（服务端 §4.15-2 也只收纯整数 JSON number）。
  for (const bad of ['', '   ', '1.5', '1e7', '1e4', '0x10', '1,024', 'abc', 'Infinity', 'NaN', '8.0']) {
    it(`「${bad}」⇒ null（不是 0，也不是 1）`, () => {
      expect(buildUploadSettingsPayload(bad)).toBeNull();
    });
  }

  it('超出安全整数的输入 ⇒ null：不许发一个已经失去精度的数', () => {
    expect(buildUploadSettingsPayload('9007199254740993')).toBeNull();
  });
});

describe('normalizeUploadSettings：显式白名单 + 「键缺席 = 未知」', () => {
  it('完整 DTO 逐键透传', () => {
    expect(normalizeUploadSettings(DTO)).toEqual({
      maxFileBytes: 8 * 1024 * 1024,
      source: 'db',
      reason: null,
      dbMaxFileBytes: 8 * 1024 * 1024,
      envMaxFileBytes: 32 * 1024 * 1024,
      envIsExplicit: true,
      defaultMaxFileBytes: 32 * 1024 * 1024,
      limits: LIMITS,
      updatedAt: '2026-11-16T02:00:00.000Z',
      updatedBy: 'u-1',
    });
  });

  it('缺键 ⇒ null（不是 0、不是 "default"）', () => {
    const empty = normalizeUploadSettings({});
    expect(empty).toEqual({
      maxFileBytes: null,
      source: null,
      reason: null,
      dbMaxFileBytes: null,
      envMaxFileBytes: null,
      envIsExplicit: false,
      defaultMaxFileBytes: null,
      limits: null,
      updatedAt: null,
      updatedBy: null,
    });
  });

  it('字符串数字与小数都不算生效值 ⇒ 未知（不许 Number() 顺手吞掉）', () => {
    expect(normalizeUploadSettings({ maxFileBytes: '1048576' }).maxFileBytes).toBeNull();
    expect(normalizeUploadSettings({ maxFileBytes: 1048576.5 }).maxFileBytes).toBeNull();
    expect(normalizeUploadSettings({ maxFileBytes: null }).maxFileBytes).toBeNull();
  });

  it('未知的 source 值不许被当成 db 或 default', () => {
    expect(normalizeUploadSettings({ source: 'mysql' }).source).toBeNull();
    expect(normalizeUploadSettings({ source: 'env' }).source).toBe('env');
  });

  it('envIsExplicit 用 === true：给了个"看起来真"的字符串也不算显式', () => {
    expect(normalizeUploadSettings({ envIsExplicit: 'false' }).envIsExplicit).toBe(false);
    expect(normalizeUploadSettings({ envIsExplicit: 1 }).envIsExplicit).toBe(false);
    expect(normalizeUploadSettings({ envIsExplicit: true }).envIsExplicit).toBe(true);
  });

  it('limits 半套（只有 minBytes）⇒ 两个数都算出来，缺失那个是 0 = 页面据此不显示区间', () => {
    const half = normalizeUploadSettings({ limits: { minBytes: 1048576 } });
    expect(half.limits).toEqual({ minBytes: 1048576, maxBytes: 0 });
  });

  it('服务端多塞的键不进状态（白名单，不是展开）', () => {
    const extra = normalizeUploadSettings({ ...DTO, smtp_password: 'hunter2', nested: { a: 1 } });
    expect(Object.keys(extra).sort()).toEqual(Object.keys(normalizeUploadSettings(DTO)).sort());
    expect(extra).not.toHaveProperty('smtp_password');
  });

  it('任何垃圾形状都不抛（这一页不许白屏）', () => {
    for (const raw of [null, undefined, [], 'x', 7, true]) {
      expect(() => normalizeUploadSettings(raw)).not.toThrow();
      expect(normalizeUploadSettings(raw).maxFileBytes).toBeNull();
    }
  });
});

describe('formatBytes：给人看的数只许向下取齐', () => {
  it('档位边界', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1048576)).toBe('1 MiB');
    expect(formatBytes(33554432)).toBe('32 MiB');
    expect(formatBytes(1073741824)).toBe('1 GiB');
  });

  it('33554431 显示成 31.99 MiB 而不是 32 MiB（向上取整会让人以为还有余量）', () => {
    expect(formatBytes(33554431)).toBe('31.99 MiB');
  });

  it('null / 负数 / 非安全整数 ⇒ null（页面据此显示「未知」）', () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(-1)).toBeNull();
    expect(formatBytes(1.5)).toBeNull();
    expect(formatBytes(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('formatDraftBytes：草稿无效时是 null，不是 "0 B"', () => {
    expect(formatDraftBytes('')).toBeNull();
    expect(formatDraftBytes('1e7')).toBeNull();
    expect(formatDraftBytes('2097152')).toBe('2 MiB');
  });
});

describe('draftRangeHint：只提示，不拦截', () => {
  it('区间内 ⇒ null；区间外 ⇒ below / above', () => {
    const settings = normalizeUploadSettings(DTO);
    expect(draftRangeHint('2097152', settings)).toBeNull();
    expect(draftRangeHint('512', settings)).toBe('below');
    expect(draftRangeHint('2147483648', settings)).toBe('above');
  });

  it('服务端没给 limits ⇒ null（此时以服务端的 400 为准，前端不编区间）', () => {
    expect(draftRangeHint('512', normalizeUploadSettings({}))).toBeNull();
    expect(draftRangeHint('512', null)).toBeNull();
  });

  it('草稿解析不出整数 ⇒ null（不叠加两条提示）', () => {
    expect(draftRangeHint('', normalizeUploadSettings(DTO))).toBeNull();
  });
});

describe('uploadValidationFieldOf：认得出才标红，认不出不猜', () => {
  const err = (status: number, field?: string) => ({ status, details: field ? { field } : undefined });

  it('400 + field=maxFileBytes / body ⇒ maxFileBytes', () => {
    expect(uploadValidationFieldOf(err(400, 'maxFileBytes'))).toBe('maxFileBytes');
    expect(uploadValidationFieldOf(err(400, 'body'))).toBe('maxFileBytes');
  });

  it('别的状态码 / 别的字段名 / 垃圾 ⇒ null', () => {
    expect(uploadValidationFieldOf(err(403, 'maxFileBytes'))).toBeNull();
    expect(uploadValidationFieldOf(err(400, 'smtp.host'))).toBeNull();
    expect(uploadValidationFieldOf(err(400))).toBeNull();
    expect(uploadValidationFieldOf(null)).toBeNull();
    expect(uploadValidationFieldOf('boom')).toBeNull();
  });
});
