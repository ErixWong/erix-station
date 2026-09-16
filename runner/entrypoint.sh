#!/bin/sh
# station-agentd entrypoint（root 启动，PID 2；tini 为 PID 1）。
# 依据：docs/design/deploy-contract.md §6.2（B12/B7）、docs/design/runner-integration.md §2.3（方案 (a)）。
set -e

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
