<script setup lang="ts">
// 消息流（旧 #stream 的渲染语义平移）：addMessage 三分（user/assistant/synthetic）、
// 助手终稿 markdown（v-html，渲染器本身先转义后格式化，XSS 安全）、工具卡片、
// roundsep/syserr 分隔行、流式增量气泡。自动跟随/「↓ 最新」由父级持有（scroll 容器也在父级）。
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useWorkbenchStore, type StreamEntry, type FoldedInfo, type FoldedOriginalState } from '../stores/workbench';
import type { ToolCardState } from '../composables/useEventStream';
// issue #85：卡片折叠（默认收起）+ 单行摘要防溢出，方案对齐 pi web ToolCallBlock。
import { getToolPreview, getToolResultSummary, formatDuration, isSpecialExecutionStatus } from '../lib/toolSummary';
import { isToolCallExpanded, setToolCallExpanded } from '../lib/toolCallExpansion';
// pi-web 风格：流式增量也走 markdown 渲染（渲染器先转义后格式化，半截 ``` 容错收尾）。
import { renderMarkdown } from '../lib/markdown';
// mermaid 图渲染（参考 pi-web MermaidBlock）：v-html 落定后对 ```mermaid 块做 DOM 后处理。
// 只挂**终稿/部分正文**容器；流式增量不挂（pi-web 同口径：流式中不预览，防逐 chunk 重渲）。
import { vMermaid } from '../directives/mermaid';
// issue #282：消息级时刻（A 块）+ 流式气泡上的「已运行 Xs」心跳（B 块在 StreamPanel 的唯一落点；
// 其余动量数字都在输入框上方常驻状态条 RunStatusBar 里，见工单「落点」）。
import { formatMessageTime } from '../lib/messageTime';
import { formatElapsed } from '../lib/runMomentum';
import { useRunMomentum } from '../composables/useRunMomentum';
// #451：会话头部「本会话压缩」累计行——层序/脏值归一化/可读单位都在 lib 里（纯函数），模板只做插值。
import { compactionLayerSegments, formatSavedTokens, type SessionCompaction } from '../lib/compactionSummary';
// issue #delegate：子 run 只读抽屉 + 分级尺规（尺规**不在组件里重造**：`lib/delegate.ts` 是
// 唯一入口，红色集合由它从 `lib/terminationReasons.ts#RUN_TERMINATION_SYSERR_REASONS` 取，
// 于是「`completed` + `persistence_failed` 仍要红」与抽屉/名册三处同源（判序在 lib 里已钉住）。
import DelegateChildDrawer from './DelegateChildDrawer.vue';
import {
  DELEGATE_BADGE_CLASS,
  delegateBadgeKind,
  parseDelegateResult,
  shortRunId,
  type DelegateBadgeKind,
  type DelegateResult,
} from '../lib/delegate';

const { t, locale } = useI18n();
const store = useWorkbenchStore();
// 本组件只读派生视图；1s 时钟由 composable 自己起、自己 `onUnmounted` 清（与 RunStatusBar 各一份，
// 两条 1s interval 的成本可忽略，换来「谁卸载谁清理」的局部性）。
const { view: momentumView } = useRunMomentum(store.momentum);

/**
 * #451：本会话压缩累计（`GET /api/sessions/:id` 的 `session.compaction`，后端读侧聚合）。
 *
 * 三条口径都写在这里，模板不再判断：
 *   ① **只在该会话真有折叠时出现**：`sessionStats.compaction` 为 null（后端键缺席）⇒ 返回 `''`
 *      ⇒ 模板 `v-if` 整段不出，一个字节都不渲染（不是「压缩 0 次」）；
 *   ② **本会话累计**（不是本次 run）：文案里写死「本会话」，tooltip 再说清累计自几轮；
 *   ③ 压缩是**正常工作**：这一行与消息数同色（`text-black/40`），不进 `.syserr` 红色。
 * token 走站内既有 `formatTokenCount`（`314.5k` / `1.2M`），不在模板里算。
 */
const compactionText = computed(() => {
  const compaction: SessionCompaction | null = store.sessionCompaction ?? null;
  if (compaction === null) return '';
  const parts = compactionLayerSegments(compaction).map((seg) => {
    const segment = t('stream.sessionCompactionLayer', {
      layer: t(`stream.sessionCompactionLayers.${seg.id}`),
      count: seg.triggered,
    });
    const saved = formatSavedTokens(seg.saved);
    return saved === '' ? segment : t('stream.sessionCompactionLayerSaved', { segment, saved });
  });
  if (parts.length === 0) return '';
  return t('stream.sessionCompactionSummary', { parts: parts.join(' · ') });
});

/** #451：累计行的 tooltip（轮数与最近一轮）。轮号缺席就只说轮数——不编一个 0。 */
const compactionTitle = computed(() => {
  const compaction: SessionCompaction | null = store.sessionCompaction ?? null;
  if (compaction === null) return '';
  const last = compaction.lastRound;
  return typeof last === 'number' && Number.isFinite(last)
    ? t('stream.sessionCompactionHintTitle', { rounds: compaction.rounds, last })
    : t('stream.sessionCompactionHintTitleNoRound', { rounds: compaction.rounds });
});

/**
 * issue #282 A：消息时刻文本。`created_at` 缺失/脏值 ⇒ `''`（模板 `v-if` 整段不出），
 * 绝不把 `undefined` / `Invalid Date` / `NaN` 渲染上屏（格式化规则见 `lib/messageTime.ts`）。
 */
function msgTime(en: Extract<StreamEntry, { kind: 'msg' }>): string {
  return formatMessageTime(en.createdAt, locale.value);
}

/**
 * issue #282 B：流式气泡上的实时计时。运行中且有起跑时刻 ⇒「已运行 03:42」；运行中但起跑时刻
 * 未知（页面中途打开）⇒ 只出「运行中」（不出假时长）；非运行态 ⇒ `''`（气泡本身也在 run_end 时被移除）。
 */
const deltaElapsedText = computed(() => {
  const view = momentumView.value;
  if (!view.running) return '';
  const dur = formatElapsed(view.elapsedMs);
  return dur === '' ? t('runStatus.running') : t('runStatus.runningElapsed', { dur });
});

// 展开态：组件内 reactive Set 驱动重渲染，模块级 Set（toolCallExpansion）做跨重渲染记忆，
// 二者双向镜像；entries 重建（SSE 补发/历史重放）后从模块 Set 回灌，展开状态不丢。
const expandedIds = reactive(new Set<string>());

watch(
  () => store.entries,
  () => {
    for (const en of store.entries) {
      if (en.kind === 'tool' && isToolCallExpanded(en.callId) && !expandedIds.has(en.callId)) {
        expandedIds.add(en.callId);
      }
    }
  },
  { immediate: true },
);

function isExpanded(callId: string): boolean {
  return expandedIds.has(callId);
}

function toggleCard(callId: string): void {
  const next = !expandedIds.has(callId);
  setToolCallExpanded(callId, next);
  if (next) expandedIds.add(callId);
  else expandedIds.delete(callId);
}

// 单行摘要：优先 args 里的语义键（command/path/...），解析失败回退 dig（§旧 toolCard 原样）。
function summaryText(card: ToolCardState): string {
  return getToolPreview(card.args) || card.dig || (card.args ? '' : t('stream.argsPending'));
}

// 折叠态状态位：✓/✗（出错变红）+ 耗时；尚无结果（null）显示 …。
// issue #283：耗时走 `formatDuration` 三档可读单位（不再裸拼 `${card.dur}ms`）；
// **没有时长就只出 ✓/✗**（旧实现在 `dur=0` 上伪装不了「引擎未给」，那个伪装在上游已拆）。
function statusMark(card: ToolCardState): string {
  const dur = card.dur != null ? formatDuration(card.dur) : '';
  if (card.ok === true) return '✓' + (dur ? ` ${dur}` : '');
  if (card.ok === false) return '✗' + (dur ? ` ${dur}` : '');
  return '…';
}

// issue #188：展开区取数——事件流卡片有完整 args/out；投影卡片（加载/刷新路径）只有上游摘要/预览
// （argsSummary 120 字 / resultPreview 400 字，全文在 DTO blocks，不在此重建）。
function cardArgs(card: ToolCardState): string {
  return card.args || card.argsSummary || '';
}

function cardOut(card: ToolCardState): string {
  if (card.out) return card.out;
  // issue #228：投影路径的 resultPreview 在进卡片前已归一成字符串，这里再走一次是**幂等**防御：
  // 旧 DTO / 其它宿主给到 number、null、`{content, metadata}` 时，既不渲染成 "[object Object]"，
  // 也不会因 `!!0` 把「写了 0 字节」当成「没结果」而丢掉。metadata 不单独上 UI（信息在 content marker 里）。
  // issue #299（guide-0.20.0 §7）：`executionStatus` 只在两种特殊状态下存在，普通块上缺席；这里**拿值比**
  // （`isSpecialExecutionStatus`）而不是看「在不在」：上游若哪天多写一个普通值，不会被我们当成状态渲进展开区。
  return [isSpecialExecutionStatus(card.executionStatus) ? card.executionStatus : '',
    getToolResultSummary(card.resultPreview)].filter((part) => !!part).join(' · ');
}

// ---------------------------------------------------------------------------
// issue #delegate：`delegate` 工具卡的专属展示（工单 §2/§3）。
//
// 数据源：卡片上的结果串（实时路 `out` = 带 ✓/耗时包裹的文案、刷新路 `resultPreview` = 上游 400 字
// 预览）里嵌的 JSON `{ ok, runId, state, action, termination? }`。**解析全在 `lib/delegate.ts`**
// （`parseDelegateResult`：整体 parse 失败后逐字段正则兜底），解不出 ⇒ 整段退回既有展示与 ✓/✗。
// 不在组件里重造解析：刷新路径的预览被截到 400 字，`JSON.parse` 必抛，只有 lib 里的兜底能拿到 runId
//（实时看起来正常、**刷新后按钮消失**就是这里漏了兜底的那次真机回归）。
// ---------------------------------------------------------------------------

/** 头行渲染所需的全部派生量（一次算完，模板里只插值不写业务）。 */
interface DelegateView {
  summary: string;
  kind: DelegateBadgeKind;
  spinner: boolean;
  mark: string;
  color: string;
  openable: boolean;
}

const delegateCache = new WeakMap<ToolCardState, DelegateResult | null>();

/** delegate 卡的结果载荷；非 delegate 卡 / 解不出 ⇒ null（整段退回既有摘要与 ✓/✗）。 */
function delegatePayload(card: ToolCardState): DelegateResult | null {
  if (card.name !== 'delegate') return null;
  const cached = delegateCache.get(card);
  if (cached !== undefined) return cached;
  // 刷新路（完整或截断的预览）优先，实时路（`✓ {json} (1.2s)` 包裹）兜底。
  const view = parseDelegateResult(card.resultPreview) ?? parseDelegateResult(card.out);
  delegateCache.set(card, view);
  return view;
}

function delegateView(callId: string): DelegateView | null {
  const card = store.es.toolCards.get(callId);
  if (!card) return null;
  const p = delegatePayload(card);
  if (!p) return null;
  // 分级单一入口（state + termination）；syserr 检查在 `completed` 之前，所以「completed + 落盘失败」仍红。
  const kind = delegateBadgeKind(p.state, p.termination || undefined);
  const summary = [p.action, shortRunId(p.runId)].filter((part) => part !== '').join(' · ');
  // state 拿不到（脏值 / 只有 `{ok:false,reason}` 这种拒单）⇒ 不猜成红色，沿用既有 ✓/✗/…。
  const known = kind !== 'unknown';
  return {
    summary: summary !== '' ? summary : summaryText(card),
    kind,
    spinner: kind === 'running',
    mark: known
      ? kind === 'completed' ? '✓' : kind === 'aborted' ? '■' : kind === 'failed' ? '✗' : ''
      : statusMark(card),
    color: known ? DELEGATE_BADGE_CLASS[kind] : (card.ok === false ? 'text-red-600' : 'text-black/50'),
    // 抽屉要两个 id 才拉得到数据：子 runId 来自结果，父 runId 来自卡片（两条建卡路径都填了）。
    openable: p.ok === true && p.runId !== '',
  };
}

// 打开的子 run（整个组件一处，抽屉挂在模板底部单一位置）。
const delegateOpen = ref<{ parentRunId: string; childRunId: string; label: string; termination?: string } | null>(null);

function openDelegateDrawer(callId: string): void {
  const card = store.es.toolCards.get(callId);
  const p = card ? delegatePayload(card) : null;
  if (!card || !p || p.runId === '') return;
  delegateOpen.value = {
    parentRunId: card.runId ?? '',
    childRunId: p.runId,
    label: card.name,
    termination: p.termination === '' ? undefined : p.termination,
  };
}

// issue #188：推理块展开态（组件内，默认收起）——与工具卡片同一按钮+chevron 交互风格，不新造一套。
// 仅加载/刷新路径产出推理块（实时推理增量不展示），entries 不会被流式事件重建，故局部状态足够。
const expandedReasoning = reactive(new Set<string>());

function isReasoningExpanded(id: string): boolean {
  return expandedReasoning.has(id);
}

function toggleReasoning(id: string): void {
  if (expandedReasoning.has(id)) expandedReasoning.delete(id);
  else expandedReasoning.add(id);
}

// 收起时的单行摘要：取推理文本首行截 120 字（与卡片摘要同口径，防溢出）。
function reasoningSummary(text: string): string {
  return text.split('\n')[0].slice(0, 120);
}

// issue #189：折叠横幅展开态（组件内，默认收起），与推理块同一交互风格。
type FoldedEntry = Extract<StreamEntry, { kind: 'folded' }>;

const expandedFolded = reactive(new Set<string>());

function isFoldedExpanded(id: string): boolean {
  return expandedFolded.has(id);
}

function toggleFolded(id: string): void {
  if (expandedFolded.has(id)) expandedFolded.delete(id);
  else expandedFolded.add(id);
}

// issue #388：「收起原文」——**纯展示态**（按 entry id 记，与 expandedFolded 同一风格），绝不碰
// workbench 的 foldedOriginals 缓存：收起后再展开必须仍命中缓存（fetch 总次数恒为 1），
// 「收起 = 删缓存」是假修法（下次展开要重拉 836 KB，等于没修）。
const collapsedOriginals = reactive(new Set<string>());

function isOriginalCollapsed(id: string): boolean {
  return collapsedOriginals.has(id);
}

function collapseOriginal(id: string): void {
  collapsedOriginals.add(id);
}

/**
 * issue #390（#390-A 前端半）：`folded.hasSummary === false` = 上游摘要其实是字面量 "missing"，
 * 展开出来的只是跟标题换句话重复的兜底句 ⇒ 不画 ▾ 控件、不画摘要区（「查看原文」照旧——
 * 原文与摘要是两回事）。**键缺失**（旧 DTO / 其他路径）≠「没有摘要」⇒ 保持现状画 ▾。
 *
 * issue #440：但 `hasSummary === false` **不再等于**「没东西可看」——`fold-llm` 把 `record.summary`
 * 写成字面量 `"missing"`（所以 `hasSummary` 恒 false），而真正的语义摘要躺在账本的
 * `foldedFacts.text` 里（DTO 的 `summaryText`）。此时如果还按 #390-A 那条关掉 ▾，用户为语义折叠
 * 付的那份 token 在界面上仍然**一个字节也看不到**（#440 的原文病症）⇒ 有 `summaryText` 就一定有
 * 东西可展开。`hasSummary` 本身的语义一字未动（它仍只回答「`record.summary` 有没有料」）。
 */
function foldedHasReadableSummary(en: FoldedEntry): boolean {
  if (en.folded.summaryText !== undefined) return true;
  return en.folded.hasSummary !== false;
}

/**
 * issue #440：摘要区画哪一份正文。
 *
 * `folded.text` 是**上游投影生成的折叠 turn 文本**（机械替代物/兜底句），`summaryText` 是账本
 * `foldedFacts.text`。**只在 `summarySource === 'llm'` 时才改用 `summaryText`**，理由两条（实测）：
 *
 *   ① 这才是 #440 要修的那一格：`fold-llm` 下 `folded.text` 只是「早期第 a–b 轮已折叠。」这类
 *      投影兜底句，而 2048 B 语义摘要只在 `foldedFacts.text` 里 ⇒ 不换就永远看不到；
 *   ② **机械那一份不能换**：`fold-statistical` 的 `foldedFacts.text` 开头带着引擎的内部 marker
 *      （`【上下文折叠·v1·erix-9f6e2c】`，`fold-statistical.js:26` 的 `FOLD_SUMMARY_MARKER`），
 *      而 `folded.text` 是**洗过的**（实测：`早期第 1–21 轮已折叠。`）。渲染前者就是把引擎的内部
 *      版本号撒到用户界面上——那正是上游 #565 造 `foldedFacts.title`（剥 marker）要消灭的东西。
 *      ⇒ 机械路径保持现状（`folded.text`），不自己写正则剥 marker（剥 = 把「解析引擎内部字面量」
 *      这件事又塞回宿主）。
 */
function foldedSummaryBody(en: FoldedEntry): string {
  if (en.folded.summarySource === 'llm' && en.folded.summaryText !== undefined) return en.folded.summaryText;
  return en.folded.text;
}

/**
 * 原文块可见性（issue #388 收起联动）：
 * - 有摘要（默认）⇒ 归横幅展开态管辖：点标题「收起」时摘要与原文**一起**收起（836 KB 的
 *   原文不许孤儿地挂在页面上），且本地「收起原文」生效时不出；
 * - hasSummary=false ⇒ 没有 ▾ 可操作 ⇒ 加载出来就直接显示（否则点「查看原文」永远看不见结果）。
 */
function foldedOriginalVisible(en: FoldedEntry): boolean {
  if (foldedOriginalState(en) == null) return false;
  if (!foldedHasReadableSummary(en)) return true;
  return isFoldedExpanded(en.id) && !isOriginalCollapsed(en.id);
}

// 横幅标题分级降级：范围 → 条数 → 裸文案（字段缺失时逐级退回，不拼半截文案）。
// #375：有范围就**只报范围**。原先一并报出去的 `foldedPayloadMessages` 在 erix-agent 0.25.0 之后
// 是「本条记录携带的归档条数」（会话级去重 + 256 KiB 夹断之后），拿它当「压掉了多少条」会说假话；
// 没有 range 的存量行才退回条数口径（那类行当时归档就是全量，条数是真话）。
function foldedTitle(folded: FoldedInfo): string {
  const count = folded.foldedPayloadMessages;
  const range = folded.foldedRoundRange;
  const from = range?.from;
  const to = range?.to;
  if (typeof from === 'number' && typeof to === 'number') return t('stream.folded.range', { from, to });
  if (typeof count === 'number') return t('stream.folded.countOnly', { count });
  return t('stream.folded.bare');
}

// 「查看原文」端点 `GET /api/sessions/:id/folded/:round` 的 :round 是**折叠行自己的 round**
//（transcript 行的 round，DTO 由 folded.round 逐字透传）。不能用 foldedRoundRange（那是
// 「被折叠的轮范围」如 1–5，拿 range.to ?? from 去查会查错行、必然 404，#189 收尾根因）。
// 无 round（整数以外）→ null → 隐藏按钮（保持现状）。
/**
 * D 片（issue #392）：横幅上的「可见性说明」。
 *
 * 为什么需要单独一行：标题（#375）只说「已压缩第 a–b 轮」，但「压缩」这个词在用户那里并不自动
 * 等于「模型从此看不见它」。折叠的全部意义就在那后半句，而它此前只存在于实现者脑子里。
 *
 * 两态的必要性：`hasSummary === false` 时下面那份“摘要”其实是重复标题的兜底句（#390-A 已经不画展开
 * 控件），此时再说「摘要就是它留下的全部」就是空头支票 ⇒ 改成指路「查看原文」。
 *
 * #440 把它从两态扩成**三态**（前两态的数据来自账本 `foldedFacts`，不是 `hasSummary`）：
 *   ① `summarySource === 'llm'` ⇒ 这次折叠留的是 **LLM 语义摘要**（`fold-llm`）。**绝对不许**在这
 *      一格再说「本次没有生成摘要」——那是 #440 的原文病症（fold-llm 把 `record.summary` 写成
 *      字面量 `"missing"`，旧实现据此说「没摘要」，而账本里躺着 2048 B 的语义摘要）；
 *   ② `summarySource === 'statistical'` ⇒ 只有**机械替代物**（`fold-statistical`），如实说「没有
 *      LLM 语义摘要」，别把机械替代物包装成语义摘要；
 *   ③ `summarySource` 缺席（旧账本 / 不认识的形态）⇒ 退回 #390-A 那两态，逐字不变。
 *
 * `hasSummary` **键缺席**（旧 DTO / 其他路径）⇒ 返回 null，整行不渲染。不能当 false 处理：那会让
 * 存量数据凭空多出一句「本次没有生成摘要」的断言（同 #390-A 那条「键缺席=不知道」纪律）。
 * 轮数只在有 `foldedRoundRange` 时报——拿 `foldedPayloadMessages` 报轮数是 #375 定过性的假话。
 */
function foldedVisibilityNotice(en: FoldedEntry): string | null {
  const range = (en.folded as { foldedRoundRange?: { from?: unknown; to?: unknown } }).foldedRoundRange;
  const from = range?.from;
  const to = range?.to;
  const n = typeof from === 'number' && typeof to === 'number' && to >= from ? to - from + 1 : null;
  // #440：**三态**里的前两态——账本 `foldedFacts` 说了这次折叠留下了什么。
  // `summarySource` 只由后端白名单给出（`'llm' | 'statistical'`），不认识的形态整个键缺席。
  const source = en.folded.summarySource;
  if (source === 'llm' || source === 'statistical') {
    const key = source === 'llm'
      ? (n === null ? 'stream.folded.visibilityLlmBare' : 'stream.folded.visibilityLlm')
      : (n === null ? 'stream.folded.visibilityMechanicalBare' : 'stream.folded.visibilityMechanical');
    const line = n === null ? t(key) : t(key, { n });
    // 「摘要被夹断」标记（账本 `truncated:true` = 语义摘要被 2048 B 上界削过尾）——
    // 不新开面板，就挂在同一行末尾（工单：零新增 UI 结构）。
    return en.folded.truncated === true ? `${line}${t('stream.folded.summaryTruncated')}` : line;
  }
  // 第三态（#390-A 原样）：账本没有可读替代物（旧账本 / 机械路径缺席）⇒ 与 #440 之前逐字一致。
  const has = (en.folded as { hasSummary?: unknown }).hasSummary;
  if (has !== true && has !== false) return null;
  if (n === null) return has ? t('stream.folded.visibilityBare') : t('stream.folded.visibilityNoSummaryBare');
  return has ? t('stream.folded.visibility', { n }) : t('stream.folded.visibilityNoSummary', { n });
}

function foldedQueryRound(folded: FoldedInfo): number | null {
  return Number.isInteger(folded.round) ? (folded.round as number) : null;
}

function loadOriginal(en: FoldedEntry): void {
  const round = foldedQueryRound(en.folded);
  if (en.sessionId == null || round == null) return;
  // issue #388：点「查看原文」=「我要看原文」⇒ 顺手展开横幅（否则原文归展开态管辖，
  // 收起状态下点了等于没反应）、并解除本地「收起原文」；命中缓存与否由 loadFoldedOriginal 自己判。
  collapsedOriginals.delete(en.id);
  expandedFolded.add(en.id);
  void store.loadFoldedOriginal(en.sessionId, round);
}

function retryOriginal(en: FoldedEntry): void {
  const round = foldedQueryRound(en.folded);
  if (en.sessionId == null || round == null) return;
  void store.loadFoldedOriginal(en.sessionId, round, { force: true });
}

function foldedOriginalState(en: FoldedEntry): FoldedOriginalState | undefined {
  const round = foldedQueryRound(en.folded);
  if (en.sessionId == null || round == null) return undefined;
  return store.getFoldedOriginal(en.sessionId, round);
}

// issue #300：部分正文走**助手正文的既有渲染路径**（renderMarkdown 先转义后格式化，XSS 安全），
// 与助手终稿/流式增量一致。text 在 store 里已保证是字符串（脏载荷退化成 '' 后根本不推 entry），
// 这里再兜一层是为了组件对 entry 形状独立可推：不依赖调用方洁净，也不渲染 undefined。
function partialHtml(text: string): string {
  return renderMarkdown(typeof text === 'string' ? text : '');
}

function entryKey(en: StreamEntry, i: number): string {
  switch (en.kind) {
    case 'msg': return 'm' + en.id;
    case 'folded': return 'f' + en.id;
    case 'partial': return 'p' + en.id;
    case 'tool': return 't' + en.callId;
    case 'reasoning': return 'r' + en.id;
    case 'delta': return 'd' + i;
    default: return 's' + i;
  }
}

function msgClass(en: Extract<StreamEntry, { kind: 'msg' }>): string {
  // 旧 div.className = `msg ${m.role}${m.synthetic ? ' synthetic' : ''}`（+ .md 仅助手终稿）
  let cls = 'msg ' + en.role;
  if (en.synthetic) cls += ' synthetic';
  if (en.html) cls += ' md';
  return cls;
}
</script>

<template>
  <!-- 试用台账 #10：「加载更早消息」入口。后端 keyset 分页一直在 work（默认只给最新一窗），
       此前前端从不消费 next_cursor ⇒ 长会话滚到顶就从压缩横幅开始，最早的对话「看起来消失」
       （其实都在库里，不是压缩删的）。游标 null（已到底/旧后端）则不渲染；失败不推进游标，可重试。 -->
  <p v-if="store.olderMessagesCursor != null" class="load-older mb-2 text-center">
    <button
      type="button"
      class="rounded-md border border-black/20 px-2.5 py-1 text-xs text-black/60 hover:bg-black/5 disabled:opacity-50"
      :disabled="store.olderLoading"
      data-test="load-older"
      @click="store.loadOlderMessages()"
    >{{ store.olderLoading ? t('stream.loadOlderLoading') : t('stream.loadOlder') }}</button>
  </p>
  <!-- issue #189（追加）：当前会话头部状态行「N 条消息 · 已压缩 M 次」（M=0 降级只显示条数；无选中会话不渲染）
       + 仅 M≥1 时一句克制提示（无弹窗/动画） -->
  <p v-if="store.sessionStats && (store.sessionStats.messages > 0 || compactionText !== '')" class="session-stats mb-2 text-xs text-black/40">
    {{ t('stream.sessionStats', { count: store.sessionStats.messages }) }}<template v-if="store.sessionStats.folded > 0"> · {{ t('stream.sessionStatsCompacted', { count: store.sessionStats.folded }) }}</template>
    <span v-if="store.sessionStats.folded >= 1" class="session-compaction-hint block">{{ t('stream.sessionCompactionHint') }}</span>
    <!-- #451：本会话压缩累计（引擎 compactionStats 的读侧聚合）。**不是**错误/警告：与上面同一灰色，
         不进 .syserr；后端没有这个键时整段不渲染（v-if 已在 computed 里收口）。 -->
    <span v-if="compactionText !== ''" class="session-compaction-stats block" :title="compactionTitle">{{ compactionText }}</span>
  </p>
  <!-- 空态：旧版「选择或新建会话」默认文案（issue #332：曾按 `noDir && isPlatformAdmin` 分叉去
       引导「进管理台」，入口拦截后该形状不可达 ⇒ 分支已删，只剩这一条） -->
  <div v-if="store.entries.length === 0">
    <p class="muted">{{ t('stream.chooseOrNewSession') }}</p>
  </div>

  <template v-for="(en, i) in store.entries" :key="entryKey(en, i)">
    <!-- 消息气泡：终稿 markdown 走 v-html；其余纯文本（{{ }} 插值等价 textContent） -->
    <div v-if="en.kind === 'msg'" :class="msgClass(en)">
      <!-- issue #282 A：每条消息（用户与助手都算）显示时刻；DTO 没给 created_at 就整段不出 -->
      <time
        v-if="msgTime(en)"
        class="msg-time block text-right text-[11px] leading-none text-black/35"
        :datetime="en.createdAt"
        :title="t('runStatus.messageTimeTitle')"
      >{{ msgTime(en) }}</time>
      <div v-if="en.html" v-mermaid v-html="en.html"></div>
      <template v-else>{{ en.text }}</template>
    </div>
    <!-- 流式增量：markdown 容错渲染（v-html，渲染器先转义后格式化 XSS 安全），
         类名与助手终稿一致（.msg assistant .md），pi-web 风格下增量与终稿视觉无跳变 -->
    <!-- issue #282 B：进行中的 run 在流式气泡上带「已运行 Xs」+ 心跳脉冲（复用既有 animate-pulse）；
         终态后气泡由 run_end 移除、终稿回写为普通消息（时刻定格在消息 `<time>` 上）。 -->
    <div v-else-if="en.kind === 'delta'" class="msg assistant md">
      <div
        class="delta-meta mb-0.5 flex items-center gap-1.5 text-[11px] leading-none text-black/40"
        :title="t('runStatus.runningHint')"
      >
        <span class="heartbeat inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true"></span>
        <span v-if="deltaElapsedText">{{ deltaElapsedText }}</span>
      </div>
      <div v-html="renderMarkdown(en.text)"></div>
    </div>
    <!-- issue #300：中止/失败 run 的**部分正文**（历史端点合成的 partial_output entry）。
         **中性助手气泡**：复用 .msg assistant .md（与助手终稿同一渲染路径），只加一个 `partial`
         修饰类做视觉区分——**不新增颜色语义**，更不进红色 .syserr（半截正文不是错误）。 -->
    <div v-else-if="en.kind === 'partial'" class="msg assistant md partial">
      <div class="partial-label mb-0.5 text-xs text-black/45">{{ t('stream.partialOutput.label') }}</div>
      <!-- issue #502 形态 M：占位（无锦点且两处正文源都空）⇒ **不渲染空气泡**，只留上面那行中性
           标签 + 一句提示。不是红色 .syserr（「正文没留住」不是故障），也不塑一个空 `div.md`。
           旧版这条提示走 SSE 分隔行（`stream.event.partialOutputLost`），形态 M 把占位收进
           历史投影后就走这里（占位只有历史那一条入口）。 -->
      <div v-if="en.placeholder" class="partial-placeholder text-black/45">{{ t('stream.partialOutput.placeholder') }}</div>
      <div v-else v-mermaid v-html="partialHtml(en.text)"></div>
      <div v-if="en.truncated" class="partial-truncated mt-0.5 text-xs text-black/45">{{ t('stream.partialOutput.truncated') }}</div>
    </div>
    <!-- issue #189：折叠横幅（**独立视觉**：非 .msg 气泡，琥珀色左边框 + 虚线分隔条，绑定助手消息 id，
         排在正文气泡前）。标题带压缩条数/轮范围（缺字段逐级降级）；摘要默认收起，点击展开；
         「查看原文」→ 只读懒加载原文 turns（loading / 404 友好提示 / error+重试）。 -->
    <div
      v-else-if="en.kind === 'folded'"
      class="folded-banner my-1.5 max-w-[46rem] rounded-md border border-dashed border-black/20 border-l-4 border-l-amber-500 bg-amber-50/60 px-3 py-1.5 text-sm"
    >
      <!-- issue #390：hasSummary=false ⇒ 无▾、无摘要区（标题降为普通行）；键缺席照旧画▾可展开。 -->
      <button
        v-if="foldedHasReadableSummary(en)"
        type="button"
        class="folded-toggle flex w-full min-w-0 items-center gap-2 text-left"
        :aria-expanded="isFoldedExpanded(en.id)"
        @click="toggleFolded(en.id)"
      >
        <span class="shrink-0 font-semibold text-black/60">🗜 {{ foldedTitle(en.folded) }}</span>
        <span
          class="shrink-0 text-black/50 transition-transform duration-150"
          :class="{ 'rotate-180': isFoldedExpanded(en.id) }"
        >▾</span>
      </button>
      <div v-else class="folded-title flex w-full min-w-0 items-center gap-2">
        <span class="shrink-0 font-semibold text-black/60">🗜 {{ foldedTitle(en.folded) }}</span>
      </div>
      <!-- D 片（#392）：可见性说明（两态；hasSummary 键缺席则整行不出）。 -->
      <p v-if="foldedVisibilityNotice(en)" class="folded-visibility mt-0.5 text-xs text-black/45">
        {{ foldedVisibilityNotice(en) }}
      </p>
      <!-- 摘要：默认收起；展开后走 markdown（#389：与助手气泡同一渲染路径/样式——先转义后格式化，
           XSS 安全；markdown 自己重排，所以不叠加 whitespace-pre-wrap，否则双倍行距）。 -->
      <div
        v-if="foldedHasReadableSummary(en) && isFoldedExpanded(en.id)"
        class="folded-summary md mt-1 overflow-auto text-black/70"
        v-html="renderMarkdown(foldedSummaryBody(en))"
      ></div>
      <!-- 查看原文（轮号可推导才展示；只读懒加载，按 (会话,轮) 缓存） -->
      <div v-if="en.sessionId != null && foldedQueryRound(en.folded) != null" class="mt-1 flex items-center gap-2">
        <button
          type="button"
          class="view-original rounded-md border border-black/20 px-2 py-0.5 text-xs hover:bg-black/5"
          @click="loadOriginal(en)"
        >{{ t('stream.folded.viewOriginal') }}</button>
      </div>
      <!-- 原文块（#388）：可见性归 foldedOriginalVisible 管——标题收起时跟着收起，本地「收起原文」时隐藏（不清缓存）。 -->
      <div v-if="foldedOriginalVisible(en)" class="folded-original mt-1">
        <!-- #388：原文块自己的收起入口——只隐藏，**不清缓存**（再展开命中缓存，不重发）。 -->
        <div class="flex justify-end">
          <button
            type="button"
            class="folded-original-collapse rounded-md border border-black/20 px-2 py-0.5 text-xs text-black/50 hover:bg-black/5"
            @click="collapseOriginal(en.id)"
          >{{ t('stream.folded.collapseOriginal') }}</button>
        </div>
        <div v-if="foldedOriginalState(en)!.status === 'loading'" class="text-xs text-black/40">{{ t('common.loading') }}</div>
        <div v-else-if="foldedOriginalState(en)!.status === 'missing'" class="folded-original-missing text-xs text-black/40">{{ t('stream.folded.originalMissing') }}</div>
        <template v-else-if="foldedOriginalState(en)!.status === 'loaded'">
          <!-- #375：归档只是本轮差分且被上游夹断时，要说清「下面的正文是从账本按轮号补齐的」 -->
          <div
            v-if="(foldedOriginalState(en) as { truncated?: boolean }).truncated"
            class="folded-original-truncated text-xs text-black/40"
          >{{ t('stream.folded.originalTruncated', { count: (foldedOriginalState(en) as { droppedMessages?: number }).droppedMessages ?? '?' }) }}</div>
          <!--
            原文渲染口径（#384，真机验出来的一条「假占位」）：
            账本里的 turn 有四类内容——`text` / `reasoning` / `toolCalls[]`（+ user 身份）。旧实现只画 `text`，
            于是**真的干了活的那几轮**（只有 reasoning + 工具调用、没有正文）整片渲染成「（无文本内容）」——
            真机 round 100 的 112 条里有 40 条是这样，用户看到的是满屏空行，而原文其实全在。
            现在：四类都画；只有四类**都空**才给占位（占位的语义收窄成「这一条真的什么都没有」）。
          -->
          <div
            v-for="(turn, ti) in (foldedOriginalState(en) as { status: 'loaded'; turns: Array<{ role?: string; text?: string; reasoning?: string; toolCalls?: Array<{ name?: string; argsSummary?: string; isError?: boolean }> }> }).turns"
            :key="ti"
            class="folded-original-turn"
          >
            <div v-if="turn.role === 'user'" class="folded-original-role text-xs text-black/35">{{ t('stream.folded.originalRoleUser') }}</div>
            <!-- #389：正文走 markdown（与助手气泡同一路径/样式）；reasoning 与工具行**刻意保持纯文本**
                 （模型独白/命令行里 `*` `_` 反引号遍地，格式化会出错），绝不 v-html。 -->
            <div v-if="turn.reasoning" class="folded-original-reasoning overflow-auto whitespace-pre-wrap break-all text-black/40 italic">{{ turn.reasoning }}</div>
            <div v-if="turn.text" class="folded-original-text md overflow-auto text-black/70" v-html="renderMarkdown(turn.text)"></div>
            <div
              v-for="(tc, ci) in (turn.toolCalls ?? [])"
              :key="ci"
              class="folded-original-tool overflow-auto whitespace-pre-wrap break-all text-xs text-black/45"
            >{{ t('stream.folded.originalTool', { name: tc.name ?? '?', args: tc.argsSummary ?? '' }) }}{{ tc.isError ? t('stream.folded.originalToolFailed') : '' }}</div>
            <div v-if="!turn.text && !turn.reasoning && !(turn.toolCalls && turn.toolCalls.length)" class="text-xs text-black/40">{{ t('stream.folded.originalEmpty') }}</div>
          </div>
          <div v-if="(foldedOriginalState(en) as { status: 'loaded'; turns: unknown[] }).turns.length === 0" class="text-xs text-black/40">{{ t('stream.folded.originalEmpty') }}</div>
        </template>
        <div v-else-if="foldedOriginalState(en)!.status === 'error'" class="folded-original-error flex items-center gap-2 text-xs text-red-600">
          <span>{{ t('stream.folded.originalError', { message: (foldedOriginalState(en) as { status: 'error'; message: string }).message }) }}</span>
          <button type="button" class="retry-original rounded-md border border-black/20 px-2 py-0.5 hover:bg-black/5" @click="retryOriginal(en)">{{ t('common.retry') }}</button>
        </div>
      </div>
    </div>
    <!-- roundsep / 系统分隔行（judge 事件以 variant='judge' 走黄色面板样式） -->
    <div v-else-if="en.kind === 'sep'" :class="en.variant === 'judge' ? 'roundsep judge-panel' : 'roundsep'">{{ en.text }}</div>
    <!-- issue #42：红色系统错误行 -->
    <div v-else-if="en.kind === 'syserr'" class="syserr">{{ en.text }}</div>
    <!-- 工具卡片（issue #85：可折叠，默认收起；ok/err 左边框分级；头部整行 button 防溢出） -->
    <div
      v-else-if="en.kind === 'tool' && store.es.toolCards.get(en.callId)"
      class="my-1.5 max-w-[46rem] rounded-md border border-black/10 border-l-4 bg-black/[0.03] px-3 py-1.5 text-sm"
      :class="store.es.toolCards.get(en.callId)!.ok === true ? 'border-l-green-600'
        : store.es.toolCards.get(en.callId)!.ok === false ? 'border-l-red-600' : 'border-l-neutral-500'"
    >
      <div class="flex w-full min-w-0 items-center">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
          :aria-expanded="isExpanded(en.callId)"
          @click="toggleCard(en.callId)"
        >
          <span
            class="shrink-0 font-semibold"
            :class="store.es.toolCards.get(en.callId)!.ok === false ? 'text-red-600' : ''"
          >🔧 {{ store.es.toolCards.get(en.callId)!.name }}</span>
          <!-- issue #delegate：delegate 卡的摘要位换成「action · 子runId 短码」（解不出就整段退回下行） -->
          <span
            v-if="delegateView(en.callId)"
            class="delegate-summary min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-black/50"
          >{{ delegateView(en.callId)!.summary }}</span>
          <span
            v-else
            class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-black/50"
          >
            {{ summaryText(store.es.toolCards.get(en.callId)!) }}
          </span>
          <!-- 状态位：spinner+蓝 / ✓ 绿 / ■ 琥珀 / ✗ 红（红色集含「completed + syserr termination」） -->
          <span
            v-if="delegateView(en.callId)"
            class="delegate-state flex shrink-0 items-center font-normal"
            :class="delegateView(en.callId)!.color"
          >
            <svg
              v-if="delegateView(en.callId)!.spinner"
              class="h-3 w-3 animate-spin"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3" />
              <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round" />
            </svg>
            <span v-else>{{ delegateView(en.callId)!.mark }}</span>
          </span>
          <span
            v-else
            class="shrink-0 font-normal"
            :class="store.es.toolCards.get(en.callId)!.ok === false ? 'text-red-600' : 'text-black/50'"
          >{{ statusMark(store.es.toolCards.get(en.callId)!) }}</span>
          <span
            class="shrink-0 text-black/50 transition-transform duration-150"
            :class="{ 'rotate-180': isExpanded(en.callId) }"
          >▾</span>
        </button>
        <!-- 只在「结果 ok 且拿到了子 runId」时出（pi-web 形状：32px 方块 + 左侧分隔线，在折叠按钮**外层**——HTML 不允许嵌套 button） -->
        <button
          v-if="delegateView(en.callId)?.openable"
          type="button"
          class="delegate-open-viewer flex h-8 w-8 shrink-0 items-center justify-center border-l border-black/10 text-black/50 hover:bg-black/5"
          :aria-label="t('delegate.openViewer')"
          :title="t('delegate.openViewer')"
          @click="openDelegateDrawer(en.callId)"
        >
          <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
            <rect x="3" y="4.5" width="18" height="15" rx="2" />
            <path d="M14.5 4.5v15" />
          </svg>
        </button>
      </div>
      <!-- 展开态：完整 args（pre 块永不溢出）+ 结果摘要行（tool_result 只带 digest，不虚构全文） -->
      <template v-if="isExpanded(en.callId)">
        <pre class="mt-1 overflow-auto whitespace-pre-wrap break-all font-normal text-black/70">{{ cardArgs(store.es.toolCards.get(en.callId)!) }}</pre>
        <div class="font-normal text-black/50">{{ cardOut(store.es.toolCards.get(en.callId)!) }}</div>
      </template>
    </div>
    <!-- issue #188：推理块（与正文分离、默认收起、可展开）——沿用工具卡片的按钮+chevron 折叠风格 -->
    <div
      v-else-if="en.kind === 'reasoning'"
      class="my-1.5 max-w-[46rem] rounded-md border border-black/10 border-l-4 border-l-neutral-400 bg-black/[0.02] px-3 py-1.5 text-sm"
    >
      <button
        type="button"
        class="flex w-full min-w-0 items-center gap-2 text-left"
        :aria-expanded="isReasoningExpanded(en.id)"
        @click="toggleReasoning(en.id)"
      >
        <span class="shrink-0 font-semibold text-black/60">🧠 {{ t('stream.reasoning') }}</span>
        <span class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-black/40">
          {{ reasoningSummary(en.text) }}
        </span>
        <span
          class="shrink-0 text-black/50 transition-transform duration-150"
          :class="{ 'rotate-180': isReasoningExpanded(en.id) }"
        >▾</span>
      </button>
      <pre v-if="isReasoningExpanded(en.id)" class="mt-1 overflow-auto whitespace-pre-wrap break-all font-normal text-black/70">{{ en.text }}</pre>
    </div>
  </template>

  <!-- issue #delegate：子 run 只读抽屉（全组件**单一挂载点**，props 全部从卡片取，不在抽屉里重导状态）。
       parentRunId = 卡片所属 run（实时与刷新两条建卡路径都填了）、childRunId = 结果里的 runId、
       termination 一并递下去（抽屉自己的端点不带它，而「completed + syserr 仍红」这条红线在抽屉里也得成立）。 -->
  <DelegateChildDrawer
    v-if="delegateOpen"
    :session-id="store.sessionId ?? ''"
    :parent-run-id="delegateOpen.parentRunId"
    :child-run-id="delegateOpen.childRunId"
    :label="delegateOpen.label"
    :termination="delegateOpen.termination"
    @close="delegateOpen = null"
  />
</template>
