// 单测：issue #88 会话标题自动落库与自动更新（portal/src/session-title.js + sessions.js title_source 语义）。
// 2026-09-25 修订：标题生成移到 agent（worker）侧（runner/lib/session-title.js，随 run_finished 上报），
// portal 侧 evaluateAutoTitle 不再发任何 HTTP——消费 agentTitle → 防抖判据 → title_source='auto' 守卫
// 落库 → SSE session_updated。降级链：agent title 缺失/空 → 首条用户消息截断 → cwd basename。
// 覆盖：
//   * title_source 语义：createSession 显式 title → manual / 缺省 → auto；updateSession 改 title → manual；
//     自动更新 UPDATE 只写 title_source='auto' 的行（manual 行 0 行不覆盖）。
//   * agentTitle 消费：上报标题清洗落库 + SSE；空/缺失 → 降级链（首条消息截断 / cwd basename）。
//   * 节流判据（shouldRefreshTitle 纯函数 + evaluateAutoTitle 集成）：首启必生成、≥N 轮新 user 消息、
//     话题漂移启发式（关键词零重合）、manual 行直接跳过、开关关闭 no-op。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool，不碰真实 DB / 网络。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_TITLE_MAX_LEN,
  shouldRefreshTitle,
  extractKeywords,
  keywordsOverlap,
  sanitizeTitle,
  clipTitleFromMessage,
  fallbackTitleFromCwd,
  evaluateAutoTitle,
} from '../src/session-title.js';
import { createSession, updateSession, postMessage } from '../src/sessions.js';
import { createSessionTextHandler, inputTranscriptRow } from './fake-session-text.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'erix-title-test-'));
}

// ---------------------------------------------------------------------------
// 纯函数：节流判据与降级链
// ---------------------------------------------------------------------------

test('shouldRefreshTitle：无标题（首启）必生成', () => {
  assert.equal(shouldRefreshTitle({ title: '', autoTitleSeq: null, newUserCount: 1, latestUserContent: 'x', minNew: 3 }), true);
  assert.equal(shouldRefreshTitle({ title: '  ', autoTitleSeq: 5, newUserCount: 0, latestUserContent: 'x', minNew: 3 }), true);
});

test('shouldRefreshTitle：≥N 轮新 user 消息 → 刷新（防抖动阈值）', () => {
  const base = { title: '修复登录 bug', autoTitleSeq: 10, latestUserContent: '登录页微调', minNew: 3 };
  assert.equal(shouldRefreshTitle({ ...base, newUserCount: 2 }), false, '2 轮 < N=3 且话题未漂移（含「登录」重合）不刷新');
  assert.equal(shouldRefreshTitle({ ...base, newUserCount: 3 }), true);
  assert.equal(shouldRefreshTitle({ ...base, newUserCount: 7 }), true);
});

test('shouldRefreshTitle：话题漂移启发式——≥1 轮新消息且与现标题关键词零重合 → 刷新', () => {
  // 「修复登录 bug」vs「数据库迁移脚本」：无重合 → 漂移。
  assert.equal(
    shouldRefreshTitle({ title: '修复登录 bug', autoTitleSeq: 10, newUserCount: 1, latestUserContent: '帮我写一个数据库迁移脚本', minNew: 3 }),
    true,
  );
  // 有重合（「登录」）→ 不漂移。
  assert.equal(
    shouldRefreshTitle({ title: '修复登录 bug', autoTitleSeq: 10, newUserCount: 1, latestUserContent: '登录页还是白屏', minNew: 3 }),
    false,
  );
  // 0 轮新消息 → 不刷新（漂移启发式要求 ≥1 轮）。
  assert.equal(
    shouldRefreshTitle({ title: '修复登录 bug', autoTitleSeq: 10, newUserCount: 0, latestUserContent: '登录页还是白屏', minNew: 3 }),
    false,
  );
});

test('shouldRefreshTitle：存量无游标标题（auto 但从未自动更新）只按 N 轮防抖', () => {
  assert.equal(shouldRefreshTitle({ title: '旧手工标题', autoTitleSeq: null, newUserCount: 1, latestUserContent: '完全不同的话题xyz', minNew: 3 }), false);
  assert.equal(shouldRefreshTitle({ title: '旧手工标题', autoTitleSeq: null, newUserCount: 3, latestUserContent: 'x', minNew: 3 }), true);
});

test('extractKeywords/keywordsOverlap：ASCII 词（≥2 字符）+ CJK 字粒度', () => {
  const k = extractKeywords('Fix the Login-BUG 登录页');
  assert.ok(k.has('fix') && k.has('the') && k.has('login') && k.has('bug'), 'ASCII 词小写化入集');
  assert.ok(k.has('登') && k.has('录') && k.has('页'), 'CJK 字粒度入集');
  assert.equal(k.has('l'), false, '单字符 ASCII 词不入集');
  assert.equal(keywordsOverlap('登录页白屏', '修复登录 bug'), true, '「登录」重合');
  assert.equal(keywordsOverlap('数据库迁移', '修复登录 bug'), false, '零重合');
  assert.equal(keywordsOverlap('!!!', '任何标题'), false, '抽不出关键词 → 判漂移');
});

test('sanitizeTitle：去包裹/首行/折叠空白/截断 ≤30 字符；空 → null', () => {
  assert.equal(sanitizeTitle('修复登录流程'), '修复登录流程');
  assert.equal(sanitizeTitle('「修复登录流程」'), '修复登录流程', '去中文引号');
  assert.equal(sanitizeTitle('"Fix login"'), 'Fix login', '去英文引号');
  assert.equal(sanitizeTitle('《发布脚本》'), '发布脚本', '去书名号');
  assert.equal(sanitizeTitle('第一行\n第二行'), '第一行', '取首行');
  assert.equal(sanitizeTitle('  a   b  '), 'a b', '折叠空白');
  assert.equal(sanitizeTitle('   '), null);
  assert.equal(sanitizeTitle(''), null);
  assert.equal(sanitizeTitle(null), null);
  const long = '长'.repeat(50);
  assert.equal(sanitizeTitle(long), '长'.repeat(AUTO_TITLE_MAX_LEN), '截断到 30 字符');
});

test('clipTitleFromMessage / fallbackTitleFromCwd：首条消息截断与 cwd basename 末级降级', () => {
  assert.equal(clipTitleFromMessage('帮我修复登录页面的白屏问题'), '帮我修复登录页面的白屏问题');
  assert.equal(clipTitleFromMessage('a'.repeat(50)), 'a'.repeat(AUTO_TITLE_MAX_LEN), '截断 30 字符');
  assert.equal(clipTitleFromMessage('  多行\n消息  '), '多行 消息', '空白折叠（不换行——截断语义保留原文轮廓）');
  assert.equal(clipTitleFromMessage(''), null);
  assert.equal(clipTitleFromMessage(null), null);
  assert.equal(fallbackTitleFromCwd('~/projects/meeting_asr_app'), 'meeting_asr_app');
  assert.equal(fallbackTitleFromCwd(`~/projects/${'a'.repeat(50)}`), 'a'.repeat(AUTO_TITLE_MAX_LEN), '长目录名截断 30 字符');
  assert.equal(fallbackTitleFromCwd(''), '未命名会话');
  assert.equal(fallbackTitleFromCwd(null), '未命名会话');
});

test('issue #114：clipTitleFromMessage({ellipsis:true})——被截断尾加 …；未截断不加；默认不加（#88 语义不变）', () => {
  const long = 'a'.repeat(50);
  assert.equal(clipTitleFromMessage(long, { ellipsis: true }), `${'a'.repeat(AUTO_TITLE_MAX_LEN)}…`, '截断 30 字 + 尾缀 …');
  assert.equal(clipTitleFromMessage('正好三十个字', { ellipsis: true }), '正好三十个字', '未截断不加 …');
  // 恰好 30 字（边界）：不截断 → 不加省略号。
  const exact = '字'.repeat(AUTO_TITLE_MAX_LEN);
  assert.equal(clipTitleFromMessage(exact, { ellipsis: true }), exact, '恰为上限不加 …');
  assert.equal(clipTitleFromMessage('字'.repeat(AUTO_TITLE_MAX_LEN + 1), { ellipsis: true }), `${'字'.repeat(AUTO_TITLE_MAX_LEN)}…`, '超 1 字即加 …');
  // 默认参数不破坏 #88 既有调用方（evaluateAutoTitle 降级链）语义。
  assert.equal(clipTitleFromMessage(long), 'a'.repeat(AUTO_TITLE_MAX_LEN), '默认不加省略号');
  assert.equal(clipTitleFromMessage(long, {}), 'a'.repeat(AUTO_TITLE_MAX_LEN));
  assert.equal(clipTitleFromMessage('  ', { ellipsis: true }), null, '空消息仍为 null（走末级降级）');
});

// ---------------------------------------------------------------------------
// sessions.js：title_source 语义（createSession / updateSession）
// ---------------------------------------------------------------------------

function sessionsPool() {
  const queries = [];
  const state = {
    row: {
      id: 's1', user_id: 'u1', project_id: null, cwd: '~/projects/demo',
      title: '', title_source: 'auto', model: null, status: 'active', last_seq: 0,
      created_at: new Date('2026-09-25T00:00:00.000Z'), updated_at: new Date('2026-09-25T00:00:00.000Z'),
    },
  };
  const pool = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT fde_name FROM users')) return { rows: [{ fde_name: 'alice' }] };
      if (sql.startsWith('INSERT INTO chat_sessions')) {
        state.row = { ...state.row, title: params[2], title_source: params[4] };
        return { rows: [{ ...state.row }] };
      }
      if (sql.startsWith('UPDATE chat_sessions')) {
        // fetchSession 首查（FOR UPDATE 无）+ UPDATE 本体共用一个匹配：按 SQL 形态区分
        if (sql.includes('SET title =')) {
          state.row = { ...state.row, title: params[1], title_source: 'manual' };
          return { rows: [{ ...state.row }] };
        }
        return { rows: [{ ...state.row }] };
      }
      if (sql.includes('FROM chat_sessions s')) return { rows: [{ ...state.row }] };
      return { rows: [] };
    },
  };
  return pool;
}

test('createSession：不传 title → title_source=auto（等待自动标题）；显式传 title → manual（手工优先）', async () => {
  const userSpaceRoot = tmpRoot();
  try {
    const cfg = { userSpaceRoot };
    const p1 = sessionsPool();
    const s1 = await createSession(p1, { userId: 'u1', projectId: '~/projects/demo', config: cfg });
    assert.equal(s1.title_source, 'auto');
    const insert1 = p1.queries.find((q) => q.sql.startsWith('INSERT INTO chat_sessions'));
    assert.equal(insert1.params[4], 'auto');

    const p2 = sessionsPool();
    const s2 = await createSession(p2, { userId: 'u1', projectId: '~/projects/demo', title: '我的会话', config: cfg });
    assert.equal(s2.title_source, 'manual', '建会话显式起名 = 手工标题，自动更新不得覆盖');
    const insert2 = p2.queries.find((q) => q.sql.startsWith('INSERT INTO chat_sessions'));
    assert.equal(insert2.params[4], 'manual');
  } finally {
    fs.rmSync(userSpaceRoot, { recursive: true, force: true });
  }
});

test('updateSession：改 title → title_source=manual', async () => {
  const pool = sessionsPool();
  const updated = await updateSession(pool, { userId: 'u1', sessionId: 'a1b2c3d4-1111-4111-8111-abcdefabcdef', title: '改名' });
  assert.equal(updated.title, '改名');
  assert.equal(updated.title_source, 'manual');
  const upd = pool.queries.find((q) => q.sql.startsWith('UPDATE chat_sessions') && q.sql.includes('SET title ='));
  assert.ok(upd.sql.includes("title_source = 'manual'"), 'UPDATE 必须置 manual');
});

// ---------------------------------------------------------------------------
// issue #114：postMessage 首条消息截断为默认标题（零 LLM，与 ERIX_SESSION_AUTO_TITLE 开关解耦）
// ---------------------------------------------------------------------------

const PM_SESSION_ID = 'a1b2c3d4-1111-4111-8111-abcdefabcdef';

/** postMessage 的业务事务 fake client：记录 SQL 顺序，模拟 transcript 唯一键与标题守卫。 */
function postMessageClient({
  title = '',
  title_source = 'auto',
  existingRounds = [],
  createdAt = new Date('2026-10-07T11:00:00.000Z'),
} = {}) {
  const state = {
    title,
    title_source,
    createdAt,
    transcriptRows: existingRounds.map((round, index) => ({
      transcriptKey: PM_SESSION_ID,
      dedupKey: `existing-${index}`,
      round,
    })),
    transcriptInsertAttempts: 0,
  };
  const order = [];
  const client = {
    async query(sql, params = []) {
      order.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] };
      if (s.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (s.includes('FROM chat_sessions s') && s.includes('FOR UPDATE')) {
        return { rows: [{ id: PM_SESSION_ID, user_id: 'u1', project_id: null, cwd: '~/projects/p', title: state.title, title_source: state.title_source, model: null, status: 'active', last_seq: 0 }] };
      }
      if (s.includes('FROM runs WHERE session_id')) return { rows: [] };
      if (s.includes('SELECT fde_name FROM users WHERE id')) return { rows: [{ fde_name: 'alice' }] };
      if (s.includes('SELECT provider_id FROM fde_llm_bindings')) return { rows: [] };
      if (s.includes('FROM containers')) return { rows: [{ id: 'c1' }] };
      if (s.includes('UPDATE chat_sessions SET last_seq')) return { rows: [{ last_seq: 1 }] };
      if (s.startsWith('INSERT INTO messages')) {
        // P3 PR②b B2：`content` 不再是绑定参数（写侧恒为 SQL 里的空串字面量），故从 SQL 取回该字面量，
        // 使 fake 的 RETURNING 行与真库一致；附件从本单起上移到 `params[2]`。
        const content = s.match(/'user',\s*'([^']*)'/)?.[1] ?? '';
        return { rows: [{ id: 'm1', seq: 1, role: 'user', content, attachments: params[2] ?? '[]', created_at: state.createdAt }] };
      }
      if (s.startsWith('SELECT round, dedup_key, record')) {
        // session transcript store 适配器 load(key)：按 transcript_key 取权威列，引擎侧推导 round/幂等。
        // 0.17.0 快路径（#193）下 appendUserTurn 不再走这里（只给回退路径与读侧镜像保留）。
        const rows = state.transcriptRows
          .filter((row) => row.transcriptKey === params[0])
          .map((row) => ({ round: row.round, dedup_key: row.dedupKey, record: row.record ?? null }));
        return { rows };
      }
      // 0.17.0 成对快路径探针（#193）：仍然只能出现在**同一事务 client** 的流水里。
      if (s.startsWith('SELECT record FROM transcript_rounds')) {
        const hit = state.transcriptRows.find(
          (row) => row.transcriptKey === params[0] && row.dedupKey === params[1],
        );
        return { rows: hit?.record != null ? [{ record: hit.record }] : [] };
      }
      if (s.startsWith('SELECT MAX(round)')) {
        const rounds = state.transcriptRows
          .filter((row) => row.transcriptKey === params[0])
          .map((row) => Number(row.round));
        return { rows: [{ max_round: rounds.length === 0 ? null : Math.max(...rounds) }] };
      }
      if (s.startsWith('INSERT INTO transcript_rounds')) {
        state.transcriptInsertAttempts += 1;
        const [transcriptKey, dedupKey, round, record, messages] = params;
        if (state.transcriptRows.some((row) => row.transcriptKey === transcriptKey && row.dedupKey === dedupKey)) {
          return { rows: [] };
        }
        state.transcriptRows.push({
          transcriptKey,
          dedupKey,
          round,
          record: JSON.parse(record),
          messages: JSON.parse(messages),
        });
        return { rows: [{ id: `tr-${state.transcriptRows.length}` }] };
      }
      // 首条消息默认标题落库：WHERE 守卫与真实 SQL 同语义（title 非空 / 非 auto → 0 行）。
      if (s.startsWith('UPDATE chat_sessions SET title =')) {
        if (String(state.title ?? '').trim() !== '' || state.title_source !== 'auto') return { rows: [] };
        state.title = params[1];
        return { rows: [{ title: params[1] }] };
      }
      if (s.startsWith('INSERT INTO runs')) return { rows: [{ id: 'r1', status: 'queued' }] };
      if (s.startsWith('INSERT INTO run_queue')) return { rows: [] };
      if (s.startsWith('UPDATE messages SET run_id')) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release() {},
  };
  return { pool: { connect: async () => client }, order, state };
}

/** 从 SQL 日志里取「默认标题落库」语句（无则 undefined）。 */
const titleStmt = (order) => order.find((e) => e.sql.replace(/\s+/g, ' ').startsWith('UPDATE chat_sessions SET title ='));

async function runPostMessage(opts = {}, msgOpts = {}) {
  const { pool, order, state } = postMessageClient(opts);
  const titles = [];
  const posted = await postMessage(pool, {
    userId: 'u1',
    sessionId: PM_SESSION_ID,
    content: msgOpts.content ?? 'hi',
    attachments: [],
    onSessionTitle: (t) => titles.push(t),
  });
  return { posted, order, state, titles };
}

test('issue #114：首条消息 >30 字 → 标题 = 前 30 字 + `…`（零 LLM），COMMIT 后回调推送一次', async () => {
  const content = '帮我把这个仓库的登录页面白屏问题彻底修复掉并且补上回归测试用例';
  assert.ok(Array.from(content).length > AUTO_TITLE_MAX_LEN, '用例内容确实超 30 字');
  const { posted, order, state, titles } = await runPostMessage({}, { content });
  const stmt = titleStmt(order);
  assert.ok(stmt, '首条消息应写默认标题');
  assert.equal(stmt.params[1], `${Array.from(content).slice(0, AUTO_TITLE_MAX_LEN).join('')}…`);
  assert.equal(state.title, stmt.params[1]);
  assert.equal(state.title_source, 'auto', '默认标题不改 title_source（仍归自动流程可刷新）');
  assert.equal(posted.run.status, 'queued', '标题落库不影响建 run 契约');
  // 推送在 COMMIT 之后（绝不先于落库到达客户端）
  const iCommit = order.findIndex((e) => e.sql === 'COMMIT');
  assert.ok(iCommit !== -1 && order.indexOf(stmt) < iCommit, '标题 UPDATE 在事务内');
  assert.deepEqual(titles, [stmt.params[1]], 'COMMIT 后回调一次新标题（供 SSE 推送）');
});

test('P3 PR②a（0.15.0 appendUserTurn）：POST 在同一事务内先写 transcript 再入队，round/record 与 runner 预写形态一致', async () => {
  const content = '来自 POST 入参的用户文本';
  const { pool, order, state } = postMessageClient({ existingRounds: [2, 7, 4] });
  const posted = await postMessage(pool, {
    userId: 'u1',
    sessionId: PM_SESSION_ID,
    content,
    attachments: [{ kind: 'file', path: '/repo/readme.md', name: 'readme.md' }],
  });
  const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();
  const messageInsert = order.findIndex(({ sql }) => normalize(sql).startsWith('INSERT INTO messages'));
  // 0.17.0 快路径（#193）：store 在事务内的读点 = dedupKey 点查 + MAX(round) 两点查，全量 load 不再出现。
  const storeProbe = order.findIndex(({ sql }) => normalize(sql).startsWith('SELECT record FROM transcript_rounds'));
  const storeLoad = order.findIndex(({ sql }) => normalize(sql).startsWith('SELECT round, dedup_key, record'));
  const transcriptInsert = order.findIndex(({ sql }) => normalize(sql).startsWith('INSERT INTO transcript_rounds'));
  const runQueueInsert = order.findIndex(({ sql }) => normalize(sql).startsWith('INSERT INTO run_queue'));
  const begin = order.findIndex(({ sql }) => sql === 'BEGIN');
  const commit = order.findIndex(({ sql }) => sql === 'COMMIT');

  assert.ok(begin < messageInsert && messageInsert < storeProbe && storeProbe < transcriptInsert);
  assert.ok(transcriptInsert < runQueueInsert && runQueueInsert < commit, 'transcript INSERT 位于入队之前且同属提交事务');
  assert.ok(begin < transcriptInsert && transcriptInsert < commit);
  // 预写与读取都只用传入的事务 client（同一连接：order 是单 client 的流水）。
  assert.equal(storeLoad, -1, '0.17.0 成对探针已接入 → 事务内不得再出现全量 load SELECT');
  assert.equal(order.filter(({ sql }) => normalize(sql).startsWith('SELECT record FROM transcript_rounds')).length, 1,
    'appendUserTurn 只点查一次，且与业务写入同一事务连接');
  assert.equal(order.filter(({ sql }) => normalize(sql).startsWith('SELECT MAX(round)')).length, 1,
    '未命中后取一次 MAX(round)');
  assert.equal(state.transcriptRows.length, 4);
  assert.equal(posted.run.status, 'queued');

  const insert = order[transcriptInsert];
  const sql = normalize(insert.sql);
  assert.match(sql, /VALUES \(NULL, \$1, \$2, \$3, \$4, false, \$5, NULL\)/);
  assert.match(sql, /ON CONFLICT \(transcript_key, dedup_key\) WHERE transcript_key IS NOT NULL DO NOTHING/);
  assert.deepEqual(order[storeProbe].params, [PM_SESSION_ID, `${PM_SESSION_ID}:input:m1`],
    '点查只取本 session key + 该 messageId 的 dedupKey');
  assert.deepEqual(insert.params.slice(0, 3), [PM_SESSION_ID, `${PM_SESSION_ID}:input:m1`, 7]);
  const userMessageInsert = order[messageInsert];
  // P3 PR②b B2（写入点①）：用户行的 `content` 恒为空串字面量（正文不再写进 messages），
  // 入参只剩 锚点元数据（session_id/seq/attachments）。
  assert.match(normalize(userMessageInsert.sql), /VALUES \(\$1, \$2, 'user', '', \$3\)/);
  assert.equal(userMessageInsert.params.length, 3, '用户输入文本不再作为 messages INSERT 的参数');
  assert.equal(userMessageInsert.params[2], JSON.stringify([{ kind: 'file', path: '/repo/readme.md', name: 'readme.md' }]));
  assert.ok(!JSON.stringify(userMessageInsert.params).includes(content), '用户正文不得出现在锚点行参数里');
  assert.equal(posted.message.content, content, '202 响应体回显请求正文（前端气泡渲染依赖）');
  const expectedMessages = [{ role: 'user', content: [{ type: 'text', text: content }] }];
  const record = JSON.parse(insert.params[3]);
  assert.deepEqual(record, {
    round: 7,
    roundKey: `${PM_SESSION_ID}:input:m1`,
    dedupKey: `${PM_SESSION_ID}:input:m1`,
    messages: expectedMessages,
    ts: record.ts,
  });
  assert.equal(typeof record.ts, 'string');
  assert.equal(new Date(record.ts).toISOString(), record.ts);
  assert.deepEqual(JSON.parse(insert.params[4]), expectedMessages);
  assert.equal(state.transcriptRows.at(-1).round, 7, 'round 由引擎 appendUserTurn 从 loadMaxRound 结果复用现有 max(round)');
});

test('P3 PR②a：重放相同 transcript INSERT 时，部分唯一冲突使 transcript 只保留一行', async () => {
  const { pool, order, state } = postMessageClient();
  await postMessage(pool, {
    userId: 'u1',
    sessionId: PM_SESSION_ID,
    content: '重放文本',
    attachments: [],
  });
  const transcriptWrite = order.find(({ sql }) => sql.includes('INSERT INTO transcript_rounds'));
  const client = await pool.connect();
  await client.query(transcriptWrite.sql, transcriptWrite.params);
  client.release();

  assert.equal(state.transcriptInsertAttempts, 2);
  assert.equal(state.transcriptRows.length, 1);
  assert.ok(order.filter(({ sql }) => sql.includes('INSERT INTO transcript_rounds'))
    .every(({ sql }) => /ON CONFLICT \(transcript_key, dedup_key\) WHERE transcript_key IS NOT NULL DO NOTHING/.test(sql)));
});

test('0.17.0 appendUserTurn：点查命中同 dedupKey 时引擎直接判幂等，不再发第二笔 INSERT、也不再取 MAX(round)', async () => {
  // 崩溃重跑/顺序重放语义：同 messageId 的预写在 store 已有同 dedupKey 记录时 written=false，
  // 引擎不发 appendRound（DB 的 ON CONFLICT 只作并发防线，不再是幂等主判据）。
  const { pool, order, state } = postMessageClient();
  await postMessage(pool, {
    userId: 'u1', sessionId: PM_SESSION_ID, content: '首轮文本', attachments: [],
  });
  // 同一 fake client 再发一次：messages INSERT 仍返回同一 messageId（m1）→ dedupKey 相同。
  await postMessage(pool, {
    userId: 'u1', sessionId: PM_SESSION_ID, content: '首轮文本', attachments: [],
  });

  assert.equal(state.transcriptInsertAttempts, 1, '第二次 postMessage 因 appendUserTurn 幂等判据命中，不发起 INSERT');
  assert.equal(state.transcriptRows.length, 1);
  const n = (prefix) => order.filter(({ sql }) => sql.replace(/\s+/g, ' ').trim().startsWith(prefix)).length;
  assert.equal(n('SELECT record FROM transcript_rounds'), 2, '两次调用各点查一次（幂等判据读自同一事务连接）');
  assert.equal(n('SELECT MAX(round)'), 1, '第二次点查即命中→不再取 MAX(round)');
  assert.equal(n('SELECT round, dedup_key, record'), 0, '全程零全量 load');
});

test('0.15.0 appendUserTurn：空 transcript 首轮预写 round=0，有历史轮时复用现有最大 round（不 +1）', async () => {
  const roundFor = async (existingRounds) => {
    const { pool, order } = postMessageClient({ existingRounds });
    await postMessage(pool, {
      userId: 'u1', sessionId: PM_SESSION_ID, content: '新输入', attachments: [],
    });
    const insert = order.find(({ sql }) => sql.replace(/\s+/g, ' ').trim().startsWith('INSERT INTO transcript_rounds'));
    return insert.params[2];
  };
  assert.equal(await roundFor([]), 0, '空 transcript：种子路径 round=0');
  assert.equal(await roundFor([0]), 0, '只有 round 0：复用它（引擎 resume 从最大 round 续起，预写不得 +1）');
  assert.equal(await roundFor([3, 1, 2]), 3, '多轮取最大');
});

test('issue #114：首条消息 ≤30 字 → 标题 = 原文（不加 `…`）', async () => {
  const { order, state, titles } = await runPostMessage({}, { content: '修复登录页白屏' });
  assert.equal(titleStmt(order).params[1], '修复登录页白屏');
  assert.equal(state.title, '修复登录页白屏');
  assert.deepEqual(titles, ['修复登录页白屏']);
});

test('issue #114：已有标题（title 非空）→ 幂等不动、不回调', async () => {
  const { order, titles } = await runPostMessage({ title: '我的标题' }, { content: '新的一条很长的用户消息内容超过三十个字符了吧' });
  assert.equal(titleStmt(order), undefined, '标题非空 → 不发 UPDATE');
  assert.deepEqual(titles, []);
});

test('issue #114：title_source=manual 且标题空 → 不动（手工优先守卫）', async () => {
  const { order, titles } = await runPostMessage({ title: '', title_source: 'manual' }, { content: '随便一条消息' });
  assert.equal(titleStmt(order), undefined, 'manual 行绝不写默认标题');
  assert.deepEqual(titles, []);
});

test('issue #114：ERIX_SESSION_AUTO_TITLE=0（开关关闭）→ 首条截断标题照样生效（解耦）', async () => {
  const prev = process.env.ERIX_SESSION_AUTO_TITLE;
  process.env.ERIX_SESSION_AUTO_TITLE = '0';
  try {
    const { order, titles } = await runPostMessage({}, { content: '修复登录页白屏' });
    assert.equal(titleStmt(order)?.params[1], '修复登录页白屏', '默认命名不读 #88 开关');
    assert.deepEqual(titles, ['修复登录页白屏']);
  } finally {
    if (prev === undefined) delete process.env.ERIX_SESSION_AUTO_TITLE;
    else process.env.ERIX_SESSION_AUTO_TITLE = prev;
  }
});

test('issue #114：并发抢占（UPDATE 命中 0 行）→ 不回调（安静放弃）', async () => {
  const { pool, order } = postMessageClient({ title: '', title_source: 'auto' });
  const client = await pool.connect();
  const origQuery = client.query.bind(client);
  // 让标题 UPDATE 恒返回 0 行（模拟事务外并发 PATCH 已置 manual/标题非空）
  client.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('UPDATE chat_sessions SET title =')) { order.push({ sql, params }); return { rows: [] }; }
    return origQuery(sql, params);
  };
  const titles = [];
  await postMessage({ connect: async () => client }, {
    userId: 'u1', sessionId: PM_SESSION_ID, content: 'hi', attachments: [], onSessionTitle: (t) => titles.push(t),
  });
  assert.deepEqual(titles, [], '0 行（被抢占）不推送');
});

// ---------------------------------------------------------------------------
// evaluateAutoTitle：fake pool 集成（消费 agent 上报 title，不发任何 HTTP）
// ---------------------------------------------------------------------------

const CFG = { sessionAutoTitle: true, sessionAutoTitleMinNew: 3 };

/** 可编排 fake pool：一张 chat_sessions 行 + messages 数组。 */
function titlePool({ session = {}, messages = [], transcriptRows = [] } = {}) {
  const queries = [];
  const sess = {
    id: 's1', user_id: 'u1', title: '', title_source: 'auto', cwd: '~/projects/demo',
    auto_title_seq: null, last_seq: 1, status: 'active', ...session,
  };
  // P3 PR②b B1：首条 / 最新 user 正文改走 session-text（锚点 + transcript 投影）。
  const anchored = messages.map((m, index) => ({
    id: m.id ?? `tu${index + 1}`,
    session_id: 's1',
    run_id: m.run_id ?? null,
    synthetic: false,
    attachments: [],
    ...m,
  }));
  const sessionText = createSessionTextHandler({ messages: anchored, transcriptRows, sessionId: 's1' });
  const pool = {
    queries,
    updates: [],
    anchoredMessages: anchored,
    async query(sql, params = []) {
      queries.push({ sql, params });
      const hit = sessionText(sql, params);
      if (hit) return hit;
      if (sql.startsWith('SELECT id, user_id, title, title_source')) {
        return { rows: sess.status === 'gone' ? [] : [{ ...sess }] };
      }
      if (sql.includes('count(*)::int')) {
        const n = anchored.filter((m) => m.role === 'user' && m.seq > params[1]).length;
        return { rows: [{ n }] };
      }
      if (sql.startsWith('UPDATE chat_sessions')) {
        // 模拟 DB 守卫：UPDATE 只写 title_source='auto' 的行
        if (sess.title_source !== 'auto') return { rows: [], rowCount: 0 };
        sess.title = params[1];
        sess.auto_title_seq = sess.last_seq;
        pool.updates.push({ title: params[1] });
        return { rows: [{}], rowCount: 1 };
      }
      return { rows: [] };
    },
  };
  return pool;
}

test('evaluateAutoTitle：agent 上报标题 → 清洗后落库（auto_title_seq 推进）+ SSE 通知', async () => {
  const pool = titlePool({
    messages: [{ role: 'user', content: '帮我修复登录页面的白屏问题', seq: 1 }],
  });
  const notified = [];
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', runId: 'r1', agentTitle: '「修复登录白屏」', config: CFG,
    notify: (sid, events) => notified.push({ sid, events }),
    log: { warn() {}, info() {} },
  });
  assert.equal(title, '修复登录白屏', '引号包裹被清洗');
  assert.equal(notified.length, 1, '标题更新经 SSE 推送');
  assert.equal(notified[0].events[0].type, 'session_updated');
  assert.equal(notified[0].events[0].payload.title, '修复登录白屏');
  assert.equal(pool.updates.length, 1, '落库一次');
});

test('evaluateAutoTitle：agent title 缺失/空串 → 降级首条用户消息截断', async () => {
  const long = '帮我修复登录页面的白屏问题并补充单元测试覆盖边界情况尤其会话过期'.repeat(2);
  const expected = Array.from(long.replace(/\s+/g, ' ').trim()).slice(0, AUTO_TITLE_MAX_LEN).join('');
  for (const agentTitle of ['', '   ', undefined, null]) {
    const pool = titlePool({ messages: [{ role: 'user', content: long, seq: 1 }] });
    const title = await evaluateAutoTitle(pool, {
      sessionId: 's1', agentTitle, config: CFG, log: { warn() {}, info() {} },
    });
    assert.equal(title, expected, `agentTitle=${JSON.stringify(agentTitle)} → 降级 = 首条消息截断 30 字符`);
  }
});

test('evaluateAutoTitle：agent title 超 30 字符 → 清洗截断后落库', async () => {
  const pool = titlePool({ messages: [{ role: 'user', content: '写个排序脚本', seq: 1 }] });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '长'.repeat(50), config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, '长'.repeat(AUTO_TITLE_MAX_LEN), 'agent 侧已清洗，portal 再过一遍幂等');
});

test('evaluateAutoTitle：agent title 不合规（仅空引号）且首条消息为空 → 末级降级 cwd basename', async () => {
  const pool = titlePool({
    session: { cwd: '~/projects/meeting_asr_app' },
    messages: [{ role: 'user', content: '   ', seq: 1 }],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '「」', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, 'meeting_asr_app', '末级降级 = cwd basename');
});

test('evaluateAutoTitle：manual 行绝不覆盖（并发手工 PATCH 语义）', async () => {
  const pool = titlePool({
    session: { title: '我手工起的名', title_source: 'manual' },
    messages: [{ role: 'user', content: '随便聊聊', seq: 9 }],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '新话题标题', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, null);
  assert.equal(pool.updates.length, 0, 'manual 行零 UPDATE');
});

test('evaluateAutoTitle：UPDATE 命中 0 行（评估期间被改 manual）→ 安静放弃、不推 SSE', async () => {
  // 模拟竞态：SELECT 时还是 auto，UPDATE 时被并发 PATCH 置 manual → rowCount=0。
  const pool = titlePool({
    messages: [{ role: 'user', content: '修 bug', seq: 1 }],
  });
  const orig = pool.query.bind(pool);
  pool.query = async (sql, params) => {
    if (sql.startsWith('UPDATE chat_sessions')) {
      // 并发 PATCH 已提交：本 UPDATE 的 WHERE title_source='auto' 不再命中
      return { rows: [], rowCount: 0 };
    }
    return orig(sql, params);
  };
  const notified = [];
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '修 bug', config: CFG,
    notify: (sid, events) => notified.push(events),
    log: { warn() {}, info() {} },
  });
  assert.equal(title, null, '0 行视为未更新');
  assert.equal(notified.length, 0, '不推 session_updated');
});

test('evaluateAutoTitle：防抖——未到 N 轮且话题未漂移 → 不刷新', async () => {
  const pool = titlePool({
    session: { title: '修复登录 bug', auto_title_seq: 5, last_seq: 7 },
    messages: [
      { role: 'user', content: '修复登录 bug', seq: 1 },
      { role: 'user', content: '登录页颜色再调下', seq: 7 }, // 与标题有重合（登录）
    ],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '全新标题', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, null);
  assert.equal(pool.updates.length, 0);
});

test('evaluateAutoTitle：≥N 轮新 user 消息 → 刷新（即使话题相关）', async () => {
  const pool = titlePool({
    session: { title: '修复登录 bug', auto_title_seq: 5, last_seq: 8 },
    messages: [
      { role: 'user', content: '修复登录 bug', seq: 1 },
      { role: 'user', content: '登录页补充日志', seq: 6 },
      { role: 'user', content: '登录报错处理', seq: 7 },
      { role: 'user', content: '登录页收尾', seq: 8 },
    ],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '登录页优化', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, '登录页优化');
  assert.equal(pool.updates.length, 1);
});

test('evaluateAutoTitle：开关关闭（ERIX_SESSION_AUTO_TITLE=0）→ no-op', async () => {
  const pool = titlePool({ messages: [{ role: 'user', content: 'hi', seq: 1 }] });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: 'hi', config: { sessionAutoTitle: false, sessionAutoTitleMinNew: 3 },
    log: { warn() {}, info() {} },
  });
  assert.equal(title, null);
  assert.equal(pool.queries.length, 0, '开关关闭时连 DB 都不查');
});

test('evaluateAutoTitle：会话已归档/不存在 → 安静跳过', async () => {
  const pool = titlePool({ session: { status: 'gone' }, messages: [{ role: 'user', content: 'hi', seq: 1 }] });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: 'hi', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, null);
});

test('evaluateAutoTitle：评估链抛错（DB 故障）→ 吞掉返回 null，不向上抛', async () => {
  const pool = { query: async () => { throw new Error('db down'); } };
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: 'hi', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, null);
});

// ---------------------------------------------------------------------------
// P3 PR②b B1 ②③：自动标题降级链（首条）与话题漂移启发式（最新）的取数来源 = transcript 投影
// ---------------------------------------------------------------------------

test('P3 PR②b ②：降级链首条 user 正文取自 transcript（锚点正文只作 legacy 兜底）', async () => {
  const pool = titlePool({
    messages: [{ role: 'user', content: '锚点旧标题文本', seq: 1 }],
    transcriptRows: [inputTranscriptRow({ sessionId: 's1', messageId: 'tu1', text: 'transcript 首条正文', round: 1 })],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, 'transcript 首条正文', '首条正文取自 transcript，不是 messages.content');
  assert.equal(pool.updates.length, 1);
});

test('P3 PR②b ③：话题漂移启发式用 transcript 的最新 user 正文（transcript 与锚点不同 → 以 transcript 判漂移）', async () => {
  // 现标题与**锚点**正文关键词重合（若仍读 messages.content → 判「未漂移」→ 不刷新），
  // 但 transcript 里的最新正文是全新话题 → 读 transcript 才判出漂移并刷新。
  const pool = titlePool({
    session: { title: '修复登录 bug', auto_title_seq: 5, last_seq: 6 },
    messages: [
      { role: 'user', content: '修复登录 bug', seq: 1 },
      { role: 'user', content: '登录页收尾', seq: 6 }, // 与标题重合（锚点侧）
    ],
    transcriptRows: [
      inputTranscriptRow({ sessionId: 's1', messageId: 'tu2', text: '数据库迁移脚本评审', round: 2 }),
    ],
  });
  const title = await evaluateAutoTitle(pool, {
    sessionId: 's1', agentTitle: '', config: CFG, log: { warn() {}, info() {} },
  });
  assert.equal(title, '修复登录 bug', `刷新后降级标题 = 首条 transcript/锚点正文（got ${title}）`);
  assert.equal(pool.updates.length, 1, 'transcript 最新正文与标题零重合 → 判漂移 → 刷新（读锚点则不会刷新）');
});
