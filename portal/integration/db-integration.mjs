// 集成测试：真实 Postgres（需 docker / TEST_DATABASE_URL）。不参与 `npm test`（docker-free）。
// 运行：TEST_DATABASE_URL=postgres://station:station@127.0.0.1:55432/station_test npm run test:integration
// 覆盖：迁移幂等 / advisory lock 并发 / 角色属性 / 最小权限（station_portal DML、station_platform DDL）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { migrate, computeExpectedVersions } from '../src/migrate.js';
import { checkReady } from '../src/http.js';
import { executeWithIdempotency, requestHash } from '../src/idempotency.js';
import { enqueueFullRebuild, FULL_REBUILD_AGGREGATE_ID } from '../src/routes.js';

const DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL 未设置。请先启动临时 postgres:16 并导出该变量。');
}

const pool = createPool(DATABASE_URL, { max: 10 });

async function resetPublicSchema() {
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    client.release();
  }
}

async function expectDenied(client, role, sql, label) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${role}`);
  let denied = false;
  try {
    await client.query(sql);
  } catch {
    denied = true;
  }
  await client.query('ROLLBACK');
  assert.ok(denied, `期望被拒绝但成功：${label}`);
}

async function expectAllowed(client, role, sql, label) {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${role}`);
  try {
    await client.query(sql);
  } catch (e) {
    await client.query('ROLLBACK');
    assert.fail(`期望成功但被拒绝：${label} —— ${e.message}`);
  }
  await client.query('ROLLBACK');
}

test('迁移：空库应用 baseline+bootstrap、幂等、head readiness、并发 advisory lock', async (t) => {
  await resetPublicSchema();

  // 迁移前未就绪（schema_migrations 不存在）
  assert.equal(await checkReady(pool), false);

  const first = await migrate(pool, {});
  assert.equal(first.baselineAppliedNow, true);
  assert.match(first.baselineChecksum, /^sha256:[0-9a-f]{64}$/);

  // head = baseline + 全部增量迁移（deploy/migrations/*.sql，文件名升序）
  const expectedVersions = computeExpectedVersions();
  assert.deepEqual(expectedVersions, ['0000_baseline', '0001-idempotency-keys', '0002-llm-config']);
  assert.equal(await checkReady(pool), true);

  // F2：baseline（schema.sql）自 P1 冻结、**不含** idempotency_keys；该表只由增量迁移 0001 提供
  const tbl = await pool.query(`SELECT to_regclass('public.idempotency_keys') AS rel`);
  assert.equal(tbl.rows[0].rel, 'idempotency_keys', 'idempotency_keys 由迁移 0001 建出');
  const stateCol = await pool.query(
    `SELECT column_default FROM information_schema.columns
      WHERE table_name = 'idempotency_keys' AND column_name = 'state'`,
  );
  assert.equal(stateCol.rows[0]?.column_default, `'done'::text`, 'state 列默认 done（先占位后执行）');
  const applied = await pool.query(`SELECT count(*)::int AS n FROM schema_migrations`);
  assert.equal(applied.rows[0].n, expectedVersions.length, '台账行数 = baseline + 全部增量迁移');

  // 幂等：再次迁移不报错、不重放 baseline
  const second = await migrate(pool, {});
  assert.equal(second.baselineAppliedNow, false);

  // 并发迁移：advisory lock 串行化，不出现 tuple concurrently updated
  await Promise.all([migrate(pool, {}), migrate(pool, {}), migrate(pool, {})]);

  // checksum 已从哨兵回填为真实 sha256
  const r = await pool.query(`SELECT checksum FROM schema_migrations WHERE version = '0000_baseline'`);
  assert.match(r.rows[0].checksum, /^sha256:[0-9a-f]{64}$/);
});

test("F3'（Round B 评审）：enqueueFullRebuild 在真实 DB 可落盘——aggregate_id=nil uuid 哨兵，revisions/outbox 各一行 pending", async () => {
  // 幂等：首个用例已应用全部迁移；此处再调一次确保本用例独立可跑。
  await migrate(pool, {});
  // 清掉历史 full_rebuild 行，保证「恰好各一行」断言的确定性。
  await pool.query(`DELETE FROM route_outbox WHERE aggregate = 'full_rebuild'`);
  await pool.query(`DELETE FROM route_revisions WHERE aggregate = 'full_rebuild'`);

  // 不抛错即堵住「invalid input syntax for type uuid」（Round A 用非 UUID 字面量 'startup' 的回归类别）。
  await enqueueFullRebuild(pool);

  const rev = await pool.query(
    `SELECT aggregate_id::text AS aggregate_id, revision
       FROM route_revisions WHERE aggregate = 'full_rebuild'`,
  );
  assert.equal(rev.rows.length, 1, 'route_revisions 恰好一行 full_rebuild');
  assert.equal(rev.rows[0].aggregate_id, FULL_REBUILD_AGGREGATE_ID, 'revisions head aggregate_id = nil uuid 哨兵');

  const out = await pool.query(
    `SELECT aggregate_id::text AS aggregate_id, op, revision, state, payload
       FROM route_outbox WHERE aggregate = 'full_rebuild'`,
  );
  assert.equal(out.rows.length, 1, 'route_outbox 恰好一行 full_rebuild');
  assert.equal(out.rows[0].aggregate_id, FULL_REBUILD_AGGREGATE_ID, 'outbox aggregate_id = nil uuid 哨兵');
  assert.equal(out.rows[0].state, 'pending', 'outbox 行 state=pending（循环可消费）');
  assert.equal(Number(out.rows[0].revision), Number(rev.rows[0].revision), 'outbox revision = revisions head（head 语义）');
  assert.equal(out.rows[0].op, 'upsert');
  assert.equal(out.rows[0].payload?.reason ?? JSON.parse(out.rows[0].payload).reason, 'startup_rebuild_failed');

  // 重试复用同一聚合：再次入队只递增 head，不产生第二聚合（哨兵语义）。
  await enqueueFullRebuild(pool);
  const rev2 = await pool.query(
    `SELECT revision FROM route_revisions WHERE aggregate = 'full_rebuild' AND aggregate_id = $1`,
    [FULL_REBUILD_AGGREGATE_ID],
  );
  assert.equal(Number(rev2.rows[0].revision), Number(rev.rows[0].revision) + 1, '二次入队复用同一聚合（revision 递增）');
  const outN = await pool.query(`SELECT count(*)::int AS n FROM route_outbox WHERE aggregate = 'full_rebuild'`);
  assert.equal(outN.rows[0].n, 2, '二次入队再写一行 pending outbox（重试信号）');
});

test('角色属性：station_platform / station_portal 均为 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE', async () => {
  const r = await pool.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole
       FROM pg_roles WHERE rolname IN ('station_platform', 'station_portal') ORDER BY rolname`,
  );
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.equal(row.rolcanlogin, true, `${row.rolname} 应可登录`);
    assert.equal(row.rolsuper, false);
    assert.equal(row.rolcreatedb, false);
    assert.equal(row.rolcreaterole, false);
  }
});

test('最小权限：station_portal 可 DML 业务表、不可 DDL、不可写 schema_migrations、可读 schema_migrations', async () => {
  const client = await pool.connect();
  try {
    // DML 允许
    await expectAllowed(client, 'station_portal', `SELECT 1 FROM users`, 'station_portal 读 users');
    await expectAllowed(client, 'station_portal', `SELECT 1 FROM login_pending`, 'station_portal 读 login_pending');
    await expectAllowed(client, 'station_portal', `SELECT 1 FROM schema_migrations`, 'station_portal 读 schema_migrations');

    // DDL 拒绝
    await expectDenied(client, 'station_portal', `CREATE TABLE _t (id int)`, 'station_portal 建表');

    // schema_migrations 写拒绝（readiness 只读）
    await expectDenied(client, 'station_portal', `INSERT INTO schema_migrations (version, checksum) VALUES ('x', 'y')`, 'station_portal 写 schema_migrations');
    await expectDenied(client, 'station_portal', `UPDATE schema_migrations SET checksum='z' WHERE version='0000_baseline'`, 'station_portal 改 schema_migrations');
    await expectDenied(client, 'station_portal', `DELETE FROM schema_migrations`, 'station_portal 删 schema_migrations');
  } finally {
    client.release();
  }
});

test('DDL 权限：station_platform 可建表/删表（bootstrap 已归正 ownership）', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE station_platform');
    try {
      await client.query('CREATE TABLE _mig_test (id int)');
      await client.query('DROP TABLE _mig_test');
    } catch (e) {
      await client.query('ROLLBACK');
      assert.fail(`station_platform 应可 DDL：${e.message}`);
    }
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
});

test('幂等台账（迁移 0001）真库 SQL 语义：先占位后执行 —— 并发第二请求 409 conflict(retryable)、fn 抛错释放、stale 接管', async () => {
  // 真库跑 idempotency.js 的全部 SQL（claim 的 ON CONFLICT DO UPDATE ... WHERE / 条件 UPDATE 抢回 /
  // 占位完成 / 释放），验证单测里 fake pool 模拟的语义与 Postgres 一致。
  const userId = '00000000-0000-4000-8000-0000000000c1';
  await pool.query(`DELETE FROM idempotency_keys`);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.query(
    `INSERT INTO users (id, login, display_name, role, auth_source, status) VALUES ($1, 'idem-probe', 'probe', 'fde', 'local', 'active')`,
    [userId],
  );

  const endpoint = 'POST /api/sessions/11111111-1111-4111-8111-111111111111/messages';
  const hash = requestHash({ content: 'hi', attachments: [{ kind: 'file', path: '/a', name: 'a.txt', size: 9 }] });
  const ctx = { userId, endpoint, key: 'probe-key', requestHash: hash };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ① 并发同 key：先到者执行（慢 fn），后到者在占位期内被 409 conflict 拦住（先到先得），fn 只执行一次
  let calls = 0;
  const slowFn = async () => {
    calls += 1;
    await sleep(300);
    return { statusCode: 202, response: { message: { id: 'm1' }, run: { id: 'r1' } } };
  };
  const winner = executeWithIdempotency(pool, ctx, slowFn);
  await sleep(80); // 让赢家先占到占位
  const loser = await executeWithIdempotency(pool, ctx, slowFn).then(
    () => ({ code: null }),
    (e) => ({ code: e.code, retryable: e.retryable, httpStatus: e.httpStatus }),
  );
  assert.deepEqual(loser, { code: 'idempotency_conflict', retryable: true, httpStatus: 409 }, '输者 409 idempotency_conflict(retryable)');
  const first = await winner;
  assert.equal(first.replayed, false);
  assert.equal(calls, 1, 'fn 只执行一次（先占位后执行：无双执行窗口）');
  const row = await pool.query(`SELECT state, status_code, response FROM idempotency_keys WHERE key = 'probe-key'`);
  assert.equal(row.rows[0].state, 'done');
  assert.equal(row.rows[0].status_code, 202);
  assert.equal(row.rows[0].response.run.id, 'r1');

  // ② 完成后重发 → 回放（不再执行 fn）；同 key 不同 hash → 409 idempotency_key_reuse
  assert.equal((await executeWithIdempotency(pool, ctx, slowFn)).replayed, true);
  assert.equal(calls, 1);
  await assert.rejects(
    () => executeWithIdempotency(pool, { ...ctx, requestHash: requestHash({ content: '别的', attachments: [] }) }, slowFn),
    (e) => e.code === 'idempotency_key_reuse' && e.httpStatus === 409,
  );

  // ③ fn 抛错 → 占位行被删除（客户端可原样重试）
  const boom = new Error('probe fn boom');
  await assert.rejects(
    () => executeWithIdempotency(pool, { ...ctx, key: 'probe-key-err' }, async () => { throw boom; }),
    (e) => e === boom,
  );
  assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'probe-key-err'`)).rows[0].n), 0, '占位已释放');

  // ④ stale in_progress（回拨 created_at 10 分钟）→ 后续请求抢回并执行（不被一次崩溃永久钉死）
  await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, state, status_code, response, created_at)
     VALUES ($1, $2, 'probe-key-stale', $3, 'in_progress', NULL, NULL, now() - interval '10 minutes')`,
    [userId, endpoint, hash],
  );
  const taken = await executeWithIdempotency(pool, { ...ctx, key: 'probe-key-stale' }, slowFn);
  assert.equal(taken.replayed, false);
  assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE key = 'probe-key-stale' AND state = 'done'`)).rows[0].n), 1);

  // ⑤ 新鲜 in_progress（刚插入）→ 409 conflict（不得覆写）
  await pool.query(
    `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash, state, status_code, response)
     VALUES ($1, $2, 'probe-key-fresh', $3, 'in_progress', NULL, NULL)`,
    [userId, endpoint, hash],
  );
  await assert.rejects(
    () => executeWithIdempotency(pool, { ...ctx, key: 'probe-key-fresh' }, slowFn),
    (e) => e.code === 'idempotency_conflict' && e.retryable === true,
  );

  await pool.query(`DELETE FROM idempotency_keys`);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
});

test.after(async () => {
  await pool.end().catch(() => {});
});
