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
//   外加五条枚举 CHECK（`kind` / `status` / `criterion` / `skipped_reason` / `verdict`）。
//
// `state` 拆成两义的坑（设计变更）：`status` = 生命周期（会推进），`criterion` = 哪条判据叫起来的
// （写完不变，是幂等键的一部分）。本文件专门有一条**状态迁移后仍 claim 不到**的用例——
// 幂等键里一旦混进 `status`，一条账 pending→running→done 之后键位空出来，同一个触发会被再 claim。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import {
  MACRO_KINDS, MACRO_AUDIENCES, MACRO_SCOPES, MACRO_RUN_STATUSES, MACRO_RUN_TERMINAL_STATUSES,
  MACRO_RUN_CRITERIA,
  MACRO_SKIPPED_REASONS, MACRO_VERDICTS,
  MacroError, validateMacroEnum, validateMacroKind, validateMacroRunStatus, validateMacroCriterion,
  isAssignmentExpired, toInstant, toAssignmentSnapshot,
  encodeMacroRunCursor, decodeMacroRunCursor,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  listAssignments, assignTemplate, unassignTemplate, applyExpiredAssignments,
  claimMacroRun, finishMacroRun, listMacroRuns,
  // #625：默认值/必填闸的两面——服务端补齐（`validateKindParams`）与契约真源（`KIND_SCHEMA`）。
  validateKindParams, KIND_SCHEMA,
} from '../src/macros.js';
import { createNotification } from '../src/notifications.js'; // #526：软删判定接真表后，本文件要能写通知行

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_0035 = path.join(HERE, '../../deploy/migrations/0035-macro-platform.sql');
// #676：`review_unavailable` 不在 0035 里，而在拓宽 CHECK 的 0044——同源闸要读两支的并集。
const MIGRATION_0044 = path.join(HERE, '../../deploy/migrations/0044-macro-skipped-reason-review-unavailable.sql');

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w524' }) : null;

/** 夹具包一层：用例体只拿 pool（`withFreshDatabase` 跑完整链：baseline → bootstrap → 全部增量含 0035）。 */
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

/**
 * #625：`scheduled-task` 的必填参数（契约 §1：`at`/`cwd`/`task` 都是 `required: true`）。
 * 以前 `validateKindParams` 对缺字段 `continue` ⇒ 夹具给 `params: {}` 也建得成；
 * 现在缺任一个就 400 ⇒ 所有 `scheduled-task` 夹具必须带齐（可缺的 `maxRounds`/`jitter`
 * 故意不带，用来验「服务端会补契约默认值」）。
 */
const SCHEDULED_PARAMS = Object.freeze({ at: '09:00', cwd: '/p', task: 't' });

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

test('#524 JS 枚举与迁移 0035 的 CHECK 同源（八种 skipped_reason / 六种 status / 五种 criterion / 四种 kind 一个都不能少）', () => {
  const sql = fs.readFileSync(MIGRATION_0035, 'utf8') + '\n' + fs.readFileSync(MIGRATION_0044, 'utf8');
  for (const values of [MACRO_KINDS, MACRO_AUDIENCES, MACRO_SCOPES, MACRO_RUN_STATUSES,
    MACRO_RUN_CRITERIA, MACRO_SKIPPED_REASONS, MACRO_VERDICTS]) {
    for (const v of values) {
      assert.ok(sql.includes(`'${v}'`), `迁移 CHECK 里缺 '${v}'：JS 与 SQL 两份枚举漂了`);
    }
  }
  // 数量本身也是契约（09 篇 §7 要「为什么没跑」可分组 ⇒ 穷举，不许退化成自由文本）。
  // #676 加了第九种 `review_unavailable`（M9 facts-only，见迁移 0044）⇒ 8 → 9。
  assert.equal(MACRO_SKIPPED_REASONS.length, 9);
  assert.equal(MACRO_RUN_STATUSES.length, 6);
  assert.deepEqual(MACRO_RUN_CRITERIA, ['terminal', 'silent', 'tick', 'mechanical', 'semantic']);
  assert.equal(MACRO_KINDS.length, 4);
  assert.deepEqual(MACRO_RUN_TERMINAL_STATUSES, ['done', 'skipped', 'failed', 'superseded']);
  // 终态必须是 status 的子集（`finishMacroRun` 补 finished_at 的判据靠这个包含关系）。
  for (const s of MACRO_RUN_TERMINAL_STATUSES) assert.ok(MACRO_RUN_STATUSES.includes(s));
  // 两个轴必须是**两列**：迁移里 status 与 criterion 各有独立 CHECK，幂等键里不许有 status。
  assert.ok(sql.includes('CHECK (status IN'), '生命周期列必须是 status + 独立 CHECK');
  assert.ok(sql.includes('CHECK (criterion IN'), '判据列必须是 criterion + 独立 CHECK');
  assert.ok(!/UNIQUE \(assignment_id, anchor, state/.test(sql), '幂等键不许回到含 state 的旧形状');
  assert.ok(!/^\s+state\s+text/m.test(sql), '库里不许再留名为 state 的列（一列两义的回归）');
});

test('#524 枚举校验：非法 kind / status / criterion 当场 validation_failed（不是写进 DB 才发现）', () => {
  assert.equal(validateMacroKind('run-review'), 'run-review');
  assert.equal(validateMacroRunStatus('superseded'), 'superseded');
  assert.equal(validateMacroCriterion('mechanical'), 'mechanical');
  assert.throws(() => validateMacroKind('run-partyy'), (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.throws(() => validateMacroEnum('status', 'zombie', MACRO_RUN_STATUSES),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
  // 判据里混进生命周期值（`done`）必须是非法的——这正是「两列不许合回去」的形状。
  assert.throws(() => validateMacroCriterion('done'),
    (e) => e instanceof MacroError && e.code === 'validation_failed');
  assert.throws(() => validateMacroRunStatus('terminal'),
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

test('#524 幂等键 (assignment, anchor, criterion, bucket)：二次 claim 返回 null，且状态迁移不改这个结论（红线①）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a1');
    const tpl = await createTemplate(pool, {
      kind: 'run-notify', name: '跑完告诉我', scope: 'session',
      params: { states: ['completed'], channel: 'site' }, createdBy: userId,
    });
    assert.deepEqual((await getTemplate(pool, { templateId: tpl.id })).params,
      { states: ['completed'], channel: 'site' },
      'params 是 jsonb：进得去也原样出得来');
    const asg = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });

    // 显式给 startedAt：翻页断言要的是确定序，不能靠「三条语句恰好落在不同微秒」。
    const base = Date.parse('2026-03-01T00:00:00Z');
    const key = (over = {}) => ({ assignmentId: asg.id, anchor: 'run-1', criterion: 'terminal', bucket: 'b0', ...over });
    const c1 = await claimMacroRun(pool, key({ startedAt: base + 1 }));
    assert.ok(c1?.id, '第一次必须拿到 id');
    assert.equal(c1.criterion, 'terminal');
    assert.equal(c1.status, 'pending', '认领写下的生命周期默认 pending');
    const c2 = await claimMacroRun(pool, key({ startedAt: base + 2 }));
    assert.equal(c2, null, '同 (assignment, anchor, criterion, bucket) 第二次必须是 null（幂等命中）');

    // ★★ 本单最容易写错的一处：**状态迁移不许影响幂等**。
    // 把第一条从 pending 推到 done 之后再拿同一个键 claim —— 必须**仍然是 null**。
    // 幂等键里若混进 `status`（旧形状 (assignment, anchor, state, bucket)），done 之后键位就
    // 空出来了，这里会拿到一个**新 id** ⇒ 同一个触发被跑第二遍，幂等失效。
    const FINISH_SQL = 'UPDATE macro_runs SET status = $2, finished_at = now() WHERE id = $1';
    // 真库前置证据：用**裸 SQL** 把 status 从 pending 推到 done —— 若幂等键含 status，这一步
    // 就会被唯一键拦住（23505）。能改成功本身就说明「生命周期不在键里」。
    await finishMacroRun(pool, { macroRunId: c1.id, status: 'done', verdict: 'pass', verdictRaw: 'LGTM' });
    const doneRow = (await pool.query('SELECT status, finished_at, verdict, verdict_raw FROM macro_runs WHERE id = $1',
      [c1.id])).rows[0];
    assert.equal(doneRow.status, 'done');
    assert.equal(doneRow.verdict, 'pass');
    await pool.query(FINISH_SQL, [c1.id, 'running']);
    assert.equal((await pool.query('SELECT status FROM macro_runs WHERE id = $1', [c1.id])).rows[0].status,
      'running', '状态可以随意推进而不动唯一键（这一步 23505 就是键里混进了 status）');
    assert.ok(doneRow.finished_at, '进终态必须补 finished_at');
    assert.equal(doneRow.verdict_raw, 'LGTM', '原话留在 verdict_raw（口径改了能回溯重算）');
    assert.equal(await claimMacroRun(pool, key({ startedAt: base + 9 })), null,
      '状态已 pending → done，同一个 (assignment, anchor, criterion, bucket) 再 claim 仍必须 null');
    // 连推两级再试一次（running → done 的中途也一样不许漏）：直接写库造 running，再 claim。
    await pool.query("UPDATE macro_runs SET status = 'running' WHERE id = $1", [c1.id]);
    assert.equal(await claimMacroRun(pool, key({ startedAt: base + 10 })), null, 'running 中途同样幂等');
    await pool.query("UPDATE macro_runs SET status = 'skipped', skipped_reason = 'quiet_hours' WHERE id = $1", [c1.id]);
    assert.equal(await claimMacroRun(pool, key({ startedAt: base + 11 })), null, 'skipped 之后同样幂等');

    // 同一 anchor 在**另一条判据**下是另一次触发 ⇒ 能认领（判据是键的一部分，status 不是）。
    const c5 = await claimMacroRun(pool, key({ criterion: 'silent', startedAt: base + 3 }));
    assert.ok(c5?.id, 'terminal 与 silent 是两条判据 ⇒ 两次不同的触发，不该互相挡');
    const c3 = await claimMacroRun(pool, key({ bucket: 'b1', startedAt: base + 4 }));
    assert.ok(c3?.id, '换 bucket 不是同一次事件 ⇒ 应当能认领');
    const c4 = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run-2', criterion: 'terminal', bucket: 'b0', startedAt: base + 5 });
    assert.ok(c4?.id);
    assert.equal(await claimMacroRun(pool, { assignmentId: '00000000-0000-4000-8000-000000000000', anchor: 'x', criterion: 'tick', bucket: 'b' }),
      null, '订阅不存在也是 null（不拿认领当存在性探针）');
    await pool.query("UPDATE macro_runs SET status = 'done' WHERE id = $1", [c1.id]);

    // 认领顺手写了 last_evaluated_at（W2 的「这条订阅多久没被看过」判据）。
    const [rowAsg] = (await pool.query('SELECT last_evaluated_at FROM macro_assignments WHERE id = $1', [asg.id])).rows;
    assert.ok(rowAsg.last_evaluated_at, '认领必须留下评估时刻');

    // keyset 翻页：limit=1 逐页走，不重不漏（账表只追加，OFFSET 在并发插入下会重/漏）。
    const p1 = await listMacroRuns(pool, { assignmentId: asg.id, limit: 1 });
    assert.equal(p1.runs.length, 1);
    assert.equal(p1.runs[0].id, c4.id, '倒序：startedAt 最新的那条在最前');
    assert.ok(p1.nextCursor);
    const seen = [...p1.runs];
    let cur = p1.nextCursor;
    while (cur) {
      const next = await listMacroRuns(pool, { assignmentId: asg.id, limit: 1, cursor: cur });
      seen.push(...next.runs);
      cur = next.nextCursor;
    }
    assert.deepEqual(seen.map((r) => r.id), [c4.id, c3.id, c5.id, c1.id],
      '四条账一条不多一条不少、按 startedAt 倒序（keyset 不重不漏）');
    assert.equal(seen.find((r) => r.id === c1.id).verdict, 'pass');
    assert.equal(seen.find((r) => r.id === c1.id).status, 'done', '快照里 status 与 criterion 是两个字段');
    assert.equal(seen.find((r) => r.id === c5.id).criterion, 'silent');
    // 筛选：判据 / 生命周期各自能筛；按模板筛走 JOIN macro_assignments（索引选型那一支）。
    const byTpl = await listMacroRuns(pool, { templateId: tpl.id, status: 'pending' });
    assert.deepEqual(byTpl.runs.map((r) => r.id).sort(), [c3.id, c4.id, c5.id].sort());
    assert.equal(byTpl.nextCursor, null);
    const byCriterion = await listMacroRuns(pool, { assignmentId: asg.id, criterion: 'silent' });
    assert.deepEqual(byCriterion.runs.map((r) => r.id), [c5.id], 'criterion 能单独筛（W2 每 tick 要问「这条判据跑过没有」）');
    assert.deepEqual((await listMacroRuns(pool, { assignmentId: asg.id, status: 'done' })).runs.map((r) => r.id),
      [c1.id], 'status 能单独筛（面板默认视图的筛法）');
  });
});

test('#524 软删三分支（07 §2.3）：零引用物理删 / 只有订阅级联删 / 有账或有通知只能软删', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a2');

    // ── 分支一：零引用 ⇒ 物理删（行真的没了）
    const t1 = await createTemplate(pool, { kind: 'run-review', name: '零引用', scope: 'session' });
    assert.equal((await deleteTemplate(pool, { templateId: t1.id })).mode, 'deleted');
    assert.equal((await pool.query('SELECT 1 FROM macro_templates WHERE id = $1', [t1.id])).rowCount, 0,
      '零引用必须物理删，不留 deleted_at 的僵尸行');

    // ── 分支二：只有订阅、无执行记录 ⇒ 物理删 + 级联删订阅
    const t2 = await createTemplate(pool, {
      kind: 'scheduled-task', name: '只有订阅', scope: 'user', params: SCHEDULED_PARAMS,
    });
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
    assert.ok((await claimMacroRun(pool, { assignmentId: a3.id, anchor: 'run-x', criterion: 'terminal', bucket: 'b0' }))?.id);
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

    // ── 分支三的另一半：`notifications` 已由 W3（0036）建成真表 ⇒ 判定必须经真表数
    //（issue #526，10 篇 §4 第 1 条：W1 留的「表不存在则跳过」时代结束）。
    const t4 = await createTemplate(pool, { kind: 'run-notify', name: '表在但无引用', scope: 'session' });
    await assignTemplate(pool, { templateId: t4.id, userId, sessionId });
    assert.equal((await deleteTemplate(pool, { templateId: t4.id })).mode, 'deleted_with_assignments',
      '真表存在但一行都没指向本模板 ⇒ 数不到 ⇒ 物理删 + 级联（空表不许误伤成软删）');

    const t5 = await createTemplate(pool, { kind: 'run-notify', name: '有通知', scope: 'session' });
    const a5 = await assignTemplate(pool, { templateId: t5.id, userId, sessionId });
    // 真表口径：引用经执行账间接成立（notifications.macro_run_id → assignments.template_id）。
    const r5run = await claimMacroRun(pool, { assignmentId: a5.id, anchor: 'run-n', criterion: 'terminal', bucket: 'b0' });
    await createNotification(pool, { userId, macroRunId: r5run.id, title: '已发出的通知' });
    const r5 = await deleteTemplate(pool, { templateId: t5.id });
    assert.equal(r5.mode, 'soft', 'notifications 里有引用（间接） ⇒ 只能软删（表存在就必须被算进来）');
    assert.equal(r5.notifications, 1);
    assert.ok((await pool.query('SELECT deleted_at FROM macro_templates WHERE id = $1', [t5.id])).rows[0].deleted_at);
    // 表在但既无直连列也无 `macro_run_id` ⇒ 数不到 ⇒ 物理删（此时通知根本记不了模板，删是安全的）。
    await pool.query('DROP TABLE notifications');
    await pool.query('CREATE TABLE notifications (id serial PRIMARY KEY, body text)');
    const t6 = await createTemplate(pool, { kind: 'run-notify', name: '无引用列', scope: 'session' });
    assert.equal((await deleteTemplate(pool, { templateId: t6.id })).mode, 'deleted');
    await pool.query('DROP TABLE notifications');
  });
});

test('#524 until 到期 ⇒ enabled=false（红线③的 DB 那一半；到期订阅没有认领资格）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a3');
    const sessionTpl = await createTemplate(pool, { kind: 'run-notify', name: '临时开一小时', scope: 'session' });
    const userTpl = await createTemplate(pool, {
      kind: 'scheduled-task', name: '临时开一小时（全局）', scope: 'user', params: SCHEDULED_PARAMS,
    });

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
    assert.equal(await claimMacroRun(pool, { assignmentId: a3.id, anchor: 'run-e', criterion: 'tick', bucket: 'b0' }), null,
      '到期的订阅没有认领资格：与「抢不到」同一个 null，调用方处置动作一致');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_runs WHERE assignment_id = $1',
      [a3.id])).rows[0].n, 0, '没资格就不该留下账');
    // 未到期那条照样能认领
    assert.ok((await claimMacroRun(pool, { assignmentId: live.id, anchor: 'run-ok', criterion: 'terminal', bucket: 'b0' }))?.id);
  });
});

test('#524 枚举 CHECK 拒绝非法值：kind / status / criterion / skipped_reason / verdict（DB 是最后一道闸）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a4');
    const tpl = await createTemplate(pool, { kind: 'run-review', name: '闸', scope: 'session' });
    const asg = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });
    const bad = [
      ['kind', `INSERT INTO macro_templates (kind, name, scope) VALUES ('run-partyy', 'x', 'user')`, []],
      ['status', `INSERT INTO macro_runs (assignment_id, anchor, criterion, bucket, status)
                   VALUES ($1, 'z', 'terminal', 'b0', 'half-done')`, [asg.id]],
      // 判据里塞生命周期的值（`pending`）必须被拒：这条拒的就是「两列合回去」的写法。
      ['criterion', `INSERT INTO macro_runs (assignment_id, anchor, criterion, bucket)
                      VALUES ($1, 'z', 'pending', 'b0')`, [asg.id]],
      ['skipped_reason', `INSERT INTO macro_runs (assignment_id, anchor, criterion, bucket, status, skipped_reason)
                           VALUES ($1, 'z', 'terminal', 'b0', 'skipped', 'i_was_sleeping')`, [asg.id]],
      ['verdict', `INSERT INTO macro_runs (assignment_id, anchor, criterion, bucket, status, verdict)
                    VALUES ($1, 'z', 'terminal', 'b0', 'done', 'green')`, [asg.id]],
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
    await pool.query(`INSERT INTO macro_runs (assignment_id, anchor, criterion, bucket, status, skipped_reason, verdict)
                      VALUES ($1, 'z', 'mechanical', 'b9', 'superseded', 'cancelled_by_user', 'unclassified')`, [asg.id]);
    // 同一份枚举在 JS 侧也拦得住（两道闸都在，W2 才不会看到裸 pg 码）。
    await assertMacroError('validation_failed', () => finishMacroRun(pool, { macroRunId: randomUUID(), status: 'half-done' }));
    await assertMacroError('validation_failed', () => createTemplate(pool, { kind: 'nope', name: 'x', scope: 'user' }));
    const onlyRunId = (await listMacroRuns(pool, { assignmentId: asg.id })).runs[0].id;
    await assertMacroError('validation_failed', () => finishMacroRun(pool, {
      macroRunId: onlyRunId, status: 'skipped',
    }), 'skipped 必带 skipped_reason');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_runs WHERE anchor = $1', ['z'])).rows[0].n, 1,
      '被拒的三条非法行一条也没漏进去');
  });
});

test('#524 订阅形状：NULLS NOT DISTINCT 挡重复订阅 / scope 决定 session_id / admin 受众 / 取消订阅两分支', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'a5');
    const userScope = await createTemplate(pool, {
      kind: 'scheduled-task', name: '每天早上', scope: 'user', params: SCHEDULED_PARAMS,
    });
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
    const adminOnly = await createTemplate(pool, { kind: 'run-review', name: '管理员专用', scope: 'session', audience: 'admin' });
    assert.equal((await listTemplates(pool, {})).some((t) => t.id === adminOnly.id), false);
    assert.equal((await listTemplates(pool, { isAdmin: true })).some((t) => t.id === adminOnly.id), true);
    assert.equal((await listTemplates(pool, { kinds: ['run-review'], isAdmin: true })).some((t) => t.id === adminOnly.id), true);
    await assertMacroError('forbidden', () => assignTemplate(pool, { templateId: adminOnly.id, userId, sessionId }));
    assert.ok((await assignTemplate(pool, { templateId: adminOnly.id, userId, sessionId, isAdmin: true })).id);

    // 取消订阅两分支：无账物理删 / 有账只停用（= 迁移里 `macro_runs.assignment_id` 不带 ON DELETE 的后果）
    const clean = await assignTemplate(pool, { templateId: userScope.id, userId, cwd: '/clean' });
    assert.equal((await unassignTemplate(pool, { assignmentId: clean.id })).mode, 'deleted');
    assert.equal((await pool.query('SELECT 1 FROM macro_assignments WHERE id = $1', [clean.id])).rowCount, 0);
    assert.ok(await claimMacroRun(pool, { assignmentId: sAsg.id, anchor: 'run-c', criterion: 'terminal', bucket: 'b0' }));
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
      () => createTemplate(pool, { kind: 'run-notify', name: '  ', scope: 'session' }), 'name 不许空白');
    await assertMacroError('conflict', () => assignTemplate(pool, { templateId: userScope.id, userId, cwd: '/after-off' }));
    assert.equal((await getTemplate(pool, { templateId: userScope.id })).enabled, false);
  });
});

  // ── 审计回修（fix-261116-05）新增的四道闸 ────────────────────────────────
  // 每条都**先造出旧行为能通过的状态**，再断言新闸拦住——不做「恒真」自证。

  test('#524 模板停用/软删 ⇒ 既有订阅也 claim 不到（模板总开关是真门禁）', { skip: SKIP }, async () => {
    await withFreshDb(async (pool) => {
      const { userId } = await seedScene(pool, 'n1');
      const t = await createTemplate(pool, {
        kind: 'scheduled-task', name: '每天跑一次',
        params: { at: '09:00', cwd: '/p', task: 't', maxRounds: 4 }, scope: 'user',
      });
      const asg = await assignTemplate(pool, { templateId: t.id, userId });
      // 基线：模板启用时能认领
      assert.ok(await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'clock:2026-11-16',
        criterion: 'tick', bucket: '2026-11-16' }), '基线：模板启用时应能认领');

      // ① 停用模板 ⇒ 订阅本身 enabled=true，但 claim 必须拿不到
      await updateTemplate(pool, { templateId: t.id, patch: { enabled: false } });
      assert.equal((await pool.query('SELECT enabled FROM macro_assignments WHERE id = $1',
        [asg.id])).rows[0].enabled, true, '前置：订阅行自己仍是启用的（不是被顺手关掉才通过的）');
      assert.equal(await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'clock:2026-11-17',
        criterion: 'tick', bucket: '2026-11-17' }), null, '模板停用后不许再认领');

      // ② 软删模板 ⇒ 同样不许认领
      await updateTemplate(pool, { templateId: t.id, patch: { enabled: true } });
      await deleteTemplate(pool, { templateId: t.id });
      assert.equal(await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'clock:2026-11-18',
        criterion: 'tick', bucket: '2026-11-18' }), null, '模板软删后不许再认领');
    });
  });

  test('#524 until 到期在 claim 自己的资格子句里被拦（不靠上一次 listAssignments 顺手收敛）',
    { skip: SKIP }, async () => {
    await withFreshDb(async (pool) => {
      const { userId } = await seedScene(pool, 'n2');
      const t = await createTemplate(pool, {
        kind: 'scheduled-task', name: '到期测试',
        params: { at: '09:00', cwd: '/p', task: 't', maxRounds: 4 }, scope: 'user',
      });
      const asg = await assignTemplate(pool, { templateId: t.id, userId });
      // ⚠ 这里**故意不调 listAssignments**（它内部会 applyExpiredAssignments）。
      // 只把 until 用裸 SQL 推到过去 ⇒ 只有 claim 自己的 `until > $now` 能拦住。
      await pool.query('UPDATE macro_assignments SET until = now() - interval \'1 hour\' WHERE id = $1',
        [asg.id]);
      assert.equal(await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'clock:2026-11-16',
        criterion: 'tick', bucket: '2026-11-16' }), null, '过期订阅不许认领（claim 自己判，不靠旁路）');
    });
  });

  test('#524 kind/scope 配对固定、params 按 kind schema 校验、name ≤ 40', { skip: SKIP }, async () => {
    await withFreshDb(async (pool) => {
      // kind 与 scope 不许自由组合
      await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'run-notify', name: 'x', scope: 'user', params: { states: ['completed'], channel: 'site' },
      }), 'run-notify 只能 scope=session');
      await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'scheduled-task', name: 'x', scope: 'session',
        params: { at: '09:00', cwd: '/p', task: 't', maxRounds: 4 },
      }), 'scheduled-task 只能 scope=user');
      // params 按 kind schema：**缺必填**（#625，如 `scheduled-task` 缺 `at`）、
      // **多字段/错值**都要拦；可缺字段缺了 ⇒ 服务端补契约默认值（不报错，见 #625 那组用例）。
      await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'run-notify', name: 'x', scope: 'session', params: { tone: 'brief' },
      }), 'run-notify 不认识 tone');
      await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'scheduled-task', name: 'x', scope: 'user',
        params: { at: '25:00', cwd: '/p', task: 't', maxRounds: 4 },
      }), 'at 必须是 HH:MM');
      // name ≤ 40（设计 07 §1.3；旧实现放到 200）
      await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'run-notify', name: 'a'.repeat(41), scope: 'session',
        params: { states: ['completed'], channel: 'site' },
      }), 'name 超过 40 字要拦');
      // 改模板：kind / scope 不在白名单
      const t = await createTemplate(pool, {
        kind: 'run-notify', name: 'ok', scope: 'session', params: { states: ['completed'], channel: 'site' },
      });
      await assertMacroError('validation_failed',
        () => updateTemplate(pool, { templateId: t.id, patch: { kind: 'run-review' } }), 'kind 不许改');
      await assertMacroError('validation_failed',
        () => updateTemplate(pool, { templateId: t.id, patch: { scope: 'user' } }), 'scope 不许改');
    });
  });

  test('#524 finish 的两道闸：skipped 显式 null 也拦；终态不许回退', { skip: SKIP }, async () => {
    await withFreshDb(async (pool) => {
      const { userId, sessionId } = await seedScene(pool, 'n3');
      const t = await createTemplate(pool, {
        kind: 'run-notify', name: '终态闸', scope: 'session', params: { states: ['completed'], channel: 'site' },
      });
      const asg = await assignTemplate(pool, { templateId: t.id, userId, sessionId });
      const run = await claimMacroRun(pool, { assignmentId: asg.id, anchor: 'run:1',
        criterion: 'terminal', bucket: 'b0' });

      // ① 显式 null 也必须拦（旧写法 `&& skippedReason !== null` 会放过它）
      await assertMacroError('validation_failed',
        () => finishMacroRun(pool, { macroRunId: run.id, status: 'skipped', skippedReason: null }),
        'skipped 显式 null 也不许');

      // ② 推到终态后，不许再改回非终态
      const done = await finishMacroRun(pool, { macroRunId: run.id, status: 'done', verdict: 'pass' });
      assert.equal(done.status, 'done');
      await assertMacroError('conflict',
        () => finishMacroRun(pool, { macroRunId: run.id, status: 'running' }), 'done → running 必须 409');
      // 前置证据：库里确实还是 done（不是被静默改掉了）
      assert.equal((await pool.query('SELECT status FROM macro_runs WHERE id = $1', [run.id]))
        .rows[0].status, 'done');
      // ③ 重复写同一终态是幂等的（重试友好）
      assert.equal((await finishMacroRun(pool, { macroRunId: run.id, status: 'done', verdict: 'pass' })).status, 'done');
    });
  });

// ── #625：`KIND_SCHEMA` 的 `default` / `required` 必须真的生效（契约 §1）────────────
// 起因：schema 里只有 type/values/min/max，于是
//   ① `validateKindParams` 对缺字段 `continue` ⇒ 能建出**没有 `at`** 的 `scheduled-task`
//      （永不触发、静默死），界面还显示 Enabled；
//   ② 前端只能用通用规则猜默认值 ⇒ `run-notify` 建出来 `states: []`（**永远不会通知**）。
// 这三条用例钉的就是「缺必填要 400」与「可缺字段由**服务端**补契约默认值（API 直连也拿到）」。

test('#625 建 scheduled-task 缺 at/cwd/task 任一 ⇒ validation_failed 400（旧行为：静默建成永不触发的模板）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await seedScene(pool, 'd1');
    for (const missing of ['at', 'cwd', 'task']) {
      const params = { ...SCHEDULED_PARAMS };
      delete params[missing];
      const err = await assertMacroError('validation_failed', () => createTemplate(pool, {
        kind: 'scheduled-task', name: `缺-${missing}`, scope: 'user', params,
      }), `缺 ${missing} 必须拦`);
      assert.equal(err.httpStatus, 400, `缺 ${missing} 要回 400（路由靠 httpStatus 映射）`);
      assert.equal(err.details?.field, `params.${missing}`, 'details 要指到具体字段，前端才标得红');
    }
    // ⚠ 反向自证：把 `at` 的 `required: true` 从 KIND_SCHEMA 去掉 ⇒ 第一条不再抛 ⇒ 本条红。
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM macro_templates')).rows[0].n, 0,
      '报错的模板不许留下半行（不是"抛了但还是写进去"）');
  });
});

test('#625 建 scheduled-task 只给三个必填 ⇒ 响应与库里都是契约默认值（maxRounds=16 / jitter=10m）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await seedScene(pool, 'd2');
    const t = await createTemplate(pool, {
      kind: 'scheduled-task', name: '只给必填', scope: 'user', params: SCHEDULED_PARAMS,
    });
    const EXPECT = { at: '09:00', cwd: '/p', task: 't', maxRounds: 16, jitter: '10m' };
    assert.deepEqual(t.params, EXPECT, '响应必须带补齐的默认值（前端不再自己猜）');
    assert.deepEqual(
      (await pool.query('SELECT params FROM macro_templates WHERE id = $1', [t.id])).rows[0].params,
      EXPECT, '默认值必须**落库**（validateKindParams 的返回值不写库 = 补了又丢）');
  });
});

test('#625 建 run-notify 不给 states ⇒ 契约那五个默认值，不是 []（[] 永不通知却显示 Enabled）',
  { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await seedScene(pool, 'd3');
    const t = await createTemplate(pool, {
      kind: 'run-notify', name: '全默认', scope: 'session', params: {},
    });
    assert.deepEqual(t.params.states,
      ['failed', 'capped', 'aborted', 'persistence_failed', 'guard_unverified'],
      'states 必须是契约 §1 的默认集合（**不是** 空数组）');
    assert.equal(t.params.channel, 'site', 'channel 也要补上（enum 的唯一取值）');
    // ⚠ 反向自证：把 states 的 `default` 从 KIND_SCHEMA 去掉 ⇒ states 根本不在 params 里 ⇒ 本条红。
    // 默认值还必须是**拷贝**：否则调用方一 push 就改到共享的 schema 常量上（跨请求串味）。
    const p = validateKindParams('run-notify', {});
    p.states.push('completed');
    assert.deepEqual(KIND_SCHEMA['run-notify'].states.default,
      ['failed', 'capped', 'aborted', 'persistence_failed', 'guard_unverified'],
      'schema 的默认值数组不许被调用方改到（必须每次拷一份）');
  });
});

test('#625 updateTemplate 也补默认值，且缺必填的 patch 一样 400', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await seedScene(pool, 'd4');
    const t = await createTemplate(pool, {
      kind: 'run-review', name: '审查', scope: 'session', params: { max_rounds: 3 },
    });
    assert.deepEqual(t.params, { max_rounds: 3, review_depth: 1, on_fail: 'reflow' },
      '显式写的 3 不许被默认值 8 覆盖；没写的可缺字段才补');
    // patch 里没写的可缺字段 ⇒ 按契约补齐；显式值原样保留
    const patched = await updateTemplate(pool, {
      templateId: t.id, patch: { params: { max_rounds: 5 } },
    });
    assert.deepEqual(patched.params, { max_rounds: 5, review_depth: 1, on_fail: 'reflow' });
    // patch 缺必填（scheduled-task 少 task）⇒ 同样 400，不许"只改一半"写进去
    const st = await createTemplate(pool, {
      kind: 'scheduled-task', name: '必填闸', scope: 'user', params: SCHEDULED_PARAMS,
    });
    const bad = { at: '10:00', cwd: '/p' };
    await assertMacroError('validation_failed',
      () => updateTemplate(pool, { templateId: st.id, patch: { params: bad } }));
    assert.deepEqual(
      (await pool.query('SELECT params FROM macro_templates WHERE id = $1', [st.id])).rows[0].params,
      { ...SCHEDULED_PARAMS, maxRounds: 16, jitter: '10m' },
      '失败的 patch 不许动库里的 params');
  });
});
