// 迁移 runner：按顺序应用 schema.sql（baseline）与 bootstrap.sql，幂等。
// 依据：docs/design/deploy-contract.md §3。
//   - baseline = docs/data/schema.sql（单事务 BEGIN..COMMIT，自包含），空库首次应用；
//     应用后由本 runner 把真实 sha256 写回 schema_migrations.checksum。
//   - bootstrap.sql 含 psql \gexec 元命令，本 runner 做最小等价模拟（跑出 SELECT 结果串再执行）。
//   - deploy/migrations/*.sql 按文件名升序应用（P1 skeleton 尚无，机制预留）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

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

export async function isBaselineApplied(pool) {
  const r = await pool.query(
    `SELECT version FROM schema_migrations WHERE version = '0000_baseline'`,
  );
  return Array.isArray(r.rows) && r.rows.length > 0;
}

async function schemaMigrationsExists(pool) {
  const r = await pool.query(`SELECT to_regclass('public.schema_migrations') AS rel`);
  return !!(r.rows?.[0] && r.rows[0].rel != null);
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

async function applyBootstrap(pool, sql, log) {
  for (const unit of splitPsqlStatements(sql)) {
    if (unit.gexec) {
      const res = await pool.query(unit.sql);
      for (const row of res.rows ?? []) {
        const cmd = row[Object.keys(row)[0]];
        if (cmd && typeof cmd === 'string' && cmd.trim()) {
          log.log(`[migrate] bootstrap gexec: ${cmd}`);
          await pool.query(cmd);
        }
      }
    } else if (unit.sql.trim()) {
      await pool.query(unit.sql);
    }
  }
}

export async function migrate(pool, opts = {}) {
  const schemaSqlPath = opts.schemaSqlPath ?? defaultSchemaSqlPath();
  const bootstrapSqlPath = opts.bootstrapSqlPath ?? defaultBootstrapSqlPath();
  const migrationsDir = opts.migrationsDir ?? defaultMigrationsDir();
  const log = opts.log ?? console;

  const schemaSql = fs.readFileSync(schemaSqlPath, 'utf8');
  const expectedBaselineChecksum = `sha256:${sha256(schemaSql)}`;
  const exists = await schemaMigrationsExists(pool);
  const baselineApplied = exists && (await isBaselineApplied(pool));

  if (!baselineApplied) {
    log.log('[migrate] applying baseline (schema.sql)');
    // schema.sql 自带 BEGIN..COMMIT；无参数 → node-pg 走 simple protocol，支持多语句单事务。
    await pool.query(schemaSql);
    await pool.query(
      `UPDATE schema_migrations SET checksum = $1 WHERE version = '0000_baseline'`,
      [expectedBaselineChecksum],
    );
  } else {
    const r = await pool.query(
      `SELECT checksum FROM schema_migrations WHERE version = '0000_baseline'`,
    );
    const stored = r.rows?.[0]?.checksum;
    if (stored && stored !== expectedBaselineChecksum) {
      throw new Error(
        `baseline checksum mismatch (stored=${stored}, expected=${expectedBaselineChecksum}); refusing to start`,
      );
    }
  }

  log.log('[migrate] applying bootstrap.sql');
  await applyBootstrap(pool, fs.readFileSync(bootstrapSqlPath, 'utf8'), log);

  // 增量迁移（deploy/migrations/*.sql，文件名升序）。P1 skeleton 尚无文件。
  if (fs.existsSync(migrationsDir)) {
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, '');
      const content = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
      const checksum = `sha256:${sha256(content)}`;
      const existing = await pool.query(
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
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(content);
        await client.query(
          `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
          [version, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
  }

  return { baselineAppliedNow: !baselineApplied, baselineChecksum: expectedBaselineChecksum };
}
