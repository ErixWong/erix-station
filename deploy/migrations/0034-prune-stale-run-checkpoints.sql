-- 0034-prune-stale-run-checkpoints.sql —— `run_checkpoints` 的存量清理（issue #502 的遗留账，**纯清理：只有 DELETE，零 DDL**）
--
-- 干什么（只有一件，且必须可重放）：分批删掉两类**永不再被读**的快照行——
--   (a) **run 作用域**（`transcript_key IS NULL`）且那个 run 已终态（`runs.status IN ('finished','failed')`）；
--   (b) **session 作用域**（`transcript_key IS NOT NULL`）且那个会话已经不活跃
--       （`chat_sessions.status <> 'active'` **或** 该会话 14 天没有任何写入）。
--   每批 ≤ 2000 行、只锁自己要删的行（`ctid` + `FOR UPDATE SKIP LOCKED`）。本文件**不新增也不删除任何索引、不加列**。
--
-- 为什么清（dev 真库 `station` 2026-11-14 只读现查，不是估算；活库读数会随写入漂移，量法照抄即可）：
--   · 表 87 行 / `pg_total_relation_size` = **4,644,864 B**，其中 heap 只有 **81,920 B**、索引 **32,768 B**
--     ⇒ **体积几乎全在 TOAST**：`snapshot` 是 JSONB，一整份引擎 run snapshot 就是几十 KB 到几百 KB，
--       87 行的表能长到 4.4 MB，账从来不在行数上（同一张表 `pg_stat_user_tables` 的累计计数
--       `n_tup_upd + n_tup_hot_upd = 5,924`
--       vs 87 个活行 ⇒ 写放大 ~68 倍）。
--   · 写侧是 **revision-gated 覆盖写**：`putCheckpoint`（`portal/src/internal.js:1504`，UPSERT 在 `:1517`）与
--     `putSessionCheckpoint`（`:1704`，UPSERT 在 `:1717`）都是 `ON CONFLICT … DO UPDATE …
--     WHERE run_checkpoints.revision < EXCLUDED.revision` ⇒ 每覆盖一次就把上一整版 JSONB 变成
--     **死 TOAST 链**（VACUUM 之前页不回收）。
--     ⇒ 所以「清行」和「回收磁盘」是两件事，见下面 VACUUM 那一段。
--   · 按 (a)+(b) 两条谓词量命中：**70/87 行、`length(snapshot::text)` 合计 3,048,055 B**
--     （占活快照文本 4,027,120 B 的 76 %）—— 拆开是 (a) 14 行 / 304,496 B、(b) 56 行 / 2,743,559 B。
--     剩下 17 行属于活跃会话（≈ 979 KB），本文件一行都不碰。
--
-- 留什么（**只留这一类**）：活跃会话每个 `transcript_key` 的那一行。读路径总共两条，删错的代价就是「会话丢快照」：
--   · `getSessionLatestCheckpoint`（`portal/src/internal.js:1732`，读 SQL 在 `:1738`：`WHERE transcript_key = $1`）是
--     **会话级**的：同一个会话里的**下一个新 run** 会读上一个 run 留下的那一行 ⇒ **活跃会话那 17 行必须留**。
--   · `getLatestCheckpoint`（`:1531`）按 run 读，终态 run 也**允许**读（`:1533` 只对非终态要求 claim token），
--     但**没有任何调用者会为终态 run 去读**：快照的唯一用途是接力一个没跑完的 run ——
--     erix-agent `docs/host-consumer-contract.md:2250-2259` 把它钉成 latest-only autosave，
--     「used only to resume a crashed run」，且本身是 **optional** 能力，缺席的语义是
--     「snapshot persistence skipped; run completes normally, no mid-flight crash resume」。
--     run 已终态 ⇒ 不会再有 attempt 去读它 ⇒ 那一行是纯死重。
--   · 现役 runner 其实**只走 session 端点**（`runner/lib/store.js:20-21`：`saveRunSnapshot`/
--     `loadLatestRunSnapshot` → `PUT|GET /transcript/:key/checkpoint`），run 作用域的 U8/U9 只是
--     旧 runner / 旧 agentd 的兼容面 ⇒ (a) 删的是旧形态留下的死行，不碰现役通路。
--   · **没被删的东西要说清**：会话账本 `transcript_rounds` 一行都不动（那才是对话历史）。
--     快照丢了最坏是「冷启动一次」，不是丢历史——这是本单能存在的根理由。
--
-- 为什么保留窗口是 14 天（本单选的值，不是量出来的常数）：
--   · 判据用 **`chat_sessions.updated_at`**，它的语义不是「多久没写快照」而是「**会话本身多久没动**」：
--     `allocSeq`（`portal/src/seq.js:8`，被 `internal.js:927` 的 U3 写循环**逐条入库事件**调用）与
--     用户发送（`sessions.js:583`）都会 `updated_at = now()`，改标题/归档同样 bump（`sessions.js:480/:504`）
--     ⇒ 「14 天没动」= 这个会话 14 天内既没人说话也没跑过任何一轮，不是「今天恰好没写快照」。
--   · 代价有上界：一个 14 天没动的会话再来 run，丢的只是「崩溃接力」这一项 optional 能力（契约原话见上），
--     下一次 run 照常从 `transcript_rounds` 账本重建上下文。
--   · 为什么不能只按 `status <> 'active'` 清：归档是**用户动作**（`DELETE /api/sessions/:id` →
--     `sessions.js#archiveSession`，没有任何自动 reaper 会把 active 会话变 archived）⇒ dev 实测 73 个
--     session-keyed 行里**只有 3 行**够得着「已归档」，另有 **53 行**只能靠「>14 天未动」这一支清掉，
--     剩下 17 行是真活跃。只按 status 过滤 = 这支迁移基本白跑。
--   · 要改这个窗口就得**追加新迁移**：本文件一旦被应用，字节就被 runner 的 sha256 钉死
--     （`deploy/migrations/README.md`「已应用的迁移不得再修改」）。
--
-- 为什么要有 `v_cutoff`（**这是正确性，不是洁癖**）：
--   `DO` 块跑在 READ COMMITTED 里，**每条语句取一个新快照**，而 `now()` 整个事务里是**同一个值**（= 事务起始时刻）。
--   于是迁移执行期间完全可能出现「某个 run 刚刚终态 / 某个会话刚刚被归档」：
--     · 不钉 cutoff 的话，它会在**末尾残留检查**里被数成「没清干净的残留」⇒ `RAISE EXCEPTION` 误炸
--       （明明清完了，只是世界在迁移期间动了）；
--     · 钉了 cutoff 之后（删除谓词与残留检查**逐字共用同一个 `updated_at < v_cutoff`），本文件只对
--       「截止时刻那一刻的存量」做承诺，迁移期间新终态的行**留给下一次重放**（第二遍 0 行的口径也由此成立）。
--
-- 为什么 VACUUM **不在**本文件里（硬约束，不是风格，照 0033）：迁移 runner 是**单事务**执行每个文件
--   （`portal/src/migrate.js:312-319` BEGIN → 执行 → 落 `schema_migrations` → COMMIT），而 PG 的 `VACUUM`
--   **不能跑在事务块里**（`VACUUM cannot run inside a transaction block`，25001）⇒ 写进来就是整个迁移失败、
--   portal 拒绝启动。**磁盘回收是部署侧的下一步**：删完 70 行只是把页与 TOAST 变成死元组，
--   `pg_total_relation_size` 不会掉；要在部署后跑 `VACUUM (ANALYZE) run_checkpoints`（要真截断文件用
--   `VACUUM (FULL) run_checkpoints`，它持 AccessExclusiveLock，这张 4.4 MB 的表上是毫秒级）。
--   ⚠ TOAST 链的死元组同样要等 VACUUM 才回收（`run_checkpoints` 的 TOAST 表跟着主表一起 vacuum，无需单独处理）。
--   ⚠ **语句区（含 NOTICE 文案）里不出现 `VACUUM` 这个词**，是刻意的：`portal/test/migrations.test.js` 对
--     本文件的闸是「剥掉整行注释后，语句区任何位置都不许出现 VACUUM」——最严的那一条，代价只是这里的
--     NOTICE 要说「部署侧再做一次表整理」而不是直说 VACUUM。理由写在这一段，看排障记录的人来这儿找。
--
-- 分批的**真实**收益（别写成银弹，照 0033）：单事务下分批**不**缩短事务、也不减少累计持有的行锁；
--   它把**每条语句**的时长与 `lock_timeout` 等待窗口切小，让并发写侧最多等一批的时间。
--   `SKIP LOCKED` 让并发 writer 正握着的行**跳过**（清存量永远排在别人后面）；被跳过的行会被末尾残留
--   检查数到 ⇒ 迁移失败，**这是刻意的**：`RAISE EXCEPTION` 让整次迁移回滚、不落 `schema_migrations`，
--   重跑一遍即可（checkpoint 写入频率是「每轮/终态一次」量级，撞上的窗口极小，重放代价是 0 行）。
--
-- 约定：本文件自己不写 BEGIN/COMMIT（runner 负责）。`SET LOCAL` 的两个超时同样只作用在本次事务：
--   * `lock_timeout = '5s'`：拿不到锁就放弃整次迁移（可重放），不要排长队把读侧一起堵住（照 0016/0032/0033）；
--   * `statement_timeout = '20min'`：**必须给得宽**——plpgsql 的 `DO` 块是**一条语句**，
--     PG 按顶层语句计时、块内不会重置 ⇒ 把它调成几十秒就是「分批反而必炸」（同 0033 里那颗雷）。
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20min';

-- 分批清存量。可重放（第二遍 0 行、rc=0）、每批 ≤ 2000 行、只锁自己删的行。
DO $$
DECLARE
  -- 截止时刻：删除谓词与末尾残留检查**共用这一个值**（理由见文件头「为什么要有 v_cutoff」）。
  v_cutoff timestamptz := now();
  v_batch constant int := 2000;
  v_ids tid[];
  v_del_a bigint := 0;
  v_del_b bigint := 0;
  v_rounds int := 0;
  v_left_a bigint := 0;
  v_left_b bigint := 0;
  v_t0 timestamptz := clock_timestamp();
BEGIN
  -- (a) run 作用域 + run 已终态。`transcript_key IS NULL` 这条必须写死：
  --     session-keyed 行的 `run_id` 存的是**写它的那个 writer run**（`internal.js:1717` 的
  --     `VALUES ($1, $2, …)`，$1 = writerRunId；`run_checkpoints.run_id` 是 **NOT NULL 主键**
--     （`\d run_checkpoints` 真库现查），那个 run 十有八九也早已终态 ——
  --     少了这个条件就会把**活跃会话**的快照一起删掉（谓词 (b) 的「留活跃会话」当场作废）。
  LOOP
    -- 独立语句拿 ctid + 行锁（不是嵌在 DELETE 的子查询里：PG 不允许数据修改语句带锁子句），
    -- `SKIP LOCKED` ⇒ 并发 writer 正在碰的行**跳过**，下一批再拿（清存量永远排在别人后面）。
    SELECT array_agg(ctid) INTO v_ids
      FROM (
        SELECT ctid FROM run_checkpoints rc
         WHERE rc.transcript_key IS NULL
           AND rc.updated_at < v_cutoff
           AND rc.run_id IN (SELECT id FROM runs WHERE status IN ('finished', 'failed'))
         ORDER BY ctid
           FOR UPDATE SKIP LOCKED
         LIMIT v_batch
      ) b;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    DELETE FROM run_checkpoints WHERE ctid = ANY (v_ids);
    v_del_a := v_del_a + cardinality(v_ids);
    v_rounds := v_rounds + 1;
    IF v_rounds % 20 = 0 THEN
      RAISE NOTICE '0034 清快照进行中：(a) 已删 % 行 / (b) 已删 % 行（% 批，% ms）',
        v_del_a, v_del_b, v_rounds,
        round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::bigint;
    END IF;
  END LOOP;

  -- (b) session 作用域 + 会话已不活跃（已归档 **或** 14 天没动）。
  -- ⚠ `transcript_key::uuid` 的显式转换**不能省**：`chat_sessions.id` 是 uuid、`run_checkpoints.transcript_key`
  --   是 text（0006 加列时就是 text），直接写 `transcript_key IN (SELECT id …)` 报
  --   `operator does not exist: text = uuid`（本单真库现证；反过来写 `id IN (SELECT transcript_key …)` 报的是
  --   `uuid = text`——同一个原因的两个方向：两列分属 `pg_type.typcategory` 的 S 与 U 两大类且都不是 preferred
  --   ⇒ PG 不做隐式转换。闸在 `portal/test/prune-checkpoints-db.test.js`）。
  --   转换本身安全：`transcript_key` 只有经 `internal.js#fetchSession` 才可能落库，那句是
  --   `WHERE id = $1` ⇒ 参数被推成 uuid，不是合法 uuid 的 key 早在写入时就 22P02 了 ⇒ 列里现存值全是 uuid 文本
  --   （dev 现查 73 行全对得上 `chat_sessions.id`，无孤儿）。真到了一条非 uuid 的脏数据，这支迁移会
  --   **当场失败而不是静默漏清**（`invalid input syntax for type uuid`）——也是刻意的，同一份用例钉住了。
  LOOP
    SELECT array_agg(ctid) INTO v_ids
      FROM (
        SELECT ctid FROM run_checkpoints rc
         WHERE rc.transcript_key IS NOT NULL
           AND rc.updated_at < v_cutoff
           AND rc.transcript_key::uuid IN (
                 SELECT id FROM chat_sessions
                  WHERE status <> 'active' OR updated_at < now() - interval '14 days'
               )
         ORDER BY ctid
           FOR UPDATE SKIP LOCKED
         LIMIT v_batch
      ) b;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    DELETE FROM run_checkpoints WHERE ctid = ANY (v_ids);
    v_del_b := v_del_b + cardinality(v_ids);
    v_rounds := v_rounds + 1;
    IF v_rounds % 20 = 0 THEN
      RAISE NOTICE '0034 清快照进行中：(a) 已删 % 行 / (b) 已删 % 行（% 批，% ms）',
        v_del_a, v_del_b, v_rounds,
        round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::bigint;
    END IF;
  END LOOP;

  -- 残留检查：谓词与上面**逐字相同**（同一个 `v_cutoff`），仍量到行 ⇒ 迁移失败。
  -- **必须 EXCEPTION 而不是 WARNING**（同 0033）：带着残留记成功 = `schema_migrations` 里落下
  -- 「已清理」这一行，而表里还躺着几十 MB 永不再读的快照，下一个来看体积数据的人会当这支账已经落地。
  -- 量到残留的真实成因只有两个，都不是「迁移写错了」：
  --   ① 有并发 writer 正握着某行（`SKIP LOCKED` 跳过的）——重跑本文件即可；
  --   ② 谓词失配（被人改窄、或 `chat_sessions`/`runs` 的状态枚举漂移）——按下面的计数与谓词名去对代码。
  SELECT count(*) INTO v_left_a
    FROM run_checkpoints rc
   WHERE rc.transcript_key IS NULL
     AND rc.updated_at < v_cutoff
     AND rc.run_id IN (SELECT id FROM runs WHERE status IN ('finished', 'failed'));

  SELECT count(*) INTO v_left_b
    FROM run_checkpoints rc
   WHERE rc.transcript_key IS NOT NULL
     AND rc.updated_at < v_cutoff
     AND rc.transcript_key::uuid IN (
           SELECT id FROM chat_sessions
            WHERE status <> 'active' OR updated_at < now() - interval '14 days'
         );

  IF v_left_a <> 0 OR v_left_b <> 0 THEN
    RAISE EXCEPTION '0034: 截止时刻 % 之前的存量没清干净 —— 谓词 (a) 仍剩 % 行 / 谓词 (b) 仍剩 % 行。成因只有两种：有并发 writer 正握着这些行（SKIP LOCKED 跳过，重跑本文件即可），或清理谓词与 runs.status / chat_sessions 的现状失配（拿这两个数字去对 internal.js 的写入侧与 0034 的谓词）',
      v_cutoff, v_left_a, v_left_b;
  END IF;

  IF v_del_a = 0 AND v_del_b = 0 THEN
    RAISE NOTICE '0034: 没有可清的快照行（第二遍重放就是这一行）—— 截止时刻 % 之前既无终态 run 的 run 作用域快照，也无死会话的 session 快照',
      v_cutoff;
  ELSE
    RAISE NOTICE '0034: 清掉 run_checkpoints (a) run 作用域 % 行 + (b) 死会话 session 作用域 % 行（% 批，% ms）；磁盘没缩是正常的，表整理要在部署侧另外做（不能进迁移文件，理由见头注释）',
      v_del_a, v_del_b, v_rounds,
      round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::bigint;
  END IF;
END
$$;
