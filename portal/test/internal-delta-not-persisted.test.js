// issue #502（perf(db)：delta 不落库）**写入侧**的单测（fake pool，不碰真库；docs/testing.md §2.1）。
//
// 覆盖的判据（issue #502 §2 与工单契约 D-1/D-2/D-8）：
//   判据 1 「一轮事件表的行数与喂进去多少条 delta 无关」→ 10 条 vs 1000 条**行数相同**
//   判据 2 的后端那一半（前端打字机由真机 e2e 负责）→ 碎片不落库但仍逐条转 SSE，帧不带 `id:`
//   判据 8 「幂等一条 SQL」→ 同 `client_event_id` 重投：不第二行、不 5xx、seq 允许跳号、last_seq 仍递增
//   D-2 → seq-less 帧既不被 `ev.seq <= sinceSeq` 过滤，也不推进 `rec.lastSeq`；溢出仍按条数
//   D-4 → 写入侧接线（碎片喂缓冲、落库事件推进 `uptoSeq`）；模块本体见 `run-partial-buffer.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { EVENT_TIERS, EVENT_TIER_STREAM, eventTierOf } from 'erix-agent';

import {
  claimRun,
  postEvents,
  setRunState,
  registerSessionClient,
  unregisterSessionClient,
  sessionClientGoLive,
  notifySessionEvents,
  hubStats,
  SESSION_CLIENT_BUFFER_MAX,
} from '../src/internal.js';
import { partialOutputs, isStreamTierType, createPartialBuffer } from '../src/run-partial-buffer.js';
import { seedClaimable } from './fake-internal-pool.js';

const INTERNAL_SRC = fs.readFileSync(new URL('../src/internal.js', import.meta.url), 'utf8');
/** 写入循环那一段文本（从计数器初始化到 tool_calls 回填之前）——"手抄名单"只可能出现在这里。 */
function writeLoopText() {
  const from = INTERNAL_SRC.indexOf('let stored = 0;');
  const to = INTERNAL_SRC.indexOf('// tool_calls 行由 portal');
  assert.ok(from > 0 && to > from, '没定位到 U3 写入循环（本文件的文本断言姿势失效）');
  return INTERNAL_SRC.slice(from, to);
}

// ---------------------------------------------------------------------------
// 现场：一套可认领的 run + 已领起（running）
// ---------------------------------------------------------------------------

async function live({ sessionId = 's1', runId = 'run1' } = {}) {
  partialOutputs.clear();
  const seed = seedClaimable({ sessionId, runId });
  const container = { id: seed.containerId, user_id: seed.userId };
  const user = { id: seed.userId, login: 'alice' };
  const ticket = await claimRun(seed.pool, { container, user, capacity: 1, holdMs: 10 });
  await setRunState(seed.pool, { container, user, runId, claimToken: ticket.claim_token, body: { state: 'running' } });
  return { ...seed, container, user, claimToken: ticket.claim_token };
}

/** 一条 U3 事件（`client_event_id` 形状 = `run_id:attempt:计数`，同 `runner/worker.js:193`）。 */
const uplink = (runId, n, type, payload) => ({
  client_event_id: `${runId}:1:${n}`, type, ts: null, payload,
});

function fakeSseRes() {
  return {
    written: [], ended: false, destroyed: false, writableEnded: false,
    write(s) { this.written.push(s); },
    end() { this.ended = true; this.writableEnded = true; },
  };
}

/** `UPDATE chat_sessions SET last_seq = last_seq + 1` 的次数 = 本批消耗了多少个 seq。 */
function allocSeqCount(pool) {
  return pool.sqlLog.filter((s) => /SET last_seq = last_seq \+ 1/.test(s.sql)).length;
}

// ---------------------------------------------------------------------------
// 判据 1 + 2：三类 stream 事件既不 INSERT 也不 allocSeq，但仍转浏览器 SSE
// ---------------------------------------------------------------------------

test('#502 判据 1/2：三类碎片不落库、不 allocSeq，但照旧转 SSE（帧不带 id:）', async () => {
  const c = await live();
  const res = fakeSseRes();
  const rec = registerSessionClient('s1', res);
  sessionClientGoLive('s1', rec); // live：事件直接写帧

  const events = [
    uplink('run1', 0, 'round_start', { round: 1 }),
    uplink('run1', 1, 'assistant_delta', { text: '你' }),
    uplink('run1', 2, 'reasoning_delta', { text: '想' }),
    uplink('run1', 3, 'tool_call_delta', { tool_call_id: 'c1', arguments_delta: '{"a"' }),
    uplink('run1', 4, 'tool_use', { tool_call_id: 'c1', name: 'read', input: {} }),
    uplink('run1', 5, 'round_end', { round: 1 }),
  ];
  const r = await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'run1', claimToken: c.claimToken,
    body: { batch_id: 'b1', events },
  });

  // ① 落库的只有三条事实事件；三类碎片**一行都没有**
  assert.equal(r.stored, 3, 'stored 语义不变：只数真落库的行');
  assert.equal(r.seq_first, 1, 'seq_first 仍指向第一条落库事件');
  const types = c.pool.events.map((e) => e.type);
  assert.deepEqual(types, ['round_start', 'tool_use', 'round_end'], `库里只剩事实档：${types.join(',')}`);
  for (const t of ['assistant_delta', 'reasoning_delta', 'tool_call_delta']) {
    assert.equal(c.pool.events.some((e) => e.type === t), false, `${t} 不得入库`);
  }
  // ② 碎片不消耗 seq：三条落库事件 ⇒ 恰好三次 allocSeq（会话 last_seq = 3）
  assert.equal(allocSeqCount(c.pool), 3, '三条落库事件 ⇒ 只分配三个 seq');
  assert.equal(c.pool.sessions[0].last_seq, 3, 'chat_sessions.last_seq = 落库行数（碎片不参与）');

  // ③ 但六条**全部**转了浏览器 SSE（打字机不能因为不落库就看不见）
  const frames = res.written.join('');
  for (const t of ['assistant_delta', 'reasoning_delta', 'tool_call_delta', 'round_start', 'tool_use', 'round_end']) {
    assert.ok(frames.includes(`event: ${t}\n`), `${t} 必须仍推到浏览器`);
  }
  assert.equal(res.written.length, 6, '六条事件六帧（碎片不因不落库被丢）');
  // ④ 碎片的 `seq = null` ⇒ 帧**不带 `id:`**（不能污染浏览器 Last-Event-ID）
  const deltaFrame = res.written.find((s) => s.includes('event: assistant_delta'));
  assert.ok(!deltaFrame.includes('id:'), `碎片帧不得带 id: ${JSON.stringify(deltaFrame)}`);
  const durableFrame = res.written.find((s) => s.includes('event: round_start'));
  assert.ok(durableFrame.includes('id: 1\n'), '落库事件的帧仍带 id（Last-Event-ID 补发靠它）');

  // ⑤ additive 计数：`stream_forwarded` 数被转发的碎片（协议形状不变 ⇒ 只加键）
  assert.equal(r.stream_forwarded, 3, 'stream_forwarded = 被转发的碎片条数');

  unregisterSessionClient('s1', rec);
});

test('#502 判据 1：1000 条 delta 与 10 条 delta 产生的行数 / seq 数**完全相同**（不随 N 增长）', async () => {
  // 同一形状跑两遍，只改喂入的 delta 条数 ⇒ 「行数 = f(轮数)」而不是 f(delta 条数)。
  const run = async (n) => {
    const c = await live({ sessionId: 'sN', runId: 'runN' });
    const events = [];
    let k = 0;
    for (let round = 1; round <= 3; round += 1) {
      events.push(uplink('runN', k++, 'round_start', { round }));
      for (let i = 0; i < n; i += 1) events.push(uplink('runN', k++, 'assistant_delta', { text: `x${i}` }));
      events.push(uplink('runN', k++, 'tool_use', { tool_call_id: `c${round}`, name: 'read', input: {} }));
      events.push(uplink('runN', k++, 'tool_result', { tool_call_id: `c${round}`, ok: true, result_digest: 'ok' }));
      events.push(uplink('runN', k++, 'round_end', { round }));
    }
    // U3 单批上限 200 条 ⇒ 分批喂（真机也是分批）
    let stored = 0;
    for (let i = 0; i < events.length; i += 200) {
      const r = await postEvents(c.pool, {
        container: c.container, user: c.user, runId: 'runN', claimToken: c.claimToken,
        body: { batch_id: `b${i}`, events: events.slice(i, i + 200) },
      });
      stored += r.stored;
    }
    return {
      rows: c.pool.events.length,
      stored,
      allocs: allocSeqCount(c.pool),
      lastSeq: c.pool.sessions[0].last_seq,
      perType: c.pool.events.reduce((a, e) => ({ ...a, [e.type]: (a[e.type] ?? 0) + 1 }), {}),
    };
  };

  const ten = await run(10);
  const thousand = await run(1000);

  assert.equal(ten.rows, thousand.rows, `行数必须与喂入 delta 条数无关：10 条 ${ten.rows} 行 vs 1000 条 ${thousand.rows} 行`);
  assert.equal(ten.allocs, thousand.allocs, '消耗的 seq 数同样与 delta 条数无关');
  assert.equal(ten.lastSeq, thousand.lastSeq, '会话 last_seq 也只由落库事件决定');
  // 3 轮 × (round_start + tool_use + tool_result + round_end) = 12 行，与 delta 条数无关。
  assert.equal(thousand.rows, 12);
  assert.deepEqual(thousand.perType, { round_start: 3, tool_use: 3, tool_result: 3, round_end: 3 });
  // 「少了很多」不算通过：断的是**等式**，不是「变小了」；同时事实档不许被一起丢掉。
  assert.equal(thousand.stored, 12, '事实档仍照常落库');
});

test('#502 判据 2：写入侧的碎片名单来自引擎 `eventTierOf`（不手抄三个串）', () => {
  // 写入侧唯一的判据入口是 `isStreamTierType` ⇒ 它与引擎分级表逐键一致，且**不是**本站抄的三元组。
  const streamKeys = Object.keys(EVENT_TIERS).filter((k) => EVENT_TIERS[k] === EVENT_TIER_STREAM);
  assert.ok(streamKeys.length >= 3, `引擎 stream 档只有 ${streamKeys.length} 键，抽取姿势可疑`);
  for (const k of streamKeys) assert.equal(isStreamTierType(k), true, `${k} 是 stream 档，本站必须认`);
  // 事实档一类都不许被认成碎片（误判 = 把 `tool_use` 这种唯一副本丢掉）
  for (const t of ['tool_use', 'tool_result', 'round_start', 'round_end', 'usage', 'judge', 'run_end']) {
    assert.equal(isStreamTierType(t), false, `${t} 是事实档`);
  }
  // 引擎不认识的名字 ⇒ `undefined` ⇒ **不许**当成碎片（否则引擎新增一类就静默丢）
  assert.equal(isStreamTierType('brand_new_engine_event'), false);
  assert.equal(isStreamTierType(undefined), false);
  assert.equal(isStreamTierType(42), false);
  // 写入循环里不得再出现手抄的三元组，判据只有一份
  const loop = writeLoopText();
  for (const lit of ['assistant_delta', 'reasoning_delta', 'tool_call_delta']) {
    assert.equal(loop.includes(`'${lit}'`), false, `写入循环里又手抄了 ${lit}`);
  }
  assert.match(loop, /eventTierOf\(ev\.type\) === EVENT_TIER_STREAM/, '写入侧必须问引擎');
});

// ---------------------------------------------------------------------------
// 判据 8：幂等一条 SQL（删掉 `SELECT 1` 预查）——接受 seq 跳号
// ---------------------------------------------------------------------------

test('#502 判据 8：同 client_event_id 重投 ⇒ 不第二行、不 5xx、seq 允许跳号、last_seq 仍递增', async () => {
  const c = await live();
  const mk = (n) => uplink('run1', n, 'round_start', { round: n + 1 });
  const first = await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'run1', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [mk(0), mk(1)] },
  });
  assert.deepEqual([first.stored, first.seq_first, first.seq_last], [2, 1, 2]);
  const lastSeqAfterFirst = c.pool.sessions[0].last_seq;

  // at-least-once 重投（agentd 提交成功但响应丢了 ⇒ 整批重发）：不抛错、不第二行
  const replay = await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'run1', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [mk(0), mk(1)] },
  });
  assert.deepEqual([replay.stored, replay.seq_first, replay.seq_last], [0, null, null],
    '重投不产生第二行，也不报 seq_first/seq_last');
  assert.equal(c.pool.events.length, 2, '库里仍是两行');

  // 重投白耗了两个 seq ⇒ **跳号**（§7.3 新口径：合法空洞，客户端不得拿它当重连判据）
  assert.ok(c.pool.sessions[0].last_seq > lastSeqAfterFirst,
    `重投必须推进 last_seq（白耗 seq）：${lastSeqAfterFirst} → ${c.pool.sessions[0].last_seq}`);

  const next = await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'run1', claimToken: c.claimToken,
    body: { batch_id: 'b2', events: [mk(2)] },
  });
  assert.equal(next.stored, 1);
  assert.ok(next.seq_first > 2, `第三条落库事件的 seq 必须跳过被白耗的号：seq_first=${next.seq_first}`);
  // `last_seq` 单调 ⇒ 补发游标仍可用（恒 >= 最大 seq）
  assert.ok(c.pool.sessions[0].last_seq >= next.seq_first, 'last_seq 仍单调且 >= 最大 seq');
  const seqs = c.pool.events.map((e) => Number(e.seq)).sort((a, b) => a - b);
  assert.deepEqual(seqs, [1, 2, next.seq_first], '库里的 seq 之间有空洞（被白耗的两个号）');
});

test('#502 D-8：预查那条 SELECT 已从写入循环里删掉（一条 SQL 幂等）', () => {
  const loop = writeLoopText();
  assert.equal(loop.includes('SELECT 1 FROM run_events'), false, '写入循环里不该再有逐事件预查（每事件少一次往返）');
  assert.match(loop, /ON CONFLICT \(run_id, client_event_id\) DO NOTHING/, '幂等只由一条 SQL 提供');
});

// ---------------------------------------------------------------------------
// D-2：SSE hub 对 seq-less 事件的两条口径
// ---------------------------------------------------------------------------

test('#502 D-2：补发期间缓冲的 seq-less 碎片不被 sinceSeq 过滤掉（JS 里 null <= N 是 true）', () => {
  const res = fakeSseRes();
  const rec = registerSessionClient('s-seqless-flush', res);
  // 缓冲窗口里先到一条 durable（seq 12），再到达两条碎片（seq = null）
  notifySessionEvents('s-seqless-flush', [
    { seq: 12, ts: 't', run_id: 'r', type: 'tool_use', payload: {} },
    { seq: null, ts: 't', run_id: 'r', type: 'assistant_delta', payload: { text: 'a' } },
    { seq: null, ts: 't', run_id: 'r', type: 'assistant_delta', payload: { text: 'b' } },
  ]);
  // 客户端的 Last-Event-ID = 12 ⇒ durable 那条补发已含，两条碎片**必须仍发**
  sessionClientGoLive('s-seqless-flush', rec, 12);
  const frames = res.written.join('');
  assert.equal(res.written.length, 2, `只该发两条碎片帧，实际 ${res.written.length}`);
  assert.equal(frames.includes('tool_use'), false, 'seq 12 已被补发覆盖 ⇒ 不再重发');
  assert.ok(frames.includes('"text":"a"') && frames.includes('"text":"b"'), '碎片一条都不能丢');
  assert.ok(!frames.includes('id:'), '碎片帧不带 id:');
  // 水位线：缓冲路径里 seq 12 已把 `lastSeq` 推到 12（上面那两条碎片不得把它改写成 null）。
  assert.equal(rec.lastSeq, 12, '碎片不得把水位线写成 null（那是比「不推进」更坏的方向）');
  unregisterSessionClient('s-seqless-flush', rec);
});

test('#502 D-2：seq-less 事件不推进 rec.lastSeq（缓冲路径与 live 路径都算）', () => {
  const res = fakeSseRes();
  const rec = registerSessionClient('s-seqless-last', res);
  notifySessionEvents('s-seqless-last', [
    { seq: 20, ts: 't', run_id: 'r', type: 'round_end', payload: {} },
    { seq: null, ts: 't', run_id: 'r', type: 'reasoning_delta', payload: { text: 'x' } },
  ]);
  assert.equal(rec.lastSeq, 20, '缓冲路径：lastSeq = 已缓冲的最大**落库** seq，碎片不得把它改成 null');
  sessionClientGoLive('s-seqless-last', rec, null);
  assert.equal(rec.lastSeq, 20, 'flush 后仍是 20');
  notifySessionEvents('s-seqless-last', [
    { seq: null, ts: 't', run_id: 'r', type: 'assistant_delta', payload: { text: 'y' } },
  ]);
  assert.equal(rec.lastSeq, 20, 'live 路径：碎片同样不推进水位线');
  assert.equal(res.written.filter((s) => s.includes('assistant_delta')).length, 1, '碎片仍照常推');
  unregisterSessionClient('s-seqless-last', rec);
});

test('#502 D-2：缓冲溢出仍按**条数**判（碎片进缓冲，但不引入第二个阈值）', () => {
  const res = fakeSseRes();
  const before = hubStats().sessionClients;
  const rec = registerSessionClient('s-seqless-overflow', res);
  const half = SESSION_CLIENT_BUFFER_MAX / 2;
  notifySessionEvents('s-seqless-overflow', [
    ...Array.from({ length: half }, (_, i) => ({ seq: null, ts: 't', run_id: 'r', type: 'assistant_delta', payload: { text: `${i}` } })),
    ...Array.from({ length: half }, (_, i) => ({ seq: i + 1, ts: 't', run_id: 'r', type: 'round_end', payload: {} })),
  ]);
  assert.equal(rec.resync, false, '恰好到上限 ⇒ 不判重同步');
  assert.equal(rec.buffer.length, SESSION_CLIENT_BUFFER_MAX);
  assert.equal(rec.lastSeq, half, '水位线只跟落库事件走');
  notifySessionEvents('s-seqless-overflow', [{ seq: null, ts: 't', run_id: 'r', type: 'assistant_delta', payload: { text: 'over' } }]);
  assert.equal(rec.resync, true, '第 N+1 **条**（哪怕是碎片）就判重同步：阈值仍是条数');
  assert.equal(hubStats().sessionClients, before, '溢出后 rec 已从 hub 摘除（不脏残留）');
  assert.equal(res.written.some((s) => s.includes('event: resync')), true, '写了 resync 控制帧');
});

// ---------------------------------------------------------------------------
// D-4 写入侧接线：碎片喂缓冲、落库事件推进 uptoSeq
// ---------------------------------------------------------------------------

test('#502 D-4 接线：U3 落库后缓冲里有正文，且 uptoSeq = 最后一条落库事件的 seq', async () => {
  const c = await live({ sessionId: 's502', runId: 'r502' });
  assert.equal(partialOutputs.snapshot('r502'), null, '开跑前没有缓冲');
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502', 0, 'round_start', { round: 1 }),
      uplink('r502', 1, 'assistant_delta', { text: '半' }),
      uplink('r502', 2, 'assistant_delta', { text: '截' }),
      uplink('r502', 3, 'reasoning_delta', { text: '因为' }),
      uplink('r502', 4, 'tool_use', { tool_call_id: 'c1', name: 'read', input: {} }),
    ] },
  });
  const snap = partialOutputs.snapshot('r502');
  assert.ok(snap, '碎片必须进缓冲');
  assert.equal(snap.text, '半截');
  assert.equal(snap.reasoning, '因为');
  assert.equal(snap.uptoSeq, 2, '两条落库事件（seq 1、2）⇒ uptoSeq = 2');
  assert.equal(snap.sessionId, 's502', '补发侧要按会话找候选 run');
});

test('#502 D-4 接线：整批重投不把正文拼两遍（stream 档没有库面可依赖）', async () => {
  const c = await live({ sessionId: 's502b', runId: 'r502b' });
  const events = [
    uplink('r502b', 0, 'assistant_delta', { text: 'AB' }),
    uplink('r502b', 1, 'assistant_delta', { text: 'CD' }),
  ];
  const body = { batch_id: 'b1', events };
  await postEvents(c.pool, { container: c.container, user: c.user, runId: 'r502b', claimToken: c.claimToken, body });
  await postEvents(c.pool, { container: c.container, user: c.user, runId: 'r502b', claimToken: c.claimToken, body });
  assert.equal(partialOutputs.snapshot('r502b').text, 'ABCD', '重投后正文仍是 ABCD，不是 ABCDABCD');
});

test('#502 D-4：单例与工厂是两套实例（测试清的是单例，不影响工厂产物）', () => {
  const mine = createPartialBuffer();
  mine.observe('x', { type: 'assistant_delta', payload: { text: 'z' }, client_event_id: 'x:1:0', session_id: 's' });
  partialOutputs.clear();
  assert.ok(mine.snapshot('x'), '工厂实例独立');
  assert.equal(partialOutputs.snapshot('x'), null, '单例已被清');
});
