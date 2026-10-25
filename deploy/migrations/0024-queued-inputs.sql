-- 0024-queued-inputs.sql —— 对话输入队列（issue #370，参考 pi-web / pi 的两条队列）
--
-- 要解决的问题：任务运行中用户「不能说话」——前端 `send()` 见到 activeRunId 直接静默返回
-- （`stores/workbench.ts`），后端 `postMessage` 撞 `ACTIVE_RUN_STATES` 409 `run_in_progress`
-- （`sessions.js`）。pi/pi-web 的做法是运行中照常可发，消息进两条队列：
--   * `steer`（转向）：打断当前 run，用这句话继续（投递点 = 当前 assistant 轮的工具调用跑完、
--     下一次 LLM 调用之前；本站经 `onRound` 边界 abort + 新 run 续接实现，见 §6）；
--   * `follow_up`（排队）：当前 run 正常结束后依次发出。
--
-- 为什么落 DB 而不是照抄 pi 的内存队列（`pi-agent-core` `Agent.steeringQueue`）：
--   pi 的队列随进程消失（其自身注释：“dead wrapper (no state) means the queue is gone”），
--   而本站不变式 3「DB 是状态真相」+ 容器是牲口 ⇒ 用户打进来的话绝不能随进程/页面消失。
--
-- 红线：**入队只写本表**。绝不写 `messages` 锚点行、绝不 `appendUserInputTurn`——正文真相在
-- `transcript_rounds`（#77 P3 PR②b B2：`messages` = 纯锚点行），提前落 transcript 会让**还没
-- 说出口的话**进入模型上下文并被读侧渲染成已发送。投递时才走 `postMessage` 的既有写入路径。
--
-- 幂等可重放（deploy/migrations/README.md：已应用迁移不可再改，本文件必须整体重放安全）：
-- 全部 `IF NOT EXISTS`，第二遍是零 DDL 空操作。

-- 第①层「人看的对话」的前置区：已说出、但尚未投递的话。
CREATE TABLE IF NOT EXISTS queued_inputs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id          uuid NOT NULL REFERENCES chat_sessions (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users (id),
  kind                text NOT NULL CHECK (kind IN ('steer', 'follow_up')),
  -- 入队原文。投递（`postMessage`）时才进 transcript；本表内容是**模型还看不见**的话。
  content             text NOT NULL CHECK (btrim(content) <> ''),
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- pending → delivering（出队者已认领，run 还没建）→ delivered（投递成功，`run_id` = 它触发的 run）
  --        → recalled（用户「取回」回填输入框，pi `clear_queue` 同义）
  --        → discarded（预留：当前实现不 discard——容器不在也留在队列，见 #370 拍板点 ②）
  -- `delivering` 不是装饰：认领与建 run 跨两次提交（`postMessage` 自开事务并锁 chat_sessions，
  -- 在同一事务里调它会自锁），中间必须有一个「已被认领」的可见状态，否则并发出队会把同一条
  -- 投两次。崩溃窗口留在 delivering 的行由 `claimed_at` 过期重认领（下面 pick 的谓词）。
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivering', 'delivered', 'recalled', 'discarded')),
  -- FIFO 真相。`bigserial` 而非 `now()`：同毫秒入队也要有确定的先后，且不能依赖时钟。
  position            bigserial NOT NULL,
  -- 投递时它触发/参加的 run（follow_up 与 steer 都有）。
  run_id              uuid REFERENCES runs (id) ON DELETE SET NULL,
  -- 仅 `steer`：入队时它**打断**的那个 run（会话锁内取自活跃 run）。
  -- 「这次 abort 是转向还是用户按了停止」的判据就落在这里——**不新增 run 状态、不新增
  -- termination reason**，run 状态机零改动（口径同 portal.md §4.5 的展示态推导红线）。
  interrupted_run_id  uuid REFERENCES runs (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  claimed_at          timestamptz,             -- 进入 delivering 的时刻（过期即可被重新认领）
  delivered_at        timestamptz
);

-- 出队扫描 / 会话详情快照：只关心未投递的，按 kind 分组内 position 升序。
CREATE INDEX IF NOT EXISTS queued_inputs_pending_idx
    ON queued_inputs (session_id, kind, position) WHERE status = 'pending';
-- 「这条 run 是被转向打断的吗」反查（终态出队判定每条终态都要问一次）。
CREATE INDEX IF NOT EXISTS queued_inputs_interrupt_idx
    ON queued_inputs (interrupted_run_id) WHERE kind = 'steer' AND status = 'delivered';

-- 测量用 lineage（#370 拍板点 ① 的配套）：每条 follow-up 都是一个新 run，各自带一份
-- `maxRounds`（默认 16，且 ≥16 自动开 reflection）+ judge/wrapup/finalGuard 固定开销。
-- 先观测两周真实分布再决定要不要加预算旋钮 ⇒ 必须先能把「这个 run 是谁叫起来的」分出来。
-- 存量行 DEFAULT 'user_send'（不回填：它们确实都是用户手发的）。
ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'user_send'
  CHECK (trigger_kind IN ('user_send', 'queued_steer', 'queued_follow_up', 'synthetic'));

-- 后置守卫（照 0021 惯例）：默认值是契约——`postMessage` 不传 trigger_kind 时靠它保持
-- 'user_send'；漂了就把每一次普通发送都记成队列投递，观测数据从此不可信。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'runs' AND column_name = 'trigger_kind'
                AND (is_nullable <> 'NO' OR column_default IS NULL
                     OR column_default NOT LIKE '%user_send%')) THEN
    RAISE EXCEPTION '0024: runs.trigger_kind 漂移（应为 NOT NULL DEFAULT ''user_send''）';
  END IF;
END $$;

-- 重放证据（纯读）：打印队列现状，第二遍应与第一遍一致（本迁移不动数据）。
DO $$
DECLARE n bigint; m bigint;
BEGIN
  SELECT COUNT(*) INTO n FROM queued_inputs;
  SELECT COUNT(*) INTO m FROM queued_inputs WHERE status = 'pending';
  RAISE NOTICE '0024: queued_inputs 共 % 行 / 其中 pending % 行', n, m;
END $$;
