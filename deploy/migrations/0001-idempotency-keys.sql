-- 0001-idempotency-keys.sql —— 写操作幂等键台账（portal.md §1.4）
-- 用途：POST 写端点（当前唯一使用者 POST /api/sessions/:id/messages）可选 Idempotency-Key 去重：
--   同 (user_id, endpoint, key) 重复提交返回首次结果，不产生第二条 user 消息 / 第二个 run。
--
-- 语义（先占位后执行 + 记账并入业务事务，F1/G2 裁决：消除「先执行后记账」的幂等双执行窗口）：
--   state='in_progress'  占位行：首个请求抢到（并发同 key 只有一个能占到），fn 至多执行一次；
--                        占位期间（< 5 分钟，IDEMPOTENCY_IN_PROGRESS_STALE_MINUTES）同 key 请求 → 409 idempotency_conflict(retryable)；
--                        超过 5 分钟（持有者崩溃残留，stale）→ 视为可覆盖，被后续请求 UPDATE 抢回后执行；
--   state='done'         完成行：落 status_code/response 供回放（TTL 24h 内命中；request_hash 不一致 → 409 idempotency_key_reuse）。
--   claim_token          占位持有者标识（owner fencing，G2）：占位/抢回时写入新 UUID，
--                        record/补记（writeDone）/release 均带 `AND claim_token = $`——旧持有者崩溃后被抢回，
--                        其迟到的记账/释放一律 0 行（不覆写新持有者的结果）。done 行保留最后一次占位的 token。
--   created_at 既作 TTL 24h 基准（done 行的命中窗口），也作 in_progress 陈旧判定基准。
--   占位行 status_code/response 为 NULL（结果尚未产生）——回放只读 state='done' 行，故不会回放出占位态。
--
-- 本表**仅由本迁移提供**：docs/data/schema.sql 是自 P1 冻结的 baseline（deploy/migrations/README.md），
--   新增 DDL 一律走增量迁移，不改 baseline（改 baseline 会改变其 checksum → migrate runner 拒绝启动）。
-- 幂等：`CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS`（可重复执行）。
-- 预发布库（本迁移发布前在本机建过本表的开发库）：**请直接重建**，不提供 ALTER 兼容路径——
--   runner 先校验 baseline checksum（migrate.js：baseline 校验在增量之前），旧库要么 checksum 失配
--   直接拒启、要么结构与本文件不一致（缺列/多 NOT NULL）而无人修复；「兼容旧库」的 ALTER 分支既
--   不可达又制造第二套 schema 口径（旧 baseline 曾包含过本表）。重建：
--     docker compose -f deploy/docker-compose.yml down -v && rm -rf /docker/station-db && up -d
--   重建后 baseline + 增量自 0001 起线性应用（compose 默认 MIGRATE_ON_START=1 自动跑到头）。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL,     -- 具体端点（含路径参数，如 POST /api/sessions/<id>/messages）：同 key 跨 session 不串号
  key          text NOT NULL,     -- 客户端原始 Idempotency-Key（≤128、无控制字符，由 portal 层校验）
  request_hash text NOT NULL,     -- 规范化请求体（content + attachments[{kind,path,name}]）的 sha256：不一致 → 409 idempotency_key_reuse
  state        text NOT NULL DEFAULT 'done' CHECK (state IN ('in_progress', 'done')),
  status_code  int,               -- 完成行的首次响应状态码（回放原样返回）；占位行为 NULL
  response     jsonb,             -- 完成行的首次响应体（回放原样返回）；占位行为 NULL
  claim_token  text,              -- 占位持有者标识（owner fencing）：占位/抢回时写入新 UUID，done 行保留最后一次的值；旧持有者的迟到记账/释放因 token 失配而 0 行
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint, key)
);

-- 过期清理扫描索引（reaper 低频 DELETE created_at < now() - interval '24 hours'）
CREATE INDEX IF NOT EXISTS idempotency_keys_created_idx ON idempotency_keys (created_at);
