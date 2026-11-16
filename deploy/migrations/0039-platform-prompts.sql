-- 0039-platform-prompts.sql —— 管理台「提示词」面板的数据层（issue #596 片 A / 工单 feat-261116-20，
-- 2026-11-16）。契约：docs/design/admin-prompts-panel-2026-11-16.md §2。
--
-- 背景：平台喂给模型的文本里，portal 侧可控的三条（`~/AGENTS.md` 的补充约定、`~/AGENTS.md` 的整段覆写、
--   会话标题的 system）今天**写死在代码里**：管理员想加一句平台约定要改 `portal/src/materializer.js`
--   再重建 station-portal 镜像。本表把这三条搬进 DB，管理台可改 ⇒「保存 ⇒ 下一次 run 生效」，
--   不发版、不重建容器。与 `upload_settings`（迁移 0036）、`mail_settings`（迁移 0026）同一形状、
--   同一决策口径——照先例做，不发明第二套。
--
-- 为什么 **`''` = 跟随内置**（三列同语义）而不是 `NULL` + 「没配」：
--   * 列 `NOT NULL DEFAULT ''` ⇒ 读侧**不需要**区分「没配」与「配了空」，`isDefault` 判据只有一条
--     （`text === ''`）。可空列会造出第二个状态（NULL 与 '' 都想表达「用内置」），而两者在渲染上必须
--     同义 ⇒ 那就只有一个该存在。
--   * 整段覆写取空串就是「不要覆写」。**没有「覆写成空文档」这种配置**：真要一份空白的 `~/AGENTS.md`
--     也没意义（标识行由代码追加，永远不为空），所以不必为它留一个 NULL 位置。
--
-- 为什么 **DB 不写产品区间**（8192 / 16384 / 2000 都不进 CHECK）——与 0036 同一分层，不是漏了：
--   * DB 只挡**物理荒谬**（这里连一条都不必挡：`text NOT NULL` 已经把「没有值」挡住，
--     长度 0 是合法值 = 「跟随内置」，写不下的是 postgres 的 1 GiB 上限，不是本单的区间）。
--   * 产品上限是**策略**：由写侧 `PUT /api/admin/prompts/{addendum,agents-md,title-prompt}` 挡
--     （改天花板 = 改 `portal/src/platform-prompts.js` 一个常量，不用 DDL、不用重放迁移）。
--   * 读侧必须能面对一个「手工 `UPDATE` 进来的超长值」并**照常工作**（回落与截断由注入侧既有规则处理）。
--     若把区间写成 CHECK，那条判据在真机上**根本进不去**（`UPDATE` 被 CHECK 拒），判据就只剩单测。
--
-- 单行：`id int PRIMARY KEY DEFAULT 1 CHECK (id = 1)` —— 与 0026/0036 同一手法，把「只能有一行」写成
--   **DB 事实**。两行配置 = 谁生效取决于 `ORDER BY`，那是不可调试的形态。
-- ⚠ 长度上限**不在 DB**，但**必须在写侧**（`AGENTS_MD_INJECT_MAX_BYTES`）：注入侧
--   （`runner/lib/agents-md.js`）超过 16 KiB 会**静默截断**只留 marker —— 不拦的后果是「管理员写完
--   8 KiB 追加段什么也不会发生，直到某天发现约定被切了一半」。对账用例：
--   `portal/test/platform-prompts.test.js` 的 P9（跨包比 `AGENTS_MD_MAX_FILE_BYTES`）。
--
-- `updated_by` 是 uuid 但**不建 FK**（照 0026/0036）：管理员行被停用/删除后配置要留着。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：只有 `CREATE TABLE IF NOT EXISTS`，
--   第二遍是零 DDL 空操作；末尾 DO 块**只读**，打印重放证据（无行也是正常态 ⇒ NOTICE，不是 EXCEPTION）。
--   baseline `docs/data/schema.sql` 一个字节都不改（冻结）。

CREATE TABLE IF NOT EXISTS platform_prompts (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- 追加到 `~/AGENTS.md` 末尾「平台补充约定」那一节的正文（管理员撰写，逐字照搬）。`''` = 不加这一节。
  agents_md_addendum text NOT NULL DEFAULT '',
  -- 整段替换内置模板正文主体（标识行仍由代码追加）。`''` = 用内置模板，不覆写。
  agents_md_override text NOT NULL DEFAULT '',
  -- 会话标题生成的 system 提示词（手工「AI 改名」与自动改名共用这一份）。`''` = 用内置默认。
  title_prompt       text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);

-- 重放证据（只读）：打印当前行数与三列是否仍在跟随内置。无行 = 从未配置 = 三块全跟随内置，是上线形态。
DO $$
DECLARE
  row_count bigint;
  a_default boolean;
  o_default boolean;
  t_default boolean;
BEGIN
  SELECT count(*) INTO row_count FROM platform_prompts;
  SELECT agents_md_addendum = '', agents_md_override = '', title_prompt = ''
    INTO a_default, o_default, t_default
    FROM platform_prompts WHERE id = 1;
  IF row_count = 0 OR a_default IS NULL THEN
    RAISE NOTICE '0039: platform_prompts 行数=%（无行 = 三块全部跟随内置提示词）', row_count;
  ELSE
    RAISE NOTICE '0039: platform_prompts 行数=%，跟随内置：addendum=% override=% title=%（生效值以 portal 读侧为准）',
      row_count, a_default, o_default, t_default;
  END IF;
END $$;
