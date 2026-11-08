# delegation（子 run）接入设计 —— 宿主 / 门户 / UI / e2e

> 2026-11-08。设计者：主 agent。依据：两份独立评估（`~/eval-delegate-261108/{erix,pi}/repo/EVAL-REPORT.md`）
> + 主 agent 亲验的 8 条源码事实。**实现一律派 worker，主 agent 只验收**（`~/projects/AGENTS.md` §3.0）。
> 状态：待实现。

## 0. 一句话

让 FDE 里的 agent 能用 `delegate` 工具**在同一进程内嵌套第二个 `runToolLoop`** 派子 run，
子 run 的账本落**本地 JSONL 文件**（引擎 `createFileTranscriptStore`），门户读那两份文件
（名册 + 账本）把它投影成与主对话**同形**的 DTO，前端用既有组件渲染成「工具卡 + 只读子 run 抽屉」。
默认关（`ERIX_DELEGATE_ENABLED`），开了才多带 2065 字节工具 schema。

## 1. 为什么不是「子 = 本站真 run」

两条 DDL 硬约束挡死（主 agent 已验）：

- `docs/data/schema.sql:205` `runs.session_id NOT NULL`
- `docs/data/schema.sql:222-223` `runs_one_active_per_session UNIQUE (session_id) WHERE status IN ('queued','running','cancelling')`
  ⇒ 父在跑时，同会话塞不进第二个活跃 run（子会当场撞唯一索引）。
- 附带：`notes` 的单写者不变量（`runner/worker.js:556-558` 注释）**明确依赖那条索引**，
  所以「子 = 真 run」也不是白捡。

⇒ 子 run 是**引擎语义的子 run**（名册 + 租约 + 账本文件），不是本站 `runs` 表的一行。

## 2. 引擎侧事实（实现时不许再推，全部已验）

| 事实 | 坐标 | 实现含义 |
|---|---|---|
| `createDelegateTool` 必需 `runChild` + `rosterDir` | `tool.js:206-220` | 缺则 `TypeError` |
| `runChild` 收到 `{task,cwd?,parentRunId?,runId,model?,deadlineMs?,signal}` | `tool.js:158-162` | 库不 fork/spawn |
| `parentRunId` 取自 `context.runId`（模型不可填） | `tool.js:330` | 本站 `config.run.runId` 填的是 **transcriptKey(=sessionId)**（`worker.js:868`）⇒ 必须在 `runChild` 里用**真 runId** 覆盖 |
| `termination` 只认**字符串**，对象 ⇒ 一律 `failed` | `tool.js:94-98` | `runChild` 必须返回 `result.termination?.reason` |
| `TERMINATION_TO_STATE` 表外一律 `failed` | `tool.js:67-79` | `no_tool` / `continuation_exhausted` 会被判 `failed`（本站当正常收尾）⇒ 必须显式补映射或改写返回值 |
| `owned` Map 只在**后台**分支登记 | `tool.js:455` | 前台子 `cancel` 恒 `not_owned`（`:547-552`）⇒ 中止只能靠宿主串 signal |
| `controller = new AbortController()` 全新，不接外层 | `tool.js:420` | 同上 |
| `deadlineMs` 是**时长**，`deadlineAt = now + deadlineMs` | `tool.js:405` | 引擎 `config.timing.deadlineMs` 是**绝对时刻**（`orchestrator.js:2059-2062`，CLI 在 `bin/delegation.js:339` 换算） |
| 无 `isProcessAlive` ⇒ 活态记录进 `unverified`、一字不动 | `roster.js:379-386` | 死槽等 30min 兜底（`capacity.js:287-292`） |
| `removeRecord` 已 `@deprecated`（0.31 删除） | `roster.d.ts:34-40` | 归档/清理是宿主责任 |
| `transcriptPath` 辅助函数**未导出**（深引被 `exports` 挡） | 实测 `ERR_PACKAGE_PATH_NOT_EXPORTED` | 自己拼 `<dir>/<runId>.jsonl`；`sub-<uuid>` 过 `safeRunId` 恒等 |
| `tail` 只读**本地文件**，限额 8/20 行、300/1000 字符 | `tail.js:43-49`、`src/store/file.js:153` | 本站今天零可用（账本在 DB） |
| `DELEGATE_DEFINITION` = 2065 字节 | 实测 | 进 `request.tools`，每个 run 每次请求都带 |
| 子工具面**不得**含 `delegate`（v1 不递归） | `bin/delegation.js:22-26`、契约 §6508 | 装配时剔掉 |
| 子权限 ≤ 父 | `bin/delegation.js:27-30` | 复用父的工具面即可 |

## 3. 落盘布局（唯一真相，门户与 runner 必须同源）

容器内 `<home> = /home/erix`（`provisioner.js:180-183` 把 `<userSpaceRoot>/<fde>/home` bind 到它）。

```
/home/erix/delegation/
├── roster/<parentRunId>/<childRunId>.json     # 引擎写（每父 run 一个名册目录）
├── leases/slot-<i>.lock                       # 引擎写（每 FDE 共享 = 全局子配额）
└── transcripts/<childRunId>.jsonl             # 引擎文件 store 写（每子一份账本）
```

**为什么这样切**：

- `roster` 按**父 run** 分片 ⇒ 模型的 `list` 只看见自己的子；也避开「A run 看见 B run 的子」。
- `leases` 按**FDE** 共享 ⇒ 两个父 run 真共享配额池（`link(2)` 保证跨进程）。
- `transcripts` 扁平按子 runId ⇒ `transcriptPathFor` 只需 `join(dir, runId+'.jsonl')`。
- **全部放在 `delegation/` 下而不是 `runs/<runId>/`**：`cleanupRunData` 只清 `runs/<runId>`，
  run 终态后名册与账本必须还活着（UI 要回看）。代价：需要 TTL 清理（P2 做，P1 先不删）。

门户侧对应宿主路径：`<userSpaceRoot>/<fde>/home/delegation/...`（`config.js:298`）。

## 4. P1 宿主实现（`runner/`）

### 4.1 新文件 `runner/lib/delegation.js`

导出 `createStationDelegation({...})` → `{ definition, execute, dispose }`。

```js
createStationDelegation({
  parentRunId,        // 真 runId（不是 transcriptKey）
  parentCwd,
  home,               // /home/erix
  provider,           // 复用父的 provider 实例（同一凭据/超时口径）
  tools,              // 父的工具面，装配时**剔掉 delegate**
  modelMetadata, maxTokens,   // 与父同源（config.metadata / config.tuning）
  childMaxRounds,     // env ERIX_DELEGATE_CHILD_ROUNDS，默认 8
  childDeadlineMs,    // env ERIX_DELEGATE_CHILD_TIMEOUT_MS，默认 240_000（< watchdog 300_000）
  maxConcurrent,      // env ERIX_DELEGATE_MAX，默认 2
  parentSignal,       // 父 abortController.signal（中止串联）
  onChildLiveness,    // (childRunId) => void  → worker 发 SHELL_LIVENESS heartbeat
  logger,
})
```

内部：

- `runChild(request)`：
  1. `signal = anySignal([request.signal, parentSignal])`（自己实现，Node 22 有 `AbortSignal.any`）
  2. `store = createFileTranscriptStore({ dir: transcriptsDir })`（包根导出，已验）
  3. `runToolLoop({ config: { run: { runId: request.runId, parentRunId, cwd: childCwd,
     maxRounds: childMaxRounds, stream: true, replayPolicy: 'per-tool-declaration' },
     metadata: {...}, tuning: { maxTokens }, folding: { context: { strategy:'fold-llm', keepRounds: 6 } },
     timing: { deadlineMs: Date.now() + (request.deadlineMs ?? childDeadlineMs) } },
     provider, tools: childTools, executeTool, store, signal,
     onEvent: (e) => onChildLiveness(request.runId),   // 只刷保活，**不转发事件**
     ... })`
  4. 返回 `{ text: result.finalText ?? '', termination: result.termination?.reason,
     usage: result.usage, rounds: result.rounds }`
  5. 任何抛错：**归一成正常返回**（`termination: 'failed'` + `text: ''`），并把 `error.message` 带上
     —— 库会把它写成 `state=failed` + `errorMessage`（`tool.js:300-303`），但父 run 不因此失败。
  6. **usage 累加**：把 `result.usage` 累进一个 `childUsage` 累加器，暴露 `takeChildUsage()`。
- `transcriptPathFor: (runId) => join(transcriptsDir, `${runId}.jsonl`)`
- `cwdFor: (requested) => path.resolve(requested ?? parentCwd)`（P1 不校验 jail 子目录；
  jail 的可写边界仍是 `parentCwd`，子若给了越界 cwd 会在工具层被 jail 拒，属预期）
- `isProcessAlive: (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }`
  （照 `bin/delegation.js:83-101`：EPERM=活，ESRCH=死，其它错误码=算活）
- `notifyParent`: P1 = `logger('warn', 'delegate child finished', {...})` 一行，**不投递**
- `rosterDir: join(home,'delegation','roster',parentRunId)`、`leaseDir: join(home,'delegation','leases')`
- `clock: Date.now`

### 4.2 `runner/worker.js` 改动（四处，不许扩散）

1. **装配**（在 `createToolRegistry` 之后、`runToolLoop` 之前，`~:596` 附近）：
   `if (process.env.ERIX_DELEGATE_ENABLED === '1') { delegation = createStationDelegation({...}) }`
2. **工具面**：`tools = [...原有, ...(delegation ? [delegation.definition] : [])]`
3. **路由**：`executeTool` 里 `delegate` 走**独立分支**直接调 `delegation.execute(input, options.context)`，
   **不要**塞进 `registry.executors`（registry 会先按自己的 schema 校验，形状不对）。
   `options.context` 必须原样传（父身份全靠它）。
4. **usage 合并**：`RUN_FINISHED` 之前把 `delegation.takeChildUsage()` 加进 `result.usage`
   （`worker.js:1023` 那一处，input/output/cacheRead/cacheWrite 逐字段相加）。
5. **保活**：`onChildLiveness` → `sendIpc({ type: MSG.SHELL_LIVENESS, run_id: runId, phase: 'heartbeat',
   command: 'delegate:'+childRunId })`（已验 `applyShellLiveness` 对 `phase:'heartbeat'` 只刷 `lastIpcAt`，
   不需要 pgid，agentd 零改动）。
6. **中止串联**：把 worker 自己的 `abortController.signal` 作为 `parentSignal` 传进去（已存在，`:992` 附近）。

### 4.3 env（`runner/lib/config.js` + `docs/env.md` 登记）

| env | 默认 | 说明 |
|---|---|---|
| `ERIX_DELEGATE_ENABLED` | `0` | 开才注册工具 |
| `ERIX_DELEGATE_MAX` | `2` | 每 FDE 子 run 并发上限（跨进程共享 leases） |
| `ERIX_DELEGATE_CHILD_ROUNDS` | `8` | 子 run 轮数预算 |
| `ERIX_DELEGATE_CHILD_TIMEOUT_MS` | `240000` | 子 run 时间预算（**必须 < 300000 watchdog**） |

### 4.4 P1 明确不做

`notifyParent` 投递、UI、DDL、新事件类型、子独立 cwd、递归 delegate、跨进程 cancel、`tail` 接给模型、
名册 TTL 清理。

## 5. P2 门户读侧（`portal/`）

### 5.1 两个端点（都挂在既有会话鉴权之后）

```
GET /api/sessions/:sessionId/delegates?runId=<parentRunId>
  → { items: [{ childRunId, state, cwd, createdAt, endedAt, updatedAt,
                termination, errorMessage, resultTruncated, hasTranscript }] }
GET /api/sessions/:sessionId/delegates/:childRunId?tail=100
  → { childRunId, state, messages: [<与主对话同形的 DTO>], truncated, nextBefore? }
```

- **归属校验**：`sessionId` 必须属于当前用户（复用 `fetchSession` 口径）；
  `parentRunId` 必须属于该 session（查 `runs` 表）；`childRunId` 必须出现在该 parent 的名册里
  （**不许**用用户给的路径直接拼盘 —— 只允许 `<userSpaceRoot>/<fde>/home/delegation/...` 之下的
  `sub-<uuid>` 形状名字，正则 `^sub-[0-9a-f-]{36}$`）。
- **读 roster**：`<...>/home/delegation/roster/<parentRunId>/*.json`，逐条 `JSON.parse`，
  坏文件跳过（不 500）。
- **读 transcript**：`<...>/home/delegation/transcripts/<childRunId>.jsonl`，逐行 `JSON.parse`
  → `foldLedgerMessages`（引擎导出）→ `projectTranscriptForDisplay`（**与 `session-view.js:31` 同一个函数**）
  → 再套一层既有 DTO 适配（`id/seq/run_id/created_at` 这些宿主字段用 `childRunId` + 行号合成）。
  `tail=N` 只投影最后 N 条逻辑消息（读侧先截断原始行会破坏折叠，**必须全量投影后再切**，
  与 `session-partial-output` 的成本口径同族：单文件有上限，超过 8MB 直接 413 并提示）。
- **成本红线**：`tail` 默认 100，硬上限 500；文件读流式，不许整文件 `readFileSync` 进内存超过上限。
- **零 DDL、零新事件类型、零新错误码**（复用 `not_found` / `validation_failed`）。

### 5.2 为什么不在 DB 建表

`removeRecord` 已从引擎删除，名册本来就是「宿主负责归档」的文件；P2 只读文件即可。
真要做「跨 FDE 统计子在飞」再另开迁移（P3）。

## 6. P3 UI（`portal/frontend/`）—— 参照 pi-web 的形态

pi-web 的形态（`~/projects/github/pi-web`，已读源码）：

1. **工具卡**（`components/MessageView.tsx:1178-1300`）：`delegate` 调用就是普通工具卡，
   卡片头右侧多一个**图标按钮**（`subagent.openTab`），点击打开右栏 tab。
2. **右栏只读视图**（`components/SubagentViewer.tsx`）：**轮询** `GET /api/sessions/:id/context`
   每 2s（**故意不用 SSE**——「viewer 永不复活/干扰子 run」），tail 100、向前翻页，
   复用 `MessageView` 渲染。
3. **Agents 面板**（`components/AgentSessionPanel.tsx`）：family 里所有 agent 一行，
   状态图标 + 标签 + 用量 + 时长，3s 轮询，点击选中/开 tab。
4. **侧栏 family 归组**（`lib/session-family.ts`）：子会话不出现在顶层，挂在父下面；顶栏 `Agents` 徽标。
5. **状态图标/颜色**由 `StatusIcon`/`statusColor` 单一来源。

### station 的映射（无右栏 tab 架构，改用抽屉）

| pi-web | station |
|---|---|
| 工具卡右侧「开 tab」按钮 | 工具卡右侧「查看子 run」按钮 → 打开**抽屉**（`DelegateChildDrawer.vue`） |
| `SubagentViewer` 轮询 context | 抽屉轮询 `GET /api/sessions/:id/delegates/:childRunId?tail=100`，**2s 一次**，`state` 终态即停 |
| `AgentSessionPanel` family 列表 | 工具卡展开区里的**子 run 行**（state 图标 + 短 id + 时长 + tokens），不新开面板 |
| 顶栏 Agents 徽标 | `RunStatusBar.vue` 里加一段 `子 run N`（仅运行时出现，非运行态不渲染） |
| `session-family` | 不需要（子不是会话） |

### 6.1 工具卡（`StreamPanel.vue`）

- 识别：`toolName === 'delegate'` 且 `tool_result` 可解析出 `{ ok, runId, state, text?, error? }`
  （引擎返回的是 JSON 工具结果；`tool.js:439-447`）。
- 展示：
  - 头行：`delegate` + action（`run/status/result/list/cancel/tail`）+ 子 runId 短码
  - 状态徽标：`running`（脉冲）/`completed`/`aborted`/`failed`/`timeout`/`interrupted`
    —— **颜色映射必须过本站 `terminationReasons.ts` 的分级**，不许直接用名册 state 上色
    （`no_tool`/`continuation_exhausted` 名册判 `failed` 但本站当正常收尾 ⇒ 后端 DTO 里要带
    `termination` 原值，前端按 `RUN_TERMINATION_SYSERR_REASONS` 判红）。
  - 「查看子 run」按钮（仅 `run` 且 `ok:true` 时出现）
- 展开区：子 run 的 `text`（截断提示照 `resultTruncated`）。

### 6.2 抽屉（新 `DelegateChildDrawer.vue`）

- 结构照既有 `FilePreviewModal.vue`（遮罩 + 面板 + Esc 关闭），但**只读、无输入**。
- 头部：子 runId + state 徽标 + cwd + 时长；`state` 活态时显示「轮询中」提示。
- 正文：复用既有消息渲染（`renderMarkdown` + 工具卡摘要 `getToolResultSummary`），
  **不复用 `StreamPanel`**（它绑 store 的 entries）。
- 轮询：`state` 为 `queued/running` 时 2s 一次；终态后停；关闭抽屉即停；`onUnmounted` 清理。
- 空态：`starting`（文件还没写）/ `no_transcript` / 错误三态文案，双语成对。

### 6.3 不做（P3）

侧栏 family 归组、顶栏徽标、`steer`/`stop` 子的按钮（P4）、子 run 的历史会话（子不是会话）。

## 7. P4 e2e（主 agent 亲手）

1. **宿主单测**（worker 写）：7 条红格（见 §8）。
2. **真机**：
   - 本地构建 portal + fde 镜像，临时顶掉 `deploy/.env` 的 digest pin（照 §8.34 路线 A，验完还原）。
   - `ERIX_DELEGATE_ENABLED=1` 下发（provisioner env 白名单已含 `ERIX_*`？需核 `fde-proxy/server.js` 的
     `ENV_KEY_ALLOW`——**这是 §8.70 那个事故的同型坑，必须加白名单**）。
   - 新会话 `~/projects/probe-delegate`，让 agent 用 `delegate` 派 2 个读密集子任务。
   - 验：名册 2 条 `completed`；账本 2 个 `.jsonl`；父 `usage` = 父自身 + 子之和（对比开关关时的基线）；
     UI 工具卡出现子 run 行；点「查看子 run」抽屉出现子对话；刷新后仍在。
   - 中止级联：起一个长子 run，点「停止」⇒ 子名册落 `aborted`，父 `termination.reason='aborted'`。
   - 看门狗：子 run 跑 > 5min（`ERIX_DELEGATE_CHILD_TIMEOUT_MS=400000` 临时调大）⇒ 父不被 SIGKILL。
   - 复原 `.env` 并 `up -d`。

## 8. P1 红格判据（worker 必须逐条写成会红的测试）

1. **父身份是真 runId**：名册 `parentRunId` === 本站 runId（**不是** sessionId）。
   变异：路由里摘掉 `options.context` ⇒ 红。
2. **对象 termination 不得静默 failed**：`end_turn` 子 ⇒ 名册 `completed`。
   变异：`termination: result.termination`（对象）⇒ `failed` ⇒ 红。
3. **`no_tool` 不许被判失败**：子以 `no_tool` 收尾 ⇒ DTO/名册语义为「正常」。
   变异：去掉显式映射 ⇒ 红。
4. **配额跨进程**：两个 worker 共用 `leaseDir`，第 3 个子 `capacity_full` + `holders`。
   变异：`leaseDir` 放 per-run ⇒ 第三个成功 ⇒ 红。
5. **父停 ⇒ 子死**：父 `parentSignal` abort ⇒ 子 `runToolLoop` 收到 abort、名册 `aborted`。
   变异：不串 signal（只透传库给的 `request.signal`）⇒ 子跑完 ⇒ 红。
6. **usage 不漏账**：子 usage 出现在父 `RUN_FINISHED.usage` 里（逐字段相加）。
   变异：不累加 ⇒ 红。
7. **默认关**：`ERIX_DELEGATE_ENABLED` 未设 ⇒ `tools` 与今天逐字相同（含 `delegate` 不在）。
   变异：默认开 ⇒ 红。
8. **不递归**：子的 `tools` 里没有 `delegate`。变异：复用父工具面不剔 ⇒ 红。
9. **`deadlineMs` 换算**：`config.timing.deadlineMs` 是 `Date.now()+budget`（不是 budget 本身）。
   变异：直接透传 ⇒ 红（断言 deadlineAt 与 now 的差 ≈ budget）。
10. **保活**：子跑 4 分钟期间父 worker 至少发过 N 次 `SHELL_LIVENESS.heartbeat`。
    变异：去掉 `onChildLiveness` ⇒ 红。

## 9. 已知边界（写进文档，不许当 bug 修）

- 子 run 在界面上**不是会话**：刷新后要从工具卡的 `runId` 重新拉，不能靠「最近会话」。
- `cancel` 对前台子无效（引擎事实）⇒ 中止只走 signal；UI 不提供「停止某个子」按钮（P4 再议）。
- 名册/账本无 TTL（P1/P2），会累积；清理是 P3 的活。
- 子共用父 cwd ⇒ **写并行会互踩**；对外只说「上下文隔离 + 读密集并行」。
- 子 notes 作用域 = 父 sessionId ⇒ 父子共用笔记；P1 不给子装 notes 工具（避免并发写），
  这是**刻意**的：子只做「读 + 分析 + 返回文本」。
- 子折叠策略沿用 `fold-llm`（成本会多一发摘要调用），P1 显式传同一策略。

## 10. 分期与派工

| 期 | 内容 | 交付 |
|---|---|---|
| P1 | 宿主（§4）+ 10 条红格 | `runner/` 改动 + `runner/test/delegation*.test.js` |
| P2 | 门户两端点（§5）+ 单测 | `portal/src/delegation.js` + `portal/test/delegation.test.js` |
| P3 | 前端（§6）+ vitest | `DelegateChildDrawer.vue` + `StreamPanel` 卡片 + spec |
| P4 | 真机 e2e（§7） | 主 agent 亲手，记录进 `AGENTS.md` |

每期一个 worktree、一个 PR；**串行**（`~/projects/AGENTS.md` §3.0 并行隔离红线）。
