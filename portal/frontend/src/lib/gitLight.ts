// 收工灯（issue #359 / 决策 §7 D9）的**纯函数层**：契约取数、脏载荷消毒、四态显示口径、预填文本取料。
// 为什么单独成文件（照 `lib/previewPorts.ts` 的路子）：判据必须能脱离 DOM 单测，且**红线只有一份**——
//   ① **⚪ 灰永远不得渲染成绿**：绿是承诺（"你的改动安全"），没检查完就没资格承诺。后端已经这么判了，
//      这里再兜一层（旧后端/新原因都不许把没查完的状态洗成绿）。
//   ② **不认识的值 ⇒ 灰**，不猜：`light`/`reason` 是服务端枚举，前端不赌它对齐（对齐了也不许因为
//      "没匹配上"就落到绿的分支）。
//   ③ 颜色不是唯一语义通道（`PreviewPortsPanel.vue` 立的规矩）：本层只给 state + 文案 key，
//      视图必须同时画文字，完整口径进 `title`/`aria-label`。
//   ④ 绿的说法要诚实：比的是**你已知的远端跟踪 ref**（只有 fetch/push 才更新），同事推了新东西而
//      你还没 fetch ⇒ 这里照样是绿。文案必须说"与你已知的远端一致"，不许说"远端是最新的"。
export const GIT_LIGHT_STATES = ['red', 'yellow', 'green', 'grey'] as const;
export type GitLightState = (typeof GIT_LIGHT_STATES)[number];

/** 后端 `GET /api/git-light` 的 repo 行（`portal/src/gitlight.js` 的返回体，字段名原样）。 */
export interface GitLightRepoRow {
  rel: string;
  repo: string;
  light: string;
  reason: string;
  shell: boolean;
  branch: string | null;
  no_commits: boolean;
  tracked_count: number;
  untracked_count: number;
  truncated: boolean;
  push_state: string;
}

export interface GitLightPayload {
  light: string;
  reason: string;
  primary: { rel: string; repo: string } | null;
  cwd: string;
  repos: GitLightRepoRow[];
  counts: { red: number; yellow: number; grey: number; green: number };
  partial: boolean;
  git_available: boolean;
  truncated_repos: number;
  checked_at: string;
}

/** 结构化错误（照 `toPreviewApiError` 的口径收窄：本面板只用到这三样）。 */
export interface GitLightApiError {
  status: number;
  code: string;
  message: string;
}

export function toGitLightApiError(err: unknown): GitLightApiError {
  const e = (err ?? {}) as { status?: unknown; code?: unknown };
  const status = typeof e.status === 'number' ? e.status : 0;
  // `ApiError.code` 的类型就是 `string | undefined` ⇒ 不能直接拿，否则这里返 `undefined`，
  // tooltip 里就会渗进 `undefined` 字面量（脉脏值不进用户可见文案）。
  const code = typeof e.code === 'string' && e.code ? e.code : 'unknown';
  const message = err instanceof Error && err.message ? err.message : String(err);
  return { status, code, message };
}

/** 端点路径的唯一构造点（query 编码不许散落在调用方）。 */
export function gitLightPath(cwd: string): string {
  return `/api/git-light?cwd=${encodeURIComponent(cwd)}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean => v === true;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 脏载荷消毒：拿值判形状，不 `as` 一把梭。
 * 不是对象 / `light` 不是四色之一 / `repos` 不是数组 ⇒ `null`（调用方显示"未检查"而不是崩，
 * 也不许因为解析失败就显绿）。行内字段同样逐个消毒，脏数字退 0、脏字符串退空。
 */
export function parseGitLightPayload(raw: unknown): GitLightPayload | null {
  if (!isRecord(raw)) return null;
  const light = str(raw.light);
  if (!(GIT_LIGHT_STATES as readonly string[]).includes(light)) return null;
  if (!Array.isArray(raw.repos)) return null;
  const counts = isRecord(raw.counts) ? raw.counts : {};
  const primary = isRecord(raw.primary) ? { rel: str(raw.primary.rel), repo: str(raw.primary.repo) } : null;
  return {
    light,
    reason: str(raw.reason) || 'unknown',
    primary,
    cwd: str(raw.cwd),
    repos: (raw.repos as unknown[]).filter(isRecord).map((r) => ({
      rel: str(r.rel),
      repo: str(r.repo),
      // 行内 light 同样要过枚举表：`??` / `ok` 这种脉字符串直接当颜色用，视图侧就会落到灰点但
      // 标签又拿到不存在的 key（上面那条单测钉的就是这个）。
      light: (GIT_LIGHT_STATES as readonly string[]).includes(str(r.light)) ? str(r.light) : 'grey',
      reason: str(r.reason) || 'unknown',
      shell: bool(r.shell),
      branch: typeof r.branch === 'string' ? r.branch : null,
      no_commits: bool(r.no_commits),
      tracked_count: num(r.tracked_count),
      untracked_count: num(r.untracked_count),
      truncated: bool(r.truncated),
      push_state: str(r.push_state) || 'unknown',
    })),
    counts: { red: num(counts.red), yellow: num(counts.yellow), grey: num(counts.grey), green: num(counts.green) },
    partial: bool(raw.partial),
    git_available: raw.git_available !== false,
    truncated_repos: num(raw.truncated_repos),
    checked_at: str(raw.checked_at),
  };
}

/** 显示口径：`state` 只可能是四色，且**灰吃掉绿**（partial / 没判完 / 不认识的值）。 */
export interface GitLightDisplay {
  state: GitLightState;
  /** `gitLight.reason.<reason>`；不认识的 reason 落 `gitLight.reason.unknown`（绝不落到绿的文案）。 */
  reasonKey: string;
  /** 是否该给「让 AI 收尾」——只有"改动还没保住"或"没推出去"才给。 */
  needsAction: boolean;
}

/** 已知的 reason 键集合（视图与测试共用；未知 reason 一律走 `unknown`）。 */
export const KNOWN_GIT_LIGHT_REASONS = [
  'uncommitted', 'untracked', 'no_commits',
  'unpushed_or_diverged', 'no_remote', 'no_upstream', 'never_fetched', 'detached', 'synced',
  'no_repo', 'covered_by_outer_repo', 'empty',
  'unchecked_partial', 'unchecked_failed', 'busy', 'unreadable', 'git_unavailable', 'shell', 'unknown',
] as const;

const KNOWN_REASONS: readonly string[] = KNOWN_GIT_LIGHT_REASONS;

export function gitLightReasonKey(reason: string): string {
  return `gitLight.reason.${KNOWN_REASONS.includes(reason) ? reason : 'unknown'}`;
}

/**
 * 显示口径的唯一计算点。
 * `payload === null`（没请求过 / 脏载荷 / 请求失败）⇒ `grey + unknown`，**不是绿**。
 */
export function gitLightDisplay(payload: GitLightPayload | null): GitLightDisplay {
  if (!payload) return { state: 'grey', reasonKey: 'gitLight.reason.unknown', needsAction: false };
  const known = (GIT_LIGHT_STATES as readonly string[]).includes(payload.light);
  let state: GitLightState = known ? (payload.light as GitLightState) : 'grey';
  if (payload.partial && state === 'green') state = 'grey'; // 后端已兜，这层防旧后端与未来回归
  const needsAction = state === 'red' || state === 'yellow';
  return { state, reasonKey: gitLightReasonKey(payload.reason), needsAction };
}

/**
 * 「让 AI 收尾」要点名的仓库名：**取脏的那些**（红/黄），不是全列。
 * 空壳外壳（`shell`）不参与点名（它恒为红，会把三个真仓库挤掉）；上限 6 个（预填是给 AI 读的长句，
 * 不是清单），超了就在末尾留 `more` 让文案说"还有 N 个"。
 */
export function dirtyRepoNames(payload: GitLightPayload | null, limit = 6): { names: string[]; more: number } {
  if (!payload) return { names: [], more: 0 };
  const dirty = payload.repos.filter((r) => !r.shell && (r.light === 'red' || r.light === 'yellow'));
  const names = dirty.slice(0, limit).map((r) => r.rel === '' ? r.repo : r.rel);
  return { names, more: Math.max(0, dirty.length - names.length) };
}

/** 相对时间（tooltip 里说"检查于 12 秒前"；不给绝对时间戳，用户不读 ISO）。 */
export function checkedAgo(checkedAt: string, now: number = Date.now()): string | null {
  const at = Date.parse(checkedAt);
  if (!Number.isFinite(at)) return null;
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}
