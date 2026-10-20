# 试用问题 + judge 行为：当前分析汇总（定稿待拍）

| 项 | 值 |
|---|---|
| 编写时间 | **2026-10-20 09:27 +0800（周二）**（`date` 实测，非推断） |
| 编写者 | 主 agent（pi 会话本体）。本文是**只读分析汇总**，未改任何源码、未跑 docker；**本文自身随仓库提交，这是本分析引发的唯一一处 git 改动** |
| 文件位置 | `docs/design/analysis-2026-10-20-judge-and-trial-issues.md`（**入库**）。不放 `.work-orders/` / `tasks/` 的原因：两者都在 `.gitignore` 里，而 pi-web 文件树的数据源是 `git ls-files --cached --others --exclude-standard` ⇒ **被忽略的路径在树里根本不存在**（2026-10-20 实测） |
| 基点 | erix-station `e7eb8a7` / tag `v0.1.16`；erix-llm-kit（npm `erix-agent`）`9440b1c` / `0.21.0`；**试用部署仍 pin `v0.1.5`** |
| 锚点复验 | 本文所有行号在 **`9440b1c`** 上重新核过（见 §1.3）。**符号锚点为主，行号仅辅助**——上游仓库正在被并行 session 高频改动 |
| 验证状态 | **未做运行验证**。行为结论来自 reviewer 的 fake-provider 离线探针 + 源码；无真机模型 run |
| 版本口径 | 上表版本是 2026-10-20 09:27 的**快照**；erix-agent 依赖 pin 的真相在 `AGENTS.md` §8，部署镜像 pin 的真相在 `deploy/.env` |

> ⚠ **本稿 §3 与 §5 的部分结论已于当日被独立复验更正**（marker 复用、溢出可达性、末次附着、恢复保真等 14 条）：见 **§10**，全文证据见同目录 `analysis-2026-10-20-judge-independent-review.md`。**照本稿施工前先读 §10。**

> 本文的存在理由：本轮分析链上已经发生两次「引用了不存在的东西」的事故（§1）。凡本文未写明的，视为**未确定**。

---

## 0. 结论速览

| 事项 | 载体 | 本版做什么 | 状态 |
|---|---|---|---|
| **judge 说「目标已达成」却继续跑**（`ISSUES.md` 第 4 条） | **无 issue**（上游+本站都没建） | 本站只改前端文案三态；行为改动走上游 `erix-agent` | 方案定稿，**待用户拍 5 条**（§5） |
| `#284` 项目目录名不允许 `_` | [erix-station#284](https://github.com/ErixWong/erix-station/issues/284) OPEN | 前端判据+文案，**一处正则**；后端已允许 | 修法定稿，未开工 |
| `#282` 消息时刻 + 动量指标 | [#282](https://github.com/ErixWong/erix-station/issues/282) OPEN | **只做 2a**（完成时刻常显 + 逐条 hover）+ 状态栏「第 N 轮」 | TPS/tokens 整片移出本版 |
| `#286` 边缘剥掉整个 Cookie 头 | [#286](https://github.com/ErixWong/erix-station/issues/286) OPEN | **只走 C**（写进边界文档 + 已有 `X-Auth-User` 事实） | 选型待确认 |
| 已处理项 | `#283`/`#285` CLOSED；`#262/#263` CLOSED | — | 已核对 |

---

## 1. 取证事故与锚点有效性（最重要，先看这节）

### 1.1 我的锚点曾被另一个 session 的未提交 WIP 污染

我曾断言 erix-llm-kit 里存在这些符号并给出行号：`callSessionJudge`（`:3168`/`:3334`）、`engine-judge` / `engine-final-guard` marker、`finalGuardVerdictFromJudgeResult`（`:5445`/`:5523`）、`DONE_CONFIDENCE_THRESHOLD`、`advisoryText`、`normalizeSessionJudgeDecision`。

**实测：以上符号在整个仓库历史中从未存在过**（`git log --all -S` 空，所有分支零命中）。成因：

- `git reflog` 显示该仓库 2026-10-15 22:55 → 10-16 02:18 **每约 20 分钟一次 commit/merge**，**并行 session 在里面干活**；PR #311 是在 reviewer 分析**进行中**合入的（HEAD `9021d74` → `2c1a8d3`）。
- 我当时 grep 到的命中来自**工作树里未提交的 WIP**，不是 main。我同一批命令的第三段（`meta.source` 那节）输出为空——那已经是信号，我没当回事。
- 我说的「`orchestrator.js` 5428 行」是把 `wc -l` 的 **`total`** 当成单文件行数；实际 `git show 9021d74:src/loop/orchestrator.js | wc -l` = **3582**。

**连带作废**：erix_run 的报告同样使用了 `engine-judge` / `normalizeSessionJudgeDecision`，凡引用这组符号的段落不可采信（它们落在同一个被污染的树窗口上）。

### 1.2 copilot 的审计报告从未落盘

`~/worker-reports-261016/` 下只有 `erix-sessions/`，**没有** `audit-final-design-282-284-286-judge.md`。该审计只以对话文本存在过，而我在两轮回复里把它的路径当引用给出过。⇒ 它的结论中**已被我复验的部分**在本文重述；未重述的部分按不存在处理。
（这正是 §2.7 / §8.29 那条纪律的第 N 次发作：**收尾产物必须直接写文件，不许只在对话里活着**。）

### 1.3 仍然有效的锚点（`9440b1c` / 0.21.0 上逐条重验）

| 事实 | 符号锚点 | 行号 @`9440b1c` |
|---|---|---|
| 方向提示只对 `off_track` 产生文本 | `directionHintText()` 首行门 | `src/loop/reflection.js:19` |
| judge 自输入排除是**单值相等** | `renderConversation()` | `src/reflection/judge.js:263` |
| resume-safe 计数器**先例** | `ctx.judgeInterceptCount = ctx.resumeExecutedToolIds.size` | `src/loop/resume-manager.js:227` |
| `judge-control` marker 三处（**第三处是 nudge 全族共用**） | nudge 注入 / hint flush ×2 / 快照 hint | `orchestrator.js:2882`, `:3099`, `:3448` |
| 提示注入处 `slice(0, 2)` 切的是**待注入队列**且随后 `length=0`（溢出=丢弃） | `pendingDirectionHints.slice(0, 2)` | `orchestrator.js:2878`, `:3095` |
| 终止判定的三重门 `done && confidence≥0.7 && isEndTurn` | `judge_done` 分支 | `orchestrator.js:3320`；`isEndTurn` `:3017` |
| `0.7` 是**两处内联字面量，无常量** | — | `orchestrator.js:3297`, `:3320` |
| `executeTool` 实传 `{id,name,input,context,signal}`，**无 `toolCallKey`、无 judge decision** | `structuredOptions` | `src/loop/run-snapshot-executor.js:270-275` |
| station **不传 finalGuard** ⇒ `verification` 恒 `skipped/no_final_guard` | `grep -c finalGuard runner/worker.js` = **0** | station `runner/worker.js` |

---

## 2. judge 行为的机制真相（已复验）

1. **中途审计放行时，模型看不到任何达成文本。** `run-snapshot-executor.js:542-544` 把 `done=true` 的动作写成 `executed`，`:555` 放行，`:558-562` 只推 `directionHintText()` 的产物 ⇒ 该函数首行的单值门使 `direction ∈ {on_track, uncertain}` 时返回空串。探针（fake-provider）实测：`done=true` 的 `reason` 文本在后续任何 provider 请求里 **0 命中**；只有 `off_track` 命中下一次请求。
2. **能终止的 `judge_done` 只在轮末。** 三重门见 §1.3。⇒ 界面上的「judge：executed」与「循环被掐死」**从来就不是同一件事**，用户把它们读成一件事就是 `ISSUES.md` 第 4 条的来源。
3. **宿主（station）拿不到回灌通道。** `executeTool` 的入参里没有 judge decision；但宿主**有** `onJudge`（station `runner/worker.js` 已接），且 `onJudge` **先于**同一次审计后的 `executeTool` 触发 ⇒ 宿主理论上能把提示拼到那次工具结果尾部（探针实测序列成立）。代价三条：落进 `tool_result` 事实链（引擎注释明确「不混入 tool_result——避免污染后续 judge 输入」）、judge 会把它当证据读回去、被审计那次恰为最后一次工具调用时无处附着。
4. **`uncertain` 不是布尔字段**，是 `direction` 的取值（`on_track|uncertain|off_track`）。judge 解析对缺 `done` / 非法 `confidence` 是**整候选拒收**，没有散文兜底路径。

---

## 3. 定稿方案（judge，走上游引擎 = reviewer 的「切法乙」）

改动 **4 文件 / 约 25–35 行 / 零配置项 / 不动顶层选项白名单**：

| 步 | 落点（符号锚点） | 内容 |
|---|---|---|
| ① | `judge-control` 之外新增 marker 值 `judge-done-advisory` | 必须是**新值**：`judge-control` 由 stall/wrapUp/noTool 等 nudge 共用（探针：judge 全关仍有 2 条），复用会**静默不生效**且无测试会红 |
| ② | `directionHintText()` | 放行 `uncertain`（**1 行**）；**不改 `direction` 字段本身** |
| ③ | `run-snapshot-executor.js` 放行分支 | `decision?.done === true` 时把 `reason` 组成达成 advisory，推入**独立新队列**（不与 off_track 共用） |
| ④ | `orchestrator.js` hint flush 旁 | 新队列的 flush，**不套 `slice(0,2)`** |
| ⑤ | `renderConversation()` | 排除判据由单值相等改成**集合**，否则新 marker 会被 judge 自己读回去（自增强回路，正是该规则当初要防的） |
| ⑥ | 配置 | **只进 `reflection.<新子键>`**——`reflection` 子键无白名单校验；顶层加键要动 60 项白名单 + 中英 README + 中英契约 + drift 检查。若复用 0.7，**先把两处内联提成共享常量**再引用 |

**文档面（A①）的真实成本**（不要按「补一段说明」估）：本仓有**裸行号只减不增棘轮**（`bare-lines` 实测须**恰好等于**基线 142，写裸行号直接把 CI 写红）⇒ 表里必须用符号锚点；且中英**成对**义务（`README.md`/`README_cn.md`、中英契约 73 节骨架由 `docs-sync-check` 逐节核对）。

**顺带该修的真问题**（原 A② 想修但修错了地方）：三处引擎作者文本注入**没打 marker** ⇒ 会被 judge 当证据读，其中快照那处会导致 **resume 后 hint 退化成「真实用户消息」**：`orchestrator.js` extend 续跑文本、finalGuard `revise` 的 `message`、`run-snapshot-executor.js` blocked 路径落快照的 hint。

---

## 4. 已砍清单（三类，都记因由）

**我砍自己的**：`#282` 的 TPS/tokens 整片（只能给轮边界累计，给不了它抱怨的那个东西）、portal 估算 `cost`（要单价表，本站零先例）、`normalizeProjectName()`、相对时间、judge C3 四支表→三支。

**被 reviewer 砍掉的（我复验后认）**：A② finalGuard 按 `meta.source` 过滤（函数与 marker 不存在，且 station 不传 finalGuard ⇒ 在唯一消费方上不会发生）；A③「保留纯文本兜底」（本仓无该兜底）；C 的 `tier` 维度（零命中）；C 的「透传 done/confidence」（**已经透传了**，缺的只是文案分支）；B1 的「扫 `judge-control` 计数 + `Math.min(上限−已注入,2)`」（见 §3①，换 `resume-manager.js:227` 计数器先例）。

**我砍 reviewer 的**：它把「中途 `done=true` 该不该拦写/终止」上抛给用户——**不必上抛，我定：绝不拦写、绝不终止**（中途判定零独立核验，station 侧 `verification` 恒 `skipped`）。以及它把「方案 E（token 走请求体 + 拦截器）」当新发现——那就是 `~/AGENTS.md` 第 7 条已在说的事，且自造 token 若走 `Authorization`/`Cookie` 仍会被剥，属 **FDE 侧绕法而非平台修法**，只值得文档一行。

---

## 5. 待用户拍（其余全是实现细节）

| # | 问题 | 我的推荐 |
|---|---|---|
| P1 | B 走引擎还是走宿主（零引擎改动）？ | **走引擎**（省下的 25–35 行不抵「污染事实链 + judge 自增强 + 末次工具漏投」，而末次漏投恰好落在用户最在意那次） |
| P2 | B 默认开还是关？ | **默认开**（不改判定、只加一句提示；反馈本身就是「看不见」） |
| P3 | 达成回灌要不要条数上限？ | **本版不做**（默认 `judgeIntervalRound=10` + 审计后复位，单轮攒到 3 条需 ≥30 次工具调用，场景不可达） |
| P4 | `uncertain` 给不给模型文本？ | **给**，只放开 `directionHintText` |
| P5 | C 的终态分隔条按什么分？ | **本版先不按 finalGuard 分**（数据源没接，三支里两支恒空）；只做三态文案 `executed`=拦截判定已执行 / `off_track`=方向偏离 / `done=true`=判定已达成（未独立核验） |

---

## 6. 其余三项的定稿修法

- **`#284`**：只改前端 `portal/frontend/src/lib/constants.ts` 的 `DIR_NAME_RE`（允许 `[a-z0-9_]`）+ 双语文案 + 正反例测试。**后端 `portal/src/sessions.js` 的 `CWD_RE` 早已允许下划线**，不放宽、不消毒、不迁移存量。⚠ 该 issue 正文的前提「与预览 DNS label 同构是设计使然」**已过期**——预览 hostname 只用 `fde_name + port`（#246 起端口为 FDE 级全局号池），项目名不进 hostname ⇒ issue 里那三选项中的「放宽并防碰撞」防碰撞成本为 **0**；去 issue 更正前提时顺带说明「文案不得承诺后端没做的错误」（`http.js` 对字符串 `details` 不包成对象 ⇒ 落兜底文案）。
- **`#282`**：本版只做终态分隔条的完成时刻常显 + 逐条消息 hover `title`（注意 `runId ?? '__direct__'` 的归组细节，避免直发消息被吞）+ 状态栏「第 N 轮」。终态 tokens 若要定格需先给 `GET /api/runs/:id` 补 `rounds`（文档已承诺该字段而实现没有）。
- **`#286`**：本版只走 C（写进边界文档 + 已有 `X-Auth-User` 注入这一事实）。**新事实**：Traefik **无内建 cookie 中间件**，按 cookie 名剥（A）与只保留白名单（B）**都必须装第三方插件**（`strip-request-cookies` / `cookiefilter` / `keepcookie` 等）⇒ 引入外部供应链 + 版本 pin + 实验特性开关。「只走 C」不是妥协，是本版唯一不引外部依赖的选择。

---

## 7. 纪律（本轮换来的，写死）

1. **并行 session 会改你在分析的仓库的工作树。** 派单前记录 commit SHA；**落地/写文档前重跑一遍 grep 判据**。本轮 HEAD 在一次分析内部变了一次（`9021d74`→`2c1a8d3`），到我写这份文档时又变了一次（→`9440b1c`，0.20.0→**0.21.0**）。
2. **符号锚点为主，行号只作辅助并标版本**（同全局 AGENTS §3.0 与上游 #177 的既有口径）。
3. **收尾产物一律直接写文件，路径写死**，不许只在对话里活着、不许 glob 猜名字。
4. **`wc -l` 多文件时的 `total` 不是单文件行数**（低级但代价大）。
5. 说 issue 编号必须带仓库名——`#282/#283/#284/#285` 在 erix-station 与 erix-agent 两仓都有同号不同事的 issue。

---

## 8. 取证索引（只列确认存在的）

| 路径 | 内容 | 可信度 |
|---|---|---|
| `/home/eric/projects/erix-llm-kit/docs/delivery/analysis-261016-judge-final-plan.md` | reviewer 对定稿的独立审查（40KB，294 行，含探针记录与逐条问答） | 承重结论**已由主 agent 在 `9440b1c` 复验**；行号按 `2c1a8d3` 写，§1.3 已刷新 |
| `/home/eric/projects/erix-llm-kit/docs/delivery/analysis-261016-judge-advisory.md` | erix_run 对我初版修法的审查 | ⚠ **部分作废**：引用了不存在的 `engine-judge` / `normalizeSessionJudgeDecision`（§1.1） |
| `/home/eric/projects/erix-station/.work-orders/analysis-issues-261016.md` | 四条未处理项的初次综合分析 | ⚠ 同上，judge 段需按本文重述 |
| `/tmp/judge-probe/probe{,3,4,5,6,7}.mjs` | reviewer 的离线行为探针（fake-provider，**非真模型**） | 仓库外，`/tmp` 可能被清；结论已在 §2 重述 |
| ~~`~/worker-reports-261016/audit-final-design-282-284-286-judge.md`~~ | copilot 审计 | **不存在**（§1.2） |

## 9. 未做清单

上游 `erix-agent` 单**未建**；erix-station 的 judge issue（`ISSUES.md` 第 4 条）**未建**；`#284` 前提更正评论未发；四片代码一行未写；真机验收零。

---

## 10. 勘误与拍板（2026-10-20 下午，独立复验后）

复验载体：同目录 `analysis-2026-10-20-judge-independent-review.md`（执行体 Copilot CLI / `gpt-6.1-sol`；基点 station `9567b05` / erix-agent `9440b1c`；源码复证 + 八个 fake-provider 探针，零真模型）。下列每条均由主 agent 独立抽查复证过，不是照抄复审件。

| 本稿原结论 | 更正 | 证据（`9440b1c` / `9567b05`） |
|---|---|---|
| §3① 「必须新增 marker 值，复用 `judge-control` 会**静默不生效**」 | **错**。全仓 `grep '"judge-control"' src/` 只有一处逻辑消费者——`judge.js` 的 `renderConversation()` 自输入排除，**没有任何代码数它**。复用反而天然免疫自读；只有「按共享 marker 数专属配额」才会被 stall/wrapUp 污染 | 主 agent `grep -rn '"judge-control"' src/` = 2 命中（注释 + 过滤） |
| §5 P3 「上限本版不做：默认 `judgeIntervalRound=10`，单轮攒到 3 条需 ≥30 次工具调用，**场景不可达**」 | **可达**。默认间隔下 33 次工具调用 → 3 次审计 → 第 3 条被 `pendingDirectionHints.slice(0, 2)` + `length=0` 丢弃，正常与 resume 双路径均复现 | interval 默认值 10（`orchestrator.js` 的 `ERIX_JUDGE_INTERVAL` 回退）；探针 `tools=33 audits=3 hints=[true,true,false]` |
| §2③ 代价之一「被审计那次恰为**最后一次**工具调用时无处附着」 | **错**，被它自己引用的 `probe6` 与本轮补测共同反证（`onJudge` 先于同次 `executeTool`） | `order=["execute:t0","judge:executed","execute:t1"]` |
| §3「顺带该修」只列 extend / revise / blocked 三处 | **漏两处**：`termination.js` 的 `forceFinalIfNeeded`（`【强制收尾】`无 `meta`）；且「放行态 pending hint 不进快照 + `resume-manager.js` snapshot-only 补落档只选含 tool_use/tool_result 的消息」⇒ **二次 resume 必丢提示** | 三处 `continuationMessage`/`instruction` push 均无 `meta`（主 agent 逐条读源码） |
| §3⑥ / 文档面「中英契约 73 节骨架」 | 现算 **75**（`#`+`##`+`###` 标题数）；`--self-test` 口径以脚本为准 | `grep -c '^#'` = 76（含文首 `# ` 标题） |
| §5 P5 「三态文案 `executed`=拦截判定已执行 / …」 | **`executed` = 工具审计已放行，≠任务完成**；且 action / done / direction / 扩轮是**不同维度、可同时非空**，不许做三个互斥态（实测存在 `action=extend+redirect` 而真实审计为拦截） | 探针 `kind=intercept action=extend+redirect actually-intercepted=1` |
| §6 `#282` 「tokens 定格需先给 `GET /api/runs/:id` 补 `rounds`」 | **错因果**：缺 `rounds` 属实，但终态 tokens 来自已有 usage，与 `rounds` 无前置依赖；`rounds` 是独立的契约修补 | 复审件 §1.4 |
| §6 `#282` 提到的 `runId ?? '__direct__'` 归组细节 | station 全仓 **查不到**该串，只能作拟实现提醒，不能引用成现存机制 | `grep -rn '__direct__' portal/ runner/` 空 |
| §6 `#286` 「Traefik 无内建 cookie 中间件 ⇒ **必须**装第三方插件 ⇒ 只走 C 是唯一不引外部依赖的选择」 | **过强**。ForwardAuth 的 `authResponseHeaders`（把自有鉴权端响应头复制进转发请求）是不引第三方插件的空间；「只走 C」可作**范围决策**，但不能称已修复 cookie-session SSR（`X-Auth-User` 是平台身份头，不是应用会话） | 源码 `portal/src/routes.js`（`fde-auth, strip-cookie` / X-Auth-User / Cookie 置空）+ Traefik v3.7 官方文档 |
| 旧稿 `analysis-261016-judge-advisory.md`「`interceptJudgeDecision` 永不清零」 | **已腐烂**：`orchestrator.js` 每轮开头置 `undefined`，别再照它派单 | `runLoopState.interceptJudgeDecision = undefined`（主 agent 抽查） |
| §3 报价「4 文件 / 约 25–35 行 / 零配置项」可完整交付六步 | **不够**。含恢复保真、类型面、中英契约与发版成本时，原始拆法合计约 1,100–2,000 行（大头是测试与双语文档）。**但见下方拍板：范围已收缩，实际不再需要这个量级** | 复审件 §4.1 |

### 10.1 用户拍板（2026-10-20，覆盖 §5 的 P1–P5）

1. **达成意见必须让模型知道**（不只是给人看界面）⇒ 走上游引擎实现：erix-agent [#322](https://github.com/ErixWong/erix-agent/issues/322)。
2. **「已完成」的语义**：judge 只是意见，**是否完成/是否收尾由模型自己判**（任务主体完成但还有扫尾工作是合法状态）；界面上「已完成」只由 run 终态驱动 ⇒ erix-station [#321](https://github.com/ErixWong/erix-station/issues/321)。
3. **复杂度收缩（用户质疑「是否值得花这个心思」后定）**：
   - **单槽**投递（同轮重复只更新，不追加）⇒ 溢出问题被设计消灭，**§3④⑤ 的「独立新队列 / 排除改集合 / 新增 marker 值」整组作废**；P3「条数上限」不再是待拍项（无需实现）。
   - **快照恢复保真不做**（pending 进快照、二次 resume 不丢）⇒ 降为**已知毛刺**记录在 #323，丢一次软提示不产生错误行为。
   - 保留唯一一处便宜的顺手修：四处注入补 `meta.source` ⇒ erix-agent [#323](https://github.com/ErixWong/erix-agent/issues/323)。
   - **不在本轮范围**：TPS/tokens 动量指标、成本估算、状态栏完整版（属 [#282](https://github.com/ErixWong/erix-station/issues/282)）。
4. **载体已建**：#322 / #323 / #321 三张 issue 已建（2026-10-20），`#284` 前提更正评论已发；代码仍一行未写，真机验收零。
