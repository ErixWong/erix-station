// 子 run（delegation）**活动面板**的数据层（issue #592 / 设计 `docs/design/delegation-activity-2026-11-16.md` §4.1 阶段 0 + §4.2）。
//
// 它只回答一个问题：**当前这个 run 派出去的几个子 run，现在活着几个、各自跑了多久**。
// 零后端改动：消费的端点 `GET /api/sessions/:id/delegates?runId=` 早在 delegation P2 就交付了，
// 一直**零消费者**（设计 §0 的第 1 条「缺的不是数据，是读它的那个读者」）。
//
// 三条不能写成别的样子的口径：
//   ① **触发条件 = 本轮存在 delegate 卡**，不是「run 在跑」。后者会在每一个没派过子任务的 run 上
//      白打 2s 心跳（长 run 常见），而「有没有派过子」前端本来就知道（`tool_use` 在历史白名单里
//      ⇒ 刷新后卡片会被回放重建，所以刷新路径同样要能触发，见 §4.4 ①）。
//      `card.runId` 缺席的卡**不算触发**：宁可少触发，也不要在一个认不出父 run 的老卡上永久轮询。
//   ② **分级唯一入口是 `lib/delegate.ts`**（`delegateBadgeKind` / `DELEGATE_LIVE_STATES`）。
//      本文件**不新造**任何状态枚举，也不写 `state === 'completed' ? 绿` 那种第二份尺规。
//   ③ **失败是静默的**：子 run 是加分项，读不到不该把父界面打成故障态（保留上次数据、不渲染红条），
//      只有连续失败到阈值才置一个**中性** `error` 标记，由 UI 出一行灰字（设计 §4.2 末段）。
//
// 轮询四条纪律（各一条反证用例，缺一不可）：
//   1. **单飞**：`setInterval` + `inFlight` 守卫。**故意不照抄 `DelegateChildDrawer` 的链式
//      `setTimeout`**——那条链结构上不可能并发，所以「单飞」在那儿是不可证伪的判据（设计 §8.7 记的
//      老账）；这里换成 interval + 守卫，判据才真的能红。
//   2. **可见性门控**：`document.visibilityState !== 'visible'` 时不发请求（只让 interval 续着），
//      重新可见**立刻补一发**（后台标签页不给服务端攒请求）。
//   3. **终态即停**：所有子都终态且没有 pending 的 delegate 卡 ⇒ 拆掉 interval。
//   4. **卸载即停**：作用域销毁（`onScopeDispose`）清 timer + abort 在途；abort 之后的 reject
//      **不当故障**（不置 error、不计入连续失败）。
import { computed, getCurrentScope, onScopeDispose, ref, watch } from 'vue';
import { api } from '../api';
import {
  DELEGATE_LIVE_STATES,
  DELEGATE_POLL_MS,
  isDelegateLive,
  isDelegateTerminal,
  parseDelegateResult,
} from '../lib/delegate';

/** 连续失败多少次才降级成「暂不可读」那一行灰字（1~N-1 次失败连灰字都不出，纯静默）。 */
export const DELEGATE_ACTIVITY_FAIL_THRESHOLD = 3;

/** 已跑时长的时钟节拍（1s：与 `RunStatusBar` 的动量时钟同粒度，秒级显示不必更快）。 */
export const DELEGATE_ACTIVITY_TICK_MS = 1000;

/**
 * 名册端点（**两个 id 都要编码**，路径段不许裸拼）。
 * 与抽屉那条 `delegateTranscriptUrl`（`lib/delegate.ts`）是**两个不同端点**：这条列名册，那条读账本。
 *
 * `&activity=1`（#593 / 设计 §4.1 阶段 1）：让端点顺手给每条 item 一个「最近动作」摘要。
 * 它是**可选参数**：不带就与阶段 0 逐字段相同；带了也只是 additive 一个 `activity` 键
 * （终态子只有 `{kind:'none', turns:null, stale}`，`at/tool/args/text` 都可能缺键
 * ⇒ 消费端逐字段兜底，见 `normalizeActivity`）。它不读 DB、只 `stat` + 读活态子的账本，
 * 缓存键 `(childRunId, size, mtimeMs)` 在服务端 ⇒ 我们这边不需要再加一层。
 */
export function delegateRosterUrl(sessionId: string, parentRunId: string): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/delegates?runId=${encodeURIComponent(parentRunId)}&activity=1`;
}

/** 触发判据要读的卡片字段（`ToolCardState` 的结构子集 ⇒ 真实卡片直接可用，不必适配）。 */
export interface DelegateActivityCardLike {
  name: string;
  ok: boolean | null;
  runId?: string;
  out?: string;
  resultPreview?: string;
}

export interface UseDelegateActivityOptions {
  /** 当前会话 id（`store.sessionId`）。空 ⇒ 不发请求（没有会话就没有名册）。 */
  sessionId: () => string | null | undefined;
  /** 当前活跃 run（`store.es.activeRunId`）= 名册的 `parentRunId`。变 null ⇒ 立刻停（run 结束了）。 */
  activeRunId: () => string | null | undefined;
  /** 工具卡片集合（`store.es.toolCards` 的 values）。用 getter 注入 ⇒ 组件侧保持响应式追踪。 */
  cards: () => Iterable<DelegateActivityCardLike>;
  /** 轮询间隔，缺省 `DELEGATE_POLL_MS`（2000）——**复用**抽屉那个常量，不另开一个数。 */
  pollMs?: number;
  /** 连续失败阈值（测试用）。 */
  failThreshold?: number;
  /** 时长时钟（测试可注入固定 `now`；缺省 `Date.now`）。 */
  now?: () => number;
}

/**
 * 「最近动作」摘要（`?activity=1` 的 `items[i].activity`，#593）的四值封闭集。
 * 拿不到/不在集内 ⇒ `'none'`（**不猜**成 tool）。
 */
export const DELEGATE_ACTIVITY_KINDS = ['tool', 'text', 'tool_result', 'none'] as const;
export type DelegateActivityKind = (typeof DELEGATE_ACTIVITY_KINDS)[number];

/**
 * 一行的「在干啥」（服务端从**投影后**的账本倒着扫出来的，折叠口径唯一来源是
 * `foldLedgerRecords` → `projectTranscriptForDisplay`，前端只读不算）。
 * 缺位一律是「没有」：`kind:'none'` + `stale:false`，其余键**缺席**（不写空串、不写 0）。
 */
export interface DelegateActivitySummary {
  kind: DelegateActivityKind;
  tool?: string;
  args?: string;
  text?: string;
  /** 账本 mtime（写盘证据）；脏值 ⇒ 键缺席。 */
  at?: number;
  /** 投影后的逻辑消息数；终态子不给 ⇒ 键缺席。 */
  turns?: number;
  /**
   * 父 run 已终态而名册还写着活态（§4.4 ③：后台子随父进程消失，`finishRun` 永远不会跑）。
   * 只认 `=== true`；它**不是**「失败」也不是「在跑」，而是「状态未知」（D9 的 ⚪ 口径）。
   */
  stale: boolean;
}

/** 面板一行（名册 DTO 的 UI 白名单视图；字段缺席一律兜底成「没有」，不 throw）。 */
export interface DelegateActivityItem {
  childRunId: string;
  /** 名册 state 原值（脏值 ⇒ `''` ⇒ 分级走 `unknown` 中性灰，**不猜**成 running）。 */
  state: string;
  /** 引擎 termination 的字符串（对象形态 ⇒ `''`，同 `lib/delegate.ts` 的 #212 口径）。 */
  termination: string;
  /** 起跑时刻（毫秒）。缺席 ⇒ null ⇒ **不画时长**（§2：名册没有 `deadlineAt`，也画不了进度条）。 */
  createdAt: number | null;
  endedAt: number | null;
  updatedAt: number | null;
  cwd: string | null;
  model: string | null;
  hasTranscript: boolean;
  /** 「最近动作」（`?activity=1`）；没带参数/字段脏 ⇒ `{ kind: 'none', stale: false }`。 */
  activity: DelegateActivitySummary;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * `activity` 摘要的逐字段兜底（**网络来的东西一个都不信**，同 `lib/delegate.ts` 对 termination 的口径）：
 *   * `kind` 只认那四个字符串，其余 ⇒ `'none'`（不拿「不认识」升成「在跑工具」）；
 *   * `tool` / `args` / `text` 只认字符串，其余 ⇒ **键缺席**（不写空串，UI 才能「整格不渲染」而不是出一个空框）；
 *   * `at` / `turns` 只认有限数（终态子 `turns: null` ⇒ 键缺席，**不许拿 0 冒充**）；
 *   * `stale` 只认 `=== true`（`'true'` / `1` 都当没这个旗标）。
 * 整个 `activity` 缺席（旧后端 / 没带 `activity=1`）⇒ `{ kind: 'none', stale: false }` ⇒ 那一格不渲染。
 */
function normalizeActivity(raw: unknown): DelegateActivitySummary {
  const record = asRecord(raw);
  const kindRaw = record?.kind;
  const kind = (DELEGATE_ACTIVITY_KINDS as readonly unknown[]).includes(kindRaw)
    ? kindRaw as DelegateActivityKind
    : 'none';
  const summary: DelegateActivitySummary = { kind, stale: record?.stale === true };
  for (const key of ['tool', 'args', 'text'] as const) {
    const value = record?.[key];
    // 空串与脏值都不写键：UI 拿「键在不在」区分「有这句话」与「没这句话」。
    if (typeof value === 'string' && value !== '') summary[key] = value;
  }
  for (const key of ['at', 'turns'] as const) {
    const value = asMs(record?.[key]);
    if (value !== null) summary[key] = value;
  }
  return summary;
}

/**
 * 名册响应 `{ items: [...] }` → 面板行（**逐字段兜底，绝不抛**）。
 *
 * 丢整行的唯一条件：`childRunId` 不是非空字符串——那一行既打不开抽屉（端点路径段就是它）也没法显示
 * 短码，留着只会点出一个 404。其余脏值（state 缺失 / createdAt 是字符串 / items 不是数组）**都保留**
 * 并降级成「没有」，因为「有这么个儿子、但状态不认识」本身就是信息（中性灰，不是绿）。
 */
export function normalizeDelegateItems(raw: unknown): DelegateActivityItem[] {
  const root = asRecord(raw);
  const list = Array.isArray(root?.items) ? (root?.items as unknown[]) : [];
  const rows: DelegateActivityItem[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const childRunId = asString(record.childRunId);
    if (childRunId === '') continue;
    rows.push({
      childRunId,
      state: asString(record.state),
      // 上游把对象形态的 termination 归一成 null（P2 读侧裁决），这里只可能收到字符串。
      termination: asString(record.termination),
      createdAt: asMs(record.createdAt),
      endedAt: asMs(record.endedAt),
      updatedAt: asMs(record.updatedAt),
      cwd: typeof record.cwd === 'string' && record.cwd !== '' ? record.cwd : null,
      model: typeof record.model === 'string' && record.model !== '' ? record.model : null,
      hasTranscript: record.hasTranscript === true,
      // 「最近动作」：`?activity=1` 才有；没带参数、旧后端、或脏值 ⇒ kind:'none' ⇒ 那一格不渲染。
      activity: normalizeActivity(record.activity),
    });
  }
  return rows;
}

/** 触发判据（设计 §4.2 的三行伪码，逐字对应）。 */
function cardTriggers(card: DelegateActivityCardLike, activeRunId: string): { hit: boolean; pending: boolean } {
  if (card.name !== 'delegate') return { hit: false, pending: false };
  // `runId` 缺失/不属本 run ⇒ 不算触发（认不出父 run 就不该为它轮询）。
  if (card.runId !== activeRunId || card.runId === undefined || card.runId === '') {
    return { hit: false, pending: false };
  }
  if (card.ok === null) return { hit: true, pending: true }; // 结果还没回来（前台子的常态）
  // 结果已回 ⇒ 只有「子还活着」（后台子 `background:true` 会立刻回 running）才继续轮询。
  const parsed = parseDelegateResult(card.resultPreview) ?? parseDelegateResult(card.out);
  const state = parsed?.state ?? '';
  return { hit: DELEGATE_LIVE_STATES.has(state), pending: false };
}

/** 在途请求被主动打断（卸载 / 换 run）⇒ **不是故障**（纪律 4 的后半句）。 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function useDelegateActivity(options: UseDelegateActivityOptions) {
  const pollMs = options.pollMs ?? DELEGATE_POLL_MS;
  const failThreshold = options.failThreshold ?? DELEGATE_ACTIVITY_FAIL_THRESHOLD;
  const nowFn = options.now ?? (() => Date.now());

  const items = ref<DelegateActivityItem[]>([]);
  /** 中性降级标记（连续失败到阈值才 true）：UI 只出一行灰字，**不**渲染告警底色。 */
  const error = ref(false);
  /** 至少成功拉到过一次（UI 用它区分「还没拉到」与「真的没有子任务」）。 */
  const loaded = ref(false);
  /** 1s 时钟（已跑时长的基准；只在轮询期间走表，面板收起/终态后不白跑）。 */
  const nowMs = ref(nowFn());

  let inFlight = false;
  let controller: AbortController | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let failures = 0;

  /** 有会话且有活跃 run 时的 parentRunId；否则 `''`（空串 = 不轮询，且能当 watch 的「换 run」信号）。 */
  const parentRunId = computed(() => {
    const sid = options.sessionId();
    const rid = options.activeRunId();
    if (typeof sid !== 'string' || sid === '') return '';
    if (typeof rid !== 'string' || rid === '') return '';
    return rid;
  });

  /** 本轮是否存在「值得为它轮询」的 delegate 卡（判据 1/2/7 的正身）。 */
  const hasTriggerCard = computed(() => {
    const runId = parentRunId.value;
    if (runId === '') return false;
    for (const card of options.cards()) {
      if (cardTriggers(card, runId).hit) return true;
    }
    return false;
  });

  /** 还挂着「没有结果」的 delegate 卡（终态即停的第二半条件：这种卡随时可能派出新子）。 */
  const hasPendingCard = computed(() => {
    const runId = parentRunId.value;
    if (runId === '') return false;
    for (const card of options.cards()) {
      if (card.name === 'delegate' && card.runId === runId && card.ok === null) return true;
    }
    return false;
  });

  /** 名册里**全部**子都终态（一条都没拉到 ⇒ 不算「全部终态」，可能只是文件还没落）。 */
  const allChildrenTerminal = computed(
    () => items.value.length > 0 && items.value.every((item) => isDelegateTerminal(item.state)),
  );

  /** 纪律 3：终态即停（还留着 pending 卡就不停——那个卡可能还要再生子）。 */
  const shouldPoll = computed(
    () => parentRunId.value !== ''
      && hasTriggerCard.value
      && !(allChildrenTerminal.value && !hasPendingCard.value),
  );

  /**
   * 徽标数字。**两个条件缺一不可**：
   *   * 活态集合 = `lib/delegate.ts#DELEGATE_LIVE_STATES`（判据 5 的唯一尺规，本文件不另造）；
   *   * **减去 `activity.stale`**（#593 / 设计 §4.4 ③）：父 run 已终态而名册还写着 `running` 的行，
   *     它**不是**「在跑」而是「状态未知」——把它计进「几个在跑」就是谎报，与 D9 的「⚪ 不得渲染成绿」
   *     同一条口径（门户不判子 run 死活：名册里的 `pid` 是容器内 PID，与门户不在同一个 namespace）。
   */
  const liveCount = computed(
    () => items.value.filter((item) => isDelegateLive(item.state) && item.activity.stale !== true).length,
  );
  const hasLive = computed(() => liveCount.value > 0);
  /**
   * **降级态**：连续失败到阈值且**一条都没拉到过** ⇒ 「读不到」不等于「没有」。
   *
   * 为什么不直接把 `error` 拿去驱动徒标可见性：面板要在拉到过东西之后用 `error` 保留上次数据继续
   * 画行（那一发挂了不改事实），而徒标的可见性必须区分两种 0：**读到过且真的没儿子**（整段不出）
   * 与**从没读到过**（必须说话）。少了这个量就是验收抓到的真缺陷：首次请求就连着 500
   * ⇒ `liveCount === 0` ⇒ 徒标不渲染 ⇒ 面板开不了 ⇒ 设计 §4.2 要的那句「子任务状态暂不可读」
   * **永远不可达**，用户看到的是「没有子任务」——把「我不知道」说成「没有」，与 D9 的
   * 「⚪ 不得渲染成绿」同一条口径（没证据就没资格下那个结论）。
   */
  const degraded = computed(() => error.value && !loaded.value);
  // ⚠ **取舍（裁定口径）**：`!loaded` 是故意的——**读到过终态、零活态 ⇒ 静默**，不再拿灰字打扰。
  // 那时候界面上本来就没有要报的东西（终态子 run 归工具卡），而「读得到、且真的没儿子」已是
  // 一个完整答案；只有**一次都没读到过**才存着「我不知道」这笔账。所以「已读到过东西后连续失败」
  // 不降级是设计而非缺陷（面板靠 `error` 在**已有行**上补一行灰字，入口仍然存在）。
  /** 面板要不要挂：拉到过东西，或已经降级到「暂不可读」那句。 */
  const hasRows = computed(() => items.value.length > 0 || error.value);

  function clearTimers(): void {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  }

  function abortInFlight(): void {
    if (controller !== null) {
      controller.abort();
      controller = null;
    }
  }

  async function poll(): Promise<void> {
    if (inFlight) return; // 纪律 1：单飞（上一发没落定就一个都不多发）
    const sessionId = options.sessionId();
    const runId = parentRunId.value;
    if (typeof sessionId !== 'string' || sessionId === '' || runId === '') return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return; // 纪律 2
    inFlight = true;
    const own = new AbortController();
    controller = own;
    try {
      const dto = await api<unknown>(delegateRosterUrl(sessionId, runId), { signal: own.signal });
      // abort 之后 fetch 可能仍然**正常 resolve**（桩/某些实现不一定抛），所以还要看信号；
      // 换 run / 换会话之后迟到的响应也不许盖到新 run 头上（同 store 里 loadSessions 的 reqSeq 口径）。
      if (own.signal.aborted) return;
      if (sessionId !== options.sessionId() || runId !== parentRunId.value) return;
      items.value = normalizeDelegateItems(dto);
      loaded.value = true;
      failures = 0;
      error.value = false;
    } catch (e) {
      if (own.signal.aborted || isAbortError(e)) return; // 主动打断不是故障（纪律 4）
      // 失败**静默**：保留上次数据（面板不闪、不红条），只有连续到阈值才置中性标记。
      failures += 1;
      if (failures >= failThreshold) error.value = true;
    } finally {
      if (controller === own) controller = null;
      inFlight = false;
    }
  }

  /** 立即补一发（「恢复可见立刻刷」与 watch 的上升沿用；被门控挡住时就是 no-op，interval 会续）。 */
  function refresh(): void {
    void poll();
  }

  function start(): void {
    nowMs.value = nowFn();
    if (pollTimer === null) {
      // 纪律 1 的结构前提：**固定间隔** + `inFlight` 守卫（链式 setTimeout 会让「单飞」无法证伪）。
      pollTimer = setInterval(() => void poll(), pollMs);
    }
    if (clockTimer === null) {
      clockTimer = setInterval(() => {
        nowMs.value = nowFn();
      }, DELEGATE_ACTIVITY_TICK_MS);
    }
    void poll();
  }

  /** 拆掉一切（纪律 3 的落点；也是纪律 4 的共用收尾）。 */
  function stop(): void {
    clearTimers();
    abortInFlight();
  }

  /** 换 run / 换会话：上一个 run 的儿子不是这个 run 的儿子，一项都不许留。 */
  function reset(): void {
    items.value = [];
    loaded.value = false;
    error.value = false;
    failures = 0;
    abortInFlight();
  }

  // 换 run / 换会话（含 `activeRunId` 变 null）⇒ 先清账，再让下面的 watch 决定停不停。
  watch(parentRunId, (next, prev) => {
    if (next !== prev) reset();
  });

  // 轮询开关（纪律 3）：判据假 ⇒ 当场拆 timer + abort，不等下一拍。
  watch(shouldPoll, (on) => (on ? start() : stop()), { immediate: true });

  // 纪律 2 的后半句：重新可见 ⇒ 立刻补一发（隐藏期间 interval 照常走，只是 poll 自己 return）。
  const onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && shouldPoll.value) {
      void poll();
    }
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

  // 纪律 4：作用域销毁（组件卸载 / pinia 复位）⇒ 清 timer + abort 在途。
  // 用 `onScopeDispose` 而不是 `onUnmounted`：本 composable 的宿主是 **pinia store**（见下），
  // store 作用域在组件卸载时不会销毁，而 store 被 `pinia.dispose()` 时会——两种情况这里都能收摊。
  if (getCurrentScope()) onScopeDispose(() => {
    stop();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
  });

  /**
   * 一行的已跑时长（§2 的结论：名册没有 deadline，只能画「已跑多久」）。
   *
   * ⚠ **终态行必须定格**：`endedAt` 是有限数且不早于 `createdAt` ⇒ 用 `endedAt - createdAt`。
   * 只用共享的 1s 时钟减 `createdAt` 的话，一个子 completed、另一个还在跑时，终态那一行的
   * 「已跑 Ns」会跟着时钟一路涨上去（跑得越久越假）。
   *
   * ⚠ **终态但拿不到 `endedAt` ⇒ 整段不出**（裁定：不回落时钟）。引擎 `finishRun` / `reconcile` 都会写
   * `endedAt`，所以这只在脏记录/引擎变更时可达；而「已结束却还在涨」是拿假数据填空白——宁可不说。
   * 活态行（含脏 state 的中性态）仍用客户端时钟；脏 `endedAt`（早于 `createdAt`）当没有。
   */
  function elapsedMs(item: DelegateActivityItem): number | null {
    if (item.createdAt === null) return null;
    const endedAt = item.endedAt !== null && item.endedAt >= item.createdAt ? item.endedAt : null;
    // 终态行没有可用的结束时刻 ⇒ 整段不出（**不回落时钟**）；宁可不说，不说一个在涨的假时长。
    if (endedAt === null && isDelegateTerminal(item.state)) return null;
    const delta = (endedAt ?? nowMs.value) - item.createdAt;
    return Number.isFinite(delta) && delta >= 0 ? delta : null;
  }

  return {
    items,
    error,
    loaded,
    degraded,
    liveCount,
    hasLive,
    hasRows,
    nowMs,
    shouldPoll,
    poll,
    refresh,
    start,
    stop,
    reset,
    elapsedMs,
  };
}

export type DelegateActivityHandle = ReturnType<typeof useDelegateActivity>;
