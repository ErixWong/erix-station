-- 0028：per-user「邮件验证码」开关（#449 的第二个维度）。
--
-- 背景：`chooseSecondFactor` 原来只有**全局**维度（`mail_settings.transport` / `MAIL_TRANSPORT`）
-- ⇒ 一旦把通道开起来，所有**有邮箱**的用户都被强制走邮箱验证码，而 `admin` / `eric` 这类没有
-- 邮箱的账号直接被 409 `email_not_registered` 锁在门外（管理员当时连邮箱都看不到，见 2026-11-06 的修复）。
--
-- 决策（用户 2026-11-06 拍板）：「管理员设定某个用户是否需要启用邮件验证码，就像启用 TOTP 一样」。
-- 所以做成**显式 per-user 开关**，默认 **false**（不启用）：
--   · 全局 `transport=disabled` 仍然压过它（急停闸不该被单用户绕过）；
--   · 开关为 true 但 `email` 为空 ⇒ API 层拒绝保存（不让人把自己锁在门外）；
--   · 已绑 TOTP 的用户仍走 TOTP（更强的因素优先），本列不影响那条路径。
--
-- 默认 false 是有意的行为变化：升级后「开了全局邮件通道」不再自动要求所有用户输邮箱码，
-- 必须由管理员逐个启用。这正是「显式优于隐式」。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mail_otp_enabled boolean NOT NULL DEFAULT false;
