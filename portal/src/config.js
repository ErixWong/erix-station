// 配置读取：从环境变量读入，含开发/生产差异。
// 依据：docs/env.md §0/§10、docs/api/portal.md §2.5（cookie 语义）。
// COOKIE_PROFILE=dev-http 仅限本机 HTTP 联调，禁止进入部署配置。

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateHostnameGrammar } from './projects.js';
import { parseCidr } from './ipam.js';

const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 天，portal.md §2.5

function intEnv(env, key, fallback) {
  const v = Number(env[key] ?? fallback);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nonNegativeIntEnv(env, key, fallback) {
  const v = Number(env[key] ?? fallback);
  return Number.isSafeInteger(v) && v >= 0 ? v : fallback;
}

/**
 * 「这个大小类 env 旋钮当前生效的值是从哪来的」（issue #485 片 A 立的那格）。
 * 返回 `'env'` 仅当：env 里**显式写了**这个键、非空串、且它能过 `intEnv` 的采纳条件（有限正数）。
 * 否则 `'default'`。为什么不能只看「键在不在」：`intEnv` 对 `0` / `'abc'` 会回落 fallback，
 * 那时告诉运维「现在是 env 的值」就是指着一个不生效的数。下面的谓词与 `intEnv` 逐字同形（两处必须同口径）。
 *
 * 名字里没有 `Upload` 是因为它现在服务**两个**旋钮：`FILE_UPLOAD_MAX_BYTES`（#485）与
 * `SESSION_TTL_SECONDS`（#677 P2a，管理台 `GET /api/admin/runtime-settings` 要能说「这一档从哪来」）。
 * 新旋钮要报真实来源就接这里，**不要**拿「值等不等于默认值」当判据。
 */
function envValueSource(env, key) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return 'default';
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? 'env' : 'default';
}

/** TCP 端口 env：正整且 ≤65535，否则回退 fallback 并 warn（一个错拼的端口不许把 portal 拦在启动外）。 */
function portEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const v = Number(raw);
  if (Number.isInteger(v) && v > 0 && v <= 65535) return v;
  // eslint-disable-next-line no-console
  console.warn(`[config] ⚠️ ${key}=${JSON.stringify(raw)} 不是合法 TCP 端口，回退默认 ${fallback}`);
  return fallback;
}

/**
 * 管理台 host（issue #450 D1）：显式 `ADMIN_PUBLIC_HOST` 优先，否则 `admin.<baseDomain>`（伞域泛解析已覆盖）。
 * 形状判据复用 hostname 族里已有的 `validateHostnameGrammar`（逐标签 ≤63 + DNS 字符集 + 总长 ≤253），
 * **不新写正则、不新增错误码**；非法形态退回默认值并 warn——一个错拼的 host 只应该降级，不应该把
 * portal 拦在启动之外（与 FDE_IMAGE/SESSION_SIGNING_KEY 那种 fail-closed 项不同：那两项错的是安全面，
 * 这一项错的是「管理台打不开」，而退回默认恰好是安全的那一侧）。
 */
function resolveAdminHost(env, baseDomain) {
  const fallback = `admin.${baseDomain}`;
  const raw = String(env.ADMIN_PUBLIC_HOST ?? '').trim();
  if (!raw) return fallback;
  const grammar = validateHostnameGrammar(raw);
  if (grammar.ok) return raw;
  // eslint-disable-next-line no-console
  console.warn(`[config] ⚠️ ADMIN_PUBLIC_HOST=${JSON.stringify(raw)} 非法（${grammar.reason}），回退默认 ${fallback}`);
  return fallback;
}

/**
 * 管理台入口来源白名单（issue #450 D4）：`ADMIN_IP_ALLOWLIST` 逗号分隔 CIDR → 数组。
 * **空数组 = 不挂 ipAllowList = 放行全部**（= 今天的现状，默认不破坏现网）。
 * 单个条目非法就丢掉该条并 warn（不是整串作废）；若因此变成空数组，则额外 warn 一次
 * 「入口将不受来源限制」——这一条必须响，因为它的安全含义是「谁能进管理台」。
 */
function resolveAdminIpAllowlist(env) {
  const raw = String(env.ADMIN_IP_ALLOWLIST ?? '').trim();
  if (!raw) return [];
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const valid = [];
  for (const entry of entries) {
    try {
      parseCidr(entry);
      valid.push(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[config] ⚠️ ADMIN_IP_ALLOWLIST 条目 ${JSON.stringify(entry)} 非法（${err.message}），已丢弃`);
    }
  }
  if (valid.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[config] ⚠️ ADMIN_IP_ALLOWLIST 全部条目非法 ⇒ 管理台入口**不挂 ipAllowList**（对任何来源放行）');
  }
  return valid;
}

/**
 * 管理台对外 URL（issue #450）：`https://<adminHost>[:<port>]`，**443 时不带端口**——
 * 与 `resolvePublicBaseUrl` 的 websecure 分支同口径（默认端口不进 URL），不另造一套拼法。
 */
function resolveAdminPublicBaseUrl(adminHost, adminPort) {
  return `https://${adminHost}${adminPort === 443 ? '' : `:${adminPort}`}`;
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
  // 邮件通道（issue #449，决策者 2026-11-04 改口径）：**SMTP 参数存 DB**（`mail_settings` 单行，
  // 管理台维护，读取侧 `portal/src/mail-provider.js`），env 只留一个旋钮：
  //   `MAIL_TRANSPORT=disabled` —— 运维急停：为真时无论 DB 怎么配都不发信（决策 D3b 的硬闸）。
  // 口令以**明文**落库（`smtp_password`）：目标是内网 email relay，口令非高价值，与既有
  // `git_hosts.admin_key`（迁移 0011）同一口径；将来换成公网 SMTP 再上加密列。
  const mailKillSwitch = String(env.MAIL_TRANSPORT ?? '').trim().toLowerCase() === 'disabled';
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

  // ---- issue #450 / feat-261105-01：管理台独立入口（独立 host admin.<伞域> + 端口 + TLS）----
  // 端口唯一真值 = 部署面 env（compose 从 deploy/.env 注入）；Traefik 侧 listen 端口写在静态文件里
  //（`${VAR}` 在 `--configFile` 下不插值，实测），两处一致性由 deploy-env-defaults 测试钉住。
  const baseDomain = env.BASE_DOMAIN || 'localhost';
  const adminHost = resolveAdminHost(env, baseDomain);
  const adminPort = portEnv(env, 'TRAEFIK_ADMIN_PORT', 9443);

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
    cookie: cookieSettings(cookieProfile, sessionTtlSeconds),
    sessionTtlSeconds,
    // #677 P2a：上面那个值的**来源**（`source: db | env | default` 里后两档的唯一区分手段）。
    // 判据与 `fileUploadMaxBytesSource` 逐字同形：看「env 里有没有显式写这个键并且能被 `intEnv` 采纳」，
    // 不是看它等不等于默认值。**为什么非要有这一格**：`sessionTtlSeconds` 永远有值（没给就是默认 7 天），
    // 所「它在不在 config 里」区分不出 env 与默认 ⇒ 管理台会把「压根没配」报成「env 配的」。
    // ⚠ `config.cookie.maxAge` 仍是这里算出的副本：`runtime_settings` 改了它不会动，
    //   所以签 cookie 的地方必须用刚读到的生效 TTL 覆盖 `maxAge`（口径见 `http.js` 的四处登录/续期点）。
    sessionTtlSecondsSource: envValueSource(env, 'SESSION_TTL_SECONDS'),
    // 两步登录（portal.md §2.2）：待决令牌短期、单次消费
    pendingTokenTtlSeconds: intEnv(env, 'PENDING_TOKEN_TTL_SECONDS', 120),
    // 邮件通道（issue #449，portal.md §2.3a/§2.3b + env.md「邮件通道（MAIL_*）」）。
    // 未配置（默认 `disabled`）时第二因素不生效：未注册 TOTP 的账号退回纯口令，并在启动时打一条 warn。
    // 邮件通道（issue #449）：**SMTP 主机/端口/凭据/发件人都在 DB**（`mail_settings`，管理台维护，
    // 见 `portal/src/mail-provider.js`）。env 只剩一个旋钮——急停开关。
    mail: {
      killSwitch: mailKillSwitch,
    },
    // 登录邮箱验证码（issue #449 决策 6）：6 位 / TTL 600s / 单 pending 5 次尝试 / 重发冷却 60s / 最多 3 次重发。
    loginEmailCode: {
      ttlSeconds: intEnv(env, 'EMAIL_CODE_TTL_SECONDS', 600),
      maxAttempts: intEnv(env, 'EMAIL_CODE_MAX_ATTEMPTS', 5),
      resendCooldownSeconds: nonNegativeIntEnv(env, 'EMAIL_CODE_RESEND_COOLDOWN_SECONDS', 60),
      maxResends: nonNegativeIntEnv(env, 'EMAIL_CODE_MAX_RESENDS', 3),
    },
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
    // 字段上限（S3：防止超大字段触发 scrypt 或打爆内存）。JSON 请求体上限原由一个 env（默认 64 KiB）
    // 提供，issue #677 已删——它从未接进 compose ⇒ 生产设了也不生效，是个假旋钮；值改由 `http.js` 的
    // 模块常量 `DEFAULT_JSON_BODY_LIMIT`（仍 64 KiB）承载。
    // issue #472 片 B：单文件上传上限。**与 JSON 请求体上限是两个东西**：后者是 JSON 请求体（默认 64 KiB，
    // 上传走它则任何真文件都 413），本值由 `receiveUpload` 在流式写入里逐 chunk 兜。
    // ⚠ 它是**单文件**上限、**不是并发上限**：32MiB × N 个并发上传不会进内存（流式），但会同时占磁盘写
    // 与带宽；真正的总量闸门是配额（#472 R6：本版不做，见 docs/env.md）。
    // ⚠ compose 的 portal service 用显式 environment 列表、**没有 env_file** ⇒ 运维改 .env 要这里也列一行才生效。
    // issue #485 片 A：本值从「唯一真相」降级成**兜底值** —— 真相在 `upload_settings` 单行表（迁移 0035），
    //   每次上传现读，优先级 `DB > env > 默认`（`portal/src/upload-settings.js`）。env 保留的意义是
    //   「不碰数据库也能压住上限」的运维急停，以及 DB 读失败时不至于没有上限（不是没上限）。
    fileUploadMaxBytes: intEnv(env, 'FILE_UPLOAD_MAX_BYTES', 32 * 1024 * 1024),
    // 上面那个值的**来源**（管理台要显示「当前生效值从哪来」）。判据是「env 里有没有显式写这个键」，
    // 不是「它是否等于 fileUploadMaxBytes」：`FILE_UPLOAD_MAX_BYTES=0` 这种**给了但非法**的值会被
    // `intEnv` 回落成默认值，此时来源必须报 `default`（报 `env` 就是在指着一个根本不生效的值）。
    fileUploadMaxBytesSource: envValueSource(env, 'FILE_UPLOAD_MAX_BYTES'),
    // issue #64 R1：run 终态产物（worktree bundle tar.gz）存储与上限。
    // 持久卷 bind mount（deploy-contract §2.2 ④）；上限默认 20MB，与 agentd 侧截断口径一致。
    artifactsRoot: env.ERIX_ARTIFACTS_ROOT || '/srv/erix/artifacts',
    artifactMaxBytes: intEnv(env, 'ERIX_ARTIFACT_MAX_BYTES', 100 * 1024 * 1024), // 2026-09-24 20MB→100MB（与 runner 侧同 env 同默认）
    // issue #88：会话标题自动生成开关。issue #114 修订：**默认关**——run 终态不再自动起名
    // （默认标题改由「首条用户消息截断」+ 手工改名 + 「AI 改名」按钮承担，省 token）；
    // env 显式设 ERIX_SESSION_AUTO_TITLE=1 可开回 #88 行为（代码路径保留不删）。
    // minNew = 防抖阈值：距上次自动更新至少 N 轮新用户消息才刷新（或话题漂移启发式命中）。
    sessionAutoTitle: env.ERIX_SESSION_AUTO_TITLE === '1',
    sessionAutoTitleMinNew: intEnv(env, 'ERIX_SESSION_AUTO_TITLE_MIN_NEW', 3),
    maxLoginLength: intEnv(env, 'MAX_LOGIN_LENGTH', 128),
    maxPasswordLength: intEnv(env, 'MAX_PASSWORD_LENGTH', 256),
    baseDomain,
    migrateOnStart: env.MIGRATE_ON_START !== '0',
    staticDir: env.STATIC_DIR || defaultStaticDir(),
    // ---- WP2a：用户空间物化 + 路由 reconciler 配置 ----
    // 用户空间根（portal 容器内路径，= 宿主 bind mount 目标；user-space §2.2 / env §6）。
    userSpaceRoot: env.ERIX_USERSPACE_ROOT || '/srv/erix/users',
    // F3：bind source 用的**宿主**路径（Docker API bind source 必须是宿主路径，与容器内 userSpaceRoot 解耦）。
    userSpaceRootHost: env.ERIX_USERSPACE_ROOT_HOST || env.ERIX_USERSPACE_ROOT || '/srv/erix/users',
    // issue #676（丙=止血）：M9「完成审查」总开关。**缺省 'disabled'** ⇒ 只出事实、不下判决
    //（run-review 分派落 skipped/review_unavailable、不建快照、verdict NULL）。
    // 甲/乙 见 #673，拍板后改 `'snapshot'`（修快照）/ `'live-fingerprint'`（读活目录+前后指纹）。
    reviewMode: env.ERIX_REVIEW_MODE || 'disabled',
    // Workspace 自动清理默认关闭；显式正数才会设置 purge deadline 并启用目录 sweep。
    workspaceRetentionDays: nonNegativeIntEnv(env, 'ERIX_WORKSPACE_RETENTION_DAYS', 0),
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
    portalInternalHosts: (env.PORTAL_INTERNAL_HOSTS || '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    portalBackendUrl: env.PORTAL_BACKEND_URL || 'http://127.0.0.1:8080',
    traefikEntryPoint: env.TRAEFIK_ENTRYPOINT || 'web',
    // 2026-11-06：用户面 HTTPS 入口。**缺省空 = 不挂**（老部署 routes.yml 字节不变）；
    // 设成 `websecure` 就同时给 `portal` 与预览 host 加该入口 + `tls: {}`（证书是 file provider 装载的
    // `certs/tls.{crt,key}`，那张 `*.fde.erix.vip` 已覆盖两个 host）。`internal` 与 LLM 路由不加。
    traefikSecureEntryPoint: env.TRAEFIK_SECURE_ENTRYPOINT || '',
    // issue #450 D2：管理台入口（静态配置里的 entrypoint 名）。管理台路由挂它，用户入口挂 deny。
    traefikAdminEntryPoint: env.TRAEFIK_ADMIN_ENTRYPOINT || 'adminsecure',
    // issue #450 D1/D4：管理台 host / 端口 / 来源白名单 / 对外 URL。
    // adminIpAllowlist 为空数组 ⇒ 路由生成器**根本不输出** ipAllowList 中间件（不是输出一个空 sourceRange：
    // 实测 Traefik 对空 sourceRange 直接拒建中间件并打 ERR `sourceRange is empty, IPAllowLister not created`）。
    adminHost,
    adminPort,
    adminIpAllowlist: resolveAdminIpAllowlist(env),
    adminPublicBaseUrl: resolveAdminPublicBaseUrl(adminHost, adminPort),
    llmHost: env.LLM_HOST || `llm.${env.BASE_DOMAIN || 'localhost'}`,
    // ---- 容器经 Traefik 访问 portal/LLM 的公共入口 base URL（scheme://host[:port]）----
    // dev：web entrypoint http + 高端口；prod：websecure entrypoint https + 443（隐式）。
    // 由 ERIX_STATION_BASE_URL（agentd）与 config.json endpoint（worker provider）使用。
    portalPublicBaseUrl: resolvePublicBaseUrl(env, 'PORTAL_PUBLIC_BASE_URL', env.PORTAL_HOST || `station.${env.BASE_DOMAIN || 'localhost'}`),
    llmPublicBaseUrl: resolvePublicBaseUrl(env, 'LLM_PUBLIC_BASE_URL', env.LLM_HOST || `llm.${env.BASE_DOMAIN || 'localhost'}`),
    // Traefik 在 host 网络；LiteLLM 迁移期通过宿主回环 4100 暴露数据面。
    llmGatewayUrl: env.LLM_GATEWAY_HOST || 'http://127.0.0.1:4100',
    llmGatewayAdminUrl: env.LLM_GATEWAY_ADMIN_URL || 'http://station-litellm:4000',
    llmGatewayMasterKey: env.LLM_GATEWAY_MASTER_KEY || '',
    // 默认池 / 保留网段（IPAM；fde-platform §8.2 / topology §3）。
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
    workerUid: intEnv(env, 'FDE_WORKER_UID', 1002),
    // portal 经自研 admission proxy 访问 Docker API（deploy-contract §5；不直挂 docker.sock）。
    dockerHost: env.DOCKER_HOST || 'tcp://station-docker-proxy:2375',
    // 预览 ticket/session（portal.md §2.8）。
    previewTicketTtlSeconds: intEnv(env, 'PREVIEW_TICKET_TTL_SECONDS', 60),
    previewSessionTtlSeconds: intEnv(env, 'PREVIEW_SESSION_TTL_SECONDS', 15 * 60),
    previewCookie: previewCookieSettings(cookieProfile, intEnv(env, 'PREVIEW_SESSION_TTL_SECONDS', 15 * 60)),
    // 预览 session 派生密钥（HMAC-SHA256，portal.md §2.7 第 6 步）；生产必须显式注入，开发期仅联调占位。
    previewSessionSigningKey: signingKeyRaw || 'erix-station-dev-signing-key-change-me',
    // #366 P2：kkFileView 反代上游（docker 内网名；compose 不发宿主端口，只有 portal 能触达）。
    // 置空串 = 未部署 kk：/api/preview-tickets 照常签码，但 /pv 转发时 connect refused → 502（可观测可降级）。
    kkInternalBaseUrl: env.KK_INTERNAL_BASE_URL ?? 'http://kkfileview:8012',
    // 预览 ticket 签发限流（portal.md §6.1：按用户 + IP）。
    previewTicketRateLimit: {
      maxFailures: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_MAX', 20),
      windowMs: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_WINDOW_MS', 60 * 1000),
      blockMs: intEnv(env, 'PREVIEW_TICKET_RATE_LIMIT_BLOCK_MS', 60 * 1000),
      maxEntries: intEnv(env, 'RATE_LIMIT_MAX_ENTRIES', 10000),
    },
    // issue #650：宿主资源监控（采样器只在 `cli.js serve` 启动，`createServer` 不启动它）。
    systemMetrics: systemMetricsSettings(env),
  };
}

/**
 * 布尔开关 env：**只认 `0` / `1`**（issue #650 的 `SYSTEM_METRICS_ENABLED` 口径）。
 *
 * 为什么不像 `MIGRATE_ON_START !== '0'` 那样「除 0 外都算开」：那种写法把 `false` / `no` / 拼错的
 * `0 ` 当成「开」，而应急刹车恰恰是「运维以为关了、实际没关」最坑的一种失败（写库出问题时的唯一
 * 手段就是一条 env）。现在：`0`⇒false、`1`⇒true、未设/空串⇒默认，**其余值 warn 后按默认**
 * （说了话但说错了 ⇒ 必须出声；静默采纳其中一侧都是猜）。
 */
function strictBoolEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim();
  if (s === '0') return false;
  if (s === '1') return true;
  // eslint-disable-next-line no-console
  console.warn(`[config] ⚠️ ${key}=${JSON.stringify(raw)} 不是 0/1，按默认 ${fallback ? 1 : 0} 处理`
    + '（这一项是应急开关，不许拿拼写错误当开/关）');
  return fallback;
}

/**
 * 带范围的整数 env：合法且在 `[min,max]` 内才采纳，否则**回落默认 + warn**（issue #650）。
 *
 * 为什么是「回落默认」而不是「夹到边界」：越界值几乎总是手误（`SYSTEM_METRICS_INTERVAL_SECONDS=3` 想写
 * `30`），默默夹成 5 会让写入频率与运维的意图差 6 倍而没人知道；回落默认 + 一条 warn 至少把错摆在日志里。
 */
function clampedIntEnv(env, key, fallback, min, max) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const v = Number(String(raw).trim());
  if (Number.isSafeInteger(v) && v >= min && v <= max) return v;
  // eslint-disable-next-line no-console
  console.warn(`[config] ⚠️ ${key}=${JSON.stringify(raw)} 不是 ${min}–${max} 的整数，回退默认 ${fallback}`);
  return fallback;
}

/**
 * 逗号分隔路径列表（`SYSTEM_METRICS_DISK_PATHS`）：trim → 去空 → 去重，全空 ⇒ 回落 `[fallback]`。
 * 去重的理由：同一个路径写两遍在写侧会被 `diskRows` 按设备合并成一行，但那是**巧合而不是语义**；
 * 在配置面就重掉，面板上「已监控 N 个文件系统」的 N 才与 env 里写的条数对得上。
 */
function csvListEnv(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return [fallback];
  const seen = [];
  for (const part of String(raw).split(',')) {
    const item = part.trim();
    if (item && !seen.includes(item)) seen.push(item);
  }
  return seen.length > 0 ? seen : [fallback];
}

/**
 * 宿主资源监控的四个旋钮（issue #650，全部走 env，不上 DB 单行表）。
 *
 * 为何不走 `upload_settings` 那种「DB 优先 env」：这四项都是「装好就不动」的运维参数，而 e2e 栈
 * 必须能在**初始化前**用 env 关掉（DB 层做不到：栈起来时 DB 里还没有配置行）。将来要在线改是
 * additive 的第二步，不影响本单表结构（口径见 `docs/ops/system-metrics.md`）。
 */
function systemMetricsSettings(env) {
  return {
    // 应急刹车：写库出问题（DB 快满 / 写放大 / 磁盘 IO 飙）时一条 env 停掉，不用改代码发版；
    // 手工复测空闲负载（`docs/ops/db-idle-load.md`）时先关掉拿干净基线。
    enabled: strictBoolEnv(env, 'SYSTEM_METRICS_ENABLED', true),
    // 写入成本与曲线粒度的唯一旋钮（5s 是最小可用粒度：低于它写放大开始咬人；300s 是曲线已不够看）。
    intervalSeconds: clampedIntEnv(env, 'SYSTEM_METRICS_INTERVAL_SECONDS', 30, 5, 300),
    retentionDays: clampedIntEnv(env, 'SYSTEM_METRICS_RETENTION_DAYS', 30, 1, 365),
    // 容器看不见宿主挂载表 ⇒ 这里写的必须是**portal 容器内存在**的路径（加盘 = compose 一行 + env 一行）。
    diskPaths: csvListEnv(env, 'SYSTEM_METRICS_DISK_PATHS', '/'),
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
