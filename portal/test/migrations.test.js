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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移（连续无空洞）');

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移（连续无空洞）');

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '迁移编号连续');

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '迁移编号连续');

  const sql = fs.readFileSync(path.join(dir, '0012-onboarding.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fde_onboarding/);
  assert.match(sql, /fde_id\s+uuid PRIMARY KEY REFERENCES users \(id\) ON DELETE CASCADE/);
  assert.match(sql, /state IN \('pending','running','awaiting_credential','done','failed'\)/);
  assert.match(sql, /steps\s+jsonb NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS fde_onboarding_state_idx ON fde_onboarding \(state\)/);
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('fde_onboarding'), 'baseline 不得回写 onboarding DDL');
});

test('迁移 0013-offboarding：增量队列可保留已停用用户并吊销 runner token', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0013-offboarding.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '迁移编号连续');

  const sql = fs.readFileSync(path.join(dir, '0013-offboarding.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE fde_offboarding/);
  assert.match(sql, /fde_id uuid PRIMARY KEY,/);
  assert.doesNotMatch(sql, /fde_id uuid PRIMARY KEY REFERENCES users/, '保留期内用户行与 offboarding 任务独立');
  assert.match(sql, /state text NOT NULL CHECK \(state IN \('pending', 'running', 'done', 'failed'\)\)/);
  assert.match(sql, /steps jsonb NOT NULL/);
  assert.match(sql, /workspace_purge_after timestamptz/);
  assert.match(sql, /ALTER TABLE containers ALTER COLUMN runner_token_hash DROP NOT NULL/);
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('fde_offboarding'), 'baseline 不得回写 offboarding DDL');
  assert.match(baseline, /runner_token_hash text NOT NULL/, 'token nullability change remains in the migration');
});

test('迁移 0014-run-state-status：终态 status 独立列，旧快照由读取层兼容', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0014-run-state-status.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移');

  const sql = fs.readFileSync(path.join(dir, '0014-run-state-status.sql'), 'utf8');
  assert.match(sql, /runs ADD COLUMN IF NOT EXISTS run_state_status jsonb/);
  assert.match(sql, /chat_sessions ADD COLUMN IF NOT EXISTS engine_run_state_status jsonb/);
  assert.doesNotMatch(sql, /\bUPDATE\b/i, '不回填旧数据，读取时兼容 legacy state');
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('run_state_status'), 'baseline 不得回写 runs status 列');
  assert.ok(!baseline.includes('engine_run_state_status'), 'baseline 不得回写 session status 列');
});

test('迁移 0015-backfill-user-input-transcript：只增不改、文本判断与唯一键确保幂等', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0015-backfill-user-input-transcript.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移');

  const sql = fs.readFileSync(path.join(dir, '0015-backfill-user-input-transcript.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = executable.split(';').map((statement) => statement.trim()).filter(Boolean);
  assert.equal(statements.length, 1, '单条 INSERT CTE，迁移可在事务内重放');
  assert.match(statements[0], /^WITH missing_user_messages AS/i);
  assert.match(statements[0], /m\.role = 'user'/);
  assert.match(statements[0], /m\.synthetic = false/);
  assert.match(statements[0], /position\(to_jsonb\(m\.content\)::text IN existing\.record::text\) > 0/);
  assert.match(statements[0], /COALESCE\(\(\s*SELECT MAX\(existing\.round\)/);
  assert.match(statements[0], /'roundKey', rows_to_insert\.dedup_key/);
  assert.match(statements[0], /'ts', rows_to_insert\.created_at/);
  assert.match(statements[0], /ON CONFLICT \(transcript_key, dedup_key\) WHERE transcript_key IS NOT NULL DO NOTHING/);
  assert.doesNotMatch(statements[0], /\b(UPDATE|DELETE)\b/i, '迁移只 INSERT，不修改或删除既有数据');
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('0015-backfill'), '冻结 baseline 不包含数据回填');
});

// 0016（erix-agent 0.16.0 store 契约，host-upgrade-guide-0.16.0 §1）：transcript 同 round 保序。
// append_seq 持久化追加序列 + 存量回填 + 索引；UNIQUE(run_id, round) 保留不动（session 行不受限）。
test('迁移 0016-transcript-append-seq：append 序列、确定性回填、索引，且不动 UNIQUE(run_id, round)', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0016-transcript-append-seq.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移');

  const sql = fs.readFileSync(path.join(dir, '0016-transcript-append-seq.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  // 新列 + 序列 + 默认值（幂等）。
  assert.match(executable, /ADD COLUMN IF NOT EXISTS append_seq bigint/);
  assert.match(executable, /CREATE SEQUENCE IF NOT EXISTS transcript_rounds_append_seq_seq/);
  assert.match(executable, /ALTER COLUMN append_seq SET DEFAULT nextval\('transcript_rounds_append_seq_seq'\)/);
  assert.match(executable, /ALTER COLUMN append_seq SET NOT NULL/);
  // 存量回填：确定性顺序 created_at, id，只写 append_seq IS NULL（可重放）。
  assert.match(executable, /row_number\(\) OVER \(ORDER BY created_at ASC, id ASC\)/);
  assert.match(executable, /WHERE append_seq IS NULL/);
  assert.match(executable, /COALESCE\(\(SELECT MAX\(append_seq\) FROM transcript_rounds\), 0\) \+ 1/);
  // 索引：session 读路径 (transcript_key, round, append_seq) + legacy run 路径。
  assert.match(executable, /CREATE INDEX IF NOT EXISTS transcript_rounds_session_append_idx\s*\n\s*ON transcript_rounds \(transcript_key, round, append_seq\) WHERE transcript_key IS NOT NULL/);
  assert.match(executable, /transcript_rounds_run_append_idx/);
  // UNIQUE(run_id, round) 不在此迁移改动（保留 legacy 幂等语义）。
  assert.doesNotMatch(executable, /DROP CONSTRAINT/i, '不得 drop UNIQUE(run_id, round)');
  assert.doesNotMatch(executable, /transcript_rounds_run_id_round_key/);
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('append_seq'), '冻结 baseline 不得回写 append_seq');
});

// 0017（#202）：port_allocations.hostname 的 DB 侧兜底 CHECK——整域名正则（逐标签 ≤63）+ 总长 ≤253，
// NOT VALID（存量未实机核对，新写入即刻生效；存量收敛动作与理由见迁移文件头注释）。
test('迁移 0017-port-allocations-hostname-check：整域名 CHECK、NOT VALID、幂等重放', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0017-port-allocations-hostname-check.sql'));
  assert.equal(Number(files[files.length - 1].slice(0, 4)), 17, '0017 为当前最后迁移（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0017-port-allocations-hostname-check.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = executable.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3, 'SET + DROP IF EXISTS + ADD：重放安全');
  // 幂等：先 DROP IF EXISTS 再 ADD（重放不炸）。
  assert.match(statements[1], /DROP CONSTRAINT IF EXISTS port_allocations_hostname_dns_check/);
  // 整域名版正则：逐标签 ≤63（1+61+1），与 routes.js DNS_LABEL_RE 同构；不是只校验首段。
  assert.match(statements[2], /hostname ~ '\^\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\(\\\.\[a-z0-9\]\(\[a-z0-9-\]\{0,61\}\[a-z0-9\]\)\?\)\*\$'/);
  // 总长 ≤253（RFC 1035 整域名上限）。
  assert.match(statements[2], /char_length\(hostname\) <= 253/);
  // NOT VALID：存量行未实机核对，新 INSERT/UPDATE 即刻强制（理由见迁移头注释）。
  assert.match(statements[2], /\) NOT VALID;?\s*$/);
  // 冻结 baseline 不回写。
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('port_allocations_hostname_dns_check'), '冻结 baseline 不得回写该 CHECK');
});
