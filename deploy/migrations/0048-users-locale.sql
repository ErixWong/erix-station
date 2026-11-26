-- 0048-users-locale.sql —— 账号级语言偏好 `users.locale`
--
-- 出处：issue #828 P1（工单 feat-261126-09）。
--
-- 要什么（推翻 #101 当年「语言偏好不上传服务端 / 不建用户表字段」的决定，本单就是这条改判的记录）：
--   偏好原本**只存浏览器**（同站 cookie `locale` + `localStorage` 兜底，#804）。换设备 / 换浏览器 /
--   清站点数据 / 隐身窗口都要重选一次。这一列是**跨设备的真相**：下次登录由登录响应带回来，前端再灌进
--   cookie（**库是真相、cookie 是载体**；服务端仍不查库定语言，理由见 issue「为什么不查库」）。
--
-- 语义（issue §语义 的实现契约）：
--   * 可空，`NULL` = 「没设过」= **跟随浏览器**。优先级链的最高一档由前端落 cookie，服务端只存不管谈判。
--   * 只收 `zh-CN` / `en` 两档；**不引入第三个「自动」哨兵值**——「跟随浏览器」就是 `NULL`，
--     别再造 `'auto'` 字符串（否则「用户显式选了中文」和「没设过」会分不清）。
--
-- 为什么**不写 CHECK 约束**（与 0046 同一分层，0036 的头注释把这条账算过一遍，这里照抄）：
--   值域（只收 `zh-CN`/`en`）是**策略**，由写侧的白名单归一化挡（`db.js` 的 `normalizeUserLocale`：
--   `en-US`/`en-GB`→`en`、`zh`/`zh-Hans`/`zh_CN`→`zh-CN`、空串→`null`，其余 400）。
--   把它写进 DB CHECK 的后果：「库里有一行但值非法 ⇒ 读侧回落浏览器」这条判据在真机上根本进不去
--   （手工 `UPDATE` 一个脏值会被 CHECK 拒），判据就只剩单测。列宽 `VARCHAR(8)` 只是防「把整段话写进这列」
--   的结构护栏（`zh-CN`=5、`en`=2 都在内），**不是**值域约束。
--
-- 单文件约定（`deploy/migrations/README.md`）：幂等可整体重放（`ADD COLUMN IF NOT EXISTS` ⇒ 重复执行零变化）、
--   **自己不写 `BEGIN/COMMIT`**（事务边界归 runner）、`SET lock_timeout` 照 0016 的纪律；
--   末尾 DO 块**只读**，打印重放证据（`NULL` 计数是正常态：绝大多数账号从未设过 ⇒ NOTICE，不是 EXCEPTION）。

SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale VARCHAR(8);

-- 重放证据（只读）：`locale IS NULL` = 「跟随浏览器」= 上线时的默认形态，不是异常。
DO $do$
DECLARE
  total bigint;
  unset bigint;
BEGIN
  SELECT count(*) INTO total FROM users;
  SELECT count(*) INTO unset FROM users WHERE locale IS NULL;
  RAISE NOTICE '0048: users 总数=%，locale 未设（NULL，跟随浏览器）=%', total, unset;
END $do$;
