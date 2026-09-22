# FDE 容器内 runner 集成设计

> 状态：**草案（设计阶段，无实现）**
> 依据：[`fde-platform.md`](fde-platform.md)（主规格，下称「规格 §x」）、[`principles.md`](principles.md)（原理与硬约束）、[`../api/portal.md`](../api/portal.md)（API 契约，下称「portal.md §x」）、[`../data/model.md`](../data/model.md) + [`../data/schema.sql`](../data/schema.sql)（数据模型，下称「model.md §x」）、上游引擎源码 [erix-agent](https://github.com/ErixWong/erix-agent)（本地仓库当前 **v0.3.5**、本地 HEAD `1a511eb`；文中引用均以 v0.3.5 源码实测行号为准，portal.md / model.md / fde-platform.md / schema.sql 均已统一为 v0.3.5 口径，行号一致）。
>
> **本文是平台最核心的实现层设计**：FDE 容器内 `station-agentd` / `station-runner` 两个可执行的进程模型、与 portal 的出站协议、IPC、run 生命周期、事件路径、store adapter、审批中转、失败恢复。目标是「实现者可直接照做」。
>
> **已定决策（不可改）**：
> - **D1' 容器不持有 DB 凭据**：所有 DB 写入经 portal 的 internal HTTP API；容器唯一的平台凭据是 **per-container token**（建容器时生成、存 DB、注入容器）。Postgres 的业务写方只有 portal。（决策者裁定 B 方案；覆盖规格 §10.3「容器 → portal 写 DB」的旧描述）
> - **D2' 存储纯 DB（Postgres），不做 file 副本**：runner 的 TranscriptStore 实现 = 调 portal internal 端点的 HTTP adapter，不是直连 PG，也不落本地 JSONL 副本。（决策者裁定；**明确不采纳**规格 §9.3「本地 file 优先 + DB 异步复制」的强烈建议，其 DB 抖动风险改由 §9.2 的重试包装补偿，代价见 §9.4）
> - **D3' 会话层（createSession/submit/stop/history）由本平台实现**：上游 erix-agent 把「会话管理 / skills / MCP」列为**永久非目标**（erix-agent `docs/requirements.md` §2「非目标（永远不做）」），因此规格 §13.1「等上游抽 `src/session` 发 0.4.0」的 P0 **作废**。
> - **D4' 引擎接口面**：只用上游 run 级能力——`runToolLoop` + `TranscriptStore` 接口 + `erix-agent/tools`（jail / file-tools / registry / recall）+ `erix-agent/contract-tests` + `config/*`。

---

## 1. 目标、非目标与上游边界

### 1.1 目标

1. 在 FDE 容器内提供**常驻桥接进程（station-agentd）**与**每 run 一个的执行进程（station-runner worker）**，把 portal 的会话/任务模型对接到 erix-agent 的 `runToolLoop`。
2. 全部平台通讯**出站**（容器不监听任何对外端口），满足三条不变式（仓库 README）与原理一/三/四。
3. run 的事件、transcript、checkpoint、用量、审批全部经 portal internal API 落中心 DB（D1'/D2'），容器可随时重建（原理三）。
4. 支撑规格 §10 的事件流与 portal.md §5 的 SSE 语义（断线重放、seq 单调）。

### 1.2 非目标

| 非目标 | 归属 |
|---|---|
| agent 逻辑（工具循环、压缩、judge、checkpoint 恢复语义） | erix-agent（原理五） |
| 会话管理 / skills / MCP | 上游**永久非目标**（`docs/requirements.md` §2）；本平台**自己实现会话层**（D3'），skills/MCP 本期不做 |
| 容器创建/销毁/镜像/资源限额 | portal（Docker API，规格 §4/§14） |
| 端口分配与路由 | portal（规格 §8） |
| git clone / git 凭据 / worktree **内容** | FDE 在容器内自理（规格 §7.2/§12.2，决策者裁定）；worktree 的**创建与清理（`remove`/`prune`）归 agentd**（§6.2） |
| LLM 出口管控 | 安全团队网络层（规格 §11.2，issue #3） |

### 1.3 为什么会话层由我们实现（D3'/D4'）

上游 `docs/requirements.md` §2 明文：「❌ agent 人格/skills/会话管理/TUI/MCP」为**永远不做**的非目标。因此规格 §13.1 设想的前置重构（上游抽 `src/session` 发 0.4.0，P0）**不会发生，该 P0 作废删除**。会话层的四个动词在本平台的落点：

| 会话动词 | 本平台落点 |
|---|---|
| `createSession` | portal `POST /api/sessions`（portal.md §4.2），纯 DB 操作 |
| `submit` | portal `POST /api/sessions/:id/messages`（建 run + 入队）→ agentd claim → worker 组装 `runToolLoop` 参数（§6） |
| `stop` | portal `POST /api/sessions/:id/stop`（写 `cancel_requested_at`）→ SSE `stop_request` → agentd abort worker（§4.3/§10） |
| `history` | portal `GET /api/sessions/:id`（`messages` 层）；resume 源 = `transcript_rounds` + 最新 checkpoint（§9） |

worker 侧对上游的**全部**依赖面（D4'，再没有别的）：

| 上游能力 | 导入路径 | 事实锚点（erix-agent v0.3.5 源码） |
|---|---|---|
| `runToolLoop` | `erix-agent` | 参数/返回值 typedef：`src/loop.js:562-626`；`termination` 取值集合：`src/loop.js:622` |
| `TranscriptStore` 接口（6 方法） | 接口约定 | typedef：`src/store/file.js:186-194`；dedupKey 幂等语义：`src/store/file.js:51-56`（`recordKey`）与 `:167`（追加前去重）；checkpoint 覆盖写（tmp+rename 原子覆盖）：`src/store/file.js:279-297` |
| 工具组装 | `erix-agent/tools` | 导出清单：`src/tools/index.js:1-9`（`createJail` / `createFileTools` / `createToolRegistry` / tool providers / `createRecallTool`） |
| 契约测试 | `erix-agent/contract-tests` | `package.json:23-27` exports；`test/contract/index.js` 导出 `transcriptStoreContract` / `modelConfigProviderContract` |
| 配置/凭据解析 | `erix-agent`（`config/*`） | `createJsonFileModelConfigProvider`（`~/.erix/config.json`，含占位 key + `endpoint=https://llm.<base>/v1`）为主；`createStaticModelConfigProvider` / `createEnvModelConfigProvider` / `resolveApiKey` / `apiKeyFile`（`src/config/api-key.js:9-30`）为上游能力，**H-B 下不使用 `apiKeyFile`/`resolveApiKey`**（容器内零 LLM 凭据，§11） |
| 宿主行为注意事项 | 文档 | `docs/host-upgrade-guide-v030.md`：checkpoint fail-closed（§0-4）、多轮必须显式传 `task`（§1 应对清单-2）、`checkpoint_failed` 需宿主 adapter 包重试（§1 应对清单-4） |

> **宿主组装的三个硬注意**（来自上游事实，worker 实现时必须遵守）：
> 1. **多轮显式传 `task`**：本轮用户输入作为 `task` 字符串传入，否则 judge 拿旧种子当基准（`docs/host-upgrade-guide-v030.md` §1-2；`task > context.task > transcript 最后一条 user 文本`，`src/loop.js:597` typedef 注释）。
> 2. **checkpoint store 成对才启用 fail-closed**：`saveCheckpoint`/`appendCheckpoint` 与 `loadLatestCheckpoint` 同时存在才有 `hasCheckpointStore`（`src/loop.js:1181-1184`）。我们的 adapter 八方法全实现（0.9.0 起引擎 fail-closed 校验 8 方法，缺即 run 前 TypeError） → fail-closed 生效：工具执行前/后写失败抛 `checkpoint_failed`（`src/loop.js:1249-1255` 与 `:1317-1322`）。
> 3. **judge 默认行为**：`maxRounds >= 16` 且未显式传 `reflection` 时 judge 自动开启（`src/loop.js:562` 注释）。worker 必须**显式传** `reflection` 配置（开/关/参数），不依赖默认值（host-upgrade-guide §0-1）——具体策略 ⚠️ 见 §15。

---

## 2. 进程模型

### 2.1 容器内进程树

```
FDE 容器（不 publish 任何端口；仅接自己的 `fde-<name>` `/29` 网络，H-B D-1）
│
├─ PID 1: tini（docker run --init）            ← 只负责 reap 孤儿 + 信号转发
│   │
│   └─ station-agentd（主进程，常驻守护/桥接）     ← 唯一持 per-container token
│       │     唯一出站：SSE 下行 + POST 上行 → portal（经 Traefik，https://station.<base>/api/internal/*）
│       │     职责：心跳/领任务/事件批量上报/审批中转/stop 中转/worker 池/孤儿清理
│       │
│       ├─ station-runner（worker，run A）       ← fork 子进程，每 run 一个
│       │     cwd = ~/worktrees/<project>-<runIdA>
│       │     跑 runToolLoop；无凭据；事件经 IPC 交 agentd
│       │     └─ （工具副作用：bash 起的 dev server 等，detached 后由 PID 1 收养）
│       │
│       ├─ station-runner（worker，run B）       ← 并发 run 各一个（上限见 §13）
│       │
│       └─ code-server（:3001，容器内监听，不 publish）← agentd 拉起并守护（崩了重拉）
│
└─ dev servers（:4000+，FDE /agent 经 bash 工具以 setsid/detached 方式拉起）
    父进程退出后被 PID 1（tini）收养，**刻意存活**（预览语义，规格 §8/§12.3）
```

### 2.2 谁是谁的父进程

| 进程 | 父进程 | 拉起时机 | 退出语义 |
|---|---|---|---|
| tini（PID 1） | docker（`--init`） | 容器启动 | 容器生命周期 |
| `station-agentd` | tini | 容器 entrypoint | agentd 退出 = 容器主进程退出 = 容器退出（`restart: unless-stopped` 由 Docker 拉起，规格 §14） |
| `station-runner`（worker） | agentd（`child_process.fork`，独立进程组） | claim 到 run 且 worktree 就绪后 | run 终态即退出；崩溃由 agentd 捕获（§6.4/§12） |
| code-server | agentd（spawn + 守护重拉） | agentd 启动时 | agentd 负责 respawn；连续崩溃退避 |
| dev servers | 起初是 worker 的 bash 工具子进程；`setsid`/nohup 后脱离进程组 | run 进行中（agent 行为） | **run 结束不杀**；真正退出时被 tini reap |

### 2.3 PID 1 与进程编排：方案与取舍 ⚠️

| 方案 | 形态 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **(a) tini + agentd（倾向）** | `docker run --init`，entrypoint 直接 exec agentd | 零额外组件；reap/信号转发由 tini 兜底；agentd 自己管 worker 池（它需要 fork 语义与 IPC 通道，supervisord 给不了） | agentd 需自实现 code-server 守护（几十行）；agentd 崩 → 容器重启（Docker `unless-stopped` 兜底，符合「容器是牲口」） | **倾向采用** ⚠️ 待决策者确认 |
| (b) supervisord 为 PID 1 | supervisord 管 agentd + code-server | 成熟守护；code-server 重拉免费 | 多一层配置与进程；agentd 崩溃时容器不退出（worker 可能已全部脱离控制，状态要靠 portal 租约收敛——反而不如直接重启容器干净） | 备选 |
| (c) agentd 直接做 PID 1 | entrypoint = agentd | 最简 | Node 默认不 reap 无主子进程 → dev server 退出留 zombie；信号语义要自己写对 | 否决（zombie 是长期运行容器的慢性病） |

> **决策点**：(a) 与 (b) 的真实差异只在「agentd 崩溃时容器是否整体重启」。按原理三（容器是牲口、状态在中心），**整体重启更干净**：agentd 崩 → 容器退出 → Docker 拉起 → 新 agentd 重新 SSE + claim，run 由 portal 租约机制 re-claim（§6.4）。

### 2.4 孤儿清理策略

- worker 以**独立进程组** fork（`setsid`）；run 收敛后 agentd 对 worker 进程组 `SIGTERM`（5s 宽限）→ `SIGKILL`。
- bash 工具内以 `setsid` / `nohup ... &` 启动的 dev server **已脱离 worker 进程组**，不受上条影响（这是 dev server 跨 run 存活的机制，不是漏洞）。
- 脱离进程的退出由 tini reap；agentd 定期（60s）扫描自身子进程表，回收已退出未 wait 的 worker 句柄并核对 run 状态（防 IPC 消息丢失导致的悬挂）。

---

## 3. 职责表：agentd vs worker vs portal

| 维度 | station-agentd | station-runner（worker） | station-portal |
|---|---|---|---|
| **凭据** | 唯一持 per-container token（env `ERIX_STATION_TOKEN`） | **无任何平台凭据**（fork 时 env 剔除 token） | 持 DB 凭据；校验 token |
| **UID / 权限** | 独立 UID（唯一持 token 的进程）；最小 capability，不授 `CAP_SYS_PTRACE` | **不同 UID**（fork 时切 UID + 剔除 token）；无特权能力 | 宿主侧进程，不进入容器（无容器 UID 语义） |
| **网络** | 唯一出站：→ portal（SSE + POST，经 Traefik host:443）；不监听任何对外端口 | **无任何平台网络 IO**；只经 IPC 与 agentd 通讯；LLM 请求经 worker 内 provider 发 `llm.<base>`（占位 key，真 key 由 Traefik 注入，规格 §11） | 监听 `:8080`（仅宿主回环 `127.0.0.1:8080`）；internal 端点经 Traefik 回环到 portal |
| **DB** | 不直连（无凭据） | 不直连 | **唯一业务写方**（D1'） |
| **任务** | claim 长轮询领任务；lease 续期（随心跳）；准备工作（worktree）；认领失败 release | 跑 `runToolLoop`；组装引擎参数（provider/tools/store/task） | 入队（`run_queue`）；租约判定与 re-claim；状态收敛 |
| **事件** | 批量（250ms/2KB）、重试、顺序保证、spool 兜底 | 引擎回调 → IPC 即发（不批量） | 分配 seq、写 `run_events`、SSE 广播 |
| **transcript/checkpoint** | store_request 的无状态转发（加 Authorization） | `TranscriptStore` HTTP adapter（IPC 版）的调用方 | 端点落 `transcript_rounds` / `run_checkpoints` |
| **审批** | 中转：worker await ↔ portal 审批单；SSE 快通道 + 轮询兜底；10min 超时拒绝 | 在 `executeTool` 包装层发起并 await；收到拒绝则返回 tool_result「被拒绝」 | 审批单 CRUD、决定写库、SSE 下发 |
| **停止** | SSE `stop_request` / 心跳兜底 → IPC `abort` | `AbortController.abort()` → 引擎收敛 `aborted`（`src/loop.js:712-717`） | 写 `cancel_requested_at`；发 SSE；心跳响应兜底 |
| **进程** | fork/kill worker；code-server 守护；孤儿清理 | 单 run 生命周期 | Docker API 管容器 |
| **明确不做** | 不执行工具、不碰 LLM、不解析 transcript 内容 | 不持凭据、不直连 portal/DB、不管理端口 | 不跑 agent、不执行工具、不自写 LLM 代理（规格 §4） |

---

## 4. portal ↔ agentd 协议（全出站）

### 4.1 总览

| 项 | 取值 |
|---|---|
| Base URL | `https://station.<base>/api/internal`（容器内 `--add-host station.<base>:<本 FDE 网关 IP>`，H-B D-5；`station.<base>` 由 env §10 部署变量 `PORTAL_HOST` 决定） |
| 网络路径 | **经 Traefik**：`Host(station.<base>) && PathPrefix(/api/internal)` + `ipAllowList`（由 `fde_networks` 精确派生，每 `subnet` 一条，topology.md §5.1）限源后回环到 portal `127.0.0.1:8080`；portal 对 internal 前缀不做 forwardAuth（鉴权靠 per-container token，审计由端点自身写 `audit_log` 关键动作） |
| 认证 | 每个请求 `Authorization: Bearer <per-container token>`；portal 由 token 解出 `container_id` / `user_id`，后续所有 `:run_id` 资源校验归属该容器（防跨容器伪造 run_id） |
| 连接 | 两条长驻出站连接：`GET .../stream`（SSE 下行）+ 循环 `POST .../claim`（长轮询）；其余为短请求 |
| 语义基调 | **at-least-once + 幂等**：所有写端点携带客户端幂等键，portal 端 DB 唯一约束兜底；agentd 对所有 5xx/网络错误无限指数退避重试（见 §4.5） |

### 4.2 上行端点（POST/PUT/GET，Bearer）

| # | 端点 | 用途 | 请求体要点 | 响应要点 | 幂等 |
|---|---|---|---|---|---|
| U1 | `POST /api/internal/claim` | **领任务（长轮询）** | `{capacity, hold_ms}`（hold 上限 30s ⚠️） | `200 {ticket}` 或 `204`（hold 超时无任务） | lease + `claim_token`（见下） |
| U2 | `PUT /api/internal/runs/:id/state` | run 状态收敛（`markRunState` 映射 + 终态收敛） | `{state: "running"}` 或终态 `{state: "finished"\|"failed", termination, usage, rounds, final_text, error?}` | `200` | 终态写入幂等（终态不可变，重复提交返回首次结果） |
| U3 | `POST /api/internal/runs/:id/events` | **事件批量上报** | `{batch_id, events: [{client_event_id, type, ts, payload}]}` | `200 {stored, seq_first, seq_last}` | `client_event_id` 唯一（§7.3） |
| U4 | `POST /api/internal/heartbeat` | 心跳 + 租约续期 + stop 兜底轮询 | `{agent_version, runs: [{run_id, status, worker_pid, claim_token}]}` | `200 {now, stop_run_ids: [], revoked: false, runs: [{run_id, lease}]}`（部分失败；`revoked` 字段保留但恒 false——吊销走鉴权阶段 `401 token_revoked`，见 §4.2） | 天然幂等（覆盖写 `last_heartbeat`、续 lease；逐 run 按 claim_token fencing） |
| U5 | `PUT /api/internal/runs/:id/transcript/rounds/:round` | store：`appendRound` | RoundRecord（含 `dedupKey`、`folded`、`messages`、`foldedPayload`） | `200 {inserted: bool}` | `UNIQUE(run_id, round)` + dedupKey（§9.3） |
| U6 | `GET /api/internal/runs/:id/transcript` | store：`load` | — | `200 {records: [...]}` | 只读 |
| U7 | `GET /api/internal/runs/:id/transcript/recall` | store：`recall` | query：`from_round` / `to_round` / `pattern` | `200 {text}` | 只读 |
| U8 | `PUT /api/internal/runs/:id/checkpoint` | store：`saveCheckpoint` / `appendCheckpoint` | `{revision, snapshot}`（`revision` 单调 CAS；`seq` 仅为调用方本地元数据、不落库） | `200` / `409 checkpoint_stale`（旧 revision 被拒） | 单行覆盖写 + revision CAS（§9.5） |
| U9 | `GET /api/internal/runs/:id/checkpoint/latest` | store：`loadLatestCheckpoint` | — | `200 {checkpoint: {snapshot, revision, updated_at}}` / `204`（无） | 只读 |
| U10 | `POST /api/internal/runs/:id/approvals` | 创建审批单 | `{tool_call_id, round, name, input_digest}` | `201 {approval_id}` | 一个工具调用至多一单（`approvals` `UNIQUE(run_id, tool_call_id)`，schema.sql） |
| U11 | `GET /api/internal/approvals/:id` | 审批决定**轮询兜底** | — | `200 {status, decided_by?, decided_at?, note?}` | 只读 |
| U12 | `POST /api/internal/runs/:id/release` | 主动放弃已领任务（准备工作失败 / worker 崩溃） | `{reason}` | `200`；portal 收敛：`runs.status='cancelling'` → queue `cancelled` + runs `finished`（aborted，A2）；否则 `attempts < max_attempts` → 回 `pending`（**attempts 不变**，A1）；`attempts >= max_attempts` → `done` + runs `failed(max_attempts_exceeded)`（耗尽） | 重复 release 返回首次结果 |

**claim（U1）长轮询 hold 语义与超时**：

```
agentd                          portal
  │── POST /claim {hold_ms:30000} ─▶│
  │                                 │ 有 pending 行：
  │                                 │   SELECT ... FOR UPDATE SKIP LOCKED
  │                                 │   → status='claimed', claimed_at=now,
  │                                 │     lease_until=now+90s, attempts++
  │◀────────── 200 {ticket} ────────│
  │                                 │ 无 pending 行：挂起连接（不持有事务/锁）
  │                                 │   · DB LISTEN/NOTIFY 或进程内事件唤醒 → 再查一次
  │                                 │   · 到 hold_ms 仍无 → 204
  │◀────────── 204 ─────────────────│（agentd 立即发起下一次 claim）
```

- ticket 载荷：`{queue_id, claim_token, lease_expires_at, run: {id, session_id, attempt, project: {name, root_path}, task, message_id, model, resume, attachments}}`（`lease_expires_at` 为 API 载荷字段名，对应 schema 列 `run_queue.lease_until`，见 portal.md §9.3；`attempt` = 本次 claim 后的 `run_queue.attempts`，供 worker 生成 `client_event_id` 与审计；`resume = attempt > 1`）。
- `claim_token`：本次认领的凭证；U2/U3/U5-U12 携带（header `X-Claim-Token`）、**心跳 U4 逐 run 携带**（`runs[].claim_token`），portal 校验「该 run 当前有效租约 = 此 token」——**防止旧 agentd（崩溃恢复后）与新 agentd 双写同一 run**（re-claim 后旧 token 失效，`409 lease_lost` / 心跳 `lease_lost`）。
- **领取资格（user_id 路由，issue #8；A2 收紧）**：portal 按「认领容器的 user_id == run 归属 user_id」（run → session → user，由 token 解出）判定领取资格，**不以 `run_queue.container_id`（容器实例）过滤**——容器重建后新容器（同 user）天然可领取旧队列行；`container_id` 仅作入队时目标快照、`owner_container_id` 记当前持有者（schema.sql §8 / model.md §1.16）。**同时只认领 `runs.status IN ('queued','running')` 的 run**：`cancelling`（用户已 stop）/ 终态（`finished`/`failed`）绝不进入认领结果（A2）。
- **唤醒机制**：portal 在 `POST /messages` 入队后 `NOTIFY run_queue`（或单节点进程内 EventEmitter，规格 §10.2 同构）唤醒挂起的 claim；这是「拉取 + portal 侧事件唤醒」，push 优化（P2）后置 ⚠️。
- 并发容量：`capacity` = agentd 当前可再接收的 run 数（§13）；portal 一次至多派发 `capacity` 条（响应数组或逐条，实现细节，契约按单条设计、数组为兼容扩展）。

**heartbeat（U4）语义**：

- 间隔 **15s**（⚠️）；每次携带当前活跃 run 列表，**逐 run 携带 `claim_token`** → portal 对每个 run 校验「当前有效租约的 `claim_token` == 请求携带值」后决定是否续租（`lease_until = now + 90s` ⚠️）。
- 请求体（U4）：

  ```json
  {
    "agent_version": "0.1.0",
    "runs": [
      { "run_id": "9d3b2f1e-...", "status": "running", "worker_pid": 1234, "claim_token": "ct_3f8a..." }
    ]
  }
  ```

- 响应（**部分失败**：单个 run 的租约丢失不使整次心跳失败）：

  ```json
  {
    "now": "2026-09-12T09:00:15.000Z",
    "stop_run_ids": ["9d3b2f1e-..."],
    "revoked": false,
    "runs": [
      { "run_id": "9d3b2f1e-...", "lease": "renewed", "lease_until": "2026-09-12T09:01:45.000Z" },
      { "run_id": "a1b2c3d4-...", "lease": "lease_lost", "reason": "reclaimed" }
    ]
  }
  ```

- 逐 run 结果语义：`lease: renewed` = claim_token 匹配，已续租；`lease: lease_lost` = claim_token 不匹配（该 run 已被 re-claim / 租约易主）→ agentd **本地 abort 该 run 的 worker、丢弃其缓冲与 spool**，不再续传该 run 的任何写。
- `lease_lost` vs `revoked`：`lease_lost` 是 **run 级**（单个 run 的租约被取代），在 `200` 内表达；`revoked`（token 吊销 / offboard）是 **容器级**且**不在 `200` 内表达**——吊销由 `authenticateContainer` 在鉴权阶段直接返回 `401 token_revoked`（三条路径同径：SSE revoke / claim 401 / heartbeat 401 → `beginRevoke`，issue #22 方案②）。agentd 收到即 drain（abort 全部在跑 run → 等 worker 真退出 → 清理 worktree）后退出（审计 #34 F-A/F-C）。`401/5xx` 对非吊销原因才是整次心跳失败（指数退避重试）。
- 响应 `stop_run_ids`：portal 侧 `cancel_requested_at` 已置位但 SSE `stop_request` 可能未达的 run——**停止指令的兜底通道**（SSE 为主、心跳为备）。
- portal 侧判定：**连续 3 次心跳丢失（45s ⚠️）判容器死**（`containers.status → exited` 语义，model.md §2.4）；run 级处置走租约到期 re-claim（§6.4/§6.5）。

**usage 上报**：不单设端点——run 用量随 U2 终态载荷（`usage`）上报，portal 同事务写 `runs.usage` + `usage_ledger`（`source='erix'`，一 run 一条，`UNIQUE(run_id, source)`，model.md §1.14）。

### 4.3 下行通道：`GET /api/internal/stream`（SSE）

常连；断线指数退避重连（1s→2s→5s→10s→30s 封顶）。事件类型表：

| `event:` | 字段 | 语义 | agentd 动作 |
|---|---|---|---|
| `run_assigned` | `{run_id, queue_id}` | **唤醒 hint**：有新任务可领。**不携带权威载荷**（载荷以 claim 响应为准）——hint 到达时任务可能已被其他 capacity 领走，agentd 必须容忍 | 若当前 claim 处于 hold 间隙则立即发起 claim |
| `approval_decision` | `{approval_id, run_id, decision, note, decided_at}` | 审批结果**快通道** | resolve 对应 worker 的 await（§10） |
| `stop_request` | `{run_id, reason}` | portal 已写 `cancel_requested_at`（portal.md §4.5），要求终止 | IPC `abort` → worker；若无此 run（已结束）忽略 |
| `revoke` | `{reason}` | token 吊销 / 容器停用 | 停领新任务；**abort 全部在跑 run**（worker 收敛）后退出——三个信号源（SSE revoke / claim 401 / heartbeat 401 token_revoked）同径（issue #22 beginRevoke） |
| `ping` | `{ts}` | 15s 保活（也可作 SSE 注释行） | 更新「下行健康」标记；连续丢失触发重连 |

> **为什么 SSE 下行而非 portal push 容器 :3000**：原方案（规格 §10.3「portal → 容器 HTTP」）要求容器监听端口 + portal 持 token 主动向容器出示。出站模型下容器**零监听、零入站**，安全收益见 §11.2。下行实时性需求只有三类（派单唤醒 / 审批决定 / 停止），SSE 全部覆盖；其中派单本就是拉取语义（claim），`run_assigned` 只是降低空转延迟的 hint。

### 4.4 认证、授权与审计

- token 生成：建容器时 portal 生成原文（`crypto.randomBytes(32)` base64url），**仅存哈希**（`containers.runner_token_hash`）并**注入容器 env `ERIX_STATION_TOKEN`**（D1'）；轮换/容器重建时 `token_generation + 1`，旧代次哈希失配 → `401 token_revoked`（issue #12）。
- portal 只**校验**哈希、不再向容器出示原文（方向反转，出站模型）；`revoked_at` / `rotated_at` 记录吊销/轮换时刻（schema.sql / model.md §1.4）。
- 每个 internal 请求：portal 校验 token → 解出容器 → 校验 `:id`（run/approval）归属该容器的用户 → 动作落 `audit_log`（`actor_id` 为容器属主；审批创建/状态收敛/心跳吊销响应等关键动作）。
- token 泄漏处置：offboarding/吊销即失效（`401 token_revoked`）；容器重建时换新 token（§12）。

### 4.5 错误码与重试策略

internal 端点错误信封沿用 portal.md §1.1；下表为本通道特有 code：

| HTTP | code | 含义 | agentd 处理 |
|---|---|---|---|
| 401 | `token_invalid` / `token_revoked` | token 错/吊销 | 停领新任务；`token_revoked` 时按 `revoke` 流程退出 |
| 403 | `run_ownership_mismatch` | run 不属本容器 | 记日志告警（视为 bug/攻击），不重试 |
| 404 | `run_not_found` | run 不存在（已清理） | 停止相关上报，收敛本地状态 |
| 409 | `run_terminal` | 向终态 run 写事件/checkpoint/state | 幂等命中：视为成功（`stored` 语义），不再重试 |
| 409 | `lease_lost` | `X-Claim-Token` 失效（run 已被 re-claim）；心跳 U4 则以 run 级 `lease: lease_lost` 表达（非 HTTP 错误，§4.2） | 本地 abort 该 run 的 worker（若还在跑），丢弃缓冲与 spool |
| 409 | `checkpoint_stale` | checkpoint 的 `revision` 不大于当前（旧/乱序快照被 CAS 拒绝） | 视为「本快照已过期」，**不重试**（以最新为准，§9.5） |
| 400 | `validation_failed` | 载荷不合法（与公开端点统一 400，portal.md §9.13） | 不重试，记错误日志（视为 bug） |
| 429 | `rate_limited` | portal 自我保护 | 遵循 `Retry-After` 退避 |
| 5xx / 网络错误 | — | portal/DB 抖动 | **无限指数退避重试**（1s→2s→5s→10s→30s 封顶，抖动 ±20%）；事件缓冲走 §7.4 背压与 spool |

> 补充 run 级错误码（`runs.error.code` 取值，经 U2 终态载荷上报、**非 HTTP code**）：`max_attempts_exceeded`（attempts 耗尽，portal 置终态，§6.4/§6.5）、`spool_full`（spool 写满且内存队列也满，worker 主动失败，§7.5）、`container_exited`（容器死亡且 attempts 耗尽后的终态标注）。这些码的展示口径见 portal.md §6.4。

---

## 5. agentd ↔ worker IPC 消息表

传输：Node `child_process.fork` 内建 IPC 通道（JSON 序列化，有序、可靠、带背压信号）。所有消息 `{type, ...}`；请求/响应式消息带 `req_id`（worker 侧单调递增）。

| `type` | 方向 | 字段 | 语义 |
|---|---|---|---|
| `worker_ready` | worker→agentd | `{pid}` | fork 后握手；agentd 收到后才发 `run_start` |
| `run_start` | agentd→worker | `{run_id, session_id, attempt, task, cwd, project, model, resume, attachments, config: {model_config_path, reflection, wrapup}}` | worker 据此组装 `runToolLoop` 参数（§6.3；`config.json` 内为占位 key + `endpoint=https://llm.<base>/v1`，无独立 key 文件）；`cwd` = 已建好的 worktree；`attempt` = 本次 start 次数（生成 `client_event_id`，§7.3）；`reflection`/`wrapup` 引擎策略由 portal 随 run_start 下发（§6.3-8 的载体） |
| `event` | worker→agentd | `{run_id, client_event_id, type, ts, payload}` | 引擎回调透传（`onEvent` 8 类 / `onDelta` / `onReasoningDelta` / `onToolCall` / `onJudge`），**逐条即发**，批量在 agentd（§7.2）；`onUsage` **不产 IPC `event`**（仅喂 U2 终态载荷，§6.3-6）；`client_event_id` = `run_id:attempt:计数`（§7.3，重启/重领不碰撞） |
| `store_request` | worker→agentd | `{req_id, method, args}` | `method ∈ appendRound/load/recall/markRunState/saveRunState/loadRunState/saveCheckpoint/loadLatestCheckpoint`（0.9.0 八方法）；agentd 映射到 U2/U5-U9/runstate（§9.1），加 token 转发 |
| `store_response` | agentd→worker | `{req_id, ok, result?, error?: {code, message, retryable}}` | 对应 `store_request`；`ok:false` 时 worker 侧 adapter 按 §9.2 重试策略处理 |
| `approval_request` | worker→agentd | `{req_id, run_id, tool_call_id, round, name, input_digest}` | `executeTool` 包装层发起；worker 挂起等待 |
| `approval_decision` | agentd→worker | `{req_id, approval_id, decision: "approved"\|"denied", note?}` | resolve worker 的 await；超时/拒绝语义见 §10 |
| `abort` | agentd→worker | `{run_id, reason}` | 停止指令（SSE `stop_request` 或心跳兜底触发）；worker 调 `AbortController.abort()` |
| `run_finished` | worker→agentd | `{run_id, ok, termination?, usage?, rounds?, final_text?, error?: {code, message, retryable}}` | `runToolLoop` resolve/reject 后发送；worker 随后自行 `process.exit` |
| `log` | worker→agentd | `{run_id, level, msg}` | stdout/stderr 转发（agentd 加 run 前缀统一输出，§14） |

> **背压**：`process.send()` 返回 `false` 表示通道缓冲满 → worker 暂停发送并等 `drain`；但引擎回调（`onEvent` 等）是同步 void（`src/loop.js:1124-1126` 的 `emitEvent` 不等待），无法反压引擎。因此 worker 侧维护**内存事件队列**（上限见 §7.4），`event` 消息一律先入队再由发送循环 drain。

> **为什么不用 worker 本地 HTTP（127.0.0.1）**：fork IPC 自带有序/可靠/背压，零端口零配置；loopback HTTP 是「第二条路」，无收益。

---

## 6. run 生命周期状态机

### 6.1 组合状态（runs.status × run_queue.status × 容器侧进程态）

```
 portal: POST /messages
   │  同事务：runs(queued) + run_queue(pending) + messages(user 行)   [portal 负责]
   ▼
 ┌─────────────┐ run_queue: pending ──(NOTIFY / 事件唤醒)──┐
 │ runs: queued│                                            ▼
 └─────────────┘                              agentd: POST /claim（hold ≤30s）
        │                                      │ 200 ticket：run_queue → claimed
        │                                      │   lease_until = now+90s
        │                                      │   attempts++，发 claim_token     [portal 负责]
        │                                      ▼
        │                            【claimed（租约态）】runs 仍 queued
        │                                      │ agentd 准备工作：
        │                                      │   git worktree add ~/worktrees/<project>-<runId>
        │                                      │        -b agent/<runId>
        │                                      │   fork worker → run_start        [agentd 负责]
        │                            准备失败 → POST /release → queue 回 pending / cancelled
        │                                      ▼
        │                            PUT state running ──▶ ┌──────────────┐
        │                                                  │ runs: running│  [agentd 上报，portal 落库]
        │                                                  └──────┬───────┘
        │            心跳 15s 续租（lease 回到 now+90s）            │  runToolLoop 执行
        │            事件批量上报（seq 分配/落库/SSE）               │
        │                                                          ▼
        │            POST /stop（用户） ──▶ cancel_requested_at ──▶ SSE stop_request / 心跳 stop_run_ids
        │                                  （runs → cancelling）   │  [portal 负责标记；agentd 负责 abort]
        │                                                          ▼
        │                            worker run_finished ──▶ PUT state（终态载荷）
        │                                                          ▼
        │                    ┌─────────────────────────────────────────────┐
        └───────────────────▶│ runs: finished / failed（终态，不可再变）      │  [portal 负责收敛，同事务]
                             │  + run_queue → done/cancelled               │
                             │  + messages 回写 assistant 行（final_text）   │
                             │  + usage_ledger（source='erix'）             │
                             │  + run 级端口释放（P2，model.md §2.2）        │
                             └─────────────────────────────────────────────┘
```

> 与 model.md §2.1 的关系：本文增加了**租约态（claimed）**这一 queue 层子状态（`runs.status` 不变，仍 `queued`）；「cancelling 的收敛者恒为 runner」（model.md §2.1）保持不变——容器死时由 portal 判死路径直接置 `failed`（`container_exited`）。

### 6.2 每一步的负责方

| 步骤 | 负责方 | 失败表现与处置 |
|---|---|---|
| 入队（runs queued + queue pending + user message） | portal | 事务失败 → `POST /messages` 5xx，无副作用 |
| worktree 创建（`git worktree add`） | **agentd**（run 启动前必须存在，故不能留给 agent） | 失败 → `POST /release`；`attempts >= max_attempts` → runs `failed`（`max_attempts_exceeded`） |
| worktree 清理（`worktree remove` / `prune`） | **agentd**（run 结束后回收；FDE/agent 只管理 worktree 内**内容**，不负责脚手架清理） | `.git` 共享，清理时勿误删他 run 的 worktree |
| worker fork + 参数组装 | agentd / worker | fork 失败 → 同 release 路径 |
| 状态收敛（终态事务） | portal | 见 §6.4 agentd 崩溃路径 |
| 租约续期 | agentd（随心跳）→ portal 落库 | 续期失败重试；90s 未续 → re-claim 窗口打开 |

### 6.3 worker 组装 `runToolLoop` 参数（照做清单）

收到 `run_start` 后：

1. **provider**：读 `config.json` 前先经 `manifest.json` 校验（user-space §5.4 硬规则：generation/sha256 一致才读，防跨文件混合版本）→ `createJsonFileModelConfigProvider`（`~/.erix/config.json`）resolve `default` slot；judge/fold 用 `audit` / `fold` slot（规格 §11.4）；API key 用**占位 key**（`endpoint=https://llm.<base>/v1`）——**worker 组装 provider 不需要任何真实密钥**，真实虚拟 key 由 Traefik 按来源子网注入（H-B D-4，§11/§16.2）。
2. **task**：`run_start.task`（本轮用户输入）显式传入（§1.3 硬注意-1）。
3. **tools / executeTool**：`createJail`（jail 根 = `run_start.cwd`，即 worktree）+ `createFileTools` + `createToolRegistry` + `createRecallTool`（`src/tools/index.js:1-9`）；`executeTool` 外包一层审批钩子（§10）与工具事件上报。
4. **store**：IPC 版 HTTP adapter（§9），`runId` = `run_start.run_id`（portal 生成的 UUID，规格 §9.3-3）。
5. **resume**：`run_start.resume === true`（即 `attempt > 1` 的 re-claim）时传 `resume: true`（引擎从 checkpoint 恢复，跳过已执行工具——`executedToolIds` 去重，`src/loop.js:1179-1180`；副作用工具按 tool id 幂等，host-upgrade-guide §0-4）。resume 时 adapter 先经 U9 读回当前 checkpoint 的 `revision`，本地计数从 `revision+1` 续起（§9.5），避免新 worker 从 0 起计被 CAS 误拒。
6. **回调**：`onEvent / onDelta / onReasoningDelta / onToolCall / onJudge` 全部桥接到 IPC `event`；**`onUsage` 不产 IPC `event`**——其值随 U2 终态载荷上报（含 usage 与 compaction_stats，§7.6）；`onPersistenceError` 记日志（store 内部已重试，最终失败会以 `checkpoint_failed` 抛出）。**usage 双源去重**：`onEvent` 里的 `usage` 类事件与 `onUsage` 都可能出现 usage——**记账以 `onUsage` 为准**（随 U2 终态载荷 `usage` 上报 → `usage_ledger`，§4.2）；`onEvent` 的 `usage` 类事件仅实时展示、不产生第二条记账。
7. **signal**：worker 持有 `AbortController`，IPC `abort` 时触发。
8. **reflection**：显式传（不依赖 `maxRounds>=16` 的默认开启，§1.3 硬注意-3）；`wrapup` 显式传（对话型宿主参照 host-upgrade-guide §1 touwaka 的先例评估 `wrapup: false` ⚠️）。
9. **结束**：resolve → `run_finished {ok:true, termination, usage, rounds, final_text}`；reject → 按 `error.code`（`checkpoint_failed` / `rate_limited` / abort→`aborted`）映射 `run_finished {ok:false, error}`。引擎 abort 时 `termination.reason="aborted"`（`src/loop.js:712-717` 的 `fail()`：`signal?.aborted ? "aborted" : "failed"`）。

### 6.4 异常路径（每步谁负责）

> 方案 B（同 run_id re-claim）下，崩溃（worker/agentd/容器/网络分区）统一走「release/reaper → re-claim → resume」，**不直接终态**；真正的终态由 `attempts >= max_attempts` 或非重试性错误触发（§6.5）。

| 场景 | 检测方 | 收敛路径 | 负责方 |
|---|---|---|---|
| claim 后准备工作失败（worktree/fork） | agentd | `POST /release` → `attempts < max_attempts` 回 `pending` 重新被领（**attempts 不变**）；`attempts >= max_attempts` → `done` + runs `failed(max_attempts_exceeded)` | agentd 上报，portal 重排 |
| worker 崩溃（run 进行中） | agentd（`exit` 事件非预期码） | agentd `POST /release`（reason=worker_crashed）→ 立即 re-claim 同一 run（claim 时 `attempts++`，`resume:true`）→ 新 worker 从 checkpoint 续跑（§6.5） | agentd（release + re-claim） |
| agentd / 容器崩溃 | portal（心跳 3 次丢失 = 45s ⚠️） | `containers` 视 `exited`；租约 90s 到期后 reaper（A1/A2）：`runs.status='cancelling'` → queue `cancelled` + runs `finished`（aborted）；否则 `attempts < max_attempts` → claimed 行回 `pending`（**attempts 不变**）；`attempts >= max_attempts` → `done` + runs `failed`。容器重启（Docker `unless-stopped`）后新 agentd re-claim，`resume:true` 继续 | portal（reaper）+ Docker（重启）+ agentd（re-claim） |
| **stop 在 running 中 + 容器死（cancelling）** | portal（心跳丢失）+ reaper | 用户已 stop（`runs.status='cancelling'`）但容器死在 worker abort 之前：租约到期后 reaper **绝不回 pending 续跑**，直接 queue `cancelled` + runs `finished`（`termination.reason='aborted'`，A2）。这是「cancelling 收敛者恒为 runner」的唯一例外——runner 已死，portal 是唯一收敛方 | portal（reaper） |
| re-claim 双写防护 | portal | 旧 `claim_token` 失效 → 旧 agentd（若复活）任何写请求 `409 lease_lost` / 心跳 `lease_lost` → 本地 abort、丢缓冲与 spool | portal 强制 |
| 容器重建 | portal（offboarding/重建 workflow） | 旧 token 吊销、新 token 注入新容器；在跑 run 走租约到期 re-claim（同上）；**领取按 user_id 路由**（新容器同 user 可领，§4.2） | portal |
| 租约丢失后的旧 worker 副作用 | —（见 §6.5「副作用策略」） | DB 状态写被 fencing 拒绝；外部副作用（shell/网络/LLM）平台无法物理终止（原理四），由 attempt 边界 + 审计标记隔离 | portal 标记 + agentd 尽力 abort |
| stop 在 claim 前到达 | portal | queue 行 → `cancelled`、runs → `cancelling` 后由 portal 直接收敛 `finished`（`termination.reason="aborted"`，无 runner 领取路径，model.md §2.1 第一行） | portal |

### 6.5 崩溃恢复方案选择（issue #8）⚠️ 待决策者确认

> **必须先做一个明确选择**：租约过期后旧 run 怎么办。本文按 principles §3（容器是牲口、状态在中心）与既有 claim/lease/resume 机制倾向 **方案 B（同 run_id re-claim）**；方案 A 记录在案作为备选。

| | 方案 A：不自动 resume（新 run + `resume_from_run_id`） | 方案 B：同 run_id re-claim（**倾向**） |
|---|---|---|
| 崩溃后 | 旧 run 直接 `failed/container_exited`；用户新建 run 并显式带 `resume_from_run_id` | 新 agentd（或本地 agentd）re-claim **同一 run**，`resume:true` 续跑 |
| checkpoint 查询 | 需跨 run 读源 run 的 checkpoint（`WHERE run_id = resume_from_run_id`） | `WHERE run_id = $1`（同一 run），无跨 run 语义 |
| transcript resume 源 | 新 run 需把源 run 的 `transcript_rounds` 当自己 load 的输入 → adapter 跨 run 重映射 | `load(run_id)` = 同一 run 的 round，无重映射 |
| 事件/attempt 边界 | 新 run 新事件空间，attempt 语义弱化 | 事件、attempt、副作用全绑原 run |
| 审计 | 一次崩溃 = 两个 run（失败 + 新），需显式关联 | 一次崩溃 = 一个 run 多 attempt，按 attempt 记录 |
| UI | 会话里出现「失败 run + 新 run」两条 | 会话里一个 run，attempt 计数展示（「第 N 次尝试」） |
| 用户动作 | 需手动重发（多一步，易错） | 消息已入队，恢复自动、用户无感 |

**选择方案 B 的理由**：

1. **principles §3**：run 是「用户一次提交」的逻辑单元，容器是牲口；崩溃不应改变 run_id，只改变「谁在跑」。
2. **机制复用**：现有 claim/lease/`claim_token`/`resume` 本就为 re-claim 设计（§4.2 ticket 已有 `resume`）；checkpoint 单行-per-run、`transcript_rounds` `UNIQUE(run_id, round)` 都以 run_id 为键，方案 B 无需跨 run 重映射。
3. **容器崩溃场景天然是 B**：容器死时用户消息已在队列、无「用户新建 run」的机会窗口——必然仍要 re-claim 同一 run。方案 A 只在 worker 崩溃（agentd 存活）场景成立，两套恢复路径会分裂。

**对 checkpoint 查询契约的影响（方案 B）**：`loadLatestCheckpoint(run_id)` 恒按本 run_id 单行读；U9 返回 `revision`，resume 时 worker 续用 `revision+1` 起计（§9.5）。若决策者改选 A，需引入 `runs.resume_from_run_id`（源 run），U8/U9 按源 run 读写 checkpoint、`load/recall` 按源 run 读 transcript——为 A 预留的列**本期不落 DDL**，仅记录改选 A 时的迁移路径。

**对审计与 UI 的影响（方案 B）**：`run_queue.attempts` 每次 claim 递增；`audit_log` 记录 `run.claim` / `run.lease_superseded` / `run.attempt_exhausted`；UI 的 run 详情显示「第 N 次尝试」；`run_end` 事件 payload 带 `attempt`。**方案 B 的代价（A5 定稿）**：`runs.status` 在崩溃恢复期间**保持 `queued`/`running`**，**不**出现 `running ↔ failed(attempt)`——attempt 级失败只记 `run_queue.attempts` + `audit_log`，**不写 `runs.status='failed'`**；真正的 run 级终态 `failed` 仅由 `max_attempts` 耗尽（`max_attempts_exceeded`）或非重试性错误（`checkpoint_failed` 重试耗尽 / `rate_limited`，§9.2 / model.md §2.9）触发。

**租约丢失后的副作用策略（gap #8）**：

- **平台 fencing 只能挡「状态写」，不能挡「外部副作用」**——这是原理四的直接推论：shell/网络/LLM 调用发生在容器内、平台无网络/进程级强制手段，旧 worker 在分区期间可能继续产生外部副作用。
- 隔离手段（尽力而为，非物理保证）：① 双写防护（`lease_lost`）保证旧 worker 的事件/checkpoint/终态全部被拒，**不污染真相**（transcript/事件流只反映当前租约持有者的 attempt）；② 事件 `client_event_id` 带 attempt 前缀，新 attempt 的事件与旧 attempt 严格分界；③ portal 在 re-claim 时写 `audit_log`（`run.lease_superseded`），UI 标注「该 run 曾发生租约易主」；④ agentd 收到 `lease_lost` 后尽力 `SIGTERM/SIGKILL` 本地 worker。
- **不承诺物理终止旧 worker**（容器分区时做不到）；若容器本身已死（重建场景），副作用自然停止。方案 A 下「禁止自动 resume」的含义对照：旧 run 直接终态，不存在「同 run 旧 worker 与 fencing」问题，但代价是每次崩溃都要用户手动介入 + 跨 run checkpoint 重映射。

---

## 7. 事件路径与 seq

### 7.1 端到端路径

```
引擎回调（onEvent/onDelta/onReasoningDelta/onToolCall/onJudge；同步 void，src/loop.js:1124-1126）
  │  <1ms
  ▼
worker 内存队列（client_event_id = run_id:attempt:计数；溢出走 spool，§7.5）
  │  IPC event（drain 循环）
  ▼
agentd 批量缓冲（250ms 或 2KB 先到者触发 ⚠️）
  │  POST /api/internal/runs/:id/events（at-least-once，无限重试）
  ▼
portal：事务内 chat_sessions.last_seq 逐条 +1 分配 seq
       → INSERT run_events（client_event_id 去重）
       → 提交后进程内 EventEmitter 广播
  │  SSE（id: <seq>；portal.md §5）
  ▼
浏览器 EventSource（断线 Last-Event-ID 补发，portal.md §5.2）
```

### 7.2 批量参数

| 参数 | 值 | 说明 |
|---|---|---|
| 时间窗口 | **250ms**（⚠️ 待决策者确认） | 到点即发，不论条数 |
| 大小窗口 | **2KB**（⚠️） | 累积 payload 字节到阈值立即发（delta 洪峰时实际批次间隔远小于 250ms） |
| 单批上限 | 200 条 / 256KB | 防单请求过大；超出切多批顺序发送 |
| 顺序 | worker 单 run 内严格按 `client_event_id`（`run_id:attempt:计数`）递增 | 引擎回调本身有序；批量不重排；跨 attempt 由 attempt 前缀分界（§7.3） |

### 7.3 幂等与 seq

- **at-least-once**：agentd 只有在收到 `200` 后才从缓冲确认删除；任何失败重试整批。
- **幂等键**：`client_event_id`（`run_id + ":" + attempt + ":" + 单调计数`，worker 生成）。portal 端 `INSERT ... ON CONFLICT (run_id, client_event_id) DO NOTHING`，响应 `stored` 为实际插入数；重复批次安全。
  - ✅ **已落地**：`run_events.client_event_id text` + `UNIQUE(run_id, client_event_id)` 已在 schema.sql（§3 run_events / model.md §1.12）；原「待补列」待办删除。
  - **attempt 前缀（issue #8，重启不碰撞）**：`attempt` = 本次 start 次数（claim 后 `run_queue.attempts`，经 ticket `run.attempt` / IPC `run_start.attempt` 下发）；`计数` 为该 attempt 内从 0 递增。re-claim 后新 worker 计数归零也不与旧 attempt 碰撞——否则旧 attempt 的 `run_id:0`、`run_id:1` 会被新 attempt 当重复丢弃。
- **seq 分配**：portal 在**同一事务**内 `UPDATE chat_sessions SET last_seq = last_seq + 1 ... RETURNING`（model.md §1.6），逐事件分配；`UNIQUE(session_id, seq)` 兜底（schema.sql §5 run_events）。seq 只在 portal 产生——worker/agentd 永不自造 seq。
- **缺口检测**：前端按 SSE `id` 检测跳号；跳号 → 断开并以最后收到的 `id` 作 `Last-Event-ID` 重连补发（portal.md §5.2）。portal 广播层同样按 seq 顺序推送（事务提交乱序时按 seq 重排后再发）。
- **断线重放**：portal 端语义已在 portal.md §5.2 定义（补发大于 `Last-Event-ID` 的全部事件）；容器侧 portal↔agentd 通道**无重放概念**——agentd 未确认的事件本地持有，重连后续传。
- **排序语义澄清（issue #8，解决「乱序不影响正确性」vs「严格递增」的矛盾）**：二者指不同的东西——
  - `seq` 是 **session 全局回放游标**：按**到达顺序**分配、严格递增、无空洞（SSE `Last-Event-ID` 依据）；它不是 run 内逻辑顺序。
  - run 内**逻辑顺序**由 `client_event_id` 的 `(attempt, 计数)` 编码。
  - 「乱序不影响正确性」成立，因为：① 逐事件 `client_event_id` 幂等去重，重复/乱序到达不产生副作用；② 事件自包含（无位置依赖）；③ 投递纪律保证 attempt N 的事件在 attempt N+1 之前全部 200 确认或丢弃（§7.5/§7.6），DB 内不存在跨 attempt 乱序混合。「严格递增」只对 `seq` 游标成立，二者不冲突。

### 7.4 背压上限与应急持久化

| 环节 | 上限（⚠️ 待决策者确认） | 超限行为 |
|---|---|---|
| worker 内存队列 | 10000 条或 4MB | 溢出写入 **spool 文件**（§7.5）；drain 后优先补发 spool。**注意：这只是事件通道的应急缓冲，不是 transcript 副本**（D2' 纯 DB 不受影响） |
| agentd 每 run 缓冲 | 20000 条或 8MB | 超限同样落 spool；run 结束后 spool 重传完成才删除文件 |
| agentd → portal POST | 无限重试（§4.5） | 事件不丢的保证点；终态 barrier 见 §7.6 |

### 7.5 spool 契约（事件通道应急缓冲，issue #8）

> **P1 实现状态**：P1 为**内存缓冲**（固定窗口 + 退避重试，`runner/agentd.js`），**spool 落盘未实现**——本节落盘/fsync/`.ack` 游标/配额（`spool_full`）/启动扫描重传为 P2 契约；`runner/README.md` 与 `user-space.md` 的目录权限按契约先行保留。
>
> spool 是**容器本地投递缓冲**，不是真相（真相在 `run_events`，第③层）；不是 transcript 副本（D2'）。容器内路径与用户空间物化契约对齐——**见 `docs/design/user-space.md`**；本文按 `~/.cache/station/spool/<run_id>.jsonl`（= `/home/<user>/.cache/station/spool/`，映射宿主 `/srv/erix/users/<fde>/home/.cache/station/spool/<run_id>.jsonl`，HOME bind mount 持久卷）写死，最终以 user-space.md 为准。

| 项 | 契约 |
|---|---|
| 位置与持久卷 | `~/.cache/station/spool/<run_id>.jsonl`（每 run 一个文件；在 HOME bind mount 内，见 user-space.md §2.4），**必须落在持久卷上**——容器重建后 spool 不丢，新 agentd 可扫描重传 |
| 格式与 append+fsync | append-only JSONL（每行一个事件 `{client_event_id, type, ts, payload}`）；`O_APPEND` 写入，**每个批次 `fsync`（fdatasync）后再视为已持久**，防止容器/进程崩溃丢尾部 |
| ack 游标 | 每个 spool 配兄弟 `.ack` 文件记录「已 200 确认」的字节偏移/行号，ack 后 fsync；重启时从 ack 游标续传。**正确性不依赖 ack 游标**——`client_event_id` 幂等去重使「从 0 重传」也安全，ack 游标只是避免重复发送的优化 |
| 损坏检测与修复 | 扫描时逐行 JSON 解析；若末行不完整（撕裂写），**截断到最后一个完整换行**、丢弃残缺尾行（该尾行从未 ack，run resume 时从 checkpoint 续跑，丢失仅限崩溃 attempt 的流式事件，非真相）；记日志告警 |
| 配额与写满 | 每 run 上限（如 256MB）+ 每容器总上限（如 1GB，⚠️）。写满时：agentd 停止接收新事件（worker 内存队列继续吸收）；若内存队列也满 → worker 触发 `spool_full` 错误 → run 失败（`spool_full`，retryable）——**事件不静默丢，显式失败** |
| 重启扫描 | agentd 启动时扫描 `spool/` 目录：损坏修复（截断）→ 逐文件按序重传未 ack 行 → **在 claim/启动新 run 之前完成**（保证旧 attempt 事件先于新 attempt 进入 DB） |
| 删除时机 | 满足两个条件才删：① run 已终态（finished/failed/cancelled）② ack 游标到达 EOF（全部 200 确认）。终态 run 的 spool 由后台 sweep 定期清理；孤儿 spool（run_id 不存在/终态已久）同样 sweep |

> 与 §7.4 的边界：spool 只缓冲「尚未被 portal 200 确认」的**事件批**（第③层）；transcript（第②层）与 checkpoint 无本地副本（D2'）。spool 不落 DB（schema.sql §5 已注明「spool 非 DB 表」）。

### 7.6 `run_end` 唯一产生方、事件 batch ack 与 U2 终态 barrier（issue #8）

**`run_end` 唯一产生方（已定，A4）：portal 由 U2 终态合成。**

| 方案 | 说明 | 取舍 |
|---|---|---|
| (a) worker 经 U3 发 `run_end` 事件 | worker 把 `runToolLoop` 返回值作为 `type:"run_end"` 事件走事件批量上报 | 存在「`run_end` 事件先到、后续事件后到」的排序间隙；worker 在「发 run_end 后、U2 前」崩溃会留下无终态的事件 |
| (b) portal 由 U2 合成（**已定**） | worker 不发 `run_end` 事件；portal 在 U2 终态事务里**合成**一条 `run_end` 事件（新 seq，payload 取 U2 的 termination/usage/rounds/final_text/compaction_stats） | 终态状态 + `run_end` 事件**同事务原子提交**，无排序间隙；`run_end` 恒为 run 内最后一条事件 |

选 (b) 的理由：U2 终态载荷本就携带 `termination/usage/rounds/final_text/compaction_stats`（§4.2 U2），portal 合成只是把它写成一条带 seq 的事件；单写方、单事务，消除「事件在终态之后到达」整类 bug。worker 侧不再产生 `run_end` 事件（引擎返回值只喂 U2）。

**确定性 `client_event_id` 与 DB 唯一性（A4）**：合成事件的 `client_event_id` 固定为 `run_id:final:run_end`（与 worker 事件的 `run_id:attempt:计数` 命名空间不碰撞）。schema.sql 已有两条兑底：① `UNIQUE(run_id, client_event_id)`（同 id 重放用 `ON CONFLICT DO NOTHING` 去重）；② 部分唯一索引 `UNIQUE(run_id) WHERE type='run_end'`（`run_events_run_end_key`）——**即使 client_event_id 不同，每个 run 也至多一条 `run_end`**。

**U2 终态加锁顺序（A4）**：portal 在 U2 终态事务内按序执行——① `SELECT ... FROM runs WHERE id=$1 FOR UPDATE`（锁 run 行，串行化并发 U2 / reaper / release）；② 校验 `X-Claim-Token` 与当前 `run_queue.claim_token` 一致（或走 reaper 的 portal 收敛路径，见 §6.4 cancelling 例外）；③ 写 `runs` 终态（status/termination/usage/error/ended_at）；④ `run_queue → done`（或 `cancelled`）；⑤ 回写 `messages` + `usage_ledger`；⑥ 从 `chat_sessions.last_seq` 分配 seq 并 `INSERT run_events`（`type='run_end'`，`client_event_id='run_id:final:run_end'`，`ON CONFLICT (run_id, client_event_id) DO NOTHING`）。第 ⑥ 步的 seq 最大，使 `run_end` 恒为 run 内最后一条事件。

**事件 batch ack（U3）**：U3 响应 `200 {stored, seq_first, seq_last}` 即「batch ack」= 该批事件已持久化 `run_events` 并分配 seq。agentd 收到 `200` 才推进 spool ack 游标、从缓冲删除；`stored < 请求条数` 是幂等命中（非错误）。batch ack 是「已落库」确认，不是「已推送到浏览器」确认——SSE 推送是 portal 落库后的派生动作（portal.md §5）。

**U2 终态提交 barrier**：agentd 在发送 U2 终态前必须满足：① 该 run 全部事件批已收到 `200`（batch ack 完成，含 spool 重传）；② 全部 store 调用（U5-U9）已完成。portal 端在 U2 终态事务内：置 runs 终态 + `run_queue → done` + 合成 `run_end` 事件（seq 最大）+ messages 回写 + usage_ledger。终态不可变；此后任何 U3/U5/U8/U10/state 写 → `409 run_terminal`（§4.5）——即终态是「不再接受事件/checkpoint」的硬屏障。`run_end` 事件 payload 带 `attempt`（供 UI 标注第几次尝试）。

---

## 8. 打字机效果

### 8.1 分工

| 侧 | 职责 |
|---|---|
| 服务端 | **不逐字推流**：delta 事件走 §7.2 批量（250ms/2KB）；SSE 原样透传批次内事件 |
| 前端 | 收到一批 `assistant_delta` 后**本地逐字动画**（20–30ms/字 ⚠️）；动画队列积压超过阈值（如 200 字）自动加速/跳播追平，避免「模型已说完、屏幕还在打」 |

> 原理：人眼对 3–5 字/100ms 的平滑输出即感知为「实时打字」；服务端 250ms 批量引入的额外延迟被前端动画队列吸收，总流量下降一个数量级（delta 合并进批次）。

### 8.2 端到端延迟预算表（首字符到达眼球）

| 段 | 预算 | 依据 |
|---|---|---|
| 引擎 `onDelta` → worker 队列 | <1ms | 同进程函数调用（`src/loop.js:610` 回调） |
| worker → agentd（IPC） | 1–2ms | fork 通道，本机 |
| agentd 批量窗口 | 0–250ms | §7.2（平均 ~125ms） |
| agentd → portal POST | 2–10ms | 同宿主机（经 Traefik host:443 回环到 portal 回环 `127.0.0.1:8080`） |
| portal 落库 + 广播 | 2–10ms | 单事务 + EventEmitter |
| SSE → 浏览器 | 5–50ms | 内网/VPN |
| **服务端小计** | **≈140–320ms（p50 ≈ 150ms）** | — |
| 前端动画 | 20–30ms/字，队列自适应加速 | 视觉层，不阻塞后续批次渲染 |

> 对照「直推逐字」方案：首字符快 ~120ms，但 SSE 消息量 ×50（每字一条），DB 写放大同倍。**批量 + 本地动画是以 ~120ms 不可感知延迟换一个数量级的负载**，取舍成立 ⚠️。

---

## 9. store adapter 契约（HTTP 版，D2'）

### 9.1 八方法 → internal 端点映射（0.9.0 起，issue #43）

worker 侧的 `TranscriptStore` 实现 = **IPC client**（`store_request` → agentd → internal 端点）；agentd 是无状态转发（加 `Authorization` + `X-Claim-Token`）。接口语义锚点：上游 typedef `src/store/file.js:175-177`；0.6.0 起引擎 run 前 fail-closed 校验 **8 方法**（缺 `saveRunState`/`loadRunState` 即 TypeError，host-upgrade-guide §2）。

| store 方法 | IPC `method` | internal 端点 | 落库 | 幂等语义 |
|---|---|---|---|---|
| `appendRound(runId, record)` | `appendRound` | U5 `PUT .../transcript/rounds/:round` | `transcript_rounds` | `UNIQUE(run_id, round)`；body 带 `dedupKey`，portal 命中冲突 → `200 {inserted:false}`（对齐上游 dedupKey 语义：`src/store/file.js:51-56`/`167`） |
| `load(runId)` | `load` | U6 `GET .../transcript` | 读 `transcript_rounds` 按 round 升序 | 只读 |
| `recall(runId, from?, to?, pattern?)` | `recall` | U7 `GET .../transcript/recall` | 读 `transcript_rounds`（含 `folded_payload`，对齐上游「折叠原文同属档案」`src/store/file.js:252-261`） | 只读 |
| `markRunState(runId, state)` | `markRunState` | `running` → U2 `PUT .../state`；**引擎终态标记**（succeeded / unverified_error / guard_error / failed / aborted，0.9.0 `termination.js finish()`）→ `PUT .../runstate {state}` | `running` 落 `runs.status`；终态标记合并进 `runs.run_state jsonb` | 覆盖写 / 合并写（见下） |
| `saveCheckpoint(runId, cp)` | `saveCheckpoint` | U8 `PUT .../checkpoint` | `run_checkpoints` | **单行覆盖写 + revision CAS**：每 run 单行（`run_id` 主键），`INSERT ... ON CONFLICT (run_id) DO UPDATE SET snapshot=EXCLUDED.snapshot, revision=EXCLUDED.revision, updated_at=now() WHERE run_checkpoints.revision < EXCLUDED.revision`——旧 revision 被拒（§9.5）；`seq` 仅调用方本地元数据（其值可等于 revision），**不落库** |
| `loadLatestCheckpoint(runId)` | `loadLatestCheckpoint` | U9 `GET .../checkpoint/latest` | 直接取单行（`SELECT ... WHERE run_id = $1`）；返回 `{snapshot, revision, updated_at}`；无 → `204` → adapter 返回 `undefined`（revision 供 resume 续计，§9.5） | 只读 |
| `saveRunState(runId, runState)` | `saveRunState` | `PUT .../runstate {run_state}`（0.6.0 新增，issue #43） | `runs.run_state` jsonb 合并写：`COALESCE(run_state,'{}') \|\| patch`（并并入 `runId`，reference 语义 = 上游 file store） | 合并写 |
| `loadRunState(runId)` | `loadRunState` | `GET .../runstate`（0.6.0 新增） | 读 `runs.run_state`；无 → `204` → adapter 返回 `undefined` | 只读；终态 run 仍可读（同 U9 口径） |

> **markRunState 双路语义（issue #43 拍板）**：`'running'` 仍走 U2（`runs.status`，终态由 worker 经 run_finished → U2 上报，§6.3-9）；引擎终态标记只合并 `run_state.state`，**不触碰 `runs.status`**（宿主终态唯一权威仍是 U2，不变式 3）。
> **recall（0.8.0 退役）**：引擎不再调用 `store.recall`，worker 也不再注册 recall 工具（档案取回归 note 工作流：note_list → note_read，NotesStore 落盘在 run worktree 内）；U7 端点与 adapter 方法保留（既有断言面与只读兼容，非孤儿）。

> `appendCheckpoint`：上游 file 实现即 `saveCheckpoint` 别名（`src/store/file.js:287-289`）；引擎选择顺序是先 `saveCheckpoint` 后 `appendCheckpoint`（`src/loop.js:1193-1199`），adapter 实现 `saveCheckpoint` 即可覆盖。

### 9.2 checkpoint 重试包装（fail-closed 语义下的补偿）

D2' 纯 DB 意味着 portal/DB 抖动会直接传导到引擎的 fail-closed（工具执行前后写失败 → 抛 `checkpoint_failed`，任务直接失败：`src/loop.js:1249-1255`、`:1317-1322`）。按规格 §9.3-2 与 host-upgrade-guide §1-4，**adapter 必须包 retry**：

| 项 | 策略（⚠️ 参数待确认） |
|---|---|
| 重试次数 | 3 次（不含首次） |
| 退避 | 1s → 2s → 5s（指数，±20% 抖动） |
| 可重试错误 | 网络错误、5xx、429；`checkpoint_failed` 语义上可重试（规格 §9.3-2） |
| 不可重试 | 4xx（`validation_failed` / `lease_lost` / `run_terminal` 之外的）→ 直接抛 |
| 耗尽 | 错误透传引擎 → `checkpoint_failed` → run 失败，用户口径见 portal.md §6.2（「进度未丢失，可重新发送继续」） |

> **A3 定稿：`checkpoint_failed` 是终态、不自动 re-claim**。它产生于 worker（`runToolLoop` fail-closed 抛错，adapter 3 次重试耗尽后透传），经 agentd U2 终态上报 `failed`（`error.code='checkpoint_failed', retryable=true`）；**不是**进程崩溃，因此不走 §6.4 的 release/re-claim——存储故障持续时 re-claim 只会原地重演。恢复时 checkpoint 取**最新已持久化那一份**（U9 返回的 `snapshot+revision`），失败的那次 save 未落库、不改变 `run_checkpoints.revision`；需「存储恢复 + 用户重发」（本期无跨 run resume，方案 A 不做）。完整口径见 model.md §2.9。

### 9.3 transcript round 幂等

- worker 每轮只 append 一次；重试经 IPC 同参数重发，portal 端 `UNIQUE(run_id, round)` + `dedupKey` 双保险。
- `folded` 行与原始行共享 `(run_id, round)` 键空间：fold 后原轮更新 `folded=true` + `folded_payload`（`UPDATE` 而非新行），档案完整不删（规格 §9.2，model.md §1.10）。

### 9.4 D2' 的代价与边界（记录在案）

规格 §9.3 曾「强烈建议本地 file 优先 + DB 异步复制」以吸收中心 DB 抖动；D2' 裁定**纯 DB 无 file 副本**后：

- 中心 DB 抖动超过 ~8s（重试窗口）将**杀掉正在跑的任务**（`checkpoint_failed`）。接受该代价的理由：DB 与 portal 同宿主机（规格 §14），抖动窗口小；**失败后为终态，需存储恢复 + 用户重发（新 run）——不自动 re-claim**（A3 定稿，§9.5/§15-16；抖动持续时 re-claim 只会原地重演）。
- **spool 文件（§7.5）不是 transcript 副本**：它只缓冲 SSE 事件流（第③层），第②层 transcript 无本地副本，D2' 语义完整。
- resume 的全部前提（checkpoint 成对、最新 checkpoint 可读）都在 DB，容器重建后由新 worker 经 portal 读回——原理三成立。

### 9.5 checkpoint 单调性（revision CAS，issue #8）

**问题**：U8 曾接收 `seq` 但不落库，单行覆盖写无版本约束 → **延迟到达的旧快照会覆盖新快照**（分区/重试乱序时）。

**规则**：`run_checkpoints` 加 `revision bigint NOT NULL DEFAULT 0`（单调 CAS 版本）；U8 请求带 `revision`（worker 每 run 从 0 递增），portal 落库用：

```sql
INSERT INTO run_checkpoints (run_id, snapshot, revision, updated_at)
VALUES ($1, $2, $3, now())
ON CONFLICT (run_id) DO UPDATE
  SET snapshot = EXCLUDED.snapshot, revision = EXCLUDED.revision, updated_at = now()
  WHERE run_checkpoints.revision < EXCLUDED.revision;  -- 旧 revision 0 行更新 → 409 checkpoint_stale
```

- **旧快照被拒**：`revision <= 当前值` 时 `DO UPDATE ... WHERE` 不命中（0 行更新）→ portal 返回 `409 checkpoint_stale`；worker 侧视为「本快照已过期」，**不重试**（继续以最新为准）。
- **重试安全**：同一 revision 重试同样被拒（`<` 不成立），但语义等价——portal 对 `checkpoint_stale` 返回 `200`（幂等命中）或 `409` 均可，agentd 不重试（对齐 §4.5）。
- **与 `seq` 的关系**：`seq` 仍为**调用方本地元数据、不落库**；其数值在实现上可等于 revision（worker 用一个本地计数同时服务两者），但**权威单调性由 DB 的 `revision` 列保证**，`seq` 无任何约束力。
- **resume 续计**：re-claim 后新 worker 先经 U9 读回当前 `revision`，本地计数从 `revision+1` 续起（§6.3-5），避免从 0 起计被 CAS 误拒；无 checkpoint（U9 `204`）→ 从 0 起计。
- **与 attempt 的关系**：`revision` 是 checkpoint 快照的**跨 attempt 连续单调版本**（同一 run 内），`attempt` 是 start 次数；二者独立（checkpoint 不因 attempt 重置而回落，故 re-claim 后必须续计而非清零）。

---

## 10. 审批中转时序

### 10.1 正常时序

```
FDE 浏览器        portal                agentd               worker（executeTool 内）
     │              │                     │                     │
     │              │                     │◀── approval_request │  工具命中审批策略（judged/高危）
     │              │◀── U10 POST ────────│                     │  worker await 挂起
     │              │    /approvals       │                     │
     │              │ 建 approvals(pending)│                     │
     │◀─SSE judge───│  （judge 事件已流经事件通道，portal.md §5.3-12）
     │  审批卡片出现  │                     │                     │
     │──POST /api/approvals/:id {decision}│                     │
     │              │ 写 decided_at ──────┤                     │
     │              │──SSE approval_decision────────────────────▶│（快通道）
     │              │                     │── approval_decision ▶│  resolve await
     │              │                     │                     │  approved → 执行工具
     │              │                     │                     │  denied   → 返回 tool_result「已被拒绝」
     │              │◀── 事件流继续 ──────│◀──── event ─────────│
```

- **denied 的表现**：worker 不抛错，而是把「该工具调用被 FDE 拒绝」作为 tool_result 文本返回引擎，由模型决定改道或收尾——避免一次拒绝炸掉整个 run。
- **双通道取决定**：SSE `approval_decision` 为主（实时）；worker 挂起期间 agentd 每 **5s**（⚠️）轮询 U11 兜底（SSE 断线时审批不卡死）。先到者生效。
- **超时**：挂起 **10 分钟**（⚠️）无决定 → worker 侧**本地按 denied** 处理（agentd 判定，无需 portal 配合）；portal 侧审批 reaper **同步把审批单 `pending → expired`**（写 `expired_at`，权威审计态「超时未决」，portal.md §9.10 / topology.md §4-L6，issue #10）。迟到决定：`expired` 后再点决定 → `409 approval_expired`（不被接受、不改状态、写审计 `approval.decision_late`）；U11 轮询到 `expired` 时 agentd 按 denied 收敛（run 早已继续）。

### 10.2 边界情形

| 情形 | 行为 |
|---|---|
| **用户离线** | 审批单停 `pending`；worker 挂起等待但 **worker/agentd 均活着** → 心跳照常续租，run 不会被 re-claim；10min 超时 → denied → run 继续（模型收到拒绝反馈） |
| 审批中途用户 stop | SSE `stop_request` → agentd 同时发 `abort` + 以 `denied` resolve 挂起的审批 → 引擎 abort 收敛（`aborted`） |
| run 已终态后 FDE 才点审批 | portal 接受决定、写审计；agentd 侧无等待者，忽略 `approval_decision`（幂等） |
| agentd 重启时存在挂起审批 | run 本身已被 re-claim + resume；审批单仍 `pending`，resume 后的 run 若再次执行到同一工具会**新建审批单**（`UNIQUE(run_id, tool_call_id)` 冲突 → portal 返回原单 `200 {approval_id}`，继续等原单决定） |

---

## 11. 凭据与安全模型

### 11.1 容器内凭据清单（全部）

| 凭据 | 位置 | 持有进程 | 说明 |
|---|---|---|---|
| **per-container token** | env `ERIX_STATION_TOKEN`（建容器时 portal 注入） | **仅 agentd**；fork worker 与 spawn code-server 时均从 env 剔除（code-server 同样不持有，属平台卫生措施；FDE 有 shell，同 UID 可读 agentd 的 `/proc/<pid>/environ` 属「FDE 自损」残余风险，见 §11.2） | 容器唯一平台凭据（D1'）；吊销即 `401 token_revoked` + SSE `revoke` |
| LLM 网关虚拟 key | **容器内不存在**（H-B D-4）；真实虚拟 key 只存在于宿主 Traefik 动态配置（600，portal 可写、Traefik 只读） | **无进程可读**；Traefik 按来源子网注入 `Authorization` | 带额度/模型白名单/可吊销（规格 §11.3 模式 C 的凭据红线）；**不是平台凭据** |
| git 凭据（SSH key / token） | FDE 自行配置（规格 §12.2） | 容器用户进程 | 平台不下发、不代管 |
| DB 凭据 | **无** | — | D1'：Postgres 业务写方只有 portal |
| docker.sock | **不挂载** | — | 不变式一 |

> **容器内零真实 LLM 凭据（H-B D-4 红线，issue #8 清理过时描述）**：容器 config（`~/.erix/config.json`）里只有**占位 key** + `endpoint=https://llm.<base>/v1`；**不存在任何真实 LLM key、没有 `ERIX_API_KEY_FILE`、没有独立 key 文件**——`erix-agent` 的 `apiKeyFile` / `resolveApiKey` / `createEnvModelConfigProvider` / `createStaticModelConfigProvider` 等真实凭据路径在 H-B 下**一律不使用**（§1.3/§6.3）。真实虚拟 key 只存在于宿主 Traefik 动态配置（600），由 Traefik 按来源子网注入 `Authorization`。凡出现「key 文件注入容器 / `ERIX_API_KEY_FILE`」的描述均视为过时。

### 11.2 「容器不监听端口」对比原 push 方案

| 维度 | 原方案：portal → 容器 `:3000` push（规格 §10.3 旧描述） | 本文：全出站（SSE 下行 + POST 上行） |
|---|---|---|
| 容器攻击面 | 监听 3000，共享网络内任何容器可触达（凭 token 校验兜底） | **零监听**（平台通道）；3000 端口角色取消 |
| token 流向 | portal 向容器**出示** token → token 在每个入站请求中传输，容器侧需校验实现 | token 只由容器向 portal 出示（单向）；portal 侧校验 |
| 伪造面 | 误配置/未鉴权端点 = 任务执行入口暴露 | 无入站即无伪造入口；agentd 只信自己发起的 SSE 流 |
| 网络依赖 | portal 需能解析/可达容器（容器名 DNS） | 只需容器 → portal 单向可达 |
| 断连语义 | portal 需感知容器在线（健康检查轮询） | 心跳即在线证明；SSE 断开由 agentd 自重连 |

> 不变式对应：不变式一（容器不持平台密钥——最小化为单 token 且不出 agentd）、不变式二（唯一入口——容器侧无入口）、不变式三（DB 是真相——容器零 DB 凭据、零本地真相）。原理四「先问有没有第二条路」：本设计在容器侧**没有第二条入站路**。

### 11.3 进程边界与残余风险（token 之外的加固）

**UID / 权限策略**：

- **不同 UID 优先**：agentd 与 worker 用**不同 UID**（agentd 是唯一持 token 的进程；worker 以更低权限 UID 运行）。`child_process.fork` 支持 `uid/gid` 参数，在 fork 时切到 worker UID；worker env 里**剔除 `ERIX_STATION_TOKEN`**。
- **同 UID 时的取舍**：若镜像只有单用户（无法建第二个 UID），边界退化为「仅进程约定」——同 UID 下任何进程可读同 UID 进程的 `/proc/<pid>/environ`（含注入 token 的 env）。取舍：要么接受「worker 能读到 token」的残余风险（见下），要么给 agentd/worker 建两个 UID（推荐，模板默认做）。

**`/proc/<pid>/environ` 可读性**：token 经 env 注入 → 出现在 agentd 的 `/proc/<pid>/environ`。同 UID 进程可读；不同 UID 下 Linux 默认权限阻断跨 UID 读取。这是「同 UID = 进程约定不可靠」的根因。

**禁止 ptrace + 最小 capability**：容器不授 `CAP_SYS_PTRACE`（禁 ptrace 读他进程内存/env）；capability 只授运行所需最小集（不授 `NET_ADMIN` / `SYS_ADMIN`）；seccomp/AppArmor 默认 profile 保持。worker 不授任何特权能力。

**残余风险声明（接受）**：FDE 拥有自己容器的 root（或等价权限）→ **接受「FDE 可破坏自己的平台状态」**——可伪造自己的事件 / usage / 终态（例如绕过 agentd 直连 portal 出示自己 token 编数据）。**跨 FDE 由归属校验挡住**：portal 用 token 解出 `container_id` / `user_id`，所有 `:run_id` / 审批资源校验归属该容器（§4.4）→ FDE 不能影响他人、不能读 DB / LLM 凭据。**平台只承诺「他人/平台状态不被单个 FDE 破坏」，不承诺「单个 FDE 自己的数据不被自己伪造」。**

**bind mount 写边界**（`/srv/erix/users/<fde>/`）：

| 文件/目录 | 写方 | 说明 |
|---|---|---|
| 模板 / `AGENTS.md` / `.erix/ports.json` | **portal 原子写**（tmp+rename） | 平台生成；容器只读到完整文件 |
| `~/projects` / `~/worktrees` / `~/cache` | **FDE 可修改** | 工作区，平台不代管内容 |

---

## 12. 失败与恢复矩阵

| 故障 | 检测 | 恢复路径 | 负责方 | 幂等/重试依据 |
|---|---|---|---|---|
| **agentd 崩** | portal 心跳 3 次丢失（45s ⚠️） | Docker `unless-stopped` 重启容器 → 新 agentd 上线 → 租约 90s 到期 → re-claim（`resume:true`、`attempts++` 从 checkpoint 续跑） | portal（判死/reaper）+ Docker + agentd | lease + `claim_token`（旧写 `409 lease_lost` / 心跳 `lease_lost`）；引擎 resume 跳过已执行工具（`src/loop.js:1179-1180`），副作用工具按 tool id 幂等（host-upgrade-guide §0-4） |
| **worker 崩** | agentd `exit` 非预期 | agentd `release` + 立即 re-claim 同一 run（`attempts++`、`resume:true`，§6.4）；`attempts >= max_attempts` → runs `failed(max_attempts_exceeded)` | agentd（release + re-claim） | checkpoint 成对 + revision CAS（§9.5）；transcript round 幂等（§9.3）；`client_event_id` 带 attempt 前缀不碰撞 |
| **portal 崩** | agentd POST/SSE 失败 | agentd 无限退避重试 + 事件缓冲/spool；portal 无状态（状态在 DB），重启即恢复 | agentd（重试） | at-least-once + `client_event_id` 去重（§7.3）；spool ack 游标（§7.5） |
| **DB 抖动** | portal 5xx → agentd 重试；引擎路径 store 调用失败 | 事件通道：重试缓冲，不丢；引擎关键路径：adapter 3 次重试（§9.2），耗尽 → `checkpoint_failed` run 失败（D2' 已接受的代价，§9.4） | agentd + portal | checkpoint UPSERT + revision CAS 幂等；`UNIQUE(run_id, round)` |
| **容器重建** | portal 生命周期操作 | 新 token 注入新容器；在跑 run 走租约到期 re-claim（**按 user_id 路由领取**，§4.2）；workspace 卷保留（bind mount，规格 §12.1/§14），spool 持久卷保留（§7.5） | portal | 同上；token 吊销防旧容器复活；新容器同 user 可领旧队列行 |
| **网络分区（容器↔portal）** | SSE 断开 + POST 超时 | agentd 本地缓冲 + spool；分区愈合后批量补传（seq 由 portal 按到达分配、游标严格递增；run 内逻辑顺序由 `client_event_id` 的 attempt 分界，§7.3）；超 lease 期间 portal 可能 re-claim → 分区侧 agentd 写请求 `409 lease_lost` / 心跳 `lease_lost` → abort 本地 worker、丢缓冲与 spool | agentd（缓冲/补传）+ portal（租约） | `claim_token` 双写防护（§6.4）；事件幂等键（attempt 前缀）；旧 worker 外部副作用由 attempt 边界 + 审计隔离（§6.5） |

---

## 13. 并发模型（一容器多 project 多 run）

| 资源 | 隔离点（每 run 独立） | 共享点（容器级） |
|---|---|---|
| 执行 | **worker 进程**（每 run 一个 fork，崩溃不传染） | CPU / 内存（容器限额，portal 创建参数，规格 §14） |
| 工作目录 | worktree `~/worktrees/<project>-<runId>`（jail 根） | `~/projects/<project>` 仓库本体与 `.git` |
| 分支 | `agent/<runId>` | git 对象库 |
| 端口 | run 级端口块（`4000+slot*8` 起，P2，规格 §8.2） | 项目级固定端口 |
| store 键 | `runId`（UUID，portal 生成下发） | 中心 DB |
| 审批上下文 | 每 `tool_call_id` 一单、每 run 独立挂起点 | 审批 UI 列表（按用户聚合） |
| 事件序 | `client_event_id` 每 run 单调 | `chat_sessions.last_seq`（session 级分配器） |
| HTTP 连接 | — | agentd 的 portal 连接池（SSE×1 + 短请求复用 keep-alive） |
| LLM 凭据 | — | **无**（容器内零 LLM 凭据：占位 key + `endpoint=https://llm.<base>/v1`，真实 key 由 Traefik 按来源子网注入，H-B D-4） |
| MCP | — | 本期不做（上游永久非目标，§1.2）；将来若做，连接池为容器级共享 ⚠️ |

**并发上限**：agentd `capacity` = 最大并发 run 数，默认 **4**（⚠️ 待决策者确认）；claim 时如实申报，portal 不超发。worker_threads 评估（替代 fork 降内存）列为 **P2** 后置项 ⚠️。

---

## 14. 可观测与日志

| 项 | 位置 / 形式 |
|---|---|
| agentd 日志 | stdout → `docker logs fde-<name>`（json-file driver）；关键生命周期单行 JSON（`{ts, level, msg, run_id?}`） |
| worker 日志 | stdout/stderr 经 IPC `log` 消息 → agentd 加 `run_id` 前缀统一输出（避免多 run 交错不可读） |
| 关键事件（必打） | 容器启动/token 校验通过、SSE 连接建立/断开/重连、claim 成功/超时、worktree 创建、worker fork/exit（码）、事件批发送（条数/重试次数）、spool 启用/清排、审批发起/决定/超时、abort 收发、run 收敛上报 |
| 平台侧真相 | 事件/工具调用/judge/审批/用量/审计全在 DB（原理三），看板直接查库（规格 §14） |
| 排障入口 | ① `docker logs fde-<name>` 看 agentd；② `runs.error` + `run_events` 尾段看 run 死因；③ `containers.last_heartbeat` 看活性；④ `run_queue` 看租约/attempts |

> 与 D6（`docs/ops/runbook.md`，docs/README.md 待补齐清单）的引用点：runbook 的「任务卡住」排查 = 本文 §12 矩阵逐行对照；「容器起不来」= §2 进程模型；日志位置以本节为准。

---

## 15. ⚠️ 待决策者确认清单（本文全部标注）

| # | 事项 | 当前倾向 |
|---|---|---|
| 1 | 命名 `station-agentd` / `station-runner` | 采用（可改） |
| 2 | 通讯形态：agentd → portal **SSE 下行 + POST 上行**，容器零监听（取代 portal → 容器 :3000 push） | 采用（§4/§11.2） |
| 3 | 派单：**拉取**（claim 长轮询 hold ≤30s + portal 侧 NOTIFY/事件唤醒）；push 优化 P2 后置 | 采用（§4.2 U1） |
| 4 | 租约/心跳参数：lease 90s、心跳 15s、3 次丢失（45s）判容器死 | 采用（§4.2/§6） |
| 5 | 事件批量：250ms 或 2KB 先到者；打字机 20–30ms/字前端动画 | 采用（§7.2/§8） |
| 6 | worker 隔离：每 run 一个 fork；P2 评估 worker_threads | 采用（§13） |
| 7 | 审批：超时 10min → 按 denied 继续；超时后补决定的处置（§10.1 末） | 采用 |
| 8 | worktree：run 启动时 **agentd 创建**；清理（remove/prune）归 agentd，内容归 FDE（已定，规格 §12.2） | 采用（§6.2） |
| 9 | PID 1：tini（`docker --init`）+ agentd 主进程；agentd 崩 → 容器整体重启 | 倾向 (a)（§2.3） |
| 10 | 单容器最大并发 run 数（capacity）= 4 | 待定（§13） |
| 11 | internal 端点前缀 `/api/internal`、claim 载荷形状、`X-Claim-Token` 头 | 采用（§4） |
| 12 | 背压上限（worker 10000 条/4MB；agentd 20000 条/8MB；spool 机制） | 采用（§7.4） |
| 13 | store adapter 重试参数（3 次，1s/2s/5s） | 采用（§9.2） |
| 14 | `reflection` / `wrapup` 的显式配置值（对话型宿主参照 host-upgrade-guide §1 评估 `wrapup:false`） | 待定（§6.3-8） |
| 15 | 审批轮询兜底间隔 5s | 采用（§10.1） |
| 16 | 崩溃恢复方案：方案 A（新 run + `resume_from_run_id`，不自动 resume）vs 方案 B（同 run_id re-claim） | 已定 B（§6.5；A5 口径：attempt 失败不写 `runs.status='failed'`） |
| 17 | `client_event_id` 含 attempt 前缀（`run_id:attempt:计数`） | 采用（§7.3） |
| 18 | `run_end` 事件唯一产生方：portal 由 U2 合成（worker 不发） | 已定 (b)（§7.6；`client_event_id='run_id:final:run_end'` + 部分唯一索引） |
| 19 | checkpoint 单调性：revision CAS（旧快照 → `409 checkpoint_stale`） | 采用（§9.5；已落 DDL） |
| 20 | 心跳 U4 逐 run 携带 `claim_token` + 部分失败响应（run 级 `lease_lost`） | 采用（§4.2） |
| 21 | 领取资格按 user_id 路由（非 container_id）；`max_attempts` 默认 3、耗尽 → `failed(max_attempts_exceeded)` | 采用（§4.2/§6.4；已落 DDL） |
| 22 | spool 配额/写满/删除参数（每 run 256MB、每容器 1GB） | 待定（§7.5） |

---

## 16. 交叉引用与后续任务修订清单

### 16.1 本文引用的既有契约

| 主题 | 位置 |
|---|---|
| 组件职责 / 网络 / 容器模板 | [规格](fde-platform.md) §4 / §5 / §12 |
| 事件流与 SSE 语义（事件信封 13 类、Last-Event-ID） | [portal.md](../api/portal.md) §5；规格 §10 |
| 数据表（runs / run_queue / run_events / transcript_rounds / run_checkpoints / approvals / containers） | [model.md](../data/model.md) §1；[schema.sql](../data/schema.sql) |
| 状态机基线（runs / queue / approvals） | [model.md](../data/model.md) §2 |
| 三份数据边界（messages / transcript / events 不混） | 规格 §9.2；[model.md](../data/model.md) §3 |
| 错误语义（`checkpoint_failed` / `rate_limited` / `container_exited`） | [portal.md](../api/portal.md) §6 |
| runbook 引用点 | docs/README.md 待补齐清单 D6（本文 §14） |

### 16.2 本文引入、需后续任务对齐的既有文档/schema 修订（本文不负责改动）

| # | 位置 | 冲突/缺口 | 建议修订 |
|---|---|---|---|
| R1 | 规格 §10.3 | 「portal → 容器 HTTP push」「容器 → portal 写 DB + 心跳」与 D1'/D2' 及本文出站模型相反 | 改为：容器全出站（SSE + POST 上行 internal API）；删除容器 :3000 入站角色（§12.3 端口表同步去 3000 runner 行或改为「无」） |
| R2 | 规格 §13.1 / §15 P0 | 「等上游抽 `src/session` 发 0.4.0」P0 已被 D3' 作废（上游永久非目标） | 删除 P0，P1 内容补上「会话层由 portal + agentd/worker 实现（见本文 §1.3）」 |
| R3 | 规格 §9.3 末尾「强烈建议」 | 「本地 file 优先 + DB 异步复制」被 D2' 明确不采纳 | 改写为本文 §9.2/§9.4 的重试包装与代价说明 |
| R4 | portal.md §6.3 | 「portal → FDE 容器 `http://fde-<name>:3000`」不复存在；`container_unreachable` 出现条件变化（pull 下拉取语义：消息落库即 202，容器恢复后自行领取） | ✅ 已改：portal.md §6.3 已按本文 §4 重写（拉模型落库即 202；`container_unreachable` 仅 push 下发模式保留，⚠️ 待决策者确认） |
| R5 | schema.sql §8 `run_queue` | 缺租约字段 | ✅ 已落地：`lease_until timestamptz` + `claim_token text` + `attempts int NOT NULL DEFAULT 0` + `max_attempts int NOT NULL DEFAULT 3`（本文 §4.2/§6）；领取资格改按 user_id 路由（不再 `container_id=$1`，§4.2）；API 载荷名 `lease_expires_at` 保留并与 `lease_until` 对应（portal.md §9.3 已同步 `attempt`/release 语义） |
| R6 | schema.sql `run_events`（§5 引擎持久化） | 缺事件幂等键 | ✅ 已落地：`client_event_id text` + `UNIQUE(run_id, client_event_id)`；格式升级为 `run_id:attempt:计数`（§7.3） |
| R7 | schema.sql `containers`（§2） | 「portal 需持原文调用，故存原文」在出站模型下过时 | ✅ 已改：`containers.runner_token_hash` + `token_generation`/`revoked_at`/`rotated_at`（schema.sql / model.md §1.4） |
| R8 | model.md §3「谁写」表 | 「runner 回写 assistant 回复」在 D1' 下实为 runner 上报、**portal 落库** | 措辞对齐 |
| R9 | 上游行号引用 | 各文档原混用 v0.3.4 / v0.3.5 行号 | ✅ 已统一：全部按 v0.3.5（本地 HEAD 1a511eb）实测标注 |
| R10 | 本文 §1.3/§5/§6.3/§11/§13 及 fde-platform.md §11 / env.md §6 | 「LLM 虚拟 key 文件注入容器（`apiKeyFile`）」已按 H-B D-4 作废：容器内零 LLM 凭据（占位 key + `endpoint=https://llm.<base>/v1`），真实虚拟 key 只存在于宿主 Traefik 动态配置（600） | 已对齐（本文 + fde-platform.md + env.md 均已注明作废；schema.sql 无 LLM 凭据列，无需改动） |
| R11 | schema.sql `run_checkpoints`（每 run 单行，无 `seq` 列） | 本文 §4.2 U8/§9.1 曾写 `UPSERT (run_id, seq)` / `ORDER BY seq`，与 schema 单行覆盖写矛盾 | ✅ 已改：统一为 `ON CONFLICT (run_id) DO UPDATE`；并新增 `revision` 列 + CAS（`WHERE revision < EXCLUDED.revision`，§9.5）；`seq` 仅调用方本地元数据、不落库（portal.md §9.8 已同步 revision） |
| R12 | portal.md §9.5（U4 heartbeat） | 请求 `runs[]` 缺 `claim_token`；响应无 run 级部分失败 | 本文 §4.2 已写清应改成什么样：请求 `runs[].claim_token`；响应加 `runs[]`（`lease: renewed / lease_lost`）+ `revoked` 字段保留（恒 false）。**修订（审计 #34 F-C）**：`lease_lost` 为 run 级、仍在 `200` 内表达（非 HTTP 错误）；`revoked`（容器级吊销）**不在 `200` 内表达**——由鉴权阶段 `401 token_revoked` 给出（SSE/claim/heartbeat 三径同源）。✅ 已转派：portal.md §9.5 已同步 |
| R13 | portal.md §9.8（U8/U9 checkpoint） | 请求/响应无 `revision`；`seq` 口径过时 | U8 请求 `{revision, snapshot}`、响应 `200`/`409 checkpoint_stale`；U9 响应 `{checkpoint: {snapshot, revision, updated_at}}`；`seq` 仅本地元数据。✅ 已转派：portal.md §9.8 已同步 |
| R14 | portal.md §9.4（U3 事件） | `client_event_id` 格式 `run_id:计数` 无 attempt 前缀 | 改为 `run_id:attempt:计数`（attempt 从 claim ticket `run.attempt` 下发）；事件排序/attempt 语义见本文 §7.3。✅ 已转派：portal.md §9.4 已同步 |
| R15 | portal.md §5.3 / §9.6（run_end / U2） | `run_end` 来源未明确；「最后一批事件 200 后才能提交终态」缺 batch ack / 状态机 | `run_end` 事件由 portal 在 U2 终态事务合成（worker 不再经 U3 发 run_end）；payload 带 `attempt`；终态 barrier 见本文 §7.6。✅ 已转派：portal.md §5.3/§9.6 已同步 |
| R16 | portal.md §9.3（U1 claim） | ticket 无 `attempt` 字段 | ticket `run` 加 `attempt`（= claim 后 `run_queue.attempts`）；`resume = attempt > 1`。✅ 已转派：portal.md §9.3 已同步 |
| R17 | portal.md §6.4 / §9.11（release） | `attempts` 耗尽语义与终态码未定 | 新增 run 级错误码 `max_attempts_exceeded` / `spool_full`；`container_exited` 改为「容器死且 attempts 耗尽才终态」；release 语义 `attempts < max → pending` / `attempts >= max → done + failed`。✅ 已转派：portal.md §6.4/§9.11 已同步 |
| R18 | portal.md §9.3（U1 claim） | claim 未过滤 `cancelling`/终态 | A2 定稿：认领资格新增 `runs.status IN ('queued','running')`——`cancelling`（用户已 stop）/终态绝不进入认领结果 |
| R19 | portal.md §9.11（release）/ §6.4 | release/reaper 未分 `cancelling` 分支 | A1/A2 定稿：`cancelling` → queue `cancelled` + runs `finished`（aborted）；否则 `attempts < max` 回 pending（**attempts 不变**）、`attempts >= max` → done + `failed(max_attempts_exceeded)` |
| R20 | portal.md §6.2（checkpoint_failed） | 「进度未丢失，可重新发送继续」暗示跨 run 续跑 | A3 定稿：`checkpoint_failed` 是终态、不自动 re-claim；checkpoint/transcript 数据仍保留（未损坏），但本期无跨 run resume，重发产生新 run |
| R21 | portal.md §5.3 / §9.6（run_end / U2） | 缺确定性 `client_event_id` 与加锁顺序 | A4 定稿：`client_event_id='run_id:final:run_end'`；部分唯一索引 `UNIQUE(run_id) WHERE type='run_end'`；U2 加锁顺序见 §7.6 |
| R22 | deploy-contract.md §3 | `schema_migrations`/baseline 未落地、缺 bootstrap 执行顺序 | A6 已落地：schema.sql §0 幂等创建角色（自包含，空库可单独执行）+ schema.sql §10（`schema_migrations` + 对象级 GRANT）；`docs/data/bootstrap.sql`（超级用户，附加 schema 级授权/环境特有设置，可重复执行）；baseline checksum 由迁移 runner 写入真实 sha256 |

---

## 附录：关键上游事实速查（erix-agent v0.3.5 实测）

| 事实 | 位置 |
|---|---|
| `LoopEvent` typedef（8 类 union） | `src/loop.js:532-543`（union 在 :533） |
| `JudgeEvent` typedef | `src/loop.js:545-552` |
| `runToolLoop` 参数 typedef | `src/loop.js:562-617` |
| 返回值 typedef（`termination` union 在 :622） | `src/loop.js:618-626` |
| abort → `termination.reason="aborted"` 映射（`fail()`） | `src/loop.js:712-717` |
| `emitEvent` 同步 void（`onEvent?.(event)`） | `src/loop.js:1124-1126` |
| resume 去重（`executedToolIds` / `checkpointResults`） | `src/loop.js:1179-1180` |
| checkpoint 成对判定（`hasCheckpointStore`） | `src/loop.js:1181-1184` |
| fail-closed 抛 `checkpoint_failed`（工具执行前/后） | `src/loop.js:1249-1255` / `:1317-1322` |
| `TranscriptStore` 接口 typedef（6 方法） | `src/store/file.js:186-194` |
| dedupKey → recordKey / 追加前去重 | `src/store/file.js:51-56` / `:167` |
| checkpoint 覆盖写（tmp+rename）；`appendCheckpoint` = `saveCheckpoint` 别名 | `src/store/file.js:279-297` |
| 公共导出清单（runToolLoop / providers / store / config / 压缩 / judge） | `src/index.js` |
| tools 子路径导出（jail / file-tools / registry / providers / recall） | `src/tools/index.js:1-9` |
| package exports（`.` / `./tools` / `./contract-tests`） | `package.json:23-27` |
| 会话管理/skills/MCP 为永久非目标 | `docs/requirements.md` §2「非目标（永远不做）」 |
| 宿主升级注意（fail-closed / 显式 task / adapter 包重试 / judge 默认） | `docs/host-upgrade-guide-v030.md` §0 / §1 |
