// issue #333 M2 承重：轮记录**写入面**的幂等/冲突行为级判别。
//
// 为什么单独一个文件：这两处端点（U5 `putRound` 与引擎轮记录走的 `putSessionRound`）此前只有
// 源码级「同一把尺」断言在钉，**行为面零判别力**——主 agent 实测把 `samePayload(ex.record, record)`
// 改成 `if (true)`（永不冲突）或 `if (false)`（次次冲突），跑 `internal.test.js` +
// `transcript-store.test.js` 都是 98 通过 / 0 失败。本文件的判据就是：**那两条变异各自必须转红**。
//
// 真雷本体（erix-agent 0.22）：引擎新增的 `…:engine:round:<n>:control:<slot>` / `:fold:<fp>` /
// `:ttl:<fp>` 三类行每次写都带 `ts: new Date()`（`orchestrator.js` 的 appendEngineMessagesToTranscript），
// resume 重放同一个 dedupKey 时**必然拿到新 ts**（session 作用域下 `round` 也会漂，宿主取 MAX(round)+1）。
// 旧判据是整条 record 的 sha256 ⇒ 顶层 ts/round 也算进哈希 ⇒ 伪报 `409 round_conflict`，
// 而 `runner/lib/store.js` 对非 2xx 一律上抛 ⇒ 引擎按持久化失败处理，终局 `persistence_failed`。
import test from 'node:test';
import assert from 'node:assert/strict';

import { claimRun, putRound, putSessionRound, InternalError } from '../src/internal.js';
import { payloadFingerprint } from '../src/transcript-payload.js';
import { seedClaimable } from './fake-internal-pool.js';
import { engineControlRow } from './fake-transcript-rounds.js';

function seated() {
  const seeded = seedClaimable();
  const container = { id: seeded.containerId, user_id: seeded.userId };
  const user = { id: seeded.userId, login: 'alice' };
  return { ...seeded, container, user };
}

const CONTROL_TEXT = '评审意见：还差回归用例，继续。';

// ---------------------------------------------------------------------------
// session 作用域（引擎轮记录的真实通路：runner makeStore().appendRound → agentd → 本端点）
// ---------------------------------------------------------------------------

test('#333 putSessionRound：0.22 控制行首写落库（dedupKey 带 :control:<slot>）', async () => {
  const { pool, userId, containerId, runId, sessionId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const row = engineControlRow(sessionId, { round: 7, slot: 'judge-nudge', text: CONTROL_TEXT });

  const res = await putSessionRound(pool, {
    container, user, key: sessionId, round: 7, claimToken: ticket.claim_token, writerRunId: runId, body: row,
  });

  assert.equal(res.inserted, true);
  const stored = pool.rounds.filter((x) => x.transcript_key === sessionId && x.dedup_key === row.dedupKey);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].record.messages[0].meta.source, 'judge-control', '0.22 控制行的 marker 原样落库');
});

test('#333 putSessionRound：resume 重放（同 dedupKey，顶层 ts 与 round 都漂）判**幂等**，不新增行也不覆盖', async () => {
  const { pool, containerId, userId, runId, sessionId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const row = engineControlRow(sessionId, { round: 7, slot: 'judge-nudge', text: CONTROL_TEXT });
  await putSessionRound(pool, {
    container, user, key: sessionId, round: 7, claimToken: ticket.claim_token, writerRunId: runId, body: row,
  });

  // 崩溃重跑形状：dedupKey 不变，墙钟 `ts` 与派生 `round` 必然不同。
  const replay = { ...row, round: 9, ts: '2026-10-21T00:09:59.999Z' };
  const second = await putSessionRound(pool, {
    container, user, key: sessionId, round: 9, claimToken: ticket.claim_token, writerRunId: runId, body: replay,
  });

  assert.equal(second.inserted, false, '同 payload（只漂顶层 ts/round）必须判幂等命中，不是 409');
  const stored = pool.rounds.filter((x) => x.transcript_key === sessionId && x.dedup_key === row.dedupKey);
  assert.equal(stored.length, 1, '幂等命中不得新增行');
  assert.deepEqual(stored[0].record, row, '既有 record 一字未被覆盖（既不覆盖也不丢弃）');
  assert.equal(stored[0].round, 7, '幂等命中不得改写已落库的 round');
});

test('#333 putSessionRound：真换正文 ⇒ 409 round_conflict，details 带两份指纹与差异顶层字段，既有行未被覆盖', async () => {
  const { pool, containerId, userId, runId, sessionId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const row = engineControlRow(sessionId, { round: 7, slot: 'judge-nudge', text: CONTROL_TEXT });
  await putSessionRound(pool, {
    container, user, key: sessionId, round: 7, claimToken: ticket.claim_token, writerRunId: runId, body: row,
  });

  const changed = {
    ...row,
    ts: '2026-10-21T00:10:00.000Z',
    messages: [{ role: 'user', meta: { source: 'judge-control' }, content: [{ type: 'text', text: '换了别的正文' }] }],
  };
  await assert.rejects(
    putSessionRound(pool, {
      container, user, key: sessionId, round: 7, claimToken: ticket.claim_token, writerRunId: runId, body: changed,
    }),
    (err) => {
      assert.ok(err instanceof InternalError, '走 internal 统一错误信封');
      assert.equal(err.status, 409);
      assert.equal(err.code, 'round_conflict', '零新错误码：真冲突仍复用既有 round_conflict');
      assert.equal(err.details.existingFingerprint, payloadFingerprint(row), '既有侧指纹可复核');
      assert.equal(err.details.incomingFingerprint, payloadFingerprint(changed));
      assert.deepEqual(err.details.differingFields, ['messages'], '差异字段点名（顶层 ts 属身份/墙钟，不算差异）');
      return true;
    },
  );

  const stored = pool.rounds.filter((x) => x.transcript_key === sessionId && x.dedup_key === row.dedupKey);
  assert.equal(stored.length, 1, '冲突不落第二行');
  assert.deepEqual(stored[0].record, row, '冲突时既有 record 也未被覆盖');
});

test('#333 putSessionRound：数组顺序换了就是冲突（消息顺序是语义，不是可忽略的字段顺序）', async () => {
  const { pool, containerId, userId, runId, sessionId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const row = {
    dedupKey: `${sessionId}:engine:round:4:control:extend`,
    roundKey: `${sessionId}:round:4`,
    round: 4,
    ts: '2026-10-21T00:00:00.000Z',
    messages: [
      { role: 'user', meta: { source: 'judge-control' }, content: [{ type: 'text', text: '第一条' }] },
      { role: 'assistant', content: [{ type: 'text', text: '第二条' }] },
    ],
  };
  await putSessionRound(pool, {
    container, user, key: sessionId, round: 4, claimToken: ticket.claim_token, writerRunId: runId, body: row,
  });

  const swapped = { ...row, ts: '2026-10-21T00:11:00.000Z', messages: [...row.messages].reverse() };
  await assert.rejects(
    putSessionRound(pool, {
      container, user, key: sessionId, round: 4, claimToken: ticket.claim_token, writerRunId: runId, body: swapped,
    }),
    (err) => err.code === 'round_conflict' && err.details.differingFields.includes('messages'),
  );

  // 对照组：只是对象键顺序不同 ⇒ 不是差异（幂等）。少这条断言，「排序式指纹」写反了也不会红。
  const reordered = { ...row, ts: '2026-10-21T00:12:00.000Z' };
  const reshuffled = Object.fromEntries(Object.entries(reordered).reverse());
  const res = await putSessionRound(pool, {
    container, user, key: sessionId, round: 4, claimToken: ticket.claim_token, writerRunId: runId, body: reshuffled,
  });
  assert.equal(res.inserted, false, '字段顺序不是语义 ⇒ 幂等命中');
});

// ---------------------------------------------------------------------------
// run 作用域（U5 putRound）：(run_id, round) 唯一 ⇒ resume 漂移面只有墙钟 `ts`
// ---------------------------------------------------------------------------

test('#333 putRound：同 dedupKey 只漂顶层 ts ⇒ 幂等命中，不新增行也不覆盖', async () => {
  const { pool, containerId, userId, runId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const body = {
    dedupKey: `${runId}:engine:round:2:control:forced-final`,
    round: 2,
    ts: '2026-10-21T00:00:00.000Z',
    messages: [{ role: 'assistant', content: [{ type: 'text', text: '终稿' }] }],
  };
  const first = await putRound(pool, {
    container, user, runId, round: 2, claimToken: ticket.claim_token, body,
  });
  assert.equal(first.inserted, true);

  const replay = { ...body, ts: '2026-10-21T00:20:00.000Z' };
  const second = await putRound(pool, {
    container, user, runId, round: 2, claimToken: ticket.claim_token, body: replay,
  });

  assert.equal(second.inserted, false, '只漂墙钟必须判幂等（旧整条哈希判据会在这里伪报 409）');
  const stored = pool.rounds.filter((x) => x.run_id === runId && Number(x.round) === 2);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].record, body);
});

test('#333 putRound：真换正文 ⇒ 409 round_conflict（run 作用域同尺）', async () => {
  const { pool, containerId, userId, runId, container, user } = seated();
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });
  const body = {
    dedupKey: `${runId}:engine:round:3:control:extend`,
    round: 3,
    ts: '2026-10-21T00:00:00.000Z',
    messages: [{ role: 'user', meta: { source: 'judge-control' }, content: [{ type: 'text', text: '扩轮提示' }] }],
  };
  await putRound(pool, { container, user, runId, round: 3, claimToken: ticket.claim_token, body });

  const changed = { ...body, messages: [{ role: 'user', meta: { source: 'judge-control' }, content: [{ type: 'text', text: '换掉' }] }] };
  await assert.rejects(
    putRound(pool, { container, user, runId, round: 3, claimToken: ticket.claim_token, body: changed }),
    (err) => err.status === 409 && err.code === 'round_conflict'
      && err.details.existingFingerprint === payloadFingerprint(body)
      && err.details.differingFields.includes('messages'),
  );
});
