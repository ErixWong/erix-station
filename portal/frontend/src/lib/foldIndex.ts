// #816 第③步：`session.folds`（**会话级**折叠索引）的**前端读侧**——把 `GET /api/sessions/:id` 的
// `session.folds[]` 收成一个可渲染的窄类型 + 一组纯函数（形状照同目录 `compactionSummary.ts`：
// 纯函数 + 窄类型 + spec，模板只负责塞插值）。
//
// 为什么单开一个 lib 而不是在模板里算：
//   ① DTO 来自网络，`unknown` 才是诚实类型，「脏值怎么办」模板里算不了一遍；
//   ② 站内既有规矩：展示层的派生一律走纯函数并配 spec（`runMomentum` / `toolSummary` / `compactionSummary`
//      同一形状），模板里只留插值；
//   ③ 竖串定位必须是**纯数学**（见 `foldRailNodes`）——一旦允许在模板里算，下一步就有人会去量 DOM。
//
// 与 `session.compaction` 的**缺席语义不同**（`docs/api/portal.md` §`session.folds[]`）：
// `folds` 是**列表**且后端**恒在**（无折叠 = `[]`，空列表本身就是完整答案），所以这里的空态是 `[]`
// 而不是 `null`；`compaction` 是聚合对象，缺席才表示「一条统计都没有」。**别把两者统一成同一种缺席语义。**

/** 折叠的成因（后端 `foldedFacts.origin` 的白名单值；白名单外一律当「不知道」丢掉）。 */
export type FoldOrigin = 'mechanical' | 'semantic' | 'host';

/** 足迹里的一次工具调用（`toolCalls[]` 逐项清洗后的形状）。 */
export interface FoldToolCall {
  name: string;
  argsSummary?: string;
}

/**
 * `session.folds[]` 的一项（窄类型）。
 *
 * ⚠ **只有 `from`/`to` 是必填**：后端对「两头取不到的项」是**整项剔除**（区间画不出来不给半截），
 * 所以能进数组的项一定有两个头；其余子键**缺席 = 不知道**（不写 `null`/`false`/`0`/空串，
 * 与后端 `foldedFactsFields` 同一把尺），渲染侧自己按缺席退化成范围。
 */
export interface FoldEntry {
  /** 该折叠的**落账轮号**（区别于 `from`/`to`：那是被折走的区间）。 */
  round?: number;
  from: number;
  to: number;
  rounds?: number;
  title?: string;
  origin?: FoldOrigin;
  toolCalls?: FoldToolCall[];
  /** 摘要被夹断（只有后端给 `true` 才写键）。 */
  truncated?: boolean;
}

/** 竖串上的一个节点：折叠本体 + 它在竖串上的纵向位置（百分比，已钳到 0–100、保留 1 位小数）。 */
export interface FoldRailNode {
  fold: FoldEntry;
  topPct: number;
}

const ORIGINS: readonly string[] = ['mechanical', 'semantic', 'host'];

/**
 * `mechanical`（机械折叠）**不显示 title** 的口径：实测它的 title 是把范围又念一遍的模板句
 * （`早期第 1–1 轮（共 1 轮）已折叠。工具足迹：无。需要原文请重读文件…`），信息量 = 范围本身，
 * 摆在常驻条上只是把「第 1 轮」重复第三次 ⇒ 直接返回范围（见 `foldHeadline`）。
 */
const HEADLINE_MIN_CHARS = 6;

/** markdown 标题前缀（`## 阶段` → `阶段`）；与工单口径逐字一致，不额外吞 `*`/`-` 之类。 */
const MD_HEADING_PREFIX = /^#{1,6}\s+/;

/** 足迹一行的分组上限（面板一行放不下清单，超过就省略——见 `foldFootprint`）。 */
const FOOTPRINT_MAX_GROUPS = 3;

function safeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** 文本子键：非字符串 / trim 后为空 ⇒ 不知道（返回 undefined，调用方不写这个键）。 */
function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * `toolCalls[]` 逐项清洗（后端同一口径）：`name` trim 后非空才收，`argsSummary` 空 ⇒ 不带该子键；
 * 脏项（非对象 / name 脏）**丢掉**而不是把整项折叠丢掉；洗完为空 ⇒ 不给 `toolCalls` 键（而不是 `[]`）。
 */
function normalizeToolCalls(raw: unknown): FoldToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: FoldToolCall[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const name = cleanText(value.name);
    if (name === undefined) continue;
    const argsSummary = cleanText(value.argsSummary);
    calls.push(argsSummary === undefined ? { name } : { name, argsSummary });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * DTO → `FoldEntry[]`（**脏值一律丢，绝不补 0/空串**；这是网络侧的第二道闸，后端已筛过一轮）。
 *
 * 丢整项的判据（与后端剔除口径一致）：不是对象 / `from` 或 `to` 不是安全整数 / 区间倒挂（`from > to`）。
 * 其余脏子键（`title` 空、`origin` 白名单外、`toolCalls` 混脏、`truncated` 不是 `true`）只丢**那个键**。
 * **不排序不去重**：`from` 升序与 `(from,to)` 去重是后端契约（`docs/api/portal.md`），前端重排只会
 * 让竖串与面板在旧后端上表现得和后端不一致。
 */
export function normalizeSessionFolds(raw: unknown): FoldEntry[] {
  if (!Array.isArray(raw)) return []; // 旧后端无此键 / 非数组脏值 ⇒ 「没有折叠」，不是崩
  const folds: FoldEntry[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const value = item as Record<string, unknown>;
    const from = safeInt(value.from);
    const to = safeInt(value.to);
    if (from === null || to === null) continue; // 两头缺一 ⇒ 区间画不出来，整项不进（不给半截）
    if (from > to) continue; // 倒挂不是折叠，是脏数据
    const fold: FoldEntry = { from, to };
    const round = safeInt(value.round);
    const rounds = safeInt(value.rounds);
    const title = cleanText(value.title);
    const origin = typeof value.origin === 'string' && ORIGINS.includes(value.origin)
      ? (value.origin as FoldOrigin)
      : undefined;
    const toolCalls = normalizeToolCalls(value.toolCalls);
    if (round !== null) fold.round = round;
    if (rounds !== null && rounds > 0) fold.rounds = rounds; // 0 轮折叠不是信息
    if (title !== undefined) fold.title = title;
    if (origin !== undefined) fold.origin = origin;
    if (toolCalls !== undefined) fold.toolCalls = toolCalls;
    if (value.truncated === true) fold.truncated = true; // 只有真 true 才给键（与后端逐子键口径一致）
    folds.push(fold);
  }
  return folds;
}

/**
 * 折叠范围的**唯一**写法：`第 7–12 轮`；单轮折叠（`from === to`）写 `第 22 轮`（不写 `第 22–22 轮`）；
 * 只有 `to`（手搓的窄对象、或将来后端只给一头）写 `到第 12 轮`；两头都不知道写 `更早的轮次`。
 *
 * ⚠ 这是**数据派生串**、不是界面外壳文案（外壳文案在 i18n `workbench.foldBar.*`）：它是折叠的**身份**，
 * 常驻条 / 面板行 / 竖串卡三处必须是同一个字符串，否则同一折叠在三个位置有三种写法。
 */
export function foldRangeLabel(fold: FoldEntry): string {
  const from = safeInt(fold.from);
  const to = safeInt(fold.to);
  if (from !== null && to !== null) return from === to ? `第 ${to} 轮` : `第 ${from}–${to} 轮`;
  if (to !== null) return `到第 ${to} 轮`;
  return '更早的轮次';
}

/**
 * 一行里「这条折叠讲了什么」的那半句 —— **按 `origin` 分派，不许简化**（工单 #816 的核心口径）：
 *
 * * `mechanical`：**不显示 title**（它的 title 是把范围又念一遍的模板句）⇒ 返回范围；
 * * `semantic`：用 title，但先剥前导 markdown 标题符号与首尾空白；剥完不足 6 字、或只剩 `#`/空白
 *   ⇒ 那是个没信息量的标题，退回范围（实测样本 `## 阶段` ⇒ 剥完 2 字 ⇒ 退回范围，**这是预期行为**）；
 * * `origin` 缺席（旧后端只给 title）：与 `semantic` 同分支（有 title 用 title，没有就范围）。
 */
export function foldHeadline(fold: FoldEntry): string {
  if (fold.origin === 'mechanical') return foldRangeLabel(fold);
  const title = cleanText(fold.title) ?? '';
  const heading = title.replace(MD_HEADING_PREFIX, '').trim();
  // 「只剩 #/空白」单独判一条：长度闸门可能被七个 `#` 骗过（`#######`.length === 7）。
  if (heading.length < HEADLINE_MIN_CHARS || !/[^#\s]/.test(heading)) return foldRangeLabel(fold);
  return heading;
}

/**
 * 工具足迹一行：`readFile×40 / shell×1 / writeFile×1`；没有足迹 ⇒ **空串**（渲染侧据此不画这一段）。
 *
 * 计数聚合按**首次出现顺序**（不是按次数排）：足迹回答的是「这一段大概读了什么」，
 * 顺序稳定比排序好看更重要（同一份 DTO 刷新两次不许换序）。超过 3 组 ⇒ 截到 3 组并加 ` …`
 * （常驻条与面板一行放不下 40 种工具的清单）。
 */
export function foldFootprint(fold: FoldEntry): string {
  const counts = new Map<string, number>();
  for (const call of fold.toolCalls ?? []) {
    const name = cleanText(call?.name);
    if (name === undefined) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (counts.size === 0) return '';
  const groups = [...counts.entries()].map(([name, count]) => `${name}×${count}`);
  if (groups.length <= FOOTPRINT_MAX_GROUPS) return groups.join(' / ');
  return `${groups.slice(0, FOOTPRINT_MAX_GROUPS).join(' / ')} …`;
}

/** 百分比钳制 + 保留 1 位小数（竖串的 `top` 直接吃这个数，模板里不再算）。 */
function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

/**
 * 竖串节点定位：`topPct = clamp(to / max(lastRound, maxTo) × 100, 0, 100)`，**纯数学、零 DOM 测量**
 * （不许 ResizeObserver / getBoundingClientRect / 滚动同步：竖串与消息流的**高度**没有任何契约关系，
 * 量来的高度只会随字体与窗口抖，而 `to / 总轮数` 是后端给的事实）。
 *
 * * `maxRound <= 0`（没有任何轮号）⇒ `[]`（一个节点都不画，而不是画一堆 0%）；
 * * `lastRound` 拿不到（`null`）⇒ 退化成「最后一条折叠落在 100%」——**这是有意的降级**：前端目前
 *   没有会话级「最新轮号」的来源（DTO 不带 `round`，`round_start` 只在实时/回放里可见），
 *   所以视图传的是 `session.compaction?.lastRound ?? null`；
 * * 返回**保持入参顺序**（入参已按 `from` 升序 ⇒ 最后一条就是最新的那条，渲染侧据此标实心点）。
 */
export function foldRailNodes(folds: FoldEntry[], lastRound: number | null): FoldRailNode[] {
  if (folds.length === 0) return [];
  let maxTo = 0;
  for (const fold of folds) maxTo = Math.max(maxTo, safeInt(fold.to) ?? 0);
  const maxRound = Math.max(safeInt(lastRound) ?? 0, maxTo);
  if (maxRound <= 0) return [];
  return folds.map((fold) => ({ fold, topPct: clampPercent(((safeInt(fold.to) ?? 0) / maxRound) * 100) }));
}
