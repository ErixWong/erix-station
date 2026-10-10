# 首次真实部署记录 — v0.1.0（2026-10-10，UTC+8）

> 面向运维/后来者：这条记录写「实际部署成了什么样」，不替代 `docs/design/deploy-contract.md`（应该是什么样）与 `docs/env.md`（参数口径）。`docs/ops/runbook.md` 仍是待补项（docs/README D6）。

## 部署形态

| 项 | 值 |
|---|---|
| 版本锚点 | git tag **`v0.1.1`**（= `f99e49c`，merge PR #237；首个部署锚点 `v0.1.0` = `24d0fe8`，PR #232） |
| 入口 | **http**，`station.fde.erix.vip:8090`（Traefik `web`；https/ACME 本轮不做 → #234） |
| 泛域名 | `*.fde.erix.vip` → Tailscale IP **`100.100.0.3`**（客户端流量在 WireGuard 隧道内，非裸明文） |
| 生产判定 | **`FDE_DEV_MODE=0`**（真·生产口径；非「dev 栈当生产糊」） |
| `SESSION_SIGNING_KEY` | 已显式注入 64hex 强随机值（生产模式下占位符会**拒绝启动**，`config.js:133`）。⚠️ 轮换它 = 全量会话失效 |
| `COOKIE_PROFILE` | **`dev-http`**（`fde_session_dev` + `HttpOnly` + `SameSite=Lax`，**无 `Secure`**）——决策者 2026-10-10 口径放行，见 `docs/env.md` §10 |
| FDE 镜像 pin | **`sha256:4c1e70685978b65863d5e21d6877fe39ab873d62366a52c89ff950a3f97fefc5`**（image ID 形态；`fde-eric` 的 `.Image` 已核等于此值。v0.1.0 时的初值是 `sha256:3572b989…`，换 `SYSTEM_PROMPT` 后重建镜像即换 ID —— **这正是「换镜像必须显式改 `.env`」的实例**） |
| 引擎 | `erix-agent` **0.18.0**（两处 pin 同步） |
| LLM | `station-litellm`（profile `litellm`，宿主回环 `127.0.0.1:4100`），`spend` 可算（#164 定价），**`max_budget` 未下发** ⇒ 不自动拦（#235） |
| 容器 | 6 个：`station-edge` / `station-portal` / `station-db` / `station-docker-proxy` / `station-litellm` / `fde-eric`，全 healthy |

## 已知偏离（都开了单，别当没看见）

| 偏离 | 单 |
|---|---|
| 无 TLS：无服务端身份验证、cookie 无 `Secure`、拿不到 `__Host-` 前缀；两条 https 路线（自建 CA / ACME DNS-01）写在单里 | **#234** |
| **防火墙应用未实现** ⇒ FDE→宿主端口未收紧（`18080` 直连 portal 可绕过 forwardAuth，违反不变式 2；`9000` Portainer 未认证=Docker 控制面）。当前缓解：入口只在 tailnet + FDE 内跑使用者本人的 agent/项目 | **#233** |
| 镜像未推 registry、无 CI（只有本机 build + image ID pin）；`portal`/`fde-proxy` 仍是 `:local` tag | **#235** |
| 终止文案不可见（`aborted` 无中文标签 + `run_end` 不入历史白名单 ⇒ 刷新后无终态提示）；空 body POST 强制 `Content-Type`；单次 run 无成本护栏 | **#236** |
| 文件工具迁上游遗留（`maskedPaths` 只挡文件工具不挡 shell；`SYSTEM_PROMPT` 已在本轮补） | #231 |

## 备份（宿主侧，平台不交付备份机制：deploy-contract §7.2 / issue #3）

- 脚本 `/home/eric/scripts/station-db-backup.sh`；cron **`30 3 * * *`**（本地 UTC+8）
- 产物 `~/backups/station-db/station-<ts>.dump`（`pg_dump -Fc` + `pg_restore --list` **可读校验**，保留 14 天），日志 `backup.log` / `cron.log`
- ⚠️ 规范位置应是 `/docker/station-backups/`（全局约定），但 `/docker` 是 `root:root 755` 且本机**无免密 sudo** ⇒ 待一次性 `sudo mkdir + chown eric` 后把 `BACKUP_DIR` 改过去（前提记在 #233）
- 数据卷：`/docker/station-db`（pg data，属主是容器 uid）
- 首次实跑：`station-20261010-082729.dump`，**16,360,909 bytes**，校验 ok

## 部署后补票：`SYSTEM_PROMPT` 行为验证（v0.1.1，PR #237）

同一个 trivial 任务（「用 searchText 在项目根搜 `react`」，**不提示任何参数**）：

| | v0.1.0（旧提示词） | v0.1.1（新提示词） |
|---|---|---|
| 工具调用 | **16 次**（翻 `~/.erix/config.json`、读别的项目、`npm init -y`、写报告两次…） | **7 次**（`searchText`×2 + `shell`×4 + `tree`×1） |
| `input_tokens` | **166,278**，撞 **`max_rounds_cap`** | **26,591**，`judge_done` 正常终态 |
| 读到排除账 marker 后的行为 | 认定 flag 无效 → **放弃 searchText 改跑 shell grep** | **自己补 `include_vendor=true, include_hidden=true` 再搜一次**（已从 `tool_use` 入参核实，不是看 marker 文本猜的） |

仍会用 `shell` 做交叉验证（项目里确实没有 `react`，属合理），但**不再因为排除账文案放弃文件工具**。样本 n=1，非基准测试。验收脚本 `~/e2e-diag/prompt-effect.mjs`。

## 部署验收（P1 口径，全部**经 Traefik 入口**，未用 portal 直连端口）

脚本 `~/e2e-diag/deploy-accept.mjs` + `stop-test.mjs`；入口用 `curl --resolve station.fde.erix.vip:8090:100.100.0.3`（本机解析器解析不出泛域名，是已知负缓存坑，见 AGENTS §4.1）。

- 入口 SPA `200`；未登录 `GET /api/sessions` → `401`
- 登录 `200` + `fde_session_dev` cookie 经 ingress 下发/回传；`/api/me` → `login=eric`
- 建会话（cwd=`~/projects/hello-station`）`201` → 对话到终态 → **`tool_use` / `tool_result` 16/16 成对** → `runs.usage` 与 `usage_ledger` 均入账（`input_tokens=166,278`）
- **停止**：`POST /api/sessions/:id/stop` → `200 {status:'cancelling'}` → 终态 **`finished/aborted`**、`cancel_requested_at` 已置、`usage_ledger` 有行（本轮 `input_tokens=0` 合法：在第一个模型轮次完成前就中止；另一轮跑到 2 轮时记 6,357）
- **无新增 `persistence_failed`**：库里 3 条全部是 2026-10-09 08:14–08:16 我自己注入的 #212 测试数据（`phase=checkpoint_before_tool`），早于 #220 合并
- 真浏览器（playwright 容器带 resolver 规则）走 8090：登录成功、会话列表/工具卡片正常、**无 `[object Object]`**、0 红色告警、重开页面无 4xx（登录页 `/api/me` 探针的 401 是浏览器控制台噪音）

## 升级 / 回滚（本次做法，可复制）

1. 改代码 → PR → 合并 → **`docker compose -f deploy/docker-compose.yml build station-portal`**（BuildKit 层缓存与 FDE 镜像共享，**构建要串行**）+ `node -e "import('./portal/integration/lib/fde-image.mjs').then(m=>m.buildFdeImage('erix-station/fde:local'))"`
2. **生产判定下 `FDE_IMAGE` 必须换成新的 image ID**（`docker image inspect erix-station/fde:local --format '{{.Id}}'`）——这是「升级 FDE 镜像」的**显式动作**，忘改就还在跑旧镜像
3. `docker compose -p station up -d station-portal`；然后 **`docker rm -f fde-eric` + `docker exec station-portal node portal/src/cli.js provision-fde --fde-name eric`**（`ensureFdeContainer` 不会因镜像变化自动重建；ExtraHosts 在容器创建时定死，改 `BASE_DOMAIN` 也必须重建）
4. 回滚：`.env` 的 `FDE_IMAGE` 改回旧 image ID + 重跑第 3 步（镜像 ID 是不可变的，所以回滚可信）
