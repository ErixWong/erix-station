-- 0013-offboarding.sql — durable FDE offboarding workflow and delayed workspace purge.
ALTER TABLE containers ALTER COLUMN runner_token_hash DROP NOT NULL;

CREATE TABLE fde_offboarding (
  fde_id uuid PRIMARY KEY,
  fde_name text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
  steps jsonb NOT NULL,
  last_error text,
  attempt integer NOT NULL DEFAULT 0,
  workspace_purge_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX fde_offboarding_state_idx ON fde_offboarding (state, created_at);
CREATE INDEX fde_offboarding_purge_idx
  ON fde_offboarding (workspace_purge_after) WHERE state = 'done';
