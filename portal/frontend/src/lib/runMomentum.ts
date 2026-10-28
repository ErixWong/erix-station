// 运行态「动量」指标（issue #282 B 块）：纯计算层（常量 / 格式化 / 派生视图）。
//
// 数据面事实（本单**零后端改动**，全部来自已到达前端的 SSE 事件）：
//   * 事件全集见 `composables/useEventStream.ts` 的 `EVENT_TYPES`；
//   * ⚠ `run_end` / `usage` **不在历史回放白名单**（`HISTORY_REPLAY_TYPES`）⇒ **硬刷新后**这些运行态
//     数字拿不回来。本单口径：页面开着期间准确，硬刷新后回落成「只有消息时间戳 + 会话级信息」，
//     绝不拿假数据填（见 `createRunMomentumFeed` 的 history 短路）。
//
// 「不伪装精确」是本文件的核心约束，逐条钉在这里：
//   ① `tok/s` 是**前端滑窗估算**（字符数 → token 的近似 + chunk 时间差），不是上游真值 ⇒ 界面上
//      必须带 `~` 或 tooltip（i18n 的 `runStatus.rateHint`），并且**样本跨度不足就给 null**（不显示
//      一个凭 1 个 chunk 算出来的数）；
//   ② 终态 tokens 只取 `run_end.usage` 真值；没有就**不显示 token 数字**（绝不 `?? 0`）；
//   ③ 起跑时刻未知（页面开着时 run 已在跑，宿主只能从服务端 `active_run_id` 得知）⇒ `startedAt`
//      为 null，`elapsedMs` 派生为 null ⇒ 界面不出时长，而不是从「我看到它的那一刻」假装 0:00；
//   ④ `usage` 事件载荷是**单次 provider 调用**的用量（erix-agent `orchestrator.js:3252`
//      `emitEvent({ type: "usage", round, usage: response.usage })`），不是整 run 汇总 ⇒ 不拿它当
//      run tokens 显示；它只推进「最后活动时刻」。

/** 冻结判据阈值（issue #282 红线：做成常量，单测引用它，不许在各处硬写 5000）。
 * issue #387 把它从「故障判据」改成「**值得提一句**」阈值：运行中的相位秒数从这一刻开始上屏，
 * 但**不再因此标黄**（等 LLM 首字节本身就可以是几十秒，5s 标黄是在误导）。标黄另用下面的 stall 阈值。 */
export const RUN_FROZEN_THRESHOLD_MS = 5000;

/**
 * issue #387：“这次真的不对了”的阈值。取数依据是本站自己下发的相超时（`runner/lib/llm-timeouts.js`
 * 默认 `firstByteTimeoutMs=240s` / `streamIdleTimeoutMs=180s`）与 worker 看门狗（300s）：
 * 相位静默超过 60s 仍然没到上游超时，但已经足够让用户开始怀疑 ⇒ 这是唯一应该标黄的量。
 * ⚠ 不抄那两个数的字面量（只把量级写进注释）：那两个数住在容器 env，改它不需要改这里。
 */
export const RUN_STALL_THRESHOLD_MS = 60_000;

/** 运行相位（#387：把「在等 LLM」与「在等工具」分开写，而不是统一成「上游无输出」）。 */
export type RunPhase = 'awaiting_llm' | 'streaming' | 'tool_running';


/** `tok/s` 估算滑窗宽度（只看最近 10s 的增量，避免整 run 平均值把「现在快/慢」抹平）。 */
export const TPS_WINDOW_MS = 10_000;

/** 估算用的字符→token 近似比（英文 ~4 字符/token；中文更少，故界面必须带 `~`）。 */
export const CHARS_PER_TOKEN = 4;

/** 估算所需的最小样本跨度：小于 1s 的增量算出来的速率没有意义（宁可不出数）。 */
export const MIN_TPS_SPAN_MS = 1000;

/** 一次 `assistant_delta` 之后的累计观测点（`chars` = 本 run 累计流式字符数）。 */
export interface RunMomentumSample {
  t: number;
  chars: number;
}

/** `run_end.usage` 真值（缺键 = 上游没给，不补 0）。 */
export interface RunUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * issue #387：两个新用量面。都是**上游真值**（事件里直接带），前端不做任何估算。
 *   * `round`：最近一次 `usage` 事件 = **单次 provider 调用**的用量（`round` 号同源）；
 *     `usage.input_tokens` 就是那一次请求发出去的上下文体量 ⇒ 它就是「上下文吃了多少」的正解。
 *   * `run`：最近一次 `round_end.usage`。实测（真机 run_events）引擎在 `round_end` 上给的是
 *     **本 run 累计**（单调递增，最后一轮的值 = `run_end.usage`），所以运行中就能拿到累计真值，
 *     不必等到终态。❗ 这个口径来自引擎实现而不是契约文档：前端只当它「截至上一轮的累计」用，
 *     拿不到（旧引擎/旧 run）就整段不出。
 */

/** 运行态原始观测面（响应式持有在 store 里；组件只读派生视图）。 */
export interface RunMomentumState {
  /** 当前（或最近一次）run 的 id；null = 本页从未见过 run。 */
  runId: string | null;
  /** 起跑时刻（ms epoch）；null = 未知（页面中途打开/服务端续接），**不是 0**。 */
  startedAt: number | null;
  /** 终态时刻；null = 仍在跑。 */
  endedAt: number | null;
  /** 已知的最细轮号（来自 round_start/round_end/attempt/recovering/recovered）。 */
  round: number | null;
  /** 本 run 收到的流式字符数（累计）。 */
  outputChars: number;
  /** 本 run 收到的流式 UTF-8 字节数（累计，`↑ 4.1 KB` 的数据源）。 */
  outputBytes: number;
  /** `run_end.usage` 真值；null = 没拿到（不显示 token 数字）。 */
  usage: RunUsage | null;
  /**
   * #387：`usage` 当前的**来源**——true = 历史回放的 `round_end` 累计值，false = 实时 `run_end` 终态值。
   * 只需要区分这两者：同一 run 的多条历史帧之间允许后者盖前者（seq 升序，后面累计更大），
   * 但实时终态值一旦落地就不许被历史帧回退。不暴露给视图（界面上两者是同一个数）。
   */
  usageFromHistory: boolean;
  /** #387：最近一次 `usage` 事件（单次 provider 调用）的真值；null = 本轮还没收到过。 */
  roundUsage: RunUsage | null;
  /** #387：`roundUsage` 累加到的轮号（同轮多次调用累加，换轮则重置）。 */
  roundUsageRound: number | null;
  /** #387：最近一次 `round_end.usage`（本 run 累计真值）；null = 还没走完第一轮。 */
  runUsage: RunUsage | null;
  /** #387：模型上下文窗口（runner 下行的 `context_window`）；null = 没配 ⇒ 不出百分比。 */
  contextWindow: number | null;
  /** #387：当前运行相位与进入相位的时刻（驱动「等待 LLM 中 12s」这一句）。 */
  phase: RunPhase | null;
  phaseAt: number | null;
  /** #387：当前在跑的工具名（多次并发时取最后一个具名的；没名字就不写工具名）。 */
  activeToolName: string | null;
  /** #387：已发出 `tool_use` 但还没回 `tool_result` 的个数（>0 ⇒ 相位是 tool_running）。 */
  pendingTools: number;
  /** `tool_use` 次数。 */
  toolCount: number;
  /** 有 `duration_ms` 的工具累计耗时（用于「均 12s」）。 */
  toolDurTotalMs: number;
  toolDurCount: number;
  /** 最后一次流式/工具事件时刻（冻结判据的分子）。 */
  lastEventAt: number | null;
  /** `run_end.termination.reason`（原样透出，不解释）。 */
  termination: string | null;
  /** `tok/s` 滑窗样本（有界：只留最近 2 个窗口）。 */
  samples: RunMomentumSample[];
}

/** 空状态（store 初始化 / 切会话复位共用）。 */
export function createEmptyMomentumState(): RunMomentumState {
  return {
    runId: null,
    startedAt: null,
    endedAt: null,
    round: null,
    outputChars: 0,
    outputBytes: 0,
    usage: null,
    usageFromHistory: false,
    roundUsage: null,
    roundUsageRound: null,
    runUsage: null,
    contextWindow: null,
    phase: null,
    phaseAt: null,
    activeToolName: null,
    pendingTools: 0,
    toolCount: 0,
    toolDurTotalMs: 0,
    toolDurCount: 0,
    lastEventAt: null,
    termination: null,
    samples: [],
  };
}

/** 派生视图（组件只渲染它；所有「拿不到」一律是 null，不是 0）。 */
export interface RunMomentumView {
  running: boolean;
  /** 已结束且留有本 run 观测（空闲态「上次 run 概况」是否可显示）。 */
  hasLastRun: boolean;
  round: number | null;
  outputBytes: number;
  /** 估算速率；null = 样本不足（不显示）。 */
  tokensPerSec: number | null;
  /** 本 run 时长；null = 起跑时刻未知。 */
  elapsedMs: number | null;
  /** 距最后一次流式/工具事件的毫秒数；null = 无观测。 */
  frozenMs: number | null;
  frozen: boolean;
  toolCount: number;
  /** 工具平均耗时；null = 一个带时长的结果都没收到。 */
  toolAvgMs: number | null;
  usage: RunUsage | null;
  termination: string | null;
  /** #387：当前相位（null = 还看不出来）。 */
  phase: RunPhase | null;
  /** #387：当前相位已持续多久；null = 相位未知或已终态。 */
  phaseMs: number | null;
  /** #387：超过 `RUN_STALL_THRESHOLD_MS` ⇒ 值得标黄。**只有这一种**会变色。 */
  stalled: boolean;
  /** #387：当前在跑的工具名（没有就 null ⇒ 文案不写工具名）。 */
  activeToolName: string | null;
  /** #387：本轮（最近一次 provider 调用）的用量真值。 */
  roundUsage: RunUsage | null;
  /** #387：本 run 累计用量真值（来自 `round_end.usage`；没收到过任何 `round_end` 则 null）。 */
  runUsage: RunUsage | null;
  /** #387：上下文占用百分比（0–100，取整）；窗口或本轮输入任一未知 ⇒ null（不出百分比）。 */
  contextPct: number | null;
  /** #387：上下文窗口；null = 未配。 */
  contextWindow: number | null;
}

/** 文本的 UTF-8 字节数（手写：jsdom 下不保证有 TextEncoder，且这里只需要长度）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/**
 * 时长格式化：`03:42` / `1:02:03`。
 * null / 非有限数 / 负数 ⇒ `''`（调用方据此整段不出，绝不渲染 `NaN:NaN`）。
 */
export function formatElapsed(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 字节量格式化：`812 B` / `4.1 KB` / `2.3 MB`。
 * null / 非有限数 / 负数 ⇒ `''`（不显示 `NaN KB`）。
 */
export function formatByteSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 滑窗速率估算（token/s，**近似值**）。
 * 判据：窗口内首样本到末样本的跨度 ≥ `MIN_TPS_SPAN_MS` 且字符有增量，否则 null。
 * 结果保留 1 位小数（不制造「27.4381」这种伪精度）。
 */
export function estimateTokensPerSec(
  samples: readonly RunMomentumSample[],
  nowMs: number,
  windowMs: number = TPS_WINDOW_MS,
): number | null {
  if (!Array.isArray(samples) || samples.length < 2) return null;
  const last = samples[samples.length - 1];
  if (last === undefined) return null;
  const cutoff = nowMs - windowMs;
  const first = samples.find((s) => s.t >= cutoff) ?? samples[0];
  if (first === undefined) return null;
  const spanMs = last.t - first.t;
  if (!Number.isFinite(spanMs) || spanMs < MIN_TPS_SPAN_MS) return null;
  const chars = last.chars - first.chars;
  if (!Number.isFinite(chars) || chars <= 0) return null;
  const tokens = chars / CHARS_PER_TOKEN;
  return Math.round((tokens / (spanMs / 1000)) * 10) / 10;
}

/**
 * 原始观测 → 派生视图。`nowMs` 由调用方给（composable 的 1s 时钟 / 单测的固定时刻），
 * 本函数**不读时钟**——这样「跨过冻结阈值那一刻」可以被单测精确钉住。
 */
export function deriveMomentumView(state: RunMomentumState, nowMs: number): RunMomentumView {
  const running = state.runId !== null && state.endedAt === null;
  const endAt = state.endedAt ?? (running ? nowMs : null);
  const elapsedMs = state.startedAt === null || endAt === null
    ? null
    : Math.max(0, endAt - state.startedAt);
  const frozenMs = running && state.lastEventAt !== null
    ? Math.max(0, nowMs - state.lastEventAt)
    : null;
  // 「> 5s」是工单口径：恰好 5000ms 还不算冻结（单测按这个边界钉）。
  // #387：这条现在只代表「值得提一句」（上屏秒数），**不再驱动颜色**——颜色另看 `stalled`。
  const frozen = frozenMs !== null && frozenMs > RUN_FROZEN_THRESHOLD_MS;
  // #387：相位时长。终态后不出（那时该看的是「上次 run」概况，不是「还在等谁」）。
  const phaseMs = running && state.phase !== null && state.phaseAt !== null
    ? Math.max(0, nowMs - state.phaseAt)
    : null;
  // 相位已知时拿相位算黄，未知（旧后端/丢帧）时退回事件静默时长——黄必须仍然会亮，只是不再乱亮。
  const stalledRef = phaseMs !== null ? phaseMs : frozenMs;
  const stalled = stalledRef !== null && stalledRef > RUN_STALL_THRESHOLD_MS;
  // #387：上下文占用 = **本轮输入 token / 上下文窗口**。两个数都是上游真值；任一没有 ⇒ null
  // （整段不出）。钳到 0–100：provider 报的 input_tokens 理论上可以超过标称窗口（折叠未触发 /
  // 元数据填小了），负值与脏值一律当「没有」而不是「0%」。
  const roundInput = finiteOrNull(state.roundUsage?.input_tokens);
  const rawWindow = finiteOrNull(state.contextWindow);
  // 窗口必须是**正**数：0 / 负数 / NaN 都是「没拿到」，而不是「上限 0」（#283/#299 同一口径）。
  const window = rawWindow !== null && rawWindow > 0 ? rawWindow : null;
  let contextPct: number | null = null;
  if (roundInput !== null && window !== null && window > 0) {
    contextPct = Math.min(100, Math.max(0, Math.round((roundInput / window) * 100)));
  }
  return {
    running,
    hasLastRun: state.runId !== null && state.endedAt !== null,
    round: state.round,
    outputBytes: state.outputBytes,
    // 速率只在运行中有意义（终态后残留的滑窗值会变成「现在还在跑」的误导）。
    tokensPerSec: running ? estimateTokensPerSec(state.samples, nowMs) : null,
    elapsedMs,
    frozenMs,
    frozen,
    toolCount: state.toolCount,
    toolAvgMs: state.toolDurCount > 0
      ? Math.round(state.toolDurTotalMs / state.toolDurCount)
      : null,
    usage: state.usage,
    termination: state.termination,
    phase: running ? state.phase : null,
    phaseMs,
    stalled,
    activeToolName: running ? state.activeToolName : null,
    roundUsage: state.roundUsage,
    runUsage: state.runUsage,
    contextPct,
    contextWindow: window,
  };
}

/** 有限数才认；`NaN` / 字符串 / `undefined` 一律当「没拿到」（而不是 0）。 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * token 量的紧凑写法：`4.2k` / `128k` / `1.2M`（状态条位置很窄，`116204` 这种全位数会挤爆）。
 * null / 脏值 / 负数 ⇒ `''`（整段不出）。阈值用 1000 而不是 1024：token 不是字节。
 */
export function formatTokenCount(tokens: number | null | undefined): string {
  const n = finiteOrNull(tokens);
  if (n === null || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${trimZero((n / 1000).toFixed(1))}k`;
  return `${trimZero((n / 1_000_000).toFixed(1))}M`;
}

function trimZero(text: string): string {
  return text.endsWith('.0') ? text.slice(0, -2) : text;
}
