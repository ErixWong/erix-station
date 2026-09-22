-- 0003-run-state.sql —— runs.run_state jsonb（issue #43：erix-agent 0.3.5 → 0.9.0 升级）
-- 背景：0.6.0 起引擎 TranscriptStore 契约 fail-closed 校验 8 方法，新增 saveRunState/loadRunState
--   （确定性 run state 持久化 + resume 恢复读取，host-consumer-contract.md「Run state」）。
--   station 落 runs.run_state jsonb（不变式 3「DB 是状态真相」）；markRunState 引擎终态标记
--   （succeeded/unverified_error/guard_error）经 PUT /runs/:id/runstate {state} 合并进本列，
--   不触碰 runs.status（宿主终态唯一权威仍是 U2 setRunState）。
-- 幂等：ADD COLUMN IF NOT EXISTS（可重复执行）。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_state jsonb;
