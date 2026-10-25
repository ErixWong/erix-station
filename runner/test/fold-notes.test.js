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

/** 引擎 `context.onFoldSummary` 的真实入参形态：`{ ...record.foldedFacts, round }`。 */
const payload = (over = {}) => ({
  text: '【已折叠】第 12–57 轮：改完 runner 的折叠策略；测试 360 通过；遗留问题是 jim 容器未重建。',
  source: 'statistical',
  chars: 184320,
  bytes: 2048,
  truncated: true,
  round: 57,
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
  assert.match(note.content, /184320/);
  assert.match(note.content, /引擎截断 是/);
  assert.match(note.content, /round 57/);
  assert.match(note.content, /run-abc/);
  assert.deepEqual(note.tags, [FOLD_NOTE_TAG, 'src:statistical']);
  assert.match(note.key, SAFE_KEY);
});

test('C6 无 text（引擎契约里本不该调用回调）⇒ 不写空注，只上报', async () => {
  for (const bad of [undefined, null, '', '   ', 42, {}]) {
    const tools = stubNoteTools();
    const events = [];
    const sink = createFoldNoteSink({ noteTools: tools, runId: 'r', onDeliveryError: (e) => events.push(e) });
    await sink.onFoldSummary({ source: 'statistical', chars: 10, truncated: false, round: 9, text: bad });
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
  const engineOptSrc = fs.readFileSync(
    path.join(RUNNER_DIR, 'node_modules/erix-agent/src/loop/option-normalization.js'), 'utf8');
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
