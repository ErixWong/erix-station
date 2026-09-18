-- 0001-idempotency-keys.sql —— 写操作幂等键台账（portal.md §1.4）
-- 用途：POST 写端点（当前唯一使用者 POST /api/sessions/:id/messages）可选 Idempotency-Key 去重：
--   同 (user_id, endpoint, key) 重复提交返回首次结果，不产生第二条 user 消息 / 第二个 run。
-- 语义：TTL 24h（命中判定带 created_at > now() - interval '24 hours'；过期行由 portal reaper 低频物理清理，
--   见 portal/src/idempotency.js purgeExpired）。request_hash 不一致 → 409 idempotency_key_reuse。
-- 说明：本表同时已写入 baseline docs/data/schema.sql §3.1（baseline 保持自包含，psql -f 空库可执行）——
--   本迁移用 IF NOT EXISTS 幂等兜底，故在「已含本表的 baseline」上应用为 no-op。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  int  NOT NULL,
  response     jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
