// issue #525（事件平台 W2 评估循环）：`portal/src/macro-eval.js` 的用例。
//
// 环境门（口径照 `portal/test/macros.test.js`）：`TEST_DATABASE_URL` 未设置 ⇒ 真库用例整体 skip，
// 纯逻辑/假 pool 用例照跑。跑法：
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15498/station_test \
//     node --test portal/test/macro-eval.test.js
//
// 判据面（工单要求的 7 格各自的落点）：
//   ① 求值失败不推进水位线（假 pool，反向自证「先推进再求值」必红）
//   ② 3 × intervalMs 判陈旧（纯函数 isWatermarkStale）
//   ③ inflight 重入等同一轮（假 pool，取订阅只跑一次 + 两个 tick 同一结果对象）
//   ④ 今天已 tick 就不再 tick（真库，两次 tick 第二次 intents 空）
//   ⑤ 静默用 run_events 而非 IPC（真库，造「run 活跃但 run_events 只有 20 分钟前一条」仍报静默）
//   ⑥ until 到期产一条到期意图（真库）
//   ⑦ timer.unref() 被调（setInterval 拦截，不拖进程退出）
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { validateKindParams, claimMacroRun, MacroError } from '../src/macros.js';
import {
  startMacroEvalLoop, isWatermarkStale, isQuietHours, inTz8, atToEpochMs, parseDurationMs,
  EVAL_INTERVAL_MS, STALE_INTERVAL_MULTIPLE, SILENCE_DEFAULT_THRESHOLD_MS, evaluateSkipGates,
  parseQuietSpec, quietSpecFor, DEFAULT_MAX_PER_DAY, DEFAULT_QUIET_SPEC, NOTIFY_KINDS,
  evalClock, jitterSpanMs, jitterOffsetMs, JITTER_MAX_MS, listEvaluableAssignments,
} from '../src/macro-eval.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w525' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

const SILENT = { log() {}, info() {}, warn() {}, error() {} };
// 固定「现在」= 2026-11-16 10:00（UTC+8）= 02:00Z；非免打扰时段，避开 quiet_hours 干扰。
const NOW_MS = Date.parse('2026-11-16T02:00:00.000Z');

// —— 假 pool：按 SQL 片段路由，够走「列表 → 求值(抛) → 水位线」这条链，不触达 macros.js。 —
// ⚠ issue #624：`listEvaluableAssignments` 现在**先**跑 `applyExpiredAssignments`
// （`UPDATE macro_assignments SET enabled = false …`），它属于「取订阅」这一步，
// ⇒ 每条假 pool 都得有这条路由。缺省时自动补一条「本轮没有到期」，不削弱
// 「未预期 SQL 就抛」的严格性（那是假 pool 的核心价值）。
const EXPIRY_SWEEP_PROBE = 'UPDATE macro_assignments SET enabled = false WHERE enabled AND until IS NOT NULL AND until <= $1 RETURNING id';
const isExpirySweep = (s) => s.includes('UPDATE macro_assignments SET enabled = false');
const NO_EXPIRY = { test: isExpirySweep, fn: () => ({ rows: [], rowCount: 0 }) };
function makeFakePool(routes) {
  const all = routes.some((r) => r.test(EXPIRY_SWEEP_PROBE)) ? routes : [NO_EXPIRY, ...routes];
  return {
    async query(sql, params) {
      for (const r of all) if (r.test(sql)) return r.fn(sql, params);
      throw new Error(`fake pool: 未预期的 SQL: ${String(sql).slice(0, 80)}`);
    },
  };
}
// listEvaluableAssignments 读的是 DB 行的 snake_case 列，映射前形状如下。
function assignRow(o = {}) {
  return {
    id: o.id ?? randomUUID(), template_id: o.template_id ?? randomUUID(),
    user_id: o.user_id ?? randomUUID(), session_id: o.session_id ?? null, cwd: o.cwd ?? null,
    until: o.until ?? null, enabled: o.enabled ?? true, last_evaluated_at: o.last_evaluated_at ?? null,
    kind: o.kind ?? 'run-silence-alert', template_name: o.template_name ?? 'T', params: o.params ?? {},
    scope: o.scope ?? 'session',
  };
}
const isList = (s) => s.includes('FROM macro_assignments a') && s.includes('JOIN macro_templates');
const isRuns = (s) => s.includes('FROM runs');
const isUpdate = (s) => s.includes('UPDATE macro_assignments SET last_evaluated_at');

// ── ① 求值失败不推进水位线（假 pool；反向自证见文件末的注释块）──────────────────
test('#525① 求值抛异常 ⇒ failed++ 且不推进水位线（先求值成功、再推进）', async () => {
  const calls = [];
  const pool = makeFakePool([
    { test: isList, fn: () => ({ rows: [assignRow({ kind: 'run-silence-alert', session_id: randomUUID() })] }) },
    // evalSilence 查活跃 run 这一步抛 ⇒ 在 claim / advanceWatermark **之前**。
    { test: isRuns, fn: () => { calls.push('eval'); throw new Error('boom'); } },
    { test: isUpdate, fn: () => { calls.push('advance'); return { rows: [] }; } },
  ]);
  const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
  const p1 = loop.tick();           // 同步拿到启动那一轮（inflight 去重）
  const r = await p1;
  loop.stop();
  assert.equal(r.failed, 1, '求值异常要计入 failed');
  assert.equal(r.evaluated, 0);
  assert.equal(r.intents.length, 0);
  assert.ok(calls.includes('eval'), 'eval 应被走到');
  // ⚠ 反向自证：若把 tick 里 `await advanceWatermark(...)` 挪到 `evalOneAssignment` **之前**，
  //   这条 `!calls.includes('advance')` 就会红（推进先于抛异常发生了）。
  assert.ok(!calls.includes('advance'), '求值失败不得推进水位线（否则把故障藏成健康）');
});

// ── ①b 正向对照：求值成功（未命中）也要推进 ────────────────────────────────────
test('#525①b 求值成功但未命中 ⇒ evaluated++ 且推进水位线', async () => {
  const calls = [];
  const pool = makeFakePool([
    { test: isList, fn: () => ({ rows: [assignRow({ kind: 'run-silence-alert', session_id: randomUUID() })] }) },
    { test: isRuns, fn: () => ({ rows: [] }) }, // 无活跃 run ⇒ 无静默、但求值成功
    { test: isUpdate, fn: () => { calls.push('advance'); return { rows: [] }; } },
  ]);
  const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
  const r = await loop.tick();
  loop.stop();
  assert.equal(r.evaluated, 1);
  assert.equal(r.failed, 0);
  assert.equal(r.intents.length, 0, '无活跃 run ⇒ 无意图');
  assert.ok(calls.includes('advance'), '求值成功无论命中与否都要推进（未命中也要证明“看过了”）');
});

// ── ② 3 × intervalMs 判陈旧 ────────────────────────────────────────────────────
test('#525② 水位线陈旧阈值 = 3 × intervalMs（默认 180s），首次 NULL 视为陈旧', () => {
  assert.equal(STALE_INTERVAL_MULTIPLE * EVAL_INTERVAL_MS, 180_000);
  const last = NOW_MS;
  assert.equal(isWatermarkStale(last, last + 3 * EVAL_INTERVAL_MS, EVAL_INTERVAL_MS), false, '恰好 3× 不算陈旧');
  assert.equal(isWatermarkStale(last, last + 3 * EVAL_INTERVAL_MS + 1, EVAL_INTERVAL_MS), true, '超过 3× 即陈旧');
  assert.equal(isWatermarkStale(null, NOW_MS, EVAL_INTERVAL_MS), true, '首次订阅（NULL）显示尚未评估');
  assert.equal(isWatermarkStale(new Date(last), last + 1000, EVAL_INTERVAL_MS), false);
});

// ── ③ inflight 重入等同一轮（不是静默跳过）─────────────────────────────────────
test('#525③ 重入 tick 等的是同一轮：取订阅只跑一次，两个 tick 拿同一结果对象', async () => {
  let listCalls = 0;
  let release;
  const gate = new Promise((res) => { release = res; });
  const pool = makeFakePool([
    { test: isList, fn: () => { listCalls += 1; return gate; } }, // 卡住，逼出并发
  ]);
  const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
  // 启动那一轮已卡在 gate；再并发两次 tick ⇒ 都应 join 同一 inflight。
  const p1 = loop.tick();
  const p2 = loop.tick();
  release({ rows: [] });
  const [r1, r2] = await Promise.all([p1, p2]);
  loop.stop();
  assert.equal(listCalls, 1, '并发 tick 只能触发一轮取数（静默跳过/各起一轮都会红）');
  assert.equal(r1, r2, '重入必须等同一轮（返回同一结果对象，不是各造一个空结果）');
});

// ── ⑦ timer.unref() 被调（不拖进程退出）─────────────────────────────────────────
test('#525⑦ 循环对 setInterval 的 timer 调了 unref()（不拖住进程退出）', () => {
  const realSetInterval = globalThis.setInterval;
  let unrefCalled = false;
  let made = 0;
  globalThis.setInterval = (fn, ms) => {
    made += 1;
    const t = realSetInterval(fn, ms);
    const realUnref = t.unref ? t.unref.bind(t) : () => {};
    t.unref = () => { unrefCalled = true; return realUnref(); };
    return t;
  };
  let loop;
  try {
    loop = startMacroEvalLoop(makeFakePool([{ test: isList, fn: () => ({ rows: [] }) }]), {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  try {
    assert.equal(made, 1, '循环只建一个 interval');
    assert.ok(unrefCalled, '必须对 timer 调 unref（否则 shutdown 之外还会拖住进程）');
  } finally {
    loop.stop();
  }
});

// ── 纯逻辑小面（防时钟口径回归）────────────────────────────────────────────────
test('#525 时钟口径：at/clock 都按 UTC+8，免打扰 22–08 也按 UTC+8', () => {
  // 2026-11-15T16:30:00Z = 2026-11-16 00:30（UTC+8）：UTC 还是 15 号，UTC+8 已是 16 号。
  const t = Date.parse('2026-11-15T16:30:00.000Z');
  assert.equal(inTz8(t).date, '2026-11-16', '日期必须用 UTC+8 那一天');
  assert.ok(isQuietHours(t), '00:30（UTC+8）落在免打扰');
  assert.ok(!isQuietHours(Date.parse('2026-11-16T02:00:00.000Z')), '10:00（UTC+8）不在免打扰');
  assert.ok(isQuietHours(Date.parse('2026-11-16T14:30:00.000Z')), '22:30（UTC+8）在免打扰');
  // at 'HH:MM' 是 UTC+8 时刻：atToEpochMs 与 inTz8 必须互逆。
  assert.equal(atToEpochMs('2026-11-16', '09:30'), Date.parse('2026-11-16T01:30:00.000Z'));
  assert.equal(inTz8(atToEpochMs('2026-11-16', '09:30')).minutesOfDay, 9 * 60 + 30);
  assert.equal(parseDurationMs('15m'), SILENCE_DEFAULT_THRESHOLD_MS);
  assert.equal(parseDurationMs('2h'), 7_200_000);
});

// ── 真库夹具：seed ─────────────────────────────────────────────────────────────
async function seedScene(pool, tag) {
  const userId = randomUUID(); const projectId = randomUUID(); const sessionId = randomUUID();
  await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1,$2,'x','active')`, [userId, `m525${tag}`]);
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot) VALUES ($1,$2,$3,'git@x:y/z.git',$4,0)`,
    [projectId, userId, `p525${tag}`, `~/projects/p525${tag}`]);
  await pool.query(`INSERT INTO chat_sessions (id, user_id, project_id, title) VALUES ($1,$2,$3,'s')`, [sessionId, userId, projectId]);
  return { userId, projectId, sessionId };
}
async function addTemplate(pool, kind, scope, params = {}) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, scope, params, audience, enabled) VALUES ($1,$2,$3,$4,$5,'all',true)`,
    [id, kind, `t525-${kind}`, scope, JSON.stringify(params)]);
  return id;
}
async function addAssignment(pool, { templateId, userId, sessionId = null, cwd = null, until = null }) {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, cwd, until, enabled) VALUES ($1,$2,$3,$4,$5,$6,true)`,
    [id, templateId, userId, sessionId, cwd, until]);
  return id;
}
async function addRun(pool, { sessionId, status = 'running', startedAt = NOW_MS }) {
  const id = randomUUID();
  await pool.query(`INSERT INTO runs (id, session_id, status, started_at, queued_at) VALUES ($1,$2,$3,$4,$4)`,
    [id, sessionId, status, new Date(startedAt)]);
  return id;
}
async function addRunEvent(pool, { runId, sessionId, type, ts, seq = 1 }) {
  await pool.query(
    `INSERT INTO run_events (run_id, session_id, seq, client_event_id, ts, type, payload) VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
    [runId, sessionId, seq, `${runId}:${seq}`, new Date(ts), type]);
}

// ── ④ 今天已 tick 就不再 tick（真库）────────────────────────────────────────────
test('#525④ scheduled-task：今天已 tick 就不再 tick（第二次 tick intents 空）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'c4');
    const tpl = await addTemplate(pool, 'scheduled-task', 'user', { at: '00:00' }); // at 已过 ⇒ 今天到点
    await addAssignment(pool, { templateId: tpl, userId, cwd: '/no/such/cwd-c4', until: null });
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
    const p1 = loop.tick();               // 同步 join 启动那一轮 ⇒ 这一轮去 claim clock:<date>
    const r1 = await p1;
    const r2 = await loop.tick();          // 新新一轮：clock:<date> 已占位 ⇒ 幂等挡下
    loop.stop();
    assert.equal(r1.intents.length, 1, '到点且今天没 tick ⇒ 产一条意图');
    assert.equal(r1.intents[0].anchor, 'clock:2026-11-16');
    assert.equal(r1.intents[0].criterion, 'tick');
    assert.equal(r1.intents[0].bucket, '2026-11-16');
    assert.equal(r2.intents.length, 0, '今天已 tick ⇒ 第二次 intents 必须空');
  });
});

// ── ⑤ 静默用 run_events 而非 IPC（真库）────────────────────────────────────────
test('#525⑤ 静默判据量 run_events（非 IPC）：run 活跃、最后一条 run_event 20 分钟前 ⇒ 仍报静默', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'c5');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', { phases: ['tool_running'], threshold: '15m' });
    await addAssignment(pool, { templateId: tpl, userId, sessionId });
    // 一个「正在跑 shell」的活跃 run：IPC 每 30s 有 shell_liveness 心跳（不落 run_events），
    // 而 run_events 里最后一条是 20 分钟前的 tool_use ⇒ 用户感知的「没反馈」= run_events 静默。
    const runId = await addRun(pool, { sessionId, status: 'running', startedAt: NOW_MS - 30 * 60_000 });
    await addRunEvent(pool, { runId, sessionId, type: 'tool_use', ts: NOW_MS - 20 * 60_000, seq: 1 });
    // shell_liveness 只存在于 IPC（不落 run_events）⇒ 本用例证明「IPC 一直有动静」也不会误判为不静默。
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
    const r1 = await loop.tick();
    loop.stop();
    assert.equal(r1.intents.length, 1, 'IPC 有动静但 run_events 静默 ⇒ 仍必须报静默');
    const it = r1.intents[0];
    assert.equal(it.anchor, `run:${runId}`);
    assert.equal(it.criterion, 'silent');
    assert.equal(it.bucket, 'tool_running', '相位 = 最后一条 run_event 的 tool_use ⇒ tool_running');
    assert.ok(it.evidence.silent_ms > 15 * 60_000, '静默时长必须按 run_events 的最后 ts 算');
    assert.equal(it.evidence.last_event_type, 'tool_use');
  });
});

// ── ⑥ until 到期产一条到期意图（真库）──────────────────────────────────────────
test('#525⑥ until 到期 ⇒ 产一条到期意图（bucket=expiry），且只产一次', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'c6');
    const tpl = await addTemplate(pool, 'scheduled-task', 'user', { at: '09:00' });
    // until 已过（2020），DB 里仍 enabled=true ⇒ 本轮扫到 ⇒ 产到期意图。
    await addAssignment(pool, { templateId: tpl, userId, cwd: '/no/such/cwd-c6', until: '2020-01-01T00:00:00Z' });
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
    const p1 = loop.tick();
    const r1 = await p1;
    const r2 = await loop.tick();
    loop.stop();
    assert.equal(r1.intents.length, 1, '到期应产一条意图');
    const it = r1.intents[0];
    assert.match(it.anchor, /^assignment:/);
    assert.equal(it.criterion, 'tick');
    assert.equal(it.bucket, 'expiry');
    assert.equal(r2.intents.length, 0, '同一订阅的到期意图只产一次（幂等键）');
  });
});

// —— UTC+8 日界（跨日）——这是时钟口径最容易退化成 UTC 的一格。
// ⚠ 跨日窗口（UTC+8 的 00:00–08:00）整段落免打扰 22:00–08:00 ⇒ clock 意图会被 `quiet_hours`
//   跳过、返回的 intents 为空；但 `claimMacroRun` 在门禁**之前**就把 `anchor` 落了账。所以这里
//   钉的是 **账行的 anchor**（也正是变异会改的那个值），而不是返回的 intents 数组。

/** 取某订阅已落的 `clock:<date>` 锚（排序后返回）。 */
async function clockAnchors(pool, assignmentId) {
  const { rows } = await pool.query(
    `SELECT anchor FROM macro_runs WHERE assignment_id = $1 AND criterion = 'tick' AND anchor LIKE 'clock:%'`,
    [assignmentId],
  );
  return rows.map((r) => r.anchor).sort();
}

// —— ⑧ 跨日 anchor 用 UTC+8 日期，不是 UTC 日期 ——
test('#525⑧ 跨日时刻的 clock anchor 必须是 UTC+8 那一天（不是 UTC 那天）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'tz1');
    const tpl = await addTemplate(pool, 'scheduled-task', 'user', { at: '00:00' });
    const asg = await addAssignment(pool, { templateId: tpl, userId, cwd: '/no/such/cwd-tz1', until: null });
    // 2026-11-15T17:30:00Z：UTC 日期是 11-15，UTC+8 已是 2026-11-16 01:30。
    const t = Date.parse('2026-11-15T17:30:00.000Z');
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(t), log: SILENT });
    await loop.tick(); // 到点（00:00 已过）⇒ claim clock:<date>；date 必须走 inTz8
    loop.stop();
    assert.deepEqual(await clockAnchors(pool, asg), ['clock:2026-11-16'],
      'anchor 必须用 UTC+8 那一天（用 UTC 日期会得到 clock:2026-11-15 ⇒ 这条红）');
  });
});

// —— ⑨ 跨日「今天已 tick」按 UTC+8 日界判 ——
test('#525⑨ 今天已 tick 按 UTC+8 日界：同日(UTC+8)不重复产，跨到 UTC+8 新一天才再产', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'tz2');
    const tpl = await addTemplate(pool, 'scheduled-task', 'user', { at: '00:00' }); // ≤01:00 ⇒ 跨午夜那次 at 也已过
    const asg = await addAssignment(pool, { templateId: tpl, userId, cwd: '/no/such/cwd-tz2', until: null });
    let t = Date.parse('2026-11-15T17:30:00.000Z'); // UTC+8 11-16 01:30
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(t), log: SILENT });
    await loop.tick(); // 占 clock:2026-11-16
    assert.deepEqual(await clockAnchors(pool, asg), ['clock:2026-11-16'], '第一次按 UTC+8 占位');
    // 拨到 UTC+8 11-16 18:00（同一 UTC+8 日）⇒ 不许再占一个新锚。
    t = Date.parse('2026-11-16T10:00:00.000Z');
    await loop.tick();
    assert.deepEqual(await clockAnchors(pool, asg), ['clock:2026-11-16'], '同一 UTC+8 日 ⇒ 幂等挡下，不再产');
    // 拨到 UTC+8 11-17 01:00（换了一天，at=00:00 已过）⇒ 要再占一条新锚。
    t = Date.parse('2026-11-16T17:00:00.000Z');
    await loop.tick();
    assert.deepEqual(await clockAnchors(pool, asg), ['clock:2026-11-16', 'clock:2026-11-17'],
      '跨到 UTC+8 新一天 ⇒ 再产一条（若 anchor 用 UTC 日期，这一步会拿到 clock:2026-11-16/16 同值而漏产 ⇒ 红）');
    loop.stop();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// #611 quiet_hours 只对通知型生效 + 从 params 读 + 窗内不丢弃合并 digest；
// #617 max_per_day/quiet_hours 进 KIND_SCHEMA（拍平），两闸读 params 缺省回落。
//
// 「通知型」= `NOTIFY_KINDS` = ['run-notify','run-silence-alert']。评估循环实际会求值的
// 通知型只有 `run-silence-alert`（run-notify 由 W1 终态触发驱动，不进 W2 循环），所以闸的
// DB 用例都用 run-silence-alert 走 `evaluateSkipGates`；`gateFor` 就是门禁认的那个 kind。
// 固定时刻（UTC+8，用 atToEpochMs）：23:00 落默认窗 22–08 内；01:30 落 01:00–02:00 内；03:00 在外。
const T23 = atToEpochMs('2026-11-16', '23:00');
const T0130 = atToEpochMs('2026-11-16', '01:30');
const T0300 = atToEpochMs('2026-11-16', '03:00');

// ── ⚑1 scheduled-task 在 23:00 仍要跑（不被 quiet_hours 挡）──────────────────────
test('#611⚑1 scheduled-task 在 23:00（默认窗内）不被 quiet_hours 挡', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'q1');
    const tpl = await addTemplate(pool, 'scheduled-task', 'user', { at: '00:00' });
    const asg = await addAssignment(pool, { templateId: tpl, userId, cwd: '/no/such/cwd-q1', until: null });
    const a = { id: asg, params: {}, sessionId: null, cwd: '/no/such/cwd-q1' };
    // 反向自证：若去掉「quiet 只对通知型生效」的 `NOTIFY_KINDS.includes(gateFor)` 前缀
    // （改成对所有 kind 判 quiet），23:00 会返回 'quiet_hours' ⇒ 这条红。
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: T23, gateFor: 'scheduled-task', log: SILENT }),
      null, 'scheduled-task 不受 quiet_hours 约束 ⇒ 23:00 也放行');
  });
});

// ── ⚑2 通知型在 23:00 被挡（基线：闸还在）─────────────────────────────────────────
test('#611⚑2 通知型 run-silence-alert 在 23:00（默认窗内）被 quiet_hours 挡', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'q2');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', { phases: ['tool_running'], threshold: '15m' });
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const a = { id: asg, params: {}, sessionId, cwd: null };
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: T23, gateFor: 'run-silence-alert', log: SILENT }),
      'quiet_hours', '通知型在默认免打扰窗内 ⇒ 闸仍命中 quiet_hours');
  });
});

// ── ⚑3 params.quiet_hours='01:00-02:00' ⇒ 01:30 挡、03:00 不挡 ───────────────────
test('#611⚑3 params.quiet_hours 覆盖缺省窗：01:30 挡、03:00 不挡', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'q3');
    const params = { quiet_hours: '01:00-02:00' };
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', params);
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const a = { id: asg, params, sessionId, cwd: null };
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: T0130, gateFor: 'run-silence-alert', log: SILENT }),
      'quiet_hours', '01:30 落在 params 指定的 01:00–02:00 内 ⇒ 挡');
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: T0300, gateFor: 'run-silence-alert', log: SILENT }),
      null, '03:00 不在 params 窗内（缺省 22–08 被 params 覆盖掉）⇒ 不挡');
  });
});

// ── ⚑4 params.max_per_day=1 ⇒ 当日第 2 次 budget_exhausted ───────────────────────
test('#617⚑4 params.max_per_day=1 ⇒ 当日第 2 次命中 budget_exhausted', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'b4');
    const params = { max_per_day: 1 };
    // 反向自证：schema 认 max_per_day 才建得成模板；若把 max_per_day 从 KIND_SCHEMA 摘掉，
    // 这行 validateKindParams 抛 '不认识参数 max_per_day' ⇒ 本条红。
    validateKindParams('run-silence-alert', params);
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', params);
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const a = { id: asg, params, sessionId, cwd: null };
    // NOW_MS=10:00（UTC+8，窗外）：先判 budget，count 含本轮已 claim 的那条（用 >）。
    await claimMacroRun(pool, { assignmentId: asg, anchor: 'b1', criterion: 'silent', bucket: 'tool_running', now: new Date(NOW_MS) });
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: NOW_MS, gateFor: 'run-silence-alert', log: SILENT }),
      null, '当日第 1 次（count=1，1>1 false）⇒ 放行');
    await claimMacroRun(pool, { assignmentId: asg, anchor: 'b2', criterion: 'silent', bucket: 'tool_running', now: new Date(NOW_MS) });
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: NOW_MS, gateFor: 'run-silence-alert', log: SILENT }),
      'budget_exhausted', '当日第 2 次（count=2>1）⇒ budget_exhausted');
  });
});

// ── ⚑5 不传 max_per_day ⇒ 默认 20 生效 ───────────────────────────────────────────
test('#617⚑5 不传 max_per_day ⇒ 回落 DEFAULT_MAX_PER_DAY=20（第 20 放行、第 21 挡）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    assert.equal(DEFAULT_MAX_PER_DAY, 20, '缺省上限必须是 20');
    const { userId, sessionId } = await seedScene(pool, 'b5');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', {});
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const a = { id: asg, params: {}, sessionId, cwd: null };
    for (let i = 1; i <= 20; i += 1) {
      await claimMacroRun(pool, { assignmentId: asg, anchor: `k${i}`, criterion: 'silent', bucket: 'tool_running', now: new Date(NOW_MS) });
    }
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: NOW_MS, gateFor: 'run-silence-alert', log: SILENT }),
      null, '第 20 次（count=20，20>20 false）⇒ 放行');
    await claimMacroRun(pool, { assignmentId: asg, anchor: 'k21', criterion: 'silent', bucket: 'tool_running', now: new Date(NOW_MS) });
    assert.equal(
      await evaluateSkipGates(pool, a, { nowMs: NOW_MS, gateFor: 'run-silence-alert', log: SILENT }),
      'budget_exhausted', '第 21 次（count=21>20）⇒ budget_exhausted');
  });
});

// ── ⚑6 窗内不丢弃 ⇒ 窗外合并成一封 digest ─────────────────────────────────────────
test('#611⚑6 静默在窗内不丢弃（不 claim/不落 skipped），出窗合并成一封 digest', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'd6');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', { phases: ['tool_running'], threshold: '15m' });
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const t2230 = atToEpochMs('2026-11-16', '22:30'); // 最后一条 run_event：窗内
    const runId = await addRun(pool, { sessionId, status: 'running', startedAt: t2230 - 5 * 60_000 });
    await addRunEvent(pool, { runId, sessionId, type: 'tool_use', ts: t2230, seq: 1 });

    let t = atToEpochMs('2026-11-16', '23:00'); // 窗内那一拍
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(t), log: SILENT });
    const r1 = await loop.tick();
    assert.equal(r1.intents.length, 0, '窗内不发即时静默');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM macro_runs WHERE assignment_id = $1`, [asg]);
    assert.equal(rows[0].n, 0, '窗内既不 claim 也不落 skipped ⇒ 积压被保留，没被丢弃');

    t = atToEpochMs('2026-11-17', '09:00'); // 出窗那一拍：积压合并
    const r2 = await loop.tick();
    loop.stop();
    assert.equal(r2.intents.length, 1, '出窗 ⇒ 窗内积压合并成 1 封 digest');
    const d = r2.intents[0];
    assert.match(d.anchor, /^digest:/, '合并意图用 digest:<窗日> 锚');
    assert.equal(d.criterion, 'tick');
    assert.equal(d.evidence.digest, true, 'evidence 必须标 digest');
    assert.ok(d.evidence.merged >= 1, 'digest 至少要合并 1 条积压');
    // 反向自证：若把「积压到窗外」改回「丢弃」（窗外直接 continue 而非进 digestBacklog），
    // r2.intents 会是空 ⇒ 上面 `r2.intents.length === 1` 红。
  });
});

// ── ⚑7 ERIX_MACRO_QUIET_HOURS=off ⇒ 通知型 23:00 也不挡 ──────────────────────────
test('#611⚑7 ERIX_MACRO_QUIET_HOURS=off ⇒ 通知型 23:00 也不被挡', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'q7');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', { phases: ['tool_running'], threshold: '15m' });
    const asg = await addAssignment(pool, { templateId: tpl, userId, sessionId });
    const a = { id: asg, params: {}, sessionId, cwd: null };
    const prev = process.env.ERIX_MACRO_QUIET_HOURS;
    process.env.ERIX_MACRO_QUIET_HOURS = 'off';
    try {
      // 反向自证：若 quietSpecFor 忽略 env，则回落缺省 22–08 ⇒ 23:00 返回 'quiet_hours' ⇒ 红。
      assert.equal(
        await evaluateSkipGates(pool, a, { nowMs: T23, gateFor: 'run-silence-alert', log: SILENT }),
        null, 'env=off ⇒ 通知型在 23:00 也放行');
    } finally {
      if (prev === undefined) delete process.env.ERIX_MACRO_QUIET_HOURS; else process.env.ERIX_MACRO_QUIET_HOURS = prev;
    }
  });
});

// ── ⚑8 建 run-notify 模板能传 max_per_day / quiet_hours（schema 认）───────────────
test('#617⚑8 run-notify/run-silence-alert 的 params 认 max_per_day/quiet_hours', () => {
  // ⚠ #625：返回值从 `true` 改成「补完默认值的 params」⇒ 这里断言「传的在、缺的补上」。
  assert.deepEqual(validateKindParams('run-notify', { max_per_day: 5, quiet_hours: '01:00-02:00' }),
    { max_per_day: 5, quiet_hours: '01:00-02:00', channel: 'site',
      states: ['failed', 'capped', 'aborted', 'persistence_failed', 'guard_unverified'] });
  assert.equal(validateKindParams('run-notify', { quiet_hours: 'off' }).quiet_hours, 'off', 'quiet_hours 允许 off');
  assert.equal(validateKindParams('run-silence-alert', { max_per_day: 200 }).max_per_day, 200);
  // 反向自证：把 max_per_day 从 KIND_SCHEMA 摘掉 ⇒ validateKindParams 抛 '不认识参数' ⇒ 红。
});

// ── ⚑9 建 scheduled-task 传 quiet_hours / max_per_day ⇒ 400（只给通知型）──────────
test('#617⚑9 scheduled-task 传 quiet_hours/max_per_day ⇒ MacroError 400', () => {
  for (const field of ['quiet_hours', 'max_per_day']) {
    let err;
    try {
      validateKindParams('scheduled-task', { at: '09:00', cwd: '/srv/x', [field]: field === 'quiet_hours' ? '22:00-08:00' : 5 });
    } catch (e) { err = e; }
    assert.ok(err instanceof MacroError, `scheduled-task + ${field} 必须抛 MacroError`);
    assert.equal(err.code, 'validation_failed');
    assert.equal(err.httpStatus, 400, `scheduled-task 不收 ${field} ⇒ 400`);
  }
});

// ── #627① `jitter` 真的参与 clock 判点 ─────────────────────────────────────────
// 过去 `jitter` 只是被 KIND_SCHEMA 收进 params、`evalClock` 从不读它（存了不用，比不填更糟：
// 用户以为它生效了）。本用例钉两件事：① 同 at 的两个订阅必须在**不同时刻**被 claim；
// ② 每个订阅的 claim 时刻必须逐字等于 `at + 确定性偏移`（不是「碰巧不同」）。
test('#627① jitter 口径：解析、钳到 0–30m、未填为 0、偏移确定性', () => {
  assert.equal(jitterSpanMs({ jitter: '10m' }), 600_000);
  assert.equal(jitterSpanMs({ jitter: '30m' }), JITTER_MAX_MS);
  assert.equal(jitterSpanMs({ jitter: '2h' }), JITTER_MAX_MS, '越界 ⇒ 钳到上限 30m（不得拖到下午）');
  assert.equal(jitterSpanMs({}), 0, '未填 ⇒ 0：不打散（不凭空造缺省，否则所有任务莫名延后）');
  assert.equal(jitterSpanMs({ jitter: '0m' }), 0);
  assert.equal(jitterSpanMs({ jitter: '乱写' }), 0, '非法形态 ⇒ 0（等价于没填）');
  const span = jitterSpanMs({ jitter: '10m' });
  const o = jitterOffsetMs('assign-a', span);
  assert.ok(o >= 0 && o <= span, '偏移必须落在 [0, span]');
  assert.equal(o, jitterOffsetMs('assign-a', span), '同一订阅的偏移必须逐次相同（每拍判点漂移=会漏 tick）');
  assert.equal(jitterOffsetMs('assign-a', 0), 0, 'span=0 ⇒ 无偏移');
  assert.notEqual(jitterOffsetMs('assign-a', span), jitterOffsetMs('assign-b', span),
    '不同订阅必须错开（这就是 jitter 的全部用途：打散同刻并发）');
});

test('#627① 同一 at 的两个订阅（jitter=10m）在不同时刻被 claim；不填 jitter 的对照组同时刻', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'j1');
    const tplJ = await addTemplate(pool, 'scheduled-task', 'user', { at: '10:00', jitter: '10m' });
    const tplN = await addTemplate(pool, 'scheduled-task', 'user', { at: '10:00' }); // 对照组：无 jitter
    // 固定 id ⇒ 偏移可预演（hash 是确定性的），断言才能钉到分钟而不是「大概不同」。
    const idA = 'aaaaaaaa-0000-4000-8000-000000000001';
    const idB = '11111111-1111-4111-8111-111111111111';
    const idC = 'cccccccc-0000-4000-8000-000000000001';
    const idD = 'dddddddd-0000-4000-8000-000000000002';
    const addWithId = async (id, templateId) => {
      await pool.query(
        `INSERT INTO macro_assignments (id, template_id, user_id, session_id, cwd, until, enabled)
         VALUES ($1,$2,$3,NULL,$4,NULL,true)`,
        [id, templateId, userId, `/no/such/cwd-${id.slice(0, 8)}`]);
    };
    await addWithId(idA, tplJ);
    await addWithId(idB, tplJ);
    await addWithId(idC, tplN);
    await addWithId(idD, tplN);

    const rows = await listEvaluableAssignments(pool);
    const row = (id) => {
      const r = rows.find((x) => x.id === id);
      assert.ok(r, `订阅 ${id} 应被评估循环取到`);
      return r;
    };
    const base = atToEpochMs('2026-11-16', '10:00');
    assert.equal(base, NOW_MS, '现场：NOW 恰为 at ⇒ 无 jitter 时立刻 tick');

    /** 分钟探针：返回第一次产出 tick 意图的时刻（= 被 claim 的时刻）。 */
    const firstFire = async (r) => {
      for (let k = 0; k <= 31; k += 1) {
        const t = NOW_MS + k * 60_000;
        const it = await evalClock(pool, r, t, { log: SILENT });
        if (it) return t;
      }
      return null;
    };

    const tA = await firstFire(row(idA));
    const tB = await firstFire(row(idB));
    assert.ok(tA && tB, 'jitter 只能推迟判点，不得把任务挤掉');
    assert.notEqual(tA, tB, '同 at + jitter=10m ⇒ 两个订阅必须在**不同时刻**被 claim');
    // 钉到分钟：探针步长 60s ⇒ 首个命中时刻 = at + ceil(偏移/60s)×60s。
    const expect = (id, params) => base + Math.ceil(jitterOffsetMs(id, jitterSpanMs(params)) / 60_000) * 60_000;
    assert.equal(tA, expect(idA, row(idA).params), 'A 的 claim 时刻必须等于 at + 它的确定性偏移');
    assert.equal(tB, expect(idB, row(idB).params), 'B 同上（偏移不同 ⇒ 时刻不同）');
    assert.ok(tA > base && tB > base, '两条都被推迟了（= jitter 在起作用，不是判点没变）');
    assert.ok(tA <= base + JITTER_MAX_MS && tB <= base + JITTER_MAX_MS, '偏移不得越出 30m 上限');

    // 对照组：同 at、**没填 jitter** ⇒ 两条仍在同一拍被 claim（证明分离确实是 jitter 造成的）。
    const tC = await firstFire(row(idC));
    const tD = await firstFire(row(idD));
    assert.equal(tC, base, '未填 jitter ⇒ at 当刻就 claim');
    assert.equal(tD, base, '对照组两条必须同拍（否则本用例证明不了什么）');
  });
});

// ── #624：`until` 到期必须由**评估循环自己**收敛 ─────────────────────────────────
// 旧实现 `listEvaluableAssignments` 只有 `WHERE a.enabled = true`，「顺手停用」只发生在
// `claimMacroRun` 里 ⇒ 只有走 tick claim 的 `scheduled-task` 晚一拍会被停用，
// `run-notify` / `run-silence-alert`（不走 tick claim）**永远 enabled**：界面显示启用、
// 实际到期了却没人关账，也没有任何「它到期了」的通知。

/** 取订阅行的启用位（收敛的唯一可观测量）。 */
async function enabledOf(pool, id) {
  return (await pool.query('SELECT enabled FROM macro_assignments WHERE id = $1', [id])).rows[0].enabled;
}

test('#624① run-notify 订阅 until=now-1h ⇒ 一次 tick 后 enabled=false 且产一条到期意图',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'x1');
    const tpl = await addTemplate(pool, 'run-notify', 'session', { states: ['failed'], channel: 'site' });
    const asg = await addAssignment(pool, {
      templateId: tpl, userId, sessionId, until: new Date(NOW_MS - 3600_000),
    });
    assert.equal(await enabledOf(pool, asg), true, '前置：造的是「已到期但仍启用」的订阅');
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
    const r = await loop.tick();
    loop.stop();
    // ⚠ 反向自证：去掉 `listEvaluableAssignments` 里的 `applyExpiredAssignments` ⇒ 下面两条都红
    //   （enabled 仍是 true，且到期订阅被过滤掉后一条意图也产不出）。
    assert.equal(await enabledOf(pool, asg), false, '到期必须被停用（run-notify 不走 tick claim，没人替它收敛）');
    assert.equal(r.intents.length, 1, '到期要说一声：产一条到期意图（#624 的另一半是它有消费者）');
    assert.equal(r.intents[0].bucket, 'expiry');
    assert.equal(r.intents[0].criterion, 'tick');
    assert.match(r.intents[0].anchor, new RegExp(`^assignment:${asg}$`));
  });
});

test('#624② until 在未来的订阅不受影响（仍启用、仍被取出、不产到期意图）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'x2');
    const tpl = await addTemplate(pool, 'run-notify', 'session', { states: ['failed'], channel: 'site' });
    const asg = await addAssignment(pool, {
      templateId: tpl, userId, sessionId, until: new Date(NOW_MS + 3600_000),
    });
    const loop = startMacroEvalLoop(pool, {}, { intervalMs: 10_000_000, now: () => new Date(NOW_MS), log: SILENT });
    const r = await loop.tick();
    loop.stop();
    assert.equal(await enabledOf(pool, asg), true, '没到期不许被关掉');
    assert.equal(r.intents.length, 0, '没到期不许产到期意图');
    const rows = await listEvaluableAssignments(pool, { now: new Date(NOW_MS) });
    assert.ok(rows.some((a) => a.id === asg), '未到期订阅仍要被评估');
  });
});

test('#624③ 到期收敛后不再被 listEvaluableAssignments 返回（也不会每拍重复产意图）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'x3');
    const tpl = await addTemplate(pool, 'run-silence-alert', 'session', { threshold: '15m' });
    const asg = await addAssignment(pool, {
      templateId: tpl, userId, sessionId, until: new Date(NOW_MS - 3600_000),
    });
    // 第一次取订阅：到期项要被取到（否则到期意图永远产不出）
    const first = await listEvaluableAssignments(pool, { now: new Date(NOW_MS) });
    assert.ok(first.some((a) => a.id === asg), '本轮刚判到期的订阅必须仍被取一次（到期意图靠它）');
    // 第二次取订阅：已停用 ⇒ 不再出现
    const second = await listEvaluableAssignments(pool, { now: new Date(NOW_MS) });
    assert.ok(!second.some((a) => a.id === asg), '到期收敛后不许再被返回（否则每拍都白跑一次）');
    // 第三拍依旧不出现（收敛是持久的，不靠「本轮刚好产过」这个内存状态）。
    // 循环层面的「只产一次」由 #525⑥ 钉（幂等键那一层）。
    const third = await listEvaluableAssignments(pool, { now: new Date(NOW_MS + 60_000) });
    assert.ok(!third.some((a) => a.id === asg), '再往后也不许复活');
  });
});
