// issue #212：引擎 termination reason / run 错误码的**单一真相常量**（防漂移锚点）。
//
// 为什么落点在「前端 src/lib 内的 .ts」（决策记录，主 agent 已定稿）：
//   1. 唯一在**运行时**需要它的消费方是前端——`RUN_FAIL_REASONS` 决定 run_end 走红色告警还是
//      灰色中性分隔条（useEventStream.ts 的 run_end 分支）。常量放在前端，红色集合就能由
//      全集**派生**（见文件末尾的子集推导），不再手抄第二份枚举。
//   2. 后端测试能直接吃这个 .ts：Node 22 自带 TypeScript 类型剥离，`portal/test/*.test.js`
//      里 `import ... from '../frontend/src/lib/terminationReasons.ts'` 直接可跑（本机
//      v22.23.2 实测通过），不需要构建步骤、不新增 devDependency。反向（TS 引 .js/.mjs）
//      要开 allowJs 或补 .d.ts，成本更高。
//   3. 镜像构建上下文互不可见：`portal/Dockerfile` 的 frontend-builder 阶段只
//      `COPY portal/frontend/ ./`，`runner/Dockerfile` 只 COPY runner/*。放在
//      `portal/frontend/` 之外的物理文件，前端产物在镜像里根本 import 不到
//      （放 docs/*.json 会让前端镜像构建挂）。→ 前端目录内的 TS 是唯一「前端运行时 +
//      前端 vitest + 后端 node --test」三端都能消费的落点。
//   ⚠️ 约束：本文件只允许 **erasable** 的 TS 语法（无 enum / namespace / 构造器参数属性），
//      且不得 import 任何运行时依赖——否则 `node --test` 直读会挂。由
//      `portal/test/termination-contract.test.js` 的「零 import」断言钉住。
//
// 真值来源（引擎 0.22.0，逐值定位；0.18.0 → 0.19.0 → 0.20.0 → 0.22.0 四次复核：reason 全集**一字未变**）：
//   * JSDoc 9 值：`erix-agent/src/loop/orchestrator.js:447-448`（runToolLoop 返回值 typedef。
//     0.18.0 时这块写在一行、位于 :511，0.19.0 起改成多行块 ⇒ 防漂移测试的取值正则已同步）；
//   * 未写进 JSDoc 但会实际产出：`persistence_failed`（`orchestrator.js:1077-1081`，fail() 里
//     「快照/markRunState 没落盘」时定值，并把 operation/phase/sideEffect 挂在 termination 上，
//     `orchestrator.js:1091` + `src/loop/termination.js:74` annotateTermination）；
//   * 0.20.0 另有一处**只影响可达性**的变更（guide §4，上游 #282）：终局裁决处 `aborted` 压过
//     `judge_done` / `final_guard_*` ⇒ 集合不变，但这三值在「用户点过停止」的 run 上不再可达。
//     我们按 reason 透传分流（`runner/lib/termination.js` 只兜 `failed`⇒`aborted` 的竞态），
//     无需改动，前端红色集合也不变。
//   * 0.20.0 → 0.22.0（#333）复核：`diff -q` 对 0.20.0（`npm pack` 解包）与 0.22.0 的
//     `src/providers/payload.js` / `src/providers/timeout.js` / `src/providers/errors.js` **逐字节相同**，
//     对 0.22.0 的 `src/loop/orchestrator.js` 跑防漂移正则取到的仍是同一组九值，且 `? "failed" :
//     "persistence_failed"`、`const reason = signal?.aborted`、`operation: persistenceFailure.operation`
//     三处形状断言仍然命中 ⇒ **只追版本号，不放宽任何断言**（§8.27 先例）。
//   * 0.22.0 → 0.23.0（#337 升级片）复核：`diff -q` 对 0.22.0（`npm pack` 解包）与 0.23.0 的
//     `src/loop/termination.js` **逐字节相同**（`diff` 无输出），对 0.23.0 的 `src/loop/orchestrator.js`
//     跑防漂移正则取到的仍是同一组九值（`end_turn` / `no_tool` / `stall` / `max_rounds_cap` / `judge_done` /
//     `continuation_exhausted` / `final_guard_unverified` / `aborted` / `failed`，顺序一字未变，只是 typedef
//     所在行号因上方新增注释下移一行），且 `? "failed" : "persistence_failed"`、`const reason = signal?.aborted`、
//     `operation: persistenceFailure.operation` 三处形状断言仍然命中；0.23.0 的 `src/` 变更面（投影 / orchestrator /
//     resume-manager / store 三个文件 / file-tools）**完全不碰 termination 语义** ⇒ **只追版本号，不放宽任何断言**。
//   * `reflection_stop` 已不是引擎取值（旧文档残留），只可能出现在历史数据行里，故**不在**本集合。

/** 常量对齐的引擎版本（升级 erix-agent 时必须重跑防漂移测试并按需重开 issue）。 */
export const ENGINE_VERSION_FOR_TERMINATION_REASONS = '0.23.0';

/**
 * 引擎 `termination.reason` 全集（顺序 = 引擎 typedef 声明顺序，`persistence_failed` 追加在末尾）。
 * 文档侧那份枚举表（docs/data/model.md §1.7、docs/api/portal.md §4.1/§5.3）必须与本数组逐项一致。
 */
export const TERMINATION_REASONS = [
  'end_turn',
  'no_tool',
  'stall',
  'max_rounds_cap',
  'judge_done',
  'continuation_exhausted',
  'final_guard_unverified',
  'aborted',
  'failed',
  'persistence_failed',
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

/** 全集查表（文档/测试用；运行时判定用 Set）。 */
export const TERMINATION_REASON_SET: ReadonlySet<string> = new Set<string>(TERMINATION_REASONS);

/**
 * issue #212 的红色告警子集（issue #42 的三值 + #212 补的两值）：
 *   * `persistence_failed` = **快照没落盘**——崩溃恢复可能重复副作用，语义最重，必须红色；
 *   * `final_guard_unverified` = **终稿未经核验**（finalGuard 修订重试耗尽 fail-closed），用户必须看见。
 * 注：`stall` / `continuation_exhausted` 属「截断但非故障」，按现状保持灰色（不在 #212 范围）。
 *
 * ⚠ issue #236 起这个集合**不再直接等于「界面上刷红」的集合**：它是「非正常收尾」的功能面判据
 * （#261B 重试面 / #306 终态补拉），界面分级看下面 `RUN_TERMINATION_SYSERR_REASONS`（两者差一个
 * `aborted`——用户主动停止不是故障）。
 */
export const RUN_FAIL_REASON_LIST = [
  'failed',
  'max_rounds_cap',
  'aborted',
  'persistence_failed',
  'final_guard_unverified',
] as const satisfies readonly TerminationReason[];

/** run_end 分级判定用（useEventStream / workbench.notifyRunEnd 共用，单一来源）。 */
export const RUN_FAIL_REASONS: ReadonlySet<string> = new Set<string>(RUN_FAIL_REASON_LIST);

/**
 * 用户**主动停止**的终态 reason（issue #236）。
 * 它是 `RUN_FAIL_REASONS` 里唯一**不是故障**的值：「用户按了停止」不是错误，所以界面呈现上
 * 从红色 `.syserr` 改判为中性分隔条（`RUN_TERMINATION_SYSERR_REASONS` = 红色集合减去它）。
 * ⚠ 它仍在 `RUN_FAIL_REASONS` 里——那个集合还决定「重试上一条」（#261B）与「终态后补拉 history」
 * （#306）两个**功能**面，那两个面把停止当失败收场是对的（都算非正常收尾）。
 */
export const USER_STOP_TERMINATION_REASON: TerminationReason = 'aborted';

/**
 * 终态分隔条**刷红**（`.syserr`）的 reason 集合（issue #236 呈现分级，实时 `run_end` 与历史合成项
 * `run_termination` **共用这一条规则**——两路同文案同分级，不然刷新一次颜色就变）：
 *   * 红 = `failed`（真失败）/ `max_rounds_cap`（撞轮数上限，异常截断）/ `persistence_failed`
 *     （快照没落盘，崩溃恢复可能重复副作用，语义最重）/ `final_guard_unverified`（终稿未核验）；
 *   * 中性 = 其余（含 `end_turn` / `no_tool` / `judge_done` / `stall` / `continuation_exhausted`
 *     这些正常或「截断但非故障」的收尾，以及 **`aborted`**：用户按了停止）。
 * **由 `RUN_FAIL_REASONS` 派生**（减掉 `USER_STOP_TERMINATION_REASON`）而不是手抄第二份枚举：
 * 将来往红色集合里加值，这里自动跟上（`terminationReasons.spec.ts` 钉住这条派生关系）。
 */
export const RUN_TERMINATION_SYSERR_REASONS: ReadonlySet<string> = new Set<string>(
  [...RUN_FAIL_REASONS].filter((reason) => reason !== USER_STOP_TERMINATION_REASON),
);

/**
 * 有落盘细节可展示的 reason（issue #212：worker 透传引擎 termination 后，
 * `persistence_failed` 会额外携带 `operation` / `phase` / `sideEffect`，工作台要能看见 phase）。
 */
export const PERSISTENCE_TERMINATION_REASON: TerminationReason = 'persistence_failed';

/**
 * 需要用户可读解释文案的 reason（i18n `stream.event.runEndReason.*` 的键集，双语）。
 *
 * issue #236（覆盖 #212 的「既有 failed / aborted / max_rounds_cap 保持原样」）：**除 `end_turn`
 * 之外的每一个引擎 reason 都有双语标签**。理由：① #236 的验收面就是「用户按停止后看到的是母语
 * 文案，不是裸 `aborted`」；② 本单把终态分隔条投影到历史里（`run_termination`）后，**任何一个**
 * reason 都会在重开会话时出现在界面上（含最常见的 `judge_done`）——只补 `aborted` 会把「裸英文
 * 枚举」从一处搬到另一处。`end_turn` 不在表里：它走既有 `stream.event.runEndNormal`
 * （「正常完成」/`completed normally`），两条文案不得漂移。
 * 引擎新增的未知 reason **不进表** ⇒ 文案回落 reason 原文（§5.3 向后兼容，不编造翻译）。
 */
export const RUN_END_LABEL_REASONS = [
  'no_tool',
  'stall',
  'max_rounds_cap',
  'judge_done',
  'continuation_exhausted',
  'final_guard_unverified',
  'aborted',
  'failed',
  'persistence_failed',
] as const satisfies readonly TerminationReason[];

/**
 * run 级错误码中「上游判定可重试」的码集（worker 终态 `error.retryable` 判据）。
 * 对齐上游：`erix-agent/src/providers/errors.js:1` RETRYABLE_CODES = timeout / rate_limited /
 * server / disconnect，再加 `checkpoint_failed`（`src/loop/run-snapshot-executor.js` 的
 * KitError，已对外文档化为可重试，见 docs/api/portal.md §6.2/§6.4）。
 * runner 侧的运行时镜像常量在 `runner/lib/termination.js`（FDE 镜像只 COPY runner/*，
 * 拿不到本文件），两者由 `portal/test/termination-contract.test.js` 逐项对齐。
 */
export const RUN_RETRYABLE_ERROR_CODES = [
  'timeout',
  'rate_limited',
  'server',
  'disconnect',
  'checkpoint_failed',
] as const;

/** 历史遗留、已不再是引擎取值的 reason（只可能在旧数据行里；文档不得再当枚举值列它）。 */
export const LEGACY_TERMINATION_REASONS = ['reflection_stop'] as const;
