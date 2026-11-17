// 能力市场（issue #595）的**纯逻辑**：端点路径 + DTO 归一化 + bundle 打包 + 错误码文案。
// 契约唯一来源：`docs/design/capability-market.md` §7（API）/ §8（UI）/ §3（包规范）/ §4（预算闸）。
//
// 为什么这些在 lib 而不是组件里（照 `lib/uploadSettings.ts` 的站内口径）：
// 「服务端漏了一个键该怎么显示」「path 含 `..` 要不要前端先挡」「409 预算超额该说哪句话」
// 都是**纯计算**，放在组件里只能断言恒真的废话。
//
// 三条硬口径：
//   1. **归一化永不抛**：任何形状都不让这一页白屏；缺键 ⇒ `null` / 空数组，UI 显示「—」而不是 0。
//      ⚠「不知道」不渲染成「没有」（#390-A 的纪律）：`toolCount: null` 是「服务端没说工具数」，
//      不是「这个包没有工具」；`installs: null` 不是「没人装」。
//   2. **前端不抢服务端的闸**（§3：路径/字节/条数的权威校验在 `portal/src/market.js`）。
//      这里只挡**一眼假**的 path（绝对路径 / 含 `..` / 含 `\` / 超长 / 空），目的是不发一个必然
//      400 的体；挡不住的那一半（文件数超、单文件超字节、slug 不合规、缺 `skill.mjs`）由服务端
//      `400 validation_failed` + `details.field` 回来。前端**不许**假装自己是校验器。
//   3. **错误分支只认 `code`**（§1.1 口径）：`error.message` 是服务端原文，不翻译，只在没有
//      专属文案时兜进通用文案。
import { toDisplayText, type ApiError } from '../api';
import { i18n } from '../i18n';
// 字节显示复用「上传上限」页那一份换算（同一站内口径，不另写一份 MiB 换算）。
import { formatBytes } from './uploadSettings';

const t = i18n.global.t;

// ── 端点路径（§7，唯一拼法；视图与单测共用）────────────────────────────────────

/** 用户面列表（只回 `published`，每条带 `installed` / `enabled` / `version`）。 */
export const MARKET_ITEMS_PATH = '/api/market/items';

/** 管理面列表（含 draft/retired，带 `installs` 计数；`?state=` 可选过滤）。 */
export const ADMIN_MARKET_ITEMS_PATH = '/api/admin/market/items';

/** 用户面条目基址：详情 = `path(slug)`，动作再拼 `/install` `/uninstall` `/enabled`（§7）。 */
export function marketUserItemPath(slug: string): string {
  return `${MARKET_ITEMS_PATH}/${encodeURIComponent(slug)}`;
}

/** 管理面条目基址：详情 / `/publish` / `/retire` 都用它（§7，主键是 uuid `id`）。 */
export function adminMarketItemPath(id: string): string {
  return `${ADMIN_MARKET_ITEMS_PATH}/${encodeURIComponent(id)}`;
}

/**
 * MCP 凭据端点（#608 §7.2）：`GET` 回**声明 + 有没有值**，`PUT` 写值。
 *
 * ⚠ 这个地址是「只写不读」的判据锚点（§3.1 / §10）：**GET 永不回值**，所以地址上也不许挂 query
 * （挂 `?reveal=1` 之类就是在给「读值」留门）。视图里对它只有两种调用形态：GET（读声明）与
 * PUT（写值），`AdminMarketView.spec.ts` 有源码级断言钉这一点。
 */
export function adminMarketSecretsPath(id: string): string {
  return `${adminMarketItemPath(id)}/secrets`;
}

/**
 * 单 FDE **启用**技能的上限（§4 的 `MAX_ENABLED_SKILLS`；policy，不是 ops 参数 ⇒ 没有 env 旋钮）。
 * ⚠ 这个数字出现在前端**只为了写文案**：前端不做本地拦截（启用请求照发，409 照接）。
 * 服务端 `details` 里若带了实际生效值，以它为准（见 `budgetLimitOf`）。
 */
export const MAX_ENABLED_SKILLS = 12;

/** §3 的单条 path 长度上限（超长属于一眼假；文件数/字节上限不在前端挡）。 */
export const MAX_BUNDLE_PATH_BYTES = 200;

// ── DTO 形状（后端下发 snake_case；缺键 ⇒ null，绝不补一个看起来合理的值）──────

/** 工具的一条参数（参数清单本身不在 §2 的 manifest 里，是留给后端的扩展）。 */
export interface MarketToolParam {
  name: string;
  type: string | null;
  required: boolean;
}

/** 清单里的一条工具（§2 `manifest.tools` 只有 name / description）。 */
export interface MarketTool {
  name: string;
  description: string | null;
  /** 参数清单；服务端不下发 ⇒ `[]`（UI 整段不出，不写「无参数」那种假话）。 */
  params: MarketToolParam[];
}

/** 静态扫描的一条提示（§3：advisory，不是安装闸门）。 */
export interface SecurityWarning {
  code: string | null;
  path: string | null;
  line: number | null;
  note: string | null;
}

/** 包内文件清单的一条（§2 `manifest.files` / §7-7 详情里的文件清单）。 */
export interface MarketFileEntry {
  path: string;
  bytes: number | null;
}

/** 列表卡片用的形状（用户面 §7-1；管理面在它上面叠 state / installs）。 */
export interface MarketListItem {
  slug: string;
  kind: string;
  /**
   * MCP 的准入理由（#608 §4.4：`stateful` / `tool_surface_gt_12` / `shared_quota` /
   * `credential_boundary`；skill 不带）。`null` = 服务端没说 ⇒ 卡片整段不出（**不**写「无理由」）。
   */
  reason: string | null;
  /** MCP 的暴露档（§4.3 `direct`/`deferred`/`hidden`）。`null` = 没说（skill 条目就是 null）。 */
  exposure: string | null;
  /**
   * MCP 的必填槽是否齐（§7.2 用户面 `secrets_ready`）。
   * 三档：`true` 齐 / `false` 缺（⇒「启用」禁用）/ `null` 服务端没说（⇒ 不拦，以服务端 409 为准）。
   */
  secretsReady: boolean | null;
  name: string;
  summary: string;
  version: string;
  tags: string[];
  /** 工具条数。`null` = 服务端没给 ⇒ 显示「—」，不显示 0。 */
  toolCount: number | null;
  /** 静态扫描分（0..100）。`null` = 没给。 */
  securityScore: number | null;
  /** 扫描提示条数。`null` = 没下发这个字段；`0` = 真的干净。两者在界面上不同。 */
  warningCount: number | null;
  installed: boolean;
  enabled: boolean;
  /** 已装的版本号（§4 漂移：与 `version` 不等 ⇒ 页面给「重新安装」）。`null` = 没给。 */
  installedVersion: string | null;
}

/**
 * MCP 的一条配置槽声明（§4.1：`name` / `kind` / `inject` / `required` / `description`）。
 * 值**不在这里**——值只在 `McpSecretSlot` 的 `hasValue` 里以「有没有」的形态出现（§3.1 只写不读）。
 */
export interface McpSlotSpec {
  name: string;
  kind: string;
  inject: string;
  required: boolean;
  description: string;
}

/** 一条 MCP 条目的连接配置（§3 的 manifest 形状；缺键 ⇒ 空串 / `null`，不补「看起来合理」的值）。 */
export interface McpConfig {
  transport: string;
  command: string;
  args: string[];
  url: string;
  exposure: string;
  lifecycle: string;
  reason: string | null;
  timeoutMs: number | null;
  slots: McpSlotSpec[];
  /** `manifest.tools_cache_at`（runner 回填的时间戳，§6.6）。`null` = 从没回填过。 */
  toolsCacheAt: string | null;
}

/** 管理台「凭据」区的一行（§7.2 的 GET secrets：永不含值）。 */
export interface McpSecretSlot {
  name: string;
  kind: string;
  inject: string;
  required: boolean;
  /** `has_value`：有值 / 没值。**值本身不在 DTO 里**，所以界面只能说「已设置 / 未设置」。 */
  hasValue: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** 用户面详情（§7-2：含 `SKILL.md` 正文）。 */
export interface MarketDetail extends MarketListItem {
  /** 「何时用」——§2 里是 L3 的路由信号（必填）；服务端没给 ⇒ 空串，UI 整段不出。 */
  whenToUse: string;
  /** 详情页正文（§2 `description_md`，可空）。 */
  descriptionMd: string;
  /** `SKILL.md` 正文。⚠ 契约没给这个字段起名 ⇒ 多键兜底，见 `readmeOf`。 */
  readme: string | null;
  author: string | null;
  license: string | null;
  tools: MarketTool[];
  files: MarketFileEntry[];
  warnings: SecurityWarning[];
  /** MCP 配置（§3 的 manifest 段）；skill 条目各键为缺席形状。 */
  mcp: McpConfig;
}

/** 管理台表格的一行（§7-3：列表带 `installs` 计数）。 */
export interface AdminMarketItem extends MarketListItem {
  /** uuid 主键（管理面的详情 / 发布 / 下线都用它，不用 slug）。 */
  id: string;
  /** `draft` / `published` / `retired`；不认识的退到「未知状态」，不折叠成 draft。 */
  state: string;
  /** 安装数。`null` = 没下发 ⇒ 「—」，**不许拿 0 冒充「没人装」**。 */
  installs: number | null;
}

/** 管理台详情（§7-7：含文件清单与扫描结果，**不回包内容**）。 */
export interface AdminMarketDetail extends AdminMarketItem {
  whenToUse: string;
  descriptionMd: string;
  /** 编辑表单回填用（§7-3 的列表不保证带这些元数据 ⇒ 编辑前先取一次详情）。 */
  author: string | null;
  license: string | null;
  tools: MarketTool[];
  files: MarketFileEntry[];
  warnings: SecurityWarning[];
  /** MCP 配置 + `tools_cache_at`（§8.1 详情的「工具清单」区要用）。 */
  mcp: McpConfig;
}

// ── 归一化的底座（永不抛）────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 列表信封：契约只写「列表」，没钉 `{items}` 还是裸数组 ⇒ 两种都收，其余形状 ⇒ 空列表。 */
function itemsOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const items = asRecord(raw)?.items;
  return Array.isArray(items) ? items : [];
}

/** 详情信封：`{item:{…}}` 与摊平两种都收（§7 没钉，后端在另一分支并行实现）。 */
function detailOf(raw: unknown): Record<string, unknown> | null {
  const bag = asRecord(raw);
  if (bag === null) return null;
  return asRecord(bag.item) ?? bag;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 非负整数才收（计数、字节、行号）；其它形状 ⇒ `null`（不猜、不补 0）。 */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 扫描分：只认 0..100 的整数（§3 的算式 `max(0, 100 - 10n)` 落在这个区间）。 */
function scoreOrNull(value: unknown): number | null {
  const n = countOrNull(value);
  return n !== null && n <= 100 ? n : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === 'string' && x !== '');
}

/**
 * 参数清单，接受四种写法（§2 的 manifest 只写了 `{name,description}`，参数是留给后端的扩展）：
 *   * `[{name,type,required}]` 数组；
 *   * `['a','b']` 只有名字的数组；
 *   * `{a:'string'}` 名字 → 类型的映射；
 *   * JSON Schema：`{properties:{a:{type}},required:['a']}`。
 * 认不出来 ⇒ `[]`（**不**把原始对象 `JSON.stringify` 上屏）。
 */
function paramsOf(raw: unknown): MarketToolParam[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((entry): MarketToolParam[] => {
      if (typeof entry === 'string' && entry !== '') return [{ name: entry, type: null, required: false }];
      const row = asRecord(entry);
      if (row === null) return [];
      const name = str(row.name ?? row.key);
      if (name === null || name === '') return [];
      return [{ name, type: str(row.type), required: row.required === true }];
    });
  }
  const bag = asRecord(raw);
  if (bag === null) return [];
  const properties = asRecord(bag.properties);
  if (properties !== null) {
    const required = new Set(stringList(bag.required));
    return Object.entries(properties).map(([name, spec]) => ({
      name,
      type: str(asRecord(spec)?.type) ?? str(spec),
      required: required.has(name),
    }));
  }
  return Object.entries(bag).map(([name, spec]) => ({
    name,
    type: str(asRecord(spec)?.type) ?? str(spec),
    required: false,
  }));
}

/** 工具清单：`tools[]` 或 `manifest.tools[]` 或 `manifest.tools_cache[]`（MCP 的那份是 runner 回填的，#608 §6.6）。 */
function toolsOf(row: Record<string, unknown>): MarketTool[] {
  const manifest = asRecord(row.manifest);
  const raw = Array.isArray(row.tools)
    ? row.tools
    : Array.isArray(manifest?.tools)
      ? (manifest?.tools as unknown[])
      : Array.isArray(manifest?.tools_cache)
        ? (manifest?.tools_cache as unknown[])
        : [];
  return raw.flatMap((entry): MarketTool[] => {
    if (typeof entry === 'string' && entry !== '') {
      return [{ name: entry, description: null, params: [] }];
    }
    const tool = asRecord(entry);
    if (tool === null) return [];
    const name = str(tool.name ?? tool.id);
    if (name === null || name === '') return [];
    return [{
      name,
      description: str(tool.description ?? tool.desc),
      params: paramsOf(tool.params ?? tool.parameters ?? tool.input_schema ?? tool.schema),
    }];
  });
}

/** 文件清单：`files[]` 或 `manifest.files[]`；一条都没有 ⇒ `[]`（UI 整段不出）。 */
function filesOf(row: Record<string, unknown>): MarketFileEntry[] {
  const manifest = asRecord(row.manifest);
  const raw = Array.isArray(row.files)
    ? row.files
    : Array.isArray(manifest?.files) ? (manifest?.files as unknown[]) : [];
  return raw.flatMap((entry): MarketFileEntry[] => {
    if (typeof entry === 'string' && entry !== '') return [{ path: entry, bytes: null }];
    const file = asRecord(entry);
    if (file === null) return [];
    const path = str(file.path);
    if (path === null || path === '') return [];
    return [{ path, bytes: countOrNull(file.bytes ?? file.size) }];
  });
}

/** 扫描提示：字段缺席 ⇒ `null`（= 不知道），空数组 ⇒ `[]`（= 真干净）。 */
function warningsOrNull(row: Record<string, unknown>): SecurityWarning[] | null {
  const raw = row.security_warnings ?? row.warnings;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((entry): SecurityWarning[] => {
    if (typeof entry === 'string' && entry !== '') {
      return [{ code: null, path: null, line: null, note: entry }];
    }
    const bag = asRecord(entry);
    if (bag === null) return [];
    return [{
      code: str(bag.code),
      path: str(bag.path),
      line: countOrNull(bag.line),
      note: str(bag.note ?? bag.message ?? bag.detail),
    }];
  });
}

/** 扫描分：`security_score`（§2）与 `score`（§8 的叫法）都收。 */
function scoreOf(row: Record<string, unknown>): number | null {
  return scoreOrNull(row.security_score ?? row.securityScore ?? row.score);
}

// ── MCP（#608）：枚举、组合矩阵、归一化、表单判据 ───────────────────────────────

/** §4.3 的三个暴露档（`hidden` 在 P1 = 装了但不生效，§0-4）。 */
export const MCP_EXPOSURES = ['direct', 'deferred', 'hidden'] as const;
export type McpExposure = (typeof MCP_EXPOSURES)[number];

/** §10-8：`timeout_ms` 的上限是 300 s（超出属干一眼假）。 */
export const MCP_MAX_TIMEOUT_MS = 300_000;

/** §4.4 的四个准入理由（MCP 必填；skill 带了服务端会忽略）。 */
export const MCP_REASONS = [
  'stateful',
  'tool_surface_gt_12',
  'shared_quota',
  'credential_boundary',
] as const;
export type McpReason = (typeof MCP_REASONS)[number];

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** §3 的 `lifecycle`：P1 两档行为相同（§13），字段先留着。 */
export const MCP_LIFECYCLES = ['run', 'run-keep-alive'] as const;

export const MCP_SLOT_KINDS = ['config', 'secret'] as const;
export type McpSlotKind = (typeof MCP_SLOT_KINDS)[number];

/** 一个「什么都没填」的槽行（管理台表单用它做初值与「新增一行」的模板）。 */
export function emptyMcpSlot(): McpSlotDraft {
  return { name: '', kind: 'secret', required: true, description: '' };
}

/**
 * §4.2 的组合矩阵：一个槽在给定 (条目 kind, transport) 下**唯一**合法的 `inject`。
 *
 * 拿它把表单里的 `inject` 锁成只读（而不是让管理员选一个「stdio 却要 header」的组合拖到运行期才炸）。
 * 不认识的 transport ⇒ `null`（前端不赌：不锁也不发，让服务端的 `capability_slot_invalid` 说话）。
 */
export function injectForTransport(kind: string, transport: string): 'context' | 'env' | 'header' | null {
  if (kind !== 'mcp') return 'context'; // §4.2：skill 只允许 context（**唯一**）
  if (transport === 'stdio') return 'env';
  if (transport === 'http') return 'header';
  return null;
}

/** 槽行草稿（表单里的形状；`inject` **不在这里**，它由 `injectForTransport` 现算，见 §4.2）。 */
export interface McpSlotDraft {
  name: string;
  kind: string;
  required: boolean;
  description: string;
}

/** MCP 表单草稿（字段面 §4；数字与数组在界面上是文本输入，发出前由 `buildMcpFields` 转形）。 */
export interface McpFormDraft {
  transport: string;
  command: string;
  /** 一行一个参数（参数里可以带空格，所以不能按空格切）。 */
  args: string;
  url: string;
  exposure: string;
  lifecycle: string;
  timeoutMs: string;
  reason: string;
  slots: McpSlotDraft[];
}

export function emptyMcpForm(): McpFormDraft {
  return {
    transport: 'stdio', command: '', args: '', url: '',
    exposure: 'deferred', lifecycle: 'run', timeoutMs: '', reason: '',
    slots: [],
  };
}

/** 一行一个参数 ⇒ 数组（丢空行；保留行内空格，那可以是合法参数）。 */
export function splitArgs(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * 表单草稿 → `manifest` 字段（§3 的形状）。
 *
 * 只发**适用的**那些键：stdio 带 `command`/`args`，http 带 `url`（互不串门，免得前端自己造出
 * 「stdio + url」这种不在矩阵里的形状）；`timeout_ms` 只在能收成合法整数时才发（否则发个 `null`
 * 会被服务端读成「清掉默认值」）。`resident` 恒 `false`（§3：P1 只形态①）。
 */
export function buildMcpFields(draft: McpFormDraft): Record<string, unknown> {
  const transport = draft.transport;
  const out: Record<string, unknown> = {
    transport,
    exposure: draft.exposure,
    lifecycle: draft.lifecycle,
    resident: false,
    reason: draft.reason,
    slots: draft.slots.map((slot) => ({
      name: slot.name.trim(),
      kind: slot.kind,
      inject: injectForTransport('mcp', transport) ?? '',
      required: slot.required === true,
      description: slot.description,
    })),
  };
  if (transport === 'http') {
    out.url = draft.url.trim();
  } else {
    out.command = draft.command.trim();
    out.args = splitArgs(draft.args);
  }
  const timeout = Number(draft.timeoutMs.trim());
  if (draft.timeoutMs.trim() !== '' && Number.isSafeInteger(timeout) && timeout > 0) {
    out.timeout_ms = timeout;
  }
  return out;
}

/** MCP 表单的「一眼假」拦项（同 bundle 的口径：只挡必然 400 的体，其余留给服务端）。 */
export type McpFormIssueCode =
  | 'reasonMissing'
  | 'commandMissing'
  | 'urlMissing'
  | 'timeoutInvalid'
  | 'slotNameMissing'
  | 'slotNameDuplicate';

export interface McpFormIssue {
  code: McpFormIssueCode;
  /** 可选的补充信息（如重复的槽名、哪一行）。 */
  detail?: string;
}

/**
 * MCP 表单的本地拦项清单（空数组 = 可以发请求）。只包含四件事：
 *   * `reason` 没选（§4.4 必填 ⇒ 不发一个必然 `capability_reason_required` 的体）；
 *   * stdio 没 `command` / http 没 `url`（§4.1）；
 *   * `timeout_ms` 填了但不是正整数或不超 300 s（§10-8）；
 *   * 槽名为空 / item 内重名（§4.1「item 内唯一」，主键就是 `(item_id,name)`）。
 * 名字正则、保留名、url 协议、command 含空格……全部留给服务端（前端不赌 §4.1 的全表）。
 */
export function checkMcpForm(draft: McpFormDraft): McpFormIssue[] {
  const issues: McpFormIssue[] = [];
  if (draft.reason === '') issues.push({ code: 'reasonMissing' });
  if (draft.transport === 'http') {
    if (draft.url.trim() === '') issues.push({ code: 'urlMissing' });
  } else if (draft.command.trim() === '') {
    issues.push({ code: 'commandMissing' });
  }
  const raw = draft.timeoutMs.trim();
  if (raw !== '') {
    const timeout = Number(raw);
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MCP_MAX_TIMEOUT_MS) {
      issues.push({ code: 'timeoutInvalid', detail: raw });
    }
  }
  const seen = new Set<string>();
  for (const slot of draft.slots) {
    const name = slot.name.trim();
    if (name === '') {
      issues.push({ code: 'slotNameMissing' });
    } else if (seen.has(name)) {
      issues.push({ code: 'slotNameDuplicate', detail: name });
    } else {
      seen.add(name);
    }
  }
  return issues;
}

/** 归一化的一条槽声明（只收认识的键；形状完全不认识 ⇒ `null`，整行丢弃）。 */
function slotSpecOf(value: unknown): McpSlotSpec | null {
  const row = asRecord(value);
  if (row === null) return null;
  const name = str(row.name);
  if (name === null || name === '') return null;
  return {
    name,
    kind: str(row.kind) ?? 'secret',
    inject: str(row.inject) ?? '',
    required: row.required !== false,
    description: strOrEmpty(row.description),
  };
}

/** 槽声明清单：`slots[]` / `manifest.slots[]` / `params[]`（表名是 `capability_params`）都收。 */
function slotsOf(row: Record<string, unknown>): McpSlotSpec[] {
  const manifest = asRecord(row.manifest);
  const raw = Array.isArray(row.slots)
    ? row.slots
    : Array.isArray(manifest?.slots)
      ? (manifest?.slots as unknown[])
      : Array.isArray(row.params)
        ? (row.params as unknown[])
        : [];
  return raw.flatMap((entry): McpSlotSpec[] => {
    const slot = slotSpecOf(entry);
    return slot === null ? [] : [slot];
  });
}

/**
 * MCP 配置段（§3 的 manifest 形状）。永不抛；skill 条目拿到的是全空形状（不会把 `''` 当「stdio」）。
 *
 * ⚠ 读值的键一个都不读：这里只收声明（transport/command/args/url/exposure/lifecycle/reason/
 * timeout_ms/slots/tools_cache_at）。
 */
function mcpOf(row: Record<string, unknown>): McpConfig {
  const manifest = asRecord(row.manifest) ?? {};
  const pick = (key: string): unknown => row[key] ?? manifest[key];
  const argsRaw = pick('args');
  return {
    transport: strOrEmpty(pick('transport')),
    command: strOrEmpty(pick('command')),
    args: Array.isArray(argsRaw)
      ? (argsRaw as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    url: strOrEmpty(pick('url')),
    exposure: strOrEmpty(pick('exposure')),
    lifecycle: strOrEmpty(pick('lifecycle')),
    reason: str(pick('reason')),
    timeoutMs: countOrNull(pick('timeout_ms') ?? pick('timeoutMs')),
    slots: slotsOf(row),
    toolsCacheAt: str(pick('tools_cache_at') ?? pick('toolsCacheAt')),
  };
}

/**
 * GET `/api/admin/market/items/:id/secrets` → 凭据行（§7.2）。
 *
 * 只从白名单键里读（`name / kind / inject / required / has_value / updated_at / updated_by`）——
 * **值不在其中**：即使服务端多发了一个 `value`（不应发生）也不会被收进来，这是
 * 「凭据区没有任何读值入口」的结构性保证（单测有源码级 + 数据级两道断言）。
 * 信封 `{item:{slots}}` / `{slots}` / 裸数组三种都收；不认识 ⇒ 空清单。
 */
export function normalizeMcpSecrets(raw: unknown): McpSecretSlot[] {
  const bag = asRecord(raw);
  const inner = asRecord(bag?.item) ?? bag;
  const rawSlots = Array.isArray(inner?.slots)
    ? (inner?.slots as unknown[])
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];
  return rawSlots.flatMap((entry): McpSecretSlot[] => {
    const row = asRecord(entry);
    const name = row === null ? null : str(row.name);
    if (row === null || name === null || name === '') return [];
    return [{
      name,
      kind: str(row.kind) ?? 'secret',
      inject: str(row.inject) ?? '',
      required: row.required !== false,
      hasValue: row.has_value === true,
      updatedAt: str(row.updated_at ?? row.updatedAt),
      updatedBy: str(row.updated_by ?? row.updatedBy),
    }];
  });
}

/**
 * PUT secrets 的请求体（§7.2）：`{scope, fde_id?, values:{NAME: 值 | null}}`。
 * `null` = 删除该值（所以「清空一个槽」不是发空串，而是发 `null`）。
 */
export function buildSecretPayload(
  values: Record<string, string | null>,
  scope: 'global' | 'fde' = 'global',
  fdeId?: string,
): string {
  const body: Record<string, unknown> = { scope, values };
  if (scope === 'fde' && fdeId !== undefined && fdeId !== '') body.fde_id = fdeId;
  return JSON.stringify(body);
}

/**
 * `SKILL.md` 正文（§7-2 只说「详情含 `SKILL.md` 正文」，**没给字段起名**）。
 * 按「最像正文」的键依次找；`files[]` 里若真带了 `SKILL.md` 的 content 也算。
 * 全都没有 ⇒ `null`，UI 明说「没拿到正文」，**不拿 `description_md` 冒充** `SKILL.md`
 * （那是两格东西：前者是详情页正文，后者是包里的文件）。
 */
function readmeOf(row: Record<string, unknown>): string | null {
  for (const key of ['readme_md', 'readmeMd', 'skill_md', 'skillMd', 'readme']) {
    const value = str(row[key]);
    if (value !== null && value !== '') return value;
  }
  const files = Array.isArray(row.files) ? row.files : [];
  for (const entry of files) {
    const file = asRecord(entry);
    if (file === null || str(file.path) !== 'SKILL.md') continue;
    const content = str(file.content ?? file.content_md ?? file.body);
    if (content !== null && content !== '') return content;
  }
  return null;
}

/** 一份 row → 列表形状（用户面与管理面共用；管理面在外面再叠 state / installs）。 */
function baseItem(row: Record<string, unknown>): MarketListItem {
  const tools = toolsOf(row);
  const warnings = warningsOrNull(row);
  const mcp = mcpOf(row);
  return {
    slug: strOrEmpty(row.slug),
    kind: str(row.kind) ?? 'skill',
    // reason / exposure 在列表里可能在顶层，也可能只在其 manifest 里（§7.2 只钉了「每条带」）。
    reason: str(row.reason) ?? mcp.reason,
    exposure: str(row.exposure) ?? (mcp.exposure === '' ? null : mcp.exposure),
    // 三档：显式 true / 显式 false / 根本没这个键（`null`）。「没说」不拦住按钮。
    secretsReady: typeof row.secrets_ready === 'boolean'
      ? row.secrets_ready
      : typeof row.secretsReady === 'boolean' ? row.secretsReady : null,
    name: strOrEmpty(row.name),
    summary: strOrEmpty(row.summary),
    version: strOrEmpty(row.version),
    tags: stringList(row.tags),
    // 工具数三档：显式计数 → 清单长度 → null（都没有就是不知道，不写 0）。
    toolCount: countOrNull(row.tool_count ?? row.toolCount) ?? (tools.length > 0 ? tools.length : null),
    securityScore: scoreOf(row),
    warningCount: warnings === null ? null : warnings.length,
    installed: row.installed === true,
    // `=== true`：缺键与 false 都落在「没启用」那一侧（未安装的东西谈不上启用）。
    enabled: row.enabled === true,
    installedVersion: str(row.installed_version ?? row.installedVersion),
  };
}

function adminExtras(row: Record<string, unknown>): Pick<AdminMarketItem, 'id' | 'state' | 'installs'> {
  return {
    id: strOrEmpty(row.id),
    state: strOrEmpty(row.state),
    installs: countOrNull(row.installs ?? row.install_count ?? row.installsCount),
  };
}

/** 用户面列表（§7-1）。永不抛。 */
export function normalizeMarketItems(raw: unknown): MarketListItem[] {
  return itemsOf(raw).flatMap((entry): MarketListItem[] => {
    const row = asRecord(entry);
    return row === null ? [] : [baseItem(row)];
  });
}

/** 用户面详情（§7-2）。永不抛；形状完全不认识 ⇒ `null`。 */
export function normalizeMarketDetail(raw: unknown): MarketDetail | null {
  const row = detailOf(raw);
  if (row === null) return null;
  const warnings = warningsOrNull(row);
  return {
    ...baseItem(row),
    whenToUse: strOrEmpty(row.when_to_use ?? row.whenToUse),
    descriptionMd: strOrEmpty(row.description_md ?? row.descriptionMd),
    readme: readmeOf(row),
    author: str(row.author),
    license: str(row.license),
    tools: toolsOf(row),
    files: filesOf(row),
    warnings: warnings ?? [],
    mcp: mcpOf(row),
  };
}

/** 管理面列表（§7-3）。永不抛。 */
export function normalizeAdminItems(raw: unknown): AdminMarketItem[] {
  return itemsOf(raw).flatMap((entry): AdminMarketItem[] => {
    const row = asRecord(entry);
    return row === null ? [] : [{ ...baseItem(row), ...adminExtras(row) }];
  });
}

/** 管理面详情（§7-7）。永不抛；不认识 ⇒ `null`。 */
export function normalizeAdminDetail(raw: unknown): AdminMarketDetail | null {
  const row = detailOf(raw);
  if (row === null) return null;
  const warnings = warningsOrNull(row);
  return {
    ...baseItem(row),
    ...adminExtras(row),
    whenToUse: strOrEmpty(row.when_to_use ?? row.whenToUse),
    descriptionMd: strOrEmpty(row.description_md ?? row.descriptionMd),
    author: str(row.author),
    license: str(row.license),
    tools: toolsOf(row),
    files: filesOf(row),
    warnings: warnings ?? [],
    mcp: mcpOf(row),
  };
}

// ── 状态与展示（§8：红黄绿不引入，文字承重）──────────────────────────────────

/** §2 的 `state` 枚举（管理台的 state 过滤器只有这三档 + 「全部」）。 */
export const CAPABILITY_STATES = ['draft', 'published', 'retired'] as const;
export type CapabilityState = (typeof CAPABILITY_STATES)[number];

const STATE_KEY: Record<string, CapabilityState> = {
  draft: 'draft',
  published: 'published',
  retired: 'retired',
};

export type MarketStateKey =
  | 'market.state.draft'
  | 'market.state.published'
  | 'market.state.retired'
  | 'market.state.unknown';

/** state → i18n 键；未知 state 退回 `market.state.unknown`（不裸露枚举字面量）。 */
export function stateMessageKey(state: string | null | undefined): MarketStateKey {
  const suffix = typeof state === 'string' ? STATE_KEY[state] : undefined;
  return suffix === undefined ? 'market.state.unknown' : `market.state.${suffix}`;
}

// ── kind / reason / exposure 的文案键（§8.2：不显示英文枚举）─────────────────

const KIND_KEY: Record<string, 'skill' | 'mcp'> = { skill: 'skill', mcp: 'mcp' };

export type MarketKindKey = 'market.kind.skill' | 'market.kind.mcp' | 'market.kind.unknown';

/** kind → i18n 键；不认识的种类退到 `unknown`（不把 `quartz` 这种英文枚举直接上屏）。 */
export function kindMessageKey(kind: string | null | undefined): MarketKindKey {
  const suffix = typeof kind === 'string' ? KIND_KEY[kind] : undefined;
  return suffix === undefined ? 'market.kind.unknown' : `market.kind.${suffix}`;
}

const REASON_KEY: Record<string, McpReason> = Object.fromEntries(
  MCP_REASONS.map((reason) => [reason, reason]),
) as Record<string, McpReason>;

export type MarketReasonKey =
  | `market.reason.${McpReason}`
  | 'market.reason.unknown';

/**
 * 准入理由 → i18n 键（§8.2：卡片上的是中文/英文句子，不是 `tool_surface_gt_12` 这种枚举）。
 * 认不出 ⇒ `market.reason.unknown`（不裸露枚举）。调用方自己处理「服务端没说 ⇒ 整段不出」（`null`）。
 */
export function reasonMessageKey(reason: string | null | undefined): MarketReasonKey {
  const suffix = typeof reason === 'string' ? REASON_KEY[reason] : undefined;
  return suffix === undefined ? 'market.reason.unknown' : `market.reason.${suffix}`;
}

const EXPOSURE_KEY: Record<string, McpExposure> = Object.fromEntries(
  MCP_EXPOSURES.map((exposure) => [exposure, exposure]),
) as Record<string, McpExposure>;

export type MarketExposureKey =
  | `market.mcp.exposure.${McpExposure}`
  | 'market.mcp.exposure.unknown';

/** 暴露档 → i18n 键（§8.3：`market.mcp.exposure.{direct,deferred,hidden}`）；认不出 ⇒ `unknown`。 */
export function exposureMessageKey(exposure: string | null | undefined): MarketExposureKey {
  const suffix = typeof exposure === 'string' ? EXPOSURE_KEY[exposure] : undefined;
  return suffix === undefined ? 'market.mcp.exposure.unknown' : `market.mcp.exposure.${suffix}`;
}

/**
 * 「已装 / 已装未启用 / 已装已启用」三态（§8：已装未启用用**中性灰字**，不用告警色）。
 * 分类在这里，颜色在渲染层——判据可单测，不靠 DOM 猜。
 */
export type InstallState = 'notInstalled' | 'installedDisabled' | 'installedEnabled';

export function installStateOf(
  item: Pick<MarketListItem, 'installed' | 'enabled'>,
): InstallState {
  if (!item.installed) return 'notInstalled';
  return item.enabled ? 'installedEnabled' : 'installedDisabled';
}

export type InstallStateKey =
  | 'market.installed.notInstalled'
  | 'market.installed.installedDisabled'
  | 'market.installed.installedEnabled';

export function installStateMessageKey(state: InstallState): InstallStateKey {
  return `market.installed.${state}`;
}

/**
 * 计数缺失的显示：`—` 而不是 `0`。
 * 拿 0 冒充「没人装」会让管理员敢下线还有人在用的包（§8 的文字承重口径）。
 */
export function countText(value: number | null): string {
  return value === null ? '—' : String(value);
}

/** 文件字节显示（复用 `lib/uploadSettings` 的换算；脏值 ⇒ `—`）。 */
export function bytesText(bytes: number | null): string {
  return formatBytes(bytes) ?? '—';
}

// ── bundle 打包（§1 硬约束 2 + §7 的 `{files:[{path, content_base64}]}`）───────

export interface BundleFilePayload {
  path: string;
  content_base64: string;
}

export interface BundlePayload {
  files: BundleFilePayload[];
}

/**
 * 一条 path 的「一眼假」理由（§3 的前端子集：四条 + 空串）。
 * 文件数 / 总字节 / 单文件字节 / slug 正则 / `skill.mjs` 是否存在，**全部留给服务端**。
 */
export type BundlePathIssueCode = 'empty' | 'absolute' | 'separator' | 'parentRef' | 'tooLong';

export interface BundlePathIssue {
  path: string;
  code: BundlePathIssueCode;
}

/** 选择结果 → bundle 里的 path（目录选择才有相对路径，单文件选择只有名字）。 */
export function bundlePathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  const text = typeof relative === 'string' && relative.trim() !== '' ? relative : file.name;
  return text.trim();
}

/** 一眼假的 path ⇒ 问题清单（顺序与入参一致；空数组 ⇒ 可以发请求）。 */
export function checkBundlePaths(paths: readonly string[]): BundlePathIssue[] {
  const issues: BundlePathIssue[] = [];
  for (const path of paths) {
    if (path === '') issues.push({ path, code: 'empty' });
    else if (path.startsWith('/')) issues.push({ path, code: 'absolute' });
    else if (path.includes('\\')) issues.push({ path, code: 'separator' });
    else if (path.split('/').includes('..')) issues.push({ path, code: 'parentRef' });
    else if (new TextEncoder().encode(path).length > MAX_BUNDLE_PATH_BYTES) {
      issues.push({ path, code: 'tooLong' });
    }
  }
  return issues;
}

/**
 * 字节 → base64（**不引依赖**：§1 硬约束 2 说 P0 不打包库，base64 用浏览器自带的 `btoa`）。
 * 分块 `String.fromCharCode`：一次性展开 `...bytes` 在几十 KB 上会爆调用栈。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** `File` → base64（`File.arrayBuffer()`，不引第三方库、不用 `FileReader`）。 */
export async function fileToBase64(file: File): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.arrayBuffer()));
}

/** 选中的文件 → bundle。调用方**必须**先过 `checkBundlePaths`（这里不重复判）。 */
export async function buildBundle(files: readonly File[]): Promise<BundlePayload> {
  const out: BundleFilePayload[] = [];
  for (const file of files) {
    out.push({ path: bundlePathOf(file), content_base64: await fileToBase64(file) });
  }
  return { files: out };
}

// ── 错误码 → 人话（§7 的六个码，一个不落）─────────────────────────────────────

export type MarketErrorKey =
  | 'market.errors.validationFailed'
  | 'market.errors.validationGeneric'
  | 'market.errors.notFound'
  | 'market.errors.notPublished'
  | 'market.errors.budgetExceeded'
  | 'market.errors.kindUnsupported'
  | 'market.errors.installFailed'
  | 'market.errors.reasonRequired'
  | 'market.errors.slotInvalid'
  | 'market.errors.secretMissing'
  | 'market.errors.secretKeyMissing'
  | 'market.errors.packageShape'
  | 'market.errors.generic';

/** §7 的六个码 + #608 §7.3 的五个新码 → i18n 键（`validation_failed` 走两条分支，见 `marketErrorText`）。 */
const ERROR_KEY_BY_CODE: Record<string, MarketErrorKey> = {
  validation_failed: 'market.errors.validationGeneric',
  capability_not_found: 'market.errors.notFound',
  capability_not_published: 'market.errors.notPublished',
  capability_budget_exceeded: 'market.errors.budgetExceeded',
  capability_kind_unsupported: 'market.errors.kindUnsupported',
  capability_install_failed: 'market.errors.installFailed',
  capability_reason_required: 'market.errors.reasonRequired',
  capability_slot_invalid: 'market.errors.slotInvalid',
  capability_secret_missing: 'market.errors.secretMissing',
  capability_package_shape: 'market.errors.packageShape',
  secret_key_missing: 'market.errors.secretKeyMissing',
};

/** 管理台表单认识的字段名（§3 的静态校验项 + #608 §4 的 MCP 字段；认不出就不标红，不猜）。 */
export type AdminFieldKey =
  | 'slug' | 'name' | 'summary' | 'when_to_use' | 'version'
  | 'author' | 'tags' | 'license' | 'description_md' | 'bundle'
  | 'transport' | 'command' | 'args' | 'url' | 'exposure' | 'lifecycle'
  | 'timeout_ms' | 'reason' | 'slots';

const FORM_FIELD_KEYS: AdminFieldKey[] = [
  'slug', 'name', 'summary', 'when_to_use', 'version',
  'author', 'tags', 'license', 'description_md', 'bundle',
  'transport', 'command', 'args', 'url', 'exposure', 'lifecycle',
  'timeout_ms', 'reason', 'slots',
];

/** `400 validation_failed` 的 `details.field` → 表单字段；认不出 ⇒ `null`（整表一条错误）。 */
export function validationFieldOf(error: unknown): AdminFieldKey | null {
  const { status, details } = (error ?? {}) as Partial<ApiError> & { details?: Record<string, unknown> };
  if (status !== 400) return null;
  const field = str(details?.field);
  if (field === null) return null;
  // `bundle.files[3].path` 这类带下标的写法：剥掉下标再比（服务端只点名到「哪一格」）。
  const head = field.replace(/\[[\d*]*\].*$/, '').replace(/^files\./, '');
  return FORM_FIELD_KEYS.includes(head as AdminFieldKey) ? (head as AdminFieldKey) : null;
}

/** 预算超额那句话里的数字：服务端 `details` 带了就用它，否则用 §4 的常量。 */
export function budgetLimitOf(error: unknown): number {
  const details = (error as Partial<ApiError> | undefined)?.details as
    | Record<string, unknown>
    | undefined;
  return countOrNull(details?.max ?? details?.max_enabled ?? details?.maxEnabled) ?? MAX_ENABLED_SKILLS;
}

/** §11：启用缺必填槽的 409 里 `details.missing` 可能是数组、逗号串或没给。 */
function missingSlotsOf(error: unknown): string {
  const details = (error as Partial<ApiError> | undefined)?.details as
    | Record<string, unknown>
    | undefined;
  const raw = details?.missing ?? details?.missing_slots;
  if (Array.isArray(raw)) {
    return raw.filter((x): x is string => typeof x === 'string' && x !== '').join(', ');
  }
  if (typeof raw === 'string') return raw;
  return '';
}

/**
 * 市场请求的错误 → 界面文案（用户面与管理面共用；`admin.errorPrefix` 那类前缀由调用方加）。
 *
 * 六个契约码各有专属文案；`validation_failed` 额外把 `details.field` 点名进去（§3 的静态校验
 * 项有十几条，只说「参数不合法」等于没说）。未知码 ⇒ 兜底文案 + 带上服务端原文（原文不译）。
 */
export function marketErrorText(error: unknown): string {
  const err = error as Partial<ApiError> | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  const serverMessage = toDisplayText(err?.message);
  if (code === 'validation_failed') {
    const field = validationFieldOf(error);
    return field === null
      ? t('market.errors.validationGeneric')
      : t('market.errors.validationFailed', { field });
  }
  const key: MarketErrorKey | undefined = ERROR_KEY_BY_CODE[code];
  switch (key) {
    case 'market.errors.notFound':
      return t('market.errors.notFound');
    case 'market.errors.notPublished':
      return t('market.errors.notPublished');
    case 'market.errors.budgetExceeded':
      return t('market.errors.budgetExceeded', { max: budgetLimitOf(error) });
    case 'market.errors.kindUnsupported':
      return t('market.errors.kindUnsupported');
    case 'market.errors.installFailed': {
      const details = (err?.details ?? {}) as Record<string, unknown>;
      return t('market.errors.installFailed', {
        reason: str(details.reason) ?? (serverMessage || t('market.errors.reasonUnknown')),
      });
    }
    case 'market.errors.slotInvalid': {
      // §4.2：`details` 带 `{transport, inject}`——组合矩阵被拒时点名是哪一对对不上。
      const details = (err?.details ?? {}) as Record<string, unknown>;
      const combo = str(details.combo)
        ?? [str(details.transport), str(details.inject)].filter((x): x is string => x !== null).join(' + ');
      return t('market.errors.slotInvalid', { combo: combo === '' ? '—' : combo });
    }
    case 'market.errors.secretMissing': {
      const missing = missingSlotsOf(error);
      return t('market.errors.secretMissing', { slots: missing === '' ? '—' : missing });
    }
    case 'market.errors.packageShape': {
      // §4.5：红色形状的命中项在 `details.pattern` 里（服务端原文不译，但只在有值时拼进去）。
      const details = (err?.details ?? {}) as Record<string, unknown>;
      const shape = str(details.pattern) ?? str(details.shape) ?? serverMessage;
      return t('market.errors.packageShape', { shape: shape === null || shape === '' ? '—' : shape });
    }
    case 'market.errors.secretKeyMissing':
      return t('market.errors.secretKeyMissing');
    case 'market.errors.reasonRequired':
      return t('market.errors.reasonRequired');
    default:
      return t('market.errors.generic', {
        status: typeof err?.status === 'number' ? err.status : 0,
        message: serverMessage || t('market.errors.reasonUnknown'),
      });
  }
}
