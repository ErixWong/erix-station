-- 0036-upload-settings.sql —— 单文件上传上限进管理台（issue #485 片 A / 工单 fix-261116-04，2026-11-16）
--
-- 背景：#472 片 B 的上传只有**一条**限额 `FILE_UPLOAD_MAX_BYTES`（默认 32 MiB），而它是**启动期 env**：
--   改一个数字要改 `deploy/.env` + 重建 station-portal 容器，管理台既看不见也改不了。
--   片 A 把它搬进 DB：`upload_settings` 单行表 + 管理台可设 + **每次上传现读**（改完立即生效，不重启）。
--
-- 为什么落 DB 而不是继续 env：这是**运维日常要调的东西**（一批素材传不进来就要问"上限是多少"），
--   与 `mail_settings`（迁移 0026）同一形状、同一决策口径——照先例做，不发明第二套。
--   env **不删**：它降级成「DB 没值/读失败时的兜底」，运维仍可在不碰数据库的情况下压住上限（急停口径
--   与 `mail-provider` 的 killSwitch 同源）。优先级 `DB > env > 默认 32 MiB`，见 `portal/src/upload-settings.js`。
--
-- 为什么是**新表**而不是往 `mail_settings` 里塞一列：两张表的**变更原因不同**（邮件通道 vs 文件面），
--   混在一行里会让「改上传上限」的审计与「改 SMTP」的审计互相污染，且 0026 的跨列 CHECK 会跟着变复杂。
--
-- 单行：`id int PRIMARY KEY DEFAULT 1 CHECK (id = 1)` —— 与 0026 同一手法，把「只能有一行」写成 **DB 事实**。
--   两行配置 = 谁生效取决于 ORDER BY，那是不可调试的形态。
--
-- 类型选 `bigint` 而不是 `int`：`int` 的上限 2,147,483,647 字节 ≈ 2 GiB，而管理台的天花板是 1 GiB——
--   今天够用，但「把上限提到 4 GiB」这件事不该需要一次 DDL 迁移。⚠ 代价：node-pg 把 int8 回成**字符串**
--   （不是 JS number），所以读侧统一 `::text` + 严格解析（`/^[0-9]+$/` + `Number.isSafeInteger`），
--   绝不 `Number(row.max_file_bytes)` 了事——`Number('1e7') === 10000000`、`parseInt('1e4') === 1`
--   这一族（台账 §8.126 附近）就是"半个值静默生效"的标准形态。
--
-- CHECK 只写 `> 0`，**不写管理台那个区间**（1 MiB–1 GiB）——这是有意的分层，不是漏了：
--   * 物理上荒谬（0 / 负数）由 DB 挡在门外（写进去就炸，比读的时候才发现便宜）；
--   * 产品区间是**策略**，由写侧 `PUT /api/admin/upload/settings` 挡（改天花板 = 改常量，不用 DDL）；
--   * 读侧仍要能面对一个"存在但不合法"的行（#485 的判据要求「DB 值非法 ⇒ 回落 env，不是 500」）。
--     若把区间写成 CHECK，那条回落路径在真机上**根本进不去**（UPDATE 会被 CHECK 拒），判据就只剩单测。
--   `updated_by` 是 uuid 但**不建 FK**（与 0026 同口径）：管理员行被停用/删除后配置要留着。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：只有 `CREATE TABLE IF NOT EXISTS`，
--   第二遍是零 DDL 空操作；末尾 DO 块**只读**，打印重放证据（无行也是正常态 ⇒ NOTICE，不是 EXCEPTION）。

CREATE TABLE IF NOT EXISTS upload_settings (
  id              int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 单文件上限（字节）。`> 0` 是 DB 事实；产品区间 1 MiB–1 GiB 由写侧校验（见头注释）。
  max_file_bytes  bigint NOT NULL CHECK (max_file_bytes > 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid
);

-- 重放证据（只读）：打印当前行数与生效值。无行 = 未配置 = 回落 env/默认，是上线时的默认形态。
DO $$
DECLARE
  row_count bigint;
  effective bigint;
BEGIN
  SELECT count(*) INTO row_count FROM upload_settings;
  SELECT max_file_bytes INTO effective FROM upload_settings WHERE id = 1;
  IF effective IS NULL THEN
    RAISE NOTICE '0036: upload_settings 行数=%（无行 = 未配置，单文件上限回落 FILE_UPLOAD_MAX_BYTES / 默认 33554432）',
      row_count;
  ELSE
    RAISE NOTICE '0036: upload_settings 行数=%，max_file_bytes=%（生效值以 portal 读侧为准）',
      row_count, effective;
  END IF;
END $$;
