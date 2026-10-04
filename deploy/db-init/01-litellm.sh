#!/bin/sh
# Optional LiteLLM role/database bootstrap for a fresh station-db data directory.
set -eu

: "${POSTGRES_USER:?POSTGRES_USER 未设置}"
: "${POSTGRES_DB:?POSTGRES_DB 未设置}"

if [ -z "${LITELLM_DB_PASSWORD:-}" ]; then
  echo "[db-init] LITELLM_DB_PASSWORD is empty; skipping optional LiteLLM role/database"
  exit 0
fi

psql_super() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" "$@"
}

role_exists="$(psql_super --dbname "$POSTGRES_DB" --tuples-only --no-align \
  --command "SELECT 1 FROM pg_roles WHERE rolname = 'litellm'")"
if [ "$role_exists" = "1" ]; then
  echo "[db-init] updating LiteLLM role password"
  psql_super --dbname "$POSTGRES_DB" -v litellm_password="$LITELLM_DB_PASSWORD" <<'EOSQL'
ALTER ROLE litellm WITH LOGIN PASSWORD :'litellm_password';
EOSQL
else
  echo "[db-init] creating LiteLLM role"
  psql_super --dbname "$POSTGRES_DB" -v litellm_password="$LITELLM_DB_PASSWORD" <<'EOSQL'
CREATE ROLE litellm WITH LOGIN PASSWORD :'litellm_password';
EOSQL
fi

db_exists="$(psql_super --dbname postgres --tuples-only --no-align \
  --command "SELECT 1 FROM pg_database WHERE datname = 'litellm'")"
if [ "$db_exists" = "1" ]; then
  echo "[db-init] LiteLLM database already exists; leaving it unchanged"
else
  echo "[db-init] creating LiteLLM database"
  psql_super --dbname postgres --command "CREATE DATABASE litellm OWNER litellm"
fi

echo "[db-init] LiteLLM role/database ready"
