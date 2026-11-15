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
// 校验已退役：见下方「本站不再自带校验」那段（erix-agent 0.33.0 / issue #530）。
// 保留的历史事实（值域口径的出处，现在靠引擎兑现）：
//   · 这两个叶子在 `CONFIG_NAMESPACE_SCHEMA.folding` 的**组层**，不在 `folding.context` 里
//     ⇒ `assertCompactContext` 管不到它们（那是另一层，上面的白名单不包含它们）；
//   · 值域按引擎语义定，不按「正整数」一刀切（`tool-result-ttl.js:244-245`）：`0` = **关掉 TTL 折叠**
//     ⇒ 合法；负数 / 小数 / 字符串 / `null` 全拒（这条不直觉的口径现在由引擎逐字同语义地校着）。
// ────────────────────────────────────────────────────────────────────────────────
// `config.folding` 组层的两个工具结果旋钮（`toolResultTtl` / `toolResultFoldMinTokens`）：
// **本站不再自带校验**（issue #440 曾加过一道，erix-agent 0.33.0 起退役成这段注释）。
//
// 为什么曾有它（#440，当时引擎 0.29.0 / 0.30.0）：那两个叶子是 `CONFIG_NAMESPACE_SCHEMA.folding`
// 的合法叶子，但**不在** `CONFIG_LEAF_VALUE_RULE_PATHS` 里 ⇒ 没有值规则，读侧是裸 `??` 缺省
// （`orchestrator.js:794` / `:703`）⇒ `'6'` / `-1` / `1.5` / `null` 一路静默，行为退化成
// 「TTL 折叠静默失效」（看起来配上了、其实是关的）。本站走直连 `runToolLoop`、值是代码写死的
// ⇒ 配错 = 编程错误，所以当时自己加了 `assertFoldingToolResultKnobs` 在起跑前 fail-fast。
//
// 为什么现在退役（issue #530 / feat-261115-08，261115 在装着的 0.33.0 上现查）：上游开始校了。
//   · `CONFIG_LEAF_VALUE_RULE_PATHS` 现在含 `folding.toolResultTtl` / `folding.toolResultFoldMinTokens`
//     / `folding.context`（0.32.0 只有 `continuity.handoff` / `metadata.modelMetadata` / `run.stream`）；
//   · 真 `runToolLoop` 实测（261115）：`toolResultTtl: '6'` / `-1` / `1.5` 全部**启动期抛**
//     `TypeError: config.folding.toolResultTtl must be a non-negative integer (received: …)`；
//     `0` 与正整数**过**（只在我那个最小桦具的 `executeTool` 上停）。
// ⇒ 引擎的校验收与本站那道**逐字同语义**（含「`0` = 关掉 ⇒ 合法」这条不直觉的口径）。
//   留着就是重复造闸：两套校验重叠时，真正会错的那一半是**不生效的那一半**（它会给出
//   「已经校过了」的错觉）。所以删函数，不留空壳。
//   ⚠ 退役的是**校验**，不是那两个旋钮：`worker.js` 的 `#440:ttl-knobs` 区间里那两行照旧在场
//     （它们是待 A/B 验证的**裁定**，不是定论；A/B 回退 = 删那两行）。「键必须在场 + 值等于 N」
//     的钉法由 `runner/test/fold-strategy.test.js` 的 #440-B4/B5 继续担，不依赖本站的校验器。
//   ⚠ 值域现在由**引擎**定：上游哪天放宽或收紧，报错形状会变，而 #440-K13 钉的就是
//     「`folding.*` 已在那张表里 + 本站不再自带校验」⇒ 上游改回去时 K13 会红，不会静默。
// ────────────────────────────────────────────────────────────────────────────────

