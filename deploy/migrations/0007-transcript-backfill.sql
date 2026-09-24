-- 0007-transcript-backfill.sql —— 旧 run 作用域 transcript 记录回填 session key（issue #81 P2 修正）
-- 背景：P2（0006）把 transcript key 从 runId 切到 sessionId，但**未迁移存量**——P2 前的 run
--   记录 transcript_key = NULL，新 runner 以 session key load 时看不到，导致：
--   ① 会话历史断层（第二 turn 只见本轮消息）；
--   ② GLM-5.3 thinking 模式（恒开思考，ADR-017）要求 assistant 历史带 reasoning_content，
--     断层触发 #70 文本注入路径 → 纯文本 assistant 无 reasoning_content → 首个请求被上游拒绝
--     （真机实证：run da343c90 "The reasoning_content in the thinking mode must be passed back"）。
-- 修法：按 runs.session_id 回填 transcript_key（记录归属唯一，安全）。backfill 后 resume 全量
--   字节级恢复（旧记录 reasoning 块完整，DB 实证），GLM 校验满足，#70 注入不再触发。
-- 旧行 dedup_key 保持 NULL：部分唯一索引 (transcript_key, dedup_key) 中 NULL 互不冲突；
--   宿主 dedupKey 命中判据对旧行天然未命中 → 下一轮正常走预写入分支，无副作用。
-- 幂等：只回填 transcript_key IS NULL 且 run_id 非空的行；重复执行零变化。
-- 约定：单事务（migrate runner）。
UPDATE transcript_rounds r
SET transcript_key = s.session_id
FROM runs s
WHERE r.run_id = s.id
  AND r.transcript_key IS NULL;
