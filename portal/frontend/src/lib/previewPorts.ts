// 预览端口面板的纯逻辑（#246 交付② 单 B）。
// 契约唯一来源：docs/api/portal.md §4.7a（列端点 / 管理员改块）与 §2.8（签票端点）。
// 为什么单独成文件：本单最容易做坏的三处判据（**票不预取**、**ticket 不重复拼进 URL**、
// **改块前必须二次确认**）里，前两条是纯函数可以钉的——放组件里就只能靠装配才能测。
// 红线：后端零改动，这里只是把常量与规则镜像一份用于 UI 提示（判据仍在服务端）。

/**
 * 观测注解（端口呈现优化·观测层 MVP，迁移 0022）：容器内该端口此刻**真有进程在听**的旁证
 * （agentd /proc 采样随 heartbeat 落库，portal 按新鲜度窗口附进 §4.7a 列表 DTO）。
 * ⚠ `observed:null` ≠ 「没应用在监听」：旧 agentd 不上报 / 未跑 0022 的部署也是 null，
 * 前端不得把 null 画成「空闲/停止」。
 */
export interface PreviewObserved {
  pid: number | null;
  /** ~/projects/<name> 形（家目录内归一）；家目录外进程是绝对路径；反查不到 ⇒ null。 */
  cwd: string | null;
  cmd: string | null;
  /** cwd 处 .git/HEAD 的分支；detached/非仓库/反查不到 ⇒ null。 */
  branch: string | null;
  /** 进程启动时刻（ISO）——比分支更诚实：原地切分支后旧进程服务的已是新代码。 */
  started_at: string | null;
  /** 最后一次采样到它的时刻（ISO）。 */
  observed_at: string | null;
}

/** 列端点的行（GET /api/me/ports 与 GET /api/admin/fdes/:fdeName/ports 同形同序，§4.7a）。 */
export interface PreviewPortItem {
  id: string;
  port: number;
  /** 端口池外的观测合成行（state='observed'，id=`observed:<port>`）无地址：null ⇒ 不可开/不可复制。 */
  hostname: string | null;
  url: string | null;
  /** allocated | active（released 的行后端不列）。 */
  state: string;
  scope: string;
  role: string;
  exposure: string;
  /** 可选：旧后端（未跑 0022）不返这个字段 ⇒ undefined 也要能画。 */
  observed?: PreviewObserved | null;
}

/** POST /api/ports/:id/preview-ticket 的 201 响应（§2.8）。 */
export interface PreviewTicketResponse {
  ticket: string;
  /** §2.8：后端返回的 url **已经**带 `?preview_ticket=`，前端不得自行再拼一遍。 */
  url: string;
  expires_in: number;
}

/**
 * `POST /api/me/ports/batch-tickets` 的单项（§4.7a，#247 一键放行整组）。
 * 字段形态与单据端点对齐（`url` 已带票），另加 `id`/`port`/`expires_at`：
 * `id` 让前端能把票对回列表行（服务端保证顺序与请求一致，但按 id 对账更稳）。
 */
export interface PreviewBatchTicketItem {
  id: string;
  port: number;
  /** 已带 `?preview_ticket=` 的完整地址（同 §2.8，前端不得自行拼接）。 */
  url: string;
  ticket: string;
  /** 整批共用一个 ISO 时间戳（= 签发时刻 + 票 TTL）。 */
  expires_at: string;
}

/** `POST /api/me/ports/batch-tickets` 的 201 响应（信封同列表端点 `{items:[...]}`）。 */
export interface PreviewBatchTicketsResponse {
  items: PreviewBatchTicketItem[];
}

/** POST /api/admin/fdes/:fdeName/ports/block 的 200 响应（§4.7a）。 */
export interface PreviewBlockMoveResult {
  changed: boolean;
  fde_name: string;
  block_start: number;
  block_end: number;
  ports: number[];
  released_allocations: number;
  revoked_grants: number;
  inserted_allocations: number;
}

/**
 * 后端错误的关键三面（展示与分支判定都要用；message 一律原文透传，不翻译、不截断）。
 *
 * #256 交付②：另带 `retryAfter`——`ApiError` 上**已经有**这个字段（类体里的 `retryAfter: number | null` 声明；
 * 取值来自 `api()` 里 `if (!r.ok)` 分支 `new ApiError(...)` 的最后一个实参
 * `parseRetryAfter(r.headers.get('Retry-After'))`，解析不出为 `null`），所以「429 的多久后重试」只在前端补一句文案即可，
 * 不需要后端把秒数写进 `error.message`（那会变成两个真相源）。
 */
export interface PreviewApiError {
  status: number;
  code: string;
  message: string;
  /** 400 validation_failed 时服务端给 details.field（§4.7a 的 block_start/fde_name）。 */
  field: string | null;
  /** `Retry-After` 头里的秒数（429 `rate_limited` / 503 `kdf_busy`）；缺头或不可解 ⇒ `null`。 */
  retryAfter?: number | null;
}

// 号池常量（镜像 portal/src/previewpool.js：池 22000–29999、每段 10 个、块起点对齐）。
// 只用于输入提示（min/max/step）与文案，**不参与请求成败判定**——判据在服务端。
export const PREVIEW_PORT_POOL_START = 22000;
export const PREVIEW_PORT_POOL_END = 29999;
export const PREVIEW_PORT_BLOCK_SIZE = 10;

/** 列端点会出现的 state 取值（§4.7a：released 不列 ⇒ 只剩这两个；文案键集与它对齐）。 */
export const PREVIEW_PORT_STATES = ['allocated', 'active'] as const;
export type PreviewPortState = (typeof PREVIEW_PORT_STATES)[number];

/** 把后端给的 state 收成本地在册取值；未知值返回 null（走「未知状态」兜底，不猜语义）。 */
export function asPreviewPortState(state: string): PreviewPortState | null {
  return (PREVIEW_PORT_STATES as readonly string[]).includes(state)
    ? (state as PreviewPortState)
    : null;
}

/** 本人列端点。 */
export const myPortsPath = '/api/me/ports';

/** 管理员列某 FDE 的端点（fdeName 走 encodeURIComponent，与 admin 面其它端点一致）。 */
export function adminFdePortsPath(fdeName: string): string {
  return `/api/admin/fdes/${encodeURIComponent(fdeName)}/ports`;
}

/** 管理员改块端点（列端点 + `/block`）。 */
export function adminFdePortsBlockPath(fdeName: string): string {
  return `${adminFdePortsPath(fdeName)}/block`;
}

/**
 * 签票端点：**路径参数是列表里的 allocation UUID**（§4.7a 的 `id` 字段就是为它存在的）。
 * 单测钉这一点（防「拿 port 号当 id」这种看起来能跑、实际 404 的实现）。
 */
export function previewTicketPath(allocationId: string): string {
  return `/api/ports/${encodeURIComponent(allocationId)}/preview-ticket`;
}

/**
 * 批量签票端点（#247）：**路径里不带 allocation id**，要签的行由请求体的 `allocation_ids` 给
 * （不给就是「本 FDE 全部活行」）。一次最多 `PREVIEW_PORT_BLOCK_SIZE` 行（服务端判据）。
 */
export const batchTicketsPath = '/api/me/ports/batch-tickets';

/**
 * 拼「新标签要打开的预览 URL」——**同一张票只出现一次**。
 * §2.8 的 `url` 已含 `?preview_ticket=`（文档明写「前端不得自行拼接」）⇒ 原样用；
 * 桩/旧形给裸 url 时补挂一次（带别的查询参数则用 `&`）。
 * 入参只要求 `{url, ticket}` ⇒ 单据响应与批量响应的单项共用本函数（两条路的拼法只能有一份）。
 */
export function previewTargetUrl(response: PreviewTicketResponse | PreviewBatchTicketItem): string {
  const url = typeof response.url === 'string' ? response.url : '';
  const ticket = typeof response.ticket === 'string' ? response.ticket : '';
  if (!ticket) return url;
  if (/[?&]preview_ticket=/.test(url)) return url;
  const joiner = url.includes('?') ? '&' : '?';
  return `${url}${joiner}preview_ticket=${encodeURIComponent(ticket)}`;
}

/**
 * 输入框原值 → 整数（只承认纯十进制整数：`''`/`2201a`/`22010.5`/`1e4` 一律 null）。
 * 判据仍在服务端（池范围与对齐都返回 400 validation_failed + details.field='block_start'），
 * 这里只拦「连整数都不是」的输入——否则请求体连 `{ block_start: <整数> }` 都凑不出来。
 */
export function parseBlockStart(raw: string): number | null {
  const trimmed = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/** 本地提示用：是否为池内、按块大小对齐的块起点（不合规照样让服务端判 400）。 */
export function isAlignedBlockStart(value: number): boolean {
  return (
    Number.isInteger(value)
    && value >= PREVIEW_PORT_POOL_START
    && value <= PREVIEW_PORT_POOL_END
    && (value - PREVIEW_PORT_POOL_START) % PREVIEW_PORT_BLOCK_SIZE === 0
  );
}

/** 从活行列表算出「当前段」的起止（改块确认文案要点名旧段）。空列表 → null。 */
export function currentBlockRange(items: readonly PreviewPortItem[]): { start: number; end: number } | null {
  const ports = items.map((item) => item.port).filter((port) => Number.isFinite(port));
  if (ports.length === 0) return null;
  return { start: Math.min(...ports), end: Math.max(...ports) };
}

/** `22000–22009` 形态的段标签（确认文案与结果文案共用；null → 空串由调用方兜底）。 */
export function formatBlockRange(range: { start: number; end: number } | null): string {
  return range ? `${range.start}–${range.end}` : '';
}

/** 块起点 → 块末端（`22010 → 22019`）；确认/结果文案用它点名新段，不写死 +9。 */
export function previewBlockEnd(start: number): number {
  return start + PREVIEW_PORT_BLOCK_SIZE - 1;
}

/** 输入框的取值范围提示（min/max；判据仍在服务端）。 */
export const PREVIEW_BLOCK_START_MIN = PREVIEW_PORT_POOL_START;
export const PREVIEW_BLOCK_START_MAX = PREVIEW_PORT_POOL_END - PREVIEW_PORT_BLOCK_SIZE + 1;

/**
 * ApiError / 其它异常 → 展示与分支判定要的三面。
 * 非 ApiError（网络断、JSON 解析炸）没有 code：给 `unknown` 而不是空串，页面不会显示「（）：」。
 */
export function toPreviewApiError(err: unknown): PreviewApiError {
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 0;
  const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'unknown';
  const message = err instanceof Error && err.message ? err.message : String(err);
  const details = (err as { details?: { field?: unknown } })?.details;
  const field = typeof details?.field === 'string' ? details.field : null;
  // #256 交付②：`Retry-After` 秒数（ApiError 已解析好）原样带走；非有限数一律 null，
  // 让文案退到不带秒数的版本——宁可少说一个数字，不说 `NaN 秒`。
  const rawRetry = (err as { retryAfter?: unknown })?.retryAfter;
  const retryAfter = typeof rawRetry === 'number' && Number.isFinite(rawRetry) ? rawRetry : null;
  return { status, code, message, field, retryAfter };
}

/**
 * 429/503 的「多久后重试」秒数（#256 交付②）：只认 `> 0` 的有限数。
 * 返回 `null` ⇒ 调用方用不带秒数的文案（**绝不**显示 `undefined 秒` / `NaN`）。
 */
export function retryAfterSeconds(error: PreviewApiError): number | null {
  const value = error.retryAfter;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const seconds = Math.max(0, Math.round(value));
  return seconds > 0 ? seconds : null;
}

// ---------------------------------------------------------------------------
// 观测层呈现（端口呈现优化 MVP）的纯判据——组件里只留装配，判据在这里可单测。
// ---------------------------------------------------------------------------

/**
 * 「同一目录/仓库多实例」分组：`observed.cwd` 相同的活观测 ≥2 条 ⇒ 这就是用户分不清的现场
 * （真机：同一项目两个分支的 dev server 各占 22000/22001）。
 * 只按 cwd 精确分组——repo 归组要 git commdir，观测数据里没有，宁缺毋滥。
 */
/**
 * 观测 cwd → 项目根（`~/projects/<name>`）：子目录里起的服务（frontend/、apps/web/）归到项目本身；
 * 非项目目录（agentd 自己的 /opt 等）返回 null——两个分组面板都不收。
 * 未 sanitize 的绝对形（/home/<u>/projects/…）同样命中（与 portalloc 合成行同口径）。
 */
export function projectRootOf(cwd: string | null | undefined): string | null {
  if (typeof cwd !== 'string') return null;
  const matched = /^(?:~|\/home\/[^/]+)\/projects\/([^/]+)/.exec(cwd);
  return matched ? `~/projects/${matched[1]}` : null;
}

/** 按项目根分组（池内+池外一视同仁）；非项目观测丢弃，组内按 port ASC、组间按目录名字序。 */
export function groupByProject(items: PreviewPortItem[]): Array<{ root: string; items: PreviewPortItem[] }> {
  const byRoot = new Map<string, PreviewPortItem[]>();
  for (const item of items) {
    const root = projectRootOf(item.observed?.cwd);
    if (root === null) continue;
    const bucket = byRoot.get(root) ?? [];
    bucket.push(item);
    byRoot.set(root, bucket);
  }
  return [...byRoot.entries()]
    .map(([root, bucket]) => ({ root, items: bucket.sort((a, b) => a.port - b.port) }))
    .sort((a, b) => a.root.localeCompare(b.root));
}

export function duplicateObservedGroups(items: PreviewPortItem[]): Array<{ cwd: string; ports: number[] }> {
  const byCwd = new Map<string, number[]>();
  for (const item of items) {
    // 按项目根归并（用户实证：主目录一个口 + 子目录一个口也是「同一项目两实例」，精确比 cwd 会漏报）。
    const cwd = projectRootOf(item.observed?.cwd);
    if (cwd === null) continue;
    const list = byCwd.get(cwd) ?? [];
    list.push(item.port);
    byCwd.set(cwd, list);
  }
  return [...byCwd.entries()]
    .filter(([, ports]) => ports.length >= 2)
    .map(([cwd, ports]) => ({ cwd, ports: ports.sort((a, b) => a - b) }));
}

/** 观测行的「起了多久」摘要（相对时刻——绝对时间戳在侧栏 163px 里既放不下也没人看）。 */
export function formatStartedAgo(startedAtIso: string, nowMs: number = Date.now()): string | null {
  const t = Date.parse(startedAtIso);
  if (!Number.isFinite(t)) return null;
  const minutes = Math.floor((nowMs - t) / 60_000);
  if (minutes < 0) return null; // 时钟漂移（started_at 在未来）⇒ 宁可不显示
  if (minutes < 60) return `${Math.max(minutes, 1)}m`; // 不足 1 分钟也报 1m，不显示 0m
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (60 * 24))}d`;
}
