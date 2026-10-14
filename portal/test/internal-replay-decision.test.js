// issue #288（缺陷 C）：「崩溃恢复时挂起工具没被重放」必须对用户可见，且**实时与刷新后两种可见性一致**。
//
// 事件来源与 `attempt_killed` 不同：它**不是宿主合成的**，而是引擎 additive LoopEvent
// （erix-agent 0.18.0 `orchestrator.js:2605-2614`）经 runner U3 上报后落 `run_events`。
// 所以本站的职责边界是「别在半路把它滤掉」：
//   ① U3 入库 + session SSE 实时推（本文件）；
//   ② 历史回放白名单（`session-events-history.test.js`）；
//   ③ 前端 `EVENT_TYPES`（实时具名监听）与 `HISTORY_REPLAY_TYPES`（回放）两处都在（本文件跨层钉）。
// 三层任意一层漏了，症状都是「实时看得见、刷新就丢」或反过来——AGENTS §8.8 那个坑，
// 本分支已用变异证明过一次，所以这里把三处一起钉住，而不是各测各的。
//
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + 假 res，不碰真实 DB/网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claimRun, setRunState, postEvents, registerSessionClient, sessionClientGoLive, unregisterSessionClient,
} from '../src/internal.js';
import { seedClaimable } from './fake-internal-pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const EVENT_TYPE = 'tool_replay_decision_required';
const DECISION_PAYLOAD = {
  tool_call_id: 'call-shell-1',
  engine_run_id: 's1', // 引擎的 runId = transcriptKey = sessionId（issue #81 P2）
  round: 3,
  name: 'shell',
  replay: 'unsafe',
  requires_host_decision: true,
  partial_output_available: false,
};

/** claim → running，返回可直接 postEvents 的现场（与 internal.test.js 的 U3 用例同一走法）。 */
async function runningAttempt(opts = {}) {
  const s = seedClaimable(opts);
  const container = { id: s.containerId, user_id: s.userId };
  const user = { id: s.userId, login: 'alice' };
  const ticket = await claimRun(s.pool, { container, user, capacity: 1, holdMs: 10 });
  await setRunState(s.pool, {
    container, user, runId: s.runId, claimToken: ticket.claim_token, body: { state: 'running' },
  });
  return { ...s, container, user, claimToken: ticket.claim_token };
}

function fakeRes() {
  return {
    written: [], ended: false, destroyed: false, writableEnded: false,
    write(chunk) { this.written.push(chunk); },
    end() { this.ended = true; },
  };
}

/** 从 SSE 帧里抠出 data 载荷（§5.1 wire：`id:` + `event:` + `data:`）。 */
function sseFrames(res, type) {
  return res.written.filter((frame) => frame.includes(`event: ${type}`));
}

test('#288③ 实时可见：runner 经 U3 上报的 tool_replay_decision_required 必须推 session SSE', async () => {
  const { pool, container, user, runId, claimToken, sessionId } = await runningAttempt();
  const live = fakeRes();
  const liveRec = registerSessionClient(sessionId, live);
  sessionClientGoLive(sessionId, liveRec); // 已补发完毕的在线客户端
  try {
    const r = await postEvents(pool, {
      container, user, runId, claimToken,
      body: {
        batch_id: 'b1',
        events: [
          { client_event_id: `${runId}:2:1`, type: 'tool_use', payload: { tool_call_id: 'call-shell-1', name: 'shell', input: {} } },
          { client_event_id: `${runId}:2:2`, type: EVENT_TYPE, payload: DECISION_PAYLOAD },
          {
            client_event_id: `${runId}:2:3`,
            type: 'tool_result',
            payload: { tool_call_id: 'call-shell-1', name: null, ok: false, result_digest: 'interrupted', duration_ms: null },
          },
        ],
      },
    });
    assert.equal(r.stored, 3, '三条都必须入库（U3 对本类型无白名单，未知/新类型一律原样透传）');

    const stored = pool.events.filter((e) => e.type === EVENT_TYPE);
    assert.equal(stored.length, 1, '落库恰一条');
    assert.deepEqual(JSON.parse(stored[0].payload), DECISION_PAYLOAD, 'payload 必须逐字段原样入库（宿主不改写）');

    const frames = sseFrames(live, EVENT_TYPE);
    assert.equal(frames.length, 1, 'session SSE 必须收到一条（实时路径不得按类型白名单过滤）');
    assert.match(frames[0], new RegExp(`^id: ${Number(stored[0].seq)}\\n`),
      'SSE 帧的 id 就是落库 seq（前端按 seq 归并/续传，§5.1）');
    const data = JSON.parse(frames[0].match(/\ndata: (.*)\n/)[1]);
    assert.equal(data.type, EVENT_TYPE);
    assert.equal(data.run_id, runId, '信封 run_id 是 station run id');
    assert.equal(data.seq, Number(stored[0].seq));
    for (const [key, value] of Object.entries(DECISION_PAYLOAD)) {
      assert.equal(data[key], value, `SSE 展开后的载荷字段 ${key} 必须与落库载荷同形状（两种可见性同源）`);
    }
    assert.equal(data.engine_run_id, sessionId,
      'engine_run_id 与信封 run_id 必须能区分开：前者是 transcriptKey=sessionId，不是 station run id');
  } finally {
    unregisterSessionClient(sessionId, liveRec);
  }
});

// ---------------------------------------------------------------------------
// 跨层一致性：同一事件在「后端可回放白名单 / 前端实时监听 / 前端回放」三处必须同时存在。
// 技法照 portal/test/termination-contract.test.js（node 直读前端源码做防漂移断言）。
// 缺任何一处的症状各不相同，所以三处分别钉：
//   缺 http.js HISTORY_EVENT_TYPES      ⇒ 刷新后消失
//   缺前端 HISTORY_REPLAY_TYPES         ⇒ 同上（前端侧的第二道过滤）
//   缺前端 EVENT_TYPES                  ⇒ EventSource 根本没挂这个具名监听 ⇒ 实时一条都收不到
// ---------------------------------------------------------------------------

const LAYERS = {
  'portal/src/http.js → HISTORY_EVENT_TYPES': {
    file: 'portal/src/http.js',
    block: (src) => src.slice(src.indexOf('const HISTORY_EVENT_TYPES = new Set(['), src.indexOf('const HISTORY_EVENT_DEFAULT_LIMIT')),
  },
  'portal/frontend/src/composables/useEventStream.ts → EVENT_TYPES（实时具名监听）': {
    file: 'portal/frontend/src/composables/useEventStream.ts',
    block: (src) => src.slice(src.indexOf('const EVENT_TYPES = ['), src.indexOf('const HISTORY_REPLAY_TYPES')),
  },
  'portal/frontend/src/composables/useEventStream.ts → HISTORY_REPLAY_TYPES（回放）': {
    file: 'portal/frontend/src/composables/useEventStream.ts',
    block: (src) => src.slice(src.indexOf('const HISTORY_REPLAY_TYPES = new Set(['), src.indexOf('export interface RunHistoryEvent')),
  },
};

test('#288③ 三处白名单/监听集合都含该事件（只加一边就是「实时收不到」或「刷新后消失」）', () => {
  for (const [label, { file, block }] of Object.entries(LAYERS)) {
    const src = read(file);
    const start = block(src);
    assert.notEqual(start, '', `${label}：锚点没找到（结构变了就更新本用例，别删断言）`);
    assert.match(start, new RegExp(`'${EVENT_TYPE}'`),
      `${label} 必须含 '${EVENT_TYPE}'。漏这处的后果见本文件头注释——三种漏法症状不同，`
      + '但都属于 AGENTS §8.8「同一事件两种可见性」那个已踩过两次的坑');
  }
});

test('#288③ 文档与实现同源：§5.3 类型清单与 §4.4a 白名单都列了该事件', () => {
  const doc = read('docs/api/portal.md');
  const section53 = doc.slice(doc.indexOf('### 5.3 事件信封完整类型清单'), doc.indexOf('## 6. 错误语义专题'));
  assert.match(section53, new RegExp(`\\| 15 \\| \`${EVENT_TYPE}\``), '§5.3 类型清单必须有第 15 行');
  assert.match(section53, /requires_host_decision/, '§5.3 必须写下宿主侧字段名（前端/联调按它对齐）');
  assert.match(section53, /engine_run_id/,
    '§5.3 必须点明 engine_run_id 与信封 run_id 的区别（否则下一个读者会当它们是同一个 run id）');
  const section44a = doc.slice(doc.indexOf('### 4.4a '), doc.indexOf('### 4.5 '));
  assert.match(section44a, new RegExp(`\`?${EVENT_TYPE}\`?`), '§4.4a 可回放白名单必须列出该事件');
});
