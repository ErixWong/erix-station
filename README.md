# FDE Station（`erix-station`）

> 给 FDE（Forward Deployed Engineer）的**开发工位平台**：每个 FDE 一台容器小电脑，里面跑 erix agent；一个统一入口（ingress）把对话界面、项目端口预览、IDE 全都收在同一个门户下。

**定位一句话**：`erix-agent` 是引擎（无头 agent 运行时），`erix-station` 是宿主平台（谁在用、在哪台机器上跑、怎么访问、花了多少钱）。

- 状态：**设计阶段**（无业务代码）
- 主设计文档：[`docs/design/fde-platform.md`](docs/design/fde-platform.md)
- 上游引擎：[erix-agent](https://github.com/ErixWong/erix-agent)

## 现在有什么

| 目录 | 内容 |
|---|---|
| `docs/design/` | 主设计文档（拓扑 / 网络 / 授权 / 端口 / 数据模型 / 分期） |
| `deploy/` | 待建：Traefik + portal + DB 的 compose，FDE 容器模板 |
| `portal/` | 待建：管理平台服务 |
| `runner/` | 待建：容器内 agent worker |

## 三条不变式（红线）

1. **容器是信任边界**：FDE 容器不 publish 端口、不挂 `docker.sock`、不持有平台密钥。
2. **ingress 是唯一的路**：所有外部访问都经过 Traefik，认证在边缘做，应用自身不感知。
3. **DB 是状态的真相**：会话、transcript、端口分配、用量都在中心 DB；容器可随时重建。

## 相关约定

- 本项目特有规则见 [`AGENTS.md`](AGENTS.md)
- 开发机共享约定见 `~/projects/AGENTS.md`（全局）
