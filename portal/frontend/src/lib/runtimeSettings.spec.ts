// `lib/runtimeSettings.ts` 的单测（issue #677 P2b）。
//
// 判据取自契约 §4.21 与本仓三条硬口径（归一化白名单 / 前端不做业务校验 / 值+来源+生效方式一起显示）。
// 这里刻意**不测组件**：组件那层由 `views/AdminRuntimeSettingsView.spec.ts` 用 DOM 断言。
import { describe, expect, it } from 'vitest';
import {
  RUNTIME_SETTINGS_PATH,
  buildRuntimeSettingPayload,
  draftOf,
  formatRuntimeValue,
  normalizeRuntimeSettingItem,
  normalizeRuntimeSettingSaved,
  normalizeRuntimeSettingsList,
  parseDraftInteger,
  replaceRuntimeSetting,
  runtimeSettingFieldOf,
  type RuntimeSettingItem,
} from './runtimeSettings';

const item = (over: Partial<RuntimeSettingItem> = {}): RuntimeSettingItem => ({
  key: 'session.ttl_seconds',
  label: '会话有效期（秒）',
  value: 86400,
  source: 'db',
  applyMode: 'hot',
  updatedAt: '2026-11-19T03:00:00.000Z',
  updatedBy: 'u-1',
  ...over,
});

describe('runtimeSettings: 归一化是显式白名单', () => {
  it('端点路径只有一处拼法', () => {
    expect(RUNTIME_SETTINGS_PATH).toBe('/api/admin/runtime-settings');
  });

  it('完整项逐字段归一化，未点名的键不进来', () => {
    const out = normalizeRuntimeSettingItem({
      ...item(), extra: 'ignored',
    });
    expect(out).not.toBeNull();
    expect(Object.keys(out as object).sort()).toEqual(
      ['applyMode', 'key', 'label', 'source', 'updatedAt', 'updatedBy', 'value'],
    );
    // 断言的仍是「没点名的键不进来」；双重转型只是为了让 `vue-tsc` 能走到这一步：
    // `RuntimeSettingItem` 既没有 `extra` 属性（直写是 TS2339），也没有索引签名（单转是 TS2352）。
    expect((out as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it('value 缺席 ⇒ null（不是 0）：「服务端没告诉我」不许显示成「当前是 0」', () => {
    expect(normalizeRuntimeSettingItem({ key: 'k.x', label: 'L' })?.value).toBeNull();
    expect(normalizeRuntimeSettingItem({ key: 'k.x', label: 'L', value: { a: 1 } })?.value).toBeNull();
    expect(normalizeRuntimeSettingItem({ key: 'k.x', label: 'L', value: Number.NaN })?.value).toBeNull();
  });

  it('source / applyMode 不认识的值各自回落（default / restart），不抛', () => {
    const out = normalizeRuntimeSettingItem({ key: 'k.x', source: 'weird', applyMode: 'nope' });
    expect(out?.source).toBe('default');
    expect(out?.applyMode).toBe('restart');
  });

  it('没有 key 的项直接丢（不许造一个 key=undefined 的行）', () => {
    expect(normalizeRuntimeSettingItem({ label: 'L' })).toBeNull();
    expect(normalizeRuntimeSettingItem(null)).toBeNull();
    expect(normalizeRuntimeSettingItem([1, 2])).toBeNull();
  });

  it('label 缺席时回落成 key（页面不至于空一列）', () => {
    expect(normalizeRuntimeSettingItem({ key: 'k.x' })?.label).toBe('k.x');
  });

  // `hint` 是 DTO 里的**可选键**（§4.21 + `portal/src/runtime-settings.js` 的 `withHint`：
  // registry 那一格登记了才带）。归一化必须保住「缺席」这个事实：补一个 `hint: null` / `''`
  // 就把「后端没说」变成了「后端说了个空」，渲染层也就没法「没有就不占行」（视图 spec 那一格钉 DOM）。
  it('hint 缺席 / 空串 / 非字符串 ⇒ 键不出现（不是 null、不是空串）；非空字符串原样保留', () => {
    const keysOf = (raw: unknown) => Object.keys(normalizeRuntimeSettingItem(raw) ?? {}).sort();
    const base = { key: 'k.x', label: 'L' };

    // 缺席（没这个键）以及后端可能发的各档“没内容”：键一律不出现
    for (const raw of [undefined, '', '   ', '\t\n', null, 7, 0, true, false, [], { a: 1 }]) {
      expect(keysOf({ ...base, hint: raw }), `hint=${String(raw)}`).not.toContain('hint');
    }
    expect(keysOf(base)).not.toContain('hint');

    // 非空字符串 ⇒ 保留且不删改空白（文案的真相在服务端，前端不重写它）
    const kept = normalizeRuntimeSettingItem({ ...base, hint: 'x' });
    expect(kept?.hint).toBe('x');
    expect(keysOf({ ...base, hint: 'x' })).toEqual(
      ['applyMode', 'hint', 'key', 'label', 'source', 'updatedAt', 'updatedBy', 'value'],
    );
  });
});

describe('runtimeSettings: 列表与保存响应', () => {
  it('只认 items 数组，按 key 去重且保持服务端顺序', () => {
    const list = normalizeRuntimeSettingsList({
      items: [item({ key: 'a.one' }), item({ key: 'b.two' }), item({ key: 'a.one', value: 1 })],
    });
    expect(list.map((i) => i.key)).toEqual(['a.one', 'b.two']);
    expect(list[0].value).toBe(86400);
  });

  it('形状不对 ⇒ 空数组（页面显示空态，而不是崩）', () => {
    expect(normalizeRuntimeSettingsList(null)).toEqual([]);
    expect(normalizeRuntimeSettingsList({ items: 'nope' })).toEqual([]);
    expect(normalizeRuntimeSettingsList({})).toEqual([]);
  });

  it('PUT 响应只认 item', () => {
    expect(normalizeRuntimeSettingSaved({ item: item({ value: 7200 }) })?.value).toBe(7200);
    expect(normalizeRuntimeSettingSaved({})).toBeNull();
  });

  it('replaceRuntimeSetting 原位替换；新 key 追加到末尾', () => {
    const list = [item({ key: 'a.one' }), item({ key: 'b.two', value: 1 })];
    const replaced = replaceRuntimeSetting(list, item({ key: 'b.two', value: 2 }));
    expect(replaced.map((i) => i.value)).toEqual([86400, 2]);
    expect(list[1].value).toBe(1); // 入参没被改
    const appended = replaceRuntimeSetting(list, item({ key: 'c.three' }));
    expect(appended.map((i) => i.key)).toEqual(['a.one', 'b.two', 'c.three']);
  });
});

describe('runtimeSettings: 前端不做业务校验（只做「能不能发」）', () => {
  it('只认纯十进制整数：1e4 / 1.5 / 空 / 负数 / 空白全不发', () => {
    for (const bad of ['', ' ', '1e4', '1.5', '-1', '0x10', '12a', '١٢']) {
      expect(parseDraftInteger(bad)).toBeNull();
      expect(buildRuntimeSettingPayload(bad)).toBeNull();
    }
    expect(parseDraftInteger(' 60 ')).toBe(60);
    expect(buildRuntimeSettingPayload('7200')).toEqual({ value: 7200 });
  });

  it('越界照发（服务端才是闸）：60 以下由 400 回来标红', () => {
    expect(buildRuntimeSettingPayload('1')).toEqual({ value: 1 });
    expect(buildRuntimeSettingPayload('99999999')).toEqual({ value: 99999999 });
  });

  it('details.field 只认三档，其余归 null', () => {
    expect(runtimeSettingFieldOf({ details: { field: 'key' } })).toBe('key');
    expect(runtimeSettingFieldOf({ details: { field: 'value' } })).toBe('value');
    expect(runtimeSettingFieldOf({ details: { field: 'body' } })).toBe('body');
    expect(runtimeSettingFieldOf({ details: { field: 'other' } })).toBeNull();
    expect(runtimeSettingFieldOf(null)).toBeNull();
  });
});

describe('runtimeSettings: 展示文案', () => {
  it('null 是「未知」⇒ 格式化返回 null、草稿为空串', () => {
    expect(formatRuntimeValue(null)).toBeNull();
    expect(draftOf(item({ value: null }))).toBe('');
  });

  it('布尔值不预填进数字框（预填 true 只会让用户困惑）', () => {
    expect(formatRuntimeValue(true)).toBe('true');
    expect(draftOf(item({ value: true }))).toBe('');
  });

  it('数字与字符串照原样显示', () => {
    expect(formatRuntimeValue(86400)).toBe('86400');
    expect(formatRuntimeValue('db-http')).toBe('db-http');
    expect(draftOf(item({ value: 7200 }))).toBe('7200');
  });
});
