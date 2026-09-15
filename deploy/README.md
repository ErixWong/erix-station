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
- 本轮只有三个容器；`station-docker-socket-proxy` / FDE 容器 / LLM 网关 / materializer / 路由 reconciler 归后续轮次。
