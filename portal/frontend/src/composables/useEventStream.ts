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
import { PERSISTENCE_TERMINATION_REASON, RUN_END_LABEL_REASONS, RUN_FAIL_REASONS, RUN_TERMINATION_SYSERR_REASONS } from '../lib/terminationReasons';
import { getToolResultSummary, formatDuration, isSpecialExecutionStatus } from '../lib/toolSummary';
import { eventRoundToken, runSegment, toolCardKey, UNKNOWN_ROUND_TOKEN } from '../lib/toolCardKey';

// 用户可见状态行/错误行文案（issue #101 P2）：非组件上下文（composable 无 setup 实例）→ i18n.global.t。
// 取词即快照：状态行在事件到达时生成，切语言后旧行不回溯翻译（可接受）。
// 注：纯英文/emoji 片段（`round 3`、` · tokens 1+2`、'tool'、'resync' 标识符）不属中文文案，保持原样。
const t = i18n.global.t;

// 具名事件全集（旧 connectEvents 的数组原样，顺序不变）。
const EVENT_TYPES = [
  'round_start', 'round_end', 'attempt', 'attempt_killed', 'recovering', 'recovered', 'usage',
  'tool_use', 'tool_result', 'assistant_delta', 'reasoning_delta',
  // issue #288（缺陷 C）：崩溃恢复时挂起工具**没被重放**（引擎 additive LoopEvent，仅
  // `replayPolicy: 'per-tool-declaration'` 下会发）。**实时具名监听**这一半：本数组是
  // EventSource 逐类型 `addEventListener` 的唯一来源（见下方 for 循环），漏加就是**实时一条都收不到**
  // （不报错、不警告，只是界面上始织不会提“没重放”）；与下面的 HISTORY_REPLAY_TYPES 是**两个坑**。
  'tool_replay_decision_required',
  'tool_call_delta', 'judge', 'compaction', 'final_guard', 'forced_final',
  'run_end', 'session_updated', 'ping', 'resync', // issue #88：session_updated = 自动标题刷新（live-only，不落 run_events）
  // issue #371-A：引擎落盘失败告警（erix-agent#461 起带 `fatal`）。本数组是 EventSource 逐类型
  // `addEventListener` 的唯一来源，漏加就是**实时一条都收不到**（不报错不警告）；与下面
  // HISTORY_REPLAY_TYPES 与 `http.js` 的 HISTORY_EVENT_TYPES 是三处独立存亡的集合（#288）。
  'persistence_error',
  // issue #370：输入队列快照（steer / follow_up 待发送）。**live-only、不落 run_events**
  // ⇒ 只进本数组，**绝不进** HISTORY_REPLAY_TYPES（它没有 seq、也没有历史行可回放；刷新后由
  // `GET /api/sessions/:id` 的 `session.queued_messages` 快照补齐）。漏加本数组 = 实时永远收不到。
  'queue_update',
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
  // issue #288（缺陷 C）：「挂起工具未重放」的**回放**这一半。与 `http.js` 的 HISTORY_EVENT_TYPES
  // 与上方 EVENT_TYPES 是**三处独立存亡的集合**（只加一边分别会「实时收不到」或「刷新后消失」，
  // 本分支已用变异逐条证明过），口径见 docs/api/portal.md §5.3 第 15 行与 AGENTS §8.22。
  'tool_replay_decision_required',
  // issue #371-A：与上面 `EVENT_TYPES` 与 `http.js` 的 `HISTORY_EVENT_TYPES` **同步**加（三处只加
  // 一边就分别得到「实时收不到」或「刷新后消失」）。它是展示类、不驱动运行态状态机：
  // 致命失败的红面仍然只由 `run_end`（`persistence_failed`）负责。
  'persistence_error',
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
  // issue #299（guide-0.20.0 §7）：这个字段**只在两种特殊状态下存在**（`intercepted`/`interrupted`），
  // 普通成功/失败的块上是**缺席**（不是空串、不是 `ok`）⇒ 不得拿「字段在不在」当「这块值得关注」的
  // 判据；下面需要「值得关注」的地方一律走 `isSpecialExecutionStatus(值)`（lib/toolSummary.ts）。
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
 *   ① 标签来源：`RUN_END_LABEL_REASONS`（除 `end_turn` 外的每个引擎 reason 一个 i18n 键，双语成对）。
 *      **issue #236 推翻了 #212 的「既有 failed / aborted / max_rounds_cap 逐字保持原样」**：那条口径的
 *      理由只是「不改既有中文基线与既有断言面」，而 #236 的验收面明确要求「用户按停止后看到的是母语
 *      文案，不是裸 `aborted`」；且本单把终态分隔条投影进历史后，任何 reason 都会在重开会话时上屏。
 *      未知 / 引擎新增的 reason **不在表里** ⇒ 仍逐字打印原文（§5.3 向后兼容，不编造翻译）。
 *   ② `persistence_failed` 额外带引擎透传的落盘细节（operation/phase/sideEffect），
 *      让工作台能看见「哪一步没落盘、副作用是否可能已发生」——这是该 reason 语义最重的部分；
 *   ③ issue #261：`termination.errorCode`（0.18.0 additive，值域由引擎定义）以
 *      `（code=<errorCode>）` 追加在文案**末尾**，让 R-2 那类「provider 超时杀 run」在横幅上直接
 *      看见 `code=timeout` 而不用去翻日志/问后端。**仅当它是非空字符串时**才追加，无 errorCode 时
 *      文案与既有断言面逐字不变；该片段是技术细节，**不进 i18n**（中英界面同形）。
 */
const RUN_END_REASON_LABEL_KEYS: Record<string, string> = Object.fromEntries(
  RUN_END_LABEL_REASONS.map((reason) => [reason, `stream.event.runEndReason.${reason}`]),
);

function runEndReasonText(reason: string, termination?: RunTermination | null): string {
  // `end_turn` 走既有的「正常完成」文案（不在标签表里，避免两条文案漂移）；
  // 其余有标签用标签，形状与 #212 一致：`<reason> — <标签>`（reason 原文保留作技术前缀，
  // 与 `errorCode` 同一种「技术细节留在行上」的口径；未知 reason 就只有 reason 本身）。
  let text = reason === 'end_turn' ? t('stream.event.runEndNormal') : reason;
  const labelKey = RUN_END_REASON_LABEL_KEYS[reason];
  if (labelKey) text += t('stream.event.dash', { value: t(labelKey) });
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
 * issue #236：一条 run 终态 → 展示行文案 + 分级（实时 `run_end` 与历史合成项 `run_termination`
 * **共用**这一个函数：两路同文案、同分级，不然刷新一次颜色就变）。
 * `usage` 是实时帧才有的片段（历史投影不带用量：刷新后的运行态数字不重建，见 #282 的边界）。
 */
function runEndLine(reason: string, termination?: RunTermination | null, usage = ''): {
  text: string;
  sysErr: boolean;
} {
  return {
    text: t('stream.event.runEnd', { reason: runEndReasonText(reason, termination), usage }),
    sysErr: RUN_TERMINATION_SYSERR_REASONS.has(reason),
  };
}

/**
 * issue #236：历史合成项 `run_termination`（`GET /events/history` 的响应期投影，不落库、不进 SSE）
 * → 展示条目。取词/分级与实时 `run_end` **共用 `runEndLine`**（两路同文案同分级）。
 *
 * 红线：它**不是** `run_end` 事件——`run_end` 仍不进 `HISTORY_EVENT_TYPES` / `HISTORY_REPLAY_TYPES`
 * （#217 / #236 的红线），本函数只吃**响应期合成项**，宿主在调 `replayEvent` **之前**分流
 * （与 #300 的 `partial_output` 同一种接法）。
 * 脏载荷（`termination` 缺键 / `reason` 非字符串 / 空串）⇒ `null`：不渲染空行，也不拿 `status` 编一个。
 */
function historyRunEndEntry(ev: RunHistoryEvent):
  | { kind: 'sep'; text: string }
  | { kind: 'syserr'; text: string }
  | null {
  const payload = (ev.payload !== null && typeof ev.payload === 'object') ? ev.payload : {};
  const raw = payload.termination;
  const termination = (raw !== null && typeof raw === 'object') ? raw as RunTermination : null;
  const reason = typeof termination?.reason === 'string' ? termination.reason : '';
  if (reason === '') return null;
  const line = runEndLine(reason, termination);
  return line.sysErr ? { kind: 'syserr', text: line.text } : { kind: 'sep', text: line.text };
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

function judgeOptionalDash(value: unknown, max: number): string {
  return typeof value === 'string' && value !== ''
    ? t('stream.event.dash', { value: value.slice(0, max) })
    : '';
}

// 引擎已知 action 全集（orchestrator 轮末 judge + run-snapshot-executor 中途审计，已对 0.20.0 源码核实）；
// 集合外的新增值（引擎演进 additive）一律中性透传，不反推任何语义。
const JUDGE_KNOWN_ACTIONS = new Set([
  'executed', 'blocked', 'degraded', 'judge_done', 'nudge', 'continue',
  'extend', 'extend+redirect', 'decline_extend',
]);

/**
 * issue #321（erix-station）：judge 事件的展示文本——judge 永远只是**意见**，不是验收；
 * 「已完成」的唯一来源是 run 终态（run_end 分隔行），本函数绝不驱动运行态状态机。
 * 分轴拼装（四个维度非互斥，可同时非空）：
 *   ① 工具审计：只有 `executed`（放行，**非任务完成**）/ `blocked`（拦截）/ `passThrough`（放行+模式）
 *     是审计结论；`extend` / `extend+redirect` / `decline_extend` 是扩轮处置而非审计结论——实测存在
 *     kind=intercept 而 action=extend+redirect、真实审计为拦截的情形，从这类 action 反推「工具已执行」
 *     会被骗，故带工具对象的事件一律走中性「结果未知，执行与否以工具卡片为准」；
 *   ② 目标判断：done=true 固定文案「评审认为目标已达成（未独立核验；是否收尾由模型自行判定）」——
 *     本站 runner 不传 finalGuard ⇒ verification 恒 skipped，文案不得写成已完成/已核验；confidence
 *     仅有限数才原样透出（不虚构 tier、不做成本估算，那些属 #282）；
 *   ③ 方向：只展示 off_track / uncertain（on_track 是常态不刷屏）；
 *   ④ 扩轮：取自 decision.extend，与 ②③ 共存，不再提前 return 遮掉其它轴。
 * degraded（评审调用失败，decision=null）与引擎新增的未知 action 走中性降级：灰色 judge 面板行，
 * 不刷红、不解读、不承诺。实时流与历史回放（replayEvent→dispatch）共用本函数，红线：两路同文案。
 */
function judgeAxesText(d: Record<string, any>): string {
  const dec = (d.decision !== null && typeof d.decision === 'object') ? d.decision : {};
  const action = typeof d.action === 'string' ? d.action : '';
  const passThrough = typeof d.passThrough === 'string' && d.passThrough !== '' ? d.passThrough : '';
  // 审计面的证据只有 kind=intercept 或 tool 对象：引擎的 extensionDecision 会把事件标成 kind=round
  // 但仍带 tool（run-snapshot-executor），所以两个判据都要看。
  const hasToolAudit = d.kind === 'intercept' || (d.tool !== null && typeof d.tool === 'object');

  // 中性降级：评审没给出意见（parse/timeout/error），也不代办工具是否执行了的结论。
  if (action === 'degraded') {
    const why = typeof d.error === 'string' && d.error !== '' ? d.error : 'unknown';
    return t('stream.event.judgeAxes', { axes: t('stream.event.judgeDegraded', { error: why }) });
  }

  const axes: string[] = [];
  // ① 工具审计轴（extend 族/轮次处置不落入本轴，带工具时走中性「以工具卡片为准」）。
  if (passThrough !== '') axes.push(t('stream.event.judgeAuditPassThrough', { mode: passThrough }));
  else if (action === 'executed') axes.push(t('stream.event.judgeAuditExecuted'));
  else if (action === 'blocked') axes.push(t('stream.event.judgeAuditBlocked'));
  else if (hasToolAudit && action !== '') axes.push(t('stream.event.judgeAuditUndecided', { action }));
  // ② 目标判断轴（纯意见；置信度是带括号的可选后缀片段，直接贴在目标轴尾，同 dash/paren 口径；
  // reason 作为独立片段，无 done 也不丢信息）。
  if (dec.done === true || dec.done === false) {
    let goal = dec.done
      ? t('stream.event.judgeGoalDoneTrue')
      : t('stream.event.judgeGoalDoneFalse');
    if (Number.isFinite(dec.confidence)) {
      goal += t('stream.event.judgeConfidence', { confidence: dec.confidence });
    }
    axes.push(goal);
  }
  if (typeof dec.reason === 'string' && dec.reason !== '') {
    axes.push(t('stream.event.judgeReason', { value: dec.reason.slice(0, 120) }));
  }
  // ③ 方向轴。
  if (dec.direction === 'off_track') {
    axes.push(t('stream.event.judgeDirectionOffTrack') + judgeOptionalDash(dec.directionReason, 60));
  } else if (dec.direction === 'uncertain') {
    axes.push(t('stream.event.judgeDirectionUncertain') + judgeOptionalDash(dec.directionReason, 60));
  }
  // ④ 扩轮轴（取自 decision.extend；不反推审计结论）。
  if (dec.extend === true) {
    const plan = typeof dec.plan === 'string' && dec.plan !== ''
      ? t('stream.event.dash', { value: String(dec.plan).slice(0, 80) }) : '';
    const why = typeof dec.extendReason === 'string' && dec.extendReason !== ''
      ? t('stream.event.paren', { value: String(dec.extendReason).slice(0, 60) }) : '';
    axes.push(t('stream.event.judgeExtendSuggest') + plan + why);
  } else if (dec.extend === false) {
    axes.push(t('stream.event.judgeExtendDecline') + judgeOptionalDash(dec.extendReason, 80));
  }
  // 未知 action（引擎 additive 新值）：中性原样透传，不解读（已有审计/处置轴能说明的不重复追加）。
  if (action !== '' && !JUDGE_KNOWN_ACTIONS.has(action)) {
    axes.push(t('stream.event.judgeUnknownAction', { action }));
  }
  return t('stream.event.judgeAxes', {
    axes: axes.length > 0 ? axes.join(' · ') : t('stream.event.judgeNoDetail'),
  });
}

/**
 * issue #279 关联索引的一条记录：provider `callId` 当前指向哪张卡、那张卡属于哪个 run、
 * 以及**已知的最细轮号**（`UNKNOWN_ROUND_TOKEN` = 这条路当时拿不到轮号）。
 * 它只服务两件事：迟到结果找到卡片、投影找不到精确键时归并回既有那张——**都不造身份**。
 */
export interface CardAlias {
  key: string;
  runId: string | null;
  roundToken: string;
  /** provider `tool_call_id`（投影路径把它当 `callId` 传进来）。 */
  callId?: string;
}

export interface EventStreamHooks {
  /** roundsep / 系统分隔行（judge/compaction/run_end 灰色文案等；judge 事件带 variant='judge'，由面板样式高亮）。 */
  onSep: (text: string, variant?: 'judge') => void;
  /** .syserr 红色错误行（RUN_FAIL_REASONS / run 失败信封）。 */
  onSysErr: (text: string) => void;
  /**
   * 工具卡片**首次创建**时通知宿主（宿主负责在消息流中占位，保持插入顺序）。
   * issue #279：入参从「裸 provider `tool_call_id`」改成**卡片身份键** `<run>:<轮号>:<callId>`
   * （见 `lib/toolCardKey.ts`）——宿主拿它当 `toolCards` 的查找键与展开记忆键，语义不变，只是键变了。
   */
  onToolCardCreated: (cardKey: string) => void;
  /** 当前 run 的 run_end（通知 + 终稿回写在宿主侧做：notifyRunEnd / refreshSession）。 */
  onCurrentRunEnd: (d: RunEndPayload & Record<string, unknown>) => void;
  /** EventSource 首次连通或自动重连恢复时，供宿主与服务端会话运行态对账。 */
  onConnected?: (sessionId: string) => void;
  /** issue #88：自动标题刷新（portal run 终态后异步评估、经 session SSE 推送）——宿主原地更新列表项。 */
  onSessionUpdated?: (d: { session_id?: string; title?: string } & Record<string, unknown>) => void;
  /**
   * issue #370：输入队列快照（`queue_update`，全量非增量）。宿主直接整体覆盖本地队列——
   * 服务端是唯一真相，前端只做乐观显示，所以「覆盖」而不是「合并」，天然消双发。
   */
  onQueueUpdate?: (d: {
    steering?: Array<{ id: string; content: string }> | string[];
    follow_up?: Array<{ id: string; content: string }> | string[];
    blocked?: string | null;
  } & Record<string, unknown>) => void;
  /**
   * issue #282：**每一帧**事件的旁路通知（不改变任何既有分发语义，纯观察面）。
   * 用途单一：会话页动量状态条（`composables/useRunMomentum.ts`）需要 `round_start` / `round_end` /
   * `usage` / `tool_use` / `tool_result` / `assistant_delta` / `run_end` 这些**已经到达前端**的帧。
   * `history=true` 表示这是历史回放帧（`replayEvent`）：状态机自己短路（run_end/usage 不在历史
   * 白名单，刷新后运行态数字本就拿不回来，不许拿历史帧假装「现在在跑」）。
   */
  onEvent?: (type: string, payload: Record<string, any>, history: boolean) => void;
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
  // 工具卡片状态（旧 S.toolCards）。issue #279：**键不再是裸 provider `tool_call_id`**，而是含轮号的
  // 组合键（`<run>:<轮号>:<callId>`，缺位的段不拼；尺规在 `lib/toolCardKey.ts`，三条路径共用）。
  // 会话级 Map、只在 resetStreamState 清空 ⇒ 把 run 写进键顺带修掉「同会话两个 run 共用 `c1` 串台」。
  const toolCards = reactive(new Map<string, ToolCardState>());
  // issue #279 轮号观测面（**实时与历史回放共用**：两条路都走 dispatch，而 round_start 既在
  // EVENT_TYPES 也在历史下发白名单）。写点只有 round_start/attempt/recovering/recovered
  // （载荷带轮号且发生在轮内；round_end/usage 不记，因为工具调用总在它们之前）。
  const roundTokenByRun = new Map<string, string>();
  // issue #279 关联索引：provider `callId` → **最新一张**卡片的身份键 + 它的 run + 它已知的最细轮号。
  // 只用于「结果/投影找到已有那张卡」，**不得当身份**（同一个 id 跨轮时身份是两张卡、索引只指向
  // 最新那张——具名用例钉住）。存结构体而不是只存 key：归并时要能判「跨 run 不许归并」「两侧轮号都
  // 已知且不同 ⇒ 那是两次调用，也不许归并」，而不靠拆字符串。
  const cardByCallId = new Map<string, CardAlias>();
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

  /** 轮号观测（仅由带轮号的事件写入；载荷脏 ⇒ 记为未知，不拿旧轮号冒充）。 */
  function observeRound(runId: unknown, round: unknown): void {
    if (typeof runId !== 'string' || runId === '') return;
    roundTokenByRun.set(runId, eventRoundToken(round));
  }

  function roundTokenFor(runId: unknown): string {
    if (typeof runId !== 'string' || runId === '') return UNKNOWN_ROUND_TOKEN;
    return roundTokenByRun.get(runId) ?? UNKNOWN_ROUND_TOKEN;
  }

  /** 事件侧（实时 + 历史回放）的卡片身份键：轮号取本连接观测到的那一个，没观测到就是未知段。 */
  function cardIdentity(runId: unknown, callId: string): string {
    return toolCardKey(runId, roundTokenFor(runId), callId);
  }

  /**
   * `tool_result` 找卡片（issue #279）：载荷里没有轮号，所以**结果关联不拿轮号当尺**。
   * 顺序：先试本 run 当前轮的精确身份键（正常形状：结果与调用同轮，两者必得同一张），未命中再退回
   * callId 索引（它指向「最新那张」= 正在等结果的那次调用；跨 resume 把结果补到下一轮、或实时漏收
   * round_start 时靠它）。两条都不中 ⇒ 无卡（与旧版「孤儿 tool_result 静默丢弃」同口径）。
   */
  function cardForCorrelation(runId: unknown, callId: unknown): ToolCardState | undefined {
    if (typeof callId !== 'string' || callId === '') return undefined;
    const exact = toolCards.get(cardIdentity(runId, callId));
    if (exact) return exact;
    const indexed = cardByCallId.get(callId);
    return indexed === undefined ? undefined : toolCards.get(indexed.key);
  }

  /** 关联索引写入（卡片**新建**时把该 callId 推进到最新那张）。 */
  function rememberCallAlias(callId: unknown, alias: CardAlias): void {
    if (typeof callId !== 'string' || callId === '') return;
    cardByCallId.set(callId, alias);
  }

  /**
   * issue #279：投影路径的**归并兜底**——精确身份键没命中时，用 provider `id` 的关联索引去找已经
   * 存在的那张实时卡（只有两路轮号对不上时才会走到这里：实时靠观测 `round_start`，投影靠上游投影键
   * 里的轮号段）。**索引在这里只用来「找到已有那张」，从不参与身份生成**。
   * 两边 `run_id` 都已知且不同 ⇒ **不归并**（那是两个 run 的两张卡）；任一侧 run 未知（旧帧不带
   * run_id）⇒ 宽松放行，宁可归并也不要拿同一个调用演两张卡。
   */
  function mergeTargetByAlias(key: string, alias?: CardAlias): ToolCardState | undefined {
    if (!alias || typeof alias.callId !== 'string' || alias.callId === '') return undefined;
    const target = cardByCallId.get(alias.callId);
    if (target === undefined || target.key === key) return undefined;
    const want = runSegment(alias.runId);
    if (want !== null && target.runId !== null && target.runId !== want) return undefined;
    // 两侧轮号**都**已知且不同 ⇒ 这是同一个 id 的**两次不同调用**（正是 #279 要分开的两张卡），
    // 不许归并；只有一侧真的拿不到轮号时才兜底归并（那条卡找不到的路，见函数注释）。
    if (alias.roundToken !== UNKNOWN_ROUND_TOKEN && target.roundToken !== UNKNOWN_ROUND_TOKEN) return undefined;
    return toolCards.get(target.key);
  }

  /** 归并成功后把索引里那条的轮号**收紧**到已知的那个（键不变，只是让下一次不同轮的投影不再误归并）。 */
  function tightenCallAlias(callId: string, target: CardAlias, alias: CardAlias): void {
    if (alias.roundToken === UNKNOWN_ROUND_TOKEN) return;
    cardByCallId.set(callId, { ...target, roundToken: alias.roundToken });
  }

  /** 关联索引的只读探针（单测用）：这个 provider `callId` 当前**关联**到哪个身份键。 */
  function cardIdentityOfCall(callId: string): string | undefined {
    return cardByCallId.get(callId)?.key;
  }

  // toolCard 语义：按**身份键**去重；首次创建时占渲染位并返回状态（旧版返回 DOM，这里返回状态对象）。
  // issue #279：去重从「裸 callId」换成组合身份键 ⇒ 跳轮复用 id 不再并进第一轮那张卡；`name`
  // **仍是首写冻结**（命中即返回、不覆盖）——保留它的理由是：身份键已含轮号，同一张卡就是一个真实
  // 调用，首写的名字就是它的名字。**不**改成「后到覆盖」（那会把真实的同名工具抖动带进来）。
  function toolCard(key: string, callId: unknown, name: string | null | undefined, input: unknown, runId?: unknown): ToolCardState {
    const existing = toolCards.get(key);
    if (existing) return existing;
    const card: ToolCardState = { name: name ?? 'tool', dig: digText(input), args: '', ok: null, out: '' };
    toolCards.set(key, card);
    // 索引只记录「这个 provider id 最新对应哪张卡」，供结果/投影关联用；它不参与身份计算。
    rememberCallAlias(callId, { key, runId: runSegment(runId), roundToken: roundTokenFor(runId) });
    hooks.onToolCardCreated(key);
    // 返回 reactive Map 读回的 proxy 而非 raw card：raw 存进响应式 Map 后，直接 mutate raw
    // 不触发渲染（与 workbench deltaEntry 同源同因）；后续既有卡片走 get（已是 proxy）本无此问题。
    return toolCards.get(key)!;
  }

  /**
   * issue #188：DTO 投影工具卡片登记（加载/刷新路径）。与实时/历史事件路径**共用同一** `toolCards`
   * Map 与 `onToolCardCreated` 占位 → 两条路收敛到 StreamPanel 同一渲染；同一**身份键**幂等
   * （事件流先建时只补全投影才有的字段，不重复占位）。
   *
   * issue #279：`key` 不再是裸 provider `id`，而是宿主用同一把尺（`lib/toolCardKey.ts`）拼出的
   * `<run>:<轮号>:<id>`——轮号来自上游投影键自带的轮号段（`toolCalls[].key` 的 `#` 前段），与事件侧
   * 观测到的 `round_start.round` 是同一个计数器 ⇒ 实时卡片与刷新后的投影卡片仍归并成一张。
   * 第三参 `alias`（provider `id` + `run_id`）只在「精确身份键没命中」时用来**找到已有那张卡**
   * （实时漏收 round_start ⇒ 它那张的轮号段是未知段）：归并而不新建，避免「刷新后卡片翻倍」。
   * 索引不得自己造身份 ⇒ 不传 alias 时行为与旧版一致（按键直接存取）。
   */
  function projectToolCard(key: string, fields: {
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
  }, alias?: CardAlias) {
    // 有预览字段 = 归一后仍不为 undefined；归一后的文本另存（number/null 到卡片里就是合法展示串）。
    const hasPreview = fields.resultPreview !== undefined;
    const resultPreview = hasPreview ? getToolResultSummary(fields.resultPreview) : undefined;
    // issue #283：库里可能是 NULL（旧数据引擎当年就没发时长）⇒ 不收，也不拿 0 冒充有时长。
    const projectedDur = Number.isFinite(fields.durationMs) ? (fields.durationMs as number) : undefined;
    const mergeKey = alias && typeof alias.callId === 'string' ? cardByCallId.get(alias.callId) : undefined;
    const existing = toolCards.get(key) ?? mergeTargetByAlias(key, alias);
    if (existing) {
      // 归并到索引里那张时顺手收紧它的轮号（键不变）：否则同一 id 的下一次不同轮投影会继续误归并。
      if (alias && mergeKey && mergeKey.key !== key && alias.callId) tightenCallAlias(alias.callId, mergeKey, alias);
      // 事件流先建：只补投影才有的摘要/预览/状态，不覆盖实时路径已有的完整数据。
      if (fields.argsSummary !== undefined && existing.argsSummary === undefined) existing.argsSummary = fields.argsSummary;
      if (resultPreview !== undefined && existing.resultPreview === undefined) existing.resultPreview = resultPreview;
      if (fields.executionStatus !== undefined && existing.executionStatus === undefined) existing.executionStatus = fields.executionStatus;
      // issue #283：刷新后不丢时长——但**只在实时路没给过的时候**用投影值（已有值优先）。
      // issue #299：投影值现在可能来自**引擎自己**（0.20.0 起投影 `toolCalls[].durationMs`），也可能来自
      // 宿主 join 的回落值（`portal/src/session-view.js`）；前端不分辨来源，只看「有值才用」。
      if (projectedDur !== undefined && existing.dur == null) existing.dur = projectedDur;
      if (existing.ok === null && (fields.isError !== undefined || hasPreview || isSpecialExecutionStatus(fields.executionStatus))) {
        existing.ok = fields.isError !== true;
      }
      return;
    }
    // 「值得关注」（= 已经有结果）的判据：**值比对**，不是存在性比对（#299 / guide §7：
    // 普通块上 executionStatus 缺席 ⇒ 拿存在性当判据会把普通块误判成「没结果」（ok=null 的…态）。
    const hasResult = fields.isError !== undefined || hasPreview || isSpecialExecutionStatus(fields.executionStatus);
    const card: ToolCardState = {
      name: fields.name,
      dig: fields.argsSummary ?? '',
      args: '',
      ok: hasResult ? fields.isError !== true : null,
      out: '',
      argsSummary: fields.argsSummary,
      resultPreview,
    };
    // 没有时长就**不写这个键**（不塞 `dur: undefined` 占位），与 M1 的「缺失保持 undefined」同口径。
    if (projectedDur !== undefined) card.dur = projectedDur;
    // #299 (c) 同口径：`executionStatus` 在 0.20.0 起**只在特殊状态下存在**，普通块上必须**也不写键**
    // （否则 DTO 的「缺席」到前端就变成了「有键但值是 undefined」，`in` / `Object.hasOwn` 一类判据会被骗）。
    if (fields.executionStatus !== undefined) card.executionStatus = fields.executionStatus;
    toolCards.set(key, card);
    // 投影路径也要推进关联索引（否则刷新后的卡片在后续 tool_result 面前「隐身」）。
    if (alias) rememberCallAlias(alias.callId, { ...alias, runId: runSegment(alias.runId) });
    hooks.onToolCardCreated(key);
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
    // issue #282：动量观察面（在 switch 之前通知 ⇒ usage/round_end 这些「接收但不展示」的类型也能被看到）。
    // 红线：它只观察、不驱动——不 return、不改 d、不参与任何既有分支判定。
    hooks.onEvent?.(type, d, history);
    switch (type) {
      case 'ping': return;
      case 'session_updated':
        // issue #88：标题是会话元数据而非时间线事件（live-only 帧，无 seq）；只更新列表项，不进消息流。
        hooks.onSessionUpdated?.(d);
        return;
      case 'queue_update':
        // issue #370：同样是一帧无 seq 的 live-only 状态帧；**不进消息流**（它是 composer 上方的条，
        // 不是对话内容——投递成功后那句话才会以正常 user 消息出现）。
        hooks.onQueueUpdate?.(d);
        return;
      case 'round_start':
        if (deltaText.value) { deltaText.value = null; }
        // issue #279：本 run 的轮号水位线（卡片身份的唯一轮号来源；实时与历史回放都走这里）。
        observeRound(d.run_id, d.round);
        hooks.onSep(`round ${d.round}`); return;
      case 'attempt':
        observeRound(d.run_id, d.round); // 重试仍在同一轮内（#279：round_start 漏收时的补点）
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
      case 'tool_replay_decision_required': {
        // issue #288（缺陷 C）：崩溃恢复时引擎把一个挂起工具**没重放**（payload 口径见
        // docs/api/portal.md §5.3 第 15 行：`{tool_call_id, round, name, replay,
        // requires_host_decision, partial_output_available, engine_run_id}`，由 runner 映射）。
        // **不新增任何 UI 结构**：与 attempt/recovering 同一个 onSep 分隔行；也不用 onSysErr——
        // 「没重放」不等于失败（引擎把选择权交回模型，模型自己会重跑），刷成红色会谎报严重程度。
        // `name` 是引擎透传的外来数据（additive）：非字符串/空串一律不带后缀片段，
        // 绝不 `String(对象)` 把 `[object Object]` 渗进用户可见文案（同 #261/#288B 口径）。
        const toolName = typeof d.name === 'string' && d.name !== '' ? d.name : null;
        hooks.onSep(t('stream.event.toolReplaySkipped', {
          tool: toolName ? t('stream.event.toolReplayTool', { name: toolName }) : '',
        }));
        return;
      }
      case 'persistence_error': {
        // issue #371-A：落盘失败告警（引擎 `orchestrator.js` 的 `persistenceErrorEvent`，
        // erix-agent#461 起附 `fatal`）。**只有 `fatal === false` 在这里刷中性分隔行**：
        //   · `fatal === true` / 字段缺失（= erix-agent 0.23.0 及以前的旧事件）⇒ 本次 run 正在或
        //     已经终止，红色面归 `run_end` 的 `persistence_failed` 管；这里再刷一条就是把一件事
        //     报两遍，也不能刷成中性——那会把真失败降成灰（谎报严重程度，同 #212 口径）。
        //   · 非致命这条**不影响本次任务**（剥掉的是折叠归档，原文仍在各轮记录里，#375 负责取回），
        //     所以走 hooks.onSep 的中性分隔行，不走红色错误行那一支。
        // `operation` 是引擎透传的外来数据：非字符串/空串一律退到 `round`（不 `String(对象)`
        // 把 `[object Object]` 渗进用户可见文案，同 #261/#288C 口径）。
        if (d.fatal !== false) return;
        hooks.onSep(t('stream.event.persistenceDegraded', {
          operation: typeof d.operation === 'string' && d.operation !== '' ? d.operation : 'round',
        }));
        return;
      }
      case 'recovering':
        observeRound(d.run_id, d.round); // 同 attempt：轮内重试，轮号仍是当前轮（#279）
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
          // issue #279：增量参数与后来的 tool_use 必须是**同一张**卡 ⇒ 两边用同一个身份键算法。
          const card = toolCard(cardIdentity(d.run_id, d.tool_call_id), d.tool_call_id, d.name ?? '', t('stream.argsStreaming'), d.run_id);
          card.args = card.args + (d.arguments_delta ?? '');
        }
        return;
      }
      case 'tool_use': {
        const card = toolCard(cardIdentity(d.run_id, d.tool_call_id), d.tool_call_id, d.name, d.input, d.run_id);
        card.args = typeof d.input === 'object' ? JSON.stringify(d.input ?? {}) : String(d.input ?? '');
        return;
      }
      case 'tool_result': {
        // issue #279：结果关联不再拿裸 id 当身份（`tool_result` 载荷**没有轮号**，契约 §5.3 第 7 类）：
        // 先试本 run 当前轮的精确身份键，未命中才回落到 callId 索引（它指向最新那张卡 = 正在等结果的
        // 那次调用）。**关联错了轮 = 把结果写进别人的卡片**，由 `结果不串轮` 具名用例钉住。
        const card = cardForCorrelation(d.run_id, d.tool_call_id);
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
        // issue #321：唯一生成点（实时帧与历史回放 dispatch 共用），分轴拼装；只出灰色 judge 面板行，
        // 绝不驱动运行态状态机（意见≠终态，终态只来自 run_end）；旧版 passThrough/extend 提前 return
        // 会遮掉 done/uncertain，现按轴独立拼装不再互遮蔽。
        hooks.onSep(judgeAxesText(d), 'judge');
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
          // issue #42 / #212 / #236：终止原因分级——异常集合红色告警，正常收尾灰色中性。
          // issue #236：分级与取词收敛到 `runEndLine`（与历史合成项 `run_termination` 共用），红色集合
          // 从 `RUN_FAIL_REASONS` 改为 `RUN_TERMINATION_SYSERR_REASONS`（= 它减掉 `aborted`）：
          // 用户按停止不是故障 ⇒ 中性分隔条；`failed` / `max_rounds_cap` / `persistence_failed` /
          // `final_guard_unverified` 仍然红（**没有把红色降级成中性**，AGENTS §8.7 的判据不变）。
          const line = runEndLine(reason, d.termination, usage);
          if (line.sysErr) hooks.onSysErr(line.text);
          else hooks.onSep(line.text);
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
    // issue #279：轮号观测面与关联索引同生命周期（都得跟着卡片清，不然跨会话串轮号/串卡）。
    roundTokenByRun.clear();
    cardByCallId.clear();
    esSessionId.value = null;
  }

  return {
    lastSeq, esSessionId, activeRunId, deltaText, toolCards,
    connect, closeEs, resetStreamState,
    // handleEvent/toolCard 导出仅为单测驱动（旧版 static-client.test.js 的 vm 直驱等价）；
    // replayEvent 供 openSession 历史归并回放驱动（issue #89）；projectToolCard 供 DTO 投影路径（#188）。
    // cardIdentityOfCall（issue #279）：关联索引的只读探针——存的是「这个 provider id 最新对应哪张卡」，
    // 存它的唯一目的是**证明索引不是身份**（身份看 toolCards 的键数）。
    // historyRunEndEntry（issue #236）：历史合成项 `run_termination` 的取词/分级入口（宿主在
    // **调 replayEvent 之前**分流，与 #300 的 `partial_output` 同一种接法）。
    handleEvent, toolCard, replayEvent, projectToolCard, cardIdentityOfCall, historyRunEndEntry,
  };
}
