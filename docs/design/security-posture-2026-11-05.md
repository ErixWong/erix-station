# 安全现状与风险清单（2026-11-05 实测）— 已归档冷层

> 本文是**参考实例 A（本机）的宿主暴露面实测快照**（机器事实），已整篇搬出仓库 ⇒ 见 `~/projects/docs/station-dev-machine.md`（源 pi-tools，自托管，不在公网）。
> **原结论摘要**：宿主暴露面存在 **OPEN 项**（`#233` 宿主防火墙未落地，FDE 容器可直连宿主绑 `0.0.0.0` 的服务）；`DOCKER-USER` 链有 **27 条 publish**、`INPUT` 链 11 条，收紧需两条链都写。
> 规格与判据仍以 [`topology.md`](topology.md) / [`deploy-contract.md`](deploy-contract.md) 为准；本页仅留档、不再更新。
