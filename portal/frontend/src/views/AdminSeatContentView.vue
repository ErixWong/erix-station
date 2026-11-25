<script setup lang="ts">
// 管理台「工位内容」页（issue #727 片 2，契约 docs/api/portal.md §4.22）——**只读**。
//
// 只读红线（工单第 3 条）的代码位置，三条都在这里可核对：
//   ① 取数只有 GET：本页所有请求都走 `stores/adminSeatContent.ts` 的 action 与 `api()`，
//      那个 store 里没有任何 method 字段（`api()` 缺省 GET），也没有 POST/PUT/PATCH/DELETE；
//   ② 没有 SSE：本文件与 AdminTranscript / AdminSeatTreeNode 都不出现 `new EventSource`；
//   ③ 没有上传/预览反代：Office 由前端渲染（字节走 `/api/file?mode=stream`），
//      服务端既无签票端点也无反代路径可请（#795 下线）。
// 三件事由 `src/views/AdminSeatContentView.spec.ts` 的「只读红线」用例钉住（fetch 桩 method
// + URL 扫描 + EventSource 构造哨兵）。
//
// 为什么不用 stores/workbench.ts：它含 POST 发送、停止、SSE 装配——管理台只要「看」。
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import AdminSeatTreeNode from '../components/AdminSeatTreeNode.vue';
import AdminTranscript from '../components/AdminTranscript.vue';
import { renderMarkdown } from '../lib/markdown';
import { isMarkdownName, previewChannel, streamMediaKind } from '../lib/previewRoute';
import {
  fileUrl,
  useAdminSeatContentStore,
  type SeatDir,
  type SeatFileJson,
  type SeatSession,
  type SeatSessionDetail,
  type SeatTreeEntry,
} from '../stores/adminSeatContent';

const { t } = useI18n();
const store = useAdminSeatContentStore();
const route = useRoute();
const router = useRouter();

/** 会话列表一页的条数（工单定稿：50；「加载更多」再要一页）。 */
const SESSION_PAGE_SIZE = 50;
/** 文件树根：相对该工位 `~/projects` 的 `'.'`（与后端缺省一致，前端不拼绝对路径）。 */
const TREE_ROOT = '.';
/** 会话 `cwd` 与一级目录互转用的公共前缀（`~/projects`，与 `dirNameOfCwd` 同口径）。 */
const PROJECTS_DIR = '~/projects';

// ── 顶部：FDE 选择 ──
const selectedFde = ref('');
const usersLoading = ref(false);

// ── 左栏上：会话清单 ──
const sessions = ref<SeatSession[]>([]);
const sessionsCursor = ref<string | null>(null);
const sessionsLoading = ref(false);
const sessionsError = ref('');
const searchQ = ref('');
const includeArchived = ref(false);
// ── 会话二级菜单：目录（folder / project）下拉 ──
/** 该 FDE `~/projects` 的一级目录（下拉的数据源，复用页面已加载的 `dirs` 端点）。 */
const dirs = ref<SeatDir[]>([]);
/** 会话目录过滤：`''` = 全部目录；否则是某个目录的 `cwd`（形如 `~/projects/<name>`）。 */
const dirFilter = ref('');

// ── 左栏下：文件树（状态按路径记账，全树共享一份）──
const childMap = ref<Record<string, SeatTreeEntry[]>>({});
const expanded = ref<Record<string, boolean>>({});
const dirLoading = ref<Record<string, boolean>>({});
const truncated = ref<Record<string, boolean>>({});
const nextAfter = ref<Record<string, string | null>>({});
const treeError = ref('');
/** 点会话后要展开并高亮的一级目录名（`cwd = ~/projects/<name>` 里的 `<name>`）。 */
const highlightName = ref<string | null>(null);

// ── 右栏：选中项 ──
const selectedSession = ref<SeatSession | null>(null);
const sessionDetail = ref<SeatSessionDetail | null>(null);
const sessionDetailError = ref('');
const selectedFilePath = ref<string | null>(null);
const fileJson = ref<SeatFileJson | null>(null);
const fileError = ref('');
const fileLoading = ref(false);

const fdeOptions = computed(() => store.fdeOptions);
const hasSelection = computed(
  () => selectedSession.value !== null || selectedFilePath.value !== null,
);

/**
 * 目录下拉的一项标签：目录名 + 该目录的活体计数。
 * `running_count` / `queued_count` 为 0 时不显示；两者都为 0 ⇒ 只有目录名。
 */
function dirOptionLabel(dir: SeatDir): string {
  const parts: string[] = [];
  if (dir.running_count > 0) {
    parts.push(t('admin.seatContent.sessions.runningCount', { count: dir.running_count }));
  }
  if (dir.queued_count > 0) {
    parts.push(t('admin.seatContent.sessions.queuedCount', { count: dir.queued_count }));
  }
  return parts.length ? `${dir.name}（${parts.join(' / ')}）` : dir.name;
}

// 会话按 `updated_at` 倒序（服务端同一口径，这里只是保证「加载更多」拼接后的顺序也成立）。
const sortedSessions = computed(() =>
  [...sessions.value].sort(
    (a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')),
  ),
);

function sessionTitle(session: SeatSession): string {
  return session.title ?? t('admin.seatContent.sessions.untitled');
}

// ── 深链：`?fde=` / `?session=` ──

/** 选中态写回 query：`router.replace`（不产生历史堆积，刷新/分享仍是当前视图）。 */
function syncQuery(): void {
  const query: Record<string, string> = {};
  if (selectedFde.value) query.fde = selectedFde.value;
  if (selectedSession.value) query.session = selectedSession.value.id;
  void router.replace({ name: 'admin-seat-content', query });
}

// ── 取数 ──

async function reloadSessions(append = false): Promise<void> {
  if (!selectedFde.value) return;
  sessionsLoading.value = true;
  sessionsError.value = '';
  try {
    const page = await store.loadSessions(selectedFde.value, {
      cwd: dirFilter.value || undefined,
      q: searchQ.value.trim() || undefined,
      includeArchived: includeArchived.value,
      cursor: append ? sessionsCursor.value ?? undefined : undefined,
      limit: SESSION_PAGE_SIZE,
    });
    const items = page.items ?? [];
    sessions.value = append ? [...sessions.value, ...items] : items;
    // 游标原样保存（不透明字符串），下一页原样传回。
    sessionsCursor.value = page.next_cursor ?? null;
  } catch (e) {
    sessionsError.value = e instanceof Error ? e.message : String(e);
  } finally {
    sessionsLoading.value = false;
  }
}

async function loadDir(path: string, append = false): Promise<void> {
  if (!selectedFde.value) return;
  dirLoading.value = { ...dirLoading.value, [path]: true };
  treeError.value = '';
  try {
    const page = await store.loadTree(selectedFde.value, {
      path,
      after: append ? nextAfter.value[path] ?? undefined : undefined,
    });
    const entries = page.entries ?? [];
    const previous = append ? childMap.value[path] ?? [] : [];
    childMap.value = { ...childMap.value, [path]: [...previous, ...entries] };
    truncated.value = { ...truncated.value, [path]: page.truncated === true };
    // `truncated=false` 时后端给 `null`：清掉游标，「加载更多」按钮随之消失。
    nextAfter.value = { ...nextAfter.value, [path]: page.next_after ?? null };
  } catch (e) {
    treeError.value = e instanceof Error ? e.message : String(e);
  } finally {
    dirLoading.value = { ...dirLoading.value, [path]: false };
  }
}

function toggleDir(path: string): void {
  // 一级目录（节点名不含 `/`）：无论展开还是收起，都把它当「选目录」——
  // 会话面板的目录下拉随之切到该目录并重取列表（folder → session 二级联动）。
  if (!path.includes('/')) applyDirFilter(`${PROJECTS_DIR}/${path}`);
  if (expanded.value[path]) {
    expanded.value = { ...expanded.value, [path]: false };
    return;
  }
  expanded.value = { ...expanded.value, [path]: true };
  if (childMap.value[path] === undefined) void loadDir(path);
}

/**
 * 把会话目录过滤切到某个 `cwd`（`''` = 全部）并重取列表。
 * 已经是该值就不重发（避免点同一目录/同一会话时多一次无谓请求）。
 */
function applyDirFilter(cwd: string): void {
  if (dirFilter.value === cwd) return;
  dirFilter.value = cwd;
  sessionsCursor.value = null;
  void reloadSessions();
}

/** 读目录下拉的数据源（`dirs` 端点）；失败不阻断会话/树（下拉退化为只有「全部」）。 */
async function loadDirsInto(): Promise<void> {
  if (!selectedFde.value) return;
  try {
    dirs.value = await store.loadDirs(selectedFde.value);
  } catch {
    dirs.value = [];
  }
}

/** 会话的 `cwd`（`~/projects/<name>`）→ 树里的一级目录名；形状不符就不高亮（不猜）。 */
function dirNameOfCwd(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') return null;
  const matched = /^~\/projects\/([^/]+)$/.exec(cwd);
  return matched ? matched[1] : null;
}

/**
 * 点会话 → 文件树自动展开并高亮该 `cwd` 对应的一级目录。
 * 展开 = 确保根层已加载 + 把该目录标记为展开（它的子层仍按懒加载，点进去才请求）。
 */
async function revealSessionDir(cwd: string | null | undefined): Promise<void> {
  const name = dirNameOfCwd(cwd);
  highlightName.value = name;
  if (name == null) return;
  if (childMap.value[TREE_ROOT] === undefined) await loadDir(TREE_ROOT);
  expanded.value = { ...expanded.value, [name]: true };
  // 「展开」得是真的展开：这一层的子项也要取回来（仍只到一级，不往里递归）。
  if (childMap.value[name] === undefined) await loadDir(name);
}

async function selectSession(id: string): Promise<void> {
  if (!selectedFde.value) return;
  selectedFilePath.value = null;
  fileJson.value = null;
  fileError.value = '';
  sessionDetailError.value = '';
  try {
    const detail = await store.loadSession(selectedFde.value, id, {
      includeArchived: includeArchived.value,
    });
    sessionDetail.value = detail;
    selectedSession.value = detail.session ?? null;
    await revealSessionDir(detail.session?.cwd);
  } catch (e) {
    sessionDetail.value = null;
    selectedSession.value = sessions.value.find((item) => item.id === id) ?? null;
    sessionDetailError.value = e instanceof Error ? e.message : String(e);
    await revealSessionDir(selectedSession.value?.cwd);
  }
  // 双向联动：选中的会话必须落在当前目录过滤里——否则会出现
  // 「选中的会话不在当前过滤中」这种自相矛盾。若它的 `cwd` 与当前过滤不一致，
  // 就把过滤切到它（「全部」也算不一致 ⇒ 收窄到该目录，深链同样靠这条落位）。
  const sessionCwd = selectedSession.value?.cwd;
  if (typeof sessionCwd === 'string' && sessionCwd !== '') applyDirFilter(sessionCwd);
  syncQuery();
}

async function selectFile(path: string): Promise<void> {
  selectedFilePath.value = path;
  selectedSession.value = null;
  sessionDetail.value = null;
  sessionDetailError.value = '';
  fileJson.value = null;
  fileError.value = '';
  // 只有 JSON 通道才发请求；PDF/音视频给 stream URL（浏览器自己取）；其余一律只给下载。
  if (previewChannel(path) === 'native-json') {
    fileLoading.value = true;
    try {
      fileJson.value = await store.loadFileJson(selectedFde.value, path);
    } catch (e) {
      fileError.value = e instanceof Error ? e.message : String(e);
    } finally {
      fileLoading.value = false;
    }
  }
  syncQuery();
}

function onFdeChange(): void {
  sessions.value = [];
  sessionsCursor.value = null;
  sessionsError.value = '';
  dirs.value = [];
  dirFilter.value = '';
  childMap.value = {};
  expanded.value = {};
  dirLoading.value = {};
  truncated.value = {};
  nextAfter.value = {};
  treeError.value = '';
  highlightName.value = null;
  selectedSession.value = null;
  sessionDetail.value = null;
  selectedFilePath.value = null;
  fileJson.value = null;
  fileError.value = '';
  if (!selectedFde.value) {
    syncQuery();
    return;
  }
  // 选中 FDE 才发这个工位的请求（未选时一个端点请求都不发）。
  void Promise.all([reloadSessions(), loadDir(TREE_ROOT), loadDirsInto()]);
  syncQuery();
}

/** 目录下拉直接改动（`@change`）：`v-model` 已先写好 `dirFilter`，这里只重置游标重取。 */
function onDirSelect(): void {
  sessionsCursor.value = null;
  void reloadSessions();
}

/** 只重取当前会话详情（不碰目录/树），供「刷新」按钮用。 */
async function reloadSessionDetail(): Promise<void> {
  const id = selectedSession.value?.id;
  if (!id || !selectedFde.value) return;
  sessionDetailError.value = '';
  try {
    const detail = await store.loadSession(selectedFde.value, id, {
      includeArchived: includeArchived.value,
    });
    sessionDetail.value = detail;
    if (detail.session) selectedSession.value = detail.session;
  } catch (e) {
    sessionDetailError.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 「刷新」：只重取当前目录的会话列表 + 当前会话详情（无定时轮询、无 SSE）。
 * 不重读 `dirs` / 目录树：那与「谁在跑」无关，重读会让 fetch 计数多走。
 */
function refreshAll(): void {
  if (!selectedFde.value) return;
  sessionsCursor.value = null;
  void reloadSessions();
  void reloadSessionDetail();
}

// ── 文件预览的派生值 ──
const fileChannel = computed(() => (selectedFilePath.value
  ? previewChannel(selectedFilePath.value)
  : 'other'));
const fileMediaKind = computed(() => (selectedFilePath.value
  ? streamMediaKind(selectedFilePath.value)
  : null));
const fileIsMarkdown = computed(() =>
  isMarkdownName(fileJson.value?.name ?? selectedFilePath.value ?? ''),
);
const fileMarkdownHtml = computed(() => (fileJson.value && fileIsMarkdown.value
  ? renderMarkdown(fileJson.value.data)
  : ''));
const streamUrl = computed(() => (selectedFilePath.value
  ? fileUrl(selectedFde.value, selectedFilePath.value, 'stream')
  : ''));
const downloadHref = computed(() => (selectedFilePath.value
  ? fileUrl(selectedFde.value, selectedFilePath.value, 'download')
  : ''));
const fileName = computed(() => (selectedFilePath.value ?? '').split('/').pop() ?? '');
const fileDirs = computed(() => {
  const parts = (selectedFilePath.value ?? '').split('/');
  return parts.slice(0, -1);
});

// 长 class / 常量化（单行 ≤100 字节纪律；语义零变化）。
const CLS_LINK = 'ml-auto shrink-0 rounded-md border border-black/15 px-2 py-1 text-xs' +
  ' hover:bg-black/5';
const CLS_LINK_BIG = 'mt-3 inline-block rounded-md border border-black/15 px-3 py-1.5 text-sm' +
  ' hover:bg-black/5';
// 运行态徽标（会话行与详情 meta 共用）：绿底绿字，不用红（红是错误语义）。
const CLS_RUN_BADGE = 'inline-flex items-center gap-1 rounded-full bg-green-500/10'
  + ' px-1.5 py-[1px] text-green-700';
const CLS_RUN_DOT = 'inline-block h-1.5 w-1.5 rounded-full bg-green-500';

/** 元信息行的一格（缺失一律 `—`，不猜、不显示 `undefined`）。 */
function metaValue(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return t('admin.seatContent.meta.unknown');
  }
  return String(value);
}
/**
 * 创建/更新两格的数据源。详情端点的 `session` 来自 `sessions.js` 的
 * `fetchSession()`，它的 SELECT 里没有 `created_at` / `updated_at`（热路径，
 * SQL 逐字不变是既有口径）；这两列只在左栏列表项（`sessions` 的 `items`）
 * 里 ⇒ 从已加载的列表按 id 找。找不到（深链直开）就整格不给：
 * 没有数据就不装成查过。
 */
const selectedListItem = computed<SeatSession | null>(() => {
  const id = selectedSession.value?.id;
  if (!id) return null;
  return sessions.value.find((item) => item.id === id) ?? null;
});

/** 元信息行的格子（cwd / 模型 / 状态 / 创建 / 更新 / 消息数；后两格
 * 见 `selectedListItem`）。 */
interface MetaCell { key: string; label: string; value: string; test?: string }

const metaCells = computed<MetaCell[]>(() => {
  const session = selectedSession.value;
  if (!session) return [];
  const cell = (key: string, value: unknown, test?: string): MetaCell => ({
    key,
    label: t(`admin.seatContent.meta.${key}`),
    value: metaValue(value),
    test,
  });
  const cells: MetaCell[] = [
    cell('cwd', session.cwd, 'meta-cwd'),
    cell('model', session.model),
    cell('status', session.status),
  ];
  // 键名必须是 `createdAt` / `updatedAt`：语言包里就是这两个。
  // 写 `created` 会渲染成裸 key，而 parity 用例只比 zh/en 键集合，抓不到它
  // ⇒ 哨兵见本文件 spec 的「裸 key」用例。
  const listed = selectedListItem.value;
  if (listed?.created_at) cells.push(cell('createdAt', listed.created_at, 'meta-created'));
  if (listed?.updated_at) cells.push(cell('updatedAt', listed.updated_at, 'meta-updated'));
  cells.push(cell('messages', messageCount.value, 'meta-messages'));
  return cells;
});

const messageCount = computed(() => {
  const detail = sessionDetail.value;
  const count = detail?.session?.message_count;
  return typeof count === 'number' ? String(count) : metaValue(null);
});

onMounted(async () => {
  usersLoading.value = true;
  await store.loadUsers();
  usersLoading.value = false;
  const queryFde = typeof route.query.fde === 'string' ? route.query.fde : '';
  // 深链里的 FDE 必须在候选列表里才认（拼错的名字不该发无意义的端点请求）。
  if (queryFde && store.fdeOptions.some((item) => item.fde_name === queryFde)) {
    selectedFde.value = queryFde;
    onFdeChange();
    const querySession = typeof route.query.session === 'string' ? route.query.session : '';
    if (querySession) await selectSession(querySession);
  }
});

// 勾选「含已归档」= 重新取一页（过滤条件变了，旧游标属于旧查询，不能续用）。
watch(includeArchived, () => {
  sessionsCursor.value = null;
  void reloadSessions();
});
</script>

<template>
  <div data-test="seat-content-page" class="flex h-[calc(100vh-8.5rem)] flex-col gap-2">
    <!-- 顶栏：FDE 下拉 + 当前工位 + 只读标记 -->
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <h2 class="text-lg font-medium mb-0">{{ t('admin.seatContent.title') }}</h2>
      <label
        class="text-sm text-black/60"
        for="seat-content-fde"
      >{{ t('admin.seatContent.fdeLabel') }}</label>
      <select
        id="seat-content-fde"
        v-model="selectedFde"
        data-test="fde-select"
        class="rounded-md border border-black/20 px-2 py-1 text-sm"
        @change="onFdeChange"
      >
        <option value="">{{ t('admin.seatContent.selectFde') }}</option>
        <option v-for="opt in fdeOptions" :key="opt.fde_name" :value="opt.fde_name">
          {{ opt.fde_name }}{{ opt.login ? `（${opt.login}）` : '' }}
        </option>
      </select>
      <span
        v-if="selectedFde"
        data-test="current-fde"
        class="text-sm font-medium"
      >{{ selectedFde }}</span>
      <span
        data-test="read-only-badge"
        class="rounded-full border border-black/15 px-2 py-0.5 text-xs text-black/55"
        :title="t('admin.seatContent.readOnlyHint')"
      >{{ t('admin.seatContent.readOnly') }}</span>
      <span v-if="usersLoading" data-test="users-loading" class="text-xs text-black/45">
        {{ t('admin.seatContent.loadingUsers') }}
      </span>
      <span
        v-if="store.error"
        data-test="users-error"
        class="syserr text-xs"
      >{{ store.error }}</span>
    </div>

    <div
      v-if="!fdeOptions.length && !usersLoading && !store.error"
      data-test="no-fde-users"
      class="text-sm text-black/45"
    >
      {{ t('admin.seatContent.noFdeUsers') }}
    </div>

    <div class="flex min-h-0 flex-1 gap-3">
      <!-- 左栏：上 40% 会话清单 / 下 60% 文件树，**各自独立滚动** -->
      <aside class="flex w-[320px] shrink-0 flex-col gap-2">
        <section class="flex h-[40%] min-h-0 flex-col rounded-md border border-black/10">
          <header class="shrink-0 space-y-1 border-b border-black/10 px-2 py-1.5">
            <h3 class="text-sm font-medium mb-0">{{ t('admin.seatContent.sessions.title') }}</h3>
            <div class="flex items-center gap-1">
              <label
                class="shrink-0 text-xs text-black/60"
                for="seat-content-session-dir"
              >{{ t('admin.seatContent.sessions.dirLabel') }}</label>
              <select
                id="seat-content-session-dir"
                v-model="dirFilter"
                data-test="session-dir-select"
                class="min-w-0 flex-1 rounded border border-black/15 px-1.5 py-1 text-xs"
                @change="onDirSelect"
              >
                <option value="">{{ t('admin.seatContent.sessions.dirAll') }}</option>
                <option v-for="dir in dirs" :key="dir.cwd" :value="dir.cwd">
                  {{ dirOptionLabel(dir) }}
                </option>
              </select>
              <button
                type="button"
                data-test="sessions-refresh"
                class="shrink-0 rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
                @click="refreshAll"
              >{{ t('admin.seatContent.sessions.refresh') }}</button>
            </div>
            <input
              v-model="searchQ"
              type="search"
              data-test="session-search"
              :placeholder="t('admin.seatContent.sessions.searchPlaceholder')"
              class="w-full rounded border border-black/15 px-1.5 py-1 text-xs"
              @keyup.enter="reloadSessions()"
              @change="reloadSessions()"
            >
            <label class="flex items-center gap-1 text-xs text-black/60">
              <input
                v-model="includeArchived"
                type="checkbox"
                data-test="include-archived"
                class="align-middle"
              >
              {{ t('admin.seatContent.sessions.includeArchived') }}
            </label>
            <p
              v-if="sessionsError"
              data-test="sessions-error"
              class="syserr text-xs"
            >{{ sessionsError }}</p>
          </header>
          <div class="min-h-0 flex-1 overflow-auto">
            <p
              v-if="!sortedSessions.length && !sessionsLoading && selectedFde"
              data-test="sessions-empty"
              class="px-2 py-3 text-xs text-black/45"
            >
              {{ t('admin.seatContent.sessions.empty') }}
            </p>
            <button
              v-for="item in sortedSessions"
              :key="item.id"
              type="button"
              data-test="session-row"
              :data-session-id="item.id"
              class="block w-full border-b border-black/5 px-2 py-1.5 text-left hover:bg-black/5"
              :class="selectedSession?.id === item.id ? 'bg-brand/10' : ''"
              @click="selectSession(item.id)"
            >
              <span class="flex items-center gap-1">
                <span class="min-w-0 flex-1 truncate text-sm">{{ sessionTitle(item) }}</span>
                <span
                  v-if="item.active_run_id"
                  data-test="session-running"
                  :class="[CLS_RUN_BADGE, 'shrink-0 text-[10px]']"
                >
                  <span :class="CLS_RUN_DOT"></span>
                  {{ t('admin.seatContent.sessions.running') }}
                </span>
              </span>
              <span class="block truncate text-[11px] text-black/45">{{ item.cwd }}</span>
              <span class="block text-[11px] text-black/40">{{ item.updated_at }}</span>
            </button>
            <button
              v-if="sessionsCursor"
              type="button"
              data-test="sessions-load-more"
              class="block w-full px-2 py-1.5 text-left text-xs underline disabled:opacity-50"
              :disabled="sessionsLoading"
              @click="reloadSessions(true)"
            >{{ t('admin.seatContent.sessions.loadMore') }}</button>
          </div>
        </section>

        <section class="flex h-[60%] min-h-0 flex-col rounded-md border border-black/10">
          <header class="shrink-0 border-b border-black/10 px-2 py-1.5">
            <h3 class="text-sm font-medium mb-0">{{ t('admin.seatContent.files.title') }}</h3>
            <p class="text-[11px] text-black/40">{{ t('admin.seatContent.files.rootHint') }}</p>
            <p v-if="treeError" data-test="tree-error" class="syserr text-xs">{{ treeError }}</p>
          </header>
          <div class="min-h-0 flex-1 overflow-auto py-1">
            <p
              v-if="!selectedFde"
              class="px-2 py-2 text-xs text-black/45"
            >{{ t('admin.seatContent.empty.hint') }}</p>
            <AdminSeatTreeNode
              v-for="entry in childMap[TREE_ROOT] ?? []"
              :key="entry.name"
              :entry="entry"
              :path="TREE_ROOT"
              :depth="0"
              :child-map="childMap"
              :expanded="expanded"
              :loading="dirLoading"
              :truncated="truncated"
              :highlight="highlightName"
              :toggle-dir="toggleDir"
              :file-click="selectFile"
              :load-more="(key: string) => loadDir(key, true)"
              :selected-file="selectedFilePath"
            />
            <button
              v-if="truncated[TREE_ROOT]"
              type="button"
              data-test="tree-load-more"
              class="block px-2 py-1 text-left text-xs underline"
              @click="loadDir(TREE_ROOT, true)"
            >{{ t('admin.seatContent.files.loadMore') }}</button>
          </div>
        </section>
      </aside>

      <!-- 右栏：面包屑 + 内容 -->
      <main class="flex min-w-0 flex-1 flex-col rounded-md border border-black/10">
        <p
          v-if="!hasSelection"
          data-test="empty-state"
          class="m-auto max-w-sm px-4 py-8 text-center text-sm text-black/45"
        >
          <span class="block text-base text-black/70">
            {{ t('admin.seatContent.empty.title') }}
          </span>

          {{ t('admin.seatContent.empty.hint') }}
        </p>

        <!-- 会话：面包屑 + 元信息 + 对话（AdminTranscript 自己管历史与折叠原文） -->
        <template v-else-if="selectedSession">
          <header class="shrink-0 border-b border-black/10 px-3 py-2">
            <div class="truncate text-sm">
              <span class="text-black/50">{{ selectedFde }}</span>
              <span class="text-black/30"> / </span>
              <span class="font-medium">{{ sessionTitle(selectedSession) }}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-black/55">
              <span
                v-for="cell in metaCells"
                :key="cell.key"
                :data-test="cell.test"
              >{{ cell.label }}: {{ cell.value }}</span>
              <span
                v-if="selectedSession.active_run_id"
                data-test="meta-running"
                :class="CLS_RUN_BADGE"
              >
                <span :class="CLS_RUN_DOT"></span>
                {{ t('admin.seatContent.sessions.running') }}
              </span>
            </div>
            <p
              v-if="sessionDetailError"
              data-test="session-detail-error"
              class="syserr mt-1 text-xs"
            >
              {{ sessionDetailError }}
            </p>
          </header>
          <AdminTranscript
            :fde="selectedFde"
            :session-id="selectedSession.id"
            :detail="sessionDetail"
            :include-archived="includeArchived"
          />
        </template>

        <!-- 文件：面包屑 + 预览 -->
        <template v-else>
          <header class="flex shrink-0 items-center gap-2 border-b border-black/10 px-3 py-2">
            <div class="min-w-0 truncate text-sm">
              <span class="text-black/50">{{ selectedFde }}</span>
              <span v-for="dir in fileDirs" :key="dir" class="text-black/30"> / </span><span
                v-for="dir in fileDirs"
                :key="`d-${dir}`"
                class="text-black/50"
              >{{ dir }} / </span>
              <span class="font-medium">{{ fileName }}</span>
            </div>
            <a
              data-test="file-download"
              :href="downloadHref"
              :class="CLS_LINK"
              :download="fileName"
            >{{ t('admin.seatContent.preview.download') }}</a>
          </header>

          <div class="min-h-0 flex-1 overflow-auto px-3 py-2">
            <p
              v-if="fileLoading"
              class="text-sm text-black/45"
            >{{ t('admin.seatContent.preview.loading') }}</p>
            <div v-else-if="fileError" data-test="file-error" role="alert" class="py-4 text-center">
              <p class="syserr text-sm">{{ fileError }}</p>
              <p class="mt-1 text-xs text-black/45">
                {{ t('admin.seatContent.preview.tooLargeHint') }}
              </p>

              <a
                data-test="file-download-instead"
                :href="downloadHref"
                :class="CLS_LINK_BIG"
                :download="fileName"
              >{{ t('admin.seatContent.preview.downloadInstead') }}</a>
            </div>

            <template v-else-if="fileChannel === 'native-json' && fileJson">
              <img
                v-if="fileJson.kind === 'image'"
                data-test="file-image"
                :src="fileJson.data"
                :alt="t('admin.seatContent.preview.imageAlt', { name: fileJson.name })"
                class="mx-auto max-h-full max-w-full"
              >
              <div
                v-else-if="fileIsMarkdown"
                data-test="file-markdown"
                class="md text-sm"
                v-html="fileMarkdownHtml"
              ></div>
              <pre
                v-else
                data-test="file-text"
                class="overflow-auto whitespace-pre-wrap break-words font-mono text-xs"
              >{{ fileJson.data }}</pre>
            </template>

            <!-- 流式通道：URL 直接给原生元素，本页不发这个请求（浏览器自己取） -->
            <object
              v-else-if="fileChannel === 'native-stream' && fileMediaKind === 'pdf'"
              data-test="file-pdf"
              type="application/pdf"
              :data="streamUrl"
              class="h-full w-full"
            ></object>
            <video
              v-else-if="fileChannel === 'native-stream' && fileMediaKind === 'video'"
              data-test="file-video"
              controls
              class="mx-auto max-h-full max-w-full"
              :src="streamUrl"
            ></video>
            <audio
              v-else-if="fileChannel === 'native-stream' && fileMediaKind === 'audio'"
              data-test="file-audio"
              controls
              class="mx-auto mt-6 w-full"
              :src="streamUrl"
            ></audio>

            <!-- Office / 压缩包 / 清单外：不发任何预览请求，唯一出口是下载 -->
            <div v-else data-test="file-download-only" class="py-6 text-center">
              <p class="text-sm text-black/45">
                {{ t('admin.seatContent.preview.notPreviewable') }}
              </p>
            </div>
          </div>
        </template>
      </main>
    </div>
  </div>
</template>
