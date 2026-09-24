// 迁移纪律测试（deploy/migrations/README.md + deploy-contract §3.2）：baseline 冻结、增量可重放。
// 0006（issue #81 P2）：session-scoped transcript——既有表加列 + 部分唯一索引（非新表），
// 全部语句幂等（IF NOT EXISTS / ALTER COLUMN 幂等），单事务由迁移 runner 保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('迁移 0006-session-transcript：文件存在、编号连续、语句全部幂等（可重放）', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  const nums = files.map((f) => Number(f.slice(0, 4)));
  // 编号连续无空洞（顺序 = 文件名升序，README 约定）
  nums.forEach((n, i) => assert.equal(n, i + 1, `迁移编号空洞：${files.join(', ')}`));
  assert.ok(files.includes('0006-session-transcript.sql'));

  const sql = fs.readFileSync(path.join(dir, '0006-session-transcript.sql'), 'utf8');
  const statements = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('--'));
  assert.ok(statements.length >= 6, `语句数异常：${statements.length}`);
  for (const stmt of statements) {
    const head = stmt.replace(/^--[^\n]*\n/g, '').trim().toUpperCase();
    assert.ok(
      head.startsWith('ALTER TABLE') || head.startsWith('CREATE UNIQUE INDEX') || head.startsWith('CREATE INDEX'),
      `0006 只允许 ALTER/CREATE INDEX（单事务幂等 DDL），发现：${head.slice(0, 60)}`,
    );
    if (head.startsWith('CREATE')) {
      assert.ok(head.includes('IF NOT EXISTS'), `CREATE 必须 IF NOT EXISTS：${head.slice(0, 60)}`);
    }
  }

  // 关键语义锚点：session 三件套（rounds 键/dedup 唯一/checkpoint 键/runstate 列）
  assert.ok(sql.includes('ALTER COLUMN run_id DROP NOT NULL'), 'transcript_rounds.run_id 解除 NOT NULL');
  assert.ok(sql.includes('transcript_rounds_session_dedup_uidx'), '(transcript_key, dedup_key) 部分唯一索引');
  assert.ok(sql.includes('run_checkpoints_session_uidx'), 'run_checkpoints transcript_key 唯一索引');
  assert.ok(sql.includes('engine_run_state jsonb'), 'chat_sessions.engine_run_state 列');
});

test('baseline 冻结：docs/data/schema.sql 不含 0006 的列（DDL 只走增量文件）', () => {
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('transcript_key'), 'baseline 不得回写 transcript_key');
  assert.ok(!baseline.includes('engine_run_state'), 'baseline 不得回写 engine_run_state');
});
