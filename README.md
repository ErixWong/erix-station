# FDE Station（`erix-station`）

> 给 FDE（Forward Deployed Engineer）的**开发工位平台**：每个 FDE 一台容器小电脑，里面跑 erix agent；一个统一入口（ingress）把对话界面、项目端口预览、IDE 全都收在同一个门户下。

**定位一句话**：`erix-agent` 是引擎（无头 agent 运行时），`erix-station` 是宿主平台（谁在用、在哪台机器上跑、怎么访问、花了多少钱）。

- 状态：**P1 实现中**（设计定稿，portal/runner/deploy 已落地，`npm test` 168 pass）
- **入口文档**：[`docs/README.md`](docs/README.md) —— 文档地图 + 待补齐清单（实现者从这里开始）
- 主规格：[`docs/design/fde-platform.md`](docs/design/fde-platform.md)
- 设计原理与取舍：[`docs/design/principles.md`](docs/design/principles.md)
- 上游引擎：[erix-agent](https://github.com/ErixWong/erix-agent)

## 现在有什么

| 目录 | 内容 |
|---|---|
| `docs/` | 文档地图（`docs/README.md`）：现有文档 + 待补齐清单与验收标准 |
| `docs/design/` | 主规格（拓扑 / 网络 / 授权 / 端口 / 数据模型 / 分期）+ 设计原理与被否决方案 |
| `deploy/` | Traefik + portal + DB 的 compose、FDE 容器模板、迁移脚本 |
| `portal/` | 管理平台服务（internal API + 用户面 API + mock LLM 网关）；用户面前端为 Vue 3 SPA（`portal/frontend/`，issue #61：Vite + TS + vue-router + pinia + Tailwind v4，`/` 服务构建产物） |
| `runner/` | 容器内 agent worker（agentd + worker，接 erix-agent `runToolLoop`） |

## 三条不变式（红线）

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥。
2. **ingress 是唯一的路**：所有外部访问都经过 Traefik，认证在边缘做，应用自身不感知。
3. **DB 是状态的真相**：会话、transcript、端口分配、用量都在中心 DB；容器可随时重建。

## 相关约定

- 本项目特有规则见 [`AGENTS.md`](AGENTS.md)
- 开发机共享约定见 `~/projects/AGENTS.md`（全局）
