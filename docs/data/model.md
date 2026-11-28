# 数据模型说明（model.md）

> 状态：**契约基线（阻塞 P1）**
> 依据：[`../design/fde-platform.md`](../design/fde-platform.md) §8/§9/§10（规格，下称「规格 §x」）、[`../design/principles.md`](../design/principles.md)（原理）、[`../design/runner-integration.md`](../design/runner-integration.md)（runner 集成设计：internal 端点 / 租约 / 幂等键，下称「runner-integration §x」）、[`../env.md`](../env.md)（环境事实，下称「env §x」）。
>
> **写入方总原则（决策者 2026-09，issue #3 评论，D1'/D2'）**：**Postgres 的业务写方只有 portal**；容器（agentd/worker）不持有 DB 凭据、不直连 DB，一切 run 侧写入经 portal internal API（portal.md §9）落库。下文各表「谁写」均按此口径。
> 配套：可执行 DDL 在 [`schema.sql`](schema.sql)（`psql -f` 空库可执行，已实测）；API 层字段口径与 [`../api/portal.md`](../api/portal.md) 对齐（下称「portal.md §x」）。
>
> **本文只补契约细节，不重新设计**：规格 §9.1 是表名 + 字段草图，本文与 schema.sql 把它落成可执行模型。与规格冲突时以规格为准并提 issue。

---

## 0. 总览

环境事实（env.md）：DB 为独立 `station-db` 容器，**postgres:16**（env §10），仅 `backend` 网络内可达（H-B：`control` 已取消）、不 publish 宿主机（env §5），数据目录 `/docker/station-db/`（env §6）。

DDL 全局约定（schema.sql 头部亦有注）：

| 约定 | 取值 | 理由 |
|---|---|---|
| 枚举 | `text` + `CHECK`（不用 ENUM 类型） | additive 演进不需 `ALTER TYPE`；规格 §13.2-3 的上游 additive 原则同构 |
| 时间 | 一律 `timestamptz` | 多端/跨时区；规格 §14 看板聚合依赖 |
| 主键 | `uuid` + `gen_random_uuid()`（PG13+ 内建） | 多节点/离线生成无协调；**例外：`runs.id` 无默认值，必须由 portal 显式生成 UUID 并下发容器**（规格 §9.3-3：runId 用 UUID，禁止 cwd 派生） |
| 可回收唯一性 | 部分唯一索引（`WHERE state <> 'released'` 等） | 历史记录不挡复用，活跃记录保持唯一（端口复用、项目重建） |

表分组一览（写入方 / 读取方见各表条目；「不混」边界见 §3）：

| 组 | 表 | 来源 |
|---|---|---|
| 账号与认证 | `users` / `login_sessions` / `login_pending` / `login_email_codes`（migration 0026，邮箱验证码）/ `api_tokens` / `preview_grants`（预览凭证） | 规格 §7 / portal.md §2.2/§2.3a/§2.7 / issue #449 |
| 邮件通道配置 | `mail_settings`（migration 0026，单行） | issue #449（SMTP 参数存 DB，管理台维护） |
| 容器与项目 | `containers` / `projects` | 规格 §4 / §7.2 |
| 会话与对话 | `chat_sessions` / `runs` / `messages` / `queued_inputs`（migration 0024） | 规格 §9.1 / issue #370 |
| 写操作幂等 | `idempotency_keys` | portal.md §1.4（本轮实现；**仅**由增量迁移 0001 提供，baseline 不含本表） |
| 端口分配与路由 | `port_allocations` / `route_outbox` / `route_revisions` | 规格 §8 / topology.md §5/§8 |
| 引擎持久化 | `transcript_rounds` / `transcript_recovery_rows` / `run_events`（~~快照表~~ 已随 #640 由迁移 `0041` 撤） | 规格 §9.2/§9.3 |
| 工具与审批 | `tool_calls` / `tool_outputs` / `judge_decisions` / `approvals` / `artifacts` | 规格 §9.1 / topology.md §9 |
| 用量与审计 | `usage_ledger` / `audit_log` | 规格 §11.4 / §14 |
| 任务队列 | `run_queue`（含租约字段） | runner-integration §4.2/§6（拉模型，claim 长轮询） |
| 网络与 IPAM | `fde_networks` | topology.md §3（H-B D-10） |
| LLM 配置 | `fde_llm_bindings`（模型目录与上游凭据归 LiteLLM；旧 `llm_providers` / `llm_models` 于 migration 0010 改名为 `_retired`，**已由 migration 0032 撤除**——库里不再有这两张表，旧目录只能从 dump 恢复） | issue #117 phase 2 / #503 |
| Git host 配置 | `git_hosts` / `fde_git_accounts`（migration 0011） | issue #118（多 Git host、按 host 能力选择代铸或逐 FDE 凭据） |
| 用户下线 | `fde_offboarding`（migration 0013） | 规格 §7.3 / issue #110 |
| 用户空间物化 | `materialize_outbox` / `materialize_revisions` | user-space.md §7.1（A7 定稿） |
| 事件平台（宏） | `macro_templates` / `macro_assignments` / `macro_runs`（migration 0035） | issue #524（W1 数据层）/ 09-observability.md §7 / 07-surfaces-and-panel.md §2.3 |
| 迁移台账 | `schema_migrations` | deploy-contract.md §3（A6 定稿） |

---

## 1. 表说明

### 1.1 `users` — 用户（规格 §7.1 双通道的落点）

| 关键字段 | 语义 |
|---|---|
| `role` | `fde` / `admin`。OIDC 接入后来自 group claim，不在 UI 手点（规格 §7.1）；P1 本地账号在本地表维护（env §4 ⚠️） |
| `fde_name` | FDE 标识 = 容器名 `fde-<name>` 的 `<name>`、预览域名首段；未建容器时 `NULL`。全表唯一 |
| `auth_source` / `oidc_sub` | `local` / `oidc`；OIDC JIT 建档按 `email` + `oidc_sub`（规格 §7.1）。P1 恒为 `local`（portal.md §2.1） |
| `password_hash` / `totp_secret` | 本地账号：argon2id 哈希 + **强制 TOTP**（规格 §7.1）；TOTP 种子只经 bootstrap 下发，不走公开 API（portal.md §2.1） |
| `last_totp_step` | TOTP 单码防重放（portal.md §2.9.4）：最近成功校验的时间步长（`bigint`，`floor(unix_seconds/30)`）；同时间窗内同码（步长 ≤ 已记录值）拒绝，成功校验原子推进 |
| `status` / `disabled_at` | `active` / `disabled` / `awaiting_credential`。per-FDE PAT host 开户后暂为 `awaiting_credential`；对应 Git 凭据成功写入后恢复 `active`；offboarding 停用（规格 §7.3） |
| `mail_otp_enabled` | per-user「邮箱验证码」开关（迁移 `0028`，`NOT NULL DEFAULT false`）。**默认 false**：全局邮件通道开启不再自动要求所有人走邮箱码，需管理员逐个打开（portal.md §2.2）。只有 `PATCH /api/admin/users/:id` 能改（§12） |
| `file_upload_enabled` | per-user「文件上传」开关（迁移 `0029`，`NOT NULL DEFAULT false`，issue #472）。**默认 false** 且**零回填**：上传是写用户磁盘的能力，与 TOTP / 邮件验证码同一口径，由管理员在管理台 Edit → Security 显式打开。谁能改：只有 `PATCH /api/admin/users/:id`（`createUser` 不接受该入参，开户一律 false）；**重新开户（同名 disabled 行再激活）会显式清零** ⇒ 不继承上一个任期的权限。消费方：上传端点的 403 闸（片 B）与 user DTO 下发（portal.md §2.6）；界面隐藏不是闸，服务端才是 |
| `last_activity_at` | 该用户**最近一次亲口说话**的时刻 = 按下发送那一刻（迁移 `0031`，`timestamptz`，issue #497 方案 A3）。**可空且无默认值**：新开户与从未说过话的账号就是 `NULL`（不能拿 `now()` 充当活动）。**写入点只有两处**（不新增第三处）：`sessions.js#postMessage`（本站唯一发送路，直发与队列投递都走它）与 `queued-inputs.js#enqueueQueuedInput`（运行中按回车那一刻就是活动）。**不算**活动：agent 跑动（run 生命周期与终态）、页面刷新/重开、会话改名与归档、预览访问、程序化 token（`api_tokens`）、以及**登录本身** ⇒ 它**允许比 `last_login_at` 旧**（登录了但一句话没说）：两条独立时间线，**不得**在登录路径顺手补写。一次性回填只动 `last_activity_at IS NULL` 的行（取 `messages` 里 `role='user' AND synthetic=false` 的 `MAX(created_at)`，join `chat_sessions` 拿 `user_id`）；回填后仍无用户消息的账号保持 `NULL`，不拿 `last_login_at`/`created_at` 冒充。**不建索引**（只作返回列，不参与过滤/排序，口径同 `last_login_at`）。**重新开户（同名 `disabled` 行再激活）不清本列**——与上一行 `file_upload_enabled` 的显式清零**相反**：权限清零是因为权限不继承任期，而这一列是**事实**，事实不需要被抹掉（那段历史真的发生过）。消费方：管理台 user DTO（`admin.js#safeUser` / `listUsers`，portal.md §12；`GET /api/me` 与两个登录端点的 §2.6 DTO **不带**本列）与管理台用户列表第 8 格（主行=最后活动、副行小字=`登录于 …`，空值渲染成「从未活动」而不是「今天」） |
| `must_change_password` | boolean `NOT NULL DEFAULT false`（迁移 `0021`，issue #614）：true ⇒ 受限会话（`RESTRICTED_SESSION_ALLOWLIST`），只允许改密码等极少数路由；`POST /api/me/password` 改密成功后清回 false。**新建用户与管理员重置密码会置 true**，强制本人首次登录改密；`bootstrap-admin` 不置（吃默认 false） |
| `totp_login_enabled` | boolean `NOT NULL DEFAULT true`（迁移 `0030`，issue #500）：per-user 登录是否启用 TOTP 第二步。与 `totp_enabled`（=已绑密钥）**分开**——「已绑定」≠「登录要用」，关掉登录**不清 `totp_secret`**（重新开启即恢复） |
| `locale` | per-user 账号级语言偏好（迁移 `0048`，`VARCHAR(8)`，**可空**，issue #828 P1）。`NULL` = 「没设过」= **跟随浏览器**（不是第三个哨兵值；「显式选了中文」与「没设过」由此区分）；非空只收 `zh-CN` / `en` 两档。**值域不写 DB CHECK**（同 `0036`/`0046` 分层：写进 CHECK，「DB 值非法 ⇒ 回落浏览器」那条判据在真机上就进不去），归一化交写侧白名单 `db.js#normalizeUserLocale`（`en-US`/`en-GB`→`en`、`zh`/`zh-Hans`/`zh_CN`→`zh-CN`、空串/`null`→`null`）。优先级（前后端同序）：账号值 > cookie > localStorage > 浏览器语言 > `zh-CN`。谁能改：本人 `PATCH /api/me/locale` 或管理员 `PATCH /api/admin/users/:id`（`createUser` 不接受该入参，开户一律 `NULL`）。**服务端不查库定语言**（库是跨设备真相、cookie 是每请求载体，登录后由前端把前者灌进后者）。消费方：登录响应与 `GET /api/me` 的 user DTO 带 `locale`（可能 `null`，P2 前端据此落 cookie；portal.md §2.6） |

**状态机**：常规账号 `active → disabled`；Git 开户 `active → awaiting_credential → active`（必须写入指定 host 的 PAT）；offboarding 可从任一态转为 `disabled`。
产生方：onboarding workflow / Git credential 管理 / 对账任务；消费方：登录、forward-auth、容器调度（仅 `active` 可运行）。

### 1.2 `login_sessions` — 登录会话

cookie 令牌的**哈希**存储（`token_hash` 唯一），可单条吊销（`revoked_at`）——offboarding「失效登录会话」依赖此性质（规格 §7.3；portal.md §2.5）。7 天滚动续期：`expires_at` 每次活跃请求刷新。

### 1.3 `api_tokens` — 程序化访问令牌

非浏览器客户端用（脚本 / agent / 长期 runner；portal.md §2.13）。**现状（#736 落地后）**：库里只存 `sha256(明文)` 的 hex（与会话 `token_hash` 同口径，`portal/src/auth.js`），明文 = `st_` + base64url(32 字节随机)，**只在签发响应里出现一次**。认证缝是 `Authorization: Bearer <明文>`。`scopes` 是 `text[]` 但**本期恒为空**（签发只支持空数组，给了非空 ⇒ `400 scopes_unsupported`）；数组列是为将来预留，不是已实现的能力。**不设过期**：表里没有 `expires_at`（本期不加列），**靠吊销**（`revoked_at`）。**无 `created_by` 列**：「谁签的」只记在审计（`auth.token_created`）里。`UNIQUE(user_id, name)` 便于按名管理；**吊销不删行**，所以同名也不释放（再签同名 ⇒ `409 token_name_taken`）。`last_used_at` 只在「从未用过或距上次超 5 分钟」时用一条条件 UPDATE 节流写。⚠️ **`id` 是 `uuid`（默认 `gen_random_uuid()`）**，偏离全局 §3.4「主键一律字符串前缀」的口径——原因是 `api_tokens` 建表早于该约定（baseline `docs/data/schema.sql:128`），本单不动 PK。

### 1.4 `containers` — FDE 容器（每 FDE 一行）

| 关键字段 | 语义 |
|---|---|
| `fde_name` / `container_name` | 均唯一；`container_name = fde-<name>`（docker 容器名）。该容器名只在其自己的 `/29` 网络内按 docker DNS 解析（供其自有服务）；portal **不**按容器名/容器 IP 访问它——平台通道全出站经 Traefik（H-B，topology.md §2/§4；`control` 已取消） |
| `runner_token_hash` / `token_generation` / `revoked_at` / `rotated_at` | per-container token（规格 §10.3 / issue #12）：**仅存哈希**。建容器时生成原文、注入容器 env `ERIX_STATION_TOKEN`；**容器 → portal 单向出示原文**（internal API Bearer），portal 只校验哈希、不再向容器出示。`token_generation` 是代次（轮换/重建 +1），`revoked_at` / `rotated_at` 记录吊销/轮换时刻——旧代次哈希失配 → `401 token_revoked`（原子吊销，topology.md §6 第 9 条）。Offboarding 吊销时将 `runner_token_hash` 置 `NULL` 并增加代次（nullable 由 migration 0013 提供）。严禁明文入 DB/日志/镜像/仓库（原理 §5 清单）。**容器除此之外无任何平台凭据，尤其没有 DB 凭据**（D1'） |
| `status` | `creating / running / stopped / exited / removed`（状态机见 §2.4） |
| `agent_version` | **实际在跑的 erix-agent 版本**（构建产物，随心跳落账，issue #404 结案）。旧语义是「版本 pin / canary 记录点」，实测那样只会存着一个没人再动的 `.env` 静态值、且**重建也不修正**，已弃用；canary 若真要做，需另开「期望版本」列，与「实际」并排才看得出漂移 |
| `git_provider` | onboarding 选定的 Git host provider（`gitea` / `github` / `gitlab`）；host 详细绑定见 `fde_git_accounts` |
| `last_heartbeat` | agentd 心跳（15s ⚠️，经 internal API 上报、portal 落库，runner-integration §4.2 U4）；3 次丢失（45s ⚠️）判容器死（视 `exited`），run 级处置走租约到期 re-claim（runner-integration §6.4） |

### 1.5 `projects` — 项目（容器内仓库目录）

| 关键字段 | 语义 |
|---|---|
| `name` | 该 `CHECK` 限定 `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`（不允许尾随 `-`）**只服务这张已退役、只读的表**：P5 起 hostname 不含项目名（迁移 `0008`），目录名不再由它约束——目录名的服务端硬边界只有「`~/projects/` 一级目录 + 无路径穿越」（`chat_sessions.cwd` 无 CHECK；portal.md §4.2） |
| `slot` | 项目端口块序号，决定起始端口 `4000 + slot*8`（规格 §8.2）。`user_id + slot` 活跃唯一 |
| `deleted_at` | 删除 = 软删除 + 回收端口（同一事务，portal.md §3.6）；软删后 name/slot 可复用 |

### 1.6 `chat_sessions` — 对话会话（UI 概念）

| 关键字段 | 语义 |
|---|---|
| `status` | `active / archived`；有进行中 run 时禁止归档（portal.md §4.2 `409 run_in_progress`） |
| `last_seq` | **session 级 seq 分配器**：`messages.seq` 与 `run_events.seq` 都由它分配（同事务 `UPDATE ... SET last_seq = last_seq + 1 ... RETURNING`），保证 SSE 的 `Last-Event-ID` 语义（portal.md §5.1/§5.2）。这是原理三「状态在中心」在实时层的落点 |
| `title` / `title_source` | 会话标题（issue #88）。`title_source` ∈ `auto`/`manual`（默认 `auto`，迁移 `0009-session-auto-title.sql`）：建会话显式传 title 或 PATCH 改 title → `manual`（手工优先，自动更新**只写 `auto` 行**）；worker 侧生成（2026-09-25 修订：agent 侧用既有 provider 轻量补全 ≤30 字符，随 `run_finished` 上报），portal 在 run 终态事件后异步评估落库（降级链：首条用户消息截断 → cwd basename），经 session SSE `session_updated` 推送前端 |
| `auto_title_seq` | 上次自动标题更新时的 `last_seq` 快照（迁移 0009；`NULL` = 从未自动更新）——防抖判据「距上次更新 ≥ N 轮新 user 消息」的游标（`ERIX_SESSION_AUTO_TITLE_MIN_NEW` 调 N，`ERIX_SESSION_AUTO_TITLE=0` 关开关） |
| `origin` | 会话来源标记（迁移 `0037`，`text NOT NULL DEFAULT 'human'`）：普通人工会话为 `human`；宏（macro）派生的会话写成 `macro:<template-name>`（如 `macro:run-review`）⇒ 面板与清理可据此区分人工与宏会话，宏会话按来源名归组 |

`active_run_id`（portal.md §4.1）**不落列**，由 `runs_one_active_per_session` 部分唯一索引覆盖的运行中 run 推导——避免两份真相（原理五同构：单一事实源）。

### 1.7 `runs` — 一次 `runToolLoop` 生命周期

| 关键字段 | 语义 |
|---|---|
| `id` | **portal 生成的 UUID**，随任务下发给容器；禁止 cwd 派生（规格 §9.3-3：多用户会撞） |
| `status` | 状态机见 §2.1 |
| `termination` | run 结束时由 `runToolLoop` 返回值透传：**对象** `{reason, detail?}` jsonb（`persistence_failed` 额外带 `{operation, phase, sideEffect}`，见下方注）。<!-- DRIFT:termination-reason:begin -->当前 0.18.0 `reason ∈ {end_turn, no_tool, stall, max_rounds_cap, judge_done, continuation_exhausted, final_guard_unverified, aborted, failed, persistence_failed}`<!-- DRIFT:termination-reason:end -->（依据：`erix-agent/src/loop/orchestrator.js:511` typedef 的 9 值 + 同文件 `:973-977` 实际产出但未写进 typedef 的 `persistence_failed`；`final_guard_unverified` 表示 finalGuard 修订重试耗尽 fail-closed）。**历史数据可能保留旧版 `reflection_stop`——它已不是引擎取值，只是旧行的残留，不得当枚举真值列出**；运行中为 `NULL` |
| `usage` / `cost` | `usage` 为 `{input_tokens, output_tokens}` jsonb（run_end 汇总）；`cost` ⚠️ 待决策者确认（Q1/Q4，P1 可空，见 §5） |
| `run_state` | 引擎 run-state 快照（0.14.0 `saveRunState` / `loadRunState` 可选能力；DDL：`deploy/migrations/0003-run-state.sql`，**baseline 已冻结故不写入 schema.sql**）；合并写时剔除顶层 `state`。终态由 `markRunState` 写入独立 `run_state_status`（migration `0014-run-state-status.sql`），而非快照；`loadRunStateStatus` 先读新状态列，若缺失则兼容读取 legacy 快照 `state`（不回填），损坏状态抛错。`runs.status` 终态仍由 U2 收敛，本列是引擎侧断点/恢复事实（不变式 3）。会话作用域对应列为 `chat_sessions.engine_run_state` 与 `engine_run_state_status` |
| `error` | 失败时为 `{code, message, retryable}`；run 级错误码见 portal.md §6.4（`rate_limited` / `checkpoint_failed` / `container_exited` / …） |
| `cancel_requested_at` | 停止标记：portal 写、runner 轮询（`AbortController` 跨不了进程，规格 §10.3）。**issue #370 起转向也写它**（`POST …/queued-inputs` 的 `kind='steer'` 分支），但**只写时间戳、不动 `status`**——`status='cancelling'` 是「worker 立刻 SIGKILL 正在跑的工具」的开关，而转向要「本轮跑完再停」。「这次 abort 是转向还是用户按了停止」不看这里，看 `queued_inputs.interrupted_run_id` | 
| `trigger_kind` | **这个 run 是谁叫起来的**（migration 0024，issue #370）：`user_send`（默认，用户手发）\| `queued_steer` \| `queued_follow_up` \| `synthetic`。存在的理由很具体：每条 follow-up 都是**一个新 run**，各带一份 `maxRounds`（默认 16，≥16 自动开 reflection）+ judge/wrapup/finalGuard 固定开销——不分出来就永远不知道「一次对话为什么烧了 4 份预算」，也就无法决定是否要合并投递。存量行 DEFAULT `user_send`（不回填，它们确实都是手发的）。默认值是契约，迁移尾部有守卫（漂了拒启动）|

**termination 口径注（issue #212，2026-10-09）**

* **真值链**：引擎实际取值 → 代码单一常量 `portal/frontend/src/lib/terminationReasons.ts`（`TERMINATION_REASONS`）→ 本文 §1.7 与 `docs/api/portal.md` §4.1/§5.3 的枚举表。三者逐项一致由 `portal/test/termination-contract.test.js` 断言（含直接读 `erix-agent` 包源码交叉核对 typedef 与 `persistence_failed` 字面量）。
* **`persistence_failed` 为什么语义最重**：它表示 **transcript 账本 / run-state 写失败**（`markRunState` 等）；**run snapshot 已于 2026-11-17 随 #640 退役，不再是它的成因**（`orchestrator.js:973-977` 定值，`:986-990` 把 `operation`/`phase`/`sideEffect` 挂在 termination 上）——DB 不是这次 run 的完整真相，**崩溃恢复可能重复执行工具副作用**，因此必须与 `failed` 区分并在工作台以红色告警显示（前端红色集合 `RUN_FAIL_REASONS`）。`final_guard_unverified` = 终稿未经 final guard 核验，用户必须看见，同列红色。⚠ issue #236 起「界面刷红」另有**派生集合** `RUN_TERMINATION_SYSERR_REASONS` = `RUN_FAIL_REASONS` **减掉 `aborted`**（用户按「停止」不是故障 ⇒ 中性分隔条）；`RUN_FAIL_REASONS` 本体不变（它仍决定「重试上一条」与「终态后补拉 history」）。
* **`termination.errorCode`（erix-agent 0.18.0 新增，上游 #176）**：仅 `reason === 'failed'` 的终局额外带 additive 字段 `errorCode`——引擎把错误上已有的分类码（`KitError.code`：`timeout` / `rate_limited` / `auth` / `server` / `checkpoint_failed` / …）原样透出，错误上没有分类码时引擎回落 `unknown`；**值域由引擎定义**，宿主不解释语义、不维护第二份枚举。station 是「原样透传引擎 termination」（`runner/lib/termination.js`），运行时零改动即已下发，因此本列的 jsonb 可能含 `errorCode` 键；其余 reason 的终局形状不变。依据：`erix-agent/src/loop/termination.js:43-49` `terminationErrorCodeForError` + `:52-57` `withErrorCode`（只认 `failed`），在 `src/loop/orchestrator.js:981-984` 的 `fail()` 里调用。
* **`docs/data/schema.sql` 内该列的注释不作为真值来源**：那段注释是 baseline 冻结时留下的历史快照（还写着 v0.3.5 与已不存在的 `reflection_stop`）。原因见 `portal/src/migrate.js`：`:138` 对**整个 `schema.sql` 文件文本（含注释）**算 sha256，`:154-172` 与库中 `schema_migrations` 里 baseline 的 checksum 不符就 `refusing to start`，而这段校验发生在增量迁移循环（`:185`）**之前**——「加一条迁移去 UPDATE checksum」救不了它。故本仓一律不改 `schema.sql`（含注释），口径变更只写本文与 `docs/api/portal.md`，DDL 只走 `deploy/migrations/*.sql`。

**容器侧 run 数据目录（文件真相的归档层，issue #64 R1 配套 / conversation-state.md §5 P1）**：DB 是状态真相（不变式 3），容器内需单独管理的文件包括 **run 产物**（v0.1.x 写的是「worktree 产物」：D8 修订后捕获目标 = 项目目录（worker cwd），终态捕获为 artifact bundle 入 `artifacts` 表 + portal 持久卷，§1.13）与 run 数据目录中的 notes（**#392 B 片起为会话作用域**：`<home>/sessions/<sessionId>/notes`，跨该会话每个 run 可见；session transcript 仍按 conversation-state.md 设计存于 DB）。后者生命周期两层（`runner/lib/run-data.js`）：`<home>/runs/<runId>/` 活跃层跨 attempt 保留；活跃 worker 存续期间 agentd 每次心跳刷新 run 目录顶层 mtime，以免深层 notes 写入不更新父目录；未确认终态的异常残留由 agentd **启动时**按该顶层 mtime 和 `ERIX_RUN_DATA_TTL_HOURS`（默认 24h，自最近心跳起算，`0` 禁用）清扫。**终态确认后不物理删除**，而是整体归档（同盘 rename）到 `<home>/runs-archive/<runId>/` 并刷新归档目录 mtime；agentd 启动 sweep 仅在该 mtime 超过 `ERIX_ARCHIVE_TTL_HOURS`（默认 168h=7 天，`0` 禁用清扫）时物理删除整棵目录树。该 168h 是 run 目录（`runs/` → `runs-archive/`）的保留阈值，与 notes 的保留**已经分家**：notes 在 #392 B 片抬到会话作用域后不再随 run 归档搬走，也**不在**上述两条 sweep 的覆盖里 —— 它与会话同命，回收归**会话生命周期**（portal 删会话时连带删目录，见 `runner/lib/run-data.js:60-62`）。若需更长保留 run 目录本身，调大 `ERIX_ARCHIVE_TTL_HOURS`；设为 `0` 可禁用归档清扫。sweep 只在 agentd 启动时运行，过期目录会保留到下一次启动；未归档异常残留则使用独立的 24h 默认阈值。

**降级路径（run 作用域 notes，仅当无 `session_id` 或会话目录预建失败）**：正常终态由 notes `onRunComplete()` 将 active 记录标为 done；实际文件位于 `<home>/runs-archive/<runId>/notes/run/<runId>/<key>.json`。Station 不另调 `store.purge()`，因为归档 sweep 会删除整个 run 目录，包括记录、tombstone 与空 scope 目录。未终态 run 的异常残留由上述 TTL 粗粒度删除整份 run-scope 文件树，不执行上游的 list/revoke orphan 循环或保留 revoked tombstone；这是文件层最终回收，不等价于语义撤销。终态归档失败也会留在 `runs/`，记录 warn 后由残留 sweep 兜底。当前 agentd 在 `session_id` 可用且预建成功时下行 `<home>/sessions/<sessionId>/notes`（**会话作用域**），否则退回 `<home>/runs/<runId>/notes`（run 作用域）并 warn；旧 agentd 缺少 `notes_dir` 时，worker 兼容回退到 `<cwd>/.notes`，该路径及历史遗留的 cwd-local `.notes` 均不受 run 目录 sweep 管理，也不会自动迁移。v0.1.x 该处还写「worktree 照旧随 run 回收（D8 执行隔离物，非真相层）」——D8 修订后 run 的工作目录就是**项目目录（用户资产，不随 run 回收）**，已无 worktree 可回收（⇒ [`../design/fde-platform.md`](../design/fde-platform.md) 附录 A.1）；产物捕获发生在 run 目录归档之前，归档不拦截产物回收。

### 1.8 `messages` — 第①层：人看的对话

见 §3 边界说明。要点：`role` 仅 `user / assistant`；`synthetic` 默认 `false`，judge/wrapup 注入的合成消息置 `true`，**UI 必须显著标记**（规格 §9.2 红线）；`seq` 与 `run_events` 共用 `chat_sessions.last_seq` 分配器，`UNIQUE(session_id, seq)`；`run_id` 关联产生它的 run（用户消息 = 它触发的 run）。

> **`content` 列语义（P3 PR②b B2，conversation-state.md §6）**：本表已降级为**纯锚点行**——两个写入点（POST 用户行 / 终态 assistant 行）的 `content` 恒写空串（列仍是 `text NOT NULL`，baseline `schema.sql` 冻结不改），正文单一来源是 `transcript_rounds.record`（UI 文本由官方展示投影派生）。因此 `content` **只对两类行有意义**：`synthetic = true` 的宿主注入行（judge/wrapup，transcript 里无对应轮次，正文只能落在本列）与迁移 0015/B2 之前的 **legacy 老行**（仅供 `portal/src/session-text.js` 的 legacy 兜底读）。上表「内容」列描述的仍是**人读层的语义归属**（本行代表哪段对话），而非正文的物理存储位置。

> ⚠ **261113 现查补一条未证事实**：本库 `messages`
> 391 行里 `content` 空串 **297 行**，且**非空的 94 行全部落在 2026-09-21…09-25**，
> 10-08 之后写入的行**一律空串** —— 与本段口径一致（正文在 `transcript_rounds.record`）。
> 但 **`synthetic = true` 的行在本 dev 库 0 行**，所以「宿主注入行正文只能落本列」这半条
> **至今没有任何真机数据证明它成立**。改写入点或改 UI 前别把它当已验证前提：要么补一条
> 覆盖注入行的用例，要么在真机跑出一条 judge/wrapup 注入行再下结论。

### 1.9 `port_allocations` — 端口分配（DB 是真相，规格 §8.1）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，**FDE 用户**（forward-auth 按预览凭证哈希查 `preview_grants` 解析 `user_id` 后与此列比对，portal.md §2.7；不解析 `cookie.sub`，旧口径作废） |
| `scope` / `run_id` | `scope` 三值 `CHECK (scope IN ('project','run','fde'))`（第三值 `fde` 由迁移 `0018` 追加：FDE 主机级端口占用，`run_id` 恒 NULL）。条件约束 `CHECK ((scope='run') = (run_id IS NOT NULL))` **原样保留**：`run` 级必带 `run_id`，`project` / `fde` 级 `run_id` 必空（与 `fde` 行 `run_id` 恒 NULL 自洽）。⚠️ Q5 早期记「P1 先只做项目级，字段先行保留」（principles §4 Q5 倾向 (b)）；`fde` 值已由 0018 落地 |
| `port` | 容器内 dev 端口，baseline 的 `CHECK (port BETWEEN 4000 AND 4999)` **已被迁移 0019 换成按状态分支**：活行 `BETWEEN 22000 AND 29999`（全局号池，#246），`state='released'` 行放宽到 `BETWEEN 4000 AND 29999` 以保留历史号码；原 3001 code-server / 3000 runner 内部 API 容器固定端口角色均已取消（规格 §12.3，issue #71 / issue #3 评论，决策者 2026-09）——容器平台通道零监听，不入表 |
| `hostname` / `url` | 由 portal **与 Traefik 路由同源生成**（规格 §8.1）；前端只展示/跳转 `url`，永不拼接（portal.md §8-4） |
| `exposure` | `private`（默认）/ `org-visible` / `public`（规格 §6.5；非 admin 申请 `public` 被拒，portal.md §4.7） |
| `state` | 状态机见 §2.2 |

**唯一性设计（本表核心）**：

- `port_allocations_live_port_key`：部分唯一索引 `(fde_id, port) WHERE state <> 'released'`——同一 FDE 容器内一个端口同一时刻至多一条未释放分配；**并发申请靠它 + 事务兜底**（规格 §8.1），释放后端口可复用。
- `port_allocations_live_global_port_key`（**迁移 0019 新增**，#246）：部分唯一索引 `(port) WHERE state <> 'released'`——端口在**全部活行范围内**唯一（跨 FDE 不重叠是硬不变式，由 DB 而非应用层保证）；`released` 行不占位 ⇒ 号码可回收复用。写侧 `ON CONFLICT` 仍需带谓词指向 `(fde_id, port)` 那条（同 FDE 幂等），跨 FDE 撞号则由本索引抛 `23505`。
- `port_allocations_live_hostname_key`：活跃 hostname 全局唯一——forward-auth 按 hostname 精确查（portal.md §2.7 第 1 步），「路由表里没有 = 不可达」（原理二）。
- `port_allocations_reaper_idx`：支撑 reaper 回收 `released_at` 过期项（规格 §8.2）。

### 1.10 `transcript_rounds` — 第②层：canonical 消息

见 §3。`UNIQUE(run_id, round)`。**`record` jsonb 存上游 RoundRecord 全量原样，是全量真相**——store 的 `load()` 原样返回它（resume / fold 的输入）；`messages` / `folded` / `folded_payload` 是**派生/加速列**，供 SQL 查询与 UI 使用（决策者 2026-09，D2' 对齐；上游 RoundRecord 形状见 runner-integration §9.1）。fold 只影响视图，**档案完整不删**（规格 §9.2）；fold 后原轮 `UPDATE`（`folded=true` + `folded_payload`），不插新行（runner-integration §9.3）。写入方 = portal internal 端点（`PUT .../transcript/rounds/:round`，按 round 幂等 + `dedupKey` 双保险）；runner 侧是 HTTP adapter 调用方，不直连 DB。

**`append_seq` 与同 round 保序（迁移 0016，erix-agent 0.16.0）**：同一 `(transcript_key, round)` 可有多行（CLI 行号复用 + 引擎 `:resume` 补跑重落盘；session 行 `run_id IS NULL` 不受 `UNIQUE(run_id, round)` 限制）。`append_seq bigint`（默认 `nextval`）是**持久化追加序列**，新行由序列保证严格追加序；存量行按 `created_at, id` 确定性回填（历史行近似还原）。`load()` 契约要求按追加序返回同 round 记录（引擎不再二次排序），故 `getSessionTranscript` / legacy `getTranscript` 用 `ORDER BY round ASC, append_seq ASC`——不得依赖 `created_at`、执行计划或主键扫描顺序（真机已存在 `created_at` 完全相同的同轮行）。

### 1.11 快照表（run snapshot，crash-resume 的落点）**【已退役：迁移 `0041`，issue #640】**

> 表原名在下面这几段历史文字里**不再重复写出**（判据：活文档里不留这个名字）——建表 DDL 见
> `deploy/migrations/0006-session-transcript.sql`，清存量见 `0034-prune-stale-run-checkpoints.sql`，
> 撤表见 `0041-retire-run-checkpoints.sql`；它从 0001 baseline 就在，所以冻结件里那句建表语句照旧。

> ⚠ **这张表已经不存在了**（2026-11-17，issue #640）。erix-agent 0.33.0（上游 #838 S2，本站 #530）
> 把 run snapshot 整个退役 ⇒ 引擎不再调 `saveRunSnapshot` / `loadLatestRunSnapshot`，恢复只靠账本
> （`transcript_rounds` 的轮记录 + `transcript_recovery_rows` 的 `tool-executed` 证据）。本站随之删掉
> store 方法、agentd 转发、四个 internal 端点，并用 `0041-retire-run-checkpoints.sql` 撤表
> （撤前真库 17 行 / 565,248 B、`max(updated_at)` = 2026-11-11，零写入；FK 是 child 端、零视图/触发器依赖）。
> **下面整节留着是历史读法**：旧 ledger、旧事件载荷、旧 runner 日志里的 revision CAS / `checkpoint_stale`
> / `checkpoint_failed` 都要能对上号。**新代码不要照本节写**（照 §1.9/§1.10 的账本写）。

**每 transcript key 一行**（run 模式以 run 为 key，session 模式以 session 为 key）：erix-agent 0.14.0 的 `saveRunSnapshot` / `loadLatestRunSnapshot` 是**latest-only 覆盖读写**。写入语义 = `INSERT ... ON CONFLICT ... WHERE <表>.revision < EXCLUDED.revision`（单行覆盖 + **revision CAS**，重试同一 revision 安全；portal.md §9.8 已标退役）。这组 optional snapshot 能力成对实现时提供 crash-resume；写失败经 HTTP adapter retry 后仍抛 `checkpoint_failed`（runner-integration §9.2）。原「本地 file 优先 + DB 异步复制」装饰器建议已按决策者裁定**不采纳**（D2' 纯 DB；代价见 runner-integration §9.4）。

**单调性（revision CAS，issue #8）**：`revision bigint NOT NULL DEFAULT 0` 是每 transcript key 的**单调版本号**。worker 每实例从 0 起递增；portal 端 `DO UPDATE ... WHERE <表>.revision < EXCLUDED.revision`——**旧 revision 的覆盖写被拒（0 行更新 → `409 checkpoint_stale`）**，解决「延迟到达的旧快照覆盖新快照」。resume 时 worker 经 U9 读回当前 `revision`，继续从 `revision+1` 起计，避免新 worker从 0 起计被 CAS 误拒。`seq` 仍是**调用方本地元数据、不落库**（其值在数值上可等于 revision，但不具权威性；runner-integration §9.5）。

> **⚠ 整段已于 2026-11-17 作废（#640 / 迁移 `0041`）**：`run_checkpoints` 表**已删**、U8/U9 端点**已删**，
> 所以下面关于「终态 run 读不到 / 只能给未完成 run 用」的口径只对**历史库**有意义，现役代码里没有这条读面。
> 恢复只靠账本。保留原文是为了解释 `0034` 当年的取舍。

**时间边界（自迁移 `0034`，PR #509）：终态 run 的 run-keyed 快照读不到了 ⇒ 它只能给「未完成的 run」用**。
`getLatestCheckpoint`（`portal/src/internal.js`，端点 U9 `GET .../runs/:id/checkpoint/latest`）对**已终态的 run**
会**返回空**（内部 `null` ⇒ HTTP `204`）——**它是返回空，不是报错**：鉴权层仍然允许终态 run 读（只有非终态 run 才校
`X-Claim-Token`），只是**那一行已经不在表里了**——`0034` 的谓词 (a)（`transcript_key IS NULL` 且那个 run
`status IN ('finished','failed')`）专清这一类（dev 实测命中 14 行 / 304,496 B）。**时间精度**：迁移只处理它执行
那一刻的存量，而现网没有会自动重跑 `0034` 的 reaper ⇒ **那之后才终态**的 run，它的 run-keyed 行只是「下一支清理迁移
来之前还躺着」——所以不能拿「这条今天还读得到」当契约：**终态 run 的 run-keyed 快照从此不是 durable 读面**，
调用方必须只对**未完成 run**（`queued` / `running` / `cancelling`）读它。为什么可以这样：快照的唯一用途是
**接力一个没跑完的 run**（上游契约把它钉成 latest-only autosave + optional 能力，缺席的语义就是「没得到崩溃接力」，
下一次 run 照常从 `transcript_rounds` 账本重建上下文 ⇒ 不丢正文），run 已终态 ⇒ 不会再有 attempt 去读它 ⇒
那一行是纯死重（取证在 `deploy/migrations/0034-prune-stale-run-checkpoints.sql` 头注释）。

> **⚠ 这一整条已于 2026-11-17 作废（issue #640，迁移 `0041`）**：erix-agent **0.33.0** 让 run snapshot
> 彻底退役（引擎零调用 `saveRunSnapshot` / `loadLatestRunSnapshot` / `loadLatestCheckpoint`），所以
> **`run_checkpoints` 整张表已撤** —— 上面关于「run-keyed 行 / session 作用域那一路」的区分、
> 以及「现役 runner 走 session 端点」这些口径**都不再成立**：两条作用域一起没了。
> 现在的唯一 durable 读面是**账本**（`transcript_rounds` / `run_events` / `transcript_recovery_rows`），
> 快照不再参与持久化与恢复。上游口径见 `erix-agent` 的 `docs/host-upgrade-guide-0.33.0.md` §2。

### 1.12 `run_events` — 第③层：流式事件日志

见 §3。只追加；`seq` 由 portal 落库时从 `chat_sessions.last_seq` 分配（session 内单调递增，portal.md §5.1）；**`client_event_id` 为客户端幂等键**（worker 生成 `run_id:attempt:单调计数`，attempt 为本次 start 次数、计数为该 attempt 内单调递增），`UNIQUE(run_id, client_event_id)` + `ON CONFLICT DO NOTHING` 支撑 agentd 批量上报的 at-least-once 去重（runner-integration §7.3）；`session_id` 为冗余列，支撑 SSE 按 session 补发（`Last-Event-ID`）；`UNIQUE(session_id, seq)`；`type` 清单见 portal.md §5.3，上游 additive 新类型原样透传（故 DB 层不对 `type` 做 CHECK 枚举）。

> **只有 durable 档落库（issue #502）**：引擎给每个事件类型标了档位（`erix-agent` 的
> `eventTierOf` / `EVENT_TIER_STREAM`），stream 档三型 `assistant_delta` / `reasoning_delta` /
> `tool_call_delta` 在 U3 写循环里**既不 INSERT 也不分配 `seq`**，只转发给浏览器。判据是引擎的表，
> 本站不再手抄类型清单（上游 additive 新碎片类型自动继承同一命运）。
> **下面那组体积读数是「`0033` 迁移前」的历史基线**（dev 真库 2026-11-13 现查，清存量与 VACUUM 都还没跑）：
> `run_events` 884,163 行里 **877,155 行是这三型**（99.2 %），表体 472 MB；平均每行 ≈ 560 B、
> `assistant_delta` 的 `payload.text` 平均 **2.09 个字符**（`SELECT avg(length(payload->>'text'))
> WHERE type='assistant_delta'` 现查；工单 #502 正文里那个 3.82 是同一条 SQL 的旧读数，本次没复现出来，
> 以现查为准）——即「一次事务 + 五次索引更新」换两个字符。**别拿它们当现在的量级。**
> **迁移后实测（2026-11-14：`0033` 跑完 + `VACUUM (FULL, ANALYZE) run_events` 之后）**：`run_events` **7,008 行**、`pg_total_relation_size`
> **5,578,752 B（5.3 MB）**、每行 **802 B**（五条索引全留）、全库 `pg_database_size`
> **48,389,143 B（46.1 MB）**，碎片行此后保持 **0**。
> ⇒ 每行字节反而**变大**（802 vs 560）是预期的：被删掉的正好是**最短**的那批行，留下的 durable 行本就更大
> ⇒ **不要**拿「每行字节」当「修法没生效」的证据，**行数与表体才是**。
> 碎片的**内容**去向只有两条（形态 M 的落点，**零新类型、零新索引**）：
> ① **进程内累加器**（`portal/src/run-partial-buffer.js`，per-process ⇒ 重启即失、多副本不共享）只服务
>    断线补发，且**只存当前那一轮**（`round_start` 一到就换槽，正文按轮重置、`reasoning` 独立累加）；
> ② 终态时若这次 run **没有 assistant 锚点**，那段未定稿正文**并进既有 `run_end` 的载荷**：
>    `payload.partial_text` + `payload.partial_round` + `payload.partial_truncated`（**第三个键是 #513 加的**，
>    取缓冲**正文槽自己**的截断位，不是两路共用的那个观测位；与合成 `run_end` 的**同一条 INSERT**，
>    `internal.js#runEndPartialKeys`，六个终态点共用一个 helper）。**没有新增事件行**，也没有
>    「一个 run 至多一行部分正文」的库面约束——那条约束本来就由**既有**的
>    `run_events_run_end_key (run_id) WHERE type='run_end'` 提供（一个 run 至多一条 `run_end`），
>    形态 M 因此**不新增也不删除任何索引**；曾经计划的部分唯一索引 `run_events_run_partial_key`
>    随它服务的那个行类型一起放弃。
> ⇒ 「这次 run 说过的话」的 durable 来源只有两处：已完成轮次的 `round_end.payload.final_text`
>    + 被停住那半轮的 `run_end.payload.partial_text`；历史投影（portal.md §4.4a-1）只读这两处拼正文，
>    两处都空则给一条**占位合成项**（`placeholder: true`，#278 不空白红线的唯一落点）。
> **B/C 的索引与键都保留**：`(run_id, client_event_id)` 的幂等键对 durable 档仍然承重（at-least-once
> 重投照旧顶回），五条索引服务的是仍在落库的那些行——碎片不落库不等于索引可以为碎片让路。
> 存量清理由迁移 `0033` 分批完成（`FOR UPDATE SKIP LOCKED` + `SET LOCAL lock_timeout/statement_timeout`，
> **纯清理：语句区零 CREATE/DROP/ALTER**）。
> **部署顺序是硬约束**：`0033` 把「残留 stream 档碎片」的观测从 `RAISE WARNING` 改成了 **`RAISE EXCEPTION`**
> ⇒ **必须先上代码、再跑迁移**；顺序反了（旧版 portal 还在往库里写碎片）迁移会失败而不是带病通过
> ——失败可重放，不是死局，但会把起栈卡住。

**`run_end` 唯一性与来源（A4 定稿）**：`type='run_end'` 是 portal 在 U2 终态事务内**合成**的 run 内最后一条事件（worker 不再经 U3 发 `run_end`，runner-integration §7.6），其 `client_event_id` 为确定性值 `run_id:final:run_end`。schema 额外有部分唯一索引 `UNIQUE (run_id) WHERE type='run_end'`（`run_events_run_end_key`），保证**即使 client_event_id 不同，每个 run 也至多一条 `run_end`**；U2 终态重试用 `ON CONFLICT (run_id, client_event_id) DO NOTHING` 去重（同载荷幂等）。

> **展示类历史读取通路（issue #89）**：`GET /api/sessions/:id/events/history`（portal.md §4.4a）按 seq 升序返回白名单内的展示类事件（工具卡片 / judge / round / compaction 等），供前端刷新后走与 SSE 实时**同一渲染路径**重建展示层；运行态语义事件（`run_end`/`usage`/`checkpoint` 等）不下发——历史回放不驱动运行态状态机。

> **事件排序与 attempt 语义（issue #8）**：`seq` 只是**回放游标**（session 全局、按到达顺序分配、严格递增；**自 #502 起允许跳号**，见下），**不是** run 内逻辑顺序；逻辑顺序由 `client_event_id` 的 `(attempt, 计数)` 编码。attempt 使 re-claim 后新 worker 的计数归零也不会与旧 attempt 的 `client_event_id` 碰撞。乱序**到达**不影响正确性（逐事件幂等 + 自包含）；严格递增只对 `seq` 游标成立。详见 runner-integration §7.3/§7.5。
>
> **#502 之后「无空洞」不再成立，跳号是合法的**（两个来源：① stream 档不分配 `seq`；② 写循环去掉了
> 「先 `SELECT` 查重再 INSERT」的预检，重复投递会烧掉几个 `seq` 再被 `ON CONFLICT DO NOTHING` 丢掉）。
> `chat_sessions.last_seq` 照旧单调，`UNIQUE(session_id, seq)` 照旧兜底，**客户端不得拿跳号当重连触发条件**
> （这条 #25 的裁决原来就在，如今更是硬事实）。

### 1.13 `tool_calls` / `judge_decisions` / `approvals` / `artifacts`

- `tool_calls`：`call_id` 对应事件流的 `tool_call_id`（portal.md §5.3），`UNIQUE(run_id, call_id)`；**`call_id` 是外部 ID（canonical，见 §1.19），`tool_calls.id` 仅内部主键（uuid）、不外露**；`result_digest` 只存摘要（完整结果可能很大）；`approved` 三态（`NULL` = 未涉及审批）。**行由 portal 在 U3 事件上报时幂等 upsert**（`type='tool_use'` 事件 `INSERT ... ON CONFLICT (run_id, call_id) DO NOTHING`，后续 `tool_result`/`tool_call_delta` 更新派生字段，portal.md §9.10）——U10 建审批单时行必已存在。
  - **`duration_ms` 列（#303 后）**：该列仍由 U3 的 `tool_result` UPDATE 回填（写侧未变），但**自 #303（erix-agent 0.34.0 后旧键 `duration` 退役）起不再被读进对话流 DTO 的 `toolCalls[].durationMs`**——后者现在只来自引擎投影的 `erix.durationMs`（旧「投影缺省 ⇒ 回落宿主 `tool_calls.duration_ms`」支路已删，见 portal.md §5.3）。此列的旧回落曾是它在视图层的**唯一**读点；#303 删后，产品代码里已无消费此列做展示的路径（写侧仍保留：U3 照旧回填，与 `run_events` 的 `tool_result` 事件一起作为历史/审计的时长存档）。
  - **跨实例风险（#303）**：删的是「读旧数据」的兼容——**存量比本次发布老的实例升级后**，那些老对话（引擎当年没写 `erix.*`、只有顶层 `duration` 或宿主 `tool_calls.duration_ms`）的工具耗时会渲染为「未知」（前端现有 `dur` 为空时不显示，**不是报错**）。⚠ 这只说 **DTO 面**：**事件回放是另一条来路**——`run_events` 里 `tool_result` 的 payload 存着当年的 `duration_ms`，历史接口原样返回、前端照它渲染（`portal/src/http.js` 的事件白名单含 `tool_result`）⇒ 别说成「老对话一律显示未知」，只有**两条来路都没给**才是未知。
  - **存量核对（一条可复跑语句，勿把某机实测数字当结论）**：工具结果块**不在 `record` 顶层**，而在
    `record -> 'messages'[*] -> 'content'[*]` 里 `type = 'tool_result'` 的块上；耗时键是块内的
    `erix.durationMs`，旧键是同一块的顶层 `duration`。按路径直查顶层键会得到恒 0 的**假阴性**（实测踩过）。
    五个计数各自回答一个问题（`tool_results` 是分母，为 0 就说明路径问错了，其余四个数全部别信）：
    - `tool_results` —— 分母。
    - `legacy_duration_key` —— 仍带顶层旧键 `duration` 的块数（冗余残留，不等于会改变行为）。
    - `legacy_only_no_engine` —— **只有**旧键、没有 `erix.durationMs` 的块数：这才是删 runner 那条
      回退后**唯一可能改变行为**的集合。
    - `no_engine_duration` —— **投影拿不到时长**的块数（没有 `erix` 对象，或 `erix.durationMs` 不是数）
      ⇒ 这些格在 DTO 面上本来就显示「未知」，删回退不改它们的显示。
    - `no_erix_object` —— 连 `erix` **对象**都没有的块数。⚠ 别只读成「引擎 0.20.0 之前的老形状」：
      `erix` 是数组、JSON `null` 或标量的块同样落在这里，**形态与年代不是一一对应**。
      ⚠ 这条 CTE **不按 type 过滤**，所以每一条 `FILTER` 都得自带 `b->>'type' = 'tool_result'`；
      漏掉就会数到 `text` / `tool_use` 块，得到**比分母还大**的数而**不报错**。
    - 大小关系是**按构造保证**的：`erix_is_obj` 为假 ⇒ `has_engine_dur` 必为假 ⇒ `no_erix_object ⊆ no_engine_duration`。
      别把判定改回「直接对 `b->'erix'` 用 `?`」——`?` 对**数组**是「成员存在」，`erix: ["durationMs"]`
      这种形状会被误判成「有时长」，关系就不成立了。
      它总是 `≤ no_engine_duration`，两者接近就说明存量里老记录占多数。
    ```sql
    WITH blocks AS (
      SELECT t.run_id, b,
             -- 把「有没有引擎时长」先算成布尔，且**只在 erix 真是对象时**才认它的键：
             -- `?` 对数组是「成员存在」，`erix: ["durationMs"]` 这种形状会被当成有时长。
             -- 两个布尔都必须 COALESCE：`jsonb_typeof(NULL) = 'object'` 结果是 NULL 不是 false，
             -- 而 `NOT NULL` 仍是 NULL ⇒ FILTER 会不计数（同一个三值坑的第二层）。
             COALESCE(jsonb_typeof(b->'erix') = 'object', false)  AS erix_is_obj,
             -- 「有引擎时长」按**投影能显示的东西**算，不按键存在算：`display-projection.js` 只收
             -- 有限数（`typeof === 'number' && Number.isFinite`）。键存在但值是字符串或 null 的块，
             -- DTO 面上本来就是「未知」⇒ 按键存在数会**低估**真正缺时长的块数。
             (COALESCE(jsonb_typeof(b->'erix') = 'object', false)
               AND COALESCE(jsonb_typeof(b->'erix' -> 'durationMs') = 'number', false)) AS has_engine_dur
      FROM transcript_rounds t
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(t.record->'messages') = 'array'
               THEN t.record->'messages' ELSE '[]'::jsonb END) m
      CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(m->'content') = 'array'
               THEN m->'content' ELSE '[]'::jsonb END) b
    )
    SELECT count(*) FILTER (WHERE b->>'type' = 'tool_result')                  AS tool_results,
           count(*) FILTER (WHERE b->>'type' = 'tool_result' AND b ? 'duration') AS legacy_duration_key,
           count(*) FILTER (WHERE b->>'type' = 'tool_result' AND b ? 'duration'
                                  AND NOT has_engine_dur)                      AS legacy_only_no_engine,
           count(*) FILTER (WHERE b->>'type' = 'tool_result'
                                  AND NOT has_engine_dur)                      AS no_engine_duration,
           count(*) FILTER (WHERE b->>'type' = 'tool_result'
                                  AND NOT erix_is_obj)                         AS no_erix_object
    FROM blocks;
    ```
    ⚠ **三值逻辑是这条语句最大的坑**：`b->'erix'` 在块里没有 `erix` 键时结果是 SQL `NULL`，
    `NOT (NULL ? 'durationMs')` 仍是 `NULL`，`FILTER` 直接不计数 ⇒ **恰好漏掉最老的形态**
    （连 `erix` 都没有的老块）。判定要写成 `NOT COALESCE(..., false)`，且只在 `erix` 是对象时取键；
    漏掉时计数会**小一个量级而不报错**——所以先看分母，再看两个计数是否满足上面那条包含关系。
    ⚠ 别把 `run_id` 当 DTO 的准入闸：`getSession` 是**按 `transcript_key` 取 transcript 行**的
    （`portal/src/sessions.js` 里那条 `WHERE transcript_key = $1`），视图层再把没归属的轮次归给
    唯一 run（`portal/src/session-view.js` 的 `soleRunId` 一支）⇒ **`run_id IS NULL` 的块也会进 DTO**。
    所以「块数很多」不等于「用户会看到变化」，但按 `run_id` 关联 `runs` 筛出来的也**不是全部影响面**。
     要判**本次删掉的宿主回落**的影响：它的键是 `${宿主 tool_calls 行的 run_id}\u0000${call_id}`，而查表用
     的是 **DTO 上的 runId**（没归属的轮次已被 `soleRunId` 归给该会话唯一 run）⇒「这格原来显示过数字」
     = 「块的 `tool_call_id` 能在**那个 run** 的 `tool_calls` 里找到同名行、且该行 `duration_ms` 非空」。
     ⚠ 别写成「`run_id IS NULL` 的块本来供不到」：归属之后它照样命中，界线是 **call_id 能否匹配**，
     不是 transcript 行自己那个 `run_id`。
    - `tool_calls.duration_ms IS NULL` 的行数只是**观察值**：自 #303 起该列不再被 DTO 读，
      「本该为 NULL」的结论要靠上面的 `(run_id, call_id)` 关联得出，不能只靠这条全表计数。
- `judge_decisions`：judge 事件（`kind / action / decision`）的持久化，与 `run_events` 中 `judge` 类型事件同源。
- `approvals`：**一个工具调用至多一条审批单**（`UNIQUE(run_id, tool_call_id)`，`tool_call_id` 为外部 `call_id`）；`CHECK` 保证 `pending/expired` 与 `decided_at IS NULL` 一致；决定后 runner 轮询继续/终止（portal.md §4.8）。状态机见 §2.3。⚠️ 超时语义已定稿（#10：`pending → expired`，由 portal 打标，topology.md §4-L6）；`tool_call_id` 是否改判 UUID 待 #10 确认。
- `artifacts`：run 产出的文件登记（issue #64 R1 起为**终态产物 bundle 登记**：`kind='worktree_bundle'`（**历史遗留名**：D8 修订后 bundle 的内容来自**项目目录（worker cwd）**而非 run worktree，值本身是契约不因此改名 ⇒ `portal/src/artifacts.js` 的 `ARTIFACT_KIND`），一 run 一行，`UNIQUE(run_id, kind)`（迁移 0005），重复上传 409 不覆盖）。`path` = portal 持久卷路径（`ERIX_ARTIFACTS_ROOT/<runId>.tar.gz`；原「容器内路径」登记设想由 v1 bundle 语义替代），`size`/`sha`（sha256）描述 bundle 本体，`manifest`（jsonb，迁移 0005）= agentd 生成的包内清单（文件路径/大小/sha256/`truncated` 截断标记），portal 从 tar 内 `manifest.json` 抽出落库。bundle 内容：`diff.patch`（git diff HEAD）+ 新文件快照 + `manifest.json`，上限 20MB（`ERIX_ARTIFACT_MAX_BYTES`）。

### 1.14 `usage_ledger` — 用量台账

记账口径见 §5（⚠️ Q1/Q4）。结构上：`source` 区分 `erix`（引擎 `onUsage`，一 run 一条，`UNIQUE(run_id, source)`）与 `gateway`（网关虚拟 key 拉取，按 `key_alias + day` 聚合，`run_id` 为 NULL 因为 key 粒度到不了 run）——规格 §11.4「两套数都要记」。

### 1.15 `audit_log` — 审计（只追加）

`actor_id` 可空（系统动作 / 未认证的 forward-auth 判定）；forward-auth **每次判定无论通过与否都写**（portal.md §2.7）——「谁在什么时候看了哪个端口」（原理二）。本地 admin 的每次登录/操作强制审计 + 告警（规格 §7.1）。

### 1.16 `run_queue` — 任务队列（含租约）

派单 = **拉取**：agentd `POST /api/internal/claim` 长轮询（hold ≤30s ⚠️）+ portal 侧 NOTIFY/事件唤醒；push 优化 P2 后置（推荐倾向，⚠️ 待决策者确认，runner-integration §15-3）。claim / 续租 / 回收全由 portal 经 internal API 执行（D1'：容器不直连 DB）。

| 关键字段 | 语义 |
|---|---|
| `container_id` | **入队时的派单目标容器实例**（历史路由快照，审计/对账用）。**领取资格不再按它过滤**（重建后容器实例 id 会变） |
| `owner_container_id` | **当前租约持有者**容器实例（claim 时写，release / reaper 回收时清）。fencing 用 `owner_container_id` + `claim_token` |
| `claim_token` | 本次认领凭证；run 级写请求带 `X-Claim-Token`、心跳 U4 逐 run 携带，re-claim 后旧 token 失效（`lease_lost`）——**双写防护**（runner-integration §4.2/§6.4） |
| `lease_until` | 租约到期时刻（lease 90s ⚠️，随心跳续期）；过期允许 re-claim（认领 SQL 见 schema.sql §8 注释） |
| `attempts` | 已发起的（re-）start 次数（**只在 claim 成功时 +1**；reaper 回 pending / U12 release 回 pending 均**不**递增，A1 定稿）；崩溃循环上限见 `max_attempts` |
| `max_attempts` | 崩溃循环上限（默认 3，`CHECK max_attempts >= 1`）；`attempts >= max_attempts` 且再崩溃 → runs `failed`（`max_attempts_exceeded`） |

**领取资格（issue #8；A2 收紧）**：以**稳定 FDE 身份**（`user_id`，经 run → session → user 推导）为准，**不以容器实例 id** 为准——容器重建后新容器（同 user）天然可领取入队时派给旧容器的队列行；`owner_container_id` 记录当前持有者、`container_id` 保留入队时目标作审计快照。**认领同时要求 `runs.status IN ('queued','running')`**——`cancelling`（用户已 stop）与终态（`finished`/`failed`）绝不进入认领结果（A2）。`run_id UNIQUE`（一个 run 至多入队一次）；CHECK 强制 `claimed` 行必带 `claimed_at / lease_until / owner_container_id / claim_token`，另有 `CHECK (attempts <= max_attempts)`；状态机见 §2.4/§2.8。

### 1.17 `fde_networks` — FDE 网络注册表（IPAM 真相，H-B D-10）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，主键：**每 FDE 一行**（一个 FDE 一张网络） |
| `network_name` / `subnet` | 均唯一。`network_name = fde-<name>`（docker 网络名）；`subnet` 为 `10.200.<n>.0/29`（默认池）或 `10.201.<n>.0/28`（大 FDE 段） |
| `prefix_len` | `29` 或 `28`（CHECK 限定）；`/29` 5 个容器位、`/28` 13 个容器位（`.0` 网络 / `.1` 网关 / 末位广播，topology.md §3） |
| `gateway` | 该网络 `.1`（宿主 bridge 端点；Traefik 走 host 网络经此可达容器） |
| `pool` | `default`（`10.200.0.0/16`）或 `large`（`10.201.0.0/16`）；两段**保留给 FDE 网络专用**（topology.md §2/§3）。**池范围 ≠ 放行范围**：放行/来源规则按 `subnet` 精确派生（topology.md §5.1） |
| `state` | 状态机见 §2.6 |
| `revision` | 预留的网络聚合版本号（暂无 network 聚合 outbox 行；若将来引入网络相关派生发布，按 `route_revisions` 的 head 模式成对使用）；**与 `route_revisions.revision` 不可混用** |

**复用语义**：`subnet` 为**全局唯一**（非部分索引）——offboarding 后 `state → released`，块可复用，但复用前需由 portal 先**腾出该行**（`DELETE` 已释放记录，或将其 `subnet` 改指新块；历史归属由 `audit_log` 的 `network.allocate` / `network.release` 承载）再分配给新 `fde_id`。已建网络子网不可改 → 扩容 = 重建网络（数据在 bind mount，容器是牲口）。

### 1.18 `route_outbox` — 路由发布 outbox（issue #9）

| 关键字段 | 语义 |
|---|---|
| `aggregate` / `aggregate_id` | 聚合类型与实例 id（如 `port_allocation` / `port_allocations.id`、`llm_binding` / `fde_llm_bindings.fde_id`） |
| `op` | `upsert` / `delete`；`delete` 用 **tombstone**（revision 递增 + op=delete，不物理删行） |
| `revision` | 聚合内单调递增版本；`UNIQUE(aggregate, aggregate_id, revision)` 保证同一聚合同一版本至多一条（重试/重复投递安全）；**单调性由 `route_revisions`（每聚合版本 head）保证**，reconciler 只发布 revision = 当前 head 的行 |
| `payload` | 生成该路由所需的全部事实快照（hostname/url/backend IP 等），随 revision 固化 |
| `state` | 状态机见 §2.5 |
| `attempts` / `last_error` | 发布重试计数与最近失败原因 |
| `claimed_at` / `lease_until` / `worker_id` | `processing` 租约字段：领取时刻 / 到期时刻（lease 60s ⚠️）/ worker 标识；到期未完成由 reaper 回收为 `pending`（attempts+1，§2.5） |

**语义**：portal 在 DB 事务里写 desired state（`port_allocations` / `fde_llm_bindings`）+ 本表一行，并在**同一事务**内 `SELECT ... FOR UPDATE` 递增 `route_revisions.revision`；**Traefik file provider 是异步幂等派生状态**（PG 事务无法含文件写入）。`delete` 用 tombstone；启动时从 DB 全量重建路由（幂等）；reconciler 消费 outbox 并做 debounce/批量合并、临时文件校验后原子替换（topology.md §8）。`route_revisions` 是「每聚合版本 head」（`PRIMARY KEY(aggregate, aggregate_id)`）；`route_outbox.(aggregate, aggregate_id, revision)` 与其同键空间关联（非外键：outbox 是追加历史，head 只存当前最大版本）。

### 1.19 `tool_outputs` — 工具结果全文另存（topology.md §9）

| 关键字段 | 语义 |
|---|---|
| `run_id` / `tool_call_id` | 归属 run 与工具调用；`tool_call_id` 为**外部 `call_id`**（对齐 `tool_calls.call_id`），复合外键 `(run_id, tool_call_id) REFERENCES tool_calls (run_id, call_id)`；`UNIQUE(run_id, tool_call_id)` |
| `bytes` / `sha256` | 字节数与 sha256（阈值判定、配额、digest 校验/去重） |
| `body` | 工具结果全文；**超过阈值才另存**——事件里只放 `result_digest` + 引用（`tool_outputs.id`），避免打爆 `run_events` |

> **`tool_call_id` canonical 规则（`tool_outputs` / `approvals` 一致）**：外部 ID = `tool_calls.call_id`（事件流 `tool_use`/`tool_result`/`tool_call_delta` 的 `tool_call_id`，字符串如 `tc_301`）；`tool_calls.id` 是**内部主键（uuid），不外露、不进 API 载荷**。两表都以复合外键 `(run_id, tool_call_id) REFERENCES tool_calls (run_id, call_id)` 关联（`tool_calls` 有 `UNIQUE(run_id, call_id)`）。
> ⚠️ **审批契约（issue #10）**：超时语义已定稿（`pending → expired`，由 portal 打标，topology.md §4-L6）；`tool_call_id` 是否改判为 UUID 仍待 #10 确认——若改判则同步 `approvals` / `tool_outputs` 两表。

### 1.20 `fde_llm_bindings` — FDE ↔ LiteLLM 虚拟 key 绑定（规格 §11.3，migration 0010）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，主键：每 FDE 一行 |
| `gateway` / `gateway_user_id` | 固定为 `litellm`；LiteLLM user id 用于同一 FDE 后续轮换 key 时复用用户 |
| `key_id` / `key_alias` | LiteLLM key id 与业务别名 `fde-<fde_name>`，供用量对账映射 |
| `state` / `generation` | 状态机见 §2.7；`generation` 为虚拟 key 代次（轮换 +1，旧 key 在 LiteLLM 删除） |
| `revoked_at` / `rotated_at` | 吊销/轮换时刻 |
| `provider_id` | LiteLLM credential 名称（兼容旧列名；无本地表外键） |
| `api_key` | LiteLLM per-FDE 虚拟 key 明文，供 portal 注入 Traefik；上游凭据仅存在 LiteLLM credential。`NULL` = 未配置 |
| `main_model_id` / `embedding_model_id` / `vision_model_id` | LiteLLM `model_info.id` 字符串（`text`，无外键）；`main` 必须是未 block、支持 `tool_calling` 的文本模型，由应用层校验 |
| `main_model_name` / `embedding_model_name` / `vision_model_name` | 对应 LiteLLM `model_name`（数据面请求体使用的别名）；与 `model_info.id` 分开保存，因为二者不是同一标识 |
| `budget_usd` / `budget_period` | 每个 FDE 的「周期 LLM 额度（USD / 周期）」（迁移 `0047`，issue #719；由旧 `daily_budget_usd` 改造成金额+周期两列）。`budget_usd` = `numeric(12,6)` **可空、无默认**：`NULL` = 该 FDE 不限额（≠ 0，0 会被 LiteLLM 当「一分钱都不能花」全拒）；下发到 key 的 `max_budget`，key 重铸时从此列恢复（不变式 3，DB 是真相 / key 是牲口）。`budget_period` = `text` 枚举 `CHECK (budget_period IN ('1d','1mo'))`（`1d` 每天本地零点重置、`1mo` 每月 1 日重置；只原样透传 LiteLLM `budget_duration`，portal 绝不自算周期）。**成对 NULL CHECK**（约束名 `fde_llm_bindings_budget_pair_null_check`）：`CHECK ((budget_usd IS NULL) = (budget_period IS NULL))`，金额与周期同生同灭，杜绝「有金额没周期」的半吊子 |

**凭据边界（issue #117 phase 2）**：上游 API key 与 `api_base` 由 LiteLLM credential 管理；Station 只存 LiteLLM 虚拟 key，不把上游明文复制进自身 DB。虚拟 key 只由 portal 用于 Traefik 动态配置（文件 mode 600），容器不持有；管理 API 回显掩码，日志/审计/错误信息不含 key。`llm_providers` 与 `llm_models` 在 migration 0010 中改名为 `llm_providers_retired` / `llm_models_retired` 留作回滚与人工核对；**这两张退役表已由 migration `0032` 撤除（issue #503）**，口径见下一段。

**已撤的退役表（migration `0032`，issue #503）**：`llm_models_retired` / `llm_providers_retired`（0002 建为 `llm_models` / `llm_providers`，0010 改名保留）与 `transcript_rounds_shape4_bak_20261027`（2026-10-27 shape4 修数据的手工备份夹具，**不在任何迁移里**，见 `docs/ops/transcript-ledger-inspection.md` §7）三张表已由 `0032-drop-retired-tables.sql` 撤除。**代码零引用**（`grep -rn "llm_providers_retired\|llm_models_retired\|shape4_bak" portal runner scripts` 只命中 `portal/test/migrations.test.js` 里断言 **0010 文件文本** 的两条）+ **DB 零访问**（PG 自己记的 `last_idx_scan` 停在 0010 改名那天）两条判据都成立才撤；后者是**每库自己的**统计，其它部署撤前自己跑一遍（SQL 在迁移头注释里）。⚠ **这是单向门**：撤后「重放 0010 那条 `RENAME` 把旧目录要回来」这条路就没了，旧供应商行 / 模型目录行 / shape4 那次的 `record_before` 原件**只能从 dump 恢复** ⇒ 撤前必须 `pg_dump` 这三张表并落到部署记录。读侧无影响：模型目录的真相在 LiteLLM，本表只存 `model_info.id` / `model_name` / 虚拟 key（无外键）。

**退役表留下的枚举字面量（`check:doc-impl` 的 schema 轴会抖到它们，#777 A5 显式登记）**：上面两张已撤的表在迁移面留下了两个 `CHECK`，**库里已不存在、但字面量仍是活的口径**：

| 退役 `CHECK` | 取值 | 当前实现里的同一口径 |
|---|---|---|
| `llm_providers.api_format`（`0002-llm-config.sql:23`，`NOT NULL DEFAULT 'openai'`）| **只有一个值** `openai` | 同名硬编码仍在：`portal/src/llm.js` 的 `toProvider()` 把每个 credential 的 `api_format` 写成字面量 `'openai'`（上游格式不再入库，所以它只能是常量）——口径见 portal.md §4.9-1 |
| `llm_models.type`（`0002-llm-config.sql:35`）| `text` / `embedding` / `vision` / `rerank` / `audio-tts` / `audio-stt` / `image-gen`（七值）| **七值逐字仍在用**：`portal/src/llm.js` 的 `LLM_MODEL_TYPES` 就是这七项，`typeToMode()` 把它们映到 LiteLLM 的 `chat` / `embedding` / `rerank` / `audio_speech` / `audio_transcription` / `image_generation`（反向映射在 `modelType`（`portal/src/llm.js:119-128`，按显式 `type` → mode 回退 → 缺省 `text`），如 `mode === 'image_generation' → image-gen`）——**表已撤，分类口径没撤**，它现在是「portal 给模型打的能力类型标签」，不是库约束 |

> 这两行是**历史事实 + 当前实现**的对账，不是「补回旧表」：库里不会再出现 `llm_providers` / `llm_models`（**两路证据**：迁移链 `0010-litellm-bindings.sql:26-27` 把它们改名为 `*_retired`、`0032-drop-retired-tables.sql:52,55` 再 `DROP`；**实查 catalog** `select tablename from pg_tables where tablename like 'llm%'` ⇒ **0 行**，同一条查询里只剩 `macro_*` 三张），`api_format` 与 `type` 也**不是** `fde_llm_bindings` 的列（本表只有 `provider_id` 与三个 `*_model_id` / `*_model_name`，见上面 §1.20 字段表）。旧目录行本身只能从 dump 恢复（上一段的单向门）。

**运行中变更守卫**：`PUT /api/admin/fdes/:name/llm` 在活跃 run（queued/running/cancelling）期间若改变 credential 或任一模型槽（该槽变化会轮换 LiteLLM key 白名单），返回 `409 active_run_conflict`；管理员显式传 `force: true` 才放行。相同 binding 为幂等重试，不重复铸 key 或写 outbox。上游 API key 不能经 FDE binding API 提交，需在 LiteLLM credential 管理入口更新。

### 1.21 `preview_grants` — 预览授权凭证（portal.md §2.7/§2.8）

forwardAuth 按「预览 token 的哈希」查本表解析 `user_id` 后做 exposure 判定（**不解析 `cookie.sub`，旧口径作废**）；portal 自身会话的登录态才查 `login_sessions`（§1.2），与本表互不相干。两种凭证：`kind='ticket'`（一次性预览 ticket）与 `kind='session'`（host-only 预览 cookie）。

| 关键字段 | 语义 |
|---|---|
| `token_hash` | 唯一；`sha256(token)`，不存明文（与 `login_sessions.token_hash` 同口径） |
| `user_id` / `allocation_id` | 凭证**主体（被授权访问的身份）**与目标 allocation（`allocation_id → port_allocations.id`）；`user_id` 是 exposure 判定身份（≠ 签发者，见 `issuer_id`） |
| `issuer_id` | ticket 的**签发者**（登录用户，`→ users.id`）；session 为系统派生、**可空**（portal.md §2.7/§2.8 B4）。普通 FDE 自签 = issuer = subject = owner；admin 代签他人 private = subject = admin、issuer = admin |
| `parent_ticket_id` | ticket→session 关联（`→ preview_grants.id` 自引用，**可空**）：session 行指向派生它的 ticket；ticket 行为 `NULL`。安全重放分支按 `parent_ticket_id=$ticket_id` 查派生 session（portal.md §2.7 第 6 步） |
| `kind` | `ticket`（一次性）/ `session`（host-only 预览 cookie，滚动续期） |
| `state` | `active / used / revoked / expired`（状态机见 §2.4）；`used` 仅 ticket 有（`CHECK (kind='session') = (used_at IS NULL)`） |
| `expires_at` | TTL 截止时刻：ticket **60s** ⚠️、session **15min** ⚠️ 滚动（portal.md §2.8） |
| `used_at` | ticket 首次校验同事务原子置位（单次有效，重放 → `403 preview_ticket_used`） |
| `revoked_at` | 显式吊销 / allocation `released` / 用户 `disabled`（portal.md §2.8/§2.9.3）/ **签发会话登出（#429，按 `login_session_id` 血缘回收，§2.4）** |
| `last_seen_at` | session 最近一次校验通过（滚动续期刷新） |
| `login_session_id` | **凭证血缘（#429，migration 0025）**：签发该凭证的登录会话（`→ login_sessions.id`，`ON DELETE SET NULL`，可空不回填）；ticket 行签发时写入，session 行兑换时继承 ticket 的值。登出撤销沿此列命中（portal.md §2.4）；列缺失（存量行）= 登出救不了，靠 TTL 自然到期 |

**与 allocation 释放的联动**：allocation 为软删除（`state → released`），释放事务由 portal 应用层**同事务**把该 allocation 的 `active` 凭证置 `revoked`；forwardAuth 每请求重查 allocation `state` 双保险（portal.md §2.8）。外键为普通引用（无级联）：物理删除 allocation（reaper 硬删 released 过期行，§4）前须先清空引用它的本表行（grant reaper 先删过期/已吊销/已消耗行，或显式按 `allocation_id` 删）。`expired` 由 reaper 周期性懒打标；forwardAuth 有效性判定同时查 `state` 与 `expires_at > now()`（打标前窗口仍拒绝，双保险）。

### 1.22 `materialize_revisions` / `materialize_outbox` — 用户空间物化 outbox（A7 定稿）

与 `route_outbox`/`route_revisions` 同构但**独立成表**（不复用 `route_outbox`，避免与路由 reconciler 争抢同一行/同一租约/同一键空间）。聚合键 = **FDE**（`fde_id` = `users.id`），详见 user-space.md §7.1 与 schema.sql §9。

| 关键字段 | 语义 |
|---|---|
| `materialize_revisions.fde_id` | 主键：每 FDE 一个版本 head |
| `materialize_revisions.revision` | 该 FDE 物化版本 head，单调递增 |
| `materialize_outbox.fde_id` / `revision` | 聚合键与版本；`UNIQUE(fde_id, revision)`（同 FDE 同版本至多一条） |
| `materialize_outbox.op` | `upsert` / `delete`；`delete` 用 tombstone（revision 递增 + op=delete，不物理删行） |
| `materialize_outbox.state` | `pending / processing / published / failed`（状态机同 `route_outbox`，§2.5 语义同构） |
| `materialize_outbox.attempts` / `lease_until` / `worker_id` | 物化租约与重试：领取 `pending→processing` 写 `claimed_at/lease_until/worker_id`；成功 `published`；失败 `attempts+1` 退回 `pending` 退避重试；耗尽 `failed`+告警；崩溃恢复由 reaper 回收过期 `processing` |

**消费语义（快照隔离 + 同 FDE 串行 + latest-wins）**：materializer 只领取 `revision = materialize_revisions.revision`（head）的行（`FOR UPDATE SKIP LOCKED`）；渲染以**当前 DB desired state 重读**为唯一输入（纯函数，不依赖 payload 增量），因此每个 FDE 同时只有一个 head 被领取 → 同 FDE 并发物化天然串行；`revision < head` 的晚到旧事件/旧 tombstone 一律丢弃（latest-wins）。已删除文件（项目删除 → 该项目 `ports.json`/`.erix/AGENTS.md`/`.gitignore` 等）由 materializer 在消费时落盘清理（user-space.md §7.1）。

### 1.23 `schema_migrations` — 迁移台账（A6 定稿）

`version text PK` / `checksum text NOT NULL` / `applied_at timestamptz NOT NULL DEFAULT now()`（deploy-contract.md §3）。本文件（schema.sql）即 baseline，记录 `version='0000_baseline'`；baseline 的 checksum 由迁移 runner 在应用后写入真实 sha256（文件无法包含自身哈希，哨兵值见 schema.sql §10）。写入方 = 迁移 runner（`station_platform`）；读取方 = portal readiness（`station_portal` 只读本表，判「迁移到 head」——对比实际 migration head：baseline + `deploy/migrations/*.sql` 全部版本）。

### 1.24 `login_pending` — 两步登录第一步的待决令牌（portal.md §2.2）

口令校验成功后**仅**发短期 `pending_token`（默认 120s、单次消费），**不发 cookie**；`/api/auth/login/totp` 校验 TOTP 成功后才建立 `login_sessions` 并下发 session cookie。

| 关键字段 | 语义 |
|---|---|
| `token_hash` | `sha256(pending_token)`，唯一；**只存哈希不存原文**（与 `login_sessions.token_hash` 同口径） |
| `user_id` | 绑定用户（`→ users.id`）；令牌不能跨用户使用 |
| `expires_at` | 短期 TTL（默认 120s）；过期后消费失败 → `401 pending_expired` |
| `used_at` | 单次消费标记：原子 `UPDATE ... SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()`，影响 0 行 = 过期/已用/不存在 |
| `created_ip` / `created_ua` | 签发来源（审计/排障） |

写入方 = portal（登录第一步）；消费方 = portal（登录第二步，单次原子消费）。

### 1.25 `idempotency_keys` — 写操作幂等键台账（portal.md §1.4）

> **来源：增量迁移 [`deploy/migrations/0001-idempotency-keys.sql`](../../deploy/migrations/0001-idempotency-keys.sql)（唯一来源）**。
> baseline `docs/data/schema.sql` 自 P1 冻结、**不包含本表**（改 baseline 会破坏 `0000_baseline` 的 checksum，见 deploy-contract §3.3）。
> 即：新库不会从 baseline 得到本表，必须应用迁移（`cli.js migrate` / `MIGRATE_ON_START=1`）。

POST 写端点的可选 `Idempotency-Key` 去重：同 `(user_id, endpoint, key)` 重复提交返回**首次结果**，不产生重复副作用（当前唯一使用者 `POST /api/sessions/:id/messages`，防断网重发产生两条 user 消息）。

| 关键字段 | 语义 |
|---|---|
| `PRIMARY KEY (user_id, endpoint, key)` | 幂等键空间：按用户 + **具体端点（含路径参数）** + 客户端 key 隔离（同 key 跨 session 不串号） |
| `request_hash` | 规范化请求体（`content` + `attachments[{kind,path,name}]`）的 `sha256`；命中且不一致 → `409 idempotency_key_reuse`（不重复执行副作用） |
| `state` | `'in_progress'` 占位行 → 完成行 `'done'`（默认）。**先占位后执行**：并发同 key 只有一个请求能占到占位；`in_progress` 超过 5 分钟（`IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES`）视为持有者崩溃残留，可被后续请求 UPDATE 抢回（否则该 key 被一次崩溃永久钉死） |
| `claim_token` | **owner fencing** 标识：占位/抢回时写入 `crypto.randomUUID()`（抢占回会改写它）。台账转 `done`、补记与释放一律带 `AND claim_token = $` 条件，故被抢回的旧持有者的迟到写入一律 0 行（旧持有者 `record` 命中 0 行 → `409 idempotency_conflict`，其业务事务回滚）。`done` 行保留最后一次占位的值 |
| `status_code` / `response` | 首次响应的状态码与响应体，回放时原样返回（`POST .../messages` = `202`）；**占位行为 NULL**（结果尚未产生，回放只读 `done` 行，故不会回放出占位态）。写入时机：与业务写入**同事务**（fn 在自身事务内调 `record(client, …)`，portal.md §1.4），故没有「有台账无业务写入」的窗口 |
| `created_at` | 双用途：① TTL 基准——命中判定带 `created_at > now() - interval '24 hours'`；② `in_progress` 陈旧判定基准。过期行由 portal reaper 低频（≈1h）物理 `DELETE`（`idempotency.js` `purgeExpired`）；`idempotency_keys_created_idx` 供该扫描 |

并发同 key（先到先得）：占位期间（< 5 分钟）的后续请求 → `409 idempotency_conflict`（`retryable: true`，**不执行** fn）；执行抛错 → 删除占位行释放 key；首执行完成后重发 → 回放首次结果。**记账与业务写入同事务**（fn 事务内 `record()`）→ 同 key 至多一次副作用；未接入 `record` 的调用方退回「业务提交后补记」路径（仍有残留窗口，portal.md §1.4）。写入方 = portal（HTTP 层包装，`portal/src/idempotency.js`）；读取方 = 同样只读本表命中判定（无其它消费者，不参与 SSE/状态机）。

### 1.26 `git_hosts` — Git host 注册表（issue #118）

来源为 [`deploy/migrations/0011-git-hosts.sql`](../../deploy/migrations/0011-git-hosts.sql)，baseline 冻结、不回写 `schema.sql`。

| 关键字段 | 语义 |
|---|---|
| `provider` | 支持 `gitea` / `github` / `gitlab`；CHECK 保留 `azure`，但当前 portal API 明确拒绝创建 Azure host |
| `base_url` | Git 服务 API 根地址；仅接受无 URL 凭据、查询与片段的 `http(s)` URL |
| `admin_key` | 可选管理凭据。只对 Gitea/GitLab 用于代建账号与铸 token；API 仅掩码回显、不进日志/审计。`CHECK ((mode='minted') = (admin_key IS NOT NULL))` 保证 key 与 mode 一致 |
| `mode` | 应用按 provider 能力与 admin key 自动计算：支持代铸且有 key → `minted`；否则 `per_fde_pat` |
| `enabled` | 禁用 host 后不可用于新的 FDE provisioning；已有绑定保留 |

### 1.27 `fde_git_accounts` — FDE 与远端 Git 账号绑定（issue #118）

每个 FDE 最多绑定一个注册 host；删除 host 前检查本表引用。`token_ref` 是远端 token ID（吊销用），不是 token 内容；`remote_login` 只记远端用户名。`per_fde_pat` 等待管理员设置凭据时两者可空；PAT 内容仅写入 FDE 用户空间 `.git-credentials`，绝不落数据库。设置匹配 host 的凭据后用户状态从 `awaiting_credential` 恢复 `active`。

### 1.28 `fde_offboarding` — FDE 下线任务（issue #110）

由 `deploy/migrations/0013-offboarding.sql` 增量创建；不设到 `users` 的外键。用户行与 offboarding 记录永久保留，便于长期审计。

| 关键字段 | 语义 |
|---|---|
| `fde_id` / `fde_name` | 被下线用户的稳定 ID 与名称快照；workspace sweep 只使用已完成任务中的名称并经真实路径校验 |
| `state` / `steps` | `pending → running → done` 或 `failed`；JSONB 保存各个幂等步骤状态，管理员 retry 只重置失败步骤 |
| `attempt` / `last_error` | 每次 claim 增加尝试次数；最近失败原因用于管理台排障 |
| `workspace_purge_after` | `ERIX_WORKSPACE_RETENTION_DAYS=0`（默认）时保持 `NULL`；显式正数才设置到期时间。到期 sweep 只删 workspace 目录，用户、Git 绑定、此任务及其他 DB 行均永久保留 |

### 1.29 `queued_inputs` — 运行中说的话（issue #370，migration 0024）

任务在跑时用户照常说话，话先进这里，**不进 `messages`、不进 `transcript_rounds`**。

| 关键字段 | 语义 |
|---|---|
| `kind` | `steer`（**转向**：当前轮跑完就停下，用这句话继续）\| `follow_up`（**排队**：当前任务正常结束后按顺序发）。就这两个值，CHECK 钉死 |
| `status` | `pending → delivering → delivered`；`pending → recalled`（用户整队取回）；`discarded`（预留位，当前实现不 discard）。**`delivering` 不是装饰**：认领与建 run 跨两次提交（`postMessage` 自开事务并锁 `chat_sessions`，同事务内调它会自锁），中间必须有一个「已被认领」的可见状态，否则并发终态出队会把同一条投两次。`delivering → delivered` 那一次推 `queue_update` 额外带 `delivered_run_id`（portal.md §5.3 第 17 类）——那是前端知道「有一个它没亲手发出去的 run」的**唯一推送路径**（它平时只能从 POST 响应或会话详情得知活跃 run，队列投递两条都不经过）|
| `position` | `bigserial`——FIFO 的真相。不用 `now()`：同毫秒入队也要有确定先后，且不依赖时钟 |
| `interrupted_run_id` | 仅 `steer`：它入队时**打断**的那个 run。**「这次 abort 是转向还是用户按了停止」的唯一判据**——所以 run 状态机零改动（不新增 status、不新增 termination reason），判定完全落在队列侧 |
| `run_id` | 投递成功后它触发的那个 run |
| `claimed_at` | 进入 `delivering` 的时刻。**过期（`CLAIM_STALE_MS` = 60s，服务端 `make_interval` 换算）可被重新认领**——判据同时写在出队扫描的 pick 与认领 CAS 两条语句里（两处必须同判据，否则「选得出来却永远抢不到」）。这条判据的存在理由：认领与建 run 跨两次提交，中间崩一次那行就停在 `delivering`——既不投递、也取不回（`recall` 只动 `pending`）、还算在 20 条上限里，界面上毫无线索。**判据在 SQL 里，单测的假池自己实现了一份同判据的 JS ⇒ 行为测试测不到它**，故另有源码级断言（`queued-inputs-wiring.test.js`；变异「pick 改回只认 pending」实测必须红，前例见 #331 那根死光纤）|

**为什么落 DB 而不是照抄 pi 的内存队列**（`pi-agent-core` `Agent.steeringQueue`）：pi 的队列随进程消失（其自身注释："dead wrapper (no state) means the queue is gone"），而本站不变式 3「DB 是状态真相」+ 容器是牲口 ⇒ 用户打进来的话不能随进程或页面消失。实测症状：关页面 = 那句话蒸发；容器重启 = 排好的队全没了。

**红线**：入队**只写本表**。提前写 `messages` 会破坏 #77 P3 PR②b B2 的「`messages` = 纯锚点行」；提前 `appendUserInputTurn` 更糟——**还没说出口的话**就进了模型上下文，并被读侧渲染成已发送。投递时才走 `postMessage` 那条唯一发送路（#261B）。

**投递判定**（`drainQueuedInputs`，由 run 终态的**五处**产出点驱动，漏一处即队列卡死）：队头是 `steer` ⇒ 无条件投；队头是 `follow_up` 且正常终态（`end_turn` / `no_tool` / `judge_done`）⇒ 投；`follow_up` + `aborted` 且**存在 `kind='steer' AND interrupted_run_id = 本 run`** ⇒ 投（用户意图就是接着说）；其余（用户按停止 / `failed` / `persistence_failed` / `max_rounds_cap`…）⇒ **不投，留在队列**——别把排队的话烧在一个坏 run 上。另加容器存活闸门：容器不在 ⇒ 不投、**不丢**，快照带 `blocked='container_not_running'` 让界面说清「为什么还没发」。

### 1.30 `login_email_codes` — 登录第二因素「邮箱验证码」（issue #449，migration 0026）

> **来源：增量迁移 [`deploy/migrations/0026-login-email-codes.sql`](../../deploy/migrations/0026-login-email-codes.sql)（唯一来源）**。
> baseline `docs/data/schema.sql` 冻结、**不含本表**（改 baseline 会破坏 `0000_baseline` 的 checksum，见 deploy-contract §3.3）。

TOTP 是 opt-in（`users.totp_secret` 为空即跳过第二因素），而现网账号都没注册 TOTP ⇒ 登录实际只有口令一层。本表给「未注册 TOTP」的账号补第二层：口令通过后发一枚 6 位邮箱验证码（portal.md §2.3a），校验通过才建 `login_sessions`。**一行一枚码**；同一 `pending_token` 下「最新一条未消费」才是当前有效码。**一枚码在同一时刻只服务一个 pending**：窗口内重复口令步（#737）不铸新码、不再发信，而是把旧码的 `code_hash` 逐字复制挂到新建的 pending 上（= 插新行 + 立即 `consumed_at` 废旧行）；`expires_at` 与 `attempts` **随码走、不随 pending 续命/刷新**（反复登录不许把码的寿命无限延长，尝试预算也不因复用而翻倍）。

| 关键字段 | 语义 |
|---|---|
| `pending_token_hash` | `sha256(pending_token)`，与 `login_pending.token_hash` 同值（**不建 FK**：`login_pending` 行会随会话建立被消费/过期，验证码行要留作审计证据） |
| `code_hash` | `sha256(6 位数字码)` hex——**只存哈希，绝不存明文**；审计只记前 12 位（`code_hash_prefix`） |
| `created_at` / `expires_at` | 发码时刻与 TTL（默认 600s，`EMAIL_CODE_TTL_SECONDS`）。校验与成功消费都带 `expires_at > now` 谓词。**行只在「发信成功之后」才插入**（发信失败 ⇒ 零行，失败重试不受重发冷却约束） |
| `attempts` / `max_attempts` | 单码校验失败计数与上限（默认 5，`EMAIL_CODE_MAX_ATTEMPTS`）。**码错只累加 attempts、不烧 `pending_token`**；`attempts + 1 >= max_attempts` 时同一条语句写 `consumed_at` 作废 |
| `resend_count` | 同一 `pending_token` 的累计重发次数（上限默认 3，`EMAIL_CODE_MAX_RESENDS`）；冷却默认 60s（`EMAIL_CODE_RESEND_COOLDOWN_SECONDS`）按「最近一条的 `created_at`」算 |
| `consumed_at` | 单次消费标记：**成功校验**（原子 `UPDATE … RETURNING id`）、**重发时作废旧码**、**尝试次数用尽**三处写它。`NULL` = 仍可能有效 |
| `created_ip` / `created_ua` | 签发来源（审计/排障），与 `login_pending` 同口径 |

索引：`login_email_codes_pending_idx (pending_token_hash, created_at DESC)` —— 读路径只有两条（取最新未消费 / 取最新一条算冷却），都按 pending 定位。

写入方 = portal（登录第一步发码、§2.3b 重发）；读取/消费方 = portal（登录第二步）。**没有第二个消费者**（不参与 SSE、不影响任何状态机）。

### 1.31 `mail_settings` — 邮件通道配置（issue #449，migration 0026，单行表）

> 同上：来自增量迁移 `0026-login-email-codes.sql`；baseline 冻结、不回写 `schema.sql`。

**为什么落 DB 而不是 env**：SMTP 主机/凭据/发件人是运维日常要改的东西（改 env 要重建容器），且口令进 env 会跟着 compose 文件与进程环境扩散。读取侧 `portal/src/mail-provider.js`：读一行 + 60s 缓存；**读取失败降级为「未启用」+ warn**（登录 fail-open 到纯口令，绝不把整站锁死）。

| 关键字段 | 语义 |
|---|---|
| `id` | 恒 `1`（`CHECK (id = 1)`）：用约束把「只能有一行」写成 DB 事实，不靠应用自觉 |
| `transport` | `'disabled'`（默认）\| `'smtp'`；非 `smtp` 一律不发信 |
| `smtp_host` / `smtp_port` / `smtp_secure` | relay 地址与端口；`secure=true` = implicit TLS（465 形态），否则 STARTTLS |
| `smtp_user` / `smtp_password` | **都可空**（内网 relay 常按来源 IP 放行、不需要认证）。口令是**明文列**：目标是内网 email relay，口令非高价值，与 `git_hosts.admin_key`（migration 0011）同一口径；**API / 审计 / 日志永不返回口令明文**。将来换成公网 SMTP 再上加密列（另开迁移） |
| `smtp_from` | 发件人。`transport='smtp'` 时与 `smtp_host` 一起被 CHECK 强制非空（半套配置不许落库） |
| `connection_timeout_ms` / `greeting_timeout_ms` / `socket_timeout_ms` | 三档超时（默认 10000 / 10000 / 20000），直接映射到 nodemailer 同名选项 |
| `updated_at` / `updated_by` | 最后修改时刻与管理员 id（**不建 FK**：删用户不该被配置行拦住；审计靠 `updated_at` + 日志） |

写入方 = 管理台 API（`GET/PUT /api/admin/mail/settings` + `POST /api/admin/mail/test`，已交付：`portal/src/mail-settings.js`，契约 `docs/api/portal.md` §4.12；落库后调 `mailerProvider.invalidate()` 让 60s 缓存立刻失效）；读取方 = portal 登录发信路径（`mail-provider.js`，60s TTL）。运维急停：`MAIL_TRANSPORT=disabled`（env），为真时**不读本表**、一律不发信。

### 1.32 `tls_certificates` — 管理台证书的审计/历史（issue #456，migration 0027）

> 同上：来自增量迁移 `0027-tls-certificates.sql`；baseline 冻结、不回写 `schema.sql`。

⚠ **本表不是真相源**：当前生效的证书是**盘上的文件**（`<TRAEFIK_DYNAMIC_DIR_HOST>/certs/tls.{crt,key}`），Traefik 只认文件。本表只回答「谁在什么时候装了什么」，用于历史与排查；与盘不一致时**以盘为准**（`GET /api/admin/tls` 就是读盘拼的 DTO）。

**为什么私钥不在这里**：私钥只落盘（mode 600、属主 = Traefik 进程 uid），不进 DB / 日志 / 审计 / 响应（#456 红线）。所以本表**没有任何 PEM 列**（单测 `portal/test/migrations.test.js` 的 0027 用例逐列钉住）。

| 关键字段 | 语义 |
|---|---|
| `subject_cn` / `sans` / `issuer_cn` | 叶子证书的主体 CN、SAN 里的 DNS 名（`text[]`）、签发者 CN。CN 可空（现代证书允许只有 SAN） |
| `not_before` / `not_after` | 有效期（从证书里读，不是上传时刻） |
| `fingerprint_sha256` | **冒号分隔大写**，与 Node `X509Certificate.fingerprint256` / `getPeerCertificate().fingerprint256` 同形 ⇒ 「盘上证书 == 真机握手 == 台账」三者可直接逐字符比对 |
| `kind` | `'upload'`（上传/更新）\| `'rollback'`（回滚到 `certs/prev/`）。CHECK 钉住两态，别让第三种来源悄悄进来 |
| `uploaded_by` | 操作的管理员（`ON DELETE SET NULL`：删用户要留历史行，也不能撞 FK） |
| `uploaded_at` | 落台账时刻；索引 `tls_certificates_uploaded_at_idx (uploaded_at DESC)` 对「最近装了什么」 |

写入方 = 管理台 API（`PUT /api/admin/tls` → `kind='upload'`；`POST /api/admin/tls/rollback` → `kind='rollback'`，`portal/src/tls-cert.js#recordCertificateRow`）；读取方 = 目前**只有运维/历史查询**（产品侧 GET 读盘，不读本表）。

---

### 1.33 `macro_templates` / `macro_assignments` / `macro_runs` — 事件平台的三张表（issue #524，migration 0035）

> 同上：来自增量迁移 `0035-macro-platform.sql`；baseline 冻结、不回写 `schema.sql`。
> **数据层现状**：`portal/src/macros.js` 是宏三表的写入口；没有定时器、没有调度器（「到点主动执行」是 W2，仍未做）。⚠ 早期记「没有面板路由 / `notifications` 落地面是 W3」**已过时**：`notifications` 表由迁移 `0037` **已建**，`portal/src/http.js` 已提供通知读 API（`GET /api/notifications`、`/api/notifications/unread-count`、`/api/notifications/:id/read`，走 `macroRoutes.notifications*`）。⚠ 这只等于「通知表 + 读侧 API 已落地」，**不等于通知调度/派发全量实现**（主动生成与推送仍属未做部分）。

**为什么是三张而不是一张**：模板可被多人复用、订阅要能改人/改范围、执行记录要能永久审计——
三者的生命周期与写入者完全不同（管理员改模板 / 用户改订阅 / 调度器只追加账）。
落 DB 而不是进程内存的理由同不变式 3（DB 是状态真相）+ 不变式 4（容器是牲口）：
调度器进程随时可死可换，只要这三张表在，重启后照样能接着认领、接着记账。

| 表 | 语义 | 幂等键 / 关键约束 |
|---|---|---|
| `macro_templates` | **做什么**：`kind`（四类：`run-notify` / `run-silence-alert` / `run-review` / `scheduled-task`）+ `name` + `params`（jsonb：四类参数集互不相交，散列成列会让每列只对一类有意义）+ `audience`（`all` / `admin`）+ `scope`（`session` / `user`）+ `enabled` + `created_by`（可空：内置模板没有创建人）+ `deleted_at`（软删） | `CHECK` 钉住 `kind` / `audience` / `scope`；`name` 不许空白 |
| `macro_assignments` | **给谁做、在哪个范围、到什么时候**：`template_id` + `user_id` + `session_id`（`scope='session'` 才给）+ `cwd`（限定项目目录；v0.1.x 写的是「限定 worktree」，D8 修订后 cwd = `~/projects/<name>`。NULL = 不限）+ `until`（到期时刻）+ `enabled` + `last_evaluated_at`（W2 的「多久没被看过」判据） | `UNIQUE NULLS NOT DISTINCT (template_id, user_id, session_id, cwd)`（PG15+）。**这一条是「重复订阅」的唯一防线**：默认 UNIQUE 语义下 NULL 互不相等 ⇒ `scope='user'`（两列都是 NULL）能被同一人订无数次。`template_id` → `ON DELETE CASCADE` |
| `macro_runs` | **做没做、结果如何**（执行账，只追加）：`anchor`（触发它的事件标识）+ `bucket`（去重桶）+ **`criterion`（哪条判据叫起来的：`terminal` / `silent` / `tick` / `mechanical` / `semantic`，写完不变）** + **`status`（生命周期：`pending` → `running` → `done`/`failed`，或 `skipped` / `superseded`，会推进）** + `verdict`/`verdict_raw`（归一化口径 vs 模型原话，分开存才能改了口径后重算）+ `reason` / `remediation_text` + `skipped_reason`（九种门禁穷举，含 `review_unavailable`，见 §2.4）+ `started_at`/`finished_at` + `child_session_id`/`child_run_id`（宏真跑起来时派生的会话与 run，`ON DELETE SET NULL`：会话被清理时账要留着）+ `depth`/`parent_macro_run_id`（挡无限自我派生）+ `snapshot_id`/`worktree_path`（现场引用，**故意不建 FK**：快照是可回收物，SET NULL 会把审计链切断。**#690 起两列不再写入**，只有历史数据，审查改读活目录 ⇒ [`../design/event-platform/08-watch-and-review.md`](../design/event-platform/08-watch-and-review.md) §5.1） | `UNIQUE (assignment_id, anchor, criterion, bucket)` = 幂等键，`macros.js#claimMacroRun` 的 `ON CONFLICT DO NOTHING` 直接依赖它。**四列全部写完不变，`status` 不在键里**（见下面的「两轴必须分两列」）。`assignment_id` → `REFERENCES macro_assignments(id)` **不带 ON DELETE**：取消订阅不许抹掉历史（有账的订阅只能停用） |

**三条口径（`portal/src/macros.js` 的三条硬语义，改代码前先读）**：

**两轴必须分两列（issue #524 的设计变更，别合回去）**：`criterion` 回答「这次触发是谁叫起来的」，
`status` 回答「这一次跑到哪了」。原先是一列 `state` 兼两义 ⇒ 幂等键里带着它，一条账
`pending → running → done` 之后**键位就空出来**，同一个触发能被再次 claim ⇒ 幂等失效。
现在：判据五值（`terminal` run 进终态 / `silent` 静默告警 / `tick` 定时轮询 /
`mechanical` M9 机械可判 / `semantic` M9 需模型裁决）写完不变、进幂等键；
生命周期六值会推进、不进键。迁移的守卫能抓三种回归：`criterion` 的 CHECK 少了 M9 的两路、
库里还留着 `state` 列、幂等键里混进了 `status`——三者都在真库上验过「反例必炸」。

1. **认领是 `INSERT … ON CONFLICT DO NOTHING RETURNING id`**，没插到返回 `null`（幂等命中）。
   写成「先 SELECT 再 INSERT」在并发下会让两个调度器各插一行、同一事件跑两遍——唯一索引就成了装饰。
   「订阅不存在 / 已停用 / 已过期」同样返回 `null`（资格判定在同一条语句的 `WHERE EXISTS` 里），
   别拿认领当存在性探针。
2. **模板删除是三分支**（07 篇 §2.3，判定与删除**同事务** + 模板行 `FOR UPDATE`）：
   零引用 ⇒ 物理删；只有订阅、无执行记录 ⇒ 物理删 + 级联删订阅；
   有 `macro_runs` **或** `notifications` ⇒ 只能软删（写 `deleted_at`）。
   「能不能物理删」由引用计数决定，不由请求方决定。`notifications` 表已由迁移 `0037` **建好**（早期「W3 才建」的口径作废）⇒
   判定按引用计数正常检查该表即可；保留「表存在则检查、不存在则跳过」（探测 `information_schema`，列名不写死）作为对旧库 / 未跑 0037 的防御。
3. **`until` 到期 ⇒ `enabled = false`**，一律按**瞬时**比（`timestamptz` × JS `Date`，
   不许按本地日截断）。W1 **不做定时器**：到期在读写两侧顺手收敛（`applyExpiredAssignments`
   被 `assignTemplate` / `listAssignments` / `claimMacroRun` 调用），所以「读出来的 `enabled`」
   与「真的还能跑」不会出现两种说法。W2 的 tick 只是把它变成主动。

**索引选型（为什么账表上不存 `template_id`）**：按模板筛执行账走
`macro_assignments(template_id)` + `macro_runs(assignment_id, started_at DESC)` 的 JOIN，
**不**给 `macro_runs` 冗余一份 `template_id`。理由：执行账是只追加的审计表，把可变的派生值
复制进不可变的历史行等于把同一事实存两处，换绑/重建模板时旧值成假账，还得再写守卫去追平。
代价是每次多一次等值 JOIN（`assignment_id` 已是 FK 且有索引），W1 量级足够。
另有 `macro_runs(started_at DESC)`（全局时间线）、`(criterion, started_at DESC)`（「这条判据
跑过没有」——幂等键那条索引的前缀是 `assignment_id`，服务不了这种筛法）、部分索引
`(started_at) WHERE status IN ('pending','running')`（调度器每 tick 扫未收口的账）、
`(child_run_id) WHERE NOT NULL`（run 详情页反查「由哪次宏触发」）——筛选全落索引列（09 篇 §7）。

写入方 = 只有 `portal/src/macros.js`（W1）；读取方 = W2 调度器与 W3 面板（尚未接线）。
用例：`portal/test/macros.test.js`（幂等键、软删三分支、`until` 到期、四条枚举 CHECK）。


### 1.34 `system_metrics` — 宿主资源指标的时序主表（issue #650，migration 0044）

> 同上：来自增量迁移 `0044-system-metrics.sql`；baseline `docs/data/schema.sql` 冻结、零字节不动。
> 要治的是「管理台没有任何宿主资源读面」：CPU / 内存 / 磁盘 / 容器数只能靠人 SSH 上机 `htop` + `docker ps`，
> 症状是「FDE 变慢」而**平台自己不知道宿主是不是快满了**。API 形状见 `docs/api/portal.md` §4.20，
> 运维动作（怎么关、怎么加盘）见 `docs/ops/system-metrics.md`。

**表用途**：每 `SYSTEM_METRICS_INTERVAL_SECONDS`（默认 30）秒一行，是宿主指标的**历史真相**。
设计决定里最要紧的一条是「只存原始点，查询时分桶」——不做「原始 + 小时汇总」双层表（那要两套写路径
加一个降采样 job）；30d × 30s = 86,400 行的主键范围扫是毫秒级，而分桶在服务端做，浏览器永远拿不到原始点。

| 列组 | 语义 |
|---|---|
| `sampled_at` `timestamptz` **PRIMARY KEY** | **自然键**：这一拍的采样时刻（应用侧的 `Date`，与 `written_at` 同拍）。写侧 `ON CONFLICT (sampled_at) DO NOTHING` ⇒ 重放是空操作。**这是对全局规范的显式偏离，见下一段** |
| `cpu_usage_pct numeric(5,2)` / `cpu_cores smallint` / `load1`/`load5`/`load15 numeric(8,3)` | CPU 占用是**两次 `/proc/stat` 的差**算出的（不是累计值）；`numeric(5,2)` 装得下 0.00–999.99，多核半开以上不会溢出。`load*` 直接透传 `/proc/loadavg`（单位是「 runnable 平均个数」，与核数相关 ⇒ 不除核数，口径在 `parseLoadavg`） |
| `mem_*_bytes bigint` / `swap_used_bytes` | `MemTotal` / `MemTotal-MemAvailable` / `MemAvailable` / `Cached`（+ SwapUsed）。`mem_used_bytes` 与 API 里的 `mem.usedPct` 同源；`MemAvailable` 缺失时**不拿 `MemFree` 顶替**（`numOrNull` ⇒ `null`，不把「不知道」当 0） |
| `uptime_seconds bigint` | `/proc/uptime` 第一字段——页面上「宿主已运行 N 天」的唯一来源（也是「DB 里的行是不是陈旧」的交叉校验） |
| `containers_total` / `_running` / `_station`、`fde_total` / `fde_running` | 容器计数口径写死在 `countContainers()`：总数 = 宿主全部；`station` = `Labels['station.managed']='true'`；`fde` = **只认** `Labels['station.managed']='true'`（名字前缀不算数——261118 真机验收修的误报：宿主别的项目容器名形如 `*-db` 曾被前缀规则算成 FDE ⇒ 面板虚报台数。一台丢了标签的 FDE 会以 `onlyDb` 形态出现在对账里，那是要看见的信号）。只读已在 Docker 白名单里的 `/containers/json`——**`stats`（1.02s/个）与 `/system/df`（15s）本单不碰** |
| `drift_count integer` | 「DB 说 N 台 ↔ Docker 实际 M 台」的对称差个数（`containerDrift()`）。只存**个数**：是谁（`onlyDb`/`onlyDocker`）只在 `latest` 里给，历史曲线不需要点名 |
| `written_at timestamptz NOT NULL` | 应用侧写（AGENTS §3.4：DDL 不写 `DEFAULT now()`），与 `sampled_at` 同拍；两者差得远就是写慢了的证据 |

**`sampled_at` 当主键 = 对 AGENTS §3.4「主键一律 `VARCHAR(32)` 单层字符串」的显式偏离（⚠️ 待决策者确认，issue #650 已标注）**

本站全局规范是「主键一律 `VARCHAR(32)` 单层字符串（`newId()`）」。这两张表**故意不遵守**，理由：

1. **时间序列表的自然键就是采样时刻**——它天然唯一（一拍一个时刻）、天然有序（范围扫即主键扫）、
   天然幂等（`ON CONFLICT (sampled_at) DO NOTHING` 直接可用，不需要先查一次「这一拍写过没有」）。
   再加一个代理键不会多换来任何一个好处，只会让幂等键退化成「`id` 唯一 + 采样时刻靠约定」。
2. **`newId()` 在这里只是每行 32 字节的死重量**：30 天基线 86,400 行 ⇒ 约 2.7 MB 纯索引死重（再加
   一个 `sampled_at` 二级索引才能真正等价）。而这张表的全部读法都是「按时间范围取」，
   `VARCHAR(32)` 主键在那个读法上一个字都服务不到。
3. **代价是可控且可逆的**：这两张表零外键指向它们（只有 disks → 主表的 `ON DELETE CASCADE`），
   没有跨表 JOIN 依赖主键形状；将来真要换 `VARCHAR(32)`，是一次 additive 迁移（加列 + 回填 + 换键），
   不需要改任何读面语义。

> 同意的偏离必须先写进本文再写迁移（不是反过来）。⚠ 本条待决策者确认；若要回到规范，
> 开口在 issue #650，不在本文自改。

**保留期与膨胀口径**：默认留 `SYSTEM_METRICS_RETENTION_DAYS = 30` 天（合法区间 1–365，越界回落默认 + warn）。
清理**不单开循环**，挂在 reaper 已有的**小时级**清理槽上（`internal.js`，一小时一个事务）；
`purgeSystemMetrics()` 那句 `DELETE` 额外带一个 `AND sampled_at < (SELECT MAX(sampled_at) ...)`
——**保住最新一拍**（采样器停了很久再启动时，「now() - 30d」可能已晚于库里唯一那批旧行，全删会让
历史图彻底空白），代价是主键上一次 index scan，毫秒级。磁盘行不单独清，靠 `ON DELETE CASCADE` 跟着走。

膨胀量级（写死在这里，便于下次算）：每拍 = 1 行主表 + N 行磁盘表（默认 N=1）。30s 拍频下
一天 = 2,880 行主表行，30 天 = 86,400 行；每行 18 个窄列，量级上「一张表几十 MB」而不是 GB——
这就是它不需要分区、不需要汇总层的原因。**拍频是写入成本的唯一旋钮**（`5s` 是最小可用粒度，
低于它写放大开始咬人；`300s` 以上曲线已经不够看）。

写入方 = 只有 `portal/src/system-metrics.js`（`writeSample`，一个事务里写两张表）；读取方 =
同文件的 `querySeries()`（服务端分桶 + 5s 进程内缓存）与 `toApiLatest()`（内存那一拍）。
用例：`portal/test/system-metrics.test.js`；「全新库跑通 + 重放幂等」在 `portal/test/migrate-fresh-db.test.js`。


### 1.35 `system_metrics_disks` — 同一拍里的逐盘行（issue #650，migration 0044）

**表用途**：一行 = **一块物理盘（一个文件系统）在一拍里的读数**。`sampled_at` 是 FK →
`system_metrics (sampled_at)` 且 **`ON DELETE CASCADE`**（保留期清理只删主表，磁盘行跟着走 ⇒
只有一句 `DELETE`，不会出现「主表清了、磁盘表还在堆」的半于状态）。

**主键是 `(sampled_at, device)`，不是 `(sampled_at, path)`**——这是本表存在的语义：
同一个文件系统上 bind 了多个路径时，`statfs` 的结果**完全相同**（它们本来就是同一个盘），
按 path 当键会让面板出现「三行一模一样的 937G」，还会让「已监控 N 个文件系统」的 N 变成谎。所以
写侧按设备去重（`diskRows()`）：`/proc/mounts` → 只留**真块设备**（`REAL_BLOCK_DEVICE_PREFIXES`，
并排除 `/dev/loop*`、`/dev/ram*`、`/dev/zram*` 这类伪设备）→ 同设备多路径取**最短 path**
（最短 = 最接近挂载根，面板上给人看的那一行要的是挂载点而不是某个嵌套 bind）。

| 列 | 语义 |
|---|---|
| `device text` | `/proc/mounts` 的**来源设备**——bind mount 下报的是**宿主**设备（实测），所以它能当「同一块盘」的身份证。挂载表**先过 `isRealBlockDevice()`**：只留 `/dev/sd*`、`/dev/nvme*`、`/dev/vd*`、`/dev/mapper/*`、`/dev/md*` 五族，并再挡一遍 `/dev/loop*`/`ram*`/`zram*`。前缀匹配不到（典型：容器里的 `/` 是 overlay，source 不是 `/dev/`）⇒ `device='unknown'`、`fs='unknown'`，**这一行仍然出**（只是说不清它是谁） |
| `path text` | 容器内**被 `statfs` 的那个路径**（来自 `SYSTEM_METRICS_DISK_PATHS`，同设备取最短，等长再按字典序⇒ 确定性）。它是展示用的引用，**不是键**——换一条 env 路径不会换一行历史 |
| `fs text` | `ext4` / `overlay` / `xfs` …，直接透传 mounts 表的 fstype |
| `total_bytes` / `used_bytes` / `avail_bytes bigint` | `statfs` 的 `df` 口径：`total = blocks*bsize`、`used = total - bfree*bsize`、`avail = bavail*bsize`（**拿 `bavail` 当 free 去算 used** 会把 root 预留那几十 G 算成「没人用」，与 `df -h` 差一截）；四个源字段任何一个缺失 ⇒ 整行不写（`NOT NULL` 三列不能写「不知道」），该路径落到 `diskUnreadable`；usedPct 在 API 层现算，表里不存百分比 |

**边界（写进数据层而不是只写进面板）**：未挂进 portal 容器的盘**不会自动出现在这里**——容器看不见
宿主挂载表，能 `statfs` 的只有 `SYSTEM_METRICS_DISK_PATHS` 里写了、且容器内真实存在的路径。
配了但读不到的路径不会静默消失：它进 `latest.diskUnreadable[]`（带 `reason`）露面，只是**不落库**
（一行读不到字节数的磁盘行在历史图上只会变成贴底的假线）。

写入方与 §1.34 同一处（`disksInsertSql()` 的多值 `INSERT … ON CONFLICT (sampled_at, device) DO NOTHING`，
与主表那一行共用同一个写事务）。**读侧自 #814 起不再是空**：新增 `seriesDisksSql()`（`portal/src/system-metrics.js`）
在本表上做「桶 × 设备」分桶查询（`GROUP BY 1, 2` + `min(path)`），经 `queryDiskSeries()` 按设备归组后由
`docs/api/portal.md` §4.20 的 `series.disks[]` 下发 ⇒ 本表从「只写不读」变成**有历史读面**（窗口与桶宽与
§1.34 的主序列查询完全同一对参数，两张图共用一条时间轴）。

### 1.36 `fde_onboarding` — FDE 开户编排状态（issue #111，migration 0012）

**用途**：一次 FDE 开户的分步进度落库（每 FDE 一行，主键即 `fde_id`）。
编排可中断可续，进程重启后照本表接着推。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `fde_id` | `uuid` | `PRIMARY KEY`，`REFERENCES users(id) ON DELETE CASCADE` | 每 FDE 一行，与 `users` 同生共死 |
| `state` | `text` | `NOT NULL DEFAULT 'pending'`，`CHECK (state IN ('pending','running','awaiting_credential','done','failed'))` | 编排状态机（见下） |
| `steps` | `jsonb` | `NOT NULL DEFAULT '{}'` | 各步进度快照 |
| `last_error` | `text` | 可空 | 最近一次失败原因 |
| `attempt` | `int` | `NOT NULL DEFAULT 0` | 重试次数 |
| `created_at` / `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 建 / 更时刻 |

**值域 / 状态机**：`state` 五值枚举由 `CHECK` 钉住（`pending` / `running` / `awaiting_credential` / `done` / `failed`）；典型推进 `pending → running → done`，失败 ⇒ `failed`，需人工写 PAT 时经 `awaiting_credential`——转换由应用层执行。

**谁写谁读**：写 = `portal/src/onboarding.js`（编排推进）；读 = `portal/src/admin.js`（管理台开户进度）。

### 1.37 `port_observations` — 容器端口占用观测（issue #246，migration 0022）

**用途**：agentd 心跳上报「容器里哪个进程在听哪个端口」的观测行，供端口分配与路由漂移对账。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | 观测行 id |
| `fde_id` | `uuid` | `NOT NULL REFERENCES users(id)` | = `containers.user_id`，冗余一份供按 FDE 直查 |
| `container_id` | `uuid` | `NOT NULL REFERENCES containers(id) ON DELETE CASCADE` | 观测来自哪台容器（重建后随旧心跳级联清除） |
| `port` | `int` | `NOT NULL CHECK (port BETWEEN 1 AND 65535)` | 监听端口 |
| `pid` | `int` | 可空 | 进程号 |
| `cwd` | `text` | 可空 | 进程工作目录（`~/projects/<name>` 下相对形，容器外进程留绝对路径） |
| `cmd` | `text` | 可空 | cmdline 摘要（截断），分辨「是哪个 dev server」 |
| `branch` | `text` | 可空 | `cwd` 处 `.git/HEAD` 指向的分支（尽力而为，detached / 非仓库为 NULL） |
| `proc_started_at` | `timestamptz` | 可空 | 进程启动时刻（`/proc/<pid>/stat` 换算） |
| `observed_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 最后一次采样到它的时刻（新鲜度窗口读侧判定） |
| `created_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 建行时刻 |

**值域 / 状态机**：`port ∈ [1, 65535]`；无状态机（观测流，新鲜度由读侧按 `observed_at` 判）。

**谁写谁读**：写 = `portal/src/portalloc.js` / `portal/src/materializer.js`（心跳落观测）；读 = `portal/src/routesdrift.js`（路由漂移对账）。

### 1.38 `preview_miss_stats` — 预览未命中的按天计数（issue #366，migration 0023）

**用途**：记录预览里「点了但不该被预览」的文件类型，按 `(kind, ext, day)` 聚合，回答「哪类文件在被点」。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `kind` | `text` | `NOT NULL CHECK (kind IN ('binary', 'too_large'))` | `binary` = 415 `unsupported_file_type`；`too_large` = 413 `file_too_large` |
| `ext` | `text` | `NOT NULL` | 归一化小写扩展名（无点；无扩展名 / 不可识别为 `''`） |
| `day` | `date` | `NOT NULL` | 按天聚合（写侧 `current_date` 归一） |
| `hits` | `bigint` | `NOT NULL DEFAULT 0` | 当日命中数 |
| `last_user_id` | `uuid` | `REFERENCES users(id) ON DELETE SET NULL` | 当日最后一次点击者（注销不挡计数） |
| `created_at` / `last_seen_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 建行 / 最近见到时刻 |

主键：`PRIMARY KEY (kind, ext, day)`。

**值域 / 状态机**：`kind` 二值 `binary` / `too_large`；`ext` 允许 `''`。无状态机。

**谁写谁读**：写 = `portal/src/previewmiss.js`（点中即按 `(kind, ext, day)` 累加 `hits`）；读 = 管理台按窗口求和。

### 1.39 `upload_settings` — 文件上传大小上限（单行表）（issue #485，migration 0036）

**用途**：全站「单文件上限（字节）」的 DB 真相；单行表（`id` 恒为 1）。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `int` | `PRIMARY KEY DEFAULT 1 CHECK (id = 1)` | 单行表哨兵 |
| `max_file_bytes` | `bigint` | `NOT NULL CHECK (max_file_bytes > 0)` | 单文件上限（字节）；产品区间 1 MiB–1 GiB 由写侧校验 |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 改时刻 |
| `updated_by` | `uuid` | 可空 | 改动人 |

**值域 / 状态机**：`max_file_bytes > 0` 是 DB 事实；产品区间 `[1 MiB, 1 GiB]` 交写侧。无状态机。

**谁写谁读**：写 = `portal/src/upload-settings.js`（管理台改）；读 = `portal/src/http.js` / `portal/src/config.js`（上传校验取上限）。

### 1.40 `notifications` — 宏事件通知（铃铛）（issue #526，migration 0037）

**用途**：宏事件「谁该被通知、读没读」的落库；面板铃铛与模板软删判定都读它。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `VARCHAR(32)` | `PRIMARY KEY` | 站内短 id，应用侧生成（见 `notifications.js`） |
| `user_id` | `uuid` | `NOT NULL REFERENCES users(id)` | 收件人 |
| `macro_run_id` | `uuid` | `REFERENCES macro_runs(id) ON DELETE SET NULL` | 关联的宏执行 |
| `severity` | `text` | `NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'error'))` | 严重级 |
| `title` | `text` | `NOT NULL CHECK (btrim(title) <> '')` | 标题（不许空白）。**入库的成品句子 = 回退面**：新行同时带下面两列，老行只有这一列 ⇒ 读侧照旧原样显示 |
| `title_key` | `text` | 可空（迁移 `0049`，issue #850） | 标题的 **i18n 键**（例 `notifications.macroExpired`），不是成品句子——写侧常常是**调度器**（没有人、没有请求、没有语言）。`NULL` = 「这条没键，请照旧用 `title`」。值域（键必须在前端 locales 登记）是**策略**，由读侧 `te()` 兜底挡，不写 DB CHECK（同 `0048` 分层） |
| `title_params` | `jsonb` | 可空（迁移 `0049`，issue #850） | 填 `title_key` 里占位符的参数（例 `{"name":"每日巡检"}`）。只在有键时有意义；无参数（如 `notifications.reviewUnavailable`）⇒ `NULL` |
| `body` | `text` | `NOT NULL DEFAULT ''` | 正文 |
| `read_at` | `timestamptz` | 可空 | `NULL` = 未读；已读时刻应用侧写 |
| `created_at` | `timestamptz` | `NOT NULL` | 生成时刻（应用侧写，无默认） |

索引：`(user_id, created_at DESC)`（翻页主路径）+ partial `(user_id) WHERE read_at IS NULL`（未读计数）。

**值域 / 状态机**：`severity ∈ {info, error}`；`read_at` `NULL`=未读 / 非 `NULL`=已读（两态）。⚠ 表与读侧 API 已落地，**不等于通知调度 / 派发全量实现**。

**谁写谁读**：写 = 宏事件生成侧（`notifications.js` / `macroRoutes`）；读 = `portal/src/http.js`（`GET /api/notifications`、`/api/notifications/unread-count`、`/api/notifications/:id/read`）。

**标题的语言（#850）**：`title_key`/`title_params` 由**读侧按读者当前语言渲染**（`portal/frontend/src/components/MacroBell.vue`，
键未登记则退回 `title`）；两列在 API 响应里**可选出现**（缺席就不带该键，不给 `null` 壳）⇒ 存量行为逐字不变。契约补记 ⇒ `docs/api/portal.md` §4.23。

### 1.41 `capability_items` — 能力市场条目（skill / mcp）（issue #595，migration 0039）

**用途**：能力市场目录主表，一条 = 一个 skill / mcp 能力。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | 条目 id |
| `kind` | `text` | `NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','mcp'))` | 能力类别 |
| `slug` | `text` | `NOT NULL UNIQUE` | 目录名，`^[a-z0-9][a-z0-9-]{0,63}$`（校验在 `market.js`） |
| `name` | `text` | `NOT NULL` | 展示名 |
| `summary` | `text` | `NOT NULL` | 一句话（列表卡片） |
| `when_to_use` | `text` | `NOT NULL` | 「何时用」，L3 路由信号 |
| `description_md` | `text` | `NOT NULL DEFAULT ''` | 详情页正文 |
| `version` | `text` | `NOT NULL` | 版本 |
| `author` | `text` | 可空 | 作者 |
| `tags` | `text[]` | `NOT NULL DEFAULT '{}'` | 标签 |
| `license` | `text` | 可空 | 许可 |
| `state` | `text` | `NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired'))` | 生命周期 |
| `manifest` | `jsonb` | `NOT NULL` | 清单 `{skill_id, entrypoint, tools:[…], files:[…]}` |
| `security_score` | `int` | `NOT NULL DEFAULT 100` | 安全分 |
| `security_warnings` | `jsonb` | `NOT NULL DEFAULT '[]'` | `[{code, path, line, note}]` |
| `created_by` | `uuid` | `REFERENCES users(id)` | 创建人 |
| `published_at` / `retired_at` | `timestamptz` | 可空 | 上架 / 退役时刻 |
| `created_at` / `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 建 / 更时刻 |

**值域 / 状态机**：`kind ∈ {skill, mcp}`；`state` 三值 `draft → published → retired`（转换由应用层执行）。

**谁写谁读**：写 = `portal/src/market.js`；读 = `portal/src/http.js`（市场列表 / 详情路由）。

### 1.42 `capability_files` — 能力条目的文件原文（issue #595，migration 0039）

**用途**：某能力某版本的文件内容（字节），随条目级联删。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `item_id` | `uuid` | `NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE` | 所属条目 |
| `version` | `text` | `NOT NULL` | 版本 |
| `path` | `text` | `NOT NULL` | 相对路径，已校验（无绝对路径 / 无 `..` / 无符号链接） |
| `content` | `bytea` | `NOT NULL` | 文件原文 |
| `bytes` | `int` | `NOT NULL` | 字节数 |

主键：`PRIMARY KEY (item_id, version, path)`。

**值域 / 状态机**：`path` 必须是相对路径；无状态机。

**谁写谁读**：写 = `portal/src/market.js`；读 = 装填能力时由 `market.js` 按 `(item_id, version)` 取文件。

### 1.43 `fde_capability_installs` — FDE ↔ 能力安装关系（issue #595，migration 0039）

**用途**：哪个 FDE 装了哪个能力哪个版本，带启停开关。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `fde_id` | `uuid` | `NOT NULL REFERENCES users(id) ON DELETE CASCADE` | 装到哪个 FDE |
| `item_id` | `uuid` | `NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE` | 装哪个能力 |
| `version` | `text` | `NOT NULL` | 装的版本 |
| `enabled` | `boolean` | `NOT NULL DEFAULT true` | 启 / 停开关 |
| `installed_at` / `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 装 / 更时刻 |

主键：`PRIMARY KEY (fde_id, item_id)`（每 FDE 对每能力一行）。

**值域 / 状态机**：`enabled` 二值，是「启 / 停」而非「装 / 卸」（卸载 = 删行，不是置 `false`）。

**谁写谁读**：写 = `portal/src/market.js`；读 = `market.js`（列已装 / 装填注入）。

### 1.44 `capability_params` — 能力的参数槽声明（issue #608，migration 0040）

**用途**：一个能力声明它需要哪些注入参数（配置 / 密钥）及注入位置。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `item_id` | `uuid` | `NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE` | 所属能力 |
| `name` | `text` | `NOT NULL` | 注入名，`^[A-Z][A-Z0-9_]{0,63}$` |
| `kind` | `text` | `NOT NULL CHECK (kind IN ('config','secret'))` | 配置 / 密钥 |
| `inject` | `text` | `NOT NULL CHECK (inject IN ('context','env','header'))` | 注入位置 |
| `required` | `boolean` | `NOT NULL DEFAULT true` | 是否必填 |
| `description` | `text` | `NOT NULL DEFAULT ''` | 说明 |
| `created_at` / `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 建 / 更时刻 |

主键：`PRIMARY KEY (item_id, name)`。额外 `CHECK (kind <> 'secret' OR inject IN ('env','header'))`：密钥只能注到 `env` / `header`。

**值域 / 状态机**：`kind ∈ {config, secret}`；`inject ∈ {context, env, header}`；`secret` 被约束为只能 `env` / `header`。无状态机。

**谁写谁读**：写 = `portal/src/market.js`；读 = `portal/src/secrets.js`（注入装配）。

### 1.45 `capability_param_values` — 参数槽的实际取值（issue #608，migration 0040/0042）

**用途**：参数槽在某作用域（全局或某 FDE）的实际值。⚠ **最终列是 `value_plain` 明文**；`value_encrypted` 已由 `0042` 删除，**没有密文列**。

**列定义**（0040 建、0042 改后的最终形态）：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `uuid` | `PRIMARY KEY DEFAULT gen_random_uuid()` | 值行 id |
| `item_id` | `uuid` | `NOT NULL REFERENCES capability_items(id) ON DELETE CASCADE` | 所属能力 |
| `name` | `text` | `NOT NULL` | 参数名（与 `item_id` 一起 FK 回 `capability_params`） |
| `scope` | `text` | `NOT NULL CHECK (scope IN ('global','fde'))` | 作用域 |
| `fde_id` | `uuid` | `REFERENCES users(id) ON DELETE CASCADE` | `scope='fde'` 才给 |
| `value_plain` | `text` | `NOT NULL`（0042 加） | 明文值；0040 建时为 `value_encrypted bytea`，0042 `ADD value_plain` + `DROP value_encrypted` + `SET NOT NULL` |
| `updated_by` | `uuid` | `REFERENCES users(id) ON DELETE SET NULL` | 改动人 |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 改时刻 |

其他约束：`FOREIGN KEY (item_id, name) REFERENCES capability_params(item_id, name) ON DELETE CASCADE`；`CHECK ((scope = 'fde') = (fde_id IS NOT NULL))`；partial 唯一索引 `capability_param_values_global_uq (item_id, name) WHERE scope = 'global'` 与 `capability_param_values_fde_uq (item_id, name, fde_id) WHERE scope = 'fde'`。

**值域 / 状态机**：`scope ∈ {global, fde}`，且与 `fde_id` 是否非空同真同假；「没有值」只能用「没有行」表达（明文拒空串）。无状态机。

**谁写谁读**：写 = `portal/src/secrets.js` / `market.js`；读 = 注入装配时按 `(item_id, name, scope)` 取值。

### 1.46 `platform_prompts` — 平台文案 / 提示词覆写（单行表）（issue #596，migration 0043）

**用途**：管理员覆写三处平台文本（AGENTS.md 补充节、AGENTS.md 覆写主体、标题生成提示词）。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | `int` | `PRIMARY KEY DEFAULT 1 CHECK (id = 1)` | 单行表哨兵 |
| `agents_md_addendum` | `text` | `NOT NULL DEFAULT ''` | 追加到 `~/AGENTS.md` 末尾的正文；`''` = 不加该节 |
| `agents_md_override` | `text` | `NOT NULL DEFAULT ''` | 整段替换内置模板正文主体；`''` = 用内置 |
| `title_prompt` | `text` | `NOT NULL DEFAULT ''` | 会话标题生成的 system 提示词；`''` = 用内置默认 |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 改时刻 |
| `updated_by` | `uuid` | 可空 | 改动人 |

**值域 / 状态机**：三个文本列空串 = 回落到内置；无状态机。

**谁写谁读**：写 = `portal/src/http.js`（管理台改）；读 = `portal/src/session-title.js`（标题）+ `portal/src/materializer.js`（生成 `AGENTS.md`）。

### 1.47 `runtime_settings` — 运行时旋钮的 DB 真相（issue #677，migration 0046）

**用途**：把 registry 旋钮的稳定值落库；读侧要的是「它是个 JSON 标量」这个类型事实。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `key` | `text` | `PRIMARY KEY` | 旋钮稳定标识 = registry key（例 `demo.limit`） |
| `value` | `jsonb` | `NOT NULL` | 值；写侧只收 number / boolean / string；对象 / 数组读侧判非法并回落 |
| `updated_at` | `timestamptz` | `NOT NULL DEFAULT now()` | 改时刻 |
| `updated_by` | `uuid` | 可空 | 改动人 |

**值域 / 状态机**：`value` 必须是 JSON 标量（number / boolean / string）；无状态机。

**谁写谁读**：写 = `portal/src/cli.js` / `portal/src/http.js`；读 = `portal/src/preview.js` 等各消费方。

### 1.48 `transcript_recovery_rows` — transcript 恢复行的落库（issue #500，migration 0038）

**用途**：引擎 recovery 事件的落库行（session 作用域），供崩溃恢复重放。

**列定义**：

| 列 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `transcript_key` | `text` | `NOT NULL` | 引擎 store key = `sessionId`（只有 session 语义，无 run 作用域） |
| `dedup_key` | `text` | `NOT NULL CHECK (length(dedup_key) <= 255)` | 事件键 `<runId>:engine:round:<n>:recovery:<event>:<判别子>` |
| `round` | `integer` | `NOT NULL CHECK (round >= 0)` | 事件所属轮号 |
| `record` | `jsonb` | `NOT NULL` | 引擎 record 原样（不剥字段） |
| `append_seq` | `bigserial` | `NOT NULL` | 持久化追加序（排序唯一真相） |

主键：`PRIMARY KEY (transcript_key, dedup_key)`。

**值域 / 状态机**：`round ≥ 0`；`dedup_key` ≤ 255 字符；`append_seq` 单调递增（排序真相）。无状态机。

**谁写谁读**：写 = `portal/src/transcript-store.js`（引擎 recovery 落行）；读 = 恢复重放时同一模块按 `append_seq` 有序读。


---

## 2. 状态机

> 验收锚点：**每个状态都列出产生方与消费方**。转换由应用层执行，DB 层用 CHECK 限定取值集合；「非法转换」的强制在应用层（portal / runner 各自只写自己负责的转换，见各表「写入方」）。

### 2.1 `runs.status`

```
                 ┌──────────┐  停止：未开始 ⇒ portal 直接终态  ┌──────────┐
                 │  queued  │ ───────────────────────────▶ │ finished │（termination.reason='aborted'，
                 └────┬─────┘   （#277：同时 run_queue → cancelled）│ detail='cancelled_before_start'）
        runner 领取/开始│                                        └──────────┘
                 ┌────▼─────┐   POST /stop（cancel_requested）
                 │ running  │ ─────────────────────────────▶ cancelling  ──┐
                 └────┬─────┘   （已执行过，等 worker 报终态；A2：不回 running）│
        run_end 正常  │  异常（persistence_failed 重试耗尽 / rate_limited / max_attempts_exceeded；`checkpoint_failed` 已于 #640 退役）
                 ┌────▼────┐   ┌────────┐                        worker abort 后 U2 收敛 ─┤
                 │ finished│   │ failed │                             → finished / failed
                 └─────────┘   └────────┘
   cancelling 口径（#277 收紧）：**已执行过（被 worker 领起过）、正在等 worker 报终态**；从未执行的 run 被停止不进本态（见 §2.1 表 `queued` 行）
   cancelling 收敛：runner 终止后 → finished（termination.reason='aborted'）或 failed
   （崩溃 ≠ 直接终态：worker/agentd 崩 → §2.8 崩溃恢复，attempts 内 re-claim 续跑）
   （例外 A2：容器已死 + cancelling → portal（reaper）收敛 finished/aborted，绝不回 pending 续跑）
```

> UI 上「已取消」是**宿主展示态**：由 `cancel_requested_at` + `termination.reason='aborted'` 推导，不是独立的引擎 termination 值（当前引擎 reason 集合见 §1.7）。

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `queued` | portal：`POST /api/sessions/:id/messages` 创建 run（portal.md §4.3） | agentd：claim 领取并开始（→ `running`，经 internal API，portal.md §9）；portal：stop 端点（**#277：未开始就被停止 → 直接 `finished`（`aborted` + `detail='cancelled_before_start'`）+ 同事务 `run_queue` 出队，不再进 `cancelling`**，portal.md §4.5）、`runs_one_active_per_session` 约束 |
| `running` | agentd 上报 `markRunState`（规格 §9.3），**portal 落库**（D1'） | portal：SSE 状态展示、`GET /api/runs/:id`；FDE：stop / 审批操作的前置状态 |
| `cancelling` | portal：`POST /api/sessions/:id/stop` 写 `cancel_requested_at` + 状态（portal.md §4.5）——**仅从 `running` 进入**（#277 收紧：本态含义是「已执行过、正在等 worker 报终态」，未开始的 run 不走本态） | agentd：SSE `stop_request`（主）/ 心跳 `stop_run_ids`（兜底）收到后 abort worker（runner-integration §4.3/§10）；portal：SSE 展示「停止中」 |
| `finished`（终态） | worker 跑完上报 → agentd 经 internal API 提交终态载荷（含 `termination` / `usage` 汇总，portal.md §5.3-13 / §9），**portal 收敛落库** | portal：消息落 `messages`、用量记 `usage_ledger`、run 级端口释放（→ `released`）；UI：展示 |
| `failed`（终态） | **仅终态、不可回退（A5 定稿）**：attempt 级失败**绝不**写 `runs.status='failed'`（记入 `run_queue.attempts` + `audit_log`，`runs.status` 保持 `queued/running`）；`failed` 只由**非重试性错误**（`checkpoint_failed` 重试耗尽 / `rate_limited`）或崩溃循环耗尽（`max_attempts_exceeded`）产生（§2.8/§2.9） | portal：错误展示与通知（规格 §14 长任务通知）、用量/端口收尾；FDE：可手动重新提交（新 run，非自动 resume） |

> 终态不可再变（无产生新状态的出边）；`cancelling` 的收敛者**恒为 runner**，**唯一例外**是「容器已死（心跳 3 次丢失）且租约过期」——此时 runner 已不存在，由 portal（reaper）收敛 `finished`（`termination.reason='aborted'`，A2），不留悬挂 `cancelling`。

### 2.2 `port_allocations.state`

```
 创建（项目/run 端口分配：同一 DB 事务写 port_allocations + route outbox）
        │
   ┌────▼─────┐  首次 forward-auth 放行（幂等升级）   ┌────────┐
   │ allocated│ ──────────────────────────────────────▶ │ active │
   └────┬─────┘                                         └───┬────┘
        │        项目删除 / run 结束 / 配额回收（同一 DB 事务写 outbox tombstone）      │
        └──────────────────────┬────────────────────────────┘
                            ┌──▼──────┐
                            │ released│（released_at 必填，reaper 定期清理）
                            └─────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `allocated` | portal：项目创建 / run 启动时的分配事务（规格 §7.2 第 3 步 / §8.2） | forward-auth：放行（portal.md §2.7 第 2 步）；portal：同一 DB 事务写 `port_allocations`（desired state）+ route outbox；`ports.json` 由 portal 在事务提交后原子写 bind mount；reconciler 异步幂等发布 Traefik 路由（同源，规格 §8.1） |
| `active` | portal：首次 forward-auth 放行（`200 + X-Auth-User`）后幂等升级（`UPDATE ... WHERE state='allocated'`，规格 §8.6） | forward-auth：放行；UI：预览卡片「在线」展示；报表 |
| `released`（终态） | portal：项目删除 / run 结束 / reaper 回收（规格 §8.2） | forward-auth：**403**（portal.md §2.7）；分配器：端口与 hostname 可复用（部分唯一索引不再覆盖）；reaper：过期清理 |

> 已定稿（规格 §8.6）：`allocated → active` 由**首次 forward-auth 放行**触发（`200 + X-Auth-User`）。portal 在放行判定通过后的同次处理内幂等升级（`UPDATE ... SET state='active' WHERE id=$1 AND state='allocated'`）：首次放行才升级、后续放行影响 0 行、已 `released` 不会误升级；升级**不写 route outbox、不重发路由**（`allocated` / `active` 转发语义一致，规格 §8.6）。`active` 状态在 DB（原理三），FDE 容器 / Traefik 路由 / `ports.json` 重建后**不回落**，唯一回退路径是 `released`（无 `active → allocated` 逆转换）。P1 无预览路由，故 P1 期间 allocation 恒为 `allocated`，`active` 只在 P2 预览启用后出现。

### 2.3 `approvals.status`

```
 runner 工具拦截 / judge 要求审批
        │
   ┌────▼────┐   FDE 决定（POST /api/approvals/:id）
   │ pending │ ─────────────┬──────────────┐
   └────┬─────┘        ┌────▼────┐   ┌────▼───┐
        │ 10min 无决定    │ approved│   │ denied │
        │（portal 打标）  └────┘   └────────┘
   ┌────▼────┐
   │ expired │（终态，修 #10 审计失真；迟到决定被拒）
   └─────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `pending` | worker 侧 judge/工具拦截产生，经 agentd 中转、portal 建单（规格 §9.1；portal.md §4.8/§9） | FDE：`GET /api/approvals?status=pending` 列表与决定；通知（规格 §14「需审批时通知」）；审批 reaper：10min 超时 → `expired` |
| `approved`（终态） | FDE：`POST /api/approvals/:id`（`decision=approve`） | worker：经 agentd 中转（SSE 快通道 + 轮询兜底，runner-integration §10）收到决定后继续执行该工具调用；审计 |
| `denied`（终态） | 同上（`decision=deny`） | worker：不抛错，把「被拒绝」作为 tool_result 反馈引擎（runner-integration §10.1）；审计 |
| `expired`（终态） | portal 审批 reaper：`pending` 挂起 **10 分钟** ⚠️ 无决定 → 置 `expired`（写 `expired_at`，#10 / topology.md §4-L6） | worker：agentd 本地 10min 超时按 denied 收敛（不等 portal 打标）；FDE：迟到决定被拒（`409 approval_expired`，portal.md §9.10）；审计 |

> `409 already_decided` / `409 approval_expired`（portal.md §4.8/§9.10）由条件更新（`UPDATE ... WHERE status='pending'`）兜底；终态无出边。

### 2.4 次要状态机（一览）

| 表.字段 | 状态集合 | 产生方 → 消费方（要点） |
|---|---|---|
| `containers.status` | `creating / running / stopped / exited / removed` | portal 生命周期操作产生（规格 §7.2/§7.3）；消费：任务下发（拉模型：消息落库即 202、容器恢复后自行 claim，portal.md §6.3）、心跳检测（`running` 长时无心跳 → 视 `exited`，3 次丢失 ≈45s ⚠️，runner-integration §4.2） |
| `chat_sessions.status` | `active / archived` | FDE 归档操作产生；消费：列表过滤、SSE 首连策略 |
| `users.status` | `active / disabled / awaiting_credential` | onboarding / offboarding / IdP 对账（规格 §7.3）产生；消费：登录与 forward-auth 拒绝、容器停止 |
| `run_queue.status` | `pending / claimed / done / cancelled` | portal 入队产生 `pending`；agentd claim（→ `claimed`，`claimed_at`/`lease_until`/`owner_container_id`/`claim_token` 必填由 CHECK 强制，attempts+1）→ 完成 `done` / 取消 `cancelled`；租约过期由 reaper 回收（A1/A2 定稿）：`runs.status='cancelling'` → `cancelled` + runs `finished`（aborted）；否则 `attempts < max_attempts` → 回 `pending`（**attempts 不变**），`attempts >= max_attempts` → `done` + runs `failed`（`max_attempts_exceeded`，§2.8） |
| `queued_inputs.status` | `pending / delivering / delivered / recalled / discarded` | `pending` 由 `POST …/queued-inputs` 产生（会话行锁内，同事务判活跃 run）；`delivering` 由终态出队的 CAS 认领产生（0 行 = 被别人抢先，放弃本轮）；`delivered` 由投递成功后回写（带 `run_id`）；`recalled` 由 `DELETE …/queued-inputs` 整队取回产生；投递失败**退回 `pending`**（下一次终态再来），只有会话已 404 才 `discarded`。消费方：会话详情 `queued_messages` 快照、`queue_update` SSE、上限校验计数。**过期 `delivering` 算可认领**（判据见 §1.29 `claimed_at` 行）且**算在上限里** | 
| `preview_grants.state` | `active / used / revoked / expired` | `active` 由 portal 签发（ticket）/ forwardAuth 换取（session）产生；`used` 由 forwardAuth 首次校验 ticket 同事务置位；`revoked` 由显式吊销 / allocation released / 用户 disabled 置位；`expired` 由 reaper 按 `expires_at` 懒打标 |
| `macro_runs.status` | `pending / running / done / skipped / failed / superseded` | **生命周期轴**（`criterion` 是另一轴：判据五值，写完不变、进幂等键，不是状态机 ⇒ 见 §1.33）。`pending` 由 `macros.js#claimMacroRun` 产生（`INSERT … ON CONFLICT DO NOTHING`，抢不到返回 `null`）；`running`/`done`/`failed` 由 W2 执行器经 `finishMacroRun` 推进（进终态补 `finished_at`）；`skipped` = 被门禁挡下，**必带 `skipped_reason`**（九种穷举：`budget_exhausted` / `quiet_hours` / `human_present` / `run_in_progress` / `deferred` / `deferred_timeout` / `active_run_in_cwd` / `cancelled_by_user` / `review_unavailable`（审查暂不可用，迁移 `0045` 追加，`verdict` 保持 NULL 不冒充 done）——「为什么没跑」是面板要分组的维度，不留自由文本）；`superseded` = 同桶被更新的一次取代。**W1 只有 `pending` 与手工收口，没有主动执行** |
| `macro_runs.verdict` | `pass / red / no-op-claim / needs-human / unclassified` | **结果判定轴**（不是生命周期：`status` 是另一行，两轴不得合一列）。单一真源 = `portal/shared/macro-kinds.js` 的 `VERDICT`（`macros.js` 的 `MACRO_VERDICTS` 只是它的导出别名）；DB 侧 `CHECK` 允许 `NULL`（只有 `done` 才该有判决）。产生方：`macro-review.js` 把模型**首行**判决映射成归一化口径（`VERDICT_BY_LABEL`：`通过→pass`、`整改→red`、`未证实有改动→no-op-claim`、`需人工→needs-human`；正则锚定首行、**fail closed**——缺行 / BOM / Markdown / 大小写或空格变化 / 未知值 ⇒ `unclassified` 且原话进 `verdict_raw` + `review_unclassified` 通知）。`macros.js#finishMacroRun` 另有一条语义闸：`status='done'` 而 `verdict` 没给 ⇒ **补 `unclassified`**（宁可显式承认没分类，也不留 NULL 让面板把「没判过」与「判不了」混成一个数）；`skipped`（含 `review_unavailable`，迁移 `0045`）时 `verdict` **保持 NULL**，不冒充 done。**消费口径**：只有 `red` 触发回灌整改 run（`needs-human` 转人工 + 通知，`pass`/`no-op-claim` 都不回灌）；`verdict` 与 `verdict_raw` 分存两列，就是为了口径改了以后能从原话重算 |

### 2.5 `route_outbox.state`

```
 portal 写 desired state + outbox 行 + 同事务递增 route_revisions（revision 递增）
        │
   ┌────▼─────┐   reconciler 领取（FOR UPDATE SKIP LOCKED，写 claimed_at/lease_until/worker_id）   ┌────────────┐
   │ pending  │ ────────────────────────────────────────────────────────────────────────────────▶ │ processing │
   └──────────┘                                                                                    └─────┬──────┘
                         租约到期未完成 → reaper 回收 pending（attempts+1）│
                                              发布失败且 attempts < max → 退回 pending（退避重试，attempts+1）
                                                         发布成功│  发布失败且 attempts 耗尽
                                                        ┌───────▼──┐   ┌───────┐
                                                        │ published│   │ failed │（终态：人工介入）
                                                        └──────────┘   └───────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `pending` | portal：任何写 desired state 的事务同时写一行 outbox（revision 递增，见 `route_revisions`）；reaper 把过期 `processing` 回收；reconciler 发布失败且 `attempts < max` 时退回 | reconciler：领取并处理 |
| `processing` | reconciler：领取（原子，`FOR UPDATE SKIP LOCKED` + 写 `claimed_at`/`lease_until`/`worker_id`，避免重复消费） | reconciler 自身：发布成功后置 `published` |
| `published` | reconciler：Traefik 动态配置生成 + 校验 + 原子替换 + reload 成功后 | 对账任务：与 file provider 比对（四向对账，topology.md §8） |
| `failed` | reconciler：发布失败且 `attempts` 耗尽（≥5 ⚠️）或不可重试 | **终态**：告警 + 人工介入；**不自动回 `pending`** |

> **完整状态机（与 schema.sql 注释一致）**：`pending → processing → published`；`processing` 发布失败且 `attempts < max` → 退回 `pending` 退避重试（1s→2s→5s→10s→30s 封顶，attempts+1）；`attempts` 耗尽 → `failed`（人工介入**终态**，不自动重试）。租约到期未完成的 `processing` 由 reaper 回收为 `pending`（attempts+1）。
> **版本单调 + latest-wins**：reconciler 消费前先查 `route_revisions`（`FOR UPDATE`）取当前 head，**只接受 `revision = head.revision` 的行**；`revision < head` 的晚到旧事件（含小 revision 后到达的 delete tombstone）**一律丢弃、不发布**。`published` 行是追加历史（保留审计/对账）；desired state 再次变更时 portal 再写一行更高 revision 的 outbox，reconciler 只发布新 head。
> **latest-wins 丢弃不写 `audit_log`**：`revision < head` 的晚到旧事件被丢弃属 reconciler 幂等收敛的**内部行为**（非对外状态变更），故不逐行写审计；漂移/异常由四向对账（topology.md §8）告警覆盖。⚠️ 待决策者确认（如需完整丢弃轨迹可另加审计）。
> **崩溃恢复**：reconciler 启动时 + 定时任务把 `state='processing' AND lease_until < now()` 回收为 `pending`（attempts+1），防 worker 崩溃后孤儿锁死。
> 幂等保证：`UNIQUE(aggregate, aggregate_id, revision)` + 生成文件为**纯函数**（同 revision 同输出）→ 重复消费/重试安全。失败保留上一版本文件（原子替换只在新文件校验通过后发生，topology.md §8）。

### 2.6 `fde_networks.state`

```
 onboarding 分配子网（写 fde_networks + docker network create）
        │
   ┌────▼─────┐  容器起好/首次可达（reconciler 观测）   ┌────────┐
   │ allocated│ ─────────────────────────────────────▶ │ active │
   └────┬─────┘                                       └───┬────┘
        │        offboarding 回收子网（state→released + released_at） │
        └───────────────────────────────────────────────┘
                                        ┌──▼──────┐
                                        │ released│（released_at 必填；块可复用）
                                        └─────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `allocated` | portal/reconciler：onboarding 分配子网（DB 写行 + `docker network create --subnet`） | reconciler：建网 + 起容器；IPAM：该 subnet 被占用（`UNIQUE(subnet)` 挡并发） |
| `active` | reconciler：容器已起、网络可达（观测到容器接入） | 连通矩阵/对账：视为在役网络 |
| `released`（终态） | portal/reconciler：offboarding **先吊销 token + 释放网段（同事务，审计 #34 F-B）** → 停容器 → 删网络 | IPAM：块可复用（复用前先腾出该行，见 §1.17）；对账：不再有对应 docker 网络 |

### 2.7 `fde_llm_bindings.state`

```
 建虚拟 key（portal 调网关 admin API → 写行 active）
        │
   ┌────▼────┐   offboarding / 轮换旧代次   ┌────────┐
   │ active  │ ───────────────────────────▶ │ revoked│
   └─────────┘                              └────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `active` | portal：onboarding 建虚拟 key（网关 admin API + 本表一行 + Traefik 注入路由 outbox） | Traefik：`Authorization` 注入；网关：额度/模型白名单/用量 |
| `revoked`（终态） | portal：offboarding / 轮换（旧代次吊销，`revoked_at` 必填） | Traefik：删除对应 LLM 注入路由（outbox op=delete）；网关：吊销 key |

### 2.8 崩溃恢复流程（run 级，方案 B：同 run_id re-claim）

> ⚠️ 待决策者确认：本文按 principles §3（容器是牲口、状态在中心）倾向 **方案 B**；方案 A（不自动 resume，新 run + `resume_from_run_id`）为备选，取舍见 runner-integration §6.5。

一个 `run`（`runs.id`）= 一次逻辑任务，可跨多次容器生命周期/worker 进程；每次（re-）start 是一个 **attempt**（`run_queue.attempts`），上限 `max_attempts`。

```
 入队(pending) → claim(attempts=1, 发 claim_token/lease) → running ──┐
      ▲                                                              │ worker 崩 / agentd 崩 / 容器重建 / 网络分区
      │  attempts < max_attempts（claim 时已 +1，回 pending 不递增）   ▼
      │◀──────────────────────── re-claim（resume:true，claim 时 attempts++）──┘
      │ attempts >= max_attempts
      └────────────────────────→ run failed(max_attempts_exceeded)（终态）
   （A2 例外：runs.status='cancelling' 时不论 attempts，直接收敛 finished/aborted，不 re-claim）
```

| 步骤 | 负责方 | 动作 |
|---|---|---|
| 崩溃检测 | agentd（worker 非预期 exit）/ portal（心跳 3 次丢失 ≈45s 判容器死） | worker 崩：agentd 走 U12 release + 重新 claim；agentd/容器崩：portal reaper 待 `lease_until` 过期回收 |
| 回收 | portal（reaper） | **A2 分支**：`runs.status='cancelling'` → queue `cancelled` + runs `finished`（`termination.reason='aborted'`），不回 pending；**A1 分支**：`attempts < max_attempts` → 回 `pending`（清 claim_token/owner_container_id/lease/claimed_at，**attempts 不变**）；`attempts >= max_attempts` → `done` + runs `failed(max_attempts_exceeded)` |
| 重新认领 | 新 agentd（重建后）或原 agentd（分区恢复后） | 按 **user_id 路由**领取且 `runs.status IN ('queued','running')`（非 container_id，§1.16）；新 claim_token 使旧 token 失效 |
| 双写防护 | portal | 旧 worker 任何写（事件/checkpoint/终态）→ `lease_lost` → 旧 agentd 本地 abort、丢缓冲（§4.5） |
| resume | 新 worker | `resume = attempt > 1`；~~引擎从快照表（本 run_id 单行）+ `transcript_rounds`（本 run_id）恢复，checkpoint revision 从 U9 读回继续 +1~~ ⇒ **自 erix-agent 0.33.0 / 本站 #640：只从 `transcript_rounds`（+ `transcript_recovery_rows`）恢复**，没有快照可读 |
| 副作用隔离 | 平台 | **DB 状态写被 fencing 拒绝**；外部副作用（shell/网络/LLM）平台无法物理终止（原理四），由 attempt 边界 + 审计标记隔离（runner-integration §6.5） |
| 终态 barrier | agentd | 全部事件批（U3）200 确认 + 全部 store 调用完成后，才提交 U2 终态；portal 合成 `run_end` 事件（runner-integration §7.6） |

**方案 B 的代价与 A5 口径（定稿）**：`runs.status` **不**在终态前多次 `running ↔ failed`——attempt 级失败（崩溃/re-claim）**不写 `runs.status`**，只记入 `run_queue.attempts`（claim 时递增）与 `audit_log`（`run.claim` / `run.lease_superseded` / `run.released` / `run.attempt_exhausted`）；`runs.status` 在崩溃恢复期间保持 `queued`/`running`，**只有**耗尽（`max_attempts_exceeded`）或非重试性错误（`checkpoint_failed` 重试耗尽 / `rate_limited`，§2.9）才置终态 `failed`。终态 `failed` 后无自动 resume（如需跨 run 续跑，那是方案 A 的 `resume_from_run_id`，本期不做）。UI 的「第 N 次尝试」由 `run_end.payload.attempt` 与 `audit_log` 展示，而非 `runs.status` 回跳。

### 2.9 `checkpoint_failed` 恢复口径（A3 定稿）**【历史口径：0.33.0 起不再产出该错误码】**

> ⚠ 本节整条是**旧档案读法**（表已由 `0041` 撤，见 §1.11）。留着的原因：`checkpoint_failed` 仍在
> 可重试码值域里（旧 run 的 `runs.error_code` / `termination.errorCode` 写着它，重试判定读旧账时要用，
> 理由见 `runner/lib/termination.js`）。**新 run 的同类失败叫 `persistence_failed`**（落的是账本写失败，
> phase 可能是 `transcript` / `run_state`，也可能是旧档案里的 `checkpoint_before_tool` / `checkpoint_after_tool`）。

| 项 | 结论 |
|---|---|
| 谁置 `checkpoint_failed` | **worker**：`runToolLoop` 在工具执行前/后 checkpoint 写失败时 fail-closed 抛错（adapter 已按 runner-integration §9.2 做 3 次重试，耗尽后透传）→ agentd 经 U2 终态上报 `failed`，`error={code:'checkpoint_failed', retryable:true}`；portal 落库 |
| 是否可重试 | **adapter 层可重试**（3 次，1s/2s/5s）；**run 层不自动 re-claim**——它是引擎 fail-closed 判定而非进程崩溃，存储故障持续时 re-claim 只会原地重演；因此直接终态 `failed`（与 A1 的崩溃耗尽、A2 的 cancelling 并列的终态来源，不冲突） |
| 恢复时 checkpoint 取哪一份 | **最新已持久化那一份**：快照表单行，U9 返回的 `snapshot + revision`。失败的那次 save 没有落库（revision CAS 拒旧/失败不写），不存在「半份 checkpoint」；`runs.status='failed'` 终态后不可 resume（终态 barrier） |
| 与 revision CAS 的关系 | 失败写不改变快照表的 `revision`（要么 0 行更新被拒、要么网络失败未达库）；U9 读回的是上一个成功 revision；若将来启用同 run resume，从 `revision+1` 续计，不冲突 |
| 是否需人工介入 | **是**：存储恢复 + 用户重发（`POST /messages` 产生新 run）。本期无跨 run resume（方案 A 不做），「进度未丢失」仅指 checkpoint/transcript 数据仍完整保留在 DB、可供未来 resume 或人工检查，**不**自动续跑 |

---

## 3. 三份数据的边界与「不混」的落地方式

规格 §9.2 的三层划分（**①≠②≠③，直接混用的后果见规格原文**）：

| 层 | 表 | 内容 | 谁写 | 谁读 | 可折叠 |
|---|---|---|---|---|---|
| ① 人看的对话 | `messages` | 用户输入 + assistant 最终回复（含 `synthetic` 标记的合成消息） | **portal**：用户消息（POST 时）；assistant 回复 = worker 终态上报、portal 落库（D1'） | **UI 唯一对话来源** | 否 |
| ② canonical 消息 | `transcript_rounds` | 模型上下文 + resume 源（含 judge 注入、wrapup、nudge）；`record` = RoundRecord 全量真相，其余列派生 | **仅 portal internal 端点**（`appendRound` 映射，runner-integration §9.1）；runner 是 HTTP adapter 调用方，不直连 DB | **仅 `runToolLoop`**（resume / fold，经 `GET .../transcript`） | 是（fold 只影响视图） |
| ③ 流式事件日志 | `run_events` | 带 seq 的事件信封（portal.md §5.3 全类型） | **仅 portal**（agentd 批量上报事件，portal 分配 seq 落库，runner-integration §7） | 前端 SSE / 断线重放 | 否 |

「不混」不是纪律口号，落地方式有四层：

1. **物理分表**：三层各自一张表，schema 上没有共用列可互相污染；唯一桥接是 `run_id` / `session_id` 外键（关联 ≠ 混合）。
2. **写入路径单一**：每张表只有一个代码写入方（见上表「谁写」）。UI 渲染**只读 `messages`**；引擎 resume **只读 `transcript_rounds`**；SSE **只读 `run_events`**。代码评审时任何跨层读写（如 UI 直接渲染 transcript）即为 bug。
3. **合成消息的显式标记**：judge 在 transcript 里注入的是 user role 合成消息（规格 §9.2）；凡需进入人读层的合成内容，落 `messages` 时必须 `synthetic = true`（DB 层 `NOT NULL DEFAULT false` + 应用层显式置位），UI 显著标记——不借道、不隐式。
4. **DB 角色（A6 已落地）**：**portal 是 Postgres 唯一业务写方**。两个角色已落地：`station_platform`（DDL/迁移专用，schema.sql 表 owner）+ `station_portal`（运行时 DML 专用，最小 GRANT：只授业务表 `SELECT/INSERT/UPDATE/DELETE` 与序列 `USAGE/SELECT`，不授 DDL；对 `schema_migrations` 只读）。角色由 `docs/data/schema.sql` 开头**幂等创建**（自包含，空库可单独执行）；`docs/data/bootstrap.sql` 是生产环境的附加初始化（schema 级授权 + 口令/ownership 等环境特有设置，可重复执行）；对象级 DML GRANT 在 schema.sql §10（`station_platform` 授出）。**runner 不连 DB，因此不需要 `station_runner` 角色**（容器侧根本没有 DB 凭据可发）。「不混」在 DB 层由「internal 端点写入路径唯一（第 2 层）+ 运行时角色只 DML」双重保证。

> seq 统一：`messages.seq` 与 `run_events.seq` 共用 `chat_sessions.last_seq` 分配器（同事务递增），三层各自的序互不依赖、但对 UI 呈现（消息与事件交错的时间线）有一致的单调序。

---

## 4. 归档与膨胀策略

**膨胀来源排序（dev 真库 `station` 现查，2026-11-13，issue #502 修正；⚠ 那一列是 **`0033` 迁移前**的历史读数）**：
`run_events` **472 MB** ≫ `transcript_rounds` **12 MB** > 快照表 4.6 MB > 其余表。
（⚠ 这条排序里「快照表」那一档是**历史项**：它已由迁移 `0041` 撤掉，issue #640；原名见冻结 baseline。）
（⚠ 行尾那一档 4.6 MB 是 **`0034` 迁移前**的读数；`0034` + `VACUUM FULL` 后它是
17 行 / 565,248 B，见下面「迁移后的当前量级」那条与。）
本表原先写的是「`transcript_rounds.messages`（单 run 可达 MB 级）> `run_events.payload`」——**排序反了**：
`transcript_rounds` 实测 12 MB / 2,231 行（单 run MB 级那一档远没出现），而 `run_events` 靠 stream 档碎片的
**行数**堆到 472 MB / 884,163 行。膨胀机制不是「行大」而是「行多且每行都要走一次事务 + 索引」，这是当初写下
「单 run 可达 MB 级」时没料到的方向。修法见 §1.12 的 stream 档那条（碎片不落库）。

> **迁移后的当前量级（2026-11-14 实测：`0033` + `VACUUM (FULL, ANALYZE)` 之后）**：`run_events` **7,008 行 / 5,578,752 B（5.3 MB）/
> 每行 802 B**，全库 **48,389,143 B（46.1 MB）** ⇒ 上面那条排序里 `run_events` 已从「472 MB」降到全库零头，
> 现下的榜首是 `transcript_rounds`（那个排序只在迁移前成立）。
> ⚠ 另一处没动的膨胀源：快照表（85 行 / 4.6 MB）本单未动——**但自迁移 `0034`（PR #509）起它也不成立了**，
> 时间边界（真库 `station` 实测）：
> **`0034` 之前 87 行 / 4,644,864 B**（台账记的拆分：heap 81,920 / 索引 32,768 / TOAST 4,227,072，
> 那一组不逐字相加——它没含 TOAST 自己的索引与 FSM/VM 那几块），
> **`0034` + `VACUUM (FULL, ANALYZE)` 后 17 行 / 565,248 B**（heap 8,192 + 索引 32,768 + TOAST 本体 507,904；
> `pg_total_relation_size` 里的 TOAST 那一块算上 TOAST 自己的索引是 524,288 B，三者相加才等于 565,248）
> ——回收 4,079,616 B = −87.8%，全库 −3.88 MB（−8.4%）。
> 上面那句 85 行 / 4.6 MB 与本节那个排序同属**旧时点读数**（那是 `0033` 前甚至 `0034` 前的一次现查），
> 留着是取证当时的排序，不是现价；现价的量法（行数 / `pg_total_relation_size` / heap·idx·TOAST 拆开）。
> 另：`0034` 只清行，**磁盘要部署侧手工 `VACUUM (FULL, ANALYZE) <快照表>` 才回收**（表已由 `0041` 撤，这条运维动作自此是历史）（同下面 `0033` 那条运维注记的理由）。

| 表 | 策略 | 理由 / 依据 |
|---|---|---|
| `run_events` | **热保留，当前不删除**（针对**已落库的 durable 档**）。~~到期导出 JSONL 冷存后 DELETE~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**：事件无限期热保留；将来可选项（保留 N 天后导出 JSONL 冷存、再 `DELETE`）留作分析，见下方运维注记。**#502 的两条例外**：① stream 档碎片自迁移 `0033` 起**不再产生**（旧存量由同一支迁移分批清掉）；② 每个 run 的未完稿正文只占**既有 `run_end` 载荷里的三个键**（`partial_text` / `partial_round`，以及 #513 加的截断位 `partial_truncated`，
>    形态 M ⇒ 不新增行、不新增索引）。 事件的唯一消费是实时推送与断线补发。补发窗口有限的契约语义（过期后 SSE 返回 `410 replay_unavailable`，前端回退全量拉取，portal.md §5.2-4）**保留定义但因当前不删事件而不会触发**——两处口径已对齐（portal.md §5.2 注） |
| `transcript_rounds` | **不删**（resume 源 + 审计），膨胀靠 jsonb 自动 TOAST 压缩吸收。~~session 归档后可整体导出冷存~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**；活跃 session 永不归档 | 规格 §9.2「fold 只影响视图，档案完整」；resume 只可能发生在活跃 session 上 |
| ~~快照表~~ | **表已撤**（迁移 `0041`，issue #640）——不再是归档对象 | 曾经：每 transcript key 单行覆盖写，无积累；0.33.0 起引擎不再读写，恢复改由 `transcript_rounds` + `transcript_recovery_rows` 承担 |
| `messages` | 永久保留 | 人读层，行小（content + 摘要），是 FDE「关掉明天再打开会话还在」期待的承载（原理三） |
| `usage_ledger` / `audit_log` | 永久保留，只追加 | 记账与审计语义（规格 §14 看板/对账）；量小（每 run 数行 / 每请求一行） |
| `port_allocations`（released） | reaper 定期硬删 `released_at` 过期的记录（规格 §8.2） | 历史归属信息已由 `audit_log`（`port.allocate` / `port.release` 动作）承载 |
| `tool_outputs` | 随 run 生命周期保留（`run_id` 归属）；`body` 靠 TOAST 压缩吸收 | 阈值另存本就是为把大 payload 移出 `run_events`；行数 = 超阈值的工具调用数（topology.md §9） |

**运维注记**：

- 冷存导出 = 「可恢复但不在线」，属**将来可选项（当前不实施**，决策者 2026-09，issue #3 评论**）**：若启用，导出目标可用 `/docker/station-db/archive/`（env §6 目录约定）。需要在线可查的长期归档（P3 之后）再评估分区表（按 `day`/`created_at` RANGE 分区）或独立归档库，**v1 DDL 不上分区**（过早复杂化）。
- 若将来启用 `run_events` 冷存删除，则 `DELETE` 密集，需关注 autovacuum；膨胀监控直接查 DB（原理三：状态在中心）。
- `0033` 清完存量后**空间不会自己还给磁盘**（普通 `VACUUM` 只回收页、不缩文件）：需要在低峰期手工
  `VACUUM (FULL, ANALYZE) run_events;`（`FULL` 持 `ACCESS EXCLUSIVE`，本站规模下秒级到十秒级）。
  这一步**没有**放进迁移文件——迁移 runner 每个文件跑在单事务里，`VACUUM` 不能在事务块中执行
  （`portal/test/delta-not-persisted-db.test.js` 里有用例钉着这条事实）。
- 每行字节上界（清理后）：`run_events` 每行 < 4 KB（含 5 个索引的摊销）；~~快照表每行 < 512 KB~~（**该表已随 #640 撤**，体积闸现在只断 `run_events`，并新增了「样本必须恰好是种下去的行数」+ **总字节下界**两道，防退化成空样本）
  （**时间边界**：`0034` 前 dev 实测 85 行 / 4,644,864 B ≈ 53 KB/行；`0034` + `VACUUM (FULL, ANALYZE)` 后
  **17 行 / 565,248 B ≈ 33 KB/行**；2026-11-14 真库现查）。
  两条上界都在真库用例里断言（`portal/test/delta-not-persisted-db.test.js` 的「体积闸」那条），不是文档口头承诺；
  ⚠ 它断的是 `pg_total_relation_size / count(*)` 的**均值**，不是单行最大值——现查单行最大
  `length(snapshot::text)` = **429,617 B**（一行的正文就吃掉那个 512 KB 上界的 **82 %**）⇒ 均值口径下很宽，
  单行口径下余量只剩 ~18 %，快照再大一档要先把这条判据改成按单行量。
- 量级粗估：单 FDE 日 20 runs × 100 事件/run × 2 KB ≈ 4 MB/日/FDE → 个位数 FDE 规模下即使**不删除**、长期热保留，增长亦平缓（年量级 GB），对 275 G 可用磁盘（env §8.1）无压力；transcript 的在线积累是主要增长项，需纳入看板。

---

## 5. `usage_ledger` 记账口径 ⚠️ 待决策者确认（Q1/Q4）

**背景**：Q1（公司是否已有统一 LLM 网关）与 Q4（虚拟 key 粒度）未定（规格 §0）。按 principles §4 当前倾向：Q1 → (b) 没有则起一个 LiteLLM，portal 只做租户绑定，**不自写代理**；Q4 → (a) **每 FDE 一把虚拟 key + 请求打客户项目标签**，不每项目一把（key 数量膨胀）。

**记账口径（当前倾向下的落地）**：

| 项 | 口径 |
|---|---|
| 最小粒度 | **一 run 一条**（`source='erix'`）：worker 在 run 结束时以引擎返回值汇总，随终态载荷经 internal API 上报（portal.md §9.6 U2 / §9.9），**portal 落** `input_tokens / output_tokens`；`user_id / project_id` 由 `run → session → project` 推导后**冗余落列**（聚合免 join） |
| `day` | UTC 日历日，写入时计算，聚合冗余维度（按日看板/限额） |
| 双源对账 | 规格 §11.4「网关 usage 与 erix onUsage 两套数都要记」：网关侧按 `key_alias + day` 聚合周期拉取落 `source='gateway'` 行（`run_id` 为 NULL——每 FDE 一把 key 时网关只知道 key 不知道 run）；**差异 = judge/fold 的额外调用 + 丢失事件**，供对账看板 |
| 成本归属 | 按 `project_id`（≈ 客户项目，规格 §11.3「业务口径：网关不知道 FDE→客户项目这层映射，portal 补」） |
| `cost` | P1 网关/价格表未定 → **可空**（portal.md §4.1 `run.cost` 同口径）；P3 接网关价格后由 portal 计算回填 |

⚠️ 待决策者确认：若 Q4 最终选 (b)（每客户项目一把 key），`gateway` 行的归属精度升到项目级（`project_id` 可直接从 key_alias 映射），表结构**无需变更**（`key_alias / project_id` 列已就位），仅聚合唯一索引的使用方式变化。

---

## 6. ⚠️ 待决策者确认汇总（本文与 schema.sql 出现的全部标注）

| # | 事项 | 当前倾向（principles §4） | 影响 |
|---|---|---|---|
| 1 | Q1/Q4：`usage_ledger` 粒度与 `cost` 口径 | Q1→(b) 自建 LiteLLM 不写代理；Q4→(a) 每 FDE 一把 key + 项目标签 | §5；`runs.cost` / `usage_ledger.cost` P1 可空 |
| 2 | Q5 端口分级：先只做项目级 | 倾向 (b) 起步 | `port_allocations.scope/run_id` 字段先行保留（§1.9） |
| 3 | `run_queue` 表：pull 模型为终态，push 仅作 P2 优化后置（⚠️ 待决策者确认，不作默认契约） | 规格 §10.3 旧描述「单机可先 push」已不再作为默认 | §1.16（表先行落地，push 模式不启用） |
| 4 | `port_allocations` `allocated → active` 触发条件 | ✅ 已定稿：首次 forward-auth 放行（幂等升级，重建不回落，规格 §8.6） | §2.2 |
| 5 | 三表「不混」的 DB 角色分离（GRANT 强制） | ✅ 已落地：`station_platform`（DDL）/`station_portal`（DML）已入 schema.sql §0（幂等创建）+ schema.sql §10（最小 DML GRANT）；`bootstrap.sql` 作附加初始化（A6） | §3-4 |
| ~~6~~ ✅ 已定稿（D2'）：纯 DB 无 file 副本，该建议作废（规格 §9.3 已改写） | 规格已改写 | §1.11（代价说明） |
| 7 | `tool_outputs` 阈值（bytes） | 未定（建议如 4KB/8KB） | §1.19；决定「事件里放 digest、全文落表」的边界 |
| 8 | `route_outbox` 聚合类型枚举（`port_allocation`/`llm_binding`/…） | 实现时定全量清单 | §1.18；reconciler debounce/SLO 已定（topology.md §8），枚举待补 |
| 9 | `fde_networks` 复用前「腾行」的精确做法 | `DELETE` 已释放行 vs 保留并改 `subnet`；历史由 `audit_log` 承载 | §1.17（`UNIQUE(subnet)` 全局唯一所致） |
| 10 | 崩溃恢复方案：**方案 A（新 run + `resume_from_run_id`，不自动 resume）** vs **方案 B（同 run_id re-claim，倾向）** | 倾向 B（principles §3 + 现有 claim/lease/resume 机制；checkpoint/transcript 单行-per-run 天然同 run_id） | §2.8；影响 checkpoint 查询契约、审计/UI（runner-integration §6.5） |
| 11 | `client_event_id` 是否含 attempt 前缀（`run_id:attempt:计数`） | 含（re-claim 后计数归零不碰撞） | §1.12；portal.md §9.4 已同步 |
| 12 | `run_end` 事件唯一产生方：worker 经 U3 vs portal 由 U2 合成 | portal 由 U2 合成（单事务，无事件/终态排序间隙） | §1.12/§2.1；portal.md §5.3 已同步 |
| 13 | checkpoint 单调性：`revision` CAS（旧快照拒绝） | ~~采用（快照表 `revision` 已落 DDL）~~ ⇒ **已撤销**：表随 #640 由 `0041` DROP，单调性改由 `transcript_rounds.append_seq`（0016）承担 | §1.11（历史）；portal.md §9.8（已标退役） |
| 14 | 心跳 U4 逐 run 携带 `claim_token` + 部分失败响应 | 采用 | §1.16；portal.md §9.5 已同步 |
| 15 | spool 契约（路径/配额/写满/删除） | 见 runner-integration §7.5（参数 ⚠️） | 不入库（非真相）；§1.12 |
| 16 | `max_attempts` 默认值与耗尽终态 | 默认 3；耗尽 → `failed(max_attempts_exceeded)` | §1.16/§2.8（已落 DDL） |
| 17 | materializer outbox 复用 `route_outbox` vs 新增表 | ✅ 新增 `materialize_outbox` + `materialize_revisions`（A7，避免与路由 reconciler 争抢） | §1.22；user-space.md §7.1 |
| 18 | `checkpoint_failed` 是否自动 re-claim | 不自动 re-claim（终态，人工重发；A3 定稿） | §2.9；portal.md §6.2 需同步提示口径 |
| 19 | ⚠️ `system_metrics` / `system_metrics_disks` 用 `sampled_at`（`timestamptz`）当主键，**偏离 §3.4「主键一律 `VARCHAR(32)`」**（issue #650，migration 0044） | 保留偏离（自然键 = 采样时刻，天然幂等；`newId()` 只是每行 32 字节死重；理由全文见 §1.34）；若要回到规范是一次 additive 迁移 | §1.34–§1.35；`deploy/migrations/0044-system-metrics.sql` 头注同步标注 |
