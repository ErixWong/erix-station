// 迁移 0034 的**真库**用例（issue #502 的遗留账：`run_checkpoints` 里永不再读的快照）。
//
// 环境门（口径照 `portal/test/delta-not-persisted-db.test.js`）：`TEST_DATABASE_URL` 未设置 ⇒ **整文件 skip**
// （不是假通过：末尾那条「环境门自证」用例不设 skip，它专门检查门是否存在）。起一次性实例：
//   docker run -d --rm -p 127.0.0.1:15505:5432 -e POSTGRES_USER=station -e POSTGRES_PASSWORD=test \
//     -e POSTGRES_DB=station_test -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16.15
//   TEST_DATABASE_URL=postgres://station:test@127.0.0.1:15505/station_test \
//     node --test 'portal/test/prune-checkpoints-db.test.js'
//
// 隔离（docs/testing.md §2.2.4）：只连注入的那台，每个用例在夹具里 `CREATE DATABASE` 自建自删；
// 绝不碰真库 `station-db`。夹具用**共享的那一份** `pg-fixture.js`（不再抄一份 —— 两份夹具各自跑
// `bootstrap.sql` 的集群级角色 DDL 会撞 `tuple concurrently updated`，理由全在那个字头注释里）。
//
// 为什么必须真库：本单的判据全是「PG 会不会按我以为的方式评估这两条谓词」——
//   ① `transcript_key::uuid` 的显式转换（`chat_sessions.id` 是 uuid、`transcript_key` 是 text，
//      不转换是 `operator does not exist: uuid = text`，本站实测踩过；fake pool 不会告诉你这件事）；
//   ② `transcript_key IS NULL` 这一支为什么不能省（session 行的 `run_id` 也是**真 run**，
//      那个 run 通常也早终态 ⇒ 少这个条件就会把活跃会话的快照一起删）；
//   ③ `v_cutoff` 让「迁移期间被并发写脏的行」既不被删、也不被末尾残留检查误判成残留；
//   ④ 第二遍重放 0 行且 rc=0（可重放性只能靠真跑两遍证明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '../../deploy/migrations/0034-prune-stale-run-checkpoints.sql');
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;

// `w502c_` 前缀：排障时 `\l` 一眼能认出是这个文件的库（与 0033 的 `w502_` 区分开）。
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w502c' }) : null;

/** 夹具包一层：用例体只拿 pool。`withFreshDatabase` 会跑完整链（baseline → bootstrap → 全部增量，含 0034）。 */
const withFreshDb = (fn, opts = {}) => fixture.withFreshDatabase(({ pool }) => fn(pool), {
  poolMax: 2, // 并发那一条用例要 3 条连接（持锁者 + 迁移自己），它自己传 opts 抬
  log: () => {}, // 迁移日志静音
  ...opts,
});

const uuid = () => crypto.randomUUID();

/**
 * 一套能挂 `run_checkpoints` 的现场（必填集合从 `docs/data/schema.sql` 现查，不是凭印象）：
 *   `users` 只要 `login`；`projects` 要 `user_id/name/repo_url/root_path/slot`
 *   （`name` 有 `^[a-z0-9][a-z0-9-]*$` 的 CHECK ⇒ tag 必须先 lowercase）；
 *   `chat_sessions` 要 `user_id/project_id`（`status` 只有 `active|archived`，有 CHECK）；
 *   `runs` 要 `id/session_id`（`status` CHECK 五值：queued/running/cancelling/finished/failed）；
 *   `run_checkpoints` 的 `run_id` 是 **NOT NULL 主键 + FK**（`\d run_checkpoints` 真库现查）
 *   ⇒ **session 作用域的行也必须挂一个真 run**（它存的是写这条快照的 writer run，见
 *   `portal/src/internal.js:1717`），这正是本单最容易删错的地方。
 */
async function seedScene(pool, tag) {
  const s = {
    userId: uuid(), projectId: uuid(),
    login: `a${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
  };
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
    [s.userId, s.login],
  );
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1, $2, $3, 'git@x:y/z.git', '~/projects/x', 0)`,
    [s.projectId, s.userId, `p${s.login}`],
  );
  return s;
}

/** 建一个会话（可控 status 与「多少天没动」）；`idleDays` 直接写 `updated_at`。 */
async function seedSession(pool, s, { idleDays = 0, status = 'active' } = {}) {
  const sessionId = uuid();
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, status, updated_at)
     VALUES ($1, $2, $3, 't', $4, now() - ($5::int * interval '1 day'))`,
    [sessionId, s.userId, s.projectId, status, idleDays],
  );
  return sessionId;
}

/**
 * 建一个 run（可控 status），挂在给定会话上。
 * ⚠ 真库里有一条 `runs_one_active_per_session` 的部分唯一索引（本单现验）：**一个会话至多一个非终态 run**
 *   ⇒ 要同时摆 `running` 与 `cancelling` 两枚「未终态」的 run，必须**各自一个会话**，否则 seed 自己先 23505。
 */
async function seedRun(pool, sessionId, { status = 'finished' } = {}) {
  const runId = uuid();
  await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1, $2, $3)`, [runId, sessionId, status]);
  return runId;
}

/**
 * 写一行快照。`ageHours` 控制 `updated_at`（负数 = 未来，用来冒充「截止时刻之后才被并发 writer 写的行」）；
 * `key` 不给 ⇒ `transcript_key IS NULL`（run 作用域）。载荷照真库量级（dev 现查 ~53 KB/行了仍算小）。
 */
async function seedCheckpoint(pool, { runId, key = null, ageHours = 1, bytes = 2048, revision = 7 }) {
  await pool.query(
    `INSERT INTO run_checkpoints (run_id, transcript_key, snapshot, revision, updated_at)
     VALUES ($1::uuid, $2::text,
             jsonb_build_object('revision', $3::bigint, 'blob', repeat('x', $4::int)),
             $3::bigint, now() - ($5::int * interval '1 hour'))`,
    [runId, key, revision, bytes, ageHours],
  );
}

/** 照 runner 的口径重放迁移文件（单事务：BEGIN → 执行 → COMMIT），并收集 NOTICE（可观测面只有 rc 与 NOTICE）。 */
async function applyOnce(pool, sql) {
  const c = await pool.connect();
  const notices = [];
  const onNotice = (m) => notices.push(String(m.message || ''));
  c.on('notice', onNotice);
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
    return { rc: 0, notices };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.removeListener('notice', onNotice);
    c.release();
  }
}

/** 分类读数（断言全部按类目，不按行序碰运气）。 */
async function census(pool) {
  const r = await pool.query(
    `SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) AS by_kind
       FROM (
         SELECT CASE
                  WHEN transcript_key IS NULL THEN 'run_keyed'
                  WHEN transcript_key::uuid IN (SELECT id FROM chat_sessions WHERE status = 'active'
                                                 AND updated_at >= now() - interval '14 days') THEN 'sess_live'
                  ELSE 'sess_dead'
                END AS k, count(*)::int AS n
           FROM run_checkpoints GROUP BY 1
       ) x`,
  );
  return r.rows[0].by_kind;
}

// ---------------------------------------------------------------------------
// 主用例：两条谓词各自的边界 + cutoff + 可重放
// ---------------------------------------------------------------------------

test('#502 迁移 0034 真库：终态 run 的 run 作用域快照被删、活跃会话的快照仍在、第二遍 0 行 rc=0', { skip: SKIP }, async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');

  await withFreshDb(async (pool) => {
    // ---- 0. 完整链跑完之后 0034 已在台账里（夹具自己就把全部增量迁移跑了一遍 ⇒ 这支迁移在空库上必须不炸）
    const led = await pool.query(`SELECT version FROM schema_migrations WHERE version = '0034-prune-stale-run-checkpoints'`);
    assert.equal(led.rows.length, 1, '0034 必须能被完整迁移链应用（夹具跑的就是这条路径）');
    const idxBefore = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'run_checkpoints' ORDER BY indexname`,
    );
    assert.ok(idxBefore.rows.length >= 2, '前置读数：run_checkpoints 的索引集合（主键 + session 部分唯一）');

    const s = await seedScene(pool, 'prune01');

    // ---- (a) 该删：run 作用域 + run 已终态（`finished` 与 `failed` 各一枚）----
    const sessA = await seedSession(pool, s, { idleDays: 0 });            // 活跃会话（但快照是 run 作用域的）
    const runDone = await seedRun(pool, sessA, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runDone, ageHours: 24 });
    const runFail = await seedRun(pool, sessA, { status: 'failed' });
    await seedCheckpoint(pool, { runId: runFail, ageHours: 24 });
    // ---- (a) 不该删：run 还没终态（`running` / `cancelling` 都不是终态，见 internal.js:249 isTerminal）
    //      ⇒ 各自一个会话（`runs_one_active_per_session`，见 seedRun 注释）
    const sessRunning = await seedSession(pool, s, { idleDays: 0 });
    const runLive = await seedRun(pool, sessRunning, { status: 'running' });
    await seedCheckpoint(pool, { runId: runLive, ageHours: 24 });
    const sessCancelling = await seedSession(pool, s, { idleDays: 0 });
    const runCancelling = await seedRun(pool, sessCancelling, { status: 'cancelling' });
    await seedCheckpoint(pool, { runId: runCancelling, ageHours: 24 });

    // ---- (b) 该删：会话已归档（status 那一支）----
    const sessArch = await seedSession(pool, s, { status: 'archived', idleDays: 0 });
    const runArchWriter = await seedRun(pool, sessArch, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runArchWriter, key: sessArch, ageHours: 24 });
    // ---- (b) 该删：会话仍 active 但 30 天没动（>14 天那一支）----
    const sessIdle = await seedSession(pool, s, { status: 'active', idleDays: 30 });
    const runIdleWriter = await seedRun(pool, sessIdle, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runIdleWriter, key: sessIdle, ageHours: 24 });
    // ---- **必须留**：活跃会话 + 每个 key 那一行；而且写它的那个 run **早已终态**
    //      ⇒ 这一枚同时钉住「(a) 少了 `transcript_key IS NULL` 就会误删活跃会话的快照」
    //      （就挂在 sessA 上：它已经携带了 (a) 的那几枚 run 作用域快照，两形并存才是真库的形状）
    const runLiveWriter = await seedRun(pool, sessA, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runLiveWriter, key: sessA, ageHours: 24 });
    // ---- **必须留**：`updated_at` 在截止时刻之后（负 age = 未来）的行
    //      = 「迁移期间被并发 writer 写了一笔」的形状：既不删，也不许被末尾残留检查当成残留
    const runFuture = await seedRun(pool, sessA, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runFuture, ageHours: -1 });
    // ---- **必须留**：孤儿 session 行（key 是合法 uuid 但会话不存在）——谓词 (b) 用 `IN`，孤儿不命中；
    //      dev 现查 87 行**无孤儿**，本单不扩大范围去清它（要清得另开一支迁移）
    const runOrphan = await seedRun(pool, sessA, { status: 'finished' });
    await seedCheckpoint(pool, { runId: runOrphan, key: uuid(), ageHours: 24 });

    assert.deepEqual(await census(pool), { run_keyed: 5, sess_live: 1, sess_dead: 3 },
      '前置状态：9 行快照（5 run 作用域 / 1 活跃会话 / 3 包活会话与孤儿 key）');

    // ---- 第一遍：清掉该清的，留下该留的 ----
    const pass1 = await applyOnce(pool, sql);
    assert.equal(pass1.rc, 0, '第一遍 rc=0');
    // 删了多少行要能从 NOTICE 里读到（迁移的可观测面只有 rc 与 NOTICE）：
    // (a) = 两枚终态 run 的 run 作用域快照（`runFuture` 被 cutoff 豁免），(b) = 归档 + 超龄各一枚。
    assert.ok(pass1.notices.some((m) => /0034: 清掉 run_checkpoints \(a\) run 作用域 2 行 \+ \(b\) 死会话 session 作用域 2 行/.test(m)),
      `NOTICE 必须报「(a) 2 行 + (b) 2 行」：${JSON.stringify(pass1.notices)}`);
    const keep = await pool.query(
      `SELECT coalesce(array_agg(run_id::text ORDER BY run_id::text), '{}') AS ids FROM run_checkpoints`,
    );
    assert.deepEqual(keep.rows[0].ids,
      [runCancelling, runFuture, runLive, runLiveWriter, runOrphan].sort(),
      `留下的必须正好是「未终态 run / 活跃会话 / cutoff 之后 / 孤儿」这四类：${JSON.stringify(keep.rows[0].ids)}`);
    assert.deepEqual(await census(pool), { run_keyed: 3, sess_live: 1, sess_dead: 1 },
      'cutoff 之后写的那一行在 census 里仍算 run_keyed（它没有被删，这是设计而不是漏清）');

    // ---- 只删行：别的表一根毫毛都没动（本单零 DDL、零跨表清理）----
    for (const t of ['runs', 'chat_sessions', 'users', 'projects']) {
      assert.ok((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n > 0,
        `${t} 里种子行必须还在（0034 只删 run_checkpoints 的行）`);
    }
    const terminalRunsAfter = await pool.query(
      `SELECT count(*)::int AS n FROM runs WHERE status IN ('finished','failed')`,
    );
    assert.equal(terminalRunsAfter.rows[0].n, 7,
      '终态 run 一行都没少（本场景一共 7 枚 finished/failed；删的是快照行，不是 run——run 表的历史归 issue #502 的另账）');

    // ---- 第二遍重放：0 行、rc=0、NOTICE 说「没有可清」 ----
    const pass2 = await applyOnce(pool, sql);
    assert.equal(pass2.rc, 0, '第二遍 rc=0');
    assert.ok(pass2.notices.some((m) => /0034: 没有可清的快照行/.test(m)),
      `第二遍必须把「0 行」打在 NOTICE 上（可重放的**可观测**证据）：${JSON.stringify(pass2.notices)}`);
    const keep2 = await pool.query(
      `SELECT coalesce(array_agg(run_id::text ORDER BY run_id::text), '{}') AS ids FROM run_checkpoints`,
    );
    assert.deepEqual(keep2.rows[0].ids, keep.rows[0].ids, '第二遍一行都没多删（cutoff 之后的行仍然豁免）');

    // ---- 零 DDL：重放前后索引集合逐字相同（任何偷偷加/删索引的改动都会在这里红）----
    const idxAfter = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'run_checkpoints' ORDER BY indexname`,
    );
    assert.deepEqual(idxAfter.rows.map((r) => r.indexname), idxBefore.rows.map((r) => r.indexname),
      '清理型迁移不得增删索引');
    assert.ok(idxAfter.rows.some((r) => r.indexname === 'run_checkpoints_session_uidx'),
      '0006 那条 session 部分唯一索引必须还在（`putSessionCheckpoint` 的 ON CONFLICT 目标靠它）');
    assert.ok(idxAfter.rows.some((r) => r.indexname === 'run_checkpoints_pkey'), '主键还在');

    // ---- `VACUUM` 不进迁移文件的直接证据：它在事务块里必炸（迁移 runner 就是单事务）----
    const c2 = await pool.connect();
    await c2.query('BEGIN');
    await assert.rejects(c2.query('VACUUM run_checkpoints'),
      (e) => /cannot run inside a transaction/i.test(String(e.message)),
      'VACUUM 在事务块里必须失败（所以它只能在部署侧跑）');
    await c2.query('ROLLBACK').catch(() => {});
    c2.release();

    // ---- 删完只是行没了，磁盘没缩（头注释那条口径的现证：不 VACUUM 就看不到体积掉下来）----
    const sizeAfter = await pool.query(`SELECT pg_total_relation_size('run_checkpoints') AS sz`);
    await pool.query('VACUUM (FULL, ANALYZE) run_checkpoints');
    const sizeVacuumed = await pool.query(`SELECT pg_total_relation_size('run_checkpoints') AS sz`);
    assert.ok(Number(sizeVacuumed.rows[0].sz) <= Number(sizeAfter.rows[0].sz),
      `VACUUM 之后体积必须不增：${sizeAfter.rows[0].sz} → ${sizeVacuumed.rows[0].sz}`);
  });
});

// ---------------------------------------------------------------------------
// 残留检查的那条 EXCEPTION 分支：并发 writer 握着的行（`SKIP LOCKED` 跳过 ⇒ 必须响亮失败）
// ---------------------------------------------------------------------------

test('#502 迁移 0034 真库：有并发 writer 正握着一行 ⇒ 迁移当场失败（EXCEPTION）而不是静默记成功', { skip: SKIP }, async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  // 3 条连接：持锁的伪并发 writer + 迁移自己的那条（夹具的 withFreshDatabase 不占连接）。
  await withFreshDb(async (pool) => {
    const s = await seedScene(pool, 'locked01');
    const sess = await seedSession(pool, s, { idleDays: 0 });
    const runId = await seedRun(pool, sess, { status: 'finished' });
    await seedCheckpoint(pool, { runId, ageHours: 24 });

    // 伪并发 writer：另一条连接上开事务、把这行锁住不放（就是部署时一个正在写 checkpoint 的旧版 portal）。
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM run_checkpoints WHERE run_id = $1 FOR UPDATE`, [runId]);

    // 迁移：`SKIP LOCKED` 把这一行**跳过**（不是排队等锁），末尾残留检查量到它 ⇒ RAISE EXCEPTION。
    // 这条分支就是「为什么必须是 EXCEPTION 而不是 WARNING」的现证：静默记下成功 = 台账落下「已清理」。
    await assert.rejects(applyOnce(pool, sql),
      (e) => /0034: 截止时刻/.test(String(e.message)) && /\(a\) 仍剩 1 行/.test(String(e.message)),
      '被并发改写的行必须让迁移失败（带计数），而不是记一条 WARNING 就 COMMIT');

    const left = await pool.query(`SELECT count(*)::int AS n FROM run_checkpoints`);
    assert.equal(left.rows[0].n, 1, '失败 = 整体回滚：那一行必须还在（runner 不落 schema_migrations，可直接重跑）');

    // 松开锁后重跑 ⇒ 清得掉（失败是可重放的，这就是头注释里那句「重跑本文件即可」）。
    await holder.query('ROLLBACK');
    holder.release();
    const again = await applyOnce(pool, sql);
    assert.equal(again.rc, 0, '并发 writer 松开后重跑 rc=0');
    const cleared = await pool.query(`SELECT count(*)::int AS n FROM run_checkpoints`);
    assert.equal(cleared.rows[0].n, 0, '重跑把那一行清掉了');
  }, { poolMax: 3 });
});

// ---------------------------------------------------------------------------
// 谓词 (b) 的类型事实：`transcript_key` 是 text、`chat_sessions.id` 是 uuid
// ---------------------------------------------------------------------------

test('#502 迁移 0034 真库：不转 uuid 就报 operator does not exist: text = uuid（那个 ::uuid 是必需的）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    const cols = await pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE (table_name = 'run_checkpoints' AND column_name = 'transcript_key')
           OR (table_name = 'chat_sessions' AND column_name = 'id')
        ORDER BY table_name`,
    );
    assert.deepEqual(cols.rows, [
      { table_name: 'chat_sessions', column_name: 'id', data_type: 'uuid' },
      { table_name: 'run_checkpoints', column_name: 'transcript_key', data_type: 'text' },
    ], '两列的类型事实必须核对（谓词里那句 ::uuid 的依据就是这两行）');

    // 不转会当场炸——这就是迁移里必须写 `transcript_key::uuid` 的直接证据。
    // （空表也会报：这是**分析阶段**的错，与表里有没有行无关；仍先插一行免得用例只钉住一个空库形状。）
    const s = await seedScene(pool, 'types01');
    const sess = await seedSession(pool, s, { status: 'archived' });
    const runId = await seedRun(pool, sess, { status: 'finished' });
    await seedCheckpoint(pool, { runId, key: sess, ageHours: 24 });

    await assert.rejects(
      pool.query(
        `SELECT 1 FROM run_checkpoints rc
          WHERE rc.transcript_key IN (SELECT id FROM chat_sessions)`,
      ),
      // 方呴取决于书写顺序：`text IN (uuid…)` 报 `text = uuid`，`uuid IN (text…)` 报 `uuid = text`
      //（两列分属 S/U 两个类型大类，都没有 preferred ⇒ PG 不做隐式转换）。
      // 迁移里写的是前者⇒现查实测消息是 `operator does not exist: text = uuid`。
      (e) => /operator does not exist: (text = uuid|uuid = text)/.test(String(e.message)),
      '不写 ::uuid 的写法必须报 operator does not exist（真库现证，别退回成口头约定）',
    );
  });
});

// ---------------------------------------------------------------------------
// 已知失败模式：非 uuid 形态的 transcript_key 会让 (b) 炸（ loud，不是静默漏清）
// ---------------------------------------------------------------------------

test('#502 迁移 0034 真库：非 uuid 形态的 transcript_key ⇒ 迁移当场失败（响亮，不是静默漏清）', { skip: SKIP }, async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  await withFreshDb(async (pool) => {
    const s = await seedScene(pool, 'badkey01');
    const sess = await seedSession(pool, s, { status: 'archived' });
    const runId = await seedRun(pool, sess, { status: 'finished' });
    // 一条「人类可读」的旧形态 key（本站现在写不进去：`internal.js#fetchSession` 的 `WHERE id = $1`
    // 会把参数推成 uuid，非 uuid 的 key 早在写入时就 22P02 ⇒ 现存值全是 uuid 文本，dev 现查 73 行全对上）。
    await pool.query(
      `INSERT INTO run_checkpoints (run_id, transcript_key, snapshot, revision, updated_at)
       VALUES ($1, 'legacy-not-uuid', '{}'::jsonb, 1, now() - interval '1 hour')`,
      [runId],
    );

    await assert.rejects(applyOnce(pool, sql),
      (e) => /invalid input syntax for type uuid/.test(String(e.message)),
      '非 uuid 的 key 必须让迁移**当场失败**（响亮失败 + 可重放，胜过静默漏清后在台账里落下「已清理」）');
    const left = await pool.query(`SELECT count(*)::int AS n FROM run_checkpoints`);
    assert.equal(left.rows[0].n, 1, '失败即整体回滚：那一行必须还在（迁移 runner 单事务，不落 schema_migrations）');
  });
});

// ---------------------------------------------------------------------------
// 环境门自证：没有 PG 时上面三条是 skip 而不是假通过
// ---------------------------------------------------------------------------

test('#502 环境门自证（0034）：没有 TEST_DATABASE_URL 时真库用例都是 skip', () => {
  // 这条**不加 skip**：它在两种环境下都必须跑，且它断言的是「门是否存在」。
  const guarded = [
    '#502 迁移 0034 真库：终态 run 的 run 作用域快照被删、活跃会话的快照仍在、第二遍 0 行 rc=0',
    '#502 迁移 0034 真库：有并发 writer 正握着一行 ⇒ 迁移当场失败（EXCEPTION）而不是静默记成功',
    '#502 迁移 0034 真库：不转 uuid 就报 operator does not exist: text = uuid（那个 ::uuid 是必需的）',
    '#502 迁移 0034 真库：非 uuid 形态的 transcript_key ⇒ 迁移当场失败（响亮，不是静默漏清）',
  ];
  assert.equal(guarded.length, 4);
  // 名单不许只是装饰：每一条都必须在本文件里**真的存着一个同名的 `test(...)`**
  //（判据是 `test('<名字>'` 而不是「名字出现过」，后者会被名单自己满足 = 恒真）。
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const name of guarded) {
    assert.ok(selfSrc.includes(`test('${name}'`),
      `环境门名单与本文件用例名漂移（本文件里没有这个用例）：${name}`);
  }
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '没有 PG 时必须走 skip（消息里写清怎么起一次性实例）');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则真库用例被静默跳过 = 假通过）');
  }
});
