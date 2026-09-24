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
import { api, ApiError } from '../api';
import { useEventStream, RUN_FAIL_REASONS, type RunEndPayload } from '../composables/useEventStream';
import { renderMarkdown } from '../lib/markdown';
import { DIR_NAME_RE } from '../lib/constants';

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
  updated_at?: string;
  active_run_id?: string | null;
  cwd?: string; // issue #84 P5：会话绑定目录（响应带 cwd）
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  synthetic?: boolean;
  run_id?: string | null;
}

/** 消息流渲染单元（旧版 DOM 追加序的数组等价）。 */
export type StreamEntry =
  | { kind: 'msg'; id: string; role: string; synthetic: boolean; text: string; html: string | null }
  | { kind: 'sep'; text: string }
  | { kind: 'syserr'; text: string }
  | { kind: 'tool'; callId: string }
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
    onSep: (text) => entries.value.push({ kind: 'sep', text }),
    onSysErr: (text) => entries.value.push({ kind: 'syserr', text }),
    onToolCardCreated: (callId) => entries.value.push({ kind: 'tool', callId }),
    onCurrentRunEnd: (d) => {
      removeDeltaEntry(); // 旧版 run_end 移除流式增量 DOM（终稿由 refreshSession 回写，防双份）
      notifyRunEnd(d);
      refreshSession(d.run_id);
    },
  });

  // ---- 计算属性（旧 updateProjectMeta / updateWorkspaceAvailability / setRunning 的响应式等价）----
  /** 当前选中目录（顶栏 cwd 徽标 / 下拉高亮用）。 */
  const currentDir = computed(() => dirs.value.find((d) => d.cwd === dirCwd.value) ?? null);
  const running = computed(() => es.activeRunId.value != null);
  const sendDisabled = computed(() => running.value || noDir.value);
  const inputPlaceholder = computed(() =>
    isPlatformAdmin.value
      ? '平台管理员：请到管理台创建 FDE 用户与分配资源'
      : noDir.value
        ? '先创建目录'
        : '输入任务，Enter 发送（Shift+Enter 换行）',
  );
  const newDirDisabled = computed(() => isPlatformAdmin.value);
  const newSessDisabled = computed(() => noDir.value || creatingSession.value);
  // 会话列表项 meta 行（● 运行中 / 本地化时间）
  function sessMeta(s: Session): string {
    return s.active_run_id
      ? '● 运行中'
      : new Date(s.updated_at ?? 0).toLocaleString('zh-CN');
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
    // 仅助手终稿渲染 Markdown 子集（先转义后格式化，XSS 安全）；用户消息与系统注入
    // （synthetic）保持纯文本。流式增量（delta）全程文本追加，run_end 终稿经
    // refreshSession → addMessage 整体渲染（半截 ``` 不炸布局）。
    const isMd = m.role === 'assistant' && !m.synthetic;
    entries.value.push({
      kind: 'msg',
      id: m.id,
      role: m.role,
      synthetic: !!m.synthetic,
      text: (m.synthetic ? '〔系统注入〕' : '') + m.content,
      html: isMd ? renderMarkdown(m.content) : null,
    });
  }

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

  async function loadSessions() {
    // 评审 LOW-3：请求序号守卫——快速 A→B 切换时，A 的迟到响应不得覆盖 B 的会话列表。
    const reqSeq = ++projectReqSeq.value;
    const data = await api<{ items?: Session[] }>(`/api/sessions?cwd=${encodeURIComponent(dirCwd.value!)}`);
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
    renderedIds.value = new Set();
    entries.value = [];
    let data: SessionDetail;
    try {
      data = await api<SessionDetail>(`/api/sessions/${encodeURIComponent(id)}`);
    } catch (e) {
      if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value) return;
      if (e instanceof ApiError && (e.code === 'not_found' || e.status === 404)) {
        resetSessionView(); // issue #55 B1：会话不存在（已删除/深链失效）：静默回退默认视图（清 hash）
        return;
      }
      // 评审修复：其他错误（网络/5xx）区分处理——保留 hash（可刷新重试）+ stream 区 syserr。
      entries.value.push({ kind: 'syserr', text: '会话加载失败，可刷新重试' });
      return;
    }
    if (reqSeq !== sessionReqSeq.value || ctx !== ctxSeq.value) return;
    es.lastSeq.value = data.last_seq;
    renderedIds.value = new Set();
    for (const m of data.messages) addMessage(m);
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
      alert('建会话失败：' + (e instanceof Error ? e.message : String(e)));
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
      return { error: '目录名必须符合：小写字母/数字/连字符，且不能以连字符开头或结尾（最多 63 个字符）' };
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
      entries.value.push({ kind: 'syserr', text: '会话加载失败，可刷新重试' });
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
          ? '发送失败：该 FDE 未配置 LLM 上游，请到管理台 /admin 配置（无权限请联系管理员）'
          : `发送失败：${err?.message ?? e}${err?.code === 'run_in_progress' ? '（已有进行中任务）' : ''}`,
      });
    }
  }

  async function stop() {
    if (!sessionId.value || !es.activeRunId.value) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(sessionId.value)}/stop`, { method: 'POST', body: '{}' });
      entries.value.push({ kind: 'sep', text: '已请求停止…' });
    } catch (e) {
      alert('停止失败：' + (e instanceof Error ? e.message : String(e)));
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
      const title = sess?.title || '未命名会话';
      const reason = d.termination?.reason ?? '';
      const failed = RUN_FAIL_REASONS.has(reason) || !!d.error;
      const body = d.error
        ? `运行失败：${d.error.code} — ${d.error.message}`
        : failed ? `运行结束：${reason}` : '运行完成';
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
    createSession, createDir, resolveRouteSession, resetSessionView,
    saveDraft, addMessage, send, stop, refreshSession,
  };
});
