# portal/ — 管理平台服务（零框架 node:http）

P1 walking skeleton：认证骨架 + 迁移 runner + 极简原生页面。运行时依赖仅 `pg`。

**用户面前端（issue #61）**：`portal/frontend/` 是 Vue 3 SPA（Vite 8 + TS + vue-router 4 hash 模式 +
pinia + Tailwind v4 + vitest），`npm run build` 产物由 Docker 多阶段构建注入 `static/app/`，
`portal/src/http.js` 的 serveStatic 将 `/` 与 `/assets/*` 映射到该注入目录（开发态 `vite dev` 走
`:5173` 代理到 portal `:8080`）。旧整页 HTML（`static/index.html` / `static/admin.html`）与
`static/vendor/` 已于 P4 退役删除；`GET /admin` 由后端 302 到 SPA hash 路由 `/#/admin`（认证与
角色判断交给前端路由守卫）。前端单测：`cd portal/frontend && npm test`（typecheck：`npm run typecheck`）。

## 目录

```
portal/
  Dockerfile            # node:22-slim，非 root node 用户
  src/
    config.js           # 从环境变量读配置（含 COOKIE_PROFILE 开发/生产差异）
    db.js               # pg 连接池
    migrate.js          # 按序应用 docs/data/schema.sql + bootstrap.sql（幂等）
    auth.js             # session 只存 token_hash / timingSafeEqual / 过期吊销
    http.js             # 路由分发（healthz / login / logout / me + 静态页）
    cli.js              # serve / migrate / bootstrap-admin / healthcheck
  static/              # 静态根（Vue SPA 产物由 Docker 构建注入 static/app/）
  test/                 # node --test 单测
```

## 不经 docker 本地跑（需先有 Postgres）

```bash
# 起一个临时 Postgres 或指向已有库
export DATABASE_URL='postgres://station:station@127.0.0.1:5432/station'
export COOKIE_PROFILE=dev-http
npm run db:migrate                 # 建表 + bootstrap
npm start                          # 起 portal（默认 :8080）
# 另开终端建 admin
node portal/src/cli.js bootstrap-admin --login admin --password <临时口令>
```

## 经 compose 跑

见 [`deploy/README.md`](../deploy/README.md)。

## 测试

```bash
npm test          # node --test（portal/test/*.test.js，注入 fake pool，不碰真实环境）
```
