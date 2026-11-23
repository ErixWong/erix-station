-- 0047-fde-daily-budget.sql —— 每个 FDE 的「每日 LLM 额度（USD/天）」落库（issue #719）。
--
-- 出处：issue #719（工单 feat-261123-01，2026-11-23）。管理台用户管理里给每个 FDE 设日额度，
--   额度单位是 **USD/天**，最终下发到 LiteLLM 虚拟 key 的 `max_budget` + `budget_duration: "1d"`。
--
-- 为什么要这一列（不变式 3：DB 是状态真相、key 是牲口）：
--   额度本身活在 LiteLLM 的 key 上，但 key 随时可能被吊销/重铸（改名对账轮换、离职重绑、
--   onboard 恢复……）。只要额度没有 DB 副本，轮换一次 key 额度就丢一次（issue 里的「坑 2：
--   key 轮换丢额度」）。把额度存进 `fde_llm_bindings` 后，任何重铸路径都能从这一列把
--   `max_budget` 重新下发到新 key 上 —— DB 是真相，key 是可抛弃的载体，这正是不变式 3 的口径。
--
-- 为什么是 `numeric(12,6)` 而不是 float/numeric 裸列：
--   * 钱不用 float：`double precision` 的二进制浮点对 0.1 之类十进制小数不精确，
--     累加/比较会漂；`numeric` 是精确十进制，和额度「按分记」的语义一致。
--   * `numeric(12,6)`：6 位小数留足模型单价的精度余量，整数位 6 位（上限百万级 USD/天）
--     足够；写侧仍另设业务上限校验（≤ 100000），DB 精度只是存储形态，不是策略（与 0046
--     「CHECK 只管结构、值域交写侧」同一分层）。
--   * 可空（无 NOT NULL、无 DEFAULT）：`NULL` 是显式语义「该 FDE 不限额」，
--     不是「未填的 0」——0 会被 LiteLLM 当成「一分钱都不能花」而全拒，语义完全不同。
--
-- 为什么不那么做：
--   * 不在这里建「用量历史表」：口径已定「绝不做第二套统计」，历史与今日用量全部读 LiteLLM
--     自己的 `/user/daily/activity/aggregated` 端点，portal 不自算 token、不再存一份，
--     免得两套数字对不上（台账一贯的「单一真相」纪律）。
--   * 不改 baseline（docs/data/schema.sql）：baseline 自 P1 冻结，新增 DDL 一律走增量迁移。
--
-- 单文件约定（`deploy/migrations/README.md`）：幂等可整体重放（`ADD COLUMN IF NOT EXISTS`，
--   第二遍是零 DDL 空操作）、**自己不写 `BEGIN/COMMIT`**（事务边界归 runner）、
--   `SET lock_timeout` 照 0016 的纪律；末尾 DO 块**只读**，打印重放证据。

SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE fde_llm_bindings
  ADD COLUMN IF NOT EXISTS daily_budget_usd numeric(12,6);

COMMENT ON COLUMN fde_llm_bindings.daily_budget_usd IS
  'USD/天日额度；NULL = 不限额。下发到 LiteLLM key 的 max_budget + budget_duration:"1d"；key 重铸时从此列恢复（不变式 3，issue #719）。';

-- 重放证据（只读）：NULL 列数 = 未设额度的 FDE 数（默认全员不限额，0 列已设是上线初的常态）。
DO $do$
DECLARE
  total bigint;
  capped bigint;
BEGIN
  SELECT count(*), count(daily_budget_usd) INTO total, capped FROM fde_llm_bindings;
  RAISE NOTICE '0047: fde_llm_bindings 共 % 行，其中设了日额度 % 行（NULL = 不限额）',
    total, capped;
END $do$;
