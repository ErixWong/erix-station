-- 0021-user-must-change-password.sql —— users 加「需改密」旗标（issue #255 首登强制改密，工单 feat-261013-03）
--
-- 治的是什么：管理员开户（`admin.js createUser`）**必须代设初始口令**（password 是必填字段），
-- 管理员重置口令（`admin.js resetUserPassword`）同样是「别人替你设了一个你知道的口令」。
-- 这两种情形之后，账号实际上一直跑在**别人知道的那枚口令**上，而库里此前**没有任何地方**能表达
-- 「这枚口令还没经过本人之手」——`docs/data/schema.sql` 的 `users` 只有 `password_hash`/`totp_secret`/
-- `last_totp_step`/`status`，没有「需改密」字段 ⇒ 本迁移补这一列。
--
-- 语义（portal.md §2.6a/§2.12）：
--   `must_change_password = true` ⇒ 该用户的会话是**受限会话**：除放行清单（`http.js` 的
--   `RESTRICTED_SESSION_ALLOWLIST`：读自己、改自己口令、登出、`/api/forward-auth`、`/api/internal/*`）
--   以外的 `/api/*` 一律 `403 password_change_required`；`POST /api/me/password` 成功后清回 false。
--
-- 谁会被置 true（口径与代码同源，见 `portal/test/must-change-password.test.js`）：
--   ① `createUser`（新建 + 同名 disabled 行重新激活，两条分支都置）——管理员代设初始口令 = 本单要治的场景；
--   ② `resetUserPassword`（管理员重置）。
--   ⚠ **`cli.js bootstrap-admin` 不置 true**：那条路径是「运维自己给自己设的第一个 admin」，口令从 CLI
--   一次性打印给的就是本人；把它锁进改密屏会让 dev/CI 的 bootstrap 账号（`admin`/`eric` 这类，AGENTS §4.1）
--   在没有任何 UI 的形态下直接不可用。所以 bootstrap 的 INSERT **不写这一列**，吃 DB 默认值 false——
--   「不置 true」是靠默认值实现的，因此**默认值本身是契约**，下面那条守卫把它钉住。
--
-- 存量行（本迁移之前已存在的用户）：`DEFAULT false` ⇒ 全部保持 false。
--   这是**刻意的**，不是漏了回填：本单的判据是「从现在起被代设口令的人要改密」，把历史用户一次性置 true
--   会让每个已部署环境一升级就全员被锁进改密屏（前端界面不在本单，锁了就没有出口），属行为变更而非缺陷修复。
--   需要「上线即全员改密」时另出一条显式数据迁移，别改本文件（已应用迁移不可再改，见 README）。
--
-- 幂等（README「单文件约定」，本文件可整体重放）：`ADD COLUMN IF NOT EXISTS` ⇒ 第二次跑是零 DDL 空操作，
--   不报错、不改任何行、不重写表（PG 11+ 对 `ADD COLUMN ... DEFAULT <常量>` 走 attmissingval，
--   不做全表 rewrite ⇒ `users` 再大也不锁全表）；后置守卫只读不写 ⇒ 重放可反复跑。
--
-- 冻结 baseline：`docs/data/schema.sql` **一个字节不改**（`migrate.js:138` 对整文件文本算 sha256，
--   失配即 `refusing to start`；同 0017/0018/0019 的手法，新 DDL 只走增量文件）。
SET lock_timeout = '5s';

-- ① 加列。`NOT NULL DEFAULT false`：布尔旗标不留三态——「不知道要不要改密」不是有意义的状态，
--   而且 NULL 会让下面 ② 的默认值守卫与门判定（`session.user.must_change_password === true`）都要多写一层
--   COALESCE，漏一处就是「有人永远不被要求改密」这种静默失效。
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

-- ② 守卫（自证，纯读）：列不存在 / 不是 NOT NULL / 默认值不是 false，都当场炸掉并写明后果，
--    而不是让「置 true 的写入」与「不置 true 的 bootstrap」两侧静默漂移。
--    触发条件示例：有人在中间手改过该列（去掉了默认值 ⇒ 新行会当场 23502，而 bootstrap-admin 会直接起不来）。
DO $do$
DECLARE
  has_not_null   boolean;
  default_text   text;
BEGIN
  SELECT (attnotnull), pg_get_expr(d.adbin, d.adrelid)
    INTO has_not_null, default_text
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'users'::regclass
     AND a.attname  = 'must_change_password'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF has_not_null IS NULL THEN
    RAISE EXCEPTION '0021: users.must_change_password 不存在（ALTER 未生效？），受限会话门与首登改密全部失效';
  END IF;
  IF has_not_null IS NOT TRUE THEN
    RAISE EXCEPTION '0021: users.must_change_password 不是 NOT NULL（旗标出现三态，门判定会静默放行）';
  END IF;
  IF default_text IS NULL OR default_text !~* 'false' THEN
    RAISE EXCEPTION '0021: users.must_change_password 的默认值不是 false（实际 %）——cli.js bootstrap-admin 与存量行都靠默认值保持 false，默认值变了就等于把 bootstrap/dev/CI 账号锁进改密屏', COALESCE(default_text, '<无默认值>');
  END IF;
END
$do$;

-- ③ 观测（纯读，可重放）：重放到第二遍时这条 NOTICE 的计数不变，就是「本迁移不改任何存量行」的证据。
DO $do$
DECLARE
  n_pending int;
  n_total   int;
BEGIN
  SELECT count(*) FILTER (WHERE must_change_password), count(*)
    INTO n_pending, n_total
    FROM users;
  RAISE NOTICE '0021: users 共 % 行，其中 must_change_password=true % 行（存量行按 DEFAULT false 保持 false，本迁移不回填）', n_total, n_pending;
END
$do$;
