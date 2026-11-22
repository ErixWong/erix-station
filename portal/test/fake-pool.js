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
    // #485 片 A：单文件上传上限（单行表 `upload_settings`）。默认无行 = 未配置 = 回落 env/默认。
    // 存的是 `{ max_file_bytes, updated_at, updated_by }`（max_file_bytes 存 **number**，
    // 出参时再按真驱动的形状转成字符串，见下面 `FROM upload_settings` 分支的长注）。
    this.uploadSettings = null;
    // #485 复 audit（活二）：注入「审计 `INSERT` 失败」。保存是一条 CTE 语句 ⇒ 注入成立时整条语句
    // 失败而设置**一格没变**（语句级原子）。默认 false = 不注入。
    this.failAudit = false;
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

  /**
   * feat-261110-02（迁移 0030）「允许用 TOTP 登录」这一列，同一条 fake 红线：SELECT 里点了名才回，
   * 漏选 ⇒ 值恒 `undefined` ⇒ 产品侧 `!== false` 会得 true（存量默认），而 `=== true`（admin DTO）得 false
   * ⇒ 漏补列在两侧都有用例会红，不是被 fake 兼平成假绿。同样**不做布尔兼平**。
   */
  projectTotpLogin(sql, user) {
    return { totp_login_enabled: /\btotp_login_enabled\b/.test(sql) ? user.totp_login_enabled : undefined };
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
      // #472 合并注记：两边都在修同一类问题——**fake 必须按 SQL 的列清单回列**，不许用整行兼平。
      // origin/main 那版（#449 回归）把投影做成通用的（从 SELECT 里解析列名），比本分支原来的
      // 单列 `projectFileUpload` 更强 ⇒ 这里取通用版；`projectFileUpload` 仍服务另外三处分支
      // （loadActiveUser / verifyTotpForUser / findSessionUser），那三处 origin/main 没动。
      if (!u) return { rows: [] };
      // **按 SQL 的列清单投影**（#449 回归）：真 PG 只回 SELECT 里点名的列，
      // 而过去这里直接回整行 ⇒ 「SELECT 漏掉 mail_otp_enabled」这类 bug 在单测里永远看不见
      // （生产上 `row.mail_otp_enabled` 恒 undefined ⇒ per-user 邮件验证码开关整条死掉）。
      // 同理覆盖 #472 的 `file_upload_enabled`：漏选该列 ⇒ 行里没有它 ⇒ `=== true` 得 false ⇒ 用例红。
      const m = /SELECT ([\s\S]*?) FROM users WHERE login/.exec(sql);
      if (!m) return { rows: [u] };
      const cols = m[1].split(',').map((c) => {
        const t = c.trim();
        const as = /\s+AS\s+(\w+)$/i.exec(t);
        return as ? as[1] : t.split('.').pop();
      });
      const projected = {};
      for (const c of cols) if (Object.hasOwn(u, c)) projected[c] = u[c];
      return { rows: [projected] };
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
          // feat-261110-02：同理（第二步与审计要读这一位）。
          ...this.projectTotpLogin(sql, u),
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

    // ---- #485 片 A 复 audit（活二）：保存 = 读旧值 + upsert + 写审计，**一条** CTE 语句 ----
    // ⚠ 必须排在下面那条 `INSERT INTO audit_log` 之前：这条 SQL 同时含两张表的 INSERT，
    // 让通用审计分支先认到就会**吞掉 upsert**（设置没改、只多一条审计，用例却绿 = 假绿）。
    // fake 真模拟三件事：① 旧值取的是**本语句开始时**的库状态（快照）；② `previous_*` 的区间判定
    // **按 SQL 写的做**（`BETWEEN $5 AND $6` 没写就放宽 ⇒ 「区间判定被删」这种变异会红）；
    //   ③ `failAudit` 注入时整条语句失败而 `uploadSettings` **一格没变**（语句级原子，对应 US-20）。
    if (sql.includes('INSERT INTO upload_settings') && /\bWITH\s+prev\b/i.test(sql)) {
      if (!/ON CONFLICT \(id\) DO UPDATE/.test(sql)) {
        throw new Error('fake：upload_settings 写入必须是单条 upsert（INSERT … ON CONFLICT (id) DO UPDATE）');
      }
      if (!/VALUES \(1,/.test(sql)) throw new Error('fake：upload_settings 是单行表，插入必须写死 id = 1');
      // 形状闸（#698 返修）：prev 带 `FOR UPDATE` 时，同一条含 data-modifying CTE 的语句里它**看不见本语句
      // 要改的那一行**（真库 postgres:16 实测：`previous_raw` 恒 null、`rowCount` 恒 0 ⇒ 保存恒 500）。
      // fake 按这个实测口径裁决（看到 `FOR UPDATE` 就直接报错，而不是比真库更宽容）。
      if (/\bFOR UPDATE\b/.test(sql)) {
        throw new Error('fake：prev 不许带 `FOR UPDATE`——同一条含 data-modifying CTE 的语句里它看不见本语句'
          + '要改的那行 ⇒ prev 恒空 ⇒ previous_* 拿不到旧值且主查询 0 行（issue #698 的现场）');
      }
      // 形状闸（#698 的另一半）：首写没有旧行，`FROM upd, prev_eff`（内连接）会把 upsert 那一行一起吃掉
      // ⇒ 主查询 0 行、审计不写 ⇒ 保存恒 500。两处都必须是 `LEFT JOIN prev_eff ON true`（所以数两次）。
      const leftJoins = (sql.match(/LEFT JOIN\s+prev_eff\s+ON\s+true/gi) || []).length;
      if (leftJoins !== 2) {
        throw new Error(`fake：aud 与主查询都必须 \`LEFT JOIN prev_eff ON true\`（首写无旧行，内连接会把` +
          `\`upd\` 那一行一起吃掉，issue #698）；当前命中 ${leftJoins} 处，应为 2 处`);
      }
      if (params.length !== 8) throw new Error(`fake：upload_settings 保存语句应带 8 个参数，实际 ${params.length}`);
      const [maxFileBytes, updatedBy, fallbackBytes, fallbackSource, minBytes, maxBytes, action, target] = params;
      const value = Number(maxFileBytes);
      if (!Number.isFinite(value)) throw new Error('fake：max_file_bytes 是 bigint NOT NULL，不能是 undefined/null/NaN');
      if (value <= 0) throw new Error('fake：CHECK (max_file_bytes > 0) 被违反');
      if (fallbackSource !== 'env' && fallbackSource !== 'default') {
        throw new Error(`fake：previous_source 回落位只可能是 env/default，实际 ${fallbackSource}`);
      }
      // 旧值：与 `FROM upload_settings` 分支同形状（bigint ⇒ 字符串）。
      const previousRaw = this.uploadSettings ? String(this.uploadSettings.max_file_bytes) : null;
      const previousValue = previousRaw === null ? null : Number(previousRaw);
      // SQL 里那句 CASE 的等价实现；`BETWEEN $5 AND $6` 被删 ⇒ 判定放宽（不兼平）。
      const requireRange = /BETWEEN\s+\$5\s+AND\s+\$6/.test(sql);
      const dbUsable = previousValue !== null && Number.isSafeInteger(previousValue)
        && (!requireRange || (previousValue >= Number(minBytes) && previousValue <= Number(maxBytes)));
      const previousMaxBytes = dbUsable ? previousValue : Number(fallbackBytes);
      const previousSource = dbUsable ? 'db' : fallbackSource;
      // 注入审计失败：真库里这是一条语句 ⇒ 设置与审计同生共死。fake 必须同样“要么全做要么全不做”，
      // 不然它比产品更宽容，“审计写不进去也照样改成了”就测不出来（US-20）。
      if (this.failAudit) throw new Error('fake：audit_log 写入失败（注入）');
      this.uploadSettings = { max_file_bytes: value, updated_at: new Date(), updated_by: updatedBy };
      this.audit.push({
        actor_id: updatedBy,
        action,
        target,
        // 真库把这列存成 jsonb；这里保持与旧实现（`auth.audit` 传 `JSON.stringify`）**同形状**，
        // 免得“形状变了”与“内容变了”两个不同的红揉成一条。
        details: JSON.stringify({
          max_file_bytes: value,
          previous_max_bytes: previousMaxBytes,
          previous_source: previousSource,
        }),
      });
      return {
        rows: [{
          max_file_bytes: String(value),
          updated_at: this.uploadSettings.updated_at,
          updated_by: updatedBy,
          previous_raw: previousRaw,
          audit_rows: 1,
        }],
        rowCount: 1,
      };
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

    // ---- #485 片 A：单文件上传上限（upload_settings 单行表，迁移 0035） ----
    // 写侧按 SQL 文本真模拟（AGENTS §8.14 “不把新 SQL 当未知放行”），并把迁移 0035 的两条
    // 约束当 **DB 事实**执行：① 只能有一行（id = 1）；② `CHECK (max_file_bytes > 0)`。
    // 产品侧漏了这两条时 fake 会炸 ⇒ 用例变红，而不是静默存下一个“半个值”。
    if (sql.includes('INSERT INTO upload_settings')) {
      if (!/ON CONFLICT \(id\) DO UPDATE/.test(sql)) {
        throw new Error('fake：upload_settings 写入必须是单条 upsert（INSERT … ON CONFLICT (id) DO UPDATE）');
      }
      if (!/VALUES \(1,/.test(sql)) throw new Error('fake：upload_settings 是单行表，插入必须写死 id = 1');
      if (params.length !== 2) throw new Error(`fake：upload_settings upsert 应带 2 个参数，实际 ${params.length}`);
      const [maxFileBytes, updatedBy] = params;
      const value = Number(maxFileBytes);
      if (!Number.isFinite(value)) throw new Error('fake：max_file_bytes 是 bigint NOT NULL，不能是 undefined/null/NaN');
      if (value <= 0) throw new Error('fake：CHECK (max_file_bytes > 0) 被违反');
      this.uploadSettings = { max_file_bytes: value, updated_at: new Date(), updated_by: updatedBy };
      return { rows: [{ ...this.uploadSettings, max_file_bytes: String(value) }], rowCount: 1 };
    }

    if (sql.includes('FROM upload_settings')) {
      // ⚠ **`max_file_bytes` 回字符串**，这不是手误：它是 `bigint`（int8），node-pg 对 int8 **默认就回
      // 字符串**（不自动转 number，怕超 2^53 丢精度）。fake 必须复制这个形状，否则产品侧一个
      // `Number(row.max_file_bytes)` / `parseInt(row.max_file_bytes)` 的错误在单测里是绿的，到真库上才锈
      // （`parseInt('1e4') === 1` 那族，台账 §8.126）。
      return {
        rows: this.uploadSettings
          ? [{ ...this.uploadSettings, max_file_bytes: String(this.uploadSettings.max_file_bytes) }]
          : [],
        rowCount: this.uploadSettings ? 1 : 0,
      };
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
