#!/bin/sh
# M5：healthcheck = agentd 进程存活 + 最近一次心跳成功信号（/run/station/hb-ok，agentd 每次成功心跳 touch）。
# 评审 M5：只查 pgrep 时，portal 完全不可达（--network none 实测）仍 healthy——加心跳新鲜度。
# 宽限：/run/station/hb-ok 由 entrypoint 在启动时创建（mtime=启动时刻），portal 短暂不可达在宽限内不算 unhealthy。
set -e
pgrep -f "node /opt/erix/agentd.js" > /dev/null || exit 1
HB=/run/station/hb-ok
[ -f "$HB" ] || exit 1
now=$(date +%s)
hb=$(stat -c %Y "$HB" 2>/dev/null || echo 0)
[ $(( now - hb )) -lt 180 ] || exit 1
