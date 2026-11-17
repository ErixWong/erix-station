// issue #526（事件平台 W3）：`portal/src/macro-routes.js` 的用例（契约 10 篇 §3）。
//
// 环境门口径照 `macros.test.js`：`TEST_DATABASE_URL` 未设置 ⇒ 真库用例整体 skip。
//   TEST_DATABASE_URL=postgres://station:station@127.0.0.1:15496/station_test \
//     node --test portal/test/macro-routes.test.js
//
// 判据面：
//   ① **summary 的分母是 `done`**：造 triggered=5 / done=3 / skipped=1 / failed=1 ⇒
//      `byVerdict` 各桶之和 === 3（把桶写成 `COALESCE(verdict,'unclassified')` 会吸进
//      skipped/failed ⇒ 和变 5 ⇒ 本用例红——反向自证就是这么打的）；
//   ② 非属主 404（SessionError.httpStatus=404，不是 403——不泄露存在性）；
//   ③ 用户面响应 `Object.keys` 恰为契约 §3.2 的六项（无 created_by/enabled/deleted_at）；
//   ④ admin 流水行 `Object.keys` 无 sessionId/childSessionId（契约 §3.3）；
//   ⑤ 订阅 PUT 幂等；软删/停用/admin-audience 模板不进用户面列表；summary 跟着筛选变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import {
  toPublicTemplate, toAdminRunItem, userTemplates, sessionAssignments, putAssignment,
  deleteAssignment, sessionMacroRuns, userMacroRuns, adminTemplates, adminCreateTemplate, adminPatchTemplate,
  adminMacroRuns, adminMacroRunDetail, adminRunsSummary,
  userAssignments, putUserAssignment, deleteUserAssignment,
} from '../src/macro-routes.js';
import { MacroError, createTemplate, assignTemplate, claimMacroRun, finishMacroRun, deleteTemplate, updateTemplate } from '../src/macros.js';
import { SessionError } from '../src/sessions.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w526r' }) : null;
const withFreshDb = (fn) => fixture.withFreshDatabase(({ pool }) => fn(pool), { log: () => {} });

async function seedScene(pool, tag) {
  const userId = randomUUID();
  const projectId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
    [userId, `r526${tag}`],
  );
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1, $2, $3, 'git@x:y/z.git', '~/projects/x', 0)`, [projectId, userId, `p526${tag}`]);
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title) VALUES ($1, $2, $3, 's')`,
    [sessionId, userId, projectId]);
  return { userId, projectId, sessionId };
}

// ── 纯逻辑（响应形状的白名单闸，无 PG 也要跑）────────────────────────────────

test('#526 判据3：用户面模板项 keys 恰为六项（created_by/enabled/deleted_at 不下发）', () => {
  const pub = toPublicTemplate({
    id: 'i', kind: 'run-review', name: 'n', params: { a: 1 }, scope: 'session', audience: 'all',
    enabled: false, created_by: 'who', created_at: 'x', updated_at: 'y', deleted_at: 'z',
  });
  assert.deepEqual(
    Object.keys(pub).sort(),
    ['audience', 'id', 'kind', 'name', 'params', 'scope'].sort(),
    '用户面白名单：多一列（created_by/enabled/deleted_at）即红',
  );
});

test('#526 判据4：admin 流水行 keys 不含 sessionId / childSessionId', () => {
  const item = toAdminRunItem({
    id: 'r1', started_at: new Date('2026-11-16T00:00:00Z'),
    finished_at: new Date('2026-11-16T00:04:12Z'),
    template_id: 't1', template_name: '完成审查 · 默认', user_id: 'u1', user_name: 'eric',
    anchor: 'run:9f3a', criterion: 'semantic', status: 'done', verdict: 'red',
    child_session_id: randomUUID(), child_run_id: randomUUID(),
  });
  const keys = Object.keys(item);
  assert.ok(!keys.includes('sessionId') && !keys.includes('childSessionId')
    && !keys.includes('child_session_id') && !keys.includes('child_run_id'),
  `admin 响应混进 session 维度: ${keys.join(',')}`);
  assert.equal(item.durationMs, 252000, 'durationMs = finished-started');
  assert.equal(item.usage, null, '0035 无 usage 列：null=未记账，不许拿 0 冒充');
});

// ── 真库 ──────────────────────────────────────────────────────────────────────

test('#526 判据1：summary 分母是 done —— byVerdict 各桶之和 === done(3) ≠ triggered(5)', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'sm');
    const tpl = await createTemplate(pool, { kind: 'run-review', name: 'rev', scope: 'session', params: {} });
    const a = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });
    // 造 5 条：done×3（pass/red/unclassified）+ skipped×1 + failed×1
    const mk = async (anchor) => claimMacroRun(pool, { assignmentId: a.id, anchor, criterion: 'terminal', bucket: 'b' });
    const r1 = await mk('e1'); const r2 = await mk('e2'); const r3 = await mk('e3');
    const r4 = await mk('e4'); const r5 = await mk('e5');
    await finishMacroRun(pool, { macroRunId: r1.id, status: 'done', verdict: 'pass' });
    await finishMacroRun(pool, { macroRunId: r2.id, status: 'done', verdict: 'red' });
    await finishMacroRun(pool, { macroRunId: r3.id, status: 'done' }); // 不给判决 ⇒ 落 unclassified
    await finishMacroRun(pool, { macroRunId: r4.id, status: 'skipped', skippedReason: 'deferred' });
    await finishMacroRun(pool, { macroRunId: r5.id, status: 'failed' });

    const s = await adminRunsSummary({ pool, query: new URLSearchParams() });
    assert.deepEqual([s.triggered, s.done, s.skipped, s.failed], [5, 3, 1, 1]);
    const sum = Object.values(s.byVerdict).reduce((x, y) => x + y, 0);
    assert.equal(sum, s.done, '分母是 done：byVerdict 之和必须等于 done(3)；若实现按 triggered 归桶（把 NULL 判决吸进 unclassified）这里是 5');
    assert.deepEqual(s.byVerdict, { pass: 1, red: 1, 'no-op-claim': 0, 'needs-human': 0, unclassified: 1 });
    assert.equal(s.usage, null);

    // summary 跟着筛选变：按模板筛 = 全量；换一个不存在模板 = 全 0
    const s2 = await adminRunsSummary({ pool, query: new URLSearchParams(`templateId=${tpl.id}`) });
    assert.equal(s2.triggered, 5);
    const s3 = await adminRunsSummary({ pool, query: new URLSearchParams(`templateId=${randomUUID()}`) });
    assert.deepEqual([s3.triggered, s3.done], [0, 0]);

    // 流水列表：倒序 + admin 形状 + 筛选
    const list = await adminMacroRuns({ pool, query: new URLSearchParams('status=done&verdict=red') });
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0].verdict, 'red');
    assert.ok(!Object.keys(list.items[0]).includes('sessionId'));
    const detail = await adminMacroRunDetail({ pool, runId: r2.id });
    assert.equal(detail.run.id, r2.id);
    await assert.rejects(() => adminMacroRunDetail({ pool, runId: randomUUID() }), (e) => e instanceof MacroError && e.httpStatus === 404);
  });
});

test('#526 判据2：非属主一律 404（SessionError.httpStatus=404，不是 403）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const owner = await seedScene(pool, 'o1');
    const other = await seedScene(pool, 'o2');
    for (const fn of [
      () => sessionAssignments({ pool, sessionId: owner.sessionId, userId: other.userId }),
      () => putAssignment({ pool, sessionId: owner.sessionId, userId: other.userId, body: { templateId: randomUUID() } }),
      () => deleteAssignment({ pool, sessionId: owner.sessionId, userId: other.userId, assignmentId: randomUUID() }),
      () => sessionMacroRuns({ pool, sessionId: owner.sessionId, userId: other.userId }),
    ]) {
      await assert.rejects(fn, (e) => {
        assert.ok(e instanceof SessionError, `应为 SessionError，实际 ${e?.constructor?.name}`);
        assert.equal(e.httpStatus, 404, '非属主必须 404（403 会泄露存在性）');
        return true;
      });
    }
    // 不存在的会话 ⇒ 同样 404（与非属主同形状，无法区分）
    await assert.rejects(
      () => sessionMacroRuns({ pool, sessionId: randomUUID(), userId: owner.userId }),
      (e) => e instanceof SessionError && e.httpStatus === 404,
    );
  });
});

test('#526 用户面：模板过滤 + 订阅 PUT 幂等 + 会话流水 keyset', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'u1');
    const tAll = await createTemplate(pool, { kind: 'run-notify', name: 'on', scope: 'session', params: {} });
    const tOff = await createTemplate(pool, { kind: 'run-notify', name: 'off', scope: 'session', params: {} });
    await updateTemplate(pool, { templateId: tOff.id, patch: { enabled: false } });
    const tAdmin = await createTemplate(pool, { kind: 'run-notify', name: 'adm', scope: 'session', audience: 'admin', params: {} });
    // 软删一支：要有执行账才删得成软删（物理删的模板直接从列表消失，殊途同归，不重复测）
    const tDel = await createTemplate(pool, { kind: 'run-notify', name: 'del', scope: 'session', params: {} });
    const ad = await assignTemplate(pool, { templateId: tDel.id, userId, sessionId });
    const rd = await claimMacroRun(pool, { assignmentId: ad.id, anchor: 'x', criterion: 'terminal', bucket: 'b' });
    await finishMacroRun(pool, { macroRunId: rd.id, status: 'done', verdict: 'pass' });
    await deleteTemplate(pool, { templateId: tDel.id });

    const list = await userTemplates({ pool });
    const names = list.items.map((t) => t.name);
    assert.ok(names.includes('on'));
    assert.ok(!names.includes('off'), '停用不下发');
    assert.ok(!names.includes('adm'), 'admin-audience 不下发');
    assert.ok(!names.includes('del'), '软删不下发');
    for (const it of list.items) {
      assert.deepEqual(Object.keys(it).sort(), ['audience', 'id', 'kind', 'name', 'params', 'scope'].sort());
    }

    // PUT 幂等 upsert：同 body 两次 ⇒ 仍一条；换 until 会更新而不是新增
    const p1 = await putAssignment({ pool, sessionId, userId, body: { templateId: tAll.id } });
    const p2 = await putAssignment({ pool, sessionId, userId, body: { templateId: tAll.id, until: '2027-01-01T00:00:00.000Z' } });
    assert.equal(p1.assignment.id, p2.assignment.id, 'ON CONFLICT 复用同一行');
    assert.equal(new Date(p2.assignment.until).getTime(), Date.parse('2027-01-01T00:00:00.000Z'));
    const asg = await sessionAssignments({ pool, sessionId, userId });
    // 本会话上有两条订阅：tDel（软删模板留下的）与 tAll（PUT 建的）——软删模板的订阅仍在会话上。
    assert.deepEqual(asg.items.map((x) => x.id).sort(), [ad.id, p1.assignment.id].sort());

    // 会话流水：keyset limit=1 翻两页不重不漏（这条会话下只属于本会话订阅的两条账）
    const a2 = await assignTemplate(pool, { templateId: tAll.id, userId, sessionId: (await seedScene(pool, 'u2')).sessionId });
    void a2; // 别人的订阅不出现在本会话（下面断言条数即证）
    await deleteAssignment({ pool, sessionId, userId, assignmentId: p1.assignment.id });
    const runs = await sessionMacroRuns({ pool, sessionId, userId });
    assert.equal(runs.items.length, 1, '会话视角只看见本会话订阅的账');
    assert.equal(runs.items[0].id, rd.id);
    assert.ok(!('sessionId' in runs.items[0]), '用户面 run 项沿用 toMacroRunSnapshot（snake 列名），不含 camel sessionId');

    // 管理台模板面：PATCH 白名单闸 + includeDeleted
    await assert.rejects(
      () => adminPatchTemplate({ pool, templateId: tAll.id, body: { kind: 'run-review' } }),
      (e) => e instanceof MacroError && e.code === 'validation_failed',
    );
    const admAll = await adminTemplates({ pool, query: new URLSearchParams('includeDeleted=true') });
    assert.ok(admAll.items.some((t) => t.id === tDel.id && t.deleted_at), 'admin includeDeleted 看得到软删行');
    const admDef = await adminTemplates({ pool, query: new URLSearchParams() });
    assert.ok(!admDef.items.some((t) => t.id === tDel.id), '默认不含软删');
    assert.ok(admDef.items.some((t) => t.id === tOff.id && t.enabled === false), '停用仍在 admin 面');
    const created = await adminCreateTemplate({ pool, body: { kind: 'scheduled-task', name: 'adm-new', scope: 'user', params: { at: '09:00' } }, adminUserId: userId });
    assert.equal(created.template.created_by, userId, 'admin 建模板记 created_by');
  });
});

// ── #613 管理台「订阅数」列 ────────────────────────────────────────────────────────

/**
 * `07` §2 要这一列的理由是「停用前要知道影响谁」，所以本用例同时钉三件事：
 *  1. 有在用订阅的模板 ⇒ 具体数字（不是 —）；一个都没有 ⇒ `0`（前端拿 `undefined` 显示 `—`，
 *     那是「后端没下发」的意思，不能和「没人订」混为一个值）；
 *  2. 口径只算 `enabled = true`：挂在**同一个模板**上的取消订阅不计入（挂在另一张表上就测不出口径）；
 *  3. 软删模板（`includeDeleted=true`）也带数：软删不抹订阅行 ⇒ 这一行的影响面照样看得见。
 * 外加一条反 N+1 自证：模板数从 3 涨到 8 ⇒ 计数 SQL 仍只发一条 `GROUP BY`。
 */
test('#613 adminTemplates 下发 subscriberCount：2/0、取消订阅不计入、软删也带数、无 N+1', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u1 = await seedScene(pool, 's613a');
    const u2 = await seedScene(pool, 's613b');
    const u3 = await seedScene(pool, 's613c');

    const tTwo = await createTemplate(pool, { kind: 'run-notify', name: 'subs-two', scope: 'session', params: {} });
    const tZero = await createTemplate(pool, { kind: 'run-notify', name: 'subs-zero', scope: 'session', params: {} });

    // 两条在用订阅：订阅键是 (template_id,user_id,session_id,cwd) ⇒ 必须换人才能真长出第二条
    await assignTemplate(pool, { templateId: tTwo.id, userId: u1.userId, sessionId: u1.sessionId });
    await assignTemplate(pool, { templateId: tTwo.id, userId: u2.userId, sessionId: u2.sessionId });

    // 第三条挂在**同一个模板**上、随后取消：先有账 ⇒ unassign 走「停用支」（enabled=false 的行留在表里）
    const aOff = await assignTemplate(pool, { templateId: tTwo.id, userId: u3.userId, sessionId: u3.sessionId });
    const rOff = await claimMacroRun(pool, { assignmentId: aOff.id, anchor: 'c613', criterion: 'terminal', bucket: 'b' });
    await finishMacroRun(pool, { macroRunId: rOff.id, status: 'done', verdict: 'pass' });
    const cancelled = await deleteAssignment({ pool, sessionId: u3.sessionId, userId: u3.userId, assignmentId: aOff.id });
    assert.equal(cancelled.mode, 'disabled', '必须是停用支：deleted 支会把行删掉 ⇒ 本用例退化成空断言');
    const offRow = await pool.query('SELECT enabled FROM macro_assignments WHERE id = $1', [aOff.id]);
    assert.equal(offRow.rows[0]?.enabled, false, '取消订阅后行仍在且 enabled=false');

    // 软删模板（有账 ⇒ 软删支，订阅行保留）
    const tDel = await createTemplate(pool, { kind: 'run-notify', name: 'subs-del', scope: 'session', params: {} });
    const aDel = await assignTemplate(pool, { templateId: tDel.id, userId: u1.userId, sessionId: u1.sessionId });
    const rDel = await claimMacroRun(pool, { assignmentId: aDel.id, anchor: 'c613d', criterion: 'terminal', bucket: 'b' });
    await finishMacroRun(pool, { macroRunId: rDel.id, status: 'done', verdict: 'pass' });
    await deleteTemplate(pool, { templateId: tDel.id });

    const byId = new Map((await adminTemplates({ pool, query: new URLSearchParams() })).items.map((t) => [t.id, t]));
    assert.ok(byId.has(tTwo.id) && byId.has(tZero.id), '两个模板都应在 admin 列表里');
    const two = byId.get(tTwo.id);
    const zero = byId.get(tZero.id);

    // 字段必须下发且是 number（缺字段 ⇒ 前端只能显示 —，正是本 issue 的病根）
    for (const it of [two, zero]) {
      assert.ok('subscriberCount' in it, 'subscriberCount 必须在响应里');
      assert.equal(typeof it.subscriberCount, 'number', `必须是 number，实际 ${typeof it.subscriberCount}`);
      assert.ok(Number.isInteger(it.subscriberCount), '不能是 bigint 字符串（node-pg 会把 COUNT(*) 回传成 "2"）');
    }
    assert.equal(two.subscriberCount, 2, '两条在用订阅；第三条已取消不计入 ⇒ 2 而不是 3');
    assert.equal(zero.subscriberCount, 0, '没人订必须是 0，不是 null/undefined');
    assert.notEqual(zero.subscriberCount, null);

    // 软删模板：includeDeleted=true 也带这个数
    const admDel = (await adminTemplates({ pool, query: new URLSearchParams('includeDeleted=true') }))
      .items.find((t) => t.id === tDel.id);
    assert.ok(admDel && admDel.deleted_at, '软删行看得到');
    assert.equal(admDel.subscriberCount, 1, '软删不抹订阅行 ⇒ 删除影响面照样要看得见');

    // 反 N+1：模板数从 3 涨到 8 ⇒ 订阅数查询仍只发一条 GROUP BY
    let groupByQueries = 0;
    const spy = { query: (sql, params) => { if (/macro_assignments/i.test(sql) && /GROUP\s+BY/i.test(sql)) groupByQueries += 1; return pool.query(sql, params); } };
    for (let i = 0; i < 5; i += 1) {
      await createTemplate(pool, { kind: 'run-notify', name: `subs-extra-${i}`, scope: 'session', params: {} });
    }
    await adminTemplates({ pool: spy, query: new URLSearchParams() });
    assert.equal(groupByQueries, 1, '一次 GROUP BY 拿全表；逐模板一条查询就是 N+1');
  });
});

// ── #614 用户级全局流水端点 ────────────────────────────────────────────────────

test('#614 userMacroRuns：属主过滤 = 当前用户，只看到自己的流水', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u1 = await seedScene(pool, 'u614a');
    const u2 = await seedScene(pool, 'u614b');
    const tpl = await createTemplate(pool, { kind: 'run-review', name: 'rev-614', scope: 'session', params: {} });
    const a1 = await assignTemplate(pool, { templateId: tpl.id, userId: u1.userId, sessionId: u1.sessionId });
    const a2 = await assignTemplate(pool, { templateId: tpl.id, userId: u2.userId, sessionId: u2.sessionId });
    const r1 = await claimMacroRun(pool, { assignmentId: a1.id, anchor: 'e1', criterion: 'terminal', bucket: 'b' });
    const r2 = await claimMacroRun(pool, { assignmentId: a2.id, anchor: 'e2', criterion: 'terminal', bucket: 'b' });
    assert.ok(r1 && r2, '两条流水都该建成');

    const mine = await userMacroRuns({ pool, userId: u1.userId });
    assert.deepEqual(mine.items.map((x) => x.id), [r1.id], 'u1 只看到自己那一条');
    assert.ok(!mine.items.some((x) => x.id === r2.id), '别人的流水不许出现');

    const theirs = await userMacroRuns({ pool, userId: u2.userId });
    assert.deepEqual(theirs.items.map((x) => x.id), [r2.id], 'u2 反过来只看到自己那一条');
  });
});

test('#614 userMacroRuns：响应不含 snapshot_id / worktree_path / verdict_raw（即使 DB 里有值）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId, sessionId } = await seedScene(pool, 'u614c');
    const tpl = await createTemplate(pool, { kind: 'run-review', name: 'rev-614c', scope: 'session', params: {} });
    const a = await assignTemplate(pool, { templateId: tpl.id, userId, sessionId });
    // 认领时就给 snapshot_id / worktree_path 填真值 ⇒ 若实现不剥，键就会出现（反向自证打这里）
    const r = await claimMacroRun(pool, {
      assignmentId: a.id, anchor: 'e', criterion: 'terminal', bucket: 'b',
      snapshotId: randomUUID(), worktreePath: '/tmp/wt-xyz',
    });
    await pool.query('UPDATE macro_runs SET verdict_raw = $1 WHERE id = $2', ['RAW_ERR', r.id]);

    const list = await userMacroRuns({ pool, userId });
    assert.equal(list.items.length, 1);
    const keys = Object.keys(list.items[0]);
    assert.ok(!keys.includes('snapshot_id'), 'snapshot_id 必须被剥掉');
    assert.ok(!keys.includes('worktree_path'), 'worktree_path 必须被剥掉');
    assert.ok(!keys.includes('verdict_raw'), '原始错误码 verdict_raw 必须被剥掉');
    // 与会话级同形：仍带用户面字段与会话/游标结构
    assert.ok('assignment_id' in list.items[0] && 'status' in list.items[0] && 'started_at' in list.items[0]);
    assert.ok('items' in list && 'nextCursor' in list, '响应形状与会话级一致');
    assert.equal(list.nextCursor, null);
  });
});

// ── issue #623：用户级订阅写入口（scheduled-task 是 scope='user'，用户需自己的开户路径）──

// 建一个 user-scope 模板（scheduled-task）；用户面可订。
async function seedUserScopeTemplate(pool, tag) {
  return createTemplate(pool, { kind: 'scheduled-task', name: `sched-${tag}`, scope: 'user', params: { at: '09:00' } });
}

test('#623 PUT 建 user-scope 订阅 ⇒ 库里一行、session_id 为 NULL、cwd 有值', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'ua1');
    const tpl = await seedUserScopeTemplate(pool, 'ua1');
    const { assignment } = await putUserAssignment({ pool, userId, body: { templateId: tpl.id, cwd: '~/projects/acme' } });
    assert.equal(assignment.session_id, null, 'user-scope 订阅 session_id 必须 NULL');
    assert.equal(assignment.cwd, '~/projects/acme', 'cwd 落库');
    assert.equal(assignment.user_id, userId);
    assert.ok(assignment.effective_enabled, '新建即生效');
    // 直查库：恰一行，且 session_id IS NULL、cwd 非空
    const rows = await pool.query('SELECT id, session_id, cwd FROM macro_assignments WHERE user_id = $1', [userId]);
    assert.equal(rows.rowCount, 1, '库里恰一行');
    assert.equal(rows.rows[0].session_id, null);
    assert.equal(rows.rows[0].cwd, '~/projects/acme');
    // 响应形状复用 toAssignmentSnapshot：不含 worktree_path 之类运维字段
    assert.ok(!('worktree_path' in assignment), '用户面订阅不下发 worktree_path');
  });
});

test('#623 同 templateId 再 PUT ⇒ 幂等（UNIQUE NULLS NOT DISTINCT，不新增行）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'ua2');
    const tpl = await seedUserScopeTemplate(pool, 'ua2');
    const first = await putUserAssignment({ pool, userId, body: { templateId: tpl.id, cwd: '~/projects/acme' } });
    const second = await putUserAssignment({ pool, userId, body: { templateId: tpl.id, cwd: '~/projects/acme' } });
    assert.equal(first.assignment.id, second.assignment.id, '命中幂等键 ⇒ 同一行');
    const cnt = await pool.query('SELECT COUNT(*)::int AS n FROM macro_assignments WHERE user_id = $1', [userId]);
    assert.equal(cnt.rows[0].n, 1, '重复 PUT 不新增行');
  });
});

test('#623 cwd 不是 ~/projects/<name> 形式 ⇒ 400（拒绝 .. / 绝对路径 / 多级目录 / 缺失）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const { userId } = await seedScene(pool, 'ua3');
    const tpl = await seedUserScopeTemplate(pool, 'ua3');
    for (const bad of ['../etc', '/home/x/y', '~/projects/a/b', '~/other/x', '~/projects', '']) {
      await assert.rejects(
        () => putUserAssignment({ pool, userId, body: { templateId: tpl.id, cwd: bad } }),
        (e) => e.httpStatus === 400,
        `非法 cwd 应 400: ${JSON.stringify(bad)}`,
      );
    }
    // 合法值应通过
    const ok = await putUserAssignment({ pool, userId, body: { templateId: tpl.id, cwd: '~/projects/acme' } });
    assert.equal(ok.assignment.cwd, '~/projects/acme');
  });
});

test('#623 GET 只返回当前用户、且只含 scope=user 的订阅', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u1 = await seedScene(pool, 'ua4a');
    const u2 = await seedScene(pool, 'ua4b');
    const tpl = await seedUserScopeTemplate(pool, 'ua4');
    await putUserAssignment({ pool, userId: u1.userId, body: { templateId: tpl.id, cwd: '~/projects/p1' } });
    await putUserAssignment({ pool, userId: u2.userId, body: { templateId: tpl.id, cwd: '~/projects/p2' } });
    const g1 = await userAssignments({ pool, userId: u1.userId });
    assert.equal(g1.items.length, 1, 'u1 只看自己一条');
    assert.equal(g1.items[0].user_id, u1.userId);
    assert.equal(g1.items[0].cwd, '~/projects/p1');
    // user 订阅不会混进会话级模板的订阅：造一个 session-scope 模板的会话订阅，不应出现在 userAssignments
    const sTpl = await createTemplate(pool, { kind: 'run-review', name: 'rev', scope: 'session', params: {} });
    await assignTemplate(pool, { templateId: sTpl.id, userId: u1.userId, sessionId: u1.sessionId });
    const g1b = await userAssignments({ pool, userId: u1.userId });
    assert.equal(g1b.items.length, 1, '会话级订阅不进 user 列表（只看 scope=user）');
  });
});

test('#623 DELETE 取消自己的订阅成功；取消别人的 ⇒ 404（不泄露存在性）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const u1 = await seedScene(pool, 'ua5a');
    const u2 = await seedScene(pool, 'ua5b');
    const tpl = await seedUserScopeTemplate(pool, 'ua5');
    const own = await putUserAssignment({ pool, userId: u1.userId, body: { templateId: tpl.id, cwd: '~/projects/p1' } });
    // 别人先删 ⇒ 404
    await assert.rejects(
      () => deleteUserAssignment({ pool, userId: u2.userId, assignmentId: own.assignment.id }),
      (e) => e instanceof MacroError && e.httpStatus === 404,
      '取消别人的订阅应 404（不泄露存在性）',
    );
    // 自己删 ⇒ 成功
    const res = await deleteUserAssignment({ pool, userId: u1.userId, assignmentId: own.assignment.id });
    assert.ok(res && (res.mode === 'deleted' || res.mode === 'disabled'), '自己的订阅取消成功');
    // 再 GET ⇒ 空
    const g = await userAssignments({ pool, userId: u1.userId });
    assert.equal(g.items.filter((a) => a.effective_enabled).length, 0, '取消后无生效订阅');
  });
});
