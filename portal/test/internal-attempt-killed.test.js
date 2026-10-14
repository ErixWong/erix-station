// issue #288（缺陷 B）：attempt 被杀必须对用户可见。
//
// 契约（docs/api/portal.md §9.11 / §5.3）：agentd 在 U12 release 上**additive** 上报
// `killed_by` / `silent_ms`，portal 在 **requeue 分支同事务**向 `run_events` 追一条
// `attempt_killed`（`client_event_id` + `ON CONFLICT DO NOTHING`，先例 #277 的合成 `run_end`）。
// 两面口径都得钉住：有 kill ⇒ 恰一条；无 kill / 非法值 ⇒ 零事件（不得 400 弄坏旧 agentd）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimRun, setRunState, releaseRun, reapExpiredRuns, registerSessionClient, sessionClientGoLive, unregisterSessionClient } from '../src/internal.js';
import { seedClaimable } from './fake-internal-pool.js';

const container = { id: 'c1', user_id: 'u1' };
const user = { id: 'u1', login: 'alice' };

// 走到「worker 已跑起来后被杀」的真实现场：claim → U2 running → release。
async function claimedAttempt(opts = {}) {
  const s = seedClaimable(opts);
  const ticket = await claimRun(s.pool, { container, user, capacity: 1, holdMs: 10 });
  await setRunState(s.pool, {
    container, user, runId: s.runId, claimToken: ticket.claim_token, body: { state: 'running' },
  });
  return { ...s, claimToken: ticket.claim_token };
}

const killsOf = (pool) => pool.events.filter((e) => e.type === 'attempt_killed');

test('#288② requeue + killed_by ⇒ 同事务恰一条 attempt_killed，载荷字段齐全', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  const rel = await releaseRun(pool, {
    container, user, runId, claimToken,
    body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301_584 },
  });
  assert.equal(rel.outcome, 'requeued');

  const kills = killsOf(pool);
  assert.equal(kills.length, 1, 'requeue 分支必须恰好追一条 attempt_killed');
  const payload = JSON.parse(kills[0].payload);
  assert.deepEqual(payload, {
    attempt: 1, max_attempts: 3, reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 301584,
  });
  assert.equal(kills[0].client_event_id, `${runId}:attempt-killed:1`, '幂等键 = runId:attempt-killed:<attempt>');
  assert.equal(pool.queue[0].status, 'pending', 'requeue 语义不变（本改动不得动队列）');
  assert.equal(pool.runs[0].status, 'running', 'A5/B：attempt 级失败不回写 runs.status（本改动不得引入回写）');
});

test('#288② seq 承重：attempt_killed 走 allocSeq 分配，与既有事件同轴单调递增', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  const before = pool.sessions[0].last_seq;
  const rel = await releaseRun(pool, {
    container, user, runId, claimToken, body: { reason: 'worker_crashed', killed_by: 'crash' },
  });
  const kill = killsOf(pool)[0];
  assert.ok(Number(kill.seq) > before, `seq(${kill.seq}) 必须大于分配前的 last_seq(${before})`);
  assert.equal(pool.sessions[0].last_seq, Number(kill.seq), '分配器（chat_sessions.last_seq）必须被推进');
  assert.equal(kill.session_id, pool.sessions[0].id, 'session_id 必填：历史回放按 session 取');
  assert.ok(Number.isFinite(Number(rel.attempts)));
});

test('#288③ 幂等：同一 attempt 的 kill 重复上报 ⇒ 仍恰一条（ON CONFLICT DO NOTHING 生效）', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  const body = { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 };
  await releaseRun(pool, { container, user, runId, claimToken, body });
  // 模拟「响应丢失后 at-least-once 重试，而队列行已被重领回 claimed」：同 attempt 再次上报同一死因。
  pool.queue[0].status = 'claimed';
  pool.queue[0].lease_until = Date.now() + 60_000;
  const rel = await releaseRun(pool, { container, user, runId, claimToken, body });
  assert.equal(rel.outcome, 'requeued');
  assert.equal(killsOf(pool).length, 1, '同一 attempt 的死因不得因重试写第二条');
});

test('#288③ 无 kill 信息 ⇒ 零事件（fork_failed / prepare_cwd_failed 这类「压根没起 worker」）', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  const rel = await releaseRun(pool, { container, user, runId, claimToken, body: { reason: 'fork_failed' } });
  assert.equal(rel.outcome, 'requeued');
  assert.equal(killsOf(pool).length, 0, '无 killed_by ⇒ 一个 attempt_killed 都不写（旧 agentd 同此路径）');
});

test('#288③ killed_by 非法值 ⇒ 不 400、不写事件（additive 字段不得弄坏旧/坏 agentd）', async () => {
  for (const bad of ['nuclear', '', 'WATCHDOG', 42, null, {}]) {
    const { pool, runId, claimToken } = await claimedAttempt();
    const rel = await releaseRun(pool, {
      container, user, runId, claimToken, body: { reason: 'worker_crashed', killed_by: bad },
    });
    assert.equal(rel.outcome, 'requeued', `killed_by=${JSON.stringify(bad)} 必须照常 requeue`);
    assert.equal(killsOf(pool).length, 0, `killed_by=${JSON.stringify(bad)} 不在 {watchdog, crash} ⇒ 不写事件`);
  }
});

test('#288③ silent_ms 只在可信时出现：非有限/负数 ⇒ 整个键不写（绝不用 0 冒充「有」）', async () => {
  for (const bad of ['300000', -1, NaN, null, {}, true]) {
    const { pool, runId, claimToken } = await claimedAttempt();
    await releaseRun(pool, {
      container, user, runId, claimToken,
      body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: bad },
    });
    const payload = JSON.parse(killsOf(pool)[0].payload);
    assert.ok(!('silent_ms' in payload), `silent_ms=${String(bad)} 时不得出现该键，实际：${JSON.stringify(payload)}`);
  }
  const ok = await claimedAttempt({ runId: 'run-ok' });
  await releaseRun(ok.pool, {
    container, user, runId: ok.runId, claimToken: ok.claimToken,
    body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_400.7 },
  });
  assert.equal(JSON.parse(killsOf(ok.pool)[0].payload).silent_ms, 300401, '有限值取整后写入');

  // next_retry_in_ms 是预留键：portal 侧支持，agentd 本站不发（发了就写）。
  const nr = await claimedAttempt({ runId: 'run-nr' });
  await releaseRun(nr.pool, {
    container, user, runId: nr.runId, claimToken: nr.claimToken,
    body: { reason: 'worker_crashed', killed_by: 'crash', next_retry_in_ms: 5000 },
  });
  assert.equal(JSON.parse(killsOf(nr.pool)[0].payload).next_retry_in_ms, 5000);
  const noNr = await claimedAttempt({ runId: 'run-nonr' });
  await releaseRun(noNr.pool, {
    container, user, runId: noNr.runId, claimToken: noNr.claimToken,
    body: { reason: 'worker_crashed', killed_by: 'crash' },
  });
  assert.ok(!('next_retry_in_ms' in JSON.parse(killsOf(noNr.pool)[0].payload)));
});

test('#288① 实时可见：release 落库后 attempt_killed 必须推 session SSE（与历史回放同形状）', async () => {
  const { pool, runId, claimToken, sessionId } = await claimedAttempt();
  // 走**真的 session hub**：`registerSessionClient` 给的是 hub rec（`{res, buffer, live, …}`），
  // 事件是 `writeSessionEvent` 写进 `res` 的 SSE 帧（§5.1 wire：`id:` + `event:` + `data:`）。
  // 上一版用例断言了一个不存在的 `rec.items` 队列 API（根本没跑过），改成钉 wire 形状。
  const res = { written: [], ended: false, destroyed: false, writableEnded: false, write(s) { this.written.push(s); }, end() { this.ended = true; } };
  const rec = registerSessionClient(sessionId, res);
  sessionClientGoLive(sessionId, rec); // 已补发完毕的在线客户端
  try {
    await releaseRun(pool, {
      container, user, runId, claimToken,
      body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 },
    });
    const frames = res.written.filter((s) => s.includes('event: attempt_killed'));
    assert.equal(frames.length, 1, 'session SSE 必须收到一条 attempt_killed');
    const stored = killsOf(pool)[0];
    assert.match(frames[0], new RegExp(`^id: ${Number(stored.seq)}\\n`), 'SSE 帧的 id 必须就是落库 seq（前端按 seq 归并/续传）');
    const data = JSON.parse(frames[0].match(/\ndata: (.*)\n/)[1]);
    assert.equal(data.type, 'attempt_killed');
    assert.equal(data.run_id, runId);
    assert.equal(data.seq, Number(stored.seq));
    const storedPayload = JSON.parse(stored.payload);
    for (const [key, value] of Object.entries(storedPayload)) {
      assert.equal(data[key], value, `SSE 展开后的载荷字段 ${key} 必须与落库载荷同形状`);
    }
  } finally {
    unregisterSessionClient(sessionId, rec);
  }
});

test('#288③ 幂等的另一面：重试的那一次没真插入行 ⇒ 也不得多推一条 SSE（前端不会看见重复重试行）', async () => {
  const { pool, runId, claimToken, sessionId } = await claimedAttempt();
  const res = { written: [], ended: false, destroyed: false, writableEnded: false, write(s) { this.written.push(s); }, end() { this.ended = true; } };
  const rec = registerSessionClient(sessionId, res);
  sessionClientGoLive(sessionId, rec);
  try {
    const body = { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 };
    await releaseRun(pool, { container, user, runId, claimToken, body });
    pool.queue[0].status = 'claimed';
    pool.queue[0].lease_until = Date.now() + 60_000;
    await releaseRun(pool, { container, user, runId, claimToken, body });
    assert.equal(killsOf(pool).length, 1, '落库恰一条');
    assert.equal(res.written.filter((s) => s.includes('event: attempt_killed')).length, 1,
      'ON CONFLICT 没插入行就不许再推 SSE（否则同一 attempt 在界面上出两条重试行）');
  } finally {
    unregisterSessionClient(sessionId, rec);
  }
});

test('#288② 同事务：attempt_killed 的 INSERT 必须落在 BEGIN…COMMIT 窗口内（挪到提交之后就是红）', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  await releaseRun(pool, {
    container, user, runId, claimToken,
    body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 },
  });
  const txn = pool.sqlLog.filter((s) => s.txnId != null);
  const beginIdx = txn.findIndex((s) => /^BEGIN\b/.test(s.sql));
  const commitIdx = txn.map((s) => /^COMMIT\b/.test(s.sql) ? s.index : -1).filter((i) => i > beginIdx)[0];
  const insertIdx = txn.map((s) => /INSERT INTO run_events[\s\S]*'attempt_killed'/.test(s.sql) ? s.index : -1).filter((i) => i >= 0)[0];
  assert.ok(beginIdx >= 0 && commitIdx !== undefined, `必须有 BEGIN…COMMIT 窗口：${JSON.stringify(txn.map((s) => s.sql.slice(0, 24)))}`);
  assert.ok(insertIdx !== undefined && insertIdx > beginIdx && insertIdx < commitIdx,
    `attempt_killed 的 INSERT（${insertIdx}）必须在队列改写同一事务内（BEGIN=${beginIdx} / COMMIT=${commitIdx}）`);
});

test('#288② 原子性：COMMIT 失败 ⇒ 一条 attempt_killed 都不留（不得留下「说被杀但没重排」的孤儿事件）', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  pool.failCommitOnce = true;
  await assert.rejects(
    releaseRun(pool, {
      container, user, runId, claimToken,
      body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 },
    }),
    (err) => err.code === '40001' || err.code === '57014',
  );
  assert.equal(killsOf(pool).length, 0, '事务没提交 ⇒ 事件不得落库');
  assert.equal(pool.sessions[0].last_seq, 0, 'seq 也不得被消费（分配与写入同事务）');
});

test('#288① 终态 run_end：error.code 契约不变，additive 挂 last_reason / last_silent_ms（有则出现）', async () => {
  const withKill = await claimedAttempt({ runId: 'run-last' });
  withKill.pool.queue[0].attempts = 3;
  withKill.pool.queue[0].max_attempts = 3;
  await releaseRun(withKill.pool, {
    container, user, runId: withKill.runId, claimToken: withKill.claimToken,
    body: { reason: 'watchdog_silent', killed_by: 'watchdog', silent_ms: 300_000 },
  });
  const end = withKill.pool.events.filter((e) => e.type === 'run_end').pop();
  const payload = JSON.parse(end.payload);
  assert.equal(payload.error.code, 'max_attempts_exceeded', '既有契约：error.code 不得改');
  assert.equal(payload.last_reason, 'watchdog_silent');
  assert.equal(payload.last_silent_ms, 300000);
  assert.equal(withKill.pool.runs[0].status, 'failed');
  assert.equal(killsOf(withKill.pool).length, 0, '耗尽分支不写 attempt_killed（终态由 run_end 承载）');

  const noKill = await claimedAttempt({ runId: 'run-last-nokill' });
  noKill.pool.queue[0].attempts = 3;
  noKill.pool.queue[0].max_attempts = 3;
  await releaseRun(noKill.pool, {
    container, user, runId: noKill.runId, claimToken: noKill.claimToken, body: { reason: 'worker_crashed' },
  });
  const end2 = JSON.parse(noKill.pool.events.filter((e) => e.type === 'run_end').pop().payload);
  assert.equal(end2.error.code, 'max_attempts_exceeded');
  assert.ok(!('last_reason' in end2), '无 kill 信息 ⇒ last_reason 键不得出现');
  assert.ok(!('last_silent_ms' in end2), '无 kill 信息 ⇒ last_silent_ms 键不得出现');
});

test('#288① cancelling 分支不受影响：只合成 run_end(aborted)，不写 attempt_killed', async () => {
  const { pool, runId, claimToken } = await claimedAttempt();
  pool.runs[0].status = 'cancelling';
  const rel = await releaseRun(pool, {
    container, user, runId, claimToken,
    body: { reason: 'stop_request', killed_by: 'watchdog', silent_ms: 1000 }, // 即便带上 kill 也不该写
  });
  assert.equal(rel.outcome, 'cancelled');
  assert.equal(killsOf(pool).length, 0, '用户主动停止不是「被看门狗杀」，不得冒泡成 attempt_killed');
});

// ===========================================================================
// issue #292：**reaper 收敛**的 attempt 重排也必须对用户可见（#288 缺陷 B 的第二条产出路径）
// ===========================================================================
//
// 为什么单独立一组：上面全部用例走的是「agentd 活着、主动 U12 release 上报 killed_by」这条路。
// 真正常见的崩溃形状是**上报者自己也死了**（agentd 被杀 / 容器 `docker kill` / OOM / 网络断）
// ⇒ 一次 release 都不会发生，只有租约（90s）过期后的 reaper 收敛（每 15s 一轮）。此前 reaper
// 三条分支都不写 `attempt_killed`，用户看到的仍是「同一个工具卡片亮 3 次，没有原因」。
//
// 载荷口径（docs/api/portal.md §5.3 第 14 类，前端已按它渲染 ⇒ 形状不得改）：
//   `{attempt, max_attempts, reason:'lease_expired', killed_by:'crash'}`
//   —— **没有 `silent_ms`**：该键的语义是「最后一次 IPC 上报后的静默时长」，reaper 拿不到这个数
//      ⇒ 整个键不出现（写 0 或自造「距上次心跳的估算」都是伪装，#288 已定口径）。
//   —— `killed_by` 固定 `crash`：reaper 无从区分 F6 看门狗判死与真崩，保守取 crash。

// 「领起来了，但上报者死了」：claim → U2 running → 租约过期（再没人续租）。
async function deadWorkerAttempt(opts = {}) {
  const s = await claimedAttempt(opts);
  s.pool.queue[0].lease_until = Date.now() - 1000;
  return s;
}

/** 「同事务」是可观测的：该类型的 INSERT 必须落在 BEGIN…COMMIT 窗口内（挪到提交之后就当红）。 */
function txnWindowOf(pool, type) {
  const txn = pool.sqlLog.filter((s) => s.txnId != null);
  const beginIdx = txn.findIndex((s) => /^BEGIN\b/.test(s.sql));
  const commitIdx = txn.map((s) => (/^COMMIT\b/.test(s.sql) ? s.index : -1)).filter((i) => i > beginIdx)[0];
  const re = new RegExp(`INSERT INTO run_events[\\s\\S]*'${type}'`);
  const insertIdx = txn.map((s) => (re.test(s.sql) ? s.index : -1)).filter((i) => i >= 0)[0];
  return { beginIdx, commitIdx, insertIdx };
}

/** 最小 SSE 客户端桩（与 §5.1 wire 一致：事件是写进 res 的帧，不是内存队列）。 */
function makeSseRes() {
  return { written: [], ended: false, destroyed: false, writableEnded: false, write(s) { this.written.push(s); }, end() { this.ended = true; } };
}

test('#292① reaper 分支③（租约过期 + attempts 未耗尽）⇒ 恰一条 attempt_killed，载荷逐字段且**没有 silent_ms 键**', async () => {
  const { pool, runId } = await deadWorkerAttempt();
  const res = await reapExpiredRuns(pool);
  assert.equal(res[0].outcome, 'requeued');

  const kills = killsOf(pool);
  assert.equal(kills.length, 1, 'reaper 的 requeue 分支必须恰好追一条 attempt_killed（此前是零条 = 本 issue 的缺陷本体）');
  assert.deepEqual(JSON.parse(kills[0].payload), {
    attempt: 1, max_attempts: 3, reason: 'lease_expired', killed_by: 'crash',
  }, '载荷逐字段：attempt=死掉的那一次（claim 时已 +1）、reason 是开放值 lease_expired、killed_by 保守取 crash');
  const payload = JSON.parse(kills[0].payload);
  assert.ok(!('silent_ms' in payload), `reaper 拿不到「距最后一次 IPC 上报的静默时长」⇒ 该键必须不出现（0 是伪装），实际：${JSON.stringify(payload)}`);
  assert.ok(!('next_retry_in_ms' in payload), 'reaper 没有自己定的退避时长 ⇒ 该键不出现');
  assert.equal(kills[0].client_event_id, `${runId}:attempt-killed:1`, '幂等键 = runId:attempt-killed:<attempt>（与 release 路径同键，两条路径同一 attempt 只会落一条）');
  assert.equal(pool.queue[0].status, 'pending', 'requeue 语义不变（本改动不得动队列）');
  assert.equal(pool.queue[0].attempts, 1, 'reaper 回 pending 不递增 attempts（#207）');
  assert.equal(pool.runs[0].status, 'running', 'A5：attempt 级失败不回写 runs.status（本改动不得引入回写）');
});

test('#292① seq 承重：reaper 的 attempt_killed 走 allocSeq 分配，分配器被推进', async () => {
  const { pool } = await deadWorkerAttempt();
  const before = pool.sessions[0].last_seq;
  await reapExpiredRuns(pool);
  const kill = killsOf(pool)[0];
  assert.ok(Number(kill.seq) > before, `seq(${kill.seq}) 必须大于分配前的 last_seq(${before})`);
  assert.equal(pool.sessions[0].last_seq, Number(kill.seq), '分配器（chat_sessions.last_seq）必须被推进 ⇒ 证明走的是 allocSeq，不是自造 seq');
  assert.equal(kill.session_id, pool.sessions[0].id, 'session_id 必填：历史回放按 session 取');
});

test('#292② 同事务：attempt_killed 的 INSERT 落在 reaper 的 BEGIN…COMMIT 窗口内（挪到提交之后就当红）', async () => {
  const { pool } = await deadWorkerAttempt();
  await reapExpiredRuns(pool);
  const { beginIdx, commitIdx, insertIdx } = txnWindowOf(pool, 'attempt_killed');
  assert.ok(beginIdx >= 0 && commitIdx !== undefined, `必须有 BEGIN…COMMIT 窗口：${JSON.stringify(pool.sqlLog.map((s) => s.sql.slice(0, 24)))}`);
  assert.ok(insertIdx !== undefined && insertIdx > beginIdx && insertIdx < commitIdx,
    `attempt_killed 的 INSERT（${insertIdx}）必须与队列改写同一事务（BEGIN=${beginIdx} / COMMIT=${commitIdx}）——提交成功但补写事件失败 = 用户永远看不到那次重排`);
});

test('#292③ 重复 reaper 轮次（同一 attempt 再收敛一次）⇒ 仍恰一条，且 SSE 不重复推', async () => {
  const { pool, runId, sessionId } = await deadWorkerAttempt();
  const res = makeSseRes();
  const rec = registerSessionClient(sessionId, res);
  sessionClientGoLive(sessionId, rec);
  try {
    const first = await reapExpiredRuns(pool);
    assert.equal(first[0].outcome, 'requeued');
    // 第二轮：模拟「事件已写过，但队列行又回到 claimed 且租约过期」（reaper 与 release 竞态 / 重领后又死）。
    pool.queue[0].status = 'claimed';
    pool.queue[0].lease_until = Date.now() - 1000;
    const second = await reapExpiredRuns(pool);
    assert.equal(second[0].outcome, 'requeued', '第二轮照常收敛');
    assert.equal(killsOf(pool).length, 1, '同一 attempt 的死因不得因重复轮次写第二条（ON CONFLICT DO NOTHING 生效）');
    assert.equal(res.written.filter((s) => s.includes('event: attempt_killed')).length, 1,
      '没真插入行就不许再推 SSE（否则同一 attempt 在界面上出两条重试行）');
  } finally {
    unregisterSessionClient(sessionId, rec);
  }
});

test('#292② 幂等键必须带 :<attempt>：同一 run 的第 2 次尝试再死一次 ⇒ 必须再来一条（否则第二轮崩溃永远不可见）', async () => {
  const { pool, runId } = await deadWorkerAttempt();
  await reapExpiredRuns(pool);
  // 重领（attempts → 2）后又死在租约上：这是「崩溃循环」的真日常形状。
  await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  pool.queue[0].lease_until = Date.now() - 1000;
  await reapExpiredRuns(pool);

  const kills = killsOf(pool);
  assert.equal(kills.length, 2, '两个不同的 attempt 各一条：第二轮的 kill 被 ON CONFLICT 吞掉 = 用户永远只看见第一次');
  assert.deepEqual(kills.map((e) => e.client_event_id), [`${runId}:attempt-killed:1`, `${runId}:attempt-killed:2`]);
  assert.deepEqual(kills.map((e) => JSON.parse(e.payload).attempt), [1, 2]);
  assert.deepEqual(kills.map((e) => JSON.parse(e.payload).max_attempts), [3, 3]);
  assert.ok(Number(kills[1].seq) > Number(kills[0].seq), '两条事件在同一 seq 轴上单调递增');
});

test('#292④ 零事件面：分支①（cancelling）与「租约未过期」都不得写 attempt_killed', async () => {
  // 分支①：用户主动 stop + 容器死 → 终态 aborted，不是「被杀」。
  const cancelling = await deadWorkerAttempt({ runId: 'run-cancel' });
  cancelling.pool.runs[0].status = 'cancelling';
  const rc = await reapExpiredRuns(cancelling.pool);
  assert.equal(rc[0].outcome, 'cancelled');
  assert.equal(killsOf(cancelling.pool).length, 0, '用户主动停止不是「被杀」，不得冒泡成 attempt_killed');
  assert.ok(cancelling.pool.events.some((e) => e.type === 'run_end'), '终态仍由 run_end 承载（不得回归）');

  // 租约未过期：不在候选集，一条事件都不许写（否则活着的 worker 会被误报「这次尝试死了」）。
  const alive = await claimedAttempt({ runId: 'run-alive' });
  const ra = await reapExpiredRuns(alive.pool);
  assert.equal(ra.length, 0);
  assert.equal(killsOf(alive.pool).length, 0, '租约仍有效 ⇒ 零 attempt_killed');
  assert.equal(alive.pool.events.length, 0, '租约仍有效 ⇒ 连合成 run_end 也不许有');
  assert.equal(alive.pool.queue[0].status, 'claimed', '租约仍有效 ⇒ 队列状态不动');
});

test('#292⑤ 分支②（耗尽）：不写 attempt_killed；run_end 的 error.code 逐字不变、additive 带 last_reason、不带 last_silent_ms', async () => {
  const { pool, runId } = await deadWorkerAttempt({ runId: 'run-exhaust' });
  pool.queue[0].attempts = 3;
  pool.queue[0].max_attempts = 3;
  const res = await reapExpiredRuns(pool);
  assert.equal(res[0].outcome, 'failed_max_attempts');
  assert.equal(pool.runs[0].status, 'failed');
  assert.equal(killsOf(pool).length, 0, '终态由 run_end 承载，不得再补一条 attempt_killed（同一事实两条展示）');

  const end = pool.events.filter((e) => e.type === 'run_end').pop();
  const payload = JSON.parse(end.payload);
  assert.equal(end.client_event_id, `${runId}:final:run_end`);
  assert.deepEqual(payload.error, { code: 'max_attempts_exceeded', message: 'attempts exhausted', retryable: false },
    '既有契约：error 对象逐字不得变（前端/文档按 code 渲染，不新造错误码）');
  assert.equal(payload.last_reason, 'lease_expired', 'additive：说明最后这一次是怎么没的（reaper 路径）');
  assert.ok(!('last_silent_ms' in payload), 'reaper 没有上报就没有那个数 ⇒ 该键不得出现（与 release 路径的差别）');
});

test('#292⑥ 原子性：COMMIT 失败 ⇒ 一条 attempt_killed 都不留（seq 也不被消费）', async () => {
  const { pool } = await deadWorkerAttempt({ runId: 'run-fail-commit' });
  pool.failCommitOnce = true;
  await assert.rejects(() => reapExpiredRuns(pool), (err) => err.code === '40001' || err.code === '57014');
  assert.equal(killsOf(pool).length, 0, '事务没提交 ⇒ 事件不得落库（不留「说被杀但没重排」的孤儿事件）');
  assert.equal(pool.sessions[0].last_seq, 0, 'seq 也不得被消费（分配与写入同事务）');
  assert.equal(pool.queue[0].status, 'claimed', '队列改写同样作废（下一次 reaper 轮次重来）');
});

test('#292① 实时可见：reaper 落库后 attempt_killed 必须推 session SSE（与刷新后的历史回放同形状）', async () => {
  const { pool, runId, sessionId } = await deadWorkerAttempt({ runId: 'run-sse' });
  const res = makeSseRes();
  const rec = registerSessionClient(sessionId, res);
  sessionClientGoLive(sessionId, rec); // 已补发完毕的在线客户端
  try {
    await reapExpiredRuns(pool);
    const frames = res.written.filter((s) => s.includes('event: attempt_killed'));
    assert.equal(frames.length, 1, 'session SSE 必须收到一条 attempt_killed（否则只有刷新后才看得见 = 两种可见性不一致）');
    const stored = killsOf(pool)[0];
    assert.match(frames[0], new RegExp(`^id: ${Number(stored.seq)}\\n`), 'SSE 帧的 id 必须就是落库 seq（前端按 seq 归并/续传）');
    const data = JSON.parse(frames[0].match(/\ndata: (.*)\n/)[1]);
    assert.equal(data.type, 'attempt_killed');
    assert.equal(data.run_id, runId);
    assert.equal(data.seq, Number(stored.seq));
    const storedPayload = JSON.parse(stored.payload);
    for (const [key, value] of Object.entries(storedPayload)) {
      assert.equal(data[key], value, `SSE 展开后的载荷字段 ${key} 必须与落库载荷同形状`);
    }
    assert.ok(!('silent_ms' in data), 'SSE 侧同样不得出现 silent_ms');
  } finally {
    unregisterSessionClient(sessionId, rec);
  }
});
