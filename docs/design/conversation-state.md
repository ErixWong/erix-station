# 会话状态模型：三层生命周期与 session-scoped transcript（issue #77）

> 状态：**设计定稿待实施**（决策者 2026-09-24 授权，全权推进）。
> 依据：`design/principles.md`（不变式 3「DB 是状态真相」、D8「隔离单元 = worktree」）、
> `design/runner-integration.md`（erix-agent `runToolLoop`/`TranscriptStore` 锚点）、
> issue #64（产物回收）/ #69（历史注入，过渡方案）/ #70（已合并的第一版注入）。
> 参照系：**pi coding agent**（`@earendil-works/pi-coding-agent` docs/sessions.md、
> session-format.md、compaction.md）——与 erix-agent store 机制同构的生产级实现。

## 1. 问题：三种生命周期被焊在同一个 runId 上

协作场景里只有三种状态，但生命周期、消费者、恢复语义完全不同：

| 状态 | 内容 | 生命周期 | 消费者 | 真相位置 |
|---|---|---|---|---|
| **执行（run）** | 进程、租约、事件流、计费 | 分钟级，牲口，可崩可弃 | portal 运维 / UI 实时流 | DB（runs/run_events/run_queue） |
| **会话（conversation）** | 消息 + 工具调用 + 推理轨迹 | 与人的协作等长（天~周），单调增长、需压缩 | **模型**（每轮都需要） | ⚠️ 当前分裂（见下） |
| **工作区（workspace）** | 代码文件、产物 | 最长，跨一切 | 人 + 模型 | worktree / git / artifacts（#64） |

现状的病根：**runId 同时是运维单元和 transcript key**，导致会话真相分裂成两半——

- `messages` 表：纯文本（UI 渲染用），丢失 tool_use/tool_result 块；
- 引擎 transcript（`run_checkpoints`/轮记录）：字节级但**按 run 分片**，且终态清场时被 purge。

模型每轮需要的是字节级上文（「我上一轮写过哪个文件」藏在 write 工具调用里），两半都不是完整答案。#70 的文本注入是过渡方案：方向对（宿主显式供给），数据源错（纯文本 + 手动截断）。

## 2. 参照系：pi 的两个关键决策

pi（本地单用户，无远端宿主）的会话模型与 erix-agent store 机制**同构**，但更彻底：

1. **真相 append-only，永不删除**：一个 session = 一个 JSONL 树文件，所有条目（消息/工具/压缩/分支摘要）追加写入，物理上永不删。compaction 是**视图层**——追加 `CompactionEntry`（摘要 + `firstKeptEntryId`），下次发给 LLM 的上下文从「摘要 + 保留段」重建；真相层完整保留。
2. **用户消息先落树、执行只是消费者**：每条用户消息是往树上追加节点，执行（agent loop）无身份、随时可弃；崩溃恢复 = 重新加载文件。

对照结论：erix-agent 的 store（round 0 种子入档 + 每轮 appendRound 累积）**已经是 append-only 累积模型**（`resume-manager.js:245`），缺的不是机制，是 station 的接线方式——transcript key 用了 runId，且终态清场把真相当垃圾删了。

## 3. 目标态

```
用户视角：一个 session = 一段连续对话 + 一个工作区
              │
    ┌─────────┼──────────────┐
    ▼         ▼              ▼
 会话真相    执行单元       工作区
 session-scoped          worktree/artifacts
 engine transcript
 （key=sessionId，跨执行累积，append-only + 归档 TTL）
    ▲
    └── 每轮执行 = 「在树上追加一轮」：
        worker 领任务时拿到「树 + 新叶子」，崩溃不影响树
```

- **run 降级为纯运维单元**：领任务、租约、事件、计费——不承担会话语义
- **会话真相单源**：engine transcript，key = session，DB 承载，append-only + 归档 TTL
- **messages 表降级为 UI 投影**（从树投影），不再双写
- **新用户消息先落树、再派工**：portal 收到消息 → 写 session transcript → 派执行

## 4. 引擎现状核对（源码证据）

- transcript 累积：非 resume 时 initialMessages/initialUserMessage 作为 round 0 种子入档（`resume-manager.js:245`），每轮 appendRound 到同一 key——跨调用累积**已支持**
- 字节级恢复：`resume: true` 时 `store.load(key)` 全量恢复（含 tool_use/fold/语义状态，`resume-manager.js:68`）
- **缺口**：resume 路径 `ctx.messages = restoredMessages` 直接覆盖（`resume-manager.js:89`），`initialMessages` 被静默丢弃，`task` 只是 judge/reflection brief 不进消息列表（`orchestrator.js:1142`）——**resume 通道没有「追加新 user turn」语义**（resume 假设恢复被中断的同一条消息）
- 结论：目标态需要上游支持（提 issue 到 erix-agent），或宿主在 resume 前把新 user 消息作为记录写入 transcript（语义等价性待上游确认）

## 5. 分阶段实施

| Phase | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P0** | 本设计定稿；上游 issue（resume + new user turn）；#77 跟踪 | — | 本文档 |
| **P1** | #64 R1：产物回收 + **终态清场语义修正**（真相层归档 TTL 替代物理删除，只清视图/临时物；`ERIX_RUN_DATA_TTL_HOURS` 语义扩展为归档而非删除） | — | 待派工 |
| **P2** | store key 切 session 维度：宿主 adapter 映射、portal 轮记录按 session 索引（表迁移）、worker 变树消费者、新消息先落树 | 上游 issue 结论 | 待 P0 |
| **P3** | messages 表降级 UI 投影；#70 文本注入退役（保留为 transcript 缺失时的兜底） | P2 稳定 | 待 P2 |

## 6. 红线与验收口径

- 红线：会话内容只走 IPC 内存、不进日志（对齐 #38 models 纪律）；引擎包改动只经上游 issue，station 不 fork 引擎
- token 预算：交给引擎 compaction 语义，宿主不再手动截断字节（#70 的截断保留为兜底）
- 验收（P2 后）：同 session 第 N 轮，模型能引用第 N-1 轮的**工具调用级细节**（如「刚写的 server.js 用了 4008 端口」），而非文本复述；执行崩溃恢复不丢会话；UI 轮号语义变化需前端适配（⚠️ 待决策：轮号跨轮累计 vs 每 run 重置的展示口径）
