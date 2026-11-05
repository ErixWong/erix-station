-- 0026-login-email-codes.sql —— 登录第二因素「邮箱验证码」（issue #449，M1+M2 后端切片）
--
-- 要解决的问题：TOTP 是 **opt-in**（`users.totp_secret` 为空即跳过第二因素，`auth.hasTotpEnrollment`），
--   而现网账号都没注册 TOTP ⇒ 登录实际只有口令一层（`handleLogin` 的 `password_direct` 分支）。
--   本迁移给「未注册 TOTP」的账号补第二层：口令通过后发一枚 6 位邮箱验证码，校验通过才发会话。
--
-- 为什么是「另起一张表」而不是复用 `login_pending`：
--   `login_pending` 是第一步的**凭证本体**（`token_hash` 唯一、120s、单次原子消费），它的语义是
--   「这个浏览器走完了口令步」。验证码是**另一个可重试、可重发、有尝试上限**的对象：
--   * 同一 pending 下重发要换新码、旧码作废（一行一个码，最新一条有效）；
--   * 每次校验失败要落 `attempts`（码错不等于 pending 失效——用户还能接着试）；
--   * 重发次数（`resend_count`）与冷却要按 pending 累计。
--   把这三件事塞进 `login_pending` 会污染「单次消费」那条原子判据（#449 决策 1：TOTP 路径一字不改）。
--
-- 为什么不动 baseline `docs/data/schema.sql`：`portal/src/migrate.js` 对**整个 schema.sql 文本**
--   （含注释）算 sha256 做 `0000_baseline` 校验，且在增量迁移循环之前 ⇒ 改一个字节 = 现存库全部
--   `refusing to start`（AGENTS §8.7/§8.8）。新表一律走本目录的增量迁移。
--
-- 本文件还建第二张表 `mail_settings`（邮件通道配置，单行；决策者 2026-11-04：SMTP 参数由管理台维护、
--   存 DB 而不进 env）。两张表同属 #449 这一个切片：登录要发信，发信要 SMTP 参数。
--
-- 敏感面：`code_hash` 只存 sha256 hex，**绝不存明文码**；`pending_token_hash` 与 `login_pending.token_hash`
--   同值（sha256，不建 FK——`login_pending` 行会随登录会话建立被消费/过期清理，验证码行要留作审计证据）。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：`CREATE TABLE/INDEX IF NOT EXISTS`，
--   第二遍是零 DDL 空操作；末尾 DO 块只读，打印重放证据。

CREATE TABLE IF NOT EXISTS login_email_codes (
  id                  bigserial PRIMARY KEY,
  -- = sha256(pending_token)，与 login_pending.token_hash 同值；不建 FK（见头注释）。
  pending_token_hash  text NOT NULL,
  -- sha256(6 位数字码) hex；绝不存明文（审计只记前 12 位前缀）。
  code_hash           text NOT NULL,
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  attempts            int NOT NULL DEFAULT 0,
  max_attempts        int NOT NULL,
  resend_count        int NOT NULL DEFAULT 0,
  -- 单次消费：校验成功、或重发时作废旧码、或尝试次数用尽，都写这里。
  consumed_at         timestamptz,
  created_ip          text,
  created_ua          text
);

-- 读路径只有两条，都按 pending 取「最新一条」：校验取最新未消费、重发冷却取最新一条（含已消费）。
CREATE INDEX IF NOT EXISTS login_email_codes_pending_idx
  ON login_email_codes (pending_token_hash, created_at DESC);

-- 重放证据（纯读）：打印本表规模，第二遍应与第一遍一致（本迁移不动数据）。
DO $$
DECLARE n bigint; m bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM login_email_codes;
  SELECT COUNT(*) INTO m FROM login_email_codes WHERE consumed_at IS NULL;
  RAISE NOTICE '0026: login_email_codes 共 % 行 / 其中未消费 % 行', n, m;
END $$;

-- ---------------------------------------------------------------------------------------------------
-- mail_settings —— 邮件通道配置（单行表；issue #449，决策者 2026-11-04：SMTP 参数由管理台维护、存 DB）
--
-- 为什么落 DB 而不是 env：SMTP 主机/凭据/发件人是**运维日常要改的东西**，改一次 env 就要重建容器；
--   而且口令进 env 会跟着 compose 文件/compose 进程环境扩散（ps、docker inspect、日志都看得到）。
--   现在参数（含口令）存在本表单行，运行时由 `portal/src/mail-provider.js` 读一行 + 60s 缓存
--   （登录是热路径，不能每请求查库）。
--
-- 口令是**明文**（`smtp_password`）：目标是内网 email relay（邮件中转），口令价值低，
--   与既有 `git_hosts.admin_key`（迁移 0011）同一口径——一致性比一层本地加密更值钱；
--   将来换成公网 SMTP 再上加密列（另开迁移）。API/审计/日志仍然**永不返回口令明文**。
--
-- 单行：`id int PRIMARY KEY DEFAULT 1 CHECK (id = 1)` —— 用约束把「只能有一行」写成 DB 事实，
--   不靠应用自觉（两行配置 = 谁生效取决于 ORDER BY，那是不可调试的形态）。
--
-- `transport <> 'smtp'` 时必填项 CHECK：半套 SMTP 配置（有 host 没 from）不该能存进去，
--   否则错误会延迟到登录发信时才暴露。`disabled` 行可以什么都不填（= 本单上线时的默认形态）。
--   `smtp_user` / `smtp_password` **都可空**：内网 relay 常按来源 IP 放行、不需要认证。
--
-- `updated_by` 是 uuid 但**不建 FK**：管理员行被停用/删除后配置要留着（审计靠 updated_at + 日志），
--   建 FK 会让「删用户」被配置行拦住。
--
-- 幂等可重放：`CREATE TABLE IF NOT EXISTS`，第二遍零 DDL 空操作。

CREATE TABLE IF NOT EXISTS mail_settings (
  id                    int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  transport             text NOT NULL DEFAULT 'disabled' CHECK (transport IN ('disabled', 'smtp')),
  smtp_host             text,
  smtp_port             int,
  smtp_secure           boolean NOT NULL DEFAULT true,
  smtp_user             text,
  -- 内网 relay 口令（明文；与 `git_hosts.admin_key` 同口径，理由见头注释）。可空 = relay 不需要认证。
  smtp_password         text,
  smtp_from             text,
  connection_timeout_ms int NOT NULL DEFAULT 10000,
  greeting_timeout_ms   int NOT NULL DEFAULT 10000,
  socket_timeout_ms     int NOT NULL DEFAULT 20000,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid,
  -- 半套配置不许落库（能存进去的错误会拖到登录发信时才炸）。
  CHECK (transport <> 'smtp' OR (smtp_host IS NOT NULL AND smtp_from IS NOT NULL))
);

-- 重放证据（纯读）：第二遍应与第一遍一致。
DO $$
DECLARE n bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM mail_settings;
  RAISE NOTICE '0026: mail_settings 共 % 行（单行表，0 = 未配置）', n;
END $$;
