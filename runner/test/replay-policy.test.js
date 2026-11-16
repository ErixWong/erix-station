// issue #288（缺陷 C）「崩溃恢复时盲目重放有副作用的工具」的 runner 侧回归锁。
//
// 缺陷本体（dev 真机标本）：一条 `sleep 360` 的 shell 被 watchdog 杀掉后，resume 把**同一个
// `tool_use` 从头再执行一遍**（`run_events` 里同 `call_id` 出现 3 条 `tool_use`）。非幂等命令
// （kill 旧进程、重启 backend/vite、重跑测试）每轮真的再掀一次桌。
//
// 为什么这里的断言必须跑**真引擎**而不是 mock：判据是「引擎在 resume 时到底有没有调 executor」，
// mock 出来的只是我对引擎的想象。技法与 test/tool-result-envelope-contract.test.js 同款：
// 桩 provider + 内存 store + 真 `runToolLoop`，零 LLM/DB/网络。
//
// ─────────────────────────────────────────────────────────────────────────────
// erix-agent 0.33.0（issue #530 / 工单 feat-261115-08）：现场造法从**快照**换成**账本**
// ─────────────────────────────────────────────────────────────────────────────
// 0.32.0 及以前，这个现场是靠 run snapshot 造的：引擎在调 executor **之前**把快照落盘，所以
// 「executor 里 abort」= 「快照里有 pendingToolUses、账本里没有 tool_result」。0.33.0 上游 #838 S2
// 把 run snapshot 整个退役（引擎不再读写 `<runId>.snapshot.json`、不再调 `saveRunSnapshot` /
// `loadLatestRunSnapshot`），**恢复只靠账本**（`orchestrator.js:3221` 原文：「恢复只信账本，
// 不再依赖 run snapshot 兜底」）⇒ 旧夹具那两个快照方法从此没人调，现场改由账本自证：
// 第 1 轮 assistant 的 `tool_use` 随轮记录入账，然后在 `executeTool` 里 `abort()`
// ⇒ 「`tool_use` 已入账、`tool_result` 未落」，与真机崩溃同形。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠⚠ 本版最重要的一条结论（别让后来者读反）
// ─────────────────────────────────────────────────────────────────────────────
// **【#500 之前的历史结论，保留原文别删】在 0.33.0 + 当时本站能力面（`runner/lib/store.js`
// 那 5 个方法）上，`run.replayPolicy` 已经无可观测效果**——传 `per-tool-declaration` 与传
// `always-replay`，resume 期 executor 都是 0 次（261115 在装着的 0.33.0 上实测，两个变体逐字相同）。
//
// **本单（#500）把三件套接上之后这条前提已经不成立了**：`makeStore()` 现在带着
// `appendRecoveryRow` / `listRecoveryRows` / `clearRecoveryRows`（生产代码，不是夹具），
// `replayPolicy` 重新有牙。本文件里 `recoveryRows: false` 那一组现在读作
// **「#500 之前的本站」**（历史形态对照），`recoveryRows: true` 那一组读作**现况**；
// 两组断言都原样留着——留着不是为了怀旧，是因为「没有证据时不重放」这条保护
// 在两种形态下都必须成立（只是**理由**不同，见下面 ①②③）。
//
// 根因（源码，不是猜测）：`resume-manager.js:837-853`
//   `ctx.resumePendingTools = pendingTools.filter((t) => replayableToolUses.has(t))`，
// 而 `replayableToolUses` 只有在**同批更早的一个 `tool_use` 被判定为已完成**时才纳入后面缺失的那些；
// 那个判定读的是 `ctx.resumeExecutedToolIds`，它的唯一来源是账本的 `tool-executed` **恢复行**
// （`readExecutedToolIdRecoveryRows`）。**#500 之前**本站没有恢复行，而 0.33.0 起**不再回落快照**
// ⇒ `resumeExecutedToolIds` 恒空 ⇒ `resumePendingTools` 恒空 ⇒ `orchestrator.js:5208` 里那个读
// `replayPolicy` 的分支根本进不去。——**这一段现在是历史**（三件套已在 `runner/lib/store.js`），
// 它解释的是「为什么当年那组断言恒绿」，不是今天的现场；今天的现场见
// `runner/test/recovery-rows-adapter.test.js` 第 ④ 组（有证据 / 无证据两条文案必须不同）。
//
// 所以 #288 的保护现在来自**引擎自己那条「无证据就不重放」**（`resume-manager.js:849-851`：
// 「Without positive progress evidence, an unpaired call is unknown rather than safe to replay」），
// **不是**来自本站传的这个 flag。⇒ 三条不许读错：
//   ① 不许据此说「本站已经不需要传这个值了」——**值仍要显式传**：默认值属于上游，上游已经改过一次
//      （0.32 的 `always-replay` → 0.33 的 `per-tool-declaration`），它还会再改；
//   ② #500 已接完（三件套在 `runner/lib/store.js` 里），所以这条现在读作「**别把下面那组
//      `recoveryRows: false` 的恒绿当成本单未做**」——它钉的是历史形态，不是今天的本站；
//   ③ 下面「反面对照」那组之所以要在**夹具里**给恢复行，就是因为只有给了证据，「重放」这件事
//      才在这套 harness 里重新可见，才能证明主用例不是恒绿的空断言。
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠ 变异口径已改（比用例本身重要）
// ─────────────────────────────────────────────────────────────────────────────
// 旧口径：删掉 `worker.js` 里 `replayPolicy: '…'` 那一行 ⇒ 引擎回落默认 `always-replay` ⇒ 主用例变红。
// **这条老变异在 0.33.0 上结构性失效**：`orchestrator.js:804` 的默认值现在就是 `per-tool-declaration`，
// 删行与不删**等价**（不是我们把闸弄松了）。现在靠两条替代判据：
//   ① **源码钉**：`workerReplayPolicy()` 必须逐字等于 `'per-tool-declaration'`
//      —— 删掉那行 ⇒ 取到 `undefined` ⇒ `test ①` 当场红。这是唯一能抓住「删行」的判据。
//   ② **行为钉**：把 worker.js 的值改成 `'always-replay'` ⇒ 在**带恢复行的夹具**上，
//      由 `workerReplayPolicy()` 驱动的那条主口径必须红（第二条 `tool_use` 真的被重放）。
// `workerReplayPolicy()` 仍从 worker.js **源码里抠**，测试里不另抄字面量（否则这两条变异都测不出）。
//
// ⚠ 「摘掉 shell 的 `replay` 声明」这条变异**行为上不会变红**，这是引擎语义而非测试漏洞：
//   `orchestrator.js` 的判据是 `definition?.replay === "safe" ? "safe" : "unsafe"`
//   ⇒ **未标注同样落 `"unsafe"`**。所以下面用 `test('…显式声明…')` 单独钉「声明必须在」，
//   并用 `test('…replay:"safe"…')` 钉住真正能红的方向（改成 safe ⇒ 真的重放 ⇒ 主口径变红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runToolLoop } from 'erix-agent';
import { createShellTools } from '../lib/shell-tools.js';
import { createStationFileTools } from '../lib/file-tools.js';
import { loopEventPayload } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRANSCRIPT_KEY = 'sess-replay-1'; // 引擎 store key = transcriptKey = sessionId（issue #81 P2）
const PENDING_CALL_ID = 'call-shell-1';
const DONE_CALL_ID = 'call-shell-0'; // 反面对照夹具里「先完成的那一条」（提供正向进度证据）

const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

/**
 * 从 worker.js 抠出**真传给 runToolLoop 的** `replayPolicy` 值。
 * 只认 `replayPolicy: '<literal>'` 形态（注释里写的是 `replayPolicy === "..."`，不带冒号，不会误命中）。
 * 没传 ⇒ 返回 undefined（= 变异「删掉那行」的真实后果，由 test ① 当场判红，测试不替它兜底）。
 */
function workerReplayPolicy() {
  const hits = read('worker.js').match(/\breplayPolicy\s*:\s*(['"])([^'"]+)\1/g) ?? [];
  assert.ok(hits.length <= 1,
    `worker.js 只应有一处 replayPolicy 传参（多份 = 出现第二个 runToolLoop 调用点或漏改，实际=${hits.length}）`);
  const matched = hits[0]?.match(/\breplayPolicy\s*:\s*(['"])([^'"]+)\1/);
  return matched ? matched[2] : undefined;
}

// ---------------------------------------------------------------------------
// 现场装配：内存 store + 桩 provider
// ---------------------------------------------------------------------------

/**
 * 内存 store。两种形态，差别**只有一处**：是否带账本恢复行三件套。
 *
 * · `recoveryRows: false` = **#500 之前的本站**（历史形态对照）：只有 `appendRound` / `load` /
 *   `saveRunState` / `loadRunState` / `markRunState` 这 5 个。
 *   0.33.0 起引擎不再调快照方法 ⇒ **这里不再实现 `saveRunSnapshot` / `loadLatestRunSnapshot`**
 *   （实现了也没人调，留着只会让人以为恢复还靠快照）。主用例全部跑在这个形态上。
 *
 * · `recoveryRows: true` = **现况（#500 已接）+ 反面对照**。三件套在 `runner/lib/store.js`
 *   里是真的（生产代码），这里给的是同一格的内存版，作用是「给引擎它做重放判定所需要的证据」
 *   （`resume-manager.js` 读 `tool-executed` 行才认「同批前一条已完成」，缺失项一律按「无证据」
 *   不重放）。没有这份证据，「重放」在这套 harness 里根本不可能发生，反面对照会退化成恒绿空断言。
 */
function makeStore({ recoveryRows = false } = {}) {
  const records = new Map();
  const rows = [];
  const store = {
    // 轮记录**按到场顺序**保存：引擎读侧靠 `foldLedgerMessages` 按到场顺序折消息，
    // 这里只回原序（同轮多条消息的分片行有自己的 kind/seq，不能按 round 重排）。
    async appendRound(key, record) {
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
    },
    async load(key) {
      return [...(records.get(key) ?? [])];
    },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
    // ── 仅夹具：账本恢复行通道（0.33.0 `src/store/recovery-rows.js`）──
    ...(recoveryRows ? {
      async appendRecoveryRow(key, record) { rows.push(record); },
      async listRecoveryRows() { return [...rows]; },
      async clearRecoveryRows() { rows.length = 0; },
    } : {}),
  };
  return { store, recoveryRowsWritten: rows };
}

/**
 * 造一次「工具挂起」崩溃。
 *
 * @param {Array} tools               工具面
 * @param {string} replayPolicy       真值来自 `workerReplayPolicy()`（变异敏感性所在）
 * @param {string} toolName           批次里每条 `tool_use` 用哪个工具
 * @param {string[]} callIds          批次里的 `tool_use` id，**按执行顺序**；最后一个是要挂起的那条。
 *                                    主用例给 1 个（本站现场）；反面对照夹具给 2 个（前一条真的跑完并
 *                                    留下 `tool-executed` 证据，后一条缺失 ⇒ 这是 0.33.0 上唯一能让
 *                                    `resumePendingTools` 非空的形状）。
 * @param {boolean} recoveryRows      见 `makeStore`：只有夹具才带恢复行。
 */
async function crashWithPendingTool({ tools, replayPolicy, toolName, callIds, recoveryRows = false }) {
  const { store, recoveryRowsWritten } = makeStore({ recoveryRows });
  const abort = new AbortController();
  const executedDuringCrash = [];
  const last = callIds[callIds.length - 1];
  await runToolLoop({
    provider: {
      async chat() {
        return {
          content: callIds.map((id) => ({ type: 'tool_use', id, name: toolName, input: { command: 'sleep 360' } })),
          stopReason: 'tool_use',
        };
      },
    },
    tools,
    store,
    // erix-agent 0.28.0：数据只能写进 `config.<组>.<叶>`（扁平键现在启动期就抛）。
    // `replayPolicy` 的值仍是 `workerReplayPolicy()` 从 worker.js 源码里抠出来的真值。
    config: {
      input: { initialUserMessage: 'go' },
      run: { runId: TRANSCRIPT_KEY, resume: false, maxRounds: 8, completion: false, replayPolicy },
    },
    executeTool: async (options) => {
      executedDuringCrash.push(options.id);
      if (options.id !== last) return 'earlier call completed'; // 夹具里前一条真跑完（并留下恢复行）
      abort.abort(); // 命令还在跑就被宿主叫停（watchdog 误杀 / SIGKILL 的等价形态）
      return 'outcome never recorded';
    },
    signal: abort.signal,
  }).catch(() => {}); // abort 让 run 以 AbortError 收场 = 崩溃语义，正是我们要的现场
  return { store, executedDuringCrash, recoveryRowsWritten };
}

/** 从挂起态 resume，返回 resume 期的 executor 调用、LoopEvent 与模型看到的块。 */
async function resumeFromPending({ store, tools, replayPolicy }) {
  const provider = {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      // resume 趟直接收尾：不再要工具 ⇒ resume 期出现的 executor 调用**只可能是盲目重放**。
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
  const resumeExecuted = [];
  const events = [];
  const result = await runToolLoop({
    provider,
    tools,
    store,
    config: { run: { runId: TRANSCRIPT_KEY, resume: true, maxRounds: 8, completion: false, replayPolicy } },
    executeTool: async (options) => {
      resumeExecuted.push(options.id);
      return 'REPLAYED BY ENGINE';
    },
    onEvent: (event) => events.push(event),
  }).catch((error) => ({ error }));
  const modelBlocks = (provider.requests[0]?.messages ?? [])
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []));
  return {
    resumeExecuted,
    events,
    modelBlocks,
    finalText: result?.finalText,
    result,
    decisionEvents: events.filter((e) => e?.type === 'tool_replay_decision_required'),
    toolResultEvents: events.filter((e) => e?.type === 'tool_result').map((e) => e.toolResult),
  };
}

const shellSchema = () => createShellTools({ worktreeRoot: RUNNER_DIR }).schemas[0];
const fileSchemas = () => createStationFileTools({ jail: { root: RUNNER_DIR }, cwd: RUNNER_DIR }).schemas;

// ---------------------------------------------------------------------------
// 0. 变异敏感性：两条替代判据（见文件头「变异口径已改」）
// ---------------------------------------------------------------------------

/**
 * 判据 ①（源码钉）。这是 0.33.0 上**唯一**能抓住「删掉 worker.js 那行」的判据：
 * 删行 ⇒ `workerReplayPolicy()` 取到 `undefined` ⇒ 本条红。
 * 行为面抓不到它（默认值已经等于本站要传的值，见文件头）。
 */
test('#288/#530 判据①：worker.js 必须**显式**传 replayPolicy: "per-tool-declaration"（删掉那行就红）', () => {
  assert.equal(workerReplayPolicy(), 'per-tool-declaration',
    'worker.js 必须逐字写着 `replayPolicy: "per-tool-declaration"`。'
    + `实得：${JSON.stringify(workerReplayPolicy())}。`
    + '⚠ 0.33.0 起引擎默认值**已经就是**这个（orchestrator.js:804），所以删行在行为上抓不到——'
    + '但默认值属于上游（0.32 那版还是 always-replay，上游已经改过一次口），本站必须显式钉住自己的口径');
});

/**
 * 判据 ②（行为钉）：把 worker.js 的值换成 `'always-replay'`，本条必须红。
 * 为什么必须借夹具：没有恢复行时两种策略都是 0 次重放（文件头那条结论），行为面分不出来；
 * 给了恢复行之后 `orchestrator.js:5208` 那个分支才进得去，策略差异才重新可观测。
 */
test('#288/#530 判据②：worker 传的策略在**有正向进度证据**时不重放（改成 always-replay 就红）', async () => {
  const policy = workerReplayPolicy();
  const { store } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: policy, toolName: 'shell',
    callIds: [DONE_CALL_ID, PENDING_CALL_ID], recoveryRows: true,
  });
  const resumed = await resumeFromPending({ store, tools: [shellSchema()], replayPolicy: policy });
  assert.deepEqual(resumed.resumeExecuted, [],
    `worker 现在的策略（${JSON.stringify(policy)}）在有证据的现场下把挂起的 shell 重放了`
    + `（executor 收到 ${JSON.stringify(resumed.resumeExecuted)}）= issue #288 缺陷 C 复发。`
    + '把 worker.js 的值改成 "always-replay" 就是这条红（判据②）');
});

// ---------------------------------------------------------------------------
// 1. 现场前提：崩溃现场的证据必须在**账本**里（0.33.0 起没有快照可查）
// ---------------------------------------------------------------------------

/**
 * 旧版这里钉的是「崩溃必须留下 run snapshot，且 `pendingToolUses` 带引擎解析出的 `replay` 判定」，
 * 判据对象是**快照那一格**。0.33.0 快照退役 ⇒ 判据换成钉**账本**：
 * `tool_use` 必须已入账、`tool_result` 必须未落（这正是「挂起」的定义），且崩溃期确实执行过一次
 * （否则现场是假的，后面「不重放」就成了恒真）。
 * ⚠ 这是**换判据对象**，不是放宽：旧断言要求「快照里有 pendingToolUses + 该 id 不在 executedToolIds」，
 * 新断言要求「账本里有该 id 的 tool_use + 没有该 id 的 tool_result + 崩溃期 executor 真跑过」。
 */
test('#288/#530 现场前提：崩溃后账本必须带着 assistant 的 tool_use、且没有对应 tool_result', async () => {
  const { store, executedDuringCrash } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: workerReplayPolicy(), toolName: 'shell',
    callIds: [PENDING_CALL_ID],
  });
  assert.deepEqual(executedDuringCrash, [PENDING_CALL_ID],
    '崩溃前那次调用当然执行过（否则「不重放」这条断言是恒真的假绿）');

  const ledger = await store.load(TRANSCRIPT_KEY);
  const idsOf = (type) => ledger
    .flatMap((record) => (record?.messages ?? []))
    .flatMap((message) => (Array.isArray(message?.content) ? message.content : []))
    .filter((block) => block?.type === type)
    .map((block) => (type === 'tool_use' ? block.id : block.tool_use_id));
  assert.ok(idsOf('tool_use').includes(PENDING_CALL_ID),
    '挂起的 tool_use 必须已经在账本里：0.33.0 起恢复**只**吃账本（引擎不再落快照），'
    + '账本里没有它 = 本次现场不是「挂起」而是「从未发生」，本文件的判据无从谈起');
  assert.ok(!idsOf('tool_result').includes(PENDING_CALL_ID),
    '账本里不得已有它的 tool_result（有了就不叫挂起，恢复也就没有「重放不重放」可判）');
});

// ---------------------------------------------------------------------------
// 2. 主口径（**本站真实能力面**：5 方法 store，无快照、无恢复行）
// ---------------------------------------------------------------------------

test('#288 主口径：worker 传 per-tool-declaration ⇒ 挂起的 shell 不再被重放，交还给模型', async () => {
  const policy = workerReplayPolicy();
  assert.equal(policy, 'per-tool-declaration', 'worker 的策略变了，本文件的前提要重看');

  const { store } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: policy, toolName: 'shell', callIds: [PENDING_CALL_ID],
  });
  const resumed = await resumeFromPending({ store, tools: [shellSchema()], replayPolicy: policy });

  // ① 决定性判据：resume 期 executor 一次都没被调（provider 这趟不再要工具，所以调了就是引擎自己重放）
  assert.deepEqual(resumed.resumeExecuted, [],
    `挂起的 shell 被重放了（executor 收到 ${JSON.stringify(resumed.resumeExecuted)}）：`
    + '`kill 旧进程`/`重启 backend`/`重跑测试` 这类非幂等命令每轮真的再掀一次桌 = issue #288 缺陷 C');

  // ② 模型收到一条结果，而不是悬空 tool_use（否则下一趟请求 400、这个 runId 永久起不来）。
  //   ⚠ 本站能力面下这格**只能从「送给模型的消息」里读到**：它是**请求视图桩**
  //   （`mid_sequence_request_view_stub`，#790），只进本次出网的消息，**不发** `tool_result`
  //   LoopEvent（实测 resume 趟的事件只有 `model_metadata_missing / round_start / attempt /
  //   round_end / run_outcome`）。所以这里钉的是 `modelBlocks`，不是事件——
  //   读事件会读到空，那是**真实现形**，不是断言写错（有证据那一格才会发事件，见下面反面对照）。
  const synthesized = resumed.modelBlocks.find((b) => b?.type === 'tool_result' && b.tool_use_id === PENDING_CALL_ID);
  assert.ok(synthesized, '送模型的消息里必须有同 tool_use_id 的 tool_result（悬空 tool_use 会让下一趟请求 400）');
  assert.equal(synthesized.is_error, true, 'is_error 必须为 true');

  // ③ ⚠ 措辞判据本版**跟着改了**（这是事实变了，不是把断言放松）：
  //   0.32.0 及以前这条结果来自「重放决策」那一格，正文写着 "It was not replayed"、
  //   并带 `erix.executionStatus === "interrupted"`。本站能力面（无恢复行）在 0.33.0 上走的是
  //   「账本缺结果 + 引擎两边都无证据」那一格（`pending-tool-result.js` 的
  //   `UNPERSISTED_TOOL_RESULT_TEXT`），语义是**无证据**而不是「没跑」。
  //   安全侧不变（都不重放），但对模型的措辞不同 ⇒ 这里钉的是新形状，且**不许**把它读成
  //   「本站拿到了『从未执行』的确证」（本站没那个证据，#500 才能给）。
  assert.match(String(synthesized.content), /no evidence either way/i,
    '正文必须说「两边都无证据」（本站此刻确实无证据）');
  assert.match(String(synthesized.content), /do not (blindly )?repeat|do not read that as the call having not run/i,
    '正文必须明确「别据此盲目重发」——这才是 #288 在能力面缺口下的真实保证');
  assert.doesNotMatch(String(synthesized.content), /never ran|was not executed/i,
    '不得把它写成「从未执行」：账本没有 `tool-executed` 恢复行，引擎无权这么断言（那是 #500 的收益面）');

  // 模型侧真的看到了这块（上面已经直接钉过消息体，这里钉「事件面确实没有它」这个形状，
  // 免得下一个人在事件里找它、找不到就以为恢复机制坏了）。
  assert.deepEqual(resumed.toolResultEvents.filter((tr) => tr?.tool_use_id === PENDING_CALL_ID), [],
    '本站能力面下这格是**请求视图桩**，不发 tool_result LoopEvent（#790）；'
    + '真发了说明引擎把它升成了账本事实，那时上面②可以改回读事件（更强的形状）');
  assert.equal(resumed.finalText, 'done', 'run 必须能正常收尾（不重放 ≠ 卡死）');

  // ④ tripwire：本站能力面下这条现场**不发** `tool_replay_decision_required`。
  //   原因见文件头：无 `tool-executed` 证据 ⇒ `resumePendingTools` 恒空 ⇒ 引擎根本进不到发那条
  //   事件的分支。这不是「宿主可见性丢了」，而是引擎压根没做重放判定。
  //   ⚠ 若将来本站接了 #500（或上游改成无证据也出声），这条会红——那是**改善**，届时把这条
  //   改成「必须发一条」并补正文判据，别只是删掉。
  assert.deepEqual(resumed.decisionEvents, [],
    '本站能力面（无恢复行）下不该发 tool_replay_decision_required；真发了说明证据面或上游分支变了，'
    + '请重看文件头那条「replayPolicy 已无可观测效果」的结论是否还成立');
});

// ---------------------------------------------------------------------------
// 3. 反面对照（**只在夹具里给恢复行**）：证明上面那条不是恒绿空断言
// ---------------------------------------------------------------------------

/**
 * 形状说明（0.33.0 上唯一可观测的形状，`resume-manager.js:837-853`）：同一批 assistant 里
 * 第一条 `tool_use` 真的跑完并留下 `tool-executed` 恢复行（= 正向进度证据），第二条缺失
 * ⇒ 引擎才认「第二条是顺序执行器没跑到的」⇒ 才会去做重放判定。
 * 只有一条挂起时（上面的主用例），引擎按「无证据」处理：不重放、也不发决策事件。
 */
test('#288/#530 反面对照：策略回到 always-replay ⇒ 有证据的挂起调用**真的**再执行一遍（缺陷原始形态）', async () => {
  const { store, recoveryRowsWritten } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: 'always-replay', toolName: 'shell',
    callIds: [DONE_CALL_ID, PENDING_CALL_ID], recoveryRows: true,
  });
  assert.ok(recoveryRowsWritten.some((r) => r?.toolUseId === DONE_CALL_ID),
    '夹具前提：先完成那条必须真留下 tool-executed 恢复行（没证据就没有「可重放」，本条会假绿）');
  const resumed = await resumeFromPending({
    store, tools: [shellSchema()], replayPolicy: 'always-replay',
  });
  assert.deepEqual(resumed.resumeExecuted, [PENDING_CALL_ID],
    'always-replay 下引擎必须重放。这条变红 = 我的判据失效了（而不是「修好了」）——'
    + '上面主用例的那条「0 次」就会恒绿，整个文件失去意义');
  assert.deepEqual(resumed.decisionEvents, [], 'always-replay 下不该发 tool_replay_decision_required（它自己就决定了）');
});

test('#288/#530 反面对照：per-tool-declaration 在有证据时也不重放，且**发出**宿主决策事件', async () => {
  const { store } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: 'per-tool-declaration', toolName: 'shell',
    callIds: [DONE_CALL_ID, PENDING_CALL_ID], recoveryRows: true,
  });
  const resumed = await resumeFromPending({
    store, tools: [shellSchema()], replayPolicy: 'per-tool-declaration',
  });
  assert.deepEqual(resumed.resumeExecuted, [], 'per-tool-declaration 只放过 replay:"safe"，shell 是 unsafe ⇒ 不该重放');

  // 这一格才是 `tool_replay_decision_required` 的真实现场（主用例那格进不到这里）。
  assert.equal(resumed.decisionEvents.length, 1, '有证据 + 不重放 ⇒ 必须恰好发一条 tool_replay_decision_required');
  const decision = resumed.decisionEvents[0];
  assert.equal(decision.toolUseId, PENDING_CALL_ID);
  assert.equal(decision.toolName, 'shell');
  assert.equal(decision.requiresHostDecision, true, 'requiresHostDecision 必须是 true（契约 §host-consumer-contract:375-383）');
  assert.equal(decision.runId, TRANSCRIPT_KEY, '引擎的 runId 是 transcriptKey=sessionId，不是 station run id');
  assert.equal(decision.replay, 'unsafe');
  assert.equal(decision.partialOutputAvailable, false,
    '本现场没有任何已归档输出（abort 早于结果归档），不得凭空说「有部分输出」');

  // 这一格的正文是「没重放」而不是「无证据」（引擎确实有证据知道它没跑到）。
  const synthesized = resumed.toolResultEvents.find((tr) => tr?.tool_use_id === PENDING_CALL_ID);
  assert.ok(synthesized, '必须有一条同 tool_use_id 的 tool_result');
  assert.equal(synthesized.is_error, true);
  assert.match(String(synthesized.content), /not replayed/i,
    '有证据这一格必须明说「没重放」，模型才知道要自己决定是否重试');
  // erix-agent 0.20.0（#284 / guide §2）：中断状态只在 `erix` 里，顶层摊平键已退役（读到 undefined
  // 是**静默**的，所以两条都要钉）。
  assert.equal(synthesized.erix?.executionStatus, 'interrupted',
    'erix.executionStatus 必须是 "interrupted"（resume 改写产生的特殊状态）');
  assert.ok(!Object.hasOwn(synthesized, 'executionStatus'),
    '退役的顶层 executionStatus 不得再出现在新产出的块上（guide §2 退役名单）');
  const modelSawIt = resumed.modelBlocks.some((b) => (
    b?.type === 'tool_result'
    && b.tool_use_id === PENDING_CALL_ID
    && b.erix?.executionStatus === 'interrupted'
  ));
  assert.ok(modelSawIt, '合成结果必须真的进本次送模型的消息');

  // U3 payload 映射：snake_case + 不与 station 的 run_id 撞名 + 脏值退化
  const payload = loopEventPayload({ type: 'tool_replay_decision_required', ...decision });
  assert.deepEqual(payload, {
    tool_call_id: PENDING_CALL_ID,
    engine_run_id: TRANSCRIPT_KEY,
    round: decision.round,
    name: 'shell',
    replay: 'unsafe',
    requires_host_decision: true,
    partial_output_available: false,
  });
  const dirty = loopEventPayload({
    type: 'tool_replay_decision_required', toolUseId: undefined, runId: undefined,
    round: undefined, toolName: undefined, replay: undefined,
    requiresHostDecision: undefined, partialOutputAvailable: 'yes',
  });
  assert.equal(dirty.tool_call_id, null, '缺 toolUseId ⇒ null，不是 undefined');
  assert.equal(dirty.requires_host_decision, false, '缺位/脏值 ⇒ false（不得把 undefined 或字符串透到下游）');
  assert.equal(dirty.partial_output_available, false, '脏值（字符串 "yes"）⇒ false，不做宽松真值判定');
  assert.equal(dirty.replay, null, '非字符串 replay（对象/数字）⇒ null，不透传脏值');
});

test('#288 变异探针：把 shell 标成 replay:"safe" ⇒ 恢复时真的重放（证明「未标注≠safe」这条判据没被我糊过去）', async () => {
  const safeShell = { ...shellSchema(), replay: 'safe' };
  const { store } = await crashWithPendingTool({
    tools: [safeShell], replayPolicy: 'per-tool-declaration', toolName: 'shell',
    callIds: [DONE_CALL_ID, PENDING_CALL_ID], recoveryRows: true,
  });
  const resumed = await resumeFromPending({
    store, tools: [safeShell], replayPolicy: 'per-tool-declaration',
  });
  assert.deepEqual(resumed.resumeExecuted, [PENDING_CALL_ID],
    'per-tool-declaration 只放过 replay:"safe"。标成 safe 就该真重放');
  assert.deepEqual(resumed.decisionEvents, [], 'safe 的工具不该发「需要宿主决定」事件');
});

// ---------------------------------------------------------------------------
// 4. 显式声明本身：行为上「未标注=unsafe」，所以声明必须被单独钉住
// ---------------------------------------------------------------------------

test('#288：shell 的工具定义必须**显式**声明 replay:"unsafe"（顶层键，不在 inputSchema 里）', () => {
  const schema = shellSchema();
  assert.equal(Object.hasOwn(schema, 'replay'), true,
    'shell 必须显式带 replay 声明。行为上未标注也落 unsafe，所以本单的行为用例**抓不到「把声明摘掉」这条变异**'
    + '——口径要写在代码里，不能只存在于注释和文档');
  assert.equal(schema.replay, 'unsafe',
    '必须是 "unsafe"：写成 "safe" 会让非幂等命令在恢复时真的再执行一遍（上一条探针已钉住后果）');
  assert.equal(schema.inputSchema?.replay, undefined,
    '引擎读的是**工具对象顶层**的 replay（definition?.replay），塞进 inputSchema 等于没声明');
  // 取值合法性：引擎只认 safe/unsafe，其它值 runToolLoop 启动即 TypeError
  assert.ok(['safe', 'unsafe'].includes(schema.replay));
});

test('#288 刻意保守：上游 createFileTools 未标注 replay ⇒ 5 个文件工具挂起时同样不重放（不是漏配）', async () => {
  const upstreamRequire = createRequire(import.meta.url);
  const pkgRoot = path.dirname(path.dirname(upstreamRequire.resolve('erix-agent')));
  // erix-agent 0.29.0 在 `src/tools/` 下新增了**子目录** `delegation/`（派生工具面，本站不接）：
  // 旧的 `readdirSync` 平铺读法会对目录调 `readFileSync` ⇒ EISDIR。改成**递归**收集 `.js`，
  // 判据强度不变（仍是「上游工具源码里一个 `replay:` 标注都没有」），且覆盖面比原来更大。
  const collectToolSources = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectToolSources(full);
      return entry.name.endsWith('.js') ? [fs.readFileSync(full, 'utf8')] : [];
    });
  const upstreamSrc = collectToolSources(path.join(pkgRoot, 'src', 'tools')).join('\n');
  assert.match(upstreamSrc, /createFileTools|file-tools/i, '上游文件工具源码要读得到（包结构变了就更新本读点）');
  assert.doesNotMatch(upstreamSrc, /\breplay\s*:/,
    '上游文件工具源码里没有任何 replay 标注。若将来上游标了 safe，'
    + '本断言变红 = 该重新评估「文件工具挂起时到底要不要重放」（见 AGENTS §8.22）');

  const schemas = fileSchemas();
  assert.ok(schemas.length >= 5, `文件工具应有 5 个，实际 ${schemas.length}`);
  for (const schema of schemas) {
    assert.equal(Object.hasOwn(schema, 'replay'), false,
      `${schema.name}：本站不替上游代签「重放安全」——保持未标注`);
  }

  // 真引擎行为：未标注 ⇒ 挂起时也不重放（这是本单接受的保守口径，不是 bug）。
  // 走**夹具形状**（有证据 + 有决策事件），才能同时钉住「不重放」与「宿主看得见」；
  // 主用例那种无证据形状不会发决策事件（见上面那条 tripwire 的说明）。
  const policy = workerReplayPolicy();
  const target = schemas.find((s) => s.name === 'writeFile') ?? schemas[0];
  const { store } = await crashWithPendingTool({
    tools: schemas, replayPolicy: policy, toolName: target.name,
    callIds: ['call-file-0', 'call-file-1'], recoveryRows: true,
  });
  const resumed = await resumeFromPending({ store, tools: schemas, replayPolicy: policy });
  assert.deepEqual(resumed.resumeExecuted, [],
    `${target.name} 挂起时被重放了。写文件本身幂等，但本单刻意选「一律不重放」：`
    + '少跑一次模型能自己补，多跑一次可能覆盖新内容');
  assert.equal(resumed.decisionEvents.length, 1,
    '文件工具同样要发 tool_replay_decision_required（宿主侧可见性一致，不能只对 shell 出声）');
  assert.equal(resumed.decisionEvents[0].toolName, target.name);
});

test('#288：replay 是引擎元数据，不得渗进送给模型的工具定义（提示词零漂移）', async () => {
  const provider = {
    requests: [],
    async chat(request) {
      this.requests.push(request);
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
  await runToolLoop({
    provider,
    tools: [...fileSchemas(), shellSchema()],
    config: {
      input: { initialUserMessage: 'go' },
      run: { maxRounds: 4, completion: false, replayPolicy: workerReplayPolicy() },
    },
    executeTool: async () => 'x',
  });
  assert.ok(provider.requests.length >= 1, '桩 provider 必须收到过请求');
  for (const request of provider.requests) {
    for (const tool of request?.tools ?? []) {
      assert.equal(Object.hasOwn(tool, 'replay'), false,
        `模型看到的 ${tool.name} 定义里不该有 replay 键（引擎会剥掉它）。`
        + '渗进去 = 每次请求都多一个模型不需要理解的字段，且工具面与历史请求不再逐字节一致');
    }
  }
  const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
  assert.ok(names.includes('shell') && names.includes('readFile'),
    `剥字段不能顺手丢工具（实际 tools=${JSON.stringify(names)}）`);
});
