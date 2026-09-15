-- ============================================================================
-- FDE Station · station-db 生产环境附加初始化脚本
-- ----------------------------------------------------------------------------
-- 依据：docs/design/deploy-contract.md §2.4 / §3（迁移身份与运行身份分离）
-- 执行身份：bootstrap 超级用户（postgres:16 镜像的 POSTGRES_USER）
--
-- 与 schema.sql 的关系 / 执行顺序：
--   - docs/data/schema.sql **自包含、可单独执行**：开头已幂等创建
--     station_platform / station_portal 两个角色（schema.sql §0），空库
--     `psql -f` 端到端成功；本文件**不是** schema.sql 的前置条件。
--   - 本文件 = 生产环境的**附加初始化**：schema 级授权 + 环境特有设置（口令、
--     ownership、扩展/权限微调等**不进仓库**的部分）。可在 schema.sql 之后执行，
--     与 schema.sql 无顺序冲突；也可单独执行（自身幂等）。
-- 幂等：可重复执行（已存在的角色/授权跳过或置为同值）。
--
-- 职责边界：
--   - 本文件只做「角色幂等声明 + 数据库/schema 级授权」，不建任何业务表。
--   - 表级 DML GRANT 在 schema.sql §10 由表 owner 授出（本文件不重复）。
--   - 两个角色的密码不进仓库：由部署侧经 env_file（600）以
--     `ALTER ROLE ... PASSWORD '...'` 设置（deploy-contract §2.4）。
--   - 表 ownership 归正（若曾单独以超级用户执行 schema.sql）：部署侧
--     `ALTER TABLE ... OWNER TO station_platform`。
-- ============================================================================

-- station_platform：DDL/迁移专用（执行 schema.sql 与 deploy/migrations/*）。
-- station_portal：运行时 DML 专用（portal 业务连接；不授 DDL）。
-- 幂等创建（psql \gexec：仅当角色不存在时才生成 CREATE ROLE）。
SELECT 'CREATE ROLE station_platform LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'station_platform')
\gexec

SELECT 'CREATE ROLE station_portal LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'station_portal')
\gexec

-- 数据库连接权（默认 PUBLIC 已可 CONNECT，此处显式声明最小化面；如需收紧可 REVOKE FROM PUBLIC）。
SELECT format('GRANT CONNECT ON DATABASE %I TO station_platform, station_portal', current_database())
\gexec

-- schema 级授权（本数据库的 public schema）：
--   station_platform 需要 CREATE（PG15+ 已默认回收 public 的 CREATE）与 USAGE 才能建表；
--   station_portal 只需 USAGE（表级 DML 在 schema.sql §10 授出）。
GRANT CREATE, USAGE ON SCHEMA public TO station_platform;
GRANT USAGE ON SCHEMA public TO station_portal;
