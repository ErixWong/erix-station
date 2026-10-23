// 工作台 store（pinia，setup 写法）：portal/static/index.html 内联 JS 的
// initWorkspace/loadSessions/openSession/send/stop/refreshSession/resetSessionView/
// saveDraft/notifyRunEnd 逐行平移（issue #61 P2）。
// issue #84 P5（目录即项目，feat-260924-02）：项目注册实体退役——projects/projectId 改为
// dirs/dirCwd（GET /api/dirs 枚举 ~/projects/ 一级目录 + 运行态计数）；
// switchProject → selectDir；createProject → createDir（POST /api/sessions {cwd}，服务端 mkdir）；
// 会话列表按 cwd 过滤（?cwd= 参数 + 响应 cwd 防御性客户端过滤）。
//
// 路由不在本 store 内：深链/回退由 WorkbenchView 监听路由参数驱动（#/session/<id> 迁入
// vue-router，见 M3）；store 通过 onClearRoute 钩子请视图清路由（等价旧 clearRoute()）。
// SSE 协议状态在 useEventStream composable 内（M1）。
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { api, ApiError, patchSessionTitle, postSessionAiTitle, toDisplayText } from '../api';
import { projectionRoundToken, runSegment, toolCardKey as buildToolCardKey } from '../lib/toolCardKey';
import { i18n } from '../i18n';
import { useEventStream, RUN_FAIL_REASONS, type CardAlias, type RunEndPayload, type RunHistoryEvent } from '../composables/useEventStream';
import { renderMarkdown } from '../lib/markdown';
import { DIR_NAME_RE, SESSION_TITLE_MAX_LEN } from '../lib/constants';
// issue #85：工具卡片折叠记忆的会话级复位（挂在各 resetStreamState 宿主调用点）。
import { clearExpandedToolCalls } from '../lib/toolCallExpansion';

// 用户可见文案取词（issue #101 P2）：Pinia setup store 不是组件 setup 上下文（useI18n 会抛
// MUST_BE_CALL_SETUP_TOP，且组件作用域 composer 语义不符），故统一走 i18n.global.t。
// 响应式：t() 内部读取 locale 响应式 ref，故在 computed / 模板函数中取词会随切语言自动更新；
// 错误行/通知正文属「事件发生时快照」，不回溯翻译（可接受）。
const t = i18n.global.t;

/** 目录项（GET /api/dirs）：~/projects/ 一级目录 + 跨目录运行态计数。 */
export interface DirInfo {
  name: string;
  cwd: string; // 相对形式 ~/projects/<name>
  running_count: number;
  queued_count: number;
}

export interface Session {
  id: string;
  title?: string | null;
  title_source?: string | null; // issue #107：'manual'（手工改名）| 'auto'（自动标题）
  updated_at?: string;
  active_run_id?: string | null;
  cwd?: string; // issue #84 P5：会话绑定目录（响应带 cwd）
  /** issue #197：会话消息数（后端 listSessions COUNT 全量 messages 行、含 synthetic，
   * 与头部状态行 sessionStats 同源口径）；旧后端/其列表外来源（createSession 响应）可能缺失 → 不显示。 */
  message_count?: number;
}

/**
 * issue #188：DTO 透传的上游投影工具调用（`DisplayTurn.toolCalls[]` 逐字）。`id` 可选（provider 决定，
 * 可缺失/可重复）；erix-agent 0.16.0 为每个 toolCall 提供稳定的视图键 `key`（单次投影内唯一、同输入
 * 确定性、由输入位置生成——**不是持久 ID、也不是 provider `tool_use.id`**），上游 #100 由此交付。
 * 预览长度上游已定（args 120 / result 400）。
 */
export interface ProjectedToolCall {
  key?: string;
  name: string;
  id?: string;
  argsSummary?: string;
  resultPreview?: string;
  isError?: boolean;
  /**
   * issue #299（erix-agent 0.20.0 / guide §7）：**只在两种特殊状态下存在**——`intercepted`（审计拦截）
   * 与 `interrupted`（续跑改写）；普通成功/失败的块上该键**缺席**（不是空串、不是 `ok`）。
   * ⚠ 不得把「字段在不在」当「这个块值得关注」的判据，要判就拿值比
   * （`lib/toolSummary.ts#isSpecialExecutionStatus`）。
   */
  executionStatus?: string;
  /**
   * erix-agent 0.20.0 起上游投影**自己就带** `toolCallKey`（一次被接受的调用的耐久身份键，
   * 跨 resume 稳定）。本单**不接进卡片身份**：我们的 §8.5 身份仍是投影自造的 `key` + provider
   * `tool_use.id`，接不接 `toolCallKey` 是单独的设计决定（见 `portal/src/session-view.js` 同注）。
   */
  toolCallKey?: string;
  /**
   * 耗时（毫秒）。**两条来源**（#283 → #299）：
   *   1. erix-agent 0.20.0 起**引擎投影自己带** `durationMs`（`erix.durationMs` 的投影）；
   *   2. 投影缺省时由 `portal/src/session-view.js` 在投影之后按 `(run_id, call_id)` 从自家
   *      `tool_calls.duration_ms` **回落 join**（老记录唯一的时长来源）。
   * 两路都没有 ⇒ DTO **不出现该键**（0.20.0 明说「缺失=不知道」，**绝不写 0**）；
   * 前端只在卡片现有 `dur` 为空时用它。T1 之前的记录上引擎那一路是直接缺省的（不合成）。
   */
  durationMs?: number;
}

/**
 * issue #189：助手消息 DTO 的折叠段信息（后端契约：只在有折叠时出现，无则不写 `folded` 键）。
 * 字段名与上游一致（foldedRoundRange / navigationRecord / foldedPayloadMessages / round），原样透传；
 * `navigationRecord` 本单不渲染，原样存着即可。
 * `round`（#189 收尾）= 该折叠行**自己**的 round（「查看原文」端点的查询键）；
 * `foldedRoundRange` 是**被折叠的轮范围**，两者语义不同，不可拿 range 代替 round 去查端点。
 */
export interface FoldedInfo {
  text: string;
  foldedRoundRange?: { from?: number; to?: number };
  navigationRecord?: unknown;
  foldedPayloadMessages?: number;
  round?: number;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  synthetic?: boolean;
  run_id?: string | null;
  seq?: number; // issue #89：刷新后历史归并回放（与 run_events 共用分配器，按 seq 穿插）
  // issue #188：上游投影字段逐字透传（有则出现、无则不写键）。加载/刷新路径据此重建工具卡片与推理。
  toolCalls?: ProjectedToolCall[];
  reasoning?: string;
  blocks?: unknown[]; // 原始 content blocks（全文在此；卡片预览已由上游截断，本单不渲染）
  turnKeys?: string[]; // 0.16.0：聚合进本 run 的助手轮视图键（`turn.key`，逐字透传）
  // issue #189：折叠段（compaction）摘要（有折叠才出现）；渲染为独立横幅，绑定在该助手消息上。
  folded?: FoldedInfo;
}

/**
 * issue #189：原文端点（GET /api/sessions/:id/folded/:round）返回的 DisplayTurn 形状。
 * 本单只渲染 `text`（纯文本），其余字段原样保留不解读。
 */
export interface FoldedOriginalTurn {
  text?: string;
  [key: string]: unknown;
}

/** 原文懒加载状态：missing=后端 404（folded_payload_not_found，友好提示，不抛红）；error=其他错误（可重试）。 */
export type FoldedOriginalState =
  | { status: 'loading' }
  | { status: 'loaded'; turns: FoldedOriginalTurn[] }
  | { status: 'missing' }
  | { status: 'error'; message: string };

/** 消息流渲染单元（旧版 DOM 追加序的数组等价）。 */
export type StreamEntry =
  | { kind: 'msg'; id: string; role: string; synthetic: boolean; text: string; html: string | null; sessionId: string | null }
  // issue #189：折叠横幅独立 entry（**方案说明**：独立 kind 而非在 msg entry 加 folded 字段——
  // msg 分支渲染 .msg 气泡，加字段会诱导把横幅画进气泡内；独立 kind 天然渲染成独立分隔条
  // （非 .msg 类），并与该助手消息绑定（id=消息 id，排在正文气泡前）。renderedIds 去重、
  // 消息顺序、会话切换复位都自动沿用既有链路。）
  | { kind: 'folded'; id: string; sessionId: string | null; folded: FoldedInfo }
  | { kind: 'sep'; text: string; variant?: 'judge' }
  | { kind: 'syserr'; text: string }
  | { kind: 'tool'; callId: string }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'delta'; text: string }
  // issue #300：被停止/失败的 run **零助手锚点**（runner 的 catch 固定 final_text:''），而正文区
  // 本来就只从 messages 锚点渲染 ⇒ 界面上这次 run 一片空白。历史端点把它的 assistant_delta 按 seq
  // 聚合成一条合成项 partial_output（**不落库、不进 SSE**），本 kind 就是它在展示层的落点：
  // **中性助手气泡**（不是红色 .syserr：「只剩半截正文」不是错误），id=partial:<run_id> 幂等去重。
  | { kind: 'partial'; id: string; text: string; truncated: boolean; sessionId: string | null };

interface SessionDetail {
  session: Session & { active_run_id?: string | null };
  messages: ChatMessage[];
  last_seq: number;
}

interface WorkbenchHooks {
  /** 等价旧 clearRoute()：请路由层清掉 #/session/<id>（视图注入 router.replace('/')）。 */
  onClearRoute?: () => void;
  /** 深链跨项目解析后写回 #/session/<id>（旧版 replaceState 恢复深链的等价）。 */
  onDeepLinkRestored?: (sid: string) => void;
}

// 模块级钩子（视图在挂载时注入 router 回调；单测可覆写）。store 保持 router 无关。
let workbenchHooks: WorkbenchHooks = {};
export function setWorkbenchHooks(h: WorkbenchHooks): void {
  workbenchHooks = h;
}

/**
 * issue #188 工具卡片身份（**投影路径**）。issue #279 后与实时路共用 `lib/toolCardKey.ts` 那一把尺：
 *   * `id` 在 ⇒ 身份 = `<run_id>:<轮号>:<id>`。轮号**不伪造**：取上游投影键 `call.key` 自带的轮号段
 *     （erix-agent `projection.js:449-455`：`"<round>#<recordIndex>:<entryIndex>:t<i>"`，轮号缺位时
 *     上游自己写 `?`）——它与实时路观测到的 `round_start.round` 是引擎同一个轮计数器，所以实时卡片
 *     与刷新后的投影卡片仍归并成一张（§8.5「与实时 `tool_call_id` 同源 ⇒ 天然归并」仍成立，只是
 *     现在多了一段轮号）。同时把 `id`/`run_id` 作为**关联别名**交给下游索引：两路轮号真对不上时
 *     （实时漏收 round_start）用索引归并，不得拿它造身份。
 *   * `id` 缺、`key` 在 ⇒ 直接用上游 `key`（§8.5，它本身就含轮号 ⇒ 跳轮不碰撞，无需再拼）。
 *   * 两者都缺 ⇒ `proj:<锚点 id>:<序号>` 兜底照旧。
 * ⚠ §8.5 那句「投影 `key` 不是持久 ID、也不是 provider `tool_use.id`」仍然成立：这里只**从它里
 * 面取轮号**，没有把它当跨投影耐久的身份。
 */
function toolCardIdentity(messageId: string, messageRunId: string | null | undefined, call: ProjectedToolCall, index: number): {
  key: string;
  alias?: CardAlias;
} {
  const id = typeof call.id === 'string' && call.id !== '' ? call.id : null;
  if (id !== null) {
    const roundToken = projectionRoundToken(call.key);
    return {
      key: buildToolCardKey(messageRunId, roundToken, id),
      alias: { key: buildToolCardKey(messageRunId, roundToken, id), runId: runSegment(messageRunId), roundToken, callId: id },
    };
  }
  if (typeof call.key === 'string' && call.key !== '') return { key: call.key };
  return { key: `proj:${messageId}:${index}` };
}

/**
 * issue #300：合成项 `partial_output` 的载荷取数（脏载荷一律退化）。
 * 与 lib/toolSummary.ts 同口径：**拿值比类型**，不 `String()` 兼平（对象 String() 出来就是
 * `[object Object]`，数字会变成「42」这种看起像正文的脏东西）。
 */
function partialText(payload: Record<string, unknown> | undefined): string {
  return typeof payload?.text === 'string' ? payload.text : '';
}

/** 同上：`truncated` 只认**真字面量 true**（缺键/脏值一律当「没截断」，不拿脏值冒充提示）。 */
function partialTruncated(payload: Record<string, unknown> | undefined): boolean {
  return payload?.truncated === true;
}

export const useWorkbenchStore = defineStore('workbench', () => {
  // ---- S 状态平移 ----
  const dirs = ref<DirInfo[]>([]);
  const dirCwd = ref<string | null>(null); // 选中目录（页面级状态）
  const sessions = ref<Session[]>([]);
  const sessionId = ref<string | null>(null);
  // issue #197：当前会话的消息总数（getSession DTO 的 session.message_count，后端全量口径）。
  // null=旧后端/非详情入口无此字段 → sessionStats 回退已加载条数（messages 是分页窗口，长会话会少报）。
  const sessionMessageCount = ref<number | null>(null);
  const noDir = ref(false);
  const projectReqSeq = ref(0); // 迟到响应丢弃（快速 A→B 切换）
  const sessionReqSeq = ref(0);
  const ctxSeq = ref(0); // 项目上下文代次
  const entries = ref<StreamEntry[]>([]); // 消息流（含分隔行/工具卡片占位）
  const renderedIds = ref<Set<string> | null>(null); // 去重（refresh 与流式缓冲竞态）
  const inputValue = ref(''); // composer 输入（旧 $('input').value）
  const creatingSession = ref(false); // 旧 newSess 按钮禁用语义
  // issue #332：这里原有 `isPlatformAdmin = user.role === 'admin' && !user.fde_name`（+ 派生的
  // `newDirDisabled`、「＋新建目录」的 disabled、「进管理台」引导文案与占位符）——入口拦截落地后
  // 这类人**根本进不到工作台**（router 守卫里的 workbenchGateDecision，判据 lib/workbenchGate.ts），
  // 本 store 的 isPlatformAdmin 永远为 false ⇒ 按仓内纪律（不留不可达分支当「以防万一」）整块拆除。
  // 服务端另有同名写闸（**2026-10-21 更正**：这里原先写的是「403 forbidden」，与代码不符）：
  // POST /api/sessions 对无 fde_name 的账号返 **400 `validation_failed` + `details.field='fde_name'`**
  // （portal/src/sessions.js:214-222 的 `if (!fdeName)`；判据由 portal/test/sessions-cwd.test.js:99
  // 「createSession：用户无 fde_name → 400」钉着）。

  // issue #55 A1：per-session 输入草稿（内存 Map，key=sessionId）；切换会话/项目时保存与恢复。
  const drafts = new Map<string, string>();

  // ---- issue #261B：一键「重试上一条」（provider 超时杀 run 后不必手打重发长消息）----
  // **仅内存、不持久化**（无 localStorage / 无后端回写）：刷新页面 = 重建 store ⇒ lastSend 与
  // retryAvailable 双双归零，按钮不再出现。这是 MVP 边界（工单明确不做「刷新后恢复重试面」）。
  // 刷新后要恢复，得把「最后一条 user 消息 + 该 run 终态」从服务端转录重建，不属本单范围。
  const lastSend = ref<{ sessionId: string; content: string } | null>(null);
  const retryAvailable = ref(false);
  // in-flight 禁用闸（防双击双发）：重试 POST 往返窗口里 activeRunId 尚未置位（send 在 POST
  // 回来后才置），running 仍为 false —— 只靠 running 拦不住第二次点击。
  const retryInFlight = ref(false);

  // SSE 协议状态 + 事件语义（hooks 接回展示层）。
  let runStateCheckSeq = 0;
  const es = useEventStream({
    onSep: (text, variant) => entries.value.push({ kind: 'sep', text, variant }),
    onSysErr: (text) => entries.value.push({ kind: 'syserr', text }),
    onToolCardCreated: (callId) => entries.value.push({ kind: 'tool', callId }),
    onConnected: (id) => { void reconcileActiveRun(id); },
    onCurrentRunEnd: (d) => {
      removeDeltaEntry(); // 旧版 run_end 移除流式增量 DOM（终稿由 refreshSession 回写，防双份）
      notifyRunEnd(d);
      applyRetryFaceOnRunEnd(d); // issue #261B：失败终局 → 点亮「重试上一条」
      refreshSession(d.run_id);
      repullPartialOutput(d); // issue #306：中止/失败终局 → 补一次 history，让合成项当场出现
    },
    // issue #88：自动标题刷新 → 原地更新会话列表项（比整表 loadSessions 轻；后续列表刷新仍是兜底）。
    onSessionUpdated: (d) => {
      const sid = d.session_id != null ? String(d.session_id) : sessionId.value;
      if (typeof d.title !== 'string' || sid == null) return;
      const item = sessions.value.find((s) => String(s.id) === sid);
      if (item) item.title = d.title;
    },
  });

  // ---- 计算属性（旧 updateProjectMeta / updateWorkspaceAvailability / setRunning 的响应式等价）----
  /** 当前选中目录（顶栏 cwd 徽标 / 下拉高亮用）。 */
  const currentDir = computed(() => dirs.value.find((d) => d.cwd === dirCwd.value) ?? null);
  const running = computed(() => es.activeRunId.value != null);
  const sendDisabled = computed(() => running.value || noDir.value);
  const inputPlaceholder = computed(() =>
    // #332：原先第三态「平台管理员：请到管理台…」已随入口拦截拆掉（不可达），两态照旧：
    // 无目录 → 引导建目录；有目录 → 正常输入提示。
    noDir.value ? t('common.createFirstDir') : t('workbench.inputPlaceholder'),
  );
  const newSessDisabled = computed(() => noDir.value || creatingSession.value);
  // 会话列表项 meta 行（● 运行中 / 本地化时间）
  // issue #105 ③：时间戳按当前 locale 格式化（原硬编码 'zh-CN'，英文界面下仍是中文格式）。
  // 'zh-CN' / 'en' 均为合法 BCP-47；locale 是响应式 ref，模板函数读取它 → 切语言即时重渲染。
  function sessMeta(s: Session): string {
    return s.active_run_id
      ? t('common.runningBadge')
      : new Date(s.updated_at ?? 0).toLocaleString(i18n.global.locale.value);
  }

  // ---- 草稿（saveDraft 三路径共用：openSession / selectDir / resetSessionView）----
  // 评审修复：统一的草稿暂存——有值 set、空值 delete（恢复后手动清空须能真正清掉）；无选中会话不动。
  function saveDraft() {
    if (!sessionId.value) return;
    const v = inputValue.value;
    if (v) drafts.set(sessionId.value, v);
    else drafts.delete(sessionId.value);
  }

  // ---- issue #261B：「重试上一条」面的两个写入点（run 终局 / 离开会话）----
  /**
   * run 终局决定重试面（与 useEventStream 推红色 syserr 分隔条走**同一个** RUN_FAIL_REASONS Set
   * 实例，不存在第二份枚举）：失败集合内 ⇒ 可用；end_turn / no_tool / judge_done 等正常终局 ⇒ 置 false。
   * 会话归属核对：onCurrentRunEnd 已被 useEventStream 的「仅当前 run」守卫过滤，但 lastSend 仍可能
   * 属于上一个会话（在 A 发送后切走、当前会话的某个 run 恰此时终局），不得把别人的失败标成可重试。
   */
  function applyRetryFaceOnRunEnd(d: RunEndPayload) {
    const last = lastSend.value;
    retryAvailable.value = RUN_FAIL_REASONS.has(d.termination?.reason ?? '')
      && last != null && last.sessionId === sessionId.value;
  }

  /** 切会话 / 切目录 / 关会话 ⇒ 重试面重置（工单 #261B：不留到另一个会话的输入框上）。 */
  function clearRetryFace() {
    retryAvailable.value = false;
  }

  // ---- issue #306：终态后补一次 history，让 `partial_output` 当场出现（不必刷新）----
  /**
   * 要不要重拉。**条件故意窄**：只有 `termination.reason ∈ RUN_FAIL_REASONS` 才拉。
   * `aborted` 本身就在那一个集合里（`lib/terminationReasons.ts` 的 RUN_FAIL_REASON_LIST），所以
   * 不另开一份枚举；`end_turn` / `no_tool` / `judge_done` / `stall` 等**零重拉**——那类 run 本来就有
   * 助手锚点（判据②不成立，后端也不会合成），白打一次 history 是纯成本（dev 一个会话 14.4 万条事件）。
   */
  function shouldRepullPartialOutput(d: RunEndPayload): boolean {
    return RUN_FAIL_REASONS.has(d.termination?.reason ?? '');
  }

  /**
   * issue #306：`partial_output` **只在 `GET /events/history` 的响应期合成**（docs/api/portal.md
   * §4.4a-1：不落库、不进 SSE），而此前只有 `openSession` 拉过 history ⇒ 用户点「停止」的那一刻
   * 只能看到 `run_end` 分隔行，部分正文要刷新一次才出现。这里在**失败/中止终态**后补拉一次。
   *
   * - **复用既有归并路径**：只把 `partial_output` 交给 `addPartialOutput`（与 openSession 同一个
   *   函数、同一份 `renderedIds` 幂等集，id = `partial:<run_id>`）⇒ 已渲染过就**不会出第二条**。
   * - **其余事件故意不重放**：工具卡片幂等，但 `judge`/`round_start`/`attempt` 这些分隔行**不幂等**
   *   （重放一遍就是刷屏），而它们本次也不是来取的东西。
   * - **窗口参数不变**：openSession 拉 history 不传 `limit`/`before`（后端默认窗口），这里用**同一个
   *   URL** ⇒ 不为了拿合成项把 limit 拉大到一个新数量级。合成项只出现在「该 run 真落在本次窗口里」
   *   的那一页，拿不到就维持现状（后端契约的已知边界，不在本单）。
   * - **失败静默**：不能把终态处理弄失败（§8.33 「自动改名降级是硬的」同口径）；内部全包在 try 里、
   *   调用处 `void`，**不得漏出未捕获拒绝**。
   */
  function repullPartialOutput(d: RunEndPayload): void {
    const sid = sessionId.value;
    // renderedIds 为 null = 不在会话详情视图里（切目录/重置）⇒ 没有幂等集，宁可不补也不能重复渲染。
    if (sid == null || renderedIds.value === null || !shouldRepullPartialOutput(d)) return;
    const reqSeq = sessionReqSeq.value;
    const ctx = ctxSeq.value;
    void (async () => {
      try {
        const data = await api<{ events?: RunHistoryEvent[] }>(`/api/sessions/${encodeURIComponent(sid)}/events/history`);
        if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value || sessionId.value !== sid) return; // 迟到的响应：已换会话
        for (const ev of data?.events ?? []) {
          if (ev && ev.type === 'partial_output') addPartialOutput(ev);
        }
      } catch {
        /* 静默降级：界面维持现状（只多一个没成功的请求），终态 UI 与停止按钮不受影响 */
      }
    })();
  }

  // ---- addMessage（issue #40 渲染规则逐行平移）----
  /**
   * issue #300：历史合成项 `partial_output` → 中性 partial entry。
   * 幂等靠 id=`partial:<run_id>` 走 renderedIds（与 addMessage 同一去重集）：同一条在多次归并/
   * 重进会话时只渲染一次。聚合文本为空（脏载荷只有脏片段）⇒ 不推 entry，界面不出现空气泡。
   */
  function addPartialOutput(ev: RunHistoryEvent) {
    const runId = typeof ev.run_id === 'string' && ev.run_id !== '' ? ev.run_id : 'unknown';
    const id = `partial:${runId}`;
    if (renderedIds.value) {
      if (renderedIds.value.has(id)) return;
      renderedIds.value.add(id);
    }
    const text = partialText(ev.payload);
    if (text === '') return;
    entries.value.push({ kind: 'partial', id, text, truncated: partialTruncated(ev.payload), sessionId: sessionId.value });
  }

  function addMessage(m: ChatMessage) {
    if (renderedIds.value) {
      if (renderedIds.value.has(m.id)) return; // 去重（refresh 与流式缓冲竞态）
      renderedIds.value.add(m.id);
    }
    // issue #188：加载/刷新路径由 DTO 的投影字段重建工具卡片与推理展示（实时/历史事件路径不变）。
    // reasoning 与正文分离、默认收起（StreamPanel 可展开）；仅加载/刷新路径产出（实时推理增量不展示）。
    if (typeof m.reasoning === 'string' && m.reasoning !== '') {
      entries.value.push({ kind: 'reasoning', id: m.id, text: m.reasoning });
    }
    // 工具卡片与实时路径**共用同一** es.toolCards Map（按 callId 幂等）→ 历史事件已建卡片时不再占位，
    // 同一调用不会渲染两张卡片；仅凭 DTO（无事件）也能渲染卡片。卡片排在正文气泡前（先工具后答复）。
    if (Array.isArray(m.toolCalls)) {
      m.toolCalls.forEach((call, index) => {
        // issue #283：整个 call（含宿主 join 的 `durationMs`）一并交给 projectToolCard——
        // 刷新后卡片仍能显示耗时，但实时路已拿到的值不会被它覆盖（覆盖规则在 composable 里）。
        // issue #279：身份键与实时路同一把尺（含轮号），另把 provider `id`/`run_id` 作为关联别名传过去。
        const ident = toolCardIdentity(m.id, m.run_id, call, index);
        es.projectToolCard(ident.key, call, ident.alias);
      });
    }
    // 仅助手终稿渲染 Markdown 子集（先转义后格式化，XSS 安全）；用户消息与系统注入
    // （synthetic）保持纯文本。流式增量（delta）全程文本追加，run_end 终稿经
    // refreshSession → addMessage 整体渲染（半截 ``` 不炸布局）。
    // issue #189：有折叠时在正文气泡前推一条独立折叠横幅 entry（绑定消息 id，非 .msg 气泡视觉）。
    if (m.folded && typeof m.folded === 'object' && typeof m.folded.text === 'string') {
      entries.value.push({ kind: 'folded', id: m.id, sessionId: sessionId.value, folded: m.folded });
    }
    const isMd = m.role === 'assistant' && !m.synthetic;
    entries.value.push({
      kind: 'msg',
      id: m.id,
      role: m.role,
      synthetic: !!m.synthetic,
      text: (m.synthetic ? t('workbench.systemInjection', { content: m.content }) : m.content),
      html: isMd ? renderMarkdown(m.content) : null,
      sessionId: sessionId.value, // issue #189：横幅「查看原文」按 (会话, 轮) 调端点，绑定所属会话
    });
  }

  // ---- issue #189：折叠段原文懒加载（GET /api/sessions/:id/folded/:round，只读）----
  // 按 (sessionId, round) 缓存；404（folded_payload_not_found）视为「无原文」（missing 态，友好提示不抛红）；
  // 其他错误可重试。loading/loaded/missing/error 四态暴露给 StreamPanel。
  const foldedOriginals = ref<Record<string, FoldedOriginalState>>({});

  function foldedOriginalKey(sid: string, round: number): string {
    return `${sid}:${round}`;
  }

  /** 取当前折叠原文状态（无记录 = 尚未加载，组件按 idle 处理）。 */
  function getFoldedOriginal(sid: string, round: number): FoldedOriginalState | undefined {
    return foldedOriginals.value[foldedOriginalKey(sid, round)];
  }

  /**
   * 懒加载某轮折叠前原文。已加载/加载中直接返回（缓存命中不重发）；error 态由组件传
   * force=true 重试。返回加载后的状态，便于调用方/测试断言。
   */
  async function loadFoldedOriginal(
    sid: string,
    round: number,
    opts: { force?: boolean } = {},
  ): Promise<FoldedOriginalState> {
    const key = foldedOriginalKey(sid, round);
    const cur = foldedOriginals.value[key];
    if (cur && !(opts.force && cur.status === 'error')) return cur;
    foldedOriginals.value[key] = { status: 'loading' };
    try {
      const data = await api<{ round: number; turns: FoldedOriginalTurn[] }>(
        `/api/sessions/${encodeURIComponent(sid)}/folded/${encodeURIComponent(String(round))}`,
      );
      const next: FoldedOriginalState = { status: 'loaded', turns: Array.isArray(data.turns) ? data.turns : [] };
      foldedOriginals.value[key] = next;
      return next;
    } catch (e) {
      const next: FoldedOriginalState =
        e instanceof ApiError && (e.status === 404 || e.code === 'folded_payload_not_found')
          ? { status: 'missing' }
          : { status: 'error', message: e instanceof Error ? e.message : String(e) };
      foldedOriginals.value[key] = next;
      return next;
    }
  }

  /**
   * issue #189（追加）：当前会话头部状态行数据：
   * messages = 消息数：#197 口径修正——优先用后端 DTO 的会话总数 message_count（全量 messages 行、
   * 含 synthetic，与侧栏列表 message_count 同源）；DTO 的 messages 只是分页窗口（limit 默认 20），
   * 长会话只按已加载条数会少报。缺失（旧后端/其他入口）回退已加载 msg entry 数；两数取大——
   * DTO 快照后实时新增的消息（send/SSE）不得被旧快照吃掉回退。folded = DTO 带 folded 字段的消息数。
   * 无选中会话 → null（不渲染）。
   */
  const sessionStats = computed(() => {
    if (!sessionId.value) return null;
    let messages = 0;
    let folded = 0;
    for (const en of entries.value) {
      if (en.kind === 'msg') messages++;
      else if (en.kind === 'folded') folded++;
    }
    const total = sessionMessageCount.value;
    return { messages: total != null ? Math.max(total, messages) : messages, folded };
  });

  // ---- 流式增量气泡（旧 S.deltaBuf DOM 的数组等价：round_start 后半截增量留在流里）----
  let deltaEntry: Extract<StreamEntry, { kind: 'delta' }> | null = null;
  watch(es.deltaText, (v, old) => {
    if (v === null) { deltaEntry = null; return; }
    if (old === null) {
      deltaEntry = { kind: 'delta', text: '' };
      entries.value.push(deltaEntry);
      // ⚠️ 必须改回读数组里的 reactive proxy：数组内部存的是 raw 对象，直接 mutate push 前的
      // raw 引用不经过 proxy set 陷阱 → 不触发渲染（打字机效果丢失，文字要等下一次
      // entries 结构变更才"顺带"出现）。indexOf 对 raw/proxy 双向解引用（Vue 数组
      // instrumentation），removeDeltaEntry 持 proxy 照常命中。
      const stored = entries.value[entries.value.length - 1];
      if (stored?.kind === 'delta') deltaEntry = stored;
    }
    if (deltaEntry) deltaEntry.text = v;
  });
  // 当前 run_end 移除活动增量占位（旧 S.deltaBuf.remove()）。
  function removeDeltaEntry() {
    if (!deltaEntry) return;
    const i = entries.value.indexOf(deltaEntry);
    if (i !== -1) entries.value.splice(i, 1);
    deltaEntry = null;
  }

  function applyServerRunState(serverRunId: string | null, previousRunId: string | null): string | null {
    es.activeRunId.value = serverRunId;
    if (previousRunId === null || serverRunId !== null) return null;
    es.deltaText.value = null;
    removeDeltaEntry();
    entries.value.push({ kind: 'sep', text: t('stream.event.missedRunEnd') });
    return previousRunId;
  }

  async function reconcileActiveRun(id: string): Promise<void> {
    const reqSeq = ++runStateCheckSeq;
    const ctx = ctxSeq.value;
    const sessionReq = sessionReqSeq.value;
    const previousRunId = es.activeRunId.value;
    try {
      const data = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
      if (
        reqSeq !== runStateCheckSeq
        || ctx !== ctxSeq.value
        || sessionReq !== sessionReqSeq.value
        || sessionId.value !== id
        || es.esSessionId.value !== id
        || es.activeRunId.value !== previousRunId
      ) return;
      const serverRunId = data.session?.active_run_id;
      if (serverRunId === undefined || serverRunId === '') return;
      const endedRunId = applyServerRunState(serverRunId, previousRunId);
      if (endedRunId) refreshSession(endedRunId);
    } catch (e) {
      console.error('Failed to reconcile workbench run state after SSE connection', e);
    }
  }

  // ---- initWorkspace ----
  // issue #332：不再接 `user` 参数（原参数只为算 isPlatformAdmin，而它已不可达）——
  // 「谁能走到这里」归路由守卫管，不再归 store 管。
  async function initWorkspace() {
    await loadDirs();
    dirCwd.value = dirs.value[0]?.cwd ?? null;
    updateAvailability();
    if (dirs.value.length === 0) {
      // issue #42 语义平移：无目录空态（「先创建目录」）
      return;
    }
    await loadSessions();
  }

  /** issue #84 P5：拉取目录下拉数据源（GET /api/dirs）。↻ 刷新与 initWorkspace 共用。 */
  async function loadDirs() {
    const data = await api<{ dirs?: DirInfo[] }>('/api/dirs');
    dirs.value = data.dirs ?? [];
  }

  /**
   * ↻ 按钮语义：重拉 /api/dirs；选中目录已不在磁盘上时回退到第一个目录并重载会话。
   * 目录树刷新由 SidebarPanel 调 DirectoryTree.reload()（组件持有树状态）。
   */
  async function refreshDirs() {
    await loadDirs();
    if (dirs.value.length === 0) {
      dirCwd.value = null;
      updateAvailability();
      sessions.value = [];
      return;
    }
    if (!dirs.value.some((d) => d.cwd === dirCwd.value)) {
      await selectDir(dirs.value[0].cwd);
    }
  }

  // issue #42 语义平移：无目录 → 禁用输入框/发送/「＋新会话」，placeholder 引导建目录或进入管理台。
  function updateAvailability() {
    noDir.value = dirs.value.length === 0;
  }

  // 侧栏列表：后端默认 limit=20（评审裁决瘦身：不显式传参，无「查看全部」入口）。
  async function loadSessions(): Promise<void> {
    // 评审 LOW-3：请求序号守卫——快速 A→B 切换时，A 的迟到响应不得覆盖 B 的会话列表。
    const reqSeq = ++projectReqSeq.value;
    const qs = new URLSearchParams({ cwd: dirCwd.value! });
    const data = await api<{ items?: Session[] }>(`/api/sessions?${qs.toString()}`);
    if (reqSeq !== projectReqSeq.value) return; // 过期响应：dirCwd 已变，丢弃
    // 防御性客户端过滤：后端按 cwd 过滤为准；响应带 cwd 时二次对齐（契约差异期双保险）。
    sessions.value = (data.items ?? []).filter((s) => !s.cwd || s.cwd === dirCwd.value);
  }

  async function selectDir(cwd: string, opts: { loadSessions?: boolean } = {}) {
    const shouldLoadSessions = opts.loadSessions ?? true;
    es.closeEs();
    // issue #55 A1：离开旧会话前保存输入草稿（空值则清除）；B1：切目录即无选中会话，清深链。
    saveDraft();
    inputValue.value = '';
    workbenchHooks.onClearRoute?.();
    ctxSeq.value++;
    projectReqSeq.value++;
    dirCwd.value = cwd;
    sessionId.value = null;
    sessionMessageCount.value = null; // #197：同 resetSessionView——离开会话不得残留旧计数
    es.resetStreamState();
    clearRetryFace(); // issue #261B：离开/换开会话（selectDir / openSession / createDir / resetSessionView）⇒ 重试面重置
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = null;
    sessions.value = [];
    // 评审修复：与 resetSessionView 对齐的状态复位（旧版同时复位自动跟随/「↓ 最新」/抽屉——
    // 这三项属视图层，由 WorkbenchView 监听 dirCwd/sessionId 变化处理）。
    streamDefaultText();
    updateAvailability();
    if (shouldLoadSessions && dirCwd.value) await loadSessions();
  }

  // 旧 $('stream').innerHTML = '<p class="muted">选择或新建会话</p>' 的等价：
  // 空 entries + 视图据空态渲染默认文案。
  function streamDefaultText() {
    entries.value = [];
  }

  async function openSession(id: string) {
    const previouslyActiveRunId = sessionId.value === id ? es.activeRunId.value : null;
    const reqSeq = ++sessionReqSeq.value;
    const ctx = ctxSeq.value;
    es.closeEs();
    // issue #55 A1：离开旧会话前保存草稿（空值则清除），切回时恢复。
    saveDraft();
    inputValue.value = drafts.get(id) ?? '';
    sessionId.value = id;
    es.resetStreamState();
    clearRetryFace(); // issue #261B：离开/换开会话（selectDir / openSession / createDir / resetSessionView）⇒ 重试面重置
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = new Set();
    entries.value = [];
    sessionMessageCount.value = null; // #197：先清旧会话的计数，加载失败/竞态丢弃时不得串会话残留
    let data: SessionDetail;
    let history: { events: RunHistoryEvent[] } | null = null;
    try {
      // issue #89：详情与展示类事件历史**并行**拉取（转录即真相对齐）；历史端点失败降级为
      // 纯文本视图（旧行为），不影响详情加载。
      const [d, h] = await Promise.all([
        api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`),
        api<{ events: RunHistoryEvent[] }>(`/api/sessions/${encodeURIComponent(id)}/events/history`).catch(() => null),
      ]);
      data = d;
      history = h;
    } catch (e) {
      if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value) return;
      if (e instanceof ApiError && (e.code === 'not_found' || e.status === 404)) {
        resetSessionView(); // issue #55 B1：会话不存在（已删除/深链失效）：静默回退默认视图（清 hash）
        return;
      }
      // 评审修复：其他错误（网络/5xx）区分处理——保留 hash（可刷新重试）+ stream 区 syserr。
      entries.value.push({ kind: 'syserr', text: t('errors.sessionLoadFailed') });
      return;
    }
    if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value) return;
    // #197：头部消息数的权威源——后端全量计数（非分页窗口的 messages 长度）；非法/缺失 → null 回退。
    sessionMessageCount.value = typeof data.session?.message_count === 'number'
      && Number.isFinite(data.session.message_count)
      ? data.session.message_count
      : null;
    es.lastSeq.value = data.last_seq;
    renderedIds.value = new Set();
    // issue #89：messages（addMessage）与历史 run_events（es.replayEvent）按 seq 归并回放——
    // 历史工具卡片走 toolCards/StreamPanel 同一渲染路径（callId 去重），judge → variant='judge'
    // 的 sep，消息与卡片按 seq 正确穿插。replayEvent 为 history 模式：不推进水位线、不驱动
    // 运行态状态机（run_end 已被后端白名单与前端双层短路）。
    const merged: Array<{ seq: number; msg?: ChatMessage; ev?: RunHistoryEvent }> = [
      ...data.messages.map((m) => ({ seq: m.seq ?? 0, msg: m })),
      ...(history?.events ?? []).map((ev) => ({ seq: ev.seq, ev })),
    ];
    merged.sort((a, b) => a.seq - b.seq);
    for (const item of merged) {
      if (item.msg) addMessage(item.msg);
      // issue #300：**在调 replayEvent 之前**分流。partial_output 只存在于历史响应里（不落库、
      // 不进 SSE），既不进 EVENT_TYPES 也不进 HISTORY_REPLAY_TYPES ⇒ 自己推 entry；
      // **不喂 replayEvent**（它拿不到这个 type，自然不产工具卡片/分隔行，也不会「实时一条 + 历史一条」）。
      else if (item.ev && item.ev.type === 'partial_output') addPartialOutput(item.ev);
      else if (item.ev) es.replayEvent(item.ev);
    }
    const serverRunId = data.session.active_run_id;
    if (serverRunId === null || (typeof serverRunId === 'string' && serverRunId !== '')) {
      applyServerRunState(serverRunId, previouslyActiveRunId);
    } else if (previouslyActiveRunId !== null) {
      es.activeRunId.value = previouslyActiveRunId;
    }
    es.connect(id);
  }

  /** 旧 newSess.onclick：建会话 → 列表置顶 → 打开（路由 push 由视图做）。 */
  async function createSession(): Promise<Session | null> {
    const ctx = ctxSeq.value;
    creatingSession.value = true;
    try {
      // issue #84 P5：project_id 退役，改传 cwd（相对形式 ~/projects/<name>，服务端校验 + mkdir）。
      const { session } = await api<{ session: Session }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ cwd: dirCwd.value }),
      });
      if (ctx !== ctxSeq.value) return null;
      sessions.value.unshift({ ...session, active_run_id: null });
      return session;
    } catch (e) {
      if (ctx !== ctxSeq.value) return null;
      alert(t('errors.createSessionFailed', { message: e instanceof Error ? e.message : String(e) }));
      return null;
    } finally {
      creatingSession.value = false;
    }
  }

  /**
   * issue #84 P5「＋ 新建目录」：取简实现——直接以该 cwd 建会话，服务端校验 + mkdir 顺带确保目录；
   * 成功后切到该目录上下文并把新会话置顶（视图 emit select-session 打开）。返回错误文案；error=null 成功。
   */
  async function createDir(name: string): Promise<{ error: string | null; session?: Session }> {
    if (!DIR_NAME_RE.test(name)) {
      return { error: t('errors.dirNameInvalid') };
    }
    const cwd = `~/projects/${name}`;
    let session: Session;
    try {
      ({ session } = await api<{ session: Session }>('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      }));
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
    // 目录上下文切换（等价 selectDir 的复位语义）：关流/存草稿/清深链/复位协议状态。
    es.closeEs();
    saveDraft();
    inputValue.value = '';
    workbenchHooks.onClearRoute?.();
    ctxSeq.value++;
    projectReqSeq.value++;
    dirCwd.value = cwd;
    sessionId.value = null;
    sessionMessageCount.value = null; // #197：同 resetSessionView——离开会话不得残留旧计数
    es.resetStreamState();
    clearRetryFace(); // issue #261B：离开/换开会话（selectDir / openSession / createDir / resetSessionView）⇒ 重试面重置
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = null;
    sessions.value = [];
    streamDefaultText();
    // 目录列表兜底补齐（服务端 mkdir 后该目录必然存在于磁盘，正常路径 loadDirs 也能看到）。
    if (!dirs.value.some((d) => d.cwd === cwd)) {
      dirs.value.push({ name, cwd, running_count: 0, queued_count: 0 });
    }
    updateAvailability();
    sessions.value.unshift({ ...session, active_run_id: null });
    return { error: null, session };
  }

  /**
   * issue #107：侧栏内联重命名——PATCH /api/sessions/:id {title}，成功后**原地**更新列表项
   * `title`/`title_source`（不整表 loadSessions：重命名不影响排序语义之外的任何字段）。
   * 空串/纯空白本地拦截（不发请求）：空串落库会置 title_source='manual'，**永久关掉**后续自动命名
   * （issue #88 守卫）——宁可无操作。超长按 SESSION_TITLE_MAX_LEN 截断（与后端 ≤200 口径一致）。
   * @returns error=null 成功；否则为错误文案（失败**不动** store，调用方回退展示旧标题）。
   */
  async function renameSession(id: string, title: string): Promise<{ error: string | null }> {
    const clean = title.trim().slice(0, SESSION_TITLE_MAX_LEN);
    if (!clean) return { error: t('errors.renameEmpty') };
    try {
      const { session } = await patchSessionTitle(id, clean);
      const item = sessions.value.find((s) => String(s.id) === String(id));
      if (item) {
        item.title = session.title;
        item.title_source = session.title_source ?? 'manual';
      }
      return { error: null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * issue #114：「AI 改名」——POST /api/sessions/:id/ai-title，成功后**原地**更新列表项
   * `title`/`title_source`（同 renameSession 的原地更新模式，不整表 loadSessions）。
   * 失败**不动** store（旧标题保留），返回错误文案供调用方做行内提示。
   * @returns error=null 成功；否则为服务端 error.message（409 无 provider / 502 上游失败）
   */
  async function aiRenameSession(id: string): Promise<{ error: string | null }> {
    try {
      const { session } = await postSessionAiTitle(id);
      const item = sessions.value.find((s) => String(s.id) === String(id));
      if (item) {
        item.title = session.title;
        item.title_source = session.title_source ?? 'manual';
      }
      return { error: null };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 深链解析（旧 resolveHashSession；跨项目切项目由调用方决定路由写回）。 */
  async function resolveRouteSession(sid: string): Promise<void> {
    if (sessions.value.some((s) => String(s.id) === String(sid))) {
      await openSession(sid);
      return;
    }
    let session: Session;
    try {
      ({ session } = await api<{ session: Session }>(`/api/sessions/${encodeURIComponent(sid)}`));
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'not_found' || e.status === 404)) {
        resetSessionView(); // 深链失效：静默回退默认视图（含清 hash）
        return;
      }
      entries.value.push({ kind: 'syserr', text: t('errors.sessionLoadFailed') });
      return;
    }
    // issue #281：`session` 本身可能就是**缺的**（旧后端/网关改写回包、200 但没 `session` 键）。
    // 旧代码在这里直接读 `session.cwd` ⇒ `TypeError: Cannot read properties of undefined (reading
    // 'cwd')`，而它在 onMounted 的 await 链上 ⇒ 变成 Unhandled Rejection（AGENTS §8.20 记的那处，
    // 行号已漂到这一行）。判空后**照样报可见错误**——判空不是吞掉真实错误，只是不再拿 TypeError 代替它。
    if (session == null || typeof session !== 'object') {
      entries.value.push({ kind: 'syserr', text: t('errors.sessionLoadFailed') });
      return;
    }
    // issue #84 P5：跨目录深链——会话详情带 cwd，切到其目录（磁盘推导视图必有该目录；
    // 防御性兜底：列表缺项时合成一个，避免下拉空白）。
    const cwd = session.cwd;
    if (cwd && cwd !== dirCwd.value) {
      if (!dirs.value.some((d) => d.cwd === cwd)) {
        dirs.value.push({ name: cwd.split('/').pop() ?? cwd, cwd, running_count: 0, queued_count: 0 });
      }
      await selectDir(cwd);
    }
    await openSession(sid);
    // 评审修复：selectDir 会清路由（旧版抹 hash），这里把深链写回（replace 无害 no-op）。
    workbenchHooks.onDeepLinkRestored?.(sid);
  }

  /**
   * issue #281：把一条**人看得见**的错误推进消息流（复用既有 `.syserr` 红色错误行，**不新增 UI
   * 结构**）。给 `onMounted` 这类「Vue 不等的异步钩子」用：失败必须落到界面上，而不是只活在控制台。
   * 文案由调用方过 `toDisplayText` 收口（不许渗 `[object Object]` / `undefined`）。
   */
  function pushStreamError(text: string): void {
    entries.value.push({ kind: 'syserr', text });
  }

  /** issue #55 B1：会话不存在/popstate 回退 → 静默回默认视图（不动项目/会话列表，只清详情区）。 */
  function resetSessionView() {
    es.closeEs();
    // issue #55 A1：popstate 回退也属「离开会话」，先存草稿（空值则清除）。
    saveDraft();
    sessionId.value = null;
    sessionMessageCount.value = null; // #197：无选中会话 → 不得复用旧会话的计数
    es.resetStreamState();
    clearRetryFace(); // issue #261B：离开/换开会话（selectDir / openSession / createDir / resetSessionView）⇒ 重试面重置
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = null;
    inputValue.value = '';
    streamDefaultText();
    workbenchHooks.onClearRoute?.();
  }

  /**
   * 发送链路（唯一一条）：自动建会话、草稿守卫、ctx/session 代次守卫、失败回填都在此。
   *
   * issue #261B：`contentOverride` = 重试链路传入的「上一条内容」。传了就用它作为发送体，
   * 且**不碰输入框**（不吞用户可能存在的草稿）；缺省（undefined）仍取 inputValue，既有行为逐字不变。
   * 重试绝不另起一次 api() 调用——绕过这里就等于绕过建会话/草稿/代次守卫（工单硬要求）。
   */
  async function send(contentOverride?: string) {
    const override = typeof contentOverride === 'string';
    const content = (override ? contentOverride! : inputValue.value).trim();
    if (!content || es.activeRunId.value) return;
    // issue #84 P5 真机验收修正：选了目录但未打开会话时，首条发送自动建会话（原实现 !sid 静默返回，
    // 用户「选目录→打字→发送」没有任何反馈）。目录未选中（空 projects）才保持 no-op。
    if (!sessionId.value) {
      if (!dirCwd.value) return;
      const created = await createSession();
      if (!created) return; // 建会话失败已 alert，输入内容保留
      // createSession 只建不开（开=视图层路由职责）；发送链路里必须显式打开，
      // 否则 sid 仍为空、消息发不出（18:32 真机实证：会话建了、输入还在）。
      await openSession(created.id);
    }
    const ctx = ctxSeq.value;
    const sid = sessionId.value;
    if (!sid) return;
    // issue #55 A7：首次发送属用户手势，此时申请桌面通知权限（浏览器要求 gesture 触发）；不支持/被拒静默降级。
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try { Notification.requestPermission().catch(() => {}); } catch { /* 忽略 */ }
    }
    if (!override) inputValue.value = ''; // 重试（override）不碰输入框：不吞与重试无关的草稿
    try {
      const { message, run } = await api<{ message: ChatMessage; run: { id: string } }>(
        `/api/sessions/${encodeURIComponent(sid)}/messages`,
        { method: 'POST', body: JSON.stringify({ content, attachments: [] }) },
      );
      // 评审修复：API 成功返回后才删草稿，且在守卫判定之前无条件执行（原先 await 前删，失败即丢草稿）。
      drafts.delete(sid);
      // issue #261B：POST 成功即记「上一条」（失败路径不记，否则会把没发出去的内容当成可重试面）。
      // 同时作废旧的失败重试面：用户已主动发新东西，不必再保留上一条的入口。
      lastSend.value = { sessionId: sid, content };
      retryAvailable.value = false;
      if (ctx !== ctxSeq.value || sessionId.value !== sid) return;
      addMessage({ ...message, role: 'user' });
      es.activeRunId.value = run.id;
      loadSessions();
    } catch (e) {
      // 评审修复：草稿按 sid 键，守卫之前写回——发送失败后即使期间切走会话，切回仍可恢复。
      drafts.set(sid, content);
      if (ctx !== ctxSeq.value || sessionId.value !== sid) return;
      if (!override) inputValue.value = content; // issue #42：发送失败回填输入，已输入内容不丢
      const err = e instanceof ApiError ? e : null;
      entries.value.push({
        kind: 'syserr',
        // issue #41：LLM 未绑定预检 409 → 友好指引（fde 角色可能无 /admin 权限 → 措辞兜底「联系管理员」）。
        text: err?.code === 'llm_not_configured'
          ? t('errors.sendFailedLlmNotConfigured')
          // issue #261014 切片 B2：`llm_model_not_found`（绑定的模型 id 在网关里已不存在）给专用指引；
          // 槽位与模型 id 取自服务端 `error.details`，一律经 `toDisplayText` 收口
          // ⇒ 脏值（嵌套对象 / 非字符串）退化成 JSON 文本，绝不演成 `[object Object]`。
          : err?.code === 'llm_model_not_found'
            ? t('errors.sendFailedLlmModelNotFound', {
              slot: toDisplayText(err.details?.slot).trim() || '-',
              model_id: toDisplayText(err.details?.model_id).trim() || '-',
            })
            : t('errors.sendFailed', { message: err?.message ?? e })
              + (err?.code === 'run_in_progress' ? t('errors.runInProgress') : ''),
      });
    }
  }

  /**
   * issue #261B：一键重试上一条——同 content、新一次 POST，**复用同一条 send() 链路**。
   * 前置守卫（任一条不满 ⇒ no-op）：retryAvailable、不在 in-flight、有会话、无活跃 run、
   * 内容非空且归属于当前会话、输入框无草稿（与 ComposerBar 按钮的显隐条件同源，
   * 免得把用户刚打的草稿吞掉）。重试 POST 失败 ⇒ retryAvailable 保留（按钮可再点）。
   */
  async function retryLast() {
    const last = lastSend.value;
    if (!retryAvailable.value || retryInFlight.value) return;
    if (!sessionId.value || es.activeRunId.value) return;
    if (!last || last.sessionId !== sessionId.value || !last.content.trim()) return;
    if (inputValue.value.trim()) return;
    retryInFlight.value = true; // 按钮禁用（防双击双发）
    try {
      await send(last.content);
    } finally {
      retryInFlight.value = false;
    }
  }

  async function stop() {
    if (!sessionId.value || !es.activeRunId.value) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId.value)}/stop`, { method: 'POST', body: '{}' });
      entries.value.push({ kind: 'sep', text: t('workbench.stopRequested') });
    } catch (e) {
      alert(t('errors.stopFailed', { message: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function refreshSession(runId?: string) {
    const reqSeq = sessionReqSeq.value;
    const ctx = ctxSeq.value;
    const sid = sessionId.value;
    try {
      const data = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(sid!)}`);
      if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value || sessionId.value !== sid) return;
      // #197：刷新是重取详情——同步刷新头部消息数的权威源（run 终态后总数会变）。
      sessionMessageCount.value = typeof data.session?.message_count === 'number'
        && Number.isFinite(data.session.message_count)
        ? data.session.message_count
        : null;
      const msgs = data.messages.filter((m) => m.run_id === runId && m.role === 'assistant' && !m.synthetic);
      for (const m of msgs) addMessage(m);
      await loadSessions();
    } catch { /* 尽力 */ }
  }

  // issue #55 A7：run_end 且页面在后台且已授权 → 桌面通知（标题含会话标题，点击聚焦标签页）；不支持的浏览器静默降级。
  function notifyRunEnd(d: RunEndPayload) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (!document.hidden) return;
      const sess = sessions.value.find((s) => String(s.id) === String(sessionId.value));
      const title = sess?.title || t('common.unnamedSession');
      const reason = d.termination?.reason ?? '';
      const failed = RUN_FAIL_REASONS.has(reason) || !!d.error;
      const body = d.error
        ? t('workbench.notifyFailed', { code: d.error.code, message: d.error.message })
        : failed ? t('workbench.notifyEnded', { reason }) : t('workbench.notifyDone');
      const n = new Notification(`FDE Station · ${title}`, { body });
      n.onclick = () => { window.focus(); n.close(); };
    } catch { /* 构造通知可能抛错（非安全上下文等）：静默忽略 */ }
  }

  return {
    // state
    dirs, dirCwd, sessions, sessionId, noDir,
    entries, renderedIds, inputValue, creatingSession,
    drafts, es,
    // computed
    currentDir, running, sendDisabled, inputPlaceholder, newSessDisabled,
    // helpers
    sessMeta,
    // actions
    initWorkspace, updateAvailability, loadDirs, refreshDirs, loadSessions, selectDir, openSession,
    createSession, createDir, resolveRouteSession, resetSessionView, renameSession, aiRenameSession,
    saveDraft, addMessage, addPartialOutput, send, stop, refreshSession,
    pushStreamError,
    // issue #306：导出让单测能直接驱动「终态后补拉 history」的窄条件（不靠拼 SSE 帧也能钉零重拉）。
    repullPartialOutput,
    // issue #261B：一键「重试上一条」（lastSend/retryAvailable 仅内存；retryInFlight 驱动按钮禁用）
    lastSend, retryAvailable, retryInFlight, retryLast,
    // issue #189：折叠段原文懒加载 + 会话头部状态行计数
    foldedOriginals, getFoldedOriginal, loadFoldedOriginal, sessionStats,
  };
});
