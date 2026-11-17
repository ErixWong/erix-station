# 管理台「提示词」面板（issue #596，工单 feat-261116-20-prompts-panel）

> 状态：契约定稿（2026-11-16），本文是**实现与验收的判据来源**。
> 一句话：让管理员在不重建容器、不发版的前提下，改平台对 agent 说的话。

## 1. 背景与范围

平台喂给模型的文本共 8 处（清单见 issue #596）。第一期只开放** portal 侧可控**的 3 条：

| 条目 | DB 列 | 落点 | 生效时机 |
|---|---|---|---|
| **平台补充约定** | `platform_prompts.agents_md_addendum` | 追加成 `~/AGENTS.md` 末尾一节 | 保存 ⇒ 入队重物化 ⇒ **该工位下一次 run** |
| **平台约定整段覆写** | `platform_prompts.agents_md_override` | 替换 `renderHomeAgentsMd()` 的正文主体 | 同上 |
| **会话标题提示词** | `platform_prompts.title_prompt` | `title-llm.js` 发请求时的 system | 保存 ⇒ **下一次改名**（每次现读，无缓存） |

**不做**（第一期，理由见 issue）：per-FDE 覆盖；镜像内那 4 条（`runner/worker.js` 的 `SYSTEM_PROMPT`、
`runner/lib/delegation.js` 的 `CHILD_SYSTEM_PROMPT`、工具描述、`runner/lib/engine-notices.js`）的在线覆写；
提示词版本历史。只读那 4 条在页面上**只列位置与生效路径，不显示全文** —— portal 镜像不含 `runner/`
（`portal/Dockerfile` 只有 `COPY portal/ portal/`），portal 运行时读不到，显示全文就是撒谎。

## 2. 数据模型（迁移 `deploy/migrations/0043-platform-prompts.sql`）

单行表，形状与理由照 0036（`upload_settings`）：`id int PK DEFAULT 1 CHECK (id = 1)` 把「只能有一行」写成 DB 事实。

```sql
CREATE TABLE IF NOT EXISTS platform_prompts (
  id                 int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  agents_md_addendum text NOT NULL DEFAULT '',
  agents_md_override text NOT NULL DEFAULT '',
  title_prompt       text NOT NULL DEFAULT '',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);
-- 种下一行（评审 F1）：`SAVE_SQL` 靠 `SELECT … FOR UPDATE` 锁单例行，**表里没有行时它锁不到任何东西** ⇒
-- 首次并发保存两边都拿空快照派生「其余列」，后者把前者刚写的另一列刷回 `''`（丢更新），
-- 且审计的 `previous_*` 会记成空串而不是紧邻的前一个值。把行**建出来**，`FOR UPDATE` 就永远有锁可拿。
-- 读侧仍然要能面对「无行」（手工 `TRUNCATE`、从别的库搬来的库）⇒ 回落内置那条路径不得删。
INSERT INTO platform_prompts (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

三条口径写死在这里：

- **`''` = 跟随内置**（三列同语义）。DB 里不出现 NULL ⇒ 读侧不必区分「没配」与「配了空」，
  `isDefault` 判据只有一条。整段覆写取空串就是「不要覆写」，没有「覆写成空文档」这种配置。
- **DB 不写长度 CHECK**（与 0036 同一分层：物理荒谬由 DB 挡、产品区间是策略、由写侧挡）。
  写侧上限见 §4；读侧必须能面对「手工 `UPDATE` 进来的超长值」并照常工作。
- `updated_by` 是 uuid 但**不建 FK**（照 0026/0036）：管理员行停用后配置要留着。
- 末尾一段只读 DO 块打印重放证据（照 0036）。
- ⚠ 加迁移必须同时把 `portal/test/migrations.test.js` 里**所有**「最后迁移 = 0038」断言（261116 现查 19 处 `, 38,`）改成 39，改完 `grep -n ', 38,'` 必须为空；baseline `docs/data/schema.sql` **一个字节都不改**（冻结）。

## 3. 读侧（`portal/src/platform-prompts.js`，新模块）

口径全部照 `portal/src/upload-settings.js`，不发明第二套：

- 优先级 **DB > 内置**。读侧**永不抛、永不 500**：表不存在 / 连接拒 / 不返回 ⇒ 回落内置 +
  `reason ∈ no_row | read_failed | read_timeout`。
- 那次读取**带超时**（`PLATFORM_PROMPTS_READ_TIMEOUT_MS`，默认 1500ms，登记进 `docs/env.md`）。
  理由与 0036 复 audit 活一相同：只 `catch` 不覆盖「发出去但不返回」。
  ⚠ **超时不取消已发出的查询**（评审 F3，与 0036 同一决策，不是漏了）：node-pg 没有中断一条已发查询的 API，
  `Promise.race` 只保证**调用方不挂**；那条查询仍占着池里一个 client ⇒ DB 持续挂住时会累积占用。
  本单判据是「配置面不许把功能锁死」，不是「连接必须回收」；真要回收得上 `statement_timeout`，那是另一单。
- 导出：`getPlatformPrompts()`（管理台 DTO）、`updatePlatformPrompts()`（写侧，见 §4）、
  `resolveEffectiveAgentsMd({fdeName})`（materializer 用）、
  `resolveEffectiveTitlePrompt()`（改名链路用）。
- 改名链路接线：`title-llm.js#generateTitle` 增加 `systemPrompt` 入参（缺省仍是 `TITLE_SYSTEM_PROMPT`），
  两个调用点（`sessions.js` 手工改名、`session-title.js` 自动改名）传解析出来的生效值。
  **提示词不是守卫**：落库前仍然 `sanitizeTitle`（口径不变）。
- materializer 接线：`renderHomeAgentsMd({ fdeName, addendum, override })`（新入参，缺省 `''` ⇒
  逐字节等于今天，既有测试与物化幂等都不受影响），`buildFilePlan()` 从 DB 取生效值传进去。

## 4. 写侧（保存 = 一条 SQL 语句）

照 0036 的 `SAVE_SQL`：`prev FOR UPDATE` → upsert → 写审计，三个动作在同一语句里同生共死；
`http.js` **不得**再补一笔 `auth.audit`。审计 `action='admin.platform_prompts_updated'`、
`target='platform_prompts'`、`details={field, text_bytes, text_sha256, previous_bytes, previous_sha256}`
—— 审计存摘要不存正文（正文在配置行里，审计只证「谁在什么时候把它换成哪一份」，16 KiB × 2 塞进 jsonb 不值）。

**预算取「最坏情况」，不取示例名**（评审 F2）：闸卡的是**落盘那份文件**的字节数，而标识行随真实工位名变化
⇒ 预算里的标识行按**最长合法工位名**算（长度从 `projects.js` 的 `FDE_NAME_RE` 单一真相导出，不许手抄 63）。
DTO 里 `effectiveText` 仍用示例名 `example` 渲染（那是给人看的预览，不是闸的依据）。
两者不同名是刻意的：**预览可以挑任何一个名字，闸不能挑一个偏短的**。

写侧校验（一律 `400 validation_failed` + `details.field`，非字符串 / 缺字段 / 越界都**不落库**）：

| 字段 | 类型 | 上限 | 附加闸 |
|---|---|---|---|
| `text`（追加段） | string（`''` 合法 = 清空） | 8192 字节 | **渲染后**整份 `~/AGENTS.md` ≤ `AGENTS_MD_INJECT_MAX_BYTES` |
| `text`（整段覆写） | string（`''` = 跟随内置） | 16384 字节 | 同上（覆写文 + 追加段 + 标识行合计） |
| `text`（标题提示词） | string（`''` = 用内置） | 2000 字节 | — |

**`AGENTS_MD_INJECT_MAX_BYTES = 16384` 不许手抄**：portal 侧常量必须与 `runner/lib/agents-md.js` 的
`AGENTS_MD_MAX_FILE_BYTES` 相等，由一条测试跨包 import 两个常量对账（跨包引用的先例：
`runner/test/system-prompt.test.js` import `portal/src/previewpool.js`）。为什么必须有这条闸：注入侧
超过 16 KiB 会**静默截断**（只留 marker），管理员写完 8 KiB 追加段什么也不会发生，直到某天发现约定被切了一半。

保存成功之后：给**全部启用中的 FDE** 入队重物化（`outbox.js#enqueueMaterializeChange`，op `upsert`）。
不做「设置 + 入队」的原子性：设置本身就是真相，入队失败只是「下一次 portal 重启的全量重建才收敛」，
必须 **catch + warn** 并把 `materializeEnqueued: <条数>` 回给前端（`=0` 时页面要说「已保存，但物化未通知」）。
`title-prompt` 不涉物化 ⇒ 不入队。

## 5. 渲染规则（`renderHomeAgentsMd`）

```
正文主体 = override !== '' ? override : 内置模板正文
追加段   = addendum !== '' ? ADDENDUM_SECTION(addendum) : ''
标识行   = `（FDE 标识：${fdeName}）`        ← 两种模式下都由代码追加，不可编辑、永远是最后一行
```

追加段的**节标题与引言是平台写的**（正文是管理员写的，逐字节照搬，不加工不改写）：

```markdown
## 平台补充约定（由平台管理员撰写）

> 本节是对上面平台约定的**补充**。与上面的硬约束（预览链路那 8 条）冲突时，**以上面为准**；
> 除非本节明确写出「覆盖上面第 N 条」。

<逐字照搬的管理员正文>
```

- **红线不变**：内置模板与追加段都受既有红线约束（零端口数字、零伞域字面量），
  `portal/test/materializer.test.js` 对**默认渲染**的断言一条都不许改（那是防漂移，不是装饰）。
- 覆写模式下那 8 条要求链是管理员自己写的 ⇒ 内置模板的 8 条断言只在默认模式生效（测试要覆盖两种模式）。

## 6. API 契约（写进 `docs/api/portal.md` 新 §4.19）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/prompts` | 三块的当前值 + 生效文本 + 预算 + 只读清单。表不存在/读失败也回 `200`（不 500） |
| `PUT` | `/api/admin/prompts/addendum` | `{text}` → `200` = 保存后的完整 GET DTO + `materializeEnqueued` |
| `PUT` | `/api/admin/prompts/agents-md` | `{text}`（`''` = 恢复内置模板） |
| `PUT` | `/api/admin/prompts/title-prompt` | `{text}`（`''` = 用内置默认） |

GET DTO（键名 camelCase，与本仓其它管理台 DTO 一致）：

```jsonc
{
  "addendum":    { "text": "", "isDefault": true, "maxBytes": 8192, "bytes": 0 },
  "agentsMd":    { "override": "", "isOverridden": false, "isDefault": true,
                   "templateBytes": 9231, "effectiveBytes": 9231, "effectiveText": "…",
                   "maxBytes": 16384, "renderedLimitBytes": 16384 },
  "titlePrompt": { "text": "", "isDefault": true, "defaultText": "<内置 TITLE_SYSTEM_PROMPT>",
                   "maxBytes": 2000, "bytes": 0 },
  "readonly": [ { "key": "runnerSystemPrompt" }, { "key": "childSystemPrompt" },
                { "key": "toolDescriptions" }, { "key": "engineNotices" } ],
  "updatedAt": null, "updatedBy": null
}
```

- `effectiveText` 用**固定示例 FDE 名 `example`** 渲染，**零时间戳 / 零 run id**（页面要能对比文本、
  测试要能断言；system 是 prompt 缓存稳定前缀，动态量会让缓存整条失效）。
- `readonly` 只给 `key`，中文说明在前端 i18n（zh + en 都要有）。
- `PUT` 的 400：`details = {field, max_bytes}`，渲染超限再带 `{rendered_bytes, render_limit_bytes}`。

## 7. 前端（新增 tab `admin-prompts`）

- 路由 `/admin/prompts` + `AdminLayout` tab（插在 upload 之后、号池占用之前）+ `router.ts`。
- `lib/platformPrompts.ts`：DTO 归一化 + 草稿校验纯函数（照 `lib/uploadSettings.ts`）；
  `stores/admin.ts` 加 load/save actions（一个 tab 挂载只发 1 次 GET）。
- `views/AdminPromptsView.vue`：三张可编辑卡片 + 一张只读说明卡。每卡必须显示
  **字节数 / 上限 / 当前来源（DB 还是内置）/ 生效时机**；覆写态要显式标「已偏离内置模板」并给
  「恢复内置」按钮；平台约定卡给「查看当前生效全文」（`effectiveText`，只读 + 复制）。
- 保存成功后**用响应 DTO 回填**（响应出自 `RETURNING`），不回显输入。

## 8. 判据（实现者自查，主 agent 复跑）

| 层 | 命令 |
|---|---|
| 语法 | `node --check` 每个改动文件 |
| 后端 | 仓库根 `npm test`（261116 基线 rc=0 / 2687 tests / 0 fail / 50 skipped） |
| 前端 | `cd portal/frontend && npm run typecheck` + `timeout 240 npm test`（基线 rc=0 / 73 files / 1508 tests） |

必测格子（点名到断言，不是「有测试就行」）：

1. `P1` 无行 ⇒ 三块全 `isDefault`、`resolveEffectiveAgentsMd()` **逐字节等于**内置渲染。
2. `P2` 表不存在 / 抛错 / 超时 ⇒ 回落内置，`reason` 三种可区分，**不抛**。
3. `P3` 追加段保存 ⇒ 渲染含新节 + 标识行仍是最后一行；`P4` 覆写保存 ⇒ 主体换掉、标识行仍在；
   `P5` 覆写设 `''` ⇒ 回到内置（逐字节等于 `P1`）。
4. `P6` 渲染超限（8 KiB 追加段 + 模板 > 16 KiB）⇒ `400` 且**不落库**（读回还是旧值）。
5. `P7` 非字符串 / 缺字段 / 空 body ⇒ `400 validation_failed` + `details.field`。
6. `P8` 保存：「写 `platform_prompts`」的语句恰好 **1** 条、`audit_log` 恰好 **1** 行，且两者是**同一条**
   SQL（fake pool 计数）——三条字段路径（追加段 / 覆写 / 标题）各自点名，口径见第 11 条。
7. `P9` `portal` 常量与 `runner/lib/agents-md.js` 的 `AGENTS_MD_MAX_FILE_BYTES` 相等（跨包对账）。
8. `P10` 入队条数 = 启用中的 FDE 数；入队抛错 ⇒ 保存仍然成功 + `materializeEnqueued=0` + warn。
   ⚠ 断言不许写成 `… || true`（恒真的断言等于没断言，评审 F4）：`op` 必须是字面量 `upsert`。
9. `P1` `renderHomeAgentsMd({fdeName})` 不传新入参时**逐字节等于**今天（既有断言一条不改仍全绿）。
   勘误：本条原写 `M1`，而 `M1` 在本仓已被三处占走且都与本题无关——
   `materializer.test.js:750`（评审轮 `a4d2cae`：root 内用户自建 `.gitignore`/`AGENTS.md`
   在 stale 清理后存活）、`docs/testing.md:330` 的「M1 原子写」并发场景、
   `docs/design/event-platform/` 的宏号 M1。
   承担本条的两处（都不改名）：① `platform-prompts.test.js` 的 `P1`——无行 ⇒
   `resolveEffectiveAgentsMd()` 与 `renderHomeAgentsMd({fdeName})` 字节级相同
   （`Buffer.from` 对比，不是「看起来一样」）；② `materializer.test.js` 那 8 条
   `renderHomeAgentsMd：…` 既有断言一条没改仍全绿——默认渲染一改就红，
   证据：#596 分支对该文件**零 diff**（`git diff origin/main...HEAD` 不含它）。
   引用本条请写 `P1`，别再写 `M1`。
10. `T1` 手工改名与自动改名两条路径都用 DB 生效值（`systemPrompt` 出现在请求 `messages[0]`）。
11. `P8` 的口径（评审 F4，261116 定稿）：判据是「**设置写与审计在同一次 `pool.query`**」，
    不是「整个保存总共只有一次查询」——渲染字段另有一次预读（JS 预闸）与 N 条入队，那是两条**不同的**
    判据，混成一句就会出现「测试只在不涉物化的那一格上成立」。测试必须各自点名。
12. `P12a`/`P12b` 首写并发（评审 F1）：表里**没有行**时两个并发保存
    （同字段 / 跨字段各一例）不得互相丢更新，
    且后一条审计的 `previous_*` 必须是紧邻的前一个值。单测用假池 + **真 PG 集成脚本**各跑一次
    （`portal/integration/platform-prompts-db.mjs`，真并发假池证不了）。
    ⚠ 勘误：本仓**没有裸 `P12`**，承担者是 `platform-prompts.test.js` 的
    `P12a`（同字段）与 `P12b`（跨字段），真库腿另名 `P12a-db`–`P12d-db`。
13. `P13` 预算按最长合法工位名（评审 F2）：一组「用示例名装得下、用最坏情况名装不下」的输入必须被拒。

## 9. 真机 e2e（主 agent 执行，不在 worker 单测里）

1. `docker compose build station-portal && docker compose up -d station-portal`（迁移随 `MIGRATE_ON_START=1` 应用）。
2. playwright 进管理台 → 「提示词」tab → 写一句可辨识的追加约定 → 保存 → 截图 → vision 看图。
3. DB 对账：`platform_prompts` 行已更新、`audit_log` 恰好 1 条。
4. 等物化，看宿主 `<userspace>/<fde>/home/AGENTS.md` 出现该节（**不许手工改文件**）。
5. 在该工位发一个 run 问「平台补充约定的最后一条是什么」，答出管理员刚写的那句 ⇒ 文本真进了模型请求。
6. 走一遍「整段覆写 → 恢复内置」，第 4 步的文件回到内置渲染。
