# 10 · 实现契约（派单前必须钉死的东西）

> 状态：**实现契约，2026-11-16**。来源：工单审计（copilot，只读）指出 6 张实现工单
> 「单张自洽、组合起来打架」——缺的都是**跨单接口**。
> 本文把那些接口钉死，工单引用本文而不是各自发挥。

---

## 0. 为什么单独一份

6 张工单（#524–#529）各自都写得下去，但组合起来有三类缺口：

| 缺口 | 后果 |
|---|---|
| **W2 说「只产意图」、W3 说「消费意图」，谁都没定义意图长什么样** | 两单各写一个 |
| **五组 HTTP API 只有路径，没有请求/响应/错误/cursor 契约** | W5/W6 的 store 无后端可依赖 |
| **枚举常量没有单一真源** | W1 建 CHECK、W2/W3/W4 各抄一份子集、W5/W6 再抄一份展示映射 |

⇒ 本文给这三类各一份契约。**工单里凡涉及这三类的，以本文为准。**

---

## 1. 枚举单一真源

**位置**：`portal/shared/macro-kinds.js`（前后端共用，`portal/src/` 与
`portal/frontend/src/` 都从这里 import）。

⚠ 放 `portal/shared/` 而不是 `portal/frontend/src/lib/`：后端不能 import 前端。
⚠ 若构建链不方便共享，退路是 `portal/src/macro-kinds.js` + 前端在构建时从它生成
—— **但只有一个真源，不许两边各维护一份**。

```js
export const KINDS = ['run-notify', 'run-silence-alert', 'run-review', 'scheduled-task'];

export const STATUS = ['pending', 'running', 'done', 'skipped', 'failed', 'superseded'];

export const CRITERION = ['terminal', 'silent', 'tick', 'mechanical', 'semantic'];

export const SKIPPED_REASON = [
  'budget_exhausted', 'quiet_hours', 'human_present', 'run_in_progress',
  'deferred', 'deferred_timeout', 'active_run_in_cwd', 'cancelled_by_user',
];

export const VERDICT = ['pass', 'red', 'no-op-claim', 'needs-human', 'unclassified'];

/** 每个 kind 的参数 schema（唯一的参数定义处，UI 与执行器都读它） */
export const KIND_SCHEMA = {
  'run-notify': {
    scope: 'session',
    fields: {
      states:  { type: 'enum[]', values: [...], default: ['failed','capped','aborted',
                 'persistence_failed','guard_unverified'] },
      channel: { type: 'enum', values: ['site'], default: 'site' },  // 第一版只有站内
    },
  },
  'run-silence-alert': {
    scope: 'session',
    fields: {
      threshold: { type: 'duration', default: '15m', min: '1m', max: '2h' },
      phases:    { type: 'enum[]', values: ['tool_running','awaiting_llm'],
                   default: ['tool_running'] },
    },
  },
  'run-review': {
    scope: 'session',
    fields: {
      review_depth: { type: 'int', values: [0, 1], default: 1 },
      on_fail:      { type: 'enum', values: ['reflow', 'notify_only'], default: 'reflow' },
      max_rounds:   { type: 'int', default: 24, min: 1, max: 100 },
    },
  },
  'scheduled-task': {
    scope: 'user',
    fields: {
      at:        { type: 'time', required: true },          // HH:MM UTC+8
      cwd:       { type: 'path', required: true },          // 订阅时由用户选，不在模板里
      task:      { type: 'text', required: true, max: 8000 },
      maxRounds: { type: 'int', default: 16, min: 1, max: 100 },
      jitter:    { type: 'duration', default: '10m', min: '0m', max: '30m' },
    },
  },
};
```

⚠ **`maxRounds` vs `max_rounds` 不许混用**：`scheduled-task` 用 `maxRounds`（它起的是普通 run），
`run-review` 用 `max_rounds`（审查 run）。两者不同名是**故意的**，因为语义不同（见 `05` §4.2/§4.3）。

**校验两处都要做**：写入时（API）+ 执行时（评估器/执行器）。UI 只消费同一份 schema 生成表单。

---

## 2. W2 → W3 的触发意图契约

评估器（W2）**不执行动作**，只产出意图。执行器（W3/W4）消费它。

```js
/** 评估器每轮产出的意图（内存结构，不落库） */
Intent = {
  assignmentId: string,
  templateId:   string,
  templateKind: string,        // KINDS 之一
  templateName: string,        // 快照：模板改名后历史仍显示当时名字
  params:       object,        // 模板参数快照（执行时不再回查模板）
  userId:       string,
  sessionId:    string | null, // session scope 才有
  cwd:          string | null, // user scope（定时任务）才有
  anchor:       string,        // 事实对象：run:<id> / dir:<path> / clock:<date>
  criterion:    string,        // CRITERION 之一
  bucket:       string,        // 状态型的分档/日期；M9 上是触发 run id
  evidence:     object,        // 判据命中时的证据（如 silent_ms、termination.reason）
}
```

### 2.1 谁写账（唯一 ledger owner）

| 阶段 | 谁 | 做什么 |
|---|---|---|
| 求值命中 | **W2** | 调 `claimMacroRun(intent)` 占位；返回 `null` ⇒ 已处理过，跳过 |
| 占位成功但决定跳过 | **W2** | `finishMacroRun({status:'skipped', skipped_reason})` |
| 占位成功后执行 | **W3/W4** | 执行动作 → `finishMacroRun({status:'done'|'failed', verdict, …})` |

⚠ **`claimMacroRun` 只在 W2 调**。W3/W4 拿到的是「已占位的 `macroRunId`」，
它们只 `finish`，**不重新 claim** —— 否则两处都 claim 会各写一行。

⚠ **跳过也必须落一行**（`status=skipped`），否则界面上「开关开着但没反应」。

### 2.2 `active_run_in_cwd` 的最终裁决

W2 预检「同 cwd 有无活跃 run」只是**意图层判断**，可能过期。
**最终裁决必须在 W3/W4 真正创建 run 的那个事务里做**（条件插入 / 行锁，见 `08` §11.1）。
W2 的预检只用来避免明显的无效执行，不作为正确性保证。

---

## 3. HTTP API 契约

五组。**全部在 W3 之前补完 server 路由**（W5/W6 的 store 依赖它们）。
⚠ 用户面端点**不能**放 `/api/admin/*`（#450 白名单）。

### 3.1 通用约定

- 错误信封：沿用站内既有形状（`{ error: { code, message, details? } }`），HTTP 状态码语义照 `SessionError`
- 分页：keyset，`?cursor=<opaque>&limit=<1..100>`，响应 `{ items: [...], nextCursor: string|null }`
- 属主校验：用户面一律走 `fetchSession(client, sessionId, userId)`，**非属主与不存在都返回 404**
- 时间：一律 ISO 8601 UTC（`2026-11-16T02:30:00.000Z`），前端负责转本地

### 3.2 用户面

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/macro-templates` | 列出 `audience='all'` 且 `enabled=true` 且 `deleted_at IS NULL` 的模板 |
| `GET` | `/api/sessions/:id/macro-assignments` | 该会话已挂的订阅 |
| `PUT` | `/api/sessions/:id/macro-assignments` | body `{ templateId, until }` ⇒ 幂等 upsert |
| `DELETE` | `/api/sessions/:id/macro-assignments/:assignmentId` | 取消 |
| `GET` | `/api/sessions/:id/macro-runs` | 流水，筛选 `?criterion=&verdict=&limit=&cursor=` |
| `GET` | `/api/notifications` | 通知列表 `?unreadOnly=true&limit=&cursor=` |
| `POST` | `/api/notifications/:id/read` | 标记已读 |
| `GET` | `/api/notifications/unread-count` | 铃铛角标 |

`GET /api/macro-templates` 响应项：
```json
{ "id": "...", "kind": "run-review", "name": "完成审查 · 默认",
  "params": { "review_depth": 1, "on_fail": "reflow", "max_rounds": 8 },
  "scope": "session", "audience": "all" }
```
⚠ **不下发 `created_by` / `enabled` / `deleted_at`** —— 用户不需要，也不该看到运维字段。

### 3.3 管理台

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/macro-templates` | 含停用/软删的，`?includeDeleted=true` |
| `POST` | `/api/admin/macro-templates` | body `{ kind, name, params, audience, scope }` |
| `PATCH` | `/api/admin/macro-templates/:id` | body 只允许 `{ name?, params?, audience?, enabled? }`，**`kind`/`scope` 不可改** |
| `DELETE` | `/api/admin/macro-templates/:id` | 按 `07` §2.3 的引用判定自动选硬删/软删 |
| `GET` | `/api/admin/macro-runs` | 全局流水，筛选 `?templateId=&status=&verdict=&userId=&from=&to=&limit=&cursor=` |
| `GET` | `/api/admin/macro-runs/summary` | 汇总（跟着筛选变） |

`GET /api/admin/macro-runs` 响应项：
```json
{ "id": "...", "startedAt": "...", "templateId": "...", "templateName": "完成审查 · 默认",
  "userId": "...", "userName": "alice", "anchor": "run:9f3a...", "criterion": "semantic",
  "status": "done", "verdict": "red", "durationMs": 252000,
  "usage": { "input": 82000, "output": 3100 } }
```
⚠ **不含 `sessionId`、不含 `childSessionId`** —— 决策者 2026-11-15：管理后台不跟踪特定会话。
点行展开的详情走 `GET /api/admin/macro-runs/:id`（同样不含 session）。

`summary` 响应：
```json
{ "triggered": 412, "done": 361, "skipped": 42, "failed": 9,
  "byVerdict": { "pass": 320, "red": 33, "no-op-claim": 4, "needs-human": 4, "unclassified": 8 },
  "usage": { "input": 48200000, "output": 1100000 } }
```
⚠ **分母是 `done`（有判决的）不是 `triggered`**；`skipped` 单列不并入 `done`。

### 3.4 通知的 `severity`

`notifications` 表加 `severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','error'))`。

推导规则（**不由动作类型推导，由收件人 + 结果推导**）：

| 条件 | severity |
|---|---|
| 投递成功且收件人含当前用户 | `info` |
| 投递失败且收件人含当前用户 | `error` |
| 收件人只有管理员 | **不写 `notifications`**（只进执行历史） |

---

## 4. 归属补丁（审计指出的三处无人认领）

| # | 缺什么 | 归给谁 |
|---|---|---|
| 1 | `notifications` 表建好后回补 W1 的软删判定 | **W3**（它建表，它负责接上那支 TODO + 补测试） |
| 2 | `until` 到期的周期扫描 | **W2**（评估循环每轮扫 `until <= now()` ⇒ 停用 + 产一条意图） |
| 3 | `until` 到期的通知投递 | **W3**（消费 W2 的到期意图） |
| 4 | `chat_sessions.origin` 迁移 + 写入 | **W1 补迁移**（列）+ **W3 补写入**（建宏会话时写 `origin='macro:<name>'`） |

⚠ `origin` 的取值：`human`（默认）/ `macro:<template-name>`。
侧栏「自动化」分组按 `origin LIKE 'macro:%'` 过滤（`07` §21.4）。

---

## 5. 判据命令（统一写法）

⚠ 站内 `npm test` 是 `node --test`（根目录），前端测试在 `portal/frontend`。
**写错工作目录会测错或找不到脚本。**

| 单 | 命令 |
|---|---|
| W1 | `node --test portal/test/migrations.test.js portal/test/macros.test.js; echo rc=$?` |
| W2 | `node --test portal/test/macro-eval.test.js; echo rc=$?` |
| W3 | `node --test portal/test/macro-run.test.js portal/test/notifications.test.js; echo rc=$?` |
| W4 | `node --test portal/test/macro-review.test.js; echo rc=$?` |
| W5 | `cd portal/frontend && timeout 240 npm test -- src/components/MacroMenu.spec.ts; echo rc=$?` |
| W6 | `cd portal/frontend && timeout 240 npm run typecheck; echo rc=$?` 然后 `timeout 240 npm test -- src/views/AdminMacrosView.spec.ts; echo rc=$?` |

⚠ `echo rc=$?` 打印的是**前一条命令**的退出码，但整个 shell 最终返回 `echo` 的 0。
判绿时**读打印出来的 `rc=` 值**，不要只看外层退出码。

### W4 的 e2e 怎么自动化

用 `portal/test/pg-fixture.js` 起隔离库 + **注入桩审查 runner**（不真的调模型）：

1. 造一条 `macro_runs`（`criterion='semantic'`, `status='running'`）
2. 桩返回 `结论：整改\n有 3 个未跟踪文件`
3. 断言：原会话的**投影正文**（`session-view.js` 的输出）里含 `[系统]`
   ⚠ **不要只查 `messages.content`** —— 普通用户消息写空串、正文在 `transcript_rounds`
4. 桩返回 `随便一段没有首行的话` ⇒ 断言 `verdict='unclassified'` 且**没有**回灌
5. 让原会话有活跃 run ⇒ 断言 `status='skipped'`、`skipped_reason='deferred'`、**`verdict` 保留原值**

---

## 6. W4 拆分（工作量重估）

审计判定 W4 超出一次派单的安全范围（文件系统快照 + 执行器隔离 + 异步生命周期三块高风险）。
拆成两张：

| 新单 | 内容 | 判据 |
|---|---|---|
| **W4a 只读隔离** | 只读工具装配（不给 `shell` / 不给 `note`，两处装配点同口径） | 单测：给回 `shell` 时只读用例必须红 |
| **W4b 判决与生命周期** | 事实采集、工作包打包、首行解析、fail closed、回灌、`until` 竞争 | e2e：§5 的五条断言 |

⚠ **#690（不做快照）**：原 W4a 的「worktree 建/清 + 脏文件搬运 + 内容级一致性校验 + 预算 + 孤儿清扫」已整体砍掉——审查 run 直接读原会话的**活目录**（`~/projects/<项目名>`，理由见 `08` §5.1），W4b 不再依赖快照产物（`snapshot_id` / worktree 路径）。`macro_runs.worktree_path` / `snapshot_id` 两列保留为历史遗留、不再写入；只读面（`RUN_REVIEW_ONLY` 链路）与快照无关，继续保留。

---

## 7. M7 执行器（审计指出的整块遗漏）

⚠ **六张单没有任何一张负责「真正起一个 run」**。W2 只产 `tick` 意图，W4 只管审查。
新增 **W7**：

| 项 | 内容 |
|---|---|
| 宏会话 | 每个 `(user, template)` **一条长期会话**（`origin='macro:<name>'`，标题平台写死 `<宏名> · 长期`） |
| 复用 | 已有就复用（**这正是 notes 跨 tick 累积的来源**，见 `06` §7 末） |
| 起 run | `postMessage` 进该会话，`trigger_kind='synthetic'` |
| 参数 | `cwd` / `task` / `maxRounds` 来自意图快照 |
| 失败 | 不补跑（`06` §8 待拍项 4：**不补**）；失败通知用户 |
| 结果 | `finishMacroRun({status:'done', verdict})`，产物由平台落盘（`~/reports/…`） |

判据：e2e 两次 tick ⇒ **同一条会话**、两条 run；notes 跨 tick 可见。
