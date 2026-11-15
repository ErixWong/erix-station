/**
 * issue #243（工单 fix-261116-03）：终局正文是「被文本化的工具调用」时的**事件链路行为**。
 *
 * 识别本身的判据在 `runner/test/final-text-toolcall.test.js`（钉着 dev 库真样本 `f4dfea1d…`）。
 * 这里钉的是把它送进界面剩下的四件事：
 *
 *   A. 命中 ⇒ `run_events` 里**恰好多一条** `textualized_tool_call`，位置对（排在 `run_end` 之前 ⇒
 *      时间线是「正文 → 中性提示 → 终态分隔条」）、载荷对（`chars` 由 portal 从收到的 final_text 自己算）、
 *      且**终态语义一个字没动**（`runs.status='finished'`、`termination.reason` 原样）。
 *   B. U2 重放不写第二条（终态幂等分支 + `client_event_id` + ON CONFLICT DO NOTHING 两道闸）。
 *   C. 没命中 ⇒ **零事件**（正常自然语言终局不该被这条信号刷屏；它是诊断，不是每条 run 的装饰）。
 *   D. 载荷校验不静默：写 `false`、脏 marker 一律 400；容器也不许经 U3 自己上报同名事件。
 *   E. 三处集合（后端下发白名单 + 前端两处订阅/回放集合）与 §5.3 登记**同步存在**——
 *      上游 erix-agent #182 的教训就是「实时看得见、刷新后消失」，而这条事件讲的恰恰是
 *      「用户刷新来看这次交付了什么」的那一刻。
 *
 * 为什么事件由 portal 在终态事务里合成，而不是容器经 U3 自己发：U3 的写入闸是「**租约有效**」
 * （`lease_epoch` + `lease_until > now()`），而收尾时 `finishRun` / `drainQueueAfterRun` 都会清
 * `claim_token`（#220 现查取证）⇒「活干完了、租约没了」是常态，容器自己发会被 409 `lease_lost` 挡掉。
 * 终态事务内由 portal 写才是必然成功那一侧（`attempt_killed` 的 reaper 分支同构）。
 *
 * 夹具：`fake-internal-pool.js` 的内存假池（docs/testing.md §2.1：不碰真实 DB）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimRun, postEvents, setRunState } from '../src/internal.js';
import { seedClaimable } from './fake-internal-pool.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** dev 库 `f4dfea1d-c439-4bba-ac34-4c86d7132bea` 的真样本（取自 `run_events.type='round_end'` 的 `final_text`）。 */
const SAMPLE_DSML = ['<｜｜DSML｜｜tool_calls>', '<｜｜DSML｜｜tool',
  '  name = "writeFile"',
  '  arguments = { "path": "docs/maintenance/task-ledger.md", "content": "…" }',
  '/>'].join('\n');

function harness() {
  const s = seedClaimable({ runId: 'run-243', sessionId: 'sess-243' });
  const ctx = {
    ...s,
    container: { id: s.containerId, user_id: s.userId },
    user: { id: s.userId, login: 'alice' },
  };
  return ctx;
}

async function toRunning(ctx) {
  const ticket = await claimRun(ctx.pool, { container: ctx.container, user: ctx.user, capacity: 1, holdMs: 10 });
  ctx.claimToken = ticket.claim_token;
  await setRunState(ctx.pool, {
    container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
    body: { state: 'running' },
  });
  return ctx;
}

const finishedBody = (finalText, extra = {}) => ({
  state: 'finished',
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  rounds: 32,
  termination: { reason: 'end_turn', rounds: 32, error_code: null },
  final_text: finalText,
  ...extra,
});

const diagOf = (pool) => pool.events.filter((e) => e.type === 'textualized_tool_call');
const payloadOf = (row) => (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload);

// ---------------------------------------------------------------------------
// A. 命中 ⇒ 事件真的落库，且没动终态
// ---------------------------------------------------------------------------

test('#243 A 命中 ⇒ 合成一条 textualized_tool_call，排在 run_end 之前，终态语义一字未动', async () => {
  const ctx = await toRunning(harness());
  const res = await setRunState(ctx.pool, {
    container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
    body: finishedBody(SAMPLE_DSML, { textualized_tool_call: true, textualized_tool_call_marker: '<｜｜DSML｜｜' }),
  });
  assert.equal(res.state, 'finished');

  const diag = diagOf(ctx.pool);
  assert.equal(diag.length, 1, '命中 ⇒ 恰好一条诊断事件');
  const runEnd = ctx.pool.events.find((e) => e.type === 'run_end');
  assert.ok(runEnd, 'run_end 仍在 —— 本改动是 additive，没有替换终态行');
  assert.ok(Number(diag[0].seq) < Number(runEnd.seq),
    `诊断事件必须排在 run_end 之前（实际 ${diag[0].seq} vs ${runEnd.seq}）⇒ 时间线「正文 → 提示 → 终态条」`);
  assert.equal(diag[0].client_event_id, 'run-243:final:textualized_tool_call',
    '幂等键必须固定（U2 重放靠它挡第二条）');
  assert.deepEqual(payloadOf(diag[0]), { chars: SAMPLE_DSML.length, marker: '<｜｜DSML｜｜' },
    'payload 只带 {chars, marker}：chars 由 portal 从收到的 final_text 算，不取容器报的数');

  // **终态语义没动**——这是本单的红线（「它不是失败」）。
  assert.equal(ctx.pool.runs[0].status, 'finished');
  const term = typeof ctx.pool.runs[0].termination === 'string'
    ? JSON.parse(ctx.pool.runs[0].termination) : ctx.pool.runs[0].termination;
  assert.equal(term.reason, 'end_turn', 'termination.reason 一个字都不能改');
  assert.equal(term.rounds, 32);
  assert.equal(ctx.pool.events.filter((e) => e.type === 'run_end').length, 1);
});

test('#243 A2 只给布尔不给 marker ⇒ 事件仍写，payload 不带 marker 键（不拿 undefined 占位）', async () => {
  const ctx = await toRunning(harness());
  await setRunState(ctx.pool, {
    container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
    body: finishedBody(SAMPLE_DSML, { textualized_tool_call: true }),
  });
  const diag = diagOf(ctx.pool);
  assert.equal(diag.length, 1);
  assert.deepEqual(payloadOf(diag[0]), { chars: SAMPLE_DSML.length },
    '没有 marker 就没有这个键 —— 前端拿到的形状要稳定');
});

test('#243 A3 载荷只有登记过的两个键（外来数据不许悄悄多带字段）', async () => {
  const ctx = await toRunning(harness());
  await setRunState(ctx.pool, {
    container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
    body: finishedBody(SAMPLE_DSML, { textualized_tool_call: true, textualized_tool_call_marker: '<｜Function' }),
  });
  const payload = payloadOf(diagOf(ctx.pool)[0]);
  assert.deepEqual(Object.keys(payload).sort(), ['chars', 'marker']);
  assert.equal(typeof payload.chars, 'number');
  assert.ok(payload.chars > 0 && payload.chars <= 200_000);
});

// ---------------------------------------------------------------------------
// B. 重放不写第二条
// ---------------------------------------------------------------------------

test('#243 B 终态后再收 U2（载荷不同 ⇒ 非幂等分支）⇒ 409，且诊断事件不会写第二条', async () => {
  const ctx = await toRunning(harness());
  const body = finishedBody(SAMPLE_DSML, { textualized_tool_call: true, textualized_tool_call_marker: '<tool_call' });
  await setRunState(ctx.pool, {
    container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken, body,
  });
  assert.equal(diagOf(ctx.pool).length, 1);
  // 换了 rounds/termination 的重放走不到 F4 幂等分支 ⇒ 会**再进一次终态记账**，
  // 这一条钉的就是「再进一次也不会多出一条诊断事件」（幂等键 + ON CONFLICT 那道闸）。
  await assert.rejects(
    () => setRunState(ctx.pool, {
      container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
      body: finishedBody(SAMPLE_DSML, {
        textualized_tool_call: true, textualized_tool_call_marker: '<tool_call',
        rounds: 33, termination: { reason: 'end_turn', rounds: 33, error_code: null },
      }),
    }),
    (e) => { assert.equal(e.status, 409); assert.equal(e.code, 'run_terminal'); return true; },
    '终态后不同载荷重放照旧 409（#277 语义不动）',
  );
  assert.equal(diagOf(ctx.pool).length, 1, '第二次终态尝试不得再多写一条诊断事件');
});

test('#243 B2 第二道闸也在：写入语句带固定 client_event_id + ON CONFLICT DO NOTHING', () => {
  // 幂等分支挡的是「同载荷重放」；万一有人把分支改松（允许终态后再写一次），靠唯一键兜底。
  const src = read('portal/src/internal.js');
  const at = src.indexOf("'textualized_tool_call', $5, now())");
  assert.ok(at > 0, 'internal.js 里合成该事件的 INSERT 锚点还在');
  const block = src.slice(at - 400, at + 500);
  assert.match(block, /ON CONFLICT \(run_id, client_event_id\) DO NOTHING/,
    '必须 ON CONFLICT DO NOTHING（#277 的先例：事件写入器会重试同一逻辑事件）');
  assert.match(block, /client_event_id|:final:textualized_tool_call/,
    '必须用固定的幂等键，而不是随机 id');
});

// ---------------------------------------------------------------------------
// C. 没命中 ⇒ 零事件
// ---------------------------------------------------------------------------

test('#243 C 正常自然语言终局（没带字段）⇒ 零诊断事件，只有 run_end', async () => {
  const normals = [
    '这次任务已完成。我调用了 shell 工具跑 npm test，55 个用例全绿；改动只有两个文件。',
    '判据：`if (a < b) return 1;` 这条比较在 42 上成立；另附 HTML 片段 `<div class="x">`。',
    '正文里引用过标记本身：`<｜｜DSML｜｜` 只是被引用的字符串，不算泄漏。',
    '',
  ];
  for (const text of normals) {
    const ctx = await toRunning(harness());
    await setRunState(ctx.pool, {
      container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
      body: finishedBody(text),
    });
    assert.deepEqual(diagOf(ctx.pool), [], `正常终局不该出事件：${JSON.stringify(text.slice(0, 24))}`);
    assert.equal(ctx.pool.events.filter((e) => e.type === 'run_end').length, 1,
      '但终态行必须照旧在（additive 不是替换）');
  }
});

// ---------------------------------------------------------------------------
// D. 载荷校验不静默
// ---------------------------------------------------------------------------

test('#243 D 脏载荷一律 400：写 false、非布尔、marker 非字符串 / 空串 / 超长', async () => {
  const cases = [
    [{ textualized_tool_call: false }, 'false 就是有人把契约读成了三态（缺席才是没命中）'],
    [{ textualized_tool_call: 'yes' }, '非布尔'],
    [{ textualized_tool_call: true, textualized_tool_call_marker: 42 }, 'marker 不是字符串'],
    [{ textualized_tool_call: true, textualized_tool_call_marker: '' }, '空串（界面上会是一条空提示）'],
    [{ textualized_tool_call: true, textualized_tool_call_marker: 'x'.repeat(121) }, '超长（外来字符串必须有上界）'],
  ];
  for (const [extra, why] of cases) {
    const ctx = await toRunning(harness());
    await assert.rejects(
      () => setRunState(ctx.pool, {
        container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
        body: finishedBody(SAMPLE_DSML, extra),
      }),
      (e) => {
        assert.equal(e.status, 400, `${why} ⇒ 期望 400，实际 ${e.status}`);
        assert.equal(e.code, 'validation_failed');
        assert.match(JSON.stringify(e.details ?? {}), /textualized_tool_call/, `${why} ⇒ 错误面必须点名是哪个字段`);
        return true;
      },
      why,
    );
    assert.deepEqual(diagOf(ctx.pool), [], `${why} ⇒ 400 之后不该留下事件行`);
    assert.notEqual(ctx.pool.runs[0].status, 'finished', `${why} ⇒ 脏载荷不得把 run 收成终态`);
  }
});

test('#243 D2 容器不许经 U3 自己上报同名事件（本站保留名）', async () => {
  const ctx = await toRunning(harness());
  await assert.rejects(
    () => postEvents(ctx.pool, {
      container: ctx.container, user: ctx.user, runId: ctx.runId, claimToken: ctx.claimToken,
      body: { events: [{ type: 'textualized_tool_call', payload: { chars: 1 } }] },
    }),
    (e) => {
      assert.equal(e.status, 400);
      assert.match(e.message, /textualized_tool_call/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// E. 三处集合 + 文档登记同步存在（源码级；端点级判据在 session-events-history.test.js）
// ---------------------------------------------------------------------------

test('#243 E 三处集合都含它（漏一边就是一种可见性不一致）', () => {
  const surfaces = [
    // 后端历史下发白名单 —— 漏 = 刷新后后端根本不下发。
    ['portal/src/http.js', 'const HISTORY_EVENT_TYPES = new Set([', ']);'],
    // 前端 EventSource 逐类型订阅的唯一来源 —— 漏 = 实时一条都收不到。
    ['portal/frontend/src/composables/useEventStream.ts', 'export const EVENT_TYPES = [', '] as const;'],
    // 前端历史回放闸门 —— 漏 = replayEvent 直接 return，刷新后这条消失。
    ['portal/frontend/src/composables/useEventStream.ts', 'const HISTORY_REPLAY_TYPES = new Set([', ']);'],
  ];
  for (const [rel, open, close] of surfaces) {
    const src = read(rel);
    const at = src.indexOf(open);
    assert.ok(at >= 0, `${rel} 的锚点 ${open} 还在`);
    const end = src.indexOf(close, at);
    assert.ok(end > at, `${rel} 的集合结尾锚点还在`);
    assert.match(src.slice(at, end), /'textualized_tool_call'/,
      `${rel} 必须含 textualized_tool_call（#288 老坑：三个集合独立存亡）`);
  }
});

test('#243 E2 docs/api/portal.md 登记了这条事件（§5.3 清单一行 + §4.4a 白名单一句）', () => {
  const docs = read('docs/api/portal.md');
  const rows = docs.split('\n').filter((l) => l.includes('`textualized_tool_call`'));
  assert.ok(rows.length >= 2,
    '§5.3 事件清单项与 §4.4a 白名单都要有它（漏 §5.3 会被 persistence-error-visibility 那族的文档对账判红）');
  assert.ok(rows.some((l) => /^\| 29 \|/.test(l)), '§5.3 必须是清单第 29 项（编号连续，别插中间）');
});
