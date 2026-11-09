// issue delegation P1（2026-11-08）——宿主侧 `delegate` 的十条红格（工单 `P1-WORKORDER.md` §5）。
//
// 判据形状的两条口径：
//   ① **能跑真引擎的就跑真引擎**（判据 2 / 10 / 目录反证）：名册 state、账本落盘位置是库与引擎
//      双方交互的结果，mock 出来的只是我对它们的想象。技法照 `runner/test/replay-policy.test.js`：
//      桩 provider + 真 `runToolLoop` + tmp 目录，零 LLM / 零 DB / 零网络。
//   ② 但子 run 的**入参形状**（deadline 换算、工具面、中止串联、保活节拍）在真引擎里既慢又不
//      确定 ⇒ `createStationDelegation` 收了 `runToolLoopImpl` 注入口：被替换掉的只有「引擎那一发」，
//      跑真代码的是 `runChild` 本体 + 库的名册/配额/映射表（**红格要红的正是这两层**）。
//
// 父身份那条**不是**纯手搓入参：`context` 由 `worker.js` 导出的 `buildDelegateContext` 构造
// （本站 `config.run.runId` 填的是 transcriptKey=sessionId，而库只从 `context.runId` 自取父身份），
// 所以判据 1 真的穿过那个函数——不覆盖 runId 就红。
//
// ⚠ worker.js 的两条接线（路由调 `buildDelegateContext`、终态 usage 合并）在进程内没法跑真 worker
//   （worker 由 agentd fork、依赖 IPC store），照 `model-metadata.test.js` / `replay-policy.test.js`
//   的先例用**源码形状**钉住：改了实现、源码形状变了 ⇒ 红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileTranscriptStore, runToolLoop } from 'erix-agent';

import {
  createStationDelegation, mergeUsage, normalizeChildTermination, terminationReasonOf,
  createLivenessThrottle, isProcessAlive, CHILD_SYSTEM_PROMPT, DELEGATE_REASON_NORMALIZATIONS,
} from '../lib/delegation.js';
import {
  isDelegateEnabled, parseDelegateMax, parseDelegateChildRounds, parseDelegateChildTimeoutMs,
} from '../lib/config.js';
import { createStationFileTools, createJail } from '../lib/file-tools.js';
import { createShellTools } from '../lib/shell-tools.js';
import { buildDelegateContext } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATION_RUN_ID = 'run-9b2e1c4d-0000-4000-8000-delegatep1';
const TRANSCRIPT_KEY = 'sess-11111111-2222-3333-4444-555555555555'; // 本站 run.runId 填的是它

const readWorkerSource = () => fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `delegate-p1-${label}-`));
}

function readRoster(rosterDir, childRunId) {
  return JSON.parse(fs.readFileSync(path.join(rosterDir, `${childRunId}.json`), 'utf8'));
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** 桩 provider：第一发要一个文件工具，第二发收尾（真引擎那条路只用来验 state 与账本）。 */
function stubProvider(text = 'child done') {
  let calls = 0;
  const requests = [];
  return {
    requests,
    async chat(request) {
      requests.push(request);
      calls += 1;
      return calls === 1
        ? { content: [{ type: 'text', text }], stopReason: 'end_turn' }
        : { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' };
    },
  };
}

/** 假的「引擎」返回值（测试里用 `runToolLoopImpl: async () => result` 的形式塞进 harness）。 */
function engineReturns(result) {
  return async () => result;
}

/** 一个「等到 abort 才结」的假引擎（父中止级联的判据用）。 */
function engineWaitsForAbort({ onSignal, timeoutMs = 1_500 }) {
  return (options) => new Promise((resolve, reject) => {
    onSignal?.(options.signal);
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('run aborted'), { termination: { reason: 'aborted' } }));
    });
    // 变异面「不串 signal」：子的 signal 永远不会 abort ⇒ 这条兜底先红，而不是把测试挂住。
    setTimeout(() => reject(new Error('TEST_TIMEOUT: 子的 signal 没有被父的 abort 串到')), timeoutMs);
  });
}

/** 子工具面（裁决 ①：文件工具 + shell，显式构造）。 */
function childToolFace(root) {
  const jail = createJail({ root, writable: [root] });
  const fileTools = createStationFileTools({ jail, cwd: root });
  const shellTools = createShellTools({ worktreeRoot: root });
  return { jail, fileTools, shellTools, schemas: [...fileTools.schemas, ...shellTools.schemas] };
}

/** 一条完整装配：tmp 目录作 delegationDir；给了 `runToolLoopImpl` 就包一层记录器。 */
function harness(overrides = {}) {
  const dir = tmpDir('case');
  const face = childToolFace(dir);
  const impl = overrides.runToolLoopImpl
    ?? (overrides.engineResult !== undefined ? engineReturns(overrides.engineResult) : undefined);
  const engine = impl === undefined
    ? null
    : (() => {
      const calls = [];
      return {
        calls,
        impl: async (options) => {
          calls.push(options);
          overrides.onEngineCall?.(options);
          return impl(options);
        },
      };
    })();
  const liveness = [];
  const logs = [];
  const parentController = new AbortController();
  const providerRef = overrides.provider ?? stubProvider();
  const executeToolRef = overrides.executeTool ?? (async (options) => face.shellTools.executors[options.name]?.(options.input, options.context)
    ?? face.fileTools.executors[options.name]?.(options.input, options.context));
  const delegation = createStationDelegation({
    parentRunId: STATION_RUN_ID,
    parentCwd: dir,
    delegationDir: path.join(dir, 'delegation'),
    provider: providerRef,
    childTools: face.schemas,
    executeTool: executeToolRef,
    ...(overrides.engineModelMetadata ? { engineModelMetadata: overrides.engineModelMetadata } : {}),
    ...(overrides.modelMetadata ? { modelMetadata: overrides.modelMetadata } : {}),
    ...(overrides.maxTokens ? { maxTokens: overrides.maxTokens } : {}),
    ...(engine ? { runToolLoopImpl: engine.impl } : {}),
    ...(overrides.childTools ? { childTools: overrides.childTools } : {}),
    parentSignal: parentController.signal,
    onChildLiveness: (childRunId) => liveness.push(childRunId),
    logger: (level, msg, fields) => logs.push({ level, msg, fields }),
    clock: overrides.clock,
    livenessIntervalMs: overrides.livenessIntervalMs,
    maxConcurrent: overrides.maxConcurrent,
    childMaxRounds: overrides.childMaxRounds,
    childDeadlineMs: overrides.childDeadlineMs,
    ...overrides.rest,
  });
  return { dir, delegation, face, engine, liveness, logs, parentController, executeToolRef, providerRef };
}

/** 走 worker 的构造函数拿 context（判据 1 要真的穿过那个函数）。 */
const parentContext = () => buildDelegateContext({ runId: TRANSCRIPT_KEY, session: 'leaked' }, STATION_RUN_ID);

// ---------------------------------------------------------------------------
// 判据 1 —— 父身份是**本站真 runId**，不是 sessionId
// ---------------------------------------------------------------------------
test('D1 父身份：名册 parentRunId = 本站 runId（且 engine context 的其它键原样带着）', async () => {
  const ctx = parentContext();
  assert.equal(ctx.runId, STATION_RUN_ID, 'worker 必须用本站真 runId 覆盖 context.runId');
  assert.equal(ctx.session, 'leaked', '覆盖 runId 不许丢 engine context 的其它键');

  const h = harness();
  const run = await h.delegation.execute({ action: 'run', task: 'read something' }, ctx);
  assert.equal(run.ok, true, JSON.stringify(run));
  const record = readRoster(h.delegation.rosterDir, run.runId);
  assert.equal(record.parentRunId, STATION_RUN_ID);
  assert.notEqual(record.parentRunId, TRANSCRIPT_KEY,
    '名册里出现 transcriptKey(=sessionId) ⇒ 父身份错位，P2 的归属校验（parentRunId 属于该 session）永远对不上');
  // 名册目录按**父 run** 分片（设计 §3）
  assert.equal(h.delegation.rosterDir, path.join(h.dir, 'delegation', 'roster', STATION_RUN_ID));

  // worker 侧接线：路由必须调那个构造函数（摘掉 `options.context` ⇒ 这里红）
  const src = readWorkerSource();
  assert.match(src, /delegation\.execute\(options\.input,\s*buildDelegateContext\(options\.context,\s*runId\)\)/,
    'worker 的 delegate 路由必须把 engine context 原样递下去并用真 runId 覆盖 runId');
  assert.doesNotMatch(src, /delegation\.execute\(options\.input,\s*(\{\}|options\.context)\)/,
    '路由不许把 engine context 摘掉、也不许不覆盖 runId 就原样透传');
});

// ---------------------------------------------------------------------------
// 判据 2 —— 对象 termination 不许静默 failed（跑真引擎）
// ---------------------------------------------------------------------------
test('D2 终止词汇：真引擎 end_turn 收尾 ⇒ 名册 completed（对象 termination 不静默 failed）', async () => {
  const h = harness(); // 不注入 runToolLoopImpl ⇒ 真 runToolLoop
  const run = await h.delegation.execute({ action: 'run', task: '读一个文件' }, parentContext());
  assert.equal(run.ok, true, JSON.stringify(run));
  const record = readRoster(h.delegation.rosterDir, run.runId);
  assert.equal(record.state, 'completed', `真引擎 end_turn 必须落 completed，实得 ${JSON.stringify(record)}`);
  assert.equal(record.termination, 'end_turn');
  assert.equal(record.resultText, 'child done');

  // 变异面：`termination: result.termination`（对象）⇒ 库的映射表查不到 ⇒ failed
  assert.equal(terminationReasonOf({ reason: 'end_turn' }), 'end_turn');
  assert.equal(normalizeChildTermination({ reason: 'end_turn' }), 'end_turn');
});

// ---------------------------------------------------------------------------
// 判据 3 —— `no_tool` 不许判失败（本站当正常收尾）
// ---------------------------------------------------------------------------
for (const reason of ['no_tool', 'continuation_exhausted']) {
  test(`D3 终止词汇：子以 ${reason} 收尾 ⇒ 名册 completed 且 termination=end_turn（原始 reason 只进日志）`, async () => {
    const h = harness({ engineResult: { finalText: 'partial', termination: { reason } } });
    const run = await h.delegation.execute({ action: 'run', task: 't' }, parentContext());
    const record = readRoster(h.delegation.rosterDir, run.runId);
    assert.equal(record.state, 'completed', `${reason} 被引擎映射表判 failed，本站必须归一`);
    assert.equal(record.termination, 'end_turn');
    assert.equal(Object.hasOwn(record, 'terminationReason'), false,
      '多余键落不了盘（库的 finishRun 只搬白名单键）⇒ 不该假装名册里有原始 reason');
    assert.deepEqual(DELEGATE_REASON_NORMALIZATIONS, { no_tool: 'end_turn', continuation_exhausted: 'end_turn' });
    const logged = h.logs.find((l) => l.msg === 'delegate child finished');
    assert.ok(logged, '原始 reason 必须可追溯（日志一行）');
    assert.equal(logged.fields.reason, reason);
    assert.equal(logged.fields.normalized, 'end_turn');
  });
}

test('D3b 终止词汇：其余 reason 原样透传（不许自己发明词、不许一律塞成 failed）', () => {
  for (const reason of ['end_turn', 'judge_done', 'aborted', 'max_rounds_cap', 'stall',
    'failed', 'persistence_failed', 'final_guard_unverified', 'timeout']) {
    assert.equal(normalizeChildTermination({ reason }), reason, `${reason} 必须原样透传`);
  }
  assert.equal(normalizeChildTermination(undefined), undefined);
  assert.equal(normalizeChildTermination({}), undefined);
});

// ---------------------------------------------------------------------------
// 判据 4 —— 配额跨进程（两个实例共享 leaseDir）
// ---------------------------------------------------------------------------
test('D4 配额：两个装配实例共享 leaseDir ⇒ 第三个子 capacity_full 且点名 holders', async () => {
  const dir = tmpDir('quota');
  const face = childToolFace(dir);
  const delegationDir = path.join(dir, 'delegation');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slowEngine = { impl: async () => { await gate; return { finalText: 'ok', termination: { reason: 'end_turn' } }; } };

  const mk = (label) => createStationDelegation({
    parentRunId: `run-parent-${label}`,
    parentCwd: dir,
    delegationDir,
    provider: stubProvider(),
    childTools: face.schemas,
    executeTool: async () => '',
    runToolLoopImpl: slowEngine.impl,
    maxConcurrent: 2,
  });
  const a = mk('a');
  const b = mk('b');
  // leases 是**每 FDE 共享**的（设计 §3）：两个父 run 真共享同一个配额池
  assert.equal(a.leaseDir, b.leaseDir, 'leaseDir 必须与父 run 无关（每 FDE 一份 ⇒ 全局子配额）');

  const first = a.execute({ action: 'run', task: 'one', background: true }, parentContext());
  const second = b.execute({ action: 'run', task: 'two', background: true }, parentContext());
  await tick(); await tick();
  const third = await b.execute({ action: 'run', task: 'three', background: true }, parentContext());
  assert.equal(third.ok, false, `池子满了第三个必须被拒：${JSON.stringify(third)}`);
  assert.equal(third.reason, 'capacity_full');
  assert.equal(third.maxConcurrent, 2);
  assert.ok(Array.isArray(third.holders) && third.holders.length === 2,
    `capacity_full 必须点名持有者：${JSON.stringify(third.holders)}`);

  release();
  const [r1, r2] = await Promise.all([first, second]);
  assert.ok(r1.runId && r2.runId);
});

// ---------------------------------------------------------------------------
// 判据 5 —— 父停 ⇒ 子死（中止级联只走 signal）
// ---------------------------------------------------------------------------
test('D5 中止级联：父 abort ⇒ 子 runToolLoop 的 signal aborted ⇒ 名册落 aborted', async () => {
  let childSignal;
  const abortingEngine = (options) => new Promise((resolve, reject) => {
    childSignal = options.signal;
    options.signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('run aborted'), { termination: { reason: 'aborted' } }));
    });
    // 变异面「不串 signal」：子的 signal 永远不会 abort ⇒ 这条兜底先红，而不是把测试挂住。
    setTimeout(() => reject(new Error('TEST_TIMEOUT: 子的 signal 没有被父的 abort 串到')), 1_500);
  });
  const h = harness({ runToolLoopImpl: engineWaitsForAbort({ onSignal: (s) => { childSignal = s; } }) });
  // 父在子跑起来之后 abort（用户点「停止」那个动作）
  const p = h.delegation.execute({ action: 'run', task: 'long thing' }, parentContext());
  await tick();
  h.parentController.abort();
  const run = await p;
  assert.ok(childSignal, '子 run 必须收到一个 signal');
  assert.equal(childSignal.aborted, true, '父已 abort ⇒ 子的 signal 必须 aborted');
  assert.equal(run.state, 'aborted', `名册与返回值都说 aborted：${JSON.stringify(run)}`);
  // ⚠ `run.ok === true` 是**刻意的**：`runChild` 把 abort 归一成「子的结局」而不是宿主异常，
  // 父 run 不许因为「用户停了某个子」而自己失败（库的 `ok` 说的是「簿记成功」）。
  assert.equal(run.ok, true);
  const record = readRoster(h.delegation.rosterDir, run.runId);
  assert.equal(record.state, 'aborted');
  assert.equal(record.termination, 'aborted');

  // 反向：库给的 request.signal 也照样串（前台 cancel 用不到，但别把它丢了）
  assert.match(fs.readFileSync(path.join(RUNNER_DIR, 'lib', 'delegation.js'), 'utf8'),
    /combineSignals\(\[request\.signal,\s*parentSignal\]\)/);
});

// ---------------------------------------------------------------------------
// 判据 6 —— usage 不漏账
// ---------------------------------------------------------------------------
test('D6 usage：子的 usage 逐字段累加，并与父的终态 usage 合并（含 cache 字段）', async () => {
  const h = harness({
    engineResult: { finalText: 'ok', termination: { reason: 'end_turn' }, usage: { input_tokens: 100, output_tokens: 5, cacheRead: 40 } },
  });
  await h.delegation.execute({ action: 'run', task: 'a' }, parentContext());
  await h.delegation.execute({ action: 'run', task: 'b' }, parentContext());
  const taken = h.delegation.takeChildUsage();
  assert.deepEqual(taken, { input_tokens: 200, output_tokens: 10, cacheRead: 80 });
  assert.deepEqual(h.delegation.takeChildUsage(), { input_tokens: 0, output_tokens: 0 },
    'takeChildUsage 必须取走并清零（否则同一笔账会被并两次）');

  const merged = mergeUsage({ input_tokens: 900, output_tokens: 90, cacheRead: 10 }, taken);
  assert.deepEqual(merged, { input_tokens: 1100, output_tokens: 100, cacheRead: 90 });
  assert.deepEqual(mergeUsage({ input_tokens: 1, output_tokens: 2 }, { input_tokens: 3, output_tokens: 4 }),
    { input_tokens: 4, output_tokens: 6 }, '两边都没报 cache ⇒ 不许写出一个假的 0');

  // worker 侧接线：**只改写发给 portal 的那一份**，且必须真调 takeChildUsage
  const src = readWorkerSource();
  assert.match(src, /usage:\s*delegation !== null\s*\?\s*mergeUsage\(result\.usage,\s*delegation\.takeChildUsage\(\)\)/,
    'RUN_FINISHED.usage 必须并上子的 usage（不累加 ⇒ 漏账）');
});

test('D6b 反向：子的 usage 只进父的 RUN_FINISHED，不另发一条 ledger（第二行会被 UNIQUE 静默吞掉）', () => {
  const src = readWorkerSource();
  assert.equal((src.match(/takeChildUsage\(\)/g) ?? []).length, 1,
    `takeChildUsage 只许在 RUN_FINISHED 那一处用（实际 ${(src.match(/takeChildUsage\(\)/g) ?? []).length} 处）`);
  assert.doesNotMatch(src, /type:\s*MSG\.(USAGE|USAGE_LEDGER|EVENT)[^\n]*delegate/,
    '不许为子另发一条 usage/ledger（usage_ledger_run_source_key UNIQUE (run_id, source) + ON CONFLICT DO NOTHING ⇒ 静默吞）');
  assert.doesNotMatch(src, /emitEvent\(\s*['"]delegate/,
    'P1 不给子发任何事件类型（新事件类型属 P2 之后的活）');
});

// ---------------------------------------------------------------------------
// 判据 7 —— 默认开（2026-11-09 决策者翻向：未设即开）
// ---------------------------------------------------------------------------
test('D7 默认开：ERIX_DELEGATE_ENABLED 未设 ⇒ 照常装配；显式非 1 才关', () => {
  // 未设 / 空串 ⇒ 开（这是 2026-11-09 翻的那一支撑）
  for (const raw of [undefined, null, '']) {
    assert.equal(isDelegateEnabled(raw), true, `${JSON.stringify(raw)} 必须算开（默认开）`);
  }
  assert.equal(isDelegateEnabled('1'), true);
  // 显式值仍只认 '1'：写错字宁可关掉，也别让人以为开了
  for (const raw of ['0', 'true', 'yes', 1, '11']) {
    assert.equal(isDelegateEnabled(raw), false, `${JSON.stringify(raw)} 不算开（显式值只有字符串 '1' 算开）`);
  }

  const src = readWorkerSource();
  assert.match(src, /const delegateEnabled = isDelegateEnabled\(process\.env\.ERIX_DELEGATE_ENABLED\);/,
    '开关必须走 lib/config.js 的唯一口径（agentd 读的是同一个函数）');
  assert.match(src, /const tools = \[\.\.\.baseToolSchemas, \.\.\.\(delegation !== null \? \[delegation\.definition\] : \[\]\)\];/,
    '关掉时工具面必须逐字等于 baseToolSchemas（2065 字节的 schema 一个字节都不许多带）');
  assert.match(src, /if \(delegateEnabled\) \{/, '装配必须整段被开关圈住（显式关 ⇒ 连目录都不碰）');
});

test('D7c 显式关：ERIX_DELEGATE_ENABLED=0 ⇒ 工具面逐字等于今天（2065 字节 schema 一个字节都不多带）', () => {
  assert.equal(isDelegateEnabled('0'), false);
  const src = readWorkerSource();
  assert.match(src, /const tools = \[\.\.\.baseToolSchemas, \.\.\.\(delegation !== null \? \[delegation\.definition\] : \[\]\)\];/,
    '关掉时工具面必须逐字等于 baseToolSchemas');
});

test('D7b env 边界：越界钳到边界并给出 clamped 标记（不静默回退）', () => {
  assert.deepEqual(parseDelegateMax(undefined), { value: 2, clamped: false });
  assert.deepEqual(parseDelegateMax('0'), { value: 1, clamped: true });
  assert.deepEqual(parseDelegateMax('99'), { value: 8, clamped: true });
  assert.deepEqual(parseDelegateMax('垃圾'), { value: 2, clamped: false });

  assert.deepEqual(parseDelegateChildRounds(undefined), { value: 8, clamped: false });
  assert.deepEqual(parseDelegateChildRounds('99'), { value: 32, clamped: true });

  assert.deepEqual(parseDelegateChildTimeoutMs(undefined), { value: 240_000, clamped: false });
  assert.deepEqual(parseDelegateChildTimeoutMs('300000'), { value: 240_000, clamped: true },
    '上限必须 < 300000 的 agentd watchdog');
  assert.deepEqual(parseDelegateChildTimeoutMs('1'), { value: 1_000, clamped: true });
  assert.ok(parseDelegateChildTimeoutMs(undefined).value < 300_000, '默认值本身也必须小于 watchdog');
});

// ---------------------------------------------------------------------------
// 判据 8 —— 子工具面（不递归、无 notes、无 skills，且复用父实例）
// ---------------------------------------------------------------------------
test('D8 子工具面：只有文件工具 + shell，没有 delegate / note_* / skills；executeTool 是父的那一个', async () => {
  const h = harness({ engineResult: { finalText: 'ok', termination: { reason: 'end_turn' } } });
  await h.delegation.execute({ action: 'run', task: 't' }, parentContext());
  const childOptions = h.engine.calls[0];
  assert.ok(childOptions, '子 run 没跑起来');
  const names = childOptions.tools.map((t) => t.name);
  assert.deepEqual(names, [...h.face.fileTools.schemas, ...h.face.shellTools.schemas].map((s) => s.name));
  assert.ok(!names.includes('delegate'), `子的工具面不许有 delegate（v1 不递归）：${names.join(',')}`);
  assert.ok(!names.some((n) => n.startsWith('note_')), `子的工具面不许有 note_*（父子共用同一批笔记，并发写互踩）：${names.join(',')}`);
  assert.ok(!names.includes('runSkill'), `子的工具面不许有 skills 工具：${names.join(',')}`);
  // 子的执行口 = 父的那一个（对象引用相等 ⇒ 同一个 registry ⇒ 同一个 jail）
  assert.equal(childOptions.executeTool, h.executeToolRef, '子的 executeTool 必须是父的那个实例（重建就多一个漂移的边界）');
  assert.equal(childOptions.provider, h.providerRef, '子复用父的 provider 实例（同一凭据 / 同一超时口径）');
  // 复用父实例 ⇒ 只有一个 jail：worker 侧的接线形状（重建一套就多一个可能与父漂移的边界）
  const src = readWorkerSource();
  assert.match(src, /childTools: \[\.\.\.fileTools\.schemas, \.\.\.shellTools\.schemas\]/,
    '子的工具面必须由父的 fileTools/shellTools 实例给出（显式，不是从父数组 filter）');
  assert.match(src, /createStationDelegation\(\{[\s\S]*?executeTool,\n/,
    '子的 executeTool 必须是父的那一个（同一个 registry ⇒ 同一个 jail）');
  // 子的 system prompt 是那段短的，不是父的 SYSTEM_PROMPT
  assert.equal(childOptions.config.input.system, CHILD_SYSTEM_PROMPT);
  assert.doesNotMatch(childOptions.config.input.system, /delegate\(action|预览 URL|AGENTS\.md/,
    '子的提示词不许带父那段里的 delegate 用法 / 预览端口 / AGENTS 注入（对子全是噪音）');
  assert.match(childOptions.config.input.system, /没有 delegate|没有.*delegate/);
});

// ---------------------------------------------------------------------------
// 判据 9 —— deadlineMs 换算（时长 → 绝对时刻）
// ---------------------------------------------------------------------------
test('D9 deadline：config.timing.deadlineMs = clock() + 预算（不是把时长直接透传）', async () => {
  const FIXED = 1_700_000_000_000;
  const h = harness({ clock: () => FIXED, childDeadlineMs: 123_456, engineResult: { finalText: 'x' } });
  await h.delegation.execute({ action: 'run', task: 't' }, parentContext());
  assert.equal(h.engine.calls[0].config.timing.deadlineMs, FIXED + 123_456,
    '引擎读的是绝对时刻；库里那个 deadlineMs 是时长 ⇒ 换算只能发生在 runChild 这一处');

  // 模型自己给的 deadlineMs（时长）优先于宿主默认，同样要换算
  const h2 = harness({ clock: () => FIXED, childDeadlineMs: 123_456, engineResult: { finalText: 'x' } });
  await h2.delegation.execute({ action: 'run', task: 't', deadlineMs: 5_000 }, parentContext());
  assert.equal(h2.engine.calls[0].config.timing.deadlineMs, FIXED + 5_000);

  // 没注入时钟时：差值 ≈ 预算（< 5s）
  const h3 = harness({ engineResult: { finalText: 'x' } });
  const before = Date.now();
  await h3.delegation.execute({ action: 'run', task: 't' }, parentContext());
  const after = Date.now();
  const deadline = h3.engine.calls[0].config.timing.deadlineMs;
  assert.ok(deadline >= before + 240_000 && deadline <= after + 240_000 + 5_000,
    `deadlineAt 必须落在 now+预算 附近：${deadline} vs ${before}+240000`);
});

test('D9b 子的 run 配置：真 runId / parentRunId / 轮数 / 折叠策略与不重放', async () => {
  const h = harness({ childMaxRounds: 3, engineResult: { finalText: 'x' } });
  const run = await h.delegation.execute({ action: 'run', task: 't' }, parentContext());
  const cfg = h.engine.calls[0].config;
  assert.equal(cfg.run.runId, run.runId);
  assert.ok(run.runId.startsWith('sub-'), `子 runId 由库生成（sub-<uuid>）：${run.runId}`);
  assert.equal(cfg.run.parentRunId, STATION_RUN_ID);
  assert.equal(cfg.run.maxRounds, 3);
  assert.equal(cfg.run.stream, true);
  assert.equal(cfg.run.replayPolicy, 'per-tool-declaration');
  assert.deepEqual(cfg.folding.context, { strategy: 'fold-llm', keepRounds: 6 });
  assert.equal(cfg.input.initialUserMessage, 't', '子的任务必须作为种子用户消息进去');
  assert.equal(Object.hasOwn(cfg, 'metadata'), false, '没给 modelMetadata / maxTokens ⇒ 整组缺席（不要写一个空对象上去）');

  // 给了就要真到引擎（与父同源）
  const h2 = harness({
    modelMetadata: { contextWindowTokens: 262_144, maxOutputTokens: 32_768 },
    maxTokens: 32_768,
    engineResult: { finalText: 'x' },
  });
  await h2.delegation.execute({ action: 'run', task: 't' }, parentContext());
  assert.deepEqual(h2.engine.calls[0].config.metadata.modelMetadata,
    { contextWindowTokens: 262_144, maxOutputTokens: 32_768 });
  assert.equal(h2.engine.calls[0].config.tuning.maxTokens, 32_768);

  // 本站 worker 递的是 **snake_case 快照**（camelCase 三键在 worker.js 里只允许出现一次 = #309 的锁），
  // 映射在本文件 ⇒ 子拿到的元数据与父同源。
  const h3 = harness({
    engineModelMetadata: { context_window: 131_072, max_output_tokens: 16_384 },
    engineResult: { finalText: 'x' },
  });
  await h3.delegation.execute({ action: 'run', task: 't' }, parentContext());
  assert.deepEqual(h3.engine.calls[0].config.metadata.modelMetadata,
    { contextWindowTokens: 131_072, maxOutputTokens: 16_384 });
  assert.equal(h3.engine.calls[0].config.tuning.maxTokens, 16_384);
});

// ---------------------------------------------------------------------------
// 判据 10 —— 保活节流
// ---------------------------------------------------------------------------
test('D10 保活：子跑 60s 期间心跳 ≥1 次且 ≤5 次（15s 节流）', async () => {
  const start = 1_000;
  let now = start;
  const h = harness({
    clock: () => now,
    livenessIntervalMs: 15_000,
    engineResult: { finalText: 'ok', termination: { reason: 'end_turn' } },
    onEngineCall: (options) => {
      // 模拟引擎在 60s 里每 500ms 发一个事件（121 个）
      for (let t = 0; t <= 60_000; t += 500) {
        now = start + t;
        options.onEvent({ type: 'round_start', round: 1 });
      }
    },
  });
  await h.delegation.execute({ action: 'run', task: 't' }, parentContext());
  assert.ok(h.liveness.length >= 1 && h.liveness.length <= 5,
    `60s / 15s 节流应当 1–5 次（去掉节流会爆到 121，去掉保活是 0）：${h.liveness.length}`);
  assert.ok(h.liveness.every((id) => id.startsWith('sub-')), '心跳必须带子的 runId（worker 拼 delegate:<id>）');
});

test('D10b 保活节流器：同一 id 在间隔内只放行一次，不同 id 互不影响；观察者抛错不炸', () => {
  let now = 0;
  const seen = [];
  const fire = createLivenessThrottle({ intervalMs: 15_000, clock: () => now, onEvent: (id) => { seen.push(id); } });
  assert.equal(fire('a'), true);
  now = 14_999;
  assert.equal(fire('a'), false);
  now = 15_000;
  assert.equal(fire('a'), true);
  assert.equal(fire('b'), true, '另一个子不该被 a 的水位挡住');
  assert.deepEqual(seen, ['a', 'a', 'b']);

  const boom = createLivenessThrottle({ clock: () => 0, onEvent: () => { throw new Error('ipc down'); } });
  assert.doesNotThrow(() => boom('c'), '心跳是加分项，抛错不许打死子 run');
});

// ---------------------------------------------------------------------------
// 目录布局反证 —— 手拼路径必须与引擎文件 store 的口径一致
// ---------------------------------------------------------------------------
test('D11 目录：transcriptPathFor 手拼的路径 = 真 createFileTranscriptStore 落盘的路径', async () => {
  const h = harness();
  const run = await h.delegation.execute({ action: 'run', task: '真引擎跑一次' }, parentContext());
  const record = readRoster(h.delegation.rosterDir, run.runId);
  assert.equal(record.transcriptPath, path.join(h.dir, 'delegation', 'transcripts', `${run.runId}.jsonl`));
  assert.ok(fs.existsSync(record.transcriptPath),
    `名册登记的账本路径必须真的存在（子 runId 过 safeRunId 恒等）：${record.transcriptPath}`);

  // 再反证一次：直接拿引擎 store 写一条，路径必须与 transcriptPathFor 逐字相同
  const store = createFileTranscriptStore({ dir: h.delegation.transcriptsDir });
  const probeId = `sub-${'0'.repeat(8)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(4)}-${'0'.repeat(12)}`;
  await store.appendRound(probeId, { round: 0, message: { role: 'user', content: [{ type: 'text', text: 'probe' }] } });
  assert.ok(fs.existsSync(h.delegation.transcriptPathFor(probeId)), '引擎写的位置必须就是宿主登记的位置');
});

test('D12 isProcessAlive：ESRCH 才算死，EPERM 与其它错误码都算活', () => {
  assert.equal(isProcessAlive(process.pid), true, '自己当然活着');
  assert.equal(isProcessAlive(0), false, '非正整数不是 pid');
  assert.equal(isProcessAlive(-3), false);
  assert.equal(isProcessAlive(1e300), true,
    '过了「正整数」闸门但 process.kill 认不得 ⇒ 落「其它错误码算活」的 fail-safe（与 bin/delegation.js 同语义）');
  assert.equal(isProcessAlive(Number.NaN), false, 'NaN 不是正整数，闸门就挡掉');
  // 一个大概率不存在的 pid ⇒ ESRCH ⇒ 死（库靠这个谓词把孤儿名册判 interrupted）
  assert.equal(isProcessAlive(2_000_000_000), false);
});

test('D13 建装配的入参闸门：缺 parentRunId / delegationDir / childTools 当场抛', () => {
  assert.throws(() => createStationDelegation({ delegationDir: '/tmp/x', childTools: [] }), TypeError);
  assert.throws(() => createStationDelegation({ parentRunId: 'r', childTools: [] }), TypeError);
  assert.throws(() => createStationDelegation({ parentRunId: 'r', delegationDir: '/tmp/x' }), TypeError);
});

// ---------------------------------------------------------------------------
// 目录属主（决策者补充的第 4 条）：agentd 必须**预建并改属主**，worker 不能自己建
// ---------------------------------------------------------------------------
test('D14 agentd 预建 delegation 三目录（幂等、叶子属 worker）；worker 只认下行的 delegation_dir', async () => {
  const { prepareDelegationDirs, DELEGATION_SUBDIRS } = await import('../lib/run-data.js');
  const home = tmpDir('home');
  const env = { workerUid: process.getuid?.() ?? 0, workerGid: process.getgid?.() ?? 0 };

  const dir = prepareDelegationDirs(home, env);
  assert.equal(dir, path.join(home, 'delegation'));
  for (const sub of ['roster', 'leases', 'transcripts']) {
    assert.ok(fs.statSync(path.join(dir, sub)).isDirectory(), `子目录 ${sub} 必须预建`);
    assert.ok(DELEGATION_SUBDIRS.includes(sub), `三目录的清单与 run-data 不同源：${sub}`);
  }
  // 幂等：再跑一次不炸（run 重启 / requeue 会反复走到这一段）
  assert.doesNotThrow(() => prepareDelegationDirs(home, env));

  // 接线形状：agentd 只在开关开时建，并把路径下行；worker 只读 `msg.delegation_dir`
  const agentd = fs.readFileSync(path.join(RUNNER_DIR, 'agentd.js'), 'utf8');
  assert.match(agentd, /if \(isDelegateEnabled\(process\.env\.ERIX_DELEGATE_ENABLED\)\) \{[\s\S]{0,400}prepareDelegationDirs\(CFG\.home/, 
    'agentd 必须在开关开时预建 delegation 目录（1001 建的 755 目录 1002 写不进）');
  assert.match(agentd, /delegation_dir: ctx\.delegationDir/, '建好的路径必须下行（路径只有一个真相源）');
  assert.doesNotMatch(agentd, /prepareDelegationDirs[\s\S]{0,200}releaseAndRequeue/,
    'delegation 目录建不出来只 warn，**不许**因此 requeue（加分项不打死 run）');

  const worker = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  assert.match(worker, /msg\.delegation_dir/, 'worker 必须读下行的 delegation_dir');
});

test('D15 worker 心跳接线：走 SHELL_LIVENESS.heartbeat（不走 emitEvent），command 带子的 runId', () => {
  const worker = readWorkerSource();
  assert.match(worker, /onChildLiveness:\s*\(childRunId\) => sendIpc\(process, \{\s*type: MSG\.SHELL_LIVENESS, run_id: runId, phase: 'heartbeat', command: 'delegate:' \+ childRunId,/,
    '保活必须走 SHELL_LIVENESS heartbeat（走 emitEvent 会多一条用户可见事件）');
  assert.match(worker, /parentSignal: abortController\.signal/, '中止级联：父的 abortController.signal 必须递进去');
});
