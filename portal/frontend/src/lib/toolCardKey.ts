// issue #279：工具卡片**身份**的单一尺规（三条路径共用一把尺）。
//
// 缺陷本体：卡片此前直接以 provider 的 `tool_call_id` 当身份（`useEventStream.ts` 里
// `toolCards = new Map<string, ToolCardState>()` + 命中即返回、`name` 首写冻结）。而这个 id
// **只在轮内唯一**：OpenAI 兼容流的 `tool_calls` 是轮内 index 作用域，Anthropic 只保证单次
// response 内唯一，本站上游的兜底常量甚至写作 `call_legacy` ⇒ 同一个 run 内跨轮复用 id 时，
// 后面所有轮的调用都并进第一轮那张卡、`name` 永远是第一轮的工具 ⇒ 用户实测「每轮恒
// ✓ readFile、✓ readFile，`edit` 卡片看不见」。
//
// 修法：身份 = **含轮号的组合键**（缺位的段不拼，见 `toolCardKey`）。三段各自的来源：
//   * `run_id`：事件信封（SSE 与历史回放都带，§5.3 共享信封）；DTO 侧取锚点消息的 `run_id`。
//   * 轮号：**不是** `tool_use`/`tool_result` 载荷里的字段——契约 §5.3 第 6/7 类都没有 `round`
//     （只有第 1~5/8 类的 `round_start`/`attempt`/`recovering`/`recovered`/`usage`/`round_end` 有）。
//     实时与历史回放两条路都走同一个 `dispatch()`，而 `round_start` 既在实时 `EVENT_TYPES` 也在
//     历史下发白名单（docs/api/portal.md §4.4a）⇒ 事件侧轮号 = **本连接内观测到的
//     `round_start.round`**（引擎 `orchestrator.js` 的 `emitEvent({ type: "round_start", round })`
//     与落盘 RoundRecord.round 是同一个计数器，实测源码：`appendEngineMessagesToTranscript(…, round)`
//     用同一个 `round` 局部量）。拿不到就**不拼这一段**，绝不伪造（不拿 0 冒充第 0 轮）。
//   * DTO 投影侧没有事件流状态，但上游投影键本身就含轮号：
//     `toolCalls[].key = "<round>#<recordIndex>:<entryIndex>:t<toolCallIndex>"`
//     （erix-agent 0.22.0 `src/display/projection.js:449-455`，轮号缺位时上游自己写 `?`）
//     ⇒ `projectionRoundToken()` 取 `#` 之前那段。
//   * `tool_result` 的**关联**不拿轮号当尺（载荷没有轮号，跨 resume 时结果还可能落在下一轮）⇒
//     见 `useEventStream.ts` 的 `cardForCorrelation`：先试精确身份键，未命中回落
//     `callId → 最新卡片` 的**辅助索引**；索引只用于关联/归并，**不得再当身份**。
//
// 为什么三条路必须拼成**同一个串**：实时卡片与刷新后的投影卡片要归并成一张（§8.5「provider id
// 与实时 `tool_call_id` 同源 ⇒ 天然归并」这条至今成立，只是现在多了轮号那一段）。两路算出的
// 轮号真对不上时（例如实时漏收 `round_start`）由那条 callId 索引兜住归并 ⇒ 最坏退化成本单之前
// 的形态，**不会**出现「刷新后卡片翻倍」。
//
// 本文件零运行时依赖（与 `lib/terminationReasons.ts` 同规矩：可被 `node --test` 直读）。

/** 轮号未知时的记号。与上游投影键缺轮号时用的**同一个字符**（`projection.js:450` 的 `roundToken = "?"`）。 */
export const UNKNOWN_ROUND_TOKEN = '?';

/** 数字（或数字串）→ 轮号段；取不到有效数值 ⇒ null。**不拿 0 冒充「没有轮号」**（0 是合法轮号）。 */
function roundNumberToken(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return String(Number(value)); // 归一成引擎的写法（"03" 与 3 必须是同一段）
  }
  return null;
}

/** 事件载荷里的轮号（`round_start.round` 一类）；脏值/缺位 ⇒ `UNKNOWN_ROUND_TOKEN`。 */
export function eventRoundToken(round: unknown): string {
  return roundNumberToken(round) ?? UNKNOWN_ROUND_TOKEN;
}

/**
 * DTO 投影侧的轮号：从上游视图键 `toolCalls[].key` 里取 `#` 之前的轮号段。
 * 形状不符（无 `#`、非数字、上游写的 `?`）一律 `UNKNOWN_ROUND_TOKEN`——本函数**不解释**语义，
 * 只判「这段是不是一个可用轮号」（§8.5：投影 `key` 不是持久 ID、也不是 provider `tool_use.id`，
 * 这里只借它携带的轮号，没有把它当跨投影耐久的身份）。
 */
export function projectionRoundToken(projectionKey: unknown): string {
  if (typeof projectionKey !== 'string') return UNKNOWN_ROUND_TOKEN;
  const hash = projectionKey.indexOf('#');
  if (hash <= 0) return UNKNOWN_ROUND_TOKEN;
  return roundNumberToken(projectionKey.slice(0, hash)) ?? UNKNOWN_ROUND_TOKEN;
}

/** 可用的 `run_id` 段（脏值/缺位 ⇒ null ⇒ 身份里不拼这一段）。 */
export function runSegment(runId: unknown): string | null {
  return typeof runId === 'string' && runId !== '' ? runId : null;
}

/**
 * 卡片身份（= `toolCards` Map 的键）。**缺位的段直接不拼**，而不是拿占位串填一个：
 *   * 三段齐全（真机形状）⇒ `r1:3:c1`；
 *   * 拿不到轮号（旧后端没有 `round_start`、或投影键缺轮号）⇒ `r1:c1`；
 *   * 连 `run_id` 也没有（旧帧）⇒ 退回裸 `c1` —— 与 #279 **之前**的键逐字相同，
 *     于是旧数据/旧后端下的键形状零变化（历史工具卡片展开记忆 `lib/toolCallExpansion`
 *     的键、以及既有回归用例的断言形状都不受影响）。
 * 本函数**永不抛错**：身份算不出来时宁可退化成「按 run+id 一张卡」，也不能把渲染链弄挂。
 */
export function toolCardKey(runId: unknown, roundToken: string, callId: string): string {
  const parts: string[] = [];
  const run = runSegment(runId);
  if (run !== null) parts.push(run);
  if (roundToken !== UNKNOWN_ROUND_TOKEN) parts.push(roundToken);
  parts.push(callId);
  return parts.join(':');
}
