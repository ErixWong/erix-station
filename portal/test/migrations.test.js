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

// 0008（P5 去项目化，docs/design/directory-as-project.md 定稿）：会话 cwd 绑定 + 端口分配去项目化。
test('迁移 0008-deprojectize：编号连续、语句幂等（可重放）、关键语义锚点齐全', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0008-deprojectize.sql'), '0008 存在');
  // 新迁移追加在序列末尾（README：编号连续无空洞）。
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 12, '0012 是最后编号（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0008-deprojectize.sql'), 'utf8');
  // 语句全部幂等（IF NOT EXISTS / 条件 UPDATE / IF EXISTS）。
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS cwd'), 'chat_sessions 加 cwd 列（幂等）');
  assert.ok(sql.includes('ALTER COLUMN project_id DROP NOT NULL'), 'project_id 解除 NOT NULL（留档）');
  assert.ok(sql.includes('DROP COLUMN IF EXISTS project_id'), 'port_allocations 退役 project_id（幂等）');
  assert.ok(sql.includes('SET cwd = p.root_path'), '回填 = projects.root_path 关联值');
  assert.ok(sql.includes('AND s.cwd IS NULL'), '回填只动 cwd IS NULL 行（可重放）');
  assert.ok(sql.includes('regexp_replace'), 'hostname/url 重写（保留 .fde.<base> 后缀，不硬编码域名）');
  // WHERE 子句保证重写幂等：重写后形态不再命中旧形态匹配。
  assert.match(sql, /WHERE a\.hostname ~ '\^\[a-z0-9-\]\+-p-/);
  // projects 表保留不删（退役留档）。
  assert.ok(!/DROP TABLE projects/.test(sql), 'projects 表不得删除');
});

test('baseline 冻结：docs/data/schema.sql 不含 0008 的 cwd 列（DDL 只走增量文件）', () => {
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  const chatSessions = baseline.slice(
    baseline.indexOf('CREATE TABLE chat_sessions'),
    baseline.indexOf('CREATE TABLE runs'),
  );
  // 注：runs 表头注释含「禁止 cwd 派生」字样（规格 §9.3-3），故只断言无 cwd 列定义。
  assert.ok(!/\bcwd\s+text/.test(chatSessions), 'baseline chat_sessions 不得回写 cwd 列');
});

// 0009（issue #88 会话标题自动生成）：title_source 语义列 + auto_title_seq 游标，
// 存量手工标题回填 'manual'（auto_title_seq IS NULL 守卫 → 可重放且不误伤未来自动标题行）。
test('迁移 0009-session-auto-title：编号连续、语句幂等、关键语义锚点齐全', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0009-session-auto-title.sql'), '0009 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 12, '0012 是最后编号（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0009-session-auto-title.sql'), 'utf8');
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS title_source'), 'chat_sessions 加 title_source 列（幂等）');
  assert.ok(sql.includes("CHECK (title_source IN ('auto', 'manual'))"), "title_source 枚举 'auto'/'manual'");
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS auto_title_seq'), 'chat_sessions 加 auto_title_seq 游标列（幂等）');
  // 回填守卫：只动「auto + 从未自动更新 + 标题非空」的行（可重放，不翻未来自动标题行）。
  assert.ok(sql.includes("SET title_source = 'manual'"), '存量非空标题回填 manual');
  assert.ok(sql.includes('AND auto_title_seq IS NULL'), '回填守卫：只动从未自动更新的行');
  assert.ok(sql.includes("AND btrim(title) <> ''"), '回填只动标题非空的行');

  // 语句级幂等（README 单文件约定）：除 UPDATE 外全部 IF NOT EXISTS；UPDATE 由 WHERE 守卫可重放。
  const statements = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('--'));
  for (const stmt of statements) {
    const head = stmt.replace(/^--[^\n]*\n/g, '').trim().toUpperCase();
    if (head.startsWith('UPDATE')) continue; // 条件 UPDATE，WHERE 守卫保证可重放
    assert.ok(head.startsWith('ALTER TABLE'), `0009 只允许 ALTER/条件 UPDATE，发现：${head.slice(0, 60)}`);
    assert.ok(head.includes('IF NOT EXISTS'), `ALTER 必须 IF NOT EXISTS：${head.slice(0, 60)}`);
  }
});

test('baseline 冻结：docs/data/schema.sql 不含 0009 的 title_source/auto_title_seq 列（DDL 只走增量文件）', () => {
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  const chatSessions = baseline.slice(
    baseline.indexOf('CREATE TABLE chat_sessions'),
    baseline.indexOf('CREATE TABLE runs'),
  );
  assert.ok(!/title_source/.test(chatSessions), 'baseline chat_sessions 不得回写 title_source 列');
  assert.ok(!/auto_title_seq/.test(chatSessions), 'baseline chat_sessions 不得回写 auto_title_seq 列');
});

test('迁移 0010-litellm-bindings：模型槽转 text、旧目录保留退役、旧直连 key 与模型槽清空', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0010-litellm-bindings.sql'), '0010 存在');
  const sql = fs.readFileSync(path.join(dir, '0010-litellm-bindings.sql'), 'utf8');
  assert.match(sql, /ALTER COLUMN main_model_id TYPE text/);
  assert.match(sql, /ALTER COLUMN embedding_model_id TYPE text/);
  assert.match(sql, /ALTER COLUMN vision_model_id TYPE text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS gateway_user_id text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS main_model_name text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS embedding_model_name text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS vision_model_name text/);
  assert.match(sql, /RENAME TO llm_providers_retired/);
  assert.match(sql, /RENAME TO llm_models_retired/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS fde_llm_bindings_main_model_id_fkey/);
  assert.match(sql, /api_key = NULL/);
  assert.match(sql, /main_model_id = NULL/);
  assert.doesNotMatch(sql, /DROP TABLE/i, '退役目录保留，DROP 应由后续迁移执行');
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('gateway_user_id'), '0010 DDL 不回写冻结 baseline');
});

test('迁移 0011-git-hosts：Git host registry、token ref 与 awaiting_credential 全在增量 DDL', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0011-git-hosts.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 12, '迁移编号连续');

  const sql = fs.readFileSync(path.join(dir, '0011-git-hosts.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS git_hosts/);
  assert.match(sql, /CHECK \(\(mode = 'minted'\) = \(admin_key IS NOT NULL\)\)/);
  assert.match(sql, /provider IN \('gitea', 'github', 'gitlab', 'azure'\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fde_git_accounts/);
  assert.match(sql, /token_ref\s+text/);
  assert.match(sql, /remote_login\s+text/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS git_provider text/);
  assert.match(sql, /awaiting_credential/);

  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('git_hosts'), 'baseline 不得回写 Git host DDL');
  assert.ok(!/\bgit_provider\s+text/.test(baseline), 'baseline 不得回写 git_provider 列');
});

test('迁移 0012-onboarding：开户队列状态、步骤和索引全在增量 DDL', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0012-onboarding.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 12, '迁移编号连续');

  const sql = fs.readFileSync(path.join(dir, '0012-onboarding.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fde_onboarding/);
  assert.match(sql, /fde_id\s+uuid PRIMARY KEY REFERENCES users \(id\) ON DELETE CASCADE/);
  assert.match(sql, /state IN \('pending','running','awaiting_credential','done','failed'\)/);
  assert.match(sql, /steps\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS fde_onboarding_state_idx ON fde_onboarding \(state\)/);
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('fde_onboarding'), 'baseline 不得回写 onboarding DDL');
});
