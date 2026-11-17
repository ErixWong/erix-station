# 能力市场（技能市场）契约 — P0

> 定位：**平台把「技能包」分发到 FDE 的 `~/.erix/skills/`，并把「模型怎么知道有这个东西」变成宿主侧
> 确定性注入**。管理台负责发布/下线，工作台负责浏览/安装/启用。MCP 条目本期只留表结构与 `kind` 列，
> **不做消费者**（runner 侧无 MCP 客户端，见 §9 不做清单）。
>
> 三层机制分开看（设计讨论 2026-11-16）：
> - **L1 落盘面**：包目录 + 脚本 + 依赖 ⇒ 平台一次性写入，属主 `erix`(1000):1000
> - **L2 工具面**：`buildSkillTools` 把每个技能的 `tools[]` 全额铺进模型 schema（**每轮都发**）
> - **L3 上下文面**：今天只有 tool `description`；本设计新增宿主注入的「平台技能」段

## 1. 三条硬约束（先读）

1. **平台不执行技能代码**。portal **绝不** `import()` 技能模块做校验——那是把不可信代码放进 portal
   进程。校验只做静态（文件名/大小/源码正则/manifest 声明），**真正的运行时校验由 loader 在 FDE 里做**
   （loader 的 `errors` 只让该技能被跳过，不打死 run）。
2. **平台不新增依赖**。包传输用 **JSON bundle**（`{files:[{path, content_base64}]}`），不用 zip：
   Node 没有内置解压，为 P0 引 `adm-zip`/`yauzl` 不划算；zip 支持归 P1。
3. **`~/.erix` 里新增任何物化文件，必须先把它钉进秘密扫描用例**（`docs/design/user-space.md` §4.1.2）。
   ⇒ 新增 `~/.erix/capabilities.json` 必须同时给 `portal/test/materializer.test.js` 补一条「无秘密」用例。

## 2. 数据模型（迁移 `deploy/migrations/0039-capability-market.sql`）

沿用本仓现状：**uuid 主键**（不是全局 §3.4 的字符串 ID——本仓 DDL 全是 uuid，跟随仓库事实）、
snake_case、`timestamptz`。

```sql
CREATE TABLE capability_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','mcp')),
  slug              text NOT NULL UNIQUE,           -- 目录名 = slug（唯一、^[a-z0-9][a-z0-9-]{0,63}$）
  name              text NOT NULL,
  summary           text NOT NULL,                  -- 一句话（列表卡片）
  when_to_use       text NOT NULL,                  -- 「何时用」——L3 的路由信号，必填
  description_md    text NOT NULL DEFAULT '',       -- 详情页正文（可空）
  version           text NOT NULL,
  author            text,
  tags              text[] NOT NULL DEFAULT '{}',
  license           text,
  state             text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published','retired')),
  manifest          jsonb NOT NULL,                 -- {skill_id, entrypoint, tools:[{name,description}], files:[{path,bytes}]}
  security_score    int  NOT NULL DEFAULT 100,
  security_warnings jsonb NOT NULL DEFAULT '[]',    -- [{code, path, line, note}]
  created_by        uuid REFERENCES users (id),
  published_at      timestamptz,
  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- 包内容：按 (item, version) 存，**不可变**（改版 = 新增行 + items.version 前移）
CREATE TABLE capability_files (
  item_id  uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  version  text NOT NULL,
  path     text NOT NULL,        -- 相对路径，已校验（无绝对路径/无 .. /无符号链接）
  content  bytea NOT NULL,
  bytes    int  NOT NULL,
  PRIMARY KEY (item_id, version, path)
);

CREATE TABLE fde_capability_installs (
  fde_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  item_id      uuid NOT NULL REFERENCES capability_items (id) ON DELETE CASCADE,
  version      text NOT NULL,
  enabled      boolean NOT NULL DEFAULT true,
  installed_at timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (fde_id, item_id)
);
```

## 3. 包规范与发布校验（`portal/src/market.js#validateBundle`）

- **布局**：根必须有 `skill.mjs`；可选 `SKILL.md`（详情正文，模型按需 readFile）、`scripts/*`、
  `references/*`、`assets/*`；**禁止**子目录里再出现 `skill.mjs` 以外的入口声明。
- **路径安全**：每条 path 必须是相对路径、不含 `..`、不以 `/` 开头、不含 `\`、长度 ≤ 200；
  文件数 ≤ 50；总字节 ≤ 2 MiB；单文件 ≤ 512 KiB。
- **静态校验**（全部 400 `validation_failed` + `details.field`）：
  - `slug` 匹配 `^[a-z0-9][a-z0-9-]{0,63}$`；
  - 源码里能静态取到 `skill.id`（`/id:\s*['"]([^'"]+)['"]/`）且 **等于 slug**（否则禁用开关按 id 匹配不到）；
  - `tools[]` 条数 1..12，每条 `name` 唯一且匹配 `^[a-z][a-z0-9_]{1,63}$`，`description` 长度 ≥ 20；
  - `when_to_use` 长度 8..500。
- **静态扫描（advisory，不是边界）**：命中下列模式各记一条 warning，`security_score = max(0, 100 - 10×n)`：
  `child_process` / `eval(` / `new Function` / `process.env` / `fetch(` / `https.request` /
  `rmSync|rm(` / `chmod`。**扫描结果只用于提示与排序，不作为安装闸门**。
- **脚本自定位**：约定「包内脚本一律用 `import.meta.url` 定位」（loader 不 chdir、不传目录；
  实测 `runner/skills/github/skill.mjs:121` 的 `cwd: process.cwd()` = 项目目录）。发布页明确写出这条。

## 4. 安装 / 卸载 / 启停（`portal/src/market.js`）

- **安装目录**：`<userSpaceRoot>/<fde>/home/.erix/skills/<slug>/`，属主 `1000:1000`，
  目录 `0755`、文件 `0644`（worker 跑在 uid 1002 / gid 1000，必须组可读）。
- **幂等**：已装同版本 ⇒ 200 无副作用；不同版本 ⇒ 清空该目录后重写（**只删 slug 目录，绝不递归删
  `.erix/skills`**）；先写 `<slug>.tmp-<rand>` 再 `rename` 原子替换。
- **卸载**：删目录 + 删 installs 行；目录不存在也返回 200（幂等）。
- **启停**：只改 `installs.enabled`，**不删文件**（重新启用零下载）。
- **预算闸**（policy，不是 ops 参数，不开 env 旋钮）：单 FDE **启用**技能 ≤ 12 个（`MAX_ENABLED_SKILLS`），
  超了 409 `capability_budget_exceeded`。理由：每个工具 schema ≈ 200 token/轮（实测 `github_fetch` 730 B），
  技能是静态铺 schema，装多了每轮都付。
- **卸载/停用不会回收镜像 bundled 技能**：bundled（`/opt/erix/skills`）不在市场管辖内。
- **漂移**：平台不做对账（`skills/` 属 FDE 自管内容，`user-space.md:553`）。用户手改/删了文件，
  DB 仍记「已装」；页面上给「重新安装」按钮。**不新增对账 reconciler**。

## 5. 物化契约：`~/.erix/capabilities.json`（L3 的真相源）

materializer 在 `buildFilePlan` 里新增一条（root:root 0644，与 `config.json`/`ports.json` 同列）：

```json
{
  "version": 1,
  "skills": [
    {
      "id": "pdf-tools",
      "name": "PDF 工具",
      "summary": "抽取 PDF 文本与表格",
      "when_to_use": "读、转、检查 PDF 时",
      "enabled": true,
      "tools": ["pdf_extract"],
      "readme": "~/.erix/skills/pdf-tools/SKILL.md"
    }
  ]
}
```

- 来源 = `capability_items` ⨝ `fde_capability_installs`（`state='published'`，按 `slug` 升序）。
- **渲染必须逐字节确定**（system prompt 是 prompt cache 稳定前缀）：不含时间戳/runId/随机量；
  无安装 ⇒ `{"version":1,"skills":[]}`（**空数组而不是空文件**，形状恒定）。
- 秘密扫描用例：`materializer.test.js` 里补一条「capabilities.json 不含 token/密钥形状」。
- `materialize()` 的入参新增 `capabilities`（由 loop 按 fde 查库填充）；查库失败 ⇒ 用上一次的值或空数组 +
  `warn`，**绝不让对账因市场表报错而停**。

## 6. runner 接线

1. **`excludeSkillIds`**（上游已有，`erix-agent/src/skills/loader.js:292`，本站没接线）：
   读 `~/.erix/capabilities.json`，`enabled=false` 的 `id` 传进去。用户自己的技能（不在文件里）不受影响。
2. **能力索引段**（新 `runner/lib/capability-index.js`，照 `runner/lib/agents-md.js` 的四条口径：
   只来自原文/字节确定/失败降级/上限）：
   - 渲染：`## 平台技能（能力市场）` + 每条一行
     `- <id>（<name>）— <summary>；何时用：<when_to_use>；工具：a,b；说明：<readme>（需要时 readFile）`
   - 上限 4 KiB，超出截断并写「（还有 N 项未列出）」，**排序固定按 id**。
   - 空 / 读不到 / JSON 坏 ⇒ 返回空串（system prompt 逐字节等于现状）+ 一条 `MSG.LOG` warn。
3. **system prompt 修正**：现有那句「**工具面只有这些**：文件工具… shell… note_*」在装了技能后是假的。
   改为「工具面 = 文件/shell/note_* + 本提示词末尾「平台技能」段列出的技能工具」，并同步
   `runner/test/system-prompt.test.js` 的防漂移断言。
4. **审查 run 继续不给技能**（#537）；delegation 子 run 继续不含技能。

## 7. API 契约（`docs/api/portal.md` 新增 §4.17）

管理面（`/api/admin/market/*`，管理台入口专属）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/market/items?state=` | 列表（含 draft/retired），带 `installs` 计数 |
| POST | `/api/admin/market/items` | 发布新条目：`{slug,name,summary,when_to_use,version,author?,tags?,license?,description_md?,bundle}` |
| PUT | `/api/admin/market/items/:id` | 改元数据 / 发新版本（`bundle` 可选） |
| POST | `/api/admin/market/items/:id/publish` / `/retire` | 状态迁移 |
| GET | `/api/admin/market/items/:id` | 详情（含文件清单与扫描结果，**不回包内容**） |

用户面（`/api/market/*`，用户入口）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/market/items` | 只回 `published`；每条带 `installed`/`enabled`/`version` |
| GET | `/api/market/items/:slug` | 详情（含 `SKILL.md` 正文） |
| POST | `/api/market/items/:slug/install` | 安装（`{enabled?:true}`） |
| POST | `/api/market/items/:slug/uninstall` | 卸载 |
| POST | `/api/market/items/:slug/enabled` | `{enabled:boolean}` |

错误码：`validation_failed` / `capability_not_found`(404) / `capability_not_published`(409) /
`capability_budget_exceeded`(409) / `capability_kind_unsupported`(409，P0 的 `kind='mcp'`) /
`capability_install_failed`(500，落盘失败，带 `details.reason`)。

## 8. UI

- **管理台**：新 tab `admin-market`（`AdminMarketView.vue`）：条目表（state/slug/版本/安装数/安全分）+
  发布/编辑 modal（元数据 + 多文件选择，浏览器侧打包成 bundle）+ 发布/下线按钮 + 扫描结果展示。
- **工作台**：新路由 `#/market`（`MarketView.vue`）+ 顶栏入口「市场」。卡片列表（name/summary/tags/
  工具数/安全分/已装态）+ 详情抽屉（when_to_use、SKILL.md 正文、工具清单）+ 安装/卸载/启停按钮。
- **i18n**：`zh`/`en` 两份同时加（`src/i18n/locales/*`），`localeParity.spec.ts` 会拦漏翻。
- 文案口径：红/黄/绿不引入；「已安装但未启用」用中性灰字，不用告警色。

## 9. 不做清单（P0 明确不做，别再顺手加）

- **MCP 消费者**：runner 侧 MCP 客户端 / 单 `mcp` 网关工具 / `~/.erix/mcp.json` 生成 ⇒ 独立单（P1）。
  本期只留 `kind` 列，`kind='mcp'` 的发布/安装一律 409 `capability_kind_unsupported`。
- zip/tar 上传、git URL 源、npm 源。
- 版本回滚 UI（DB 已按版本存，但页面只给「重装当前版本」）。
- 子进程隔离（技能仍是 in-process dynamic import，ADR-008）。
- 按 FDE 的可见性/分配（全员可见）。
- 任何对 `~/.erix/skills/` 的对账 reconciler。
- 工具预算的**自动**缩容（只做安装期拒绝，不做事后裁剪）。

## 10. 验收判据（P0 完成 = 全部成立）

单测：
- `portal/test/market.test.js`：bundle 校验 9 条负例（zip-slip/绝对路径/超大/无 skill.mjs/id≠slug/
  tools 超限/description 过短/空 bundle/非 utf8）、安装幂等、卸载幂等、预算闸、`kind='mcp'` 拒绝、
  扫描打分、卸载只删 slug 目录。
- `portal/test/materializer.test.js`：`capabilities.json` 形状 + 逐字节确定 + 秘密扫描。
- `runner/test/capability-index.test.js`：渲染逐字节确定 / 空输入空串 / 超限截断 / 坏 JSON 降级。
- `runner/test/skills-channel.test.js`：新增「`excludeSkillIds` 接线后禁用技能工具不在面」用例。
- 前端：`AdminMarketView.spec.ts` / `MarketView.spec.ts`（**不用 `w.emitted()`**，断言 DOM 与请求桩）。

真机 e2e（主 agent 亲自跑）：
1. admin 发布一个探针技能（`echo_probe` 工具返回固定 marker）→ 状态 published；
2. `eric` 在 `#/market` 安装并启用 → 宿主 `users/eric/home/.erix/skills/<slug>/skill.mjs` 存在且属主 1000:1000；
3. 工作台新建会话，让它「调用 echo_probe」→ transcript 里出现工具调用 + marker 回显（证明 L1+L2+L3）；
4. 页面上禁用 → 新 run 里该工具不可用（模型报 Unknown tool 或工具面不含它）；
5. 卸载 → 目录消失，DB 行消失。
