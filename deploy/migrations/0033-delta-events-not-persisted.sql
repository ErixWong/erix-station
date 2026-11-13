-- 0033-delta-events-not-persisted.sql —— stream 档碎片不落库之后的存量清理 + 那一行的唯一键（issue #502）
--
-- 干什么（两件，都必须可重放）：
--   ① 建部分唯一索引 `run_events_run_partial_key (run_id) WHERE type = 'partial_output'`：
--      把「一个 run 至多一行 `partial_output`」从代码约定（`internal.js#insertPartialOutputRow` 的
--      `client_event_id = <runId>:final:partial_output` + `ON CONFLICT DO NOTHING`）抬成**库面约束**。
--      形状照既有先例 `run_events_run_end_key`（`docs/data/schema.sql:371-372`，同一个 run 至多一条
--      终态事件），不新造第三种写法。为什么必须唯一：补发侧（`http.js#buildPartialSnapshotFrames`）与
--      历史合成项（`http.js#aggregatePartialOutputs`）都按「至多一行」取数，两行就会让**同一个 run
--      在界面上出两条正文**——正是 #300 从头就在防的那件事。
--   ② 分批清存量碎片：`assistant_delta` / `reasoning_delta` / `tool_call_delta` 三类共 877,155 行
--      （dev 实测：884,163 行里占 99.2 %，472 MB 表体的 99 % 在这里）。清完表体与五个索引一起缩。
--
-- ⚠ 名单与写入侧同源，但**这里只能手抄**：迁移文件跑在 SQL 里，读不到 JS 的 `EVENT_TIERS`。
--   所以这三串在本文件里出现两次（谓词 + 观测），而 `portal/test/migrations.test.js` 钉住
--   「代码里的写入侧判据仍来自 `eventTierOf`」——漂移方向只有一个：引擎新增 stream 档类型时
--   本站写入侧自动拦住（不落库），而这里少清一类**历史存量**（历史存量本来就只可能有这三类，
--   新类型不会出现在旧数据里）⇒ 漏清不会发生，写错才会。
--
-- 为什么 VACUUM **不在**本文件里（硬约束，不是风格）：迁移 runner 是**单事务**执行每个文件
--   （`portal/src/migrate.js` BEGIN → 执行 → 落 schema_migrations → COMMIT），而 PG 的 `VACUUM`
--   **不能跑在事务块里**（`VACUUM cannot run inside a transaction block`，25001）⇒ 写进来就是
--   整个迁移失败、portal 拒绝启动。磁盘回收留在部署文档（`docs/data/model.md` 的 #502 小节）：
--   删完只是把页变成死页，文件不缩；不 VACUUM FULL 就看不到 `pg_total_relation_size` 掉下来。
--   实测差值（迁移 + VACUUM 前后）见 §8.125 与 `portal/test/delta-not-persisted-db.test.js` 的体积闸。
--
-- 关于「顺手少建几个索引 / 换个键」（issue 的 B 与 C）：**本单全部保留、不换键**，理由写在这里而不是
--   等下一个人重新发现一遍：
--     * B（`run_events` 的 5 个索引）：删索引只在**写入路径**换收益，而 #502 之后写入量已经是每轮
--       几条而不是每轮几百条 ⇒ 写入侧收益跟着消失，留下的是读侧真用得到的形状
--       （`(session_id, seq)` 补发、`(run_id, seq)` 历史与聚合、`session_id INCLUDE` 覆盖）。
--       索引体量的问题由「行数 ×0.8%」解决，不需要动形状。
--     * C（`client_event_id` 前缀里重复了 `run_id` 的文本）：换键要动 U3 协议与 runner 的编号生成
--       （`runner/worker.js:193`），而 #502 的 D-12 明写「runner→portal 批量协议不在本单」。
--       省下的字节数在 560 B/行的量级里是个位数百分比，代价是一次跨组件协议变更 ⇒ 不换。
--     * 清理后的实测数（表体/索引体/每行字节/碎片占比）见 §8.125 ⇒ 谁要重开 B/C，先看那份数。
--
-- 分批的**真实**收益（别把它写成银弹）：单事务下分批**不**缩短事务，也不减少累计持有的行锁；
--   它把**每条语句**的时长与 `lock_timeout` 等待窗口切小，让并发写侧最多等一批的时间。
--   真库若要在维护窗外跑，就照本文件的谓词手工分批提交（脚本见 §8.125），本文件保证第二遍 0 行。
--
-- 约定：本文件自己不写 BEGIN/COMMIT（runner 负责）。`SET LOCAL` 的两个超时同样只作用在本次事务：
--   * `lock_timeout = '5s'`：拿不到锁就该放弃整次迁移（可重放），不要排长队把读侧一起堵住（照 0016/0032）；
--   * `statement_timeout = '20min'`：**必须给得宽**——plpgsql 的 `DO` 块是**一条语句**，
--     PG 的 statement_timeout 按顶层语句计时、块内不会重置 ⇒ 把它调成几十秒就是「分批反而必炸」，
--     这颗雷写在 `portal/test/delta-not-persisted-db.test.js` 的注释里。
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20min';

-- ① 那一行的唯一键（先建索引再清碎片：清完之后任何时刻都不允许出现「同一 run 两行」的窗口）。
--    `IF NOT EXISTS` ⇒ 第二遍重放是零 DDL 空操作（README「单文件约定」）。
CREATE UNIQUE INDEX IF NOT EXISTS run_events_run_partial_key
  ON run_events (run_id) WHERE type = 'partial_output';

-- ② 分批清存量。可重放（第二遍 0 行、rc=0）、每批 ≤ 5000 行、只锁自己删的行。
DO $$
DECLARE
  v_batch constant int := 5000;
  v_ids tid[];
  v_deleted bigint := 0;
  v_rounds int := 0;
  v_t0 timestamptz := clock_timestamp();
BEGIN
  LOOP
    -- 独立语句拿 ctid + 行锁（不是嵌在 DELETE 的子查询里：PG 不允许数据修改语句带锁子句），
    -- `SKIP LOCKED` ⇒ 并发写侧正在碰的行**跳过**，下一批再拿（清存量永远排在别人后面）。
    SELECT array_agg(ctid) INTO v_ids
      FROM (
        SELECT ctid FROM run_events
         WHERE type IN ('assistant_delta', 'reasoning_delta', 'tool_call_delta')
         ORDER BY ctid
           FOR UPDATE SKIP LOCKED
         LIMIT v_batch
      ) b;

    EXIT WHEN v_ids IS NULL OR cardinality(v_ids) = 0;

    DELETE FROM run_events WHERE ctid = ANY (v_ids);
    v_deleted := v_deleted + cardinality(v_ids);
    v_rounds := v_rounds + 1;
    -- 每 20 批报一次进度：真库跑到一半时，运维要能看出它在动，而不是「迁移卡住了」
    IF v_rounds % 20 = 0 THEN
      RAISE NOTICE '0032/0033 清碎片进行中：已删 % 行（% 批，% ms）',
        v_deleted, v_rounds,
        round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::bigint;
    END IF;
  END LOOP;

  IF v_deleted = 0 THEN
    RAISE NOTICE '0033: 碎片存量为 0（第二遍重放就是这一行）—— 表里已无 stream 档行';
  ELSE
    RAISE NOTICE '0033: 清掉 stream 档碎片 % 行（% 批，% ms）；磁盘回收要另外跑 VACUUM（不能进迁移文件，见头注释）',
      v_deleted, v_rounds,
      round(extract(epoch from (clock_timestamp() - v_t0)) * 1000)::bigint;
  END IF;

  -- 观测（纯读）：清完之后三类必须归零，且那一行的唯一键必须已经存在。
  PERFORM 1 FROM run_events WHERE type IN ('assistant_delta', 'reasoning_delta', 'tool_call_delta') LIMIT 1;
  IF FOUND THEN
    RAISE WARNING '0033: 清完之后仍量到碎片行 —— 有并发写方仍在上报 stream 档（部署顺序：先上代码再跑迁移）';
  END IF;
  IF to_regclass('public.run_events_run_partial_key') IS NULL THEN
    RAISE WARNING '0033: partial_output 唯一键没建成 —— 补发侧的「至多一行」前提不成立';
  END IF;
END
$$;
