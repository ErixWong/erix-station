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
| 账号与认证 | `users` / `login_sessions` / `api_tokens` / `preview_grants`（预览凭证） | 规格 §7 / portal.md §2.7 |
| 容器与项目 | `containers` / `projects` | 规格 §4 / §7.2 |
| 会话与对话 | `chat_sessions` / `runs` / `messages` | 规格 §9.1 |
| 端口分配与路由 | `port_allocations` / `route_outbox` / `route_revisions` | 规格 §8 / topology.md §5/§8 |
| 引擎持久化 | `transcript_rounds` / `run_checkpoints` / `run_events` | 规格 §9.2/§9.3 |
| 工具与审批 | `tool_calls` / `tool_outputs` / `judge_decisions` / `approvals` / `artifacts` | 规格 §9.1 / topology.md §9 |
| 用量与审计 | `usage_ledger` / `audit_log` | 规格 §11.4 / §14 |
| 任务队列 | `run_queue`（含租约字段） | runner-integration §4.2/§6（拉模型，claim 长轮询） |
| 网络与 IPAM | `fde_networks` | topology.md §3（H-B D-10） |
| LLM 网关绑定 | `fde_llm_bindings` | 规格 §11.3 / topology.md §4-L7 |
| 用户空间物化 | `materialize_outbox` / `materialize_revisions` | user-space.md §7.1（A7 定稿） |
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
| `status` / `disabled_at` | `active` / `disabled`。offboarding 停用（规格 §7.3），与 IdP 对账任务的写入目标 |

**状态机**：`active → disabled`（单向；恢复 = 管理操作重新置 `active`，无自动路径）。
产生方：onboarding workflow / 对账任务（规格 §7.3）；消费方：登录（disabled 拒绝）、forward-auth、容器调度（disabled 用户的容器应停）。

### 1.2 `login_sessions` — 登录会话

cookie 令牌的**哈希**存储（`token_hash` 唯一），可单条吊销（`revoked_at`）——offboarding「失效登录会话」依赖此性质（规格 §7.3；portal.md §2.5）。7 天滚动续期：`expires_at` 每次活跃请求刷新。

### 1.3 `api_tokens` — 程序化访问令牌

非浏览器客户端用（portal.md §2 之外的 API 访问；规格 §6.2 basic auth 兜底场景的补充）。哈希存储、`scopes` 数组、可吊销。`UNIQUE(user_id, name)` 便于按名管理。

### 1.4 `containers` — FDE 容器（每 FDE 一行）

| 关键字段 | 语义 |
|---|---|
| `fde_name` / `container_name` | 均唯一；`container_name = fde-<name>`（docker 容器名）。该容器名只在其自己的 `/29` 网络内按 docker DNS 解析（供其自有服务）；portal **不**按容器名/容器 IP 访问它——平台通道全出站经 Traefik（H-B，topology.md §2/§4；`control` 已取消） |
| `runner_token_hash` / `token_generation` / `revoked_at` / `rotated_at` | per-container token（规格 §10.3 / issue #12）：**仅存哈希**。建容器时生成原文、注入容器 env `ERIX_STATION_TOKEN`；**容器 → portal 单向出示原文**（internal API Bearer），portal 只校验哈希、不再向容器出示。`token_generation` 是代次（轮换/重建 +1），`revoked_at` / `rotated_at` 记录吊销/轮换时刻——旧代次哈希失配 → `401 token_revoked`（原子吊销，topology.md §6 第 9 条）。严禁明文入 DB/日志/镜像/仓库（原理 §5 清单）。**容器除此之外无任何平台凭据，尤其没有 DB 凭据**（D1'） |
| `status` | `creating / running / stopped / exited / removed`（状态机见 §2.4） |
| `agent_version` | erix-agent 版本 pin / canary 的记录点（规格 §14 容器升级流程） |
| `last_heartbeat` | agentd 心跳（15s ⚠️，经 internal API 上报、portal 落库，runner-integration §4.2 U4）；3 次丢失（45s ⚠️）判容器死（视 `exited`），run 级处置走租约到期 re-claim（runner-integration §6.4） |

### 1.5 `projects` — 项目（容器内仓库目录）

| 关键字段 | 语义 |
|---|---|
| `name` | 同时是容器内目录名 → `CHECK` 限定 `[a-z0-9][a-z0-9-]{0,62}`（portal.md §3.1） |
| `slot` | 项目端口块序号，决定起始端口 `4000 + slot*8`（规格 §8.2）。`user_id + slot` 活跃唯一 |
| `deleted_at` | 删除 = 软删除 + 回收端口（同一事务，portal.md §3.6）；软删后 name/slot 可复用 |

### 1.6 `chat_sessions` — 对话会话（UI 概念）

| 关键字段 | 语义 |
|---|---|
| `status` | `active / archived`；有进行中 run 时禁止归档（portal.md §4.2 `409 run_in_progress`） |
| `last_seq` | **session 级 seq 分配器**：`messages.seq` 与 `run_events.seq` 都由它分配（同事务 `UPDATE ... SET last_seq = last_seq + 1 ... RETURNING`），保证 SSE 的 `Last-Event-ID` 语义（portal.md §5.1/§5.2）。这是原理三「状态在中心」在实时层的落点 |

`active_run_id`（portal.md §4.1）**不落列**，由 `runs_one_active_per_session` 部分唯一索引覆盖的运行中 run 推导——避免两份真相（原理五同构：单一事实源）。

### 1.7 `runs` — 一次 `runToolLoop` 生命周期

| 关键字段 | 语义 |
|---|---|
| `id` | **portal 生成的 UUID**，随任务下发给容器；禁止 cwd 派生（规格 §9.3-3：多用户会撞） |
| `status` | 状态机见 §2.1 |
| `termination` | run 结束时由 `runToolLoop` 返回值透传：**对象** `{reason, detail?}` jsonb，`reason ∈ {end_turn, no_tool, stall, max_rounds_cap, reflection_stop, judge_done, continuation_exhausted, aborted, failed}`（依据：erix-agent v0.3.5 `src/loop.js:622`；portal.md §4.1/§5.3）；运行中为 `NULL` |
| `usage` / `cost` | `usage` 为 `{input_tokens, output_tokens}` jsonb（run_end 汇总）；`cost` ⚠️ 待决策者确认（Q1/Q4，P1 可空，见 §5） |
| `error` | 失败时为 `{code, message, retryable}`；run 级错误码见 portal.md §6.4（`rate_limited` / `checkpoint_failed` / `container_exited` / …） |
| `cancel_requested_at` | 停止标记：portal 写、runner 轮询（`AbortController` 跨不了进程，规格 §10.3） |

### 1.8 `messages` — 第①层：人看的对话

见 §3 边界说明。要点：`role` 仅 `user / assistant`；`synthetic` 默认 `false`，judge/wrapup 注入的合成消息置 `true`，**UI 必须显著标记**（规格 §9.2 红线）；`seq` 与 `run_events` 共用 `chat_sessions.last_seq` 分配器，`UNIQUE(session_id, seq)`；`run_id` 关联产生它的 run（用户消息 = 它触发的 run）。

### 1.9 `port_allocations` — 端口分配（DB 是真相，规格 §8.1）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，**FDE 用户**（forward-auth 按预览凭证哈希查 `preview_grants` 解析 `user_id` 后与此列比对，portal.md §2.7；不解析 `cookie.sub`，旧口径作废） |
| `scope` / `run_id` | `project` 级 `run_id` 必空、`run` 级必带 → `CHECK ((scope='run') = (run_id IS NOT NULL))`。⚠️ 待决策者确认（Q5）：P1 先只做项目级，字段先行保留（principles §4 Q5 倾向 (b)） |
| `port` | 容器内 dev 端口，`CHECK (port BETWEEN 4000 AND 4999)`；3001 code-server 是容器固定角色，不入表（规格 §12.3；原 3000 runner 内部 API 角色已取消——容器平台通道零监听，规格 §10.3，决策者 2026-09） |
| `hostname` / `url` | 由 portal **与 Traefik 路由同源生成**（规格 §8.1）；前端只展示/跳转 `url`，永不拼接（portal.md §8-4） |
| `exposure` | `private`（默认）/ `org-visible` / `public`（规格 §6.5；非 admin 申请 `public` 被拒，portal.md §4.7） |
| `state` | 状态机见 §2.2 |

**唯一性设计（本表核心）**：

- `port_allocations_live_port_key`：部分唯一索引 `(fde_id, port) WHERE state <> 'released'`——同一 FDE 容器内一个端口同一时刻至多一条未释放分配；**并发申请靠它 + 事务兜底**（规格 §8.1），释放后端口可复用。
- `port_allocations_live_hostname_key`：活跃 hostname 全局唯一——forward-auth 按 hostname 精确查（portal.md §2.7 第 1 步），「路由表里没有 = 不可达」（原理二）。
- `port_allocations_reaper_idx`：支撑 reaper 回收 `released_at` 过期项（规格 §8.2）。

### 1.10 `transcript_rounds` — 第②层：canonical 消息

见 §3。`UNIQUE(run_id, round)`。**`record` jsonb 存上游 RoundRecord 全量原样，是全量真相**——store 的 `load()` 原样返回它（resume / fold 的输入）；`messages` / `folded` / `folded_payload` 是**派生/加速列**，供 SQL 查询与 UI 使用（决策者 2026-09，D2' 对齐；上游 RoundRecord 形状见 runner-integration §9.1）。fold 只影响视图，**档案完整不删**（规格 §9.2）；fold 后原轮 `UPDATE`（`folded=true` + `folded_payload`），不插新行（runner-integration §9.3）。写入方 = portal internal 端点（`PUT .../transcript/rounds/:round`，按 round 幂等 + `dedupKey` 双保险）；runner 侧是 HTTP adapter 调用方，不直连 DB。

### 1.11 `run_checkpoints` — checkpoint（fail-closed 的落点）

**每 run 一行**（`run_id` 即主键）：上游 store 的 `saveCheckpoint` 是**覆盖写单份**（tmp+rename 原子覆盖）、`loadLatestCheckpoint(runId)` 无参数（依据：erix-agent v0.3.5 `src/store/file.js:279-297`，已 grep 复核）。写入语义 = `INSERT ... ON CONFLICT (run_id) DO UPDATE ... WHERE run_checkpoints.revision < EXCLUDED.revision`（单行覆盖 + **revision CAS**，重试同一 revision 安全；portal.md §9）。**必须成对**（save + load）：工具执行前写失败 → `checkpoint_failed`，任务直接失败（规格 §9.3-1）；HTTP adapter 必须包 retry 且识别其为可重试（规格 §9.3-2，runner-integration §9.2）。原「本地 file 优先 + DB 异步复制」装饰器建议已按决策者裁定**不采纳**（D2' 纯 DB；代价见 runner-integration §9.4）。

**单调性（revision CAS，issue #8）**：`revision bigint NOT NULL DEFAULT 0` 是每 run 的**单调版本号**。worker 每 run 从 0 起递增；portal 端 `DO UPDATE ... WHERE run_checkpoints.revision < EXCLUDED.revision`——**旧 revision 的覆盖写被拒（0 行更新 → `409 checkpoint_stale`）**，解决「延迟到达的旧快照覆盖新快照」。resume（方案 B re-claim）时 worker 经 U9 读回当前 `revision`，继续从 `revision+1` 起计，避免新 worker 从 0 起计被 CAS 误拒。`seq` 仍是**调用方本地元数据、不落库**（其值在数值上可等于 revision，但不具权威性；runner-integration §9.5）。

### 1.12 `run_events` — 第③层：流式事件日志

见 §3。只追加；`seq` 由 portal 落库时从 `chat_sessions.last_seq` 分配（session 内单调递增，portal.md §5.1）；**`client_event_id` 为客户端幂等键**（worker 生成 `run_id:attempt:单调计数`，attempt 为本次 start 次数、计数为该 attempt 内单调递增），`UNIQUE(run_id, client_event_id)` + `ON CONFLICT DO NOTHING` 支撑 agentd 批量上报的 at-least-once 去重（runner-integration §7.3）；`session_id` 为冗余列，支撑 SSE 按 session 补发（`Last-Event-ID`）；`UNIQUE(session_id, seq)`；`type` 清单见 portal.md §5.3，上游 additive 新类型原样透传（故 DB 层不对 `type` 做 CHECK 枚举）。

**`run_end` 唯一性与来源（A4 定稿）**：`type='run_end'` 是 portal 在 U2 终态事务内**合成**的 run 内最后一条事件（worker 不再经 U3 发 `run_end`，runner-integration §7.6），其 `client_event_id` 为确定性值 `run_id:final:run_end`。schema 额外有部分唯一索引 `UNIQUE (run_id) WHERE type='run_end'`（`run_events_run_end_key`），保证**即使 client_event_id 不同，每个 run 也至多一条 `run_end`**；U2 终态重试用 `ON CONFLICT (run_id, client_event_id) DO NOTHING` 去重（同载荷幂等）。

> **事件排序与 attempt 语义（issue #8）**：`seq` 只是**回放游标**（session 全局、按到达顺序分配、严格递增、无空洞），**不是** run 内逻辑顺序；逻辑顺序由 `client_event_id` 的 `(attempt, 计数)` 编码。attempt 使 re-claim 后新 worker 的计数归零也不会与旧 attempt 的 `client_event_id` 碰撞。乱序**到达**不影响正确性（逐事件幂等 + 自包含）；严格递增只对 `seq` 游标成立。详见 runner-integration §7.3/§7.5。

### 1.13 `tool_calls` / `judge_decisions` / `approvals` / `artifacts`

- `tool_calls`：`call_id` 对应事件流的 `tool_call_id`（portal.md §5.3），`UNIQUE(run_id, call_id)`；**`call_id` 是外部 ID（canonical，见 §1.19），`tool_calls.id` 仅内部主键（uuid）、不外露**；`result_digest` 只存摘要（完整结果可能很大）；`approved` 三态（`NULL` = 未涉及审批）。**行由 portal 在 U3 事件上报时幂等 upsert**（`type='tool_use'` 事件 `INSERT ... ON CONFLICT (run_id, call_id) DO NOTHING`，后续 `tool_result`/`tool_call_delta` 更新派生字段，portal.md §9.10）——U10 建审批单时行必已存在。
- `judge_decisions`：judge 事件（`kind / action / decision`）的持久化，与 `run_events` 中 `judge` 类型事件同源。
- `approvals`：**一个工具调用至多一条审批单**（`UNIQUE(run_id, tool_call_id)`，`tool_call_id` 为外部 `call_id`）；`CHECK` 保证 `pending/expired` 与 `decided_at IS NULL` 一致；决定后 runner 轮询继续/终止（portal.md §4.8）。状态机见 §2.3。⚠️ 超时语义已定稿（#10：`pending → expired`，由 portal 打标，topology.md §4-L6）；`tool_call_id` 是否改判 UUID 待 #10 确认。
- `artifacts`：run 产出的文件登记（`kind / path / size / sha`），路径为容器内路径。

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

### 1.20 `fde_llm_bindings` — FDE ↔ LLM 网关虚拟 key 绑定（规格 §11.3）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，主键：每 FDE 一行 |
| `gateway` / `key_id` | 网关标识与网关侧 key id（创建成功后回填） |
| `key_alias` | 业务别名（如 `alice@client-x`），供用量对账映射（规格 §11.3） |
| `state` / `generation` | 状态机见 §2.7；`generation` 为虚拟 key 代次（轮换 +1，旧代次在网关吊销） |
| `revoked_at` / `rotated_at` | 吊销/轮换时刻 |

**红线**：真实 key **绝不存明文**——只写宿主 Traefik 动态配置（600，portal 可写、Traefik 只读）；本表只存 `key_id` / 别名 / 代次（供轮换、吊销、用量对账，topology.md §4-L7/§6 第 8 条）。

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
| `revoked_at` | 显式吊销 / allocation `released` / 用户 `disabled`（portal.md §2.8/§2.9.3） |
| `last_seen_at` | session 最近一次校验通过（滚动续期刷新） |

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

`version text PK` / `checksum text NOT NULL` / `applied_at timestamptz NOT NULL DEFAULT now()`（deploy-contract.md §3）。本文件（schema.sql）即 baseline，记录 `version='0000_baseline'`；baseline 的 checksum 由迁移 runner 在应用后写入真实 sha256（文件无法包含自身哈希，哨兵值见 schema.sql §10）。写入方 = 迁移 runner（`station_platform`）；读取方 = portal readiness（`station_portal` 只读本表，判「迁移到 head」）。

---

## 2. 状态机

> 验收锚点：**每个状态都列出产生方与消费方**。转换由应用层执行，DB 层用 CHECK 限定取值集合；「非法转换」的强制在应用层（portal / runner 各自只写自己负责的转换，见各表「写入方」）。

### 2.1 `runs.status`

```
                 ┌──────────┐  停止(无 runner 领取)   ┌────────────┐
                 │  queued  │ ──────────────────────▶ │ cancelling │
                 └────┬─────┘                         └─────┬──────┘
        runner 领取/开始│                                     │
                 ┌────▼─────┐   POST /stop（cancel_requested）│
                 │ running  │ ◀───────────────────────────────┘ (仅标记，状态仍由 runner 收敛)
                 └────┬─────┘
        run_end 正常  │  异常（checkpoint_failed 重试耗尽 / rate_limited / max_attempts_exceeded）
                 ┌────▼────┐   ┌────────┐
                 │ finished│   │ failed │
                 └─────────┘   └────────┘
   cancelling 收敛：runner 终止后 → finished（termination.reason='aborted'）或 failed
   （崩溃 ≠ 直接终态：worker/agentd 崩 → §2.8 崩溃恢复，attempts 内 re-claim 续跑）
   （例外 A2：容器已死 + cancelling → portal（reaper）收敛 finished/aborted，绝不回 pending 续跑）
```

> UI 上「已取消」是**宿主展示态**：由 `cancel_requested_at` + `termination.reason='aborted'` 推导，不是引擎的 termination 取值（引擎 reason 集合见 §1.7，依据：erix-agent v0.3.5 `src/loop.js:622`/`712`）。

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `queued` | portal：`POST /api/sessions/:id/messages` 创建 run（portal.md §4.3） | agentd：claim 领取并开始（→ `running`，经 internal API，portal.md §9）；portal：stop 端点（→ `cancelling`）、`runs_one_active_per_session` 约束 |
| `running` | agentd 上报 `markRunState`（规格 §9.3），**portal 落库**（D1'） | portal：SSE 状态展示、`GET /api/runs/:id`；FDE：stop / 审批操作的前置状态 |
| `cancelling` | portal：`POST /api/sessions/:id/stop` 写 `cancel_requested_at` + 状态（portal.md §4.5） | agentd：SSE `stop_request`（主）/ 心跳 `stop_run_ids`（兜底）收到后 abort worker（runner-integration §4.3/§10）；portal：SSE 展示「停止中」 |
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
| `users.status` | `active / disabled` | onboarding / offboarding / IdP 对账（规格 §7.3）产生；消费：登录与 forward-auth 拒绝、容器停止 |
| `run_queue.status` | `pending / claimed / done / cancelled` | portal 入队产生 `pending`；agentd claim（→ `claimed`，`claimed_at`/`lease_until`/`owner_container_id`/`claim_token` 必填由 CHECK 强制，attempts+1）→ 完成 `done` / 取消 `cancelled`；租约过期由 reaper 回收（A1/A2 定稿）：`runs.status='cancelling'` → `cancelled` + runs `finished`（aborted）；否则 `attempts < max_attempts` → 回 `pending`（**attempts 不变**），`attempts >= max_attempts` → `done` + runs `failed`（`max_attempts_exceeded`，§2.8） |
| `preview_grants.state` | `active / used / revoked / expired` | `active` 由 portal 签发（ticket）/ forwardAuth 换取（session）产生；`used` 由 forwardAuth 首次校验 ticket 同事务置位；`revoked` 由显式吊销 / allocation released / 用户 disabled 置位；`expired` 由 reaper 按 `expires_at` 懒打标 |

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
| `released`（终态） | portal/reconciler：offboarding 停容器 → 删网络 → 回收子网 | IPAM：块可复用（复用前先腾出该行，见 §1.17）；对账：不再有对应 docker 网络 |

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
| resume | 新 worker | `resume = attempt > 1`；引擎从 `run_checkpoints`（本 run_id 单行）+ `transcript_rounds`（本 run_id）恢复，checkpoint revision 从 U9 读回继续 +1 |
| 副作用隔离 | 平台 | **DB 状态写被 fencing 拒绝**；外部副作用（shell/网络/LLM）平台无法物理终止（原理四），由 attempt 边界 + 审计标记隔离（runner-integration §6.5） |
| 终态 barrier | agentd | 全部事件批（U3）200 确认 + 全部 store 调用完成后，才提交 U2 终态；portal 合成 `run_end` 事件（runner-integration §7.6） |

**方案 B 的代价与 A5 口径（定稿）**：`runs.status` **不**在终态前多次 `running ↔ failed`——attempt 级失败（崩溃/re-claim）**不写 `runs.status`**，只记入 `run_queue.attempts`（claim 时递增）与 `audit_log`（`run.claim` / `run.lease_superseded` / `run.released` / `run.attempt_exhausted`）；`runs.status` 在崩溃恢复期间保持 `queued`/`running`，**只有**耗尽（`max_attempts_exceeded`）或非重试性错误（`checkpoint_failed` 重试耗尽 / `rate_limited`，§2.9）才置终态 `failed`。终态 `failed` 后无自动 resume（如需跨 run 续跑，那是方案 A 的 `resume_from_run_id`，本期不做）。UI 的「第 N 次尝试」由 `run_end.payload.attempt` 与 `audit_log` 展示，而非 `runs.status` 回跳。

### 2.9 `checkpoint_failed` 恢复口径（A3 定稿）

| 项 | 结论 |
|---|---|
| 谁置 `checkpoint_failed` | **worker**：`runToolLoop` 在工具执行前/后 checkpoint 写失败时 fail-closed 抛错（adapter 已按 runner-integration §9.2 做 3 次重试，耗尽后透传）→ agentd 经 U2 终态上报 `failed`，`error={code:'checkpoint_failed', retryable:true}`；portal 落库 |
| 是否可重试 | **adapter 层可重试**（3 次，1s/2s/5s）；**run 层不自动 re-claim**——它是引擎 fail-closed 判定而非进程崩溃，存储故障持续时 re-claim 只会原地重演；因此直接终态 `failed`（与 A1 的崩溃耗尽、A2 的 cancelling 并列的终态来源，不冲突） |
| 恢复时 checkpoint 取哪一份 | **最新已持久化那一份**：`run_checkpoints` 单行，U9 返回的 `snapshot + revision`。失败的那次 save 没有落库（revision CAS 拒旧/失败不写），不存在「半份 checkpoint」；`runs.status='failed'` 终态后不可 resume（终态 barrier） |
| 与 revision CAS 的关系 | 失败写不改变 `run_checkpoints.revision`（要么 0 行更新被拒、要么网络失败未达库）；U9 读回的是上一个成功 revision；若将来启用同 run resume，从 `revision+1` 续计，不冲突 |
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

膨胀来源排序（payload 量级）：`transcript_rounds.messages`（全量 canonical 消息，单 run 可达 MB 级）> `run_events.payload`（事件流，含 delta 逐片）> 其余表（均为小行）。

| 表 | 策略 | 理由 / 依据 |
|---|---|---|
| `run_events` | **热保留，当前不删除**。~~到期导出 JSONL 冷存后 DELETE~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**：事件无限期热保留；将来可选项（保留 N 天后导出 JSONL 冷存、再 `DELETE`）留作分析，见下方运维注记 | 事件的唯一消费是实时推送与断线补发。补发窗口有限的契约语义（过期后 SSE 返回 `410 replay_unavailable`，前端回退全量拉取，portal.md §5.2-4）**保留定义但因当前不删事件而不会触发**——两处口径已对齐（portal.md §5.2 注） |
| `transcript_rounds` | **不删**（resume 源 + 审计），膨胀靠 jsonb 自动 TOAST 压缩吸收。~~session 归档后可整体导出冷存~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**；活跃 session 永不归档 | 规格 §9.2「fold 只影响视图，档案完整」；resume 只可能发生在活跃 session 上 |
| `run_checkpoints` | **每 run 单行**（覆盖写，见 §1.11），无历史 seq 概念；随 run/transcript 同生命周期保留 | 上游 `loadLatestCheckpoint` 无参数、只读最新（唯一消费者），覆盖写天然无积累 |
| `messages` | 永久保留 | 人读层，行小（content + 摘要），是 FDE「关掉明天再打开会话还在」期待的承载（原理三） |
| `usage_ledger` / `audit_log` | 永久保留，只追加 | 记账与审计语义（规格 §14 看板/对账）；量小（每 run 数行 / 每请求一行） |
| `port_allocations`（released） | reaper 定期硬删 `released_at` 过期的记录（规格 §8.2） | 历史归属信息已由 `audit_log`（`port.allocate` / `port.release` 动作）承载 |
| `tool_outputs` | 随 run 生命周期保留（`run_id` 归属）；`body` 靠 TOAST 压缩吸收 | 阈值另存本就是为把大 payload 移出 `run_events`；行数 = 超阈值的工具调用数（topology.md §9） |

**运维注记**：

- 冷存导出 = 「可恢复但不在线」，属**将来可选项（当前不实施**，决策者 2026-09，issue #3 评论**）**：若启用，导出目标可用 `/docker/station-db/archive/`（env §6 目录约定）。需要在线可查的长期归档（P3 之后）再评估分区表（按 `day`/`created_at` RANGE 分区）或独立归档库，**v1 DDL 不上分区**（过早复杂化）。
- 若将来启用 `run_events` 冷存删除，则 `DELETE` 密集，需关注 autovacuum；膨胀监控直接查 DB（原理三：状态在中心）。
- 量级粗估：单 FDE 日 20 runs × 100 事件/run × 2 KB ≈ 4 MB/日/FDE → 个位数 FDE 规模下即使**不删除**、长期热保留，增长亦平缓（年量级 GB），对 275 G 可用磁盘（env §8.1）无压力；transcript 的在线积累是主要增长项，需纳入看板。

---

## 5. `usage_ledger` 记账口径 ⚠️ 待决策者确认（Q1/Q4）

**背景**：Q1（公司是否已有统一 LLM 网关）与 Q4（虚拟 key 粒度）未定（规格 §0）。按 principles §4 当前倾向：Q1 → (b) 没有则起一个 LiteLLM，portal 只做租户绑定，**不自写代理**；Q4 → (a) **每 FDE 一把虚拟 key + 请求打客户项目标签**，不每项目一把（key 数量膨胀）。

**记账口径（当前倾向下的落地）**：

| 项 | 口径 |
|---|---|
| 最小粒度 | **一 run 一条**（`source='erix'`）：worker 在 run 结束时以引擎返回值汇总，随终态载荷经 internal API 上报（portal.md §9 I8），**portal 落** `input_tokens / output_tokens`；`user_id / project_id` 由 `run → session → project` 推导后**冗余落列**（聚合免 join） |
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
| 6 | 规格 §9.3「本地 file 优先 + DB 异步复制」store 装饰器 | 规格为「强烈建议」 | §1.11（影响 `checkpoint_failed` 频率，不影响表结构） |
| 7 | `tool_outputs` 阈值（bytes） | 未定（建议如 4KB/8KB） | §1.19；决定「事件里放 digest、全文落表」的边界 |
| 8 | `route_outbox` 聚合类型枚举（`port_allocation`/`llm_binding`/…） | 实现时定全量清单 | §1.18；reconciler debounce/SLO 已定（topology.md §8），枚举待补 |
| 9 | `fde_networks` 复用前「腾行」的精确做法 | `DELETE` 已释放行 vs 保留并改 `subnet`；历史由 `audit_log` 承载 | §1.17（`UNIQUE(subnet)` 全局唯一所致） |
| 10 | 崩溃恢复方案：**方案 A（新 run + `resume_from_run_id`，不自动 resume）** vs **方案 B（同 run_id re-claim，倾向）** | 倾向 B（principles §3 + 现有 claim/lease/resume 机制；checkpoint/transcript 单行-per-run 天然同 run_id） | §2.8；影响 checkpoint 查询契约、审计/UI（runner-integration §6.5） |
| 11 | `client_event_id` 是否含 attempt 前缀（`run_id:attempt:计数`） | 含（re-claim 后计数归零不碰撞） | §1.12；portal.md §9.4 已同步 |
| 12 | `run_end` 事件唯一产生方：worker 经 U3 vs portal 由 U2 合成 | portal 由 U2 合成（单事务，无事件/终态排序间隙） | §1.12/§2.1；portal.md §5.3 已同步 |
| 13 | checkpoint 单调性：`revision` CAS（旧快照拒绝） | 采用（`run_checkpoints.revision` 已落 DDL） | §1.11；portal.md §9.8 U8/U9 已同步 |
| 14 | 心跳 U4 逐 run 携带 `claim_token` + 部分失败响应 | 采用 | §1.16；portal.md §9.5 已同步 |
| 15 | spool 契约（路径/配额/写满/删除） | 见 runner-integration §7.5（参数 ⚠️） | 不入库（非真相）；§1.12 |
| 16 | `max_attempts` 默认值与耗尽终态 | 默认 3；耗尽 → `failed(max_attempts_exceeded)` | §1.16/§2.8（已落 DDL） |
| 17 | materializer outbox 复用 `route_outbox` vs 新增表 | ✅ 新增 `materialize_outbox` + `materialize_revisions`（A7，避免与路由 reconciler 争抢） | §1.22；user-space.md §7.1 |
| 18 | `checkpoint_failed` 是否自动 re-claim | 不自动 re-claim（终态，人工重发；A3 定稿） | §2.9；portal.md §6.2 需同步提示口径 |
