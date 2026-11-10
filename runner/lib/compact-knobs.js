// issue #469 宿主侧后续（A4）：**本站自己**校一遍折叠摘要旋钮与 `context` 子键名。
//
// 为什么必须宿主自己校（这是本站走**直连** `runToolLoop` 的代价）：
//   erix-agent #488/#493 加的装配期校验（未知子键抛错、旋钮值必须正整数）**只挂在
//   `createAssemblyPort` 上**。本站从不走装配口——真链路实测（引擎 0.26.0 + pr493 同款探针）：
//       runToolLoop({ config: { folding: { context: {
//         strategy:'fold-llm', summarizerTimeout:5000, maxSummaryTokens:'abc' } } } })
//   ⇒ 一路 `end_turn`，**不抛错、不发事件、不红**：`summarizerTimeout` 是拼错的键名（引擎读的是
//   `summarizerTimeoutMs`），`maxSummaryTokens:"abc"` 是非法值。这就是 erix-station #331 那根
//   「没人读的光纤」的形状：配置写了、看起来配上了、跑的其实是默认值。
//
// 所以口径在这里一次定死：
//   · 键名白名单 = 本站**确实会用到**的那些 + 引擎在 `budget.js` 里自己读的五个（`toolContext`
//     / `expert` / `user` / `session` / `requestId`）；新增键必须同批改这里，改一处不留痕是本站红线。
//   · 旋钮值 = **安全正整数**（与上游 `validateFoldSummarizerCaps` 同口径；`0` / 负数 / 小数 /
//     字符串 / `null` 全拒——省略才是默认值，写了就等于给了一个错值）。
//   · 抛错而不是 warn：`context` 是**代码写死的**（本站明确不给 env 旋钮，见 worker.js
//     `#392:context-strategy` 段的裁定），所以配错 = 编程错误，崩在起跑前比静默用默认好。

/** 本站与引擎都会读的 `context` 子键全集（写错键名 ⇒ 静默用默认值，这里当场抛）。 */
export const COMPACT_CONTEXT_KEYS = Object.freeze([
  // 折叠策略与预算（本站现状只用到 strategy / budgetTokens / keepRounds）
  'strategy', 'budgetTokens', 'keepRounds', 'recoveryHint', 'stubFor',
  'summaryRole', 'protectedMessage', 'stripHistoricalImages',
  'onBeforeFold', 'onAfterFold', 'maxFoldedPayloadBytes', 'maxFoldedFactsBytes',
  'channel', 'task',
  // 折叠摘要的五个上限（erix-agent #469 B1 + #493；本站当前**全部省略**，省略即引擎默认）
  'summarizerTimeoutMs', 'summarizerBudgetMs', 'maxSummarizerInputBytes',
  'maxPriorSummaryBytes', 'maxSummaryTokens',
  // 引擎自己在 budget.js:81-91 读的宿主上下文键（漏一个就是把合法配置打成错）
  'toolContext', 'expert', 'user', 'session', 'requestId',
]);

/**
 * 需要「安全正整数」的那几个键。两层超时的语义**刻意不同**，别合并：
 * `summarizerTimeoutMs` = provider 层**单发**上限；`summarizerBudgetMs` = 策略层**整条步骤**死线
 * （首发与超窗自愈共用）。上游 #493 还把前者定义成「与剩余预算取小」，所以它是红线不是目标值。
 */
export const COMPACT_POSITIVE_INT_KEYS = Object.freeze([
  'summarizerTimeoutMs', 'summarizerBudgetMs', 'maxSummarizerInputBytes',
  'maxPriorSummaryBytes', 'maxSummaryTokens', 'budgetTokens', 'keepRounds',
  'maxFoldedPayloadBytes', 'maxFoldedFactsBytes',
]);

const KEY_SET = new Set(COMPACT_CONTEXT_KEYS);
const POSITIVE_INT_SET = new Set(COMPACT_POSITIVE_INT_KEYS);

/**
 * @param {Record<string, unknown>|undefined} context 要交给 `runToolLoop({ config: { folding: { context } } })` 的那个对象
 *   （erix-agent 0.28.0 起扁平顶层 `context` 会被启动期拒；**值本身**与本校验器一字未变）
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectCompactContextProblems(context) {
  if (context === undefined || context === null) return [];
  if (typeof context !== 'object' || Array.isArray(context)) {
    return ['context must be a plain object'];
  }
  const problems = [];
  for (const [key, value] of Object.entries(context)) {
    if (!KEY_SET.has(key)) {
      problems.push(`unknown context option ${JSON.stringify(key)} (engine reads it only via a name on this list; a typo = silently ignored on the direct runToolLoop path)`);
      continue;
    }
    // `keepRounds: 0` 是**合法值**（引擎 `selectFoldedRounds` 用 `Math.max(0, …)` 明确为它留了口子），
    // 所以这里不能用「> 0 才算给」。
    // ⚠ 别在这里给它写语义：折几轮还取决于 `protectedMessage` / `workingSetRecentRounds`。
    //   2026-11-10 实测裸调 `selectFoldedRounds(8 轮, 0)` = 折 8 保留 0，与本节旧注释
    //   「折掉除最后一轮以外的全部」**不符** ⇒ 语义归折叠策略那侧，这里只管值域。
    if (POSITIVE_INT_SET.has(key) && key !== 'keepRounds') {
      if (value === undefined) continue;                       // 省略 = 用引擎默认
      if (!Number.isSafeInteger(value) || value <= 0) {
        problems.push(`${key} must be a positive integer, got ${JSON.stringify(value)}`);
      }
    }
    if (key === 'keepRounds' && value !== undefined
      && (!Number.isSafeInteger(value) || value < 0)) {
      // `keepRounds: 0` 合法（语义归折叠策略那侧，见上方注释），负数没意义。
      problems.push(`keepRounds must be a non-negative integer, got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/**
 * 起跑前的 fail-fast：有问题就抛（worker 把它当崩溃语义处理，与 `store.load` 失败同一档）。
 * @param {Record<string, unknown>|undefined} context
 */
export function assertCompactContext(context) {
  const problems = collectCompactContextProblems(context);
  if (problems.length > 0) throw new TypeError(`invalid compaction context: ${problems.join('; ')}`);
  return context;
}

// ── issue #440：`config.folding` **层**的两个工具结果旋钮（`toolResultTtl` / `toolResultFoldMinTokens`）──
//
// 为什么在这里另立一道（先核实过引擎**不校**这两个叶子，0.29.0）：
//   · 它们是 `CONFIG_NAMESPACE_SCHEMA.folding` 里的合法叶子（`src/loop/config-namespace.js:222-223`），
//     所以不会撞「unknown config.folding option」；
//   · 但 `CONFIG_LEAF_VALUE_RULE_PATHS`（`config-namespace.js:569-587`）只登记了 `run.stream` 与
//     `continuity.handoff` 两条值规则 ⇒ 这两个叶子**没有值规则**，任何值都收；
//   · 读侧是 `resolvedToolResultTtl = toolResultTtl ?? TOOL_RESULT_TTL_DEFAULT`（`orchestrator.js:794`）
//     与 `toolResultFoldMinTokens = TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT`（`:703`）——**裸 ?? 缺省**，
//     不校验类型。真链路实测（真 `runToolLoop`，四个非法值各跑一发）：`'6'` / `-1` / `null` / `1.5`
//     全部正常收尾，**不抛、不告警**，
//     行为退化成「TTL 折叠静默失效」（`tool-result-ttl.js:245`：`ttl <= 0 || minTokens <= 0` ⇒ no-op；
//     字符串走 `Number.isFinite` 守卫 `:241` ⇒ 直接原样返回）。
//   ⇒ 与 #469 A4 同一个理由：本站走直连 `runToolLoop`，值是**代码写死的**（本片不给 env 旋钮），
//     所以配错 = 编程错误，崩在起跑前比静默用默认值好。
//
// 值域按引擎语义定，不按「正整数」一刀切（`tool-result-ttl.js:244-245`）：
//   · `toolResultTtl: 0` = **关掉 TTL 折叠**（引擎自己 `cacheCapable === true` 时就是这么关的，
//     `orchestrator.js:794-796`）⇒ 合法；负数/小数/字符串/`null` 全拒；
//   · `toolResultFoldMinTokens: 0` = 同样关掉（`:245`）⇒ 合法；其余同上。
// ⚠ 本站当前传的是 6 / 8000（见 `worker.js` 的 `#440:ttl-knobs` 段），`0` 合法只是**校验口径**，
//   不代表本站现在用 0。
export const FOLDING_TOOL_RESULT_KEYS = Object.freeze(['toolResultTtl', 'toolResultFoldMinTokens']);

/**
 * @param {Record<string, unknown>|undefined} knobs 要交给 `runToolLoop({ config: { folding } })` 的
 *   `folding` 层（**不是** `folding.context`——那两个叶子在组层，`assertCompactContext` 管不到）。
 * @returns {string[]} 问题列表（空 = 通过）
 */
export function collectFoldingToolResultProblems(knobs) {
  if (knobs === undefined || knobs === null) return [];
  if (typeof knobs !== 'object' || Array.isArray(knobs)) return ['folding tool-result knobs must be a plain object'];
  const problems = [];
  for (const [key, value] of Object.entries(knobs)) {
    if (!FOLDING_TOOL_RESULT_KEYS.includes(key)) {
      problems.push(`unknown folding tool-result knob ${JSON.stringify(key)} (only ${FOLDING_TOOL_RESULT_KEYS.join(' / ')} are validated here)`);
      continue;
    }
    if (value === undefined) continue; // 省略 = 用引擎默认（0.29.0：2 / 4000）
    if (!Number.isSafeInteger(value) || value < 0) {
      problems.push(`${key} must be a non-negative integer (0 = off), got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/**
 * 起跑前的 fail-fast（同 `assertCompactContext` 那一档：抛出去走 #212 失败信封）。
 * 返回入参本身，方便在 `worker.js` 里用 `...assertFoldingToolResultKnobs({...})` 展开。
 * @param {Record<string, unknown>|undefined} knobs
 */
export function assertFoldingToolResultKnobs(knobs) {
  const problems = collectFoldingToolResultProblems(knobs);
  if (problems.length > 0) throw new TypeError(`invalid folding tool-result knobs: ${problems.join('; ')}`);
  return knobs;
}
