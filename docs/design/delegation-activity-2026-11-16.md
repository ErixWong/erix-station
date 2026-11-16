# 子 run 活动可视化：把 delegation 的「在跑什么」冒泡给平台

> 2026-11-16。主 agent 的**调研 + 方案**（未实现）。前置：`docs/design/delegation-2026-11-08.md`
> （P1/P2/P3 已落地，台账 §8.103）。本文只回答一个问题：**子 run 跑起来之后，平台怎么知道
> 「现在有几个在跑、各自在干啥」，并且把它画出来**。
>
> 状态：**可研（待裁决）**。第 4 节是推荐方案，第 6 节是分期；第 3 节的三条通路是并列备选，
> 不是「已经选好了再找理由」。

---

## 0. 一句话结论

**缺的不是数据，是读它的那个读者。** 子 run 的「活着 / 在干啥」两件事今天都已经落在 FDE 家目录里
（名册 + 账本，逐消息行、工具粒度），门户也有两个只读端点，但：

1. **前端从来没调用过名册端点**（`GET /api/sessions/:id/delegates?runId=`，P2 交付，零消费者）；
2. 子 run 跑着的整段时间里，**前端连它的 `childRunId` 都拿不到**（前台子要等工具返回才回 `runId`），
   于是连「点开抽屉」这个已有的能力都无处可点；
3. 因此界面上「有几个子 run 在跑」= **恒 0**，直到父 run 的工具卡返回结果。

⇒ 推荐 **A 方案（轮询读侧）**：前端在「本轮存在 delegate 卡」时按 2s 轮询名册端点，
拿到活态子清单 → 徽标显示 `N` → 展开面板 → 每行给出「状态 / 已跑多久 / **最近一个动作**」→
点行打开**已有的**只读抽屉看实时对话。后端只加一个可选的 `activity=1` 摘要（带 (size,mtime) 缓存），
**不碰 SSE、不碰 `run_events`、不碰 DDL**。

**最小可用版本（阶段 0）零后端改动**：只把已存在的名册端点接进前端，就能做到
「有几个在跑 + 点进去看它在干啥」。

---

## 1. 问题现场：用户看到的是什么

### 1.1 今天的三个可见面（全部与「正在跑的子 run」无关）

| 面 | 坐标 | 它回答什么 | 它答不了什么 |
|---|---|---|---|
| 工具卡 | `portal/frontend/src/components/StreamPanel.vue:157-215` | 子 run **结束后**的 action / 短码 / 状态徽标 | 跑着的时候：卡片摘要位是 `getToolPreview(args)`，而它的 `PREVIEW_KEYS` 只有 `command/path/file_path/pattern/query`，全不中时取「第一个键的值」（`lib/toolSummary.ts:5-22`）——delegate 的 args 通常以 `action` 打头 ⇒ 屏幕上就是「🔧 delegate · run …」，**任务文本都不显示** |
| 「查看子任务」按钮 | 同上 `:208`（`openable = p.ok === true && p.runId !== ''`） | 打开只读抽屉 | 前台子跑着时 `runId` 还没回来 ⇒ `p` 为 `null` ⇒ **按钮不存在** |
| 只读抽屉 | `components/DelegateChildDrawer.vue` | 子 run 的**实时**对话（2s 轮询，终态即停） | 它需要 `childRunId` + `parentRunId`；**今天没有任何 UI 能在子 run 结束前提供 `childRunId`** |

`RunStatusBar.vue`（`views/WorkbenchView.vue:371`，贴 composer 上沿的那条）里**没有任何子 run 段**
（`grep -n delegate RunStatusBar.vue` = 0）——2026-11-08 设计 §6 表格里「顶栏 Agents 徽标 → `RunStatusBar`
里加一段 `子 run N`」**这一格从未实现**。

### 1.2 不可见窗口有多大（不是几秒，是分钟级）

- 前台子是**默认**：模型不传 `background:true` ⇒ 引擎 `await child` 之后才返回工具结果
  （`erix-agent/src/tools/delegation/tool.js:433-449`）。
- 单个子的时间预算缺省 **240s**（`runner/lib/delegation.js:40`），并发缺省 **2**（`:42`，跨进程租约）。
  ⇒ 一次「派两个子任务」的父 run，界面上**最长约 4 分钟**是「🔧 delegate · run …」加一个 `…`。
- 后台子（`background:true`）反而是**可见的**：工具立刻回 `{ok:true, runId, state:'running'}`（`tool.js:456-458`）
  ⇒ 卡片带 `running` 徽标 + 可点按钮。但：① 没有任何提示词/说明让模型倾向用它；
  ② 本站的 `notifyParent` 只打一行日志（`runner/lib/delegation.js:365`）⇒ 子完成**不会**唤醒父，
  父要么自己轮 `status` 要么永远不知道 ⇒ 实际生产中后台子近乎不出现。

### 1.3 为什么 pi-web 有「列表 + 徽标」，本站没有

pi-web 的 subagent **就是一个会话**：`SessionInfo.relation = {kind:'subagent', parentSessionId}`
（`~/projects/github/pi-web/lib/session-family.ts` 的 `resolveFamilyRoots`），于是它天然进了会话列表、
天然有 SSE 的 `runningSessionIds`、天然能算「family 里有几个在跑」
（`countRunningSubagents`）→ 顶栏一个带转圈的计数徽标（`components/AppShell.tsx:1727-1760`）+
`AgentSessionPanel` 每行一个 agent。**它白拿的那些东西，全部来自「子 = DB 里的一行」。**

本站的子**不是会话**，而且是两条 DDL 硬约束挡死的（`docs/data/schema.sql` 的
`runs.session_id NOT NULL` + `runs_one_active_per_session`，见 delegation 设计 §1）：
父在跑时同会话塞不进第二个活跃 run。⇒ 子 = 同进程嵌套的第二个 `runToolLoop`，
它的全部事实只存在于**文件**里。**本文的整个工作量，就是把 pi-web 在 DB 面上白拿的东西，在文件面上重建出来。**

---

## 2. 事实面盘点：磁盘上有什么、多新、读它多贵

布局是 `docs/design/delegation-2026-11-08.md` §3 定的（门户与 runner 同源）：

```
<userSpaceRoot>/<fde>/home/delegation/
├── roster/<parentRunId>/<childRunId>.json      引擎写：状态机（queued→running→终态）
├── leases/slot-<i>.lock                        引擎写：每 FDE 共享的子 run 槽位（配额真相）
└── transcripts/<childRunId>.jsonl              引擎文件 store 写：**逐消息行**的账本
    transcripts/<childRunId>.status.json        引擎 markRunState：run 起/终
    transcripts/<childRunId>.state.json         引擎 saveRunState：每轮一份（latest-only 覆盖写）
    transcripts/<childRunId>.recovery.jsonl     引擎恢复行（tool-executed，**只有 toolUseId 没有工具名**）
```

| 源 | 写时机（新鲜度） | 能回答 | 读它的成本 |
|---|---|---|---|
| `roster/*.json` | **只有状态跃迁**：`queued`（`tool.js:396`）→ `running`（`:418`，在调 `runChild` **之前**）→ 终态 | 有几个、各自的 state/cwd/createdAt/termination/**resultText** | 极小（每条几百字节） |
| `transcripts/*.jsonl` | **一条消息一行**（0.23 起「一条消息一落盘」：assistant 正文、每个 `tool_result` 各写一行，`erix-agent/src/store/message-rows.js` 头注） | **在干啥**：最后一条消息是谁、调了哪个工具、参数摘要、正文片段 | O(文件大小)；真机样本 21KB / 38KB，上限口径 8MiB |
| `transcripts/*.status.json` | run 起 / 终 | 活着没 | 极小 |
| `leases/slot-*.lock` | 取/还槽 | 全局子配额占用（第 3 个 `delegate` 会被 `capacity_full` 拒，`tool.js` 的 `acquire`） | 极小（readdir + N 个小文件） |

**三条从这张表直接读出来的结论**：

1. **「在干啥」的唯一来源是账本**（`roster` 只有状态词汇，`recovery.jsonl` 只有 `toolUseId` 没有工具名，
   `.state.json` 是每轮覆盖写的 latest-only，且引擎**没有**导出任何读取器
   ——实测 `erix-agent` 根与 `erix-agent/tools` 两个导出面里 `tailChildTranscript` /
   `readTranscriptTailLines` / `listRecoveryRows` **全是 `undefined`**）。
2. 账本的**新鲜度是「工具粒度」**：子每完成一个工具结果就落一行 ⇒ 轮询它得到的不是「上一轮的样子」，
   而是「它刚刚在干的那一步」。这一点是 A 方案成立的技术前提。
3. **门户已有的投影链路可以直接复用**：`portal/src/delegation.js:262` 的
   `getDelegateTranscript` 已经是「读全量行 → `foldLedgerRecords` → `projectTranscriptForDisplay` → 才切尾」，
   而且 `toolCalls[].argsSummary` 就是「工具名 + 参数摘要」——**面板要的那句话，现成的**。

**两个必须提前记住的缺口**（会影响 UI 能承诺什么）：

- **名册里没有 per-child 的 token 用量**：引擎 `finishRun` 只搬 `state/termination/verification/
  budgetSource/resultText/errorMessage`（`tool.js:271-330` 的 `finishRun`），usage 是宿主并进父的 `RUN_FINISHED`
  （裁决 ③）。⇒ 面板**不能**显示「每个子花了多少 token」，除非另外从账本 `response.usage` 求和（额外工作，见 §4.1 可选字段）。
- **名册的 `deadlineAt` 缺省不存在**：它只在**模型**显式传 `deadlineMs` 时写（`tool.js:405`），
  而本站的 240s 缺省是在 `runChild` 里换算的（`runner/lib/delegation.js:275-317`，`timing.deadlineMs`
  取绝对时刻）⇒ 名册那条记录里没有 `deadlineAt` ⇒ 面板**不能**
  画「预算进度条」，只能画「已跑多久」（用 `createdAt` + 客户端时钟）。

---

## 3. 三条候选通路（并列比较，不是「先选后找理由」）

| | A 轮询读侧（推荐） | B 事件冒泡（SSE） | C 宿主 sidecar 活动文件 |
|---|---|---|---|
| 数据怎么到浏览器 | 前端每 2s `GET` 一个只读端点 | runner 把子事件经 agentd → portal → SSE 推下去 | runner 每次子事件原子写一个小 JSON，前端轮询它 |
| runner 改动 | **零** | 新 IPC 消息类型 + agentd 路由 + 节流 | ~40 行（`onEvent` 里节流写盘）+ 新目录 + 归属 + 清理 |
| 门户改动 | 一个可选摘要（阶段 1）；阶段 0 零改动 | 新 internal 端点（或新事件类型）+ 新 SSE 事件名 | 新读侧 + 路径白名单 |
| 新鲜度 | ≤2s | 亚秒（但必须节流，否则事件洪泛） | ≤1s |
| 断线/刷新 | **天然自愈**（下一发就是真相） | 需要补偿语义（SSE 断了就没了；落库才能回放） | 天然自愈 |
| 与现有契约的摩擦 | 极低（不动三处事件白名单） | **高**：若落 `run_events`，要动「写入侧 + `HISTORY_EVENT_TYPES` + 前端 `EVENT_TYPES` + `HISTORY_REPLAY_TYPES`」四处集合（`portal/src/http.js:2663` 起那一大段血泪注），还要进 `engineEventSurface.spec.ts` 的对账；而且子事件挂在**父** run_id 下会污染父时间线的语义（卡片/分隔条按 `type` 分派） | 中：新增第二份「子 run 事实」，与账本存在漂移风险 |
| 结论 | **做** | 只在「亚秒级是硬需求」时再做 | 不做（与账本重复，且有清理债） |

**B 方案为什么不该顺手做**：本站事件面是「三处集合各自独立存亡」的老坑（`#288`：只加一边就是
「实时看得见、刷新后消失」或反之）。子 run 的事件**不是父 run 的时间线事件**——把 `delegate` 子的
`tool_use` 塞进父的 `run_events` 会让父的卡片区凭空多出几张「不属于这次 run」的卡，且
`client_event_id` 形状（`<run_id>:<attempt>:<n>`）与 `seq` 分配都归父 run。真要实时，正确做法是
**另开一条不进 DB 的会话级 SSE 通道**（先例：`notifyQueueUpdate` / `run_assigned` 那种），
那是「阶段 2 可选」，不是第一版。

**被否决的结构性方案（记录理由，别再提）**：放宽 DDL 让子 run 成为 `runs` 的一行（或新建 `child_runs`）。
好处是 §1.3 说的那些「白拿」全部自动生效；代价是：① `runs_one_active_per_session` 同时是 notes
**单写者不变量**的依据（`runner/worker.js:622-623` 注释），动了它要重证那一整块；
② 「子 run 的生命周期归引擎还是归本站」会分裂（今天归引擎，名册的归档/清理是宿主责任，`removeRecord`
已从引擎删除）；③ 迁移 + 现有 4 处事件白名单全要重审。**结论：不做，写在这里是为了下次不必重新论证。**

---

## 4. 推荐方案（A）：读侧轮询 + 一个徽标 + 一个面板

### 4.1 数据面

#### 阶段 0（零后端）

直接消费**已存在**的端点：

```
GET /api/sessions/:sessionId/delegates?runId=<parentRunId>
→ { items: [{childRunId, state, cwd, model, createdAt, endedAt, updatedAt,
             termination, errorMessage, resultTruncated, hasTranscript}], skipped }
```

（`portal/src/delegation.js:196`；`parentRunId` = 前端已有的 `es.activeRunId`，
刷新后由 `reconcileActiveRun` 从 `GET /api/sessions/:id` 的 `active_run_id` 恢复，`stores/workbench.ts:951`。）

每行的 `state` 走 `lib/delegate.ts#delegateBadgeKind(state, termination)` 分级（**不新造枚举**；
`completed` + `persistence_failed` 仍判红这条红线自动继承）。「几个在跑」= 活态计数
（`DELEGATE_LIVE_STATES` = `queued|running`，同一份尺规）。

#### 阶段 1（加一个可选摘要，回答「在干啥」）

**不改现有响应形状**，只在带 `?activity=1` 时给每条 item 追加 `activity`：

```
GET /api/sessions/:id/delegates?runId=<parentRunId>&activity=1
→ items[i].activity = {
    at: 1752730000123,          // 账本 mtime（写盘证据，不是消息自己的 ts）
    ageMs: 1200,                // 服务端算一次，客户端也能自己算（给不给都行）
    turns: 7,                   // 投影后的逻辑消息数（= 现在抽屉的 totalTurns）
    kind: 'tool' | 'text' | 'tool_result' | 'none',
    tool: 'bash',               // kind=tool 时的工具名
    args: 'npm test',           // 工具参数摘要（复用上游 argsSummary，≤120 字）
    text: '正在整理结论…',       // kind∈{text,tool_result} 时的正文片段（≤120 字）
    stale: false                // 见 4.4 ③
  }
```

**取数纪律（每条都是判据，见 §5）**：

1. **只对活态子读账本**；终态子 `activity` 不读文件（它的终稿在 `roster.resultText` 里，
   而抽屉已经能看全文）。
2. **缓存键 = `(childRunId, size, mtimeMs)`**：`stat` 说没变就复用上次的摘要，
   **零 `readFile`**。子 run 是逐消息追加，2s 一轮里绝大多数轮次命中缓存
   ⇒ 稳态成本 ≈ N 次 `stat`。
3. **上限**：账本 > 8MiB ⇒ 不读，`activity` 只给 `{kind:'none'}`（`stale` 仍按 4.4 ③ 判）
   （**不 413**：面板不是正文读取面，降级比报错合理）。
4. **SQL 一次**：现在 `listDelegates` 每次 3 条（`fetchSession` + `users` + `runs`，`portal/src/delegation.js:167-186`）；
   `activity=1` 这条走**一条 join**（`chat_sessions` × `users` × `runs`），并把
   「父 run 是否已终态」一起取回来（4.4 ③ 要用）。**404 必须先于 400**（越权的人不该从错误码读出
   「这个 session 存在」——现有注释已写明这条，照抄）。
5. **DTO 白名单不变**：`transcriptPath` / `pid` / `statusPath` / `verification` 仍然**不下发**
   （`portal/src/delegation.js:144` 的既有裁决），`activity` 是**新加的一个键**，不是把 record 摊开。
6. 可选（便宜就做）：`tokens` = 折叠时顺带把 `response.usage` 逐轮相加。
   拿不到就是 `null`（**不许写 0 冒充**）。

「最近一个动作」的取法（服务端，纯函数、可单测）：把投影后的 `messages` **从后往前**扫，
取**第一条**能定性为动作的消息：有 `toolCalls[].argsSummary` ⇒ `kind:'tool'`；
`role==='assistant'` 且有正文 ⇒ `kind:'text'`；只有工具结果 ⇒ `kind:'tool_result'`；
一条都没有 ⇒ `kind:'none'`。**不许**从原始行里自己拼 JSON（折叠口径唯一来源是
`foldLedgerRecords` → `projectTranscriptForDisplay`，`portal/src/delegation.js:323` 的既有红线）。

### 4.2 前端：什么时候轮询（这条决定成本，也决定「刷新后还在不在」）

新增 `composables/useDelegateActivity.ts`，**触发条件是本轮存在 delegate 卡**，而不是「run 在跑」：

```
activeRunId != null
  && entries 里存在 name === 'delegate' 的卡，且 (ok === null || state ∈ 活态)
  ⇒ 每 DELEGATE_POLL_MS（2000，复用 lib/delegate.ts:53）拉一次
  所有子终态 && 没有 pending 的 delegate 卡  ⇒ 停
```

- **为什么不是「run 在跑就轮询」**：那会在每一个没派过子任务的 run 上白打 2s 心跳
  （长 run 常见），而「有没有派过子」前端**本来就知道**（`tool_use` 事件就在流里，
  `HISTORY_EVENT_TYPES` 含 `tool_use` ⇒ 刷新后历史回放也会把卡建回来，`portal/src/http.js:2663` 白名单）。
- **四条轮询纪律**（与 `DelegateChildDrawer.vue` 同一套，但**用 `setInterval` + `inFlight`**，
  理由见 §8 的「抽屉单飞不可证伪」）：单飞、`document.visibilityState === 'visible'` 才发、
  终态即停、`onUnmounted` 清 timer + abort 在途。
- 失败语义：**静默保留上次数据**（面板不闪、不报错条），连续 N 次失败才降级成一行中性提示
  （「子任务状态暂不可读」）。子 run 是加分项，读不到不该把父界面打成故障态。

### 4.3 形态：徽标（banner）+ 面板（panel）+ 复用抽屉

```
┌ 消息流 ─────────────────────────────────────────────┐
│ …                                                   │
├─────────────────────────────────────────────────────┤
│ ● run 1:12  ↑1.2k ↓340   🔧 3          🤖 子任务 2 ◍ │  ← RunStatusBar 尾部追加一段（不新开一条）
├─────────────────────────────────────────────────────┤
│  🤖 子任务 2/2 槽位    [收起]                        │  ← 展开态：贴在状态条下方、队列条上方
│  ● 3f9a21c4  已跑 42s   🔧 bash · npm test      [查看]│
│  ● 7b0e5d12  已跑 38s   💬 正在整理结论…        [查看]│
└─────────────────────────────────────────────────────┘
│ [ 输入框 ]                                          │
```

- **落点**：徽标挂在 `RunStatusBar.vue` **尾部**（它已经是「run 级状态」的唯一落点，`#282` 定的），
  面板挂在它下面、`QueuedInputsBar` 上面（`views/WorkbenchView.vue:371-375` 的读序
  「现在在跑什么 → 还排队说什么 → 输入框」正好容得下这一段）。
- **只在有活态子时出现**；终态后收起（历史子 run 归工具卡，不占常驻界面）。
- 行内容：状态点（颜色唯一来源 `DELEGATE_BADGE_CLASS`）+ 短码（`shortRunId`）+ 已跑时长
  + 一句 `activity`（`kind` 决定图标：🔧 工具 / 💬 正文 / ✓ 结果）+ 「查看」按钮。
- 「查看」打开**已有的** `DelegateChildDrawer`。⚠ **实现约束**：抽屉今天挂在 `StreamPanel.vue:718`
  的单一位置，`delegateOpen` 是组件内 `ref`。面板要用它 ⇒ **必须把 `delegateOpen` 提到 store
  （或一个 composable）**，两个入口都写同一份状态，**仍然只有一个挂载点**。别复制第二个抽屉实例
  （那会得到两份轮询、两套 abort、两份 `state`）。
- 槽位显示（可选）：`2/2 槽位` 来自 `leases/slot-*.lock` 的占用数；它解释「为什么第三个 delegate
  被 `capacity_full` 拒了」，是这一行唯一能回答的「为什么没有第三个」。

### 4.4 四种边界的处理（每条都是真实会发生的）

① **刷新页面**：`activeRunId` 由 `reconcileActiveRun` 恢复（`stores/workbench.ts:951`），
delegate 卡由历史回放重建（`tool_use` 在白名单里）⇒ 面板**会**自己回来。
前提是刷新时那次 `GET /api/sessions/:id` 成功；失败就退化成「没有面板」，不报错。

② **多标签页 / 后台页**：每个打开的工作台都会轮询（N × 0.5qps）。可见性门控挡住后台页；
多标签页是接受的成本（与 `usePreviewPorts` 同族）。

③ **父 run 已终态、子名册还写着 `running`**（**后台子**的真实形状：父跑完 ⇒ worker 进程退出 ⇒
嵌套的子 `runToolLoop` 随进程消失 ⇒ 那句 `finishRun` 永远不会执行 ⇒ 名册**永久**停在 `running`）。
⇒ 门户**不许**自己判死：
- **不能**用 `pid` 判活：名册的 `pid` 是**容器内**的 PID（`tool.js:375` / `:406` 写的是 `process.pid`），
  门户在宿主上，两个 PID namespace，`kill(pid,0)` 读到的是**另一个进程**（危险且必然错）。
- **不能**改写名册（门户对名册零写操作，这是既有裁决）。
- 正确做法：`activity=1` 那次 join 顺手取父 run 的 `status`；父 run 终态而子仍是活态 ⇒
  `activity.stale = true` ⇒ 前端这一行画 ⚪「状态未知（父 run 已结束）」并**停止**把它计入活态数
  （与 D9 的「⚪ 不得渲染成绿」同一口径：绿是承诺，没证据就没资格承诺）。
  名册 TTL / 归档仍是**未做**的债（delegation 设计 §9 已登记），本文不顺手做。

④ **`capacity_full` 拒单**：名册里**没有**这一条（`tool.js` 在 `acquire` 失败时直接返回，
没有记录）⇒ 面板看不到它，工具卡的 `{ok:false, reason:'capacity_full'}` 仍然是唯一提示。
这解释了「为什么面板数 ≠ 模型以为派出去的数量」。

---

## 5. 判据（每条都必须能红；「跑通了」不算）

**端点（`portal/test/delegation.test.js` 既有 770 行里加格，不新开文件）**

1. **不带 `activity=1` ⇒ 响应与今天逐字段相同**（形状不变）。变异：无条件加 `activity` ⇒ 红。
2. **只对活态子读账本**：终态子 `fs.readFile` 调用数为 0（spy 计数）。变异：对所有子都读 ⇒ 红。
3. **缓存命中**：同一 `(size,mtime)` 第二次调用 `readFile` = 0 次、返回同一份 `activity`。
   变异：去掉缓存 ⇒ 红。
4. **超大账本**：> 8MiB ⇒ 不读、`kind:'none'`、**不是** 413、不是 500。变异：`readFile` 照读 ⇒ 红。
5. **越权先于形状**：非属主 404、`runId` 形状错 400，且顺序与基端点一致。变异：先校验 `runId` ⇒ 红。
6. **SQL 条数上限 = 1**（`pool.query` spy）。变异：复用 `resolveScope` 的三连 ⇒ 红。
7. **`stale`**：父 run 终态 + 子活态 ⇒ `stale:true`；父 run 活态 ⇒ `stale:false`。
   变异：恒 false ⇒ 红。
8. **`kind` 判定**：`tool`（有 `argsSummary`）/ `text`（assistant 正文）/ `none`（空账本）三格各一条。
   变异：从原始行自己拼 ⇒ 用「分片行（`partOf`）」的账本夹具 ⇒ 红。

**前端（vitest，`timeout 240`；别用 `w.emitted()` —— `NODE_ENV=production` 下它恒空）**

9. **没有 delegate 卡 ⇒ 零请求**。变异：按 `activeRunId` 轮询 ⇒ 红。
10. **有 pending delegate 卡 ⇒ 2s 一发且单飞**（`setInterval` + `inFlight`；变异去掉 `inFlight` ⇒ 红）。
11. **全部子终态 ⇒ 停**（变异：不停 ⇒ 红）。
12. **可见性门控**：`hidden` 期间零请求，恢复可见立刻补一发。
13. **徽标数 = 活态子数**（终态子不计数；`stale` 行不计数）。
14. **点「查看」打开抽屉**（DOM 断言：抽屉标题出现 `子任务 <短码>`）。
15. **刷新路径**：历史回放建出 `ok:null` 的 delegate 卡 ⇒ 面板仍能拉到并渲染行。
16. **失败静默**：端点 500 ⇒ 保留上次行、不渲染红条。

**真机 e2e（主 agent 亲手，playwright + vision）**

17. 派 2 个读密集子任务 ⇒ 面板出现 2 行、各自「已跑 Ns」在涨、`activity` 显示工具名；
    截图 + vision 确认渲染。
18. 点开其中一行 ⇒ 抽屉里是子 run 的实时对话（与账本对得上）。
19. 子完成 ⇒ 徽标消失/归零，工具卡仍是既有形态（`✓` + 可点）。
20. 中途刷新 ⇒ 面板与抽屉都回来（4.4 ①）。

---

## 6. 分期与派工

| 阶段 | 内容 | 交付 | 后端改动 |
|---|---|---|---|
| **0** | 接现有名册端点 + 徽标 + 面板（state/时长/短码）+ 「查看」复用抽屉（`delegateOpen` 上提） | `useDelegateActivity.ts` + `DelegateActivityBar.vue` + `RunStatusBar` 尾部一段 + 双语键 + spec | **零** |
| **1** | `activity=1` 摘要 + 缓存 + `stale` + 一条 join | `portal/src/delegation.js` 加分支 + 端点测试 8 格 | 一个可选参数 |
| **2**（可选） | ① 槽位占用 `N/M`；② 名册 TTL/归档；③ 真·实时（不进 DB 的会话级 SSE 通道） | 各自独立 | — |

派工口径（`~/projects/AGENTS.md` §3.0）：**阶段 0 与阶段 1 串行**（阶段 1 的 DTO 会被阶段 0 的组件消费，
并行会互相改同一个 spec）；每个阶段一个 worktree + 一个 PR；前端命令一律
`cd portal/frontend && timeout 240 npm test -- src/xxx.spec.ts` + `npm run typecheck`；
根 `npm test` 判绿**只看退出码**（`npm test && echo GREEN`），别 grep 摘要行。

---

## 7. 已知边界（写进文档，不许当 bug 修）

- **子 run 不是会话**：面板是「当前 run 的子 run 列表」，不是「所有 agent 的列表」；
  换会话/换 run 面板就换内容，终态后不常驻。
- **新鲜度上限是 2s**（轮询间隔），且账本按**消息**落盘 ⇒ 一个跑 60s 的单条 shell 命令期间，
  面板会一直显示「🔧 bash · <那条命令>」——这**是正确**的（它确实还在跑那条命令）。
- **per-child token 用量不在名册里**（§2 缺口），面板默认不显示；要显示就得走 §4.1 第 6 条的可选求和。
- **`deadlineAt` 缺省不存在** ⇒ 不画预算进度条。
- **门户不判子 run 死活**（PID namespace 不同），只做 `stale` 标记（4.4 ③）。
- **名册/账本无 TTL**：面板只读，不清理；清理是独立一片。
- **不做**：跨会话/跨 FDE 的全局 agent 面板（那需要另一条读侧与另一个权限面）、子 run 的停止/steer
  按钮（引擎事实：前台子 `cancel` 恒 `not_owned`，`tool.js:545-552`）、把子事件灌进父 `run_events`。

---

## 8. 风险清单（每条：症状 / 触发条件 / 防御）

1. **面板永远转圈**：后台子的 `running` 记录永不过期（4.4 ③）。
   防御 = `stale` 标记 + 父 run 终态即停 + 该行不进活态计数。
2. **成本失控**：账本涨到 MB 级 + 2s 轮询 + 多标签页。
   防御 = `(size,mtime)` 缓存 + 8MiB 降级 + 可见性门控 + 只在有 delegate 卡时轮询。
3. **两处抽屉 / 两份轮询**：面板与 StreamPanel 各挂一个 `DelegateChildDrawer`。
   防御 = `delegateOpen` 上提、挂载点唯一（§4.3 的约束写成判据 14 的变异）。
4. **假绿**：`state=completed` 但 `termination` 是 syserr（`persistence_failed` 等）。
   防御 = 只用 `delegateBadgeKind`（`lib/delegate.ts:87`），**不许**在面板里写 `state === 'completed' ? 绿`。
5. **越权读别人家的账本**：新参数让路径拼装多一个入口。
   防御 = 路径只由两个 id 拼 + 复用 `resolveScope` + 判据 5。
6. **`activity` 变成第二份真相**：有人开始从原始 JSONL 自己拼消息。
   防御 = 只走 `foldLedgerRecords` → `projectTranscriptForDisplay`（判据 8 用分片夹具钉）。
7. **单飞不可证伪**（§8.103 记的老账：抽屉用链式 `setTimeout`，并发结构上不可能）。
   防御 = 新代码用 `setInterval` + `inFlight`，判据 10 能真红。

---

## 9. 待裁决（需要决策者拍板的三件事）

1. **要不要先建 issue**（本项目规矩：新需求先确认 issue；跨模块 + 多文件，建议建父单 + 两个子片）。
2. **阶段 0 是否照本文形态**（徽标在 `RunStatusBar` 尾部 + 展开面板），还是要一个常驻的右栏 panel
   （pi-web 是右栏 tab，本站没有 tab 架构；抽屉已被 P3 选定）。
3. **阶段 2 的真·实时要不要排**：本文的判断是「2s 轮询已经够回答『几个在跑 + 在干啥』」，
   SSE 冒泡是「更爽」而不是「更对」，且成本集中在事件面四处集合与断线补偿。
