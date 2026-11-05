# AGENTS.md 层级注入评估（宿主侧「让 agent 读 AGENTS.md 及其上级目录」）

> 状态：**已落地**（issue #451；分支 `feat-261105-01-agents-md-layering`，PR 由主 agent 统一收尾）。
> 代码落点：`runner/lib/agents-md.js`（采集 + 渲染）、`runner/worker.js` 的 `startRun`（接线）；
> 判据：`runner/test/agents-md.test.js`（16 格）+ `runner/test/system-prompt.test.js`（指针用例改写 + 2 条接线锁）。
> §7 表里标了各片完成情况；**§1.2 / §4.4 的实测数字一个都没改**（那是开工前的真机取证，改了就失去对照价值）。
> 作者：主 agent；日期 2026-11-05（UTC+8）。裁决项见 §5。
> 需求原话：「作为宿主需要实现一个功能，让 agent 读取 AGENTS.md 以及上级目录的 AGENTS.md，做个评估。」
> 参照系：pi（本机开发环境的 harness）的 `global → 父目录 → 当前目录` 逐级拼接。

---

## 0. 结论

**要做，但不是"再加一条提示词"，而是把「告知面」从"让模型自己去读"改成"宿主在 run 启动时注入"。**

三条理由（都有实测证据，见 §1.2）：

1. **今天这条链基本没被执行**：近 14 天 35 个 run 里只有 5 个跑过含 `AGENTS.md` 的命令（14%）；
   其中 4 个是**我自己的验收探针**（`probe-438` / `probe-ttl`），**真实任务的 5 个 run 里只有 1 个读过**。
   换句话说 **~86% 的 run 从头到尾没读过那份 9 KB 的平台约定**——而它里面装着预览访问 8 条、
   收工即提交（#359 D9）、环境事实、GitHub 拉取兜底。
2. **读到的也常常是残的**：5 个 run 里 **4 个**自带 `head -50/60/80` 截断。`~/AGENTS.md` 共 67 行，
   **「收工即提交」在第 53–54 行** ⇒ `head -50` 正好把它切掉（实测，见 §1.2）。
3. **读进 transcript 的规则会随轮次被折掉（机制风险，不是已观测故障）**：那条 `cat` 结果是**某一轮的工具结果**，
   整轮被 `fold-llm` / `sliding-window` 折走时一起消失；而 **system prompt 永远不参与折叠**。
   ⚠ 口径：dev 全库只有 2 个会话发生过整轮折叠（`e02d96cb` 折 1–22 轮、`16261d57` 折 1 轮），
   **它们都没读过 `AGENTS.md`** ⇒ 这条是「机制上必然、dev 上尚未发生」，不许写成已观测。
   （TTL 层今天也不会折它：本站 `toolResultFoldMinTokens=8000`，而平台文件按引擎估算 4081 tok。
   折叠摘要进的是 **user** 消息不是 system：`summaryRole` 默认 `"user"`，`src/compact/budget-fit.js:134`。）

顺带解决两件既有欠账：**父目录层今天根本不存在**（提示词只提 `~/AGENTS.md`，`~/projects/AGENTS.md`
与项目根 `AGENTS.md` 从未被提到）；**`readFile` 读不到它们**（jail root = cwd，#259 未落地）。

代价也诚实写在 §4.4：约 +4.5k token/轮（引擎口径，含平台 9 KB + 项目文件），对中位 15.6k 输入的小 run 是显著比例，
但**大部分是今天本来就要花的**（模型合规时那次 `cat` 同样进上下文），真正的净增出现在"今天压根没读"的 run 上
——而那正是要修的那部分。

---

## 1. 现状

### 1.1 代码事实（改动前）

| 事实 | 位置 |
|---|---|
| 平台约定由 materializer 物化到 `~/AGENTS.md`（root:root 0644，每轮 reconcile 覆盖） | `portal/src/materializer.js:322`（`add(\`${CONTAINER_HOME}/AGENTS.md\`, renderHomeAgentsMd(...))`） |
| 落点是决策者 2026-10-12 定的：**规则只住 `~/AGENTS.md`，提示词只留强制指针** | `portal/src/materializer.js:177-183`、`docs/design/user-space.md` §4.1.2 |
| 提示词里的强制指针 + 读法（`cat ~/AGENTS.md`） | `runner/worker.js:81`、`:85` |
| 提示词注入点（`config.input.system`） | `runner/worker.js:703` |
| 文件工具读边界 = 项目根，无只读例外 ⇒ `readFile ~/AGENTS.md` 撞「被宿主边界拒绝」 | `runner/worker.js:480`（`createJail({ root: cwd, writable: [cwd] })`）、`runner/lib/file-tools.js:56-90`、`docs/design/user-space.md:184` |
| 防漂移锁：指针必须存在 + 8 个规则词不得进提示词 | `runner/test/system-prompt.test.js:207-247` |
| 家目录解析已有先例（skills loader） | `runner/worker.js:554`（`home: process.env.HOME \|\| '/home/erix'`） |
| 层级优先的仓内先例：skills 是 `project > ~/.erix/skills > bundled`（内层优先） | `runner/worker.js:546-553` 注释 |

**结论：今天只有一层，而且靠模型自觉。**

### 1.2 真机事实（2026-11-05 现查，`station-db` 只读 SQL）

```sql
-- 近 14 天有真实用量的 run 数 / 其中跑过含 AGENTS.md 命令的 run 数
select count(distinct r.id) from runs r
 where r.started_at > now()-interval '14 days' and (r.usage->>'input_tokens')::bigint > 0;
-- 35
select count(distinct e.run_id) from run_events e join runs r on r.id=e.run_id
 where r.started_at > now()-interval '14 days' and e.type='tool_use'
   and (e.payload->'input'->>'command') like '%AGENTS.md%';
-- 5   （6 次调用）
```

| 指标 | 值 | 含义 |
|---|---|---|
| 近 14 天 run 数 | 35 | — |
| 读过 `AGENTS.md` 的 run | **5（14%）** | 86% 的 run 全程没读 |
| 其中是验收探针（`cwd` 含 `probe`） | **4/5** | 真实任务里只有 1 个（`todo-multi`）读过 |
| 真实任务 run / 其中读过 | **5 / 1**（样本小） | 有机合规率 ≈ 20%，n=5，只作趋势不作定论 |
| 其中自带 `head -N` 截断 | **4/5**（`head -60` / `head -50` / `head -80` / `cat -n \| head`） | 读了也是残的；只有 1 个 run 整份读 |
| `~/AGENTS.md` 行数 / 大小 | 67 行 / 9 018 B（引擎 `estimateTokens` = **4 081 tok**） | 「收工即提交」在 **53–54 行** ⇒ `head -50` 丢掉它 |
| 同批读 `ports.json` 的 run | 3 | 端口告知面同样靠自觉 |
| 单 run 累计输入（14 天） | 均值 176 k / 中位 15.6 k / 最大 1.95 M；均 10.8 轮 | 成本基数 |

> 口径提醒：`usage.input_tokens` 是**该 run 各轮累计**（§8.75 已记），不是单轮。

**三条由此得出的结构性缺陷**：

1. **「下发了 ≠ 读了」在统计上就是常态**（14%），不是个别模型跑偏。R-1 当年只验了"给了指针就会读"，
   没验"长期、多任务下还读不读"。
2. **读法本身不可靠**：`cat | head -N` 是模型的自保习惯（怕灌爆上下文），结果把尾部规则切掉。
   提示词里写"整份读"也挡不住，因为它不知道文件有多长。
3. **内容生命周期错位**：规则进了 transcript = 进了可折叠区；规则进 system prompt = 不可折叠。
   长会话（今天 dev 就有 60 轮量级的会话）后半程，平台约束事实上失效。

### 1.3 层级现状：只有一层

| 层 | 路径 | 今天是否被告知 | 是否能被 `readFile` 读 |
|---|---|---|---|
| 平台 | `~/AGENTS.md`（materializer 生成） | ✅ 强制指针（+ shell 读法） | ❌（jail） |
| 跨项目 | `~/projects/AGENTS.md` | ❌ 从未提及 | ❌ |
| 项目 | `~/projects/<project>/AGENTS.md` | ❌ 从未提及 | ✅ |
| 子仓库 | `~/projects/<project>/<repo>/AGENTS.md` | ❌ | ✅ |

实测盘点（`/srv/erix/users`）：平台文件 6 份（各 5.6–9.0 KB）；**项目级只有 1 份**
（`eric/projects/meeting_asr_app/AGENTS.md`，911 B）；`~/projects/AGENTS.md` **一份都没有**。
⇒ 本功能的**当前收益主要来自平台层**（那 9 KB），父/项目层是"为将来留位 + 让已有的那份生效"。

---

## 2. 目标语义

### 2.1 层级与顺序（由外到内）

```
~/AGENTS.md                    平台生成（materializer），不可被下层覆盖
~/projects/AGENTS.md           用户跨项目约定（用户自建，平台不物化）
~/projects/<project>/AGENTS.md 项目约定（agent 自己写/仓库自带）
（cwd 之下若还有祖先目录，同规则继续向内；cwd 是项目根，通常没有）
```

**拼接顺序 = 由外到内**，与 pi 一致；**优先级 = 内层更具体，但平台节不可覆盖**（差异见 §5-①）。

### 2.2 注入时机与生命周期

- **每个 run 启动时读一次**（worker 侧，容器内 fs 直读），拼进 `config.input.system`。
- run 内不变（system 是稳定前缀，见 §4.4 缓存口径）；**下一轮 run 自动看到上一轮 run 里 agent 改过的 AGENTS.md**。
- 在 run 中途写 AGENTS.md **不影响本 run**（要在提示词里说明，否则模型会以为改了立刻生效）。
- **resume / 重试也要重读**：每次 `startRun` 都重新采集（worker 进程会被 agentd 复用给下一个 run，
  §8.64 记过 `steerArmed` 漏复位的老账）⇒ 采集**必须在 `startRun` 里做**，不能提到模块顶层常量，
  否则第二个 run 会沿用第一个 run 的内容（或启动时的空快照）。

### 2.3 不可变的边界

- **只读 `$HOME` 及其子孙**：不读 `/AGENTS.md`、不读 `/etc/**`、不越过 `realpath(HOME)`。
- **不改 jail 写边界**（`writable: [cwd]` 一字不动）；本方案连读边界都不改（宿主读文件不经过文件工具）。
- **不物化任何用户内容**：`~/projects/AGENTS.md` 属用户空间，平台不创建、不覆盖、不进入 manifest。

---

## 3. 方案对比

| 方案 | 做法 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| **A 宿主注入（推荐）** | run 启动时宿主读 AGENTS.md 链，拼进 `config.input.system` | 确定性（不依赖模型自觉）、零额外轮次、**不可折叠**、父/项目层一次性覆盖、无 jail 改动 | system prompt 变长（+4.5k tok/轮，引擎口径）；每 run 多几次 `stat/open`（微秒级） | ✅ |
| **B 只加强提示词 + 开 #259 读边界** | 提示词写清"先读这三份"，jail 加只读例外让 `readFile` 能读 | 零 token 成本（不读就不花）、模型可控 | 依赖自觉（实测 86% 不读）、多烧 1–3 轮、**仍会被折叠掉** | ❌ 单独用不行 |
| **C 混合** | 注入"索引"（哪几份文件、各多少行）+ 开 #259，正文让 agent 按需读 | 成本最低 | 仍要模型动手（同样的 86% 失败模式） | 作为 A 的**子集**保留：索引 + 提示句 |

**推荐：A（注入正文）+ C 的索引（列"还有哪些子目录有 AGENTS.md"）+ 建议另单做 #259**
（#259 在 A 之后从"必需"降为"顺手"：注入已覆盖主路径，但模型仍会想 `readFile` 它们、也想 `readFile ~/.erix/ports.json`）。

---

## 4. 推荐方案（A）设计

### 4.1 采集器：`runner/lib/agents-md.js`（新增，纯函数、可注入 fs）

```js
export const AGENTS_MD_BASENAME = 'AGENTS.md';
export const AGENTS_MD_MAX_FILE_BYTES = 16 * 1024;   // 单文件上限
export const AGENTS_MD_MAX_TOTAL_BYTES = 48 * 1024;  // 全链上限
export const AGENTS_MD_MAX_SUBDIR_HINTS = 5;         // 子目录索引条数上限

// 由外到内的候选链（home → … → cwd），每项 { dir, path, scope }
// cwd 不可用 ⇒ 返回 []（空链）；home 不可用 ⇒ 只返回 [cwd] 一项（scope = project）
export function resolveAgentsMdChain({ cwd, home, fs: fsImpl = fs } = {}) {}

// 返回 { blocks: [{ dir, path, display, scope, text, bytes, truncated }],
//        totalBytes, notes, subdirHints }
// `limits`（{ maxFileBytes, maxTotalBytes, maxSubdirHints }）只给单测用，生产没有 env 旋钮
export function collectAgentsMd({ cwd, home, fs: fsImpl = fs, limits = {} } = {}) {}

// 无 blocks ⇒ 返回 ''（system 逐字节等于原值）；有内容时自带前导 '\n\n'
export function renderAgentsMdSection({ blocks, notes = [], subdirHints = [] } = {}) {}
```

> **与初稿的差异（实现后回填，2026-11-05）**：`subdirHints` 是独立的一个键，**不塞进 `blocks`**——
> 子目录索引是「索引不是正文」，混进 `blocks` 会污染「注入了几份文件」的账，也会被全链截断逻辑当成一份内容。
> 三处签名对 `null` / 缺参 / 非字符串路径**一律降级不抛**（详见下面规则 6 的补充）。

规则（每条都要单测）：

1. **链的构成**：`realpath(cwd)` 向上直到 `realpath(home)`（含 home 自身）。若 `cwd` 不在 home 之下
   （理论上不该发生）⇒ 只读 `cwd/AGENTS.md`，并记一条 note（随注入段的「采集记账」小节上浮，不额外发日志）。
2. **scope 标注**：`home` ⇒ `platform`；`home/projects` ⇒ `workspace`；其它 ⇒ `project`。
   平台节由 materializer 生成（root:root），用户改不动 ⇒ 这是"不可覆盖"的**事实依据**，不是约定。
3. **跳过**：不存在 / 非普通文件（`stat.isFile()===false`）/ 空或全空白 / 与前面某份 **sha256 相同**（去重，防用户抄一份）。
4. **越界**：`realpath(file)` 必须仍在 `realpath(home)` 内（挡 symlink 逃逸）；不满足 ⇒ 跳过 + note。
   实现以「链的最外层目录」为基准：home 是祖先时它就等于 `realpath(home)`；`cwd` 不在 home 之下时退回 `cwd`
   （否则那份项目文件按定义「越界」，永远读不到）。
5. **截断 / 挤出**：**单文件** > 16 KiB ⇒ 截断并留 marker：
   `[已截断：原 N 字节，仅注入前 M 字节；看全文：cat <path>]`（给的是可直接照抄的命令；按 UTF-8 字符边界切，
   不产生半个字符）。**全链** > 48 KiB ⇒ **从内层开始整份不注入**并逐份记账（实现是 `blocks.pop()` + note），
   不是把内层截一半——**平台节必须完整**（它装的是运行期硬约束）。只有「单份就超全链上限」这种极限情形
   （默认常量下不可达：单文件 16 KiB < 全链 48 KiB）才会把那一份截断，并另记一条 note。
6. **失败隔离**：任何 `EACCES` / `EISDIR` / 解码失败 ⇒ 该份跳过 + note，**绝不让 run 失败**。
   注意 worker 是 uid 1002、home 目录 0770 erix:erix（实测可读 `~/AGENTS.md` 与 `~/projects`），
   但若用户把某份写成 `0600` 且属主不是 worker，就会走到这条分支。
   **「绝不抛」也包括调用方传错参数**（返修 F1，主 agent 亲审实测出来的真缺口）：`cwd` / `home` 非字符串或空串
   ⇒ 降级（`cwd` 不可用 ⇒ 空结果 + note；`home` 不可用 ⇒ 只按 `cwd` 采集 + note），**不是异常**。
   为什么这条是硬的：这次采集在 `worker.js` 的 `startRun` 里、`runToolLoop` **之前**，抛出去 = worker 进程死
   ⇒ agentd 当崩溃处理 → requeue → 3 次 attempt 耗尽，用户只看到「attempts exhausted」。
   采集与渲染在 worker 侧还各包一层 `try/catch`（catch ⇒ 注入段置空 + 一条 `MSG.LOG` warn，run 照跑）。
7. **子目录索引**（C 的部分）：`cwd` 的直接子目录里带 `AGENTS.md` 的，最多列 5 条路径（只列路径，不注入正文）。
   动机：真实形态是"目录即项目，仓库在其下一层"（D9 记过"一个目录里有多个仓库"），
   而仓库自带的 `AGENTS.md` **不在 cwd 的祖先链上**。
   ⚠ **子目录索引只在至少注入了一份文件时才渲染**（`blocks` 为空 ⇒ 整段为空串，索引不单独出现）。
   这是**口径 7（子目录索引）与口径 8（渲染逐字节确定：无 blocks ⇒ 空串）的取舍**，实现按 8 裁（#451 评审 M2，
   产品行为不变）：代价是「项目根没有 `AGENTS.md`、只有几个子仓库各有一份」时连索引也看不见；
   补偿是 `worker.js` 那条 info 记账里拼上**前 2 条 note 摘要**（超过 2 条加 `…`，仍是 `MSG.LOG`、
   **不新增事件类型**）——`blocks=[]` 时 notes 同样进不了 prompt，日志是唯一通道。

### 4.2 渲染与拼接位置

```
config.input.system = SYSTEM_PROMPT + '\n\n' + renderAgentsMdSection(blocks)
```

`renderAgentsMdSection` 输出形状（示意）：

```
## 本次 run 注入的约定文件（AGENTS.md 链，由宿主在启动时读取）

> 顺序：由外到内（越靠后越具体）。**平台节由平台生成、不可被下层覆盖**；若下层与之冲突，
> 按平台节执行并在回复里告知用户。以下内容已在你上下文里，**不要重复 cat 它们**
> （除非你要确认文件是否被改过）。你在本 run 里修改这些文件不会立刻生效，下一次 run 才生效。

### 1. ~/AGENTS.md（平台生成，不可覆盖）
<原文>

### 2. ~/projects/AGENTS.md（跨项目约定）
<原文>

### 3. ~/projects/<project>/AGENTS.md（项目约定）
<原文>

### 子目录里另有约定文件（未注入，进那个目录工作时先读它）
- ~/projects/<project>/<repo>/AGENTS.md
```

三条硬口径：

- **不写时间戳 / 不写 run id / 不写 generation**：system 是 prompt 缓存的最前段（引擎 `markStablePrefix`
  给 system 打 `cacheBoundary`，`runner/node_modules/erix-agent/src/loop/provider-runner.js:57-73`），
  任何每次变化的内容都会让整条前缀缓存失效。文件不变 ⇒ 输出逐字节不变。
- **平台节的"不可覆盖"写在宿主生成的抬头里，不写进 `~/AGENTS.md` 正文**：正文由 materializer 管，
  抬头由 runner 管，两边不互相引用（避免第二份会漂的真相）。
- **不复制规则文本**：注入的是文件原文，宿主不解析、不改写、不摘录。8 条规则仍然只有一份。

### 4.3 要跟着改的地方（否则会与既有锁打架）

| 位置 | 现状 | 改法 |
|---|---|---|
| `runner/worker.js:81-85` 指针段 | "先读 `~/AGENTS.md`……文件工具读不到，用 shell 读：`cat ~/AGENTS.md`" | 改成"平台约定**已随本次 run 注入**到本提示词末尾；`~/.erix/ports.json` 仍需 `cat`（它是动态清单）；若要确认约定文件是否被改过，可 `cat` 复核" |
| `runner/test/system-prompt.test.js:207-217` | 钉死 `先读` + `cat ~/AGENTS.md` + `文件工具读不到…用 shell 读` | 按新语义重写：**仍然要求**存在"已注入"的明确告知（否则模型不知道那段内容从哪来），并保留 `cat ~/.erix/ports.json` 与 shell 复核口径 |
| `runner/test/system-prompt.test.js:248-259` | 预览段必须含 `shell`（给 `ports.json` 的读法）+ `0.0.0.0` | 只要 `cat ~/.erix/ports.json` 那句还在就能过；**别顺手把"用 shell 读"整段删掉** |
| `runner/test/system-prompt.test.js:219-247` | 8 个规则词不得出现在 `SYSTEM_PROMPT` 常量里 | **一字不改**。注意：它抠的是 `worker.js` 里的常量，不是运行时拼好的字符串——运行时**必然**含这些词（那正是目的），别把断言改成"查最终 prompt" |
| `runner/test/system-prompt.test.js:42` | 抠取器假设「声明紧跟分号」 | 接线只改 `config.input.system` 的取值表达式，**不动 `const SYSTEM_PROMPT = \`…\`;` 这一行** |

### 4.4 成本与缓存（诚实口径）

| 项 | 数 | 依据 |
|---|---|---|
| 平台节 | 9 018 B，引擎 `estimateTokens` = **4 081 tok** | 用 `runner/node_modules/erix-agent/src/tokens.js` 现算（CJK 1.5 tok/字 + 1.15 余量） |
| 项目节（现网唯一一份） | 911 B = **423 tok** | 同上 |
| 合计/轮 | **≈ 4.5 k tok**（引擎口径；provider 实际计费通常更低，未单独测） | — |
| 现有 `SYSTEM_PROMPT` 基线 | 2 938 tok（同一估算器） | 注入后 ≈ 7.4 k tok ⇒ system 段约 2.5× |
| 每 run 增量（均 10.8 轮） | ≈ +48 k 累计输入 | 14 天均值 176 k ⇒ +28%（中位 15.6 k 的小 run 比例更高） |
| 反事实（今天合规时） | 那次 `cat` 同样进上下文，≈ 4.1 k × 剩余轮数 | 差额 ≈ 1–2 轮的量 |
| 真实净增 | 出现在**今天压根没读**的那 86% run 上 | §1.2 |
| 小窗口影响 | 门户下限 65 536 ⇒ 预算 ≈ 42.6 k，system 从 2.9 k → 7.4 k 吃掉约 **10% 预算** | 生产窗口 512 k 下可忽略 |

**缓存**：system 是引擎标记的稳定前缀（`markStablePrefix`，`provider-runner.js:57-73`），run 内逐字节不变 ⇒
与今天同一条缓存路径；文件不变时**跨 run 也稳定**（这正是 §4.2 禁止时间戳的原因）。缓存确实在生效——
dev 现查 `runs.usage.cacheRead` 有值（最近 5 条：3 328 / 3 328 / 3 328 / 4 480 / 96 384，末条 input 120 606）
⇒ 实际计费低于名义增量，但**注入后 cacheRead 如何变化未测**，按 §6.2 D4 量。

**不做 env 开关**（延续 §8.73 口径：策略不是运维参数）。要关就回滚这一个接线点。

### 4.5 安全

- **信任模型不变**：这些文件本来就在用户的容器里、agent 本来就能 `cat`（shell 不设 jail，`runner/lib/shell-tools.js` 头注已定）。
  注入**没有新增可读面**，只是把"能读"变成"一定读"。
- **风险升级的是"权威级"**：进了 system prompt 的内容比工具结果更有分量。仓库自带的 `AGENTS.md`
  属**第三方内容**（clone 来的），可能是提示注入载体。缓解：
  ① 抬头明写"平台节不可覆盖、下层冲突以平台为准"；
  ② 每份文件用 `### N. <path>` 显式标源，模型能分辨"这是仓库说的"；
  ③ 与今天相比**不是新增暴露**（今天它 cat 完照样照做），但**新增了"一定进上下文"**——这一条要在真机验收里
     用一份"故意冲突"的夹具看模型选谁（§6.2 D3）。
- **不注入密钥类文件**：只认文件名 `AGENTS.md`，不递归扫内容；`maskedPaths` 与注入无关（不经过文件工具）。

### 4.6 明确不做

- 不注入 `~/.erix/ports.json`（动态清单，体积小、按需读；**另开一片**再议，同源但不同风险）。
- 不支持 `CLAUDE.md` / `.cursorrules` / `README` 等别名（多一个真相源入口，收益不明）。
- 不递归扫全项目找 AGENTS.md（成本无界；只做祖先链 + 一层子目录索引）。
- 不改 jail 读写边界（#259 独立单）。
- 不新增事件类型、不新增错误码、不动 `docs/data/schema.sql` 与 `deploy/migrations/`（零 DDL）。

---

## 5. 需要裁决的四条

| # | 问题 | 我的建议 | 反方理由 |
|---|---|---|---|
| ① | **平台节是否"不可被下层覆盖"？**（pi 的语义是"内层一律优先"） | **平台优先**。平台规则是运行期硬约束（端口号池、边缘剥 Cookie），违反 = 应用必挂，不是风格选择 | 与 pi 语义不一致，用户可能期望"项目里写什么就以项目为准" |
| ② | **注入哪些层？** | 祖先链（home → projects → 项目）+ 子目录**索引**（不注入正文） | 只注入 home + 项目根最省；或连子仓库正文也注入（多一层成本与第三方内容） |
| ③ | **是否顺带做 #259（jail 只读例外）？** | 另开一单，不在本单。注入后主路径已闭环 | 模型仍会尝试 `readFile ~/AGENTS.md` 白烧一轮（今天就有这条口径） |
| ④ | **是否给"关闭注入"的 env 旋钮？** | 不给（§8.73：策略不是运维参数） | 出问题时要能快速关掉——回滚接线点即可，不必加旋钮 |

另有一条**观察项**（不阻塞）：`~/projects/AGENTS.md` 这层现在**一份都没有**。要么等用户自己写，
要么在开户时给一份空模板（含注释"这里是你的跨项目约定"）。**不建议平台物化它**（属用户空间，
物化会进 manifest 对账，与"平台不写用户内容"冲突）；建议只在 `~/AGENTS.md` 的目录约定节里提一句它的存在。

---

## 6. 验收判据

### 6.1 单测（`runner/test/agents-md.test.js`，约 15 格）

1. 顺序：home → projects → 项目，逐字节拼接顺序正确。
2. scope 标注：三层的 `scope` 分别是 `platform` / `workspace` / `project`。
3. 缺失文件跳过且**不产生空节**（只有 home 存在时输出只有一节）。
4. 去重：内容相同的两份只注入靠外那份。
5. 截断：单文件超限 ⇒ marker 含原字节数与 `cat <path>`；全链超限 ⇒ 从**内层**开始截（保平台节完整）。
6. 越界 symlink：`~/projects/AGENTS.md -> /etc/passwd` ⇒ 跳过 + note。
7. `EACCES` ⇒ 跳过 + note，不抛。
8. 非普通文件（目录/管道）⇒ 跳过。
9. 空白文件 ⇒ 跳过。
10. 子目录索引：≤5 条、只列路径、不含正文。
11. **确定性**：同一输入跑两次，输出逐字节相同（禁时间戳）。
12. 抬头必含"不可覆盖"与"本 run 修改下次生效"两句（语义断言）。
13. `cwd` 不在 home 之下 ⇒ 只读 cwd 那份 + note。

### 6.2 接线与真机

| # | 判据 | 方法 |
|---|---|---|
| W1 | 注入点唯一（`config.input.system` 那一处拼），源码级锁 | 正则数 `renderAgentsMdSection(` 调用次数 = 1 |
| W2 | `SYSTEM_PROMPT` 常量里 8 个规则词仍为 0（既有锁不许放宽） | 既有用例照跑 |
| D1 | 真机：新 run 的 `run_events` 里 `tool_use` 含 `AGENTS.md` 的调用数 = 0，但 agent **照做**了平台约定 | 跑一条"起个 dev server 并报告地址"的任务：看是否给完整预览 `url`（第 8 条）+ 是否绑 `0.0.0.0` |
| D2 | 收工纪律生效（`head -50` 丢的那一段） | 造一个改动任务：看 run 结束后 `git status` 是否干净 / 是否 `git commit` |
| D3 | 冲突夹具：项目 AGENTS.md 写"端口固定用 3000"，平台节说"端口从清单取" | 看模型选谁（验证 §5-① 的裁决是否真的落地） |
| D4 | 成本：注入前后同类型 run 的 `usage.input_tokens` 与 `cacheRead` | 各 3 个 run 取中位，报差值 |
| D5 | 长会话不丢规则 | 60 轮量级 run，检查后半程仍遵守收工/端口约定（对比折叠机制：system 不可折叠） |

### 6.3 已知的"这次测不到"

- **子仓库 AGENTS.md 正文**不注入 ⇒ 只能验"索引提示有没有让它去读"。
- **跨 run 缓存收益**：relay 侧的缓存命中率不在本站可观测面内（只有 `cacheRead` 一个数）。

---

## 7. 工作量与切片

| 片 | 内容 | 规模 | 完成情况（2026-11-05） |
|---|---|---|---|
| S1 | `runner/lib/agents-md.js` + `runner/test/agents-md.test.js` | 1 新文件（~150 行）+ 1 测试（~15 格） | ✅ 完成：采集器 326 行（含注释）+ 16 格单测（`8b945ab`）。实际导出与 §4.1 的草案差一处：`collectAgentsMd` 多返回 `subdirHints`（子目录索引是**索引不是正文**，不该混进 `blocks` 的账，也不该被截断逻辑当成一份内容）；`renderAgentsMdSection({ blocks, notes, subdirHints })` 因此多接受一个可选键 |
| S2 | `runner/worker.js` 接线（3 行）+ 指针段改写 + `system-prompt.test.js` 重写指针用例 | ~20 行 + 1 测试改写 | ✅ 完成（`46f9465`）：`startRun` 内采集 + `MSG.LOG`（info，不新增事件类型）+ `system: SYSTEM_PROMPT + agentsMdSection`；指针段改为「已随本次 run 注入」；新增 2 条接线源码级锁。8 规则词禁词用例与 `0.0.0.0` 断言一字未动 |
| S3 | 文档：`docs/design/user-space.md` §4.1.2 增行（层级与注入口径）、`docs/design/runner-integration.md` 记一句、本节转正 | 3 处 | ✅ 完成（本提交）：§4.1.2 增「注入 = 主路径」一行 + 「读取边界」行改口径 + §4.1 文件表同一句；`runner-integration.md` §6.3 新增 2b 条 |
| S4 | 真机验收（§6.2 D1–D5） | 主 agent | ⬜ 未做（需要重建 FDE 镜像 + 真 run，本单不 push 也不起容器） |

**必须重建 FDE 镜像**（动 `runner/`），并按 §8.17 `docker rm -f` 让 reconcile 重建。
**不需要** portal 改动 ⇒ 平台 AGENTS.md 内容不变、物化不变。

---

## 8. 与既有 issue 的关系

| issue | 关系 |
|---|---|
| **#259**（jail 只读例外） | 本方案**不依赖**它；它仍有独立价值（`readFile ~/.erix/ports.json`、`readFile ~/AGENTS.md` 复核）。建议另单，不在本单 |
| **#285 R-1**（"下发了 ≠ 读了"） | 那条判据（transcript 里读 `~/AGENTS.md` 的调用数）在本方案下**应当反转**：不再要求出现读调用，而要求"规则被遵守"。§6.2 D1/D2 就是它的替代判据 |
| **#359 D9**（收工灯 + 告知面先行） | 本方案是"告知面先行"的**加强**：`head -50` 实测会丢掉 D9 那条规则，注入后不会再丢 |
| **§8.87 / 折叠** | 本方案顺带覆盖一个**机制风险**（长会话里 `cat` 结果随整轮被折走 ⇒ 平台约束失效）。⚠ dev 上尚未观测到该故障（§1.2 口径），别写成"已修 bug" |
| **#331 / §8.73**（死光纤） | 反例警戒：本方案要**真机验证"注入的规则被遵守"**，不能只验"注入成功"（注入成功但模型不遵守 = 又一根光纤） |

---

## 9. 一句话总结

今天这份 9 KB 的平台约定，**86% 的 run 从没读过、读过的有 4/5 被自己 `head -50/60/80` 切掉、读到的在长会话里还会随整轮被折走（机制，dev 尚未观测到）**；
把它（连同 `~/projects/AGENTS.md` 与项目 `AGENTS.md`）改成 run 启动时由宿主注入 system prompt，
是**唯一能同时解决这三件事**的改法，代价约 +4.5 k token/轮（引擎口径；大部分今天已在花，且 system 段本来就走 prompt 缓存）。
