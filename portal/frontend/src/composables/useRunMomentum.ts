// 运行态动量的状态机 + 时钟（issue #282 B 块）。
//
// 分工（工单「落点」要求）：
//   * **状态机**（`createRunMomentumFeed`）= 唯一的事件入口，由 store 持有（store 拥有 SSE 协议状态）；
//     纯数据 + 纯函数式 ingest，**不碰 Vue 生命周期、不建定时器** ⇒ 单测可以拿着假事件直接驱动。
//   * **时钟/派生**（`useRunMomentum`）= 组件侧 composable：1s tick 出「现在」，把原始观测派生成视图，
//     `onUnmounted` 清定时器（工单要求单测能断言「卸载后不再有 interval」）。
//
// ⚠ **硬刷新边界**（必须写进代码与 issue 回帖）：`run_end` / `usage` 不在历史回放白名单
// （`useEventStream.ts` 的 `HISTORY_REPLAY_TYPES`），所以刷新后这些运行态数字**拿不回来**。本文件的
// 处理是 `ingest(..., history=true)` **直接短路**——历史帧（含 round_start/tool_use）一律不驱动运行态，
// 于是刷新后回落成「只有消息时间戳 + 会话级信息」。**不许用假数据把空白填满**。
//
// issue #425 只开了**一个口子，且只开在用量上**：`round_end` 在白名单里，而它的 `usage` 是本 run 的
// 累计真值 ⇒ 刷新后「上次 run 吃了多少 token / 窗口多大」能拿回来。相位 / 轮号 / 时长 / 速率
// 依旧一律不吃历史帧（那会把历史帧说成「现在在跑」）。
import { computed, onMounted, onUnmounted, reactive, ref, type ComputedRef } from 'vue';
import {
  createEmptyMomentumState,
  deriveMomentumView,
  TPS_WINDOW_MS,
  utf8ByteLength,
  type RunMomentumState,
  type RunMomentumView,
  type RunPhase,
  type RunUsage,
} from '../lib/runMomentum';

/** 状态条时钟节拍（1s：与「已运行 Xs」/「上游已 Xs 无输出」的秒级粒度一致）。 */
export const RUN_MOMENTUM_TICK_MS = 1000;

/** 非活动事件：不刷新「最后活动时刻」（ping/session_updated/resync 是协议帧，run_end 单独处理）。 */
const NON_ACTIVITY_TYPES = new Set(['ping', 'session_updated', 'resync', 'run_end']);

export interface RunMomentumFeed {
  state: RunMomentumState;
  /**
   * 事件入口（store 的 `useEventStream` onEvent 钩子逐帧调用）。
   * @param history 历史回放帧（`GET /events/history`）⇒ 直接短路，见文件头注。
   * @param nowMs   观测时刻（缺省 Date.now；单测显式传入以便精确钉住边界）。
   */
  ingest: (type: string, payload?: Record<string, unknown> | null, history?: boolean, nowMs?: number) => void;
  /**
   * 起跑登记（宿主在「POST 返回 run id」或「服务端说这个会话有 active_run_id」时调用）。
   * @param startedAt 缺省 = 现在（用户刚发出，我们知道起跑时刻）；显式 `null` = **未知**
   *   （页面中途打开、run 早已在跑）⇒ 界面不出时长，不从「我看到它的那一刻」假装 0:00。
   */
  beginRun: (runId: string, startedAt?: number | null) => void;
  /** 切会话/离开会话复位（不保留上一个会话的动量数字）。 */
  reset: () => void;
}

function runIdOf(payload: Record<string, unknown> | null | undefined): string | null {
  const id = payload?.run_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** `run_end.usage` 取真值：只收有限数，缺键就不写（不补 0）。 */
function readUsage(raw: unknown): RunUsage | null {
  if (raw === null || typeof raw !== 'object') return null;
  const usage: RunUsage = {};
  const input = (raw as Record<string, unknown>).input_tokens;
  const output = (raw as Record<string, unknown>).output_tokens;
  if (typeof input === 'number' && Number.isFinite(input)) usage.input_tokens = input;
  if (typeof output === 'number' && Number.isFinite(output)) usage.output_tokens = output;
  return Object.keys(usage).length > 0 ? usage : null;
}

/** 有限数才认（`NaN` / 字符串 / `undefined` = 「没拿到」，不是 0）。 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 本轮用量累加（同轮多次 provider 调用：续写 / 重试）。两边都缺的键保持缺席，不补 0。 */
function addUsage(base: RunUsage | null, delta: RunUsage): RunUsage {
  const out: RunUsage = { ...base };
  for (const key of ['input_tokens', 'output_tokens'] as const) {
    const a = out[key];
    const b = delta[key];
    if (typeof b === 'number') out[key] = (typeof a === 'number' ? a : 0) + b;
  }
  return out;
}

/** 历史帧里的上下文窗口（runner 宿主侧 additive 字段）；只收正有限整数之外的脏值一律当没拿到。 */
function readContextWindow(raw: unknown): number | null {
  const value = finiteOrNull(raw);
  return value !== null && value > 0 ? value : null;
}

/**
 * 状态机工厂：返回响应式原始观测面 + ingest/beginRun/reset。
 * 每个 store 实例一份（pinia setup store 里创建），组件通过 `useRunMomentum` 只读派生。
 */
export function createRunMomentumFeed(): RunMomentumFeed {
  const state = reactive<RunMomentumState>(createEmptyMomentumState());

  function reset(): void {
    Object.assign(state, createEmptyMomentumState());
    state.samples = [];
  }

  function beginRun(runId: string, startedAt?: number | null): void {
    if (typeof runId !== 'string' || runId === '') return;
    const same = state.runId === runId && state.endedAt === null;
    state.runId = runId;
    state.endedAt = null;
    const nextStart = startedAt === undefined ? Date.now() : startedAt;
    // 同一个 run 重复登记（POST 返回 → SSE 重连对账）时：**只补已知值，不拿 null 覆盖已知起跑时刻**
    // （重连那条路径只能给 null，覆盖了就会把「本 run 03:42」抹成未知）。
    if (!(same && nextStart === null)) state.startedAt = nextStart;
    // 同一个 run 重复登记时不清零：否则会把已收到的增量抹掉。
    if (same) return;
    state.round = null;
    state.outputChars = 0;
    state.outputBytes = 0;
    state.usage = null;
    state.usageFromHistory = false;
    state.roundUsage = null;
    state.roundUsageRound = null;
    state.runUsage = null;
    state.contextWindow = null;
    state.phase = null;
    state.phaseAt = null;
    state.activeToolName = null;
    state.pendingTools = 0;
    state.toolCount = 0;
    state.toolDurTotalMs = 0;
    state.toolDurCount = 0;
    state.lastEventAt = null;
    state.termination = null;
    state.samples = [];
  }

  /** 滑窗样本有界：只保留最近两个窗口（速率只需要窗口内 + 一个窗口外的锚点）。 */
  function pruneSamples(nowMs: number): void {
    const cutoff = nowMs - TPS_WINDOW_MS * 2;
    while (state.samples.length > 2 && (state.samples[1]?.t ?? 0) < cutoff) state.samples.shift();
  }

  function ingest(
    type: string,
    payload: Record<string, unknown> | null = {},
    history = false,
    nowMs: number = Date.now(),
  ): void {
    // 历史回放帧不驱动运行态（硬刷新边界的落点，见文件头注）。
    // 唯一例外 `historyUsageOnly`：历史 `round_end` 的累计用量与窗口——只喂【用量】与【窗口】两个数，
    // 并且把登记出来的 run 直接标成已结束（否则历史帧会被当成「现在在跑」）。
    const historyUsageOnly = history && type === 'round_end';
    if (history && !historyUsageOnly) return;
    const d = payload ?? {};
    const rid = runIdOf(d);

    if (type === 'run_end') {
      // 只认本 run 的终态（迟到/历史帧不得把正在跑的 run 标成结束）。
      if (state.runId === null) return;
      if (rid !== null && rid !== state.runId) return;
      state.endedAt = nowMs;
      state.lastEventAt = nowMs;
      const termination = (d.termination as { reason?: unknown } | null | undefined)?.reason;
      state.termination = typeof termination === 'string' && termination !== '' ? termination : null;
      // 真值优先：`run_end.usage` 有就显示真值，没有就保持 null（界面不出 token 数字）。
      // 来源标成实时：此后任何历史 `round_end` 都不得回退它（#425）。
      state.usage = readUsage(d.usage);
      state.usageFromHistory = false;
      return;
    }

    // 历史 `round_end`：本页没见过这个 run（硬刷新后的典型形状）⇒ 登记一个**已结束的** run，
    // 只为了把「上次 run」那一栏的用量与窗口填上。**必顶在通用 run 登记之前**：那个入口会拿
    // `nowMs` 当起跑时刻，而历史帧根本不知道什么时候起跑（假出一个「上次 run 00:00」）。
    // `startedAt = null` ⇒ 界面不出时长；`endedAt = nowMs` ⇒ 它进空闲态那一栏，不是「运行中」。
    // 回放按 seq 升序，所以最后一条就是累计量最大的那一条（后面的轮盖住前面的，不会回退）。
    if (historyUsageOnly) {
      // 本页正在跟踪一个**还活着**的 run 时，别的 run 的历史帧不得抢登记（刷新后历史补拉与实时帧同屏）。
      if (state.runId !== null && state.endedAt === null && rid !== null && rid !== state.runId) return;
      if (rid !== null && rid !== state.runId) beginRun(rid, null);
      if (state.runId === null) return;
      state.endedAt = nowMs;
      // 实时 `run_end` 已经给过终态用量的，**不拿历史 `round_end` 盖掉**（前者是权威口径）；
      // 但历史帧之间要允许覆盖（回放按 seq 升序，后一条的累计量更大，不盖就是少报）。
      const historyUsage = readUsage(d.usage);
      if (historyUsage !== null && (state.usage === null || state.usageFromHistory)) {
        state.usage = historyUsage;
        state.usageFromHistory = true;
      }
      const historyWindow = readContextWindow(d.context_window);
      if (historyWindow !== null) state.contextWindow = historyWindow;
      return;
    }

    // 别的 run 的帧：正在跟踪一个活跃 run 时，迟到帧一律忽略（不串 run、不误判起跑）。
    if (rid !== null && rid !== state.runId) {
      if (state.runId !== null && state.endedAt === null) return;
      beginRun(rid, nowMs);
    }

    // 不知道 run 的帧（旧后端/无 run_id）不造 run：没有 run 就没有动量。
    if (state.runId === null) return;

    if (!NON_ACTIVITY_TYPES.has(type)) state.lastEventAt = nowMs;

    switch (type) {
      case 'round_start':
      case 'attempt':
      case 'recovering':
      case 'recovered':
        // 脏轮号不覆盖已知值（不拿「旧轮号冒充当前轮」，也不写 NaN）。
        if (typeof d.round === 'number' && Number.isFinite(d.round)) state.round = d.round;        // #425：这四个事件都发生在「刚把请求发出去」的时刻 ⇒ 相位 = 等 LLM。
        // 新一轮开始 ⇒ 上轮的用量不再是「本轮」（宁可不显，也不拿 N-1 轮的数冒充 N 轮）。
        state.roundUsage = null;
        state.roundUsageRound = null;
        enterPhase('awaiting_llm', nowMs);
        return;
      case 'usage': {
        // #425：单次 provider 调用的真值。同轮多次调用（续写/重试）累加到本轮；换轮则重置。
        const usage = readUsage(d.usage);
        const round = finiteOrNull(d.round);
        if (usage !== null) {
          if (state.roundUsageRound === null || round === null || state.roundUsageRound === round) {
            state.roundUsage = addUsage(state.roundUsage, usage);
          } else {
            state.roundUsage = usage;
          }
          if (round !== null) state.roundUsageRound = round;
        }
        // 上下文窗口：runner 的宿主侧 additive 字段。没带就保持已知值（同一 run 的窗口不会变），
        // 从不拿 0 盖掉已知值。
        const window = readContextWindow(d.context_window);
        if (window !== null) state.contextWindow = window;
        // 能拿到 usage = 上游已经回话了 ⇒ 不再是「等回音」。后面的 tool_use 会把相位接过去；
        // 没有工具调用时保持 awaiting_llm 也不并错（下一轮即将开始）——不自己造「收尾中」这种新相位。
        return;
      }
      case 'round_end':
        if (typeof d.round === 'number' && Number.isFinite(d.round)) state.round = d.round;
        // #425：引擎给的是**本 run 累计**真值（口径见 lib 层注释）；没有就不覆盖旧值。
        {
          const usage = readUsage(d.usage);
          if (usage !== null) state.runUsage = usage;
        }
        // `round_end` **不清**本轮用量：轮与轮之间有个空档，清了会让刚显示的「本轮 tokens」闪一下就没。
        // 重置放在下一个 `round_start`（那时才真的换了轮）。
        // 工具结果已全部返回、下一轮还没 `round_start`：这段空隙也是在等 LLM，不回到「未知」。
        enterPhase('awaiting_llm', nowMs);
        return;
      case 'assistant_delta': {
        const text = typeof d.text === 'string' ? d.text : '';
        if (text === '') return;
        state.outputChars += text.length;
        state.outputBytes += utf8ByteLength(text);
        state.samples.push({ t: nowMs, chars: state.outputChars });
        pruneSamples(nowMs);
        // 流在动 ⇒ 相位是「在收流」。进相位只在从别的相位切过来时重置计时（否则每秒重置，
        // 「已运行」永远停在 0s）。
        enterPhase('streaming', nowMs);
        return;
      }
      case 'reasoning_delta':
        // 推理增量同样证明「上游在回话」（不展示，但相位必须算 streaming）。
        enterPhase('streaming', nowMs);
        return;
      case 'tool_use':
        state.toolCount += 1;
        state.pendingTools += 1;
        // 工具在跑：把相位从「等 LLM」换成「等工具」，并记下工具名（文案用得上）。
        state.activeToolName = typeof d.name === 'string' && d.name !== '' ? d.name : state.activeToolName;
        enterPhase('tool_running', nowMs);
        return;
      case 'tool_result': {
        // 只有**真带了**有限时长才计入均值（缺失不伪装成 0ms，与 #283 同口径）。
        const dur = d.duration_ms;
        if (typeof dur === 'number' && Number.isFinite(dur) && dur >= 0) {
          state.toolDurTotalMs += dur;
          state.toolDurCount += 1;
        }
        state.pendingTools = Math.max(0, state.pendingTools - 1);
        if (state.pendingTools === 0) {
          // 全部工具已交差 ⇒ 下一个动作一定是「把结果发回模型并等回音」。
          state.activeToolName = null;
          enterPhase('awaiting_llm', nowMs);
        }
        return;
      }
      default:
        return;
    }
  }

  /** 进相位：只有**从别的相位切过来**才重置计时（同相位内重复事件不得把秒数抹回 0）。 */
  function enterPhase(phase: RunPhase, nowMs: number): void {
    if (state.phase !== phase) {
      state.phase = phase;
      state.phaseAt = nowMs;
    }
  }

  return { state, ingest, beginRun, reset };
}

export interface RunMomentumHandle {
  view: ComputedRef<RunMomentumView>;
  /** 立即重算「现在」（测试/需要同步刷新的场景用；正常靠 1s tick）。 */
  tick: () => void;
}

/**
 * 组件侧：1s 时钟 + 派生视图。
 * 定时器**必须在卸载时清**（工单验收 ⑥）：本函数自己注册 `onUnmounted`，调用方不必记得。
 * 注：调用点必须在组件 `setup` 内（`onMounted`/`onUnmounted` 需要组件实例）。
 */
export function useRunMomentum(
  feed: RunMomentumFeed,
  opts: { now?: () => number; intervalMs?: number } = {},
): RunMomentumHandle {
  const nowFn = opts.now ?? (() => Date.now());
  const nowMs = ref(nowFn());
  let timer: ReturnType<typeof setInterval> | null = null;

  function tick(): void {
    nowMs.value = nowFn();
  }

  onMounted(() => {
    timer = setInterval(tick, opts.intervalMs ?? RUN_MOMENTUM_TICK_MS);
  });

  onUnmounted(() => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  });

  return {
    view: computed<RunMomentumView>(() => deriveMomentumView(feed.state, nowMs.value)),
    tick,
  };
}
