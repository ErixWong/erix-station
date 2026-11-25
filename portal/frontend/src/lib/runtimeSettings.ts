// 管理台「运行时设置」页（issue #677 P2a/P2b）的纯逻辑：DTO 归一化 + 保存请求体构造 + 展示文案。
// 契约唯一来源：`docs/api/portal.md` §4.21（`GET/PUT /api/admin/runtime-settings`）。
//
// 为什么这些函数在 lib 里而不是组件里（与 `lib/uploadSettings.ts` 同一理由）：
// jsdom 不做布局，但「服务端给了没点名的键怎么办」「空输入要不要发请求」「这个值该怎么显示」
// 全是可断言的纯逻辑；放在组件里只能断言恒真的废话。
//
// 三条硬口径：
//   1. **归一化是显式白名单**：DTO 里没点名的键不猜（多一个字段就是多一个要维护的形状）。
//      `value` 缺席 ⇒ **`null`**（不是 `0`/`''`）：UI 必须显示「未知」，不许把「服务端没告诉我」
//      显示成「当前是 0」。
//   2. **前端不做业务校验**（照 §4.15 / §4.19 的口径）：数字框解析不出整数 ⇒ 不发请求
//      （发一个 `null` 只是把「用户还没填」伪装成「用户填了个非法值」）；解析得出整数就照发，
//      越界由服务端 `400 validation_failed` + `details.field` 回来标红。
//   3. **值、来源、生效方式必须一起显示**：`source`（db/env/default）与 `applyMode`（hot/restart）
//      是这一页的全部价值——只显示一个数字，运维就不知道「我改的这个数到底听不听」。

/** 端点路径（唯一拼法，视图与 store 共用）。 */
export const RUNTIME_SETTINGS_PATH = '/api/admin/runtime-settings';

export const RUNTIME_SETTING_SOURCES = ['db', 'env', 'default'] as const;
export type RuntimeSettingSource = (typeof RUNTIME_SETTING_SOURCES)[number];

export const RUNTIME_SETTING_APPLY_MODES = ['hot', 'restart'] as const;
export type RuntimeSettingApplyMode = (typeof RUNTIME_SETTING_APPLY_MODES)[number];

/**
 * 一个配置项（GET `items[]` 与 PUT `item` 同形）。
 *
 * `hint` 是**可选键**（后端 registry 那一格登记了才带，没登记就连键都没有 —— 不是 `null`、
 * 不是空串，见 `portal/src/runtime-settings.js` 的 `withHint` 与 §4.21）。
 * 为什么不是「人人一个 null」：那一行小字要「有就渲染、没有就不占行」，一个恒存在的 `null`
 * 只能让渲染层自己判空，而键的缺席/存在本身就是后端给的信号。
 */
export interface RuntimeSettingItem {
  key: string;
  label: string;
  value: number | string | boolean | null;
  source: RuntimeSettingSource;
  applyMode: RuntimeSettingApplyMode;
  /** 输入框类型：`text` = 自由文本（如 kk 地址），缺省一律 `integer`（后端只有那一格声明 text）。 */
  kind: 'integer' | 'text';
  updatedAt: string | null;
  updatedBy: string | null;
  /** 服务端登记过的行内提示文案（原样照抄，本页不翻译、不参与任何判定）。 */
  hint?: string;
}

const asSource = (raw: unknown): RuntimeSettingSource =>
  (RUNTIME_SETTING_SOURCES as readonly string[]).includes(String(raw)) ? (raw as RuntimeSettingSource) : 'default';

const asApplyMode = (raw: unknown): RuntimeSettingApplyMode =>
  (RUNTIME_SETTING_APPLY_MODES as readonly string[]).includes(String(raw))
    ? (raw as RuntimeSettingApplyMode)
    : 'restart';

const asScalarOrNull = (raw: unknown): RuntimeSettingItem['value'] => {
  const t = typeof raw;
  if (t === 'number' && Number.isFinite(raw as number)) return raw as number;
  if (t === 'boolean') return raw as boolean;
  if (t === 'string') return raw as string;
  // 对象/数组/NaN/null ⇒ 未知。**不猜**（猜成 0 就是假账）。
  return null;
};

const asTextOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() !== '' ? raw : null;

/**
 * `hint` 走的是**白名单里的可选键**：非字符串 / 空串 / 纯空白 ⇒ **键不出现**（不是 `hint: null`、
 * 不是 `hint: ''`）。差别是可断言的：`'hint' in item` 与渲染层的 `v-if` 都以键的缺席为准，
 * 归一化时补一个 `null` 就是把「后端没说」变成「后端说了个空」，前端也就没法「没有就不占行」。
 */
const withOptionalHint = <T extends object>(out: T, raw: unknown): T & { hint?: string } =>
  typeof raw === 'string' && raw.trim() !== '' ? { ...out, hint: raw } : out;

/** 单项归一化（GET 的 `items[]` 与 PUT 的 `item` 共用这一份）。 */
export function normalizeRuntimeSettingItem(raw: unknown): RuntimeSettingItem | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== 'string' || r.key.trim() === '') return null;
  return withOptionalHint({
    key: r.key,
    label: typeof r.label === 'string' && r.label.trim() !== '' ? r.label : r.key,
    value: asScalarOrNull(r.value),
    source: asSource(r.source),
    applyMode: asApplyMode(r.applyMode),
    // #787：只有后端显式给 `kind: 'text'` 才当 text；其余（缺字段/别的值）一律 integer。
    kind: (r.kind === 'text' ? 'text' : 'integer') as RuntimeSettingItem['kind'],
    updatedAt: asTextOrNull(r.updatedAt),
    updatedBy: asTextOrNull(r.updatedBy),
  }, r.hint);
}

/** `GET` 响应归一化：只认 `items` 数组，**按 key 去重且保持服务端顺序**（顺序是 registry 的顺序）。 */
export function normalizeRuntimeSettingsList(raw: unknown): RuntimeSettingItem[] {
  if (raw === null || typeof raw !== 'object') return [];
  const items = (raw as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: RuntimeSettingItem[] = [];
  for (const it of items) {
    const item = normalizeRuntimeSettingItem(it);
    if (item === null || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** `PUT` 响应归一化：只认 `item`。 */
export function normalizeRuntimeSettingSaved(raw: unknown): RuntimeSettingItem | null {
  if (raw === null || typeof raw !== 'object') return null;
  return normalizeRuntimeSettingItem((raw as Record<string, unknown>).item);
}

/**
 * 数字框的一手值是字符串（DOM 如此）。返回 `null` = **不发请求**（解析不出整数）。
 * ⚠ 刻意不用 `Number()` / `parseInt()`：`parseInt('1e4') === 1` 那族会把「用户打错了」
 * 静默变成「保存了一个别的数」（台账 §8.126）。只认 `/^\d+$/`。
 */
export function parseDraftInteger(draft: string): number | null {
  const text = draft.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}

/** 保存请求体：`{ value }`（§4.21）。解析失败 ⇒ `null`（调用方据此不发请求）。 */
export function buildRuntimeSettingPayload(draft: string): { value: number } | null {
  const value = parseDraftInteger(draft);
  return value === null ? null : { value };
}

/**
 * 按 `item.kind` 选发法（#787）：
 *   · `text` ⇒ `{ value: draft.trim() }`——**空串照发**（服务端才是闸，前端不预拒）；
 *   · 其余 ⇒ 走现有 `buildRuntimeSettingPayload`（整数解析，解不出 ⇒ `null` 不发）。
 * ❗ `buildRuntimeSettingPayload` 本体与导出行为不变（既有测试钉着）。
 */
export function buildRuntimeSettingPayloadFor(
  item: RuntimeSettingItem,
  draft: string,
): { value: number | string } | null {
  if (item.kind === 'text') return { value: draft.trim() };
  return buildRuntimeSettingPayload(draft);
}

/** `400` 的 `details.field` 归一化：只认 §4.21 点名的三档，其余归 `null`（不猜）。 */
export function runtimeSettingFieldOf(error: unknown): 'key' | 'value' | 'body' | null {
  const details = (error as { details?: Record<string, unknown> } | null)?.details;
  const field = details?.field;
  return field === 'key' || field === 'value' || field === 'body' ? field : null;
}

/** 值 → 给人看的文本。`null` 是「未知」，**不是** 0 / 空串。 */
export function formatRuntimeValue(value: RuntimeSettingItem['value']): string | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** 草稿输入框的初值：`null`（未知）⇒ 空串（让用户自己填，而不是预填一个假数）。 */
export function draftOf(item: RuntimeSettingItem): string {
  const text = formatRuntimeValue(item.value);
  return text === null || typeof item.value === 'boolean' ? '' : text;
}

/** 保存成功后的回填：用响应 DTO 换掉列表里那一条（其余保持原位序）。 */
export function replaceRuntimeSetting(
  list: RuntimeSettingItem[],
  saved: RuntimeSettingItem,
): RuntimeSettingItem[] {
  const at = list.findIndex((i) => i.key === saved.key);
  if (at < 0) return [...list, saved];
  const next = list.slice();
  next[at] = saved;
  return next;
}
