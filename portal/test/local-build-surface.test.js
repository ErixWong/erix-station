// issue #643 B：**本地 scratch 构建必须自曝**（后端腿的判据）。
//
// 病根（261117 现场，本机真机）：共享 dev 栈里跑的是 `erix-station/portal:p596-v3`，
// `/api/health` 报 `station:0.1.72 / revision:unknown / builtAt:unknown` —— 一份**本地构建**顶着
// 发布件的脸。`revision` 只有构建期 ARG 拿得到（`portal/Dockerfile` 末尾烘 `/app/build-info.json`），
// 本地 `docker compose build` 不传就是 `unknown`，而界面把这一格显示成「未知」、日志里一声不响
// ⇒ 没人知道自己正在拿哪份东西对账（版本面 #586 那条「三格各自从哪儿取」的读法本身没错，
// 缺的是「这份构建压根没身份」这一句要被**说出来**）。
//
// 本文件钉三件事（形状各不相同，缺一不可）：
//   ① 判别位只有一个：`revision === 'unknown'` ⇒ 本地构建。**不看 `builtAt`**（那是另一个 ARG，
//      它单独缺不说明这份构建没身份）⇒ 有独立用例钉这条方向，写反就红。
//   ② 观测面不承重（#515 同口径）：读版本失败、注入的 `log` 是脏东西、`warn` 自己抛，
//      都不许把 `serve()` 的启动路径带倒；而**发布件一条都不打**（天天喊的告警等于没告警）。
//   ③ 接线：`portal/src/cli.js` 的 `serve()` 真调用它，且位置在 `loadConfig()` 之后、
//      `migrate()` 之前 —— DB 起不来时那一句更要说得出（放在 migrate 后面就是「DB 好了才有
//      资格自曝」）。接线锁是源码级的（`cli.js` 没有测试可达的入口：它一跑就 listen + 起循环）。
//
// 为什么 `localBuild` 在**顶层**而不是塞进 `server`：`server` 那条「每一格都是字符串」的不变式
// 正被 `portal/test/admin-version-panel.test.js` 钉着，塞布尔进去就得连带放宽那条红线；
// 顶层布尔的先例就在同一层（`fdesPresent`）。
//
// 隔离（docs/testing.md §2.1）：临时目录 + 内存 fake pool，不碰真实 DB、不改仓库里的 `package.json`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { aboutPanel, isLocalBuild, warnIfLocalBuild, readStationVersion } from '../src/version-info.js';
import { UNKNOWN } from '../src/build-info.js';
import { createServer } from '../src/http.js';
import { cookieSettings } from '../src/config.js';
import { hashToken } from '../src/auth.js';
import { FakePool } from './fake-pool.js';

const CLI_SRC = new URL('../src/cli.js', import.meta.url);
const ADMIN_ID = '00000000-0000-4000-8000-0000000000b1';
const ADMIN_TOKEN = '643-admin-session-token';

/** 只读用的小 fake：`aboutPanel()` 只查 `FROM containers`，给空表即可（FDE 段与本单无关）。 */
const emptyContainersPool = () => ({ calls: [], async query(sql) { this.calls.push(String(sql)); return { rows: [] }; } });

/** 收日志的 sink：既能数条数，也能当「脏 log」用。 */
function logSink({ throwOnWarn = false } = {}) {
  const lines = [];
  return {
    lines,
    warn: (m) => {
      lines.push(String(m));
      if (throwOnWarn) throw new Error('sink 挂了');
    },
  };
}

/** 临时 build-info 文件（`STATION_BUILD_INFO_PATH` 注入点，先例见 `health-version.test.js`）。 */
function injectBuildInfo(values) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'station-643-bi-'));
  const file = path.join(dir, 'build-info.json');
  fs.writeFileSync(file, JSON.stringify(values));
  return { dir, file };
}

/** 一份「有身份的」发布件 build-info（revision 有值）。 */
const RELEASE_BI = {
  station_version: '0.1.72', engine_version: '0.33.0',
  revision: 'b'.repeat(40), built_at: '2026-11-16T03:45:00Z',
};
/** 一份「没身份的」本地构建：只有版本号烘进去了，`revision` 这一格压根没写。 */
const LOCAL_BI = {
  station_version: '0.1.72', engine_version: '0.33.0', built_at: '2026-11-16T03:45:00Z',
};

/** 在临时 build-info 上跑一次读法（不碰仓库文件，也不碰镜像内那个位置）。 */
function readFrom(values) {
  const { dir, file } = injectBuildInfo(values);
  try {
    return readStationVersion({ env: { STATION_BUILD_INFO_PATH: file } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 判别位
// ─────────────────────────────────────────────────────────────────────────────
test('#643B-1a：`revision=unknown` ⇒ 本地构建；revision 有值 ⇒ 不是（真/假两支各一条）', () => {
  assert.equal(isLocalBuild({ revision: UNKNOWN }), true, '没有 revision 就是没身份');
  assert.equal(isLocalBuild({ revision: 'b'.repeat(40) }), false, '有 revision 就不是本地构建');
  // 真件对拍：整条读法跑下来，两侧结论必须相反（不许 `isLocalBuild` 与真实读法各说各话）。
  assert.equal(isLocalBuild(readFrom(LOCAL_BI)), true, '没有 revision 字段的 build-info ⇒ 本地构建');
  assert.equal(isLocalBuild(readFrom(RELEASE_BI)), false, '烘了 revision 的 build-info ⇒ 发布件');
});

test('#643B-1b：判别位**只有** revision —— `builtAt` 单独缺不许把真发布件报成本地构建', () => {
  // 方向性判据：把判据改成看 `builtAt` 就必须红在这里（M-b 的靶子）。
  assert.equal(isLocalBuild({ revision: 'b'.repeat(40), builtAt: UNKNOWN }), false,
    '「传了 revision、忘了传构建时刻」是真发布件：报成本地构建就是假红，而假红一次就没人再信这条');
  assert.equal(isLocalBuild({ revision: UNKNOWN, builtAt: '2026-11-16T03:45:00Z' }), true,
    '反过来（有构建时刻、没 revision）仍然是本地构建');
});

test('#643B-1c：脏形状一律按「读不出身份」处理（恒真布尔，绝不抛、绝不 undefined）', () => {
  for (const v of [undefined, null, {}, { revision: '' }, { revision: '   ' },
    { revision: 42 }, { revision: ['x'] }]) {
    assert.equal(isLocalBuild(v), true, `${JSON.stringify(v) ?? String(v)} 读不出身份 ⇒ 按本地构建`);
  }
  assert.equal(typeof isLocalBuild({ revision: 'x' }), 'boolean', '返回值必须是真布尔');
});

// ─────────────────────────────────────────────────────────────────────────────
// ② 日志腿：本地构建恰一条、发布件零条、观测面不承重
// ─────────────────────────────────────────────────────────────────────────────
test('#643B-2a：本地构建 ⇒ 启动日志恰一条，含机器可 grep 的 `local-build` 与 `revision=unknown`', () => {
  const log = logSink();
  const res = warnIfLocalBuild({ readVersion: () => readFrom(LOCAL_BI), log });
  assert.equal(res.local, true);
  assert.equal(log.lines.length, 1, `恰一条，实际 ${log.lines.length} 条`);
  assert.match(log.lines[0], /local-build/, '标记必须在：`docker logs … | grep local-build` 是读数入口');
  assert.match(log.lines[0], /revision=unknown/, '机器读数：点名「revision 这一格是 unknown」');
  assert.match(log.lines[0], /不能当发布件对账|不是发布件/, '要说清后果，不然这声喊没有行动意义');
  assert.equal(res.message, log.lines[0], '返回值与真喊出去的那条同源（不许两份文案）');
});

test('#643B-2b：发布件 ⇒ **一条都不打**（天天喊的告警等于没有告警）', () => {
  const log = logSink();
  const res = warnIfLocalBuild({ readVersion: () => readFrom(RELEASE_BI), log });
  assert.equal(res.local, false);
  assert.deepEqual(log.lines, [], `发布件不该往日志里喊：${JSON.stringify(log.lines)}`);
  assert.ok(!log.lines.some((l) => l.includes('local-build')),
    '`local-build` 这个标记只能是「本地构建」的同义句：发布件顶着它，grep 就不再等于结论');
});

test('#643B-2c：观测面不承重（#515）—— 脏 log / 没 warn / warn 自己抛 / 读版本抛，都不许抛出去', () => {
  const local = () => readFrom(LOCAL_BI);
  assert.doesNotThrow(() => warnIfLocalBuild({ readVersion: local, log: undefined }));
  assert.doesNotThrow(() => warnIfLocalBuild({ readVersion: local, log: {} }));
  assert.doesNotThrow(() => warnIfLocalBuild({ readVersion: local, log: { warn: null } }));
  const broken = logSink({ throwOnWarn: true });
  const res = warnIfLocalBuild({ readVersion: local, log: broken });
  assert.equal(res.local, true, '告警出口挂了也不许改判「这是不是本地构建」');
  assert.equal(broken.lines.length, 1, '喊出去一条（抛在 sink 里由本函数吞掉）');
  // 读版本这条路自己炸 ⇒ 当「读不出身份」处理：仍然只喊一条，仍然不往上抛。
  const boom = logSink();
  const r2 = warnIfLocalBuild({ readVersion: () => { throw new Error('读版本的链路炸了'); }, log: boom });
  assert.equal(r2.local, true, '读不出身份与没有身份，对管理员是同一句话');
  assert.equal(boom.lines.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ 面板字段（值只由服务端推，前端只搬）
// ─────────────────────────────────────────────────────────────────────────────
test('#643B-3a：`aboutPanel()` 顶层 `localBuild` 随 build-info 变，且 `server` 仍全是字符串', async () => {
  const mk = (values) => aboutPanel({
    pool: emptyContainersPool(),
    readVersion: () => readFrom(values),
    log: logSink(),
  });
  const local = await mk(LOCAL_BI);
  const release = await mk(RELEASE_BI);
  assert.equal(local.localBuild, true, '本地构建必须在版本面上自己说出来，不许等人看 revision');
  assert.equal(release.localBuild, false, '发布件要显式 false（不是缺键）：前端据此保持干净');
  for (const panel of [local, release]) {
    assert.equal(typeof panel.localBuild, 'boolean', '真布尔，不是 "true" / 0 / 1');
    assert.ok(Object.values(panel.server).every((v) => typeof v === 'string' && v !== ''),
      `#586 那条「server 每格都是字符串」的不变式不许被本单放宽：${JSON.stringify(panel.server)}`);
  }
  // 顶层键集合：本单只加 `localBuild` 一格，别的键一个不许少（面板的读面是契约 §4.16）。
  for (const key of ['server', 'platformEngine', 'buildInfoPath', 'fdes', 'fdesPresent', 'provenance']) {
    assert.ok(key in local, `既有键 ${key} 被本单弄丢了`);
  }
});

test('#643B-3b：端点 `GET /api/admin/version` 下发真布尔 `localBuild`（两种 build-info 各一次）', async () => {
  const call = async (values) => {
    const { dir, file } = injectBuildInfo(values);
    const pool = new FakePool({
      users: [{ id: ADMIN_ID, login: 'admin', role: 'admin', status: 'active', auth_source: 'local' }],
    });
    const config = {
      cookie: cookieSettings('643-test', 600),
      sessionTtlSeconds: 600, sessionRenewIntervalSeconds: 3600, pendingTokenTtlSeconds: 120,
      totp: { issuer: 'FDE Station', digits: 6, period: 30, window: 1 },
      loginRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, maxEntries: 10 },
      totpRateLimit: { maxFailures: 5, windowMs: 60_000, blockMs: 60_000, perTokenMaxFailures: 5, maxEntries: 10 },
      kdfConcurrency: 1, kdfQueueLimit: 5, kdfQueueTimeoutMs: 1000,
      maxLoginLength: 128, maxPasswordLength: 256,
      staticDir: fs.mkdtempSync(path.join(os.tmpdir(), 'station-643-static-')),
    };
    pool.sessions.push({
      id: 'session-643', user_id: ADMIN_ID, token_hash: hashToken(ADMIN_TOKEN),
      created_at: new Date(), expires_at: new Date(Date.now() + 600_000),
      last_seen_at: new Date(), revoked_at: null,
    });
    const saved = process.env.STATION_BUILD_INFO_PATH;
    process.env.STATION_BUILD_INFO_PATH = file;
    const server = createServer({ pool, config, log: { error() {}, warn() {}, log() {} } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/version`,
        { headers: { cookie: `${config.cookie.name}=${ADMIN_TOKEN}` } });
      assert.equal(res.status, 200);
      return await res.json();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      if (saved === undefined) delete process.env.STATION_BUILD_INFO_PATH;
      else process.env.STATION_BUILD_INFO_PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(config.staticDir, { recursive: true, force: true });
    }
  };

  const local = await call(LOCAL_BI);
  assert.equal(local.localBuild, true, '端点必须把「本地构建」说出来，而不是只让 revision 显示未知');
  assert.equal(typeof local.localBuild, 'boolean', '契约写的是真布尔（前端只认真布尔）');
  assert.deepEqual(local.server, {
    station: '0.1.72', revision: UNKNOWN, builtAt: '2026-11-16T03:45:00Z', source: 'build-info',
  }, '既有 `server` 段的形状一字未动（`deepEqual`：既不许加格也不许改值）');

  const release = await call(RELEASE_BI);
  assert.equal(release.localBuild, false, '发布件要显式 false（缺键 = 「没说」，前端会保持沉默）');
});

// ─────────────────────────────────────────────────────────────────────────────
// ④ 接线锁（源码级：`cli.js` 一跑就 listen + 起九个循环，没有可达的单测入口）
// ─────────────────────────────────────────────────────────────────────────────
test('#643B-4：`cli.js` 的 `serve()` 真调用 `warnIfLocalBuild`，且夹在 loadConfig 与 migrate 之间', () => {
  const src = fs.readFileSync(CLI_SRC, 'utf8');
  assert.match(src, /^import \{[^}]*warnIfLocalBuild[^}]*\} from '\.\/version-info\.js';$/m,
    '必须显式 import（漏 import 就是「接线锁绿着但运行时 ReferenceError」的形状）');
  const at = src.indexOf('async function serve()');
  assert.ok(at >= 0, '找不到 serve() 的起点（接线锁的坐标先失效）');
  const body = src.slice(at, at + 3000); // serve() 的开头一段就够：三个坐标都在前半段
  // **剥掉注释行再比位置**：这段里有一段写「为什么在 migrate 之前」的注释，正文里就写着
  // `loadConfig()` / `migrate()` 这两个字面量 —— 不剥就会先命中注释（实测拿到注释里的坐标，
  // 位置断言方向相反 ⇒ 接线锁本身变成假红）。
  const code = body.replace(/^[ \t]*\/\/.*$/gm, '');
  const call = code.indexOf('warnIfLocalBuild(');
  const cfg = code.indexOf('loadConfig()');
  const mig = code.indexOf('migrate(');
  assert.ok(call >= 0, 'serve() 里没有 warnIfLocalBuild() 调用 ⇒ 本地构建不会自曝');
  assert.ok(cfg >= 0 && mig >= 0, '坐标读不到（loadConfig / migrate 改名了？回来对齐这条判据）');
  assert.ok(cfg < call && call < mig,
    `位置必须在 loadConfig() 之后、migrate() 之前（读到 config 才知道环境，而 migrate 失败会直接 ` +
    `exit(1)）：实际 loadConfig@${cfg} / warn@${call} / migrate@${mig}`);
  // 注意 `slice` 的**负数下标是从尾部数的**：写 `code.slice(call - 200, …)` 在 call < 200 时会
  // 拿到空串（本单实测踩到：接线锁红在 `actual: ''`，而不是红在「没传 log」）。
  assert.match(code.slice(Math.max(0, call - 200), call + 120), /warnIfLocalBuild\(\{[^}]*\blog\b/,
    '调用必须显式把 log sink 传进去（不传就走 console 默认，测试与运维都无从重定向）');
});
