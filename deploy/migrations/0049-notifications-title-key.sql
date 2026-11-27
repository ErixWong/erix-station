-- 0049-notifications-title-key.sql —— 通知标题存「键 + 参数」（issue #850，工单 850-notify-keys）
--
-- 病：有一类文字**写进数据库、以后谁看都是当初那一份**——通知标题。写入方常常是**调度器**
--   （没有人、没有请求、没有语言），所以「给写入方塞一个 locale」是把问题搬家；正解是
--   **存键 + 参数，渲染时按读者当前语言拼**（读者侧 i18n，见 `MacroBell.vue`）。
--
-- 语义（两列都可空，NULL = 「这条没有键，请照旧用 title」）：
--   * `title_key`：i18n 键（`notifications.macroExpired` 这类），**不是**成品句子。
--   * `title_params`：填键里占位符的参数（`{"name":"每日 9 点"}`），jsonb 而不是 text：
--     读侧要按名字取值，text 得自己 parse 并把格式错误变成运行时红。
--   * `title` **不动**（`NOT NULL` 保留，见下）：存量行只有成品中文，旧读侧行为逐字不变。
--
-- 为什么**不**把 `title` 改成可空：那会让「老库 + 新代码」「新库 + 老代码」两条路上都可能出现
--   `title IS NULL`，而老读侧（`toNotificationSnapshot` 直接透出 `title`）会把它渲染成空白——
--   面铺得越大越难证明「存量行逐字不变」。`title` 继续写成品中文（回退面），两列是**增量**。
--
-- 值域（键名必须在前端 locales 里登记过）是**策略**，由读侧 `te()` 兜底挡（没登记 ⇒ 退回 `title`），
--   与 0048 同一分层：不写 DB CHECK，否则手工插入一个实验键这条判据在真机上根本进不去。
--
-- 单文件约定（`deploy/migrations/README.md`）：幂等可整体重放（`ADD COLUMN IF NOT EXISTS` ⇒ 重复执行零变化）、
--   **自己不写 `BEGIN/COMMIT`**（事务边界归 runner）、`SET lock_timeout` 照 0016 的纪律；
--   末尾 DO 块**只读**，打印重放证据（键缺席是正常态：存量行与回退面都是 `NULL`，NOTICE 不是 EXCEPTION）。

SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS title_key text;

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS title_params jsonb;

-- 重放证据（只读）：`title_key IS NULL` = 存量行 = 照旧渲染 `title`，不是异常。
DO $do$
DECLARE
  total bigint;
  keyed bigint;
BEGIN
  SELECT count(*) INTO total FROM notifications;
  SELECT count(*) INTO keyed FROM notifications WHERE title_key IS NOT NULL;
  RAISE NOTICE '0049: notifications 总数=%，带 title_key=%（其余照旧用 title）', total, keyed;
END $do$;
