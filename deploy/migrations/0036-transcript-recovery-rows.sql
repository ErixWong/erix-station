-- 0036-transcript-recovery-rows.sql —— 账本恢复行（issue #500：erix-agent 0.33.0 恢复行三件套）
--
-- 要解决的问题：引擎 0.32（上游 issue #769）把「这个 `tool_use` 真的执行过了」「这段半截正文产生过」
-- 做成**账本恢复行**（`kind: "recovery"`），要求宿主实现 `appendRecoveryRow` / `listRecoveryRows` /
-- `clearRecoveryRows` 三个可选方法。本站一个都没有 ⇒ 每条 run 固定 2 条 `persistence_capability_degraded`，
-- 且崩溃续跑时引擎只能说「两边都无证据」，说不出「跑过但结果没落盘」/「没跑到」。
--
-- 语义红线（`src/store/recovery-rows.js` 文件头，也是契约里那句话的出处）：
--   **「`tool_use` 没有对应 `tool_result`」推不出「工具没执行」**——工具副作用先于结果行落盘。
--   所以「执行过没有」必须由一条**显式的、追加写的**恢复行携带，不许从「缺结果行」反推。
--   0.31 及以前这个事实只在 run 快照里，而快照是覆盖写 ⇒ 恰好在最需要它的时刻被下一轮盖掉；
--   0.32 起换成 append-only 恢复行（本站 #530 已把快照退役，恢复只信账本）。
--
-- 为什么是**新表**而不是给 `transcript_rounds` 加 `kind` 列（issue #500 正文的对照表，此处只留结论）：
--   ① 契约要求「恢复行**不进** `load()` / `loadRawRows()`」——独立表里结构性成立，同表加列则要靠
--      「11 条 session-key 读点每条都记得加谓词」的纪律，漏一条就静默污染模型上下文；
--   ② `clearRecoveryRows` 要 `DELETE`，而 `portal/src/sessions.js` 把「全站 `DELETE FROM
--      transcript_rounds` 零命中」当作折叠重建「可证无损」的论证前提（两处引用），同表就是引进例外；
--   ③ 每次工具执行都进共享账本与共享索引，放大现有轮账本。
--
-- 形状（引擎 `buildToolExecutedRecoveryRow` / `buildUnledgeredToolResultRecoveryRow` /
-- `buildPartialTextRecoveryRow`，`dedupKey` 由**引擎算好**，宿主不重算）：
--   { round, roundKey, dedupKey, kind: "recovery", recoveryEvent, toolUseId?, toolResult?, text?,
--     messages: [], ts }
--   · `kind: "recovery"` 是唯一判别键；`messages` **恒空**（恢复行永不载正文，否则 resume 的
--     `records.flatMap(record.messages)` 会把同一份正文恢复两遍）。
--   · `tool-executed`：一格一条、append-only、永不改写，事件键 = `toolUseId`。
--   · `tool-result-unledgered`：结果行写失败的兜底，带 `toolResult`。
--   · `partial-text`：每轮一个槽位（本站 #301 未开 `partialPersistence` ⇒ 今天不产生，读侧能忽略即可）。
--
-- 为什么没有 `transcript_key` 的外键、也没有 `created_at`：
--   · 与 `transcript_rounds` 同口径（键是引擎给的 transcript key，写入路径不与 session 同事务）；
--   · 本站规矩「不写 `DEFAULT CURRENT_TIMESTAMP`」：**排序靠 `append_seq`，不靠时间**——引擎读
--     `partial-text` 取的是「该轮**最后落盘**那条」（`readPartialTextRecoveryRow`），同秒两行用
--     `created_at` 排不出来，`bigserial` 才给得出持久化追加序（同 `transcript_rounds.append_seq`，迁移 0016）。
--   · 幂等判据是 `PRIMARY KEY (transcript_key, dedup_key)`：同 key + 同 payload ⇒ 幂等跳过，
--     同 key + 异 payload ⇒ 拒绝（判据与轮记录同一把尺 `portal/src/transcript-payload.js`）。
--
-- 幂等可重放（deploy/migrations/README.md）：全部 `IF NOT EXISTS`，第二遍是零 DDL 空操作；
-- 末尾守卫与证据块都是纯读。`SET LOCAL`（不是 `SET`）：迁移 runner 在单事务里执行，
-- `SET LOCAL` 随事务结束自动失效，不会把超时漏给同一条池化连接的后续语句（照 0033/0034）。

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '20min';

CREATE TABLE IF NOT EXISTS transcript_recovery_rows (
  -- 引擎 store key = sessionId（issue #81 P2 起 transcript 全是 session 作用域；恢复行**只有**
  -- session 语义，没有 run 作用域这一格 ⇒ 本表只有一列键，不像 transcript_rounds 那样 run/key 并存）。
  transcript_key text      NOT NULL,
  -- 事件键（引擎 `recoveryEventKey`：`<runId>:engine:round:<n>:recovery:<event>:<判别子>`）。
  -- 长度上界：runId 是 uuid(36) + 固定段 + `toolUseId`（provider 给的调用 id，实测几十字符）或
  -- 半截正文的 `sha256:<24 hex>` ⇒ 255 字符给得下；越界是形状问题，让它当场失败而不是静默截断。
  dedup_key      text      NOT NULL CHECK (length(dedup_key) <= 255),
  -- 事件所属轮号。`round >= 0` 与 `transcript_rounds.round` 同口径；引擎侧还有一条更强的判据
  -- （`toolExecutedRecoveryRowShapeProblem` 要求 `Number.isSafeInteger(round)`），那道闸在**读侧**抛错，
  -- 本表这条只是别让畸形数字进库。
  round          integer   NOT NULL CHECK (round >= 0),
  -- 引擎 record **原样**（不剥字段、不合成列字段：恢复行的读侧判据读的就是 record 本体）。
  record         jsonb     NOT NULL,
  -- 持久化追加序（排序唯一真相，见文件头）。`bigserial` ⇒ 序列属主随本表 = 迁移角色，
  -- `station_portal` 的 USAGE/SELECT 由 baseline `schema.sql` §10 的 `ALTER DEFAULT PRIVILEGES` 覆盖。
  append_seq     bigserial NOT NULL,
  PRIMARY KEY (transcript_key, dedup_key)
);

-- 读侧（`listRecoveryRows`）唯一的谓词 + 排序：`WHERE transcript_key = ? ORDER BY append_seq`。
-- 主键是 (key, dedup_key)，给不出这个顺序 ⇒ 单独一条（契约要求按落盘顺序返回，引擎取「该轮最后一条」）。
CREATE INDEX IF NOT EXISTS transcript_recovery_rows_key_seq_idx
    ON transcript_recovery_rows (transcript_key, append_seq);

-- ── 守卫：上面两条 DDL 若被改写（键列漂了、索引排序漂了），当场失败而不是让读侧拿到错的行序 ──
DO $$
DECLARE
  pk_cols text;
  idx_cols text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO pk_cols
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE c.contype = 'p' AND t.relname = 'transcript_recovery_rows';

  IF pk_cols IS DISTINCT FROM 'transcript_key,dedup_key' THEN
    RAISE EXCEPTION '0036: transcript_recovery_rows 幂等键 UNIQUE (transcript_key, dedup_key) 漂移（实得 %）',
      coalesce(pk_cols, '<无主键>');
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO idx_cols
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
   WHERE t.relname = 'transcript_recovery_rows'
     AND i.indexrelid = 'transcript_recovery_rows_key_seq_idx'::regclass;

  IF idx_cols IS DISTINCT FROM 'transcript_key,append_seq' THEN
    RAISE EXCEPTION '0036: transcript_recovery_rows_key_seq_idx 的列漂移（实得 %）——'
      '恢复行必须按 append_seq（不是时间）返回，partial-text 取的是「该轮最后落盘」那条',
      coalesce(idx_cols, '<无索引>');
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute
     WHERE attrelid = 'transcript_recovery_rows'::regclass
       AND attname = 'created_at' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '0036: transcript_recovery_rows 又出现了 created_at——排序真相是 append_seq，'
      '不是墙钟（本站规矩：新表不写 DEFAULT CURRENT_TIMESTAMP）';
  END IF;
END
$$;

-- ── 重放证据（纯读）：第二遍跑必须原样打印同样的行数，证明确实是零 DDL 空操作 ──
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM transcript_recovery_rows;
  RAISE NOTICE '0036: transcript_recovery_rows 就绪，共 % 行（新建时必为 0；重放时不变）', n;
END
$$;
