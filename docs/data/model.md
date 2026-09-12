# 数据模型说明（model.md）

> 状态：**契约基线（阻塞 P1）**
> 依据：[`../design/fde-platform.md`](../design/fde-platform.md) §8/§9/§10（规格，下称「规格 §x」）、[`../design/principles.md`](../design/principles.md)（原理）、[`../env.md`](../env.md)（环境事实，下称「env §x」）。
> 配套：可执行 DDL 在 [`schema.sql`](schema.sql)（`psql -f` 空库可执行，已实测）；API 层字段口径与 [`../api/portal.md`](../api/portal.md) 对齐（下称「portal.md §x」）。
>
> **本文只补契约细节，不重新设计**：规格 §9.1 是表名 + 字段草图，本文与 schema.sql 把它落成可执行模型。与规格冲突时以规格为准并提 issue。

---

## 0. 总览

环境事实（env.md）：DB 为独立 `station-db` 容器，**postgres:16**（env §10），仅 `control` 网络内可达、不 publish 宿主机（env §5），数据目录 `/docker/station-db/`（env §6）。

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
| 账号与认证 | `users` / `login_sessions` / `api_tokens` | 规格 §7 |
| 容器与项目 | `containers` / `projects` | 规格 §4 / §7.2 |
| 会话与对话 | `chat_sessions` / `runs` / `messages` | 规格 §9.1 |
| 端口分配 | `port_allocations` | 规格 §8 |
| 引擎持久化 | `transcript_rounds` / `run_checkpoints` / `run_events` | 规格 §9.2/§9.3 |
| 工具与审批 | `tool_calls` / `judge_decisions` / `approvals` / `artifacts` | 规格 §9.1 |
| 用量与审计 | `usage_ledger` / `audit_log` | 规格 §11.4 / §14 |
| 任务队列 | `run_queue` ⚠️ | 规格 §10.3（拉模型终态，push 模式不启用） |

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
| `fde_name` / `container_name` | 均唯一；`container_name = fde-<name>`，control 网络内 docker DNS 可达（规格 §5.3） |
| `runner_token` | portal → runner 的 Bearer token（规格 §10.3）。**portal 需持原文发起调用，故存原文**（非哈希）；严禁入日志/镜像/仓库（原理 §5 清单） |
| `status` | `creating / running / stopped / exited / removed`（状态机见 §2.4） |
| `agent_version` | erix-agent 版本 pin / canary 的记录点（规格 §14 容器升级流程） |
| `last_heartbeat` | 容器 → portal 只写 DB + 心跳（规格 §10.3）；portal 据此判断 `container_unreachable`（portal.md §6.3）与 `container_exited` |

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
| `termination` | run 结束时由 `runToolLoop` 返回值透传：**对象** `{reason, detail?}` jsonb，`reason ∈ {end_turn, no_tool, stall, max_rounds_cap, reflection_stop, judge_done, continuation_exhausted, aborted, failed}`（依据：erix-agent v0.3.4 `src/loop.js:622`；portal.md §4.1/§5.3）；运行中为 `NULL` |
| `usage` / `cost` | `usage` 为 `{input_tokens, output_tokens}` jsonb（run_end 汇总）；`cost` ⚠️ 待决策者确认（Q1/Q4，P1 可空，见 §5） |
| `error` | 失败时为 `{code, message, retryable}`；run 级错误码见 portal.md §6.4（`rate_limited` / `checkpoint_failed` / `container_exited` / …） |
| `cancel_requested_at` | 停止标记：portal 写、runner 轮询（`AbortController` 跨不了进程，规格 §10.3） |

### 1.8 `messages` — 第①层：人看的对话

见 §3 边界说明。要点：`role` 仅 `user / assistant`；`synthetic` 默认 `false`，judge/wrapup 注入的合成消息置 `true`，**UI 必须显著标记**（规格 §9.2 红线）；`seq` 与 `run_events` 共用 `chat_sessions.last_seq` 分配器，`UNIQUE(session_id, seq)`；`run_id` 关联产生它的 run（用户消息 = 它触发的 run）。

### 1.9 `port_allocations` — 端口分配（DB 是真相，规格 §8.1）

| 关键字段 | 语义 |
|---|---|
| `fde_id` | → `users.id`，**FDE 用户**（forward-auth 的 `cookie.sub` 比对对象，portal.md §2.7 第 4 步） |
| `scope` / `run_id` | `project` 级 `run_id` 必空、`run` 级必带 → `CHECK ((scope='run') = (run_id IS NOT NULL))`。⚠️ 待决策者确认（Q5）：P1 先只做项目级，字段先行保留（principles §4 Q5 倾向 (b)） |
| `port` | 容器内 dev 端口，`CHECK (port BETWEEN 4000 AND 4999)`；3000 runner / 3001 code-server 是容器固定角色，不入表（规格 §12.3） |
| `hostname` / `url` | 由 portal **与 Traefik 路由同源生成**（规格 §8.1）；前端只展示/跳转 `url`，永不拼接（portal.md §8-4） |
| `exposure` | `private`（默认）/ `org-visible` / `public`（规格 §6.5；非 admin 申请 `public` 被拒，portal.md §4.7） |
| `state` | 状态机见 §2.2 |

**唯一性设计（本表核心）**：

- `port_allocations_live_port_key`：部分唯一索引 `(fde_id, port) WHERE state <> 'released'`——同一 FDE 容器内一个端口同一时刻至多一条未释放分配；**并发申请靠它 + 事务兜底**（规格 §8.1），释放后端口可复用。
- `port_allocations_live_hostname_key`：活跃 hostname 全局唯一——forward-auth 按 hostname 精确查（portal.md §2.7 第 1 步），「路由表里没有 = 不可达」（原理二）。
- `port_allocations_reaper_idx`：支撑 reaper 回收 `released_at` 过期项（规格 §8.2）。

### 1.10 `transcript_rounds` — 第②层：canonical 消息

见 §3。`UNIQUE(run_id, round)`；`messages` jsonb 为该轮 canonical 消息数组（模型上下文 + resume 源）；`folded` 只影响视图，**档案完整不删**（规格 §9.2）；`folded_payload` 存 fold 后的展示载荷。只由 store 适配器（规格 §9.3）写入。

### 1.11 `run_checkpoints` — checkpoint（fail-closed 的落点）

`UNIQUE(run_id, seq)`。**必须成对**（save + load）：工具执行前写失败 → `checkpoint_failed`，任务直接失败（规格 §9.3-1）；DB adapter 必须包 retry 且识别其为可重试（规格 §9.3-2）。⚠️ 规格 §9.3 强烈建议「本地 file 优先 + DB 异步复制」装饰器——落地与否影响 `checkpoint_failed` 出现频率，不影响本表结构。

### 1.12 `run_events` — 第③层：流式事件日志

见 §3。只追加；`seq` 由宿主落库时从 `chat_sessions.last_seq` 分配（session 内单调递增，portal.md §5.1）；`session_id` 为冗余列，支撑 SSE 按 session 补发（`Last-Event-ID`）；`UNIQUE(session_id, seq)`；`type` 清单见 portal.md §5.3，上游 additive 新类型原样透传（故 DB 层不对 `type` 做 CHECK 枚举）。

### 1.13 `tool_calls` / `judge_decisions` / `approvals` / `artifacts`

- `tool_calls`：`call_id` 对应事件流的 `tool_call_id`（portal.md §5.3），`UNIQUE(run_id, call_id)`；`result_digest` 只存摘要（完整结果可能很大）；`approved` 三态（`NULL` = 未涉及审批）。
- `judge_decisions`：judge 事件（`kind / action / decision`）的持久化，与 `run_events` 中 `judge` 类型事件同源。
- `approvals`：**一个工具调用至多一条审批单**（`tool_call_id UNIQUE`）；`CHECK` 保证 `pending` 与 `decided_at` 一致；决定后 runner 轮询继续/终止（portal.md §4.8）。状态机见 §2.3。
- `artifacts`：run 产出的文件登记（`kind / path / size / sha`），路径为容器内路径。

### 1.14 `usage_ledger` — 用量台账

记账口径见 §5（⚠️ Q1/Q4）。结构上：`source` 区分 `erix`（引擎 `onUsage`，一 run 一条，`UNIQUE(run_id, source)`）与 `gateway`（网关虚拟 key 拉取，按 `key_alias + day` 聚合，`run_id` 为 NULL 因为 key 粒度到不了 run）——规格 §11.4「两套数都要记」。

### 1.15 `audit_log` — 审计（只追加）

`actor_id` 可空（系统动作 / 未认证的 forward-auth 判定）；forward-auth **每次判定无论通过与否都写**（portal.md §2.7）——「谁在什么时候看了哪个端口」（原理二）。本地 admin 的每次登录/操作强制审计 + 告警（规格 §7.1）。

### 1.16 `run_queue` — 任务队列 ⚠️ 待决策者确认

规格 §10.3：拉模型（容器长轮询 / `LISTEN` 领 `run_queue`）为终态，单机可先用 push。**push 模式下本表不启用**，结构先行落地以免中途迁移。`run_id UNIQUE`（一个 run 至多入队一次）；状态机见 §2.5。

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
        run_end 正常  │  异常（checkpoint_failed / rate_limited / container_exited / …）
                 ┌────▼────┐   ┌────────┐
                 │ finished│   │ failed │
                 └─────────┘   └────────┘
   cancelling 收敛：runner 终止后 → finished（termination.reason='aborted'）或 failed
```

> UI 上「已取消」是**宿主展示态**：由 `cancel_requested_at` + `termination.reason='aborted'` 推导，不是引擎的 termination 取值（引擎 reason 集合见 §1.7，依据：erix-agent v0.3.4 `src/loop.js:622`/`712`）。

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `queued` | portal：`POST /api/sessions/:id/messages` 创建 run（portal.md §4.3） | runner：领取并开始（→ `running`）；portal：stop 端点（→ `cancelling`）、`runs_one_active_per_session` 约束 |
| `running` | runner：开始执行时 `markRunState`（规格 §9.3） | portal：SSE 状态展示、`GET /api/runs/:id`；FDE：stop / 审批操作的前置状态 |
| `cancelling` | portal：`POST /api/sessions/:id/stop` 写 `cancel_requested_at` + 状态（portal.md §4.5） | runner：轮询标记并 abort 工具循环（规格 §10.3）；portal：SSE 展示「停止中」 |
| `finished`（终态） | runner：`run_end`（含 `termination` / `usage` 汇总，portal.md §5.3-13） | portal：消息落 `messages`、用量记 `usage_ledger`、run 级端口释放（→ `released`）；UI：展示 |
| `failed`（终态） | runner：异常退出；portal：心跳丢失判定 `container_exited`（portal.md §6.4） | portal：错误展示与通知（规格 §14 长任务通知）、用量/端口收尾；FDE：重发消息继续（checkpoint 成对恢复） |

> 终态不可再变（无产生新状态的出边）；`cancelling` 的收敛者恒为 runner——容器死了由 portal 心跳检测直接置 `failed`（`container_exited`），不留悬挂 `cancelling`。

### 2.2 `port_allocations.state`

```
 创建（项目/run 端口分配，与 Traefik 路由同一事务）
        │
   ┌────▼─────┐  观测到 dev server 监听 / 首次授权访问   ┌────────┐
   │ allocated│ ──────────────────────────────────────▶ │ active │
   └────┬─────┘                                         └───┬────┘
        │        项目删除 / run 结束 / 配额回收（同事务删路由）      │
        └──────────────────────┬────────────────────────────┘
                            ┌──▼──────┐
                            │ released│（released_at 必填，reaper 定期清理）
                            └─────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `allocated` | portal：项目创建 / run 启动时的分配事务（规格 §7.2 第 3 步 / §8.2） | forward-auth：放行（portal.md §2.7 第 2 步）；portal：生成 `ports.json` + Traefik 路由（同源，规格 §8.1） |
| `active` | portal：观测到端口实际在服务（runner 上报监听或首次授权请求）后升级标记 | forward-auth：放行；UI：预览卡片「在线」展示；报表 |
| `released`（终态） | portal：项目删除 / run 结束 / reaper 回收（规格 §8.2） | forward-auth：**403**（portal.md §2.7）；分配器：端口与 hostname 可复用（部分唯一索引不再覆盖）；reaper：过期清理 |

> ⚠️ 待决策者确认：`allocated → active` 的精确触发条件规格未定义（规格 §8 只列了三个状态名）。当前按「runner 上报端口开始监听，或首次 forward-auth 放行」取先到者实现；该细化不影响转发语义（`allocated` / `active` 一律放行）。

### 2.3 `approvals.status`

```
 runner 工具拦截 / judge 要求审批
        │
   ┌────▼────┐   FDE 决定（POST /api/approvals/:id）
   │ pending │ ──────────────┬──────────────┐
   └─────────┘          ┌────▼────┐    ┌────▼───┐
                        │ approved│    │ denied │
                        └─────────┘    └────────┘
```

| 状态 | 产生方 | 消费方 |
|---|---|---|
| `pending` | runner：judge/工具拦截产生待审批项（规格 §9.1；portal.md §4.8） | FDE：`GET /api/approvals?status=pending` 列表与决定；通知（规格 §14「需审批时通知」） |
| `approved`（终态） | FDE：`POST /api/approvals/:id`（`decision=approve`） | runner：轮询到决定后继续执行该工具调用；审计 |
| `denied`（终态） | 同上（`decision=deny`） | runner：终止该工具调用并反馈引擎；审计 |

> `409 already_decided`（portal.md §4.8）由 `decided_at IS NOT NULL` + 应用层条件更新（`UPDATE ... WHERE status='pending'`）兜底；终态无出边。

### 2.4 次要状态机（一览）

| 表.字段 | 状态集合 | 产生方 → 消费方（要点） |
|---|---|---|
| `containers.status` | `creating / running / stopped / exited / removed` | portal 生命周期操作产生（规格 §7.2/§7.3）；消费：任务下发前的可达性判断（`container_unreachable`，portal.md §6.3）、心跳检测（`running` 长时无心跳 → 视 `exited`） |
| `chat_sessions.status` | `active / archived` | FDE 归档操作产生；消费：列表过滤、SSE 首连策略 |
| `users.status` | `active / disabled` | onboarding / offboarding / IdP 对账（规格 §7.3）产生；消费：登录与 forward-auth 拒绝、容器停止 |
| `run_queue.status` ⚠️ | `pending / claimed / done / cancelled` | portal 入队产生 `pending`；runner 领取（`claimed`，`claimed_at` 必填由 CHECK 强制）→ 完成 `done` / 取消 `cancelled` |

---

## 3. 三份数据的边界与「不混」的落地方式

规格 §9.2 的三层划分（**①≠②≠③，直接混用的后果见规格原文**）：

| 层 | 表 | 内容 | 谁写 | 谁读 | 可折叠 |
|---|---|---|---|---|---|
| ① 人看的对话 | `messages` | 用户输入 + assistant 最终回复（含 `synthetic` 标记的合成消息） | portal（用户消息，POST 时）/ runner（run 结束时回写 assistant 回复） | **UI 唯一对话来源** | 否 |
| ② canonical 消息 | `transcript_rounds` | 模型上下文 + resume 源（含 judge 注入、wrapup、nudge） | **仅 store 适配器**（`appendRound`，规格 §9.3） | **仅 `runToolLoop`**（resume / fold） | 是（fold 只影响视图） |
| ③ 流式事件日志 | `run_events` | 带 seq 的事件信封（portal.md §5.3 全类型） | **仅 store decorator**（事件落库，规格 §9.3-4） | 前端 SSE / 断线重放 | 否 |

「不混」不是纪律口号，落地方式有四层：

1. **物理分表**：三层各自一张表，schema 上没有共用列可互相污染；唯一桥接是 `run_id` / `session_id` 外键（关联 ≠ 混合）。
2. **写入路径单一**：每张表只有一个代码写入方（见上表「谁写」）。UI 渲染**只读 `messages`**；引擎 resume **只读 `transcript_rounds`**；SSE **只读 `run_events`**。代码评审时任何跨层读写（如 UI 直接渲染 transcript）即为 bug。
3. **合成消息的显式标记**：judge 在 transcript 里注入的是 user role 合成消息（规格 §9.2）；凡需进入人读层的合成内容，落 `messages` 时必须 `synthetic = true`（DB 层 `NOT NULL DEFAULT false` + 应用层显式置位），UI 显著标记——不借道、不隐式。
4. **（P2 强化，⚠️ 实现注记）DB 角色分离**：拆 `station_portal` / `station_runner` 两个 DB 角色，用 `GRANT` 把「写 `transcript_rounds`/`run_events`」收归 runner 角色、「写 `messages`」收归 portal 角色，把约定变成权限。P1 单账号先用前 3 层。

> seq 统一：`messages.seq` 与 `run_events.seq` 共用 `chat_sessions.last_seq` 分配器（同事务递增），三层各自的序互不依赖、但对 UI 呈现（消息与事件交错的时间线）有一致的单调序。

---

## 4. 归档与膨胀策略

膨胀来源排序（payload 量级）：`transcript_rounds.messages`（全量 canonical 消息，单 run 可达 MB 级）> `run_events.payload`（事件流，含 delta 逐片）> 其余表（均为小行）。

| 表 | 策略 | 理由 / 依据 |
|---|---|---|
| `run_events` | **热保留，当前不删除**。~~到期导出 JSONL 冷存后 DELETE~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**：事件无限期热保留；将来可选项（保留 N 天后导出 JSONL 冷存、再 `DELETE`）留作分析，见下方运维注记 | 事件的唯一消费是实时推送与断线补发。补发窗口有限的契约语义（过期后 SSE 返回 `410 replay_unavailable`，前端回退全量拉取，portal.md §5.2-4）**保留定义但因当前不删事件而不会触发**——两处口径已对齐（portal.md §5.2 注） |
| `transcript_rounds` | **不删**（resume 源 + 审计），膨胀靠 jsonb 自动 TOAST 压缩吸收。~~session 归档后可整体导出冷存~~ → **暂不考虑（P1/P2 不实施**，决策者 2026-09，issue #3 评论**）**；活跃 session 永不归档 | 规格 §9.2「fold 只影响视图，档案完整」；resume 只可能发生在活跃 session 上 |
| `run_checkpoints` | 随 transcript 同生命周期；resume 只需要**最新** checkpoint，旧 seq 可在 run 结束后只留最大 seq 一条（`loadLatestCheckpoint`，规格 §9.3） | checkpoint 语义决定历史 seq 无消费者 |
| `messages` | 永久保留 | 人读层，行小（content + 摘要），是 FDE「关掉明天再打开会话还在」期待的承载（原理三） |
| `usage_ledger` / `audit_log` | 永久保留，只追加 | 记账与审计语义（规格 §14 看板/对账）；量小（每 run 数行 / 每请求一行） |
| `port_allocations`（released） | reaper 定期硬删 `released_at` 过期的记录（规格 §8.2） | 历史归属信息已由 `audit_log`（`port.allocate` / `port.release` 动作）承载 |

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
| 最小粒度 | **一 run 一条**（`source='erix'`）：runner 在 `run_end` 时以 `onUsage` 汇总落 `input_tokens / output_tokens`；`user_id / project_id` 由 `run → session → project` 推导后**冗余落列**（聚合免 join） |
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
| 3 | `run_queue` 表：pull 模型终态，push 先行 | 规格 §10.3：单机可先 push | §1.16（表先行落地，push 模式不启用） |
| 4 | `port_allocations` `allocated → active` 触发条件 | runner 上报监听 / 首次授权访问，先到者 | §2.2（不影响转发语义） |
| 5 | 三表「不混」的 DB 角色分离（GRANT 强制） | P1 靠写入路径约定，P2 拆角色 | §3-4（实现注记，不影响 schema） |
| 6 | 规格 §9.3「本地 file 优先 + DB 异步复制」store 装饰器 | 规格为「强烈建议」 | §1.11（影响 `checkpoint_failed` 频率，不影响表结构） |
