// 内存 fake pool：模拟 internal.js 用到的核心 SQL（claim/state/events/release/heartbeat/round/checkpoint）。
// 隔离约定（docs/testing.md §2.1）：注入 fake pool，不碰真实 DB。
// 并发语义：claim 的 UPDATE 在 JS 单线程内同步完成（无内部 await），故并发 claim 只有一个成功（SKIP LOCKED 等价）。

import { hashToken } from '../src/auth.js';
import { createSessionTextHandler } from './fake-session-text.js';

export class FakeInternalPool {
  constructor(seed = {}) {
    this.users = seed.users ?? [];
    this.containers = seed.containers ?? [];
    this.projects = seed.projects ?? [];
    this.sessions = seed.sessions ?? [];
    this.runs = seed.runs ?? [];
    this.queue = seed.queue ?? [];
    this.messages = seed.messages ?? [];
    this.events = seed.events ?? [];
    this.rounds = seed.rounds ?? [];
    this.checkpoints = seed.checkpoints ?? [];
    this.approvals = seed.approvals ?? [];
    // tool_calls 行补齐两列缺省值（NULL 就是 NULL，不是「没这个键」），与真库列默认值同口径。
    this.toolCalls = (seed.toolCalls ?? []).map((row) => Object.assign({ duration_ms: null, result_digest: null }, row, {
      duration_ms: row.duration_ms ?? null,
      result_digest: row.result_digest ?? null,
    }));
    this.usage = seed.usage ?? [];
    // issue #117：binding slots hold LiteLLM model_info.id strings; credentials/models live upstream.
    this.llm = {
      providers: seed.llm?.providers ?? [],
      models: seed.llm?.models ?? [],
      bindings: seed.llm?.bindings ?? [],     // [{fde_id, state, gateway, api_key, main_model_id, ...}]
    };
    this.auditLog = [];
    // 计数器一开始就存在：只在建构造后第一次写入时才出现的计数器，会让"没写过"和"没查过"看起来一样。
    this.agentVersionWrites = 0;
    this._claim = 0;
    // 事务模拟（对 `run_events` 的写入 + `allocSeq` + release/reaper 的 runs/run_queue 状态改写建撤销
    // 日志，#292 扩到后两项）：`failCommitOnce = true` 让下一次 COMMIT 抛错。
    this._txn = null;
    this.failCommitOnce = false;
    // 语句时序日志（`{sql, index, txnId}`）：「同事务」是能被观测的契约——只有「在 BEGIN…COMMIT 窗口里」
    // 才叫同事务，把 INSERT 挑到 COMMIT 之后就应当红（AGENTS §8.14 的变异验收）。
    this.sqlLog = [];
    this._txnId = 0;
    // P3 PR②b B1：`session-text.js` 的取数面（投影取文本）。共用 `this.messages` / `this.rounds` 引用，
    // 所以 putSessionRound / appendUserInputTurn / 终态 assistant 回写的内容对文本读取立即可见。
    this.sessionText = createSessionTextHandler({
      messages: this.messages,
      transcriptRows: this.rounds,
      sessionId: seed.sessionId ?? null,
    });
  }

  _user(id) {
    return this.users.find((u) => u.id === id);
  }
  _container(id) {
    return this.containers.find((c) => c.id === id);
  }
  _run(id) {
    return this.runs.find((r) => r.id === id);
  }
  _session(id) {
    return this.sessions.find((s) => s.id === id);
  }
  _queue(runId) {
    return this.queue.find((q) => q.run_id === runId);
  }

  /** 已提交 + 本事务未提交暂存的 run_events 合并视图（真库 read-your-writes）。 */
  _eventVisible(pred) {
    return [...this.events, ...(this._txn?.events ?? [])].find(pred);
  }

  _txnEventsPending() {
    return this._txn ? this._txn.events.length : 0;
  }

  async query(sql, params = []) {
    const norm = String(sql).replace(/\s+/g, ' ').trim();
    if (/^BEGIN\b/i.test(norm)) this._txnId += 1;
    const inTxn = this._txn != null || /^BEGIN\b/i.test(norm);
    this.sqlLog.push({ sql: norm, index: this.sqlLog.length, txnId: inTxn ? this._txnId : null });
    const res = await this._query(sql, params);
    if (res && res.rows && !('rowCount' in res)) res.rowCount = res.rows.length;
    return res;
  }

  async _query(sql, params = []) {
    // session-text.js（AI 改名 / 自动标题 / claim task / claim 历史 / 终态幂等）的取数 SQL：优先派发。
    const textHit = this.sessionText(sql, params);
    if (textHit) return textHit;

    // ---- authenticateContainer ----
    if (sql.includes('FROM containers c') && sql.includes('JOIN users u')) {
      const tokenHash = params[0];
      const c = this.containers.find((x) => x.runner_token_hash === tokenHash);
      if (!c) return { rows: [] };
      const u = this._user(c.user_id);
      return {
        rows: [
          {
            container_id: c.id,
            user_id: c.user_id,
            revoked_at: c.revoked_at ?? null,
            container_status: c.status ?? 'running',
            fde_name: c.fde_name,
            container_name: c.container_name,
            token_generation: c.token_generation ?? 1,
            login: u?.login ?? '',
            display_name: u?.display_name ?? null,
            email: u?.email ?? null,
            user_status: u?.status ?? 'active',
          },
        ],
      };
    }

    // ---- claim（原子：同步无 await）----
    if (sql.includes('UPDATE run_queue') && sql.includes('FOR UPDATE SKIP LOCKED')) {
      const [containerId, claimToken, userId] = params;
      const now = Date.now();
      const eligible = this.queue
        .filter((q) => {
          const r = this._run(q.run_id);
          if (!r) return false;
          const s = this._session(r.session_id);
          if (!s || s.user_id !== userId) return false;
          if (!['queued', 'running'].includes(r.status)) return false;
          if (q.attempts >= q.max_attempts) return false;
          const leaseExpired = q.status === 'claimed' && q.lease_until != null && q.lease_until < now;
          return q.status === 'pending' || leaseExpired;
        })
        .sort((a, b) => a.created_at - b.created_at);
      if (eligible.length === 0) return { rows: [] };
      const q = eligible[0];
      q.status = 'claimed';
      q.claimed_at = now;
      q.lease_until = now + 90000;
      q.owner_container_id = containerId;
      q.claim_token = claimToken;
      q.attempts += 1;
      return { rows: [{ queue_id: q.id, run_id: q.run_id, claim_token: q.claim_token, lease_until: q.lease_until, attempts: q.attempts }] };
    }

    // ---- reaper：候选扫描（claimed + 租约过期）----
    if (sql.includes('FROM run_queue q JOIN runs r') && sql.includes("q.status = 'claimed'")) {
      const now = Date.now();
      const rows = this.queue
        .filter((q) => q.status === 'claimed' && q.lease_until != null && q.lease_until < now)
        .map((q) => {
          const r = this._run(q.run_id);
          return { run_id: q.run_id, attempts: q.attempts, max_attempts: q.max_attempts, status: r?.status, session_id: r?.session_id };
        });
      return { rows };
    }

    // ---- fetchRun / claim run 行（runs JOIN chat_sessions；含会话 model/cwd 投影）----
    if (sql.includes('FROM runs r') && sql.includes('JOIN chat_sessions s') && sql.includes('WHERE r.id')) {
      const runId = params[0];
      const r = this._run(runId);
      if (!r) return { rows: [] };
      const s = this._session(r.session_id);
      return {
        rows: [
          {
            id: r.id,
            session_id: r.session_id,
            status: r.status,
            cancel_requested_at: r.cancel_requested_at ?? null,
            rounds: r.rounds ?? 0,
            usage: r.usage ?? null,
            error: r.error ?? null,
            termination: r.termination ?? null,
            user_id: s?.user_id ?? null,
            project_id: s?.project_id ?? null,
            model: s?.model ?? null,
            cwd: s?.cwd ?? null,
          },
        ],
      };
    }

    // ---- finishRun：锁 run 行（SELECT id, session_id, status FROM runs WHERE id FOR UPDATE）----
    if (sql.includes('SELECT id, session_id, status FROM runs') && sql.includes('WHERE id')) {
      const runId = params[0];
      const r = this._run(runId);
      return { rows: r ? [{ id: r.id, session_id: r.session_id, status: r.status }] : [] };
    }

    // ---- assertClaimToken / heartbeat / release / events 读 run_queue 单行 ----
    if (sql.includes('FROM run_queue WHERE run_id')) {
      const runId = params[0];
      const q = this._queue(runId);
      if (!q) return { rows: [] };
      // F1：SQL 带 lease_until > now() 时应用层在 DB 模拟租约过期 fencing。
      if (sql.includes('lease_until > now()') && !(q.lease_until != null && q.lease_until > Date.now())) {
        return { rows: [] };
      }
      if (sql.includes('FOR UPDATE')) {
        return { rows: [{ claim_token: q.claim_token, attempts: q.attempts, max_attempts: q.max_attempts, status: q.status, lease_until: q.lease_until }] };
      }
      return { rows: [{ claim_token: q.claim_token, status: q.status, lease_until: q.lease_until }] };
    }

    // P5：claim 的 run 行直接带出 s.cwd（fake 经上方 fetchRun 投影）；不再查询 projects 表。

    // ---- messages（claim 会话历史下行，issue #69：最近 user/assistant，排除当前 message_id，DESC LIMIT）----
    if (sql.includes('FROM messages') && sql.includes('role IN')) {
      const [sessionId, excludeId, limit] = params;
      const rows = [...this.messages]
        .filter((x) => x.session_id === sessionId && ['user', 'assistant'].includes(x.role) && x.id !== excludeId)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map((m) => ({ role: m.role, content: m.content }));
      return { rows };
    }

    // ---- messages（claim task）----
    if (sql.includes('FROM messages') && sql.includes("role = 'user'")) {
      const runId = params[0];
      const m = [...this.messages].filter((x) => x.run_id === runId && x.role === 'user').sort((a, b) => b.seq - a.seq)[0];
      return { rows: m ? [{ id: m.id, content: m.content, attachments: m.attachments ?? [] }] : [] };
    }

    // ---- setRunState：markRunning ----
    if (sql.includes("SET status = 'running'") && sql.includes('FROM run_queue q')) {
      const [runId, claimToken] = params;
      const r = this._run(runId);
      const q = this._queue(runId);
      if (!r || !q || q.claim_token !== claimToken) return { rows: [] };
      if (q.lease_until == null || q.lease_until <= Date.now()) return { rows: [] };
      if (!['queued', 'running'].includes(r.status)) return { rows: [] };
      r.status = 'running';
      r.started_at = r.started_at ?? Date.now();
      return { rows: [{ id: runId }] };
    }

    // ---- 事务边界（run_events 的 INSERT / allocSeq / runs・run_queue 状态改写都建撤销日志，见文件内 ⚠ 注）----
    if (/^\s*BEGIN\b/i.test(sql)) {
      this._txn = { events: [], undo: [] };
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*COMMIT\b/i.test(sql)) {
      const txn = this._txn ?? { events: [], undo: [] };
      this._txn = null;
      if (this.failCommitOnce) {
        this.failCommitOnce = false;
        // 真库能在这里失败（串行冲突/死锁/连接掉线）。失败 = 本事务的写一钱不值。
        for (const undo of [...txn.undo].reverse()) undo();
        throw Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
      }
      this.events.push(...txn.events);
      return { rows: [], rowCount: 0 };
    }
    if (/^\s*ROLLBACK\b/i.test(sql)) {
      const txn = this._txn;
      this._txn = null;
      if (txn) for (const undo of [...txn.undo].reverse()) undo();
      return { rows: [], rowCount: 0 };
    }

    // ---- allocSeq ----
    if (sql.includes('SET last_seq = last_seq + 1')) {
      const sessionId = params[0];
      const s = this._session(sessionId);
      const prev = s.last_seq ?? 0;
      s.last_seq = prev + 1;
      if (this._txn) this._txn.undo.push(() => { s.last_seq = prev; }); // 回滚 ⇒ seq 不被消费（真库同一事务）
      return { rows: [{ last_seq: s.last_seq }] };
    }

    // ---- events：查重（真库 read-your-writes：同事务内未提交的暂存行也算看见）----
    if (sql.includes('FROM run_events WHERE run_id') && sql.includes('client_event_id')) {
      const [runId, clientEventId] = params;
      const hit = this._eventVisible((e) => e.run_id === runId && e.client_event_id === clientEventId);
      return { rows: hit ? [{}] : [] };
    }

    // ---- events：插入 ----
    // ⚠ **type / payload 的位置从 SQL 文本里解析，不是写死两形态**（AGENTS §8.14 的教训：fake 必须
    // 模拟真库，否则「新事件类型接不上」这类事实在单测里结构上不可能被发现——#288 第一版 fake 只认
    // `'run_end'` 字面量与「type 在 $5」两种形态，于是 `attempt_killed`（type 是字面量、payload 在 $5）
    // 被当成 `type = <payload JSON>`，事件凭空「不存在」）。
    // 同时按 docs/data/schema.sql:360-371 的真库约束裁决（不是无条件吞重复）：
    //   * `UNIQUE (run_id, client_event_id)` / `UNIQUE (session_id, seq)`：撞约束时**只有** SQL 里真写了
    //     `ON CONFLICT … DO NOTHING` 才静默跳过（幂等语义由 SQL 提供，不是 fake 白送）；SQL 没写就抛
    //     23505（与真库同形）⇒ 把产品代码里的 `ON CONFLICT DO NOTHING` 摘掉，幂等用例必须红。
    //   * `payload jsonb NOT NULL`：拿不到 payload 参数就抛 23502（上面那种错位会当场炸在这里）。
    // ⚠ 事务语义（#288 变异④「INSERT 挪到 COMMIT 之后」）：run_events 的 INSERT 进**未提交暂存区**，
    //   `COMMIT` 才落到 `events`、`ROLLBACK` 丢弃；同事务内的读（上面的查重 SELECT）看得见暂存行
    //   （真库 read-your-writes）。`failCommitOnce` 让下一次 COMMIT 抛错模拟「提交失败/连接掉线」。
    if (sql.includes('INSERT INTO run_events')) {
      const literalType = sql.match(/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*\$4,\s*'([a-z_]+)'/)?.[1] ?? null;
      const [runId, sessionId, seq, clientEventId] = params;
      const type = literalType ?? params[4];
      const payload = literalType !== null ? params[4] : params[5];
      if (payload === undefined || payload === null) {
        throw Object.assign(new Error('null value in column "payload" of relation "run_events" violates not-null constraint'), { code: '23502' });
      }
      const dupOnConflict = /ON\s+CONFLICT[^;]*?DO\s+NOTHING/i.test(sql);
      const clash = (key, msg) => {
        if (dupOnConflict) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING：0 行
        throw Object.assign(new Error(msg), { code: '23505' });
      };
      if (this._eventVisible((e) => e.run_id === runId && e.client_event_id === clientEventId)) {
        return clash('ceid', 'duplicate key value violates unique constraint "run_events_run_id_client_event_id_key"');
      }
      if (this._eventVisible((e) => e.session_id === sessionId && Number(e.seq) === Number(seq))) {
        return clash('seq', 'duplicate key value violates unique constraint "run_events_session_id_seq_key"');
      }
      const row = { run_id: runId, session_id: sessionId, seq, client_event_id: clientEventId, type, payload };
      if (this._txn) this._txn.events.push(row); else this.events.push(row);
      return { rows: [{ id: 'ev' + (this.events.length + this._txnEventsPending()) }], rowCount: 1 };
    }

    // ---- heartbeat：更新容器心跳 ----
    // #404 结案：心跳落账 agent_version（同值不写 ⇒ 这里也照 SQL 的 IS DISTINCT FROM 语义判）
    if (sql.includes('UPDATE containers') && sql.includes('agent_version IS DISTINCT FROM')) {
      const [containerId, version] = params;
      const c = this._container(containerId);
      const changed = Boolean(c) && c.agent_version !== version;
      if (c && changed) c.agent_version = version;
      // "同值不写"必须可观测：真库靠 `IS DISTINCT FROM` 让 UPDATE 命中 0 行（也就不动 updated_at），
      // 这里把它记成计数，判据才能钉住"15s 一次的心跳不许把这一行刷成噪音"。
      this.agentVersionWrites = (this.agentVersionWrites ?? 0) + (changed ? 1 : 0);
      return { rows: [], rowCount: changed ? 1 : 0 };
    }

    if (sql.includes('UPDATE containers') && sql.includes('last_heartbeat')) {
      const [containerId] = params;
      const c = this._container(containerId);
      if (c) c.last_heartbeat = Date.now();
      return { rows: [] };
    }

    // ---- port_observations（观测层 MVP，迁移 0022）：heartbeat listeners 整批替换 ----
    if (sql.includes('SELECT port FROM port_observations')) {
      const list = this.portObservations ?? [];
      return { rows: list.filter((o) => o.container_id === params[0]).map((o) => ({ port: o.port })) };
    }
    // ---- #361：in_use 翻转→重刷 ports.json 的 outbox 入队（bump revision + 插 outbox 行）----
    if (sql.includes('INSERT INTO materialize_revisions')) {
      const [fde_id] = params;
      const revs = (this.materializeRevisions ??= {});
      revs[fde_id] = (revs[fde_id] ?? 0) + 1;
      return { rows: [{ revision: revs[fde_id] }] };
    }
    if (sql.includes('INSERT INTO materialize_outbox')) {
      const [fde_id, op, revision] = params;
      (this.materializeOps ??= []).push({ fde_id, op, revision });
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM port_observations')) {
      this.portObservations = (this.portObservations ?? []).filter((o) => o.container_id !== params[0]);
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO port_observations')) {
      const [fde_id, container_id, port, pid, cwd, cmd, branch, proc_started_at] = params;
      const list = (this.portObservations ??= []);
      const row = { fde_id, container_id, port, pid, cwd, cmd, branch, proc_started_at, observed_at: Date.now() };
      const existing = list.find((o) => o.container_id === container_id && o.port === port);
      if (existing) Object.assign(existing, row);
      else list.push(row);
      return { rows: [] };
    }

    // ---- heartbeat：LLM serving names read alongside the text model_info.id slots ----
    if (sql.includes('FROM fde_llm_bindings') && sql.includes('main_model_id, main_model_name')) {
      const [userId] = params;
      const b = this.llm.bindings.find((x) =>
        x.fde_id === userId && x.state === 'active' && x.gateway === 'litellm' && x.api_key,
      );
      if (!b) return { rows: [] };
      return {
        rows: [{
          main_model_id: b.main_model_id ?? null,
          main_model_name: b.main_model_name ?? null,
          embedding_model_id: b.embedding_model_id ?? null,
          embedding_model_name: b.embedding_model_name ?? null,
          vision_model_id: b.vision_model_id ?? null,
          vision_model_name: b.vision_model_name ?? null,
        }],
      };
    }

    // ---- heartbeat：续租 ----
    if (sql.includes('SET lease_until = now() + interval')) {
      const [runId, claimToken] = params;
      const q = this._queue(runId);
      if (!q || q.claim_token !== claimToken) return { rows: [] };
      if (q.lease_until == null || q.lease_until <= Date.now()) return { rows: [] };
      q.lease_until = Date.now() + 90000;
      return { rows: [{ lease_until: q.lease_until }] };
    }

    // ---- finishRun：runs 终态（$2 参数化 status）----
    if (sql.includes('UPDATE runs SET status = $2')) {
      const [runId, state] = params;
      const r = this._run(runId);
      if (r) {
        r.status = state;
        r.termination = params[2] ? JSON.parse(params[2]) : null;
        r.usage = params[3] ? JSON.parse(params[3]) : null;
        r.rounds = params[4] ?? 0;
        r.error = params[5] ? JSON.parse(params[5]) : null;
        r.ended_at = Date.now();
      }
      return { rows: [] };
    }

    // ---- finishRun：run_queue 终态收敛（$2 参数化 status）----
    if (sql.includes('UPDATE run_queue SET status = $2')) {
      const [runId, status] = params;
      const q = this._queue(runId);
      if (q) {
        q.status = status;
        q.claim_token = null;
        q.owner_container_id = null;
        q.lease_until = null;
        q.claimed_at = null;
      }
      return { rows: [] };
    }

    // ---- releaseUndeliveredClaim（issue #180：孤儿化 claim 回滚；attempts 递减 + RETURNING）----
    if (sql.includes('UPDATE run_queue') && sql.includes('GREATEST(attempts - 1, 0)')) {
      const [runId, claimToken] = params;
      const q = this._queue(runId);
      if (!q || q.claim_token !== claimToken || q.status !== 'claimed') return { rows: [] };
      q.status = 'pending';
      q.claimed_at = null;
      q.lease_until = null;
      q.owner_container_id = null;
      q.claim_token = null;
      q.attempts = Math.max(q.attempts - 1, 0);
      return { rows: [{ attempts: q.attempts, max_attempts: q.max_attempts }] };
    }

    // ---- release/reaper：queue 收敛（字面量 status）----
    // issue #292：与下方 runs 分支一起登记撤销（真库里它们与 run_events 的 INSERT **同一个事务**，
    // COMMIT 失败就得一起作废）。原 fake 只给 run_events/allocSeq 建撤销 ⇒「提交失败后只剩半截
    // 收敛」在单测里结构上不可见（放宽 fake 是禁的，这是反方向的**收紧**）。
    if (sql.includes('UPDATE run_queue SET status=')) {
      const [runId] = params;
      const q = this._queue(runId);
      if (q) {
        const before = { status: q.status, owner_container_id: q.owner_container_id, lease_until: q.lease_until, claimed_at: q.claimed_at, claim_token: q.claim_token };
        if (sql.includes("status='cancelled'")) q.status = 'cancelled';
        else if (sql.includes("status='pending'")) q.status = 'pending';
        else if (sql.includes("status='done'")) q.status = 'done';
        q.owner_container_id = null;
        q.lease_until = null;
        q.claimed_at = null;
        // release（U12）保留 claim_token 供幂等重放；reaper 显式 claim_token=NULL 才清。
        if (sql.includes('claim_token=NULL')) q.claim_token = null;
        if (this._txn) this._txn.undo.push(() => Object.assign(q, before));
      }
      return { rows: [] };
    }

    // ---- release：runs 收敛（字面量 status）----
    if (sql.includes('UPDATE runs SET status=')) {
      const [runId] = params;
      const r = this._run(runId);
      if (r) {
        const before = { status: r.status, hadEndedAt: 'ended_at' in r, ended_at: r.ended_at };
        if (sql.includes("'finished'")) r.status = 'finished';
        else if (sql.includes("'queued'")) r.status = 'queued';
        else if (sql.includes("'failed'")) r.status = 'failed';
        if (sql.includes('ended_at')) r.ended_at = Date.now();
        if (this._txn) this._txn.undo.push(() => {
          r.status = before.status;
          if (before.hadEndedAt) r.ended_at = before.ended_at; else delete r.ended_at;
        });
      }
      return { rows: [] };
    }

    // ---- session transcript rounds（issue #81 P2：键 = transcript_key，唯一性 = (key, dedup_key)）----
    if (sql.includes('INSERT INTO transcript_rounds') && sql.includes('transcript_key')) {
      const [key, dedupKey, round, record, folded, messages, foldedPayload] = params;
      if (this.rounds.some((x) => x.transcript_key === key && x.dedup_key === dedupKey)) return { rows: [] };
      // append_seq = 插入序（真实 schema 由迁移 0016 的序列保证；fake 用同一自增计数器模拟）。
      const seq = ++this._claim;
      this.rounds.push({ transcript_key: key, dedup_key: dedupKey, run_id: null, round, record: JSON.parse(record), folded, messages: JSON.parse(messages), folded_payload: foldedPayload ? JSON.parse(foldedPayload) : null, created_at: seq, append_seq: seq });
      return { rows: [{ id: 'sr' + this.rounds.length }] };
    }
    if (sql.includes('FROM transcript_rounds WHERE transcript_key') && sql.includes('dedup_key')) {
      const [key, dedupKey] = params;
      const r = this.rounds.find((x) => x.transcript_key === key && x.dedup_key === dedupKey);
      return { rows: r ? [{ record: r.record, folded: r.folded }] : [] };
    }
    if (sql.includes('UPDATE transcript_rounds SET record') && sql.includes('transcript_key')) {
      const [key, dedupKey, record, folded, messages, foldedPayload] = params;
      const r = this.rounds.find((x) => x.transcript_key === key && x.dedup_key === dedupKey);
      if (r) {
        r.record = JSON.parse(record);
        r.folded = folded === true;
        r.messages = JSON.parse(messages);
        r.folded_payload = foldedPayload ? JSON.parse(foldedPayload) : r.folded_payload ?? null;
      }
      return { rows: [] };
    }
    // #189/#195：recallTranscript 的取数面（round 区间 + record/folded_payload 两列，同 append_seq 保序）。
    if (sql.includes('FROM transcript_rounds') && sql.includes('round BETWEEN')) {
      const [runId, from, to] = params;
      const rows = this.rounds
        .filter((x) => x.run_id === runId && x.round >= from && x.round <= to)
        .sort((a, b) => (a.round - b.round)
          || ((a.append_seq ?? a.created_at ?? 0) - (b.append_seq ?? b.created_at ?? 0)))
        .slice(0, 2000)
        .map((x) => ({ round: x.round, record: x.record, folded_payload: x.folded_payload ?? null }));
      return { rows };
    }
    // issue #338：session transcript 读面是**按行**的 `(round, append_seq)` 真 keyset。
    // 规矩：**照 SQL 文本裁决**——谓词写的是行值比较还是只比 round，由 SQL 自己说了算，
    // 不替产品兜底。旧语义分支留着不是「宽容」：恰恰相反，若 fake 只有 keyset 一支，
    // 有人把谓词改回 `AND round > $2` 时 fake 会拿旧参数集硬套 keyset 语义，
    // M1 变异就变成**空操作**（#338 的丢行 bug 在单测里永远复现不出来）。
    // append_seq 是 bigint：真 pg 驱动把它当**字符串**返回，fake 也返回字符串。
    if (sql.includes('SELECT round, record, append_seq FROM transcript_rounds') && sql.includes('transcript_key')) {
      // 种子行可能没有 append_seq（历史测试只填 created_at）⇒ 同排序口径回落，保证全序可比。
      const seqOf = (x) => Number(x.append_seq ?? x.created_at ?? 0);
      const sorted = (rows) => rows
        .sort((a, b) => (a.round - b.round) || (seqOf(a) - seqOf(b)))
        .map((x) => ({ round: x.round, record: x.record, append_seq: String(seqOf(x)) }));
      if (sql.includes('(round, append_seq) > (')) {
        const [key, cursorRound, cursorSeq, limit] = params;
        const cr = Number(cursorRound);
        // 断点比较用 BigInt（真库 append_seq 是 bigint，可能超 Number.MAX_SAFE_INTEGER；
        // Number 比较会把 9007199254740993 和 …992 当相等 ⇒ fake 比真库宽松）。
        const cs = BigInt(cursorSeq);
        return {
          rows: sorted(this.rounds.filter((x) => x.transcript_key === key
            && (x.round > cr || (x.round === cr && BigInt(seqOf(x)) > cs)))).slice(0, limit),
        };
      }
      // #338 之前的形态（`AND round > $2`，3 个参数）：谓词只看 round ⇒ 同 round 的后继行被跳过。
      // 只在产品真的回退时才走到这里（正常路径上一分支就 return 了）。
      const [key, cursorRound, limit] = params;
      return {
        rows: sorted(this.rounds.filter((x) => x.transcript_key === key && x.round > Number(cursorRound)))
          .slice(0, limit),
      };
    }

    // ---- transcript rounds（run 作用域读；session 读分支在前）----
    if (sql.includes('SELECT round, record FROM transcript_rounds')) {
      const [runId, cursor, limit] = params;
      const rows = this.rounds
        .filter((x) => x.run_id === runId && x.round > cursor)
        .sort((a, b) => (a.round - b.round)
          || ((a.append_seq ?? a.created_at ?? 0) - (b.append_seq ?? b.created_at ?? 0)))
        .slice(0, limit)
        .map((x) => ({ round: x.round, record: x.record }));
      return { rows };
    }

    // ---- session checkpoint（issue #81 P2：ON CONFLICT (transcript_key) + revision CAS）----
    if (sql.includes('INSERT INTO run_checkpoints') && sql.includes('transcript_key')) {
      const [runId, key, snapshot, revision] = params;
      const existing = this.checkpoints.find((c) => c.transcript_key === key);
      if (!existing) {
        this.checkpoints.push({ run_id: runId, transcript_key: key, snapshot: JSON.parse(snapshot), revision });
        return { rows: [{ revision }] };
      }
      if (revision > existing.revision) {
        existing.snapshot = JSON.parse(snapshot);
        existing.revision = revision;
        return { rows: [{ revision }] };
      }
      return { rows: [] }; // stale
    }
    if (sql.includes('FROM run_checkpoints WHERE transcript_key')) {
      const [key] = params;
      const c = this.checkpoints.find((x) => x.transcript_key === key);
      return { rows: c ? [{ snapshot: c.snapshot, revision: c.revision, updated_at: new Date() }] : [] };
    }

    // ---- session 属主校验（fetchSession）----
    if (sql.includes('SELECT id, user_id FROM chat_sessions WHERE id')) {
      const key = params[0];
      const s = this._session(key);
      return { rows: s ? [{ id: s.id, user_id: s.user_id }] : [] };
    }

    // ---- session 引擎 run state / status（issue #81 P2 + erix-agent 0.14.0）----
    if (sql.includes('UPDATE chat_sessions') && sql.includes('engine_run_state')) {
      const [key, patchJson, userId, writerRunId, claimToken] = params;
      const s = this._session(key);
      const r = this._run(writerRunId);
      const q = this._queue(writerRunId);
      if (!s || s.user_id !== userId || !r || r.session_id !== key || !q
          || q.claim_token !== claimToken || q.lease_until == null || q.lease_until <= Date.now()
          || !['queued', 'running', 'cancelling'].includes(r.status)) {
        return { rows: [] };
      }
      if (sql.includes('SET engine_run_state_status')) {
        s.engine_run_state_status = JSON.parse(patchJson);
      } else {
        s.engine_run_state = { ...(s.engine_run_state ?? {}), ...JSON.parse(patchJson) };
      }
      return { rows: [{ id: key }] };
    }
    if (sql.includes('SELECT engine_run_state') && sql.includes('FROM chat_sessions WHERE id')) {
      const key = params[0];
      const s = this._session(key);
      return { rows: s ? [{
        engine_run_state: s.engine_run_state ?? null,
        engine_run_state_status: s.engine_run_state_status ?? null,
        has_engine_run_state_status: s.engine_run_state_status != null,
      }] : [] };
    }

    // ---- transcript rounds ----
    if (sql.includes('INSERT INTO transcript_rounds')) {
      const [runId, round, record, folded, messages, foldedPayload] = params;
      if (this.rounds.some((x) => x.run_id === runId && x.round === round)) return { rows: [] };
      this.rounds.push({ run_id: runId, round, record: JSON.parse(record), folded, messages: JSON.parse(messages), folded_payload: foldedPayload ? JSON.parse(foldedPayload) : null });
      return { rows: [{ id: 'r' + this.rounds.length }] };
    }
    if (sql.includes('FROM transcript_rounds WHERE run_id') && sql.includes('AND round')) {
      const [runId, round] = params;
      const r = this.rounds.find((x) => x.run_id === runId && x.round === round);
      return { rows: r ? [{ record: r.record, folded: r.folded }] : [] };
    }

    // ---- checkpoint ----
    if (sql.includes('INSERT INTO run_checkpoints')) {
      const [runId, snapshot, revision] = params;
      const existing = this.checkpoints.find((c) => c.run_id === runId);
      if (!existing) {
        this.checkpoints.push({ run_id: runId, snapshot: JSON.parse(snapshot), revision });
        return { rows: [{ revision }] };
      }
      if (revision > existing.revision) {
        existing.snapshot = JSON.parse(snapshot);
        existing.revision = revision;
        return { rows: [{ revision }] };
      }
      return { rows: [] }; // stale
    }
    if (sql.includes('FROM run_checkpoints WHERE run_id')) {
      const runId = params[0];
      const c = this.checkpoints.find((x) => x.run_id === runId);
      return { rows: c ? [{ snapshot: c.snapshot, revision: c.revision, updated_at: new Date() }] : [] };
    }

    // ---- runstate snapshot/status（F2：条件 UPDATE 包含非终态+属主+有效租约）----
    if (sql.includes('UPDATE runs r') && sql.includes('SET run_state')) {
      const [runId, claimToken, userId, patchJson] = params;
      const r = this._run(runId);
      const q = this._queue(runId);
      const s = r ? this._session(r.session_id) : null;
      if (!r || !q || !s || s.user_id !== userId) return { rows: [] };
      if (q.claim_token !== claimToken) return { rows: [] };
      if (q.lease_until == null || q.lease_until <= Date.now()) return { rows: [] };
      if (!['queued', 'running', 'cancelling'].includes(r.status)) return { rows: [] };
      if (sql.includes('SET run_state_status')) {
        r.run_state_status = JSON.parse(patchJson);
      } else {
        r.run_state = { ...(r.run_state ?? {}), ...JSON.parse(patchJson) };
      }
      return { rows: [{ id: runId }] };
    }
    if (sql.includes('SELECT run_state') && sql.includes('FROM runs WHERE id')) {
      const runId = params[0];
      const r = this._run(runId);
      return { rows: r ? [{
        run_state: r.run_state ?? null,
        run_state_status: r.run_state_status ?? null,
        has_run_state_status: r.run_state_status != null,
      }] : [] };
    }

    // ---- approvals ----
    if (sql.includes('INSERT INTO approvals')) {
      const [runId, toolCallId] = params;
      if (this.approvals.some((a) => a.run_id === runId && a.tool_call_id === toolCallId)) return { rows: [] };
      const a = { id: 'ap' + (this.approvals.length + 1), run_id: runId, tool_call_id: toolCallId, status: 'pending' };
      this.approvals.push(a);
      return { rows: [{ id: a.id }] };
    }
    if (sql.includes('FROM approvals') && sql.includes('LEFT JOIN users')) {
      const id = params[0];
      const a = this.approvals.find((x) => x.id === id);
      return { rows: a ? [a] : [] };
    }

    // ---- tool_calls（issue #283）----
    // ⚠ **谓词从 SQL 文本里解析，不是写死行为**（AGENTS §8.14 的教训：fake 必须模拟真库约束，
    // 否则「幂等 / 不擦写」这类性质在单测里结构上不可能被发现）：
    //   * INSERT 走 `ON CONFLICT (run_id, call_id) DO NOTHING`（UNIQUE 在真库里存在）；
    //   * `call_id` NOT NULL ⇒ 给空就报 23502（与真库同形，不许静默吞）；
    //   * UPDATE 的 `AND duration_ms IS NULL` / `AND result_digest IS NULL` 守卫从 SQL 里读：
    //     把产品代码里的守卫删掉，本 fake 就会**真的**把已写值擦成 NULL ⇒ 变异测试必须红。
    if (sql.includes('INSERT INTO tool_calls')) {
      const [runId, callId, round, name, input] = params;
      if (typeof callId !== 'string' || callId === '') {
        throw Object.assign(new Error('null value in column "call_id" of relation "tool_calls" violates not-null constraint'), { code: '23502' });
      }
      if (this.toolCalls.some((x) => x.run_id === runId && x.call_id === callId)) return { rows: [], rowCount: 0 };
      this.toolCalls.push({
        run_id: runId, call_id: callId,
        round: round ?? 0, name: name ?? '', input: input ? JSON.parse(input) : {},
        duration_ms: null, result_digest: null, judged: false, approved: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE tool_calls')) {
      const [runId, callId, durationMs, digest] = params;
      const guardDuration = /duration_ms\s+IS\s+NULL/i.test(sql);
      const guardDigest = /result_digest\s+IS\s+NULL/i.test(sql);
      let touched = 0;
      for (const row of this.toolCalls) {
        if (row.run_id !== runId || row.call_id !== callId) continue;
        if (guardDuration && row.duration_ms !== null) continue;
        if (guardDigest && row.result_digest !== null) continue;
        row.duration_ms = durationMs === undefined ? null : durationMs;
        row.result_digest = digest === undefined ? null : digest;
        touched += 1;
      }
      return { rows: [], rowCount: touched };
    }
    if (sql.includes('FROM tool_calls')) {
      const [runId, callId] = params;
      return { rows: this.toolCalls.filter((x) => (runId === undefined || x.run_id === runId)
        && (callId === undefined || x.call_id === callId)) };
    }

    // ---- usage_ledger ----
    if (sql.includes('INSERT INTO usage_ledger')) {
      this.usage.push(params);
      return { rows: [] };
    }

    // ---- messages assistant final_text 读取（M4：终态幂等比对）----
    if (sql.includes('FROM messages') && sql.includes("role = 'assistant'") && sql.includes('ORDER BY seq DESC')) {
      const [runId] = params;
      const m = [...this.messages].filter((x) => x.run_id === runId && x.role === 'assistant').sort((a, b) => b.seq - a.seq)[0];
      return { rows: m ? [{ content: m.content }] : [] };
    }

    // ---- messages assistant 回写（role 为字面量 'assistant'）----
    // P3 PR②b B2：写侧不再把正文当参数（`content` 恒为空串字面量），故从 SQL 文本里取该字面量——
    // 测试因此能钉住「新行 content = ''」；将来若回到写正文，正则取不到而是 undefined，用例自会红。
    if (sql.includes('INSERT INTO messages')) {
      const [sessionId, runId, seq] = params;
      const content = sql.match(/'assistant',\s*'([^']*)'/)?.[1];
      this.messages.push({ id: 'm' + (this.messages.length + 1), session_id: sessionId, run_id: runId, seq, role: 'assistant', content });
      return { rows: [] };
    }

    // ---- audit ----
    if (sql.includes('INSERT INTO audit_log')) {
      this.auditLog.push(params);
      return { rows: [] };
    }

    return { rows: [] };
  }

  async connect() {
    const pool = this;
    return {
      query: (sql, params) => pool.query(sql, params),
      release() {},
    };
  }

  async end() {}
}

/** 便捷构造：一套最小可认领的 run 现场。 */
export function seedClaimable({ userId = 'u1', containerId = 'c1', runId = 'run1', sessionId = 's1', projectId = 'p1', token = 'tok_plain' } = {}) {
  const pool = new FakeInternalPool({
    users: [{ id: userId, login: 'alice', display_name: 'Alice', email: 'alice@example.test', status: 'active' }],
    containers: [{ id: containerId, user_id: userId, runner_token_hash: hashToken(token), status: 'running', fde_name: 'alice', container_name: 'fde-alice', token_generation: 1 }],
    projects: [{ id: projectId, name: 'proj1', root_path: '~/projects/proj1' }],
    sessions: [{ id: sessionId, user_id: userId, project_id: projectId, cwd: '~/projects/proj1', model: 'mock-model', last_seq: 0 }],
    runs: [{ id: runId, session_id: sessionId, status: 'queued' }],
    queue: [{ id: 'q1', run_id: runId, container_id: containerId, status: 'pending', attempts: 0, max_attempts: 3, created_at: 1 }],
    messages: [{ id: 'm1', run_id: runId, session_id: sessionId, role: 'user', content: 'hello', seq: 1, attachments: [] }],
  });
  return { pool, userId, containerId, runId, sessionId, projectId, token };
}
