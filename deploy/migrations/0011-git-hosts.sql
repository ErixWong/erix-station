-- 0011-git-hosts.sql — 多 Git host 注册表与 FDE 账号映射（issue #118）。
-- admin_key 仅用于平台调用 host API；代铸 token 明文只投放到 FDE 凭据文件，
-- fde_git_accounts.token_ref 保存远端 token ID 以支持后续吊销。
CREATE TABLE IF NOT EXISTS git_hosts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  provider   text NOT NULL CHECK (provider IN ('gitea', 'github', 'gitlab', 'azure')),
  base_url   text NOT NULL,
  admin_key  text,
  mode       text NOT NULL CHECK (mode IN ('minted', 'per_fde_pat')),
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((mode = 'minted') = (admin_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS fde_git_accounts (
  fde_id      uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  git_host_id uuid NOT NULL REFERENCES git_hosts (id) ON DELETE RESTRICT,
  remote_login text,
  token_ref   text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (token_ref IS NULL OR remote_login IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS fde_git_accounts_host_idx ON fde_git_accounts (git_host_id);

ALTER TABLE containers ADD COLUMN IF NOT EXISTS git_provider text;

-- per_fde_pat 用户在凭据落地前不能认证或运行；状态通过既有 Git credential 管理流程
-- 在对应 host 凭据成功写入后恢复为 active。
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('active', 'disabled', 'awaiting_credential'));
