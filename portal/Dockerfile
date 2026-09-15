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

# 源码 + 迁移脚本（schema/bootstrap）
COPY portal/ portal/
COPY docs/data/ docs/data/

# materializer 以 root 写平台文件（root:root 0644/0444）、chown 工作区目录（1000:1000）。
USER root

EXPOSE 8080

CMD ["node", "portal/src/cli.js", "serve"]
