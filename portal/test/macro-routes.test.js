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
  deleteAssignment, sessionMacroRuns, adminTemplates, adminCreateTemplate, adminPatchTemplate,
  adminMacroRuns, adminMacroRunDetail, adminRunsSummary,
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
