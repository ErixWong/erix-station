#!/usr/bin/env node
// CLI 入口：serve / migrate / bootstrap-admin / healthcheck。
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import * as auth from './auth.js';
import { createServer } from './http.js';

function usage() {
  // eslint-disable-next-line no-console
  console.error(
    'usage:\n' +
      '  cli.js serve\n' +
      '  cli.js migrate\n' +
      '  cli.js bootstrap-admin --login <name> [--password <pw>] [--display-name <name>] [--allow-extra]\n' +
      '  cli.js healthcheck',
  );
}

async function serve() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  if (config.migrateOnStart) {
    try {
      const summary = await migrate(pool, {});
      // eslint-disable-next-line no-console
      console.log('[migrate] ok', summary);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[migrate] failed:', err.message);
      await pool.end().catch(() => {});
      process.exit(1);
    }
  }
  const server = createServer({ pool, config });
  server.listen(config.port, config.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[portal] listening on http://${config.host}:${config.port} (cookie=${config.cookie.name}, secure=${config.cookie.secure})`,
    );
  });
}

async function runMigrate() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const summary = await migrate(pool, {});
    // eslint-disable-next-line no-console
    console.log('[migrate] done', summary);
    process.exitCode = 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function bootstrapAdmin(values) {
  const login = values.login;
  if (!login) {
    // eslint-disable-next-line no-console
    console.error('--login is required');
    process.exit(2);
  }
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    await migrate(pool, {});
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  try {
    const loginTaken = await pool.query(`SELECT 1 FROM users WHERE login = $1`, [login]);
    if (loginTaken.rows.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`login ${login} 已存在`);
      process.exit(1);
    }
    const existing = await pool.query(
      `SELECT 1 FROM users WHERE role = 'admin' AND status = 'active' LIMIT 1`,
    );
    if (existing.rows.length > 0 && !values['allow-extra']) {
      // eslint-disable-next-line no-console
      console.error('已有 active admin；如需再建请加 --allow-extra');
      process.exit(1);
    }

    let password = values.password;
    let generated = false;
    if (!password) {
      password = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
    const passwordHash = await auth.hashPassword(password);
    const displayName = values['display-name'] || login;
    await pool.query(
      `INSERT INTO users (login, display_name, role, auth_source, status, password_hash)
       VALUES ($1, $2, 'admin', 'local', 'active', $3)`,
      [login, displayName, passwordHash],
    );
    // eslint-disable-next-line no-console
    console.log(`created admin login=${login} display_name=${displayName}`);
    // eslint-disable-next-line no-console
    console.log(`${generated ? 'generated password' : 'password'}: ${password}`);
    if (generated) {
      // eslint-disable-next-line no-console
      console.log('⚠️ 请立即记录此一次性口令（P1 skeleton 暂无强制改密 UI）');
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

async function healthcheck() {
  // 等价 wget -qO- http://127.0.0.1:8080/api/health（deploy-contract §2.3）：
  // 命中 /healthz，200 才算就绪（DB 可达 + 迁移到 head 由服务端判定）。
  const config = loadConfig();
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.log('ok');
      process.exitCode = 0;
    } else {
      // eslint-disable-next-line no-console
      console.error(`not ready (HTTP ${res.status})`);
      process.exitCode = 1;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('not ready:', err.message);
    process.exitCode = 1;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      login: { type: 'string' },
      password: { type: 'string' },
      'display-name': { type: 'string' },
      'allow-extra': { type: 'boolean', default: false },
    },
  });
  const [command] = positionals;
  switch (command) {
    case 'serve':
      return serve();
    case 'migrate':
      return runMigrate();
    case 'bootstrap-admin':
      return bootstrapAdmin(values);
    case 'healthcheck':
      return healthcheck();
    default:
      usage();
      process.exit(2);
  }
}

main();
