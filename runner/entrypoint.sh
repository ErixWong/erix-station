#!/bin/sh
# station-agentd entrypoint（root 启动，PID 2；tini 为 PID 1）。
# 依据：docs/design/deploy-contract.md §6.2（B12/B7）、docs/design/runner-integration.md §2.3（方案 (a)）。
set -e

# M5：healthcheck 心跳信号锚点（agentd 每次成功心跳 touch；启动时创建 = 宽限起点）。
mkdir -p /run/station
touch /run/station/hb-ok
chown 1001:1000 /run/station/hb-ok

# F3：umask 0002——共享 GID 1000 模型下，agentd(1001) 创建的目录/文件必须让 worker(1002) 可写
#（评审实测：默认 0022 时 agentd 建的 worktree 为 2755，worker 1002 写入 Permission denied）。
umask 0002

# root → drop 到 erix-agentd(1001)，并以 ambient caps 保留 SETUID/SETGID/KILL：
#   - SETUID/SETGID：agentd fork worker 时切 UID 1002（runner §3/§11.3）；
#   - KILL：agentd 在 lease_lost / stop 时对 worker（不同 UID）发 SIGTERM/SIGKILL（§6.4/§6.5）。
# bounding-set 收敛到仅这三个能力；其余（CHOWN/DAC_OVERRIDE/FOWNER）在 drop 后不再需要。
exec setpriv \
  --reuid=1001 --regid=1000 --init-groups \
  --bounding-set=-all,+setuid,+setgid,+kill \
  --inh-caps=+setuid,+setgid,+kill \
  --ambient-caps=+setuid,+setgid,+kill \
  node /opt/erix/agentd.js
