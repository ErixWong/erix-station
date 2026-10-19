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
| Q1 | 公司是否已有统一 LLM 网关（候选分析与活跃度筛查见 [`llm-gateway/llm-gateway-selection.md`](llm-gateway/llm-gateway-selection.md)；one-api / one-hub 已因停更淘汰） | 决定 portal 是「租户绑定」还是「兼做网关」（§11） | ⚠️ 待定 |
| Q2 | 出口管控（egress）职责归属 | 平台侧保证凭据层（虚拟 key）+ 审计；网络层阻断（容器能否出网、可访问哪些域名）由安全团队负责（§11） | ✅ 已定：外部依赖（安全团队），决策者 2026-09（issue #3） |
| Q3 | 本地 admin 的定位：仅破窗，还是 FDE 也可用？ | 认证设计（§6） | ⚠️ 待定 |
| Q4 | LLM 虚拟 key 粒度：每 FDE 一把，还是每客户项目一把？ | 成本归属精度 vs key 数量（§11） | ⚠️ 待定 |
| Q5 | 端口分级：项目级 + run 级都做，还是先只做项目级？ | 端口模型复杂度（§8） | ⚠️ 待定 |
| Q6 | 部署形态：同一台宿主机裸 docker，还是将来上 K8s？ | 编排实现（§14）。当前按**裸 Linux host + Docker** 设计 | 暂按裸机 |
| Q7 | portal 技术栈与依赖政策：零依赖 Node，还是允许框架依赖？ | 实现选型 | ✅ 已定稿（原生 `node:http` + 原生前端、零 Web 框架；运行时依赖 `pg` 与 YAML 配置解析器，principles.md；WP1 落地） |

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

> **issue #117 phase 2 当前口径**：本文件后续保留的旧 LLM 网关细节若提及真实上游 key、per-provider 直发或 station-mock-llm，均属历史方案；当前由 LiteLLM 持有模型目录和上游 credential，Traefik 注入 per-FDE virtual key 并将所有 FDE 路由送往单一 `llm-gateway` service。运行契约见 [`../data/model.md`](../data/model.md) §1.20 与 [`../../deploy/litellm/README.md`](../../deploy/litellm/README.md)。

```
                          ┌──────────────────────────────────────────────┐
   FDE 浏览器 ───────────▶│  ingress: Traefik（host 网络，独占 80/443，   │
                          │  --api=false，唯一 ingress；不接任何 docker 网络）│
                          └───┬───────────────┬──────────────┬───────────┘
      station.<domain>        │               │ *.fde.<domain>│  llm.<domain>
      （portal：登录/项目/对话） │               │ （项目预览）   │（LLM 调用：Traefik
                              ▼               ▼              │  按来源子网注入凭据）
                    ┌──────────────────┐  ┌──────────────────────────────┐ ▼
                    │  station-portal  │  │ FDE 容器 "alice"（仅自己的   │ ┌───────────────┐
                    │  用户/项目/端口   │  │  /29，如 10.200.1.0/29）    │ │ LLM 网关      │
                    │  容器生命周期     │  │  station-agentd（守护/桥接）   │ │（backend 网络；│
                    │  事件/SSE        │  │  station-runner（每 run 子进程）│ │ 数据面 publish │
                    └────────┬─────────┘  │  :4000+ dev servers          │ │ 127.0.0.1:4100 │
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
docker network: backend    ← portal + station-db + station-litellm（litellm profile）
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
| `fde-<name>`（FDE 容器） | `station-agentd`（常驻守护/桥接，唯一出站连 portal）+ `station-runner`（每 run 一个子进程，跑 erix agent）+ dev servers（进程模型见 [runner-integration.md](runner-integration.md) §2，命名 ⚠️ 待决策者确认）；平台状态一律经 portal internal API 落 DB——**容器不直连 DB**（决策者 2026-09，issue #3 评论） | 不 publish 端口、**不监听任何对外端口**、不挂 `docker.sock`、**不持有平台密钥（含 DB 凭据）**——唯一平台凭据为 per-container token，仅 agentd 持有 |

**只有 `station-docker-proxy` 挂 `/var/run/docker.sock`（只读）**；portal **不直挂**，经 `DOCKER_HOST=tcp://station-docker-proxy:2375` 访问 Docker API——proxy 为（自研零依赖 Node admission proxy，方法+路径白名单 12 条 + `POST /containers/create` 参数级 allowlist；完整契约见 deploy-contract §5.1。原「tecnativa/docker-socket-proxy + 类别级 env 白名单」方案已被替换）。FDE 容器永不挂。

---

## 5. 网络与隔离模型（H-B，决策者 2026-09 定稿，issue #5）

> 本节已按 H-B 定稿重写（issue #5 两条定稿评论）。**单一事实来源是 [`topology.md`](topology.md)**（全链路 L1–L10、连通矩阵、10 条加固清单、9 项实测证据、reconciler 职责），本节只保留规格层面的模型与不变式。

### 5.1 拓扑（决定一切）

**网络清单**：

| 网络 | 成员 | 子网 |
|---|---|---|
| **host** | Traefik（host 网络模式，零 docker 网络接入，独占 80/443） | —（不占 docker 网络） |
| **`backend`** | portal（publish 仅 `127.0.0.1:8080` 回环）+ station-db + station-docker-proxy + LLM 网关（issue #117 phase 1 以 opt-in profile 加入） | **显式 `172.30.0.0/24`**（与 FDE 池 `10.200.0.0/16` / `10.201.0.0/16` 隔离，topology.md §2/§3；成员表以 deploy-contract §2.1 为准） |
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

容器内 dev server **仍然监听**端口（4000+），只是仅在容器自己的 `/29` 内可达：

- **预览**：Traefik（host）→ forwardAuth（`http://127.0.0.1:8080/api/forward-auth`）→ 直连容器 IP `http://10.200.<n>.2:<port>`（每 allocation 一条 router+service，§6.4；topology.md §4-L2）
- **平台通道全出站经 Traefik**（方向反转为决策者 2026-09 裁定，issue #3 评论；经 Traefik 为 H-B 定稿 D-5，issue #5）：容器内不再有 runner 监听端口（3000 角色取消，§12.3），portal **不主动访问容器**；`station-agentd` 全出站——`https://station.<base>/api/internal/*`（容器侧 `--add-host station.<base>:<网关IP>`），Traefik 上以 `ipAllowList`（由 `fde_networks` 精确派生，每 `subnet` 一条 `/29` 或 `/28`，topology.md §5.1）限源后回环到 portal `127.0.0.1:8080`（SSE 下行 + POST 上行，§10.3；取舍对比见 [runner-integration.md](runner-integration.md) §11.2；topology.md §4-L3）
- **LLM 调用**：worker → `https://llm.<base>` → Traefik 按来源子网注入 per-FDE LiteLLM virtual key → 单一 `llm-gateway` service → LiteLLM（默认宿主回环 `127.0.0.1:4100`；topology.md §4-L7）
- **hosts 注入（创建 FDE 容器时，docker `--add-host` 或等价受控方式）**：容器内解析 `station.<base>` 与 `llm.<base>` 都**不走内网/公网 DNS**，映射到该 FDE 的 bridge 网关 IP（默认池 `10.200.<n>.1`；大 FDE `10.201.<n>.1`）。开发期 `*.localhost` 变通对容器无效，必须同样注入（env.md §0/§1；topology.md §4-L3）

---

## 6. 访问控制与认证

### 6.1 「只有本人可见」= 两件事同时成立

| 层 | 机制 | 挡住的攻击 |
|---|---|---|
| ① **网络拓扑** | 每 FDE 独立 `/29`；dev 端口不 publish；Traefik 在 host 网络、零接入即可达所有容器（H-B，§5） | 其他 FDE 的容器直连；内网/公网直连宿主机端口 |
| ② **门口授权** | Traefik forwardAuth：按 token 哈希查 `preview_grants`（预览凭证）解析 `user_id`，再与 hostname 对应 allocation 的 `fde_id` 及 `exposure` 比对（owner 本人或显式 admin 例外，见 portal.md §2.7 第 5 步；**不解析 cookie `sub`**；portal 自身会话校验才查 `login_sessions`，同为哈希口径；细节见 [portal.md](../api/portal.md) §2.7 / [topology.md](topology.md) §5.2） | 同在 VPN 的其他人、会话被钓鱼、链接被转发 |

**只有①没②**：任何能连 ingress 的人都能看 → 需求不达成。
**只有②没①**：一句 `curl 172.x.x.x:4000` 绕过门 → 更糟（有防护的错觉）。

> **核心原则：认证放在边缘，应用自身不感知。** dev server 不做任何改造；容器内的 agent 用 `127.0.0.1` 访问自己的服务，完全不受影响。

### 6.2 为什么不用 IP 白名单 / basic auth 作主机制

- **IP allowlist**：VPN 池与 DHCP 会变；**公司出口 NAT 会把所有人塌缩成同一源 IP**（要么宽到人人可看，要么严到自己进不去）；多设备/手机/客户现场失效。→ 正确用法是「整个平台只在 VPN 内网可达」这一层。
- **basic auth**：浏览器按 host+realm 自动重发凭据（共享浏览器/录屏泄漏面）；每子域弹密码；静态密钥轮换与离职要逐容器改；无法表达分级可见性；无访问审计；不复用 SSO。→ 只作**兜底**（forwardAuth 挂掉时 deny-all）或内部非浏览器客户端使用。

### 6.3 域名与 cookie（必踩的两个坑）

| 坑 | 解法 |
|---|---|
| **SameSite 打死 iframe**：portal 在 `station.a.com`、预览在 `b.com` → cross-site → iframe 里 cookie 不发送，预览显示登录页 | **把 FDE 页面放在与 portal 同一 registrable domain 下**：portal = `station.<base>`，预览 = `alice-p-4000.fde.<base>`。同 site → `SameSite=Lax` 在 iframe 内正常发送。⚠️ **P1 预览凭证不再是 portal session cookie**：portal 签发一次性 ticket，forwardAuth 换取**预览 host 的 host-only 预览 cookie**（portal session cookie 为 host-only、绝不发到预览域）——同 registrable domain 布局仍保留，是为让「预览 host 自己的 cookie」在 iframe 内为 same-site；细节见 [portal.md](../api/portal.md) §2.5/§2.7/§2.8 |
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
    # 预览：每 allocation 一条 router + 一条 service（Host 精确匹配，各自独立 priority）。
    # 否决原「单条 HostRegexp + service: fde-dynamic」的「零 per-port 配置」方案——
    # 单 service 无法表达 per-allocation 的后端地址与生命周期（issue #9，topology.md §5）
    fde-alice-p-4000:
      rule: "Host(`alice-p-4000.fde.<base>`)"
      entryPoints: [websecure]
      priority: 200
      middlewares: [fde-auth, strip-cookie]
      service: fde-alice-p-4000
    # LLM 注入：每 FDE 一条 router + 一条 headers middleware（各自独立 priority）；
    # 身份来自网络来源（ClientIP），非自报；禁止写无 ClientIP 条件的兜底路由（无匹配 404 = 默认拒绝）
    # （issue #117 phase 2：按 fde_llm_bindings 逐 binding 注入 LiteLLM virtual key；
    #  所有 FDE 共用 llm-gateway service；无 binding 不生成 LLM 路由 = fail-closed；
    #  本段实际发布在独立文件 llm-routes.yml，mode 600）
    llm-alice:
      rule: "Host(`llm.<base>`) && ClientIP(`10.200.1.0/29`)"
      entryPoints: [websecure]
      priority: 200
      middlewares: [llm-key-alice]
      service: llm-gateway
    # 大 FDE（/28）示例：rule: "Host(`llm.<base>`) && ClientIP(`10.201.7.0/28`)"（subnet 由 fde_networks 派生，topology.md §5.1）
  middlewares:
    fde-auth:
      forwardAuth:
        address: "http://127.0.0.1:8080/api/forward-auth"   # Traefik 在 host、portal 发布在回环，不再走容器网络寻址
        authRequestHeaders: [X-Forwarded-Host, X-Forwarded-Uri, X-Forwarded-Method, X-Forwarded-Proto, Cookie, Origin, Access-Control-Request-Method]   # #241：Origin/ACRM 必须进白名单，否则 portal 无法识别预检、也无法回显 ACAO（白名单外的头一律丢弃）
        authResponseHeaders: [X-Auth-User]
    strip-cookie:
      headers:
        customRequestHeaders:
          Cookie: ""   # 放行后删除 Cookie：预览 cookie 只到 forwardAuth、绝不透传上游（B2 实测验证）
    internal-allow:
      ipAllowList:
        # 从 fde_networks 精确派生：state ∈ {allocated,active} 的每个 subnet 一条（topology.md §5.1）。
        # 示例（若 fde_networks 现有 10.200.1.0/29 与 10.201.7.0/28 两块）：
        sourceRange: ["10.200.1.0/29", "10.201.7.0/28"]
        # ⚠️ 池范围 ≠ 放行范围：10.200.0.0/16 / 10.201.0.0/16 仅是取值池，禁止直接写入 sourceRange
        # 不配置 ipStrategy.depth / ipStrategy.excludedIPs：默认按 request remote address 判定（不读 X-Forwarded-For）
    llm-key-alice:
      headers:
        customRequestHeaders:                 # 覆盖容器自带的任何 Authorization（实测可覆盖伪造头）
          Authorization: "Bearer <alice binding 的真实上游 api_key>"   # 2026-09-20 修订（issue #38）：不再有平台虚拟 key / X-FDE-Identity
  services:
    portal:
      loadBalancer:
        servers: [{ url: "http://127.0.0.1:8080" }]
    fde-alice-4000:
      loadBalancer:
        servers: [{ url: "http://10.200.1.2:4000" }]   # 容器 IP；重建漂移由 reconciler 重写（H-B 唯一技术债，topology.md §4-L8/§8）
    llm-provider-<id 前 8 位>:
      loadBalancer:
        servers: [{ url: "<llm_providers.base_url，如 http://127.0.0.1:4000>" }]   # 2026-09-20 修订（issue #38）：per-provider 上游直发，不再共享 llm-hub
        # responseForwarding.flushInterval 必须调小（≤100ms），否则 token 流被缓冲成整段（topology.md §6 第 5 条）
```

> **预览链路 Cookie 边界（B2，已用 `traefik:v3` + `traefik/whoami` 实跑验证）**：`fde-auth` 的 `authRequestHeaders` 是**最小 allowlist**——forwardAuth 只收到 `X-Forwarded-*`（Host/Uri/Method/Proto）与 `Cookie`（预览凭证 `__Host-fde_preview`；portal session cookie 为 host-only、到不了预览 host）。放行后 `strip-cookie` 中间件**删除 `Cookie`**，保证预览上游（dev server）收到的请求头里**没有 `Cookie`**（whoami 回显：上游无 `Cookie` 头）。**方法覆盖（#263 复测补实，2026-10-13）**：剥除对 **GET/POST/PUT/PATCH/DELETE 全方法一致**（同版本 `traefik:v3.7.13` 干净试验台 + 现网 echo 双方法复测），B2 承诺成立；曾疑似的「只对读方法生效」不可复现，已证伪关单。应用自己的会话凭证因此**不得依赖 Cookie**，要走 `Authorization: Bearer`（告知面见 `~/AGENTS.md` 预览访问节第 7 条 / #262）。**302 阶段**：forwardAuth 返回 `302 + Set-Cookie + Location` 时，Traefik 把该响应**原样透传给浏览器**（不剥离 `Set-Cookie`、不缓存）；`Location` 必须用**绝对 URL**（portal §2.7 第 6 步已如此，相对路径会被 Traefik 改写成相对 forwardAuth 地址）。

> **预检与 deny 的 CORS（#241，2026-10-11 在 `traefik:v3.7.13` 真机实测）**：① **预检免鉴权在 portal 完成**（不在边缘加 `cors`/`headers` 中间件）：上游 dev server 自己已回 `Access-Control-Allow-Origin`，Traefik 的 CORS 中间件在反向代理**之前**写头、`ReverseProxy` 对后端响应是 **`Add` 而非 `Set`**，叠加后客户端会收到两个 `Access-Control-Allow-Origin` → 浏览器报「contains multiple values」而打断本已正常的带凭据请求。预检被 portal 判为放行后，Traefik 将 `OPTIONS` 原样转发给上游，由应用自己回 `Access-Control-Allow-*`（实测 204 + 全套头）。② **deny 分支的响应头会被 Traefik 透给客户端**：auth 子响应返回 `403` 时，客户端收到的状态码、响应体与**自定义响应头**均为 portal 所发（实测 `Access-Control-Allow-Origin`/`-Allow-Credentials`/`Vary` 均出现；`Connection`/`Keep-Alive` 这类逐跳头会被丢掉）。因此 ACAO 回显只需在 portal 的 deny 分支做（详 portal.md §2.7）。

portal 的 `/api/forward-auth` 逻辑：**解析 `X-Forwarded-Host` → 精确查 `port_allocations.hostname` → 按 token 哈希查 `preview_grants`（一次性 ticket / host-only 预览 cookie；portal 自身会话才查 `login_sessions`）→ 按 `exposure` 授权**（**不解析 session cookie 的 `sub`**）。端口/槽位白名单、审计日志都在这里做；执行顺序与失败语义见 [portal.md](../api/portal.md) §2.7 与 [topology.md](topology.md) §5.2，此处不重复定义。

**路由由 portal 生成、经 reconciler 幂等发布到 Traefik file provider，与 DB 的端口分配表同源**（DB 事务写 `port_allocations` + route outbox/revision，§8.1）——不允许手工改，也不允许 FDE 容器打 label 自注册（「路由表里没有 = 不可达」「FDE 不能自注册路由」这两条性质必须成立）。动态配置文件含全部虚拟 key，宿主文件权限 **600**，仅 portal 可写、Traefik 只读（topology.md §6 第 8 条）。

> **LLM 网关凭据入口收紧（H-B）**：LLM 网关数据面只接受 Traefik 经 `fde-<name>-llm` router 注入的 `Authorization` 头；网关须显式**拒绝**其它凭据输入通道（`X-API-Key`、HTTP Basic、cookie、query token）——否则容器可绕过「来源子网 → 身份」判定直接出示凭据（topology.md §4-L7）。

> **安全前提（ipAllowList / ClientIP 均按 request remote address 判定，不读 `X-Forwarded-For`）**：容器**直达宿主 Traefik（host:443）、中间无任何代理**，是「来源子网 = 身份」成立的前提。作为配置约束写死：public entryPoint 不配 `forwardedHeaders.insecure`；`ipAllowList` / `ClientIP` 不配基于 XFF 的 `ipStrategy`（`depth` / `excludedIPs`）。**验收项**：伪造/重复 `X-Forwarded-For` 头不得影响来源判定（topology.md §10 证据 8 的反向断言）。

### 6.5 访问分级（沿用 Codespaces 词汇）

| 级别 | 含义 |
|---|---|
| `private`（默认） | 仅 owner 可访问（owner 预览凭证，或显式 admin 例外——判定主体为预览凭证非 session，见 portal.md §2.7 第 5 步） |
| `org-visible` | 认证同事可见（需要时再开）——**未启用**：写侧无入口（见下方口径注） |
| `public` | token 链接 / 真公开（**默认不给**）——**未启用**：同上 |

> ⚠ **交付口径（#250 裁决，2026-10-11）**：本表的三档是**词汇表的完整集**，被交付的只有 `private`。
> 全仓唯一写点 = 开户时写死 `private`（`portal/src/portalloc.js:101`），**无 UPDATE**（真机 20 条活 allocation 全 `private`）。
> 理由（决策者）：**预览不对外分享**——测试环境一旦被长期开放，就会被当成生产环境；人对人临时分享走 §2.8 一次性 ticket。
> 另：访问控制挡得住「访问」，**挡不住「误认」**——外来者唯一看得见的标记是域名（现 `*.fde.erix.vip:8090` 看起来像真站）；
> 若要对外标示测试性质（候选：`*.lab.erix.vip` 一类伞域），那是**对外品牌决策**，需同时改 Traefik host 与 cookie domain，**未决**。

---

## 7. 账号生命周期

### 7.1 双通道认证

| | FDE 日常 | 本地 admin |
|---|---|---|
| 来源 | OIDC（JIT provisioning：首次登录按 email 建档，group claim 映射角色） | portal 本地表 |
| 凭据 | 公司 SSO | 口令哈希 + **强制 TOTP**（目标 argon2id；P1 骨架暂用 `crypto.scrypt`，迁移项见 portal.md §2.9.4） |
| 数量 | N | 1~2 个（写进值班文档） |
| 用途 | 日常 | break-glass、初始 bootstrap（第一个 admin 只能本地建） |
| 审计 | 常规 | **每次登录/操作强制审计 + 告警**（本地账号登录本身即异常信号） |

角色来自 group claim（`fde` / `admin`），不在 UI 手点。

### 7.2 onboarding = 一个 workflow（5 步）

1. 建 user 记录（角色来自 claim）
2. **分配子网（IPAM）→ 建 `fde-<name>` 网络 → 起容器**（H-B 定稿 D-1/D-10，issue #5）：portal 查 `fde_networks` 推荐下一块空闲 `/29`（管理员可改），`docker network create --subnet` 显式创建；容器**只接自己这条网络**（不再有 `control` 接入），bind mount 用户空间
3. **预分配一整段预览域名 + 同事务触发派生链**（issue #240 引入、issue #246 交付①把端口来源换成全局号池；决策者 2026-10-11 裁决）：`portal/src/portalloc.js` 的 `ensureFdePreviewPorts` 在**一个 DB 事务**里写 `port_allocations` **一整块 10 行**（`scope='fde'`、端口 = **全局号池 `22000–29999` 里最小的未占用对齐块**（#246；旧实现写死 `4000–4009`）、`role='spare'`、`exposure='private'`、`state='allocated'`，口径见 §8.2），并在**同一事务**内入队 route outbox/revision + materialize revision ⇒ reconciler **幂等发布** Traefik 路由、materializer 重写 `~/.erix/ports.json`，两条派生链都不需要人工触发（PG 事务无法含文件写入，故仍是「事务写 desired state + outbox」、由 reconciler 异步落盘，§8.1；历史上 `port_allocations` 从没被产品代码写过，手工插完之后路由与 `ports.json` 一律不动——这正是 #240 要消灭的动作）。幂等判据 = 既有部分唯一索引 `port_allocations_live_port_key (fde_id, port) WHERE state <> 'released'` + `ON CONFLICT DO NOTHING`（**与 #246 的全局索引并存**：同 FDE 重跑零插入，跳 FDE 撞号则整笔回滚并报 `preview_port_block_taken`）⇒ 重跑 `cli.js provision-fde` 只补缺口、已齐备则零插入零入队，输出行带 `block=<起>-<止>`
4. **物化用户空间文件（bind mount）**：portal 直写宿主 `/srv/erix/users/<fde>/`（H-B 定稿 D-6，issue #7，无需任何入站网络；原「落容器内文件需容器网络可达」类表述随之作废）——含 `AGENTS.md`、`~/.erix/config.json`、项目 `.erix/ports.json`、模板与 `manifest.json`。**文件清单、路径映射、原子写、UID/权限、失败重试、重建幂等、项目目录归属的完整契约见 [`user-space.md`](user-space.md)**（本条由原「写模板/AGENTS.md」单点描述扩充为该契约）
5. **创建 LLM 绑定**：按建号表单必选的 LiteLLM provider 与主模型（可选 embedding / vision）创建模型白名单受限的 per-FDE 虚拟 key 并发布 LLM 注入路由；key 只写进宿主 Traefik 动态配置（600），**不进容器**（容器内零 LLM 凭据，§11）

> **边界**：平台交付到「**容器内一个仓库目录** + 端口分配 + 模板」为止。平台不绑定单一 git host 产品；管理台可新建 Gitea/GitLab（可选平台代铸）与 GitHub host。GitHub 以 `per_fde_pat` 支持：平台无法为其代铸 per-FDE 凭据（凭据由管理员/FDE 提供，host 的 mode 恒为「需凭据」，配置 admin key 会被拒绝），azure 仍空悬。agent 代劳 clone，Git 凭据由 FDE 经 portal 投放（#110）到 `home/.git-credentials`；GitHub 另写 `~/.config/gh/hosts.yml` 供 gh CLI 读取。此 write-through 凭据文件不进 DB/日志/audit payload，细节见 [`user-space.md`](user-space.md) §4.1.1。平台不下发 SSH key（SSH 强制私钥 `0600` 与组可读 `0640` 冲突）。

**开户执行（issue #111 A；LLM 绑定按 issue #146 更新）**：管理台新建 FDE 时 email、`fde_name`、启用中的 Git host，以及 LiteLLM 目录中的 provider 和至少一个启用且支持 tool-calling 的主模型必填。目录不可达（LiteLLM profile 未启用或故障）时 fail-closed，拒绝创建用户。用户、模型选择（保存在 `fde_onboarding.steps` JSONB）、Git host 绑定与队列记录在同一 DB 事务内写入。portal 后台依次执行 provision、用户空间 materialize、`llm-binding` 并持久化步骤状态；LLM key 创建失败只将该步骤记为 `failed`，不阻断账户主体，整体终态仍按 Git 凭据状态取 `done` / `awaiting_credential`。**`per_fde_pat` 模式下开户时凭据尚未投放、用户处于 `awaiting_credential`，但物化照常生效（见 [`user-space.md`](user-space.md) §8.1）——平台文件不因凭据待补而缺失**；管理员/FDE 投放凭据把状态翻回 `active` 时 portal 会在同一事务内补入队一次物化 revision（issue #183）。**同一「活」状态口径也适用于容器对账（issue #185）**：`awaiting_credential` 的 FDE 仍在 reconciler 的「应有容器」期望集内——删/换 Git 凭据把状态翻成 `awaiting_credential` 时，既有容器**不得**被判孤儿删除重建（正在跑的 run 不被杀）；`disabled` 仍排除（offboarding 后容器照常被清）。管理员可用 onboarding retry 重试该独立步骤；若已有 binding（例如管理员先手配），开户步骤跳过且不覆盖。其他步骤失败仍由管理员显式重试，已完成步骤跳过。

### 7.3 offboarding（issue #110，已实现；政策定稿见 issue #160）

> **政策（决策者拍板）：下线 = 只停用，不删号。** `users` 行与全部关联 DB 记录**永久保留**（审计要求至少保留 10 年）；workspace **默认不自动清理**；上游 Git 账号通过 `prohibit_login` 吊销访问而**不删上游账号**。

```
立即停用账号/失效登录会话并停止活动 run
→ 停容器 + 吊销 runner token + 吊销 LLM 虚拟 key + 删除 Git 凭据与 CLI 配置
→ 吊销上游 Git 账号访问（minted 账号置 prohibit_login=true；per_fde_pat 用户自管凭据不触碰，GitLab 暂缓）
→ 释放网络、端口与路由（并撤销该 FDE 全部 allocation 上**仍 `active`** 的预览凭证：按 allocation id 无条件幂等撤，`used` 保留原状——#252，portal.md §2.8）
→ （仅当显式配置保留期时）记录 workspace 到期时间 —— 删除只发生在运维显式开启后的 workspace 目录
```

八个幂等步骤（`portal/src/offboarding.js` 的 `STEPS`）：`disable-user` / `stop-container` / `revoke-runner-token` / `revoke-llm-key` / `delete-git-credential` / `revoke-git-account-access` / `release-network-routes` / `schedule-workspace-purge`。

管理台 `DELETE /api/admin/users/:id` **任何情况下都不删除 `users` 行**：事务内立即设 `status='disabled'` + `disabled_at`、清 `login_sessions`/`login_pending`/`api_tokens`、撤销 `preview_grants`（只撤 `state='active'`，`used` 保留原状，#252）；有 FDE 资源或 workspace 存在的返回 `202` 并持久化 offboarding 队列，否则返回 `204`（同样只是停用）。worker 按步骤幂等执行，失败可由管理员重试，账号保持 disabled。

`ERIX_WORKSPACE_RETENTION_DAYS` 默认 **`0`（永不自动清理）**，此时 `workspace_purge_after` 恒为 `NULL`；显式正数才记录到期时间。到期 sweep 只处理 `fde_offboarding.state='done'` 的记录，先用真实路径守护删除 `/srv/erix/users/<fde_name>`，**不删除任何 DB 行**——用户、Git 绑定、offboarding 记录与审计全部保留。

**重新雇用同名 FDE**（issue #161）：复用原 disabled 行而非新建，两次雇佣沿用同一用户 ID 与审计/历史；保留策略与重雇细节见 [`user-space.md`](user-space.md) 的「Offboarding 与保留策略」「重新激活」两段。

并配一个**定时与 IdP 对账**的任务（拉 IdP 用户列表 → 比对 → 停用；issue #135，SSO 范围，尚未实现）。SSO 侧停用 ≠ 本平台停用——**onboarding 和 offboarding 是同一 workflow 的两端，只做前者是内部平台最常见的腐烂方式**。

---

## 8. 端口分配模型

### 8.1 DB 是真相，JSON 是派生视图

```
DB: port_allocations（权威，唯一写入口）
 ├─ id / fde_id / scope(project|run|fde)      ← 'fde' 由迁移 0018 放开（#240，§8.2）
 ├─ run_id（scope='fde' 时恒 NULL；project_id 已随 P5 退役，迁移 0008）
 ├─ port / role
 ├─ hostname / url            ← 与 Traefik 路由同源生成
 ├─ exposure(private|org-visible|public)
 └─ state(allocated|active|released) + released_at
        │ 同一 DB 事务另写 route outbox/revision（H-B 定稿，issue #5/#9；
        │ PG 事务无法含文件写入，故不再是「路由与 DB 同一事务」）
        ▼
reconciler 幂等发布 → Traefik file provider（每 allocation 一条 router+service，§6.4）
        │ portal 单向写出（直写宿主 bind mount，D-6/issue #7，无需容器网络可达；契约见 user-space.md）
        ▼
容器内 ~/.erix/ports.json（FDE 级单一文件，P5 去项目化，directory-as-project §3；agent 只读，永不写）
```

**为什么 DB 是真相**：URL 与 Traefik 路由必须同源（不一致 = 502 的来源）；主机/portal/Traefik 重启后由 reconciler 凭 DB 全量重建全部 JSON + 路由（自愈，topology.md §8）；并发申请靠唯一约束 + 事务；谁在用、何时回收、给谁看过只有 DB 装得下。

**为什么还要 JSON**：agent 读端口无需发 API（少一个失败点，可离线）；可 grep、可调试；符合「这台小电脑」的心智模型。

**同步规则**：平台 → 容器**单向**。#240 起**没有「申请新端口」这条路**：开户时已预建一整段（§8.2：全局号池里的一个对齐块），#246 起**哪几个号是运行时决定的** ⇒ 容器内一律从 `~/.erix/ports.json` 取（**它就是唯一真相**）、绝不自己挑、也不要凭记忆假定是某几个固定端口。#246 交付② 也**没有**打开 FDE 自服务写入口：改块仍是**管理员端点**（§8.2 表「管理员改块」行 / portal.md §4.7a），FDE 侧只能经 §4.7a 的列端点**读**。

**告知的两处落点（容器侧不做端口管控，只告知）**：① `~/.erix/ports.json`（本图的派生终点，一整段 allocation + 每条真实 `url`）；② `runner/worker.js` 的 `SYSTEM_PROMPT`（复述「端口段由平台分配 / **清单是唯一真相** / 必须从清单里选且绑 `0.0.0.0` / 不要自造域名或端口 / 不要要求平台再加」）。两处都由同一份 DB 事实派生。防漂移测试：`portal/test/materializer.test.js`、`runner/test/system-prompt.test.js`——#246 后这两处**都不允许出现端口数字**（旧写法「复述 4000–4009」本质是拄一份第二清单，换号池时必然漂）；需要时从 `portal/src/previewpool.js` 的常量推导，不在测试里重打一遍。

**第三处落点（#257 + #258，2026-10-12 定稿）**：③ `~/AGENTS.md` 是**应用侧要求链的单一真相**（预览访问要满足哪几条 + 每种错误形态是谁给的），② 对它只留「开工先读 `~/AGENTS.md`」的**强制指针**而不复述规则（抄进提示词就是第二份真相）——职责边界、红线与防漂移断言见 [`user-space.md`](user-space.md) §4.1.2。

### 8.2 分配策略（开户即发**全局号池里的一个对齐块**；issue #246 定稿，取代 #240 的「人人都是 4000–4009」）

> **裁决（决策者 2026-10-11，issue #246）**：全局**只有一个号池 `22000–29999`**（8000 个号 = **800 段**）。
> 开户默认发「**池内最小的未占用对齐块**」（第 1 个 FDE `22000–22009`，下一个 `22010–22019` …，块大小 10）；
> **管理员可覆盖**（指定块起点或单个端口）。**重叠 = 硬不变式**（决策者：「分配时候要检查重叠性」）：
> 活行内 `port` **全局唯一**，由迁移 **0019** 的部分唯一索引 `port_allocations_live_global_port_key
> UNIQUE (port) WHERE state <> 'released'` 在 **DB 层**保证；`released` 行不占位 ⇒ **号码可回收复用**。
>
> **历史（#240，已被本节取代）**：#240 把分配粒度定在 **FDE 级**、但端口写死 `4000–4009`（人人同一段），
> 而既有索引只按 FDE 判重 ⇒ 真机 `eric` 与 `tetris` 同时持有 4000–4009（**10 组重叠**）。
> 本单只换「挑哪些号」，**不改** #240 定的其它口径：粒度仍是 FDE 级；原「项目创建分配块首单端口 +
> 8 端口块（slot）+ 每用户总配额」的方案仍作废（项目注册制已随 P5 退役，`projects.slot` 不再参与端口分配，
> `port_allocations.project_id` 已被迁移 0008 DROP，run 级端口块仍是 P2）；**仍不存在「超限」，
> 错误码 `port_quota_exceeded` 仍是已删除状态**（portal.md §1.2 / §3.3；不新造替代错误码）。

| 项 | 取值 | 依据 |
|---|---|---|
| 粒度 | `scope='fde'`（迁移 **0018** 放开的第三个值；`run_id` 恒 NULL，与 `CHECK ((scope='run') = (run_id IS NOT NULL))` 自洽） | §7.2 第 3 步、迁移 0018 |
| 条数 | 默认**一个块 = 10 个**，开户一次写完；不做配额、不再追加；管理员可改块 | 决策者裁决（#246） |
| 号池 | 全局唯一池 **`22000–29999`**（800 段）；常量单一来源 `portal/src/previewpool.js`，与迁移 0019 同口径 | 决策者裁决（#246）、迁移 0019 |
| 端口选取 | **池内最小的未占用对齐块**（起点对齐 10 的倍数）；占用判据 = **全局活行**（`state <> 'released'`，不分 FDE/scope/role），**整块**判定（块内任一号被占就整块跳过） | `previewpool.js:firstFreePreviewBlockStart`、`portalloc.js:choosePreviewBlockStart` |
| 重叠不变式 | 活行内 `port` **全局唯一**，由 **DB** 保证；应层**不做**「先查后插」查重，只算候选块 + 把 `23505` 翻成 `preview_port_block_taken`（带重试提示）后由调用方重试 | 迁移 **0019** 的 `port_allocations_live_global_port_key` |
| `port` CHECK | **按状态分支**：活行必须 `BETWEEN 22000 AND 29999`；`state='released'` 行保留历史号码（`BETWEEN 4000 AND 29999`） | 迁移 **0019** |
| 角色 | `role='spare'`（复用既有枚举，不新造） | schema.sql §4 |
| 可见性 | `exposure='private'`（对外分享走 §2.8 预览 ticket） | §6.5 |
| 状态 | `state='allocated'`；首次 forward-auth 放行才幂等升 `active` | §8.6 |
| 管理员改块 | **= 搬迁**（#246 交付②）：`POST /api/admin/fdes/:fdeName/ports/block` 在**单个事务**里释放旧块 + 撤 grant + 插新块 + 入队两条派生链；**不是追加**（`ensureFdePreviewPorts` 是 insert-only，只复用它就会留 20 条活行）；目标块被外来活行占住 ⇒ `409 preview_port_block_taken`，**不偷偷换块** | `portalloc.js:moveFdePreviewBlock`、portal.md §4.7a |
| 列端口的读取面 | `GET /api/me/ports`（本人）与 `GET /api/admin/fdes/:fdeName/ports`（admin，**读他人必写审计**）；只列活行、`port ASC`、DTO 必含 `id`——否则签票端点 `POST /api/ports/:id/preview-ticket` 无法被人用 | portal.md §4.7a |
| 抢号重试 | 未显式指定块起点 ⇒ 遇 `preview_port_block_taken` 开**新事务重算**，**总尝试 3 次**（`PREVIEW_BLOCK_MAX_ATTEMPTS`）；显式指定 ⇒ 不重算。⚠ 重试**只覆盖端口分配这一小段**（开户里它在网络/容器之后、LLM 联动之前 ⇒ 已建网络/容器不回滚） | `portalloc.js:provisionFdePreviewPorts`、`provisioner.js` 开户步骤序列 |
| 容器固定角色 | `3001` **已取消**（code-server 清退，容器唯一交互入口为 FDE 对话界面，issue #71，决策者 2026-09-24；原 `3000` runner 内部 API 同样已取消：容器平台通道零监听、全出站，§10.3，issue #3 评论） | 原 §8.2 保留项 |

- **容器侧不做端口管控**（决策者裁决 2）：平台只保证**分给本 FDE 的那一段**预览域名**有路由**；FDE 容器实际
  监听什么端口平台**不检查、不限制、不 reconcile**。「严格管理容器内端口」的设想作废，改为
  **告知 + 尽力**（落点见 §8.1 末段）。
- **应用侧的要求链以 `~/AGENTS.md` 为准，本文不重抄**（#257 + #258 落点定稿，2026-10-12）：「在预览域名下跑通
  一个应用」还需要满足一组**与端口分配无关、全在应用侧**的条件（主机白名单 / 跳端口带凭据 / 后端 CORS /
  逐 host 各放行一次 / 应用自己的登录态不要用 Cookie（#262：边缘全方法剥 `Cookie` 头）等）；它们的**单一真相**
  是 materializer 下发的 `~/AGENTS.md` 里那一节（口径见 [`user-space.md`](user-space.md) §4.1.2），
  `runner/worker.js` 的 `SYSTEM_PROMPT` 只放「先读它」的强制指针。本节与 §8.4 只登记**口径来源**，
  不重抄规则（重抄就是第二份会过期的真相源）。
- **派生必须自动**（决策者裁决 4）：写库与 route outbox / materialize revision 入队**同一事务**，
  禁止依赖人工 `enqueueFullRebuild` / `runMaterializerOnce`。
- **幂等与存量补齐**（决策者裁决 7）：`ensureFdePreviewPorts` 的幂等判据仍是**部分唯一索引 +
  `ON CONFLICT (fde_id, port) WHERE state <> 'released' DO NOTHING`**（不是「先查后插」，没有 TOCTOU）
  ⇒ 二次调用零插入、零入队；缺几条补几条，且**块起点从本 FDE 已有活行反推**（重跑不会又开新段）；
  老 FDE 重跑 `node portal/src/cli.js provision-fde --fde-name <name>` 即补齐整段（输出行带 `block=<起>-<止>`）。
- **跳 FDE 侵吞的块不硬补**：如果本 FDE 已有的块里存在**外来**活行（历史手工插行 / 管理员改块都可能造成），
  就整段换下一个空闲块，而不是在残缺段里插到一半被全局索引拒（`portal/test/portalloc.test.js` 钉住）。
- **存量已由迁移 0019 一次性重排**（取代 #240 的「遗留行不迁移」）：活行按 `fde_name` 定序重排进号池，
  `hostname`/`url` 同事务重写（base 域从旧 hostname 反推，不硬编码伞域）；装不进一个块的溢出活行（真机只有
  `tetris` 的 **4100**）置 `released`；`released` 历史行（真机 `portsprobe` 的 4000–4009）**保留旧号码不重写**。
  已接受的代价：eric / tetris 现有预览 URL 全部改写，**容器内应用要改监听端口**，旧链接失效。
- **管理员改块是搬迁事务，不是再发一块**（#246 交付②，本节最容易做错的一句）：`ensureFdePreviewPorts`
  全文件零 `UPDATE port_allocations`（**insert-only**），所以「改块」若直接复用它补一段，旧 10 条行仍活、
  继续占号、旧域名仍可访问（真机就会是 20 条活行）。因此 `moveFdePreviewBlock` 在**同一事务**里先按
  offboarding 的先例释放旧行（`state='released'` + `released_at=COALESCE(…, now())`）并撤销其
  `preview_grants`（`state='revoked'` + `revoked_at=COALESCE(…, now())`，**只动 `state='active'`**：
  `used` 是历史事实、保留原状，把它塞进 `revoked` 会撞 baseline 的双向 CHECK `(state='used') = (used_at IS NOT NULL)`
  即 #252 那个真机 500；撤权**无条件发**，撤 0 行也算成功。口径全文见 portal.md §2.8「撤 grant 的口径」），再插新块；
  固定顺序与“任一步失败 ⇒ 整笔回滚零残留”由 `portal/test/preview-ports.test.js` 逐序钉住（契约见 portal.md §4.7a）。
  `released` 行不占位 ⇒ **号码可回收**（搬出去再搬回同一块必须能成功）。
- **抢号重算不等于整笔开户回滚**（#246 交付② 补交付① 的边界）：重试只覆盖「端口分配」这一小段——开户顺序是
  「网络与容器已落地之后、LLM 联动之前」调端口分配（`provisioner.js` 已核实）⇒ 冲突时**已建的网络/容器不回滚**，
  LLM binding 尚未执行。`withFdeLock` 的锁键是 `fde:${fdeName}`，**串行化不了不同 FDE 抢同一个空闲块**，
  所以「索引 + 新事务重算」才是正解（别指望加锁）；重算上限 3 次，用尽后把兑底动作指给管理员改块端点。
- 定期 reaper 回收 `released_at` 过期项；Traefik 配置由 reconciler 按 route outbox 幂等发布（§8.1，H-B）

### 8.3 `ports.json` 结构

> **canonical schema 以 [`user-space.md`](user-space.md) §4.3.1 为准**（含 `schema`/`generation` 包裹与 `state` 字段）；下方仅为字段语义示意。字段名用 snake_case，`run_id` 恒为 run UUID（P5 后 hostname/url 不再含项目名段/run-tok，统一 `<fde>-p-<portLabel>`，§8.5）。

```json
{
  "schema": 1,
  "generation": 42,
  "project": "proj1",
  "fde": "alice",
  "allocations": [
    { "scope": "project", "port": 4000, "role": "frontend", "run_id": null, "state": "allocated",
      "url": "https://alice-p-4000.fde.erix.vip", "exposure": "private" },
    { "scope": "run", "port": 4001, "role": "backend", "run_id": "6f1c2a34-9b8e-4f2d-a1c5-7d8e0f1a2b3c", "state": "allocated",
      "url": "https://alice-p-4001.fde.erix.vip", "exposure": "private" }
  ]
}
```

### 8.4 容器内两条硬约定

1. 端口一律从 `~/.erix/ports.json` 取，**不要自己挑**（#240 预建、#246 改为号池块：平台从全局号池 22000–29999 里发**属于本工位的一整段**（默认 10 个），且**没有**「申请新端口」这条路，§8.2。端口的**唯一真相就是这份清单**——不要凭记忆假定是某几个固定号）
2. dev server 必须绑 **`0.0.0.0`**（容器内）——与常规安全建议相反，因为容器网络私有且只有 ingress 能进；绑 `127.0.0.1` 会导致 ingress 够不着

### 8.5 hostname grammar（写死；P5 去项目化后无项目名段；#57 阶段2 伞域修订）

> **`BASE_DOMAIN` 语义 = 伞域（#57 定稿）**：`BASE_DOMAIN` 不再是「可注册域」，而是**伞域** `fde.<可注册域>`（现取 `fde.erix.vip`）。
> 派生结果：portal = `station.<BASE_DOMAIN>` = `station.fde.erix.vip`、LLM = `llm.<BASE_DOMAIN>` = `llm.fde.erix.vip`（两条生成式在 `config.js`，不动）；
> 预览域 = `<fde>-p-<portLabel>.<BASE_DOMAIN>` = `eric-p-8001.fde.erix.vip`（#246 后端口段来自号池 ⇒ 实际形态 `eric-p-22000.fde.erix.vip`）——**语法里写死的 `.fde.` 段已删除**（伞域本身已含 `fde.`，否则叠加成 `.fde.fde.erix.vip`）。
> 代码默认兜底 = `BASE_DOMAIN=localhost`（`config.js`，本地起服不改环境变量的形态；要给本地也套伞域则显式配 `BASE_DOMAIN=fde.localhost`）；dev 走 `http://…:8090`、生产走 `https/443`，**同一代码路径**（URL 的 scheme/端口从公开入口 `config.portalPublicBaseUrl` 派生，见 `projects.previewUrl`）。

> **唯一入口**：`hostname` / `url` 由 **portal 生成**（§8.1「DB 是真相」；实现唯一入口 `portal/src/projects.js` `buildHostname`，URL 另见同模块 `previewUrl`），前端只展示/跳转、agent 只读——**任何其它方不得拼接/改写**（portal.md §8-4 / 本节 §8.4）。
> **长度约束（DNS 标签安全的前提，#202 如实写；预算宽度随 #246 号池变宽）**：单标签上限 **63** 字符、整域名 ≤ **253**（RFC 1035）。首标签 `<fde>-p-<portLabel>` 的固定段 = `-p-`（3）+ 端口段宽度（**取池内最大端口的位数**：#240 时代恒 4 位 ⇒ 7；#246 号池是 5 位 ⇒ **8**）⇒ **FDE 名参与预览域名的预算 = 63 − 8 = 55**（旧口径是 56 ⇒ **56 字符的名字现在开户即 400**）。两个数都从 `portal/src/previewpool.js` 的池边界**推导**（`MAX_FDE_NAME_LEN_FOR_HOSTNAME`），不写死端口也不写死预算：写死 `4000` 就会让 56 字符的名字过应用校验、再到 INSERT 被 0017 的 CHECK 以 23514 炸掉（旧实现的真实翻车路径）。`buildHostname` 的 `padStart(4,'0')` **不截断**，5 位端口原样入域名（旧文档的「项目名段 / 最长 134」形态已随 P5 去项目化作废，存量 hostname 由迁移 0008 重写；#246 重排存量时由迁移 0019 重写首标签端口段）。
> **强制点（四层，同一口径逐标签 ≤63 + 总长 ≤253）**：① 开户即 400（`admin.js createUser` → `projects.validateFdeNameForHostname`，对**最终 hostname** 整体校验，探测端口取**池内最宽**的号 ⇒ 探到最坏情况；错误文案含实际长度与「缩短到 55 以内」）；② **预分配前**（#240：`portalloc.js ensureFdePreviewPorts` 写 hostname 之前按同一函数复检，`code='preview_hostname_invalid'`——否则一段里有 1 条拼错就会让 0017 的 DB CHECK 在开户事务中途炸成裸 23514）；③ 路由生成 fail-closed（`routes.js isValidHostname`）；④ DB 兜底 CHECK（迁移 **0017**，整域名正则，NOT VALID）。FDE_NAME_RE（≤63）本身不改：目录名/容器名/git-credential 路径不受 DNS 标签约束，56..63 字符在那些路径仍合法。

**grammar**（小写、DNS 标签安全）：

```
hostname := <fde> "-p-" <portLabel> "." <BASE_DOMAIN>   -- #57：<BASE_DOMAIN> 即伞域 fde.<可注册域>，语法不再插 .fde. 段
<fde>       := [a-z0-9]([a-z0-9-]{0,53}[a-z0-9])?   -- users.fde_name；字符集同 schema.sql CHECK，预览域名长度预算 ≤55（#246，见上）
<portLabel> := [0-9]{4,}                        -- 十进制；不足 4 位零填充，**超过 4 位不截断**（号池端口是 5 位）

-- 完整域示例：eric-p-22000.fde.erix.vip（= <fde>-p-<portLabel> + 伞域 fde.erix.vip）
```

| 段 | 字符集 | 长度 | 生成规则 |
|---|---|---|---|
| `<fde>` | `[a-z0-9-]`，小写，不以 `-` 开头/结尾 | 1..55（预览域名预算；字符集本身允许到 63，仅开户的域名口径收紧） | `users.fde_name`（= 容器名 `fde-<name>` 的 `<name>`、预览域名首段） |
| `-p-` | 字面量 | 3 | 固定标记（P5 去项目化：原 `p-<project-name>` 的项目名段已删除） |
| `<portLabel>` | `[0-9]` | ≥4 | 端口十进制：**不足 4 位零填充、超过 4 位不截断**（#246 号池端口是 5 位，如 `22000`；旧口径「恒 4 位、4000..4999」已作废） |

- **不可变性（写死）**：`hostname` / `url` 是 allocation 的**一次性分配标识，运行期永不改写**。保证书签/分享链接/iframe/预览卡片不漂移（原理三「URL 稳定」，§8.2 项目级固定端口用途）。**唯一例外**：迁移 **0019** 把存量活行一次性重排进号池时同事务重写首标签端口段（决策者已接受「存量预览 URL 全部改写、旧链接失效」这个代价，§8.2）；除此之外只有 `released` 会让一个 host 退役。
- **碰撞处理**：`fde_name` 全局唯一 + **端口在活行内全局唯一**（#246 起不再只是「同 FDE 内唯一」）⇒ hostname 天然无碰撞；兜底是两条唯一索引：`port_allocations_live_hostname_key`（schema.sql 既有）+ **`port_allocations_live_global_port_key`（迁移 0019）**。
- **段长组合不在 schema 层**：schema.sql `users.fde_name` CHECK 只管字符集/单段 ≤63，不管「63 − 7」这类组合预算——组合口径由上述三层应用/DB 强制点执行（#202）。

### 8.6 `allocated → active` 的触发条件与幂等更新（写死）

> **裁决**：`allocated → active` 由 **首次 forward-auth 放行** 触发（预览链路首次成功授权）。选它而非「runner 上报监听」的理由：forward-auth 放行是「端口已经过边缘授权并实际被访问过」的确定信号，且**不需要新增任何 internal 端点**；「runner 上报监听」要求 agentd 可靠探测 detached dev server 的监听状态（额外探测机制 + 新端点）。model.md §2.2 已同步定稿。

- **判定**：Traefik 回调 `/api/forward-auth`（portal.md §2.7）返回 `200 + X-Auth-User`（放行）即触发。
- **写库时机**：portal 在**同一次 forward-auth 处理内**，放行判定通过后执行幂等升级：
  ```sql
  UPDATE port_allocations
  SET state = 'active'
  WHERE id = $1 AND state = 'allocated';
  ```
  `WHERE state='allocated'` 保证**幂等**：首次放行才升级，后续放行影响 0 行、不重复写；已 `released` 不会误升级。
- **不触发路由重发布**：`allocated` 与 `active` 的转发语义一致（forward-auth 第 2 步两者都放行，portal.md §2.7），故升级**不写 route outbox、不重发 Traefik 路由**——`active` 只是 UI「在线」展示态 + 报表口径。
- **重建恢复**：`active` 状态在 DB（原理三），FDE 容器 / Traefik 路由 / `ports.json` 重建后 **DB 里的 `state='active'` 不回落**（DB 是真相，重建只是重新物化派生视图）；reconciler 凭 DB 全量重建路由时按当前 `state` 生成，不依赖「是否曾放行」的历史事件。唯一回退路径是 `released`（项目删除 / run 结束 / reaper），无 `active → allocated` 逆转换。
- **语义边界（尽力而为，不是强在线探针）**：forward-auth 放行只证明「授权通过且请求到达边缘」，**不**证明上游 dev server 返回 200（授权与上游健康是两件事）。因此 `active` 的语义 =「已获准访问过」，UI「在线」应按此口径；dev server 强在线探针（reconciler 定期对上游 200 探测）留作 P2 预览卡片可选增强，P1 不做。
- **P1 影响**：P1 无预览路由（deploy-contract.md §7 P1 范围），故 P1 期间 allocation 恒为 `allocated`，`active` 只在 P2 预览启用后出现；不影响 P1 端口分配/物化/回收。

---

## 9. 数据模型

### 9.1 表清单（草案）

> **表结构以 [`schema.sql`](../data/schema.sql) + [`model.md`](../data/model.md) 为唯一事实来源**（可执行 DDL，`psql -f` 空库可实测）。本节不再维护内联草图表清单——历史草案遗漏了新表与 `client_event_id`、且 checkpoint 的 `seq` 口径过时，直接引用以消歧。
>
> 表分组一览（写入方 / 状态机 / 三份数据边界见 model.md §0/§2/§3）：
> - 账号与认证：`users` / `login_sessions` / `api_tokens`
> - 容器与项目：`containers` / `projects`
> - 会话与对话：`chat_sessions` / `runs` / `messages`
> - 端口分配与路由：`port_allocations` / `route_outbox` / `route_revisions`
> - 引擎持久化：`transcript_rounds` / `run_checkpoints`（每 run 单行）/ `run_events`（含 `client_event_id`）
> - 工具与审批：`tool_calls` / `tool_outputs` / `judge_decisions` / `approvals` / `artifacts`
> - 用量与审计：`usage_ledger` / `audit_log`
> - 任务队列：`run_queue`（含租约字段）
> - 网络与 IPAM：`fde_networks`
> - LLM 网关绑定：`fde_llm_bindings`

### 9.2 三份数据不可混（重要）

| 层 | 内容 | 谁看 | 可折叠 |
|---|---|---|---|
| ① `messages` | 人看的对话（含 `synthetic` 标记） | UI / 人类 | 否 |
| ② `transcript_rounds` | canonical 消息（模型上下文 + resume 源） | `runToolLoop` | 是（fold 只影响视图，档案完整） |
| ③ `run_events` | 流式事件日志（带 seq） | 前端 / 重放 | 否 |

> **①≠②**。judge 会在 transcript 里注入 **user role 的合成消息**（如「【审计拦截】方向可能偏…」），wrapup 协议、方向提示、nudge 也都会进去。直接渲染 = 用户以为这话是自己说的。→ `messages.synthetic` 必须过滤/标记。

### 9.3 store 适配器（接 erix-agent）

实现 erix-agent 0.14.0 的 `TranscriptStore`：必需 `appendRound / load`；配对的 `saveRunSnapshot / loadLatestRunSnapshot`、`saveRunState / loadRunState`、`markRunState` 是可选能力。Station adapter 通过 `erix-agent/contract-tests` 校验；详见 runner-integration §9。

四条注意：

1. **run snapshot 能力须成对**（`saveRunSnapshot` + `loadLatestRunSnapshot`）。adapter 成对暴露时引擎启用 crash-resume 持久化；写入失败经 adapter retry 后仍抛 `checkpoint_failed`，不会静默降级。
2. **store adapter 必须包 retry**，并把 `checkpoint_failed` 识别为**可重试**。adapter = 调 portal internal 端点的 HTTP adapter（不直连 DB，D1'/D2'），重试参数见 [runner-integration.md](runner-integration.md) §9.2。
3. **runId 用 UUID**，不要用 cwd 派生（多用户下会撞）。
4. `run_events` / 用量 / session 状态**不属于** `TranscriptStore` 契约 → 由 portal 在 internal 端点侧补齐（事件落库与 seq 分配、`last_seq` 推进、`usage_ledger` 记账；agentd 只负责上报，runner-integration §4.2/§7）。

> **原「⚠️ 强烈建议：本地 file 优先 + DB 异步复制」已按决策者裁定作废（2026-09，issue #3 评论，D2'）**：存储为**纯 DB（Postgres），不做 file 副本**；runner 的 TranscriptStore 实现 = 调 portal internal 端点的 HTTP adapter。中心 DB 抖动风险改由 adapter 重试包装补偿（runner-integration §9.2），代价（抖动超过重试窗口会使在跑任务 `checkpoint_failed` 失败）记录在 runner-integration §9.4。

---

## 10. 事件流与实时层

### 10.1 事件信封

| erix 回调 | 信封 |
|---|---|
| `onEvent`（`round_start`/`attempt`/`tool_use`/`tool_result`/`usage`/`round_end`/…） | `{seq, ts, session_id, run_id, type: 同 LoopEvent}`（其中 `usage` 类事件**仅实时展示**，不参与记账，见下） |
| `onDelta` / `onReasoningDelta` | `{type:"assistant_delta"｜"reasoning_delta", text}` |
| `onToolCall`（参数增量） | `{type:"tool_call_delta", ...}` |
| `onJudge` | `{type:"judge", kind, action, decision}` |
| `runToolLoop` 返回值 | 喂 U2 终态载荷（`termination`/`usage`/`rounds`/`final_text`），**不直接产事件**——`run_end` 事件由 portal 在 U2 终态事务合成（runner §7.6） |

`seq`（erix 不提供）由宿主在落库时分配。

> **usage 唯一权威来源**：记账以 `onUsage`（随 U2 终态载荷 `usage` 上报 → `runs.usage` + `usage_ledger`，`source='erix'`，一 run 一条）为准；`onEvent` 中出现的 `usage` 类事件**只作实时展示、不产生第二条记账**（runner-integration §4.2/§6.3）。
> **`run_end` 唯一产生方**：portal 由 U2 终态合成（worker 不再经 U3 发 `run_end`，runner §7.6）——上表「runToolLoop 返回值」一行只说明数据来源，不表示 worker 直接发事件。

### 10.2 传输

- **SSE 而非 WebSocket**：事件单向（输入走 POST），SSE 自带断线重连 + `Last-Event-ID`
- **事件先落 DB，portal 从 DB 读并推流**——不直接透传容器的流。好处：**portal 重启不杀正在跑的任务**（run loop 在容器、状态在 DB）；多端同步；断线按 seq 补发
- 单节点用进程内 EventEmitter 即可；多节点再上 DB LISTEN/NOTIFY 或 pub/sub

### 10.3 portal ↔ 容器（全出站，B 方案；决策者 2026-09，issue #3 评论）

> 本节按决策者裁定重写（D1'/D2'，覆盖原「portal → 容器 push + 容器写 DB」描述）。完整协议（端点、租约、事件批量、审批中转）见 [runner-integration.md](runner-integration.md) §4；internal 端点契约见 [../api/portal.md](../api/portal.md) §9。

- **容器 → portal**：唯一通道 = portal 的 **internal HTTP API**（`/api/internal/*`，H-B 定稿 D-5（issue #5）：**经 Traefik**——`Host(station.<base>) && PathPrefix(/api/internal)` + `ipAllowList`（由 `fde_networks` 精确派生，每 `subnet` 一条，topology.md §5.1）限源后回环到 portal `127.0.0.1:8080`；容器侧经 `--add-host station.<base>:<网关IP>` 访问，见 topology.md §4-L3。原「仅 `control` 网络可达、不经 Traefik」随 `control` 取消一并作废）。所有平台状态写入（事件 / transcript / checkpoint / 用量 / 审批 / 状态收敛）都经该 API 由 **portal 落库**——**容器不直连 DB，Postgres 的业务写方只有 portal**。容器唯一的平台凭据是 **per-container token**（建容器时生成、存 DB、注入容器 env），每个请求以 `Authorization: Bearer` 出示，且只能操作本 FDE 的资源。
- **portal → 容器**：**不主动推、不要求容器监听端口**。改为 agentd 出站维持 **SSE 长连接（下行）**：派单唤醒 hint / 审批决定 / 停止指令 / 吊销；派单本身为**拉取**（claim 长轮询 hold + portal 侧 NOTIFY/事件唤醒；push 作为 P2 优化后置 ⚠️ 待决策者确认）。
- **租约与心跳**（参数 ⚠️ 待决策者确认）：claim 发租约（lease 90s），心跳 15s 续期并兼作停止指令的兜底轮询；连续 3 次心跳丢失（45s）判容器死，租约到期允许 re-claim。
- **取消**：`AbortController` 跨不了进程 → portal 写 DB `cancel_requested_at` 标记，经 SSE `stop_request` 下发 + 心跳响应兜底，agentd abort 对应 worker；终态收敛仍由 runner 侧上报、portal 落库。
- **为什么这样做**：容器是信任边界（原理一）——DB 凭据不进容器（泄漏面最小化，offboarding 吊销 token 即断）；容器零监听零入站（攻击面最小化，容器侧无需鉴权实现）；portal 无需感知容器在线（心跳即在线证明）。

---

## 11. LLM 接入与出口管控

> **方向与实施更新（issue #117，2026-10-03）**：已恢复 LiteLLM per-FDE virtual key 方案并完成 phase 2：LiteLLM 是 credential 与模型目录真相源；portal admin API 代理 credentials/models，Station binding 存 LiteLLM `model_info.id`、数据面 `model_name` 与 virtual key；Traefik 每 FDE 按来源子网注入 key，所有 router 共用 `llm-gateway` data-plane service。`model_info.id` 与请求体中的 `model_name` 是不同值，不能互换。实现细节见 [`../data/model.md`](../data/model.md) §1.20；本节中注明 2026-09-20 的直连上游描述均为历史方案。

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

> **职责边界（决策者 2026-09，issue #3）**：「网络到不了」由**网络层出口策略**实现，属**安全团队职责**，平台不负实施责任。技术事实：Docker 容器默认经宿主机 NAT 出网且无任何限制；出口策略只能在网络层实施（宿主机 iptables/nftables 按 docker 网络/容器 IP/veth 接口、或强制 egress 代理按域名白名单、或网络设备对容器所在网段做策略），平台业务代码实现不了。平台侧不可推卸的部分是**凭据红线**：容器内**零 LLM 凭据**（H-B 后连虚拟 key 也不放——仅占位 key + endpoint，真实虚拟 key 由 Traefik 按来源子网注入，§11.3），永不下放下游真实 key。

### 11.3 模式对比

| 模式 | 形态 | key 进容器 | 能改 endpoint 绕过 | 需自写代理 |
|---|---|---|---|---|
| A 直连 | 容器 → 网关（per-FDE 虚拟 key） | 是 | **能**（除非做出口管控） | 否 |
| B 经 portal | 容器 → portal → 上游 | 否 | 不能 | **是**（SSE 透传） |
| **C 网络强制（选定）** | 容器 → Traefik（按来源子网注入凭据）→ 网关，**且网关是唯一可达的 LLM 出口**（前提：安全团队网络层出口策略已实施，issue #3） | **否**（H-B 定稿 D-4，issue #5：容器零 LLM 凭据，Traefik 按 `ClientIP` 注入） | **不能** | 否 |

**选 C**：用现成网关做（不自己写流式代理），当前采用 LiteLLM；2026-09-20「上游直发 per-FDE key」是已被 issue #117 取代的历史方案。portal 只做：

1. 开通账号时调网关 admin API **建虚拟 key**（额度、模型白名单、别名 `alice@client-x`）——key 随后由 portal（经 reconciler）写入**宿主 Traefik 动态配置**（文件权限 600，仅 portal 可写、Traefik 只读），**不下发容器**
2. 禁用账号时**吊销**（删 key + 删对应 LLM 注入路由）
3. 定期拉用量 → 落 `usage_ledger`，做**业务口径**（按 FDE / 按客户项目，网关不知道这层映射）

→ 待 Q1 确认公司是否已有网关；没有则先起一个网关容器（候选分析见 [`llm-gateway/llm-gateway-selection.md`](llm-gateway/llm-gateway-selection.md)：默认且唯一推荐 LiteLLM；one-api / one-hub 因停更淘汰，new-api 因源码级验证不达标出局——429 语义缺失、鉴权契约 rc 期间重写、凭据通道不可收紧，详见 [`llm-gateway/new-api-api-analysis.md`](llm-gateway/new-api-api-analysis.md)），仍走 C。

> **H-B 链路（决策者 2026-09 定稿，issue #5 D-4；实测见 topology.md §10 证据 8）**：agent/worker 只认 `llm.<base>`——容器内**零 LLM 凭据**，仅占位 key + `endpoint=https://llm.<base>/v1`；请求经 Traefik（host:443），router `Host(llm.<base>) && ClientIP(<该 FDE 精确 subnet>，默认 `10.200.<n>.0/29`、大 FDE `10.201.<n>.0/28`)` 按**网络来源**判定身份，headers middleware **覆盖** `Authorization: Bearer <该 FDE binding 的真实上游 api_key>`（容器自带的任何 `Authorization` 均被覆盖；**2026-09-20 修订，issue #38**：不再注入 `X-FDE-Identity`、不再有平台虚拟 key——路由按 `fde_llm_bindings`（必须含 api_key）生成，无 binding 无路由，LLM 段独立文件 `llm-routes.yml` mode 600）；service = per-provider `llm-provider-<id>` → `llm_providers.base_url`（如 mock 数据面回环 `127.0.0.1:4000`，**上游直发**）；provider admin 配置面走 portal admin API。**禁止无 ClientIP 条件的兜底路由**（无匹配来源 404 = 默认拒绝）。配套：`aliasHeadersStrategy: delete`、provider service `flushInterval` 调小、LLM 路由配置 600（§6.4，topology.md §6）。（原「网关 admin 面不发布、只在 backend 网络」随 LiteLLM hub 取消而移除——issue #38，2026-09-20。）

> **澄清（归属归位）**：LLM 网关是**独立组件**——公司已有网关，或平台另起的网关容器（如 LiteLLM），**不是 portal 内部的实现模块**；portal 侧只有「租户绑定」逻辑（上面的 1/2/3）。Q1（公司是否已有网关）保持未决，本文不替选型拍板。

> 模式 C 的「唯一可达」是**依赖外部网络策略实现的前提**（安全团队职责，issue #3），不是平台自身交付物；该前提未成立时，模式 C 退化为「模式 A + 审计告警」（见 §11.4 降级路径）。

### 11.4 配套细节

- **容器内零 LLM 凭据**（H-B 定稿 D-4，issue #5）：容器 config 里只有占位 key + `endpoint=https://llm.<base>/v1`（`llm.<base>` 经 §5.3 hosts 注入解析到本 FDE 网关 IP）；Station DB 只存 LiteLLM virtual key（`fde_llm_bindings.api_key`），不存上游 `api_key`；virtual key 由 portal 注入宿主 Traefik 动态配置 `llm-routes.yml`（**600**，portal 可写、Traefik 只读；存储纪律见 [`../data/model.md`](../data/model.md) §1.20）。
- **judge / fold 用便宜模型**：`ModelConfigProvider.resolve(slot)` 支持 `default` / `audit` / `fold`；长任务 judge 会 +10~30% 调用量
- **额度用尽**：网关 429 → erix 分类 `KitError(rate_limited, retryable)` → 宿主需友好提示，且避免重试继续烧配额
- **对账**：网关 usage 与 erix `onUsage` 两套数都要记（差异来自 judge/fold 的额外调用）
- **出口 allowlist 移交给安全团队的网络层策略**（白名单内容由安全团队维护）：npm registry、pypi、GitHub/内部 git、镜像仓库；**LLM 域名不在白名单**——这是「唯一出口」的实现方式（决策者 2026-09，issue #3）。平台对安全团队的接口：容器网络名/命名规范（`fde-<name>`）+ 子网段 `10.200.0.0/16` 与 `10.201.0.0/16`（默认池 `/29` 与大 FDE `/28` 池；均保留给 FDE 网络专用，`control` 已取消，H-B 定稿 issue #5）、审计事件、以及「上游 LLM 只经网关」的架构事实
- 若安全团队的出口策略未实施 → 「防用外部 key」降级为**审计 + 告警**，须管理层**书面知情**（性质不同）

### 11.5 用量与计费（定价、未知定价、spend 与 429）（issue #164）

> 背景：管理台铸出的 per-FDE 虚拟 key `spend` 曾恒为 `0.0`——LiteLLM 成本表**按模型名匹配**，而我们的模型目录是自定义名（`deepseek-v4-pro`、`glm-5.3-flash-awq` 等），内置价目表里没有这些名字 → 金额算不出来。

**定价从哪来（LiteLLM v1.103.2 口径，已实测）**

- 单价单位是 **USD / token**（不是每 1M）。管理台 UI 以「USD / 1M tokens」呈现，提交前换算为每 token（÷1e6）。
- 自定义模型必须**显式**声明单价，写在 **`litellm_params.input_cost_per_token` / `litellm_params.output_cost_per_token`**。
- ⚠️ **不要写在 `model_info`**：v1.103.2 在 `/model/new` 与 `/model/{id}/update` 上用 `without_server_derived_pricing()` 剥离 `model_info` 里的定价字段（`model_info` 是服务端派生/展示数据）；真正生效的是 `litellm_params`，`Deployment.__init__` 再把它镜像进 `model_info`。`GET /model/info` 的 `model_info.pricing_overrides` 列出该 deployment 显式覆盖的定价字段，可用来区分「显式定价」与「价目表自动命中」。
- 清空定价：`PATCH /model/{id}/update` 的 `litellm_params` 带显式 `null`（`NULL_CLEARABLE_LITELLM_PARAMS` 会把该字段从 `litellm_params` 与 `model_info` 两处移除）；字段缺省则保持原值。
- **`max_output_tokens` 与 `litellm_params.max_tokens` 绑死同值（#309 切片 1）**：门户把「单次响应输出预算上限」写在 `model_info.max_output_tokens`（`model_info` 自带的真字段），并同值写 `litellm_params.max_tokens`（真正生效的那一侧）；清空走同一对（`model_info` 显式 `null` + `litellm_params` 不带键）。写之前必过 **`≤ floor(context_window / 4)`** 硬上限（引擎侧把 `max_tokens` 当预算用，越界的值会让每个 run 启动即死；契约与理由见 [`../api/portal.md`](../api/portal.md) §4.9）。
  - **读侧是生效值的四级回退（#309 切片 1.5）**：`model_info.max_output_tokens ?? litellm_params.max_tokens ?? floor(正数 context_window / 4) ?? null` —— 都没配就按窗口的 1/4 假定（窗口不可得才算不出），于是**缺元数据不再等于关压缩**：门户总会算出一个生效值并随心跳下行，引擎的压缩开关默认是开的。而这个回退值**恰好等于手填上限**（同为 `floor(ctx/4)`）⇒ 平台自己造不出被自己校验拒的值。不区分「配置值 vs 假定值」（决策者定稿），门户 DTO / 表单 / 心跳下行就一列 `max_output_tokens`；各层名字对照见 portal.md §4.9。本切片只改门户写/读/心跳下行，**不动 runner**。

**未知定价必须显式（不静默为 0）**

- 管理台 `GET /api/admin/llm/models`（及 providers 内嵌的 models）为每个模型带：
  - `pricing_configured: boolean` —— **input/output 两项都有**才为 `true`（LiteLLM 需要两项才能完整计价；只填一半仍视为未配置）。
  - `pricing_source: 'override' | 'cost_map' | 'none'` —— 显式定价 / 命中 LiteLLM 内置价目表 / 无。
  - `input_cost_per_token`、`output_cost_per_token` —— 生效值（每 token）。
- 前端 LLM tab 对 `pricing_configured=false` 的模型显式展示「未设定价」徽标（不静默展示 0），新增/编辑表单也给出「留空 → 该模型用量金额将记 0」的提示。编辑表单只回填**显式**定价，不回填价目表自动命中的值（避免把当日价目表冻结成覆盖值）。
- 网关侧：未定价模型 `spend` 记 `0`（LiteLLM 会 WARNING 提示缺 `input_cost_per_token/output_cost_per_token`）；若开启 `block_requests_for_models_without_pricing`，未定价模型的请求会被**直接拒绝**而非记 0。

**spend 与 `max_budget` / 429**

- `spend` 由 LiteLLM 按「token 数 × 该模型单价」累计到虚拟 key / user；定价配好后管理台铸出的 key `spend` 才会增长。
- `max_budget` 超限 → LiteLLM 对数据面请求返回 **429**；erix-agent `classifyHttpError`（`src/providers/errors.js`）把 429 归类为 `code='rate_limited'`、`retryable=true`（`RETRYABLE_CODES` 含 `rate_limited`）→ 宿主需友好提示且避免继续重试烧配额（与 §11.4「额度用尽」一致）。
- **现状**：portal 铸 key（`generateKey`）**暂未下发 `max_budget`**；LiteLLM 客户端是透传 body，需要时可加。因此当前无法仅靠管理台触发「budget 超限 429」，真机验收需直接在 LiteLLM 侧给 key 设 `max_budget`（见 issue #164 报告）。

---

## 12. 容器模板与工作区约定

### 12.1 目录布局与路径映射

宿主 `/srv/erix/users/<fde>/`，FDE 容器内映射为 `/home/<user>/`（HOME）。**路径映射表、文件清单、原子写、UID/权限、失败重试、重建幂等、项目目录归属的完整契约见 [`user-space.md`](user-space.md)**——本节只保留规格层面的骨架，细节以该契约为准（原「bind mount 到容器内同路径（路径一致性约定）」的临时表述已按 issue #7 修正为「宿主路径 ↔ `/home/<user>` 显式映射」）。

```
/srv/erix/users/<fde>/            # 宿主机（user-space.md §2）
├── home/                          # 挂到容器 /home/<user>（HOME：.git-credentials + .erix/{config.json,mcp.json,skills,todos} + .cache/station/spool）
├── projects/<project>/            # 仓库；含 .erix/{ports.json,AGENTS.md} + .gitignore
├── worktrees/<project>-<runId>/   # 每个 run 独占的 git worktree（agentd 创建）
└── cache/                         # 依赖缓存（npm/pnpm/pip）
```

> **容器网络（H-B 定稿，issue #5）**：FDE 容器**只接自己的 `/29`**（不接 `backend`、无 `control`）；Traefik 不在容器内（host 网络）；容器内**零 LLM 凭据**（§11）。文件投递（模板/AGENTS.md/ports.json）由 portal 直写上述宿主 bind mount（D-6），不需任何入站网络；属主/权限/原子写见 [`user-space.md`](user-space.md) §5/§6。

### 12.2 容器内约定（写进 FDE 容器的 AGENTS.md）

- 一个项目 = `~/projects/<project>`；一个 run = `~/worktrees/<project>-<runId>` + 分支 `agent/<runId>`
- 端口从 `~/projects/<project>/.erix/ports.json` 取，不自己挑；dev server 绑 `0.0.0.0`
- 回流走 fork/PR，不直接在主干改
- `git worktree` 的**创建与清理（`worktree remove` / `worktree prune`）归 agentd**（run 启动前必须存在、结束后由 agentd 回收，见 runner-integration §6.2）；worktree 内的**内容由 agent（FDE）在容器内自行管理**（改代码、commit、分支），平台不代管内容（决策者 2026-09，issue #3 评论）；`.git` 是共享的，清理时别误删其他 run 的 worktree
- `node_modules` 每个 worktree 一份 → 用 pnpm store / npm cache 共享
- agent 代劳执行 clone；Git 凭据由 FDE 经 portal 投放到 `~/.git-credentials`（#110，`0640`、FDE 属主、不进 DB/环境变量；见 [`user-space.md`](user-space.md) §4.1.1）。平台不下发 SSH key（SSH 强制私钥 `0600` 与组可读 `0640` 冲突）。

> **平台文件读取纪律**：`ports.json` / `config.json` 一律经 `manifest.json` 校验后再读（防跨文件混合版本），见 [`user-space.md`](user-space.md) §3/§5.4。

### 12.3 端口模板（FDE 容器内）

| 端口 | 用途 | 暴露 |
|---|---|---|
| ~~3000~~ | ~~`station-runner` 内部 API~~ **已取消**：容器平台通道零监听、全出站（§10.3，决策者 2026-09，issue #3 评论） | — |
| ~~3001~~ | ~~code-server~~ **已取消**：容器唯一交互入口为 FDE 对话界面（issue #71，决策者 2026-09-24；对齐 3000 取消先例） | — |
| 号池段（默认 `22000–22009`） | **平台开户即预建的一整段预览域名**（`scope='fde'`、`role='spare'`）：dev servers / 浏览器调试（#240 预建、#246 改为从全局号池 `22000–29999` 发对齐块，§8.2）。具体号段看容器内 `~/.erix/ports.json` | FDE 私，可分享 |
| 其它端口 | 未预分配（run 级端口块仍是 P2；平台不做容器侧端口管控，容器爱监听什么监听什么，但没有 allocation 就没有路由） | — |

> H-B 对齐确认（issue #5）：容器内**无 runner 监听端口**（3000 已取消，平台通道全出站经 Traefik，§5.3/§10.3）；Traefik 不在容器内（host 网络）；以上端口均不 publish，仅经 Traefik 每 allocation 一条路由可达（§6.4）。

### 12.4 Playwright

装进 FDE 容器（chromium ≈1GB），**不做独立 sidecar**——避免跨容器 `localhost` 的持续坑（sidecar 里的 `localhost` 不是 FDE 的 localhost）。成本不是约束时这是正确取舍。

---

## 13. 与 erix-agent 的依赖

### 13.1 会话层与宿主组装：本平台实现（原「等上游抽 src/session」P0 已作废）

宿主组装逻辑（config → provider → store → session → 组装 `runToolLoop` 参数）平台需要自己的一份。原设想「在 erix-agent 抽 `src/session/`（`createSession` / `submit` / `stop` / `history`）发 0.4.0」**不会发生**：上游把会话管理明确列为**永久非目标**——erix-agent `docs/requirements.md` §2「非目标（永远不做）」原文：「❌ agent 人格/skills/会话管理/TUI/MCP」。因此该 P0 **作废删除**（决策者 2026-09，issue #3 评论）。

→ **会话层与宿主组装由本平台实现**：portal（会话 CRUD / 入队 / 状态收敛）+ FDE 容器内 `station-agentd` / `station-runner`（claim / 执行 / 上报）+ DB。对上游的依赖**只剩 run 级接口面**：`runToolLoop` + `TranscriptStore` 接口（`appendRound` / `load` 必需，分层能力可选）+ `erix-agent/tools`（tool registry / providers；jail、file 与 notes 由宿主或 notes 工厂装配）+ `erix-agent/contract-tests` + `config/*`。

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

> **部署契约（compose 字段、镜像 pin、healthcheck、DB 迁移、Traefik 静态/动态配置、防火墙应用方式、socket-proxy、FDE 容器创建参数、readiness 语义、P1 范围）已独立成文：[`deploy-contract.md`](deploy-contract.md)**（P1 部署契约）。本节只保留规格层面的不变式与决策，字段级细节以该契约为准。
>
> （注：任务原文写「§12 部署段」，但本文 §12 是「容器模板与工作区约定」，部署段实为 §14——按实际位置引用，本节即原「部署与运维」段。）

- 平台栈用 `deploy/docker-compose.yml`：`station-edge`（Traefik，**host 网络**，独占 80/443，`--api=false`）+ `station-portal`（`backend` 网络，publish 仅 `127.0.0.1:8080` 回环）+ `station-db`（`backend` 网络，不 publish）+ `station-docker-proxy`（`backend` 网络，仅 portal 可达）；`station-litellm` 为显式 opt-in 的 `litellm` profile（H-B 定稿，issue #5；**compose 字段/healthcheck/volume/镜像 pin 见 deploy-contract.md §2/§3**）
- FDE 容器由 portal 通过 Docker API 动态创建（模板化，非 compose）；**创建契约（网络 `--subnet`/`--add-host`/UID-GID/capability/agentd 命令）见 deploy-contract.md §5**
- **数据持久化**：bind mount 一律 `/docker/<名称>/`（平台统一约定）；用户空间 `/srv/erix/users/<fde>/`（宿主路径，FDE 容器内映射 `/home/<user>`，见 [`user-space.md`](user-space.md) §2）；**宿主源↔容器目标↔权限见 deploy-contract.md §2**
- `restart: unless-stopped`；DB 与 portal 配 healthcheck（**阈值与 readiness 语义见 deploy-contract.md §2/§8**）
- **容器资源限额**：FDE 容器的创建参数（如 `--memory` 限额）只能由 portal 经 Docker API 设置（容器创建参数为平台侧独有）；`node_modules` 每 worktree 一份的磁盘/内存压力在容器内由 FDE 用 pnpm store / npm cache 自行缓解（§12.2）
- **可靠性**：中心 DB 是全平台单点；portal 无状态（状态在 DB），可重启。**DB 备份/高可用不在本项目范围**（系统级方案负责，决策者 2026-09，issue #3 评论）——平台侧只保证数据落卷（bind mount，见上）、DB 处于可被系统级备份方案备份的形态
- **可观测**：run 事件、judge 决策、工具调用、访问审计、用量都在 DB，直接做看板
- **长任务无人看** → 完成/失败/需审批时通知（邮件或 IM webhook）——**延后（P2+），P1 不做**（决策者 2026-09，issue #3 评论）。§7.1 本地 admin 登录告警、§11.4 出口策略未实施时的管理层书面知情，语义保留（它们是设计结论），但**通知通道实现同属延后事项**，不阻塞 P1
- **运行时超时/租约/心跳/背压/时间权威/日志轮转**：见 [`env.md`](../env.md) §11「P1 运行时参数表」
- **防火墙应用方式**（iptables-nft、幂等、fail-closed、docker/宿主重启恢复）：见 deploy-contract.md §4

---

## 15. 分期计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P1** | Traefik + portal + DB + 单 FDE 容器（含 station-agentd / station-runner）；登录、项目列表、对话（SSE）、停止 | 真机走通「登录→建项目→对话→工具卡片→停止」；playwright + vision 验证 |
| **P2** | 多 FDE、run 级端口块 + 预览卡片/iframe、事件重放、~~工具审批~~（**已摘除**：裁决不交付，理由与重新考虑的条件见 principles §3 / issue #249；`approvals` 表与 internal U10/U11 保留作协议留档）、账号生命周期 workflow（项目级端口分配已在 P1，见 §8.2/deploy-contract §7.1） | 断线重连不漏事件；**FDE A 无法访问 FDE B 的任何端口** |
| **P3** | LLM 网关 + 用量记账 + 审计（出口管控为**外部依赖**：安全团队网络层策略，issue #3，非平台交付项） | 成本可按客户项目归集；安全团队出口策略实施后「改 endpoint 无效」，未实施时降级为审计+告警 |

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
