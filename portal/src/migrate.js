// 迁移 runner：advisory lock 串行化（单实例并发安全），按序应用 baseline（schema.sql）→ bootstrap.sql
//   → deploy/migrations/*.sql（文件名升序），幂等，失败可恢复。
// 依据：docs/design/deploy-contract.md §3。
//   - baseline = docs/data/schema.sql（自带 BEGIN..COMMIT，自包含）。哨兵 checksum 由 runner 在应用后
//     写回真实 sha256（哨兵值 = 'sha256:<computed-by-migration-runner>'），并把「哨兵→真实值」纳入
//     可靠状态机（失败可重跑，不留下已提交 schema + 哨兵 checksum 的半成品态）。
//   - bootstrap.sql 含 psql \gexec 元命令，本 runner 做最小等价模拟，并在单个事务内执行（明确事务边界）。
//   - 每个增量迁移在单事务内执行 + 落 schema_migrations 行；checksum 失配 → 拒绝启动。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

// 迁移 advisory lock key：任意固定 64-bit 整数，本平台专用。
const MIGRATION_LOCK_KEY = 74452311;

// schema.sql 内部插入的哨兵 checksum（见 docs/data/schema.sql §10）。
const BASELINE_SENTINEL = 'sha256:<computed-by-migration-runner>';
const BASELINE_VERSION = '0000_baseline';

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function defaultSchemaSqlPath() {
  return path.resolve(REPO_ROOT, 'docs/data/schema.sql');
}

export function defaultBootstrapSqlPath() {
  return path.resolve(REPO_ROOT, 'docs/data/bootstrap.sql');
}

export function defaultMigrationsDir() {
  return path.resolve(REPO_ROOT, 'deploy/migrations');
}

/** 列出增量迁移文件（文件名升序）。 */
export function listMigrationFiles(migrationsDir = defaultMigrationsDir()) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ version: f.replace(/\.sql$/, ''), file: path.join(migrationsDir, f) }));
}

/** 期望已应用的全部版本（baseline + 全部增量迁移），供 readiness 对比实际 migration head。 */
export function computeExpectedVersions(migrationsDir = defaultMigrationsDir()) {
  const versions = [BASELINE_VERSION];
  for (const m of listMigrationFiles(migrationsDir)) versions.push(m.version);
  return versions;
}

export async function isBaselineApplied(pool) {
  const r = await pool.query(
    `SELECT version FROM schema_migrations WHERE version = $1`,
    [BASELINE_VERSION],
  );
  return Array.isArray(r.rows) && r.rows.length > 0;
}

async function schemaMigrationsExists(pool) {
  const r = await pool.query(`SELECT to_regclass('public.schema_migrations') AS rel`);
  return !!(r.rows?.[0] && r.rows[0].rel != null);
}

async function baselineChecksum(pool) {
  const r = await pool.query(
    `SELECT checksum FROM schema_migrations WHERE version = $1`,
    [BASELINE_VERSION],
  );
  return r.rows?.[0]?.checksum ?? null;
}

/**
 * 把 psql 脚本拆成「普通语句」与「\gexec 单元」。
 * \gexec 语义：其前的 SELECT 逐行返回 SQL 文本，再逐条执行这些文本。
 */
function splitPsqlStatements(sql) {
  const units = [];
  let buf = [];
  for (const rawLine of sql.split('\n')) {
    const line = rawLine.replace(/--.*$/, '').replace(/\s+$/, '');
    const trimmed = line.trim();
    if (trimmed.endsWith('\\gexec')) {
      const before = trimmed.slice(0, trimmed.length - '\\gexec'.length).trim();
      if (before) buf.push(before);
      const stmt = buf.join('\n').trim();
      if (stmt) units.push({ gexec: true, sql: stmt });
      buf = [];
    } else if (trimmed) {
      buf.push(line);
    }
  }
  const rest = buf.join('\n').trim();
  if (rest) units.push({ gexec: false, sql: rest });
  return units;
}

/** 在单个事务内执行 bootstrap.sql（\gexec 模拟 + 明确事务边界）。 */
async function applyBootstrap(client, sql, log) {
  await client.query('BEGIN');
  try {
    for (const unit of splitPsqlStatements(sql)) {
      if (unit.gexec) {
        const res = await client.query(unit.sql);
        for (const row of res.rows ?? []) {
          const cmd = row[Object.keys(row)[0]];
          if (cmd && typeof cmd === 'string' && cmd.trim()) {
            log.log(`[migrate] bootstrap gexec: ${cmd}`);
            await client.query(cmd);
          }
        }
      } else if (unit.sql.trim()) {
        await client.query(unit.sql);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function migrate(pool, opts = {}) {
  const schemaSqlPath = opts.schemaSqlPath ?? defaultSchemaSqlPath();
  const bootstrapSqlPath = opts.bootstrapSqlPath ?? defaultBootstrapSqlPath();
  const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();
  const log = opts.log ?? console;
  // 迁移身份（station_platform）与 bootstrap 超级用户可分离；未拆分时回退到同一 pool。
  const bootstrapPool = opts.bootstrapPool ?? pool;

  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
  const expectedBaselineChecksum = `sha256:${sha256(schemaSql)}`;

  // 使用单一连接持有 session 级 advisory lock，串行化并发迁移进程。
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const exists = await schemaMigrationsExists(client);
    const baselineApplied = exists && (await isBaselineApplied(client));

    if (!baselineApplied) {
      log.log('[migrate] applying baseline (schema.sql)');
      // schema.sql 自带 BEGIN..COMMIT；node-pg simple protocol 支持多语句单事务。
      await client.query(schemaSql);
    }

    // baseline checksum 状态机：哨兵/缺失 → 回填真实 sha256（失败可重跑恢复）；
    // 已是其它值且与真实 sha256 不符 → 拒绝启动（防改历史）。
    const stored = await baselineChecksum(client);
    if (stored === null || stored === BASELINE_SENTINEL) {
      await client.query('BEGIN');
      try {
        await client.query(
          `UPDATE schema_migrations SET checksum = $1 WHERE version = $2`,
          [expectedBaselineChecksum, BASELINE_VERSION],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      log.log(`[migrate] baseline checksum recorded (${expectedBaselineChecksum})`);
    } else if (stored !== expectedBaselineChecksum) {
      throw new Error(
        `baseline checksum mismatch (stored=${stored}, expected=${expectedBaselineChecksum}); refusing to start`,
      );
    }

    log.log('[migrate] applying bootstrap.sql (single transaction)');
    const bootstrapClient = bootstrapPool === pool ? client : await bootstrapPool.connect();
    try {
      await applyBootstrap(bootstrapClient, fs.readFileSync(bootstrapSqlPath, 'utf8'), log);
    } finally {
      if (bootstrapPool !== pool) bootstrapClient.release();
    }

    // 增量迁移（deploy/migrations/*.sql，文件名升序）。
    for (const { version, file } of listMigrationFiles(migrationsDir)) {
      const content = fs.readFileSync(file, 'utf8');
      const checksum = `sha256:${sha256(content)}`;
      const existing = await client.query(
        `SELECT checksum FROM schema_migrations WHERE version = $1`,
        [version],
      );
      if (existing.rows.length > 0) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`migration ${version} checksum mismatch; refusing to start`);
        }
        continue;
      }
      log.log(`[migrate] applying ${version}`);
      await client.query('BEGIN');
      try {
        await client.query(content);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
          [version, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    return { baselineAppliedNow: !baselineApplied, baselineChecksum: expectedBaselineChecksum };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
