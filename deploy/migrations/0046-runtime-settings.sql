-- 0046-runtime-settings.sql —— 运行时配置底座 `runtime_settings`
--
-- 出处：issue #677 P1（工单 feat-261119-01，2026-11-19）。
-- **这一支只建底座，一格真实旋钮都不迁**（逐批迁旋钮是 P3 的事）。
--
-- 背景（#677 的病灶；实测读数在 `portal/test/deploy-env-bootstrap.test.js` 的头注释里）：
--   `station-portal.environment` 攒到 70 条，其中只有 10 条是「容器起来之前就必须知道」的值，
--   其余是功能旋钮 —— 改一个数字要改 `deploy/.env` + 重建容器，管理台既看不见也改不了。
--   P5 已把 compose 冻成「存量只许变小」；P1 提供的是**搬家的目的地**：一张 key-value 表
--   + 读写侧模块（`portal/src/runtime-settings.js`）+ `serve()` 的覆盖层接线。
--
-- 为什么是 key-value（`key text / value jsonb`）而不是「单行多列」
--   （`upload_settings` 0036、`platform_prompts` 0043 那张）：
--   P3 要**一批批**加旋钮。多列表每加一格都要一次 DDL（一次重放风险 + 一行新的 checksum 账），
--   而 key-value 加一格 = 一次 `INSERT`（零 DDL）。
--   代价也写在明处：值类型从「列类型」退化成 `jsonb` ⇒ 类型纪律从 DB 搬到代码两侧，
--   于是「写侧只收 JSON 标量 + 读侧严格解析」这两条硬口径成了承重墙（见模块头注释）。
--
-- 为什么不种首行（与 0043 的口径**刻意不同**，不是漏了）：
--   0043 那张是单行表，两个并发首写在空表上锁不到任何行 ⇒ `ON CONFLICT DO UPDATE`
--   覆盖整行 = 丢更新，所以它必须种。本表按 key 分行，`ON CONFLICT (key)` 自带仲裁：
--   同一 key 的并发第二写会等行锁再走 `DO UPDATE` ⇒ **生效值不丢**
--   （last-write-wins 是并发保存同一格的固有语义，不是本表新引入的洞）。
--
-- CHECK 只写 key 的形状，**不写任何值域**（有意的分层，与 0036 同一决策）：
--   * key 形状 `^[a-z][a-z0-9_.]{2,63}$` 是**结构性**事实：拼错的 key 会静默多出一行
--     永不生效的配置 —— 读侧只按 registry 里的 key 去取，拼错的行没有任何报错面，
--     只能靠 DB 挡在门外（写进去就炸，比事后考古便宜）。
--   * 值域是**策略**，由写侧（registry 条目的 `validate`）挡。写进 DB CHECK 的话，
--     「DB 有一行但值非法 ⇒ 读侧回落 env」这条判据在真机上根本进不去（手工 `UPDATE`
--     会被 CHECK 拒），判据就只剩单测 —— 0036 的头注释把这条账算过一遍，这里照抄。
--   * `updated_by` 是 uuid 但**不建 FK**（照 0026/0036/0043）：管理员被停用/删除后配置要留着。
--
-- 已知残留（P1 记账，不藏）：**同一 key 的首次并发写**（表里还没有那一行）里，两条语句的
--   `prev` CTE 各取自己进来之前的快照 ⇒ 两条都可能把 `previous_value` 记成 `null`，
--   而库里最终值是其中一条的写入。生效值不受影响，只有那一次的「谁把谁改成了谁」少一段。
--   收掉它要给 key 加 advisory lock（0043 那种「种首行」在这里做不到：P1 没有真实 key）。
--   P3 若某格要求严格历史，就在 registry 条目上显式加锁，别回头改这张表。
--
-- 单文件约定（`deploy/migrations/README.md`）：幂等可整体重放（只有
--   `CREATE TABLE IF NOT EXISTS` + 守卫式 `ADD CONSTRAINT`）、**自己不写 `BEGIN/COMMIT`**
--   （事务边界归 runner）、`SET lock_timeout` 照 0016 的纪律；末尾 DO 块**只读**，
--   打印重放证据（0 行是正常态 ⇒ NOTICE，不是 EXCEPTION）。

SET lock_timeout = '5s';
SET statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS runtime_settings (
  -- 旋钮的稳定标识 = registry 的 key（例 `demo.limit`）。值的分层理由见文件头。
  key         text PRIMARY KEY,
  -- 值。jsonb 而不是 text：读侧要的是「它是个 JSON 标量」这个类型事实（写侧只收
  -- number/boolean/string）。手工 `UPDATE` 写成对象/数组 ⇒ 读侧判为非法并回落，
  -- 而不是靠字符串去猜类型（`Number('1e4')` 那一族，台账 §8.126）。
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid
);

-- key 形状的 DB 事实。`ADD CONSTRAINT` 没有 IF NOT EXISTS ⇒ 用 DO 守卫，
-- 第二遍重放走进 IF 的假支 = 零 DDL 空操作。
DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'runtime_settings'::regclass
       AND conname = 'runtime_settings_key_shape'
  ) THEN
    ALTER TABLE runtime_settings
      ADD CONSTRAINT runtime_settings_key_shape
      CHECK (key ~ '^[a-z][a-z0-9_.]{2,63}$');
  END IF;
END $do$;

-- 重放证据（只读）：0 行 = 底座建好而一格未配 = P1 上线时的默认形态，不是异常。
DO $do$
DECLARE
  row_count bigint;
BEGIN
  SELECT count(*) INTO row_count FROM runtime_settings;
  RAISE NOTICE '0046: runtime_settings 行数=%（0 行 = 未配置任何旋钮，读侧全走 env/默认）',
    row_count;
END $do$;
