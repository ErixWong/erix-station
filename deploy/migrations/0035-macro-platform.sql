-- 0035-macro-platform.sql —— 事件平台 W1 数据层：宏模板 / 订阅 / 执行账（issue #524）
--
-- 要解决的问题：站内现在只有「人坐在对话前敲一句话」这一条驱动路径——run 只能由人发起，
-- 没有任何「机器事件 ⇒ 自动跑一次宏」的落点。W1 只做**数据层**：把三件事分三张表存清楚，
-- 让 W2 的调度器、W3 的通知面板各自有唯一真相可读写：
--   * `macro_templates`：**可复用的宏定义**（做什么）。`deleted_at` 软删，见下面的红线 ③。
--   * `macro_assignments`：**谁在什么范围内订阅了哪个模板**（给谁做、做几次）。`until` 到期
--     ⇒ `enabled = false`（到期判定一律 UTC；本单**不做定时器**，到点执行是 W2 的事）。
--   * `macro_runs`：**每次执行一条账**（做没做、结果如何）。幂等键
--     `(assignment_id, anchor, criterion, bucket)` 唯一——同一个事件在同一条判据同一桶里只该跑
--     一次。⚠ **键里不许出现 `status`**：`status` 是生命周期（pending → running → done），会随执行
--     推进而变；把它放进幂等键，一条记录跑完之后键就换了，同一个触发能被再次 claim ⇒ 幂等直接失效
--     （这就是「一列两义」的代价）。判据（`criterion`）与桶（`bucket`）都不随执行变，键才稳定。
--     认领用 `INSERT … ON CONFLICT DO NOTHING RETURNING id`（`macros.js` `claimMacroRun`），
--     **不是**「先 SELECT 再 INSERT」（那在并发下会把同一个事件跑两遍）。
--
-- 为什么不合成一张表：模板要能被多人复用、订阅要能改人、执行记录要能永久审计——
-- 三者的生命周期与写入者完全不同（管理员改模板 / 用户改订阅 / 调度器只追加执行账）。
-- 这也是不变式 3「DB 是状态真相」+ 不变式 4「容器是牲口」的落地：调度器进程随时可死可换，
-- 只要这三张表在，重启后照样能接着认领、接着记账。
--
-- 幂等可重放（deploy/migrations/README.md：已应用迁移不可再改，本文件必须整体重放安全）：
-- 全部 `IF NOT EXISTS`，第二遍是零 DDL 空操作；末尾守卫与证据块都是纯读。

-- ① 宏模板：可复用的定义。
CREATE TABLE IF NOT EXISTS macro_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 宏的种类。四类都先立起来：`run-notify` / `run-silence-alert` / `run-review` 由 run 事件驱动，
  -- `scheduled-task` 由时间驱动（W2 的定时器只驱动这一类）。
  kind        text NOT NULL
              CHECK (kind IN ('run-notify', 'run-silence-alert', 'run-review', 'scheduled-task')),
  name        text NOT NULL CHECK (btrim(name) <> ''),
  -- 模板参数（提示词、阈值、目标模型等）。jsonb 而非散列成列：四类宏的参数集互不相交，
  -- 散列会让每一列只对一类有意义。校验放在 `macros.js`（写侧），不在 DB 侧上 JSON Schema。
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- `all` = 全员可订阅；`admin` = 仅管理员可见可订阅（门户侧鉴权，不在本表里存成员）。
  audience    text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'admin')),
  -- 订阅时允许绑定的范围：`session` 必须给 session_id，`user` 是「我的所有会话」。
  scope       text NOT NULL CHECK (scope IN ('session', 'user')),
  enabled     boolean NOT NULL DEFAULT true,
  -- 可空：系统内置模板由迁移/种子写入，没有「创建人」。FK 口径照 `chat_sessions.user_id`
  -- （`REFERENCES users (id)`，不带 ON DELETE——用户删号策略见 model.md，本表不擅自 CASCADE）。
  created_by  uuid REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- 软删标记。**红线 ③**（07-surfaces-and-panel.md §2.3）：能不能物理删由引用数决定，
  -- 判定在 `macros.js` `deleteTemplate`，不在这里写 trigger（DB 侧触发器看不见 notifications 表）。
  deleted_at  timestamptz
);

-- 门户列表：只列未软删的，按 kind 分组、名字排序。
CREATE INDEX IF NOT EXISTS macro_templates_kind_idx
    ON macro_templates (kind, name) WHERE deleted_at IS NULL;

-- ② 订阅：谁 + 在哪个范围 + 到什么时候。
CREATE TABLE IF NOT EXISTS macro_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id   uuid NOT NULL REFERENCES macro_templates (id) ON DELETE CASCADE,
  -- FK 口径与 `chat_sessions.user_id` 一致：NOT NULL REFERENCES users (id)，不带 ON DELETE。
  user_id       uuid NOT NULL REFERENCES users (id),
  -- scope='session' 时必填，scope='user' 时为 NULL（NULL 的含义由模板的 scope 决定，
  -- 不在这里加 CHECK：跨表条件 CHECK 要 trigger，而这条约束的正确性由 `macros.js` 写侧保证）。
  session_id    uuid REFERENCES chat_sessions (id) ON DELETE CASCADE,
  -- 限定只在某个 worktree 目录里生效；NULL = 不限目录。
  cwd           text,
  -- 到期时刻（UTC）。到期 ⇒ `enabled = false`（`macros.js` 在读写两侧都用 UTC 比较，
  -- 本单不做定时器，见文件头）。
  until         timestamptz,
  enabled       boolean NOT NULL DEFAULT true,
  -- 调度器最近一次评估它的时刻（W2 写）。可空 = 从未被评估过。
  last_evaluated_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- 幂等订阅键。NULLS NOT DISTINCT（PG15+）：scope='user' 的订阅 session_id/cwd 都是 NULL，
  -- 默认语义下 NULL 互不相等 ⇒ 同一个人能把同一个模板订无数次，调度器就会重复跑。
  -- 这一条是「重复订阅」的唯一防线，所以不能省。
  UNIQUE NULLS NOT DISTINCT (template_id, user_id, session_id, cwd)
);

-- 「这个模板被谁订了」（删除模板前的引用判定也要它）。
CREATE INDEX IF NOT EXISTS macro_assignments_template_idx
    ON macro_assignments (template_id);
-- 调度器扫描：按人取启用中的订阅。
CREATE INDEX IF NOT EXISTS macro_assignments_user_active_idx
    ON macro_assignments (user_id) WHERE enabled;

-- ③ 执行账：一次执行一行，只追加，不改写历史（`status` 的推进是唯一例外）。
CREATE TABLE IF NOT EXISTS macro_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ⚠ **不带 ON DELETE**（口径同 `chat_sessions.user_id`）：执行账是审计面，「取消订阅」不能顺手
  -- 抹掉「这台机器当时真跑过一次」的历史——默认 NO ACTION（=RESTRICT）正是这个语义：
  -- 有账的订阅只能停用不能物理删（`macros.js` `unassignTemplate` 的两分支）。
  -- 而 `macro_assignments.template_id → macro_templates` 是 CASCADE，两支方向不同是有意的：
  -- 「模板物理删 ⇒ 订阅跟着没意义」成立，「订阅没了 ⇒ 历史没意义」不成立。
  assignment_id       uuid NOT NULL REFERENCES macro_assignments (id),
  -- 幂等键的两半：`anchor` = 触发它的事件标识（run id / 事件 id / 定时桶的时刻字符串），
  -- `bucket` = 去重桶（同一 anchor 下的聚合窗口，例如静默告警的 10 分钟桶）。
  anchor              text NOT NULL,
  bucket              text NOT NULL,
  -- **生命周期**（这一列会随执行推进而变 ⇒ 绝不进幂等键，见文件头）：
  -- pending → running → done / failed；pending → skipped（被门禁挡下）；
  -- pending → superseded（被同桶的更新一次取代，不执行）。
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'done', 'skipped', 'failed', 'superseded')),
  -- **触发判据**（这一列写完就不变 ⇒ 是幂等键的一部分）。为什么必须与 `status` 分两列：
  -- 判据回答「这次触发是谁叫起来的」，生命周期回答「这一次跑到哪了」——两个轴各自演进，
  -- 合成一列就得让幂等键跟着状态跑（见上面的 ⚠）。取值：
  --   `terminal`   run 进终态触发的宏（run-notify / run-review）
  --   `silent`     静默告警（run-silence-alert，按 bucket 聚合窗口去重）
  --   `tick`       定时/轮询（scheduled-task，W2 的定时器驱动）
  --   `mechanical` M9 判据：机械可判定的那一路（不需要模型裁决）
  --   `semantic`   M9 判据：要模型语义裁决的那一路
  criterion           text NOT NULL
                      CHECK (criterion IN ('terminal', 'silent', 'tick', 'mechanical', 'semantic')),
  -- 结果判定（`done` 才有）。`verdict` 是归一化后的口径，`verdict_raw` 存模型原话，
  -- 便于口径改了以后回溯重算——两者分开存是站内既有习惯（照 run 的 termination 透传 + 展示态推导）。
  verdict             text CHECK (verdict IN ('pass', 'red', 'no-op-claim', 'needs-human', 'unclassified')),
  verdict_raw         text,
  reason              text,
  remediation_text    text,
  -- `skipped` 才有：被哪条门禁挡下的。八种穷举成 CHECK 而不是自由文本——「为什么没跑」
  -- 是面板与观测要分组的维度，自由文本会把这一维变成不可统计的垃圾场。
  skipped_reason      text CHECK (skipped_reason IN ('budget_exhausted', 'quiet_hours',
                             'human_present', 'run_in_progress', 'deferred', 'deferred_timeout',
                             'active_run_in_cwd', 'cancelled_by_user')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  -- 宏真跑起来时派生的会话与 run（可空：没真跑就没有）。SET NULL：会话/run 被清理时
  -- 执行账要留着，账上的引用可以断，账本身不能消失。
  child_session_id    uuid REFERENCES chat_sessions (id) ON DELETE SET NULL,
  child_run_id        uuid REFERENCES runs (id) ON DELETE SET NULL,
  -- 递归深度与父账：宏 A 派生宏 B 时靠它挡住无限自我派生（深度上限在 W2 的调度器里判）。
  depth               integer NOT NULL DEFAULT 0 CHECK (depth >= 0),
  parent_macro_run_id uuid REFERENCES macro_runs (id) ON DELETE SET NULL,
  -- 现场引用（可空，都不建 FK）：快照/工作树是**可回收物**，账要能在它们被清掉之后
  -- 仍然指得回「当时用的是哪个快照」，SET NULL 会把审计链切断。
  snapshot_id         uuid,
  worktree_path       text,
  -- 幂等键：同订阅 × 同事件 × **同判据** × 同桶 只有一行。`claimMacroRun` 的
  -- `ON CONFLICT DO NOTHING` 依赖的正是这条约束；四列全都写完不变（`status` 不在里面）。
  UNIQUE (assignment_id, anchor, criterion, bucket)
);

-- 筛选全落索引列（09-observability.md §7）。**索引选型说明**（任务给的二选一）：
-- 这里选「不冗余」的一支——`macro_assignments(template_id)`（上面已建）
-- + `macro_runs(assignment_id, started_at)`，按模板查执行账走 JOIN。
-- 理由：给 `macro_runs` 加一份冗余 `template_id` 等于把同一个事实存两处——订阅换模板
-- （模板软删后重建、或后台改绑）时账上的旧值就成了假账，还得再写一个守卫或触发器去追平；
-- 执行账是**只追加**的审计表，把可变的派生值塞进不可变的历史行里，方向就是反的。
-- 代价是每次按模板筛选多一次等值 JOIN（assignment_id 已是 FK + 有索引，走嵌套循环，
-- W1 的量级完全够；真成瓶颈再加覆盖索引或物化视图）。
CREATE INDEX IF NOT EXISTS macro_runs_assignment_started_idx
    ON macro_runs (assignment_id, started_at DESC);
-- 面板默认视图：最近执行倒序（跨订阅的全局时间线）。
CREATE INDEX IF NOT EXISTS macro_runs_started_idx
    ON macro_runs (started_at DESC);
-- 未收口的账（进程死在 running 上的残留、待跑的 pending）——调度器每次 tick 都要扫。
CREATE INDEX IF NOT EXISTS macro_runs_open_idx
    ON macro_runs (started_at) WHERE status IN ('pending', 'running');
-- 「这条判据跑过没有」/「这条订阅在这条判据下跑过没有」（W2 每次 tick 都要问；
-- 幂等键那条索引的前缀是 assignment_id，服务不了这种按判据的筛法）。
CREATE INDEX IF NOT EXISTS macro_runs_criterion_started_idx
    ON macro_runs (criterion, started_at DESC);
-- 「这个 run 是哪次宏跑出来的」反查（run 详情页要显示「由宏 X 触发」）。
CREATE INDEX IF NOT EXISTS macro_runs_child_run_idx
    ON macro_runs (child_run_id) WHERE child_run_id IS NOT NULL;

-- 后置守卫（照 0021 / 0024 惯例）：CHECK 集合是契约——枚举漂了，W2 的调度器会写出
-- DB 不认但代码不报错的值，「为什么没跑」从此不可统计。漂了就拒绝启动。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'macro_runs'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%status%'
                AND pg_get_constraintdef(oid) NOT LIKE '%superseded%') THEN
    RAISE EXCEPTION '0035: macro_runs.status 的 CHECK 漂移（缺 superseded）';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'macro_runs'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%criterion%'
                AND pg_get_constraintdef(oid) NOT LIKE '%mechanical%') THEN
    RAISE EXCEPTION '0035: macro_runs.criterion 的 CHECK 漂移（M9 两路 mechanical/semantic 缺了）';
  END IF;
  -- 判据与状态**必须是两列**（一列两义的回归闸）：库里不许再有名为 `state` 的列。
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'macro_runs' AND column_name = 'state') THEN
    RAISE EXCEPTION '0035: macro_runs 还留着 state 列（生命周期与判据必须拆成 status / criterion 两列）';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'macro_runs'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%skipped_reason%'
                AND pg_get_constraintdef(oid) NOT LIKE '%cancelled_by_user%') THEN
    RAISE EXCEPTION '0035: macro_runs.skipped_reason 的 CHECK 漂移（八种门禁不全）';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'macro_templates'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%kind%'
                AND pg_get_constraintdef(oid) NOT LIKE '%scheduled-task%') THEN
    RAISE EXCEPTION '0035: macro_templates.kind 的 CHECK 漂移（缺 scheduled-task）';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'macro_runs'::regclass AND contype = 'u'
                    AND pg_get_constraintdef(oid) =
                        'UNIQUE (assignment_id, anchor, criterion, bucket)') THEN
    RAISE EXCEPTION '0035: macro_runs 幂等键 UNIQUE (assignment_id, anchor, criterion, bucket) 漂移';
  END IF;
  -- ⚠ **幂等键里混进 status 就必须失败**（这条是本节存在的理由）：状态会随执行推进而变，
  -- 键里带它 ⇒ 一条账 pending→running→done 之后键位空出来 ⇒ 同一个触发能被再次 claim，幂等失效。
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'macro_runs'::regclass AND contype = 'u'
                AND pg_get_constraintdef(oid) LIKE '%status%') THEN
    RAISE EXCEPTION '0035: macro_runs 幂等键里混进了 status（生命周期列进键 ⇒ 状态一迁移幂等就失效）';
  END IF;
  -- ⚠ 极性注意：这条是「**必须存在**一条带 NULLS NOT DISTINCT 的 UNIQUE」（与上面几条
  -- 「存在但不完整 ⇒ 漂」的写法相反），因为要防的是这半句被丢，而不是多写了什么。
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'macro_assignments'::regclass AND contype = 'u'
                    AND pg_get_constraintdef(oid) LIKE '%NULLS NOT DISTINCT%') THEN
    RAISE EXCEPTION '0035: macro_assignments 订阅键丢了 NULLS NOT DISTINCT（重复订阅会复活）';
  END IF;
END $$;

-- 重放证据（纯读）：打印三表现状，第二遍应与第一遍一致（本迁移不动数据）。
DO $$
DECLARE a bigint; b bigint; c bigint;
BEGIN
  SELECT COUNT(*) INTO a FROM macro_templates;
  SELECT COUNT(*) INTO b FROM macro_assignments;
  SELECT COUNT(*) INTO c FROM macro_runs;
  RAISE NOTICE '0035: macro_templates % 行 / macro_assignments % 行 / macro_runs % 行', a, b, c;
END $$;
