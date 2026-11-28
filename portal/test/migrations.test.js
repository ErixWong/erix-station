// 迁移纪律测试（deploy/migrations/README.md + deploy-contract §3.2）：baseline 冻结、增量可重放。
// 0006（issue #81 P2）：session-scoped transcript——既有表加列 + 部分唯一索引（非新表），
// 全部语句幂等（IF NOT EXISTS / ALTER COLUMN 幂等），单事务由迁移 runner 保证。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 号池常量：迁移 SQL 与 JS 侧必须是同一份数字（漂移 = 分配出池外号）。
import { PREVIEW_PORT_COUNT, PREVIEW_PORT_POOL_END, PREVIEW_PORT_POOL_START } from '../src/previewpool.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── 迁移号位表（issue #640 起目录里有一个**已知预留空洞**，这里是唯一真相）──────────────────
// `0040-platform-prompts` 这个号**已被占用**：真库 `schema_migrations` head 现查 = `0040-platform-prompts`
// （主 agent 261117 只读现查），文件在未合并的分支上。runner 用**文件名**当 version，同号两支的后果是
// 「应用先后只由 slug 字典序决定」（这正是 `37380f0` 那次把 0039 让成 0040 的理由）。
// ⇒ #640 的退役迁移取号 **0041**，本目录因此在 40 上留一个洞：
//   · 「1..head 连续无空洞」这条闸**不许改成恒真**，它继续逐号核对，只是把这一个预留号显式让开；
//   · 多一个洞、或洞挪到别的号 ⇒ 这里红（`RESERVED_MIGRATION_NUMS` 与实算集合的差会被 deepEqual 抓住）。
// 合并 `0040-platform-prompts.sql` 之后**必须**把下面那个集合清空（留空 = 恢复严格连续）。
// 0040 这个洞已被 `0040-mcp-channel.sql`（#608）填上 ⇒ 保留集合清空，恢复严格连续。
const RESERVED_MIGRATION_NUMS = new Set([]);
// 现势（issue #596 第四次让号，2026-11-17）：本单 platform-prompts 迁到 0043。
// 判据：migrations.test.js「NNNN 全局唯一」闸 + migrate.js 台账反向对账。
// 0042 已被 #670 那条线 `0042-mcp-plaintext-values` 取走 ⇒ 第四次让号到 0043
//（撞号会撞真库 checksum / 容器反复重启）。
// 现势（issue #719，2026-11-23）：本单追加 `0047-fde-budget.sql`（`fde_llm_bindings` 加
// `budget_usd numeric(12,6)` + `budget_period text`，每 FDE 周期额度落库（周期白名单 '1d'/'1mo'），
// key 重铸时从这两列恢复）⇒ head 46 → 47（周期改造仍写在同一个 0047，未合并故直接改写、不新开 0048）。
// 现势（issue #828 P1，2026-11-26）：本单追加 `0048-users-locale.sql`（`users.locale VARCHAR(8)` 可空，
// 账号级语言偏好，NULL=跟随浏览器；值域交应用侧白名单不写 DB CHECK）⇒ head 47 → 48。
// 现势（issue #850，2026-11-27）：本单追加 `0049-notifications-title-key.sql`（`notifications.title_key text`
// + `title_params jsonb`，都可空；`title` 的 NOT NULL 不动 ⇒ 存量行逐字不变）⇒ head 48 → 49。
const MIGRATION_HEAD = 49;
const MIGRATION_NUMS = Array.from({ length: MIGRATION_HEAD }, (_, i) => i + 1)
  .filter((n) => !RESERVED_MIGRATION_NUMS.has(n));

// 「谁是当前迁移头号」这句话在本文件里逐字重复了 19 处（每支旧迁移的用例都要确认自己没被插到末尾）。
// **每追加一支新迁移，这 19 处 + 那几处 `Array.from({ length: N })` 必须一起进一位**（本单：0034 → 0035，
// `0035-macro-platform.sql`，issue #524 的事件平台 W1 数据层：`macro_templates` /
// `macro_assignments` / `macro_runs` 三张表）。
// `0036-upload-settings.sql`，issue #485 片 A 的 `upload_settings` 单行表（原 `0035-upload-settings.sql`，因 main 上 0035 已被 macro-platform 占位而进位）。
// 为什么不改成「现算最大值」：那会把闸变成恒真（`max(files) === max(files)`）——
// 这里的语义是「头号必须是**我期望的那一支**」，所以它只能写死；漏改一处的代价是一条红，
// 而不是默默接受一支插错位置的迁移（插中间另有 `Array.from` 那条「连续无空洞」兜着）。
// 每支迁移自己的语义闸在文件末尾按编号开一段（0035 那段就在最后）。

test('迁移 0006-session-transcript：文件存在、编号连续、语句全部幂等（可重放）', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  const nums = files.map((f) => Number(f.slice(0, 4)));
  // 编号连续无空洞（顺序 = 文件名升序，README 约定）。唯一的例外是上面显式登记的**预留号**
  // （`0040-platform-prompts` 已落真库台账，文件在未合并分支上）——洞只许在那一个位置，
  // 多一个洞或洞挪位都照样红；判据是「逐号比集合」，不是「max 自己等于 max」。
  assert.deepEqual(nums, MIGRATION_NUMS, `迁移编号空洞/多余：${files.join(', ')}`);
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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "迁移编号连续（head=0046）");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "迁移编号连续（head=0046）");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "迁移编号连续（head=0046）");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移");

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
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

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

// 0018（issue #240）：port_allocations.scope 放开第三个值 'fde'——开户预分配 10 条 FDE 级预览域名
// （端口 4000–4009）需要 FDE 级归属；P5 之后既不是项目级也不是 run 级。
// 幂等靠**既有**部分唯一索引 port_allocations_live_port_key，故本迁移**不新建任何索引**。
test('迁移 0018-port-allocations-scope-fde：scope CHECK 放开含 fde、保留 run_id 条件约束、不新建索引', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0018-port-allocations-scope-fde.sql'), '0018 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

  const sql = fs.readFileSync(path.join(dir, '0018-port-allocations-scope-fde.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const statements = executable.split(';').map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 3, 'SET + DROP IF EXISTS + ADD：重放安全（照 0017 的幂等形状）');
  assert.match(statements[0], /^SET lock_timeout/);
  // 幂等：先 DROP IF EXISTS 再 ADD。
  assert.match(statements[1], /ALTER TABLE port_allocations DROP CONSTRAINT IF EXISTS port_allocations_scope_check/);
  // ④-a 放开后的取值集：project|run|fde（老值一个都不能少——存量 project 行不改不删，仍要能过校验）。
  assert.match(statements[2], /ADD CONSTRAINT port_allocations_scope_check/);
  assert.match(statements[2], /CHECK \(scope IN \('project', 'run', 'fde'\)\)/);
  // ④-b 保留 `CHECK ((scope = 'run') = (run_id IS NOT NULL))`（conname port_allocations_check）：
  //     本迁移按名 DROP 的只有 scope 那一条 CHECK，条件约束连提都不提 ⇒ scope='fde' 的行 run_id 必须为 NULL。
  assert.doesNotMatch(statements[1], /port_allocations_check\b/, '不得连带 drop 掉 scope/run_id 的条件约束');
  assert.doesNotMatch(executable, /DROP CONSTRAINT IF EXISTS port_allocations_check;/);
  // 冻结 baseline 的口径仍然自洽（schema.sql 里那条条件约束没被文档改动）。
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.match(baseline, /CHECK \(\(scope = 'run'\) = \(run_id IS NOT NULL\)\)/, 'baseline 的 run_id 条件约束原样存在');
  // 冻结 baseline 里 port_allocations 的 scope CHECK 必须仍是两值（schema.sql 一个字节都没动 ⇒
  // migrate.js 的 baseline sha256 不变；判定限定在本表 DDL 块内，避开全文无关的 'fde' 字样）。
  const paBlock = baseline.slice(baseline.indexOf('CREATE TABLE port_allocations'), baseline.indexOf('CREATE TABLE preview_grants'));
  assert.ok(paBlock.length > 200, 'port_allocations DDL 块可定位');
  assert.match(paBlock, /scope\s+text NOT NULL CHECK \(scope IN \('project', 'run'\)\)/, 'baseline 仍是 project|run 两值');
  assert.ok(!paBlock.includes("'fde'"), '冻结 baseline 不得回写 fde（sha256 失配会让既有部署拒启）');
  // ④-c 不新建索引：幂等判据是 baseline 既有的部分唯一索引
  //     port_allocations_live_port_key UNIQUE (fde_id, port) WHERE state <> 'released'。
  assert.doesNotMatch(executable, /CREATE (UNIQUE )?INDEX/i, '本迁移不新建索引（幂等靠既有部分唯一索引）');
  assert.ok(/ON CONFLICT \(fde_id, port\) WHERE state <> 'released' DO NOTHING/
    .test(fs.readFileSync(path.join(HERE, '../../portal/src/portalloc.js'), 'utf8')),
  '写侧必须用带谓词的 ON CONFLICT 目标（部分索引不做无谓词推断）');
});

// 0019（issue #246 交付①）：预览端口**全局号池** 22000–29999 落库。三件事 + 一条前置，顺序不可换：
//   ⓪ 按名 DROP 旧 port CHECK → ① 重排存量活行进池（含 hostname/url 同步重写）→ ② port CHECK 换成
//   按状态分支的新口径 → ③ 建全局部分唯一索引 `port_allocations_live_global_port_key`。
// 本文件按仓库纪律做**静态 SQL 断言**（顺序、幂等、谓词、不硬编码伞域、口径与 JS 常量一致）；
// 「未重排就加 CHECK / 就建索引」的**真库负例**与整事务 ROLLBACK 的正例在交付报告里（TEMP 克隆实测）。
test('迁移 0019-preview-port-pool：⓪→①→②→③ 顺序不可换、CHECK 按状态分支、全局部分唯一索引、不硬编码伞域', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0019-preview-port-pool.sql'), '0019 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

  const sql = fs.readFileSync(path.join(dir, '0019-preview-port-pool.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const pos = (re) => {
    const m = executable.search(re);
    assert.notEqual(m, -1, `0019 里必须出现：${re}`);
    return m;
  };

  // —— 顺序（本迁移的全部正确性都建立在这个顺序上）——
  const pDrop = pos(/^ALTER TABLE port_allocations DROP CONSTRAINT IF EXISTS port_allocations_port_check;$/m);
  const pWith = pos(/^WITH live AS \($/m);            // ① 的 CTE 链（取数与块几何都在这里）
  const pUpdate = pos(/^UPDATE port_allocations AS pa$/m);
  const pGuard = pos(/^DO \$do\$$/m);
  const pAdd = pos(/^ALTER TABLE port_allocations ADD CONSTRAINT port_allocations_port_check CHECK \($/m);
  const pIndex = pos(/^CREATE UNIQUE INDEX IF NOT EXISTS port_allocations_live_global_port_key$/m);
  assert.ok(pDrop < pWith && pWith < pUpdate, '⓪ 旧 CHECK 必须先摘掉：它是 4000–4999，与新池不相交，带着它 ① 自己就 23514');
  assert.ok(pUpdate < pAdd, '① 重排必须先于 ② 加 CHECK（否则 ADD CONSTRAINT 校验存量当场 23514）');
  assert.ok(pAdd < pIndex, '② 必须先于 ③：建索引前必须已无重复（PG 16.15 唯一索引不支持 NOT VALID）');
  assert.ok(pGuard > pUpdate && pGuard < pAdd, '①\' 守卫夹在重排与 CHECK 之间，把裸 23514/23505 换成可操作文案');
  assert.doesNotMatch(executable, /CREATE (UNIQUE )?INDEX CONCURRENTLY/, 'runner 在显式事务里执行 ⇒ CONCURRENTLY 不可用');

  // —— 只动 port 这一条 CHECK（0017 的 hostname CHECK、0018 的 scope CHECK、两条条件约束都不许碰）——
  const drops = executable.match(/DROP CONSTRAINT IF EXISTS [a-z0-9_]+/g) ?? [];
  assert.deepEqual(drops, ['DROP CONSTRAINT IF EXISTS port_allocations_port_check'],
    `只能按名摘 port 那条 CHECK，实际：${JSON.stringify(drops)}`);
  assert.doesNotMatch(executable, /port_allocations_scope_check|port_allocations_hostname_dns_check/,
    '不得连带 scope / hostname 的 CHECK 一起改');
  assert.ok(!/NOT VALID/.test(executable.slice(pAdd, pIndex)),
    '② 必须建成 VALID：本迁移的正解就是「活行全部已在池内」，要真校验存量');

  // —— CHECK 按状态分支：活行必须在池内；released 保留历史号码（portsprobe 的 4000–4009 靠这条活）——
  const checkBody = executable.slice(pAdd, executable.indexOf(';', pAdd));
  assert.match(checkBody, /state =\s+'released' AND port BETWEEN 4000\s+AND 29999/,
    'released 分支下界必须是 4000（历史号码留着），上界与号池一致');
  assert.match(checkBody, /state <> 'released' AND port BETWEEN 22000 AND 29999/, '活行分支必须钉在号池内');
  assert.equal((checkBody.match(/port BETWEEN/g) ?? []).length, 2, '只有两个分支，没有第三种取值');

  // —— ③ 全局部分唯一索引：跨 FDE 不重叠由 DB 保证；released 不占位 ⇒ 号码可复用 ——
  const indexDef = executable.slice(pIndex);
  assert.match(indexDef, /ON port_allocations \(port\) WHERE state <> 'released';/,
    '索引必须是 (port) 的全局部分唯一索引，谓词与 released 语义一致');
  assert.ok(!/DROP INDEX/.test(executable), '不删任何既有索引（(fde_id,port) 那条继续做幂等冲突目标）');

  // —— 重排：只动活行、块装不下的溢出槽位置 released、hostname/url 同步重写且不硬编码伞域 ——
  const updateBody = executable.slice(pWith, pGuard);
  assert.match(updateBody, /FROM live AS l/, '取数只看活行（released 行不重排）');
  assert.match(updateBody, /WHERE l\.port NOT BETWEEN 22000 AND 29999/, '只挑池外活行 ⇒ 重放时集合为空（no-op）');
  assert.match(updateBody, /generate_series\(22000, 29999, 10\)/, '候选块 = 池内 10 个一段的对齐块');
  assert.match(updateBody, /row_number\(\) OVER \(ORDER BY COALESCE\(u\.fde_name, l\.fde_id::text\)\)/,
    '确定顺序 = fde_name（无用户时回落 fde_id），第 1 个 FDE 拿 22000 段');
  assert.match(updateBody, /state\s+= CASE WHEN r\.slot_no <= 10 THEN pa\.state\s+ELSE 'released' END/,
    '块装不下的第 11 条起置 released（<fde_name> 的 4100 就走这条）');
  assert.match(updateBody, /released_at = CASE WHEN r\.slot_no <= 10 THEN pa\.released_at ELSE now\(\) END/,
    "置 released 必须同时写 released_at（CHECK ((state='released') = (released_at IS NOT NULL))）");
  // hostname：拆「首标签前缀 + 旧端口段 + base」重组 ⇒ base 来自旧 hostname，不写死伞域；
  // 且**不许用 lpad**（PG 的 lpad 会把 5 位端口截成 4 位，实测 lpad('22010',4,'0')='2201'）。
  assert.match(updateBody, /substr\(s\.hostname, length\(split_part\(s\.hostname, '\.', 1\)\) \+ 1\)/,
    'base = 第一段之后的部分（从旧 hostname 反推，不硬编码伞域）');
  assert.doesNotMatch(updateBody, /\blpad\(/, 'PG lpad 会截断超长串 ⇒ 5 位端口会被写坏，禁止在端口段用 lpad');
  assert.doesNotMatch(updateBody, /erix\.vip|fde\.[a-z]/, '不得把伞域写死进迁移（base 来自 deploy/.env）');
  assert.ok(updateBody.includes("regexp_replace(pa.url, '://[^/:]+', '://' || r.new_hostname)"),
    'url 只换 host 段（scheme 与非默认端口原样保留，形态与 projects.previewUrl 一致）');

  // —— 口径与 JS 侧必须是同一份数字（迁移与 portalloc/previewpool 漂移 = 分配出池外号）——
  assert.ok(executable.includes(String(PREVIEW_PORT_POOL_START)) && executable.includes(String(PREVIEW_PORT_POOL_END)),
    'SQL 里的池边界必须等于 previewpool.js 的常量');
  assert.ok(executable.includes(`generate_series(${PREVIEW_PORT_POOL_START}, ${PREVIEW_PORT_POOL_END}, ${PREVIEW_PORT_COUNT})`),
    '块大小/对齐粒度必须与 PREVIEW_PORT_COUNT 一致');

  // —— 冻结 baseline 不回写（sha256 失配会让既有部署拒启）——
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('port_allocations_live_global_port_key'), '冻结 baseline 不得回写新索引');
  assert.ok(!baseline.includes('22000'), '冻结 baseline 的 port CHECK 仍是 4000–4999');
});

// 0020（issue #252 / 工单 fix-261011-B）：**纯数据修复**——清掉「已释放 allocation 上仍 active」的预览凭证残渣。
// 病灶：撤权谓词 `state IN ('active','used')` 撞 baseline 的双向 CHECK `(state='used') = (used_at IS NOT NULL)`
// （真机报 `preview_grants_check3`），而 offboarding 把撤权包在「本次释放了行」的守卫里 ⇒ 重试静默跳过。
// 静态断言口径：只撤 active、**绝不碰 used**、可整体重放、零 DDL（冻结 baseline 一字节不动）。
// 重放证据（真库 PG 16.15 的 scratch 库实测，见 DELIVERY.md）：第 1 次 `UPDATE 2`、第 2 次 `UPDATE 0` 且
// 分布逐字相同；`used` 行与 `used_at` 全程不变；旧谓词在真库当场 23514 preview_grants_check3。
test('迁移 0020-preview-grant-revoke-repair：只撤 active、不碰 used、可重放、零 DDL、口径与实现同源', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0020-preview-grant-revoke-repair.sql'), '0020 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");

  const sql = fs.readFileSync(path.join(dir, '0020-preview-grant-revoke-repair.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  // —— 依据要写进头注释（README「已应用的迁移不可再改」⇒ 解释只能写在这里）——
  assert.match(sql, /#252/, '头注释要引用 issue #252');
  assert.match(sql, /fix-261011-B/, '头注释要引用工单代号');
  assert.match(sql, /preview_grants_check3/, '头注释要点出真机撞的是哪条 CHECK');
  assert.match(sql, /不碰 used|used 行保留原状|为什么只修 active/, '头注释要写清「为什么只修 active、为什么不碰 used」');

  // —— 幂等（README「单文件约定」）：UPDATE 只命中 active，跑完即变 revoked ⇒ 重放零变更 ——
  assert.match(executable, /^SET lock_timeout = '5s';$/m, '数据修复按纪律设 lock_timeout');
  const updateStart = executable.search(/^UPDATE preview_grants/m);
  assert.notEqual(updateStart, -1, '0020 必须有一条顶层 UPDATE preview_grants');
  const update = executable.slice(updateStart);
  const updateBody = update.slice(0, update.indexOf(';'));
  const whereBody = updateBody.slice(updateBody.search(/\bWHERE\b/));
  assert.match(whereBody, /pg\.state = 'active'/, '② 的谓词只能是 state = active');
  assert.doesNotMatch(whereBody, /'used'|'expired'|'revoked'/, '② 不得把 used/expired/revoked 放进待撤集合');
  assert.match(updateBody, /revoked_at = COALESCE\(pg\.revoked_at, now\(\)\)/,
    'revoked ⇔ revoked_at 要靠 COALESCE 满足（不覆盖既有值）');
  assert.doesNotMatch(updateBody, /used_at\s*=\s*NULL/, '不得清 used_at（篡改历史）');
  assert.match(updateBody, /EXISTS/, '只撤「挂在已释放 allocation 上」的残渣：用 EXISTS 判定 allocation 状态');
  const existsBody = whereBody.slice(whereBody.indexOf('EXISTS'));
  assert.match(existsBody, /pa\.state = 'released'/, '只挑已释放的 allocation（活 allocation 上的 active 凭证是正常状态）');
  assert.match(whereBody, /^\s*WHERE pg\.state = 'active'$/m, '可重放的机关：待修集合跑完即为空');

  // —— 零 DDL：冻结 baseline 一字节不动（sha256 失配 → runner refusing to start）——
  assert.doesNotMatch(executable, /\bALTER TABLE\b|\bCREATE (?:UNIQUE )?INDEX\b|\bDROP\b/i, '纯数据修复：不许有 DDL');
  assert.doesNotMatch(executable, /INSERT INTO schema_migrations/, '台账由 runner 写，迁移自己别写');
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  const pgBlock = baseline.slice(baseline.indexOf('CREATE TABLE preview_grants'), baseline.indexOf('CREATE INDEX preview_grants_user_idx'));
  assert.match(pgBlock, /CHECK \(\(state = 'used'\) = \(used_at IS NOT NULL\)\)/, 'baseline 的双向 CHECK 原样存在（本迁移尊重它，不去改约束）');
  assert.match(pgBlock, /CHECK \(\(state = 'revoked'\) = \(revoked_at IS NOT NULL\)\)/, 'baseline 的 revoked 双向 CHECK 原样存在');
  assert.ok(!/0020/.test(baseline), '冻结 baseline 不得回写本迁移的痕迹');

  // —— 口径与实现同源：迁移与 portal 代码必须是「只撤 active」这一条口径 ——
  for (const [name, rel] of [['offboarding.js', '../src/offboarding.js'], ['portalloc.js', '../src/portalloc.js']]) {
    const src = fs.readFileSync(path.join(HERE, rel), 'utf8');
    assert.ok(!/state IN \('active', 'used'\)/.test(src), `${name} 里不得再出现旧谓词 state IN ('active','used')`);
  }
});

// 0021（issue #255 / 工单 feat-261013-03）：users 加「需改密」旗标 must_change_password。
// 静态断言口径：幂等可重放（ADD COLUMN IF NOT EXISTS + 纯读守卫）、NOT NULL DEFAULT false（默认值是契约：
// bootstrap-admin 与存量行都靠它保持 false）、零 baseline 回写、且**默认值这一契约与代码同源**
// （cli.js bootstrap-admin 的 INSERT 必须不写该列——写了 true 就把 dev/CI 账号锁进改密屏）。
// 真库重放证据（TEMP scratch 库 PG 16，跑两遍比对）见交付报告。
test('迁移 0021-user-must-change-password：ADD COLUMN IF NOT EXISTS 可重放、NOT NULL DEFAULT false、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0021-user-must-change-password.sql'), '0021 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, "0046 为当前最后迁移（连续无空洞）");
  // 编号连续无空洞（README 约定：顺序 = 文件名升序）。
  // 同 0006 那条：逐号核对，只让开顶部显式登记的预留号（0040-platform-prompts 已落真库台账）。
  assert.deepEqual(files.map((f) => Number(f.slice(0, 4))), MIGRATION_NUMS, `迁移编号空洞/多余：${files.join(', ')}`);

  const sql = fs.readFileSync(path.join(dir, '0021-user-must-change-password.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  // —— 依据与语义要写进头注释（已应用迁移不可再改 ⇒ 解释只能落在文件头/README）——
  assert.match(sql, /#255/, '头注释要引用 issue #255');
  assert.match(sql, /feat-261013-03/, '头注释要引用工单代号');
  assert.match(sql, /bootstrap-admin 不置 true|bootstrap-admin[^]{0,40}不置 true/, '头注释要写清 bootstrap-admin 不置 true 及其后果');
  assert.match(sql, /存量行/, '头注释要写清存量行不回填');

  // —— 幂等（README「单文件约定」：本文件可整体重放）——
  assert.match(executable, /^SET lock_timeout = '5s';$/m, 'DDL 按纪律设 lock_timeout');
  const alter = executable.match(/ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;/);
  assert.ok(alter, '唯一的 DDL：ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false');
  // 语句级幂等：先整块摘掉 DO 守卫（体内有分号，不能直接按 ';' 切），再要求剩下的语句只有两类。
  const doBlocks = executable.match(/DO \$do\$[\s\S]*?\$do\$/g) ?? [];
  assert.ok(doBlocks.length >= 2, `0021 至少要有「默认值守卫」+「观测」两个 DO 块，实际 ${doBlocks.length}`);
  for (const block of doBlocks) {
    // 守卫块必须是纯读：出现任何 DML/DDL 就不可重放。
    // 先把单引号字面量剔掉再查——RAISE 文案里会出现「ALTER 未生效」这类词，不是真语句。
    const code = block.replace(/'(?:[^']|'')*'/g, "''");
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/i,
      `0021 的 DO 块必须纯读（可重放），发现写操作：${code.slice(0, 80)}`);
  }
  const statements = executable
    .replace(/DO \$do\$[\s\S]*?\$do\$/g, '@@DO@@')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (stmt === '@@DO@@') continue;
    const head = stmt.replace(/^\s+/, '').toUpperCase();
    assert.ok(
      head.startsWith('SET LOCK_TIMEOUT') || head.startsWith('ALTER TABLE USERS ADD COLUMN IF NOT EXISTS'),
      `0021 只允许 SET lock_timeout / ADD COLUMN IF NOT EXISTS / 纯读 DO，发现：${head.slice(0, 70)}`,
    );
  }
  // 只加这一列：不得顺手加约束/索引/回填（回填会把存量用户全锁进改密屏）。
  assert.doesNotMatch(executable, /^\s*(UPDATE|CREATE (?:UNIQUE )?INDEX|CREATE TABLE)/m, '0021 不回填、不建索引、不新建表');
  assert.equal((executable.match(/ADD COLUMN/g) ?? []).length, 1, '只加一列');

  // —— 默认值是契约：NOT NULL DEFAULT false（守卫块必须自己把它钉住）——
  assert.match(executable, /RAISE EXCEPTION[^]{0,200}默认值不是 false/, '守卫块要在默认值漂移时炸掉（bootstrap 与存量行都靠默认值 false）');
  assert.match(executable, /has_not_null IS NOT TRUE/, '守卫块要校验 NOT NULL（三态 = 门判定静默放行）');

  // —— 口径与实现同源：bootstrap-admin 必须**不写**这一列（吃 DEFAULT false）——
  const cli = fs.readFileSync(path.join(HERE, '../src/cli.js'), 'utf8');
  const bootstrapInsert = cli.slice(cli.indexOf('INSERT INTO users (login, display_name, role'), cli.indexOf('INSERT INTO users (login, display_name, role') + 400);
  assert.ok(bootstrapInsert.length > 40, 'cli.js 里找得到 bootstrap-admin 的 INSERT INTO users');
  assert.doesNotMatch(bootstrapInsert.slice(0, bootstrapInsert.indexOf(')') + 1), /must_change_password/,
    'bootstrap-admin 的 INSERT 不得写 must_change_password（写 true 就把 dev/CI 的 bootstrap 账号锁进改密屏）');

  // —— 冻结 baseline 不回写（sha256 失配会让既有部署拒启）——
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('must_change_password'), '冻结 baseline 不得回写 must_change_password');
  assert.ok(!/0021/.test(baseline), '冻结 baseline 不得回写本迁移的痕迹');
});

// 0022（端口呈现优化·观测层 MVP）：port_observations 表——agentd /proc 采样随 heartbeat 落库，
// 读侧按 observed_at 新鲜度窗口过滤进 /api/me/ports DTO。整批替换语义 ⇒ 陈旧注解无需显式释放。
test('迁移 0022-port-observations：编号连续、语句幂等、关键语义锚点齐全', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0022-port-observations.sql'), '0022 存在');

  const sql = fs.readFileSync(path.join(dir, '0022-port-observations.sql'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS port_observations'), '建表幂等');
  assert.ok(sql.includes('fde_id          uuid NOT NULL REFERENCES users (id)') || /fde_id\s+uuid NOT NULL REFERENCES users \(id\)/.test(sql), 'fde_id 必带（读端点按 FDE 直查）');
  assert.ok(sql.includes('observed_at'), 'observed_at 新鲜度列（陈旧性由读侧窗口判定）');
  assert.ok(sql.includes('proc_started_at'), '进程启动时刻（比 HEAD 分支更诚实的时间证据）');
  assert.ok(sql.includes('port_observations_container_port_key'), '每容器每端口唯一（整批替换的幂等落点）');
  assert.ok(sql.includes('ON port_observations (container_id, port)'), '唯一索引键 = (container_id, port)');
  assert.ok(sql.includes('port_observations_fde_idx'), 'FDE 读路径索引');

  // 幂等（README 单文件约定）：全部 CREATE ... IF NOT EXISTS，零 UPDATE/DELETE。
  const statements = sql.split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('--'));
  for (const stmt of statements) {
    const head = stmt.replace(/^--[^\n]*\n/g, '').trim().toUpperCase();
    assert.ok(
      head.startsWith('SET LOCK_TIMEOUT') || head.startsWith('CREATE TABLE IF NOT EXISTS') || head.startsWith('CREATE UNIQUE INDEX IF NOT EXISTS') || head.startsWith('CREATE INDEX IF NOT EXISTS'),
      `0022 只允许 SET lock_timeout / CREATE ... IF NOT EXISTS，发现：${head.slice(0, 60)}`,
    );
  }

  // 冻结 baseline 不回写。
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('port_observations'), '冻结 baseline 不得回写 port_observations');
});

// 0024（对话输入队列 · issue #370）：`queued_inputs` 表 + `runs.trigger_kind`。
// 本文件的断言重点不是「表建了」，而是**三条设计红线在 DDL 里成立**：
//   ① 入队只写本表（⇒ 断言它**不碰** messages / transcript_rounds）；
//   ② 有 `delivering` 这个认领态（否则并发终态出队会把同一条投两次）；
//   ③ `interrupted_run_id` 承载「这次 abort 是转向还是停止」的判据（⇒ 不必新增 run 状态/reason）。
test('迁移 0024-queued-inputs：编号连续、幂等可重放、三条设计红线在 DDL 成立', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0024-queued-inputs.sql'), '0024 存在');

  const sql = fs.readFileSync(path.join(dir, '0024-queued-inputs.sql'), 'utf8');
  assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS queued_inputs'), '建表幂等');
  assert.ok(/kind\s+text NOT NULL CHECK \(kind IN \('steer', 'follow_up'\)\)/.test(sql), 'kind 值域就两个：转向 / 排队');
  assert.ok(/status IN \('pending', 'delivering', 'delivered', 'recalled', 'discarded'\)/.test(sql),
    'status 值域必须含 delivering——认领与建 run 跨两次提交，没有它并发出队会双投');
  assert.ok(/position\s+bigserial NOT NULL/.test(sql), 'FIFO 用 bigserial，不用 now()（同毫秒也要有确定先后）');
  assert.ok(/interrupted_run_id\s+uuid REFERENCES runs \(id\) ON DELETE SET NULL/.test(sql),
    '转向目标 run 的指针（「这次 abort 是不是转向」的唯一判据，不新增 run 状态）');
  assert.ok(/CREATE INDEX IF NOT EXISTS queued_inputs_pending_idx/.test(sql), '出队扫描的部分索引');

  // 红线①：入队绝不写第①层锚点行，也不提前进 transcript（正文真相在 transcript_rounds，
  // 提前写入等于「还没说出口的话已进模型上下文」）。
  const noLayerOne = !/INSERT INTO (messages|transcript_rounds)/.test(sql)
    && !/UPDATE (messages|transcript_rounds)/.test(sql)
    && !/ALTER TABLE (messages|transcript_rounds)/.test(sql);
  assert.ok(noLayerOne, '0024 不得触碰 messages / transcript_rounds（#77 P3 PR②b B2 锚点纯净红线）');

  // 测量用 lineage：follow-up 一条一个 run，必须先能把它从普通发送里分出来。
  assert.ok(/ALTER TABLE runs ADD COLUMN IF NOT EXISTS trigger_kind text NOT NULL DEFAULT 'user_send'/.test(sql),
    'runs.trigger_kind 幂等新增，默认 user_send（存量行语义不变）');
  assert.ok(/RAISE EXCEPTION '0024: runs\.trigger_kind 漂移/.test(sql), '默认值是契约，必须有后置守卫（照 0021 惯例）');

  // 幂等可重放：除 DO $$ 守卫块之外，语句头只允许 SET / CREATE ... IF NOT EXISTS / ALTER ... ADD COLUMN IF NOT EXISTS。
  // ⚠ 先整块摘掉 `DO $$ … $$;`：它内部有分号（`END IF;`），按 ';' 裸切会把 PL/pgSQL 的尾巴
  //   当成独立语句，于是断言在测「我的切分器」而不是「迁移的幂等性」。
  const withoutDo = sql.replace(/DO\s+\$\$[\s\S]*?\$\$\s*;/gi, '');
  const statements = withoutDo.split(';').map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith('--'));
  for (const stmt of statements) {
    const head = stmt.replace(/^--[^\n]*\n/g, '').trim().toUpperCase();
    assert.ok(
      head.startsWith('SET LOCK_TIMEOUT')
        || head.startsWith('CREATE TABLE IF NOT EXISTS')
        || head.startsWith('CREATE INDEX IF NOT EXISTS')
        || head.startsWith('ALTER TABLE RUNS ADD COLUMN IF NOT EXISTS'),
      `0024 只允许幂等 DDL，发现：${head.slice(0, 60)}`,
    );
  }

  // 冻结 baseline 不回写（docs/data/schema.sql 是历史快照）。
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('queued_inputs'), '冻结 baseline 不得回写 queued_inputs');
  assert.ok(!/trigger_kind/.test(baseline), '冻结 baseline 不得回写 runs.trigger_kind');
});

// 0025（issue #429）：**凭证血缘**——preview_grants 加签发会话指针 login_session_id，登出时沿血缘回收
// 预览平面（auth.js revokeSession 的同语句 CTE）。静态断言口径：
//   ① 幂等（ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，第二遍零 DDL）；
//   ② FK 必须 ON DELETE SET NULL（offboarding / 停用用户会 DELETE login_sessions 行，
//      RESTRICT 会把那两条既有流程当场撞 FK 失败）；
//   ③ 可空不回填（发布窗口的存量活跃凭证靠自身 ≤15min TTL 自然到期，不做数据修复）；
//   ④ 冻结 baseline 不回写；
//   ⑤ **口径与实现同源**：实现里的三条 SQL 必须真的用这一列——签票写入 / 派生继承 / 登出撤销，
//      任何一条静默漂移（比如登出改回裸 UPDATE login_sessions），本用例当场红。
test('迁移 0025-preview-grant-login-session：血缘列可空、FK SET NULL、幂等、零 baseline 回写、与三条实现 SQL 同源', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0025-preview-grant-login-session.sql'), '0025 存在');

  const sql = fs.readFileSync(path.join(dir, '0025-preview-grant-login-session.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.match(sql, /#429/, '头注释要引用 issue #429');
  assert.match(executable, /ADD COLUMN IF NOT EXISTS login_session_id/, '血缘列必须幂等新增');
  assert.match(executable, /REFERENCES login_sessions \(id\) ON DELETE SET NULL/,
    'FK 只能 SET NULL：offboarding / 停用用户 DELETE login_sessions，RESTRICT 会当场撞 FK');
  assert.doesNotMatch(executable, /\bNOT NULL\b/, '血缘必须可空（存量行不回填，测试桩/无会话签发靠 null 兜住）');
  assert.doesNotMatch(executable, /\bUPDATE\b/, '不做数据回填/修复：存量凭证靠自身 TTL 自然到期');
  assert.match(executable, /CREATE INDEX IF NOT EXISTS preview_grants_login_session_idx[\s\S]*?WHERE state = 'active'/,
    '登出撤销的部分索引（只数 active）');

  // 幂等：全部语句只允许幂等 DDL 形态。
  const statements = executable.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of statements) {
    const head = stmt.trim().replace(/\s+/g, ' ').toUpperCase();
    assert.ok(
      head.startsWith('ALTER TABLE PREVIEW_GRANTS ADD COLUMN IF NOT EXISTS')
        || head.startsWith('CREATE INDEX IF NOT EXISTS'),
      `0025 只允许幂等 DDL，发现：${head.slice(0, 60)}`,
    );
  }

  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('login_session_id'), '冻结 baseline 不得回写 login_session_id');

  // —— 口径与实现同源（三条 SQL 少一条，血缘链就断）——
  const authSrc = fs.readFileSync(path.join(HERE, '../src/auth.js'), 'utf8');
  const previewSrc = fs.readFileSync(path.join(HERE, '../src/preview.js'), 'utf8');
  assert.match(authSrc, /UPDATE login_sessions SET revoked_at = now\(\)[\s\S]*?UPDATE preview_grants[\s\S]*?login_session_id IN \(SELECT id FROM revoked\)/,
    'revokeSession 必须是「吊销会话 + 按血缘撤 active grant」的同语句 CTE（回到裸 UPDATE 即 #429 复发）');
  assert.match(authSrc, /WHERE state = 'active'/, '登出撤权必须只撤 active（#252 口径，used 是历史事实）');
  assert.match(previewSrc, /INSERT INTO preview_grants[\s\S]*?login_session_id[\s\S]*?session\.session\?\.id/,
    '签票必须写入签发时刻的登录会话血缘');
  assert.match(previewSrc, /VALUES \(\$1, \$2, NULL, \$3, \$4, 'session', 'active', \$5, \$5, \$6\)/,
    '派生 session 必须继承血缘（登出才能连派生的 cookie 一起回收）');
  assert.match(previewSrc, /g\.login_session_id \?\? null/, '派生继承读的是 ticket 行的血缘（不是重新猜一个）');
});

// 0026（issue #449）：登录第二因素「邮箱验证码」——`login_email_codes`（一行一枚码）+ `mail_settings`
// （邮件通道单行配置，决策者 2026-11-04/05：SMTP 参数存 DB、口令明文，与 git_hosts.admin_key 同口径）。
// 静态断言口径：
//   ① 幂等（CREATE TABLE/INDEX IF NOT EXISTS，第二遍零 DDL）；
//   ② 敏感面：码只存 hash 列（没有明文列）、口令列叫 smtp_password（不是 *_enc，也不许假装加密）；
//   ③ 单行表靠 CHECK (id = 1) 把「只能有一行」写成 DB 事实；
//   ④ 半套 SMTP 配置不许落库（transport='smtp' ⇒ host/from 必填）；
//   ⑤ 冻结 baseline 不回写；
//   ⑥ 与实现同源：产品 SQL 必须真的读/写这些列（列名漂移即红）。
test('迁移 0026-login-email-codes：两表幂等、码只存 hash、单行配置靠 CHECK、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0026-login-email-codes.sql'), '0026 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0026-login-email-codes.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.match(sql, /#449/, '头注释要引用 issue #449');
  assert.match(executable, /CREATE TABLE IF NOT EXISTS login_email_codes/);
  assert.match(executable, /CREATE INDEX IF NOT EXISTS login_email_codes_pending_idx\s+ON login_email_codes \(pending_token_hash, created_at DESC\)/);
  assert.match(executable, /code_hash\s+text NOT NULL/, '码只存 sha256 列');
  assert.doesNotMatch(executable, /\bcode\s+text/, '绝不许有明文码列');
  assert.match(executable, /attempts\s+int NOT NULL DEFAULT 0/);
  assert.match(executable, /max_attempts\s+int NOT NULL/);
  assert.match(executable, /resend_count\s+int NOT NULL DEFAULT 0/);
  assert.match(executable, /consumed_at\s+timestamptz/, '单次消费列可空');

  assert.match(executable, /CREATE TABLE IF NOT EXISTS mail_settings/);
  assert.match(executable, /id\s+int PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/, '单行表：约束写成 DB 事实');
  assert.match(executable, /CHECK \(transport IN \('disabled', 'smtp'\)\)/);
  assert.match(executable, /smtp_password\s+text/, '口令列是明文（内网 relay 口径）');
  assert.doesNotMatch(executable, /smtp_password_enc|MAIL_SECRET_KEY/, '不做本地加密：不许留假加密列/密钥');
  assert.match(executable, /CHECK \(transport <> 'smtp' OR \(smtp_host IS NOT NULL AND smtp_from IS NOT NULL\)\)/,
    '半套 SMTP 配置不许落库');
  assert.match(executable, /updated_by\s+uuid/, 'updated_by 只记 id，不建 FK（删用户不该被配置行拦住）');
  assert.doesNotMatch(executable, /updated_by uuid REFERENCES/, 'updated_by 不得建 FK');

  // 幂等：全部语句只允许幂等 DDL（DO 块是纯读证据，允许）。
  const withoutDo = executable.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');
  const statements = withoutDo.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  assert.ok(statements.length >= 3, `语句数异常：${statements.length}`);
  for (const stmt of statements) {
    const head = stmt.replace(/\s+/g, ' ').trim().toUpperCase();
    assert.ok(
      head.startsWith('CREATE TABLE IF NOT EXISTS') || head.startsWith('CREATE INDEX IF NOT EXISTS'),
      `0026 只允许幂等 DDL，发现：${head.slice(0, 60)}`,
    );
  }

  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('login_email_codes'), '冻结 baseline 不得回写 login_email_codes');
  assert.ok(!baseline.includes('mail_settings'), '冻结 baseline 不得回写 mail_settings');

  // —— 与实现同源（列名/表名漂移即红）——
  const codeSrc = fs.readFileSync(path.join(HERE, '../src/login-email-code.js'), 'utf8');
  for (const col of ['pending_token_hash', 'code_hash', 'expires_at', 'attempts', 'max_attempts', 'resend_count', 'consumed_at']) {
    assert.ok(codeSrc.includes(col), `login-email-code.js 必须真的读写 ${col}`);
  }
  const providerSrc = fs.readFileSync(path.join(HERE, '../src/mail-provider.js'), 'utf8');
  assert.match(providerSrc, /FROM mail_settings WHERE id = 1/, 'provider 读的是单行表（id = 1）');
  for (const col of ['smtp_host', 'smtp_port', 'smtp_secure', 'smtp_user', 'smtp_password', 'smtp_from']) {
    assert.ok(providerSrc.includes(col), `mail-provider.js 必须读 ${col}`);
  }
  const configSrc = fs.readFileSync(path.join(HERE, '../src/config.js'), 'utf8');
  assert.ok(!configSrc.includes('MAIL_SMTP_'), 'SMTP 参数不进 env（决策者 2026-11-04）');
  assert.ok(!configSrc.includes('MAIL_SECRET_KEY'), '不做本地加密（决策者 2026-11-05）');
  assert.match(configSrc, /MAIL_TRANSPORT/, 'env 只剩急停开关');
});

// 0027（issue #456）：管理台证书生命周期的**审计/历史**表 `tls_certificates`。
// 静态断言口径（每条都能被打红）：
//   ① 幂等（CREATE TABLE/INDEX IF NOT EXISTS，第二遍零 DDL）；
//   ② **不是真相源**：表里没有任何 PEM/私钥列（真相是盘上的证书文件，私钥只落盘）；
//   ③ `fingerprint_sha256` NOT NULL 且与 Node `fingerprint256` 同形（冒号大写）；
//   ④ `kind` 只有 upload/rollback 两态（CHECK 写成 DB 事实）；
//   ⑤ 零 baseline 回写（schema.sql 一个字节都不许改）；
//   ⑥ 与实现同源：`tls-cert.js` 的 INSERT 必须真的写这些列（列名漂移即红）。
test('迁移 0027-tls-certificates：审计表幂等、无 PEM 列、kind 两态、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0027-tls-certificates.sql'), '0027 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0027-tls-certificates.sql'), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  assert.match(sql, /#456/, '头注释要引用 issue #456');
  assert.match(executable, /CREATE TABLE IF NOT EXISTS tls_certificates/);
  assert.match(executable, /CREATE INDEX IF NOT EXISTS tls_certificates_uploaded_at_idx\s+ON tls_certificates \(uploaded_at DESC\)/);

  // 列清单：一个不少、一个不多（多出来的列最容易是「顺手存了 PEM」）
  for (const col of ['subject_cn', 'sans', 'issuer_cn', 'not_before', 'not_after',
    'fingerprint_sha256', 'kind', 'uploaded_by', 'uploaded_at']) {
    assert.match(executable, new RegExp(`\\b${col}\\b`), `缺列 ${col}`);
  }
  assert.match(executable, /sans\s+text\[\] NOT NULL DEFAULT '\{\}'/);
  assert.match(executable, /fingerprint_sha256 text NOT NULL/);
  assert.match(executable, /CHECK \(kind IN \('upload', 'rollback'\)\)/, 'kind 只有两态');
  assert.match(executable, /uploaded_by\s+uuid REFERENCES users \(id\) ON DELETE SET NULL/);

  // 敏感面：**任何形态的证书/私钥正文都不许入库**（真相在盘上）。
  assert.doesNotMatch(executable, /\b(cert_pem|key_pem|certificate_pem|private_key)\b/i, '表里不许有 PEM 列');
  assert.doesNotMatch(executable, /BEGIN (CERTIFICATE|PRIVATE KEY)/, 'SQL 里不许出现 PEM 正文');

  // 幂等：全部语句只允许幂等 DDL（DO 块是纯读证据，允许）。
  const withoutDo = executable.replace(/DO \$\$[\s\S]*?END \$\$;/g, '');
  const statements = withoutDo.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
  assert.ok(statements.length >= 2, `语句数异常：${statements.length}`);
  for (const stmt of statements) {
    const head = stmt.replace(/\s+/g, ' ').trim().toUpperCase();
    assert.ok(
      head.startsWith('CREATE TABLE IF NOT EXISTS') || head.startsWith('CREATE INDEX IF NOT EXISTS'),
      `0027 只允许幂等 DDL，发现：${head.slice(0, 60)}`,
    );
  }

  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('tls_certificates'), '冻结 baseline 不得回写 tls_certificates');

  // —— 与实现同源（列名/表名漂移即红）——
  const codeSrc = fs.readFileSync(path.join(HERE, '../src/tls-cert.js'), 'utf8');
  assert.match(codeSrc, /INSERT INTO tls_certificates/, 'tls-cert.js 必须真的落台账');
  for (const col of ['subject_cn', 'sans', 'issuer_cn', 'not_before', 'not_after', 'fingerprint_sha256', 'kind', 'uploaded_by']) {
    assert.ok(codeSrc.includes(col), `tls-cert.js 的 INSERT 必须写 ${col}`);
  }
});

// 0028（2026-11-06，per-user「邮件验证码」开关）：布尔列、NOT NULL DEFAULT false、可重放、零 baseline 回写。
// 默认 false 是**有意的行为变化**：升级后「开了全局邮件通道」不再自动要求所有用户输邮箱码，
// 必须由管理员逐个启用（判据见 login-email-code.test.js 的 chooseSecondFactor 参数化表）。
test('迁移 0028-user-mail-otp：布尔列幂等、NOT NULL DEFAULT false、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0028-user-mail-otp.sql'), '0028 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, '0028-user-mail-otp.sql'), 'utf8');
  assert.match(sql, /ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS mail_otp_enabled boolean NOT NULL DEFAULT false/,
    'ADD COLUMN IF NOT EXISTS 可重放 + NOT NULL DEFAULT false（默认不启用）');
  assert.ok(!/UPDATE\s+users/i.test(sql), '零数据回填（不猜存量用户的意图）');
  assert.ok(!sql.includes('password_hash') && !sql.includes('totp_secret'), '不碰秘密列');
});

// 0029（2026-11-09，#472 片 A：per-user「文件上传」开关）—— 同一族形状：布尔列、幂等、零回填、零 baseline 回写。
// 为什么默认 false：上传是**往用户磁盘写文件**的能力，与 TOTP / 邮件验证码同一口径（决策 1）——
// 升级后没有人自动获得它，必须管理员逐个打开（显式优于隐式）。
test('迁移 0029-user-file-upload：布尔列幂等、NOT NULL DEFAULT false、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0029-user-file-upload.sql'), '0029 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');
  // 编号连续无空洞（0001..0029 一个不少）——新迁移**只能追加在末尾**，插中间这里就红。
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, '0029-user-file-upload.sql'), 'utf8');
  // ① 静态判据：幂等（可重放）+ 默认值契约
  assert.match(sql, /ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS file_upload_enabled boolean NOT NULL DEFAULT false/,
    'ADD COLUMN IF NOT EXISTS 可重放 + NOT NULL DEFAULT false（默认不放开上传）');
  assert.ok(!/UPDATE\s+users/i.test(sql), '零数据回填（存量用户全部吃 DEFAULT false）');
  assert.ok(!sql.includes('password_hash') && !sql.includes('totp_secret'), '不碰秘密列');
  // ② baseline 冻结：本列**只能**走增量迁移（schema.sql 的 sha256 已写进迁移台账，改一字节现存库就拒启）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('file_upload_enabled'),
    'docs/data/schema.sql（baseline）不许出现 0029 的列 —— baseline sha256 冻结，DDL 只走增量文件');
  // ③ 代码侧的消费点必须与这一列同名（拼错列名在单测里会静默地「永远 false」）
  for (const file of ['../src/admin.js', '../src/auth.js']) {
    const codeSrc = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.ok(codeSrc.includes('file_upload_enabled'), `${file} 必须读写这一列`);
  }
});

// 0030（2026-11-12，工单 feat-261110-02）：**允许用 TOTP 登录**单独成一列。
// 与 0028/0029 同族形状（布尔列、幂等、零回填、零 baseline 回写），但**默认值方向相反：true**。
// 为什么是 true：这一列不是「新能力要不要放开」，而是「把既有行为拆出一维来」——
// `totp_secret` 存在就意味着今天能用 TOTP；默认 false 会在升级那一刻把所有存量 TOTP 用户
// 静默打成口令直通（用户第二天发现要邮箱码/直接进了，而没人做过这个决定）。
test('迁移 0030-user-totp-login-enabled：布尔列幂等、NOT NULL DEFAULT true、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0030-user-totp-login-enabled.sql'), '0030 存在');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, '0030-user-totp-login-enabled.sql'), 'utf8');
  assert.match(
    sql,
    /ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS totp_login_enabled boolean NOT NULL DEFAULT true/,
    'ADD COLUMN IF NOT EXISTS 可重放 + NOT NULL **DEFAULT true**（存量 TOTP 用户行为一字不变）',
  );
  assert.ok(!/UPDATE\s+users/i.test(sql), '零数据回填（存量全部吃 DEFAULT true）');
  // ⚠ 只看**语句**：本文件的注释里就要写 `totp_secret`（正是为了说清「不清密钥」）。
  const statements = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  assert.ok(!/\btotp_secret\b/.test(statements), '不许动 `totp_secret`：关掉「允许用 TOTP 登录」**不清密钥**，随时可再打开');
  // baseline 冻结：本列只走增量迁移（schema.sql 的 sha256 已进迁移台账）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('totp_login_enabled'),
    'docs/data/schema.sql（baseline）不许出现 0030 的列');
  // 消费点必须与列同名（拼错列名在单测里会静默地「永远 true / 永远 false」）
  for (const file of ['../src/admin.js', '../src/auth.js']) {
    const codeSrc = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.ok(codeSrc.includes('totp_login_enabled'), `${file} 必须读写这一列`);
  }
});

// 0031（2026-11-12，issue #497 / 工单 feat-261112-01）：`users.last_activity_at` —— 「最近一次用户输入」。
// 与 0028/0029/0030 **不是**同族形状，三处必须单独钉：
//   ① **可空且无默认值**（那三列都是 `NOT NULL DEFAULT <常量>`）：可空 = 「从未活动」必须能被表达，
//      无默认值 = 没人写过它时不许看起来像刚刚活动过；
//   ② **有一次性回填**（那三列都是零回填）：谓词必须是 `WHERE last_activity_at IS NULL`，
//      否则重放会把老账号的时间一路改到「最新的一条消息」，并且第二遍不再是零操作；
//   ③ **不建索引**：它只作返回列，不参与过滤/排序（口径同 `last_login_at`）。
test('迁移 0031-user-last-activity-at：可空无默认列幂等、回填只动 NULL 行、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0031-user-last-activity-at.sql'), '0031 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, '0031-user-last-activity-at.sql'), 'utf8');
  // ⚠ 只看**语句**：本文件的注释与守卫消息里就要写 `NOT NULL` / `默认值`（正是为了说清可空是契约）。
  const statements = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
  // ① 幂等 + 形态契约：可空（无 NOT NULL）、无 DEFAULT
  assert.match(statements, /ALTER TABLE users\s+ADD COLUMN IF NOT EXISTS last_activity_at timestamptz\s*;/,
    'ADD COLUMN IF NOT EXISTS last_activity_at timestamptz（可空、无默认值、可重放）');
  const alter = /ALTER TABLE users\s+(ADD COLUMN[^;]*);/.exec(statements);
  assert.ok(alter, '有 ALTER TABLE users ADD COLUMN 语句');
  assert.ok(!/\bNOT NULL\b/.test(alter[1]), '列本身不许 NOT NULL：从未活动的账号必须是 NULL');
  assert.ok(!/\bDEFAULT\b/.test(alter[1]), '列本身不许 DEFAULT：没人写过它时不许看起来像刚刚活动过');
  // ② 回填的谓词与口径（少了 `IS NULL` 第二遍就不是零操作；少了 synthetic=false 就把宿主注入的话当人话）
  assert.match(statements, /\bUPDATE users\b[\s\S]*\bSET last_activity_at\b/, '有一次性回填 UPDATE');
  assert.match(statements, /WHERE u\.id = s\.user_id\s+AND u\.last_activity_at IS NULL/,
    '回填只动 last_activity_at IS NULL 的行（重放第二遍 = 零行）');
  assert.match(statements, /FROM messages m\s+JOIN chat_sessions cs ON cs\.id = m\.session_id/, '回填按 messages→chat_sessions 取 user_id');
  assert.match(statements, /WHERE m\.role = 'user'\s+AND m\.synthetic = false/, "回填只算 role='user' AND synthetic=false");
  assert.match(statements, /MAX\(m\.created_at\)/, '回填取 MAX(created_at)');
  // ③ 不建索引（只作返回列；写侧是「每次发消息」这条高频路径）
  assert.ok(!/CREATE (UNIQUE )?INDEX/i.test(sql), '本列不建索引：只作返回列，不参与过滤/排序');
  // ④ 重放证据必须打印出来（重放第二遍 0 行是看得见的，不是靠人相信）
  assert.match(statements, /GET DIAGNOSTICS n_updated = ROW_COUNT/, '回填写入条数有证据');
  assert.match(statements, /RAISE NOTICE '0031[\s\S]*回填/, '有 RAISE NOTICE 作重放证据');
  // ⑤ 守卫不许静默放行（可空/无默认是契约，漂了要当场炸）
  assert.match(statements, /RAISE EXCEPTION '0031[\s\S]*NOT NULL/, '有「变成 NOT NULL 就炸」的守卫');
  assert.match(statements, /RAISE EXCEPTION '0031[\s\S]*默认值/, '有「带了默认值就炸」的守卫');
  // ⑥ baseline 冻结：本列只走增量迁移（schema.sql 的 sha256 已写进迁移台账，改一字节现存库全部拒启）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('last_activity_at'),
    'docs/data/schema.sql（baseline）不许出现 0031 的列 —— baseline sha256 冻结，DDL 只走增量文件');
  // 口径必须落到文档（不是只写在 SQL 的注释里）
  const modelDoc = fs.readFileSync(path.join(HERE, '../../docs/data/model.md'), 'utf8');
  assert.ok(modelDoc.includes('last_activity_at'), 'docs/data/model.md §1.1 必须写这一列的口径');
  // 消费点必须与列同名：拼错列名在单测里会静默地「永远 null」（= 每个人都被显示成「从未活动」），
  // 真库里则是一条 42703 把整条发送路炸掉。三个读写方逐个钉（M2 的后端面；前端 store 在 M3 的 spec 里钉）。
  for (const [file, label] of [
    ['../src/sessions.js', '写入点①：唯一发送路'],
    ['../src/queued-inputs.js', '写入点②：运行中入队'],
    ['../src/admin.js', '读侧：user DTO（safeUser / listUsers / 两条 CTE）'],
  ]) {
    const codeSrc = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.ok(codeSrc.includes('last_activity_at'), `${label}（${file}）必须读写这一列`);
  }
  // 写入点的字面形状也要在这里钉一道：迁移与写入点是同一份契约的两半（不节流、不带值、无 RETURNING）
  for (const file of ['../src/sessions.js', '../src/queued-inputs.js']) {
    const codeSrc = fs.readFileSync(path.join(HERE, file), 'utf8');
    assert.match(codeSrc, /UPDATE users SET last_activity_at = now\(\) WHERE id = \$1/,
      `${file} 必须用「now() + 只按 id」这一句（节流或带值 = 偷偷换口径）`);
  }
});

// 0032（2026-11-13，issue #503 / 工单 fix-261113-01）：**撤表**迁移 —— 撤 0010 改名保留的 `llm_models_retired`
// / `llm_providers_retired`，以及 261027 shape4 修数据时手工建的备份夹具 `transcript_rounds_shape4_bak_20261027`。
// 三条**会炸的**判据（每条都是一次真事故，不是风格）：
//   ① **三句全带 `IF EXISTS`**：第三张表**不在任何迁移文件里**（手工建的夹具 ⇒ 全新库根本没有它）
//      ⇒ 写成裸 `DROP TABLE` 会让**新库首次起栈就炸**（`MIGRATE_ON_START=1`，portal 在监听端口前应用）。
//   ② **删除顺序**：`llm_models_retired` 必须排在 `llm_providers_retired` **之前** —— 外键
//      `llm_models_provider_id_fkey`（child `llm_models_retired`.provider_id → parent `llm_providers_retired`.id，
//      0002:31 建、0010 只 RENAME 表而 PG **不连带重命名约束**）⇒ 先撤父表会被 2BP01 顶回来。
//      ⚠ 这条只能比**语句**的位置：本文件的头注释里两个名字都出现过，整文件 indexOf 会先命中注释而假绿。
//   ③ **不用 `CASCADE`**：顺序已经解决依赖，CASCADE 会把没预料到的依赖（后来挂上来的视图/外键）一起带走。
// 静态断言到此为止；「全新库真的不炸 + 重放 rc=0」的证明在真库闸 `portal/test/migrate-fresh-db.test.js`。
test('迁移 0032-drop-retired-tables：三句 IF EXISTS、子表先撤（外键顺序）、无 CASCADE、零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0032-drop-retired-tables.sql'), '0032 存在');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, '0046 为当前最后迁移（连续无空洞）');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, '0032-drop-retired-tables.sql'), 'utf8');
  // ⚠ 位置判定只看**去掉整行注释之后**的语句区（头注释里两个名字都出现过）。
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  // —— ① 三句 DROP 全在，且全带 IF EXISTS（第三张表全新库不存在，裸 DROP = 新库起不来）——
  const dropped = executable.match(/DROP TABLE IF EXISTS [a-z0-9_]+;/g) ?? [];
  assert.deepEqual(
    [...dropped].sort(),
    [
      'DROP TABLE IF EXISTS llm_models_retired;',
      'DROP TABLE IF EXISTS llm_providers_retired;',
      'DROP TABLE IF EXISTS transcript_rounds_shape4_bak_20261027;',
    ].sort(),
    `只能撤这三张表，一个不多一个不少（多撤 = 顺手清了没取证的东西），实际：${JSON.stringify(dropped)}`,
  );
  assert.equal((executable.match(/DROP TABLE/g) ?? []).length, 3, '三条 DROP，没有第四条');
  assert.doesNotMatch(executable, /DROP TABLE (?!IF EXISTS)/, '一句裸 DROP 都不许有（全新库没有 shape4 那张夹具）');

  // —— ② 外键顺序的机器锁：子表 llm_models_retired 必须**先**撤 ——
  const pChild = executable.indexOf('DROP TABLE IF EXISTS llm_models_retired;');
  const pParent = executable.indexOf('DROP TABLE IF EXISTS llm_providers_retired;');
  assert.notEqual(pChild, -1, '有撤子表的语句');
  assert.notEqual(pParent, -1, '有撤父表的语句');
  assert.ok(pChild < pParent,
    'llm_models_retired（外键 llm_models_provider_id_fkey 的 child）必须排在 llm_providers_retired 之前');
  // 依赖本身的出处也要在（外键是 0002 的 REFERENCES 建的；0010 只 RENAME 表 ⇒ 约束名仍是旧表名那一套）。
  const m0002 = fs.readFileSync(path.join(dir, '0002-llm-config.sql'), 'utf8');
  assert.match(m0002, /provider_id\s+uuid NOT NULL REFERENCES llm_providers \(id\)/,
    '依赖依据：0002 里 llm_models.provider_id 对 llm_providers 的 REFERENCES（就是那条 fkey）');

  // —— ③ 不用 CASCADE：顺序已解决依赖，CASCADE 会静默带走没预料到的依赖 ——
  assert.doesNotMatch(executable, /\bCASCADE\b/i, '不许 CASCADE（顺序已经解决依赖，CASCADE 会顺手多撤）');

  // —— 幂等 + 纪律：只有 SET lock_timeout / DROP TABLE IF EXISTS / 纯读 DO 三类语句 ——
  assert.match(executable, /^SET lock_timeout = '5s';$/m, 'DDL 按纪律设 lock_timeout（照 0016）');
  const doBlocks = executable.match(/DO \$do\$[\s\S]*?\$do\$/g) ?? [];
  // ⚠ 查 BEGIN/COMMIT 必须先摘掉 DO 块：plpgsql 自己的 `BEGIN … END` 与「迁移别开事务」是两件事。
  const withoutDo = executable.replace(/DO \$do\$[\s\S]*?\$do\$/g, '');
  assert.doesNotMatch(withoutDo, /^\s*(BEGIN|COMMIT)\b/im, 'runner 在单事务内执行，迁移自己不写 BEGIN/COMMIT');
  for (const block of doBlocks) {
    const code = block.replace(/'(?:[^']|'')*'/g, "''"); // 剔掉字面量：RAISE 文案里会出现 DROP 这类词
    assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT)\b/i,
      `0032 的 DO 块必须纯读（可重放），发现写操作：${code.slice(0, 80)}`);
  }
  const statements = executable
    .replace(/DO \$do\$[\s\S]*?\$do\$/g, '@@DO@@')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    if (stmt === '@@DO@@') continue;
    const head = stmt.replace(/\s+/g, ' ').trim().toUpperCase();
    assert.ok(
      head.startsWith('SET LOCK_TIMEOUT') || head.startsWith('DROP TABLE IF EXISTS'),
      `0032 只允许 SET lock_timeout / DROP TABLE IF EXISTS / 纯读 DO，发现：${head.slice(0, 70)}`,
    );
  }

  // —— 依据与「单向门」必须在头注释里（已应用迁移不可再改 ⇒ 解释只能落在文件头）——
  assert.match(sql, /#503/, '头注释要引用 issue #503');
  assert.match(sql, /fix-261113-01/, '头注释要引用工单代号');
  assert.match(sql, /单向门/, '头注释要写清这是单向门：撤后「重放 0010 的 RENAME」这条路不再可用');
  assert.match(sql, /只能从 dump 恢复/, '头注释要写清撤后的恢复路径只有 dump');
  assert.match(sql, /pg_dump/, '头注释要求撤前 pg_dump 这三张表并落到部署记录');
  assert.match(sql, /pg_stat_user_tables/, '头注释要留给其它部署自查的撤前判据 SQL（last_seq_scan/last_idx_scan）');
  assert.match(sql, /llm_models_provider_id_fkey/, '头注释要点出那条外键的名字（顺序的依据）');
  assert.match(sql, /shape4/, '头注释要说清第三张表的来历（手工夹具，不在任何迁移里）');

  // —— 零 baseline 回写：这三张表本来就不在冻结 baseline 里（0002 之后才建、0010 才改名）——
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  for (const name of ['llm_models_retired', 'llm_providers_retired', 'transcript_rounds_shape4_bak_20261027']) {
    assert.ok(!baseline.includes(name), `冻结 baseline 不得出现 ${name}（schema.sql 的 sha256 已进迁移台账）`);
  }

  // —— ⚠ 0010 不许回改（runner 记 sha256，改一字节 = 现存库全部拒启）：撤表**不影响**它那两个 RENAME，
  //    所以本文件上方对 0010 文本的断言（`RENAME TO *_retired`）在这里继续成立，一条都不许删。——
  const m0010 = fs.readFileSync(path.join(dir, '0010-litellm-bindings.sql'), 'utf8');
  assert.match(m0010, /ALTER TABLE IF EXISTS llm_providers RENAME TO llm_providers_retired;/,
    '0010 的字节不许动：改名语句仍在原处（撤表由 0032 做，不是回头改 0010）');
  assert.match(m0010, /ALTER TABLE IF EXISTS llm_models RENAME TO llm_models_retired;/, '同上（子表）');
  assert.doesNotMatch(m0010, /DROP TABLE/i, '0010 仍然只改名不撤表（撤是 0032 的事）');
});

// 0033（2026-11-13，issue #502 / 工单 feat-261113-02）：**形态 M 之后是一支纯清理迁移**
// —— 上一版它还带半截 DDL（`CREATE UNIQUE INDEX run_events_run_partial_key`），而形态 M 把终态正文
// 并进**既有的** `run_end.payload` ⇒ 那条索引保护的行类型根本不再被写入 ⇒ DDL 整段删除。
// 静态断言（跑真库的那一半在 `portal/test/delta-not-persisted-db.test.js`，TEST_DATABASE_URL 缺席时跳过）：
//   ① **零 DDL**：没有 CREATE / DROP / ALTER —— 一支清理型迁移动索引，就是往「行数 ×0.8%」的账上
//      偷偷加长期成本（写入路径每次 INSERT 多维护一棵树，收益却从没拿过）。
//   ② **残留碎片必须让迁移失败**（`RAISE EXCEPTION`，不是 `RAISE WARNING`）：带残留记成功
//      = `schema_migrations` 落下「已应用」而表里还躺着几十万行，下一个看体积数据的人会当 #502 已落地。
//   ③ **`VACUUM` 不在文件里**：迁移 runner 单事务（`portal/src/migrate.js`），PG 的 VACUUM
//      不能在事务块里跑 ⇒ 写进来就是整个迁移失败、portal 拒绝启动。
//   ④ **锁窗口有界 + 分批**：`SET LOCAL lock_timeout` / `FOR UPDATE SKIP LOCKED` / `LIMIT v_batch`。
//   ⑤ **进度 NOTICE 的编号必须是 0033**（原文件写成 `'0032/0033'` 是笔误）：迁移应用后 NOTICE 文案
//      就进了别人的排障记录，改不了 ⇒ 在落库前钉住。
//   ⑥ B/C 两个议题（`run_events` 的 5 个索引、`client_event_id` 里重复 run_id）在头注释里**明确
//      表态保留、不换键**，并指向实测数 §8.125 —— 否则下一个人会重新发现一遍并再开一单。
test('迁移 0033-delta-events-not-persisted：形态 M 是纯清理（零 DDL）、残留必须 EXCEPTION、VACUUM 不进文件', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0033-delta-events-not-persisted.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0033 存在');
  // ⚠ 0034（`prune-stale-run-checkpoints`）追加之后，本行从「0033 是最后一支」改成「0033 是倒数第二支」；
  // 0035（`macro-platform`，issue #524）追加之后本行退一支；0037（`notifications-and-origin`，
  // issue #526）再退一支 —— 口径不变：靠**绝对位置**钉住。
  // 而不是「0033 必须永远排末位」——后者已经被上面那 19 处 head 断言接管（它们现在钉 0037）。
  assert.equal(files[files.length - 17], file, '0033 是倒数第十三支（0034..0042 + 0043-platform-prompts + 0044-system-metrics / 0045-macro-skipped-reason-review-unavailable 追加在它后面，不许回头插队）');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 只看**去掉整行注释之后**的语句区（头注释里"索引""VACUUM"这些词都会出现，整文件 indexOf 会假绿）。
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');

  // —— ① 零 DDL ——
  assert.equal(/\bCREATE\b/i.test(executable), false, '形态 M 的 0033 不得有任何 CREATE（那条 partial_output 唯一索引已随设计删除）');
  assert.equal(/\bDROP\b/i.test(executable), false, '也不得有 DROP（B 议题的 5 个索引本单表态保留）');
  assert.equal(/\bALTER\b/i.test(executable), false, '不得有 ALTER（本单零新列、零新类型）');
  assert.equal(executable.includes('partial_output'), false,
    '语句区不该再出现 partial_output：那种行不再被写入，清理谓词里也不该带上它（历史存量里它归 run_end 读侧负责）');

  // —— ② 观测必须让迁移失败 ——
  assert.match(executable, /RAISE EXCEPTION '0033: 清完之后仍量到/,
    '清完仍量到碎片 ⇒ 必须 EXCEPTION（WARNING 不挡 COMMIT = 把「没清干净」这个事实吞掉）');
  assert.equal(/RAISE WARNING/.test(executable), false, '本文件没有任何「报告但继续」的观测段');

  // —— ③ VACUUM 不进迁移 ——
  assert.equal(/^\s*VACUUM/im.test(executable), false, 'VACUUM 不能在事务块里跑（迁移 runner 是单事务）');
  assert.match(sql, /VACUUM cannot run inside a transaction|不能跑在事务块里/, '理由要写在文件里，别等下一个人再撞一次');

  // —— ④ 分批与锁窗口 ——
  assert.match(executable, /SET LOCAL lock_timeout/, '锁窗口必须有界（拿不到锁就放弃整次迁移，可重放）');
  assert.match(executable, /SET LOCAL statement_timeout/, 'DO 块是一条语句 ⇒ statement_timeout 必须给得宽（照文件里的雷）');
  assert.match(executable, /FOR UPDATE SKIP LOCKED/, '每批只锁自己要删的行，清存量永远排在并发写之后');
  assert.match(executable, /LIMIT v_batch/, '必须分批，不能一枪删几十万行');
  assert.match(executable, /type IN \('assistant_delta', 'reasoning_delta', 'tool_call_delta'\)/,
    '清理名单 = 引擎 stream 档那三类（写入侧同源；这里只能手抄，理由在文件头）');

  // —— ⑤ NOTICE 编号笔误 ——
  assert.equal(/0032\/0033/.test(sql), false, "进度 NOTICE 的编号必须写 '0033'（迁移应用后文案不可再改）");
  assert.match(sql, /RAISE NOTICE '0033[: ]/, '结论 NOTICE 以 0033 开头（排障时能认出是谁在说话）');

  // —— ⑥ B/C 议题表态 + 指向实测数 ——
  assert.match(sql, /本单全部保留、不换键/, 'B/C 两个议题要明确表态（否则会被重新发现并再开一单）');
  assert.match(sql, /§8\.125/, '要指向实测数那份台账（重开议题的人先看数）');
});

// 0034（2026-11-14，issue #502 的遗留账 / 工单 fix-261114-01）：`run_checkpoints` 的**纯清理**迁移。
// 它清的是「永不再读」的引擎 run snapshot：run 作用域 + run 已终态（谓词 a），以及会话已不活跃的
// session 作用域行（谓词 b：已归档 **或** >14 天没动）。体积几乎全在 TOAST（dev 现查 87 行 / 4,644,864 B
// 里 heap 只占 81,920 B），而写侧是 revision-gated 覆盖写 ⇒ 每覆盖一次留一整版死 TOAST。
// 静态闸（真库那一半在 `portal/test/prune-checkpoints-db.test.js`，无 TEST_DATABASE_URL 时整体 skip）：
//   ① **零 DDL**：没有 CREATE / DROP / ALTER —— 本单只删行，索引与列一个都不动。
//   ② **残留必须 EXCEPTION**（不许 WARNING）：带残留记成功 = 台账落下「已清理」而表里还躺着几十 MB。
//   ③ **`VACUUM` 一次都不出现在语句区**（连 NOTICE 文案都不写这个词，见文件里那段说明）：
//      迁移 runner 是单事务，`VACUUM cannot run inside a transaction block` ⇒ 写进来就是 portal 拒启。
//   ④ **`v_cutoff` 纪律**：`run_checkpoints.updated_at` 与截止时刻的比较**必须逐字同形且恰好 4 处**
//      （两条删除谓词 + 末尾两条残留检查）。少一处 = 有人在残留检查里换了另一把钟（`now()` 是事务起点，
//      但块内每条语句取新快照 ⇒ 迁移期间刚终态的 run 会被当成「残留」误炸）；多一处 = 有人新增了
//      一条没跟 cutoff 对齐的谓词。这个「恰好 4」是**可数**的，不是装饰。
//   ⑤ **锁子句不进 DELETE 的子查询**（照 0033 的写法）：`SELECT … FOR UPDATE SKIP LOCKED … LIMIT` 独立一句，
//      `DELETE … WHERE ctid = ANY (v_ids)` 另起一句 —— 反过来的话 PG 直接报错（数据修改语句不带锁子句）。
//   ⑥ **只删 `run_checkpoints` 一张表的行**：`DELETE FROM` 恰好 2 处（两条谓词各一），且目标恒为该表。
test('迁移 0034-prune-stale-run-checkpoints：纯清理（零 DDL）、cutoff 逐字同形、残留必须 EXCEPTION、VACUUM 不进文件', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0034-prune-stale-run-checkpoints.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0034 存在');
  assert.equal(files[files.length - 16], file, '0034 是倒数第十三支（新迁移只能追加，不回改已应用的编号）；0035..0045 之后它不再是末位');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 只看**去掉整行注释之后**的语句区（头注释里 "VACUUM""索引""DELETE" 这些词都会出现，整文件判会假绿/假红）。
  const executable = sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n');
  const count = (re) => (executable.match(re) || []).length;

  // —— ① 零 DDL（本单只删行）——
  assert.equal(/\bCREATE\b/i.test(executable), false, '0034 不得有 CREATE（不新增索引/列/表）');
  assert.equal(/\bDROP\b/i.test(executable), false, '不得有 DROP（`run_checkpoints_session_uidx` 是写侧 ON CONFLICT 的目标，撤不得）');
  assert.equal(/\bALTER\b/i.test(executable), false, '不得有 ALTER（零新列、零新类型）');

  // —— ③ VACUUM 不进迁移（ runner 单事务）——
  assert.equal(/VACUUM/i.test(executable), false,
    '语句区连 NOTICE 文案都不许出现 VACUUM：它在事务块里必炸，磁盘回收是部署侧的下一步（本条是最严口径，宁可改文案）');
  assert.match(sql, /VACUUM cannot run inside a transaction/, '为什么 VACUUM 不在文件里，理由必须写在文件里（别等下一个人再撞一次）');

  // —— ② 观测必须让迁移失败 ——
  assert.match(executable, /RAISE EXCEPTION '0034: 截止时刻/,
    '清完仍量到残留 ⇒ 必须 EXCEPTION（WARNING 不挡 COMMIT = 把「没清干净」这个事实吞掉）');
  assert.equal(/RAISE WARNING/.test(executable), false, '本文件没有任何「报告但继续」的观测段');
  assert.match(sql, /RAISE NOTICE '0034[: ]/, '结论 NOTICE 以 0034 开头（排障时能认出是谁在说话）');

  // —— ④ cutoff 纪律 ——
  assert.match(executable, /v_cutoff timestamptz := now\(\);/, '截止时刻必须在 DECLARE 里捕获一次（块内不再取别的钟）');
  assert.equal(count(/rc\.updated_at < v_cutoff/g), 4,
    '本表 updated_at 与截止时刻的比较必须恰好 4 处（2 条删除谓词 + 2 条残留检查）——少一处就是残留检查换了另一把钟');
  assert.equal(count(/updated_at < now\(\) - interval '14 days'/g), 2,
    '会话 14 天窗口只许出现在 `chat_sessions.updated_at` 上（删除 + 残留各一处），不许落到 run_checkpoints 自己头上');

  // —— ⑤ 分批与锁窗口 ——
  assert.match(executable, /SET LOCAL lock_timeout/, '锁窗口必须有界（拿不到锁就放弃整次迁移，可重放）');
  assert.match(executable, /SET LOCAL statement_timeout/, 'DO 块是一条语句 ⇒ statement_timeout 必须给得宽（照 0033 那颗雷）');
  assert.match(executable, /FOR UPDATE SKIP LOCKED/, '每批只锁自己要删的行，清存量永远排在并发写之后');
  assert.match(executable, /v_batch constant int := 2000/, '每批 ≤ 2000 行（不是一枪删全表）');
  assert.equal(count(/LIMIT v_batch/g), 2, '两条谓词各自分批（一条一批，漏一条就是那一条整表扫删）');
  assert.equal(count(/DELETE FROM run_checkpoints WHERE ctid = ANY \(v_ids\)/g), 2,
    '锁子句留在独立的 SELECT 里、DELETE 只按 ctid 删（PG 不允许数据修改语句带锁子句）');

  // —— ⑥ 只删一张表的行 ——
  assert.equal(count(/DELETE FROM/g), 2, '整个文件只有两条 DELETE，且都指向 run_checkpoints（不许顺手清别的表）');

  // —— 两条谓词的语义锚点（写错方向就是删错行，这里逐条钉）——
  assert.equal(count(/transcript_key IS NULL/g), 2,
    '(a) 必须带 `transcript_key IS NULL`：session 行的 run_id 也是真 run 且通常也早终态，少了就误删活跃会话的快照');
  assert.equal(count(/transcript_key::uuid/g), 2,
    '(b) 必须显式转 uuid（`chat_sessions.id` 是 uuid、`transcript_key` 是 text；不转 = operator does not exist，真库现证见 prune-checkpoints-db.test.js）');
  assert.equal(count(/status IN \('finished', 'failed'\)/g), 2,
    '终态集合必须与 `internal.js#isTerminal` 同口径（两个方向各一处：删除 + 残留检查）');
  assert.equal(count(/status <> 'active'/g), 2, '(b) 的「已归档」那一支（会话归档只有用户动作，见 sessions.js#archiveSession）');
  assert.match(sql, /14 天/, '保留窗口为什么是 14 天要写在文件里（本单选的值，要改就追加新迁移）');
  assert.match(sql, /每条语句取一个新快照/, 'cutoff 的理由要写在文件里：READ COMMITTED 块内每条语句取新快照 ⇒ 不钉 cutoff 就会被残留检查误炸');
});

// 0035（2026-11-15，issue #524 的事件平台 W1 数据层）：`macro_templates` / `macro_assignments` /
// `macro_runs` 三张表，**只新增、不动既有表**（`docs/data/schema.sql` 一个字节都没改：baseline 冻结）。
// 这条用例只管**静态形状**（真库语义在 `portal/test/macros.test.js`）。钉三件事：
//   ① 两条唯一键必须在——`UNIQUE (assignment_id, anchor, criterion, bucket)` 是 `claimMacroRun` 的
//      `ON CONFLICT DO NOTHING` 的依据，`UNIQUE NULLS NOT DISTINCT (…)` 是「重复订阅」的唯一防线
//      （默认 UNIQUE 语义下 NULL 互不相等 ⇒ `scope='user'` 的订阅能被同一人订无数次）；
//      ⚠ 键里**不许出现生命周期列**：`status`（pending→running→done）会随执行推进而变，进了键
//      就等于「跑完之后同一个触发可以再 claim」⇒ 幂等失效。故判据 `criterion` 与 `status` 必须
//      是两列（issue #524 的设计变更：原先一列 `state` 两义，就是这个坑）；
//   ② `ON DELETE` 的**方向**是审计口径的一部分：`template_id → … ON DELETE CASCADE`（模板物理删
//      ⇒ 订阅跟着没意义）与 `assignment_id → macro_assignments(id)` **不带 ON DELETE**（取消订阅
//      不许抹掉执行账）故意不对称，抄成一致就红；
//   ③ 索引选型钉死「不给账表冗余 `template_id`」——想加列的人必须重新论证（可变派生值塞进
//      只追加的审计行 = 同一事实存两处），而不是顺手 ADD COLUMN；
//   ④ `status` / `criterion` 两列必须各自独立存在，库里不许再留 `state` 列。
test('迁移 0035-macro-platform：三表齐全、两条唯一键在、FK 的 ON DELETE 方向与索引选型不许漂', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0035-macro-platform.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0035 存在');
  assert.equal(files[files.length - 15], file, '0035 是倒数第十二支（0036..0045 追加在它后面；新迁移只能追加，不回改已应用的编号）');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 去掉**整行注释**（保留 `$$ ... $$` 内部语句），否则「注释里提到 DROP TABLE」会被误判。
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');
  const count = (needle) => executable.split(needle).length - 1;

  // ① 三张表 + 幂等/可重放：全部 `IF NOT EXISTS`，第二遍是零 DDL 空操作。
  for (const t of ['macro_templates', 'macro_assignments', 'macro_runs']) {
    assert.equal(count(`CREATE TABLE IF NOT EXISTS ${t}`), 1, `${t} 必须恰好建一次且带 IF NOT EXISTS`);
  }
  assert.equal(count('ON CONFLICT'), 0, '迁移本身不做 upsert（认领是 macros.js 的事，不在 DDL 里）');
  for (const bad of ['DROP TABLE', 'DROP COLUMN', 'ALTER TABLE macro_']) {
    assert.equal(count(bad), 0, `0035 不得有 ${bad}（只新增；删既有东西要另开一支迁移）`);
  }

  // ② 两条唯一键 + FK 的 ON DELETE 方向 + 生命周期与判据必须是两列。
  assert.equal(count('UNIQUE (assignment_id, anchor, criterion, bucket)'), 3,
    '幂等键必须含 criterion（DDL 一处 + 守卫条件与文案各一处）；回到含 state 的旧形状这里就红');
  assert.equal(count('status') >= 3, true, 'status（生命周期）必须在：列 + CHECK + 部分索引谓词');
  assert.match(executable, /status\s+text NOT NULL DEFAULT 'pending'/, '生命周期列必须是 status（默认 pending）');
  assert.match(executable, /criterion\s+text NOT NULL/, '判据列 criterion 必须 NOT NULL（幂等键的一分子）');
  assert.match(executable, /CHECK \(status IN \('pending', 'running', 'done', 'skipped', 'failed', 'superseded'\)\)/,
    'status 的六值 CHECK 必须独立成一条');
  assert.match(executable, /CHECK \(criterion IN \('terminal', 'silent', 'tick', 'mechanical', 'semantic'\)\)/,
    'criterion 的五值 CHECK 必须独立成一条（M9 的 mechanical / semantic 两路要在里面）');
  assert.equal(/\bstate\s+text/.test(executable), false, '库里不许再留名为 state 的列（一列两义的回归）');
  assert.equal(count('UNIQUE NULLS NOT DISTINCT (template_id, user_id, session_id, cwd)'), 1,
    '订阅键必须是 NULLS NOT DISTINCT（PG15+；丢了它 ⇒ 同一人能重复订同一模板，调度器就重复跑）');
  assert.equal(count('REFERENCES macro_templates (id) ON DELETE CASCADE'), 1,
    'template_id 必须 CASCADE（模板物理删 ⇒ 订阅跟着没意义）');
  assert.equal(count('REFERENCES macro_assignments (id),'), 1,
    'macro_runs.assignment_id 必须是**不带 ON DELETE** 的裸 REFERENCES（=RESTRICT：有账的订阅只能停用，不能顺手抹历史）');
  assert.equal(count('REFERENCES macro_runs (id) ON DELETE SET NULL'), 1, '自引用 parent_macro_run_id 必须 SET NULL');
  assert.equal(count('ON DELETE CASCADE'), 2, 'CASCADE 只许两笔（template_id / session_id）；给 assignment_id 加上就是把审计级联删掉');
  assert.equal(count('REFERENCES users (id)'), 2,
    '两处 user 引用（templates.created_by / assignments.user_id）都必须 REFERENCES users (id) 且不带 ON DELETE（口径同 chat_sessions.user_id）');
  assert.equal(count('REFERENCES chat_sessions (id)'), 2);
  assert.equal(count('ON DELETE SET NULL'), 3, 'child_session_id / child_run_id / parent_macro_run_id 三笔 SET NULL：会话与 run 被清理时账要留着');
  // `snapshot_id` / `worktree_path` **故意不建 FK**：快照是可回收物，SET NULL 会把审计链切断。
  assert.match(executable, /snapshot_id\s+uuid,/, 'snapshot_id 必须是裸 uuid 列（不加 REFERENCES）');

  // ③ 索引：八条（`09` §7 要筛选全落索引列），且**账表上没有冗余的 template_id**。
  assert.equal(count('CREATE INDEX IF NOT EXISTS'), 8,
    '0035 恰好八条索引（模板列表 / 订阅按模板 / 订阅按人启用中 / 账按订阅+时间 / 全局时间线 /'
    + ' 未收口 / 按判据+时间 / child_run 反查）');
  assert.ok(executable.includes('ON macro_runs (assignment_id, started_at DESC)'),
    '按模板筛执行账走 JOIN，所以 (assignment_id, started_at) 这条复合索引必须在');
  assert.ok(executable.includes('ON macro_runs (criterion, started_at DESC)'),
    '判据是筛选维度，必须有自己的索引（幂等键那条的前缀是 assignment_id，服务不了这种筛法）');
  assert.ok(executable.includes("WHERE status IN ('pending', 'running')"),
    '未收口账的部分索引谓词必须按 status（改列名后还写着 state 就是哑索引）');
  const runsBlock = executable.slice(executable.indexOf('CREATE TABLE IF NOT EXISTS macro_runs ('));
  assert.equal(runsBlock.slice(0, runsBlock.indexOf('\n);')).includes('template'), false,
    '索引选型口径：不给只追加的账表冗余 template_id（要按模板筛就 JOIN macro_assignments）');

  // ④ 后置守卫（照 0021 / 0024 惯例）：CHECK 与两条 UNIQUE 漂了就拒绝启动，不静默记成功。
  assert.equal(count("RAISE EXCEPTION '0035"), 8, '0035 的八条漂移守卫一条不能少');
  assert.equal(count("RAISE NOTICE '0035"), 1, '结论 NOTICE 以 0035 开头（排障时能认出是谁在说话）');
  assert.equal(count('RAISE WARNING'), 0, '不许 RAISE WARNING——CI 只 grep ERROR 会吞掉它');
  assert.match(sql, /RAISE EXCEPTION '0035: macro_runs 幂等键 UNIQUE \(assignment_id, anchor, criterion, bucket\) 漂移/,
    '幂等键漂移必须当场失败（否则 claimMacroRun 的 ON CONFLICT 会报「无此约束」）');
  // ★ 本节最关键的一条：守卫必须能抓「幂等键里混进了 status」。真库上验过反例必炸
  //   （把键改成 UNIQUE (assignment_id, anchor, status, bucket) ⇒ 迁移拒绝启动）。
  assert.match(sql, /RAISE EXCEPTION '0035: macro_runs 幂等键里混进了 status/,
    '生命周期列进幂等键 = 状态一迁移同一个触发就能再 claim，必须单独一条响亮错误');
  assert.match(sql, /RAISE EXCEPTION '0035: macro_runs 还留着 state 列/, '两列拆分的回归守卫必须在');
  assert.match(sql, /RAISE EXCEPTION '0035: macro_runs\.criterion 的 CHECK 漂移/, '判据 CHECK 的漂移守卫必须在');
});

test('迁移 0038-transcript-recovery-rows：幂等键/append_seq 排序/只新增/零 baseline 回写/守卫消息', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0038-transcript-recovery-rows.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0038 存在');
  assert.equal(files[files.length - 12], file, '0038 是倒数第八支（0039-capability-market / 0040-mcp-channel / 0041 / 0042 / 0043-platform-prompts / 0044-system-metrics / 0045-macro-skipped-reason-review-unavailable 追加在它后面）');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 去掉**整行注释**（保留 `$$ … $$` 内部语句）：头注释里 "DELETE""索引""created_at" 这些词都会出现，
  // 整文件判会假红/假绿（同 0032 / 0035 那两条的口径）。
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');
  const count = (re) => (executable.match(re) || []).length;

  // —— ① 表 + 幂等键 ——
  assert.equal(count(/CREATE TABLE IF NOT EXISTS transcript_recovery_rows\b/g), 1, '新建这张表，且必须 IF NOT EXISTS（可重放）');
  assert.match(executable, /PRIMARY KEY \(transcript_key, dedup_key\)/,
    '幂等键 = (transcript_key, dedup_key)：appendRecoveryRow 的 ON CONFLICT 目标，漂了就报无此冲突目标');
  // 键里混进 round ⇒ 同 dedupKey 换轮号就变成「另一行」，「同 key 异 payload 必须拒绝」当场失效。
  assert.doesNotMatch(executable, /PRIMARY KEY \([^)]*\bround\b[^)]*\)/,
    '幂等键里不许出现 round（否则同 dedupKey 异 payload 会被当成另一行收下，冲突判不出来）');
  assert.doesNotMatch(executable, /UNIQUE \([^)]*\bappend_seq\b[^)]*\)/,
    'append_seq 是排序键不是身份键，不许进任何唯一约束（bigserial 每写一行都换值）');

  // —— ② 排序真相：append_seq 进索引，墙钟不进表 ——
  assert.match(executable,
    /CREATE INDEX IF NOT EXISTS transcript_recovery_rows_key_seq_idx\s+ON transcript_recovery_rows \(transcript_key, append_seq\)/,
    '读侧唯一谓词 + 排序 (transcript_key, append_seq) 必须有索引支撑，且 IF NOT EXISTS');
  assert.match(executable, /append_seq\s+bigserial/, 'append_seq 是 bigserial（持久化追加序，同迁移 0016 口径）');
  assert.doesNotMatch(executable, /^\s*created_at\s+(timestamptz|timestamp)/m,
    '本表不许有 created_at：排序靠 append_seq 不靠时间（partial-text 取「该轮最后落盘」那条，同秒排不出来）');
  // 表体单独抠出来判：守卫消息**正文里**就写着「新表不写 DEFAULT CURRENT_TIMESTAMP」，
  // 拿整个语句区正则会把那句人话当成一条 DEFAULT 子句（假红）。
  const tableBody = /CREATE TABLE IF NOT EXISTS transcript_recovery_rows \(([\s\S]*?)\n\);/.exec(executable);
  assert.ok(tableBody, '抠得出这张表的列定义（改写法请同步改本判据）');
  assert.equal((tableBody[1].match(/\bDEFAULT\b/g) || []).length, 0,
    '表体零 DEFAULT：本站规矩，墙钟默认值会让「没人写过它」看起来像刚刚活动过（排序真相是 append_seq）');
  assert.match(executable, /round\s+integer\s+NOT NULL CHECK \(round >= 0\)/,
    'round 非负（与 transcript_rounds.round 同口径；更强的安全整数判据在引擎读侧）');
  assert.match(executable, /dedup_key\s+text\s+NOT NULL CHECK \(length\(dedup_key\) <= 255\)/,
    'dedup_key 列宽 CHECK 必须在：portal/src/transcript-store.js 的 RECOVERY_DEDUP_KEY_MAX_LEN 与它同一个数');

  // —— ③ 只新增：不撤东西、不碰既有表，尤其零 DELETE ——
  for (const bad of ['DROP TABLE', 'DROP INDEX', 'ALTER TABLE', 'TRUNCATE', 'DELETE FROM', 'UPDATE ']) {
    assert.equal(count(new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 0,
      `0038 不得有 ${bad}（只新增；删既有东西要另开一支迁移）`);
  }
  assert.doesNotMatch(executable, /DELETE FROM\s+transcript_rounds/i,
    '红线：全站 transcript_rounds 零 DELETE 是折叠重建「可证无损」的前提，本单不许引进例外');
  assert.doesNotMatch(executable, /\bREFERENCES\b/,
    '不建外键：与 transcript_rounds 同口径（键是引擎给的 transcript key，写路径不与 session 同事务）');

  // —— ④ baseline 冻结：本表只能走增量迁移，且不许回写 schema.sql ——
  assert.ok(!fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8')
    .includes('transcript_recovery_rows'),
    'baseline schema.sql 里不许出现这张新表（sha256 已进迁移台账，改一字节现存库全部拒启）');

  // —— ⑤ 守卫与证据块 ——
  assert.equal(count(/RAISE EXCEPTION '0038/g), 3,
    '三条漂移守卫（幂等键 / 索引列 / 混进 created_at）一条不能少——少了就只剩"看起来跑成功了"');
  assert.match(executable, /RAISE EXCEPTION '0038: transcript_recovery_rows 幂等键 UNIQUE \(transcript_key, dedup_key\) 漂移/,
    '幂等键漂移必须当场失败（否则 appendRecoveryRow 的 ON CONFLICT 报「无此冲突目标」）');
  assert.match(executable, /RAISE EXCEPTION '0038: transcript_recovery_rows_key_seq_idx 的列漂移/,
    '索引列漂移必须当场失败（返回顺序是契约面，不是实现细节）');
  assert.equal(count(/RAISE WARNING/g), 0, '不许 RAISE WARNING——CI 只 grep ERROR 会吞掉它');
  assert.equal(count(/RAISE NOTICE '0038/g), 1, '重放证据 NOTICE 以 0038 开头（排障时能认出是谁在说话）');
  // VACUUM 不进迁移文件：`VACUUM` 不能在事务块里跑（25001），而 runner 是单事务 ⇒ 写进去就是整支失败、portal 拒启。
  assert.doesNotMatch(executable, /\bVACUUM\b/, 'VACUUM 不许进迁移文件（不在事务块里跑；要回收磁盘就手工跑）');
  // 超时必须 SET LOCAL：runner 用池化连接，裸 `SET` 会漏给同一条连接的后续语句。
  assert.match(executable, /^SET LOCAL lock_timeout/m, 'lock_timeout 必须 SET LOCAL（随事务结束失效，不漏给后续语句）');
  assert.doesNotMatch(executable, /^SET lock_timeout/m, '不许裸 SET lock_timeout（同上）');
});

// issue #595（能力市场 P0）：三表形态 + 两条复合主键 + 枚举 CHECK + 幂等可重放。
// 这里只钉「schema 事实」；校验规则（slug/路径/体积/id 一致性）的唯一真相在 portal/src/market.js，
// 判据在 portal/test/market.test.js，DDL 不重复钉业务校验（否则两份真相）。
test('迁移 0039-capability-market：三表齐全、包内容按 (item,version) 不可变、枚举 CHECK 在、零 UPDATE 回填', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0039-capability-market.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0039 存在');
  assert.equal(files[files.length - 11], file, '0039 是倒数第七支（0040-mcp-channel / 0041-retire / 0042-mcp-plaintext-values / 0043-platform-prompts / 0044-system-metrics / 0045-macro-skipped-reason-review-unavailable 追加在它后面；新迁移只能追加）');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（40 是显式登记的预留号，见 MIGRATION_NUMS）',
  );

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 去整行注释（同 0032 / 0035 / 0038 的口径）：头注释里会出现 UPDATE / DROP / INSERT 这些词。
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');
  for (const t of ['capability_items', 'capability_files', 'fde_capability_installs']) {
    assert.match(executable, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`), `${t} 必须存在且幂等`);
  }
  // 包内容按 (item, version) 复合主键：改版 = 新增行，就地 UPDATE 会让已装版本与账面脱钩
  assert.match(executable, /PRIMARY KEY \(item_id, version, path\)/,
    'capability_files 主键必须是 (item_id, version, path)（历史版本留得下，才谈得上以后开回滚）');
  assert.match(executable, /PRIMARY KEY \(fde_id, item_id\)/,
    'installs 主键必须是 (fde_id, item_id)（一人一条 = 幂等安装落库的那道天然闸门）');
  // 枚举值写进 DB：state/kind 的取值集合是协议，被写侧校验与物化 SQL 同时引用
  assert.match(executable, /CHECK \(state IN \('draft','published','retired'\)\)/, 'state 枚举不许漂');
  assert.match(executable, /CHECK \(kind IN \('skill','mcp'\)\)/, 'kind 枚举不许漂（mcp 是 P1 的位子，今天只占位）');
  // advisory 扫描分不得变成闸门：DDL 里不许出现「score 低于某值」这类约束
  assert.doesNotMatch(executable, /security_score\s*(>=|>|<|<=)\s*\d/,
    'security_score 是 advisory（只提示与排序），不是安装闸门 —— 闸门在 JS 侧，DDL 里不许出现第二份判据');
  // 幂等可重放：零 UPDATE 回填、零 DROP、末尾 DO 块只读
  assert.doesNotMatch(executable, /\bUPDATE\b/, '新表上线即空表，不许出现回填 UPDATE');
  assert.doesNotMatch(executable, /\bDROP (TABLE|COLUMN|INDEX)\b/, '不许 DROP（改表形态是改形状，另开一支迁移）');
  assert.doesNotMatch(executable, /INSERT INTO|DELETE FROM/, '末尾 DO 块只读：出现 INSERT/DELETE 就不计成本重放（README）');
});

// ---------------------------------------------------------------------------
// 0039 之后补的**通用形状闸**（不是某支迁移的语义判据）：RAISE 的格式串
// ---------------------------------------------------------------------------

/** 剥掉 `--` 行注释与块注释（注释里写的 `RAISE … || …` 不该被抓）。 */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

/** 把单引号字面量折成一个占位符：这样「字面量文本里含 ||」不会被误判成拼接。 */
function squashLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, " \u0000 ");
}

/**
 * 找出「`RAISE <级别> 'a' || 'b', args`」这种写法。
 * 为什么这是一条**必须存在**的闸（issue #595 真机实测）：PL/pgSQL 的 RAISE 第一个参数必须是
 * **字面量格式串**，写 `'a' || 'b', n` 会在解析期就 `syntax error at or near "||"` ⇒ 整支迁移回滚 ⇒
 * **镜像起不来**。0039 首跑正是这条（`0039: capability_items=% …' || '（全 0 = …）', n_items, …`）。
 * 它是「没人真跑过」的典型形状：文件从没被 migrate runner 应用过，文本断言又全在讲 DDL ⇒ 全绿照过。
 * 所以这条闸只管**形状**（RAISE 到第一个逗号之间不许有 `||`），不管语义，扫的是全部增量迁移。
 * @returns {string[]} 每条命中给一段可定位的片段
 */
function raiseFormatConcat(sql) {
  const scannable = squashLiterals(stripSqlComments(sql));
  const hits = [];
  const re = /\bRAISE\b(?:\s+(NOTICE|EXCEPTION|WARNING|INFO|DEBUG|LOG|SQLSTATE)\b)?([^;]*)/gi;
  let m;
  while ((m = re.exec(scannable)) !== null) {
    const rest = m[2] ?? '';
    const comma = rest.indexOf(',');
    const formatPart = comma === -1 ? rest : rest.slice(0, comma);
    if (formatPart.includes('||')) {
      hits.push(`RAISE ${(m[1] ?? '<级别>')} ${formatPart.trim().slice(0, 80)}`);
    }
  }
  return hits;
}

test('迁移形状闸：RAISE 的格式串必须是单个字面量（\'a\' || \'b\', args 在 PL/pgSQL 是语法错）', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.length >= 40, `迁移条数异常：${files.length}`);
  const bad = [];
  for (const f of files) {
    for (const hit of raiseFormatConcat(fs.readFileSync(path.join(dir, f), 'utf8'))) bad.push(`${f}: ${hit}`);
  }
  assert.deepEqual(bad, [],
    `RAISE 的格式串不许写成拼接（迁移会在解析期炸并整支回滚）：\n${bad.join('\n')}`);

  // 反向自证：0039 首跑那条真机报错的形状必须被判不合格，否则这条闸就是恒真的。
  // 首条 = 当时文件里的**逐字形状**（源：`git show 0888aec:deploy/migrations/0039-capability-market.sql`，
  // 即主 agent 修之前的那一版）：本闸已拿那份原文跑过⇒命中 1 条；换成单字面量后⇒clean。
  const offenders = [
    `RAISE NOTICE '0039: capability_items=% / capability_files=% / fde_capability_installs=% 行'\n    || '（全 0 = 市场未发布，capabilities.json 将渲染成 {"version":1,"skills":[]}）',\n    n_items, n_files, n_installs;`,
    `RAISE NOTICE 'a=% ' || 'b' || 'c', v;`,                                          // 多段拼接
    `DO $$ BEGIN RAISE WARNING 'p=%' || 'q', v; END $$;`,                             // 藏在 DO 块里
    `RAISE 'x' || 'y';`,                                                               // 省略级别（缺省 EXCEPTION）
  ];
  offenders.forEach((sql, i) => assert.equal(raiseFormatConcat(sql).length, 1,
    `违规样本 ${i} 必须恰好被判一次不合格：${sql}`));

  // 合法形状不许误伤：闸只管「格式串」那一段，参数里出现 `||` 是合法的。
  [
    `RAISE NOTICE 'a=%', n;`,
    `RAISE NOTICE 'a=% / b=%', x || 'z', y;`,            // 拼接在**参数**里 ⇒ 合法
    `RAISE NOTICE '文本里含 || 也只是普通字符';`,          // 字面量内部的 ||
    `-- 注释里写 RAISE NOTICE 'a' || 'b', n; 不算\nRAISE LOG 'ok %', v;`,
    `/* 块注释里同理 RAISE NOTICE 'a' || 'b'; */ RAISE INFO 'ok';`,
    `EXCEPTION WHEN OTHERS THEN RAISE; END;`,            // 重抛（没有格式串）
  ].forEach((sql, i) => assert.deepEqual(raiseFormatConcat(sql), [], `合法样本 ${i} 被误伤：${sql}`));

  // 0039 那一条本身：必须保持「单字面量 + 三个参数」（别被下一个人"顺手美化"回拼接）
  const m39 = fs.readFileSync(path.join(dir, '0039-capability-market.sql'), 'utf8');
  assert.match(m39, /RAISE NOTICE '[^']*'\s*,\s*\n?\s*n_items, n_files, n_installs;/s,
    '0039 收尾的 DO 块 NOTICE 必须是单字面量格式串 + 三个参数');
});

// ---------------------------------------------------------------------------
// 0041（2026-11-17，issue #640）：`run_checkpoints` 整条竖切退役。
//
// 事实链（写在这里是为了下一个人不必再考古）：erix-agent 0.33.0（上游 #838 S2，本站 #530）把
// run snapshot 整个退役 ⇒ 引擎不再调 `saveRunSnapshot` / `loadLatestRunSnapshot`（0.33.0 源码现查
// 零命中），本站的 store 方法 / agentd 转发 / 四个 internal 端点已在同一单删净（M1/M2）。
// 真库现查：17 行 / 565,248 B，`max(updated_at)` = 2026-11-11（0.33 上线后零写入），
// FK `run_checkpoints.run_id → runs.id` 且本站是 **child 端**，视图依赖 / 触发器 / 被引用都是 0
// ⇒ 零级联风险。备份已落 `~/backups/run_checkpoints-pre-0041-261117-0937.sql.gz`。
// 这里钉的是**撤表的形状**；「全新库跑通 + 重放幂等」的证明在 `portal/test/migrate-fresh-db.test.js`。
// ---------------------------------------------------------------------------
test('迁移 0041-retire-run-checkpoints：DROP 形状四 constraint（IF EXISTS / 无 CASCADE / 无 VACUUM / 无 BEGIN）+ 冻结件不改', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0041-retire-run-checkpoints.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0041 存在');
  assert.equal(files[files.length - 9], file, '0041 是倒数第五支（0042-mcp-plaintext-values / 0043-platform-prompts / 0044-system-metrics / 0045-macro-skipped-reason-review-unavailable 追加在它后面）');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 只看**语句区**（整行注释剥掉）：头注释里 DROP / VACUUM / BEGIN / CASCADE 这些词都要出现，
  // 整文件判会假红（同 0032 / 0035 / 0038 的口径）。
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');

  // ① 撤的只有这一张表，且必须 `IF EXISTS`（幂等：第二遍重放零 DDL，也是全新库第二遍不炸的前提）
  const drops = executable.match(/\bDROP\s+TABLE\b[^;]*;/gi) ?? [];
  assert.equal(drops.length, 1, `0041 只许一句 DROP TABLE，实得 ${drops.length} 句：${drops.join(' | ')}`);
  assert.match(drops[0], /^DROP TABLE IF EXISTS public\.run_checkpoints;$/,
    `必须逐字是 "DROP TABLE IF EXISTS public.run_checkpoints;"，实得：${drops[0]}`);

  // ② 不许 CASCADE：现查零依赖 ⇒ 加了它只会掩盖「后来挂上来的东西」，静默多撤比回滚难查。
  assert.equal(/\bCASCADE\b/i.test(executable), false, '不许 CASCADE（意外依赖要让事务回滚，不要静默带走）');

  // ③ 不许 VACUUM：runner 在单事务里跑本文件，`VACUUM` 不能在事务块里（同 0033 / 0034 的理由）。
  assert.equal(/\bVACUUM\b/i.test(executable), false, '迁移文件里不许 VACUUM（不在事务块里跑）');

  // ④ 不许自己写 BEGIN/COMMIT（事务边界归 runner，见 README「单文件约定」）。
  //    `DO $do$ … $do$;` 整块先剥掉：块里那个 `BEGIN` 是 PL/pgSQL 的块开始，不是事务开始。
  const noDoBlock = executable.replace(/\bDO\s+\$[a-z]*\$[\s\S]*?\$[a-z]*\$/i, ' ');
  assert.equal(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(noDoBlock), false,
    '不许手写 BEGIN/COMMIT/ROLLBACK（事务边界归 runner）');
  assert.match(executable, /\bDO\s+\$do\$\s*\n?BEGIN\b/, '收尾的 DO 观测块必须还在（④ 剥的就是它）');

  // ⑤ 锁纪律：DROP TABLE 要 ACCESS EXCLUSIVE，拿不到就该放弃而不是排长队堵住读侧。
  assert.match(executable, /^SET LOCAL lock_timeout = '5s';$/m,
    '必须 SET LOCAL lock_timeout（随 runner 的事务结束）');

  // ⑥ 顺手改形状的东西：不许给这张表再加列/加索引/回填，也不许动别的表。
  assert.equal(/ALTER TABLE[^\n]*run_checkpoints/i.test(executable), false, '不许顺手 ALTER run_checkpoints');
  assert.equal(/CREATE [^;]*INDEX/i.test(executable), false, '0041 不建索引');
  assert.equal(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/i.test(executable), false, '零数据写（撤表不需要碰行）');

  // ⑦ **冻结件一个字节都不改**（红线 1）：baseline 里那句 CREATE TABLE 必须还在，
  //    历史迁移（0006 加 session 侧键 / 0034 清存量）也照旧提到这张表。
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.match(baseline, /CREATE TABLE (IF NOT EXISTS )?run_checkpoints\b/,
    'baseline 是冻结件：它**继续包含**建表语句（新库先建再由 0041 撤），改一字节 = 现存库拒启动');
  const m0006 = fs.readFileSync(path.join(dir, '0006-session-transcript.sql'), 'utf8');
  assert.match(m0006, /run_checkpoints_session_uidx/, '0006 冻结件照旧（它的 session 侧索引随表一起消失，但字节不许动）');
  const m0034 = fs.readFileSync(path.join(dir, '0034-prune-stale-run-checkpoints.sql'), 'utf8');
  assert.match(m0034, /DELETE FROM run_checkpoints/, '0034 冻结件照旧（清存量迁移不随退役改写历史）');
});

// 反向自证：上面那条的形状闸不是恒真的——四个反例逐个必须被判不合格。
test('0041 形状闸反向自证：裸 DROP / 带 CASCADE / 带 VACUUM / 手写 COMMIT 都必须被判不合格', () => {
  const offenders = [
    'DROP TABLE public.run_checkpoints;',                                  // 漏 IF EXISTS ⇒ 重放炸
    'DROP TABLE IF EXISTS public.run_checkpoints CASCADE;',                // 掩盖未知依赖
    'DROP TABLE IF EXISTS public.run_checkpoints;\nVACUUM run_checkpoints;', // 事务块里跑不动
    'BEGIN;\nDROP TABLE IF EXISTS public.run_checkpoints;\nCOMMIT;',       // 抢 runner 的事务边界
  ];
  // 判据与 ①②③④ 同源：逐条走同一个尺子（剥 DO 块后的语句区 + 那句 DROP 的逐字形状）。
  const shapeOk = (sql) => {
    const drops = sql.match(/\bDROP\s+TABLE\b[^;]*;/gi) ?? [];
    const dropOk = drops.length === 1 && /^DROP TABLE IF EXISTS public\.run_checkpoints;$/.test(drops[0].trim());
    const body = sql.replace(/\bDO\s+\$[a-z]*\$[\s\S]*?\$[a-z]*\$/i, ' ');
    return dropOk
      && !/\bCASCADE\b/i.test(body)
      && !/\bVACUUM\b/i.test(body)
      && !/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/i.test(body);
  };
  for (const sql of offenders) assert.equal(shapeOk(sql), false, `反例必须被判不合格：${sql}`);
  // 正向：真文件的形状必须通过同一把尺（否则上面四条是恒真，判据没接地）。
  const real = fs.readFileSync(path.join(HERE, '../../deploy/migrations/0041-retire-run-checkpoints.sql'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')).join('\n');
  assert.equal(shapeOk(real), true, '0041 真文件必须通过同一把尺');
});

// 迁移 0043（issue #596 片 A，`platform_prompts` 单行表）——本节的存在理由是一条评审结论（F1）：
// 写侧那条语句靠 `SELECT … FROM platform_prompts WHERE id = 1 FOR UPDATE` 拿旧值快照，而
// **`FOR UPDATE` 只能锁已经存在的行**。空表里没有任何行可锁 ⇒ 两个并发首写各拿一份「无行」快照
// （三列全 `COALESCE(…, '')`）、各写自己那一格 ⇒ 后写的 `ON CONFLICT DO UPDATE` 覆盖**整行**，
// 先写的那个值就这么丢了。种下 `id = 1` 是这件事的机器判据：那把锁从此一直存在。
// 判据判的是**可执行 SQL 里真有那句 INSERT**（不是头注释里说过），注释写一万字也拦不住漏种。
// 反向自证（2026-11-16 复测）：把 0043 那句 `INSERT INTO platform_prompts (id) VALUES (1)`
// 换成一行注释 ⇒ 本节必须红在**点名它的那条断言**上，实测 rc=1 且
// `error: '缺种首行：空表时 `snap … FOR UPDATE` 锁不到任何行 ⇒ 并发首写各拿一份空快照
// ⇒ 后写覆盖整行（丢更新）'`（不是红在编号、不是红在 baseline —— 那说明判据没打在种行上）。
// 同一件事在**真库**上的对应判据：`portal/integration/platform-prompts-db.mjs` 的
// `P12d-db`（不种行 ⇒ 并发保存真的丢更新）。
// ---------------------------------------------------------------------------

test('迁移 0043-platform-prompts：种首行（让 FOR UPDATE 有行可锁）+ 幂等 + 零 baseline 回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const file = '0043-platform-prompts.sql';
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes(file), '0043 存在');
  // 本单让号到 0043 后它就是当前末位（0040→#608 mcp-channel、0041→#640 retire、0042→#670 mcp-plaintext 都排在它之前）。
  // #650 追加 `0044-system-metrics.sql` 之后 0043 不再是末位 ⇒ 判据改成「位置固定 + 只能往后追加」
  // （形状同 0033..0041 那几支的位次断言：钉的是「不许回头插队」，不是「永远是最后一支」）。
  assert.equal(files[files.length - 7], file,
    '0043 是倒数第三支（0040-mcp-channel、0041-retire-run-checkpoints、0042-mcp-plaintext-values 在它之前，'
    + '0044-system-metrics 追加在它之后；新迁移只能追加）');
  assert.deepEqual(
    files.map((f) => Number(f.slice(0, 4))),
    MIGRATION_NUMS,
    '迁移编号 = 1..head 连续（0043 已由本单填上 ⇒ 恢复严格连续）',
  );

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 去掉整行注释后再判（头注释里满是 "UPDATE""DELETE""索引" 这些词，整文件判会假红，口径同 0038 那节）。
  const executable = sql.split('\n').map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('--')).join('\n');
  const count = (re) => (executable.match(re) || []).length;

  // —— ① ★ 本节本体（评审 F1）：首行必须**种在迁移里** ——
  const seed = /INSERT INTO platform_prompts \(\w+\)\s+VALUES \(1\)\s+ON CONFLICT \(id\) DO NOTHING/;
  assert.match(executable, seed,
    '缺种首行：空表时 `snap … FOR UPDATE` 锁不到任何行 ⇒ 并发首写各拿一份空快照 ⇒ 后写覆盖整行（丢更新）');
  assert.equal(count(new RegExp(seed.source, 'g')), 1, '种行恰好一条（多条 = 有人开始往迁移里塞数据操作）');
  // 只认 `DO NOTHING`：写成 `DO UPDATE` 的话，第二遍重放会把管理员已经改过的文本刷回空串
  // ⇒ 迁移吃掉了用户的配置（这条迁移的「幂等」二字指的就是它）。
  assert.doesNotMatch(executable, /INSERT INTO platform_prompts[\s\S]{0,200}?ON CONFLICT \(id\) DO UPDATE/,
    '种行不许写成 ON CONFLICT DO UPDATE（重放会把已改过的文本刷成空 = 迁移覆盖用户配置）');
  // 只种 id ⇒ 三列由列上的 DEFAULT 出 `''` ⇒ 种行本身不改变任何生效值（读侧「三块全跟随内置」照旧，判据 P1）。
  const seedStmt = /INSERT INTO platform_prompts[^;]*;/.exec(executable)[0];
  assert.doesNotMatch(seedStmt, /agents_md_|title_prompt/,
    '种行只给 id：在这里写死文本 = 造出第二份「内置提示词」真相（内置只有 materializer.js / title-llm.js 一份）');

  // —— ② 建表与「只能有一行」这条 DB 事实 ——
  assert.match(executable, /CREATE TABLE IF NOT EXISTS platform_prompts\b/, '建表必须 IF NOT EXISTS（可重放）');
  assert.match(executable, /id\s+int PRIMARY KEY DEFAULT 1 CHECK \(id = 1\)/,
    '单行是 DB 事实（照 0026/0036）：两行配置 = 谁生效取决于 ORDER BY，那是不可调试的形态');
  for (const col of ['agents_md_addendum', 'agents_md_override', 'title_prompt']) {
    assert.match(executable, new RegExp(`${col} +text NOT NULL DEFAULT ''`),
      `${col} 必须 NOT NULL DEFAULT ''（'' = 跟随内置，是读侧唯一的默认态判据，不许再引入 NULL 那个状态）`);
  }
  // 产品区间（8192 / 16384 / 2000）**不在这里**：写侧常量挡（改天花板不用重放迁移），读侧要能面对
  // 手工 UPDATE 进来的超长值照常工作 ⇒ DB 里出现这三个数字就是分层漂了。
  for (const n of ['8192', '16384', '2000']) {
    assert.doesNotMatch(executable, new RegExp(`\\b${n}\\b`), `${n} 是产品上限，属写侧常量，不进 DB CHECK`);
  }
  assert.match(executable, /updated_by\s+uuid\b/, 'updated_by 存在（谁改的要留名）');
  assert.doesNotMatch(executable, /\bREFERENCES\b/, 'updated_by 不建 FK（照 0026/0036：管理员行被删后配置要留着）');

  // —— ③ 可重放：零 DDL 破坏、零数据回收 ——
  for (const bad of ['DROP TABLE', 'DROP INDEX', 'ALTER TABLE', 'TRUNCATE', 'DELETE FROM', ' UPDATE ']) {
    assert.equal(count(new RegExp(bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 0,
      `0043 不得有 ${bad.trim()}（重放要零变化；要改形态请另开一支迁移）`);
  }
  // 这条迁移没有需要断言的既有形态（无行与 1 行都是正常态）⇒ 只许 NOTICE，不许拿 EXCEPTION 当嗓门。
  assert.equal(count(/RAISE EXCEPTION/g), 0, '零 EXCEPTION：这里没有「漂了就别启动」的形态可守');
  assert.equal(count(/RAISE WARNING/g), 0, '不许 RAISE WARNING——CI 只 grep ERROR 会吞掉它');
  assert.equal(count(/RAISE NOTICE '0040/g), 2, '重放证据两个分支各一条 NOTICE（有行/无行都要说清是哪一种）');
  assert.doesNotMatch(executable, /\bVACUUM\b/, 'VACUUM 不进迁移（不在事务块里跑，runner 是单事务）');

  // —— ④ baseline 冻结：本表只走增量迁移，schema.sql 一个字节不改 ——
  assert.ok(!fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8').includes('platform_prompts'),
    'baseline schema.sql 里不许出现 platform_prompts（它的 sha256 在迁移台账里，改一字节现存库全部拒启）');
});

// ---------------------------------------------------------------------------
// 通用形状闸：**`NNNN-*.sql` 的四位号必须全局唯一**（不是某支迁移的语义判据）
//
// 为什么这条闸必须存在（2026-11-16 现场，不是假想敌）：`deploy/migrations/README.md`「命名与顺序」
// 写明 `NNNN` 是**四位递增序号**，而 #595 与 #596 两张并行单各自取号，各自都从「40」往下排 ⇒
// 同一号出现两个文件：`0039-capability-market.sql` 与 `0039-platform-prompts.sql`。两边各自都绿：
// 迁移 runner 用**文件名**当 `schema_migrations.version`，两个文件是两个不同的 version，
// 于是 dev 库里同时落了 `0039-capability-market` 与 `0039-platform-prompts` 两行台账，
// **全仓没有任何一条判据抱怨过**（`migrations.test.js` 只判「末位是哪支 + 编号连续」，
// 末位断言看的是 `files[length-1]`，连续断言看的是 `Number(f.slice(0,4))` 的升序——
// 重复号在两条判据里都不产生异常：升序里出现两个 39 也不算「跳号」）。
// 真实代价不是难看：`sort` 升序里同号的先后由 **slug 字典序**决定 ⇒ 应用顺序变成隐式，
// 而「谁在前」这件事今后没人能从编号本身读出来（迁移一旦有依赖，这就是不可复现的部署）。
//
// 反向自证（常驻，不靠手工）：见本节末尾的 `dupOf` 自检——它把两个同号文件名喂进同一个函数，
// 必须判出**且点名是哪两个文件**。手工实测记录：`touch deploy/migrations/0040-collision-proof.sql`
// ⇒ 本格子红在点名那两个文件的那条断言上（rc=1），删掉临时文件即复绿。
// ---------------------------------------------------------------------------

/** 重复的迁移号 → 抢这个号的文件名列表（干净目录 ⇒ 空对象）。 */
function duplicateMigrationNumbers(files) {
  const byNum = new Map();
  for (const f of files) {
    const num = f.slice(0, 4);
    if (!/^\d{4}$/.test(num)) continue;
    if (!byNum.has(num)) byNum.set(num, []);
    byNum.get(num).push(f);
  }
  return Object.fromEntries([...byNum.entries()].filter(([, list]) => list.length > 1).sort());
}

test('迁移编号唯一性闸：`NNNN-*.sql` 的四位号全局唯一（同号两个文件 = 应用顺序没人说得清）', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.length >= 40, `迁移条数异常：${files.length}`);

  const dup = duplicateMigrationNumbers(files);
  const bad = Object.entries(dup).map(([num, list]) => `${num} 被 ${list.length} 个文件抢用：${list.join(' / ')}`);
  assert.deepEqual(bad, [],
    `deploy/migrations/ 里 ` + `NNNN 必须全局唯一（README「命名与顺序」）——撞号时 runner 照样`
    + `各记一行 version，台账看起来都对，但同号两支的先后只剩 slug 字典序可查：\n${bad.join('\n')}`);

  // 反向自证：本闸不是恒真的 —— 把两个同号文件名喂进去必须恰好判出一条，且**点名是哪两个文件**。
  const proof = duplicateMigrationNumbers([
    '0001-a.sql', '0040-capability-market.sql', '0040-platform-prompts.sql', '0041-b.sql',
  ]);
  assert.deepEqual(Object.keys(proof), ['0040'], `反向自证失败：0040 撞号没被抓到（拿到 ${JSON.stringify(proof)}）`);
  assert.deepEqual(proof['0040'], ['0040-capability-market.sql', '0040-platform-prompts.sql'],
    '反向自证失败：抓到了撞号但没点名是哪两个文件（下一地点名式报错就失去意义）');
  // 边界：末位/首位撞号也要抓（判据不是「只检查中间」），空目录不得抛。
  assert.deepEqual(Object.keys(duplicateMigrationNumbers(['0001-a.sql', '0001-b.sql'])), ['0001'],
    '反向自证失败：首位撞号没被抓到');
  assert.deepEqual(Object.keys(duplicateMigrationNumbers(['0099-a.sql', '0099-z.sql'])), ['0099'],
    '反向自证失败：末位撞号没被抓到');
  assert.deepEqual(duplicateMigrationNumbers([]), {}, '空目录不许抛');
});

// ---------------------------------------------------------------------------
// 通用形状闸：**`docs/api/portal.md` 的 `### N.N` 章节号必须全局唯一**（同一族的事故，写在这里是
// 因为「编号唯一」这条纪律只该有一处落地）
//
// 为什么这条闸也必须在（同一天的第二处现场）：合并 `origin/main` 时两边各自新建了一节 **§4.16**
// （本单的「管理台提示词面板」与 #586 的「管理台关于」）——两节都写得很认真，**判据却先塌了**：
// 本单的 `D1`（`portal/test/platform-prompts.test.js`）按 `apiDoc.indexOf('### 4.16 ')` 取节，
// 撞号之后它取到的节界一路串到邻居 #595 的能力市场那一节，于是把 `capability_budget_exceeded` /
// `capability_install_failed` 当成「本单发明了错误码」报红（实测：`§4.16 只许用既有错误码（发明了：
// capability_budget_exceeded, capability_install_failed）`）。也就是说重复编号让判据在
// **假红与假绿之间随机摆**：谁排在前面，别人那一节的文本就被算成它的。这与 `0039` 两个文件
// 在库里并存而无人报警是同一类事故，只是发生在文档里。
//
// 判据形状与上面那条同族：抓**全部** `### N.N`（不区分章节、不许只查某一节），违规时点名
// 「哪两个标题抢了同一个号」。字母后缀的子号（`### 4.4a`）是**不同的号**，不算撞车。
//
// 反向自证（常驻）：见本节末尾 `duplicateSectionNumbers` 的自检；手工实测 = 往 portal.md 临时插一句
// `### 4.16 collision-proof` ⇒ 本格子必须红在点名那两个标题的断言上，删掉即复绿。
// ---------------------------------------------------------------------------

/**
 * 重复的章节号 → 抢这个号的标题行列表（干净文档 ⇒ 空对象）。
 * 只认 `### N.N` 这一级（`## N.` 是大章、`#### N.N-x` 是某一节内部的小节，各有自己的命名空间）。
 */
function duplicateSectionNumbers(markdown) {
  const byNum = new Map();
  for (const line of markdown.split('\n')) {
    const m = /^### (\d+\.\d+[a-z]*)\s/.exec(line);
    if (!m) continue;
    if (!byNum.has(m[1])) byNum.set(m[1], []);
    byNum.get(m[1]).push(line.trim());
  }
  return Object.fromEntries([...byNum.entries()].filter(([, list]) => list.length > 1).sort());
}

test('文档编号唯一性闸：docs/api/portal.md 的三级标题号（H3 的 `N.N`）全局唯一（撞号会把别人的节算成你的）', () => {
  const doc = fs.readFileSync(path.join(HERE, '../../docs/api/portal.md'), 'utf8');
  const dup = duplicateSectionNumbers(doc);
  const bad = Object.entries(dup)
    .map(([num, list]) => `§${num} 被 ${list.length} 个标题抢用：\n${list.map((h) => `    ${h}`).join('\n')}`);
  assert.deepEqual(bad, [],
    `docs/api/portal.md 的章节号必须全局唯一——撞号之后「按 §号取节」的判据（如本单的 D1）`
    + `会吃进邻居那一节的文本，判据开始随机红/随机绿：\n${bad.join('\n')}`);

  // 反向自证：同一个号写两次必须被抓，并且**点名是哪两个标题**。
  const proof = duplicateSectionNumbers([
    '### 4.1 甲', '### 4.16 管理台提示词面板', '### 4.16 管理台「关于」', '### 4.17 能力市场',
  ].join('\n'));
  assert.deepEqual(Object.keys(proof), ['4.16'], `反向自证失败：4.16 撞号没被抓到（拿到 ${JSON.stringify(proof)}）`);
  assert.deepEqual(proof['4.16'], ['### 4.16 管理台提示词面板', '### 4.16 管理台「关于」'],
    '反向自证失败：抓到了撞号但没点名是哪两个标题');
  // 边界：`4.4` 与 `4.4a` 是两个号（文档里大量使用字母后缀，误判就是假红）；小节 `#### 4.16-1` 不参与。
  assert.deepEqual(duplicateSectionNumbers('### 4.4 乙\n### 4.4a 丙\n#### 4.4-1 丁\n#### 4.4-1 戊'), {},
    '字母后缀子号与 `####` 小节不许被判成撞号');
  // ↑ 这里说「`####` 不参与」**只针对本闸**（撞号命名空间）：小节号自己另有归属闸 ——
  //   下面那条「小节号必须挂在同名 H3 下」。两道闸各管一件事，不是这里写漏了。
});

// ---------------------------------------------------------------------------
// 上一节那条闸的**盲区**（评审 R9）：`duplicateSectionNumbers` 只读 H3，而小节写的是
// `#### N.N-x`——那个 `N.N` 本意就是「我挂在哪个 H3 下面」，却从来没人对账过。
// 现场：合并 `origin/main` 后能力市场那一节是 `### 4.17`，而它下面**六个**小节仍叫
// `#### 4.16-1 … 4.16-6`（§4.16 早已是 #586 的管理台「关于」）⇒ 按小节号去找节会找到邻居家。
// 裁决：闸扩成「小节号 ≡ 它上面那个 H3 的号」，违规点名（哪个小节、挂在哪个 H3 下、应该叫什么）。
// 口径：比较的是**数字本体**（`### 4.4a` 下面的 `#### 4.4-1` 算对，字母后缀不参与比较）；
// 不带号的 `####` 小标题不参与；文档里代码块内没有 `#### N.N-x` 形状的行（实测），
// 所以本闸不跟踪围栏。
//
// 反向自证（常驻）：把 `#### 4.16-1` 挂在 `### 4.17` 下面必须判红且点名两个标题。
// ---------------------------------------------------------------------------

/**
 * 「小节号与主人不一致」的清单（干净文档 ⇒ 空数组）。
 * 每条都带：那一行原文、它挂在哪个 H3 下、以及它**应该**叫什么。
 */
function subsectionNumbersOutOfParent(markdown) {
  const bad = [];
  let h3 = null;   // 当前那个 H3（`### N.N[a-z]*`）
  for (const line of markdown.split('\n')) {
    const m3 = /^### (\d+\.\d+)([a-z]*)\s/.exec(line);
    if (m3) { h3 = { num: m3[1], title: line.trim() }; continue; }
    const m4 = /^#### (\d+\.\d+)-/.exec(line);
    if (!m4) continue;
    if (!h3) {
      bad.push(`${line.trim()} ⇒ 上面没有任何「### N.N」可挂（它得先有个主人）`);
      continue;
    }
    if (m4[1] === h3.num) continue;
    bad.push(`${line.trim()} ⇒ 挂在 ${h3.title} 下面，小节号必须与主人同号（应为 #### ${h3.num}-…）`);
  }
  return bad;
}

test('文档小节归属闸：`#### N.N-x` 的小节号必须等于它上面那个 H3 的号（评审 R9 的盲区）', () => {
  const doc = fs.readFileSync(path.join(HERE, '../../docs/api/portal.md'), 'utf8');
  const out = subsectionNumbersOutOfParent(doc);
  assert.deepEqual(out, [],
    'docs/api/portal.md 里每个「#### N.N-x」的小节号必须与它所属那一节同号：\n' + out.join('\n'));

  // 常驻反向自证·①：真实现场那个形状（`#### 4.16-1` 挂在 `### 4.17` 下面）必须判红。
  const misplaced = subsectionNumbersOutOfParent([
    '### 4.17 能力市场（`/api/market/*`，issue #595）',
    '#### 4.16-1 `GET /api/market/items`',
    '#### 4.17-2 `GET /api/market/items/:slug`',
  ].join('\n'));
  assert.equal(misplaced.length, 1, `只许抓到那一条违规（实得 ${JSON.stringify(misplaced)}）`);
  assert.match(misplaced[0], /#### 4\.16-1/, '要点名**哪个小节**');
  assert.match(misplaced[0], /### 4\.17 能力市场/, '要点名它**挂在哪个 H3 下**');
  assert.match(misplaced[0], /#### 4\.17-/, '要给出它应该叫什么（否则修的人还得自己推）');

  // 常驻反向自证·②：同号但挂错节（两道闸都不拦的形状，只有这条拦得住）。
  assert.equal(subsectionNumbersOutOfParent('### 4.16 关于\n### 4.17 市场\n#### 4.16-1 装').length, 1,
    '小节号在自己的节里、但人已换到下一节 ⇒ 必须报（这正是 H3 唯一性闸的盲区）');

  // 常驻反向自证·③：干净形状不许误伤（同号、字母后缀主人、不带号的小标题、主人之前没有小节）。
  const CLEAN = ['### 4.17 市场', '#### 4.17-1 甲', '#### 4.17-2 乙', '#### 形状约定',
    '### 4.4a 边（字母后缀的主人）', '#### 4.4-1 丙'].join('\n');
  assert.deepEqual(subsectionNumbersOutOfParent(CLEAN), [],
    '合法形状不许假红（字母后缀的主人名下用数字本体比较）');
  // 边界：小节出现在任何 H3 之前 ⇒ 也要点名（不能默默放过）。
  assert.match(subsectionNumbersOutOfParent('#### 4.2-1 孤儿').join('\n'), /没有任何/, '无主小节也要点名');
});

// ---------------------------------------------------------------------------
// 迁移 0047-fde-budget（issue #719 周期额度改造）：把每日额度改成周期额度，未合并故直接改写、不新开 0048。
// 断言：两列存在（budget_usd numeric(12,6) + budget_period text）、两条 CHECK（枚举白名单 + 配对 NULL）、
// 幂等（ADD COLUMN IF NOT EXISTS + 按名 DROP CONSTRAINT IF EXISTS）、lock_timeout、末尾只读 DO 块。
// ---------------------------------------------------------------------------

test('迁移 0047-fde-budget：周期额度两列 + 枚举/配对两条 CHECK + 幂等 + 不写 BEGIN/COMMIT', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  assert.ok(files.includes('0047-fde-budget.sql'), '0047-fde-budget 存在（旧名 fde-daily-budget 已 git mv）');
  assert.ok(!files.includes('0047-fde-daily-budget.sql'), '旧文件名不得残留');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, 'head=48（连续无空洞；0048 已归 #828 合法启用，不再禁止 0048）');
  assert.ok(files.includes('0048-users-locale.sql'), '0048-users-locale 已归 #828，不再禁止 0048');

  const sql = fs.readFileSync(path.join(dir, '0047-fde-budget.sql'), 'utf8');
  // 两列 + 金额精度
  assert.match(sql, /ADD COLUMN IF NOT EXISTS budget_usd numeric\(12,6\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS budget_period text/);
  // ① 枚举 CHECK（照 usage_ledger.source 的 IN 写法）：只允许 '1d'/'1mo'
  assert.match(sql, /CHECK \(budget_period IN \('1d', '1mo'\)\)/);
  // ② 配对 CHECK：金额与周期同生同灭（NULL ⇔ NULL）
  assert.match(sql, /CHECK \(\(budget_usd IS NULL\) = \(budget_period IS NULL\)\)/);
  // 幂等：列 IF NOT EXISTS + 配对约束按名 DROP IF EXISTS 后 ADD
  assert.match(sql, /DROP CONSTRAINT IF EXISTS fde_llm_bindings_budget_pair_null_check/);
  assert.match(sql, /SET lock_timeout/);
  // 自己不写事务边界（归 runner）
  assert.doesNotMatch(sql, /^\s*BEGIN\s*;/im, '不写 BEGIN（事务边界归 runner）');
  assert.doesNotMatch(sql, /^\s*COMMIT\s*;/im, '不写 COMMIT');
  // 只读 DO 块（无写操作）
  assert.match(sql, /DO \$do\$/);
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE fde_llm_bindings SET/i, 'DO 块只读，不得写库');

  // 冻结 baseline 不回写这两列
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!baseline.includes('budget_period'), 'baseline 不得回写 budget_period');
});

// ---------------------------------------------------------------------------
// 迁移 0048-users-locale（issue #828 P1）：`users.locale VARCHAR(8)` 可空，账号级语言偏好。
// 断言：列存在且可空、**值域不写 DB CHECK**（归一化交应用侧白名单，与 0036/0046 同一分层）、
// 幂等（ADD COLUMN IF NOT EXISTS）、lock_timeout、末尾只读 DO 块、不写 BEGIN/COMMIT；
// 以及 baseline 冻结：schema.sql **不回写** locale（DDL 只走增量，同 0006/0008/0009 那一族口径）。
// ---------------------------------------------------------------------------
test('迁移 0048-users-locale：users.locale 可空 + 值域不写 DB CHECK + 幂等 + baseline 不回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  const file = '0048-users-locale.sql';
  assert.ok(files.includes(file), '0048-users-locale 存在');
  // #850 追加 0049 后，0048 不再是末位；这里的语义是「0048 号位没被人插走」。
  assert.ok(files.indexOf(file) === files.length - 2, '0048 仍是倒数第二支（0049 之后）');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, 'head=0049（连续无空洞）');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  // 列定义：可空（无 NOT NULL）、宽 8、幂等
  assert.match(sql, /ALTER TABLE users/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS locale VARCHAR\(8\)/i, '幂等 ADD COLUMN，宽 8');
  assert.doesNotMatch(sql, /ADD COLUMN[^\n]*locale[^\n]*NOT NULL/i, 'locale 必须可空（NULL=跟随浏览器）');
  // 值域故意不写 DB CHECK（交应用侧 normalizeUserLocale；写了 CHECK 非法值回落那条判据真机进不去）
  assert.doesNotMatch(sql, /CHECK\s*\(\s*\(?locale\)?/i, '不得对 locale 写 DB CHECK');
  assert.doesNotMatch(sql, /locale[^\n]*IN\s*\(/i, '不得用 IN 白名单锁 locale 值域');
  // 幂等与纪律
  assert.match(sql, /SET lock_timeout/, '照 0016 的 lock_timeout 纪律');
  assert.doesNotMatch(sql, /^\s*BEGIN\s*;/im, '不写 BEGIN（事务边界归 runner）');
  assert.doesNotMatch(sql, /^\s*COMMIT\s*;/im, '不写 COMMIT');
  // 只读 DO 块（重放证据）
  assert.match(sql, /DO \$do\$/, '末尾只读 DO 块打印重放证据');
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE users SET/i, 'DO 块只读，不得写库');

  // baseline 冻结：locale 只走增量，不写回 baseline（schema.sql 一字节不改，checksum 不漂）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!/\blocale\b/.test(baseline), 'baseline 不得回写 locale（DDL 只走增量迁移）');
});

// ---------------------------------------------------------------------------
// 迁移 0049-notifications-title-key（issue #850）：`notifications.title_key text` + `title_params jsonb`，
// 都可空 —— 标题入库存「键 + 参数」，渲染时按读者语言拼（写入方是调度器，没有语言）。
// 断言：两条 `ADD COLUMN IF NOT EXISTS`（幂等可重放）、**两列都可空**（NULL = 照旧用 title）、
// `title` 的 NOT NULL 不动（存量行逐字不变）、值域不写 DB CHECK（交读侧 `te()` 兜底，与 0048 同一分层）、
// lock_timeout、不写 BEGIN/COMMIT、末尾只读 DO 块；以及 baseline 冻结：schema.sql **不回写**这两列。
// ---------------------------------------------------------------------------
test('迁移 0049-notifications-title-key：两列可空 + title NOT NULL 不动 + 幂等 + baseline 不回写', () => {
  const dir = path.join(HERE, '../../deploy/migrations');
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}-.*\.sql$/.test(f)).sort();
  const file = '0049-notifications-title-key.sql';
  assert.ok(files.includes(file), '0049-notifications-title-key 存在');
  assert.equal(files[files.length - 1], file, '0049 是当前末位迁移（连续无空洞）');
  assert.equal(Number(files[files.length - 1].slice(0, 4)), MIGRATION_HEAD, 'head=0049');

  const sql = fs.readFileSync(path.join(dir, file), 'utf8');
  assert.match(sql, /ALTER TABLE notifications/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS title_key text/i, 'title_key 幂等 ADD COLUMN');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS title_params jsonb/i, 'title_params 是 jsonb 且幂等');
  assert.doesNotMatch(sql, /ADD COLUMN[^\n]*\btitle\s/i, '不得重新声明/重建成品 title 列');
  assert.doesNotMatch(sql, /ADD COLUMN[^;\n]*NOT NULL/i, '新增两列都必须可空（NULL=这条没键，照旧用 title）');
  assert.doesNotMatch(sql, /ALTER COLUMN[^;\n]*title[^;\n]*(SET NOT NULL|DROP NOT NULL)/i, 'title 的 NOT NULL 不动');
  // 值域（键必须在 locales 登记）故意不写 DB CHECK：写了「键未登记 ⇒ 退回 title」那条判据真机进不去。
  assert.doesNotMatch(sql, /CHECK\s*\(\s*title_key/i, '不得对 title_key 写 DB CHECK');
  assert.match(sql, /SET lock_timeout/, '照 0016 的 lock_timeout 纪律');
  assert.doesNotMatch(sql, /^\s*BEGIN\s*;/im, '不写 BEGIN（事务边界归 runner）');
  assert.doesNotMatch(sql, /^\s*COMMIT\s*;/im, '不写 COMMIT');
  assert.match(sql, /DO \$do\$/, '末尾只读 DO 块打印重放证据');
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE notifications SET/i, 'DO 块只读，不得写库');

  // baseline 冻结：两列只走增量，不写回 baseline（schema.sql 一字节不改，checksum 不漂）
  const baseline = fs.readFileSync(path.join(HERE, '../../docs/data/schema.sql'), 'utf8');
  assert.ok(!/title_key/.test(baseline), 'baseline 不得回写 title_key（DDL 只走增量迁移）');
  assert.ok(!/title_params/.test(baseline), 'baseline 不得回写 title_params');
});
