-- 0010-litellm-bindings.sql —— LiteLLM 成为模型目录与虚拟 key 的唯一真相源（issue #117 phase 2）。
-- 模型槽改存 LiteLLM model_info.id（text），绑定关联到 LiteLLM credential 名称；
-- 旧目录改名保留，供回滚/人工核对。待确认所有部署均不再读取旧表后，再另发迁移 DROP *_retired。
--
-- 旧 api_key 是直连上游凭据，不是 LiteLLM 虚拟 key：清除它们并撤销旧绑定，避免将上游凭据
-- 误注入新网关。旧模型目录 UUID 也不是 LiteLLM model_info.id，槽位清空后由管理员重新选择模型。
-- gateway_user_id 记录 LiteLLM 用户，避免每次 key 轮换都重复创建用户。
-- baseline (docs/data/schema.sql) 冻结；所有 DDL 只在增量迁移中执行。

ALTER TABLE fde_llm_bindings
  DROP CONSTRAINT IF EXISTS fde_llm_bindings_provider_id_fkey,
  DROP CONSTRAINT IF EXISTS fde_llm_bindings_main_model_id_fkey,
  DROP CONSTRAINT IF EXISTS fde_llm_bindings_embedding_model_id_fkey,
  DROP CONSTRAINT IF EXISTS fde_llm_bindings_vision_model_id_fkey;

ALTER TABLE fde_llm_bindings
  ALTER COLUMN provider_id TYPE text USING provider_id::text,
  ALTER COLUMN main_model_id TYPE text USING main_model_id::text,
  ALTER COLUMN embedding_model_id TYPE text USING embedding_model_id::text,
  ALTER COLUMN vision_model_id TYPE text USING vision_model_id::text,
  ADD COLUMN IF NOT EXISTS gateway_user_id text,
  ADD COLUMN IF NOT EXISTS main_model_name text,
  ADD COLUMN IF NOT EXISTS embedding_model_name text,
  ADD COLUMN IF NOT EXISTS vision_model_name text;

ALTER TABLE IF EXISTS llm_providers RENAME TO llm_providers_retired;
ALTER TABLE IF EXISTS llm_models RENAME TO llm_models_retired;

UPDATE fde_llm_bindings b
   SET provider_id = p.name
  FROM llm_providers_retired p
 WHERE b.provider_id = p.id::text;

UPDATE fde_llm_bindings
   SET gateway = 'litellm',
       key_id = NULL,
       api_key = NULL,
       main_model_id = NULL,
       main_model_name = NULL,
       embedding_model_id = NULL,
       embedding_model_name = NULL,
       vision_model_id = NULL,
       vision_model_name = NULL,
       state = 'revoked',
       revoked_at = COALESCE(revoked_at, now()),
       updated_at = now();

COMMENT ON TABLE llm_providers_retired IS
  'Retired by 0010-litellm-bindings.sql; keep for rollback/reference until a later migration drops it.';
COMMENT ON TABLE llm_models_retired IS
  'Retired by 0010-litellm-bindings.sql; keep for rollback/reference until a later migration drops it.';
COMMENT ON COLUMN fde_llm_bindings.provider_id IS
  'LiteLLM credential name (legacy column name retained for API compatibility); no FK.';
COMMENT ON COLUMN fde_llm_bindings.main_model_id IS
  'LiteLLM model_info.id, stored as text; no FK.';
COMMENT ON COLUMN fde_llm_bindings.embedding_model_id IS
  'LiteLLM model_info.id, stored as text; no FK.';
COMMENT ON COLUMN fde_llm_bindings.vision_model_id IS
  'LiteLLM model_info.id, stored as text; no FK.';
COMMENT ON COLUMN fde_llm_bindings.main_model_name IS
  'LiteLLM model_name sent on the data plane; model_info.id remains the binding identity.';
COMMENT ON COLUMN fde_llm_bindings.embedding_model_name IS
  'LiteLLM model_name sent on the data plane; model_info.id remains the binding identity.';
COMMENT ON COLUMN fde_llm_bindings.vision_model_name IS
  'LiteLLM model_name sent on the data plane; model_info.id remains the binding identity.';
COMMENT ON COLUMN fde_llm_bindings.gateway_user_id IS
  'LiteLLM user id used when generating per-FDE virtual keys.';
