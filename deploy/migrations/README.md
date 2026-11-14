# deploy/migrations/ — 增量 DB 迁移目录

> 依据：`docs/design/deploy-contract.md` §3。本目录自 **0001** 起已有实际增量迁移
> （`0001-idempotency-keys.sql`，portal.md §1.4 幂等台账）；命名/顺序/幂等规则供迁移 runner
> （`portal/src/migrate.js` 读取）与后续轮次使用。
>
> **baseline 已冻结**：`docs/data/schema.sql`（`version='0000_baseline'`）自 P1 起不可再改——
> 改它会让 `00-init.sh`/runner 记录的真实 `sha256` 失配，runner 直接拒绝启动（§3.2 防改历史）。
> 新增 DDL 一律写成新编号迁移文件（本目录），**不**回写 baseline。
>
> **已应用的迁移文件同样不可再改（2026-10-08 实测确认）**：runner 对**每个**已应用迁移记录 `sha256`
> （`schema_migrations.checksum`），失配即拒绝启动——**连注释都不能改**。因此「补一句说明/修一个 typo」
> 的正确做法是写进本文档或新迁移，**绝不回改历史迁移文件**；排查线索也写在这里（见文末「排障」）。

## 目录职责

- 本目录存放**增量 DDL 迁移**（`baseline = docs/data/schema.sql` 之后的 schema 演进）。
- baseline（`schema.sql`）与 `bootstrap.sql` **不放在这里**：前者是自包含 baseline，后者是
  超级用户附加初始化（角色属性/授权/ownership 归正），均由部署侧 superuser bootstrap 处理。
- 迁移 runner 按文件名升序应用本目录下所有 `*.sql`，并以 `version = 文件名去 .sql` 落
  `schema_migrations` 台账。

## 命名与顺序

- 文件名：`NNNN-<slug>.sql`，`NNNN` 为四位递增序号（`0001`、`0002`、…），`<slug>` 为
  小写 kebab-case 简短描述。
- 顺序 = 文件名升序（`sort`）。**已应用的迁移文件不得再修改**（见下「单文件约定」）。

## 单文件约定

- 每个迁移文件在 **Postgres 单事务内**执行（runner 会 `BEGIN` → 执行 → `INSERT INTO
  schema_migrations` → `COMMIT`），失败整体回滚、不写台账行。
- 数据迁移（有损 / 大表 rewrite）必须显式 `SET lock_timeout` / `SET statement_timeout`
  并保持幂等（`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 等），见 deploy-contract §3.2。
- **已应用的迁移不得再修改**：runner 记录每个迁移文件的 `sha256`，改动即失配、拒绝启动。
  未发布（未进入任何已部署库）的迁移可以在同一个 PR 内迭代，但发布后只能追加新编号。
- 迁移内新建的表/序列自动获得 `station_portal` 的最小 DML 授权——baseline 已设
  `ALTER DEFAULT PRIVILEGES FOR ROLE station_platform`（schema.sql §10），无需在迁移里重复 `GRANT`。

## 镜像与执行

- portal 镜像（`portal/Dockerfile`）`COPY deploy/migrations/`，容器内路径 `/app/deploy/migrations`
  （= `migrate.js` 的 `defaultMigrationsDir()`）。
- 执行方：`node portal/src/cli.js migrate`（或 `MIGRATE_ON_START=1`，portal 在**监听端口前**应用），
  身份 `station_platform`（`MIGRATE_DATABASE_URL`，DDL），见 deploy-contract §3.1。
- 现状（**下面这段只写到 0026，是 2026-11-06 的读数**；0027–0034 见下面「增量迁移清单」一节）：增量迁移已包含
  `0001-idempotency-keys.sql`（写操作幂等台账）至
  `0026-login-email-codes.sql`（**#449 登录第二因素「邮箱验证码」**：`login_email_codes` 一行一枚码 +
  `mail_settings` 单行邮件通道配置——SMTP 参数存 DB、口令明文，与 `git_hosts.admin_key` 同口径；
  `docs/data/schema.sql` 冻结 baseline 一个字节未改，静态断言见 `portal/test/migrations.test.js`）至
  `0021-user-must-change-password.sql`（**#255 首登强制改密**：`users` 加
  **`must_change_password boolean NOT NULL DEFAULT false`** ——单条 `ADD COLUMN IF NOT EXISTS`（可整体重放，
  第二遍是零 DDL 空操作；PG 11+ 对常量 DEFAULT 不重写表），后置两个**纯读** DO 块：一个在「列缺失 / 不是
  NOT NULL / 默认值不是 false」时当场 `RAISE`（默认值是契约：`cli.js bootstrap-admin` 与存量行都靠它保持
  `false`，漂了就把 dev/CI 的 bootstrap 账号锁进改密屏），一个打印「共 N 行 / 其中 true M 行」作重放证据。
  **存量行不回填**（`DEFAULT false`）：本单只治「从现在起被代设口令的人」，一次性置 true 会让每个已部署环境
  一升级就全员被锁（前端界面不在本单，锁了没出口）。静态断言见 `portal/test/migrations.test.js`。
  前一道 `0020-preview-grant-revoke-repair.sql`（**#252：清「已释放 allocation 上仍 `active`」的预览凭证残渣**——
  纯数据修复、**零 DDL**（baseline 冻结件一字节不动）；谓词与代码同源，**只撤 `state='active'`**，
  `used` 行按 #252 口径**保留原状**（把 used 塞进 `revoked` 会撞双向 CHECK `(state='used') = (used_at IS NOT NULL)`
  即真机的 `preview_grants_check3`；顺手清 `used_at` 则篡改历史）；可整体重放（前置 NOTICE 打印待修条数，
  第二遍必为 0，后置 DO 守卫兜住「谓词被改窄」），真库重放证据见 `DELIVERY.md`）。
  前一道 `0019-preview-port-pool.sql`（**#246 交付①：预览端口全局号池 `22000–29999` 与块分配**——四条语句的
  **顺序不可换**：⓪ 按名 `DROP CONSTRAINT IF EXISTS port_allocations_port_check` → ① 重排存量**活行**
  进号池（按 `fde_name` 定序，一人一个 10 个的对齐块；`hostname`/`url` 的端口段**同事务**重写，base 域从旧
  hostname 反推、**不硬编码伞域**；装不下的溢出活行置 `released`；`released` 行一律不动⇒ 历史号码保留）
  → ①′ 守卫 DO 块（池外活行 / hostname 与端口不同步 ⇒ 带表名与例外的 RAISE，换掉裸 23514）
  → ② `port` CHECK 换为**按状态分支**（活行 `BETWEEN 22000 AND 29999`；`released` 行 `BETWEEN 4000 AND 29999`
  保留历史号码），建成 **VALID**（正解就是「活行全在池内」，要真校存量）→ ③ 新建全局部分唯一索引
  **`port_allocations_live_global_port_key UNIQUE (port) WHERE state <> 'released'`**（跨 FDE 不重叠由 DB
  保证；`released` 不占位 ⇒ 号码可复用；普通 `CREATE UNIQUE INDEX`，**`CONCURRENTLY` 在显式事务里不可用**）。
  旧 CHECK 的 4000–4999 与新池**不相交** ⇒ 不先摘它，① 自己的 UPDATE 就当场 23514（这就是必须多一步 ⓪ 的原因）。
  ⚠ PG 的 `lpad(text,n)` 会**截断**超过 n 的串（实测 `lpad('22010',4,'0')='2201'`）⇒ 重写端口段不得用 lpad。
  `docs/data/schema.sql` 冻结 baseline **一个字节未改**（§8.7/§8.8）；静态断言见 `portal/test/migrations.test.js`。
  前一道 `0018-port-allocations-scope-fde.sql`（#240 开户预分配 10 条 FDE 级预览域名：`port_allocations.scope`
  的 CHECK 由 `('project','run')` 放开为 `('project','run','fde')`，按名 DROP→ADD 可重放；**只改这一条
  CHECK**——`CHECK ((scope='run') = (run_id IS NOT NULL))` 原样保留（`scope='fde'` 的行 `run_id` 恒 NULL），
  且**不新建索引**（幂等靠 baseline 既有的部分唯一索引 `port_allocations_live_port_key (fde_id, port)
  WHERE state <> 'released'`，写侧 `ON CONFLICT` 必须带上该谓词才能推断冲突目标；#246 后它与新的全局索引**并存**）；前一道
  `0017-port-allocations-hostname-check.sql` 为 #202 预览域名 hostname 的 DB 兜底 CHECK（整域名正则
  逐标签 ≤63 + 总长 ≤253，NOT VALID，存量收敛动作见迁移头注释）；再前一道 `0016-transcript-append-seq.sql`
  为 transcript 同 round 保序：新增 `append_seq` + 存量按 `created_at, id` 确定性回填 + 部分索引）。
  **P1 compose 显式设
  `MIGRATE_ON_START: "1"`**——单实例平台起栈即自动补增量，不再需要人工补跑（deploy-contract §3.1）；
  多实例部署必须置 `0` 并外部跑迁移。

> 迁移身份 = `station_platform`（DDL，表 owner）；运行时身份 = `station_portal`（最小 DML）。
> 见 `docs/design/deploy-contract.md` §2.4/§3 与 `docs/env.md` §10。**为什么这是硬约束而不是建议，见下节。**

## 增量迁移清单（0027–0034）

> 上面「现状」段那句「已包含 `0001` 至 `0026`」停在 2026-11-06，**清单以本节为准**（`ls deploy/migrations/*.sql` 现查可复核）。
> 一句话用途 + 关联 issue；细节在各自文件头注释里（那里才是取证的地方），旧条目（0001–0026）的来历见「镜像与执行」段。

| 文件 | 一句话用途 | 关联 issue |
|---|---|---|
| `0027-tls-certificates.sql` | 管理台证书生命周期的**审计/历史**表 `tls_certificates`（一行一次装证/回滚；**盘上文件才是真相源**，本表只答「谁在什么时候装了什么」） | #456 |
| `0028-user-mail-otp.sql` | `users.mail_otp_enabled`：per-user「邮件验证码」开关（默认 `false` ⇒ 开了全局邮件通道不再自动要求所有人） | #449 |
| `0029-user-file-upload.sql` | `users.file_upload_enabled`：per-user「文件上传」开关（默认 `false`，管理员显式打开） | #472 |
| `0030-user-totp-login-enabled.sql` | `users.totp_login_enabled`：把「绑过 TOTP」与「登录允许用 TOTP」拆成两位（默认 `true` ⇒ 存量行为零变化） | 工单 feat-261110-02（台账 §8.112） |
| `0031-user-last-activity-at.sql` | `users.last_activity_at`：该用户最近一次**亲口说话**（按下发送）的时刻，可空、无默认、不建索引 | #497 |
| `0032-drop-retired-tables.sql` | 撤三张退役/备份表（`llm_models_retired`、`llm_providers_retired`、`transcript_rounds_shape4_bak_20261027`）；**撤前每个部署自己跑一遍访问账判据** | #503 |
| `0033-delta-events-not-persisted.sql` | 清 `assistant_delta` / `reasoning_delta` / `tool_call_delta` 的历史存量（**形态 M：纯清理、零 DDL**，分批 `FOR UPDATE SKIP LOCKED`） | #502 |
| `0034-prune-stale-run-checkpoints.sql` | 清 `run_checkpoints` 里**永不再被读**的两类快照（(a) run 作用域且那个 run 已终态、(b) session 作用域且会话已归档或 14 天没动；**纯清理、零 DDL**，分批 `ctid` + `FOR UPDATE SKIP LOCKED`，只留活跃会话每 key 一行） | #502 的遗留账（工单 261114-03，PR #509） |

⚠ `0033` 有**部署顺序**要求，见下一节——它不是「又是一条 DELETE」那么轻。
⚠ `0034` 同病：**迁移清完磁盘也不会自己缩**——它只清行（dev 实测清掉 70/87 行后
`pg_total_relation_size` 从 4,644,864 B 只动到 4,628,480 B，−0.35%），要回收磁盘必须在部署后手工跑
**`VACUUM (FULL, ANALYZE) run_checkpoints;`**（不能写进迁移文件：`VACUUM` 不在事务块里跑，同下面 `0033` 那条），
实测 **4.64 MB → 565 KB**（565,248 B，−87.8%，`VACUUM FULL` 耗时 0.179 s）；出处
`docs/maintenance/task-ledger.md` §8.126.2（那里还有「删行≠还磁盘」的逐时点读数表）。

## 部署顺序：`0033` 必须**先部署新代码、再跑迁移**（issue #502）

- **`0033` 是纯清理迁移**（语句区只有 `DELETE` 与观测，零 `CREATE/DROP/ALTER`），但它清完之后会**量一遍残留**：
  仍有 stream 档碎片 ⇒ **`RAISE EXCEPTION`**（不是 `WARNING`）。带残留记成功 = `schema_migrations` 落下
  「已清完」这一行、表里却还躺着几十万行碎片，而迁移的可观测面只有 rc 与 NOTICE，`WARNING` 挡不住 COMMIT。
- **量到残留的真实原因只有一个：部署顺序倒了。**拦住碎片写入的代码（`portal/src/internal.js` 的 U3 写循环问
  引擎 `eventTierOf`）与这支迁移在**同一个 commit**里 ⇒ 旧版 portal 还在上报碎片时跑迁移，必然一边清一边写。
  所以：**先把新 portal 镜像部署起来，再让迁移跑**（compose 路径 `MIGRATE_ON_START: "1"` 下，起新镜像本身就是
  在跑新迁移，顺序天然成立；手工/救灾路径分开跑这两步时才需要记住它）。
- **失败可重放，不是死局**：新代码上线后重跑 `0033` 即可（第二遍清 0 行、rc=0）。
- **磁盘回收不在迁移里，要手工跑**：`VACUUM` 不能跑在事务块里（25001），而迁移 runner 是单事务 ⇒ 写进迁移文件
  就是整个迁移失败、portal 拒启。`DELETE` 跑完体积**一个字节都不动**（实测：877,155 行删完仍是
  494,960,640 B），只有 `VACUUM (FULL, ANALYZE) run_events` 才回收（实测降到 5,578,752 B）。它拿
  `ACCESS EXCLUSIVE` ⇒ **在迁移事务之外、低峰期手工跑**，读数与耗时见 `docs/maintenance/task-ledger.md` §8.126.1。

## 迁移身份：增量迁移**必须**由平台库角色执行（issue #280）

**口径**：跑 `deploy/migrations/*` 的连接必须是**平台库角色**（`deploy/.env` 的 `PLATFORM_DB_USER`，
缺省 `station_platform`）——即 `MIGRATE_DATABASE_URL` 的用户。只设 `DATABASE_URL` 的走法见下文。

**为什么**（不是洁癖，是 PG 的硬约束）：
- `docs/data/bootstrap.sql:50-62` 那个 DO 块把 `public` 下表与序列的属主**归正给平台库角色**
  （`ALTER TABLE … OWNER TO station_platform` 在 `:57`、`ALTER SEQUENCE … OWNER TO` 在 `:60`），并在 `:51`
  声明前提「后续 `deploy/migrations/*` 由其执行」。
- PG 的 `ALTER SEQUENCE … OWNED BY <table>.<col>` 要求**序列与表同属主**（`routine=process_owned_by`，
  SQLSTATE 55000）；`CREATE SEQUENCE` 把新序列给**当前连接角色**。两者一撞：迁移角色 ≠ 表属主 ⇒
  **整个迁移在 `0016-transcript-append-seq.sql` 失败**（报 `sequence must have same owner as table it is linked to`）。
  同理适用于任何 `… OWNED BY` / 依赖属主的 DDL，不是 0016 独有。

**只设 `DATABASE_URL` 会怎样**：`portal/src/config.js` 的 `migrateDatabaseUrl` **缺省回退 `DATABASE_URL`**
（通常是 bootstrap 超级用户），于是迁移以超级用户新建序列、表却归平台角色 ⇒ 手工/救灾路径**必炸**；
compose 路径显式设 `MIGRATE_DATABASE_URL=station_platform`（`deploy/docker-compose.yml:149`）所以不触发。

**runner 的处置（issue #280 起，`portal/src/migrate.js`）**：
- 落点：`applyBootstrap` **之后**、增量迁移循环**之前**发 `SET ROLE`。必须在 bootstrap 之后——
  `bootstrap.sql` 要 `CREATE ROLE`/`ALTER ROLE`/`GRANT`（非超级用户跑不动，实测 42501），且「谁是属主」本身是它决定的。
- 目标角色**不写死**，解析顺序：显式 `opts.platformRole` / `PLATFORM_DB_USER`（配置点名）
  > `MIGRATE_DATABASE_URL`（回退 `DATABASE_URL`）的用户 > **库内实测表属主**（`schema_migrations` 的
  `tableowner`，量不到则取 `public` 下最多的那个）。第三档是救灾路径的关键：只设 `DATABASE_URL` 时
  连接串用户就是超级用户（= 当前角色，等于没点名），而 PG 的约束字面上就是「与表同属主」。
- **当前角色已是目标角色 ⇒ 无副作用 no-op**（一条 `SET ROLE` 都不发）——compose 路径就长这样，不回退它。
- **`SET ROLE` 被拒 ⇒ fail fast**，报可操作错误（点名 `MIGRATE_DATABASE_URL` 与两个角色），
  **不静默跳过**（静默 = 陷阱还在），也不让人到 0016 里去读 PG 内部报错。
- 循环**结束与异常两条路径**都 `RESET ROLE`：pg 会复用连接，残留的 `SET ROLE` 会把后续同一条连接上
  查询的属主语义一起改掉（钉桩见 `portal/test/migrate-role.test.js`、`portal/test/migrate-fresh-db.test.js`）。
- 切角色之后，循环里的 DDL **与 `schema_migrations` 的写入**都以平台角色执行 ⇒ 它必须对该表有
  INSERT/UPDATE（bootstrap 归正属主后即成立；真库断言见 `migrate-fresh-db.test.js`）。

**为什么没有更早就修好**：把属主同步挪到迁移**前**或迁移**后**都救不了（0016 在循环内部就炸，同步跑不到，
已实测否决）。也**不能改 `0016-*.sql` 的文件内容**——runner 按 sha256 比对 checksum，改字节 = 现存库全部拒启。
需要补授权就**新增**编号迁移（并同步 `portal/test/migrations.test.js` 的编号断言），baseline `schema.sql` 不动。

**测试口径**：这条真实顺序（空库 → baseline → bootstrap → 全部增量，且故意以非属主角色跑）的唯一
真库覆盖是 `portal/test/migrate-fresh-db.test.js`；`TEST_DATABASE_URL` 未设置时整体 skip（无 PG 不假通过）。

## 排障

- **`sequence must have same owner as table it is linked to`（`routine=process_owned_by`，典型在 0016）**：
  迁移身份不对——连接角色不是表属主（见上节「迁移身份」）。先看日志有没有
  `[migrate] SET ROLE <平台角色>`：没有 ⇒ 目标角色解析成了当前角色（库里量到的属主就是它）；
  有 `[migrate] 迁移身份切换失败` ⇒ 按该消息把 `MIGRATE_DATABASE_URL` 指向平台库角色。
  **不要**去改 `0016-*.sql` 的内容（checksum 冻结，现存库会全部拒启）。
- **`[migrate] 迁移身份切换失败：当前连接角色 X 无法 SET ROLE 到平台库角色 Y`**：把 `MIGRATE_DATABASE_URL`
  改成指向 Y（`deploy/.env` 的 `PLATFORM_DB_USER`），或让 X 成为 Y 的成员。**不要**把它解读成数据问题。
- **`column "claim_token" does not exist`（或其他基线列缺失）**：说明目标库**不是由 0001 建的表**
  （典型：手工建库 / 导入了不匹配的 dump）。runner 不会自愈——请**重建库**后重跑迁移，不要靠改迁移文件绕过。
- **`checksum mismatch` / runner 拒启**：有人改过已应用迁移或 baseline。从 `git log` 取回原文件内容即可，
  **不要**删 `schema_migrations` 行去「重放」（那会跳过 DDL，留下半成品 schema）。
