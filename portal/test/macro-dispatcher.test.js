// issue #616（意图消费者 / dispatcher）e2e —— 用 pg-fixture + **桩执行器**（不真跑模型）。
//
// 环境门（同 macro-scheduled/macro-review）：TEST_DATABASE_URL 未设 ⇒ 整文件 skip。真库自起：
//   docker run -d --name w616-pg -e POSTGRES_USER=station -e POSTGRES_PASSWORD=station \
//     -e POSTGRES_DB=station_test -p 127.0.0.1:15489:5432 postgres:16
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15489/station_test \
//     node --test portal/test/macro-dispatcher.test.js
//
// 判据（5 条）：
//   1 意图被消费：通过门禁的 scheduled-task 订阅 ⇒ tick() 后 executeScheduledIntent 恰好一次，
//     那条 macro_runs 最终不是 pending。
//   2 失败也收尾：桩执行器抛异常 ⇒ 行落 failed（非 pending）。
//   3 超时回收：pending 且 started_at 20min 前 ⇒ 清扫后落 failed（reason dispatch_timeout）。
//   4 一条失败不影响其余：3 条意图第 2 条抛 ⇒ 第 1/3 条正常 dispatch。
//   5 onIntents 抛异常 ⇒ 评估循环不崩（tick() 仍返回正常结果）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimMacroRun, finishMacroRun } from '../src/macros.js';
import { startMacroEvalLoop } from '../src/macro-eval.js';
import {
  createIntentDispatcher, reclaimTimedOutPendingRuns, extractReviewRunId,
} from '../src/macro-dispatcher.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w616' }) : null;

const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { poolMax: 2, log: () => {} });

const ids = (tag) => ({
  userId: crypto.randomUUID(), containerId: crypto.randomUUID(),
  templateId: crypto.randomUUID(), assignmentId: crypto.randomUUID(),
  login: `w616${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
});

const QUIET_FREE_NOW = () => new Date('2026-11-16T02:00:00.000Z'); // UTC+8 = 10:00 ⇒ 非免打扰、已过 09:00

/** 造一套可跑 scheduled-task 的现场（#623：user scope 无 HTTP 入口 ⇒ 直接 INSERT；until 留 NULL 避开 #624）。 */
async function seedScene(pool, scene, { cwd = '~/projects/w616demo', params = '{"at":"09:00","cwd":"~/projects/w616demo","task":"整理今日变更","maxRounds":16}' } = {}) {
  await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1,$2,'x','active')`,
    [scene.userId, scene.login]);
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1,$2,$3,'img','0.32.0','running',$4,$5)`,
    [scene.containerId, scene.userId, hashToken(`tok-${scene.login}`), scene.login, `fde-${scene.login}`]);
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, params, audience, scope)
     VALUES ($1,'scheduled-task',$2,$3::jsonb,'all','user')`,
    [scene.templateId, `daily-${scene.login}`, params]);
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, cwd, until, enabled)
     VALUES ($1,$2,$3,NULL,$4,NULL,true)`,
    [scene.assignmentId, scene.templateId, scene.userId, cwd]);
  return scene;
}

/** 认领一条 tick 账 + 组一条与 buildIntent 同形的意图（dispatch 测试用，不经 eval 循环）。 */
async function claimedIntent(pool, scene, { date = '2026-11-16', kind = 'scheduled-task', anchor = null, bucket = date, criterion = 'tick' } = {}) {
  const a = anchor ?? `clock:${date}`;
  const claimed = await claimMacroRun(pool, { assignmentId: scene.assignmentId, anchor: a, criterion, bucket });
  assert.ok(claimed?.id, 'claimMacroRun 应占位成功');
  return {
    assignmentId: scene.assignmentId, templateId: scene.templateId,
    templateKind: kind, templateName: `daily-${scene.login}`,
    params: { at: '09:00', cwd: '~/projects/w616demo', task: 'x', maxRounds: 16 },
    userId: scene.userId, sessionId: null, cwd: '~/projects/w616demo',
    anchor: a, criterion, bucket, evidence: {}, macroRunId: claimed.id,
  };
}

const rowOf = (pool, id) => pool.query(
  `SELECT status, reason FROM macro_runs WHERE id=$1`, [id],
).then((r) => r.rows[0]);

/** 轮询等待 macro_runs 离开 pending（评估循环启动即自动跑一拍，与显式 tick 竞态；幂等键保证只产一条意图）。 */
async function waitNotPending(pool, id, { ms = 3000 } = {}) {
  const deadline = Date.now() + ms;
  let row = await rowOf(pool, id);
  while (row?.status === 'pending' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    row = await rowOf(pool, id);
  }
  return row;
}

// —— 判据 1：通过门禁的订阅 ⇒ tick() 后 executeScheduledIntent 恰好一次、行非 pending ——
test('1. 意图被消费：tick() 后 executeScheduledIntent 恰好一次，行最终非 pending', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T1'));
    let calls = 0;
    let lastIntent = null;
    // 桩执行器（模拟 W7 自收尾：成功即 finish done）。
    const execScheduled = async (_pool, intent) => {
      calls += 1; lastIntent = intent;
      await finishMacroRun(pool, { macroRunId: intent.macroRunId, status: 'done' });
      return { status: 'done' };
    };
    const dispatcher = createIntentDispatcher({ pool, executeScheduledIntent: execScheduled });
    const loop = startMacroEvalLoop(pool, {}, {
      now: QUIET_FREE_NOW, intervalMs: 60 * 60_000, onIntents: (its) => dispatcher.dispatch(its),
    });
    try {
      await loop.tick(); // 与启动自动一拍经 inflight/幂等键去重 ⇒ 至多一条意图
      const row = await waitNotPending(pool, (await pool.query(
        `SELECT id FROM macro_runs WHERE assignment_id=$1`, [scene.assignmentId])).rows[0].id);
      assert.ok(lastIntent, 'dispatcher 应收到意图');
      assert.equal(lastIntent.templateKind, 'scheduled-task');
      assert.equal(calls, 1, `executeScheduledIntent 应恰好一次（实际 ${calls}）`);
      assert.notEqual(row.status, 'pending', '行不应停在 pending');
    } finally {
      loop.stop();
    }
  });
});

// —— 判据 2：桩执行器抛异常 ⇒ 行落 failed（非 pending）——
test('2. 失败也收尾：执行器抛异常 ⇒ 行落 failed 而非 pending', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T2'));
    const intent = await claimedIntent(pool, scene);
    const execScheduled = async () => { throw new Error('模型炸了'); };
    const dispatcher = createIntentDispatcher({ pool, executeScheduledIntent: execScheduled, log: { warn() {}, info() {} } });
    const out = await dispatcher.dispatch([intent]);
    assert.equal(out.failed, 1, '应计一条 failed');
    assert.equal(out.dispatched, 0);
    const row = await rowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'failed', `应为 failed（实际 ${row.status}）`);
    assert.match(row.reason, /dispatch_failed/);
  });
});

// —— 判据 3：pending 且 started_at 20min 前 ⇒ 清扫后落 failed ——
test('3. 超时回收：pending 且 started_at 20min 前 ⇒ 清扫落 failed(dispatch_timeout)', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T3'));
    const intent = await claimedIntent(pool, scene);
    // 手动把 started_at 拨到 20min 前，模拟「派发途中进程崩了」。
    await pool.query(`UPDATE macro_runs SET started_at = now() - interval '20 minutes' WHERE id=$1`, [intent.macroRunId]);
    const { ids: reclaimed } = await reclaimTimedOutPendingRuns({ pool, now: () => new Date(), log: { warn() {}, info() {} } });
    assert.ok(reclaimed.includes(intent.macroRunId), '超时的 pending 行应被回收');
    const row = await rowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'failed');
    assert.equal(row.reason, 'dispatch_timeout');
  });
});

// —— 判据 4：3 条意图第 2 条抛 ⇒ 第 1/3 条正常 dispatch（互不影响）——
test('4. 一条失败不影响其余：3 条意图第 2 条抛 ⇒ 1/3 正常、2 failed', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T4'));
    const i1 = await claimedIntent(pool, scene, { date: '2026-11-16' });
    const i2 = await claimedIntent(pool, scene, { date: '2026-11-17' });
    const i3 = await claimedIntent(pool, scene, { date: '2026-11-18' });
    const execScheduled = async (_pool, intent) => {
      if (intent.macroRunId === i2.macroRunId) throw new Error('第 2 条炸');
      await finishMacroRun(pool, { macroRunId: intent.macroRunId, status: 'done' });
      return { status: 'done' };
    };
    const dispatcher = createIntentDispatcher({ pool, executeScheduledIntent: execScheduled, log: { warn() {}, info() {} } });
    const out = await dispatcher.dispatch([i1, i2, i3]);
    assert.equal(out.dispatched, 2, '应有 2 条成功');
    assert.equal(out.failed, 1, '应有 1 条失败');
    assert.equal((await rowOf(pool, i1.macroRunId)).status, 'done');
    assert.equal((await rowOf(pool, i2.macroRunId)).status, 'failed');
    assert.equal((await rowOf(pool, i3.macroRunId)).status, 'done');
  });
});

// —— 判据 5：onIntents 抛异常 ⇒ 评估循环不崩（tick() 仍返回正常结果）——
test('5. onIntents 抛异常不崩：tick() 仍返回正常结果且水位线已推进', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T5'));
    const boom = async () => { throw new Error('消费者炸了'); };
    const loop = startMacroEvalLoop(pool, {}, { now: QUIET_FREE_NOW, intervalMs: 60 * 60_000, onIntents: boom });
    let res;
    try {
      res = await loop.tick();
    } finally {
      loop.stop();
    }
    assert.ok(res, 'tick() 不应抛');
    assert.ok(Array.isArray(res.intents) && res.intents.length >= 1, '仍应产出意图');
    assert.equal(res.evaluated >= 1, true, '仍应计 evaluated');
    assert.equal(res.failed, 0, '消费者异常不应计为评估失败');
  });
});

// —— 附带（非判据）：run-review 的 runId 解析口径 ——
test('附. extractReviewRunId：evidence.runId 优先，否则从 anchor run:<id> 解析', { skip: SKIP }, () => {
  assert.equal(extractReviewRunId({ evidence: { runId: 'e-id' }, anchor: 'run:a-id' }), 'e-id');
  assert.equal(extractReviewRunId({ anchor: 'run:a-id' }), 'a-id');
  assert.equal(extractReviewRunId({ anchor: 'clock:2026-11-16' }), null);
});
