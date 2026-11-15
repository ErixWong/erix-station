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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
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
// 与 `runner/test/fold-strategy.test.js` 的 `workerTtlKnobs()` 同一对标记、同一套正则：
// 从**源码**里解析 worker 真传的那两个旋钮，而不是在测试里手抄一遍值。
const TTL_MARKERS = /\/\* #440:ttl-knobs:start \*\/([\s\S]*?)\/\* #440:ttl-knobs:end \*\//;

// ── ① A4：校验器本体的口径 ────────────────────────────────────────────────────
test('K1 本站现在真传的那份 context 必须过校验（否则 worker 起跑即崩）', () => {
  // #438 切片 B：真传的是 `{ strategy: 'fold-llm', keepRounds: 6 }`（从 worker 抠，不另抄）。
  const block = read('worker.js').match(CTX_MARKERS);
  assert.ok(block, 'worker.js 的 #392:context-strategy 标记没了');
  const real = new Function('assertCompactContext', `return {${block[1]}}`)(assertCompactContext).context;
  assert.deepEqual(collectCompactContextProblems(real), [],
    `worker 真传的那份 context 过不了本站校验：${JSON.stringify(real)}`);
  assert.equal(assertCompactContext(real).strategy, 'fold-llm');
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
  // #438 切片 B（M2.2）：判据是**非负整数**，且必须是**安全整数**。
  // 四个具名负例（工单 §2 M2.2 点名）：-1 / 1.5 / '3'（字符串）/ NaN，再加安全整数上界。
  const negatives = [
    ['-1', -1],
    ['1.5', 1.5],
    ["'3'", '3'],
    ['NaN', NaN],
    ['MAX_SAFE_INTEGER+1', Number.MAX_SAFE_INTEGER + 1],
    ['Infinity', Infinity],
    ['null', null],
  ];
  for (const [label, bad] of negatives) {
    const problems = collectCompactContextProblems({ strategy: 'fold-llm', keepRounds: bad });
    assert.equal(problems.length, 1, `keepRounds=${label} 应红，实际 ${JSON.stringify(problems)}`);
    assert.match(problems[0], /^keepRounds must be a non-negative integer/,
      `keepRounds=${label} 的报错文案要能看出「非负整数」这条口径`);
    assert.throws(() => assertCompactContext({ strategy: 'fold-llm', keepRounds: bad }), TypeError);
  }
  // 正向：0 与 6 都合法（0 是「全折」，不是「没给」）
  for (const good of [0, 1, 6, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(collectCompactContextProblems({ strategy: 'fold-llm', keepRounds: good }), [],
      `keepRounds=${good} 应合法`);
  }
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

test('K6 【真链路】同样的错在 0.29.0 的**直连路径**上也会被拒（上游 #496 S1 起两条路共用一个语义相）', async () => {
  const run = await runToolLoop({
    provider: {
      protocol: 'openai', model: 'm',
      async chat() { return { content: [{ type: 'text', text: '收尾' }], stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }; },
      async chatStream() { return this.chat(); },
    },
    tools: [{ name: 'f', description: 'd', inputSchema: { type: 'object' } }],
    executeTool: async () => 'ok',
    // erix-agent 0.28.0：数据只能写进 `config.<组>.<叶>`（扁平 `model` / `initialUserMessage` /
    // `maxRounds` / `reflection` / `completion` / `stallDetection` / `context` 现在启动期就抛）。
    config: {
      metadata: { model: 'm' },
      input: { initialUserMessage: 'hi' },
      run: {
        maxRounds: 2, reflection: false, completion: false, stallDetection: false,
      },
      // 一个拼错的键 + 一个非法值
      folding: { context: { strategy: 'fold-statistical', summarizerTimeout: 5000, maxSummaryTokens: 'abc' } },
    },
  }).then((r) => ({ ok: r }), (err) => ({ err }));
  // ⚠ 口径在 0.29.0 上**变了，而且是变严**：0.26.0 时直连路径对这个错**一声不响**
  // （`normalizeRunToolLoopOptions` 里没有语义相），0.28.0 把 `assertSemanticOptionValues`
  // 放进了两条路的公共前置（上游 issue #496 S1，`option-normalization.js` 头注释第 5 条）⇒
  // 现在**直连也抛**。所以本格从「引擎不校验」改成「引擎现在也校验」，判据强度是**升**的：
  // 上游若哪天把这道闸从直连路径上摘掉，本格会红（那正是 A4 重新变成唯一防线的那一天）。
  assert.equal(run.ok, undefined, '0.29.0 的直连路径必须拒掉这份错配置（0.26.0 时代它是一声不响的）');
  assert.match(String(run.err?.message ?? ''),
    /unknown assembly policy context option: "summarizerTimeout"/,
    '拒绝理由必须点名那个拼错的键（上游文案口径，本站只钉「真的拒了 + 拒得有名有姓」）');
  assert.match(String(run.err?.message ?? ''), /maxSummaryTokens must be a positive integer/,
    '非法值那一半同样要被点名');
  assert.ok(run.err instanceof TypeError, '语义相的抛错类型仍是 TypeError（两条路一致）');
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
  assert.equal(context.strategy, 'fold-llm');
  assert.equal(context.keepRounds, 6);
});

// ── ② A2：降级事实的出口 ─────────────────────────────────────────────────────
test('K8 `fold-llm` 产出合格摘要时五键全缺席 ⇒ 不出告警，不许凭空造一条', () => {
  assert.equal(foldDegradeNotice({ strategyName: 'fold-llm', foldedRounds: 12 }), null);
  assert.equal(foldDegradeNotice({ foldSummary: {} }), null, '产出了合格摘要 ⇒ 不该有 warn');
  assert.equal(foldDegradeNotice(undefined), null);
  assert.equal(foldDegradeNotice({
    foldSummary: { degraded: false, budgetExhausted: false, inputTruncated: false, droppedRounds: 0, droppedMessages: 0, finishReason: 'end_turn' },
  }), null);
});

// ── K9 issue #442（erix-agent 0.30.0 / 上游 #661）：**已退役的键不许复活** ─────────────────────
//
// 0.29 时代这里钉的是「degradeKind 优先、degradeReason 退回」。#661 把「降级为统计摘要」整条路径
// 删了：摘要器失败 ⇒ 抛 `KitError("summarizer_failed")` ⇒ run 以 `failed` 收场（一个 compaction
// 事件都不发）。于是 `foldSummary.degradeKind` / `degradeReason` / `degraded` **再也不会出现**，
// 读它们的那一支是死分支（本站 0.30.0 起已删）。
//
// 本格是那条删除的**判据**，方向反过来了：不是「读得对」，而是「**一个字节都不许再读**」。
// 变异：把那一支加回 `worker.js#foldDegradeNotice` ⇒ 本格红（证明删除不是靠注释自觉）。
test('K9 【已退役的键不许复活】degradeKind / degradeReason / degraded 不再被读（0.30 起引擎不生产）', () => {
  // ① 行为面：喂进去也不出声（这三个键今天只可能是旧数据/旧事件里的残留）
  for (const retired of [
    { degraded: true, degradeKind: 'timeout' },
    { degraded: true, degradeReason: 'provider 拒绝了请求' },
    { degradeKind: 'error', degradeReason: '整句' },
  ]) {
    assert.equal(foldDegradeNotice({ strategyName: 'fold-llm', foldedRounds: 46, foldSummary: retired }), null,
      `foldSummary 里只有退役键 ${JSON.stringify(retired)} 时不许出告警（那条降级路径已删）`);
  }
  // ② 代码面：生产代码（剥掉注释）里这三个键名一个都不许出现。
  //    `runner/worker.js` 与前端 `compactionDegradeText` 各盯一半（同一口径，两个出口）。
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const sources = [
    ['runner/worker.js', read('worker.js')],
    ['portal/frontend/src/composables/useEventStream.ts',
      fs.readFileSync(path.join(RUNNER_DIR, '..', 'portal', 'frontend', 'src', 'composables', 'useEventStream.ts'), 'utf8')],
  ];
  // 只认**属性访问**（`.degradeKind` / `.degraded`）：`persistence_capability_degraded` 与 judge 的
  // `action === 'degraded'` 都是别的语义，按裸字符串搜会把它们误判成复活。
  for (const [name, source] of sources) {
    const code = stripComments(source);
    for (const retired of ['degradeKind', 'degradeReason', 'degraded']) {
      const hit = new RegExp(`\\.${retired}\\b`).test(code);
      assert.equal(hit, false,
        `${name} 的代码面又读了已退役的 \`.${retired}\`（0.30.0 起引擎不生产它）⇒ `
        + '那是死分支：要么删掉，要么先证明上游把它加回来了（K12 会先红）');
    }
  }
  // ③ 抽取面同口径：K12 的「本站从 foldSummary 读的键」里也不许有退役键（两格互相兜）
  assert.deepEqual(keysReadFromStat().filter((key) => FOLD_SUMMARY_KEYS_RETIRED.includes(key)), [],
    '生产代码仍在读退役键 ⇒ 死分支复活');
});

// ⚠ issue #442 复核（0.30.0 实测）：`foldSummary.budgetExhausted` 现在**只剩失败路径**那一个写入点
// （`fold-llm.js:805` 的 `fail(..., { budgetExhausted: true })`，而失败路径不再返回 stat）⇒ 成功路径上
// 已不可达。工单 §M3 明确要求**保留**这一支（「删了就是丢信号」），故本格继续钉它；处置见报告 §M3。
test('K10 另外两类非致命事实也要出声：整条步骤预算耗尽（没自愈重试）、输入面被裁；摘要被输出预算截断', () => {
  // 契约 #469①②③：剩余预算不足 2 秒 ⇒ 连「换更短输入自愈重试」都没发生，记 budgetExhausted
  assert.match(foldDegradeNotice({ foldSummary: { budgetExhausted: true } }), /budget_exhausted/);
  // 输入面被裁是两层守卫：48 KB 按整轮裁（inputTruncated / droppedRounds）与 token 守卫逐条裁
  //（droppedMessages）。任一发生 ⇒ 这份摘要是「基于不完整材料写成的」，必须说。
  assert.match(foldDegradeNotice({ foldSummary: { inputTruncated: true } }), /input clipped/);
  assert.match(foldDegradeNotice({ foldSummary: { droppedRounds: 7 } }), /input clipped \(rounds=7 messages=0\)/);
  assert.match(foldDegradeNotice({ foldSummary: { droppedMessages: 3 } }), /messages=3/);
  assert.match(foldDegradeNotice({ foldSummary: { finishReason: 'max_tokens' } }), /truncated at max output tokens/);
  assert.equal(foldDegradeNotice({ foldSummary: { finishReason: 'end_turn' } }), null,
    '正常收尾不是事实，不该刷 warn');
  assert.equal(foldDegradeNotice({ foldSummary: { droppedRounds: 0, droppedMessages: 0, inputTruncated: false } }), null,
    '0 与 false 都是「没裁」，不许据此报事（那会把每个正常折叠都刷一条）');
  const all = foldDegradeNotice({
    foldSummary: { budgetExhausted: true, droppedRounds: 7, finishReason: 'max_tokens' },
  });
  assert.equal(all.match(/budget_exhausted|input clipped|truncated/g).length, 3,
    '三类同时发生要一条说全，不要分三条（退役的 degraded 那一支已不在计数里）');
});

test('K11 worker 的 onEvent 里那条 warn 真接着（且**不改事件**：降级不是 run 失败）', () => {
  const src = read('worker.js');
  const onEvent = src.match(/onEvent: \(event\) => \{[\s\S]*?\n      \},/);
  assert.ok(onEvent, 'worker.js 的 onEvent 结构变了，本判据的正则需要重看');
  assert.match(onEvent[0], /foldDegradeNotice\(event\.compaction\)/);
  assert.match(onEvent[0], /level:\s*'warn'/);
  // #425 起 `loopEventPayload` 多了一个 meta 参数（`{ contextWindow }`，只往 payload 里加宿主侧
  // additive 展示量，**不改 event 本身**）⇒ 锚点必须容得下它，否则这条判据会因为一个纯加法而假红。
  // 「不改事件」这层仍由下面的 doesNotMatch 与「第一参数就是 event」共同兜住。
  assert.match(onEvent[0], /emitEvent\(event\.type,\s*loopEventPayload\(event(?:,\s*\{[^}]*\})?\)\)/,
    '告警之后仍要原样下发 compaction 事件：#392-D 横幅与历史回放都靠它');
  assert.doesNotMatch(onEvent[0], /RUN_FINISHED|buildFailureEnvelope/,
    '摘要降级不得改终态：模型拿到的仍是机械摘要，把正常完成的 run 刷红是误报');
});

// ── ③ 字段面对账：本站读的每个 foldSummary 键都必须真的存在 ─────────────────────
// 前例（本单自己犯的）：本站曾读 `foldSummary.unshrinkable`——**引擎从不发这个键**（0.26.0 与
// 上游 main 的契约、`src/` 全文 grep 均零命中），它靠"看起来像 #490 会发的东西"写进了代码、
// 判据和两份 i18n。后果不是报错而是**永不触发**：一条永不响的告警比没有告警更坏。
// 键名清单**从两处生产代码里抠**（不手抄），所以改了代码不改进契约面就会红。
// 0.30.0 起 `degradeKind` / `degradeReason` / `degraded` **退役**（见 K9）：它们从「可读键」清单里
// 移走，不是因为上游契约删了字段（`pipeline.js` 的投影面还写着），而是因为**没有任何代码路径生产它们**。
// 留在清单里等于给「复活」发许可。
const FOLD_SUMMARY_KEYS_PINNED = [
  'budgetExhausted', 'inputTruncated', 'droppedRounds', 'droppedMessages', 'finishReason',
];
/** 已退役（0.30.0）：读它们 = 死分支。K9 盯这一半。 */
const FOLD_SUMMARY_KEYS_RETIRED = ['degradeKind', 'degradeReason', 'degraded'];

function enginePackageRoot() {
  const engineEntry = createRequire(import.meta.url).resolve('erix-agent');
  let root = path.dirname(engineEntry);
  while (root !== path.dirname(root)) {
    const pj = path.join(root, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') return root;
    root = path.dirname(root);
  }
  throw new Error('找不到已安装 erix-agent 的包根');
}

function keysReadFromStat() {
  const workerBody = read('worker.js');
  const w = workerBody.slice(workerBody.indexOf('export function foldDegradeNotice'));
  const fePath = path.join(RUNNER_DIR, '..', 'portal', 'frontend', 'src', 'composables', 'useEventStream.ts');
  const fe = fs.readFileSync(fePath, 'utf8');
  const f = fe.slice(fe.indexOf('export function compactionDegradeText'));
  const grab = (text, re) => [...text.slice(0, text.indexOf('\n}\n') > 0 ? text.indexOf('\n}\n') : 4000)]
    .join('').match(re) || [];
  const found = new Set([
    ...grab(w, /\bstat\.([A-Za-z][A-Za-z0-9]*)/g).map((m) => m.split('.')[1]),
    ...grab(f, /\bs\.([A-Za-z][A-Za-z0-9]*)/g).map((m) => m.split('.')[1]),
  ]);
  return [...found].sort();
}

test('K12 本站从 foldSummary 读的每个键都在上游契约的字段面里（引擎不发的键 = 一条永不响的告警）', (t) => {
  const keys = keysReadFromStat();
  // 0.30.0 起剩 5 个（退役的三个不在其中）；下限跟着收，但**不再往下**——再少就是抽取姿势坏了。
  assert.ok(keys.length >= 5, `从生产代码里只抠到 ${keys.length} 个键，正则或函数形状变了：${keys.join(', ')}`);
  for (const key of keys) {
    assert.equal(FOLD_SUMMARY_KEYS_RETIRED.includes(key), false,
      `${key} 是 0.30.0 已退役的键（引擎不再生产）⇒ 读它=死分支（K9 的反向面）`);
    assert.ok(FOLD_SUMMARY_KEYS_PINNED.includes(key),
      `${key} 不在手抄自上游契约（erix-agent main 的 host-consumer-contract.md「compaction stat」那一行）的清单里`
      + ' ⇒ 要么上游改名了，要么本站又在读一个引擎不发的键（unshrinkable 前例）');
  }
  // ↑ 这一半**永远跑**，是今天真正的防线。↓ 另一半是「装上 0.27.0 之后自动接管」的对账：
  const engineRoot = enginePackageRoot();
  const engineVersion = JSON.parse(fs.readFileSync(path.join(engineRoot, 'package.json'), 'utf8')).version;
  const contractPath = path.join(engineRoot, 'docs', 'host-consumer-contract.md');
  const contract = fs.existsSync(contractPath) ? fs.readFileSync(contractPath, 'utf8') : '';
  const hasSurface = contract.includes('foldSummary');
  const [maj, min] = String(engineVersion).split('.').map((n) => Number(n));
  const surfaceShouldExist = maj > 0 || min >= 27;
  // 跳过必须**有机判据**，不许用「引擎版本旧」这句话自证：这里按版本号判，并反过来钉住
  // 「低于 0.27.0 时契约确实还没有这一面」——上游若把字段面回移到老版本，这里就红。
  assert.notEqual(hasSurface, surfaceShouldExist ? false : true,
    `契约 foldSummary 字段面的存在性与引擎版本（${engineVersion}）对不上：shouldExist=${surfaceShouldExist}`);
  if (!hasSurface) {
    t.skip(`已安装引擎 ${engineVersion} 的契约还没有 foldSummary 字段面（<0.27.0 正常如此）；pin 到 0.27.0 后下面的逐键对账自动接管`);
    return;
  }
  for (const key of keys) {
    assert.ok(contract.includes('\`' + key + '\`'), `上游契约里没有 foldSummary.${key} ⇒ 本站在读一个不存在的键`);
  }
});

// ── ③ issue #440：`config.folding` 组层的工具结果旋钮 ────────────────────────────────
//
// **本段在 erix-agent 0.33.0（issue #530 / 工单 feat-261115-08）上翻了个面。**
// 历史上（#440，引擎 0.29.0 / 0.30.0，0.31/0.32 复核仍成立）引擎**不校**这几个叶子：
// 它们是 `CONFIG_NAMESPACE_SCHEMA.folding` 的合法叶子（不撞 unknown-leaf），但**不在**
// `CONFIG_LEAF_VALUE_RULE_PATHS` 里（当时只有 `run.stream` / `continuity.handoff`，0.30.0 起多一条
// `metadata.modelMetadata`）⇒ 没有值规则，读侧是裸 `??` 缺省 ⇒ `'6'` / `-1` / `null` 一路静默
// （`tool-result-ttl.js` 的 `Number.isFinite` 守卫 + `ttl <= 0 || minTokens <= 0` no-op ⇒
// **看起来配上了、其实是关的**）。所以当时本站自己加了一道 `assertFoldingToolResultKnobs`。
// 而那道校验的文案本来就写着「上游哪天登记了值规则，本站这道就该退成注释」——
// **0.33.0 就是那天**（上游 #718）：引擎启动期校 `folding.toolResultTtl` /
// `folding.toolResultFoldMinTokens` / `folding.context.keepRounds`，本站那道已按约定退役（D3）。
// 所以下面 K13 钉的方向从「引擎不校 ⇒ 本站要校」翻成「**引擎已在校 ⇒ 本站不得重复造**」；
// K14（原本站值域用例）随被退役的函数一起删——不留空壳、不把断言改成恒真。
// **261115-08 复核**（独立评审指出的建议修）：K14 一删，它覆盖过的输入形态（`null` / `NaN` /
// `Infinity` / 越过安全整数上界 / 省略 / 正整数上界 / 拼错键名）**一条断言都不剩了**——
// 上面 K13 的矩阵比 K14 窄。下面 **K13b / K13c / K13d** 把那份矩阵还给引擎这一侧：
// 逐条是在装着的 **erix-agent 0.33.0** 上跑真 `runToolLoop` 实测出来的（一次性探针
// `/tmp/probe-folding-knobs-261115-08.mjs`，未提交），**抛的钉文案、被接受的钉「被接受」**，
// 不预设引擎行为、不为凑红硬写「应该抛」——**不是**把退役的 `assertFoldingToolResultKnobs` 请回来。
// 值本身（6 / 8000）的「在场 + 等于 N」仍由 `runner/test/fold-strategy.test.js` 的 #440-B4/B5 钉着，
// **不依赖本站校验器**，所以退役没降低任何强度。
// ── K13 一族的共用工位：把一份 `config.folding` 原样交给**真引擎**，看它启动期说什么 ──
// 桦具只缺 `executeTool`（无工具 ⇒ 不会真调）⇒ 非法值必须在走到装配校验之前就把值错报出来；
// 合法值则一路走到「assembly port is missing methods: executeTool」——那恰好证明「过了值校验」。
// 所以这一族的通过判据是「**没报 folding 的错**」，而不是「run 成功」（桦具本来就不会成功）。
async function foldingIntakeError(folding) {
  try {
    await runToolLoop({
      provider: { async chat() { return { content: [{ type: 'text', text: 'x' }], stopReason: 'end_turn' }; } },
      tools: [],
      config: { input: { initialUserMessage: 'go' }, run: { maxRounds: 2, completion: false }, folding },
    });
    return null;
  } catch (error) { return error ?? new Error('引擎抛了个 undefined'); }
}

const foldingIntakeMessage = async (folding) => {
  const error = await foldingIntakeError(folding);
  return error === null ? null : String(error?.message ?? error);
};

// ──「引擎**接受**了这条输入」的**正向**判据（K13c 的清单与 K13d 的 `keepRound` 那条共用）──
// 实测（装着的 erix-agent 0.33.0）：只要这条输入**过了值校验**，桦具必然一路走到装配期，而那里
// 报的错**恒**是下面这一条 —— `undefined` / `{}` / `context: null` / `Number.MAX_SAFE_INTEGER` /
// worker 真传的那份 / `keepRound` 拼错，六种全是这一条，一字不差。
// 为什么这条 assembly 错**等价于**「过了值校验」：装配校验站在值规则**之后**（值错在 `config-namespace.js`
// 的 intake 层就抛，走不到装配），而桦具唯一缺的是 `executeTool` ⇒ 能报到装配期，说明值那一关已经放行。
//
// ⚠ 为什么必须写成**正向断言**（「等于这一条」），而不是原先那种排除式（「不等于某几条已知 folding 错」）：
//   排除式问的是「不是**我们现在认识的**这几条文案」⇒ 上游换措辞、换一张嘴、甚至**收紧**了输入面，
//   都落在排除集之外 ⇒ 非法/新被拒的输入被判「接受」，用例**照常绿**（假绿），而它其实什么都没钉住。
//   正向断言把预期收窄成「只接受这一种结果」：任何新文案当场红。逐字相等、不写成「包含」——这条错里
//   带着**缺的方法名**，哪天缺的是别的方法，说明桦具形状变了（本判据的前提没了），同样该红。
const ASSEMBLY_PORT_ERROR = 'assembly port is missing methods: executeTool';

/** 正向判定「引擎接受了这份 folding」：没抛错，**或**只抛了装配期那一条预期错。 */
async function assertFoldingAccepted(label, folding, note = '') {
  const error = await foldingIntakeError(folding);
  const msg = error === null ? null : String(error?.message ?? error);
  assert.ok(error === null || msg === ASSEMBLY_PORT_ERROR,
    `${label}：引擎没有**正向**判它「接受」（实得：${msg}）。两种可能都得查：`
    + '① 引擎收窄了输入面 ⇒ 这条输入现在真被拒了；② 装配期那条预期错的文案/类型变了 ⇒ 本桦具的前提没了。'
    + '⚠ 别退回去写「只要不是某几条已知 folding 错就算接受」——那种排除式在任何新文案下都假绿。'
    + (note ? `\n   引擎语义 / 若确属①该怎么办：${note}` : ''));
  return msg;
}

// 引擎值规则的文案模板（`config-namespace.js` 的 `nonNegativeIntegerConfigValueProblem`）：
// **完整路径** + `must be a non-negative integer` + `(received: <类型>)` 尾巴。
const foldingNonNegRe = (leafPath, received) => new RegExp(
  `config\\.folding\\.${leafPath.replace(/\./g, '\\.')} must be a non-negative integer \\(received: ${received}\\)`);

// 引擎导出的那两个表（值规则表 / 合法叶子表）——按**导出**读，不 grep 源码。
async function loadConfigNamespaceModule() {
  return import(pathToFileURL(path.join(enginePackageRoot(), 'src', 'loop', 'config-namespace.js')).href);
}

test('#440-K13 引擎已从 0.33.0 起自己校 folding.* ⇒ 本站不得再重复造那道闸', async () => {
  const root = enginePackageRoot();
  const ns = fs.readFileSync(path.join(root, 'src', 'loop', 'config-namespace.js'), 'utf8');
  // ① 三个叶子仍是合法叶子（否则「unknown option」那一层先拦，值规则根本没机会跑）
  assert.match(ns, /folding:\s*Object\.freeze\(\[/, 'folding 组不见了');
  for (const leaf of ['toolResultTtl', 'toolResultFoldMinTokens']) {
    assert.ok(ns.includes(`"${leaf}"`), `${leaf} 不再是 folding 组的合法叶子 ⇒ 引擎层变了，重看本判据`);
  }
  // ② 正向判据（方向与 0.32.0 及以前**相反**）：读引擎**导出的那张表**。
  //    不 grep 源码：同一份文件里还有一张 `CONFIG_LEAF_BINDING`（`"folding.toolResultTtl": "init"`），
  //    按字符串搜会把绑定表误判成值规则。⚠ 这张表的**值是函数**，而 `folding.context` 这一条
  //    在函数内部校 `value.keepRounds`（`config-namespace.js:617-622`）⇒ 表里的**键是
  //    `folding.context`**，不是 `folding.context.keepRounds`；但报错文案点的是完整路径
  //    （实测 `config.folding.context.keepRounds must be a non-negative integer`）。
  const nsModule = await loadConfigNamespaceModule();
  const rulePaths = Object.keys(nsModule.CONFIG_LEAF_VALUE_RULE_PATHS);
  for (const p of ['folding.toolResultTtl', 'folding.toolResultFoldMinTokens', 'folding.context']) {
    assert.ok(rulePaths.includes(p),
      `${p} 不在引擎值规则表里了（现表：${rulePaths.join(', ')}）：上游把 0.33 加的校验收回去了 ⇒ `
      + '本站那道重复闸要**重新加回来**（见 git 历史上的 assertFoldingToolResultKnobs），别只改本断言');
  }
  // ③ 真引擎行为（不只读表）：三个叶子各自把非法值**启动期抛**，而 `0` 合法（= 关掉）。
  //   真引擎桦具与「什么算过了值校验」见上面的 `foldingIntakeError`（K13b/c/d 共用同一份）。
  const leafCases = [
    ['toolResultTtl', { toolResultTtl: '6' }, /config\.folding\.toolResultTtl must be a non-negative integer/],
    ['toolResultTtl', { toolResultTtl: -1 }, /config\.folding\.toolResultTtl must be a non-negative integer/],
    ['toolResultTtl', { toolResultTtl: 1.5 }, /config\.folding\.toolResultTtl must be a non-negative integer/],
    ['toolResultFoldMinTokens', { toolResultFoldMinTokens: '8000' }, /config\.folding\.toolResultFoldMinTokens must be a non-negative integer/],
    ['toolResultFoldMinTokens', { toolResultFoldMinTokens: -1 }, /config\.folding\.toolResultFoldMinTokens must be a non-negative integer/],
    ['context.keepRounds', { context: { keepRounds: '3' } }, /config\.folding\.context\.keepRounds must be a non-negative integer/],
    ['context.keepRounds', { context: { keepRounds: -1 } }, /config\.folding\.context\.keepRounds must be a non-negative integer/],
  ];
  for (const [name, folding, re] of leafCases) {
    const msg = await foldingIntakeMessage(folding);
    assert.ok(msg !== null, `${name} 非法值竞没报错 ⇒ 引擎又不校了，本站那道闸要加回来`);
    assert.match(msg, re, `${name} 的报错形状与预期不同（实得：${msg}）⇒ 重看本判据`);
  }
  // `0` 必须**不报**值错（引擎语义：`0` = 关掉，不是非法值）。本站当年就是按这条定的口径，
  // 现在由引擎兑现；它要是变了，上面那族正则不会包住的，所以这里单独钉。
  for (const folding of [{ toolResultTtl: 0 }, { toolResultFoldMinTokens: 0 }, { context: { keepRounds: 0 } }]) {
    const msg = await foldingIntakeMessage(folding);
    assert.ok(msg === null || !/must be a non-negative integer/.test(msg),
      `${JSON.stringify(folding)} 被引擎拒了 ⇒ 「0 = 关掉」这条值域语义变了，重看本站与 #440 的口径（实得：${msg}）`);
  }
  // ④ 反向：本站**不再**自带那道重复校验（退役而不是默着没删）。
  const station = await import(pathToFileURL(path.join(RUNNER_DIR, 'lib', 'compact-knobs.js')).href);
  for (const gone of ['assertFoldingToolResultKnobs', 'collectFoldingToolResultProblems']) {
    assert.ok(!Object.hasOwn(station, gone),
      `compact-knobs.js 又导出了 ${gone} ⇒ 与引擎重复（两套校验重叠时，会错的是不生效的那一半）`);
  }
  const worker = fs.readFileSync(path.join(RUNNER_DIR, 'worker.js'), 'utf8');
  // 只查**代码面**（import 与调用），不查名字是否被提过：注释里写「已退役成注释」时必须点名它，
  // 否则下一个人不知道曾有过这道闸。与同仓 `stripComments` 那条口径同（注释不是引用）。
  assert.doesNotMatch(worker, /import[^\n]*\bassertFoldingToolResultKnobs\b/,
    'worker.js 又 import 了本站那道已退役的重复闸 ⇒ 与引擎重复');
  assert.doesNotMatch(worker, /\bassertFoldingToolResultKnobs\s*\(/,
    'worker.js 又把那层包装叫回来了 ⇒ 两套校验重叠时，会错的是不生效的那一半');
  // ⑤ 读侧仍是 `??` 缺省（引擎把非法值挡在启动期，而不是在读取处兼容垃圾）。
  //   上游哪天改成读取处宽容，上面②③ 会先红，这条只是把「为什么能放心删」的理由钉住。
  const orch = fs.readFileSync(path.join(root, 'src', 'loop', 'orchestrator.js'), 'utf8');
  assert.match(orch, /toolResultTtl \?\? TOOL_RESULT_TTL_DEFAULT/,
    '引擎读侧不再是 `??` 缺省 ⇒ 值校验可能已搬到别处，重看');
});

// ── K13b 值形态矩阵（被删 K14 的那一半覆盖，重钉在**引擎行为**上）────────────────────
// 逐条实测于装着的 erix-agent 0.33.0（探针脚本见上面段头的指针）。**结论：全部抛。**
// 尾巴 `(received: <类型>)` 也是钉的一部分（K13 原来的正则没有它）：那是
// `describeConfigValueType` 只报 `typeof` 的结果（`null`→`null`、数组→`array`）⇒
// ⚠ **NaN / ±Infinity / 越过安全整数上界三者文案里都写作 `received: number`**，
// 光看报错分不出是哪一种。所以「上界到底是 `Number.isSafeInteger` 还是 `Number.isInteger`」
// 只能靠 **K13b 的 `MAX_SAFE_INTEGER+1` 抛 + K13c 的 `MAX_SAFE_INTEGER` 过**这一对钉住
// （`Number.isInteger(2**53)` 是 true，只测「是不是整数」定不出这条界）。
test('#440-K13b folding 三叶子的非法值形态：null / NaN / ±Infinity / 溢出 / boolean / array 全抛（按实测钉文案形状）', async () => {
  const intakeRejections = [
    // [标签, folding, 实测文案（完整路径 + `(received: <类型>)` 尾巴）]
    ['toolResultTtl=null', { toolResultTtl: null }, foldingNonNegRe('toolResultTtl', 'null')],
    ['toolResultTtl=NaN', { toolResultTtl: NaN }, foldingNonNegRe('toolResultTtl', 'number')],
    ['toolResultTtl=Infinity', { toolResultTtl: Infinity }, foldingNonNegRe('toolResultTtl', 'number')],
    ['toolResultTtl=-Infinity', { toolResultTtl: -Infinity }, foldingNonNegRe('toolResultTtl', 'number')],
    ['toolResultTtl=MAX_SAFE_INTEGER+1',
      { toolResultTtl: Number.MAX_SAFE_INTEGER + 1 }, foldingNonNegRe('toolResultTtl', 'number')],
    // 下面两条不在 K14 的清单里，是探针顺手探到的**同一张嘴**（`received:` 报的就是 `typeof`）
    ['toolResultTtl=true', { toolResultTtl: true }, foldingNonNegRe('toolResultTtl', 'boolean')],
    ['toolResultTtl=[]', { toolResultTtl: [] }, foldingNonNegRe('toolResultTtl', 'array')],
    ['toolResultFoldMinTokens=null', { toolResultFoldMinTokens: null }, foldingNonNegRe('toolResultFoldMinTokens', 'null')],
    ['toolResultFoldMinTokens=NaN', { toolResultFoldMinTokens: NaN }, foldingNonNegRe('toolResultFoldMinTokens', 'number')],
    ['toolResultFoldMinTokens=Infinity', { toolResultFoldMinTokens: Infinity }, foldingNonNegRe('toolResultFoldMinTokens', 'number')],
    ['toolResultFoldMinTokens=MAX_SAFE_INTEGER+1',
      { toolResultFoldMinTokens: Number.MAX_SAFE_INTEGER + 1 }, foldingNonNegRe('toolResultFoldMinTokens', 'number')],
    ['context.keepRounds=null', { context: { keepRounds: null } }, foldingNonNegRe('context.keepRounds', 'null')],
    ['context.keepRounds=NaN', { context: { keepRounds: NaN } }, foldingNonNegRe('context.keepRounds', 'number')],
    ['context.keepRounds=Infinity', { context: { keepRounds: Infinity } }, foldingNonNegRe('context.keepRounds', 'number')],
    ['context.keepRounds=MAX_SAFE_INTEGER+1',
      { context: { keepRounds: Number.MAX_SAFE_INTEGER + 1 } }, foldingNonNegRe('context.keepRounds', 'number')],
    // `toolResultTtl` 上面已钉过 -Infinity / boolean / array：三个叶子共用同一张嘴
    // （`nonNegativeIntegerConfigValueProblem`），但**逐叶都钉**：上游完全可以只改一个叶子的入口。
    ['toolResultFoldMinTokens=-Infinity', { toolResultFoldMinTokens: -Infinity }, foldingNonNegRe('toolResultFoldMinTokens', 'number')],
    ['toolResultFoldMinTokens=true', { toolResultFoldMinTokens: true }, foldingNonNegRe('toolResultFoldMinTokens', 'boolean')],
    ['toolResultFoldMinTokens=[]', { toolResultFoldMinTokens: [] }, foldingNonNegRe('toolResultFoldMinTokens', 'array')],
    ['context.keepRounds=-Infinity', { context: { keepRounds: -Infinity } }, foldingNonNegRe('context.keepRounds', 'number')],
    ['context.keepRounds=true', { context: { keepRounds: true } }, foldingNonNegRe('context.keepRounds', 'boolean')],
    ['context.keepRounds=[]', { context: { keepRounds: [] } }, foldingNonNegRe('context.keepRounds', 'array')],
  ];
  for (const [label, folding, re] of intakeRejections) {
    const error = await foldingIntakeError(folding);
    assert.ok(error !== null,
      `${label} 竞被引擎接受 ⇒ 0.33.0 实测是**启动期抛**（本站 worker 传的是字面量 6 / 8000，`
      + '引擎放宽值域不会让本站变错，但会让「配了但没生效」那族事故回来）⇒ 重看 #440 与 K13 的口径');
    // 抛错类型也在账上（探针实测：这道闸抛的是**裸 TypeError**，`code` / `retryable` / `termination`
    // 全 `undefined`）。本站 `lib/termination.js:89` 的失败信封只看 `err?.code ?? 'failed'`、
    // `usage` 回退零值（同文件 `:105` 写的就是「runToolLoop 之前抛错」这一形）⇒ 不管引擎抛什么
    // 类型，终态都是 `failed`。**类型本身不在宿主的判据面上**，所以只有这条钉得住它：
    // 上游若换成带 `code` 的 KitError，终态与「能不能重试」就会静悄悄变掉，而这里先红。
    assert.ok(error instanceof TypeError,
      `${label} 的抛错类型不是 TypeError（实得 ${error?.constructor?.name}）`
      + '⇒ 报错渠道换了：带不带 `code` 会改变本站的终态与 retryable，重看 `lib/termination.js`');
    const msg = String(error?.message ?? error);
    assert.match(msg, re,
      `${label} 的报错形状与 0.33.0 实测不符（实得：${msg}）⇒ 上游改了文案或类型措辞，重看本判据`);
  }
});

// ── K13c **被引擎接受**的输入形态 ────────────────────────────────────────────────────
// 这一半是「不许为了凑红硬写成应该抛」的那一半。引擎语义逐条写清（实测，非推测）：
//   · `undefined` = **未设置**，不是非法值：`config-namespace.js` 的组层循环对
//     `leafValue === undefined` 直接 `continue`（实测行号 1237），`folding.context` 那条规则
//     也只在校 `raw !== undefined` 时才看子键（`:620`）⇒ 读侧退回默认
//     （`tool-result-ttl.js`：`TOOL_RESULT_TTL_DEFAULT = 2` / `TOOL_RESULT_FOLD_MIN_TOKENS_DEFAULT = 4000`）。
//     ⚠ 与 `null` **不同罪**：`null` 是「给了但给错」，K13b 已钉它抛。
//   · `folding.context = null` 也被接受：那条规则对**非对象** payload 直接早退（`:618`）
//     ⇒ 引擎把 `context` 当不透明盒子，只挖 `keepRounds` 一个子键。
//   · 正整数全接受，**上界是安全整数**（与 K13b 的 `+1` 抛配对）。
// ⚠ 「接受」的口径已改成**正向断言**（`assertFoldingAccepted`：没报错，或只报装配期那一条预期错）。
//   原先的排除式（「不带某几条已知 folding 文案就算接受」）在引擎**换文案**时会让非法输入被判接受（假绿）。
test('#440-K13c folding 旋钮被引擎**接受**的形态：省略 / undefined / context=null / 正整数 / 安全整数上界', async () => {
  // 本站 worker 真传的那一份：从 `worker.js` 的两对标记区间里**解析**出来，**不手抄**。
  // 手抄会漂移：worker 改了值（A/B 回退就是改那一处），这里旧值照旧绿 ⇒ 钉的是已经不存在的配置。
  // 两个区间各管一层（`config.folding` 叶子 / `config.folding.context` 子键），合成一份才是真输入。
  const ttlBlock = read('worker.js').match(TTL_MARKERS);
  assert.ok(ttlBlock,
    'worker.js 没有成对的 `/* #440:ttl-knobs:start|end */` 标记 ⇒ 解析不出真传的那份（与同目录 '
    + 'fold-strategy.test.js 的 B4/B5 同步：标记丢了先补那里）');
  const ctxBlock = read('worker.js').match(CTX_MARKERS);
  assert.ok(ctxBlock, 'worker.js 没有成对的 `/* #392:context-strategy:start|end */` 标记 ⇒ 同上');
  // context 区间里写着 `assertCompactContext(…)` ⇒ 注入**真**校验器再求值（与 K1 同一姿势）。
  // ⚠ 先把解析结果落成具名变量：下面这几条形状断言要用它，不能只在对象字面量里内联一次就完事。
  const workerContext = new Function('assertCompactContext', `return {${ctxBlock[1]}}`)(assertCompactContext).context;
  const workerFolding = {
    ...new Function(`return {${ttlBlock[1]}}`)(),
    context: workerContext,
  };
  // **这条（context 内层形状）与下面那条（顶层键集合）是两张不同的嘴，都要留着**：
  // 对象字面量里的 `context: workerContext` 是**无条件显式**加键的 ⇒ 区间一旦被清空、或写法从
  // `context: assertCompactContext({…})` 改成别的形，求值出来就是 `undefined`，而
  // `Object.keys({...{context: undefined}})` **照样含 `context`** ⇒ 只跑 K13c 时下面那条照绿（假绿）。
  // 所以这里钉的是「区间里**真的**解析出了 worker 传的那两个子键」。
  assert.ok(
    workerContext !== null && typeof workerContext === 'object' && !Array.isArray(workerContext)
      && Object.keys(workerContext).length > 0,
    `从 \`#392:context-strategy\` 标记区间里解析出的 context 是空的（实得：${JSON.stringify(workerContext)}，`
    + `键：${JSON.stringify(Object.keys(workerContext ?? {}))}）⇒ 这说明**标记区间解析空了 / 区间里的写法变了**`
    + '（`context:` 那行被删、或不再是 `context: assertCompactContext({…})` 那形），**不是引擎问题**'
    + '：本用例的输入是从源码解析的，区间一空就等于在测一份不存在的配置（顶层键那条挡不住这种空）');
  // worker 真传的就是这两个子键（值本身另由 fold-strategy B4/B5 与 K1 钉，这里只钉**在场与类型**）。
  assert.ok(Object.hasOwn(workerContext, 'strategy'),
    `解析出的 context 没有 \`strategy\` 子键（实得键：${JSON.stringify(Object.keys(workerContext))}）`
    + '⇒ 这说明标记区间解析空了 / 区间里的写法变了，不是引擎问题');
  assert.ok(Object.hasOwn(workerContext, 'keepRounds'),
    `解析出的 context 没有 \`keepRounds\` 子键（实得键：${JSON.stringify(Object.keys(workerContext))}）`
    + '⇒ 这说明标记区间解析空了 / 区间里的写法变了，不是引擎问题');
  assert.equal(typeof workerContext.keepRounds, 'number',
    `解析出的 \`context.keepRounds\` 不是数字（实得：${JSON.stringify(workerContext.keepRounds)}`
    + `，类型 ${typeof workerContext.keepRounds}）⇒ 这说明标记区间解析空了 / 区间里的写法变了，不是引擎问题`);
  assert.deepEqual(Object.keys(workerFolding).sort(), ['context', 'toolResultFoldMinTokens', 'toolResultTtl'],
    `从 worker 标记区间里解析出的 folding 形状不是预期那份（实得：${JSON.stringify(workerFolding)}）`);

  const intakeAcceptances = [
    ['整组省略（folding 都不给）', undefined, '一个叶子都没给 ⇒ 全用引擎默认（2 / 4000）'],
    ['整组空对象', {}, '同上：没有叶子就没有值规则要跑'],
    ['toolResultTtl 省略', { toolResultTtl: undefined }, '`undefined` 在 intake 层就是「没给」——**与 `null` 不同罪**'],
    ['toolResultFoldMinTokens 省略', { toolResultFoldMinTokens: undefined }, '同上'],
    ['context.keepRounds 省略', { context: { keepRounds: undefined } }, '规则只在 `raw !== undefined` 时校子键'],
    ['context = null', { context: null }, '非对象 payload 直接早退 ⇒ 当它「未设置」（本站 worker 真传的是对象）'],
    ['context = {}', { context: {} }, '空对象合法 ⇒ 折叠策略自己兜默认'],
    ['本站 worker 真传的那份（从源码标记区间解析）', workerFolding,
      '**这一条红了就是 worker 起跑即崩**（值本身的在场另由 fold-strategy B4/B5 钉）'],
    // 上界逐叶单独顶满（而不是三叶写在一起）：红了直接知道是哪个叶子改了上界。
    // `toolResultFoldMinTokens` 这一条是本轮补的：共用同一张嘴，但只钉两个叶子时第三个可以本身被收窄而没人看见。
    // 这一族与 K13b 的 `MAX_SAFE_INTEGER+1` 抛配对，才定得出「上界是 `isSafeInteger` 而非 `isInteger`」
    // （`Number.isInteger(2 ** 53)` 是 true）。
    ['toolResultTtl=MAX_SAFE_INTEGER', { toolResultTtl: Number.MAX_SAFE_INTEGER },
      '与 K13b 的 `toolResultTtl=MAX_SAFE_INTEGER+1` 抛配对'],
    ['toolResultFoldMinTokens=MAX_SAFE_INTEGER', { toolResultFoldMinTokens: Number.MAX_SAFE_INTEGER },
      '与 K13b 的同形溢出抛配对'],
    ['context.keepRounds=MAX_SAFE_INTEGER', { context: { keepRounds: Number.MAX_SAFE_INTEGER } },
      '与 K13b 的同形溢出抛配对（这条走的是 `folding.context` 那条规则，不是顶层叶子的入口）'],
  ];
  for (const [label, folding, why] of intakeAcceptances) {
    await assertFoldingAccepted(label, folding, why);
  }
});

// ── K13d 拼错键名走的是**名字闸**，不是值规则 ─────────────────────────────────────────
// 本站真实风险：`runner/worker.js` 的 `#440:ttl-knobs` 区间里这两个键名是**手写**的，
// 少个字母 / 大小写写错就会**退回引擎默认**（2 / 4000），而不是报错。原 K14 钉的是本站那句
// `unknown folding tool-result knob`；函数退役（D3）后这张嘴一度没人钉，本格把它按**引擎实测
// 文案**钉回来。合法叶子清单从引擎导出的 `CONFIG_NAMESPACE_SCHEMA.folding` 里读，**不手抄**。
test('#440-K13d folding 拼错键名由 unknown config option 那层拦（文案点名 + 列出真叶子；context 内层则是静默的）', async () => {
  const legalLeaves = (await loadConfigNamespaceModule()).CONFIG_NAMESPACE_SCHEMA?.folding;
  assert.ok(Array.isArray(legalLeaves) && legalLeaves.length >= 2,
    `读不到 CONFIG_NAMESPACE_SCHEMA.folding（实得：${JSON.stringify(legalLeaves)}）⇒ 提示面判据失效，重看`);
  for (const typo of ['toolResultTll', 'toolResultTTL', 'toolResultFoldMinToken']) {
    const error = await foldingIntakeError({ [typo]: 6 });
    assert.ok(error !== null,
      `拼错的键名 ${typo} 竞被静默接受 ⇒ 名字闸松了，本站要重新自己列白名单（#331 那根「没人读的光纤」会回来）`);
    assert.ok(error instanceof TypeError,
      `${typo} 的抛错类型不是 TypeError（实得 ${error?.constructor?.name}）`);
    const msg = String(error?.message ?? error);
    assert.match(msg, new RegExp(`unknown config\\.folding option: "${typo}"`),
      `${typo} 的报错没点名叫这个键（实得：${msg}）⇒ 文案换了或换成了泛泛一句，重看`);
    assert.ok(msg.includes(`(accepted: ${legalLeaves.join(', ')})`),
      `${typo} 的提示面没列出合法叶子全集（实得：${msg}）⇒ 上游改了提示，或本站抽 schema 的姿势坏了`);
    // 拼错键名**不该**同时冒一条值错：名字闸在值规则之前（`config-namespace.js:1224-1249`），
    // 一条错只说一件事，排查时才看不出是在猜。
    assert.doesNotMatch(msg, /must be a non-negative integer/,
      `拼错的 ${typo} 还叠了一条值错（实得：${msg}）⇒ 引擎把未知键也送去校值了，重看`);
  }
  // 两个错同时给 ⇒ **两条都报**（`; ` 连接），不是只报第一条。实测事实，对排查有用：
  // worker 里同时写错两个键时，一条消息就能看完，不必改一个跑一次。
  const bothMsg = await foldingIntakeMessage({ toolResultTll: 6, toolResultTtl: null });
  assert.match(bothMsg ?? '',
    /unknown config\.folding option: "toolResultTll"[^;]*; config\.folding\.toolResultTtl must be a non-negative integer \(received: null\)/,
    `两个错不再同时报了（实得：${bothMsg}）⇒ 上游改成「第一条就退」，重看排查口径`);
  // ⚠ 一个实测到的**不对称**（钉事实，也是「本站 K2 那层不许摸掉」的理由）：同一个手滑写在
  //   `config.folding` **组层**会被名字闸拦（上面那族），写进 `config.folding.context` **内层**
  //   （`keepRound` 少一个 s）引擎**放行**——那道 context 名字闸只认折叠摘要旋钮家族
  //   （`assembly-validators.js` 的 `isSummarizerKnobKey`，编辑距离 ≤2 才报），`keepRound` 不在其中
  //   ⇒ 当成宿主业务元数据静默通过。而 `worker.js` 的 `keepRounds: 6` 恰恰是手写的
  //   （`#392:context-strategy` 区间）⇒ 这个错法**唯一**的防线是本站 `assertCompactContext`（K2）。
  //   本条钉「引擎放行」这个事实：上游哪天把 `keepRounds` 收进 context 合法名单，这里会红，
  //   **那时**才谈得上把 K2 那条降级成注释。
  await assertFoldingAccepted(
    'context 内层拼错的 keepRound 竞被拦',
    { context: { strategy: 'fold-llm', keepRound: 6 } },
    '上游把 keepRounds 收进了 context 合法名单 ⇒ 本站 K2 那条可以降级（先改 K2 再改这里）');
  // 另一张嘴：`folding.context` 给**非对象**时文案是 `context must be an object`——**不带**
  // `config.folding.` 前缀（与 K13/K13b 那条完整路径不同形，排查时看不出它是哪个组的）。
  // 钉住这个差异：上游哪天补上前缀这里会红（那是改进，按实测改正则即可）。
  for (const bad of ['fold-llm', []]) {
    const error = await foldingIntakeError({ context: bad });
    const msg = String(error?.message ?? error);
    assert.ok(error instanceof TypeError, `context=${JSON.stringify(bad)} 没抛 TypeError（实得：${msg}）`);
    assert.match(msg, /^context must be an object$/,
      `context=${JSON.stringify(bad)} 的报错形状变了（实得：${msg}）⇒ 上游补了路径前缀或换了张嘴，按实测改正则`);
  }
});
