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

/**
 * 预览 cookie（host-only）属性随 COOKIE_PROFILE 切换（portal.md §2.8）。
 * - prod     -> __Host-fde_preview + Secure=true（host-only 于当前预览 host）
 * - dev-http -> fde_preview_dev + Secure=false（仅本机 HTTP 联调）
 */
export function previewCookieSettings(profile = 'prod', ttlSeconds = 15 * 60) {
  if (profile === 'dev-http') {
    return {
      name: 'fde_preview_dev',
      secure: false,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: ttlSeconds,
    };
  }
  return {
    name: '__Host-fde_preview',
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
  // 生产判定：FDE_DEV_MODE=1 显式开发（即使镜像内 NODE_ENV=production 也按开发）；
  // FDE_DEV_MODE=0 显式生产；未设时按 NODE_ENV=production 判生产，否则开发。
  const fdeDevMode =
    env.FDE_DEV_MODE === '1' ? true : env.FDE_DEV_MODE === '0' ? false : env.NODE_ENV !== 'production';

  // F12：生产模式要求 FDE_IMAGE 为不可变引用形态（issue #27 pin 双轨，P1 = image ID 路线）：
  //   `image@sha256:<digest>`（repo digest，push/pull 后才有）或 `sha256:<imageId>`（目标机本地
  //   build 的 image ID——本地 build 的 RepoDigests 为空，唯一不可变引用）；dev 允许 tag 但警告。
  const fdeImage = env.FDE_IMAGE || 'traefik/whoami';
  // 严格两分支（审计 #34 F-D）：旧的 `/@?sha256:[0-9a-f]{64}$/` 是 lax-accept——`repo@evilsha256:<hex>`、
  // `任意串sha256:<hex>` 都能过（Docker 后续会拒，但校验口径与错误信息不符）。分支：
  //   ① image ID：`sha256:<64hex>`
  //   ② repo digest：`<合法镜像引用>@sha256:<64hex>`（引用可含 registry host:port / path / tag）
  const imageIdRef = /^sha256:[0-9a-f]{64}$/;
  // repo digest 引用按 docker reference 语法校验（评审 A：仅字符集允许仍会收 `repo//foo@…`、
  // `repo:tag:extra@…` 这类 malformed）。构成：[host[:port]/]path[:tag]
  //   host：域名标签（允许大写——域名大小写不敏感）  path：小写 [a-z0-9] 段，`/` 分隔且不得为空
  //   tag：`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`
  // 名称段分隔符对齐 docker：`[._]|__|[-]+`（评审 B info：单 `[._-]` 会误拒 `foo__bar`/`foo--bar`）
  const repoNameSeg = '[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*';
  const repoPath = `${repoNameSeg}(?:/${repoNameSeg})*`;
  // registry host 严格对齐 docker 的 splitDockerDomain（评审 B，两轮）——首段满足下列其一为 registry
  // （域名大小写不敏感 → 允许大写）；否则该段是 namespace（须小写，由 repoPath 覆盖）：
  //   ① 含 `.`（多标签域名）  ② **含 `:`（单标签 + 端口，如 registry:5000）**  ③ `localhost`
  // 少了 ② 会误拒 `registry:5000/fde`（评审 B 实测的 false-reject 回归）；少了 ③/① 的区分则
  // 会把 `FOO/bar` 当 host 放行（docker 视为 namespace 须小写）。
  const repoHostLabel = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
  const repoHostDotted = `${repoHostLabel}(?:\\.${repoHostLabel})+`;
  // ⚠️ 整体分组必不可少（评审 B 第四轮实测）：缺外层 `(?:…)` 时 `^(?:HOST/)?` 里的 `/` 只绑定
  // 最后一个交替分支，`dotted|localhost` 分支不再要求 `/` → `registry.example.com:5000x/fde` 被
  // 拆成「port :5000」+「path x/fde」误放行。
  const repoHost = `(?:(?:${repoHostDotted}|localhost)(?::[0-9]+)?|${repoHostLabel}:[0-9]+)`;
  // 边界声明：本校验是**形态门**（三类前缀 + 严格 sha256 后缀），不声称 docker reference 语法完备。
  // 已知边界（fail-open，Docker 兜底）：`foo__bar.example.com/fde` 这类「首段含 `.` 但域名含非法
  // 字符」我们会放行而 docker 会拒（#34 follow-up）。要完全对齐需引入域名语法校验，收益不抵复杂度。
  const repoTag = '[A-Za-z0-9_][A-Za-z0-9._-]{0,127}';
  const repoDigestRef = new RegExp(`^(?:${repoHost}/)?${repoPath}(?::${repoTag})?@sha256:[0-9a-f]{64}$`);
  const imageIsDigest = imageIdRef.test(fdeImage) || repoDigestRef.test(fdeImage);
  if (!imageIsDigest && !fdeDevMode) {
    throw new Error('FDE_IMAGE 必须为 image@sha256:<digest> 或 sha256:<imageId> 形态（生产模式；或显式 FDE_DEV_MODE=1 进入开发模式）');
  }
  if (!imageIsDigest && fdeDevMode) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ⚠️ dev 偏差：FDE_IMAGE=${fdeImage} 非不可变引用；生产 pin 两形态之一：image@sha256:… 或 sha256:<imageId>（issue #27）`);
  }

  // F14：生产模式缺失/占位 SESSION_SIGNING_KEY 时 fail-closed（拒绝启动）；dev 保持现状 + 警告。
  const signingKeyRaw = env.SESSION_SIGNING_KEY;
  const signingKeyIsPlaceholder =
    !signingKeyRaw || signingKeyRaw === 'erix-station-dev-signing-key-change-me';
  if (signingKeyIsPlaceholder && !fdeDevMode) {
    throw new Error('SESSION_SIGNING_KEY 必须显式注入强随机值（生产模式拒绝启动）');
  }
  if (signingKeyIsPlaceholder && fdeDevMode) {
    // eslint-disable-next-line no-console
    console.warn('[config] ⚠️ SESSION_SIGNING_KEY 使用 dev 占位值，生产必须改为强随机值');
  }

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
    // ---- WP2a：用户空间物化 + 路由 reconciler 配置 ----
    // 用户空间根（portal 容器内路径，= 宿主 bind mount 目标；user-space §2.2 / env §6）。
    userSpaceRoot: env.ERIX_USERSPACE_ROOT || '/srv/erix/users',
    // F3：bind source 用的**宿主**路径（Docker API bind source 必须是宿主路径，与容器内 userSpaceRoot 解耦）。
    userSpaceRootHost: env.ERIX_USERSPACE_ROOT_HOST || env.ERIX_USERSPACE_ROOT || '/srv/erix/users',
    // FDE 工作区属主 UID/GID（user-space §6.1：1000/1000）。
    fdeUid: intEnv(env, 'FDE_USER_UID', 1000),
    fdeGid: intEnv(env, 'FDE_USER_GID', 1000),
    // Traefik 动态配置目录（portal 容器内路径，reconciler 写 file provider；deploy-contract §4.2）。
    traefikDynamicDir: env.TRAEFIK_DYNAMIC_DIR || '/etc/traefik/dynamic',
    traefikDynamicFile: env.TRAEFIK_DYNAMIC_FILE || 'routes.yml',
    // issue #38 Phase B1：LLM 段（含上游 api_key 明文）独立文件，mode 600（routes.js rebuildRoutes 写入）。
    traefikLlmDynamicFile: env.TRAEFIK_LLM_DYNAMIC_FILE || 'llm-routes.yml',
    // portal 域名与后端（reconciler 生成 portal 路由与 forwardAuth 地址用）。
    portalHost: env.PORTAL_HOST || `station.${env.BASE_DOMAIN || 'localhost'}`,
    portalBackendUrl: env.PORTAL_BACKEND_URL || 'http://127.0.0.1:8080',
    traefikEntryPoint: env.TRAEFIK_ENTRYPOINT || 'web',
    llmHost: env.LLM_HOST || `llm.${env.BASE_DOMAIN || 'localhost'}`,
    // ---- 容器经 Traefik 访问 portal/LLM 的公共入口 base URL（scheme://host[:port]）----
    // dev：web entrypoint http + 高端口；prod：websecure entrypoint https + 443（隐式）。
    // 由 ERIX_STATION_BASE_URL（agentd）与 config.json endpoint（worker provider）使用。
    portalPublicBaseUrl: resolvePublicBaseUrl(env, 'PORTAL_PUBLIC_BASE_URL', env.PORTAL_HOST || `station.${env.BASE_DOMAIN || 'localhost'}`),
    llmPublicBaseUrl: resolvePublicBaseUrl(env, 'LLM_PUBLIC_BASE_URL', env.LLM_HOST || `llm.${env.BASE_DOMAIN || 'localhost'}`),
    // LLM 网关数据面回环地址。issue #38 Phase B1 起 LLM 路由直连 llm_providers.base_url
    // （不再经 llm-hub），本键暂保留兼容（外部脚本/文档引用），routes.js 已不再消费。
    llmGatewayUrl: env.LLM_GATEWAY_HOST || 'http://127.0.0.1:4000',
    // 端口配额 / 默认池 / 保留网段（IPAM；fde-platform §8.2 / topology §3）。
    portQuota: intEnv(env, 'PORT_QUOTA', 40),
    fdePool: env.FDE_POOL || 'default',
    // F9：栈所有权标签——reconcile 只清本栈（station.stack=<stackId>）的孤儿容器/网络，
    // 防并行栈互删；缺省 default（既有无 station.stack 标签的资产视为 default 栈）。
    stackId: env.STATION_STACK_ID || 'default',
    reservedSubnets: (env.IPAM_RESERVED_SUBNETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // ---- WP2b：FDE provisioning + preview ticket ----
    // FDE 容器镜像/命令（开发期 traefik/whoami 站台；生产自构建 runner 镜像，env §10/deploy-contract §6.2）。
    fdeImage,
    fdeDevMode,
    // F5：开发期 whoami 等镜像不满足「root 启动→drop 1001」契约时的 --user 兜底（⚠️ dev 偏差）；生产留空由镜像 entrypoint 降权。
    fdeDevUser: env.FDE_DEV_USER || null,
    fdeCmd: parseJsonStringArray(env.FDE_CMD, ['-port', '4000']),
    fdeAgentVersion: env.FDE_AGENT_VERSION || 'dev',
    // 资源限额（deploy-contract §6.2；issue #27 已决 2026-09-18）：默认 4g（B 档镜像下 dotnet build/chromium 峰值），可配 0 表示不限。
    fdeMemoryLimit: env.FDE_MEMORY_LIMIT || '4g',
    // 容器内双 UID（runner-integration/user-space §6.1：agentd 1001 / worker 1002，GID 1000）。
    agentdUid: intEnv(env, 'FDE_AGENTD_UID', 1001),
    workerUid: intEnv(env, 'FDE_WORKER_UID', 1002),
    // portal 经自研 admission proxy 访问 Docker API（deploy-contract §5；不直挂 docker.sock）。
    dockerHost: env.DOCKER_HOST || 'tcp://station-docker-proxy:2375',
    // 预览 ticket/session（portal.md §2.8）。
    previewTicketTtlSeconds: intEnv(env, 'PREVIEW_TICKET_TTL_SECONDS', 60),
    previewSessionTtlSeconds: intEnv(env, 'PREVIEW_SESSION_TTL_SECONDS', 15 * 60),
    previewCookie: previewCookieSettings(cookieProfile, intEnv(env, 'PREVIEW_SESSION_TTL_SECONDS', 15 * 60)),
    // 预览 session 派生密钥（HMAC-SHA256，portal.md §2.7 第 6 步）；生产必须显式注入，开发期仅联调占位。
    previewSessionSigningKey: signingKeyRaw || 'erix-station-dev-signing-key-change-me',
    // 预览 ticket 签发限流（portal.md §6.1：按用户 + IP）。
    previewTicketRateLimit: {
      maxFailures: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_MAX', 20),
      windowMs: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_WINDOW_MS', 60 * 1000),
      blockMs: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_BLOCK_MS', 60 * 1000),
      maxEntries: intEnv(env, 'RATE_LIMIT_MAX_ENTRIES', 10000),
    },
  };
}

/** 解析 JSON 字符串数组（如 FDE_CMD='["-port","4000"]'）；非法输入回退到 fallback。 */
function parseJsonStringArray(raw, fallback) {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v;
  } catch {
    // fallthrough
  }
  return fallback;
}

/**
 * 容器经 Traefik 访问 portal/LLM 的公共入口 base URL（scheme://host[:port]）。
 * 优先显式 env；否则按 entrypoint 推导：dev（web）http + TRAEFIK_WEB_PORT，prod（websecure）https + 443。
 */
function resolvePublicBaseUrl(env, key, host) {
  if (env[key] && String(env[key]).trim()) return String(env[key]).trim().replace(/\/+$/, '');
  const entrypoint = env.TRAEFIK_ENTRYPOINT || 'web';
  const webPort = Number(env.TRAEFIK_WEB_PORT || 8090);
  const websecurePort = Number(env.TRAEFIK_WEBSECURE_PORT || 8443);
  const scheme = entrypoint === 'websecure' ? 'https' : 'http';
  const port = entrypoint === 'websecure'
    ? (websecurePort === 443 ? '' : `:${websecurePort}`)
    : `:${webPort}`;
  return `${scheme}://${host}${port}`;
}
