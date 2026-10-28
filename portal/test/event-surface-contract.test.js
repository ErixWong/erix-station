// issue #421 判据（跨端面）：erix-agent 承诺给宿主的事件全集 vs 本站三处白名单。
//
// 为什么放在 `portal/test`（而不是前端 spec）：这条要同时读**后端源码**与**前端源码**。前端
// vitest 的全局 environment 是 jsdom，读源码只能走 vite `?raw`，而 vite 的 fs 边界不许越出
// `portal/frontend`（issue #349 已为此换过一次写法）。跨边界的结构对账本来就该住在后端侧
// （同 `portal/test/termination-contract.test.js`：那边锁「常量 ↔ 文档枚举表 ↔ 引擎源码」）。
//
// 三处集合各自独立存亡（#288 教训、#371-A 又犯一次）：
//   ① 前端 `useEventStream.ts` 的 `EVENT_TYPES`（EventSource `addEventListener` 的唯一来源）
//      —— 漏 = **实时一条都收不到**（不报错、不警告）；
//   ② 前端 `HISTORY_REPLAY_TYPES` —— 漏 = **刷新后消失**；
//   ③ 后端 `http.js` 的 `HISTORY_EVENT_TYPES` —— 漏 = **刷新后后端根本不下发**。
// 写入侧不过白名单（`internal.js` 直接 `INSERT INTO run_events`），所以「库里没这条」永远不是借口：
// 漏接的事件只是躺在表里没人读。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORTAL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FE_EVENTS = path.join(PORTAL_DIR, 'frontend', 'src', 'composables', 'useEventStream.ts');
const HTTP = path.join(PORTAL_DIR, 'src', 'http.js');

/**
 * 引擎承诺给宿主的事件全集。来源（**不凭记忆**）：`erix-agent` `src/loop/orchestrator.js` 里
 * `LoopEvent` 的 `@property` 联合类型。上游改这个联合类型 ⇒ 本测红 ⇒ 逼本站重看承接面
 * （#421 那 5 类漏接就是这么找出来的）。
 */
const ENGINE_PROMISED_EVENTS = [
  'round_start', 'attempt', 'recovering', 'recovered', 'usage', 'tool_use', 'tool_result',
  'tool_replay_decision_required', 'round_end', 'compaction', 'final_guard',
  'persistence_capability_degraded', 'model_metadata_missing', 'resume_journal_skipped',
  'compaction_strategy_fallback', 'run_outcome',
];

/** #421 新接的四类诊断事件：三处都必须有它们。 */
const DIAGNOSTIC_EVENTS = [
  'compaction_strategy_fallback', 'model_metadata_missing',
  'persistence_capability_degraded', 'resume_journal_skipped',
];

/**
 * **显式豁免表**：订得到、但故意不进时间线也不进回放的类型，必须写理由。
 * `run_outcome`：每 run 一条的 run 级汇总，与 `run_end`（rounds / 终局）语义重叠，今天没有读者；
 * 放进回放只会让刷新时多一堆没人看的行。等 §12 台账 / 结算面板真用它时再接。
 */
const EXEMPT_FROM_TIMELINE = { run_outcome: '与 run_end 语义重叠且今天无读者（见上）' };

function literalsIn(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `源码里找不到锚点「${marker}」：集合被搬走/改名，本测会失去对象（宁可先红在这里）`);
  const after = source.slice(start);
  const end = after.indexOf('] as const') >= 0 && after.indexOf('] as const') < 4000
    ? after.indexOf('] as const')
    : after.indexOf(']);');
  assert.ok(end > 0, `锚点「${marker}」之后找不到集合结尾`);
  return new Set([...after.slice(0, end).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
}

function feSource() { return fs.readFileSync(FE_EVENTS, 'utf8'); }
function liveSet() { return literalsIn(feSource(), 'const EVENT_TYPES = ['); }
function replaySet() { return literalsIn(feSource(), 'const HISTORY_REPLAY_TYPES = new Set(['); }
function backendSet() { return literalsIn(fs.readFileSync(HTTP, 'utf8'), 'const HISTORY_EVENT_TYPES = new Set(['); }

test('S1 引擎承诺的 16 类全部在前端实时监听集合里（“订得到”不可豁免）', () => {
  const live = liveSet();
  assert.ok(live.size >= 20, `抽到的 EVENT_TYPES 只有 ${live.size} 项，抽取姿势可疑`);
  for (const type of ENGINE_PROMISED_EVENTS) {
    assert.ok(live.has(type), `实时监听里没有 ${type} ⇒ 浏览器一条都收不到（#421 的原病灶）`);
  }
  for (const [type, reason] of Object.entries(EXEMPT_FROM_TIMELINE)) {
    assert.ok(ENGINE_PROMISED_EVENTS.includes(type), `豁免表里的 ${type} 已不在承诺清单里：上游不发了，该删豁免`);
    assert.ok(reason.length > 6, `${type} 的豁免必须写理由——写了才算决定，没写就是漏`);
  }
});

test('S2 四类诊断事件三处齐全（漏任一处都是一种可见性不一致）', () => {
  const live = liveSet();
  const replay = replaySet();
  const back = backendSet();
  for (const type of DIAGNOSTIC_EVENTS) {
    assert.ok(live.has(type), `${type} 漏在前端 EVENT_TYPES ⇒ 实时收不到`);
    assert.ok(replay.has(type), `${type} 漏在前端 HISTORY_REPLAY_TYPES ⇒ 刷新后消失`);
    assert.ok(back.has(type), `${type} 漏在后端 HISTORY_EVENT_TYPES ⇒ 刷新后后端不下发`);
  }
});

test('S3 run_outcome 是写明了理由的豁免（订得到，但不进回放、不进后端历史）', () => {
  assert.ok(liveSet().has('run_outcome'), '订都订不到就不叫豁免，叫漏');
  assert.equal(replaySet().has('run_outcome'), false, 'run_outcome 已进前端回放 ⇒ 要么真接了，要么在刷没人看的行，请重读豁免理由');
  assert.equal(backendSet().has('run_outcome'), false, 'run_outcome 已进后端历史白名单 ⇒ 同上');
});

test('S4 前端回放集合与后端下发白名单**逐项相等**（不是子集：多一边少一边都是 bug）', () => {
  const replay = replaySet();
  const back = backendSet();
  const onlyFe = [...replay].filter((t) => !back.has(t)).sort();
  const onlyBe = [...back].filter((t) => !replay.has(t)).sort();
  assert.deepEqual(onlyFe, [], `前端能回放、后端却不下发（这些类型刷新后永远空白）：${onlyFe.join(', ')}`);
  assert.deepEqual(onlyBe, [], `后端下发、前端却不处理（白送的数据没人读）：${onlyBe.join(', ')}`);
});

test('S5 反向防推测键：前端接的诊断事件必须引擎真发（读已安装引擎源码）', (t) => {
  let entry;
  try { entry = fileURLToPath(import.meta.resolve('erix-agent')); } catch { return t.skip('未安装 erix-agent，无从对账'); }
  let root = path.dirname(entry);
  while (root !== path.dirname(root)) {
    const pj = path.join(root, 'package.json');
    if (fs.existsSync(pj) && JSON.parse(fs.readFileSync(pj, 'utf8')).name === 'erix-agent') break;
    root = path.dirname(root);
  }
  const loop = path.join(root, 'src', 'loop', 'orchestrator.js');
  if (!fs.existsSync(loop)) return t.skip('引擎源码里没有 src/loop/orchestrator.js（随包裁剪或改版）');
  const src = fs.readFileSync(loop, 'utf8');
  for (const type of DIAGNOSTIC_EVENTS) {
    assert.match(src, new RegExp(`type: "${type}"`),
      `引擎不再发 ${type} ⇒ 本站的前端分支是永不触发的死支（推测键），该删`);
  }
});
