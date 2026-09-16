# FDE 容器镜像：station-agentd + station-runner + erix-agent（deploy-contract §1/§6）。
# 依据：docs/design/deploy-contract.md §6（三用户/root-drop/--init/healthcheck）、
#       docs/design/runner-integration.md §2/§11（进程模型/凭据边界）。
# build context = runner/（deploy-contract §1：FDE_IMAGE 自构建）。

FROM node:22-slim

# ---- 运行时工具（deploy-contract §2.3/testing §3.8 + git worktree §6.2）----
# procps：ps/pgrep（healthcheck 与 smoke test 依赖）。
# git：真实项目 run 需要 worktree（runner §6.2）；缺失时 agentd 会静默回退空目录（评审 F2）→ 必须安装。
# ca-certificates：erix-agent 访问 llm.<base>（https）与 git https clone（FDE 自配凭据，§11.1）。
RUN apt-get update \
  && apt-get install -y --no-install-recommends procps git \
  && rm -rf /var/lib/apt/lists/*

# ---- 三用户（deploy-contract §6.3）：erix(1000)/erix-agentd(1001)/erix-worker(1002) 同 GID 1000 ----
# node:22-slim 自带 node(1000) 用户，重命名为 erix 以符合契约（HOME=/home/erix）。
RUN groupmod -n erix node \
  && usermod -l erix -d /home/erix -m node \
  && useradd -u 1001 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin erix-agentd \
  && useradd -u 1002 -g 1000 -M -d /nonexistent -s /usr/sbin/nologin erix-worker

WORKDIR /opt/erix

# ---- erix-agent 依赖（npm v0.3.5，deploy-contract §1 版本记录点）----
# 构建不留缓存与凭据：--omit=dev（erix-agent 零运行时依赖）+ 清 npm cache；容器内无真实 LLM key。
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && rm -rf /root/.npm

# ---- runner 代码 ----
COPY agentd.js worker.js ./
COPY lib ./lib
COPY entrypoint.sh /usr/local/bin/station-agentd-entrypoint
COPY healthcheck.sh /usr/local/bin/station-agentd-healthcheck
RUN chmod 0755 /usr/local/bin/station-agentd-entrypoint /usr/local/bin/station-agentd-healthcheck

# ---- 非 root 运行路径（deploy-contract §1）：root 启动 → drop 1001（setpriv ambient caps）----
# 说明：compose/provisioner 已 --init（tini 作 PID 1）；entrypoint 直接 exec agentd，不重复 init（runner §2.3 方案 (a)）。
# setpriv 以 ambient caps 保留 SETUID/SETGID/KILL，供 agentd(1001) fork worker(1002) 与跨 UID kill（deploy-contract §6.2 B7）。
ENTRYPOINT ["/usr/local/bin/station-agentd-entrypoint"]

# healthcheck（M5）：进程存活 + 心跳新鲜度——agentd 每次成功心跳 touch /run/station/hb-ok，
# 健康要求进程在 + 心跳新鲜（<120s）或启动宽限（hb 文件尚无但 agentd 进程 <120s，避免启动竞态误重启）。
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD /usr/local/bin/station-agentd-healthcheck || exit 1
