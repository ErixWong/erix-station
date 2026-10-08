// 0.16.0「同 round 保序」读取点收敛护栏（issue #26 追加项）。
// 背景：erix-agent 0.16.0 store 契约（host-upgrade-guide-0.16.0 §1）要求同 (transcript_key, round)
// 多行按**持久化追加序**（append_seq，迁移 0016；恒非空）返回，引擎不再二次排序；真库存在
// created_at 完全相同的同 round 行，created_at 排序不确定。
// 本文件锁定两类回归防线：
//   ① 源码级：所有 transcript_rounds 多行读 SQL 必须 ORDER BY … append_seq（正则对源码，
//      同 migrations.test.js 对迁移文件的断言先例）；
//   ② 行为级：fake-session-text 的整会话 transcript 分支（镜像 sessions.js / session-text.js
//      的 SQL）在同 round + created_at 相同的情况下按 append_seq 返回。
// 隔离约定（docs/testing.md §2.1）：内存 fake，不碰真实 DB。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTextContext } from '../src/session-text.js';
import { createSessionTextHandler } from './fake-session-text.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(HERE, '../src', rel), 'utf8');

// ① 源码级护栏：点名的多行读路径全部按 append_seq 保序（0.16.0 契约 / 迁移 0016）。
const ORDERED_READS = [
  // [文件, 定位片段（唯一锚点）, 期望排序子句]
  ['transcript-store.js', 'SELECT round, dedup_key, record', /ORDER BY round, append_seq/],
  ['sessions.js', 'SELECT run_id, round, dedup_key, record, created_at', /ORDER BY round ASC, append_seq ASC/],
  ['session-text.js', 'SELECT run_id, round, dedup_key, record, created_at', /ORDER BY round ASC, append_seq ASC/],
  ['internal.js', 'SELECT round, record, folded_payload FROM transcript_rounds', /ORDER BY round ASC, append_seq ASC LIMIT 2000/],
  // 上游 worker 已改的引擎读路径一并上锁，防止后续回退。
  ['internal.js', 'WHERE run_id = $1 AND round > $2', /ORDER BY round ASC, append_seq ASC LIMIT \$3/],
  ['internal.js', 'WHERE transcript_key = \$1 AND round > \$2', /ORDER BY round ASC, append_seq ASC/],
];

test('0.16.0 同 round 保序：所有 transcript_rounds 多行读 SQL 按 append_seq 排序', () => {
  for (const [file, anchor, expected] of ORDERED_READS) {
    const src = read(file);
    const idx = src.indexOf(anchor);
    assert.ok(idx >= 0, `${file} 应包含读取点「${anchor}」`);
    const window = src.slice(idx, idx + 400);
    assert.match(window, expected, `${file} 的读取点「${anchor}」必须按 append_seq 保序`);
  }
});

test('0.16.0 同 round 保序：src 中不存在按 created_at 排序的 transcript_rounds 读 SQL 残留', () => {
  for (const file of ['transcript-store.js', 'sessions.js', 'session-text.js', 'internal.js']) {
    const src = read(file);
    // 允许 SELECT 列里出现 created_at（展示字段），不允许其充当 transcript_rounds 排序键。
    assert.doesNotMatch(
      src,
      /FROM transcript_rounds[\s\S]{0,200}?ORDER BY[^\n]*created_at/,
      `${file}：transcript_rounds 读 SQL 不应再按 created_at 排序（同 round 行 created_at 可相同，顺序不确定）`,
    );
  }
});

test('transcript-store 头注释标注 0.16.0（appendUserTurn 消费面版本）', () => {
  const src = read('transcript-store.js');
  assert.match(src.split('\n')[0], /erix-agent 0\.16\.0/);
});

// ② 行为级护栏：镜像 sessions.js getSession / session-text.js TRANSCRIPT_SQL 的 fake，
//    同 round + 同 created_at 时按 append_seq 返回（数组序刻意与 append_seq 逆序）。
test('fake-session-text 整会话分支：同 round 行按 append_seq 返回，created_at 相同不构成歧义', async () => {
  const sessionId = '60000000-0000-4000-8000-000000000001';
  const sameInstant = new Date('2026-10-08T00:00:00Z');
  const row = (round, dedup, appendSeq) => ({
    transcript_key: sessionId, run_id: null, round, dedup_key: dedup,
    created_at: sameInstant, append_seq: appendSeq,
    record: { round, dedupKey: dedup, messages: [] },
  });
  const rows = [
    row(1, `${sessionId}:engine:round:1`, 102),
    row(0, `${sessionId}:input:m1`, 100),
    row(1, `${sessionId}:input:m2`, 101),
  ];
  const handle = createSessionTextHandler({ messages: [], transcriptRows: rows, sessionId });
  const pool = { async query(sql, params) { return handle(sql, params) ?? { rows: [] }; } };

  const ctx = await loadTextContext(pool, { sessionId });
  assert.deepEqual(
    ctx.transcriptRows.map((r) => r.dedup_key),
    [`${sessionId}:input:m1`, `${sessionId}:input:m2`, `${sessionId}:engine:round:1`],
    'round 升序、同 round 内按 append_seq（而非 created_at / 数组序：数组序里 engine 排在 m2 前）',
  );
});
