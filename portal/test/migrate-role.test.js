// issue #280：迁移身份对齐（SET ROLE / RESET ROLE）的**无 PG 也能跑**的护栏。
// 钉四件事（真库形状由 portal/test/migrate-fresh-db.test.js 钉）：
//   ① 纯函数口径 resolveMigrationRole / roleFromDatabaseUrl（角色名不写死）；
//   ② 顺序：SET ROLE 必须落在 applyBootstrap **之后**、增量循环（首次 INSERT INTO schema_migrations）
//      **之前**——bootstrap 要 CREATE ROLE/GRANT 并决定「谁是属主」，非超级用户跑不动它；
//   ③ 当前角色已是平台角色 ⇒ 一条 SET/RESET ROLE 都不发（compose 路径是无副作用 no-op，不许回退）；
//   ④ RESET ROLE 在成功与异常两条路径上都必须发，且**早于连接归还 pool**（pg 会复用连接，
//      残留 SET ROLE 会把后续同连接查询的属主语义一起改掉）。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool 记录语句序列，不碰真实 DB / 不碰真实环境。
import test from 'node:test';
import assert from 'node:assert/strict';

import { migrate, resolveMigrationRole, roleFromDatabaseUrl } from '../src/migrate.js';

const PLATFORM = 'station_platform';

/** 记录语句序列的假 client/pool：只认识 migrate.js 真会发的那些语句。 */
function makeFakePool({
  currentRole = 'station',
  measuredOwner = PLATFORM,
  failSetRole = null,
  failOnSql = null,
} = {}) {
  const trace = [];
  const logs = [];
  const client = {
    async query(sql, params) {
      trace.push(String(sql).replace(/\s+/g, ' ').trim().slice(0, 200));
      if (/^SET ROLE/i.test(String(sql).trim()) && failSetRole) throw new Error(failSetRole);
      if (failOnSql && String(sql).includes(failOnSql)) throw new Error(`boom: ${failOnSql}`);
      if (/pg_advisory_(un)?lock/i.test(sql)) return { rows: [] };
      if (sql.includes('to_regclass')) return { rows: [{ rel: null }] }; // 空库：台账不存在
      if (sql.includes('current_user')) return { rows: [{ role: currentRole }] };
      if (sql.includes('pg_tables')) return { rows: [{ owner: measuredOwner }] };
      if (/SELECT checksum FROM schema_migrations WHERE version/.test(sql)) return { rows: [] }; // 未应用
      return { rows: [] };
    },
    release() {
      trace.push('<<release>>');
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query() {
      return { rows: [] };
    },
    async end() {},
  };
  return { pool, trace, logs, log: { log: (m) => logs.push(String(m)) } };
}

const idxOf = (trace, needle) => trace.findIndex((q) => q.includes(needle));
// 注意 'RESET ROLE' 也包含子串 'SET ROLE' ⇒ 找 SET 时必须锚定行首。
const idxOfStart = (trace, needle) => trace.findIndex((q) => q.startsWith(needle));

test('resolveMigrationRole：配置点名 > 连接串用户 > 库内实测属主；全等于当前角色 ⇒ no-op', () => {
  // 救灾路径（issue #280 现场）：只设 DATABASE_URL ⇒ 连接串用户就是当前角色（超级用户），
  // 等于没点名 ⇒ 必须退到「库内实测表属主」，否则 0016 照炸。
  assert.equal(
    resolveMigrationRole({ configured: null, urlRole: 'station', measuredOwner: PLATFORM, currentRole: 'station' }),
    PLATFORM,
    '超级用户连接时取库内实测属主',
  );
  // 配置点名优先（PLATFORM_DB_USER / 显式注入）。
  assert.equal(
    resolveMigrationRole({ configured: 'custom_owner', urlRole: 'station', measuredOwner: PLATFORM, currentRole: 'station' }),
    'custom_owner',
    '配置点名的角色优先于实测',
  );
  // compose 路径：连接串用户 == 当前角色 == 实测属主 ⇒ 返回当前角色（调用方须是 no-op）。
  assert.equal(
    resolveMigrationRole({ configured: null, urlRole: PLATFORM, measuredOwner: PLATFORM, currentRole: PLATFORM }),
    PLATFORM,
    '已是平台角色 ⇒ 原样返回（no-op）',
  );
  // 什么都没配、库里也量不到 ⇒ 仍是当前角色（不发 SET ROLE）。
  assert.equal(
    resolveMigrationRole({ configured: '', urlRole: undefined, measuredOwner: null, currentRole: 'station' }),
    'station',
  );
});

test('roleFromDatabaseUrl：取连接角色（URL 编码 / 无用户 / 坏串都不炸）', () => {
  assert.equal(roleFromDatabaseUrl('postgres://station_platform:pw@station-db:5432/station'), PLATFORM);
  assert.equal(roleFromDatabaseUrl('postgresql://station%2Fplatform:pw@h/db'), 'station/platform');
  assert.equal(roleFromDatabaseUrl('postgres://h/db'), null);
  assert.equal(roleFromDatabaseUrl(''), null);
  assert.equal(roleFromDatabaseUrl(undefined), null);
  assert.equal(roleFromDatabaseUrl('not a url at all'), null);
});

test('SET ROLE 落在 bootstrap 之后、增量循环之前；结束与异常都还原角色，且早于连接归还', async () => {
  const { pool, trace, logs } = makeFakePool();
  const summary = await migrate(pool, { env: {}, log: { log: (m) => logs.push(String(m)) } });
  assert.match(summary.baselineChecksum, /^sha256:[0-9a-f]{64}$/);

  const iBootstrapRole = idxOf(trace, 'CREATE ROLE station_platform'); // bootstrap 建平台角色
  const iBootstrapGrant = idxOf(trace, 'GRANT CREATE, USAGE ON SCHEMA public'); // bootstrap 授权
  const iSetRole = idxOfStart(trace, 'SET ROLE');
  const iFirstLedgerWrite = idxOf(trace, 'INSERT INTO schema_migrations (version, checksum)');
  const iReset = idxOf(trace, 'RESET ROLE');
  const iRelease = idxOf(trace, '<<release>>');
  assert.ok(iBootstrapRole >= 0 && iBootstrapGrant >= 0, 'bootstrap 的角色/授权块应被执行');
  assert.ok(iSetRole > iBootstrapRole && iSetRole > iBootstrapGrant, 'SET ROLE 必须在 bootstrap 之后（角色与授权还没建出来时它跑不动）');
  assert.ok(iSetRole >= 0 && iSetRole < iFirstLedgerWrite, 'SET ROLE 必须在任何增量迁移落账之前');
  assert.ok(trace[iSetRole].includes(`"${PLATFORM}"`), `SET ROLE 目标应是平台角色，实得：${trace[iSetRole]}`);
  assert.ok(iReset > iFirstLedgerWrite && iReset < iRelease, 'RESET ROLE 必须在循环之后、归还连接之前');
  // 还原必须早于 advisory unlock / release（同一个 finally 块里）。
  assert.ok(iReset < idxOf(trace, 'pg_advisory_unlock'), 'RESET ROLE 早于 advisory unlock');
  assert.ok(logs.some((l) => l.includes(`SET ROLE ${PLATFORM}`)), '切换动作要留日志');
  assert.ok(logs.some((l) => l.includes('RESET ROLE')), '还原动作要留日志');
});

test('当前角色已是平台角色 ⇒ 一条 SET/RESET ROLE 都不发（compose 路径无副作用 no-op）', async () => {
  const { pool, trace, logs, log } = makeFakePool({ currentRole: PLATFORM });
  await migrate(pool, { env: { MIGRATE_DATABASE_URL: `postgres://${PLATFORM}:pw@h/station` }, log });
  assert.deepEqual(
    trace.filter((q) => /^(SET|RESET) ROLE/i.test(q)),
    [],
    `no-op 路径不得发 SET/RESET ROLE，实得：${JSON.stringify(trace.filter((q) => /ROLE/i.test(q)))}`,
  );
  assert.ok(logs.some((l) => l.includes('no-op') && l.includes(PLATFORM)), 'no-op 要说清楚');
  // 台账照写（迁移没被跳过，只是不发角色语句）。
  assert.ok(idxOf(trace, 'INSERT INTO schema_migrations (version, checksum)') >= 0);
});

test('SET ROLE 被拒 ⇒ fail fast：报可操作错误、不静默跳过、一条增量迁移都不跑', async () => {
  const { pool, trace, log } = makeFakePool({ failSetRole: `permission denied to set role "${PLATFORM}"` });
  await assert.rejects(
    () => migrate(pool, { env: {}, log }),
    (err) => {
      const msg = String(err.message);
      assert.match(msg, /MIGRATE_DATABASE_URL/, '要给出可操作出口（点名 MIGRATE_DATABASE_URL）');
      assert.ok(msg.includes(PLATFORM), '要写明目标平台角色');
      assert.ok(msg.includes('station'), '要写明当前连接角色');
      assert.ok(msg.includes('DDL 属主'), '要说清为什么承担不了');
      assert.ok(msg.includes('permission denied to set role'), '原始 PG 错误要保留在末尾');
      return true;
    },
  );
  assert.equal(idxOf(trace, 'INSERT INTO schema_migrations (version, checksum)'), -1, 'fail fast 后不跑增量');
  assert.equal(idxOf(trace, 'RESET ROLE'), -1, '没进去就不必还原');
  assert.ok(idxOf(trace, '<<release>>') >= 0, '连接仍要归还');
});

test('迁移中途抛错 ⇒ RESET ROLE 照样发（异常路径也还原，且不掩盖原错误）', async () => {
  const boomOn = 'ALTER TABLE transcript_rounds ADD COLUMN IF NOT EXISTS append_seq'; // 0016 的形状
  const { pool, trace, log } = makeFakePool({ failOnSql: boomOn });
  await assert.rejects(() => migrate(pool, { env: {}, log }), (err) => {
    assert.match(err.message, /boom:/, '原始迁移错误必须原样抛出');
    return true;
  });
  const iReset = idxOf(trace, 'RESET ROLE');
  const iRelease = idxOf(trace, '<<release>>');
  assert.ok(iReset >= 0, '异常路径也必须 RESET ROLE');
  assert.ok(iReset < iRelease, '还原早于连接归还 pool');
});
