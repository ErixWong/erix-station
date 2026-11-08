// 子 run（delegation）UI 的**唯一分级尺规**（issue #delegate P3，设计 §6.1）。
//
// 为什么单独成文件（而不是写在组件里）：工具卡（`StreamPanel.vue`）与只读抽屉
// （`DelegateChildDrawer.vue`）**两处都要**给同一个子 run 画同一颗徽标，颜色必须同源
// —— 否则「卡片绿、抽屉红」这种自相矛盾就是下一个 #236。
//
// 两条不可让的口径：
//   ① **分级不许只看名册 `state`**：`state === 'completed'` 但 `termination` 属于
//      `RUN_TERMINATION_SYSERR_REASONS`（`persistence_failed` / `final_guard_unverified` /
//      `failed` / `max_rounds_cap`）⇒ **仍判红**。名册 state 只回答「引擎认为它怎么收的尾」，
//      而「快照没落盘」这类收尾在用户面就是故障（`terminationReasons.ts` 头注 + issue #212）。
//      红色集合**唯一来源**是 `lib/terminationReasons.ts`，本文件**不许**另造第二份枚举
//      （由 `lib/delegate.spec.ts` 钉住：直接对 `RUN_TERMINATION_SYSERR_REASONS` 逐项断言）。
//   ② `aborted` 是**琥珀不是红**（用户主动停止不是故障，#236 同一口径），且它**不在**
//      `RUN_TERMINATION_SYSERR_REASONS` 里 —— 拿 syserr 集合判红天然不会把停止误染成失败。
//
// 状态色/图标的取值照 pi-web `components/AgentSessionPanel.tsx:129-165`（单一来源）：
//   running/starting=accent、completed=#16a34a、failed=#dc2626、aborted=#d97706、其余=text-dim。
// Tailwind 侧 `red-600`/`amber-600`/`green-600` 与那三个十六进制**逐字相同**，所以直接用车
// 尾类而不写内联 style（本站没有 pi-web 的 CSS 变量层，只有 `style.css` 的 `--color-brand`）。

import { RUN_TERMINATION_SYSERR_REASONS } from './terminationReasons';

/** 名册 `state` 的封闭 7 值（引擎 `roster.js#ROSTER_STATES`，portal 读侧同源）。 */
export const DELEGATE_ROSTER_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'aborted',
  'timeout',
  'interrupted',
] as const;

export type DelegateRosterState = (typeof DELEGATE_ROSTER_STATES)[number];

/**
 * 活态（还要继续刷新的两种 state）。**只有这两种**算活态：
 * `queued` 在 P1 之后其实已经被引擎改成写 `running`，留它是为名册里的旧记录兜底，
 * 不是为了「将来可能有」。
 */
export const DELEGATE_LIVE_STATES: ReadonlySet<string> = new Set<string>(['queued', 'running']);

/**
 * 终态（轮询**必须**停下来的一组 state）。与活态互斥，且**逐值**由 7 值封闭集减去活态导出，
 * 不手抄第二份清单（将来引擎加第 8 个 state 时这里会自己长出来，而不是悄悄漏掉一种不停的）。
 */
export const DELEGATE_TERMINAL_STATES: ReadonlySet<string> = new Set<string>(
  DELEGATE_ROSTER_STATES.filter((state) => !DELEGATE_LIVE_STATES.has(state)),
);

/** 抽屉与卡片的轮询间隔（毫秒）。照 pi-web `SubagentViewer.tsx` 的 `POLL_MS = 2000`。 */
export const DELEGATE_POLL_MS = 2000;

/** 一次拉取的窗口（条）。P2 端点硬上限 500，默认 100；子 run ≤8 轮 ⇒ 100 足够全量替换。 */
export const DELEGATE_TAIL = 100;

/** 短码：runId 后 8 位。脏值（非字符串/空）→ 原样返回 ''，调用方 `v-if` 整段不出。 */
export function shortRunId(runId: unknown): string {
  return typeof runId === 'string' ? runId.slice(-8) : '';
}

export function isDelegateLive(state: unknown): boolean {
  return typeof state === 'string' && DELEGATE_LIVE_STATES.has(state);
}

export function isDelegateTerminal(state: unknown): boolean {
  return typeof state === 'string' && DELEGATE_TERMINAL_STATES.has(state);
}

/**
 * 徽标类别（**语义**，不是颜色）：渲染层按这张表挑 Tailwind 类与图标。
 * 六值封闭，`unknown` 是「拿不到 state / 不在 7 值里」—— 画中性灰，**不猜**成 running。
 */
export type DelegateBadgeKind = 'running' | 'completed' | 'aborted' | 'failed' | 'unknown';

/**
 * 分级（单一入口）。
 *
 * 判定顺序**有意义**：syserr 检查必须在 `completed` 之前（`completed` + `persistence_failed`
 * 是真实可达组合，判序反了就是「谎报成功」）。
 *
 * @param state       名册 state（脏值/缺位 ⇒ `unknown` ⇒ 中性灰）
 * @param termination 引擎 reason 的**字符串**（P2 读侧已把对象形态归一成 null；这里仍只认字符串，
 *                    拿到对象不当「命中 syserr」处理，避免把「形状不认识」误升级成红色告警）
 */
export function delegateBadgeKind(state: unknown, termination?: unknown): DelegateBadgeKind {
  if (typeof state !== 'string' || state === '') return 'unknown';
  if (DELEGATE_LIVE_STATES.has(state)) return 'running';
  // 唯一的 syserr 闸：`RUN_TERMINATION_SYSERR_REASONS`（= RUN_FAIL_REASONS 减 `aborted`，#236）。
  if (typeof termination === 'string' && RUN_TERMINATION_SYSERR_REASONS.has(termination)) return 'failed';
  switch (state) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return 'aborted';
    case 'failed':
    case 'timeout':
    case 'interrupted':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** 徽标色（Tailwind 类）。色值与 pi-web `statusColor` 对齐；中性态用站内既有的 `text-black/50`。 */
export const DELEGATE_BADGE_CLASS: Readonly<Record<DelegateBadgeKind, string>> = {
  running: 'text-brand',
  completed: 'text-green-600',
  aborted: 'text-amber-600',
  failed: 'text-red-600',
  unknown: 'text-black/50',
};

/** 状态文案的 i18n 键后缀（`delegate.state.<kind>`）。7 值 + unknown 共 8 个，双语成对。 */
export function delegateStateKey(state: unknown): string {
  return typeof state === 'string' && (DELEGATE_ROSTER_STATES as readonly string[]).includes(state)
    ? state
    : 'unknown';
}

/** 抽屉/名册端点（两个 id 都要编码，路径段不许裸拼）。 */
export function delegateTranscriptUrl(sessionId: string, childRunId: string, parentRunId: string): string {
  const q = new URLSearchParams({ runId: parentRunId, tail: String(DELEGATE_TAIL) });
  return `/api/sessions/${encodeURIComponent(sessionId)}/delegates/${encodeURIComponent(childRunId)}?${q}`;
}

/**
 * 子 run 消息（P2 读侧 `getDelegateTranscript` 的 `messages[]`，与主对话 DTO 同形）。
 * 这里只声明 UI 真正消费的字段，其余键（`blocks`/`reasoning`/`folded`/`seq`）原样留着不解释。
 */
export interface DelegateToolCall {
  name?: unknown;
  argsSummary?: unknown;
  isError?: unknown;
}
export interface DelegateMessage {
  id?: unknown;
  role?: unknown;
  text?: unknown;
  toolCalls?: unknown;
}

/** 工具行文本：`🔧 name · argsSummary`。`argsSummary` 缺席 ⇒ 调用方**不渲染这一行**（工单 §3.1）。 */
export function delegateToolCallText(call: DelegateToolCall): string | null {
  const args = typeof call.argsSummary === 'string' ? call.argsSummary : '';
  if (args === '') return null;
  const name = typeof call.name === 'string' && call.name !== '' ? call.name : '?';
  return `🔧 ${name} · ${args}`;
}

// ---------------------------------------------------------------------------
// delegate 工具结果的解析（卡片摘要 / 分级 / 「查看子 run」按钮的闸门，工单 §2）。
//
// 为什么必须有**逐字段兜底**（2026-12 真机定位，刷新后按钮必消失）：加载/刷新路径卡片上的
// `resultPreview` 是**上游截断到 400 字符**的预览串（末尾带 `…`），内容正是 delegate 结果 JSON 的
// 前缀 —— 引号不闭合 ⇒ `JSON.parse` **必然抛** ⇒ 解析失败 ⇒ `runId` 为空 ⇒ 按钮不渲染。
// 实时路径的 `card.out` 是完整 JSON（`✓ {json} (1.2s)` 包裹），所以实时一切正常，**只有刷新后坏**，
// 而刷新是用户最常做的动作。前缀里 `ok`/`runId`/`state` 都在截断点之前 ⇒ 逐字段正则拿得到。
//
// 顺序（每一层失败才落到下一层，全程 try/catch，**绝不抛**）：
//   ① 入参已是对象 ⇒ 直接取字段；
//   ② 整串 `JSON.parse`；
//   ③ 抠出 `{…}` 再 parse（实时路 `out` 的 `✓ {json} (1.2s)` 包裹，原 `StreamPanel` 的语义）；
//   ④ **逐字段正则**各取一次（互不相关 ⇒ 与字段顺序无关，也不要求 JSON 完整）。
//
// 「不许返回空壳」的口径：④ 里 `runId` 与 `state` 一个都没拿到 ⇒ 返回 `null`（调用方退回既有
// 摘要与 ✓/✗）；对象路径（①②③）只在**一个 delegate 字段都不认识**时才返回 `null` —— 拒单信封
// `{ ok:false, reason:'capacity_full' }` 本来就没有 `runId`/`state`，那是**有效结果**不是空壳
// （它要驱动「不出按钮且不谎报成功」的展示，`DelegateToolCard.spec.ts` 有对应用例）。
// ---------------------------------------------------------------------------

/** delegate 结果里 UI 真正消费的字段；字段缺位一律 `''`（`ok` 缺位是 `null`，与 `false` 可区分）。 */
export interface DelegateResult {
  ok: boolean | null;
  runId: string;
  state: string;
  termination: string;
  action: string;
}

/** ④ 的逐字段兜底：各字段一条正则，独立取用 ⇒ 前缀里出现顺序不影响结果。 */
const DELEGATE_FIELD_RES = {
  runId: /"runId"\s*:\s*"([^"]+)"/,
  state: /"state"\s*:\s*"([^"]+)"/,
  termination: /"termination"\s*:\s*"([^"]+)"/,
  action: /"action"\s*:\s*"([^"]+)"/,
} as const;
const DELEGATE_OK_RE = /"ok"\s*:\s*(true|false)/;
/** delegate 结果的字段名（判断「这个对象到底是不是 delegate 的结果」）。 */
const DELEGATE_KEYS = ['ok', 'runId', 'state', 'termination', 'action'] as const;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 非对象 / 数组 / `null` ⇒ null。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * termination 上游给过字符串与 `{ reason }` 对象两种形状（#212）：只收敛成字符串，
 * 形状不认识就当归不到（不拿「不认识」误升级成红色告警）。
 */
function terminationText(value: unknown): string {
  return asString(value && typeof value === 'object' ? (value as { reason?: unknown }).reason : value);
}

function delegateResultFromObject(obj: Record<string, unknown>): DelegateResult {
  return {
    ok: obj.ok === true ? true : obj.ok === false ? false : null,
    runId: asString(obj.runId),
    state: asString(obj.state),
    termination: terminationText(obj.termination),
    action: asString(obj.action),
  };
}

/** ④：从前缀里逐字段取一次；`runId` 与 `state` 都没取到 ⇒ null（不返回空壳）。 */
function delegateResultFromPrefix(text: string): DelegateResult | null {
  const pick = (re: RegExp): string => text.match(re)?.[1] ?? '';
  const runId = pick(DELEGATE_FIELD_RES.runId);
  const state = pick(DELEGATE_FIELD_RES.state);
  if (runId === '' && state === '') return null;
  const ok = text.match(DELEGATE_OK_RE)?.[1];
  return {
    ok: ok === 'true' ? true : ok === 'false' ? false : null,
    runId,
    state,
    // 截断串里的 termination 只能按字符串取（对象形态 `{ reason }` 取不到 ⇒ 当没这个字段，同 #212 口径）。
    termination: pick(DELEGATE_FIELD_RES.termination),
    action: pick(DELEGATE_FIELD_RES.action),
  };
}

/**
 * 从工具结果文本里取 delegate 的结构化字段。先整体 `JSON.parse`；失败（被 400 字截断）则逐字段正则兜底。
 *
 * 入参 `unknown`：字符串（完整 JSON / `✓ {json} (1.2s)` 包裹 / 截断预览）、已经是对象、`null` 都收。
 * 解不出任何 delegate 字段 ⇒ `null`，调用方**必须**退回既有展示；本函数**绝不抛**。
 */
export function parseDelegateResult(raw: unknown): DelegateResult | null {
  try {
    const direct = asRecord(raw);
    if (direct) return DELEGATE_KEYS.some((key) => key in direct) ? delegateResultFromObject(direct) : null;
    if (typeof raw !== 'string' || raw === '') return null;

    const candidates = [raw];
    // ③ 实时路 `out` 的包裹形状：`✓ {json} (1.2s)`。截断串没有闭合的 `}` ⇒ 抠不出，自然落到 ④。
    const braced = raw.match(/\{[\s\S]*\}/);
    if (braced && braced[0] !== raw) candidates.push(braced[0]);
    for (const candidate of candidates) {
      try {
        const parsed = asRecord(JSON.parse(candidate));
        if (parsed) return delegateResultFromObject(parsed);
      } catch {
        // 截断的预览在这一层必抛（引号不闭合）—— 它是**常态**，不是错误：继续下一个候选，最后落 ④。
      }
    }
    return delegateResultFromPrefix(raw);
  } catch {
    // 截断的预览、工具给的非 JSON 文案、旧数据都是**正常情况**，不是错误（调用方退回既有展示）。
    return null;
  }
}
