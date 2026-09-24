-- 0006-session-transcript.sql —— session-scoped transcript（issue #81 P2：store key 切 session 维度）
-- 背景：docs/design/conversation-state.md §4.1——transcript key 从 runId 切到 sessionId，
--   照抄 erix-agent CLI「预写入 + resume」模式（引擎零改动）。宿主（worker）以
--   dedupKey=`<sessionId>:input:<messageId>` 预写入用户消息，跨 run 在同一会话键上累积。
-- 存储方案（评估记录）：选「既有表加列 + 部分唯一索引」而非新表——
--   ① 会话真相单表：P3（messages 投影）只读一张 transcript_rounds，不维护双份 schema/归档 TTL；
--   ② run 作用域旧行（旧 runner 写入）原样保留，旧端点向后兼容不动；
--   ③ 部分唯一索引（WHERE transcript_key IS NOT NULL）使新旧语义共存于同表互不干扰。
-- 关键语义：
--   * transcript_rounds.run_id 解除 NOT NULL：session 行 run_id = NULL（宿主预写行与引擎
--     行允许同行号不同 dedupKey——CLI 模式 latestRound 行号复用 + 引擎 `:resume` 补跑重落盘，
--     若保留 NOT NULL + UNIQUE(run_id, round) 会撞唯一约束）。UNIQUE(run_id, round) 约束
--     本身保留（旧 run 作用域端点语义不变，NULL run_id 不参与唯一判定）。
--   * dedup_key 加速/唯一列：由写入方从 body.dedupKey 显式填充（session 行必填，见
--     putSessionRound 校验）——不用 GENERATED 列，避免加列全表 rewrite（大表迁移纪律）。
--     session 行唯一性判据 = (transcript_key, dedup_key)，崩溃重跑幂等（同 dedupKey 重放 → 幂等命中）。
--     旧 run 作用域行两列均为 NULL，不参与任何 session 索引。
--   * run_checkpoints session 行复用 transcript_key 唯一索引 + revision CAS（同 U8 语义）。
--   * 引擎语义 run state 落 chat_sessions.engine_run_state（session 作用域合并写）；
--     runs.run_state 保留 run 作用域（旧端点兼容）。
-- 幂等：ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / ALTER COLUMN 可重复执行。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
ALTER TABLE transcript_rounds ALTER COLUMN run_id DROP NOT NULL;
ALTER TABLE transcript_rounds ADD COLUMN IF NOT EXISTS transcript_key text;
ALTER TABLE transcript_rounds ADD COLUMN IF NOT EXISTS dedup_key text;
CREATE UNIQUE INDEX IF NOT EXISTS transcript_rounds_session_dedup_uidx
  ON transcript_rounds (transcript_key, dedup_key) WHERE transcript_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS transcript_rounds_session_round_idx
  ON transcript_rounds (transcript_key, round, created_at) WHERE transcript_key IS NOT NULL;

ALTER TABLE run_checkpoints ADD COLUMN IF NOT EXISTS transcript_key text;
CREATE UNIQUE INDEX IF NOT EXISTS run_checkpoints_session_uidx
  ON run_checkpoints (transcript_key) WHERE transcript_key IS NOT NULL;

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS engine_run_state jsonb;
