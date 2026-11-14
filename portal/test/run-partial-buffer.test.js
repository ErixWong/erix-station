// issue #502 D-4（**形态 M**）：`run-partial-buffer.js` 的单测（纯内存，零依赖，docs/testing.md §2.1）。
//
// 这个模块是「delta 不落库之后，断线重连还能不能把那段未完稿正文补回来」的**唯一**内存来源，
// 所以口径各自有具名用例：
//   ① 档位判据来自引擎 `eventTierOf`（本站不手抄三个串）
//   ② 正文**按轮**成槽：`round_start` 一到就清空（前端也在此刻置空气泡），`reasoning` 独立累加
//   ③ 快照带 `roundSeq`（当前轮 `round_start` 自己的 seq）——**形态 M 删掉了 `uptoSeq`**：碎片不落库
//      就没有 seq 坐标系，「已落库事件的最大 seq」与客户端 `Last-Event-ID` 是两套坐标，硬比就漏发/重发
//   ④ 内存有界：单 run 单轮正文夹到 `textCap`、run 数夹到 `maxEntries`（LRU **优先逐已终态的 run**，
//      逐活跃 run 必须出声）；`counters` 也有上界（它按 attempt 增长，不封顶就是隐性泄漏）
//   ⑤ 变更只在 COMMIT 之后生效（`stage()`/`commit()`）——写入侧在事务里只碰副本
import test from 'node:test';
import assert from 'node:assert/strict';

import { EVENT_TIERS, EVENT_TIER_STREAM } from 'erix-agent';

import {
  createPartialBuffer,
  isStreamTierType,
  partialOutputs,
  PARTIAL_TEXT_CAP_DEFAULT,
  PARTIAL_MAX_ENTRIES_DEFAULT,
  PARTIAL_MAX_COUNTERS_DEFAULT,
} from '../src/run-partial-buffer.js';

const ev = (n, type, payload, extra = {}) => ({
  client_event_id: `r1:1:${n}`, type, payload, session_id: 's1', ...extra,
});
const roundStart = (n, round, seq) => ev(n, 'round_start', { round }, { seq });

test('D-4①：碎片名单来自引擎分级表（stream 档逐键一致，事实档一类都不认）', () => {
  const streamKeys = Object.keys(EVENT_TIERS).filter((k) => EVENT_TIERS[k] === EVENT_TIER_STREAM);
  assert.ok(streamKeys.includes('assistant_delta') && streamKeys.includes('reasoning_delta')
    && streamKeys.includes('tool_call_delta'), '引擎里这三类必须是 stream 档（否则本单的判据要重写）');
  for (const k of streamKeys) assert.equal(isStreamTierType(k), true);
  for (const t of ['tool_use', 'tool_result', 'round_start', 'round_end', 'usage', 'judge']) {
    assert.equal(isStreamTierType(t), false, `${t} 是事实档，不得被当碎片`);
  }
  assert.equal(isStreamTierType('unknown_new_event'), false, '引擎不认识 ⇒ 不许当碎片（宁留不丢）');
});

test('D-4②（形态 M）：round_start 重置正文槽；reasoning 独立累加、不在轮边界清空', () => {
  const b = createPartialBuffer();
  b.observe('r1', roundStart(0, 1, 1));
  b.observe('r1', ev(1, 'assistant_delta', { text: '第一段' }));
  b.observe('r1', ev(2, 'reasoning_delta', { text: 'A' }));
  b.observe('r1', roundStart(3, 2, 3));
  b.observe('r1', ev(4, 'assistant_delta', { text: '第二段' }));
  b.observe('r1', ev(5, 'reasoning_delta', { text: 'B' }));
  const s = b.snapshot('r1');
  // 改写的旧断言：`text === '第一段第二段'`（旧口径「跨轮累加」）。形态 M 反过来：
  // 前端的流式气泡本来就在 `round_start` 置 null（`useEventStream.ts`）⇒ 跨轮累加会拼出一段
  // **界面上从来没出现过**的话，并把它写进 `run_end.partial_text`（与 `round_end.final_text` 重复）。
  assert.equal(s.text, '第二段', '轮边界清空正文槽：缓冲里的就是「还在写的这一段」');
  assert.equal(s.reasoning, 'AB', '推理单独一路：既不混进正文，也不在轮边界消失（它不落库，只是观测面）');
  assert.equal(s.chunks, 1, 'chunks 只数**正文**片并跟着正文槽重置（它是「这一段有几片」的读数；推理不按轮重置，混进来就变成 run 级累计）');
  assert.equal(s.truncated, false);
});

test('D-4②：tool_call_delta 是工具入参，不进正文（成型副本在 tool_use.input）', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'tool_call_delta', { tool_call_id: 'c1', arguments_delta: '{"cmd":"ls"' }));
  const s = b.snapshot('r1');
  assert.ok(s, '碎片事件仍进缓冲（它证明这个 run 正在流式）');
  assert.equal(s.text, '', '入参碎片不得混进正文');
});

test('D-4③（形态 M）：roundSeq = 当前轮 round_start 的 seq；没有 uptoSeq，也不认「已落库最大 seq」', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'a' }));
  assert.equal(b.snapshot('r1').roundSeq, null,
    '没观测到 round_start ⇒ null（前端对不上账就整帧丢弃，宁可不覆盖也不盖错轮）');
  b.observe('r1', roundStart(1, 1, 7));
  assert.equal(b.snapshot('r1').roundSeq, 7);
  assert.equal(b.snapshot('r1').round, 1);
  b.observe('r1', ev(2, 'assistant_delta', { text: 'b' }));
  assert.equal(b.snapshot('r1').roundSeq, 7, '碎片不占号 ⇒ 轮起点不变');
  b.observe('r1', ev(3, 'tool_use', {}, { seq: 99 }));
  assert.equal(b.snapshot('r1').roundSeq, 7,
    '旧口径会拿这条（seq 99）推进 uptoSeq；形态 M 里事实档与本槽无关 ⇒ 不动（这就是两套坐标不再硬比）');
  b.observe('r1', roundStart(4, 2, undefined));
  assert.equal(b.snapshot('r1').roundSeq, null, 'round_start 没带 seq ⇒ null（不拿旧轮的号冒充新轮）');
  assert.equal(b.snapshot('r1').round, 2, '轮号与 roundSeq 各自独立：脏一个不牵连另一个');
  assert.ok(!('uptoSeq' in b.snapshot('r1')), '快照里不许再有 uptoSeq（整套水位线已删除）');
});

test('D-4④（形态 M）：单 run 单轮正文夹到 textCap，truncated 如实报告；默认上限 16384 而非 2000', () => {
  const b = createPartialBuffer({ textCap: 10 });
  b.observe('r1', ev(0, 'assistant_delta', { text: '0123456789' }));
  assert.equal(b.snapshot('r1').text, '0123456789');
  assert.equal(b.snapshot('r1').truncated, false, '刚好等于上限 ⇒ 还没丢东西');
  b.observe('r1', ev(1, 'assistant_delta', { text: 'AB' }));
  assert.equal(b.snapshot('r1').text, '0123456789', '上限之后不再长');
  assert.equal(b.snapshot('r1').truncated, true, '上限之后仍到帐 ⇒ 必须报 truncated');
  assert.equal(b.snapshot('r1').chunks, 2, 'chunks 数的是**收到过**的片数（可观测性）');
  // 默认上限从 2000 抬到 16384（判据 3：> 2000 的半截正文刷新后必须逐字完整）。
  // 真库现查 `round_end.final_text` 最长 31,707 字符、均值 467 ⇒ 2000 会把中位以上的正文砍掉。
  // 读侧投影上限另算（`http.js` 的 65536）：这里只夹「还在写的这一段」，跨轮拼接后的总长由读侧拿笔。
  assert.equal(PARTIAL_TEXT_CAP_DEFAULT, 16384, '默认上限 = 16384（内存算术见模块头）');
  const big = createPartialBuffer();
  big.observe('r2', ev(0, 'assistant_delta', { text: 'x'.repeat(5000) }));
  assert.equal(big.snapshot('r2').text.length, 5000, '5000 字符**不截**（旧默认 2000 会砍掉 ⇒ 判据 3 就是在这里输的）');
  big.observe('r2', ev(1, 'assistant_delta', { text: 'y'.repeat(12000) }));
  assert.equal(big.snapshot('r2').text.length, 16384);
  assert.equal(big.snapshot('r2').truncated, true);
});

test('D-4④：LRU 上界（构造参数可注入），观测刷新位置，逐出的是最久未观测的那个', () => {
  const b = createPartialBuffer({ maxEntries: 3 });
  b.observe('a', ev(0, 'assistant_delta', { text: 'A' }));
  b.observe('b', ev(0, 'assistant_delta', { text: 'B' }));
  b.observe('c', ev(0, 'assistant_delta', { text: 'C' }));
  b.observe('a', ev(1, 'assistant_delta', { text: 'A2' })); // 刷新 a 的位置
  b.observe('d', ev(0, 'assistant_delta', { text: 'D' }));
  assert.equal(b.size(), 3, '上界是硬的');
  assert.equal(b.snapshot('b'), null, 'b 是最久未观测 ⇒ 被逐出');
  assert.equal(b.snapshot('a').text, 'AA2', 'a 刚被观测过 ⇒ 留着');
  assert.equal(b.snapshot('c').text, 'C');
  assert.equal(b.snapshot('d').text, 'D');
});

test('D-4④（M-3）：LRU 满了先逐已终态的 run；全是活跃 run 时逐出必须出声（不许静默丢正文）', () => {
  const warns = [];
  const b = createPartialBuffer({ maxEntries: 2, log: { warn: (m) => warns.push(m) } });
  b.observe('active1', ev(0, 'assistant_delta', { text: '还在写' }));
  b.observe('done', ev(0, 'assistant_delta', { text: '已终态' }));
  b.markTerminal('done'); // 终态点的动作（`internal.js#retirePartialBuffer`）
  b.observe('active1', ev(1, 'assistant_delta', { text: '！' })); // 刷新位置：active1 现在是最"新"的
  b.observe('fresh', ev(0, 'assistant_delta', { text: 'F' }));
  // 旧版没有终态偏好 ⇒ 逐的是「最久未观测」的 `done`…那是巧合：只要 done 刚被写过就会被留下，
  // 而下一个活跃 run 的正文就被静默丢掉（它终态时写不出 `partial_text`）。
  assert.equal(b.snapshot('done'), null, '已终态的 run 优先让位（它的正文已经进 run_end 了）');
  assert.equal(b.snapshot('active1').text, '还在写！', '仍在流的 run 不被逐 ⇒ 它终态时还写得出 partial_text');
  assert.equal(warns.length, 0, '逐的是终态 run ⇒ 无需告警');
  assert.equal(b.stats().evictedActive, 0);

  // 全表都是活跃 run ⇒ 只能逐一个，但必须计数 + 出声（「不许静默」的后半条口径）
  const noisy = [];
  const c = createPartialBuffer({ maxEntries: 2, log: { warn: (m) => noisy.push(m) } });
  c.observe('x', ev(0, 'assistant_delta', { text: 'X' }));
  c.observe('y', ev(0, 'assistant_delta', { text: 'Y' }));
  c.observe('z', ev(0, 'assistant_delta', { text: 'Z' }));
  assert.equal(c.snapshot('x'), null);
  assert.equal(c.stats().evictedActive, 1, '逐出活跃 run 必须进 stats（界面上的表现是"那段没了"，日志里得能对账）');
  assert.equal(noisy.length, 1, `必须写一条告警：${JSON.stringify(noisy)}`);
  assert.match(noisy[0], /partial_text/, '告警要说清后果（写不进 run_end.partial_text），不只说"逐出了"');
});

test('D-4④（M-3）：counters 有上界（按 attempt 无界增长就是隐性泄漏）', () => {
  const b = createPartialBuffer({ maxCounters: 3 });
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    b.observe('r1', { client_event_id: `r1:${attempt}:0`, type: 'assistant_delta', payload: { text: 'x' }, session_id: 's1' });
  }
  const stats = b.stats();
  assert.equal(stats.maxCounters, 3, '上界可由构造参数注入');
  // 判据面：丢掉最老的 attempt 计数后，最老那次若真被重投就会重新累加一次。
  // 那是**有意的取舍**：只影响内存里那段气泡（终态正文另有 run_end.partial_text 兜底），
  // 换的是「长跑 run 的 counters 不再无界」。下面这条把取舍的另一面也钉住：新 attempt 照常算新内容。
  b.observe('r1', { client_event_id: 'r1:10:1', type: 'assistant_delta', payload: { text: 'y' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text.length, 11, '10 片 + 1 片（当前 attempt 的计数还在 ⇒ 判重仍生效）');
  b.observe('r1', { client_event_id: 'r1:10:1', type: 'assistant_delta', payload: { text: 'y' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text.length, 11, '同一计数重投 ⇒ 不重复累加');
  assert.equal(PARTIAL_MAX_COUNTERS_DEFAULT, 8);
  assert.equal(PARTIAL_MAX_ENTRIES_DEFAULT, 32, '默认 32 条（× 64 KB ≈ 2 MB；256 条会到 16 MB）');
});

test('D-4⑤（M-6②）：stage() 的变更在 commit() 之前不动真相；不 commit 就整体作废', () => {
  const b = createPartialBuffer();
  b.observe('r1', roundStart(0, 1, 1));
  b.observe('r1', ev(1, 'assistant_delta', { text: '已提交的' }));
  const tx = b.stage();
  tx.observe('r1', ev(2, 'assistant_delta', { text: '事务里的' }));
  tx.observe('r2', ev(3, 'assistant_delta', { text: '新 run' }));
  // 回滚的样子：事务里改了，但没人调 commit() ⇒ 真相一个字不动。
  // 旧版直接在事务里 observe：U3 后面租约校验失败/写报错 ⇒ 内存里已经累了正文，库里一行没有，
  // 补发侧与终态写都拿这段「内存有、库里无」的假象当真值（审计 B-4）。
  assert.equal(b.snapshot('r1').text, '已提交的', '真相未被污染');
  assert.equal(b.snapshot('r2'), null, '事务里新建的 run 也不许出现在真相里');
  assert.equal(tx.snapshot('r1').text, '已提交的事务里的', '事务**视图**看到真相 + 本事务的变更（终态写 partial_text 要在事务里读它）');
  tx.commit();
  assert.equal(b.snapshot('r1').text.includes('事务里的'), true, 'commit 之后才落到真相');
  assert.equal(b.snapshot('r2').text, '新 run');
});

test('D-4⑤（M-6②）：stage() 的去重判据在事务内自洽（同批重投不会被当成新内容）', () => {
  const b = createPartialBuffer();
  const tx = b.stage();
  assert.equal(tx.observe('r1', ev(0, 'assistant_delta', { text: 'AB' })), true, '首次观察');
  assert.equal(tx.observe('r1', ev(0, 'assistant_delta', { text: 'AB' })), false, '同一编号在事务内二次观察 ⇒ 判为重投');
  assert.equal(tx.observe('r1', ev(1, 'assistant_delta', { text: 'CD' })), true);
  tx.commit();
  assert.equal(b.snapshot('r1').text, 'ABCD', '重投的那条没被拼两遍');
});

test('D-4⑤（M-6②）：stage().drop 也在 commit 之后生效；已 drop 的 run 不再往里写', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'X' }));
  const tx = b.stage();
  tx.drop('r1');
  assert.equal(b.snapshot('r1').text, 'X', 'drop 也只是暂存');
  assert.equal(tx.snapshot('r1'), null, '本事务视图里已经没了');
  assert.equal(tx.observe('r1', ev(1, 'assistant_delta', { text: 'Y' })), false, 'drop 是终态语义 ⇒ 不再往回写');
  tx.commit();
  assert.equal(b.snapshot('r1'), null);
});

test('D-4：drop / clear / sessionRuns 与快照副本语义', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: 'x' }));
  b.observe('r2', ev(0, 'assistant_delta', { text: 'y' }, { session_id: 's2' }));
  assert.deepEqual(b.sessionRuns('s1'), ['r1'], '按会话取候选（补发侧用）');
  assert.deepEqual(b.sessionRuns('nope'), []);

  // M-4：已标终态的 run **不算**候选（它的正文已经进 run_end 了，再发一份快照就是重复正文）
  b.markTerminal('r2');
  assert.deepEqual(b.sessionRuns('s2'), [], '终态 run 退出补发候选集');
  assert.equal(b.snapshot('r2').terminal, true, '快照带 terminal（可观测面：为什么它不补发）');
  assert.equal(b.markTerminal('nope'), false, '没有这个 run ⇒ 如实报 false');

  const snap = b.snapshot('r1');
  snap.text = '改'; // 调用方改写不得污染缓冲
  assert.equal(b.snapshot('r1').text, 'x', 'snapshot 返回副本');
  assert.equal(b.snapshot('nope'), null, '没有该 run ⇒ null（不是空对象）');

  assert.equal(b.drop('r1'), true);
  assert.equal(b.drop('r1'), false, '再删一次如实报 false');
  assert.equal(b.snapshot('r1'), null);
  assert.equal(b.clear(), 1, 'clear 返回清掉的条数');
  assert.equal(b.size(), 0);
});

test('D-4：at-least-once 重投不重复累加（同一 attempt 内计数的高水位判重投）+ observe 返回首次观察', () => {
  const b = createPartialBuffer();
  assert.equal(b.observe('r1', ev(0, 'assistant_delta', { text: 'AB' })), true, '返回值 = 首次观察 ⇒ 写侧靠它决定是否转 SSE');
  assert.equal(b.observe('r1', ev(1, 'assistant_delta', { text: 'CD' })), true);
  // 整批重放（agentd 可重试路径把批次放回队首再发一遍）
  assert.equal(b.observe('r1', ev(0, 'assistant_delta', { text: 'AB' })), false, '重投 ⇒ false');
  assert.equal(b.observe('r1', ev(1, 'assistant_delta', { text: 'CD' })), false);
  assert.equal(b.snapshot('r1').text, 'ABCD', '正文只拼一遍');
  assert.equal(b.snapshot('r1').chunks, 2, '被识别为重投的碎片不计数');
  // 不同 attempt 的计数从 0 重新开始 ⇒ 不得被当重投（`runner/worker.js:193` 按 attempt 编号）
  b.observe('r1', { client_event_id: 'r1:2:0', type: 'assistant_delta', payload: { text: 'E' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text, 'ABCDE', '新 attempt 不是重投');
  // 不是那个形状（合成事件 / 手工上报）⇒ 不当判据，宁重不漏
  b.observe('r1', { client_event_id: 'r1:final:run_end', type: 'assistant_delta', payload: { text: 'F' }, session_id: 's1' });
  assert.equal(b.snapshot('r1').text, 'ABCDEF');
});

test('D-4：脏输入一律不进缓冲（不拿脏值冒充正文）', () => {
  const b = createPartialBuffer();
  assert.equal(b.observe('', ev(0, 'assistant_delta', { text: 'x' })), false, '空 runId');
  assert.equal(b.observe('r1', null), false, '没有事件');
  assert.equal(b.observe('r1', { type: 'usage', payload: {} }), false, '事实档（非 round_start）⇒ 不进');
  b.observe('r1', ev(0, 'assistant_delta', { text: 42 }));
  b.observe('r1', ev(1, 'assistant_delta', { text: null }));
  b.observe('r1', ev(2, 'assistant_delta', undefined));
  const s = b.snapshot('r1');
  assert.equal(s.text, '', '数字/null/缺键都不许变成正文（String() 会写出 "42" 那种脏东西）');
  assert.equal(s.chunks, 0);
});

test('copilot 复审②：textSegment = 正文段代际号（只在 round_start / closeRound 各 +1，单调不减，跨 run 互不影响）', () => {
  const b = createPartialBuffer();
  b.observe('r1', ev(0, 'assistant_delta', { text: '还没轮起点的半句' }));
  assert.equal(b.snapshot('r1').textSegment, 0, '开局 = 0（不是 null/undefined：前端要能直接比大小）');
  b.observe('r1', roundStart(1, 1, 7));
  assert.equal(b.snapshot('r1').textSegment, 1, 'round_start = 正文段边界 ⇒ +1');
  b.observe('r1', ev(2, 'assistant_delta', { text: '第一段' }));
  assert.equal(b.snapshot('r1').textSegment, 1, '碎片**不**推代际（否则每片都算新一代，那条守卫等于没有）');
  b.closeRound('r1');   // = durable `round_end` 的写入侧效果（`internal.js` 走 stage().closeRound）
  assert.equal(b.snapshot('r1').textSegment, 2, 'closeRound = 另一个正文段边界 ⇒ +1');
  assert.equal(b.snapshot('r1').chunks, 0, '同时 `chunks` 归零 —— 这正是它**不能**当代际号的现场');

  // 单调不减：随轮推进只进不退（每轮都采一次读数，含正文已空的时刻）
  // ⚠ `client_event_id` 的计数必须**全程递增**：`isRedelivery` 拿「同一 attempt 的计数高水位」判重投，
  //   拿比它小的号回去就是「重投」⇒ 那条事件被整条丢弃，本用例采不到代际。
  const seen = [b.snapshot('r1').textSegment];
  let n = 40;
  for (let round = 2; round <= 4; round++) {
    b.observe('r1', roundStart(n++, round, 20 + round));
    b.observe('r1', ev(n++, 'assistant_delta', { text: `第${round}轮` }));
    b.closeRound('r1');
    seen.push(b.snapshot('r1').textSegment);
  }
  assert.ok(seen.every((v, i) => i === 0 || v > seen[i - 1]), `代际必须严格递增：${JSON.stringify(seen)}`);
  // 既有字段语义一个字不许动（本单只加键）
  const snap = b.snapshot('r1');
  assert.equal(snap.chunks, 0, '`chunks` 仍是「本轮正文片数」（跟着轮边界归零），没被代际污染');
  assert.equal(snap.roundSeq, 24, '`roundSeq` 仍是当前轮 `round_start` 的 seq（没被代际改动）');
  assert.equal(snap.truncated, false, '`truncated` 语义不变');
  assert.ok(!('uptoSeq' in snap), '不加水位线类旧键（additive 只加 textSegment）');

  // 跨 run 互不影响
  b.observe('r2', ev(0, 'assistant_delta', { text: '另一个 run' }));
  assert.equal(b.snapshot('r2').textSegment, 0, '新 run 从 0 起（代际是 per-run 的，不是全局计数器）');
  assert.equal(b.snapshot('r1').textSegment, seen.at(-1), 'r1 的水位不因观测了 r2 而变');
  b.observe('r2', roundStart(1, 1, 3));
  assert.equal(b.snapshot('r2').textSegment, 1);
  assert.ok(b.snapshot('r2').textSegment < b.snapshot('r1').textSegment,
    '两个 run 各自数自己的段 ⇒ 前端必须按 run 记账（拿 A 的代际比 B 的帧会整帧丢）');

  // 重投去重不得重复推代际（`applyTo` 在 `isRedelivery` 判重**之后**才动槽）
  // ⚠ `client_event_id` 必须带**本 run 的 id** 前缀（`isRedelivery` 的正则拿 runId 拼），否则它根本
  //   不进判重通道（`ev()` 那个 helper 硬编码了 `r1:` 前缀，对 r2 不适用）。
  const before = b.snapshot('r2').textSegment;
  const rs = { client_event_id: 'r2:1:9', type: 'round_start', payload: { round: 2 }, session_id: 's1', seq: 11 };
  assert.equal(b.observe('r2', rs), true, '首次观察');
  assert.equal(b.snapshot('r2').textSegment, before + 1, '真的新一轮 ⇒ +1');
  assert.equal(b.observe('r2', rs), false, '同计数重投 ⇒ 判重');
  assert.equal(b.snapshot('r2').textSegment, before + 1, '重投的那条不得把代际多推一格');
});

test('copilot 复审②：stage()/commit 通道里代际同样只在 COMMIT 后生效（没 commit 就不留痕）', () => {
  const b = createPartialBuffer();
  b.observe('r1', roundStart(0, 1, 5));
  assert.equal(b.snapshot('r1').textSegment, 1);
  const tx = b.stage();
  tx.observe('r1', roundStart(1, 2, 9));
  tx.closeRound('r1');
  assert.equal(tx.snapshot('r1').textSegment, 3, '事务**视图**看到本事务的两格');
  assert.equal(b.snapshot('r1').textSegment, 1, '未 COMMIT ⇒ 真相不动（口径④）');
  tx.commit();
  assert.equal(b.snapshot('r1').textSegment, 3, 'COMMIT 之后才并进真相');
  const tx2 = b.stage();
  tx2.observe('r1', roundStart(2, 3, 15));
  assert.equal(b.snapshot('r1').textSegment, 3, '没 commit 的事务不留痕（回滚 = 不推代际）');
});

test('D-4：单例导出可用（写入侧与补发侧共用一份）', () => {
  partialOutputs.clear();
  partialOutputs.observe('rr', { client_event_id: 'rr:1:0', type: 'assistant_delta', payload: { text: 'hi' }, session_id: 'ss' });
  assert.equal(partialOutputs.snapshot('rr').text, 'hi');
  partialOutputs.clear();
  assert.equal(partialOutputs.snapshot('rr'), null);
});
