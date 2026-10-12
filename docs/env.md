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
| 用户空间根 / 动态配置目录 | 开发期**可注入临时目录隔离**：`ERIX_USERSPACE_ROOT_HOST`（宿主用户空间根，默认 `/srv/erix/users`）与 `TRAEFIK_DYNAMIC_DIR_HOST`（Traefik 动态配置宿主目录，默认 `./traefik/dynamic`）——两者都**建议 0755**（portal 虽回加了 `CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID`（deploy-contract §1），开发期临时目录仍避免依赖特权位；station-docker-proxy 以 gid 1000 穿越目录（deploy-contract §5.1）；`mktemp -d` 默认 0700 需先 chmod） |
| backend 子网 | **`172.32.0.0/24`**（本机 `172.30.0.0/16` 已被运行中的 `voiceprint_default` 占用（`br-8e3857476b83` / `172.30.0.1`）→ 开发期 `backend` 用 `172.32.0.0/24`，`BACKEND_SUBNET=172.32.0.0/24`；部署期规范值仍为 §5.2 的 `172.30.0.0/24`，由 `BACKEND_SUBNET` 覆盖） |
| socket-proxy | 开发期**同样启用**：`station-docker-proxy` 单独挂 `/var/run/docker.sock`（RO），portal 经 `DOCKER_HOST=tcp://station-docker-proxy:2375` 访问 Docker API（不直挂 socket）；白名单见 deploy-contract §5.1（自研 admission proxy：方法+路径白名单 12 条 + create 参数级校验；**不再用** tecnativa 类别级 env 门） |
| DB 首次初始化 | 由 `deploy/db-init/00-init.sh` 在 `station-db` **首次启动（空数据目录）**时以超级用户完成一次：`schema.sql`（baseline）→ 设两角色口令 → 回填 baseline checksum → `bootstrap.sql`（授权 + ownership 归正）→ 收紧跨库 CONNECT；**开发期同样**。增量迁移（`deploy/migrations/*.sql`）**由 portal 自己跑**：`MIGRATE_ON_START=1`（compose 显式值），portal 在监听端口前应用（§10） |
| 域名 | **开发期已使用真实泛解析域名（2026-10-08 定稿，issue #57）**：`*.fde.erix.vip` 泛解析 → 宿主机 Tailscale IP `100.100.0.3`（比 DHCP LAN IP 稳定），浏览器/playwright/FDE 均可达；入口带端口 `:8090`（dev Traefik 不在 80/443）。`/etc/hosts` 逐条与 `*.localhost` 变通**降级为历史兜底**（仅本机无 DNS 可用时），不再是主路径。⚠️ 容器内解析与宿主无关：`station.<伞域>` / `llm.<伞域>` 恒走创建容器时注入的 hosts 映射（`--add-host` → 该 FDE 的 bridge 网关 IP，见本节末注与 §1），不依赖外部 DNS |
| TLS | 自签证书，或直接 http 联调（当前 dev 采用 **http**：cookie 无 `Secure`，预览 URL 按 http 生成；升 https 时同步 `PORTAL_PUBLIC_BASE_URL`，见 §2 与验收清单） |
| 证书方式 / DNS-01 / VPN-only / 公网可达性 / 443 冲突处理 | **一律部署期再管**（见 §2/§3/§5.1/§8.3 的「部署期事项」标注） |

> **容器内域名解析（开发期同样适用）**：FDE 容器内 `station-agentd` 访问 `station.<伞域>`、worker 访问 `llm.<伞域>` 都走 HTTPS 到 Traefik（伞域命名与平台规范同构，与 dev/prod 无关；端口按 §0 表，生产 443）。容器内解析**与宿主 DNS/`/etc/hosts` 无关**：创建 FDE 容器时注入 `--add-host station.<伞域>:<该 FDE 网关 IP>` + `--add-host llm.<伞域>:<该 FDE 网关 IP>`（默认池 `10.200.<n>.1`；大 FDE `10.201.<n>.1`；H-B，topology.md §4-L3/L7）。**ExtraHosts 在容器创建时定死**：切换 `BASE_DOMAIN` 后必须重建既有 FDE 容器才改到新域名。开发期自签/缺证书下 agentd 走 `rejectUnauthorized:false`（生产换系统信任，见 topology.md §4）。

**上线验收清单（切伞域上线前按序过一遍，每项都要真跑；#57 阶段2 实测记录见 issue #57）**

- [ ] 前置：`*.fde.erix.vip` 泛解析已配（§0 DNS 行 ✅）；`deploy/.env` 三项改齐（BASE_DOMAIN / PORTAL_HOST / PORTAL_PUBLIC_BASE_URL）；重建 portal + force-create edge + **重建 FDE 容器**（ExtraHosts 创建时定，见上注）；清 dev 旧 `*.fde.localhost` 分配记录
- [ ] 浏览器（无 hosts 条目）`http://station.fde.erix.vip:8090` 登录成功；工作台正常
- [ ] 签发预览票据 → URL = `http://<fde>-p-<port>.fde.erix.vip:8090?preview_ticket=…`（scheme/端口随公开入口）；兑换 302 的 Location 保留端口；Set-Cookie 为 host-only（无 Domain 属性）
- [ ] 预览页渲染容器 dev server 内容；cookie 复访免票；无凭证直访 → 403 `preview_ticket_required`（fail-closed）
- [ ] https 变体：☑ dev 实测 8443 可达但路由暂只挂 `web` 入口（P4 现状，伞域 8443 暂 404，非回归）——生产接 ACME 时同批挂 websecure，本项随生产验证

---

## 1. 域名与 DNS 参数

> 本节域名规则采用**伞域**语义（2026-10-08 定稿，issue #57）：`BASE_DOMAIN` = 伞域 `fde.<registrable domain>`，portal / LLM / 预览全部直接挂在伞域下、由**同一条**泛解析 `*.fde.erix.vip` 覆盖——「DNS 泛解析是部署期事项（P1 开发不需要）」的旧口径已废：**开发期即使用真域名**（2026-10-08 已配，见下表 DNS 行），dev 与生产同一代码路径（URL 的 scheme/端口按公开入口生成）。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| `BASE_DOMAIN` | **伞域** = `fde.` + registrable domain；portal/LLM/预览的公共后缀（#57 定稿，旧语义「可注册域」作废） | 决策者定稿（2026-10-08） | `fde.erix.vip` |
| `PORTAL_HOST` | portal 域名 = `station.` + 伞域 | 平台规范固定（规格 §6.3） | `station.fde.erix.vip` |
| `FDE_WILDCARD_HOST` | 预览泛域名 = `*.<伞域>`（伞域名恰含 `fde`，不再额外拼 `.fde.` 段——`buildHostname` 的 `.fde.` 硬编码已随 #57 拆除）；必须与 portal 同 registrable domain，否则 SameSite 打死 iframe | 平台规范固定（规格 §6.3） | `*.fde.erix.vip`（#246 号池后的实际形态如 `eric-p-22000.fde.erix.vip`，grammar=`<fde>-p-<portLabel>.<伞域>`） |
| DNS 泛解析 | ✅ **已配置（2026-10-08）**：一条 A 记录 `*.fde.erix.vip → 100.100.0.3`（宿主机 Tailscale IP）即覆盖 portal/llm/预览全部名字（`*.` 不覆盖裸域，平台无服务落裸域）。原「两条内网 A 记录 + 部署期事项」口径作废；解析器负缓存（路由器 dnsmasq 负 TTL）为唯一已知 dev 期坑，公共 DNS 正常 | 已落地 | 全球生效实测（权威 NS/阿里/Google 一致） |
| `llm.<伞域>`（LLM 数据面域名） | 解析双通道：容器内恒用 hosts 注入（`--add-host llm.<伞域>:<该 FDE 网关 IP>`）解析到 Traefik，**不依赖 DNS**（机制不变）；伞域收敛后该名字（`llm.fde.erix.vip`）也**顺带被 `*.fde.erix.vip` 泛解析覆盖**（浏览器偶访可达，dev http 下够用），无需单独 A 记录 | 平台规范固定（topology.md §4-L7，H-B） | `llm.fde.erix.vip` |
| 代码托管（git host） | **git host 中立**：GitHub / Gitea / 其他自托管均可，平台不假设具体 git host；平台不代为 clone。Git 凭据可由 FDE 自行配置，或由 admin 通过 portal 凭据端点 write-through 到用户空间文件（见 `design/user-space.md` §4.1.1） | 决策者提供 | `git.erix.vip`（内网自托管 Gitea——**仅为参考实例 A 的情况**，见 §8.1，非设计约束） |

## 2. 证书参数

> 🕓 **本节整体为部署期事项（P1 开发不需要）**：开发期 TLS 自签或直接 http，见 §0（决策者 2026-09，issue #3 评论）。

| 参数 | 语义 | 取值来源 | 示例值 |
|---|---|---|---|
| 证书方式 | 预览域名是泛域名，HTTP-01 无法签泛域名证书；DNS-01 是唯一免费方案。**伞域收敛后 SAN 简化为一张通配 `*.fde.erix.vip`**——`station.*`/`llm.*`/全部预览都落在同一单标签覆盖内（旧三条 SAN `station.<base>`+`*.fde.<base>`+`llm.<base>` 并集口径作废，#57）；所有 router 统一 `tls.domains=[{main:"*.fde.erix.vip"}]` 共享同一张证，规避 per-host 签发限速 | 决策者定稿方向（2026-10-08） | **Let's Encrypt DNS-01**（SAN=`*.fde.erix.vip`）。前提：`erix.vip` zone 可 API 操作（DNSPod，已确认 NS）；DNS-01 纯出站，**与 A 记录指向无关**（100.100.0.3 不影响签发/续期）。**降级方案**：zone 不可 API 操作时改内部 CA（自签根下发到设备）；自签仅作本地兜底 |
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
| LiteLLM 数据面/管理面 | `station-litellm` 仅在 `litellm` profile 启动；宿主只发布到 `127.0.0.1`，默认端口由 `LITELLM_HOST_PORT` 控制。Traefik 通过 `LLM_GATEWAY_HOST` 访问；portal 容器内 AI-title 使用 `LLM_GATEWAY_ADMIN_URL`（backend 地址） | 平台规范固定 + 目标环境探测 | `127.0.0.1:4100`（默认） |
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
| FDE → 宿主 portal / LLM 网关回环发布端口 | ❌ 拒 |
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
| `ERIX_USERSPACE_ROOT` | portal 运行时读写的用户空间根（**容器内路径**，=`USER_SPACE_ROOT` 的 portal 运行时名；compose 以 `ERIX_USERSPACE_ROOT_HOST` 挂到该路径） | 平台规范固定 | `/srv/erix/users` |
| `FDE_USER_UID` / `FDE_USER_GID` | FDE 工作区属主 UID/GID（工作区目录属主） | 平台规范固定（user-space.md §6） | `1000` / `1000` |
| `AGENTD_UID` / `WORKER_UID` | agentd（唯一持 per-container token）/ worker（每 run）的 UID；GID 同 `1000` | 平台规范固定（runner-integration §11.3 不同 UID 优先） | `1001` / `1002` |
| `PORTAL_RUNTIME_UID` | portal 容器运行身份 = materializer 物化写入身份（需 chown 工作区目录、写 Docker API） | 平台规范固定（user-space.md §6.1） | `0`（root） |
| `USER_SPACE_DIR_MODE` / `USER_SPACE_UMASK` | 工作区目录模式 / 容器进程 umask；平台文件权限固定 | 平台规范固定（user-space.md §6.2） | `2770` / `0002`（平台文件 `0644`，`manifest.json` `0444`） |
| `backend` / `fde-<name>` | **`backend` = 显式 `172.30.0.0/24`**（compose 声明，与 FDE 池彻底隔离）；`fde-<name>` 每 FDE 一条 `/29`；Traefik 走 host 网络（H-B 定稿，issue #5；~~`edge` / `control`~~ 已取消——共享 `control` 是横向越权根源）。**`10.200.0.0/16` 与 `10.201.0.0/16` 保留给 FDE 网络专用**，其它 compose/自动网络不得使用 | 平台规范固定（规格 §3/§5，topology.md §2） | `backend` 接 portal + station-db + LLM 网关；`fde-<name>` 只接该 FDE 的容器（`10.200.<n>.0/29`，大 FDE `/28` 见 §5.2） |
| 凭据存放 | 平台凭据（DB 密码、runner token、OIDC client secret、DNS-01 API token）一律环境变量或凭据文件注入（项目 AGENTS.md §6），不进仓库、不进 compose 正文 | 决策者/运维约定 | 参考实例 A：`~/.config/mcp/creds/`，权限 **600**（已实测存在，含 gitea、portainer、mssql 等凭据，见 §8.1）；或 `<DATA_ROOT>/<名称>/` 下 600 文件 |

凭据注入要点（平台规范固定，不随环境变化）：

- 用户空间 UID/GID/权限（`FDE_USER_UID=1000`、`AGENTD_UID=1001`、`WORKER_UID=1002`、目录 `2770`、umask `0002`、平台文件 `0644`）为**平台规范固定**，开发期与目标环境**无差异**（不随机器变化）；开发期仅 `USER_SPACE_ROOT` 可指向仓库内临时目录以隔离（结构不变）。完整契约见 [`design/user-space.md`](design/user-space.md) §6。

- LLM 虚拟 key **不进容器**（容器内零 LLM 凭据，仅占位 key + endpoint：portal（经 reconciler）写宿主 Traefik 动态配置文件，权限 **600**、仅 portal 可写、Traefik 只读（H-B 定稿 D-4，issue #5；规格 §11，topology.md §6 第 8 条）。原「LLM key 经 `ERIX_API_KEY_FILE` 只读文件注入容器」**作废**
- `docker.sock` **只挂到 `station-docker-proxy`**（不直挂 portal）；portal 经 `DOCKER_HOST=tcp://station-docker-proxy:2375` 访问，路径白名单见 deploy-contract §5.1（自研 admission proxy：12 条契约路径 + create 参数级校验；`VOLUMES` 不授，bind mount 不需 volume API）
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
| 4100 | `ss -tlnp` 未见宿主监听（2026-05） | LiteLLM data plane/admin plane（`LITELLM_HOST_PORT` 默认值；**publish `127.0.0.1:4100` 回环**） | 参考实例 A 上可用；目标环境按 §9 第 7 项重新核实 |
| 5432 | 已被容器 `postgresql` 占用（`0.0.0.0:5432->5432/tcp`） | station-db（**仅 `backend` 网络内**（H-B：`control` 已取消），不 publish 宿主机） | 无冲突——station-db 是独立 postgres 容器，只对 `backend` 网络暴露 5432，与宿主既有实例互不可见（同上） |

### 8.3 443 占用处理记录（参考实例 A 的候选方案）

> 🕓 **部署期事项（P1 开发不需要）**：开发期直接用 §0 的高端口，不碰 443（决策者 2026-09，issue #3 评论）。
>
> 以下为参考实例 A 上 443 冲突的具体处理选项，**仅参考实例 A**；通用要求与处理优先级见 §5.1。目标环境若有同类冲突，需按 §5.1 重新评估，且同样**不构成「P1 硬阻塞」级别的设计问题**——它只是部署前检查项之一。

按 §5.1 的优先级展开（参考实例 A 语境）：

1. **迁移 443 上的现有服务**（推荐）：占用者已定位为容器 `nginx_reverse_proxy`（映射 443、9001、9002，另有 8443 暴露未映射）。评估：把它的现有路由迁到 Traefik 之后（Traefik 作唯一 ingress，nginx 退为后端服务），或让其改听其他端口，然后 Traefik 按规格独占 443。（注意该 nginx 当前默认 vhost 返回 502，说明它是否仍在承载有效业务需先确认。）
2. **Traefik `websecure` 暂用 8443**：URL 带端口号（`https://station.fde.erix.vip:8443`），仅作联调过渡；正式使用前必须回到方案 1。
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
| 7 | 其他端口占用 | `ss -tlnp \| grep -E ':(8080\|4100\|5432)\b'` | portal publish `127.0.0.1:8080`、LiteLLM `127.0.0.1:${LITELLM_HOST_PORT:-4100}`（回环，需对应端口空闲）；station-db 不 publish，理论上无冲突 | §5 | |
| 8 | Portainer 是否存在 | `docker ps --format '{{.Names}} {{.Ports}}' \| grep -i portainer` | 记录容器名/监听地址 | §7 Portainer | |
| 9 | 既有容器命名冲突 | `docker ps -a --format '{{.Names}}' \| grep -E '^(station-\|fde-)'` | 无输出，或冲突容器已评估 | §6 容器命名 | |
| 10 | DNS 泛解析（✅ 已配，2026-10-08 #57：`*.fde.erix.vip → 100.100.0.3`） | `dig test-9527.fde.erix.vip`（任意子名）；异常时对照 `dig … @223.5.5.5` 区分本地/路由器负缓存 | 解析到 100.100.0.3；若仅本机解析不出而公共 DNS 正常，是递归解析器负缓存，等 TTL 或重启路由器 dnsmasq | §1 DNS 泛解析 | |
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
| `BASE_DOMAIN` | 伞域，决策者定稿（§1，#57） | `fde.erix.vip` |
| `PORTAL_HOST` | 平台规范固定 = `station.` + `BASE_DOMAIN`（§1） | `station.fde.erix.vip` |
| `PORTAL_INTERNAL_HOSTS` | internal API router 的额外 Host（逗号分隔；只接受合法 hostname 或 IPv4，不改变 portal UI Host） | 空（仅匹配 `PORTAL_HOST`） |
| `FDE_WILDCARD_HOST` | 平台规范固定 = `*.fde.` + `BASE_DOMAIN`（§1） | `*.fde.erix.vip` |
| `LLM_HOST` | 平台规范固定 = `llm.` + `BASE_DOMAIN`（§1；容器内 hosts 注入解析为主、不依赖 DNS；伞域下顺带被泛解析覆盖） | `llm.fde.erix.vip` |
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
| `MIGRATE_ON_START` | 是否由 portal 在**监听端口前**自动应用增量迁移（`deploy/migrations/*.sql`，身份 `station_platform`）；compose 显式置 **`1`**——P1 单实例平台自动迁移安全，避免「部署后忘跑迁移 → 表缺失」（deploy-contract §3.1） | `1`（单实例）；⚠️ **多实例部署必须置 `0` 并外部跑一次 `node portal/src/cli.js migrate`**（并发 DDL/发布风险不上启动路径） |
| `PORTAL_IMAGE` | 平台规范固定（规格 §14）；自构建（build context `portal/`） | `erix-station/portal:<git-sha>`（不可变 tag；部署时再 `docker inspect --format '{{.Id}}'` 记 digest） |
| `POSTGRES_IMAGE` | 平台规范固定（规格 §14）；官方镜像（compose 变量名 `POSTGRES_IMAGE`） | `postgres:16.15`；生产必须 pin 到 `postgres:16.<patch>` **再 pin digest**（⚠️ 具体值部署时由 §9 产出后填） |
| `TRAEFIK_IMAGE` | 平台规范固定（规格 §14）；官方镜像 | `traefik:v3`；生产必须 pin 到 `traefik:v3.<minor>.<patch>` **再 pin digest**（⚠️ 同上；P1 开发可临时 `traefik:v3` 并记录 resolved digest） |
| `STATION_DOCKER_PROXY_IMAGE` | 平台规范固定（deploy-contract §5.1）；自构建（build context `deploy/fde-proxy/`） | `erix-station/fde-proxy:<git-sha>`（自研 admission proxy；tecnativa/docker-socket-proxy 方案已废弃）；dev 默认 `:local`，compose 插值可 env 覆盖（issue #27） |
| `FDE_IMAGE` | 平台规范固定（规格 §12/§14）；自构建（build context `runner/`） | `erix-station/fde:<erix-agent 版本>-<git-sha>`（不可变 tag；版本记录点 `containers.agent_version`）；**WP2b 开发期默认 `traefik/whoami`（轻量站台，可配置）**；生产 pin 双轨见下方「镜像 pin 策略」+ issue #27（B 档语言矩阵：Node/Python/.NET/Playwright，实测 2.29GB） |
| `FDE_CMD` | 平台规范固定（FDE 容器命令；开发期 whoami 站台用，生产为 `station-agentd` 入口） | JSON 数组；开发期 `["-port","4000"]`（首个项目块首端口，fde-platform §8.2） |
| `FDE_AGENT_VERSION` | 平台规范固定（写 `containers.agent_version`；开发期占位） | `dev` |
| `FDE_MEMORY_LIMIT` | 平台规范固定（deploy-contract §6.2 资源限额；**已决 2026-09-18，issue #27**） | `4g`（B 档镜像下 dotnet build/chromium 峰值需要；`0` 表示不限） |
| `FDE_AGENTD_UID` / `FDE_WORKER_UID` | 平台规范固定（runner-integration §11.3 / user-space §6.1 双 UID） | `1001` / `1002`（GID 同 `1000`；开发期 whoami 镜像不具备双 UID 用户，用 `--user 1001:1000` 兜底） |
| `SESSION_SIGNING_KEY` | 决策者/运维提供（预览 session 确定性派生 HMAC 密钥，portal.md §2.7；⚠️ 生产必须改为强随机值） | `erix-station-dev-signing-key-change-me`（仅联调占位） |
| `PREVIEW_TICKET_TTL_SECONDS` / `PREVIEW_SESSION_TTL_SECONDS` | 平台规范固定（portal.md §2.8；**已决 2026-09-18，issue #27**） | `60` / `900`（ticket 单次短 TTL / 预览 cookie 15min 滚动续期） |
| `LLM_GATEWAY_HOST` | Traefik host-network 使用的 LiteLLM 数据面回环地址 | `http://127.0.0.1:4100` |
| `LITELLM_HOST_PORT` | LiteLLM 在宿主回环发布的端口；隔离栈必须指定与其它栈不同的端口 | `4100` |
| `LLM_GATEWAY_MODE` / `LLM_GATEWAY_ADMIN_URL` | portal LiteLLM admin API 配置；该 LiteLLM 版本管理面与数据面同服务。`self` 使用 backend 上的本栈 LiteLLM，`external` 指向外部网关。AI-title 从 portal 容器经此 backend URL 调用数据面 | `self` / `http://station-litellm:4000` |
| `LITELLM_MASTER_KEY` / `LLM_GATEWAY_MASTER_KEY` | LiteLLM proxy admin key（`sk-` 前缀）；Compose 把同一秘密映射到 portal 配置项；只放 `deploy/.env`（600），不得提交 | 独立强随机值 |
| `LITELLM_SALT_KEY` | LiteLLM 加密 DB 凭据的 salt；写入 `litellm` 库数据后不可更改；只放 `deploy/.env`（600） | 独立强随机值 |
| `LITELLM_DB_USER` / `LITELLM_DB_PASSWORD` | 独立 LiteLLM 数据库角色；新建 DB 数据目录时由 `deploy/db-init/01-litellm.sh` 创建角色与库；容器 `DATABASE_URL` 指向 `station-db:5432/litellm`，不得复用 portal 的 DB 角色 | `litellm` / 独立随机值 |
| `DATABASE_URL`（LiteLLM 容器） | Compose 内部构造的 PostgreSQL URL，连接 `station-db` 上的 `litellm` 数据库 | `postgresql://litellm:…@station-db:5432/litellm` |
| `COOKIE_PROFILE` | 平台规范固定（portal.md §2.5 已声明的同步点，本节落地） | `prod`（→ `__Host-fde_session` + `Secure=true`）\| `dev-http`（→ `fde_session_dev` + `Secure=false`，**仅限 HTTP 部署/联调**（无 `Secure` ⇒ 拿不到 `__Host-` 前缀，cookie 被看到即会话被冒用；2026-10-10 首次部署按决策者口径用于私有网 http 部署，代价与 https 两条路线见 #234 与 `docs/ops/deployment-2026-10-10.md`）） |
| `FIREWALL_ENABLED` | 平台规范固定（topology.md §6.1 / deploy-contract.md） | `1`（生产恒 `1`；`0` 仅限无其它宿主服务的隔离开发机——关闭即放弃「FDE→宿主其它端口」收紧） |
| `TRAEFIK_CONFIG_DIR` | 平台规范固定（deploy-contract.md；由 `DATA_ROOT` 派生） | `/docker/station-edge/`（静态 `traefik.yml` + `dynamic/` 目录 + `acme.json` + `logs/` + `firewall/` 规则文件） |
| `FIREWALL_RULES_PATH` | 平台规范固定（deploy-contract.md；由 `TRAEFIK_CONFIG_DIR` 派生） | `/docker/station-edge/firewall/`（规则文件 `rules.v4`，权限 **600**） |
| `DB_DATA_DIR` | 平台规范固定（由 `DATA_ROOT` 派生） | `/docker/station-db/`（pg data；见 §6） |
| `ERIX_USERSPACE_ROOT` | portal 运行时环境变量：用户空间根（portal **容器内路径**，固定 `/srv/erix/users`，与宿主 bind mount 同路径，user-space §2.2） | 平台规范固定 | `/srv/erix/users` |
| `ERIX_USERSPACE_ROOT_HOST` | compose 插值：宿主用户空间根路径（默认 `/srv/erix/users`；开发期可指向临时目录隔离，结构不变） | 平台规范固定 + 开发期隔离 | `/srv/erix/users` |
| `ERIX_WORKSPACE_RETENTION_DAYS` | workspace 自动清理保留天数；默认 `0` 永不自动清理，显式正数只删除 workspace 目录、不删除用户或关联 DB 行 | 默认关闭，可运维显式开启 | `0` |
| `TRAEFIK_DYNAMIC_DIR` | portal 运行时环境变量：Traefik 动态配置目录（portal **容器内路径**，reconciler 单一写方，deploy-contract §4.2） | 平台规范固定 | `/etc/traefik/dynamic` |
| `TRAEFIK_DYNAMIC_DIR_HOST` | compose 插值：Traefik 动态配置宿主目录（portal 写方与 Traefik 只读方共享；生产 `/docker/station-edge/dynamic/`，开发期默认 `./traefik/dynamic`） | 平台规范固定 + 开发期隔离 | `./traefik/dynamic` |
| `PORTAL_BACKEND_URL` | portal 后端回环地址（reconciler 生成 portal service 与 forwardAuth 地址用） | 平台规范固定 + 目标环境探测（回环端口） | `http://127.0.0.1:8080`（开发期 `http://127.0.0.1:18080`，§0） |
| `TRAEFIK_ENTRYPOINT` | reconciler 生成路由挂载的 Traefik entryPoint | 平台规范固定 | `web`（P1 开发 http；生产 `websecure`） |
| `PORT_QUOTA` | **已无消费者**（#240，2026-10-11）：预览域名固定预分配 10 条 ⇒ 配额语义与 `port_quota_exceeded` 一并删除，规格 §8.2。`config.js` 仍解析该变量但全仓无人读取，**待后续 PR 连同 compose/env 项一起摘除** | 平台规范固定 | `40` |
| `FDE_POOL` | IPAM 默认池选择 | 平台规范固定 | `default`（`large` = 大 FDE `/28` 段） |
| `IPAM_RESERVED_SUBNETS` | IPAM 保留网段（逗号分隔；避开宿主既有网段，开发期可置空，因 FDE 池 10.200/10.201 与 backend 172.32 天然隔离） | 目标环境探测 | ``（空） |
| `FDE_USER_UID` / `FDE_USER_GID` | FDE 工作区属主 UID/GID（user-space §6.1） | 平台规范固定 | `1000` / `1000` |

> **本机重建 FDE 镜像**：当前构建环境访问 GitHub、GitLab 和 Gitea 下载站需经代理，且 Docker build 容器需使用 host 网络才能访问宿主代理；代理地址是构建环境配置，不写入 Dockerfile。重建时传入代理 build args，例如：
> ```sh
> docker build runner/ -t erix-station/fde:local --network=host \
>   --build-arg HTTP_PROXY=http://172.20.0.35:19001 \
>   --build-arg HTTPS_PROXY=http://172.20.0.35:19001 \
>   --build-arg NO_PROXY=127.0.0.1,localhost
> ```

> **口令必须改 + 600 权限存放**：`POSTGRES_PASSWORD` / `PLATFORM_DB_PASSWORD` / `PORTAL_DB_PASSWORD` 在生产环境必须把 `change-me-dev-only` 占位全部改掉，并以 **600 权限 `deploy/.env`** 存放（不入库、不进 compose 正文、不进镜像，见 deploy-contract §2.4）。
>
> **镜像 pin 策略（deploy-contract.md §2 的完整契约，此处只记取值口径；双轨定稿见 issue #27，2026-09-18）**：`deploy/` 内的 compose/镜像引用**不得使用浮动 tag**（`latest` / 裸 `:16` / 裸 `:v3`）。生产部署对每个镜像最终以**不可变引用**锁定，两种形态（F12 校验均接受）：**① repo digest** `image@sha256:…`——push/pull 后 `docker inspect --format '{{index .RepoDigests 0}}'` 取；**② image ID** `sha256:<imageId>`——目标机本地 build（RepoDigests 为空）用 `docker inspect --format '{{.Id}}'` 取。P1 开发期可暂用 `<major>.<minor>` 类 tag，但必须在 `docker inspect` 后把 resolved digest 记录进部署记录（env 附录 B / runbook）。`⚠️ 待决策者确认`：`postgres:16` / `traefik:v3` 的具体 patch 号与 digest 是部署期事实，本文不虚构；P1 开发按 §0 即可，目标环境按 §9 探测后再 pin。**运行时强制范围（审计 #34 F-E）**：程序内 fail-closed 校验的只有 `FDE_IMAGE`（portal `config.js` F12 双轨两形态）；`PORTAL_IMAGE`/`POSTGRES_IMAGE`/`TRAEFIK_IMAGE`/`STATION_DOCKER_PROXY_IMAGE` 由 compose 变量注入，portal 进程内看不到其实际引用 → **由部署流程保证**（部署记录留存 `docker inspect` 解析的 digest），不属运行时校验。**F12 校验口径（审计 #34 F-D）**：这是**形态门**——只做「三类前缀（image ID / 多标签域名·localhost·单标签+端口）+ 严格 `@sha256:<64hex>` 后缀」判别，用于 fail-closed 挡住浮动 tag 与伪 sha256 尾缀；**不声称 docker reference 语法完备**（引用最终合法性由 Docker 裁决）。已知 fail-open 边界：`foo__bar.example.com/fde` 这类「首段含 `.` 但域名含非法字符」会被放行（docker 会拒）。
>
> **容器内 Playwright 覆写（issue #27 评审 F9）**：镜像内置 playwright 1.63/chromium，浏览器路径镜像级写死 `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`（root:root 0755，只读使用）。FDE 项目若需 pin 其它 playwright 版本，在容器内覆写：`PLAYWRIGHT_BROWSERS_PATH=$HOME/cache/ms-playwright npx playwright install chromium`（`~/cache/` 为 FDE 自管卷，重建不丢，user-space §2）。
>
> 宿主机内网 IP（DNS A 记录目标）在部署时由运维填入 DNS，不进入 compose 变量。

### 10.1 补登：已在 `deploy/` 使用、此前未登记的变量（2026-09-16 审计补登）

> 以下参数已被 `deploy/.env.example` / `docker-compose.yml` 使用但本表（§10 自称验收锚点）此前未登记，按 README 写作纪律 3 补齐。描述以实现处为准。

| 变量 | 用途 | 默认 / 示例 |
|---|---|---|
| `PORTAL_PUBLIC_BASE_URL` | portal 对外完整 URL（cookie 域 / 跳转生成用，portal 运行时） | 空 = 由 `PORTAL_HOST` 派生 |
| `LLM_PUBLIC_BASE_URL` | LLM 网关对外完整 URL（`llm.<base>`，路由生成与占位 endpoint 用） | 空 = 由 `LLM_HOST` 派生 |
| `SESSION_TTL_SECONDS` | portal 登录会话 TTL | `604800`（7 天） |
| `FDE_IPAM_POOLS` | IPAM 池（逗号分隔 CIDR；proxy/portal 双侧校验；隔离 e2e 必须使用与宿主网络不重叠的专用池） | `10.200.0.0/16,10.201.0.0/16` |
| `FDE_ALLOWED_USERS` | FDE 容器允许的 `uid:gid` 白名单（create 参数级校验，deploy-contract §5.1） | `1001:1000` |
| `FDE_MEMORY_LIMIT_MAX` / `FDE_PIDS_LIMIT_MAX` | FDE 容器资源限额上限（`0` = 不限；透传 station-docker-proxy） | `0` / `0` |
| `FDE_DEV_MODE` | 显式开发模式（F12/F14 松约束；生产必须 `0` 或 `NODE_ENV=production`） | 开发 `1` / 生产 `0` |
| `FDE_DEV_USER` | 开发期容器 `--user`（whoami 镜像无双 UID 用户时兑底） | `1001:1000` |

### 10.2 补登：agentd 容器侧环境变量（runner 运行时，2026-09-24 登记）

> 以下变量由 FDE 容器内 agentd 进程读取（`runner/agentd.js`），不经 compose 插值；此前未登记，随 issue #64 R1 配套归档修正一并补齐。

| 变量 | 用途 | 默认 / 示例 |
|---|---|---|
| `ERIX_RUN_DATA_TTL_HOURS` | 启动 sweep 对 `<home>/runs/`（活跃层：跨 attempt notes 等 run 数据）残留的 mtime 保留期（小时）；崩溃后 resume re-claim 必在窗口内发生，新鲜目录不会误删（race 推导见 `runner/lib/run-data.js` 头注释）；`0` = 禁用该扫描 | `24` |
| `ERIX_ARCHIVE_TTL_HOURS` | 启动 sweep 对 `<home>/runs-archive/`（归档层：终态确认后从 `runs/` 整体移入的会话真相——transcript/notes，conversation-state.md §5 P1 归档 TTL 替代物理删除）的 mtime 保留期（小时），超期才物理删除；`0` = 禁用归档清扫（一律保留，纯人工/运维兜底） | `168`（7 天） |
| `ERIX_AGENTD_CAPACITY` | agentd 同时执行的 run 上限（并行度；P5 去项目化起同项目并行放行，pi 对齐不锁）。**下发光纤**：portal（compose `ERIX_AGENTD_CAPACITY`）→ provisioner → FDE 容器 env——改值改 deploy env + `docker compose up -d station-portal` + 重建 FDE 容器，**无需重建镜像** | `2` |
| `ERIX_MAX_ROUNDS` | worker `runToolLoop` 轮预算（2026-09-24 用户拍板自 8 上调，与上游 judge 常规搭配 `DEFAULT_REFLECTION_MIN_ROUNDS=16` 对齐；nearLimit 由 round judge 扩轮兜底）。**下发光纤**同上（provisioner Env 注入，issue #84）；非法值回退默认 | `16` |
| `ERIX_ARTIFACT_MAX_BYTES` | run 终态产物快照的文件内容累计上限（字节），超限截断并 manifest.truncated 标记。**runner 侧（采集）与 portal 侧（存储校验）同名同默认**，2026-09-24 自 20MB → 100MB | `104857600`（100MB） |
| `ERIX_ARTIFACT_CAPTURE_BUDGET_MS` | 产物快照打包时间预算（ms）：超时停止收录并 truncated 标记——时间预算比字节数更本质，封死「大产物打包久」的痛点 | `60000` |
| `ERIX_SHELL_TIMEOUT_MS` | agent shell 工具默认超时（可被单次调用的 timeout_ms 参数覆盖） | `60000` |
| `ERIX_SHELL_MAX_TIMEOUT_MS` | agent shell 工具超时上限（单次调用超上限按上限钳制）；DEFAULT 自动钳 ≤ 此值 | `600000` |
| `ERIX_SHELL_OUTPUT_MAX_BYTES` | agent shell 工具输出截断上限（字节，影响模型可见输出量） | `32768` |
| `ERIX_FILE_READ_MAX_BYTES` | agent `readFile` 单次返回的字节上限（上游 erix-agent 0.18.0 有界读，钳 1024–4194304；issue #228 迁上游后取代旧 fork 的无上限 `readFileSync`）。**本站不注入**（工单 D3 §3.2）：跟随上游默认值，改值只需在容器 env 里加该变量（下发光纤同 `ERIX_MAX_ROUNDS`），无需重建镜像 | `262144`（256KB，上游默认） |

### 10.3 补登：portal 侧环境变量（会话自动标题，issue #88，2026-09-25 登记；同日修订为 agent 侧生成）

> 以下变量由 portal 进程读取（`portal/src/config.js`），并经 provisioner 下发链（compose `station-portal` env → provisioner Env → FDE 容器 env，fde-proxy `ENV_KEY_ALLOW` 白名单已登记）同名下发 worker 侧。**2026-09-25 修订**（用户拍板）：标题生成从「portal 独立调 relay」改为「agent（worker）侧生成、随 `run_finished` 上报、portal 落库」——agent 跑任务时本就有完整上下文与既有 provider（§6.3，复用 Traefik 数据面与 key 注入），思考型模型兼容归引擎 provider 层管；portal 不再持有 LLM HTTP 客户端。变量名与开关语义不变（`0` = 两侧全关）。

| 变量 | 用途 | 默认 / 示例 |
|---|---|---|
| `ERIX_SESSION_AUTO_TITLE` | 会话标题自动生成与自动更新总开关（issue #88）：worker 侧在 `runToolLoop` 正常返回后用既有 provider 发一次轻量非流式补全（首条用户消息 + finalText 各截 500 字符，≤30 字符标题，10s 超时，maxTokens 512），标题随 `run_finished` 上报、portal 异步评估落库（不阻塞消息主链路）；失败/空降级链：首条用户消息截断 → cwd basename。手工改过的标题（`title_source='manual'`）不被覆盖。**下发光纤**：portal env → provisioner Env → FDE 容器 env | `1`（开；`0` = 关闭） |
| `ERIX_SESSION_AUTO_TITLE_MIN_NEW` | 防抖阈值 N：距上次自动标题更新 ≥ N 轮新 user 消息才刷新（或话题漂移启发式命中：≥1 轮新消息且与现标题关键词零重合）。portal 侧落库评估用，不下发 worker | `3` |

### 10.4 补登：worker 侧 LLM provider 超时相（runner `lib/llm-timeouts.js`，issue #261，2026-10-12 登记）

> 以下四个变量由 FDE 容器内 **worker** 进程读取（`runner/lib/llm-timeouts.js`，`createOpenAIProvider({ timeouts })`），
> 不经 compose 插值。**立案依据**（issue #261 + R-2 演练实测）：worker 此前不传任何超时 ⇒ 引擎 erix-agent 0.18.0
> 走 legacy 模式，`legacyDeadline = startedAt + 120000` 是一条**从请求发起就定死的绝对线**（流式有 chunk 回流也不重置），
> 重型轮子（8-10K 输出 ≈ 100-130s）必撞 ⇒ run 整条 `failed`、`termination.detail="request timed out"`。
> **真正的修法不是把 120000 换大**：只要传了**任一**显式相超时，引擎就置 `hasExplicitPhase=true` ⇒
> `legacyTimeoutMs=undefined` ⇒ 那条绝对死线整体消失，改由下面三相分别计时。

| 变量 | 用途 | 默认 / 示例 |
|---|---|---|
| `ERIX_LLM_TIMEOUT_FIRST_BYTE_MS` | **首字节前**的静默上限（用户语义：超过 N 秒没返回才算超时）。发请求后迟迟拿不到第一个字节即 `firstByte timed out` | `240000`（240s，真超时） |
| `ERIX_LLM_TIMEOUT_STREAM_IDLE_MS` | 见到首字节后**相邻两个 chunk 之间**的静默上限——**每来一个 chunk 重新计时**（有返回就不算超时），所以长推理 / 慢生成不会被误杀 | `180000`（180s，真超时） |
| `ERIX_LLM_TIMEOUT_STREAM_TOTAL_MS` | 一条流的**总时长**上限。默认值是 `2147483647`（=2^31-1 ms ≈24.85 天），语义是**「事实关闭总闸 + 溢出安全」，不是一个超时值**（陷阱说明见下方注） | `2147483647` |
| `ERIX_LLM_TIMEOUT_REQUEST_MS` | 只兜**非流式**路径（会话标题生成等）的整请求上限，防悬挂；流式路径不受它约束（三相各管各的） | `300000`（300s） |

> **解析口径**（`runner/lib/llm-timeouts.js`）：未设置 / 空串 → 静默取默认；合法 = 有限且 ≥1 的毫秒数；
> 超上限钳到 `2147483647`；其余非法值（`0` / 负数 / `NaN` / 垃圾串 / **`Infinity`**）**回落默认 + `console.warn` 一次**，
> 绝不抛错炸 run。**为什么 `streamTotalTimeoutMs` 只能写 `2147483647`**（引擎 0.18.0 源码 + 实测取证，钉在 `runner/test/llm-timeouts.test.js` ③）：
> 引擎对这一相**没有「显式关闭」的值**——`undefined`/`null` 回落引擎默认 `300000`（重型轮子照样被杀）；
> `0`/`false` 原样透传后经 `Math.max(0, …)` 变成 `setTimeout(fn, 0)` ⇒ **流一开跑就被杀**（实测 3ms）；
> `Infinity` 也原样透传，而非流式路径把它直接交给 Node `setTimeout` ⇒ 溢出 `TimeoutOverflowWarning` 钳成 **1ms** ⇒ **立刻 `request timed out`**（实测 7ms，与本单要修的症状同形）。
> `2147483647` 是 `setTimeout` 不溢出的最大 delay，因此是唯一两条路都安全的「不设总闸」写法——**别改成 `Infinity`**。
>
> **下发链路现状**（本单未动 `deploy/`）：这四个名字目前**不在** `deploy/fde-proxy/server.js` 的 `ENV_KEY_ALLOW` 白名单里，
> 也未进 `portal/src/provisioner.js` 的 Env 下行集，所以现在只能靠**容器创建时直接注入**（或进容器改 env 后重建）生效；
> 要像 `ERIX_MAX_ROUNDS` 那样走「portal env → provisioner → 容器 env」的光纤，需后续单登记两处（改值本身无需重建镜像）。

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
| 审批轮询兜底 / 审批超时 | 5 / 600 | s | — | agentd（runner §10.1） | 10min 无决定 → 按 denied 继续；审批单由 portal reaper 打 `expired`（权威审计态，portal.md §9.12/model.md） | 审批 pending 时长、超时数 |
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
| socket-proxy | `docker logs station-docker-proxy` | json-file `max-size`/`max-file` |
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
