# 宿主资源监控（系统监控指标）：运维怎么做（issue #650）

> **这一页只回答「怎么做」**：怎么关、怎么加盘、怎么读数、保留期怎么清、什么时候才该换方案。
> 数据形状与字段语义在 `docs/data/model.md` §1.34–§1.35，API 契约在 `docs/api/portal.md` §4.18，
> 参数登记在 `docs/env.md` §10.5，立案理由与决策账在 GitHub issue #650（本文不重复）。
> 实现只有一处：`portal/src/system-metrics.js`（采样 / 落库 / 分桶 / API 载荷）+ `cli.js serve` 起采样器
> + `internal.js` 的 reaper 清理槽 + `http.js` 的 `GET /api/admin/system/metrics`。

## 1. 它是怎么跑起来的（一句话形状）

`cli.js serve` 起一个采样器：每 `SYSTEM_METRICS_INTERVAL_SECONDS`（默认 30s）一拍，读容器内的
`/proc/stat` `/proc/meminfo` `/proc/loadavg` `/proc/uptime` + `fs.statfsSync(各配置路径)` +
Docker `/containers/json`，然后 ① 把这一拍留在**进程内**（给卡片）② 一个事务写
`system_metrics` + `system_metrics_disks`（给历史曲线）。读面只有一个：
`GET /api/admin/system/metrics`（admin only）。采样器**只在 `serve` 里起**，`createServer`（测试/e2e 用）不起它。

## 2. 保留期与清理节拍

- **保留多久**：`SYSTEM_METRICS_RETENTION_DAYS`，默认 **30 天**（合法区间 1–365；越界值 `console.warn` 后
  **回落默认**，不是夹到边界）。
- **多久清一次**：**每小时一次**——挂在 `internal.js` reaper 已有的**小时级清理槽**上（与幂等键过期清理同一个槽），
  一小时一个事务。**不单独起循环**，也不按采样拍清。
- **怎么清**：`purgeSystemMetrics()` 一句
  `DELETE FROM system_metrics WHERE sampled_at < now() - make_interval(days => $1) AND sampled_at < (SELECT MAX(sampled_at) …)`；
  磁盘行不单独清，靠 `system_metrics_disks` 的 `ON DELETE CASCADE` 跟着走。
  尾句是**保住最新一拍**：采样器停很久再启动时，「now() − 30d」可能已经晚于库里唯一那批旧行，全删会让历史图彻底空白。
- **`ENABLED=0` 时照清**：采样停了但旧行还得按保留期缩，否则「关掉采样」反而让表永远堆在那儿。
- **清理失败只 warn**：历史图少清一小时不弄坑任何东西，reaper 的主职（租约回收）不许被它拖住。
- **膨胀量级**：30s 拍频 ⇒ 一天 2,880 行主表行、30 天 86,400 行（磁盘行 = 拍数 × 已监控文件系统数）。
  想减一半体积就调大拍频，这是唯一旋钮；不需要分区，也不需要汇总层。
- 看当前占用（共享 dev 栈，一律只读）：

  ```bash
  docker exec station-db psql -U station -d station -At -F'|' -c \
    "SELECT (SELECT count(*) FROM system_metrics),
            (SELECT count(*) FROM system_metrics_disks),
            pg_size_pretty((SELECT pg_total_relation_size('system_metrics')))"
  ```

## 3. 怎么关（应急刹车）

写库出问题（DB 快满 / 写放大 / 磁盘 IO 飙）或手工复测空闲负载基线（`docs/ops/db-idle-load.md`）时，
一条 env 停掉，不用改代码发版：

```yaml
# deploy/docker-compose.yml → station-portal → environment
      SYSTEM_METRICS_ENABLED: "0"
```

然后 **重建/重启 portal 容器**（`docker compose up -d --force-recreate station-portal`）——
env 只在进程启动时读一次，改文件不重启是不生效的。

关掉之后会看到什么：

- 采样器**不建定时器**：一个字节都不写库，也不拖住关停。
- `GET /api/admin/system/metrics` **仍然 200**，`latest: null`、`series` 是空点数组、`seriesError: null`。
- 管理台「系统」页据此显示「**采样已关闭**」（不是错误页、不是 500）。⚠ 前端那一页是**下一单**（#650 本轮只交后端），
  在此之前这个降级形状只在 API 响应里成立（`latest: null` 而不是 500）。
- 保留期清理照旧在跑（见 §2）。
- 恢复：把值改回 `1`（或删掉这一行，默认就是开）再重建容器。

⚠ **这个开关只认严格的 `0` / `1`**。写成 `"false"` / `"no"` / `"0 "` 会 `console.warn` 一条然后
**按默认（开）**处理——这是刻意的：应急刹车最怕「运维以为关了、实际没关」，所以拿拼写错误当开关是被禁止的。
重启后请在 portal 日志里确认没有那条 warn，才算真的关掉了。

## 4. 读数口径：为什么卡片可能是 N 秒前的数

同一个响应里有两个读数，来自**同一个采样器**，但取法不同：

| 字段 | 来源 | 新鲜度 |
|---|---|---|
| `latest` | **进程内最新一拍**（内存副本，不回 DB） | 最多落后一个采样周期（默认 30s）；`sampled_at` 就是它的时刻 |
| `series` | **DB 里已落库的行**，服务端按 `range` 分桶 | 落后一个采样周期 **+ 最多 5s 缓存**（`SERIES_CACHE_TTL_MS`，与前端 5s 轮询对齐） |

- **卡片显示的是 `latest.sampled_at` 那一拍**，所以它天然是「N 秒前」而不是「此刻」——这是设计，不是 bug。
  页面必须把 `sampled_at` 露出来（人看到「CPU 93%」的第一反应是「什么时候的」）。
- `latest` 与 `series` 的最后一个点**可以不一致**（新拍已在内存但还没进 5s 缓存的分桶结果）。别拿它们做相等断言。
- 卡片可能是 `null`：采样器没跑（§3）或还没第一拍。`latest` 里单个字段 `null` = **读不到**，
  不是 0（`containers: null` = docker 不可达，不是「0 个容器」）。
- `latest.diskUnreadable[]` 非空 = env 里配了但 `statfs` 失败的路径（带 `reason`）。它们**不落库**，
  所以不会出现在历史曲线里；看到它就去看路径在容器内到底存不存在。
- `containers.drift`（`onlyDb` / `onlyDocker` / `count`）是「DB 台账 ↔ Docker 实况」的对账，
  `count > 0` 时先去看 FDE 生命周期，不要去怀疑采样器。
- 图上的点是分桶值：`cpuAvg`/`cpuMax` 是桶内平均与峰值，`samples` 是这个桶聚合了几行原始点。
  只有 1 个点的桶要在页面上说清粒度，否则「30 天里 CPU 峰值 99%」会被当成连续高负载。

## 5. 加一块盘要改哪里（两步，**同一次改动**）

容器看不见宿主的挂载表，能 `statfs` 的只有「容器内真实存在的路径」。所以加盘永远是**两处一起改**：

```yaml
# deploy/docker-compose.yml → station-portal
    volumes:
      # ① 把宿主目录只读挂进 portal 容器（ro 是硬要求：采样只读，不许给写权限）
      - /srv/data:/srv/data:ro
    environment:
      # ② 同一次改动里把容器内路径加进列表
      SYSTEM_METRICS_DISK_PATHS: "/,/srv/data"
```

然后重建 portal 容器。漏掉任何一步的症状不同，都好认：

| 只做了 | 症状 |
|---|---|
| 只有 ①（挂了但没进 env） | 面板里没有这一行——它压根没被测 |
| 只有 ②（进了 env 但没挂） | `latest.diskUnreadable[]` 里出现它（`reason` 一般是 `ENOENT`），曲线里没有它 |

同一块盘上 bind 了多个路径时**只会出一行**（按设备去重，`path` 取最短那个）：这是刻意的——
同一个文件系统的 `statfs` 结果完全相同，按路径当键会出现「三行一模一样的 937G」。

## 6. 边界（这页不许被读成什么）

- **未挂进 portal 容器的盘不会自动出现**。加盘是运维动作（§5），不是自动发现。
- 面板只声明「**已监控 N 个文件系统**」，**不声称「宿主全部磁盘」**。N 的权威来源是 `latest.disk[]` 的行数
  （已按设备去重后的文件系统个数），而不是 env 里写了多少条：配了但测不到的那些在
  `latest.diskUnreadable[]` 里露面，不计进 N。
- 只存**原始点**，没有小时汇总层：30 天以外的历史在保留期之外，查不到就是查不到（要更长得改
  `SYSTEM_METRICS_RETENTION_DAYS`，见 §7 的复评判据）。
- 采样只读，零新挂载、零安全面改动：Docker 侧只用已在白名单里的 `/containers/json`；
  `stats`（1.02s/个）与 `/system/df`（15s）**不碰**——它们会把一拍的成本从毫秒级抬到秒级。
- 迁移 `0044` 已应用；`docs/data/schema.sql` 是冻结件（baseline 不回写增量）。

## 7. 为什么不用 Prometheus / Grafana（以及什么时候再谈）

本期要的是「管理台里有一页能看见宿主忙不忙」，代价上限是「零新容器、零新挂载、零新端口、零新安全面」。
Prometheus + Grafana 的方案要新增采集器与两个常驻服务、要开一条查询面、要在 Docker 白名单外开新读法，
而它要解决的问题（长期历史、多机聚合、告警路由）今天一个都不存在：单机、30 天足够、告警仍走平台自己的通知链。

**复评判据（命中任一条就来谈，没命中就别提前换）**：

1. **需要 > 30 天的历史**（例如要回答「上个月哪天开始变慢」）——本方案是固定保留期的滚动窗口，
   把 `SYSTEM_METRICS_RETENTION_DAYS` 拉到 365 只是缓解，代价是 12 倍的行数与全表扫式查询；
2. **需要多机聚合**（一个平台管多台宿主）——本方案的读数与宿主是 1:1 绑死的（进程内采样器 + 单库），
   没有 host 维度，跨机对比只能靠人开两个页面；
3. **需要告警**（阈值、静默、升级、值班路由）——本方案只有读数，没有任何判定与推送。
