// 内存 fake pool：模拟 internal.js 用到的核心 SQL（claim/state/events/release/heartbeat/round/checkpoint）。
// 隔离约定（docs/testing.md §2.1）：注入 fake pool，不碰真实 DB。
// 并发语义：claim 的 UPDATE 在 JS 单线程内同步完成（无内部 await），故并发 claim 只有一个成功（SKIP LOCKED 等价）。

import { hashToken } from '../src/auth.js';

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
    this.toolCalls = seed.toolCalls ?? [];
    this.usage = seed.usage ?? [];
    // issue #38 Phase B2：心跳下行模型集（fde_llm_bindings / llm_providers / llm_models）。
    this.llm = {
      providers: seed.llm?.providers ?? [],   // [{id, enabled}]
      models: seed.llm?.models ?? [],         // [{id, provider_id, model_id, type, tool_calling, enabled}]
      bindings: seed.llm?.bindings ?? [],     // [{fde_id, state, provider_id, main_model_id, embedding_model_id, vision_model_id}]
    };
    this.auditLog = [];
    this._claim = 0;
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

  async query(sql, params = []) {
    const res = await this._query(sql, params);
    if (res && res.rows && !('rowCount' in res)) res.rowCount = res.rows.length;
    return res;
  }

  async _query(sql, params = []) {
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

    // ---- fetchRun ----
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

    // ---- 项目（claim ticket 组装）----
    if (sql.includes('SELECT name, root_path FROM projects')) {
      const sessionId = params[0];
      const s = this._session(sessionId);
      const p = this.projects.find((x) => x.id === s?.project_id);
      return { rows: p ? [{ name: p.name, root_path: p.root_path }] : [] };
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

    // ---- allocSeq ----
    if (sql.includes('SET last_seq = last_seq + 1')) {
      const sessionId = params[0];
      const s = this._session(sessionId);
      s.last_seq = (s.last_seq ?? 0) + 1;
      return { rows: [{ last_seq: s.last_seq }] };
    }

    // ---- events：查重 ----
    if (sql.includes('FROM run_events WHERE run_id') && sql.includes('client_event_id')) {
      const [runId, clientEventId] = params;
      const hit = this.events.find((e) => e.run_id === runId && e.client_event_id === clientEventId);
      return { rows: hit ? [{}] : [] };
    }

    // ---- events：插入（run_end 为字面量 type，其余为参数化 type）----
    if (sql.includes('INSERT INTO run_events')) {
      const runEnd = sql.includes("'run_end'");
      const [runId, sessionId, seq, clientEventId] = params;
      const type = runEnd ? 'run_end' : params[4];
      const payload = runEnd ? params[4] : params[5];
      if (this.events.some((e) => e.run_id === runId && e.client_event_id === clientEventId)) return { rows: [] };
      this.events.push({ run_id: runId, session_id: sessionId, seq, client_event_id: clientEventId, type, payload });
      return { rows: [{ id: 'ev' + this.events.length }] };
    }

    // ---- heartbeat：更新容器心跳 ----
    if (sql.includes('UPDATE containers') && sql.includes('last_heartbeat')) {
      const [containerId] = params;
      const c = this._container(containerId);
      if (c) c.last_heartbeat = Date.now();
      return { rows: [] };
    }

    // ---- heartbeat：LLM 下行模型集（getFdeLlmHeartbeatModels：bindings JOIN providers JOIN models）----
    if (sql.includes('FROM fde_llm_bindings b') && sql.includes('JOIN llm_providers')) {
      const [userId] = params;
      const b = this.llm.bindings.find((x) => x.fde_id === userId && x.state === 'active');
      if (!b) return { rows: [] };
      const p = this.llm.providers.find((x) => x.id === b.provider_id && x.enabled !== false);
      if (!p) return { rows: [] };
      const upstream = (id, ok) => {
        if (id == null) return null;
        const m = this.llm.models.find((x) => x.id === id);
        if (!m || m.enabled === false || !ok(m)) return null;
        return m.model_id;
      };
      return {
        rows: [{
          main_upstream: upstream(b.main_model_id, (m) => m.type === 'text' && m.tool_calling === true),
          embedding_upstream: upstream(b.embedding_model_id ?? null, (m) => m.type === 'embedding'),
          vision_upstream: upstream(b.vision_model_id ?? null, (m) => m.type === 'vision'),
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

    // ---- release/reaper：queue 收敛（字面量 status）----
    if (sql.includes('UPDATE run_queue SET status=')) {
      const [runId] = params;
      const q = this._queue(runId);
      if (q) {
        if (sql.includes("status='cancelled'")) q.status = 'cancelled';
        else if (sql.includes("status='pending'")) q.status = 'pending';
        else if (sql.includes("status='done'")) q.status = 'done';
        q.owner_container_id = null;
        q.lease_until = null;
        q.claimed_at = null;
        // release（U12）保留 claim_token 供幂等重放；reaper 显式 claim_token=NULL 才清。
        if (sql.includes('claim_token=NULL')) q.claim_token = null;
      }
      return { rows: [] };
    }

    // ---- release：runs 收敛（字面量 status）----
    if (sql.includes('UPDATE runs SET status=')) {
      const [runId] = params;
      const r = this._run(runId);
      if (r) {
        if (sql.includes("'finished'")) r.status = 'finished';
        else if (sql.includes("'queued'")) r.status = 'queued';
        else if (sql.includes("'failed'")) r.status = 'failed';
        if (sql.includes('ended_at')) r.ended_at = Date.now();
      }
      return { rows: [] };
    }

    // ---- transcript rounds ----
    if (sql.includes('INSERT INTO transcript_rounds')) {
      const [runId, round, record, folded, messages] = params;
      if (this.rounds.some((x) => x.run_id === runId && x.round === round)) return { rows: [] };
      this.rounds.push({ run_id: runId, round, record: JSON.parse(record), folded, messages: JSON.parse(messages) });
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

    // ---- tool_calls ----
    if (sql.includes('FROM tool_calls') || sql.includes('INSERT INTO tool_calls')) {
      return { rows: [] };
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
    if (sql.includes('INSERT INTO messages')) {
      const [sessionId, runId, seq, content] = params;
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
    users: [{ id: userId, login: 'alice', status: 'active' }],
    containers: [{ id: containerId, user_id: userId, runner_token_hash: hashToken(token), status: 'running', fde_name: 'alice', container_name: 'fde-alice', token_generation: 1 }],
    projects: [{ id: projectId, name: 'proj1', root_path: '~/projects/proj1' }],
    sessions: [{ id: sessionId, user_id: userId, project_id: projectId, model: 'mock-model', last_seq: 0 }],
    runs: [{ id: runId, session_id: sessionId, status: 'queued' }],
    queue: [{ id: 'q1', run_id: runId, container_id: containerId, status: 'pending', attempts: 0, max_attempts: 3, created_at: 1 }],
    messages: [{ id: 'm1', run_id: runId, session_id: sessionId, role: 'user', content: 'hello', seq: 1, attachments: [] }],
  });
  return { pool, userId, containerId, runId, sessionId, projectId, token };
}
