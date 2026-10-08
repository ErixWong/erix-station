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
| **P3** | messages 表降级 UI 投影；#70 文本注入退役（**PR③ 定稿为整链删除，不留兜底**） | P2 稳定（已实施） | **契约已定稿（§6）**；PR①/②a/②b/③ 已完成（读路径投影 → POST 事务落 transcript → 停双写/切数据源 → 退役注入），仅剩 **②c 残留数据收敛** |

## 6. P3 实施契约（2026-10-08 定稿）

> 决策者拍板（对话记录）：①「一说话就该写入 store」；②「投影不是上下文创建，是同一份数据换个角度」；③「折叠的是上下文，显示的是历史消息」。④ 经 PR① 真机检查后修订：历史会话不删除，增量回填可投影的 transcript 输入行。
> 上游缺口已提 issue：`git.erix.vip/eric/erix-llm-kit#95`（宿主展示投影契约缺失，含反模式与 helper 请求）。

### 契约四条（实现必须遵守）

| # | 定稿 | 理由/依据 |
|---|---|---|
| **①** | **portal 在 POST 消息的事务内直写 session transcript**（沿用既有幂等键 `dedupKey = <sessionId>:input:<messageId>`）；**删除 runner 的「预写入」分支** | 现在 portal 先写 `messages` + 入队、runner 领活后才补写 transcript → 中间有窗口（消息已可见、transcript 未落）→ 断层 → 只能靠文本注入兜底。写入时机提前到消息落库那一刻，写入方由 runner 改为 portal（portal 本就是 DB 权威，无需经 S2 writer 租约端点） |
| **②** | 消息列表**读时从 transcript 派生**（投影）：`id` 按确定性规则生成（刷新前后稳定）、`seq` 沿用现有 `chat_sessions.last_seq` 分配器（与 `run_events` 共用序列）、`attachments`/`run` 归属留在 `messages` **锚点行**；**内容不再双写**、**不引入物化表/缓存**（实测慢再议） | 重叠的只是「文本内容」；`messages` 独占的是 UI 元数据（seq/附件/run 归属），transcript 独占的是协议细节（工具调用、推理、结构化 parts、折叠状态）。让重叠部分单一来源、非重叠部分各留各的 → 结构上不可能再分叉 |
| **③** | **UI 一律显示 `record` 全量**；`folded`/`foldedPayload` **只作用于模型上下文**（上下文节流），不作为展示内容（PR②b 细化：「record 全量」= 官方投影给的展示字段，`foldedPayload` 按官方规则只展示「摘要 + 范围 + 导航指针」） | 决策者原话「折叠的是上下文，显示的是历史消息」 |
| **④** | **不保留读时老数据兼容分支**：一次性增量迁移为缺少 transcript 文本证据的历史 user message 补 `:input:<messageId>` 行；**不删除旧会话**，投影代码不读 `messages.content` 兜底 | 真机证据表明删除会丢失仍需展示的数据；迁移只增不改，既保留旧对话，又允许移除投影兜底 |

用户消息的投影归属也必须确定性：`<sessionId>:input:<messageId>` 按 message ID 精确映射（PR②b 后判据 = 官方投影带出的 `meta.dedupKey`，DB `dedup_key` 列与 record 内字段任一存在即生效），**一旦命中就不再参与文本匹配**；其它 transcript 行（无论是否带 `run_id`）按投影输出顺序遍历其 user 文本（`meta.synthetic` 的注入文本排除在外，引擎注入不得抢认真实用户锚点），与同 session 尚未认领的非合成 user 锚点按 `seq` 升序精确匹配，认领第一个相同文本。按文本分组的锚点队列使用单调游标，避免每条候选反复扫描全部锚点。没有精确匹配就留空；不得因行的 `run_id`、时间/位置顺序或 `messages` 锚点内容推测归属。助手文本仍按 run 归组：显式 `run_id` 行使用该 ID，session-scoped 行沿用 transcript 分段得到的 run（单 run 会话兜底，见 PR②a/#81）。

### 落点与可替换性

- **投影逻辑收敛到单一模块** `portal/src/session-view.js`，读路径只经它。**读侧已换上游官方投影（#95 闭环）**：
  「文本 / blocks / reasoning / 折叠」的推导自 PR②b 起由 `erix-agent` 0.15.0 的
  `projectTranscriptForDisplay(records)`（`docs/host-consumer-contract.md` → "Host display projection"）提供，
  **自研部分只剩锚点元数据映射**。官方投影不承担、仍由 station 承担的三条规则：
  ① **锚点元数据**（`id`/`seq`/`run_id`/`attachments`/`synthetic`/`created_at` 取自 `messages` 锚点行——引擎没有「消息行」概念）；
  ② **助手文本的 run 归属**（投影输出不带 `run_id`，而 UI 的助手气泡必须落到某个 run：显式 `run_id` 列 → 该 run、
  session-scoped 行沿用 transcript 分段、单 run 会话兜底）；
  ③ **非 `:input:` 行的 user 锚点认领**（引擎轮记录带的是**轮级** dedupKey、没有 messageId，崩溃 run 的用户文本又只存在于
  后续 run 的历史快照里 → 这类行仍按「内容精确相等」认领；带 `<sessionId>:input:<messageId>` 的行一律用
  `meta.dedupKey` 精确映射，不再参与内容匹配）。
  按官方契约，**投影输出形状是稳定契约面**（`role`/`text`/`blocks`/`toolCalls`/`reasoning`/`folded`/`round`/`ts`/`meta`），
  `RoundRecord` 内部字段不是 → 本模块不再读 `messages`/`response`/`foldedPayload` 的结构；未知 `meta` 键忽略。
  展示口径的两点细化：`reasoning` 与正文分离（不进 DTO `content`）；折叠轮按官方规则展示
  「摘要 + 范围 + 导航指针」，`foldedPayload` 原文不进对话流（DTO 是锚点驱动的、没有可承载官方 system 折叠行的锚点，
  故折叠摘要只在该 run 无自身助手正文时顶上——与契约 ③「显示的是历史消息」一致）。
- **对话流 DTO 透传投影展示字段（issue #188）**：`GET /api/sessions/:id` 的助手锚点 DTO 增带上游投影的
  `toolCalls`/`reasoning`/`blocks`（**逐字、原名透传**，无则不写该键——不塞 `undefined`/`null` 占位）；
  宿主独有的 UI 元数据（`id`/`run_id`/`seq`/`attachments`/`synthetic`/`created_at`）语义与命名不变。
  前端**加载/刷新路径**据此重建工具卡片与推理展示（reasoning 与正文分离、默认收起可展开），与实时/历史事件流
  **共用同一 `toolCards` Map 按 callId 幂等归并** → 同一调用只渲染一张卡片；实时增量流（SSE）行为不变。
  erix-agent 0.16.0 起投影提供稳定的视图键 `turn.key` / `toolCalls[].key`（单次投影内唯一、同输入确定性、
  由输入位置生成；**不是持久 ID、也不是 provider `tool_use.id`**）——上游 #100（`toolCalls[].id` 可选/可重复）
  由此交付：DTO 逐字透传 `toolCalls[].key` 与 `turnKeys`（run 聚合各轮的 `turn.key`），前端在 provider `id`
  缺失时用上游 `key`，仅当两者都缺失才回退「锚点消息 id + 投影内块序号」兜底键（宿主不向上游形状注入字段，#95 红线）。
- **写侧（契约①）实现分工已换到引擎 API**（erix-agent 0.15.0 `appendUserTurn`，上游 #97 闭环）：POST 事务内的预写由引擎承担 round 推导、dedupKey 生成、record 形态与幂等判据；station 只提供极小 store 适配器 `portal/src/transcript-store.js`（`load`/`appendRound` 复用调用方事务 client，落库列形态与原手搋时代逐列等价，「先写 transcript 再入队」顺序不变）。幂等主判据从 DB `ON CONFLICT` 换为引擎按 dedupKey 的 load 判据（顺序重放），`ON CONFLICT` 保留作并发最后防线（同 key 并发由 session `FOR UPDATE` 串行化，满足引擎「在接收事务内发起」的前提）。**0.17.0 起预写走点查快路径**（store 成对实现 `loadByDedupKey`/`loadMaxRound`，上游 #157 / station #193）：事务内不再全量 load——先按 dedupKey 点查，命中即返回既有 record；未命中才取 `MAX(round)` 派生 round 后 `appendRound`，成本不再随 session 行数增长（谓词等价性与保真口径见 AGENTS.md §8.6）。
- 与上游 ADR-018/0.12–0.14 契约的关系：本契约只涉及**读/展示侧**；写侧由 portal 先提交 session transcript、worker 再 resume 的多轮模式见上游 issue #135（本契约 ① 即其实现在 station 的收敛，0.15.0 后由 `appendUserTurn` 承接）。

### 拆解（四个可独立验收的 PR）

| PR | 内容 | 验收 |
|---|---|---|
| **①读路径投影** | 定义投影 DTO 与派生规则（`id`/`seq`/`attachments`/`run` 归属/折叠呈现），`GET /api/sessions/:id` 改走投影；`messages` 仍双写（本 PR 不动写路径，保证可回退）；带**过渡兜底**：当前写路径尚未把用户输入落入 transcript 时，缺少可派生内容的锚点暂回退到自身内容 | 根 `npm test`、前端 `vue-tsc` + vitest、`wp3a`/`wp5` e2e；DTO 字段与语义不变 → **前端零改动** |
| **②a 先落树再入队（本 PR）** | portal POST 事务内写 session transcript；删 runner 预写入分支；新增 0015 一次性回填历史 user 输入；删除 PR① 投影内容兜底 | 根 `npm test`、前端 typecheck/vitest；真机由主 agent 验证同 session 多轮、崩溃 resume 与 transcript/投影等价性（所有非合成消息内容有 transcript 证据且非空） |
| **②b 停内容双写与切换数据源** | `messages` 降级为锚点行（停止写 `content`）；终态幂等比较从 `messages.final_text` 换到 transcript；AI 标题首条用户文本改从 transcript 取 | 根 `npm test`、前端两项、`wp3a`/`wp3b`/`wp5` e2e |
| **②b-读侧（已完成，`feat-261008-11-display-projection`）** | 读侧文本/blocks/reasoning/折叠推导改由上游官方 `projectTranscriptForDisplay` 提供（#95 闭环），自研只剩锚点元数据映射；删除 PR① 的内容匹配用于 `:input:` 行的分支（改 `meta.dedupKey` 精确映射） | 根 `npm test`（0 失败）、前端 `vue-tsc` + vitest（272 项）；真机全库等价性由主 agent 复验 |
| **②b-B1 文本读取点改源（已完成，`feat-261008-12b-reread-source`）** | `messages.content` 的 **6 个读取点已改源（B1）**：全部改从 transcript 投影取文本（共享模块 `portal/src/session-text.js`，内部复用 `session-view.js` 的 `projectSessionMessages`/`recordForProjection` 口径，不另写一份投影）——① AI 改名上下文、② 自动标题降级链首条、③ 话题漂移最新一条、④ claim ticket 的 `task`（按 `<sessionId>:input:<messageId>` 单行精确命中，`attachments` 仍取 `messages`）、⑤ issue #69 历史上行（锚点集合/排除/预算截断不变，只有正文改源）、⑥ 终态幂等比较的 `stored.final_text`。**本单不停写内容**（行为保持型）：`messages.content` 照旧写入，仅当投影对该锚点无证据时才 legacy 回退该列（迁移 0015 之前的行；legacy-only，不用于新会话） | 根 `npm test`（0 失败，基线 679 项全绿 + 新增 16 项）、前端 `vue-tsc` + vitest（272 项）；每个读取点至少 1 个「正文来自 transcript」断言，② 另含「输入行取不到时的回退顺序」用例 |
| **②b-B2 停写内容（已完成，`feat-261008-12d-stop-write`）** | **`messages` 降级为纯锚点行**：仅剩的两个 `messages.content` 写入点（POST 用户行 / 终态 assistant 行）改写空串——用户输入的文本真相已由契约① 的 `appendUserTurn` 落树，终态答复由引擎写 transcript。assistant 行的「有终态文本才建行」前置条件**不变**（它决定要不要产生一条锚点），只是不再携带正文；`content` 列仍是 `text NOT NULL`（**baseline `schema.sql` 冻结、不改 DDL**）。**legacy 兜底保留**（新行 content 为空串 → 投影恒有证据 → 不会触发；兜底只对迁移 0015 之前的老行有意义）。`POST .../messages` 的 202 响应体 `message.content` 改为**回显请求正文**（不再从 `messages` 读回），否则前端 `send()` 渲染的用户气泡会变空。前瞻约束：**`synthetic = true` 的宿主注入行（judge/wrapup）必须仍写正文**（它在 transcript 里没有对应轮次，读侧 `session-view.js` 的 `anchor.synthetic === true` 分支与 `session-text.js` 的 `CASE WHEN synthetic THEN content END` 取的就是锚点自身文本）；当前全库无此类写入点，已用构造用例钉住（`session-text.test.js` / `session-view.test.js`） | 根 `npm test`（0 失败，基线 695 项→698 项）、前端 `vue-tsc` + vitest（272 项）；两个写入点各有「落库 content = 空串」断言，读路径既有投影/DTO 用例全绿；真机 `wp3a`/`wp3b`/`wp5` 由主 agent 复验 |
| **②c 残留数据收敛（待做）** | 把 0015 之前的残留行补齐到 transcript 证据，再收敛/退役 `session-text.js` 的 legacy 兜底分支（B2 只停写、**不删兜底**：删了老会话就地丢正文） | 根 `npm test`、前端两项、e2e |
| **③退役文本注入（已完成，`feat-261008-13-retire-history-injection`）** | **整链删除，不是收窄兜底**：claim ticket 的 `run.history` 字段、`tryClaim` 的历史查询与 `HISTORY_DEFAULTS`/`normalizeHistoryBudget`/`truncateHistory`、`session-text.js` 的 `fetchConversationTurns`（原第 ⑤ 个文本读取点）、`portal/src/config.js` 的 `historyMaxMessages`/`historyMaxBytes`（env `STATION_HISTORY_MAX_MESSAGES`/`STATION_HISTORY_MAX_BYTES` 一并下线，见 `docs/env.md`）、`RUN_START.history` 与 `history_count` 日志、`runner/lib/history.js`（`mapHistoryToInitialMessages`）全部退役。**定稿口径：会话上下文唯一来源 = transcript resume；空本子靠 ticket 的 `task`（引擎 round 0 种子）——引擎两个分支都永不传 `initialMessages`**（对齐上游 CLI `repl.js` 的 `...(resume ? {} : { initialUserMessage })`）。保留 `run.task`：空本子路径仍需要它，且它是 notes/标题的输入（`resolveFirstUserContent` 随之只取 `task`）。理由：写侧输入已在 POST 事务内由 `appendUserTurn` 落树（PR②a）、读侧正文真相 = transcript（PR②b），注入已成死重；且它正是 thinking 模型被上游拒的肇因（`reasoning_content must be passed back`，`deploy/migrations/0007` 头部实证） | 根 `npm test`（0 失败，691 项：690 通过 1 跳过；注入用例删除、新增 resume/空本子种子回归）、前端 `vue-tsc` + vitest（272 项）；`wp3b`/`wp5`/`wp6` e2e 与 FDE 镜像重建由主 agent 真机复验 |

> **过渡兜底、回填决策与实测依据**：PR① 过渡兜底曾命中 30 次。真机全库检查发现 64 个会话中仅 2 个有 `:input:<messageId>` 行；抽查会话 `d86dda63-fc52-481c-9994-65ff29cb5eee` 的用户文本在整份 transcript 的 `record::text` 检索为 0 命中。原因是旧 POST 写路径只写 `messages`，未写 transcript。选择迁移 0015 回填而非删除旧会话，以保留历史数据并让旧会话继续渲染；回填只 INSERT、可幂等重放，随后删除投影兜底，缺证据内容留空。

### `messages` 列语义（P3 PR②b B2 定稿：`messages` = 纯锚点行）

| 列 | B2 后的语义 |
|---|---|
| `seq` / `attachments` / `run_id` / `synthetic` / `created_at` | **`messages` 独占的 UI 元数据**（引擎没有「消息行」概念：seq 由 `chat_sessions.last_seq` 分配、`run_id` 是本平台外键）——永远从这里取 |
| `content` | **只有两类行有意义**：① `synthetic = true` 的宿主注入行（judge/wrapup，transcript 里无对应轮次，正文只能落在本列）；② **legacy 数据**（迁移 0015 / B2 之前入档、正文仍留在本列的老行，仅由 `session-text.js` 的 legacy 兜底读）。**B2 之后的新行恒为空串**（列是 `text NOT NULL`，故写 `''` 而非 NULL，不改 DDL） |

两个写入点（`portal/src/sessions.js` 用户行、`portal/src/internal.js` 终态 assistant 行）均写 `''`；读侧（`session-view.js` 对话流 DTO + `session-text.js` 的 5 个文本读取点——原 6 个中的「claim 历史下行」已随 **PR③** 退役）一律从 transcript 官方投影取文。**读侧不得往 `content` 加新的兜底读**（除上表两类行）；新行的投影无证据时按契约④ 留空。

### 已裁决（UI 轮号口径，2026-10-08）

**默认不显示每轮轮号**（issue #190 裁决）。核实结论：对话流 DTO **从未带 `round` 字段**、前端也从未渲染轮号（用户看到的横条是 judge/停止提示）；行业（ChatGPT/Claude/Cursor/Cline/pi web）同样不标轮号。

口径澄清：**轮 ≠ 工具调用次数**——轮 = 模型被调用一次（think→act 往返），一轮内可调 0 个或多个工具（真机实测一轮最多 49 个工具调用）。轮是**诊断量**（真机 58 个 run 中 7 个以 `max_rounds_cap` 收尾），不是进度条。

轮号只保留在**有信息量的位置**：① 折叠横幅的**范围**（`已压缩第 r1–r2 轮`，DTO 的 `folded.foldedRoundRange`，#189）；② run 摘要（按需）；③ 调试开关（按需）。「该不该新开会话」的真实需求转 **#197**（消息数 + 已压缩次数 + 提示；已压缩 = 引擎在丢早期细节的真信号）。

---

## 7. 红线与验收口径

- 红线：会话内容只走 IPC 内存、不进日志（对齐 #38 models 纪律）；引擎包改动只经上游 issue，station 不 fork 引擎
- token 预算：交给引擎 compaction 语义，宿主不再手动截断字节（#70 的截断保留为兜底）
- 验收（P2 后）：同 session 第 N 轮，模型能引用第 N-1 轮的**工具调用级细节**（如「刚写的 server.js 用了 4008 端口」），而非文本复述；执行崩溃恢复不丢会话；UI 轮号口径**已裁决：默认不显示**（#190，详见 §6 末「已裁决」）
