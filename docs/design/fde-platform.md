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
                          ┌─────────────────────────────────────────┐
   FDE 浏览器 ───────────▶│  ingress: Traefik（唯一 publish 80/443）  │
                          └───┬─────────────────────────┬───────────┘
      station.<domain>        │                         │  *.fde.<domain>
      （portal：登录/项目/对话）│                         │  （项目预览/IDE）
                              ▼                         ▼
                    ┌──────────────────┐    ┌──────────────────────────────┐
                    │  station-portal  │    │ FDE 容器 "alice"              │
                    │  用户/项目/端口   │    │  :3000 runner（erix worker）  │
                    │  容器生命周期     │    │  :3001 code-server           │
                    │  事件/SSE        │    │  :4000+ dev servers          │
                    │  LLM 网关        │    │  workspace volume            │
                    └────────┬─────────┘    └──────────────────────────────┘
                             │                              ▲
                    ┌────────▼─────────┐                    │
                    │  station-db      │◀───────────────────┘
                    │  postgres        │   长轮询领任务 / 回写事件
                    └──────────────────┘
```

**网络**：
```
docker network: edge       ← 只有 ingress + portal
docker network: control    ← portal + db + 所有 FDE 容器
docker network: fde-alice  ← 只给 alice 的容器和她的辅助容器
docker network: fde-bob    ← ...
```

---

## 4. 组件职责

| 组件 | 职责 | 明确不做 |
|---|---|---|
| `station-edge`（Traefik） | TLS、按 host 路由、forwardAuth、访问日志（原始，非审计真相）、唯一对外入口 | 不碰业务逻辑 |
| `station-portal` | 用户系统、项目/端口分配、容器生命周期、事件与消息、SSE、LLM 网关、用量记账 | 不跑 agent、不做工具执行 |
| `station-db`（Postgres） | 用户/会话/消息/transcript/events/端口表/用量/审计 | 不存代码 |
| `fde-<name>`（FDE 容器） | `station-runner`（跑 erix agent）+ code-server + dev servers；状态写 DB | 不 publish 端口、不挂 `docker.sock`、不存平台密钥 |

**只有 portal 挂 `/var/run/docker.sock`**（建议前置 `tecnativa/docker-socket-proxy` 收窄到 CONTAINERS/NETWORKS/VOLUMES）。FDE 容器永不挂。

---

## 5. 网络与隔离模型

### 5.1 拓扑（决定一切）

```
portal  → 在 control 网络上 → 能按容器名访问 fde-alice / fde-bob
alice   → 在 control + fde-alice 上 → 能访问 portal；
                                   访问不到 fde-bob（无共同网络 → DNS/IP 均不可达）
```

即**每个 FDE 容器 = `control` + 自己的 `fde-<name>` 双接入**。

### 5.2 三条必须同时堵的洞

| 洞 | 后果 | 堵法 |
|---|---|---|
| `-p 4000:4000` publish 到宿主机 | 绕过 ingress，直接访问 | FDE 容器一律不 publish；只有 ingress publish 80/443 |
| 所有容器同一 bridge 网络 | alice 的容器 `curl bob:4000` 直达 | 每 FDE 独立网络（§5.1） |
| 容器内自建隧道（cloudflared/ngrok） | 绕过平台直接对外 | 安全团队网络层策略（§11.4，issue #3）+ 平台审计 |

### 5.3 「不 publish」不等于「不监听」

容器内**仍然监听**端口（如 runner 监听 3000），只是该端口仅在 docker 网络内可达。portal 通过 `http://fde-alice:3000` 访问（docker 内嵌 DNS 解析容器名，需同在 `control` 网络）。

---

## 6. 访问控制与认证

### 6.1 「只有本人可见」= 两件事同时成立

| 层 | 机制 | 挡住的攻击 |
|---|---|---|
| ① **网络拓扑** | 每 FDE 独立网络；dev 端口不 publish；只有 ingress 双接入 | 其他 FDE 的容器直连；内网/公网直连宿主机端口 |
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

### 6.4 Traefik 骨架

```yaml
# 泛域名 + 一个 forwardAuth，零 per-port 配置
http:
  routers:
    fde:
      rule: "HostRegexp(`^[a-z0-9-]+\\.fde\\..+$`)"   # 或 portal 生成的显式路由
      entryPoints: [websecure]
      middlewares: [fde-auth]
      service: fde-dynamic          # 由 portal 写入 file provider 动态配置
  middlewares:
    fde-auth:
      forwardAuth:
        address: "http://station-portal:8080/api/forward-auth"
        authResponseHeaders: [X-Auth-User]
```

portal 的 `/api/forward-auth` 逻辑：**解析 `X-Forwarded-Host` 取 FDE 标识 → 与 session cookie 的 `sub` 比对 → 200 / 403**。端口/槽位白名单、审计日志都在这里做。

**路由由 portal 生成并写入 Traefik file provider，与 DB 的端口分配表同源同事务**——不允许手工改，也不允许 FDE 容器打 label 自注册（「路由表里没有 = 不可达」这条性质必须成立）。

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
2. 建/复用 FDE 容器：接入 `control` + `fde-<name>` 网络，bind mount 用户空间
3. 分配端口块 + 生成 Traefik 路由（**同一事务**）
4. 在 LLM 网关建**虚拟 key**（额度、模型白名单、别名 `alice@client-x`）
5. 生成项目模板与 AGENTS.md（含端口约定、分支约定）

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
        │ portal 单向写出
        ▼
容器内 ~/projects/<project>/.erix/ports.json（agent 只读，永不写）
```

**为什么 DB 是真相**：URL 与 Traefik 路由必须同源（不一致 = 502 的来源）；主机重启后凭 DB 重新生成全部 JSON + 路由（自愈）；并发申请靠唯一约束 + 事务；谁在用、何时回收、给谁看过只有 DB 装得下。

**为什么还要 JSON**：agent 读端口无需发 API（少一个失败点，可离线）；可 grep、可调试；符合「这台小电脑」的心智模型。

**同步规则**：平台 → 容器**单向**；agent 需要新端口**发 API 申请**，绝不自己挑。

### 8.2 分配策略

| 类别 | 用途 | 生命周期 |
|---|---|---|
| **项目级固定端口** | URL 稳定：书签、演示、客户 demo、对话页预览卡片 | 项目创建时分配，删除时回收 |
| **run 级临时端口** | 多分支并发开发；URL 带 runId | run 结束回收 |

- 容器固定角色：`3000` runner（不对外）、`3001` code-server
- run 端口块：`4000 + runIndex*8 … +7`（前端/后端/浏览器调试/备用）
- 每用户总配额（如 40 个端口），超限**明确报错**而非静默漂移
- 定期 reaper 回收 `released_at` 过期项；Traefik 配置由同一事务生成

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
containers          (fde_name, container_name, token, status, image, agent_version, last_heartbeat)
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
2. **DB adapter 必须包 retry**，并把 `checkpoint_failed` 识别为**可重试**（erix ≤0.3.4 无重试）。
3. **runId 用 UUID**，不要用 cwd 派生（多用户下会撞）。
4. `run_events` / 用量 / session 状态**不属于** `TranscriptStore` 契约 → 用 store decorator 包一层（写事件、更新 `last_seq`、记 `usage_ledger`）。

> **⚠️ 强烈建议：本地 file 优先 + DB 异步复制的 store 装饰器。** 中心 DB 抖动时，fail-closed 会**杀掉所有正在跑的任务**。本地 JSONL 先写保证不失败，后台同步到 DB；恢复时 DB 没有就回落本地。

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

### 10.3 portal ↔ 容器

- **portal → 容器**：HTTP，`Authorization: Bearer <per-container token>`（建容器时生成、存 DB、注入容器环境 `ERIX_RUNNER_TOKEN`）
- **容器 → portal**：写 DB + 心跳。**不需要回连 portal API**（不需要 portal 凭据、不受中心网络抖动影响）
- **任务下发**：拉模型（容器长轮询/`LISTEN` 领 `run_queue`）优于推模型——容器无需暴露入口、天然可重放。单机下也可先用 push
- **取消**：`AbortController` 跨不了进程 → DB 标记 `cancel_requested` + runner 轮询，或走 runner API

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

> **职责边界（决策者 2026-09，issue #3）**：「网络到不了」由**网络层出口策略**实现，属**安全团队职责**，平台不负实施责任。技术事实：Docker 容器默认经宿主机 NAT 出网且无任何限制；出口策略只能在网络层实施（宿主机 iptables/nftables 按 docker 网络/容器 IP/veth 接口、或强制 egress 代理按域名白名单、或网络设备对容器所在网段做策略），平台业务代码实现不了。平台侧不可推卸的部分是**凭据红线**：容器内只放网关虚拟 key（带额度/模型白名单/可吊销），永不下放下游真实 key。

### 11.3 模式对比

| 模式 | 形态 | key 进容器 | 能改 endpoint 绕过 | 需自写代理 |
|---|---|---|---|---|
| A 直连 | 容器 → 网关（per-FDE 虚拟 key） | 是 | **能**（除非做出口管控） | 否 |
| B 经 portal | 容器 → portal → 上游 | 否 | 不能 | **是**（SSE 透传） |
| **C 网络强制（选定）** | 容器 → 网关，**且网关是唯一可达的 LLM 出口**（前提：安全团队网络层出口策略已实施，issue #3） | 是（虚拟 key） | **不能** | 否 |

**选 C**：用现成的 LiteLLM/one-api 做网关（不自己写流式代理），portal 只做：

1. 开通账号时调网关 admin API **建虚拟 key**（额度、模型白名单、别名 `alice@client-x`）
2. 禁用账号时**吊销**
3. 定期拉用量 → 落 `usage_ledger`，做**业务口径**（按 FDE / 按客户项目，网关不知道这层映射）

→ 待 Q1 确认公司是否已有网关；没有则先起一个 LiteLLM 容器，仍走 C。

> 模式 C 的「唯一可达」是**依赖外部网络策略实现的前提**（安全团队职责，issue #3），不是平台自身交付物；该前提未成立时，模式 C 退化为「模式 A + 审计告警」（见 §11.4 降级路径）。

### 11.4 配套细节

- key 通过 `ERIX_API_KEY_FILE` 指向**只读文件**注入，不写进 config 正文（erix 的 `ModelConfig` 原生支持 `apiKeyEnv` / `apiKeyFile`）
- **judge / fold 用便宜模型**：`ModelConfigProvider.resolve(slot)` 支持 `default` / `audit` / `fold`；长任务 judge 会 +10~30% 调用量
- **额度用尽**：网关 429 → erix 分类 `KitError(rate_limited, retryable)` → 宿主需友好提示，且避免重试继续烧配额
- **对账**：网关 usage 与 erix `onUsage` 两套数都要记（差异来自 judge/fold 的额外调用）
- **出口 allowlist 移交给安全团队的网络层策略**（白名单内容由安全团队维护）：npm registry、pypi、GitHub/内部 git、镜像仓库；**LLM 域名不在白名单**——这是「唯一出口」的实现方式（决策者 2026-09，issue #3）。平台对安全团队的接口：容器网络名/命名规范（`control` / `fde-<name>`）、审计事件、以及「上游 LLM 只经网关」的架构事实
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

### 12.2 容器内约定（写进 FDE 容器的 AGENTS.md）

- 一个项目 = `~/projects/<project>`；一个 run = `~/worktrees/<project>-<runId>` + 分支 `agent/<runId>`
- 端口从 `~/projects/<project>/.erix/ports.json` 取，不自己挑；dev server 绑 `0.0.0.0`
- 回流走 fork/PR，不直接在主干改
- `git worktree` 注意：`.git` 是共享的（`worktree prune` 由平台/人管理，别让 agent 乱跑 `worktree remove`）；`node_modules` 每个 worktree 一份 → 用 pnpm store / npm cache 共享，或给容器 `--memory` 限额

### 12.3 端口模板（FDE 容器内）

| 端口 | 用途 | 暴露 |
|---|---|---|
| 3000 | `station-runner`（内部 API） | 不对外 |
| 3001 | code-server | FDE 私 |
| 4000+ | 按 run 分配的 dev servers / 浏览器调试 | FDE 私，可分享 |

> **建议把 code-server 放进模板**：纯聊天界面的 agent 很痛苦——人需要在同一台机器上接管、review、手改，IDE 与聊天面板指向同一 workspace 才叫协作。

### 12.4 Playwright

装进 FDE 容器（chromium ≈1GB），**不做独立 sidecar**——避免跨容器 `localhost` 的持续坑（sidecar 里的 `localhost` 不是 FDE 的 localhost）。成本不是约束时这是正确取舍。

---

## 13. 与 erix-agent 的依赖

### 13.1 前置重构（P0，必须先做）

宿主组装逻辑目前全在 `bin/cli.js:runChat`（config → provider → skills → MCP proxy → store → sessionId → idleTimeout → resume → 组装 `runToolLoop` 参数）。平台若复用会造成**两份真相**。

→ 需在 erix-agent 抽 `src/session/`（`createSession` / `submit` / `stop` / `history`），从 `erix-agent/session` 导出，CLI 改为薄壳。

### 13.2 erix 侧缺口（均可在宿主侧包掉，不改库）

1. `TranscriptStore` 无 list/search → 宿主 SQL 天然解决
2. `LoopEvent` 无 seq/ts/持久化 → 宿主 store decorator 补
3. `onEvent` 是同步 void，事件分散在 6 个回调 → 建议 additive 增补 `assistant_delta` / `reasoning_delta` / `tool_call_delta` / `judge` 类型（可选增强）
4. **多轮必须显式传 `task`**（host-upgrade-guide §2），否则 judge 拿旧种子当基准
5. `checkpoint_failed` fail-closed 语义 → 见 §9.3
6. `erix-agent/contract-tests` 应接入 CI（长期运行的宿主必需）

---

## 14. 部署与运维（裸 Linux host + Docker）

- 平台栈用 `deploy/docker-compose.yml`：`station-edge` (Traefik) + `station-portal` + `station-db`
- FDE 容器由 portal 通过 Docker API 动态创建（模板化，非 compose）
- **数据持久化**：bind mount 一律 `/docker/<名称>/`（平台统一约定）；用户空间 `/srv/erix/users/<fde>/`（宿主路径与容器内一致）
- `restart: unless-stopped`；DB 与 portal 配 healthcheck
- **可靠性**：中心 DB 是全平台单点 → 备份 + 主从；portal 无状态（状态在 DB），可重启
- **可观测**：run 事件、judge 决策、工具调用、访问审计、用量都在 DB，直接做看板
- **长任务无人看** → 完成/失败/需审批时通知（邮件或 IM webhook）

---

## 15. 分期计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | erix-agent 抽 `src/session/`，发 0.4.0（**在 erix-agent 仓库**） | `npm test` 全绿 + CLI 行为不变 |
| **P1** | Traefik + portal + DB + 单 FDE 容器；登录、项目列表、对话（SSE）、停止 | 真机走通「登录→建项目→对话→工具卡片→停止」；playwright + vision 验证 |
| **P2** | 多 FDE、端口分配 + 预览卡片/iframe、事件重放、工具审批、账号生命周期 workflow | 断线重连不漏事件；**FDE A 无法访问 FDE B 的任何端口** |
| **P3** | LLM 网关 + 用量记账 + 审计 + code-server 模板（出口管控为**外部依赖**：安全团队网络层策略，issue #3，非平台交付项） | 成本可按客户项目归集；安全团队出口策略实施后「改 endpoint 无效」，未实施时降级为审计+告警 |

---

## 附录 A：决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | ingress 用 **Traefik**，路由由 portal 生成写入 file provider | 动态配置简单、内置 forwardAuth、自动证书；路由与 DB 端口表强一致可审计 |
| D2 | 登录走 **SSO(OIDC) + 本地 break-glass admin** | SSO 日常；本地账号是 IdP 故障时唯一通道，强制 TOTP + 审计 |
| D3 | 每 FDE 容器 = `control` + `fde-<name>` 双网络接入 | portal 可访问所有容器；FDE 互相不可达 |
| D4 | **不 publish 任何 FDE 端口** | 堵死绕过 ingress 的第二条路；所有 auth 生效的前提 |
| D5 | dev 端口由**平台分配**，DB 为真相 + `.erix/ports.json` 为派生副本（单向） | 防冲突/URL 漂移；agent 不自己挑端口 |
| D6 | LLM 走**模式 C：唯一可达的网关出口**；其中「FDE 改不了 endpoint」**依赖网络层出口策略（安全团队职责），平台不负实施责任**；策略未实施时降级为审计+告警，须管理层书面知情（决策者 2026-09，issue #3） | 「FDE 改不了 endpoint」只能靠网络强制，不能靠文件权限 |
| D7 | 事件/transcript 落中心 DB，portal 从 DB 读并发 SSE | portal 重启不杀任务；断线可按 Last-Event-ID 补发 |
| D8 | 隔离单元 = **worktree**（`agent/<runId>` 分支） | 同仓库并发多 agent 不冲突；回流走 fork/PR |
| D9 | **认证放边缘**，dev server 与 agent 不感知认证 | 安全设施对 agent 工具链透明；应用零改造 |
| D10 | 仓库名 `erix-station`，展示名 **FDE Station** | 标识短（天天打）、展示名说清语义 |
