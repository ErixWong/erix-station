#!/usr/bin/env node
// CLI 入口：serve / migrate / bootstrap-admin / healthcheck。
import { parseArgs } from 'node:util';
import crypto from 'node:crypto';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import * as auth from './auth.js';
import * as totp from './totp.js';
import { createServer } from './http.js';
import { startMaterializerLoop } from './materializer.js';
import { startOnboardingLoop } from './onboarding.js';
import { startOffboardingLoop } from './offboarding.js';
import { startRoutesLoop } from './routes.js';
import { startRouteDriftMonitor } from './routesdrift.js';
import { startMacroEvalLoop } from './macro-eval.js';
// issue #616：意图消费者（dispatcher）与超时回收 loop——评估循环只产意图，执行/收尾在这里接线。
import { createIntentDispatcher, startPendingSweepLoop } from './macro-dispatcher.js';
import { startReaperLoop, notifySessionEvents } from './internal.js';
// issue #650：宿主资源采样器。**只在 `serve` 里启动**（`createServer` 不启动它）——否则每一个
// 拿 `createServer` 的单测都会被一个 unref 定时器拖住（拍里还会读真实 `/proc` 与 DB）。
import { startMetricsSampler } from './system-metrics.js';
import { gracefulShutdown, SHUTDOWN_LOOPS_MS_DEFAULT } from './shutdown.js';
import {
  createDockerClient,
  onboardFde,
  deprovisionFde,
  reconcileOnce,
  startProvisionerLoop,
} from './provisioner.js';
import { migrateLegacyCredential } from './git-credential.js';
// issue #643 B：本地构建自曝（`revision=unknown` ⇒ 启动日志里一条 `local-build`）。
import { warnIfLocalBuild } from './version-info.js';
// issue #677 P1：运行时配置覆盖层（`runtime_settings`，DB > env > 默认）。**只在 `serve` 用**——
// 其它子命令不服务请求，接了只是给 `migrate` 那类一次性进程多一次无谓的 DB 往返。
import { applyRuntimeOverrides } from './runtime-settings.js';

function usage() {
  // eslint-disable-next-line no-console
  console.error(
    'usage:\n' +
      '  cli.js serve\n' +
      '  cli.js migrate\n' +
      '  cli.js bootstrap-admin --login <name> [--password <pw>] [--display-name <name>] [--allow-extra] [--print-secret]\n' +
      '  cli.js provision-fde --fde-name <name>\n' +
      '  cli.js deprovision-fde --fde-name <name>\n' +
      '  cli.js migrate-git-credentials [--fde-name <name>]\n' +
      '  cli.js healthcheck',
  );
}

const SHUTDOWN_WAIT_MS = SHUTDOWN_LOOPS_MS_DEFAULT; // 等循环收尾的上限（只管循环那一段）
// **整个关闭流程**的总上限（#506 复审①）：compose / k8s 默认只给 10s 宽限期，超了就是 SIGKILL。
// 8s = 循环收尾 5s + server 关闭 3s，另留 ~2s 给 process.exit 与调度器。见 ./shutdown.js 的 gracefulShutdown。
const SHUTDOWN_TOTAL_MS = 8000;

async function serve() {
  const config = loadConfig();
  // issue #643 B：**本地 scratch 构建自曝**，位置在 `loadConfig()` 之后、`migrate()` 之前。
  // 为什么要在 migrate 之前：读版本不碰 DB（它只读镜像里的 `/app/build-info.json`），而 `migrate()`
  // 失败会直接 `process.exit(1)`、DB 起不来时还要看 compose 的 `service_healthy` 门槛——自曝挂在它后面
  // 就等于「只有 DB 好了才有机会说自己是本地构建」，而一个 crash-loop 的容器恰恰最需要这一句。
  // 它自己也不抛（观测面不承重，#515 同口径），放这儿不会把启动路径弄挂。
  // eslint-disable-next-line no-console
  warnIfLocalBuild({ log: console });
  const pool = createPool(config.databaseUrl);
  if (config.migrateOnStart) {
    const migratePool = createPool(config.migrateDatabaseUrl);
    const bootstrapPool = createPool(config.bootstrapDatabaseUrl);
    try {
      const summary = await migrate(migratePool, {
        bootstrapPool,
        // issue #280：平台库角色点名口径（config.js 的 migrateDatabaseUrl 是同一份配置）。
        migrateDatabaseUrl: config.migrateDatabaseUrl,
      });
      // eslint-disable-next-line no-console
      console.log('[migrate] ok', summary);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[migrate] failed:', err.message);
      await Promise.all([pool.end(), migratePool.end(), bootstrapPool.end()].map((p) => p.catch(() => {})));
      process.exit(1);
    }
    await migratePool.end().catch(() => {});
    await bootstrapPool.end().catch(() => {});
  }
  // issue #677 P1：**运行时配置覆盖层**（DB > env > 默认，见 ./runtime-settings.js 的六条硬口径）。
  // 位置刻意在 `migrate()` **之后**、`createServer()` **之前**：表（迁移 0046）必须先存在，
  // 否则每次启动都白走一次「读不到 ⇒ 回落」；而 HTTP 与下面**每一个循环**都必须拿到同一份
  // 被覆盖过的 config——只改 `createServer` 那一处的话，覆盖层就只对 HTTP 生效，
  // reconciler 还在用 env 那份旧值（这正是 P3 逐批迁旋钮时会踩的坑，所以本轮一次接完）。
  // ⚠ `applyRuntimeOverrides` 自己**永不抛**（读侧口径），所以它不会把启动路径弄挂。
  const effectiveConfig = await applyRuntimeOverrides(config, { pool, log: console });
  const server = createServer({ pool, config: effectiveConfig });
  // 启动物化、开户、路由与容器对账循环；开户与 reconcile 独立避免慢 provision 阻塞对账。
  const materializerLoop = startMaterializerLoop(pool, effectiveConfig);
  const onboardingLoop = startOnboardingLoop(pool, effectiveConfig);
  const offboardingLoop = startOffboardingLoop(pool, effectiveConfig);
  const routesLoop = startRoutesLoop(pool, effectiveConfig);
  // issue #474 S3 一期：动态文件漂移**只读**对账（60s + 启动一次；只 warn + 审计，绝不写盘）。
  const driftMonitor = startRouteDriftMonitor(pool, effectiveConfig);
  // issue #525 W2：宏平台评估循环（只产触发意图，不执行；水位线逐条推进；60s + 启动一次）。
  // issue #616：评估器产出的意图由 dispatcher **消费**（onIntents 接线），否则三条主功能全断且留永久 pending 行。
  const intentDispatcher = createIntentDispatcher({ pool, config: effectiveConfig });
  const macroEvalLoop = startMacroEvalLoop(pool, effectiveConfig, { onIntents: (intents) => intentDispatcher.dispatch(intents) });
  // issue #646：M1 终态通知 / M9 完成审查是**终态触发**型，产生端在 `internal.finishRun`（不在评估循环里）。
  // 用**同一个** dispatcher 消费：把 `dispatch` 经 `effectiveConfig.onMacroIntents` 注入——`createServer`/`finishRun`
  // 拿到的 `config` 是同一个对象引用（`cli.serve` 同步跑完这三行才 `listen`，无请求早于此），
  // 所以 finishRun 经 `setRunState(…, { config: ctx.config })` 就能拿到。⚠ **不在 internal.js 里新建 dispatcher**
  //（那会绕过本处接线、还可能重复起 sweep loop）。
  effectiveConfig.onMacroIntents = (intents) => intentDispatcher.dispatch(intents);
  // issue #616 要求④：超时回收清扫单独起 loop（职责与评估不同，不合并）；pending 超阈→failed。
  const macroSweepLoop = startPendingSweepLoop(pool, effectiveConfig);
  const provisionerLoop = startProvisionerLoop(pool, effectiveConfig);
  // issue #650：宿主指标的保留期清理**不单开循环**，挂 reaper 已有的小时级清理槽（一小时一个事务）。
  // `ENABLED=0` 时也照清：采样停了但旧行还得按保留期缩，否则「关掉采样」反而让表永远堆在那儿。
  const reaperLoop = startReaperLoop(pool, {
    systemMetricsRetentionDays: effectiveConfig.systemMetrics?.retentionDays ?? null,
  });
  // issue #650：宿主资源采样器（CPU/内存/磁盘/容器数）。与其余 reconciler 同形：只在 `serve` 里起、
  // 挂进 `loops` 走关停路径。`SYSTEM_METRICS_ENABLED=0` 时 `startMetricsSampler` **不建定时器**（它
  // 自己看 `config.systemMetrics.enabled`），因此那一支既不写库也不拖住退出；但句柄仍然要起，因为
  // `GET /api/admin/system/metrics` 需要一个存在的 `latest()`（它回 `null`，不是 500）。
  // 拍本身不读未注环境的真实环境：`/proc` + `statfs` + docker socket 都是容器里就有的宿主读数（issue #650 实测）。
  const metricsSampler = startMetricsSampler({ pool, config: effectiveConfig, log: console });
  // `GET /api/admin/system/metrics` 的 `latest` 格要读它（口径：`latest` 与 `series` 是**同一个**采样器的
  // 两份读数，不是两份真相）。递送方式照 #616 的 `onMacroIntents` 同一条通道：`ctx.config` 与这里
  // 的 `effectiveConfig` 是**同一个对象引用**，而 `serve` 同步跑完这一行才 `listen` ⇒ 不可能有请求早于它。
  // ⚠ **不在 `http.js` 里新建采样器**（那会绕过 `ENABLED=0` 与关停接线，还可能重复起 sweep）。
  effectiveConfig.metricsSampler = metricsSampler;
  server.listen(effectiveConfig.port, effectiveConfig.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[portal] listening on http://${effectiveConfig.host}:${effectiveConfig.port} (cookie=${effectiveConfig.cookie.name}, secure=${effectiveConfig.cookie.secure})`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `[portal] reconcilers started (materializer root=${effectiveConfig.userSpaceRoot}, traefik dynamic=${effectiveConfig.traefikDynamicDir}, docker=${effectiveConfig.dockerHost})`,
    );
    // eslint-disable-next-line no-console
    console.log('[portal] onboarding loop started');
    console.log('[portal] offboarding loop started');
  });
  // 进程退出时停循环 + 关 HTTP（优雅关闭）。
  //
  // issue #506 评审②：旧代码只同步调 7 个 `stop()` 就 `server.close(() => process.exit(0))`，
  // 而 `stop()` **不中断在途的 `claim*Rows()` 事务**，也没人 await `done` ⇒ 进程可能切在事务中间
  // （回滚白干一轮，或已提交却没 mark*Published ⇒ processing 行带 60s 租约等孤儿回收）。
  // issue #506 复审①：修完②之后顺序变成「先等 5s 循环、**再** server.close」，那 5s 里 server 还在
  // listen ⇒ 仍在接新请求；且 `server.close` 只停接新连接、要等既有连接（SSE = keep-alive）自己结束
  // ⇒ 5s 只是循环那一段的上限，不是整个流程的上限。现在：**先 close 再等循环**，且给整个流程一个
  // 总上限 `SHUTDOWN_TOTAL_MS`，到点无论收没收完都 exit(0) 并点名还没退的循环。细节见 ./shutdown.js。
  const loops = [
    { name: 'materializer', ...materializerLoop },
    { name: 'onboarding', ...onboardingLoop },
    { name: 'offboarding', ...offboardingLoop },
    { name: 'routes', ...routesLoop },
    { name: 'routes-drift', ...driftMonitor },
    { name: 'macro-eval', ...macroEvalLoop },
    { name: 'macro-sweep', ...macroSweepLoop },
    { name: 'provisioner', ...provisionerLoop },
    { name: 'reaper', ...reaperLoop },
    // issue #650：采样器只供 `stop()`（它的定时器已 `unref()`，且拍内没有可 await 的 `done`——
    // `gracefulShutdown` 对缺 `done` 的循环直接跳过，不会多等）。写失败只 warn 的口径下，
    // 停机时丢掉在途那一拍是可接受的（下一拍 `ON CONFLICT DO NOTHING` 重放，不丢正确性）。
    { name: 'system-metrics', ...metricsSampler },
  ];
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // 重入保护：重复信号不许重复 stop / 重复 close
    shuttingDown = true;
    // 顺序与总上限都在 gracefulShutdown 里（可注入 server / exit / stopLoops ⇒ 可单测）：
    // server.close() 发起即返回 → await 循环收尾（SHUTDOWN_WAIT_MS）→ 在剩余总预算里等 server 关完 → exit(0)。
    await gracefulShutdown({
      server,
      loops,
      loopTimeoutMs: SHUTDOWN_WAIT_MS,
      totalTimeoutMs: SHUTDOWN_TOTAL_MS,
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      // shutdown 是 async：拒绝必须在这里接住，否则就是一条未捕获拒绝（本仓已知「摘要全绿但 rc=1」陷阱）。
      shutdown().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[portal] 优雅关闭自身异常，直接退出：', err?.message ?? err);
        process.exit(1);
      });
    });
  }
}

async function runMigrate() {
  const config = loadConfig();
  const pool = createPool(config.migrateDatabaseUrl);
  const bootstrapPool = createPool(config.bootstrapDatabaseUrl);
  try {
    const summary = await migrate(pool, {
      bootstrapPool,
      migrateDatabaseUrl: config.migrateDatabaseUrl,
    });
    // eslint-disable-next-line no-console
    console.log('[migrate] done', summary);
    process.exitCode = 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
    await bootstrapPool.end().catch(() => {});
  }
}

function printTotpProvisioning(secret, login, issuer) {
  const uri = totp.otpauthUri(secret, { issuer, label: login });
  // eslint-disable-next-line no-console
  console.log(`TOTP otpauth URI: ${uri}`);
  // eslint-disable-next-line no-console
  console.log('⚠️ 请用认证器 App（Google Authenticator / 1Password / Aegis 等）扫码或录入上述 URI。');
  // eslint-disable-next-line no-console
  console.log(`   种子（base32，仅此一次下发，之后不再显示）：${secret}`);
}

async function bootstrapAdmin(values) {
  const login = values.login;
  if (!login) {
    // eslint-disable-next-line no-console
    console.error('--login is required');
    process.exit(2);
  }
  const config = loadConfig();
  // bootstrap-admin 属 bootstrap 操作：用 bootstrap 超级用户（BOOTSTRAP_DATABASE_URL）执行迁移与写 users。
  const pool = createPool(config.bootstrapDatabaseUrl);
  try {
    // 本命令以 bootstrap 超级用户跑全流程：迁移身份切换（issue #280）按这条连接串点名，
    // 与当前角色同名时是无副作用 no-op，否则由 runner 量出表属主后 SET ROLE（见 migrate.js）。
    await migrate(pool, { migrateDatabaseUrl: config.bootstrapDatabaseUrl });
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
    const totpSecret = totp.generateSecret(20);
    const displayName = values['display-name'] || login;
    // #255（首登强制改密）：这条 INSERT **故意不写 `must_change_password`** ⇒ 吃 DB 默认值 false。
    // 理由：bootstrap-admin 是「运维自己给自己设第一个 admin」——口令就是这次 CLI 打印出来的那枚，
    // 已经经过本人之手，再要求「首登改密」是空转；而 dev/CI 的 bootstrap 账号（AGENTS §4.1 的 admin/eric）
    // 一旦被打上旗标就会被锁进改密屏，而本单不含前端界面 ⇒ 锁了没有出口，dev 栈与 CI 直接不可用。
    // 对照：admin.js 的 createUser / resetUserPassword 两条分支都写 `must_change_password = true`
    //（那里是「管理员代设」= 本单要治的场景）。默认值契约由迁移 0021 的 DO 守卫钉住。
    await pool.query(
      `INSERT INTO users (login, display_name, role, auth_source, status, password_hash, totp_secret)
       VALUES ($1, $2, 'admin', 'local', 'active', $3, $4)`,
      [login, displayName, passwordHash, totpSecret],
    );
    // eslint-disable-next-line no-console
    console.log(`created admin login=${login} display_name=${displayName}`);
    // eslint-disable-next-line no-console
    console.log(`${generated ? 'generated password' : 'password'}: ${password}`);
    if (generated) {
      // eslint-disable-next-line no-console
      console.log('⚠️ 请立即记录此一次性口令（P1 skeleton 暂无强制改密 UI）');
    }
    // 默认打印 otpauth provisioning URI 与 secret（一次性展示）；--print-secret 保留为兼容开关（无额外行为）。
    printTotpProvisioning(totpSecret, login, config.totp.issuer);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function runProvisionFde(values) {
  const fdeName = values['fde-name'];
  if (!fdeName) {
    // eslint-disable-next-line no-console
    console.error('--fde-name is required');
    process.exit(2);
  }
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const docker = createDockerClient({ dockerHost: config.dockerHost });
  try {
    const out = await onboardFde(pool, config, { fdeName, docker });
    // eslint-disable-next-line no-console
    console.log(
      `[provision-fde] ok fde=${fdeName} network=${out.networkName} subnet=${out.subnet} container=${out.containerName}`
      // issue #246 交付①：运维要一眼看到分到哪一段号（块 = 号池里的对齐十连号），不再只报条数。
      + ` preview_ports=${out.previewPorts.created}/${out.previewPorts.requested} 新写（${out.previewPorts.skipped} 条已存在）`
      + ` block=${out.previewPorts.blockStart}-${out.previewPorts.blockEnd}`,
    );
    process.exitCode = 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[provision-fde] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * issue #399：存量搬运——把 minted FDE 留在 legacy home/.git-credentials 里的平台托管行
 * 搬进平台独占文件（token 不变、agent 无感）。缺省扫全部 minted FDE；--fde-name 限定单台。
 * 幂等：legacy 没有该行则迁 0；重跑安全。
 */
async function runMigrateGitCredentials(values) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  let failed = false;
  try {
    const rows = (await pool.query(
      `SELECT u.fde_name, h.base_url
         FROM fde_git_accounts a
         JOIN users u ON u.id = a.fde_id
         JOIN git_hosts h ON h.id = a.git_host_id
        WHERE h.mode = 'minted' AND ($1::text IS NULL OR u.fde_name = $1) AND u.fde_name IS NOT NULL`,
      [values['fde-name'] ?? null],
    )).rows;
    let migrated = 0;
    for (const row of rows) {
      let host;
      try {
        host = new URL(row.base_url).host.toLowerCase();
      } catch {
        continue;
      }
      try {
        const n = migrateLegacyCredential({ config, fdeName: row.fde_name, host });
        migrated += n;
        // eslint-disable-next-line no-console
        console.log(`[migrate-git-credentials] ${row.fde_name} ${host}: ${n > 0 ? `moved ${n} line(s)` : 'nothing to move'}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[migrate-git-credentials] ${row.fde_name} ${host}: FAILED ${err.message}`);
        failed = true;
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[migrate-git-credentials] done: scanned=${rows.length} migrated_lines=${migrated}`);
    if (failed) process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function runDeprovisionFde(values) {
  const fdeName = values['fde-name'];
  if (!fdeName) {
    // eslint-disable-next-line no-console
    console.error('--fde-name is required');
    process.exit(2);
  }
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const docker = createDockerClient({ dockerHost: config.dockerHost });
  try {
    // issue #33：offboard 收敛该用户 active run 并合成 run_end。run_events 落库才是真相；
    // notify 仅在「同一进程内存在 SSE hub」时实时可达——独立 CLI 进程的 hub 是空的，
    // 已连接的浏览器**不会**实时收到（评审 major：backlog 只在 SSE 重连时补发，需刷新/重连）。
    // 保留注入：未来 admin 端点改为 portal 进程内调用 deprovision 时即实时生效。
    const out = await deprovisionFde(pool, config, { fdeName, docker, notify: notifySessionEvents });
    // eslint-disable-next-line no-console
    console.log(
      `[deprovision-fde] ok fde=${fdeName} container=${out.containerName} network=${out.networkName}`,
    );
    process.exitCode = 0;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[deprovision-fde] failed:', err.message);
    process.exitCode = 1;
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
      'print-secret': { type: 'boolean', default: false },
      'fde-name': { type: 'string' },
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
    case 'provision-fde':
      return runProvisionFde(values);
    case 'deprovision-fde':
      return runDeprovisionFde(values);
    case 'migrate-git-credentials':
      return runMigrateGitCredentials(values);
    case 'healthcheck':
      return healthcheck();
    default:
      usage();
      process.exit(2);
  }
}

main();
