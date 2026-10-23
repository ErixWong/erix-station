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
import { computed, onMounted, onUnmounted, reactive, ref, type ComputedRef } from 'vue';
import {
  createEmptyMomentumState,
  deriveMomentumView,
  TPS_WINDOW_MS,
  utf8ByteLength,
  type RunMomentumState,
  type RunMomentumView,
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
    if (history) return;
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
      state.usage = readUsage(d.usage);
      return;
    }

    // 别的 run 的迟到帧：正在跟踪一个活跃 run 时一律忽略（不串 run、不误判起跑）。
    if (rid !== null && rid !== state.runId) {
      if (state.runId !== null && state.endedAt === null) return;
      beginRun(rid, nowMs);
    }
    // 不知道 run 的帧（旧后端/无 run_id）不造 run：没有 run 就没有动量。
    if (state.runId === null) return;

    if (!NON_ACTIVITY_TYPES.has(type)) state.lastEventAt = nowMs;

    switch (type) {
      case 'round_start':
      case 'round_end':
      case 'attempt':
      case 'recovering':
      case 'recovered':
        // 脏轮号不覆盖已知值（不拿「旧轮号冒充当前轮」，也不写 NaN）。
        if (typeof d.round === 'number' && Number.isFinite(d.round)) state.round = d.round;
        return;
      case 'assistant_delta': {
        const text = typeof d.text === 'string' ? d.text : '';
        if (text === '') return;
        state.outputChars += text.length;
        state.outputBytes += utf8ByteLength(text);
        state.samples.push({ t: nowMs, chars: state.outputChars });
        pruneSamples(nowMs);
        return;
      }
      case 'tool_use':
        state.toolCount += 1;
        return;
      case 'tool_result': {
        // 只有**真带了**有限时长才计入均值（缺失不伪装成 0ms，与 #283 同口径）。
        const dur = d.duration_ms;
        if (typeof dur === 'number' && Number.isFinite(dur) && dur >= 0) {
          state.toolDurTotalMs += dur;
          state.toolDurCount += 1;
        }
        return;
      }
      default:
        return;
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
