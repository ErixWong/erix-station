// issue #469 宿主侧后续：折叠摘要旋钮的**本站侧**校验（A4）+ 降级事实的出口（A2）。
//
// 两条各自独立存亡的线：
//   ① A4 = `lib/compact-knobs.js` + worker 里那一层 `assertCompactContext(…)`。存在理由不是
//      「上游没校验」（#488/#493 有），而是**那些校验只挂在 `createAssemblyPort` 上，本站从不走
//      装配口**。K5 用真引擎证明这一点：把拼错的键名和非法值原样交给 `runToolLoop`，它一路
//      `end_turn`，不抛错、不发事件 ⇒ 这就是 #331 那根「没人读的光纤」。
//   ② A2 = `worker.js` 导出的 `foldDegradeNotice` + onEvent 里那条 warn。引擎侧「摘要降级」是
//      故意静默的（#469 裁定一：只进 `CompactionStat.foldSummary`，不新增事件类型），所以出口
//      必须由宿主自己接。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop } from 'erix-agent';
import {
  COMPACT_CONTEXT_KEYS,
  collectCompactContextProblems,
  assertCompactContext,
} from '../lib/compact-knobs.js';
import { foldDegradeNotice } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');
const CTX_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;

// ── ① A4：校验器本体的口径 ────────────────────────────────────────────────────
test('K1 本站现在真传的那份 context 必须过校验（否则 worker 起跑即崩）', () => {
  assert.deepEqual(collectCompactContextProblems({ strategy: 'fold-statistical' }), []);
  assert.equal(assertCompactContext({ strategy: 'fold-statistical' }).strategy, 'fold-statistical');
  assert.deepEqual(collectCompactContextProblems(undefined), [], '不传 context 是合法形态（引擎自己兜底）');
});

test('K2 键名拼错当场红——直连路径上它是**静默**的，本站是唯一能拦住的地方', () => {
  // 三个都是"看起来对"的错法：少了 Ms、单复数、少 s
  for (const typo of ['summarizerTimeout', 'maxSummarizerInputByte', 'maxSummaryToken', 'keepRound', 'budgetToken']) {
    const problems = collectCompactContextProblems({ strategy: 'fold-llm', [typo]: 1000 });
    assert.equal(problems.length, 1, `${typo} 应当被拦，实际 ${JSON.stringify(problems)}`);
    assert.match(problems[0], /unknown context option/);
  }
});

test('K3 旋钮值只认「安全正整数」：0 / 负数 / 小数 / 字符串 / null / NaN / 超出安全整数全红', () => {
  for (const bad of [0, -1, 1.5, '1000', null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    for (const key of ['summarizerTimeoutMs', 'summarizerBudgetMs', 'maxSummarizerInputBytes', 'maxPriorSummaryBytes', 'maxSummaryTokens']) {
      const problems = collectCompactContextProblems({ strategy: 'fold-llm', [key]: bad });
      assert.equal(problems.length, 1, `${key}=${String(bad)} 应红，实际 ${JSON.stringify(problems)}`);
      assert.match(problems[0], new RegExp(`^${key} must be a positive integer`));
    }
  }
});

test('K4 省略 = 用引擎默认（本站当前的裁定）；`keepRounds: 0` 是合法值不能按「>0」判', () => {
  assert.deepEqual(collectCompactContextProblems({
    strategy: 'fold-llm', summarizerTimeoutMs: undefined, maxSummaryTokens: undefined,
  }), []);
  assert.deepEqual(collectCompactContextProblems({ strategy: 'fold-llm', keepRounds: 0 }), [],
    'keepRounds=0 的含义是「折掉除最后一轮以外的全部」，不是没给');
  assert.equal(collectCompactContextProblems({ strategy: 'fold-llm', keepRounds: -1 }).length, 1);
  assert.equal(collectCompactContextProblems({ strategy: 'fold-llm', keepRounds: 'x' }).length, 1);
});

test('K5 上游给本站定的那批默认值都能过（将来写死时不会被自己拦下）', () => {
  // erix-agent #488/#490/#493 的默认值 = 本站的裁定值 ⇒ 省略与写死等价；写死也要能过这道门。
  assert.deepEqual(collectCompactContextProblems({
    strategy: 'fold-llm',
    summarizerTimeoutMs: 30_000,
    summarizerBudgetMs: 30_000,
    maxSummarizerInputBytes: 49_152,
    maxPriorSummaryBytes: 24_576,
    maxSummaryTokens: 1_400,
  }), []);
  // 五个键必须真在白名单里（漏一个就是「上游开了旋钮、本站写死即崩」）
  for (const key of ['summarizerTimeoutMs', 'summarizerBudgetMs', 'maxSummarizerInputBytes', 'maxPriorSummaryBytes', 'maxSummaryTokens']) {
    assert.ok(COMPACT_CONTEXT_KEYS.includes(key), `${key} 不在本站白名单：上游 #493 刚把它加进装配口，本站这边漏了`);
  }
});

test('K6 【真链路】同样的错交给**引擎**不报错——这正是 A4 必须存在的理由', async () => {
  const run = await runToolLoop({
    provider: {
      protocol: 'openai', model: 'm',
      async chat() { return { content: [{ type: 'text', text: '收尾' }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }; },
      async chatStream() { return this.chat(); },
    },
    model: 'm',
    initialUserMessage: 'hi',
    tools: [{ name: 'f', description: 'd', inputSchema: { type: 'object' } }],
    executeTool: async () => 'ok',
    maxRounds: 2, reflection: false, completion: false, stallDetection: false,
    // 一个拼错的键 + 一个非法值：装配口会抛 TypeError，直连路径什么都不会发生
    context: { strategy: 'fold-statistical', summarizerTimeout: 5000, maxSummaryTokens: 'abc' },
  });
  assert.equal(run.termination?.reason, 'end_turn', '引擎不校验 ⇒ 错配置照样"成功"跑完');
  // 反向确认：本站校验器对同一份入参是**红**的
  assert.equal(collectCompactContextProblems({ strategy: 'fold-statistical', summarizerTimeout: 5000, maxSummaryTokens: 'abc' }).length, 2);
  assert.throws(() => assertCompactContext({ strategy: 'fold-statistical', summarizerTimeout: 5000 }), TypeError);
});

test('K7 worker 真的把 context 包在 assertCompactContext 里（删掉那层包装就红，不靠注释自觉）', () => {
  const block = read('worker.js').match(CTX_MARKERS);
  assert.ok(block, 'worker.js 的 #392:context-strategy 标记没了');
  assert.match(block[1], /context:\s*assertCompactContext\(\{/,
    'worker 里的 context 又变成裸对象了 ⇒ 本站侧校验失效，拼错键名重新变成静默');
  // 注入真校验器求值 worker 那段真代码，而不是抄一份字面量
  const context = new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
  assert.equal(context.strategy, 'fold-statistical');
});

// ── ② A2：降级事实的出口 ─────────────────────────────────────────────────────
test('K8 fold-statistical（本站现状）下五键全缺席 ⇒ 不出告警，不许凭空造一条', () => {
  assert.equal(foldDegradeNotice({ strategyName: 'fold-statistical', foldedRounds: 12 }), null);
  assert.equal(foldDegradeNotice({ foldSummary: {} }), null, '产出了合格摘要 ⇒ 不该有 warn');
  assert.equal(foldDegradeNotice(undefined), null);
  assert.equal(foldDegradeNotice({ foldSummary: { degraded: false, unshrinkable: false, finishReason: 'end_turn' } }), null);
});

test('K9 degradeKind 优先（#487 的封闭枚举，短）；只有 degradeReason 时退回它（#482/#491 的整句）', () => {
  const both = foldDegradeNotice({
    strategyName: 'fold-llm', foldedRounds: 46,
    foldSummary: { degraded: true, degradeKind: 'timeout', degradeReason: '摘要器在 30000ms 内没有回来' },
  });
  assert.match(both, /degraded=timeout/);
  assert.doesNotMatch(both, /摘要器在/, '两个都在时读 kind：整句留给 #392-D 的 tooltip，日志要能 grep');
  assert.match(both, /strategy=fold-llm/);
  assert.match(both, /foldedRounds=46/);

  const onlyReason = foldDegradeNotice({ foldSummary: { degraded: true, degradeReason: 'provider 拒绝了请求' } });
  assert.match(onlyReason, /degraded=provider 拒绝了请求/);
  // 整句可能很长：留边界，别让一条 warn 变成半页
  assert.ok(foldDegradeNotice({ foldSummary: { degraded: true, degradeReason: 'x'.repeat(500) } }).length < 300);
});

test('K10 另两类非致命事实也要出声：截了等于没截（#490）、摘要被输出预算截断（#490 finishReason）', () => {
  assert.match(foldDegradeNotice({ foldSummary: { unshrinkable: true } }), /unshrinkable/);
  assert.match(foldDegradeNotice({ foldSummary: { finishReason: 'max_tokens' } }), /truncated at max output tokens/);
  assert.equal(foldDegradeNotice({ foldSummary: { finishReason: 'end_turn' } }), null,
    '正常收尾不是事实，不该刷 warn');
  const all = foldDegradeNotice({ foldSummary: { degraded: true, degradeKind: 'too_large', unshrinkable: true, finishReason: 'max_tokens' } });
  assert.equal(all.match(/degraded=|unshrinkable|truncated/g).length, 3, '三类同时发生要一条说全，不要分三条');
});

test('K11 worker 的 onEvent 里那条 warn 真接着（且**不改事件**：降级不是 run 失败）', () => {
  const src = read('worker.js');
  const onEvent = src.match(/onEvent: \(event\) => \{[\s\S]*?\n      \},/);
  assert.ok(onEvent, 'worker.js 的 onEvent 结构变了，本判据的正则需要重看');
  assert.match(onEvent[0], /foldDegradeNotice\(event\.compaction\)/);
  assert.match(onEvent[0], /level:\s*'warn'/);
  assert.match(onEvent[0], /emitEvent\(event\.type,\s*loopEventPayload\(event\)\)/,
    '告警之后仍要原样下发 compaction 事件：#392-D 横幅与历史回放都靠它');
  assert.doesNotMatch(onEvent[0], /RUN_FINISHED|buildFailureEnvelope/,
    '摘要降级不得改终态：模型拿到的仍是机械摘要，把正常完成的 run 刷红是误报');
});
