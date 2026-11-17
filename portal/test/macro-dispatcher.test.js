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
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimMacroRun, finishMacroRun } from '../src/macros.js';
import { startMacroEvalLoop } from '../src/macro-eval.js';
import { executeScheduledIntent } from '../src/macro-scheduled.js';
import {
  createIntentDispatcher, reclaimTimedOutPendingRuns, extractReviewRunId, pollRunTask,
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

// —— #624 判据 6：到期意图（criterion=tick + bucket=expiry）要有**正确**的消费者 ——
// 到期是**正常生命周期结束**：只说一声 + 落 `done`。以前 dispatcher 只按 `templateKind`
// 分派 ⇒ `scheduled-task` 的到期会**真的再起一个 run**（把「不想再跑了」执行成「再跑一次」）。
test('6. 到期意图：不起 run、deliverIntent 说一声、账落 done（不是 failed）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T6'));
    const intent = await claimedIntent(pool, scene, {
      anchor: `assignment:${scene.assignmentId}`, bucket: 'expiry', criterion: 'tick',
    });
    let scheduledCalls = 0;
    const delivered = [];
    const dispatcher = createIntentDispatcher({
      pool,
      executeScheduledIntent: async () => { scheduledCalls += 1; return { status: 'done' }; },
      deliverIntent: async (_pool, it, opts) => { delivered.push({ it, opts }); },
      log: { warn() {}, info() {} },
    });
    const out = await dispatcher.dispatch([intent]);
    assert.equal(out.dispatched, 1);
    assert.equal(out.failed, 0);
    // ⚠ 反向自证（语义那一半）：删掉 dispatchOne 里的 `isExpiryIntent` 前置支 ⇒ 这里
    //   `scheduledCalls` 变 1（到期把任务又跑了一遍）、且账不是 done。
    assert.equal(scheduledCalls, 0, '到期不是「再跑一次」，不许叫执行器');
    assert.equal(delivered.length, 1, '到期要说一声（#624 的「到期通知无消费者」）');
    assert.deepEqual(delivered[0].opts.recipients, [scene.userId], '收件人是订阅者本人');
    assert.match(delivered[0].opts.title, /到期/);
    assert.match(delivered[0].opts.body, /停用/);
    const row = await rowOf(pool, intent.macroRunId);
    // ⚠ 到期是正常结束 ⇒ **done**；写成 failed 会把每次到期显示成一次故障。
    assert.equal(row.status, 'done', `到期账必须 done（实际 ${row.status}）`);
    assert.equal(row.reason ?? null, null, 'done 不该带失败 reason');
  });
});

// —— 判据 7：普通（非到期）通知意图仍走原路，不被到期支误吞 ——
test('7. 非到期的 run-notify 意图仍按 kind 分派（到期支不是万能支）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T7'));
    const intent = await claimedIntent(pool, scene, {
      kind: 'run-notify', anchor: 'run:r-1', bucket: 'b0', criterion: 'terminal',
    });
    const delivered = [];
    const dispatcher = createIntentDispatcher({
      pool,
      deliverIntent: async (_pool, it, opts) => { delivered.push({ it, opts }); },
      log: { warn() {}, info() {} },
    });
    const out = await dispatcher.dispatch([intent]);
    assert.equal(out.dispatched, 1);
    assert.equal(delivered.length, 1, 'terminal/run-notify 仍要被投递');
    assert.match(delivered[0].opts.title, /daily-/, '标题仍是宏名（不是到期文案）');
    assert.equal((await rowOf(pool, intent.macroRunId)).status, 'done');
  });
});

// ── #637① 真实 runTask（pollRunTask）：等 run 到终态、收集判决与正文 ──────────────────
// 种一条会话 + run + transcript。⚠ 正文种在 transcript_rounds.messages（不是 messages.content：
// P3 PR②b 起 assistant 的 messages.content 是空串），pollRunTask 必须从这里取到正文。
async function seedRun(pool, scene, { status = 'running', assistantText = '这是巡检结果：一切正常' } = {}) {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, title_source, status, last_seq)
     VALUES ($1,$2,NULL,'s','manual','active',0)`, [sessionId, scene.userId]);
  await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1,$2,$3)`, [runId, sessionId, status]);
  await pool.query(
    `INSERT INTO transcript_rounds (run_id, round, record, messages)
     VALUES ($1,0,'{}'::jsonb,$2::jsonb)`,
    [runId, JSON.stringify([
      { role: 'user', content: '整理今日变更' },
      { role: 'assistant', content: assistantText },
    ])]);
  return { sessionId, runId };
}

// —— #637①-4：finished ⇒ ok:true 且 text 非空；failed ⇒ ok:false ——
test('#637①-4 pollRunTask：run finished ⇒ ok:true 且 text 非空；failed ⇒ ok:false', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T8'));
    const { runId } = await seedRun(pool, scene, { status: 'running' });
    await pool.query(`UPDATE runs SET status='finished', ended_at=now() WHERE id=$1`, [runId]); // queued/running → finished
    const ok = await pollRunTask({ pool, childRunId: runId }, { timeoutMs: 1000, pollMs: 5 });
    assert.equal(ok.ok, true, 'finished ⇒ ok:true');
    assert.ok(ok.text && ok.text.includes('这是巡检结果'), `text 必须取到 transcript 里的 assistant 正文（非空）：${ok.text}`);
    assert.equal(ok.termination.error, null);

    await pool.query(
      `UPDATE runs SET status='failed', error='{"code":"network","message":"fetch failed"}'::jsonb WHERE id=$1`, [runId]);
    const bad = await pollRunTask({ pool, childRunId: runId }, { timeoutMs: 1000, pollMs: 5 });
    assert.equal(bad.ok, false, 'failed ⇒ ok:false（不许记 done）');
    assert.equal(bad.termination.error?.code, 'network', 'termination 带上 run 的 error');
  });
});

// —— #637①-4b【接线锁】：dispatcher **缺省** runTask 必须就是 pollRunTask ——
// 上面 ①-4 直接测 `pollRunTask`、①-5 **注入** `runTask` ⇒ 两条都绕过 `defaultRunTask`。
// 主 agent 复验时把 `defaultRunTask` 改回空壳桩 `({ok:true,text:''})` 跑测试：**全绿**
// （①-5 的注释声称「改回空壳桩 ⇒ 本条红」，实测是假的 —— 它注入 runTask，压根不走缺省）。
// 本条钉的是「接线」：**不注入** runTask，走 createIntentDispatcher 的缺省，
// 断言产物正文来自 transcript（空壳桩会给空串 ⇒ 红）。
test('#637①-4b【接线锁】dispatcher 缺省 runTask = pollRunTask（不注入也等终态）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T8b'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w616home-b-'));
    const intent = await claimedIntent(pool, scene);
    // 入队后 **100ms 才失败**（复刻「run 起来了一会儿才被网络错误打死」）。
    // 判别器：空壳桩立刻返回 ok:true ⇒ 账 done（错）；缺省 pollRunTask 会等到 failed ⇒ 账 failed（对）。
    // ⚠ 这就是真机 bug 的形状：`status=failed` 的 run 被记成 `done`。
    const dispatcher = createIntentDispatcher({
      pool,
      config: { userSpaceRoot: home },
      reportsRoot: home, sessionsHome: home,
      log: { warn() {}, info() {} },
      executeScheduledIntent: async (p, it, opts) => {
        const { executeScheduledIntent: real } = await import('../src/macro-scheduled.js');
        return real(p, it, {
          ...opts,
          postMessageImpl: async (...args) => {
            const posted = await (await import('../src/sessions.js')).postMessage(...args);
            const rid = posted?.run?.id;
            if (rid) {
              setTimeout(() => {
                p.query(`UPDATE runs SET status='failed', error='{"code":"network","message":"fetch failed"}'::jsonb, ended_at=now() WHERE id=$1`, [rid])
                  .catch(() => {});
              }, 100);
            }
            return posted;
          },
        });
      },
    });
    const out = await dispatcher.dispatch([intent]);
    assert.equal(out.dispatched, 1);
    const row = await rowOf(pool, intent.macroRunId);
    // ⚠ 反向自证锚点：把 defaultRunTask 改回空壳桩 ⇒ 立刻 ok:true ⇒ 账 done ⇒ 本条红。
    assert.equal(row.status, 'failed',
      `run 后来 failed ⇒ 账必须 failed（空壳桩会立刻记 done）。实际 ${row.status}`);
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— #637①-5：run failed ⇒ macro_runs 落 failed 而非 done（真机 network 场景端到端）——
test('#637①-5 run failed ⇒ macro_runs 落 failed 而非 done（真机 network 场景）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T9'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w616home-'));
    const intent = await claimedIntent(pool, scene);
    // 真实 executeScheduledIntent + 真实 pollRunTask：runTask 把入队的 run 翻成 failed 再轮询（复刻 LLM 网关挂了）。
    const out = await executeScheduledIntent(pool, intent, {
      reportsRoot: home, sessionsHome: home, log: { warn() {}, info() {} },
      runTask: async (ctx) => {
        await pool.query(
          `UPDATE runs SET status='failed', error='{"code":"network","message":"fetch failed"}'::jsonb, ended_at=now()
             WHERE id=$1`, [ctx.childRunId]);
        return pollRunTask(ctx, { timeoutMs: 1000, pollMs: 5 });
      },
    });
    assert.equal(out.status, 'failed');
    // ⚠ 反向自证锚点：把 defaultRunTask 改回空壳桩 ({ok:true,text:''}) ⇒ runTask 立刻返回 ok:true ⇒ 账是 done ⇒ 本条红。
    const row = await rowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'failed', `run 真失败 ⇒ 账必须 failed，不是 done（实际 ${row.status}）`);
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— #637①-6：run 一直 queued ⇒ pollRunTask 到超时返回 ok:false + reason=run_timeout（短超时，别真等 30 分钟）——
test('#637①-6 run 一直 queued ⇒ pollRunTask 超时返回 ok:false + run_timeout', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T10'));
    const { runId } = await seedRun(pool, scene, { status: 'queued' });
    const t0 = Date.now();
    const res = await pollRunTask({ pool, childRunId: runId }, { timeoutMs: 40, pollMs: 5 });
    assert.equal(res.ok, false, '超时 ⇒ ok:false');
    assert.equal(res.termination.reason, 'run_timeout', `超时 reason 必须是 run_timeout：${JSON.stringify(res.termination)}`);
    assert.ok(Date.now() - t0 < 3000, `短超时必须快速返回（实际 ${Date.now() - t0}ms，别真等 30 分钟）`);
  });
});
