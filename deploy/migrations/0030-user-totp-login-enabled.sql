-- 0030：第二因素里「**允许用 TOTP 登录**」这一维单独成列（工单 feat-261110-02）。
--
-- 背景：`totp_secret IS NOT NULL`（即 `totp_enabled`）说的是**这个账号绑过验证器**，
-- 而登录该不该走 TOTP 一直是从这一位直接推出来的（`hasTotpEnrollment` ⇒ `totp_required`）。
-- 于是「绑过」和「允许用」被压成一位，管理员想改成「密钥留着，但登录只走邮箱验证码」做不到
-- ——要么重绑、要么删密钥（丢历史），没有第三条路。
--
-- 本列把这两件事分开：
--   `totp_enabled`（既有，= `totp_secret IS NOT NULL`）  = 密钥在不在
--   `totp_login_enabled`（本迁移）                       = 登录允不允许用它
-- ⇒ 关掉这一位**不清密钥**（`totp_secret` 一字不动），随时可以再打开；重绑/重置的语义也不变。
--
-- 默认 **true**（关键）：存量 TOTP 用户在升级后行为**一字不变**（绑了就是能用），
-- 零回填、零 UPDATE —— 不猜任何存量用户的意图。只有管理员显式关掉才改变登录路径。
--
-- 幂等：与 0028 / 0029 同形（`ADD COLUMN IF NOT EXISTS`），重放不报错（deploy/migrations/README.md 的单文件约定）。
-- ⚠ `docs/data/schema.sql` 是冻结的 baseline（sha256 写进迁移台账），**一字节都不改**；本列只走增量迁移。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_login_enabled boolean NOT NULL DEFAULT true;
