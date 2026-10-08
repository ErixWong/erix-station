-- 0016-transcript-append-seq.sql —— transcript 同 round 保序（erix-agent 0.16.0 store 契约）
-- 依据：host-upgrade-guide-0.16.0 §1「Store fidelity / same-round ordering」——load() 必须按
--   **持久化追加顺序**返回同 round 的记录，引擎不再二次排序；不得依赖 DB 执行计划、主键扫描顺序
--   或偶然行布局来还原插入序。SQL 后端示例 ORDER BY round_no, append_seq。
-- 背景：现行 session 读路径用 `ORDER BY round, created_at`；真机 transcript_rounds 已有
--   58 组重复 (transcript_key, round)、共 183 行，且存在 created_at 完全相同的同 round 行 →
--   仅凭 created_at 无法确定性还原同轮顺序 → 需要显式持久化的 append 序列。
-- 变更：
--   1) 新增 append_seq（bigint，默认 nextval）——新行由单调序列保证严格追加序；
--   2) 存量回填：历史行没有真实追加序，只能按**当前可用的确定性顺序** `created_at, id` 近似还原；
--      同一 created_at 的历史行之间相对顺序无法复原（已知近似，仅历史行，新行由序列保证）；
--   3) 索引 (transcript_key, round, append_seq) 支撑 session 读路径 ORDER BY round, append_seq；
--      (run_id, round, append_seq) 支撑 legacy run 作用域读路径。
-- UNIQUE (run_id, round) 处置：**保留不动**。依据——
--   * session 维度行 run_id IS NULL，NULL 在唯一索引里互不相等，本就不受该约束限制
--     （真机 58 组重复 (transcript_key, round) 即 session 行）；0.16.0 引擎 store 自 P2 起只走
--     session 端点（putSessionRound，唯一判据 = 部分唯一索引 (transcript_key, dedup_key)），
--     该约束不阻塞 0.16.0 合规；
--   * legacy run 维度 putRound 仍以该约束做 ON CONFLICT 幂等；且其存量行 dedup_key 列为 NULL
--     （迁移 0006 有意不填），若在同一迁移里 drop/替换为 (run_id, dedup_key) 会破坏旧行重放幂等，
--     属于「为改而改」——故本迁移不动它。
-- 幂等：ADD COLUMN / CREATE SEQUENCE / CREATE INDEX 全 IF NOT EXISTS；回填只写 append_seq IS NULL
--   的行，重放不改变已有值（deploy/migrations/README.md「单文件约定」）。
-- 约定：迁移 runner 在单事务内 BEGIN → 执行 → 落 schema_migrations → COMMIT。
SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE transcript_rounds ADD COLUMN IF NOT EXISTS append_seq bigint;
CREATE SEQUENCE IF NOT EXISTS transcript_rounds_append_seq_seq;

-- 存量回填：确定性顺序 created_at ASC, id ASC（历史行近似还原；新行由序列保证）。
UPDATE transcript_rounds AS t
   SET append_seq = s.rn
  FROM (
    SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
      FROM transcript_rounds
     WHERE append_seq IS NULL
  ) AS s
 WHERE t.id = s.id
   AND t.append_seq IS NULL;

-- 序列起点 = 现有最大值 + 1（空表 → 1），新行严格大于全部历史行。
SELECT setval(
  'transcript_rounds_append_seq_seq',
  COALESCE((SELECT MAX(append_seq) FROM transcript_rounds), 0) + 1,
  false
);
ALTER TABLE transcript_rounds ALTER COLUMN append_seq SET DEFAULT nextval('transcript_rounds_append_seq_seq');
ALTER SEQUENCE transcript_rounds_append_seq_seq OWNED BY transcript_rounds.append_seq;
ALTER TABLE transcript_rounds ALTER COLUMN append_seq SET NOT NULL;

CREATE INDEX IF NOT EXISTS transcript_rounds_session_append_idx
  ON transcript_rounds (transcript_key, round, append_seq) WHERE transcript_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS transcript_rounds_run_append_idx
  ON transcript_rounds (run_id, round, append_seq) WHERE run_id IS NOT NULL;
