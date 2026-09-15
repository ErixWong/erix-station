// 共享 in-memory fake pool：模拟 auth.js / http.js 用到的 SQL，**真校验过期/吊销/单次消费**。
// 隔离约定（docs/testing.md §2.1）：注入 fake pool，不碰真实 DB。

export class FakePool {
  constructor({ users = [] } = {}) {
    this.users = users; // [{id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret, last_totp_step}]
    this.pending = [];
    this.sessions = [];
    this.audit = [];
  }

  async query(sql, params = []) {
    if (sql.includes('schema_migrations')) {
      return { rows: [{ version: '0000_baseline' }] };
    }

    // authenticate：按 login 查活跃用户
    if (sql.includes('FROM users WHERE login')) {
      const login = params[0];
      const u = this.users.find((x) => x.login === login && x.status === 'active');
      return { rows: u ? [u] : [] };
    }

    // verifyTotpForUser：按 id 查活跃用户（含 totp_secret/last_totp_step）
    if (sql.includes('FROM users WHERE id') && sql.includes('totp_secret')) {
      const userId = params[0];
      const u = this.users.find((x) => x.id === userId && x.status === 'active');
      return { rows: u ? [u] : [] };
    }

    // createPendingToken
    if (sql.includes('INSERT INTO login_pending')) {
      const [userId, tokenHash, createdAt, expiresAt] = params;
      this.pending.push({ user_id: userId, token_hash: tokenHash, created_at: createdAt, expires_at: expiresAt, used_at: null });
      return { rows: [] };
    }

    // findPendingUser：非消费读取（过期/已用拒绝）
    if (sql.includes('SELECT user_id FROM login_pending')) {
      const [tokenHash, now] = params;
      const p = this.pending.find(
        (x) => x.token_hash === tokenHash && x.used_at === null && new Date(x.expires_at) > new Date(now),
      );
      return { rows: p ? [{ user_id: p.user_id }] : [] };
    }

    // consumePendingToken：单次消费 + 过期校验
    if (sql.includes('UPDATE login_pending SET used_at')) {
      const [tokenHash, now] = params;
      const p = this.pending.find(
        (x) => x.token_hash === tokenHash && x.used_at === null && new Date(x.expires_at) > new Date(now),
      );
      if (!p) return { rows: [] };
      p.used_at = now;
      return { rows: [{ user_id: p.user_id }] };
    }

    // verifyTotpForUser：原子推进 last_totp_step
    if (sql.includes('UPDATE users SET last_totp_step')) {
      const [userId, step] = params;
      const u = this.users.find((x) => x.id === userId);
      if (!u) return { rows: [] };
      const last = u.last_totp_step == null ? null : Number(u.last_totp_step);
      if (last === null || last < Number(step)) {
        u.last_totp_step = Number(step);
        return { rows: [{ id: userId }] };
      }
      return { rows: [] };
    }

    // createSession
    if (sql.includes('INSERT INTO login_sessions')) {
      const [userId, tokenHash, createdAt, expiresAt] = params;
      const s = {
        id: 's' + (this.sessions.length + 1),
        user_id: userId,
        token_hash: tokenHash,
        created_at: createdAt,
        expires_at: expiresAt,
        last_seen_at: createdAt,
        revoked_at: null,
      };
      this.sessions.push(s);
      return { rows: [] };
    }

    // findSessionUser：过期 + 吊销 + 用户 active 全真校验
    if (sql.includes('FROM login_sessions s') && sql.includes('JOIN users')) {
      const [tokenHash, now] = params;
      const s = this.sessions.find(
        (x) => x.token_hash === tokenHash && x.revoked_at === null && new Date(x.expires_at) > new Date(now),
      );
      if (!s) return { rows: [] };
      const u = this.users.find((x) => x.id === s.user_id && x.status === 'active');
      if (!u) return { rows: [] };
      return {
        rows: [
          {
            id: u.id,
            login: u.login,
            display_name: u.display_name,
            role: u.role,
            fde_name: u.fde_name,
            auth_source: u.auth_source,
            status: u.status,
            session_id: s.id,
            expires_at: s.expires_at,
            last_seen_at: s.last_seen_at,
          },
        ],
      };
    }

    // renewSession：滚动续期（距上次续期超阈值才写库；last_seen_at=本次活动时间，expires_at=本次活动+TTL）
    if (sql.includes('UPDATE login_sessions') && sql.includes('last_seen_at <')) {
      const [sessionId, expiresAt, lastSeenAt, cutoff] = params;
      const s = this.sessions.find(
        (x) => x.id === sessionId && x.revoked_at === null && new Date(x.last_seen_at) < new Date(cutoff),
      );
      if (!s) return { rows: [] };
      s.expires_at = expiresAt;
      s.last_seen_at = lastSeenAt;
      return { rows: [{ expires_at: expiresAt }] };
    }

    // revokeSession
    if (sql.includes('UPDATE login_sessions SET revoked_at')) {
      const [tokenHash] = params;
      const s = this.sessions.find((x) => x.token_hash === tokenHash && x.revoked_at === null);
      if (s) s.revoked_at = new Date();
      return { rows: [] };
    }

    // audit（best-effort）
    if (sql.includes('INSERT INTO audit_log')) {
      const [actorId, action, target, details] = params;
      this.audit.push({ actor_id: actorId, action, target, details });
      return { rows: [] };
    }

    return { rows: [] };
  }

  async end() {}
}
