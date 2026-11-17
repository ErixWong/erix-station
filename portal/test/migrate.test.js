// issue #596 评审 R10：迁移**台账的反向对账**（无 PG 也能跑的护栏）。
//
// 病：`0039-platform-prompts` 换号成 `0040-platform-prompts` 之后，已部署库 `schema_migrations`
// 里那条旧行成了孤儿。`portal/src/migrate.js` 的循环一直只按**本地文件**正向查库
// （`SELECT checksum FROM schema_migrations WHERE version = $1`），从不反过来对账
// ⇒ 那条旧 checksum 再也不校验（库里形状被改了也没人报警）。
//
// 本文件钉四件事：
//   ① 台账里有、本地没有 ⇒ 启动时 **warn 点名**（列出具体 version），且**不许 fail**；
//   ② 差集口径的常驻反向自证（方向写反必红：它是「台账 − 本地」，不是「本地 − 台账」）；
//   ③ 没有孤儿时**一条 warn 都不许发**（否则①的绿是「总是 warn」糊出来的）；
//   ④ 反向对账那条查询自己炸了（老库没这张表 / 没权限）也只 warn，**不许把启动弄挂**。
// 隔离约定（docs/testing.md §2.1）：内存 fake pool + 临时目录，不碰真实 DB / 真实容器 / 真实网络。
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrate, findOrphanLedgerVersions } from '../src/migrate.js';

const BASELINE = '0000_baseline';
const sha = (text) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;

/** 临时目录：一份 schema.sql / bootstrap.sql + 一棵只含指定迁移文件的 migrations 目录。 */
async function withSandbox(migrationFiles, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-orphan-'));
  try {
    const schemaSqlPath = path.join(dir, 'schema.sql');
    const bootstrapSqlPath = path.join(dir, 'bootstrap.sql');
    const migrationsDir = path.join(dir, 'migrations');
    fs.mkdirSync(migrationsDir);
    const schemaSql = '-- sandbox baseline\nSELECT 1;\n';
    fs.writeFileSync(schemaSqlPath, schemaSql);
    fs.writeFileSync(bootstrapSqlPath, '-- sandbox bootstrap\nSELECT 1;\n');
    // 台账里已应用的那些行，checksum 必须与本地文件算出来的一致（否则跑到 checksum 失配那条红，
    // 与本节要测的「反向对账」是两件事）。
    const checksums = new Map([[BASELINE, sha(schemaSql)]]);
    for (const [name, body] of Object.entries(migrationFiles)) {
      fs.writeFileSync(path.join(migrationsDir, name), body);
      checksums.set(name.replace(/\.sql$/, ''), sha(body));
    }
    return await fn({ schemaSqlPath, bootstrapSqlPath, migrationsDir, checksums });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** warn / log 两个出口都收（`migrate.js` 优先 `log.warn`，没有才退回 `log.log`）。 */
function captureLog() {
  const warns = [];
  const logs = [];
  const sink = (m) => logs.push(String(m));
  return { warns, logs, log: { log: sink, warn: (m) => warns.push(String(m)) } };
}

/**
 * 只认识 `migrate.js` 真会发的那些语句的假 pool；`ledger` = 台账里现存的 version 行。
 * `failLedgerScan` 注入的是**反向对账那条查询**本身炸掉（判据④）。
 */
function makeFakePool({ ledger = [], checksums = new Map(), failLedgerScan = null } = {}) {
  const trace = [];
  const client = {
    async query(sql, params = []) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      trace.push(s.slice(0, 140));
      if (/pg_advisory_(un)?lock/i.test(s)) return { rows: [] };
      if (s.includes('to_regclass')) return { rows: [{ rel: 'public.schema_migrations' }] };
      if (/^SELECT current_user AS role$/i.test(s)) return { rows: [{ role: 'station_platform' }] };
      if (s.includes('pg_tables')) return { rows: [{ owner: 'station_platform' }] };
      // ★ 反向对账那条（评审 R10 新加的）。必须与下面那条正向查询**分开**认，别混成一条。
      if (/SELECT version FROM schema_migrations ORDER BY version/i.test(s)) {
        if (failLedgerScan) throw failLedgerScan;
        return { rows: ledger.map((version) => ({ version })) };
      }
      if (/SELECT version FROM schema_migrations WHERE version = \$1/i.test(s)) {
        return { rows: ledger.includes(params[0]) ? [{ version: params[0] }] : [] };
      }
      if (/SELECT checksum FROM schema_migrations WHERE version = \$1/i.test(s)) {
        if (!ledger.includes(params[0])) return { rows: [] };
        return { rows: [{ checksum: checksums.get(params[0]) ?? 'sha256:故意不匹配' }] };
      }
      return { rows: [] };
    },
    release() { trace.push('<<release>>'); },
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [] }; },
    async end() {},
  };
  return { pool, trace };
}

// 一台「换过一次号」的库：本地只有 0040，台账里 0039 那一行还留着。
const SANDBOX_FILES = { '0040-test-one.sql': '-- 0040\nSELECT 1;\n' };
const LEDGER_AFTER_RENAME = [BASELINE, '0040-test-one', '0039-test-orphan'];

test('R10① 台账里有、本地没有 ⇒ 启动 warn **点名那条**（正常那条不许被牵连，也不 fail）', async () => {
  await withSandbox(SANDBOX_FILES, async (sb) => {
    const { pool, trace } = makeFakePool({ ledger: LEDGER_AFTER_RENAME, checksums: sb.checksums });
    const { warns, logs, log } = captureLog();
    const opts = { schemaSqlPath: sb.schemaSqlPath, bootstrapSqlPath: sb.bootstrapSqlPath,
      migrationsDir: sb.migrationsDir, env: {} };
    const done = await migrate(pool, { ...opts, log });

    assert.deepEqual(done.orphanLedgerVersions, ['0039-test-orphan'],
      `终局要带着那一条（运维要能对账），实得：${JSON.stringify(done.orphanLedgerVersions)}`);
    assert.equal(warns.length, 1, `恰好一条 warn（实得 ${JSON.stringify(warns)}）`);
    assert.match(warns[0], /0039-test-orphan/, 'warn 必须**点名具体 version**，不是「有孤儿」这种空话');
    assert.equal(warns[0].includes('0040-test-one'), false, '正常那条不许出现在 warn 里（不许连坐）');
    assert.equal(warns[0].includes(BASELINE), false, 'baseline 有独立来源，不许被当成孤儿');
    assert.ok(trace.some((q) => /SELECT version FROM schema_migrations ORDER BY version/.test(q)),
      '反向对账必须真发一条查询（不发 = 恒绿的假绿）');
    assert.ok(logs.some((l) => l.includes('SET ROLE') || l.includes('no-op')), '正向流程照旧跑到');
    assert.ok(trace.some((q) => /<<release>>/.test(q)), '连接仍要归还 pool（这条闸不许改生命周期）');
  });
});

test('R10③ 没有孤儿 ⇒ 一条 warn 都不许发（①的绿不是「总是 warn」糊出来的）', async () => {
  await withSandbox(SANDBOX_FILES, async (sb) => {
    const { pool } = makeFakePool({ ledger: [BASELINE, '0040-test-one'], checksums: sb.checksums });
    const { warns, logs, log } = captureLog();
    const opts = { schemaSqlPath: sb.schemaSqlPath, bootstrapSqlPath: sb.bootstrapSqlPath,
      migrationsDir: sb.migrationsDir, env: {} };
    const done = await migrate(pool, { ...opts, log });
    assert.deepEqual(done.orphanLedgerVersions, [], '台账与本地逐条一致 ⇒ 孤儿清单必须为空');
    assert.deepEqual(warns, [], `没有孤儿时不许 warn（实得 ${JSON.stringify(warns)}）`);
    assert.ok(logs.length > 0, '正向日志还在（这条绿不是把整个 runner 跑空了）');
  });
});

test('R10④ 反向对账那条查询自己炸了 ⇒ 只 warn，启动不许挂', async () => {
  await withSandbox(SANDBOX_FILES, async (sb) => {
    const { pool } = makeFakePool({
      ledger: [BASELINE, '0040-test-one'],
      checksums: sb.checksums,
      failLedgerScan: new Error('permission denied for table schema_migrations'),
    });
    const { warns, log } = captureLog();
    const opts = { schemaSqlPath: sb.schemaSqlPath, bootstrapSqlPath: sb.bootstrapSqlPath,
      migrationsDir: sb.migrationsDir, env: {} };
    const done = await migrate(pool, { ...opts, log });
    assert.deepEqual(done.orphanLedgerVersions, [], '对账没跑成 ⇒ 孤儿清单按空处理（不猜一份）');
    assert.equal(warns.length, 1, `只该一条 warn（实得 ${JSON.stringify(warns)}）`);
    assert.match(warns[0], /permission denied/, '原始错误要留在 warn 里（运维查得出来）');
    assert.match(warns[0], /不影响启动/, '要说清这是运维面，不是正确性面');
  });
});

test('R10② 差集口径（常驻反向自证）：只认「台账有而本地没有」，方向写反必红', () => {
  const local = [BASELINE, '0040-platform-prompts'];
  // 正例：换号现场（旧号那一行留在台账里）。
  assert.deepEqual(
    findOrphanLedgerVersions([BASELINE, '0040-platform-prompts', '0039-platform-prompts'], local),
    ['0039-platform-prompts'], '旧号那条必须被抓出来');
  // 反向自证·方向：本地清空 ⇒ 台账全部是孤儿（写成「本地 − 台账」的话这里会得空数组 ⇒ 恒绿）。
  assert.deepEqual(findOrphanLedgerVersions([BASELINE, '0039-x', '0040-y'], []).slice().sort(),
    [BASELINE, '0039-x', '0040-y'].sort(), '方向写反就是恒绿：本地为空时台账必须全算孤儿');
  // 反向自证·另一侧：台账为空（全新库）⇒ 不许把本地还没应用的迁移报成孤儿。
  assert.deepEqual(findOrphanLedgerVersions([], local), [], '新库一条台账都没有 ⇒ 不许有任何孤儿');
  // 台账与本地逐条相同 ⇒ 空（否则判据③那条「不许 warn」永远做不到）。
  assert.deepEqual(findOrphanLedgerVersions(local, local), [], '一致 ⇒ 空');
  // 形状边界：重复行去重、空值忽略、输出升序（点名要可复现）；缺入参不许抛。
  assert.deepEqual(findOrphanLedgerVersions(['0042-z', null, '0042-z', '', '0041-a'], []),
    ['0041-a', '0042-z'], '去重 + 忽略空值 + 升序');
  assert.deepEqual(findOrphanLedgerVersions(undefined, undefined), [], '缺入参不许抛');
});
