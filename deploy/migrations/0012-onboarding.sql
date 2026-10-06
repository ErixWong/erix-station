-- 0012-onboarding.sql — 持久化 FDE 自动开户进度（issue #111）。
CREATE TABLE IF NOT EXISTS fde_onboarding (
  fde_id     uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  state      text NOT NULL DEFAULT 'pending'
             CHECK (state IN ('pending','running','awaiting_credential','done','failed')),
  steps      jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  attempt    int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fde_onboarding_state_idx ON fde_onboarding (state);
