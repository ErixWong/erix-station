#!/bin/sh
# ============================================================================
# station-db 首次初始化（postgres 镜像 entrypoint 以超级用户 POSTGRES_USER 执行一次，
#   仅在数据目录为空时运行；deploy-contract.md §2.4/§3、docs/env.md §0/§10）
# ----------------------------------------------------------------------------
# 职责（一次性 superuser bootstrap，口令/ownership 归部署侧，不进仓库）：
#   1) 应用 schema.sql（baseline）：幂等建角色 + 建表 + 落 schema_migrations + 授
#      station_portal 最小 DML（schema.sql 自带 BEGIN..COMMIT）。
#   2) 设置 station_platform / station_portal 口令（来自 600 权限的 deploy/.env，
#      经 station-db 容器 env 注入；deploy-contract §2.4）。
#   3) 把 baseline 哨兵 checksum 回填为真实 sha256（与 portal migrate.js 的
#      sha256(schema.sql) 计算口径一致，防改历史，deploy-contract §3.2）。
#   4) 应用 bootstrap.sql：schema 级授权 + 角色属性兜底 + 表/序列 ownership 归正到
#      station_platform（幂等，可重复执行）。
# ============================================================================
set -eu

: "${POSTGRES_USER:?POSTGRES_USER 未设置}"
: "${POSTGRES_DB:?POSTGRES_DB 未设置}"
: "${PLATFORM_DB_PASSWORD:?PLATFORM_DB_PASSWORD 未设置}"
: "${PORTAL_DB_PASSWORD:?PORTAL_DB_PASSWORD 未设置}"

psql_super() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

echo "[db-init] applying schema.sql (baseline)"
psql_super -f /init-sql/schema.sql

echo "[db-init] setting role passwords (station_platform / station_portal)"
psql_super \
  -v platform_password="$PLATFORM_DB_PASSWORD" \
  -v portal_password="$PORTAL_DB_PASSWORD" <<'EOSQL'
ALTER ROLE station_platform PASSWORD :'platform_password';
ALTER ROLE station_portal PASSWORD :'portal_password';
EOSQL

echo "[db-init] recording baseline checksum (sha256 of schema.sql)"
REAL_CHECKSUM="sha256:$(sha256sum /init-sql/schema.sql | cut -d' ' -f1)"
psql_super -c "UPDATE schema_migrations SET checksum = '$REAL_CHECKSUM' WHERE version = '0000_baseline'"

echo "[db-init] applying bootstrap.sql (schema grants + ownership)"
psql_super -f /init-sql/bootstrap.sql

echo "[db-init] tightening cross-db CONNECT (roles only reach station, not postgres/template1)"
psql_super -c "REVOKE CONNECT ON DATABASE postgres FROM PUBLIC"
psql_super -c "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC"

echo "[db-init] done"
