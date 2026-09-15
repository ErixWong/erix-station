// 集成测试：真实 Postgres（需 docker / TEST_DATABASE_URL）。不参与 `npm test`（docker-free）。
// 运行：TEST_DATABASE_URL=postgres://station:station@127.0.0.1:55432/station_test npm run test:integration
// 覆盖：迁移幂等 / advisory lock 并发 / 角色属性 / 最小权限（station_portal DML、station_platform DDL）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from '../src/db.js';
import { migrate, computeExpectedVersions } from '../src/migrate.js';
import { checkReady } from '../src/http.js';

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

  // head = baseline（deploy/migrations 为空）
  assert.deepEqual(computeExpectedVersions(), ['0000_baseline']);
  assert.equal(await checkReady(pool), true);

  // 幂等：再次迁移不报错、不重放 baseline
  const second = await migrate(pool, {});
  assert.equal(second.baselineAppliedNow, false);

  // 并发迁移：advisory lock 串行化，不出现 tuple concurrently updated
  await Promise.all([migrate(pool, {}), migrate(pool, {}), migrate(pool, {})]);

  // checksum 已从哨兵回填为真实 sha256
  const r = await pool.query(`SELECT checksum FROM schema_migrations WHERE version = '0000_baseline'`);
  assert.match(r.rows[0].checksum, /^sha256:[0-9a-f]{64}$/);
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

test.after(async () => {
  await pool.end().catch(() => {});
});
