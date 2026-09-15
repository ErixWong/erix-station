# runner/ — 容器内 agent worker

> 本轮（P1 walking skeleton 第一步）**未实现**，仅占位。

下一轮（WP2+）在此实现：

- `station-agentd`：容器内唯一 HTTP 客户端 / 唯一持 per-container token，聚合 worker 事件上报（runner-integration §4）。
- `station-runner` / worker：接 erix-agent 公开 API（`runToolLoop` / `TranscriptStore`），跑 run。
- 进程模型、UID（erix/agentd/worker）、事件批量、spool、租约/fencing 等，依据见
  [`docs/design/runner-integration.md`](../docs/design/runner-integration.md)。

本轮不建 FDE 容器、不做 materializer / 路由 reconciler / internal API。
