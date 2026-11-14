// issue #502 的**真库**形状闸与体积闸（一次性 postgres:16.15，docs/testing.md §2.2.1）。
//
// 环境门（口径逐字照抄 `portal/test/migrate-fresh-db.test.js` 的头注释）：
//   有 PG：
//     sg docker -c "docker run -d --rm -p 127.0.0.1:15499:5432 -e POSTGRES_USER=station \
//       -e POSTGRES_PASSWORD=test -e POSTGRES_DB=station_test postgres:16.15"
//     TEST_DATABASE_URL=postgres://station:test@127.0.0.1:15499/station_test \
//       node --test portal/test/delta-not-persisted-db.test.js
//   无 PG：`TEST_DATABASE_URL` 未设置 ⇒ **整个文件 skip**（不是假通过：`skip` 会让 rc 里带着它，
//   `# skipped` 计数可查，见本文件末尾那条「skip 形状」自证用例）。
//
// 隔离（§2.2.4）：只连注入的那台，每个用例 `CREATE DATABASE` 自建自删；绝不碰真库 `station-db`。
//
// 为什么这些判据非真库不可：单测里的 fake pool 是**按 SQL 文本裁决**的模拟，它不会因为我忘写
// `RETURNING` 就少一行、不会因为 partial unique 索引没建就让我把两行都收下、更不会在我把
// `allocSeq` 留在碎片分支里时把 `last_seq` 真的推到 80 万。判据 1 的「行数与 delta 条数无关」
// 与 #502 的「体积真的掉下来了」只有在真库上才是事实。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashToken } from '../src/auth.js';
import { claimRun, setRunState, postEvents } from '../src/internal.js';
import { partialOutputs } from '../src/run-partial-buffer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '../../deploy/migrations/0033-delta-events-not-persisted.sql');
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const SKIP = URL_VALUE
  ? false
  : 'TEST_DATABASE_URL 未设置：真库用例需一次性 postgres:16.15（docs/testing.md §2.2.1），无 PG 时整体跳过';
const adminPool = URL_VALUE ? createPool(URL_VALUE, { max: 2 }) : null;

const TOKEN = 'tok-502-runner';
const suffix = () => crypto.randomBytes(4).toString('hex');

async function withFreshDb(fn) {
  const name = `w502_${suffix()}`;
  await adminPool.query(`CREATE DATABASE ${name}`);
  const u = new URL(URL_VALUE);
  u.pathname = `/${name}`;
  const url = u.toString();
  const pool = createPool(url, { max: 2 });
  try {
    // baseline(schema.sql) → bootstrap.sql → 全部增量（含 0033）。迁移身份/属主那颗雷由
    // `migrate-fresh-db.test.js` 负责，这里只保证「表结构是今天的真形状」。
    await migrate(pool, { env: { DATABASE_URL: url }, log: { log: () => {} } });
    return await fn(pool, name);
  } finally {
    await pool.end().catch(() => {});
    await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  }
}

/**
 * 一套真库里可认领的现场（用户 / 目录 / 容器 / 会话 / run / 队列）。
 * 必填集合从 `docs/data/schema.sql` **现查**（不是凭印象）：
 *   `users` 只有 `login` 必填；`projects` 要 `user_id/name/repo_url/root_path/slot`
 *   （`name` 有 `^[a-z0-9][a-z0-9-]*$` 的 CHECK ⇒ tag 必须先 lowercase）；
 *   `containers` 要 `user_id/runner_token_hash/image/agent_version`；
 *   `chat_sessions` 要 `user_id/project_id`；`run_queue` 要 `run_id/container_id`。
 * id 全部 uuid（`ids()` 的注释里记着第一版栽的跟头）。
 */
async function seedRunScene(pool, scene) {
  await pool.query(
    `INSERT INTO users (id, login, password_hash, status) VALUES ($1, $2, 'x', 'active')`,
    [scene.userId, scene.login],
  );
  await pool.query(
    `INSERT INTO projects (id, user_id, name, repo_url, root_path, slot)
     VALUES ($1, $2, $3, 'git@x:y/z.git', $4, 0)`,
    [scene.projectId, scene.userId, `p${scene.login}`, '~/projects/x'],
  );
  await pool.query(
    `INSERT INTO containers (id, user_id, runner_token_hash, image, agent_version, status, fde_name, container_name)
     VALUES ($1, $2, $3, 'img', '0.32.0', 'running', $4, $5)`,
    [scene.containerId, scene.userId, hashToken(TOKEN), scene.login, `fde-${scene.login}`],
  );
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, project_id, title, model, cwd, status)
     VALUES ($1, $2, $3, 't', 'mock-model', '~/projects/x', 'active')`,
    [scene.sessionId, scene.userId, scene.projectId],
  );
  await pool.query(`INSERT INTO runs (id, session_id, status) VALUES ($1, $2, 'queued')`, [scene.runId, scene.sessionId]);
  await pool.query(
    `INSERT INTO run_queue (run_id, container_id, status, attempts, max_attempts)
     VALUES ($1, $2, 'pending', 0, 3)`, [scene.runId, scene.containerId],
  );
  return {
    container: { id: scene.containerId, user_id: scene.userId },
    user: { id: scene.userId, login: scene.login },
  };
}

// 全部 id 都是 uuid（`docs/data/schema.sql` 里 users/containers/projects/chat_sessions/runs/run_queue
// 的主外键一律 `uuid DEFAULT gen_random_uuid()`）⇒ **不能拿人类可读的串当 id**：第一版就栽在这里
//（症状是 `inconsistent types deduced for parameter $1` 与 `invalid input syntax for type uuid`，
// 都出在 seed 里、与被测逻辑无关 ⇒ 看到这两种报错先查 seed，别去怀疑产品代码）。
// `login` 才是 text，且 `projects.name` 带 `^[a-z0-9][a-z0-9-]*$` 的 CHECK ⇒ tag 只能留小写字母数字。
const ids = (tag) => ({
  userId: crypto.randomUUID(), projectId: crypto.randomUUID(), sessionId: crypto.randomUUID(),
  runId: crypto.randomUUID(), containerId: crypto.randomUUID(),
  login: `a${tag.toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 30),
});

async function claimAndStart(pool, scene) {
  const { container, user } = await seedRunScene(pool, scene);
  const ticket = await claimRun(pool, {
    container, user, capacity: 1, holdMs: 10,
  });
  await setRunState(pool, { container, user, runId: scene.runId, claimToken: ticket.claim_token, body: { state: 'running' } });
  return { container, user, claimToken: ticket.claim_token };
}

/**
 * 形状闸的驱动：喂 `rounds` 轮、每轮 `deltasPerRound` 条碎片的真实 U3 流量（分批 ≤ 200 条同真机），
 * 再报终态。返回该 run 在 `run_events` 里的行数与类型分布。
 */
async function driveRun(pool, scene, live, { rounds, deltasPerRound }) {
  let n = 0;
  const events = [];
  for (let round = 1; round <= rounds; round += 1) {
    events.push({ client_event_id: `${scene.runId}:1:${n++}`, type: 'round_start', payload: { round } });
    for (let i = 0; i < deltasPerRound; i += 1) {
      events.push({ client_event_id: `${scene.runId}:1:${n++}`, type: 'assistant_delta', payload: { text: `片段${i}` } });
    }
    events.push({ client_event_id: `${scene.runId}:1:${n++}`, type: 'tool_use', payload: { tool_call_id: `c${round}`, round, name: 'readFile', input: { path: 'a' } } });
    events.push({ client_event_id: `${scene.runId}:1:${n++}`, type: 'tool_result', payload: { tool_call_id: `c${round}`, ok: true, result_digest: 'ok', duration_ms: 5 } });
    events.push({ client_event_id: `${scene.runId}:1:${n++}`, type: 'round_end', payload: { round, text: 'r' } });
  }
  for (let i = 0; i < events.length; i += 200) {
    await postEvents(pool, {
      ...live, runId: scene.runId,
      body: { batch_id: `b${i}`, events: events.slice(i, i + 200) },
    });
  }
  // 终态且 `final_text` 为空 ⇒ 无 assistant 锚点（判据 3 的形状）
  await setRunState(pool, {
    ...live, runId: scene.runId,
    body: { state: 'failed', termination: { reason: 'aborted' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds, final_text: '' },
  });
  const rows = await pool.query(
    `SELECT type, count(*)::int AS n FROM run_events WHERE run_id = $1 GROUP BY type`, [scene.runId],
  );
  const per = Object.fromEntries(rows.rows.map((r) => [r.type, r.n]));
  const total = rows.rows.reduce((a, r) => a + r.n, 0);
  return { total, per };
}

// ---------------------------------------------------------------------------
// 判据 1（真库形状闸）：行数 = f(轮数)，与喂入的 delta 条数**无关**
// ---------------------------------------------------------------------------

const ROWS_PER_ROUND = 8; // 每轮事实档上界（本夹具每轮实际 4 行，留一倍余量给 usage/judge 这类合法行）
// run 级常数：形态 M 之后**只剩 `run_end` 一行**（上一版还会多一行 `partial_output`；终态那半截
// 正文现在是它的 payload 键 ⇒ 常数从 2 降到 1。这是本单在「行数」这条闸上的**净删**证据）。
const ROWS_BASELINE = 1;

test('#502 判据 1 真库形状闸：喂 10 条与 1000 条 delta 的 run，落库行数**完全相同**', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    partialOutputs.clear();
    const a = ids('shape10');
    const liveA = await claimAndStart(pool, a);
    const ten = await driveRun(pool, a, liveA, { rounds: 3, deltasPerRound: 10 });

    partialOutputs.clear();
    const b = ids('shape1000');
    const liveB = await claimAndStart(pool, b);
    const thousand = await driveRun(pool, b, liveB, { rounds: 3, deltasPerRound: 1000 });

    // **等式**，不是「少了很多」：判据 1 的改写口径就是这个等式。
    assert.equal(ten.total, thousand.total,
      `行数必须与 delta 条数无关：10 条 = ${ten.total} 行 / 1000 条 = ${thousand.total} 行`);
    // 常数上界：行数 ≤ 轮数 × 每轮上界 + run 级常数（1 = 只有 run_end）
    for (const [label, got] of [['10 条', ten], ['1000 条', thousand]]) {
      assert.ok(got.total <= 3 * ROWS_PER_ROUND + ROWS_BASELINE,
        `${label}：${got.total} 行超出上界 ${3 * ROWS_PER_ROUND + ROWS_BASELINE}（轮数 × ${ROWS_PER_ROUND} + ${ROWS_BASELINE}）`);
    }
    // 碎片一类都没有（真库面证据，不是 fake 的证据）
    for (const t of ['assistant_delta', 'reasoning_delta', 'tool_call_delta']) {
      assert.equal(thousand.per[t] ?? 0, 0, `${t} 在真库里仍被写入：${JSON.stringify(thousand.per)}`);
    }
    // 形态 M：**一类新行都没有**。上一版这里会多一条 `partial_output: 1`（新的读侧合成来源），
    // 现在终态正文并进既有的那一行 `run_end` ⇒ 类型集合里没有本站新增的东西（本单零新事件类型）。
    assert.deepEqual(thousand.per, {
      round_start: 3, tool_use: 3, tool_result: 3, round_end: 3, run_end: 1,
    }, '落库类型集合必须只含引擎既有的事实档类型（partial_output 这类本站自造行不得出现）');
    // 会话水位线与落库行数一致（碎片不 allocSeq）
    const s = await pool.query(`SELECT last_seq FROM chat_sessions WHERE id = $1`, [b.sessionId]);
    assert.ok(Number(s.rows[0].last_seq) <= 3 * ROWS_PER_ROUND + ROWS_BASELINE + 4,
      `last_seq 也必须是 f(轮数)：${s.rows[0].last_seq}`);
  });
});

// ---------------------------------------------------------------------------
// 判据 3 + 迁移：终态正文落在既有 `run_end` 行的 payload 上（零新行、零新索引）
// ---------------------------------------------------------------------------

test('#502 判据 3 真库：终态无锚点 ⇒ 半截正文并进那一行 run_end 的 payload（无新行、无新索引）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    partialOutputs.clear();
    const scene = ids('anchor');
    const live = await claimAndStart(pool, scene);
    await postEvents(pool, {
      ...live, runId: scene.runId,
      body: { batch_id: 'b1', events: [
        { client_event_id: `${scene.runId}:1:0`, type: 'round_start', payload: { round: 1 } },
        { client_event_id: `${scene.runId}:1:1`, type: 'assistant_delta', payload: { text: '说到一半' } },
      ] },
    });
    await setRunState(pool, {
      ...live, runId: scene.runId,
      body: { state: 'failed', termination: { reason: 'aborted' }, rounds: 1, final_text: '' },
    });

    // 形态 M 的落点：**既有**那一行 `run_end` 的 payload（同一次 INSERT ⇒ 不存在「run 已终态但
    // 正文还没写」的窗口；上一版是紧接着再 INSERT 一行 `partial_output`，本用例改写后断的是键而不是行）。
    const rows = await pool.query(
      `SELECT seq, type, client_event_id, payload FROM run_events WHERE run_id = $1 ORDER BY seq`,
      [scene.runId],
    );
    const types = rows.rows.map((r) => r.type);
    assert.equal(types.filter((t) => t === 'run_end').length, 1, '一个 run 恰一条 run_end（既有 run_events_run_end_key 的口径不变）');
    assert.equal(types.includes('partial_output'), false, `形态 M 不再写那种行：${types.join(',')}`);
    assert.equal(types[types.length - 1], 'run_end', 'run_end 仍是该 run 的最后一条（历史里正文排在分隔条之前）');
    const end = rows.rows.find((r) => r.type === 'run_end');
    assert.equal(end.client_event_id, `${scene.runId}:final:run_end`, '幂等键不变（additive 只加 payload 键）');
    assert.equal(end.payload.partial_text, '说到一半', '刷新后这段必须还在（#278/#300 的红线，现在由这个键承重）');
    assert.equal(Number(end.payload.partial_round), 1);
    assert.equal(end.payload.termination.reason, 'aborted', '既有键不受影响');

    // 本单**不新增任何索引**（形态 M 删掉了 `run_events_run_partial_key`）：
    // 「一个 run 至多一条 run_end」本来就有库面约束，不需要第二条部分索引说同一句话。
    const idx = await pool.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'run_events_run_partial_key'`,
    );
    assert.equal(idx.rows[0].n, 0, 'partial_output 唯一索引不得存在（它保护的是一种已经不再写入的行）');
    const runEndIdx = await pool.query(
      `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'run_events_run_end_key'`,
    );
    assert.equal(runEndIdx.rows[0].n, 1, '既有的 run_end 唯一键仍在（这才是「至多一条」的兜底）');

    // 反向证据：同 run 再插一条 run_end 会被**既有**唯一键顶回来（23505）—— 说明形态 M 把
    // 「至多一行」这件事完全交给既有约束，而不是新造一条。
    await assert.rejects(
      pool.query(
        `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload)
         VALUES ($1, $2, $3, $4, 'run_end', '{}'::jsonb)`,
        [scene.runId, scene.sessionId, 99999, `${scene.runId}:final:run_end:dup`],
      ),
      (e) => e.code === '23505' && /run_events_run_end_key/.test(String(e.message)),
      '第二条 run_end 必须被既有唯一键顶回来（23505）',
    );
  });
});

// ---------------------------------------------------------------------------
// 迁移 ② + 体积闸：清存量可重放 / 分批 / 锁窗口有界；VACUUM 前后的体积下降差值
// ---------------------------------------------------------------------------

test('#502 迁移 0033：分批清存量可重放（第二遍 0 行 rc=0）、锁窗口有界、VACUUM 不能进迁移文件', { skip: SKIP }, async () => {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  assert.match(sql, /SET LOCAL lock_timeout/, '锁窗口必须有界（拿不到锁就放弃，可重放）');
  assert.match(sql, /FOR UPDATE SKIP LOCKED/, '每批只锁自己要删的行');
  assert.match(sql, /LIMIT v_batch|LIMIT 5000/, '必须是分批，不是一枪删 87 万行');
  // 形态 M：观测段用 **EXCEPTION** 而不是 WARNING —— 带着残留记成功，等于把「没清干净」吞掉
  // （`schema_migrations` 会落下已应用，而表里还躺着几十万行）。见迁移文件里那段的注释。
  assert.match(sql, /RAISE EXCEPTION '0033: 清完之后仍量到/, '残留碎片的观测必须让迁移失败（不许 WARNING 蒙过）');
  assert.equal(/RAISE WARNING/.test(sql), false, '本文件没有任何「报告但继续」的观测：有残留就该失败');
  // 编号笔误（原文件写的是 '0032/0033'）：迁移应用后 NOTICE 文案不可再改，所以在落库前钉住
  assert.equal(/0032\/0033/.test(sql), false, '进度/结论 NOTICE 的编号必须只写 0033');
  // 零 DDL：本支迁移不得出现任何索引/列/表的 DDL（形态 M 的硬口径）。
  // ⚠ 只看**去掉整行注释之后**的语句区：头注释里会解释「为什么删掉了那条 CREATE UNIQUE INDEX」，
  //   整文件正则必先命中注释 ⇒ 断言恒红（这不是放宽：migrations.test.js 里同一条用同一套剥离）。
  const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.equal(/\bCREATE\b/i.test(executable), false, '形态 M 的 0033 是纯清理，语句区不该有 CREATE');
  assert.equal(/\bDROP\b/i.test(executable), false, '也不该有 DROP（B/C 两个索引议题本单表态保留）');
  assert.equal(/\bALTER\b/i.test(executable), false, '也不该有 ALTER（零新列、零新类型）');
  assert.equal(/^\s*VACUUM/im.test(sql), false, 'VACUUM 不得出现在迁移文件里（迁移 runner 是单事务，VACUUM 不能在事务块里跑）');

  await withFreshDb(async (pool, dbName) => {
    // 造一份「delta 不落库之前」的存量：5 万条碎片 + 少量事实档，载荷尺寸照真库量级（≈ 560 B/行）。
    await pool.query(`BEGIN`);
    // id 必须是 uuid（见 `ids()` 的注释）⇒ 借一套真实现场挂 legacy 碎片，而不是造字符串 id。
    const scene = ids('legacy');
    await seedRunScene(pool, scene);
    await pool.query(
      `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload)
       SELECT $1::uuid, $2::uuid, gs, 'x' || gs,
              CASE gs % 3 WHEN 0 THEN 'assistant_delta' WHEN 1 THEN 'reasoning_delta' ELSE 'tool_call_delta' END,
              jsonb_build_object('text', repeat('x', 200))
         FROM generate_series(1, 50000) gs`,
      [scene.runId, scene.sessionId],
    );

    // 用**独立事务**重放迁移文件（照 runner 的口径：BEGIN → 执行 → COMMIT）。
    const applyOnce = async () => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(sql);
        await c.query('COMMIT');
        return 0;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
    const before = await pool.query(`SELECT count(*)::int AS n FROM run_events`);
    assert.equal(before.rows[0].n, 50000);
    const idxBefore = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'run_events' ORDER BY indexname`,
    );
    await applyOnce();
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM run_events WHERE type IN ('assistant_delta','reasoning_delta','tool_call_delta')`,
    );
    assert.equal(after.rows[0].n, 0, '第一遍必须清干净');
    assert.equal(await applyOnce(), 0, '第二遍重放 rc=0');
    // 形态 M：本文件是**纯清理**（零 DDL）⇒ 重放前后索引集合必须**逐字相同**（旧版这里断的是
    // 「partial_output 唯一索引存在」，那一整段 DDL 已删；改成断「一支清理型迁移不该动索引」，
    // 比原断言更强：任何偷偷加/删索引的改动都会红）。
    const idxAfter = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'run_events' ORDER BY indexname`,
    );
    assert.equal(idxAfter.rows.length, idxBefore.rows.length,
      `清理型迁移不得增删索引：前 ${idxBefore.rows.length} 个 / 后 ${idxAfter.rows.length} 个`);
    assert.deepEqual(idxAfter.rows.map((r) => r.indexname), idxBefore.rows.map((r) => r.indexname));
    assert.equal(idxAfter.rows.some((r) => r.indexname === 'run_events_run_partial_key'), false,
      '形态 M 不再建那条 partial_output 唯一索引');

    // VACUUM **不能跑在事务块里**：这就是它不进迁移文件的直接证据（迁移 runner 单事务）。
    const c2 = await pool.connect();
    await c2.query('BEGIN');
    await assert.rejects(c2.query('VACUUM run_events'), (e) => /cannot run inside a transaction/i.test(String(e.message)));
    await c2.query('ROLLBACK').catch(() => {});
    c2.release();

    // VACUUM 之后磁盘才真的回收（`pg_total_relation_size` 掉下来）。这是「清存量 + VACUUM」的差值面。
    const pre = await pool.query(`SELECT pg_total_relation_size('run_events') AS sz`);
    await pool.query('VACUUM (FULL, ANALYZE) run_events'); // FULL：截断文件（普通 VACUUM 只回收页，文件不缩）
    const post = await pool.query(`SELECT pg_total_relation_size('run_events') AS sz`);
    const preSz = Number(pre.rows[0].sz);
    const postSz = Number(post.rows[0].sz);
    assert.ok(postSz < preSz, `VACUUM FULL 之后表体必须变小：${preSz} → ${postSz}`);
    assert.ok(preSz - postSz > preSz * 0.5,
      `清掉 5 万行之后必须掉一半以上（这是「体积真回收了」而不是「行没了但文件没动」）：${preSz} → ${postSz}`);
    void dbName;
  });
});

test('#502 体积闸：清理后 `run_events` / `run_checkpoints` 各自的每行字节上界 + 碎片占比 < 5 %', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    // 先造一份**清理之后**的真实形状（空库量出来的每行字节是页常数，什么都不是；行数太少时
    // 每行字节由 5 个索引的页粒度决定 ⇒ 必须喂够行数再量，这条上界才有意义）。
    // 载荷尺寸照 dev 真库的量级：每行 ≈ 560 B（事实档行本来就比碎片行大一个数量级）。
    // `run_events.run_id/session_id` 都是外键 ⇒ 必须挂在一对真实 run/session 上（`run_events_run_id_fkey`）。
    const volScene = ids('volume');
    await seedRunScene(pool, volScene);
    await pool.query(
      `INSERT INTO run_events (run_id, session_id, seq, client_event_id, type, payload)
       SELECT $1::uuid, $2::uuid, 1000 + gs, 'vol-' || gs,
              CASE gs % 4 WHEN 0 THEN 'tool_use' WHEN 1 THEN 'tool_result'
                          WHEN 2 THEN 'round_start' ELSE 'round_end' END,
              jsonb_build_object('text', repeat('x', 400))
         FROM generate_series(1, 5000) gs`,
      [volScene.runId, volScene.sessionId],
    );
    // run_events：清理后只剩事实档 + 那一行（每轮几行、每行都是「有内容的事实」）。
    const ev = await pool.query(
      `SELECT count(*)::int AS n, pg_total_relation_size('run_events') AS sz,
              count(*) FILTER (WHERE type IN ('assistant_delta','reasoning_delta','tool_call_delta'))::int AS delta_n
         FROM run_events`,
    );
    const n = ev.rows[0].n;
    const bytes = Number(ev.rows[0].sz);
    assert.equal(ev.rows[0].delta_n, 0, '碎片占比必须是 0（< 5 % 的下界）');
    // 空表时 `pg_total_relation_size` 是几个页的常数（≈ 80 KB 级）⇒ 每行字节只在真有行时有意义。
    if (n > 0) {
      assert.ok(bytes / n < 4096, `清理后每行字节上界破了：${Math.round(bytes / n)} B/行（${n} 行 / ${bytes} B）`);
    }
    // run_checkpoints：本单不动它（清它属于 issue 里另开的账），但给出上界并说明来历 ——
    // 它的每行体积是「整份引擎 run state」，dev 实测 85 行 / 4,644,864 B ≈ 53 KB/行。
    const cp = await pool.query(
      `SELECT count(*)::int AS n, pg_total_relation_size('run_checkpoints') AS sz FROM run_checkpoints`,
    );
    const cn = cp.rows[0].n;
    const cb = Number(cp.rows[0].sz);
    if (cn > 0) {
      assert.ok(cb / cn < 512 * 1024, `run_checkpoints 每行字节上界破了：${Math.round(cb / cn)} B/行`);
    }
    assert.ok(cb >= 0, '两张表都要各自给出读数（体积闸不许只量一张）');
  });
});

test('#502 环境门自证：没有 TEST_DATABASE_URL 时上面四条都是 skip 而不是假通过', () => {
  // 这条**不加 skip**：它在两种环境下都必须跑，且它断言的是「门是否存在」。
  const guarded = [
    '#502 判据 1 真库形状闸：喂 10 条与 1000 条 delta 的 run，落库行数**完全相同**',
    '#502 判据 3 真库：终态无锚点 ⇒ 同事务恰一行 partial_output，seq 排在 run_end 之后，唯一索引挡住第二行',
    '#502 迁移 0033：分批清存量可重放（第二遍 0 行 rc=0）、锁窗口有界、VACUUM 不能进迁移文件',
    '#502 体积闸：清理后 `run_events` / `run_checkpoints` 各自的每行字节上界 + 碎片占比 < 5 %',
  ];
  assert.equal(guarded.length, 4);
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '没有 PG 时必须走 skip（消息里写清怎么起一次性实例）');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则真库用例被静默跳过 = 假通过）');
  }
});
