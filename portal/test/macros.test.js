// issue #524（事件平台 W1 数据层）：`portal/src/macros.js` + 迁移 0035 的用例。
//
// 环境门（口径照 `portal/test/prune-checkpoints-db.test.js` / `delta-not-persisted-db.test.js`）：
// `TEST_DATABASE_URL` 未设置 ⇒ **真库用例整体 skip**，纯逻辑用例照跑。跑法：
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15432/station_test \
//     node --test portal/test/macros.test.js
// 夹具用 `./pg-fixture.js`（真库夹具的唯一实现：跨进程文件锁 + 每用例自建新库 + 跑完整迁移链）。
//
// 判据面（本单三条硬语义各自的落点）：
//   ① 幂等：`claimMacroRun` 同键第二次必须返回 `null`（SQL 是 `ON CONFLICT DO NOTHING`；
//      写成「先 SELECT 再 INSERT」时这里的第二条腿会拿到一个新 id ⇒ 本文件那条断言就是防它回退）。
//   ② 软删三分支（07 篇 §2.3）：零引用物理删 / 只有订阅物理删 + 级联 / 有账或有通知只能软删。
//      `notifications` 是 **W3 才建**的表 ⇒ 「表存在则检查」这一支用临时表现场接上验证。
//   ③ `until` 到期 ⇒ `enabled = false`，且按**瞬时**判定（不受机器时区影响）。
//   外加四条枚举 CHECK（`kind` / `state` / `skipped_reason` / `verdict`）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import {
  MACRO_KINDS, MACRO_AUDIENCES, MACRO_SCOPES, MACRO_RUN_STATES, MACRO_RUN_TERMINAL_STATES,
  MACRO_SKIPPED_REASONS, MACRO_VERDICTS,
  MacroError, validateMacroEnum, validateMacroKind, validateMacroRunState,
  isAssignmentExpired, toInstant, toAssignmentSnapshot,
  encodeMacroRunCursor, decodeMacroRunCursor,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  listAssignments, assignTemplate, unassignTemplate, applyExpiredAssignments,
  claimMacroRun, finishMacroRun, listMacroRuns,
} from '../src/macros.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0035 = path.join(HERE, '../../deploy/migrations/0035-macro-platform.sql');

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w524' }) : null;

/** 夹具包一层：用例体只拿 pool（`withFreshDatabase` 跑完整链：baseline → bootstrap → 全部增量含 0035）。 */
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

/** 建一个能过 FK 的最小场景：user → project → session。id 由 UUIDv4 给（不 cwd 派生，同 runs.id 红线）。 */
async function seedScene(pool, tag) {
  const userId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
    [userId, `m524${tag}`],
  );
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1, $2, $3, 'git@x:y/z.git', '~/projects/x', 0)`,
    [projectId, userId, `p524${tag}`],
  );
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title) VALUES ($1, $2, $3, 's')`,
    [sessionId, userId, projectId],
  );
  return { userId, projectId, sessionId };
}

/** 断言抛的是 `MacroError` 且 code 对（不靠 message 文案判等）。 */
function assertMacroError(code, fn) {
  return fn().then(
    () => assert.fail(`应当抛 MacroError(${code})`),
    (e) => {
      assert.ok(e instanceof MacroError, `错误类型应为 MacroError，实际 ${e?.constructor?.name}: ${e?.message}`);
      assert.equal(e.code, code);
      return e;
    },
  );
}

/** pg 的 CHECK 违约码（23514 check_violation）——枚举闸只认这个码，不认文案。 */
const CHECK_VIOLATION = '23514';

// ── 纯逻辑（无 PG 也要跑）──────────────────────────────────────────────────────

test('#524 JS 枚举与迁移 0035 的 CHECK 同源（八种 skipped_reason / 六种 state / 四种 kind 一个都不能少）', () => {
  const sql = fs.readFileSync(MIGRATION_0035, 'utf8');
  for (const values of [MACRO_KINDS, MACRO_AUDIENCES, MACRO_SCOPES, MACRO_RUN_STATES,
    MACRO_SKIPPED_REASONS, MACRO_VERDICTS]) {
    for (const v of values) {
      assert.ok(sql.includes(`'${v}'`), `迁移 CHECK 里缺 '${v}'：JS 与 SQL 两份枚举漂了`);
    }
  }
  // 数量本身也是契约（09 篇 §7 要「为什么没跑」可分组 ⇒ 八种穷举，不许退化成自由文本）。
  assert.equal(MACRO_SKIPPED_REASONS.length, 8);
  assert.equal(MACRO_RUN_STATES.length, 6);
  assert.equal(MACRO_KINDS.length, 4);
  assert.deepEqual(MACRO_RUN_TERMINAL_STATES, ['done', 'skipped', 'failed', 'superseded']);
  // 终态必须是 state 的子集（`finishMacroRun` 补 finished_at 的判据靠这个包含关系）。
  for (const s of MACRO_RUN_TERMINAL_STATES) assert.ok(MACRO_RUN_STATES.includes(s));
});

test('#524 枚举校验：非法 kind / state 当场 validation_failed（不是写进 DB 才发现）', () => {
  assert.equal(validateMacroKind('run-review'), 'run-review');
  assert.equal(validateMacroRunState('superseded'), 'superseded');
  assert.throws(() => validateMacroKind('run-partyy'), (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.throws(() => validateMacroEnum('state', 'zombie', MACRO_RUN_STATES),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.throws(() => validateMacroEnum('verdict', undefined, MACRO_VERDICTS),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.equal(validateMacroEnum('verdict', null, MACRO_VERDICTS, { nullable: true }), null);
});

test('#524 until 到期判定按瞬时：换时区不改结论（红线③的纯函数那一半）', () => {
  const until = new Date('2026-01-02T00:00:00Z');
  assert.equal(isAssignmentExpired(until, new Date('2026-01-01T23:59:59Z')), false);
  // 同一时刻的两种写法：+08:00 偏移的本地串必须是同一个瞬时 ⇒ 结论不许变。
  // （这一条防的是 `toISOString().slice(0,10)` 那种「按本地日」的写法：它会让
  //   `until=…T00:00Z` 在 UTC+8 的机器上提前一天到期。）
  assert.equal(isAssignmentExpired(until, new Date('2026-01-02T07:59:59+08:00')), false);
  assert.equal(isAssignmentExpired(until, new Date('2026-01-02T08:00:01+08:00')), true);
  assert.equal(isAssignmentExpired(until, '2026-01-02T00:00:00.000Z'), true, '边界：until <= now 即到期');
  assert.equal(isAssignmentExpired(null, new Date()), false, '没有 until = 永不过期');
  assert.throws(() => toInstant('until', 'not-a-date'), (e) => e instanceof MacroError && e.code === 'validation_failed');
  // `expired` 只是推导出的**展示态**（口径同 run 的「已取消」推导），不是第四种状态。
  const snap = toAssignmentSnapshot({
    id: 'x', template_id: 't', user_id: 'u', until: '2020-01-01T00:00:00Z', enabled: true, created_at: new Date(0),
  }, new Date('2020-01-02T00:00:00Z'));
  assert.equal(snap.expired, true);
  assert.equal(snap.effective_enabled, false, 'DB 里 enabled 还是 true，但对外必须报不可用');
});

test('#524 keyset 游标：能往返，脏串是 validation_failed（不是裸 JSON.parse 崩）', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  const back = decodeMacroRunCursor(encodeMacroRunCursor({ started_at: new Date('2026-01-02T03:04:05Z'), id }));
  assert.equal(back.startedAt.toISOString(), '2026-01-02T03:04:05.000Z');
  assert.equal(back.id, id);
  assert.throws(() => decodeMacroRunCursor('@@@ 不是 base64url 的 JSON @@@'),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.throws(() => decodeMacroRunCursor(Buffer.from('{"t":null}').toString('base64url')),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
});

test('#524 环境门自证：没有 TEST_DATABASE_URL 时真库用例都是 skip（不会假装绿）', () => {
  assert.equal(SKIP, URL_VALUE ? false : SKIP_WITHOUT_PG);
});

// ── 真库用例──────────────────────────────────────────────────────────────────

test('#524 幂等键：同 (assignment, anchor, state, bucket) 二次 claimMacroRun 返回 null（红线①）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a1');
    const tpl = await createTemplate(pool, {
      kind: 'run-notify', name: '跑完告诉我', scope: 'session', params: { tone: 'brief' }, createdBy: userId,
    });
    assert.deepEqual((await getTemplate(pool, { templateId: tpl.id })).params, { tone: 'brief' },
      'params 是 jsonb：进得去也原样出得来');
    const asg = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });

    // 显式给 started_at：翻页断言要的是确定序，不能靠「三条语句恰好落在不同微秒」。
    const base = Date.parse('2026-03-01T00:00:00Z');
    const c1 = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run-1', bucket: 'b0', startedAt: base + 1 });
    assert.ok(c1?.id, '第一次必须拿到 id');
    const c2 = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run-1', bucket: 'b0', startedAt: base + 2 });
    assert.equal(c2, null, '同键第二次必须是 null（幂等命中）——改成先 SELECT 再 INSERT，这里会是一个新 id');
    const c3 = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run-1', bucket: 'b1', startedAt: base + 3 });
    assert.ok(c3?.id, '换 bucket 不是同一次事件 ⇒ 应当能认领');
    const c4 = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run-2', bucket: 'b0', startedAt: base + 4 });
    assert.ok(c4?.id);
    assert.equal((await claimMacroRun(pool, { assignmentId: '00000000-0000-4000-8000-000000000000', anchor: 'x', bucket: 'b' })),
      null, '订阅不存在也是 null（不拿认领当存在性探针）');

    // 认领顺手写了 last_evaluated_at（W2 的「这条订阅多久没被看过」判据）。
    const [rowAsg] = (await pool.query('SELECT last_evaluated_at FROM macro_assignments WHERE id = $1', [asg.id])).rows;
    assert.ok(rowAsg.last_evaluated_at, '认领必须留下评估时刻');

    // 收口 + keyset 翻页：limit=1 逐页走，不重不漏。
    await finishMacroRun(pool, { macroRunId: c1.id, state: 'done', verdict: 'pass', verdictRaw: 'LGTM' });
    const done = (await pool.query('SELECT state, finished_at, verdict, verdict_raw FROM macro_runs WHERE id = $1',
      [c1.id])).rows[0];
    assert.equal(done.state, 'done');
    assert.ok(done.finished_at, '进终态必须补 finished_at');
    assert.equal(done.verdict_raw, 'LGTM', '原话留在 verdict_raw（口径改了能回溯重算）');

    const p1 = await listMacroRuns(pool, { assignmentId: asg.id, limit: 1 });
    assert.equal(p1.runs.length, 1);
    assert.equal(p1.runs[0].id, c4.id, '倒序：started_at 最新的那条在最前');
    assert.ok(p1.nextCursor);
    const seen = [...p1.runs];
    let cur = p1.nextCursor;
    while (cur) {
      const next = await listMacroRuns(pool, { assignmentId: asg.id, limit: 1, cursor: cur });
      seen.push(...next.runs);
      cur = next.nextCursor;
    }
    assert.equal(seen.length, 3, '三条账一条不多一条不少（OFFSET 分页在并发插入下会重/漏，keyset 不会）');
    assert.equal(new Set(seen.map((r) => r.id)).size, 3);
    assert.deepEqual(seen.map((r) => r.id), [c4.id, c3.id, c1.id]);
    assert.equal(seen.find((r) => r.id === c1.id).verdict, 'pass');
    // 按模板筛（走 JOIN macro_assignments —— 索引选型的那一支）
    const byTpl = await listMacroRuns(pool, { templateId: tpl.id, state: 'pending' });
    assert.deepEqual(byTpl.runs.map((r) => r.id).sort(), [c3.id, c4.id].sort());
    assert.equal(byTpl.nextCursor, null);
  });
});

test('#524 软删三分支（07 §2.3）：零引用物理删 / 只有订阅级联删 / 有账或有通知只能软删', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a2');

    // ── 分支一：零引用 ⇒ 物理删（行真的没了）
    const t1 = await createTemplate(pool, { kind: 'run-review', name: '零引用', scope: 'user' });
    assert.equal((await deleteTemplate(pool, { templateId: t1.id })).mode, 'deleted');
    assert.equal((await pool.query('SELECT 1 FROM macro_templates WHERE id = $1', [t1.id])).rowCount, 0,
      '零引用必须物理删，不留 deleted_at 的僵尸行');

    // ── 分支二：只有订阅、无执行记录 ⇒ 物理删 + 级联删订阅
    const t2 = await createTemplate(pool, { kind: 'scheduled-task', name: '只有订阅', scope: 'user' });
    const a2 = await assignTemplate(pool, { templateId: t2.id, userId });
    const r2 = await deleteTemplate(pool, { templateId: t2.id });
    assert.equal(r2.mode, 'deleted_with_assignments');
    assert.equal(r2.assignmentsRemoved, 1);
    assert.equal((await pool.query('SELECT 1 FROM macro_templates WHERE id = $1', [t2.id])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM macro_assignments WHERE id = $1', [a2.id])).rowCount, 0,
      '订阅必须跟着级联消失（迁移里 template_id 是 ON DELETE CASCADE）');

    // ── 分支三（有执行账）⇒ 只能软删
    const t3 = await createTemplate(pool, { kind: 'run-silence-alert', name: '有账', scope: 'session' });
    const a3 = await assignTemplate(pool, { templateId: t3.id, userId, sessionId });
    assert.ok((await claimMacroRun(pool, { assignmentId: a3.id, anchor: 'run-x', bucket: 'b0' }))?.id);
    const r3 = await deleteTemplate(pool, { templateId: t3.id });
    assert.equal(r3.mode, 'soft', '有执行账 ⇒ 不许物理删（既成事实必须能被解释）');
    assert.equal(r3.macroRuns, 1);
    assert.ok((await pool.query('SELECT deleted_at FROM macro_templates WHERE id = $1', [t3.id])).rows[0]?.deleted_at,
      '软删 = 写 deleted_at');
    await assertMacroError('not_found', () => getTemplate(pool, { templateId: t3.id }));
    assert.equal((await getTemplate(pool, { templateId: t3.id, includeDeleted: true })).id, t3.id,
      'includeDeleted 才看得见（审计/面板要能回看）');
    assert.equal((await listTemplates(pool, {})).some((t) => t.id === t3.id), false, '列表默认排除软删');
    const r3b = await deleteTemplate(pool, { templateId: t3.id });
    assert.equal(r3b.mode, 'soft');
    assert.equal(r3b.alreadyDeleted, true, '重复删除幂等：不许把软删翻成物理删');
    await assertMacroError('not_found', () => updateTemplate(pool, { templateId: t3.id, patch: { name: '复活' } }),
    );

    // ── 分支三的另一半：`notifications` **W3 才建** ⇒ 「表存在则检查、不存在则跳过」
    const t4 = await createTemplate(pool, { kind: 'run-notify', name: '此刻无通知表', scope: 'user' });
    await assignTemplate(pool, { templateId: t4.id, userId });
    assert.equal((await deleteTemplate(pool, { templateId: t4.id })).mode, 'deleted_with_assignments',
      'notifications 表不存在 ⇒ 这一支跳过（只有订阅 ⇒ 物理删 + 级联）');

    const t5 = await createTemplate(pool, { kind: 'run-notify', name: '有通知', scope: 'user' });
    await assignTemplate(pool, { templateId: t5.id, userId });
    // 现场建一张 W3 形状的表：验的是「探测 + 计数」这条通路真的接得上（列名用探测列表里的第一个）。
    await pool.query('CREATE TABLE notifications (id serial PRIMARY KEY, macro_template_id uuid, body text)');
    await pool.query('INSERT INTO notifications (macro_template_id, body) VALUES ($1, $2)', [t5.id, '已发出的通知']);
    const r5 = await deleteTemplate(pool, { templateId: t5.id });
    assert.equal(r5.mode, 'soft', 'notifications 里有引用 ⇒ 只能软删（表存在就必须被算进来）');
    assert.equal(r5.notifications, 1);
    assert.ok((await pool.query('SELECT deleted_at FROM macro_templates WHERE id = $1', [t5.id])).rows[0].deleted_at);
    // 表在但没有任何引用列 ⇒ 数不到 ⇒ 物理删（此时通知根本记不了模板，物理删是安全的）。
    await pool.query('DROP TABLE notifications');
    await pool.query('CREATE TABLE notifications (id serial PRIMARY KEY, body text)');
    const t6 = await createTemplate(pool, { kind: 'run-notify', name: '无引用列', scope: 'user' });
    assert.equal((await deleteTemplate(pool, { templateId: t6.id })).mode, 'deleted');
    await pool.query('DROP TABLE notifications');
  });
});

test('#524 until 到期 ⇒ enabled=false（红线③的 DB 那一半；到期订阅没有认领资格）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a3');
    const sessionTpl = await createTemplate(pool, { kind: 'run-notify', name: '临时开一小时', scope: 'session' });
    const userTpl = await createTemplate(pool, { kind: 'scheduled-task', name: '临时开一小时（全局）', scope: 'user' });

    const live = await assignTemplate(pool, {
      templateId: sessionTpl.id, userId, sessionId, until: new Date(Date.now() + 3600_000),
    });
    assert.equal(live.enabled, true);
    assert.equal(live.effective_enabled, true);

    const past = new Date(Date.now() - 1000);
    const a2 = await assignTemplate(pool, { templateId: userTpl.id, userId, cwd: '/srv/x', until: past });
    assert.equal(a2.enabled, true, '插入那一刻 DB 行是 true：到期不是「写进去的 false」而是评估出来的');
    assert.equal(a2.expired, true);
    assert.equal(a2.effective_enabled, false, '写侧也必须把过期算进返回值，不能只给 DB 那一列');
    const [rowA2] = (await pool.query('SELECT enabled FROM macro_assignments WHERE id = $1', [a2.id])).rows;
    assert.equal(rowA2.enabled, false, 'DB 里必须真的落成 false（不是只在返回值里演一下）');
    assert.deepEqual((await applyExpiredAssignments(pool, { now: new Date() })).disabledIds, [],
      '收敛幂等：已经关掉的不会再被算成「刚关掉」');
    assert.equal((await listAssignments(pool, { userId, includeDisabled: true })).find((a) => a.id === live.id).enabled,
      true, '未到期的那条不许被顺手关掉');

    // 已经存过期的行也要被收敛（绕过 assignTemplate 直接写库的情形）——读侧顺手收敛。
    const a3 = await assignTemplate(pool, { templateId: userTpl.id, userId, cwd: '/srv/y' });
    await pool.query('UPDATE macro_assignments SET until = $2 WHERE id = $1', [a3.id, new Date(Date.now() - 5000)]);
    const listed = await listAssignments(pool, { userId });
    assert.equal(listed.find((a) => a.id === a3.id).enabled, false,
      'listAssignments 读侧也收敛：读出来的 enabled 必须等于「真的还能跑」');
    assert.equal(listed.find((a) => a.id === a3.id).expired, true);
    assert.equal(await claimMacroRun(pool, { assignmentId: a3.id, anchor: 'run-e', bucket: 'b0' }), null,
      '到期的订阅没有认领资格：与「抢不到」同一个 null，调用方处置动作一致');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_runs WHERE assignment_id = $1',
      [a3.id])).rows[0].n, 0, '没资格就不该留下账');
    // 未到期那条照样能认领
    assert.ok((await claimMacroRun(pool, { assignmentId: live.id, anchor: 'run-ok', bucket: 'b0' }))?.id);
  });
});

test('#524 枚举 CHECK 拒绝非法值：kind / state / skipped_reason / verdict（DB 是最后一道闸）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a4');
    const tpl = await createTemplate(pool, { kind: 'run-review', name: '闸', scope: 'session' });
    const asg = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });
    const bad = [
      ['kind', `INSERT INTO macro_templates (kind, name, scope) VALUES ('run-partyy', 'x', 'user')`, []],
      ['state', `INSERT INTO macro_runs (assignment_id, anchor, state, bucket) VALUES ($1, 'z', 'half-done', 'b0')`, [asg.id]],
      ['skipped_reason', `INSERT INTO macro_runs (assignment_id, anchor, state, bucket, skipped_reason)
                           VALUES ($1, 'z', 'skipped', 'b0', 'i_was_sleeping')`, [asg.id]],
      ['verdict', `INSERT INTO macro_runs (assignment_id, anchor, state, bucket, verdict)
                    VALUES ($1, 'z', 'done', 'b0', 'green')`, [asg.id]],
    ];
    for (const [column, sql, params] of bad) {
      await assert.rejects(
        () => pool.query(sql, params),
        (e) => {
          assert.equal(e.code, CHECK_VIOLATION, `${column} 非法值必须撞 CHECK（23514），实际 ${e.code}`);
          return true;
        },
        `${column} 的 CHECK 没拦住非法值`,
      );
    }
    // 合法值必须能进（否则上面的红是假红：CHECK 写死成一个也不许）。
    await pool.query(`INSERT INTO macro_runs (assignment_id, anchor, state, bucket, skipped_reason, verdict)
                      VALUES ($1, 'z', 'superseded', 'b9', 'cancelled_by_user', 'unclassified')`, [asg.id]);
    // 同一份枚举在 JS 侧也拦得住（两道闸都在，W2 才不会看到裸 pg 码）。
    await assertMacroError('validation_failed', () => finishMacroRun(pool, { macroRunId: randomUUID(), state: 'half-done' }));
    await assertMacroError('validation_failed', () => createTemplate(pool, { kind: 'nope', name: 'x', scope: 'user' }));
    const onlyRunId = (await listMacroRuns(pool, { assignmentId: asg.id })).runs[0].id;
    await assertMacroError('validation_failed', () => finishMacroRun(pool, {
      macroRunId: onlyRunId, state: 'skipped',
    }), 'skipped 必带 skipped_reason');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_runs WHERE anchor = $1', ['z'])).rows[0].n, 1,
      '被拒的三条非法行一条也没漏进去');
  });
});

test('#524 订阅形状：NULLS NOT DISTINCT 挡重复订阅 / scope 决定 session_id / admin 受众 / 取消订阅两分支', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a5');
    const userScope = await createTemplate(pool, { kind: 'scheduled-task', name: '每天早上', scope: 'user' });
    const first = await assignTemplate(pool, { templateId: userScope.id, userId });
    const again = await assignTemplate(pool, { templateId: userScope.id, userId });
    assert.equal(again.id, first.id,
      'scope=user 时 session_id/cwd 都是 NULL：默认 UNIQUE 语义下 NULL 互不相等 ⇒ 会订出第二行，靠 NULLS NOT DISTINCT 挡');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_assignments WHERE template_id = $1',
      [userScope.id])).rows[0].n, 1, '重复点订阅不许产生第二条');
    const other = await assignTemplate(pool, { templateId: userScope.id, userId, cwd: '/srv/z' });
    assert.notEqual(other.id, first.id, '换了 cwd 是**另一个**订阅');

    // 绕过 JS 直接撞 DB 的订阅键也必须被挡：证明那条 UNIQUE 真在库上（而不是靠应用层自觉）。
    await assert.rejects(() => pool.query(
      `INSERT INTO macro_assignments (template_id, user_id) VALUES ($1, $2)`, [userScope.id, userId],
    ), (e) => e.code === '23505');

    // scope 决定 session_id 的形状（迁移里没有跨表 CHECK，正确性就在 assignTemplate）
    const sessionScope = await createTemplate(pool, { kind: 'run-notify', name: '这个会话跑完', scope: 'session' });
    await assertMacroError('validation_failed', () => assignTemplate(pool, { templateId: sessionScope.id, userId }));
    await assertMacroError('validation_failed',
      () => assignTemplate(pool, { templateId: userScope.id, userId, sessionId, cwd: '/q' }));
    const sAsg = await assignTemplate(pool, { templateId: sessionScope.id, userId, sessionId });
    assert.equal(sAsg.session_id, sessionId);

    // audience=admin：非管理员看不见、也订不上
    const adminOnly = await createTemplate(pool, { kind: 'run-review', name: '管理员专用', scope: 'user', audience: 'admin' });
    assert.equal((await listTemplates(pool, {})).some((t) => t.id === adminOnly.id), false);
    assert.equal((await listTemplates(pool, { isAdmin: true })).some((t) => t.id === adminOnly.id), true);
    assert.equal((await listTemplates(pool, { kinds: ['run-review'], isAdmin: true })).some((t) => t.id === adminOnly.id), true);
    await assertMacroError('forbidden', () => assignTemplate(pool, { templateId: adminOnly.id, userId }));
    assert.ok((await assignTemplate(pool, { templateId: adminOnly.id, userId, isAdmin: true })).id);

    // 取消订阅两分支：无账物理删 / 有账只停用（= 迁移里 `macro_runs.assignment_id` 不带 ON DELETE 的后果）
    const clean = await assignTemplate(pool, { templateId: userScope.id, userId, cwd: '/clean' });
    assert.equal((await unassignTemplate(pool, { assignmentId: clean.id })).mode, 'deleted');
    assert.equal((await pool.query('SELECT 1 FROM macro_assignments WHERE id = $1', [clean.id])).rowCount, 0);
    assert.ok(await claimMacroRun(pool, { assignmentId: sAsg.id, anchor: 'run-c', bucket: 'b0' }));
    const off = await unassignTemplate(pool, { assignmentId: sAsg.id });
    assert.equal(off.mode, 'disabled', '有执行账的订阅只能停用');
    assert.equal(off.macroRuns, 1);
    assert.equal((await pool.query('SELECT enabled FROM macro_assignments WHERE id = $1', [sAsg.id])).rows[0].enabled, false);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_runs WHERE assignment_id = $1',
      [sAsg.id])).rows[0].n, 1, '取消订阅不许抹掉执行账');
    await assertMacroError('not_found', () => unassignTemplate(pool, { assignmentId: clean.id }));
    await assertMacroError('not_found', () => unassignTemplate(pool, { assignmentId: sAsg.id, userId: randomUUID() }),
      '别人的订阅不能取消（越权当作不存在，不泄露存在性）');

    // 改模板：能改的改、漂了的红、改完不许再被订阅
    const upd = await updateTemplate(pool, { templateId: userScope.id, patch: { name: '每天早上改三点', enabled: false } });
    assert.equal(upd.name, '每天早上改三点');
    assert.equal(upd.enabled, false);
    await assertMacroError('validation_failed', () => updateTemplate(pool, { templateId: userScope.id, patch: { scope: 'dept' } }));
    await assertMacroError('validation_failed', () => updateTemplate(pool, { templateId: userScope.id, patch: {} }));
    await assertMacroError('validation_failed',
      () => createTemplate(pool, { kind: 'run-notify', name: '  ', scope: 'user' }), 'name 不许空白');
    await assertMacroError('conflict', () => assignTemplate(pool, { templateId: userScope.id, userId, cwd: '/after-off' }));
    assert.equal((await getTemplate(pool, { templateId: userScope.id })).enabled, false);
  });
});
