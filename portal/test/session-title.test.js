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
import { createSession, updateSession } from '../src/sessions.js';
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
// evaluateAutoTitle：fake pool 集成（消费 agent 上报 title，不发任何 HTTP）
// ---------------------------------------------------------------------------

const CFG = { sessionAutoTitle: true, sessionAutoTitleMinNew: 3 };

/** 可编排 fake pool：一张 chat_sessions 行 + messages 数组。 */
function titlePool({ session = {}, messages = [] } = {}) {
  const queries = [];
  const sess = {
    id: 's1', user_id: 'u1', title: '', title_source: 'auto', cwd: '~/projects/demo',
    auto_title_seq: null, last_seq: 1, status: 'active', ...session,
  };
  const pool = {
    queries,
    updates: [],
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT id, user_id, title, title_source')) {
        return { rows: sess.status === 'gone' ? [] : [{ ...sess }] };
      }
      if (sql.includes("FROM messages") && sql.includes("role = 'user'") && sql.includes('ORDER BY seq ASC LIMIT 1')) {
        const u = messages.filter((m) => m.role === 'user').sort((a, b) => a.seq - b.seq);
        return { rows: u[0] ? [{ content: u[0].content, seq: u[0].seq }] : [] };
      }
      if (sql.includes("FROM messages") && sql.includes("role = 'user'") && sql.includes('ORDER BY seq DESC LIMIT 1')) {
        const u = messages.filter((m) => m.role === 'user').sort((a, b) => b.seq - a.seq);
        return { rows: u[0] ? [{ content: u[0].content, seq: u[0].seq }] : [] };
      }
      if (sql.includes('count(*)::int')) {
        const n = messages.filter((m) => m.role === 'user' && m.seq > params[1]).length;
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
