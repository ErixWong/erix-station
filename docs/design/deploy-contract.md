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
| `station-portal` | `PORTAL_IMAGE`（自构建，build context `portal/`） | `erix-station/portal:<git-sha>` 不可变 tag，部署时 pin digest | `node portal/src/cli.js serve`（零依赖 Node，Q7 已定稿 (a)） | **WP2a 起 `root`（`PORTAL_RUNTIME_UID=0`）**：materializer 需 chown 工作区（1000:1000）、写 Traefik 动态配置（600）、经 socket-proxy 调 Docker API（user-space §6.1）；compose 加固 `no-new-privileges` + `cap_drop: [ALL]`，并回加 `cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID]`（WP1 skeleton 原为 `node` 非 root，已切回） | `unless-stopped` | P1 ✅ |
| `station-db` | `DB_IMAGE`（官方 `postgres:16`） | 生产 `postgres:16.<patch>` **再 pin digest**（env §10 ⚠️） | 官方默认（`postgres`，容器内以 `postgres` 用户跑） | `postgres`（镜像内置） | `unless-stopped` | P1 ✅ |
| `station-docker-proxy`（自研 admission proxy） | 自构建（build context `deploy/fde-proxy/`，零依赖 Node） | `erix-station/fde-proxy:<git-sha>` 不可变 tag | `node deploy/fde-proxy/server.js` | `user: "0:1000"`（root 读 sock + gid 1000 穿越用户空间；`no-new-privileges` + `cap_drop: [ALL]` + `read_only`；**方法+路径白名单 12 条 + create 参数级校验**，见 §5.1） | `unless-stopped` | P1 ✅ |
| `llm-gateway`（LLM 网关） | LiteLLM（`ghcr.io/berriai/litellm` 或等价） | digest pin（Q1 未定 → ⚠️ 具体镜像/版本待决策者确认） | 官方默认 | 官方默认 | `unless-stopped` | **P3**（P1 不部署，见 §7） |
| `fde-<name>`（FDE 容器，模板化） | `FDE_IMAGE`（自构建，build context `runner/`） | `erix-station/fde:<erix-agent 版本>-<git-sha>` 不可变 tag；版本记录点 `containers.agent_version` | `station-agentd`（`docker run --init`：docker 内置 tini 作 PID 1，entrypoint **直接** exec agentd，**不重复 `tini --`**，runner §2.3 方案 (a)） | root 启动 → **drop 到 `erix-agentd`(1001)**，fork worker 切 `erix-worker`(1002)（user-space §6.1） | `unless-stopped` | P1 ✅（单实例；多 FDE = P2） |

> **P1 `MIGRATE_ON_START=0`**：baseline（`schema.sql`）与 `bootstrap.sql` 由 `station-db` **首次初始化**（`deploy/db-init/00-init.sh`，超级用户，空数据目录时）完成一次，portal 运行时以 `station_portal` 启动、不重复跑 superuser bootstrap；首个增量迁移出现时以 `station_platform`（`MIGRATE_DATABASE_URL`）跑（§3）。
>
> **镜像预拉取**：portal **不授 IMAGES**（station-docker-proxy 路径白名单仅 containers/networks，§5.1）。FDE 镜像由**宿主在部署时 `docker pull`** 预拉取（版本 pin 走 `containers.agent_version` + canary，规格 §14）；镜像升级 = 宿主预拉新 digest + 重建容器，不经过 portal 的 Docker API。
>
> **LLM 网关（P3，不入 P1 compose）的字段契约**：`llm-gateway` 接 `backend` 网络，**数据面 publish 仅 `127.0.0.1:4000`（回环，供 Traefik `llm.<base>` 路由回环访问）；admin 面不发布**（仅 `backend` 内可达，topology §6 第 6 条 / env §5）。Q1（公司是否已有网关）未定 → 已有则复用、不部署本容器；没有则 P3 起一个 LiteLLM 容器，portal 仍只做租户绑定（规格 §11.3）。

---

## 2. compose 契约（network / publish / volume / depends_on / healthcheck / env_file）

> 本节给出 **P1 四个 compose 服务**（`station-edge` / `station-portal` / `station-db` / `station-docker-proxy`）的字段级契约；`deploy/docker-compose.yml` 按此生成。FDE 容器**不在 compose 内**（由 portal 经 Docker API 动态创建，§6）。

### 2.1 网络

| 网络 | 声明方式 | 成员 |
|---|---|---|
| `backend` | compose 顶层 `networks.backend`，`ipam.config[].subnet = 172.30.0.0/24`（**显式**，不与 FDE 池 `10.200.0.0/16`/`10.201.0.0/16` 及既有 bridge 重叠，env §5.2）；**生产取值可由 `BACKEND_SUBNET` 覆盖，须避开宿主既有网段（开发期见 env.md §0）** | `station-portal` + `station-db` + `station-docker-proxy`（P1 即此四服务 + station-mock-llm 开发期） |
| `host` | Traefik `network_mode: host`（**零 docker 网络接入**，topology §2.2 D-2） | `station-edge` |

- FDE 网络 `fde-<name>` **不在 compose 内**，由 portal 经 Docker API 显式 `--subnet` 创建（§6）。
- 仅 `backend` 与 `host`；`control`/`edge` 已取消（topology §2.3）。

### 2.2 每服务字段

| 服务 | network | publish | volumes（宿主源 → 容器目标，权限） | depends_on | healthcheck | env_file |
|---|---|---|---|---|---|---|
| `station-db` | `backend` | **无**（仅 backend 内可达） | `/docker/station-db/` → `/var/lib/postgresql/data`（RW，属主由 postgres 镜像初始化） | — | `pg_isready`（见下） | `/docker/station-db/.env.db`（600） |
| `station-portal` | `backend` | **`127.0.0.1:8080:8080`**（回环，供 Traefik 反代 + forwardAuth） | ① 用户空间 `${ERIX_USERSPACE_ROOT_HOST:-/srv/erix/users}` → `/srv/erix/users`（RW，**同路径**，materializer 直写用户空间，user-space §2.2）；② 动态配置 `${TRAEFIK_DYNAMIC_DIR_HOST:-./traefik/dynamic}` → `/etc/traefik/dynamic`（RW，**单一写方**，reconciler 写 Traefik 动态配置；生产宿主目录为 `/docker/station-edge/dynamic/`，开发期默认仓库相对目录）；③ `/docker/station-edge/firewall/` → `/docker/station-edge/firewall/`（RW，600，reconciler 写 `rules.v4`，WP2b 接入防火墙时启用）。**不挂整个 `/docker/station-edge`**（Traefik 静态配置 / `acme.json` / `logs/` 不挂给 portal）。portal 自身无持久卷（状态在 DB） | `station-db`（`condition: service_healthy`）+ `station-docker-proxy`（`condition: service_started`） | `station-portal healthcheck`（见下） | `/docker/station-portal/.env.portal`（600） |

> **WP2a 开发期宿主管道路径参数**：用户空间与动态配置两个 bind mount 的宿主路径用 `ERIX_USERSPACE_ROOT_HOST` / `TRAEFIK_DYNAMIC_DIR_HOST` 注入（见 env §10），容器内路径固定（`/srv/erix/users` / `/etc/traefik/dynamic`）。（开发期指向临时目录时**建议 0755**——portal 虽已回加 `CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID`（§1），但开发期临时目录避免依赖特权位更稳；proxy 侧见 §5.1 运行身份说明。生产路径仍按本表默认（`/srv/erix/users` / `/docker/station-edge/dynamic/`）。
| `station-docker-proxy` | `backend` | **无**（仅 portal 可达；FDE 不在 backend，天然不可达） | `/var/run/docker.sock` → `/var/run/docker.sock`（**RO**） | — | 无（自研 Node 进程；靠 `service_started` 依赖） | 路径白名单见 §5.1（12 条 + create 参数级校验） |
| `station-edge` | `host` | **无**（host 网络直接监听 `TRAEFIK_WEB_PORT`/`TRAEFIK_WEBSECURE_PORT`） | ① `/docker/station-edge/traefik.yml` → `/etc/traefik/traefik.yml`（RO）；② `/docker/station-edge/dynamic/` → `/etc/traefik/dynamic/`（RO，**与 portal 共享宿主目录、Traefik 侧只读**）；③ `/docker/station-edge/acme.json` → `/acme.json`（RW，**600**，**仅 Traefik 读写、不挂给 portal**）；④ `/docker/station-edge/logs/` → `/var/log/traefik/`（RW，**仅 Traefik、不挂给 portal**） | —（host 网络独立启动；路由在 portal 就绪后自然可用） | 无（`--api=false` 关闭 ping；靠 restart policy + reconciler 对账兜底，§8） | `/docker/station-edge/.env.edge`（600，含 ACME/DNS-01 凭据，经环境变量注入、**不进 traefik.yml**） |

> **`station-db` 容器加固（与其它三服务一致）**：`security_opt: [no-new-privileges]` + `cap_drop: [ALL]`，并显式回加 postgres 初始化所需的最小 capability `CHOWN` / `DAC_OVERRIDE` / `FOWNER` / `SETGID` / `SETUID`（官方入口以 root 启动、chown 数据目录后用 gosu 降权到 `postgres`）。已用空卷起栈验证 DB 可完成首次初始化（建库/应用 schema/设角色口令）并 healthy。

### 2.3 healthcheck 命令与阈值（写死）

| 服务 | test | interval | timeout | retries | start_period |
|---|---|---|---|---|---|
| `station-db` | `["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]` | 5s | 5s | 10 | 10s |
| `station-portal` | `["CMD", "station-portal", "healthcheck"]`（等价 `wget -qO- http://127.0.0.1:8080/api/health` 返回 200） | 10s | 5s | 5 | 30s |
| `station-edge` | 无（见 §2.2；`--api=false` 下无 in-band ping） | — | — | — | — |
| `station-docker-proxy` | 无（`service_started` 依赖即可） | — | — | — | — |

> portal healthcheck 语义：`/api/health` 返回 200 当且仅当「DB 可达 + 迁移已到 head（§3）+ 无致命初始化错误」——这使 `depends_on: station-db (service_healthy)` 传递的 readiness 链成立（§8）。

### 2.4 `env_file` 约定与凭据注入

- **P1 落地**：`deploy/docker-compose.yml` 经 **`deploy/.env`（600 权限，不入库）** 的 compose 变量插值注入全部环境变量；**口令不写死、不进 compose 正文、不进仓库**（`deploy/.env.example` 只含占位 `change-me-dev-only`）。部署期可再把凭据拆到宿主 600 文件（`/docker/<名称>/.env.<名称>`）由 `env_file` 引用（项目 AGENTS.md §6，env §6）。
- **portal 的三个连接身份（口令均经 600 权限 `deploy/.env` 注入）**：

  | 身份 | 环境变量 | 角色 | 用途 |
  |---|---|---|---|
  | 运行时 | `DATABASE_URL` | `station_portal`（最小 DML GRANT） | portal 业务读写 |
  | 迁移 | `MIGRATE_DATABASE_URL` | `station_platform`（DDL/表 owner） | 增量迁移 `deploy/migrations/*.sql` |
  | bootstrap | `BOOTSTRAP_DATABASE_URL` | 超级用户（`POSTGRES_USER`） | schema.sql/bootstrap.sql 的角色/授权/ownership（仅 bootstrap 步骤用） |

- `DB_PASSWORD`（超级用户 `POSTGRES_PASSWORD`）部署时生成、存 600 权限 `deploy/.env`（env §10）；生产环境所有 `change-me-dev-only` 占位必须改掉。
- LLM 虚拟 key **不进任何 env_file/容器**：真实 key 只存在于 portal 经 reconciler 写出的宿主 Traefik 动态配置（600，portal 可写、Traefik 只读，topology §6 第 8 条）。

---

## 3. DB 初始化与 migration 机制

### 3.1 谁执行、怎么幂等

> **P1 实际执行方（与 `deploy/db-init/00-init.sh` 对齐）**：P1 walking skeleton 下 baseline（`schema.sql`）与 `bootstrap.sql` 由 `station-db` **首次初始化**（空数据目录时，超级用户）完成一次，portal 以 `MIGRATE_ON_START=0` 启动、不重复跑 superuser bootstrap。`00-init.sh` 顺序：① 应用 `schema.sql`（baseline）→ ② `ALTER ROLE ... PASSWORD` 设 `station_platform`/`station_portal` 口令（来自 600 权限 `deploy/.env`）→ ③ 回填 baseline 哨兵 checksum 为真实 `sha256(schema.sql)` → ④ 应用 `bootstrap.sql`（schema 授权 + 表/序列 ownership 归正到 `station_platform`）→ ⑤ 收紧跨库 CONNECT。

- **baseline = [`../data/schema.sql`](../data/schema.sql)**（可执行建表 DDL，单事务 `BEGIN;…COMMIT;`，**自包含**：开头幂等创建 `station_platform` / `station_portal` 两个角色，空库 `psql -f` 可单独执行，不依赖 bootstrap）。
- **migration runner**：`portal/src/migrate.js` 以 advisory lock 串行化，按序应用 baseline → bootstrap → `deploy/migrations/*.sql`（文件名升序），幂等、失败可恢复。**P1 默认 `MIGRATE_ON_START=0`**（baseline/bootstrap 已由 db-init 完成）；当 `MIGRATE_ON_START=1` 时 portal 在**监听端口之前**跑迁移，迁移角色 `station_platform`（DDL），运行时角色 `station_portal`（DML 最小 GRANT）。
- **幂等**：新增 `schema_migrations` 表（`version text PK, checksum text, applied_at timestamptz DEFAULT now()`）。每个迁移文件在**单事务**内执行，成功后插入 `schema_migrations` 行；已存在的 `version` 跳过。`schema.sql` 作为 `version='0000_baseline'` 只在空库首次应用（已有 `schema_migrations` 则不再重放 baseline）。
- **顺序**：baseline → `deploy/migrations/0001-*.sql` → `0002-*.sql` …（文件名编号升序）。每次新增 DDL 都写成新编号迁移文件，**不修改已应用的迁移**（改历史迁移会破坏 checksum 一致性）。

### 3.2 失败与回滚

- 每个迁移在 Postgres **单事务**内执行（DDL 在 PG 中事务性）→ 失败整体回滚该迁移，`schema_migrations` 不写该行，**不产生半套 schema**。
- 迁移失败 → portal **拒绝启动**（不进入 unhealthy 的假就绪），`/api/health` 返回 503 + 明确错误码 `migration_failed`（§8 readiness）。
- 迁移文件带 `checksum`：已应用迁移的文件内容被改动 → checksum 失配 → 拒绝启动 + 告警（防「改历史」）。
- **数据迁移**（有损/大表 rewrite）必须显式 `SET lock_timeout` + 幂等（`IF NOT EXISTS` 等），遵循 env §11.2 的 `statement_timeout`/`lock_timeout` 基线；超时则回滚重试，不硬等锁。

### 3.3 `docs/data/schema.sql` 的应用方式

- **空库**：P1 由 `deploy/db-init/00-init.sh`（超级用户）执行，顺序见 §3.1；也可手动以超级用户 `psql -f docs/data/schema.sql`（自包含：开头幂等创建角色 → 建表 → 落 `0000_baseline` → 授最小 DML GRANT），记录 `0000_baseline`。
- **生产/P1**：baseline 由 db-init 超级用户完成；随后 `bootstrap.sql` 做 schema 级授权 + 表/序列 ownership 归正到 `station_platform` + 角色属性兑底（超级用户，可重复执行）；增量迁移以 `station_platform`（`MIGRATE_DATABASE_URL`）跑。
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
- **写边界（B5）**：portal 只 RW `dynamic/` 与 `firewall/` 两个子目录；`traefik.yml`（静态）、`acme.json`、`logs/` **不挂给 portal**（§2.2）。Traefik 对 `dynamic/` 只读、对 `acme.json` 单独 RW（600，仅 Traefik）、对 `logs/` RW（仅 Traefik）。
- 动态配置内容（P1 最小集）：portal 路由 + internal 路由（`Host(station.<base>) && PathPrefix(/api/internal)` + `ipAllowList` 由 `fde_networks` 精确派生）+ `fde-auth` forwardAuth 中间件（P2）。**P1 不含预览路由、不含真实 LLM 注入路由**（§7）；仅 P1 开发期可**可选启用** dev-only LLM mock 路由（`llm.<base>` → 回环 mock，§7.3 选项 1，零真实凭据）。
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

**选定：proxy**（不直挂 `docker.sock`）。**现行实现为 §5.1 的自研 admission proxy（`station-docker-proxy`）**；本节 tecnativa 方案表仅作历史记录（已被 §5.1 替换）。

| 项 | 取值 |
|---|---|
| 镜像 | 历史记录：`SOCKET_PROXY_IMAGE` = `tecnativa/docker-socket-proxy`（**已废弃**，见 §5.1） |
| 挂载 | `/var/run/docker.sock` → `/var/run/docker.sock`（**RO**） |
| API 白名单 | `CONTAINERS=1`、`NETWORKS=1`、`POST=1`，**其余全 0**（`IMAGES/EXEC/SYSTEM/AUTH/SECRETS/BUILD/COMMIT/PLUGINS/SWARM/INFO/VOLUMES/…`）；`POST=1` → **放行 containers/networks 生命周期所需的非 GET 方法**（WP2b 起，portal 经此创建/启动/停止/删除 FDE 容器） |
| 加固 | `--security-opt no-new-privileges` + `cap_drop: [ALL]` + `read_only`（`/tmp`、`/run`、`/var/lib/haproxy` 走 tmpfs）；不 publish、仅 `backend` 网络 |
| portal 连接 | `DOCKER_HOST=tcp://station-docker-proxy:2375` |

> **WP2b 已放开（portal 经 socket-proxy 实际可用的 Docker API）**：`POST=1` 下放行 `CONTAINERS=1`/`NETWORKS=1` 两个类别内的全部方法——`/_ping`、`/version`、`/containers/json`、`/containers/create`、`/containers/{id}/json`、`/containers/{id}/start|stop`、`DELETE /containers/{id}`、`/networks`、`/networks/create`、`/networks/{id}`、`DELETE /networks/{id}`。**真正的路径级最小面由 portal 侧代码层白名单兑底**（见下「实现偏差」）。

### 5.1 ✅ 自研 admission proxy 实现了契约的路径级+参数级白名单

> **已替换 tecnativa/docker-socket-proxy**：自研零依赖 Node admission proxy（`deploy/fde-proxy/server.js`，compose 服务 `station-docker-proxy`）落地 §5 的「路径级最小面」意图——**方法+路径白名单（12 条契约路径）+ POST /containers/create 参数级策略校验**，不再依赖「socket-proxy 类别级 + portal 代码层」的软边界。

（历史记录，供上下文：）对 `tecnativa/docker-socket-proxy:v0.5.0` 的 haproxy 模板实测确认：

- **`POST` 是一个全局方法门**：模板首行 `http-request deny unless METH_GET \|\| { env(POST) -m bool }`——`POST=1` 放行**所有**非 GET 方法，**没有**「按 endpoint 类别/路径区分 POST」的粒度，因此无法在该镜像上用 env 表达路径级 POST 白名单。

**自研 proxy 落地（真正安全边界）**：

- **路径白名单（12 条）**：`GET /_ping`、`GET /version`、`GET /containers/json`、`POST /containers/create`、`GET /containers/{name}/json`、`POST /containers/{name}/start|stop`、`DELETE /containers/{name}`、`GET /networks`、`POST /networks/create`、`GET /networks/{name}`、`DELETE /networks/{name}`；其余路径一律 403。
- **create 参数级校验（§5 B6，在 proxy 内强制）**：拒绝 `Privileged` / `PidMode=host` / `NetworkMode=host`；`PortBindings` 必须空；`CapDrop` 必须含 `ALL`；`SecurityOpt` 必须含 `no-new-privileges`；binds source 必须在 `USERSPACE_ROOT` 之下且不含 `docker.sock`；`Image` 必须匹配 `IMAGE_ALLOWLIST` 前缀（env 可配）。不合规 → 403 + 理由。
- **运行身份**：`user: "0:1000"`——uid 0（root）以 owner 权限读写 `docker.sock`（宿主 `root:docker` 660）；gid 1000（erix 组）以 group 权限穿越 2770 用户空间目录。`cap_drop: ALL` 下 root **无 `DAC_OVERRIDE`**，必须靠组权限才能 `realpath` 校验 bind source（防 symlink 逃逸），否则 2770 目录（other=---）会 `EACCES` 导致 bind 校验误判「not resolvable」。
- **其余放行路径原样转发（含流式）**。

**白名单理由（每项都对应 portal 实际所需的最小面）**：

- `CONTAINERS`：FDE 容器生命周期（create/start/stop/rm/inspect/ps）——portal 核心职责。
- `NETWORKS`：FDE 网络生命周期（`network create --subnet` / inspect / ls / rm），onboarding/offboarding。
- **删除 `VOLUMES`**：portal 用 **bind mount** 而非 docker volume（user-space §2.2 的四条宿主路径），不需要 `VOLUMES` API（`inspect/ls` 卷观察无必要、且多一个被攻破后可枚举宿主卷的面）。
- **不授 `IMAGES`**：FDE 镜像由宿主部署时预拉取（§1），portal 不需要、也不应能拉任意镜像（防被攻破后拉恶意镜像）。
- **不授 `EXEC`**：portal 被攻破后 `docker exec` 进任意容器 = 跨信任边界提权（违反不变式一）。
- **不授 `SYSTEM`/`AUTH`/`SECRETS`**：防读宿主 docker 配置/凭据/secret。
- **不授 `BUILD`/`COMMIT`**：防镜像篡改/逃逸面。

> **参数级约束（B6：`POST /containers/create` 参数级 allowlist 已在 admission proxy 内强制，不再依赖 portal 代码层）**：真正的最小面 = proxy 在 `POST /containers/create` **之前**强制校验的创建字段 allowlist——
>
> - **镜像**：只允许**预拉取的 `FDE_IMAGE` digest**（`image@sha256:…`，env §10）；拒绝任何 tag-only / 其它镜像 / `image` 为空。
> - **网络**：只允许 `fde-<name>`（本 FDE 的网络名，与 `fde_networks.network_name` 一致）；拒绝 `backend` / `host` / `bridge` / 其它网络名。
> - **bind mount**：白名单 = `USER_SPACE_ROOT/<fde>/{home,projects,worktrees,cache}` 四条宿主源（user-space §2.4 / §6.4）；拒绝其它宿主路径（尤其 `/var/run/docker.sock`、`/docker/**`、`/`）。
> - **禁止项（硬拒绝）**：`--privileged`、`--pid=host`、`--network=host`、`--device`、`--cap-add` 超出 §6.2 白名单、`--security-opt` 以外的任意 security 选项、`--publish`（`-p`）。
> - **`--ip`**：只允许该 FDE `/29`（或 `/28`）内的固定位（`.2`）；其它 IP 拒绝。
>
> **被攻破时的爆炸半径**：portal 被攻破后，攻击者经 admission proxy **至多**能「在已授权 FDE 位点用 `FDE_IMAGE` digest 起一个满足 allowlist 的容器」——即**该 FDE 自己的 /29 内的资源滥用 + 可读该 FDE 的 bind mount**；**不能**拉任意镜像、`exec` 进其它容器、publish 端口、挂 `docker.sock`、`privileged`/host PID/host network 逃逸宿主、改其它网络/卷。**跨 FDE 与宿主逃逸被 allowlist 挡住**；纵向提权（`EXEC`/`SYSTEM`/`AUTH`/`SECRETS`）被 proxy 路径白名单挡住。残余风险 = 单个被攻破 FDE 的数据面（原理四：FDE 自损本就接受，见 runner §11.3）。

> **残余风险（第三轮加固，记录不改代码）**：
> 1. **bind TOCTOU**：proxy 校验 bind source 后、Docker 真正挂载前，宿主路径可能被换成 symlink。触发前提是攻击者能改宿主 bind source（portal 被攻破才可，FDE 用户无法触达 proxy——FDE 只接自己的 `/29`，不在 `backend`）。记为已知残余风险。
> 2. **生命周期对象替换竞态**：inspect 通过后、按名 start/stop/rm 前，同名对象可能被替换（inspect-后-按名操作竞态）。同上，攻击者须能改 proxy 可见的 Docker 对象（= portal 被攻破），归入同一类别。

> FDE 容器**永不挂 `docker.sock`、也访问不到 admission proxy**（FDE 只接自己的 `/29`，不在 `backend`）。

---

## 6. FDE 容器创建契约（portal 经 Docker API，模板化）

> ⚠️ **WP2b 已交付**：portal 经 socket-proxy（`POST=1`）创建/启动/停止/删除 FDE 容器；本节字段级契约为 `portal/src/provisioner.js` 的实现依据（创建字段 allowlist 见 §5 B6）。
>
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
| `--init` | `true`（docker 内置 tini 作 PID 1，reap + 信号转发；**entrypoint 不再重复 `tini --`**，避免双重 init） | runner §2.3 方案 (a) |
| `--restart` | `unless-stopped` | 规格 §14 |
| entrypoint/command | `station-agentd`（**直接** exec；`--init` 的 tini 已是 PID 1，agentd 为 PID 2） | runner §2.3 |
| env | `ERIX_STATION_TOKEN`（per-container token，建容器时生成、**仅存哈希入 DB**、原文注入容器 env，runner §4.4）；`ERIX_STATION_BASE_URL=https://station.<base>/api/internal`；`ERIX_FDE_NAME=<name>` | runner §4.1 |
| `--security-opt` | `no-new-privileges` | topology §6.2 |
| `--cap-drop` / `--cap-add` | `--cap-drop ALL`，回加运行必需最小集（`SETUID`/`SETGID`/`CHOWN`/`DAC_OVERRIDE`/`FOWNER`/`CAP_KILL`）：前五项供 root 启动后 drop 到 1001、fork worker 切 1002、chown 工作区；**`CAP_KILL` 供 agentd（UID 1001）在 lease lost / stop 时对 worker（UID 1002，不同 UID）发 `SIGTERM`/`SIGKILL`**（跨 UID `kill(2)` 需 `CAP_KILL`，runner §2.4/§6.4/§6.5）。**不授 `NET_ADMIN`/`SYS_ADMIN`/`SYS_PTRACE`** | topology §6.2 / runner §11.3 |
| seccomp/AppArmor | 保持默认 profile | topology §6.2 |
| 资源限额 | `--memory` 等由 portal 经 Docker API 设置（规格 §14；具体数值 ⚠️ 按 FDE 规模定） | 规格 §14 |

> **PID 1 / 信号 / 僵尸回收（B12 定案：单一 init，不双重 init）**：`--init=true` 由 docker 注入 tini 作 PID 1，entrypoint/command 直接 `station-agentd`（PID 2）。stop/restart 行为：`docker stop` 对 tini 发 `SIGTERM` → tini 转发给 agentd → agentd 对在跑 worker `SIGTERM`（5s 宽限）→ `SIGKILL`（runner §2.4）；`unless-stopped` 下 agentd 崩 → 容器退出 → docker 拉起。**僵尸回收验证（smoke test，testing.md §3.8）**：`docker exec fde-<name> ps -ef` 断言无 `<defunct>`（dev server 退出由 tini reap，不留 zombie）。
>
> **`CAP_KILL` 与 `no-new-privileges`（B7）**：容器以 root 启动、随后 drop 到 UID 1001；`setuid(1001)` 默认会清空 effective/permitted capability，故 agentd 在 drop 前须 `prctl(PR_SET_KEEPCAPS, 1)`，drop 后再 `capset()` 把 effective 集收敛为仅 `CAP_KILL`（如还需）——否则跨 UID kill worker 会 `EPERM`。`no-new-privileges` **不禁止**该机制（`PR_SET_KEEPCAPS` 只保留 bounding set 内已授能力、非提权）；若实现不保留 `CAP_KILL`，则须改同 UID / supervisor 模型（runner §11.3 备选）。跨 UID signal 的 smoke test 见 testing.md §3.8。

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

- **4 个 compose 服务**：`station-edge`（Traefik，host 网络）+ `station-portal` + `station-db` + `station-docker-proxy`（P1 即此四服务 + station-mock-llm 开发期）（§2）。
- **单 FDE 容器**（含 `station-agentd`/`station-runner`/erix-agent）✅ **WP2b 已交付**：FDE 容器的动态创建（portal 经 Docker API + socket-proxy，§6）由 `portal/src/provisioner.js` 实现（开发期默认 `traefik/whoami` 站台，生产切 runner 镜像）。
- **登录**（本地账号 + `crypto.scrypt` 口令哈希（P1 骨架，argon2id 待决策者确认后按自描述哈希平滑迁移，portal §2.9.4）+ 强制 TOTP，bootstrap CLI，portal §2.9）、**项目列表/创建**（含项目级**单端口**分配 + `ports.json` 物化，规格 §8.2/§8.5）、**对话（SSE）**、**停止**。
- **internal API**（agentd ↔ portal 全出站通道）+ **防火墙应用**（§4.4）+ **DB 迁移**（§3）。
- P1 验收 = 规格 §15 P1 行「登录→建项目→对话→工具卡片→停止」。

### 7.2 P1 不包含 + 部署方式

| 项 | 归期 | P1 部署方式 |
|---|---|---|
| **预览 / IDE iframe**（`*.fde.<base>` 浏览器访问 + forwardAuth 预览凭证 ticket/cookie） | P2 | **不部署预览路由**：不发布 `*.fde.<base>` 预览路由。预览凭证代码已就绪（WP2b 已实现签发/校验/`allocated→active`，portal.md §2.8），P1 仅不启用（fail-closed：路由表无预览路由 = 不可达）；端口分配照常落 DB |
| **多 FDE** | P2 | 只部署单 FDE（`fde-<name>` 仅一个） |
| **run 级端口块 + 事件重放 UI** | P2 | 只做项目级单端口（规格 §8.2）；run 级端口分配/URL 带 runId 不启用 |
| **工具审批** | P2 | **完全不部署**审批单/审批 UI/审批中转（tools 直接执行；judge 拦截链 P2 再接，runner §10 端点 P2 才启用） |
| **SSO / OIDC** | P2 | **不部署** OIDC（P1 恒 `auth_source=local`，env §4/portal §2.1） |
| **LLM 网关（模式 C）+ 用量记账 + code-server 模板** | P3 | **不部署真实 LLM 网关、不写真实虚拟 key**。P1 对话验收用**无真实凭据的 OpenAI-compatible mock/test gateway**（dev-only helper，见 §7.3），容器仍只持占位 key + `endpoint`（topology D-4 红线**无豁免**）；真实 LLM 网关（LiteLLM）+ 用量记账 + code-server 模板归 P3 |
| **通知通道**（邮件/IM webhook） | P2+ | 不部署；告警**状态**（`failed`+code）P1 落库可查（规格 §14 / user-space §7.3） |
| **备份/高可用** | 系统级方案（issue #3） | 不部署；平台只保证数据落卷、DB 处于可被系统级备份的形态（规格 §14） |

### 7.3 P1 对话验收的 LLM mock 网关（dev-only，零真实凭据）

> 红线（topology D-4 / 规格 §11.4）：容器内**零真实 LLM 凭据**——P1 **也不例外**。已删除「`LLM_DEV_BASE_URL` + `LLM_DEV_API_KEY` 注入容器」的临时豁免路径：**任何真实 LLM key 都不经 portal env 注入、不进 `config.json`、不进容器 env/镜像**。

- **mock 网关是什么**：本地运行的 **OpenAI-compatible `/v1/chat/completions` mock**（返回 canned/流式 SSE 响应，✅ WP3a 已实现虚拟 key 形态校验 `erix-*` 与流式/非流式；可注入 `429 rate_limited` 或错误码以测错误映射，testing.md §3.9），**不含任何真实 LLM key、不访问任何上游 LLM**。
- **部署位置（dev-only helper）**：✅ **WP3a 已落地为独立 compose 服务 `station-mock-llm`**（`portal/mock-gateway/`，零依赖 Node，数据面 publish 仅宿主回环 `127.0.0.1:${LLM_GATEWAY_PORT:-4000}`，read_only + cap_drop:ALL 加固）；**不进生产**（P3 由真实 `llm-gateway` 占据该回环端口，env §5）。开发期随 `docker compose up -d` 一起拉起，无需手动启动。
- **如何满足「经 Traefik 注入」链路（二选一）**：
  1. **完整演练注入链（推荐）**：P1 开发期**可选启用** `llm.<base>` 路由（与 P3 同形态：`Host(llm.<base>) && ClientIP(<该 FDE 精确 subnet>)` → headers middleware 覆盖 `Authorization` → service 回环 `127.0.0.1:4000`），但注入的是 **mock 哨兵值**（如 `Authorization: Bearer erix-mock`，非真实 key，mock 只校验/忽略该值）；容器 `--add-host llm.<base>:<本 FDE 网关 IP>`、`config.json` 占位 key + `endpoint=https://llm.<base>/v1` 与 P3 **完全一致**。这样 P1 即演练「ClientIP 判身份 → 覆盖伪造 Authorization → 回环到网关」的完整链路，**全程零真实凭据**。
  2. **mock 模式简化（⚠️ 待决策者确认）**：P1 不启用 `llm.<base>` 注入路由，`config.json` 的 `endpoint` 直接指向 mock 回环（容器经 `--add-host` 映射宿主 mock 地址）+ 占位 key。此简化不演练注入链，但**仍满足零真实凭据红线**（占位 key + mock，无真实 key）。生产/P3 一律回到选项 1 的完整链。
- **红线不变**：无论哪个选项，容器 env/文件/镜像里**绝不出现**任何真实 LLM key（`LLM_DEV_API_KEY` 一类变量**删除**）；mock 网关自身也不持有真实 LLM key。凡「P1 开发期临时豁免」的表述一律作废。

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
| S2 | `data/model.md` §2.2 | ✅ 已落地：`allocated → active` 定案为「首次 forward-auth 放行」（model.md 已改为定稿口径） |
| S3 | `data/schema.sql` | ✅ 已落地：`users.fde_name` CHECK 与 `schema_migrations` 表均已入库 |
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
