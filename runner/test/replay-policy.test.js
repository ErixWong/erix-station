// issue #288（缺陷 C）「崩溃恢复时盲目重放有副作用的工具」的 runner 侧回归锁。
//
// 缺陷本体（dev 真机标本）：一条 `sleep 360` 的 shell 被 watchdog 杀掉后，resume 把**同一个
// `tool_use` 从头再执行一遍**（`run_events` 里同 `call_id` 出现 3 条 `tool_use`）。非幂等命令
// （kill 旧进程、重启 backend/vite、重跑测试）每轮真的再掀一次桌。
//
// 为什么这里的断言必须跑**真引擎**而不是 mock：判据是「引擎在 resume 时到底有没有调 executor」，
// 这是 `replayPolicy` × 工具声明 × run snapshot 三者交互的结果，mock 出来的只是我对引擎的想象。
// 技法与 test/tool-duration.test.js 同款：桩 provider + 内存 store + 真 `runToolLoop`，零 LLM/DB/网络。
//
// ⚠ **变异敏感性的关键**：行为断言用的 `replayPolicy` 值是从 worker.js **源码里抠出来的真值**
//   （`workerReplayPolicy()`），不是测试里另抄一份字面量。删掉 worker.js 里那行 ⇒ 取到 `undefined`
//   ⇒ 引擎回落默认 `"always-replay"` ⇒ 挂起工具又被重放 ⇒ 本文件的主用例必须变红。
//   测试里再抄一份字面量的话，这条变异就永远测不出来（改了实现、测试还在自娱自乐）。
//
// ⚠ 「摘掉 shell 的 `replay` 声明」这条变异**行为上不会变红**，这是引擎语义而非测试漏洞：
//   `orchestrator.js:1781` 的判据是 `definition?.replay === "safe" ? "safe" : "unsafe"`
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

const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

/**
 * 从 worker.js 抠出**真传给 runToolLoop 的** `replayPolicy` 值。
 * 只认 `replayPolicy: '<literal>'` 形态（注释里写的是 `replayPolicy === "..."`，不带冒号，不会误命中）。
 * 没传 ⇒ 返回 undefined，让引擎用它自己的默认值（= 变异「删掉那行」的真实后果，而不是测试替它兜底）。
 */
function workerReplayPolicy() {
  const hits = read('worker.js').match(/\breplayPolicy\s*:\s*(['"])([^'"]+)\1/g) ?? [];
  assert.ok(hits.length <= 1,
    `worker.js 只应有一处 replayPolicy 传参（多份 = 出现第二个 runToolLoop 调用点或漏改，实际=${hits.length}）`);
  const matched = hits[0]?.match(/\breplayPolicy\s*:\s*(['"])([^'"]+)\1/);
  return matched ? matched[2] : undefined;
}

// ---------------------------------------------------------------------------
// 现场装配：内存 store（含 run snapshot 能力）+ 桩 provider
// ---------------------------------------------------------------------------

function makeStore() {
  const records = new Map();
  const snapshots = new Map();
  return {
    async appendRound(key, record) {
      if (!records.has(key)) records.set(key, []);
      records.get(key).push(record);
    },
    async load(key) {
      return [...(records.get(key) ?? [])]
        .sort((a, b) => (a.round ?? 0) - (b.round ?? 0)); // 同 round 保序由 append_seq 保证，这里只一条
    },
    async saveRunSnapshot(key, snapshot) { snapshots.set(key, snapshot); },
    async loadLatestRunSnapshot(key) { return snapshots.get(key); },
    async saveRunState() {},
    async loadRunState() { return undefined; },
    async markRunState() {},
  };
}

/** 第 1 趟要一个 shell 工具调用；之后收尾。 */
function toolThenDoneProvider(toolName, callId, input = { command: 'sleep 360' }) {
  let calls = 0;
  const requests = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? { content: [{ type: 'tool_use', id: callId, name: toolName, input }], stopReason: 'tool_use' }
        : { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
}

/** resume 趟直接收尾：不再要工具 ⇒ resume 期出现的 executor 调用**只可能是盲目重放**。 */
function endTurnProvider() {
  const requests = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
}

const shellSchema = () => createShellTools({ worktreeRoot: RUNNER_DIR }).schemas[0];
const fileSchemas = () => createStationFileTools({ jail: { root: RUNNER_DIR }, cwd: RUNNER_DIR }).schemas;

/**
 * 造一次「工具挂起」崩溃：引擎在调 executor **之前**先把 run snapshot 落盘
 * （`run-snapshot-executor.js:229-238` persistRunSnapshot ⇒ `orchestrator.js:1808-1818` 盖 replay），
 * 所以 executor 里 abort 就等价于「tool_use 已记录、tool_result 还没有」的崩溃现场。
 */
async function crashWithPendingTool({ tools, replayPolicy, toolName, callId = PENDING_CALL_ID }) {
  const store = makeStore();
  const abort = new AbortController();
  const executedDuringCrash = [];
  await runToolLoop({
    provider: toolThenDoneProvider(toolName, callId),
    initialUserMessage: 'go',
    completion: false,
    tools,
    maxRounds: 8,
    replayPolicy,
    store,
    runId: TRANSCRIPT_KEY,
    executeTool: async (options) => {
      executedDuringCrash.push(options.id);
      abort.abort(); // 命令还在跑就被宿主叫停（watchdog 误杀 / 进程被 SIGKILL 的等价形态）
      return 'outcome never recorded';
    },
    signal: abort.signal,
  }).catch(() => {}); // abort 让 run 以 AbortError 收场 = 崩溃语义，正是我们要的现场
  return { store, executedDuringCrash };
}

/** 从挂起态 resume，返回 resume 期的 executor 调用、LoopEvent 与模型看到的块。 */
async function resumeFromPending({ store, tools, replayPolicy }) {
  const provider = endTurnProvider();
  const resumeExecuted = [];
  const events = [];
  const result = await runToolLoop({
    provider,
    completion: false,
    tools,
    maxRounds: 8,
    replayPolicy,
    store,
    runId: TRANSCRIPT_KEY,
    resume: true,
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

// ---------------------------------------------------------------------------
// 1. 崩溃现场本身：snapshot 必须记下引擎解析出的 replay 判定（否则恢复无从判断）
// ---------------------------------------------------------------------------

test('#288 现场前提：崩溃时 run snapshot 的 pendingToolUses 必须带引擎解析出的 replay 判定', async () => {
  const { store, executedDuringCrash } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: workerReplayPolicy(), toolName: 'shell',
  });
  assert.deepEqual(executedDuringCrash, [PENDING_CALL_ID], '崩溃前那次调用当然执行过（否则现场是假的）');
  const snapshot = await (async () => {
    // 走 store 的读点，别摸内部 Map
    const loaded = await store.loadLatestRunSnapshot(TRANSCRIPT_KEY);
    return loaded;
  })();
  assert.ok(snapshot, '崩溃必须留下 run snapshot（没有快照就没有 resume，本单语义无从谈起）');
  assert.deepEqual(
    (snapshot.pendingToolUses ?? []).map((t) => ({ id: t.id, name: t.name, replay: t.replay })),
    [{ id: PENDING_CALL_ID, name: 'shell', replay: 'unsafe' }],
    'orchestrator.js:1783-1786/1808-1818 必须把解析结果盖在 pendingToolUses 上；'
    + '丢了它，恢复时只能按「未标注=unsafe」兜底，口径不再是「当初记录的意图」',
  );
  assert.ok(!(snapshot.executedToolIds ?? []).includes(PENDING_CALL_ID),
    '未完成的调用不得进 executedToolIds（resume-manager.js:260-264 靠它过滤，误标 = 结果丢失）');
});

// ---------------------------------------------------------------------------
// 2. 主口径：worker 传的策略下，挂起的 shell **不再被重放**
// ---------------------------------------------------------------------------

test('#288 主口径：worker 传 per-tool-declaration ⇒ 挂起的 shell 不再被重放，交还给模型', async () => {
  const policy = workerReplayPolicy();
  assert.equal(policy, 'per-tool-declaration',
    'worker.js 必须显式传 replayPolicy: "per-tool-declaration"。'
    + '删掉那行 = 回落引擎默认 "always-replay"（orchestrator.js:558）= 本单缺陷原样复发');

  const { store } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: policy, toolName: 'shell',
  });
  const resumed = await resumeFromPending({ store, tools: [shellSchema()], replayPolicy: policy });

  // ① 决定性判据：resume 期 executor 一次都没被调（provider 这趟不再要工具，所以调了就是引擎自己重放）
  assert.deepEqual(resumed.resumeExecuted, [],
    `挂起的 shell 被重放了（executor 收到 ${JSON.stringify(resumed.resumeExecuted)}）：`
    + '`kill 旧进程`/`重启 backend`/`重跑测试` 这类非幂等命令每轮真的再掀一次桌 = issue #288 缺陷 C');

  // ② 模型收到一条「没重放」的失败结果，而不是没有结果（否则会话卡在悬空 tool_use 上）
  const synthesized = resumed.toolResultEvents.find((tr) => tr?.tool_use_id === PENDING_CALL_ID);
  assert.ok(synthesized, '必须有一条同 tool_use_id 的 tool_result（悬空 tool_use 会让下一趟请求 400）');
  assert.equal(synthesized.is_error, true, 'is_error 必须为 true');
  assert.equal(synthesized.executionStatus, 'interrupted',
    'executionStatus 必须是 "interrupted"（orchestrator.js:2586-2597 的合成块形状）');
  assert.match(String(synthesized.content), /not replayed/i,
    '正文必须明说「没重放」，模型才知道要自己决定是否重试');
  // 模型侧真的看到了这块（不是只发了事件）
  const modelSawIt = resumed.modelBlocks.some((b) => (
    b?.type === 'tool_result'
    && b.tool_use_id === PENDING_CALL_ID
    && b.executionStatus === 'interrupted'
  ));
  assert.ok(modelSawIt, '合成结果必须真的进本次送模型的消息（交还决定的前提是模型看得见）');
  assert.equal(resumed.finalText, 'done', 'run 必须能正常收尾（不重放 ≠ 卡死）');

  // ③ 宿主事件必须发出来，且载荷就是引擎事件对象那几个字段
  assert.equal(resumed.decisionEvents.length, 1, '必须恰好发一条 tool_replay_decision_required');
  const decision = resumed.decisionEvents[0];
  assert.equal(decision.toolUseId, PENDING_CALL_ID);
  assert.equal(decision.toolName, 'shell');
  assert.equal(decision.requiresHostDecision, true, 'requiresHostDecision 必须是 true（契约 §host-consumer-contract:375-383）');
  assert.equal(decision.runId, TRANSCRIPT_KEY, '引擎的 runId 是 transcriptKey=sessionId，不是 station run id');
  assert.equal(decision.replay, 'unsafe');
  assert.equal(decision.partialOutputAvailable, false,
    '本现场没有任何已归档输出（abort 早于结果归档），不得凭空说「有部分输出」');

  // ④ U3 payload 映射：snake_case + 不与 station 的 run_id 撞名 + 脏值退化
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

// ---------------------------------------------------------------------------
// 3. 反面对照：策略换成默认 always-replay ⇒ 同一条调用**真的**被重放
//    （这条是上一条的「变异探针」：证明 ② 的判据真在测重放，而不是碰巧恒绿）
// ---------------------------------------------------------------------------

test('#288 反面对照：策略回到引擎默认 always-replay ⇒ 同一条 shell 真的再执行一遍（缺陷原始形态）', async () => {
  const { store } = await crashWithPendingTool({
    tools: [shellSchema()], replayPolicy: 'always-replay', toolName: 'shell',
  });
  const resumed = await resumeFromPending({ store, tools: [shellSchema()], replayPolicy: 'always-replay' });
  assert.deepEqual(resumed.resumeExecuted, [PENDING_CALL_ID],
    'always-replay 下引擎必须重放（orchestrator.js:2571 的门不进）。这条变红 = 我的判据失效了，'
    + '而不是「修好了」——上面那条主口径就会恒绿');
  assert.deepEqual(resumed.decisionEvents, [], 'always-replay 下不该发 tool_replay_decision_required');
});

test('#288 变异探针：把 shell 标成 replay:"safe" ⇒ 恢复时真的重放（证明「未标注≠safe」这条判据没被我糊过去）', async () => {
  const safeShell = { ...shellSchema(), replay: 'safe' };
  const { store } = await crashWithPendingTool({
    tools: [safeShell], replayPolicy: 'per-tool-declaration', toolName: 'shell',
  });
  const resumed = await resumeFromPending({ store, tools: [safeShell], replayPolicy: 'per-tool-declaration' });
  assert.deepEqual(resumed.resumeExecuted, [PENDING_CALL_ID],
    'per-tool-declaration 只放过 replay:"safe"（orchestrator.js:2571）。标成 safe 就该真重放');
  assert.deepEqual(resumed.decisionEvents, [], 'safe 的工具不该发「需要宿主决定」事件');
});

// ---------------------------------------------------------------------------
// 4. 显式声明本身：行为上「未标注=unsafe」，所以声明必须被单独钉住
// ---------------------------------------------------------------------------

test('#288：shell 的工具定义必须**显式**声明 replay:"unsafe"（顶层键，不在 inputSchema 里）', () => {
  const schema = shellSchema();
  assert.equal(Object.hasOwn(schema, 'replay'), true,
    'shell 必须显式带 replay 声明。行为上未标注也落 unsafe（orchestrator.js:1781 判据是 === "safe"），'
    + '所以本单的行为用例**抓不到「把声明摘掉」这条变异**——口径要写在代码里，不能只存在于注释和文档');
  assert.equal(schema.replay, 'unsafe',
    '必须是 "unsafe"：写成 "safe" 会让非幂等命令在恢复时真的再执行一遍（上一条探针已钉住后果）');
  assert.equal(schema.inputSchema?.replay, undefined,
    '引擎读的是**工具对象顶层**的 replay（:1781 definition?.replay），塞进 inputSchema 等于没声明');
  // 取值合法性：:667-670 只认 safe/unsafe，其它值 runToolLoop 启动即 TypeError
  assert.ok(['safe', 'unsafe'].includes(schema.replay));
});

test('#288 刻意保守：上游 createFileTools 未标注 replay ⇒ 5 个文件工具挂起时同样不重放（不是漏配）', async () => {
  const upstreamRequire = createRequire(import.meta.url);
  const pkgRoot = path.dirname(path.dirname(upstreamRequire.resolve('erix-agent')));
  const upstreamSrc = fs.readdirSync(path.join(pkgRoot, 'src', 'tools'))
    .map((f) => fs.readFileSync(path.join(pkgRoot, 'src', 'tools', f), 'utf8'))
    .join('\n');
  assert.match(upstreamSrc, /createFileTools|file-tools/i, '上游文件工具源码要读得到（包结构变了就更新本读点）');
  assert.doesNotMatch(upstreamSrc, /\breplay\s*:/,
    'erix-agent 0.18.0 的上游工具源码里没有任何 replay 标注。若将来上游标了 safe，'
    + '本断言变红 = 该重新评估「文件工具挂起时到底要不要重放」（见 AGENTS §8.22）');

  const schemas = fileSchemas();
  assert.ok(schemas.length >= 5, `文件工具应有 5 个，实际 ${schemas.length}`);
  for (const schema of schemas) {
    assert.equal(Object.hasOwn(schema, 'replay'), false,
      `${schema.name}：本站不替上游代签「重放安全」——保持未标注`);
  }

  // 真引擎行为：未标注 ⇒ 挂起时也不重放（这是本单接受的保守口径，不是 bug）
  const policy = workerReplayPolicy();
  const target = schemas.find((s) => s.name === 'writeFile') ?? schemas[0];
  const { store } = await crashWithPendingTool({
    tools: schemas, replayPolicy: policy, toolName: target.name, callId: 'call-file-1',
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
  const provider = endTurnProvider();
  await runToolLoop({
    provider,
    initialUserMessage: 'go',
    completion: false,
    tools: [...fileSchemas(), shellSchema()],
    maxRounds: 4,
    replayPolicy: workerReplayPolicy(),
    executeTool: async () => 'x',
  });
  assert.ok(provider.requests.length >= 1, '桩 provider 必须收到过请求');
  for (const request of provider.requests) {
    for (const tool of request?.tools ?? []) {
      assert.equal(Object.hasOwn(tool, 'replay'), false,
        `模型看到的 ${tool.name} 定义里不该有 replay 键（orchestrator.js:707-715 会剥掉它）。`
        + '渗进去 = 每次请求都多一个模型不需要理解的字段，且工具面与历史请求不再逐字节一致');
    }
  }
  const names = (provider.requests[0]?.tools ?? []).map((t) => t.name);
  assert.ok(names.includes('shell') && names.includes('readFile'),
    `剥字段不能顺手丢工具（实际 tools=${JSON.stringify(names)}）`);
});
