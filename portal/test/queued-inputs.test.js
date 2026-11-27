// issue #370：输入队列核心的单测。
//
// 用「按 SQL 片段路由的内存假池」而不是真 PG（本站惯例，见 test/fake-pool.js / fake-internal-pool.js）：
// 本文件要钉的是**判定**（谁该投、谁不该投、谁被谁抢先），不是 SQL 方言。SQL 本身的形状由
// `queued-inputs-sql.test.js` 的字面断言兜住（CHECK 值域、status 迁移、status<>cancelling 那类）。
//
// `postMessage` 用注入的假实现：它是本站唯一的发送路（#261B 红线），队列只是它的第二个调用方。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueueQueuedInput, recallQueuedInputs, drainQueuedInputs, drainAfterRunTerminal,
  validateQueuedKind, toSnapshot, MAX_QUEUED_INPUTS_PER_SESSION,
} from '../src/queued-inputs.js';
import { createUserActivityWorld } from './fake-user-activity.js';
import { notifyQueueUpdate as internalNotifyQueueUpdate, registerSessionClient, unregisterSessionClient } from '../src/internal.js';

// ---------------------------------------------------------------------------
// 内存世界
// ---------------------------------------------------------------------------
// 必须过 `sessions.js` 的 UUID_RE（fetchSession 在校验之前就拒非 UUID ⇒ 假池根本走不到）
const SID = '11111111-1111-4111-8111-111111111111';

function world(overrides = {}) {
  const w = {
    // sessions.js#fetchSession 先过 UUID_RE（非 UUID 直接 404），所以假 id 必须是真 UUID 形状
    session: { id: SID, user_id: 'u1', status: 'active', cwd: '/w', title: null, project_id: null, last_seq: 0 },
    activeRun: { id: 'r1', status: 'running' },   // null = 无活跃 run
    containerUp: true,
    queued: [],          // queued_inputs 行
    postCalls: [],       // 传给 postMessage 的参数
    postImpl: null,      // 覆盖默认投递行为
    notifies: [],        // queue_update 推送（含 blocked 原因）
    steers: [],          // steer_request 推送
    runEnqueues: [],     // notifyRunEnqueued
    now: 0,
    // issue #497：入队那一刻的用户活动位（写入点之二）。`activity.writes` 是「写了几次 / 写给了谁」的判据面。
    users: [{ id: 'u1', last_activity_at: new Date(0) }],
    ...overrides,
  };
  w.activity = createUserActivityWorld({ users: w.users });
  let seq = 0;
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) { return query(sql, params); },
        release() {},
      };
    },
    async query(sql, params = []) { return query(sql, params); },
  };
  async function query(sql, params) {
    // 事务壳：内存世界不做真回滚（每个分支本身是幂等赋值），只需不被当成未知 SQL 抛错。
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) return { rows: [] };
    // --- 会话行（fetchSession）---
    if (/FROM chat_sessions/.test(sql) && /id = \$1/.test(sql)) {
      if (!w.session || w.session.id !== params[0]) return { rows: [] };
      return { rows: [{ ...w.session }] };
    }
    // --- 活跃 run ---
    if (/FROM runs r/.test(sql) && /status IN \('queued', 'running', 'cancelling'\)/.test(sql)) {
      return { rows: w.activeRun ? [{ ...w.activeRun }] : [] };
    }
    // --- 终态取数（drainAfterRunTerminal）---
    if (/FROM runs r JOIN chat_sessions/.test(sql)) {
      if (!w.activeRun && !w.endedRun) return { rows: [] };
      const ended = w.endedRun ?? { id: 'r1', termination: w.termination ?? null };
      return { rows: [{ id: ended.id, session_id: w.session.id, termination: ended.termination ?? null, user_id: w.session.user_id, session_status: w.session.status }] };
    }
    // --- 容器闸门 ---
    if (/FROM containers/.test(sql)) {
      return { rows: w.containerUp ? [{ '?column?' : 1 }] : [] };
    }
    // --- 计数 ---
    if (/COUNT\(\*\)::int/.test(sql)) {
      return { rows: [{ n: w.queued.filter((q) => q.status === 'pending' || q.status === 'delivering').length }] };
    }
    // --- 入队 ---
    if (/INSERT INTO queued_inputs/.test(sql)) {
      const [session_id, user_id, kind, content, attachments, interrupted_run_id] = params;
      const position = w.now++;
      const row = {
        id: `q${seq++}`, session_id, user_id, kind, content,
        attachments: JSON.parse(attachments ?? '[]'), interrupted_run_id,
        position, status: 'pending', created_at: new Date(0),
      };
      w.queued.push(row);
      return { rows: [row] };
    }
    // --- steer 的停止意图（只打时间戳，不动 status）---
    if (/UPDATE runs SET cancel_requested_at/.test(sql)) {
      if (w.activeRun && w.activeRun.status === 'running') w.cancelFlagged = params[0];
      return { rows: [] };
    }
    // --- 整队取回 ---
    // 必须与产品 SQL 同步认「过期的 delivering」（`w.staleIds`）：#848 评审 MED 之后取回不再只动
    // pending —— 认领后崩溃的行若不认过期，就既不投递也取不回，用户只看到「队列里还有 1 条」且没有原因。
    if (/UPDATE queued_inputs SET status = 'recalled'/.test(sql)) {
      // ⚠ 假池必须**照着 SQL 字面**决定认不认过期行，否则这条用例只能证明假池自己一致：
      // 产品 SQL 里没有 `claimed_at < now()` 这一段 ⇒ 这里也只取 pending（变异才会红）。
      const staleAware = /claimed_at < now\(\)/.test(sql);
      const rows = w.queued.filter((q) => q.session_id === params[0]
        && (q.status === 'pending'
          || (staleAware && q.status === 'delivering' && w.staleIds?.has(q.id))));
      for (const q of rows) q.status = 'recalled';
      return { rows: rows.map((q) => ({ id: q.id, kind: q.kind, content: q.content })) };
    }
    // --- 队头查询（含「组内第一条」的 NOT EXISTS 自连接）---
    // 必须与产品 SQL 同步认「过期的 delivering」（`w.staleIds`），否则这条测试只能证明假池自己一致。
    if (/FROM queued_inputs q/.test(sql)) {
      const claimable = (q) => q.session_id === params[0]
        && (q.status === 'pending' || (q.status === 'delivering' && w.staleIds?.has(q.id)));
      const pending = w.queued.filter(claimable)
        .sort((a, b) => (a.kind === b.kind ? a.position - b.position : a.kind === 'steer' ? -1 : 1));
      return { rows: pending[0] ? [{ id: pending[0].id, kind: pending[0].kind, content: pending[0].content, attachments: pending[0].attachments }] : [] };
    }
    // --- 「这次 abort 是不是转向」 ---
    if (/kind = 'steer' AND interrupted_run_id = \$1/.test(sql)) {
      return { rows: w.queued.some((q) => q.kind === 'steer' && q.interrupted_run_id === params[0]) ? [{ '?column?' : 1 }] : [] };
    }
    // --- 认领 CAS ---
    if (/SET status = 'delivering'/.test(sql)) {
      // CAS 的准入与 pick 同谓词：pending 或（delivering 且已过期）
      const row = w.queued.find((q) => q.id === params[0]
        && (q.status === 'pending' || (q.status === 'delivering' && w.staleIds?.has(q.id))));
      if (!row) return { rows: [] };
      row.status = 'delivering';
      return { rows: [{ id: row.id, kind: row.kind, content: row.content, attachments: row.attachments }] };
    }
    if (/SET status = 'pending', claimed_at = NULL/.test(sql)) {
      const row = w.queued.find((q) => q.id === params[0]);
      if (row) row.status = 'pending';
      return { rows: [] };
    }
    if (/SET status = 'discarded'/.test(sql)) {
      const row = w.queued.find((q) => q.id === params[0]);
      if (row) row.status = 'discarded';
      return { rows: [] };
    }
    // --- issue #497：用户活动位（入队即活动；同事务，见 queued-inputs.js 的注释）---
    {
      const hit = w.activity.query(sql, params);
      if (hit) return hit;
    }
    if (/SET status = 'delivered'/.test(sql)) {
      const row = w.queued.find((q) => q.id === params[0] && q.status === 'delivering');
      if (row) { row.status = 'delivered'; row.run_id = params[1]; }
      return { rows: row ? [{ id: row.id }] : [] };
    }
    throw new Error(`假池未覆盖的 SQL: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  // postMessage 的替身：默认成功建一个 run
  const deps = {
    notifyRunEnqueued: ({ runId }) => { w.runEnqueues.push(runId); },
    notifyQueueUpdate: (sessionId, blocked = null, deliveredRunId = null, delivered = null) => { w.notifies.push({ sessionId, blocked, deliveredRunId, delivered }); },
    notifySteerRequest: (userId, payload) => { w.steers.push({ userId, ...payload }); },
  };
  w.deps = deps;
  w.pool = pool;
  w.post = (args) => {
    w.postCalls.push(args);
    const out = w.postImpl
      ? w.postImpl(args)
      : { message: { id: `m${seq++}`, seq: 1, role: 'user' }, run: { id: `run${seq++}` } };
    // 真 postMessage 在 COMMIT 之后调 `notify({runId,userId,sessionId})`（sessions.js:682）。
    // 替身必须照做，否则「队列投递也要推 run_assigned」这条契约就没地方被钉住
    // （漏推 = run 躺在库里等 15s 心跳节拍才被 claim，界面表现为「点了要等一下」）。
    if (out?.run?.id) args.notify?.({ runId: out.run.id, userId: args.userId, sessionId: args.sessionId });
    return out;
  };
  return w;
}

// 唯一发送路的替身经 `deps.postMessage` 注入（默认值是 `sessions.js#postMessage`，见模块头注）：
// 重建整条发送路的 SQL 世界（LLM 绑定 / 容器 / seq / transcript / 建 run / outbox）对本文件的
// 判定表毫无加成，只会让第一条改 SQL 的 PR 就来这里改假池。
function withFakePostMessage(w, fn) {
  const deps = { ...w.deps, postMessage: (_pool, args) => w.post(args) };
  return fn(deps);
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------
test('#370 validateQueuedKind：只认 steer / follow_up', () => {
  assert.equal(validateQueuedKind('steer'), 'steer');
  assert.equal(validateQueuedKind('follow_up'), 'follow_up');
  for (const bad of [undefined, '', 'queue', 'steering', 42, null]) {
    assert.throws(() => validateQueuedKind(bad), (e) => e.code === 'validation_failed');
  }
});

test('#370 toSnapshot：steering 恒在前，withId=false 出裸文本', () => {
  const rows = [
    { id: 'a', kind: 'follow_up', content: '后排' },
    { id: 'b', kind: 'steer', content: '前排' },
  ];
  assert.deepEqual(toSnapshot(rows), { steering: [{ id: 'b', content: '前排' }], follow_up: [{ id: 'a', content: '后排' }] });
  assert.deepEqual(toSnapshot(rows, { withId: false }), { steering: ['前排'], follow_up: ['后排'] });
});

// ---------------------------------------------------------------------------
// 入队
// ---------------------------------------------------------------------------
test('#370 入队：有活跃 run ⇒ 落 pending，且**不写 messages**（#77 P3 锚点纯净红线）', async () => {
  const w = world();
  const res = await withFakePostMessage(w, (deps) => enqueueQueuedInput(w.pool, {
    userId: 'u1', sessionId: SID, kind: 'follow_up', content: '等它跑完再说这句', attachments: [], deps,
  }));
  assert.equal(res.posted, null);
  assert.equal(res.queued.content, '等它跑完再说这句');
  assert.equal(w.postCalls.length, 0, '入队不得触发 postMessage');
  assert.equal(w.queued[0].status, 'pending');
  assert.equal(w.notifies.length, 1, 'COMMIT 之后推一帧快照');
});

test('#370 入队 steer：记 interrupted_run_id + 打 cancel_requested_at，**run.status 保持 running**', async () => {
  const w = world();
  const res = await withFakePostMessage(w, (deps) => enqueueQueuedInput(w.pool, {
    userId: 'u1', sessionId: SID, kind: 'steer', content: '慢一点', attachments: [], deps,
  }));
  assert.equal(res.queued.kind, 'steer');
  assert.equal(w.queued[0].interrupted_run_id, 'r1', '「这次 abort 是转向」的唯一判据必须落库');
  assert.equal(w.cancelFlagged, 'r1', 'steer 必须打停止意图时间戳');
  assert.equal(w.activeRun.status, 'running', '⚠ status 不得进 cancelling——那是「立刻 SIGKILL 正在跑的工具」的开关');
  assert.deepEqual(w.steers, [{ userId: 'u1', run_id: 'r1' }], 'steer_request 必须下行给 agentd');
});

test('#370 入队：无活跃 run ⇒ 原子降级为直接发送（复用 postMessage，不开第二条发送路）', async () => {
  const w = world({ activeRun: null });
  const res = await withFakePostMessage(w, (deps) => enqueueQueuedInput(w.pool, {
    userId: 'u1', sessionId: SID, kind: 'follow_up', content: '空档里按的发送', attachments: [], deps,
  }));
  assert.equal(res.queued, null);
  assert.ok(res.posted.run, '直发必须带回 run');
  assert.equal(w.postCalls.length, 1);
  assert.equal(w.postCalls[0].triggerKind, 'user_send', '直发默认口径 = 用户手发，不是队列投递');
  assert.equal(w.queued.length, 0, '直发不落队列行');
  assert.deepEqual(w.runEnqueues.length, 1, '直发也要推 run_assigned（走的是同一条入队通知）');
});

test('#370 入队：直发时 postMessage 抛错必须原样上抛（前端要据此回填草稿）', async () => {
  const w = world({
    activeRun: null,
    postImpl: () => { const e = new Error('未绑定 LLM'); e.code = 'llm_slot_not_bound'; e.httpStatus = 409; throw e; },
  });
  await assert.rejects(
    withFakePostMessage(w, (deps) => enqueueQueuedInput(w.pool, { userId: 'u1', sessionId: SID, kind: 'steer', content: 'x', attachments: [], deps })),
    (e) => e.code === 'llm_slot_not_bound',
  );
});

test('#370 入队上限：第 21 条 409 queue_full，且不落行', async () => {
  const w = world();
  for (let i = 0; i < MAX_QUEUED_INPUTS_PER_SESSION; i++) {
    w.queued.push({ id: `p${i}`, session_id: SID, user_id: 'u1', kind: 'follow_up', content: `第${i}条`, attachments: [], position: i, status: 'pending' });
  }
  w.now = 100;
  await assert.rejects(
    withFakePostMessage(w, (deps) => enqueueQueuedInput(w.pool, { userId: 'u1', sessionId: SID, kind: 'follow_up', content: '挤不进去', attachments: [], deps })),
    (e) => e.code === 'queue_full' && e.httpStatus === 409,
  );
  assert.equal(w.queued.length, MAX_QUEUED_INPUTS_PER_SESSION);
});

test('#370 整队取回：pending → recalled（不硬删），delivering 不动，返回裸文本且 steering 在前', async () => {
  const w = world();
  w.queued.push(
    { id: 'a', session_id: SID, kind: 'follow_up', content: '后排', attachments: [], position: 1, status: 'pending' },
    { id: 'b', session_id: SID, kind: 'steer', content: '前排', attachments: [], position: 0, status: 'pending' },
    { id: 'c', session_id: SID, kind: 'follow_up', content: '已在投递', attachments: [], position: 2, status: 'delivering' },
  );
  const out = await recallQueuedInputs(w.pool, { userId: 'u1', sessionId: SID, deps: w.deps });
  assert.deepEqual(out, { steering: ['前排'], follow_up: ['后排'] });
  assert.equal(w.queued.find((q) => q.id === 'c').status, 'delivering', '已经在建 run 的话不许吐回输入框');
  assert.equal(w.queued.find((q) => q.id === 'a').status, 'recalled');
});

test('#848 评审 MED：认领过期（delivering 但 claimed_at 已超时）的行**必须能取回**，未过期的仍不动', async () => {
  const w = world();
  w.queued.push(
    { id: 'a', session_id: SID, kind: 'steer', content: '正常待发', attachments: [], position: 0, status: 'pending' },
    { id: 'b', session_id: SID, kind: 'follow_up', content: '认领后崩了', attachments: [], position: 1, status: 'delivering' },
    { id: 'c', session_id: SID, kind: 'follow_up', content: '正在建 run', attachments: [], position: 2, status: 'delivering' },
  );
  w.staleIds = new Set(['b']); // 只有 b 的认领过期（c 是正常在飞的投递）
  const out = await recallQueuedInputs(w.pool, { userId: 'u1', sessionId: SID, deps: w.deps });
  assert.deepEqual(out, { steering: ['正常待发'], follow_up: ['认领后崩了'] },
    '过期那行要能被取回（否则它永远停在 delivering：不投递、取不回、还算在上限里）');
  assert.equal(w.queued.find((q) => q.id === 'b').status, 'recalled');
  assert.equal(w.queued.find((q) => q.id === 'c').status, 'delivering', '未过期的投递不许被吐回输入框');
});

// ---------------------------------------------------------------------------
// 终态出队：判定表
// ---------------------------------------------------------------------------
async function drainWith(w, { termination, endedRunId = 'r1' }) {
  w.endedRun = { id: endedRunId, termination };
  return withFakePostMessage(w, (deps) => drainAfterRunTerminal(w.pool, { runId: endedRunId, deps }));
}

function seedQueued(w, entries) {
  w.queued = entries.map((e, i) => ({
    id: e.id ?? `q${i}`, session_id: SID, user_id: 'u1', attachments: [], position: i,
    status: 'pending', interrupted_run_id: null, ...e,
  }));
  w.now = 100;
}

test('#370 出队：队头是 steer ⇒ 无条件投（它就是这次终态的原因）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'steer', content: '慢一点', interrupted_run_id: 'r1' }]);
  const out = await drainWith(w, { termination: { reason: 'aborted', detail: 'steered' } });
  assert.equal(out.delivered, 'q0');
  assert.equal(w.postCalls[0].triggerKind, 'queued_steer');
  assert.equal(w.queued[0].status, 'delivered');
  assert.ok(w.queued[0].run_id, '投递要回写 run_id（账要能对上）');
});

test('#370 出队：follow_up + 正常终态 ⇒ 投，triggerKind=queued_follow_up', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '跑完接着做这个' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.delivered, 'q0');
  assert.equal(w.postCalls[0].triggerKind, 'queued_follow_up');
});

test('#370 出队：follow_up + aborted 且**存在指向本 run 的 steer 行** ⇒ 投（用户意图是接着说）', async () => {
  const w = world();
  seedQueued(w, [
    { id: 's', kind: 'steer', content: '慢一点', interrupted_run_id: 'r1', status: 'delivered' }, // 已投出去的转向行仍在本 run 名下
    { id: 'f', kind: 'follow_up', content: '后面这条' },
  ]);
  const out = await drainWith(w, { termination: { reason: 'aborted', detail: 'steered' } });
  assert.equal(out.delivered, 'f', '转向打断之后，排队的话要自动跟上（pi continue() 先 steering 后 followUp）');
});

test('#370 出队：follow_up + 用户按停止（aborted 且无转向行）⇒ **不投**，留在队列', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '别烧在坏 run 上' }]);
  const out = await drainWith(w, { termination: { reason: 'aborted' } });
  assert.equal(out.delivered, undefined);
  assert.equal(out.blocked, 'not_deliverable_at_terminal');
  assert.equal(w.queued[0].status, 'pending');
  assert.equal(w.postCalls.length, 0);
});

test('#370 出队：follow_up + failed / persistence_failed / max_rounds_cap ⇒ 都不投', async () => {
  for (const reason of ['failed', 'persistence_failed', 'max_rounds_cap', 'upstream_unavailable', 'interrupted']) {
    const w = world();
    seedQueued(w, [{ kind: 'follow_up', content: 'x' }]);
    const out = await drainWith(w, { termination: { reason } });
    assert.equal(out.blocked, 'not_deliverable_at_terminal', `${reason} 不该投递`);
  }
});

test('#370 出队：steer 即使在失败终态也投（它是用户点名要的转向）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'steer', content: '慢一点', interrupted_run_id: 'r1' }]);
  const out = await drainWith(w, { termination: { reason: 'failed' } });
  assert.equal(out.delivered, 'q0');
});

test('#370 出队：steering 恒先于 follow_up，同组内 FIFO', async () => {
  const w = world();
  seedQueued(w, [
    { kind: 'follow_up', content: '排一' },
    { kind: 'follow_up', content: '排二' },
    { kind: 'steer', content: '转向' },
  ]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.delivered, w.queued.find((q) => q.content === '转向').id);
  // 第二次终态才轮到 follow_up 的第一条
  w.postCalls.length = 0;
  const out2 = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(w.queued.find((q) => q.id === out2.delivered).content, '排一');
});

test('#370 出队：一次终态只投一条（新 run 起来后由它自己的终态接着投）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '一' }, { kind: 'follow_up', content: '二' }]);
  await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(w.postCalls.length, 1);
});

test('#370 出队：容器没起来 ⇒ 不投不丢，快照带 blocked=container_not_running（拍板点②）', async () => {
  const w = world({ containerUp: false });
  seedQueued(w, [{ kind: 'follow_up', content: '周五排的队' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.blocked, 'container_not_running');
  assert.equal(w.queued[0].status, 'pending', '绝不丢弃');
  assert.equal(w.notifies.at(-1).blocked, 'container_not_running', '界面必须能说出为什么没发');
});

test('#370 出队：认领 CAS 失败（别人抢先）⇒ 放弃本轮，不双发', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '只该发一次' }]);
  const origQuery = w.pool.query.bind(w.pool);
  w.pool.query = async (sql, params) => {
    if (/SET status = 'delivering'/.test(sql)) return { rows: [] }; // 模拟被抢先
    return origQuery(sql, params);
  };
  w.endedRun = { id: 'r1', termination: { reason: 'end_turn' } };
  const out = await withFakePostMessage(w, (deps) => drainAfterRunTerminal(w.pool, { runId: 'r1', deps }));
  assert.equal(out.blocked, 'claimed_by_other');
  assert.equal(w.postCalls.length, 0, '抢先失败的一方绝不重复 postMessage');
});

test('#370 出队：postMessage 失败 ⇒ 退回 pending（下次终态再来），快照带 deliver_failed', async () => {
  const w = world({
    postImpl: () => { const e = new Error('未绑定 LLM'); e.code = 'llm_slot_not_bound'; e.httpStatus = 409; throw e; },
  });
  seedQueued(w, [{ kind: 'follow_up', content: '发不出去' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.blocked, 'deliver_failed');
  assert.equal(w.queued[0].status, 'pending', '没发成功的话必须回到队列，不是蒸发了');
  assert.equal(w.notifies.at(-1).blocked, 'deliver_failed');
});

test('#370 出队：会话已归档 ⇒ 直接不投（用户已看不见它）', async () => {
  const w = world({ session: { id: SID, user_id: 'u1', status: 'archived', cwd: '/w', title: null, project_id: null, last_seq: 0 } });
  seedQueued(w, [{ kind: 'follow_up', content: 'x' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out, null);
  assert.equal(w.postCalls.length, 0);
});

test('#370 出队：认领过期的 delivering 行要被重新捞起（崩溃窗口不许让话永久蒸发）', async () => {
  // 现场：上一次投递认领了这行（delivering）之后进程崩在建 run 之前 ⇒ claimed_at 停在那里。
  // 旧实现只认 status='pending' ⇒ 这行既不投（pick 不认）、也取不回（recall 只动 pending）、
  // 还算在 20 条上限里 —— 迁移注释里承诺的「过期即可被重新认领」是句空话。
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '认领后崩掉的那句', status: 'delivering' }]);
  w.staleIds = new Set(['q0']);   // 假池按 SQL 谓词判过期
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.delivered, 'q0', '过期认领必须能被重投');
  assert.equal(w.postCalls.length, 1);
});

test('#370 出队：未过期的 delivering 不算可认领（正在投的那条不许被抢第二次）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '别人正在投', status: 'delivering' }]);
  w.staleIds = new Set();
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out, null, '没有可认领的行 ⇒ 直接返回 null');
  assert.equal(w.postCalls.length, 0);
});

test('#370 出队：投递成功那一帧必须带 delivered_run_id（否则前端不知道新 run 在跑）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '投出去的一句' }]);
  const seen = [];
  w.deps.notifyQueueUpdate = (_sid, blocked = null, deliveredRunId = null) => { seen.push({ blocked, deliveredRunId }); };
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.ok(out.runId, '投递要回传新 run id');
  assert.deepEqual(seen.at(-1), { blocked: null, deliveredRunId: out.runId },
    '前端只有 POST 响应与会话详情两条路知道活跃 run，队列投递两条都不走 ⇒ 只能靠这一帧');
});

test('#370 出队：推送失败不得污染终态响应（best-effort）', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: 'x' }]);
  w.deps.notifyQueueUpdate = () => { throw new Error('SSE 断了'); };
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.delivered, 'q0');
});

test('#370 出队：postMessage 404（会话没了）⇒ 钉 discarded，不再每次终态空转', async () => {
  const w = world({ postImpl: () => { const e = new Error('会话不存在'); e.httpStatus = 404; throw e; } });
  seedQueued(w, [{ kind: 'follow_up', content: '孤儿' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.blocked, 'deliver_failed');
  assert.equal(w.queued[0].status, 'discarded');
});

// ---------------------------------------------------------------------------
// issue #799：投递成功那一帧要带 `delivered`（那句话本身）。
// 队列是**状态**；一句队列话被投出去那一刻起就是普通 user 消息 = **历史**，所以它必须随这一帧
// 交到前端当场出气泡，而不是等刷新从库里读回来（读得到，但「实时对话」里那句话凭空缺席）。
// ---------------------------------------------------------------------------
test('#799 出队投递成功：notifyQueueUpdate 第 5 实参逐字等于 postMessage 回的 user 消息体', async () => {
  const probe = '转向探针-799';
  const probeMessage = { id: 'm-del-799', seq: 7, role: 'user', content: probe, synthetic: false, attachments: [] };
  const w = world({ postImpl: () => ({ message: probeMessage, run: { id: 'run-del-799' } }) });
  seedQueued(w, [{ kind: 'follow_up', content: '投出去的一句' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.delivered, 'q0');
  const last = w.notifies.at(-1);
  assert.equal(last.blocked, null, '成功帧不带 blocked');
  assert.equal(last.deliveredRunId, 'run-del-799');
  assert.ok(last.delivered && typeof last.delivered === 'object', '投递帧必须带 delivered（那句话本身）');
  assert.equal(last.delivered.content, probe, 'delivered 就是 postMessage 回显的那句话，逐字相等');
  assert.equal(last.delivered.id, 'm-del-799');
});

test('#799 出队投递失败 deliver_failed：delivered 必须是 null（没投成的不许画成已发送）', async () => {
  const w = world({ postImpl: () => { throw new Error('LLM 没绑'); } });
  seedQueued(w, [{ kind: 'follow_up', content: '投不出去' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.blocked, 'deliver_failed');
  const last = w.notifies.at(-1);
  assert.equal(last.blocked, 'deliver_failed');
  assert.ok('delivered' in last, 'notify 记录面恒带 delivered 键');
  assert.equal(last.delivered, null, '失败帧的 delivered 必须是 null');
});

test('#799 出队 container_not_running：delivered 必须是 null', async () => {
  const w = world({ containerUp: false });
  seedQueued(w, [{ kind: 'follow_up', content: '周五排的队' }]);
  const out = await drainWith(w, { termination: { reason: 'end_turn' } });
  assert.equal(out.blocked, 'container_not_running');
  const last = w.notifies.at(-1);
  assert.equal(last.blocked, 'container_not_running');
  assert.ok('delivered' in last);
  assert.equal(last.delivered, null, '容器没起来更不许渲染那句话');
});

test('#799 internal.notifyQueueUpdate 的 queue_update 帧恒带 delivered 键（非投递帧=null）', () => {
  const res = { written: [], writableEnded: false, destroyed: false, end() {}, write(x) { this.written.push(x); } };
  const rec = registerSessionClient('s-del-799', res);
  try {
    internalNotifyQueueUpdate('s-del-799', { steering: [], follow_up: [] });
    const frame = rec.buffer.find((e) => e.type === 'queue_update');
    assert.ok(frame, '非投递（入队/取回）也要推一帧 queue_update');
    assert.ok('delivered' in frame.payload, 'queue_update 载荷面恒有 delivered 键');
    assert.equal(frame.payload.delivered, null, '非投递帧 delivered=null');

    const msg = { id: 'm-x', role: 'user', content: '投出去的话' };
    internalNotifyQueueUpdate('s-del-799', { steering: [], follow_up: [] }, null, 'r-x', msg);
    const frame2 = rec.buffer.filter((e) => e.type === 'queue_update').at(-1);
    assert.deepEqual(frame2.payload.delivered, msg, '投递帧 delivered 逐字带上那句话的回显体');
  } finally {
    unregisterSessionClient('s-del-799', rec);
  }
});

// ---------------------------------------------------------------------------
// issue #805：`blocked` 不是「接口失败」，是「这句话这次为什么没投出去」的原因码。
// 发帧面必须**逐码**钉住，不能整片发也不能整片不发：
//   · `not_deliverable_at_terminal` ⇒ **发**（用户看得见「为什么这句没发」，否则只剩「队列里还有 1 条」）；
//   · `claimed_by_other`（正常握手，赢的那一方自己会推 delivered 帧）与会话没了/已归档 ⇒ **零调用**。
// 反向判据是这条测试的全部意义：少了它，「顺手把另两条也发了」一样全绿（#805）。
// ---------------------------------------------------------------------------
test('#805 出队：follow_up + aborted 且非转向 ⇒ blocked=not_deliverable_at_terminal，且**推一帧**、行仍 pending', async () => {
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '别烧在坏 run 上' }]);
  const out = await drainWith(w, { termination: { reason: 'aborted' } });   // 用户按停止，无转向行
  assert.equal(out.blocked, 'not_deliverable_at_terminal');
  assert.equal(w.postCalls.length, 0, '不投就是不投，不能顺手 postMessage');
  assert.equal(w.queued[0].status, 'pending', '原因码不是终态：那行没被消费，下一次终态还会来捞');
  assert.equal(w.notifies.length, 1, '本单主判据：这条必须发帧（不发 = 界面上没有任何地方解释为什么没发）');
  assert.equal(w.notifies[0].sessionId, SID);
  assert.equal(w.notifies[0].blocked, 'not_deliverable_at_terminal', '第 2 实参就是原因码（#294：只发码不发话）');
});

test('#805 出队：claimed_by_other 与会话已归档 ⇒ **不投也不发帧**（故意不发，不是遗漏）', async () => {
  // ① 认领 CAS 被别处终态抢先：赢的一方自己会推 `delivered` 帧，这里再推只会让原因闪一下又消失。
  const w = world();
  seedQueued(w, [{ kind: 'follow_up', content: '只该发一次' }]);
  const origQuery = w.pool.query.bind(w.pool);
  w.pool.query = async (sql, params) => {
    if (/SET status = 'delivering'/.test(sql)) return { rows: [] };
    return origQuery(sql, params);
  };
  w.endedRun = { id: 'r1', termination: { reason: 'end_turn' } };   // 正常终态，否则先被上一道闸门挡下
  const out = await withFakePostMessage(w, (deps) => drainAfterRunTerminal(w.pool, { runId: 'r1', deps }));
  assert.equal(out.blocked, 'claimed_by_other');
  assert.equal(w.notifies.length, 0, '握手失败的一方闭嘴（反向判据：不许顺手把它也发了）');

  // ② 会话已归档 / 没了 ⇒ 没有收件人，`drainAfterRunTerminal` 直接 return null，连判定都不进。
  const a = world({ session: { id: SID, user_id: 'u1', status: 'archived', cwd: '/w', title: null, project_id: null, last_seq: 0 } });
  seedQueued(a, [{ kind: 'follow_up', content: '没人收的话' }]);
  const outA = await withFakePostMessage(a, (deps) => drainAfterRunTerminal(a.pool, { runId: 'r1', deps }));
  assert.equal(outA, null, '归档会话不参与自动投递（口径不动）');
  assert.equal(a.notifies.length, 0, '没有收件人 ⇒ 一帧都不推');
});
