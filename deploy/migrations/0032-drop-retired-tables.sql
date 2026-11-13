-- 0032-drop-retired-tables.sql —— 撤三张退役/备份表（issue #503 / 工单 fix-261113-01）
--
-- 撤的是哪三张（来历逐个现查，不凭印象）：
--   `llm_models_retired`     = 0002-llm-config.sql:29 建为 `llm_models` → 0010-litellm-bindings.sql:27 RENAME 保留
--   `llm_providers_retired`  = 0002-llm-config.sql:19 建为 `llm_providers` → 0010:26 RENAME 保留
--   `transcript_rounds_shape4_bak_20261027` = **不在任何迁移文件里**：2026-10-27 那次 shape4 修数据时手工建的
--                              备份夹具（建表语句与当天取证见 docs/ops/transcript-ledger-inspection.md §7.3/§7.4）
--                              ⇒ **全新库（baseline → 全部增量）里根本没有这张表**，这一点直接决定下面第 ① 条约束。
--
-- 为什么现在可以撤（两条判据都要成立，缺一就不撤）：
--   ① 代码零引用：`grep -rn "llm_providers_retired\|llm_models_retired\|shape4_bak" portal runner scripts`
--      ⇒ 生产代码零命中（唯一命中是 portal/test/migrations.test.js 里断言 **0010 那个文件的文本** 的两条，
--        它断言的是迁移文本、不是库里的表，0010 字节不变 ⇒ 撤表后照样成立）。
--   ② DB 侧零访问：PG 自己记的访问账停在 0010 改名那天，此后无人查询（dev 实测）——
--        llm_models_retired     last_idx_scan = 2026-10-03 09:53
--        llm_providers_retired  last_idx_scan = 2026-10-03 09:52
--      ⚠ 统计视图是**每库自己的**，别拿别台机器的读数当自己家的判据 ⇒ **每个部署撤前自己跑一遍**：
--        select relname, seq_scan, idx_scan, last_seq_scan, last_idx_scan
--          from pg_stat_user_tables
--         where relname in ('llm_providers_retired','llm_models_retired','transcript_rounds_shape4_bak_20261027');
--      ⚠ 读数的坑：`pg_stat_reset()` 会把它们清成 NULL ⇒「全 NULL」有两种读法（真没人查 / 账被清过），
--        分不清就当成有人查过：先 dump 再撤，别赌。
--
-- 单向门（撤之前要想清楚的那件事）：撤掉之后「重放 0010 那条 RENAME 把旧目录要回来」这条路**不再可用**——
--   供应商行、模型目录行、以及 shape4 那次的 `record_before` 原件，此后**只能从 dump 恢复**。
--   ⇒ **撤前必须 pg_dump 这三张表并落到部署记录**（表名保持原名，恢复时 `psql -1 -f` 回去即可）：
--     pg_dump -t llm_models_retired -t llm_providers_retired -t transcript_rounds_shape4_bak_20261027 <db> \
--       > <部署记录目录>/pre-0032-retired-tables.sql
--
-- 三条会炸的硬约束（不是风格问题，每条都有对应的机器锁，见 portal/test/migrations.test.js）：
--   ① **三句全带 `IF EXISTS`**：第三张表不在任何迁移里，全新库里没有它 ⇒ 写成裸 `DROP TABLE`
--      会让**新库首次起栈就炸**（`MIGRATE_ON_START=1`，portal 在监听端口前应用 ⇒ 整个 portal 起不来）。
--      唯一的证明闸是真库跑一遍 `portal/test/migrate-fresh-db.test.js`（静态断言看不出「库里没有这张表」）。
--   ② **顺序**：`llm_models_retired` 必须排在 `llm_providers_retired` **之前**。现查依据是这条外键
--      `llm_models_provider_id_fkey`（child `llm_models_retired`.provider_id → parent `llm_providers_retired`.id，
--      由 0002:31 的 `REFERENCES` 自动命名；0010 只 RENAME 了表，**PG 不会连带重命名约束**）
--      ⇒ 先撤父表会被 PG 顶回来（`cannot drop table ... because other objects depend on it`，2BP01）。
--   ③ **不用 `CASCADE`**：顺序已经把这条依赖解决了；CASCADE 会把**没预料到的**依赖（后来挂上来的视图/外键）
--      一起带走，而本迁移只想撤这三张表——静默多撤东西，比顺序写错更难查。
--
-- 幂等（README「单文件约定」：本文件必须能整体重放）：`DROP TABLE IF EXISTS` ⇒ 第二遍是零 DDL 空操作，
--   不报错、不改任何东西（这一条不是形式：真库里在**已经撤过表**的库上再跑一遍本文件，rc 必须是 0）。
-- 约定：迁移 runner 在单事务内 BEGIN → 执行 → 落 schema_migrations → COMMIT（deploy/migrations/README.md），
--   所以本文件**自己不写** BEGIN/COMMIT。`SET lock_timeout` 照 0016 的纪律设：`DROP TABLE` 要拿 ACCESS EXCLUSIVE，
--   拿不到就该放弃而不是排长队把读侧一起堵住。
-- 不动的东西：`0010-litellm-bindings.sql` **一个字节都不改**（runner 对每个已应用迁移记 sha256，
--   改一字节 = 现存库全部拒绝启动），它的 `RENAME TO *_retired` 既不改也不删；
--   `docs/data/schema.sql`（冻结 baseline）本来就不含这三张表，本迁移也不回写它。
SET lock_timeout = '5s';

-- ① 先撤子表：它是外键 `llm_models_provider_id_fkey` 的 child 端。顺序不许换（头注释 ②）。
DROP TABLE IF EXISTS llm_models_retired;

-- ② 再撤父表：此刻已经没有任何对象依赖它。
DROP TABLE IF EXISTS llm_providers_retired;

-- ③ 手工备份夹具：全新库没有这张表 ⇒ `IF EXISTS` 就是本迁移能在全新库跑通的前提（头注释 ①）。
DROP TABLE IF EXISTS transcript_rounds_shape4_bak_20261027;

-- ④ 观测（**纯读**，可反复重放）：撤完之后三个名字都得量不到东西。
--    还在 = 有本次没算到的东西挂着它（同义词、别处的同名对象），所以是 WARNING 而不是静默通过。
DO $do$
DECLARE
  names text[] := ARRAY['llm_models_retired','llm_providers_retired','transcript_rounds_shape4_bak_20261027'];
  still text;
BEGIN
  SELECT string_agg(n, ', ' ORDER BY n) INTO still
    FROM unnest(names) AS n
   WHERE to_regclass(n) IS NOT NULL;

  IF still IS NULL THEN
    RAISE NOTICE '0032: 三张退役/备份表都已不在（第二遍重放也是这一行）';
  ELSE
    RAISE WARNING '0032: 撤完后仍能量到 % —— 有本迁移没算到的对象，请人工确认它是什么', still;
  END IF;
END
$do$;
