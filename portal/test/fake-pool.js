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
    // #456：证书台账（`tls_certificates`）。**不是真相源**（真相是盘上证书文件），只记「谁什么时候装了什么」。
    this.tlsCerts = [];
    // #456 M2：**语句流水**（`{sql, params}`，每条进来的语句）。只给「零副作用」这类判据用：
    // `POST /api/admin/tls/inspect` 必须一条写语句都不发（`SELECT` 可以，鉴权本身要查会话）。
    // ⚠ 刻意**不叫** `sqlLog`：子类（admin/must-change-password/…）自带同名字段并在自己的 `query` 里
    // 记一份，而它们未处理的语句会落到 `super.query` ⇒ 共用一个数组会多出重复条目，把「每请求恰查一次」
    // 那类计数判据误打红（实测 7 条）。
    this.statements = [];
  }

  /**
   * #472 片 A：fake 的「按 SQL 说的做」（AGENTS §8.14）—— 只有 SELECT 里真的写了 `file_upload_enabled`
   * 才回这一列。产品代码漏补列 ⇒ 行里拿不到它 ⇒ `=== true` 得 false ⇒ 用例会红，
   * 而不是被 fake 好心兼平成假绿。
   *
   * ⚠ **必须覆盖成 `undefined` 而不是「不带这个键」**：这些分支的行是 `{ ...u }` 展开出来的，
   * 而种子用户对象本身就有这个键 —— 只删不补的话，「SELECT 里漏了列」会被展开值兼平，
   * 变异测试（把 `authenticate` 的 SELECT 补列删掉）实测绿着过 = 假绿。
   * 值**不做布尔兼平**：`'f'` / `0` / `undefined` 这些形状留着，那正是 A-3 要钉的东西。
   */
  projectFileUpload(sql, user) {
    return { file_upload_enabled: /\bfile_upload_enabled\b/.test(sql) ? user.file_upload_enabled : undefined };
  }

  async query(sql, params = []) {
    this.statements.push({ sql, params });
    if (sql.includes('schema_migrations')) {
      return { rows: [{ version: '0000_baseline' }] };
    }

    // authenticate：按 login 查活跃用户
    if (sql.includes('FROM users WHERE login')) {
      const login = params[0];
      const u = this.users.find((x) => x.login === login && x.status === 'active');
      // #472：SELECT 里没 `file_upload_enabled` 就不回这一列（fake 不兼平，见 `projectFileUpload`）。
      return { rows: u ? [{ ...u, ...this.projectFileUpload(sql, u) }] : [] };
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
          // #472：同上（`loadActiveUser` 的 SELECT）。
          ...this.projectFileUpload(sql, u),
        }],
      };
    }

    // verifyTotpForUser：按 id 查活跃用户（含 totp_secret/last_totp_step）
    if (sql.includes('FROM users WHERE id') && sql.includes('totp_secret')) {
      const userId = params[0];
      const u = this.users.find((x) => x.id === userId && x.status === 'active');
      // #472：同上（`verifyTotpForUser` 的 SELECT）。
      return { rows: u ? [{ ...u, ...this.projectFileUpload(sql, u) }] : [] };
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
            // #472：同上（`findSessionUser` 的 SELECT 里写的是 `u.file_upload_enabled`）。
            ...this.projectFileUpload(sql, u),
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
    // 写侧（管理台 PUT）：**单条 upsert**，按 SQL 文本真模拟——不把新 SQL 当未知放行（AGENTS §8.14 同族）。
    // 同时把迁移 0026 的两条约束当 DB 事实执行：① 只能有一行（id = 1）；② `transport='smtp'` 时
    // host/from 必须非空（半套配置不许落库）。产品侧校验漏了这两条时这里会炸 ⇒ 用例变红而不是静默绿。
    if (sql.includes('INSERT INTO mail_settings')) {
      if (!/ON CONFLICT \(id\) DO UPDATE/.test(sql)) {
        throw new Error('fake：mail_settings 写入必须是单条 upsert（INSERT … ON CONFLICT (id) DO UPDATE）');
      }
      if (!/VALUES \(1,/.test(sql)) throw new Error('fake：mail_settings 是单行表，插入必须写死 id = 1');
      const [transport, host, port, secure, user, password, from, connMs, greetMs, sockMs, updatedBy] = params;
      if (params.length !== 11) throw new Error(`fake：mail_settings upsert 应带 11 个参数，实际 ${params.length}`);
      if (password !== null && typeof password !== 'string') {
        throw new Error('fake：smtp_password 必须是字符串或 null（键缺席时应回落到原值）');
      }
      if (transport !== 'smtp' && transport !== 'disabled') throw new Error('fake：transport 违反 CHECK 约束');
      if (transport === 'smtp' && (host == null || from == null)) {
        throw new Error('fake：CHECK (transport <> \'smtp\' OR (smtp_host IS NOT NULL AND smtp_from IS NOT NULL)) 被违反');
      }
      this.mailSettings = {
        transport,
        smtp_host: host,
        smtp_port: port,
        smtp_secure: secure,
        smtp_user: user,
        smtp_password: password,
        smtp_from: from,
        connection_timeout_ms: connMs,
        greeting_timeout_ms: greetMs,
        socket_timeout_ms: sockMs,
        updated_at: new Date(),
        updated_by: updatedBy,
      };
      return { rows: [{ ...this.mailSettings }], rowCount: 1 };
    }

    if (sql.includes('FROM mail_settings')) {
      // 回副本：避免产品代码拿到 fake 的内部对象引用后就地改（那会让「没落库」的 bug 测不出来）。
      return { rows: this.mailSettings ? [{ ...this.mailSettings }] : [], rowCount: this.mailSettings ? 1 : 0 };
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

    // 成功消费：单条原子 UPDATE。谓词**按 SQL 文本真解析**（AGENTS §8.14）：产品侧少写
    // `AND consumed_at IS NULL` / 少写过期或次数谓词时，fake 必须跟着放宽 ⇒ 「重放保护」这条防线
    // 才在单测里有牙（评审返修 ③ 的变异就落在这里：删掉 consumed_at 谓词必须让重放用例变红）。
    if (sql.includes('UPDATE login_email_codes') && sql.includes('code_hash = $3')) {
      const [pendingTokenHash, now, codeHash] = params;
      const requireUnconsumed = sql.includes('consumed_at IS NULL');
      const requireUnexpired = /expires_at\s*>\s*\$2/.test(sql);
      const requireAttemptsLeft = /attempts\s*<\s*max_attempts/.test(sql);
      const row = this.emailCodes.find((x) => x.pending_token_hash === pendingTokenHash
        && x.code_hash === codeHash
        && (!requireUnconsumed || x.consumed_at === null)
        && (!requireUnexpired || new Date(x.expires_at) > new Date(now))
        && (!requireAttemptsLeft || x.attempts < x.max_attempts));
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

    // ---- #456：证书台账（tls_certificates） ----
    // 写侧：按 SQL 文本真模拟，并把迁移 0027 的约束当 DB 事实执行——
    //   ① `fingerprint_sha256` 必须是**冒号分隔大写**（与 Node fingerprint256 同形，verify 端点直接逐字符比）；
    //   ② `kind` 只有 upload/rollback（CHECK）；
    //   ③ `sans` 是 `text[]` ⇒ 必须传数组。
    // 产品侧把指纹小写化、或把 PEM 当指纹写进去，这里会炸（而不是静默绿）。
    if (sql.includes('INSERT INTO tls_certificates')) {
      const [subjectCn, sans, issuerCn, notBefore, notAfter, fingerprint, kind, uploadedBy] = params;
      if (!/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(fingerprint))) {
        throw new Error(`fake: fingerprint_sha256 必须是冒号分隔大写（与 fingerprint256 同形），实际 ${String(fingerprint).slice(0, 24)}…`);
      }
      if (!Array.isArray(sans)) throw new Error('fake: sans 是 text[]，必须传数组');
      if (kind !== 'upload' && kind !== 'rollback') throw new Error(`fake: kind 违反 CHECK (${kind})`);
      const row = {
        id: `tls${this.tlsCerts.length + 1}`,
        subject_cn: subjectCn,
        sans,
        issuer_cn: issuerCn,
        not_before: notBefore,
        not_after: notAfter,
        fingerprint_sha256: fingerprint,
        kind,
        uploaded_by: uploadedBy,
        uploaded_at: new Date(),
      };
      this.tlsCerts.push(row);
      return { rows: [{ id: row.id, uploaded_at: row.uploaded_at }], rowCount: 1 };
    }

    if (sql.includes('FROM tls_certificates')) {
      const rows = [...this.tlsCerts].sort((a, b) => b.uploaded_at - a.uploaded_at);
      return { rows, rowCount: rows.length };
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
