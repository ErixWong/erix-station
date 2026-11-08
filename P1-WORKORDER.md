# 工单 · P1 宿主：把 erix-agent delegation 接进 runner

> 派单：主 agent。日期 2026-11-08。分支 `feat-261108-01-delegate-p1`，worktree `/home/eric/projects/wt-del1`。
> **设计文档（必读，先全文读完）**：`docs/design/delegation-2026-11-08.md`（已在 worktree 里）。
> 本工单只做 **P1 = 宿主（`runner/`）+ 环境变量下发面**。**P2/P3（portal / 前端）不在本单**，一个字节都不要碰 `portal/`。

## 0. 前置

```bash
cd /home/eric/projects/wt-del1
npm ci --prefer-offline                 # 根依赖（worktree 不自带 node_modules）
cd runner && npm ci --prefer-offline     # runner 依赖（含 erix-agent 0.31.0）
```

- **不要**改 `package.json` 的 version、**不要**动 lockfile、**不要**加依赖。
- 测试命令一律带 timeout：
  - 根：`timeout 600 npm test`
  - runner：`timeout 600 node --test runner/test/*.test.js`（**不要**用 `node --test runner/test/` 目录形式，本机是坏的）
- 判绿 = **退出码 0**，不是 grep 摘要行。

## 1. 要交付的东西（6 个文件）

| 文件 | 动作 |
|---|---|
| `runner/lib/delegation.js` | **新建**（见 §2） |
| `runner/worker.js` | 改 5 处（见 §3） |
| `runner/lib/config.js` | 加 4 个 env 解析（见 §4） |
| `portal/src/provisioner.js` | 加 4 行 env 注入（**只加 env，不动别的**） |
| `deploy/fde-proxy/server.js` | `ENV_KEY_ALLOW` 加 4 个键（**§8.70 那个事故的同型坑，漏了就是 `create_policy_denied`**） |
| `docs/env.md` | 4 个 env 登记（照既有条目格式） |

测试文件（新建）：

- `runner/test/delegation.test.js` —— 10 条红格判据（见 §5）
- `portal/test/deploy-env-delegate.test.js` —— 交叉核对：provisioner 可能注入的 `ERIX_DELEGATE_*` 必须 ⊆ `fde-proxy` 的 `ENV_KEY_ALLOW`（照 §8.70 的既有交叉核对测试手法，先找到它照抄形状）

## 2. `runner/lib/delegation.js`（核心）

导出：

```js
export function createStationDelegation({
  parentRunId,      // 真 runId（不是 transcriptKey）
  parentCwd,
  home,             // process.env.HOME || '/home/erix'
  provider,         // 父的 provider 实例，原样复用
  tools,            // 父的工具面（schema 数组），内部装配时**剔掉 name === 'delegate'**
  executeTool,      // 父的 executeTool（子工具执行用；子工具面不含 delegate ⇒ 不会递归）
  modelMetadata,    // 与父同源（可能 undefined）
  maxTokens,        // 与父同源（可能 undefined）
  childMaxRounds,   // 默认 8
  childDeadlineMs,  // 默认 240_000（必须 < watchdog 300_000）
  maxConcurrent,    // 默认 2
  parentSignal,     // 父 abortController.signal
  onChildLiveness,  // (childRunId) => void，内部节流 ≥15s 调一次
  logger,           // (level, msg, fields) => void
})
```

返回 `{ definition, execute, takeChildUsage, dispose }`：

- `definition` = `DELEGATE_DEFINITION`（从 `erix-agent/tools` 导入的 `createDelegateTool` 的产出里取；
  **确认**：`createDelegateTool(...)` 的返回形状要先探针看清，再决定怎么拿 definition / execute）。
- `execute(input, context)` = 调库的 `execute`（或等价入口），把 `context` 原样递进去。
- `takeChildUsage()` = 取走并清零子 usage 累加器（`{input_tokens, output_tokens, cacheRead?, cacheWrite?}` 逐字段相加）。
- `dispose()` = 清租约（若库提供 `release`/`dispose`；没有就空实现 + 注释说明）。

### 2.1 目录（唯一真相，门户 P2 会按同一布局读）

```
home/delegation/roster/<parentRunId>/   → rosterDir
home/delegation/leases                  → leaseDir（每 FDE 共享）
home/delegation/transcripts             → 子账本目录
```

`transcriptPathFor: (runId) => path.join(transcriptsDir, runId + '.jsonl')`
（`sub-<uuid>` 过引擎 `safeRunId` 恒等；**测试里必须用真 `createFileTranscriptStore` 反证一次**
——写一条记录后断言该路径真的存在，防止手拼与引擎口径漂移）。

### 2.2 `runChild`

```js
const childStore = createFileTranscriptStore({ dir: transcriptsDir });   // 包根导出
const childSignal = AbortSignal.any([request.signal, parentSignal]);     // Node 22 有
const result = await runToolLoop({
  provider,
  tools: childTools,              // 父 tools 剔掉 delegate
  executeTool,                    // 父的（子工具面里没有 delegate ⇒ 不递归）
  store: childStore,
  signal: childSignal,
  config: {
    run: { runId: request.runId, parentRunId, cwd: childCwd,
           maxRounds: childMaxRounds, stream: true,
           replayPolicy: 'per-tool-declaration' },
    ...(modelMetadata ? { metadata: modelMetadata } : {}),
    ...(maxTokens ? { tuning: { maxTokens } } : {}),
    folding: { context: { strategy: 'fold-llm', keepRounds: 6 } },
    timing: { deadlineMs: Date.now() + (request.deadlineMs ?? childDeadlineMs) },  // 绝对时刻
  },
  onEvent: () => onChildLiveness(request.runId),   // 只保活，**不转发事件**
});
```

返回：

```js
return {
  text: typeof result.finalText === 'string' ? result.finalText : '',
  termination: normalizeTermination(result.termination),   // ← 见 2.3
  usage: result.usage,
  rounds: result.rounds,
};
```

**抛错必须归一成正常返回**（库会写 `state=failed` + `errorMessage`，父 run 不因此失败）：

```js
catch (err) {
  return { text: '', termination: normalizeTermination(err?.termination) ?? 'failed',
           error: String(err?.message ?? err) };
}
```

⚠ 库要求 `termination` 是**字符串**；`runChild` 抛错时库自己写 `failed`，所以这里返回字符串即可。

### 2.3 `normalizeTermination`（本单最高危的一格）

引擎 reason 全集（10 值）→ 名册词汇（7 值）。**必须显式**处理这三个，不许依赖库的默认 `failed`：

| 引擎 reason | 名册 state | 理由 |
|---|---|---|
| `end_turn` / `judge_done` | `completed` | 库已对 |
| `aborted` | `aborted` | 库已对 |
| `no_tool` | **`completed`** | 本站当正常收尾（`portal/frontend/src/lib/terminationReasons.ts:117-124` 不在 FAIL 集合） |
| `continuation_exhausted` | **`completed`** | 同上（灰，不是故障） |
| `max_rounds_cap` / `stall` / `failed` / `persistence_failed` / `final_guard_unverified` | `failed` | 库已对（后两者本站判红） |

实现：`runChild` 里把 `no_tool` / `continuation_exhausted` 归一成 `end_turn` 再交给库
（**不许**改库、**不许**自造新词）。同时在名册外另存原始 reason（`usage`/DTO 面 P2 用）——
最简单：`runChild` 返回对象里带 `termination`（归一后）+ `terminationReason`（原始），库会忽略未知键。

### 2.4 其它端口

- `cwdFor: (requested) => path.resolve(requested ?? parentCwd)`（P1 不校验；越界由 jail 在工具层拒）
- `isProcessAlive`：照 `runner/node_modules/erix-agent/bin/delegation.js:83-101` 的语义
  （`kill(pid,0)` 成功=活、`EPERM`=活、`ESRCH`=死、其它错误码=**算活**）
- `notifyParent`：P1 只 `logger('warn', 'delegate child finished', { childRunId, state })`，**不投递**
- `clock: Date.now`
- `maxConcurrent`、`leaseMaxAgeMs` 用库默认/入参

## 3. `runner/worker.js`（5 处，别扩散）

1. **装配**（`createToolRegistry` 之后、`runToolLoop` 之前）：`process.env.ERIX_DELEGATE_ENABLED === '1'` 才建。
2. **工具面**（`:626` 那一行）：追加 `...(delegation ? [delegation.definition] : [])`。
3. **路由**（`:634-660` 的 `executeTool`）：加 `delegate` 独立分支
   `return delegation.execute(input, options?.context ?? {})`，**不要**进 `registry.executors`。
4. **usage 合并**（`:1023` 附近，`RUN_FINISHED` 之前）：把 `delegation.takeChildUsage()` 逐字段加进
   `result.usage`（`input_tokens` / `output_tokens` / `cacheRead` / `cacheWrite`；缺字段按 0）。
   ⚠ **必须改的是发给 portal 的那份**，不要改 `result` 本体影响别处。
5. **保活 + 中止**：`onChildLiveness` → `sendIpc({ type: MSG.SHELL_LIVENESS, run_id: runId,
   phase: 'heartbeat', command: 'delegate:' + childRunId })`（内部节流 ≥15s）；
   `parentSignal` 传 `abortController.signal`。

## 4. env（4 个）

`runner/lib/config.js` 照既有 `parseIntEnv` 风格加：

| env | 默认 | 边界 |
|---|---|---|
| `ERIX_DELEGATE_ENABLED` | `0` | 只有 `'1'` 算开 |
| `ERIX_DELEGATE_MAX` | `2` | 1..8，越界钳到边界 + warn |
| `ERIX_DELEGATE_CHILD_ROUNDS` | `8` | 1..32 |
| `ERIX_DELEGATE_CHILD_TIMEOUT_MS` | `240000` | 1000..240000（**上限必须 < 300000 watchdog**，钳住并 warn） |

`portal/src/provisioner.js`：在 `ERIX_MAX_ROUNDS` / `ERIX_AGENTD_CAPACITY` 那两行旁边加 4 行
（**只在 `ERIX_DELEGATE_ENABLED` 为开时才下发其余三个**，或者四个都下发也行——但值必须来自
portal 自己的 `process.env`，不许硬编码 `1`）。

`deploy/fde-proxy/server.js:79` 的 `ENV_KEY_ALLOW` 加这 4 个键。

## 5. 10 条红格判据（每条都必须写成「变异会红」的测试）

1. **父身份是真 runId**：名册记录 `parentRunId === 本站 runId`，**不是** sessionId。
   变异：路由里摘掉 `options.context` ⇒ 红。
2. **对象 termination 不静默 failed**：子以 `end_turn` 收尾 ⇒ 名册 `completed`。
   变异：`termination: result.termination`（对象）⇒ `failed` ⇒ 红。
3. **`no_tool` 不判失败**：子以 `no_tool` 收尾 ⇒ 名册 `completed`。
   变异：删掉归一 ⇒ `failed` ⇒ 红。
4. **配额跨进程**：同一 `leaseDir`，第 3 个子 `capacity_full` 且带 `holders`。
   变异：`leaseDir` 放 per-run ⇒ 第三个成功 ⇒ 红。
5. **父停 ⇒ 子死**：`parentSignal` abort ⇒ 子 `runToolLoop` 的 signal 已 aborted、名册落 `aborted`。
   变异：不串 signal ⇒ 子跑完 ⇒ 红。
6. **usage 不漏账**：子 usage 出现在 `RUN_FINISHED.usage`（逐字段相加）。
   变异：不累加 ⇒ 红。
7. **默认关**：`ERIX_DELEGATE_ENABLED` 未设 ⇒ `tools` 与今天逐字相同（`delegate` 不在）。
   变异：默认开 ⇒ 红。
8. **不递归**：子的 `tools` 里没有 `delegate`。变异：不剔 ⇒ 红。
9. **`deadlineMs` 换算**：`config.timing.deadlineMs ≈ Date.now() + budget`（差 < 5s）。
   变异：直接透传 budget ⇒ 红。
10. **保活节流**：子跑 60s 期间 `onChildLiveness` 被调 ≥1 次且 ≤5 次（15s 节流）。
    变异：去掉节流 ⇒ 次数爆 ⇒ 红；去掉保活 ⇒ 0 次 ⇒ 红。

**测试怎么跑真 `runToolLoop`**：照 `runner/test/replay-policy.test.js` 的手法（桩 provider + 内存/文件 store），
**不要**连网、不要连 DB。子 run 的 provider 用桩，返回固定 tool_calls / 文本。

## 6. 不许做的事

- 不碰 `portal/src/`（除 provisioner 那 4 行）、不碰 `portal/frontend/`、不碰 `docs/data/schema.sql`、不碰 `deploy/migrations/`。
- 不加新事件类型、不加新错误码、不改 `runner/lib/termination.js`、不改 `portal/frontend/src/lib/terminationReasons.ts`。
- 不给子装 `notes` 工具（P1 刻意：避免父子并发写同一批笔记）。
- 不做 `notifyParent` 投递、不做 UI、不做 DDL、不做名册 TTL 清理、不做递归 delegate。
- 不改 `package.json` / lockfile / version。

## 7. 交付与提交纪律

- **每完成一个里程碑就 commit 一次**（撞超时不会丢）：
  1. `feat(delegate): 宿主装配骨架 + 目录布局`
  2. `feat(delegate): runChild 嵌套 runToolLoop + 归一`
  3. `feat(delegate): worker 接线（工具面/路由/usage/保活/中止）`
  4. `feat(delegate): env 下发面（config/provisioner/fde-proxy/docs）`
  5. `test(delegate): 10 条红格`
  6. `docs(agents): 无`（AGENTS 台账由主 agent 写，**你不要改 AGENTS.md**）
- 提交信息用中文摘要 + conventional 前缀。
- 收尾必须给出：**每条的变异验证结果**（改了什么、哪条用例红了、还原后是否全绿）+ 三套基线数字
  （根 `npm test` / `node --test runner/test/*.test.js` 的通过/失败/跳过数）+ `git diff --numstat` 汇总。
- **不要** push、不要开 PR（主 agent 验收后再做）。

## 8. 报告格式（写到 worktree 根的 `P1-REPORT.md`，并在终局消息里给摘要）

第一格固定 `## 取证边界`（实际打开的文件路径；打不开写 `BLOCKED: <路径>` 并停下）。
然后：`## 落点` / `## 10 条红格与变异` / `## 基线` / `## 未验证` / `## 偏离设计之处（如有，逐条给理由）`。
每条结论带 `file:line`。
