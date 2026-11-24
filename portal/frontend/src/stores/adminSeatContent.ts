// 管理台「工位内容」页的取数层（issue #727 片 2，契约 docs/api/portal.md §4.22）。
//
// 只读红线（工单第 3 条）：本文件里**只允许 GET**。七条端点全部经 `api()` 走 GET，
// 没有任何 POST/PUT/PATCH/DELETE，也没有 EventSource / `/pv/` —— 那条红线另由
// `adminSeatContent.spec.ts` 用源码级断言 + fetch 桩 method 断言钉住。
//
// 为什么不复用 stores/workbench.ts：那个 store 混着发送（POST）、停止、SSE 装配，
// 管理台只要「看」，复用会把写侧的副作用一起拖进来。
import { defineStore } from 'pinia';
import { api } from '../api';
import type { FoldedInfo, ProjectedToolCall, QueuedSnapshot } from './workbench';

// ── DTO 类型（形状来源：portal/src/admin-seat-content.js + session-view.js）──

/** GET .../dirs 的一项：该 FDE `~/projects` 的一级目录 + 该目录的会话计数。 */
export interface SeatDir {
  name: string;
  cwd: string;
  running_count: number;
  queued_count: number;
}

/** 会话列表项（同 `/api/sessions` 的 `items[]`，`portal/src/sessions.js#rowToSession`）。 */
export interface SeatSession {
  id: string;
  project_id: string | null;
  cwd: string | null;
  title: string | null;
  title_source?: string;
  origin?: string;
  model: string | null;
  status: string;
  last_seq: number;
  created_at: string | null;
  updated_at: string | null;
  active_run_id?: string | null;
  message_count?: number | null;
}

/** 会话详情里的一条消息（`portal/src/session-view.js` 的投影，camelCase 键有则出现）。 */
export interface SeatMessage {
  id: string;
  run_id: string | null;
  seq: number;
  role: 'user' | 'assistant' | string;
  content: string;
  synthetic: boolean;
  attachments: unknown[];
  created_at: string | null;
  toolCalls?: ProjectedToolCall[];
  reasoning?: string;
  blocks?: unknown[];
  turnKeys?: string[];
  folded?: FoldedInfo;
}

/** 会话详情 DTO（`GET .../sessions/:id`）。 */
export interface SeatSessionDetail {
  session: SeatSession & {
    message_count?: number | null;
    compaction?: unknown;
    queued_messages?: QueuedSnapshot;
  };
  messages: SeatMessage[];
  last_seq: number;
  next_cursor: number | null;
}

/** `events/history` 的一行：真实事件与合成项（`partial_output` / `run_termination`）同形。 */
export interface SeatHistoryEvent {
  seq: number;
  run_id: string | null;
  type: string;
  payload: Record<string, unknown>;
}

export interface SeatHistoryPage {
  events: SeatHistoryEvent[];
  next_cursor: number | null;
}

/** `files/tree` 的一项。`type` 与用户面同形：`dir` / `file`。 */
export interface SeatTreeEntry {
  name: string;
  type: 'dir' | 'file' | string;
}

/**
 * `files/tree` 的分页口径：`truncated=true` 时 `next_after` 是**复合游标** `<rank>:<name>`
 * （`d`=目录 / `f`=文件），必须**原样透传**回 `after`——前端不得拆解、不得改写、不得排序。
 */
export interface SeatTreePage {
  entries: SeatTreeEntry[];
  truncated: boolean;
  next_after: string | null;
}

/** `file?mode=json` 的 DTO（`kind` 只有这两值；PDF/音视频走 `mode=stream`）。 */
export interface SeatFileJson {
  name: string;
  path: string;
  kind: 'image' | 'text' | string;
  data: string;
}

/** folded 原文 DTO（`GET .../sessions/:id/folded/:round`）。 */
export interface SeatFoldedPayload {
  round: number;
  turns: Array<Record<string, unknown>>;
  source?: string;
  truncated?: boolean;
  dropped_messages?: number;
}

interface DirsResponse { dirs: SeatDir[] }
interface SessionsResponse { items: SeatSession[]; next_cursor: string | null }
interface UsersListResponse { items: Array<{ fde_name: string | null }> }

// ── URL 构造 ──

/** 管理台端点的公共前缀（路径段一律 encodeURIComponent，`fde` 里可能有非字母字符）。 */
function base(fde: string): string {
  return `/api/admin/fdes/${encodeURIComponent(fde)}`;
}

/** 拼 query：值为 `undefined`/`null`/`''` 的键**不出现**（服务端把空串当未传，前端不复制默认值）。 */
function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** `include_archived` 的线上传输值：只认 `1`/`true`（§4.22），关掉时整键不出现。 */
function archivedFlag(on: boolean | undefined): string | undefined {
  return on ? '1' : undefined;
}

/** 文件预览/下载的 URL（json 模式不带 `mode`，与用户面 `/api/file` 同口径）。 */
export function fileUrl(
  fde: string,
  path: string,
  mode: 'json' | 'stream' | 'download' = 'json',
): string {
  const q = qs({ path, mode: mode === 'json' ? undefined : mode });
  return `${base(fde)}/file${q}`;
}

/** 会话列表的一页请求参数（`limit` 由视图传 50；这里不复制后端默认值）。 */
export interface SessionQuery {
  cwd?: string;
  q?: string;
  includeArchived?: boolean;
  cursor?: string | null;
  limit?: number;
}

export const useAdminSeatContentStore = defineStore('adminSeatContent', {
  state: () => ({
    /** 有 `fde_name` 的用户（下拉的唯一数据源；没有工位名的用户不进列表）。 */
    fdeOptions: [] as Array<{ fde_name: string; login: string }>,
    usersLoaded: false,
    loading: false,
    /** 服务端 `error.message` 原文（只加本地化前缀，不翻译，口径同 stores/admin.ts）。 */
    error: null as string | null,
  }),
  actions: {
    /** `GET /api/admin/users`：只保留 `fde_name` 非空的用户（没有工位就没有内容可看）。 */
    async loadUsers(): Promise<string | null> {
      this.loading = true;
      this.error = null;
      try {
        const data = await api<UsersListResponse>('/api/admin/users');
        const withFde = (data.items ?? []).filter(
          (item): item is { fde_name: string; login?: string } =>
            typeof item.fde_name === 'string' && item.fde_name !== '',
        );
        this.fdeOptions = withFde.map(
          (item) => ({ fde_name: item.fde_name, login: item.login ?? '' }),
        );
        this.usersLoaded = true;
        return null;
      } catch (e) {
        this.error = errorText(e);
        return this.error;
      } finally {
        this.loading = false;
      }
    },

    async loadDirs(fde: string): Promise<SeatDir[]> {
      const data = await api<DirsResponse>(`${base(fde)}/dirs`);
      return data.dirs ?? [];
    },

    async loadSessions(fde: string, query: SessionQuery = {}): Promise<SessionsResponse> {
      return await api<SessionsResponse>(`${base(fde)}/sessions${qs({
        cwd: query.cwd,
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        include_archived: archivedFlag(query.includeArchived),
      })}`);
    },

    async loadSession(
      fde: string,
      id: string,
      opts: { includeArchived?: boolean; limit?: number; cursor?: number | null } = {},
    ): Promise<SeatSessionDetail> {
      return await api<SeatSessionDetail>(`${base(fde)}/sessions/${encodeURIComponent(id)}${qs({
        limit: opts.limit,
        cursor: opts.cursor,
        include_archived: archivedFlag(opts.includeArchived),
      })}`);
    },

    async loadHistory(
      fde: string,
      id: string,
      opts: { before?: number | null; limit?: number; includeArchived?: boolean } = {},
    ): Promise<SeatHistoryPage> {
      return await api<SeatHistoryPage>(
        `${base(fde)}/sessions/${encodeURIComponent(id)}/events/history${qs({
          before: opts.before,
          limit: opts.limit,
          include_archived: archivedFlag(opts.includeArchived),
        })}`,
      );
    },

    async loadFolded(
      fde: string, id: string, round: number, opts: { includeArchived?: boolean } = {},
    ): Promise<SeatFoldedPayload> {
      const roundPart = encodeURIComponent(String(round));
      const foldedPath = `${base(fde)}/sessions/${encodeURIComponent(id)}/folded/${roundPart}`;
      return await api<SeatFoldedPayload>(
        `${foldedPath}${qs({ include_archived: archivedFlag(opts.includeArchived) })}`,
      );
    },

    /**
     * 目录树的一层。`path` 是相对 `~/projects` 的路径（根 = `'.'`，与后端缺省一致），
     * `after` 是上一页原样交回的复合游标（不拆解、不改写）。
     */
    async loadTree(
      fde: string,
      opts: { path: string; after?: string | null; limit?: number },
    ): Promise<SeatTreePage> {
      return await api<SeatTreePage>(`${base(fde)}/files/tree${qs({
        path: opts.path,
        after: opts.after,
        limit: opts.limit,
      })}`);
    },

    async loadFileJson(fde: string, path: string): Promise<SeatFileJson> {
      return await api<SeatFileJson>(fileUrl(fde, path, 'json'));
    },
  },
});

/** 错误文案：服务端 message 原文透传（口径同 `stores/admin.ts#errorPrefix`）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
