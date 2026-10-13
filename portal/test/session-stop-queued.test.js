// issue #277 第一片（#277-A）：被停止的 `queued` run 必须**直接进终态**，不得进 `cancelling`。
//
// 缺陷（真机复现，dev 栈 capacity=2 + 3 条并发，第三条停在 queued）：`POST /api/sessions/:id/stop`
// 返回 200 `{"status":"cancelling"}`，但那条 queued run 从未被任何 worker 领起 ⇒
//   ①认领 SQL 排除 `cancelling`（internal.js tryClaim 的 `r.status IN ('queued','running')`，A2）
//   ②终态只能由 worker 经 U2 写（`cancelling → finished|failed`）
//   ③reaper 候选集是 `q.status='claimed' AND q.lease_until<now()`，不含它
// ⇒ 20 分钟仍 `cancelling`；`active_run_id`（ACTIVE_RUN_STATES 含 cancelling）恒非空 ⇒ UI 恒「运行中」，
//   发新消息恒 409 `run_in_progress`；再点停止又 200（幂等地继续卡）。
//
// 隔离约定（docs/testing.md §2.1）：内存 fake pool 按 SQL 标记 emulate **谓词与影响行数**，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import { stopSession, postMessage, SessionError } from '../src/sessions.js';
import { validateTransition, setRunState, claimRun } from '../src/internal.js';
import { seedClaimable } from './fake-internal-pool.js';

const UID = '00000000-0000-4000-8000-0000000000a1';
const SID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
const CID = 'c0000000-0000-4000-8000-0000000000c1';

/**
 * 会话/run/queue 三表的内存 fake pool：**按 SQL 里的 status 谓词真过滤**（这是本文件全部判据的支点
 * ——谓词不匹配就必须 0 行，否则「竞态」「幂等」两组用例都会假通过）。
 */
class StopPool {
  constructor({ run } = {}) {
    this.session = {
      id: SID, user_id: UID, project_id: null, cwd: '~/projects/a', title: '既有标题', title_source: 'manual',
      model: null, status: 'active', last_seq: 10, created_at: new Date(), updated_at: new Date(),
    };
    this.runs = run ? [{ id: run.id, session_id: SID, status: run.status, termination: run.termination ?? null,
      error: null, usage: null, rounds: 0, cancel_requested_at: run.cancel_requested_at ?? null,
      queued_at: new Date('2026-10-20T00:00:00Z'), started_at: run.started_at ?? null, ended_at: null }] : [];
    this.queue = run ? [{ id: 'q1', run_id: run.id, container_id: CID, owner_container_id: run.owner ?? null,
      claim_token: run.claim_token ?? null, status: run.queue_status ?? 'pending', attempts: run.attempts ?? 0,
      max_attempts: 3, lease_until: run.lease_until ?? null, created_at: new Date('2026-10-20T00:00:00Z'),
      claimed_at: run.claimed_at ?? null }] : [];
    this.messages = [];
    this.transcript = [];
    this.events = []; // run_events（#277-A2 返修 2：合成 run_end 的判据面）
    this.sqlJournal = []; // 按执行顺序记录原始 SQL（事务边界/同事务断言用）
    this.commits = 0;
    this.rollbacks = 0;
    // 竞态注入：在第 1 步（queued 分支）UPDATE **执行前**把 run 改成 running（模拟 claim + markRunState 已提交），
    // 于是 queued 分支命中 0 行——断言第 2 步必须接住它。
    this.onBeforeQueuedUpdate = null;
  }

  runRow() { return this.runs[0] ?? null; }
  queueFor(runId) { return this.queue.find((q) => q.run_id === runId) ?? null; }

  /** 租约事实的 SQL 表达式仿真：`q.status='claimed'` (+ 可选 `q.lease_until > now()`)。 */
  claimedFor(runId, { needLease = true } = {}) {
    return this.queue.some((q) => q.run_id === runId && q.status === 'claimed'
      && (!needLease || (q.lease_until != null && new Date(q.lease_until).getTime() > Date.now())));
  }
  /** 从 SQL 文本里读出守卫写了哪半个条件——**没写就不仿真**（变异测试的支点：删掉守卫，仿真跟着消失）。 */
  guardOf(sql) {
    return { claimed: sql.includes("q.status = 'claimed'"), lease: sql.includes('q.lease_until > now()') };
  }

  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ');
    this.sqlJournal.push({ sql: s, params });

    if (/^\s*BEGIN/i.test(s)) return { rows: [] };
    if (/^\s*COMMIT/i.test(s)) { this.commits += 1; return { rows: [] }; }
    if (/^\s*ROLLBACK/i.test(s)) { this.rollbacks += 1; return { rows: [] }; }

    // ---- stopSession 第 1 步：queued → finished（谓词 status='queued' + #277-A2 的「未被领走」守卫）----
    if (s.includes('UPDATE runs') && s.includes("SET status = 'finished'") && s.includes("AND status = 'queued'")) {
      if (this.onBeforeQueuedUpdate) await this.onBeforeQueuedUpdate(); // 竞态注入点（UPDATE 前翻转状态）
      const g = this.guardOf(s);
      const hit = this.runs.filter((r) => r.session_id === params[0] && r.status === 'queued'
        // 守卫存在时：已领走（可选：且租约有效）的行必须被排除（NOT EXISTS 不命中）
        && !(g.claimed && this.claimedFor(r.id, { needLease: g.lease })));
      for (const r of hit) {
        r.status = 'finished';
        r.termination = { reason: 'aborted', detail: 'cancelled_before_start' };
        r.cancel_requested_at = r.cancel_requested_at ?? new Date();
        r.ended_at = new Date();
      }
      const rows = hit.map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }

    // ---- stopSession 第 2 步：running → cancelling；#277-A2 后额外接住「已领走但仍 queued」的行 ----
    if (s.includes('UPDATE runs') && s.includes("SET status = 'cancelling'")
        && s.includes("status = 'running'") && !s.includes("AND status IN ('queued', 'running')")) {
      const g = this.guardOf(s);
      const hit = this.runs.filter((r) => r.session_id === params[0]
        && (r.status === 'running'
          // 镜像守卫：第 1 步排除的那批（`status='queued'` 且已领走）必须在这里被接住
          || (g.claimed && r.status === 'queued' && this.claimedFor(r.id, { needLease: g.lease }))));
      for (const r of hit) {
        r.status = 'cancelling';
        r.cancel_requested_at = r.cancel_requested_at ?? new Date();
      }
      const rows = hit.map((r) => ({ id: r.id }));
      return { rows, rowCount: rows.length };
    }

    // ---- 出队：run_queue → cancelled + 清租约字段（RETURNING attempts 供 run_end 载荷的 attempt 字段）----
    if (s.includes('UPDATE run_queue') && s.includes("SET status = 'cancelled'")) {
      const q = this.queueFor(params[0]);
      if (!q) return { rows: [], rowCount: 0 };
      q.status = 'cancelled';
      q.claim_token = null;
      q.owner_container_id = null;
      q.lease_until = null;
      q.claimed_at = null;
      return { rows: [{ attempts: q.attempts }], rowCount: 1 };
    }

    // ---- 合成 run_end（#277-A2 返修 2）：照 DDL 的两条约束真仿真 ----
    // UNIQUE (run_id, client_event_id)：被 `ON CONFLICT (run_id, client_event_id) DO NOTHING` 仲裁 → 静默丢弃；
    //   没有写 arbiter 就抛（否则「幂等」在 fake 里永远假通过）。
    // 部分唯一索引 run_events_run_end_key ON (run_id) WHERE type='run_end'：同一 run 的第二条 run_end
    //   （即使 client_event_id 不同）**不被仲裁** → 报错，照真库行为。
    // UNIQUE (session_id, seq)：seq 不单调/重复分配也报错。
    if (s.includes('INSERT INTO run_events')) {
      // 与 finishRun / terminateActiveRuns 同形：type 是 SQL 里的字面量，params 只带 5 个值。
      const [run_id, session_id, seq, client_event_id, payloadJson, extra] = params;
      const type = extra ?? (/'run_end'/.test(s) ? 'run_end' : 'unknown');
      const parsed = { run_id, session_id, seq, client_event_id, type, payload: JSON.parse(payloadJson) };
      const dupKey = this.events.find((e) => e.run_id === run_id && e.client_event_id === client_event_id);
      if (dupKey) {
        if (!/ON CONFLICT \(run_id, client_event_id\) DO NOTHING/i.test(s)) {
          throw new Error(`duplicate key value violates unique constraint "run_events_run_id_client_event_id_key"`);
        }
        return { rows: [], rowCount: 0 };
      }
      if (type === 'run_end' && this.events.some((e) => e.run_id === run_id && e.type === 'run_end')) {
        throw new Error('duplicate key value violates unique constraint "run_events_run_end_key"');
      }
      if (this.events.some((e) => e.session_id === session_id && e.seq === seq)) {
        throw new Error('duplicate key value violates unique constraint "run_events_session_id_seq_key"');
      }
      this.events.push(parsed);
      return { rows: [{}], rowCount: 1 };
    }

    // ---- 旧代码的单步停止（`status IN ('queued','running')` → cancelling）：照旧语义仿真，
    //      目的是让「旧代码必红」红在**断言**（queued 被写成 cancelling）而不是红在 fake pool 不认 SQL。
    if (s.includes('UPDATE runs') && s.includes("SET status = 'cancelling'") && s.includes("AND status IN ('queued', 'running')")) {
      const hit = this.runs.filter((r) => r.session_id === params[0] && ['queued', 'running'].includes(r.status));
      for (const r of hit) {
        r.status = 'cancelling';
        r.cancel_requested_at = new Date();
      }
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    if (s.includes('SELECT id FROM runs WHERE session_id = $1 AND status = ') && s.includes("'cancelling'")) {
      const hit = this.runs.filter((r) => r.session_id === params[0] && r.status === 'cancelling')
        .sort((a, b) => b.queued_at - a.queued_at)
        .slice(0, 1);
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }

    // ---- 幂等重放读（cancelling 或已 cancelled_before_start 终态）----
    if (s.includes('FROM runs') && s.includes("status = 'cancelling'") && s.includes('cancelled_before_start')) {
      const hit = this.runs.filter((r) => r.session_id === params[0]
        && (r.status === 'cancelling'
          || (r.status === 'finished' && r.termination?.detail === 'cancelled_before_start')))
        .sort((a, b) => b.queued_at - a.queued_at)
        .slice(0, 1);
      return { rows: hit.map((r) => ({ id: r.id, status: r.status })), rowCount: hit.length };
    }

    // ---- postMessage：活跃 run 检查（ACTIVE_RUN_STATES）----
    if (s.includes('SELECT id FROM runs WHERE session_id = $1 AND status IN')) {
      const active = this.runs.filter((r) => r.session_id === params[0]
        && ['queued', 'running', 'cancelling'].includes(r.status));
      return { rows: active.slice(0, 1).map((r) => ({ id: r.id })), rowCount: Math.min(active.length, 1) };
    }

    // ---- postMessage 事务其余环节（够用即可，非本文件判据）----
    if (s.includes('FROM chat_sessions s')) {
      const ok = this.session.id === params[0] && this.session.user_id === UID && this.session.status === 'active';
      return { rows: ok ? [{ ...this.session }] : [], rowCount: ok ? 1 : 0 };
    }
    if (s.includes('UPDATE chat_sessions SET last_seq')) {
      this.session.last_seq += 1;
      return { rows: [{ last_seq: this.session.last_seq }], rowCount: 1 };
    }
    if (s.includes('INSERT INTO messages')) {
      const row = { id: `m${this.messages.length + 1}`, session_id: params[0], seq: params[1], role: 'user',
        content: '', attachments: JSON.parse(params[2] ?? '[]'), run_id: null, created_at: new Date() };
      this.messages.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (s.includes('UPDATE messages SET run_id')) {
      const m = this.messages.find((x) => x.id === params[0]);
      if (m) m.run_id = params[1];
      return { rows: [], rowCount: m ? 1 : 0 };
    }
    if (s.includes('SELECT record') && s.includes('FROM transcript_rounds')) return { rows: [], rowCount: 0 };
    if (s.includes('SELECT MAX(round) AS max_round')) return { rows: [{ max_round: null }], rowCount: 1 };
    if (s.includes('INSERT INTO transcript_rounds')) {
      this.transcript.push({ key: params[0], dedup_key: params[1], round: params[2], record: JSON.parse(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('INSERT INTO runs')) {
      this.runs.push({ id: params[0], session_id: params[1], status: 'queued', termination: null, error: null,
        usage: null, rounds: 0, cancel_requested_at: null, queued_at: new Date(), started_at: null, ended_at: null });
      return { rows: [{ id: params[0], status: 'queued' }], rowCount: 1 };
    }
    if (s.includes('INSERT INTO run_queue')) {
      this.queue.push({ id: `q${this.queue.length + 1}`, run_id: params[0], container_id: params[1],
        owner_container_id: null, claim_token: null, status: 'pending', attempts: 0, max_attempts: 3,
        lease_until: null, created_at: new Date(), claimed_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('FROM containers')) return { rows: [{ id: CID }], rowCount: 1 };
    if (s.includes('SELECT fde_name FROM users')) return { rows: [{ fde_name: 'alice' }], rowCount: 1 };
    if (s.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };

    throw new Error(`StopPool：未预期的 SQL\n${sql}`);
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }

  /** 执行日志里的语句序列（只取影响判据的那几个标记）——用于「同事务」断言。 */
  journalOf(marker) { return this.sqlJournal.filter((e) => marker.test(e.sql)).map((e) => e.sql); }
  markerIndex(marker) { return this.sqlJournal.findIndex((e) => marker.test(e.sql)); }
}

const stop = (pool) => stopSession(pool, { userId: UID, sessionId: SID });
const send = (pool, content = '再来一条') => postMessage(pool, { userId: UID, sessionId: SID, content, attachments: [] });

test('#277-A 主判据：queued run 停止 ⇒ 直接 finished(aborted) + 出队 + 同会话可再发消息', async () => {
  const pool = new StopPool({ run: { id: 'run-q', status: 'queued' } });

  const out = await stop(pool);

  // ① 终态且不是 cancelling：direct finished + termination.reason='aborted'
  assert.equal(out.run.status, 'finished', 'queued 停止的响应状态必须是 finished（旧代码在此为 cancelling）');
  assert.equal(pool.runRow().status, 'finished', 'runs.status 必须直接进终态');
  assert.equal(pool.runRow().termination?.reason, 'aborted');
  assert.equal(pool.runRow().termination?.detail, 'cancelled_before_start');
  assert.ok(pool.runRow().ended_at, 'ended_at 必须写（终态标记）');
  assert.ok(pool.runRow().cancel_requested_at, 'cancel_requested_at 必须写（停止标记，UI 推导「已取消」）');

  // ② run_queue 里查不到它（不再是 pending/claimed，且租约字段已清）
  const q = pool.queueFor('run-q');
  assert.equal(q.status, 'cancelled', 'run_queue 行必须摘掉（→ cancelled，同 release/reaper 口径）');
  assert.equal(q.lease_until, null);
  assert.equal(q.claim_token, null);
  assert.ok(!pool.queue.some((x) => ['pending', 'claimed'].includes(x.status)),
    '待领队列里不得再出现这条 run');

  // ③ 同会话随后能发新消息（不再 409 run_in_progress）
  const posted = await send(pool);
  assert.equal(posted.run.status, 'queued');
  assert.notEqual(posted.run.id, 'run-q', '新消息必须建出新 run');
});

test('#277-A running 不回退：运行中停止仍是 cancelling，终态留给 worker', async () => {
  const pool = new StopPool({
    run: { id: 'run-r', status: 'running', queue_status: 'claimed', claim_token: 'tok', attempts: 1,
      owner: CID, lease_until: new Date(Date.now() + 90_000), claimed_at: new Date(), started_at: new Date() },
  });

  const out = await stop(pool);

  assert.equal(out.run.status, 'cancelling');
  assert.equal(pool.runRow().status, 'cancelling', 'running 不得被 portal 直接写终态（A2：终态由 worker 报）');
  assert.equal(pool.runRow().ended_at, null, 'cancelling 不得写 ended_at');
  assert.equal(pool.runRow().termination, null);
  assert.equal(pool.queueFor('run-r').status, 'claimed', 'cancelling 期间租约原样保留（worker 还要写终态）');
});

test('#277-A 幂等：重复停止仍返回 200 语义且零新增副作用', async () => {
  const pool = new StopPool({ run: { id: 'run-q', status: 'queued' } });
  const first = await stop(pool);
  const snapshot = { run: { ...pool.runRow() }, queue: { ...pool.queueFor('run-q') }, commitsBefore: pool.commits };

  const second = await stop(pool);

  assert.equal(second.run.id, first.run.id);
  assert.equal(second.run.status, 'finished', '重放必须回同一条终态 run（旧代码在此会把状态报成 cancelling）');
  assert.deepEqual({ ...pool.runRow() }, snapshot.run, '第二次停止不得再改 runs 行');
  assert.deepEqual({ ...pool.queueFor('run-q') }, snapshot.queue, '第二次停止不得再改 run_queue 行');
  assert.equal(pool.commits, snapshot.commitsBefore + 1);
});

test('#277-A 竞态：queued 分支 0 行（run 已被领走并写了 running）⇒ 仍走 cancelling，不许吞', async () => {
  const pool = new StopPool({
    run: { id: 'run-c', status: 'queued', queue_status: 'claimed', claim_token: 'tok', attempts: 1,
      owner: CID, lease_until: new Date(Date.now() + 90_000), claimed_at: new Date() },
  });
  // queued 分支的 UPDATE 执行前：worker 已领走并 markRunState(running) 已提交 ⇒ 谓词 status='queued' 命中 0 行。
  pool.onBeforeQueuedUpdate = async () => {
    const r = pool.runRow();
    r.status = 'running';
    r.started_at = new Date();
  };

  const out = await stop(pool);

  assert.equal(out.run.status, 'cancelling', '被抢跑的 run 必须落到 cancelling 路径（不得静默 no-op）');
  assert.equal(pool.runRow().status, 'cancelling');
  assert.ok(pool.runRow().cancel_requested_at);
  assert.equal(pool.runRow().ended_at, null);
  assert.equal(pool.queueFor('run-c').status, 'claimed', '0 行的 queued 分支不得误出队（租约留给 worker 报终态）');
});

// ===========================================================================
// #277-A2 返修 1：「已被 agentd 领走、还没来得及写 `running`」的 run（runs.status 仍是 `queued`，
// 认领只写 run_queue）不得被直接终态化。
// 它必须落到第 2 步 `cancelling`，因为那才是能收敛且**不丢 usage** 的那条路：
//   ① worker 正常的 markRunState('running') 由 internal.js setRunState 的 #220 ack 分支接住
//      （无副作用 2xx、不炸成 persistence_failed、也不把状态改回 running——该分支自身的行为由
//      internal.test.js `#220 setRunState：cancelling + state=running → 幂等 ack` 钉住）；
//   ② 心跳 stop_run_ids 的谓词要求 `status='cancelling'` 且 run 在 worker 上报列表里 ⇒ 信号能送到活着的 worker；
//   ③ worker abort 后经 U2 报终态（cancelling → finished|failed，租约未被清 ⇒ 门禁过得去）⇒ 带真实 usage 收敛。
// 直接终态则：写下一个说谎的 detail='cancelled_before_start'，且 worker 的终态写入被 fencing 拒 ⇒ usage 丢。
// ===========================================================================

/** 造形：已领走（queue claimed + 租约至 now+leaseMs）但 runs.status 仍 queued。 */
const claimedButQueued = (leaseMs = 90_000) => ({
  run: { id: 'run-x', status: 'queued', queue_status: 'claimed', claim_token: 'tok', attempts: 1,
    owner: CID, lease_until: new Date(Date.now() + leaseMs), claimed_at: new Date() },
});

test('#277-A2 已领走但未写 running：stop 必须落 cancelling（不是 finished）且不碰租约、不写 termination', async () => {
  const pool = new StopPool(claimedButQueued());
  const qBefore = { ...pool.queueFor('run-x') };

  const out = await stop(pool);

  assert.equal(out.run.status, 'cancelling', '已领走的 run 不得被直接终态（无守卫时在此为 finished）');
  assert.equal(pool.runRow().status, 'cancelling', 'runs.status 必须是 cancelling（等 worker 报终态）');
  assert.equal(pool.runRow().ended_at, null, 'cancelling 不是终态，不得写 ended_at');
  assert.equal(pool.runRow().termination, null, 'termination 由 worker 带真实值写，portal 不得预写 cancelled_before_start');
  assert.ok(pool.runRow().cancel_requested_at, 'cancel_requested_at 必须写（心跳 stop_run_ids 的谓词条件）');
  assert.deepEqual({ ...pool.queueFor('run-x') }, qBefore, '租约字段一个不得清（清了 worker 写终态就 lease_lost ⇒ 丢 usage）');
  assert.equal(pool.queueFor('run-x').claim_token, 'tok');
  assert.ok(pool.queueFor('run-x').lease_until > new Date(), '租约仍是未来时刻');
  assert.equal(pool.events.length, 0, '未进终态就不得合成 run_end');
  assert.equal(pool.session.last_seq, 10, 'cancelling 路径不得分配 seq');
});

test('#277-A2 已领走走 cancelling 后同会话仍不得发新消息（ACTIVE_RUN_STATES 含 cancelling，与 running 分支一致）', async () => {
  const pool = new StopPool(claimedButQueued());
  await stop(pool);
  await assert.rejects(() => send(pool), (e) => e instanceof SessionError && e.code === 'run_in_progress');
});

test('#277-A2 守卫不误伤：已领走但**租约已过期**（worker 已死，reaper 会回 pending/判 failed）⇒ 仍直接终态', async () => {
  // 租约过期 = 按 reaper 口径「worker 已死」，没有活着的执行体会再来报终态；
  // 若守卫写成「排除一切 claimed 行」（少掉 `q.lease_until > now()`）⇒ 本例不再直接终态：只改第 1 步时两步皆 0 行
  // → 409 `no_active_run`；连第 2 步也跟着改则落 `cancelling`（本例验的是「不得阻止直接终态」，两种都红）。
  const pool = new StopPool(claimedButQueued(-1_000)); // lease_until 已过期 1s

  const out = await stop(pool);

  assert.equal(out.run.status, 'finished', '过期租约不得阻止直接终态（否则又永久卡住）');
  assert.equal(pool.runRow().status, 'finished');
  assert.equal(pool.runRow().termination?.detail, 'cancelled_before_start');
  assert.equal(pool.queueFor('run-x').status, 'cancelled', '过期租约的队列行照常出队');
  assert.equal(pool.queueFor('run-x').lease_until, null);
});

test('#277-A2 未领走（pending）仍是直接终态：守卫只排「已领走」，不得把 queued 全排掉', async () => {
  const pool = new StopPool({ run: { id: 'run-p', status: 'queued' } }); // queue pending，无租约
  const out = await stop(pool);
  assert.equal(out.run.status, 'finished');
  assert.equal(pool.runRow().termination?.reason, 'aborted');
  assert.equal(pool.queueFor('run-p').status, 'cancelled');
});

// ===========================================================================
// #277-A2 返修 2：queued 直接终态那条路必须**同事务合成 `run_end`**。
// 不合成则活页面的输入框要等刷新才能摘「运行中」（用户原话）。写法照 internal.js finishRun /
// provisioner.js terminateActiveRuns 的先例（client_event_id = `<runId>:final:run_end`、seq 走 allocSeq、
// ON CONFLICT DO NOTHING、提交后推 SSE）。
// 注意：`run_end` 在 SSE 实时下发，但**历史回放白名单故意不含它**（http.js HISTORY_EVENT_TYPES，
// #89 契约）——本组用例断的是「事件确实落了 run_events 表且 seq 单调」，不去断历史端点可见性。
// ===========================================================================

/** 带 SSE 捕获的 stop：记录推送时刻的 pool.commits，用来断「必须在 COMMIT 之后」。 */
async function stopWithNotify(pool) {
  const pushes = [];
  const out = await stopSession(pool, {
    userId: UID, sessionId: SID,
    notify: (sessionId, events) => pushes.push({ sessionId, events, commits: pool.commits }),
  });
  return { out, pushes };
}

test('#277-A2 queued → stop：run_events 落下 run_end（reason=aborted）且 seq 单调、SSE 在提交后', async () => {
  const pool = new StopPool({ run: { id: 'run-q', status: 'queued' } });
  const seqBefore = pool.session.last_seq;

  const { out, pushes } = await stopWithNotify(pool);

  assert.equal(out.run.status, 'finished');
  assert.equal(pool.events.length, 1, '直接终态必须合成一条 run_end（不合成则前端要等刷新）');
  const ev = pool.events[0];
  assert.equal(ev.type, 'run_end');
  assert.equal(ev.run_id, 'run-q');
  assert.equal(ev.session_id, SID, '冗余列 session_id 必须写（SSE 按 session 补发靠它）');
  assert.equal(ev.client_event_id, 'run-q:final:run_end', 'client_event_id 口径同 finishRun / offboard');
  assert.equal(ev.payload.termination.reason, 'aborted', '载荷 reason 必须是 aborted');
  assert.equal(ev.payload.termination.detail, 'cancelled_before_start');
  assert.deepEqual(ev.payload.usage, { input_tokens: 0, output_tokens: 0 });
  assert.equal(ev.payload.rounds, 0);
  assert.equal(ev.payload.attempt, 0, 'attempt = run_queue.attempts（未被领走过 ⇒ 0），与 finishRun 载荷同构');

  // seq 单调：走 §7.3 统一分配器，严格大于停止前的 last_seq，会话游标同步前移
  assert.equal(ev.seq, seqBefore + 1, 'seq 必须由 allocSeq 分配（与消息共享同一游标）');
  assert.equal(pool.session.last_seq, seqBefore + 1, 'last_seq 必须同事务前移');

  // SSE：只推一次，形状与 finishRun 那条同构，且**必须在 COMMIT 之后**
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].sessionId, SID);
  assert.equal(pushes[0].commits, 1, 'notify 必须在 COMMIT 之后（先于落库到达前端会读到旧状态）');
  assert.equal(pushes[0].events.length, 1);
  assert.equal(pushes[0].events[0].type, 'run_end');
  assert.equal(pushes[0].events[0].seq, ev.seq);
  assert.equal(pushes[0].events[0].run_id, 'run-q');

  // 同会话第二个 run 再停一次：seq 仍单调递增且无空洞（消息占 1 个 seq，run_end 占 1 个）
  const second = await send(pool);
  const secondStop = await stopSession(pool, { userId: UID, sessionId: SID });
  assert.equal(secondStop.run.id, second.run.id);
  assert.equal(pool.events.length, 2);
  assert.ok(pool.events[1].seq > ev.seq, '第二条 run_end 的 seq 必须更大');
  assert.equal(pool.events[1].seq, pool.session.last_seq, 'seq 无空洞：最后一次分配就是会话游标');
  assert.equal(pool.session.last_seq, seqBefore + 3, '1 条用户消息 + 2 条 run_end = 3 个 seq');
});

test('#277-A2 重复停止 ⇒ run_end 仍只有一条（幂等；重放不分配 seq、不重插）', async () => {
  const pool = new StopPool({ run: { id: 'run-q', status: 'queued' } });
  await stopSession(pool, { userId: UID, sessionId: SID });
  const seqAfter = pool.session.last_seq;
  assert.equal(pool.events.length, 1);

  const second = await stopSession(pool, { userId: UID, sessionId: SID });

  assert.equal(second.run.status, 'finished');
  assert.equal(pool.events.length, 1, '重复停止不得再插一条 run_end');
  assert.equal(pool.session.last_seq, seqAfter, '重放路径不得再分配 seq');

  // 幂等的真正护栏：SQL 带 `ON CONFLICT (run_id, client_event_id) DO NOTHING` 仲裁器
  //（端到端不会重插——第 1 步 CAS 已把终态行排除；但万一重入，只有它能保证不撞唯一约束）。
  const ins = pool.sqlJournal.find((e) => /INSERT INTO run_events/.test(e.sql));
  assert.match(ins.sql, /ON CONFLICT \(run_id, client_event_id\) DO NOTHING/, '必须有 run_events 幂等仲裁器');
  const replay = await pool.query(ins.sql, ins.params);
  assert.equal(replay.rowCount, 0, '同 client_event_id 重插被仲裁掉（rowCount 0）');
  assert.equal(pool.events.length, 1, '仲裁后不得多出一行');
  // 换 client_event_id 的“第二条 run_end”会撞部分唯一索引 run_events_run_end_key ⇒ fake 照真库报错
  //（证明上面「只有一条」不是 fake pool 没约束换来的）。
  await assert.rejects(
    () => pool.query(ins.sql, [ins.params[0], ins.params[1], ins.params[2] + 100, 'other-key', ins.params[4]]),
    /run_events_run_end_key/,
  );
});

test('#277-A2 running → stop 不得多出 run_end（终态事件仍由 worker 的 U2 产出，本片不抢它的活）', async () => {
  const pool = new StopPool({
    run: { id: 'run-r', status: 'running', queue_status: 'claimed', claim_token: 'tok', attempts: 1,
      owner: CID, lease_until: new Date(Date.now() + 90_000), claimed_at: new Date(), started_at: new Date() },
  });

  const { out, pushes } = await stopWithNotify(pool);

  assert.equal(out.run.status, 'cancelling');
  assert.equal(pool.events.length, 0, 'cancelling 不是终态：portal 不得提前合成 run_end');
  assert.equal(pool.session.last_seq, 10, '本路径不得分配 seq');
  assert.equal(pushes.length, 0, '无事件就不推 SSE');
});

test('#277-A2 run_end 与 runs 终态同事务：INSERT 必须落在 BEGIN…COMMIT 之间（不照抄 provisioner 的独立小事务 B）', async () => {
  const pool = new StopPool({ run: { id: 'run-q', status: 'queued' } });

  await stopSession(pool, { userId: UID, sessionId: SID });

  const marks = pool.sqlJournal.map((e) => e.sql);
  const iUpdate = marks.findIndex((x) => /UPDATE runs/.test(x) && /SET status = 'finished'/.test(x));
  const iInsert = marks.findIndex((x) => /INSERT INTO run_events/.test(x));
  const iCommit = marks.findIndex((x) => /^\s*COMMIT/.test(x));
  assert.ok(iUpdate >= 0 && iInsert >= 0 && iCommit >= 0, '三步都必须存在');
  assert.ok(iUpdate < iInsert, 'run_end 必须在终态写入之后（同一批副作用）');
  assert.ok(iInsert < iCommit, 'run_end 必须在 COMMIT 之前——拆成提交后独立小事务就会出现「已终态但无 run_end」的窗口');
  assert.equal(marks.filter((x) => /^\s*BEGIN/.test(x)).length, 1, '整个停止流程只应有一个事务');
  assert.equal(marks.filter((x) => /^\s*COMMIT/.test(x)).length, 1);
  assert.equal(pool.commits, 1);
});

test('#277-A 无活跃 run ⇒ 409 no_active_run 语义不变', async () => {
  const pool = new StopPool({ run: { id: 'run-done', status: 'finished' } });
  pool.runRow().termination = { reason: 'end_turn' };
  await assert.rejects(() => stop(pool), (err) => {
    assert.ok(err instanceof SessionError);
    assert.equal(err.code, 'no_active_run');
    assert.equal(err.httpStatus, 409);
    return true;
  });
});

test('#277-A 状态机：queued → finished|failed 合法，queued → running 仍在，非法迁移仍非法（portal.md §9.6）', () => {
  assert.equal(validateTransition('queued', 'finished'), true, '未开始就被取消必须能进终态');
  assert.equal(validateTransition('queued', 'failed'), true);
  assert.equal(validateTransition('queued', 'running'), true, 'worker 领取路径不变');
  assert.equal(validateTransition('running', 'finished'), true);
  assert.equal(validateTransition('running', 'failed'), true);
  assert.equal(validateTransition('cancelling', 'finished'), true);
  assert.equal(validateTransition('cancelling', 'failed'), true);
  // 非法：回退 / 停止后回 running / 终态回退 / 自环
  assert.equal(validateTransition('running', 'queued'), false);
  assert.equal(validateTransition('queued', 'queued'), false);
  assert.equal(validateTransition('queued', 'cancelling'), false, 'queued 不得进 cancelling（#277 根因）');
  assert.equal(validateTransition('cancelling', 'running'), false);
  assert.equal(validateTransition('finished', 'running'), false);
  assert.equal(validateTransition('failed', 'running'), false);
  assert.equal(validateTransition('finished', 'cancelling'), false);
});

// ---- U2 侧护栏：新边不得把「租约门禁」与「非法 from」一起放松 ----

test('#277-A U2：queued + 有效租约上报终态 → 合法（claim 后未及写 running 就结束的 worker 路径）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  assert.equal(pool.runs[0].status, 'queued', '前置：认领后 runs.status 仍 queued');

  const out = await setRunState(pool, {
    container, user, runId, claimToken: ticket.claim_token,
    body: { state: 'finished', termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0 },
  });

  assert.equal(out.state, 'finished');
  assert.equal(pool.runs[0].status, 'finished');
  assert.equal(pool.queue[0].status, 'done', '未取消的终态收敛 queue → done');
});

test('#277-A U2：queued 但租约已失效 → 409 lease_lost（新边不得让旧 worker 越权写终态）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  Object.assign(pool.queue[0], { claim_token: null, lease_until: null });

  await assert.rejects(
    () => setRunState(pool, {
      container, user, runId, claimToken: 'stale',
      body: { state: 'finished', termination: { reason: 'aborted' } },
    }),
    (e) => e.code === 'lease_lost',
  );
  assert.equal(pool.runs[0].status, 'queued', '被拒的写入不得改状态');
});

test('#277-A U2：表外 from 状态 → 仍 409 invalid_transition（护栏没变成「什么都允许」）', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  pool.runs[0].status = 'paused'; // 表外值（真 DB 的 CHECK 不可达，但转换表必须先拦住）

  await assert.rejects(
    () => setRunState(pool, {
      container, user, runId, claimToken: ticket.claim_token,
      body: { state: 'finished', termination: { reason: 'end_turn' } },
    }),
    (e) => e.code === 'invalid_transition' && e.status === 409,
  );
  assert.equal(pool.runs[0].status, 'paused');
});
