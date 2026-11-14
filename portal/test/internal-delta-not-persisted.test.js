// issue #502（perf(db)：delta 不落库）**写入侧**的单测（fake pool，不碰真库；docs/testing.md §2.1）。
//
// 覆盖的判据（issue #502 §2 与工单契约 D-1/D-2/D-8）：
//   判据 1 「一轮事件表的行数与喂进去多少条 delta 无关」→ 10 条 vs 1000 条**行数相同**
//   判据 2 的后端那一半（前端打字机由真机 e2e 负责）→ 碎片不落库但仍逐条转 SSE，帧不带 `id:`
//   判据 8 「幂等一条 SQL」→ 同 `client_event_id` 重投：不第二行、不 5xx、seq 允许跳号、last_seq 仍递增
//   D-2 → seq-less 帧既不被 `ev.seq <= sinceSeq` 过滤，也不推进 `rec.lastSeq`；溢出仍按条数
//   D-4 → 写入侧接线（碎片喂缓冲、`round_start` 开新槽并带出 `roundSeq`）；模块本体见 `run-partial-buffer.test.js`
//   形态 M（审计四条）→ M-6① 重投不重复转发、M-6② 缓冲变更排在 COMMIT 之后、M-6③ U3 拒绝
//   portal 自造的事件类型；M-6④（历史合成项分页）在 `session-partial-output.test.js` 承重
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
// D-4 写入侧接线：碎片喂缓冲、`round_start` 开新槽（形态 M：不再是「落库事件推进 uptoSeq」）
// ---------------------------------------------------------------------------

test('#502 D-4 接线：U3 落库后缓冲里有正文，且 roundSeq = 当前轮 round_start 的 seq', async () => {
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
  // 改写的旧断言：`uptoSeq: 2` ⇒ `roundSeq: 1`。形态 M 删了 `uptoSeq`：碎片不落库就没有 seq 坐标系，
  // 「已落库事件的最大 seq」与客户端 `Last-Event-ID` 是两套坐标，拿它当闸门会漏发/重发（审计 B-2/B-3）；
  // 现在只带「当前轮轮起点自己的 seq」，前端拿同一个事实对账（`round_start` 是事实档，两边同一个数）。
  assert.equal(snap.roundSeq, 1, 'round_start 自己落在 seq 1 ⇒ roundSeq = 1');
  assert.equal(snap.round, 1, '轮号取自 round_start.payload.round ⇒ 终态写 `run_end.partial_round` 用的就是它');
  assert.ok(!('uptoSeq' in snap), '快照里不许再有 uptoSeq（那套坐标已整体删除）');
  assert.equal(snap.sessionId, 's502', '补发侧要按会话找候选 run');
});

test('#502 形态 M 口径②：round_start 重置正文槽（不许跨轮累加），reasoning 独立累加', async () => {
  const c = await live({ sessionId: 's502r', runId: 'r502r' });
  const send = (events) => postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502r', claimToken: c.claimToken,
    body: { batch_id: 'b', events },
  });
  await send([
    uplink('r502r', 0, 'round_start', { round: 1 }),
    uplink('r502r', 1, 'assistant_delta', { text: '第一轮' }),
    uplink('r502r', 2, 'reasoning_delta', { text: 'A' }),
  ]);
  assert.equal(partialOutputs.snapshot('r502r').text, '第一轮');
  await send([
    uplink('r502r', 3, 'round_start', { round: 2 }),
    uplink('r502r', 4, 'assistant_delta', { text: '第二轮' }),
    uplink('r502r', 5, 'reasoning_delta', { text: 'B' }),
  ]);
  const snap = partialOutputs.snapshot('r502r');
  // 旧版是「按 run 累加」⇒ 这里会拼出 `第一轮第二轮`，而界面的流式气泡本来就在 `round_start` 置 null
  //（`useEventStream.ts`）⇒ 缓冲里那段话界面上**从来没出现过**，拿它写终态正文就是造了一份没人见过的
  // 历史（审计 B-1）。跨轮累加的另一半代价更大：`run_end.partial_text` 会带上前几轮的终稿，
  // 与 `round_end.final_text`（历史投影读的那一份）**重复**。
  assert.equal(snap.text, '第二轮', '新一轮开始 ⇒ 正文槽清空');
  assert.equal(snap.reasoning, 'AB', 'reasoning 不在轮边界清空，也不与正文混写（它不落库，只是观测面）');
  assert.equal(snap.round, 2);
  assert.equal(snap.roundSeq, 2, '只有 round_start 占号（碎片不 allocSeq）⇒ 第二条 round_start 落在 seq 2 = 当前轮起点');
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

// ---------------------------------------------------------------------------
// 形态 M-2：终态那半截正文**并进既有 `run_end` 行的 payload**（不新增事件行类型）
// ---------------------------------------------------------------------------

/** 取该 run 的合成 `run_end` 载荷（fake 里 payload 存的是字符串，同 `internal-attempt-killed.test.js`）。 */
function runEndOf(pool, runId) {
  const row = pool.events.filter((e) => e.type === 'run_end' && e.run_id === runId).pop();
  assert.ok(row, `没有合成 run_end：${pool.events.map((e) => e.type).join(',')}`);
  return { row, payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload ?? {}) };
}

test('#502 形态 M-2：停止时那半截正文进 `run_end.payload.partial_text`/`partial_round`，且**不新增事件行**', async () => {
  const c = await live({ sessionId: 's502t', runId: 'r502t' });
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502t', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502t', 0, 'round_start', { round: 3 }),
      uplink('r502t', 1, 'assistant_delta', { text: '说到' }),
      uplink('r502t', 2, 'assistant_delta', { text: '一半' }),
    ] },
  });
  // runner 的 catch 固定 `final_text: ''`（`runner/worker.js:1182`，本单红线不得改）⇒ 无 assistant 锚点
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502t', claimToken: c.claimToken,
    body: { state: 'finished', termination: { reason: 'aborted' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 3, final_text: '' },
  });
  const { payload } = runEndOf(c.pool, 'r502t');
  assert.equal(payload.partial_text, '说到一半', '#300 那条「中止后还能看到那段正文」现在靠这两个键承重');
  assert.equal(payload.partial_round, 3, '轮号取自 round_start ⇒ 排障时能定位是哪一轮断的');
  // **零新行类型**：上一版会多出一条 `type='partial_output'` 的行，形态 M 里它根本不存在
  assert.equal(c.pool.events.filter((e) => e.type === 'partial_output').length, 0,
    '不得再写 partial_output 行（那是被删掉的旧通道）');
  assert.equal(c.pool.events.filter((e) => e.type === 'run_end').length, 1, '一个 run 仍只有一条 run_end');
  // 既有键一个不少（additive：并进两个键不得动 termination/usage/rounds/attempt 的形状）
  assert.equal(payload.termination.reason, 'aborted');
  assert.deepEqual(payload.usage, { input_tokens: 1, output_tokens: 1 });
  assert.equal(payload.rounds, 3);
  // 缓冲在 COMMIT 之后收尾 ⇒ 补发侧不再对它发帧（正文的 durable 副本已在库里）
  assert.equal(partialOutputs.snapshot('r502t'), null, '终态后缓冲必须让位（否则刷新后历史一份 + 补发一份）');
});

test('#502 形态 M-2：有 assistant 锚点 ⇒ run_end 载荷**逐字**不多键（两份正文就是 #300 那个坑）', async () => {
  const c = await live({ sessionId: 's502a', runId: 'r502a' });
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502a', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502a', 0, 'round_start', { round: 1 }),
      uplink('r502a', 1, 'assistant_delta', { text: '流式的半截' }),
    ] },
  });
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502a', claimToken: c.claimToken,
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 1, final_text: '完整终稿' },
  });
  const { payload } = runEndOf(c.pool, 'r502a');
  assert.equal(Object.hasOwn(payload, 'partial_text'), false, '有锚点 ⇒ 正文的 durable 副本在 transcript/投影那条路上');
  assert.equal(Object.hasOwn(payload, 'partial_round'), false);
  assert.equal(c.pool.messages.some((m) => m.role === 'assistant'), true, '前置：这条路径确实建了锚点');
});

test('#502 形态 M-2：缓冲里没有正文（停在 sleep 上）⇒ run_end 载荷与今天逐字相同', async () => {
  const c = await live({ sessionId: 's502e', runId: 'r502e' });
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502e', claimToken: c.claimToken,
    body: { state: 'finished', termination: { reason: 'aborted' }, usage: { input_tokens: 0, output_tokens: 0 }, rounds: 0, final_text: '' },
  });
  const { payload } = runEndOf(c.pool, 'r502e');
  assert.deepEqual(Object.keys(payload).sort(), ['attempt', 'rounds', 'termination', 'usage'],
    '空正文不许凭空多两个键（也不写空串：空键会让读侧把「没有」读成「正文是空」）');
});

// ---------------------------------------------------------------------------
// 形态 M / 审计四条（M-6）的写入侧三条：①重投不重转 ②变更排在 COMMIT 后 ③保留类型 400
// ---------------------------------------------------------------------------

test('#502 M-6①：整批重投不把碎片**再转一次 SSE**（observe 的返回值必须用起来）', async () => {
  const c = await live({ sessionId: 's502d', runId: 'r502d' });
  const res = fakeSseRes();
  const rec = registerSessionClient('s502d', res);
  sessionClientGoLive('s502d', rec);
  const events = [
    uplink('r502d', 0, 'round_start', { round: 1 }),
    uplink('r502d', 1, 'assistant_delta', { text: 'AB' }),
    uplink('r502d', 2, 'assistant_delta', { text: 'CD' }),
  ];
  const body = { batch_id: 'b1', events };
  const first = await postEvents(c.pool, { container: c.container, user: c.user, runId: 'r502d', claimToken: c.claimToken, body });
  const framesAfterFirst = res.written.length;
  assert.equal(first.stream_forwarded, 2, '首投：两条碎片都转发');
  // U3 是 at-least-once：`runner/agentd.js` 的可重试路径会把**整批**放回队首再发一遍
  const second = await postEvents(c.pool, { container: c.container, user: c.user, runId: 'r502d', claimToken: c.claimToken, body });
  assert.equal(second.stream_forwarded, 0,
    '重投的碎片必须**不再转发**：浏览器已经收过一次，再发就是打字机上重复正文（#300 头号坑），'
    + '而 stream 档不落库 ⇒ 库里没有判据，唯一判据就是缓冲里那份 client_event_id 计数');
  assert.equal(res.written.length, framesAfterFirst,
    '一条帧都不许多发（round_start 重投被 ON CONFLICT 挡下，碎片被 observe 判为重投）');
  assert.equal(partialOutputs.snapshot('r502d').text, 'ABCD', '正文也只拼一遍');
  assert.equal(second.stored, 0, 'round_start 的幂等仍靠 ON CONFLICT（不得回归）');
  try { unregisterSessionClient('s502d', rec); } catch { /* 收尾 */ }
});

test('#502 M-6②：COMMIT 失败 ⇒ 缓冲一个字都不改（不许留下「内存有、库里无」的假象）', async () => {
  const c = await live({ sessionId: 's502c', runId: 'r502c' });
  c.pool.failCommitOnce = true; // fake 提供：下一次 COMMIT 抛错（模拟提交失败/连接掉线）
  await assert.rejects(() => postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502c', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502c', 0, 'round_start', { round: 1 }),
      uplink('r502c', 1, 'assistant_delta', { text: '这段没提交成功' }),
    ] },
  }));
  // 旧版在事务里直接 observe ⇒ 这里缓冲里会留着「这段没提交成功」：
  // 补发侧会把它发给浏览器，终态时还会写进 `run_end.partial_text` ⇒ 用户看见一段库里没有的正文。
  const snap = partialOutputs.snapshot('r502c');
  assert.ok(snap === null || snap.text === '', `回滚后缓冲里不许有正文：${JSON.stringify(snap)}`);
  assert.equal(c.pool.events.length, 0, '前置：库里确实一行没写');
});

test('#502 M-6③：portal 自造的三类事件从 U3 上来 ⇒ 400 validation_failed（其余 additive 类型照收）', async () => {
  const c = await live({ sessionId: 's502v', runId: 'r502v' });
  for (const type of ['run_end', 'partial_output', 'attempt_killed']) {
    await assert.rejects(
      () => postEvents(c.pool, {
        container: c.container, user: c.user, runId: 'r502v', claimToken: c.claimToken,
        body: { batch_id: 'b', events: [uplink('r502v', 1, type, {})] },
      }),
      (e) => e.status === 400 && e.code === 'validation_failed' && /portal 自造/.test(e.message),
      `${type} 必须被拒（portal 在终态/回收事务里自己写它，容器再递一条就是第二把笔写同一个名字）`,
    );
  }
  assert.equal(c.pool.events.length, 0, '400 发生在进事务之前 ⇒ 零写入');
  // 反面：上游新增的 additive 类型（`eventTierOf` 认不出 = 事实档）照旧透传，本闸不得顺手拒掉
  const r = await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502v', claimToken: c.claimToken,
    body: { batch_id: 'b2', events: [uplink('r502v', 2, 'some_future_event', { hello: 'world' })] },
  });
  assert.equal(r.stored, 1, '引擎将来新增的类型仍照旧落库（闸只认本站自造那三个名字）');
});

test('#502 M-2 helper：runEndPartialKeys 的三条判据（锚点 / 空正文 / 正常正文）', async () => {
  const { runEndPartialKeys } = await import('../src/internal.js');
  const b = createPartialBuffer();
  assert.deepEqual(runEndPartialKeys('r1', { buffer: b }), {}, '没有这个 run ⇒ 空对象');
  b.observe('r1', { client_event_id: 'r1:1:0', type: 'round_start', payload: { round: 2 }, seq: 4, session_id: 's' });
  b.observe('r1', { client_event_id: 'r1:1:1', type: 'assistant_delta', payload: { text: '半截' }, session_id: 's' });
  assert.deepEqual(runEndPartialKeys('r1', { hasAssistantAnchor: true, buffer: b }), {},
    '有锚点 ⇒ 空对象：判据与 finishRun 建锚点用的是同一条表达式');
  assert.deepEqual(runEndPartialKeys('r1', { buffer: b }),
    { partial_text: '半截', partial_round: 2, partial_truncated: false },
    '审计第 3 条：additive 键 `partial_truncated` 必须跟着出（没截就是 false，不是缺键）');
  // 缓冲只读：算键这个动作本身不得把 run 标掉/丢掉（终态点要在 COMMIT 之后才收尾）
  assert.ok(b.snapshot('r1'), 'helper 只读缓冲（M-6②：变更排在 COMMIT 之后）');
});

test('#502 M-6②：终态事务提交失败 ⇒ 缓冲**不收尾**（drop/markTerminal 也排在 COMMIT 之后）', async () => {
  const c = await live({ sessionId: 's502f', runId: 'r502f' });
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502f', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502f', 0, 'round_start', { round: 1 }),
      uplink('r502f', 1, 'assistant_delta', { text: '这段还得留着' }),
    ] },
  });
  const before = partialOutputs.snapshot('r502f');
  assert.equal(before.text, '这段还得留着', '前置：正文在缓冲里');
  c.pool.failCommitOnce = true; // 终态收敛事务提交失败（连接掉线 / 死锁重试）
  await assert.rejects(() => setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502f', claimToken: c.claimToken,
    body: { state: 'finished', termination: { reason: 'aborted' }, rounds: 1, final_text: '' },
  }));
  const after = partialOutputs.snapshot('r502f');
  // 提交失败 ⇒ `run_end` 那一行没落库 ⇒ 那段正文**仍然只有内存这一份**。
  // 若在这里就 drop/markTerminal，worker 重投终态时内存已空 ⇒ 界面上那段话永久消失
  //（历史投影两处正文都没有，只剩一个占位）。
  assert.equal(after?.text, '这段还得留着', '终态写失败 ⇒ 缓冲必须原样保留，等下一次重试');
  assert.equal(after?.terminal, false, '也不许标终态：标了就会被 LRU 优先逐掉，等于换个方式丢正文');
  assert.equal(c.pool.events.filter((e) => e.type === 'run_end').length, 0, '前置：run_end 确实没落库');
  // 「提交成功 ⇒ 这时才收尾」的正面对照在上一条 M-2 用例里（那里断终态后 `snapshot` 变 null）：
  // 这里不再补一条重试腿，因为 fake 的撤销日志不回滚 `run_queue.status` ⇒ 第二次 `setRunState`
  // 会走 F5 幂等重放分支直接返回，走不到终态写入那段（真库 ROLLBACK 会连队列行一起回滚）。
  // 「重试那一次照样把正文落下来」这件事由真库闸 `delta-not-persisted-db.test.js` 承重。
});

// ---------------------------------------------------------------------------
// 审计第 2 条（261114-05）：**durable `round_end` 必须关掉正文槽**
//
// 形状：跑完一轮（`round_end` 带 `final_text`）⇒ 那一轮的正文**已经在库里**（`round_end.payload.final_text`）。
// 而历史投影读的是 **`round_end.final_text` 拼 `run_end.partial_text`**（`http.js#projectPartialOutputItems`）
// ⇒ 若槽不关，「`round_end` 之后、下一轮 `round_start` 之前」被 reaper / offboard / 取消终态化时，
// `runEndPartialKeys` 会把**已完成那一轮**的正文再写一遍进 `partial_text` ⇒ 界面重复一轮。
// ---------------------------------------------------------------------------
test('审计第 2 条：完整一轮的 `round_end` 落库 ⇒ 正文槽关掉，无锚点终态不再把该轮写进 partial_text', async () => {
  const c = await live({ sessionId: 's502re', runId: 'r502re' });
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502re', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502re', 0, 'round_start', { round: 1 }),
      uplink('r502re', 1, 'assistant_delta', { text: '第一轮' }),
      uplink('r502re', 2, 'assistant_delta', { text: '说完了' }),
      uplink('r502re', 3, 'round_end', { round: 1, final_text: '第一轮说完了' }), // durable 落点
    ] },
  });
  // 改前这里会是 `第一轮说完了`（槽没关）⇒ 下一步会把它再写一遍进 `partial_text`。
  const mid = partialOutputs.snapshot('r502re');
  assert.equal(mid.text, '', 'round_end 落库后正文槽必须为空（那一轮的正文已在 round_end.final_text 里）');
  assert.equal(mid.round, 1, '轮号/轮起点 seq 不清：下一轮 round_start 才换（补发帧的对账凭据不能瞎）');
  assert.equal(mid.roundSeq, 1, '同上 —— roundSeq 仍是本轮轮起点的 seq');

  // 「无锚点终态」：runner 的 catch 固定 final_text:'' ⇒ 不建 assistant 锚点
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502re', claimToken: c.claimToken,
    body: { state: 'failed', termination: { reason: 'aborted' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 1, final_text: '' },
  });
  const { payload } = runEndOf(c.pool, 'r502re');
  assert.equal(Object.hasOwn(payload, 'partial_text'), false,
    '已完成那一轮不得再写进 partial_text —— 写了就是历史投影里的「重复一轮」');
  // 前置自证：那一轮的终稿确实 durable 在 `round_end` 行里（fake 里 payload 存的是字符串，同 `runEndOf`）。
  // **不这样钉的话，「槽被清空」与「正文根本丢了」两件事在断言上长得一样。**
  const roundEnds = c.pool.events.filter((e) => e.type === 'round_end').map((e) => (
    typeof e.payload === 'string' ? JSON.parse(e.payload) : (e.payload ?? {})
  ));
  assert.deepEqual(roundEnds.map((p) => p.final_text), ['第一轮说完了'],
    'round_end 行必须真的带着那一轮的终稿（正文没丢，只是不再重复）');
});

test('审计第 2 条（另一半）：round_end **之后**新说的半轮仍然写进 partial_text（关掉的是那一轮，不是整个 run）', async () => {
  const c = await live({ sessionId: 's502rf', runId: 'r502rf' });
  const send = (events) => postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502rf', claimToken: c.claimToken,
    body: { batch_id: 'b', events },
  });
  await send([
    uplink('r502rf', 0, 'round_start', { round: 1 }),
    uplink('r502rf', 1, 'assistant_delta', { text: '第一轮说完了' }),
    uplink('r502rf', 2, 'round_end', { round: 1, final_text: '第一轮说完了' }),
    // 下一轮开始了又说了两句被停止（引擎先发 round_start，所以槽是正常开的）
    uplink('r502rf', 3, 'round_start', { round: 2 }),
    uplink('r502rf', 4, 'assistant_delta', { text: '第二轮说到' }),
  ]);
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502rf', claimToken: c.claimToken,
    body: { state: 'failed', termination: { reason: 'aborted' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 2, final_text: '' },
  });
  const { payload } = runEndOf(c.pool, 'r502rf');
  assert.equal(payload.partial_text, '第二轮说到', 'partial_text 只装「库里没有的那半轮」——历史投影拼出来正好一遍');
  assert.equal(payload.partial_round, 2);
  // 投影面（拼出口径在 http.js）：两处合起来 = 第一轮 + 第二轮那半句，各出现一次
  const joined = '第一轮说完了' + (payload.partial_text ?? '');
  assert.equal(joined, '第一轮说完了第二轮说到');
  assert.equal(joined.split('第一轮说完了').length - 1, 1, '已完成那一轮在拼出来的正文里只出现一次');
});

// ---------------------------------------------------------------------------
// 审计第 3 条（261114-05）：**截断状态没持久化，历史把「被截断」说成「完整」**
// ---------------------------------------------------------------------------
test('审计第 3 条：正文超 textCap ⇒ runEndPartialKeys 带 partial_truncated=true（未超是 false，不是缺键）', async () => {
  const { runEndPartialKeys } = await import('../src/internal.js');
  const b = createPartialBuffer({ textCap: 20 });
  const feed = (text, n) => b.observe('r1', {
    client_event_id: `r1:1:${n}`, type: 'assistant_delta', session_id: 's', payload: { text },
  });
  b.observe('r1', { client_event_id: 'r1:1:0', type: 'round_start', payload: { round: 1 }, seq: 1, session_id: 's' });
  assert.deepEqual(runEndPartialKeys('r1', { buffer: b }), {},
    '一轮还没说话 ⇒ 一个键都不加（既有口径：空正文不许凭空多键，也不写空串）');
  feed('一二三四五六七八九十', 1);
  assert.equal(runEndPartialKeys('r1', { buffer: b }).partial_truncated, false, '恰好夹到上限（没丢内容）⇒ 不算截断');
  feed('尾巴丢了尾巴丢了尾巴丢了', 2); // 再来 12 字，只剩 10 个位子 ⇒ 真的掉尾巴了
  const keys = runEndPartialKeys('r1', { buffer: b });
  assert.equal(keys.partial_text.length, 20, `前置：正文确实被夹到 20（实拿 ${keys.partial_text?.length}）`);
  assert.equal(keys.partial_truncated, true, '被夹尾就要说实话（改前这个键根本不存在 ⇒ 历史谎报「完整」）');
  // 反过来也必须成立：**只有推理被截**时不得谎报正文被截（这就是不能复用 `snap.truncated` 的理由）
  const onlyReasoning = createPartialBuffer({ textCap: 10 });
  onlyReasoning.observe('r2', { client_event_id: 'r2:1:0', type: 'round_start', payload: { round: 1 }, seq: 1, session_id: 's' });
  onlyReasoning.observe('r2', { client_event_id: 'r2:1:1', type: 'assistant_delta', payload: { text: '正文没截' }, session_id: 's' });
  onlyReasoning.observe('r2', { client_event_id: 'r2:1:2', type: 'reasoning_delta', payload: { text: '推理很长推理很长推理很长' }, session_id: 's' });
  assert.equal(onlyReasoning.snapshot('r2').truncated, true, '前置：两路共用的观测位确实被推理置上了');
  assert.equal(runEndPartialKeys('r2', { buffer: onlyReasoning }).partial_truncated, false,
    '推理截了 ≠ 正文截了：写进库的必须是正文自己的那一位');
});

test('审计第 3 条（端到端）：> textCap 的正文经终态落库 ⇒ run_end 行里带 partial_truncated=true', async () => {
  const c = await live({ sessionId: 's502tc', runId: 'r502tc' });
  await postEvents(c.pool, {
    container: c.container, user: c.user, runId: 'r502tc', claimToken: c.claimToken,
    body: { batch_id: 'b1', events: [
      uplink('r502tc', 0, 'round_start', { round: 1 }),
      // 默认 textCap = 16,384：喂 20,000 字符（> 上限）⇒ 尾巴必被夹掉
      uplink('r502tc', 1, 'assistant_delta', { text: 'x'.repeat(20_000) }),
    ] },
  });
  assert.equal(partialOutputs.snapshot('r502tc').text.length, 16_384, '前置：缓冲确实夹到 16,384');
  await setRunState(c.pool, {
    container: c.container, user: c.user, runId: 'r502tc', claimToken: c.claimToken,
    body: { state: 'failed', termination: { reason: 'aborted' }, usage: { input_tokens: 1, output_tokens: 1 }, rounds: 1, final_text: '' },
  });
  const { payload } = runEndOf(c.pool, 'r502tc');
  assert.equal(payload.partial_text.length, 16_384, '库里存的就是被截过的那一份');
  assert.equal(payload.partial_truncated, true, '「这一份是被截过的」必须跟着落库（改前只活在内存里）');
});
