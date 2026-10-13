// issue #280 的**真库**核心用例：空库 → baseline(schema.sql) → bootstrap.sql → 全部增量迁移，
// 且**故意以非属主角色（超级用户）跑** —— 这正是「只设 DATABASE_URL」的手工/救灾路径
// （config.js 的 migrateDatabaseUrl 缺省回退 DATABASE_URL）。此前仓库没有任何测试覆盖这条真实
// 顺序，所以「0016 的 CREATE SEQUENCE + ALTER SEQUENCE … OWNED BY 要求与表同属主」这颗雷才能长期存活。
//
// 环境门（口径同 portal/test/litellm-live.test.js 的 env 门 + docs/testing.md §2.2.1）：
//   有 PG：TEST_DATABASE_URL 指向一次性 postgres:16（必须是超级用户——bootstrap 要 CREATE ROLE）：
//     sg docker -c "docker run -d --rm -p 127.0.0.1:15499:5432 -e POSTGRES_USER=station \
//       -e POSTGRES_PASSWORD=test -e POSTGRES_DB=station_test postgres:16"
//     TEST_DATABASE_URL=postgres://station:test@127.0.0.1:15499/station_test node --test portal/test/migrate-fresh-db.test.js
//   无 PG：TEST_DATABASE_URL 未设置 ⇒ 整个文件 skip（不 fail，不参与假通过）。
// 隔离约定（docs/testing.md §2.2.4）：只连注入的 URL，每个用例自建新库自建角色、用完即删；
//   绝不碰真实 dev 库（station-db）与真实容器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPool } from '../src/db.js';
import { migrate, computeExpectedVersions } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPER_DATABASE_URL = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = SUPER_DATABASE_URL
  ? false
  : 'TEST_DATABASE_URL 未设置：真库用例需一次性 postgres:16（docs/testing.md §2.2.1），无 PG 时整体跳过';

// 一次性容器内的测试口令（不是凭据，不进仓库口径的密钥管理；容器 --rm 即焚）。
const TEST_PW = 'w280-test-only';

/** 平台库角色名从 bootstrap.sql 里读（它才是属主归正的目标），避免在测试里写死。 */
function platformRoleFromBootstrap() {
  const sql = fs.readFileSync(path.join(HERE, '../../docs/data/bootstrap.sql'), 'utf8');
  const m = sql.match(/OWNER TO\s+([A-Za-z_][A-Za-z0-9_$]*)/);
  assert.ok(m, 'bootstrap.sql 里应能找到属主归正目标角色');
  return m[1];
}

const PLATFORM = platformRoleFromBootstrap();
const SUPER_URL = SUPER_DATABASE_URL ? new URL(SUPER_DATABASE_URL) : null;
const LOGIN_ROLE = SUPER_URL ? decodeURIComponent(SUPER_URL.username) : '';
const LOGIN_PW = SUPER_URL ? decodeURIComponent(SUPER_URL.password || '') : '';
const adminPool = SUPER_DATABASE_URL ? createPool(SUPER_DATABASE_URL, { max: 2 }) : null;

const suffix = () => crypto.randomBytes(4).toString('hex');

/** 在注入的实例上换库 / 换登录角色拼连接串（只碰注入的那台）。 */
function dbUrl(database, user = LOGIN_ROLE, pw = LOGIN_PW) {
  const u = new URL(SUPER_DATABASE_URL);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(pw);
  u.pathname = `/${database}`;
  return u.toString();
}

/** 建一个全新空库并在结束时删掉（WITH (FORCE)：pg 池可能还占着连接）。 */
async function withFreshDatabase(fn) {
  const name = `w280_${suffix()}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  try {
    return await fn(name);
  } finally {
    await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
}

async function ownersOf(database) {
  const pool = createPool(dbUrl(database), { max: 1 });
  try {
    const tbl = await pool.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'transcript_rounds'`,
    );
    const seq = await pool.query(
      `SELECT sequenceowner FROM pg_sequences WHERE schemaname = 'public' AND sequencename = 'transcript_rounds_append_seq_seq'`,
    );
    const ledger = await pool.query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'`,
    );
    const canWriteLedger = await pool.query(
      `SELECT has_table_privilege($1, 'public.schema_migrations', 'INSERT') AS ins,
              has_table_privilege($1, 'public.schema_migrations', 'UPDATE') AS upd`,
      [PLATFORM],
    );
    return {
      table: tbl.rows[0]?.tableowner ?? null,
      sequence: seq.rows[0]?.sequenceowner ?? null,
      ledger: ledger.rows[0]?.tableowner ?? null,
      ledgerPrivileges: canWriteLedger.rows[0],
    };
  } finally {
    await pool.end();
  }
}

test('全新空库以超级用户跑全流程（issue #280 现场）：一路到 head，序列与表同属主，台账以平台角色可写', { skip: SKIP }, async () => {
  await withFreshDatabase(async (database) => {
    // 只设 DATABASE_URL（救灾/手工路径的形状）：runner 连的是超级用户，不是表属主。
    const pool = createPool(dbUrl(database), { max: 1 });
    try {
      const summary = await migrate(pool, {
        env: { DATABASE_URL: dbUrl(database) },
        log: { log: () => {} },
      });
      assert.match(summary.baselineChecksum, /^sha256:[0-9a-f]{64}$/);

      const expected = computeExpectedVersions();
      const ledger = await pool.query(`SELECT version FROM schema_migrations ORDER BY version`);
      assert.deepEqual(
        ledger.rows.map((r) => r.version),
        [...expected].sort(),
        '台账 = baseline + 全部增量（0016 必须在内，正是原失败点）',
      );
      assert.equal(ledger.rows.length, 22, '台账行数 = 22（baseline + 0001..0021）');

      // 这颗雷本身：序列属主必须与表属主一致（PG process_owned_by 的硬要求）。
      const owners = await ownersOf(database);
      assert.equal(owners.table, PLATFORM, '表属主 = bootstrap 归正目标');
      assert.equal(owners.sequence, PLATFORM, '0016 新建的序列属主必须与表同 = 平台角色');
      // 要求 4：SET ROLE 之后循环里的 schema_migrations 写入确实以平台角色执行 ⇒ 它必须有 INSERT/UPDATE。
      assert.equal(owners.ledger, PLATFORM, 'schema_migrations 属主 = 平台角色');
      assert.deepEqual(owners.ledgerPrivileges, { ins: true, upd: true }, '平台角色必须能写台账');

      // RESET ROLE 钉桩：pool max=1 ⇒ 这里拿到的必定是迁移用过的那条连接，角色必须已还原。
      const now = await pool.query('SELECT current_user AS role');
      assert.equal(now.rows[0].role, LOGIN_ROLE, '迁移结束必须还原到连接登录角色');
    } finally {
      await pool.end();
    }
  });
});

test('compose 形态（连接角色已是平台角色）再跑一遍：幂等 + 一条 SET/RESET ROLE 都不发（不回退 no-op）', { skip: SKIP }, async () => {
  await adminPool.query(`ALTER ROLE ${PLATFORM} PASSWORD '${TEST_PW}' LOGIN`);
  await withFreshDatabase(async (database) => {
    const superPool = createPool(dbUrl(database), { max: 1 });
    try {
      await migrate(superPool, { env: {}, log: { log: () => {} } });
    } finally {
      await superPool.end();
    }

    // 以平台角色连接（compose 的 MIGRATE_DATABASE_URL 形状），记录语句序列验证「零角色语句」。
    // bootstrap 步骤必须另给超级用户连接（compose 就是这么拆的：BOOTSTRAP_DATABASE_URL）——
    // bootstrap.sql 要 CREATE ROLE / ALTER ROLE / GRANT，非超级用户跑不动（实测 42501）。
    const recorded = [];
    const inner = createPool(dbUrl(database, PLATFORM, TEST_PW), { max: 1 });
    const recorder = {
      async connect() {
        const c = await inner.connect();
        return {
          query: async (sql, params) => {
            recorded.push(String(sql).replace(/\s+/g, ' ').trim());
            return c.query(sql, params);
          },
          release: () => c.release(),
        };
      },
    };
    const logs = [];
    const composeBootstrapPool = createPool(dbUrl(database), { max: 1 });
    try {
      const summary = await migrate(recorder, {
        bootstrapPool: composeBootstrapPool,
        env: { MIGRATE_DATABASE_URL: dbUrl(database, PLATFORM, TEST_PW) },
        log: { log: (m) => logs.push(String(m)) },
      });
      assert.match(summary.baselineChecksum, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(
        recorded.filter((q) => /^(SET|RESET) ROLE/i.test(q)),
        [],
        `已是平台角色时不得发任何角色语句：${JSON.stringify(recorded.filter((q) => /ROLE/i.test(q)))}`,
      );
      assert.ok(
        logs.some((l) => l.includes('no-op') && l.includes(PLATFORM)),
        `no-op 要留可诊断日志，实得：${JSON.stringify(logs.filter((l) => /no-op/.test(l)))}`,
      );
      const role = await inner.query('SELECT current_user AS role');
      assert.equal(role.rows[0].role, PLATFORM, 'compose 路径的连接角色全程不变（零副作用）');
      const ledger = await inner.query('SELECT count(*)::int AS n FROM schema_migrations');
      assert.equal(ledger.rows[0].n, computeExpectedVersions().length, '重放幂等：台账行数不变');
    } finally {
      await inner.end();
      await composeBootstrapPool.end();
    }
  });
});

test('迁移角色无权限承担 DDL 属主 ⇒ fail fast 报可操作错误（不让人在 0016 里读 PG 内部报错）', { skip: SKIP }, async () => {
  const intruder = `w280_intr_${suffix()}`;
  await withFreshDatabase(async (database) => {
    const superPool = createPool(dbUrl(database), { max: 1 });
    try {
      await migrate(superPool, { env: {}, log: { log: () => {} } });
      // 模拟「baseline + bootstrap 已就位、增量未落账」的中间态（迁移跑到一半炸掉后的形状）：
      // 增量全是幂等的，重放安全（deploy/migrations/README.md 单文件约定）。
      await superPool.query(`DELETE FROM schema_migrations WHERE version <> '0000_baseline'`);
    } finally {
      await superPool.end();
    }

    await adminPool.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${intruder}') THEN
         CREATE ROLE ${intruder} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${TEST_PW}';
       END IF; END $$;`,
    );
    const intruderUrl = dbUrl(database, intruder, TEST_PW);
    const intruderPool = createPool(intruderUrl, { max: 1 });
    // bootstrap 给超级用户（生产拆分形状）；迁移本体走 intruder（非属主、非成员）。
    // schema 级授权是**分库**的 ⇒ 必须连到该库上发（owner 已由 bootstrap 归正给平台角色，
    // 这里由超级用户代授）。
    const bootstrapPool = createPool(dbUrl(database), { max: 1 });
    try {
      await bootstrapPool.query(`GRANT CONNECT ON DATABASE ${database} TO ${intruder}`);
      await bootstrapPool.query(`GRANT USAGE ON SCHEMA public TO ${intruder}`);
      await bootstrapPool.query(`GRANT SELECT ON schema_migrations TO ${intruder}`);

      const err = await migrate(intruderPool, {
        bootstrapPool,
        env: { MIGRATE_DATABASE_URL: intruderUrl },
        log: { log: () => {} },
      }).then(() => null, (e) => e);
      assert.ok(err, '非属主且非成员的角色必须失败（静默跳过 = 陷阱还在）');
      const msg = String(err.message);
      assert.match(msg, /MIGRATE_DATABASE_URL/, '必须给出可操作出口');
      assert.ok(msg.includes(PLATFORM), '必须点名目标平台角色');
      assert.ok(msg.includes(intruder), '必须点名当前连接角色');
      assert.match(msg, /DDL 属主/, '必须说清为什么承担不了');
      assert.doesNotMatch(
        msg,
        /sequence must have same owner/,
        '必须在 0016 之前就报人话，而不是把 PG 内部报错甩给人读',
      );
      const role = await intruderPool.query('SELECT current_user AS role');
      assert.equal(role.rows[0].role, intruder, '失败路径也不能把角色残留在这条连接上');
      const applied = await bootstrapPool.query(
        `SELECT count(*)::int AS n FROM schema_migrations WHERE version <> '0000_baseline'`,
      );
      assert.equal(applied.rows[0].n, 0, 'fail fast 后一条增量都不落账');
    } finally {
      await intruderPool.end();
      await bootstrapPool.end();
      await adminPool.query(`DROP ROLE IF EXISTS ${intruder}`).catch(() => {});
    }
  });
});
