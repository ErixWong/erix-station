# deploy/ — 本地开发栈

P1 walking skeleton 的本地开发栈：`station-db`（Postgres）+ `station-portal`（自构建 Node 服务）+ `station-edge`（Traefik，host 网络）。

> 依据：[`docs/design/deploy-contract.md`](../docs/design/deploy-contract.md) §2、[`docs/env.md`](../docs/env.md) §0（开发期参数）。
> docker 命令在本机需 `sg docker -c '...'` 绕过（交互 shell 无 docker 组，见 env §8.1）。

## 端口与本机避让（env §0）

| 用途 | 开发期端口 |
|---|---|
| Traefik `web` | `127.0.0.1:8090` |
| Traefik `websecure` | `127.0.0.1:8443` |
| portal（宿主回环发布，容器内固定 8080） | `127.0.0.1:18080` |
| `backend` 子网 | `172.32.0.0/24`（本机 172.30.0.0/16 被 voiceprint 占用） |

本机 8080/443/5432 已被占用，故按 env §0 用上述开发期端口；换机器先 `ss -tlnp` 自查。

## 启动

```bash
# 1) 生成本地 .env（不入库）
cp deploy/.env.example deploy/.env
# 2) 起栈（构建 portal 镜像 + 拉起三容器）
sg docker -c 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml up -d --build'
# 2a) （可选，Office/压缩包预览）先自建 kkFileView 镜像再带 profile 起（#366，见「说明」节）
#   deploy/kkfileview/build-image.sh
#   sg docker -c 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml --profile kkfileview up -d'
# 3) 观察状态
sg docker -c 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml ps'
```

就绪后：

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18080/healthz   # 期望 200
```

## 建本地 admin（bootstrap）

```bash
# 容器内执行（自动先跑迁移）
sg docker -c 'docker exec -i station-portal node portal/src/cli.js bootstrap-admin --login admin --password <临时口令>'
```

## 停止 / 重置

```bash
# 停止（保留数据卷）
sg docker -c 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml down'
# 重置（删除数据卷 /docker/station-db/ 内容，慎重）
sg docker -c 'docker compose --env-file deploy/.env -f deploy/docker-compose.yml down -v'
```

## 说明

- 开发期 `COOKIE_PROFILE=dev-http` → cookie 名 `fde_session_dev`、无 `Secure`（仅本机 HTTP 联调；部署配置必须 `prod`）。
- 默认开发栈包含 edge/portal/db 与 `station-docker-proxy`；`station-litellm` 需显式启用 profile（`--profile litellm`）。
- **LiteLLM 是唯一 LLM 网关**（LLM 路由只发单一 `llm-gateway` service，上游 = `station-litellm`）；集成 e2e 通过管理台 API 创建 LiteLLM mock model 并验证白名单。新建 DB 数据目录时 `01-litellm.sh` 按 `deploy/.env` 的 `LITELLM_DB_PASSWORD` 创建专用角色和数据库。启动及模型管理见 [`litellm/README.md`](litellm/README.md) 与项目 `AGENTS.md` §4.2。
- **kkFileView（#366，Office/压缩包预览引擎）：镜像自建，官方 Hub 镜像停在 4.1.0**——`file://` 本地协议（ro 挂载 userspace 直接读文件，整个预览设计的前提）是 5.x 才有的能力，而上游 5.0.x 没发过 Docker 镜像（其 Dockerfile 的基座 `keking/kkfileview-base:5.0.0` Hub 上 404）。构建：`deploy/kkfileview/build-image.sh`（maven 打包 5.0.3 + ubuntu noble 基座，产物 `erix-station/kkfileview:5.0.3`），compose 用 `KKFILEVIEW_IMAGE` 注入（生产按 digest 钉）。要点：服务不发布宿主端口（只能经 portal `/pv/<code>` 网关进）；userspace **ro** 挂到与 portal 同路径（两侧路径字符串必须一致，`KK_LOCAL_PREVIEW_DIR` 比对的是 canonical 前缀）；`KK_TRUST_HOST=station-preview.internal` 必须与 portal `previewproxy.KK_TRUST_HOST` 同值（能力码 URL 的命名 authority，改一侧=全量 403）；运行 uid/gid 1000:1000（userspace 属主 `drwxrwx---`，无特权容器里 root 拿不到 1000 组，只有同 uid/gid 能直读）。真机 E2E 已验（docx→LibreOffice→pdf 产物经闸门 200）。契约见 `docs/api/portal.md` §4.11。
