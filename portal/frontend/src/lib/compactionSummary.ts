// #451：`compactionStats` 观测面的**前端读侧**——把 `session.compaction`（后端读侧聚合）收成
// 一个可渲染的窄类型 + 一组纯函数。
//
// 为什么单开一个 lib 文件而不是在模板里算：
//   ① 模板里算不了一遍「脏值怎么办」——DTO 来自网络，`unknown` 才是诚实类型；
//   ② 站内既有规矩是「展示层的派生一律走纯函数、配 spec」（`lib/runMomentum.ts` / `lib/toolSummary.ts`
//      同一形状），模板只负责把结果塞进插值；
//   ③ token 走**既有**格式化（`formatTokenCount`：`314.5k` / `1.2M`），不在这里另造一套单位。

import { formatTokenCount } from './runMomentum';

/** 单层统计（引擎 `layers[id]` 的原形状：`triggered` 次数 + `tokensSaved` 省下的 token）。 */
export interface CompactionLayerStat {
  triggered: number;
  tokensSaved: number;
}

/**
 * `session.compaction` 的窄类型（后端 #451 的 DTO）。
 *
 * ⚠ **键缺席语义**：整个 `compaction` 键缺席 = 本会话一次折叠都没有（不是 0 次），
 * 所以它在 store 里是 `SessionCompaction | null`，渲染侧 `null` ⇒ 一个字节都不出。
 * `layers` 同理只含 `triggered > 0` 的层（全零层后端就不列）。
 */
export interface SessionCompaction {
  rounds: number;
  layers: Record<string, CompactionLayerStat>;
  tokensSaved: number;
  lastRound?: number | null;
}

/**
 * 层的**规范顺序**（与引擎 `COMPACTION_PIPELINE` 一致，见后端 `session-view.js#COMPACTION_LAYER_IDS`）。
 * 后端已经按这个顺序给键了，这里再排一遍是因为「对象键序」在 JSON 往返后**不是**契约面
 * （旧后端/代理重排都能打乱），而展示顺序必须是稳定的。
 */
export const COMPACTION_LAYER_ORDER = [
  'ttl', 'slidingWindow', 'foldStatistical', 'foldLlm', 'anchors', 'enforceSize',
] as const;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * DTO → 窄类型（**脏值一律当「没有」，绝不补 0**）。
 *
 * 后端已经做过一轮脏数据过滤（#451 判据 4），这里是**第二道**：
 * 旧后端（没有这个字段）、被代理/中间层改写过、或将来形状变了，都不该让界面炸成白屏。
 * 判据：`rounds` / `tokensSaved` 必须是非负有限数，`layers` 必须是对象；
 * 任何一项不成立 ⇒ 整个字段当「没有」（`null` ⇒ 不渲染），而不是渲染一个半截汇总。
 */
export function normalizeSessionCompaction(raw: unknown): SessionCompaction | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const rounds = finiteNonNegative(value.rounds);
  const tokensSaved = finiteNonNegative(value.tokensSaved);
  if (rounds === null || tokensSaved === null) return null;
  if (value.layers === null || typeof value.layers !== 'object' || Array.isArray(value.layers)) return null;
  const rawLayers = value.layers as Record<string, unknown>;
  const layers: Record<string, CompactionLayerStat> = {};
  for (const id of COMPACTION_LAYER_ORDER) {
    const layer = rawLayers[id];
    if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) continue;
    const triggered = finiteNonNegative((layer as Record<string, unknown>).triggered);
    const saved = finiteNonNegative((layer as Record<string, unknown>).tokensSaved);
    // 没触发的层后端就不列；万一列了也在这里丢掉（与后端同一口径：全零层不是信息）。
    if (triggered === null || triggered <= 0) continue;
    layers[id] = { triggered, tokensSaved: saved ?? 0 };
  }
  // 一层都没有 ⇒ 等于「没有折叠」（后端本不该发这个键，发了也不渲染）。
  if (Object.keys(layers).length === 0) return null;
  const lastRound = finiteNonNegative(value.lastRound);
  return {
    rounds,
    layers,
    tokensSaved,
    ...(lastRound === null ? {} : { lastRound }),
  };
}

/** 渲染用的一行分段：`{ id, triggered, saved }`（顺序 = 规范层序，只含触发的层）。 */
export interface CompactionLayerSegment {
  id: string;
  triggered: number;
  saved: number;
}

/** `SessionCompaction.layers` → 有序分段数组（渲染侧不自己遍历对象）。 */
export function compactionLayerSegments(compaction: SessionCompaction | null): CompactionLayerSegment[] {
  if (compaction === null) return [];
  return COMPACTION_LAYER_ORDER
    .filter((id) => compaction.layers[id] !== undefined)
    .map((id) => ({
      id,
      triggered: compaction.layers[id].triggered,
      saved: compaction.layers[id].tokensSaved,
    }));
}

/** 省下的 token 的可读单位（复用站内 `formatTokenCount`：`314.5k` / `1.2M`；0 ⇒ 空串）。 */
export function formatSavedTokens(saved: number | null | undefined): string {
  const value = finiteNonNegative(saved);
  return value === null || value === 0 ? '' : formatTokenCount(value);
}
