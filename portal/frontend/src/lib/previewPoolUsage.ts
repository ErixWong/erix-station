// 号池**占用总览**（issue #350）的纯逻辑：端点响应 → 页面要的三块（pool / occupied / free）+ 不猜数归一化。
// 契约唯一来源：`docs/api/portal.md` §4.7a（`GET /api/admin/preview-ports/usage`，由 #256 交付① 上线）。
//
// 硬口径（工单判据②）：**池边界 / 块大小 / 总段数全部从响应里的 `pool` 推导**。
// 本文件与 `views/PreviewPoolUsageView.vue` 里**零端口/号池字面量**（唯一真相在 `portal/src/previewpool.js`，
// 前端抄一份就会漂）。这条由 `views/PreviewPoolUsageView.spec.ts` 里的源码级断言按**数值**钉住
// （它读 `?raw` 源码文本，不用 `node:fs`——前端 spec 跑在 jsdom，见 #349 的坑）。
//
// 为什么不复用 `lib/previewPorts.ts` 的 `PREVIEW_PORT_POOL_START/END`：那是 #246 改块输入框的
// min/max 提示（当时只能抄一份常量做输入提示）。占用总览**有服务端给的 `pool`**，再引一份镜像常量
// 就等于让页面有两个真相源——服务端换号池时页面会自相矛盾。
import type { ApiError } from '../api';

/** 端点路径（唯一拼法；`?limit=` 只在调用方显式要时才拼）。 */
export const PREVIEW_USAGE_PATH = '/api/admin/preview-ports/usage';

/**
 * 端点 URL。`limit` = `free_blocks.items` 的条数上限（服务端缺省自有一份默认值，
 * 这里**不复制**那个默认值——缺省就是不带参数，让服务端说了算）。
 * 非正整数一律按「不指定」处理（脏值不拼进 URL，也不本地拦成 400——判据在服务端）。
 */
export function previewUsagePath(limit?: number | null): string {
  if (typeof limit === 'number' && Number.isInteger(limit) && limit > 0) {
    return `${PREVIEW_USAGE_PATH}?limit=${limit}`;
  }
  return PREVIEW_USAGE_PATH;
}

/** `pool` 段（全部从响应读，页面不写死）。 */
export interface PreviewPoolBounds {
  start: number;
  end: number;
  blockSize: number;
  totalBlocks: number;
}

/** `occupied_blocks` 的一项（§4.7a：`{start, end, occupied_count, fde_names}`）。 */
export interface PreviewOccupiedBlock {
  start: number;
  end: number | null;
  occupiedCount: number | null;
  fdeNames: string[];
}

/** `free_blocks` 段。`hasMore`/`limit` 缺失或脏值 ⇒ `null`（页面说「不知道」，不说「没有更多」）。 */
export interface PreviewFreeBlocks {
  items: number[];
  limit: number | null;
  hasMore: boolean | null;
}

/** `summary` 段。**每个数都可能是 `null`**（缺失/脏值 ⇒ 页面显示「—」，绝不渲染成 0）。 */
export interface PreviewUsageSummary {
  totalBlocks: number | null;
  free: number | null;
  partial: number | null;
  occupied: number | null;
}

/**
 * 归一化后的响应。`occupiedBlocks` / `freeBlocks.items` 用**空数组 + `*Present` 旗标**区分
 * 「服务端明确说这里没有」与「字段缺失」（判据③：不许把「没请求 / 没给」渲染成「0 段」）。
 */
export interface PreviewPoolUsage {
  pool: PreviewPoolBounds | null;
  summary: PreviewUsageSummary;
  occupiedBlocks: PreviewOccupiedBlock[];
  freeBlocks: PreviewFreeBlocks;
  /** 响应里真的有 `occupied_blocks` 数组（false ⇒ 页面说「服务端没给这一段」）。 */
  occupiedPresent: boolean;
  /** 响应里真的有 `free_blocks` 对象（false ⇒ 同上，**不是**「零个空闲段」）。 */
  freePresent: boolean;
}

/** 只认有限 number：字符串 `'800'`、`NaN`、`null`、对象一律 `null`（不猜、不 Number() 硬转）。 */
function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 块起点 → 块末端：块大小**只能来自响应**（`pool.block_size`），缺失就返回 `null`（不写死 +9）。 */
export function blockEnd(start: number, blockSize: number | null): number | null {
  if (typeof blockSize !== 'number' || !Number.isFinite(blockSize) || blockSize < 1) return null;
  return start + blockSize - 1;
}

/**
 * `{start}–{end}` 形态的段标签（与 #246 改块文案同一形态：全角/半角一致的 en dash）。
 * 末端未知（响应没给 `block_size` 且该项也没给 `end`）⇒ 只给起点，**不编造末端**。
 */
export function formatBlockLabel(start: number, end: number | null): string {
  return end === null ? String(start) : `${start}–${end}`;
}

/**
 * 端点响应 → 归一化结构。入参是 `unknown`：服务端换形、桩给半截、字段脏掉都不许炸，
 * 更不许把缺失当成 0（判据③）。
 */
export function normalizeUsage(raw: unknown): PreviewPoolUsage {
  const root = recordOf(raw) ?? {};
  const poolRaw = recordOf(root.pool);
  const start = numOrNull(poolRaw?.start);
  const end = numOrNull(poolRaw?.end);
  const blockSize = numOrNull(poolRaw?.block_size);
  const totalBlocks = numOrNull(poolRaw?.total_blocks);
  const pool: PreviewPoolBounds | null = start !== null && end !== null && blockSize !== null && totalBlocks !== null
    ? { start, end, blockSize, totalBlocks }
    : null;

  const summaryRaw = recordOf(root.summary);
  const summary: PreviewUsageSummary = {
    totalBlocks: numOrNull(summaryRaw?.total_blocks),
    free: numOrNull(summaryRaw?.free),
    partial: numOrNull(summaryRaw?.partial),
    occupied: numOrNull(summaryRaw?.occupied),
  };

  const occupiedRaw = root.occupied_blocks;
  const occupiedPresent = Array.isArray(occupiedRaw);
  const occupiedBlocks: PreviewOccupiedBlock[] = (occupiedPresent ? (occupiedRaw as unknown[]) : [])
    .map((item) => recordOf(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const namesRaw = item.fde_names;
      const fdeNames = Array.isArray(namesRaw)
        ? namesRaw.filter((name): name is string => typeof name === 'string' && name !== '')
        : [];
      const itemStart = numOrNull(item.start);
      return itemStart === null
        ? null
        // 起点都没有的项直接丢掉（没法定位到段，显示出来只会骗人）
        : {
          start: itemStart,
          end: numOrNull(item.end),
          occupiedCount: numOrNull(item.occupied_count),
          fdeNames,
        };
    })
    .filter((item): item is PreviewOccupiedBlock => item !== null)
    .sort((a, b) => a.start - b.start);

  const freeRaw = recordOf(root.free_blocks);
  const freePresent = freeRaw !== null;
  const freeItemsRaw = freeRaw?.items;
  const items = Array.isArray(freeItemsRaw)
    ? freeItemsRaw
      .map((item) => numOrNull(item))
      .filter((item): item is number => item !== null)
    : [];
  const hasMoreRaw = freeRaw?.has_more;
  const freeBlocks: PreviewFreeBlocks = {
    items,
    limit: numOrNull(freeRaw?.limit),
    hasMore: typeof hasMoreRaw === 'boolean' ? hasMoreRaw : null,
  };

  return { pool, summary, occupiedBlocks, freeBlocks, occupiedPresent, freePresent };
}

/** 页面读数的三种可能（判据③：「不知道」不许伪装成「空」或「0」）。 */
export type BlockOccupancyKind = 'occupied' | 'free' | 'unknown';

export interface BlockOccupancy {
  kind: BlockOccupancyKind;
  /** 只有 `kind==='occupied'` 才有值（谁占着这段；数组来自服务端）。 */
  fdeNames: string[];
  occupiedCount: number | null;
}

/**
 * 某个块起点在**已加载的快照**里是「被占 / 整段空闲 / 不知道」。
 *
 * ⚠ `free_blocks.items` 是**截断**的（服务端默认只列前 N 段）⇒ 不在 `occupied_blocks` 里
 * **不等于**空闲：只有真的出现在 `items` 里才算 `free`，其余一律 `unknown`。
 * 这条是判据③的另一面：给管理员看「这段空着」却其实是「没列出来」，就会把人推去撞 409。
 */
export function classifyBlock(usage: PreviewPoolUsage | null, start: number | null): BlockOccupancy {
  const unknown: BlockOccupancy = { kind: 'unknown', fdeNames: [], occupiedCount: null };
  if (usage === null || start === null || !Number.isFinite(start)) return unknown;
  const hit = usage.occupiedBlocks.find((block) => block.start === start);
  if (hit) return { kind: 'occupied', fdeNames: hit.fdeNames, occupiedCount: hit.occupiedCount };
  if (usage.freeBlocks.items.includes(start)) return { kind: 'free', fdeNames: [], occupiedCount: null };
  return unknown;
}

/** 自洽关系的违例键（§4.7a 的三条；页面显示的数必须能对上，对不上要明说而不是照画）。 */
export type UsageIssueKey = 'total' | 'occupiedList' | 'freeList' | 'hasMore';

/**
 * 自洽关系（只对**已知**的数判，`null` 一律跳过——不知道不是违例）：
 *   ① `total = free + partial + occupied`（§4.7a 原句）；
 *   ② `len(occupied_blocks) = partial + occupied`（`occupied_blocks` 列的是**全部**被占段，
 *      含部分占用的段 ⇒ 它 **不小于** `occupied`，`partial > 0` 时必大于）；
 *   ③ `len(free_blocks.items) ≤ free`，且 `has_more=true` ⇒ 确实还有（`free > items.length`）。
 *
 * ⚠ 工单 #350 把②写成 `len(occupied_blocks) ≤ occupied`，**那是错的**：§4.7a 自己的示例是
 * `len=3`、`occupied=1`（`partial=2`），按工单那条就要报「自相矛盾」。口径以文档 + 实现为准
 * （`portal/src/portalloc.js` 的 `previewPortPoolUsage`：`occupied` 只数「占满整块」的段）。
 */
export function usageConsistencyIssues(usage: PreviewPoolUsage): UsageIssueKey[] {
  const issues: UsageIssueKey[] = [];
  const { totalBlocks, free, partial, occupied } = usage.summary;
  if (totalBlocks !== null && free !== null && partial !== null && occupied !== null) {
    if (free + partial + occupied !== totalBlocks) issues.push('total');
  }
  if (partial !== null && occupied !== null
    && usage.occupiedBlocks.length !== partial + occupied) {
    issues.push('occupiedList');
  }
  if (free !== null && usage.freeBlocks.items.length > free) issues.push('freeList');
  if (usage.freeBlocks.hasMore === true && free !== null && free <= usage.freeBlocks.items.length) {
    issues.push('hasMore');
  }
  return issues;
}

/**
 * `ApiError` → 页面错误行要的两面（判据⑥）。服务端 `error.message` **不翻译**（`stores/admin.ts`
 * 既有口径：只加本地化前缀），`code` 仅用于把「没登录/没权限」与「参数」区分开时的兜底。
 */
export function usageErrorText(err: unknown): { code: string; message: string } {
  const error = err as Partial<ApiError> | null | undefined;
  const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'unknown';
  const message = err instanceof Error && err.message !== '' ? err.message : String(err);
  return { code, message };
}
