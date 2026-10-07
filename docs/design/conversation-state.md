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

## 4. 引擎现状核对（源码证据，2026-09-24 晚修正）

- transcript 累积：非 resume 时 initialMessages/initialUserMessage 作为 round 0 种子入档（`resume-manager.js:245`），每轮 appendRound 到同一 key——跨调用累积**已支持**
- 字节级恢复：`resume: true` 时 `store.load(key)` 全量恢复（含 tool_use/fold/语义状态，`resume-manager.js:68`）
- **缺口（初判，后被 CLI 推翻）**：resume 路径 `ctx.messages = restoredMessages` 直接覆盖（`resume-manager.js:89`），initialMessages 被静默丢弃——曾据此提 erix-agent#135
- **CLI 既存答案（bin/cli.js:566-614、bin/repl.js:602-656）**：transcript key = `--session` 会话 ID；每轮 load 查历史，有记录 → 宿主自行 `appendRound` 预写入新 user 消息（round=latestRound，dedupKey 唯一）→ `resume: true`；repl 明确 resume 时不传 initialMessages（`...(resume ? {} : { initialMessages, initialUserMessage })`）。**多轮续跑引擎零改动**，#135 已修正为契约文档化请求
- 结论：P2 依赖解除，照抄 CLI 模式；崩溃重跑 vs 下一轮的判据 = 记录 dedupKey（建议 `<key>:input:<messageId>`）幂等

## 4.1 目标态接线图（station 侧）

```
engine 视角：runToolLoop(key=sessionId, resume=有记录, store)
  ├─ 空本子（会话首条）→ 不 resume，initialUserMessage 全新路径
  ├─ 新消息未入档（正常下一轮）→ worker 预写入 appendRound（dedupKey 幂等）→ resume
  └─ 消息已入档（崩溃重跑 attempt>1）→ 直接 resume（不重复写入）
runId：退回纯运维身份（runs 表/事件流/租约/计费），不进 store key
```

## 5. 分阶段实施

| Phase | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **P0** | 本设计定稿；上游 issue（resume + new user turn）；#77 跟踪 | — | 本文档 |
| **P1** | #64 R1：产物回收 + **终态清场语义修正**（真相层归档 TTL 替代物理删除，只清视图/临时物；`ERIX_RUN_DATA_TTL_HOURS` 语义扩展为归档而非删除） | — | 待派工 |
| **P2** | #81 P2：store key 切 session 维度（**照抄 CLI 预写入+resume 模式，引擎零改动**）：portal 轮记录按 session 索引（表迁移）、worker 变树消费者、新消息预写入（dedupKey 幂等判据） | 无（CLI 已验证模式） | **已实施**（`feat-260924-06-session-transcript`：迁移 0006 + portal S1–S6 端点 + worker 三分支装配；部署顺序：portal 先上、FDE 镜像后上） |
| **P3** | messages 表降级 UI 投影；#70 文本注入退役（仅保留 transcript 缺失兜底） | P2 稳定（已实施） | **契约已定稿（§6）**，按 PR①、②a、②b、③推进（读路径投影 → POST 事务落 transcript → 停双写/切终态与标题数据源 → 退役注入） |

## 6. P3 实施契约（2026-10-08 定稿）

> 决策者拍板（对话记录）：①「一说话就该写入 store」；②「投影不是上下文创建，是同一份数据换个角度」；③「折叠的是上下文，显示的是历史消息」。④ 经 PR① 真机检查后修订：历史会话不删除，增量回填可投影的 transcript 输入行。
> 上游缺口已提 issue：`git.erix.vip/eric/erix-llm-kit#95`（宿主展示投影契约缺失，含反模式与 helper 请求）。

### 契约四条（实现必须遵守）

| # | 定稿 | 理由/依据 |
|---|---|---|
| **①** | **portal 在 POST 消息的事务内直写 session transcript**（沿用既有幂等键 `dedupKey = <sessionId>:input:<messageId>`）；**删除 runner 的「预写入」分支** | 现在 portal 先写 `messages` + 入队、runner 领活后才补写 transcript → 中间有窗口（消息已可见、transcript 未落）→ 断层 → 只能靠文本注入兜底。写入时机提前到消息落库那一刻，写入方由 runner 改为 portal（portal 本就是 DB 权威，无需经 S2 writer 租约端点） |
| **②** | 消息列表**读时从 transcript 派生**（投影）：`id` 按确定性规则生成（刷新前后稳定）、`seq` 沿用现有 `chat_sessions.last_seq` 分配器（与 `run_events` 共用序列）、`attachments`/`run` 归属留在 `messages` **锚点行**；**内容不再双写**、**不引入物化表/缓存**（实测慢再议） | 重叠的只是「文本内容」；`messages` 独占的是 UI 元数据（seq/附件/run 归属），transcript 独占的是协议细节（工具调用、推理、结构化 parts、折叠状态）。让重叠部分单一来源、非重叠部分各留各的 → 结构上不可能再分叉 |
| **③** | **UI 一律显示 `record` 全量**；`folded`/`foldedPayload` **只作用于模型上下文**（上下文节流），不作为展示内容 | 决策者原话「折叠的是上下文，显示的是历史消息」 |
| **④** | **不保留读时老数据兼容分支**：一次性增量迁移为缺少 transcript 文本证据的历史 user message 补 `:input:<messageId>` 行；**不删除旧会话**，投影代码不读 `messages.content` 兜底 | 真机证据表明删除会丢失仍需展示的数据；迁移只增不改，既保留旧对话，又允许移除投影兜底 |

用户消息的投影归属也必须确定性：`<sessionId>:input:<messageId>` 按 message ID 精确映射，优先于文本匹配；其它 transcript 行（无论是否带 `run_id`）按 `record.messages` 顺序遍历全部 user 文本，与同 session 尚未认领的非合成 user 锚点按 `seq` 升序精确匹配，认领第一个相同文本。按文本分组的锚点队列使用单调游标，避免每条候选反复扫描全部锚点。没有精确匹配就留空；不得因行的 `run_id`、时间/位置顺序或 `messages` 锚点内容推测归属。助手文本仍按 run 归组：显式 `run_id` 行使用该 ID，session-scoped 行沿用 transcript 分段得到的 run。

### 落点与可替换性

- **投影逻辑收敛到单一模块**（如 `portal/src/session-view.js`），读路径只经它 —— 上游若提供官方 `projectTranscriptForDisplay`（#95），**直接替换该模块并删除自研部分**。（上游 0.15.0 已交付该 API；接线属 PR②b，本 PR 未动读路径。）
- **写侧（契约①）实现分工已换到引擎 API**（erix-agent 0.15.0 `appendUserTurn`，上游 #97 闭环）：POST 事务内的预写由引擎承担 round 推导、dedupKey 生成、record 形态与幂等判据；station 只提供极小 store 适配器 `portal/src/transcript-store.js`（`load`/`appendRound` 复用调用方事务 client，落库列形态与原手搋时代逐列等价，「先写 transcript 再入队」顺序不变）。幂等主判据从 DB `ON CONFLICT` 换为引擎按 dedupKey 的 load 判据（顺序重放），`ON CONFLICT` 保留作并发最后防线（同 key 并发由 session `FOR UPDATE` 串行化，满足引擎「在接收事务内发起」的前提）。
- 与上游 ADR-018/0.12–0.14 契约的关系：本契约只涉及**读/展示侧**；写侧由 portal 先提交 session transcript、worker 再 resume 的多轮模式见上游 issue #135（本契约 ① 即其实现在 station 的收敛，0.15.0 后由 `appendUserTurn` 承接）。

### 拆解（四个可独立验收的 PR）

| PR | 内容 | 验收 |
|---|---|---|
| **①读路径投影** | 定义投影 DTO 与派生规则（`id`/`seq`/`attachments`/`run` 归属/折叠呈现），`GET /api/sessions/:id` 改走投影；`messages` 仍双写（本 PR 不动写路径，保证可回退）；带**过渡兜底**：当前写路径尚未把用户输入落入 transcript 时，缺少可派生内容的锚点暂回退到自身内容 | 根 `npm test`、前端 `vue-tsc` + vitest、`wp3a`/`wp5` e2e；DTO 字段与语义不变 → **前端零改动** |
| **②a 先落树再入队（本 PR）** | portal POST 事务内写 session transcript；删 runner 预写入分支；新增 0015 一次性回填历史 user 输入；删除 PR① 投影内容兜底 | 根 `npm test`、前端 typecheck/vitest；真机由主 agent 验证同 session 多轮、崩溃 resume 与 transcript/投影等价性（所有非合成消息内容有 transcript 证据且非空） |
| **②b 停内容双写与切换数据源** | `messages` 降级为锚点行（停止写 `content`）；终态幂等比较从 `messages.final_text` 换到 transcript；AI 标题首条用户文本改从 transcript 取 | 根 `npm test`、前端两项、`wp3a`/`wp3b`/`wp5` e2e |
| **③退役文本注入** | `history` 仅保留「transcript 缺失」兜底（收窄到旧 ticket/异常路径） | 根 `npm test`、前端两项、`wp3b`/`wp5`/`wp6` e2e |

> **过渡兜底、回填决策与实测依据**：PR① 过渡兜底曾命中 30 次。真机全库检查发现 64 个会话中仅 2 个有 `:input:<messageId>` 行；抽查会话 `d86dda63-fc52-481c-9994-65ff29cb5eee` 的用户文本在整份 transcript 的 `record::text` 检索为 0 命中。原因是旧 POST 写路径只写 `messages`，未写 transcript。选择迁移 0015 回填而非删除旧会话，以保留历史数据并让旧会话继续渲染；回填只 INSERT、可幂等重放，随后删除投影兜底，缺证据内容留空。

### 待决策（UI 轮号口径，遗留项）

「轮号跨轮累计 vs 每 run 重置」仍未定（§7 已列）——PR① 实现投影时**先按现状口径**（不改变现有展示语义），单独评估后再改。

---

## 7. 红线与验收口径

- 红线：会话内容只走 IPC 内存、不进日志（对齐 #38 models 纪律）；引擎包改动只经上游 issue，station 不 fork 引擎
- token 预算：交给引擎 compaction 语义，宿主不再手动截断字节（#70 的截断保留为兜底）
- 验收（P2 后）：同 session 第 N 轮，模型能引用第 N-1 轮的**工具调用级细节**（如「刚写的 server.js 用了 4008 端口」），而非文本复述；执行崩溃恢复不丢会话；UI 轮号语义变化需前端适配（⚠️ 待决策：轮号跨轮累计 vs 每 run 重置的展示口径）
