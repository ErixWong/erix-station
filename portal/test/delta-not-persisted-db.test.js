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

import { hashToken } from '../src/auth.js'; // createPool/migrate 已随夹具搬进 pg-fixture.js
// issue #502 F-1：夹具从本文件**搬进** `pg-fixture.js`（与 `migrate-fresh-db.test.js` 共用一份）。
// 原副本的毛病：两个文件各跑一遍 `bootstrap.sql` 的集群级 `ALTER ROLE`（bootstrap.sql:37-38 写
// `pg_authid` 同一行），而 `migrate.js` 的 advisory lock 作用域带 database OID ⇒ 两个新建库
// 互相看不见 ⇒ `npm test` 带 TEST_DATABASE_URL 并发跑时偶发 `tuple concurrently updated`(XX000)。
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';
import { claimRun, setRunState, postEvents, putCheckpoint } from '../src/internal.js';
import { partialOutputs } from '../src/run-partial-buffer.js';
// issue #502 形态 M 绊线用例要拿 runner 的**真映射**造 `round_end` 载荷（不手抄字段名）。
// `loopEventPayload` 是导出的纯函数（`runner/worker.js:232`，导出理由就写在它的注释里）；
// import worker.js 在 runner/test/*.test.js 里已是常规做法（`usage-event.test.js:13` 等）。
import { loopEventPayload } from '../../runner/worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '../../deploy/migrations/0033-delta-events-not-persisted.sql');
const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
// env 门口径不变：未设 ⇒ 整文件 skip（`SKIP_WITHOUT_PG` 那句话与另一份夹具共用，不再各写一份）。
const SKIP = URL_VALUE ? false : SKIP_WITHOUT_PG;

const TOKEN = 'tok-502-runner';

// `w502_` 前缀保留（排障时 `\l` 一眼能认出是哪个文件的库）；迁移日志静音（原样）。
const fixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w502' }) : null;
const adminPool = fixture ? fixture.adminPool : null;

/** 与旧签名的差异只有「多包一层夹具」：fn(pool, dbName) 原样。 */
const withFreshDb = (fn) => fixture.withFreshDatabase(
  ({ database, pool }) => fn(pool, database),
  { poolMax: 2, log: () => {} }, // baseline → bootstrap → 全部增量（含 0033）
);

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
// 绊线（tripwire）：形态 M 判据 3 的两处 durable 源，**键名与类型**
// ---------------------------------------------------------------------------

/**
 * 这条用例**不测行为，只测「那两个键还在不在」**——它是一根绊线，不是功能验证。
 *
 * 形态 M 判据 3（「停止后界面正文不比停止前少」）的 durable 源只有两处，都挂在 `run_events`
 * **既有**的行上（本单零新事件类型、零新索引）：
 *   ① `type='round_end'` 行的 `payload.final_text` —— **已完成轮次**的正文；
 *   ② `type='run_end'`   行的 `payload.partial_text` —— **停止那半轮**的正文。
 * 读侧 `portal/src/http.js#projectPartialOutputItems` 就只认这两个键（非字符串 ⇒ 当「没给正文」）。
 *
 * ⚠ **①上游契约没钉**（2026-11-14 现查 `node_modules/erix-agent@0.32.0`）：
 *   * `docs/host-consumer-contract.md:6635` —— `round_end` 只在**档位表**里出现，钉的是档位
 *     `fact`，**没有一个字**讲它的 payload 有哪些键；
 *   * `finalText` 只出现在引擎源码 JSDoc（`src/loop/orchestrator.js:489`，而且写作**可选**
 *     `@property {string} [finalText]`）与发出点（`src/loop/orchestrator.js:6459-6464`）
 *     ——**是实现事实，不是契约承诺**。
 *   ⇒ 上游哪天改名（`finalText`→`text`）或瘦身（空轮不写键 / payload 换成 `{ round }`），本站会
 *     **静默退化**：引擎不报错、`postEvents` 照单全收（payload 是原样 `JSON.stringify` 落库的）、
 *     库里那一行照样在，只是读侧 `typeof p.final_text === 'string'` 永远不成立 ⇒ 界面正文消失，
 *     而**别的测试不会红**（`session-partial-output.test.js` 那族喂的是自己手造的载荷，不是库里的行）。
 *     ②是本站自造的键（`internal.js#runEndPartialKeys`），它这里的风险是**本站自己**的读点/写点漂移。
 *
 * 断言口径刻意是**键存在 + 类型是 string**，不是「值非空」：引擎在空轮上写的就是 `''`
 * （runner 的 `event.finalText ?? ''`，`runner/worker.js:293`），要求非空会把合法的空轮判成回归。
 * 载荷也**不手抄**字段名，而是从 runner 的 `loopEventPayload` 真映射里拿 —— 否则这条只钉得住
 * 「库里存了什么」，钉不住「runner 有没有把引擎的 `finalText` 映射成 `final_text`」这半条链。
 * 正文**内容**对不对另有其人（上面那条判据 3 用例断 `partial_text === '说到一半'`），这里不重复。
 *
 * **红了怎么读**：先查上游 payload 是否改名/瘦身（上面两处坐标），再查本站 runner 的映射
 * （`runner/worker.js:290` 的 `case 'round_end'`）与 `internal.js#runEndPartialKeys`；
 * **它红了不是本单（#502）的回归**，是「上游动了形态 M 脚下的地基」的信号。
 */
test('#502 绊线：库里 round_end.payload.final_text 与 run_end.payload.partial_text 两个键必须在（形态 M 判据 3 的 durable 源）', { skip: SKIP }, async () => {
  await withFreshDb(async (pool) => {
    partialOutputs.clear();
    const scene = ids('tripwire');
    const live = await claimAndStart(pool, scene);
    let n = 0;
    // 一条 U3 事件（`client_event_id` 形状同 `runner/worker.js:191`）。
    const ev = (type, payload) => ({ client_event_id: `${scene.runId}:1:${n++}`, type, payload });
    await postEvents(pool, {
      ...live, runId: scene.runId,
      body: { batch_id: 'b1', events: [
        ev('round_start', { round: 1 }),
        ev('assistant_delta', { text: '第一段正文' }),
        // 引擎事件是**驼峰**的，落库键是**蛇形**的：中间这笔账由 `loopEventPayload` 结（本绊线的重点）。
        ev('round_end', loopEventPayload({
          type: 'round_end', round: 1, finalText: '第一段正文', stopReason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 3 },
        })),
        // 第 2 轮**故意不给 `finalText`**（引擎空轮的真实形态）⇒ 落库值 `''`：键**仍须在**，
        // 这正是「空串也算存在」那条口径的用武之地（瘦身成「空轮不写键」就会在这里红）。
        ev('round_start', { round: 2 }),
        ev('round_end', loopEventPayload({ type: 'round_end', round: 2, stopReason: 'end_turn' })),
        // 第 3 轮只有碎片、没有 `round_end` ⇒ 停止时它还是半轮（正文只可能来自 ② 那个键）。
        ev('round_start', { round: 3 }),
        ev('assistant_delta', { text: '说到一半' }),
      ] },
    });
    // `final_text: ''` ⇒ 没有 assistant 锚点（与 `finishRun` 建锚点同一条判据）⇒ ② 的键该出现。
    await setRunState(pool, {
      ...live, runId: scene.runId,
      body: { state: 'failed', termination: { reason: 'aborted' }, rounds: 3, final_text: '' },
    });

    const rows = await pool.query(
      `SELECT seq, type, payload FROM run_events WHERE run_id = $1 ORDER BY seq`, [scene.runId],
    );
    // ---- ① 已完成轮次：每一行 round_end 都得带着 `final_text`（读侧只认它）----
    const roundEnds = rows.rows.filter((r) => r.type === 'round_end');
    assert.equal(roundEnds.length, 2, '本场景有 2 个已完成轮次（第 3 轮是停掉的半轮，不该有 round_end）');
    // 逐轮钉一遍，并按**引擎给的 round**对上号（不靠行序碰运气）。
    for (const [round, want] of [[1, '第一段正文'], [2, '']]) {
      const row = roundEnds.find((r) => Number(r.payload?.round) === round);
      assert.ok(row, `第 ${round} 轮的 round_end 行没落库`);
      const p = row.payload;
      assert.ok(p && typeof p === 'object', `round_end 的 payload 不是对象：${JSON.stringify(p)}`);
      assert.ok(Object.hasOwn(p, 'final_text'),
        `绊线断了：seq=${row.seq}（第 ${round} 轮）的 round_end 行没有 final_text 键 ⇒ 形态 M 判据 3 的已完成轮次正文没有 durable 源了（上游 payload 改名/瘦身，或 runner/worker.js:290 的映射断了；不是 #502 本单的回归）`);
      // 与读侧 `projectPartialOutputItems` 的谓词**逐字同一句**：非 string 在它眼里就是「没给正文」。
      assert.equal(typeof p.final_text, 'string',
        `绊线断了：final_text 不是 string（拿到 ${typeof p.final_text}）⇒ 读侧会把它当没给正文，界面正文消失`);
      // 这一句钉的是**本站 runner 那一半链**：引擎驼峰 → U3 蛇形这笔账不能被改扁
      //（比如退成恒 `''`：键在、类型也对，但正文丢了，上面两条给不了信）。
      assert.equal(p.final_text, want,
        `第 ${round} 轮的 final_text 与引擎事件里的 finalText 不再对应（拿到 ${JSON.stringify(p.final_text)}）——空轮给空串是合法的，但丢正文不是`);
    }

    // ---- ② 停止那半轮：`run_end` 那一行得带着 `partial_text` ----
    const ends = rows.rows.filter((r) => r.type === 'run_end');
    assert.equal(ends.length, 1, '一个 run 恰一条 run_end（正文就并在它身上）');
    const ep = ends[0].payload;
    assert.ok(ep && typeof ep === 'object', `run_end 的 payload 不是对象：${JSON.stringify(ep)}`);
    assert.ok(Object.hasOwn(ep, 'partial_text'),
      '绊线断了：无 assistant 锚点且缓冲里有正文，run_end 的 payload 却没有 partial_text 键 ⇒ 停止那半轮的正文没有 durable 源了（本站 internal.js#runEndPartialKeys 断了）');
    assert.equal(typeof ep.partial_text, 'string',
      `绊线断了：partial_text 不是 string（拿到 ${typeof ep.partial_text}）⇒ 读侧会把它当没给正文`);
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

/**
 * 难压缩的**确定性**伪随机正文（copilot 验收 #513 的 I 条）。
 *
 * 为什么必须是「难压缩」：`run_checkpoints.snapshot` 是 jsonb ⇒ 大值走 TOAST 并默认压缩，
 * 于是 `'x'.repeat(53_000)` 这种「字符数很多、信息量几乎没有」的种子在磁盘上只有几 KB，
 * 「每行字节 / 总字节」两条上界量的根本不是同一件事（实测见体积闸那条用例的注释）。
 * 为什么必须**确定性**：这条闸的数字要能被复算（`Math.random()` 让每次量出来的上界都不同，
 * 下次红了没人知道是该信还是该改阈值）。
 * 形状：`sha256(<行号>:<块号>)` 的 base64 串接（64 字母表 ≈ 每字符 6 bit 信息量，pglz/lz4
 * 都压不动），截到目标长度。同一行号永远得到同一个串。
 */
function hardCompressible(rowIndex, targetChars = 53_000) {
  let out = '';
  let block = 0;
  while (out.length < targetChars) {
    out += crypto.createHash('sha256').update(`${rowIndex}:${block}`).digest('base64');
    block += 1;
  }
  return out.slice(0, targetChars);
}

test('#502 体积闸：`run_events` 每行字节上界 + 碎片占比 < 5 %；`run_checkpoints` 每行 / 总行数 / 总字节三条上界（样本必须非空）', { skip: SKIP }, async () => {
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
    //
    // ⚠ **审计第 9 条：这一段的样本原来是空的**。全新库里 `run_checkpoints` 是 **0 行**（本用例
    // 只往 `run_events` 插行），于是 `if (cn > 0)` 永不进入，剩下那句 `assert.ok(cb >= 0)`
    // 是个**恒真**的空断言（`pg_total_relation_size` 返回空表那几个页的常数，也 >= 0）。
    // 「闸看起来在，其实没验」——本单把它修成「先种真行，再断三条」。
    //
    // 种行走**产品写入口** `putCheckpoint`（U8），不是自己 INSERT：那样才连 `ON CONFLICT (run_id)`
    // + revision CAS 一起验了（自己 INSERT 就只能验「页常数没超标」）。
    // `run_checkpoints.run_id` 是主键且外键指 `runs` ⇒ 每条 checkpoint 要挂在一个真 run 上。
    const CP_ROWS = 10;          // 种 10 行（与 dev 库的 85 行同量级下界，够把每行字节从页常数里分出来）
    // ---- 三条上界全部**先量后定**（copilot 验收 #513 的 I 条；上一版是拍脑袋的 4 MiB）----
    // 实测（本文件这条用例，一次性 postgres:16.15 容器，`hardCompressible` 种子，10 行）：
    //     n=10  total=630,784 B  per_row=63,078 B
    //  同一套夹具把种子换回 `'x'.repeat(53_000)` ⇒ total=**40,960 B**（4,096 B/行；jsonb 走 TOAST
    //  压缩，压缩比 ≈13:1。主 agent 在裸表上另量到 32,768 B，同一件事的两个读数，差异在表自身的
    //  索引/页布局，不影响结论）。于是旧那两条上界与「10 行 ≈ 0.5 MB」那句注释：
    //    · 每行 512 KiB 对上 4,096 B/行 = **128 倍**余量；对上现在这个 63,078 B/行也还有 8.3 倍；
    //    · 总量 4 MiB 对上 40,960 B = **102 倍**余量；对上现在这个 630,784 B 也还有 6.6 倍；
    //  ⇒ 旧闸在**任何**种子下都抓不到「复长」（行数翻十倍、每行翻倍都没事），这就是 I 条。
    // 上界取实测的 ~1.9 倍：既留出走形变动的余量（引擎 state 本来就会漂），又不至于
    // 「行数翻十倍也没人看见」。改种子 = 改数字，注释里这两行数字必须一起改。
    const CP_ROWS_CAP = 20;             // 总行数上界 = 种行数 × 2：夹具只种 10 条 ⇒ 「顺带多写」立刻顶到
    const CP_ROW_BYTES_CAP = 120_000;   // 每行上界 ≈ 实测 63,078 B × 1.9
    const CP_TOTAL_BYTES_CAP = 1_200_000; // 总字节上界 ≈ 实测 630,784 B × 1.9
    // **种子自证（新增，也是这条闸的「别把上界静默改松」保险）**：总量必须 ≥ 实测的 ~0.7 倍。
    // 为什么单独要一条：上面三条都是「别太大」，谁都没有问「样本够不够大」。有人（有意或顺手）
    // 把种子换回 `'x'.repeat(53_000)` 时，实占会从 630 KB 掉回 40 KB ⇒ 三条上界**全都不会红**，
    // 闸只是悄悄变松。这一条会**先红**，并且红话说清「是种子退化，不是数据复长」。
    const CP_TOTAL_BYTES_FLOOR = 450_000; // 实测 630,784 B × 0.7 ≈ 441 KB（取整）
    // ⚠ 每个 checkpoint 要**自己的一套 scene**：`seedRunScene` 里每个 id 都是 uuid，
    // 拿已经种过的 `volScene` 再种一遍就是 `duplicate key value ... "users_pkey"`（真踩过）。
    const cpScenes = [];
    for (let i = 0; i < CP_ROWS; i++) cpScenes.push(ids(`cp${i}`));
    // 快照载荷尺寸照 dev 量级（每行 ≈ 53 KB）；走 U8 真入口需要每个 run 已领起。
    for (const [i, scene] of cpScenes.entries()) {
      const live = await claimAndStart(pool, scene);
      await putCheckpoint(pool, {
        container: live.container, user: live.user, runId: scene.runId, claimToken: live.claimToken,
        // `snapshot` 必须是对象（`putCheckpoint` 会验）；给一个 ≈ 53 KB 的引擎 state 形状。
        // copilot 独立验收 #513 的 **I 条**（261115-01）：种子原来是 `'x'.repeat(53_000)`，而
        // `snapshot` 是 **jsonb** ⇒ 走 TOAST 压缩 ⇒ 10 行实际只占 **32 KB**（实测见下面注释），
        // 于是「10 行 ≈ 0.5 MB」与 4 MiB 的上界**松了约 130 倍**，这条闸抓不到任何复长。
        // 换成**难压缩的确定性伪随机**内容（sha256-base64 串接，按行号派生 ⇒ 可复现，
        // 不用 `Math.random()`，失败重跑量出来的数字还是同一个）。
        body: { revision: 1, snapshot: { round: i + 1, messages: hardCompressible(i) } },
      });
    }
    const cp = await pool.query(
      `SELECT count(*)::int AS n, pg_total_relation_size('run_checkpoints') AS sz FROM run_checkpoints`,
    );
    const cn = cp.rows[0].n;
    const cb = Number(cp.rows[0].sz);
    // 复量开关：`STATION_MEASURE_CP=1 node --test portal/test/delta-not-persisted-db.test.js`
    // ⇒ 把这次量到的读数打到 stderr。上面那三条上界就是这么定下来的（**先量后定**），
    // 以后改种子/改形状也用它重量一遍再改数字，别拿新的拍脑袋值替换旧的拍脑袋值。
    if (process.env.STATION_MEASURE_CP) {
      console.error(`MEASURE_CP n=${cn} total=${cb} per_row=${Math.round(cb / Math.max(cn, 1))}`);
    }
    // **反向自证（空样本不得静默通过）**：种了多少行就必须拿到多少行。
    // 拿不到（0 行 / 少于预期）就是**本用例红**，而不是「跳过断言继续绿」——那正是审计第 9 条的形状。
    assert.equal(cn, CP_ROWS,
      `样本必须是 ${CP_ROWS} 行（审计第 9 条：0 行时旧写法会把恒真的「cb >= 0」当成读数）：实拿 ${cn} 行`);
    assert.ok(cb / cn < CP_ROW_BYTES_CAP,
      `run_checkpoints 每行字节上界破了：${Math.round(cb / cn)} B/行 > ${CP_ROW_BYTES_CAP}（${cn} 行 / ${cb} B）`
      + ' —— 引擎 state 走形或快照没折叠都会先撞这里；数字来历见上面的实测注释');
    assert.ok(cn <= CP_ROWS_CAP,
      `run_checkpoints 总行数上界破了（新增，防「行数翻十倍但每行不变」这种复长）：${cn} > ${CP_ROWS_CAP}`);
    assert.ok(cb <= CP_TOTAL_BYTES_CAP,
      `run_checkpoints 总字节上界破了（新增）：${cb} B > ${CP_TOTAL_BYTES_CAP} B（${cn} 行 × 约 ${Math.round(cb / cn)} B/行）`);
    // 种子自证（见上面的 `CP_TOTAL_BYTES_FLOOR`）：**先红的是这条，不是上面那三条**。
    assert.ok(cb >= CP_TOTAL_BYTES_FLOOR,
      `种子不够大了：10 行 checkpoint 只占 ${cb} B（阈值 ${CP_TOTAL_BYTES_FLOOR} B，实测形状 ≈ 630,784 B）。`
      + '要么种子被换回了可压缩内容（`repeat(x)` 这类，TOAST 一压就没了 ⇒ 上面三条上界全部静默变松），'
      + '要么 jsonb/TOAST 口径变了 —— 两种都得改代码，不能只把这条阈值调小。');
    assert.ok(cb >= 0, '两张表都要各自给出读数（体积闸不许只量一张）');
  });
});

test('#502 环境门自证：没有 TEST_DATABASE_URL 时上面那些真库用例都是 skip 而不是假通过', () => {
  // 这条**不加 skip**：它在两种环境下都必须跑，且它断言的是「门是否存在」。
  const guarded = [
    '#502 判据 1 真库形状闸：喂 10 条与 1000 条 delta 的 run，落库行数**完全相同**',
    '#502 判据 3 真库：终态无锚点 ⇒ 半截正文并进那一行 run_end 的 payload（无新行、无新索引）',
    '#502 迁移 0033：分批清存量可重放（第二遍 0 行 rc=0）、锁窗口有界、VACUUM 不能进迁移文件',
    '#502 体积闸：`run_events` 每行字节上界 + 碎片占比 < 5 %；`run_checkpoints` 每行 / 总行数 / 总字节三条上界（样本必须非空）',
    // 绊线用例也在门后面 ⇒ 它也必须在名单里：无 PG 时它是 skip（**不是** pass），
    // 根 `npm test`（不带 TEST_DATABASE_URL）里它计入 `# skipped`，不是 `# pass`。
    '#502 绊线：库里 round_end.payload.final_text 与 run_end.payload.partial_text 两个键必须在（形态 M 判据 3 的 durable 源）',
  ];
  assert.equal(guarded.length, 5);
  // 名单不许只是装饰：每一条都必须在本文件里**真的存着一个同名的 `test(...)`**。
  // 不这样钉的话，它只能自数长度 ⇒ 本单就踩过一次：上一版用例改名后这里没人发现，
  // 名单里那行已经变成对着一件不存往事描述的文字（所以旧名字也顺手改对了）。
  // ⚠ 判据必须是 `test('<名字>'` 而不是「名字在源码里出现过」：后者会被名单自己满足（恒真）。
  const selfSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const name of guarded) {
    assert.ok(selfSrc.includes(`test('${name}'`) || selfSrc.includes(`test(\`${name}\``),
      `环境门名单与本文件用例名漂移（本文件里没有这个用例）：${name}`);
  }
  if (!URL_VALUE) {
    assert.match(SKIP, /TEST_DATABASE_URL 未设置/, '没有 PG 时必须走 skip（消息里写清怎么起一次性实例）');
  } else {
    assert.equal(SKIP, false, '有 PG 时 skip 标志必须是 false（否则真库用例被静默跳过 = 假通过）');
  }
});
