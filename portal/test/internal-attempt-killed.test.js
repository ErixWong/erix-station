// issue #288（缺陷 B）：attempt 被杀必须对用户可见。
//
// 契约（docs/api/portal.md §9.11 / §5.3）：agentd 在 U12 release 上**additive** 上报
// `killed_by` / `silent_ms`，portal 在 **requeue 分支同事务**向 `run_events` 追一条
// `attempt_killed`（`client_event_id` + `ON CONFLICT DO NOTHING`，先例 #277 的合成 `run_end`）。
// 两面口径都得钉住：有 kill ⇒ 恰一条；无 kill / 非法值 ⇒ 零事件（不得 400 弄坏旧 agentd）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimRun, setRunState, releaseRun, registerSessionClient, sessionClientGoLive, unregisterSessionClient } from '../src/internal.js';
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
