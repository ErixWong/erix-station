// #451：`session.compaction` —— 引擎 `compactionStats` 的观测面（零 DDL、读侧聚合）。
//
// 动机（真库现查，2026-11）：全库 82 条带 `compactionStats` 的轮记录里 TTL 层 `triggered=75`、
// `tokensSaved=314518`，而两版台账都写着「TTL 未触发」——因为判据看的是 `compaction` 事件，
// 而 **TTL 层不发那个事件**，只写 `compactionStats`。本文件钉住读侧聚合的五条判据：
//   ① 真形状（两轮两层的汇总值）     ② 键缺席而非零
//   ③ 全零层不列                     ④ 脏数据不炸（HTTP 200）
//   ⑤ 成本红线（transcript_rounds 只查一次）
// 隔离约定（docs/testing.md §2.1）：注入内存 fake pool，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as auth from '../src/auth.js';
import { getSession } from '../src/sessions.js';
import {
  COMPACTION_LAYER_IDS, aggregateCompactionStats, collectTranscriptFacts,
} from '../src/session-view.js';
import { FakePool } from './fake-pool.js';

const USER = {
  id: '00000000-0000-4000-8000-0000000000a1', login: 'alice', display_name: 'alice',
  role: 'fde', fde_name: 'alice', auth_source: 'local', status: 'active',
};
const SESSION_ID = 'c0ffee00-1111-4111-8111-abcdefabcdef';
const TOKEN = 'tok-compaction-stats-test';
const at = (second) => new Date(Date.UTC(2026, 10, 1, 0, 0, second));
const text = (value) => [{ type: 'text', text: value }];

/**
 * 引擎真形状的 `compactionStats` 条目（真库核过：`layers` 六个键**全在**，
 * 没触发的层是 `{triggered:0, tokensSaved:0}`，不是缺席）。
 */
function statsEntry(layers = {}) {
  const full = Object.fromEntries(COMPACTION_LAYER_IDS.map((id) => [id, { triggered: 0, tokensSaved: 0 }]));
  for (const [id, value] of Object.entries(layers)) full[id] = value;
  return {
    compacted: Object.values(full).some((layer) => layer.triggered > 0),
    foldedRounds: 0,
    tokensBefore: 1000,
    tokensAfter: 500,
    layers: full,
  };
}

/** 一条 transcript 行（真列名形状：`run_id`/`round`/`dedup_key`/`record`/`created_at`）。 */
function transcriptRow(round, record) {
  return {
    run_id: null,
    round,
    dedup_key: `${SESSION_ID}:engine:round:${round}`,
    record: { roundKey: `${SESSION_ID}:round:${round}`, dedupKey: `${SESSION_ID}:engine:round:${round}`, ...record },
    created_at: at(round),
  };
}

/** 只带 compactionStats 的轮行（聚合用；不需要正文）。 */
const statsRow = (round, ...entries) => transcriptRow(round, { compactionStats: entries });

/** 一条用户锚点（`getSession` 只有在 anchors 非空时才会去读 transcript_rounds）。 */
function anchorRow(seq = 1) {
  return {
    id: 'm1', run_id: null, seq, role: 'user', content: '第一句',
    synthetic: false, attachments: [], created_at: at(1),
  };
}

/** `getSession` 用到的 SQL 面（其余落回 FakePool：默认 `{rows: []}`）。 */
class CompactionPool extends FakePool {
  constructor({ anchors = [anchorRow()], transcriptRows = [] } = {}) {
    super({ users: [USER] });
    this.anchors = anchors;
    this.transcriptRows = transcriptRows;
    this.sqlLog = [];
  }

  async query(sql, params = []) {
    this.sqlLog.push(sql);
    if (sql.includes('FROM chat_sessions s')) {
      return {
        rows: [{
          id: SESSION_ID,
          user_id: USER.id,
          project_id: null,
          cwd: '~/projects/demo',
          title: 'compress me',
          title_source: 'auto',
          model: null,
          status: 'active',
          last_seq: 9,
          message_count: this.anchors.length,
        }],
      };
    }
    if (sql.includes('FROM messages') && sql.includes("role = 'user'")) {
      return {
        rows: this.anchors
          .filter((anchor) => anchor.role === 'user')
          .map(({ id, run_id, seq, synthetic, content, created_at }) => ({
            id, run_id, seq, synthetic, anchor_text: content, created_at,
          })),
      };
    }
    if (sql.includes('FROM messages')) {
      return { rows: this.anchors.filter((anchor) => anchor.seq < (params[2] ?? Infinity)) };
    }
    if (sql.includes('FROM transcript_rounds')) {
      return { rows: this.transcriptRows };
    }
    if (sql.includes('FROM runs')) return { rows: [] };
    if (sql.includes('FROM tool_calls')) return { rows: [] };
    return super.query(sql, params);
  }
}

// ---------------------------------------------------------------------------
// 纯函数层：aggregateCompactionStats / collectTranscriptFacts
// ---------------------------------------------------------------------------

test('#451 判据 1（真形状）：两轮两层 ⇒ rounds=2 / layers.ttl.triggered=1 / tokensSaved=4885 / lastRound=2', () => {
  const { compaction, skipped } = aggregateCompactionStats([
    statsRow(1, statsEntry({ ttl: { triggered: 1, tokensSaved: 3985 } })),
    statsRow(2, statsEntry({ slidingWindow: { triggered: 1, tokensSaved: 900 } })),
  ]);
  assert.equal(skipped, 0);
  assert.deepEqual(compaction, {
    rounds: 2,
    layers: {
      ttl: { triggered: 1, tokensSaved: 3985 },
      slidingWindow: { triggered: 1, tokensSaved: 900 },
    },
    tokensSaved: 4885,
    lastRound: 2,
  });
});

test('#451 判据 2（键缺席而非零）：一条 compactionStats 都没有 ⇒ compaction === null（不是 {} / 不是全零对象）', () => {
  const { compaction } = aggregateCompactionStats([
    transcriptRow(1, { messages: [{ role: 'assistant', content: text('普通轮') }] }),
    transcriptRow(2, { folded: true, summary: { action: 'x', note: 'y' } }),
  ]);
  assert.equal(compaction, null, '没有统计 ⇒ 整个键不给');
  // 反向自证：`{}` 与全零对象都**不是**本函数会返回的形状（变异 1 的靶子）
  assert.notDeepEqual(compaction, {});
  assert.notDeepEqual(compaction, { rounds: 0, layers: {}, tokensSaved: 0, lastRound: null });
});

test('#451 判据 3（全零层不列）：foldLlm.triggered === 0 ⇒ layers 里没有 foldLlm 键', () => {
  const { compaction } = aggregateCompactionStats([
    statsRow(3, statsEntry({
      ttl: { triggered: 2, tokensSaved: 100 },
      foldLlm: { triggered: 0, tokensSaved: 0 },
    })),
  ]);
  assert.deepEqual(Object.keys(compaction.layers), ['ttl']);
  assert.equal('foldLlm' in compaction.layers, false, '零层不列，不是列个 0');
  assert.equal('anchors' in compaction.layers, false);
  assert.equal(compaction.tokensSaved, 100, '全零层不进 tokensSaved 求和');
});

test('#451：按数组遍历（不假设 length === 1）——同一轮两条 stats 都算，rounds 仍按轮号去重', () => {
  const { compaction } = aggregateCompactionStats([
    statsRow(4,
      statsEntry({ ttl: { triggered: 1, tokensSaved: 40 } }),
      statsEntry({ enforceSize: { triggered: 1, tokensSaved: 60 } })),
  ]);
  assert.equal(compaction.rounds, 1, '同一轮两条只算一轮');
  assert.deepEqual(compaction.layers, {
    ttl: { triggered: 1, tokensSaved: 40 },
    enforceSize: { triggered: 1, tokensSaved: 60 },
  });
  assert.equal(compaction.tokensSaved, 100);
  assert.equal(compaction.lastRound, 4);
});

test('#451 判据 4（脏数据不炸，纯函数层）：四种脏形态逐条跳过并计数，其余轮照常汇总', () => {
  const clean = statsEntry({ ttl: { triggered: 1, tokensSaved: 500 } });
  const dirty = [
    transcriptRow(1, { compactionStats: 'oops' }),                        // 不是数组
    transcriptRow(2, { compactionStats: [statsEntry(), null] }),          // 条目不是对象
    transcriptRow(3, { compactionStats: [{ ...clean, layers: null }] }),  // layers 缺失
    transcriptRow(4, { compactionStats: [statsEntry({ ttl: { triggered: 'abc', tokensSaved: 1 } })] }),
    transcriptRow(5, { compactionStats: [statsEntry({ ttl: { triggered: 1, tokensSaved: -5 } })] }),
    statsRow(6, clean),                                                   // 唯一一条干净的
  ];
  const { compaction, skipped } = aggregateCompactionStats(dirty);
  assert.equal(skipped, 5, '五条脏（含 layers:null 与 -5）逐条计数');
  assert.deepEqual(compaction, {
    rounds: 1,
    layers: { ttl: { triggered: 1, tokensSaved: 500 } },
    tokensSaved: 500,
    lastRound: 6,
  });
});

test('#451：`collectTranscriptFacts` 一趟扫描同时产出折叠事实与压缩聚合（两者互不污染）', () => {
  const facts = collectTranscriptFacts([
    transcriptRow(1, {
      folded: true,
      summary: { action: 'fold', note: '真摘要' },
      foldedFacts: { text: '折叠替代物', source: 'llm' },
      compactionStats: [statsEntry({ ttl: { triggered: 1, tokensSaved: 7 } })],
    }),
  ]);
  assert.deepEqual([...facts.roundsWithRealSummary], [1]);
  assert.deepEqual([...facts.foldedFactsByRound.keys()], [1]);
  assert.deepEqual(facts.compaction.layers, { ttl: { triggered: 1, tokensSaved: 7 } });
  assert.equal(facts.skippedCompactionEntries, 0);
});

// ---------------------------------------------------------------------------
// DTO 层：GET /api/sessions/:id 的 session.compaction
// ---------------------------------------------------------------------------

test('#451 DTO：session.compaction 汇总真形状（判据 1）', async () => {
  const pool = new CompactionPool({
    transcriptRows: [
      statsRow(1, statsEntry({ ttl: { triggered: 1, tokensSaved: 3985 } })),
      statsRow(2, statsEntry({ slidingWindow: { triggered: 1, tokensSaved: 900 } })),
    ],
  });
  const result = await getSession(pool, { userId: USER.id, sessionId: SESSION_ID, limit: 20 });
  assert.deepEqual(result.session.compaction, {
    rounds: 2,
    layers: {
      ttl: { triggered: 1, tokensSaved: 3985 },
      slidingWindow: { triggered: 1, tokensSaved: 900 },
    },
    tokensSaved: 4885,
    lastRound: 2,
  });
});

test('#451 DTO 判据 2：没有任何 compactionStats ⇒ session 上**没有** compaction 键', async () => {
  const pool = new CompactionPool({
    transcriptRows: [transcriptRow(1, { messages: [{ role: 'assistant', content: text('无压缩') }] })],
  });
  const result = await getSession(pool, { userId: USER.id, sessionId: SESSION_ID, limit: 20 });
  assert.equal('compaction' in result.session, false, '键缺席（不是 {} / 不是全零对象）');
  assert.equal(JSON.stringify(result.session).includes('compaction'), false, '序列化后也一个字节都没有');
});

test('#451 DTO 判据 3：全零层不出现在 DTO 的 layers 里', async () => {
  const pool = new CompactionPool({
    transcriptRows: [statsRow(1, statsEntry({
      ttl: { triggered: 3, tokensSaved: 300 },
      foldLlm: { triggered: 0, tokensSaved: 0 },
    }))],
  });
  const result = await getSession(pool, { userId: USER.id, sessionId: SESSION_ID, limit: 20 });
  assert.deepEqual(Object.keys(result.session.compaction.layers), ['ttl']);
});

test('#451 判据 5（成本红线）：一次 getSession 对 transcript_rounds 只查一次（与改动前相同）', async () => {
  const pool = new CompactionPool({
    transcriptRows: [statsRow(1, statsEntry({ ttl: { triggered: 1, tokensSaved: 1 } }))],
  });
  await getSession(pool, { userId: USER.id, sessionId: SESSION_ID, limit: 20 });
  const transcriptQueries = pool.sqlLog.filter((sql) => sql.replace(/\s+/g, ' ').includes('FROM transcript_rounds'));
  assert.equal(transcriptQueries.length, 1, '聚合并入既有的那一次扫描，不许另起一笔');
  // 整条读取链的查询数一并钉住：任何「为聚合多打一条 SQL」的改动都会在这里红。
  // 5 = chat_sessions / messages / user 锚点 / transcript_rounds / runs
  // （tool_calls 那条只在锚点带 run_id 时才发，本用例的锚点 run_id 为 null ⇒ 不发）。
  assert.equal(pool.sqlLog.length, 5, `读取链共 5 条 SQL，实得 ${pool.sqlLog.length}`);
});

// ---------------------------------------------------------------------------
// HTTP 层：脏数据不许把会话 DTO 打成 500（判据 4）
// ---------------------------------------------------------------------------

async function startServer(pool) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-compaction-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SECRET_INDEX');
  const config = {
    cookie: cookieSettings('dev-http', 604800),
    sessionTtlSeconds: 604800,
    sessionRenewIntervalSeconds: 3600,
    pendingTokenTtlSeconds: 120,
    totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
    loginRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, maxEntries: 10000 },
    totpRateLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000, blockMs: 60 * 1000, perTokenMaxFailures: 5, maxEntries: 10000 },
    kdfConcurrency: 2,
    kdfQueueLimit: 100,
    kdfQueueTimeoutMs: 30000,
    maxBodyBytes: 64 * 1024,
    maxLoginLength: 128,
    maxPasswordLength: 256,
    staticDir,
  };
  pool.sessions.push({
    id: 'ls1', user_id: USER.id, token_hash: auth.hashToken(TOKEN),
    created_at: new Date(), expires_at: new Date(Date.now() + 86_400_000), last_seen_at: new Date(), revoked_at: null,
  });
  const server = createServer({ pool, config });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    cookieHeader: `${config.cookie.name}=${TOKEN}`,
    close: async () => {
      await new Promise((res) => server.close(res));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

test('#451 判据 4（HTTP）：四种脏形态都不许把会话详情打成 500，干净轮照常汇总', async () => {
  const pool = new CompactionPool({
    transcriptRows: [
      transcriptRow(1, { compactionStats: 'oops' }),
      transcriptRow(2, { compactionStats: [{ layers: null }] }),
      transcriptRow(3, { compactionStats: [statsEntry({ ttl: { triggered: 'abc', tokensSaved: 1 } })] }),
      transcriptRow(4, { compactionStats: [statsEntry({ ttl: { triggered: 1, tokensSaved: -5 } })] }),
      statsRow(5, statsEntry({ ttl: { triggered: 2, tokensSaved: 400 } })),
    ],
  });
  const s = await startServer(pool);
  try {
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200, '脏轮记录不许把整个 DTO 打成 500');
    const body = await res.json();
    assert.deepEqual(body.session.compaction, {
      rounds: 1,
      layers: { ttl: { triggered: 2, tokensSaved: 400 } },
      tokensSaved: 400,
      lastRound: 5,
    });
  } finally {
    await s.close();
  }
});

test('#451（HTTP）：健康会话照常带 compaction；没有统计的会话整键缺席', async () => {
  const clean = new CompactionPool({
    transcriptRows: [statsRow(7, statsEntry({ ttl: { triggered: 1, tokensSaved: 3985 } }))],
  });
  const s = await startServer(clean);
  try {
    const res = await fetch(`${s.base}/api/sessions/${SESSION_ID}`, { headers: { Cookie: s.cookieHeader } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.session.compaction.tokensSaved, 3985);
    assert.equal(body.session.compaction.lastRound, 7);
  } finally {
    await s.close();
  }

  const bare = new CompactionPool({ transcriptRows: [transcriptRow(1, {})] });
  const s2 = await startServer(bare);
  try {
    const res = await fetch(`${s2.base}/api/sessions/${SESSION_ID}`, { headers: { Cookie: s2.cookieHeader } });
    assert.equal(res.status, 200);
    assert.equal('compaction' in (await res.json()).session, false);
  } finally {
    await s2.close();
  }
});
