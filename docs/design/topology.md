# H-B 网络与访问拓扑（topology.md）

> 状态：**定稿（决策者 2026-09 确认 H-B 方案）**
> 依据：GitHub issue #5 的两条定稿评论——[评论 1「H-B 定稿」](https://github.com/ErixWong/erix-station/issues/5)（拓扑、网络/IP 分配、全链路、存储策略、决策记录）与[评论 2「实测证据 · 加固清单 · reconciler 职责 · 影响面」](https://github.com/ErixWong/erix-station/issues/5)（9 项实测证据、10 条加固清单、reconciler 职责、影响面与落地顺序）。两条评论均为决策者确认过的定稿，本文**只承载、不改变**其决策。
>
> **本文是 H-B 网络与访问拓扑的单一事实来源（single source of truth）**：拓扑结构、网络/IP 分配、全链路 L1–L10、路由模型、加固清单、连通矩阵、reconciler 职责、流式与存储策略、实测证据，一律以本文为准。
>
> **与既有文档的关系（已对齐，2026-09-16 审计复核）**：规格 [`fde-platform.md`](fde-platform.md) §3/§5/§6.4/§10.3/§11/§12.3/§14、[`runner-integration.md`](runner-integration.md) §4/§10/§11、[`../env.md`](../env.md) §5/§6 均已按本文修订（旧 `edge`/`control` 拓扑、internal API 不经 Traefik、portal 不 publish、容器内放 LLM key 文件等旧描述已清）；如有残留冲突**以本文为准**。

---

## 1. 定稿决策 D-1 ~ D-10

| # | 决策 | 说明 |
|---|---|---|
| D-1 | **每 FDE 一条独立 `/29` 网络**，取消原 `control` 共享网络 | 隔离靠拓扑（无共享网络 + Docker 不转发跨 bridge 流量），不靠规则 |
| D-2 | **Traefik 走 host 网络（零 docker 网络接入）** | 宿主天然是每座 bridge 的 `.1` 端点 → 可达所有 `/29`；避免 N 次接入（30 FDE = 31 张网卡，实测见 §10 证据 7） |
| D-3 | **portal 走容器网络**（`backend`，与 station-db 同网）+ `publish 127.0.0.1:8080` | 仅宿主回环可达 → 不暴露给 LAN（保住不变式 2） |
| D-4 | **FDE 容器零 LLM 凭据**：Traefik 按来源子网注入 `Authorization` | 见 §4-L7；比「虚拟 key 放容器」更强（实测可覆盖伪造头，§10 证据 8） |
| D-5 | **internal API 经 Traefik**（`/api/internal/*` + 来源白名单 + per-container token） | 避免 portal 接入每条 FDE 网络 |
| D-6 | **文件投递走 portal 直写宿主 bind mount**（`/srv/erix/users/<fde>/`） | 无需任何入站网络（详见 issue #7） |
| D-7 | **流式**：单一合并点（agentd，250ms/2KB）+ 边界 flush；reasoning 粗粒度落库；工具结果阈值另存 | 见 §9 |
| D-8 | **加固三件套**：`INPUT` + `DOCKER-USER` 两层防火墙规则 + `ipAllowList` + `aliasHeadersStrategy: delete`（原「仅 DOCKER-USER」经 §6.1 评审修正为两层） | 见 §6.1 |
| D-9 | **reconciler 声明式收敛**（网络、路由、IP 漂移） | 见 §8 |
| D-10 | **子网由 portal 管 IPAM**（DB 注册表，系统推荐、管理员可改） | 见 §3 |

---

## 2. 网络清单与成员表

### 2.1 终态拓扑

```
┌──────────────────────────────────────────────────────────────────────┐
│ 宿主：既是所有 bridge 的路由器（.1 端点），也是 ingress 的宿主栈         │
│                                                                      │
│  Traefik（host 网络，独占 80/443，--api=false）                        │
│    ├─ station.<base>        → http://127.0.0.1:8080 （portal，回环）   │
│    ├─ *.fde.<base>          → http://10.200.<n>.2:<port>（预览/IDE）   │
│    ├─ llm.<base>            → http://127.0.0.1:4000 （LLM 网关数据面） │
│    └─ /api/internal/*       → http://127.0.0.1:8080 （ipAllowList）    │
│                                                                      │
│  backend 网络（172.30.0.0/24）：portal（publish 127.0.0.1:8080）+ station-db + station-docker-proxy + station-mock-llm（P1）+ LLM 网关（P3）│
│                                                                      │
│  fde-alice 10.200.1.0/29：alice 主容器(.2) + 她的自有服务(.3)…          │
│  fde-bob   10.200.2.0/29：bob 主容器(.2) + …                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件 × 网络 × 地址表

| 组件 | 网络归属 | 对外暴露 |
|---|---|---|
| Traefik | **host** | 宿主 80/443（唯一 ingress） |
| portal | `backend` | 仅 `127.0.0.1:8080`（回环） |
| station-db | `backend` | 无（仅 portal 可达） |
| LLM 网关 | `backend` | 数据面 `127.0.0.1:4000`（回环）；admin 面**不发布** |
| FDE 容器 | **仅自己的 `/29`** | 无 publish（预览经 Traefik） |
| ~~`edge` 网络~~ | **取消** | Traefik 在 host，不需要 |
| ~~`control` 网络~~ | **取消** | 共享网络是横向越权的根因（issue #5 正文的证据），D-1 取消 |

### 2.3 三条网络一览

| 网络 | 类型 | 成员 | 子网 |
|---|---|---|---|
| host | 宿主网络栈 | Traefik（host 网络模式） | —（不占 docker 网络） |
| `backend` | docker bridge（compose 管理，`subnet` 显式声明） | portal + station-db + station-docker-proxy + station-mock-llm（P1 开发期）+ LLM 网关（P3 加入；成员表以 deploy-contract §2.1 为准） | **显式 `172.30.0.0/24`**（与 FDE 池 `10.200.0.0/16` / `10.201.0.0/16` 彻底隔离） |
| `fde-<name>` | docker bridge（portal 经 Docker API 按 `--subnet` 显式创建） | 该 FDE 的主容器 + 其自有服务（db/redis/sidecar） | `10.200.<n>.0/29`（大 FDE 为 `10.201.<n>.0/28`，见 §3） |

---

## 3. 地址规划与 IPAM

| 项 | 取值 |
|---|---|
| 默认池 | `default-address-pools: [{ base: "10.200.0.0/16", size: 29 }]` → **8192** 条 FDE 网络 |
| 大 FDE 段 | 预留 `10.201.0.0/16`（`/28`，13 个容器位）给需要多个自有服务的 FDE |
| `/28` 内分配 | `.1` 宿主网关 / `.2` FDE 主容器 / `.3–.14` FDE 自有服务与备用（12 位；可分配 `.2–.14` 共 13 位） |
| `/29` 内分配 | `.1` 宿主网关 / `.2` FDE 主容器 / `.3` FDE 自有服务（db/redis/sidecar）/ `.4–.6` 备用（5 位） |
| IPAM 归属 | **portal 管**：DB 表 `fde_networks`（见 [schema.sql](../data/schema.sql) / [model.md](../data/model.md) §1.17；`fde_id` 主键、`subnet`/`network_name` 唯一、`prefix_len ∈ {29,28}`、`pool ∈ {default,large}`、`state` allocated→active→released）；系统推荐下一块空闲，管理员可改；docker 用 `--subnet` 显式创建 |
| 扩展 | Docker 不能改已有网络子网 → 扩容 = 重建网络（数据在 bind mount，容器是牲口） |

> **保留地址与可分配范围**：`/29` = 8 位（`.0` 网络、`.1` 网关、`.7` 广播 → 可分配 `.2–.6` 共 **5** 位）；`/28` = 16 位（`.0` 网络、`.1` 网关、`.15` 广播 → 可分配 `.2–.14` 共 **13** 位）。**`10.200.0.0/16` 与 `10.201.0.0/16` 保留给 FDE 网络专用**；`backend`（`172.30.0.0/24`）与其它 compose/自动网络不得使用这两段。

> 注：H-B 下平台服务**不占用** FDE 子网地址，所以 `/29` 的 5 个容器位**全部留给 FDE 侧**（这正是选 `/29` 而非 `/30` 的理由：有些 FDE 要跑自己的 db/多服务）。

**portal 分配器语义**：

1. onboarding 时查 `fde_networks`，推荐下一块空闲子网（默认池 `/29`；管理员显式指定时从大 FDE 段取 `/28`）；
2. 管理员可在推荐值基础上改（同池内换块、或显式提为 `/28`，见 §12 遗留项 2）；
3. 写 `fde_networks` 与 `docker network create --subnet` 同属 reconciler 的 onboarding 编排（§8），DB 是注册表真相；
4. offboarding 回收子网（`fde_networks.state` 流转），块可复用；
5. 已建网络的子网不可改 → 「扩容 = 重建网络」：重建由 reconciler 执行，容器数据在 bind mount 不受影响（原理三）。

---

## 4. 全链路（L1–L10）

### L1 用户 → portal

`浏览器 https://station.<base>` → Traefik(host:443) → `127.0.0.1:8080` → portal。
认证 = portal 自己的 **host-only session cookie `__Host-fde_session`**（`Secure`/`HttpOnly`/`SameSite=Lax`/`Path=/`、**无 `Domain`**；issue #6 后，取值细节以 [`../api/portal.md`](../api/portal.md) §2.5 为准）。SSE 回传需 `flushInterval`（§6 第 5/10 条）。

### L2 用户 → 预览/IDE

`浏览器 https://<fde>-<tok>-<port>.fde.<base>` → Traefik → **forwardAuth**（`127.0.0.1:8080/api/forward-auth`，查 `port_allocations.hostname` + 按 token 哈希查 `preview_grants`，**不解析 cookie `sub`**；portal 自身会话校验才查 `login_sessions`）→ 200 后代理到 `http://10.200.<n>.2:<port>`。
预览凭证 = **一次性 ticket（`?preview_ticket=`）换取的 host-only 预览 cookie `__Host-fde_preview`**，**绝不用 portal session cookie**（portal cookie 为 host-only、不会发到预览域，issue #6）。**这是唯一「用户直连容器」的链路**（iframe 内嵌 portal 页面）。执行顺序 / 失败语义 / 信任边界见 §5.2。

### L3 agentd → portal（internal API）

```
N 个 worker ──IPC──▶ agentd（唯一 HTTP 客户端、唯一持 token）
                        │ https://station.<base>/api/internal/*（--add-host station.<base>:<网关IP>）
                        ▼
                  Traefik:443 → ipAllowList(精确 CIDR，由 fde_networks 派生，§5.1) → 127.0.0.1:8080 → portal（Bearer 校验）
```

- **物理通道只有一条**（agentd 聚合），worker 零凭据、零网络 IO
- 逻辑上按 `run_id` 隔离：claim（长轮询）/ heartbeat（含租约续期）/ events（批量）/ rounds / checkpoint / usage / approvals / finish（端点契约见 [runner-integration.md](runner-integration.md) §4.2）
- 断线：agentd 重连 + 未确认事件重传（at-least-once + `client_event_id` 幂等，见 issue #8）
- **hosts 注入（创建 FDE 容器时，docker `--add-host` 或等价受控方式）**：`station.<base>` 与 `llm.<base>` 都映射到**该 FDE 的 bridge 网关 IP**（默认池 `10.200.<n>.1`；大 FDE `10.201.<n>.1`），**不走内网/公网 DNS**。开发期 `*.localhost` 变通对容器无效，必须同样注入（env.md §0/§1）

### L4 用户 →「自己容器里的 agent」（对话）—— **不存在直连链路**

```
① 浏览器 POST /api/sessions/:id/messages → Traefik → portal
② portal 同事务：messages(user) + runs(queued) + run_queue(pending) → 202
③ agentd 经 L3 claim（原子认领 + 租约）→ fork worker
④ worker 跑 runToolLoop
⑤ 引擎回调 → IPC → agentd → L3 批量 events → portal 分配 seq 落库 → SSE → 浏览器
```

> 用户与 agent 之间**没有直连通道**，portal(+DB) 是汇合点。用户感知的「每个 agent」= 每个 session/run 的逻辑通道。

### L5 停止

`portal 写 cancel_requested_at` → agentd（下行 SSE / 心跳响应）→ IPC abort → worker `AbortController.abort()` → `termination.reason=aborted` → 事件回传。

### L6 审批

`worker 在 executeTool await` → IPC → agentd → L3 → portal 建审批单 → 用户浏览器（L1）决定 → portal 写库 → agentd（下行）→ worker 继续/拒绝；**超时 10min 由 portal 打 `expired`**（修 issue #10 的审计失真）。

### L7 LLM 调用（**Traefik 注入凭据**）

```
worker（零凭据，占位 key + endpoint=https://llm.<base>/v1；`llm.<base>` 经 L3 的 hosts 注入解析到本 FDE 网关 IP）
  │ POST https://llm.<base>/v1/chat/completions（可带任意 Authorization）
  ▼
Traefik(host:443)
  ① router：Host(`llm.<base>`) && ClientIP(`<该 FDE 精确 subnet>`)   ← 身份来自网络来源，非自报；subnet 由 fde_networks 精确派生：默认池 `10.200.<n>.0/29`、大 FDE `10.201.<n>.0/28`（§5.1）
  ② middleware：customRequestHeaders 覆盖 Authorization: Bearer <该 FDE 虚拟 key> + X-FDE-Identity
  ③ service → http://127.0.0.1:4000（网关数据面，回环）
  ▼
LLM 网关（按 key 做额度/模型白名单/用量）→ 上游 provider
```

**实测**：A 子网拿到 alice 的 key、B 子网拿到 bob 的 key；两者主动带的 `Authorization: Bearer STOLEN-KEY` **被覆盖**；无匹配来源 **404**（§10 证据 8）。
**配套**：`aliasHeadersStrategy: delete`（防头别名伪造，Traefik 自行警告过，§10 证据 9）、无兜底路由、流式 `flushInterval`、网关 admin 面只在 `backend`。
**边界**：「不能直连外部 LLM」仍靠**安全团队网络层出口策略**（issue #3），Traefik 只负责平台允许的那条路。

### L8 端口/路由发布与 IP 漂移

建项目 → portal 同事务写 `port_allocations` + **route outbox** → reconciler 生成 Traefik 动态配置（**每 allocation 一条 router+service**，修 issue #9 的「单通配 service」缺陷，见 §5）→ file provider reload。
容器重建（IP 变）→ reconciler 检测 → 重写后端 IP → reload。**这是 H-B 的唯一技术债**（后端用 IP 而非容器名），由 reconciler 兜住（§8）。

### L9 数据库

`portal(backend) → station-db:5432`。其它组件**既无凭据也无网络路径**。

### L10 收紧（详见 §6 第 7 条）

允许：FDE 子网 → 宿主 :443；拒绝：FDE 子网 → 宿主其它端口（实测可达 gitea/mssql/portainer，必须拦，§10 证据 2 的反面与 §6 第 7 条）。

---

## 5. 路由模型

| 路由 | 规则 | middleware | service | 说明 |
|---|---|---|---|---|
| portal | `Host(`station.<base>`)` | — | `http://127.0.0.1:8080` | L1 |
| 预览/IDE（**每 allocation 一条 router + 一条 service**） | `Host(`<fde>-<tok>-<port>.fde.<base>`)` | `fde-auth`（forwardAuth）→ `strip-cookie`（放行后删 Cookie，预览凭证不透传上游，B2 实测） | `http://10.200.<n>.2:<port>` | **否决「单通配 service」**（issue #9）：单 service 无法表达 per-allocation 的后端地址与生命周期；每条 allocation 独立 router+service，由 route outbox + reconciler 生成（L8） |
| LLM（**每 FDE 一条 router + 一条 headers middleware**） | `Host(`llm.<base>`) && ClientIP(`<该 FDE 精确 subnet>`)` | `<fde>-llm-auth`（headers 注入） | `llm-hub` → `http://127.0.0.1:4000` | L7；身份来自网络来源，注入凭据并覆盖伪造头；subnet 由 `fde_networks` 精确派生（默认 `10.200.<n>.0/29`、大 FDE `10.201.<n>.0/28`，§5.1）；**禁止无 ClientIP 条件的兜底路由**（§6 第 3 条） |
| internal | `PathPrefix(`/api/internal`)`（挂在 `station.<base>` 路由链上） | `internal-allow`（`ipAllowList`，从 `fde_networks` 精确派生，每 `subnet` 一条，§5.1） | `http://127.0.0.1:8080` | L3/L5；容器侧经 hosts 注入（`--add-host station.<base>:<网关IP>`；`llm.<base>` 同法，见 L3）访问 |

**公共约定**：

- **forwardAuth 指向 `127.0.0.1:8080`**（`http://127.0.0.1:8080/api/forward-auth`）——Traefik 在 host 网络，portal 发布在回环，forwardAuth 不再走容器网络寻址。
- **Traefik 动态配置由 portal 写 file provider**：portal（经 reconciler，§8）生成全部动态路由文件，与 DB（`port_allocations` / route outbox / `fde_networks`）同源；「路由表里没有 = 不可达」这条性质必须成立。文件权限与职责分工见 §6 第 8 条。
- **路由发布预算**：outbox reconciler 的 debounce/批量合并、临时文件校验后原子替换、失败保留上一版本、reload SLO（P95 < 2s）、最大路由数（30 FDE × N 端口）与批量 offboarding 见 §8。
- `llm-hub` service 的 `responseForwarding.flushInterval` 必须调小（≤100ms），否则 token 流被缓冲成整段（§6 第 5 条）。
- **来源判定一律用 request remote address（不读 `X-Forwarded-For`）**：`ipAllowList`（internal 路由）与 `ClientIP`（LLM 路由）默认匹配 remote address；public entryPoint 不配 `forwardedHeaders.insecure`、中间件不配基于 XFF 的 `ipStrategy`。「容器直达 host Traefik、无中间代理」是「来源子网 = 身份」成立的安全前提，作为配置约束写死；**验收**：伪造/重复 `X-Forwarded-For` 不得影响来源判定（§10 证据 8 反向断言）。

### 5.1 来源规则派生（唯一口径）

> **所有「按来源子网放行/判定」的规则共用同一条派生结果**：internal 路由 `ipAllowList`、LLM 路由 `ClientIP`、宿主 INPUT、DOCKER-USER——**禁止在任何文档/配置里把 `/16` 聚合池直接写进放行范围**。

派生规则：对 `fde_networks` 中 `state ∈ {allocated, active}` 的每一行，取其 `subnet`（精确 `/29` 或 `/28`）生成一条来源规则；上述四处**全部复用这一派生结果**。

派生 SQL（portal/reconciler 每次全量生成时执行）：

```sql
SELECT subnet
FROM fde_networks
WHERE state IN ('allocated', 'active')
ORDER BY subnet;
```

两个具体示例（假设 `fde_networks` 现有两行）：

| `fde_id` | `subnet` | `pool` | 派生的来源规则 |
|---|---|---|---|
| alice | `10.200.1.0/29` | `default` | `ipAllowList` 一条 `10.200.1.0/29`；LLM `ClientIP(`10.200.1.0/29`)`；INPUT/DOCKER-USER `-s 10.200.1.0/29` |
| bob（大 FDE） | `10.201.7.0/28` | `large` | `ipAllowList` 一条 `10.201.7.0/28`；LLM `ClientIP(`10.201.7.0/28`)`；INPUT/DOCKER-USER `-s 10.201.7.0/28` |

> **池范围 ≠ 放行范围**：`10.200.0.0/16` 与 `10.201.0.0/16` 只是 `fde_networks.subnet` 的**取值池**（子网从这两段中切出），**不是**放行范围；放行范围恒为 `fde_networks` 中实际存在的精确 `subnet`。任何把 `/16` 直接写进 `sourceRange` / `ClientIP` / iptables 的配置都是 bug。

### 5.2 认证与授权链路执行顺序总表（四条链）

> 本文与 [`../api/portal.md`](../api/portal.md) §2.5/§2.7/§2.8 的 cookie/ticket 口径**一致**：portal session cookie 与预览 cookie 均为 **host-only（`__Host-` 前缀、不设 `Domain`、`Secure`/`HttpOnly`/`SameSite=Lax`）**；预览访问走**一次性 ticket + host-only 预览 cookie**，**绝不使用 portal session cookie**（issue #6）。本表是执行顺序与失败语义的唯一落点，cookie/ticket 取值细节以 portal.md 为准。

#### Traefik 中间件执行顺序（通用）

Traefik 求值顺序：**router 规则（含 `ClientIP`、`PathPrefix`）→ 中间件（按 `middlewares:` 声明顺序）→ service**。平台用到的中间件及**必须的先后**：

1. `redirect`（scheme http→https）——挂在 entryPoint 层，先于一切
2. `ipAllowList`（来源白名单，internal 路由）——**必须在任何业务中间件之前**，先挡非白名单来源
3. `forwardAuth`（身份 + 授权，预览路由 `fde-auth`）——在代理到上游**之前**执行
4. `headers`（LLM 凭据注入，`<fde>-llm-auth`）——在代理到上游**之前**注入并覆盖

> `redirect`（scheme http→https）只挂在 **entryPoint 层**，不参与 router 中间件链，因此恒先于一切业务中间件。router 中间件链按需叠加：internal=`ipAllowList`；预览=`forwardAuth` → `strip-cookie`；LLM=`headers`。若将来同路由叠加多类，顺序恒为 `ipAllowList` → `forwardAuth` → `headers`。

#### 四条链路总表

| 链路 | 中间件/检查（按顺序） | 每层失败 → HTTP code | redirect? | 写审计? |
|---|---|---|---|---|
| **① 浏览器 → portal**（`station.<base>`） | TLS 终结 → Host 匹配 → portal 自身 session cookie 校验（按 `login_sessions.token_hash` 查库）→ 路由 handler | TLS/主机不匹配 → 连接失败 / `404`；session 无效 → `401 unauthorized`（JSON） | `401` 前端跳登录页 | portal 写登录/登出/关键动作 `audit_log`；Traefik access log 仅原始 |
| **② 浏览器 → 预览**（`*.fde.<base>`） | TLS → Host 精确匹配（per-allocation router）→ `forwardAuth`（`fde-auth`，回调 `127.0.0.1:8080/api/forward-auth`）：①hostname 查 `port_allocations` ②state ③凭证（ticket 优先 / 预览 cookie）④exposure 判定 → service（容器 IP:port） | hostname 无 → `404`；state released → `403`；无凭证 → `403 forbidden（preview_ticket_required）`（**`public` exposure 例外：跳过凭证校验，仍须过 hostname/state**）；ticket 过期/无效 → `401`；ticket 已用/撤销/不匹配 → `403`；exposure 越权/用户禁用 → `403`；forwardAuth 自身 5xx/超时 → **deny-all** | `403`（凭证类）→ Traefik 透传；登录引导由 portal 前端按 `preview_ticket_required` 处理 | forwardAuth **每次判定**（pass/fail）写 `audit_log` |
| **③ 容器 → internal API**（`/api/internal/*`） | TLS（容器→Traefik）→ `Host(station) && PathPrefix(/api/internal)` + **`ipAllowList`（remote address，每 FDE 精确 subnet）** → service portal → portal Bearer 校验（`containers.runner_token_hash` 按代次比对）→ 归属校验（`run → session → user_id`）→ handler | 来源不在白名单 → `403`（Traefik）；Bearer 缺失/错 → `401 token_invalid`；吊销 → `401 token_revoked`；归属不符 → `403 run_ownership_mismatch`（或 `404`） | 否（容器不是浏览器，不 302） | portal 对关键动作（claim/心跳/吊销/越权）写 `audit_log` |
| **④ LLM 数据面**（`llm.<base>`） | TLS（容器→Traefik）→ `Host(llm) && ClientIP(精确 subnet)`（身份=网络来源，无匹配来源 404）→ `headers`（`<fde>-llm-auth` 注入并覆盖 `Authorization` + `X-FDE-Identity`）→ service `llm-hub` | 无匹配 ClientIP → `404`（无兜底路由）；TLS → 连接失败 | 否 | 不逐请求写 portal `audit_log`（量太大）；用量/成本走网关 `usage_ledger`，Traefik access log 原始 |

#### 失败语义与信任边界（写死）

- **forwardAuth 故障 → deny-all**：portal 5xx / 连接失败 / 超时时，Traefik `forwardAuth` 默认拒绝（请求**不到达**预览上游），**禁止任何 fail-open 配置**；可叠加 basic-auth 兜底（规格 §6.2，仅作 forwardAuth 挂掉时的降级，不是主机制）。
- **`X-Forwarded-*` 信任边界**：
  - public entryPoint **不配** `forwardedHeaders.insecure`（不信任客户端 `X-Forwarded-*`）。
  - forwardAuth 中间件 **不配** `trustForwardHeader: true`（默认 false）→ Traefik 用真实 `Host`/`URI`/`Method` **覆盖** `X-Forwarded-Host`/`X-Forwarded-Uri`/`X-Forwarded-Method` 后再回调 portal——portal 只信 Traefik 覆盖后的值，客户端自报无法伪造。
  - `ipAllowList` / `ClientIP` **不配**基于 XFF 的 `ipStrategy`（`depth`/`excludedIPs`）——来源判定只用 request remote address（§5）。
  - `aliasHeadersStrategy: delete`（§6 第 2 条）——防 `X_FDE_Identity` 之类别名头绕过注入。
  - **推论**：直接以浏览器访问 `https://station.<base>/api/forward-auth`（`Host=station.<base>`）会被 forwardAuth 以「hostname 无对应 allocation」拒为 `404`，无法冒用预览授权（§5 公共约定「forwardAuth 只被 Traefik 回调」由此成立）。
- **审计归属**：portal `audit_log` 是审计真相；Traefik access log 是原始日志，不作审计依据（规格 §4 组件职责）。

---

## 6. 加固清单（10 条，必须全部配置）

| # | 项 | 配置 | 为什么 |
|---|---|---|---|
| 1 | Traefik 关闭管理面 | `--api=false`（dashboard/API 全关） | FDE 能访问 Traefik，开着就是跳板 |
| 2 | **头别名防伪造** | `entryPoints.<name>.http.aliasHeadersStrategy: delete`（或 `reject`） | 实测警告：`X_FDE_Identity` 之类别名头可绕过注入（§10 证据 9）。**必须挂在 `http` 层级下**——写成 `entryPoints.<name>.aliasHeadersStrategy` 会错层 → Traefik 启动失败（fde-platform.md §6.4 注释） |
| 3 | **禁止兜底路由** | 不写 `Host(llm.<base>)` 的通配路由（无 ClientIP 条件） | 实测：无匹配来源 404 = 默认拒绝，兜底等于开门 |
| 4 | internal 路由来源白名单 | `/api/internal/*` 加 `ipAllowList`（从 `fde_networks` 精确派生，每 `subnet` 一条 `/29` 或 `/28`，§5.1） | internal API 走 ingress，必须限制来源（含大 FDE `/28` 段） |
| 5 | 流式 | hub service `responseForwarding.flushInterval` 调小（≤100ms） | 否则 token 流被缓冲成整段 |
| 6 | 网关 admin 面隔离 | admin 端口不发布，只在 `backend` 网络 | 否则 FDE 能自开额度/建 key |
| 7 | **容器 → 宿主服务收紧（分层）** | INPUT（宿主本地服务）+ DOCKER-USER（转发/publish）两层，见 §6.1 | **实测**：FDE 容器可达宿主 `gitea:3000`/`mssql:1433`/`portainer:9000`（所有方案共同缺口）；原「只写 DOCKER-USER」不成立（§6.1） |
| 8 | Traefik 动态配置含全部虚拟 key | 宿主文件权限 **600**，仅 portal 可写、Traefik 只读 | 凭据集中点，必须锁死 |
| 9 | per-container token | 仅存哈希 + `generation/revoked_at`；原文只注入容器 env、portal 不存明文；容器重建/离职原子吊销 | 见 issue #12；边界与残余风险见 §6.2 |
| 10 | SSE 与长轮询超时 | 路由 read/write timeout ≥ 5min；SSE 禁缓冲 | claim 长轮询与 SSE 都用长连接 |

### 6.1 分层防火墙模型（容器 → 宿主收紧：INPUT + DOCKER-USER）

> **评审修正**：原第 7 条「只写 `DOCKER-USER`」不成立——`DOCKER-USER` 在 FORWARD 链，而**容器访问宿主本地服务走 INPUT**；publish 端口在 PREROUTING 已 DNAT（到 FORWARD 时目的地址已被改写，`-d <宿主IP>` 匹配不到）。故改为两层，规则由 `fde_networks` 的**精确 CIDR** 生成（每 `subnet` 一条，含 `/28`，§5.1），**不硬编码单一池**；`10.200.0.0/16` 与 `10.201.0.0/16` 仅为取值池（**池范围 ≠ 放行范围**）。

**① INPUT 链（宿主本地服务）**：

```
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A INPUT -s <FDE CIDR> -p tcp --dport 443 -j ACCEPT   # Traefik（host 网络）
-A INPUT -s <FDE CIDR> -j DROP                         # 其它宿主本地端口
```

（等价可用 `-i br-fde-*` 接口匹配；`-s <CIDR>` 更精确、天然覆盖 `/28` 与两池。）

**② DOCKER-USER 链（转发与 publish）**：

```
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A DOCKER-USER -s <FDE CIDR> -m conntrack --ctstate DNAT -j DROP
```

- **不得阻断容器出网 NAT 与 DNS**：容器出网（MASQUERADE）与跨 bridge 转发由 Docker 自身规则 / DOCKER-ISOLATION 处理；上面的规则只额外收紧 FDE 子网的 publish/DNAT 路径，默认策略保持 RETURN（落回 Docker 规则）。容器 DNS 是 netns 内 `127.0.0.11`（Docker 内嵌 DNS），**不经宿主 INPUT**；若容器显式改用外部 resolver（如网关 `.1` 或公网 DNS），需在 INPUT 放行对应 UDP/TCP 53（否则保持 `127.0.0.11` 默认）。
- **规则持久化**：INPUT 不被 Docker 管理；DOCKER-USER 在 docker daemon 重启时重建并清空自定义规则。两者都需在 host 重启 / daemon reload 后重新应用（systemd unit `After=docker.service` 或 portal reconciler 启动钩子，从 `fde_networks` 全量生成）。

**验收矩阵（目标环境实测，逐项打勾）**：

| 用例 | 期望 |
|---|---|
| FDE → 宿主 `:443`（Traefik） | ✅ 通 |
| FDE → 宿主 `:8080` / `:4000`（portal / LLM 网关数据面回环） | ❌ 拒 |
| FDE → 宿主 publish `gitea:3000` / `mssql:1433` / `portainer:9000` | ❌ 拒 |
| FDE → 互联网 HTTPS | 按安全团队出口策略（issue #3） |
| FDE → DNS | ✅（netns `127.0.0.11`） |
| FDE A → FDE B | ❌（DOCKER-ISOLATION） |

### 6.2 容器内 token 边界与残余风险

- **UID 策略**：agentd 与 worker 用**不同 UID**（优先）；agentd 是唯一持 token 的进程，worker 以低权限 UID 运行、`fork` 时从 env 剔除 token。同 UID 时（如镜像只有单用户），边界退化为「仅进程约定」——残余风险靠最小 capability + 禁 ptrace 缓解（详见 [runner-integration.md](runner-integration.md) §3/§11）。
- **`/proc/<pid>/environ` 可读性**：同 UID 下任何进程可读同 UID 进程的 `/proc/<pid>/environ`（含注入 token 的 env）——这是「同 UID 时进程约定不可靠」的根因；不同 UID 下 Linux 默认权限阻断跨 UID 读取。
- **禁止 ptrace、最小 capability**：容器模板不授 `CAP_SYS_PTRACE`（禁 ptrace 读他进程内存/env），capability 只授运行所需最小集（不授 `NET_ADMIN`/`SYS_ADMIN`）；seccomp/AppArmor 默认 profile 保持。
- **残余风险声明（接受）**：FDE 拥有自己容器的 root（或等价权限）→ **接受「FDE 可破坏自己的平台状态」**——可伪造自己的事件/usage/终态（例如绕过 agentd 直连 portal 出示自己 token 编数据）。**跨 FDE 由归属校验挡住**（portal 用 token 解出 `container_id`/`user_id`，所有 `:run_id` 资源校验归属，防跨容器伪造 run_id）；FDE 不能影响他人，也不能越权读 DB / LLM 凭据。
- **bind mount 写边界**：portal 原子写 `/srv/erix/users/<fde>/` 下**平台生成的文件**（模板 / AGENTS.md / `.erix/ports.json`——tmp+rename 原子写，容器只读到完整文件）；`~/projects`、`~/worktrees`、`~/cache` 等**允许 FDE 修改**（那是他的工作区，平台不代管内容）。

---

## 7. 连通矩阵（终态）

| 源 → 目标 | 结果 | 保证 |
|---|---|---|
| FDE A → FDE B（任意端口） | 禁止 | 无共享网络 + 宿主不转发 |
| FDE → station-db | 禁止 | 无网络路径 + 无凭据 |
| FDE → 宿主 :443（Traefik） | 允许 | INPUT（443 放行）+ DOCKER-USER（其它宿主端口拒绝，§6.1）——`ipAllowList` 仅用于 ③ internal API 行，不参与本行 |
| FDE → 宿主其它端口 | 禁止 | INPUT + DOCKER-USER（分层，§6.1） |
| 浏览器 → `station.<base>` / `*.fde.<base>` | 允许 | Traefik 路由 + forwardAuth |
| portal → station-db | 允许 | `backend` 网络 |
| 用户 → agent（直连） | **不存在** | 经 portal 汇合 |

---

## 8. reconciler 职责（声明式收敛）

> 接入/网络/路由都是「编排状态」，不进 compose 声明；容器 restart 保留、**recreate 会丢** → 必须有 reconciler。

| 时机 | 动作 |
|---|---|
| **onboarding** | 分配子网（DB）→ **建网络前经 Docker API 校验子网与既有网络 / `fde_networks` 无重叠** → 建 `fde-<name>` 网络（`--subnet`）→ 起容器 → 写 ports 路由 + LLM 注入路由 → 写模板/AGENTS.md（bind mount）→ 建网关虚拟 key |
| **offboarding** | **吊销 token/虚拟 key → 释放子网（同事务）** → 停容器 → 删路由（含 LLM 注入）→ 删网络（审计 #34 F-B：token 必须先于资源删除失效，且与「离开 desired」同事务——否则 DB 写失败窗口内旧 token 仍有效，或被 reconcile 复活） |
| **portal/Traefik 启动** | 从 DB 全量重建缺失状态（幂等）：路由文件、内部端点、网络记录对账 |
| **定时对账** | DB ↔ docker（容器/网络/IP）↔ Traefik 路由 ↔ `fde_networks` 四向一致；漂移即修 + 告警 |
| **容器重建后** | 检测 IP 变化 → 重写该 FDE 的预览路由与 LLM 路由注入（H-B 的唯一技术债 L8，由本行兜住） |

**路由发布预算与收敛机制**（outbox reconciler，配合 §5）：

- **debounce/批量合并**：outbox 到达后按短窗口（如 200ms）聚合同批 revision，一次生成整份 Traefik 动态配置（而非逐 allocation 写文件/reload）。
- **临时文件校验后原子替换**：生成到临时文件 → Traefik 配置 schema 校验（或 dry-check）→ `mv` 原子替换 → reload。**失败保留上一版本文件**（不回滚到空/半截）；`attempts < max` 时退回 `pending` 退避重试，`attempts` 耗尽（≥5 ⚠️）才置 `failed`（人工介入终态）+ 告警（状态机与 schema.sql / model.md §2.5 一致）。
- **reload SLO**：P95 < 2s（从 outbox 落库到 Traefik 生效；目标环境实测）。批量合并不逐条 reload 是达标前提。
- **预期最大路由数**：30 FDE × 每 FDE 端口数（每项目 1 个项目级端口 + 块内 7 个 run 级，§8.2）→ 数百条 router+service；file provider 单文件承载无压力，reload 频率受 debounce 控制。
- **批量 offboarding**：N 个 FDE 同时 offboard 时，reconciler 合并为一次生成 + 一次 reload（tombstone 批量处理），不逐 FDE reload。

---

## 9. 流式与存储策略

**合并（避免打爆 DB）**：worker 只做累积与**边界 flush**（`tool_use`/`tool_result`/`round_end`/`judge`/`run_end` 前必须 flush，否则 UI 顺序错乱）；agentd 是**唯一时间窗口**（250ms 或 2KB，单批 ≤200 条/256KB）。
→ 80 chunk/s 合并后 ≈ **4–8 行/秒/run**。

**事件 → UI**：`assistant_delta` 逐字动画（前端 20–30ms/字）｜`reasoning_delta` **折叠面板**｜`tool_call_delta`→`tool_use`→`tool_result` 工具卡片状态机｜`judge` 轻提示｜`usage` 头部计数｜`attempt/recovering/recovered` 重试指示｜`run_end` 收尾。

**存储（已确认）**：

- **reasoning：粗粒度合并落 `run_events`**（如每 2KB 一条），UI 默认折叠
- **工具结果全文：阈值另存 `tool_outputs` 表**（事件里只放 `result_digest` + 引用）
- `run_end` 必须等所有事件批 200 确认后才发（barrier，见 issue #8）

---

## 10. 实测证据（9 项，本机真跑：`traefik:v3` + 真实 docker 网络/容器）

| # | 测试 | 结果 | 支撑的决策 |
|---|---|---|---|
| 1 | host 网络服务 → 自定义 bridge 容器 | ✅ 通 | H-B：Traefik 零接入可达 FDE 容器 |
| 2 | 容器 → 宿主（经网关 IP）端口 | ✅ 通（`127.0.0.1` 不可用，符合预期） | L3/L7：FDE → Traefik:443 |
| 3 | **FDE A → FDE B（跨 bridge 直连）** | ❌ **被拦** | 隔离不变式成立（零配置） |
| 4 | 多归属容器同时访问两侧网络 | ✅ 通 | 「多宿端点 = 发起连接」可行 |
| 5 | **多归属容器做 L3 转发**（含双向静态路由） | ❌ **不通** | 否决「路由器容器」方案（§11） |
| 6 | 对运行中容器 `network connect/disconnect` | ✅ **零重启**（`StartedAt` 未变）、立即可达、**按容器名寻址可用** | 若走容器模式，接入是低成本在线操作 |
| 7 | 同一容器接入 30 条 `/29` | ⚠️ 可用但 **31 张网卡/31 个 IP**，建网 2.3s + 接入 2.5s，宿主多 30 座 bridge | 否决「Traefik 接 N 条网络」，定 H-B（§11） |
| 8 | **Traefik v3 按 `ClientIP` 注入 LLM 凭据** | ✅ A 子网 → `Bearer alice-virtual-key`；B 子网 → `bob-virtual-key`；**两者自带的 `Bearer STOLEN-KEY` 被覆盖**；无匹配来源 **404** | D-4/L7：FDE 容器零 LLM 凭据且无法冒用 |
| 9 | Traefik 启动警告（头别名） | ⚠️ `aliasHeadersStrategy is not configured … allows a client to spoof the headers Traefik manages` | D-8：**必须**设 `aliasHeadersStrategy: delete`（§6 第 2 条） |

> 证据 8 的配置形态（供实现参考）：
> ```yaml
> routers:
>   fde-alice-llm:
>     rule: "Host(`llm.<base>`) && ClientIP(`10.200.1.0/29`)"
>     middlewares: [alice-llm-auth]
>     service: llm-hub
> middlewares:
>   alice-llm-auth:
>     headers:
>       customRequestHeaders:
>         Authorization: "Bearer <alice 虚拟 key>"
>         X-FDE-Identity: "alice"
> services:
>   llm-hub:
>     loadBalancer:
>       servers: [{ url: "http://127.0.0.1:4000" }]
>       # responseForwarding.flushInterval 必须调小（流式必需）
> ```

---

## 11. 为什么不引入「路由器容器」、不给 Traefik 接 30 条网络

- **路由器容器（L3 转发）**：多归属容器虽能同时访问两侧网络（证据 4），但**跨 bridge 转发被 Docker 主动丢弃**（实测双向静态路由也不通，证据 5）；绕开要 SNAT（**丢源 IP**）+ `NET_ADMIN` + **全局单点** → **收益 0、成本为正**。我们要的「统一跨子网入口」应由 **L7 组件**承担（Traefik 做的是「发起新连接」，天然可行）。
- **Traefik 接入每条 `/29`**：N=30 实测（证据 7）→ 该容器 **31 张网卡/31 个 IP**、接入耗时 2.5s、宿主多 30 座 bridge；能跑，但随规模**线性膨胀**，且每次 FDE 变更都要动 ingress。→ 改 H-B（Traefik 在 host，零接入，D-2）。
- **隔离不受影响**：隔离来自「每 FDE 独占 bridge + Docker 不转发」（证据 3），与平台服务放哪无关。

---

## 12. ⚠️ 待决策者确认的遗留项

| # | 事项 | 当前建议 |
|---|---|---|
| 1 | **LLM 网关 admin 面的端口与鉴权细节** | 只在 `backend` 网络，不发布（§6 第 6 条已定隔离原则；具体端口与鉴权方式待定） |
| 2 | **大 FDE 的 `/28` 分配策略**（管理员显式指定 vs 系统阈值自动） | 系统给默认 `/29`，管理员可显式提为 `/28`（§3） |

> 注：issue #5 评论 1 §7 的遗留项「是否新增 `docs/design/topology.md` 承载本定稿」已由本文的创建**落地**（建议为：新增本文，规格 §5 后续精简为引用——属 issue #5 §11 影响面的后续任务）。

---

## 13. 交叉引用

| 主题 | 位置 |
|---|---|
| 主规格（网络与隔离模型、Traefik 骨架、LLM 接入——**已按本文对齐**，残留冲突以本文为准） | [`fde-platform.md`](fde-platform.md) §5 / §6.4 / §11 |
| 容器内进程模型、出站协议端点、事件批量参数、幂等与租约 | [`runner-integration.md`](runner-integration.md) §2 / §4 / §7 |
| 部署参数（`default-address-pools`、端口清单、路径与凭据注入约定） | [`../env.md`](../env.md) |
| internal 端点契约、SSE 语义 | [`../api/portal.md`](../api/portal.md) §9 / §5 |
| 三条不变式（容器是信任边界 / ingress 唯一入口 / DB 是状态真相） | [`../../README.md`](../../README.md) |
| 五条核心原理（本拓扑是原理一/二/四的落地） | [`principles.md`](principles.md) §1 |
| 定稿原始依据（决策、证据、加固清单、影响面与落地顺序） | [issue #5](https://github.com/ErixWong/erix-station/issues/5) 两条定稿评论 |
| 相关 issue | #6（L2 预览 cookie）、#7（D-6 文件投递）、#8（幂等/租约/barrier）、#9（per-allocation 路由 + outbox）、#10（L6 审批超时 `expired`）、#11、#12（token 哈希/轮换/吊销） |
