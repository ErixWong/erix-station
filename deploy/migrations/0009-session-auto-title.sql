-- 0009-session-auto-title.sql —— 会话标题自动生成与自动更新（issue #88）
-- 背景：chat_sessions.title 此前只能手工设置、默认空串，列表全是「未命名会话」。
--   本迁移加 title_source 语义列 + 自动更新游标列：
--   * title_source 'auto'|'manual'（默认 'auto'）——用户手工改过的标题（PATCH title / 建会话显式
--     传 title）置 'manual'，自动更新只写 'auto' 行（手工优先，issue #88 设计要点）。
--   * auto_title_seq —— 上次自动更新标题时的 chat_sessions.last_seq 快照（NULL = 从未自动更新）。
--     防抖判据「距上次更新 ≥ N 轮新用户消息」= COUNT(messages WHERE role='user' AND seq > auto_title_seq)。
-- 回填：存量非空标题只能来自手工设置（旧链路无任何生成路径）→ 'manual'；
--   auto_title_seq IS NULL 守卫使本 UPDATE 可重放且不误伤未来的自动标题行（自动更新必置游标）。
-- 幂等：ADD COLUMN IF NOT EXISTS 天然幂等；UPDATE 的 WHERE 只命中 title_source='auto' 且游标为 NULL
--   且标题非空的行，重复执行零变化。
-- 约定：单事务（migrate runner）；baseline schema.sql 冻结，DDL 只走本目录（README.md）。
ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'auto' CHECK (title_source IN ('auto', 'manual'));
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS auto_title_seq integer;

UPDATE chat_sessions
   SET title_source = 'manual'
 WHERE title_source = 'auto'
   AND auto_title_seq IS NULL
   AND title IS NOT NULL
   AND btrim(title) <> '';
