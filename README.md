# FDE Station（`erix-station`）

FDE Station 是面向 FDE（Forward Deployed Engineer）的开发工位平台（host platform）。
平台为每名 FDE 提供一台隔离容器作为独立工作环境，容器内运行 erix-agent；
会话界面、端口预览与管理入口统一经平台边缘（Traefik）对外提供。

**职责边界**：`erix-agent` 是执行引擎（headless agent runtime）；
`erix-station` 是宿主平台，负责身份与工位编排、运行调度、访问控制、状态持久化与用量计量。

## 项目状态

- 发布版本以 `package.json` 的 `version` 为准（当前 `0.1.79`）；
  容器镜像由 GitHub Actions 构建并发布至 GHCR（`.github/workflows/release.yml`）。
- 能力现状见 **GitHub issue / PR**（本仓唯一真相源）；设计分期见 [`docs/design/fde-platform.md`](docs/design/fde-platform.md) §15。
- 测试基线见 [`docs/ops/ci-release.md`](docs/ops/ci-release.md)。
  用例数量随开发漂移，验收只认退出码与失败数，不以条数为依据。

## 仓库结构

| 目录 | 内容 |
|---|---|
| `docs/` | 文档地图（[`docs/README.md`](docs/README.md)）：设计规格、API/数据契约、运维手册 |
| `portal/` | 管理平台服务：用户面 API、内部 API、LLM 网关薄代理；`portal/frontend/` 为 Vue 3 SPA |
| `runner/` | 容器内 agent worker（agentd + worker），基于 erix-agent `runToolLoop` 执行任务 |
| `deploy/` | Compose 编排、Traefik 静态/动态配置、FDE 容器模板与数据库迁移 |
| `db-init/` | 数据库与 LiteLLM 的初始化脚本 |
| `scripts/` | 文档与配置一致性闸（热层预算、文档可公开性、文档↔实现比对等） |
| `test/` | 仓库级测试（文档闸、部署面默认值、仓库卫生等） |

## 三条不变式

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂载 `docker.sock`、不持有平台密钥。
2. **ingress 是唯一入口**：所有外部访问均经 Traefik，认证在边缘完成，应用自身不感知。
3. **DB 是状态的真相**：会话、transcript、端口分配与用量均落中心数据库；
   容器可随时重建，重建后状态由数据库与卷恢复。

## 架构要点

- **入口**：Traefik 单入口 + 泛域名，用户面与管理台分属不同 host 与入口。
- **portal**：Node.js（>= 22，零框架 `node:http`）+ PostgreSQL；
  提供用户面 API、内部 API 与 LLM 网关薄代理。
- **前端**：Vue 3 + TypeScript + Vite + Pinia，构建产物由 portal 托管。
- **runner**：容器内 agentd 与 worker，通过 erix-agent 的 `runToolLoop` 执行任务，
  经内部 API 与 portal 交换租约、心跳与事件。
- **LLM**：统一经自托管 LiteLLM 网关出网；模型目录与上游凭据以 LiteLLM 数据库为准。
- **部署**：Docker Compose + Traefik；平台与工位容器按契约固定网络与挂载面。

## 开发与验证

| 命令 | 用途 |
|---|---|
| `node --check <file>` | 语法检查（无需安装依赖） |
| `npm test` | 根目录单测（`node --test`，含 runner 与文档闸） |
| `cd runner && node --test` | runner 单测 |
| `cd portal/frontend && npm run typecheck && npm test` | 前端类型检查与单测 |
| `docker compose -f deploy/docker-compose.yml up -d` | 本地启动平台栈（LLM 网关需 `--profile litellm`） |

测试分层、隔离约定与验收口径见 [`docs/testing.md`](docs/testing.md)。

## 相关文档

- 文档地图（实现者入口）：[`docs/README.md`](docs/README.md)
- 主规格：[`docs/design/fde-platform.md`](docs/design/fde-platform.md)
- 设计原理与被否决方案：[`docs/design/principles.md`](docs/design/principles.md)
- 部署契约：[`docs/design/deploy-contract.md`](docs/design/deploy-contract.md)
- 部署参数清单：[`docs/env.md`](docs/env.md)
- 项目开发规则：[`AGENTS.md`](AGENTS.md)
- 上游引擎：[erix-agent](https://github.com/ErixWong/erix-agent)
