// issue #392（A 片）：本站**显式选折叠策略**的防漂移锁 + 行为实证。
//
// 为什么要有这个文件：本站此前连 `context` 都不传 ⇒ 超预算时引擎自己拿 `createSlidingWindowStrategy()`
// 兜底，而那条兜底**什么都不产出**（零摘要 / 零锚点 / 零占位 / 账本零事实）——真机（会话 `bdef6dd7`，
// erix-agent 0.25.0，195 轮 / 12 run）7 次整轮折叠全是 slidingWindow，`foldedSummary` 与
// `navigationRecord` 各 0 行、`summary` 恒 `"missing"`。改成 `fold-statistical` 是**一行**改动，
// 而一行改动最容易被后来人以「反正折叠会自己跑」为由顺手删掉 ⇒ 判据必须能让「删掉那行」变红。
//
// 技法照 runner/test/model-metadata.test.js：值从 **worker.js 源码里抠出来求值**，不在测试里另抄一份
// 字面量（否则「删掉 worker 那行」这条变异永远测不出来）；⚠ 不 import worker.js（顶层有 fork /
// process.on 副作用，工单明令）。
//
// 三条与本行绑定的口径（细节写在 worker.js 那段注释里，这里只钉成可执行的）：
//   ① 换策略**只**为了产出替代物，不改变折叠量（erix-agent#464 C 档未做）；
//   ② `context.keepRounds` 在 0.25.0 是**没人读**的键 ⇒ 出现它就是又一根 #331 式死光纤；
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

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

const STRATEGY_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;

/** 求值 worker 的 `context` 装配段（标记没了 = 装配点被搬走/删掉，判据先在这里红，不许静默失去对象）。 */
function workerContextOption() {
  const block = read('worker.js').match(STRATEGY_MARKERS);
  assert.ok(block,
    'worker.js 必须有一对配对的 `/* #392:context-strategy:start|end */` 标记：'
    + '没了就是本站又退回「不传 context ⇒ 引擎滑窗兜底 ⇒ 折叠是静默硬删」那条老路');
  // 本块里**只**该有 `strategy`。C 片（`onFoldSummary`）一度被塞在这里，而引擎从**顶层 options**
  // 解构它 ⇒ 折照折、注一条不写且不报错 ⇒ 又一根 #331 式死光纤。现由 C12/C14 钉住（两层各管各的）。
  return new Function(`return {${block[1]}}`)().context;
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

test('#392-A2 只传 strategy：出现没人读的 context 键就红（#331 死光纤守卫）', () => {
  const context = workerContextOption();
  assert.deepEqual(Object.keys(context).sort(), ['strategy'],
    '0.25.0 里除 strategy / recoveryHint / stubFor 之外的 context 键**没有任何读点**'
    + '（`orchestrator.js:1301-1305` 只转发 recoveryHint+stubFor；`:3090-3097` 的调用期白名单里也没有'
    + ' keepRounds）。要按预算裁剪请改**对象形态** `createFoldStatisticalStrategy({ keepRounds })`'
    + '（包根 index.js:41 有导出），别在这里加没人读的键');
});

test('#392-A3 行为实证：worker 抠出的那个名字，折叠后**必须**在消息流里留下替代物', async () => {
  const context = workerContextOption();
  const strategy = BUILTIN_COMPACTION_STRATEGIES[context.strategy]();
  const messages = makeRounds(12);
  const inputSet = new Set(messages);
  const result = await strategy.compact(messages, {});

  assert.ok(result.foldedRounds > 0, '前置：这一格必须真的折了（否则下面的断言是空断言）');
  assert.ok(Array.isArray(result.messages));

  const joined = result.messages.map(textOf).join('\n');
  assert.match(joined, /早期第 .*轮（共 .* 轮）已折叠/,
    '替代物第一句（范围句）缺席 ⇒ 又回到「模型不知道自己少了什么」');
  assert.match(joined, /工具足迹：shell×\d+/,
    '工具足迹缺席 ⇒ 替代物退化成一句话，模型无从判断该去哪找');

  // 「会进账本」的口径代理：orchestrator 判「本次折叠造出来、确实进了请求的那份摘要」用的是
  // **对象身份**（`!preCompactionMessages.has(message)`，0.25.0 :3250-3257），摘要必须是**新对象**
  // 才满足 ⇒ `fedSummaryText !== ""` 成立 ⇒ `record.foldedSummary` 落账。摘要若被拼进既有消息里，
  // 这条判据就不成立，账本又会变回 0 行。
  const carried = result.messages.filter((m) => !inputSet.has(m) && /已折叠/.test(textOf(m)));
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
