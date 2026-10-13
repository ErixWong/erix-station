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

// ---- issue #280：迁移身份必须与业务表属主一致（口径见 deploy/migrations/README.md「迁移身份」）----
// 事实链：docs/data/bootstrap.sql:52-56 把 public 下表/序列属主**归正给平台库角色**（deploy/.env 的
//   PLATFORM_DB_USER，缺省 station_platform），并声明前提「后续 deploy/migrations/* 由其执行」。
//   而 PG 的 `ALTER SEQUENCE … OWNED BY` 要求序列与表**同属主**（routine=process_owned_by）；
//   0016 正是 CREATE SEQUENCE + OWNED BY 的形状 ⇒ 迁移连接角色 ≠ 表属主时，**整个迁移在 0016 失败**。
//   触发面：config.js 的 migrateDatabaseUrl 缺省回退 DATABASE_URL（通常是超级用户）⇒ 只设 DATABASE_URL
//   的手工/救灾路径必炸（compose 显式设 MIGRATE_DATABASE_URL=平台角色，故不触发）。
// 落点：必须在 applyBootstrap **之后**（bootstrap.sql 要 CREATE ROLE / GRANT / 归正属主，非超级用户
//   跑不动它，且「谁是属主」这件事本身就是它决定的）、增量迁移循环**之前**。把属主同步挪到迁移前或
//   迁移后都救不了（0016 在循环内部就炸，同步跑不到——已实测否决）。
// 不改迁移文件字节：runner 按 sha256 记 checksum，改既有迁移 = 现存库全部拒启。
const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_$]{0,62}$/i;

/** 角色名是标识符不是值：白名单校验 + 双引号包裹（防注入，且允许 $ / 数字等非默认折叠字符）。 */
function quoteRoleIdentifier(name, label) {
  if (typeof name !== 'string' || !ROLE_IDENTIFIER.test(name)) {
    throw new Error(`${label}「${name}」不是合法的角色标识符（^[a-z_][a-z0-9_$]{0,62}$）`);
  }
  return `"${name}"`;
}

/** 取连接串里的连接角色名（解析不出来 → null）。口径与 config.js 的 migrateDatabaseUrl 一致。 */
export function roleFromDatabaseUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const user = decodeURIComponent(new URL(url).username || '').trim();
    return user || null;
  } catch {
    return null;
  }
}

/**
 * 目标迁移角色 = 必须与业务表同属主的那个角色。**纯函数，不碰 DB**（无 PG 环境也能单测）。
 * 优先级：显式注入 platformRole / env.PLATFORM_DB_USER（配置点名）> 迁移连接串用户 > 库内实测表属主。
 * 取不到（或与当前角色同名）⇒ 返回当前角色 ⇒ 调用方必须是**无副作用的 no-op**（compose 路径即此形态）。
 * 「实测表属主」这一档是救灾路径的关键：只设 DATABASE_URL 时连接串用户就是超级用户（= 当前角色，
 * 点名等于没说），而 PG 的约束字面上就是「与表同属主」，所以从库里量出来的必然是对的那个角色。
 */
export function resolveMigrationRole({ configured, urlRole, measuredOwner, currentRole } = {}) {
  const current = typeof currentRole === 'string' ? currentRole.trim() : '';
  for (const candidate of [configured, urlRole, measuredOwner]) {
    const role = typeof candidate === 'string' ? candidate.trim() : '';
    if (role && role !== current) return role;
  }
  return current;
}

/** 量出「业务表属主」：优先 schema_migrations（runner 自己写的表），否则取 public 下最多的那个属主。 */
const OWNER_OF_APPLIED_OBJECTS_SQL = `SELECT COALESCE(
         (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'),
         (SELECT tableowner FROM pg_tables WHERE schemaname = 'public'
             GROUP BY tableowner ORDER BY count(*) DESC, tableowner LIMIT 1)
       ) AS owner`;

/**
 * 把当前连接切到平台库角色（= 业务表属主）。返回 { changed, target, previous } 供 finally 还原。
 * 已是该角色 ⇒ 不发任何语句（无副作用 no-op）；SET ROLE 被拒 ⇒ fail fast 报可操作错误，
 * 不让人到 0016 里去读 PG 内部报错（静默跳过 = 陷阱还在，同样不允许）。
 */
async function enterMigrationRole(client, { configuredRole, urlRole, log }) {
  const measuredOwner = (await client.query(OWNER_OF_APPLIED_OBJECTS_SQL)).rows?.[0]?.owner ?? null;
  const currentRole = (await client.query('SELECT current_user AS role')).rows?.[0]?.role ?? '';
  const target = resolveMigrationRole({
    configured: configuredRole,
    urlRole,
    measuredOwner,
    currentRole,
  });
  if (!target) return { changed: false, target: null, previous: currentRole };
  if (target === currentRole) {
    log.log(`[migrate] 迁移身份已是平台库角色 ${target}（无副作用 no-op，不发 SET ROLE）`);
    return { changed: false, target, previous: currentRole };
  }
  try {
    await client.query(`SET ROLE ${quoteRoleIdentifier(target, '目标迁移角色')}`);
  } catch (err) {
    throw new Error(
      `[migrate] 迁移身份切换失败：当前连接角色 ${currentRole} 无法 SET ROLE 到平台库角色 ${target}，` +
        `无法承担 DDL 属主（迁移内 CREATE … OWNED BY 要求与表同属主，见 0016）。` +
        `请把 MIGRATE_DATABASE_URL 指向平台库角色 ${target}（= deploy/.env 的 PLATFORM_DB_USER；` +
        `只设 DATABASE_URL 时 migrateDatabaseUrl 回退成它，通常是超级用户，承担不了 DDL 属主）。` +
        `原始错误：${err.message}`,
      { cause: err },
    );
  }
  log.log(`[migrate] SET ROLE ${target}（原连接角色 ${currentRole}；迁移循环结束/异常后还原）`);
  return { changed: true, target, previous: currentRole };
}

/** 还原角色：pool 会复用连接，残留 SET ROLE 会把后续同连接查询的属主语义一起改掉（必须还原）。 */
async function exitMigrationRole(client, state, log) {
  if (!state || !state.changed) return;
  try {
    await client.query('RESET ROLE');
    log.log(`[migrate] RESET ROLE（还原连接角色 ${state.previous}）`);
  } catch (err) {
    // eslint-disable-next-line no-console
    log.log(`[migrate] ⚠️ RESET ROLE 失败：连接归还 pool 后角色可能残留（${state.previous} → ${state.target}）：${err.message}`);
  }
}

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
  // 平台库角色点名（issue #280）：显式注入 > PLATFORM_DB_USER > 迁移连接串用户（见 config.js:144-151）。
  const env = opts.env ?? process.env;
  const configuredRole = opts.platformRole ?? env.PLATFORM_DB_USER ?? null;
  const urlRole = roleFromDatabaseUrl(
    opts.migrateDatabaseUrl ?? env.MIGRATE_DATABASE_URL ?? env.DATABASE_URL,
  );

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

    // 迁移身份对齐（issue #280）：上面 applyBootstrap 已把属主归正给平台库角色，这里把**本连接**
    // 切成那个角色，循环里的 DDL 与 schema_migrations 写入都以它执行（否则 0016 的
    // `ALTER SEQUENCE … OWNED BY` 撞 `sequence must have same owner as table it is linked to`）。
    const roleState = await enterMigrationRole(client, { configuredRole, urlRole, log });
    try {
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
    } finally {
      // 成功与异常两条路径都必须还原（连接马上要归还 pool 复用）。
      await exitMigrationRole(client, roleState, log);
    }

    return { baselineAppliedNow: !baselineApplied, baselineChecksum: expectedBaselineChecksum };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
