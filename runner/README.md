# runner/ — 容器内 agent worker（WP3b 已实现）

FDE 容器内两个进程（依据 `docs/design/runner-integration.md`）：

- **`station-agentd`**（`agentd.js`）：常驻守护/桥接。唯一持 per-container token（env `ERIX_STATION_TOKEN`，仅本进程内存）；全出站（SSE 下行 + POST 上行 → portal internal API）；心跳续租、claim 长轮询领任务、准备工作目录、fork worker 子进程、事件批量上报、store_request 转发、终态 barrier。
- **`station-runner` worker**（`worker.js`）：每 run 一个子进程（UID 1002）。接 erix-agent `runToolLoop`；store adapter 走 HTTP 版（经 IPC → agentd → internal 端点）；事件经 IPC 回 agentd 批量上报；无任何平台凭据。

进程模型：`docker run --init`（tini 作 PID 1）→ entrypoint（root）`setpriv` drop 到 `erix-agentd`(1001) 并保留 SETUID/SETGID/KILL → exec `agentd.js`（PID 2）→ fork worker 切 UID 1002（`erix-worker`）。

## 构建

```bash
docker build -t erix-station/fde:local runner/
```

镜像契约见 [`docs/design/deploy-contract.md`](../docs/design/deploy-contract.md) §1/§6：三用户 1000/1001/1002 同 GID 1000、`node:22-slim`、非 root 运行路径、root→drop 1001、erix-agent v0.14.0（npm）。

## 环境变量（容器内，deploy-contract §6.2）

| 变量 | 说明 |
|---|---|
| `ERIX_STATION_TOKEN` | per-container token（**仅 agentd 持有**，worker fork 时从 env 剔除） |
| `ERIX_STATION_BASE_URL` | internal API base URL（如 `https://station.<base>/api/internal`） |
| `ERIX_FDE_NAME` | FDE 标识（审计/日志） |
| `FDE_CONTAINER_USER` / `FDE_HOME` | 容器用户 `erix` / `/home/erix` |
| `FDE_WORKER_UID` / `FDE_WORKER_GID` | worker UID/GID（1002/1000） |
| `ERIX_RUN_DATA_TTL_HOURS` | 未归档的异常残留清扫阈值（小时），默认 `24`；`0` 禁用 |
| `ERIX_ARCHIVE_TTL_HOURS` | 终态 run 归档保留阈值（小时），默认 `168`（7 天）；`0` 禁用 |

## 范围与偏差

- **erix-agent 0.14.0 store 契约**：`appendRound` / `load` 是仅有的必需方法；配对的 `saveRunSnapshot` / `loadLatestRunSnapshot`、`saveRunState` / `loadRunState`、`markRunState` 是可选能力。Station 通过 `transcriptStoreContract` 验证 adapter；`loadRunStateStatus` 是宿主扩展，不是引擎必需方法。
- **run state 分路**：`saveRunState` 写快照但剔除顶层 `state`；`markRunState` 写独立状态列。新状态字段由迁移 `0014-run-state-status.sql` 提供，legacy 快照中的 `state` 仍可读。
- **notes 生命周期与保留**：0.14.0 notes 仅有 `run` scope，`scopeRef` 是逻辑 `runId`；agentd 下发的 `notesDir` 固定为 `<FDE_HOME>/runs/<runId>/notes`，所以跨 attempt/resume 保留，终态确认后随整个 run 目录移入 `runs-archive/<runId>/`。可验证的文件路径为 `<FDE_HOME>/runs-archive/<runId>/notes/run/<runId>/<key>.json`。`onRunComplete()` 只将 active notes 标为 done；没有 `onRunStart`，Station 不调用 `store.purge()`。归档 sweep 删除整个目录树（含 notes、tombstone 和空 scope 目录），因此单独 purge 不会增加清理覆盖面。
- **保留策略与 ADR-018 D7 的差异**：终态 run 的 notes 保留阈值采用 `ERIX_ARCHIVE_TTL_HOURS`（默认 168h）；归档时刷新目录 mtime，agentd 启动时若归档目录 mtime 超阈值才物理清理，因此实际删除发生在阈值之后的下一次启动，并非定时器准点删除。上游 D7 的 session clock 以 transcript mtime/调度器状态判断 session 是否仍活跃；Station 没有 session-scope notes，run 是 notes 的唯一 scope，故不以 session transcript mtime 延长或缩短单个 run 的寿命。要延长保留，增大 `ERIX_ARCHIVE_TTL_HOURS`；设为 `0` 可禁用归档清扫、无限期保留。
- **异常退出与 active orphan**：未确认终态的 `runs/<runId>/` 不归档，resume 会复用其 notes；活跃 worker 存续期间 agentd 每次心跳刷新 run 目录顶层 mtime，避免深层 notes 写入不更新父目录导致旧目录被误清。agentd 启动 sweep 按该 mtime 与 `ERIX_RUN_DATA_TTL_HOURS`（默认 24h，自最近心跳起算）清理残留，`0` 禁用。这覆盖 Station 文件层的最终孤儿回收，但只是整个 run-scope 文件树的粗粒度物理清理，不是上游 list/revoke 三行循环，也不写 revoked tombstone；清扫仅在启动时运行，过期残留会保留到下一次启动。终态归档为 best-effort；归档失败会留在 `runs/` 并记录 warn，后续由该残留 sweep 兜底。正常完成仍由 `onRunComplete()` 收敛 active notes。
- **兼容路径例外**：当前 agentd 总会下发上述 `notesDir`；但 worker 收不到 `notes_dir` 时仍兼容回退到 `<cwd>/.notes`（旧 agentd 路径）。该目录不在 `runs/` 或 `runs-archive/` 下，不受这两种 sweep 管理；历史遗留的 cwd-local `.notes` 也不会自动迁移或清理，不能视为符合当前保留策略。
- **P1 单实例**：`capacity=1`（单容器串行，runner §13）；多 run 并发 P2。
- **approvals 不实现**（路径留空，P2 接入，runner §10）。
- **spool 不落盘**（runner §7.5 待定项）；事件投递为内存缓冲 + 无限退避重试（§7.2/§4.5）。
- **历史兼容记录（v0.3.5）**：`createJsonFileModelConfigProvider` 读取 `slots.{default,audit,fold}` 嵌套结构且字段为 `endpoint`（非 `baseURL`）——materializer 已按当时实测修正 config.json（见 WP3b 报告偏差记录）。
- **项目目录（D8 修订 2026-09-24，AGENTS.md §7）**：worker cwd 直达 `~/projects/<project>`，agentd 只确保目录存在（mkdir -p），不再 `git worktree add`；项目目录是用户资产，清场绝不删除。
