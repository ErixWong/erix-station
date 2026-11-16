-- 0039-capability-market.sql —— 能力市场（技能市场）P0 的三张表（issue #595，契约 docs/design/capability-market.md §2）
--
-- 定位：平台把「技能包」分发到 FDE 的 `~/.erix/skills/`（L1 落盘面），并把「模型怎么知道有这个东西」
--   变成宿主侧确定性注入（L3，物化 `~/.erix/capabilities.json`）。本文件只落**数据层**。
--
-- 为什么 uuid 主键而不是全局规范的字符串业务 ID：本仓 DDL 全是 uuid（`docs/data/schema.sql` 起），
--   跟随仓库事实；`slug` 才是人类可读的唯一键（目录名 = slug，唯一性由 `slug UNIQUE` 保证）。
-- 为什么包内容单独一张 `capability_files` 且**按 (item, version) 不可变**：
--   版本回滚在 P0 不开 UI，但 DB 必须留得下历史版本——「改版 = 新增行 + items.version 前移」，
--   就地 UPDATE 会让已装旧版本的 FDE 与库里声称的版本对不上账。
-- 为什么 `fde_capability_installs` 只管「装没装/启没启」而不管磁盘：
--   `~/.erix/skills/` 属 FDE 自管内容（docs/design/user-space.md:553），平台**不做磁盘对账**；
--   用户手改/删了文件，这一行仍记「已装」，页面给「重新安装」按钮（§4 的口径）。
-- `kind` 列今天只有 `skill` 会被消费：`mcp` 的消费者（runner 侧 MCP 客户端）是 P1 独立单，
--   P0 的 `kind='mcp'` 发布/安装一律 409 `capability_kind_unsupported`（§9 不做清单）。
--
-- CHECK 把「枚举值」写成 DB 事实（state / kind）：这两列的取值集合是**协议**，
--   被写侧校验与物化 SQL 同时引用，漂了必须当场炸而不是留下一个没人认识的行。
-- `security_score`/`security_warnings` 是 **advisory**（§3：扫描只用于提示与排序，不是安装闸门），
--   所以这里不写「score 低于多少就不许装」这类 CHECK——闸门在 JS 侧，判据也不同源。
--
-- 幂等可重放（deploy/migrations/README.md 单文件约定）：只有 `CREATE TABLE IF NOT EXISTS`，
--   第二遍是零 DDL 空操作；末尾 DO 块**只读**，打印重放证据。

CREATE TABLE IF NOT EXISTS capability_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','mcp')),
  -- 目录名 = slug（唯一、^[a-z0-9][a-z0-9-]{0,63}$，校验在 portal/src/market.js）
  slug              text NOT NULL UNIQUE,
  name              text NOT NULL,
  summary           text NOT NULL,                  -- 一句话（列表卡片）
  when_to_use       text NOT NULL,                  -- 「何时用」——L3 的路由信号，必填
  description_md    text NOT NULL DEFAULT '',       -- 详情页正文（可空）
  version           text NOT NULL,
  author            text,
  tags              text[] NOT NULL DEFAULT '{}',
  license           text,
  state             text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  -- {skill_id, entrypoint, tools:[{name,description}], files:[{path,bytes}]}
  manifest          jsonb NOT NULL,
  security_score    int  NOT NULL DEFAULT 100,
  security_warnings jsonb NOT NULL DEFAULT '[]',    -- [{code, path, line, note}]
  created_by        uuid REFERENCES users (id),
  published_at      timestamptz,
  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 包内容：按 (item, version) 存，**不可变**（改版 = 新增行 + items.version 前移）
CREATE TABLE IF NOT EXISTS capability_files (
  item_id  uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  version  text NOT NULL,
  path     text NOT NULL,        -- 相对路径，已校验（无绝对路径/无 .. /无符号链接）
  content  bytea NOT NULL,
  bytes    int  NOT NULL,
  PRIMARY KEY (item_id, version, path)
);

CREATE TABLE IF NOT EXISTS fde_capability_installs (
  fde_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  version      text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fde_id, item_id)
);

-- 物化侧（capabilities.json）与用户面列表都按 (fde, enabled) / (state) 取数；两表今天都是小表，
-- 索引是「让计划不随规模变差」而不是救急，建在迁移里而不是事后补（补索引要单独一支迁移）。
CREATE INDEX IF NOT EXISTS capability_items_state_idx ON capability_items (state, slug);
CREATE INDEX IF NOT EXISTS fde_capability_installs_fde_idx ON fde_capability_installs (fde_id, item_id);

-- 重放证据（只读）：三张表的行数。全 0 = 市场还没发布过任何条目，是上线时的默认形态。
DO $$
DECLARE
  n_items bigint;
  n_files bigint;
  n_installs bigint;
BEGIN
  SELECT count(*) INTO n_items FROM capability_items;
  SELECT count(*) INTO n_files FROM capability_files;
  SELECT count(*) INTO n_installs FROM fde_capability_installs;
  RAISE NOTICE '0039: capability_items=% / capability_files=% / fde_capability_installs=% 行'
    || '（全 0 = 市场未发布，capabilities.json 将渲染成 {"version":1,"skills":[]}）',
    n_items, n_files, n_installs;
END $$;
