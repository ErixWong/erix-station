// 宏用户面 store（pinia，issue #528 / 事件平台 W5）。形状照 `stores/workbench.ts`：
// `defineStore(id, () => {...})` 的 setup 写法 + 「一次 action = 一次请求」+ 错误透传。
//
// 端点是 W3 建好的那几个（`portal/src/macro-routes.js` + `http.js` 的匹配链，契约 `10` 篇 §3）：
//   GET     /api/macro-templates                  用户面模板（只回 `audience='all'` 且启用的）
//   GET|PUT /api/sessions/:id/macro-assignments    订阅读/写（PUT 幂等 upsert）
//   DELETE  /api/sessions/:id/macro-assignments/:assignmentId
//   GET     /api/sessions/:id/macro-runs           会话流水（keyset 游标）
//   GET     /api/notifications                     通知列表
//   GET     /api/notifications/unread-count        未读数（后端把它注册在 `/:id` 之前）
//   POST    /api/notifications/:id/read            标记已读（幂等）
//
// 三条纪律：
//  1. **DTO 归一化全在 `lib/macroView.ts`**：`snapshot_id` / `worktree_path` 在归一层就被丢掉，
//     所以「用户看不到」不是靠渲染时记得不印。
//  2. **面板关着一个请求都不发**（`07` §16）：轮询只由抽屉的开/关驱动，终态即停。
//  3. 枚举一律来自 `@shared/macro-kinds`（契约 `10` 篇 §1）。
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { VERDICT } from '@shared/macro-kinds';
import { api, ApiError, toDisplayText } from '../api';
import {
  normalizeAssignment,
  normalizeNotification,
  normalizeRun,
  normalizeTemplate,
  panelState,
  watermarkState,
  type MacroAssignment,
  type MacroNotification,
  type MacroPanelState,
  type MacroRun,
  type MacroTemplate,
  type WatermarkState,
} from '../lib/macroView';

/** 端点路径（唯一真相：store 与测试共用，不在用例里重抄一遍字面量）。 */
export const MACRO_TEMPLATES_PATH = '/api/macro-templates';
export const NOTIFICATIONS_PATH = '/api/notifications';
export const NOTIFICATIONS_UNREAD_PATH = '/api/notifications/unread-count';

export const macroAssignmentsPath = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/macro-assignments`;

export const macroAssignmentPath = (sessionId: string, assignmentId: string): string =>
  `${macroAssignmentsPath(sessionId)}/${encodeURIComponent(assignmentId)}`;

export const macroRunsPath = (sessionId: string): string =>
  `/api/sessions/${encodeURIComponent(sessionId)}/macro-runs`;

/** `07` §16：有未完成的记录才轮询，间隔 2s。 */
export const MACRO_POLL_INTERVAL_MS = 2_000;
/** 一次拉多少条流水（后端 `limit` 上限 100，契约 §3.1）。 */
export const MACRO_RUNS_LIMIT = 50;
export const NOTIFICATIONS_LIMIT = 30;

export const useMacroStore = defineStore('macro', () => {
  // ── 状态 ───────────────────────────────────────────────────────────────────
  const templates = ref<MacroTemplate[]>([]);
  const templatesLoading = ref(false);
  const templatesFailed = ref(false);
  const templatesLoaded = ref(false);

  /** 当前会话的订阅（`scope='user'` 的流水不在会话面显示，`07` §19.1）。 */
  const assignments = ref<MacroAssignment[]>([]);
  const runs = ref<MacroRun[]>([]);
  /** 流水的加载态：**首次加载 / 失败 / 已加载**三者分开（`07` §17.1「加载失败不能伪装成空」）。 */
  const runsLoading = ref(false);
  const runsFailed = ref(false);
  const runsLoaded = ref(false);
  const runsErrorText = ref<string | null>(null);
  const runsNextCursor = ref<string | null>(null);

  /** 两个筛选（`09` §3.2：用户的筛选**只有两个**——模板 / 判决）。 */
  const filterTemplateId = ref<string | null>(null);
  const filterVerdict = ref<string | null>(null);

  const notifications = ref<MacroNotification[]>([]);
  const notificationsLoading = ref(false);
  const notificationsFailed = ref(false);
  const notificationsLoaded = ref(false);
  const unreadCount = ref(0);

  /** 抽屉开合（轮询的唯一开关）。 */
  const drawerOpen = ref(false);
  const pollingSession = ref<string | null>(null);
  const pollTimer = ref<ReturnType<typeof setTimeout> | null>(null);

  // ── 计算属性 ────────────────────────────────────────────────────────────────

  /** 会话级可订模板（`07` §3.2：用户面只列 `scope='session'` 的）。 */
  const sessionTemplates = computed(() => templates.value.filter((t) => t.scope === 'session'));
  /** 顶栏那份列用户级模板（`user` scope 由管理员代配，用户面只读不订）。 */
  const userTemplates = computed(() => templates.value.filter((t) => t.scope === 'user'));

  const assignmentByTemplate = computed(() => {
    const map = new Map<string, MacroAssignment>();
    for (const a of assignments.value) map.set(a.templateId, a);
    return map;
  });

  const enabledAssignments = computed(() => assignments.value.filter((a) => a.effectiveEnabled));

  /** 模板筛选在本地过滤：会话流水端点**没有** `templateId` 参数（`macro-routes.js#sessionMacroRuns`
   *  只吃 `criterion`/`verdict`）⇒ 宁可本地筛，也不在前端假装后端支持。 */
  const visibleRuns = computed(() => {
    if (!filterTemplateId.value) return runs.value;
    const ids = new Set(
      assignments.value.filter((a) => a.templateId === filterTemplateId.value).map((a) => a.id),
    );
    return runs.value.filter((r) => ids.has(r.assignmentId));
  });

  const filterActive = computed(() => filterTemplateId.value !== null || filterVerdict.value !== null);

  /**
   * 注入时钟（判据⑤「水位线陈旧」要能用固定时刻测）。默认 `Date.now()`；
   * 测试里 `setClock(() => FIXED)` 后再挂载组件即可。不用 `ref` 包住：时刻不是渲染数据，
   * 响应性由 `assignments` / 手动 `refresh` 驱动（健康位只在重算时读一次）。
   */
  let clock: () => number = () => Date.now();
  const now = (): number => clock();
  const setClock = (next: () => number): void => {
    clock = next;
  };

  /** 判决下拉的选项（**列表本身来自 shared 枚举**，不在前端重抄一遍）。 */
  const verdictOptions = computed<string[]>(() => [...VERDICT]);

  /** 空态四选一 + 两个技术态（判据①）。 */
  const panelStateValue = computed<MacroPanelState>(() => panelState({
    loading: runsLoading.value && !runsLoaded.value,
    failed: runsFailed.value,
    assignments: assignments.value,
    runs: visibleRuns.value,
    filterActive: filterActive.value,
  }));

  /** 有未完成的记录 ⇒ 才继续轮询。 */
  const hasPending = computed(() => runs.value.some((r) => r.pending));

  // ── 请求 ───────────────────────────────────────────────────────────────────

  let templatesInFlight: Promise<void> | null = null;

  /** 模板列表：单飞（会话头 chip 与顶栏 chip 同时挂载时只发一次）。 */
  async function loadTemplates(force = false): Promise<void> {
    if (templatesLoaded.value && !force) return;
    if (templatesInFlight) return templatesInFlight;
    templatesLoading.value = true;
    templatesInFlight = (async () => {
      try {
        const body = await api<{ items?: Record<string, unknown>[] }>(MACRO_TEMPLATES_PATH);
        templates.value = (body?.items ?? [])
          .map(normalizeTemplate)
          .filter((t): t is MacroTemplate => t !== null);
        templatesFailed.value = false;
        templatesLoaded.value = true;
      } catch {
        templatesFailed.value = true;
      } finally {
        templatesLoading.value = false;
        templatesInFlight = null;
      }
    })();
    return templatesInFlight;
  }

  /** 订阅列表（抽屉顶部的订阅卡片 + chip 上的「已启用 N 个」）。 */
  async function loadAssignments(sessionId: string): Promise<void> {
    if (!sessionId) return;
    try {
      const body = await api<{ items?: Record<string, unknown>[] }>(macroAssignmentsPath(sessionId));
      assignments.value = (body?.items ?? [])
        .map(normalizeAssignment)
        .filter((a): a is MacroAssignment => a !== null);
    } catch {
      // 订阅读失败**不**把流水判成失败（两个资源各自显示各自的错误，§17.1）。
      assignments.value = [];
    }
  }

  /** 拉流水（首次 / 手动 ↻ / 轮询都走这里；`silent` 时不把 loading 翻起来）。 */
  async function loadRuns(sessionId: string, opts: { silent?: boolean } = {}): Promise<void> {
    if (!sessionId) return;
    const silent = opts.silent === true;
    if (!silent) runsLoading.value = true;
    const params = new URLSearchParams({ limit: String(MACRO_RUNS_LIMIT) });
    // 判决筛选走服务端（后端会按枚举校验 `verdict`）。
    if (filterVerdict.value) params.set('verdict', filterVerdict.value);
    try {
      const body = await api<{ items?: Record<string, unknown>[]; nextCursor?: string | null }>(
        `${macroRunsPath(sessionId)}?${params.toString()}`,
      );
      runs.value = (body?.items ?? [])
        .map(normalizeRun)
        .filter((r): r is MacroRun => r !== null);
      runsNextCursor.value = body?.nextCursor ?? null;
      runsFailed.value = false;
      runsErrorText.value = null;
      runsLoaded.value = true;
    } catch (error) {
      runsFailed.value = true;
      runsErrorText.value = error instanceof ApiError ? toDisplayText(error.message) : toDisplayText(error);
    } finally {
      if (!silent) runsLoading.value = false;
    }
  }

  /** 翻页（keyset 游标）。 */
  async function loadMoreRuns(sessionId: string): Promise<void> {
    if (!runsNextCursor.value) return;
    const params = new URLSearchParams({ limit: String(MACRO_RUNS_LIMIT), cursor: runsNextCursor.value });
    if (filterVerdict.value) params.set('verdict', filterVerdict.value);
    try {
      const body = await api<{ items?: Record<string, unknown>[]; nextCursor?: string | null }>(
        `${macroRunsPath(sessionId)}?${params.toString()}`,
      );
      const page = (body?.items ?? []).map(normalizeRun).filter((r): r is MacroRun => r !== null);
      runs.value = [...runs.value, ...page];
      runsNextCursor.value = body?.nextCursor ?? null;
    } catch {
      // 翻页失败保留已有内容（不要把已看到的列表清成空态）。
    }
  }

  /** 订阅（PUT 幂等 upsert）。成功后用响应合并本地，不靠「再打一次 GET」刷新自己的写。 */
  async function assign(sessionId: string, templateId: string, until: string | null = null): Promise<boolean> {
    try {
      const body = await api<{ assignment?: Record<string, unknown> }>(macroAssignmentsPath(sessionId), {
        method: 'PUT',
        body: JSON.stringify({ templateId, until }),
      });
      const next = normalizeAssignment(body?.assignment);
      if (next) {
        assignments.value = [...assignments.value.filter((a) => a.templateId !== next.templateId), next];
      } else {
        await loadAssignments(sessionId);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function unassign(sessionId: string, assignmentId: string): Promise<boolean> {
    try {
      await api<unknown>(macroAssignmentPath(sessionId, assignmentId), { method: 'DELETE' });
      assignments.value = assignments.value.filter((a) => a.id !== assignmentId);
      return true;
    } catch {
      return false;
    }
  }

  // ── 通知（顶栏铃铛）─────────────────────────────────────────────────────────

  async function loadNotifications(): Promise<void> {
    notificationsLoading.value = true;
    try {
      const body = await api<{ items?: Record<string, unknown>[] }>(
        `${NOTIFICATIONS_PATH}?limit=${NOTIFICATIONS_LIMIT}`,
      );
      notifications.value = (body?.items ?? [])
        .map(normalizeNotification)
        .filter((n): n is MacroNotification => n !== null);
      notificationsFailed.value = false;
      notificationsLoaded.value = true;
    } catch {
      notificationsFailed.value = true;
    } finally {
      notificationsLoading.value = false;
    }
  }

  async function refreshUnreadCount(): Promise<void> {
    try {
      const body = await api<{ count?: number }>(NOTIFICATIONS_UNREAD_PATH);
      const n = Number(body?.count ?? 0);
      unreadCount.value = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    } catch {
      // 读不到 ⇒ 保留上一个数字（角标宁旧勿错，「读不到」不是「没有」）。
    }
  }

  async function markRead(notificationId: string): Promise<boolean> {
    try {
      await api<unknown>(`${NOTIFICATIONS_PATH}/${encodeURIComponent(notificationId)}/read`, {
        method: 'POST',
        body: '{}',
      });
      const at = new Date().toISOString();
      notifications.value = notifications.value.map((n) => (n.id === notificationId ? { ...n, readAt: at } : n));
      unreadCount.value = Math.max(0, unreadCount.value - 1);
      return true;
    } catch {
      return false;
    }
  }

  // ── 轮询（`07` §16：开→拉一次；有未完成→2s 一轮；全完成 / 关抽屉→停）──────────

  function stopPolling(): void {
    if (pollTimer.value !== null) {
      clearTimeout(pollTimer.value);
      pollTimer.value = null;
    }
  }

  function schedulePoll(sessionId: string): void {
    stopPolling();
    if (!drawerOpen.value) return;
    pollTimer.value = setTimeout(() => {
      void (async () => {
        await loadRuns(sessionId, { silent: true });
        if (hasPending.value && drawerOpen.value) schedulePoll(sessionId);
        else stopPolling();
      })();
    }, MACRO_POLL_INTERVAL_MS);
  }

  async function openDrawer(sessionId: string): Promise<void> {
    drawerOpen.value = true;
    pollingSession.value = sessionId;
    await Promise.all([loadTemplates(), loadAssignments(sessionId), loadRuns(sessionId)]);
    if (hasPending.value) schedulePoll(sessionId);
  }

  function closeDrawer(): void {
    drawerOpen.value = false;
    stopPolling();
    pollingSession.value = null;
  }

  /** 手动 ↻ / 消息流 `run_end` 触发的拉一次（`07` §16 最后两行）。 */
  async function refresh(sessionId?: string): Promise<void> {
    const target = sessionId ?? pollingSession.value ?? '';
    await loadAssignments(target);
    if (target) await loadRuns(target, { silent: true });
    if (target && drawerOpen.value && hasPending.value) schedulePoll(target);
  }

  function setVerdictFilter(verdict: string | null, sessionId?: string): void {
    filterVerdict.value = verdict;
    const target = sessionId ?? pollingSession.value ?? '';
    if (target) void loadRuns(target);
  }

  function setTemplateFilter(templateId: string | null): void {
    filterTemplateId.value = templateId;
  }

  function clearFilters(): void {
    filterTemplateId.value = null;
    filterVerdict.value = null;
  }

  function reset(): void {
    templates.value = [];
    templatesLoaded.value = false;
    templatesFailed.value = false;
    assignments.value = [];
    runs.value = [];
    runsLoaded.value = false;
    runsFailed.value = false;
    runsErrorText.value = null;
    runsNextCursor.value = null;
    filterTemplateId.value = null;
    filterVerdict.value = null;
    closeDrawer();
  }

  return {
    templates, templatesLoading, templatesFailed, templatesLoaded,
    assignments, runs, runsLoading, runsFailed, runsLoaded, runsErrorText, runsNextCursor,
    filterTemplateId, filterVerdict,
    notifications, notificationsLoading, notificationsFailed, notificationsLoaded, unreadCount,
    drawerOpen, pollingSession,
    sessionTemplates, userTemplates, assignmentByTemplate, enabledAssignments,
    visibleRuns, filterActive, panelStateValue, hasPending, verdictOptions,
    loadTemplates, loadAssignments, loadRuns, loadMoreRuns, assign, unassign,
    loadNotifications, refreshUnreadCount, markRead,
    openDrawer, closeDrawer, refresh, setVerdictFilter, setTemplateFilter, clearFilters,
    stopPolling, schedulePoll, reset, now, setClock,
    /** 健康告警（判据⑤）：陈旧 ⇒ 进顶部状态条，不进空态区。时刻由调用方注入（可测）。 */
    watermark: (nowMs: number): WatermarkState => watermarkState(assignments.value, nowMs),
  };
});
