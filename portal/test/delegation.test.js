// 子 run（delegation）门户读侧判据（工单 `P2-WORKORDER.md` §5 的 10 条 + 白名单/成本红线）。
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool + `fs.mkdtemp` 临时用户空间，不碰真实 DB / 真实家目录。
//
// ⚠ 读侧三件事各有一条「撤掉就没牙」的判据，位置写在这里免得下一个人找不到：
//   · 路径只能由两个 id 拼 ⇒ `C8`（正则 + 零 fs 调用）；
//   · 归属三段校验（会话 / 父 run / 子 run 必须在名册里）⇒ `B1`/`B2`/`C3`；
//   · **先折叠 → 再投影 → 最后才切尾** ⇒ `C5`（同形）/`C6`（切尾在投影后）/`F1`（解链闸在本入口的复验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';import {
  delegationRoot, rosterDir, transcriptPath, listDelegates, getDelegateTranscript,
  DelegationError, DELEGATE_TRANSCRIPT_MAX_BYTES, ROSTER_STATES,
} from '../src/delegation.js';
import { foldLedgerRecords } from '../src/transcript-fold.js';
import { projectTranscriptForDisplay } from 'erix-agent';
import { SessionError } from '../src/sessions.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const USER_A = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const USER_B = {
  id: '00000000-0000-4000-8000-0000000000b2', login: 'bob', display_name: 'bob',
  role: 'fde', fde_name: 'bob', auth_source: 'local', status: 'active',
};
const SESSION_A = 'a1b2c3d4-2222-4222-8222-abcdefabcdef';
const SESSION_A_OTHER = 'a1b2c3d4-4444-4444-8444-abcdefabcdef'; // A 的**另一个**会话（判据 2）
const SESSION_B = 'a1b2c3d4-3333-4333-8333-abcdefabcdef';
const MISSING_SESSION = 'a1b2c3d4-9999-4999-8999-abcdefabcdef';
const PARENT_RUN = 'b0b0b0b0-1111-4111-8111-222222222222';
const PARENT_RUN_B = 'c0c0c0c0-1111-4111-8111-222222222222';
const CHILD_1 = 'sub-11111111-2222-4222-8222-333333333333';
const CHILD_2 = 'sub-aaaaaaaa-bbbb-4bbb-8bbb-cccccccccccc';
const CHILD_NOT_ROSTERED = 'sub-eeeeeeee-ffff-4fff-8fff-000000000000';

// ---------------------------------------------------------------------------
// 现场：临时用户空间 + 名册/账本落盘
// ---------------------------------------------------------------------------

/** 名册记录的最小真形：只写字段名与引擎 `roster.js#OPTIONAL_KEYS` 一致的那些。 */
function rosterRecord({ childRunId, state = 'completed', createdAt = 1_700_000_000_000, extra = {} }) {
  return {
    runId: childRunId,
    state,
    updatedAt: createdAt + 2_000,
    parentRunId: PARENT_RUN,
    cwd: '/home/erix/projects/probe',
    model: 'mock-chat',
    createdAt,
    endedAt: createdAt + 1_000,
    termination: 'end_turn',
    ...extra,
  };
}

/** 一条名册记录落盘（文件名 = 身份，引擎同口径）。 */
async function writeRoster(dir, childRunId, record) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${childRunId}.json`), JSON.stringify(record, null, 2));
}

/** 读侧 fs 的 spy 包装：四个动作全记账，判据 3/7/9/10 全靠它数「到底读没读」。 */
function spyFs() {
  const calls = [];
  return {
    calls,
    readdir: (p) => { calls.push(['readdir', p]); return fsp.readdir(p); },
    readFile: (p) => { calls.push(['readFile', p]); return fsp.readFile(p, 'utf8'); },
    stat: (p) => { calls.push(['stat', p]); return fsp.stat(p); },
    existsSync: (p) => { calls.push(['existsSync', p]); return fs.existsSync(p); },
  };
}

/** 真正读了账本内容的调用（`existsSync` 不算：它就是 hasTranscript 唯一允许的那个动作）。 */
const transcriptReads = (calls) => calls
  .filter(([op, p]) => p.endsWith('.jsonl') && (op === 'readFile' || op === 'stat'));
const transcriptStats = (calls) => calls.filter(([op, p]) => p.endsWith('.jsonl') && op === 'stat');

/**
 * 真引擎形状的账本（**手抄**自 `runToolLoop` + `createFileTranscriptStore` 的实测落盘，
 * 行形状对齐 `erix-agent/src/loop/orchestrator.js` 的 `appendMessageRowToTranscript` 与
 * `:5725` 的轮记录）：一轮 = 载体行 `<id>:engine:round:<n>` + 若干 `kind:"message"` 行。
 * 不用真引擎现跑：跑一次要 provider 桩 + 折叠策略，而本单要钉的是**读侧**，行形状对得上就够。
 */
function engineLedgerLines(runId, { round = 1 } = {}) {
  const k = (n) => `${runId}:msg:${round}:${n}`;
  return [
    {
      round: 0,
      roundKey: `${runId}:round:0`,
      dedupKey: `${runId}:engine:round:0:seed`,
      ts: '2026-11-08T10:00:00.000Z',
      messages: [{ role: 'user', content: [{ type: 'text', text: '数一下 README 有几行' }] }],
    },
    {
      round, kind: 'message', seq: 0, dedupKey: k(0), roundKey: `${runId}:round:${round}`,
      ts: '2026-11-08T10:00:01.000Z',
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: '先看文件' },
          { type: 'tool_use', id: 'c1', name: 'readFile', input: { path: 'README.md' } },
          { type: 'tool_use', id: 'c2', name: 'shell', input: { command: 'wc -l README.md' } },
        ],
      }],
    },
    // 一轮多工具：每个 tool_result 单独成行，第 2 个起用 `partOf` 接回首片（0.23 写侧口径）
    {
      round, kind: 'message', seq: 1, dedupKey: k(1), roundKey: `${runId}:round:${round}`,
      ts: '2026-11-08T10:00:02.000Z',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'README 内容' }] }],
    },
    {
      round, kind: 'message', seq: 2, dedupKey: k(2), roundKey: `${runId}:round:${round}`,
      partOf: k(1), ts: '2026-11-08T10:00:03.000Z',
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c2', content: '42 README.md' }] }],
    },
    // 轮记录：0.23 之后**不带正文**（正文在消息行里），只有元数据
    {
      round, roundKey: `${runId}:round:${round}`, dedupKey: `${runId}:engine:round:${round}`,
      ts: '2026-11-08T10:00:04.000Z',
      response: { content: [], stopReason: 'tool_use' },
      toolUses: 2,
    },
  ].map((row) => JSON.stringify(row));
}

async function makeHarness({ roster = [], transcripts = {}, parentRunId = PARENT_RUN, sessionId = SESSION_A } = {}) {
  const userSpaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'station-delegation-'));
  const root = path.join(userSpaceRoot, 'alice', 'home', 'delegation');
  await fsp.mkdir(path.join(root, 'roster', parentRunId), { recursive: true });
  await fsp.mkdir(path.join(root, 'transcripts'), { recursive: true });
  for (const [childRunId, record] of roster) {
    await writeRoster(path.join(root, 'roster', parentRunId), childRunId, record);
  }
  for (const [childRunId, lines] of Object.entries(transcripts)) {
    await fsp.writeFile(path.join(root, 'transcripts', `${childRunId}.jsonl`), `${lines.join('\n')}\n`);
  }
  const pool = new DelegationPool();
  const fsSpy = spyFs();
  const scope = { pool, userSpaceRoot, fsImpl: fsSpy, sessionId, parentRunId };
  return {
    ...scope,
    root,
    fsSpy,
    users: USER_A,
    cleanup: () => fs.rmSync(userSpaceRoot, { recursive: true, force: true }),
  };
}

/** 会话 / fde_name / 父 run 归属三条查询的 fake（其余语句交回 FakePool）。 */
class DelegationPool extends FakePool {
  constructor() {
    super({ users: [USER_A, USER_B] });
    this.chatSessions = [
      { id: SESSION_A, user_id: USER_A.id, status: 'active' },
      { id: SESSION_A_OTHER, user_id: USER_A.id, status: 'active' },
      { id: SESSION_B, user_id: USER_B.id, status: 'active' },
    ];
    this.runs = [
      { id: PARENT_RUN, session_id: SESSION_A },
      { id: PARENT_RUN_B, session_id: SESSION_B },
    ];
    this.sqlLog = [];
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('FROM chat_sessions s')) {
      const row = this.chatSessions.find((s) => s.id === params[0]);
      return { rows: row ? [{ ...row, project_id: null, cwd: '~/projects/p', title: '', title_source: 'auto', model: null, last_seq: 0 }] : [] };
    }
    if (sql.includes('fde_name FROM users')) {
      const u = this.users.find((x) => x.id === params[0] && x.status === 'active');
      return { rows: u ? [{ fde_name: u.fde_name }] : [] };
    }
    if (sql.includes('FROM runs WHERE id = $1 AND session_id = $2')) {
      const hit = this.runs.some((r) => r.id === params[0] && r.session_id === params[1]);
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }
    return super.query(sql, params);
  }
}

const callList = (h, over = {}) => listDelegates({
  userId: USER_A.id, ...h, ...over,
});
const callTranscript = (h, childRunId, over = {}) => getDelegateTranscript({
  userId: USER_A.id, childRunId, ...h, ...over,
});

/** 断言抛出的 DelegationError 的 code/httpStatus/details（顺带挡住「抛错类型不对」= 500 那条路）。 */
async function expectDelegationError(promise, { code, httpStatus, details }) {
  let err;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `期望抛 ${code}，实际没抛`);
  assert.ok(err instanceof DelegationError || err instanceof SessionError,
    `期望 DelegationError/SessionError（http.js 才认），实际 ${err.constructor.name}: ${err.message}`);
  assert.equal(err.code, code);
  assert.equal(err.httpStatus, httpStatus);
  if (details !== undefined) assert.deepEqual(err.details, details);
  return err;
}

// ---------------------------------------------------------------------------
// A 组：路径解析（安全红线，判据 8 的实现面）
// ---------------------------------------------------------------------------

test('A1 路径解析：两个 id 拼出的路径必须落在 <userSpaceRoot>/<fde>/home/delegation 之下', () => {
  const root = delegationRoot({ userSpaceRoot: '/srv/erix/users', fdeName: 'alice' });
  assert.equal(root, '/srv/erix/users/alice/home/delegation');
  assert.equal(rosterDir({ userSpaceRoot: '/srv/erix/users', fdeName: 'alice', parentRunId: PARENT_RUN }),
    `${root}/roster/${PARENT_RUN}`);
  assert.equal(transcriptPath({ userSpaceRoot: '/srv/erix/users', fdeName: 'alice', childRunId: CHILD_1 }),
    `${root}/transcripts/${CHILD_1}.jsonl`);
});

test('A2 路径解析：id 形状非法（含 `..`、绝对路径、缺 sub- 前缀、大写）一律 400 validation_failed 且带 field', () => {
  const bad = [
    '../../etc', '/etc/passwd', `${PARENT_RUN}/../../..`, 'sub-x', PARENT_RUN.toUpperCase(),
  ];
  for (const value of bad) {
    assert.throws(
      () => rosterDir({ userSpaceRoot: '/srv/erix/users', fdeName: 'alice', parentRunId: value }),
      (err) => err instanceof DelegationError && err.code === 'validation_failed'
        && err.httpStatus === 400 && err.details.field === 'runId',
      `parentRunId=${value} 必须被拒`,
    );
  }
  for (const value of ['../../etc', CHILD_1.slice(4), 'sub-%2e%2e/x', CHILD_1.toUpperCase()]) {
    assert.throws(
      () => transcriptPath({ userSpaceRoot: '/srv/erix/users', fdeName: 'alice', childRunId: value }),
      (err) => err instanceof DelegationError && err.details.field === 'childRunId',
      `childRunId=${value} 必须被拒`,
    );
  }
});

test('A3 路径解析：userSpaceRoot 缺失 ⇒ 500 internal；fde_name 缺失/非法 ⇒ 与 sessions.js 同一句 400', () => {
  assert.throws(() => delegationRoot({ userSpaceRoot: '', fdeName: 'alice' }),
    (e) => e.code === 'internal' && e.httpStatus === 500);
  for (const fdeName of [undefined, '', 'A/../b', 'a/b']) {
    assert.throws(() => delegationRoot({ userSpaceRoot: '/srv/erix/users', fdeName }),
      (e) => e.code === 'validation_failed' && e.details.field === 'fde_name'
        && e.message === '当前用户未配置 fde_name，无法确定家目录',
      `fdeName=${fdeName}`);
  }
});

// ---------------------------------------------------------------------------
// B 组：名册列表
// ---------------------------------------------------------------------------

test('B1 判据1 跨用户不可见：B 拿 A 的 sessionId ⇒ 404，且响应体与「session 不存在」逐字相同', async () => {
  const h = await makeHarness({ roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]] });
  try {
    const crossUser = await expectDelegationError(
      listDelegates({ ...h, userId: USER_B.id }),
      { code: 'not_found', httpStatus: 404 },
    );
    const missing = await expectDelegationError(
      listDelegates({ ...h, userId: USER_A.id, sessionId: MISSING_SESSION }),
      { code: 'not_found', httpStatus: 404 },
    );
    // 「不泄露存在性」的可执行形式：两条路的 message 一模一样（错误信封由 http.js 由 code/message 生成）
    assert.equal(crossUser.message, missing.message);
    assert.equal(crossUser.message, 'session not found');
    // 越权的人**不该**从错误码里读出「这个 session 存在」⇒ 归属 404 必须早于任何读盘
    assert.deepEqual(h.fsSpy.calls, []);
  } finally { h.cleanup(); }
});

test('B2 判据2 跨会话不可见：同用户的另一个 sessionId + 本会话的 parentRunId ⇒ 404', async () => {
  const h = await makeHarness({ roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]] });
  try {
    await expectDelegationError(
      listDelegates({ ...h, sessionId: SESSION_A_OTHER }),
      { code: 'not_found', httpStatus: 404 },
    );
    assert.deepEqual(h.fsSpy.calls, [], '父 run 不属于该会话 ⇒ 一个文件都不许读');
  } finally { h.cleanup(); }
});

test('B4 判据4 坏名册文件不 500：坏 JSON / 身份不符 / 非对象 ⇒ 跳过并计数，其余项照常', async () => {
  const dir = path.join('roster', PARENT_RUN);
  const h = await makeHarness({ roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1, createdAt: 1 })]] });
  try {
    const rosterAbs = path.join(h.root, dir);
    await fsp.writeFile(path.join(rosterAbs, `${CHILD_2}.json`), '{"oops"');
    await fsp.writeFile(path.join(rosterAbs, `${CHILD_NOT_ROSTERED}.json`),
      JSON.stringify({ runId: 'sub-ffffffff-ffff-4fff-8fff-ffffffffffff', state: 'completed', updatedAt: 5 }));
    await fsp.writeFile(path.join(rosterAbs, 'not-a-child.json'),
      // 内容自身**完全合法**（runId 与文件名相符）：把它挡在外的唯一东西是「文件名就不是 sub-<uuid>」
      // ⇒ 撤掉那一道形状判据就多得一条假子 run（而不是靠后面的身份比对兼平）。
      JSON.stringify({ runId: 'not-a-child', state: 'completed', updatedAt: 9 }));
    await fsp.writeFile(path.join(rosterAbs, `${CHILD_1}.json.tmp-1-0`), '{"half');
    const res = await callList(h);
    assert.equal(res.items.length, 1, `只剩真件：${JSON.stringify(res.items)}`);
    assert.deepEqual(res.items.map((i) => i.childRunId), [CHILD_1]);
    assert.equal(res.skipped, 3, `坏件要逐件点名（坏 JSON / 身份不符 / 名字不是子 run 形状），实际 skipped=${res.skipped}`);
  } finally { h.cleanup(); }
});

test('B9 判据9 名册目录不存在 ⇒ { items: [], skipped: 0 }，200 语义且零 transcript 读', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) },
  });
  try {
    // 真把名册目录拿掉（不是「目录在但空」——那条路另有 B12 管）：从未派生子 run / 没开过
    // ERIX_DELEGATE_ENABLED 的会话就是这一格，而 P1 只在开关开时才建 roster/<runId>/。
    await fsp.rm(path.join(h.root, 'roster', PARENT_RUN), { recursive: true, force: true });
    const res = await callList(h);
    assert.deepEqual(res, { items: [], skipped: 0 });
    assert.deepEqual(transcriptReads(h.fsSpy.calls), [], '一条 transcript 都不许碰');
    assert.equal(h.fsSpy.calls.filter(([op]) => op === 'readdir').length, 1, '只 readdir 那一次');
    assert.deepEqual(h.fsSpy.calls.filter(([op]) => op === 'existsSync'), [], '没子 run ⇒ 连 existsSync 都不该发');

    // 账本入口同样不吃 500：名册目录整个不在 ⇒ 404 not_in_roster
    await expectDelegationError(callTranscript(h, CHILD_1),
      { code: 'not_found', httpStatus: 404, details: { reason: 'not_in_roster' } });
  } finally { h.cleanup(); }
});

test('B10 判据10 hasTranscript 只用 existsSync：账本有与没有都不产生 .jsonl 内容读', async () => {
  const h = await makeHarness({
    roster: [
      [CHILD_1, rosterRecord({ childRunId: CHILD_1, createdAt: 1 })],
      [CHILD_2, rosterRecord({ childRunId: CHILD_2, createdAt: 2 })],
    ],
    transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) }, // 只有 CHILD_1 有账本
  });
  try {
    const res = await callList(h);
    assert.deepEqual(res.items.map((i) => [i.childRunId, i.hasTranscript]),
      [[CHILD_1, true], [CHILD_2, false]]);
    const stats = h.fsSpy.calls.filter(([op]) => op === 'existsSync');
    assert.equal(stats.length, 2, '每个子 run 恰好一次 existsSync');
    assert.deepEqual(transcriptStats(h.fsSpy.calls), [], 'existsSync 就够，不必 stat');
  } finally { h.cleanup(); }
});

test('B11 DTO 白名单：roster record 不被原样下发；字段类型与 createdAt 升序照契约', async () => {
  const h = await makeHarness({
    roster: [
      [CHILD_2, rosterRecord({
        childRunId: CHILD_2,
        createdAt: 2_000,
        state: 'running',
        extra: {
          resultText: 'x'.repeat(4000), // 一整段子 run 终稿：下发它就是契约扩张
          pid: 1213,
          statusPath: '/home/erix/delegation/transcripts/out/status.json',
          transcriptPath: '/home/erix/delegation/transcripts/out/x.jsonl',
          verification: { status: 'verified' },
          taskDigest: 'sha256:deadbeef',
          budgetSource: 'env',
          errorMessage: 'boom',
          resultTruncated: true,
          termination: 'timeout',
        },
      })],
      [CHILD_1, rosterRecord({ childRunId: CHILD_1, createdAt: 1_000, state: 'queued', extra: { termination: 'no_tool' } })],
    ],
  });
  try {
    const res = await callList(h);
    assert.deepEqual(res.items.map((i) => i.childRunId), [CHILD_1, CHILD_2], 'createdAt 升序');
    // 缺位的位不得臬造：CHILD_1 的名册件**没写** resultTruncated / errorMessage
    assert.equal(res.items[0].resultTruncated, false, '缺位必须归一成 false（不是 true、不是 undefined）');
    assert.equal(res.items[0].errorMessage, null);
    assert.equal(res.items[0].termination, 'no_tool', '归一前的引擎 reason 照字符串下发（P1 已在写侧归一）');
    assert.deepEqual(Object.keys(res.items[0]).sort(), [
      'childRunId', 'createdAt', 'cwd', 'endedAt', 'errorMessage', 'hasTranscript', 'model',
      'resultTruncated', 'state', 'termination', 'updatedAt',
    ].sort());
    const running = res.items[1];
    assert.equal(running.state, 'running');
    assert.equal(running.termination, 'timeout');
    assert.equal(running.errorMessage, 'boom');
    assert.equal(running.resultTruncated, true);
    assert.equal(running.hasTranscript, false);
    assert.equal(running.cwd, '/home/erix/projects/probe');
    assert.equal(running.model, 'mock-chat');
    assert.deepEqual([running.createdAt, running.endedAt, running.updatedAt], [2_000, 3_000, 4_000]);
    const json = JSON.stringify(res);
    for (const leak of ['resultText', 'taskDigest', 'statusPath', 'verification', 'budgetSource', '"pid"']) {
      assert.ok(!json.includes(leak), `${leak} 不该出现在响应里`);
    }
    // 在 7 值之外的字符串 state **照原样下发**（词汇表封闭性是写侧不变量，读侧不拿它当过滤器）
    assert.equal(res.items[0].state, 'queued');
    assert.ok(ROSTER_STATES.includes('queued'));
  } finally { h.cleanup(); }
});

test('B12 state 非字符串 / 非对象 record ⇒ 损坏件，进 skipped 而不是下发一个空 state', async () => {
  const h = await makeHarness();
  try {
    const rosterAbs = path.join(h.root, 'roster', PARENT_RUN);
    await fsp.writeFile(path.join(rosterAbs, `${CHILD_1}.json`), JSON.stringify({ runId: CHILD_1, updatedAt: 1 }));
    await fsp.writeFile(path.join(rosterAbs, `${CHILD_2}.json`), JSON.stringify([1, 2]));
    const res = await callList(h);
    assert.deepEqual(res, { items: [], skipped: 2 });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// C 组：账本投影
// ---------------------------------------------------------------------------

test('C3 判据3 childRunId 必须出现在名册里：形状合法但名册没有 ⇒ 404，且没读 transcript 文件', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: {
      [CHILD_1]: engineLedgerLines(CHILD_1),
      [CHILD_NOT_ROSTERED]: engineLedgerLines(CHILD_NOT_ROSTERED), // 账本在，名册里没有
    },
  });
  try {
    await expectDelegationError(
      callTranscript(h, CHILD_NOT_ROSTERED),
      { code: 'not_found', httpStatus: 404, details: { reason: 'not_in_roster' } },
    );
    const touched = transcriptReads(h.fsSpy.calls);
    assert.deepEqual(touched, [], `名册没这个子 run 就不该碰任何账本：${JSON.stringify(touched)}`);
  } finally { h.cleanup(); }
});

test('C5 判据5 投影与主对话同形：1 条 user + 1 条 assistant，toolCalls 带结果，run_id = childRunId', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) },
  });
  try {
    const res = await callTranscript(h, CHILD_1);
    assert.equal(res.childRunId, CHILD_1);
    assert.equal(res.state, 'completed');
    assert.equal(res.totalTurns, 2, `一轮 = 1 user + 1 assistant，实际 ${res.totalTurns}`);
    assert.equal(res.truncated, false);
    assert.deepEqual(res.messages.map((m) => m.role), ['user', 'assistant']);
    const [userTurn, assistantTurn] = res.messages;
    assert.equal(userTurn.text, '数一下 README 有几行');
    assert.equal(assistantTurn.text, '先看文件');
    // 工具结果必须配得上对（#337 的病根：折叠没做 ⇒ 卡片从 ✓ 退化成 …）
    assert.equal(assistantTurn.toolCalls.length, 2);
    assert.deepEqual(assistantTurn.toolCalls.map((c) => [c.name, c.resultPreview]), [
      ['readFile', 'README 内容'],
      ['shell', '42 README.md'],
    ]);
    assert.ok(assistantTurn.toolCalls.every((c) => c.isError !== true), '成功的调用不得带 isError');
    // 宿主字段 + 不覆盖上游字段
    assert.deepEqual([userTurn.id, userTurn.seq, userTurn.run_id], [`${CHILD_1}:0`, 0, CHILD_1]);
    assert.equal(assistantTurn.id, `${CHILD_1}:1`);
    // ⚠ `created_at` = **轮行落盘时刻**（投影的 `turn.ts` 取自载体行），不是消息成型时刻：
    //    折叠把正文折回轮行时只往消息上盖行级 `ts`（#439 A），而投影的 `ts` 一直读轮记录本身。
    //    子 run 抽屉上不拿它当「这条消息什么时候出现」的精确尺，只当轮级时间戳。
    assert.equal(assistantTurn.created_at, '2026-11-08T10:00:04.000Z');
    assert.equal(assistantTurn.round, 1, '上游字段（round）在位 ⇒ 宿主字段没把投影改写掉');
    assert.ok('ts' in assistantTurn && 'key' in assistantTurn && 'meta' in assistantTurn);
  } finally { h.cleanup(); }
});

test('C6 判据6 切尾在投影之后：tail=1 拿到最后一条**完整**逻辑消息，不是半条', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: {
      [CHILD_1]: [
        ...engineLedgerLines(CHILD_1),
        // 第二个 round 的正文行 + 轮行（切在它们中间就会拿到缺正文的一轮）
        JSON.stringify({
          round: 2, kind: 'message', seq: 0, dedupKey: `${CHILD_1}:msg:2:0`, roundKey: `${CHILD_1}:round:2`,
          ts: '2026-11-08T10:00:05.000Z',
          messages: [{ role: 'assistant', content: [{ type: 'text', text: '42 行' }] }],
        }),
        JSON.stringify({
          round: 2, roundKey: `${CHILD_1}:round:2`, dedupKey: `${CHILD_1}:engine:round:2`,
          ts: '2026-11-08T10:00:06.000Z', response: { content: [], stopReason: 'end_turn' },
        }),
      ],
    },
  });
  try {
    const res = await callTranscript(h, CHILD_1, { tail: 1 });
    assert.equal(res.totalTurns, 3);
    assert.equal(res.truncated, true);
    assert.equal(res.messages.length, 1);
    const last = res.messages[0];
    assert.equal(last.role, 'assistant');
    assert.equal(last.text, '42 行');
    assert.equal(last.seq, 2, 'seq 用全量下标 ⇒ 向前翻页时同一条消息的 id 不漂移');
    assert.equal(last.id, `${CHILD_1}:2`);
    // 中间窗口也完整：tail=1 取最后一条，tail=2 取最后两条，都不许出现半截正文
    const two = await callTranscript(h, CHILD_1, { tail: 2 });
    assert.deepEqual(two.messages.map((m) => [m.seq, m.role, m.text]),
      [[1, 'assistant', '先看文件'], [2, 'assistant', '42 行']]);
    const toolTurn = two.messages[0];
    assert.equal(toolTurn.toolCalls.length, 2, '切尾之后这一条的工具面仍然完整');
  } finally { h.cleanup(); }
});

test('C7 判据7 超大账本 ⇒ 413 payload_too_large（带 details.size），且先 stat 再读 ⇒ 没读内容', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: [] },
  });
  try {
    const file = path.join(h.root, 'transcripts', `${CHILD_1}.jsonl`);
    // 9 MiB：用稀疏文件撑大小（写 9 MiB 真字节要几十毫秒，但 stat 只看 st_size，语义等价）
    await fsp.truncate(file, DELEGATE_TRANSCRIPT_MAX_BYTES + 1024 * 1024);
    const err = await expectDelegationError(
      callTranscript(h, CHILD_1),
      { code: 'payload_too_large', httpStatus: 413 },
    );
    assert.equal(err.details.size, DELEGATE_TRANSCRIPT_MAX_BYTES + 1024 * 1024);
    assert.equal(err.details.max_bytes, DELEGATE_TRANSCRIPT_MAX_BYTES);
    const reads = h.fsSpy.calls.filter(([op, p]) => p.endsWith('.jsonl') && op === 'readFile');
    assert.deepEqual(reads, [], '超限的文件一个字节都不许读进内存（上限判定只能靠 stat）');
    assert.equal(transcriptStats(h.fsSpy.calls).length, 1, '判大小靠一次 stat');
  } finally { h.cleanup(); }
});

test('C8 判据8 路径穿越：runId=../../etc ⇒ 400 validation_failed，零 fs 调用（早于归属查询之后读盘）', async () => {
  const h = await makeHarness({ roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]] });
  try {
    await expectDelegationError(
      callList(h, { parentRunId: '../../etc' }),
      { code: 'validation_failed', httpStatus: 400, details: { field: 'runId' } },
    );
    await expectDelegationError(
      callTranscript(h, CHILD_1, { parentRunId: '../../../../etc/passwd' }),
      { code: 'validation_failed', httpStatus: 400, details: { field: 'runId' } },
    );
    await expectDelegationError(
      callTranscript(h, '../../etc/passwd'),
      { code: 'validation_failed', httpStatus: 400, details: { field: 'childRunId' } },
    );
    assert.deepEqual(h.fsSpy.calls, [], '形状非法 ⇒ 一个文件都不许读');
  } finally { h.cleanup(); }
});

test('C13 tail 边界：0 / 501 / 非整数 ⇒ 400 validation_failed（details.field=tail）', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) },
  });
  try {
    for (const tail of [0, 501, 2.5, 'x', null]) {
      await expectDelegationError(callTranscript(h, CHILD_1, { tail }),
        { code: 'validation_failed', httpStatus: 400, details: { field: 'tail' } });
    }
    const ok = await callTranscript(h, CHILD_1, { tail: 500 });
    assert.equal(ok.truncated, false);
  } finally { h.cleanup(); }
});

test('C14 账本不存在 ⇒ 404 details.reason=no_transcript（与「名册里没这个子」区分开，前端要靠它给空态）', async () => {
  const h = await makeHarness({ roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]] });
  try {
    await expectDelegationError(callTranscript(h, CHILD_1),
      { code: 'not_found', httpStatus: 404, details: { reason: 'no_transcript' } });
  } finally { h.cleanup(); }
});

test('C15 坏行/空行跳过：账本被崩溃截断在最后一行 ⇒ 200 而不是 500', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: [...engineLedgerLines(CHILD_1), '', '{"round":2,"kind":"mes'] },
  });
  try {
    const res = await callTranscript(h, CHILD_1);
    assert.equal(res.totalTurns, 2);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// F 组：折叠口径在本入口的复验（AGENTS §8.52 那条既有保证）
// ---------------------------------------------------------------------------

test('F1 判据5b 0.23 链式 partOf（msg:1:3 → msg:1:2 → msg:1:1）必须折回 1 条聚合 tool_result', async () => {
  const h = await makeHarness({
    roster: [[CHILD_1, rosterRecord({ childRunId: CHILD_1 })]],
    transcripts: { [CHILD_1]: [] },
  });
  try {
    const k = (n) => `${CHILD_1}:msg:1:${n}`;
    const rows = [
      { round: 1, kind: 'message', seq: 0, dedupKey: k(0), messages: [{ role: 'assistant', content: [
        { type: 'tool_use', id: 't1', name: 'shell', input: {} },
        { type: 'tool_use', id: 't2', name: 'shell', input: {} },
        { type: 'tool_use', id: 't3', name: 'shell', input: {} },
      ] }] },
      { round: 1, kind: 'message', seq: 1, dedupKey: k(1), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] }] },
      { round: 1, kind: 'message', seq: 2, dedupKey: k(2), partOf: k(1), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] }] },
      // ⚠ 0.23 写侧把 partOf 写成**链**（第 3 片指第 2 片，而不是聚合消息首片）
      { round: 1, kind: 'message', seq: 3, dedupKey: k(3), partOf: k(2), messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'r3' }] }] },
      { round: 1, dedupKey: `${CHILD_1}:engine:round:1`, response: { content: [], stopReason: 'tool_use' } },
    ];
    const file = path.join(h.root, 'transcripts', `${CHILD_1}.jsonl`);
    await fsp.writeFile(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);

    const folded = foldLedgerRecords(rows.map((r) => ({ ...r })));
    const carrier = folded.find((r) => r.dedupKey === `${CHILD_1}:engine:round:1`);
    const users = carrier.messages.filter((m) => m.role === 'user');
    assert.equal(users.length, 1, `3 个分片必须折回**一条**聚合 user 消息，实际 ${users.length} 条：`
      + JSON.stringify(users.map((m) => m.content.map((b) => b.type))))
      ;
    assert.deepEqual(users[0].content.map((b) => [b.type, b.tool_use_id]),
      [['tool_result', 't1'], ['tool_result', 't2'], ['tool_result', 't3']]);
    // 端点侧同样不给额外的 turn（撤闸后第 3 片会自成一条记录，resume 侧则是 invalid_messages）
    const res = await callTranscript(h, CHILD_1);
    assert.equal(res.totalTurns, 1, '链上的分片不得变成独立 turn');
    assert.deepEqual(res.messages[0].toolCalls.map((c) => [c.name, c.resultPreview]), [
      ['shell', 'r1'], ['shell', 'r2'], ['shell', 'r3'],
    ]);
  } finally { h.cleanup(); }
});

test('F2 投影输入必须是折叠后的记录：把顺序写反（先切原始行再投影）会丢正文', async () => {
  // 这条**不测实现**，它测的是「顺序为什么不能反」这件事仍然为真：
  // 同一批行，全量投影给 2 条 turn，只取尾 2 行投影给 0 条（载体行与正文行被切在两侧）。
  const lines = engineLedgerLines(CHILD_1).map((l) => JSON.parse(l));
  assert.equal(projectTranscriptForDisplay(foldLedgerRecords(lines)).length, 2);
  assert.equal(projectTranscriptForDisplay(foldLedgerRecords(lines.slice(-2))).length, 0);
});

// ---------------------------------------------------------------------------
// H 组：HTTP 接线（鉴权 / 必填参数 / 401 / 状态码）
// ---------------------------------------------------------------------------

async function startHttp() {
  const userSpaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'station-delegation-http-'));
  const staticDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'station-delegation-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const pool = new DelegationPool();
  pool.sessions.push({
    id: 's1', user_id: USER_A.id, token_hash: auth.hashToken('tok-delegation'),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000),
    last_seen_at: new Date(), revoked_at: null,
  });
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 900_000, blockMs: 60_000, maxEntries: 1000 },
    totpRateLimit: { maxFailures: 5, windowMs: 900_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 1000 },
    kdfConcurrency: 2, kdfQueueLimit: 100, kdfQueueTimeoutMs: 30_000,
    maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256,
    staticDir, userSpaceRoot,
  };
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    pool,
    userSpaceRoot,
    cookie: `${config.cookie.name}=tok-delegation`,
    get: (p, cookieHeader) => fetch(`${base}${p}`, { headers: cookieHeader ? { cookie: cookieHeader } : {} }),
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
      fs.rmSync(userSpaceRoot, { recursive: true, force: true });
    },
  };
}

/** 在 <userSpaceRoot>/<fde>/home/delegation 下写一份名册 + 账本（HTTP 用例走真盘）。 */
async function seedFiles(userSpaceRoot, fde, { parentRunId = PARENT_RUN, roster = {}, transcripts = {} } = {}) {
  const root = path.join(userSpaceRoot, fde, 'home', 'delegation');
  await fsp.mkdir(path.join(root, 'roster', parentRunId), { recursive: true });
  await fsp.mkdir(path.join(root, 'transcripts'), { recursive: true });
  for (const [childRunId, record] of Object.entries(roster)) {
    await writeRoster(path.join(root, 'roster', parentRunId), childRunId, record);
  }
  for (const [childRunId, lines] of Object.entries(transcripts)) {
    await fsp.writeFile(path.join(root, 'transcripts', `${childRunId}.jsonl`), `${lines.join('\n')}\n`);
  }
}

test('H1 HTTP：两个端点 200 的形状 + 未登录 401 + runId 缺失/非法 400 + 越权 404 与「不存在」逐字相同', async () => {
  const h = await startHttp();
  try {
    await seedFiles(h.userSpaceRoot, 'alice', {
      roster: {
        [CHILD_1]: rosterRecord({ childRunId: CHILD_1 }),
        // CHILD_2：名册里有、账本还没落盘 ⇒ 专用于 `no_transcript` 那一格（state=running 顺带给形状）
        [CHILD_2]: rosterRecord({ childRunId: CHILD_2, state: 'running' }),
      },
      transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) },
    });
    const list = await h.get(`/api/sessions/${SESSION_A}/delegates?runId=${PARENT_RUN}`, h.cookie);
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.deepEqual(Object.keys(listBody).sort(), ['items', 'skipped']);
    assert.equal(listBody.items[0].childRunId, CHILD_1);
    assert.equal(listBody.items[0].hasTranscript, true);

    const one = await h.get(`/api/sessions/${SESSION_A}/delegates/${CHILD_1}?runId=${PARENT_RUN}&tail=1`, h.cookie);
    assert.equal(one.status, 200);
    const oneBody = await one.json();
    assert.deepEqual(Object.keys(oneBody).sort(),
      ['childRunId', 'messages', 'state', 'totalTurns', 'truncated'].sort());
    assert.equal(oneBody.messages.length, 1);
    assert.equal(oneBody.messages[0].run_id, CHILD_1);

    assert.equal((await h.get(`/api/sessions/${SESSION_A}/delegates?runId=${PARENT_RUN}`)).status, 401);

    const noRun = await h.get(`/api/sessions/${SESSION_A}/delegates`, h.cookie);
    assert.equal(noRun.status, 400);
    assert.deepEqual((await noRun.json()).error.details, { field: 'runId' });

    const traverse = await h.get(`/api/sessions/${SESSION_A}/delegates?runId=../../etc`, h.cookie);
    assert.equal(traverse.status, 400);
    const traverseBody = await traverse.json();
    assert.equal(traverseBody.error.code, 'validation_failed');
    assert.deepEqual(traverseBody.error.details, { field: 'runId' });

    const badTail = await h.get(`/api/sessions/${SESSION_A}/delegates/${CHILD_1}?runId=${PARENT_RUN}&tail=0`, h.cookie);
    assert.equal(badTail.status, 400);
    assert.deepEqual((await badTail.json()).error.details, { field: 'tail' });

    // 越权（B 的 cookie 看不到，直接换 sessionId 归属）与「不存在」同一个体
    const cross = await h.get(`/api/sessions/${SESSION_B}/delegates?runId=${PARENT_RUN}`, h.cookie);
    const missing = await h.get(`/api/sessions/${MISSING_SESSION}/delegates?runId=${PARENT_RUN}`, h.cookie);
    assert.equal(cross.status, 404);
    const crossBody = await cross.json();
    const missingBody = await missing.json();
    assert.deepEqual(crossBody, missingBody, '越权与不存在的响应体必须逐字相同（不泄露存在性）');
    assert.equal(crossBody.error.code, 'not_found');

    const notInRoster = await h.get(
      `/api/sessions/${SESSION_A}/delegates/${CHILD_NOT_ROSTERED}?runId=${PARENT_RUN}`, h.cookie);
    assert.equal(notInRoster.status, 404);
    assert.deepEqual((await notInRoster.json()).error.details, { reason: 'not_in_roster' });

    const noTranscript = await h.get(
      `/api/sessions/${SESSION_A}/delegates/${CHILD_2}?runId=${PARENT_RUN}`, h.cookie);
    assert.equal(noTranscript.status, 404);
    assert.deepEqual((await noTranscript.json()).error.details, { reason: 'no_transcript' });
  } finally { await h.close(); }
});

test('H2 大写 id 归一化：路径参数与 query 参数经 decodeUuid 落小写 ⇒ 名册目录名（引擎写的小写）能命中', async () => {
  const h = await startHttp();
  try {
    await seedFiles(h.userSpaceRoot, 'alice', {
      roster: { [CHILD_1]: rosterRecord({ childRunId: CHILD_1 }) },
      transcripts: { [CHILD_1]: engineLedgerLines(CHILD_1) },
    });
    const res = await h.get(
      `/api/sessions/${SESSION_A}/delegates/${CHILD_1.toUpperCase()}?runId=${PARENT_RUN.toUpperCase()}`, h.cookie);
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
  } finally { await h.close(); }
});
