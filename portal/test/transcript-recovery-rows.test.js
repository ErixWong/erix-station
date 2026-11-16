// issue #500：账本恢复行三件套（`portal/src/transcript-store.js` 的 `createRecoveryRowStore`）行为级判据。
//
// 钉四条，一条都不能少（工单 §3 验收判据 + §1 红线）：
//   ① **幂等**：同 `dedupKey` + 同 payload ⇒ 返回 `false` 且**不新增行**（引擎重放同一个「执行过了」
//      事件时必然拿到新的顶层 `ts`，判据必须把它当重放而不是冲突）；
//   ② **冲突**：同 `dedupKey` + **异 payload** ⇒ 拒绝（`code === 'dedup_payload_conflict'`）且
//      **既有行一字不被覆盖**（契约原话 no overwrite, no silent drop）；
//   ③ **清空**：`clearRecoveryRows` 返回 `true`/`false`（删了至少一行 / 本来就没有），**且只打新表**——
//      `transcript_rounds` 全站零 DELETE 是 `sessions.js` 折叠重建「可证无损」的论证前提；
//   ④ **红线：恢复行不出现在 `load()` 里**（也不出现在 resume 读面 `getSessionTranscript` 里）——
//      这条是「新建表而不是给 `transcript_rounds` 加 `kind` 列」的全部理由，必须有断言指着它。
//
// 另有一条**防漂移**判据（不在四条里，但它是这个文件存在的一半理由）：本站写侧的 `tool-executed`
// 形状闸与**上游真件** `erix-agent/src/store/recovery-rows.js#toolExecutedRecoveryRowShapeProblem`
// 逐格对拍。上游那个文件不在包 `exports` 面里（只有 `.` / `./tools` / `./contract-tests`），
// 所以按**文件路径**深路径 import —— 与 `portal/test/transcript-payload.test.js` ↔
// 上游 `transcript-dedup.js` 完全同一手法：上游改形状 ⇒ 本文件红，而不是两把尺各自漂移。
//
// 两支形态：
//   · 主用例跑在**内存 fake**上（不碰 PG，`npm test` 里恒跑）：fake 的规矩与
//     `fake-transcript-rounds.js` 同一条——「按 SQL 说的做，不替产品兜底」，撞键读回只回**真存着的那条**，
//     不认的 SQL **抛错**（让「产品发了一句 fake 不认识的 SQL」当场红，而不是拿到空行假装成功）。
//   · 真库用例（`TEST_DATABASE_URL` 注入，docs/testing.md §2.2.1）跑判据 ①②④ 的**真 DB 形状**：
//     幂等键靠 PG 的 PRIMARY KEY 而不是 fake 的 JS 比较，`load()` 的隔离靠的是「不同表」这个物理事实。
//     未注入 ⇒ 整个真库段 `skip`（不是假通过；skip 文案用 `pg-fixture.js` 的 `SKIP_WITHOUT_PG` 单点）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecoveryRowStore, createSessionTranscriptStore } from '../src/transcript-store.js';
import { DEDUP_CONFLICT_CODE } from '../src/transcript-payload.js';
import { createPgFixture, SKIP_WITHOUT_PG } from './pg-fixture.js';

const URL_VALUE = (process.env.TEST_DATABASE_URL || '').trim();
const pgFixture = URL_VALUE ? createPgFixture(URL_VALUE, { prefix: 'w500' }) : null;

const KEY = 'sess-500-1';
const OTHER_KEY = 'sess-500-2';

/** 引擎 `buildToolExecutedRecoveryRow` 的形状（`src/store/recovery-rows.js`，逐字段照抄）。 */
const executedRow = (runId, { round = 3, toolUseId = 'call-7f', ts = '2026-11-16T00:00:00.000Z' } = {}) => ({
  round,
  roundKey: `${runId}:round:${round}`,
  dedupKey: `${runId}:engine:round:${round}:recovery:tool-executed:${toolUseId}`,
  kind: 'recovery',
  recoveryEvent: 'tool-executed',
  toolUseId,
  messages: [],
  ts,
});

/** `tool-result-unledgered`（结果行写失败的兜底，带 toolResult）。 */
const unledgeredRow = (runId, { round = 3, toolUseId = 'call-7f', text = 'ok', ts } = {}) => ({
  round,
  roundKey: `${runId}:round:${round}`,
  dedupKey: `${runId}:engine:round:${round}:recovery:tool-result-unledgered:${toolUseId}`,
  kind: 'recovery',
  recoveryEvent: 'tool-result-unledgered',
  notYetLedgered: true,
  toolUseId,
  toolResult: { type: 'tool_result', tool_use_id: toolUseId, content: text },
  messages: [],
  ts: ts ?? '2026-11-16T00:00:01.000Z',
});

/** `partial-text`（本站 #301 未开 partialPersistence ⇒ 今天不产生，读侧要能忽略/透传）。 */
const partialRow = (runId, { round = 3, text = '半截', ts } = {}) => ({
  round,
  roundKey: `${runId}:round:${round}`,
  dedupKey: `${runId}:engine:round:${round}:recovery:partial-text:sha256:${text}`,
  kind: 'recovery',
  recoveryEvent: 'partial-text',
  text,
  messages: [],
  ts: ts ?? '2026-11-16T00:00:02.000Z',
});

// ---------------------------------------------------------------------------
// 内存 fake：只实现恢复行那三条 SQL（形状闸见文件头）
// ---------------------------------------------------------------------------

function fakeRecoveryClient() {
  const rows = [];          // 真列名：transcript_key / dedup_key / round / record / append_seq
  let seq = 0;
  const state = { inserts: 0, conflictSkips: 0, readBacks: 0, deletes: 0 };
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  const find = (key, dedupKey) => rows.find((r) => r.transcript_key === key && r.dedup_key === dedupKey);

  return {
    state,
    rows,
    async query(sql, params = []) {
      const s = norm(sql);
      if (/^INSERT INTO transcript_recovery_rows\b/i.test(s)) {
        state.inserts += 1;
        const [key, dedupKey, round, record] = params;
        if (typeof key !== 'string' || typeof dedupKey !== 'string') throw new Error('not-null violation');
        if (dedupKey.length > 255) {
          throw new Error('23514: length(dedup_key) <= 255');   // 迁移 0036 的列宽 CHECK
        }
        if (!Number.isInteger(round) || round < 0) throw new Error('23514: round >= 0');
        if (find(key, dedupKey)) {
          if (!/ON CONFLICT \(transcript_key, dedup_key\) DO NOTHING/i.test(s)) {
            throw new Error('23505: duplicate key value violates unique constraint "transcript_recovery_rows_pkey"');
          }
          state.conflictSkips += 1;
          return { rows: [], rowCount: 0 };   // 真库：被仲裁跳过 ⇒ 零行
        }
        rows.push({
          transcript_key: key, dedup_key: dedupKey, round,
          record: JSON.parse(record), append_seq: (seq += 1),
        });
        return { rows: [{ dedup_key: dedupKey }], rowCount: 1 };
      }
      if (/^SELECT record FROM transcript_recovery_rows\b/i.test(s)
        && /WHERE transcript_key = \$1 AND dedup_key = \$2/i.test(s)) {
        const hit = find(params[0], params[1]);
        if (!hit) return { rows: [], rowCount: 0 };   // 没存过 ⇒ 零行，**绝不**把「想写的那条」回给调用方
        state.readBacks += 1;
        return { rows: [{ record: hit.record }], rowCount: 1 };
      }
      if (/^SELECT record FROM transcript_recovery_rows\b/i.test(s) && /ORDER BY append_seq/i.test(s)) {
        const list = rows.filter((r) => r.transcript_key === params[0])
          .sort((a, b) => a.append_seq - b.append_seq)
          .map((r) => ({ record: r.record }));
        return { rows: list, rowCount: list.length };
      }
      if (/^DELETE FROM transcript_recovery_rows\b/i.test(s)) {
        state.deletes += 1;
        const keep = rows.filter((r) => r.transcript_key !== params[0]);
        const removed = rows.length - keep.length;
        rows.length = 0;
        rows.push(...keep);
        return { rows: Array.from({ length: removed }, () => ({ 1: 1 })), rowCount: removed };
      }
      // 轮记录表被碰了就要看得见（红线④的负向半边：恢复行的任何一条 SQL 都不许打到 transcript_rounds）
      if (/transcript_rounds/i.test(s)) throw new Error(`恢复行路径不该碰 transcript_rounds：${s.slice(0, 90)}`);
      throw new Error(`fake 不认识的 SQL（产品新加了读点，请同步 fake）：${s.slice(0, 110)}`);
    },
  };
}

const store = (client) => createRecoveryRowStore(client);

// ---------------------------------------------------------------------------
// ① 幂等
// ---------------------------------------------------------------------------

test('#500 幂等：同 dedupKey + 同 payload ⇒ false，且不新增行、不改写既有行', async () => {
  const client = fakeRecoveryClient();
  const first = await store(client).appendRecoveryRow(KEY, executedRow(KEY));
  assert.equal(first, true, '首写必须报「真写进去了一行」');

  // 崩溃重跑形状：引擎重算同一事件 ⇒ dedupKey 逐字相同、只有墙钟 `ts` 与派生 `round` 会漂。
  const replay = { ...executedRow(KEY), round: 4, roundKey: `${KEY}:round:4`, ts: '2026-11-16T00:09:59.999Z' };
  const second = await store(client).appendRecoveryRow(KEY, replay);

  assert.equal(second, false, '同 payload（只漂顶层 ts/round）必须判幂等跳过，不是抛错也不是 true');
  assert.equal(client.rows.length, 1, '幂等跳过不得新增行');
  assert.deepEqual(client.rows[0].record, executedRow(KEY), '既有行一字未被覆盖');
  assert.equal(client.state.conflictSkips, 1, '第二笔确实走了 ON CONFLICT 仲裁（不是没发写）');
});

test('#500 幂等的另一侧：不同 toolUseId ⇒ 换键 ⇒ 两行并存（一格一条，同轮多行是正常形状）', async () => {
  const client = fakeRecoveryClient();
  await store(client).appendRecoveryRow(KEY, executedRow(KEY, { toolUseId: 'call-a' }));
  const added = await store(client).appendRecoveryRow(KEY, executedRow(KEY, { toolUseId: 'call-b' }));
  assert.equal(added, true);
  assert.equal(client.rows.length, 2, '同一轮两个 tool_use ⇒ 两条 tool-executed 行（契约：one row = one event）');
});

// ---------------------------------------------------------------------------
// ② 冲突
// ---------------------------------------------------------------------------

test('#500 冲突：同 dedupKey + 异 payload ⇒ 抛 dedup_payload_conflict，既有行不被覆盖', async () => {
  const client = fakeRecoveryClient();
  const stored = executedRow(KEY, { toolUseId: 'call-7f' });
  await store(client).appendRecoveryRow(KEY, stored);

  // 同键换正文（同一事件被宿主改写过内容）⇒ 这是真冲突，不是重放。
  const conflicting = { ...stored, toolUseId: 'call-7f', messages: [{ role: 'user', content: '不该有正文' }] };
  await assert.rejects(
    () => store(client).appendRecoveryRow(KEY, conflicting),
    (err) => {
      assert.equal(err.code, DEDUP_CONFLICT_CODE, '判据是 code 不是 instanceof（随包契约套件同口径）');
      assert.match(err.message, /dedup conflict/i, '消息里要点名是 dedup 冲突');
      assert.equal(err.key, stored.dedupKey, '消息要指认是哪把键');
      assert.match(err.message, /no overwrite, no silent drop/, '语义声明必须在');
      return true;
    },
  );
  assert.equal(client.rows.length, 1, '冲突不得留下第二行');
  assert.deepEqual(client.rows[0].record, stored, '既有行原样留着（拒绝 = 不覆盖）');
});

test('#500 写侧形状闸：tool-executed 行缺 toolUseId / round 畸形 ⇒ 拒收，且不发任何写', async () => {
  const client = fakeRecoveryClient();
  for (const [label, row] of [
    ['缺 toolUseId', { ...executedRow(KEY), toolUseId: undefined }],
    ['空 toolUseId', { ...executedRow(KEY), toolUseId: '' }],
    ['round 非安全整数', { ...executedRow(KEY), round: NaN }],
    ['缺 dedupKey', { ...executedRow(KEY), dedupKey: undefined }],
    ['kind 不是 recovery', { ...executedRow(KEY), kind: 'message' }],
  ]) {
    await assert.rejects(() => store(client).appendRecoveryRow(KEY, row), /recovery row rejected|kind must be/, label);
  }
  assert.equal(client.state.inserts, 0, '形状不合的行必须在写之前就挡住——写进去才炸是更差的排障时序');
});

test('#500 写侧不越权：tool-result-unledgered / partial-text 原样透传（形状守卫归引擎读侧）', async () => {
  const client = fakeRecoveryClient();
  assert.equal(await store(client).appendRecoveryRow(KEY, unledgeredRow(KEY)), true);
  assert.equal(await store(client).appendRecoveryRow(KEY, partialRow(KEY)), true);
  assert.deepEqual(client.rows.map((r) => r.record.recoveryEvent),
    ['tool-result-unledgered', 'partial-text'], '两种事件都收，字段不改写（本站不是第二把尺）');
});

// ---------------------------------------------------------------------------
// ③ 清空
// ---------------------------------------------------------------------------

test('#500 清空：clearRecoveryRows 原样透出 true/false，且 DELETE 只打新表', async () => {
  const client = fakeRecoveryClient();
  assert.equal(await store(client).clearRecoveryRows(KEY), false, '本来就没有 ⇒ false（合法结果，不是错误）');

  await store(client).appendRecoveryRow(KEY, executedRow(KEY, { toolUseId: 'call-a' }));
  await store(client).appendRecoveryRow(OTHER_KEY, executedRow(OTHER_KEY, { toolUseId: 'call-z' }));

  assert.equal(await store(client).clearRecoveryRows(KEY), true, '删了至少一行 ⇒ true');
  assert.deepEqual(client.rows.map((r) => r.transcript_key), [OTHER_KEY],
    '清盘只清这个 key：别的会话的执行证据不许一起清掉');
  assert.equal(await store(client).clearRecoveryRows(KEY), false, '第二次清 ⇒ false（可重放）');
  assert.equal(client.state.deletes, 3, '每次都真发 DELETE（幂等语义在 SQL 结果里，不是靠 fake 少发一次）');
});

test('#500 红线：恢复行的三条 SQL 一条都不碰 transcript_rounds（全站该表零 DELETE 的前提不许破）', async () => {
  const client = fakeRecoveryClient();   // fake 里任何触及 transcript_rounds 的 SQL 都会抛
  await store(client).appendRecoveryRow(KEY, executedRow(KEY));
  await store(client).listRecoveryRows(KEY);
  await store(client).clearRecoveryRows(KEY);
  assert.ok(true, '上面三句都没抛 ⇒ 恢复行路径与轮账本完全隔离');
});

// ---------------------------------------------------------------------------
// ④ 读面形状 + 红线「不进 load()」
// ---------------------------------------------------------------------------

test('#500 读面：listRecoveryRows 按 append_seq 升序返回 record 本体（不折叠、不合成列字段、不吞错）', async () => {
  const client = fakeRecoveryClient();
  // 故意乱序种：append_seq 由写序决定，与 round 无关（partial-text 取「该轮最后落盘」那条靠的就是这个序）。
  await store(client).appendRecoveryRow(KEY, partialRow(KEY, { round: 9, text: 'later-round' }));
  await store(client).appendRecoveryRow(KEY, executedRow(KEY, { round: 1, toolUseId: 'call-1' }));
  await store(client).appendRecoveryRow(KEY, executedRow(KEY, { round: 2, toolUseId: 'call-2' }));

  const rows = await store(client).listRecoveryRows(KEY);
  assert.ok(Array.isArray(rows), '契约：返回数组（空数组是唯一的「静默没证据」）');
  assert.deepEqual(rows.map((r) => r.recoveryEvent),
    ['partial-text', 'tool-executed', 'tool-executed'], '顺序 = 落盘顺序，不是 round 顺序');
  assert.deepEqual(rows.map((r) => r.toolUseId).filter(Boolean), ['call-1', 'call-2']);
  assert.ok(!Object.hasOwn(rows[0], 'append_seq'), 'append_seq 是内部分页列，不进返回集');
});

test('#500 红线：恢复行不出现在 load() 里（本站唯一的轮记录读点被同一份 fake 喂两张表）', async () => {
  // 轮记录表与恢复行表**物理分离** ⇒ 这一条断言钉的就是「不同表」：同一个 client 上两套 SQL 都能答，
  // 只要 `load()` 的 SQL 里多出一张表 / 恢复行被写进 transcript_rounds，这里立刻多一行。
  const rounds = [];
  const client = layeredClient({ recovery: fakeRecoveryClient(), rounds });

  await store(client).appendRecoveryRow(KEY, executedRow(KEY, { toolUseId: 'call-7f' }));
  await store(client).appendRecoveryRow(KEY, partialRow(KEY));
  await createSessionTranscriptStore(client).appendRound(KEY, {
    round: 3, dedupKey: `${KEY}:engine:round:3`, messages: [], ts: '2026-11-16T00:00:00.000Z',
  });

  const loaded = await createSessionTranscriptStore(client).load(KEY);
  assert.equal(loaded.length, 1, 'load() 只有轮记录那一行（恢复行两条都不在）');
  assert.deepEqual(loaded.map((r) => r.dedupKey), [`${KEY}:engine:round:3`]);
  assert.ok(!loaded.some((r) => r.kind === 'recovery'),
    '恢复行混进 load() = 每条恢复行都给同一轮追加一条引擎事实（污染 judge 看到的轮次历史）');
  // 反向自证：恢复行确实写进去了（不是「根本没写所以看不见」的假绿）。
  assert.equal((await store(client).listRecoveryRows(KEY)).length, 2);
});

/** 把「恢复行 SQL」与「轮记录 SQL」两套 fake 拼在一个 client 上（load() 与恢复行共用同一个入口）。 */
function layeredClient({ recovery, rounds }) {
  const roundsHit = roundsHandler(rounds);
  return {
    async query(sql, params = []) {
      const hit = await roundsHit(sql, params);
      if (hit) return hit;
      return recovery.query(sql, params);
    },
  };
}

function roundsHandler(rows) {
  const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
  let seq = 0;
  return async (sql, params = []) => {
    const s = norm(sql);
    if (/^INSERT INTO transcript_rounds\b/i.test(s)) {
      const [key, dedupKey, round, record, folded, messages, foldedPayload] = params;
      if (rows.find((r) => r.transcript_key === key && r.dedup_key === dedupKey)) return { rows: [], rowCount: 0 };
      rows.push({
        transcript_key: key, dedup_key: dedupKey, run_id: null, round,
        record: JSON.parse(record), folded, messages: JSON.parse(messages ?? '[]'),
        folded_payload: foldedPayload ? JSON.parse(foldedPayload) : null,
        append_seq: (seq += 1), created_at: seq,
      });
      return { rows: [{ id: `tr${seq}` }], rowCount: 1 };
    }
    if (/^SELECT round, dedup_key, record FROM transcript_rounds\b/i.test(s)) {
      const list = rows.filter((r) => r.transcript_key === params[0])
        .sort((a, b) => a.append_seq - b.append_seq)
        .map((r) => ({ round: r.round, dedup_key: r.dedup_key, record: r.record }));
      return { rows: list, rowCount: list.length };
    }
    if (/^SELECT MAX\(round\) AS max_round FROM transcript_rounds\b/i.test(s)) {
      const rs = rows.filter((r) => r.transcript_key === params[0]).map((r) => Number(r.round));
      return { rows: [{ max_round: rs.length ? Math.max(...rs) : null }], rowCount: 1 };
    }
    return null;   // 交回下一个 handler
  };
}

// ---------------------------------------------------------------------------
// 防漂移：本站写侧闸 ↔ 上游真件逐格对拍（深路径 import，同 transcript-payload.test.js 手法）
// ---------------------------------------------------------------------------

const UPSTREAM_PATH = new URL('../../node_modules/erix-agent/src/store/recovery-rows.js', import.meta.url);
let upstream;
try {
  upstream = await import(UPSTREAM_PATH);
} catch (err) {
  assert.fail(`拿不到上游恢复行件 ${UPSTREAM_PATH.pathname}（${err.message}）`
    + ' —— 上游可能挪动/改名了 src/store/recovery-rows.js，请重新核对本站写侧闸是否还该存在');
}

test('#500 对拍：上游三个 builder 造出来的行，本站写侧一律收（本站不是第二把尺）', async () => {
  const built = [
    upstream.buildToolExecutedRecoveryRow({ runId: KEY, round: 3, toolUseId: 'call-7f' }),
    upstream.buildUnledgeredToolResultRecoveryRow({
      runId: KEY, round: 3, toolUseId: 'call-7f',
      toolResult: { type: 'tool_result', tool_use_id: 'call-7f', content: 'ok' },
    }),
    upstream.buildPartialTextRecoveryRow({ runId: KEY, round: 4, text: '跑到一半的正文' }),
  ];
  const client = fakeRecoveryClient();
  for (const row of built) {
    assert.equal(await store(client).appendRecoveryRow(KEY, row), true,
      `上游 builder 的产物必须收（${row.recoveryEvent}）`);
  }
  // 引擎读侧也认这批行（本站存的形状 = 引擎读得回的形状）。
  const rows = await store(client).listRecoveryRows(KEY);
  assert.deepEqual([...upstream.readExecutedToolIdRecoveryRows(rows)], ['call-7f']);
  assert.deepEqual(upstream.readPartialTextRecoveryRounds(rows), [4]);
});

test('#500 对拍：上游读侧守卫会抛的行，本站写侧也拒（两道闸同一把尺，不各说各话）', async () => {
  const malformed = [
    { label: '缺 toolUseId', row: { ...executedRow(KEY), toolUseId: undefined } },
    { label: 'round 是 NaN', row: { ...executedRow(KEY), round: NaN } },
    { label: '缺 dedupKey', row: { ...executedRow(KEY), dedupKey: undefined } },
  ];
  for (const { label, row } of malformed) {
    // 上游：读侧抛（不是静默跳过 —— 那是本切片要防的那个错）。
    assert.throws(
      () => upstream.readExecutedToolIdRecoveryRows([row]),
      /malformed on field/,
      `${label}：上游读侧守卫必须抛（本站若静默收下就和引擎各说各话）`,
    );
    // 本站：写侧同向拒收。
    await assert.rejects(() => store(fakeRecoveryClient()).appendRecoveryRow(KEY, row), /recovery row rejected/, label);
  }
});

test('#500 红线：本站读面把畸形行原样交出去，由引擎抛 recovery_rows_unreadable（本站不静默跳过）', async () => {
  // 手工种一条**没有 toolUseId** 的 tool-executed 行（真库里可能来自手修/半截修复/截断）。
  const client = fakeRecoveryClient();
  client.rows.push({
    transcript_key: KEY, dedup_key: `${KEY}:engine:round:3:recovery:tool-executed:`, round: 3,
    record: { round: 3, kind: 'recovery', recoveryEvent: 'tool-executed', messages: [], ts: 'T' },
    append_seq: 1,
  });
  const rows = await store(client).listRecoveryRows(KEY);
  assert.equal(rows.length, 1, '本站一个都不滤（滤掉 = 把唯一的执行证据当没有）');
  assert.throws(() => upstream.readExecutedToolIdRecoveryRows(rows), /malformed on field "toolUseId"/,
    '抛错发生在引擎那一侧（它包成 recovery_rows_unreadable），不是被本站吞掉');
});

test('#500 未认识的 recoveryEvent 原样透传（前向兼容：新事件不许把老宿主搞崩）', async () => {
  const client = fakeRecoveryClient();
  const future = { ...executedRow(KEY), recoveryEvent: 'tool-reaped-by-something-new' };
  assert.equal(await store(client).appendRecoveryRow(KEY, future), true, '本站不收字段清单，只认 kind');
  const rows = await store(client).listRecoveryRows(KEY);
  assert.deepEqual([...upstream.readExecutedToolIdRecoveryRows(rows)], [],
    '引擎侧忽略未知事件（契约里唯一那条前向兼容承诺），本站也不替它挑行');
});

// ---------------------------------------------------------------------------
// 真库（TEST_DATABASE_URL 注入）：幂等键 / 冲突 / 不进 load() 的**真 DB 形状**
// ---------------------------------------------------------------------------

const withFreshDb = (fn) => pgFixture.withFreshDatabase(
  ({ database, pool }) => fn(pool, database),
  { poolMax: 2, log: () => {} },
);

test('#500 真库：新表存在、幂等键在、排序索引在（迁移 0036 真的建出来了）', { skip: URL_VALUE ? false : SKIP_WITHOUT_PG }, async () => {
  await withFreshDb(async (pool) => {
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'transcript_recovery_rows' ORDER BY ordinal_position`,
    );
    assert.deepEqual(cols.rows.map((r) => r.column_name),
      ['transcript_key', 'dedup_key', 'round', 'record', 'append_seq'], '五列，顺序一致');
    assert.equal(cols.rows.find((r) => r.column_name === 'append_seq')?.data_type, 'bigint',
      'append_seq 是 bigint（bigserial）——排序真相，不是时间');

    const pk = await pool.query(
      `SELECT a.attname FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
         JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
        WHERE c.contype = 'p' AND t.relname = 'transcript_recovery_rows' ORDER BY k.ord`,
    );
    assert.deepEqual(pk.rows.map((r) => r.attname), ['transcript_key', 'dedup_key'], '幂等键 = (key, dedup_key)');

    // 直接撞一次 PG 的真唯一约束（fake 里那句 23505 是模拟，这里是事实）。
    await pool.query(
      `INSERT INTO transcript_recovery_rows (transcript_key, dedup_key, round, record)
       VALUES ($1,$2,3,'{}'::jsonb)`, ['k-pk', 'd-1'],
    );
    await assert.rejects(() => pool.query(
      `INSERT INTO transcript_recovery_rows (transcript_key, dedup_key, round, record)
       VALUES ($1,$2,3,'{}'::jsonb)`, ['k-pk', 'd-1'],
    ), /duplicate key value violates unique constraint/);
  });
});

test('#500 真库：幂等 false / 冲突抛 / 清空 true→false / 恢复行不进 load()（四条判据在真 DB 上复现）',
  { skip: URL_VALUE ? false : SKIP_WITHOUT_PG }, async () => {
    await withFreshDb(async (pool) => {
      const key = 'sess-real-500';

      // —— 轮记录一行（引擎轮记录的真实形状，走 store 的 appendRound）——
      await createSessionTranscriptStore(pool).appendRound(key, {
        round: 1, dedupKey: `${key}:engine:round:1`, messages: [], ts: '2026-11-16T00:00:00.000Z',
      });

      // —— ① 幂等 ——
      assert.equal(await store(pool).appendRecoveryRow(key, executedRow(key)), true);
      assert.equal(
        await store(pool).appendRecoveryRow(key, { ...executedRow(key), ts: '2026-11-16T00:09:59.999Z' }),
        false, '同 payload 重放 ⇒ false（真库的 ON CONFLICT + 指纹判据）',
      );
      assert.equal((await store(pool).listRecoveryRows(key)).length, 1, '幂等跳过不新增行');

      // —— ② 冲突 ——
      await assert.rejects(
        () => store(pool).appendRecoveryRow(key, { ...executedRow(key), messages: [{ role: 'user', content: 'x' }] }),
        (err) => err?.code === DEDUP_CONFLICT_CODE,
      );
      assert.equal((await store(pool).listRecoveryRows(key)).length, 1, '冲突不覆盖、不新增');

      // —— ④ 红线：不进 load() ——
      const loaded = await createSessionTranscriptStore(pool).load(key);
      assert.equal(loaded.length, 1, 'load() 只有轮记录那一行');
      assert.ok(!loaded.some((r) => r.kind === 'recovery'), '恢复行不许出现在 load() 里');

      // —— ③ 清空 true/false ——
      assert.equal(await store(pool).clearRecoveryRows(key), true);
      assert.equal(await store(pool).clearRecoveryRows(key), false);
      assert.equal((await store(pool).listRecoveryRows(key)).length, 0);

      // 清盘只打新表：轮账本那一行还在（append-only，零 DELETE）。
      const rounds = await pool.query(
        `SELECT count(*)::int AS n FROM transcript_rounds WHERE transcript_key = $1`, [key],
      );
      assert.equal(rounds.rows[0].n, 1, 'clearRecoveryRows 之后轮记录一行不少（DELETE 只打新表）');
    });
  });
