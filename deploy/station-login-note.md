# v0.1.5 FDE 容器重建后登录冒烟发现（2026-10-13 夜班，主 agent 记录）
# 本机透明代理(iptables OUTPUT owner/cgroup)会劫持宿主机进程发起的 station 端口请求，
# v2ray 按 Host 域名路由到陈旧实例 → 新口令 401 / 陈旧态；容器 netns 内发起则干净(200)。
# 规避：agent 冒烟/验收一律容器内发起(docker exec station-portal node … 或 --net host 容器)，
# 别拿宿主机 curl 的 401 当平台故障。AGENTS §3.2 代理坑家族的新变体。
