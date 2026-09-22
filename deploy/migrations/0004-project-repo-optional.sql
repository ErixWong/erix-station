-- 0004-project-repo-optional.sql —— issue #52：创建项目只需名字，仓库地址可选
-- 背景：平台不 clone 仓库、不下发凭据；repo_url 仅作可选登记元数据。
-- 幂等：ALTER COLUMN ... DROP NOT NULL 在 PostgreSQL 中重复执行仍保持同一结果。
ALTER TABLE projects ALTER COLUMN repo_url DROP NOT NULL;
