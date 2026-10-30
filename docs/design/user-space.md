# 用户空间物化契约（user-space.md）

> 状态：**契约基线（阻塞 P1 开工，issue #7）**
> 依据：[`fde-platform.md`](fde-platform.md)（主规格，下称「规格 §x」）、[`topology.md`](topology.md)（H-B 网络与访问拓扑，下称「topology §x」）、[`principles.md`](principles.md)（原理，下称「principles §x」）、[`runner-integration.md`](runner-integration.md)（容器内进程模型，下称「runner §x」）、[`../env.md`](../env.md)（部署参数，下称「env §x」）、[`../data/model.md`](../data/model.md)（数据模型，下称「model §x」）。
>
> **本文只定义「平台 ↔ FDE 用户空间」的物化契约**：路径映射、文件清单、原子写、属主/权限、失败重试、变更感知、重建幂等、与路由的一致性、项目目录归属。**不定义实现**（materializer 代码、Docker 模板、compose 字段），实现者可按本文照做。
>
> **已定决策（不可改）**：
> - **D-6 文件投递走 portal 直写宿主 bind mount**（`/srv/erix/users/<fde>/`），无需任何入站网络（topology §1 D-6，issue #7）。
> - **容器内零 LLM 凭据**：仅占位 key + `endpoint=https://llm.<base>/v1`；真实虚拟 key 由 Traefik 按来源子网注入，永不下发容器（topology §1 D-4 / 规格 §11.4）。
> - **DB 是状态真相**：用户空间文件是 DB 的**派生视图**，不是真相（principles §1 原理三；规格 §8.1）。`ports.json` 是 `port_allocations` 的派生视图。
> - **每 FDE 一条独立 `/29`**、**Traefik 走 host 网络**、**portal 不主动访问容器**——文件投递只走「portal 直写宿主 bind mount」，无网络路径（topology §1 D-1/D-2/D-6）。

---

## 0. 总览（一句话）

平台物化的 FDE 侧文件（模板、`AGENTS.md`、`ports.json`、`config.json`、`manifest.json`）由 **portal（materializer）** 在 **DB 事务提交之后**、以**同目录 tmp + `fsync` + `rename` 原子替换**的方式直写宿主 `/srv/erix/users/<fde>/`；FDE 容器通过 bind mount 只读到**完整、自洽**的文件（靠单文件原子替换 + `manifest.json` 的 generation/sha256 保证多文件一致）。凭据类文件不属于物化/对账覆盖集，见 §4.1.1。

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| **materializer** | portal 内的一个组件（reconciler 的一部分，见 §7），负责把 DB 的 desired state 物化为用户空间文件 |
| **物化（materialize）** | 把 DB 快照派生为文件并原子落盘的过程 |
| **平台文件** | 由 portal/materializer 生成、写入用户空间的文件（`config.json` / `ports.json` / `AGENTS.md` / `.gitignore` / `manifest.json` / 模板）。见 §4 |
| **generation** | 每个 FDE 用户空间的物化批次号，单调递增；是多文件一致性的提交点（见 §5.3） |
| **宿主路径** | `/srv/erix/users/<fde>/...`，materializer 写盘的真实路径 |
| **容器路径** | `/home/<user>/...`，FDE 容器内进程（agentd/worker）看到的路径 |

---

## 2. 路径映射表（宿主 ↔ portal 容器 ↔ FDE 容器）

### 2.1 为什么宿主路径放在 `/srv/erix/users/<fde>/`（而不是 `/docker/`）

- `/docker/<名称>/`（`DATA_ROOT`）是**平台服务自身的持久数据**（`station-db` 的 pg data、`station-edge` 的 acme.json / 动态配置）。它的生命周期、备份口径、属主都跟平台服务绑定（env §6）。
- `/srv/erix/users/<fde>/` 是**FDE 的私人工作区**，属「用户数据」，与平台服务数据分属两类：
  1. **生命周期不同**：offboarding 只停用账号；平台 `users` 行永久保留，workspace 默认不自动清理。只有显式设置 `ERIX_WORKSPACE_RETENTION_DAYS > 0` 才会到期删除 workspace 目录，且不会删除用户或关联 DB 行。
  2. **访问主体不同**：用户空间要被 FDE 容器 bind mount（读/写）；平台服务数据**绝不**挂进 FDE 容器（否则 FDE 可读 pg data / traefik 配置）。
  3. **属主/容量隔离不同**：用户空间按 FDE 分目录、按 FDE 计容量；平台服务数据按服务分目录。
- 选 `/srv`（FHS：本机提供的服务的数据目录）+ `/erix/users/` 命名空间，语义为「erix 平台服务的用户数据」，与 `/docker/` 平台数据在**顶层就分开**，避免备份脚本/运维误把两者混为一谈。
- **结论**：`USER_SPACE_ROOT = /srv/erix/users`（env §6），每 FDE 一层 `<fde>` 子目录。此取值与 H-B 定稿 D-6 完全一致（topology §1），不引入新路径。

### 2.2 三层路径映射

| 层 | 路径 | 说明 |
|---|---|---|
| **宿主** | `/srv/erix/users/<fde>/` | materializer 写盘的真实根；子目录见 §2.3 |
| **portal 容器** | `/srv/erix/users/`（**同路径**，RW bind mount） | portal 需要创建/删除 `<fde>` 目录、直写任意 FDE 的文件，故挂**整根**，且容器内路径与宿主一致，materializer 无需做路径翻译 |
| **FDE 容器** | `/home/<user>/`（HOME）+ 三条子挂载，另有一条**只读**凭据挂载 `/run/erix/git`（#399，不在 HOME 下；见 §2.4） | 容器内进程看到的路径；**与宿主路径不一致**（见 §2.4 理由） |

> **是否挂到 portal 容器：是**。portal 是唯一需要写用户空间的服务（D-6），故只有 portal 挂 `/srv/erix/users`（RW）。`station-edge`（Traefik）与 `station-db` **不挂**用户空间——Traefik 只读自己 `/docker/station-edge/` 的动态配置（600），station-db 只挂自己的 pg data。这条「只有 portal 能写用户空间」的单一写方性质与「Postgres 业务写方只有 portal」同构（D1'）。

### 2.3 宿主目录布局（`/srv/erix/users/<fde>/`）

```
/srv/erix/users/<fde>/
├── home/                       # 容器 HOME 的内容（挂到 /home/<user>）
│   ├── AGENTS.md               # 平台文件（**工位约定 + 平台约束的单一真相**：含预览访问要求链，§4.1.2）
│   ├── .git-credentials        # 遗留/FDE 自配凭据（github 等自配 host 归它；平台托管行已迁 platform/，§4.1.1）
│   ├── .config/
│   │   ├── tea/config.yml      # Gitea CLI 凭据（按 git_hosts provider 投放，§4.1.1）
│   │   ├── gh/hosts.yml        # GitHub CLI 凭据（同上）
│   │   └── glab-cli/config.yml # GitLab CLI 凭据（同上）
│   ├── .erix/
│   │   ├── config.json         # 平台文件（LLM 占位 key + endpoint + model slots）
│   │   ├── mcp.json            # 平台文件（本期空骨架；MCP 本期不做）
│   │   ├── manifest.json       # 平台文件（多文件一致性提交点，§5.3）
│   │   ├── skills/             # FDE/agent 自管（平台不物化内容）
│   │   └── todos/              # FDE/agent 自管（平台不物化内容）
│   └── .cache/station/spool/   # 事件 spool（agentd/worker 写，平台不碰）
├── platform/git/               # 平台托管 Git 凭据（#399；portal 独占写，ro bind 进容器 /run/erix/git）
│   └── credentials             # credential-store 行格式；镜像 /etc/gitconfig 的 fill-only helper 读它
├── projects/<project>/         # 仓库目录（agent clone 目标）
│   ├── .gitignore              # 平台文件（忽略 .erix/ 等，§11）
│   └── .erix/
│       ├── ports.json          # 平台文件（该项目的端口派生视图）
│       └── AGENTS.md           # 平台文件（该项目级约定，含 clone 指引，§11）
├── worktrees/<project>-<runId>/# 每个 run 独占的 git worktree（agentd 创建，平台不碰）
└── cache/                      # 依赖缓存（pnpm store / npm / pip；FDE 自管）
```

### 2.4 FDE 容器挂载表（bind mount 源 → 目标）

| 宿主源 | FDE 容器目标 | 用途 | 属主（§6） |
|---|---|---|---|
| `/srv/erix/users/<fde>/home` | `/home/<user>` | HOME | `erix`(1000) |
| `/srv/erix/users/<fde>/projects` | `/home/<user>/projects` | 项目目录 | `erix`(1000) |
| `/srv/erix/users/<fde>/worktrees` | `/home/<user>/worktrees` | run 工作区 | `erix`(1000) |
| `/srv/erix/users/<fde>/cache` | `/home/<user>/cache` | 依赖缓存 | `erix`(1000) |
| `/srv/erix/users/<fde>/platform/git`（**ro**） | `/run/erix/git` | 平台托管 Git 凭据（#399）：portal 独占写，容器内连 root 都写不动；镜像 `/etc/gitconfig` 的 fill-only helper 读 `/run/erix/git/credentials`（排在 `store` 前，先答先赢） | portal(root)，`0755`/文件 `0644`（ro bind 不改权限、只拦写；容器内按 UID 可读） |

> **为什么容器内路径是 `/home/<user>` 而不是「宿主路径与容器内一致」**：原规格 §12.1 写「bind mount 到容器内同路径（路径一致性约定）」，那是**未定稿的临时表述**（issue #7 指出的缺口之一）。把容器内 HOME 定为 `/home/<user>`（标准 Linux 家目录）有三个好处：
> 1. **避免把宿主路径泄漏进容器**：容器内进程、`$HOME`、shell 提示符、`~` 展开、各类工具写 `~/.config` / `~/.cache` 都落到 `/home/<user>`，而不是 `/srv/erix/...`——镜像与工具对「家目录」的假设全部成立。
> 2. **模板镜像可复用**：所有 FDE 用同一个 `erix` 用户、同一个 `/home/<user>` 布局，无需按 FDE 名现造用户（见 §6 UID）。
> 3. **子目录按用途拆分挂载**：`home` / `projects` / `worktrees` / `cache` 分开挂，属主/容量/备份语义各自清晰；`home` 里的 `.cache/station/spool` 与顶层 `cache/`（依赖缓存）互不干扰。
>
> ⚠️ 待决策者确认：容器内用户名用**固定 `erix`**（倾向）还是按 FDE 名 `alice`（`/home/alice`）。当前倾向**固定 `erix`**——单模板镜像、无需每 FDE 建用户、UID/GID 全局稳定；FDE 身份由 DB `fde_name` 承载，与 OS 用户名无关。若决策者要求「容器内提示符显示 FDE 名」，改为 entrypoint 里 `useradd -u 1000 <fde>` 即可，路径映射不变。

---

## 3. 变更感知（FDE 侧怎么知道文件变了）

**选定：启动读 + 每次 run 前读（worker 组装前）+ 按需快照；不做轮询、不用 inotify。**

| 候选 | 结论 | 理由 |
|---|---|---|
| 仅启动读 | ✗ 不足 | run 级端口（P2）与项目新建/端口变更发生在容器存活期间，仅启动读拿不到最新 `ports.json` |
| **启动读 + 每次 run 前读** | ✅ **选定** | 文件只在「平台状态变更」时变（项目创建/删除、端口分配/释放），频率低；run 是唯一消费点，run 前读一次即拿到最新快照，零常驻开销 |
| 轮询（如 5s 扫 `mtime`） | ✗ 否决 | 对低频事件做高频 IO，纯浪费；bind mount 上跨容器 `mtime` 语义也无增益 |
| inotify 监听 | ✗ 否决 | bind mount 上的跨容器 FS 事件可靠性与顺序难保证；低频事件不值得引入 watch 生命周期与复杂度 |

**落地**：
1. `station-agentd` 在**容器启动时**读一次 `~/.erix/manifest.json` + `~/.erix/config.json`，校验完整性（§5.4）。
2. 每次 claim 到 run、fork worker **之前**，agentd 重读 `~/projects/<project>/.erix/ports.json`（经 manifest 校验，§5.4），把**本次 run 的快照**通过 `run_start` 传给 worker（runner §5）。
3. worker 组装 `runToolLoop` 时读 `~/.erix/config.json`（provider 源）——这是**每次 run 前读**的另一半。
4. run 进行中端口变更**不回刷**正在跑的 run：该 run 继续用自己启动时的快照，新 run 才会看到新值。这是可接受的短暂偏斜（§10）。

---

## 4. 文件清单表（每个生成文件的契约）

> 路径一律用**容器内绝对路径**（读者视角）；宿主路径 = 把 `/home/<user>` 换成 `/srv/erix/users/<fde>/home`、`/home/<user>/projects` 换成 `/srv/erix/users/<fde>/projects`（§2.4）。
>
> 「是否随 allocation 变化」指：`port_allocations`（端口分配）发生变化时，该文件内容是否必须重写。

### 4.1 平台所有、FDE 只读（platform-owned, read-only）

| 文件（容器路径） | 格式 / schema | 写方 | 读方 | 权限 | 随 allocation 变化 |
|---|---|---|---|---|---|
| `/home/<user>/.erix/config.json` | JSON（§4.3.2） | materializer | worker（`createJsonFileModelConfigProvider`）；agentd 启动校验 | `0644`（root:root） | 否（仅 endpoint/占位 key/model slots；与端口无关） |
| `/home/<user>/.erix/mcp.json` | JSON（`{"mcpServers":{}}` 空骨架） | materializer | 本期无（MCP 本期不做） | `0644` | 否 |
| `/home/<user>/.erix/manifest.json` | JSON（§4.3.3） | materializer | agentd / worker（多文件一致性校验） | `0444` | 是（generation 随任一批次递增） |
| `/home/<user>/AGENTS.md` | Markdown（**工位约定 + 平台约束的单一真相**：目录/环境事实/clone 约定 + 预览访问要求链，§4.1.2） | materializer | FDE / agent（人读 + pi 逐级加载）；runner 的 `SYSTEM_PROMPT` 只放「先读它」的强制指针 | `0644` | 否 |
| `/home/<user>/projects/<project>/.erix/ports.json` | JSON（§4.3.1） | materializer | agentd / worker（取端口，永不写，规格 §8.4） | `0644` | **是**（本文件就是 allocation 的派生视图） |
| `/home/<user>/projects/<project>/.erix/AGENTS.md` | Markdown（项目级约定 + clone 指引） | materializer | FDE / agent | `0644` | 否 |
| `/home/<user>/projects/<project>/.gitignore` | 纯文本（含 `.erix/`） | materializer | git（clone/checkout 时忽略平台文件） | `0644` | 否 |

> **「平台所有、FDE 只读」是 best-effort**：由「文件属主 = root、模式 `0644`/`0444`」实现——容器内非 root 进程（1000/1001/1002）只有读权限、无写权限。但 FDE 拥有自己容器的 root/等价权限（runner §11.3），可 `chmod`/`chown`/删除重建绕过。这与 principles §1 原理四一致：**文件权限只能防误改，不能作为安全边界**（真正的边界是网络）。因此这些文件**不承载任何安全敏感内容**——`config.json` 里只有占位 key（§4.3.2），真实 LLM key 永远不进容器。

### 4.1.1 凭据类文件（不纳入物化覆盖集）

| 文件（容器路径） | 写方 / 读方 | 属主与权限 | 物化 / 生命周期 |
|---|---|---|---|
| `/run/erix/git/credentials`（宿主 `<userSpaceRoot>/<fde>/platform/git/credentials`，**ro bind**） | **平台托管凭据唯一落点（issue #399）**：portal（凭据端点 / provision 重铸）独占写；镜像 `/etc/gitconfig` 的 fill-only helper（`/usr/local/libexec/erix-gitcred`）代答 `get`，`store`/`erase` 对它是 no-op ⇒ git 的「认证被拒 ⇒ erase」与 agent 的整文件重写都删不动它 | portal 进程（生产 root），目录 `0755`、文件 `0644`（容器内 agentd/worker 按 UID 可读；ro 挂载拦写，权限不承担防写职责） | **不写入 manifest，不进对账覆盖集**（根本不在 home 树里）。存量（#399 前投进 `.git-credentials` 的行）由 `migrateLegacyCredential`/`cli.js migrate-git-credentials` 整行原样搬入（token 不变）。offboarding 删除。 |
| `/home/<user>/.git-credentials` | **遗留位，降级为 FDE 自配凭据文件（#399）**：FDE 在容器内自配的非托管 host（如 `github.com`）照旧由 FDE 读写；portal 新写不再落这里，只在 offboarding 时删除。镜像 `/etc/gitconfig` 第二条 `helper = store` 读它（平台 helper 未命中才兼答） | FDE UID:GID（默认 `1000:1000`），`0640`（owner 与同组 worker 可读） | **不写入 manifest，不进入 materializer 对账覆盖集**；stale 清理不得删除。offboarding 删除该文件。 |
| `/home/<user>/.config/tea/config.yml` | portal 在 Git 凭据写入时按 `git_hosts.provider=gitea` upsert；tea CLI 读取 | FDE UID:GID（默认 `1000:1000`），`0640`；父目录 `0750` | **不写入 manifest，不进入 materializer 对账覆盖集**；凭据删除移除 host 条目；offboarding 无条件删除该文件。 |
| `/home/<user>/.config/gh/hosts.yml` | portal 在 Git 凭据写入时按 `git_hosts.provider=github` upsert；gh CLI 读取 | FDE UID:GID（默认 `1000:1000`），`0640`；父目录 `0750` | **不写入 manifest，不进入 materializer 对账覆盖集**；凭据删除移除 host 条目；offboarding 无条件删除该文件。 |
| `/home/<user>/.config/glab-cli/config.yml` | portal 在 Git 凭据写入时按 `git_hosts.provider=gitlab` upsert；glab CLI 读取 | worker UID（默认 `1002`），`0600`；父目录保持 FDE UID:GID（默认 `1000:1000`）、`0750` | **不写入 manifest，不进入 materializer 对账覆盖集**；凭据删除移除 host 条目；offboarding 无条件删除该文件。 |

> **glab 特例（issue #148；2026-10-06 实测并裁决）**：glab 1.121.0 硬性要求配置文件恰为 `0600`。agent shell 以 worker UID（默认 `1002`）运行且 `HOME=/home/erix`（`runner/agentd.js` 的 `childEnv`），因此配置文件属主必须是 worker；FDE 的 `erix` 用户（UID `1000`）不能读取该配置，此代价已接受。父目录仍为 `erix:erix`、`0750`，其余 CLI 凭据配置仍为 FDE 所有、`0640`。

**Gitea token scope（issue #148 真机验收）**：代铸 token 使用 `write:user`（在 FDE 本人账号下建仓）、`write:repository`（仓库访问与 push）和 `read:issue`（PR/issue 读取与提 PR）。真实 Gitea 1.27.2、worker UID 1002、使用交付的 tea 配置验收时，`tea pulls create` 报 `token does not have at least one of required scope(s), required=[read:issue], token scope=write:repository,write:user`；在同一实例验证 `read:issue` 与 `write:issue` 两种 scope 组合均成功创建 PR，因此采用最小权限 `read:issue`。**不授予 `write:issue`**：创建 issue、评论等写操作不在当前范围，未来需要时再单独决策。指定 `--owner <组织>` 还需 `write:organization`，当前不授予，未来需要时另行决策。GitLab 当前代铸的 `write_repository` 支持 Git-over-HTTP push，但**不支持 API 认证**；官方 [`glab repo create`](https://docs.gitlab.com/cli/repo/create/) 文档说明该命令创建项目，官方 [token scope 文档](https://docs.gitlab.com/security/tokens/access_token_scopes/)说明 `api` 授予 API 读写、`read_api` 仅读，`write_repository` 不支持 API 认证。官方文档未明确列出该命令的最小 scope；因此现有 impersonation token 的 `write_repository` 足以支持 push、但不足以支持基于 API 的 `glab repo create`，`api` 是文档列出的 API 写 scope。本次不扩大其权限。

**Gitea 已存在账号（issue #148）**：代铸遇到同名账号时复用该账号并重置为新随机口令，再以该口令铸上述 scope 的 token；Gitea 没有管理员代铸 token 的 API，且 token 换 token 返回 401。PATCH 必须带 GET 返回的 `login_name` 与 `source_id`，否则 Gitea 返回 422。#148 真机复验发现，平台通过 `POST /admin/users` 创建且未指定 `login_name` 的账号，GET 会返回 `login_name: ""`，但 PATCH 要求非空 `LoginName`（422 `[LoginName]: Required`），因此 `login_name` 为空或纯空白时改用用户名；`source_id` 仍沿用 GET 值。此分支失败不得删除复用账号。minted 模式下平台持有 Gitea admin key，因而能重置平台代管账号口令；这是该模式的固有能力与预期行为。**offboarding 不删除上游 Gitea 账号**，因此同名 FDE 重建与 token 轮换依赖此复用分支；复用被停用的账号时必须将 `prohibit_login` 设回 `false`，否则 Gitea 1.27.2 的 Basic auth 会返回 401。实测解禁会使旧 token 重新有效，因此改密并解禁后，Station 以新口令 Basic auth 列出 token，只删除 `name` 以 `erix-station-` 开头或 `id` 等于旧 `token_ref` 的 token，再铸新 token；Gitea 删除 token 的 API 按 token **name** 寻址，其他用户自行创建的 token 不删除。

**Offboarding 与保留策略（决策者政策）**：用户下线是永久保留 `users` 行并设为 `disabled`，不删除账号。Gitea `minted` 账号通过管理员 API 设置 `prohibit_login=true` 吊销访问，不删上游用户或 token；员工自行提供的凭据（数据库 `git_hosts.mode='per_fde_pat'`，即用户管理的账号）不触碰，GitLab 上游吊销暂缓。workspace 自动清理默认关闭（`ERIX_WORKSPACE_RETENTION_DAYS=0`）；只有显式正数才启用 sweep，且 sweep 仅删除 workspace 目录，所有用户、Git 绑定、offboarding 与其他 DB 记录继续保留。

**重新激活（issue #161）**：再次雇用同一 `fde_name` 时，管理台复用原 disabled `users` 行（不新建第二行），更新登录名、邮箱、显示名、口令与 TOTP 后设回 active；因此两次雇佣沿用同一用户 ID 与审计/历史记录。若新登录名被别的用户占用则返回 `409 login_conflict`。事务清空旧 `login_sessions`、`login_pending` 与 `api_tokens`，并将 `fde_git_accounts.remote_login` / `token_ref` 清空；历史 `fde_offboarding` 行保留。已有 onboarding 行按原队列契约重置为 pending，重新执行 provision、materialize、LLM binding；provision 重建容器、恢复/重铸 LLM key，并重新投放 Git 凭据。若旧 offboarding 仍处于 pending/running，则拒绝重激活以免与清理任务竞态。Gitea 复用分支在 mint 前吊销 Station 旧 token，避免 `prohibit_login=false` 后旧 token 复活。

Git 凭据按 Git credential-store URL 行格式保存（`https://<username>:<URL-encoded-token>@<host>`）；对应 CLI 配置也含该 host 的明文 token，二者只落在 FDE 用户空间，不进 DB、日志或 `audit_log.details`，也不经环境变量传入容器。portal 以同目录临时文件 + `fsync` + `rename` 原子替换，写前复用 `assertSafePath` 并校验 `realpath` 位于用户空间根内；禁止非法 FDE 名、路径穿越与 symlink 路径。配置按 provider 选择，未注册 host 或不支持的 provider 不写 CLI 配置；轮换原位 upsert。API 只回显 host、username 与 token 掩码。

> **#399（2026-10-26）：为什么平台托管凭据必须离开 `.git-credentials`。**该文件同时有三个写者（portal、FDE/agent、**git 自己**），而 git 的语义是「认证被拒 ⇒ `erase` 掉那枚凭据」——一次 401 就静默删行、rc=0、不留痕迹（现网 eric 两天内被删两次，现场复现实验：可写文件 1 行→401→0 行；ro 文件同一动作凭据存活）。`chmod` 挡不住：store helper 是「同目录建锁文件→写→rename 覆盖」，rename 只看目录可写不看目标 mode。所以平台那份搬进 portal 独占的 `platform/git/credentials` 并 **ro bind** 进容器（挂载级只读才是只读）；存在性判据同步从「DB 里 `token_ref` 非空」换成「平台文件里这一行在不在」，缺了走既有重铸路。`~/.git-credentials` 保留给 FDE 自配凭据，两边不再互侵犯。

该文件是 FDE 经 portal 显式授权投放的 Git 凭据，不是平台控制面密钥；FDE 容器仍不持有 DB、runner 或 LLM 平台凭据。它独立于 manifest 的纯 DB 派生平台文件，凭据更新不触发 generation，也不参与旧 manifest stale 清理。用户下线时 portal 尝试删除此文件；失败只告警，不回滚停用。

平台不下发 SSH 私钥：OpenSSH 要求私钥仅属主可读（通常 `0600`），与 worker 通过组权限读取凭据的 `0640` 契约冲突；本契约仅支持 Git HTTPS credential-store 凭据。宿主侧有权访问用户空间的进程仍可读取该明文文件，这是宿主侧残余风险，文件权限不是安全边界。

### 4.1.2 `~/AGENTS.md` 的职责边界：平台约束的**单一真相**（issue #257 + #258，2026-10-12）

`~/AGENTS.md` 不只是「容器级约定」：自 #257/#258 起它同时是**应用侧要求链的唯一可读面**——
外部浏览器要用一个跑在预览域名上的应用必须满足哪几条、每种失败形态是谁给的，全部写在这一份文件里
（当前内容：目录约定 / **预览访问 8 条 + 错误形态对照**（#262 起 7 条、#285 起 8 条：第 8 条是**告知义务**——报「服务已起」就必须给出清单里那条完整预览 `url` 并提醒逐 host 放行，不是一种错误形态，故**对照表不加行**）/ clone 方式 / 环境事实 / git）。

| 项 | 口径 | 依据 |
|---|---|---|
| 为什么落在 `~/AGENTS.md` 而不是 runner 的 `SYSTEM_PROMPT` | 提示词与 portal 文案是**两个包里的两份文案**；规则抄进提示词就是埋下第二个会过期的真相源（同 `AGENTS.md` §8.10「工具名从注册面取、不手抄清单」） | 决策者定稿（#258 `#issuecomment-6117800165`） |
| `SYSTEM_PROMPT` 的角色 | 只留一句**强制指针**「开工先读 `~/AGENTS.md`」，**不复述规则**；防漂移：`runner/test/system-prompt.test.js`（该测试**双向**禁/钉 `allowedHosts` / `credentials` / `CORS` / `Set-Cookie` / `localStorage` / `Bearer` / `打开预览` / `markdown 链接` 这八个具体规则词：提示词里不得出现、`renderHomeAgentsMd()` 输出里必须存在；后三个随 #262 第 7 条加入，最后两个随 #285 第 8 条加入） | 同上 |
| 内容红线 | 本节**不得出现端口数字 / 端口区间 / 伞域字面量**（号段与域名都是生成值，#246 / #57）；host 一律以「取清单里那一条的 `url`」的口径表达 | `portal/test/materializer.test.js` |
| 「下发了 ≠ 读了」 | 物化落盘不等于 agent 真读了它；`runner/worker.js` 提示词的强制指针就是为这条 P0 存在（真机实测：旧提示词下 `AGENTS.md` 只在 2 轮出现，1 轮只是 `ls` 扫到） | 复测协议 R-1 P0 |
| 读取边界（#259 未落地前） | `createJail({ root: cwd })` 的读边界只有项目根（**无只读例外**），故 `readFile` 读不到 `~/AGENTS.md`；提示词与 8 条都自带「用 shell（`cat`）读」的口径。#259（家目录只读例外）**不在本单** | `runner/worker.js` 的 jail 装配；前提单 #259 |

本节内容的**实证来源**是演练记录 [`../ops/drill-2026-10-12.md`](../ops/drill-2026-10-12.md) §三：一个最普通的前后端分离应用要满足 6 条，其中 3 条当时根本没告知，靠人发第 3、4 条消息才修通——缺口在告知面，不在 agent 能力。

### 4.2 FDE / agent 所有（平台不物化内容，只保证目录存在与属主正确）

| 路径（容器路径） | 写方 | 说明 |
|---|---|---|
| `/home/<user>/projects/<project>/`（仓库内容） | agent 代劳 clone + FDE/agent 编辑 | 平台只创建空目录与平台文件；Git 凭据由 FDE 经 portal 投放（#110，§4.1.1） |
| `/home/<user>/worktrees/<project>-<runId>/` | **agentd**（`git worktree add`，runner §6.2） | **worktree 元数据无文件**：run↔worktree 绑定在 DB（`runs.id` + 路径约定 `~/worktrees/<project>-<runId>`），不在用户空间物化任何元数据文件（避免与 git 自身元数据冲突、避免双真相） |
| `/home/<user>/.cache/station/spool/<runId>.jsonl` | agentd / worker（事件缓冲，runner §7.5） | **JSONL**（append-only，每行一个事件信封）；run 结束后清排；平台不读不写 |
| `/home/<user>/cache/` | FDE / agent（pnpm store / npm / pip） | 依赖缓存，内容平台不代管；**位置由 FDE 镜像预配**（`/usr/local/etc/npmrc` 的 globalconfig + `COREPACK_HOME`/`PIP_CACHE_DIR` ENV，见 runner/Dockerfile） |
| `/home/<user>/.erix/skills/`、`.erix/todos/` | FDE / agent 自管 | 平台只建目录（若模板需要），内容不物化 |

> **为何预配缓存位置**（eric 空间实测 2026-10-24）：不指默认时 pnpm 会自己在「项目所在卷」上找地方建
> `.pnpm-store`，而 `~/projects` 正是 projects bind mount 的根 → 实测长出 388 MB 的 `~/projects/.pnpm-store`，
> 污染目录列表（`dirs.js` 现已过滤 `.` 开头目录作展示层兼容）。globalconfig 是 npmrc 链最低一层，
> 只供默认值：`~/.npmrc` 与项目 `.npmrc` 仍可覆盖（已实测），所以这不与「内容 FDE 自管」冲突。

> **spool 路径澄清**：事件 spool 在 `~/.cache/station/spool/`（runner §7.5 原文），依赖缓存在 `~/cache/`（规格 §12.1）——两者**不同目录**，不是同一路径的两处写法。本表按此区分，不改 runner-integration.md。

### 4.3 JSON schema

#### 4.3.1 `ports.json`（FDE 级分配告知 + in_use 咨询位，schema 2）

路径：`/home/<user>/.erix/ports.json`（P5 去项目化后为 FDE 级单一文件）。schema 2（issue #361）只载**分配事实**：

```json
{
  "schema": 2,
  "fde": "alice",
  "generation": 42,
  "block": { "start": 22000, "end": 22009 },
  "allocations": [
    { "port": 22000, "url": "http://alice-p-22000.fde.erix.vip:8090", "in_use": true },
    { "port": 22001, "url": "http://alice-p-22001.fde.erix.vip:8090", "in_use": false }
  ]
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | int | 固定 `2`（读方据此做向后兼容分支） |
| `fde` | string | FDE 名（与 `port_allocations` 同源） |
| `generation` | int | = 物化时 `manifest.json` 的 generation（跨文件一致性锚点，§5.3） |
| `block` | obj \| null | 分配段范围（活跃分配的最小/最大端口；无分配 ⇒ null） |
| `allocations[]` | array | 该 FDE 当前所有未释放分配（`state ∈ {allocated, active}`）的投影，按端口升序 |
| `allocations[].port` | int | 与 `port_allocations.port` 同源 |
| `allocations[].url` | string | 现成预览地址（**agent 报地址时取此原值**，永不自行拼接；#240 口径） |
| `allocations[].in_use` | bool \| null | **咨询位**：新鲜观测（`port_observations`，≤45s，与门户读端点同口径）镜像「此刻有进程在听」；`null` = 无观测数据（**≠空闲**）。仲裁仍是内核 `bind()`（`EADDRINUSE` 即拒绝换口），平台不据观测做任何管控（#246 不变式） |

**使用面事实永不进文件**（#361 决策）：「谁在占哪个口、干啥用」是心跳黑板（`port_observations`，允许丢失自动重建）；文件只回答「哪些号归我」。旧 schema 1 的 `scope/role/run_id/exposure/state` 已剃除（P5 后恒值/无消费者）。

**刷新纪律**：`in_use` 翻转（观测端口集合变化）时由心跳写侧入队 materialize 重刷；不跟 15s 心跳节拍做全量物化。

**序列化规则（幂等前提）**：对象键序固定（按渲染模板插入序，非字典序）、2 空格缩进、末尾换行。同一 DB 快照 → 字节级相同的文件（§5.5）。

#### 4.3.2 `config.json`（LLM 配置，占位 key + endpoint）

路径：`/home/<user>/.erix/config.json`。

```json
{
  "slots": {
    "default": {
      "apiKey": "erix-placeholder",
      "endpoint": "https://llm.erix.vip/v1",
      "model": "claude-sonnet"
    },
    "audit": {
      "apiKey": "erix-placeholder",
      "endpoint": "https://llm.erix.vip/v1",
      "model": "claude-haiku"
    },
    "fold": {
      "apiKey": "erix-placeholder",
      "endpoint": "https://llm.erix.vip/v1",
      "model": "claude-haiku"
    }
  }
}
```

| 项 | 取值 | 说明 |
|---|---|---|
| `slots.*.apiKey` | `"erix-placeholder"`（占位哨兵值） | **非真实凭据（2026-09-20 确认，issue #38：容器内占位 key 语义不变）**。worker 依此发送 `Authorization: Bearer erix-placeholder`，Traefik 在 `llm.<base>` 路由用 `customRequestHeaders` **覆盖**为该 FDE `fde_llm_bindings` 的**真实上游 api_key**（per-FDE，topology §10 证据 8；修订前为「覆盖为平台虚拟 key 再经 llm-hub 网关」）。**真实 key 永不物化进容器**（D-4）。**fail-closed：无 binding（含未配 api_key）→ 该 FDE 无 LLM 路由，出口 404**（2026-09-20 修订，issue #38）。 |
| `slots.*.endpoint` | `https://llm.<base>/v1`（`llm.<base>` = `llm.erix.vip`，env §10 `LLM_HOST`） | 容器内经 `--add-host llm.<base>:<本 FDE 网关 IP>` 解析到 Traefik host:443（env §0/§1）；**不写 A 记录、不进 DNS**。 |
| `slots.*.model` | `default`/`audit`/`fold` 三个 slot 的模型名 | 平台默认值；`audit`/`fold` 用便宜模型（规格 §11.4）。 |

> **issue #117 phase 2 当前凭据口径**：上表 2026-09-20 的「真实上游 api_key」说明为历史方案；当前 Traefik 注入 `fde_llm_bindings.api_key` 中的 LiteLLM per-FDE virtual key，上游凭据只保存在 LiteLLM credential。Station 槽位以 `model_info.id` 识别模型，并将对应 `model_name` 用作请求体值。

> **已对齐上游（v0.3.5 `src/config/json-file.js` 实测）**：`config.json` 顶层键为 **`slots`**，即 `{"slots": {"default": {apiKey, endpoint, model}, "audit": …, "fold": …}}`；`createJsonFileModelConfigProvider` 只认 `parsed.slots`（缺 `slots` → 配置解析失败）。字段名 `apiKey`/`endpoint`/`model` 与实现（materializer）一致；平台承诺语义 =「占位 key + `endpoint=https://llm.<base>/v1` + `default/audit/fold` 三 slot」。

#### 4.3.3 `manifest.json`（多文件一致性提交点）

路径：`/home/<user>/.erix/manifest.json`。结构见 §5.3。

---

## 5. 原子写与多文件一致性

### 5.1 单文件原子写（每个平台文件都走这套）

1. **temp 命名**：与目标文件**同目录**、`<目标名>.<随机 8 hex>.tmp`（例 `ports.json.9f2c1a4b.tmp`）。同目录保证 `rename` 是**同文件系统内**的原子替换（跨目录/跨挂载点 rename 可能退化为 copy，失去原子性）。
2. **写 + fsync 文件**：以 `O_WRONLY|O_CREAT|O_EXCL` 打开 temp（防覆盖既有 temp、防预置符号链接）→ 写入完整内容 → `fdatasync`（内容持久化）→ `close`。
3. **rename 原子替换**：`rename(tmp, target)`——读者要么看到旧文件、要么看到新文件，**绝不会看到半截文件**。
4. **fsync 目录**：`open(目标目录, O_DIRECTORY)` → `fsync`，把「目录项指向新 inode」这一变更持久化（否则 crash 后 rename 可能丢失、回退到旧文件——这本身安全，但会与 DB 已提交状态偏斜更久）。
5. **失败处理**：任一步失败 → `unlink(tmp)`（不留垃圾）→ 该物化批次进入失败重试（§7）。

### 5.2 平台文件权限落盘顺序

文件先以 `0600` 写入 temp（内容不提前泄漏），rename 前用 `fchmod` 设为最终模式（`0644` / `0444`），再 rename。避免「rename 后、chmod 前」出现一个短暂可写的最终文件。

### 5.3 多文件一致性：generation + manifest

单文件原子替换只保证**每个文件**完整，不保证**多个文件之间**是同一代。例：一次端口分配同时重写 `ports.json`（项目 A）与 `manifest.json`，worker 若在两次 rename 之间读，可能读到「新 ports.json + 旧 manifest」。用 manifest 作为**提交点**解决：

**manifest 文件名**：`/home/<user>/.erix/manifest.json`。

**结构**：

```json
{
  "schema": 1,
  "fde": "alice",
  "generation": 42,
  "materialized_at": "2026-09-12T08:30:00.000Z",
  "files": {
    "/home/erix/.erix/config.json":   { "sha256": "<hex64>", "revision": 7 },
    "/home/erix/.erix/mcp.json":      { "sha256": "<hex64>", "revision": 1 },
    "/home/erix/AGENTS.md":           { "sha256": "<hex64>", "revision": 3 },
    "/home/erix/projects/proj1/.erix/ports.json": { "sha256": "<hex64>", "revision": 12 },
    "/home/erix/projects/proj1/.gitignore":        { "sha256": "<hex64>", "revision": 1 }
  }
}
```

| 字段 | 语义 |
|---|---|
| `generation` | 该 FDE 用户空间的物化批次号，**单调递增**。任一批次有任一文件内容变化时 +1；内容无变化的重物化**不**递增（幂等，§9）。 |
| `files` | 当前 generation 下**全部**平台文件的**内容哈希**（`sha256`）与 per-file `revision`（该文件内容变化次数，诊断用）。**keys 用容器内绝对路径**（读者是容器进程）。 |
| `materialized_at` | 本 generation 的物化时刻（UTC ISO 8601） |

**写序（提交点）**：
1. 重写本次要变更的每个平台文件（各自 tmp + fsync + rename，§5.1）。
2. **最后**重写 `manifest.json`（tmp + fsync + rename + fsync 目录）——manifest 是「这批文件已全部就位」的提交标记。

**读序（校验）**：
1. 读 `manifest.json`（其自身是原子替换，读不到半截）→ 得 generation G 与各文件 `sha256`。
2. 逐文件读取并计算 `sha256`，与 manifest 记录比对。
3. **全部匹配** → 使用这批文件；**任一不匹配** → 判定为「读到跨代混合版本」，**放弃本次结果**，退避后重读（建议 20ms → 50ms → 100ms，封顶 3 次）。
4. 3 次仍不一致 → 视为平台侧物化异常，agentd **告警**（记日志 + 下次心跳上报 `materialize_mismatch`），并**暂停领取新 run**（A8 定稿：不降级到「最后一份一致快照」——单文件原子替换只保证单文件一致，读方没有版本化快照/双目录提交可可靠取回旧一致状态，降级承诺不可实现）。

> 为什么「读 manifest → 读文件 → 比哈希」能保证不读到混合版本：文件被 rename 到新代（G+1）时，其哈希不再等于 manifest 里 G 代记录的值，读方必能检测到，从而重试收敛到某一完整代。物化频率低（端口变更才发生），重试窗口可忽略。

### 5.4 FDE 侧读文件必须走 manifest（硬规则）

agentd / worker **不直接裸读** `ports.json` / `config.json`：一律「先读 `manifest.json` → 校验目标文件 `sha256` → 再用」。这是「不会读到跨文件混合版本」的唯一保证点（§3 已把它并入「启动读 / 每次 run 前读」）。

### 5.5 幂等序列化

materializer 对所有 JSON 统一「**固定键序**（按渲染模板插入序）+ 2 空格缩进 + 末尾换行」；Markdown/纯文本用固定模板渲染。保证：**同一 DB 快照 → 字节级相同输出**。这使「重复物化」「全量重物化」都幂等（§9），且 `sha256` 稳定、可比对。

---

## 6. 属主与权限（UID/GID、目录权限、umask、写入身份、路径安全）

### 6.1 UID/GID 取值（平台规范固定）

| 角色 | UID | GID | 运行位置 | 说明 |
|---|---|---|---|---|
| FDE 用户 `erix` | **1000** | **1000** | FDE 容器 | 工作区属主；FDE 交互通道为对话界面，dev servers 以它运行 |
| `erix-agentd` | **1001** | 1000 | FDE 容器 | 唯一持 per-container token 的进程；fork worker 时切 UID（runner §11.3） |
| `erix-worker` | **1002** | 1000 | FDE 容器 | 每 run 一个；跑 `runToolLoop`/工具；无平台控制面凭据，可经 HOME 文件读取显式投放的 Git 凭据（§4.1.1） |
| portal（materializer 写入身份） | **0（root）** | 0 | portal 容器 | 控制面：需 `chown`（把工作区目录属主设成 1000）、写 Docker API、写 Traefik 动态配置（600）与 LLM key 文件 |

> 三 UID（1000/1001/1002）共享 GID 1000，是为了让 agentd（1001）能建 worktree、worker（1002）能读写工作区（见 §6.2 组权限），同时保持三者 UID 不同——worker（1002）读不到 agentd（1001）的 `/proc/<pid>/environ`，token 不泄漏（runner §11.3 的「不同 UID 优先」落地）。

### 6.2 目录/文件权限与 umask

| 对象 | 属主 | 模式 | 说明 |
|---|---|---|---|
| `/srv/erix/users/`（宿主根） | root:root | `0755` | 仅 portal（root）可写；Traefik/db 不挂、无权限 |
| `/srv/erix/users/<fde>/` 及其下**每轮 reconcile 的**工作区目录（`home`、`projects`、`cache`） | `erix`(1000):`erix`(1000) | **`0770`**（组 rwx，**无 setgid**） | 组 rwx 使 agentd(1001)/worker(1002) 可读写（三者主组恒为 1000）；**不需要 setgid**——新建子项的 GID 由写入进程的**主组**决定（恒 1000），不由目录的 setgid 位决定。口径与成因见本节末「为什么不需要 setgid」 |
| `projects/<p>/`（**只创建一次**的那类，由 `sessions.js` `createSession` 建） | `erix`(1000):`erix`(1000) | **实测 `2770`**（首轮 `chmod` 时属组仍 == 进程 egid 0 ⇒ setgid 落得下，见成因 (a) 第 2 步） | ⚠ **同一棵树里 setgid 位是混的，别当一致状态**（真机实测 `eric/projects/probe-343`、`blind/projects/r1-app` = `2770`，同树 `eric/projects/probe-261014` = `770`）：同一项目再建第二个 session 会被下一轮 `chmod` 清成 `0770`。遗留的 `home/worktrees` 还见过 `2755`（在 `2770` 父目录里新建会**继承** setgid + umask `0022`）⇒ 结论同上：setgid 在这里不承载访问权 |
| `.erix/`（HOME 级与项目级） | `erix`(1000):`erix`(1000) | `0750` | FDE 可管理 `skills/todos`；平台文件在其中为 root 属只读（下一行）；agentd/worker 只读 |
| `.cache/station/spool/`（事件 spool，**尚未实现**） | `erix`(1000):`erix`(1000) | 口径随创建者，**先不给数字** | spool 目前不落盘（runner README §7.5 待定项），全仓无创建该目录的代码 ⇒ 无法指到实测。将来落盘时按成因 (a) 判：**portal 建 ⇒ `0770`**（属组交出后被清）；**agentd/worker 建 ⇒ `2770` 会真落下**（其主组 1000 == egid，`chmod` 清不掉）。需要组写的结论不变（agentd 与 worker 都写） |
| **平台文件**（`config.json`/`mcp.json`/`ports.json`/`AGENTS.md`/`.gitignore`） | root:root | `0644` | 容器内 1000/1001/1002 可读、不可写（防误改；FDE 有 root 可绕过，§4.1 已声明） |
| `manifest.json` | root:root | `0444` | 更强只读（内容无敏感，但改它即破坏一致性校验，故只读） |
| `~/.git-credentials`（遗留/FDE 自配） | FDE UID:GID（默认 `1000:1000`） | `0640` | Git credential-store；owner 1000 与同组 agentd/worker（1001/1002）可读，其他用户不可读；不由 materializer 管理；#399 后 portal 不再往这里写平台托管行 |
| `platform/git/credentials`（宿主侧，ro bind 到容器 `/run/erix/git/`，#399） | portal 进程（生产 root:root） | 目录 `0755`、文件 `0644` | 只读靠**挂载级 ro**，不靠 mode；容器内全员可读（helper 代答需要）、连 root 不可写；portal 独占写（tmp+rename 在宿主目录里完成，不受 ro 影响——ro 只存在于 FDE 容器的挂载视图） |
| 容器内进程 `umask` | — | **`0002`** | 新建文件 664、新建目录 775（`runner/entrypoint.sh` 设一次，`agentd.js`/`worker.js` 各自防御性重设）。组写位**确实生效**——靠的是三者主组同为 1000 + 目录属组 1000，**与 setgid 无关**。注：`docker exec` 起的临时 shell 不在该进程树下，仍是镜像默认 `0022`（实测），别拿它当容器 umask 的证据 |

**portal 写入身份**：portal 容器以 root 运行，materializer 以 root 写平台文件（root:root），并在创建/重建工作区目录时 `chown 1000:1000` + `chmod 2770`（代码意图；**落盘是 `0770`**，成因见下）。这是「portal 直写」能同时满足「工作区属主=FDE」「平台文件=root 只读」的机制。

#### 为什么是 `0770` 而不是 `2770`（issue #273，2026-10-24 定稿）

**现状（实测，不是推测）**：portal 每轮 reconcile 的工作区目录落盘 `0770`，属主 `erix`(1000):`erix`(1000)；**只创建一次的目录（`projects/<p>/`）实测停在 `2770`**（首轮遗留）。`portal/src/{fsutil,provisioner,materializer,sessions}.js` 传的一直是 `0o2770`，但 setgid 位在 reconcile 循环里**将来也不会**留下来（成因见 (a)）——注意这句只描述 **portal 侧反复 chmod 的目录**，不等于全树一致，见上表的「混的」那行。

**(a) 根因：不是 `chown` 清掉的，是 `chmod` 在缺 `CAP_FSETID` 时被内核静默清掉的**

`ensureDirSafe` 是三步 `mkdir(recursive, 0o2770)` → `chmod(0o2770)` → `chown(1000,1000)`，逐轮实测（portal 镜像 + compose 里那套 cap）：

1. **`mkdir` 这一步永远交不出 setgid**：`mkdir(2)` 传 `0o2770`，umask 022 → `0750`、umask 0002 → `0770`，setgid 位两次都没落下。
2. **`chmod` 只在「目录属组 = 进程 egid」时落得下 setgid**：portal 以 `uid=0 gid=0` 运行，刚 `mkdir` 出来的目录属组还是 0 ⇒ 首轮 `chmod` 得 `2770`（真机 `/srv/erix/users/portsprobe` = `2770` 正是这一轮的遗留）。
3. **从第 2 轮起必然被按回 `0770`**：第 1 轮的 `chown(1000,1000)` 把属组交出去后，下一次 reconcile 的 `chmod(0o2770)` 面对的是「属组 1000 ≠ 进程 egid 0」，而 portal 的 `cap_drop: [ALL]` + `cap_add: CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID` **不含 `CAP_FSETID`**（容器内实测 `CapEff=00000000000000cb`，`0xcb & 0x10 == 0`）⇒ 内核**静默清掉 setgid**、permission 位 770 原样保留、`chmod` 不抛错（所以 `fsutil` 的 `catch` 连告警都不会有）。探针逐轮：`2770 → 0770 → 0770` 稳态。

对照组（同一操作换身份）：以 `gid=1000` 的身份 `chmod 2770` ⇒ 稳得 `2770`；`chown` 目录本身**不清** setgid（内核 `chown(2)` 只对非目录清 suid/sgid）——所以「补 `CAP_FSETID` 就能拿到 2770」成立，但见 (b)。

**(b) 这不是缺陷：setgid 在本设计里不承载任何行为**

1. **GID 继承已由「主组」达成**：FDE 容器内三个 UID（`erix` 1000 / `erix-agentd` 1001 / `erix-worker` 1002）**主组都是 1000**（实测 `id`：`uid=1000(erix) gid=1000(erix)`；以 1001/1002 身份建文件实测 gid 恒 1000）。新建子项继承 GID 1000 靠的是 `fsgid`，与目录的 setgid 位无关 ⇒ setgid 想给的那件事**已经在发生**，它不是任何行为的因。
2. **组写位对 agentd/worker 生效，靠的也不是 setgid**：`umask 0002` 下以 1001/1002 身份实测得 `f=664`、`d=775`、gid 1000；能写进 `0770` 目录靠的是「目录属组 1000 + 组写位」，而属组是 portal 显式 `chown` 出来的、子项属组是主组继承来的。**全程没有 setgid 参与。**
3. **portal 侧不靠组**：portal 是 root + `CAP_DAC_OVERRIDE`（`CapEff=0xcb` 含 bit1/bit3），FDE 进程是**属主**身份读写自己的目录。组既不是 portal 的通道，也不是 FDE 的通道。
4. **补 `CAP_FSETID` 只改一个看不见的数字**：多一项 capability（违背最小权限），换来界面上、`stat` 的 group 归属上、任何访问判定上都**完全一样**的结果；还会造出「有没有那个 cap 部署行为不同」的隐性差异。
5. ⚠ **以上四条成立有一个前提，它是会被人不小心破坏的**：**所有 FDE 属主写点都必须同时传 `uid` 与 `gid`（=1000）**。`fsutil.ensureDirSafe` 的 `gid` 默认是 `null`、`chownSync(dir, uid ?? -1, gid ?? -1)` 会把它当「不改」，所以任何**只传 uid** 的新调用点都会在目录里留下 `gid=0`（root 组）的文件——那时 setgid 就**真的开始承重**，本节「别补 `CAP_FSETID`」的结论随之失效。逐调用点核对结果（2026-10-24）：`materializer.js:234`、`provisioner.js:236`、`sessions.js:232`、`git-credential.js:324/358`、`git-cli-config.js:75-78` 全部同时传 uid+gid；只有**平台文件**（`materializer.js:272/293`）不 chown，落 `root:root 0644/0444`（全员可读，无访问依赖）。

> 部署面同源代码：`deploy/docker-compose.yml` 里 proxy 的 `DAC_OVERRIDE` 注释仍写「穿越 **2770** 用户空间目录」，是同一处历史口径（本单红线不动 compose），随下次 compose 变更一起同步成 `0770`。

**(c) 将来真要「组协作」要动的是 umask / 组成员，不是 setgid**

setgid 只影响**新建子项的属组**，一个 mode 位都不改；「组能不能写」由 **umask（决定 mode 位）** 与 **组成员关系（决定谁是组）** 决定。真要让某个新进程（主组不是 1000）也能协作用户空间，正确动作是把它加进 GID 1000 / 设 `fsgid=1000`，或调整 `umask`；**给它所在的目录补 setgid 位解决不了这个问题**。⚠ 别为了「把文档兑现成 2770」去动 `cap_add`——那是本末倒置（issue #273 明确选 C：改口径，不加 cap）。

### 6.3 禁止 symlink / path traversal（写侧硬规则）

materializer 所有写入路径**只能由 DB 白名单值派生**，并做符号链接防御：

1. **名字白名单**：`<fde>` 与 `<project>` 只取 DB 值，`<project>` 受 `CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')` 约束（schema.sql），`<fde>` 同受用户名校验——**不可能**出现 `..`、`/`、绝对路径、空段。任何拼出的路径先 `realpath`/规范校验，越出 `/srv/erix/users/<fde>/` 即拒。
2. **`O_NOFOLLOW` + `O_EXCL`**：写 temp 用 `O_CREAT|O_EXCL|O_NOFOLLOW`；rename 前对**目标路径的每一段目录**做 `lstat` 校验：是符号链接 → **拒绝 + 告警**（视为 FDE 篡改，`materialize_path_tampered`）。`rename()` 本身**不跟随目标文件的符号链接**（替换的是链接本身），所以最终文件不能被预置 symlink 劫持；真正要防的是**目录段**被换成 symlink（如把 `projects/proj1/.erix` 换成指向他 FDE 目录的链接）。
3. **先建目录、后写文件**：materializer 先 `mkdir -p` 并校验目录属主（不满足则 `chown`/重建），再写文件；目录缺失时创建，目录为 symlink 时拒写。
4. **从不读回用户空间内容做决策**：materializer 的输入**只来自 DB**，不把用户空间文件当输入——避免「FDE 篡改文件 → 平台行为被污染」。

---

## 7. 失败与重试状态机（DB commit → materializer → file revision → retry/backoff → alert）

### 7.1 物化链路（与 route outbox 同构，独立 outbox 表）

```
① DB 事务提交 desired state
   （例：建项目 = projects + port_allocations + route_outbox(port_allocation) + materialize_outbox 行）
        │
② materializer 消费（claim，FOR UPDATE SKIP LOCKED，租约 60s）
   · 只领取 revision = materialize_revisions.revision（head）的 pending 行
   · 以 DB desired state 重读为纯函数输入，渲染目标文件内容（§5.5）
   · 逐文件 tmp → fsync → rename → fsync 目录（§5.1）
   · 最后写 manifest.json（generation+1，§5.3）
        │
③ 成功 → 标记 published + 递增 materialize_revisions.revision head + 记录 generation
   失败 → attempts+1，退避重试（1s→2s→5s→10s→30s 封顶，±20% 抖动）
        │ attempts 耗尽（≥5 ⚠️）→ failed + 告警；保留上一版文件（不回滚、不写半截）
```

> **A7 定稿：materializer outbox 使用独立表 `materialize_outbox` + `materialize_revisions`**（已落 schema.sql §9 / model.md §1.22，不复用 `route_outbox`）。理由：避免与路由 reconciler 争抢同一行/同一租约/同一键空间，且聚合键（per-FDE）、租约、attempts、失败语义各自独立清晰。
>
> **写入路径（portal，同一 DB 事务）**：写 desired state（`projects` / `port_allocations` 等）+ `INSERT materialize_outbox(op, revision, payload)` + 同事务递增 `materialize_revisions.revision`（`INSERT ... ON CONFLICT (fde_id) DO UPDATE SET revision = materialize_revisions.revision + 1`）。
>
> **消费路径（materializer）**：`FOR UPDATE SKIP LOCKED` 领取 `revision = materialize_revisions.revision`（head）的 `pending` 行 → `processing`（写 `claimed_at/lease_until/worker_id`）→ 以 **DB desired state 重读**为纯函数输入渲染该 FDE 全部平台文件（§5.5，不依赖 payload 增量）→ 逐文件 tmp+fsync+rename（§5.1）→ 最后 manifest.json（generation+1，§5.3）→ `published`。失败 → `attempts+1` 退回 `pending` 退避重试；耗尽 → `failed` + 告警（保留上一版文件）。崩溃恢复：materializer 启动时+定时任务把 `state='processing' AND lease_until<now()` 回收为 `pending`（`attempts+1`）。
>
> **快照隔离 + 同 FDE 串行 + latest-wins**：materializer 重读 DB desired state 为唯一输入（纯函数）→ 渲染结果只依赖「领取时刻已提交」的快照，天然快照隔离；每个 FDE 同时只有一个 `revision = head` 被领取 → 同 FDE 并发物化天然串行；`revision < head` 的晚到旧事件/旧 tombstone **一律丢弃**（latest-wins）。
>
> **已删除文件清理**：materializer 每次消费对该 FDE 做声明式全量收敛——磁盘上存在但 DB desired state 已无的文件（如项目删除后的 `projects/<p>/.erix/*`）**落盘删除**，并在 manifest.json 中移除对应项（`op='delete'` 是触发信号，权威内容以 DB 为准）。

### 7.2 「DB 已提交但文件未发布」的语义与读取方行为

这是**派生视图必然存在的持久化缺口**（DB 真相已变、文件还没跟上）。语义与处置：

| 读取方 | 看到什么 | 后果与兜底 |
|---|---|---|
| **agentd / worker（读 `ports.json`）** | 旧的、**完整且自洽**的快照（单文件原子替换 + manifest 保证不会读到半截/混合） | 可能暂不知道新端口。但端口申请是**发 API、DB 分配**（规格 §8.1），agent 绝不会「因文件没更新而自己去挑端口」→ 无错误分配风险。 |
| **forward-auth / 预览路由** | 不受文件影响——读 **DB**（`port_allocations.hostname` 精确查，portal.md §2.7） | 路由可用性由 route outbox/reconciler 决定，与用户空间文件无关 |
| **materializer** | 该缺口由**重试 + 定时对账**收敛 | 缺口有界：退避重试耗尽前必收敛；耗尽则 `failed` + 告警，对账任务继续重试 |

**核心不变式**：**文件是 DB 的派生视图，DB 是真相**。文件落后只会造成「新端口暂时不可见」，**不会造成错误分配、不会造成越权**（分配唯一性在 DB 唯一约束 + 事务，路由可达性在 DB hostname 精确查）。因此该缺口是「可用性偏斜」，不是「正确性缺口」。

### 7.3 磁盘满 / 权限错误的处置

| 故障 | 表现 | 处置 |
|---|---|---|
| **磁盘满（ENOSPC）** | temp 写失败 / fsync 失败 | 与工作区同盘 → 同时影响 FDE 工作，属**宿主级事故**。materializer 退避重试（§7.1），连续失败标记 `failed` + **立即告警**（code `disk_full`）。不清空任何既有文件（保留上一版）。 |
| **权限错误（EACCES / EPERM）** | 目录属主被改 / mount 只读 / UID 映射错 | **配置错误，非瞬时**：立即告警（code `permission_denied`），**不**做高频盲重试（降为低频对账重试），提示运维核对 §6 的 UID/GID/mount。 |
| **路径被篡改（symlink）** | `lstat` 校验失败 | **立即告警**（code `materialize_path_tampered`），标记 `failed`；不写、不 follow（§6.3）。 |
| **rename 跨设备（EXDEV）** | 同目录写 temp 但目录被换成跨设备链接 | 视为路径篡改/配置错误，同上告警（正常设计下不会发生：temp 与目标恒同目录，§5.1）。 |

> 告警通道本身（邮件/IM webhook）为**延后事项（P2+）**（规格 §14），但**告警状态**（`failed` + code）是 materializer 的落库事实，P1 即可实现、可查询，不阻塞。

---

## 8. 重建与幂等

### 8.1 谁触发全量重物化

| 触发 | 触发方 | 范围 |
|---|---|---|
| onboarding（建 FDE） | materializer（portal） | 该 FDE 全量：`home/` 骨架 + `~/.erix/*` + `~/AGENTS.md` + 空 `projects/ worktrees/ cache/` |
| 建项目 / 删项目 | materializer | 该项目目录 + 该 FDE `manifest.json` |
| 端口分配 / 释放 | materializer | 该项目 `ports.json` + `manifest.json` |
| **portal / 容器重建后** | materializer 的**启动对账**（topology §8「portal/Traefik 启动时从 DB 全量重建缺失状态」） | 全 FDE 全量：逐 FDE 比对 manifest `sha256`，缺失/不一致即重物化 |
| **FDE 容器重建** | reconciler 检测容器 recreate → materializer 重物化该 FDE | 该 FDE 全量（保证新容器拿到完整、自洽文件；bind mount 数据本就在，重物化是幂等确认） |
| 定时对账 | materializer（周期，如每 5min ⚠️） | 漂移检测：manifest 记录 vs DB 派生 vs 磁盘实际，三向比对，漂移即修 + 告警 |

> **物化状态范围（issue #183）**：materializer 对 `users.status ∈ {active, awaiting_credential}` 的 FDE 都物化——`awaiting_credential`（容器/工作区已在、Git 凭据待补）也是「活」状态，凭据待补**不**阻塞平台文件（否则 agent run 会因缺 `~/.erix/config.json` 而 ENOENT 崩溃）；**`disabled`（offboarding 后）不物化**。凭据到达把状态翻回 `active` 时，portal 会在**同一事务**内补入队一次物化 revision（幂等，head/latest-wins）。

### 8.2 幂等规则

1. **纯函数**：文件内容 = `f(DB 快照)`，DB 快照相同 → 字节级相同（§5.5）。
2. **内容不变不重写**：materializer 先比对「目标文件当前 sha256 vs 待写内容 sha256」，相同则**跳过写**（不 rename、不 bump 文件 revision）。
3. **generation 只在内容实际变化时递增**：全量重物化若所有文件内容都没变 → `manifest.json` 也不重写、generation 不变 → FDE 侧无谓的「变化」信号为零。
4. **原子替换天然幂等**：即使重复 rename 同一内容，结果也是同一字节流，无累积副作用。
5. **失败保留上一版**：任何失败都不删既有文件（§7.1），重试从头执行同一纯函数，最终收敛到同一结果。

---

## 9. 项目目录归属

### 9.1 项目目录不存在时谁创建

- **portal（materializer）创建空目录 + 平台文件**，**agent 代劳 clone 仓库内容**；FDE 先经 portal 投放 Git HTTPS 凭据（#110，§4.1.1），两者分工不重叠。
- 时序（建项目，`POST /api/projects`）：
  1. DB 事务写 `projects` + `port_allocations` + route outbox（portal.md §3.3）。
  2. `sessions.js` `createSession` 在宿主创建 `projects/<project>/`（`chown 1000:1000`、`chmod 0o2770`；**单次调用 ⇒ 实测落 `2770`**，同项目再建一个 session 才会被清成 `0770`，见 §6.2 表「混的」那行）。⚠ 早先这里写的是「materializer 创建并写 `.gitignore` / `.erix/ports.json` / `.erix/AGENTS.md`」——**P5 已整体退役**（`materializer.js` `buildFilePlan` 注释明写），materializer 只产 `home/AGENTS.md` 与 `home/.erix/{config,mcp,ports}.json`，不建项目目录。
  3. FDE 经 portal 投放 Git HTTPS 凭据（#110；#399 后写入平台独占的 `platform/git/credentials`，ro bind 进容器 `/run/erix/git`；FDE 自配凭据仍写 `home/.git-credentials`），由 agent 在项目目录代劳 clone。平台不下发 SSH key（SSH 私钥强制 `0600` 与组可读 `0640` 冲突）。

### 9.2 用户 clone 覆盖平台文件怎么办

平台把**会与 clone 冲突的文件全部收进 `.erix/`（gitignored）**，使 clone/checkout 天然不碰它们：

| 平台文件 | 是否会与 clone 冲突 | 处置 |
|---|---|---|
| `.erix/ports.json`、`.erix/AGENTS.md` | **否**——在 `.gitignore` 里，git 永不 track/checkout 它们 | 无需处置 |
| `.gitignore`（项目根） | 会：仓库自带 `.gitignore` 时冲突 | 见下 |
| 项目根 `AGENTS.md` | **会**：仓库通常自带 `AGENTS.md` | **平台不写项目根 `AGENTS.md`**——项目级约定放 `.erix/AGENTS.md`（§2.3） |

- **`.gitignore` 冲突策略**：平台写的是**最小** `.gitignore`（只含 `.erix/`）。若仓库自带 `.gitignore` 在 clone/checkout 时覆盖平台版 → 平台在**下次对账**检测到 `.erix/` 未 ignore，则**把 `.erix/` 行追加/合并**回去（读仓库 `.gitignore` 现有行 + 确保 `.erix/` 在其中，原子重写）。这是唯一一处「平台会合并回写仓库文件」的例外，因为它直接关系到平台文件不被 git 干扰。
- **clone 方式指引**（写进 `.erix/AGENTS.md` 与 `~/AGENTS.md`）：因目录非空（含 `.erix/`、`.gitignore`），FDE 用 `git init + remote add + fetch + checkout` 或 `clone 到临时目录再搬移`；两种方式都不会触碰 `.erix/`。

### 9.3 用户手改平台文件会怎样

| 文件 | 手改后果 | 平台行为 |
|---|---|---|
| `ports.json` | agent 读到被改的端口视图 | **对账重物化覆盖**（DB 是真相）；同时写 `audit_log`（`materialize.drift`）+ 告警（P2 通知通道，状态 P1 可查） |
| `config.json` | 手改 endpoint/model/key | **对账重物化覆盖**为平台值；但真正防「改 endpoint」靠网络（`llm.<base>` 唯一可达，Traefik 注入真 key），文件被改**无害**（占位 key 无价值） |
| `manifest.json`（0444） | 改哈希/删文件可破坏一致性校验 | 读方校验失败 → 重读 → 仍失败则告警 + 暂停领新 run（§5.4）；对账重物化恢复 |
| `.erix/AGENTS.md`、`~/AGENTS.md`、`.gitignore` | 改约定（`~/AGENTS.md` 还携带平台约束的单一真相，§4.1.2） | 对账重物化覆盖为平台模板值 |
| `skills/`、`todos/`、`cache/`、`projects/<p>` 仓库内容、`worktrees/` | **FDE 合法自管内容，平台不碰** | 永不覆盖、永不告警 |

> 统一口径：**平台文件（§4.1 表）一旦漂移，一律「DB 派生值覆盖 + 审计 + 告警」，绝不向 FDE 的改动妥协**；FDE 自管内容（§4.2 表）平台永不干预。这正是「DB 是真相、文件是派生视图」在写边界上的体现（principles §1 原理三）。

---

## 10. 与 `port_allocations` / `route_outbox` 的一致性

**结论：文件 revision 与路由 revision 不需要同一 generation，但必须同源、同轮收敛、都可幂等重建。**

| 维度 | 路由（Traefik file provider） | 用户空间文件（`ports.json` 等） |
|---|---|---|
| 真相源 | `port_allocations`（DB） | 同左 |
| 发布机制 | `route_outbox` + `route_revisions` + reconciler → Traefik 动态配置 | `materialize_outbox` + `materialize_revisions` + materializer（§7.1）→ bind mount |
| 消费者 | Traefik（host 网络） | FDE 容器内 agentd/worker |
| 原子性域 | 单份 Traefik 动态配置（tmp + 校验 + `mv`，topology §8） | 单 FDE 的 `manifest.json`（generation） |
| revision | `route_revisions.(aggregate,aggregate_id).revision` | `materialize_revisions.fde_id.revision`（outbox 版本 head）；文件侧另记 `generation` / per-file `revision`（§5.3） |

**为什么不共享一个 generation**：
1. 两者**消费者不同、可达性判定不同**：路由可用性由 forward-auth 查 DB hostname（portal.md §2.7），文件视图由 agent 查 `ports.json`——互相独立，没有「必须同刻生效」的正确性要求。
2. 两者的**原子性域不同**：Traefik 配置是「全平台一份文件」，用户空间是「每 FDE 一份 manifest」——把两者硬塞进同一代只会让一次端口变更牵动全平台 manifest，放大失败面。
3. **正确性由「同源 + 最终一致 + 定时对账」保证**：两者都从同一 DB 快照派生，都在同一轮 reconciler 收敛里发布；短暂偏斜（路由先于/后于文件生效）只造成「预览 URL 暂不可达」或「端口暂不可见」，不造成错误分配/越权（§7.2），对账兜底收敛。

**落地要求**：
- 一次 DB 事务（如建项目）同时写 `port_allocations` + `route_outbox` + `materialize_outbox` 行 + 递增 `materialize_revisions.revision`（§7.1），**保证同源、同起点**。
- materializer 与 route reconciler 在**同一对账轮**内消费各自的 outbox，先后顺序不强制（各自幂等）。
- 定时对账做「DB ↔ 路由文件 ↔ 用户空间文件」三向比对（topology §8 四向对账的子集），漂移即修。

---

## 11. 安全边界与残余风险

| 项 | 结论 |
|---|---|
| 文件权限是安全边界吗 | **不是**（principles §1 原理四）。只防误改；真正边界是网络（每 FDE 独立 `/29`、不 publish、ingress 唯一、LLM 唯一出口）。 |
| 平台文件泄漏什么 | 物化平台文件无真实密钥：占位 key 无价值、endpoint 是内网 `llm.<base>`、`ports.json` 是 FDE 自己的端口。`.git-credentials` 是 FDE 单独授权的 Git 主机凭据文件；**真实 LLM key / DB 凭据 / runner token 永不进入用户空间文件**。宿主侧有权访问该用户空间的进程可读取 Git token 明文，这是接受的残余风险。 |
| FDE 能否破坏自己 | 能（有 root）——**接受**（runner §11.3 同口径）；只保证「他人/平台状态不被单个 FDE 破坏」。 |
| 跨 FDE 隔离 | bind mount 每 FDE 只挂自己的 `/srv/erix/users/<fde>/`；materializer 只按 DB `fde_id` 写对应目录；名字白名单 + 无 `..`（§6.3）防越目录。 |
| 单 FDE 写入路径 | materializer 不读回用户空间内容做决策（§6.3-4），杜绝「FDE 篡改文件反灌平台」。 |

---

## 12. ⚠️ 待决策者确认清单（本文全部标注）

| # | 事项 | 当前倾向 | 影响 |
|---|---|---|---|
| 1 | 容器内用户名固定 `erix` 还是按 FDE 名 | 固定 `erix`（§2.4） | 镜像模板 / HOME 路径 |
| 2 | materializer outbox 复用 `route_outbox` 还是新增表 | ✅ 已定：新增 `materialize_outbox` + `materialize_revisions`（A7，已落 schema.sql §9 / model.md §1.22） | schema.sql / model.md（已落地，§13 S1） |
| 3 | `config.json` 字段名与 erix-agent `config/*` 对齐 | 以 erix-agent 为准，平台只保证「占位 key + endpoint + 三 slot」语义 | 上游契约对齐（§13） |
| 4 | 定时对账周期 | 5min | 漂移收敛时延 |

---

## 13. 跨文件同步点（本轮不改，转派）

> 注：S1（materialize outbox/revision 表）已在后续轮次落地到 schema.sql / model.md（A7）。其余同步点仍待转派到对应文档。

| # | 目标文档 | 需同步点 | 本文对应 |
|---|---|---|---|
| S1 | `data/schema.sql` + `data/model.md` | ✅ 已落地：新增 `materialize_outbox` + `materialize_revisions`（A7，见 schema.sql §9 / model.md §1.22） | §7.1 / §10 / §12-2 |
| S2 | `data/model.md` §1.9 / §2.2 | ✅ 已同步（`allocated→active` 定稿 + `generation` 字段已落 model.md） | §4.3.1 |
| S3 | `design/runner-integration.md` §7.5 | spool 路径 `~/.cache/station/spool/` 与本文 §4.2 已对齐（无冲突，确认即可）；§5 `run_start` 载荷若需携带「本 run 端口快照」则补字段（P2 run 级端口） | §3 / §4.3.1 |
| S4 | `design/runner-integration.md` §6.3 | worker 读 `config.json` 前先经 manifest 校验（本文 §5.4 硬规则） | ✅ 已同步（runner §6.3-1 已补 manifest 校验步骤） |
| S5 | `api/portal.md` §3.3 | `POST /api/projects` 响应/语义补「项目目录与平台文件由 materializer 物化」的说明 | ⚠️ 未落地（portal.md §3.3 尚无此说明，待补） |
| S6 | `docs/README.md` 待补齐清单 | 新增 D 项或记录本文为「用户空间物化契约」已交付 | 本文件 |

---

## 14. 与既有文档的关系

| 主题 | 位置 |
|---|---|
| 主规格（端口分配、onboarding、容器模板） | [`fde-platform.md`](fde-platform.md) §7.2 / §8 / §12 |
| 网络与文件投递 D-6 | [`topology.md`](topology.md) §1 / §6.2 |
| 原理（DB 是真相、文件权限非边界） | [`principles.md`](principles.md) §1 原理三/四 |
| 容器内进程/UID/凭据 | [`runner-integration.md`](runner-integration.md) §2/§3/§11 |
| 部署参数（路径/UID） | [`../env.md`](../env.md) §6 |
| 数据模型（`port_allocations` / `route_outbox` / `materialize_outbox`） | [`../data/model.md`](../data/model.md) §1.9/§1.18/§1.22 |
