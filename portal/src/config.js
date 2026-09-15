// 配置读取：从环境变量读入，含开发/生产差异。
// 依据：docs/env.md §0/§10、docs/api/portal.md §2.5（cookie 语义）。
// COOKIE_PROFILE=dev-http 仅限本机 HTTP 联调，禁止进入部署配置。

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天，portal.md §2.5

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
  const sessionTtlSeconds = Number(env.SESSION_TTL_SECONDS || DEFAULT_SESSION_TTL_SECONDS);
  const cookieProfile = env.COOKIE_PROFILE || 'prod';
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 8080),
    databaseUrl:
      env.DATABASE_URL || 'postgres://station:station@127.0.0.1:5432/station',
    cookieProfile,
    cookie: cookieSettings(cookieProfile, sessionTtlSeconds),
    sessionTtlSeconds,
    baseDomain: env.BASE_DOMAIN || 'localhost',
    migrateOnStart: env.MIGRATE_ON_START !== '0',
    staticDir: env.STATIC_DIR || defaultStaticDir(),
  };
}
