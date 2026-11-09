-- 0029：per-user「文件上传」开关（issue #472 片 A）。
--
-- 背景：工位此前只有**出向**通道（预览 / 下载，portal.md §4.11），没有入向通道。
-- #472 补上传端点（片 B），并把「谁能往自己磁盘写文件」**交给管理员按用户决定**。
--
-- 默认 **false**（决策 1）：上传是**写入用户磁盘**的能力，与 TOTP / 邮件验证码同一口径
-- （迁移 0028 的邻居）—— 由管理员在管理台 Edit → Security 里**显式打开**，不默认放开。
-- 「显式优于隐式」：升级后没有任何人自动获得上传能力。
--
-- 幂等：与 0028 同形（`ADD COLUMN IF NOT EXISTS`），重放不报错（deploy/migrations/README.md 的单文件约定）。
-- 零回填：存量用户全部 false，不需要 UPDATE（不猜存量用户的意图）。
-- ⚠ `docs/data/schema.sql` 是冻结的 baseline（sha256 写进迁移台账），**一字节都不改**；
--    本列只走增量迁移。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS file_upload_enabled boolean NOT NULL DEFAULT false;
