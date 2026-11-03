// issue #421 判据（runner 侧）：`lib/engine-notices.js` 的五条运维嘴。
//
// 这一族测要防的是两件事，分开钉：
//   ① 嘴漏（引擎发了、本站没接）⇒ E1/E2 逐条要求出文案；
//   ② **推测键**（本站按记忆造形状）⇒ E5 拿已安装引擎源码做对账，口径同 `compact-knobs.test.js`
//      的 K12 与 `fold-notes.test.js` 的 C18。前例两条：`payload.chars`、`foldSummary.unshrinkable`
//      ——推测键的后果不是报错，是**永不触发**（AGENTS §8.73）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { engineDiagnosticNotice, summarizerFailureNotice } from '../lib/engine-notices.js';

const RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 定位**装在本 worktree 里的**引擎根目录（与 `fold-notes.test.js` 的 C18 同一手法：不信注释、不信夹具）。 */
function engineRootOrNull() {
  let dir;
  try { dir = path.dirname(createRequire(import.meta.url).resolve('erix-agent')); }
  catch { return null; }
  while (dir !== path.dirname(dir)) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') return dir;
    dir = path.dirname(dir);
  }
  return null;
}

test('E1 四类诊断事件各出一条 warn，且关键字段进文案（不许静默）', () => {
  const cases = [
    // 载荷逐条对着引擎发射点写：orchestrator.js:3193 / :1040 / :1011 / :2525
    { event: { type: 'compaction_strategy_fallback', round: 7, detail: 'engine compaction fallback in effect' },
      must: ['sliding-window', 'round 7'] },
    { event: { type: 'model_metadata_missing', detail: 'contextWindowTokens/maxOutputTokens unavailable' },
      must: ['model metadata missing', 'disabled for this run'] },
    { event: { type: 'persistence_capability_degraded', method: 'saveRunSnapshot', detail: 'store does not implement' },
      must: ['saveRunSnapshot', 'skipped for this run'] },
    { event: { type: 'resume_journal_skipped', round: 4, count: 3, reason: 'crash_round_assistant_not_in_ledger' },
      must: ['3 tool result(s)', 'round 4', 'crash_round_assistant_not_in_ledger'] },
  ];
  for (const { event, must } of cases) {
    const n = engineDiagnosticNotice(event);
    assert.ok(n, `${event.type} 必须接出一条（接不出就等于运维看不见）`);
    assert.equal(n.level, 'warn', `${event.type} 是告警，不是 info`);
    for (const m of must) assert.ok(n.msg.includes(m), `${event.type} 文案里必须有「${m}」，实得：${n.msg}`);
  }
});

test('E2b issue #438 切片 B：0.29 新增的三类各有一条嘴，级别按「每轮都有 ⇒ info / 异常才 warn」判', () => {
  // 载荷逐条对着引擎发射点写：orchestrator.js:4884 / :4056 / :1271
  const deferred = engineDiagnosticNotice({ type: 'compaction_deferred', round: 3, reason: 'pending_tool_use' });
  assert.ok(deferred, 'compaction_deferred 必须接出一条');
  assert.equal(deferred.level, 'info', '推迟折叠是正常形态（每轮最多一条）⇒ info，不许占 warn 面');
  assert.match(deferred.msg, /round 3/);
  assert.match(deferred.msg, /pending_tool_use/);

  const budget = engineDiagnosticNotice({
    type: 'budget_below_working_set', round: 5, budgetTokens: 9000, workingSetTokens: 15000,
    suggestedBudgetTokens: 24000, attempts: 3, repeatStreak: 2, foldLayersOverBudget: 1,
  });
  assert.ok(budget);
  assert.equal(budget.level, 'warn', '预算装不下工作集 ⇒ run 提前收尾，是异常，必须 warn');
  for (const needle of ['15000', '9000', '3', '24000']) {
    assert.ok(budget.msg.includes(needle), `文案里必须有「${needle}」，实得：${budget.msg}`);
  }

  const conflict = engineDiagnosticNotice({
    type: 'config_override_conflict', conflicts: [{ path: 'run.maxRounds', key: 'maxRounds' }],
  });
  assert.ok(conflict);
  assert.equal(conflict.level, 'warn', '配置冲突 = 宿主代码 bug ⇒ warn');
  assert.match(conflict.msg, /run\.maxRounds/);
  // 数组缺席 ≠ 零条冲突（引擎只在 >0 时才发）⇒ 写 ?，不拿 0 冒充（#283）
  assert.match(engineDiagnosticNotice({ type: 'config_override_conflict' }).msg, /conflict: \?/);
  // 脏 path 过形状闸（#261）
  const dirtyPath = engineDiagnosticNotice({ type: 'config_override_conflict', conflicts: [{ path: { x: 1 } }] });
  assert.doesNotMatch(dirtyPath.msg, /\[object Object\]/);
  assert.match(dirtyPath.msg, /\(\?\)/);
});

test('E2c issue #442（0.30.0）：27 类里新接的 5 个运维嘴，级别按「结构上不该发生 ⇒ warn / 正常形态 ⇒ info」判', () => {
  // 载荷逐条对着引擎发射点写（不凭记忆造键）：
  //   final_guard_extend     orchestrator.js:4744 / :4849
  //   context_unknown_option assembly.js:999
  //   tool_output_aggregate  run-snapshot-executor.js:218
  //   continuity_write_failed orchestrator.js:3277/3355/3401
  //   user_turn_guard_unrecoverable orchestrator.js:2716
  const guardExtend = engineDiagnosticNotice({
    type: 'final_guard_extend', round: 4, from_max_rounds: 12, to_max_rounds: 16, guard_extension: true,
  });
  assert.ok(guardExtend, 'final_guard_extend 必须接出一条');
  assert.equal(guardExtend.level, 'warn', '本站不传 finalGuard ⇒ 一响就是配置面变了，必须 warn');
  for (const needle of ['round 4', '12 -> 16', 'guard_revise', 'never passes finalGuard']) {
    assert.ok(guardExtend.msg.includes(needle), `文案里必须有「${needle}」，实得：${guardExtend.msg}`);
  }
  // 交付物补齐那一支复用同一个事件名，但 `guard_extension: false` + `reason: 'deliverables_failed'`
  const gap = engineDiagnosticNotice({
    type: 'final_guard_extend', round: 4, from_max_rounds: 12, to_max_rounds: 13,
    guard_extension: false, reason: 'deliverables_failed', deliverables_failed: 2,
  });
  assert.match(gap.msg, /trigger=deliverables_failed/);

  const unknownOption = engineDiagnosticNotice({ type: 'context_unknown_option', keys: ['budgetTokens', 'foo'] });
  assert.ok(unknownOption);
  assert.equal(unknownOption.level, 'warn');
  assert.match(unknownOption.msg, /budgetTokens, foo/);
  assert.match(unknownOption.msg, /2 key\(s\)/);
  // `keys` 缺席 ≠ 零个（引擎只在 >0 时才发）⇒ 写 ?，不拿 0 冒充（#283）
  assert.match(engineDiagnosticNotice({ type: 'context_unknown_option' }).msg, /\? key\(s\)/);

  const aggregate = engineDiagnosticNotice({
    type: 'tool_output_aggregate', round: 6, toolUseId: 'call_1', name: 'bash', action: 'archived',
    reason: 'round_budget_exceeded', budgetTokens: 8000, inlineTokens: 9100, costTokens: 4000,
    projectedTokens: 13100, contentLength: 51200, archivedBytes: 51200,
  });
  assert.ok(aggregate);
  assert.equal(aggregate.level, 'info', '聚合是正常形态（每轮可多条）⇒ info，不许占 warn 面');
  for (const needle of ['round 6', 'archived', 'round_budget_exceeded', 'bash', '51200', 'contentLength=51200', 'inline=9100/budget=8000']) {
    assert.ok(aggregate.msg.includes(needle), `文案里必须有「${needle}」，实得：${aggregate.msg}`);
  }

  const writeFailed = engineDiagnosticNotice({ type: 'continuity_write_failed', round: 9 });
  assert.ok(writeFailed);
  assert.equal(writeFailed.level, 'warn');
  assert.match(writeFailed.msg, /round 9/);
  assert.match(writeFailed.msg, /handoff=off/);

  const unrecoverable = engineDiagnosticNotice({
    type: 'user_turn_guard_unrecoverable', round: 3, channel: 'request', reason: 'no_user_turn',
  });
  assert.ok(unrecoverable);
  assert.equal(unrecoverable.level, 'warn', '请求会原样发出、上游多半 400 ⇒ 必须 warn');
  assert.match(unrecoverable.msg, /round 3/);
  assert.match(unrecoverable.msg, /channel=request/);
  assert.match(unrecoverable.msg, /no_user_turn/);

  // 明确豁免：`continuity_written` / `continuity_injection_skipped` 是展示类事实，不是告警 ⇒ 不接。
  // 这条反向断言把「不接」钉成**决定**，而不是将来某次新增时的手滑。
  for (const type of ['continuity_written', 'continuity_injection_skipped']) {
    assert.equal(engineDiagnosticNotice({ type, round: 1 }), null,
      `${type} 不该出 LOG 文案（它是展示类事实，豁免理由在 portal/test/event-surface-contract.test.js）`);
  }
});

test('E2 run_outcome 每轮都有 ⇒ 走 info，不许刷成 warn（否则 warn 面被淹）', () => {
  const n = engineDiagnosticNotice({
    type: 'run_outcome', rounds: 12, judgeRecordCount: 3,
    termination: { reason: 'end_turn' }, verification: { done: true },
  });
  assert.ok(n);
  assert.equal(n.level, 'info');
  assert.match(n.msg, /reason=end_turn/);
  assert.match(n.msg, /rounds=12/);
  assert.match(n.msg, /judgeRecords=3/);
});

test('E3 数字没给就写 ?，绝不拿 0 冒充（#283 口径）', () => {
  const a = engineDiagnosticNotice({ type: 'resume_journal_skipped' });
  assert.ok(a);
  assert.match(a.msg, /\? tool result\(s\)/);
  assert.match(a.msg, /crash round \?/);
  assert.doesNotMatch(a.msg, /0 tool result|round 0\b/, '缺失必须显式成 ?，写成 0 就是编数据');
  const b = engineDiagnosticNotice({ type: 'compaction_strategy_fallback' });
  assert.match(b.msg, /round \?/);
  const c = engineDiagnosticNotice({ type: 'run_outcome' });
  assert.match(c.msg, /reason=\? rounds=\? judgeRecords=\?/);
});

test('E4 外来标识符过形状闸：不给字符串就退 ?，绝不 [object Object]（#261 口径）', () => {
  const dirty = [{ method: { toString: () => 'x' } }, { method: 'a b;rm -rf' }, { method: '' }, { method: null }];
  for (const event of dirty) {
    const n = engineDiagnosticNotice({ type: 'persistence_capability_degraded', ...event });
    assert.ok(n);
    assert.match(n.msg, /does not implement "\?"/, `脏 method ${JSON.stringify(event.method)} 必须退成 ?`);
    assert.doesNotMatch(n.msg, /\[object Object\]/);
  }
  // 合法形状（含下划线/点号）照原样保留——闸不能把真值也刷掉
  const ok = engineDiagnosticNotice({ type: 'persistence_capability_degraded', method: 'append_checkpoint' });
  assert.match(ok.msg, /"append_checkpoint"/);
});

// ── S1 issue #442（erix-agent 0.30.0 / 上游 #661）：**折叠失败 ⇒ run 失败**的运维嘴 ─────────
//
// 这不是一条事件（那条失败路径一个 compaction 事件都不发），所以它不住在 `engineDiagnosticNotice`
// 的 switch 里，而是吃 worker 的失败终态片段。判据口径与工单 §M3.2 一致：模拟该终局 ⇒ 有 LOG。
test('S1 摘要器失败的终局 ⇒ 一条 warn（说清「这是失败，不是降级」）；别的失败 ⇒ null', () => {
  // 真终态形状（0.30.0 实测：`termination.errorCode` 与宿主 `error.code` 是同一份码的两个挂载点）
  const notice = summarizerFailureNotice({
    termination: { reason: 'failed', errorCode: 'summarizer_failed' },
    error: { code: 'summarizer_failed', message: 'summarizer timed out', details: { kind: 'timeout' } },
  });
  assert.ok(notice, '摘要器失败的终局必须接出一条（接不出就等于运维只看到裸 failed）');
  assert.equal(notice.level, 'warn');
  for (const needle of ['THIS RUN FAILED', 'not a degraded statistical summary', 'kind=timeout',
    'reason=failed', 'errorCode=summarizer_failed', 'NOT compacted']) {
    assert.ok(notice.msg.includes(needle), `文案里必须有「${needle}」，实得：${notice.msg}`);
  }
  // 两个挂载点各自都能单独命中（引擎改了挂载点时不会静默漏）
  assert.ok(summarizerFailureNotice({ termination: { reason: 'failed', errorCode: 'summarizer_failed' } }));
  assert.ok(summarizerFailureNotice({ error: { code: 'summarizer_failed' } }));
  // 归因分类缺失/脏值 ⇒ `?`，不拿假值冒充（#283 / #261）
  const bare = summarizerFailureNotice({ error: { code: 'summarizer_failed', details: { kind: { x: 1 } } } });
  assert.match(bare.msg, /kind=\?/);
  assert.doesNotMatch(bare.msg, /\[object Object\]/);
  // 反向：别的失败/中止/空入参一个都不许被这条嘴吞掉（否则每类失败都变成「摘要器失败」）
  for (const input of [
    { termination: { reason: 'failed' }, error: { code: 'llm_error', message: 'boom' } },
    { termination: { reason: 'aborted' }, error: { code: 'aborted' } },
    { termination: { reason: 'persistence_failed' }, error: { code: 'persistence_failed' } },
    {}, undefined, null,
  ]) {
    assert.equal(summarizerFailureNotice(input), null, `${JSON.stringify(input)} 不该出「摘要器失败」告警`);
  }
});

test('S2 worker 的失败路径真接着这条嘴（删掉那两行就红，不靠注释自觉）', () => {
  const src = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  const at = src.indexOf('const summarizerFailure = summarizerFailureNotice({');
  assert.ok(at > 0, 'worker.js 的 catch 里没有 summarizerFailureNotice 调用 ⇒ 折叠失败又变回裸 failed');
  const block = src.slice(at, at + 400);
  assert.match(block, /sendIpc\(process, \{ type: MSG\.LOG, run_id: runId, level: summarizerFailure\.level/,
    '接出来了却没发 LOG ⇒ 等于没接');
  // 红线：它**只记日志**，不许改终态、不许改事件（终态是引擎判的）
  const around = src.slice(Math.max(0, at - 800), at + 800);
  assert.doesNotMatch(around, /termination\s*=\s*\{/,
    '这段不许改 termination（终态由引擎判；把摘要器失败改写成别的 reason 就是伪造终态）');
});

test('E5 非诊断类型返回 null（本模块不许什么都接，否则每轮多一条噪声）', () => {
  for (const event of [
    { type: 'round_start', round: 1 }, { type: 'compaction', foldedRounds: 2 },
    { type: 'tool_result' }, { type: 'usage' }, undefined, null, 'compaction_strategy_fallback',
  ]) {
    assert.equal(engineDiagnosticNotice(event), null, `${JSON.stringify(event)} 不该出文案`);
  }
});

test('E6 【防推测键】本模块接的 13 类，已安装引擎必须真发（源码对账）', (t) => {
  const root = engineRootOrNull();
  if (!root) return t.skip('未安装 erix-agent，无从对账');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const loop = read('src/loop/orchestrator.js');
  const records = read('src/loop/judge-record.js');
  // 发射点逐条对：上游哪天不发这类事件，本站这条嘴就该跟着删（留着 = 永不触发的死支）。
  for (const kind of ['compaction_strategy_fallback', 'model_metadata_missing',
    'persistence_capability_degraded', 'resume_journal_skipped',
    // issue #438 切片 B（0.29.0 的 LoopEvent 新增三类）
    'compaction_deferred', 'budget_below_working_set', 'config_override_conflict',
    // issue #442（0.30.0）：这四条住在 `orchestrator.js`
    'final_guard_extend', 'continuity_write_failed', 'user_turn_guard_unrecoverable']) {
    assert.match(loop, new RegExp(`type: "${kind}"`),
      `引擎源码里已找不到 type: "${kind}" 的发射点：本站这条嘴该删`);
  }
  // 剩下两条不在 orchestrator.js：聚合层在 `loop/run-snapshot-executor.js`，装配口在 `assembly.js`。
  assert.match(read('src/loop/run-snapshot-executor.js'), /type: "tool_output_aggregate"/,
    '引擎不再发 tool_output_aggregate ⇒ 本站那条 info 是死支');
  assert.match(read('src/assembly.js'), /"context_unknown_option"/,
    '引擎不再发 context_unknown_option ⇒ 本站那条 warn 是死支');
  // `run_outcome` 的记录体在 judge-record.js（orchestrator 里那处只是观察者报错标签），
  // 本模块读的 `judgeRecordCount` 也必须在那儿真存在。
  assert.match(records, /type: "run_outcome"/, '引擎不再造 run_outcome 记录 ⇒ 本站那条 info 是死支');
  assert.match(records, /judgeRecordCount/, '引擎不再给 judgeRecordCount ⇒ 文案里的 judgeRecords 会永远成 ?');
  // 反向：本模块**代码面**不许出现历史上栽过的推测键名（注释里提到它们是允许的，所以先剖注释）。
  const mine = fs.readFileSync(path.join(RUNNER_DIR, 'lib/engine-notices.js'), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const fake of ['unshrinkable', 'chars']) {
    assert.equal(mine.includes(fake), false, `本站代码面又引入了「${fake}」这类推测键`);
  }
});

test('#442 已退役的 degradeKind 不许在代码里复活（注释可以提，可执行代码读它就是回归）', () => {
  // 主 agent 亲跑变异发现的真覆盖缺口：往 `engine-notices.js` 里加一个读 `stat.degradeKind` 的函数，
  // 原有用例 10/10 全绿 —— 因为 0.30 起引擎**不再生产**这个键（`fold-llm.js:266` 的「降级为统计摘要」
  // 那条路径已删，run 直接 `failed` + `errorCode='summarizer_failed'`），所以行为级用例永远喂不出它。
  // ⇒ 用源码级判据钉住：剥掉注释后不许出现 `degradeKind`。
  const src = fs.readFileSync(new URL('../lib/engine-notices.js', import.meta.url), 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
    .replace(/^\s*\/\/.*$/gm, '')        // 整行注释
    .replace(/\s\/\/.*$/gm, '');         // 行尾注释
  assert.ok(!/degradeKind/.test(code),
    '`engine-notices.js` 的可执行代码里不许再读 `degradeKind`（0.30 起引擎不生产它；'
    + '摘要器失败是终局错误，由 `summarizerFailureNotice` 承接）');
});
