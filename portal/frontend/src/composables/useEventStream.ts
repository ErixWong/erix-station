// SSE 链路 composable：portal/static/index.html 内联 JS 的 connectEvents / handleEvent /
// resyncEvents **逐行平移**（issue #61 P2，协议语义不许变；§5.1 合法空洞 / §5.2 补发 / §5.3 向后兼容）。
//
// 平移要点（与旧版逐条对应）：
//   * 原生 EventSource + 具名事件分发（全集见 EVENT_TYPES，含 round_end/usage/reasoning_delta
//     等「接收但不展示」的类型——它们注册监听以推进水位线）；
//   * `?last_event_id=<seq>` 续传；lastSeq 只对合法数字推进（Math.max），不做跳号启发式——
//     messages 与 run_events 共用 chat_sessions.last_seq 分配器，事件流单独看存在合法空洞
//     （user 消息/assistant 回写各占一个 seq），跳号判定会无限重连（实测复现，§5.1）；
//   * resync 控制帧 → 主动断开 + 带 lastSeq 重连（服务端补发 seq > last_event_id 收敛，§5.2）；
//   * 陈旧连接事件忽略（es !== S.es 守卫）：重连后旧连接可能还有在途帧，防重复渲染/重复推进水位；
//   * 畸形 JSON 忽略（§5.3）；run_end 仅当 d.run_id === activeRunId 才参与运行态状态机
//     （历史重放的旧 run_end 不得误关当前 run 的停止按钮/误拉刷新）。
//
// 展示层的 sep/syserr/终稿回写通过 hooks 交给宿主（workbench store）：本 composable 只拥有
// 协议状态（es/lastSeq/esSessionId/activeRunId/deltaText/toolCards）与事件语义。
import { reactive, ref } from 'vue';

// 具名事件全集（旧 connectEvents 的数组原样，顺序不变）。
const EVENT_TYPES = [
  'round_start', 'round_end', 'attempt', 'recovering', 'recovered', 'usage',
  'tool_use', 'tool_result', 'assistant_delta', 'reasoning_delta',
  'tool_call_delta', 'judge', 'compaction', 'final_guard', 'forced_final',
  'run_end', 'ping', 'resync',
] as const;

// issue #42：run_end 分级文案的异常终止集合（end_turn 之外的正常/未知原因保持灰色中性）。
export const RUN_FAIL_REASONS = new Set(['failed', 'max_rounds_cap', 'aborted']);

export interface ToolCardState {
  name: string;
  dig: string;
  args: string;
  ok: boolean | null; // null = 尚无结果；true/false = tool_result 回填
  out: string;
  // issue #85：tool_result 的 duration_ms 原值（可选，tool_result 回填），卡片头部耗时显示用；
  // out 文案的拼接语义不变。
  dur?: number;
}

export interface RunEndPayload {
  run_id?: string;
  termination?: { reason?: string } | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  error?: { code?: string; message?: string } | null;
}

export interface EventStreamHooks {
  /** roundsep / 系统分隔行（judge/compaction/run_end 灰色文案等）。 */
  onSep: (text: string) => void;
  /** .syserr 红色错误行（RUN_FAIL_REASONS / run 失败信封）。 */
  onSysErr: (text: string) => void;
  /** 工具卡片**首次创建**时通知宿主（宿主负责在消息流中占位，保持插入顺序）。 */
  onToolCardCreated: (callId: string) => void;
  /** 当前 run 的 run_end（通知 + 终稿回写在宿主侧做：notifyRunEnd / refreshSession）。 */
  onCurrentRunEnd: (d: RunEndPayload & Record<string, unknown>) => void;
}

// dig 摘要：对象 → JSON 截 120 字；其余 → String 截 120（旧 toolCard 原样）。
function digText(input: unknown): string {
  return (typeof input === 'object' ? JSON.stringify(input ?? {}) : String(input ?? '')).slice(0, 120);
}

export function useEventStream(hooks: EventStreamHooks) {
  // ---- 协议状态（旧 S 的 SSE 相关字段；es 非响应式，等价旧 S.es 引用比较）----
  const lastSeq = ref(0);
  const esSessionId = ref<string | null>(null);
  const activeRunId = ref<string | null>(null);
  // 流式增量气泡文本（旧 S.deltaBuf 指向的 DOM 的 textContent；null = 无活动气泡）。
  // round_start 只置 null（旧版不 remove 元素——半截增量留在流里）；当前 run_end 才移除。
  const deltaText = ref<string | null>(null);
  // callId 去重的工具卡片状态（旧 S.toolCards）。
  const toolCards = reactive(new Map<string, ToolCardState>());
  let es: EventSource | null = null;

  function closeEs() {
    if (es) { es.close(); es = null; }
  }

  // §5.2：带 ?last_event_id=<seq> 重连 → 服务端补发 seq > last_event_id 的事件；
  // 无参 = 首连不补发历史。
  function connect(id: string, lastEventId: number | null = null) {
    const q = lastEventId != null ? `?last_event_id=${encodeURIComponent(lastEventId)}` : '';
    const conn = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events${q}`);
    es = conn;
    esSessionId.value = id;
    conn.onmessage = () => {}; // 具名事件分发
    for (const type of EVENT_TYPES) {
      // 陈旧连接的事件一律忽略（重连后旧连接可能还有在途帧，防重复渲染/重复推进水位线）。
      conn.addEventListener(type, (e) => { if (es !== conn) return; handleEvent(type, e); });
    }
    conn.onerror = () => { /* EventSource 自动重连，带 Last-Event-ID */ };
  }

  // 需重同步（仅由服务端 `resync` 控制帧触发，如补发前缓冲溢出）：主动断开 +
  // 带 ?last_event_id=<本地已知最大 seq> 重连，由服务端补发收敛（§5.2）。
  // 注：**不**做客户端「seq 跳号 → 重连」启发式（§5.1 合法空洞，见文件头注记）。
  function resyncEvents(why: string) {
    const id = esSessionId.value ?? undefined;
    if (!id) return;
    hooks.onSep(`事件流需重同步（${why}），正在重连补发…`);
    closeEs();
    connect(id, lastSeq.value);
  }

  // toolCard 语义：callId 去重；首次创建时占渲染位并返回状态（旧版返回 DOM，这里返回状态对象）。
  function toolCard(callId: string, name: string | null | undefined, input: unknown): ToolCardState {
    const existing = toolCards.get(callId);
    if (existing) return existing;
    const card: ToolCardState = { name: name ?? 'tool', dig: digText(input), args: '', ok: null, out: '' };
    toolCards.set(callId, card);
    hooks.onToolCardCreated(callId);
    return card;
  }

  function handleEvent(type: string, e: MessageEvent) {
    let d: Record<string, any>;
    try { d = e.data ? JSON.parse(e.data) : {}; } catch { return; } // 畸形事件忽略（§5.3）
    if (type === 'resync') {
      resyncEvents(d.reason === 'buffer_overflow' ? '服务端缓冲溢出' : (d.reason ?? 'resync'));
      return;
    }
    // 实现注记（§5.1）：事件流 seq 有合法空洞（messages 占号），故**不做**跳号重连判定；
    // 这里只推进本地水位线（resync 重连时作为 ?last_event_id 回放游标）。
    if (typeof d.seq === 'number') lastSeq.value = Math.max(lastSeq.value, d.seq);
    switch (type) {
      case 'ping': return;
      case 'round_start':
        if (deltaText.value) { deltaText.value = null; }
        hooks.onSep(`round ${d.round}`); return;
      case 'attempt': hooks.onSep(`round ${d.round} · 尝试 ${d.attempt}/${d.maxAttempts}`); return;
      case 'recovering': hooks.onSep(`重试中（${d.attempt}/${d.maxAttempts}）`); return;
      case 'recovered': hooks.onSep('重试成功'); return;
      case 'assistant_delta':
        if (deltaText.value === null) deltaText.value = '';
        deltaText.value += d.text ?? '';
        return;
      case 'reasoning_delta': return; // 推理增量 P1 不展示
      case 'tool_call_delta': {
        if (d.tool_call_id) {
          const card = toolCard(d.tool_call_id, d.name ?? '', '（参数流式生成中…）');
          card.args = card.args + (d.arguments_delta ?? '');
        }
        return;
      }
      case 'tool_use': {
        const card = toolCard(d.tool_call_id, d.name, d.input);
        card.args = typeof d.input === 'object' ? JSON.stringify(d.input ?? {}) : String(d.input ?? '');
        return;
      }
      case 'tool_result': {
        const card = toolCards.get(d.tool_call_id);
        if (card) {
          card.ok = !!d.ok;
          card.dur = d.duration_ms ?? 0;
          card.out = `${d.ok ? '✓' : '✗'} ${d.result_digest ?? ''}（${d.duration_ms ?? 0}ms）`;
        }
        return;
      }
      case 'judge': {
        // 0.9.0 引擎载荷（已对源码核实）：extend/extendReason/plan 在 d.decision 内
        // （orchestrator round judge）；passThrough 挂在 intercept 类事件上
        // （checkpoint-executor，action='executed' + passThrough='on_track'|'readonly'）。
        const dec = d.decision ?? {};
        if (d.passThrough) { hooks.onSep(`judge：放行（${d.passThrough}）`); return; }
        if (dec.extend === true) {
          hooks.onSep(`judge：扩轮${dec.plan ? ' — ' + String(dec.plan).slice(0, 80) : ''}${dec.extendReason ? '（' + String(dec.extendReason).slice(0, 60) + '）' : ''}`);
          return;
        }
        if (dec.extend === false) {
          hooks.onSep(`judge：不扩轮${dec.extendReason ? ' — ' + String(dec.extendReason).slice(0, 80) : ''}`);
          return;
        }
        if (d.kind === 'intercept' || d.action) {
          hooks.onSep(`judge：${d.action ?? ''}${dec.reason ? ' — ' + dec.reason : ''}`);
        }
        return;
      }
      // 0.9.0 新事件类型（issue #43）：compaction = 上下文折叠（详情在 d.compaction，
      // orchestrator recordCompactionStat）；final_guard = 终稿核验（action ∈ accept/skip/
      // revise/degraded/error）；forced_final = 最后一轮强制无 tools 文本终稿（termination.js）。
      // 仅状态行展示，不参与运行态状态机。
      case 'compaction': {
        const c = d.compaction ?? {};
        hooks.onSep(`上下文折叠（round ${d.round}）：${c.foldedRounds ?? 0} 轮折叠，${c.tokensBefore ?? '?'} → ${c.tokensAfter ?? '?'} tokens`);
        return;
      }
      case 'final_guard': hooks.onSep(`final guard：${d.action ?? 'unknown'}${d.reason ? ` — ${d.reason}` : ''}`); return;
      case 'forced_final': hooks.onSep(`forced final（round ${d.round}）：${d.reason ?? ''}`); return;
      case 'usage': return;
      case 'run_end': {
        // 历史重放的旧 run_end 不参与运行态状态机（防误关当前 run 的停止按钮/误拉刷新）。
        const isCurrent = d.run_id === activeRunId.value;
        if (isCurrent) {
          // 移除流式增量气泡（终稿由 refreshSession 回写，防双份）。
          if (deltaText.value !== null) deltaText.value = null;
          const reason = d.termination?.reason ?? '';
          const usage = d.usage ? ` · tokens ${d.usage.input_tokens ?? 0}+${d.usage.output_tokens ?? 0}` : '';
          // issue #42：终止原因分级——failed/max_rounds_cap/aborted 红色告警，end_turn 灰色中性。
          if (RUN_FAIL_REASONS.has(reason)) hooks.onSysErr(`run 结束：${reason}${usage}`);
          else hooks.onSep(`run 结束：${reason === 'end_turn' ? '正常完成' : reason}${usage}`);
          if (d.error) hooks.onSysErr(`run 失败：${d.error.code} — ${d.error.message}`);
          activeRunId.value = null;
          hooks.onCurrentRunEnd(d);
        }
        return;
      }
      default: return; // 未知类型忽略（§5.3 向后兼容）
    }
  }

  // 离开会话/项目时的协议状态复位（旧 switchProject / openSession / resetSessionView 内联段）。
  function resetStreamState() {
    closeEs();
    lastSeq.value = 0;
    activeRunId.value = null;
    deltaText.value = null;
    toolCards.clear();
    esSessionId.value = null;
  }

  return {
    lastSeq, esSessionId, activeRunId, deltaText, toolCards,
    connect, closeEs, resetStreamState,
    // handleEvent/toolCard 导出仅为单测驱动（旧版 static-client.test.js 的 vm 直驱等价）。
    handleEvent, toolCard,
  };
}
