// issue #536（W7 / M7）：定时任务执行器 e2e —— 宏会话复用 / notes 跨 tick / 失败通知 / 产物落点。
//
// 环境门（口径同 `macro-review.test.js`）：`TEST_DATABASE_URL` 未设 ⇒ 整文件 skip；真库自起：
//   docker run -d --name w7-pg -e POSTGRES_USER=station -e POSTGRES_PASSWORD=station \
//     -e POSTGRES_DB=station_test -p 127.0.0.1:15492:5432 postgres:16
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15492/station_test \
//     node --test portal/test/macro-scheduled.test.js
//
// 执行体走**桩 runner**（不真调模型）：runTask 把入队的 run 直接收口成终态（模拟它跑完了），
// 并往 ctx.notesDir 写一条注（模拟 agent 的 note_take）。notes 作用域 = sessionId，
// 所以「第二次 tick 看得到第一次的注」本质是在验**会话复用**（sessionId 稳定）。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { hashToken } from '../src/auth.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimMacroRun } from '../src/macros.js';
import { claimRun } from '../src/internal.js';
import {
  executeScheduledIntent, artifactPath, macroOrigin, macroSessionTitle,
} from '../src/macro-scheduled.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w7' }) : null;

const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), {
  poolMax: 2, log: () => {},
});

const ids = (tag) => ({
  userId: crypto.randomUUID(), containerId: crypto.randomUUID(),
  templateId: crypto.randomUUID(), assignmentId: crypto.randomUUID(),
  login: `w7${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
});

/** 一套可跑 scheduled-task 的现场：用户 / 容器 / scheduled-task 模板 + 订阅（无 session：user scope）。 */
async function seedScene(pool, scene, { cwd = '~/projects/w7demo' } = {}) {
  await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1,$2,'x','active')`,
    [scene.userId, scene.login]);
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1,$2,$3,'img','0.32.0','running',$4,$5)`,
    [scene.containerId, scene.userId, hashToken('tok-w7'), scene.login, `fde-${scene.login}`]);
  await pool.query(
    `INSERT INTO macro_templates (id, kind, name, params, audience, scope)
     VALUES ($1,'scheduled-task',$2,'{"at":"09:00","maxRounds":16}','all','user')`,
    [scene.templateId, `daily-${scene.login}`]);
  await pool.query(
    `INSERT INTO macro_assignments (id, template_id, user_id, session_id, cwd, enabled)
     VALUES ($1,$2,$3,NULL,$4,true)`,
    [scene.assignmentId, scene.templateId, scene.userId, cwd]);
  return scene;
}

/** W2 认领一条 tick（幂等键归它），返回与 buildIntent 同形的意图（含已占位的 macroRunId）。 */
async function tickIntent(pool, scene, {
  date = '2026-11-16', task = '整理今日变更',
  cwd = '~/projects/w7demo',   // #627②：意图快照里的 cwd 可改（= 用户改了模板/订阅的目录）
  maxRounds = 16,              // #627③：轮数上限可改（过去读了不用）
} = {}) {
  const claimed = await claimMacroRun(pool, {
    assignmentId: scene.assignmentId, anchor: `clock:${date}`, criterion: 'tick', bucket: date,
  });
  assert.ok(claimed?.id, 'claimMacroRun 应占位成功（tick）');
  return {
    assignmentId: scene.assignmentId, templateId: scene.templateId,
    templateKind: 'scheduled-task', templateName: `daily-${scene.login}`,
    params: { at: '09:00', cwd, task, maxRounds },
    userId: scene.userId, sessionId: null, cwd,
    anchor: `clock:${date}`, criterion: 'tick', bucket: date,
    evidence: { at: '09:00', local_date: date }, macroRunId: claimed.id,
  };
}

/** 成功桩：把入队的 run 收口成 finished（模拟它跑完），并往 notesDir 写一条注。 */
function okRunner(noteName) {
  return async ({ pool, childRunId, notesDir }) => {
    if (childRunId) {
      await pool.query(`UPDATE runs SET status='finished' WHERE id=$1`, [childRunId]);
    }
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(path.join(notesDir, noteName), 'note body', 'utf8');
    return { ok: true, text: '产物正文' };
  };
}

const runCount = (pool, sessionId) => pool.query(
  `SELECT count(*)::int AS n FROM runs WHERE session_id = $1`, [sessionId],
).then((r) => r.rows[0].n);
const macroRunRow = (pool, macroRunId) => pool.query(
  `SELECT status, verdict, reason, child_session_id, child_run_id FROM macro_runs WHERE id=$1`, [macroRunId],
).then((r) => r.rows[0]);

// —— 判据 1：两次 tick ⇒ **同一条会话、两条 run**（断言 session_id 相同）——
test('两次 tick 复用同一条宏会话、产出两条 run', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T1'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    const it1 = await tickIntent(pool, scene, { date: '2026-11-16' });
    const it2 = await tickIntent(pool, scene, { date: '2026-11-17' });

    const r1 = await executeScheduledIntent(pool, it1, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day1.md'),
    });
    const r2 = await executeScheduledIntent(pool, it2, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day2.md'),
    });

    assert.equal(r1.status, 'done');
    assert.equal(r2.status, 'done');
    assert.ok(r1.sessionId, '第一次应产生会话');
    assert.equal(r1.sessionId, r2.sessionId, '复用：两次必须同一条会话');

    const row1 = await macroRunRow(pool, it1.macroRunId);
    const row2 = await macroRunRow(pool, it2.macroRunId);
    assert.equal(row1.child_session_id, row2.child_session_id, '账上的 child_session_id 必须相同');
    assert.notEqual(row1.child_run_id, row2.child_run_id, '但两次 run 必须不同');
    assert.equal(await runCount(pool, r1.sessionId), 2, '同会话下应有两条 run');

    // origin 与标题按设计写死
    const s = (await pool.query(
      `SELECT origin, title FROM chat_sessions WHERE id=$1`, [r1.sessionId])).rows[0];
    assert.equal(s.origin, macroOrigin(it1.templateName), 'origin = macro:<模板名>');
    assert.equal(s.title, macroSessionTitle(it1.templateName), '标题 = <宏名> · 长期');
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— 判据 2：第二次 tick 时 notes 跨 tick 可见（会话复用 ⇒ notes 目录稳定）——
test('notes 跨 tick 可见（第二次能列到第一次写的注）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T2'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    const it1 = await tickIntent(pool, scene, { date: '2026-11-16' });
    await executeScheduledIntent(pool, it1, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day1.md'),
    });

    // 第二次 tick 的桩先「note_list」：读同 sessionId 的 notes 目录，必须看到 day1 的注。
    let sawFirstNoteOnSecondTick = false;
    const probeRunner = async ({ pool: p, childRunId, notesDir }) => {
      if (childRunId) await p.query(`UPDATE runs SET status='finished' WHERE id=$1`, [childRunId]);
      const entries = await fs.readdir(notesDir).catch(() => []);
      sawFirstNoteOnSecondTick = entries.includes('day1.md');
      await fs.writeFile(path.join(notesDir, 'day2.md'), 'note body', 'utf8');
      return { ok: true, text: '产物' };
    };
    const it2 = await tickIntent(pool, scene, { date: '2026-11-17' });
    await executeScheduledIntent(pool, it2, { reportsRoot, sessionsHome: home, runTask: probeRunner });

    assert.ok(sawFirstNoteOnSecondTick, '第二次 tick 的 notes 目录必须含第一次写的 day1.md');
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— 判据 3：桩失败 ⇒ status='failed' + 一条通知 + **没有第二次自动重试** ——
test('runTask 失败 ⇒ failed + 一条 error 通知 + 不自动重试', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T3'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    let calls = 0;
    const failing = async ({ pool: p, childRunId }) => {
      calls += 1;
      if (childRunId) await p.query(`UPDATE runs SET status='failed' WHERE id=$1`, [childRunId]);
      throw new Error('模型炸了');
    };
    const it = await tickIntent(pool, scene, { date: '2026-11-16' });
    const out = await executeScheduledIntent(pool, it, {
      reportsRoot, sessionsHome: home, runTask: failing,
    });

    assert.equal(out.status, 'failed');
    assert.equal(calls, 1, '只驱动一次：失败不得自动重试');
    const row = await macroRunRow(pool, it.macroRunId);
    assert.equal(row.status, 'failed');
    assert.ok((row.reason || '').includes('模型炸了'), 'reason 记下失败原因');

    // 恰一条通知，severity=error，收件人是订阅人本人（普通用户）
    const notes = (await pool.query(
      `SELECT user_id, severity FROM notifications WHERE macro_run_id=$1`, [it.macroRunId])).rows;
    assert.equal(notes.length, 1, '失败必须且只发一条通知');
    assert.equal(notes[0].severity, 'error');
    assert.equal(notes[0].user_id, scene.userId, '通知给订阅人本人（不是只给 admin）');
    await fs.rm(home, { recursive: true, force: true });
  });
});

// —— 判据 4：产物落在 reportsRoot 下、**不在** ~/projects/ 下 ——
test('产物落在 reportsRoot 下、不在 projects 下（收工灯不受污染）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T4'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    const it = await tickIntent(pool, scene, { date: '2026-11-16' });
    const out = await executeScheduledIntent(pool, it, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day1.md'),
    });

    assert.ok(out.artifactPath, '成功应有产物路径');
    assert.ok(out.artifactPath.startsWith(reportsRoot), `产物必须在 reportsRoot 下：${out.artifactPath}`);
    assert.ok(!out.artifactPath.includes(path.join(home, 'projects')) && !out.artifactPath.includes('/projects/'),
      `产物路径不得含 /projects/（否则收工灯变红）：${out.artifactPath}`);
    assert.equal(out.artifactPath, artifactPath(reportsRoot, it.templateName, it.bucket));
    const written = await fs.readFile(out.artifactPath, 'utf8');
    assert.equal(written, '产物正文', '产物内容 = 执行体返回的正文（平台落盘，非模型自写）');
    await fs.rm(home, { recursive: true, force: true });
  });
});

// ── #627② 改模板 cwd ⇒ 下一次 tick 用新 cwd ────────────────────────────────────
// 过去的静默失效：`getOrCreateMacroSession` 只按 (user, origin) 复用 ⇒ 会话带着旧 cwd 被一直
// 复用，而 run 的 cwd 是 claim 时读 `chat_sessions.cwd` ⇒ 用户把目录从 a 改到 b，任务仍在 a 跑。
test('#627② 模板 cwd 改了 ⇒ 下次 tick 用新 cwd（新建宏会话，旧会话保留历史）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T5'), { cwd: '~/projects/old-dir' });
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    const it1 = await tickIntent(pool, scene, { date: '2026-11-16', cwd: '~/projects/old-dir' });
    const r1 = await executeScheduledIntent(pool, it1, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day1.md'),
    });
    assert.equal(r1.status, 'done');

    // 用户改目录：订阅（模板）cwd 变成新值，下一次 tick 的意图快照也是新值。
    await pool.query(`UPDATE macro_assignments SET cwd = $2 WHERE id = $1`,
      [scene.assignmentId, '~/projects/new-dir']);
    const it2 = await tickIntent(pool, scene, { date: '2026-11-17', cwd: '~/projects/new-dir' });
    const r2 = await executeScheduledIntent(pool, it2, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day2.md'),
    });
    assert.equal(r2.status, 'done');

    assert.notEqual(r2.sessionId, r1.sessionId,
      'cwd 变了必须换会话：沿用旧会话 = 沿用旧 cwd（#627② 的静默失效）');
    const s1 = (await pool.query(`SELECT cwd, origin, status FROM chat_sessions WHERE id=$1`, [r1.sessionId])).rows[0];
    const s2 = (await pool.query(`SELECT cwd, origin, status FROM chat_sessions WHERE id=$1`, [r2.sessionId])).rows[0];
    assert.equal(s1.cwd, '~/projects/old-dir', '旧会话保持旧 cwd（历史留在它自己的目录里）');
    assert.equal(s2.cwd, '~/projects/new-dir', '新会话必须带新 cwd ⇒ claim 时 run 的 cwd 就是新目录');
    assert.equal(s2.origin, s1.origin, 'origin 不变（同一个宏，只是目录换了）');
    assert.equal(s1.origin, macroOrigin(it1.templateName));
    assert.equal(s1.status, 'active', '旧会话保留（不归档、不删）');
    assert.equal(s2.status, 'active');

    // 同目录的第三次 tick 仍复用新会话（判据是 cwd 变了才换，不是每次都换）。
    const it3 = await tickIntent(pool, scene, { date: '2026-11-18', cwd: '~/projects/new-dir' });
    const r3 = await executeScheduledIntent(pool, it3, {
      reportsRoot, sessionsHome: home, runTask: okRunner('day3.md'),
    });
    assert.equal(r3.sessionId, r2.sessionId, '同 cwd ⇒ 仍复用，不得每拍新建会话');

    // 反向自证锚点：新会话里那条 run 的**有效 cwd**（claim 读的就是会话行的 cwd）必须是新目录。
    const ticketCwd = (await pool.query(
      `SELECT s.cwd FROM runs r JOIN chat_sessions s ON s.id = r.session_id WHERE r.id = $1`,
      [r2.childRunId])).rows[0].cwd;
    assert.equal(ticketCwd, '~/projects/new-dir', 'run 的 cwd（= claim 时读的会话 cwd）必须已刷新');
    await fs.rm(home, { recursive: true, force: true });
  });
});

// ── #627③ maxRounds 真的进 run（并随 claim 下行到 runner）──────────────────────
// 过去的静默失效：`executeScheduledIntent` 读了 params.maxRounds 却只传 4 个字段给 postMessage，
// 而 run 的 maxRounds 实际**只来自容器级 env** `ERIX_MAX_ROUNDS`（默认 16）⇒ 用户填几都是 16。
test('#627③ maxRounds=3 ⇒ 起出来的 run 带的是 3，并随 claim ticket 下行', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const scene = await seedScene(pool, ids('T6'));
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'w7home-'));
    const reportsRoot = path.join(home, 'reports');

    // 桩**不**收尾 run：让它留在 queued，好让 claimRun 把 ticket 取出来验下行值。
    const keepQueued = async () => ({ ok: true, text: '产物' });
    const it = await tickIntent(pool, scene, { date: '2026-11-16', maxRounds: 3 });
    const out = await executeScheduledIntent(pool, it, {
      reportsRoot, sessionsHome: home, runTask: keepQueued,
    });
    assert.equal(out.status, 'done');
    assert.ok(out.childRunId, '应真的起了一个 run');

    // ① run 行：宿主键 `host_max_rounds` 必须是 3（不是缺省 16）。
    const row = (await pool.query(`SELECT run_state FROM runs WHERE id=$1`, [out.childRunId])).rows[0];
    assert.equal(Number(row.run_state?.host_max_rounds), 3,
      'maxRounds 必须落到 run 行（过去根本没地方，永远是容器默认 16）');

    // ② ticket 下行：agentd 拿不到它 = 白写。
    const ticket = await claimRun(pool, {
      container: { id: scene.containerId, user_id: scene.userId },
      user: { id: scene.userId, login: scene.login },
      capacity: 1, holdMs: 10, log: { warn() {}, info() {} },
    });
    assert.ok(ticket, 'queued run 应能被 claim');
    assert.equal(ticket.run.id, out.childRunId);
    assert.equal(ticket.run.max_rounds, 3, 'claim ticket 必须把本次轮数上限下行给 runner');

    // ③ 对照：没声明 maxRounds 的 run ⇒ 不带这个键（用容器默认，不是 0 也不是 16 写死）。
    // 先收掉上一条：宏会话同刻只允许一个活跃 run（postMessage 会 409 run_in_progress）。
    await pool.query(`UPDATE runs SET status='finished', ended_at=now() WHERE id=$1`, [out.childRunId]);
    await pool.query(`UPDATE run_queue SET status='done' WHERE run_id=$1`, [out.childRunId]);
    const it2 = await tickIntent(pool, scene, { date: '2026-11-17' });
    const without = { ...it2, params: { ...it2.params, maxRounds: undefined } };
    const out2 = await executeScheduledIntent(pool, without, {
      reportsRoot, sessionsHome: home, runTask: keepQueued,
    });
    const row2 = (await pool.query(`SELECT run_state FROM runs WHERE id=$1`, [out2.childRunId])).rows[0];
    assert.equal(row2.run_state?.host_max_rounds ?? null, null,
      '没声明 ⇒ 不写键（不得把「未填」翻译成一个具体的轮数）');
    await fs.rm(home, { recursive: true, force: true });
  });
});
