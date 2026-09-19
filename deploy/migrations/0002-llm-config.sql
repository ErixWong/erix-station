-- 0002-llm-config.sql —— 真 LLM 接入的配置存储层（issue #38 Phase A）
-- 背景（issue #38，用户决策 2026-09-19）：去 LiteLLM hub，上游直发 per-FDE key——平台存储明文 key
--   （单机自托管，同机加密是安全剧场），三条存储纪律：①容器永不持有真 key（架构不变式）；
--   ②API 回显只给掩码（sk-...last4），编辑需重输；③key 不进日志/审计/错误信息。
--
-- 本迁移新增 master-detail 两张表 + 复用扩列既有 fde_llm_bindings（不新建替代表）：
--   llm_providers  全局 LLM 供应商（上游 API 端点）
--   llm_models     模型目录（上游模型名 + 类型 + tool_calling 能力标记），挂 provider 下
--   fde_llm_bindings 扩列：provider_id / api_key / main|embedding|vision_model_id ——
--     gateway 列语义更新：值 'direct' 表示上游直连（不再要求网关名）；旧值保留兼容。
--
-- 校验分工：main_model_id 必须 tool_calling=true 由**应用层**校验（PG 无法跨表查能力标记）；
--   api_key 为 NULL = 未配置（该 FDE 无 LLM 可用，心跳下行空模型集）。
--
-- 本结构变更**仅**由本迁移提供：docs/data/schema.sql 是冻结 baseline（deploy/migrations/README.md），
--   改 baseline 会改变其 checksum → migrate runner 拒绝启动。
-- 幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS（可重复执行）。
-- 约定：单事务（runner 会 BEGIN → 执行 → 落 schema_migrations → COMMIT，deploy/migrations/README.md）。
CREATE TABLE IF NOT EXISTS llm_providers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  base_url   text NOT NULL,
  api_format text NOT NULL DEFAULT 'openai' CHECK (api_format IN ('openai')),
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS llm_models (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     uuid NOT NULL REFERENCES llm_providers (id),
  model_id        text NOT NULL,                       -- 上游模型名（请求体 model 字段）
  name            text NOT NULL,                       -- 展示名
  type            text NOT NULL
                  CHECK (type IN ('text','embedding','vision','rerank','audio-tts','audio-stt','image-gen')),
  tool_calling    boolean NOT NULL DEFAULT false,
  context_window  int,
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);

-- 既有 fde_llm_bindings 复用扩列（gateway/key_id/key_alias/state/generation/revoked_at/rotated_at 保留不动）。
ALTER TABLE fde_llm_bindings
  ADD COLUMN IF NOT EXISTS provider_id       uuid REFERENCES llm_providers (id),
  ADD COLUMN IF NOT EXISTS api_key           text,
  ADD COLUMN IF NOT EXISTS main_model_id     uuid REFERENCES llm_models (id),
  ADD COLUMN IF NOT EXISTS embedding_model_id uuid REFERENCES llm_models (id),
  ADD COLUMN IF NOT EXISTS vision_model_id   uuid REFERENCES llm_models (id);
-- gateway 列语义更新注释：值 'direct' 表示上游直连（不再要求网关名）；旧值保留兼容。
