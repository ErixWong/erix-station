# FDE 容器镜像：station-agentd + station-runner + erix-agent（deploy-contract §1/§6）。
# B 档语言矩阵（issue #27，决策 2026-09-18）：Node 22 + Python3/venv/pip + gcc/g++/make
#   + .NET SDK 8.0（COPY 自官方 sdk 镜像）+ Playwright/chromium（§12.4，装容器内不做 sidecar）。
#   code-server 不装（用户 2026-09-18 裁定，P3 再议）。
# 依据：docs/design/deploy-contract.md §6（三用户/root-drop/--init/healthcheck）、
#       docs/design/runner-integration.md §2/§11（进程模型/凭据边界）。
# build context = runner/（deploy-contract §1：FDE_IMAGE 自构建）。
# 层序：重且稳定的层（apt/dotnet/playwright）在前，易变代码在后——改 runner 代码不触发重装。

FROM node:22-slim

# ---- 运行时工具 + B 档语言链（issue #27；--no-install-recommends 控制体积）----
# procps：ps/pgrep（healthcheck 与 smoke test 依赖）。
# git：真实项目 run 需要 worktree（runner §6.2）；缺失时 agentd 会静默回退空目录（评审 F2）→ 必须安装。
# ca-certificates：erix-agent 访问 llm.<base>（https）与 git https clone（FDE 自配凭据，§11.1）。
# python3/venv/pip + build-essential（gcc/g++/make/libc-dev）：Python 项目 + node-gyp 原生模块
#   （缺这三样时 npm install sharp/better-sqlite3 等必挂，issue #27 §1.3）。
# python3-dev（Python.h 头文件）：缺则 pip 源码构建必挂（评审 F2 实测 Python.h: No such file）。
# libicu72：.NET SDK 运行依赖（globalization；node:22-slim 不带）。
# curl：排障/HTTPS 拉取（code-server 已裁定不装，issue #27）。
# tree：跨项目目录概览（内置 tree 工具被 jail 锁在项目内，shell 层需要真二进制，真机 run dca532a3 实证）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       procps git ca-certificates curl tree \
       python3 python3-venv python3-pip python3-dev \
       build-essential \
       libicu72 \
  && rm -rf /var/lib/apt/lists/*

# ---- 三用户（deploy-contract §6.3）：erix(1000)/erix-agentd(1001)/erix-worker(1002) 同 GID 1000 ----
# node:22-slim 自带 node(1000) 用户，重命名为 erix 以符合契约（HOME=/home/erix）。
RUN groupmod -n erix node \
  && usermod -l erix -d /home/erix -m node \
  && useradd -u 1001 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin erix-agentd \
  && useradd -u 1002 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin erix-worker

# ---- .NET SDK 8.0（issue #27 决策 1）：COPY 自官方 sdk 镜像（bookworm 同底座），软链进 PATH ----
COPY --from=mcr.microsoft.com/dotnet/sdk:8.0 /usr/share/dotnet /usr/share/dotnet
ENV DOTNET_ROOT=/usr/share/dotnet
RUN ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
  && dotnet --list-sdks

# ---- Playwright + chromium（规格 §12.4：装进 FDE 容器，不做 sidecar；版本 pin 便于重建复现）----
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# 浏览器装到固定路径（root 属主、全员可读执行；agent 以 erix/worker 运行时只读使用）。
# code-server 不装（用户 2026-09-18 裁定：路线图 P3 项不提前；issue #27 §2 同步）。
RUN npm install -g playwright@1.63.0 \
  && npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*  # --with-deps 触发 apt 安装，同层清理（评审 F6）

# ---- Git hosting CLIs（linux/amd64，固定稳定版；版本/资产于 2026-10-06 核实）----
ARG GH_CLI_VERSION=2.102.0
ARG TEA_CLI_VERSION=0.16.0
ARG GLAB_CLI_VERSION=1.121.0
RUN set -eu; \
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT; \
  mkdir -p "$tmp/gh" "$tmp/glab"; \
  curl --fail --silent --show-error --location --retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors \
    "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/gh_${GH_CLI_VERSION}_linux_amd64.tar.gz" \
    -o "$tmp/gh.tar.gz"; \
  tar -xzf "$tmp/gh.tar.gz" -C "$tmp/gh"; \
  install -o root -g root -m 0755 "$tmp/gh/gh_${GH_CLI_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh; \
  curl --fail --silent --show-error --location --retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors \
    "https://dl.gitea.io/tea/${TEA_CLI_VERSION}/tea-${TEA_CLI_VERSION}-linux-amd64" \
    -o "$tmp/tea"; \
  install -o root -g root -m 0755 "$tmp/tea" /usr/local/bin/tea; \
  curl --fail --silent --show-error --location --retry 5 --retry-delay 2 --retry-connrefused --retry-all-errors \
    "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_CLI_VERSION}/downloads/glab_${GLAB_CLI_VERSION}_linux_amd64.tar.gz" \
    -o "$tmp/glab.tar.gz"; \
  tar -xzf "$tmp/glab.tar.gz" -C "$tmp/glab"; \
  install -o root -g root -m 0755 "$tmp/glab/bin/glab" /usr/local/bin/glab; \
  gh --version | grep -F "gh version ${GH_CLI_VERSION} (" >/dev/null; \
  tea --version | sed 's/\x1b\[[0-9;]*m//g' | grep -F "Version: ${TEA_CLI_VERSION}" >/dev/null; \
  glab --version | grep -F "glab ${GLAB_CLI_VERSION} " >/dev/null

# ---- git 跨 UID 协作（实测发现，issue #27 记录）----
# safe.directory：agentd(1001)/worker(1002) 在 FDE(1000) clone 的仓库里跑 git 必触发
#   "dubious ownership" → agentd.js:326 catch 吞掉 → worktree 机制**静默降级成普通目录**（D8 隔离失效）。
# sharedRepository=group：git 原生机制，init/clone 自动把 .git 调成 2775 组写——免约定，
#   对任意入口（docker exec shell umask 022 / agent bash）都生效；agentd(1001) 才能 worktree add。
# 配合 agentd/worker 的 umask 0002（user-space §6.2）：agentd checkout 的 worktree 文件 664，worker(1002) 可写。
#
# credential.helper 两条（issue #399）：
#   1) 平台托管凭据：fill-only helper 读 /run/erix/git/credentials（ro bind，portal 独占写，
#      宿主源 <userSpaceRoot>/<fde>/platform/git/）。store/erase 对它是 no-op——git 的
#      「认证被拒 ⇒ erase」再也删不动平台托管的那一行（#399 真因：一次 401 静默删行）。
#   2) FDE 自己的 ~/.git-credentials 照旧由 FDE 读写（github 等自配凭据），平台不碰。
#   ⚠ 排序必须落在 system 级且平台条在前：git 逐 helper 询问、先答先赢；而 local/-c 的
#      helper 是**追加在 system 之后**的，写 ~/.gitconfig 会被后加的条目插队（容器实测）。
RUN install -d -o root -g root -m 0755 /usr/local/libexec && \
  printf '#!/bin/sh\n# erix-gitcred：平台托管凭据文件的只读视图（issue #399）。\n# git 把操作名追加在参数末尾：get ⇒ 代答（无该 host 时输出为空，git 继续问下一个 helper）；\n# store/erase ⇒ 静默 no-op（exit 0）：平台文件只归 portal 写，erase 永不落在这里。\ncase " $* " in\n  *" get "*) exec git credential-store "$@" ;;\n  *) exit 0 ;;\nesac\n' > /usr/local/libexec/erix-gitcred && \
  chmod 0755 /usr/local/libexec/erix-gitcred && \
  printf '[safe]\n\tdirectory = *\n\n[core]\n\tsharedRepository = group\n\n[credential]\n\thelper = !/usr/local/libexec/erix-gitcred --file=/run/erix/git/credentials\n\thelper = store\n' > /etc/gitconfig

WORKDIR /opt/erix

# ---- erix-agent 依赖（npm v0.9.0，issue #43；deploy-contract §1 版本记录点）----
# 构建不留缓存与凭据：--omit=dev（erix-agent 零运行时依赖）+ 清 npm cache；容器内无真实 LLM key。
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /root/.npm

# ---- 依赖缓存落位（平台默认，优先级最低的一层）----
# 症状（eric 空间实测 2026-10-24）：`~/projects/.pnpm-store` 长到 388 MB，把目录下拉第一项
#   掉了——真实项目被工具自建缓存目录淹没（现靠 dirs.js 过滤点开头目录兼容，但垃圾还在长）。
#   根因不是权限：pnpm 默认 store 与项目不同卷（或不可用）时，会在「项目所在卷」往上找位置建
#   `.pnpm-store`，而 `~/projects` 正是 projects bind mount 的根，缓存就写进了项目列表。
#   只要缓存位置由工具自己选，同类事就会反复发生——以平台默认值铉死才是解。
# 做法：写 npm 的 **globalconfig**（镜像内 `npm config get globalconfig` 实测 = /usr/local/etc/npmrc）。
#   它是 npmrc 配置链最低一层，只给默认值：实测 `~/.npmrc` / 项目 `.npmrc` 仍能覆盖（userconfig 优先）；
#   npm / pnpm / yarn 共读此文件，所以 `store-dir`（pnpm）+ `cache`（npm）一并铉住。
#   `~/cache` 是 user-space.md §3 已划定的依赖缓存区（独立 bind mount、不在目录下拉、平台不代管内容）；
#   不预建子目录，工具自建：agentd(1001)/worker(1002) 主组 1000 + umask 0002 ⇒ 写入跳 UID 可复用。
# 层位：必须在上方 `npm install --omit=dev` 之后——否则构建期缓存也落 /home/erix/cache/npm，
#   运行时被宿主 bind mount 盖住，镜像里白占一层且不可回收。
# corepack / pip 不读 npmrc，用镜像 ENV（用户 shell export 可覆盖）。
RUN printf 'cache=/home/erix/cache/npm\nstore-dir=/home/erix/cache/pnpm-store\n' > /usr/local/etc/npmrc \
  && chmod 0644 /usr/local/etc/npmrc
ENV COREPACK_HOME=/home/erix/cache/corepack \
    PIP_CACHE_DIR=/home/erix/cache/pip

# ---- runner 代码 ----
COPY agentd.js worker.js ./
COPY lib ./lib
# #363：平台技能（bundled 通道，worker 默认 bundledDir=/opt/erix/skills）。用户同名技能放
# ~/.erix/skills 可覆盖（loader 优先级），日得迭代不需重建镜像。
COPY skills ./skills
COPY entrypoint.sh /usr/local/bin/station-agentd-entrypoint
COPY healthcheck.sh /usr/local/bin/station-agentd-healthcheck
RUN chmod 0755 /usr/local/bin/station-agentd-entrypoint /usr/local/bin/station-agentd-healthcheck

# ---- 版本作为构建产物（issue #404 结案）-------------------------------------------
# `build-info.json` 是运行时唯一版本真相（agentd 经 lib/build-info.js 读它）。
# station/engine 两个版本**从镜像内的文件取**（`package.json` 与 `node_modules/erix-agent/package.json`），
# 不从 ARG 传——少一条"必须与构建同步的手工输入"就少一次漂移；只有 git revision / 构建时间这类
# 镜像内部拿不到的才走 ARG。engine_version 用文件读而不是 `require('erix-agent/package.json')`：
# 该包的 exports 只开了 `.`/`./tools`/`./contract-tests`，裸 spec 会 ERR_PACKAGE_PATH_NOT_EXPORTED。
# 故意放在靠后位置：ARG 每次变更都会让它之后的层缓存失效，放末尾把影响压到最小。
ARG STATION_VERSION=unknown
ARG STATION_REVISION=unknown
ARG STATION_BUILD_DATE=unknown
RUN node -e 'const fs=require("fs");const v=p=>{try{const j=JSON.parse(fs.readFileSync(p,"utf8"));return (typeof j.version==="string"&&j.version)||"unknown"}catch{return "unknown"}};const sv=v("/opt/erix/package.json");if(sv==="unknown"){console.error("[build-info] /opt/erix/package.json 缺 version，版本没能烘进镜像");process.exit(1)}fs.writeFileSync("/opt/erix/build-info.json",JSON.stringify({station_version:sv,engine_version:v("/opt/erix/node_modules/erix-agent/package.json"),revision:process.env.STATION_REVISION||"unknown",built_at:process.env.STATION_BUILD_DATE||"unknown"})+"\n");console.log("[build-info] "+fs.readFileSync("/opt/erix/build-info.json","utf8").trim())'
# label 给人看（docker inspect 一眼可读版本），不参与运行时真相；版本真值以 build-info.json 为准。
LABEL org.opencontainers.image.version="${STATION_VERSION}"       org.opencontainers.image.revision="${STATION_REVISION}"

# ---- 非 root 运行路径（deploy-contract §1）：root 启动 → drop 1001（setpriv ambient caps）----
# 说明：compose/provisioner 已 --init（tini 作 PID 1）；entrypoint 直接 exec agentd，不重复 init（runner §2.3 方案 (a)）。
# setpriv 以 ambient caps 保留 SETUID/SETGID/KILL，供 agentd(1001) fork worker(1002) 与跨 UID kill（deploy-contract §6.2 B7）。
ENTRYPOINT ["/usr/local/bin/station-agentd-entrypoint"]

# healthcheck（M5）：进程存活 + 心跳新鲜度——agentd 每次成功心跳 touch /run/station/hb-ok，
# 健康要求进程在 + 心跳新鲜（<180s）；启动宽限由 --start-period=120s + entrypoint 启动即建 hb-ok（mtime=启动时刻）保证，避免启动竞态误重启。
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD /usr/local/bin/station-agentd-healthcheck || exit 1
