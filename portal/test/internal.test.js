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
  HISTORY_DEFAULTS,
  normalizeHistoryBudget,
  truncateHistory,
  validateEventPayload,
  authenticateContainer,
  claimRun,
  setRunState,
  postEvents,
  releaseRun,
  heartbeat,
  reapExpiredRuns,
  putCheckpoint,
  getLatestCheckpoint,
  saveRunState,
  loadRunState,
  registerSseClient,
  unregisterSseClient,
  broadcastStopRequest,
  broadcastRevoke,
  notifyRunEnqueued,
  hubStats,
  writeSseEvent,
  registerSessionClient,
  unregisterSessionClient,
  sessionClientGoLive,
  notifySessionEvents,
  SESSION_CLIENT_BUFFER_MAX,
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

test('assembleTicket：P5 cwd 权威下行 + project 快照兼容旧 agentd（双列过渡）', () => {
  const t = assembleTicket({
    queueId: 'q1', claimToken: 'ct1', leaseUntil: new Date('2026-09-12T00:01:30Z'),
    run: { id: 'run1', session_id: 's1', model: 'm', cwd: '~/projects/meeting_asr_app' },
    project: { name: 'meeting_asr_app', root_path: '~/projects/meeting_asr_app' },
    message: { id: 'm1', content: 'hi', attachments: [] }, attempts: 1,
  });
  assert.equal(t.run.cwd, '~/projects/meeting_asr_app');
  // project 快照保留（部署序 portal 先上、FDE 镜像后上：旧 agentd 只读 run.project）。
  assert.equal(t.run.project.name, 'meeting_asr_app');
  assert.equal(t.run.project.root_path, '~/projects/meeting_asr_app');

  // cwd 缺失（旧 DB 行未回填的极端态）→ 下行 null，agentd 侧回退 project.name。
  const legacy = assembleTicket({
    queueId: 'q1', claimToken: 'ct1', leaseUntil: new Date(),
    run: { id: 'run1', session_id: 's1', model: 'm' },
    project: { name: 'p', root_path: '~/projects/p' },
    message: null, attempts: 1,
  });
  assert.equal(legacy.run.cwd, null);
});

test('assembleTicket：git identity 优先用户邮箱、缺失时回退，身份不可得时不注入', () => {
  const base = {
    queueId: 'q1', claimToken: 'ct1', leaseUntil: new Date(),
    run: { id: 'run1', session_id: 's1', model: 'm' },
    project: { name: 'p', root_path: '~/p' }, message: null, attempts: 1,
  };
  const storedEmail = assembleTicket({
    ...base,
    gitIdentity: { login: 'alice', display_name: 'Alice Wong', email: 'alice@corp.example' },
    baseDomain: 'station.example',
  });
  assert.deepEqual(storedEmail.run.git_identity, { name: 'Alice Wong', email: 'alice@corp.example' });

  const fallbackEmail = assembleTicket({
    ...base,
    gitIdentity: { login: 'alice', display_name: null, email: null },
    baseDomain: 'station.example',
  });
  assert.deepEqual(fallbackEmail.run.git_identity, { name: 'alice', email: 'alice@station.example' });

  const noIdentity = assembleTicket({
    ...base,
    gitIdentity: { login: null, display_name: null, email: null },
    baseDomain: 'station.example',
  });
  assert.equal(Object.hasOwn(noIdentity.run, 'git_identity'), false);
});

test('truncateHistory：先按条数截尾（保最新），再按 UTF-8 字节从头丢到符合（issue #69）', () => {
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: 'user', content: `m${i + 1}` }));
  // 条数截尾：保最新 3 条
  assert.deepEqual(truncateHistory(msgs(5), { maxMessages: 3 }), [
    { role: 'user', content: 'm3' },
    { role: 'user', content: 'm4' },
    { role: 'user', content: 'm5' },
  ]);
  // 字节截断：maxBytes 内保最新丢最旧（中文 3 字节/字）
  const cn = [
    { role: 'user', content: '一二三四五六七八九十' }, // 30B
    { role: 'assistant', content: 'hello' },            // 5B
    { role: 'user', content: 'ab' },                    // 2B
  ];
  assert.deepEqual(truncateHistory(cn, { maxBytes: 10 }), [
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'ab' },
  ]);
  // 顺序：先条数后字节（条数截完再按字节丢）
  assert.deepEqual(
    truncateHistory(cn, { maxMessages: 2, maxBytes: 100 }),
    [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'ab' }],
  );
  // 非法入参
  assert.deepEqual(truncateHistory(null), []);
  assert.deepEqual(truncateHistory('x'), []);
  // 预算缺省用默认
  assert.deepEqual(truncateHistory(msgs(25)).length, HISTORY_DEFAULTS.maxMessages);
});

test('normalizeHistoryBudget：非正整数/缺省回退默认（issue #69）', () => {
  assert.deepEqual(normalizeHistoryBudget(), HISTORY_DEFAULTS);
  assert.deepEqual(normalizeHistoryBudget({ maxMessages: 0, maxBytes: -1 }), HISTORY_DEFAULTS);
  assert.deepEqual(normalizeHistoryBudget({ maxMessages: 'x', maxBytes: 1.5 }), HISTORY_DEFAULTS);
  assert.deepEqual(normalizeHistoryBudget({ maxMessages: 5, maxBytes: 100 }), { maxMessages: 5, maxBytes: 100 });
});

test('assembleTicket：history 注入与缺省（issue #69）', () => {
  const base = {
    queueId: 'q1', claimToken: 'ct1', leaseUntil: new Date('2026-09-12T00:01:30Z'),
    run: { id: 'run1', session_id: 's1', model: 'm' }, project: { name: 'p', root_path: '~/p' },
    message: { id: 'm1', content: 'hi', attachments: [] }, attempts: 1,
  };
  assert.deepEqual(assembleTicket(base).run.history, []);
  const h = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  assert.deepEqual(assembleTicket({ ...base, history: h }).run.history, h);
});

test('claimRun：history 下行——session 最近 user/assistant 升序、排除当前消息（issue #69）', async () => {
  const { pool, userId, containerId, runId, sessionId } = seedClaimable();
  // 现场：m0(assistant, seq0) m1(user 'hello'=当前消息, seq1) m2(assistant, seq2)；m3 属别的 session 不混入
  pool.messages.push(
    { id: 'm0', run_id: 'run0', session_id: sessionId, role: 'assistant', content: 'prev answer', seq: 0, attachments: [] },
    { id: 'm2', run_id: runId, session_id: sessionId, role: 'assistant', content: 'last answer', seq: 2, attachments: [] },
    { id: 'm3', run_id: 'runX', session_id: 'sX', role: 'assistant', content: 'other session', seq: 9, attachments: [] },
  );
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };

  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(ticket.run.cwd, '~/projects/proj1', 'P5：ticket 下行会话绑定 cwd（权威）');
  assert.equal(ticket.run.project.name, 'proj1', 'project 快照兼容旧 agentd');
  assert.deepEqual(ticket.run.history, [
    { role: 'assistant', content: 'prev answer' },
    { role: 'assistant', content: 'last answer' },
  ]);
});

test('claimRun：history 预算注入——条数截断与字节截断（issue #69）', async () => {
  const { pool, userId, containerId, runId, sessionId } = seedClaimable();
  // seq1 为当前消息（seed 自带）；seq2..6 五条 assistant 历史
  for (let i = 2; i <= 6; i += 1) {
    pool.messages.push({ id: `m${i}`, run_id: runId, session_id: sessionId, role: 'assistant', content: `ans${i}`, seq: i, attachments: [] });
  }
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };

  // 条数：maxMessages=3 → 保最新 3 条（ans4/5/6），升序
  const t1 = await claimRun(pool, { container, user, capacity: 1, holdMs: 10, historyBudget: { maxMessages: 3, maxBytes: 16384 } });
  assert.deepEqual(t1.run.history, [
    { role: 'assistant', content: 'ans4' },
    { role: 'assistant', content: 'ans5' },
    { role: 'assistant', content: 'ans6' },
  ]);

  // 重置现场再测字节：maxBytes=10 → 'ans4'(4B)+'ans5'(4B)+'ans6'(4B)=12B → 丢最旧 ans4，保 ans5/ans6
  const { pool: pool2, userId: u2, containerId: c2 } = seedClaimable();
  for (let i = 2; i <= 6; i += 1) {
    pool2.messages.push({ id: `m${i}`, run_id: 'run1', session_id: 's1', role: 'assistant', content: `ans${i}`, seq: i, attachments: [] });
  }
  const t2 = await claimRun(pool2, { container: { id: c2, user_id: u2 }, user: { id: u2, login: 'alice' }, capacity: 1, holdMs: 10, historyBudget: { maxMessages: 20, maxBytes: 10 } });
  assert.deepEqual(t2.run.history, [
    { role: 'assistant', content: 'ans5' },
    { role: 'assistant', content: 'ans6' },
  ]);

  // 非法注入值回退默认（20 条上限内全保留 5 条）
  const { pool: pool3, userId: u3, containerId: c3 } = seedClaimable();
  for (let i = 2; i <= 6; i += 1) {
    pool3.messages.push({ id: `m${i}`, run_id: 'run1', session_id: 's1', role: 'assistant', content: `ans${i}`, seq: i, attachments: [] });
  }
  const t3 = await claimRun(pool3, { container: { id: c3, user_id: u3 }, user: { id: u3, login: 'alice' }, capacity: 1, holdMs: 10, historyBudget: { maxMessages: 0, maxBytes: -5 } });
  assert.equal(t3.run.history.length, 5);
  assert.equal(t3.run.history[0].content, 'ans2');
});

test('claimRun：history 查询抛错 → best-effort 回退空历史，claim 不阻断（issue #69 评审修正）', async () => {
  const { pool, userId, containerId, sessionId } = seedClaimable();
  pool.messages.push(
    { id: 'm0', run_id: 'run0', session_id: sessionId, role: 'assistant', content: 'prev answer', seq: 0, attachments: [] },
  );
  // 注入：history 查询抛错（模拟 DB 抖动），其余查询正常——对齐 fake pool 风格，包一层委托。
  const origQuery = pool.query.bind(pool);
  pool.query = (sql, params) => {
    if (sql.includes('FROM messages') && sql.includes('role IN')) {
      return Promise.reject(new Error('history query db down'));
    }
    return origQuery(sql, params);
  };
  const warns = [];
  const log = { warn: (msg) => warns.push(msg) };

  const ticket = await claimRun(pool, { container: { id: containerId, user_id: userId }, user: { id: userId, login: 'alice' }, capacity: 1, holdMs: 10, log });
  assert.ok(ticket); // claim 仍成功（UPDATE run_queue 已生效，ticket 照常发出）
  assert.equal(ticket.run.id, 'run1');
  assert.deepEqual(ticket.run.history, []); // 历史回退空数组
  assert.equal(warns.length, 1); // warn 只记 err 摘要
  assert.ok(warns[0].includes('history query failed'));
  assert.ok(warns[0].includes('history query db down'));
  assert.ok(!warns[0].includes('prev answer')); // 红线：history 内容不入日志
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
  assert.equal(ok.user.display_name, 'Alice');
  assert.equal(ok.user.email, 'alice@example.test');

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

test('claimRun：下行 git identity 使用用户 email 或 baseDomain 回退', async () => {
  const { pool, userId, containerId } = seedClaimable();
  const ticket = await claimRun(pool, {
    container: { id: containerId, user_id: userId },
    user: { id: userId, login: 'alice', display_name: 'Alice', email: null },
    capacity: 1,
    holdMs: 10,
    baseDomain: 'station.example',
  });
  assert.deepEqual(ticket.run.git_identity, { name: 'Alice', email: 'alice@station.example' });
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

test('saveRunState/loadRunState：run_state 合并写 + 引擎终态标记（mark）+ 终态后读放宽（0.9.0 八方法契约）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  // loadRunState：无 → null
  assert.equal(await loadRunState(pool, { container, user, runId, claimToken }), null);

  // saveRunState 全量合并（reference 语义 = previous + state）
  await saveRunState(pool, { container, user, runId, claimToken, body: { run_state: { stateVersion: 3, deterministic: { rounds: 2 } } } });
  await saveRunState(pool, { container, user, runId, claimToken, body: { run_state: { semantic: { text: 'summary', version: 1 } } } });

  // markRunState 终态标记（引擎 succeeded）只合并 state 字段，不动 runs.status
  await saveRunState(pool, { container, user, runId, claimToken, body: { state: 'succeeded' } });

  const state = await loadRunState(pool, { container, user, runId, claimToken });
  assert.equal(state.run_state.state, 'succeeded');
  assert.equal(state.run_state.stateVersion, 3);
  assert.deepEqual(state.run_state.deterministic, { rounds: 2 });
  assert.deepEqual(state.run_state.semantic, { text: 'summary', version: 1 });
  assert.equal(pool.runs[0].status, 'running', 'mark 不触碰 runs.status');

  // 校验失败：非对象 run_state / 空 body
  await assert.rejects(
    () => saveRunState(pool, { container, user, runId, claimToken, body: { run_state: 'nope' } }),
    (e) => e.code === 'validation_failed',
  );
  await assert.rejects(
    () => saveRunState(pool, { container, user, runId, claimToken, body: {} }),
    (e) => e.code === 'validation_failed',
  );

  // 终态后写 409 run_terminal；终态后读仍放宽可读
  await setRunState(pool, {
    container, user, runId, claimToken,
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 2 }, rounds: 1, final_text: 'ok' },
  });
  await assert.rejects(
    () => saveRunState(pool, { container, user, runId, claimToken: null, body: { run_state: { stateVersion: 4 } } }),
    (e) => e.code === 'run_terminal',
  );
  const after = await loadRunState(pool, { container, user, runId, claimToken: null });
  assert.equal(after.run_state.state, 'succeeded', '终态后仍可读');
});

test('saveRunState：F2 原子写——租约过期/re-claim 后旧 worker 的迟到写被 fencing（409 lease_lost，状态不被覆盖）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const t1 = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  await setRunState(pool, { container, user, runId, claimToken: t1.claim_token, body: { state: 'running' } });

  // 旧 worker（token t1）正常写一次
  await saveRunState(pool, { container, user, runId, claimToken: t1.claim_token, body: { run_state: { stateVersion: 1, sentinel: 'attempt1' } } });

  // ① 租约过期（未 re-claim）：t1 再写 → 409 lease_lost，已落库状态不被覆盖
  pool.queue[0].lease_until = Date.now() - 1000;
  await assert.rejects(
    () => saveRunState(pool, { container, user, runId, claimToken: t1.claim_token, body: { run_state: { sentinel: 'stale-write' } } }),
    (e) => e.code === 'lease_lost',
  );
  // 读端点在此场景同样要求有效租约（run 未终态），直接查 fake 行验证「写未生效」。
  assert.equal(pool.runs[0].run_state.sentinel, 'attempt1', '过期租约的写未生效');

  // ② re-claim（attempt 2，新 token t2）：旧 token t1 的迟到写被 fencing；新 token 可写
  const t2 = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(t2.run.attempt, 2);
  await assert.rejects(
    () => saveRunState(pool, { container, user, runId, claimToken: t1.claim_token, body: { run_state: { sentinel: 'old-owner-overwrite' } } }),
    (e) => e.code === 'lease_lost',
  );
  assert.equal(pool.runs[0].run_state.sentinel, 'attempt1', 're-claim 后旧 token 写未生效');

  await saveRunState(pool, { container, user, runId, claimToken: t2.claim_token, body: { run_state: { sentinel: 'attempt2' } } });
  const state = await loadRunState(pool, { container, user, runId, claimToken: t2.claim_token });
  assert.equal(state.run_state.sentinel, 'attempt2', '新租约持有者可写');
  assert.equal(state.run_state.stateVersion, 1, '合并语义保留（jsonb || patch）');
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

test('F1：租约过期 fencing——heartbeat/state/events 全 lease_lost（不续租不写）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;

  // 把 lease_until 改到过去（评审实测：过期 lease 仍被续/写）。
  pool.queue[0].lease_until = Date.now() - 1000;

  // heartbeat：过期租约不得续期，返回 run 级 lease_lost。
  const hb = await heartbeat(pool, { container, user, body: { agent_version: '0.1', runs: [{ run_id: runId, status: 'running', worker_pid: 1, claim_token: claimToken }] } });
  assert.equal(hb.runs[0].lease, 'lease_lost');
  assert.equal(hb.runs[0].reason, 'expired');
  assert.ok(pool.queue[0].lease_until < Date.now(), '过期租约未被续期');

  // state running → 409 lease_lost。
  await assert.rejects(
    () => setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'lease_lost',
  );

  // events → 409 lease_lost。
  await assert.rejects(
    () => postEvents(pool, { container, user, runId, claimToken, body: { batch_id: 'b', events: [{ client_event_id: 'run1:1:0', type: 'assistant_delta', ts: null, payload: { text: 'x' } }] } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'lease_lost',
  );
});

test('F2：reaper 收敛——过期 claimed 行按矩阵（requeue/耗尽/cancelling）', async () => {
  // ① attempts < max → requeue（attempts 不变）
  const a = seedClaimable({ runId: 'run-a', containerId: 'c1', userId: 'u1' });
  const u = { id: 'u1', login: 'alice' };
  const container = { id: 'c1', user_id: 'u1' };
  const ta = await claimRun(a.pool, { container, user: u, capacity: 1, holdMs: 10 });
  a.pool.runs[0].status = 'running';
  a.pool.queue[0].lease_until = Date.now() - 1000;
  const ra = await reapExpiredRuns(a.pool);
  assert.equal(ra[0].outcome, 'requeued');
  assert.equal(a.pool.queue[0].status, 'pending');
  assert.equal(a.pool.runs[0].status, 'queued');
  assert.equal(a.pool.queue[0].attempts, 1, 'reaper 回 pending 不递增 attempts');

  // ② attempts >= max → done + failed(max_attempts_exceeded) + run_end
  const b = seedClaimable({ runId: 'run-b', containerId: 'c1', userId: 'u1' });
  const tb = await claimRun(b.pool, { container, user: u, capacity: 1, holdMs: 10 });
  b.pool.runs[0].status = 'running';
  b.pool.queue[0].attempts = 3;
  b.pool.queue[0].max_attempts = 3;
  b.pool.queue[0].lease_until = Date.now() - 1000;
  const rb = await reapExpiredRuns(b.pool);
  assert.equal(rb[0].outcome, 'failed_max_attempts');
  assert.equal(b.pool.queue[0].status, 'done');
  assert.equal(b.pool.runs[0].status, 'failed');
  assert.ok(b.pool.events.some((e) => e.type === 'run_end' && e.client_event_id === 'run-b:final:run_end'), '耗尽终态合成 run_end');

  // ③ cancelling → cancelled + finished(aborted) + run_end
  const c = seedClaimable({ runId: 'run-c', containerId: 'c1', userId: 'u1' });
  const tc = await claimRun(c.pool, { container, user: u, capacity: 1, holdMs: 10 });
  c.pool.runs[0].status = 'cancelling';
  c.pool.queue[0].lease_until = Date.now() - 1000;
  const rc = await reapExpiredRuns(c.pool);
  assert.equal(rc[0].outcome, 'cancelled');
  assert.equal(c.pool.queue[0].status, 'cancelled');
  assert.equal(c.pool.runs[0].status, 'finished');
  assert.ok(c.pool.events.some((e) => e.type === 'run_end' && e.client_event_id === 'run-c:final:run_end'), 'cancelling 终态合成 run_end');
});

test('F3：U12 release 终态分支（cancelling / 耗尽）合成 run_end', async () => {
  // cancelling → finished + run_end
  const a = seedClaimable({ runId: 'run-a', containerId: 'c1', userId: 'u1' });
  const container = { id: 'c1', user_id: 'u1' };
  const user = { id: 'u1', login: 'alice' };
  const ta = await claimRun(a.pool, { container, user, capacity: 1, holdMs: 10 });
  a.pool.runs[0].status = 'cancelling';
  await releaseRun(a.pool, { container, user, runId: 'run-a', claimToken: ta.claim_token, body: { reason: 'stop' } });
  assert.equal(a.pool.runs[0].status, 'finished');
  assert.ok(a.pool.events.some((e) => e.type === 'run_end' && e.client_event_id === 'run-a:final:run_end'), 'cancelling release 合成 run_end');

  // 耗尽 → failed + run_end
  const b = seedClaimable({ runId: 'run-b', containerId: 'c1', userId: 'u1' });
  const tb = await claimRun(b.pool, { container, user, capacity: 1, holdMs: 10 });
  b.pool.queue[0].attempts = 3;
  b.pool.queue[0].max_attempts = 3;
  await releaseRun(b.pool, { container, user, runId: 'run-b', claimToken: tb.claim_token, body: { reason: 'worker_crashed' } });
  assert.equal(b.pool.runs[0].status, 'failed');
  assert.ok(b.pool.events.some((e) => e.type === 'run_end' && e.client_event_id === 'run-b:final:run_end'), '耗尽 release 合成 run_end');
});

// issue #88 修订：worker 侧生成的会话标题随终态上报——finishRun 收包校验（字符串、截断 ≤200）。
test('U2 finish：title 字段校验——非字符串 400；超长字符串截断放行（fire-and-forget 评估落库）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  // 非字符串 → 400 validation_failed（title 是可选增强字段，类型错不静默吞）。
  await assert.rejects(
    () => setRunState(pool, {
      container, user, runId, claimToken,
      body: { state: 'finished', termination: { reason: 'end_turn' }, title: 42 },
    }),
    (e) => e instanceof InternalError && e.status === 400 && e.code === 'validation_failed',
  );
  assert.equal(pool.runs[0].status, 'running', '校验失败不写终态');

  // 超长字符串（>200 字符）→ 截断后放行（fire-and-forget 评估链，不阻塞终态响应）。
  const res = await setRunState(pool, {
    container, user, runId, claimToken,
    body: { state: 'finished', termination: { reason: 'end_turn' }, title: '长'.repeat(500), final_text: 'done' },
  });
  assert.equal(res.state, 'finished');
});

test('F4：U2 finish 同载荷重放幂等（200），载荷不同 409 run_terminal', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;
  await setRunState(pool, { container, user, runId, claimToken, body: { state: 'running' } });

  const payload = { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 3 }, rounds: 1, final_text: 'done' };
  const r1 = await setRunState(pool, { container, user, runId, claimToken, body: payload });
  assert.equal(r1.state, 'finished');

  // 同载荷重放 → 200 幂等成功（不再 409）。
  const r2 = await setRunState(pool, { container, user, runId, claimToken, body: { ...payload } });
  assert.equal(r2.state, 'finished');
  assert.equal(r2.idempotent, true);

  // 载荷不同（usage）→ 409 run_terminal。
  await assert.rejects(
    () => setRunState(pool, { container, user, runId, claimToken, body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 9, output_tokens: 2 }, rounds: 1 } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'run_terminal',
  );

  // M4：载荷不同（final_text）→ 同样 409（final_text 落 messages，幂等比对必须含它）。
  await assert.rejects(
    () => setRunState(pool, { container, user, runId, claimToken, body: { ...payload, final_text: 'different' } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'run_terminal',
  );
});

test('F5：U12 release 同 claim_token 重放幂等（不 409）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const claimToken = ticket.claim_token;

  const r1 = await releaseRun(pool, { container, user, runId, claimToken, body: { reason: 'worker_crashed' } });
  assert.equal(r1.outcome, 'requeued');

  // 同 claim_token 重放 → 幂等返回首次结果（不 409）。
  const r2 = await releaseRun(pool, { container, user, runId, claimToken, body: { reason: 'worker_crashed' } });
  assert.equal(r2.outcome, 'requeued');
  assert.equal(r2.run_status, 'queued');
  assert.equal(r2.queue_status, 'pending');

  // token 不匹配 → 409 lease_lost。
  await assert.rejects(
    () => releaseRun(pool, { container, user, runId, claimToken: 'wrong-token', body: { reason: 'x' } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'lease_lost',
  );
});

test('F6：setRunState CAS 查影响行数——伪造 token 不得返回成功', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });

  // 伪造 token：UPDATE 命中 0 行 → 409 lease_lost，且 runs.status 保持 queued。
  await assert.rejects(
    () => setRunState(pool, { container, user, runId, claimToken: 'forged-token', body: { state: 'running' } }),
    (e) => e instanceof InternalError && e.status === 409 && e.code === 'lease_lost',
  );
  assert.equal(pool.runs[0].status, 'queued');
});

test('F7：revoke 后已建 SSE 连接被服务端主动关闭', async () => {
  const res = { written: [], ended: false, destroyed: false, writableEnded: false, write(s) { this.written.push(s); }, end() { this.ended = true; } };
  registerSseClient('c1', 'u1', res);
  assert.equal(hubStats().sseClients, 1);

  broadcastRevoke('c1', { reason: 'offboarded' });
  assert.ok(res.written.some((s) => s.includes('event: revoke')));
  assert.equal(res.ended, true, 'revoke 后连接被 res.end() 关闭');
  assert.equal(hubStats().sseClients, 0, 'revoke 后客户端注销');
});

// ---- B：session hub 缓冲溢出 → resync（portal.md §5.1/§5.2） ----

function fakeSseRes() {
  return {
    written: [], ended: false, destroyed: false, writableEnded: false,
    write(s) { this.written.push(s); },
    end() { this.ended = true; this.writableEnded = true; },
  };
}
const sessionEvent = (seq, type = 'assistant_delta', payload = { text: `t${seq}` }) => ({
  seq, ts: '2026-09-12T00:00:00.000Z', run_id: 'run-x', type, payload,
});

test('B：session hub 缓冲未满 → 不重同步（事件进缓冲，连接不关）', () => {
  const res = fakeSseRes();
  const rec = registerSessionClient('s-buffer-ok', res);
  notifySessionEvents('s-buffer-ok', Array.from({ length: SESSION_CLIENT_BUFFER_MAX }, (_, i) => sessionEvent(i + 1)));
  assert.equal(rec.buffer.length, SESSION_CLIENT_BUFFER_MAX, '缓冲到上限');
  assert.equal(res.ended, false, '未溢出不 end()');
  assert.equal(res.written.length, 0, '未 live 客户端不直接写（先缓冲）');
  // 转 live 后 flush 缓冲（带 id: <seq>）
  sessionClientGoLive('s-buffer-ok', rec);
  assert.equal(res.written.length, SESSION_CLIENT_BUFFER_MAX);
  assert.ok(res.written[0].includes(`id: 1\n`));
  unregisterSessionClient('s-buffer-ok', rec);
});

test('B：session hub 缓冲溢出 → 写 resync 帧（reason，不带 last_seq）+ res.end()，并从 map 移除', () => {
  const res = fakeSseRes();
  const rec = registerSessionClient('s-overflow', res);
  notifySessionEvents('s-overflow', Array.from({ length: SESSION_CLIENT_BUFFER_MAX }, (_, i) => sessionEvent(i + 1)));
  assert.equal(res.ended, false);

  // 第 1001 条事件：超过 SESSION_CLIENT_BUFFER_MAX → 不再静默丢弃，改判重同步
  notifySessionEvents('s-overflow', [sessionEvent(SESSION_CLIENT_BUFFER_MAX + 1)]);
  const frames = res.written.map((s) => s.trim()).filter(Boolean);
  const resyncFrame = frames.find((s) => s.includes('event: resync'));
  assert.ok(resyncFrame, `写入 resync 帧：${JSON.stringify(res.written)}`);
  assert.ok(resyncFrame.includes('"reason":"buffer_overflow"'));
  assert.ok(!resyncFrame.includes('last_seq'), 'F6：resync 帧不带 last_seq（重连游标以客户端本地水位线为准）');
  // 服务端仍跟踪 rec.lastSeq（仅内部状态，不再下发）
  assert.equal(rec.lastSeq, SESSION_CLIENT_BUFFER_MAX, 'lastSeq 内部仍跟踪已推/已缓冲的最大 seq');
  assert.equal(res.ended, true, '溢出后 res.end() 关闭连接（浏览器随之重连带 Last-Event-ID）');

  // 已从 map 移除：后续事件不再写入该连接
  const writes = res.written.length;
  notifySessionEvents('s-overflow', [sessionEvent(SESSION_CLIENT_BUFFER_MAX + 2)]);
  assert.equal(res.written.length, writes, '重同步后 rec 已摘除，不再推送');
  assert.equal(rec.buffer.length, 0, '缓冲已清空（防脏状态常驻）');
  assert.equal(hubStats().sessionClients, 0, 'resync 后 session hub 无残留客户端');
});

test('B：session hub 溢出只影响溢出客户端；live 客户端继续收事件', () => {
  const live = fakeSseRes();
  const liveRec = registerSessionClient('s-multi', live);
  sessionClientGoLive('s-multi', liveRec);

  const slow = fakeSseRes();
  const slowRec = registerSessionClient('s-multi', slow);
  notifySessionEvents('s-multi', Array.from({ length: SESSION_CLIENT_BUFFER_MAX + 1 }, (_, i) => sessionEvent(i + 1)));

  assert.equal(slow.ended, true, '未 live 且溢出的客户端被重同步');
  assert.ok(slow.written.some((s) => s.includes('event: resync')));
  assert.equal(live.ended, false, 'live 客户端不受影响');
  assert.equal(live.written.length, SESSION_CLIENT_BUFFER_MAX + 1, 'live 客户端逐条收到');
  assert.equal(slowRec.resync, true);
  unregisterSessionClient('s-multi', liveRec);
  assert.equal(hubStats().sessionClients, 0);
});

// ---------------------------------------------------------------------------
// issue #117：heartbeat carries LiteLLM serving names while Station stores model_info.id slots.
// ---------------------------------------------------------------------------

/** 心跳 models 现场构造：active LiteLLM binding + three text-valued model slots. */
function seedLlmHeartbeat(overrides = {}) {
  const base = seedClaimable();
  base.pool.llm.bindings = [{
    fde_id: base.userId, gateway: 'litellm', api_key: 'sk-test-virtual', state: 'active', provider_id: 'credential',
    main_model_id: 'model-info-id-main', main_model_name: 'deepseek-flash',
    embedding_model_id: 'model-info-id-embedding', embedding_model_name: 'deepseek-flash',
    vision_model_id: 'model-info-id-vision', vision_model_name: 'deepseek-flash',
  }];
  Object.assign(base.pool.llm, overrides.llm ?? {});
  if (overrides.binding) Object.assign(base.pool.llm.bindings[0], overrides.binding);
  return base;
}

test('心跳下行模型集：DB 存 model_info.id，agent 收到 deepseek-flash serving name', async () => {
  const { pool, userId, containerId } = seedLlmHeartbeat();
  const hb = await heartbeat(pool, {
    container: { id: containerId, user_id: userId },
    user: { id: userId, login: 'alice' },
    body: { agent_version: '0.1', runs: [] },
  });
  assert.deepEqual(hb.models, {
    main: { model: 'deepseek-flash', type: 'text' },
    embedding: { model: 'deepseek-flash', type: 'embedding' },
    vision: { model: 'deepseek-flash', type: 'vision' },
  });
});

test('心跳下行模型集：仅 main 位 → 只下发 main；binding revoked / 无配置 → models=null（不下发空对象）', async () => {
  // 仅 main（无 embedding/vision 位）
  const a = seedLlmHeartbeat({ binding: { embedding_model_id: null, vision_model_id: null } });
  const hbA = await heartbeat(a.pool, {
    container: { id: a.containerId, user_id: a.userId },
    user: { id: a.userId, login: 'alice' },
    body: { runs: [] },
  });
  assert.deepEqual(hbA.models, { main: { model: 'deepseek-flash', type: 'text' } });

  // revoked → null
  const b = seedLlmHeartbeat({ binding: { state: 'revoked' } });
  const hbB = await heartbeat(b.pool, {
    container: { id: b.containerId, user_id: b.userId },
    user: { id: b.userId, login: 'alice' },
    body: { runs: [] },
  });
  assert.equal(hbB.models, null);

  // 无 binding 行 → null
  const c = seedLlmHeartbeat({ llm: { bindings: [] } });
  const hbC = await heartbeat(c.pool, {
    container: { id: c.containerId, user_id: c.userId },
    user: { id: c.userId, login: 'alice' },
    body: { runs: [] },
  });
  assert.equal(hbC.models, null);
});

test('心跳下行模型集：无 virtual key → models=null（未绑定时不下发半残配置）', async () => {
  const a = seedLlmHeartbeat({ binding: { api_key: null } });
  const hbA = await heartbeat(a.pool, {
    container: { id: a.containerId, user_id: a.userId },
    user: { id: a.userId, login: 'alice' },
    body: { runs: [] },
  });
  assert.equal(hbA.models, null);
});
