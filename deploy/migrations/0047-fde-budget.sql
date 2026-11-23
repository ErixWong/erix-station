-- 0047-fde-budget.sql —— 每个 FDE 的「周期 LLM 额度（USD / 周期）」落库（issue #719）。
--
-- 出处：issue #719（工单 feat-261123-01，2026-11-23）。管理台用户管理里给每个 FDE 设额度，
--   额度单位是 **USD / 周期**，周期由 LiteLLM 虚拟 key 的 `budget_duration` 决定，
--   白名单只允许 '1d' 与 '1mo'（默认 '1mo'）；金额下发到 key 的 `max_budget`。
--   本单把先前的「每日额度（USD/天）」改造成「周期额度」：`daily_budget_usd` → `budget_usd`
--   + `budget_period`。**0047 尚未合并，直接改写本文件，不新开 0048。**
--
-- 为什么只能把白名单字符串原样交给 LiteLLM，绝不能自己换算（主 agent 在运行中的 LiteLLM
--   v1.103.2 容器里实测的语义，写死在此，勿自行发挥）：
--   | 写法 | 实际行为 |
--   |---|---|
--   | `1d` | 每天 `reset_time_of_day`（我们配了 `Asia/Shanghai` + `00:00` ⇒ 本地零点） |
--   | `1mo` | **每月 1 日** `reset_time_of_day`；且 `value != 1` 直接抛错（`duration_parser.py:355 _handle_month_reset`），即只支持「1 个月」 |
--   | `30d` | 被特判成**月**（`_handle_day_reset` 里 `value == 30` ⇒ 月重置），**不是「30 天后」** |
--   | `7d`  | **每周一**，不是「7 天后」 |
--   | `1m`  | **1 分钟**，不是 1 个月 |
--   ⇒ 代码里**绝不能**自己推导/换算周期（例如把「30 天」写成 `30d` 会意外变成「每月 1 日」重置），
--     只能把白名单里的 `'1d'`/`'1mo'` 原样透传给 LiteLLM。
--
-- 为什么要这两列（不变式 3：DB 是状态真相、key 是牲口）：
--   额度本身活在 LiteLLM 的 key 上，但 key 随时可能被吊销/重铸（改名对账轮换、离职重绑、
--   onboard 恢复……）。只要额度没有 DB 副本，轮换一次 key 额度就丢一次（issue 里的「坑 2：
--   key 轮换丢额度」）。把额度 + 周期存进 `fde_llm_bindings` 后，任何重铸路径都能从这两列把
--   `max_budget` + `budget_duration` 重新下发到新 key 上 —— DB 是真相，key 是可抛弃的载体。
--
-- 为什么是 `numeric(12,6)` 而不是 float/numeric 裸列：
--   * 钱不用 float：`double precision` 的二进制浮点对 0.1 之类十进制小数不精确，
--     累加/比较会漂；`numeric` 是精确十进制，和额度「按分记」的语义一致。
--   * `numeric(12,6)`：6 位小数留足模型单价的精度余量，整数位 6 位（上限百万级 USD）
--     足够；写侧仍另设业务上限校验（≤ 100000），DB 精度只是存储形态，不是策略（与 0046
--     「CHECK 只管结构、值域交写侧」同一分层）。
--   * 可空（无 NOT NULL、无 DEFAULT）：`NULL` 是显式语义「该 FDE 不限额」，
--     不是「未填的 0」——0 会被 LiteLLM 当成「一分钱都不能花」而全拒，语义完全不同。
--
-- 两条结构 CHECK（照仓里 `usage_ledger.source` / `auth_source` 的 `CHECK (col IN (...))` 写法）：
--   ① 枚举：`CHECK (budget_period IN ('1d', '1mo'))` —— 周期只能是白名单里的两个字面量，
--      把「绝不允许 `30d`/`7d`/`1m`/`monthly` 之类被误写进库」这件事钉在 DB 层（值域校验，
--      不是换算；换算永远是 LiteLLM 的事）。写法对齐 0009 的 `ADD COLUMN ... CHECK (title_source IN ('auto','manual'))`。
--   ② 配对：`CHECK ((budget_usd IS NULL) = (budget_period IS NULL))` —— 金额与周期必须
--      同时为 NULL（不限额）或同时非 NULL（设了额度），杜绝「有金额没周期」或
--      「有周期没金额」的半吊子状态（否则重铸 key 时会下发 `max_budget=金额` 却没有 duration，
--      退化成终身累计，正是要避免的坑）。
--
-- 为什么不那么做：
--   * 不在这里建「用量历史表」：口径已定「绝不做第二套统计」，历史与周期用量全部读 LiteLLM
--     自己的 `/user/daily/activity/aggregated` 端点，portal 不自算 token、不再存一份，
--     免得两套数字对不上（台账一贯的「单一真相」纪律）。
--   * 不改 baseline（docs/data/schema.sql）：baseline 自 P1 冻结，新增 DDL 一律走增量迁移。
--
-- 单文件约定（`deploy/migrations/README.md`）：幂等可整体重放（列用 `ADD COLUMN IF NOT EXISTS`，
--   枚举 CHECK 随列一起加、列已存在时整条 ADD 是空操作；配对 CHECK 用 `DROP CONSTRAINT IF EXISTS`
--   + `ADD CONSTRAINT` 按名重建，第二遍仍是零净变化）、**自己不写 `BEGIN/COMMIT`**（事务边界归 runner）、
--   `SET lock_timeout` 照 0016 的纪律；末尾 DO 块**只读**，打印重放证据。

SET lock_timeout = '5s';
SET statement_timeout = '120s';

ALTER TABLE fde_llm_bindings
  ADD COLUMN IF NOT EXISTS budget_usd numeric(12,6);

ALTER TABLE fde_llm_bindings
  ADD COLUMN IF NOT EXISTS budget_period text CHECK (budget_period IN ('1d', '1mo'));

-- 配对 CHECK：金额与周期同生同灭（NULL ⇔ NULL）。按名 DROP IF EXISTS + ADD，整体重放幂等。
ALTER TABLE fde_llm_bindings
  DROP CONSTRAINT IF EXISTS fde_llm_bindings_budget_pair_null_check;
ALTER TABLE fde_llm_bindings
  ADD CONSTRAINT fde_llm_bindings_budget_pair_null_check
  CHECK ((budget_usd IS NULL) = (budget_period IS NULL));

COMMENT ON COLUMN fde_llm_bindings.budget_usd IS
  'USD/周期额度；NULL = 不限额。下发到 LiteLLM key 的 max_budget；key 重铸时从此列恢复（不变式 3，issue #719）。';
COMMENT ON COLUMN fde_llm_bindings.budget_period IS
  '额度周期，白名单仅 ''1d''（每天本地零点重置）/ ''1mo''（每月 1 日重置，只支持 1 个月）；NULL = 不限额。原样透传给 LiteLLM 的 budget_duration，portal 绝不自算周期。';

-- 重放证据（只读）：两列皆非空的行数 = 设了周期的 FDE 数（默认全员不限额，0 行已设是上线初的常态）。
DO $do$
DECLARE
  total bigint;
  capped bigint;
BEGIN
  SELECT count(*), count(budget_usd) INTO total, capped FROM fde_llm_bindings;
  RAISE NOTICE '0047: fde_llm_bindings 共 % 行，其中设了周期额度 % 行（budget_usd 非 NULL = 已设额度；NULL = 不限额）',
    total, capped;
END $do$;
