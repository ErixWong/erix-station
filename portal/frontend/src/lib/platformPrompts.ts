// 管理台「提示词」页（issue #596 片 B）的纯逻辑：DTO 归一化 + 请求体构造 + 400 字段映射
// + 「保存后物化到底通知了没有」的判据 + 只读清单。
//
// 契约：`docs/api/portal.md` §4.18（端点与 DTO）、`docs/design/admin-prompts-panel-2026-11-16.md`
// §1（哪些可改）/ §6（DTO）/ §7（前端要求）。
// ⚠ **DTO 的真相在后端实现里**（`portal/src/platform-prompts.js` 的 `toPlatformPromptsDto`），
//   键集由后端判据 `portal/test/platform-prompts.test.js` 的 `P8c` 逐键钉住。本文照那份写，
//   **不照设计文档猜**（设计文档 §6 的例子少了 `reason` 这个 additive 键，且 `templateBytes`
//   的数值本来就不是契约值）。
//
// 为什么这些函数在 lib 里而不是组件里（AGENTS §8.14 / `lib/uploadSettings.ts` 同族）：
//   「服务端多塞一个没点名的键怎么办」「`materializeEnqueued=0` 到底是『没工位』还是『没通知』」
//   「`readonly[]` 给了前端没说明文案的第 5 个 key 要不要显示」都是**纯计算**，
//   放在组件里只能断言恒真的废话。
//
// 三条硬口径：
//   1. **归一化是显式白名单且永不抛**：`GET` 在「表不存在 / 读失败 / 读超时」时也回 `200`
//      （§4.18-1），所以任何形状都不许让这一页白屏。逐键取值，漏一个键只会让那一格显示「未知」。
//   2. **服务端才是闸**（§4.18-2）：文本框里是什么就发什么，**越界照发**，由
//      `400 validation_failed` + `details` 回来标红；前端只在「连长度都算不出」
//      （进来的根本不是字符串）时不发请求 —— 发一个 `{text: null}` 只是把「用户还没填」
//      伪装成「用户填了个非法值」。
//   3. **「跟随内置」只有一条判据**：`text === ''`（§4.18 开头）。前端**从文本自己派生**，
//      不去读服务端的 `isDefault`：读侧的判据本来就是它，读两份真相迟早分叉。
import type { ApiError } from '../api';

/** `GET /api/admin/prompts`（也是三个 `PUT` 响应里 DTO 那一份的路径前缀）。 */
export const PLATFORM_PROMPTS_PATH = '/api/admin/prompts';

/** 三块的字段名（DTO 键名 = 写侧字段名，与后端 `PROMPT_FIELDS` 同名单）。 */
export const PROMPT_FIELD_KEYS = ['addendum', 'agentsMd', 'titlePrompt'] as const;
export type PromptFieldKey = (typeof PROMPT_FIELD_KEYS)[number];

/** 路由 slug（唯一一处字段名 → URL 的映射；后端 `http.js` 用的是同一组 slug）。 */
const PROMPT_SLUGS: Record<PromptFieldKey, string> = {
  addendum: 'addendum',
  agentsMd: 'agents-md',
  titlePrompt: 'title-prompt',
};

/** `addendum` / `agentsMd` 参与物化，`titlePrompt` 不涉（§4.18-4）。 */
const MATERIALIZING_FIELDS: readonly PromptFieldKey[] = ['addendum', 'agentsMd'];

/** 只读清单（第一期不开放在线覆写的那 4 条，§1/§6）。后端只给 `key`，说明文案在前端 i18n。 */
export const READONLY_PROMPT_KEYS = [
  'runnerSystemPrompt',
  'childSystemPrompt',
  'toolDescriptions',
  'engineNotices',
] as const;
export type ReadonlyPromptKey = (typeof READONLY_PROMPT_KEYS)[number];

/**
 * `GET` DTO 的 `reason`：`null` = DB 生效；其余三种是「现在用的是内置提示词」的**可区分**原因。
 * `'unknown'` **不是后端发的值**：它出现在「服务端给了一个前端不认识的 reason」时 ——
 * 后端将来加第四种 reason 时，页面必须说「有个原因我不认识」，而不是整行不显示，
 * 也不许把它当成 `no_row`（那会说成「管理台还没配过」，而真故障可能在连接上）。
 */
export const PROMPT_FALLBACK_REASONS = ['no_row', 'read_failed', 'read_timeout'] as const;
export type PromptKnownReason = (typeof PROMPT_FALLBACK_REASONS)[number];
export type PromptFallbackReason = PromptKnownReason | 'unknown';

/** 一块可编辑文本的当前状态（`addendum` / `titlePrompt` 同形）。 */
export interface PromptBlock {
  /** DB 里的当前值（`''` = 跟随内置）。服务端没给这一格 ⇒ `''`（并显示成「跟随内置」）。 */
  text: string;
  /** `= (text === '')`，前端派生（口径见文件头第 3 条）。 */
  isDefault: boolean;
  /** 写侧上限（8192 / 2000）。`null` = 服务端没给 ⇒ 不许显示一个编出来的数。 */
  maxBytes: number | null;
  /** 当前值的 UTF-8 字节数（服务端给的数；`null` = 没给，此时前端自己按 UTF-8 算）。 */
  bytes: number | null;
}

/** 整段覆写那一块（`agentsMd`）：除文本外还要能显示「整份文件多大、上限多大、生效全文」。 */
export interface AgentsMdBlock {
  override: string;
  /** `= (override !== '')`，前端派生。页面据此显示「已偏离内置模板」。 */
  isOverridden: boolean;
  isDefault: boolean;
  templateBytes: number | null;
  effectiveBytes: number | null;
  /** 按固定示例工位名渲染的整份 `~/AGENTS.md`（零时间戳 ⇒ 可对比）。没给 ⇒ `''`。 */
  effectiveText: string;
  maxBytes: number | null;
  /** 注入侧对**整份**文件的字节上限（= `runner/lib/agents-md.js` 的常量）。 */
  renderedLimitBytes: number | null;
}

/** 标题提示词那一块：多一个内置默认全文（它是 portal 侧的真相，可以显示）。 */
export interface TitlePromptBlock extends PromptBlock {
  defaultText: string;
}

/** 归一化后的整页状态（GET DTO + PUT 响应多出来的 `materializeEnqueued`）。 */
export interface PlatformPrompts {
  addendum: PromptBlock;
  agentsMd: AgentsMdBlock;
  titlePrompt: TitlePromptBlock;
  /** 后端给的只读 key，**按后端顺序**、只留认识的（未登记的进 `unknownReadonly`）。 */
  readonly: ReadonlyPromptKey[];
  /** `readonly[]` 里前端没有说明文案的 key（不猜它是什么，只按原文列出来）。 */
  unknownReadonly: string[];
  updatedAt: string | null;
  /** 操作人 uuid（**没有显示名**，页面显示成短 uuid 或「—」，见 `shortUuid`）。 */
  updatedBy: string | null;
  reason: PromptFallbackReason | null;
  /** 最近一次 `PUT` 响应的入队条数；`GET` 不带这个键 ⇒ `null` = 未知。 */
  materializeEnqueued: number | null;
}

/** 写侧请求体（§4.18-2）：只有一个 `text`，且必须是 JSON 字符串（`''` 合法）。 */
export interface PromptPayload {
  text: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** 字节数一类的非负安全整数才收；其它形状 ⇒ `null` = 未知（不许拿 0 冒充，#283 同口径）。 */
function safeIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 文本位：只收真字符串（`null`/缺键/数字 ⇒ `''`，即「跟随内置」）。 */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * UTF-8 字节数（与后端 `Buffer.byteLength(text, 'utf8')` 同口径）。
 * 手写而不用 `TextEncoder`：jsdom / 构建产物里那个全局不保证存在，而这里只需要长度不需要编码。
 * `for...of` 按**码点**迭代 ⇒ 代理对（emoji）算一个 4 字节字符，不会双计。
 */
export function utf8ByteLength(text: string): number {
  let total = 0;
  for (const char of typeof text === 'string' ? text : '') {
    const cp = char.codePointAt(0) ?? 0;
    total += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return total;
}

function reasonOrNull(value: unknown): PromptFallbackReason | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'unknown';
  return (PROMPT_FALLBACK_REASONS as readonly string[]).includes(value)
    ? value as PromptKnownReason
    : 'unknown';
}

/**
 * `readonly[]` 的形状是**对象数组** `[{ key: 'runnerSystemPrompt' }, …]`（§4.18-1，
 * 后端 `P8c` 逐字钉住），**不是**字符串数组。只取 `key` 且只认字符串：
 * `text` / `where` 这类多余键一律丢掉 —— portal 镜像不含 `runner/`，后端自己就读不到全文，
 * 它哪天误发一份文本进来也不许被当成真相渲染（那才是撑不起的承诺）。
 * 裸字符串也收（旧形状 / 手写例子），`{key: 42}` / `{}` / `null` 丢掉，不 `String()` 强转。
 */
function readonlyKeysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys: string[] = [];
  for (const item of value) {
    const raw = asRecord(item);
    const key = raw === null ? item : raw.key;
    if (typeof key === 'string' && key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function normalizeAddendum(raw: unknown): PromptBlock {
  const src = asRecord(raw) ?? {};
  const text = textOf(src.text);
  return {
    text,
    isDefault: text === '',
    maxBytes: safeIntOrNull(src.maxBytes),
    // 服务端给了就用它（真相），没给才自己算（同一个 UTF-8 口径，不是猜）。
    bytes: safeIntOrNull(src.bytes) ?? utf8ByteLength(text),
  };
}

function normalizeAgentsMd(raw: unknown): AgentsMdBlock {
  const src = asRecord(raw) ?? {};
  const override = textOf(src.override);
  return {
    override,
    isOverridden: override !== '',
    isDefault: override === '',
    templateBytes: safeIntOrNull(src.templateBytes),
    effectiveBytes: safeIntOrNull(src.effectiveBytes),
    effectiveText: textOf(src.effectiveText),
    maxBytes: safeIntOrNull(src.maxBytes),
    renderedLimitBytes: safeIntOrNull(src.renderedLimitBytes),
  };
}

function normalizeTitlePrompt(raw: unknown): TitlePromptBlock {
  const base = normalizeAddendum(raw);
  return { ...base, defaultText: textOf(asRecord(raw)?.defaultText) };
}

/**
 * 归一化 DTO（`GET` 与 `PUT` 响应同一个形状 + `materializeEnqueued`）。**永不抛**。
 * 逐键取值 ⇒ 服务端漏一个键只会让那一格显示「未知」/「跟随内置」，不会连带整页崩。
 */
export function normalizePlatformPrompts(raw: unknown): PlatformPrompts {
  const src = asRecord(raw) ?? {};
  const readonlyAll = readonlyKeysOf(src.readonly);
  const known = readonlyAll.filter(
    (key): key is ReadonlyPromptKey => (READONLY_PROMPT_KEYS as readonly string[]).includes(key),
  );
  return {
    addendum: normalizeAddendum(src.addendum),
    agentsMd: normalizeAgentsMd(src.agentsMd),
    titlePrompt: normalizeTitlePrompt(src.titlePrompt),
    readonly: known,
    unknownReadonly: readonlyAll.filter((key) => !known.includes(key as ReadonlyPromptKey)),
    updatedAt: typeof src.updatedAt === 'string' && src.updatedAt !== '' ? src.updatedAt : null,
    updatedBy: typeof src.updatedBy === 'string' && src.updatedBy !== '' ? src.updatedBy : null,
    reason: reasonOrNull(src.reason),
    // 只有 `PUT` 响应带这个键；`0` 是真值「一台都没入队」，缺键是「不知道」—— 两者不能合并。
    materializeEnqueued: safeIntOrNull(src.materializeEnqueued),
  };
}

/**
 * 文本框的一手值 → 请求体（§4.18-2 只有 `text` 一个字段）。
 *
 * **只有「进来的不是字符串」才返回 `null`（= 不发请求）**：文本框没有「解析不出数值」那种形态，
 * 越界是服务端的判断（它会回 `400` + `details`，页面据此标红），前端不许抢这道闸。
 * `''` 是**合法值**（= 清空 / 跟随内置），不许在这里当「没填」丢掉。
 */
export function buildPromptPayload(input: unknown): PromptPayload | null {
  return typeof input === 'string' ? { text: input } : null;
}

/** 单个字段的 `PUT` 路径（唯一拼法；slug 与后端 `http.js` 的路由一致）。 */
export function platformPromptPath(field: PromptFieldKey): string {
  return `/api/admin/prompts/${PROMPT_SLUGS[field]}`;
}

/**
 * 400 时决定「标红哪张卡」。
 *
 * ⚠ 服务端的 `details.field` 是 **`'text'` / `'body'` / `'field'`**，**不是** DTO 的键名
 * （`platform-prompts.js` 的 `fail()` 只说「这一格里哪个位置错了」）。所以「是哪张卡」这件事
 * 只能由「刚才那张卡发了请求」来定 —— 这比从错误文本里猜可靠。
 * 非 400 / 没有 `details.field` ⇒ `null`（退化成整页一条错误，不猜是哪个框）。
 */
export function promptValidationFieldOf(
  error: unknown,
  savedField: PromptFieldKey,
): PromptFieldKey | null {
  if (error === null || typeof error !== 'object') return null;
  const { status, details } = error as Partial<ApiError>;
  if (status !== 400) return null;
  const field = (details as Record<string, unknown> | undefined)?.field;
  if (field === 'text' || field === 'body' || field === 'field') return savedField;
  return null;
}

/**
 * `materializeEnqueued` 的语义（§4.18-4）—— 页面在 `0` 时**必须**说「已保存，但物化未通知」。
 *
 * | 值 | 含义 | 页面 |
 * |---|---|---|
 * | `> 0` | 已通知 N 台启用中的工位重物化 | 「已通知 {count} 台 ⇒ 各自下一次 run 生效」 |
 * | `0`（追加段 / 整段覆写） | 一台启用中的工位都没有，**或通知没发出去** | 「已保存，但物化未通知（portal 重启后全量重建收敛）」 |
 * | `0`（标题提示词） | **本来就不涉物化**（恒 0） | 「已保存 ⇒ 下一次改名生效」——说「物化未通知」是撒谎 |
 * | `null` | 服务端没给这个键（旧后端 / 形状漂了） | 「已保存，但物化通知条数未给出」——不许当「已通知」 |
 */
export type MaterializeNotice = 'enqueued' | 'not_enqueued' | 'enqueued_unknown' | 'no_materialize';

export function materializeNoticeOf(
  field: PromptFieldKey,
  enqueued: number | null,
): MaterializeNotice {
  if (!MATERIALIZING_FIELDS.includes(field)) return 'no_materialize';
  if (enqueued === null) return 'enqueued_unknown';
  return enqueued > 0 ? 'enqueued' : 'not_enqueued';
}

/**
 * `updatedBy` 只有 uuid、**没有显示名**（§4.18-1）。页面必须显示成「短 uuid」或「—」：
 * 留空会让人以为「没人改过」，而那恰恰是没改过的样子。取前 8 位当短形式（认不出的形状原样给）。
 */
export function shortUuid(value: string | null): string | null {
  if (value === null) return null;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(value);
  return uuid === null ? value : `${value.slice(0, 8)}…`;
}

/** 字节显示：单一真相在 `lib/uploadSettings.formatBytes`（不许抄第二份换算）。 */
export { formatBytes } from './uploadSettings';
