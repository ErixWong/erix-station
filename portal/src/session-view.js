// 会话读侧展示投影（P3 PR②b，docs/design/conversation-state.md §6，上游 issue #95）。
//
// 「文本 / blocks / reasoning / 折叠」的推导**全部交给本站自有投影**
// `projectTranscriptForDisplay(records)`（本仓 `portal/src/display-projection.js`，
// 来源见该文件头注释）：
//   - `reasoning` 与 `text` 分离，推理文本不再混进正文；
//   - 折叠轮只给「摘要 + 范围 + 导航指针」（`meta.foldedRoundRange` / `meta.navigationRecord`），
//     `foldedPayload` 原文不进对话流；
//   - 注入消息（judge 方向提示、审计拦截、system、wrapup）由 `meta.synthetic` / `meta.source` 标注；
//   - 记录的 dedupKey 经 `meta.dedupKey` 带出 → 宿主可把输入行**精确**映射到 messages 锚点。
//   输出形状（role/text/blocks/toolCalls/reasoning/folded/round/ts/meta）是稳定契约面；
//   `RoundRecord` 内部字段不是，本模块不读它。
//
// issue #188：投影的 `toolCalls`/`reasoning`/`blocks` 随助手锚点**逐字透传**进对话流 DTO（原名、不裁剪、
// 不重推导；无则不写该键），供前端加载/刷新路径重建工具卡片与推理展示。宿主不向上游形状注入字段
//（#95 红线）。erix-agent 0.16.0 已提供稳定的投影视图键：`turn.key`（轮级）与 `toolCalls[].key`
// （单次投影内唯一、同输入确定性、由输入位置生成；**不是持久 ID、也不是 provider `tool_use.id`**）
// ——上游 erix-llm-kit#100（`toolCalls[].id` 可选/可重复）由此交付视图身份，前端不再自造 key。
//
// 官方投影**不承担**、仍由本模块承担的部分（都是宿主/UI 概念，契约面里没有）：
//   1. **锚点元数据**：DTO 的 `id`/`seq`/`run_id`/`attachments`/`synthetic`/`created_at` 一律取自
//      `messages` 锚点行——引擎没有「消息行」概念，`seq`/附件是本平台的分配器与外键。
//   2. **助手文本的 run 归属**：投影输出不带 `run_id`（引擎只认 transcript key 与 dedupKey 命名空间），
//      而 UI 的助手气泡必须落到某个 run。故保留三条归组规则：显式 `run_id` 列 → 该 run；
//      session-scoped 行沿用 transcript 分段（遇到 user 输入/键名 run 才切换）；单 run 会话兜底。
//   3. **非 `:input:` 行的锚点认领**：引擎轮记录（`<key>:engine:round:<n>`）、run 历史快照与 seed 行
//      带的是**轮级** dedupKey，没有 messageId，映射不到 `messages.id`；崩溃 run 的用户文本又常常
//      只存在于后续 run 的历史快照里（迁移 0015 之前入档的行甚至两者皆无）。这类行只能继续按
//      「内容精确相等」认领尚未认领的 user 锚点（seq 升序、单调游标、一条锚点只被认领一次）。
//      带 `<sessionId>:input:<messageId>` 的行**一律走 meta.dedupKey 精确映射**，不再参与内容匹配。
import { projectTranscriptForDisplay } from './display-projection.js';
import { foldTranscriptRows } from './transcript-fold.js';

// 归属用的键名：DB `dedup_key` 列（宿主自有的幂等键）+ 投影带出的 `meta.dedupKey`。
// 展示不读 RoundRecord 内部字段；只有「补齐 dedupKey」时会看一眼 dedupKey/roundKey（见 recordForProjection）。
function attributionKeys(row, metaDedupKey) {
  return [row.dedup_key, metaDedupKey]
    .filter((key) => typeof key === 'string' && key.length > 0);
}

/**
 * DB 行 → 引擎 record（附合成的 dedupKey）。与 `transcript-store.js` 的 `load()` 同一套补齐规则：
 * 官方投影只从 `record.dedupKey` 产出 `meta.dedupKey`，而老行的幂等键可能**只在 `dedup_key` 列上**，
 * 因此把列值合成进 record，避免这类行退化成「无稳定 id」走内容匹配。
 * 这里读 `base.dedupKey`/`base.roundKey` 只为补齐这个键（与 store.load 同口径），不是展示数据源。
 */
export function recordForProjection(row) {
  const base = row.record && typeof row.record === 'object' ? row.record : {};
  const dedupKey = row.dedup_key ?? base.dedupKey ?? base.roundKey ?? null;
  return {
    record: {
      ...base,
      round: Number(row.round),
      ...(dedupKey === null ? {} : { dedupKey: String(dedupKey) }),
    },
    dedupKey: dedupKey === null ? null : String(dedupKey),
  };
}

/** 投影带出的 `meta.dedupKey`（同一 record 展开出的各 turn 共享同一个键）。 */
export function projectionDedupKey(turns) {
  const turn = turns.find((candidate) => typeof candidate?.meta?.dedupKey === 'string'
    && candidate.meta.dedupKey !== '');
  return turn?.meta?.dedupKey ?? null;
}

export function inputMessageId(dedupKey, sessionId) {
  const prefix = `${sessionId}:input:`;
  return typeof dedupKey === 'string' && dedupKey.startsWith(prefix)
    ? dedupKey.slice(prefix.length)
    : null;
}

function recordRunId(keys, runIds) {
  for (const runId of runIds) {
    if (keys.some((key) => key.startsWith(`${runId}:round:`) || key.startsWith(`${runId}:engine:round:`))) {
      return runId;
    }
  }
  return null;
}

function isSessionRound(keys, sessionId) {
  return keys.some((key) => (
    key.startsWith(`${sessionId}:round:`) || key.startsWith(`${sessionId}:engine:round:`)
  ));
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function compareTranscriptRows(a, b) {
  const roundDiff = Number(a.round) - Number(b.round);
  if (Number.isFinite(roundDiff) && roundDiff !== 0) return roundDiff;
  const aTime = timestamp(a.created_at);
  const bTime = timestamp(b.created_at);
  if (aTime !== null && bTime !== null && aTime !== bTime) return aTime - bTime;
  return 0;
}

/** 引擎注入的控制文本（erix-agent 0.22 `meta.source === 'judge-control'`）：advisory / 强制收尾指令等，
 * 不是人说的话 ⇒ 不进标题素材 / 终态比较 / 锚点认领。
 *
 * ⚠ **逐条消息判，不按整行判**：0.22 的 `…:control:forced-final` 同一行里**既带** marker 的注入指令
 * （role=user）**又带**不带 marker 的真终稿（role=assistant），按行过滤会把终稿一起吞掉
 * （#300 之后那就是「中止/失败 run 正文又空了」）。
 *
 * 诚实记录今天的有性（实测，不是推测）：0.22 的 `projectTranscriptForDisplay` 会给带 `meta.source`
 * 的 **user 角色**消息**另外打 `synthetic: true`** ⇒ 下面那条 `meta?.synthetic !== true` 早已把它拦住
 * （= 界面正文本来就不漏的真原因）。本条因此是**冗余守卫**：上游一旦不再打 synthetic，没它就漏。
 * 它只能在「直接喂 turn 对象」的用例里被测到 —— 变异实测：撤掉本条**只有那一条**用例会红。
 * **assistant 角色故意不加这道守卫**：同一个投影对 assistant 消息会**连 `meta.source` 一起抹掉**
 * （实测：投影后 `meta` 只剩 `{ synthetic:false, dedupKey }`）⇒ 宿主侧看不到 marker，写了也接不住
 * （要接住得上游别抹）。该上游口径已钉成用例（portal/test/session-view-judge-control.test.js）。 */
function isEngineControlTurn(turn) {
  return turn?.meta?.source === 'judge-control';
}

/** 该行的真实用户文本（排除引擎注入的合成消息与控制文本，避免注入文本抢认锚点 / 当标题素材）。
 *  P3 PR②b：`session-text.js`（标题 / claim task / 历史上行等文本读取点）复用同一口径，勿另写一份。 */
export function userTurnTexts(turns) {
  return turns
    .filter((turn) => turn.role === 'user'
      && turn.meta?.synthetic !== true
      && turn.folded !== true
      && !isEngineControlTurn(turn))
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '');
}

/** 该行的助手正文：投影已把 reasoning 与 tool-only 轮次分离，取最后一条非空文本（= 最终答复）。
 *  故意**不**按 `meta.source` 排控制文本：投影对 assistant 消息已把该字段抹掉，宿主侧无从判据
 *  （见上方 `isEngineControlTurn` 注释）；0.22 的控制文本也只注入 role=user。
 *  P3 PR②b：同样供 `session-text.js` 复用（终态幂等比较的 final_text 取数）。 */
export function assistantTurnText(turns) {
  const text = turns
    .filter((turn) => turn.role === 'assistant' && turn.folded !== true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '')
    .at(-1);
  return text ?? null;
}

/**
 * 折叠轮的官方展示文本（摘要 + 范围 + 导航指针，`foldedPayload` 原文已被投影排除）。
 * DTO 是锚点驱动的，没有可承载官方 system 折叠行的锚点，故只在「该 run 没有自身助手正文」时顶上
 * （取舍见执行报告：契约 ③「折叠的是上下文，显示的是历史消息」——历史消息优先，折叠摘要兜底）。
 */
function foldedTurnText(turns) {
  const text = turns
    .filter((turn) => turn.folded === true)
    .map((turn) => turn.text)
    .filter((value) => typeof value === 'string' && value !== '')
    .at(-1);
  return text ?? null;
}

/**
 * issue #189：折叠轮的上游元数据（范围 / 导航指针 / 被折叠消息条数 + 折叠摘要原文），逐字透传
 * （#95 红线：上游原名、不改名、不重推导）。只从 `turn.folded === true` 的轮取；
 * 四项都缺 → null（调用方据此不写 `folded` 键，与 toolCalls 同规矩）。
 * 上游把三元组放在折叠 turn 的 meta 面上（erix-agent display/projection.js：meta.foldedRoundRange /
 * meta.navigationRecord / meta.foldedPayloadMessages），`text` 则与 `foldedTurnText()` 同源（折叠摘要原文）。
 * `round`（#189 收尾）= **该折叠行自己的 round**（上游 turn.round，实测契约面 {role,text,blocks,folded,round,meta,key}），
 * 是「查看原文」端点 `GET /api/sessions/:id/folded/:round` 的正确查询键——它与被折叠的轮范围
 * `foldedRoundRange`（如 1–5）语义不同，前端拿 range 去查会查错行 404。附加字段，不进「四项全缺 → null」判据。
 */
/**
 * issue #390-A：这次折叠**到底有没有真摘要**。
 *
 * 判据来自上游契约本身（erix-agent `src/store/file.js:25` / `src/store/memory.js:19` 逐字同款）：
 *
 *     summary?:{action:string,note:string}|"missing",
 *
 * ⇒ 摘要**可缺省**，缺省时上游写的是字符串字面量 `"missing"`（现网全站 17 条折叠行都是这个值）。
 * 只有 `{action,note}` 形态、且至少一项是非空字符串，才算「有摘要」。刻意**不**用「`text` 是不是
 * 那句兜底话」来判：那是上游投影生成物，字符串比对会把真摘要也误判掉（#390 里写明了这条红线）。
 *
 * 判据宽松度说明：`{action:'x', note:''}` 算有（上游只承诺形状、没承诺两项都填），
 * `{}`、`{note:''}`、`"missing"`、`null`、数组都算没有。
 */
function hasRealSummary(record) {
  const summary = record?.summary;
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return false;
  return [summary.action, summary.note].some((value) => typeof value === 'string' && value !== '');
}

/**
 * issue #440：`foldedFacts.source` 里本站**认得**的那两个值（实测值域，见 erix-agent
 * `compact/fold-summary-journal.js#ORIGIN_BY_SOURCE`：`llm` ⇒ semantic，`statistical` ⇒ mechanical）。
 *
 * 为什么要白名单而不是「原样透传」：`source` 的引擎缺省是字面量 `'strategy'`（同一函数里
 * `input.source ?? 'strategy'`），另有一个 `'host'`。这两个值在本站横幅上**没有第三态可落**——
 * 说它们是「LLM 语义摘要」是假话、说「机械替代物」也不准。所以不认识的形态**整个键不给**
 * （与 #390-A 同一条「键缺席 = 不知道」纪律），前端自然退回第三态。
 */
const FOLDED_FACTS_SOURCES = Object.freeze(['llm', 'statistical']);

/**
 * issue #816：`foldedFacts.origin` 里本站**认得**的那三个值——逐字取引擎
 * `compact/fold-summary-journal.js#FOLDED_FACT_ORIGINS` 的现查值（`['mechanical','semantic','host']`）。
 *
 * 为什么是白名单而不是原样透传：`origin` 是「这条投影由谁产出」的三态标签，前端据它选横幅文案。
 * 引擎将来若加第四态，本站白名单外的值**整个键不给**（与 #390-A / #440 同一条「键缺席 = 不知道」纪律），
 * 前端退回第三态，而不是把一个没核对过的字符串直接当标签渲染。
 */
const FOLDED_FACT_ORIGINS = Object.freeze(['mechanical', 'semantic', 'host']);

/**
 * issue #816：`foldedFacts.toolCalls` 的逐项清洗（宿主不再动第二刀：引擎已按 ≤8 条 × ≤80 字夹过）。
 *
 * 只保留「形状可信」的项：非数组对象、`name` 是 trim 后非空的字符串（输出取 trim 后的值）；
 * `argsSummary` 仅在是非空字符串时带上（空串 ⇒ 不带这个键，而不是写空串）。
 * 清洗后为空数组 ⇒ 返回 `[]`，由调用方据此**不给 `toolCalls` 键**（不是给 `[]`）。
 *
 * @param {unknown} items `foldedFacts.toolCalls`
 * @returns {{ name: string, argsSummary?: string }[]}
 */
function cleanFoldedToolCalls(items) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = /** @type {{ name?: unknown, argsSummary?: unknown }} */ (item);
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (name === '') continue;
    const argsSummary = typeof entry.argsSummary === 'string' && entry.argsSummary !== ''
      ? entry.argsSummary
      : undefined;
    out.push({ name, ...(argsSummary === undefined ? {} : { argsSummary }) });
  }
  return out;
}

/**
 * issue #440：`foldedFacts` 的**读侧**投影（一折一条，落在发生折叠的那一轮的轮记录上）。
 *
 * 为什么必须进 DTO：`foldedFacts.text` 是宿主横幅**唯一**能拿到「这次折叠到底留下了什么」的地方
 * （引擎 `orchestrator.js:5417` 把 `compaction.foldedFacts` clone 到轮记录）。真机标本（会话
 * `e02d96cb…` 第 25 轮，`seq 8989`）：`record.foldedFacts` = `{source:'llm', origin:'semantic',
 * strategy:'fold-llm', text:'## 阶段…（2048 B 语义摘要）', truncated:true, bytesBefore:3076}`，
 * 而 `folded.hasSummary === false`（fold-llm 写的是字面量 `"missing"`）+ `folded.text` 取的是
 * 上游投影生成的折叠 turn 文本 ⇒ 界面上一句「this fold produced no summary」，用户为语义折叠付的
 * 那份 token 一个字节也看不见（#440 的原文病症）。
 *
 * 三个键的缺席语义（与 #390-A 同规矩，**不许写 false/null 冒充**）：
 *   · `summaryText` —— `foldedFacts.text` 非空字符串才给；
 *   · `summarySource` —— 只在白名单里才给（见 `FOLDED_FACTS_SOURCES`）；
 *   · `truncated` —— 只在 `foldedFacts.truncated === true` 时给（前端据此说「摘要被夹断」）；
 *     `false` 不给：`buildFoldedFacts` 只在真夹断时写这个键，回一个 `false` 等于替引擎断言
 *     「我看过且没夹断」，而旧账本上我们根本不知道。
 *
 * ⚠ `hasSummary` 的语义**一字未动**（#390-A 钉着：它只读 `record.summary`，与 `foldedFacts` 无关）。
 * 「有没有可读摘要」这件事由 `summaryText` 自己表达，不复用 `hasSummary`。
 *
 * ── #816：`facts` 嵌套键的口径与缺席语义 ──
 * 本函数在三个既有键之外**新增一个嵌套键 `facts`**（不是平铺 8 个键，也不动 `summaryText`/`summarySource`/
 * `truncated`/`hasSummary`），把账本 `record.foldedFacts` 里本就有的结构化数据搬进 DTO，供折叠呈现重设计
 * （一行「范围 · title · 工具足迹」）直接取用。
 *   · **缺席 = 不知道**（与 #390-A / #440 同一条纪律）：每个子键取不到就**不写这个键**，绝不写 `null`/`false`/
 *     `0`/空串；`foldedFacts` 不是对象或是数组 ⇒ **整个 `facts` 键不出现**（被上面的守卫挡掉）。
 *   · `toolCalls` 逐项清洗（见 `cleanFoldedToolCalls`），清洗后为空 ⇒ 不给键；**不截断、不改写内容**。
 *   · `origin` 走白名单 `FOLDED_FACT_ORIGINS`，白名单外一律不给键。
 *   · `summary`/`summaryDropped`/`titleFallback` 是为引擎即将落地的 #897 **预留的读点**：0.33.0 上这些键
 *     不存在 ⇒ 天然缺席；等引擎补上（用户 261126 确认近期修好）本站**零改动**就能用（不是「等升级才能用」）。
 *   · ⚠ `facts.summary`（模型给的 description）与 `summaryText`（= `foldedFacts.text`，替代物正文）是**两份
 *     不同的东西**，注释与实现都必须保持两者各写各的键——这是本函数最容易被误合并的地方。
 *
 * @param {unknown} facts 轮记录上的 `record.foldedFacts`
 * @returns {{ summaryText?: string, summarySource?: string, truncated?: true, facts?: object }}
 */
function foldedFactsFields(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return {};
  const value = /** @type {{ text?: unknown, source?: unknown, truncated?: unknown, title?: unknown, summary?: unknown, origin?: unknown, from?: unknown, to?: unknown, rounds?: unknown, toolCalls?: unknown, summaryDropped?: unknown, titleFallback?: unknown }} */ (facts);
  const summaryText = typeof value.text === 'string' && value.text !== '' ? value.text : undefined;
  const summarySource = typeof value.source === 'string' && FOLDED_FACTS_SOURCES.includes(value.source)
    ? value.source
    : undefined;
  // #816：`facts` 嵌套键——每个子键「取不到就不写」，绝不写 null/false/0/空串。到这里 `facts` 已是
  // 非 null 非数组对象（上面的守卫已挡掉非对象），所以没有任何认得子键时整个 `facts` 键不出现
  // （空壳 `{}` 等于替账本断言『有事实』，那是假话）。
  const trimmed = typeof value.title === 'string' ? value.title.trim() : '';
  const title = trimmed !== '' ? trimmed : undefined;
  // ⚠ `summary` 是**模型给的 description**（#897 预留读点），与 `summaryText`（=`foldedFacts.text` 替代物正文）
  //   不是同一份东西——两者各写各的键，不许合并。
  const summary = typeof value.summary === 'string' && value.summary !== '' ? value.summary : undefined;
  const origin = typeof value.origin === 'string' && FOLDED_FACT_ORIGINS.includes(value.origin)
    ? value.origin
    : undefined;
  const from = Number.isSafeInteger(value.from) ? value.from : undefined;
  const to = Number.isSafeInteger(value.to) ? value.to : undefined;
  const rounds = Number.isSafeInteger(value.rounds) && value.rounds > 0 ? value.rounds : undefined;
  const toolCalls = cleanFoldedToolCalls(value.toolCalls);
  const factsObj = {
    ...(title === undefined ? {} : { title }),
    ...(summary === undefined ? {} : { summary }),
    ...(origin === undefined ? {} : { origin }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(rounds === undefined ? {} : { rounds }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(value.summaryDropped === true ? { summaryDropped: true } : {}),
    ...(value.titleFallback === true ? { titleFallback: true } : {}),
  };
  return {
    ...(summaryText === undefined ? {} : { summaryText }),
    ...(summarySource === undefined ? {} : { summarySource }),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(Object.keys(factsObj).length === 0 ? {} : { facts: factsObj }),
  };
}

function foldedTurnFields(turns, roundsWithRealSummary = new Set(), foldedFactsByRound = new Map()) {
  for (const turn of [...turns].reverse()) {
    if (turn?.folded !== true) continue;
    const pick = (key) => (turn[key] !== undefined && turn[key] !== null
      ? turn[key]
      : (turn.meta?.[key] !== undefined && turn.meta?.[key] !== null ? turn.meta[key] : undefined));
    const range = pick('foldedRoundRange');
    const navigation = pick('navigationRecord');
    const payloadMessages = pick('foldedPayloadMessages');
    // 折叠摘要原文（与 foldedTurnText 同源：该折叠 turn 自己的 text，逐字透传）。
    const text = typeof turn.text === 'string' && turn.text !== '' ? turn.text : undefined;
    // 该折叠行自己的轮号（上游 turn.round，原名；仅整数时带上。非四项判据成员，缺了不影响出现与否）。
    const round = Number.isInteger(turn.round) ? turn.round : undefined;
    if (range === undefined && navigation === undefined && payloadMessages === undefined && text === undefined) continue;
    // #440：`foldedFacts` 按**该折叠行自己的轮号**取（与 `roundsWithRealSummary` 同一把键，见调用方）。
    // 轮号缺失 / 账本没有这个键（旧账本）⇒ 三个键全部缺席，不是 false/null。
    const factsFields = round === undefined ? {} : foldedFactsFields(foldedFactsByRound.get(round));
    return {
      ...(text === undefined ? {} : { text }),
      ...(range === undefined ? {} : { foldedRoundRange: range }),
      ...(navigation === undefined ? {} : { navigationRecord: navigation }),
      ...(payloadMessages === undefined ? {} : { foldedPayloadMessages: payloadMessages }),
      ...(round === undefined ? {} : { round }),
      ...factsFields,
      // #390-A：轮号可定时才给得出「这次折叠有没有真摘要」。**轮号缺失就整个不带这个键**（不是 false）——
      // 前端口径是「键缺席 = 不知道 = 保持现状」，把它写成 false 会让旧数据凭空丢掉展开控件。
      // ⚠ #440 不许把它改成读 `foldedFacts.text`：它回答的是「引擎 `record.summary` 有没有料」，
      // 与「折叠替代物有没有料」是两件事（后者由上面的 `summaryText` 回答）。
      ...(round === undefined ? {} : { hasSummary: roundsWithRealSummary.has(round) }),
    };
  }
  return null;
}

/**
 * issue #188：单条 transcript 行里、官方投影助手轮上的展示字段（逐字透传，不裁剪/不改名/不重推导）。
 *
 * 投影的 `DisplayTurn` 契约面里，助手轮除 `text` 外还带 `blocks`（原始 content blocks 数组）、
 * `toolCalls?`（0.20.0 形状：`{key, name, id?, argsSummary?, resultPreview?, isError?, executionStatus?,
 * toolCallKey?, durationMs?}`，预览长度由上游定：args 120 / result 400。⚠ `executionStatus` **只在
 * 两种特殊状态下存在**（`intercepted`/`interrupted`，guide-0.20.0 §7：普通结果块上是**缺席**，
 * 不是空串也不是 `ok`），**不得拿「字段在不在」当「这块值得关注」的判据**；`toolCallKey`/`durationMs`
 * 在 T1 之前的记录上直接缺省）。与 `reasoning?`（与正文分离的推理文本）。这三者此前没有进入对话流 DTO，
 * 导致前端刷新后丢失工具卡片与推理。本函数把它们从助手轮上取出（**只取字段值，不做任何加工**）。
 * `turn.key`（0.16.0 新增的轮级视图键）也原样取出（keys），供 DTO 透传（run 聚合轮 → 数组）。
 *
 * 全部为空时返回 null，调用方据此**不写该键**（契约：有则透传、无则 DTO 不出现该键）。
 */
function assistantTurnFields(turns) {
  const assistantTurns = turns.filter((turn) => turn.role === 'assistant');
  if (assistantTurns.length === 0) return null;
  const toolCalls = assistantTurns.flatMap((turn) => (Array.isArray(turn.toolCalls) ? turn.toolCalls : []));
  const reasonings = assistantTurns
    .map((turn) => turn.reasoning)
    .filter((value) => typeof value === 'string' && value !== '');
  const blocks = assistantTurns.flatMap((turn) => (Array.isArray(turn.blocks) ? turn.blocks : []));
  const keys = assistantTurns
    .map((turn) => turn.key)
    .filter((value) => typeof value === 'string' && value !== '');
  return {
    toolCalls: toolCalls.length > 0 ? toolCalls : null,
    // 一个 run 可含多条助手轮，推理文本按投影顺序以 '\n' 连接（与上游 joinBlocks 同一连接符）。
    reasoning: reasonings.length > 0 ? reasonings.join('\n') : null,
    blocks: blocks.length > 0 ? blocks : null,
    keys: keys.length > 0 ? keys : null,
  };
}

/**
 * issue #283 / #299 / #303：把引擎投影的工具调用时长规范化进 DTO 的 `toolCalls[]`。
 *
 * ⚙ **单一来源 = 引擎投影自己带的 `toolCalls[].durationMs`**（erix-agent 0.20.0 起 `DisplayTurn.toolCalls[]`
 *    带 `toolCallKey` 与 `durationMs`；投影**只在 `erix.durationMs` 是有限数时**才带 `durationMs`，
 *    **缺失 = 未知、不是 0**）。宿主不再为「读老记录」补值。
 *
 * #303 清账（erix-agent 升到 0.34.0 这个 minor）：旧的「投影缺省 ⇒ 回落宿主 `tool_calls.duration_ms`」
 * 那条支路已删除。引擎侧旧键 `duration` 已退役（契约映射把旧键指向 erix.durationMs、orchestrator 落盘前
 * `delete` 旧键、run-snapshot-executor 注释明写旧键已退役 ⇒ 新记录上时长只此一份）。 ⇒ 投影不带
 * `durationMs` 就是「未知」：DTO 里**不出现这个键**，**禁止写 0**（guide §2：缺失 = 不知道，
 * 写 `?? 0` 会把未知渲染成「瞬间完成」）。
 *
 * ⚠ 跨实例风险：删的是「读旧数据」的兼容——存量比本次发布老的实例升级后，那些老对话的工具耗时会
 *   渲染成「未知」（前端现有 `dur` 为空时不显示，**不是报错**）。真正会被影响的集合是「投影不带
 *   `durationMs`、而宿主 `tool_calls.duration_ms` 有值」的那些 `(run_id, call_id)`。数它先用
 *   docs/data/model.md §1.13 的那条查询取分母，再按 `run_id` 关联 `runs` / `tool_calls` 收口
 *   （⚠ `transcript_rounds` 有 `run_id IS NULL` 的历史行，视图层会把没归属的轮次归给会话唯一 run，
 *   所以它们**也**能命中这条回落——界线是 `call_id` 能否匹配那个 run 的 `tool_calls`，不是块自己的 `run_id`；
 *   按 record 顶层路径直查 `duration` 也是恒 0 的假阴性，本单先被它骗过一次）。
 *
 * 为什么仍在投影**之后**做：`assistantTurnFields()` 的职责是**逐字透传**上游形状、不向引擎字段里注
 * 水（#95 红线）；这里只做一件防御性收尾——若上游偶发把 `durationMs` 写成非有限数（NaN/字符串），
 * 剥掉这个键而不是落 0。产出是**新对象**（剥键时），不就地改写引擎产出的对象。
 *
 * `durationMs` 现由**引擎投影直接带**（不再有宿主回落那条路）：前端只在现有 `dur` 为空时显示它。
 * 另：投影还发了 **`toolCallKey`**（引擎的耐久身份键）。本单**不接进前端卡片身份**——
 * 我们 §8.5 的卡片身份用的是投影自造的 `key` + provider `tool_use.id`，接不接 `toolCallKey` 是
 * 单独的设计决定（#299 (d) 明确不在本单范围），故它只作为透传字段存在，不在此处参与匹配。
 *
 * @param {Array<Record<string, unknown>>} toolCalls 引擎投影产出的数组（不被就地修改）
 */
function attachToolCallDurations(toolCalls) {
  return toolCalls.map((call) => {
    const ms = call?.durationMs;
    // 键本就缺省 = 未知 ⇒ 原对象返回（不拷贝、不加伪键）。
    if (ms === undefined) return call;
    // 投影给的有限数（含 0：引擎把墙钟回拨夹到 0）= 时长 ⇒ 原样透传。
    if (typeof ms === 'number' && Number.isFinite(ms)) return call;
    // 非有限值（NaN/字符串等上游偶发脏形）⇒ 当「未知」处理：剥键、不落 0。
    const { durationMs: _dropped, ...rest } = call;
    return rest;
  });
}

/**
 * #451：引擎压缩层的 id，**规范顺序**逐字取自 erix-agent `src/compact/pipeline.js` 的
 * `COMPACTION_PIPELINE`（ttl → slidingWindow → foldStatistical → foldLlm → anchors → enforceSize）。
 *
 * 为什么是白名单而不是「`layers` 里有什么就透什么」：这是宿主 DTO 的契约面，前端每个 id 都有一句
 * 中英文案；引擎将来加第七层时，宿主**不该**静默把一个没有文案的键塞给界面（键缺席 = 不渲染）。
 * 代价写在这里：新层要等宿主补 id + 文案才会出现在界面上（工单 §残留）。
 */
export const COMPACTION_LAYER_IDS = Object.freeze([
  'ttl', 'slidingWindow', 'foldStatistical', 'foldLlm', 'anchors', 'enforceSize',
]);

/**
 * #451：解析**一条** `compactionStats` 条目（引擎每轮往轮记录里 append 一条）。
 *
 * 真形状（真库核过，2026-11 全库 82 条带 stats 的轮记录，`jsonb_array_length` 恒 1）：
 * `{compacted, foldedRounds, tokensBefore, tokensAfter, layers:{ttl|slidingWindow|foldStatistical|
 * foldLlm|anchors|enforceSize:{triggered,tokensSaved}}, userTurnGuard?, strategyName?, foldSummary?}`。
 * ⚠ 真数据里 `layers` 的**六个键全在**（没触发的层是 `{triggered:0,tokensSaved:0}`，不是缺席）。
 *
 * 脏数据的处置是**整条丢弃**（不是修修补补）：一个坏轮记录不许把整个会话 DTO 打成 500。
 * 判据形状与 #390-A 同源——「不知道」就什么都不说，**绝不写 0 冒充**：
 *   · 条目不是对象 / `layers` 不是对象 ⇒ 脏（返回 null）；
 *   · 某层 `triggered` 非「非负安全整数」（如 `"abc"`）或 `tokensSaved` 非有限非负数（如 `-5`）⇒ 脏；
 *   · 某层缺席 ⇒ **不是脏**，只是该层没参与这次折叠（照实跳过该层）；
 *   · `tokensSaved` 缺席 ⇒ 不是脏，按 0 计（`triggered` 才是「有没有折」的判据）。
 *
 * @param {unknown} entry `compactionStats[i]`
 * @returns {Record<string, {triggered: number, tokensSaved: number}> | null} 脏 ⇒ null
 */
function parseCompactionEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const layers = /** @type {{layers?: unknown}} */ (entry).layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) return null;
  const parsed = {};
  for (const id of COMPACTION_LAYER_IDS) {
    const stat = layers[id];
    if (stat === undefined) continue; // 层缺席 = 这一层没参与，不是脏数据
    if (stat === null || typeof stat !== 'object' || Array.isArray(stat)) return null;
    const { triggered, tokensSaved } = /** @type {{triggered?: unknown, tokensSaved?: unknown}} */ (stat);
    if (!Number.isSafeInteger(triggered) || triggered < 0) return null;
    if (tokensSaved === undefined) {
      parsed[id] = { triggered, tokensSaved: 0 };
      continue;
    }
    if (typeof tokensSaved !== 'number' || !Number.isFinite(tokensSaved) || tokensSaved < 0) return null;
    parsed[id] = { triggered, tokensSaved: Math.floor(tokensSaved) };
  }
  return parsed;
}

/**
 * #451：`session.compaction` 聚合器（**纯函数、零查询**）——读侧覆盖存量与新 run。
 *
 * 语义（三条硬口径都在这里）：
 *   ① **键缺席而非零**：全库一条有效 `compactionStats` 都没有（或所有层的 `triggered` 都是 0）
 *      ⇒ 返回 `null`，调用方**整个 `compaction` 键都不给**——「键缺席 = 本会话没有任何折叠」，
 *      不是 `{}` / 不是全零对象（#390-A 同一形状）。
 *   ② **全零层不列**：只输出 `triggered > 0` 的层（`layers.foldLlm.triggered === 0` ⇒ 没有 `foldLlm` 键）。
 *   ③ **脏数据不炸**：脏条目逐条跳过并计入 `skipped`（进 LOG / 进测试断言，**不进 DTO**），
 *      其余轮照常汇总。
 *
 * `rounds` 按**轮号去重**计数（同一轮若出现多条 stats 只算一轮）；`lastRound` 是贡献过统计的最大轮号。
 * ⚠ 「贡献过」的准确含义是「这一轮至少有一层 `triggered > 0`」——全零轮（六层全 0）不进 `rounds`、
 * 也不推 `lastRound`。工单里写的是「有 compactionStats 的轮数」，而真库 82 条 stats 里全零轮是 **0 条**
 * （引擎不会为「什么都没折」的轮写统计），所以两种读法在今天的真数据上逐字相等；选后者是因为它让
 * 「键在 ⇒ `rounds ≥ 1`、`lastRound` 必定指向一轮真有折叠」自洽（否则会出现 `layers` 全空却 `rounds > 0`）。
 *
 * 实现上它只是 `collectTranscriptFacts` 的一个薄壳（同一个累加器，不另扫一遍）：
 * 单独导出是为了让「聚合语义」能被单测直接钉住，不必每次都造整个 DTO。
 *
 * @param {Array<{round?: unknown, record?: unknown}>} transcriptRows
 * @returns {{compaction: {rounds: number, layers: Record<string, {triggered: number, tokensSaved: number}>, tokensSaved: number, lastRound: number | null} | null, skipped: number}}
 */
export function aggregateCompactionStats(transcriptRows) {
  const { compaction, skippedCompactionEntries } = collectTranscriptFacts(transcriptRows);
  return { compaction, skipped: skippedCompactionEntries };
}

/**
 * #451：`transcriptRows` 的**那一次**扫描——四份事实一起产出，谁都别再扫第二遍。
 *
 * 为什么合成一个函数而不是多个 `filter`/`for`：`GET /api/sessions/:id` 要同时拿到
 * ① 折叠行真摘要（#390-A）、② 折叠替代物（#440）、③ 压缩层聚合（#451）、
 * ④ 会话级折叠索引 `session.folds[]`（#816 第②步，从同一趟整会话扫描派生，**不受消息窗口限制**）；
 * 分多趟就是多倍 `recordForProjection` 调用。成本红线的**判据**是 SQL 次数不变，但同一个数组多扫一遍同样没必要。
 *
 * @param {Array<{round?: unknown, record?: unknown}>} transcriptRows
 * @returns {{roundsWithRealSummary: Set<number>, foldedFactsByRound: Map<number, unknown>, compaction: object | null, skippedCompactionEntries: number, folds: Array<object>}}
 */
export function collectTranscriptFacts(transcriptRows) {
  const rows = Array.isArray(transcriptRows) ? transcriptRows : [];
  const roundsWithRealSummary = new Set();
  const foldedFactsByRound = new Map();
  const foldEntries = []; // #816 第②步：会话级折叠索引的原料（{round, foldedFacts}），同趟顺手收，不去重不清洗
  const totals = new Map(); // layerId → {triggered, tokensSaved}
  const roundsSeen = new Set();
  let lastRound = null;
  let skipped = 0;
  for (const row of rows) {
    // 一行只过一次 `recordForProjection`：折叠那半边与压缩那半边读的是同一个合成后的 record。
    const { record } = recordForProjection(row);
    const round = Number(row.round);
    if (record?.folded === true) {
      if (hasRealSummary(record)) roundsWithRealSummary.add(round);
      const foldedFacts = record?.foldedFacts;
      if (foldedFacts !== undefined && foldedFacts !== null) {
        foldedFactsByRound.set(round, foldedFacts);
        // #816 第②步：原样把 {round, foldedFacts} 存进局部数组——folds 索引的原料（**同一次** recordForProjection，
        // 零额外扫描）。区间可否取到、怎么排序、同 (from,to) 留哪条，全在扫描后统一派生（见函数尾）。
        foldEntries.push({ round, foldedFacts });
      }
    }
    // ---- #451：压缩层统计（同一趟扫描的第三个消费者）----
    const stats = record?.compactionStats;
    if (stats === undefined || stats === null) continue;
    // `compactionStats` 不是数组 ⇒ 这一行脏（跳过并计数），不是「没有统计」。
    if (!Array.isArray(stats)) {
      skipped += 1;
      continue;
    }
    // 按数组遍历（**不假设**长度恒 1）：引擎每轮 append 一条是今天的实测事实，不是契约。
    for (const entry of stats) {
      const parsed = parseCompactionEntry(entry);
      if (parsed === null) {
        skipped += 1;
        continue;
      }
      const layerIds = Object.keys(parsed);
      if (layerIds.length === 0) continue; // 空 layers ⇒ 这一条什么也没说
      // 全零轮不算「有折叠的轮」（见上方注释：真库 0 条全零 stats，两种读法在真数据上等价）。
      if (!layerIds.some((id) => parsed[id].triggered > 0)) continue;
      if (Number.isFinite(round)) {
        roundsSeen.add(round);
        if (lastRound === null || round > lastRound) lastRound = round;
      }
      for (const id of layerIds) {
        const target = totals.get(id) ?? { triggered: 0, tokensSaved: 0 };
        target.triggered += parsed[id].triggered;
        target.tokensSaved += parsed[id].tokensSaved;
        totals.set(id, target);
      }
    }
  }
  const layers = {};
  let tokensSaved = 0;
  for (const id of COMPACTION_LAYER_IDS) {
    const total = totals.get(id);
    if (!total || total.triggered <= 0) continue; // ② 全零层不列（不是列个 0）
    layers[id] = { triggered: total.triggered, tokensSaved: total.tokensSaved };
    tokensSaved += total.tokensSaved;
  }
  // ① 键缺席而非零：一条都没折（或全零）⇒ null，调用方不给这个键。
  const compaction = Object.keys(layers).length === 0
    ? null
    : { rounds: roundsSeen.size, layers, tokensSaved, lastRound };
  // ---- #816 第②步：会话级折叠索引 `session.folds[]`（同一趟扫描派生，零新增 SQL）----
  // 每项**复用 `foldedFactsFields` 那把尺**（不另写第二份）：它的 `facts` 子对象已按「取不到即不写」清洗过
  // from/to/rounds/title/...（from/to 只认安全整数），`truncated` 也在它的返回里（口径 = `=== true`）。
  // 契约：① 区间取不到（`from`/`to` 非安全整数）⇒ **这一项不进数组**（没有边界画不出来，不给半截）；
  // ② 按 `from` 升序、同 `from` 按 `round` 升序；③ 同 `(from,to)` 只留 `round` 最大的那条（最新落账=累计真值）。
  const foldItems = [];
  for (const { round, foldedFacts } of foldEntries) {
    const { facts, truncated } = foldedFactsFields(foldedFacts);
    // `facts` 缺席 ⇒ 连一个认得子键都没有（含区间）⇒ 不进数组；区间必须两头都是安全整数。
    if (!facts || !Number.isSafeInteger(facts.from) || !Number.isSafeInteger(facts.to)) continue;
    foldItems.push({
      ...(Number.isSafeInteger(round) ? { round } : {}),
      ...facts,
      ...(truncated === true ? { truncated: true } : {}),
    });
  }
  // 排序：`from` 升序（取不到排最后，实际已被上面剔除故都取得到）、同 `from` 按 `round` 升序（取不到当最小）。
  const fromRank = (item) => (Number.isSafeInteger(item.from) ? item.from : Number.POSITIVE_INFINITY);
  const roundRank = (item) => (Number.isSafeInteger(item.round) ? item.round : Number.NEGATIVE_INFINITY);
  foldItems.sort((a, b) => (fromRank(a) - fromRank(b)) || (roundRank(a) - roundRank(b)));
  // 去重：Map 按插入序（即 from 升序）保序，同 `(from,to)` 后写覆盖前写 ⇒ 留下的正是 round 最大那条。
  const byRange = new Map();
  for (const item of foldItems) byRange.set(`${item.from}:${item.to}`, item);
  const folds = [...byRange.values()];
  return {
    roundsWithRealSummary,
    foldedFactsByRound,
    compaction,
    skippedCompactionEntries: skipped,
    folds,
  };
}

/**
 * Build the existing message DTO from the official display projection plus message anchor metadata.
 * Synthetic rows (for example judge/wrapup injections) have no required transcript
 * text match yet, so their content intentionally remains sourced from the anchor.
 *
 * issue #283/#303：工具耗时回落（旧入参 `toolCallRows`）已退役——时长只来自引擎投影的
 * `toolCalls[].durationMs`，故本函数不再接受宿主耗时的行入参（传了也不参与，见 #303 清账）。
 *
 * 可选入参 `facts`：调用方已经跑过 `collectTranscriptFacts(transcriptRows)` 时把它传进来，
 * 本函数就不再自己扫一遍（`GET /api/sessions/:id` 正是这样：同一次扫描既喂投影、又喂
 * `session.compaction` 聚合——成本红线的落点）。不传 ⇒ 行为与以前逐字相同。
 */
export function projectSessionMessages({
  sessionId, anchors, userAnchors, transcriptRows, facts = null,
  // issue #243：终态带 `textualized_tool_call` 诊断的 run 集合（调用方按 run_id 提供，见 `sessions.js`）。
  // additive 可选参：缺省 / 非 Set ⇒ 空集 ⇒ DTO 不出现 `textualized_tool_call` 键（绝不透成 false）。
  textualizedRunIds = null,
}) {
  // 键缺席 = 不知道 / 没命中；命中才给布尔（与终局信封、`run_events` 诊断同一口径）。
  const textualizedRuns = textualizedRunIds instanceof Set ? textualizedRunIds : new Set();
  const users = [...userAnchors].sort((a, b) => Number(a.seq) - Number(b.seq));
  const userById = new Map(users.map((anchor) => [String(anchor.id), anchor]));
  const userAnchorsByText = new Map();
  // 非 `:input:` 行的内容匹配用：文本桶按 seq 升序 + 单调游标，避免每条候选反复扫描全部锚点
  // （历史快照一行可含十几条 user 文本，反复全量扫描会退化成 O(行数 × 锚点数)）。
  for (const anchor of users) {
    if (anchor.synthetic === true || typeof anchor.anchor_text !== 'string') continue;
    let queue = userAnchorsByText.get(anchor.anchor_text);
    if (!queue) {
      queue = { anchors: [], cursor: 0 };
      userAnchorsByText.set(anchor.anchor_text, queue);
    }
    queue.anchors.push(anchor);
  }
  const claimedUserAnchors = new Set();
  const claimUserAnchorByExactText = (text) => {
    const queue = userAnchorsByText.get(text);
    if (!queue) return null;
    while (queue.cursor < queue.anchors.length) {
      const anchor = queue.anchors[queue.cursor++];
      if (!claimedUserAnchors.has(String(anchor.id))) return anchor;
    }
    return null;
  };

  const runIds = new Set([
    ...users.map((anchor) => anchor.run_id),
    ...anchors.map((anchor) => anchor.run_id),
  ].filter((runId) => typeof runId === 'string' && runId.length > 0));
  const soleRunId = runIds.size === 1 ? runIds.values().next().value : null;
  const userContent = new Map();
  const assistantContent = new Map();
  const foldContent = new Map();
  // issue #188：DTO 是「一个 run 一条助手锚点」，而投影是「一轮一条助手 turn」——按 run 累积该 run
  // 全部助手轮的透传字段（toolCalls/blocks 逐元素拼接、reasoning 逐段收集，均在输出前保持上游原值）。
  const runToolCalls = new Map();
  const runReasoning = new Map();
  const runBlocks = new Map();
  // 0.16.0：轮级视图键（`turn.key`）逐字透传（与 toolCalls[].key 同源，后者是其前缀 + `:t<i>`）。
  const runTurnKeys = new Map();
  // issue #189：折叠轮元数据（按 run 收集，写法同 runToolCalls/runTurnKeys；后到行覆盖前行，与 foldContent 同语义）。
  const runFolded = new Map();
  // issue #283/#303：宿主自有的工具耗时回落已退役（#303）——时长只来自引擎投影的 toolCalls[].durationMs，
  // 故不再从本站 `tool_calls` 拼 durations 索引（旧回退路径与对应的 `toolCallRows` 入参一并删除）。
  let currentRunId = null;

  // #390-A：折叠行的真摘要按**折叠行自己的 round** 记账（`recordForProjection` 恒把 round 列合成进
  // record，所以 turn.round 与 row.round 必然同值，两边对得上）。只扫一遍入参行，无额外查询。
  //
  // #451（compactionStats 观测面）：这一趟扫描同时产出四份事实——`roundsWithRealSummary` /
  // `foldedFactsByRound` / `compaction`（压缩层聚合）/ `folds`（#816 第②步会话级折叠索引，由
  // `getSession` 挂到 `session.folds`；这里是同一趟扫描的**第四个消费者**，投影本身不消费它）。
  // **一趟扫描供四处消费**，聚合不另起一轮遍历、更不另发 SQL（成本红线：`GET /api/sessions/:id`
  // 对 `transcript_rounds` 的查询次数不变）。
  const resolvedFacts = facts ?? collectTranscriptFacts(transcriptRows);
  const roundsWithRealSummary = resolvedFacts.roundsWithRealSummary;
  const foldedFactsByRound = resolvedFacts.foldedFactsByRound;

  const setRunText = (runId, assistantText, foldText, turns) => {
    if (assistantText !== null) assistantContent.set(runId, assistantText);
    if (foldText !== null) foldContent.set(runId, foldText);
    const foldedFields = foldedTurnFields(turns, roundsWithRealSummary, foldedFactsByRound);
    if (foldedFields !== null) runFolded.set(runId, foldedFields);
    const fields = assistantTurnFields(turns);
    if (fields === null) return;
    if (fields.toolCalls !== null) {
      runToolCalls.set(runId, [...(runToolCalls.get(runId) ?? []), ...fields.toolCalls]);
    }
    if (fields.keys !== null) {
      runTurnKeys.set(runId, [...(runTurnKeys.get(runId) ?? []), ...fields.keys]);
    }
    if (fields.reasoning !== null) {
      runReasoning.set(runId, [...(runReasoning.get(runId) ?? []), fields.reasoning]);
    }
    if (fields.blocks !== null) {
      runBlocks.set(runId, [...(runBlocks.get(runId) ?? []), ...fields.blocks]);
    }
  };

  // issue #337（erix-agent 0.23.0 读侧折叠）：**折，且只在这里折**。
  // 0.23 一轮的正文落在 `kind:"message"` 行上（`<key>:msg:<round>:<seq>`），轮记录不再带 `messages`；
  // 本函数逐行喂投影，而消息行的 key 两个前缀都不是 ⇒ 会在下面的 `isSessionRound` 守卫处被整行丢弃
  // ⇒ 工具结果配不上对（刷新后卡片全退化成 `…`）。折叠把正文按轮拼回轮行，恢复 0.22 的投影输入形状。
  // 折在这里是因为它是**咽喉点**：全站两个业务调用方（`sessions.js#fetchSession` 的对话流、
  // `session-text.js#projectAnchors` 的取文本）都过它，一处接线不会「改了一个漏一个」。
  // 先排序再折：折叠保留存活行的相对顺序，所以载体行仍在它该在的位置上。
  // 无消息行的老账本（0.22 及更早）⇒ `foldTranscriptRows` 原样返回入参本身，输出逐字节不变。
  const foldedRows = foldTranscriptRows([...transcriptRows].sort(compareTranscriptRows), {
    recordOf: (row) => recordForProjection(row).record,
  });
  for (const row of foldedRows) {
    // 逐行调用官方投影：它是按记录独立展开的纯函数（整表调用只做「按 round 排序 + flatMap」），
    // 而本模块要把每个 turn 对应回它的 DB 行（`run_id` 归属、键名分段），行级调用是唯一稳定映射。
    const { record, dedupKey } = recordForProjection(row);
    const turns = projectTranscriptForDisplay([record]);
    // 注意：即使本行没产出可展示 turn（tool-only / 纯 tool_result 轮）也不能提前跳过——
    // 它的 dedupKey 仍参与 run 分段（否则后面的 session-scoped 行会失去归属）。
    const metaDedupKey = projectionDedupKey(turns) ?? dedupKey;
    const keys = attributionKeys(row, metaDedupKey);
    const messageId = inputMessageId(metaDedupKey, sessionId);
    const candidateUserTexts = userTurnTexts(turns);
    const lastUserText = candidateUserTexts.at(-1) ?? null;
    let matchedUserAnchor = null;

    if (messageId !== null) {
      // meta.dedupKey 精确映射（取代内容匹配启发式）：一个输入行只喂它自己的锚点。
      matchedUserAnchor = userById.get(messageId) ?? null;
      if (
        matchedUserAnchor
        && matchedUserAnchor.synthetic !== true
        && lastUserText !== null
        && !claimedUserAnchors.has(String(matchedUserAnchor.id))
      ) {
        const anchorId = String(matchedUserAnchor.id);
        claimedUserAnchors.add(anchorId);
        userContent.set(anchorId, lastUserText);
      }
    } else {
      // 无 messageId 的行（引擎轮/历史快照/seed）：按内容精确相等认领未认领锚点（seq 升序、认领一次）。
      for (const userText of candidateUserTexts) {
        const candidate = claimUserAnchorByExactText(userText);
        if (candidate) {
          matchedUserAnchor = candidate;
          const anchorId = String(candidate.id);
          claimedUserAnchors.add(anchorId);
          userContent.set(anchorId, userText);
        }
      }
    }

    const assistantText = assistantTurnText(turns);
    const foldText = foldedTurnText(turns);

    if (typeof row.run_id === 'string' && row.run_id.length > 0) {
      if (lastUserText !== null) currentRunId = row.run_id;
      setRunText(row.run_id, assistantText, foldText, turns);
      continue;
    }

    if (messageId !== null) {
      currentRunId = matchedUserAnchor?.run_id ?? null;
      continue;
    }

    const keyedRunId = recordRunId(keys, runIds);
    if (keyedRunId !== null) {
      currentRunId = keyedRunId;
    }

    const isSeed = keys.some((key) => key.endsWith(':seed'));
    if (isSeed) {
      if (matchedUserAnchor) currentRunId = matchedUserAnchor.run_id ?? null;
      continue;
    }

    const sessionRound = keyedRunId === null && isSessionRound(keys, sessionId);
    if (keyedRunId === null && !sessionRound) {
      continue;
    }

    // Real sessions showed migration-0015 input rows sorting after session rounds
    // by both round and created_at, leaving currentRunId unset. A sole anchored run
    // makes attribution of otherwise-unassigned session rounds unambiguous.
    if (!currentRunId && sessionRound && soleRunId !== null) {
      currentRunId = soleRunId;
    }
    if (!currentRunId) continue;
    setRunText(currentRunId, assistantText, foldText, turns);
  }

  const messages = anchors.map((anchor) => {
    let content = '';
    if (anchor.synthetic === true) {
      content = anchor.content;
    } else if (anchor.role === 'user') {
      const anchorId = String(anchor.id);
      if (userContent.has(anchorId)) {
        content = userContent.get(anchorId);
      }
    } else if (anchor.role === 'assistant') {
      if (assistantContent.has(anchor.run_id)) {
        content = assistantContent.get(anchor.run_id);
      } else if (foldContent.has(anchor.run_id)) {
        // issue #189：该 run 没有自身助手正文 → 折叠摘要兜底顶上（兜底行为不变；折叠标记见下方透传块）。
        content = foldContent.get(anchor.run_id);
      }
    }
    const dto = {
      id: anchor.id,
      run_id: anchor.run_id,
      seq: Number(anchor.seq),
      role: anchor.role,
      content,
      synthetic: anchor.synthetic,
      attachments: anchor.attachments ?? [],
      created_at: anchor.created_at?.toISOString?.() ?? anchor.created_at,
    };
    // issue #188：助手锚点透传上游投影字段（逐字、原名）。宿主独有的 UI 元数据（id/run_id/seq/
    // attachments/synthetic/created_at）保持 snake_case 且语义不变；这三项**有则出现、无则不写键**，
    // 不塞 undefined/null 占位。合成助手行（synthetic）正文来自锚点本身、不经 transcript 投影，故不透传。
    if (anchor.role === 'assistant' && anchor.synthetic !== true) {
      const toolCalls = runToolCalls.get(anchor.run_id);
      // issue #283/#303：时长只来自引擎投影的 toolCalls[].durationMs（#303 已删宿主回落）；
      // 这里只过一道防御性收尾（非有限的脏值剥键、不落 0），缺省即未知。
      if (toolCalls !== undefined) dto.toolCalls = attachToolCallDurations(toolCalls);
      const reasoning = runReasoning.get(anchor.run_id);
      if (reasoning !== undefined) dto.reasoning = reasoning.join('\n');
      const blocks = runBlocks.get(anchor.run_id);
      if (blocks !== undefined) dto.blocks = blocks;
      // 0.16.0 轮级视图键（`turn.key`，逐字透传；run 可聚合多轮 → 数组，与 toolCalls 同为「有则出现」）。
      const turnKeys = runTurnKeys.get(anchor.run_id);
      if (turnKeys !== undefined) dto.turnKeys = turnKeys;
      // issue #189 修正：只要有折叠轮就挂（无论正文是该 run 自身助手正文还是折叠摘要兜底——
      // 此前只挂兜底分支，正常 run 有正文时前端永远收不到「已压缩」标记）。
      // 上游三元组 + 折叠摘要原文（text），逐字透传；有则出现、无则不写键，同 toolCalls 规矩。
      const folded = runFolded.get(anchor.run_id);
      if (folded !== undefined) dto.folded = folded;
      // issue #243：这一轮的终局正文是**被文本化的工具调用**（模型把 tool call 吐进 content，run 仍正常
      // 结束）⇒ 给这条助手气泡挂一个**中性状态标记**（有则出现、无则不写键，同 toolCalls/folded 规矩，
      // 绝不写 false）。前端据此画「这条回复是机器标记，报告可能不完整」的状态词——不是报错。
      if (textualizedRuns.has(anchor.run_id)) dto.textualized_tool_call = true;
    }
    return dto;
  });

  return messages;
}
