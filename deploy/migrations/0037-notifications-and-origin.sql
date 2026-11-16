-- 0036-notifications-and-origin.sql —— 事件平台 W3：通知表 + 会话来源列（issue #526）
--
-- 要解决的问题：W1/W2 把「宏跑没跑、结果如何」记进了 `macro_runs`，但**人**这一侧还缺两件事：
--   1. 跑完之后谁该被通知、通知读没读——没有 `notifications` 表，面板的铃铛与软删判定
--      （`macros.js` `countTemplateNotifications` 的 `// TODO(W3)`）都没有真相可查。
--   2. 侧栏「自动化」分组要按 `origin LIKE 'macro:%'` 过滤（07 篇 §21.4），
--      但 `chat_sessions` 没有 `origin` 列——0035 漏了，10 篇 §4 第 4 条把补列归本单。
--
-- `notifications` 设计口径：
--   * `id` 是站内短字符串 id（VARCHAR(32)，应用侧生成，见 `notifications.js`），
--     不是 uuid：通知是给用户面 API 寻址的资源，短 id 直接进 URL / 前端 store。
--   * 时间字段应用侧写（AGENTS.md §3.4：DDL 不写 DEFAULT CURRENT_TIMESTAMP）——
--     写入者（W2 循环 / API）可能带自己的时钟，DB 默认值会把「谁写的时间」含糊掉。
--   * `severity` 由**收件人 + 结果**推导（10 篇 §3.4），不由动作类型推导：
--     投递成功且收件人含当前用户 ⇒ `info`；投递失败且收件人含当前用户 ⇒ `error`；
--     收件人只有管理员 ⇒ **不写本表**（只进执行历史）。CHECK 穷举两值，漂移即拒。
--   * `macro_run_id` 可空且 ON DELETE SET NULL：执行账被清理时通知要留着（通知是用户资产），
--     引用可以断，行不能消失——口径照 `macro_runs.child_session_id`。
--   * `user_id` FK 不带 ON DELETE（口径照 `chat_sessions.user_id` / `macro_runs`）：
--     删号不顺手抹通知，删除策略在别处统一管。
--
-- 幂等可重放（README：已应用迁移不可再改，本文件必须整体重放安全）：
-- 全部 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`，第二遍是零 DDL 空操作。

CREATE TABLE IF NOT EXISTS notifications (
  id            VARCHAR(32) PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users (id),
  macro_run_id  uuid REFERENCES macro_runs (id) ON DELETE SET NULL,
  severity      text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'error')),
  title         text NOT NULL CHECK (btrim(title) <> ''),
  body          text NOT NULL DEFAULT '',
  -- NULL = 未读；已读时刻应用侧写。
  read_at       timestamptz,
  created_at    timestamptz NOT NULL
);

-- 列表主路径：按人倒序翻页（keyset 分页按 (created_at, id) 走，见 notifications.js）。
CREATE INDEX IF NOT EXISTS notifications_user_created_idx
    ON notifications (user_id, created_at DESC);
-- 铃铛角标：未读数只扫未读部分。
CREATE INDEX IF NOT EXISTS notifications_user_unread_idx
    ON notifications (user_id) WHERE read_at IS NULL;
-- 「这条执行账发过哪些通知」反查（软删判定 / 排查重复投递）。
CREATE INDEX IF NOT EXISTS notifications_macro_run_idx
    ON notifications (macro_run_id) WHERE macro_run_id IS NOT NULL;

-- 会话来源（10 篇 §4 第 4 条）：`human`（默认）/ `macro:<template-name>`。
-- 写入侧（建宏会话时写 `origin='macro:<name>'`）归 W7；本单只补列 + 投影下发。
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'human';

-- 后置守卫（照 0035 惯例）：CHECK 集合是契约，漂了就拒绝启动。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'notifications'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%severity%'
                AND pg_get_constraintdef(oid) NOT LIKE '%error%') THEN
    RAISE EXCEPTION '0036: notifications.severity 的 CHECK 漂移（缺 error）';
  END IF;
END $$;

-- 重放证据（纯读）：第二遍应与第一遍一致（本迁移不动数据）。
DO $$
DECLARE n bigint; o bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM notifications;
  SELECT COUNT(*) INTO o FROM chat_sessions WHERE origin <> 'human';
  RAISE NOTICE '0036: notifications % 行 / 非 human 来源会话 % 行', n, o;
END $$;
