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
  EVAL_INTERVAL_MS, STALE_INTERVAL_MULTIPLE, SILENCE_DEFAULT_THRESHOLD_MS,
  parseQuietSpec, quietSpecFor, DEFAULT_MAX_PER_DAY, DEFAULT_QUIET_SPEC, NOTIFY_KINDS,
} from '../src/macro-eval.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w525' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

const SILENT = { log() {}, info() {}, warn() {}, error() {} };
// 固定「现在」= 2026-11-16 10:00（UTC+8）= 02:00Z；非免打扰时段，避开 quiet_hours 干扰。
const NOW_MS = Date.parse('2026-11-16T02:00:00.000Z');

// —— 假 pool：按 SQL 片段路由，够走「列表 → 求值(抛) → 水位线」这条链，不触达 macros.js。 —
function makeFakePool(routes) {
  return {
    async query(sql, params) {
      for (const r of routes) if (r.test(sql)) return r.fn(sql, params);
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
