-- 0024-git-token-plaintext.sql —— fde_git_accounts 加 `token`：平台代铸的 Git token 明文落库（issue #395）
--
-- 治的是什么（现网实证，2026-10-25）：`minted` 模式下 portal 用 `git_hosts.admin_key` 向 Gitea 代铸一枚
-- per-FDE token，`provisioner.js` 拿到 `minted.tokenPlaintext` 之后**只投放到 FDE 的 `~/.git-credentials`**
-- 就把它丢了，库里 `token_ref` 存的是 Gitea 侧的 token **ID**（用于吊销寻址），不是 secret。于是那枚明文
-- 的唯一副本落在**用户态、agent 可写**的文件里。真机结果：FDE `eric` 的 agent 在配 GitHub 凭据时整文件重写
-- （`>` 而非 `>>`）把 gitea 那行冲掉 ⇒ 平台作为铸币方**既没有副本、也不会自愈**（`provisioner.js:720`
-- 的存在性判据是 `token_ref` 非空，与文件真实状态脱钩），只能人肉进容器补。
--
-- 为什么是**明文**而不是密文：同一个库里 `git_hosts.admin_key`（`0011`）本就是裸 `text`，而它的权限比任何
-- 单枚 per-FDE token 都大——一把能铸/吊销所有人 token 的钥匙都明文存着，再单独给 per-FDE token 套一层加密
-- 只会在旁边长出第二个会过期的真相源（加解密 key 放哪、谁轮换、轮换后怎么迁移存量）。两者威胁模型完全一致：
-- 能读 DB 的 == 能读用户空间根的，`docs/design/user-space.md` §「物化面」早已把「宿主侧进程可读取 Git token
-- 明文」列为**已接受的残余风险**。既然后果同等，就不值得为它单独引一套密钥生命周期。
--
-- 为什么**可空**而不是 NOT NULL：`mode` 在 `git_hosts` 上，跨表 CHECK（"minted  ⇒ token 必非空"）写不成，
-- 而为它引 trigger 不值。三态各有明确语义，不是"忘了填"：
--   `token IS NOT NULL` ⇒ 平台持有明文副本，具备重投能力（minted 正常态、以及 per_fde_pat 下由 portal/API
--                         提交的凭据——`setGitCredential` 本来就见过明文，存了才有重投能力）；
--   `token IS NULL`     ⇒ 平台**没有**副本，文件丢了只能重铸或重新提交凭据。`per_fde_pat` 模式下 FDE 自行
--                         在容器里配的密钥（平台从未持有明文）与 #395 上线前的存量行都属此类，**语义就是
--                         「我不知道那枚 token 是什么」，别用空串冒充**（空串会让「无副本」和「副本是空」混
--                         成一个值，而下面那条 CHECK 会把空串当场拒掉）。
--
-- 本迁移**不回填**：明文在文件系统（`<userSpaceRoot>/<fde>/home/.git-credentials`）里，SQL 到不了。
--   回填是 `cli.js backfill-git-tokens` 的活（幂等、只填 NULL 行、填不上就留着 NULL）。已应用迁移不可再改
--   （migrations/README），所以"上线即有副本"这件事在文档里说一次、在 CLI 里做一次，不在这里做。
--
-- 出参面（本迁移不实现，但记在这里防漂移，实现见 #395 的写入点收口）：`token` **永不**进 API 响应、
--   `audit_log.details`、日志与错误消息，一律走 `git-credential.js` 的 `maskToken()`——与 `git_hosts.admin_key`
--   的既有契约（`git-hosts.js` 首行：「列表与更新响应永远只返回掩码」）同一条红线，两者应并进同一组测试。
--
-- 幂等（README「单文件约定」，本文件可整体重放）：① `ADD COLUMN IF NOT EXISTS` ⇒ 第二次跑零 DDL 空操作，
--   PG 11+ 对 `ADD COLUMN`（无默认值 ⇒ attmissingval 都不用）不重写表，`fde_git_accounts` 至多每 FDE 一行；
--   ② 是 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` 的头尾配对（先例 `0019`），重放等价；
--   ③④ 纯读守卫/观测 ⇒ 可反复跑。
--
-- 冻结 baseline：`docs/data/schema.sql` **一个字节不改**（`migrate.js` 对整文件文本算 sha256，失配即拒启动）。
-- 授权：station_portal 的 DML 由 baseline 的 ALTER DEFAULT PRIVILEGES 自动覆盖，本文件不写 GRANT。
SET lock_timeout = '5s';

-- ① 加列。无默认值 ⇒ 存量行一律 NULL（= "平台没有副本"，正是存量环境的真实状态，不是漏回填）。
ALTER TABLE fde_git_accounts ADD COLUMN IF NOT EXISTS token text;

-- ② 形状守卫：长度上限与代码侧同源（`git-credential.js` 的 `MAX_TOKEN_LENGTH = 4096`）。
--    这里防的不是"token 太长"这种业务问题，而是**整份凭据文件被当成 token 塞进库**这类调用侧事故
--    （一次 PUT 传错字段就能发生）：没有上限，这类脏数据会静默躺在库里，等到重投时才在文件里长成一行
--    永远匹配不上的垃圾。空串一并拒掉，理由见文件头「三态」段。
ALTER TABLE fde_git_accounts DROP CONSTRAINT IF EXISTS fde_git_accounts_token_shape;
ALTER TABLE fde_git_accounts ADD CONSTRAINT fde_git_accounts_token_shape
  CHECK (token IS NULL OR (token <> '' AND length(token) <= 4096));

-- ③ 守卫（自证，纯读）：列必须存在、可空、无默认值。
--    "可空"与"无默认值"是契约而不是疏忽：`updateAssignedAccount` 与吊销路径要靠 `token IS NULL` 表达
--    「平台无副本」，若哪天有人给它加了默认值或 NOT NULL，回填/重投两侧都会静默退化成"每行都有个假副本"。
DO $do$
DECLARE
  has_not_null boolean;
  default_text text;
BEGIN
  SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO has_not_null, default_text
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'fde_git_accounts'::regclass
     AND a.attname  = 'token'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF has_not_null IS NULL THEN
    RAISE EXCEPTION '0024: fde_git_accounts.token 不存在（ALTER 未生效？），minted 模式的凭据重投能力全部失效';
  END IF;
  IF has_not_null IS TRUE THEN
    RAISE EXCEPTION '0024: fde_git_accounts.token 被改成了 NOT NULL——per_fde_pat 与 #395 之前的存量行必须是 NULL（"平台无副本"），NOT NULL 会让它们无法存在';
  END IF;
  IF default_text IS NOT NULL THEN
    RAISE EXCEPTION '0024: fde_git_accounts.token 不该有默认值（实际 %）——NULL 是"平台无副本"的唯一表达，给了默认值就等于给每行造了个假副本', default_text;
  END IF;
END
$do$;

-- ④ 观测（纯读，可重放）：本迁移不回填，所以刚跑完时"有副本"的行数应当**只增自 CLI 回填**，
--    与 minted 账号总数对比即知还差几行需要回填或重铸。
DO $do$
DECLARE
  n_minted   int;
  n_with     int;
  n_total    int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE t.token IS NOT NULL),
         count(*) FILTER (WHERE h.mode = 'minted')
    INTO n_total, n_with, n_minted
    FROM fde_git_accounts t
    JOIN git_hosts h ON h.id = t.git_host_id;
  RAISE NOTICE '0024: fde_git_accounts 共 % 行，其中持有明文副本 % 行；minted 模式账号 % 个（本迁移不回填，差额由 cli.js backfill-git-tokens 或重铸补齐）',
    n_total, n_with, n_minted;
END
$do$;
