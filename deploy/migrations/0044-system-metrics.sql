-- 0044-system-metrics.sql —— 宿主资源指标（CPU / 内存 / 磁盘 / 容器数）的时序落库（issue #650，工单 feat-261117-15）
--
-- 要治的是什么：管理台今天没有任何宿主资源读面——CPU / 内存 / 磁盘 / 容器数只能靠人 SSH 上机
--   `htop` + `docker ps`。出问题的症状是「FDE 变慢」，而**平台自己不知道宿主是不是快满了**。
--   这与 #586 那次版本分裂是同一个形状：真相存在，界面上一个读面都没有。
-- 架构（issue #650 决定 1–4）：DB 是历史真相（采样器每 N 秒落一行，图表只读 DB）；进程内只留
--   「最新一拍」给卡片；**只存原始点，查询时分桶**（不搞原始 + 小时汇总的双层表，那要两套写路径
--   加一个降采样 job）；零新挂载、零安全面改动（宿主指标读容器内 `/proc` + `fs.statfsSync`，
--   容器计数只用已在 Docker 白名单里的 `/containers/json`——`deploy/fde-proxy/server.js` 的 12 条
--   路径一条都不动，`stats`(1.02s/个) 与 `/system/df`(15s) 本单不碰）。
--
-- **`sampled_at` 当主键是对全局规范「主键一律 VARCHAR(32) 单层字符串」的显式偏离**（AGENTS §3.4 /
--   全局规范 §3.4）：时间序列表的自然键就是采样时刻，天然唯一、天然幂等（写侧靠
--   `ON CONFLICT (sampled_at) DO NOTHING` 重放），再加一个 `newId()` 只是每行 32 字节的死重量
--   （30 天基线 86,400 行 ⇒ 约 2.7 MB 纯索引死重）。理由全文见 `docs/data/model.md` §1.34。
--   ⚠ 待决策者确认（issue #650 已标注）。
--
-- `system_metrics_disks` 的主键是 **(sampled_at, device)**：一块物理盘（一个文件系统）= 一行。
--   同一块盘上 bind 了多个路径时 `statfs` 结果完全相同，写侧按设备去重（同设备取最短 path），
--   否则面板会出现「三行一模一样的 937G」。
--
-- 授权：`station_portal` 的 DML 由 baseline 的 `ALTER DEFAULT PRIVILEGES` 自动覆盖
--   （`deploy/migrations/README.md`「单文件约定」），本文件**不写 GRANT**。
--   baseline `docs/data/schema.sql` 冻结，零字节不动。
--
-- 幂等可重放（README 单文件约定）：两条 `CREATE TABLE IF NOT EXISTS`（第二遍是零 DDL 空操作）
--   + 一个**只读** DO 块打印重放证据。
SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS system_metrics (
  sampled_at          timestamptz PRIMARY KEY,   -- 自然键：时间序列表的采样时刻，天然幂等
  cpu_usage_pct       numeric(5,2)  NOT NULL,
  cpu_cores           smallint      NOT NULL,
  load1               numeric(8,3)  NOT NULL,
  load5               numeric(8,3)  NOT NULL,
  load15              numeric(8,3)  NOT NULL,
  mem_total_bytes     bigint NOT NULL,
  mem_used_bytes      bigint NOT NULL,
  mem_available_bytes bigint NOT NULL,
  mem_cached_bytes    bigint NOT NULL,
  swap_used_bytes     bigint NOT NULL,
  uptime_seconds      bigint NOT NULL,
  containers_total    integer NOT NULL,
  containers_running  integer NOT NULL,
  containers_station  integer NOT NULL,
  fde_total           integer NOT NULL,
  fde_running         integer NOT NULL,
  drift_count         integer NOT NULL,          -- DB 说 N 台 ↔ Docker 实际 M 台
  written_at          timestamptz NOT NULL       -- 应用侧写（§3.4：DDL 不写 DEFAULT now()）
);

CREATE TABLE IF NOT EXISTS system_metrics_disks (
  sampled_at  timestamptz NOT NULL REFERENCES system_metrics (sampled_at) ON DELETE CASCADE,
  device      text        NOT NULL,   -- /proc/mounts 的来源设备（bind mount 报宿主设备，实测）
  path        text        NOT NULL,   -- 容器内被 statfs 的路径（同设备多路径取最短那个）
  fs          text        NOT NULL,   -- ext4 / overlay / xfs …
  total_bytes bigint      NOT NULL,
  used_bytes  bigint      NOT NULL,
  avail_bytes bigint      NOT NULL,
  PRIMARY KEY (sampled_at, device)    -- 一个物理盘（一个文件系统）= 一行
);

-- 只读重放证据：两张表都是新建即空表，第二遍跑本文件零 DDL、读数不变。
DO $$
DECLARE
  n_metrics bigint;
  n_disks bigint;
BEGIN
  SELECT count(*) INTO n_metrics FROM system_metrics;
  SELECT count(*) INTO n_disks FROM system_metrics_disks;
  RAISE NOTICE '0044: system_metrics=% 行 / system_metrics_disks=% 行（新建即空表，全 0 是正常态）',
    n_metrics, n_disks;
END
$$;
