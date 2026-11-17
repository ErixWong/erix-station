-- 0042-platform-prompts.sql —— 管理台「提示词」面板的数据层（issue #596 片 A / 工单 feat-261116-20，
--
-- ⚠ 现势再让号（2026-11-17，本单第三次）：0040 → 0042。
--   判据：migrations.test.js「迁移 NNNN 编号全局唯一」闸。
--   0040 被 #608 `0040-mcp-channel` 占用（已在 dev 库 Applied）；
--   0041 被 #640 `0041-retire-run-checkpoints` 占用 ⇒ 本单取 0042。
--   同号两支撞真库 checksum ⇒ 容器反复重启（0039 已撞过一次）。
-- ⚠ 下方 `RAISE NOTICE '0040: …'` 前缀**故意不改**：它是重放日志标签，
--   不是台账版本号；让号只改文件名与本注释自指号。
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
--
-- ⚠ **为什么还要种下 `id = 1` 这一行**（独立评审 F1，契约 §2）——不是「省一次 INSERT」的优化，是补一个锁洞：
--   写侧那条语句（`portal/src/platform-prompts.js` 的 `SAVE_SQL`）靠
--   `SELECT … FROM platform_prompts WHERE id = 1 FOR UPDATE` 拿旧值快照，而 **`FOR UPDATE` 只能锁已经存在的
--   行**：空表里没有任何行可锁 ⇒ 两个并发首写各拿一份「无行」快照（三列全 `COALESCE(…, '')`）、各写自己那一格
--   ⇒ 后写的那条 `ON CONFLICT DO UPDATE` 把**整行**覆盖 ⇒ 先写的值丢了、它的 `previous_*` 也无从谈起。
--   可选的补法里为什么不选别的：
--     * 「把 `snap` 换成对不存在的键加锁（advisory lock / 锁表）」——引入一把与数据无关的锁，而 0026/0036
--       两张同形表都没这么做，长出来的第二套并发模型要后人记住；
--     * 「只在 JS 侧加互斥」——portal 可以起多个副本，进程内互斥锁不住跨连接的 `FOR UPDATE` 窗口。
--   种一行让 `FOR UPDATE` **有行可锁**：DB 里本来就有 `id = 1` 这一把锁，写侧一条语句都不用改。
--   代价是这条迁移多一行 `INSERT`，而它是幂等的（`ON CONFLICT (id) DO NOTHING` ⇒ 重放零变化，
--   也不会覆盖管理员已经改过的文本）。
--   ⚠ 种行**不等于**读侧可以省掉「无行」那一档：手工 `DELETE`、部分恢复的 dump、`TRUNCATE` 都能让表重新变空
--   ⇒ 读侧 `resolveFromRow` 的 `no_row` ⇒ 回落内置必须留着（判据 `P1`），写侧 `snap` 取不到行时的
--   `LEFT JOIN + COALESCE` 也照旧成立。
--
-- ⚠ 长度上限**不在 DB**，但**必须在写侧**（`AGENTS_MD_INJECT_MAX_BYTES`）：注入侧
--   （`runner/lib/agents-md.js`）超过 16 KiB 会**静默截断**只留 marker —— 不拦的后果是「管理员写完
--   8 KiB 追加段什么也不会发生，直到某天发现约定被切了一半」。对账用例：
--   `portal/test/platform-prompts.test.js` 的 P9（跨包比 `AGENTS_MD_MAX_FILE_BYTES`）。
--
-- `updated_by` 是 uuid 但**不建 FK**（照 0026/0036）：管理员行被停用/删除后配置要留着。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：只有 `CREATE TABLE IF NOT EXISTS` + 一条
--   `INSERT … ON CONFLICT DO NOTHING`，第二遍是零 DDL、零数据变化（`DO NOTHING` ⇒ 永不覆盖已改过的文本）；
--   末尾 DO 块**只读**，打印重放证据（无行也是正常态 ⇒ NOTICE，不是 EXCEPTION）。
--   baseline `docs/data/schema.sql` 一个字节都不改（冻结）。
--   ⚠ 本片（#596 片 A）**尚未进入任何已部署库** ⇒ 本文件在同一片里迭代（加上面那条种行）不碰
--     deploy/migrations/README.md 那条「已应用的迁移不可再改」的红线；一旦上线就只能新增新编号。
--   ⚠ **编号本身换过一次**（2026-11-16）：本文件原为 `0039-platform-prompts.sql`，而 `origin/main` 已经
--     有 `0039-capability-market.sql`（#595）⇒ `NNNN` 同号两个文件违反 README「四位递增序号」，且 dev 库里
--     真的同时落了 `0039-capability-market` 与 `0039-platform-prompts` 两行台账而没有任何判据报警 ⇒
--     本文件让号到 0040（未进任何已部署库，换号 + 重放安全：内容只有 IF NOT EXISTS / ON CONFLICT DO
--     NOTHING / 只读 DO 块）。机械闸：`portal/test/migrations.test.js`「迁移编号 NNNN 全局唯一」。

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

-- 种首行（评审 F1）：让 `SAVE_SQL` 的 `FOR UPDATE` 从第一次保存起就**有行可锁**。
-- 三列取库里的 DEFAULT（`''` = 跟随内置）⇒ 种行本身不改变任何生效值：读侧仍是「三块全跟随内置」。
-- `ON CONFLICT (id) DO NOTHING` ⇒ 重放零变化，也绝不覆盖管理员已经改过的文本。
INSERT INTO platform_prompts (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 重放证据（只读）：打印当前行数与三列是否仍在跟随内置。上线形态 = 1 行且三列全空（上面那条种行）。
-- 行数 0 仍然合法（手工 `DELETE` / 部分恢复的 dump）⇒ 那是 NOTICE 不是 EXCEPTION：读侧对无行照样回落内置。
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
    RAISE NOTICE '0040: platform_prompts 行数=%（无行 = 三块全部跟随内置提示词）', row_count;
  ELSE
    RAISE NOTICE '0040: platform_prompts 行数=%，跟随内置：addendum=% override=% title=%（生效值以 portal 读侧为准）',
      row_count, a_default, o_default, t_default;
  END IF;
END $$;
