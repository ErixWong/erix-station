// 共享 in-memory fake pool：模拟 auth.js / http.js 用到的 SQL，**真校验过期/吊销/单次消费**。
// 隔离约定（docs/testing.md §2.1）：注入 fake pool，不碰真实 DB。

export class FakePool {
  constructor({ users = [] } = {}) {
    this.users = users; // [{id, login, display_name, role, fde_name, auth_source, status, password_hash, totp_secret, last_totp_step}]
    this.pending = [];
    this.sessions = [];
    this.grants = [];   // #429：revokeSession 的 CTE 会按 login_session_id 血缘撤这里的 active 行
    this.audit = [];
    // #449：登录邮箱验证码（`login_email_codes`）。按 SQL 文本真模拟：取「最新未消费」、attempts 累加、
    // 成功消费、重发作废旧码——不把新 SQL 当未知放行（否则「码错也放行」这类变异在单测里是绿的）。
    this.emailCodes = [];
    // #449：邮件通道配置（单行表 `mail_settings`）。默认无行 = 未配置 = 第二因素不生效。
    this.mailSettings = null;
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

    // hasTotpEnrollment：NULL 与空字符串均表示未注册。
    if (sql.includes("SELECT 1 FROM users WHERE id") && sql.includes("NULLIF(totp_secret, '') IS NOT NULL")) {
      const userId = params[0];
      const u = this.users.find(
        (x) => x.id === userId && x.status === 'active' && x.totp_secret != null && x.totp_secret !== '',
      );
      return { rows: u ? [{ '?column?': 1 }] : [] };
    }

    // loadActiveUser（#449 邮箱码第二步发会话）：按 id 查活跃用户，按 SQL 的列清单回列。
    if (sql.includes('FROM users WHERE id') && sql.includes('must_change_password') && !sql.includes('totp_secret')) {
      const userId = params[0];
      const u = this.users.find((x) => x.id === userId && x.status === 'active');
      if (!u) return { rows: [] };
      return {
        rows: [{
          id: u.id,
          login: u.login,
          display_name: u.display_name,
          role: u.role,
          fde_name: u.fde_name,
          auth_source: u.auth_source,
          email: u.email ?? null,
          must_change_password: u.must_change_password === true,
        }],
      };
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
            // #255：受限会话门的判据就读这一列。**按 SQL 说的做**（AGENTS §8.14）：SELECT 里没这一列
            // 就不回这一列（=> 产品代码 `=== true` 得 false）⇒ 实现漏选这一列时门会失效、用例会红，
            // 而不是由 fake 好心兼平。没声明该列的 users 行一律按 false（不被要求改密）。
            must_change_password: sql.includes('must_change_password') ? u.must_change_password === true : undefined,
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

    // revokeSession（#429 后是实现里的同语句 CTE：吊销会话 + 按 login_session_id 血缘撤 active 预览 grant）。
    // fake 按 SQL 说的做：血缘谓词从 SQL 文本里认（只撤 active，撤 used 就是篡改历史 #252）。
    if (sql.includes('UPDATE login_sessions SET revoked_at')) {
      const [tokenHash] = params;
      const s = this.sessions.find((x) => x.token_hash === tokenHash && x.revoked_at === null);
      if (s) {
        s.revoked_at = new Date();
        if (sql.includes('UPDATE preview_grants')) {
          if (!sql.includes("state = 'active'")) {
            throw new Error('fake：revokeSession 的预览回收必须只撤 state = active（#252 口径）');
          }
          for (const g of this.grants ?? []) {
            if (g.state === 'active' && g.login_session_id === s.id) {
              g.state = 'revoked';
              g.revoked_at = g.revoked_at ?? new Date();
            }
          }
        }
      }
      return { rows: [] };
    }

    // audit（best-effort）
    if (sql.includes('INSERT INTO audit_log')) {
      const [actorId, action, target, details] = params;
      this.audit.push({ actor_id: actorId, action, target, details });
      return { rows: [] };
    }

    // ---- #449：邮件通道配置（mail_settings 单行表） ----
    if (sql.includes('FROM mail_settings')) {
      return { rows: this.mailSettings ? [this.mailSettings] : [], rowCount: this.mailSettings ? 1 : 0 };
    }

    // ---- #449：登录邮箱验证码（login_email_codes） ----
    // 写侧：只接受 sha256 hex（产品代码的契约是「绝不存明文码」，fake 按契约拒明文）。
    if (sql.includes('INSERT INTO login_email_codes')) {
      const [pendingTokenHash, codeHash, createdAt, expiresAt, maxAttempts, resendCount, ip, ua] = params;
      if (!/^[0-9a-f]{64}$/.test(String(pendingTokenHash))) throw new Error('fake: pending_token_hash 必须是 sha256 hex');
      if (!/^[0-9a-f]{64}$/.test(String(codeHash))) throw new Error('fake: code_hash 必须是 sha256 hex（绝不存明文码）');
      if (!Number.isInteger(Number(maxAttempts))) throw new Error('fake: max_attempts NOT NULL');
      const row = {
        id: `ec${this.emailCodes.length + 1}`,
        pending_token_hash: pendingTokenHash,
        code_hash: codeHash,
        created_at: createdAt,
        expires_at: expiresAt,
        attempts: 0,
        max_attempts: Number(maxAttempts),
        resend_count: Number(resendCount ?? 0),
        consumed_at: null,
        created_ip: ip ?? null,
        created_ua: ua ?? null,
      };
      this.emailCodes.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    // 校验读：该 pending 下「最新一条未消费」。
    if (sql.includes('FROM login_email_codes') && sql.includes('pending_token_hash = $1 AND consumed_at IS NULL')) {
      const [pendingTokenHash] = params;
      const rows = this.emailCodes
        .filter((x) => x.pending_token_hash === pendingTokenHash && x.consumed_at === null)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || String(b.id).localeCompare(String(a.id)));
      const row = rows[0];
      return {
        rows: row
          ? [{
            id: row.id, code_hash: row.code_hash, expires_at: row.expires_at,
            attempts: row.attempts, max_attempts: row.max_attempts,
          }]
          : [],
        rowCount: row ? 1 : 0,
      };
    }

    // 重发闸门读：该 pending 下「最新一条」（含已消费——冷却按最近一次发信算）。
    if (sql.includes('FROM login_email_codes') && sql.includes('resend_count')) {
      const [pendingTokenHash] = params;
      const rows = this.emailCodes
        .filter((x) => x.pending_token_hash === pendingTokenHash)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || String(b.id).localeCompare(String(a.id)));
      const row = rows[0];
      return {
        rows: row ? [{ id: row.id, resend_count: row.resend_count, created_at: row.created_at }] : [],
        rowCount: row ? 1 : 0,
      };
    }

    // 码错：attempts + 1；达到上限同时作废（与产品 SQL 的 CASE 同语义）。
    if (sql.includes('UPDATE login_email_codes') && sql.includes('attempts = attempts + 1')) {
      const [id, now] = params;
      const row = this.emailCodes.find((x) => x.id === id && x.consumed_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      row.attempts += 1;
      if (row.attempts >= row.max_attempts) row.consumed_at = now;
      return { rows: [], rowCount: 1 };
    }

    // 成功消费：单条原子 UPDATE（谓词与产品 SQL 逐条同形）。
    if (sql.includes('UPDATE login_email_codes') && sql.includes('code_hash = $3')) {
      const [pendingTokenHash, now, codeHash] = params;
      const row = this.emailCodes.find((x) => x.pending_token_hash === pendingTokenHash
        && x.consumed_at === null
        && new Date(x.expires_at) > new Date(now)
        && x.code_hash === codeHash
        && x.attempts < x.max_attempts);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed_at = now;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    // 重发作废旧码（保留新码）。
    if (sql.includes('UPDATE login_email_codes') && sql.includes('code_hash <> $3')) {
      const [pendingTokenHash, now, keepCodeHash] = params;
      let n = 0;
      for (const row of this.emailCodes) {
        if (row.pending_token_hash === pendingTokenHash && row.consumed_at === null && row.code_hash !== keepCodeHash) {
          row.consumed_at = now;
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }

    // 按 id 作废（尝试次数用尽时的幂等标记）。
    if (sql.includes('UPDATE login_email_codes') && sql.includes('WHERE id = $1 AND consumed_at IS NULL')) {
      const [id, now] = params;
      const row = this.emailCodes.find((x) => x.id === id && x.consumed_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      row.consumed_at = now;
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('login_email_codes')) {
      // 严格 fake：没认出来的 SQL 直接炸，不静默返回空行（AGENTS §8.14 同族）。
      throw new Error(`fake: 未识别的 login_email_codes SQL：${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

    return { rows: [] };
  }

  async end() {}

  // issue #183：git-credential 的 updateAssignedAccount 现走事务（pool.connect）；
  // fake pool 用同一 query 处理器充当事务 client（BEGIN/COMMIT 落入默认空行）。
  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }
}
