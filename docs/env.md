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

## 0. P1 本地开发环境最小集（先把开发跑起来，最优先看本节）

> **优先级声明（决策者 2026-09，issue #3 评论）**：「公网443和本项目啥关系？我们是写代码啊，你随便搞个端口先把开发环境搞起来不行吗？」——**开发期不需要 443 / 公网可达 / DNS 泛解析 / 真实证书 / VPN**。本文 §1（DNS 泛解析行）、§2（整节）、§3（平台可达性行）、§5.1、§8.3、§9 第 6/10/11 项、附录 A 第 2/3/5 项均为**部署期事项（P1 开发不需要）**，已逐处标注；开发期只看本节即可开工。

P1 本地开发（写代码、起栈联调）只需：

| 项 | 开发期做法 |
|---|---|
| 入口端口 | **127.0.0.1 + 任意高端口**。默认建议：Traefik `websecure` → **`8443`**，`web` → **`8090`**（参考实例 A 上已用 `ss -tlnp` 确认两者空闲，2026-09）。**注意避开本机已占用端口**：80/443 被占（443 为 `nginx_reverse_proxy`）、8080 被占（`gitea_act_runner`）、5432 被占、8931~8934 是 playwright 容器（见 §8.2）；换机器或换端口前一律先 `ss -tlnp` 自查 |
| portal 发布端口 | **`127.0.0.1:18080:8080`**（宿主 8080 已被 `gitea_act_runner` 占用 → 开发期 portal 宿主端口改用 `18080`，`PORTAL_HOST_PORT=18080`；容器内仍听 8080） |
| backend 子网 | **`172.32.0.0/24`**（本机 `172.30.0.0/16` 已被运行中的 `voiceprint_default` 占用（`br-8e3857476b83` / `172.30.0.1`）→ 开发期 `backend` 用 `172.32.0.0/24`，`BACKEND_SUBNET=172.32.0.0/24`；部署期规范值仍为 §5.2 的 `172.30.0.0/24`，由 `BACKEND_SUBNET` 覆盖） |
| socket-proxy | 开发期**同样启用**：`station-docker-socket-proxy` 单独挂 `/var/run/docker.sock`（RO），portal 经 `DOCKER_HOST=tcp://station-docker-socket-proxy:2375` 访问 Docker API（不直挂 socket）；白名单 `CONTAINERS=1`/`NETWORKS=1` + `POST=0` → **P1 只读**（创建容器归 WP2） |
| DB 首次初始化 | 由 `deploy/db-init/00-init.sh` 在 `station-db` **首次启动（空数据目录）**时以超级用户完成一次：`schema.sql`（baseline）→ 设两角色口令 → 回填 baseline checksum → `bootstrap.sql`（授权 + ownership 归正）→ 收紧跨库 CONNECT；**开发期同样**，portal 运行时 `MIGRATE_ON_START=0` 不重复跑 |
| 域名 | 不依赖 DNS 泛解析：用 `/etc/hosts` 逐条指到 127.0.0.1，或用 `*.localhost` 变通（`station.localhost` / `alice-r3a7f-4008.fde.localhost`，多数系统 localhost 子域自动回环到 127.0.0.1）。⚠️ **`*.localhost` 变通只对浏览器/宿主有效，对容器无效**：容器内解析 `station.<base>` / `llm.<base>` 用创建容器时注入的 hosts 映射（`--add-host` → 该 FDE 的 bridge 网关 IP，见本节末注与 §1） |
| TLS | 自签证书，或直接 http 联调（cookie `Secure`/`SameSite` 属性按实际域名方案调试，正式语义仍以 portal.md §2.5 为准） |
| 证书方式 / DNS-01 / VPN-only / 公网可达性 / 443 冲突处理 | **一律部署期再管**（见 §2/§3/§5.1/§8.3 的「部署期事项」标注） |

> **容器内域名解析（开发期同样适用）**：FDE 容器内 `station-agentd` 访问 `station.<base>`、worker 访问 `llm.<base>` 都走 HTTPS 到 Traefik（host:443）。容器内**不走宿主 `/etc/hosts`、也不走 `*.localhost` 变通**——创建 FDE 容器时用 docker `--add-host station.<base>:<该 FDE 网关 IP>` + `--add-host llm.<base>:<该 FDE 网关 IP>`（默认池 `10.200.<n>.1`；大 FDE `10.201.<n>.1`；H-B，topology.md §4-L3/L7）。开发期自签证书需同时覆盖这两个域名（§0 TLS / §2 SAN）。

---

## 1. 域名与 DNS 参数

> 本节参数名与域名规则（portal = `station.<base>`、预览 = `*.fde.<base>`）开发期仍然成立，只是取值用 §0 的 hosts/localhost 变通；**DNS 泛解析行是部署期事项（P1 开发不需要）**。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| `BASE_DOMAIN` | base domain，portal 与预览域名的公共后缀 | 决策者提供 ⚠️ | `erix.vip`（倾向：与参考实例 A 的 git host `git.erix.vip` 同域，规格 §8.3 示例 URL 亦用 `fde.erix.vip`） |
| `PORTAL_HOST` | portal 域名 = `station.` + base domain | 平台规范固定（规格 §6.3） | `station.erix.vip` |
| `FDE_WILDCARD_HOST` | 预览泛域名；必须与 portal 同 registrable domain，否则 SameSite 打死 iframe | 平台规范固定（规格 §6.3） | `*.fde.erix.vip`（如 `alice-r3a7f-4008.fde.erix.vip`） |
| DNS 泛解析 | 内网 DNS 添加两条 A 记录：`station.<base>` 与 `*.fde.<base>` → 宿主机内网 IP。**部署期事项（P1 开发不需要**，开发期用 §0 的 hosts/localhost 变通，决策者 2026-09，issue #3 评论**）** | 目标环境探测 + 决策者确认 ⚠️（倾向：平台 VPN-only/内网（见 §3），泛解析只需内网 DNS 支持） | 探测命令见 §9。若内网 DNS 不支持泛解析，降级方案是 portal 生成显式路由 + 逐条 A 记录，控制面复杂度上升（见 principles §3「每个端口一条手工路由」被否决项的权衡） |
| `llm.<base>`（LLM 数据面域名） | **不进内网/公网 DNS**：只被 FDE 容器（worker）访问，容器内用 hosts 注入（`--add-host llm.<base>:<该 FDE 网关 IP>`）解析到 Traefik（host:443）；证书 SAN 仍需覆盖（§2）。浏览器从不直接访问 `llm.<base>` | 平台规范固定（topology.md §4-L7，H-B） | `llm.erix.vip`（仅作证书 SAN / 容器 hosts 注入用，不做 A 记录） |
| 代码托管（git host） | **git host 中立**：GitHub / Gitea / 其他自托管均可，平台不假设具体 git host；平台亦**不负责 clone 与 git 凭据下发**（由 FDE 在容器内自行配置，规格 §7.2/§12.2；决策者 2026-09，issue #3 评论） | 决策者提供 | `git.erix.vip`（内网自托管 Gitea——**仅为参考实例 A 的情况**，见 §8.1，非设计约束） |

## 2. 证书参数

> 🕓 **本节整体为部署期事项（P1 开发不需要）**：开发期 TLS 自签或直接 http，见 §0（决策者 2026-09，issue #3 评论）。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 证书方式 | 预览域名是泛域名，HTTP-01 无法签泛域名证书；DNS-01 是唯一能覆盖 `*.fde.` 泛域名的免费方案。**证书 SAN 必须同时包含 `station.<base>`、`*.fde.<base>` 与 `llm.<base>`**——`llm.<base>` 由 worker（容器内）经 HTTPS 访问 Traefik，缺它则 TLS 握手失败（H-B，topology.md §4-L7） | 决策者提供 ⚠️ | 倾向：**Let's Encrypt DNS-01**（SAN = `station.erix.vip` + `*.fde.erix.vip` + `llm.erix.vip`）。前提：`erix.vip` 的公网 DNS zone 可通过 API 操作（Traefik 支持主流 DNS provider）。**降级方案**：若 zone 不可 API 操作，改用内部 CA（自签根 + 下发到公司设备），代价是每台访问设备需装根证书；自签仅作本地开发兜底，不用于交付 |
| `ACME_EMAIL` | ACME 账号注册邮箱 | 决策者提供 ⚠️ | 待填 |
| `DNS_PROVIDER` / DNS-01 API token | DNS-01 的 provider 名称与 API 凭据；凭据经环境变量注入（见 §6），不写进配置文件 | 决策者提供 ⚠️，凭据文件注入 | 待填 |

Traefik 侧对应配置：`certificatesResolvers.le.acme.dnsChallenge`，凭据经环境变量注入，不写进配置文件。

## 3. 网络可达性与出口参数

> 🕓 「平台可达性」（VPN-only / 公网可达性）为**部署期事项（P1 开发不需要）**，开发期 127.0.0.1 即可，见 §0（决策者 2026-09，issue #3 评论）。出口管控行仍为部署前置条件，与本节标注互不冲突。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 平台可达性 | 平台是否 VPN-only / 仅内网可达：宿主机不暴露公网入口，portal 与预览域名只在内网 DNS 解析 | 决策者提供 ⚠️ | 倾向：**VPN-only**。依据：principles §3「IP 白名单作主机制」被否决项明确——「平台整体 VPN-only 时，IP 限制是网络层措施而非按人白名单」，这是正确用法 |
| 公司出口正向代理 | 目标环境出口是否存在强制正向代理 | 目标环境探测 ⚠️（探测命令见 §9） | 未知；按「无透明代理、宿主机可直连外网」设计。若实际存在强制正向代理，会影响：① 安全团队容器出口策略的落地方式（issue #3）；② LLM 网关上游连通性。部署前必须实测确认 |
| 出口管控（egress 策略） | **部署前置条件：安全团队须已实施容器出口策略**（决策者 2026-09，issue #3：出口管控归安全团队网络层，平台不负实施责任） | 外部依赖（安全团队）⚠️ | 需向安全团队索要/确认的事实：① 容器使用哪个网段；② 策略如何标识容器（IP / 网络名 / label）；③ 白名单内容与维护流程（npm registry / pypi / GitHub / 内网 Gitea / 镜像仓库；**LLM 域名不在白名单**——这是规格 §11 模式 C「唯一出口」的实现方式）；④ LLM 域名是否不解析；⑤ 变更/开通 SLA。平台侧提供的接口：容器网络名/命名规范（`fde-<name>`）+ 子网段 `10.200.0.0/16` 与 `10.201.0.0/16`（均保留给 FDE 网络专用；`control` 已取消，H-B 定稿 issue #5）+ 审计事件 + 「上游 LLM 只经网关」的架构事实 |

## 4. 认证 / SSO 参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| OIDC provider 事实 | issuer / client 注册方式 / group claim 名称 | 决策者提供 ⚠️ | 未发现可用的公司 SSO 事实（均未实测） |
| P1 认证方案 | portal 本地表 + `crypto.scrypt` 口令哈希（P1 骨架；argon2id 待决策者确认后按自描述哈希平滑迁移，portal §2.9.4）+ 强制 TOTP（规格 §7.1 本地 admin 通道的同一套机制）；第一个 admin 只能本地建（bootstrap） | 平台规范固定（倾向，依据 principles §4 Q3 倾向 (a)：本地账号仅破窗 + bootstrap） | 先用本地账号：在没有 IdP 事实前，P1 不阻塞于 SSO |
| OIDC 接入 | 拿到 issuer / client 注册方式 / group claim 名称后接入（建议 P2）：JIT provisioning，角色来自 group claim（`fde` / `admin`），不在 UI 手点 | 平台规范固定（规格 §7.1 / D2 已定方向），接入时点取决于决策者提供事实 | 延后到 P2 |

## 5. 端口参数与 ingress 入口

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| `TRAEFIK_WEB_PORT` | Traefik `web` entrypoint 的监听端口（Traefik 跑 **host 网络**，独占；对外唯一入口之一。H-B 定稿，issue #5） | 平台规范固定（规格 §5：只有 ingress 占 80/443）+ 目标环境探测（可用性，见 §9） | `80` |
| `TRAEFIK_WEBSECURE_PORT` | Traefik `websecure` entrypoint 的监听端口（同上，host 网络） | 同上 | `443`（目标环境冲突未解时过渡用 `8443`，见 §5.1 与 §8.3） |
| portal 8080 | portal 服务端口，**publish 仅 `127.0.0.1:8080`（回环）**：portal 在 `backend` 网络，回环 publish 供 Traefik（host 网络）反代与 forwardAuth；不暴露 LAN（H-B 定稿 D-3，issue #5，规格 §5） | 平台规范固定 + 目标环境探测（回环 8080 可用性，§9 第 7 项） | `127.0.0.1:8080`（⚠️ 参考实例 A 上宿主 8080 已被 `gitea_act_runner` 占用，见 §8.2——该机部署需迁移占用者或改 publish 端口） |
| LLM 网关数据面 4000 | LLM 网关数据面端口，**publish 仅 `127.0.0.1:4000`（回环）**，供 Traefik `llm.<base>` 路由回环访问；**admin 面不发布**（只在 `backend` 网络。H-B 定稿，issue #5） | 平台规范固定 | `127.0.0.1:4000` |
| station-db 5432 | 数据库端口，**仅 `backend` 网络内**（H-B：`control` 已取消），不 publish 宿主机；station-db 是独立 postgres 容器，与宿主既有实例互不可见 | 平台规范固定 | —（同上） |

### 5.1 通用部署前检查：ingress 端口可用性

> 🕓 **部署期事项（P1 开发不需要）**：开发期不要求独占 80/443，Traefik 直接 publish 到 §0 的高端口（`websecure`→8443、`web`→8090）即可联调；本节是部署到目标环境前的检查项（决策者 2026-09，issue #3 评论）。
>
> **ingress 需要独占的端口（默认 80/443）在部署前必须在目标环境上核实可用**（探测命令见 §9）。若被占用，按优先级处理：
>
> 1. **迁移占用者**（推荐）：把占用者的路由迁到 Traefik（Traefik 作唯一 ingress，原服务退为后端），或让占用者改听其他端口，Traefik 按规格独占 443。**这保持「唯一入口」不变式不被破坏。**
> 2. **临时备用端口**：`websecure` 暂用 8443，URL 带端口号（`https://station.<base>:8443`），仅作联调过渡；正式使用前必须回到方案 1——泛域名预览 URL 带端口会污染书签/iframe/cookie 域模型。
> 3. **只在不得以时代理链**：复用现有 443 反代、把 station/fde 域名转发给 Traefik——违反「ingress 是唯一入口」（原理四），多一层不受 portal 控制的代理，**不推荐**。
>
> 参考实例 A 上的端口占用实况与具体处理选项见 §8.2/§8.3——那是参考实例的现状，不是部署目标的约束。

### 5.2 H-B 部署前置：地址池与拓扑加固（决策者 2026-09 定稿，issue #5）

> 依据 [`design/topology.md`](design/topology.md)（H-B 网络与访问拓扑的单一事实来源）§3/§6。🕓 其中容器→宿主分层收紧（INPUT + DOCKER-USER）与独占 80/443 为**部署期事项**；P1 本地开发期按 §0 执行即可（127.0.0.1 + 任意端口、单 FDE 也能跑），但 `default-address-pools` 建议开发机同步配置（避免默认池耗尽影响 FDE 网络创建）。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| Docker `default-address-pools` | docker daemon 默认地址池：每 FDE 一条 `/29` 从这里切（`10.200.0.0/16` size 29 → 8192 条 FDE 网络）。**为什么需要**：docker 默认池每建一条 bridge 就吃掉一段，FDE 规模稍大即耗尽（参考实例 A 上默认池已被既有容器用掉大半） | 平台规范固定（topology.md §3） | daemon.json：`"default-address-pools": [{"base": "10.200.0.0/16", "size": 29}]` |
| 大 FDE 保留段 | 需要多个自有服务的 FDE 用 `/28`（13 个容器位），从独立段分配，不与默认池混；portal IPAM 显式 `--subnet` 创建 | 平台规范固定（topology.md §3） | `10.201.0.0/16` |
| `backend` 子网 | portal + station-db + LLM 网关的**显式独立子网**（compose 声明 `subnet`，不再 docker 自动分配），与 FDE 池彻底隔离 | 平台规范固定（topology.md §2/§3） | `172.30.0.0/24`（已避开本机既有 `172.19/20/23/26/27/29/31`；目标环境按 §9 第 16 项探测后定） |
| 容器 → 宿主收紧（分层防火墙） | 分 **INPUT**（宿主本地服务）与 **DOCKER-USER**（转发/publish）两层收紧；规则由 `fde_networks` 的**精确 CIDR** 生成（每 `subnet` 一条 `/29` 或 `/28`，见 topology.md §5.1）；`10.200.0.0/16` 与 `10.201.0.0/16` 仅为取值池（**池范围 ≠ 放行范围**），详见 §5.3 与 topology.md §6 第 7 条 | 平台规范固定（加固清单，issue #5） | 见 §5.3 |
| Traefik `--api=false` | 关闭 dashboard/API 管理面：FDE 能访问 Traefik，开着就是跳板（topology.md §6 第 1 条） | 平台规范固定 | 静态配置 `api: false` |

### 5.3 分层防火墙模型（容器 → 宿主收紧：INPUT + DOCKER-USER）

> 依据 topology.md §6（单一事实来源）。**评审修正**：原「只写 `DOCKER-USER` 一条链」不成立——`DOCKER-USER` 在 FORWARD 链，而**容器访问宿主本地服务走 INPUT**；publish 端口在 PREROUTING 已 DNAT（到 FORWARD 时目的地址已被改写，`-d <宿主IP>` 匹配不到）。故改为两层，规则由 `fde_networks` 的**精确 CIDR** 生成（每 `subnet` 一条，含 `/28`，见 topology.md §5.1），**不硬编码单一池**；`10.200.0.0/16` 与 `10.201.0.0/16` 仅为取值池（**池范围 ≠ 放行范围**）。

**① INPUT 链（宿主本地服务）**：

```
# 先放行已建立连接（宿主主动发起/长连接的回包）
-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# 允许 FDE 子网 → 宿主 :443（Traefik，host 网络）；按 fde_networks 每块精确 CIDR 生成
-A INPUT -s <FDE CIDR> -p tcp --dport 443 -j ACCEPT
# 拒绝 FDE 子网 → 宿主其它本地端口
-A INPUT -s <FDE CIDR> -j DROP
```

（等价地可用 `-i br-fde-*` 接口匹配；用 `-s <CIDR>` 更精确、天然覆盖 `/28` 与两池。）

**② DOCKER-USER 链（转发与 publish）**：

```
# 先放行已建立连接（容器出网 NAT 的回包等）
-A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# 拒绝 FDE 子网 → 其它 bridge / 宿主 publish 端口（publish 流量在 PREROUTING 已 DNAT，
# 到 FORWARD 时目的地址已被改写，故用 conntrack DNAT 匹配，而非 -d <宿主IP>）
-A DOCKER-USER -s <FDE CIDR> -m conntrack --ctstate DNAT -j DROP
```

- **不得阻断容器出网 NAT 与 DNS**：容器默认出网（MASQUERADE）与跨 bridge 直接转发已由 Docker 自身规则 / DOCKER-ISOLATION 处理；上面的规则只**额外收紧** FDE 子网的 publish/DNAT 路径，默认策略保持 RETURN（落回 Docker 规则）。容器 DNS 是 netns 内 `127.0.0.11`（Docker 内嵌 DNS），**不经宿主 INPUT**，天然不受影响；若某容器显式改用外部 resolver（如网关 `.1` 或公网 DNS），需在 INPUT 放行对应 UDP/TCP 53（否则保持 `127.0.0.11` 默认）。
- **规则持久化**：INPUT 链**不被 Docker 管理**（Docker 只管 FORWARD/DOCKER-USER 与 NAT 链）；DOCKER-USER 链在 Docker daemon 重启时会**重建并清空自定义规则**。两者都需在 **host 重启 / docker daemon reload 后重新应用**——用 systemd unit（`After=docker.service`）或 portal reconciler 启动钩子，从 `fde_networks` 全量生成并 `iptables-restore`/逐条下发。

**验收矩阵（目标环境实测，逐项打勾）**：

| 用例 | 期望 |
|---|---|
| FDE → 宿主 `:443`（Traefik） | ✅ 通 |
| FDE → 宿主 `:8080` / `:4000`（portal / LLM 网关数据面回环） | ❌ 拒 |
| FDE → 宿主 publish `gitea:3000` / `mssql:1433` / `portainer:9000` | ❌ 拒 |
| FDE → 互联网 HTTPS | 按安全团队出口策略（issue #3） |
| FDE → DNS | ✅（netns `127.0.0.11`；外部 resolver 按上文放行 53） |
| FDE A → FDE B | ❌（Docker 不转发跨 bridge，DOCKER-ISOLATION） |

## 6. 路径、命名与凭据注入参数

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 容器命名 | 项目前缀 + 组件名 | 平台规范固定（规格 §14 已定） | 本平台：`station-edge` / `station-portal` / `station-db`；FDE 容器：`fde-<name>`（如 `fde-alice`） |
| `DATA_ROOT` | 平台数据 bind mount 根目录，布局为 `<DATA_ROOT>/<名称>/` | 决策者/运维约定 | `/docker`（参考实例 A 的全机统一约定，见 §8.1）；如 `/docker/station-db/`（pg data）、`/docker/station-edge/`（traefik 动态配置/证书存储 acme.json） |
| `USER_SPACE_ROOT` | FDE 用户空间根，布局为 `<USER_SPACE_ROOT>/<fde>/`（宿主路径）；FDE 容器内映射 `/home/<user>`（见 [`design/user-space.md`](design/user-space.md) §2） | 路径结构平台规范固定；具体取值由决策者/运维提供 | `/srv/erix/users`（参考实例 A，见 §8.1）；如 `/srv/erix/users/alice/{home,projects,worktrees,cache}` |
| `FDE_CONTAINER_USER` / `FDE_HOME` | 容器内 FDE 用户名与 HOME（user-space.md §2.4；⚠️ 用户名固定 `erix` vs 按 FDE 名，倾向固定 `erix`） | 平台规范固定 | `erix` / `/home/erix` |
| `FDE_USER_UID` / `FDE_USER_GID` | FDE 工作区属主 UID/GID（工作区目录属主） | 平台规范固定（user-space.md §6） | `1000` / `1000` |
| `AGENTD_UID` / `WORKER_UID` | agentd（唯一持 per-container token）/ worker（每 run）的 UID；GID 同 `1000` | 平台规范固定（runner-integration §11.3 不同 UID 优先） | `1001` / `1002` |
| `PORTAL_RUNTIME_UID` | portal 容器运行身份 = materializer 物化写入身份（需 chown 工作区目录、写 Docker API） | 平台规范固定（user-space.md §6.1） | `0`（root） |
| `USER_SPACE_DIR_MODE` / `USER_SPACE_UMASK` | 工作区目录模式 / 容器进程 umask；平台文件权限固定 | 平台规范固定（user-space.md §6.2） | `2770` / `0002`（平台文件 `0644`，`manifest.json` `0444`） |
| `backend` / `fde-<name>` | **`backend` = 显式 `172.30.0.0/24`**（compose 声明，与 FDE 池彻底隔离）；`fde-<name>` 每 FDE 一条 `/29`；Traefik 走 host 网络（H-B 定稿，issue #5；~~`edge` / `control`~~ 已取消——共享 `control` 是横向越权根源）。**`10.200.0.0/16` 与 `10.201.0.0/16` 保留给 FDE 网络专用**，其它 compose/自动网络不得使用 | 平台规范固定（规格 §3/§5，topology.md §2） | `backend` 接 portal + station-db + LLM 网关；`fde-<name>` 只接该 FDE 的容器（`10.200.<n>.0/29`，大 FDE `/28` 见 §5.2） |
| 凭据存放 | 平台凭据（DB 密码、runner token、OIDC client secret、DNS-01 API token）一律环境变量或凭据文件注入（项目 AGENTS.md §6），不进仓库、不进 compose 正文 | 决策者/运维约定 | 参考实例 A：`~/.config/mcp/creds/`，权限 **600**（已实测存在，含 gitea、portainer、mssql 等凭据，见 §8.1）；或 `<DATA_ROOT>/<名称>/` 下 600 文件 |

凭据注入要点（平台规范固定，不随环境变化）：

- 用户空间 UID/GID/权限（`FDE_USER_UID=1000`、`AGENTD_UID=1001`、`WORKER_UID=1002`、目录 `2770`、umask `0002`、平台文件 `0644`）为**平台规范固定**，开发期与目标环境**无差异**（不随机器变化）；开发期仅 `USER_SPACE_ROOT` 可指向仓库内临时目录以隔离（结构不变）。完整契约见 [`design/user-space.md`](design/user-space.md) §6。

- LLM 虚拟 key **不进容器**（容器内零 LLM 凭据，仅占位 key + baseURL）：portal（经 reconciler）写宿主 Traefik 动态配置文件，权限 **600**、仅 portal 可写、Traefik 只读（H-B 定稿 D-4，issue #5；规格 §11，topology.md §6 第 8 条）。原「LLM key 经 `ERIX_API_KEY_FILE` 只读文件注入容器」**作废**
- `docker.sock` **只挂到 `station-docker-socket-proxy`**（不直挂 portal）；portal 经 `DOCKER_HOST=tcp://station-docker-socket-proxy:2375` 访问，白名单 `CONTAINERS=1`/`NETWORKS=1` + `POST=0`（P1 只读；`VOLUMES` 已删，bind mount 不需 volume API；创建参数 allowlist 见 deploy-contract §5）
- 超级用户口令（`POSTGRES_PASSWORD`）与两个角色口令（`PLATFORM_DB_PASSWORD`/`PORTAL_DB_PASSWORD`）部署时生成后存 `deploy/.env`（600）

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
| 8080 | 已被容器 `gitea_act_runner` 占用（host 网络，进程直接监听 `:::8080`，Go 服务：`http://127.0.0.1:8080/` 返回 `404 text/plain`） | portal（H-B：**publish `127.0.0.1:8080` 回环**，规格 §5） | ⚠️ **参考实例 A 上有冲突**：回环 8080 被占 → 该机部署需迁移占用者或改 portal publish 端口；目标环境按 §9 第 7 项重新核实 |
| 4000 | `ss -tlnp` 未见宿主监听（2026-05） | LLM 网关数据面（H-B：**publish `127.0.0.1:4000` 回环**；admin 面不发布） | 参考实例 A 上可用；目标环境按 §9 第 7 项重新核实 |
| 5432 | 已被容器 `postgresql` 占用（`0.0.0.0:5432->5432/tcp`） | station-db（**仅 `backend` 网络内**（H-B：`control` 已取消），不 publish 宿主机） | 无冲突——station-db 是独立 postgres 容器，只对 `backend` 网络暴露 5432，与宿主既有实例互不可见（同上） |

### 8.3 443 占用处理记录（参考实例 A 的候选方案）

> 🕓 **部署期事项（P1 开发不需要）**：开发期直接用 §0 的高端口，不碰 443（决策者 2026-09，issue #3 评论）。
>
> 以下为参考实例 A 上 443 冲突的具体处理选项，**仅参考实例 A**；通用要求与处理优先级见 §5.1。目标环境若有同类冲突，需按 §5.1 重新评估，且同样**不构成「P1 硬阻塞」级别的设计问题**——它只是部署前检查项之一。

按 §5.1 的优先级展开（参考实例 A 语境）：

1. **迁移 443 上的现有服务**（推荐）：占用者已定位为容器 `nginx_reverse_proxy`（映射 443、9001、9002，另有 8443 暴露未映射）。评估：把它的现有路由迁到 Traefik 之后（Traefik 作唯一 ingress，nginx 退为后端服务），或让其改听其他端口，然后 Traefik 按规格独占 443。（注意该 nginx 当前默认 vhost 返回 502，说明它是否仍在承载有效业务需先确认。）
2. **Traefik `websecure` 暂用 8443**：URL 带端口号（`https://station.erix.vip:8443`），仅作联调过渡；正式使用前必须回到方案 1。
3. ~~复用现有 443 反代，把 station/fde 域名转发给 Traefik~~：**不推荐**（理由见 §5.1）。

> 部署配置（`deploy/`）应把 Traefik 的 publish 端口做成变量（见 §10），使方案 1/2 切换只改一处。

## 9. 目标环境核实项 checklist（部署前必做）

> 运维/决策者在**目标环境**上逐项执行探测命令并填「实测值」列；填完即得到 §10 中所有「目标环境探测」类变量的取值。任何一项不满足期望值，先解决再继续部署。
>
> 🕓 **P1 本地开发期无需执行本表**（开发环境最小集见 §0）；其中第 6、10、11 项为纯**部署期事项**（决策者 2026-09，issue #3 评论），其余各项（Docker 版本、资源、路径可写等）在开发机上通常随手可查，亦不作 P1 阻塞。

| # | 核实项 | 探测命令 | 期望值 / 记录内容 | 对应参数 | 实测值 |
|---|---|---|---|---|---|
| 1 | Docker Server 版本 | `docker version --format '{{.Server.Version}}'` | 记录版本号 | §7 Docker 版本 | |
| 2 | 运维会话是否在 docker 组 | `docker ps`；若权限不足则 `sg docker -c 'docker ps'` | 可直连，或记录需 `sg docker -c` 绕过 | §7 运维会话注意 | |
| 3 | CPU 核数 | `nproc` | 记录核数 | §7 资源 | |
| 4 | 内存 | `free -h` | 记录总量/可用 | §7 资源 | |
| 5 | 磁盘 | `df -h /`；及 `df -h <DATA_ROOT> <USER_SPACE_ROOT>` | 按目标规模估算是否充裕 | §7 资源 / §6 路径 | |
| 6 | ingress 端口可用性（🕓 部署期事项，P1 开发无需执行） | `ss -tlnp \| grep -E ':(80\|443)\b'` | 80/443 无监听，或占用者已按 §5.1 评估 | §5 `TRAEFIK_WEB_PORT` / `TRAEFIK_WEBSECURE_PORT` | |
| 7 | 其他端口占用 | `ss -tlnp \| grep -E ':(8080\|4000\|5432)\b'` | portal publish `127.0.0.1:8080`、LLM 网关数据面 publish `127.0.0.1:4000`（回环，需宿主回环 8080/4000 空闲）；station-db 不 publish，理论上无冲突 | §5 | |
| 8 | Portainer 是否存在 | `docker ps --format '{{.Names}} {{.Ports}}' \| grep -i portainer` | 记录容器名/监听地址 | §7 Portainer | |
| 9 | 既有容器命名冲突 | `docker ps -a --format '{{.Names}}' \| grep -E '^(station-\|fde-)'` | 无输出，或冲突容器已评估 | §6 容器命名 | |
| 10 | 内网 DNS 泛解析（🕓 部署期事项，P1 开发无需执行） | `dig station.<base> @<内网DNS>`；`dig test.fde.<base> @<内网DNS>` | 两条均解析到宿主机内网 IP；不支持泛解析时走 §1 降级方案 | §1 DNS 泛解析 | |
| 11 | 公网 DNS zone 可 API 操作（🕓 部署期事项，P1 开发无需执行） | 决策者确认 DNS provider 及其 API 能力 | 支持则 DNS-01；不支持则内部 CA | §2 证书方式 | |
| 12 | 出口正向代理 | `env \| grep -i proxy`；`curl -sI --max-time 5 https://registry.npmjs.org/` | 无强制代理可直连；有代理则记录代理地址，影响 §3 egress 落地 | §3 正向代理 | |
| 13 | 路径可写 | `ls -ld <DATA_ROOT> <USER_SPACE_ROOT>`；不存在则 `mkdir -p` 验证 | 可创建且归属 docker 可写用户 | §6 路径 | |
| 14 | 安全团队出口策略已实施 | 与安全团队确认（非命令探测） | 记录：策略覆盖的网段 / 标识方式（IP、网络名、label）/ 白名单内容 / 负责人 | §3 出口管控 | |
| 15 | Docker 默认地址池已配置 | `docker info --format '{{json .DefaultAddressPools}}'` | 含 `10.200.0.0/16` size 29（§5.2）；未配置则改 daemon.json 并 reload（P1 开发机建议同步配置） | §5.2 地址池 | |
| 16 | `backend` 独立子网可用性 | `docker network ls` + 既有 bridge 子网核对（`docker network inspect` 或 `ip -4 addr show type bridge`） | `172.30.0.0/24` 与既有 bridge（如 `172.19/20/23/26/27/29/31`）及 FDE 池（`10.200/16`、`10.201/16`）无重叠 | §5.2 `backend` 子网 | |

## 10. deploy 变量一览（验收锚点）

`deploy/` 配置只需替换以下变量即可 `up -d`。每个变量的取值来源在本文 §1~§9 有唯一定义；「目标环境探测」类变量的实测值由 §9 checklist 产出。

| 变量 | 取值来源 | 示例值 |
|---|---|---|
| `BASE_DOMAIN` | 决策者提供（§1 ⚠️） | `erix.vip` |
| `PORTAL_HOST` | 平台规范固定 = `station.` + `BASE_DOMAIN`（§1） | `station.erix.vip` |
| `FDE_WILDCARD_HOST` | 平台规范固定 = `*.fde.` + `BASE_DOMAIN`（§1） | `*.fde.erix.vip` |
| `LLM_HOST` | 平台规范固定 = `llm.` + `BASE_DOMAIN`（§1；容器内 hosts 注入解析，不进 DNS，仅证书 SAN 用） | `llm.erix.vip` |
| `TRAEFIK_WEB_PORT` | 平台规范固定 + 目标环境探测可用性（§5/§9） | `80` |
| `TRAEFIK_WEBSECURE_PORT` | 平台规范固定 + 目标环境探测可用性（§5/§9） | `443`（冲突未解时 `8443`，见 §5.1/§8.3） |
| `BACKEND_SUBNET` | 平台规范固定（deploy-contract.md §2.1）；须避开宿主既有网段 | `172.30.0.0/24`（开发期本机为 `172.32.0.0/24`，见 §0） |
| `PORTAL_HOST_PORT` | 平台规范固定（portal publish 仅回环 `127.0.0.1`，容器内固定 8080） | `8080`（开发期本机为 `18080`，见 §0） |
| `ACME_EMAIL` | 决策者提供（§2 ⚠️） | 待填 |
| `DNS_PROVIDER` / DNS-01 API token | 决策者提供，凭据文件注入（§2 ⚠️ / §6） | 待填 |
| `DATA_ROOT` | 决策者/运维约定（§6） | `/docker` |
| `USER_SPACE_ROOT` | 结构平台规范固定，取值决策者/运维提供（§6） | `/srv/erix/users` |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | 超级用户（bootstrap）身份；部署时生成，`POSTGRES_PASSWORD` 存 **600 权限 `deploy/.env`**（§6），⚠️ 必须改 | `station` / — / `station` |
| `PLATFORM_DB_USER` / `PLATFORM_DB_PASSWORD` | 迁移身份（DDL/表 owner）；口令存 **600 权限 `deploy/.env`**（§6），⚠️ 必须改 | `station_platform` / — |
| `PORTAL_DB_USER` / `PORTAL_DB_PASSWORD` | 运行时身份（最小 DML GRANT）；口令存 **600 权限 `deploy/.env`**（§6），⚠️ 必须改 | `station_portal` / — |
| `PORTAL_IMAGE` | 平台规范固定（规格 §14）；自构建（build context `portal/`） | `erix-station/portal:<git-sha>`（不可变 tag；部署时再 `docker inspect --format '{{.Id}}'` 记 digest） |
| `DB_IMAGE` | 平台规范固定（规格 §14）；官方镜像 | `postgres:16`；生产必须 pin 到 `postgres:16.<patch>` **再 pin digest**（⚠️ 具体 patch/digest 部署时由 §9 产出后填；P1 开发可临时 `postgres:16` 并记录 resolved digest） |
| `TRAEFIK_IMAGE` | 平台规范固定（规格 §14）；官方镜像 | `traefik:v3`；生产必须 pin 到 `traefik:v3.<minor>.<patch>` **再 pin digest**（⚠️ 同上；P1 开发可临时 `traefik:v3` 并记录 resolved digest） |
| `SOCKET_PROXY_IMAGE` | 平台规范固定（规格 §4 / §6 / deploy-contract §5） | `tecnativa/docker-socket-proxy:v0.5.0`（P1 开发 pin patch tag；生产再 pin digest；`POST=0` 只读） |
| `FDE_IMAGE` | 平台规范固定（规格 §12/§14）；自构建（build context `runner/`） | `erix-station/fde:<erix-agent 版本>-<git-sha>`（不可变 tag；版本记录点 `containers.agent_version`） |
| `COOKIE_PROFILE` | 平台规范固定（portal.md §2.5 已声明的同步点，本节落地） | `prod`（→ `__Host-fde_session` + `Secure=true`）\| `dev-http`（→ `fde_session_dev` + `Secure=false`，**仅限本机 HTTP 联调，禁止进部署配置**） |
| `FIREWALL_ENABLED` | 平台规范固定（topology.md §6.1 / deploy-contract.md） | `1`（生产恒 `1`；`0` 仅限无其它宿主服务的隔离开发机——关闭即放弃「FDE→宿主其它端口」收紧） |
| `TRAEFIK_CONFIG_DIR` | 平台规范固定（deploy-contract.md；由 `DATA_ROOT` 派生） | `/docker/station-edge/`（静态 `traefik.yml` + `dynamic/` 目录 + `acme.json` + `logs/` + `firewall/` 规则文件） |
| `FIREWALL_RULES_PATH` | 平台规范固定（deploy-contract.md；由 `TRAEFIK_CONFIG_DIR` 派生） | `/docker/station-edge/firewall/`（规则文件 `rules.v4`，权限 **600**） |
| `DB_DATA_DIR` | 平台规范固定（由 `DATA_ROOT` 派生） | `/docker/station-db/`（pg data；见 §6） |

> **口令必须改 + 600 权限存放**：`POSTGRES_PASSWORD` / `PLATFORM_DB_PASSWORD` / `PORTAL_DB_PASSWORD` 在生产环境必须把 `change-me-dev-only` 占位全部改掉，并以 **600 权限 `deploy/.env`** 存放（不入库、不进 compose 正文、不进镜像，见 deploy-contract §2.4）。
>
> **镜像 pin 策略（deploy-contract.md §2 的完整契约，此处只记取值口径）**：`deploy/` 内的 compose/镜像引用**不得使用浮动 tag**（`latest` / 裸 `:16` / 裸 `:v3`）。生产部署对每个镜像最终以 **digest**（`image@sha256:…`）锁定；P1 开发期可暂用 `<major>.<minor>` 类 tag，但必须在 `docker inspect` 后把 resolved digest 记录进部署记录（env 附录 B / runbook）。`⚠️ 待决策者确认`：`postgres:16` / `traefik:v3` 的具体 patch 号与 digest 是部署期事实，本文不虚构；P1 开发按 §0 即可，目标环境按 §9 探测后再 pin。
>
> 宿主机内网 IP（DNS A 记录目标）在部署时由运维填入 DNS，不进入 compose 变量。

---

## 11. P1 运行时参数表（超时 / 背压 / 时间权威 / 日志）

> 本节是 **P1 运行时契约**的取值锚点：把散落在规格 / runner-integration / topology 里的超时与资源参数收敛到一处，并补上「DB 超时 / 时间权威 / 日志轮转」三块此前缺失的运行时事实。**配置来源**指向实现时读取的环境变量或服务参数；实现未到位的参数按「当前倾向」取值并标注 `⚠️ 待决策者确认`。

### 11.1 超时 / 心跳 / 租约 / 背压参数

| 参数 | 默认值 | 单位 | 上限 | 配置来源 | 超时/错误表现 | 监控指标 |
|---|---|---|---|---|---|---|
| SSE（portal→浏览器）路由 read/write timeout | ≥ 300 | s | 无（长连接） | Traefik 动态配置（portal reconciler 生成；topology §6 第 10 条「路由 read/write timeout ≥ 5min；SSE 禁缓冲」） | 断连 → 浏览器 `EventSource` 按 `retry: 3000` 自动重连 + `Last-Event-ID` 补发 | SSE 连接数、断线重连率、补发事件数 |
| SSE（portal→浏览器）心跳注释行 | 15 | s | — | portal（portal.md §5.1 `: ping`） | 连续 3 个周期无心跳 → 客户端判死重连 | 心跳丢失数 |
| SSE（agentd→portal `/api/internal/stream`）重连退避 | 1→2→5→10→30 封顶 | s | 30 | agentd（runner §4.3/§4.5） | 断开按指数退避重连 | agentd 下行健康、重连次数 |
| claim 长轮询 `hold_ms` | 30 | s | **30（硬上限）** | agentd 请求参数（runner §4.2 U1） | hold 超时无任务 → `204`，agentd 立即再 claim | claim 空转率、hold 命中率 |
| 租约 `lease` | 90 | s | — | portal（schema.sql `run_queue` 认领 SQL，`now()+interval '90 seconds'`） | 到期未续 → 允许 re-claim（旧写 `lease_lost`） | lease 过期/易主次数 |
| 心跳间隔 / 判死阈值 | 15 / 45 | s | — | agentd（runner §4.2 U4） | 连续 3 次丢失（45s）→ `containers.status` 视 `exited` | `containers.last_heartbeat` 延迟、判死次数 |
| 审批轮询兜底 / 审批超时 | 5 / 600 | s | — | agentd（runner §10.1） | 10min 无决定 → 按 denied 继续（审批单留 `pending`） | 审批 pending 时长、超时数 |
| store adapter checkpoint 重试 | 3 次（1s→2s→5s） | 次 / s | 3 | worker（runner §9.2） | 耗尽 → `checkpoint_failed` → run `failed` | checkpoint 重试率、`checkpoint_failed` 数 |
| 事件批量窗口 | 250ms 或 2KB 先到 | ms / KB | 单批 200 条 / 256KB | agentd（runner §7.2） | — | 批次大小、批间隔、端到端延迟 |
| 背压（worker / agentd 内存队列） | 10000 条/4MB；20000 条/8MB | 条 / MB | 见左 | worker / agentd（runner §7.4） | 超限落 spool；spool 也满 → run `spool_full` | 队列深度、spool 用量 |
| spool 配额 | 每 run 256MB / 每容器 1GB | MB | 见左 | agentd（runner §7.5） | 写满 → 事件不静默丢，显式 `spool_full` run 失败 | spool 磁盘占用 |
| agentd 并发 `capacity` | 4 | run | 4 | agentd claim 上报（runner §13） | portal 不超发 | 并发 run 数 |
| portal HTTP 慢客户端防护 | 请求头 10s / 请求体 30s / keep-alive 60s | s | — | portal 服务器配置（技术栈 Q7 ⚠️，语义与栈无关） | 超时断连；连接数超限 → 排队 / `503` | 慢客户端断开数 |
| portal 最大并发连接数 | 1024 | 连接 | — | portal 服务器配置 | 超限排队或 `503 rate_limited` | 峰值连接数 |

> 上表中带 `⚠️` 语义的参数（capacity、背压阈值、spool 配额等）沿用 runner-integration.md §15 的当前倾向取值，**未新造数值**；实现前由决策者按 §9/runbook 复核。

### 11.2 DB 运行时参数（连接池 / statement / lock 超时）

> 中心 DB 是全平台单点（规格 §14）；以下参数是「DB 抖动不把慢查询/死锁放大成平台级故障」的 P1 基线。**DB 侧**参数以 `station_portal` 运行时角色（model.md §3）在 `ALTER ROLE ... SET` 或每连接 `SET` 下发；**portal 侧**连接池参数在 portal 配置下发。

| 参数 | 默认值 | 单位 | 上限 | 配置来源 | 超时/错误表现 | 监控指标 |
|---|---|---|---|---|---|---|
| portal → DB 连接池大小 | 20 | 连接 | 与 DB `max_connections` 匹配（默认 100，预留运维连接） | portal 配置 | 池耗尽 → 等待队列 / 请求 `503`；internal 通道 5xx 由 agentd 无限退避重试兜底（runner §4.5） | 池使用率、等待时长 |
| DB `statement_timeout` | 30 | s | — | `ALTER ROLE station_portal SET statement_timeout`（或每连接） | 超时 → `57014 query_canceled` → 该事务失败回滚 → portal `5xx`（可重试） | 慢查询数、被取消查询数 |
| DB `lock_timeout` | 10 | s | — | 同上 | 等锁超时 → `55P03 lock_not_available` → 事务回滚（不阻塞死等） | 锁等待次数、锁等待时长 |
| DB `idle_in_transaction_session_timeout` | 60 | s | — | 同上 | 超时 → 会话被终止（`25P03` / 连接断开）→ 应用层重试 | 空闲事务会话数、被终止会话数 |
| DB `max_connections` | 100 | 连接 | 按内存/规模评估 | postgres 容器参数（`postgresql.conf` / command） | 超限 → 新连接拒绝（`53300 too_many_connections`） | 连接数 / 上限 |

### 11.3 时间权威来源（统一口径）

- **所有平台时间戳一律 UTC**（ISO 8601 `…Z`；schema.sql 全部 `timestamptz`，portal.md §0）。
- **权威时钟 = DB `now()`**（station-db 的 PostgreSQL 时钟）：portal 落库的 `seq` 分配、`created_at` / `lease_until` / `released_at` / `claimed_at` 等一律以 DB `now()`（`DEFAULT now()` 已落 schema.sql）为准；租约、reaper、对账、记账（`day` 按 UTC 日历日）全部以 DB 时钟为准。
- **worker/agentd 上报的事件 `ts` 仅作展示**：它记录「事件在容器内产生的时刻」，**不参与** seq 排序、租约判定、reaper、对账。权威时序恒为 DB 侧 `now()` 分配的 `seq` / 时间列。
- **时钟漂移对账**：reconciler/定时任务比对「宿主时钟 ↔ DB 时钟 ↔ 容器上报 `ts`」的漂移，超阈值（如 30s）告警（告警通道为 P2 延后事项，但状态落库可查）。

### 11.4 日志位置与轮转

| 组件 | 位置 | 轮转 |
|---|---|---|
| portal | `docker logs station-portal`（json-file driver） | docker json-file `max-size` + `max-file`（如 `10m` / `3`） |
| station-db | `docker logs station-db`（postgres 默认 stderr） | 同上 |
| Traefik | access log → `/docker/station-edge/logs/`（文件）+ 容器 stdout | 文件由 host `logrotate` 轮转（`daily` + `compress` + `rotate 7`）；stdout 由 docker json-file |
| socket-proxy | `docker logs station-docker-socket-proxy` | json-file `max-size`/`max-file` |
| FDE 容器（agentd/worker） | `docker logs fde-<name>`（agentd 单行 JSON 统一输出，runner §14） | 同上 |
| 排障真相 | 事件/工具调用/judge/审批/用量/审计在 DB（原理三），日志只是**原始**记录、**不作审计依据**（topology §5.2） | — |

> 日志轮转的 `max-size`/`max-file` 与 `logrotate` 周期为运维约定（⚠️ 待决策者确认具体数值）；本文只定「位置 + 必须轮转 + 日志≠审计」三点，不虚构轮转数值。docker daemon 级 `log-driver`/`log-opts` 由 `deploy/` 的 daemon.json 或 compose `logging:` 段设置（deploy-contract.md §2）。

---

## 附录 A：⚠️ 待决策者确认清单（设计侧）

> 设计侧问题：与环境无关，需要决策者拍板；不定则对应 deploy 变量无法最终定值。

| # | 事项 | 当前倾向 | 阻塞 |
|---|---|---|---|
| 1 | base domain = `erix.vip` | 与 git.erix.vip 同域 | deploy 变量 |
| 2 | 证书 = Let's Encrypt DNS-01（🕓 部署期事项，P1 开发不需要） | 需 erix.vip zone 可 API 操作；否则内部 CA | P1 TLS（部署期；开发期自签/http，见 §0） |
| 3 | 平台 VPN-only（🕓 部署期事项，P1 开发不需要） | 是 | 安全模型（部署期） |
| 4 | 出口无强制正向代理 | 按「无」设计；若有，影响安全团队 egress 策略的落地方式与 LLM 网关上游连通性（§3） | 部署前确认 |
| 4a | （已移出本清单）出口管控不再是设计侧待确认项：已定外部依赖（安全团队），作为部署前置条件见 §9 第 14 项（issue #3） | — | — |
| 5 | 端口冲突时的处理方案选择（若目标环境 443 被占用）（🕓 部署期事项，P1 开发不需要） | 方案 1（迁移占用者）；过渡期方案 2（8443），见 §5.1 | 部署前检查项，**非设计硬阻塞** |
| 6 | SSO provider 事实（issuer/client/group claim） | P1 先本地账号 + TOTP | P2 前必须确认 |
| 7 | ACME_EMAIL / DNS provider token | 决策者提供 | deploy 变量 |

## 附录 B：⚠️ 目标环境待探测清单（环境侧）

> 环境侧问题：答案因目标环境而异，必须在目标环境上实测（命令见 §9）；参考实例 A 的实测值（§8）只是示例。
>
> 🕓 第 1、4 项为**部署期事项（P1 开发不需要）**，开发期按 §0 执行即可（决策者 2026-09，issue #3 评论）。

| # | 事项 | 探测方式 | 对应参数 |
|---|---|---|---|
| 1 | ingress 端口（80/443）可用性（🕓 部署期事项） | §9 第 6 项 | `TRAEFIK_WEB_PORT` / `TRAEFIK_WEBSECURE_PORT` |
| 2 | Docker / Portainer 版本与存在性 | §9 第 1、8 项 | §7 |
| 3 | CPU / 内存 / 磁盘资源 | §9 第 3~5 项 | §7 容量评估 |
| 4 | 内网 DNS 泛解析支持（🕓 部署期事项） | §9 第 10 项 | §1 DNS 泛解析 |
| 5 | 出口是否存在强制正向代理 | §9 第 12 项 | §3 正向代理 |
| 6 | `DATA_ROOT` / `USER_SPACE_ROOT` 路径可写 | §9 第 5、13 项 | §6 路径 |
