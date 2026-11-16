# ---- issue #61 P1：前端构建阶段（Vue 3 + Vite + TS，portal/frontend）----
# devDependencies 含 vite/tailwind/vitest，故本阶段不得设 NODE_ENV=production（npm ci 会跳过 devDeps）。
FROM node:22-slim AS frontend-builder
WORKDIR /build/portal/frontend
# 依赖清单先行，利于层缓存（package-lock.json 入库，npm ci 可复现）
COPY portal/frontend/package.json portal/frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY portal/frontend/ ./
# ---- issue #589 止血：`@shared` 别名的目标目录必须进得了镜像 ----
# ① 为什么目标是 `../shared/`（而不是 `./shared/`）：本阶段的 WORKDIR 是上面的 `WORKDIR /build/portal/frontend`
#    （= `COPY portal/frontend/ ./` 的落点），而前端 `vite.config.ts:17` 把别名定成
#    `alias: { '@shared': new URL('../shared/', import.meta.url).pathname }` ⇒ 别名目标 = `portal/frontend/` 的
#    **同级** `portal/shared/`，镜像里就是 WORKDIR 的上一层再进 `shared` = `/build/portal/shared`。
#    所以本行的源与目标都**与 vite.config 同源**：改 WORKDIR、改别名、或把前端换一层目录，这行都要跟着动。
# ② 这一行是 issue #589 的止血（main 于 `04c7d83` 红）：`portal/shared/` 是 PR #582（issue #528 枚举单源）
#    才新建的目录，前端 7 个文件随之 `import … from '@shared/macro-kinds'`，但本阶段只
#    `COPY portal/frontend/ ./`（`portal/shared/` 在它外面）⇒ 镜像里没那个目录 ⇒ `vite build` 报
#    `UNLOADABLE_DEPENDENCY: Could not load ../shared/macro-kinds` ⇒ **镜像构建不出来**（CI run 43817003603
#    的「构建校验：station-portal 镜像」步）。此前 `portal/shared/` 不存在，所以「只拷 frontend」曾经是成立的。
# ③ 以后**新增 `@shared` 目标（或任何指向 `portal/frontend/` 外面的构建期依赖）必须同步这里**，而不靠人肉记
#    忆：根 `test/portal-shared-copy.test.js` 扫 `portal/frontend/src/**` 的全部 `@shared` 引用，要求每个目标
#    既在盘上存在、又被本阶段某条**排在 `RUN npm run build` 之前**的 COPY 送到别名解析得到的那个路径
#    （它自带反向自证：删/歪/延后本行都必须判不合格）。
COPY portal/shared/ ../shared/
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

# ---- 版本作为构建产物（issue #586：portal 此前**没有**这份载体）-------------------------
# 口径与 `runner/Dockerfile:155-166` 逐字同源，那边已经定过：`build-info.json` 是运行时**唯一**版本真相，
# `LABEL org.opencontainers.image.version` 只给人看。portal 侧缺它付出过真代价：发 v0.1.69 时宿主工作树
# 停在 0.1.68，`docker compose build station-portal` 烘的就是那份树 ⇒ 真机上 FDE 报 0.1.69、portal 报 0.1.68
# 分裂了一小时，而**没有任何机器判据能发现**（`ci.yml` 的 ⑤′ tripwire 当时只查 FDE 镜像）。
# 两格版本从**镜像内的文件**取（`/app/package.json`、`/app/node_modules/erix-agent/package.json`），
# 不从 ARG 传——少一条必须与构建同步的手工输入就少一次漂移；只有镜像内拿不到的 git revision /
# 构建时间走 ARG（与 runner 同一取舍）。`station_version` 取不到就 **exit 1**：宁可构建红，
# 也不要烘出一个看起来合法的假版本（`runner/lib/build-info.js` 顶部记的 `0.1.0` 事故就是这个形状）。
# 故意放在**最末尾**：ARG 一变更就让它之后的层缓存失效，放最后把影响压到最小（前面所有层与版本无关）。
# ⚠ 这三个 ARG 不传 ⇒ `revision`/`built_at` 恒 `unknown`（v0.1.53 的 FDE 镜像实测就是这样）：
#   判据是 `ci.yml` 的 portal tripwire 步骤（四格逐条断言），不是这段注释。
# ⚠ 运行侧读它的唯一入口 = `portal/src/build-info.js`（dev 源码态退到仓库根 `package.json`），
#   业务代码**不许**自己 `require('package.json')` —— 那是第二个真相源。
ARG STATION_VERSION=unknown
ARG STATION_REVISION=unknown
ARG STATION_BUILD_DATE=unknown
RUN node -e 'const fs=require("fs");const v=p=>{try{const j=JSON.parse(fs.readFileSync(p,"utf8"));return (typeof j.version==="string"&&j.version)||"unknown"}catch{return "unknown"}};const sv=v("/app/package.json");if(sv==="unknown"){console.error("[build-info] /app/package.json 缺 version，版本没能烘进镜像");process.exit(1)}fs.writeFileSync("/app/build-info.json",JSON.stringify({station_version:sv,engine_version:v("/app/node_modules/erix-agent/package.json"),revision:process.env.STATION_REVISION||"unknown",built_at:process.env.STATION_BUILD_DATE||"unknown"})+"\n");console.log("[build-info] "+fs.readFileSync("/app/build-info.json","utf8").trim())'
# label 给人看（`docker inspect` 一眼可读版本），不参与运行时真相；真值以 build-info.json 为准。
LABEL org.opencontainers.image.version="${STATION_VERSION}"       org.opencontainers.image.revision="${STATION_REVISION}"

CMD ["node", "portal/src/cli.js", "serve"]
