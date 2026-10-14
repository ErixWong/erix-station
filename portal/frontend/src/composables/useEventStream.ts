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
import { i18n } from '../i18n';
import { PERSISTENCE_TERMINATION_REASON, RUN_FAIL_REASONS } from '../lib/terminationReasons';
import { getToolResultSummary, formatDuration } from '../lib/toolSummary';

// 用户可见状态行/错误行文案（issue #101 P2）：非组件上下文（composable 无 setup 实例）→ i18n.global.t。
// 取词即快照：状态行在事件到达时生成，切语言后旧行不回溯翻译（可接受）。
// 注：纯英文/emoji 片段（`round 3`、` · tokens 1+2`、'tool'、'resync' 标识符）不属中文文案，保持原样。
const t = i18n.global.t;

// 具名事件全集（旧 connectEvents 的数组原样，顺序不变）。
const EVENT_TYPES = [
  'round_start', 'round_end', 'attempt', 'attempt_killed', 'recovering', 'recovered', 'usage',
  'tool_use', 'tool_result', 'assistant_delta', 'reasoning_delta',
  'tool_call_delta', 'judge', 'compaction', 'final_guard', 'forced_final',
  'run_end', 'session_updated', 'ping', 'resync', // issue #88：session_updated = 自动标题刷新（live-only，不落 run_events）
] as const;

// issue #42：run_end 分级文案的异常终止集合（end_turn 之外的正常/未知原因保持灰色中性）。
// issue #212：集合本体（含补入的 persistence_failed / final_guard_unverified）收敛到
// `lib/terminationReasons.ts` 单一常量（文档防漂移测试的锚点）；此处 re-export 保留既有引用面
// —— stores/workbench.ts 的 notifyRunEnd 与本文件用的是**同一个 Set 实例**，不存在第二份枚举。
export { RUN_FAIL_REASONS };

// issue #89：历史回放（刷新后重建展示层，对齐 pi-web「转录即真相」）可回放的展示类事件白名单——
// 与后端 GET /api/sessions/:id/events/history 的下发白名单一致。运行态语义事件（run_end/usage/
// 增量流等）不在其列：历史回放绝不驱动运行态状态机（停止按钮/run 状态/终态刷新）。
const HISTORY_REPLAY_TYPES = new Set([
  'tool_use', 'tool_result', 'tool_call_delta', 'judge',
  'round', 'round_start', 'round_end', 'attempt', 'recovering', 'recovered',
  'compaction', 'final_guard', 'forced_final',
  // issue #288（缺陷 B）：宿主在 release-requeue 分支合成的「attempt 被杀并重排」事件；
  // 与后端 `http.js` 的 HISTORY_EVENT_TYPES 同步加，否则「实时有、刷新后没」。
  'attempt_killed',
]);

/** issue #89：run_events 历史端点的事件项（REST 形状，与 SSE data 展开后同构）。 */
export interface RunHistoryEvent {
  seq: number;
  run_id: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export interface ToolCardState {
  name: string;
  dig: string;
  args: string;
  ok: boolean | null; // null = 尚无结果；true/false = tool_result 回填
  out: string;
  // issue #85：tool_result 的 duration_ms 原值（可选，tool_result 回填），卡片头部耗时显示用；
  // out 文案的拼接语义不变。
  // issue #283：**undefined = 没有时长**（引擎没给 / 旧数据 NULL），卡片只出 ✓/✗——绝不拿 0 冒充。
  // 两个来源：实时/历史 `tool_result` 事件，以及投影路径 DTO 的宿主字段 `durationMs`
  //（`projectToolCard` 只在它为空的时侯填，实时值优先）。单位换算在 `lib/toolSummary.formatDuration`。
  dur?: number;
  // issue #188：DTO 投影来源的卡片字段（加载/刷新路径）——直接透传上游 `toolCalls[]` 同名键，
  // 事件流路径不填。argsSummary = 上游 120 字参数摘要；resultPreview = 上游 400 字结果预览；
  // executionStatus = 上游执行状态串。全文在 DTO `blocks` 里（不在卡片展开区重建）。
  // issue #228：存进来的一律是 `getToolResultSummary` 归一后的**字符串**（上游三套返回形态在
  // 入口就收敛掉，number 0 也不会被 `!!part` 判空吞掉）。
  argsSummary?: string;
  resultPreview?: string;
  executionStatus?: string;
}

/**
 * issue #212：引擎 termination 形状。worker 现按原样透传引擎挂在错误上的对象，
 * 故除 `reason`/`detail` 外，`persistence_failed` 还会带 `operation`/`phase`/`sideEffect`
 * （erix-agent orchestrator.js:758-771）；未知/额外键按 §5.3 向后兼容原则忽略。
 */
export interface RunTermination {
  reason?: string;
  detail?: string;
  operation?: string;
  phase?: string;
  sideEffect?: string;
  // issue #261（erix-agent 0.18.0 additive 字段，上游 #176）：**仅** `reason === "failed"` 的终局
  // 额外带该键 —— 引擎把错误上已有的分类码（timeout / rate_limited / auth / server /
  // checkpoint_failed / …）原样透出，无分类码时引擎回落 `unknown`（docs/api/portal.md §4.1/§5.3、
  // docs/data/model.md §1.7）。**值域由引擎定义**：前端不解释语义、不维护第二份枚举、不参与
  // RUN_FAIL_REASONS 判定，只做失败横幅的原样透出（failReasonText）。
  errorCode?: string;
}

export interface RunEndPayload {
  run_id?: string;
  termination?: RunTermination | null;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
}

/**
 * issue #212：失败原因的**用户可读补充**（拼进 `stream.event.runEnd` 的 `{reason}` 槽）。
 *   ① 只给本次新增的两值加双语标签——既有 failed / aborted / max_rounds_cap 逐字保持原样
 *      （不改既有中文基线与既有断言面）；
 *   ② `persistence_failed` 额外带引擎透传的落盘细节（operation/phase/sideEffect），
 *      让工作台能看见「哪一步没落盘、副作用是否可能已发生」——这是该 reason 语义最重的部分；
 *   ③ issue #261：`termination.errorCode`（0.18.0 additive，值域由引擎定义）以
 *      `（code=<errorCode>）` 追加在文案**末尾**，让 R-2 那类「provider 超时杀 run」在横幅上直接
 *      看见 `code=timeout` 而不用去翻日志/问后端。**仅当它是非空字符串时**才追加，无 errorCode 时
 *      文案与既有断言面逐字不变；该片段是技术细节，**不进 i18n**（中英界面同形）。
 */
function failReasonText(reason: string, termination?: RunTermination | null): string {
  let text = reason;
  const label = reason === 'persistence_failed'
    ? t('stream.event.runEndReason.persistence_failed')
    : reason === 'final_guard_unverified'
      ? t('stream.event.runEndReason.final_guard_unverified')
      : '';
  if (label) text += t('stream.event.dash', { value: label });
  if (reason === PERSISTENCE_TERMINATION_REASON && termination?.phase) {
    text += ` · ${t('stream.event.runEndPersistence', {
      operation: termination.operation ?? '?',
      phase: termination.phase,
      sideEffect: termination.sideEffect ?? '?',
    })}`;
  }
  // issue #261：typeof + 非空双重判定——后端 additive 字段，旧 run / 旧引擎 / 显式 null 都要
  // 落回「文案零变化」，不能让 `（code=undefined）` 这种字样渗进用户可见文案。
  const code = termination?.errorCode;
  if (typeof code === 'string' && code !== '') text += `（code=${code}）`;
  return text;
}

/**
 * issue #288（缺陷 B）：`attempt_killed` 的「原因」文本——payload 是**宿主自己合成的**（不是引擎透传），
 * 口径见 docs/api/portal.md §5.3 第 14 行：`killed_by` 只有 `watchdog` / `crash` 两个合法值，
 * 但它是 additive 字段 ⇒ 未知值/缺失/对象都得退化（照 #261 的 `errorCode` 口径：typeof 守卫，
 * 绝不 `String(对象)` 把 `[object Object]` 渗进用户可见文案）。未知时退到 release 的 `reason` 原文
 * （运维排查就靠它），两者都没 ⇒ 走「未知原因」文案。
 */
const ATTEMPT_KILLED_CAUSE_KEYS: Record<string, string> = {
  watchdog: 'stream.event.attemptKilledCause.watchdog',
  crash: 'stream.event.attemptKilledCause.crash',
};

function attemptKilledCauseText(killedBy: unknown, reason: unknown): string {
  const key = typeof killedBy === 'string' ? ATTEMPT_KILLED_CAUSE_KEYS[killedBy] : undefined;
  if (key) return t(key);
  return typeof reason === 'string' && reason !== '' ? reason : t('stream.event.attemptKilledUnknown');
}

export interface EventStreamHooks {
  /** roundsep / 系统分隔行（judge/compaction/run_end 灰色文案等；judge 事件带 variant='judge'，由面板样式高亮）。 */
  onSep: (text: string, variant?: 'judge') => void;
  /** .syserr 红色错误行（RUN_FAIL_REASONS / run 失败信封）。 */
  onSysErr: (text: string) => void;
  /** 工具卡片**首次创建**时通知宿主（宿主负责在消息流中占位，保持插入顺序）。 */
  onToolCardCreated: (callId: string) => void;
  /** 当前 run 的 run_end（通知 + 终稿回写在宿主侧做：notifyRunEnd / refreshSession）。 */
  onCurrentRunEnd: (d: RunEndPayload & Record<string, unknown>) => void;
  /** EventSource 首次连通或自动重连恢复时，供宿主与服务端会话运行态对账。 */
  onConnected?: (sessionId: string) => void;
  /** issue #88：自动标题刷新（portal run 终态后异步评估、经 session SSE 推送）——宿主原地更新列表项。 */
  onSessionUpdated?: (d: { session_id?: string; title?: string } & Record<string, unknown>) => void;
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
    conn.onopen = () => { if (es === conn) hooks.onConnected?.(id); };
    conn.onerror = () => { /* EventSource 自动重连，带 Last-Event-ID */ };
  }

  // 需重同步（仅由服务端 `resync` 控制帧触发，如补发前缓冲溢出）：主动断开 +
  // 带 ?last_event_id=<本地已知最大 seq> 重连，由服务端补发收敛（§5.2）。
  // 注：**不**做客户端「seq 跳号 → 重连」启发式（§5.1 合法空洞，见文件头注记）。
  function resyncEvents(why: string) {
    const id = esSessionId.value ?? undefined;
    if (!id) return;
    hooks.onSep(t('stream.event.resync', { why }));
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

  /**
   * issue #188：DTO 投影工具卡片登记（加载/刷新路径）。与实时/历史事件路径**共用同一** `toolCards`
   * Map 与 `onToolCardCreated` 占位 → 两条路收敛到 StreamPanel 同一渲染；同一 callId 幂等
   * （事件流先建时只补全投影才有的字段，不重复占位）。callId 由宿主给出：优先上游 provider `id`
   *（与实时 `tool_call_id` 同源 → 天然归并），缺失时用宿主合成的稳定键（见 workbench.ts，上游 #100）。
   */
  function projectToolCard(callId: string, fields: {
    name: string;
    argsSummary?: string;
    // issue #228：上游 DTO 理论上给 string，但工具结果本体有三套形态（string / {content, metadata} /
    // number），这里按 `unknown` 收并在入口归一，不把「上游保证给字符串」当成依赖。
    resultPreview?: unknown;
    isError?: boolean;
    executionStatus?: string;
    // issue #283：宿主从自家 `tool_calls` join 进 DTO 的耗时（**不是**引擎投影字段，来源见
    // `portal/src/session-view.js#attachToolCallDurations`）。只在卡片现有 `dur` 为空时填——
    // 实时路已拿到的值不许被投影覆盖（两路同 callId 归并时以实时为准）。
    durationMs?: number;
  }) {
    // 有预览字段 = 归一后仍不为 undefined；归一后的文本另存（number/null 到卡片里就是合法展示串）。
    const hasPreview = fields.resultPreview !== undefined;
    const resultPreview = hasPreview ? getToolResultSummary(fields.resultPreview) : undefined;
    // issue #283：库里可能是 NULL（旧数据引擎当年就没发时长）⇒ 不收，也不拿 0 冒充有时长。
    const projectedDur = Number.isFinite(fields.durationMs) ? (fields.durationMs as number) : undefined;
    const existing = toolCards.get(callId);
    if (existing) {
      // 事件流先建：只补投影才有的摘要/预览/状态，不覆盖实时路径已有的完整数据。
      if (fields.argsSummary !== undefined && existing.argsSummary === undefined) existing.argsSummary = fields.argsSummary;
      if (resultPreview !== undefined && existing.resultPreview === undefined) existing.resultPreview = resultPreview;
      if (fields.executionStatus !== undefined && existing.executionStatus === undefined) existing.executionStatus = fields.executionStatus;
      // issue #283：刷新后不丢时长——但**只在实时路没给过的时候**用投影值（已有值优先）。
      if (projectedDur !== undefined && existing.dur == null) existing.dur = projectedDur;
      if (existing.ok === null && (fields.isError !== undefined || hasPreview || fields.executionStatus !== undefined)) {
        existing.ok = fields.isError !== true;
      }
      return;
    }
    const hasResult = fields.isError !== undefined || hasPreview || fields.executionStatus !== undefined;
    const card: ToolCardState = {
      name: fields.name,
      dig: fields.argsSummary ?? '',
      args: '',
      ok: hasResult ? fields.isError !== true : null,
      out: '',
      argsSummary: fields.argsSummary,
      resultPreview,
      executionStatus: fields.executionStatus,
    };
    // 没有时长就**不写这个键**（不塞 `dur: undefined` 占位），与 M1 的「缺失保持 undefined」同口径。
    if (projectedDur !== undefined) card.dur = projectedDur;
    toolCards.set(callId, card);
    hooks.onToolCardCreated(callId);
  }

  function handleEvent(type: string, e: MessageEvent) {
    let d: Record<string, any>;
    try { d = e.data ? JSON.parse(e.data) : {}; } catch { return; } // 畸形事件忽略（§5.3）
    if (type === 'resync') {
      resyncEvents(d.reason === 'buffer_overflow' ? t('stream.event.resyncBufferOverflow') : (d.reason ?? 'resync'));
      return;
    }
    dispatch(type, d);
  }

  /**
   * issue #89：历史 run_events 回放（GET /api/sessions/:id/events/history 的响应项，
   * 与 SSE data 展开后同构）。history 模式红线：
   *   * 只走展示分支（tool 卡片 / sep / syserr），产出与实时**同一渲染路径**（toolCards Map +
   *     onToolCardCreated 占位 + StreamPanel）；
   *   * 不推进水位线（openSession 已按 detail.last_seq 初始化；回放事件 seq ≤ 该值）；
   *   * run_end 强制短路——绝不触发 onCurrentRunEnd / refreshSession / 停止按钮状态机。
   */
  function replayEvent(raw: RunHistoryEvent) {
    if (!HISTORY_REPLAY_TYPES.has(raw.type)) return;
    dispatch(raw.type, { seq: raw.seq, run_id: raw.run_id, ...(raw.payload ?? {}) }, true);
  }

  function dispatch(type: string, d: Record<string, any>, history = false) {
    // 实现注记（§5.1）：事件流 seq 有合法空洞（messages 占号），故**不做**跳号重连判定；
    // 这里只推进本地水位线（resync 重连时作为 ?last_event_id 回放游标）；历史回放不推进。
    if (typeof d.seq === 'number' && !history) lastSeq.value = Math.max(lastSeq.value, d.seq);
    switch (type) {
      case 'ping': return;
      case 'session_updated':
        // issue #88：标题是会话元数据而非时间线事件（live-only 帧，无 seq）；只更新列表项，不进消息流。
        hooks.onSessionUpdated?.(d);
        return;
      case 'round_start':
        if (deltaText.value) { deltaText.value = null; }
        hooks.onSep(`round ${d.round}`); return;
      case 'attempt':
        hooks.onSep(t('stream.event.attempt', { round: d.round, attempt: d.attempt, max: d.maxAttempts }));
        return;
      case 'attempt_killed': {
        // issue #288（缺陷 B）：worker 被宿主杀掉并重排（F6 执行期静默 watchdog / 非预期退出）。
        // payload 由 portal 在 release-requeue 分支合成（portal.md §5.3）：{attempt, max_attempts,
        // reason, killed_by, silent_ms?}。不新增任何 UI 结构：与 attempt/recovering 同一个 onSep 分隔行。
        const attempt = Number.isFinite(d.attempt) ? d.attempt : '?';
        const max = Number.isFinite(d.max_attempts) ? d.max_attempts : '?';
        // silent_ms：**没给就不写这一段**（不拿 0 冒充「静默了 0ms」，也不留空括号，与 #283 同口径）。
        const silentOk = Number.isFinite(d.silent_ms) && (d.silent_ms as number) >= 0;
        hooks.onSep(t('stream.event.attemptKilled', {
          attempt,
          max,
          cause: attemptKilledCauseText(d.killed_by, d.reason),
          silent: silentOk
            ? t('stream.event.attemptKilledSilent', { dur: formatDuration(d.silent_ms as number) })
            : '',
        }));
        return;
      }
      case 'recovering':
        hooks.onSep(t('stream.event.recovering', { attempt: d.attempt, max: d.maxAttempts }));
        return;
      case 'recovered': hooks.onSep(t('stream.event.recovered')); return;
      case 'assistant_delta':
        if (deltaText.value === null) deltaText.value = '';
        deltaText.value += d.text ?? '';
        return;
      case 'reasoning_delta': return; // 推理增量 P1 不展示
      case 'tool_call_delta': {
        if (d.tool_call_id) {
          const card = toolCard(d.tool_call_id, d.name ?? '', t('stream.argsStreaming'));
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
          // issue #283：只有事件**真带了**有限时长才写 `card.dur`，缺失就保持 `undefined`（卡片据此
          // 不渲染时长）。旧写法 `d.duration_ms ?? 0` 把「引擎没给」伪装成 0，就是「恒显 0s」的
          // 前端共犯；同时也不拿 null/字符串冒充时长。已有值不被「无时长事件」覆写（实时与历史
          // 重放、投影回填同一路径上都成立，与 M3 的「实时优先」同一口径）。
          const durMs = Number.isFinite(d.duration_ms) ? (d.duration_ms as number) : undefined;
          if (durMs !== undefined) card.dur = durMs;
          const mark = d.ok ? '✓' : '✗';
          // issue #228：result_digest 的理论形状是字符串，但工具结果有三套形态（string /
          // {content, metadata} / number）——入口归一后「writeFile 写了 0 字节」也能正常展示，
          // `{content, metadata}` 则只展示 content（截断/跳过信息就在 content 的 marker 文本里）。
          const digest = getToolResultSummary(d.result_digest);
          // issue #283：没时长走「无时长」文案——不得出现 `0ms` / `undefined` / 空括号。
          card.out = durMs === undefined
            ? t('stream.event.toolResultNoDur', { mark, digest })
            : t('stream.event.toolResult', { mark, digest, dur: formatDuration(durMs) });
        }
        return;
      }
      case 'judge': {
        // 0.9.0 引擎载荷（已对源码核实）：extend/extendReason/plan 在 d.decision 内
        // （orchestrator round judge）；passThrough 挂在 intercept 类事件上
        // （checkpoint-executor，action='executed' + passThrough='on_track'|'readonly'）。
        const dec = d.decision ?? {};
        if (d.passThrough) { hooks.onSep(t('stream.event.judgePassThrough', { mode: d.passThrough }), 'judge'); return; }
        if (dec.extend === true) {
          hooks.onSep(t('stream.event.judgeExtend', {
            dash: dec.plan ? t('stream.event.dash', { value: String(dec.plan).slice(0, 80) }) : '',
            paren: dec.extendReason ? t('stream.event.paren', { value: String(dec.extendReason).slice(0, 60) }) : '',
          }), 'judge');
          return;
        }
        if (dec.extend === false) {
          hooks.onSep(t('stream.event.judgeNoExtend', {
            dash: dec.extendReason ? t('stream.event.dash', { value: String(dec.extendReason).slice(0, 80) }) : '',
          }), 'judge');
          return;
        }
        if (d.kind === 'intercept' || d.action) {
          hooks.onSep(t('stream.event.judgeAction', {
            action: d.action ?? '',
            dash: dec.reason ? t('stream.event.dash', { value: dec.reason }) : '',
          }), 'judge');
        }
        return;
      }
      // 0.9.0 新事件类型（issue #43）：compaction = 上下文折叠（详情在 d.compaction，
      // orchestrator recordCompactionStat）；final_guard = 终稿核验（action ∈ accept/skip/
      // revise/degraded/error）；forced_final = 最后一轮强制无 tools 文本终稿（termination.js）。
      // 仅状态行展示，不参与运行态状态机。
      case 'compaction': {
        const c = d.compaction ?? {};
        hooks.onSep(t('stream.event.compaction', {
          round: d.round,
          folded: c.foldedRounds ?? 0,
          before: c.tokensBefore ?? '?',
          after: c.tokensAfter ?? '?',
        }));
        return;
      }
      case 'final_guard':
        hooks.onSep(t('stream.event.finalGuard', {
          action: d.action ?? 'unknown',
          dash: d.reason ? t('stream.event.dash', { value: d.reason }) : '',
        }));
        return;
      case 'forced_final':
        hooks.onSep(t('stream.event.forcedFinal', { round: d.round, reason: d.reason ?? '' }));
        return;
      case 'usage': return;
      case 'run_end': {
        // issue #89 红线：历史回放的 run_end 一律短路——绝不驱动运行态状态机
        // （防误关当前 run 的停止按钮/误拉刷新）。实时路径保留「仅当前 run」守卫。
        if (history) return;
        const isCurrent = d.run_id === activeRunId.value;
        if (isCurrent) {
          // 移除流式增量气泡（终稿由 refreshSession 回写，防双份）。
          if (deltaText.value !== null) deltaText.value = null;
          const reason = d.termination?.reason ?? '';
          const usage = d.usage ? ` · tokens ${d.usage.input_tokens ?? 0}+${d.usage.output_tokens ?? 0}` : '';
          // issue #42：终止原因分级——异常集合红色告警，end_turn 灰色中性。
          // issue #212：集合补 persistence_failed / final_guard_unverified（两者语义都重到「用户必须看见」），
          // 且必须与「worker 透传引擎 reason」同一个 PR：先透传再扩集合，否则 persistence_failed
          // 会落到下面 else 分支，被渲染成灰色中性分隔条（语义最重的失败反而最弱）。
          if (RUN_FAIL_REASONS.has(reason)) {
            hooks.onSysErr(t('stream.event.runEnd', { reason: failReasonText(reason, d.termination), usage }));
          } else {
            hooks.onSep(t('stream.event.runEnd', {
              reason: reason === 'end_turn' ? t('stream.event.runEndNormal') : reason,
              usage,
            }));
          }
          if (d.error) hooks.onSysErr(t('stream.event.runFailed', { code: d.error.code, message: d.error.message }));
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
    // handleEvent/toolCard 导出仅为单测驱动（旧版 static-client.test.js 的 vm 直驱等价）；
    // replayEvent 供 openSession 历史归并回放驱动（issue #89）；projectToolCard 供 DTO 投影路径（#188）。
    handleEvent, toolCard, replayEvent, projectToolCard,
  };
}
