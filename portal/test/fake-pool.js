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
    // #485 复 audit（活二）：注入「审计 `INSERT` 失败」。保存现在是一个**事务** ⇒ 注入成立时产品侧
    // `ROLLBACK` ⇒ 设置**一格没变**、审计零行（事务级原子，US-21）。默认 false = 不注入。
    this.failAudit = false;
    // #698b：**连接级事务的撤销账**（只在「本连接当前正在一个事务里」时非 null，见 `connect()`）。
    // fake 原本完全不模拟事务：`ROLLBACK` 落空 ⇒ 「审计写不进去 ⇒ 设置也没改」在 fake 里不可表示
    //（而那是硬口径 6 的一半）。这里只补**最小的一块**：事务里的写记下怎么撤销，`ROLLBACK` 逐条撤销、
    // `COMMIT` 丢弃。⚠ **刻意不模拟 MVCC / 行锁**（见 `connect()` 的注）——并发可见性不在 fake 的口径里。
    this._txUndo = null;
    // #456：证书台账（`tls_certificates`）。**不是真相源**（真相是盘上证书文件），只记「谁什么时候装了什么」。
    this.tlsCerts = [];
    // #736：API 令牌（`api_tokens`）。按 SQL 文本真模拟：INSERT（含 UNIQUE(user_id,name) 撞名）、
    // 按 hash 取活跃行、条件 UPDATE last_used_at、UPDATE revoked_at、列表。列名写错真库才报（见工单）。
    this.apiTokens = [];
    // #456 M2：**语句流水**（`{sql, params}`，每条进来的语句）。只给「零副作用」这类判据用：
    // `POST /api/admin/tls/inspect` 必须一条写语句都不发（`SELECT` 可以，鉴权本身要查会话）。
    // ⚠ 刻意**不叫** `sqlLog`：子类（admin/must-change-password/…）自带同名字段并在自己的 `query` 里
    // 记一份，而它们未处理的语句会落到 `super.query` ⇒ 共用一个数组会多出重复条目，把「每请求恰查一次」
    // 那类计数判据误打红（实测 7 条）。
    this.statements = [];
  }

  /**
   * #472 片 A：fake 的「按 SQL 说的做」—— 只有 SELECT 里真的写了 `file_upload_enabled`
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
   * #828 P1：与 `projectFileUpload` 同口径的语言偏好投影——只有 SELECT 里真的写了
   * `locale` 才回这一列（`findSessionUser` 的 SELECT 写了 `u.locale`）。值**不做兼平**：
   * 直接透传 `user.locale`（可为 `null`），产品侧 `row.locale ?? null` 自己兼平。
   */
  projectLocale(sql, user) {
    return /\blocale\b/.test(sql) ? { locale: user.locale ?? null } : {};
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
            // #255：受限会话门的判据就读这一列。**按 SQL 说的做**：SELECT 里没这一列
            // 就不回这一列（=> 产品代码 `=== true` 得 false）⇒ 实现漏选这一列时门会失效、用例会红，
            // 而不是由 fake 好心兼平。没声明该列的 users 行一律按 false（不被要求改密）。
            must_change_password: sql.includes('must_change_password') ? u.must_change_password === true : undefined,
            session_id: s.id,
            expires_at: s.expires_at,
            last_seen_at: s.last_seen_at,
            // #472：同上（`findSessionUser` 的 SELECT 里写的是 `u.file_upload_enabled`）。
            ...this.projectFileUpload(sql, u),
            // #828 P1：同上口径（`findSessionUser` 的 SELECT 里写的是 `u.locale`）。SQL 里没这一列
            // 就不回（=> 产品代码 `row.locale ?? null` 得 null），实现漏选这一列时用例会红，不由 fake 兼平。
            ...this.projectLocale(sql, u),
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

    // ---- #698b：保存 = **一个事务**（`BEGIN` → `SELECT … FOR UPDATE` → upsert → 审计 → `COMMIT`）----
    // 旧版这里是一条 `WITH prev … upd … aud` 的 CTE 语句（`SAVE_SQL`），fake 在这一条语句里一次性做完
    // 「读旧值 + 写设置 + 写审计」。产品侧改成事务后，那套模拟整块作废：
    //   * 「同一语句内 `FOR UPDATE` 看不见本语句要改的行」（上一版硬闸的依据）不再是产品形状；
    //   * `previous_*` 由 JS 单点派生，fake 不再自己算一份区间判定（那正是"比产品更宽容"的第二套策略）；
    //   * 原子性改由 `connect()` 里的**撤销账**表达（`ROLLBACK` ⇒ 写回去，见那里）。
    // 留下的只有两条**形状闸**（都比真库松，不在 fake 里判语义）：
    //   ① `FOR UPDATE` 不许出现在 upsert 那条语句里（`INSERT INTO upload_settings` 分支）；
    //   ② `upload_settings` 的审计必须落在事务里（`INSERT INTO audit_log` 分支）。
    // ⚠ **fake 不模拟行锁与可见性**：并发保存的链（谁记谁的旧值）在 fake 里没有意义，判据在
    //   `portal/test/upload-settings-real-db.test.js`。在 fake 上测并发 = 拿 fake 的调度当 PG 的语义。
    // audit（best-effort；`auth.audit` 与 #698b 的保存事务都走这一条）
    if (sql.includes('INSERT INTO audit_log')) {
      // 形状闸（#698b）：一条语句同时写两张表 = 上一版 `SAVE_SQL` 那条 CTE（硬口径 6 已作废），
      // 在这里挡下来比“诚 quietly 吞掉 upsert”好：不挡的话设置没改、只多一条审计，用例却绿。
      if (sql.includes('INSERT INTO upload_settings')) {
        throw new Error('fake：写设置与写审计必须是**事务里的两条语句**（硬口径 6）；'
          + '一条语句同时写两张表是上一版的 CTE 形状（#698：它既拿不到行锁又看不见本语句要改的那行）');
      }
      const [actorId, action, target, details] = params;
      // 形状闸（#698b，对应硬口径 6「审计与设置同生共死」）：`upload_settings` 的审计必须落在事务里。
      // 真库允许审计在事务外插（不报），所以这道闸**只为这一张表的审计服务**——其它 action 走
      // `auth.audit`（本就无事务）⇒ 不管。拿不到事务上下文 = 产品把审计挪到了 COMMIT 之后。
      if (target === 'upload_settings' && !this._txUndo) {
        throw new Error('fake：upload_settings 的审计必须在 `BEGIN`…`COMMIT` 之间（硬口径 6）；'
          + '事务外写审计就是「设置已生效而审计一行没有」那个窗口（#698 活二）');
      }
      if (this.failAudit) throw new Error('fake：audit_log 写入失败（注入）');
      const row = { actor_id: actorId, action, target, details };
      this.audit.push(row);
      // 事务里插的审计 → 记一条撤销（`ROLLBACK` 只摸本事务插的那几行，按对象身份删，
      // 不会误删同期另一条路径（如 `auth.audit`）插的无辜行）。
      if (this._txUndo) {
        this._txUndo.push(() => {
          const i = this.audit.indexOf(row);
          if (i >= 0) this.audit.splice(i, 1);
        });
      }
      // `rowCount: 1` 是真库形状（单行 INSERT）：产品侧拿它当「审计必须落一行」的闸（US-21 同族）。
      return { rows: [], rowCount: 1 };
    }

    // ---- #449：邮件通道配置（mail_settings 单行表） ----
    // 写侧（管理台 PUT）：**单条 upsert**，按 SQL 文本真模拟——不把新 SQL 当未知放行。
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

    // ---- #485 片 A：单文件上传上限（upload_settings 单行表，迁移 0035/0036）----
    // 写侧按 SQL 文本真模拟（ “不把新 SQL 当未知放行”），并把迁移 0035 的两条
    // 约束当 **DB 事实**执行：① 只能有一行（id = 1）；② `CHECK (max_file_bytes > 0)`。
    // 产品侧漏了这两条时 fake 会炸 ⇒ 用例变红，而不是静默存下一个“半个值”。
    if (sql.includes('INSERT INTO upload_settings')) {
      if (!/ON CONFLICT \(id\) DO UPDATE/.test(sql)) {
        throw new Error('fake：upload_settings 写入必须是单条 upsert（INSERT … ON CONFLICT (id) DO UPDATE）');
      }
      if (!/VALUES \(1,/.test(sql)) throw new Error('fake：upload_settings 是单行表，插入必须写死 id = 1');
      // 形状闸（#698b）：`FOR UPDATE` 不许出现在 upsert 那条语句里。真库不报（比它松的不是这条闸，
      // 而是“拿不到旧值”这个事实）：同一条含 data-modifying 的语句里 `FOR UPDATE` 看不见本语句要改的
      // 那行（#698 第一轮实测）⇒ 锁白拿、旧值拿不到。行锁必须在 `PREVIOUS_SQL` 那一条单独语句里。
      if (/\bFOR UPDATE\b/.test(sql)) {
        throw new Error('fake：`FOR UPDATE` 不许嵌在 upsert 语句里（#698：同一条含 data-modifying 的语句里'
          + '它看不见本语句要改的那行）——它必须是事务里单独的那条 SELECT');
      }
      if (params.length !== 2) throw new Error(`fake：upload_settings upsert 应带 2 个参数，实际 ${params.length}`);
      const [maxFileBytes, updatedBy] = params;
      const value = Number(maxFileBytes);
      if (!Number.isFinite(value)) throw new Error('fake：max_file_bytes 是 bigint NOT NULL，不能是 undefined/null/NaN');
      if (value <= 0) throw new Error('fake：CHECK (max_file_bytes > 0) 被违反');
      // 事务里写的 → 记下“怎么写回去”（US-21：审计写不进去 ⇒ 设置一格没变）。
      const before = this.uploadSettings;
      if (this._txUndo) this._txUndo.push(() => { this.uploadSettings = before; });
      this.uploadSettings = { max_file_bytes: value, updated_at: new Date(), updated_by: updatedBy };
      return { rows: [{ ...this.uploadSettings, max_file_bytes: String(value) }], rowCount: 1 };
    }

    // #698b：保存事务的第 1 条 —— 单独一条 `SELECT … FOR UPDATE`（拿锁 + 拿最新已提交值）。
    // fake **不模拟锁**（它只把当前状态回出去），但必须按 SQL 的列清单回列（#472 同一条红线）：
    // 产品要的是 `AS raw`，那它就只拿得 `raw`；漏了别名 ⇒ 拿不到旧值 ⇒ 用例会红，不是被兼平成假绿。
    if (/FROM upload_settings/.test(sql) && /\bFOR UPDATE\b/.test(sql)) {
      const alias = /\bAS\s+(\w+)\s+FROM/i.exec(sql)?.[1] ?? 'max_file_bytes';
      // bigint → 字符串（与下面 `FROM upload_settings` 分支同一理由：不拿驱动默认行为当语义）。
      const raw = this.uploadSettings === null ? null : String(this.uploadSettings.max_file_bytes);
      return { rows: raw === null ? [] : [{ [alias]: raw }], rowCount: raw === null ? 0 : 1 };
    }

    if (sql.includes('FROM upload_settings')) {
      // ⚠ **`max_file_bytes` 回字符串**，这不是手误：它是 `bigint`（int8），node-pg 对 int8 **默认就回
      // 字符串**（不自动转 number，怕超 2^53 丢精度）。fake 必须复制这个形状，否则产品侧一个
      // `Number(row.max_file_bytes)` / `parseInt(row.max_file_bytes)` 的错误在单测里是绿的，到真库上才锈
      // （`parseInt('1e4') === 1` 那族）。
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
      // #737：`adoptEmailCode` 的 INSERT 比 `createEmailCode` 多一列 `attempts`（预算随码走）；
      // 按 SQL 文本判列形（同族纪律：产品改列形 fake 必须跟着变）。
      const withAttempts = /expires_at,\s*attempts,/.test(sql);
      const [pendingTokenHash, codeHash, createdAt, expiresAt, a, b, c, d, e] = params;
      const attempts = withAttempts ? Number(a ?? 0) : 0;
      const maxAttempts = withAttempts ? b : a;
      const resendCount = withAttempts ? c : b;
      const ip = withAttempts ? d : c;
      const ua = withAttempts ? e : d;
      if (!/^[0-9a-f]{64}$/.test(String(pendingTokenHash))) throw new Error('fake: pending_token_hash 必须是 sha256 hex');
      if (!/^[0-9a-f]{64}$/.test(String(codeHash))) throw new Error('fake: code_hash 必须是 sha256 hex（绝不存明文码）');
      if (!Number.isInteger(Number(maxAttempts))) throw new Error('fake: max_attempts NOT NULL');
      const row = {
        id: `ec${this.emailCodes.length + 1}`,
        pending_token_hash: pendingTokenHash,
        code_hash: codeHash,
        created_at: createdAt,
        expires_at: expiresAt,
        attempts,
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

    // #737 复用读：同一账号窗口内「未消费且未过期」的最新一枚码（JOIN login_pending 按账号筛）。
    // 谓词**按 SQL 文本真解析**（同 453 行上方纪律）：产品侧漏写 `consumed_at IS NULL` / 漏过期谓词 /
    // 漏窗口谓词时，fake 跟着放宽 ⇒ 漏条件会被用例打红。窗口判定按传入参数算（$2=now、$3=windowSeconds），
    // 产品侧 `now` 是 `new Date()` 不好注入 ⇒ 用例靠推早旧行的 created_at 来造「窗口外」。
    if (sql.includes('FROM login_email_codes') && sql.includes('JOIN login_pending')) {
      const [userId, now, windowSeconds] = params;
      const requireUnconsumed = /c\.consumed_at\s+IS NULL/.test(sql);
      const requireUnexpired = /c\.expires_at\s*>\s*\$2/.test(sql);
      const requireWindow = /\$2\s*-\s*make_interval/.test(sql);
      const windowStartMs = new Date(now).getTime() - Number(windowSeconds ?? 0) * 1000;
      const rows = this.emailCodes
        .filter((x) => {
          const p = this.pending.find((pp) => pp.token_hash === x.pending_token_hash && pp.user_id === userId);
          if (!p) return false;
          if (requireUnconsumed && x.consumed_at !== null) return false;
          if (requireUnexpired && !(new Date(x.expires_at) > new Date(now))) return false;
          if (requireWindow && !(new Date(x.created_at) > new Date(windowStartMs))) return false;
          return true;
        })
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at) || String(b.id).localeCompare(String(a.id)));
      const row = rows[0];
      return {
        rows: row
          ? [{
            id: row.id, code_hash: row.code_hash, created_at: row.created_at,
            expires_at: row.expires_at, attempts: row.attempts, max_attempts: row.max_attempts,
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

    // 成功消费：单条原子 UPDATE。谓词**按 SQL 文本真解析**：产品侧少写
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
      // 严格 fake：没认出来的 SQL 直接炸，不静默返回空行。
      throw new Error(`fake: 未识别的 login_email_codes SQL：${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

    // ---- #456：证书台账（tls_certificates） ----
    // 写侧：按 SQL 文本真模拟，并把迁移 0027 的约束当 DB 事实执行——
    //   ① `fingerprint_sha256` 必须是**冒号分隔大写**（与 Node fingerprint256 同形，verify 端点直接逐字符比）；
    //   ② `kind` 只有 upload/rollback（CHECK）；
    //   ③ `sans` 是 `text[]` ⇒ 必须传数组。
    // 产品侧把指纹小写化、或把 PEM 当指纹写进去，这里会炸（而不是静默绿）。
    // 项目内部 id（仅供需要合法 uuid 形状的分支用）：`decodeAdminUserUuid` 要过 UUID_RE。
    // #736：api_tokens 的 id 在真库里是 uuid；假库给一个合法形状的固定号即可。
    // ---- #736：API 令牌（api_tokens）----
    // 假库不校 SQL 列名（列名写错只有真库会报），所以这里**按 SQL 说的做**；列面/类型对账在
    // M2 真库事务里跑一次（见工单）。分支顺序：INSERT / 按 hash 联查 / touch / revoke / 存在探测 / 列表。
    if (sql.includes('INSERT INTO api_tokens')) {
      const [userId, name, tokenHash] = params;
      // 库事实：`token_hash` 只存 sha256 hex —— 产品侧把明文写进来这里就该炸（明文只出一次）。
      if (!/^[0-9a-f]{64}$/.test(String(tokenHash))) {
        throw new Error('fake: api_tokens.token_hash 必须是 sha256 hex（明文不得落库）');
      }
      // UNIQUE (user_id, name)：同账号重名（含已吊销，因吊销不删行）⇒ ON CONFLICT DO NOTHING ⇒ 空 rows。
      if (this.apiTokens.some((t) => t.user_id === userId && t.name === name)) {
        return { rows: [], rowCount: 0 };
      }
      if (this.apiTokens.some((t) => t.token_hash === tokenHash)) {
        return { rows: [], rowCount: 0 }; // token_hash UNIQUE（极小概率撞 hash）
      }
      this._apiTokenSeq = (this._apiTokenSeq || 0) + 1;
      const hex = this._apiTokenSeq.toString(16).padStart(12, '0');
      const row = {
        id: `00000000-0000-4000-8000-${hex}`,
        user_id: userId,
        name,
        token_hash: tokenHash,
        scopes: [],
        created_at: new Date(),
        last_used_at: null,
        revoked_at: null,
      };
      this.apiTokens.push(row);
      return {
        rows: [{ id: row.id, name: row.name, scopes: row.scopes, created_at: row.created_at }],
        rowCount: 1,
      };
    }

    // findActiveByToken：按 token_hash 取「未吊销令牌 + 活跃用户」（JOIN users）。
    if (sql.includes('FROM api_tokens t') && sql.includes('JOIN users')) {
      const [tokenHash] = params;
      const t = this.apiTokens.find((x) => x.token_hash === tokenHash && x.revoked_at === null);
      if (!t) return { rows: [] };
      const u = this.users.find((x) => x.id === t.user_id && x.status === 'active');
      if (!u) return { rows: [] };
      return {
        rows: [{
          token_id: t.id,
          name: t.name,
          scopes: t.scopes,
          created_at: t.created_at,
          last_used_at: t.last_used_at,
          id: u.id,
          login: u.login,
          display_name: u.display_name,
          role: u.role,
          fde_name: u.fde_name,
          auth_source: u.auth_source,
          status: u.status,
          must_change_password: sql.includes('must_change_password')
            ? u.must_change_password === true : undefined,
          ...this.projectFileUpload(sql, u),
          // #828 P1：同口径（`findActiveByToken` 的 SELECT 写了 `u.locale`）——SELECT 点了名才回，不兼平。
          ...this.projectLocale(sql, u),
        }],
      };
    }

    // touchToken：条件 UPDATE last_used_at（从未用过或距上次超 5 分钟才写）。
    if (sql.includes('UPDATE api_tokens SET last_used_at')) {
      const [tokenId] = params;
      const t = this.apiTokens.find((x) => x.id === tokenId);
      if (!t) return { rows: [], rowCount: 0 };
      const cutoff = Date.now() - 5 * 60 * 1000;
      if (t.last_used_at === null || new Date(t.last_used_at).getTime() < cutoff) {
        t.last_used_at = new Date();
        return { rows: [{ id: tokenId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // revokeToken step1：置 revoked_at（仅未吊销、按 user_id 维度）。
    if (sql.includes('UPDATE api_tokens SET revoked_at')) {
      const [userId, tokenId] = params;
      const t = this.apiTokens.find(
        (x) => x.user_id === userId && x.id === tokenId && x.revoked_at === null,
      );
      if (!t) return { rows: [], rowCount: 0 };
      t.revoked_at = new Date();
      // 产品 SQL 是 `RETURNING id, name`（name 供审计 details）⇒ fake 照形状回。
      return { rows: [{ id: tokenId, name: t.name }], rowCount: 1 };
    }

    // revokeToken step2：存在探测（已吊销但仍在本账号下 ⇒ 幂等 200）。
    if (sql.includes('SELECT 1 FROM api_tokens')) {
      const [userId, tokenId] = params;
      const found = this.apiTokens.some((x) => x.user_id === userId && x.id === tokenId);
      return { rows: found ? [{ '?column?': 1 }] : [], rowCount: found ? 1 : 0 };
    }

    // listTokens：某用户全部令牌（含已吊销），按 created_at 升序。
    if (sql.includes('FROM api_tokens') && sql.includes('ORDER BY created_at')) {
      const [userId] = params;
      const rows = this.apiTokens
        .filter((x) => x.user_id === userId)
        .slice()
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map((x) => ({
          id: x.id,
          name: x.name,
          scopes: x.scopes,
          created_at: x.created_at,
          last_used_at: x.last_used_at,
          revoked_at: x.revoked_at,
        }));
      return { rows, rowCount: rows.length };
    }

    // 既有产品行为（admin.js，早于 #736）：重建/重绑账号时整账号清令牌。
    if (sql.includes('DELETE FROM api_tokens')) {
      const [userId] = params;
      const before = this.apiTokens.length;
      this.apiTokens = this.apiTokens.filter((t) => t.user_id !== userId);
      return { rows: [], rowCount: before - this.apiTokens.length };
    }

    if (sql.includes('api_tokens')) {
      // 其余 api_tokens SQL（新读法/新谓词）一律报错，**不许静默空集**（同 login_email_codes 口径）。
      throw new Error(`fake: 未识别的 api_tokens SQL：${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
    }

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

  /**
   * 事务入口。两类使用者：
   *   * #183（git-credential）等：拿它当一个能跑 `BEGIN`/`COMMIT` 的普通句柄（行为不变）；
   *   * #698b（保存上传上限）：需要 fake **真的能回滚** —— 否则「审计写不进去 ⇒ 设置也没改」
   *     这条硬口径（US-21）在 fake 里不可表示（旧版它是靠“一条语句要么全做要么全不做”兼平的，
   *     产品改成事务后那个兼平就没了 ⇒ 必须补事务形状本身）。
   *
   * 只补三件事：`BEGIN` 开一份撤销账、`COMMIT` 丢账、`ROLLBACK` 逐条撤销。
   * ⚠ **刻意不模拟 MVCC / 行锁**（不去做“事务间互相看不见未提交写”）：做了就是拿 fake 的调度
   *   当 PG 的语义，而 #698 的 MED 正是这么漏过去的——并发审计链的判据在真库文件里。`BEGIN` 重复
   *   与无事务时的 `COMMIT`/`ROLLBACK` 都**不报错**（PG 只给 warning）：不要比真库更严。
   */
  async connect() {
    const pool = this;
    const client = {
      /** 本连接当前事务的撤销账；null = 不在事务里。 */
      _undo: null,
      async query(sql, params) {
        const head = String(sql).trim().split(/\s+/)[0].toUpperCase();
        if (head === 'BEGIN') client._undo = client._undo ?? [];
        // 只把记账窗口开在**同步分发那一段**（基类 `query` 的分支全是同步的）：窗口再宽就会把
        // 同期另一条路径（`auth.audit` 走 `pool.query`）的写也记到本事务账上，`ROLLBACK` 就会误伤。
        const outer = pool._txUndo;
        pool._txUndo = client._undo;
        let pending;
        try {
          pending = pool.query(sql, params);
        } finally {
          pool._txUndo = outer;
        }
        const out = await pending;
        if (head === 'COMMIT') client._undo = null;
        if (head === 'ROLLBACK') {
          const undo = client._undo ?? [];
          client._undo = null;
          for (const fn of undo.reverse()) fn();
        }
        return out;
      },
      release() {},
    };
    return client;
  }
}
