# portal 镜像：node:22-slim，非 root node 用户运行（deploy-contract.md §1/§2）。
FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

# 依赖清单先行，利于层缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码 + 迁移脚本（schema/bootstrap）
COPY --chown=node:node portal/ portal/
COPY --chown=node:node docs/data/ docs/data/

USER node

EXPOSE 8080

CMD ["node", "portal/src/cli.js", "serve"]
