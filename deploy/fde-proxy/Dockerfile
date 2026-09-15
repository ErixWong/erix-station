# 自研零依赖 admission proxy（替换 tecnativa/docker-socket-proxy）。
# 运行用户：root（uid 0，cap_drop ALL + no-new-privileges 由 compose 施加）；
# docker.sock 挂载 owner 为 root，cap_drop 后仍按 owner 权限可读（deploy-contract §5 加固语义）。
FROM node:22-alpine

WORKDIR /app
COPY server.js ./

ENV PORT=2375
EXPOSE 2375

CMD ["node", "server.js"]
