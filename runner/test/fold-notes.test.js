// issue #392（C 片）：折叠摘要 → 会话笔记 的投递判据。
//
// 这片要守的不变量只有一句：**折一次，记一次**。A 片让 `fold-statistical` 产出替代物，C 片负责把它
// 落成一条能排进时间线的笔记；两者之间断任何一环，用户侧感知就还是「静默硬删」——而这类断链在界面上
// 看不出来（笔记目录少几行，没人会去数）。所以判据必须能让「删掉接线」变红，而不只是能跑通。
//
// 三类判据，各挡一种真实漂移：
//   ① key 形态与唯一性——同 scope 下 key 就是笔记 id：固定 key ⇒ 第二个 run 的第一次折叠撞重复、注丢掉；
//      key 不过 store 的 SAFE_KEY ⇒ 被哈希成 `h<digest>`，`note_list` 里读不出时间顺序。
//   ② 投递失败不上抛——笔记是台账不是事实源，写注失败不该把用户那一轮打死（引擎侧同纪律：
//      `fold_summary_delivery` 只发 `persistence_error{fatal:false}`）。
//   ③ 接线本身（源码求值，技法同 fold-strategy.test.js：值从 worker.js 里抠出来求值，
//      不在测试里另抄字面量，否则「删掉 worker 那行」这条变异永远测不出来）。⚠ 不 import worker.js。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  FOLD_NOTE_TAG,
  foldNoteKey,
  deriveFoldNote,
  createFoldNoteSink,
} from '../lib/fold-notes.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');

// 与 erix-agent `src/store/notes.js:47` 同源（那边是唯一的真判据，这边是它的镜像）。
const SAFE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

const T0 = '2026-10-25T18:15:30.123Z';
const T1 = '2026-10-25T18:16:05.999Z';

/**
 * 引擎 `onFoldSummary` 的**真**入参形态——逐字取自真链路（`runToolLoop` + `fold-statistical`，
 * 0.26.0 上实测键面）：`{ text, source, strategy, bytes, fingerprint, round }`，被引擎夹断时多
 * `truncated:true` / `bytesBefore`，策略给出区间时多 `from`/`to`/`rounds`。
 * ⚠ **没有 `chars`**：旧夹具手写了 `chars: 184_320`，于是 `deriveFoldNote` 读它恒 `undefined`、
 * 生产上永远写「摘掉正文 ? 字」而单测一直绿（#331「没人读的光纤」的同形状）。夹具从此只喂真形状。
 */
const payload = (over = {}) => ({
  text: '【已折叠】第 12–57 轮：改完 runner 的折叠策略；测试 360 通过；遗留问题是 jim 容器未重建。',
  source: 'statistical',
  strategy: 'fold-statistical',
  bytes: 2048,
  truncated: true,
  bytesBefore: 41_000,
  fingerprint: 'sha256:9cc1a97d8742b8b506a6599c',
  round: 57,
  ...over,
});

/** erix-agent #485（已合 main、未发版）追加的三键。本站按「有就写、没有就不写」处理。 */
const payload485 = (over = {}) => payload({
  foldedRoundRange: { from: 12, to: 57 },
  foldedThrough: 57,
  foldedRoundCount: 46,
  from: 12,
  to: 57,
  rounds: 46,
  ...over,
});

function stubNoteTools({ throwOn } = {}) {
  const calls = [];
  return {
    calls,
    executors: async (name, input, context) => {
      calls.push({ name, input, context });
      if (throwOn) throw new Error(throwOn);
      return { ok: true, key: input.key };
    },
  };
}

// ── ① key：时间线可排 + 永不重复 ────────────────────────────────────────────────
test('C1 key 必须过 store 的 SAFE_KEY（不过就被哈希成 h<digest>，note_list 读不出顺序）', () => {
  const key = foldNoteKey({ nowIso: T0, round: 57, seq: 1 });
  assert.match(key, SAFE_KEY, `key=${key} 会被 safeKey() 换成 h<digest>`);
  assert.ok(key.length <= 128);
  // 时刻必须真在 key 里（承担时间线），且是 basic 形态（带 - : . 就过不了 SAFE_KEY）
  assert.ok(key.includes('20261025T181530Z'), key);
});

test('C2 key 能按字典序排出折叠先后（时间线的最低要求）', () => {
  const a = foldNoteKey({ nowIso: T0, round: 12, seq: 1 });
  const b = foldNoteKey({ nowIso: T1, round: 88, seq: 2 });
  assert.ok(a < b, `${a} 应排在 ${b} 之前`);
});

test('C3 同一时刻同一轮连折三次，三个 key 互不相同（固定 key = 第二、三条注直接丢掉）', () => {
  const keys = [1, 2, 3].map((seq) => foldNoteKey({ nowIso: T0, round: 57, seq }));
  assert.equal(new Set(keys).size, 3, keys.join(' | '));
  keys.forEach((k) => assert.match(k, SAFE_KEY));
});

test('C4 round 是怪值也不能崩、也不能退化成固定 key（round 来自引擎，不该由本站假设它总是整数）', () => {
  for (const round of [7, '7', null, undefined, 'a/b', -1]) {
    const key = foldNoteKey({ nowIso: T0, round, seq: 1 });
    assert.match(key, SAFE_KEY, `round=${String(round)} → key=${key}`);
  }
  assert.notEqual(foldNoteKey({ nowIso: T0, round: 'a/b', seq: 1 }), foldNoteKey({ nowIso: T0, round: 'c\\d', seq: 1 })
    ?? foldNoteKey({ nowIso: T0, round: 'a/b', seq: 1 }), '退化路径也要留着序号这根轴');
});

// ── ② 正文：这条注是唯一能回答「丢了什么、多大一块、谁折的」的东西 ──────────────
test('C5 正文带摘要本体 + 来源/规模/截断/轮次，tags 带 fold 与来源轴', () => {
  const note = deriveFoldNote({ payload: payload(), seq: 2, nowIso: T0, runId: 'run-abc' });
  assert.ok(note);
  assert.ok(note.content.includes('改完 runner 的折叠策略'), '摘要本体必须在正文里——原文已退出可见上下文');
  assert.match(note.content, /statistical/);
  assert.match(note.content, /2048 B/, '规模必须用引擎真给的 `bytes`（0.26.0 没有 `chars` 这个键）');
  assert.match(note.content, /夹断前 41000 B/, '被引擎夹断过就要说「夹断前多大」，否则丢了规模');
  assert.doesNotMatch(note.content, /正文 \?/, '不许出现「摘掉正文 ?」——那正是旧代码读不存在的 `chars` 的症状');
  assert.match(note.content, /策略 fold-statistical/, '来源轴之外还要写引擎策略名（前端 #392-D 同一个口径）');
  assert.match(note.content, /引擎截断 是/);
  assert.match(note.content, /第 57 轮及之前/, '没有区间信息时退回旧口径（不发「折走第 undefined–undefined 轮」）');
  assert.doesNotMatch(note.content, /水位线|本 run 累计/, '#485 的三键不存在时**整段不写**，不发 0 也不发 ?');
  assert.match(note.content, /run-abc/);
  assert.deepEqual(note.tags, [FOLD_NOTE_TAG, 'src:statistical']);
  assert.match(note.key, SAFE_KEY);
});

test('C6 无 text（引擎契约里本不该调用回调）⇒ 不写空注，只上报', async () => {
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    const tools = stubNoteTools();
    const events = [];
    const sink = createFoldNoteSink({ noteTools: tools, runId: 'r', onDeliveryError: (e) => events.push(e) });
    await sink.onFoldSummary({ source: 'statistical', bytes: 10, truncated: false, round: 9, text: bad });
    assert.equal(tools.calls.length, 0, `text=${String(bad)} 时不该写注（空注会在 note_list 里冒充已存档）`);
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, 'no_summary_text');
    assert.equal(events[0].fatal, false);
    assert.equal(events[0].phase, 'fold_summary_delivery');
  }
  assert.equal(deriveFoldNote({ payload: { text: '' }, seq: 1, nowIso: T0 }), null);
});

// ── ③ 投递：调用形态 + 失败不打死 run ─────────────────────────────────────────
test('C7 投递走 noteTools.executors(note_take, …)，且**不伪造作用域**（scopeRef/runId 由工厂绑定）', async () => {
  const tools = stubNoteTools();
  const sink = createFoldNoteSink({ noteTools: tools, runId: 'run-7' });
  await sink.onFoldSummary(payload());

  assert.equal(tools.calls.length, 1);
  const { name, input, context } = tools.calls[0];
  assert.equal(name, 'note_take');
  assert.equal(typeof context, 'object');
  assert.ok(!('scopeRef' in input) && !('runId' in input),
    'B 片把作用域绑在工厂上（scopeRef=sessionId）；这里再传一次就是伪造 __erix，会把注写回 run 目录');
  assert.equal(input.pinned, false, 'pinned 的唯一豁免是 memory，折叠摘要不算');
  assert.match(input.key, SAFE_KEY);
  assert.ok(input.content.includes('改完 runner 的折叠策略'));
});

test('C8 写注抛错 ⇒ onFoldSummary 不上抛，只报一条 fatal:false（台账失败不该打死用户那一轮）', async () => {
  const tools = stubNoteTools({ throwOn: 'ENOSPC: no space left on device' });
  const events = [];
  const sink = createFoldNoteSink({ noteTools: tools, runId: 'r', onDeliveryError: (e) => events.push(e) });
  await sink.onFoldSummary(payload());            // 不 reject 就是本片要的形状
  assert.equal(events.length, 1);
  assert.equal(events[0].fatal, false);
  assert.equal(events[0].phase, 'fold_summary_delivery');
  assert.match(events[0].message, /ENOSPC/);
  assert.match(events[0].key, SAFE_KEY);
});

test('C9 上报通道自己抛错也不传染（warn 链路坏了不能把 run 带下水）', async () => {
  const tools = stubNoteTools({ throwOn: 'boom' });
  const sink = createFoldNoteSink({ noteTools: tools, runId: 'r', onDeliveryError: () => { throw new Error('ipc closed'); } });
  await sink.onFoldSummary(payload());
  await sink.onFoldSummary(payload({ text: undefined }));
});

test('C10 notes 不可用（executors 不是函数）⇒ 整体不接线，而不是接一个每次必炸的 sink', () => {
  for (const noteTools of [undefined, null, {}, { executors: null }, { executors: 'not-a-fn' }]) {
    const sink = createFoldNoteSink({ noteTools, runId: 'r' });
    assert.equal(sink.enabled, false);
    assert.equal(sink.onFoldSummary, null);
  }
});

test('C11 多次折叠序号递增（seq 既进 key 也进正文，是「折一次记一次」的计数器）', async () => {
  const tools = stubNoteTools();
  const sink = createFoldNoteSink({ noteTools: tools, runId: 'r' });
  await sink.onFoldSummary(payload({ round: 20 }));
  await sink.onFoldSummary(payload({ round: 40 }));
  await sink.onFoldSummary(payload({ round: 60 }));
  const keys = tools.calls.map((c) => c.input.key);
  assert.equal(new Set(keys).size, 3, keys.join(' | '));
  assert.equal(sink.seq(), 3);
  assert.match(tools.calls[2].input.content, /第 3 次折叠/);
});

// ── ④ 接线本体（删掉 worker 那一行必须变红） ──────────────────────────────────
const CTX_MARKERS = /\/\* #392:context-strategy:start \*\/([\s\S]*?)\/\* #392:context-strategy:end \*\//;
const OPT_MARKERS = /\/\* #392:C-onFoldSummary:start \*\/([\s\S]*?)\/\* #392:C-onFoldSummary:end \*\//;

/** 求值 worker 的**顶层** options 片段（引擎从 options 解构 onFoldSummary，不是从 context）。 */
function topLevelOptionWith(foldNoteSink) {
  const block = read('worker.js').match(OPT_MARKERS);
  assert.ok(block, 'worker.js 里 `#392:C-onFoldSummary` 标记没了：C 片的接线被搬走或删除');
  return new Function('foldNoteSink', `return {${block[1]}}`)(foldNoteSink);
}

test('C12 worker 真的把 onFoldSummary 接在**顶层 options**（有 sink 时），sink=null 时不接', () => {
  const sink = { onFoldSummary: async () => {} };
  const opts = topLevelOptionWith(sink);
  assert.equal(opts.onFoldSummary, sink.onFoldSummary,
    '没接上就是「摘要产出来就扔」：A 片的收益停在引擎内部，用户侧仍是静默硬删');
  assert.deepEqual(Object.keys(topLevelOptionWith(null)), [],
    'notes 不可用时不该接一个必炸的回调');
});

test('C14 【防回装】onFoldSummary 不得被塞回 context——引擎只从顶层 options 读它', () => {
  // 真实现场（本单自己踩的）：把它放进 `context` 后，折叠照跑、`record.foldedFacts` 照落账、
  // 注**一条也不写**，且不报错——#331 那根「没人读的光纤」原样重现。判据不抄进测试：
  // 直接与**已安装引擎**的选项白名单比对（上游改名/搬走 ⇒ 本格红，与 termination-contract 同族）。
  // 路径不拼！根 `npm test` 的 glob **也覆盖 `runner/test/`**（CI 里根套件那 1641 格就含本文件），而那时
  // `runner/node_modules` 可能还没装（runner 安装在第③步）⇒ 拼路径会 ENOENT。用 `import.meta.url`
  // 走**与本文件 `import { runToolLoop } from 'erix-agent'` 完全同源**的解析，拿到那份引擎再读文件。
  // 用 `import.meta.url` 走**与本文件 `import { runToolLoop } from 'erix-agent'` 完全同源**的解析。
  // ⚠ 不能用 `resolve('erix-agent/package.json')`：引擎的 `exports` 只列了 `.` / `./tools` /
  // `./contract-tests`，没列 `./package.json` ⇒ `ERR_PACKAGE_PATH_NOT_EXPORTED`（实测）。所以下面
  // 解析主入口，再向上找到 `name === 'erix-agent'` 的包根。
  const engineEntry = createRequire(import.meta.url).resolve('erix-agent');
  let engineRoot = path.dirname(engineEntry);
  while (engineRoot !== path.dirname(engineRoot)) {
    const pj = path.join(engineRoot, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') break;
    engineRoot = path.dirname(engineRoot);
  }
  const engineOptSrc = fs.readFileSync(
    path.join(engineRoot, 'src/loop/option-normalization.js'), 'utf8');
  assert.match(engineOptSrc, /"onFoldSummary",/,
    '已安装引擎的 RUN_TOOL_LOOP_OPTION_NAMES 里找不到 onFoldSummary ⇒ 上游改了/移了它，'
    + 'worker 的接线口径与本文件需同步重核');

  const ctxBlock = read('worker.js').match(CTX_MARKERS);
  assert.ok(ctxBlock, 'worker.js 的 #392 context 装配标记没了');
  assert.ok(!/onFoldSummary/.test(ctxBlock[1]),
    'onFoldSummary 又被塞回 context 了——那里没人读它，折叠会**静默**不投递（不报错、不红、只是没注）');
});

test('C13 接线的前置门是「executors 可用」，不是「runId 存在」之类会误伤会话作用域的条件', () => {
  const src = read('worker.js');
  const block = src.match(/\/\* #392:C-fold-notes:start \*\/([\s\S]*?)\/\* #392:C-fold-notes:end \*\//);
  assert.ok(block, 'worker.js 里 `#392:C-fold-notes` 标记没了：C 片的装配点被搬走或删除');
  assert.match(block[1], /typeof noteTools\.executors === 'function'/);
  assert.doesNotMatch(block[1], /scopeRef\s*:/,
    '投递处不得再传作用域：B 片已把 scopeRef 绑成 sessionId，这里传第二次就是伪造 __erix');
});

// ── ④ 规模与范围口径：只写引擎真给的东西（erix-agent #485 / #469 宿主侧后续）────────
test('C15 规模走引擎真给的 `bytes`；`chars` 只在引擎哪天真给了才写（旧代码读一个不存在的键，生产永远写「?」）', () => {
  // 真形状（0.26.0）：无 chars ⇒ 必须写清字节数，不能退化成「?」或「规模未知」
  const real = deriveFoldNote({ payload: payload({ truncated: false, bytes: 20_000 }), seq: 1, nowIso: T0, runId: 'r' });
  assert.match(real.content, /摘掉正文 20000 B/);
  assert.doesNotMatch(real.content, /规模未知|\?/);
  // 前向兼容：哪天真给了 chars，就一并写上
  const withChars = deriveFoldNote({ payload: payload({ truncated: false, chars: 65_000, bytes: 20_000 }), seq: 1, nowIso: T0, runId: 'r' });
  assert.match(withChars.content, /65000 字 \/ 20000 B/);
  // 两个都没有（引擎改了形状）⇒ 老实说「规模未知」，不许编一个 0
  const noSize = deriveFoldNote({ payload: { text: 'x', source: 'llm', round: 3 }, seq: 1, nowIso: T0, runId: 'r' });
  assert.match(noSize.content, /摘掉正文 规模未知/);
});

test('C16 #485 三键到位时写全「第 a–b 轮 · 水位线 · 本 run 累计」，且累计必须标 run 作用域', () => {
  const note = deriveFoldNote({ payload: payload485(), seq: 3, nowIso: T0, runId: 'run-9' });
  assert.match(note.content, /折走第 12–57 轮（46 轮）/);
  assert.match(note.content, /水位线到第 57 轮/);
  assert.match(note.content, /本 run 累计折 46 轮/);
  assert.doesNotMatch(note.content, /第 57 轮及之前/, '有区间信息时不该退回「及之前」这种含糊口径');
  // 契约（host-consumer-contract #479）：foldedRoundCount 是 **run 作用域**，resume 后归零 ⇒
  // 写成「会话累计」就是把一个会归零的数说成不会归零的数。
  assert.doesNotMatch(note.content, /会话累计|累计折 46 轮（会话/);
});

test('C17 只有平铺 `from`/`to`（引擎 buildFoldedFacts 自己的形状）时也写范围；两者都缺才退回旧口径', () => {
  const flat = deriveFoldNote({ payload: payload({ from: 4, to: 9 }), seq: 1, nowIso: T0, runId: 'r' });
  assert.match(flat.content, /折走第 4–9 轮/);
  const nestedWins = deriveFoldNote({ payload: payload({ from: 4, to: 9, foldedRoundRange: { from: 1, to: 3 } }), seq: 1, nowIso: T0, runId: 'r' });
  assert.match(nestedWins.content, /折走第 1–3 轮/, '两种形状同时在场时以 #485 的嵌套键为准（它与轮记录同源）');
  const neither = deriveFoldNote({ payload: payload({ from: undefined, to: undefined }), seq: 1, nowIso: T0, runId: 'r' });
  assert.match(neither.content, /第 57 轮及之前/);
  // 半截区间（引擎只给了 from）不许拼出「第 12–undefined 轮」
  const half = deriveFoldNote({ payload: payload({ from: 12, to: undefined }), seq: 1, nowIso: T0, runId: 'r' });
  assert.doesNotMatch(half.content, /undefined/);
});

test('C18 【防再犯】已安装引擎的 buildFoldedFacts 确实给 `bytes` 而不给 `chars`（口径漂移就红）', () => {
  // 与 C14 同一手法：不信注释、不信夹具，直接读**装在这个 worktree 里的引擎源码**。
  // 上游哪天真的加了 `chars` 或改了规模键，这里会红 ⇒ 逼着我们重看一遍上面的口径。
  const engineEntry = createRequire(import.meta.url).resolve('erix-agent');
  let engineRoot = path.dirname(engineEntry);
  while (engineRoot !== path.dirname(engineRoot)) {
    const pj = path.join(engineRoot, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') break;
    engineRoot = path.dirname(engineRoot);
  }
  const journal = fs.readFileSync(path.join(engineRoot, 'src/compact/fold-summary-journal.js'), 'utf8');
  const body = journal.slice(journal.indexOf('export function buildFoldedFacts'));
  const returned = body.slice(0, body.indexOf('\n}\n') > 0 ? body.indexOf('\n}\n') : 4000);
  assert.match(returned, /bytes:\s*bytesOf\(text\)/, '引擎的规模键已不是 bytes ⇒ 本站注文案的规模口径要重定');
  assert.doesNotMatch(returned, /^\s*chars:/m, '引擎开始给 chars 了 ⇒ 本站该改回以字数为主口径');
});
