# 空闲 DB 负载：测量方法与现测基线（#506 / #520）

> **这一页只回答两个问题**：①「平台静置时数据库到底被谁打」怎么**量**；②现在量到的数是多少。
> 改动的过程账在 `docs/maintenance/task-ledger.md` §8.11x（#506）与 §8.134（#520）。
> 判据口径在 GitHub issue #506 / #520，本文不重复。

## 1. 测量方法（可复现，只读）

```bash
# psql 在 DB 容器里，宿主机没装：只能进容器（共享 dev 栈，一律只读，不重启不重建任何容器）
docker exec station-db psql -U station -d station -At -F'|' -c \
  'SELECT COALESCE(SUM(xact_commit),0), COALESCE(SUM(xact_rollback),0) FROM pg_stat_database'
```

- **取哪个字段**：`pg_stat_database.xact_commit`（全库求和）。它是**计数器**，必须取**两次的差 ÷ 窗口秒数**，
  不能直接读绝对值（绝对值是 postmaster 以来的累计，上次重启点未知）。
- **窗口长度**：30s 起。10s 以下的窗口里 `xact_commit` 差值只有百来个，抖动能把结论翻掉。
- **前置条件**：无浏览器、无在跑的 run。⚠ 但 `station-db` 是**共享 dev 库**——当时挂在栈上的
  FDE 容器仍在发 internal API 心跳与长轮询 claim，这部分**不算噪声、也停不掉**（停 = 重启容器 = 影响别的 session），
  所以本文所有读数都是「**平台静置**」而不是「库完全空转」。
- **配套看每表扫描**：`pg_stat_user_tables` 的 `seq_scan` / `idx_scan` / `n_tup_ins+upd+del`，同样取差值。
  只有事务数会骗人：一条 `UPDATE ... FROM users JOIN fde_networks` 是 1 个事务、3 次表扫。

### 1.1 试过但**不可用**的办法（别再来一遍）

| 办法 | 结果 |
|---|---|
| `pg_stat_activity` 客户端轮询采样 | 100 次采样 / 20s 只抓到 **2** 条在飞语句 |
| **服务端** `DO` 块内 `pg_stat_get_activity` / `pg_stat_activity` 采样（4ms × 7500 次；0.5ms × 40000 次） | **0 命中**。这些语句短于亚毫秒，采样抓不到 ⇒ 想按语句文本归因，只能装 `pg_stat_statements`（要改 `shared_preload_libraries` = 重启 DB，本单不允许） |

所以**归因 = 「每拍语句数（单测里用假 pool 数出来）」×「拍/秒（现测节拍）」，再用每表扫描增量交叉验证**；
不是靠抓语句。上面两条采样读数是 2026-11-16 现测。

## 2. 现测基线（#520 改前，2026-11-16 01:19–01:40，dev 真库）

同法三次独立窗口：

| 窗口 | `xact_commit` 速率 |
|---|---|
| 30.29s | **11.23 /秒** |
| 30.29s | **12.02 /秒** |
| 32.28s | **11.74 /秒** |

对照 issue 里 #506 改完的读数 13.2 /秒（2026-11-15 00:2x）——**同一量级，本单起点按 ~12 /秒 算**。

上面那三个都是 30s 窗口。后来补了一个 **300.28s 的长窗口**（02:40–02:45，静置）：**11.34 事务/秒**，
与三个短窗口完全一致 ⇒ 本单拿的基线不是偶然窗口。**但要注意**：`station-portal` 容器里是**旧代码**，
那 11.34 是「**本单改前**」的数，**不是**本单改完的读数（拿它当改后读数就是谎）。

每表 30s 窗口增量（同一窗口，`seq`/`idx` = seq_scan / idx_scan 次数，`writes` = ins+upd+del 速率）：

| 表 | seq | idx | writes/秒 | 归属（§3） |
|---|---|---|---|---|
| `containers` | **107** | 0 | **1.32** | provisioner（对账每 FDE 两条无条件 UPDATE） |
| `users` | 34 | **99** | 0 | provisioner `readFdeDesired` + agentd 心跳 |
| `fde_networks` | 45 | 18 | 0 | provisioner（锁内重读 + 期望态 JOIN） |
| `fde_llm_bindings` | 11 | 3 | 0 | agentd 心跳（`getFdeLlmHeartbeatModels`） |
| `materialize_revisions` / `materialize_outbox` | 15 / 30 | 60 / 33 | 0 | materializer（#506 已退避，2s 上限） |
| `route_outbox` / `route_revisions` | 0 / 15 | 63 / 0 | 0 | routes（#506 已退避，2s 上限） |
| `run_queue` / `runs` | 0 | 44 / 54 | 0 | agentd 长轮询 claim（reaper 只占 2/拍·15s，见 §3） |
| `chat_sessions` | 0 | **26** | 0 | **不是这 7 个循环**（§4） |
| `port_observations` | 20 | 0 | 0 | agentd 心跳的 listeners 整批替换 |
| `fde_onboarding` / `fde_offboarding` | 6 / 6 | 12 / 0 | 0 | 两个队列循环的空闲认领 |

## 3. 归因：每拍语句数 × 拍频（不是估的，语句数是数出来的）

「每拍几条语句」用**假 pool** 跑一次真实函数计数（`runRoutesOnce` / `reconcileOnce` / `reapExpiredRuns` …），
拍频是代码常量；两者相乘再与 §2 的表扫增量对量级：

| 循环 | 语句/拍（空闲时，实测） | 改前拍频 | 改前 ≈语句/秒 | **本单之后** | 之后 ≈语句/秒 |
|---|---|---|---|---|---|
| provisioner | **32**（6 个 FDE 稳态；1 个 FDE 是 7 ⇒ 每 FDE 5 条 + 每拍两次 `readFdeDesired`） | 1/5s | **6.4** | 空闲退避到 15s | **2.1** |
| onboarding | **3**（`BEGIN` + `SELECT … FOR UPDATE SKIP LOCKED` + `COMMIT`） | 1/5s | 0.6 | 空闲退避到 30s | 0.1 |
| offboarding | **3**（同上，另有 1h 一次的工作区清理） | 1/5s | 0.6 | 空闲退避到 30s | 0.1 |
| reaper | **1**（`SELECT … FROM run_queue JOIN runs WHERE lease 过期`；0 个到期就是 1 条） | 1/15s | 0.07 | **不退避**（定时语义） | 0.07 |
| drift monitor | 读一份期望态 + 三份盘上文件 | 1/60s | ≪0.1 | **不退避**（定时语义） | 同左 |
| routes（#506） | **4** | 1/2s | 2.0 | 本单没动 | 2.0 |
| materializer（#506） | **4** | 1/2s | 2.0 | 本单没动 | 2.0 |

**结论 1（本单的份额）**：三个被退避的循环合计 7.6 → 2.3 语句/秒，省掉约 **5 条语句/秒**，
与实测里 `containers` / `users` / `fde_networks` 三张表的份额一致（交叉验证成立）。

**结论 2（判据 1 的 <3/秒 本单达不到，这不是漏做）**：本单没动、也不许动的 #506 那两个 outbox 循环
空闲地板就是 **2s × 4 条语句 × 2 个循环 = 4 条语句/秒**，已经单独高于 3/秒；再叠上 §4 那部分 HTTP 侧份额。
要真的 <3/秒，必须**抬 `ROUTE_IDLE_BACKOFF_MAX_MS` / `MATERIALIZE_IDLE_BACKOFF_MAX_MS`（默认 2000）**
或把 outbox 改成事件驱动（`LISTEN/NOTIFY`）——那是 #506 的口径变更，需要单独拍板，不该由 #520 顺带做掉。

## 4. `chat_sessions` 0.9/秒 的归因（工单要求现查）

**结论：不是 `cli.js` 起的这 7 个循环里的任何一个。** 排除方式是把 7 个循环的**空闲路径 SQL 逐条点名**：

| 循环 | 空闲一拍实际跑的语句 | 碰 `chat_sessions` 吗 |
|---|---|---|
| provisioner | `readFdeDesired`（`users`/`fde_networks`/`containers`）+ 每 FDE 锁内重读 `fde_networks` + 两条 `containers` UPDATE | ❌（本模块唯一的 `chat_sessions` 出现在 `deprovisionFde` 的两个事务里，不在对账路径） |
| onboarding / offboarding | `fde_onboarding` / `fde_offboarding` 的认领 SELECT + UPDATE | ❌（`offboarding.js` 里那条 `UPDATE runs … FROM chat_sessions` 在 `disable-user` 步骤里，只有**真在销号**时才跑） |
| reaper | `run_queue JOIN runs`（§3 实测 1 条） | ❌（合成 `run_end` 才碰会话，那要有到期租约） |
| routes / materializer | `*_outbox` 认领 + `*_revisions` | ❌ |
| drift monitor | `readRouteDesiredState` + 三份文件 | ❌ |

剩下的候选只有 **internal/HTTP 侧**，按节拍能对上号的两个：

1. **agentd 长轮询 `claim`**（`runner/agentd.js` 的 `holdMs = 30000`）：`claimRun` 在等待前后各跑一次
   `tryClaim`，那条候选语句的 `FROM run_queue q2 JOIN runs r JOIN chat_sessions s WHERE s.user_id = $3`
   就是 `chat_sessions` 的 idx 扫——挂在栈上的每个 FDE 容器贡献 2 次 / 30s，同时也解释了
   `run_queue` 44 与 `runs` 54 这两项（reaper 自己每拍只有 1 条）。
2. **agentd 心跳**（`ERIX_HEARTBEAT_MS` 默认 15000）：每次心跳 1 条 `containers` UPDATE +
   `getFdeLlmHeartbeatModels`（`fde_llm_bindings`）+ listeners 整批替换（`port_observations`
   `SELECT`+`DELETE`）。这与实测的 `fde_llm_bindings` 0.46/秒、`port_observations` 0.66/秒 对得上。

**没做到的那一步**：把「0.86/秒」精确拆到 1 还是 2。本机没有可用的语句级计数（§1.1），
Traefik 访问日志与 portal 请求日志都不打，所以拿不到决定性读数——**这一格按「未精确拆分」交付**，
但「不是那 7 个循环」这一条是**逐条 SQL 排除**得出的，不是猜。
→ 后续若要收口：scratch 库装 `pg_stat_statements`（或给 claim 候选语句加一条 `application_name` 前缀），
再按 §1 的方法复测。

## 5. 部署后复测口径（判据 1 用它判）

```bash
# 1) 部署带 #520 的镜像（别在 dev 共享栈上直接判：那里的 portal 跑的是旧代码）
# 2) 静置 ≥ 90s（让三个循环爬到退避上限：30s/30s/15s 的最长的那个）
# 3) 跑 §1 的 SQL，30s 窗口
# 4) 想做对照（旧固定节拍 vs 退避）：先看 §6 —— 旋钮不登进 compose 就配不动
```

期望值与本单的算术一致，**不要期望 <3/秒**：

| 指标 | #506 后（本文基线） | #520 部署后期望 | 判据 1 的 <3/秒 |
|---|---|---|---|
| `containers` seq 扫 | 3.5/秒 | **≈ 0.2/秒**（15s 一拍 × 14 次/拍 ⇒ 每拍开销没变，拍少了） | — |
| `fde_onboarding` / `fde_offboarding` 扫 | 0.59 / 0.20/秒 | **≈ 0.10 / 0.10/秒** | — |
| `xact_commit` | 11.2–12.0/秒 | **≈ 6–7/秒** | **不达标**（地板见 §3 结论 2） |

## 6. 三根旋钮「登记才生效」（PR #552 审计 LOW-1 / LOW-2 的返工）

`deploy/docker-compose.yml` 里 `station-portal` 的 `environment` 是**显式列表、无 `env_file`**（该文件
`FILE_UPLOAD_MAX_BYTES` 那条注释自己就写着这个行为）。⇒ 任何新旋钮只要没写进那张列表，运维在
`deploy/.env` 里写它**完全不生效、也不报错**（症状长得像「配了没用」/「运维不会配」）。
#520 的三根一开始就漏了这个形状（LOW-1），现已登记：

| 旋钮 | 代码缺省 | compose 插值缺省 | 生效面 |
|---|---|---|---|
| `ONBOARDING_IDLE_BACKOFF_MAX_MS` | 30000 | `${ONBOARDING_IDLE_BACKOFF_MAX_MS:-30000}` | 可配到共享上限 `MAX_BACKOFF_MS_SAFE=60000` |
| `OFFBOARDING_IDLE_BACKOFF_MAX_MS` | 30000 | `${OFFBOARDING_IDLE_BACKOFF_MAX_MS:-30000}` | 同上 |
| `PROVISIONER_IDLE_BACKOFF_MAX_MS` | **15000（硬上限）** | `${PROVISIONER_IDLE_BACKOFF_MAX_MS:-15000}` | 写 >15000 ⇒ **钳到 15000** + warn 点名旋钮（LOW-2）|

三腿一致性（compose 插值缺省 == 代码缺省常量 == **循环真正生效的封顶值**）由
`portal/test/deploy-env-idle-backoff.test.js` 机器钉住（先例：#472 / #270 / #450）。值口径：只认严格正整数，
`1e4` / `10000abc` / 负数 ⇒ warn 并回落缺省（不静默采用）。**逃生口**：三根都配 `5000` ⇒ 回到 #520 之前的
固定 5s 节拍（现在配得动了）。

⚠ **同一族病的已知遗留（#520 没动，跨单）**：#506 的
`ROUTE_IDLE_BACKOFF_MAX_MS` / `ROUTE_ORPHAN_RECOVERY_INTERVAL_MS` /
`MATERIALIZE_IDLE_BACKOFF_MAX_MS` / `MATERIALIZE_ORPHAN_RECOVERY_INTERVAL_MS` **至今不在** compose 的
`station-portal.environment` 里（四条 `grep -c` 全 0）⇒ 在任何标准部署上它们同样是空气。
修法与本节同形：四行插值 + 把它们加进同一条三腿判据。

## 7. offboarding 的 1h 工作区清理：阈值不变，**节拍会晚**（LOW-3 的准口径）

它不是独立定时器，而是**销号循环里每拍检查一次**的时间门（`now() - lastSweepAt >= SWEEP_INTERVAL_MS`）。
所以 #520 把空闲拍退到 30s 之后，三种说法只有一种对：

| 说法 | 对不对 |
|---|---|
| 「1h 阈值变了」 | ❌ 阈值一个字节没改（`SWEEP_INTERVAL_MS = 60 * 60 * 1000`）|
| 「会被空闲退避饿死」 | ❌ 闸门与「有没有活」解耦；改成「有活才扫」才会饿死（一个已全部处理完的平台永不扫）|
| 「完全不影响日程」 | ❌ 检查频率就是它的节拍上限 ⇒ 典型晚 ~max/2（默认 ≈ 15s），**最坏晚一整个空闲拍 ≤ max（默认 30s）** |

对 1h 粒度是噪声；但 `OFFBOARDING_IDLE_BACKOFF_MAX_MS=3600000` 那种配法会把清理拖到最坏晚 1h，
那已经是拿旋钮改业务语义。判据：用例 C1（假时钟；不拿墙钟当判据 —— #531）。
复测时要卡「清理是否按时」，请直看 portal 日志里 sweep 那一行的时间戳，别拿 30s 窗口反推。
