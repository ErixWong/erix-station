// issue #392（E 片）→ issue #438 切片 B：**端到端**验「折叠 → 写注 → 注回到模型可见输入」这条链，
// 一环不许靠声称。
//
// 为什么单独立一片：A/B/C 三片各自的单测只证明自己那一段（选对策略 / 绑对作用域 / 投得出去）。
// 三片接起来有一个**任何一片都证不了**的命题：
//
//     引擎折掉 N 轮 → 宿主写下一条会话笔记 → 下一次喂给模型的请求里，这条笔记在不在？
//
// 本文件落地当天就抓到两件事，都是只有"跑一遍真引擎"才可能看见的：
//   ① **C 片原本是死光纤**：`onFoldSummary` 被塞进 `context`，而引擎从**顶层 options** 解构它
//      （`option-normalization.js` 的 `RUN_TOOL_LOOP_OPTION_NAMES`）。折叠照跑、`record.foldedFacts`
//      照落账、注**一条也不写**、且不报错。C 片自己的 13 条判据全绿——因为它们喂的是手工 payload。
//   ② 探针不能拿注的**正文第二句**去请求里找：引擎的 semantic 段渲染的是**小抄目录**
//      （`[notes 小抄目录]（note_read key=... 取全文）` + 每条一行 `key (@agent): 首行`），不是注全文
//      （全文塞回去等于把刚省下的预算再烧掉）。拿正文当探针会得出"注没回去"的**假红**。
//
// #438 切片 B 改了什么：生产策略从 `fold-statistical` 翻到 **`fold-llm`** ⇒ 本文件的现场也翻过来
// （**与生产同一个策略**，否则这一片证的是已经不存在的配置）。于是多了三条本片要证的「死代码变活」：
//   · 摘要由**真 provider 的摘要那一发**产出（桩 provider 按 system prompt 认出它，回一段可识别的
//     摘要正文）⇒ 注的正文/来源必须是 `llm` 形态，`foldedFacts.origin` 从 `mechanical` 变 `semantic`；
//   · `compaction` 事件里的 `strategyName` / `foldSummary.source` / `foldedRoundRange` 是**真折叠**的
//     形状（界面横幅与事件行读的就是这几个键）；
//   · 摘要器失败时引擎走**真降级**形态（`degradeKind`）⇒ 宿主的 A2 告警出口被真事件驱动一次。
//
// 现场构成：真 `runToolLoop` + 桩 provider（录下每一份请求）+ 内存 store + **真** notes 工厂与
// **真**投递器（落真临时目录）+ 引擎元数据从 `worker.js` 的 `#309:engine-model-params` 标记里抠出来
// 求值（与生产同一条装配式，技法同 `model-metadata.test.js`）。
// ⚠ 预算下界不是自由参数：引擎算 `budget = cw - maxOutput - max(2000, ⌈cw×比例⌉)`
//   （`src/compact/budget.js:23-25`），预留硬底 2000 ⇒ `cw: 900` 直接 `Computed context budget must be
//   positive (got -1300)`，四格空转。`cw: 6000` 是"够小所以必然折叠、又不至于被硬底打死"的取值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop, createMemoryTranscriptStore } from 'erix-agent';

import { createNotesTools } from '../lib/notes-tools.js';
import { createFoldNoteSink } from '../lib/fold-notes.js';
import { assertCompactContext } from '../lib/compact-knobs.js';
import { foldDegradeNotice } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');
const PARAMS_MARKERS = /\/\* #309:engine-model-params:start \*\/([\s\S]*?)\/\* #309:engine-model-params:end \*\//;

/**
 * 生产同一条元数据装配式（与 model-metadata.test.js 同款技法，不另抄字面量）。
 * erix-agent 0.28.0 起这一段住在 `config` 里（`config.metadata.modelMetadata` /
 * `config.tuning.maxTokens`，`task` 与前者同组）⇒ 求值时把它放回 `config` 对象内再返回。
 */
const TASK_TEXT = '继续收尾';
function workerEngineModelParams(engineModelMetadata) {
  const block = read('worker.js').match(PARAMS_MARKERS);
  assert.ok(block, 'worker.js 的 #309:engine-model-params 标记没了，本片失去被测对象');
  return new Function('engineModelMetadata', 'task', `return { config: {${block[1]}} };`)(
    engineModelMetadata, TASK_TEXT,
  );
}

/**
 * 折叠策略从 **worker.js 的真配置**里抠（与生产同一份，不另抄）：切片 B 翻成 `fold-llm` 之后，
 * 这里如果还写 `fold-statistical`，本文件证的就是一个已经不存在的配置。
 */
const CTX_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;
function workerFoldingContext() {
  const block = read('worker.js').match(CTX_MARKERS);
  assert.ok(block, 'worker.js 的 #392:context-strategy 标记没了');
  // 求值 worker 那段真代码（注入真校验器；与 fold-strategy.test.js 同一手法）
  return new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
}

/** 摘要那一发的可识别正文（用来在请求里认出「LLM 摘要真的进了上下文」）。 */
const SUMMARY_MARKER = '【LLM 摘要】已完成：把折叠策略切到 fold-llm；验证项 A/B/C 全过。';

/** 造 n 轮真形态历史（user → tool_use → tool_result），文本足够长以便真折得动。 */
function historyRounds(n) {
  const messages = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${i} 轮任务 ${'u'.repeat(500)}` }] });
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `h-t${i}`, name: 'noop', input: { round: i } }] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `h-t${i}`, content: `第 ${i} 轮结果 ${'r'.repeat(700)}` }] });
  }
  return messages;
}

/**
 * 桩 provider：录下每一份真实发出去的请求。
 *
 * ⚠ `fold-llm` 的摘要那一发**走同一个 provider**（`createProviderSummarizer` 用本 run 的 `chat`），
 * 所以必须按 **system prompt** 把它认出来单独回（引擎的摘要 system 文案首句是「你是对话历史压缩器」，
 * 见 `src/compact/provider-summarizer.js`）——否则摘要器会收到一条 `tool_use` 回复，被当成"摘要正文"
 * 落进上下文，本文件的所有断言就都在证一个假现场。
 *
 * `summarizer: 'throw'` / `'empty'` 用来造**真降级形态**（`degradeKind: timeout` / `empty_summary`）。
 */
function recordingProvider({ toolCalls = 5, summarizer = 'ok' } = {}) {
  const requests = [];
  const mainRequests = [];
  const summarizerRequests = [];
  return {
    requests,
    mainRequests,
    summarizerRequests,
    async chat(request) {
      requests.push(request);
      const isSummarizer = typeof request?.system === 'string' && request.system.includes('对话历史压缩器');
      if (isSummarizer) {
        summarizerRequests.push(request);
        if (summarizer === 'throw') {
          throw Object.assign(new Error('summarizer timed out'), { code: 'summarizer_timeout' });
        }
        if (summarizer === 'empty') {
          return { content: [{ type: 'text', text: '   ' }], stopReason: 'end_turn' };
        }
        return {
          content: [{ type: 'text', text: SUMMARY_MARKER }],
          stopReason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20 },
        };
      }
      mainRequests.push(request);
      return mainRequests.length <= toolCalls
        ? { content: [{ type: 'tool_use', id: `c${mainRequests.length}`, name: 'noop', input: {} }], stopReason: 'tool_use' }
        : { content: [{ type: 'text', text: '收尾：无新工具调用' }], stopReason: 'end_turn' };
    },
  };
}

/**
 * 一次完整现场。`semanticEnabled: false` 用来做 E5 的对照组（不接 semanticStateProvider）。
 * 返回里带 `semantic`（provider 被调次数与返回值）——归因要靠它，不能只看"请求里有注"。
 * `events` 是**真 `onEvent`** 收到的事件流（M3.2/M3.3 要的是引擎真发的形状，不是手写的）。
 */
async function runFoldingScene({ semanticEnabled = true, summarizer = 'ok' } = {}) {
  const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fold-e2e-'));
  const sessionId = 'sess-e2e-1';
  const noteTools = await createNotesTools({ scopeRef: sessionId, notesDir });
  const deliveries = [];
  const sink = createFoldNoteSink({ noteTools, runId: 'run-e2e', onDeliveryError: (e) => deliveries.push(e) });
  const provider = recordingProvider({ summarizer });
  const store = createMemoryTranscriptStore();
  const semantic = { calls: 0, returns: [] };
  const events = [];
  const semanticStateProvider = async (arg) => {
    semantic.calls += 1;
    const r = await noteTools.semanticStateProvider(arg);
    semantic.returns.push(r);
    return r;
  };

  const result = await runToolLoop({
    provider,
    store,
    executeTool: async () => 'noop 结果',
    ...(semanticEnabled ? { semanticStateProvider } : {}),
    // ⚠ **顶层**选项：引擎从 options 解构 `onFoldSummary`，折叠壳（`config.folding.context`）
    // 里只认数据键。塞错一层就是本文件头注释里那条死光纤。
    onFoldSummary: sink.onFoldSummary,
    // 真 `onEvent`（与 worker.js 同一条通道）：M3.2/M3.3 的判据吃的是引擎真发的形状。
    onEvent: (event) => { events.push(event); },
    // erix-agent 0.28.0：数据只能写进 `config.<组>.<叶>`（扁平 `runId` / `maxRounds` /
    // `completion` / `initialMessages` / `initialUserMessage` / `context` 现在启动期就抛；
    // `initialMessages` 的叶子名是 `config.input.messages`，唯一登记过的别名）。
    config: {
      input: {
        messages: historyRounds(14),
        initialUserMessage: '继续收尾',
      },
      run: { runId: sessionId, maxRounds: 8, completion: false },
      // **与生产同一份 context**（策略名与尾窗都从 worker.js 抠）
      folding: { context: workerFoldingContext() },
      // 生产同一条元数据装配式（metadata / tuning 两组）
      ...workerEngineModelParams({ context_window: 6000, max_output_tokens: 200 }).config,
    },
  });

  const requestsText = provider.requests.map((r) => JSON.stringify(r ?? {}));
  const notesFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.json')) notesFiles.push(p);
    }
  };
  walk(notesDir);
  const records = await store.load(sessionId);
  const compactionEvents = events.filter((e) => e?.type === 'compaction');
  return {
    result, requestsText, notesFiles, deliveries, sink, notesDir, records, sessionId, semantic,
    events, compactionEvents, provider,
  };
}

const foldNoteFile = (files) => files.find((p) => /\/fold-[^/]+\.json$/.test(p));

// ── E1 前置：折叠在这个 run 里**真的发生了**，且喂给模型的是 **LLM 摘要**（不是降级/机械） ──
test('E1 小预算 + fold-llm：run 里真发生了折叠，模型看见的是 LLM 摘要（不是降级、不是机械替代物）', async () => {
  const { requestsText, provider } = await runFoldingScene();
  assert.ok(provider.summarizerRequests.length >= 1,
    `摘要器一次都没被调用（实得 ${provider.summarizerRequests.length}）⇒ 折叠走的是机械路径或根本没折`);
  assert.ok(requestsText.length >= 2, `桩 run 至少要有两次请求（实得 ${requestsText.length}）`);
  const summarizedAt = requestsText.findIndex((t, i) => i >= 1 && t.includes(SUMMARY_MARKER));
  assert.ok(summarizedAt >= 0,
    '从第 2 份请求起没有任何 LLM 摘要正文 ⇒ 摘要没进上下文（折叠对模型等于没发生），下游断言全部失去对象');
  assert.doesNotMatch(requestsText[summarizedAt], /摘要失败，已降级为统计摘要/,
    '摘要器明明回了正文，上下文里却是降级标记 ⇒ 这条路上 fold-llm 没真跑');
});

// ── E2 折一次记一次：注由**真折叠**写出，落会话作用域，形态是 llm ────────────────────
test('E2 真折叠真的写出了注（不是手工喂 payload），llm 形态：来源/策略/字节都对', async () => {
  const { notesFiles, sessionId, sink } = await runFoldingScene();
  assert.ok(sink.seq() >= 1, `引擎必须真调用过 onFoldSummary（实得 seq=${sink.seq()}）——`
    + '这一格就是当初那条死光纤：折叠照跑、回调零次、不报错');
  assert.ok(notesFiles.length >= 1, `notes 目录里应至少有一条注（实得 0）`);
  const file = foldNoteFile(notesFiles);
  assert.ok(file && file.includes(sessionId),
    `注必须落在 <notesDir>/run/<sessionId>/fold-*.json：${notesFiles.join(', ')}`);
  assert.match(path.basename(file), /^fold-\d{8}T\d{6}Z-r[^-]+-s\d+\.json$/,
    'key 必须可读、可排序，且过 store 的 SAFE_KEY（不过就被哈希成 h<digest>，顺序读不出来）');

  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.scopeRef, sessionId, '作用域是会话——run 作用域下下一个 run 一行也读不到（B 片病根）');
  // #438 切片 B：来源轴从 `statistical` 变 `llm`（deriveFoldNote 的 tags 由 payload.source 派生）
  assert.deepEqual(rec.tags, ['fold', 'src:llm'],
    `来源轴必须是 llm（实得 ${JSON.stringify(rec.tags)}）⇒ 说明注还是按 mechanical 形态写的`);
  assert.equal(rec.pinned, false);
  assert.match(rec.current.content, /折走存档/);
  assert.match(rec.current.content, /来源 llm/, '注正文的「来源」段必须写 llm（不是 statistical）');
  assert.match(rec.current.content, /策略 fold-llm/, '还要写引擎策略名（#392-D 同一个口径）');
  // C15/C18 的 bytes 主口径在 llm 形态下**仍然成立**（引擎给的是 bytes，不是 chars）
  assert.match(rec.current.content, /摘掉正文 \d+ B/,
    '规模段必须用引擎真给的 bytes：llm 形态下这条口径不许退化成「规模未知」');
  assert.doesNotMatch(rec.current.content, /规模未知|\? B/, 'llm 形态下不该丢规模');
});

// ── E3 投递失败不打死 run（真折叠路径下同样成立） ────────────────────────────────
test('E3 真折叠路径下不该有投递失败，且 run 正常跑完', async () => {
  const { result, deliveries, notesFiles } = await runFoldingScene();
  assert.equal(deliveries.length, 0, `不该有投递失败：${JSON.stringify(deliveries)}`);
  assert.ok(notesFiles.length >= 1);
  assert.ok(result, 'run 必须正常返回（注是台账，失败也不该把 run 打死——见 fold-notes.test.js C8）');
});

// ── E4 闭环：注回到模型可见输入 ─────────────────────────────────────────────────
test('E4 【闭环】折叠写出的注必须出现在喂给模型的请求里（以引擎的 notes 小抄形态）', async () => {
  const { requestsText, notesFiles, semantic } = await runFoldingScene();
  const note = JSON.parse(fs.readFileSync(foldNoteFile(notesFiles), 'utf8'));
  assert.match(note.current.content, /折走存档/);

  // 探针只取**小抄行里有的东西**（`折走存档` 是注的首行，会进小抄；正文第二句不会）。
  assert.ok(requestsText.some((t) => t.includes('折走存档')),
    '注写出来了，但没有任何一份喂给模型的请求里有它 ⇒ 折叠丢的东西只有人能捡回、模型捡不回，'
    + '那就只是台账，不是闭环');
  assert.ok(requestsText.some((t) => t.includes('note_read')),
    '请求里必须带 `note_read key=…` 的取全文指引，否则模型只知道有注、拿不到注内容');
  assert.ok(semantic.calls >= 1, 'semanticStateProvider 必须真被引擎调用过（没调用 = 闭环根本没启动）');
  assert.ok(semantic.returns.some((r) => typeof r?.text === 'string' && r.text.includes('折走存档')),
    '宿主侧 provider 必须把那条折叠注渲染进小抄');
});

// ── E5 对照组：证明 E4 不是白绿 ─────────────────────────────────────────────────
test('E5 不接 semanticStateProvider 时注仍在盘上、但进不了模型输入（E4 的归因靠本格兜住）', async () => {
  const { requestsText, notesFiles } = await runFoldingScene({ semanticEnabled: false });
  assert.ok(foldNoteFile(notesFiles), '关掉 semantic 不该影响写注：投递与注入是两件事');
  assert.ok(!requestsText.some((t) => t.includes('折走存档')),
    '不接 provider 却还能在请求里看到注 ⇒ 注是从别的渠道进来的（例如折叠消息本身），E4 的归因就错了');
});

// ── E6 折叠事实同时进轮记录（引擎 #470-B/#470-D 两路都得在），且 origin 是 semantic ──
test('E6 轮记录里的 foldedFacts：text 有料，且 origin 从 mechanical 变成 semantic（llm 形态）', async () => {
  const { records } = await runFoldingScene();
  const withFacts = records.filter((r) => r?.foldedFacts?.text);
  assert.ok(withFacts.length >= 1,
    '轮记录里没有任何 foldedFacts ⇒ 账本又变回"折了但说不出折了什么"（#470-B 的回退）');
  const facts = withFacts[0].foldedFacts;
  // `resolveFactsOrigin`：`source: "llm"` ⇒ `semantic`（`ORIGIN_BY_SOURCE`，0.29.0
  // `src/compact/fold-summary-journal.js`）。**不是**字面量 "llm"——本片要钉的是"不再是 mechanical"。
  assert.equal(facts.origin, 'semantic',
    `foldedFacts.origin 应为 semantic（实得 ${JSON.stringify(facts.origin)}）⇒ `
    + '说明折叠仍走 mechanical（fold-statistical）那条路，本片的三处「死代码」也就没变活');
  assert.match(facts.text, /【LLM 摘要】/,
    '事实正文必须来自 LLM 摘要（降级时才会变成机械替代物）');
  assert.equal(facts.strategy, 'fold-llm');
});

// ── E7（M3.2 runner 半边）：真 compaction 事件里的策略名与摘要诊断面 ─────────────────
test('E7 真折叠发出的 compaction 事件：strategyName=fold-llm，且 foldSummary 只带诊断键', async () => {
  const { compactionEvents } = await runFoldingScene();
  assert.ok(compactionEvents.length >= 1, '这一跑里没有任何 compaction 事件 ⇒ 折叠没发生，界面横幅也没有数据源');
  const stat = compactionEvents[0].compaction;
  assert.equal(stat.strategyName, 'fold-llm',
    `事件里的实例策略名应为 fold-llm（实得 ${JSON.stringify(stat.strategyName)}）——`
    + '界面那一行「策略 fold-llm」读的就是这个键（`useEventStream.ts` 的 compaction 分支）');
  assert.ok(stat.foldedRounds >= 1);
  assert.ok(stat.tokensAfter < stat.tokensBefore, '折叠必须真的把 token 降下来（否则本条是空断言）');
  assert.equal(stat.layers?.foldLlm?.triggered, 1,
    'layers.foldLlm 必须被点亮（这是「跑的是 fold-llm 而不是统计折叠」的机读信号）');
  // ⚠ 引擎**故意**不把 `source` 放进事件里的 `foldSummary`（`compact/pipeline.js:228-232`：
  //   “只收诊断信号，`source` 不算——它已在轮记录 `foldedFacts.source` 上，再进一份只会把既有精确
  //   断言洗脏”）。所以这里钉的是**「不许在本站代码里读事件上的 foldSummary.source」**——
  //   读了就是第二个 `unshrinkable`（永不触发的推测键）。`source` 在 E6 的 foldedFacts 上验。
  assert.equal(Object.hasOwn(stat.foldSummary ?? {}, 'source'), false,
    '事件里的 foldSummary 出现了 source ⇒ 上游改了投影口径，本站读 source 的地方要重新核（包括本文件的 E6）');
  assert.equal(stat.foldSummary?.degradeKind, undefined, '摘要成功了却带着 degradeKind ⇒ 现场不干净');
  // A2 出口：摘要**成功**时绝不能报 `degraded=`（那会把每一条正常折叠都刷成降级）。
  // ⚠ 本现场（6k 窗口）里摘要输入会被 token 守卫裁（`droppedMessages: 21`）——那是**真事实**，
  //   出口报 `input clipped` 是对的；这里只钉「不许把成功说成降级」。
  const notice = foldDegradeNotice(stat);
  assert.doesNotMatch(notice ?? '', /degraded=/,
    `摘要成功却报了 degraded= ⇒ 界面上「有 LLM 摘要」与「降级」分不开：${notice}`);
  assert.equal(stat.foldSummary?.inputTruncated, true,
    '本现场（cw 6000 / keepRounds 6）摘要输入必被裁；若上游改成不裁，这里的口径要重核');
});

// ── E8（M3.3）：真 degrade 形态驱动 A2 的两个出口（runner LOG + 前端横幅后缀） ─────────
test('E8 摘要器真失败 ⇒ 引擎发出 degradeKind 形态，A2 出口被真事件驱动（不是喂字面量）', async () => {
  // 两形态各跑一次，都是**真 provider 行为**逼出来的：
  //   · `timeout`：摘要那一发抛 `summarizer_timeout`（`classifyFoldDegradeKind` 的封闭枚举值）；
  //   · `error`：摘要器回空文本 —— ⚠ 实测口径：走**引擎默认 provider 摘要器**时它先抛自己的
  //     `default fold-llm summarizer returned no text`（不带 `summarizer_empty_summary` 码），
  //     所以分类是 `error` 而**不是** `empty_summary`；后者只在宿主注入的 summarizer 直接返回空串时
  //     才可达（`assertUsableSummary`）。本片按真链路的形状钉。
  for (const [summarizer, expected] of [['throw', 'timeout'], ['empty', 'error']]) {
    const { compactionEvents, records } = await runFoldingScene({ summarizer });
    assert.ok(compactionEvents.length >= 1, `${expected}: 折叠没发生，本格失去对象`);
    const stat = compactionEvents[0].compaction;
    assert.equal(stat.foldSummary?.degradeKind, expected,
      `${expected}: 引擎给的原因分类应与桩 provider 造的一致（实得 ${JSON.stringify(stat.foldSummary?.degradeKind)}）`);
    // 降级事实的另一半在轮记录上：`foldedFacts.source` 退回 statistical（⇒ origin = mechanical）
    const facts = records.map((r) => r?.foldedFacts).find((f) => f?.text);
    assert.ok(facts, `${expected}: 降级时仍应有 foldedFacts（机械替代物）`);
    assert.equal(facts.source, 'statistical',
      `${expected}: 降级时 source 必须退回 statistical（否则「有 LLM 摘要」是假的）`);
    assert.equal(facts.origin, 'mechanical',
      `${expected}: 降级时 origin 应退回 mechanical（E6 是它的正向对照）`);
    // A2 的 runner 出口：真事件 → 真告警
    const notice = foldDegradeNotice(stat);
    assert.ok(notice, `${expected}: 真降级形态必须让 foldDegradeNotice 出声（否则「降级了」与「没降级」在日志里一样）`);
    assert.match(notice, new RegExp(`degraded=${expected}`));
    assert.match(notice, /strategy=fold-llm/);
    // 降级是**事实**不是终局：run 照旧跑完、注照旧写出（模型拿到的仍是机械摘要）
    assert.ok(records.length >= 1, `${expected}: 降级不该让 run 没有轮记录`);
  }
});

// ── E9：本文件的桩 provider 靠**引擎摘要 system 文案**认出「摘要那一发」 ─────────────
// 为什么需要这一格：`isSummarizer` 是本片 M3 全部判据的地基（认错了就会把 `tool_use` 回复当成摘要
// 正文落进上下文，于是 E1/E2/E6/E7 全部在证一个假现场，而且是**静默**的——它们都会绿）。
// 桩里只能硬编码那句文案，所以必须有一条判据钉住「引擎源码里确实还是这句」：上游改文案 ⇒ 本格红，
// 提示同时重核本文件与 `portal/test/session-view-fold.test.js` 两处 `isSummarizer`。
// 这条与 E8 同族（§8.73 的 A2 出口也是「真事件驱动」而不是喂字面量），区别是它钉的是**夹具保真**。
test('E9 夹具保真：桩 provider 的摘要识别文案必须仍与已安装引擎一致（引擎改文案 ⇒ 本格红）', () => {
  const entry = fileURLToPath(import.meta.resolve('erix-agent'));
  let root = path.dirname(entry);
  while (root !== path.dirname(root)) {
    const pj = path.join(root, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') break;
    root = path.dirname(root);
  }
  const summarizerSrc = path.join(root, 'src', 'compact', 'provider-summarizer.js');
  assert.ok(fs.existsSync(summarizerSrc), `引擎里没有 ${summarizerSrc}（摘要器搬家了 ⇒ 本文件与 session-view-fold 的桩都要重写）`);
  const src = fs.readFileSync(summarizerSrc, 'utf8');
  // 判据不是「抄一份文案」，而是「桩用的那段子串必须仍在引擎的 DEFAULT_SUMMARY_SYSTEM 里」
  const probe = '对话历史压缩器';
  assert.match(src, /DEFAULT_SUMMARY_SYSTEM\s*=/,
    '引擎不再用 DEFAULT_SUMMARY_SYSTEM 这个常量命名摘要 system ⇒ 请重核本文件的识别姿势');
  assert.ok(src.includes(probe),
    `引擎的摘要 system 文案里已经没有「${probe}」⇒ 本文件的 isSummarizer 会认不出摘要那一发，`
    + 'E1/E2/E6/E7 会静默变成假绿。修法：改本文件与 portal/test/session-view-fold.test.js 两处识别串');
  // 反向：本文件的桩**确实**用了这段子串（防止有人改了桩却留下这条判据自证）
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(self.includes(`includes('${probe}')`),
    `本文件的 isSummarizer 不再用「${probe}」识别摘要那一发 ⇒ 这条判据已失去对象，请重写`);
});
