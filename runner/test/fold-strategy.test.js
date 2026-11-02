// issue #392（A 片）→ issue #438（切片 B）：本站**显式选折叠策略**的防漂移锁 + 行为实证。
//
// 为什么要有这个文件：本站此前连 `context` 都不传 ⇒ 超预算时引擎自己拿 `createSlidingWindowStrategy()`
// 兜底，而那条兜底**什么都不产出**（零摘要 / 零锚点 / 零占位 / 账本零事实）——真机（会话 `bdef6dd7`，
// erix-agent 0.25.0，195 轮 / 12 run）7 次整轮折叠全是 slidingWindow，`foldedSummary` 与
// `navigationRecord` 各 0 行、`summary` 恒 `"missing"`。A 片改成 `fold-statistical` 是**一行**改动，
// 而一行改动最容易被后来人以「反正折叠会自己跑」为由顺手删掉 ⇒ 判据必须能让「删掉那行」变红。
//
// #438 切片 B 把这一行从 `fold-statistical` 翻成 **`fold-llm`**，并**显式**加 `keepRounds: 6`。
// 判据方向跟着翻，**强度只增不减**：
//   · A1 名字必须是引擎承认的内置名（上游改名 ⇒ 红，而不是等 run 起来炸）；
//   · A2 **钉死策略名 = `fold-llm`**，且 `keepRounds` **必须显式在场且等于 6**（删掉这一行就红 ——
//     它测的是「显式写」，不是「引擎缺省也是 6」）；同格钉住「除这两项之外一个键都不许有」；
//   · A3 行为实证：这个策略真能在消息流里留下替代物（且是 LLM 那份，不是降级那份）；
//   · A4 对照组：引擎兜底那条路确实**什么都不产**（换策略的理由不过期）；
//   · A5/A6 负例：本站**故意不传**的旋钮逐个钉「不在场」（四个上限 / `workingSetRecentRounds` /
//     `foldAtRatio` / `continuity.handoff`）。
//
// 技法照 runner/test/model-metadata.test.js：值从 **worker.js 源码里抠出来求值**，不在测试里另抄一份
// 字面量（否则「删掉 worker 那行」这条变异永远测不出来）；⚠ 不 import worker.js（顶层有 fork /
// process.on 副作用，工单明令）。
//
// 三条与本行绑定的口径（细节写在 worker.js 那段注释里，这里只钉成可执行的）：
//   ① 换策略**只**为了产出替代物，不改变折叠量（erix-agent#464 C 档未做）；
//   ② `keepRounds` 在 0.26.0 起**真被引擎读**（`orchestrator.js:3856` 的 `?? 6`）⇒ 显式传才有意义，
//      且「不传」不等于 0、也不等于「没配」；
//   ③ 名字必须是引擎自己承认的内置名（上游改名 ⇒ 本文件红，而不是等 run 起来炸）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_COMPACTION_STRATEGIES,
  BUILTIN_COMPACTION_STRATEGY_NAMES,
  createSlidingWindowStrategy,
} from 'erix-agent';
import { assertCompactContext } from '../lib/compact-knobs.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

const STRATEGY_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;

/** 求值 worker 的 `context` 装配段（标记没了 = 装配点被搬走/删掉，判据先在这里红，不许静默失去对象）。 */
function workerContextOption() {
  const block = read('worker.js').match(STRATEGY_MARKERS);
  assert.ok(block,
    'worker.js 必须有一对配对的 `/* #392:context-strategy:start|end */` 标记：'
    + '没了就是本站又退回「不传 context ⇒ 引擎滑窗兜底 ⇒ 折叠是静默硬删」那条老路');
  // ⚠ #469 后续 A4 之后这一块包了一层 `assertCompactContext(…)`（本站走直连 `runToolLoop`，
  // 上游 #488/#493 的装配期校验一次也不会触发）。这里**注入真校验器**而不是桩 ⇒ 本用例顺带多钉
  // 一件事：worker 里那段真配置必须真能过本站自己的白名单（将来往里加个拼错的键，这里就红）。
  return new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
}

/** 造 n 轮真形态消息（user → assistant tool_use → user tool_result），文本够长以便真的折得动。 */
function makeRounds(n) {
  const messages = [];
  for (let i = 1; i <= n; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `任务第 ${i} 轮 ${'u'.repeat(400)}` }] });
    messages.push({
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${i}`, name: 'shell', input: { command: `cmd ${i}` } }],
    });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: `r${i} ${'r'.repeat(600)}` }],
    });
  }
  return messages;
}

const textOf = (message) => {
  const content = message?.content;
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }]
    : (Array.isArray(content) ? content : []);
  return blocks.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n');
};

test('#392-A1 worker 传出的 context.strategy 必须是引擎承认的内置名', () => {
  const context = workerContextOption();
  assert.ok(context && typeof context === 'object', 'worker 必须真的传 context（不是 undefined）');
  assert.equal(typeof context.strategy, 'string',
    'context.strategy 必须是**名字字符串**（对象形态要改的是整段装配，不是这里换个值）');
  assert.ok(BUILTIN_COMPACTION_STRATEGY_NAMES.includes(context.strategy),
    `context.strategy="${context.strategy}" 不在引擎内置名里（合法值：`
    + `${BUILTIN_COMPACTION_STRATEGY_NAMES.join(' | ')}）——上游改名或未注册，启动期就是 TypeError`);
});

test('#438-B1 策略名钉死 `fold-llm`，且 `keepRounds` **必须显式在场并等于 6**', () => {
  const context = workerContextOption();
  // 策略方向：切片 B 的决策（2026-11-02 决策者拍）——三处为 fold-llm 建好的面（#392-C 折叠写注 /
  // #392-D 横幅两态 / A2 降级告警）在 fold-statistical 下**结构上不可达**。翻回去 = 那三处又变死代码。
  assert.equal(context.strategy, 'fold-llm',
    '折叠策略被翻回去了：`fold-llm` 是决策者 2026-11-02 定的值；翻回去必须同时把 '
    + 'runner/test/fold-notes-e2e.test.js（E1/E2 的 llm 形态）与 AGENTS §8.73 的闸门状态一起改');
  // keepRounds：**测的是「显式写」，不是「引擎缺省也是 6」**。
  // 引擎缺省是 `compactionContext.keepRounds ?? 6`（orchestrator.js:3856）⇒ 删掉这一行，行为上
  // 看起来没变，所以只有「键必须在场 + 值必须等于 6」这一条能把它钉住。
  assert.ok(Object.hasOwn(context, 'keepRounds'),
    'worker 里 `keepRounds: 6` 这一行被删了：引擎缺省也是 6，但那是**引擎的**决定，不是本站的'
    + '（决策者要求显式传）。删掉这行就红是这条判据存在的全部理由');
  assert.equal(context.keepRounds, 6,
    `keepRounds 必须是 6（实得 ${JSON.stringify(context.keepRounds)}）。`
    + '⚠ 两个不许写错的事实：① 不传 ≠ 0（引擎 `?? 6`）；② `estimatedTokens / budgetTokens > 2` 时'
    + '引擎会收紧成 `Math.min(配置值, 2)` ⇒ 小窗口高负载下实际会掉到 2，**这是设计不是 bug**');
  // 除这两项之外一个键都不许有（#331 死光纤守卫 + 切片 B「仍然不传」的正面表述）
  assert.deepEqual(Object.keys(context).sort(), ['keepRounds', 'strategy'],
    'context 里出现了本片没有裁定的键：每加一个键都要先证明引擎真读它（#331 那根「没人读的光纤」），'
    + '并在本文件里补一条负例判据');
});

test('#392-A3 行为实证：worker 抠出的那个名字，折叠后**必须**在消息流里留下替代物', async () => {
  const context = workerContextOption();
  // `fold-llm` 的工厂**必须**拿到 summarizer（引擎在名字形态下自动注入本 run 的 provider 摘要器）。
  // 这里注入一个桩：本格证的是「这个名字 + 这份 context 真能产出替代物」，引擎侧的接线由
  // `runner/test/fold-notes-e2e.test.js`（真 runToolLoop）负责，两层各管各的。
  const strategy = BUILTIN_COMPACTION_STRATEGIES[context.strategy]({
    summarizer: async () => '## 阶段\n已把 runner 的折叠策略切到 fold-llm 并跑过测试。',
  });
  const messages = makeRounds(12);
  const inputSet = new Set(messages);
  const result = await strategy.compact(messages, { keepRounds: context.keepRounds });

  assert.ok(result.foldedRounds > 0, '前置：这一格必须真的折了（否则下面的断言是空断言）');
  assert.ok(Array.isArray(result.messages));

  const joined = result.messages.map(textOf).join('\n');
  assert.match(joined, /已把 runner 的折叠策略切到 fold-llm/,
    '替代物缺席 ⇒ 又回到「模型不知道自己少了什么」（这是 A 片存在的理由）');
  assert.doesNotMatch(joined, /摘要失败，已降级为统计摘要/,
    '桩摘要器没抛错，却出现了降级标记 ⇒ 这条路上 fold-llm 没真跑（降级形态由 A2 的 e2e 单独证）');
  // foldSummary 的形态：source 必须是 llm（= 账本里 foldedFacts.origin 会是 semantic，不是 mechanical）
  assert.equal(result.foldSummary?.source, 'llm',
    `foldSummary.source 应为 "llm"（实得 ${JSON.stringify(result.foldSummary?.source)}）⇒ `
    + '账本的 foldedFacts.origin 会跟着从 mechanical 变成 semantic');

  // **尾窗真的被读**（行为面，不靠字面量）：keepRounds=6 ⇒ 保留 10 条消息；keepRounds=0（全折）⇒ 只剩
  // 摘要那一条。两发用**同一个桩摘要器**，差异只能来自那个数字。
  // ⚠ 探针不能拿「最后那轮的正文字符串」去搜：折叠的保真层会**逐字引用**被折原文（锚点节）⇒ 字符串
  //   在折完之后仍可能命中，拿它当判据会得出假绿/假红（E 片 §8.67 同形教训）。用**条数与折走轮数**。
  const allFolded = await strategy.compact(makeRounds(12), { keepRounds: 0 });
  assert.ok(allFolded.foldedRounds > result.foldedRounds,
    `keepRounds=0（全折）应折得更多（实得 ${allFolded.foldedRounds} vs ${result.foldedRounds}）`
    + ' ⇒ 否则 keepRounds 根本没被策略读（本格就是 #331 形状：写了没人读）');
  assert.ok(allFolded.messages.length < result.messages.length,
    `keepRounds=0 的消息条数应更少（实得 ${allFolded.messages.length} vs ${result.messages.length}）`);
  assert.equal(allFolded.messages.length, 1,
    'keepRounds=0 = 「折掉除最后一轮以外的全部」（尾窗为 0 ⇒ 只剩摘要那一条）');

  // 「会进账本」的口径代理：orchestrator 判「本次折叠造出来、确实进了请求的那份摘要」用的是
  // **对象身份**（`!preCompactionMessages.has(message)`）⇒ 摘要必须是**新对象**才满足 ⇒
  // `fedSummaryText !== ""` 成立 ⇒ `record.foldedSummary` 落账。
  const carried = result.messages.filter((m) => !inputSet.has(m) && /fold-llm/.test(textOf(m)));
  assert.ok(carried.length >= 1,
    '摘要必须是折叠新造的消息对象，否则 orchestrator 的对象身份判据拿不到它 ⇒ 不进账本');
});

test('#392-A4 对照组：引擎兜底那条路（不传 context 的后果）确实**什么都不产**', async () => {
  // 这一格钉的是「换策略的理由」。上游若哪天把兜底也补上摘要，本格会红——那是**口径过期**信号，
  // 届时应把 worker 那段注释与本文件的理由一起改写，而不是把断言放宽。
  const result = await createSlidingWindowStrategy().compact(makeRounds(12), {});
  assert.ok(result.foldedRounds > 0, '前置：兜底路径同样会折（它只是不产替代物）');
  const joined = result.messages.map(textOf).join('\n');
  assert.doesNotMatch(joined, /工具足迹：/,
    '兜底路径居然产出了工具足迹 ⇒ 上游改了 sliding-window，A 片的理由需要同步复核');
  assert.ok(result.foldSummary === undefined,
    '兜底路径不应带 foldSummary；带上了说明本站可以直接回退到「不传 context」');
});

// ── A5/A6：本站**故意不传**的旋钮逐个钉「不在场」 ─────────────────────────────
// 为什么不传：这些键的引擎缺省**就是**本站的裁定值（§8.73 口径：省略 = 用上游默认，写死 = 多一份
// 会漂移的副本）；`workingSetRecentRounds` 上游默认关且 #612 实测打开更贵；`foldAtRatio` 默认 1.0
// 与今天逐字等价；`continuity.handoff` 默认 off。传了就是引入未量的行为变化。
// ⚠ 判据方向是**负例**：它们一旦出现在 `context` 里就红（哪怕值恰好等于缺省），
// 因为「写死」与「省略」在漂移时是两件事。
const NOT_PASSED = [
  // 四个上限（erix-agent #488/#493）：上游缺省即本站裁定值
  'summarizerTimeoutMs', 'firstByteTimeoutMs', 'maxSummaryBytes', 'maxSummaryTokens',
  // 工作集地板（#612 默认关）/ 折叠触发比例（默认 1.0）
  'workingSetRecentRounds', 'foldAtRatio',
];

test('#438-B2 四个上限 / workingSetRecentRounds / foldAtRatio 仍然**不在场**（省略 = 用上游默认）', () => {
  const context = workerContextOption();
  const present = NOT_PASSED.filter((key) => Object.hasOwn(context, key));
  assert.deepEqual(present, [],
    `这些键被写进 context 了：${present.join(', ')}。它们的引擎缺省就是本站裁定值（§8.73），`
    + '写死 = 多一份会漂移的副本；真要改得先量（②③ 闸门）并同批改本文件');
  // 反向：白名单**必须**认得它们（将来主 agent 量完要写死时，不能被本站自己的校验器拦下）
  const block = read('worker.js').match(STRATEGY_MARKERS);
  const context2 = new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
  assert.deepEqual(Object.keys(context2).sort(), ['keepRounds', 'strategy']);
});

test('#438-B3 `config.continuity` / `capabilities.hooks.continuityProvider` 一个都不传（handoff 默认 off）', () => {
  const src = read('worker.js');
  // 本站在 `runToolLoop` 的 `config` 树里**没有** `continuity` 组；观察者/端口层也没有
  // `continuityProvider`。开了就由引擎当默认写者（请求里多一条 ~80 token 指令、落
  // `~/.erix/continuity/`）⇒ 属未量行为变化，本片不接（`continuity_injection_skipped` 的豁免理由也建在这条上）。
  assert.doesNotMatch(src, /^\s*continuity:\s*\{/m, 'worker 开始传 `config.continuity` 了 ⇒ continuity 那族事件的豁免理由失效，需重看');
  assert.doesNotMatch(src, /\bcontinuityProvider\b/, 'worker 开始传 `continuityProvider` 了 ⇒ 同上');
});
