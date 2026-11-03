// issue #421：引擎「诊断类」事件的宿主侧嘴（runner 这一半）。
//
// 为什么要有这个文件：erix-agent 对宿主承诺 **27 类事件**（`LoopEvent` 联合类型，0.30.0 的
// `src/loop/orchestrator.js` —— #438 切片 B 起由 `portal/test/event-surface-contract.test.js`
// 从已安装引擎源码解析，不再手抄；#442 把 19 类追到 27 类），本站此前只有 11 类订得到——`compaction_strategy_fallback`、
// `model_metadata_missing`、`persistence_capability_degraded`、`resume_journal_skipped`、
// `run_outcome` 这 5 类**每一轮都在往 `run_events` 里写，但前端一条都收不到**（写入侧不过白名单，
// 读侧白名单里没有它们）。#421 把界面那一半补齐；本文件补的是**运维那一半**：只读 LOG 的人
// 也必须能看见这五件事，否则「界面没接」就变成「世界上没人知道」。
// #438 切片 B 又把 0.29 新增的三类接进本文件（`compaction_deferred` / `budget_below_working_set` /
// `config_override_conflict`），口径同上：级别按「每轮都有就 info，异常才 warn」判。
//
// 口径与 `worker.js` 的 `foldDegradeNotice` 完全一致：
//   · **只描述事实，不改终态、不改事件**（这些都是诊断，不是 run 失败）；
//   · **只读契约里真存在的键**，每个键名旁边注明发射点行号；判据 `test/engine-notices.test.js`
//     逐条对账。前例本站栽过两次：`payload.chars` 与 `foldSummary.unshrinkable` 都是本站按记忆
//     造的键——推测键的后果不是报错，是**永不触发**（见 AGENTS §8.73）；
//   · 数字没给就写 `?`，绝不拿 0 冒充（#283）；
//   · 外来标识符（`method` / `reason` / `termination.reason`）要过形状闸，绝不 `String(对象)`
//     把 `[object Object]` 渗进日志（#261）。

/** 没给的数一律 `?`，不拿 0 冒充（#283 口径）。 */
const num = (v) => (Number.isSafeInteger(v) ? String(v) : '?');

/** 引擎侧的标识符/枚举值形状（`saveRunSnapshot` / `crash_round_assistant_not_in_ledger` / `end_turn`）。 */
const TOKEN_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
/** 外来字符串过形状闸，不合格就 `?`——不 `String()` 强转，不截断半截（宁可信息少，不可渗脏数据）。 */
const token = (v) => (typeof v === 'string' && TOKEN_RE.test(v) ? v : '?');

/**
 * 把一个引擎事件翻成一行运维可读的告警。
 *
 * @param {object|undefined} event `runToolLoop` 的 `onEvent` 入参（`LoopEvent`）
 * @returns {{ level: 'warn'|'info', msg: string }|null} `null` = 这类事件本模块不管（不是诊断）
 */
export function engineDiagnosticNotice(event) {
  if (!event || typeof event !== 'object') return null;
  switch (event.type) {
    // 配的策略没生效，实际跑的是引擎库层默认 `sliding-window`（整轮丢头、不摘要）。
    // 发射点 `orchestrator.js:3193`，载荷 `{ runId?, round, detail }`。
    // ⚠ 本站恒配 `context.strategy` ⇒ 这条响了就说明**本站的配置没送到引擎**，
    //    正是 #392 那个回归的机读信号（上游 #464-A 专门造的）。
    case 'compaction_strategy_fallback':
      return {
        level: 'warn',
        msg: `compaction strategy fallback: the configured context.strategy did NOT take effect; `
          + `engine default "sliding-window" is dropping whole head rounds without summarising (round ${num(event.round)})`,
      };
    // 模型元数据取不到 ⇒ 压缩闸门与聚合输出预算整条 run 关闭。发射点 `orchestrator.js:1040`，
    // 载荷 `{ runId, detail }`——**没有 `round`**，别编一个。
    // 本站的 #309/#316 行为级测早就把它当判据（"压缩关掉必须是可观测的"），但今天只有测试看得见。
    case 'model_metadata_missing':
      return {
        level: 'warn',
        msg: 'model metadata missing: compaction and aggregate output budget are disabled for this run',
      };
    // 宿主 store 缺某个持久化能力 ⇒ 那一步整个 run 跳过（= 中途崩溃不可恢复）。
    // 发射点 `orchestrator.js:1011`，载荷 `{ runId, method, detail }`。
    // 本站实现了 `saveRunSnapshot` ⇒ 今天不响；一响就是 portal 侧 store 面回退了。
    case 'persistence_capability_degraded':
      return {
        level: 'warn',
        msg: `store capability degraded: store does not implement "${token(event.method)}"; `
          + 'that persistence is skipped for this run (mid-run crash resume unavailable)',
      };
    // 崩溃那一轮的助手消息不在账上 ⇒ 那批工具结果本次没入账，下次恢复靠快照兜。
    // 发射点 `orchestrator.js:2525`，载荷 `{ runId, round, reason, count }`。
    case 'resume_journal_skipped':
      return {
        level: 'warn',
        msg: `resume journal skipped: ${num(event.count)} tool result(s) of crash round ${num(event.round)} `
          + `were not written to the ledger (reason=${token(event.reason)}); the next resume relies on the run snapshot`,
      };
    // run 级终局汇总，**每个 run 恰好一条**（`runOutcomeEmitted` 去重；正常终局走
    // `termination.js:700`，抛错终局走 `orchestrator.js:1197`）。载荷
    // `{ runId?, model?, judgeModel?, rounds?, judgeRecordCount?, termination?, verification? }`
    // （`judge-record.js:105`）。它是账不是告警 ⇒ `info`，别把每轮都有的东西刷成 warn。
    case 'run_outcome': {
      const termination = event.termination && typeof event.termination === 'object' ? event.termination : null;
      return {
        level: 'info',
        msg: `run outcome: reason=${token(termination?.reason)} rounds=${num(event.rounds)}`
          + ` judgeRecords=${num(event.judgeRecordCount)}`,
      };
    }
    // ---- issue #438 切片 B（erix-agent 0.29.0）：`LoopEvent` 联合类型新增的三类 ----
    // 发射点 `orchestrator.js:4884`，载荷 `{ runId?, round, reason, detail }`。
    // 语义：本轮**没折**（请求尾部是没结清的 tool_use，折了就会把半截工具调用写成摘要）。
    // 正常形态、每轮最多一条 ⇒ `info`；一响就说明这轮请求可能按本地估算超预算。
    case 'compaction_deferred':
      return {
        level: 'info',
        msg: `compaction deferred: round ${num(event.round)} was not folded (reason=${token(event.reason)});`
          + ' the next round folds the completed round',
      };
    // 发射点 `orchestrator.js:4056`，载荷 `{ runId?, round, budgetTokens, workingSetTokens,
    // suggestedBudgetTokens, repeatStreak, foldLayersOverBudget, attempts, detail }`。
    // 语义：连续几次折叠后工作集本身仍超预算 ⇒ 引擎判定「预算装不下模型手上的东西」并提前收尾。
    // 这是**配置配小了**（异常）⇒ `warn`，并带上引擎自己给的「该配多少」，别让运维去反推。
    case 'budget_below_working_set':
      return {
        level: 'warn',
        msg: `budget below working set: working set ${num(event.workingSetTokens)} tokens > budget`
          + ` ${num(event.budgetTokens)} tokens for ${num(event.attempts)} consecutive attempt(s)`
          + ` (round ${num(event.round)}); suggested budget >= ${num(event.suggestedBudgetTokens)}`
          + ' — the run ends early instead of re-reading until max_rounds_cap',
      };
    // 发射点 `orchestrator.js:1271`，载荷 `{ runId?, conflicts: [{path, key}], detail }`。
    // 语义：`config.*` 与同名扁平键（或调用级 config 与装配口 policy.config）同时给了**不同的值**。
    // 本站只写 `config.<组>.<叶>` ⇒ 结构上不可能出现；一响就是宿主代码 bug ⇒ `warn`。
    // `path` 是外来字符串（形如 `run.maxRounds` / `hooks.onEvent`）⇒ 逐条过形状闸，不合格写 `?`。
    case 'config_override_conflict': {
      // 数组缺席 ≠ 零条冲突：引擎只在 `conflicts.length > 0` 时才发这条事件，所以「键不在」
      // 只能是形状漂移 ⇒ 写 `?`，绝不拿 0 冒充（#283）。
      const conflicts = Array.isArray(event.conflicts) ? event.conflicts : null;
      const paths = (conflicts ?? [])
        .slice(0, 8)
        .map((entry) => token(entry && typeof entry === 'object' ? entry.path : entry))
        .join(', ');
      return {
        level: 'warn',
        msg: `config override conflict: ${conflicts === null ? '?' : num(conflicts.length)}`
          + ' leaf/leaves set by two sources with different values'
          + ` (${paths === '' ? '?' : paths}); config.* wins, the flat spelling is still accepted`,
      };
    }
    // ---- issue #442（erix-agent 0.30.0）：`LoopEvent` 27 类里的 5 个新类型（运维那一半）----
    // 其中前三个在本站**结构上不产生**，接它们是为了「一响就是宿主代码出错了」这个信号不被吞：
    //   · `final_guard_extend`：guard 专属（两个发射点都在 guard 裁决后的扩轮路径：
    //     `orchestrator.js:4744` 的 revise 补跑 / `:4849` 的交付物补齐）。本站**不传 `finalGuard`**
    //     ⇒ 结构上不产生；真响了就说明有人给 runToolLoop 接上了 guard（那不是小事，得看）。
    //   · `context_unknown_option`：唯一发射点在 `createAssemblyPort`（`assembly.js:999`，走 `port.emit`）。
    //     本站从不走装配口（直连 `runToolLoop`，见 `lib/compact-knobs.js`）⇒ 同样结构上不产生。
    //   · `tool_output_aggregate`：正常形态、每轮可多条 ⇒ `info`（不占 warn 面）。
    //   · `continuity_write_failed`：要 `config.continuity.handoff` 打开才走得到 ⇒ `warn`（真响了就是落盘失败）。
    // ⚠ `continuity_written` / `continuity_injection_skipped` **故意不接**：它们是「续接块写了 / 本轮没注入」的
    //   展示类事实（且本站 handoff=off ⇒ 永不发生），不是告警。不接 = 明确豁免，不是漏（理由在
    //   `portal/test/event-surface-contract.test.js` 的豁免表）。
    case 'final_guard_extend':
      return {
        level: 'warn',
        msg: `final guard extension: the engine gave this run one more round for a guard decision`
          + ` (round ${num(event.round)}, max rounds ${num(event.from_max_rounds)} -> ${num(event.to_max_rounds)},`
          + ` trigger=${event.guard_extension === true ? 'guard_revise' : token(event.reason)})`
          + ' — this host never passes finalGuard, so seeing this means a guard was wired in somewhere',
      };
    case 'context_unknown_option': {
      // 载荷 `{ keys: [...], note }`（`assembly.js:999`）。`keys` 是外来字符串数组 ⇒ 逐条过形状闸。
      const keys = Array.isArray(event.keys) ? event.keys : null;
      const listed = (keys ?? []).slice(0, 8).map((key) => token(key)).join(', ');
      return {
        level: 'warn',
        msg: `unknown context option(s): ${keys === null ? '?' : num(keys.length)} key(s) in the assembly`
          + ` port's context are not recognised engine knobs (${listed === '' ? '?' : listed})`
          + ' — this host never builds the assembly port, so seeing this means that changed',
      };
    }
    case 'tool_output_aggregate':
      // 载荷（`run-snapshot-executor.js:218`）：`{round, toolUseId, name, action, reason, budgetTokens,
      // inlineTokens, costTokens, projectedTokens, contentLength, archivedBytes?}`。
      // `action` 是封闭枚举（`archived` / `stub` / `stub_kept` / `unrecoverable`）⇒ 过形状闸。
      return {
        level: 'info',
        msg: `tool output aggregate: round ${num(event.round)} output ${token(event.action)}`
          + ` (reason=${token(event.reason)}, name=${token(event.name)}, contentLength=${num(event.contentLength)},`
          + ` inline=${num(event.inlineTokens)}/budget=${num(event.budgetTokens)} tokens)`,
      };
    case 'continuity_write_failed':
      // 发射点 `orchestrator.js:3277` / `:3355` / `:3401`（只在 `config.continuity.handoff` 打开时走）。
      // 本站 handoff=off ⇒ 永不发生；一响就是「有人开了 continuity 且落盘失败」。
      return {
        level: 'warn',
        msg: `continuity write failed (round ${num(event.round)}): the handoff block was not persisted;`
          + ' the next resume may lack it (this host runs with continuity.handoff=off, so this is unexpected)',
      };
    // 发射点 `orchestrator.js:2716`，载荷 `{ runId?, parentRunId?, round, channel, reason, detail }`。
    // 语义：请求视图违反「必须有 user 轮」不变式且所有回补都失败 ⇒ **请求原样发出**，上游多半 400。
    // 它也是界面那一半（中性分隔行）的那一条：日志与界面同一个事实、两张嘴（口径同 #421）。
    case 'user_turn_guard_unrecoverable':
      return {
        level: 'warn',
        msg: `user turn guard unrecoverable: round ${num(event.round)} request view still violates the`
          + ` user-turn invariant (channel=${token(event.channel)}, reason=${token(event.reason)});`
          + ' the request is sent unchanged and an upstream that requires a user query will reject it',
      };
    default:
      return null;
  }
}

/**
 * issue #442（erix-agent **0.30.0** / 上游 #661）：**折叠摘要器失败 ⇒ 本次 run 失败**（不是降级）。
 *
 * 为什么这条单独一个函数、而不是 `engineDiagnosticNotice` 里的一个 `case`：它**不是事件**。
 * 0.30.0 起 `fold-llm` 的摘要器失败不再返回一份「降级为统计摘要」的替代物，而是抛
 * `KitError("summarizer_failed")` ⇒ run 以 `termination.reason === 'failed'` /
 * `termination.errorCode === 'summarizer_failed'` 收场（CHANGELOG 的 Breaking 段；
 * 那条失败路径**一个 compaction 事件都不发**，所以事件侧没有任何东西可接）。
 *
 * 病灶（用户原话，issue #661）：*LLM 做摘要失败了必须报错好让用户知道，不然静默着跑，质量差，
 * 也没人发现问题。* 界面那一半是 `run_end` 的红色 `.syserr`（前端把 `summarizer_failed` 翻成人话）；
 * 本函数是**运维那一半**：只读 LOG 的人必须能看见「这次失败是折叠摘要器挂了」，
 * 而不是一条 `run failed: failed` 的裸账。
 *
 * 判据（`test/engine-notices.test.js` 的 S1）：模拟该终局 ⇒ 有 LOG；别的失败 ⇒ `null`。
 *
 * @param {{ termination?: unknown, error?: unknown }} input worker 的失败终态片段
 * @returns {{ level: 'warn', msg: string }|null} `null` = 不是「摘要器失败」这一类终局
 */
export function summarizerFailureNotice(input) {
  // `input` 可能是 `null` / `undefined`（旧调用点）⇒ 显式兜底，别让默认参数在 null 上失效。
  const { termination, error } = input ?? {};
  const term = termination && typeof termination === 'object' ? termination : {};
  const err = error && typeof error === 'object' ? error : {};
  // 两个来源都要认：引擎把码挂在 `termination.errorCode` 上（0.30.0 的契约），
  // worker 自己的 `error.code` 是同一份码的宿主侧镜像（`buildFailureEnvelope` 从 `err.code` 取）。
  // 任一处命中就算这一类——只认一处会在「引擎改了挂载点」时静默漏掉。
  const summarizerFailed = term.errorCode === 'summarizer_failed' || err.code === 'summarizer_failed';
  if (!summarizerFailed) return null;
  // `details.kind` 是引擎给的归因分类（`fold-llm.js` 的 `classifyFoldDegradeKind`，四值封闭枚举）：
  // timeout / context_window_exceeded / empty_summary / error。它现在住在**异常**上
  // （CHANGELOG：「`budgetExhausted` moves to `details.budgetExhausted`」，同一条搬家规则）。
  const kind = err.details && typeof err.details === 'object' ? err.details.kind : undefined;
  return {
    level: 'warn',
    msg: `fold summarizer failed: the LLM compaction summarizer failed, so THIS RUN FAILED`
      + ` (reason=${token(term.reason)}, errorCode=summarizer_failed, kind=${token(kind)})`
      + ' — this is a terminal error, not a degraded statistical summary; nothing from the failed fold'
      + ' was applied and the context was NOT compacted (retry the run)',
  };
}
