// 单测：internal.js 纯逻辑 + token 鉴权 + 状态机（fake pool）+ SSE hub + seq/事件幂等。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  InternalError,
  canonicalJson,
  canonicalHash,
  isValidClientEventId,
  validateTransition,
  assembleTicket,
  validateEventPayload,
  authenticateContainer,
  claimRun,
  setRunState,
  postEvents,
  releaseRun,
  putCheckpoint,
  getLatestCheckpoint,
  registerSseClient,
  unregisterSseClient,
  broadcastStopRequest,
  notifyRunEnqueued,
  hubStats,
  writeSseEvent,
} from '../src/internal.js';
import { FakeInternalPool, seedClaimable } from './fake-internal-pool.js';

test('validateTransition：合法/非法转换（portal.md §9.6）', () => {
  assert.equal(validateTransition('queued', 'running'), true);
  assert.equal(validateTransition('running', 'running'), true);
  assert.equal(validateTransition('running', 'finished'), true);
  assert.equal(validateTransition('running', 'failed'), true);
  assert.equal(validateTransition('cancelling', 'finished'), true);
  assert.equal(validateTransition('cancelling', 'failed'), true);
  // 非法：回退 / 跳过 running / 停止后回 running / 终态回退
  assert.equal(validateTransition('running', 'queued'), false);
  assert.equal(validateTransition('queued', 'finished'), false);
  assert.equal(validateTransition('queued', 'failed'), false);
  assert.equal(validateTransition('cancelling', 'running'), false);
  assert.equal(validateTransition('finished', 'running'), false);
  assert.equal(validateTransition('failed', 'running'), false);
});

test('assembleTicket：resume = attempt > 1（方案 B re-claim）', () => {
  const t1 = assembleTicket({
    queueId: 'q1', claimToken: 'ct1', leaseUntil: new Date('2026-09-12T00:01:30Z'),
    run: { id: 'run1', session_id: 's1', model: 'm' }, project: { name: 'p', root_path: '~/p' },
    message: { id: 'm1', content: 'hi', attachments: [] }, attempts: 1,
  });
  assert.equal(t1.run.attempt, 1);
  assert.equal(t1.run.resume, false);
  assert.equal(t1.lease_expires_at, '2026-09-12T00:01:30.000Z');
  assert.equal(t1.run.task, 'hi');

  const t2 = assembleTicket({
    queueId: 'q1', claimToken: 'ct2', leaseUntil: new Date('2026-09-12T00:03:00Z'),
    run: { id: 'run1', session_id: 's1', model: 'm' }, project: { name: 'p', root_path: '~/p' },
    message: null, attempts: 2,
  });
  assert.equal(t2.run.resume, true);
  assert.equal(t2.run.task, '');
});

test('canonicalJson/canonicalHash：键序无关的稳定规范化', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(canonicalHash({ a: 1, b: 2 }), canonicalHash({ b: 2, a: 1 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('isValidClientEventId：run_id:attempt:计数 格式', () => {
  assert.equal(isValidClientEventId('run1', 'run1:1:0'), true);
  assert.equal(isValidClientEventId('run1', 'run1:2:42'), true);
  assert.equal(isValidClientEventId('run1', 'run2:1:0'), false); // 前缀不匹配
  assert.equal(isValidClientEventId('run1', 'run1:1'), false); // 缺计数
  assert.equal(isValidClientEventId('run1', 'run1:x:0'), false); // attempt 非整数
  assert.equal(isValidClientEventId('run1', 'run1:1:abc'), false);
});

test('validateEventPayload：payload 必须为 JSON 对象', () => {
  assert.equal(validateEventPayload({ text: 'x' }), true);
  assert.equal(validateEventPayload(null), false);
  assert.equal(validateEventPayload([]), false);
  assert.equal(validateEventPayload('str'), false);
});

test('authenticateContainer：token 鉴权三路径（valid/invalid/revoked）', async () => {
  const { pool, userId, containerId, token } = seedClaimable();

  const ok = await authenticateContainer(pool, token);
  assert.equal(ok.container.id, containerId);
  assert.equal(ok.user.id, userId);

  await assert.rejects(() => authenticateContainer(pool, 'wrong'), (e) => e instanceof InternalError && e.status === 401 && e.code === 'token_invalid');
  await assert.rejects(() => authenticateContainer(pool, ''), (e) => e.code === 'token_invalid');

  // 吊销
  pool.containers[0].revoked_at = new Date();
  await assert.rejects(() => authenticateContainer(pool, token), (e) => e.code === 'token_revoked');
});

test('claimRun：领到任务返回 ticket（attempt=1/resume=false）；无任务返回 null', async () => {
  const { pool, userId, containerId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };

  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.ok(ticket);
  assert.equal(ticket.run.id, 'run1');
  assert.equal(ticket.run.attempt, 1);
  assert.equal(ticket.run.resume, false);
  assert.ok(ticket.claim_token);

  // 第二次 claim（无 pending）→ null（hold 短）
  const none = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(none, null);
});

test('claimRun：capacity/hold_ms 越界 → 400 validation_failed', async () => {
  const { pool, userId, containerId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  await assert.rejects(() => claimRun(pool, { container, user, capacity: 0, holdMs: 10 }), (e) => e.code === 'validation_failed');
  await assert.rejects(() => claimRun(pool, { container, user, capacity: 1, holdMs: 0 }), (e) => e.code === 'validation_failed');
  await assert.rejects(() => claimRun(pool, { container, user, capacity: 1, holdMs: 30001 }), (e) => e.code === 'validation_failed');
});

test('setRunState：queued→running 写 started_at；非法转换 409 invalid_transition', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;

  const r1 = await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });
  assert.equal(r1.state, 'running');
  assert.equal(pool.runs[0].status, 'running');

  // 非法：running → queued
  await assert.rejects(
    () => setRunState(pool, { container, user, runId, claimToken, body: { state: 'queued' } }),
    (e) => e.code === 'validation_failed' || e.code === 'invalid_transition',
  );
});

test('setRunState：终态收敛（finished）合成 run_end + usage_ledger + assistant 回写', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  const res = await setRunState(pool, {
    container, user, runId, claimToken,
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 3 }, rounds: 1, final_text: 'done' },
  });
  assert.equal(res.state, 'finished');
  assert.equal(pool.runs[0].status, 'finished');
  assert.ok(pool.events.some((e) => e.type === 'run_end' && e.client_event_id === 'run1:final:run_end'));
  assert.equal(pool.usage.length, 1);
  assert.ok(pool.messages.some((m) => m.content === 'done' && m.role === 'assistant'));
});

test('postEvents：seq 单调、无空洞；重复 client_event_id 幂等命中不耗 seq', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  const ev = (n) => ({ client_event_id: `run1:1:${n}`, type: 'assistant_delta', ts: null, payload: { text: `t${n}` } });
  const r1 = await postEvents(pool, { container, user, runId, claimToken, body: { batch_id: 'b1', events: [ev(0), ev(1), ev(2)] } });
  assert.deepEqual([r1.stored, r1.seq_first, r1.seq_last], [3, 1, 3]);

  // 重复批次：全幂等命中，不消耗 seq
  const r2 = await postEvents(pool, { container, user, runId, claimToken, body: { batch_id: 'b1', events: [ev(0), ev(1), ev(2)] } });
  assert.deepEqual([r2.stored, r2.seq_first, r2.seq_last], [0, null, null]);

  // 新批次：seq 从 4 继续（无空洞）
  const r3 = await postEvents(pool, { container, user, runId, claimToken, body: { batch_id: 'b2', events: [ev(3)] } });
  assert.deepEqual([r3.stored, r3.seq_first, r3.seq_last], [1, 4, 4]);

  const seqs = pool.events.map((e) => e.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test('releaseRun：attempts < max → requeue（attempts 不变）；re-claim 后 attempt 递增（方案 B）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(ticket.run.attempt, 1);

  const rel = await releaseRun(pool, { container, user, runId, claimToken: ticket.claim_token, body: { reason: 'worker_crashed' } });
  assert.equal(rel.outcome, 'requeued');
  assert.equal(rel.attempts, 1);
  assert.equal(pool.queue[0].status, 'pending');

  // re-claim 同一 run：attempts 递增到 2，resume=true
  const t2 = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(t2.run.id, runId);
  assert.equal(t2.run.attempt, 2);
  assert.equal(t2.run.resume, true);
});

test('putCheckpoint：revision CAS（前进 200 / 旧 revision 409 checkpoint_stale）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  const r1 = await putCheckpoint(pool, { container, user, runId, claimToken, body: { revision: 1, snapshot: { round: 1 } } });
  assert.equal(r1.revision, 1);

  const r2 = await putCheckpoint(pool, { container, user, runId, claimToken, body: { revision: 2, snapshot: { round: 2 } } });
  assert.equal(r2.revision, 2);

  await assert.rejects(
    () => putCheckpoint(pool, { container, user, runId, claimToken, body: { revision: 1, snapshot: { round: 0 } } }),
    (e) => e.code === 'checkpoint_stale',
  );

  const latest = await getLatestCheckpoint(pool, { container, user, runId, claimToken });
  assert.equal(latest.checkpoint.revision, 2);
});

test('SSE hub：register/broadcast/run_assigned/stop_request/unregister', async () => {
  const res = { written: [], destroyed: false, writableEnded: false, write(s) { this.written.push(s); } };
  registerSseClient('c1', 'u1', res);
  assert.equal(hubStats().sseClients, 1);

  broadcastStopRequest('u1', { run_id: 'run1', reason: 'stop' });
  assert.ok(res.written.some((s) => s.includes('event: stop_request')));
  assert.ok(res.written.some((s) => s.includes('"run_id":"run1"')));

  // 其它用户不收到
  const res2 = { written: [], write(s) { this.written.push(s); } };
  registerSseClient('c2', 'u2', res2);
  broadcastStopRequest('u1', { run_id: 'run1' });
  assert.equal(res2.written.length, 0);

  notifyRunEnqueued('u2', { run_id: 'runX', queue_id: 'qx' });
  assert.ok(res2.written.some((s) => s.includes('event: run_assigned')));

  unregisterSseClient('c1', res);
  unregisterSseClient('c2', res2);
  assert.equal(hubStats().sseClients, 0);

  // writeSseEvent 对已结束响应静默跳过
  const done = { writableEnded: true, write() { throw new Error('should not write'); } };
  writeSseEvent(done, 'ping', {});
  assert.ok(true);
});
