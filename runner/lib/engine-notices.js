// issue #421：引擎「诊断类」事件的宿主侧嘴（runner 这一半）。
//
// 为什么要有这个文件：erix-agent 对宿主承诺 **16 类事件**（`LoopEvent` 联合类型，
// `src/loop/orchestrator.js:297`），本站此前只有 11 类订得到——`compaction_strategy_fallback`、
// `model_metadata_missing`、`persistence_capability_degraded`、`resume_journal_skipped`、
// `run_outcome` 这 5 类**每一轮都在往 `run_events` 里写，但前端一条都收不到**（写入侧不过白名单，
// 读侧白名单里没有它们）。#421 把界面那一半补齐；本文件补的是**运维那一半**：只读 LOG 的人
// 也必须能看见这五件事，否则「界面没接」就变成「世界上没人知道」。
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
    default:
      return null;
  }
}
