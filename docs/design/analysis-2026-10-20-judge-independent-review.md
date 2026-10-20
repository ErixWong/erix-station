# judge 行为与试用问题：独立复验、归因与实施方案（2026-10-20）

> **本文是被审文档的独立复审件**：被审对象 `analysis-2026-10-20-judge-and-trial-issues.md`（同目录，其勘误见该文 §10）。
> **执行体**：GitHub Copilot CLI，模型 `gpt-6.1-sol`，reasoning effort `xhigh`，context `default`（用户当次点名模型；`readonly` 档写不出文件，故走 `work` + 一次性沙箱 `~/judge-analysis-sandbox`，两个业务仓库以 `addDir` 挂为只读素材）。
> **基点**：erix-station `9567b05` / erix-agent（`erix-llm-kit`）`9440b1c`（0.21.0）。两仓在本轮全程未被写入（收尾 `git status` 干净、SHA 未移动，由主 agent 复验）。
> **验证性质**：源码复证 + **fake-provider 离线探针重跑**（`/tmp/judge-probe/probe{,2..7}.mjs` 七个 + 本轮新增 `independent-probe-261020.mjs`，均零真模型调用）。**没有真机 run**，行为收益（省几轮、tokens）未测。
> **证据文件寿命**：探针与证据 txt 在沙箱内，属本机过程产物，**可能被清理**；承重结论已在正文 §1 内重述，不依赖外部文件存活。
> **后续载体**：erix-agent [#322](https://github.com/ErixWong/erix-agent/issues/322)（达成意见回灌）/ [#323](https://github.com/ErixWong/erix-agent/issues/323)（控制文本补 marker）；erix-station [#321](https://github.com/ErixWong/erix-station/issues/321)（完成语义与文案）、[#284 评论](https://github.com/ErixWong/erix-station/issues/284#issuecomment-6282072480)（前提更正）。**工单已按用户拍板收缩范围，与本文 §4 的 W01/W02 原始拆法不同，以工单正文为准。**

---

# 试用问题与 judge 行为：独立复验、归因与实施方案

审查日期：2026-10-20。**本报告覆盖上一轮受阻记录；本轮已完成源码与离线行为复验。** 没有修改两个仓库，没有执行 git 写操作、Docker、真实模型或部署操作。

**版本约定**：下文 `U@9440b1c` 指 erix-llm-kit 提交 `9440b1c34cc31badd13be8bfce03f629856d8384`，包版本 0.21.0；`S@9567b05` 指 erix-station 提交 `9567b05f1d857af1a0c3e35542ad3ad7faf1957e`，版本 0.1.17。源码行号依此标 commit，不引用浮动 HEAD。两仓开场及报告落盘后再次核验的工作树均干净，HEAD 均与任务指定基点一致。被审文档自身写的 station 基点是 `e7eb8a7`；它到 `9567b05` 仅改变 `.gitignore`、文档索引及该文档，相关运行代码未变。

**消费版本边界**：station 根 `package.json:25` 和 `runner/package.json:11`（均 `S@9567b05`）仍 pin **erix-agent 0.20.0**，两处本地安装包也都是 0.20.0。本文上游探针跑的是 **U@9440b1c 源码**，不冒充部署镜像内的验证。

## §0 结论速览表

| 被审文档承重结论 | 判定 | 独立依据 / 更正 |
|---|---|---|
| 中途 `done=true` 的达成理由没有回到主模型 | **确认** | 三种 direction 的达成 reason 均 0 命中；只有 off_track 的方向文本进入下一请求。 |
| `judge_done` 仅在无工具的 `end_turn` 生效 | **确认** | 三重门及既有回归测试保护模型收尾；0.699 / 0.7 补测分别得到 end_turn / judge_done。 |
| 第 4 条只是用户把 `executed` 读错 | **更正** | 决定性是设计上中途不终止，叠加达成提示缺席；UI 放大误解，不能解释真实额外调用。 |
| `judge-control` 三处，包含 nudge 全族 | **确认** | orchestrator 的 2882 / 3099 / 3448 三个赋值点，第三点不限 judge。 |
| 必须新增 `judge-done-advisory`，复用 marker 会失效 | **更正** | 会失效的是“用共享 marker 数专属配额”；不这样计数即可复用，还天然排除自读。 |
| `slice(0,2)` 后清空会丢提示，但默认参数不可达 | **更正** | 默认间隔下，单轮 33 工具、3 次审计已丢第 3 条；正常和 resume flush 均复现。 |
| 新队列可以不设条数上限 | **更正** | 需生产端限条限长、合并、持久化与恢复；默认间隔不是容量保证。 |
| 宿主没有专用回灌参数，onJudge 先于 executor | **确认** | executor 实参五键；宿主工具结果回灌可行，但会污染事实链并被 judge 读回。 |
| 被审计的最后一次工具调用无处附着提示 | **更正** | 回调先发生，同一次、也是最后一次工具调用即可附着；旧 probe6 与补测均反证。 |
| station 没接 finalGuard，不能当成独立核验 | **确认** | grep 计数 0；返回 skipped/no_final_guard，另有 metrics，不等于 verified。 |
| uncertain 是 direction 枚举；judge 无散文兜底 | **确认** | 缺 done、非法 confidence、纯散文均为 null；后续合法候选仍可被接受。 |
| uncertain 只需改一行门 | **更正** | 原模板仍把不确定说成“路线可能偏”；必须同步改中性文案与测试。 |
| 漏 marker 只需处理 extend / revise / blocked snapshot | **更正** | 另漏强制收尾；还漏 pending 不进快照、snapshot-only 文本不补落档。 |
| 后端允许 `_`，预览 hostname 不含项目名 | **确认** | 前端拒下划线、后端既有纯函数测试接受；hostname 使用 FDE 名、端口和基础域。 |
| GET Run 缺 rounds，因此 tokens 定格必须先补 rounds | **更正** | 缺字段属实；tokens 来自已有 usage，不依赖 rounds；后者是独立契约修补。 |
| 时间活动度主要只改 StreamPanel，TPS/tokens 整片砍掉 | **更正** | 类型/entry 丢时间，历史 API 丢 ts；实时字符量可做，轮级 usage 不能伪装瞬时 TPS。 |
| 上游门禁数字与中英配对义务 | **更正** | 实测裸行号 142、符号 63 组/165 处、checkJs 119/162；契约现为 **75 节**而非 73。 |
| 四文件 25–35 行可以完整交付六步 | **更正** | 只够无恢复保证的主路径草图；容量、快照、隔离、类型与双语发布明显超额。 |
| Cookie 只写文档是唯一无第三方依赖选择 | **更正** | 可作为延期决策，不能称修复 SSR blocker；自有 forwardAuth/代理不必引第三方插件。 |

**总判决**：源码定位主干大体可信，“定稿方案”不能直接施工。先补真实可见性与控制文本保真，再做显式启用、有限容量的软收尾提示；不把 LLM 中途 done 冒充独立验收，不承诺一句提示能硬性消灭过冲。

## §1 复验证据：实际命令、真实输出、判定

### 1.1 现场与证据口径

先完整读被审文档 144 行，再核代码与探针。实际执行：

```bash
git -C /home/eric/projects/erix-station rev-parse HEAD
git -C /home/eric/projects/erix-station --no-pager status --short
git -C /home/eric/projects/erix-llm-kit rev-parse HEAD
git -C /home/eric/projects/erix-llm-kit --no-pager status --short
```

得到开头两个完整 SHA，两条 status 均无输出。另执行：

```bash
git -C /home/eric/projects/erix-station --no-pager diff --stat e7eb8a7 9567b05
```

输出片段：

```text
 .gitignore                                       |   3 +
 docs/README.md                                   |   1 +
 ...analysis-2026-10-20-judge-and-trial-issues.md   | 144 +++++++++++++++++++++
 3 files changed, 148 insertions(+)
```

下文命令简写与实际使用一致：

```bash
U=/home/eric/projects/erix-llm-kit
S=/home/eric/projects/erix-station
```

证据附件均在 `/home/eric/judge-analysis-sandbox/`，不是仓库内笔记：

| 文件 | 内容 |
|---|---|
| `source-evidence-261020.txt` | 相关源文件、契约、脚本、被审文档，逐份 `git show <固定SHA>:<path> \| nl -ba`，保留真实 commit 行号 |
| `anchors-261020.txt` | 锚点命中与 finalGuard grep 退出码 |
| `probe-replay-261020.txt` | 七个原探针完整运行输出 |
| `independent-probe-261020.mjs`、同名 `.txt` | 本轮新增带 assert 的离线探针及最终完整输出 |
| `gates-261020.txt`、`types-261020.txt`、`syntax-261020.txt` | 门禁实测 |
| `upstream-targeted-261020.txt`、`docs-ratchet-261020.txt`、`station-cwd-261020.txt` | 针对性既有测试输出 |

原探针逐个完整读过，fake provider 也读过：请求只保存内存，executor 返回字符串，probe4 使用内存 store，无真实模型、无 shell 执行。命令中的 git show / grep / status / diff / check-ignore 均只读。

### 1.2 §1.3 锚点表逐项复验

**原表实际有 9 个事实行**，不是任务所称 8 行（0.7 单列、station 另列）。以下全部覆盖。

#### A1 方向文本单值门：成立

```bash
git -C "$U" show 9440b1c:src/loop/reflection.js | grep -nE 'direction !=='
```

```text
19:  if (direction !== "off_track") return "";
```

`directionHintText` 在 `U@9440b1c:src/loop/reflection.js:18–24`。独立运行输出：

```text
hint gate: on_track=empty uncertain=empty off_track=nonempty
```

确实同时挡住 on_track / uncertain。

#### A2 judge 自输入排除为单值比较：成立

```bash
git -C "$U" show 9440b1c:src/reflection/judge.js | grep -nE 'meta\?\.source'
```

```text
263:  const visible = list.filter((message) => message?.meta?.source !== "judge-control");
```

补测直接调用 `renderConversation`：

```text
renderConversation source=judge-control visible=false
renderConversation source=judge-done-advisory visible=true
```

新增 source 目前不受排除；这证明**若新增 source 就需扩规则**，不证明必须新增 source。

#### A3 resume-safe 计数器先例：部分成立

```bash
git -C "$U" show 9440b1c:src/loop/resume-manager.js |
  grep -nE 'judgeInterceptCount = ctx.resumeExecutedToolIds.size'
```

```text
227:          ctx.judgeInterceptCount = ctx.resumeExecutedToolIds.size;
```

命中真实。但这是从快照已执行工具集合**重建**计数，不是任意新 counter 自动持久化。`persistRunSnapshot` 的字段表（`U@9440b1c:src/loop/orchestrator.js:1984–2028`）没有通用“状态格子自动保存”。新 advisory counter 若要跨恢复，必须定义保存、恢复、去重和新任务重置。

#### A4 三处 marker 及第三处 nudge 全族：成立，表格描述需改

```bash
git -C "$U" show 9440b1c:src/loop/orchestrator.js |
  grep -n 'meta: { source: "judge-control" }'
```

```text
2882:          meta: { source: "judge-control" },
3099:          meta: { source: "judge-control" },
3448:        meta: { source: "judge-control" },
```

前二分别是 resume flush / 普通工具轮 flush；第三在 `action.kind === "nudge"` 分支。**不是第三处为“快照 hint”**，executor 的快照 hint 正好漏 marker。

全族来源 `U@9440b1c:src/reflection/governor.js`：`memoryLoss:74`、`wrapUp:84`、`repeatedError:93`、`stall:102`、`noTool:118`、`noExtend:158`；另有 orchestrator 的 judge nudge（3337–3342），共同走 3445–3454。

旧 probe5 输出：

```text
judge OFF, yet meta.source=judge-control messages: 2
```

两条均为 stall 文本。它否证“按共享 marker 数专属配额”，不否证“用共享 source 标控制文本”。

#### A5 两处 slice 后整体清空：成立

```bash
git -C "$U" show 9440b1c:src/loop/orchestrator.js |
  grep -nE 'pendingDirectionHints.slice|pendingDirectionHints.length = 0'
```

```text
2878:          ? [...pendingDirectionHints.slice(0, 2), "（另有多次方向提示已合并）"]
2887:        pendingDirectionHints.length = 0;
3095:          ? [...pendingDirectionHints.slice(0, 2), "（另有多次方向提示已合并）"]
3104:        pendingDirectionHints.length = 0;
```

第 3 条以后**丢弃，不延期**；“已合并”只是占位文字，没合并其理由。补测真实输出：

```text
default interval (env cleared): tools=33 audits=3 next-request hints=[true,true,false] mergedNotice=true
resume flush default interval: tools=33 audits=3 first-request hints=[true,true,false]
```

正常与 resume 两个分支都实际越过容量。

#### A6 judge_done 三重门：成立

```bash
git -C "$U" show 9440b1c:src/loop/orchestrator.js |
  grep -nE 'const isEndTurn|confidence >= 0.7'
git -C "$U" show 9440b1c:src/loop/orchestrator.js | nl -ba | sed -n '3317,3325p'
```

```text
3017:    const isEndTurn = roundStopReason === "end_turn" && !hasToolUse(content);
3297:            action: judgeDecision.done === true && judgeDecision.confidence >= 0.7
3320:      && judgeDecision.confidence >= 0.7
3319    if (judgeDecision?.done === true
3320      && judgeDecision.confidence >= 0.7
3321      && isEndTurn) {
3322      action = {
3323        kind: "stop",
3324        value: "judge_done",
```

补测：

```text
end_turn confidence=0.699: termination=end_turn verification={"status":"skipped","reason":"no_final_guard",…}
end_turn confidence=0.7: termination=judge_done verification={"status":"skipped","reason":"no_final_guard",…}
```

**0.699 不产生 judge_done，不代表一定继续**；自然 end_turn 仍可结束。这是 judge_done 的门，不是所有结束的门。

#### A7 0.7 两处内联，无该常量：成立

```bash
git -C "$U" grep -nE '0\.7|DONE_CONFIDENCE_THRESHOLD' 9440b1c -- \
  src/loop/orchestrator.js src/loop/reflection.js src/loop/run-snapshot-executor.js
```

```text
9440b1c:src/loop/orchestrator.js:3297: … judgeDecision.confidence >= 0.7
9440b1c:src/loop/orchestrator.js:3320:      && judgeDecision.confidence >= 0.7
```

还执行了：

```bash
git -C "$U" grep -nE \
 'callSessionJudge|engine-judge|engine-final-guard|finalGuardVerdictFromJudgeResult|DONE_CONFIDENCE_THRESHOLD|advisoryText|normalizeSessionJudgeDecision' \
 9440b1c -- src
```

无输出，退出 1。这些名字在本基点源码**查不到**，本文不拿它们当锚点；不另作“所有历史所有分支都没有”的更强声明。

#### A8 executeTool 实传五键，无 judge decision：成立

```bash
git -C "$U" show 9440b1c:src/loop/run-snapshot-executor.js |
  nl -ba | sed -n '270,278p'
```

```text
270      const structuredOptions = {
271        id: block.id,
272        name: block.name,
273        input: block.input,
274        context: { ...ctx.baseToolContext, round },
275        signal: ctx.toolSignal,
276      };
```

补测在实际调用处断言 Object.keys 恰为 `context,id,input,name,signal`，通过。无 toolCallKey、无 judge decision。

#### A9 station 不传 finalGuard：成立

```bash
grep -c finalGuard /home/eric/projects/erix-station/runner/worker.js
```

```text
0
grep exit=1 (0 matches is exit 1)
```

固定提交 worker 的完整选项对象也核过。默认源是 `U@9440b1c:src/loop/orchestrator.js:1650–1652`；result 的 verification 另加 metrics（`src/loop/termination.js` 的 `makeResult`）。补测是 skipped/no_final_guard，不是 verified。

### 1.3 §2 四条机制结论：运行复验

实际逐个执行，全部退出 0：

```bash
node /tmp/judge-probe/probe.mjs
node /tmp/judge-probe/probe2.mjs
node /tmp/judge-probe/probe3.mjs
node /tmp/judge-probe/probe4.mjs
node /tmp/judge-probe/probe5.mjs
node /tmp/judge-probe/probe6.mjs
node /tmp/judge-probe/probe7.mjs
```

真实输出片段：

```text
[A done+on_track] … reason … NO / direction-hint … NO
[B done+off_track] … reason … NO / direction-hint … YES req#2
[C done+uncertain] … reason … NO / direction-hint … NO
probe2: all 3 HINT_i present? [ true, false, false ]
probe3: judge audit calls in one 4-tool round: 2
probe4: persisted messages carrying meta.source=judge-control: 1
probe4: resumed run sees MIDHINT in first request: true
probe6: executeTool a pendingAdvice=null
probe6: onJudge action=executed done=true reason=目标已达成
probe6: executeTool b pendingAdvice="目标已达成"
probe6: tool_result contents: ["ok","ok\n[宿主回灌：评审认为目标已达成（未独立核验）]"]
probe7: TOTAL judge-control msgs observed by host via onRound: 1
```

| 被审 §2 条目 | 判定 | 范围修正 |
|---|---|---|
| 1 中途放行不给达成文本 | 成立 | reason 与 directionReason 分开；off_track 返回后者，不是 done 理由。 |
| 2 judge_done 只在轮末 | 成立 | 应指无工具 end_turn，不是每个 round_end；UI 误读不是全部根因。 |
| 3 宿主缺专用通道，回调先于执行 | 部分成立 | 工具结果回灌可行且会自读；“末次工具漏投”被同一探针反证。 |
| 4 uncertain 枚举、严格解析 | 成立 | 不合格候选拒收后还试下一合法候选；不要混入 reflection 的散文兜底。 |

解析源码实查 `git -C "$U" show 9440b1c:src/reflection/judge.js | nl -ba | sed -n '424,450p'`：`parseJudgeDecision` 声明在 424，429 要字面布尔 done，430–432 要 [0,1] 有限数 confidence，443–448 处理 direction 枚举（均 `U@9440b1c`）。

**旧探针证明力限制**：probe2 的 3 工具实际仅 1 次审计，所以缺 HINT_1/2 不是 slice 证据；probe3 的 4 工具仅 2 次审计，也没越界。probe4 测的是正常完成后 resume，不是 crash window 保真。

独立补测命令：

```bash
env -u ERIX_JUDGE_INTERVAL -u ERIX_NO_REFLECTION \
    -u ERIX_NO_ROUND_JUDGE -u ERIX_NO_FORCED_FINAL \
  node /home/eric/judge-analysis-sandbox/independent-probe-261020.mjs
```

真实输出（最后全部 assert 通过）：

```text
parse missing done: null
parse bad confidence: null
parse prose: null
parse invalid first / valid second: accepts second candidate
last audited tool attaches host advice: order=["execute:t0","judge:executed","execute:t1"] next-model=true judge-self-read=true
blocked snapshot resume: source=ABSENT judge-self-read=true projection=[… "synthetic":true,"sourceInferred":true,"source":"direction-hint" …]
blocked snapshot hint: first resume visible / durable transcript absent / second resume absent
pass-through pending hint: next-tool checkpoint absent / crash-resume absent
extension event precedence: kind=intercept action=extend+redirect actually-intercepted=1
extend control: meta.source=ABSENT next-judge-request contains control=true
finalGuard revise control: meta.source=ABSENT judge-render contains control=true
forceFinalIfNeeded control: meta.source=ABSENT judge-render contains control=true
top-level option whitelist actual count=60
ALL INDEPENDENT ASSERTIONS PASSED
```

**末次漏投的反证**：第一轮只有两个工具，审计在第二个、亦即最后一个工具之前。提示附着该工具结果，进入下一主模型请求，也进入 judge 的渲染输入。无工具可附的是轮末 judge，但 done 达阈值时本就终局；不能用它证明中途最后一个被审计工具漏投。

### 1.4 §6 三项代码事实

实际执行：

```bash
git -C "$S" grep -nE 'DIR_NAME_RE|CWD_RE|function validateSessionCwd|function buildHostname|function handleGetRun' \
 9567b05 -- portal/frontend/src/lib/constants.ts portal/src/sessions.js portal/src/projects.js portal/src/http.js
```

```text
9567b05:portal/frontend/src/lib/constants.ts:8:export const DIR_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
9567b05:portal/src/sessions.js:33:export const CWD_RE = /^~\/projects\/([^/]+)$/;
9567b05:portal/src/sessions.js:40:export function validateSessionCwd(value) {
9567b05:portal/src/projects.js:56:export function buildHostname({ fdeName, port, baseDomain }) {
9567b05:portal/src/http.js:1920:async function handleGetRun(req, res, ctx, runId) {
```

1. **前端严后端松：确认。** 后端是一级路径形态，加拒绝 `.`、`..`、控制字符（`S@9567b05:portal/src/sessions.js:40–55`），不限 DNS 字符集。`createDir` 走会话 cwd 创建，不走退役项目注册（`S:portal/frontend/src/stores/workbench.ts:652–665`）；不能误改旧 PROJECT_NAME_RE 或 FDE DNS 规则。

   实跑纯函数测试，排除同文件建目录测试：

   ```bash
   cd /home/eric/projects/erix-station
   node --test --test-name-pattern=validateSessionCwd portal/test/sessions-cwd.test.js
   ```

   输出 `# tests 1 / # pass 1 / # fail 0`；已有断言接受 `meeting_asr_app`。独立补测前端真实正则：`cmms_test=false`。

2. **hostname 不含项目名：确认。**

   ```bash
   git -C "$S" show 9567b05:portal/src/projects.js | nl -ba | sed -n '48,62p'
   ```

   ```text
   56 export function buildHostname({ fdeName, port, baseDomain }) {
   59   const portLabel = String(port).padStart(PREVIEW_PORT_LABEL_MIN_WIDTH, '0');
   60   return `${fdeName}${PREVIEW_PORT_SEGMENT}${portLabel}.${baseDomain}`;
   ```

   函数补测输出 `eric-p-22000.example.test`。因此 ISSUES 第 3 条的旧 DNS 推测已过期。下划线放宽不用做目录到 hostname 的消毒/防碰撞映射；不等于平台端口/域名整体无需唯一性约束。

3. **GET Run 没 rounds：确认；tokens 前提错误。**

   ```bash
   git -C "$S" show 9567b05:portal/src/http.js | nl -ba | sed -n '1920,1945p'
   ```

   ```text
   1926 SELECT r.id, r.session_id, r.status, r.termination, r.usage, r.error, r.cancel_requested_at,
   1927         r.queued_at, r.started_at, r.ended_at
   1937 termination: row.termination ?? null, usage: row.usage ?? null, error: row.error ?? null,
   1939 queued_at: row.queued_at?.toISOString?.() ?? null,
   1940 started_at: row.started_at?.toISOString?.() ?? null,
   1941 ended_at: row.ended_at?.toISOString?.() ?? null,
   ```

   查询与 DTO 均无 rounds。DB 已存（`S:portal/src/internal.js:704,712–714`），文档 Run 示例承诺它（`S:docs/api/portal.md:806`）。无须 DB 迁移，但 **usage tokens 显示不需要 rounds**。

### 1.5 上游门禁现场答案

实际执行，均退出 0：

```bash
cd /home/eric/projects/erix-llm-kit
node scripts/docs-drift-check.mjs --verbose
node scripts/docs-sync-check.mjs
node scripts/docs-drift-check.mjs --strict
node scripts/type-check-ratchet.mjs --baseline
node scripts/type-check-ratchet.mjs
node scripts/type-check-ratchet.mjs --with-tools
node scripts/syntax-check.mjs
node --test test/docs-anchor-ratchet.test.js
node --test --test-reporter=dot test/judge.test.js test/reflection.test.js \
  test/run-snapshot-executor.test.js test/loop-resume.test.js test/loop-final-guard.test.js
```

真实输出片段：

```text
ref-scan: 覆盖面 22 份文档 … 下限 22
symbol-anchor-span: … 自带区间 30 处：相交 30 处 / 不相交 0 处
symbol-anchor: … 165 处（唯一 (符号, 文件) 63 组 …）
bare-lines: … 179 次出现 / … 146 处 … 豁免 4 处 … 实测 **142** vs 基线 142
docs-sync-check: OK — 中英契约标题结构对齐（75 节，锚点齐全）
check:types: OK — 实测 119 个 --checkJs 错误 / 29 个文件（包根入口）…
check:types: OK — 实测 162 个 --checkJs 错误 / 31 个文件（含 ./tools 入口）…
syntax-check: OK — 全量 264 个跟踪的 .js/.mjs/.cjs 文件 node --check 全过…
docs-anchor-ratchet.test.js: # tests 6 / # pass 6 / # fail 0
```

固定提交真值：

```bash
git -C "$U" grep -nE 'const (BARE_LINE_REF_BASELINE|SYMBOL_ANCHOR_MIN_UNIQUE|REF_SCAN_DOCS_MINIMUM|BASELINE_ROOT|BASELINE_WITH_TOOLS)' \
 9440b1c -- scripts/docs-drift-check.mjs scripts/type-check-ratchet.mjs
```

命中 drift 脚本 `1540=22`、`1967=63`、`2067=142`；type 脚本 `105=119`、`120=162`（均 `U@9440b1c`）。

**成本解释**：

- drift 脚本 `2219–2223 @U` 是超过红、低于提示降基线；`test/docs-anchor-ratchet.test.js:98–102 @U` 才要求**实测恰好等于基线**。整个 CI 要相等，但不能说 drift 脚本自身只接受相等。
- 符号至少 **63 个唯一 (符号,文件) 组**，不是 63 次引用；文档覆盖下限另为 22；带区间需与真实声明相交。施工文档优先不带范围的符号锚点。
- `U:AGENTS.md` §3（137–145、155–202）要求中英配对；实测 README 骨架 25 标题，契约 **75 节而非 73**。标题同步不等于语义自动翻译，仍须人工成对维护。
- `RUN_TOOL_LOOP_OPTION_NAMES` 实测 60 项（`U:src/loop/option-normalization.js:36–97`）。子键没有同类白名单，不代表不用类型、校验、契约和默认说明。
- checkJs 是接受 119/162 项债务的绿灯，不是零错误。本次未生成/删除声明或安装依赖制造假绿。

## §2 问题定位：分层归因与第 4 条根因判决

### 2.1 决定性是设计上中途不叫停，兼有信息缺口和 UI 误导

`S@9567b05:ISSUES.md` 第 4 条原话是：

> “原始任务目标已达成”，之后仍在 venv/pip/grep/readFile 一路跑；“若用户意图只是 clone，等于白烧十几轮。”

| 候选 | 判决 | 证据 |
|---|---|---|
| (a) 判定与终局断链 | 若指 end-turn done 漏消费，不成立；若指中途 done 无软反馈，成立 | 工具中途 done 明确放行，轮末有完整 stop 门；不是缺一个本应连接的终局函数。 |
| (b) 设计上中途不叫停 | **决定性** | `U:run-snapshot-executor.js:555` 放行；`U:orchestrator.js:3321` 要 isEndTurn；`U:test/judge.test.js:512–536` 明确保护“不抢模型自己的收尾”。 |
| (c) UI 文案误读 | 次因，但真实存在 | `S:useEventStream.ts:419–443` 展示 action/reason，未区分放行与完成。改词不能撤销后续真实工具调用。 |

**历史实录的证据边界**：ISSUES 没保留当次 JSON 的 done/confidence/direction/kind。done=false/on_track 也可 executed；不能由 reason 一句自然语言反推 `done:true && confidence>=0.7`。本轮证明当前机制足以产生现象，不伪造对 10 月 13 日某 run 的完整溯源。

中途不硬停是合理的当前默认，不是永久不可讨论的产品真理。若验收是“达成后不得再写、不得再花十几轮”，软 advisory **没有确定性保证**。需另定义宿主可验证的任务验收、后续调用预算或安全收尾协议，并处理批量剩余工具配对、abort 优先等；不是改一个 if，更不能未经核验直接砍掉写操作。

### 2.2 分层归因

| 问题 | 归属层 | 根因与边界 |
|---|---|---|
| 中途 done 理由不可见，模型继续扩包 | **上游引擎** | 策略选择 + 正向收尾提示缺席；station 回调仅上报，不能靠 UI 修复模型的信息缺口 |
| executed 被暗示为完成，三态互斥遮信息 | **station 前端** | 文案真正生成于 useEventStream，不是 StreamPanel |
| action 与 direction/扩轮/执行状态混同 | **上游事件语义 + station 前端** | extensionAction 抢优先；补测实际拦截却 action=extend+redirect。MVP 分轴展示，执行事实看 tool_result |
| 控制文本漏 provenance / judge 自读 | **上游引擎** | extend、revise、blocked snapshot、强制收尾漏标记 |
| 第三及以后提示丢弃 | **上游引擎** | 两处取前二清空；应限量真实合并、保留最新而非丢最新 |
| crash 后 hint 丢失、首次可见而再次恢复消失 | **上游引擎** | pending 没快照表示；snapshot-only 补落档只选工具块 |
| 新建目录 `_` 被拒 | **station 前端** | 沿用旧 DNS 校验；后端 cwd 更宽，不能去改 FDE DNS 正则 |
| 时间与活动度看不见 | **station 前端，部分后端** | 已有字段被类型/entry 丢失；历史事件接口不带 ts |
| 旧 DNS 前提、73 节、必须插件等 | **仅文档与文案** | 旧快照或受限备选集被当作今日全部事实 |
| Cookie-session SSR 预览登录失败 | **station 后端/边缘设计** | `S:routes.js:203–207` 给 X-Auth-User 但剥 Cookie；身份头不是 Flask session。文档延期不等于兼容修复 |

### 2.3 漏掉的控制注入与恢复问题

下列位置全部经固定提交 git grep/show 命中；路径也有独立运行补测：

| 路径 | 源码位置（均 `U@9440b1c`） | 实测 / 风险 |
|---|---|---|
| extend / extend+redirect | `src/loop/orchestrator.js:3463–3468` | 无 meta，后一次真实 judge 请求含自己的 EXTEND_CONTROL |
| finalGuard revise | `src/loop/orchestrator.js:3521–3526` | 无 meta，renderConversation 当 user；station 当前不触发，上游其他消费者可触发 |
| blocked 快照 hint | `src/loop/run-snapshot-executor.js:598–603` | 无 marker、不限量、不清队列；crash-cut 后 judge 读回 |
| **遗漏：强制收尾** | `src/loop/termination.js:203,211–218` 的 forceFinalIfNeeded | `【强制收尾】` 无 meta；不保证本轮再 judge，但进入宿主/恢复消息后会被当输入，当前渲染已能读到 |
| **遗漏：放行 pending hint 不持久化** | `src/loop/run-snapshot-executor.js:557–562` 对比 `orchestrator.js:2015` | post-tool 快照发生在入队前；下一工具 checkpoint 也不带队列。恢复后 PASS_HINT 不见 |
| **遗漏：snapshot-only 纯文本不补落档** | `src/loop/resume-manager.js:195–204`；`orchestrator.js:2890–2916` | 补落档只选含 tool_use/tool_result 的未持久消息；blocked hint 首次 resume 可见，transcript 不含它，第二次 resume 消失 |

**“退化成真实用户”要分面**：

- judge 侧确为普通 `### user`，因为只按 meta.source 排除。
- 显示投影不一定：`U:src/display/projection.js:40–43,199–211` 有方向提示前缀回退。补测无 meta 的 blocked hint 仍是 `synthetic:true, sourceInferred:true, source:"direction-hint"`，不是 UI 一定当真人。
- extend/revise/强制收尾不在该三项前缀表；沿快照或宿主记录进入投影时更易被当用户文本。前缀回退不是 provenance 的替代。
- 普通完成后 marker 保真，不能证明“快照从未标记”或“文本根本没补落档”也没问题。

**slice 的其他 victim**：off_track 既来自 done=true 放行，也来自 done=false 的只读放行或 blocked；所有入队者都受 FIFO 丢最新。再加入 uncertain/done advisory 会互相挤掉。blocked 快照反而复制全量累计队列，正常请求看到二条，崩溃恢复可能看到更多，构成行为不一致。

**不要误修的邻接面**：

- `U:src/run-state.js:512–520` request-only user 状态文本未用此 marker，但它是宿主事实/状态视图，不等同 judge 控制意见。不能把所有“引擎作者文本”一律从 judge 删掉。tool_result 的“被拦未执行”事实也应保留。
- `isRealUserTurn`（`U:src/loop/request-user-view.js:47–51`）不看 meta，是协议 user-query 保底，不是人类身份认证。别为修 marker 破坏 provider 的合法 user 轮。
- `taskBriefFromMessages`（`U:src/loop/task-brief.js:7–16`）也不看 meta；宿主若把合成文本重灌种子且不给 task，有简报污染风险。station 当前显式给 task（`S:runner/worker.js` 种子装配段），不能宣判已经触发。
- 老 advisory 报告声称 `interceptJudgeDecision` 永不清零，当前**不成立**：`U:src/loop/orchestrator.js:2939` 每轮置 undefined，不能再派这张陈旧修复单。

## §3 对被审文档六步方案逐条裁决

| 步 | 裁决 | 可开工修正 |
|---|---|---|
| ① 必须新增 marker | **应砍“必须新增”** | 复用已有 judge-control 标 advisory/其他纯控制意见；配额用独立待投递槽，不数共享 marker。若确需分类再新增类型并配排除测试 |
| ② uncertain 一行放开 | **需改** | direction 原样，模板区分“不确定”与“可能偏离”，空理由也中性；不改拦截/扩轮。MVP 可仅准确显示给人 |
| ③ done=true 推独立队列 | **需改** | 增加有效决策、confidence≥0.7、显式启用门；reason 限长；至多一个待投递 advisory 槽，不用无界列表 |
| ④ 新队列不 slice | **需改** | 不用旧 FIFO 切片可以，但必须生产端限量合并、正常/resume 同策略、快照保留 pending、补落档不漏纯文本 |
| ⑤ 排除改集合 | **有条件成立；推荐方案可砍** | 只在新增 source 时必做；复用 judge-control 保持现有排除即可。必须测试真实 judge 请求没有 advisory 原文 |
| ⑥ reflection 子键、共享阈值 | **原则成立，成本需改** | 避开顶层 60 项白名单不等于零配置；补校验、JSDoc/声明、双语契约/默认值。上游默认关、station 显式开 |

### 3.1 marker 的真实因果关系

现有代码不存在“看到 judge-control 就禁止入队/投递”的门。相关比较是在 judge 输入排除，恰好是复用 source 的好处。

“复用无效”只在另行设计“数所有 judge-control 消息，满两条停投”时成立。stall 污染这套计数；应删错计数，不必由此强制新 source。

station 传引擎的 runId 是 **transcriptKey=sessionId**（`S@9567b05:runner/worker.js:537–539`），不是宿主实际 run。扫整个 transcript 限“每 run 两次”，会变成整个会话终身额度，新用户任务也得不到提示。闭包 counter 反过来会每次 worker 恢复重置。都不是免费 resume-safe。

### 3.2 有限容量软提示的施工口径

以下是拟实现要求，不声称仓库已有新符号：

1. 每个工具批次/轮次最多投 **1 条达成 advisory + 2 条方向摘要**；生产端即有限容量，不先攒成千条再切。
2. reason 最多 200 字符，完整 advisory 最多 400；同轮重复 done 更新一个槽，不追加。新否定审计/新结果可更新，不做会话终身额度。
3. 方向保留两个不同的最新提示，重复合并计数；不保最老二条而丢最新。没有真实摘要就写“省略 N 条重复提示”，不要虚称已合并。
4. 普通 flush、resume flush、blocked 快照使用同一有限集合和 marker。快照保存待投递状态或等价的带身份消息；恢复去重且补落档。
5. 上游默认关，station 显式启用。文本可为：“评审认为可能已满足原始目标（未独立核验）。请按用户最初要求核对；若已满足，仅总结交付，不新增工作；否则只补齐缺项。”
6. 不增加 judge 调用，不改 done/confidence/direction、写入拦截、abort 优先或终局规则，不混 tool_result。

每轮限量仍会累计 prompt 成本；context/compaction 回收不等于零成本。应记录首次 advisory 后额外工具数、提示字符增量、最终 termination；真实收益要真机对照，fake provider 仅验证协议。

## §4 工单化实施方案：MVP、完整版、顺序与门禁

两仓同一主人，没有外部 PR 摩擦；仍需“上游正确性与行为审查→发包→station 双 pin”。前端止血可先独立发布。以下 **6 张工单**均锚定真实符号；新增测试点不是伪称已有测试名。

### W01 上游：控制意见 provenance、有限提示与恢复保真

**层/优先级**：上游引擎，P0 正确性；不引入 done 新行为。

**文件/真实锚点**（均 `U@9440b1c`）：

- `src/loop/run-snapshot-executor.js`：`createRunSnapshotExecutor:69`、`pendingDirectionHints:414`、blocked `overriddenMessages:599`。
- `src/loop/orchestrator.js`：`persistRunSnapshot:1984`、两个 flush 2876/3091、extend 3463、revise 3521。
- `src/loop/resume-manager.js`：`restoreResume:7`、snapshot-only 选择器 197。
- `src/loop/termination.js`：`forceFinalIfNeeded:203`；同步中英 `docs/host-consumer-contract{,_cn}.md`。

**实施**：纯控制意见用现有 judge-control；方向集合在生产端限量、去重、保留最新。保存未投递状态，恢复补落档保留控制纯文本，按原位置/身份去重，不能把所有历史 snapshot 消息重复 append。**仅补 marker 不算完成**。

**验收**：33 工具默认间隔正常/resume 都不静默丢最新；blocked 快照与非崩溃请求等价；在 post-tool、next-tool checkpoint、blocked result、flush 前后逐点 crash-cut；连续两次 resume 不消失不重投；extend/revise/forced-final 主模型可见、judge 不可见；工具事实/usage/abort 不变。

**预计改动**：源码 80–150 行，测试 160–280，双语契约 40–80；总约 280–510 行。

**真实命令**（未来在可写实施 worktree 执行）：

```bash
node --test test/judge.test.js test/run-snapshot-executor.test.js \
  test/loop-resume.test.js test/loop-final-guard.test.js test/display/projection.test.js
npm run check:syntax
npm run check:types
npm run check:docs
npm run check:docs:strict
npm test
```

**风险/回滚**：标记会有意改变 judge 输入。snapshot 新字段 additive，旧快照缺字段兼容；旧版本读未知字段保真。不能删快照或重放写工具“回滚”；用固定 crash fixture 证兼容。**依赖：无**。

### W02 上游：可选且有限容量的达成软提示

**层**：上游引擎，P1 行为变更。**依赖：W01**。

**文件/锚点**（`U@9440b1c`）：`src/loop/reflection.js:18` 提示生成区域；`run-snapshot-executor.js:555–565` 放行；`orchestrator.js:3297,3319–3324` 两处阈值、reflection 选项 JSDoc（329 附近）、ctx 装配（2421 起）。

**实施**：提取两处共享 0.7 阈值；在现有 reflection 对象定义一个**拟新增**布尔子键，默认 false、非法输入报 TypeError（本报告不把不存在的名字冒充现有 API）；单槽 advisory 按 §3.2；uncertain 改为中性文本，未启用功能的宿主不自动增加噪声。继续用 judge-control，无需改 renderConversation 排除集。

**验收**：关闭时旧请求逐字不变；开启后 done=true 且 0.7 生效，0.699/解析失败不生效；不重标 direction/action；超长限幅、同轮至多一条、主模型见而 judge 不见；不加审计、不掐工具批次，末个被审计工具后可投；恢复去重。

**预计改动**：源码 60–110，测试 120–220，README 对/契约对/CHANGELOG 80–160。若按当前习惯为新 minor 增升级指南对，还会动包 files、README 清单、文档下限和指南 pinned list；是正常发版成本，不能省略来凑“小改”。

```bash
node --test test/judge.test.js test/reflection.test.js \
  test/loop-option-normalization.test.js test/loop-resume.test.js
npm run check:syntax
npm run check:types
npm run check:docs
npm run check:docs:strict
npm run check:docs-examples
npm test
```

发布再执行现存 `npm run check:types-build`、`npm run check:release`，它们会写文件，本次没跑。若改 drift checker，按 AGENTS 加 `node scripts/docs-drift-check.mjs --self-test`，已知 archive 例外外的新红不能放过。

**风险/回滚**：可能过早收尾，也可能无效。上游默认关、station 可关子键回旧行为；不承诺零额外调用。硬性调用上限/独立验收另立设计，不能偷塞本单。

### W03 station：judge 分轴文案，随后双 pin/显式启用

**层**：前端；后半为 runner 接线/依赖升级。

**文件/锚点**（`S@9567b05`）：`useEventStream.ts:419–443` judge、`replayEvent`；`StreamPanel.vue:254–255` sep；`i18n/locales/zh-CN.ts:228–231`、`en.ts:215–218`。接引擎改 `runner/worker.js:571` reflection，根 `package.json:25`、`runner/package.json:11`、两处实际 lockfile、AGENTS §8。

**实施/验收**：

- 显示“工具审计/放行或拦截”“目标判断/置信度/未核验”“方向”“扩轮”不同轴，不用三个互斥状态。
- executed = **工具调用已放行（非任务完成）**，不是“拦截判定已执行”；done=true = “评审认为达成，未独立核验；run 仍执行中”。终态只由 run_end 驱动。
- passThrough/extend 提前 return 不再遮掉 done/uncertain；degraded/未知 action 中性降级；实时/历史同文案。
- extend+redirect 不反推工具已执行，真实结果卡为准；MVP 不虚构 tier。
- 先发前端不等上游。W01/W02 实际发包后，两个 exact pin 一起升到含修复版本并显式启用；**只升现有 0.21.0 不能声称包含本报告尚未实现的功能**。

**预计改动**：主路径文案可 25–35 行；完整分支/双语/测试约 100–180，双 pin/接线/升级记录另 20–50。

```bash
npm --prefix portal/frontend test -- src/composables/useEventStream.spec.ts \
  src/components/StreamPanel.spec.ts src/i18n/localeParity.spec.ts
npm --prefix portal/frontend run typecheck
npm --prefix portal/frontend run build
node --test portal/test/engine-api-contract.test.js portal/test/engine-upgrade-299.test.js \
  runner/test/store-contract.test.js runner/test/replay-policy.test.js \
  runner/test/tool-result-envelope-contract.test.js
```

**风险/回滚**：不动 run 状态机，不把 judge 当 run_end；先关新子键、再退双 pin，不单退 runner 留异版本 portal。正确文案可保留。**依赖：文案无；双 pin 依赖上游发包**。

### W04 station：常驻活动栏、耗时与真实时间元数据

**层**：前端为主、后端 DTO。

**锚点**（`S@9567b05`）：`useEventStream.ts:333,338–340,380–384,474–494`、`RunHistoryEvent:63`、`RunEndPayload:114`；`workbench.ts:100–115,130–149,232,319–355`；`StreamPanel.vue:254–255`；`http.js:1859,1885–1895,1920–1944`；`session-view.js:438`；`internal.js:704,712`。

**MVP**：

- 常驻 running/正在工具调用/等待模型/终态、run 耗时、最后**引擎输出或事件**距今，停止入口明显。
- 完成时刻常显、逐条 hover 用真实 created_at；未知不显示。消息锚点创建时间不能冒充每个模型片段完成时刻。
- metadata 必须贯通类型、entry、onSep；历史查询补 ts，防刷新丢时间。run_id 为空的直发消息保留，不被分组吞掉。
- round 跨 resume/会话递增，先标“引擎轮号 N”，不能谎称“本 run 第 N/16 轮”。
- SSE 连接正常不证明模型/工具活着；EventSource 不把注释 `: ping` 当正文事件交前端。无输出写“已 N 秒未收到新输出”，不下“卡死”结论。

**完整版**：实时 assistant 字符/字节量（onDelta 真实存在）、工具经过时间；reasoning 即使不展示正文也更新活动时间；usage 到达再更新 tokens，终态用 Run usage 定格。不制造瞬时 TPS/单价表。GET Run 补 rounds 的查询/映射及测试，**与 tokens 无前置依赖**。

**预计改动**：前端 100–180 + 测试 140–240；后端 ts/rounds 10–25 + 接口测试/文档 40–90；总约 290–535。

```bash
npm --prefix portal/frontend test -- src/stores/workbench.spec.ts \
  src/composables/useEventStream.spec.ts src/components/StreamPanel.spec.ts
npm --prefix portal/frontend run typecheck
npm --prefix portal/frontend run build
node --test portal/test/session-events-history.test.js portal/test/session-http.test.js \
  portal/test/session-view.test.js portal/test/internal.test.js
```

**验收**：fake timer 跨秒、终态冻结；换会话不串 run；两 run/直发/无时间保留；乱序重放不倒退 last activity；无输出长工具不误标失败；刷新时 ended_at/usage 一致；rounds 从 DB 真值映射。

**风险/回滚**：timer 在切屏/卸载清理；字段 additive、无 DB 迁移，退前端可留后端字段。**依赖：无，应早于 W02 获得试用收益**。

### W05 station：目录下划线

**层**：前端。

**锚点**（`S@9567b05`）：`lib/constants.ts:8`、`workbench.ts:createDir:652`、`NewDirectoryModal.vue:57`；双语 newDirLabel/dirNameInvalid；旧文案断言 `SidebarPanel.spec.ts:319,348`、`workbench.spec.ts:153,657,679`。

**实施**：保小写/最多63/禁首尾连字符，允许 `_`（含首尾）；不动 CWD_RE/FDE_NAME_RE/DNS_LABEL_RE，不 normalize/消毒/迁移。正例 `cmms_test/_cmms/cmms_/a-b_2`，负例 `./../slash/控制字符/大写/首尾-/64字符`。后端本就更宽，不假装本单两端完全同规则。

**预计改动**：源码/词条 8–15，测试 30–60；“一处正则”是业务改动面，不是总交付一行。

```bash
npm --prefix portal/frontend test -- src/stores/workbench.spec.ts \
  src/components/NewDirectoryModal.spec.ts src/components/SidebarPanel.spec.ts \
  src/i18n/localeParity.spec.ts
npm --prefix portal/frontend run typecheck
node --test --test-name-pattern=validateSessionCwd portal/test/sessions-cwd.test.js
```

**风险/回滚**：退前端只再禁新建 `_`，存量后端仍访问；测试已有目录选择不受影响。**依赖：无**。

### W06 文档：证据勘误、版本边界与 Cookie blocker

**层**：文档/文案，不冒充兼容改造。

**文件**：被审文档；ISSUES 保历史原文追加日期勘误；`docs/api/portal.md` 随 W04 对齐；station AGENTS §8 随 W03 pin 对齐（均以 `S@9567b05` 为起点）。

**必须修订**：marker 必须新值、溢出不可达、末次漏投、75 节、tokens/rounds 因果、插件唯一论、整片砍活动信号、HEAD≠部署。上游两个 delivery 报告 `git ls-files` 无输出、`git check-ignore` 命中，是本机忽略资料，不可给浮动内容套当前 commit 行号。

Cookie 边界依据 `S:routes.js:188,203–207`、`http.js:2255`：X-Auth-User 是平台身份，不是应用会话。本轮只明示“不支持 cookie-session SSR 的当前限制/替代路径边界/平台修复未完成”，不要求应用长期把认证 token 放 URL，不把文档 C 称修好了登录。

**预计**：80–160 行文档。API 宣称更动随 W04 接口 tests；相关现有契约命令为 `node --test portal/test/termination-contract.test.js`。上游公共文档仍走 W01/W02 双语 gates。

**风险/回滚/依赖**：无运行风险，保留历史日期；基础勘误立即可做，pin/API 宣称等待代码。

### 4.1 两档、规模与发版顺序

| 档 | 内容与顺序 | 不承诺 |
|---|---|---|
| **MVP：消除盲等与语义误导** | W03 前端 + W04 基础活动/时刻 + W05，可并行；W06 立即勘误。W01 并行进入上游 | 不承诺 done 后立刻停、不伪 TPS、不声称 Cookie SSR 兼容 |
| **完整版：保真与软收尾闭环** | W01→W02→上游新 minor→W03 双 pin启用；W04 字符/usage 与收益观测；W06 同步 | 不以模型自述作验收，软提示不提供额外工具数硬上限 |

**成本诚实**：单补几个 marker、或 W03 主路径换词可约 25–35 行源码；W05 更小。**W01 恢复链、W02 公共行为/发布、W04 元数据/历史/时钟不是小改**。完整版合计约 1,100–2,000 行（含大量测试/双语文档，非全业务逻辑），按工单分审，不能报价“4 文件 35 行”。

**边界与门禁**：

1. station 可先发文案/活动修复，不提前启用不存在的配置。
2. 上游新 minor 先过语法、测试、docs 普通/strict、types，再发布；新增指南/符号改变实际数字时同步脚本、双语 AGENTS、pinned list，不抬裸行号基线掩盖漂移。
3. station 根/runner 两处 exact pin、lockfile、安装包契约验收同步；镜像 digest 按真实发布再部署，不只改 package.json 就声称试用已生效。
4. station 根真实脚本是 `test` 等，不存在其自有 `check:syntax`、`check:docs`、`test:unit`。前端真实脚本是 test/typecheck/build。`test:integration:wp6` 涉真模型，不塞进零成本必跑。

### 4.2 只做一件事

**做 W04 的“运行状态/耗时/最后真实输出距今/最近 judge 是非终局意见”常驻状态面，并保留明显停止入口。**

第 1 条原话是“无法判断还在执行 / 卡死 / 刚返回，只能盲等”；第 5 条是“此刻还在不在动”；第 4 条是“已达成却继续烧轮”。该状态面明确“评审认为达成，但 run 仍在运行”，让用户及时停止，覆盖共同焦虑且不加模型费用。

它不自动消灭额外调用。若唯一标准是“无需人干预且不扩包”，优先 W01+W02 并真机比较；若要求确定性，就还需要显式验收/调用预算策略，不能包装一句软提示为硬保证。

## §5 P1–P5 独立推荐

| 问题 | 推荐 | 理由 | 反向代价 |
|---|---|---|---|
| **P1 引擎还是宿主** | **上游实现；MVP 人类可见性在 station 先做** | 引擎拥有消息、marker、flush/恢复；同一主人没有外部 PR 摩擦 | 宿主回灌可行且不漏最后被审计工具，但污染工具事实、judge 自读，还受结果截断/聚合影响，非等价替代 |
| **P2 默认开关** | **上游关、station 显式开** | 新提示改变模型策略，未改判定字段≠没行为变化 | 全局默认开需所有消费者迁移说明/关闭开关/误收尾回归；station 也不开则只修可见性 |
| **P3 条数上限** | **每轮1达成+2方向、限长且生产端合并，不设全 transcript 终身额度** | 默认33工具已越界；interval可配；sessionId不是宿主run身份 | 无限会增内存/快照/prompt；只切前二丢最新；全任务上限另付身份、恢复、任务重置成本 |
| **P4 uncertain 文本** | **MVP 准确展示给人；模型文本仅显式启用后给中性版本** | uncertain是不确定，不是偏航，原模板会诱导多试路线 | 默认全给增加噪声/过度纠偏；始终不给保留信息缺口。两者都不得篡改 direction |
| **P5 终态分隔条** | **终态看 run_end/termination；运行中 judge 分执行/目标/方向/扩轮，未来再叠加真实 verification** | 三者非同维非互斥；当前无 finalGuard | 按guard三支是空壳；互斥三态遮 done+off_track/readonly；从action推执行会被extend优先骗过 |

verification.status / final_guard.action 是真字段，但不等于 station 已完整接线。没独立核验就如实写“未独立核验”。

## §6 文档可信度与遗漏清单

### 6.1 可保留

单值门/排除、双 flush、三重门、两处0.7、executor五键、宿主无guard、cwd/DNS/Run DTO 的主干锚点准确。不改 direction、不污染工具事实、不把模型当确定验收的方向正确。

142/63/119 本轮重新运行得到同值，不是抄旧材料；文档承认无真模型运行也恰当。

### 6.2 阻止照原稿施工的缺陷

1. **因果收缩**：UI 误读不是全部，真实额外工具调用不能换词修掉。
2. **marker 偷换前提**：共享 marker 不适合专属计数，不等于不能复用 source。
3. **可达性错误**：4工具/2审计不能推出默认不溢出；33工具双路径已反证。
4. **末次漏投错误**：probe6 自己就附着最后工具成功，应删该代价。
5. **恢复覆盖缺口**：只测普通恢复，漏 pending 不存、snapshot-only 不落档、二次恢复消失。
6. **漏强制收尾 marker**；还需分清控制意见和事实，不能全部引擎文本一刀切删除。
7. **uncertain 一行文案失真**；未给 reason/空字段/重复意见明确预算。
8. **UI 锚点错误**：生成在 useEventStream，时间还需 workbench/接口。`runId ?? '__direct__'` 在当前这条工作台实现**查不到**，只能当拟实现提醒，不能引用成现存机制。
9. **tokens/rounds 错因果**；实时字符/字节活动量不因无法精确TPS就不可做。
10. **轮号口径**：跨 resume 身份轮号不是本run预算轮。
11. **错误 details 推论过强**：`S:http.js:69–72,561–569` 原样 details；`S:api.ts:97–105` 用 error.message；`S:workbench.ts:664–666` 返回 e.message。字符串 details 不是所有路径必落兜底文案的充分条件，需看具体调用。
12. **旧报告腐烂**：interceptJudgeDecision 不清零已被当前2939反证；delivery资料无当前commit跟踪身份。
13. **Cookie候选不完备**：无内建按名称过滤配置≠一定第三方插件；自有鉴权/代理有成本但不是外部依赖。
14. **报价漏承重面**：队列/ctx/snapshot/resume/类型/双语发布不可能全塞35行。

### 6.3 Cookie 核对范围

源码确认 `fde-auth, strip-cookie`（`S:routes.js:188`）、X-Auth-User（203）、Cookie置空（207），足以解释 classic cookie session 不保登录，但没重演指定 Flask 全页面。

独立读取 Traefik **v3.7 官方文档**（仅公开 URL，不发送仓库代码）：

- [Headers](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/headers/)：customRequestHeaders 空值删除头。
- [ForwardAuth](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/)：authResponseHeaders 将鉴权响应头复制到转发请求，替换冲突头。

后者保留了“自有鉴权端处理后回写请求头”的无第三方插件机制空间。本轮未真机验证 Cookie 特例、空头/续期/预检/同名不同路径组合，**不直接派该功能上线**。先写边界可作为范围决策；“唯一选择所以问题解决”不可采纳。

## §7 未验证 / 真机才能定

| 项目 | 边界与所需证据 |
|---|---|
| 10月13日 production-scheduling 真实run | 未取DB/完整judge.log/JSON，不能反推done/confidence/kind、精算十几轮费用；需run_id、逐事件、当时镜像 |
| 部署镜像源码版本 | deploy/.env 未跟踪，本轮只读镜像digest；不能证明其等于v0.1.5，未运行Docker inspect/启动，未把HEAD当部署 |
| advisory 实际收益 | fake只证可见/隔离/容量/恢复；需旧新同任务对照额外工具、judge调用、tokens、通过率、误收尾 |
| done/direction 分布与阈值校准 | 未打真模型，不能假定uncertain少或0.7可靠 |
| Cookie SSR 完整改法 | 源码/官方机制已核，目标应用与边缘链未跑；文档延期不是兼容修复 |
| GitHub issue今日状态/是否已建单 | 未查GitHub状态/发评论，不把旧稿OPEN/CLOSED当今日事实；工单按源码问题自足 |
| 所谓全历史不存在/旧报告曾否落盘 | 未搜其他用户目录或全分支历史；只确认本基点src查不到那组符号 |
| 个别权限 | 目录授权有效；扩展检索遇 deploy/traefik/dynamic/llm-routes.yml 单文件不可读，没绕过。预览规则已由固定提交routes.js证实，不影响任务完成 |
| 未跑的门 | 未跑写仓库的types:build/check:release、安装、前端build/Vitest、全量npm test、真模型集成；实际运行的targeted/docs/checkJs/语法/探针见§1，未来工单命令不冒充已跑 |

全部报告与复验证据只写入指定 sandbox；实施前再次核 SHA，若移动则按新 SHA 重验，不沿用本文行号。
