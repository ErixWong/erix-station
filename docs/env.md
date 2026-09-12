# 部署参数清单（env.md）

> 本文是 **FDE Station 的部署参数清单（Deployment Parameter Spec）**，不是「某台机器的环境事实清单」。
>
> **定位**：我们不一定要在任何已实测过的环境里部署——目标环境可能完全不同。因此本文的每个参数给出四要素：**参数名 / 语义 / 取值来源 / 示例值**。部署时由运维/决策者在**目标环境**上按 §9 跑探测命令、按附录填 ⚠️ 项，即可得到 §10 的全部 deploy 变量。
>
> 规格 [`design/fde-platform.md`](design/fde-platform.md) 中一切环境相关取值（域名、路径、端口、版本），部署时以本文的参数定义为准；本文没有的参数，先补本文再引用（见 [`README.md`](README.md) §四 写作纪律 3）。
>
> 取值来源分三类：
> - **决策者提供**：组织/业务事实（base domain、证书方式、ACME email、SSO）。出口策略（egress）**不是平台参数**，而是**外部依赖（安全团队）+ 部署前置条件**（决策者 2026-09，issue #3），见 §3。
> - **目标环境探测**：机器事实（Docker 版本、端口可用性、资源、路径），必须在目标环境上实测，§9 给出探测命令。
> - **平台规范固定**：规格已定，不随环境变化（域名规则、网络划分、「ingress 是唯一入口」、不 publish 的端口等）。
>
> 所有**实测数值**统一收敛到 §8「参考实例 A（开发机）」，仅作示例。**参考实例仅用于验证配置可跑通，不是设计约束、不是部署目标**；目标环境的对应取值必须重新探测或向决策者确认。

---

## 1. 域名与 DNS 参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| `BASE_DOMAIN` | base domain，portal 与预览域名的公共后缀 | 决策者提供 ⚠️ | `erix.vip`（倾向：与内网 Gitea `git.erix.vip` 同域，规格 §8.3 示例 URL 亦用 `fde.erix.vip`） |
| `PORTAL_HOST` | portal 域名 = `station.` + base domain | 平台规范固定（规格 §6.3） | `station.erix.vip` |
| `FDE_WILDCARD_HOST` | 预览泛域名；必须与 portal 同 registrable domain，否则 SameSite 打死 iframe | 平台规范固定（规格 §6.3） | `*.fde.erix.vip`（如 `alice-r3a7f-4008.fde.erix.vip`） |
| DNS 泛解析 | 内网 DNS 添加两条 A 记录：`station.<base>` 与 `*.fde.<base>` → 宿主机内网 IP | 目标环境探测 + 决策者确认 ⚠️（倾向：平台 VPN-only/内网（见 §3），泛解析只需内网 DNS 支持） | 探测命令见 §9。若内网 DNS 不支持泛解析，降级方案是 portal 生成显式路由 + 逐条 A 记录，控制面复杂度上升（见 principles §3「每个端口一条手工路由」被否决项的权衡） |
| 代码托管 | 内网自托管 Gitea | 决策者提供 | `git.erix.vip`（参考实例 A 已实测在跑，见 §8.1） |

## 2. 证书参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 证书方式 | 预览域名是泛域名，HTTP-01 无法签泛域名证书；DNS-01 是唯一能覆盖 `*.fde.` 泛域名的免费方案 | 决策者提供 ⚠️ | 倾向：**Let's Encrypt DNS-01**（泛域名 `*.fde.erix.vip` + `station.erix.vip`）。前提：`erix.vip` 的公网 DNS zone 可通过 API 操作（Traefik 支持主流 DNS provider）。**降级方案**：若 zone 不可 API 操作，改用内部 CA（自签根 + 下发到公司设备），代价是每台访问设备需装根证书；自签仅作本地开发兜底，不用于交付 |
| `ACME_EMAIL` | ACME 账号注册邮箱 | 决策者提供 ⚠️ | 待填 |
| `DNS_PROVIDER` / DNS-01 API token | DNS-01 的 provider 名称与 API 凭据；凭据经环境变量注入（见 §6），不写进配置文件 | 决策者提供 ⚠️，凭据文件注入 | 待填 |

Traefik 侧对应配置：`certificatesResolvers.le.acme.dnsChallenge`，凭据经环境变量注入，不写进配置文件。

## 3. 网络可达性与出口参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 平台可达性 | 平台是否 VPN-only / 仅内网可达：宿主机不暴露公网入口，portal 与预览域名只在内网 DNS 解析 | 决策者提供 ⚠️ | 倾向：**VPN-only**。依据：principles §3「IP 白名单作主机制」被否决项明确——「平台整体 VPN-only 时，IP 限制是网络层措施而非按人白名单」，这是正确用法 |
| 公司出口正向代理 | 目标环境出口是否存在强制正向代理 | 目标环境探测 ⚠️（探测命令见 §9） | 未知；按「无透明代理、宿主机可直连外网」设计。若实际存在强制正向代理，会影响：① 安全团队容器出口策略的落地方式（issue #3）；② LLM 网关上游连通性。部署前必须实测确认 |
| 出口管控（egress 策略） | **部署前置条件：安全团队须已实施容器出口策略**（决策者 2026-09，issue #3：出口管控归安全团队网络层，平台不负实施责任） | 外部依赖（安全团队）⚠️ | 需向安全团队索要/确认的事实：① 容器使用哪个网段；② 策略如何标识容器（IP / 网络名 / label）；③ 白名单内容与维护流程（npm registry / pypi / GitHub / 内网 Gitea / 镜像仓库；**LLM 域名不在白名单**——这是规格 §11 模式 C「唯一出口」的实现方式）；④ LLM 域名是否不解析；⑤ 变更/开通 SLA。平台侧提供的接口：容器网络名/命名规范（`control` / `fde-<name>`）+ 审计事件 + 「上游 LLM 只经网关」的架构事实 |

## 4. 认证 / SSO 参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| OIDC provider 事实 | issuer / client 注册方式 / group claim 名称 | 决策者提供 ⚠️ | 未发现可用的公司 SSO 事实（均未实测） |
| P1 认证方案 | portal 本地表 + argon2id 哈希 + 强制 TOTP（规格 §7.1 本地 admin 通道的同一套机制）；第一个 admin 只能本地建（bootstrap） | 平台规范固定（倾向，依据 principles §4 Q3 倾向 (a)：本地账号仅破窗 + bootstrap） | 先用本地账号：在没有 IdP 事实前，P1 不阻塞于 SSO |
| OIDC 接入 | 拿到 issuer / client 注册方式 / group claim 名称后接入（建议 P2）：JIT provisioning，角色来自 group claim（`fde` / `admin`），不在 UI 手点 | 平台规范固定（规格 §7.1 / D2 已定方向），接入时点取决于决策者提供事实 | 延后到 P2 |

## 5. 端口参数与 ingress 入口

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| `TRAEFIK_WEB_PORT` | Traefik `web` entrypoint 的宿主机 publish 端口（对外唯一入口之一） | 平台规范固定（规格 §5：只有 ingress publish 80/443）+ 目标环境探测（可用性，见 §9） | `80` |
| `TRAEFIK_WEBSECURE_PORT` | Traefik `websecure` entrypoint 的宿主机 publish 端口 | 同上 | `443`（目标环境冲突未解时过渡用 `8443`，见 §5.1 与 §8.3） |
| portal 8080 | portal 服务端口，**仅容器网络内**，不 publish 宿主机（规格 §5） | 平台规范固定 | —（宿主机 8080 是否被占用与本平台无关） |
| station-db 5432 | 数据库端口，**仅 `control` 网络内**，不 publish 宿主机；station-db 是独立 postgres 容器，与宿主既有实例互不可见 | 平台规范固定 | —（同上） |

### 5.1 通用部署前检查：ingress 端口可用性

> **ingress 需要独占的端口（默认 80/443）在部署前必须在目标环境上核实可用**（探测命令见 §9）。若被占用，按优先级处理：
>
> 1. **迁移占用者**（推荐）：把占用者的路由迁到 Traefik（Traefik 作唯一 ingress，原服务退为后端），或让占用者改听其他端口，Traefik 按规格独占 443。**这保持「唯一入口」不变式不被破坏。**
> 2. **临时备用端口**：`websecure` 暂用 8443，URL 带端口号（`https://station.<base>:8443`），仅作联调过渡；正式使用前必须回到方案 1——泛域名预览 URL 带端口会污染书签/iframe/cookie 域模型。
> 3. **只在不得以时代理链**：复用现有 443 反代、把 station/fde 域名转发给 Traefik——违反「ingress 是唯一入口」（原理四），多一层不受 portal 控制的代理，**不推荐**。
>
> 参考实例 A 上的端口占用实况与具体处理选项见 §8.2/§8.3——那是参考实例的现状，不是部署目标的约束。

## 6. 路径、命名与凭据注入参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 容器命名 | 项目前缀 + 组件名 | 平台规范固定（规格 §14 已定） | 本平台：`station-edge` / `station-portal` / `station-db`；FDE 容器：`fde-<name>`（如 `fde-alice`） |
| `DATA_ROOT` | 平台数据 bind mount 根目录，布局为 `<DATA_ROOT>/<名称>/` | 决策者/运维约定 | `/docker`（参考实例 A 的全机统一约定，见 §8.1）；如 `/docker/station-db/`（pg data）、`/docker/station-edge/`（traefik 动态配置/证书存储 acme.json） |
| `USER_SPACE_ROOT` | FDE 用户空间根，布局为 `<USER_SPACE_ROOT>/<fde>/`，**宿主路径与容器内路径一致**（规格 §12.1） | 路径结构平台规范固定；具体取值由决策者/运维提供 | `/srv/erix/users`（参考实例 A，见 §8.1）；如 `/srv/erix/users/alice/{home,projects,worktrees,cache}` |
| docker 网络 | `edge` / `control` / `fde-<name>` | 平台规范固定（规格 §3） | `edge` 只接 ingress+portal；`control` 接 portal+db+全部 FDE 容器 |
| 凭据存放 | 平台凭据（DB 密码、runner token、OIDC client secret、DNS-01 API token）一律环境变量或凭据文件注入（项目 AGENTS.md §6），不进仓库、不进 compose 正文 | 决策者/运维约定 | 参考实例 A：`~/.config/mcp/creds/`，权限 **600**（已实测存在，含 gitea、portainer、mssql 等凭据，见 §8.1）；或 `<DATA_ROOT>/<名称>/` 下 600 文件 |

凭据注入要点（平台规范固定，不随环境变化）：

- LLM key 经 `ERIX_API_KEY_FILE` 只读文件注入容器（规格 §11.4）
- `docker.sock` 仅 portal 挂载，且前置 `tecnativa/docker-socket-proxy` 收窄到 CONTAINERS/NETWORKS/VOLUMES（规格 §4）
- `DB_PASSWORD` 部署时生成后存凭据文件（600）

## 7. 运行时与资源要求

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| Docker Server 版本 | 编排与 Docker API 依赖的运行时版本 | 目标环境探测（命令见 §9） | 参考实例 A：**29.1.3**（见 §8.1） |
| 编排形态 | 裸 Linux host + Docker（无 K8s）；编排层留 `RunnerBackend` 抽象 | 平台规范固定（规格 Q6 已定） | — |
| CPU / 内存 / 磁盘 | 容器成本不是约束（规格 §1）；FDE 容器模板含 chromium（≈1 GB/容器，规格 §12.4），需按目标规模估算磁盘 | 目标环境探测（命令见 §9） | 参考实例 A 实测值见 §8.1 |
| Portainer 是否存在 | 目标环境上是否已有 Portainer（运维观察面） | 目标环境探测（命令见 §9） | 参考实例 A：已存在（见 §8.1） |

Portainer 与本平台的关系（平台规范固定，不随环境变化）：Portainer 是**运维观察面**（看容器、日志），不是控制面——FDE 容器生命周期一律由 portal 经 Docker API 管理（规格 §14），不允许在 Portainer 里手工增删 FDE 容器（会绕过 DB 真相与端口分配事务）。

运维会话注意事项：若目标环境上运维/agent 会话不在 `docker` 组，bash 中执行 docker 命令可用 `sg docker -c '<cmd>'` 绕过（此情况在参考实例 A 上实测出现过，见 §8.1；写 runbook / 运维脚本时按目标环境实际情况引用，D6 任务应引用）。

## 8. 参考实例 A（开发机）

> **本节是全部实测数值的唯一出处。** 以下数值于 2026-05 在一台开发机上实测确认，仅用于验证配置可跑通、为各参数提供示例值。**参考实例不是设计约束、不是部署目标**；目标环境的对应取值必须按 §9 重新探测或向决策者确认。凡引用本节数值处，均应理解为「参考实例 A 上如此」。

### 8.1 实测概览（2026-05，仅参考实例 A）

| 项 | 实测值 |
|---|---|
| Docker Server 版本 | **29.1.3** |
| Portainer | **已存在**：容器名 `portainerce`，监听 `127.0.0.1:9000`，endpoint Id = 2 |
| CPU | 36 核 |
| 内存 | 125 GiB 总量，可用约 100 GiB |
| 磁盘 | 单盘 `/dev/nvme0n1p2` 挂载 `/`；总量 937 G，可用 275 G |
| 已有负载 | 宿主机已跑大量容器（gitea、portainer、mssql、多个 playwright 等），资源规划需预留余量 |
| 代码托管 | Gitea `git.erix.vip`（内网自托管，在跑） |
| 凭据目录 | `~/.config/mcp/creds/`（600，含 gitea、portainer、mssql 等凭据） |
| docker 组会话 | 该机上 agent 的旧会话不在 `docker` 组，docker 命令需 `sg docker -c '<cmd>'` 绕过 |
| 数据目录约定 | 全机统一 `/docker/<名称>/`；FDE 用户空间 `/srv/erix/users/<fde>/` |

容量评估（以参考实例 A 为例）：容器成本不是约束（规格 §1）；FDE 容器模板含 chromium（≈1 GB/容器，规格 §12.4），275 G 可用磁盘对 P1~P3 规模（个位数 FDE）充裕。

### 8.2 端口占用实况（仅参考实例 A；目标环境需按 §9 重新核实）

| 端口 | 参考实例 A 现状 | 规格规划 | 结论 |
|---|---|---|---|
| 80 | ✅ 空闲（`ss -tlnp` 无监听） | Traefik `web` entrypoint（唯一 publish 之一） | 参考实例 A 上可用 |
| 443 | ⚠️ **已被容器 `nginx_reverse_proxy` 占用**（`0.0.0.0:443->443/tcp`，nginx，默认 vhost 对 `https://127.0.0.1/` 返回 `502 Bad Gateway`；同容器另映射 9001/9002） | Traefik `websecure` entrypoint | 参考实例 A 上冲突，处理选项见 §8.3 |
| 8080 | 已被容器 `gitea_act_runner` 占用（host 网络，进程直接监听 `:::8080`，Go 服务：`http://127.0.0.1:8080/` 返回 `404 text/plain`） | portal（规格 §5：**仅容器网络内**，不 publish 宿主机） | 无冲突——portal 的 8080 只存在于 docker 网络内，宿主不映射（此结论与平台规范一致，任何环境均成立） |
| 5432 | 已被容器 `postgresql` 占用（`0.0.0.0:5432->5432/tcp`） | station-db（**仅 `control` 网络内**，不 publish 宿主机） | 无冲突——station-db 是独立 postgres 容器，只对 `control` 网络暴露 5432，与宿主既有实例互不可见（同上） |

### 8.3 443 占用处理记录（参考实例 A 的候选方案）

> 以下为参考实例 A 上 443 冲突的具体处理选项，**仅参考实例 A**；通用要求与处理优先级见 §5.1。目标环境若有同类冲突，需按 §5.1 重新评估，且同样**不构成「P1 硬阻塞」级别的设计问题**——它只是部署前检查项之一。

按 §5.1 的优先级展开（参考实例 A 语境）：

1. **迁移 443 上的现有服务**（推荐）：占用者已定位为容器 `nginx_reverse_proxy`（映射 443、9001、9002，另有 8443 暴露未映射）。评估：把它的现有路由迁到 Traefik 之后（Traefik 作唯一 ingress，nginx 退为后端服务），或让其改听其他端口，然后 Traefik 按规格独占 443。（注意该 nginx 当前默认 vhost 返回 502，说明它是否仍在承载有效业务需先确认。）
2. **Traefik `websecure` 暂用 8443**：URL 带端口号（`https://station.erix.vip:8443`），仅作联调过渡；正式使用前必须回到方案 1。
3. ~~复用现有 443 反代，把 station/fde 域名转发给 Traefik~~：**不推荐**（理由见 §5.1）。

> 部署配置（`deploy/`）应把 Traefik 的 publish 端口做成变量（见 §10），使方案 1/2 切换只改一处。

## 9. 目标环境核实项 checklist（部署前必做）

> 运维/决策者在**目标环境**上逐项执行探测命令并填「实测值」列；填完即得到 §10 中所有「目标环境探测」类变量的取值。任何一项不满足期望值，先解决再继续部署。

| # | 核实项 | 探测命令 | 期望值 / 记录内容 | 对应参数 | 实测值 |
|---|---|---|---|---|---|
| 1 | Docker Server 版本 | `docker version --format '{{.Server.Version}}'` | 记录版本号 | §7 Docker 版本 | |
| 2 | 运维会话是否在 docker 组 | `docker ps`；若权限不足则 `sg docker -c 'docker ps'` | 可直连，或记录需 `sg docker -c` 绕过 | §7 运维会话注意 | |
| 3 | CPU 核数 | `nproc` | 记录核数 | §7 资源 | |
| 4 | 内存 | `free -h` | 记录总量/可用 | §7 资源 | |
| 5 | 磁盘 | `df -h /`；及 `df -h <DATA_ROOT> <USER_SPACE_ROOT>` | 按目标规模估算是否充裕 | §7 资源 / §6 路径 | |
| 6 | ingress 端口可用性 | `ss -tlnp \| grep -E ':(80\|443)\b'` | 80/443 无监听，或占用者已按 §5.1 评估 | §5 `TRAEFIK_WEB_PORT` / `TRAEFIK_WEBSECURE_PORT` | |
| 7 | 其他端口占用（参考） | `ss -tlnp \| grep -E ':(8080\|5432)\b'` | portal/db 不 publish，理论上无冲突；占用仅说明宿主已有同名服务 | §5 | |
| 8 | Portainer 是否存在 | `docker ps --format '{{.Names}} {{.Ports}}' \| grep -i portainer` | 记录容器名/监听地址 | §7 Portainer | |
| 9 | 既有容器命名冲突 | `docker ps -a --format '{{.Names}}' \| grep -E '^(station-\|fde-)'` | 无输出，或冲突容器已评估 | §6 容器命名 | |
| 10 | 内网 DNS 泛解析 | `dig station.<base> @<内网DNS>`；`dig test.fde.<base> @<内网DNS>` | 两条均解析到宿主机内网 IP；不支持泛解析时走 §1 降级方案 | §1 DNS 泛解析 | |
| 11 | 公网 DNS zone 可 API 操作 | 决策者确认 DNS provider 及其 API 能力 | 支持则 DNS-01；不支持则内部 CA | §2 证书方式 | |
| 12 | 出口正向代理 | `env \| grep -i proxy`；`curl -sI --max-time 5 https://registry.npmjs.org/` | 无强制代理可直连；有代理则记录代理地址，影响 §3 egress 落地 | §3 正向代理 | |
| 13 | 路径可写 | `ls -ld <DATA_ROOT> <USER_SPACE_ROOT>`；不存在则 `mkdir -p` 验证 | 可创建且归属 docker 可写用户 | §6 路径 | |
| 14 | 安全团队出口策略已实施 | 与安全团队确认（非命令探测） | 记录：策略覆盖的网段 / 标识方式（IP、网络名、label）/ 白名单内容 / 负责人 | §3 出口管控 | |

## 10. deploy 变量一览（验收锚点）

`deploy/` 配置只需替换以下变量即可 `up -d`。每个变量的取值来源在本文 §1~§9 有唯一定义；「目标环境探测」类变量的实测值由 §9 checklist 产出。

| 变量 | 取值来源 | 示例值 |
|---|---|---|
| `BASE_DOMAIN` | 决策者提供（§1 ⚠️） | `erix.vip` |
| `PORTAL_HOST` | 平台规范固定 = `station.` + `BASE_DOMAIN`（§1） | `station.erix.vip` |
| `FDE_WILDCARD_HOST` | 平台规范固定 = `*.fde.` + `BASE_DOMAIN`（§1） | `*.fde.erix.vip` |
| `TRAEFIK_WEB_PORT` | 平台规范固定 + 目标环境探测可用性（§5/§9） | `80` |
| `TRAEFIK_WEBSECURE_PORT` | 平台规范固定 + 目标环境探测可用性（§5/§9） | `443`（冲突未解时 `8443`，见 §5.1/§8.3） |
| `ACME_EMAIL` | 决策者提供（§2 ⚠️） | 待填 |
| `DNS_PROVIDER` / DNS-01 API token | 决策者提供，凭据文件注入（§2 ⚠️ / §6） | 待填 |
| `DATA_ROOT` | 决策者/运维约定（§6） | `/docker` |
| `USER_SPACE_ROOT` | 结构平台规范固定，取值决策者/运维提供（§6） | `/srv/erix/users` |
| `DB_PASSWORD` | 部署时生成，存凭据文件 600（§6） | — |
| `PORTAL_IMAGE` / `EDGE_IMAGE` / `DB_IMAGE` | 平台规范固定（规格 §14） | portal 自构建；`traefik:v3`；`postgres:16` |

> 宿主机内网 IP（DNS A 记录目标）在部署时由运维填入 DNS，不进入 compose 变量。

---

## 附录 A：⚠️ 待决策者确认清单（设计侧）

> 设计侧问题：与环境无关，需要决策者拍板；不定则对应 deploy 变量无法最终定值。

| # | 事项 | 当前倾向 | 阻塞 |
|---|---|---|---|
| 1 | base domain = `erix.vip` | 与 git.erix.vip 同域 | deploy 变量 |
| 2 | 证书 = Let's Encrypt DNS-01 | 需 erix.vip zone 可 API 操作；否则内部 CA | P1 TLS |
| 3 | 平台 VPN-only | 是 | 安全模型 |
| 4 | 出口无强制正向代理 | 按「无」设计；若有，影响安全团队 egress 策略的落地方式与 LLM 网关上游连通性（§3） | 部署前确认 |
| 4a | （已移出本清单）出口管控不再是设计侧待确认项：已定外部依赖（安全团队），作为部署前置条件见 §9 第 14 项（issue #3） | — | — |
| 5 | 端口冲突时的处理方案选择（若目标环境 443 被占用） | 方案 1（迁移占用者）；过渡期方案 2（8443），见 §5.1 | 部署前检查项，**非设计硬阻塞** |
| 6 | SSO provider 事实（issuer/client/group claim） | P1 先本地账号 + TOTP | P2 前必须确认 |
| 7 | ACME_EMAIL / DNS provider token | 决策者提供 | deploy 变量 |

## 附录 B：⚠️ 目标环境待探测清单（环境侧）

> 环境侧问题：答案因目标环境而异，必须在目标环境上实测（命令见 §9）；参考实例 A 的实测值（§8）只是示例。

| # | 事项 | 探测方式 | 对应参数 |
|---|---|---|---|
| 1 | ingress 端口（80/443）可用性 | §9 第 6 项 | `TRAEFIK_WEB_PORT` / `TRAEFIK_WEBSECURE_PORT` |
| 2 | Docker / Portainer 版本与存在性 | §9 第 1、8 项 | §7 |
| 3 | CPU / 内存 / 磁盘资源 | §9 第 3~5 项 | §7 容量评估 |
| 4 | 内网 DNS 泛解析支持 | §9 第 10 项 | §1 DNS 泛解析 |
| 5 | 出口是否存在强制正向代理 | §9 第 12 项 | §3 正向代理 |
| 6 | `DATA_ROOT` / `USER_SPACE_ROOT` 路径可写 | §9 第 5、13 项 | §6 路径 |
