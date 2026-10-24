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

# ---- 运行时依赖：git（issue #359 收工灯）----
# 为什么 portal 自己也要 git：`GET /api/git-light`（`portal/src/gitlight.js`）要跑一条
#   `git status --porcelain -uall` 判「未提交 + 未跟踪」。未推送 / 0 提交那两路是纯文本读 `.git`，
#   不依赖 git 二进制；**但缺 git 时灯永远只能报 `grey / git_unavailable`** —— 一颗恒灰的灯比没有灯更槽
#   （绿是承诺、灰是无信息，用户会直接把它当“坏了”而不再看）。
# 只要 read-only 能力：不装 openssh-client / 不配凭据 —— portal 零 git 写（D9：init/commit/push/clone
#   全走「让 AI 收尾」），也不跑 fetch，所以不碰网络也不碰凭据。
# 层序照 runner/Dockerfile：重且稳定的 apt 层在前、易变代码在后（改 portal 代码不触发重装）；
#   `--no-install-recommends` + 同层 `rm -rf /var/lib/apt/lists/*`（评审 F6 先例：异层清理等于没清）。
# 本层内容被 `portal/test/portal-image-git.test.js` 以文本锁钉住。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖清单先行，利于层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码 + 迁移脚本（schema/bootstrap + 增量迁移）
COPY portal/ portal/
# 前端构建产物：只注入 dist（staticDir/app/；serveStatic 把 / 与 /assets/* 映射到该注入目录，
# 见 http.js issue #61 P2 注释）。前端 node_modules 不进 runtime 镜像
#（.dockerignore 排除 + 本 COPY 仅 --from builder 的 dist）。
COPY --from=frontend-builder /build/portal/frontend/dist/ portal/static/app/
COPY docs/data/ docs/data/
# 增量迁移（deploy/migrations/*.sql）：migrate runner 的 defaultMigrationsDir() = /app/deploy/migrations，
# 由 `cli.js migrate` 或 MIGRATE_ON_START=1 以 station_platform 应用到 head（deploy-contract §3.1/§3.3）。
COPY deploy/migrations/ deploy/migrations/

# materializer 以 root 写平台文件（root:root 0644/0444）、chown 工作区目录（1000:1000）。
USER root

EXPOSE 8080

CMD ["node", "portal/src/cli.js", "serve"]
