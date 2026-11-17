-- 0040-mcp-channel.sql —— MCP 通道 P1：配置槽声明与值（issue #608，契约 docs/design/mcp-integration.md §3）
--
-- 定位：MCP 条目复用 `capability_items`（`kind='mcp'`，迁移 0039 已建）与 `fde_capability_installs`；
--   本文件只补「配置槽」两张表。槽位声明随条目走，值**加密**存（AES-256-GCM，key 在 deploy/.env 的
--   MCP_SECRET_KEY），**只写不读**：任何 API 都不返回明文。
--
-- 为什么 secret 不许 `inject='context'`：`context` 是技能进程内面（`skillModule[tool](input, ctx)`），
--   把密钥交给技能代码等于放弃「密钥只在平台注入面」这条口径；secret 只允许 env（stdio 子进程）/ header（HTTP）。
-- 为什么 `updated_by` 是 ON DELETE SET NULL：删用户不该因为「他改过一个全局槽值」而被外键挡住。
-- 为什么两条**部分**唯一索引而不是复合主键：`scope='global'` 时 `fde_id` 为 NULL，而 PG 里 NULL 互不相等
--   ⇒ 复合唯一约束对 global 行不起作用（同一 (item,name) 能插出多行）。
-- 幂等可重放：只有 CREATE TABLE/INDEX IF NOT EXISTS；末尾 DO 块**只读**，打印重放证据。
--   ⚠ RAISE NOTICE 的第一个参数必须是**字面量格式串**（0039 曾写成 `'a' || 'b'` ⇒ PL/pgSQL 语法错、
--   整支回滚、portal 起不来）；`portal/test/migrations.test.js` 有形状闸钉这条。

CREATE TABLE IF NOT EXISTS capability_params (
  item_id     uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name        text NOT NULL,                    -- 注入名：^[A-Z][A-Z0-9_]{0,63}$
  kind        text NOT NULL CHECK (kind IN ('config','secret')),
  inject      text NOT NULL CHECK (inject IN ('context','env','header')),
  required    boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, name),
  CHECK (kind <> 'secret' OR inject IN ('env','header'))
);

CREATE TABLE IF NOT EXISTS capability_param_values (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id         uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  name            text NOT NULL,
  scope           text NOT NULL CHECK (scope IN ('global','fde')),
  fde_id          uuid REFERENCES users (id) ON DELETE CASCADE,
  value_encrypted bytea NOT NULL,               -- iv(12) || tag(16) || ciphertext
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (item_id, name) REFERENCES capability_params (item_id, name) ON DELETE CASCADE,
  CHECK ((scope = 'fde') = (fde_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_global_uq
  ON capability_param_values (item_id, name) WHERE scope = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS capability_param_values_fde_uq
  ON capability_param_values (item_id, name, fde_id) WHERE scope = 'fde';

DO $$
DECLARE
  n_params bigint;
  n_values bigint;
BEGIN
  SELECT count(*) INTO n_params FROM capability_params;
  SELECT count(*) INTO n_values FROM capability_param_values;
  RAISE NOTICE '0040: capability_params=% / capability_param_values=% 行（全 0 = 还没有任何 MCP 条目声明槽位）',
    n_params, n_values;
END $$;
