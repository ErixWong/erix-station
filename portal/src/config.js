// 配置读取：从环境变量读入，含开发/生产差异。
// 依据：docs/env.md §0/§10、docs/api/portal.md §2.5（cookie 语义）。
// COOKIE_PROFILE=dev-http 仅限本机 HTTP 联调，禁止进入部署配置。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天，portal.md §2.5

function intEnv(env, key, fallback) {
  const v = Number(env[key] ?? fallback);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * cookie 属性随 COOKIE_PROFILE 切换（portal.md §2.5）。
 * - prod     -> __Host-fde_session + Secure=true（__Host- 前缀强制 Secure+Path=/+无 Domain）
 * - dev-http -> fde_session_dev + Secure=false（去 __Host- 前缀，仅本机 HTTP 联调）
 */
export function cookieSettings(profile = 'prod', ttlSeconds = DEFAULT_SESSION_TTL_SECONDS) {
  if (profile === 'dev-http') {
    return {
      name: 'fde_session_dev',
      secure: false,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: ttlSeconds,
    };
  }
  return {
    name: '__Host-fde_session',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: ttlSeconds,
  };
}

function defaultStaticDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static');
}

export function loadConfig(env = process.env) {
  const sessionTtlSeconds = intEnv(env, 'SESSION_TTL_SECONDS', DEFAULT_SESSION_TTL_SECONDS);
  const cookieProfile = env.COOKIE_PROFILE || 'prod';
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 8080),
    databaseUrl:
      env.DATABASE_URL || 'postgres://station:station@127.0.0.1:5432/station',
    // 迁移身份 station_platform（DDL）与 bootstrap 超级用户（schema 级角色/授权/ownership）。
    // 未拆分（单 DATABASE_URL 联调）时回退到 DATABASE_URL（deploy-contract §2.4/§3）。
    migrateDatabaseUrl:
      env.MIGRATE_DATABASE_URL || env.DATABASE_URL || 'postgres://station:station@127.0.0.1:5432/station',
    bootstrapDatabaseUrl:
      env.BOOTSTRAP_DATABASE_URL || env.MIGRATE_DATABASE_URL || env.DATABASE_URL || 'postgres://station:station@127.0.0.1:5432/station',
    cookieProfile,
    cookie: cookieSettings(cookieProfile, sessionTtlSeconds),
    sessionTtlSeconds,
    // 两步登录（portal.md §2.2）：待决令牌短期、单次消费
    pendingTokenTtlSeconds: intEnv(env, 'PENDING_TOKEN_TTL_SECONDS', 120),
    // 滚动续期：距上次续期超过该间隔才写库并重发 cookie（portal.md §2.5）
    sessionRenewIntervalSeconds: intEnv(env, 'SESSION_RENEW_INTERVAL_SECONDS', 60 * 60),
    // TOTP（RFC 6238）：6 位 / 30s / ±1 窗口 / SHA-1
    totp: {
      issuer: env.TOTP_ISSUER || 'FDE Station',
      digits: 6,
      period: 30,
      window: 1,
    },
    // 登录限流 + KDF 并发（portal.md §2.2/§2.9.4）
    loginRateLimit: {
      maxFailures: intEnv(env, 'LOGIN_RATE_LIMIT_MAX_FAILURES', 5),
      windowMs: intEnv(env, 'LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      blockMs: intEnv(env, 'LOGIN_RATE_LIMIT_BLOCK_MS', 60 * 1000),
      maxEntries: intEnv(env, 'RATE_LIMIT_MAX_ENTRIES', 10000),
    },
    // TOTP 限流按「账户 + IP」计数（防换新 pending_token 绕过），另保留单 token 尝试上限。
    // 退避策略：账户级 10 次失败 / 15 分钟窗口，超限锁定至窗口结束（blockMs = windowMs）。
    totpRateLimit: {
      maxFailures: intEnv(env, 'TOTP_RATE_LIMIT_MAX_FAILURES', 10),
      windowMs: intEnv(env, 'TOTP_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
      blockMs: intEnv(env, 'TOTP_RATE_LIMIT_BLOCK_MS', 15 * 60 * 1000),
      perTokenMaxFailures: intEnv(env, 'TOTP_TOKEN_RATE_LIMIT_MAX_FAILURES', 5),
      maxEntries: intEnv(env, 'RATE_LIMIT_MAX_ENTRIES', 10000),
    },
    kdfConcurrency: intEnv(env, 'KDF_CONCURRENCY', 4),
    // KDF 等待队列上限与排队超时：队列满/超时快速失败（503 kdf_busy），不让请求无限排队。
    kdfQueueLimit: intEnv(env, 'KDF_QUEUE_LIMIT', 100),
    kdfQueueTimeoutMs: intEnv(env, 'KDF_QUEUE_TIMEOUT_MS', 30 * 1000),
    // 请求体上限与字段上限（S3：防止超大 body/字段触发 scrypt 或打爆内存）
    maxBodyBytes: intEnv(env, 'MAX_BODY_BYTES', 64 * 1024),
    maxLoginLength: intEnv(env, 'MAX_LOGIN_LENGTH', 128),
    maxPasswordLength: intEnv(env, 'MAX_PASSWORD_LENGTH', 256),
    baseDomain: env.BASE_DOMAIN || 'localhost',
    migrateOnStart: env.MIGRATE_ON_START !== '0',
    staticDir: env.STATIC_DIR || defaultStaticDir(),
  };
}
