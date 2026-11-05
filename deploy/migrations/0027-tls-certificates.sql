-- 0027-tls-certificates.sql —— 管理台证书生命周期的**审计/历史**表（issue #456，M1 后端切片）
--
-- 要解决的问题：管理台入口（#450 A1/D5）的证书今天是运维手工登服务器放文件，换证/回滚/「到底装了什么」
--   全靠人记。本单把上传/校验/回滚搬进管理台，需要一张表回答「谁在什么时候装了什么证书」。
--
-- ⚠ **本表不是真相源，盘上的证书文件才是**（`<dynamic>/certs/tls.crt` / `tls.key`，由
--   `portal/src/tlsassets.js` 物化 `<dynamic>/tls.yml`）。理由：
--   * Traefik 只认文件（file provider），DB 里再准也换不了线上握手；
--   * 私钥**只落盘**（0600、属主 = Traefik uid），绝不进 DB / 日志 / 审计 / 响应（#456 红线）；
--   * 所以「当前生效的是哪张证书」的答案必须由**读盘**给出（GET /api/admin/tls 就是这么做的），
--     本表只回答「历史上有谁装过什么」——两者不一致时以盘为准，且这种不一致本身就是运维线索。
--
-- 为什么还要存 `fingerprint_sha256`：与 Node `X509Certificate.fingerprint256` /
--   `tls.getPeerCertificate().fingerprint256` **同形**（冒号分隔大写十六进制），这样
--   「盘上证书指纹 == 真机握手拿到的指纹 == 台账里那一行」三者可以直接逐字符比对（verify 端点的判据）。
--
-- `kind`：`upload` = 管理员上传/更新；`rollback` = 回滚到 `certs/prev/` 里的上一代。
--   两态用 CHECK 钉住，别让将来「自动续期」之类的第三种来源悄悄塞进来（那是另一单的事）。
--
-- `uploaded_by` 用 `ON DELETE SET NULL`：管理员账号被停用/删除后历史行要留着（审计证据），
--   但也不能因为删用户而撞 FK（与 0025 / 0026 的口径一致）。
--
-- 零 baseline 回写：`docs/data/schema.sql` 一个字节都不许改——`portal/src/migrate.js` 对**整份文本**
--   （含注释）算 sha256 做 `0000_baseline` 校验，改一个字节 = 现存库全部 `refusing to start`
--   （AGENTS §8.7/§8.8）。新表一律走本目录的增量迁移。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：`CREATE TABLE/INDEX IF NOT EXISTS`，
--   第二遍是零 DDL 空操作；末尾 DO 块只读，打印重放证据。

CREATE TABLE IF NOT EXISTS tls_certificates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 证书主体 CN（可能为空：现代证书允许只有 SAN、没有 CN）。
  subject_cn         text,
  -- SAN 里的 DNS 名（不含 `DNS:` 前缀，小写不强制——原样保留证书里的写法）。
  sans               text[] NOT NULL DEFAULT '{}',
  issuer_cn          text,
  not_before         timestamptz,
  not_after          timestamptz,
  -- 冒号分隔大写（与 Node getPeerCertificate().fingerprint256 同形，见头注释）。
  fingerprint_sha256 text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('upload', 'rollback')),
  uploaded_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  uploaded_at        timestamptz NOT NULL DEFAULT now()
);

-- 读路径只有一条：按时间倒序看最近装过什么（管理台历史 / 运维排查）。DESC 与查询方向一致。
CREATE INDEX IF NOT EXISTS tls_certificates_uploaded_at_idx
  ON tls_certificates (uploaded_at DESC);

-- 重放证据（纯读）：打印本表规模，第二遍应与第一遍一致（本迁移不动数据）。
DO $$
DECLARE n bigint; u bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM tls_certificates;
  SELECT COUNT(*) INTO u FROM tls_certificates WHERE kind = 'upload';
  RAISE NOTICE '0027: tls_certificates 共 % 行（其中 upload % 行）', n, u;
END $$;
