-- 0001-idempotency-keys.sql —— 写操作幂等键台账（portal.md §1.4）
-- 用途：POST 写端点（当前唯一使用者 POST /api/sessions/:id/messages）可选 Idempotency-Key 去重：
--   同 (user_id, endpoint, key) 重复提交返回首次结果，不产生第二条 user 消息 / 第二个 run。
--
-- 语义（先占位后执行，F1 裁决：消除「先执行后记账」的幂等双执行窗口）：
--   state='in_progress'  占位行：首个请求抢到（并发同 key 只有一个能占到），fn 至多执行一次；
--                        占位期间（< 5 分钟，IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES）同 key 请求 → 409 idempotency_conflict(retryable)；
--                        超过 5 分钟（持有者崩溃残留，stale）→ 视为可覆盖，被后续请求 UPDATE 抢回后执行；
--   state='done'         完成行：落 status_code/response 供回放（TTL 24h 内命中；request_hash 不一致 → 409 idempotency_key_reuse）。
--   created_at 既作 TTL 24h 基准（done 行的命中窗口），也作 in_progress 陈旧判定基准。
--   占位行 status_code/response 为 NULL（结果尚未产生）——回放只读 state='done' 行，故不会回放出占位态。
--
-- 本表**仅由本迁移提供**：docs/data/schema.sql 是自 P1 冻结的 baseline（deploy/migrations/README.md），
--   新增 DDL 一律走增量迁移，不改 baseline（改 baseline 会改变其 checksum → migrate runner 拒绝启动）。
-- 幂等：`CREATE TABLE IF NOT EXISTS` + `ADD COLUMN IF NOT EXISTS` + `DROP NOT NULL`（可重复执行）；
--   末尾两条 ALTER 只为兼容**预发布期**已建出本表的库（本 PR 未发布前，该表曾一度写在 baseline 里，
--   那一版不含 state 且 status_code/response 为 NOT NULL）；对全新库是 no-op。
--   注：兼容路径只补列与可空性，不补 state 的 CHECK 约束（该库为开发/预发布库，应用层总是写合法值）——
--   全新库一律带上 CHECK。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL,     -- 具体端点（含路径参数，如 POST /api/sessions/<id>/messages）：同 key 跨 session 不串号
  key          text NOT NULL,     -- 客户端原始 Idempotency-Key（≤128、无控制字符，由 portal 层校验）
  request_hash text NOT NULL,     -- 规范化请求体（content + attachments[{kind,path,name}]）的 sha256：不一致 → 409 idempotency_key_reuse
  state        text NOT NULL DEFAULT 'done' CHECK (state IN ('in_progress', 'done')),
  status_code  int,               -- 完成行的首次响应状态码（回放原样返回）；占位行为 NULL
  response     jsonb,             -- 完成行的首次响应体（回放原样返回）；占位行为 NULL
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);

-- 预发布期兼容（对全新库 no-op，见文件头说明）
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'done';
ALTER TABLE idempotency_keys ALTER COLUMN status_code DROP NOT NULL;
ALTER TABLE idempotency_keys ALTER COLUMN response DROP NOT NULL;

-- 过期清理扫描索引（reaper 低频 DELETE created_at < now() - interval '24 hours'）
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
