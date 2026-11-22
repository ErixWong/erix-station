// issue #698 / #698b：**真库**判据 —— 保存的形状只有在真库里才是事实。
//
// 两个现场（都是 fake 测不出来的那一类，本文件是它们的判据化）：
//   * 第一轮（#698）：`prev` CTE 带 `FOR UPDATE` ⇒ 在**含 data-modifying CTE 的同一条语句**里看不见
//     本语句要改的那行 ⇒ `prev` 恒空集 ⇒ 保存恒 500（而值已落库、审计一行没有）。
//   * 本轮（#698b，独立审计 MED）：把 `FOR UPDATE` 去掉后 500 修好了，但**没有行锁** ⇒ 两个连接并发
//     保存时两条审计的 `previous_max_bytes` **都指向并发前的值**（审计链看不出谁把谁改成了谁）。
//   ⇒ 本轮把保存改成**显式事务**（`BEGIN` → `SELECT … FOR UPDATE` → upsert → 审计 → `COMMIT`）；
//     下面第四格（并发链）就是那条 MED 的判据化，前三格继续盯第一轮那个 500。
//
// 为什么必须真库：`portal/test/upload-settings.test.js` 全走 fake pool，而 fake 是按 **SQL 文本**裁决的
// 模拟 —— 它既不模拟行锁，也不模拟 READ COMMITTED 的可见性。第一轮那个 500 被它的"恒绿"放过，
// 本轮的审计链 MED 也被它的"恒绿"放过 ⇒ **判据类型选错**不是"测得不细"，所以补的是真库判据。
//
// 环境门（口径照 `portal/test/migrate-fresh-db.test.js`，文案由 `pg-fixture.js` 的 `SKIP_WITHOUT_PG` 单点持有）：
//   有 PG（**一次性**实例，绝不指向真库 station-db，docs/testing.md §2.2.1 / §2.2.4）：
//     docker run -d --rm --name pg698b -p 127.0.0.1:55443:5432 \
//       -e POSTGRES_USER=p -e POSTGRES_PASSWORD=p -e POSTGRES_DB=p postgres:16
//     docker exec pg698b pg_isready -U p -d p -t 15
//     TEST_DATABASE_URL=postgres://p:p@127.0.0.1:55443/p \
//       node --test portal/test/upload-settings-real-db.test.js
//   无 PG：`TEST_DATABASE_URL` 未设置 ⇒ **整个文件 skip**（不是假通过：计入 `# skipped`；
//   下面那条「环境门自证」用例不设 skip，专门盯这个门有没有把真库用例静默放行）。
//
// 隔离：只连注入的那台，每条用例 `CREATE DATABASE` 自建自删（`withFreshDatabase`，内含跨进程文件锁）。
// 并发那一格另外开**三条 `max: 1` 的池**（两个保存连接 + 一个拦路连接）：`max: 1` 只保证"一条池一条
// 后端"，"两个后端互不相同"由格子里那对 `pg_backend_pid()` 相等与否来证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { createPool } from '../src/db.js';
import {
  DEFAULT_MAX_FILE_BYTES, AUDIT_ACTION, AUDIT_TARGET, updateUploadSettings,
} from '../src/upload-settings.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;
const MIB = 1024 * 1024;
// env 显式给了值（`fileUploadMaxBytesSource: 'env'` 是 `loadConfig` 的产出形状）⇒ 回落位是 `env`。
const ENV32 = { fileUploadMaxBytes: DEFAULT_MAX_FILE_BYTES, fileUploadMaxBytesSource: 'env' };
const ACTOR = 'd0000000-0000-4000-8000-0000000000a1';

// 表形**不自己发明**：库由夹具按 baseline + bootstrap + 全部增量建出来，`upload_settings` 来自
// 迁移 0036、`audit_log` 来自 baseline（0026 线）。下面只是把两边读回来的形状摆在一起对账。
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'u698' }) : null;

/** 每条用例一个全新库；`fn(pool, ctx)` 里 `ctx.url` 是那个库的连接串（并发格要另开 `max: 1` 的池）。 */
const withFreshDb = (fn) => fixture.withFreshDatabase(
  (ctx) => fn(ctx.pool, ctx), { log: () => {} },
);

const save = (pool, maxFileBytes) => updateUploadSettings({
  pool, config: ENV32, actorId: ACTOR, fields: { maxFileBytes },
});
const auditRows = (pool) => pool.query(
  `SELECT details ->> 'previous_max_bytes' AS previous_max_bytes,
          details ->> 'previous_source'     AS previous_source,
          details -> 'max_file_bytes'       AS max_file_bytes,
          actor_id
     FROM audit_log WHERE action = $1 AND target = $2 ORDER BY id`,
  [AUDIT_ACTION, AUDIT_TARGET],
);
const dbValue = (pool) => pool.query('SELECT max_file_bytes::text AS v FROM upload_settings WHERE id = 1');

/** 真并发用的专用池：`max: 1` ⇒ 一条池 = 一条后端连接（不靠池调度碰运气凑并发）。 */
const oneConnection = (url) => createPool(url, { max: 1 });
const endQuietly = async (p) => { try { await p?.end(); } catch { /* 收尾不能盖掉正在报的错 */ } };
const pidOf = async (pool) => (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

// ---------------------------------------------------------------------------
test('#698 首写（表里没行）：保存不抛、值落库、审计恰好 1 行且 previous_* 是当时真正在用的兜底值', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    const res = await save(pool, 20 * MIB); // 旧形状在这里抛 500（rowCount=0 ⇒ 读回不可用）
    assert.equal(res.settings.maxFileBytes, 20 * MIB, '响应里的生效值必须来自 RETURNING（= 落库值）');
    assert.equal((await dbValue(pool)).rows[0].v, String(20 * MIB), '库里必须真是这个值');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 1, '首写必须写 1 行审计（旧形状这里是 0 行 = 设置生效而审计无痕）');
    // ⚠ **#698b 的契约变更点**（不是测错了）：首写的 `previous_*` 不再是 SQL `LEFT JOIN` 出来的 `null`，
    // 而是「改动前真正在用的那个兜底值」（env 显式 ⇒ env 那一档）。理由：`previous_*` 现在只由 JS 用
    // `parseDbMaxFileBytes` 派生一处（硬口径 6），而接口返回的 `previous` 用的就是同一次派生 ⇒
    // 「审计说的」与「接口说的」在首写这一格也逐值相同（fake 侧 US-20 一直要求两边等价，旧版真库
    // 反而与它不同形）。`null` 那个形状只有旧 CTE 能产生，它随 SQL 里那份 CASE 一起删掉了。
    assert.equal(rows[0].previous_max_bytes, String(DEFAULT_MAX_FILE_BYTES),
      `首写没有 DB 旧值 ⇒ 审计必须记当时真正生效的兜底值（${DEFAULT_MAX_FILE_BYTES}），实得 ${rows[0].previous_max_bytes}`);
    assert.equal(rows[0].previous_source, 'env', '兜底位来自显式 env（loadConfig 的来源标注），不许猜');
    assert.deepEqual(
      { prev: res.previous.maxFileBytes, src: res.previous.source },
      { prev: Number(rows[0].previous_max_bytes), src: rows[0].previous_source },
      '接口返回的 previous 与审计里的 previous 必须是同一个数、同一个来源（US-20 口径的真库面）',
    );
    assert.equal(String(rows[0].max_file_bytes), String(20 * MIB), '新值记的是落库值');
    assert.equal(String(rows[0].actor_id), ACTOR, '审计必须记是谁改的');
  });
});

test('#698 二写：previous_max_bytes 是首写那个值、审计 2 行（串成一条链）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    await save(pool, 20 * MIB);
    const res = await save(pool, 40 * MIB);
    assert.equal(res.previous.maxFileBytes, 20 * MIB, '接口返回的 previous 必须是紧邻的前一个值');
    assert.equal(res.previous.source, 'db', '旧值可用 ⇒ 接口也说 db');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 2, `两次保存必须各写 1 行审计，实得 ${rows.length} 行`);
    assert.equal(rows[1].previous_max_bytes, String(20 * MIB),
      '第二条审计的 previous_max_bytes 必须是首写落的那个值（旧形状在这里是 null：FOR UPDATE 让 prev 空）');
    assert.equal(rows[1].previous_source, 'db', '旧值可用 ⇒ 来源必须写 db（不许谎报 env）');
    assert.equal(rows[0].previous_max_bytes, String(DEFAULT_MAX_FILE_BYTES),
      '第一条仍是首写（无 DB 旧值 ⇒ 记当时生效的兜底值，与第 1 格同一口径）');
    assert.equal((await dbValue(pool)).rows[0].v, String(40 * MIB), '终值是第二次写的值');
  });
});

test('#698 区间外旧值那一档：previous_source 回落 env/default（不是 db）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
      [ACTOR]);
    await save(pool, 20 * MIB);
    // 手工造一个「绕过写侧进来」的旧值：8 TiB，远超管理台天花板 1 GiB（DB 只有 CHECK > 0，挡不住它）。
    await pool.query('UPDATE upload_settings SET max_file_bytes = 8::bigint * 1024 * 1024 * 1024 * 1024 WHERE id = 1');
    assert.equal((await dbValue(pool)).rows[0].v, String(8192 * 1024 * MIB), '现场必须是区间外的值（8 TiB）');
    const res = await save(pool, 30 * MIB);
    assert.equal(res.previous.maxFileBytes, DEFAULT_MAX_FILE_BYTES, '区间外 ⇒ 接口说 previous 是兜底值');
    assert.equal(res.previous.source, 'env', '兜底位来自显式 env（loadConfig 的来源标注），不许猜');
    const rows = (await auditRows(pool)).rows;
    assert.equal(rows.length, 2, '保存本身必须成功并写下第二条审计');
    assert.equal(rows[1].previous_source, 'env',
      `审计里的 previous_source 必须是回落位（env/default），不能是 db，实得 ${rows[1].previous_source}`);
    assert.equal(rows[1].previous_max_bytes, String(DEFAULT_MAX_FILE_BYTES),
      'previous_max_bytes 必须是真正在用的那个兜底值，不是库里那个 8 TiB');
    assert.equal((await dbValue(pool)).rows[0].v, String(30 * MIB), '区间外的旧值不许把新值顶回去');
  });
});


// ---------------------------------------------------------------------------
// #698b 的核心判据：**并发**保存的审计链（独立审计的 MED 就是这个形状）。
//
// 现场（审计实测）：已种 20 MiB ⇒ 两个连接同时保存 40 / 60 MiB ⇒ 两次都成功、都有审计，但两条审计的
// `previous_max_bytes` **都指向并发前的 20 MiB** —— 后写那条没指向紧邻的前一次写入 ⇒ 事后看审计
// 看不出「谁把谁改成了谁」，而这是审计存在的唯一理由。
//
// 为什么这一格必须在真库、且必须真两个连接：
//   * fake pool 按 SQL 文本同步裁决，**没有行锁、没有 READ COMMITTED 可见性** ⇒ 它在 fake 里恒绿
//     （上一版的 500 与本轮的 MED 都是这么被放过的）。fake 侧只留形状闸（US-18/US-19）。
//   * 同一个 `pg.Pool` 上并发也可能被复用到同一条后端连接 ⇒ 那不是并发。所以这里开**两条 `max: 1`
//     的池**，并断言两条后端的 `pg_backend_pid()` 不同。
//
// 并发是**造出来的**，不是碰运气：先用第三条连接 `BEGIN` + `SELECT … FOR UPDATE` 把那一行占住，
// 再同时发出两次保存 ⇒ 它们**必然**都卡在拿锁那一步（格子里用 `pg_locks` 数到 2 个等待者当见证），
// 然后放行。没有这个拦路事务，两次 localhost 上的保存可能压根不重叠 ⇒ 这一格会"绿得没测到东西"，
// 而变异 M-1（去掉 FOR UPDATE）也会因此时有时无。
test('#698b 并发链（真并发：两个连接）：两条审计串成链 —— previous 是 {20 MiB, 另一个写入值}，不是 {20, 20}',
  { skip: SKIP, timeout: 120_000 }, async () => {
    await withFreshDb(async (pool, { url }) => {
      await pool.query(`INSERT INTO users (id, login, password_hash, status) VALUES ($1, 'u698', 'x', 'active')`,
        [ACTOR]);
      await save(pool, 20 * MIB);                    // 起点：库里已有 20 MiB（审计第 1 行）
      assert.equal((await dbValue(pool)).rows[0].v, String(20 * MIB), '起点必须是 20 MiB');

      const saverA = oneConnection(url);
      const saverB = oneConnection(url);
      const blocker = oneConnection(url);           // 拦路连接：负责把两次保存逼成"真重叠"
      try {
        const [pidA, pidB] = await Promise.all([pidOf(saverA), pidOf(saverB)]);
        assert.notEqual(pidA, pidB, '两次保存必须落在**两个不同后端**上（同一连接上的"并发"不叫并发）');

        const bc = await blocker.connect();
        try {
          await bc.query('BEGIN');
          await bc.query('SELECT max_file_bytes FROM upload_settings WHERE id = 1 FOR UPDATE');
          // 两次保存同时发出：它们都会卡在 `SELECT … FOR UPDATE`（拦路连接持着那把行锁）。
          const inflight = Promise.allSettled([save(saverA, 40 * MIB), save(saverB, 60 * MIB)]);
          const waiters = await waitForLockWaiters(pool, 2, 20_000);
          assert.ok(waiters >= 2,
            `两个保存连接必须**同时**卡在锁上（重叠的证据，实得等待者 ${waiters} 个）；`
            + '等不到 = 要么并发没造出来，要么拿锁那一步根本不存在（M-1：FOR UPDATE 被去掉）');
          const stillRunning = await Promise.race([
            inflight.then(() => false), new Promise((r) => setTimeout(() => r(true), 200)),
          ]);
          assert.ok(stillRunning, '锁没放行之前两次保存都不许完成（它们确实被挡住了）');
          await bc.query('COMMIT');                  // 放行：此后两条保存只能排队串行
          const settled = await inflight;
          for (const [i, one] of settled.entries()) {
            assert.equal(one.status, 'fulfilled', `并发保存第 ${i + 1} 次必须成功，实得 ${one.reason?.message}`);
          }
        } finally {
          await bc.release();
        }

        const rows = (await auditRows(pool)).rows;
        assert.equal(rows.length, 3, `1 次起点 + 2 次并发 = 3 行审计，实得 ${rows.length} 行`);
        const concurrent = rows.slice(1);            // audit_log id 按插入顺序 ⇒ 第 2、3 行就是那两次
        const prevs = concurrent.map((r) => Number(r.previous_max_bytes)).sort((x, y) => x - y);
        const written = concurrent.map((r) => Number(r.max_file_bytes));
        // 这一格真正盯的就是下面三行：两个**不同**的值，一个是并发前的 20 MiB，另一个是**前一个
        // 保存写进去的那个值**。两条都记 20 MiB 就是审计链断（独立审计 MED 的现场，M-1 的读数）。
        assert.ok(prevs[0] !== prevs[1],
          `两条并发审计的 previous_max_bytes 必须是两个不同的值（链），实得 ${JSON.stringify(prevs)}`);
        assert.equal(prevs[0], 20 * MIB, '先完成那条记的必须是并发前的 20 MiB');
        assert.ok(prevs[1] === 40 * MIB || prevs[1] === 60 * MIB,
          `后完成那条必须记前一个保存写入的值（40 或 60 MiB），实得 ${prevs[1]}`);
        assert.notEqual(prevs[1], 20 * MIB, '后完成那条不许也记并发前的值（= {20 MiB, 20 MiB} 那个 MED）');
        assert.deepEqual(concurrent.map((r) => r.previous_source), ['db', 'db'],
          '两次保存的旧值都是库里的真值 ⇒ 来源必须是 db（两次都谎报 env = 根本没读到旧行）');
        // 链的最强形式（与顺序无关的写法）：**后一条审计的 previous 就是前一条审计写入的那个值**。
        assert.equal(Number(concurrent[1].previous_max_bytes), Number(concurrent[0].max_file_bytes),
          '后提交那条审计的 previous 必须正好等于先提交那条写入的值（链不能只是"两个不同的数"）；'
          + `实得 ${concurrent[1].previous_max_bytes} vs ${concurrent[0].max_file_bytes}`);
        assert.equal(prevs[1], Number(concurrent[0].max_file_bytes), '同上（排序后的口径）');
        assert.ok(written.includes(prevs[1]), 'previous 必须真被前一个保存写过');

        // 终值自洽：库里那个值 = 最后提交那次写的 = 最后一条审计记的新值（并发不能写出半个状态）。
        const finalValue = (await dbValue(pool)).rows[0].v;
        assert.ok([String(40 * MIB), String(60 * MIB)].includes(finalValue),
          `终值必须是两次写入之一，实得 ${finalValue}`);
        assert.equal(String(concurrent[1].max_file_bytes), finalValue,
          '最后一条审计记的新值必须就是终值（并发不能写出半个状态）');
      } finally {
        await endQuietly(saverA);
        await endQuietly(saverB);
        await endQuietly(blocker);
      }
    });
  });

/**
 * 轮询等「本库里有 n 个会话卡在锁上」；到点回实测个数（让断言能说清现实）。
 *
 * 用 `pg_stat_activity.wait_event_type='Lock'` 而不是 `pg_locks.granted=false`：真库实测（PG 16）同一件
 * 事在 `pg_locks` 里长得**不一样** —— 卡在别人未提交事务上的那条显示为 `locktype='transactionid'`
 * （`relation` 是 NULL），后面排队的那条才显示为 `locktype='tuple'` + `relation=upload_settings`；
 * 只按 relation 数就会把 2 个等待者数成 1 个（本轮实测踩过，所以把原因写在注释里）。
 * 不筛语句文本：M-1（去掉 FOR UPDATE）时两个保存会改卡在 upsert 上，等待者仍是 2 个 ⇒ 重叠见证照过，
 * 真正报红的应当是下面那条**链**的断言（= 本单要修的 MED 本体）。
 */
async function waitForLockWaiters(pool, n, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    const res = await pool.query(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    seen = res.rows[0]?.waiting ?? 0;
    if (seen >= n || Date.now() > deadline) return seen;
    await new Promise((r) => setTimeout(r, 20));
  }
}
// ---------------------------------------------------------------------------
// 环境门自证（不设 skip）：无 PG 时上面四格必须是 **skip**，不是 pass。
// 少了这条，"文件里全是 skip" 与 "文件里全是假通过" 在门禁报告上长得一样。
const GUARDED = [
  '#698 首写（表里没行）：保存不抛、值落库、审计恰好 1 行且 previous_* 是当时真正在用的兜底值',
  '#698 二写：previous_max_bytes 是首写那个值、审计 2 行（串成一条链）',
  '#698 区间外旧值那一档：previous_source 回落 env/default（不是 db）',
  '#698b 并发链（真并发：两个连接）：两条审计串成链 —— previous 是 {20 MiB, 另一个写入值}，不是 {20, 20}',
];

test('#698 环境门自证：四格真库用例的名字必须与本文件用例一一对应，且门的形状正确', () => {
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.equal(GUARDED.length, 4, '真库判据至少 4 格（首写 / 二写 / 区间外回落 / 并发链）');
  for (const name of GUARDED) {
    assert.ok(selfSrc.includes(`test('${name}'`) || selfSrc.includes(`test('${name}',`)
      || selfSrc.includes(name), `环境门名单与本文件用例名漂移：${name}`);
  }
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '无 PG 时必须整体 skip（skip 文案点名一次性实例的起法）');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则四格被静默跳过 = 假通过）');
  }
  // 反向自证：产品侧必须真的是「显式事务 + 单独一条 FOR UPDATE + 审计在 COMMIT 之前」，
  // 否则上面四格测的就不是它（这是 US-18 那条运行时形状闸的**源码面镜像**：M-3 那一刀必须在这里也红）。
  const src = fs.readFileSync(path.join(HERE, '../src/upload-settings.js'), 'utf8');
  const body = /export async function updateUploadSettings[\s\S]*\n}/.exec(src)?.[0] ?? '';
  assert.ok(body, 'upload-settings.js 里必须能读到 updateUploadSettings 函数体');
  const at = (token) => body.indexOf(token);
  for (const token of ["'BEGIN'", 'PREVIOUS_SQL', 'UPSERT_SQL', 'AUDIT_SQL', "'COMMIT'"]) {
    assert.ok(at(token) >= 0, `保存必须发 ${token}，函数体里找不到它`);
  }
  assert.ok(at("'BEGIN'") < at('PREVIOUS_SQL'), 'BEGIN 必须最早（否则 FOR UPDATE 拿不到跨语句的锁）');
  assert.ok(at('PREVIOUS_SQL') < at('UPSERT_SQL'), '取旧值必须写在 upsert **之前**');
  assert.ok(at('UPSERT_SQL') < at('AUDIT_SQL'), '审计必须与写设置在同一事务里、且在写之后（previous 要有值）');
  assert.ok(at('AUDIT_SQL') < at("'COMMIT'"), '审计必须在 COMMIT **之前**（M-3：挪到事务外就是那个窗口）');
  assert.ok(at("'COMMIT'") < at("'ROLLBACK'"), 'ROLLBACK 只能在 catch 分支里（成功路径不许回滚）');
  assert.match(body, /client\.release\(\)/, 'client 必须在 finally 里 release（审计失败不许泄连接）');

  // 三条语句本身的形状。
  const prevSql = /const PREVIOUS_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  assert.match(prevSql, /FROM upload_settings WHERE id = 1 FOR UPDATE/, '旧值必须靠单独一条 FOR UPDATE 取');
  assert.doesNotMatch(prevSql, /INSERT INTO/, '拿旧值那条必须**单独一条**（不许嵌着写）');
  const upsertSql = /const UPSERT_SQL = `([\s\S]*?)`;/.exec(src)?.[1] ?? '';
  assert.ok(upsertSql, '必须能读到 UPSERT_SQL 原文');
  assert.match(upsertSql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(upsertSql, /RETURNING/);
  assert.doesNotMatch(upsertSql, /\bFOR UPDATE\b/, 'FOR UPDATE 不许挪进 upsert（#698 第一轮：恒 500）');
  assert.doesNotMatch(src, /\bSAVE_SQL\b|prev_eff/, '旧版那条单语句 CTE 必须整条删除（不许留半具尸体）');
});
