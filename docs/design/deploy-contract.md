# P1 部署契约（deploy-contract.md）

> 状态：**契约基线（补齐「没有足够信息生成可运行的 P1 compose」的阻断缺口）**
> 依据：[`fde-platform.md`](fde-platform.md)（主规格，下称「规格 §x」）、[`topology.md`](topology.md)（H-B 网络与访问拓扑单一事实来源，下称「topology §x」）、[`principles.md`](principles.md)（原理）、[`user-space.md`](user-space.md)（用户空间物化契约）、[`runner-integration.md`](runner-integration.md)（容器内进程模型）、[`../env.md`](../env.md)（部署参数，下称「env §x」）、[`../data/model.md`](../data/model.md)（数据模型，下称「model §x」）。
>
> **本文只定义「部署契约」**：服务清单、compose 字段、DB 迁移、Traefik 配置、防火墙应用方式、socket 策略、FDE 容器创建参数、P1 范围、readiness 语义。**不写实现代码**——字段级契约为实现者提供「可直接照做、无需再拍板」的部署事实；`deploy/` 下的 compose/traefik 模板/迁移文件按本文生成。
>
> **环境取值纪律**：本文所有域名/路径/版本/端口一律引用 [`../env.md`](../env.md) 的变量（`BASE_DOMAIN` / `PORTAL_HOST` / `DATA_ROOT` / `USER_SPACE_ROOT` / 镜像 pin 等）；env.md 没有的先补 env.md 再引用（[`../README.md`](../README.md) §四 写作纪律 3）。未决项按 `principles.md §4` 倾向写 + 标注 `⚠️ 待决策者确认`。

---

## 0. 阅读前提与不变式

三条不变式（[`../../README.md`](../../README.md)）贯穿本文：

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥。
2. **ingress 是唯一的路**：一切对外访问经 Traefik，认证在边缘。
3. **DB 是状态的真相**：容器是牲口，重建后从 DB + 卷恢复。

已定架构决策（规格附录 A D1~D10 + topology D-1~D-10）**本文不重定、只落地**：Traefik host 网络独占 80/443（`--api=false`）、portal `backend` 网络 publish 仅回环、station-db 仅 `backend`、每 FDE 独立 `/29`、FDE 容器零 LLM 凭据、internal API 经 Traefik、文件投递走 portal 直写 bind mount、reconciler 声明式收敛。

---

## 1. 服务清单（镜像 pin / command / 运行用户 / restart）

> 镜像取值见 env §10；**生产部署对每个镜像最终以 digest（`image@sha256:…`）锁定，禁止浮动 tag**（`latest` / 裸 `:16` / 裸 `:v3`）。P1 开发期可暂用 `<major>.<minor>` 类 tag 并记录 resolved digest。

| 服务 | 镜像 | tag pin 要求 | command（ENTRYPOINT/CMD） | 运行用户 | restart | 部署期 |
|---|---|---|---|---|---|---|
| `station-edge`（Traefik） | `TRAEFIK_IMAGE`（官方 `traefik:v3`） | 生产 `traefik:v3.<minor>.<patch>` **再 pin digest**（env §10 ⚠️） | `traefik --configFile=/etc/traefik/traefik.yml`（静态配置见 §4） | **root**（官方镜像默认；需绑 80/443 与写 `acme.json`） | `unless-stopped` | P1 ✅ |
| `station-portal` | `PORTAL_IMAGE`（自构建，build context `portal/`） | `erix-station/portal:<git-sha>` 不可变 tag，部署时 pin digest | `station-portal serve`（零依赖 Node，Q7 倾向 (a)） | **root（UID 0）**（materializer 需 chown 工作区、写 Traefik 动态配置 600、经 socket-proxy 调 Docker API，user-space §6.1 `PORTAL_RUNTIME_UID=0`） | `unless-stopped` | P1 ✅ |
| `station-db` | `DB_IMAGE`（官方 `postgres:16`） | 生产 `postgres:16.<patch>` **再 pin digest**（env §10 ⚠️） | 官方默认（`postgres`，容器内以 `postgres` 用户跑） | `postgres`（镜像内置） | `unless-stopped` | P1 ✅ |
| `station-docker-socket-proxy` | `SOCKET_PROXY_IMAGE`（`tecnativa/docker-socket-proxy`） | digest pin（env §10 ⚠️） | 官方默认入口 | 官方默认（非 root 或受 `no-new-privileges` 约束，见 §5） | `unless-stopped` | P1 ✅ |
| `llm-gateway`（LLM 网关） | LiteLLM（`ghcr.io/berriai/litellm` 或等价） | digest pin（Q1 未定 → ⚠️ 具体镜像/版本待决策者确认） | 官方默认 | 官方默认 | `unless-stopped` | **P3**（P1 不部署，见 §7） |
| `fde-<name>`（FDE 容器，模板化） | `FDE_IMAGE`（自构建，build context `runner/`） | `erix-station/fde:<erix-agent 版本>-<git-sha>` 不可变 tag；版本记录点 `containers.agent_version` | `tini -- station-agentd`（`docker run --init` + entrypoint exec agentd，runner §2.3 方案 (a)） | root 启动 → **drop 到 `erix-agentd`(1001)**，fork worker 切 `erix-worker`(1002)（user-space §6.1） | `unless-stopped` | P1 ✅（单实例；多 FDE = P2） |

> **镜像预拉取**：portal **不授 IMAGES**（socket-proxy 白名单仅 CONTAINERS/NETWORKS/VOLUMES，§5）。FDE 镜像由**宿主在部署时 `docker pull`** 预拉取（版本 pin 走 `containers.agent_version` + canary，规格 §14）；镜像升级 = 宿主预拉新 digest + 重建容器，不经过 portal 的 Docker API。
>
> **LLM 网关（P3，不入 P1 compose）的字段契约**：`llm-gateway` 接 `backend` 网络，**数据面 publish 仅 `127.0.0.1:4000`（回环，供 Traefik `llm.<base>` 路由回环访问）；admin 面不发布**（仅 `backend` 内可达，topology §6 第 6 条 / env §5）。Q1（公司是否已有网关）未定 → 已有则复用、不部署本容器；没有则 P3 起一个 LiteLLM 容器，portal 仍只做租户绑定（规格 §11.3）。

---

## 2. compose 契约（network / publish / volume / depends_on / healthcheck / env_file）

> 本节给出 **P1 四个 compose 服务**（`station-edge` / `station-portal` / `station-db` / `station-docker-socket-proxy`）的字段级契约；`deploy/docker-compose.yml` 按此生成。FDE 容器**不在 compose 内**（由 portal 经 Docker API 动态创建，§6）。

### 2.1 网络

| 网络 | 声明方式 | 成员 |
|---|---|---|
| `backend` | compose 顶层 `networks.backend`，`ipam.config[].subnet = 172.30.0.0/24`（**显式**，不与 FDE 池 `10.200.0.0/16`/`10.201.0.0/16` 及既有 bridge 重叠，env §5.2） | `station-portal` + `station-db` + `station-docker-socket-proxy` |
| `host` | Traefik `network_mode: host`（**零 docker 网络接入**，topology §2.2 D-2） | `station-edge` |

- FDE 网络 `fde-<name>` **不在 compose 内**，由 portal 经 Docker API 显式 `--subnet` 创建（§6）。
- 仅 `backend` 与 `host`；`control`/`edge` 已取消（topology §2.3）。

### 2.2 每服务字段

| 服务 | network | publish | volumes（宿主源 → 容器目标，权限） | depends_on | healthcheck | env_file |
|---|---|---|---|---|---|---|
| `station-db` | `backend` | **无**（仅 backend 内可达） | `/docker/station-db/` → `/var/lib/postgresql/data`（RW，属主由 postgres 镜像初始化） | — | `pg_isready`（见下） | `/docker/station-db/.env.db`（600） |
| `station-portal` | `backend` | **`127.0.0.1:8080:8080`**（回环，供 Traefik 反代 + forwardAuth） | ① `/srv/erix/users` → `/srv/erix/users`（RW，**同路径**，materializer 直写用户空间，user-space §2.2）；② `/docker/station-edge` → `/docker/station-edge`（RW，写 Traefik 动态配置 600 + 防火墙规则 600）。portal 自身无持久卷（状态在 DB） | `station-db`（`condition: service_healthy`）+ `station-docker-socket-proxy`（`condition: service_started`） | `station-portal healthcheck`（见下） | `/docker/station-portal/.env.portal`（600） |
| `station-docker-socket-proxy` | `backend` | **无**（仅 portal 可达；FDE 不在 backend，天然不可达） | `/var/run/docker.sock` → `/var/run/docker.sock`（**RO**） | — | 无（官方镜像无内置；靠 `service_started` 依赖） | env 白名单（`CONTAINERS=1 NETWORKS=1 VOLUMES=1`，其余 0，见 §5） |
| `station-edge` | `host` | **无**（host 网络直接监听 `TRAEFIK_WEB_PORT`/`TRAEFIK_WEBSECURE_PORT`） | ① `/docker/station-edge/traefik.yml` → `/etc/traefik/traefik.yml`（RO）；② `/docker/station-edge/dynamic/` → `/etc/traefik/dynamic/`（RO）；③ `/docker/station-edge/acme.json` → `/acme.json`（RW，**600**，仅 Traefik 写）；④ `/docker/station-edge/logs/` → `/var/log/traefik/`（RW） | —（host 网络独立启动；路由在 portal 就绪后自然可用） | 无（`--api=false` 关闭 ping；靠 restart policy + reconciler 对账兜底，§8） | `/docker/station-edge/.env.edge`（600，含 ACME/DNS-01 凭据，经环境变量注入、**不进 traefik.yml**） |

### 2.3 healthcheck 命令与阈值（写死）

| 服务 | test | interval | timeout | retries | start_period |
|---|---|---|---|---|---|
| `station-db` | `["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]` | 5s | 5s | 10 | 10s |
| `station-portal` | `["CMD", "station-portal", "healthcheck"]`（等价 `wget -qO- http://127.0.0.1:8080/api/health` 返回 200） | 10s | 5s | 5 | 30s |
| `station-edge` | 无（见 §2.2；`--api=false` 下无 in-band ping） | — | — | — | — |
| `station-docker-socket-proxy` | 无（`service_started` 依赖即可） | — | — | — | — |

> portal healthcheck 语义：`/api/health` 返回 200 当且仅当「DB 可达 + 迁移已到 head（§3）+ 无致命初始化错误」——这使 `depends_on: station-db (service_healthy)` 传递的 readiness 链成立（§8）。

### 2.4 `env_file` 约定与凭据注入

- 所有平台凭据（`DB_PASSWORD`、runner token 生成、OIDC client secret、DNS-01 token、ACME 凭据）一律经 `env_file` 指向宿主 **600 权限文件**（`/docker/<名称>/.env.<名称>`），**不进 compose 正文、不进仓库**（项目 AGENTS.md §6，env §6）。
- `DB_PASSWORD` 部署时生成存凭据文件 600（env §10）；portal 运行时角色 `station_portal`（最小 GRANT）、迁移角色 `station_platform`（DDL 专用，model §3）。
- LLM 虚拟 key **不进任何 env_file/容器**：真实 key 只存在于 portal 经 reconciler 写出的宿主 Traefik 动态配置（600，portal 可写、Traefik 只读，topology §6 第 8 条）。

---

## 3. DB 初始化与 migration 机制

### 3.1 谁执行、怎么幂等

- **baseline = [`../data/schema.sql`](../data/schema.sql)**（可执行建表 DDL，单事务 `BEGIN;…COMMIT;`，`psql -f` 空库实测可执行）。
- **migration runner**：portal 在**启动时、监听端口之前**先跑迁移（或用独立一次性 `station-migrate` 命令，实现任选，语义一致）。迁移角色 `station_platform`（DDL），运行时角色 `station_portal`（DML 最小 GRANT）。
- **幂等**：新增 `schema_migrations` 表（`version text PK, checksum text, applied_at timestamptz DEFAULT now()`）。每个迁移文件在**单事务**内执行，成功后插入 `schema_migrations` 行；已存在的 `version` 跳过。`schema.sql` 作为 `version='0000_baseline'` 只在空库首次应用（已有 `schema_migrations` 则不再重放 baseline）。
- **顺序**：baseline → `deploy/migrations/0001-*.sql` → `0002-*.sql` …（文件名编号升序）。每次新增 DDL 都写成新编号迁移文件，**不修改已应用的迁移**（改历史迁移会破坏 checksum 一致性）。

### 3.2 失败与回滚

- 每个迁移在 Postgres **单事务**内执行（DDL 在 PG 中事务性）→ 失败整体回滚该迁移，`schema_migrations` 不写该行，**不产生半套 schema**。
- 迁移失败 → portal **拒绝启动**（不进入 unhealthy 的假就绪），`/api/health` 返回 503 + 明确错误码 `migration_failed`（§8 readiness）。
- 迁移文件带 `checksum`：已应用迁移的文件内容被改动 → checksum 失配 → 拒绝启动 + 告警（防「改历史」）。
- **数据迁移**（有损/大表 rewrite）必须显式 `SET lock_timeout` + 幂等（`IF NOT EXISTS` 等），遵循 env §11.2 的 `statement_timeout`/`lock_timeout` 基线；超时则回滚重试，不硬等锁。

### 3.3 `docs/data/schema.sql` 的应用方式

- **空库**：runner 以 `station_platform` 角色执行 `psql -f docs/data/schema.sql`（等价单事务 baseline），记录 `0000_baseline`。
- **已有库**：不重放 baseline；只按 `deploy/migrations/` 顺序补增量。
- schema.sql 由文档→`deploy/` 的**生成/拷贝步骤**保持同步（schema.sql 是真相，`deploy/` 的 baseline 副本是部署产物；若将来拆分，以 `docs/data/schema.sql` 为准）。

---

## 4. Traefik 静态/动态配置 + 证书 + 防火墙应用方式

### 4.1 静态配置（`traefik.yml` / CLI args）

| 项 | 取值 | 依据 |
|---|---|---|
| `api` | **`false`**（dashboard/API 全关） | topology §6 第 1 条 |
| `entryPoints.websecure.address` | `:${TRAEFIK_WEBSECURE_PORT}`（443） | env §5 |
| `entryPoints.websecure.http.aliasHeadersStrategy` | **`delete`**（必须挂在 `http` 层级下，写成 entryPoint 顶层会启动失败） | topology §6 第 2 条 / 规格 §6.4 |
| `entryPoints.web.address` | `:${TRAEFIK_WEB_PORT}`（80，仅作 http→https 跳转） | env §5 |
| public entryPoint `forwardedHeaders.insecure` | **不配**（不信任客户端 `X-Forwarded-*`） | topology §5 公共约定 |
| `providers.file.directory` | `/etc/traefik/dynamic/`（动态配置目录，reconciler 写出的 file provider） | topology §5 |
| `providers.file.watch` | `true`（文件替换后自动 reload；配合 reconciler 的临时文件+原子替换） | topology §8 |
| `certificatesResolvers.le.acme.dnsChallenge` | Let's Encrypt **DNS-01**，`provider`/凭据经环境变量注入（**不写进 traefik.yml**），SAN = `station.<base>` + `*.fde.<base>` + `llm.<base>` | env §2（🕓 部署期事项；P1 开发自签/http，env §0） |
| `log.level` | **`INFO`**（生产）；P1 联调可 `DEBUG`。`--api=false` 下 access log 仍正常输出 | — |
| `accessLog.filePath` | `/var/log/traefik/access.log`（原始日志，**不作审计依据**，topology §5.2） | — |

### 4.2 动态配置目录与权限

- 目录：宿主 `/docker/station-edge/dynamic/`（600 文件），容器内 `/etc/traefik/dynamic/`（RO）。
- **单一写方**：portal（reconciler）生成整份动态配置 → 临时文件 → schema 校验 → `mv` 原子替换 → file provider reload；失败保留上一版文件（topology §8）。
- 动态配置内容（P1 最小集）：portal 路由 + internal 路由（`Host(station.<base>) && PathPrefix(/api/internal)` + `ipAllowList` 由 `fde_networks` 精确派生）+ `fde-auth` forwardAuth 中间件（P2）+ LLM 注入路由（P3）。**P1 不含预览路由、不含 LLM 路由**（§7）。
- 每 allocation 一条 router+service（否决单通配 service，topology §5）；hub service `responseForwarding.flushInterval ≤ 100ms`（P3 流式）。

### 4.3 证书/ACME 存储与权限

- `acme.json`：`/docker/station-edge/acme.json`，权限 **600**，仅 Traefik 读写（§2.2）。
- P1 开发期：自签证书或直接 http（cookie 走 `COOKIE_PROFILE=dev-http`，env §0/§10）；部署期：DNS-01（env §2，🕓）。

### 4.4 防火墙应用方式（选定）

> **选定**：**portal reconciler 生成规则文件 + 一个 host systemd unit 在启动/文件变化时应用**（iptables-nft，自有链 + 逐条下发）。分工：生成在 portal（无 root 权限需求，只写文件）、应用在宿主（systemd unit 以 root 执行）。

**① iptables vs nftables**：选定 **iptables（iptables-nft 后端，Docker 默认）**。理由：Docker 用 iptables（iptables-nft）管理 NAT/FORWARD/`DOCKER-USER`/`DOCKER-ISOLATION` 与 publish 端口的 INPUT 规则；改用独立 nftables 表会与 Docker 链脱节、需重复实现 Docker 的 NAT/转发处理。topology §6.1 的规则模型以 iptables 语法表达，落地一致。

**② 规则集合（语义，与 topology §6.1 逐条对应；单一事实来源仍为 topology §6.1）**：

自有链 `STATION-INPUT`（宿主本地服务收紧，被 INPUT 以 `-j STATION-INPUT` 引入）：

```
-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-s <FDE CIDR> -p tcp --dport 443 -j ACCEPT      # Traefik（host 网络）
-s <FDE CIDR> -j DROP                           # 其它宿主本地端口
```

自有链 `STATION-DOCKER-USER`（转发/publish 收紧，被 DOCKER-USER 以 `-j STATION-DOCKER-USER` 引入）：

```
-m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-s <FDE CIDR> -m conntrack --ctstate DNAT -j DROP
```

- **派生关系（topology §5.1 唯一口径）**：`<FDE CIDR>` 对 `fde_networks` 中 `state ∈ {allocated, active}` 的**每一行**取其精确 `subnet`（`/29` 或 `/28`）生成一条 `-s <CIDR>`。**禁止把 `/16` 聚合池写进放行范围**（池范围 ≠ 放行范围）。
- **不影响非 FDE 流量与容器出网**：两条自有链默认 `RETURN`（非 FDE 流量直接落回 INPUT/DOCKER-USER 既有规则，不误伤宿主其它服务）；容器出网 MASQUERADE 在 nat 表 POSTROUTING、容器 DNS 在 netns `127.0.0.11`、跨 bridge 转发由 `DOCKER-ISOLATION`——三者都**不经过**这两条链，天然不受影响（topology §6.1）。

**③ 幂等**：规则由 reconciler 从 `fde_networks` **全量纯函数生成**（同 DB 快照 → 字节级相同）。应用时：① 两条自有链先 `iptables -F STATION-INPUT` / `-F STATION-DOCKER-USER` 再按派生结果重建（这两条链是本平台独占，flush 安全）；② 两条 jump 规则（`-A INPUT -j STATION-INPUT`、`-A DOCKER-USER -j STATION-DOCKER-USER`）带 `-m comment --comment "station-fw"` 标记、**先删后插**，不重复堆积。**不 flush INPUT/DOCKER-USER 本体**（避免误删宿主/Docker 既有规则）。

**④ fail-closed**：

- 规则生成后先 **dry-run 校验**（逐条 `iptables -C` 或 `iptables-restore --test` 到临时链），全部通过才提交；提交失败**保留上一版已生效规则 + 告警，绝不清空成放行态**。
- **兜底 DROP**：当规则缺失 / 校验失败 / 应用不完整时，应用脚本**追加一条紧急 catch-all DROP**——对 FDE 两池 `10.200.0.0/16` 与 `10.201.0.0/16`（443 除外）整体收紧到宿主本地端口与 DNAT 路径——**宁可过度收紧**（连 released/未分配段一起挡），**绝不回到放行态**。此兜底 DROP 与「池范围 ≠ 放行范围」不冲突：那条只约束**放行**规则，不约束**兜底拒绝**（方向相反）。
- `FIREWALL_ENABLED=0` 仅限无其它宿主服务的隔离开发机（env §10）。

**⑤ docker 重启 / 宿主重启恢复**：

- **宿主重启**：systemd unit `station-firewall.service`（`After=docker.service network.target`，`WantedBy=multi-user.target`）自动应用。
- **docker daemon reload/重启**（`DOCKER-USER` 被 Docker 重建清空，jump 丢失）：① `docker.service` drop-in `ExecStartPost=/usr/local/bin/station-firewall-apply`；② reconciler 定时对账检测 `-j STATION-DOCKER-USER` jump 缺失 → 重写 rules.v4（触发 path unit 重应用）+ 告警。
- **portal/reconciler 不直接持 root**：只写 `/docker/station-edge/firewall/rules.v4`（600）；`station-firewall.path`（path unit）监听文件变化自动触发 `station-firewall.service`。

---

## 5. Docker socket 策略（直挂 vs socket-proxy）

**选定：socket-proxy**（不直挂 `docker.sock`）。与规格 §4 / env §6 已定决策一致。

| 项 | 取值 |
|---|---|
| 镜像 | `SOCKET_PROXY_IMAGE` = `tecnativa/docker-socket-proxy`（digest pin，env §10 ⚠️） |
| 挂载 | `/var/run/docker.sock` → `/var/run/docker.sock`（**RO**） |
| API 白名单 | `CONTAINERS=1`、`NETWORKS=1`、`VOLUMES=1`，**其余全 0**（`IMAGES/EXEC/SYSTEM/AUTH/SECRETS/BUILD/COMMIT/PLUGINS/SWARM/INFO/…`） |
| 加固 | `--security-opt no-new-privileges`；官方默认非特权运行；不 publish、仅 `backend` 网络 |
| portal 连接 | `DOCKER_HOST=tcp://station-docker-socket-proxy:2375` |

**白名单理由（每项都对应 portal 实际所需的最小面）**：

- `CONTAINERS`：FDE 容器生命周期（create/start/stop/rm/inspect/ps）——portal 核心职责。
- `NETWORKS`：FDE 网络生命周期（`network create --subnet` / inspect / ls / rm），onboarding/offboarding。
- `VOLUMES`：卷观察（inspect/ls），配合绑定挂载的运维对账（env §6 已定清单）。
- **不授 `IMAGES`**：FDE 镜像由宿主部署时预拉取（§1），portal 不需要、也不应能拉任意镜像（防被攻破后拉恶意镜像）。
- **不授 `EXEC`**：portal 被攻破后 `docker exec` 进任意容器 = 跨信任边界提权（违反不变式一）。
- **不授 `SYSTEM`/`AUTH`/`SECRETS`**：防读宿主 docker 配置/凭据/secret。
- **不授 `BUILD`/`COMMIT`**：防镜像篡改/逃逸面。

> FDE 容器**永不挂 `docker.sock`、也访问不到 socket-proxy**（FDE 只接自己的 `/29`，不在 `backend`）。

---

## 6. FDE 容器创建契约（portal 经 Docker API，模板化）

> 路径/UID/权限的**完整契约**以 [`user-space.md`](user-space.md) 为准（本文 §6 引用、不重写）。以下字段级契约供 portal 的容器创建实现照做。

### 6.1 网络创建（显式 subnet）

1. 从 `fde_networks` 取该 FDE 的 `subnet`（`10.200.<n>.0/29` 或大 FDE `10.201.<n>.0/28`）。
2. **建网络前经 Docker API 校验**该 subnet 与既有网络/`fde_networks` 无重叠（topology §8）。
3. `docker network create --subnet <subnet> --gateway <gateway> fde-<name>`（gateway = 该网络 `.1`，= `host(subnet)+1`，schema.sql `fde_networks.gateway`）。

### 6.2 容器创建参数

| 参数 | 取值 | 依据 |
|---|---|---|
| `--name` | `fde-<name>`（docker 容器名 = `fde_networks.network_name`） | env §6 |
| `--network` | `fde-<name>`（**只接自己的 `/29`**，不接 backend/control） | topology §2.2 D-1 |
| `--ip` | `<gateway> + 1`（= `.2`，FDE 主容器固定位；Traefik 预览/LLM 后端用 `10.200.<n>.2:<port>`） | topology §3 / §4-L2 |
| `--add-host` | `station.<base>:<gateway>` + `llm.<base>:<gateway>`（**两条**，映射到本 FDE bridge 网关 `.1`；容器内解析不走 DNS） | env §0/§1，topology §4-L3 |
| `--init` | `true`（tini 作 PID 1，reap + 信号转发） | runner §2.3 方案 (a) |
| `--restart` | `unless-stopped` | 规格 §14 |
| entrypoint/command | `tini -- station-agentd` | runner §2.3 |
| env | `ERIX_STATION_TOKEN`（per-container token，建容器时生成、**仅存哈希入 DB**、原文注入容器 env，runner §4.4）；`ERIX_STATION_BASE_URL=https://station.<base>/api/internal`；`ERIX_FDE_NAME=<name>` | runner §4.1 |
| `--security-opt` | `no-new-privileges` | topology §6.2 |
| `--cap-drop` / `--cap-add` | `--cap-drop ALL`，回加运行必需最小集（`SETUID`/`SETGID`/`CHOWN`/`DAC_OVERRIDE`/`FOWNER`，供 root 启动后 drop 到 1001、fork worker 切 1002、chown 工作区）；**不授 `NET_ADMIN`/`SYS_ADMIN`/`SYS_PTRACE`** | topology §6.2 / runner §11.3 |
| seccomp/AppArmor | 保持默认 profile | topology §6.2 |
| 资源限额 | `--memory` 等由 portal 经 Docker API 设置（规格 §14；具体数值 ⚠️ 按 FDE 规模定） | 规格 §14 |

### 6.3 UID/GID（引用 user-space §6.1）

| 角色 | UID | GID | 运行位置 |
|---|---|---|---|
| FDE 用户 `erix` | 1000 | 1000 | FDE 容器（工作区属主、code-server/dev servers） |
| `erix-agentd` | 1001 | 1000 | 唯一持 token，root 启动后 drop 到 1001 |
| `erix-worker` | 1002 | 1000 | fork 时切 UID + 从 env 剔除 token |

镜像内预建 `erix`(1000) / `erix-agentd`(1001) / `erix-worker`(1002) 三用户（同 GID 1000）；容器内 HOME = `/home/<user>`（`FDE_CONTAINER_USER=erix`，⚠️ 固定 `erix` 待决策者确认，user-space §2.4）。

### 6.4 用户空间挂载（引用 user-space §2.4）

| 宿主源 | FDE 容器目标 | 属主 |
|---|---|---|
| `/srv/erix/users/<fde>/home` | `/home/<user>` | `erix`(1000) |
| `/srv/erix/users/<fde>/projects` | `/home/<user>/projects` | `erix`(1000) |
| `/srv/erix/users/<fde>/worktrees` | `/home/<user>/worktrees` | `erix`(1000) |
| `/srv/erix/users/<fde>/cache` | `/home/<user>/cache` | `erix`(1000) |

> 平台文件（`config.json`/`ports.json`/`AGENTS.md`/`manifest.json`）由 portal（materializer）以 root 直写宿主 bind mount（tmp+fsync+rename 原子替换），属主 root:root、模式 `0644`/`0444`，容器只读（防误改，非安全边界）——完整契约见 user-space §4/§5/§6。

---

## 7. P1 范围声明（包含 / 不包含 + 未包含项部署方式）

> 与规格 §15 分期计划一致；此处把「部署方式」落到 compose/创建契约层面。

### 7.1 P1 包含

- **4 个 compose 服务**：`station-edge`（Traefik，host 网络）+ `station-portal` + `station-db` + `station-docker-socket-proxy`（§2）。
- **单 FDE 容器**（含 `station-agentd`/`station-runner`/erix-agent），由 portal 经 Docker API 动态创建（§6）。
- **登录**（本地账号 + argon2id + 强制 TOTP，bootstrap CLI，portal §2.9）、**项目列表/创建**（含项目级**单端口**分配 + `ports.json` 物化，规格 §8.2/§8.5）、**对话（SSE）**、**停止**。
- **internal API**（agentd ↔ portal 全出站通道）+ **防火墙应用**（§4.4）+ **DB 迁移**（§3）。
- P1 验收 = 规格 §15 P1 行「登录→建项目→对话→工具卡片→停止」。

### 7.2 P1 不包含 + 部署方式

| 项 | 归期 | P1 部署方式 |
|---|---|---|
| **预览 / IDE iframe**（`*.fde.<base>` 浏览器访问 + forwardAuth 预览凭证 ticket/cookie） | P2 | **完全不部署**：不发布 `*.fde.<base>` 预览路由、不实现 preview-ticket/preview-cookie 签发。端口分配照常落 DB（为 P2 预留），但「路由表里没有 = 不可达」→ 预览入口 fail-closed |
| **多 FDE** | P2 | 只部署单 FDE（`fde-<name>` 仅一个） |
| **run 级端口块 + 事件重放 UI** | P2 | 只做项目级单端口（规格 §8.2）；run 级端口分配/URL 带 runId 不启用 |
| **工具审批** | P2 | **完全不部署**审批单/审批 UI/审批中转（tools 直接执行；judge 拦截链 P2 再接，runner §10 端点 P2 才启用） |
| **SSO / OIDC** | P2 | **不部署** OIDC（P1 恒 `auth_source=local`，env §4/portal §2.1） |
| **LLM 网关（模式 C）+ 用量记账 + code-server 模板** | P3 | **完全不部署** `llm-gateway` 容器、不实现 Traefik LLM 注入路由。P1 对话所需的 LLM 走**开发期临时直连**：portal 物化的 `config.json` baseURL/key 在 P1 指向开发机可达的 LLM endpoint（`LLM_DEV_BASE_URL` + `LLM_DEV_API_KEY` 经 portal env 注入，**仅限 P1 开发机、不进目标环境**）——⚠️ 这是对「容器零 LLM 凭据」红线（topology D-4）的 **P1 开发期临时豁免**，P3 模式 C 落地后废除 |
| **通知通道**（邮件/IM webhook） | P2+ | 不部署；告警**状态**（`failed`+code）P1 落库可查（规格 §14 / user-space §7.3） |
| **备份/高可用** | 系统级方案（issue #3） | 不部署；平台只保证数据落卷、DB 处于可被系统级备份的形态（规格 §14） |

---

## 8. readiness 语义（就绪判据）

| 组件 | 「就绪」判据 | 消费方 |
|---|---|---|
| **station-db** | `pg_isready` 接受连接 **且** 迁移已到 head（`schema_migrations` 最新 version 已应用） | portal `depends_on: service_healthy` → portal 才启动监听 |
| **portal** | `/api/health` 返回 200 = DB 可达 + 迁移到 head + 无致命初始化错误（`migration_failed` 时返回 503） | compose healthcheck；Traefik 路由自然可服务（portal 未就绪时 502） |
| **Traefik** | 进程 up + 监听 `TRAEFIK_WEB_PORT`/`TRAEFIK_WEBSECURE_PORT`（宿主 `ss -tln`）+ 静态/动态配置加载无错。`--api=false` 无 in-band ping → 无 healthcheck，靠 restart policy + reconciler 对账检测 | 无 compose 依赖；对账任务判「路由是否生效」 |
| **agentd（FDE 容器）** | ① SSE 下行 `GET /api/internal/stream` 已建立；② 完成启动读（`manifest.json` 校验，user-space §3/§5.4）；③ 首次心跳上报成功（portal `containers.last_heartbeat` 在 45s 内刷新） | portal：`containers.status` 从 `creating` → `running`（心跳为在线证明，runner §4.2） |

> 全链路 readiness 顺序：`station-db` 健康 → `station-portal` 迁移+健康 → portal 注册 healthy → reconciler 写 Traefik 动态配置 → Traefik reload → agentd 连接 SSE + 心跳 → 容器 `running`。

---

## 9. ⚠️ 待决策者确认 + 转派同步点

### 9.1 本文待决策者确认（按 principles §4 倾向，未新造数值）

| # | 事项 | 当前倾向 |
|---|---|---|
| 1 | `postgres:16` / `traefik:v3` / socket-proxy / LiteLLM 的具体 patch 号与 digest | 部署期事实，由 env §9 探测后 pin（P1 开发按 env §0，不阻塞） |
| 2 | FDE 镜像 cap 精确清单（`--cap-add` 最小集） | 以 FDE 镜像 smoke test 收敛；禁止 `NET_ADMIN`/`SYS_ADMIN`/`SYS_PTRACE` |
| 3 | 容器内用户名固定 `erix` | 固定 `erix`（user-space §2.4 同口径） |
| 4 | 日志轮转 `max-size`/`max-file` 具体值 | env §11.4 运维约定 |

### 9.2 转派同步点（本轮不改，需另开轮次）

| # | 目标文档 | 需同步 |
|---|---|---|
| S1 | `api/portal.md` §3.5 | 「改名会同步重生成端口 hostname/url」→ 改为「改名**不**重生成 hostname/url，旧 hostname 保持」（规格 §8.5 不可变性） |
| S2 | `data/model.md` §2.2 | `allocated → active` 触发条件由 `⚠️` 定案为「首次 forward-auth 放行」（规格 §8.6）；删除「runner 上报监听」先到者表述 |
| S3 | `data/schema.sql` | （可选）`users.fde_name` 加 `CHECK (fde_name ~ '^[a-z0-9][a-z0-9-]{0,62}$')`（规格 §8.5 grammar 的 `<fde>` 字符集落库）；新增 `schema_migrations` 表（§3） |
| S4 | `api/portal.md` §9（internal） | 无需新增端口上报端点（§8.6 选 forward-auth 触发，不选 runner 上报）——确认不新增即可 |
| S5 | `docs/README.md` 待补齐清单 | 新增 D8 记录本文为「P1 部署契约」已交付（原「`deploy/` 待建」仍成立，本文是 `deploy/` 的生成依据） |

---

## 10. 交叉引用

| 主题 | 位置 |
|---|---|
| 主规格（网络/端口/容器模板/分期） | [`fde-platform.md`](fde-platform.md) §5/§8/§12/§15 |
| 网络与访问拓扑（单一事实来源） | [`topology.md`](topology.md) |
| 用户空间物化（UID/权限/原子写） | [`user-space.md`](user-space.md) |
| 容器内进程/凭据/出站协议 | [`runner-integration.md`](runner-integration.md) |
| 部署参数 + 运行时参数 | [`../env.md`](../env.md) §10/§11 |
| 数据模型/状态机 | [`../data/model.md`](../data/model.md) |
