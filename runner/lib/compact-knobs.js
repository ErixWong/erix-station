// issue #469 宿主侧后续（A4）：**本站自己**校一遍折叠摘要旋钮与 `context` 子键名。
//
// 为什么必须宿主自己校（这是本站走**直连** `runToolLoop` 的代价）：
//   erix-agent #488/#493 加的装配期校验（未知子键抛错、旋钮值必须正整数）**只挂在
//   `createAssemblyPort` 上**。本站从不走装配口——真链路实测（引擎 0.26.0 + pr493 同款探针）：
//       runToolLoop({ context: { strategy:'fold-llm', summarizerTimeout:5000, maxSummaryTokens:'abc' } })
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
 * @param {Record<string, unknown>|undefined} context 要交给 `runToolLoop({ context })` 的那个对象
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
    // `keepRounds: 0` 是合法值（折掉除最后一轮以外的全部），所以这里不能用「> 0 才算给」。
    if (POSITIVE_INT_SET.has(key) && key !== 'keepRounds') {
      if (value === undefined) continue;                       // 省略 = 用引擎默认
      if (!Number.isSafeInteger(value) || value <= 0) {
        problems.push(`${key} must be a positive integer, got ${JSON.stringify(value)}`);
      }
    }
    if (key === 'keepRounds' && value !== undefined
      && (!Number.isSafeInteger(value) || value < 0)) {
      // `keepRounds: 0` 合法（含义是「折掉除最后一轮以外的全部」），负数没意义。
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
