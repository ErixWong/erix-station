-- 0041-retire-run-checkpoints.sql —— 撤 `run_checkpoints`（issue #640，erix-agent 0.33.0 让整条竖切变成死代码）
--
-- 撤的是什么：erix-agent 0.14.0 那套 **run snapshot** 的落点（`docs/data/schema.sql` §8 建的表，
--   `0006-session-transcript.sql:31-33` 给它加了 session 侧的 `transcript_key` + 部分唯一索引，
--   `0034-prune-stale-run-checkpoints.sql` 清过一次存量）。写侧是 `TranscriptStore.saveRunSnapshot`，
--   读侧是 `loadLatestRunSnapshot`，经 agentd 转四个 internal 端点（U8/U9 run 作用域 + S3/S4 session 作用域）进来。
--
-- 为什么现在可以撤（两条判据都要成立，缺一就不撤；同 `0032` 的纪律）：
--   ① **引擎侧零调用**：erix-agent 0.33.0（上游 #838 S2，本站 #530）把 run snapshot 整个退役，
--      `grep -rn "saveRunSnapshot\|loadLatestRunSnapshot\|loadLatestCheckpoint" node_modules/erix-agent/src/`
--      ⇒ **零命中**；上游 `docs/host-upgrade-guide-0.33.0.md` §2.2 的口径是「这些方法引擎不再调用，
--      留着无害、删掉不报错」。恢复链路自 0.33.0 起只信账本（`orchestrator.js:3221`），
--      本站的账本 = `transcript_rounds` + `transcript_recovery_rows`（#500），两者本单**都不动**。
--   ② **旧 writer 已排空**：全部 5 台 FDE + dev portal 都在 station 0.1.72 / engine 0.33.0（主 agent
--      261117 现查容器读数），0.32/0.31 的旧 runner 一台都不在跑 ⇒ 撤表之后不会有人还在写它。
--   另有代码侧现查：本仓写侧（`runner/lib/store.js` + `runner/agentd.js`）与端点侧（`portal/src/http.js`
--   四个分支 + `portal/src/internal.js` 四个函数）已在同一单里删除（M1/M2），所以真库里这张表从此
--   零写零读。
--
-- 撤前的现查（主 agent 261117 只读跑，逐条实测不是推断）：
--   行数 / 大小      **17 行 / 565,248 B**（heap 8,192 + 索引 32,768 + TOAST 本体 507,904）
--   max(updated_at)  **2026-11-11 01:32:41+00** —— 0.33 上线（261115）之后再没写过一次
--   外键             `run_checkpoints_run_id_fkey`：`run_checkpoints.run_id → runs.id`，`confdeltype = a`
--                    ⇒ **本站是 child 端**，撤 child 不动 parent，也不会顶回「还有对象依赖它」
--   视图依赖 / 触发器 / 其它表引用本表：**0 / 0 / 无**
--   `schema_migrations` head：`0040-platform-prompts` ⇒ 本单取号 **0041**
--   ⇒ 撤前备份（17 行，成本可忽略）已落：`~/backups/run_checkpoints-pre-0041-261117-0937.sql.gz`。
--     这是**单向门**：此后要回那 17 行只能从这份 dump 恢复（`psql -1 -f`；每个部署自己先 dump 再撤，
--     别拿别人家的读数与备份当自己家的判据 —— 同 `0032` 头注释那条）。
--
-- 三条硬约束（不是风格问题，`portal/test/migrations.test.js` 有对应的机器锁）：
--   ① **`IF EXISTS` 必带**：全新库（baseline → 全部增量）里 `0006` 会先加列再被本文件撤掉，
--      但重放第二遍时表已经不在 ⇒ 裸 `DROP TABLE` 会让第二次迁移失败（幂等是 README「单文件约定」的硬要求）。
--   ② **不加 `CASCADE`**：现查零依赖，加了反而会在将来有视图/外键挂上来时**静默多撤**东西——
--      那比让事务回滚、去看清是谁挂着它更难查。真出现意外依赖就让它失败回滚，不绕过。
--   ③ **不跑 `VACUUM`**：runner 在单事务内执行本文件，`VACUUM` 不能在事务块里跑（同 `0033` / `0034` 的理由）。
--      ⚠ 撤表**释放磁盘靠 checkpoint + bgwriter**，`DROP TABLE` 本身要拿 ACCESS EXCLUSIVE，
--      所以下面 `SET LOCAL lock_timeout` 是必须的：拿不到锁就该放弃让这一轮迁移回滚，而不是排长队把读侧一起堵住。
--
-- 约定：runner 负责 `BEGIN → 执行 → 落 schema_migrations → COMMIT`（`deploy/migrations/README.md`），
--   所以本文件**自己不写** BEGIN/COMMIT；`SET LOCAL` 因此正好随本事务结束。
-- 不动的东西：
--   * `docs/data/schema.sql`（冻结 baseline，sha256 落库）里那句 `CREATE TABLE run_checkpoints`
--     **一个字节都不改** —— 新库照样「先按 baseline 建表，再由本迁移撤掉它」；
--   * `0006-session-transcript.sql` / `0034-prune-stale-run-checkpoints.sql` 同理不改（已应用迁移改一字节
--     = 现存库全部拒绝启动）。
SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS public.run_checkpoints;

-- 观测（**纯读**，可反复重放）：撤完之后这个名字必须量不到东西。
-- 还在 = 有本迁移没算到的对象挂着它（同名同义词、别的 schema），那是 WARNING 而不是静默通过。
DO $do$
BEGIN
  IF to_regclass('public.run_checkpoints') IS NOT NULL THEN
    RAISE WARNING '0041: DROP 之后 public.run_checkpoints 仍能量到 —— 有本迁移没算到的对象，请人工确认它是什么';
  ELSE
    RAISE NOTICE '0041: run_checkpoints 已撤（run snapshot 竖切随 erix-agent 0.33.0 退役，issue #640；第二遍重放也是这一行）';
  END IF;
END
$do$;
