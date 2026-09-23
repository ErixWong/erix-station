# ---- issue #61 P1：前端构建阶段（Vue 3 + Vite + TS，portal/frontend）----
# devDependencies 含 vite/tailwind/vitest，故本阶段不得设 NODE_ENV=production（npm ci 会跳过 devDeps）。
FROM node:22-slim AS frontend-builder
WORKDIR /build/portal/frontend
# 依赖清单先行，利于层缓存（package-lock.json 入库，npm ci 可复现）
COPY portal/frontend/package.json portal/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portal/frontend/ ./
RUN npm run build

# portal 镜像：node:22-slim。
# WP2a 起 materializer 需 chown 工作区目录 + 写 Traefik 动态配置（600）+ 经 socket-proxy 调 Docker API，
# 故运行身份切回 root（deploy-contract.md §1 注：PORTAL_RUNTIME_UID=0）。
# 容器加固（cap_drop: ALL + cap_add 最小集）在 deploy/docker-compose.yml 侧声明，见 §2.2。
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# 依赖清单先行，利于层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码 + 迁移脚本（schema/bootstrap + 增量迁移）
COPY portal/ portal/
# 前端构建产物：只注入 dist（staticDir/app/，由 serveStatic 以 /app 前缀服务，见 http.js 注释）。
# 前端 node_modules 不进 runtime 镜像（.dockerignore 排除 + 本 COPY 仅 --from builder 的 dist）。
COPY --from=frontend-builder /build/portal/frontend/dist/ portal/static/app/
COPY docs/data/ docs/data/
# 增量迁移（deploy/migrations/*.sql）：migrate runner 的 defaultMigrationsDir() = /app/deploy/migrations，
# 由 `cli.js migrate` 或 MIGRATE_ON_START=1 以 station_platform 应用到 head（deploy-contract §3.1/§3.3）。
COPY deploy/migrations/ deploy/migrations/

# materializer 以 root 写平台文件（root:root 0644/0444）、chown 工作区目录（1000:1000）。
USER root

EXPOSE 8080

CMD ["node", "portal/src/cli.js", "serve"]
