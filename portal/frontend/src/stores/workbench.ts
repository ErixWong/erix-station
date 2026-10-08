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
import { api, ApiError, patchSessionTitle, postSessionAiTitle } from '../api';
import { i18n } from '../i18n';
import { useEventStream, RUN_FAIL_REASONS, type RunEndPayload, type RunHistoryEvent } from '../composables/useEventStream';
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
  executionStatus?: string;
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
  | { kind: 'delta'; text: string };

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
 * issue #188 工具卡片 key：优先上游 provider `id`——它与实时/历史事件流的 `tool_call_id` 同源，
 * 两条路据此天然幂等归并（同一调用只渲染一张卡片）。`id` 缺失/重复由 provider 决定（可缺失/可重复）；
 * erix-agent 0.16.0 起上游为每个 toolCall 提供稳定视图键 `call.key`（由输入位置生成、单次投影内唯一、
 * 同输入确定性；**不是持久 ID、也不是 provider `tool_use.id`**）→ `id` 缺失时用它作卡片身份，
 * 不再自造 `proj:<锚点 id>:<序号>`（仅当 `id`/`key` 都缺失时保留该兜底）。
 */
function toolCallKey(messageId: string, call: ProjectedToolCall, index: number): string {
  if (typeof call.id === 'string' && call.id !== '') return call.id;
  if (typeof call.key === 'string' && call.key !== '') return call.key;
  return `proj:${messageId}:${index}`;
}

export const useWorkbenchStore = defineStore('workbench', () => {
  // ---- S 状态平移 ----
  const dirs = ref<DirInfo[]>([]);
  const dirCwd = ref<string | null>(null); // 选中目录（页面级状态）
  const sessions = ref<Session[]>([]);
  const sessionId = ref<string | null>(null);
  const noDir = ref(false);
  const projectReqSeq = ref(0); // 迟到响应丢弃（快速 A→B 切换）
  const sessionReqSeq = ref(0);
  const ctxSeq = ref(0); // 项目上下文代次
  const entries = ref<StreamEntry[]>([]); // 消息流（含分隔行/工具卡片占位）
  const renderedIds = ref<Set<string> | null>(null); // 去重（refresh 与流式缓冲竞态）
  const inputValue = ref(''); // composer 输入（旧 $('input').value）
  const creatingSession = ref(false); // 旧 newSess 按钮禁用语义
  const isPlatformAdmin = ref(false); // user.role === 'admin' && !user.fde_name（平台管理员）

  // issue #55 A1：per-session 输入草稿（内存 Map，key=sessionId）；切换会话/项目时保存与恢复。
  const drafts = new Map<string, string>();

  // SSE 协议状态 + 事件语义（hooks 接回展示层）。
  const es = useEventStream({
    onSep: (text, variant) => entries.value.push({ kind: 'sep', text, variant }),
    onSysErr: (text) => entries.value.push({ kind: 'syserr', text }),
    onToolCardCreated: (callId) => entries.value.push({ kind: 'tool', callId }),
    onCurrentRunEnd: (d) => {
      removeDeltaEntry(); // 旧版 run_end 移除流式增量 DOM（终稿由 refreshSession 回写，防双份）
      notifyRunEnd(d);
      refreshSession(d.run_id);
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
    isPlatformAdmin.value
      ? t('common.platformAdminHint')
      : noDir.value
        ? t('common.createFirstDir')
        : t('workbench.inputPlaceholder'),
  );
  const newDirDisabled = computed(() => isPlatformAdmin.value);
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

  // ---- addMessage（issue #40 渲染规则逐行平移）----
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
        es.projectToolCard(toolCallKey(m.id, call, index), call);
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
   * issue #189（追加）：当前会话头部状态行数据（前端已有数据，不改后端/不加 API）：
   * messages = 已加载消息条数（msg entry 数），folded = DTO 带 folded 字段的消息条数
   * （每有折叠的消息只推一条 folded entry，故两者相等）。无选中会话 → null（不渲染）。
   */
  const sessionStats = computed(() => {
    if (!sessionId.value) return null;
    let messages = 0;
    let folded = 0;
    for (const en of entries.value) {
      if (en.kind === 'msg') messages++;
      else if (en.kind === 'folded') folded++;
    }
    return { messages, folded };
  });

  // ---- 流式增量气泡（旧 S.deltaBuf DOM 的数组等价：round_start 后半截增量留在流里）----
  let deltaEntry: Extract<StreamEntry, { kind: 'delta' }> | null = null;
  watch(es.deltaText, (v, old) => {
    if (v === null) { deltaEntry = null; return; }
    if (old === null) {
      deltaEntry = { kind: 'delta', text: '' };
      entries.value.push(deltaEntry);
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

  // ---- initWorkspace ----
  async function initWorkspace(user: { role: string; fde_name: string | null }) {
    isPlatformAdmin.value = user.role === 'admin' && !user.fde_name;
    await loadDirs();
    dirCwd.value = dirs.value[0]?.cwd ?? null;
    updateAvailability();
    if (dirs.value.length === 0) {
      // issue #42 语义平移：无目录空态（平台管理员引导进管理台）
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
    es.resetStreamState();
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
    const reqSeq = ++sessionReqSeq.value;
    const ctx = ctxSeq.value;
    es.closeEs();
    // issue #55 A1：离开旧会话前保存草稿（空值则清除），切回时恢复。
    saveDraft();
    inputValue.value = drafts.get(id) ?? '';
    sessionId.value = id;
    es.resetStreamState();
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = new Set();
    entries.value = [];
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
      else if (item.ev) es.replayEvent(item.ev);
    }
    if (data.session.active_run_id) {
      es.activeRunId.value = data.session.active_run_id;
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
    es.resetStreamState();
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

  /** issue #55 B1：会话不存在/popstate 回退 → 静默回默认视图（不动项目/会话列表，只清详情区）。 */
  function resetSessionView() {
    es.closeEs();
    // issue #55 A1：popstate 回退也属「离开会话」，先存草稿（空值则清除）。
    saveDraft();
    sessionId.value = null;
    es.resetStreamState();
    // issue #85：离开会话/目录切换时清空工具卡片展开记忆（toolCallExpansion）。
    clearExpandedToolCalls();
    renderedIds.value = null;
    inputValue.value = '';
    streamDefaultText();
    workbenchHooks.onClearRoute?.();
  }

  async function send() {
    const content = inputValue.value.trim();
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
    inputValue.value = '';
    try {
      const { message, run } = await api<{ message: ChatMessage; run: { id: string } }>(
        `/api/sessions/${encodeURIComponent(sid)}/messages`,
        { method: 'POST', body: JSON.stringify({ content, attachments: [] }) },
      );
      // 评审修复：API 成功返回后才删草稿，且在守卫判定之前无条件执行（原先 await 前删，失败即丢草稿）。
      drafts.delete(sid);
      if (ctx !== ctxSeq.value || sessionId.value !== sid) return;
      addMessage({ ...message, role: 'user' });
      es.activeRunId.value = run.id;
      loadSessions();
    } catch (e) {
      // 评审修复：草稿按 sid 键，守卫之前写回——发送失败后即使期间切走会话，切回仍可恢复。
      drafts.set(sid, content);
      if (ctx !== ctxSeq.value || sessionId.value !== sid) return;
      inputValue.value = content; // issue #42：发送失败回填输入，已输入内容不丢
      const err = e instanceof ApiError ? e : null;
      entries.value.push({
        kind: 'syserr',
        // issue #41：LLM 未绑定预检 409 → 友好指引（fde 角色可能无 /admin 权限 → 措辞兜底「联系管理员」）。
        text: err?.code === 'llm_not_configured'
          ? t('errors.sendFailedLlmNotConfigured')
          : t('errors.sendFailed', { message: err?.message ?? e })
            + (err?.code === 'run_in_progress' ? t('errors.runInProgress') : ''),
      });
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
    entries, renderedIds, inputValue, creatingSession, isPlatformAdmin,
    drafts, es,
    // computed
    currentDir, running, sendDisabled, inputPlaceholder, newDirDisabled, newSessDisabled,
    // helpers
    sessMeta,
    // actions
    initWorkspace, updateAvailability, loadDirs, refreshDirs, loadSessions, selectDir, openSession,
    createSession, createDir, resolveRouteSession, resetSessionView, renameSession, aiRenameSession,
    saveDraft, addMessage, send, stop, refreshSession,
    // issue #189：折叠段原文懒加载 + 会话头部状态行计数
    foldedOriginals, getFoldedOriginal, loadFoldedOriginal, sessionStats,
  };
});
