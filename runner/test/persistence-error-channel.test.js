// issue #371-A：引擎落盘失败事件 `persistence_error` 的 runner 侧接线与回归锁。
//
// 缺陷本体（真机 + 代码双向坐实，2026-10-24）：引擎把落盘失败经 **`diagnostics.error`** 上报
//（`orchestrator.js:873` 起，0.23.0 就有），而本站 `worker.js` **从来没传 `diagnostics`**
// ——只有 `onPersistenceError`，那条只拿得到 `Error` 对象、且只落一条 IPC warn 日志。后果是
// 事件整条丢弃：真机全库 `SELECT count(*) FROM run_events WHERE type='persistence_error'` = **0 行**。
// 于是 erix-agent#461 的「剥掉折叠归档重试一次」这条**非致命降级**在界面上彻底隐形：
// run 正常跑完、绿色、有正文，只是再没有人知道某一轮的原文归档没存进去。
//
// 三格各钉一层，缺一层的后果不同：
//   ① 真引擎跑一遍 ⇒ 钉「通道存在 + 字段名是真的」（映射不是在读幻影字段；上游改名这里先红）。
//   ② `loopEventPayload` 映射 ⇒ 钉 `fatal` 归一、`stack` 不透传、`runId` 落名 `engine_run_id`。
//   ③ worker.js 源码哨兵 ⇒ 钉「接线还在」：删掉 `diagnostics` 那一段 ⇒ 事件又变回 0 行，本格变红。
//      （行为格①**不会**因为摘掉本站接线而变红——它自己传了 diagnostics，所以必须有③。）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runToolLoop } from 'erix-agent';
import { loopEventPayload } from '../worker.js';

const RUNNER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(RUNNER_DIR, rel), 'utf8');
const TRANSCRIPT_KEY = 'sess-persistence-error-1'; // 引擎 store key = transcriptKey = sessionId（#81 P2）

/** 引擎要求的最小 store：写必炸，其余空转（本用例只关心 appendRound 失败之后的事）。 */
function brokenStore() {
  return {
    async appendRound() { throw new Error('fake: host rejected the round (1MB cap)'); },
    async load() { return null; },
    async saveRunSnapshot() { return undefined; },
    async loadLatestRunSnapshot() { return null; },
  };
}

function textProvider() {
  return {
    async chat() { return { content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' }; },
  };
}

// ---------------------------------------------------------------------------
// ① 真引擎：通道与字段名确实存在
// ---------------------------------------------------------------------------
test('① 真引擎在 store 写失败时经 diagnostics.error 上抛 persistence_error（fatal/operation/port 字段是真的）', async () => {
  const seen = [];
  await runToolLoop({
    provider: textProvider(),
    initialUserMessage: 'go',
    completion: false,
    tools: [],
    maxRounds: 2,
    store: brokenStore(),
    runId: TRANSCRIPT_KEY,
    // 引擎的装配口缺一格就整条 run 起不来（实测 `assembly port is missing methods: executeTool`
    // ——那样 diagnostics 一次都不会被调，①会变成「通道不存在」的假红，所以必须给全）
    executeTool: async () => 'ok',
    // 重试与退避压到最小：本用例要的是「失败之后上报了什么」，不是重试次数
    retry: { attempts: 1, backoffBaseMs: 0, backoffMaxMs: 0 },
    diagnostics: { error: (event) => seen.push(event) },
  }).catch(() => {}); // 落盘失败会让 run 以 persistence 失败收场，终态本身不是本格的断言对象

  assert.ok(seen.length >= 1,
    '引擎必须调 diagnostics.error —— 这是本站接线的前提（0.23.0 `orchestrator.js:873` 起的通道）。'
    + '它变成非公开通道/改名时本格先红，提醒重看下面两格，不要让前端去读一个引擎不再写的字段');
  const event = seen[0];
  assert.equal(event.type, 'persistence_error');
  assert.equal(event.fatal, true,
    'store 写失败是**致命**的（`fatal:false` 是另一条：宿主端口桥 0.23.0 `:895` / #461 剥归档重试）');
  assert.equal(event.operation, 'appendRound', 'operation 必须是失败的方法名——前端与排障都靠它分流');
  assert.equal(event.port, 'transcript', 'port 默认 transcript（引擎 `persistenceErrorEvent` 的默认值）');
  assert.equal(typeof event.error?.message, 'string');
});

// ---------------------------------------------------------------------------
// ② 映射：字段白名单 + 归一（前端只认这份形状）
// ---------------------------------------------------------------------------
const ENGINE_EVENT = {
  type: 'persistence_error',
  port: 'notes',
  phase: 'write',
  operation: 'saveSemantic',
  runId: TRANSCRIPT_KEY,
  fatal: false,
  sideEffect: 'retry-strip-archive',
  error: { name: 'PayloadTooLarge', message: 'round 请求体超过 1048576 字节上限', stack: 'Error\n at engine/frame\n…' },
  ts: '2026-10-24T10:00:00.000Z',
};

test('② 映射：payload 是前端与 run_events 的唯一契约面（fatal 归一 / stack 不透传 / runId 改名）', () => {
  const p = loopEventPayload(ENGINE_EVENT);
  assert.deepEqual(p, {
    port: 'notes', phase: 'write', operation: 'saveSemantic',
    engine_run_id: TRANSCRIPT_KEY, fatal: false, sideEffect: 'retry-strip-archive',
    error: { name: 'PayloadTooLarge', message: 'round 请求体超过 1048576 字节上限' },
    ts: '2026-10-24T10:00:00.000Z',
  });
  // `run_id` 绝不能出现：U3 行的 run_id 列已是 station 口径，同名不同义就是 #81 P2 那个坑
  assert.ok(!('run_id' in p), 'payload 里不得有 run_id（引擎那个是 transcriptKey，落名 engine_run_id）');
  assert.ok(!('stack' in (p.error ?? {})), 'stack 是宿主日志的东西，不进 UI payload');
});

test('② fatal 缺字段/脏值一律按**致命**处理（宁可报重，不可把真失败刷成灰）', () => {
  assert.equal(loopEventPayload({ ...ENGINE_EVENT, fatal: undefined }).fatal, true);
  assert.equal(loopEventPayload({ ...ENGINE_EVENT, fatal: 'no' }).fatal, true,
    '只有真 `false` 才算非致命；字符串/undefined/对象都落致命侧（前端据此不刷中性行）');
  assert.equal(loopEventPayload({ ...ENGINE_EVENT, fatal: false }).fatal, false);
});

test('② 脏事件不许把 [object Object]/undefined 渗进用户可见面', () => {
  const p = loopEventPayload({ type: 'persistence_error', operation: {}, port: 0, error: 'boom' });
  assert.equal(p.operation, 'unknown', 'operation 非字符串 → unknown（前端拿它填文案，空串会拼出怪话）');
  assert.equal(p.port, 'transcript');
  assert.deepEqual(p.error, { name: 'Error', message: '' }, 'error 不是对象时给空串，不 String(对象)');
  assert.equal(p.engine_run_id, null);
});

// ---------------------------------------------------------------------------
// ③ 源码哨兵：接线必须在（①自传 diagnostics，摘掉本站接线行为格不会红，所以必须有这一格）
// ---------------------------------------------------------------------------
test('③ worker.js 必须把 diagnostics.error 接到 emitEvent（删掉那一段 = 事件又变回全库 0 行）', () => {
  const src = read('worker.js');
  const hits = src.match(/\bdiagnostics\s*:\s*\{/g) ?? [];
  assert.equal(hits.length, 1, `runToolLoop 只应有一处 diagnostics 接线（实际 ${hits.length}）`);
  const block = src.slice(src.indexOf('diagnostics: {'), src.indexOf('diagnostics: {') + 600);
  assert.match(block, /emitEvent\(/, 'diagnostics.error 必须把事件发到 U3（只写日志就是本单缺陷本体）');
  assert.match(block, /loopEventPayload\(/, '必须走 ② 那个映射，不许在接线处手搓第二份 payload');
});
