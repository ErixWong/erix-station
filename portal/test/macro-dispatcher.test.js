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
import { assembleTicket } from '../src/internal.js';

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
const QUIET = { info() {}, warn() {}, error() {} }; // issue #662：静默日志（避免分派器的 warn 刷屏干扰判读）

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

// ── #637① / #652 真实 runTask（pollRunTask）：等 run 到终态、收集判决与正文 ──────────────
//
// ⚠ **#652 的教训就写在本函数的形状里**：#637 的 fixture 自己造 transcript 行并**显式写了
// `run_id`**，而真机 `transcript_rounds.run_id` **97% 是 NULL**（实测 96/3219；引擎 sidecar 走
// session 维度写：`run_id = NULL` + `transcript_key = sessionId`，见 `transcript-store.js#appendRound`）
// ⇒ 用例绿、线上产物 0 字节（fixture 比现实友好）。
// 所以本函数**照写入方的原样**种行（erix-agent 0.23 账本形状，三行全部 `run_id = NULL`、
// `transcript_key = sessionId`）：
//   · `:input:<messageId>` 宿主预写行（postMessage 写的那条）
//   · `:engine:round:<n>` 轮载体行（`messages` 为空数组）
//   · `:msg:<n>:<seq>` 正文行（`kind:'message'`，assistant 正文在它的 `record.messages` 里）
// ⚠ 正文只在 `record` 里：`messages.content` 对 assistant **恒为空串**（P3 PR②b 停双写），
// 所以锚点行的 content 也种空串——文本只能从读侧投影拿。
async function seedRun(pool, scene, { status = 'running', assistantText = '这是巡检结果：一切正常' } = {}) {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const round = 8; // 真机宏会话最后一轮的轮号（issue #652 的证据里就是 8）
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, title_source, status, last_seq)
     VALUES ($1,$2,NULL,'s','manual','active',2)`, [sessionId, scene.userId]);
  await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1,$2,$3)`, [runId, sessionId, status]);
  // 锚点行（messages 表）：user + assistant 各一条，**content 恒为空串**（PR②b 停双写）。
  await pool.query(
    `INSERT INTO messages (id, session_id, run_id, seq, role, content, synthetic)
     VALUES ($1,$2,$3,1,'user','',false), ($4,$2,$3,2,'assistant','',false)`,
    [messageId, sessionId, runId, crypto.randomUUID()]);
  // transcript 行：写入方口径（`run_id` 恒 NULL、`transcript_key = sessionId`、`append_seq` 用列默认）。
  const insert = `INSERT INTO transcript_rounds
       (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
     VALUES (NULL, $1, $2, $3, $4::jsonb, false, $5::jsonb, NULL)`;
  const put = (dedupKey, record) => pool.query(
    insert, [sessionId, dedupKey, round, JSON.stringify(record), JSON.stringify(record.messages ?? [])]);
  const inputKey = `${sessionId}:input:${messageId}`;
  await put(inputKey, { round, dedupKey: inputKey, messages: [{ role: 'user', content: '整理今日变更' }] });
  const engineKey = `${sessionId}:engine:round:${round}`;
  await put(engineKey, { round, dedupKey: engineKey, messages: [] });
  const msgKey = `${sessionId}:msg:${round}:0`;
  await put(msgKey, {
    round, dedupKey: msgKey, kind: 'message', seq: 0,
    messages: [{ role: 'assistant', content: [{ type: 'text', text: assistantText }] }],
  });
  return { sessionId, runId, round };
}

/** 只补「引擎写的那两行」（宿主预写的 `:input:` 行由真 postMessage 自己写）——端到端用例用。 */
async function seedEngineRound(pool, { sessionId, round = 8, assistantText }) {
  const insert = `INSERT INTO transcript_rounds
       (run_id, transcript_key, dedup_key, round, record, folded, messages, folded_payload)
     VALUES (NULL, $1, $2, $3, $4::jsonb, false, $5::jsonb, NULL)`;
  const engineKey = `${sessionId}:engine:round:${round}`;
  await pool.query(insert, [sessionId, engineKey, round,
    JSON.stringify({ round, dedupKey: engineKey, messages: [] }), JSON.stringify([])]);
  const msgKey = `${sessionId}:msg:${round}:0`;
  const messages = [{ role: 'assistant', content: [{ type: 'text', text: assistantText }] }];
  await pool.query(insert, [sessionId, msgKey, round,
    JSON.stringify({ round, dedupKey: msgKey, kind: 'message', seq: 0, messages }), JSON.stringify(messages)]);
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

// ── #652 正文取数口径（真机形态：transcript_key=sessionId、run_id 为 NULL）───────────────
// 反向自证锚点：把 `collectRunFinalText` 改回自己写 `... FROM transcript_rounds WHERE run_id=$1`
// ⇒ 下面 ①-③ 全红（真机就是这样：按 run_id 查恒 0 行 ⇒ 产物 0 字节）。
test('#652-1 真实 transcript 形状（run_id NULL + transcript_key=sessionId）⇒ pollRunTask 的 text 非空',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T11'));
    const { sessionId, runId } = await seedRun(pool, scene, { status: 'running' });
    // fixture 自证：transcript 行必须**全是 run_id IS NULL**（否则就又变回「比现实友好」的假现场）。
    const shape = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE run_id IS NULL)::int AS null_run_id,
              count(*) FILTER (WHERE transcript_key = $1)::int AS by_session_key
         FROM transcript_rounds`, [sessionId]);
    assert.ok(shape.rows[0].total >= 3, `至少要有 input/载体/正文三行：${JSON.stringify(shape.rows[0])}`);
    assert.equal(shape.rows[0].null_run_id, shape.rows[0].total,
      '所有 transcript 行的 run_id 必须为 NULL（线上 97% 的样子）');
    assert.equal(shape.rows[0].by_session_key, shape.rows[0].total,
      '所有 transcript 行必须挂在 transcript_key=sessionId 上');
    // assistant 锚点行的 content 必须是空串（PR②b 停双写）⇒ 正文不可能从 messages.content 拿到。
    const anchor = await pool.query(
      `SELECT content FROM messages WHERE run_id=$1 AND role='assistant'`, [runId]);
    assert.equal(anchor.rows[0].content, '', 'assistant 锚点 content 恒为空串（fixture 不许作弊）');

    await pool.query(`UPDATE runs SET status='finished', ended_at=now() WHERE id=$1`, [runId]);
    // 生产接线：executeScheduledIntent 传给 runTask 的 ctx **本来就带 sessionId**（macro-scheduled.js）。
    const res = await pollRunTask({ pool, childRunId: runId, sessionId }, { timeoutMs: 1000, pollMs: 5 });
    assert.equal(res.ok, true);
    assert.ok(typeof res.text === 'string' && res.text.includes('这是巡检结果'),
      `text 必须是投影出来的 assistant 正文（非空）：${JSON.stringify(res.text)}`);
  });
});

// —— #652-2 端到端：真 postMessage + 缺省 pollRunTask ⇒ 产物文件非 0 字节且就是那段正文 ——
test('#652-2 端到端（真 postMessage）⇒ 产物落盘非 0 字节、内容 = 该 run 的 assistant 正文',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T12'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w652home-'));
    const reportsRoot = path.join(home, 'reports');
    const intent = await claimedIntent(pool, scene);
    const body = '每日巡检：14 个文件有变更，无异常。';
    const out = await executeScheduledIntent(pool, intent, {
      reportsRoot, sessionsHome: home, log: { warn() {}, info() {} },
      runTask: async (ctx) => {
        // 引擎写侧的形状：正文只落 transcript（transcript_key=sessionId、run_id NULL），
        // 并给该 run 留一条 content 为空串的 assistant 锚点行（= 读侧投影的落点）。
        await seedEngineRound(pool, { sessionId: ctx.sessionId, assistantText: body });
        const seq = await pool.query(
          `SELECT COALESCE(max(seq),0)+1 AS s FROM messages WHERE session_id=$1`, [ctx.sessionId]);
        await pool.query(
          `INSERT INTO messages (id, session_id, run_id, seq, role, content, synthetic)
           VALUES ($1,$2,$3,$4,'assistant','',false)`,
          [crypto.randomUUID(), ctx.sessionId, ctx.childRunId, seq.rows[0].s]);
        await pool.query(`UPDATE runs SET status='finished', ended_at=now() WHERE id=$1`, [ctx.childRunId]);
        return pollRunTask(ctx, { timeoutMs: 1000, pollMs: 5 });
      },
    });
    assert.equal(out.status, 'done');
    assert.ok(out.artifactPath, `有输出就必须有产物路径：${JSON.stringify(out)}`);
    const st = await fs.stat(out.artifactPath);
    assert.ok(st.size > 0, `产物必须非 0 字节（#652 的现物就是 0 字节）：${out.artifactPath}`);
    const written = await fs.readFile(out.artifactPath, 'utf8');
    assert.ok(written.includes(body), `产物内容必须是该 run 的 assistant 正文，实际：${JSON.stringify(written)}`);
    const row = await rowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'done');
    assert.ok(!row.reason, `有产物时 reason 不得记 no_output：${row.reason}`);
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— #652-3 空正文的产物形态（拍板 (a)）：不落盘 + macro_runs.reason='no_output' ——
test('#652-3 run 成功但无正文 ⇒ 不落 0 字节文件，账上记 reason=no_output', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T13'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w652home-e-'));
    const reportsRoot = path.join(home, 'reports');
    const intent = await claimedIntent(pool, scene);
    const out = await executeScheduledIntent(pool, intent, {
      reportsRoot, sessionsHome: home, log: { warn() {}, info() {} },
      runTask: async (ctx) => {
        // 没有任何 transcript 正文（引擎这一轮只跑了工具 / 正文取不到）⇒ text 应为 ''。
        await pool.query(`UPDATE runs SET status='finished', ended_at=now() WHERE id=$1`, [ctx.childRunId]);
        return pollRunTask(ctx, { timeoutMs: 1000, pollMs: 5 });
      },
    });
    assert.equal(out.status, 'done', 'run 本身成功 ⇒ 账仍是 done（无产物不等于失败）');
    assert.equal(out.artifactPath, null, `无输出 ⇒ 不落盘（artifactPath 必须 null），实际 ${out.artifactPath}`);
    const files = [];
    const walk = async (dir) => {
      let entries = [];
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p); else files.push(p);
      }
    };
    await walk(reportsRoot);
    assert.deepEqual(files, [], `不该留下任何产物文件（0 字节文件是假账）：${files.join(', ')}`);
    const row = await rowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'done');
    assert.equal(row.reason, 'no_output', `账上必须能看出「本次无输出」，实际 reason=${row.reason}`);
    await fs.rm(home, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// issue #662：M9 完成审查的最后一块——快照接入 + 只读审查 run（独立会话 + review-only）
//          + per-run 标志（A 段）。全部**桩**（不真调模型）。
// ══════════════════════════════════════════════════════════════════════════════

/** 一套可走 run-review 的现场：用户/容器/被审会话（cwd=~/projects/rv）+ 原 run（终态）+ run-review 订阅。 */
async function seedReviewScene(pool, scene) {
  const sessionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status, fde_name) VALUES ($1,$2,'x','active',$2)`,
    [scene.userId, scene.login],
  );
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1,$2,$3,'img','0.32.0','running',$4,$5)`,
    [scene.containerId, scene.userId, hashToken('tok-662'), scene.login, `fde-${scene.login}`],
  );
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, model, cwd, status, last_seq)
     VALUES ($1,$2,NULL,'被审会话','mock-model','~/projects/rv','active',2)`,
    [sessionId, scene.userId],
  );
  await pool.query(
    `INSERT INTO runs (id, session_id, status, termination, rounds, usage, error)
     VALUES ($1,$2,'finished','{"reason":"end_turn"}',4,'{"input_tokens":1,"output_tokens":1}','{"code":"none"}')`,
    [runId, sessionId],
  );
  await pool.query(
    `INSERT INTO messages (id, session_id, run_id, seq, role, content)
     VALUES ($1,$2,$3,1,'user','把登录修好'), ($4,$2,$3,2,'assistant','我修好了，测试全过')`,
    [crypto.randomUUID(), sessionId, runId, crypto.randomUUID()],
  );
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, params, audience, scope)
     VALUES ($1,'run-review',$2,'{}','all','session')`,
    [scene.templateId, `rv-${scene.login}`],
  );
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, until, enabled)
     VALUES ($1,$2,$3,$4,NULL,true)`,
    [scene.assignmentId, scene.templateId, scene.userId, sessionId],
  );
  return { ...scene, sessionId, runId };
}

/** 认领一条 run-review 并造出分发器要的意图（anchor=run:<原 run>）。 */
async function claimReviewIntent(pool, scene) {
  const { id: macroRunId } = await claimMacroRun(pool, {
    assignmentId: scene.assignmentId, anchor: `run:${scene.runId}`, criterion: 'terminal', bucket: scene.runId,
  });
  return {
    templateKind: 'run-review', macroRunId, anchor: `run:${scene.runId}`, userId: scene.userId,
    params: { max_rounds: 5 }, evidence: {},
  };
}

const reviewRowOf = (pool, id) => pool.query(
  `SELECT status, verdict, reason, remediation_text, child_run_id, worktree_path, snapshot_id
     FROM macro_runs WHERE id = $1`, [id]).then((r) => r.rows[0]);

// —— #662-1：run-review 分派**建快照**，且 worktreePath 传到 runMacroReview ——
test('#662-1 run-review 分派建快照，快照 worktreePath 传给 runMacroReview（并落 macro_runs.worktree_path）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedReviewScene(pool, ids('R1'));
    const intent = await claimReviewIntent(pool, scene);
    const WT = '/tmp/wt-662-r1';
    let snapCalls = 0;
    let snapArg = null;
    let snapshotPassed = null;
    const fake = { ok: true, snapshotId: 'snap-1', worktreePath: WT, contentDigest: 'd' };
    const d = createIntentDispatcher({
      pool, log: QUIET,
      createSnapshot: async (a) => { snapCalls += 1; snapArg = a; return fake; },
      runMacroReview: async (_p, o) => { snapshotPassed = o.snapshot; return { macroRunId: o.macroRunId, status: 'done', verdict: 'pass' }; },
    });
    await d.dispatch([intent]);
    assert.equal(snapCalls, 1, 'createSnapshot 必须恰好调用一次');
    assert.ok(snapArg && typeof snapArg.repoDir === 'string' && snapArg.repoDir, `createSnapshot 必须带 repoDir：${JSON.stringify(snapArg)}`);
    assert.equal(snapshotPassed?.worktreePath, WT, `worktreePath 必须传到 runMacroReview：${JSON.stringify(snapshotPassed)}`);
    assert.equal(snapshotPassed?.ok, true, '快照对象（含 ok:true）必须原样传下去');
    const row = await reviewRowOf(pool, intent.macroRunId);
    assert.equal(row.worktree_path, WT, 'worktree_path 必须落 macro_runs（供 W4a 孤儿清扫关联回收）');
  });
});

// —— #662-2：快照失败（ok:false）⇒ 原样传下去走 runMacroReview 的失败出口（不回灌）——
test('#662-2 快照失败 ⇒ status=failed / verdict=unclassified / 不回灌 / 审查 runner 不起',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedReviewScene(pool, ids('R2'));
    const intent = await claimReviewIntent(pool, scene);
    let runnerCalled = 0;
    const d = createIntentDispatcher({
      pool, log: QUIET,
      createSnapshot: async () => ({ ok: false, reason: 'disk_low', worktreePath: '/tmp/wt-r2' }),
      reviewRunner: () => { runnerCalled += 1; return '结论：整改\n不该跑到这里'; },
      // runMacroReview 用真实缺省实现（快照失败出口已实现）
    });
    await d.dispatch([intent]);
    const row = await reviewRowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'failed', `快照失败 ⇒ failed：${JSON.stringify(row)}`);
    assert.equal(row.verdict, 'unclassified', '快照失败 ⇒ unclassified');
    assert.equal(row.remediation_text, null, '不回灌：remediation_text 必为 null');
    assert.equal(row.child_run_id, null, '不回灌：child_run_id 必为 null');
    assert.equal(runnerCalled, 0, '快照失败时绝不该起审查 run');
  });
});

// —— #662-3：审查 run 是 review-only（postMessage 收到 reviewOnly===true）——
test('#662-3 缺省审查 runner：postMessage 收到 reviewOnly===true + triggerKind=synthetic',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedReviewScene(pool, ids('R3'));
    const intent = await claimReviewIntent(pool, scene);
    const WT = '/tmp/wt-662-r3';
    let pmOpts = null;
    const d = createIntentDispatcher({
      pool, log: QUIET,
      createSnapshot: async () => ({ ok: true, snapshotId: 's', worktreePath: WT, contentDigest: 'd' }),
      postMessage: async (_p, o) => { pmOpts = o; return { run: { id: crypto.randomUUID() } }; },
      reviewTask: async () => ({ ok: true, text: '结论：通过', termination: { reason: 'finished', error: null }, error: null }),
      // reviewRunner 不注入 ⇒ 走缺省 runReviewTaskDefault
    });
    await d.dispatch([intent]);
    assert.ok(pmOpts, '缺省审查 runner 必须调用 postMessage');
    assert.equal(pmOpts.reviewOnly, true, `审查 run 必须声明 reviewOnly:true，实得：${pmOpts.reviewOnly}`);
    assert.equal(pmOpts.triggerKind, 'synthetic', '审查 run 必须是 synthetic');
  });
});

// —— #662-4：审查 run 的 cwd = 快照 worktree（postMessage 收到 cwd===worktreePath）——
test('#662-4 缺省审查 runner：postMessage 的 cwd === snapshot.worktreePath（独立只读会话）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedReviewScene(pool, ids('R4'));
    const intent = await claimReviewIntent(pool, scene);
    const WT = '/tmp/wt-662-r4-isolated';
    let pmOpts = null;
    const d = createIntentDispatcher({
      pool, log: QUIET,
      createSnapshot: async () => ({ ok: true, snapshotId: 's', worktreePath: WT, contentDigest: 'd' }),
      postMessage: async (_p, o) => { pmOpts = o; return { run: { id: crypto.randomUUID() } }; },
      reviewTask: async () => ({ ok: true, text: '结论：通过', termination: { reason: 'finished', error: null }, error: null }),
    });
    await d.dispatch([intent]);
    assert.ok(pmOpts, '缺省审查 runner 必须调用 postMessage');
    assert.equal(pmOpts.cwd, WT, `cwd 必须 = 快照 worktree，实得：${pmOpts.cwd}`);
  });
});

// —— #662-5：端到端（桩 runner）结论：整改 ⇒ verdict=red + 回灌（既有行为不变）——
test('#662-5 桩 runner 返回「结论：整改」⇒ verdict=red + 回灌（remediation_text/child_run_id 落账）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedReviewScene(pool, ids('R5'));
    const intent = await claimReviewIntent(pool, scene);
    let runnerCalled = 0;
    const d = createIntentDispatcher({
      pool, log: QUIET,
      createSnapshot: async () => ({ ok: true, snapshotId: 's', worktreePath: '/tmp/wt-662-r5', contentDigest: 'd' }),
      reviewRunner: ({ brief }) => { runnerCalled += 1; assert.ok(brief.includes('原任务'), '工作包应含原任务段'); return '结论：整改\n有 3 个未跟踪文件'; },
      // runMacroReview 用真实缺省实现 + 真实回灌 postMessage
    });
    await d.dispatch([intent]);
    assert.equal(runnerCalled, 1, '审查 runner 跑一次');
    const row = await reviewRowOf(pool, intent.macroRunId);
    assert.equal(row.status, 'done');
    assert.equal(row.verdict, 'red', `桩返回整改 ⇒ red：${JSON.stringify(row)}`);
    assert.ok(row.remediation_text && row.remediation_text.startsWith('[系统] '), `回灌正文以 [系统] 开头：${row.remediation_text}`);
    assert.ok(row.child_run_id, 'red 已回灌 ⇒ child_run_id 应落账');
  });
});

// —— #662-A：per-run review-only 标志（纯函数，无需 DB）——
test('#662-A assembleTicket 下行 review_only + agentd 仅 true 置 RUN_REVIEW_ONLY=1', async () => {
  const base = { queueId: 'q', claimToken: 'c', leaseUntil: '2026-01-01T00:00:00Z', project: {}, message: { content: 'x' }, attempts: 1 };
  assert.equal(assembleTicket({ ...base, run: { id: 'r', session_id: 's', review_only: true } }).run.review_only, true);
  assert.equal(assembleTicket({ ...base, run: { id: 'r', session_id: 's', review_only: false } }).run.review_only, null, 'false ⇒ null（区分没声明/声明关）');
  assert.equal(assembleTicket({ ...base, run: { id: 'r', session_id: 's' } }).run.review_only, null, '缺失 ⇒ null');
  process.env.FDE_HOME = process.env.FDE_HOME || '/tmp/erix-662-home';
  process.env.ERIX_STATION_TOKEN = process.env.ERIX_STATION_TOKEN || 'test-token';
  const { buildWorkerEnv } = await import('../../runner/agentd.js');
  assert.equal(buildWorkerEnv({ review_only: true }, {}).RUN_REVIEW_ONLY, '1', 'review_only=true ⇒ RUN_REVIEW_ONLY=1');
  assert.ok(!('RUN_REVIEW_ONLY' in buildWorkerEnv({ review_only: false }, {})), 'false ⇒ 不设 RUN_REVIEW_ONLY');
  assert.ok(!('RUN_REVIEW_ONLY' in buildWorkerEnv({}, {})), '缺失 ⇒ 不设 RUN_REVIEW_ONLY');
});
