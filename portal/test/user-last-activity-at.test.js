// 单测：issue #497（工单 feat-261112-01，方案 A3）—— `users.last_activity_at` = 最近一次**用户输入**。
//
// 这一列存在的全部理由：`last_login_at`（从 `login_sessions` 聚合）说的是「最近一次把门推开」，
// 而页面刷新、自动续期、登录本身都会写它 ⇒ 「这个人还在不在用」此前**根本没有数据**。
// 本单补的是一维新事实，不是把旧事实算准。
//
// 判据面（口径来源：`docs/data/model.md` §1.1、迁移 0031 的头注释）：
//   W-0  两个写入点的 SQL 字面 + 共用仿真件的反向自证（仿真件不许吞别的语句）
//   W-5  全仓写入点**恰好两处**（工单红线：不许加第三个）
//   W-1  正例·发送路：postMessage 恰写一次，值真的变新
//   W-1b 事务形状：只有事务内那个 `client` 能写；`pool.query` 自开连接就红
//   W-1c 回滚：业务失败 ⇒ 活动位**不前进**（「消息回滚了但活动位前进了」是红线）
//   W-2  正例·入队路：运行中按回车那一刻就变新（同事务）
//   W-2b 直发路：一条用户输入**恰好写一次**（两处写入点不许双写）
//   W-3  反例·run 完成（worker 报 finished/end_turn）⇒ 不许动
//   W-3b 反例·会话改名 ⇒ 不许动      W-3c 反例·归档 ⇒ 不许动      W-3d 反例·登录本身 ⇒ 不许动
//   W-4  admin DTO 五个生产点都带这一列且**值与库一致**（不是「键存在」：挡不住 NULL::timestamptz 回来）
//   W-4b 假池自己有牙：复现 PG「重复列名后者覆盖前者」，否则 W-4 是假绿
//   W-6  迁移回填只动 `last_activity_at IS NULL` 的行（重放第二遍 = 零行）
//
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB / docker / 网络。
// fake 红线（AGENTS §8.14）：**按 SQL 说的做** —— 未覆盖的语句一律抛错，不心软放行。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { postMessage, updateSession, archiveSession } from '../src/sessions.js';
import { enqueueQueuedInput } from '../src/queued-inputs.js';
import { claimRun, setRunState } from '../src/internal.js';
import * as admin from '../src/admin.js';
import * as auth from '../src/auth.js';
import { FakePool } from './fake-pool.js';
import { FakeInternalPool, seedClaimable } from './fake-internal-pool.js';
import { fakeTranscriptRounds } from './fake-transcript-rounds.js';
import { createUserActivityWorld, USER_ACTIVITY_UPDATE } from './fake-user-activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '../src');

const USER_ID = '00000000-0000-4000-8000-0000000000a1';
const SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';
/** 库里已有一个「上一次说话」的时刻：所有「变新」判据拿它当基准，所有「不许动」判据拿它当锚。 */
const PREV_ACTIVITY = new Date('2026-11-11T23:00:00.000Z');

const activitySqlOf = (sql) => sql.replace(/\s+/g, ' ').trim();

/**
 * 剥**整行注释**（JS 与 SQL 各一种）。源码级判据必须先把注释剥掉，否则它会去匹配
 * 「被注释掉的那一行」——变异实验实测：把写入点整行注释掉，不剥注释的源码判据**照样绿**。
 */
const stripLineComments = (text) => text.replace(/^\s*\/\/[^\n]*$/gm, '');
const stripSqlComments = (text) => text.replace(/^\s*--[^\n]*$/gm, '');

// ---------------------------------------------------------------------------
// 会话 / 队列侧的内存世界（postMessage + enqueueQueuedInput + 改名 / 归档 都要过的 SQL）
// ---------------------------------------------------------------------------

class ActivityPool {
  /**
   * @param activeRun  活跃 run（null = 无活跃 run ⇒ 入队端点退化成直发）
   * @param failOn     SQL 片段：命中即抛（模拟「业务写入失败 ⇒ 整笔事务回滚」）
   */
  constructor({ activeRun = null, failOn = null } = {}) {
    this.users = [{ id: USER_ID, login: 'alice', last_activity_at: PREV_ACTIVITY }];
    this.activity = createUserActivityWorld({ users: this.users });
    this.session = {
      id: SESSION_ID, user_id: USER_ID, project_id: 'p1', cwd: '~/projects/p',
      title: '既有标题', title_source: 'manual', model: null, status: 'active', last_seq: 5,
    };
    this.activeRun = activeRun;
    this.queued = [];
    this.messages = [];
    this.transcript = [];
    this.rounds = fakeTranscriptRounds({ rows: this.transcript });
    /** 按执行顺序记录 `{ sql, params, via }`；`via` = 'pool' | 'client'（W-1b 的支点）。 */
    this.journal = [];
    this.connects = 0;
    this.commits = 0;
    this.rollbacks = 0;
    this.failOn = failOn;
    // 事务内的活动位快照：ROLLBACK 必须**真的还原**（否则 W-1c 只能证明「SQL 在事务里」，
    // 证不了「回滚之后库里没有前进」——而那才是这条红线要说的那句话）。
    this.snap = null;
  }

  userRow() { return this.users.find((u) => u.id === USER_ID); }

  /** 流水里活动位写入的下标（-1 = 没写过）。 */
  activityIndex(via = null) {
    return this.journal.findIndex((e) => USER_ACTIVITY_UPDATE.test(e.sql) && (via == null || e.via === via));
  }

  async connect() {
    this.connects += 1;
    const pool = this;
    return { query: (sql, params) => pool.query(sql, params, 'client'), release() {} };
  }

  async query(sql, params = [], via = 'pool') {
    const s = activitySqlOf(sql);
    this.journal.push({ sql: s, params: [...params], via });
    if (this.failOn && s.includes(this.failOn)) throw new Error(`fake: 业务写入失败（${this.failOn}）`);

    if (/^BEGIN\b/i.test(s)) {
      this.snap = { values: new Map(this.users.map((u) => [u.id, u.last_activity_at])), writes: this.activity.writes.length };
      return { rows: [] };
    }
    if (/^COMMIT\b/i.test(s)) { this.commits += 1; return { rows: [] }; }
    if (/^ROLLBACK\b/i.test(s)) {
      this.rollbacks += 1;
      if (this.snap) {
        for (const u of this.users) if (this.snap.values.has(u.id)) u.last_activity_at = this.snap.values.get(u.id);
        this.activity.writes.length = this.snap.writes; // 真 PG：回滚的事务一个字节都不留
      }
      return { rows: [] };
    }

    // --- 活动位（共用仿真件；命中就返回，不命中继续自己的链）---
    const hit = this.activity.query(s, params);
    if (hit) return hit;

    // --- fetchSession ---
    if (s.includes('FROM chat_sessions s') && s.includes('id = $1')) {
      // fetchSession 只传 [sessionId]（属主是取回行后在 JS 里比的），所以这里也只按 $1 找行
      if (!this.session || this.session.id !== params[0]) return { rows: [] };
      return { rows: [{ ...this.session }] };
    }
    // --- 活跃 run（enqueue 的分岔判定 / postMessage 的 409 预检）---
    if (/FROM runs/.test(s) && /status IN \('queued', 'running', 'cancelling'\)/.test(s)) {
      return { rows: this.activeRun ? [{ ...this.activeRun }] : [] };
    }
    if (/SELECT 1 FROM runs WHERE session_id/.test(s)) {
      return { rows: this.activeRun ? [{ '?column?': 1 }] : [] };
    }
    if (s.includes('SELECT fde_name FROM users WHERE id')) return { rows: [{ fde_name: 'alice' }] };
    if (s.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
    if (s.includes('pg_advisory_xact_lock')) return { rows: [] };

    // --- seq 分配 ---
    if (s.includes('UPDATE chat_sessions SET last_seq')) {
      this.session.last_seq += 1;
      return { rows: [{ last_seq: this.session.last_seq }] };
    }
    if (s.startsWith('INSERT INTO messages')) {
      const row = { id: `m${this.messages.length + 1}`, seq: params[1], role: 'user', content: '', attachments: [], created_at: new Date() };
      this.messages.push(row);
      return { rows: [row] };
    }
    const roundHit = this.rounds.query(sql, params);
    if (roundHit) return roundHit;
    if (s.startsWith('INSERT INTO runs')) return { rows: [{ id: 'r1', status: 'queued' }] };
    if (s.startsWith('INSERT INTO run_queue')) return { rows: [] };
    if (s.startsWith('UPDATE messages SET run_id')) return { rows: [] };

    // --- 改名 / 归档（#497 的反例面：它们只动 chat_sessions）---
    if (s.startsWith('UPDATE chat_sessions SET title =')) {
      if (this.session.status !== 'active') return { rows: [] };
      this.session.title = params[1];
      this.session.title_source = 'manual';
      return { rows: [{ ...this.session }] };
    }
    if (s.includes("UPDATE chat_sessions SET status = 'archived'")) {
      this.session.status = 'archived';
      return { rows: [], rowCount: 1 };
    }

    // --- 输入队列 ---
    if (/COUNT\(\*\)::int/.test(s)) {
      return { rows: [{ n: this.queued.filter((q) => q.status === 'pending' || q.status === 'delivering').length }] };
    }
    if (s.startsWith('INSERT INTO queued_inputs')) {
      const [session_id, user_id, kind, content, attachments, interrupted_run_id] = params;
      const row = {
        id: `q${this.queued.length + 1}`, session_id, user_id, kind, content,
        attachments: JSON.parse(attachments ?? '[]'), interrupted_run_id,
        position: this.queued.length + 1, status: 'pending', created_at: new Date(),
      };
      this.queued.push(row);
      return { rows: [row] };
    }
    if (s.includes('UPDATE runs SET cancel_requested_at')) return { rows: [] };

    // --- 登录建会话（W-3d 的反例面：auth.createSession 只写 login_sessions）---
    if (s.startsWith('INSERT INTO login_sessions')) return { rows: [] };

    throw new Error(`ActivityPool：未预期的 SQL\n${s}`);
  }
}

/** 事务边界（流水里的 BEGIN / 最后一次 COMMIT 的下标）。 */
function txnBounds(pool) {
  const begin = pool.journal.findIndex((e) => /^BEGIN\b/i.test(e.sql));
  let commit = -1;
  for (let i = pool.journal.length - 1; i >= 0; i -= 1) {
    if (/^COMMIT\b/i.test(pool.journal[i].sql)) { commit = i; break; }
  }
  return { begin, commit };
}

async function sendOne(pool, over = {}) {
  return postMessage(pool, {
    userId: USER_ID, sessionId: SESSION_ID, content: '在吗', attachments: [],
    triggerKind: 'user_send', ...over,
  });
}

// ---------------------------------------------------------------------------
// W-0 / W-5：写入点的字面与数量
// ---------------------------------------------------------------------------

test('W-0 共用仿真件只接管两个写入点那条语句（反向自证：别的语句必须不接管）', () => {
  const user = { id: USER_ID, last_activity_at: PREV_ACTIVITY };
  const world = createUserActivityWorld({ users: [user] });

  const hit = world.query('UPDATE users SET last_activity_at = now() WHERE id = $1', [USER_ID]);
  assert.ok(hit, '两个写入点那条语句必须被接管');
  assert.equal(hit.rowCount, 1, '用户存在 ⇒ 1 行');
  assert.ok(user.last_activity_at.getTime() > PREV_ACTIVITY.getTime(), '真改了内存行（不是把语句吞掉）');
  assert.equal(world.query('UPDATE users SET last_activity_at = now() WHERE id = $1', ['ghost']).rowCount, 0,
    '用户不存在 ⇒ 0 行（真 PG 语义，不假装写成功）');

  for (const other of [
    'UPDATE users SET last_activity_at = now() WHERE id = $2',      // 参数位不对 = 不是我们那条
    'UPDATE users SET last_login_at = now() WHERE id = $1',         // 有人「顺手」在登录路径补写
    'UPDATE users SET last_activity_at = $2 WHERE id = $1',         // 带值写（节流变体的形状）
    'UPDATE chat_sessions SET last_activity_at = now() WHERE id = $1',
    'SELECT last_activity_at FROM users WHERE id = $1',
  ]) {
    assert.equal(world.query(other, [USER_ID]), null, `不该接管：${other}`);
  }
});

test('W-0b 两个写入点都是同一句 SQL、同一形状：不节流、不比当前值、无 RETURNING', () => {
  const one = /await client\.query\(`UPDATE users SET last_activity_at = now\(\) WHERE id = \$1`, \[userId\]\);/;
  for (const [file, label] of [['sessions.js', '发送路'], ['queued-inputs.js', '入队路']]) {
    const src = stripLineComments(fs.readFileSync(path.join(SRC, file), 'utf8'));
    assert.match(src, one, `${label}必须用 client + 无 RETURNING 的裸 UPDATE（不节流、不带值）`);
    // 节流变体的三种写法都不许出现（拍板：不节流。带时间窗 / 「比当前值新才写」都是偷偷换口径）
    assert.ok(!/last_activity_at\s*(<|>|IS\s+DISTINCT|IS\s+NULL)/.test(src),
      `${label}不许出现「比当前值新才写 / 时间窗」这类节流谓词`);
    assert.ok(!/last_activity_at[^;]*RETURNING/i.test(src), `${label}不许给这条 UPDATE 加 RETURNING（多一次往返，没人要这个值）`);
  }
});

test('W-5 全仓写入点恰好两处（不许加第三个）', () => {
  const hits = [];
  for (const entry of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
    // 只数**没被注释掉**的语句（注释里写「以前这里是 UPDATE users SET last_activity_at = now()」不算写入点）
    const src = stripLineComments(fs.readFileSync(path.join(SRC, entry), 'utf8'));
    const found = src.match(/UPDATE\s+users\s+SET\s+last_activity_at\s*=\s*now\(\)/gi);
    if (found) hits.push([entry, found.length]);
  }
  assert.deepEqual(
    hits.map(([f, n]) => `${f}:${n}`).sort(),
    ['queued-inputs.js:1', 'sessions.js:1'],
    `写入点必须恰好这两处、每处一条（实得 ${JSON.stringify(hits)}）—— 加第三处就是把 A3 偷偷做成别的方案`,
  );
});

// ---------------------------------------------------------------------------
// W-1 / W-2：正例（两个写入点各一条）
// ---------------------------------------------------------------------------

test('W-1 发送路：postMessage 恰写一次活动位，且库里那一格真的变新', async () => {
  const pool = new ActivityPool();
  const posted = await sendOne(pool);
  assert.equal(posted.message.role, 'user', '先把消息发出去（这条判据不是空转）');

  assert.equal(pool.activity.writes.length, 1, '一条用户消息 ⇒ 恰好一次写入（不节流 ⇒ 每发一条写一次）');
  assert.deepEqual(pool.activity.writes[0].userId, USER_ID, '写的是发送者本人，不是会话属主以外的谁');

  const after = pool.userRow().last_activity_at;
  assert.ok(after.getTime() > PREV_ACTIVITY.getTime(),
    `必须严格变新：前=${PREV_ACTIVITY.toISOString()} 后=${after?.toISOString()}`);
  assert.equal(after.getTime(), pool.activity.writes[0].at.getTime(), '库里那一格 = 这次事务时间戳（值相等，不是「大概变新了」）');

  // 顺序：活动位写在 seq 分配之后、COMMIT 之前（同一事务里挨着，口径同工单指定落点）
  const { commit } = txnBounds(pool);
  const iActivity = pool.activityIndex();
  const iSeq = pool.journal.findIndex((e) => e.sql.includes('UPDATE chat_sessions SET last_seq'));
  const iMessage = pool.journal.findIndex((e) => e.sql.startsWith('INSERT INTO messages'));
  assert.ok(iSeq !== -1 && iMessage !== -1 && iActivity !== -1, '三条语句都要在流水里');
  assert.ok(iSeq < iActivity && iActivity < commit, '活动位与 seq 分配在同一事务内（COMMIT 之前）');
});

test('W-1b 事务形状：活动位只能由事务内那个 client 写（换 pool.query 自开连接就红）', async () => {
  const pool = new ActivityPool();
  await sendOne(pool);

  assert.equal(pool.connects, 1, 'postMessage 自开事务（connect 一次）——本单不许改成 pool.query');
  assert.notEqual(pool.activityIndex('client'), -1, '写入必须来自 client（事务句柄）');
  assert.equal(pool.activityIndex('pool'), -1,
    '不许出现 pool.query 版的写入：它自开一条连接、自带一个事务 ⇒ 「消息回滚了但活动位前进了」（工单 M2 硬要求 3）');
  // 逐条查：整条流水里**任何**一条活动位写入都必须是 client 发的
  const offenders = pool.journal.filter((e) => USER_ACTIVITY_UPDATE.test(e.sql) && e.via !== 'client');
  assert.deepEqual(offenders, [], `所有活动位写入都必须在事务句柄上，实得 ${JSON.stringify(offenders.map((o) => o.via))}`);
});

test('W-1c 回滚：业务写入失败 ⇒ 活动位不前进（「消息回滚了但活动位前进了」是红线）', async () => {
  const pool = new ActivityPool({ failOn: 'INSERT INTO runs' });
  await assert.rejects(() => sendOne(pool), /业务写入失败/);

  assert.equal(pool.rollbacks, 1, '假池确实走了 ROLLBACK');
  assert.equal(pool.commits, 0);
  assert.equal(pool.userRow().last_activity_at.getTime(), PREV_ACTIVITY.getTime(),
    `回滚后库里那一格必须还是原值（实得 ${pool.userRow().last_activity_at?.toISOString()}）——写入点必须在事务内`);
  assert.equal(pool.activity.writes.length, 0, '回滚的事务不留写入记录（本假池按真 PG 还原）');

  // 反证：同一句在事务里确实发出去了（不是「压根没走到」，否则上面两条是假绿）
  assert.notEqual(pool.activityIndex(), -1, '语句发过、但在 BEGIN..ROLLBACK 之间');
  const rollbackIdx = pool.journal.findLastIndex((e) => /^ROLLBACK\b/i.test(e.sql));
  assert.ok(pool.activityIndex() < rollbackIdx);
});

test('W-2 入队路：运行中按回车那一刻就变新（同事务；投递成功与否无关）', async () => {
  const pool = new ActivityPool({ activeRun: { id: 'r1', status: 'running' } });
  const res = await enqueueQueuedInput(pool, {
    userId: USER_ID, sessionId: SESSION_ID, kind: 'follow_up', content: '等一下再改测试', attachments: [],
    deps: {},
  });

  assert.equal(res.posted, null, '有活跃 run ⇒ 走入队分岔（不是直发）');
  assert.equal(pool.queued.length, 1, '确实落了一行 queued_inputs（判据不是空转）');
  assert.equal(pool.activity.writes.length, 1);
  assert.equal(pool.activity.writes[0].userId, USER_ID);

  const after = pool.userRow().last_activity_at;
  assert.ok(after.getTime() > PREV_ACTIVITY.getTime(), '入队那一刻就是活动：不等投递、不等 run 结束');
  assert.equal(after.getTime(), pool.activity.writes[0].at.getTime(), '值相等（不是「大概变新了」）');

  const { begin, commit } = txnBounds(pool);
  const iActivity = pool.activityIndex();
  const iInsert = pool.journal.findIndex((e) => e.sql.startsWith('INSERT INTO queued_inputs'));
  assert.ok(begin !== -1 && commit !== -1, '入队走显式事务');
  assert.ok(iInsert < iActivity && iActivity < commit, '与 queued_inputs 落库同事务、COMMIT 之前（回滚必须一起消失）');
  assert.equal(pool.activityIndex('pool'), -1, '同样是 client，不是 pool.query');
});

test('W-2b 直发路：一条用户输入恰好写一次活动位（两处写入点不许双写）', async () => {
  const pool = new ActivityPool({ activeRun: null });
  const res = await enqueueQueuedInput(pool, {
    userId: USER_ID, sessionId: SESSION_ID, kind: 'follow_up', content: '直发', attachments: [], deps: {},
  });

  assert.ok(res.posted, '无活跃 run ⇒ 退化成直发（转 postMessage）');
  assert.equal(res.queued, null);
  assert.equal(pool.queued.length, 0, '直发不落队列行');
  assert.equal(pool.activity.writes.length, 1,
    '恰好一次：入队分支先 COMMIT 再转 postMessage，活动位由 postMessage 那一处写。这里变成 2 就是双写');
  assert.ok(pool.userRow().last_activity_at.getTime() > PREV_ACTIVITY.getTime(), '值确实前进了（不是「0 次也算过」）');
});

// ---------------------------------------------------------------------------
// W-3：反例（缺这组就等于偷偷做成了另一个方案）
// ---------------------------------------------------------------------------

test('W-3 反例·run 完成：worker 报 finished(end_turn) 不许动活动位', async () => {
  const { pool, userId, containerId, runId } = seedClaimable();
  const seeded = new Date('2026-11-11T20:00:00.000Z');
  pool.users[0].last_activity_at = seeded;
  const container = { id: containerId, user_id: userId };
  const user = { id: userId, login: 'alice' };
  const ticket = await claimRun(pool, { container, user, capacity: 1, holdMs: 10 });

  await setRunState(pool, { container, user, runId, claimToken: ticket.claim_token, body: { state: 'running' } });
  const res = await setRunState(pool, {
    container, user, runId, claimToken: ticket.claim_token,
    body: { state: 'finished', termination: { reason: 'end_turn' }, usage: { input_tokens: 3, output_tokens: 1 }, rounds: 1, final_text: 'done' },
  });

  // 先证明「run 真的跑完了」：否则这条只是在证明假池啥也没干
  assert.equal(res.state, 'finished');
  assert.equal(pool.runs[0].status, 'finished');
  assert.ok(pool.events.some((e) => e.type === 'run_end'), 'run_end 事件落下（终态面确实被走了一遍）');

  const offenders = pool.sqlLog.filter((e) => USER_ACTIVITY_UPDATE.test(e.sql));
  assert.deepEqual(offenders.map((o) => o.sql), [],
    `agent 自己跑完不许刷新「他什么时候说过话」——实得 ${offenders.length} 条写入`);
  assert.equal(pool.users[0].last_activity_at.getTime(), seeded.getTime(),
    '库里那一格一字不变（run 完成 ≠ 用户说话；口径见 docs/data/model.md §1.1）');
});

test('W-3b 反例·会话改名不许动活动位（PATCH title 只动 chat_sessions）', async () => {
  const pool = new ActivityPool();
  const s = await updateSession(pool, { userId: USER_ID, sessionId: SESSION_ID, title: '改个名字' });

  assert.equal(s.title, '改个名字', '改名真的成功了（不是提前 return 让断言空转）');
  assert.equal(pool.activityIndex(), -1, '改名一条活动位写入都不许发');
  assert.equal(pool.userRow().last_activity_at.getTime(), PREV_ACTIVITY.getTime(),
    '库里那一格一字不变（改名不是说话）');
});

test('W-3c 反例·归档会话不许动活动位', async () => {
  const pool = new ActivityPool();
  const res = await archiveSession(pool, { userId: USER_ID, sessionId: SESSION_ID });

  assert.equal(res.archived, true, '归档真的发生了');
  assert.equal(pool.session.status, 'archived');
  assert.equal(pool.activityIndex(), -1, '归档一条活动位写入都不许发');
  assert.equal(pool.userRow().last_activity_at.getTime(), PREV_ACTIVITY.getTime(),
    '库里那一格一字不变（归档不是说话）');
});

test('W-3d 反例·登录本身不许动活动位（它允许比 last_login_at 旧 = 设计意图）', async () => {
  const user = { id: USER_ID, login: 'alice', last_activity_at: PREV_ACTIVITY, status: 'active' };
  const base = new FakePool({ users: [user] });
  // 包一层活动位仿真：登录路径哪天「顺手」补写，这里就从「静默」变成「红」
  const world = createUserActivityWorld({ users: [user] });
  const pool = {
    journal: [],
    async query(sql, params) {
      this.journal.push(activitySqlOf(sql));
      const hit = world.query(sql, params);
      if (hit) return hit;
      return base.query(sql, params);
    },
    async connect() { return { query: (sql, params) => this.query(sql, params), release() {} }; },
  };

  const { tokenHash } = await auth.createSession(pool, USER_ID, { ip: '10.0.0.1', userAgent: 'pytest' });
  assert.ok(tokenHash, '登录会话真的建了（写的是 login_sessions）');
  assert.ok(pool.journal.some((s) => s.startsWith('INSERT INTO login_sessions')), '写的是登录会话，不是活动位');
  assert.equal(world.writes.length, 0, '登录本身**不算**活动（工单契约：不算登录）');
  assert.equal(user.last_activity_at.getTime(), PREV_ACTIVITY.getTime(),
    '库里那一格一字不变 ⇒ 「last_activity_at 比 last_login_at 旧」是允许的状态，不是 bug');
});

// ---------------------------------------------------------------------------
// W-4：admin DTO（值相等，不是键存在）
// ---------------------------------------------------------------------------

/**
 * 管理台侧的假池：只建模本单要的五个 `safeUser` 生产点。
 *
 * 有牙的地方在 `#returning`：
 *   ① **RETURNING 段没点名列 ⇒ 整个键都不给**（产品侧 `?? null` ⇒ 「从未活动」）⇒ 漏列会红；
 *   ② SQL 里出现 `NULL::timestamptz AS last_activity_at` ⇒ 值是 `null`（真 PG 里同名输出列
 *      后者覆盖前者，见 W-4b）⇒ 「用 NULL 补 DTO 形状」这个旧写法回来也会红。
 */
class AdminActivityPool {
  constructor(users) {
    this.users = users.map((u) => ({ ...u }));
    this.sqlLog = [];
    /**
     * 变异开关（W-4b 用）：把产品 SQL 改回工单「陷阱三」的旧写法，验证**本文件自己的假池有牙**。
     *   'drop'     = RETURNING 不带列，外层用 NULL::timestamptz 补 DTO 形状（本单之前的形态）
     *   'aliasOnly'= RETURNING 带了列，外层又补一个同名 NULL 别名（PG 里后者覆盖前者 ⇒ 仍是 NULL）
     */
    this.mutateNullAlias = null;
  }

  /** 只在两条 CTE 上施变异（listUsers / createUser 不受这条陷阱影响）。 */
  #mutate(sql) {
    if (!this.mutateNullAlias || !/NULL::timestamptz AS last_login_at/.test(sql)) return sql;
    let out = sql;
    if (this.mutateNullAlias === 'drop') out = out.replace(/,\s*last_activity_at\b/, '');
    return out.replace(
      /NULL::timestamptz AS last_login_at/,
      'NULL::timestamptz AS last_login_at, NULL::timestamptz AS last_activity_at',
    );
  }

  find(id) { return this.users.find((u) => u.id === id); }

  #returning(sql, user) {
    const segment = /RETURNING([\s\S]*?)(?:\n\s*\)|$)/.exec(sql)?.[1] ?? '';
    const row = {
      id: user.id, login: user.login, display_name: user.display_name, role: user.role,
      fde_name: user.fde_name ?? null, auth_source: user.auth_source, status: user.status,
      created_at: user.created_at, email: user.email ?? null,
      mail_otp_enabled: user.mail_otp_enabled === true,
      file_upload_enabled: user.file_upload_enabled === true,
      totp_login_enabled: user.totp_login_enabled !== false,
      totp_enabled: user.totp_secret != null,
    };
    if (/\blast_activity_at\b/.test(segment)) row.last_activity_at = user.last_activity_at ?? null;
    // 真 PG：`SELECT x.*, NULL::timestamptz AS last_activity_at FROM x` 输出两列同名，
    // node-pg 的行对象里**后者覆盖前者** ⇒ NULL 赢过真值。旧写法就是这么把真值洗掉的。
    if (/NULL::timestamptz\s+AS\s+last_activity_at/i.test(sql)) row.last_activity_at = null;
    return row;
  }

  async query(rawSql, params = []) {
    this.sqlLog.push({ sql: rawSql, params });
    // ⚠ **先剥 SQL 注释**：产品 SQL 里就写着「不许再补 NULL::timestamptz AS last_activity_at」这类
    //   说明（`--` 注释），不剥掉的话假池会把**注释**当成列别名 ⇒ 假池自己先骗人。
    //   真 PG 不认注释，假池也不许认。（这是本文件第一版踩到的坑，留在这里当下一次的护栏。）
    let sql = this.#mutate(rawSql.replace(/--[^\n]*/g, ''));

    // updateUser 的 CTE
    if (sql.includes('WITH updated AS') && sql.includes('UPDATE users SET')) {
      const user = this.find(params[0]);
      if (!user) return { rows: [] };
      for (const column of ['display_name', 'email', 'role', 'fde_name', 'status',
        'mail_otp_enabled', 'file_upload_enabled', 'totp_login_enabled']) {
        const m = sql.match(new RegExp(`${column} = \\$([0-9]+)`));
        if (m) user[column] = params[Number(m[1]) - 1];
      }
      return { rows: [{ ...this.#returning(sql, user), last_login_at: null }] };
    }
    // enrollUserTotp 的 CTE
    if (sql.includes('WITH target AS') && sql.includes('totp_secret = $2')) {
      const user = this.find(params[0]);
      if (!user) return { rows: [] };
      user.totp_secret = params[1];
      user.last_totp_step = null;
      return { rows: [{ ...this.#returning(sql, user), totp_enabled: true, last_login_at: null }] };
    }
    // createUser：重激活分支（UPDATE 复用 disabled 旧行）
    if (sql.includes('UPDATE users') && sql.includes('SET login = $2')) {
      const [id, login, email, displayName, hash, totpSecret] = params;
      const user = this.users.find((u) => u.id === id && u.status === 'disabled');
      if (!user) return { rows: [] };
      Object.assign(user, {
        login, email, display_name: displayName, password_hash: hash, totp_secret: totpSecret,
        last_totp_step: null, status: 'active', disabled_at: null,
      });
      return { rows: [this.#returning(sql, user)] };
    }
    // createUser：新建分支（列没写 ⇒ 吃迁移默认值 NULL）
    if (sql.includes('INSERT INTO users (')) {
      const [login, email, displayName, hash, totpSecret, fdeName] = params;
      const row = {
        id: `b0000000-0000-4000-8000-${String(this.users.length + 10).padStart(12, '0')}`,
        login, email, display_name: displayName, role: 'fde', fde_name: fdeName,
        auth_source: 'local', status: 'active', password_hash: hash, totp_secret: totpSecret,
        mail_otp_enabled: false, file_upload_enabled: false, totp_login_enabled: true,
        last_activity_at: null, // 迁移 0031：可空无默认 ⇒ 新账号就是 NULL（从未活动）
        created_at: new Date(),
      };
      this.users.push(row);
      return { rows: [this.#returning(sql, row)] };
    }
    // listUsers
    if (sql.includes('FROM users') && sql.includes('LEFT JOIN')) {
      return {
        rows: this.users.map((u) => ({
          id: u.id, login: u.login, display_name: u.display_name, email: u.email ?? null,
          role: u.role, fde_name: u.fde_name ?? null, auth_source: u.auth_source, status: u.status,
          created_at: u.created_at, totp_enabled: u.totp_secret != null, last_login_at: null,
          git_host_id: null, onboarding_state: null, offboarding_state: null,
          mail_otp_enabled: u.mail_otp_enabled === true,
          file_upload_enabled: u.file_upload_enabled,
          totp_login_enabled: u.totp_login_enabled,
          // ⚠ 按 SQL 的列清单回列：SELECT 里没点名 last_activity_at ⇒ 键都不给（产品侧折叠成 null）
          ...(/\blast_activity_at\b/.test(sql) ? { last_activity_at: u.last_activity_at ?? null } : {}),
        })),
      };
    }
    if (sql.includes('INSERT INTO audit_log')) return { rows: [] };
    // createUser 的开户前置检查（fde_name 是否已被非 disabled 行占着）
    if (sql.includes('SELECT id, status FROM users WHERE fde_name')) {
      const u = this.users.find((x) => x.fde_name === params[0]);
      return { rows: u ? [{ id: u.id, status: u.status }] : [] };
    }
    if (sql.includes('SELECT git_host_id, token_ref FROM fde_git_accounts')) return { rows: [] };
    if (/SELECT 1 FROM users WHERE (login|email|fde_name)/.test(sql)) return { rows: [] };
    if (sql.includes('lower(email) = lower($1)')) return { rows: [] };
    if (sql.includes('SELECT state FROM fde_offboarding')) return { rows: [] };
    if (sql.includes('SELECT id, login, fde_name FROM users WHERE id')) {
      const u = this.find(params[0]);
      return { rows: u ? [{ id: u.id, login: u.login, fde_name: u.fde_name ?? null }] : [] };
    }
    if (sql.includes('DELETE FROM login_sessions') || sql.includes('DELETE FROM login_pending')
      || sql.includes('DELETE FROM api_tokens') || sql.includes('UPDATE fde_git_accounts')) {
      return { rows: [] };
    }
    throw new Error(`AdminActivityPool：未预期的 SQL\n${sql.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
}

/** 库里的一个用户（默认「上周说过话」；`over` 用来造 disabled / 新建等形状）。 */
const ADMIN_USER = (over = {}) => ({
  id: USER_ID, login: 'alice', display_name: 'Alice', email: 'alice@example.test',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
  created_at: new Date('2026-11-01T00:00:00Z'),
  password_hash: null, totp_secret: 'SEEDSEEDSEEDSEEDSEED', last_totp_step: null,
  mail_otp_enabled: false, file_upload_enabled: false, totp_login_enabled: true,
  last_activity_at: PREV_ACTIVITY,
  ...over,
});

test('W-4 admin DTO 五个生产点都带 last_activity_at，且**值与库里那一刻相等**', async () => {
  const iso = PREV_ACTIVITY.toISOString();

  // ① listUsers
  const pool = new AdminActivityPool([ADMIN_USER()]);
  const listed = await admin.listUsers(pool);
  assert.ok(Object.hasOwn(listed.items[0], 'last_activity_at'), 'listUsers 的 DTO 必须带这个键');
  assert.equal(listed.items[0].last_activity_at, iso, '值必须等于库里那一刻（键存在挡不住漏列）');

  // ② updateUser（PATCH）——工单陷阱三：这两条 CTE 以前用 NULL::timestamptz 补 DTO 形状
  const patched = await admin.updateUser(pool, USER_ID, { display_name: 'Alice Wong' });
  assert.equal(patched.user.display_name, 'Alice Wong', 'PATCH 真的改了（不是提前返回）');
  assert.equal(patched.user.last_activity_at, iso,
    'PATCH 返回的必须是**真实时刻**，不是 NULL —— 写 NULL 就会把「上周说过话」显示成「从未活动」');

  // ③ enrollUserTotp——同理，且重绑不该改活动时刻
  const enrolled = await admin.enrollUserTotp(pool, USER_ID);
  assert.ok(enrolled.totp_secret, '重绑发了新种子（判据不是空转）');
  assert.equal(enrolled.user.last_activity_at, iso, '重绑 TOTP 不是「用户说话」，值必须原样带回');

  // ④ createUser 新建分支：新账号从未活动 ⇒ null（键必须在，值必须是 null 而不是缺键）
  const created = await admin.createUser(pool, {
    login: 'bob', display_name: 'Bob', password: 'correct horse battery staple',
    email: 'bob@example.test', fde_name: 'bob',
  });
  assert.ok(Object.hasOwn(created.user, 'last_activity_at'), '新建分支的 RETURNING 也要带这一列');
  assert.equal(created.user.last_activity_at, null, '刚开户 ⇒ 从未活动（可空列 + 无默认值，见迁移 0031）');

  // ⑤ createUser 重激活分支：复用 disabled 旧行 ⇒ 上一任期的真实时刻不许被洗掉
  const rePool = new AdminActivityPool([ADMIN_USER({
    id: 'c0000000-0000-4000-8000-000000000003', login: 'carol', fde_name: 'carol', status: 'disabled',
  })]);
  const reactivated = await admin.createUser(rePool, {
    login: 'carol', display_name: 'Carol', password: 'correct horse battery staple',
    email: 'carol@example.test', fde_name: 'carol',
  });
  assert.equal(reactivated.user.status, 'active', '重激活真的发生了');
  assert.equal(reactivated.user.last_activity_at, iso,
    '重新开户**不**重置活动时刻：库里存着上一任期那一刻就还是那一刻（要清它是另一件事，本单不猜）');
});

test('W-4b 假池自己有牙：把旧写法（NULL::timestamptz 补 DTO 形状）喂回去，值必须变成 null', async () => {
  // 这一条不测产品代码，测的是「W-4 会不会是假绿」：如果假池好心替产品代码补上真值，
  // 那么 W-4 里 `assert.equal(patched.user.last_activity_at, iso)` 就永远绿，
  // 而真库里 DTO 正在报「从未活动」——工单点名的陷阱三正是这个形状。
  const iso = PREV_ACTIVITY.toISOString();

  // 变异一：RETURNING 不带列 + 外层 NULL 别名（本单之前的旧写法）
  const dropped = new AdminActivityPool([ADMIN_USER()]);
  dropped.mutateNullAlias = 'drop';
  const r1 = await admin.updateUser(dropped, USER_ID, { display_name: 'Alice Wong' });
  assert.equal(r1.user.display_name, 'Alice Wong', '变异没改掉 PATCH 本身（只改 DTO 那一列的取法）');
  assert.equal(r1.user.last_activity_at, null,
    '旧写法必须让假池交出 null（而不是替产品代码补真值）⇒ W-4 的「值相等」当场红');

  // 变异二：RETURNING 带了列，但外层又补同名 NULL 别名 —— PG 输出两列同名，node-pg 行对象里后者赢
  const aliased = new AdminActivityPool([ADMIN_USER()]);
  aliased.mutateNullAlias = 'aliasOnly';
  const r2 = await admin.updateUser(aliased, USER_ID, { display_name: 'Alice Wong' });
  assert.equal(r2.user.last_activity_at, null,
    '同名别名列赢过真值（这是真库里的实际行为，不是假池的洁癖）⇒ 产品侧必须在 RETURNING 里拿列且不补 NULL');

  // 对照：不施变异时同一个池必须给真值（否则上面两条是「假池根本拿不到值」的假红）
  const clean = new AdminActivityPool([ADMIN_USER()]);
  const r3 = await admin.updateUser(clean, USER_ID, { display_name: 'Alice Wong' });
  assert.equal(r3.user.last_activity_at, iso, '同一份库、同一条 PATCH：不补 NULL 就拿得到真值');

  // 并且钉住产品 SQL 现在的形状：两条 CTE 都把列写进 RETURNING，块内不许出现 NULL 补位
  // ⚠ 先剥**整行 SQL 注释**：产品代码里就写着「这里不许再补 NULL::timestamptz AS last_activity_at」
  //   这类说明（真 PG 不认注释，判据也不许被注释绊倒）。这条坑本文件已经踩过一次（见 AdminActivityPool 的注释）。
  const adminSrc = stripSqlComments(fs.readFileSync(path.join(SRC, 'admin.js'), 'utf8'));
  for (const [anchor, tail, label] of [
    ['WITH updated AS (', 'SELECT updated.*', 'updateUser（PATCH）的 CTE'],
    ['SET totp_secret = $2', 'SELECT target.*', 'enrollUserTotp 的 CTE'],
  ]) {
    const from = adminSrc.indexOf(anchor);
    const to = adminSrc.indexOf(tail, from);
    assert.ok(from !== -1 && to > from, `${label}：锚点失配（SQL 改形状了就来同步这条判据）`);
    const block = adminSrc.slice(from, to);
    assert.match(block, /RETURNING[\s\S]*\blast_activity_at\b[\s\S]*totp_enabled/,
      `${label} 的 RETURNING 必须点名 last_activity_at（真实值只能从这里拿）`);
    assert.ok(!/NULL::timestamptz\s+AS\s+last_activity_at/.test(block),
      `${label} 里不许用 NULL 补这一列（那会把真值洗成「从未活动」）`);
  }
  assert.equal(
    (adminSrc.match(/NULL::timestamptz\s+AS\s+last_activity_at/g) ?? []).length,
    0,
    '产品代码里不许出现 NULL::timestamptz AS last_activity_at（那会把真值洗成「从未活动」）',
  );
});

test('W-6 迁移回填只动 last_activity_at IS NULL 的行（重放第二遍 = 零行）', () => {
  const sql = fs.readFileSync(path.join(HERE, '../../deploy/migrations/0031-user-last-activity-at.sql'), 'utf8');
  const statements = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  assert.match(statements, /\bUPDATE users\b[\s\S]*\bSET last_activity_at\b/, '有一次性回填');
  assert.match(statements, /AND u\.last_activity_at IS NULL/,
    '回填谓词必须带 IS NULL：漏了它，第二遍会把已有时刻改写成「该用户最新一条消息」并让重放不再零操作');
  assert.match(statements, /WHERE m\.role = 'user'\s+AND m\.synthetic = false/,
    "只算真人说的话（role='user' AND synthetic=false）");
});
