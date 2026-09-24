# runner/ — 容器内 agent worker（WP3b 已实现）

FDE 容器内两个进程（依据 `docs/design/runner-integration.md`）：

- **`station-agentd`**（`agentd.js`）：常驻守护/桥接。唯一持 per-container token（env `ERIX_STATION_TOKEN`，仅本进程内存）；全出站（SSE 下行 + POST 上行 → portal internal API）；心跳续租、claim 长轮询领任务、准备工作目录、fork worker 子进程、事件批量上报、store_request 转发、终态 barrier。
- **`station-runner` worker**（`worker.js`）：每 run 一个子进程（UID 1002）。接 erix-agent `runToolLoop`；store adapter 走 HTTP 版（经 IPC → agentd → internal 端点）；事件经 IPC 回 agentd 批量上报；无任何平台凭据。

进程模型：`docker run --init`（tini 作 PID 1）→ entrypoint（root）`setpriv` drop 到 `erix-agentd`(1001) 并保留 SETUID/SETGID/KILL → exec `agentd.js`（PID 2）→ fork worker 切 UID 1002（`erix-worker`）。

## 构建

```bash
docker build -t erix-station/fde:local runner/
```

镜像契约见 [`docs/design/deploy-contract.md`](../docs/design/deploy-contract.md) §1/§6：三用户 1000/1001/1002 同 GID 1000、`node:22-slim`、非 root 运行路径、root→drop 1001、erix-agent v0.3.5（npm）。

## 环境变量（容器内，deploy-contract §6.2）

| 变量 | 说明 |
|---|---|
| `ERIX_STATION_TOKEN` | per-container token（**仅 agentd 持有**，worker fork 时从 env 剔除） |
| `ERIX_STATION_BASE_URL` | internal API base URL（如 `https://station.<base>/api/internal`） |
| `ERIX_FDE_NAME` | FDE 标识（审计/日志） |
| `FDE_CONTAINER_USER` / `FDE_HOME` | 容器用户 `erix` / `/home/erix` |
| `FDE_WORKER_UID` / `FDE_WORKER_GID` | worker UID/GID（1002/1000） |

## 范围与偏差

- **P1 单实例**：`capacity=1`（单容器串行，runner §13）；多 run 并发 P2。
- **approvals 不实现**（路径留空，P2 接入，runner §10）。
- **spool 不落盘**（runner §7.5 待定项）；事件投递为内存缓冲 + 无限退避重试（§7.2/§4.5）。
- **erix-agent v0.3.5 实测差异**：`createJsonFileModelConfigProvider` 读 `slots.{default,audit,fold}` 嵌套结构且字段为 `endpoint`（非 `baseURL`）——materializer 已按实测修正 config.json（见 WP3b 报告偏差记录）。
- **项目目录（D8 修订 2026-09-24，AGENTS.md §7）**：worker cwd 直达 `~/projects/<project>`，agentd 只确保目录存在（mkdir -p），不再 `git worktree add`；项目目录是用户资产，清场绝不删除。
