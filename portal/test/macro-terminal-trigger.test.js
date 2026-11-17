// issue #646（事件平台 · M1 终态通知 / M9 完成审查**没有触发源**）：`finishRun` 此前一行都没碰
// 宏平台 ⇒ `run-notify`/`run-review` 零发生。本文件钉「终态收敛后产生宏意图并交给 dispatcher」这条链。
//
// 环境门（口径照抄 `portal/test/delta-not-persisted-db.test.js`）：`TEST_DATABASE_URL` 未设置 ⇒
// 真库用例整体 skip（不是假通过：rc 里带着 skip 计数可查）。跑法：
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15480/station_test \
//     node --test portal/test/macro-terminal-trigger.test.js
//
// 判据落点（对应工单「判据」5 条 + ②）：
//   1  run-notify(states 含 failed) + run 失败 ⇒ macro_runs 出现 anchor='run:<id>' 的账 + notifications 落一行
//   2  同一条 run 终态重放 ⇒ 不新增第二条账（幂等键 (assignment,run:<id>,terminal,b0)）
//   3  run-review 订阅 + run 终态 ⇒ 出现审查账
//   4  派发抛异常 ⇒ 终态收敛照常完成（不阻塞、不冒泡）
//   5  没传 onMacroIntents ⇒ 静默跳过（既有终态行为零变化、不炸）
//   ②  digest 那一路（run-silence-alert，anchor='digest:<date>' + criterion='tick'）被 dispatcher 消费
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimRun, setRunState, emitTerminalMacroIntents, macroStateOfTermination, TERMINATION_REASON_TO_MACRO_STATE, REVIEWABLE_MACRO_STATES } from '../src/internal.js';
import { claimMacroRun } from '../src/macros.js';
import { createIntentDispatcher, isExpiryIntent, extractReviewRunId } from '../src/macro-dispatcher.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w646' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { poolMax: 2, log: () => {} });

const TOKEN = 'tok-646-runner';
const SILENT = { log() {}, info() {}, warn() {}, error() {} };

// 全 uuid（schema 里 users/projects/chat_sessions/runs/run_queue/macro_* 主外键都是 uuid）。
const ids = (tag) => ({
  userId: crypto.randomUUID(), projectId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(), containerId: crypto.randomUUID(), templateId: crypto.randomUUID(),
  assignmentId: crypto.randomUUID(),
  login: `a${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
});

// 一套可认领的真库现场 + 一条会话上的宏订阅（kind/params 由调用方给）。
async function seedScene(pool, s, { kind, params }) {
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1,$2,'x','active')`,
    [s.userId, s.login],
  );
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1,$2,$3,'git@x:y/z.git','~/projects/x',0)`,
    [s.projectId, s.userId, `p${s.login}`],
  );
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1,$2,$3,'img','0.33.0','running',$4,$5)`,
    [s.containerId, s.userId, hashToken(TOKEN), s.login, `fde-${s.login}`],
  );
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, model, cwd, status)
     VALUES ($1,$2,$3,'t','mock-model','~/projects/x','active')`,
    [s.sessionId, s.userId, s.projectId],
  );
  await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1,$2,'queued')`, [s.runId, s.sessionId]);
  await pool.query(
    `INSERT INTO run_queue (run_id, container_id, status, attempts, max_attempts)
     VALUES ($1,$2,'pending',0,3)`,
    [s.runId, s.containerId],
  );
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, params, audience, scope, enabled)
     VALUES ($1,$2,$3,$4,'all','session',true)`,
    [s.templateId, kind, `宏-${kind}`, JSON.stringify(params)],
  );
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, enabled)
     VALUES ($1,$2,$3,$4,true)`,
    [s.assignmentId, s.templateId, s.userId, s.sessionId],
  );
  return { container: { id: s.containerId, user_id: s.userId }, user: { id: s.userId, login: s.login } };
}

// 认领并起跑，返回续跑终态需要的 live（同 claimToken）。
async function startRunning(pool, live, s) {
  const ticket = await claimRun(pool, { container: live.container, user: live.user, capacity: 1, holdMs: 10 });
  await setRunState(pool, {
    container: live.container, user: live.user, runId: s.runId, claimToken: ticket.claim_token,
    body: { state: 'running' },
  });
  return { ...live, claimToken: ticket.claim_token };
}

const countTerminalRuns = (pool, runId) => pool.query(
  `SELECT count(*)::int AS n FROM macro_runs WHERE anchor = $1 AND criterion = 'terminal'`,
  [`run:${runId}`],
);
const countNotifications = (pool, userId) => pool.query(
  `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [userId],
);

// ── 判据 1：run-notify(states 含 failed) + run 失败 ⇒ macro_runs 账 + notifications 行 ─────────
test('#646① run-notify(states=[failed]) + run 失败 ⇒ macro_runs 出现 run:<id> 账 且 notifications 落一行', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('notify1');
    const live = await seedScene(pool, s, { kind: 'run-notify', params: { states: ['failed'], channel: 'site' } });
    const running = await startRunning(pool, live, s);
    const dispatcher = createIntentDispatcher({ pool, log: SILENT });
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'failed', termination: { reason: 'failed' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 1 },
      config: { onMacroIntents: (ints) => dispatcher.dispatch(ints) },
    });
    await out.macroIntents; // 等 fire-and-forget 落地，断言才确定
    assert.equal(out.state, 'failed');
    const runs = await countTerminalRuns(pool, s.runId);
    assert.equal(runs.rows[0].n, 1, 'macro_runs 应恰好出现一条 anchor=run:<id> criterion=terminal 的账');
    const notif = await countNotifications(pool, s.userId);
    assert.ok(notif.rows[0].n >= 1, 'notifications 应给该用户落至少一行（dispatcher 真的投递了）');
    // 账被 dispatcher 收成 done（run-notify 执行器 deliverIntent 不碰账，dispatcher 自己 finish done）
    const acct = await pool.query(
      `SELECT status FROM macro_runs WHERE anchor=$1 AND criterion='terminal'`, [`run:${s.runId}`],
    );
    assert.equal(acct.rows[0].status, 'done');
  });
});

// ── 判据 1b：states 不含该终态 ⇒ 不产账、不通知（默认 completed 不在 states 里）──────────────
test('#646①b run-notify(states=[failed]) 但 run 正常完成(end_turn→completed) ⇒ 不产账', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('notify1b');
    const live = await seedScene(pool, s, { kind: 'run-notify', params: { states: ['failed'] } });
    const running = await startRunning(pool, live, s);
    const dispatcher = createIntentDispatcher({ pool, log: SILENT });
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'finished', termination: { reason: 'end_turn' }, rounds: 1 },
      config: { onMacroIntents: (ints) => dispatcher.dispatch(ints) },
    });
    await out.macroIntents;
    assert.equal((await countTerminalRuns(pool, s.runId)).rows[0].n, 0, 'completed 不在 states ⇒ 不产通知账（避免通知疲劳）');
  });
});

// ── 判据 2：终态重放 ⇒ 不新增第二条账（幂等键）──────────────────────────────────────────────
test('#646② 同一条 run 的终态重放两次 ⇒ 仍只有一条 terminal 账（幂等键）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('replay2');
    await seedScene(pool, s, { kind: 'run-notify', params: { states: ['failed'] } });
    // 直接调产生端两次，模拟「finishRun 对同一条 run 被触发两次」——这是幂等键要挡的正是这一格。
    const seen = [];
    const hook = (ints) => { seen.push(...ints); };
    const term = { reason: 'failed' };
    await emitTerminalMacroIntents(pool, { runId: s.runId, sessionId: s.sessionId, termination: term, onMacroIntents: hook, log: SILENT });
    await emitTerminalMacroIntents(pool, { runId: s.runId, sessionId: s.sessionId, termination: term, onMacroIntents: hook, log: SILENT });
    assert.equal((await countTerminalRuns(pool, s.runId)).rows[0].n, 1, '重放必须只产一条账');
    assert.equal(seen.length, 1, '第二次 claim 返回 null ⇒ 不应再产意图交给 dispatcher');
  });
});

// ── 判据 3：run-review 订阅 + run 终态 ⇒ 审查账出现 ──────────────────────────────────────────
test('#646③ run-review 订阅 ⇒ run 失败终态后出现审查账（anchor=run:<id>）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('review3');
    const live = await seedScene(pool, s, { kind: 'run-review', params: { review_depth: 1, on_fail: 'reflow', max_rounds: 8 } });
    const running = await startRunning(pool, live, s);
    // 审查执行器很重（建 worktree + 模型）；这里桩掉它，只验「账产生了、evidence 带原 run id」。
    let reviewArg = null;
    const dispatcher = createIntentDispatcher({
      pool, log: SILENT,
      runMacroReview: async (_pool, arg) => { reviewArg = arg; return { macroRunId: arg.macroRunId, status: 'done', verdict: 'pass' }; },
    });
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'failed', termination: { reason: 'failed' }, rounds: 1 },
      config: { onMacroIntents: (ints) => dispatcher.dispatch(ints) },
    });
    await out.macroIntents;
    const acct = await pool.query(
      `SELECT status, assignment_id FROM macro_runs WHERE anchor=$1 AND criterion='terminal'`, [`run:${s.runId}`],
    );
    assert.equal(acct.rows.length, 1, '审查账应出现且只有一条');
    assert.equal(acct.rows[0].assignment_id, s.assignmentId);
    // dispatcher 用 evidence.runId（我们已塞）定位原 run，等价于 extractReviewRunId 的 anchor 解析
    assert.equal(reviewArg.originalRunId, s.runId, 'run-review 必须拿到原 run id（runMacroReview 靠它）');
    assert.equal(extractReviewRunId({ anchor: `run:${s.runId}` }), s.runId, 'anchor 解析口径也一致（双保险）');
  });
});

// ── 判据 3b：aborted（用户在场的正常停止）不触审查 ───────────────────────────────────────────
test('#646③b run-review 订阅 + aborted ⇒ 不审（人在场，审查是噪音）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('review3b');
    const live = await seedScene(pool, s, { kind: 'run-review', params: { review_depth: 1 } });
    const running = await startRunning(pool, live, s);
    const dispatcher = createIntentDispatcher({ pool, log: SILENT, runMacroReview: async (_p, a) => ({ macroRunId: a.macroRunId, status: 'done', verdict: 'pass' }) });
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'finished', termination: { reason: 'aborted' }, rounds: 1 },
      config: { onMacroIntents: (ints) => dispatcher.dispatch(ints) },
    });
    await out.macroIntents;
    assert.equal((await countTerminalRuns(pool, s.runId)).rows[0].n, 0, 'aborted 不审');
  });
});

// ── 判据 4：派发抛异常 ⇒ 终态收敛照常完成（不阻塞、不冒泡）─────────────────────────────────
test('#646④ onMacroIntents 抛异常 ⇒ run 终态收敛照常返回（失败只 warn）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('boom4');
    const live = await seedScene(pool, s, { kind: 'run-notify', params: { states: ['failed'] } });
    const running = await startRunning(pool, live, s);
    const boom = async () => { throw new Error('消费者炸了'); };
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'failed', termination: { reason: 'failed' }, rounds: 1 },
      config: { onMacroIntents: boom },
    });
    // 关键：setRunState 正常返回终态，且 macroIntents promise 自身已 catch（不会 unhandled rejection）。
    assert.equal(out.state, 'failed', '派发异常不得影响终态收敛返回');
    await assert.doesNotReject(out.macroIntents, 'fire-and-forget 内部必须吞掉派发异常');
    const run = await pool.query(`SELECT status FROM runs WHERE id=$1`, [s.runId]);
    assert.equal(run.rows[0].status, 'failed', 'run 自己的收尾照常完成');
  });
});

// ── 判据 5：没传 onMacroIntents ⇒ 静默跳过（既有终态行为零变化、不炸）─────────────────────────
test('#646⑤ 未注入 onMacroIntents ⇒ 静默跳过：终态照常、无宏账、macroIntents=null', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('silent5');
    const live = await seedScene(pool, s, { kind: 'run-notify', params: { states: ['failed'] } });
    const running = await startRunning(pool, live, s);
    const out = await setRunState(pool, {
      container: running.container, user: running.user, runId: s.runId, claimToken: running.claimToken,
      body: { state: 'failed', termination: { reason: 'failed' }, rounds: 1 },
      // 故意不传 config.onMacroIntents（模拟既有测试/旧接线）
    });
    assert.equal(out.state, 'failed');
    assert.equal(out.macroIntents, null, '未注入 hook ⇒ 不排任何宏意图任务（静默跳过）');
    assert.equal((await countTerminalRuns(pool, s.runId)).rows[0].n, 0);
  });
});

// ── ② digest 那一路（run-silence-alert，anchor='digest:<date>' + criterion='tick'）被 dispatcher 消费 ──
test('#646② digest 意图（criterion=tick, anchor=digest:<date>）走 tick 型 ⇒ 被 dispatcher 消费并收 done', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const s = ids('digest');
    await seedScene(pool, s, { kind: 'run-silence-alert', params: { threshold: '15m', phases: ['tool_running'] } });
    // 复刻 evalSilence 的 digest 产账口径（criterion='tick'、bucket=<date>、anchor='digest:<date>'）
    const date = '2026-11-16';
    const claimed = await claimMacroRun(pool, {
      assignmentId: s.assignmentId, anchor: `digest:${date}`, criterion: 'tick', bucket: date,
    });
    assert.ok(claimed, 'digest 账应能占位');
    const intent = {
      assignmentId: s.assignmentId, templateId: s.templateId, templateKind: 'run-silence-alert',
      templateName: '宏-run-silence-alert', params: { threshold: '15m', phases: ['tool_running'] },
      userId: s.userId, sessionId: s.sessionId, cwd: null,
      anchor: `digest:${date}`, criterion: 'tick', bucket: date,
      evidence: { digest: true, merged: 2, runs: [crypto.randomUUID(), crypto.randomUUID()] },
      macroRunId: claimed.id,
    };
    assert.equal(isExpiryIntent(intent), false, 'digest 不是到期意图（bucket!=expiry），不能被到期分支吞掉');
    let delivered = 0;
    const dispatcher = createIntentDispatcher({
      pool, log: SILENT,
      deliverIntent: async () => { delivered += 1; return { wrote: 1 }; },
    });
    const res = await dispatcher.dispatch([intent]);
    assert.equal(res.dispatched, 1, 'digest 意图被消费（未落 unknown-kind / 未报错）');
    assert.equal(delivered, 1, '走通知型执行器 deliverIntent ⇒ 真的投递了');
    const acct = await pool.query(`SELECT status FROM macro_runs WHERE id=$1`, [claimed.id]);
    assert.equal(acct.rows[0].status, 'done', 'run-silence-alert 投递后由 dispatcher 收成 done');
  });
});

// ── 纯函数：reason → 六个封闭态 映射（无 DB）────────────────────────────────────────────────
test('#646 reason→state 映射覆盖六个封闭态 + 未知 reason 归 completed', () => {
  // 五个非 completed 与引擎 reason 一一对应
  assert.equal(macroStateOfTermination('failed'), 'failed');
  assert.equal(macroStateOfTermination('max_rounds_cap'), 'capped');
  assert.equal(macroStateOfTermination('aborted'), 'aborted');
  assert.equal(macroStateOfTermination('persistence_failed'), 'persistence_failed');
  assert.equal(macroStateOfTermination('final_guard_unverified'), 'guard_unverified');
  // 正常收尾/未知 ⇒ completed
  for (const r of ['end_turn', 'judge_done', 'no_tool', 'stall', 'continuation_exhausted', 'whatever']) {
    assert.equal(macroStateOfTermination(r), 'completed', `${r} 应归 completed`);
  }
  // 映射结果只落在六个封闭值之内（shared/macro-kinds.js:56 的 states 集）
  const SIX = new Set(['completed', 'failed', 'capped', 'aborted', 'persistence_failed', 'guard_unverified']);
  for (const v of Object.values(TERMINATION_REASON_TO_MACRO_STATE)) assert.ok(SIX.has(v));
  // 审查保守集不含 aborted / persistence_failed
  assert.ok(!REVIEWABLE_MACRO_STATES.includes('aborted'));
  assert.ok(!REVIEWABLE_MACRO_STATES.includes('persistence_failed'));
  assert.ok(REVIEWABLE_MACRO_STATES.includes('completed'));
});
