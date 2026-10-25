// issue #371-A：`persistence_error` 的**跨层一致性**哨兵（runner 侧的接线锁在
// `runner/test/persistence-error-channel.test.js`，端点行为锁在 `portal/test/session-events-history.test.js`，
// 本文件只管「三处集合 + 文档同源」这两件事）。
//
// 为什么单独立一个文件：这个事件的缺陷本体就是「同一件事在不同层面各说各话」——引擎报了、
// runner 没接、库里没有、界面不提、文档没写。每一处单独看都「不算错」，合起来就是非致命降级
// 全隐形（真机 `run_events` 该类型 0 行，2026-10-24 查得）。所以每一处都要有一格锁。
//
// 三处集合的技法照 `portal/test/internal-replay-decision.test.js`（node 直读前端源码做防漂移断言）：
//   缺 http.js HISTORY_EVENT_TYPES   ⇒ 刷新后消失
//   缺前端 HISTORY_REPLAY_TYPES      ⇒ 同上（前端侧的第二道过滤）
//   缺前端 EVENT_TYPES               ⇒ EventSource 根本没挂这个具名监听 ⇒ 实时一条都收不到
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const EVENT_TYPE = 'persistence_error';

const LAYERS = {
  'portal/src/http.js → HISTORY_EVENT_TYPES（刷新后可回放）': {
    file: 'portal/src/http.js',
    start: 'const HISTORY_EVENT_TYPES = new Set([',
    end: 'const HISTORY_EVENT_DEFAULT_LIMIT',
  },
  'portal/frontend/src/composables/useEventStream.ts → EVENT_TYPES（实时具名监听）': {
    file: 'portal/frontend/src/composables/useEventStream.ts',
    start: 'const EVENT_TYPES = [',
    end: 'const HISTORY_REPLAY_TYPES',
  },
  'portal/frontend/src/composables/useEventStream.ts → HISTORY_REPLAY_TYPES（回放）': {
    file: 'portal/frontend/src/composables/useEventStream.ts',
    start: 'const HISTORY_REPLAY_TYPES = new Set([',
    end: 'export interface RunHistoryEvent',
  },
};

test('#371-A 三处集合都含 persistence_error（只加一边就是「实时收不到」或「刷新后消失」）', () => {
  for (const [label, { file, start, end }] of Object.entries(LAYERS)) {
    const src = read(file);
    const from = src.indexOf(start);
    const to = src.indexOf(end);
    assert.ok(from >= 0 && to > from, `${label}：锚点没找到（结构变了就更新本用例，别删断言）`);
    const block = src.slice(from, to);
    assert.match(block, new RegExp(`'${EVENT_TYPE}'`),
      `${label} 必须含 '${EVENT_TYPE}'。三种漏法症状不同，但都属于 AGENTS §8.8「同一事件两种可见性」`
      + '——#288 已在同一个文件里踩过两次，这是第三次');
  }
});

test('#371-A 文档与实现同源：§5.3 有第 16 行、§4.4a 白名单也列了它', () => {
  const doc = read('docs/api/portal.md');
  const s53 = doc.slice(doc.indexOf('### 5.3 事件信封完整类型清单'), doc.indexOf('## 6. 错误语义专题'));
  assert.match(s53, /\| 16 \| `persistence_error`/, '§5.3 类型清单必须有第 16 行');
  // 三个最容易被人「顺手简化掉」的口径必须写在文档里，而不是只存在于代码注释：
  assert.match(s53, /diagnostics\.error/, '必须写明它走 diagnostics.error 而不是 onEvent（否则下一个人会去 onEvent 里找）');
  assert.match(s53, /engine_run_id/, '必须点明 engine_run_id ≠ station run id（#81 P2 老坑）');
  assert.match(s53, /stack.*不透传|stack` 刻意不透传/, '必须写明 stack 不进 payload（这是刻意取舍，不是漏字段）');
  const s44a = doc.slice(doc.indexOf('### 4.4a '), doc.indexOf('### 4.5 '));
  assert.match(s44a, /`persistence_error`/, '§4.4a 可回放白名单必须列出该事件');
});

test('#371-A 前端只给 fatal:false 一条中性文案，且双语都有这个键（缺一个语言就是界面漏字）', () => {
  const locales = 'portal/frontend/src/i18n/locales';
  for (const file of ['zh-CN.ts', 'en.ts']) {
    assert.match(read(`${locales}/${file}`), /persistenceDegraded\s*:/, `${file} 必须有 persistenceDegraded 键`);
  }
  const handler = read('portal/frontend/src/composables/useEventStream.ts');
  const block = handler.slice(handler.indexOf("case 'persistence_error'"), handler.indexOf("case 'recovering'"));
  assert.match(block, /d\.fatal !== false/, '必须只认 fatal:false（缺字段按致命处理，不许刷成中性）');
  assert.match(block, /onSep/, '非致命走中性分隔行；出现 onSysErr 就是把降级刷成了红');
  assert.ok(!/onSysErr/.test(block), '本 case 里不得出现 onSysErr');
});
