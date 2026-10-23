# 测试与验收契约（testing.md）

> 状态：**契约基线（补齐「阻塞 P1 交付」的 D5 缺口）**
> 依据：全局约定 [`~/projects/AGENTS.md`](../../../projects/AGENTS.md) §2.2/§2.3/§3.2（下称「全局 §x」）、[`fde-platform.md`](design/fde-platform.md)（主规格，下称「规格 §x」）、[`topology.md`](design/topology.md)（H-B 拓扑单一事实来源，下称「topology §x」）、[`user-space.md`](design/user-space.md)（用户空间物化契约，下称「user-space §x」）、[`deploy-contract.md`](design/deploy-contract.md)（P1 部署契约，下称「deploy §x」）、[`runner-integration.md`](design/runner-integration.md)（容器内进程模型，下称「runner §x」）、[`portal.md`](api/portal.md)（portal API 契约，下称「portal §x」）、[`schema.sql`](data/schema.sql) + [`model.md`](data/model.md)（数据模型，下称「schema.sql §x」/「model §x」）、[`env.md`](env.md)（部署参数，下称「env §x」）。
>
> **本文只定义「测什么、怎么测、什么算过」的契约与可执行验收方案，不写实现代码。** 每条命令都是本机可执行的（Node 22/24、`~/.dotnet`、python venv、docker 用 `sg docker -c '...'`、psql 用 `postgres:16` 镜像），不出现伪命令。凡涉及「目标环境事实」的安全回归用例，本文区分「本机开发可跑」与「必须目标环境真机跑」两档，避免假通过。
>
> 全局约定（全局 §3.2）：**语法/编译保底 → 单测全绿 → 浏览器验证（playwright 截图 → vision 读图）**。本机无真实浏览器，浏览器验证用 Playwright MCP（全局 §2.2）+ vision MCP（全局 §2.3）。

---

## 0. 三条不变式（验收红线，先看）

验收的最终判据是仓库 [`README.md`](../README.md) 的三条不变式是否成立，任何测试若只验证到实现细节而没守住这三条，都不算过：

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥。
2. **ingress 是唯一的路**：任何「绕过 Traefik 也能访问」的路径都是 bug。
3. **DB 是状态的真相**：容器是牲口，重建后必须能从 DB + 卷恢复。

每条必测清单（§3）都标注它守的是哪条不变式。

---

## 1. 测试分层与命令表

### 1.1 分层总表

| 层 | 目标 | 运行环境 | 命令（本机可执行） | 预期耗时 | 判定标准 |
|---|---|---|---|---|---|
| **语法/编译保底** | 改动即查，零依赖 | 宿主 Node 22/24 | `node --check <file>`（JS）；`~/.dotnet/dotnet build`（.NET，当前项目无 .NET 代码，仅占位） | <1s/文件 | 退出码 0，无输出 |
| **单测（unit）** | 纯逻辑：seq 分配、幂等键、hostname grammar、revision CAS、manifest 校验、暴露矩阵判定 | 宿主，`node --test` | `npm test`（项目 AGENTS.md §4）；需 `await using` 的测试加 Node 24：`PATH=~/.local/node24/bin:$PATH npm test` | 秒级 | 全绿（退出码 0），0 failed |
| **集成（integration）** | 真实 Postgres + 临时 docker 网络 + 伪造 FDE 容器，验证 DB 约束/路由/物化/租约 | 宿主 + 临时 `postgres:16` 容器 | §2.2 的临时栈命令 | 分钟级 | 每条断言有明确 exit code / 输出匹配 |
| **端到端（e2e）** | 真机走通「登录→建项目→对话→工具卡片→停止」 | 本机 docker compose 平台栈 + Playwright MCP | §1.4 P1 验收清单 + §3.7 浏览器流程 | 十分钟级 | 截图 + vision 读图确认 + 关键断言通过 |
| **安全回归（security）** | 网络隔离 / 认证 / 凭据红线，**必须真机** | 目标环境（部分可在本机开发环境跑通，见 §3.1） | §3.1/§3.2 命令 | 分钟级 | 逐条对应 topology §6.1 验收矩阵 |

> **当前仓库状态（前置条件，B8）**：`portal/`、`runner/`、`deploy/` 已落地（含 `package.json`）。§1 的代码类命令（`npm test`、`node --check <文件>`）现可运行；本文命令随实现演进，**以仓库现状为准**。
> 单测数量会随开发漂移，**不要把它当验收依据**——只看退出码与 failed 数。2026-10-08 快照：根 `npm test` **731 项 / 730 通过 / 1 跳过**、`runner/` **126 全绿**、`portal/frontend/` **302 全绿**（+ `vue-tsc`）。

### 1.2 分层命令与判定

#### 1.2.1 语法/编译保底

```bash
# 每个改动过的 JS 文件（变量为占位，实现落位后用真实路径替换）
PORTAL_JS="portal/src/foo.js"   # ⚠️ 模板占位：文件尚不存在，落地后换成真实改动文件
RUNNER_JS="runner/src/bar.js"   # 同上
node --check "$PORTAL_JS"
node --check "$RUNNER_JS"
# 期望：退出码 0、无 stderr/stdout
```

判定标准：`node --check` 对零依赖 Node ESM 文件只做语法校验；任何语法错误 → 立即修复，不进入下一步（全局 §3.2 保底）。

#### 1.2.2 单测

```bash
cd /home/eric/projects/erix-station
# ✅ 前置条件已满足：portal/ 与 package.json 已落地（数量见 §1.1 注，以实际输出为准）
npm test                                    # 默认 Node 22
PATH=~/.local/node24/bin:$PATH npm test     # 若测试用到 await using（Node 24）
```

判定标准：`node --test` 全绿。单测只测**纯逻辑**，禁止触碰真实 docker/DB/宿主路径（§2.1 隔离约定）。

#### 1.2.3 集成（临时栈）

临时栈起停命令见 §2.2。集成测试用 `node --test` 或独立脚本驱动，但**必须**满足 §2.2 的隔离与清理约定；判定 = 测试进程退出码 0 + 临时资源（容器/网络/数据卷）已清理（§2.2.4）。

#### 1.2.4 安全回归

安全回归用例（§3.1/§3.2）**不能只写单测**——它们验证的是「容器网络/宿主防火墙/边缘认证」的真实行为，必须在真实 docker 网络与真实 Traefik/portal 栈上跑。本机可跑的部分用 `sg docker -c '...'` 起真容器验证；目标环境事实部分（如宿主是否真的跑了 `gitea:3000`/`mssql:1433`/`portainer:9000`）必须**目标环境实测**（topology §6.1「验收矩阵（目标环境实测，逐项打勾）」）。

### 1.3 运行环境约束（本机事实，已实测）

| 项 | 事实 | 命令依据 |
|---|---|---|
| Node | v22.23.2（`node`）+ v24.19.0（`~/.local/node24/bin/node`） | 本机实测 |
| .NET | `~/.dotnet/dotnet` = 8.0.424（本项目无 .NET 代码，占位） | 本机实测 |
| Docker | 29.1.3，需 `sg docker -c '...'`（`eric` 已在 docker 组，旧会话需重登） | 全局 §2.3 |
| Compose | `docker compose` = 2.40.3 | 本机实测 |
| psql | 宿主无 `psql`，统一用 `postgres:16` 镜像（`docker exec -i <容器> psql ...`；`postgres:16` → psql 16.15） | 本机实测 |
| 已拉镜像 | `postgres:16`、`traefik:v3`、`traefik/whoami:latest`、`nginx:alpine`、`curlimages/curl`、`alpine`、`mcr.microsoft.com/playwright/mcp` | 本机实测 `docker images`（`curlimages/curl` / `alpine` 供 §2.2.3/§3.1 的隔离/连通用例，使用前先 pull，见 §2.2.3） |
| 宿主已占用端口 | 80/443（nginx_reverse_proxy）、8080（gitea_act_runner）、5432、9000（portainer）、3000（gitea）、1433（mssql）——开发期入口用 env §0 的 8443/8090 | 本机实测 `ss -tlnp` / `docker ps` |

### 1.4 阶段可执行验收清单（P1 / P2 / P3）

> 分期口径 = 规格 §15 + deploy §7（P1 范围声明）。每条给「命令 + 期望输出 + 判定标准」；命令只列验收动作，契约细节引用 §3 对应小节，**不在此重复定义**。

**P1（登录→建项目→对话→工具卡片→停止；单 FDE；无预览/LLM/SSO/审批）**

| # | 验收项 | 命令 | 期望输出 | 判定标准 |
|---|---|---|---|---|
| P1-1 | 语法 + 单测 | `node --check <改动文件>`；`npm test` | 退出码 0、全绿 | §1.2.1/§1.2.2 |
| P1-2 | schema.sql 空库可执行 | §2.2.2 命令 | `COMMIT`、退出码 0 | 无 `ERROR`（§2.2.2） |
| P1-3 | 临时栈集成 + 清理 | §2.2 全套 + 清理断言 | 测试通过 + 无 `station-test-*` 残留 | 退出码 0（§2.2.4） |
| P1-4 | internal token 拒绝路径 | §3.2 C1/C2/C3/C6 | 401/403 各分支 | 逐条匹配（§3.2 C） |
| P1-5 | 幂等/崩溃核心 | §3.4 R4/R6/R7/R10/R11 | 无重复事件 / CAS 拒旧 / fence 旧写 / `run_end` 唯一 | 逐条匹配（§3.4） |
| P1-6 | 网络隔离（本机可跑） | §3.1 N1–N3/N6 | N1 通、N2/N3 拒、N6 通（N4 归 P2） | 逐条匹配（§3.1） |
| P1-7 | 真机主链路 | §3.7.1 playwright + vision | 登录→建项目→对话→工具卡片→停止 | 截图可读 + 无致命 console（§3.7.1） |
| P1-8 | contract-tests 接入 | §3.6.3 | 导出面正确 + 深路径 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 接入（§3.6.3） |

**P2（多 FDE、run 级端口分配+预览、事件重放、工具审批、账号生命周期）**

> 端口分期口径（规格 §8.2/§7.1）：**项目级端口（1 个/项目）归 P1**，**run 级端口（块内 7 个/run）+ 预览归 P2**——P1 验收已覆盖项目级端口分配。

| # | 验收项 | 命令 | 期望输出 | 判定标准 |
|---|---|---|---|---|
| P2-1 | 预览 ticket/cookie 全分支 | §3.2 B1–B9 | 401/403/404 各分支 + 不泄露 portal cookie | 逐条匹配（§3.2 B） |
| P2-2 | FDE A 无法访问 FDE B | §3.1 N4（多 FDE 真机） | 拒 | topology §7 |
| P2-3 | 断线重连不漏事件 | §3.7.2 | `Last-Event-ID` 补发、seq 无空洞 | §3.7.2 |
| P2-4 | 路由发布端到端 | §3.5 T1–T3 | 生成 router+service、原子替换、失败保留上一版 | §3.5 |
| P2-5 | 工具审批 + 超时 `expired` | §3.6.2 U10/U11 | 审批决定 / 10min 超时 / 迟到决定 `409` | §3.6.2 |
| P2-6 | 账号生命周期 workflow | onboarding/offboarding 脚本（规格 §7.2/§7.3） | 建子网/起容器/分配端口/物化 + 停容器/吊销 | 脚本走通 |

**P3（LLM 网关 + 用量记账 + 审计）**

| # | 验收项 | 命令 | 期望输出 | 判定标准 |
|---|---|---|---|---|
| P3-1 | LLM 注入（来源子网→身份） | topology §4-L7 实测（§10 证据 8） | A 子网拿 alice key、伪造 Authorization 被覆盖、无匹配 404 | topology §10 证据 8 |
| P3-2 | 成本按客户项目归集 | 拉网关用量 → `usage_ledger` | `source='gateway'` 行、按 `key_alias`/`project_id` 归集 | model §5 |
| P3-3 | 改 endpoint 无效 | 出口策略实施后实测 | 外部 LLM 域名不可达、仅 `llm.<base>` 可达 | 规格 §11（安全团队策略依赖，issue #3） |
| P3-4 | 审计 | `audit_log` 查询（关键动作：登录/端口分配/预览授权/LLM 调用） | 关键动作落审计、可检索 | 规格 §14 |

---

## 2. 隔离约定

### 2.1 单测隔离（硬规则）

单测必须满足：

1. **路径参数注入**：任何涉及用户配置、容器网络、bind mount、宿主路径（`/srv/erix/users`、`/docker`）的代码，其路径必须由构造函数/工厂注入（默认值只为生产），单测注入临时目录（`fs.mkdtempSync` / `os.tmpdir()`），**不碰真实 `/srv/erix/users`、`/docker`**。
2. **不碰真实 docker**：容器生命周期、网络、socket 逻辑的测试一律用**接口注入的 fake**（`DockerApi` 接口的 in-memory/HTTP stub），不 `docker.sock`、不 `docker run`。
3. **不碰真实 DB**：DB 逻辑的单测用 SQL 语义层的 fake 或 `pg-mem` 类内存库；真正需要 Postgres 约束（唯一索引、CAS、`FOR UPDATE SKIP LOCKED`、`NOTIFY`）的验证放到集成层（§2.2），因为内存库无法模拟这些语义。
4. **时间可注入**：租约/心跳/TTL/重试退避的时间一律注入时钟，单测用 fake clock；不 `sleep`。
5. **随机可复现**：涉及 `crypto.randomBytes` 的（token、run_id、claim_token）通过 seed/stub 注入，断言用不变量（长度、字符集、唯一性、哈希只存哈希），不依赖具体随机值。

> 判定：单测进程内出现 `/srv/erix/users`、`/var/run/docker.sock`、真实 `docker ps`、真实 DB 连接 → 视为破坏隔离，测试不通过。反例（允许）：`psql -f schema.sql` 空库可执行性验证是**集成层**的验收命令（§2.2.2），不是单测。

### 2.2 集成测试临时栈

#### 2.2.1 临时 Postgres（隔离、一次性、随机名）

```bash
DB_NAME="station-test-$RANDOM"
NET_NAME="station-test-net-$RANDOM"

# 起临时网络 + 临时 postgres:16（--rm，退出即删）
sg docker -c "docker network create $NET_NAME"
sg docker -c "docker run -d --rm --name $DB_NAME --network $NET_NAME \
  -e POSTGRES_USER=station -e POSTGRES_PASSWORD=test -e POSTGRES_DB=station_test \
  postgres:16"

# 等它就绪（pg_isready 容器内自带）
sg docker -c "docker exec $DB_NAME pg_isready -U station -d station_test -t 15"
# 期望：输出 "<host>:<port> - accepting connections"
```

判定：`pg_isready` 在 15s 内 `accepting connections`，否则集成测试不启动。

#### 2.2.2 schema.sql 空库可执行性（D3 验收锚点，集成层）

```bash
sg docker -c "docker exec -i $DB_NAME psql -U station -d station_test -v ON_ERROR_STOP=1" \
  < docs/data/schema.sql
# 期望：输出 CREATE TABLE / CREATE INDEX / COMMIT；退出码 0
# 失败（任一语句报错）→ 整体回滚（schema.sql 单事务 BEGIN;…COMMIT;），退出码非 0
```

判定：`ON_ERROR_STOP=1` 下退出码 0，且无 `ERROR`。这是 D3「`psql -f schema.sql` 在空库可执行」在临时栈上的可复现形式。

#### 2.2.3 伪造 FDE 容器（whoami 假容器 + 手动写 port_allocations）

> 集成测试不真跑 FDE 镜像（那属于 e2e/真机）。用 `traefik/whoami -port <p>` 假容器充当「dev server」，再**手动向临时 DB 写 `fde_networks` / `port_allocations` / `route_outbox` 行**，供 reconciler 发布路由、供 forwardAuth/隔离测试命中。`traefik/whoami` 支持 `-port` 指定监听端口（本机已实测 `--help`），可直接在 4000 监听以对齐 grammar 端口。
>
> **本节起两条 `/29` + 两个 whoami（`-a`/`-b`）**：既服务 N1–N3/N6（单 FDE），也服务 P2 的 N4（FDE A → FDE B 跨 bridge 拒）。下面所有变量在 §3.1 复用。

```bash
# 镜像 pin：先 pull 再记 resolved digest（供 §3.1 网络连通/DNS 断言使用）
CURL_IMAGE="curlimages/curl:8.9.1"
ALPINE_IMAGE="alpine:3.20"
sg docker -c "docker pull $CURL_IMAGE $ALPINE_IMAGE"

# 两条 /29（默认池样例，前缀 10.200.x.0/29）
FA_NET="fde-testfake-a"; FA_SUBNET="10.200.9.0/29";  FA_GW="10.200.9.1";  FA_IP="10.200.9.2"
FB_NET="fde-testfake-b"; FB_SUBNET="10.200.10.0/29"; FB_GW="10.200.10.1"; FB_IP="10.200.10.2"

sg docker -c "docker network create --subnet $FA_SUBNET $FA_NET"
sg docker -c "docker network create --subnet $FB_SUBNET $FB_NET"
# 起假 dev server：各自 .2，监听 4000（whoami 回显请求头，便于断言注入/未注入）
sg docker -c "docker run -d --rm --name ${FA_NET}-svc --network $FA_NET --ip $FA_IP traefik/whoami -port 4000"
sg docker -c "docker run -d --rm --name ${FB_NET}-svc --network $FB_NET --ip $FB_IP traefik/whoami -port 4000"

# 手动写 DB 行（复现「路由表里没有 = 不可达」的反向断言用）——经临时 DB 执行：
sg docker -c "docker exec -i $DB_NAME psql -U station -d station_test -v ON_ERROR_STOP=1" <<'SQL'
INSERT INTO users (id, login, fde_name) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'alice', 'alice'),
  ('00000000-0000-0000-0000-0000000000a2', 'bob',   'bob');
INSERT INTO projects (id, user_id, name, repo_url, root_path, slot) VALUES
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1',
   'proj1', 'https://git.example/alice/proj1.git', '~/projects/proj1', 2),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2',
   'proj1', 'https://git.example/bob/proj1.git',   '~/projects/proj1', 2);
INSERT INTO fde_networks (fde_id, network_name, subnet, prefix_len, gateway, pool, state) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'fde-testfake-a', '10.200.9.0/29',  29, '10.200.9.1',  'default', 'allocated'),
  ('00000000-0000-0000-0000-0000000000a2', 'fde-testfake-b', '10.200.10.0/29', 29, '10.200.10.1', 'default', 'allocated');
-- ⚠ 迁移 0019（#246）之后：**未释放**的 port_allocations 行端口必须落在全局号池 22000–29999 内，且**跨 FDE 不得重复**（`port_allocations_live_global_port_key`），否则当场 23514/23505；只有 `state='released'` 的行才允许保留 4000 段历史号码。
INSERT INTO port_allocations (id, fde_id, scope, project_id, run_id, port, role, hostname, url, exposure, state) VALUES
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1',
   'project', '00000000-0000-0000-0000-0000000000c1', NULL,
   22000, 'frontend', 'alice-p-22000.fde.test', 'https://alice-p-22000.fde.test', 'private', 'allocated'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2',
   'project', '00000000-0000-0000-0000-0000000000c2', NULL,
   22010, 'frontend', 'bob-p-22010.fde.test',   'https://bob-p-22010.fde.test',   'private', 'allocated');
SQL
```

> 注：上面的最小 seed 满足 `users`/`projects`/`fde_networks`/`port_allocations` 的外键与 CHECK（schema.sql §2/§4/§9），`fde_networks` 的 `pool='default' ∧ prefix_len=29 ∧ subnet << 10.200.0.0/16` 与 `gateway = host(subnet)+1` 两条 CHECK 均成立；两条 `port_allocations` 的活跃 `hostname` 全局唯一（`port_allocations_live_hostname_key`）不冲突。**路由发布的触发**另需 `route_outbox` + `route_revisions` 行（见 §3.5，本文不在此重复），本节 seed 只证明「假容器 + 手动写 port_allocations」这条隔离/认证测试的前置路径。

判定：假容器从宿主可达（`sg docker -c "docker run --rm --network host $CURL_IMAGE -s http://$FA_IP:4000"` 与 `... http://$FB_IP:4000` 均返回 whoami 回显），且 reconciler 能用这些行生成/删除对应 Traefik 路由（§3.5）。

#### 2.2.4 测试数据清理约定（硬规则）

- **一次性容器/网络**：一律 `--rm` + `docker rm -f`/`docker network rm`，名字带 `-test`/`-$RANDOM` 前缀，**绝不**与生产栈命名（`station-db`、`fde-<name>`、`backend`）冲突。
- **临时 DB**：用完 `docker rm -f`（`--rm` 已保证），**不落宿主卷**（不挂 `/docker/station-db`），数据随容器消失。
- **宿主 bind mount**：集成测试若需物化，写入 `$(mktemp -d)` 临时目录注入（§2.1），**不写 `/srv/erix/users`**；测试结束 `rm -rf`。
- **失败兜底**：测试脚本用 `trap '... cleanup ...' EXIT` 保证断言失败也清理临时容器/网络/目录；CI/本地留有 `docker ps -a` 断言「无 `station-test-*` 残留」。
- **清理断言**：集成测试最后一条断言 = 残留检查（`docker ps -a --filter name=station-test-` 为空、`docker network ls --filter name=station-test-net-` 为空）。

---

## 3. 必测清单（按契约逐项对应文档章节）

> 每条给出：**契约依据（文档章节）→ 测试动作 → 命令 → 期望输出 → 判定标准**。网络隔离与认证用例为**安全回归**（必须真机，见 §4.2）。

### 3.1 网络隔离（守不变式 1/2；契约 = topology §5.1/§6.1/§7 + env §5.3）

**契约依据**：topology §6.1「分层防火墙模型」+「验收矩阵」、§7「连通矩阵」、§5.1「来源规则派生（唯一口径）」；env §5.3 的规则语义同源。验收矩阵（topology §6.1）共 6 行，必须逐行对应，**不得漏测**：

> 下列命令复用 §2.2.3 的变量（`$FA_NET`/`$FA_GW`/`$FA_IP`/`$FB_IP`/`$CURL_IMAGE`/`$ALPINE_IMAGE`），先执行 §2.2.3 完成镜像 pull + 网络/假容器/seed；换其它 FDE 网络时改 §2.2.3 的 `FA_SUBNET`/`FB_SUBNET` 即可。

| # | 用例（对应 topology §6.1 验收矩阵） | 命令（本机可跑形式） | 期望输出 | 判定标准 |
|---|---|---|---|---|
| N1 | FDE → 宿主 `:443`（Traefik）通 | 从 FDE 网络内发起：`sg docker -c "docker run --rm --network $FA_NET $CURL_IMAGE -sk -m 5 https://$FA_GW:443/"` | TLS 握手成功（自签时 `-k`），Traefik 响应（404/路由响应均可，关键在**连接建立**） | 通（exit 0 或收到 HTTP 响应） |
| N2 | FDE → 宿主 `:8080`/`:4000`（portal / LLM 数据面回环）拒 | `sg docker -c "docker run --rm --network $FA_NET $CURL_IMAGE -s -m 3 http://$FA_GW:8080/"` | 连接超时/拒绝（无 HTTP 响应） | 拒（curl 非 0，`Connection refused` 或超时） |
| N3 | FDE → 宿主 publish `gitea:3000`/`mssql:1433`/`portainer:9000` 拒 | `sg docker -c "docker run --rm --network $FA_NET $CURL_IMAGE -s -m 3 http://$FA_GW:3000/"`（1433/9000 同法） | 超时/拒绝 | **三端口全拒**（任何一端口可达 = 防火墙规则未生效，阻断） |
| N4 | FDE A → FDE B 任意端口拒（跨 bridge 直连；**P2 多 FDE 验收**） | `sg docker -c "docker run --rm --network $FA_NET $CURL_IMAGE -s -m 3 http://$FB_IP:4000/"` | 超时/被拦（DOCKER-ISOLATION） | 拒（对应 topology §7「FDE A → FDE B 禁止」） |
| N5 | FDE → 互联网 HTTPS 按出口策略 | 目标环境实测（本机开发机出口策略未实施 → 本机不测，见 §5） | 按安全团队策略（issue #3） | 目标环境实测 |
| N6 | FDE → DNS 通（netns `127.0.0.11`） | `sg docker -c "docker run --rm --network $FA_NET $ALPINE_IMAGE nslookup github.com 127.0.0.11"` 或 `getent hosts` | 解析成功 | 通（默认内嵌 DNS） |

> 关键实现约束（写入断言，不只手工验证）：
> - **N3 必须覆盖三个宿主服务**（`gitea:3000`/`mssql:1433`/`portainer:9000`）——这是 topology §6.1「所有方案共同缺口」的实测反例，漏一个即假通过。
> - **来源规则派生唯一口径**（topology §5.1）：断言「放行/拒绝规则来自 `fde_networks` 中 `state ∈ {allocated,active}` 的**精确 `subnet`**（`/29`/`/28`），而非 `/16` 聚合池」。测试：`fde_networks` 里只有 `10.200.1.0/29` 时，`10.200.1.8`（同 /16 不同 /29）访问 internal API 应被 `ipAllowList` 拒（Traefik 403）。
> - **N2 的 `:8080` 是「回环 publish」**：portal 只 publish `127.0.0.1:8080`，FDE 经网关 IP 访问的是宿主非回环地址，本就不应命中 publish；防火墙兜底 DROP 兜住残余路径。二者叠加才成立（topology §6.1 分层）。
> - **防火墙 fail-closed**（deploy §4.4 ④）：规则缺失/校验失败时追加兜底 DROP（`10.200.0.0/16`、`10.201.0.0/16` 收紧到宿主本地端口与 DNAT，443 除外），断言「清空 `STATION-INPUT`/`STATION-DOCKER-USER` 后 N2/N3 仍拒」。

**假容器 / 假网络准备**（§2.2.3 复用）：N1–N3/N6 需一条 `/29` + 一个 whoami 假容器；**N4 需两条 `/29` + 两个 whoami**（P2 多 FDE 验收，§2.2.3 已一并创建 `-a`/`-b`）；N3 的宿主服务在本机开发机真实存在（§1.3），但**目标环境实测**仍需按 topology §6.1 在目标机重跑。

### 3.2 认证与边缘授权（守不变式 2；契约 = portal §2.5/§2.7/§2.8 + topology §5.2）

> ⚠️ **P1 范围**：预览路由（`*.fde.<base>` forwardAuth + preview ticket/cookie）归 **P2**（deploy §7.2「P1 完全不部署预览路由」）。因此 §3.2 的预览 ticket 用例为 **P2 验收**；P1 的认证验收只含「portal 自身 session cookie」+「internal API token」+「forwardAuth 不泄露 cookie 的结构性断言（若 P1 写了 fde-auth 中间件但无预览路由，则以『未部署预览路由 = fail-closed』为 P1 断言）」。

**A. portal session cookie（P1）**

| 用例 | 命令 | 期望 | 判定 |
|---|---|---|---|
| A1 未认证访问门户 API → 401 | `curl -s -o /dev/null -w '%{http_code}' https://station.<base>/api/me`（或 dev `http://station.localhost:8090/api/me`） | `401` + `{"error":{"code":"unauthorized"}}` | HTTP 401，code=`unauthorized` |
| A2 session cookie host-only（无 `Domain`，`__Host-` 前缀） | 登录后检查 `Set-Cookie`：`curl -sv -X POST .../login/totp ... 2>&1 | grep -i set-cookie` | 生产 `__Host-fde_session=...; Secure; HttpOnly; SameSite=Lax; Path=/`，**无 `Domain=`**；`HttpOnly` 防 XSS | cookie 属性逐项匹配（portal §2.5） |
| A3 预览域收不到 portal cookie | 断言 `Set-Cookie` 无 `Domain`（A2 即覆盖）；对 `*.fde.<base>` 的请求不带 `__Host-fde_session` | 浏览器请求预览域时 `Cookie` 头不含 `__Host-fde_session` | 抓包/playwright network 断言（P2） |

**B. forwardAuth / preview ticket（P2 验收；契约 = portal §2.7/§2.8）**

> 每条都要能回答「返回什么码」+「**不泄露 portal session cookie**」。用 whoami 假容器当上游（回显请求头），断言上游**收不到**任何 cookie。

| 用例 | 动作 | 期望返回码 + code | 判定 |
|---|---|---|---|
| B1 未认证访问任意 `*.fde.<base>` | `curl -s -o /dev/null -w '%{http_code}' https://alice-p-4000.fde.<base>/` | `403`（`preview_ticket_required`；无 ticket 无预览 cookie）| 403，且**响应/上游不含 `__Host-fde_session`** |
| B2 hostname 无对应 allocation | 访问 `https://nope-p-4000.fde.<base>/` | `404`（`not_found`） | 404（「路由表里没有 = 不可达」；dev 实机下为带 #57 可操作提示的正文） |
| B3 ticket 过期 / 不存在 / 格式非法 | `?preview_ticket=<过期/假>` | `401`（`preview_ticket_expired`/`preview_ticket_invalid`） | 401 |
| B4 ticket 已用（重放） | 同一 ticket 第二次 | `403`（`preview_ticket_used`） | 403，重放防护 |
| B5 ticket 已撤销 | `revoked_at` 置位后再用 | `403`（`preview_ticket_revoked`） | 403 |
| B6 ticket allocation 不匹配 | 用 A 的 ticket 访问 B 的 hostname | `403`（`preview_ticket_mismatch`） | 403 |
| B7 allocation 已释放 | 释放 allocation 后访问 | `403`（`allocation_released`，portal §2.7 第 2 步） | 403 |
| B7b 同名 released 历史行遮蔽活行（#275） | 管理台把预览块搬出去再**搬回曾用号段**（如 `22000→22030→22000`，造成同 hostname 的活行 + released 行共存），再点「Open preview」 | **放行**（无凭证时 `403 preview_ticket_required`；带票则 `302`/`200`）——**不是** `allocation_released` | 签票仍 201；审计 `grant_kind` 不为 `NULL`（ticket 分支真的走到了）；`SELECT state,count(*) FROM port_allocations WHERE hostname='<预览 host>' GROUP BY 1` 能同时看到活行与 released 行 |
| B8 forwardAuth 故障 → deny-all | 停 portal（或 forwardAuth 地址改到不可达）后访问预览 | Traefik **拒**（典型 503），**请求不到达上游** | 上游 whoami 无访问记录（access log 不增加）+ 客户端非 200-from-upstream |
| B9 不泄露 portal session cookie（贯穿 B1–B8） | 检查预览响应与上游 | 预览链路**任何环节**不出现 `__Host-fde_session`；上游 dev server 永不接收 portal cookie | portal §2.7「forwardAuth 一律忽略 portal session cookie」 |

**C. internal API token（P1；契约 = portal §9.1/§9.2 + topology §5.2 链③）**

| 用例 | 命令 | 期望 | 判定 |
|---|---|---|---|
| C1 无 token | `curl -s -o /dev/null -w '%{http_code}' -X POST https://station.<base>/api/internal/claim` | `401`（`token_invalid`） | 401 |
| C2 错 token | `-H 'Authorization: Bearer WRONG'` | `401`（`token_invalid`） | 401 |
| C3 已吊销 token | 用 `token_generation` 旧代次 | `401`（`token_revoked`） | 401 |
| C4 来源不在 `ipAllowList` | 从**非 FDE 精确 subnet**（如宿主外网/其它 bridge，或同 /16 不同 /29 的容器）访问 internal | Traefik `403`（ipAllowList 拦截，**不达 portal**） | 403，且不落 `audit_log`（portal 没收到） |
| C5 伪造/重复 `X-Forwarded-For` 不影响来源判定 | `-H 'X-Forwarded-For: 10.200.1.2'` 从白名单外访问 internal | 仍 403（来源判 remote address，topology §5 公共约定） | 403（XFF 不改变判定） |
| C6 越权 run（token 对，run 不属本 FDE） | 用 alice 的 token 写 bob 的 run | `403`（`run_ownership_mismatch`）或 `404`（不泄露存在性） | 403/404（portal §9.13） |
| C7 session cookie 不能调 internal / token 不能调公开 | 交叉调用 | 两套认证不互通（portal §9） | 分别 401/403 |

### 3.3 文件物化（守不变式 3；契约 = user-space §4/§5/§6/§7/§8）

> 契约依据：user-space §5.1（原子写）、§5.3（manifest 提交点）、§5.5（幂等序列化）、§6.1/§6.2（UID/权限）、§7.3（磁盘满/权限错误）、§8（重建幂等）。测试用**临时目录注入**（§2.1），不碰真实 `/srv/erix/users`。

| 用例 | 动作 | 期望 | 判定 |
|---|---|---|---|
| M1 原子写（半截不可见） | 物化写入过程中（temp 阶段）并发读目标文件 | 读者读到**旧完整文件**或**新完整文件**，绝无半截/空文件（同目录 tmp+rename，user-space §5.1） | 多次并发读，sha256 恒等于旧或新，无中间态 |
| M2 跨文件一致性（manifest 提交点） | 一批物化同时改 `ports.json`+`manifest.json`，读方在两次 rename 之间读 | 读方检测到 sha256 不匹配 → 重读收敛到同一 generation（user-space §5.3） | 最终读到的 `ports.json.generation == manifest.generation` |
| M3 manifest generation 单调 + 内容不变不递增 | 重复物化同一 DB 快照 | generation 不变、文件字节级相同（user-space §5.5/§8.2） | 两次输出 sha256 相等 |
| M4 权限/属主 | 物化后 `stat` | 平台文件 root:root `0644`/`0444`（manifest `0444`）；工作区目录 `erix`(1000) `0770`（user-space §6.2，**无 setgid**；代码传 `2770` 但落盘 `0770`，成因与「为什么不是缺陷」见该节「为什么是 `0770` 而不是 `2770`」，issue #273） | 逐项匹配 |
| M5 容器重建后重物化幂等 | 触发全量重物化（user-space §8.1） | 内容无变化 → 不重写、generation 不变（§8.2） | 文件 mtime 不变 + sha256 不变 |
| M6 磁盘满（ENOSPC） | 对 temp 写入注入 ENOSPC | 不写半截、保留上一版、标记 `failed` + code=`disk_full` + 告警状态落库（user-space §7.3） | 上一版文件完好 + 失败状态可查 |
| M7 权限错误（EACCES/EPERM） | 目录属主改错 / mount 只读 | 立即告警 code=`permission_denied`，低频对账重试，不高频盲重试（user-space §7.3） | 告警状态可查 |
| M8 路径被篡改（symlink） | 把 `.erix` 目录换成 symlink | 拒写 + 告警 `materialize_path_tampered`（user-space §6.3/§7.3） | 不 follow、不写、告警 |
| M9 读方经 manifest（硬规则） | worker/agentd 裸读 vs 校验后读 | 裸读被禁止（user-space §5.4），实现必须「先 manifest → 校验 sha256 → 再用」 | 代码审查断言（无裸读路径） |

> M6/M7/M8 的「告警状态」：告警**通知通道**是 P2+ 延后事项（user-space §7.3），但 `failed` + code 是 materializer 落库事实，P1 即可查。断言「状态落库」，不要求「收到邮件/IM」。

### 3.4 崩溃恢复 / 幂等（守不变式 3；契约 = runner §6/§7/§9 + schema.sql + model §2.8）

> 契约依据：runner §6.4/§6.5（崩溃路径）、§7.3/§7.5/§7.6（事件幂等/spool/run_end）、§9.5（revision CAS）；schema.sql §5（`run_events.client_event_id` 唯一）、§8（`run_queue` 租约字段）、§5（`run_checkpoints` 单行）；model §2.8（方案 B 恢复流程）。

| 用例 | 动作 | 期望 | 判定 |
|---|---|---|---|
| R1 kill agentd | `sg docker -c "docker kill fde-alice"`（agentd=容器主进程） | Docker `unless-stopped` 拉起；心跳 3 次丢失（45s）→ 租约 90s 到期 → re-claim（`resume:true`）→ 从 checkpoint 续跑（runner §6.4） | run 未终态前被同 run_id re-claim；`run_queue.attempts` +1；`resume=true` |
| R2 kill worker | 仅 kill worker 进程（agentd 存活） | agentd `release`（`worker_crashed`）→ 立即 re-claim（`attempts++`、`resume:true`）（runner §6.4） | 同上，但 release 由 agentd 发起 |
| R3 容器重启（整容器） | `docker restart fde-alice` | 新 agentd 扫描 spool → 重传未 ack → re-claim 续跑（runner §7.5/§6.4） | spool 不丢（在 HOME bind mount 持久卷）+ 事件不重不漏 |
| R4 重复 batch（同 `client_event_id`） | 重发同一 U3 批次 | `INSERT ... ON CONFLICT (run_id, client_event_id) DO NOTHING`，响应 `stored < 请求条数`、`200`，不产生重复事件（schema.sql §5 + portal §9.4） | `run_events` 中该 `client_event_id` 恰一条 |
| R5 乱序 batch | 乱序重发 attempt N 与 N+1 的批次 | 逐事件幂等去重；`seq` 按到达顺序分配、严格递增无空洞；run 内逻辑顺序由 `client_event_id` 的 `(attempt,计数)` 编码（runner §7.3） | 无重复行 + seq 连续 |
| R6 checkpoint 旧 revision 被拒（CAS） | U8 提交 `revision <= 当前` | `409 checkpoint_stale`；agentd 不重试（runner §9.5 + portal §9.8） | DB 内 snapshot 未被旧值覆盖 |
| R7 lease 过期回收 + `claim_token` fencing | 让租约过期（不续租）→ 另一 agentd re-claim → 旧 agentd 写 | reaper 回收租约；旧 `claim_token` 任何写 → `409 lease_lost` / 心跳 `lease_lost`（runner §4.2/§6.4） | 旧写被拒、不污染 DB |
| R8 spool 写满 | 塞满 spool 配额（每 run 256MB / 每容器 1GB ⚠️）且内存队列也满 | 事件不静默丢，run 显式 `spool_full`（retryable）（runner §7.5 + portal §6.4） | run 失败码 = `spool_full` |
| R9 spool 损坏（撕裂写） | 制造末行不完整 | 扫描截断到最后一个完整换行、丢弃残缺尾行、告警（runner §7.5） | 不崩溃、不重传残缺行、日志告警 |
| R10 `run_end` 唯一产生方 | 跑完一个 run | `run_end` 事件**仅由 portal 在 U2 终态事务合成**（worker 不经 U3 发 run_end，runner §7.6）；该事件 seq 为该 run 最大 | `run_events` 中该 run 恰一条 `type='run_end'`，且来源为 U2 终态事务 |
| R11 终态 barrier | 终态后写 U3/U8/state | `409 run_terminal`（portal §9.6/§9.13） | 终态不可再写 |

### 3.5 路由发布（守不变式 2；契约 = topology §5/§8 + schema.sql `route_outbox`/`route_revisions` + model §2.5）

> 契约依据：topology §8「路由发布预算与收敛机制」（debounce/原子替换/失败保留上一版/reload SLO）、§5（每 allocation 一条 router+service）；schema.sql §9（`route_outbox` 状态机 + `route_revisions` head）；model §2.5。

| 用例 | 动作 | 期望 | 判定 |
|---|---|---|---|
| T1 `route_outbox` → Traefik 动态配置端到端 | 写 outbox 行 → reconciler 消费 → 检查 file provider 文件 | 生成 `fde-<name>-<port>` router+service（backend = 容器 IP:port），file provider reload（topology §5/§8） | 配置文件含预期 router/service，且 Traefik 生效（`curl` 经 Traefik 到达假容器） |
| T2 debounce/批量合并 | 200ms 窗口内连续写多条 outbox | 聚合同批 revision 一次生成整份配置，非逐条 reload（topology §8） | reload 次数 < outbox 条数（日志/计数器断言） |
| T3 原子替换 + 失败保留上一版 | 生成到临时文件 → schema 校验 → `mv`；注入校验失败 | 失败时保留上一版文件（不回滚到空/半截）；`attempts < max` 退回 `pending` 退避重试（topology §8 / model §2.5） | 失败后旧配置仍生效 + outbox 行回 `pending` |
| T4 旧 revision 丢弃（latest-wins） | 同 aggregate 晚到旧 revision 行 | `revision < head` 丢弃不发布（schema.sql §9 注释 + model §2.5） | 不产生旧版本路由 |
| T5 过期 tombstone 丢弃 | 同 aggregate 旧 `op='delete'` tombstone 晚到 | 丢弃（latest-wins） | 已 upsert 的活跃路由不被旧 tombstone 误删 |
| T6 孤儿 processing 回收 | 制造 `state='processing' AND lease_until < now()` | reaper 回收 `pending`（attempts+1）（schema.sql §9 注释） | 不锁死、恢复可发布 |
| T7 `active` 触发不重发路由 | forward-auth 放行触发 `allocated→active`（规格 §8.6） | 升级不写 outbox、不重发路由（规格 §8.6「不触发路由重发布」） | 无多余 outbox 行 / 无 reload |

### 3.6 API 契约（internal U1–U12；契约 = portal §9 + runner §4/§5 + schema.sql）

> **本文不重复定义契约**：U1–U12 的请求/响应/错误码以 portal §9.2–§9.13 为唯一事实来源（runner §4.2 同源）。这里只给「契约测试如何接、每端点必测哪些码」。

#### 3.6.1 错误码统一（400 vs 422 结论）

internal 通道与公开端点的 `validation_failed` **统一为 `400`**（portal §9.13 末「✅ 已统一」+ §1.2）。契约测试必须显式断言：

| 断言 | 期望 |
|---|---|
| 载荷非法 → | `400 validation_failed`（**绝不 422**） |
| 越权资源 → | `403 run_ownership_mismatch` 或 `404`（不泄露存在性，portal §1.2/§9.13） |
| token 错/吊销 → | `401 token_invalid` / `401 token_revoked` |
| 租约失配 → | `409 lease_lost` |
| 终态写 → | `409 run_terminal`（幂等命中视成功，portal §9.13） |
| checkpoint 旧 revision → | `409 checkpoint_stale` |
| 5xx/网络 → | 无限指数退避重试（agentd 侧，portal §9.13/§4.5） |

#### 3.6.2 U1–U12 契约测试矩阵（必测最小集）

> 以 portal §9 各端点「错误」表为准；下表是**每端点至少覆盖的幂等/错误分支**，实现时逐条落成 `node --test` 用例（打真实 HTTP 或 in-process stub，见 §2.1/§2.2）。

| 端点 | 必测幂等/错误分支 |
|---|---|
| U1 claim | `400`（capacity/hold_ms 越界）、`200`/`204`（长轮询）、re-claim 条件（lease 过期/attempts<max/user_id 路由，portal §9.3） |
| U2 state | 合法转换表逐行 + `409 invalid_transition` + 重复终态同载荷 `200`（`idempotent:true`）/不同载荷 `409 run_terminal`（portal §9.6） |
| U3 events | 空批次 `200 {stored:0,seq_first:null,seq_last:null}`、重复批次 `stored<条数`、`400`（超限/非对象 payload/格式非法）、终态 `409 run_terminal`（portal §9.4） |
| U4 heartbeat | 逐 run 续租 `renewed` / `lease_lost`（reason 取值）、吊销经 `401 token_revoked`（非 200 `revoked:true`，审计 #34 F-C）、`stop_run_ids` 兑底（portal §9.5） |
| U5 transcript | 同 round 同 body `200 {inserted:false}` / 不同 body `409 round_conflict` / 不同 dedupKey `409 round_conflict`（portal §9.7） |
| U6/U7 load/recall | 分页 `next_cursor`（U6 run 作用域 = round 号；S1 session 作用域 = 不透明串 `<round>:<append_seq>`，portal §9.8b）、U7 `501 not_implemented` 降级（P1 可 501，portal §9.7）。⚠ 旧文列的 `400 response_too_large` **不存在**（`grep -rn response_too_large portal/src` 零命中；读侧无体积闸，见 portal §9.7 更正） |
| U8/U9 checkpoint | 首次/前进 `200`、`409 checkpoint_stale`、`204`（无）、终态仍可读（portal §9.8） |
| U10/U11 approvals | 重复创建返回原单 `200`、`409 approval_expired` 迟到决定、U11 轮询（portal §9.10） |
| U12 release | `requeued`/`failed_max_attempts`/`cancelled` 三分支 + 重复 release 幂等 + `409 lease_lost`（portal §9.11） |

#### 3.6.3 与 `erix-agent` 的 `contract-tests` 接入方式

> 契约锚点：runner §1.3「契约测试 | `erix-agent/contract-tests` | `package.json:23-27` exports；`test/contract/index.js` 导出 `transcriptStoreContract` / `modelConfigProviderContract`」。**该包只导出 `.` / `./tools` / `./contract-tests`**，深路径导入会被 `ERR_PACKAGE_PATH_NOT_EXPORTED` 拒绝。

接入步骤（依赖装好后执行；当前 `erix-agent` 尚未安装，见 §5）：

```bash
# 1) 安装并 pin（版本 pin 走 containers.agent_version + canary，规格 §14/§13.2；下文以文档锚定的 v0.3.5 为例，替换为实际 pin）
ERIX_AGENT_VERSION=0.3.5
npm install "erix-agent@$ERIX_AGENT_VERSION"

# 2) 验证导出面（只允许这三个入口）
node --input-type=module -e \
  "import('erix-agent/contract-tests').then(m => { console.log(Object.keys(m).sort().join(',')); })"
# 期望输出包含：transcriptStoreContract,modelConfigProviderContract

# 3) 深路径导入必须被拒（负向断言）
node --input-type=module -e \
  "import('erix-agent/tools/jail').then(() => process.exit(1), e => { console.log(e.code); process.exit(e.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 0 : 1); })"
# 期望输出：ERR_PACKAGE_PATH_NOT_EXPORTED（退出码 0）
```

接入落点（实现后）：

- **store adapter 契约测试**：用 `transcriptStoreContract` 跑**本平台的 HTTP store adapter**（实现 `TranscriptStore` 六方法，映射到 portal internal U5–U9，runner §9.1）。跑法：起 in-process stub 实现 U5–U9（§2.1 fake），adapter 指向 stub，contract 测试逐方法断言。**这验证的是「我们的 adapter 满足上游 store 接口语义」，不是验证 portal 业务逻辑**。
- **config provider 契约测试**：用 `modelConfigProviderContract` 跑**本平台物化的 `config.json`**（顶层键 `slots` + 占位 key + `endpoint=https://llm.<base>/v1` + `default/audit/fold` 三 slot，user-space §4.3.2）经 `createJsonFileModelConfigProvider` 解析的结果——断言三个 slot 可解析、占位 key 可读（真实 key 由 Traefik 注入，容器内零凭据，runner §11.1）。
- **CI 接入**：规格 §13.2-6「`erix-agent/contract-tests` 应接入 CI（长期运行的宿主必需）」——落点为 `npm test` 的一个子集（`contract-tests` 目录），随全绿门槛执行。

### 3.7 浏览器验证流程（playwright MCP → 截图 → vision MCP；守不变式 2，P1 验收主链路）

> 全局 §2.2/§2.3：Playwright MCP 截图 → vision MCP 读图确认。工具名带 `playwright_` / `vision_` 前缀；截图落盘 `/docker/playwright-mcp/`（默认实例，宿主路径）。SSE `Last-Event-ID` 断线续传的验收步骤见 §3.7.2。

#### 3.7.1 标准浏览器验证三步

```text
① navigate：playwright_browser_navigate { url: "http://station.localhost:8090"（dev）或 https://station.<base> }
② snapshot/交互：browser_snapshot 确认元素 → browser_click/browser_type/browser_fill_form 走流程
③ 截图 + 读图：browser_take_screenshot { filename: "p1-login.png" }
   → vision_playwright_screenshot { path: "/home/node/.playwright-mcp/p1-login.png", question: "页面是否显示登录表单？" }
   （或直接读宿主路径 /docker/playwright-mcp/p1-login.png：vision_analyze_image）
```

判定标准：vision 返回确认「预期 UI 元素/文案/状态出现」；console 无致命错误（`browser_console_messages` 过滤 `error`）；关键请求成功（`browser_network_requests` 过滤 5xx）。

**P1 验收主链路（对应规格 §15 P1 行）**，每步一个截图 + 一个 vision 确认：

| 步骤 | 断言（vision 读图确认） |
|---|---|
| 登录（本地账号 + TOTP） | 登录表单 → 两步 → 进入项目列表 |
| 建项目 | 表单 → 项目卡片出现（含分配的端口/URL，取自 `PortAllocation.url`，前端不拼接） |
| 对话 | 发送消息 → SSE 逐字/工具卡片动画（`assistant_delta` → `tool_use`/`tool_result` 卡片） |
| 停止 | stop 后 run 收敛 `termination.reason="aborted"`，UI 显示已停止 |

#### 3.7.2 SSE `Last-Event-ID` 断线续传验收步骤

> 契约：portal §5.2（`id` 字段恒等于 `seq`；重连带 `Last-Event-ID` 补发大于该 seq 的事件；无 `Last-Event-ID` 首连不补发）。分两层验收：

**API 层（curl，快、可脚本化）**：

> cookie 名称随 `COOKIE_PROFILE`（env §10 / portal §2.5）切换：`prod` → `__Host-fde_session`（`Secure`），`dev-http` → `fde_session_dev`（`Secure=false`）。下列命令以 `prod` 为例，开发期 http 联调换成 `fde_session_dev` 并把协议改 http。

```bash
# 1) 开 SSE，记录事件 seq（用 curl -N 抓前几条）
curl -sN -H 'Cookie: __Host-fde_session=<token>' \
  'https://station.<base>/api/sessions/<sid>/events' | head -5
# 期望：data 行含 seq 递增、id: <seq>

# 2) 断线后带 Last-Event-ID 重连，验证补发
curl -sN -H 'Last-Event-ID: 128' -H 'Cookie: ...' \
  'https://station.<base>/api/sessions/<sid>/events'
# 期望：先补发 seq>128 的全部历史事件，再切实时流（portal §5.2 第 2 步）

# 3) 边界：Last-Event-ID > last_seq → 404；小于归档保留 → 410 replay_unavailable（当前不触发，见 portal §5.2 注）
curl -s -o /dev/null -w '%{http_code}' -H 'Last-Event-ID: 999999999' .../events
# 期望：404
```

**浏览器层（playwright + vision，模拟 EventSource 自动重连）**：

```text
① playwright 打开对话页，用 browser_evaluate 创建一个 EventSource('/api/sessions/<sid>/events')，
   收集收到的 seq 到 window.__seqs
② 用 browser_evaluate 断开 EventSource（close()），等 1s 后重建（EventSource 自动带 Last-Event-ID）
③ browser_evaluate 返回 window.__seqs，断言：重建后无跳号（seq 连续）、无重复
④ 截图 + vision 确认「对话气泡完整、无缺段」
```

判定：seq 无空洞（`UNIQUE(session_id, seq)` 兜底）、补发不漏（重连后从断点之后连续）、无重复。

---

### 3.8 容器进程模型 smoke test（守不变式 1；契约 = deploy §6.2 + runner §2.4/§11.3）

> 对应 B7（agentd 跨 UID 杀 worker 需 `CAP_KILL`）与 B12（单一 init，不双重 init）。真机栈（起一个 FDE 容器）后跑；本机可用假 FDE 镜像（含 `station-agentd` 二进制）先验。

| 用例 | 命令（真机 FDE 容器 `fde-alice`） | 期望 | 判定 |
|---|---|---|---|
| S1 单一 init | `sg docker -c "docker inspect fde-alice --format '{{.HostConfig.Init}} {{.Path}}'"` | `Init=true` 且 `Path` 为 `station-agentd`（**非** `tini`） | 无双重 init（deploy §6.2/§1） |
| S2 僵尸回收 | 容器内起一个后台进程并退出后：`sg docker -c "docker exec fde-alice ps -ef"` | 无 `<defunct>` / `Z` 状态残留 | tini reap（deploy §6.2 note） |
| S3 跨 UID kill（B7） | 领一个 run，agentd（UID 1001）在 stop/lease_lost 时对 worker（UID 1002）发 `SIGTERM`→`SIGKILL`；`sg docker -c "docker exec fde-alice ps -o uid,pid,cmd"` 确认 worker 已退出 | worker 进程被终止、退出码合理、无 `EPERM` 日志 | agentd 持 `CAP_KILL` + `PR_SET_KEEPCAPS` 生效（deploy §6.2 note；失败即 `EPERM` 需改同 UID/supervisor 模型） |

### 3.9 P1 对话验收的 LLM mock 网关（deploy §7.3）

> 集成对话通过 LiteLLM 原生 `mock_response` 验证真实产品链路，不访问真实上游 LLM。

| 用例 | 动作 | 期望 | 判定 |
|---|---|---|---|
| L1 请求发出 | 经管理台 API 建 LiteLLM credential/mock model 并绑定 FDE；worker 经 Traefik 发 `/v1/chat/completions` | LiteLLM 原生 mock response 回到 assistant 消息，run `finished` | 请求经过真实路由与 key 注入链 |
| L2 模型白名单 | 使用 FDE virtual key 请求已选模型、未选模型及 `/v1/models` | 已选模型 200；未选模型 403；列表仅含允许模型 | WP6 e2e |
| L3 零真实凭据 | 检查 runner 配置、容器环境与 LiteLLM 测试 credential | FDE 不持有真实上游凭据；测试 credential 不含真实 key | deploy §7.3 红线 |

---

## 4. 验收判定与门禁

### 4.1 「P1 交付完成」的条件

P1 交付完成 = 同时满足：

1. **语法/单测全绿**：`node --check` 0 错误 + `npm test` 全绿（§1.2.1/§1.2.2）。
2. **临时栈集成通过**：§2.2 的 `psql -f schema.sql` 空库可执行 + 集成测试（DB 约束/路由/物化/租约 CAS）通过，且临时资源清理断言通过（§2.2.4）。
3. **P1 真机主链路走通**：规格 §15 P1 行「登录→建项目→对话→工具卡片→停止」用 playwright + vision 走通（§3.7.1），截图可读、无致命 console 错误。
4. **P1 范围安全回归通过**：§3.1 中本机可跑的 N1–N3/N6 + §3.2 C（internal token）+ §3.4 R4/R6/R7/R10/R11 真机通过（§4.2 判「必须真机」的项；N4 归 P2）。
5. **契约测试接入**：§3.6.3 的 `erix-agent/contract-tests` 跑通（store adapter + config provider），深路径导入被拒的负向断言通过。

> ⚠️ **P1 是否含预览/真实 LLM（待决策者确认）**：按 deploy §7.2 已定 **P1 不含**预览 iframe、多 FDE、**真实 LLM 网关**（归 P2/P3）；**P1 对话验收走无真实凭据的 mock 网关（deploy §7.3 + §3.9）**。因此：
> - **若按「P1 不含预览/真实 LLM」**（当前文档定稿）：§3.2 B（preview ticket）、§3.1 N4 的「多 FDE」完整版、真实 LLM 注入（topology §4-L7）**不属于 P1 验收**，归 P2/P3；P1 只须保证「未部署预览路由 = fail-closed」（`*.fde.<base>` 无路由 → 404/不可达）这一条，对话链路用 §3.9 的 mock 断言。
> - **若决策者改判「P1 含预览」**：把 §3.2 B 与 §3.5 T1（预览路由端到端）提入 P1 验收，并要求 preview ticket TTL（60s ⚠️）、预览 cookie TTL（15min ⚠️）先拍板（portal §2.8 ⚠️）。**若「P1 含真实 LLM」**：把 topology §4-L7 的真实 LLM 注入验收（A 子网拿 alice key / B 子网拿 bob key / 伪造 Authorization 被覆盖 / 无匹配来源 404，topology §10 证据 8）提入 P1，且需真实 LLM 网关（LiteLLM）——这会引入「真实 LLM 配额」依赖（§5），须决策者明确接受。

### 4.2 哪些测试必须真机跑（不能只单测）

| 类别 | 必须真机的原因 | 落点 |
|---|---|---|
| §3.1 网络隔离（N1–N3/N6） | 验证 docker 网络/宿主防火墙的真实行为，单测模拟不了 | 本机开发可跑 N1–N3/N6；N4 归 P2；N5 目标环境实测 |
| §3.2 认证（B/C） | Traefik forwardAuth/ipAllowList/XFF 是真实中间件行为 | 真实 Traefik + portal 栈 |
| §3.5 路由发布（T1–T3） | file provider + reload 是 Traefik 真实行为 | 真实 Traefik |
| §3.7 浏览器验证 | 渲染/SSE 断线续传是真实浏览器行为 | Playwright MCP + vision MCP |
| topology §6.1 验收矩阵全表 | 目标环境宿主服务事实（gitea/mssql/portainer） | **目标环境实测，逐项打勾**（topology §6.1） |

**只单测就够的**：纯逻辑（§1.2.2）——seq 分配、幂等键格式、hostname grammar、revision CAS 的 SQL 语义之外的纯函数、manifest 校验、暴露矩阵判定、错误码映射。

### 4.3 失败时的处理（阻断合并 vs 记 issue）

| 失败类型 | 处理 |
|---|---|
| **语法/单测失败** | **阻断合并**（全局 §3.2 硬门槛） |
| **集成测试失败**（DB 约束/CAS/幂等/清理残留） | **阻断合并**（破坏不变式 3） |
| **安全回归失败**（§3.1 N1–N4、§3.2 B/C、§3.5 T1–T3） | **阻断合并**（破坏不变式 1/2，是安全红线） |
| **契约测试失败**（erix-agent contract-tests） | **阻断合并**（store/config 与上游不兼容 = 引擎跑不起来） |
| 已知外部依赖缺失（LLM 配额、目标环境出口策略、DNS-01） | **记 issue + 显式标注「未验收」**，不假通过（§5） |
| `⚠️ 待决策者确认` 参数未拍板（TTL/capacity/spool 配额等） | 按文档当前倾向值验收 + **记 issue 待决策者**，不阻塞合并（参数是倾向值，非正确性缺口） |
| 非关键 UI 瑕疵（vision 读到的小排版问题） | **记 issue**，不阻断（但「主链路走不通」仍阻断） |

---

## 5. 已知不可测 / 暂不测（避免假通过）

| # | 项 | 为什么暂不测 | 处置 |
|---|---|---|---|
| 1 | **真实 LLM 配额/调用**（P3） | 需真实 LLM 网关 + 上游配额；P1 对话走**无真实凭据的 OpenAI-compatible mock/test gateway**（deploy §7.3，容器仍只持占位 key + `endpoint`，无 `LLM_DEV_*` 变量） | P1 用 mock/占位断言「请求发出、错误码映射（`rate_limited`→429、`checkpoint_failed`）正确」（§3.9）；真实配额 P3 验收 |
| 2 | **目标环境网络策略（出口管控）** | 外部依赖（安全团队，issue #3），本机开发机未实施 | N5（FDE→互联网）目标环境实测；「改 endpoint 无效」（P3 验收）依赖安全团队策略，未实施时降级为审计+告警（规格 §11.4） |
| 3 | **LLM 注入真实虚拟 key 覆盖伪造头**（topology §4-L7/§10 证据 8） | P3 才部署 `llm-gateway` + LLM 注入路由（deploy §7.2） | 归 P3 验收；P1 不测（不假通过） |
| 4 | **`erix-agent` 依赖未安装**（本机无 `~/projects/erix-agent`，npm 源未接入） | 契约已定义（runner §1.3），接入命令见 §3.6.3 | 「待接入」：安装 + contract-tests 跑通后转「已测」；当前显式标「未验收」 |
| 5 | **预览 ticket/cookie 的 TTL 实测**（60s/15min ⚠️） | 参数待决策者确认（portal §2.8） | 拍板后按值测；未拍板前只测「过期即拒」的方向性断言，不测具体秒数 |
| 6 | **多 FDE 全量隔离**（30 FDE 规模） | P2（deploy §7.2「多 FDE」），P1 单 FDE | P1 只测「单 FDE + 假容器」的拓扑隔离；30 FDE 规模/批量 offboarding 归 P2 |
| 7 | **DNS-01 / 真实证书 / VPN-only / 公网可达**（env §1/§2/§3 🕓 部署期） | 部署期事项，P1 开发不需要 | 开发期用 hosts/localhost 变通 + 自签/http；部署期按 env §9 探测后实测 |
| 8 | **告警通知通道**（邮件/IM） | P2+ 延后（user-space §7.3 / 规格 §14） | 只断言「告警**状态**落库可查」，不测「收到通知」 |

> 原则（写作纪律）：**上述项一律显式标注「未验收/归后续」，绝不写成「通过」**——尤其 §3.1 N5、§5-3（LLM 注入）这类必须目标环境/真网关的用例。

---

## 6. ⚠️ 待决策者确认 + 转派同步点

### 6.1 本文待决策者确认（按文档当前倾向写，未新造数值）

| # | 事项 | 当前倾向（引用） | 影响 |
|---|---|---|---|
| 1 | P1 是否含预览/真实 LLM | 不含预览/真实 LLM；对话验收走 mock 网关（deploy §7.3） | §4.1 分支 |
| 2 | preview ticket TTL / 预览 cookie TTL | 60s / 15min 滚动（portal §2.8 ⚠️） | §3.2 B、§5-5 |
| 3 | 租约/心跳/事件批量/背压/spool 配额/capacity | 90s/15s/250ms·2KB/10000·4MB/256MB·1GB/4（env §11.1 + runner §15 ⚠️） | §3.4 R7/R8 |
| 4 | materializer outbox 复用 `route_outbox` 还是新增表 | ✅ 已定稿：新增 `materialize_outbox` + `materialize_revisions`（A7，不复用 `route_outbox`，schema.sql §9 / model §1.22） | §3.3 物化测试的 outbox 落点 |
| 5 | argon2id 参数 / 口令长度 / TOTP 强制 | `m=19MiB,t=2,p=1` / ≥12 / 强制（portal §2.9.4 ⚠️） | §3.2 A |

### 6.2 转派同步点（已销账）

| # | 目标文档 | 需同步点 | 状态 |
|---|---|---|---|
| S2 | `data/model.md` §2.2 | `allocated→active` 触发条件定案为「首次 forward-auth 放行」（规格 §8.6；deploy §9.2 S2 已标记） | ✅ 已同步（model.md §2.2 已定稿并注明） |
| S3 | `data/schema.sql` | `schema_migrations` 表（deploy §3.1）+ `users.fde_name` CHECK（规格 §8.5） | ✅ 已同步（schema.sql §10 + §2 CHECK 均已落） |

---

## 7. 交叉引用

| 主题 | 位置 |
|---|---|
| 全局测试/浏览器约定 | [`~/projects/AGENTS.md`](../../../projects/AGENTS.md) §2.2/§2.3/§3.2 |
| 主规格（分期/不变式） | [`fde-platform.md`](design/fde-platform.md) §15 / §8 |
| 网络隔离与验收矩阵 | [`topology.md`](design/topology.md) §5.1/§6.1/§7/§8/§10 |
| 认证与预览 ticket/cookie | [`portal.md`](api/portal.md) §2.5/§2.7/§2.8/§5 |
| internal 端点 U1–U12 | [`portal.md`](api/portal.md) §9；[`runner-integration.md`](design/runner-integration.md) §4 |
| 文件物化契约 | [`user-space.md`](design/user-space.md) §4/§5/§6/§7/§8 |
| 崩溃恢复/幂等/checkpoint | [`runner-integration.md`](design/runner-integration.md) §6/§7/§9；[`model.md`](data/model.md) §2.8 |
| 路由发布/reconciler | [`topology.md`](design/topology.md) §5/§8；[`schema.sql`](data/schema.sql) §9；[`model.md`](data/model.md) §2.5 |
| P1 部署范围/防火墙/migration | [`deploy-contract.md`](design/deploy-contract.md) §3/§4.4/§7/§8 |
| 部署变量/运行时参数 | [`env.md`](env.md) §0/§5/§10/§11 |
| 上游契约测试 | [`runner-integration.md`](design/runner-integration.md) §1.3/§16 |
