-- 0031：`users.last_activity_at` —— 该用户**最近一次亲口说话**的时刻（issue #497，工单 feat-261112-01，方案 A3）。
--
-- 治的是什么：管理台此前只有 `last_login_at`（= `login_sessions` 里最新的 `created_at`，语义是
-- 「最近一次把门推开」）。它回答不了管理员真正想问的那句「**这个人还在用吗**」——
-- 页面刷新/重开会写它、自动续期也会写它，而一句话没说的人可以天天「登录」。
-- 于是「活跃度」这一维此前是**缺的**，不是不准。
--
-- 口径（定稿，A3）：`last_activity_at` = 该用户最近一次**用户输入**落库的时刻，即**按下发送那一刻**。
--   写入点**只有两处**（两处都已有 `userId`、都已在事务内，刻意不加第三处）：
--     ① `portal/src/sessions.js` 的 `postMessage` —— 本站唯一发送路（直发与队列投递都走它）；
--     ② `portal/src/queued-inputs.js` 的 `enqueueQueuedInput` —— 任务运行中按回车那一刻就是活动
--       （那句话此刻已经落进 `queued_inputs`，与「稍后被投递」无关）。
--   **不算**活动：agent 自己跑动（run 生命周期与终态）、页面刷新/重开、改名与归档、预览访问、
--   程序化 token（`api_tokens`）、以及**登录本身**。
--   ⇒ 因此它**允许比 `last_login_at` 旧**（登录了但一句话没说）。这是设计意图，不是 bug：
--     两条独立的时间线各有语义，别在登录路径「顺手」补写，那会把它退回成第二个 `last_login_at`。
--
-- 形态（可空、无默认值、不建索引）：
--   · **可空**：新开户与「从来没说过话」的账号就该是 NULL ⇒ 界面上「从未活动」与「从未登录」
--     是两个措辞（`docs/api/portal.md` §12）；`NOT NULL` 会逼出一个假哨兵值并让这两种「从未」分不开。
--   · **无 DEFAULT**：不给 `DEFAULT now()`，否则新建的每个账号都凭空得到一个「活动时刻」，
--     而那一刻它其实什么都还没说。
--   · **不建索引**：本列只作**返回列**，不参与任何过滤/排序（`last_login_at` 同样没有索引）；
--     多一颗索引 = 每次发消息多写一颗树，而这正是本列唯一的高频写路径。
--
-- 一次性回填：**只动 `last_activity_at IS NULL` 的行** ⇒ 第二遍重放必然 0 行（README「单文件约定」：
--   已应用的迁移不可再改，所以本文件必须自己可重放）。取 `messages` 中
--   `role = 'user' AND synthetic = false` 的 `MAX(created_at)`，join `chat_sessions` 拿 `user_id`。
--   · `synthetic = false` 是口径的一部分：宿主注入的合成行（judge/wrapup）不是人说的话；
--   · 回填后**仍然没有用户消息的账号保持 NULL** —— 不拿 `last_login_at` 或 `created_at` 冒充活动，
--     那是另一条时间线（上面那条 ⚠），宁可留空也不猜。
--
-- ⚠ `docs/data/schema.sql` 是**冻结的 baseline**（sha256 写进迁移台账，改一字节现存库全部拒启），
--   **一字节都不改**；本列只走增量迁移，口径写进 `docs/data/model.md` §1.1。静态断言见
--   `portal/test/migrations.test.js`。
SET lock_timeout = '5s';

-- ① 加列。可空 + 无默认值：见上面「形态」。
--   `ADD COLUMN IF NOT EXISTS` ⇒ 第二遍是零 DDL 空操作（PG 11+ 加可空无默认列只改目录，不重写表）。
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;

-- ② 一次性回填（只写 NULL 行；重放第二遍 = 0 行）。
--   写在 DO 块里只为了拿到 `GET DIAGNOSTICS ROW_COUNT` 作**重放证据**——语句本身是普通集合 UPDATE。
DO $do$
DECLARE
  n_updated int;
BEGIN
  UPDATE users AS u
     SET last_activity_at = s.last_at
    FROM (
      SELECT cs.user_id, MAX(m.created_at) AS last_at
        FROM messages m
        JOIN chat_sessions cs ON cs.id = m.session_id
       WHERE m.role = 'user'
         AND m.synthetic = false
       GROUP BY cs.user_id
    ) AS s
   WHERE u.id = s.user_id
     AND u.last_activity_at IS NULL;

  GET DIAGNOSTICS n_updated = ROW_COUNT;
  RAISE NOTICE '0031: 回填 last_activity_at 写入 % 行（只动 IS NULL 的行；第二遍重放必为 0）', n_updated;
END
$do$;

-- ③ 后置守卫（自证，**纯读**，可反复重放）：这一列的「可空 + 无默认值」是契约而不是风格偏好——
--    可空 = 「从未活动」必须能被表达；无默认值 = 「没人写过它」不许看起来像「刚刚说过话」。
--    漂了的后果都是**静默**的（界面把新账号显示成刚刚活动过 / 「从未活动」再也问不出来），所以在这里炸掉。
--    触发条件示例：有人在中间手改过该列（补了 `DEFAULT now()`，或抬成 `NOT NULL`）。
DO $do$
DECLARE
  has_column   boolean;
  is_not_null  boolean;
  default_text text;
BEGIN
  SELECT (a.attnum IS NOT NULL), a.attnotnull, pg_get_expr(d.adbin, d.adrelid)
    INTO has_column, is_not_null, default_text
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'users'::regclass
     AND a.attname  = 'last_activity_at'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  IF has_column IS NULL THEN
    RAISE EXCEPTION '0031: users.last_activity_at 不存在（ALTER 未生效？），发送路每次都会 42703';
  END IF;
  IF is_not_null IS TRUE THEN
    RAISE EXCEPTION '0031: users.last_activity_at 是 NOT NULL —— 可空是契约：新开户/从未说话的账号必须是 NULL，否则「从未活动」与「从未登录」分不开';
  END IF;
  IF default_text IS NOT NULL THEN
    RAISE EXCEPTION '0031: users.last_activity_at 带了默认值 % —— 无默认值是契约：没人写过它时不许看起来像刚刚活动过', default_text;
  END IF;
END
$do$;

-- ④ 观测（纯读，可重放）：第二遍跑这三个计数**一字不变**，就是「本迁移第二遍不改任何行」的证据。
DO $do$
DECLARE
  n_total   int;
  n_active  int;
  n_never   int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE last_activity_at IS NOT NULL),
         count(*) FILTER (WHERE last_activity_at IS NULL)
    INTO n_total, n_active, n_never
    FROM users;
  RAISE NOTICE '0031: users 共 % 行；last_activity_at 非空 % 行；仍为 NULL（从未有用户输入）% 行',
    n_total, n_active, n_never;
END
$do$;
