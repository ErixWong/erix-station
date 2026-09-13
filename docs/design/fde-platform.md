# FDE Station 设计文档

> 状态：**草案（设计阶段，无实现）**
> 来源：2026-09-12 六轮设计讨论，归档于 [erix-llm-kit#24](https://git.erix.vip/eric/erix-llm-kit/issues/24)
> 上游：erix-agent（引擎）；本文只描述**宿主平台**。
>
> **本文只写「是什么」**。要理解「为什么」、查看**被否决的方案**、以及未覆盖场景如何推导，读 [`principles.md`](principles.md)。
> 待补齐的文档清单见 [`../README.md`](../README.md)。

---

## 0. 待决问题（阻塞后续，先看这里）

| # | 问题 | 影响 | 状态 |
|---|---|---|---|
| Q1 | 公司是否已有统一 LLM 网关（LiteLLM / one-api / one-hub）？ | 决定 portal 是「租户绑定」还是「兼做网关」（§11） | ⚠️ 待定 |
| Q2 | 出口管控（egress）职责归属 | 平台侧保证凭据层（虚拟 key）+ 审计；网络层阻断（容器能否出网、可访问哪些域名）由安全团队负责（§11） | ✅ 已定：外部依赖（安全团队），决策者 2026-09（issue #3） |
| Q3 | 本地 admin 的定位：仅破窗，还是 FDE 也可用？ | 认证设计（§6） | ⚠️ 待定 |
| Q4 | LLM 虚拟 key 粒度：每 FDE 一把，还是每客户项目一把？ | 成本归属精度 vs key 数量（§11） | ⚠️ 待定 |
| Q5 | 端口分级：项目级 + run 级都做，还是先只做项目级？ | 端口模型复杂度（§8） | ⚠️ 待定 |
| Q6 | 部署形态：同一台宿主机裸 docker，还是将来上 K8s？ | 编排实现（§14）。当前按**裸 Linux host + Docker** 设计 | 暂按裸机 |
| Q7 | portal 技术栈与依赖政策：零依赖 Node，还是允许框架依赖？ | 实现选型 | ⚠️ 待定 |

---

## 1. 定位

**给 FDE 的开发工位平台。**

| | |
|---|---|
| **是什么** | 管理「每个 FDE 一台容器小电脑」的生命周期、身份、访问路径、成本；提供统一的 Web 对话界面驱动容器里的 erix agent；让 FDE 能访问自己项目起的 dev server 页面 |
| **不是什么** | 不是 agent 实现（那是 erix-agent）；不是多角色编排器（erix 的边界止于单任务）；不是代码托管 |
| **为什么自研** | FDE 的工作形态（多客户项目并行、需要真机跑 dev server + 浏览器验证、需要人接管）与通用 CI/沙箱平台不匹配；且 erix-agent 的宿主契约（`runToolLoop` 注入式）天然适合做这件事 |

### 关键前提（讨论已确认）

- 宿主是**一台裸 Linux host**，Docker 自管容器（无 K8s）
- 容器成本**不是约束**
- **隔离单元是 repository / worktree，不是容器**——容器只是「一台小电脑」
- 允许同一仓库并发多个 agent：不同分支 + 不同 worktree，完成后 fork/PR 回流
- 结对开发**不需要**：fork + PR 即可

---

## 2. 术语（避免和已有概念混淆）

| 术语 | 含义 |
|---|---|
| **FDE 容器** | 一个 FDE 的「小电脑」，长期存在的开发环境 |
| **project** | 容器内的一个仓库目录 `~/projects/<project>` |
| **run** | 一次 `runToolLoop` 生命周期（一个 agent 任务） |
| **worktree** | 一个 run 独占的 git worktree `~/worktrees/<project>-<runId>`，分支 `agent/<runId>` |
| **slot** | 分配给一个 run 的端口块 |
| **session** | 对话会话（UI 概念），一个 session 串起多次 run |
| **ingress** | 唯一入口网关（Traefik），所有外部访问必经之路 |

> ⚠️ 注意 `projects` 一词的双重含义：**开发机**上的 `~/projects/` 是工作区根（pi 逐级加载 AGENTS.md 的地方）；**FDE 容器**里的 `~/projects/<project>` 是用户项目目录。写文档/代码时务必显式区分。

---

## 3. 总体架构

```
                          ┌──────────────────────────────────────────────┐
   FDE 浏览器 ───────────▶│  ingress: Traefik（host 网络，独占 80/443，   │
                          │  --api=false，唯一 ingress；不接任何 docker 网络）│
                          └───┬───────────────┬──────────────┬───────────┘
      station.<domain>        │               │ *.fde.<domain>│  llm.<domain>
      （portal：登录/项目/对话） │               │ （项目预览/IDE） │（LLM 调用：Traefik
                              ▼               ▼              │  按来源子网注入凭据）
                    ┌──────────────────┐  ┌──────────────────────────────┐ ▼
                    │  station-portal  │  │ FDE 容器 "alice"（仅自己的   │ ┌───────────────┐
                    │  用户/项目/端口   │  │  /29，如 10.200.1.0/29）    │ │ LLM 网关      │
                    │  容器生命周期     │  │  station-agentd（守护/桥接）   │ │（backend 网络；│
                    │  事件/SSE        │  │  station-runner（每 run 子进程）│ │ 数据面 publish │
                    │  LLM 网关租户绑定 │  │  :3001 code-server           │ │ 仅回环         │
                    └────────┬─────────┘  │  :4000+ dev servers          │ │ 127.0.0.1:4000 │
                    backend 网络           │  workspace volume            │ │ admin 不发布） │
                    publish 仅            └──────────────┬───────────────┘ └───────────────┘
                    127.0.0.1:8080       唯一业务写方      │ 全出站（零监听）：
                    ┌────────▼─────────┐                │ 经 Traefik /api/internal
                    │  station-db      │◀───────────────┘（SSE 下行 + POST 上行）
                    │  postgres        │  （internal API 经 Traefik 回环到 portal；容器不直连 DB）
                    └──────────────────┘
```

> 容器内进程命名（station-agentd / station-runner）⚠️ 待决策者确认；容器 ↔ portal 全出站模型为决策者裁定（2026-09，issue #3 评论，D1'/D2'），详见 §10.3 与 [runner-integration.md](runner-integration.md)；H-B 下全出站**经 Traefik**（internal API + LLM 注入，决策者 2026-09，issue #5 定稿）。

**网络**（H-B 定稿，决策者 2026-09，issue #5）：
```
Traefik：host 网络（零 docker 网络接入；宿主天然是每座 bridge 的 .1 端点，可达所有 /29）
docker network: backend    ← portal + station-db + LLM 网关（compose 管理）
docker network: fde-alice  ← 只给 alice 的容器（10.200.1.0/29，portal 管 IPAM）
docker network: fde-bob    ← ...（10.200.2.0/29）
~~edge / control~~ 已取消：Traefik 在 host 不需要 edge；control 共享网络是横向越权根源（§5）
```

> **网络与访问拓扑的单一事实来源见 [`topology.md`](topology.md)**（拓扑、IPAM、链路 L1–L10、路由模型、加固清单、连通矩阵、reconciler、实测证据）；本文 §5/§6.4/§10.3/§11 已按 H-B 对齐，细节以 topology.md 为准。

---

## 4. 组件职责

| 组件 | 职责 | 明确不做 |
|---|---|---|
| `station-edge`（Traefik，**host 网络**，独占 80/443，`--api=false`） | TLS、按 host 路由、forwardAuth、**LLM 凭据按来源子网注入**（H-B，§11）、访问日志（原始，非审计真相）、唯一对外入口 | 不碰业务逻辑 |
| `station-portal` | 用户系统、项目/端口分配、容器生命周期、事件与消息、SSE、LLM 网关**租户绑定**（虚拟 key 的开通/吊销/额度，见 §11；网关本身是独立组件，不是 portal 内部模块）、用量记账 | 不跑 agent、不做工具执行、不自写 LLM 流式代理 |
| `station-db`（Postgres） | 用户/会话/消息/transcript/events/端口表/用量/审计 | 不存代码 |
| `fde-<name>`（FDE 容器） | `station-agentd`（常驻守护/桥接，唯一出站连 portal）+ `station-runner`（每 run 一个子进程，跑 erix agent）+ code-server + dev servers（进程模型见 [runner-integration.md](runner-integration.md) §2，命名 ⚠️ 待决策者确认）；平台状态一律经 portal internal API 落 DB——**容器不直连 DB**（决策者 2026-09，issue #3 评论） | 不 publish 端口、**不监听任何对外端口**、不挂 `docker.sock`、**不持有平台密钥（含 DB 凭据）**——唯一平台凭据为 per-container token，仅 agentd 持有 |

**只有 portal 挂 `/var/run/docker.sock`**（建议前置 `tecnativa/docker-socket-proxy` 收窄到 CONTAINERS/NETWORKS/VOLUMES）。FDE 容器永不挂。

---

## 5. 网络与隔离模型（H-B，决策者 2026-09 定稿，issue #5）

> 本节已按 H-B 定稿重写（issue #5 两条定稿评论）。**单一事实来源是 [`topology.md`](topology.md)**（全链路 L1–L10、连通矩阵、10 条加固清单、9 项实测证据、reconciler 职责），本节只保留规格层面的模型与不变式。

### 5.1 拓扑（决定一切）

**网络清单**：

| 网络 | 成员 | 子网 |
|---|---|---|
| **host** | Traefik（host 网络模式，零 docker 网络接入，独占 80/443） | —（不占 docker 网络） |
| **`backend`** | portal（publish 仅 `127.0.0.1:8080` 回环）+ station-db + LLM 网关 | **显式 `172.30.0.0/24`**（与 FDE 池 `10.200.0.0/16` / `10.201.0.0/16` 隔离，topology.md §2/§3） |
| **`fde-<name>`** | 该 FDE 的主容器 + 其自有服务（db/redis/sidecar） | **每 FDE 一条独立 `/29`**（默认池 `10.200.0.0/16`；大 FDE 预留 `10.201.0.0/16` `/28`），portal 管 IPAM（topology.md §3） |

**取消 `control`（本次修正点）**：原「portal + db + 所有 FDE 容器共享 `control`」意味着任何 FDE 容器都能直连 portal 与其它 FDE 容器——**共享网络是横向越权的隔离漏洞根源**（issue #5 正文证据）。H-B 下 portal 不再与任何 FDE 容器同网，容器 → portal 的 internal 通道改经 Traefik（§5.3）。

**隔离机制：发起（originate）vs 转发（forward）**：

- 宿主是每座 bridge 的 `.1` 端点，所以从宿主**发起**到任何 `/29` 容器的连接天然可行——Traefik 在 host 网络即继承此能力（实测：host 网络服务 → 自定义 bridge 容器 ✅，topology.md §10 证据 1）
- 容器之间跨 bridge 的**转发**被 `DOCKER-ISOLATION` 链丢弃：FDE A → FDE B 任意端口被拦，连「多归属容器做 L3 转发 + 双向静态路由」也不通（实测，topology.md §10 证据 3/5）
- → **FDE 间隔离由拓扑保证、零配置**：没有共享网络，就没有第二条路

### 5.2 必须同时堵的洞（H-B 更新版）

| 洞 | 后果 | 堵法 |
|---|---|---|
| `-p 4000:4000` publish 到宿主机 | 绕过 ingress，直接访问 | FDE 容器一律不 publish；只有 Traefik（host 网络）占 80/443 |
| 共享 docker 网络 | alice 的容器 `curl bob:4000` 直达 | **每 FDE 独立 `/29`**，无任何共享网络（`control` 已取消，§5.1） |
| **容器 → 宿主服务**（新增洞） | **实测**：FDE 容器经网关 IP 可达宿主 `gitea:3000` / `mssql:1433` / `portainer:9000`（所有方案共同缺口，topology.md §6 第 7 条） | **分层防火墙**：INPUT（宿主本地服务）+ DOCKER-USER（转发/publish）两层收紧，规则由 `fde_networks` 精确 CIDR 生成（覆盖两池，含 `/28`）——详见 topology.md §6.1 |
| 容器内自建隧道（cloudflared/ngrok） | 绕过平台直接对外 | 安全团队网络层策略（§11.4，issue #3）+ 平台审计 |

### 5.3 「不 publish」不等于「不监听」；H-B 下的实际路径

容器内 dev server / code-server **仍然监听**端口（3001、4000+），只是仅在容器自己的 `/29` 内可达：

- **预览/IDE**：Traefik（host）→ forwardAuth（`http://127.0.0.1:8080/api/forward-auth`）→ 直连容器 IP `http://10.200.<n>.2:<port>`（每 allocation 一条 router+service，§6.4；topology.md §4-L2）
- **平台通道全出站经 Traefik**（方向反转为决策者 2026-09 裁定，issue #3 评论；经 Traefik 为 H-B 定稿 D-5，issue #5）：容器内不再有 runner 监听端口（3000 角色取消，§12.3），portal **不主动访问容器**；`station-agentd` 全出站——`https://station.<base>/api/internal/*`（容器侧 `--add-host station.<base>:<网关IP>`），Traefik 上以 `ipAllowList(10.200.0.0/16)` 限源后回环到 portal `127.0.0.1:8080`（SSE 下行 + POST 上行，§10.3；取舍对比见 [runner-integration.md](runner-integration.md) §11.2；topology.md §4-L3）
- **LLM 调用**：worker → `https://llm.<base>` → Traefik 按来源子网注入凭据 → 网关数据面回环 `127.0.0.1:4000`（§11；topology.md §4-L7）
- **hosts 注入（创建 FDE 容器时，docker `--add-host` 或等价受控方式）**：容器内解析 `station.<base>` 与 `llm.<base>` 都**不走内网/公网 DNS**，映射到该 FDE 的 bridge 网关 IP（默认池 `10.200.<n>.1`；大 FDE `10.201.<n>.1`）。开发期 `*.localhost` 变通对容器无效，必须同样注入（env.md §0/§1；topology.md §4-L3）

---

## 6. 访问控制与认证

### 6.1 「只有本人可见」= 两件事同时成立

| 层 | 机制 | 挡住的攻击 |
|---|---|---|
| ① **网络拓扑** | 每 FDE 独立 `/29`；dev 端口不 publish；Traefik 在 host 网络、零接入即可达所有容器（H-B，§5） | 其他 FDE 的容器直连；内网/公网直连宿主机端口 |
| ② **门口授权** | Traefik forwardAuth：`cookie.sub === hostname 里的 FDE 标识` | 同在 VPN 的其他人、会话被钓鱼、链接被转发 |

**只有①没②**：任何能连 ingress 的人都能看 → 需求不达成。
**只有②没①**：一句 `curl 172.x.x.x:4000` 绕过门 → 更糟（有防护的错觉）。

> **核心原则：认证放在边缘，应用自身不感知。** dev server 不做任何改造；容器内的 agent 用 `127.0.0.1` 访问自己的服务，完全不受影响。

### 6.2 为什么不用 IP 白名单 / basic auth 作主机制

- **IP allowlist**：VPN 池与 DHCP 会变；**公司出口 NAT 会把所有人塌缩成同一源 IP**（要么宽到人人可看，要么严到自己进不去）；多设备/手机/客户现场失效。→ 正确用法是「整个平台只在 VPN 内网可达」这一层。
- **basic auth**：浏览器按 host+realm 自动重发凭据（共享浏览器/录屏泄漏面）；每子域弹密码；静态密钥轮换与离职要逐容器改；无法表达分级可见性；无访问审计；不复用 SSO。→ 只作**兜底**（forwardAuth 挂掉时 deny-all）或内部非浏览器客户端使用。

### 6.3 域名与 cookie（必踩的两个坑）

| 坑 | 解法 |
|---|---|
| **SameSite 打死 iframe**：portal 在 `station.a.com`、预览在 `b.com` → cross-site → iframe 里 cookie 不发送，预览显示登录页 | **把 FDE 页面放在与 portal 同一 registrable domain 下**：portal = `station.<base>`，预览 = `alice-r3a7f-4000.fde.<base>`。同 site → `SameSite=Lax` 在 iframe 内正常发送 |
| CSP / 缓存 / Referer 泄漏 | `Content-Security-Policy: frame-ancestors https://station.<base>`；`Cache-Control: private, no-store`；`Referrer-Policy: no-referrer` |

### 6.4 Traefik 骨架（H-B，决策者 2026-09 定稿，issue #5）

```yaml
# ===== 静态配置（traefik.yml / CLI args）=====
# Traefik 跑 host 网络，独占 80/443，管理面全关
api: false   # --api=false：FDE 能访问 Traefik，开着 dashboard/API 就是跳板（topology.md §6 第 1 条）
entryPoints:
  websecure:
    address: ":443"
    http:
      # 实测结论：aliasHeadersStrategy 必须挂在 entryPoints.websecure.http 下——
      # 写成 entryPoints.websecure.aliasHeadersStrategy 会让 Traefik 直接启动失败（schema 校验报错）。
      aliasHeadersStrategy: delete   # 防头别名伪造：X_FDE_Identity 之类别名头可绕过注入，
                                     # Traefik 自身启动即告警（实测，topology.md §10 证据 9）
      # public entryPoint 不信任 forwarded headers：不配 forwardedHeaders.insecure，
      # 来源判定一律用 request remote address（见动态配置与下方「安全前提」注）。
```

```yaml
# ===== 动态配置（portal 经 reconciler 写 file provider，与 DB port_allocations / route outbox 同源）=====
http:
  routers:
    # portal（登录/项目/对话/SSE 的浏览器入口）
    portal:
      rule: "Host(`station.<base>`)"
      entryPoints: [websecure]
      priority: 100
      service: portal
    # internal API：挂在 station.<base> 链上 + 来源白名单（H-B 定稿 D-5）。
    # priority 必须 > portal，否则同 Host 下 portal 路由可能先命中、绕过 internal 的 ipAllowList。
    internal:
      rule: "Host(`station.<base>`) && PathPrefix(`/api/internal`)"
      entryPoints: [websecure]
      priority: 200
      middlewares: [internal-allow]
      service: portal
    # 预览/IDE：每 allocation 一条 router + 一条 service（Host 精确匹配，各自独立 priority）。
    # 否决原「单条 HostRegexp + service: fde-dynamic」的「零 per-port 配置」方案——
    # 单 service 无法表达 per-allocation 的后端地址与生命周期（issue #9，topology.md §5）
    fde-alice-4000:
      rule: "Host(`alice-p-proj1-4000.fde.<base>`)"
      entryPoints: [websecure]
      priority: 200
      middlewares: [fde-auth]
      service: fde-alice-4000
    # LLM 注入：每 FDE 一条 router + 一条 headers middleware（各自独立 priority）；
    # 身份来自网络来源（ClientIP），非自报；禁止写无 ClientIP 条件的兜底路由（无匹配 404 = 默认拒绝）
    fde-alice-llm:
      rule: "Host(`llm.<base>`) && ClientIP(`10.200.1.0/29`)"
      entryPoints: [websecure]
      priority: 200
      middlewares: [alice-llm-auth]
      service: llm-hub
  middlewares:
    fde-auth:
      forwardAuth:
        address: "http://127.0.0.1:8080/api/forward-auth"   # Traefik 在 host、portal 发布在回环，不再走容器网络寻址
        authResponseHeaders: [X-Auth-User]
    internal-allow:
      ipAllowList:
        sourceRange: ["10.200.0.0/16", "10.201.0.0/16"]   # 从 fde_networks 生成，覆盖两池（含大 FDE /28）
        # 不配置 ipStrategy.depth / ipStrategy.excludedIPs：默认按 request remote address 判定（不读 X-Forwarded-For）
    alice-llm-auth:
      headers:
        customRequestHeaders:                 # 覆盖容器自带的任何 Authorization（实测可覆盖伪造头）
          Authorization: "Bearer <alice 虚拟 key>"
          X-FDE-Identity: "alice"
  services:
    portal:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:8080" }]
    fde-alice-4000:
      loadBalancer:
        servers: [{ url: "http://10.200.1.2:4000" }]   # 容器 IP；重建漂移由 reconciler 重写（H-B 唯一技术债，topology.md §4-L8/§8）
    llm-hub:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:4000" }]
        # responseForwarding.flushInterval 必须调小（≤100ms），否则 token 流被缓冲成整段（topology.md §6 第 5 条）
```

portal 的 `/api/forward-auth` 逻辑：**解析 `X-Forwarded-Host` 取 FDE 标识 → 与 session cookie 的 `sub` 比对 → 200 / 403**。端口/槽位白名单、审计日志都在这里做。

**路由由 portal 生成、经 reconciler 幂等发布到 Traefik file provider，与 DB 的端口分配表同源**（DB 事务写 `port_allocations` + route outbox/revision，§8.1）——不允许手工改，也不允许 FDE 容器打 label 自注册（「路由表里没有 = 不可达」「FDE 不能自注册路由」这两条性质必须成立）。动态配置文件含全部虚拟 key，宿主文件权限 **600**，仅 portal 可写、Traefik 只读（topology.md §6 第 8 条）。

> **LLM 网关凭据入口收紧（H-B）**：LLM 网关数据面只接受 Traefik 经 `fde-<name>-llm` router 注入的 `Authorization` 头；网关须显式**拒绝**其它凭据输入通道（`X-API-Key`、HTTP Basic、cookie、query token）——否则容器可绕过「来源子网 → 身份」判定直接出示凭据（topology.md §4-L7）。

> **安全前提（ipAllowList / ClientIP 均按 request remote address 判定，不读 `X-Forwarded-For`）**：容器**直达宿主 Traefik（host:443）、中间无任何代理**，是「来源子网 = 身份」成立的前提。作为配置约束写死：public entryPoint 不配 `forwardedHeaders.insecure`；`ipAllowList` / `ClientIP` 不配基于 XFF 的 `ipStrategy`（`depth` / `excludedIPs`）。**验收项**：伪造/重复 `X-Forwarded-For` 头不得影响来源判定（topology.md §10 证据 8 的反向断言）。

### 6.5 访问分级（沿用 Codespaces 词汇）

| 级别 | 含义 |
|---|---|
| `private`（默认） | 仅 owner 会话可访问 |
| `org-visible` | 认证同事可见（需要时再开） |
| `public` | token 链接 / 真公开（**默认不给**） |

---

## 7. 账号生命周期

### 7.1 双通道认证

| | FDE 日常 | 本地 admin |
|---|---|---|
| 来源 | OIDC（JIT provisioning：首次登录按 email 建档，group claim 映射角色） | portal 本地表 |
| 凭据 | 公司 SSO | argon2id 哈希 + **强制 TOTP** |
| 数量 | N | 1~2 个（写进值班文档） |
| 用途 | 日常 | break-glass、初始 bootstrap（第一个 admin 只能本地建） |
| 审计 | 常规 | **每次登录/操作强制审计 + 告警**（本地账号登录本身即异常信号） |

角色来自 group claim（`fde` / `admin`），不在 UI 手点。

### 7.2 onboarding = 一个 workflow（5 步）

1. 建 user 记录（角色来自 claim）
2. **分配子网（IPAM）→ 建 `fde-<name>` 网络 → 起容器**（H-B 定稿 D-1/D-10，issue #5）：portal 查 `fde_networks` 推荐下一块空闲 `/29`（管理员可改），`docker network create --subnet` 显式创建；容器**只接自己这条网络**（不再有 `control` 接入），bind mount 用户空间
3. 分配端口块 + **写预览路由 + LLM 注入路由**：DB 事务写 `port_allocations` + route outbox/revision，由 reconciler **幂等发布**到 Traefik file provider（§8.1；不再是「路由与 DB 同事务」——PG 事务无法含文件写入）
4. 在 LLM 网关建**虚拟 key**（额度、模型白名单、别名 `alice@client-x`）；key 只写进宿主 Traefik 动态配置（600），**不进容器**（容器内零 LLM 凭据，§11）
5. **写模板/AGENTS.md（bind mount）**：portal 直写宿主 `/srv/erix/users/<fde>/`（H-B 定稿 D-6，issue #7，无需任何入站网络；原「落容器内文件需容器网络可达」类表述随之作废）；含端口约定、分支约定

> **边界（决策者 2026-09，issue #3 评论）**：平台交付到「**容器内一个仓库目录** + 端口分配 + 模板」为止。**平台不假设 git host 是 Gitea**（GitHub / Gitea / 其他自托管均可，git host 中立），也**不负责 clone 与 git 凭据下发**——clone 与 git 凭据（SSH key / token）由 FDE 在容器内自行配置，等同他自己的开发机（见 §12.2）。

### 7.3 offboarding 必须同样脚本化

```
停容器 + 吊销 runner token + 吊销 LLM 虚拟 key + 失效登录会话 + 保留 workspace 卷 N 天
```

并配一个**定时与 IdP 对账**的任务（拉 IdP 用户列表 → 比对 → 停用）。SSO 侧停用 ≠ 本平台停用——**onboarding 和 offboarding 是同一 workflow 的两端，只做前者是内部平台最常见的腐烂方式**。

---

## 8. 端口分配模型

### 8.1 DB 是真相，JSON 是派生视图

```
DB: port_allocations（权威，唯一写入口）
 ├─ id / fde_id / scope(project|run)
 ├─ project_id / run_id
 ├─ port / role
 ├─ hostname / url            ← 与 Traefik 路由同源生成
 ├─ exposure(private|org|public)
 └─ state(allocated|active|released) + released_at
        │ 同一 DB 事务另写 route outbox/revision（H-B 定稿，issue #5/#9；
        │ PG 事务无法含文件写入，故不再是「路由与 DB 同一事务」）
        ▼
reconciler 幂等发布 → Traefik file provider（每 allocation 一条 router+service，§6.4）
        │ portal 单向写出（直写宿主 bind mount，D-6/issue #7，无需容器网络可达）
        ▼
容器内 ~/projects/<project>/.erix/ports.json（agent 只读，永不写）
```

**为什么 DB 是真相**：URL 与 Traefik 路由必须同源（不一致 = 502 的来源）；主机/portal/Traefik 重启后由 reconciler 凭 DB 全量重建全部 JSON + 路由（自愈，topology.md §8）；并发申请靠唯一约束 + 事务；谁在用、何时回收、给谁看过只有 DB 装得下。

**为什么还要 JSON**：agent 读端口无需发 API（少一个失败点，可离线）；可 grep、可调试；符合「这台小电脑」的心智模型。

**同步规则**：平台 → 容器**单向**；agent 需要新端口**发 API 申请**，绝不自己挑。

### 8.2 分配策略

| 类别 | 用途 | 生命周期 |
|---|---|---|
| **项目级固定端口** | URL 稳定：书签、演示、客户 demo、对话页预览卡片 | 项目创建时分配，删除时回收 |
| **run 级临时端口** | 多分支并发开发；URL 带 runId | run 结束回收 |

- 容器固定角色：`3001` code-server（原 `3000` runner 内部 API **已取消**：容器平台通道零监听、全出站，§10.3，决策者 2026-09，issue #3 评论）
- run 端口块：`4000 + runIndex*8 … +7`（前端/后端/浏览器调试/备用）
- 每用户总配额（如 40 个端口），超限**明确报错**而非静默漂移
- 定期 reaper 回收 `released_at` 过期项；Traefik 配置由 reconciler 按 route outbox 幂等发布（§8.1，H-B）

### 8.3 `ports.json` 结构

```json
{
  "project": "proj1",
  "fde": "alice",
  "allocations": [
    { "scope": "project", "port": 4000, "role": "frontend", "runId": null,
      "url": "https://alice-p-proj1-4000.fde.erix.vip", "exposure": "private" },
    { "scope": "run", "port": 4008, "role": "backend", "runId": "r3a7f",
      "url": "https://alice-r3a7f-4008.fde.erix.vip", "exposure": "private" }
  ]
}
```

### 8.4 容器内两条硬约定

1. 端口一律从 `.erix/ports.json` 取，**不要自己挑**
2. dev server 必须绑 **`0.0.0.0`**（容器内）——与常规安全建议相反，因为容器网络私有且只有 ingress 能进；绑 `127.0.0.1` 会导致 ingress 够不着

---

## 9. 数据模型

### 9.1 表清单（草案）

```
users / login_sessions / api_tokens
containers          (fde_name, container_name, runner_token_hash, token_generation, status, image, agent_version, last_heartbeat, revoked_at, rotated_at)
projects            (user_id, name, repo_url, root_path, slot, template)
port_allocations    (见 §8)
chat_sessions       (user_id, project_id, title, model, status, last_seq)
messages            (session_id, seq, role, content, synthetic, attachments)
runs                (session_id, status, termination, rounds, usage, cost, started_at, ended_at)
transcript_rounds   (run_id, round, folded, messages JSON, folded_payload JSON)
run_checkpoints     (run_id, seq, snapshot JSON)
run_events          (run_id, seq, ts, type, payload JSON)
tool_calls          (run_id, round, name, input, result_digest, duration_ms, judged, approved)
judge_decisions     (run_id, kind, action, decision JSON)
approvals           (run_id, tool_call_id, status, decided_by, decided_at)
artifacts           (run_id, kind, path, size, sha)
usage_ledger        (user_id, project_id, run_id, input_tokens, output_tokens, cost, day)
audit_log           (actor_id, action, target, ts)
```

### 9.2 三份数据不可混（重要）

| 层 | 内容 | 谁看 | 可折叠 |
|---|---|---|---|
| ① `messages` | 人看的对话（含 `synthetic` 标记） | UI / 人类 | 否 |
| ② `transcript_rounds` | canonical 消息（模型上下文 + resume 源） | `runToolLoop` | 是（fold 只影响视图，档案完整） |
| ③ `run_events` | 流式事件日志（带 seq） | 前端 / 重放 | 否 |

> **①≠②**。judge 会在 transcript 里注入 **user role 的合成消息**（如「【审计拦截】方向可能偏…」），wrapup 协议、方向提示、nudge 也都会进去。直接渲染 = 用户以为这话是自己说的。→ `messages.synthetic` 必须过滤/标记。

### 9.3 store 适配器（接 erix-agent）

实现 `TranscriptStore`：`appendRound / load / recall / saveCheckpoint / appendCheckpoint / loadLatestCheckpoint / markRunState`。

四条注意：

1. **checkpoint 必须成对**（save + load）。不成对 → 恢复保护静默失效；成对 → **fail-closed**：工具执行前写失败则抛 `checkpoint_failed`，任务直接失败。
2. **store adapter 必须包 retry**，并把 `checkpoint_failed` 识别为**可重试**（erix ≤0.3.4 无重试）。adapter = 调 portal internal 端点的 HTTP adapter（不直连 DB，D1'/D2'），重试参数见 [runner-integration.md](runner-integration.md) §9.2。
3. **runId 用 UUID**，不要用 cwd 派生（多用户下会撞）。
4. `run_events` / 用量 / session 状态**不属于** `TranscriptStore` 契约 → 由 portal 在 internal 端点侧补齐（事件落库与 seq 分配、`last_seq` 推进、`usage_ledger` 记账；agentd 只负责上报，runner-integration §4.2/§7）。

> **原「⚠️ 强烈建议：本地 file 优先 + DB 异步复制」已按决策者裁定作废（2026-09，issue #3 评论，D2'）**：存储为**纯 DB（Postgres），不做 file 副本**；runner 的 TranscriptStore 实现 = 调 portal internal 端点的 HTTP adapter。中心 DB 抖动风险改由 adapter 重试包装补偿（runner-integration §9.2），代价（抖动超过重试窗口会使在跑任务 `checkpoint_failed` 失败）记录在 runner-integration §9.4。

---

## 10. 事件流与实时层

### 10.1 事件信封

| erix 回调 | 信封 |
|---|---|
| `onEvent`（`round_start`/`attempt`/`tool_use`/`tool_result`/`usage`/`round_end`/…） | `{seq, ts, session_id, run_id, type: 同 LoopEvent}` |
| `onDelta` / `onReasoningDelta` | `{type:"assistant_delta"｜"reasoning_delta", text}` |
| `onToolCall`（参数增量） | `{type:"tool_call_delta", ...}` |
| `onJudge` | `{type:"judge", kind, action, decision}` |
| `runToolLoop` 返回值 | `{type:"run_end", termination, usage, compaction_stats}` |

`seq`（erix 不提供）由宿主在落库时分配。

### 10.2 传输

- **SSE 而非 WebSocket**：事件单向（输入走 POST），SSE 自带断线重连 + `Last-Event-ID`
- **事件先落 DB，portal 从 DB 读并推流**——不直接透传容器的流。好处：**portal 重启不杀正在跑的任务**（run loop 在容器、状态在 DB）；多端同步；断线按 seq 补发
- 单节点用进程内 EventEmitter 即可；多节点再上 DB LISTEN/NOTIFY 或 pub/sub

### 10.3 portal ↔ 容器（全出站，B 方案；决策者 2026-09，issue #3 评论）

> 本节按决策者裁定重写（D1'/D2'，覆盖原「portal → 容器 push + 容器写 DB」描述）。完整协议（端点、租约、事件批量、审批中转）见 [runner-integration.md](runner-integration.md) §4；internal 端点契约见 [../api/portal.md](../api/portal.md) §9。

- **容器 → portal**：唯一通道 = portal 的 **internal HTTP API**（`/api/internal/*`，H-B 定稿 D-5（issue #5）：**经 Traefik**——`Host(station.<base>) && PathPrefix(/api/internal)` + `ipAllowList(10.200.0.0/16)` 限源后回环到 portal `127.0.0.1:8080`；容器侧经 `--add-host station.<base>:<网关IP>` 访问，见 topology.md §4-L3。原「仅 `control` 网络可达、不经 Traefik」随 `control` 取消一并作废）。所有平台状态写入（事件 / transcript / checkpoint / 用量 / 审批 / 状态收敛）都经该 API 由 **portal 落库**——**容器不直连 DB，Postgres 的业务写方只有 portal**。容器唯一的平台凭据是 **per-container token**（建容器时生成、存 DB、注入容器 env），每个请求以 `Authorization: Bearer` 出示，且只能操作本 FDE 的资源。
- **portal → 容器**：**不主动推、不要求容器监听端口**。改为 agentd 出站维持 **SSE 长连接（下行）**：派单唤醒 hint / 审批决定 / 停止指令 / 吊销；派单本身为**拉取**（claim 长轮询 hold + portal 侧 NOTIFY/事件唤醒；push 作为 P2 优化后置 ⚠️ 待决策者确认）。
- **租约与心跳**（参数 ⚠️ 待决策者确认）：claim 发租约（lease 90s），心跳 15s 续期并兼作停止指令的兜底轮询；连续 3 次心跳丢失（45s）判容器死，租约到期允许 re-claim。
- **取消**：`AbortController` 跨不了进程 → portal 写 DB `cancel_requested_at` 标记，经 SSE `stop_request` 下发 + 心跳响应兜底，agentd abort 对应 worker；终态收敛仍由 runner 侧上报、portal 落库。
- **为什么这样做**：容器是信任边界（原理一）——DB 凭据不进容器（泄漏面最小化，offboarding 吊销 token 即断）；容器零监听零入站（攻击面最小化，容器侧无需鉴权实现）；portal 无需感知容器在线（心跳即在线证明）。

---

## 11. LLM 接入与出口管控

### 11.1 先拆问题

| # | 问题 | 本质 |
|---|---|---|
| i | 上游凭据归谁持有 | 公司统一 token hub vs portal 自持 |
| ii | FDE 能不能改 endpoint/model/key | **控制面强制，本质是网络出口问题** |
| iii | 数据能不能发到外部 LLM | **网络出口问题** |

### 11.2 核心洞察（决定方案）

> **FDE 在自己容器里有 shell，不可能靠文件权限阻止他改配置。**
> 只读挂载、非 root、平台注入——**只能防「误改」**。他能 kill 掉 runner 自己起一个进程，或直接 `curl` 外部 API。

**唯一有效的保证是：网络到不了。** 把 LLM 网关做成唯一可达的 LLM 出口，其他 LLM 域名 DNS 不解析 / IP 不可达 → 改 endpoint、换 key 均无效。

> **职责边界（决策者 2026-09，issue #3）**：「网络到不了」由**网络层出口策略**实现，属**安全团队职责**，平台不负实施责任。技术事实：Docker 容器默认经宿主机 NAT 出网且无任何限制；出口策略只能在网络层实施（宿主机 iptables/nftables 按 docker 网络/容器 IP/veth 接口、或强制 egress 代理按域名白名单、或网络设备对容器所在网段做策略），平台业务代码实现不了。平台侧不可推卸的部分是**凭据红线**：容器内**零 LLM 凭据**（H-B 后连虚拟 key 也不放——仅占位 key + baseURL，真实虚拟 key 由 Traefik 按来源子网注入，§11.3），永不下放下游真实 key。

### 11.3 模式对比

| 模式 | 形态 | key 进容器 | 能改 endpoint 绕过 | 需自写代理 |
|---|---|---|---|---|
| A 直连 | 容器 → 网关（per-FDE 虚拟 key） | 是 | **能**（除非做出口管控） | 否 |
| B 经 portal | 容器 → portal → 上游 | 否 | 不能 | **是**（SSE 透传） |
| **C 网络强制（选定）** | 容器 → Traefik（按来源子网注入凭据）→ 网关，**且网关是唯一可达的 LLM 出口**（前提：安全团队网络层出口策略已实施，issue #3） | **否**（H-B 定稿 D-4，issue #5：容器零 LLM 凭据，Traefik 按 `ClientIP` 注入） | **不能** | 否 |

**选 C**：用现成的 LiteLLM/one-api 做网关（不自己写流式代理），portal 只做：

1. 开通账号时调网关 admin API **建虚拟 key**（额度、模型白名单、别名 `alice@client-x`）——key 随后由 portal（经 reconciler）写入**宿主 Traefik 动态配置**（文件权限 600，仅 portal 可写、Traefik 只读），**不下发容器**
2. 禁用账号时**吊销**（删 key + 删对应 LLM 注入路由）
3. 定期拉用量 → 落 `usage_ledger`，做**业务口径**（按 FDE / 按客户项目，网关不知道这层映射）

→ 待 Q1 确认公司是否已有网关；没有则先起一个 LiteLLM 容器，仍走 C。

> **H-B 链路（决策者 2026-09 定稿，issue #5 D-4；实测见 topology.md §10 证据 8）**：agent/worker 只认 `llm.<base>`——容器内**零 LLM 凭据**，仅占位 key + `baseURL=https://llm.<base>/v1`；请求经 Traefik（host:443），router `Host(llm.<base>) && ClientIP(10.200.<n>.0/29)` 按**网络来源**判定身份，headers middleware **覆盖** `Authorization: Bearer <该 FDE 虚拟 key>` + 注入 `X-FDE-Identity`（容器自带的任何 `Authorization` 均被覆盖）；service 回环到网关数据面 `127.0.0.1:4000`；网关 **admin 面不发布**、只在 `backend` 网络。**禁止无 ClientIP 条件的兜底路由**（无匹配来源 404 = 默认拒绝）。配套：`aliasHeadersStrategy: delete`、hub service `flushInterval` 调小、路由配置 600（§6.4，topology.md §6）。

> **澄清（归属归位）**：LLM 网关是**独立组件**——公司已有网关，或平台另起的网关容器（如 LiteLLM），**不是 portal 内部的实现模块**；portal 侧只有「租户绑定」逻辑（上面的 1/2/3）。Q1（公司是否已有网关）保持未决，本文不替选型拍板。

> 模式 C 的「唯一可达」是**依赖外部网络策略实现的前提**（安全团队职责，issue #3），不是平台自身交付物；该前提未成立时，模式 C 退化为「模式 A + 审计告警」（见 §11.4 降级路径）。

### 11.4 配套细节

- **容器内零 LLM 凭据**（H-B 定稿 D-4，issue #5）：容器 config 里只有占位 key + `baseURL=https://llm.<base>/v1`（`llm.<base>` 经 §5.3 hosts 注入解析到本 FDE 网关 IP）；真实虚拟 key 只存在于宿主 Traefik 动态配置（600，portal 可写、Traefik 只读）。原「key 经 `ERIX_API_KEY_FILE` 只读文件注入容器」**作废**
- **judge / fold 用便宜模型**：`ModelConfigProvider.resolve(slot)` 支持 `default` / `audit` / `fold`；长任务 judge 会 +10~30% 调用量
- **额度用尽**：网关 429 → erix 分类 `KitError(rate_limited, retryable)` → 宿主需友好提示，且避免重试继续烧配额
- **对账**：网关 usage 与 erix `onUsage` 两套数都要记（差异来自 judge/fold 的额外调用）
- **出口 allowlist 移交给安全团队的网络层策略**（白名单内容由安全团队维护）：npm registry、pypi、GitHub/内部 git、镜像仓库；**LLM 域名不在白名单**——这是「唯一出口」的实现方式（决策者 2026-09，issue #3）。平台对安全团队的接口：容器网络名/命名规范（`fde-<name>`）+ 子网段 `10.200.0.0/16`（`control` 已取消，H-B 定稿 issue #5）、审计事件、以及「上游 LLM 只经网关」的架构事实
- 若安全团队的出口策略未实施 → 「防用外部 key」降级为**审计 + 告警**，须管理层**书面知情**（性质不同）

---

## 12. 容器模板与工作区约定

### 12.1 目录布局

```
/srv/erix/users/<fde>/            # 宿主机；bind mount 到容器内同路径（路径一致性约定）
├── home/                          # HOME：.erix/{config.json,mcp.json,skills,todos}
├── projects/<project>/            # 仓库；含 .erix/ports.json
├── worktrees/<project>-<runId>/   # 每个 run 独占的 git worktree
└── cache/                         # 依赖缓存（npm/pnpm/pip）
```

> **容器网络（H-B 定稿，issue #5）**：FDE 容器**只接自己的 `/29`**（不接 `backend`、无 `control`）；Traefik 不在容器内（host 网络）；容器内**零 LLM 凭据**（§11）。文件投递（模板/AGENTS.md/ports.json）由 portal 直写上述宿主 bind mount（D-6），不需任何入站网络。

### 12.2 容器内约定（写进 FDE 容器的 AGENTS.md）

- 一个项目 = `~/projects/<project>`；一个 run = `~/worktrees/<project>-<runId>` + 分支 `agent/<runId>`
- 端口从 `~/projects/<project>/.erix/ports.json` 取，不自己挑；dev server 绑 `0.0.0.0`
- 回流走 fork/PR，不直接在主干改
- `git worktree` 由 **agent（FDE）自己在容器内全权管理**：创建、`worktree remove` / `worktree prune` 清理都归它自己负责，平台不介入（决策者 2026-09，issue #3 评论）；`.git` 是共享的，清理时别误删其他 run 的 worktree
- `node_modules` 每个 worktree 一份 → 用 pnpm store / npm cache 共享
- clone 与 git 凭据（SSH key / token）由 FDE 在容器内自行配置（等同他自己的开发机）；平台不下发、不代管 git 凭据（边界见 §7.2）

### 12.3 端口模板（FDE 容器内）

| 端口 | 用途 | 暴露 |
|---|---|---|
| ~~3000~~ | ~~`station-runner` 内部 API~~ **已取消**：容器平台通道零监听、全出站（§10.3，决策者 2026-09，issue #3 评论） | — |
| 3001 | code-server | FDE 私 |
| 4000+ | 按 run 分配的 dev servers / 浏览器调试 | FDE 私，可分享 |

> H-B 对齐确认（issue #5）：容器内**无 runner 监听端口**（3000 已取消，平台通道全出站经 Traefik，§5.3/§10.3）；Traefik 不在容器内（host 网络）；以上端口均不 publish，仅经 Traefik 每 allocation 一条路由可达（§6.4）。

> **建议把 code-server 放进模板**：纯聊天界面的 agent 很痛苦——人需要在同一台机器上接管、review、手改，IDE 与聊天面板指向同一 workspace 才叫协作。

### 12.4 Playwright

装进 FDE 容器（chromium ≈1GB），**不做独立 sidecar**——避免跨容器 `localhost` 的持续坑（sidecar 里的 `localhost` 不是 FDE 的 localhost）。成本不是约束时这是正确取舍。

---

## 13. 与 erix-agent 的依赖

### 13.1 会话层与宿主组装：本平台实现（原「等上游抽 src/session」P0 已作废）

宿主组装逻辑（config → provider → store → session → 组装 `runToolLoop` 参数）平台需要自己的一份。原设想「在 erix-agent 抽 `src/session/`（`createSession` / `submit` / `stop` / `history`）发 0.4.0」**不会发生**：上游把会话管理明确列为**永久非目标**——erix-agent `docs/requirements.md` §2「非目标（永远不做）」原文：「❌ agent 人格/skills/会话管理/TUI/MCP」。因此该 P0 **作废删除**（决策者 2026-09，issue #3 评论）。

→ **会话层与宿主组装由本平台实现**：portal（会话 CRUD / 入队 / 状态收敛）+ FDE 容器内 `station-agentd` / `station-runner`（claim / 执行 / 上报）+ DB。对上游的依赖**只剩 run 级接口面**：`runToolLoop` + `TranscriptStore` 接口（6 方法）+ `erix-agent/tools`（jail / file-tools / registry / recall）+ `erix-agent/contract-tests` + `config/*`。

完整进程模型、出站协议、store adapter 与 run 生命周期设计见 [`runner-integration.md`](runner-integration.md)。

### 13.2 erix 侧缺口（均可在宿主侧包掉，不改库）

1. `TranscriptStore` 无 list/search → 宿主 SQL 天然解决
2. `LoopEvent` 无 seq/ts/持久化 → 宿主 store decorator 补
3. `onEvent` 是同步 void，事件分散在 6 个回调 → 建议 additive 增补 `assistant_delta` / `reasoning_delta` / `tool_call_delta` / `judge` 类型（可选增强）
4. **多轮必须显式传 `task`**（host-upgrade-guide §2），否则 judge 拿旧种子当基准
5. `checkpoint_failed` fail-closed 语义 → 见 §9.3
6. `erix-agent/contract-tests` 应接入 CI（长期运行的宿主必需）

---

## 14. 部署与运维（裸 Linux host + Docker）

- 平台栈用 `deploy/docker-compose.yml`：`station-edge`（Traefik，**host 网络**，独占 80/443，`--api=false`）+ `station-portal`（`backend` 网络，publish 仅 `127.0.0.1:8080` 回环）+ `station-db`（`backend` 网络，不 publish）（H-B 定稿，issue #5）
- FDE 容器由 portal 通过 Docker API 动态创建（模板化，非 compose）
- **数据持久化**：bind mount 一律 `/docker/<名称>/`（平台统一约定）；用户空间 `/srv/erix/users/<fde>/`（宿主路径与容器内一致）
- `restart: unless-stopped`；DB 与 portal 配 healthcheck
- **容器资源限额**：FDE 容器的创建参数（如 `--memory` 限额）只能由 portal 经 Docker API 设置（容器创建参数为平台侧独有）；`node_modules` 每 worktree 一份的磁盘/内存压力在容器内由 FDE 用 pnpm store / npm cache 自行缓解（§12.2）
- **可靠性**：中心 DB 是全平台单点；portal 无状态（状态在 DB），可重启。**DB 备份/高可用不在本项目范围**（系统级方案负责，决策者 2026-09，issue #3 评论）——平台侧只保证数据落卷（bind mount，见上）、DB 处于可被系统级备份方案备份的形态
- **可观测**：run 事件、judge 决策、工具调用、访问审计、用量都在 DB，直接做看板
- **长任务无人看** → 完成/失败/需审批时通知（邮件或 IM webhook）——**延后（P2+），P1 不做**（决策者 2026-09，issue #3 评论）。§7.1 本地 admin 登录告警、§11.4 出口策略未实施时的管理层书面知情，语义保留（它们是设计结论），但**通知通道实现同属延后事项**，不阻塞 P1

---

## 15. 分期计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | Traefik + portal + DB + 单 FDE 容器（含 station-agentd / station-runner）；登录、项目列表、对话（SSE）、停止 | 真机走通「登录→建项目→对话→工具卡片→停止」；playwright + vision 验证 |
| **P2** | 多 FDE、端口分配 + 预览卡片/iframe、事件重放、工具审批、账号生命周期 workflow | 断线重连不漏事件；**FDE A 无法访问 FDE B 的任何端口** |
| **P3** | LLM 网关 + 用量记账 + 审计 + code-server 模板（出口管控为**外部依赖**：安全团队网络层策略，issue #3，非平台交付项） | 成本可按客户项目归集；安全团队出口策略实施后「改 endpoint 无效」，未实施时降级为审计+告警 |

> **原 P0（「等 erix-agent 抽 `src/session/` 发 0.4.0」）已删除**（决策者 2026-09，issue #3 评论）：上游把会话管理列为永久非目标（§13.1），会话层由本平台自实现。**P1 内容不变，只是解除了外部依赖阻塞**——P1 现为第一阶段。

> **与 erix-agent 的跨仓库关系**（与项目 AGENTS.md 约定一致）：
>
> 1. 若将来发现引擎能力缺口，仍以 **issue 形式提给 erix-agent 仓库**；本仓库不实现引擎逻辑。当前**无阻塞性上游缺口**（会话层自实现，§13.1）。
> 2. **版本 pin 策略**：erix-station 侧 pin 具体 erix-agent 版本进入 FDE 容器镜像/模板，升级走 canary；版本记录点为 `containers.agent_version`（§9.1）。
> 3. 本项目**不修改** erix-agent 行为，只依赖其公开 API（`runToolLoop` / `TranscriptStore` / `erix-agent/tools` / `contract-tests` / `config/*`，§13.1）。

---

## 附录 A：决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | ingress 用 **Traefik**，路由由 portal 生成写入 file provider | 动态配置简单、内置 forwardAuth、自动证书；路由与 DB 端口表强一致可审计 |
| D2 | 登录走 **SSO(OIDC) + 本地 break-glass admin** | SSO 日常；本地账号是 IdP 故障时唯一通道，强制 TOTP + 审计 |
| D3 | ~~每 FDE 容器 = `control` + `fde-<name>` 双网络接入~~ **已被 H-B 取代**（决策者 2026-09，issue #5 定稿 D-1）：每 FDE 仅自己的 `/29`，**取消 `control`**；portal 在 `backend` 网络，Traefik 在 host | 共享 `control` 是横向越权根源；隔离靠拓扑（无共享网络 + Docker 不转发跨 bridge），「FDE 互相不可达」不变 |
| D4 | **不 publish 任何 FDE 端口** | 堵死绕过 ingress 的第二条路；所有 auth 生效的前提 |
| D5 | dev 端口由**平台分配**，DB 为真相 + `.erix/ports.json` 为派生副本（单向） | 防冲突/URL 漂移；agent 不自己挑端口 |
| D6 | LLM 走**模式 C：唯一可达的网关出口**；其中「FDE 改不了 endpoint」**依赖网络层出口策略（安全团队职责），平台不负实施责任**；策略未实施时降级为审计+告警，须管理层书面知情（决策者 2026-09，issue #3） | 「FDE 改不了 endpoint」只能靠网络强制，不能靠文件权限 |
| D7 | 事件/transcript 落中心 DB，portal 从 DB 读并发 SSE | portal 重启不杀任务；断线可按 Last-Event-ID 补发 |
| D8 | 隔离单元 = **worktree**（`agent/<runId>` 分支） | 同仓库并发多 agent 不冲突；回流走 fork/PR |
| D9 | **认证放边缘**，dev server 与 agent 不感知认证 | 安全设施对 agent 工具链透明；应用零改造 |
| D10 | 仓库名 `erix-station`，展示名 **FDE Station** | 标识短（天天打）、展示名说清语义 |
