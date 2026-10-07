-- 0014-run-state-status.sql —— 引擎终态从 run-state 快照拆分（erix-agent 0.14.0）。
-- 新写入状态落独立列；旧 JSONB 内嵌的 state 由 loadRunStateStatus 兼容读取，不回填。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS run_state_status jsonb;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS engine_run_state_status jsonb;
