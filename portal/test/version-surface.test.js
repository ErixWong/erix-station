// issue #586 判据 D：**三格来源锁死** + **portal 镜像的 build-info 判据本身要能红**。
//
// 本单要治的事故（发 v0.1.69：`git pull` 抖动 ⇒ portal 烘的是停在 0.1.68 的工作树 ⇒ 真机 FDE 报
// 0.1.69 / portal 报 0.1.68 分裂一小时，**没有任何机器判据发现它**）。所以这里钉两件不同的事：
//
//   ① **来源锁死**（D-1/D-3）：注入一份版本与仓库 `package.json` **不同**的 build-info（可注入路径，
//      **不真改仓库文件**）⇒ 端点与面板必须显示 build-info 的值；FDE 那格必须来自
//      `containers.agent_version` 且**不等于**平台侧引擎那格（互抄就红）。
//   ② **判据本身要自证**（D-2）：镜像四格的断言抽在 `scripts/check-build-info.mjs`（CI 与本文件共用
//      同一份实现），这里逐格喂坏形状 ⇒ 每格都得红，且**只有该红的那条红**（防断言互相遮蔽）。
//      再加源码级锁：Dockerfile / release.yml / ci.yml / compose 四处改动一处没落就红。
//
// 隔离（docs/testing.md §2.1）：临时目录 + 内存 FakePool，不碰真实 DB、不改仓库文件、不 build 镜像。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import * as migrate from '../src/migrate.js';
import { hashToken } from '../src/auth.js';
import { aboutPanel, provenanceFor, provenanceForValue, PACKAGE_DIR, BUILD_INFO_PATH } from '../src/version-info.js';
import { readBuildInfo as readPortalBuildInfo } from '../src/build-info.js';
import { readStationVersion } from '../src/version-info.js';
import { readBuildInfo as readRunnerBuildInfo, UNKNOWN } from '../../runner/lib/build-info.js';
import { checkBuildInfo, checkBuildInfoText } from '../../scripts/check-build-info.mjs';
import { FakePool } from './fake-pool.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const REPO_VERSION = JSON.parse(read('package.json')).version;

const ADMIN_ID = '00000000-0000-4000-8000-0000000000b1';
const FDE_ID = '00000000-0000-4000-8000-0000000000b2';
const ADMIN_TOKEN = 'surface-admin-session';
const FDE_TOKEN = 'surface-fde-session';

/** 注入的 build-info：三个数互不相同，且**都不等于**仓库 `package.json` 的版本。 */
const INJECT = {
  station_version: '9.9.9-injected-build',
  engine_version: '0.902.0-injected-engine',
  revision: 'c'.repeat(40),
  built_at: '2026-11-16T03:45:00Z',
};
const CONTAINER_AGENT_VERSION = '0.910.7-fde-side';

class SurfacePool extends FakePool {
  constructor() {
    super({
      users: [
        { id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' },
        { id: FDE_ID, login: 'alice', role: 'fde', fde_name: 'alice', status: 'active', auth_source: 'local' },
      ],
    });
  }

  async query(sql, params = []) {
    const text = String(sql);
    if (text.includes('FROM schema_migrations')) {
      // 迁移全在 head ⇒ `/api/health` 走 200 分支（假 pool 的默认台账只有一行，会翻成 503）。
      return { rows: migrate.computeExpectedVersions(migrate.defaultMigrationsDir()).map((version) => ({ version })) };
    }
    if (text.includes('FROM containers')) {
      return {
        rows: [{
          fde_name: 'eric', agent_version: CONTAINER_AGENT_VERSION,
          image: 'ghcr.io/erixwong/erix-station-fde@sha256:abc',
          created_at: new Date('2026-11-16T02:00:00Z'), rotated_at: null,
          last_heartbeat: null, revoked_at: null,
        }],
      };
    }
    return super.query(sql, params);
  }
}

function writeBuildInfo(values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-surface-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(values));
  return { dir, file };
}

async function withEnv(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function startServer(pool) {
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-sstatic-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'INDEX');
  for (const [id, token] of [[ADMIN_ID, ADMIN_TOKEN], [FDE_ID, FDE_TOKEN]]) {
    pool.sessions.push({
      id: `session-${id}`, user_id: id, token_hash: hashToken(token), created_at: new Date(),
      expires_at: new Date(Date.now() + 600_000), last_seen_at: new Date(), revoked_at: null,
    });
  }
  const cookie = cookieSettings('surface-test', 600);
  const server = createServer({
    pool,
    log: { error() {}, warn() {}, log() {} },
    config: {
      cookie,
      sessionTtlSeconds: 600, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
      totp: { issuer: 'x', digits: 6, period: 30, window: 1 },
      loginRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, maxEntries: 100 },
      totpRateLimit: { maxFailures: 20, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 20, maxEntries: 100 },
      kdfConcurrency: 1, kdfQueueLimit: 10, kdfQueueTimeoutMs: 1000,
      maxBodyBytes: 64 * 1024, maxLoginLength: 128, maxPasswordLength: 256, staticDir,
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    adminCookie: `${cookie.name}=${ADMIN_TOKEN}`,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// D-1 / D-3：三格来源锁死（注入 ≠ package.json 的 build-info）
// ─────────────────────────────────────────────────────────────────────────────
test('#586D-1：注入一份与仓库 package.json 不同版本的 build-info ⇒ 端点与面板都显示 build-info 的值', async () => {
  assert.notEqual(INJECT.station_version, REPO_VERSION, '夹具前提：注入版本必须与仓库版本不同（否则本判据是软的）');
  const { dir, file } = writeBuildInfo(INJECT);
  await withEnv({ STATION_BUILD_INFO_PATH: file }, async () => {
    const srv = await startServer(new SurfacePool());
    try {
      const health = await (await fetch(`${srv.base}/api/health`)).json();
      assert.equal(health.version.station, INJECT.station_version,
        '`/api/health` 的 station 来自 build-info.json，**不是** `package.json`');
      assert.notEqual(health.version.station, REPO_VERSION,
        '读成 package.json 的版本就是本单要消灭的形状（构建输入 ≠ 运行事实）');

      const panel = await (await fetch(`${srv.base}/api/admin/version`, {
        headers: { cookie: srv.adminCookie },
      })).json();
      assert.equal(panel.server.station, INJECT.station_version, '面板服务端段同样锁在 build-info');
      assert.equal(panel.platformEngine.version, INJECT.engine_version, '平台侧引擎段 = build-info 的 engine_version');
      assert.equal(panel.server.source, 'build-info', '面板要说清这一格是从 build-info 读的，不是现读的');
    } finally {
      await srv.close();
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#586D-3：FDE 那格与平台侧引擎格**不同源也不同值**，面板要能看出来（不许静默显示成同一个数）', async () => {
  const { dir, file } = writeBuildInfo(INJECT);
  const body = await aboutPanel({ pool: new SurfacePool(), readVersion: undefined });
  // 上面故意不注入 env：用真实默认路径（本地没有 /app/build-info.json ⇒ dev 退路）。
  // 真正的三值对比走注入版：
  await withEnv({ STATION_BUILD_INFO_PATH: file }, async () => {
    const injected = await aboutPanel({ pool: new SurfacePool() });
    const threeValues = [
      injected.server.station,
      injected.platformEngine.version,
      injected.fdes[0].agentVersion,
    ];
    assert.deepEqual(threeValues, [INJECT.station_version, INJECT.engine_version, CONTAINER_AGENT_VERSION],
      '三格各自出自自己的来源，三个数互不相同');
    assert.equal(new Set(threeValues).size, 3, '三个值两两不同（有任何两格相等到夹具层面就该红）');
    assert.equal(injected.fdes[0].versionSource, 'containers.agent_version');
    assert.equal(injected.fdes[0].snapshot, 'provision', 'FDE 段必须带快照口径标注（前端据此渲染「provision 时快照」）');
    assert.equal(injected.provenance.fdes, 'containers.agent_version');
    assert.notEqual(injected.fdes[0].agentVersion, injected.platformEngine.version);
    assert.notEqual(injected.fdes[0].agentVersion, injected.server.station);
  });
  assert.ok(body.server.station !== undefined, '未注入时（dev 退路）也要有 station，不许 undefined');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-2：判据本身要能红（`scripts/check-build-info.mjs` 与 CI 共用同一份实现）
// ─────────────────────────────────────────────────────────────────────────────
const WANT = { wantVersion: '0.1.69', wantRevision: 'd'.repeat(40) };
const GOOD = {
  station_version: '0.1.69', engine_version: '0.33.0', revision: 'd'.repeat(40), built_at: '2026-11-16T00:00:00Z',
};

test('#586D-2：好形状绿、四种坏形状各自红，且**只有该红的那条红**（断言不许互相遮蔽）', () => {
  assert.deepEqual(checkBuildInfo(GOOD, WANT), [], '好形状必须绿（否则 CI 那一步恒红也是判据坏了）');
  const cases = [
    ['station_version 与仓库不符（烘错了树）', { ...GOOD, station_version: '0.1.68' }, 'station_version'],
    ['revision 不是本次 commit（没传 STATION_REVISION）', { ...GOOD, revision: UNKNOWN }, 'revision'],
    ['engine_version 是 unknown（引擎版本没烘进去）', { ...GOOD, engine_version: UNKNOWN }, 'engine_version'],
    ['built_at 是 unknown（没传 STATION_BUILD_DATE）', { ...GOOD, built_at: UNKNOWN }, 'built_at'],
  ];
  for (const [name, broken, expectKey] of cases) {
    const bad = checkBuildInfo(broken, WANT);
    assert.equal(bad.length, 1, `${name} ⇒ 应恰好一条不合格，实得 ${bad.length} 条：${JSON.stringify(bad)}`);
    assert.ok(bad[0].includes(expectKey), `${name} ⇒ 报错要点名 ${expectKey}：${bad[0]}`);
  }
  // 整份缺失 / 坏 JSON 也算不合格（「镜像里根本没烘」是本单的原始事故形状）。
  assert.equal(checkBuildInfo(null, WANT).length, 1);
  assert.ok(checkBuildInfoText('not json', WANT)[0].includes('解析失败'));
});

test('#586D-2：CI 用的就是这份实现，且四格断言都在（源码级锁，删一条就红）', () => {
  const ci = read('.github/workflows/ci.yml');
  const step = ci.slice(ci.indexOf("构建校验：station-portal 镜像的 build-info.json"));
  assert.ok(step.length > 0, 'ci.yml 里必须还有 portal 的 build-info tripwire 步骤');
  assert.match(step, /docker run --rm --entrypoint cat "\$\{IMG_PORTAL\}:ci-\$\{GITHUB_SHA::7\}" \/app\/build-info\.json/,
    'tripwire 必须真的从**镜像里**读 /app/build-info.json（不是读仓库里那份）');
  assert.match(step, /node scripts\/check-build-info\.mjs/, 'CI 必须调共用实现，而不是另写一份内联断言');
  assert.match(step, /WANT_VERSION="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/,
    '期望版本必须**现读仓库 package.json**（写死一个数就是第二份会漂的账）');
  assert.match(step, /WANT_REVISION="\$GITHUB_SHA"/, '期望 revision 必须是本次 commit');
});

test('#586D-2：portal 构建侧的三处改动都在册（Dockerfile 烘 + release 传 ARG + compose 有 args）', () => {
  const dockerfile = read('portal/Dockerfile');
  assert.match(dockerfile, /ARG STATION_VERSION=unknown\nARG STATION_REVISION=unknown\nARG STATION_BUILD_DATE=unknown/,
    '三个 ARG 必须成组声明（缺一个就等于那一格恒 unknown）');
  assert.match(dockerfile, /fs\.writeFileSync\("\/app\/build-info\.json"/, '必须真的写 /app/build-info.json');
  assert.match(dockerfile, /v\("\/app\/node_modules\/erix-agent\/package\.json"\)/,
    'engine_version 必须从镜像内的 erix-agent package.json 读（不是从 ARG 传）');
  assert.match(dockerfile, /if\(sv==="unknown"\)\{[^\n]*process\.exit\(1\)/,
    '取不到 station_version 必须让构建红（宁可红，也不要烘出一个像样的假版本）');
  assert.match(dockerfile, /LABEL org\.opencontainers\.image\.version="\$\{STATION_VERSION\}"/,
    'OCI label 要给人看（不参与运行时真相）');
  // 位置红线：版本 ARG 必须声明在**所有 COPY 之后**（放最前 = 每次改版本就击穿前面的依赖/源码层缓存）。
  // ⚠ 不与最后的 `RUN` 比：紧随 ARG 的那条 RUN 就是烘 build-info  itself（它必须在 ARG 之后）。
  const argAt = dockerfile.indexOf('ARG STATION_VERSION');
  const lastCopyAt = dockerfile.lastIndexOf('COPY ');
  assert.ok(argAt > lastCopyAt, '版本 ARG 必须在所有 COPY 之后（缓存影响最小；与 runner/Dockerfile 同一取舍）');
  // 位置一致性：Dockerfile 写的路径必须就是运行侧读的那一个。
  assert.ok(dockerfile.includes(BUILD_INFO_PATH), `运行侧读的 ${BUILD_INFO_PATH} 必须与镜像里写的位置一致`);

  const release = read('.github/workflows/release.yml');
  const portalStep = release.slice(release.indexOf("'④ 构建并推送 portal 镜像"), release.indexOf("'⑤ 构建并推送 FDE 镜像"));
  for (const arg of ['STATION_VERSION', 'STATION_REVISION', 'STATION_BUILD_DATE']) {
    assert.ok(portalStep.includes(`${arg}=`), `release.yml 的 portal 步骤必须传 ${arg}（不传 ⇒ 镜像里那格恒 unknown）`);
  }

  const compose = read('deploy/docker-compose.yml');
  const portalBuild = compose.slice(compose.indexOf('station-portal:'), compose.indexOf('image: ${STATION_PORTAL_IMAGE'));
  for (const arg of ['STATION_VERSION', 'STATION_REVISION', 'STATION_BUILD_DATE']) {
    assert.ok(portalBuild.includes(`${arg}:`), `compose 的 station-portal.build.args 必须带 ${arg}（本地构建也要能留 revision）`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 镜像副本不许漂：`portal/src/build-info.js` 必须是 runner 那份的逐字副本
// ─────────────────────────────────────────────────────────────────────────────
test('#586：portal 侧的 readBuildInfo 是 runner 那份的**逐字副本**（跨镜像不许 import，同步必须钉住）', () => {
  const portalSrc = read('portal/src/build-info.js');
  const runnerSrc = read('runner/lib/build-info.js');
  const at = portalSrc.indexOf(runnerSrc);
  assert.ok(at >= 0, 'portal/src/build-info.js 必须逐字包含 runner/lib/build-info.js 的当前内容（改了没同步 ⇒ 两份读法会漂）');
  const head = portalSrc.slice(0, at);
  assert.ok(head.split('\n').every((line) => line.trim() === '' || line.startsWith('//')),
    '唯一允许的差异是顶部的镜像说明注释（不许在副本里改逻辑）');
  assert.equal(portalSrc.slice(at + runnerSrc.length).trim(), '', '副本尾部也不许多出自创逻辑');
});

test('#586：同一份 build-info，两份实现读出**同一组值**（行为面同步，不只文本面）', () => {
  const { dir, file } = writeBuildInfo({
    station_version: '1.2.3', engine_version: '0.4.5', revision: 'e'.repeat(40), built_at: '2026-10-01T00:00:00Z',
  });
  try {
    const pkgDir = PACKAGE_DIR;
    const portalView = readPortalBuildInfo({ env: {}, buildInfoPath: file, packageDir: pkgDir });
    const runnerView = readRunnerBuildInfo({ env: {}, buildInfoPath: file, packageDir: pkgDir });
    assert.deepEqual(portalView, runnerView, '同一路径必须读出同一个对象（降级链不许两份各写一份）');
    assert.equal(portalView.source, 'build-info');
    assert.equal(portalView.runnerVersion, '1.2.3', 'station_version 落在 runnerVersion 格（历史包袱字段名，见 version-info.js）');
    assert.equal(portalView.agentVersion, '0.4.5');
    // 负例：文件不存在 ⇒ 两份都退到 package.json，且 station 是**仓库根**的那一份。
    const missing = path.join(dir, 'nope.json');
    const fallback = readPortalBuildInfo({ env: {}, buildInfoPath: missing, packageDir: pkgDir });
    assert.equal(fallback.source, 'package');
    assert.equal(fallback.runnerVersion, REPO_VERSION);
    assert.equal(fallback.revision, UNKNOWN, 'dev 退路给不出 revision/built_at：那两格只有构建期 ARG 能给');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586：读法只有一条 —— portal/src 里除 version-info.js/build-info.js 外不许有人自己读 package.json', () => {
  const offenders = [];
  for (const entry of fs.readdirSync(path.join(REPO, 'portal/src'))) {
    if (!entry.endsWith('.js')) continue;
    // 只看**代码**：注释里提一句「根 package.json 的依赖」是注释（mailer.js / transcript-store.js 就是），
    // 不算第二个真相源。剔行注释与块注释后再扫。
    const code = read(`portal/src/${entry}`)
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    if (/package\.json/.test(code) && !['version-info.js', 'build-info.js'].includes(entry)) {
      offenders.push(entry);
    }
  }
  assert.deepEqual(offenders, [], '自己 `require(.../package.json)` 就是第二个真相源（口径 #586 第 4 条）');
});

// ─────────────────────────────────────────────────────────────────────────────
// 评审阻断（copilot review）：`ERIX_AGENT_VERSION` 不许在 portal 侧冒充镜像里的构建产物
// ─────────────────────────────────────────────────────────────────────────────
// `readBuildInfo()` ① 那条 override 是 **FDE 容器侧**的正当需求（`provisioner.js` 往容器 env 注入它，
// 与容器自己的 build-info.json 同源）。portal 的权威载体是**自己镜像里**的 build-info.json —— 一旦让它
// 盖过去，`aboutPanel()` 写死的 `provenance.platformEngine: 'build-info.json'` 就变成谎话：面板显示的值
// 不来自它自称的那个来源。所以 portal 在**入口**屏蔽这个旋钮（不是把 provenance 改成 `'env'` 了事）。
test('#586 评审阻断：portal 侧 ERIX_AGENT_VERSION 盖不掉平台侧引擎那格（provenance 不许说谎）', async () => {
  const BOGUS = '9.9.9-bogus';
  const { dir, file } = writeBuildInfo(INJECT);
  await withEnv({ STATION_BUILD_INFO_PATH: file, ERIX_AGENT_VERSION: BOGUS }, async () => {
    const panel = await aboutPanel({ pool: new SurfacePool() });
    assert.equal(panel.platformEngine.version, INJECT.engine_version,
      '引擎那格必须还是 build-info 里那一个（被 env 盖过 = 谎报来源）');
    assert.equal(panel.server.source, 'build-info', '面板要能说真话：这一格确实从 build-info 读的');
    assert.equal(panel.provenance.platformEngine, 'build-info.json');
    assert.ok(!JSON.stringify(panel).includes(BOGUS),
      `env 那个值根本不许出现在响应里，实得：${JSON.stringify(panel)}`);
    // `/api/health` 同口径：形状不变（**不含** engine 字段），三格也不受这个旋钮影响。
    const srv = await startServer(new SurfacePool());
    try {
      const res = await fetch(`${srv.base}/api/health`);
      const body = await res.json();
      assert.deepEqual(Object.keys(body.version).sort(), ['builtAt', 'revision', 'station'],
        '健康端点的 version 块仍是三格，没多出 engine');
      assert.deepEqual(body.version, {
        station: INJECT.station_version, revision: INJECT.revision, builtAt: INJECT.built_at,
      });
      assert.ok(!JSON.stringify(body).includes(BOGUS), '健康端点同样不许漏出 env 覆盖值');
    } finally {
      await srv.close();
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('#586 评审阻断：屏蔽只发生在 portal 入口 —— runner 那份 override 语义原样保留（不许顺手改别人的口径）', () => {
  const { dir, file } = writeBuildInfo(INJECT);
  try {
    const withOverride = readRunnerBuildInfo({
      env: { ERIX_AGENT_VERSION: '9.9.9-bogus' }, buildInfoPath: file, packageDir: PACKAGE_DIR,
    });
    assert.equal(withOverride.agentVersion, '9.9.9-bogus', 'runner/FDE 侧仍能显式盖（那是它的正当需求）');
    assert.equal(withOverride.source, 'env');
    const portalView = readPortalBuildInfo({
      env: { ERIX_AGENT_VERSION: '9.9.9-bogus' }, buildInfoPath: file, packageDir: PACKAGE_DIR,
    });
    assert.equal(portalView.agentVersion, '9.9.9-bogus',
      '底层函数本身照旧：屏蔽是 version-info.js 的责任，不是把 readBuildInfo 改残');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 复验阻断（第二轮）：来源标注必须**由实际来源推导**，路径注入要可见
// ─────────────────────────────────────────────────────────────────────────────
// 写死 `'build-info.json'` 在**旧 portal 镜像**（本 PR 之前构建的、或烘失败的）上就是说谎：
// `readBuildInfo()` 在那份镜像里读不到 build-info.json ⇒ 退到 `packageDir/node_modules/erix-agent/package.json`
// （`source:'package'`），面板上那个引擎号确实是 package.json 里的，标签却写着「镜像里的构建产物」。
test('#586 复验阻断：build-info 读不到（旧镜像形状）⇒ 引擎格取自 package.json，来源标注也必须是 package.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-oldimage-'));
  // 造一份「旧镜像」的最小布局：只有 package.json 与 node_modules/erix-agent/package.json，**没有** build-info.json。
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.666.0-old-station' }));
  fs.mkdirSync(path.join(dir, 'node_modules/erix-agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/erix-agent/package.json'), JSON.stringify({ version: '0.777.0-old-engine' }));
  const missing = path.join(dir, 'build-info.json'); // 就是不存在 ⇒ 走降级链
  try {
    const panel = await aboutPanel({
      pool: new SurfacePool(),
      readVersion: () => readStationVersion({ env: {}, buildInfoPath: missing, packageDir: dir }),
    });
    assert.equal(panel.server.source, 'package', '夹具前提：这次读取走的是 dev/旧镜像退路');
    assert.equal(panel.platformEngine.version, '0.777.0-old-engine',
      '引擎那格确实来自那份 package.json（值本身没撒谎）');
    assert.equal(panel.provenance.platformEngine, 'package.json',
      '**阻断点**：来源标注必须跟着值走，写死 build-info.json 就是在旧镜像上谎报');
    assert.equal(panel.provenance.server, 'package.json', '同一次读取 ⇒ 服务端段同源（两格不许一格真一格假）');
    assert.notEqual(panel.provenance.platformEngine, 'build-info.json',
      '「镜像里烘了 build-info.json」这句话在这份构建里是不成立的');
    assert.equal(panel.buildInfoPath, missing, '没读到也要说清去哪条路径读过（否则退路是凭空冒出来的）');
    // 认不出的 source 一律 `unknown`，不许默认成 build-info（`provenanceFor` 是面板唯一的推导口）。
    assert.equal(provenanceFor('nonsense'), UNKNOWN);
    assert.equal(provenanceFor(undefined), UNKNOWN);
    assert.equal(provenanceFor('env'), 'env', 'env 真出现时就说 env（入口已屏蔽它，但不能静默说成 build-info）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586 三轮 nit：引擎值本身是 unknown 时，来源标注不许冒充 package.json（有值才谈来源）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-586-noengine-'));
  // **只有根 package.json**、没有 `node_modules/erix-agent/package.json`，也没有 build-info.json。
  // `readBuildInfo()` 只看根 package.json 可读就置 `source:'package'` ⇒ 引擎那格其实是 `unknown`。
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.666.0-old-station' }));
  const missing = path.join(dir, 'build-info.json');
  try {
    const panel = await aboutPanel({
      pool: new SurfacePool(),
      readVersion: () => readStationVersion({ env: {}, buildInfoPath: missing, packageDir: dir }),
    });
    assert.equal(panel.server.station, '0.666.0-old-station', '夹具前提：根 package.json 确实读到了');
    assert.equal(panel.server.source, 'package');
    assert.equal(panel.platformEngine.version, UNKNOWN, '引擎没有值（那份 package.json 不存在）');
    assert.equal(panel.provenance.platformEngine, UNKNOWN,
      '**nit 点**：没值就不能报「来自 package.json」——标注只在有值时才说来源');
    assert.notEqual(panel.provenance.platformEngine, 'package.json',
      '有值才谈来源：这一格值都缺，冒充来源就是本单一贯要消灭的形状');
    // `server` 那格不受这道闸门影响：它的值就出自根 package.json，读到了就有值。
    assert.equal(panel.provenance.server, 'package.json', '有值的那一格照报来源（闸门不是把标注一律抹成 unknown）');
    // 同一道闸门在 build-info 形状下不该误伤：四格齐全时来源照报。
    assert.equal(provenanceForValue('0.33.0', 'build-info'), 'build-info.json');
    assert.equal(provenanceForValue(UNKNOWN, 'build-info'), UNKNOWN,
      'build-info 里缺 engine_version 时同样不许冒充');
    assert.equal(provenanceForValue('', 'package'), UNKNOWN, '空串也算没值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('#586 复验阻断：STATION_BUILD_INFO_PATH 改过路径 ⇒ 面板透出 buildInfoPath，而 /api/health 形状一字不动', async () => {
  const { dir, file } = writeBuildInfo(INJECT);
  await withEnv({ STATION_BUILD_INFO_PATH: file }, async () => {
    const srv = await startServer(new SurfacePool());
    try {
      const panel = await (await fetch(`${srv.base}/api/admin/version`, {
        headers: { cookie: srv.adminCookie },
      })).json();
      assert.equal(panel.buildInfoPath, file,
        '路径被 env 改过就必须看得见（否则一份指向别处的文件顶着「镜像内 build-info.json」的标签出现）');
      assert.equal(panel.provenance.server, 'build-info.json', '读到了 ⇒ 标注仍是 build-info.json（推导不是降级）');
      assert.equal(panel.provenance.platformEngine, 'build-info.json');
      assert.equal(panel.server.source, 'build-info');
      // 第三轮 nit：光透出路径不够 —— 必须**逐字对上这次注入的值**，才算证明「界面上那条路径
      // 就是实际读到这两个版本的那条」，而不是路径与版本各算一遍（两条路各自降级也会各自全绿）。
      assert.equal(panel.server.station, INJECT.station_version,
        'station 必须出自**这条被改过的路径**里的那份 build-info');
      assert.equal(panel.platformEngine.version, INJECT.engine_version,
        '平台侧引擎同理（值与路径必须同一次读取，不许一边读文件、一边读 package.json）');
      assert.equal(panel.server.revision, INJECT.revision);
      assert.equal(panel.server.builtAt, INJECT.built_at);
      assert.notEqual(panel.server.station, REPO_VERSION, '反证：不是从仓库 package.json 现读的那一份');

      const health = await (await fetch(`${srv.base}/api/health`)).json();
      assert.deepEqual(Object.keys(health.version).sort(), ['builtAt', 'revision', 'station'],
        '红线：`/api/health` **不加** buildInfoPath（公开端点不泄露部署路径，形状仍是三格）');
      assert.ok(!JSON.stringify(health).includes(file.replace(/\/[^/]+$/, '')),
        '整份健康响应里也不许漏出那条路径');
    } finally {
      await srv.close();
    }
  });
  fs.rmSync(dir, { recursive: true, force: true });
});
