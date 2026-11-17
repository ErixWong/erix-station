// 宏用户面的**视图层纯函数**（issue #528，事件平台 W5）。
//
// 为什么单独成 lib：站内口径是「DTO 归一化 / 判定 / 文案映射都在 lib，纯函数可单测」
// （见 `lib/tlsSettings.ts`、`lib/previewPoolUsage.ts`、`lib/mailSettings.ts`），
// store 只负责「一次调用 = 一次请求」，组件只负责渲染。五类判据（`07` §21.5）全部
// 落在这里或组件的 DOM 断言上，不靠快照。
//
// ⚠ 枚举一律 import `@shared/macro-kinds`（契约 `10` 篇 §1 的单一真源）。
// 本文件**不许**出现枚举字面量数组——防漂移：portal/test/macro-kinds-single-source.test.js。
import { EVAL_INTERVAL_MS, SKIPPED_REASON, STALE_INTERVAL_MULTIPLE, STATUS, VERDICT } from '@shared/macro-kinds';

/**
 * 水位线新鲜阈值（`09` 篇 §1.1：`now - last_evaluated_at > 3 × 评估间隔` 即陈旧）。
 * 间隔与倍数的**权威值**在 shared 真源（后端 `macro-eval.js` re-export 同一份），
 * 本文件只是消费方——两边各写 180_000 就会漂。
 */
export const WATERMARK_STALE_MS = STALE_INTERVAL_MULTIPLE * EVAL_INTERVAL_MS;

// ── DTO 形状（后端下发 snake_case，前端只留用户面该看的字段）──────────────────

export interface MacroTemplate {
  id: string;
  kind: string;
  name: string;
  scope: string;
  audience: string;
  params: Record<string, unknown>;
}

export interface MacroAssignment {
  id: string;
  templateId: string;
  sessionId: string | null;
  /** 订阅的运行目录（issue #623：`scope='user'` 订阅必填 `~/projects/<name>`；会话级为 null）。可选以免扰动既有会话级构造。 */
  cwd?: string | null;
  until: string | null;
  enabled: boolean;
  expired: boolean;
  effectiveEnabled: boolean;
  /** 水位线（`09` 篇 §1.1）：求值成功才推进，失败保持陈旧。`null` = 尚未评估。 */
  lastEvaluatedAt: string | null;
  createdAt: string | null;
}

/** 一次触发的实测用量；**没有就是 `null`**（不是 0，见 §12/§15「不知道不渲染成 0」）。 */
export interface MacroUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface MacroRun {
  id: string;
  assignmentId: string;
  anchor: string | null;
  status: string;
  criterion: string | null;
  verdict: string | null;
  skippedReason: string | null;
  /** 动作与结果的人话来源（`remediation_text` / `reason`）；原始错误码不在用户面暴露。 */
  actionText: string | null;
  startedAt: string;
  finishedAt: string | null;
  depth: number;
  childSessionId: string | null;
  childRunId: string | null;
  usage: MacroUsage | null;
  /** 未完成（`07` §16：有未完成的记录才轮询）。 */
  pending: boolean;
}

export interface MacroNotification {
  id: string;
  severity: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string | null;
}

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** 归一时刻为 ISO 串（pg 的 `timestamptz` 是 `Date`，JSON 里是 ISO 串）。 */
function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  return Number.isNaN(Date.parse(text)) ? null : new Date(text).toISOString();
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

/**
 * 模板行 → 前端形状（用户面六项，`created_by` / `enabled` / `deleted_at` 后端就不下发）。
 */
export function normalizeTemplate(row: Record<string, unknown> | null | undefined): MacroTemplate | null {
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    kind: String(row.kind ?? ''),
    name: String(row.name ?? ''),
    scope: String(row.scope ?? ''),
    audience: String(row.audience ?? ''),
    params: (row.params && typeof row.params === 'object' ? row.params : {}) as Record<string, unknown>,
  };
}

export function normalizeAssignment(row: Record<string, unknown> | null | undefined): MacroAssignment | null {
  if (!row) return null;
  const enabled = row.enabled === true;
  const expired = row.expired === true;
  return {
    id: String(row.id ?? ''),
    templateId: String(row.template_id ?? row.templateId ?? ''),
    sessionId: str(row.session_id ?? row.sessionId ?? null),
    cwd: str(row.cwd ?? null),
    until: iso(row.until),
    enabled,
    expired,
    effectiveEnabled: row.effective_enabled === undefined ? enabled && !expired : row.effective_enabled === true,
    lastEvaluatedAt: iso(row.last_evaluated_at ?? row.lastEvaluatedAt),
    createdAt: iso(row.created_at ?? row.createdAt),
  };
}

/**
 * 用量归一：后端 `macro_runs` 目前**没有** token 记账列（`usage` 不下发或为 `null`）。
 * ⚠ 缺失 ⇒ `null`，**绝不补 0**（`07` §12/§15：「不知道」不渲染成 `↑0 ↓0`）。
 */
export function normalizeUsage(raw: unknown): MacroUsage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const input = num(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const output = num(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? usage.completionTokens);
  if (input === null && output === null) return null;
  return { inputTokens: input ?? 0, outputTokens: output ?? 0 };
}

/**
 * 执行账行 → 用户面形状。
 *
 * ⚠ **`snapshot_id` / `worktree_path` 在这里被丢掉**（`09` §3.2：用户看不到），
 * 不是「渲染时不显示」——丢在归一层，组件拿不到就不可能不小心印出来。
 */
export function normalizeRun(row: Record<string, unknown> | null | undefined): MacroRun | null {
  if (!row) return null;
  const status = String(row.status ?? '');
  const startedAt = iso(row.started_at ?? row.startedAt) ?? '';
  const finishedAt = iso(row.finished_at ?? row.finishedAt);
  const reason = str(row.reason);
  const remediation = str(row.remediation_text ?? row.remediationText);
  return {
    id: String(row.id ?? ''),
    assignmentId: String(row.assignment_id ?? row.assignmentId ?? ''),
    anchor: str(row.anchor),
    status,
    criterion: str(row.criterion),
    verdict: str(row.verdict),
    skippedReason: str(row.skipped_reason ?? row.skippedReason),
    // 审查整改文本是给用户看的人话；`reason` 里可能是原始错误码 ⇒ 只在没有人话时用，
    // 且由组件按「管理员诊断面字段」对待（不直接印错误码串）。
    actionText: remediation ?? reason,
    startedAt,
    finishedAt,
    depth: num(row.depth) ?? 0,
    childSessionId: str(row.child_session_id ?? row.childSessionId),
    childRunId: str(row.child_run_id ?? row.childRunId),
    usage: normalizeUsage(row.usage),
    pending: finishedAt === null && (status === 'pending' || status === 'running'),
  };
}

export function normalizeNotification(row: Record<string, unknown> | null | undefined): MacroNotification | null {
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    severity: String(row.severity ?? 'info'),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    readAt: iso(row.read_at ?? row.readAt),
    createdAt: iso(row.created_at ?? row.createdAt),
  };
}

// ── 文案映射（判决 / 跳过 / kind）：键是枚举成员，值不存在 ⇒ 退回 unclassified 口径 ──

/** `verdict` → i18n 后缀（`07` §6.1 的用词：通过 / 整改 / 未证实有改动 / 需人工 / 未判）。 */
const VERDICT_KEY: Record<string, string> = {
  pass: 'pass',
  red: 'red',
  'no-op-claim': 'noop',
  'needs-human': 'human',
  unclassified: 'unclassified',
};

/**
 * 判决 → i18n 键。未知值一律退回 `macro.verdict.unclassified`（`07` §6.1：「未判」是平台状态，
 * 正是给「后端加了新判决而前端还没对译」准备的）。
 */
export function verdictMessageKey(verdict: string | null | undefined): string {
  const key = verdict ? VERDICT_KEY[verdict] : undefined;
  return `macro.verdict.${key ?? 'unclassified'}`;
}

/** `skipped_reason` → i18n 后缀（`09` §3.3 的人话对照；原始枚举不进 UI）。 */
const SKIP_KEY: Record<string, string> = {
  budget_exhausted: 'budget',
  quiet_hours: 'quietHours',
  human_present: 'humanPresent',
  run_in_progress: 'runInProgress',
  deferred: 'deferred',
  deferred_timeout: 'deferredTimeout',
  active_run_in_cwd: 'activeRunInCwd',
  cancelled_by_user: 'cancelledByUser',
};

/**
 * 跳过原因 → i18n 键；未知原因退回 `macro.skip.unknown`（不裸露枚举字面量）。
 * 「认识不认识」以 shared 枚举为准（`SKIPPED_REASON`），不拿本地表的键当权威——
 * 否则后端新加一个门禁时，本地表永远比枚举少一项而看不出来。
 */
export function skipMessageKey(reason: string | null | undefined): string {
  const known = typeof reason === 'string' && SKIPPED_REASON.includes(reason);
  const key = known ? SKIP_KEY[reason as string] : undefined;
  return `macro.skip.${key ?? 'unknown'}`;
}

/** 该跳过原因是否走「额度风险」的琥珀档（`07` §13.1：只有额度这一种是）。 */
export function skipIsBudgetRisk(reason: string | null | undefined): boolean {
  return reason === 'budget_exhausted';
}

/** `kind` → i18n 后缀（`macro.kind.*`）。 */
const KIND_KEY: Record<string, string> = {
  'run-notify': 'runNotify',
  'run-silence-alert': 'runSilence',
  'run-review': 'runReview',
  'scheduled-task': 'scheduledTask',
};

export function kindMessageKey(kind: string | null | undefined): string {
  return `macro.kind.${kindSuffixOf(kind)}`;
}

/**
 * `kind` → i18n 后缀（`macro.kind.*` / `macro.kind.desc.*`）。
 * 未知 kind 退回 `unknown` 而不是返原枚举（否则原始枚举会直接出现在用户屏幕上，`09` §3.2）。
 */
export function kindSuffixOf(kind: string | null | undefined): string {
  const key = kind ? KIND_KEY[kind] : undefined;
  return key ?? 'unknown';
}

/** 执行账状态 → i18n 键（`07` §13.1：文字承重，颜色只是复述）。已知集取自 shared 的 `STATUS`。 */
export function statusMessageKey(status: string | null | undefined): string {
  const known = typeof status === 'string' && STATUS.includes(status);
  return `macro.status.${known ? status : 'unknown'}`;
}

/**
 * 判决档位（颜色不承重，语义在文字里）。已知集取自 shared 的 `VERDICT`：
 * 不认识的判决走中性档 + 「未判」文案，而不是拿颜色抢语义。
 */
export function verdictTone(verdict: string | null | undefined): 'neutral' | 'warn' | 'danger' {
  const known = typeof verdict === 'string' && VERDICT.includes(verdict);
  if (!known || verdict === 'pass') return 'neutral';
  return verdict === 'needs-human' ? 'danger' : 'warn';
}

// ── 跳过聚合（`07` §13.2）────────────────────────────────────────────────────

export type MacroFeedItem =
  | { kind: 'run'; key: string; run: MacroRun; repeatCount: number }
  | {
    kind: 'skippedGroup';
    key: string;
    reason: string | null;
    /** 组内按时间倒序的成员（展开时才逐个显示时刻）。 */
    runs: MacroRun[];
    repeatCount: number;
    latest: MacroRun;
  };

/**
 * **连续**同因跳过合成**一条**汇总行；**不同因不合并**（`07` §13.2：
 * 「静默时段 ×3」与「额度用完 ×2」是两件事）。
 *
 * 「连续」按传入顺序（API 是 `started_at DESC`，即时间倒序）判定：中间夹进任何一条
 * 非跳过记录或不同原因的跳过，就断成两组。
 */
export function aggregateSkippedRuns(runs: MacroRun[]): MacroFeedItem[] {
  const items: MacroFeedItem[] = [];
  for (const run of runs) {
    const isSkipped = run.status === 'skipped' && run.skippedReason !== null;
    const tail = items[items.length - 1];
    if (isSkipped && tail && tail.kind === 'skippedGroup' && tail.reason === run.skippedReason) {
      tail.runs.push(run);
      tail.repeatCount = tail.runs.length;
      continue;
    }
    if (isSkipped) {
      items.push({
        kind: 'skippedGroup',
        key: `skip:${run.skippedReason}:${run.id}`,
        reason: run.skippedReason,
        runs: [run],
        repeatCount: 1,
        latest: run,
      });
      continue;
    }
    items.push({ kind: 'run', key: run.id, run, repeatCount: 1 });
  }
  return items;
}

// ── 水位线（健康告警）────────────────────────────────────────────────────────

export interface WatermarkState {
  /** 最近一次成功评估（订阅卡片上那个「上次评估 14:03:12」）。 */
  last: string | null;
  /** 陈旧 ⇒ 告警进**顶部状态条**（`07` §17.3，不放空态区）。 */
  stale: boolean;
  /** 有生效订阅但一条都没评估过（首次订阅）：显示「尚未评估」而不是「47 分钟前」。 */
  neverEvaluated: boolean;
}

/**
 * 水位线状态：取**所有生效订阅里最新**的那条作为「上次评估」，
 * 但只要**有任何一条**生效订阅陈旧，就算陈旧（`09` §1.1：求值抛异常的那条不推进水位线，
 * 陈旧正是它唯一的暴露方式——取 max 会把坏掉的那条藏起来）。
 */
export function watermarkState(assignments: MacroAssignment[], nowMs: number): WatermarkState {
  const active = assignments.filter((a) => a.effectiveEnabled);
  if (active.length === 0) return { last: null, stale: false, neverEvaluated: false };
  const stamps = active
    .map((a) => a.lastEvaluatedAt)
    .filter((v): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
    .sort();
  const last = stamps.length > 0 ? stamps[stamps.length - 1] : null;
  const stale = active.some((a) => {
    if (a.lastEvaluatedAt === null) {
      // 尚未评估 ≠ 水位线陈旧（`09` §1.1 把「首次订阅」与「水位线陈旧」分开）：
      // 只有过了宽限窗（`createdAt + 3 × 间隔`）仍没推进过，才算陈旧——执行器真挂了
      // 仍会被抓到，但不对刚建的订阅误报（否则每个新订阅都闪一次 ⚠，狼来了）。
      if (a.createdAt === null) return false;
      const created = Date.parse(a.createdAt);
      return !Number.isNaN(created) && nowMs - created > WATERMARK_STALE_MS;
    }
    const ts = Date.parse(a.lastEvaluatedAt);
    return Number.isNaN(ts) || nowMs - ts > WATERMARK_STALE_MS;
  });
  return { last, stale, neverEvaluated: stamps.length === 0 };
}

// ── 空态（`07` §17）：技术态与业务态**分开**，各判各的 ────────────────────────

export type MacroPanelState =
  | 'loading'
  | 'failed'
  | 'noSubscription'
  | 'neverTriggered'
  | 'filteredEmpty'
  | 'ready';

/**
 * 面板该显示哪一态（判据①「空态四选一」）。
 *
 * 顺序是判据的一部分：**技术态先于业务态**（§17.1「加载失败不能伪装成空」），
 * 业务态内部再按「没订阅 → 没触发 → 筛选空 → 有内容」排。
 */
export function panelState(input: {
  loading: boolean;
  failed: boolean;
  assignments: readonly MacroAssignment[];
  runs: readonly MacroRun[];
  filterActive: boolean;
}): MacroPanelState {
  if (input.loading) return 'loading';
  if (input.failed) return 'failed';
  if (input.assignments.length === 0) return 'noSubscription';
  if (input.runs.length === 0) return input.filterActive ? 'filteredEmpty' : 'neverTriggered';
  return 'ready';
}

/** 业务空态文案键（技术态 loading/failed 由组件走 `macro.loading` / `macro.loadFailed`）。 */
export function emptyStateMessageKey(state: MacroPanelState): string | null {
  switch (state) {
    case 'noSubscription': return 'macro.empty.noSubscription';
    case 'neverTriggered': return 'macro.empty.neverTriggered';
    case 'filteredEmpty': return 'macro.empty.filtered';
    case 'ready': return null;
    default: return null;
  }
}

// ── 成本（`07` §15）──────────────────────────────────────────────────────────

export interface CostSummary {
  triggers: number;
  inputTokens: number;
  outputTokens: number;
  /** 有实测用量的条数——为 0 时整条汇总不显示（不写「↑0 ↓0」）。 */
  measured: number;
}

/** 会话级汇总（范围必须是「本会话」，§15 第 2 条：范围未定只显示本会话）。 */
export function summarizeUsage(runs: readonly MacroRun[]): CostSummary {
  const summary: CostSummary = { triggers: runs.length, inputTokens: 0, outputTokens: 0, measured: 0 };
  for (const run of runs) {
    if (!run.usage) continue;
    summary.measured += 1;
    summary.inputTokens += run.usage.inputTokens;
    summary.outputTokens += run.usage.outputTokens;
  }
  return summary;
}

/** 千位压缩（`↑82k`）；**没有实测用量就返回 null**，不返回 `↑0 ↓0`。 */
export function formatTokens(usage: MacroUsage | null): string | null {
  if (!usage) return null;
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
  return `↑${k(usage.inputTokens)} ↓${k(usage.outputTokens)}`;
}

/** 金额（§15 第 1 条：单价未确认就**只给 token 不给钱**）。 */
export function formatCostEstimate(
  usage: MacroUsage | null,
  price: { inputPerToken?: number | null; outputPerToken?: number | null } | null,
): string | null {
  if (!usage || !price) return null;
  const inPrice = price.inputPerToken;
  const outPrice = price.outputPerToken;
  if (typeof inPrice !== 'number' || typeof outPrice !== 'number' || !Number.isFinite(inPrice) || !Number.isFinite(outPrice)) {
    return null;
  }
  const money = usage.inputTokens * inPrice + usage.outputTokens * outPrice;
  return `≈ ¥${money.toFixed(2)}`;
}

/** 耗时（`4m12s`）；没有 `finished_at` ⇒ null（不显示 `0s`）。 */
export function formatDuration(startedAt: string | null, finishedAt: string | null): string | null {
  if (!startedAt || !finishedAt) return null;
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** `14:03:12` 形态的本地时刻（`09` §3.1 的「上次评估 14:03:12」）。 */
export function formatClock(iso: string | null, timeZone = 'Asia/Shanghai'): string | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone,
    }).format(new Date(ts));
  } catch {
    return new Date(ts).toISOString().slice(11, 19);
  }
}

/** 分钟差（健康告警要说「47 分钟前」，`07` §17.3 要求给最后成功时刻 + 预期频率 + 下一步）。 */
export function minutesAgo(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.round((nowMs - ts) / 60_000));
}

/**
 * 宏会话（`07` §21.4）：`chat_sessions.origin LIKE 'macro:%'` ⇒ 单独分组「自动化」，
 * 分组内**不允许用户发消息**。
 */
export function isMacroSessionOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin.startsWith('macro:');
}

/** 会话级模板（`07` §3.2：用户面只列 `scope='session'` 的）。 */
export function isSessionScope(scope: string | null | undefined): boolean {
  return scope === 'session';
}
