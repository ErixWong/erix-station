-- cleanup-test-users.sql —— dev/测试库清理：删除测试用户及其**全部**依赖，保留真人账号。
--
-- ⚠️ 仅限 dev/测试库；**破坏性、不可回滚**（生产政策是 offboarding=只禁用不删除，见
--    docs/design/fde-platform.md §7.3——生产**不要**跑本脚本）。
--
-- 用法（默认保留 admin / eric，其余账号全部删除）：
--   # 1) 空跑看清影响面（末尾 ROLLBACK，不改数据）
--   { cat portal/integration/cleanup-test-users.sql; echo 'ROLLBACK;'; } \
--     | docker exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1
--   # 2) 确认后正式执行
--   { cat portal/integration/cleanup-test-users.sql; echo 'COMMIT;'; } \
--     | docker exec -i station-db psql -U station -d station -v ON_ERROR_STOP=1
--
-- 改保留名单：编辑下面 tgt 的 `NOT IN ('admin','eric')`。
-- 清理范围（按 FK 依赖序，全部 NO ACTION 外键，顺序不可乱）：run 事件/工具调用/transcript/
-- messages/runs/chat_sessions → 路由投影（route_outbox/route_revisions 无 FK，按聚合键清）→
-- 端口分配/预览授权/用量 → 容器/项目 → FDE 附属（network/binding/onboarding/offboarding/git 账号）
-- → 账号附属（token/登录会话/幂等键/审计）→ users。测试 git host（github-e2e）一并删除，
-- 开发用 Gitea host（gitea-test）保留。
--
-- 注意：llm_binding / fde_network 的 PK 就是 fde_id，且 route_outbox.aggregate_id 存的就是该 fde_id；
-- tool_outputs.tool_call_id / approvals.tool_call_id 是 text（tool_calls.id 是 uuid）→ 需 ::text 转换。
BEGIN;

CREATE TEMP TABLE tgt ON COMMIT DROP AS
  SELECT id, login FROM users WHERE login NOT IN ('admin', 'eric');
CREATE TEMP TABLE tgt_sess ON COMMIT DROP AS
  SELECT id FROM chat_sessions WHERE user_id IN (SELECT id FROM tgt);
CREATE TEMP TABLE tgt_run ON COMMIT DROP AS
  SELECT id FROM runs WHERE session_id IN (SELECT id FROM tgt_sess);
CREATE TEMP TABLE tgt_container ON COMMIT DROP AS
  SELECT id FROM containers WHERE user_id IN (SELECT id FROM tgt);
CREATE TEMP TABLE tgt_proj ON COMMIT DROP AS
  SELECT id FROM projects WHERE user_id IN (SELECT id FROM tgt);
CREATE TEMP TABLE tgt_alloc ON COMMIT DROP AS
  SELECT id FROM port_allocations
   WHERE fde_id IN (SELECT id FROM tgt) OR run_id IN (SELECT id FROM tgt_run);
CREATE TEMP TABLE tgt_binding ON COMMIT DROP AS
  SELECT fde_id AS id FROM fde_llm_bindings WHERE fde_id IN (SELECT id FROM tgt);
CREATE TEMP TABLE tgt_net ON COMMIT DROP AS
  SELECT fde_id AS id FROM fde_networks WHERE fde_id IN (SELECT id FROM tgt);

-- 叶子层（先删引用方）
DELETE FROM tool_outputs WHERE run_id IN (SELECT id FROM tgt_run)
   OR tool_call_id IN (SELECT id::text FROM tool_calls WHERE run_id IN (SELECT id FROM tgt_run));
DELETE FROM approvals WHERE run_id IN (SELECT id FROM tgt_run)
   OR tool_call_id IN (SELECT id::text FROM tool_calls WHERE run_id IN (SELECT id FROM tgt_run));
DELETE FROM artifacts       WHERE run_id IN (SELECT id FROM tgt_run);
DELETE FROM judge_decisions WHERE run_id IN (SELECT id FROM tgt_run);
DELETE FROM run_checkpoints WHERE run_id IN (SELECT id FROM tgt_run);
DELETE FROM transcript_rounds WHERE run_id IN (SELECT id FROM tgt_run)
   OR transcript_key IN (SELECT id::text FROM tgt_sess);
DELETE FROM tool_calls WHERE run_id IN (SELECT id FROM tgt_run);
DELETE FROM run_events WHERE run_id IN (SELECT id FROM tgt_run)
   OR session_id IN (SELECT id FROM tgt_sess);
DELETE FROM run_queue WHERE run_id IN (SELECT id FROM tgt_run)
   OR container_id IN (SELECT id FROM tgt_container)
   OR owner_container_id IN (SELECT id FROM tgt_container);
DELETE FROM messages WHERE run_id IN (SELECT id FROM tgt_run)
   OR session_id IN (SELECT id FROM tgt_sess);

-- 路由投影（无 FK，按聚合键清；aggregate_id 存的是对应实体的 id）
DELETE FROM route_outbox WHERE (aggregate = 'port_allocation' AND aggregate_id IN (SELECT id FROM tgt_alloc))
    OR (aggregate = 'llm_binding' AND aggregate_id IN (SELECT id FROM tgt_binding))
    OR (aggregate = 'fde_network' AND aggregate_id IN (SELECT id FROM tgt_net));
DELETE FROM route_revisions WHERE (aggregate = 'port_allocation' AND aggregate_id IN (SELECT id FROM tgt_alloc))
    OR (aggregate = 'llm_binding' AND aggregate_id IN (SELECT id FROM tgt_binding))
    OR (aggregate = 'fde_network' AND aggregate_id IN (SELECT id FROM tgt_net));

DELETE FROM preview_grants WHERE user_id IN (SELECT id FROM tgt)
   OR issuer_id IN (SELECT id FROM tgt)
   OR allocation_id IN (SELECT id FROM tgt_alloc);
DELETE FROM usage_ledger WHERE user_id IN (SELECT id FROM tgt)
   OR project_id IN (SELECT id FROM tgt_proj)
   OR run_id IN (SELECT id FROM tgt_run);
DELETE FROM port_allocations WHERE id IN (SELECT id FROM tgt_alloc);

-- 主体层
DELETE FROM runs         WHERE id IN (SELECT id FROM tgt_run);
DELETE FROM chat_sessions WHERE id IN (SELECT id FROM tgt_sess);
DELETE FROM containers   WHERE id IN (SELECT id FROM tgt_container);
DELETE FROM projects     WHERE id IN (SELECT id FROM tgt_proj);

-- FDE 附属
DELETE FROM materialize_outbox    WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM materialize_revisions WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM fde_llm_bindings      WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM fde_networks          WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM fde_onboarding        WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM fde_offboarding       WHERE fde_id IN (SELECT id FROM tgt);
DELETE FROM fde_git_accounts      WHERE fde_id IN (SELECT id FROM tgt);

-- 账号附属
DELETE FROM api_tokens       WHERE user_id IN (SELECT id FROM tgt);
DELETE FROM login_sessions   WHERE user_id IN (SELECT id FROM tgt);
DELETE FROM login_pending    WHERE user_id IN (SELECT id FROM tgt);
DELETE FROM idempotency_keys WHERE user_id IN (SELECT id FROM tgt);
DELETE FROM audit_log        WHERE actor_id IN (SELECT id FROM tgt);

-- 测试 git host（github-e2e 属 e2e 产物；gitea-test 是开发实例，保留）
DELETE FROM git_hosts WHERE name = 'github-e2e';

-- 账号本体
DELETE FROM users WHERE id IN (SELECT id FROM tgt);

-- 残留校验：三项必须为 0
SELECT '残留检查' AS check,
       (SELECT count(*) FROM users WHERE login NOT IN ('admin', 'eric')) AS users_left,
       (SELECT count(*) FROM chat_sessions WHERE user_id NOT IN (SELECT id FROM users)) AS orphan_sessions,
       (SELECT count(*) FROM runs WHERE session_id NOT IN (SELECT id FROM chat_sessions)) AS orphan_runs;

-- 保留账号确认
SELECT login, role, status FROM users ORDER BY login;

-- 记得单独收尾（DB 之外）：测试 FDE 容器/网络/工作区
--   docker rm -f fde-<name>; docker network rm fde-<name>
--   docker run --rm -v /srv/erix/users:/u alpine rm -rf /u/<name>   # 属主是 FDE uid 1001/1002，eric 删不动
