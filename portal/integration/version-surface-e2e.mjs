// issue #603：把「版本三格」的**真机** e2e 固化进仓库（读面本身是 #586，契约见 docs/api/portal.md §4.16）。
//
// **这条脚本存在的理由不是「再测一遍字段」，而是那条真事故**：发 v0.1.69 时宿主工作树停在 0.1.68，
// `docker compose build station-portal` 烘的就是那份旧树 ⇒ 真机上 FDE 报 0.1.69、portal 报 0.1.68
// 分裂一小时，而**没有任何机器判据能发现**。单测（`portal/test/version-surface.test.js`）钉的是
// 「读法只有一条」；它证不了**真机上那份镜像里到底烘了什么**。只有「容器里的 `/app/build-info.json`
// ↔ `/api/health` ↔ `/api/admin/version` ↔ 管理台「关于」面板」四处的数字**逐格相等**才是那条事故
// 的机器判据。所以本文件的骨头不是断言字段存在，而是 `C1`（容器 ⇄ API 逐格对账）与 `U1`（页面显示的
// 就是 API 给的那几个数）。
//
// 三条腿（**缺环境一律 skip 并打印原因**：不许静默 pass，也不许把「没环境」报成「产品坏了」）：
//   · `API 腿`（默认跑）   `A1` `GET /api/health` 的 version 三格 + **不许有引擎格**；
//                          `A2` 登录 → `GET /api/admin/version` 三格齐 + `provenance` 必须由 `source`
//                          一致推导；`A3` `fdes[]` 每行都带 `containers.agent_version` / `provision` 标注。
//   · `容器腿`（docker 可用时跑）`C1` `docker exec <portal> cat /app/build-info.json` 三格与 `A2` **逐格相等**，
//                          且 `buildInfoPath` 就是那条路径。← 本单的骨头。
//   · `UI 腿`（`E2E_UI=1` 且 playwright 容器在跑时跑）`U1` 真浏览器登管理台进 `#/admin/about`：三区块、
//                          三格值、每台 FDE 的快照标注、无横向溢出、登录成功后无控制台错误 + 截图。
//
// **与 wp2a/wp3b/… 的差别（刻意的）**：那几支是「起一套隔离栈再验」（`lib/isolated-env.mjs` 那套重型
// 护栏，#226/#268）。本单验的对象**就是这台机器上活着的那套栈**——版本三格是「现在跑的是哪份构建」的
// 读数，把它搬进一个新建的隔离栈去验就失去意义了（新栈必然是当前工作树烘的，永远自洽）。所以这里
// 没有任何 compose 操作，只有读。红线：**不改产品代码**，本单只加测试 + 一条 npm script + 一处文档。
//
// 跑法（口径全文见 docs/api/portal.md §4.16 末尾）：
//   npm run test:integration:version                              # API 腿 + 容器腿
//   E2E_UI=1 npm run test:integration:version                     # 再加 UI 腿
//   PORTAL_URL=http://127.0.0.1:1 npm run test:integration:version # 没栈 ⇒ 全 skip，rc 仍是 0
//
// 要知道的坑（今天手搓时踩过，别再踩）：
//   1. 登录体字段是 **`login`** 不是 `username`（`portal/src/http.js` handleLoginStep1）。dev 的 `admin`
//      没注册 TOTP ⇒ 口令直通**直接发会话 cookie**（没有第二步）。账号若开了 TOTP/邮箱码，本脚本
//      **skip 而不是硬失败**（那是环境形状，不是产品坏了）。
//   2. 口令**不入库**：只从 `~/.config/creds/station-dev-password-file` 读（AGENTS.md §4.1）。为了把它
//      送进 playwright 容器，会往容器 `/tmp` 写一份临时文件（里面有口令）并尽力删掉；别把它 print 出来。
//   3. `/api/health` 的 `version` **只有三格**，没有 `engine`/`platformEngine`（#586 刻意：公开零鉴权
//      端点里并排两个引擎数一定被读错）。`A1` 就是钉这一条的**负断言**，别顺手「补上」引擎格。
//   4. `provenance.*` 是**由 `source` 推导的**，不是常量（复验阻断）。旧镜像里没烘 build-info.json 时
//      读面会退到 `package.json`，此时标成 `build-info.json` 就是谎报 ⇒ `A2` 断的是**推导关系**，
//      不是断「一定是 build-info.json」。
//   5. `containers.agent_version` 是**派生副本**（provision/心跳那一刻），不是「这个镜像现在是什么」
//      ⇒ 面板必须标 `provision-time snapshot`，`U1` 断标签数 ≥ FDE 行数。
//   6. UI 腿把 playwright 留在**容器里**（`/app/node_modules/playwright`），仓库**不**加这个依赖。
//      登录前 SPA 会问一次 `GET /api/me`（匿名 ⇒ 401），那是引导噪声：控制台错误**从登录成功后开始计**。
//   7. 走 docker 包装层时命令串**不许含换行**（wp2a 头注 F-6：换行会变成字面 `\n` 两字符）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// 坐标（全部 env 可覆盖；缺省值就是这台部署机的 dev 栈）
// ---------------------------------------------------------------------------
const PORTAL = (process.env.PORTAL_URL || `http://127.0.0.1:${process.env.PORTAL_HOST_PORT || '18080'}`).replace(/\/$/, '');
const PORTAL_CONTAINER = process.env.PORTAL_CONTAINER || 'station-portal';
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const PASSWORD_FILE = (process.env.ADMIN_PASSWORD_FILE || '~/.config/creds/station-dev-password-file')
  .replace(/^~/, os.homedir());
/** portal 镜像内 build-info 的位置（`portal/src/version-info.js` 的 `BUILD_INFO_PATH`；产品不许改，测试这边跟着钉）。 */
const BUILD_INFO_PATH = '/app/build-info.json';
/** `readBuildInfo()` 的 `source` → 面板来源标注（与 `provenanceFor()` 同表；这里是**独立复算**，不是抄产品常量）。 */
const PROVENANCE_BY_SOURCE = { 'build-info': 'build-info.json', package: 'package.json', env: 'env' };
const UI_ENABLED = process.env.E2E_UI === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
const UI_BASE = (process.env.E2E_UI_BASE || 'https://admin.fde.erix.vip:9443').replace(/\/$/, '');
const SHOT_CONTAINER = process.env.E2E_SHOT_CONTAINER || '/tmp/version-surface-e2e.png';
const SHOT_HOST = process.env.E2E_SHOT_HOST || '/tmp/version-surface-e2e.png';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** `docker` 直连（开发机在 docker 组里）与 `sg docker -c`（组未生效的会话）两条路，探一次记下来。 */
let dockerPrefix = null;
function dockerCmd(args) {
  if (/\n|\r/.test(args)) throw new Error(`docker 参数不许含换行（sg 层会变成字面 \\n，见 wp2a 头注 F-6）: ${JSON.stringify(args)}`);
  const cmd = `docker ${args}`;
  return dockerPrefix === 'sg' ? `sg docker -c ${JSON.stringify(cmd)}` : cmd;
}
function dockerProbe() {
  if (dockerPrefix) return true;
  for (const mode of ['plain', 'sg']) {
    try {
      execSync(mode === 'sg' ? 'sg docker -c "docker version -f {{.Server.Version}}"' : 'docker version -f {{.Server.Version}}',
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000, cwd: REPO_ROOT });
      dockerPrefix = mode === 'sg' ? 'sg' : 'plain';
      return true;
    } catch (err) {
      if (mode === 'sg') {
        const why = String(err?.stderr || err?.message || err).split('\n')[0].slice(0, 160);
        return { reason: `docker 不可用（直连与 \`sg docker -c\` 都不行）：${why}` };
      }
    }
  }
  return false;
}
function dockerRun(args, { timeout = 90_000 } = {}) {
  return execSync(dockerCmd(args), { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout, cwd: REPO_ROOT });
}
/** 尽力而为的清理（临时文件删不掉不算失败，但要说一声——那是带着口令的文件）。 */
function tryQuiet(fn) {
  try { fn(); return true; } catch (err) { console.log(`# 清理没成功（不影响判据）：${String(err?.message || err).split('\n')[0]}`); return false; }
}
function containerRunning(name) {
  try {
    return dockerRun(`inspect -f "{{.State.Running}}" ${name}`, { timeout: 20_000 }).trim() === 'true';
  } catch { return false; }
}

/** fetch → `{status,json,cookies}`：拿不到 HTTP 响应才抛（那才是「环境没起」的形状）。 */
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 8_000, retries = 2 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* 只报状态码，不在这里猜形状 */ }
      const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
      return { status: res.status, json, text, cookies: raw.filter(Boolean).map((c) => c.split(';')[0]) };
    } catch (err) {
      last = err;
      if (i < retries) await sleep(500 * (i + 1)); // 127.0.0.1 上偶发的连接抖动重试一次，别立刻算「没栈」
    }
  }
  const cause = last?.cause?.code || last?.cause?.message || last?.message || String(last);
  const e = new Error(`${url} 连不上：${cause}`);
  e.transport = true;
  throw e;
}

function readPassword() {
  if (!fs.existsSync(PASSWORD_FILE)) return null;
  const value = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  return value === '' ? null : value;
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const UNKNOWNISH = (v) => !isNonEmptyString(v) || v.trim() === 'unknown';

// ---------------------------------------------------------------------------
// 探测：把**所有** HTTP/docker 读面在模块加载时取一次，三条腿共用同一份快照
// （同一份快照 = A2/A3/C1/U1 互相比的是同一时刻的数字，不会因为中途有人重建容器而假红）。
// 探测阶段**只读不断言**：语义对不对一律留在 test 里判，这里只回答「读得到吗」。
// ---------------------------------------------------------------------------
const probe = {
  reasons: {},           // leg → skip 原因（没有这一腿的 key = 该腿要跑）
  health: null,          // GET /api/health
  version: null,         // GET /api/admin/version（A2 的响应体）
  loginStatus: null,     // 登录响应状态码（A2 要断它是 200）
  loginBody: null,
  buildInfo: null,       // 容器内 /app/build-info.json
  versionNoBaseline: null, // /api/admin/version 不是 200 时的那句话（C1/U1 靠它说「为什么没有基准」）
};

async function gather() {
  // ── API 腿：health 是这一腿的「有没有栈」探针 ──
  try {
    probe.health = await fetchJson(`${PORTAL}/api/health`);
  } catch (err) {
    probe.reasons.apiA1 = `portal 不可达（${PORTAL} 的 /api/health 连不上：${err.message}）⇒ 栈没起，或 PORTAL_URL/PORTAL_HOST_PORT 指错了`;
    probe.reasons.apiAdmin = probe.reasons.apiA1;
    probe.reasons.container = `${probe.reasons.apiA1} ⇒ 容器腿要和 A2 的读数逐格对账，没有基准`;
    probe.reasons.ui = `${probe.reasons.apiA1} ⇒ UI 腿同理（且它还得页面显示同一份数字）`;
    return;
  }
  // ── A2/A3：要凭据，且这个账号得能**口令直通** ──
  const password = readPassword();
  if (password === null) {
    const why = `缺管理员口令文件 ${PASSWORD_FILE}（AGENTS.md §4.1：明文不入库，轮换就改这个文件）`;
    probe.reasons.apiAdmin = why;
    probe.reasons.container = `${why} ⇒ 容器腿没有对账基准`;
    probe.reasons.ui = `${why} ⇒ UI 腿要登管理台`;
    return;
  }
  let login;
  try {
    login = await fetchJson(`${PORTAL}/api/auth/login`, { method: 'POST', body: { login: ADMIN_LOGIN, password }, timeoutMs: 15_000 });
  } catch (err) {
    probe.reasons.apiAdmin = err.message;
    probe.reasons.container = `${err.message} ⇒ 容器腿没有对账基准`;
    probe.reasons.ui = `${err.message} ⇒ UI 腿要登管理台`;
    return;
  }
  probe.loginStatus = login.status;
  probe.loginBody = login.json;
  if (login.status !== 200 || login.cookies.length === 0) {
    // 口令不匹配 / 有第二因素（pending_token 但没有 cookie）/ 限流 ⇒ 环境形状，不是产品坏了。
    const code = login.json?.error?.code;
    probe.reasons.apiAdmin = `登录没拿到会话 cookie（HTTP ${login.status}${code ? ` ${code}` : ''}`
      + `${login.json?.pending_token ? '，响应带 pending_token ⇒ 这个账号开了第二因素，本脚本只会口令直通' : ''}`
      + `）⇒ 口令不对/已轮换，或 admin 需要 TOTP/邮箱码`;
    probe.reasons.container = `${probe.reasons.apiAdmin} ⇒ 容器腿没有对账基准`;
    probe.reasons.ui = `${probe.reasons.apiAdmin} ⇒ UI 腿要登管理台`;
    return;
  }
  try {
    const v = await fetchJson(`${PORTAL}/api/admin/version`, { headers: { Cookie: login.cookies.join('; ') }, timeoutMs: 15_000 });
    probe.version = { status: v.status, json: v.json, text: v.text };
    if (v.status !== 200) {
      // 200 以外都**不断在探测里**：留给 A2 报「HTTP 期望 200 得到 xxx」，这里只是没有可用读数。
      probe.versionNoBaseline = `HTTP ${v.status}：${(v.text || '').slice(0, 120)}`;
    }
  } catch (err) {
    probe.reasons.container = `${err.message} ⇒ 容器腿没有对账基准`;
    probe.reasons.ui = `${err.message} ⇒ UI 腿要用 API 读数当期望值`;
  }
  // ── 容器腿：docker 可用 + 容器在跑 + 那份文件读得出 ──
  const d = dockerProbe();
  if (d !== true) {
    const why = typeof d === 'object' ? d.reason : 'docker 不可用';
    probe.reasons.container = why;
  } else if (!containerRunning(PORTAL_CONTAINER)) {
    probe.reasons.container = `容器 ${PORTAL_CONTAINER} 不在跑（PORTAL_CONTAINER 可指到别的栈）`;
  } else {
    try {
      const out = dockerRun(`exec ${PORTAL_CONTAINER} cat ${BUILD_INFO_PATH}`, { timeout: 30_000 });
      probe.buildInfo = JSON.parse(out);
    } catch (err) {
      const why = String(err?.stdout || err?.stderr || err?.message || err).split('\n')[0].slice(0, 200);
      probe.reasons.container = `读不到 ${PORTAL_CONTAINER}:${BUILD_INFO_PATH}`
        + `（本 PR 之前烘的 portal 镜像里**没有**这个文件 ⇒ 这正是 A2 该说 source=package 的时候）：${why}`;
    }
  }
  // ── UI 腿：显式开开关 + playwright 容器在跑且里面有 playwright（仓库故意不加这个依赖） ──
  if (!UI_ENABLED) {
    probe.reasons.ui = 'UI 腿要点名才跑：E2E_UI=1 npm run test:integration:version（真浏览器要几十秒，且得有个 playwright 容器）';
  } else if (!containerRunning(PW_CONTAINER)) {
    probe.reasons.ui = `E2E_UI=1 但 playwright 容器 ${PW_CONTAINER} 不在跑（PLAYWRIGHT_CONTAINER 可指到别的）`;
  } else {
    try {
      dockerRun(`exec ${PW_CONTAINER} sh -c "test -f ${PW_MODULE}"`, { timeout: 30_000 });
    } catch {
      probe.reasons.ui = `容器 ${PW_CONTAINER} 里没有 ${PW_MODULE}（UI 腿用容器里的 playwright，仓库不加这个依赖）`;
    }
  }
}
await gather();

// 每腿一行，**跑不跑都说话**（静默 pass 是本单红线之一）。
for (const [leg, label] of [['apiA1', 'A1 /api/health'], ['apiAdmin', 'A2+A3 /api/admin/version'], ['container', 'C1 容器内 build-info'], ['ui', 'U1 管理台「关于」页']]) {
  console.log(probe.reasons[leg] ? `[version-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}` : `[version-e2e] leg=${leg} (${label}) 开跑`);
}

/** 有可用读数就返回它，没有就当场以「环境缺」收尾（skip + 打印原因），**不**算失败也不算通过。 */
function need(t, leg, value) {
  const reason = probe.reasons[leg];
  if (reason || value === null || value === undefined) {
    const why = reason || `探测阶段没拿到 ${leg} 的读数`;
    t.diagnostic(`SKIP (${leg})：${why}`);
    t.skip();
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// API 腿
// ---------------------------------------------------------------------------
test('A1 `GET /api/health`：version 三格非空、status=ok，且**不许**有引擎格（#586 的公开端点形状）',
  { skip: probe.reasons.apiA1 || false, timeout: 60_000 }, async (t) => {
    const health = need(t, 'apiA1', probe.health);
    if (!health) return;
    assert.equal(health.status, 200, `/api/health 期望 200（503 = migration_failed，栈没就绪），得到 ${health.status}：${health.text.slice(0, 160)}`);
    const body = health.json ?? {};
    assert.equal(body.status, 'ok', '`status` 必须是 "ok"');

    const v = body.version;
    assert.ok(v && typeof v === 'object', `响应里根本没有 version 块（#586 加的 additive 块没了？body=${health.text.slice(0, 200)}）`);
    for (const cell of ['station', 'revision', 'builtAt']) {
      assert.ok(isNonEmptyString(v[cell]), `version.${cell} 必须是非空字符串（缺也是字面量 unknown，不许 undefined/空串），得到 ${JSON.stringify(v[cell])}`);
    }
    // `station` 不能是 unknown：那一格从镜像内 `package.json` 读，读不到就是**烘失败**（`portal/Dockerfile`
    // 末尾那层会直接 exit 1）。而 `revision`/`built_at` 在本地**可以是** unknown（compose 不传那两个 ARG
    // 就是 unknown，口径见 deploy/docker-compose.yml:114-120；只有 CI/发布路径不许），所以它们只报不红。
    assert.notEqual(v.station, 'unknown', 'version.station 是 "unknown" ⇒ 镜像里没烘进 station_version（烘失败或旧镜像）');
    for (const cell of ['revision', 'builtAt']) {
      if (v[cell] === 'unknown') t.diagnostic(`提示：version.${cell}=unknown（本地 compose build 没带 STATION_REVISION/STATION_BUILD_DATE 就是这形状，不是 bug；发布路径由 ci.yml 的 portal tripwire 拦）`);
    }
    // 负断言（**别顺手补**）：公开、零鉴权的端点里并排两个引擎数一定被读错 ⇒ #586 刻意只给三格。
    assert.ok(!('engine' in v), `version 里冒出了 engine=${JSON.stringify(v.engine)}——公开端点不带引擎格是刻意的（portal.md §4.16）`);
    assert.ok(!('platformEngine' in v), 'version 里冒出了 platformEngine（同上）');
    assert.deepEqual(Object.keys(v).slice().sort(), ['builtAt', 'revision', 'station'],
      `version 块的键必须恰好是三格，得到 ${JSON.stringify(Object.keys(v))}`);
  });

test('A2 登录 → `GET /api/admin/version`：三格齐、source 合法、provenance 与 source **一致推导**、buildInfoPath 非空',
  { skip: probe.reasons.apiAdmin || false, timeout: 90_000 }, async (t) => {
    assert.equal(probe.loginStatus, 200, `登录步 1 期望 200，得到 ${probe.loginStatus}：${JSON.stringify(probe.loginBody).slice(0, 200)}`);
    const version = need(t, 'apiAdmin', probe.version);
    if (!version) return;
    assert.equal(version.status, 200, `/api/admin/version 期望 200，得到 ${version.status}：${(version.text || '').slice(0, 200)}（401 = 会话没带上；403 = 这个账号不是 admin）`);

    const j = version.json ?? {};
    const server = j.server ?? {};
    for (const cell of ['station', 'revision', 'builtAt']) {
      assert.ok(isNonEmptyString(server[cell]), `server.${cell} 必须是非空字符串，得到 ${JSON.stringify(server[cell])}`);
    }
    assert.notEqual(server.station, 'unknown', 'server.station 是 "unknown" ⇒ 这一份构建没读出 station_version（镜像没烘或读面坏了）');
    assert.ok(isNonEmptyString(j.platformEngine?.version), `platformEngine.version 必须是非空字符串，得到 ${JSON.stringify(j.platformEngine)}`);

    assert.ok(['build-info', 'package', 'unknown'].includes(server.source),
      `server.source 只能是 build-info/package/unknown（env 在 portal 入口就被屏蔽），得到 ${JSON.stringify(server.source)}`);
    // **推导关系**而不是常量：镜像里没烘 build-info 时读面会退到 package.json，此时标 build-info.json 就是谎报。
    const expected = PROVENANCE_BY_SOURCE[server.source] ?? 'unknown';
    assert.equal(j.provenance?.server, expected,
      `provenance.server 必须由 source=${JSON.stringify(server.source)} 推成 ${JSON.stringify(expected)}，得到 ${JSON.stringify(j.provenance?.server)}`);
    if (server.source === 'package') {
      assert.notEqual(j.provenance?.server, 'build-info.json', 'source=package 却把来源标成 build-info.json ⇒ 谎报（旧镜像里根本没烘那个文件）');
    }
    if (server.source === 'unknown') {
      for (const [cell, got] of [['server', j.provenance?.server], ['platformEngine', j.provenance?.platformEngine]]) {
        assert.ok(!/\.json$|\.js$/.test(String(got)), `source=unknown 时 provenance.${cell} 不许指向任何具体文件，得到 ${JSON.stringify(got)}`);
      }
    }
    // 两格同源（一次读取只出一个 source），但引擎那格多一道「有值才谈来源」。
    const engineUnknown = UNKNOWNISH(j.platformEngine?.version);
    assert.equal(j.provenance?.platformEngine, engineUnknown ? 'unknown' : expected,
      `provenance.platformEngine：引擎值 ${engineUnknown ? '是 unknown ⇒ 来源也只能是 unknown' : `与 server 同源 ⇒ ${expected}`}，得到 ${JSON.stringify(j.provenance?.platformEngine)}`);
    // 路径可见性：三个注入旋钮能改它 ⇒ 「读了哪条路径」必须透出来（它证明不了「读到了」）。
    assert.ok(isNonEmptyString(j.buildInfoPath), `buildInfoPath 必须非空（实际读过的那条路径），得到 ${JSON.stringify(j.buildInfoPath)}`);
    // 「读不到」与「没有 FDE」是两件事（#350 同口径）：真机 DB 在，这一段必须读得到。
    assert.equal(j.fdesPresent, true, `fdesPresent 必须是 true（false ⇒ containers 查失败，面板要说「读不到」，此时对账没有基准）`);
  });

test('A3 `fdes[]` 每行都标 `versionSource=containers.agent_version` + `snapshot=provision`（第三格是派生副本）',
  { skip: probe.reasons.apiAdmin || false, timeout: 60_000 }, async (t) => {
    const version = need(t, 'apiAdmin', probe.version);
    if (!version || version.status !== 200) {
      if (version && version.status !== 200) {
        const why = `/api/admin/version 不是 200（${probe.versionNoBaseline || `HTTP ${version.status}`}）`;
        t.diagnostic(`SKIP (apiAdmin)：${why}`);
        t.skip();
      }
      return;
    }
    const j = version.json ?? {};
    assert.ok(Array.isArray(j.fdes), `fdes 必须是数组，得到 ${JSON.stringify(j.fdes)?.slice(0, 160)}`);
    if (j.fdes.length === 0) {
      // 真空栈（刚 migrate 完没开过户）是合法形状 ⇒ 断言变成空转，说明白，别让它看起来像「验过了」。
      t.diagnostic('SKIP (A3)：这台栈上还没有 FDE 容器（fdes=[]）⇒ 「每行都带标注」这条没有对象，不算验过');
      t.skip();
      return;
    }
    assert.equal(j.provenance?.fdes, 'containers.agent_version', `provenance.fdes 要说清第三格的来源，得到 ${JSON.stringify(j.provenance?.fdes)}`);
    assert.equal(j.provenance?.fdesSnapshot, 'provision', `provenance.fdesSnapshot 必须是 "provision"，得到 ${JSON.stringify(j.provenance?.fdesSnapshot)}`);
    for (const row of j.fdes) {
      const where = `fde ${JSON.stringify(row?.name)}`;
      assert.equal(row.versionSource, 'containers.agent_version', `${where} 的 versionSource 必须是 containers.agent_version（派生副本），得到 ${JSON.stringify(row.versionSource)}`);
      assert.equal(row.snapshot, 'provision', `${where} 的 snapshot 必须是 provision（「上次被报告时跑的是什么」，不是「这个镜像现在是什么」）`);
      assert.ok(isNonEmptyString(row.name), `${where} 的 name 必须非空`);
    }
    // 派生副本**与平台侧那一格是两个不同的数**，不许互抄：抄了就是 v0.1.69 那起事故的反向形状。
    const engine = version.json?.platformEngine?.version;
    const differing = j.fdes.filter((row) => row.agentVersion !== engine);
    t.diagnostic(`引擎格（portal 镜像）=${engine}；${j.fdes.length} 台 FDE 里有 ${differing.length} 台的 agent_version 与它不同`
      + `${differing.length ? `（${differing.map((r) => `${r.name}=${r.agentVersion}`).join(', ')}）——分裂本身不是错，快照口径本来就是那一刻的值` : ''}`);
  });

// ---------------------------------------------------------------------------
// 容器腿（本单的骨头）
// ---------------------------------------------------------------------------
test('C1 容器内 `cat /app/build-info.json` 与 `/api/admin/version` **逐格相等**，且 buildInfoPath 就是那条路径',
  { skip: probe.reasons.container || false, timeout: 120_000 }, async (t) => {
    const buildInfo = need(t, 'container', probe.buildInfo);
    const version = need(t, 'container', probe.version);
    if (!buildInfo || !version) return;
    if (version.status !== 200 || !version.json?.server) {
      const why = `A2 没有可用读数（${probe.versionNoBaseline || `HTTP ${version?.status}`}）⇒ 无基准可对`;
      t.diagnostic(`SKIP (container)：${why}`);
      t.skip();
      return;
    }
    const server = version.json.server;
    // 逐格对账。**这四行就是 v0.1.69 那起事故的机器判据**：镜像里烘的与进程报的必须同一个数。
    for (const [cell, apiValue, fileKey] of [
      ['station', server.station, 'station_version'],
      ['revision', server.revision, 'revision'],
      ['builtAt', server.builtAt, 'built_at'],
    ]) {
      assert.ok(isNonEmptyString(buildInfo[fileKey]), `容器里 ${BUILD_INFO_PATH} 的 ${fileKey} 必须非空（缺也是字面量 unknown），得到 ${JSON.stringify(buildInfo[fileKey])}（整份=${JSON.stringify(buildInfo).slice(0, 200)}）`);
      assert.equal(buildInfo[fileKey], apiValue,
        `分裂！容器内 ${BUILD_INFO_PATH} 的 ${fileKey}=${JSON.stringify(buildInfo[fileKey])}，而 /api/admin/version 的 server.${cell}=${JSON.stringify(apiValue)}`
        + '（v0.1.69 事故形状：烘的是旧工作树 ⇒ 界面上报的构建不是镜像里那份）');
    }
    // 同一份文件里的第四格：面板那一格显示的必须是它，不是宿主 `package.json`。
    if (!UNKNOWNISH(buildInfo.engine_version)) {
      assert.equal(version.json.platformEngine?.version, buildInfo.engine_version,
        `平台侧引擎格=${JSON.stringify(version.json.platformEngine?.version)} 而镜像里 engine_version=${JSON.stringify(buildInfo.engine_version)}（不同源 ⇒ 有人在别处读引擎版本）`);
    }
    assert.equal(server.source, 'build-info', `容器里明明读到了 ${BUILD_INFO_PATH}，source 却说 ${JSON.stringify(server.source)} ⇒ 读的不是它`);
    assert.equal(version.json.buildInfoPath, BUILD_INFO_PATH, `buildInfoPath 必须就是 ${BUILD_INFO_PATH}，得到 ${JSON.stringify(version.json.buildInfoPath)}（被注入旋钮改过？那面板上的标签就不是「镜像内构建产物」）`);
    t.diagnostic(`镜像内三格 = station ${buildInfo.station_version} / revision ${String(buildInfo.revision).slice(0, 12)} / built_at ${buildInfo.built_at}；引擎 ${buildInfo.engine_version}（四处一致）`);
  });

// ---------------------------------------------------------------------------
// UI 腿
// ---------------------------------------------------------------------------
/**
 * 跑在 playwright 容器里的采集脚本（**自包含**，仓库不加 playwright 依赖）。
 * 它只**收集事实**并打一行 `REPORT:<json>`；断言全在外面——失败信息才有用（在容器里 assert
 * 只能拿到一句 `expect(...)` 的字符串）。整份 JSON 从 `argv[2]` 的临时文件读，口令不走命令行
 * （`ps` 里会露出来），也不 print。
 */
const CONTAINER_SCRIPT = String.raw`
import { chromium } from '__PW_MODULE__';
import { readFileSync, statSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = { fatal: null, login: {}, page: {}, consoleErrors: [], consoleErrorsBeforeLogin: 0, shotBytes: 0 };
const grab = [];
let browser = null;
try {
  browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox'] });
  // locale 钉死 en：三区块标题与快照标签的**英文字面量**是断言对象，而前端按 navigator.language
  // 选语言（i18n/index.ts detectLocale），不钉就会随容器浏览器语言变成中文 ⇒ 假红。
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'en-US', ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') grab.push(m.text()); });
  page.on('pageerror', (e) => grab.push('pageerror: ' + e.message));

  await page.goto(cfg.base + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#loginName', { timeout: 20_000 });
  await page.fill('#loginName', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type=submit]');
  // 登录表单消失 = 已经离开 /login（成功）；随后落点由 hash 记录，成功与否由外层看 hash 判。
  await page.waitForFunction(() => !document.querySelector('#loginPass'), null, { timeout: 20_000 });
  r.login.hash = await page.evaluate(() => location.hash);
  // 登录前 SPA 必问一次 GET /api/me（匿名 ⇒ 401），那是引导噪声、和「关于」页无关：从此刻起才计错误。
  r.consoleErrorsBeforeLogin = grab.length;
  grab.length = 0;

  await page.goto(cfg.base + '/#/admin/about', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-test="about-server"], [data-test="about-error"], [data-test="about-not-loaded"]', { timeout: 25_000 });
  // 面板是 onMounted 才请求的（懒挂载）；等它把三区块渲染出来（或明确报错）。
  await page.waitForFunction(() => !!document.querySelector('[data-test="about-error"]')
    || (!!document.querySelector('[data-test="about-server"]') && !!document.querySelector('[data-test="about-fdes"]')), null, { timeout: 25_000 });

  r.page = await page.evaluate(() => {
    const txt = (sel) => { const el = document.querySelector(sel); return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null; };
    const count = (sel) => document.querySelectorAll(sel).length;
    return {
      hash: location.hash,
      text: document.body.innerText,
      sections: { server: count('[data-test="about-server"]'), engine: count('[data-test="about-engine"]'), fdes: count('[data-test="about-fdes"]') },
      serverStation: txt('[data-test="server-station"]'),
      serverRevision: txt('[data-test="server-revision"]'),
      serverBuiltAt: txt('[data-test="server-built-at"]'),
      serverSource: txt('[data-test="server-source"]'),
      serverPath: txt('[data-test="server-build-info-path"]'),
      engineVersion: txt('[data-test="engine-version"]'),
      engineSource: txt('[data-test="engine-source"]'),
      fdeRows: count('[data-test="fde-item"]'),
      snapshotLabels: count('[data-test="fde-snapshot"]'),
      fdeNames: [...document.querySelectorAll('[data-test="fde-name"]')].map((e) => e.textContent.trim()),
      fdeVersions: [...document.querySelectorAll('[data-test="fde-agent-version"]')].map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()),
      aboutError: txt('[data-test="about-error"]'),
      aboutUnreadable: txt('[data-test="fdes-unreadable"]'),
      scrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
      overflowing: [...document.querySelectorAll('body *')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 2)
        .slice(0, 5).map((el) => el.tagName + '.' + String(el.className ?? '').slice(0, 40)),
    };
  });
  await page.screenshot({ path: cfg.shotPath, fullPage: true });
  try { r.shotBytes = statSync(cfg.shotPath).size; } catch { r.shotBytes = 0; }
  r.consoleErrors = grab.slice(0, 20);
} catch (err) {
  r.fatal = String(err?.message ?? err).split('\n')[0].slice(0, 300);
  r.consoleErrors = grab.slice(0, 20);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 收台失败不算判据 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
process.exit(0);
`;

test('U1 真浏览器进 `#/admin/about`：三区块 + 三格显示的就是 API 的数 + 每台 FDE 带快照标注 + 无溢出 + 登录成功后无控制台错误',
  { skip: probe.reasons.ui || false, timeout: 420_000 }, async (t) => {
    const version = need(t, 'ui', probe.version);
    if (!version || version.status !== 200 || !version.json?.server) {
      const why = version ? `A2 没有可用读数（${probe.versionNoBaseline || `HTTP ${version.status}`}）⇒ 页面该显示什么没有基准` : 'A2 没跑';
      t.diagnostic(`SKIP (ui)：${why}`);
      t.skip();
      return;
    }
    const password = readPassword();
    if (password === null) { t.diagnostic(`SKIP (ui)：缺口令文件 ${PASSWORD_FILE}`); t.skip(); return; }

    const api = version.json;
    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `version-surface-e2e-${uid}.mjs`);
    const cfgHost = path.join(os.tmpdir(), `version-surface-e2e-${uid}.json`);
    const scriptIn = `/tmp/version-surface-e2e-${uid}.mjs`;
    const cfgIn = `/tmp/version-surface-e2e-${uid}.json`;
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    // 口令 + 期望值走文件进容器（命令行会被 `ps` 抄走）；expect 里是 API 刚报的数，页面必须显示同一批。
    fs.writeFileSync(cfgHost, JSON.stringify({
      base: UI_BASE, login: ADMIN_LOGIN, password, shotPath: SHOT_CONTAINER,
      expect: {
        station: api.server.station,
        revision: api.server.revision,
        engine: api.platformEngine?.version,
        buildInfoPath: api.buildInfoPath,
        fdeNames: (api.fdes ?? []).map((row) => row.name),
      },
    }), { mode: 0o600 });

    try {
      dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`, { timeout: 60_000 });
      dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`, { timeout: 60_000 });
      const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
      const m = out.match(/REPORT:(\{.*\})/);
      assert.ok(m, `容器里的采集脚本没交出 REPORT（tail=${out.slice(-400)}）`);
      const report = JSON.parse(m[1]);

      // 导航/渲染挂了分两类：压根没到页面（DNS/TLS/入口挂了 = 环境）说 skip，到了页面却没渲染 = 产品坏了。
      if (report.fatal && !report.page?.text) {
        const why = report.fatal;
        if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(why)) {
          t.diagnostic(`SKIP (ui)：管理台入口 ${UI_BASE} 从容器里到不了：${why}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器里没跑通：${why}（登录态=${JSON.stringify(report.login)}，控制台错误=${report.consoleErrors.slice(0, 3).join(' / ')}）`);
      }
      assert.equal(report.page.aboutError, null, `「关于」面板报了错误行：${JSON.stringify(report.page.aboutError)}（登录没带上会话？看 report=${JSON.stringify(report).slice(0, 400)}）`);
      assert.match(String(report.page.hash), /#\/admin\/about$/, `没落在「关于」页上，hash=${JSON.stringify(report.page.hash)}（路由或 host 闸动了？router.ts 的 admin-about）`);

      // ① 三区块都在，且标题是**那一句话**（三格必须各自有标签，#586 的全部意义就是别再让人猜「这是哪个引擎」）。
      assert.deepEqual(report.page.sections, { server: 1, engine: 1, fdes: 1 }, `三区块应当各渲染一次，得到 ${JSON.stringify(report.page.sections)}`);
      const text = String(report.page.text ?? '');
      for (const title of ['Server (portal image)', 'Platform engine', 'Engine per FDE']) {
        assert.ok(text.includes(title), `页面里没有区块标题「${title}」（语言没钉成 en？标题表 i18n/locales/en.ts 的 admin.about）`);
      }
      assert.ok(!/Engine per FDE[\s\S]{0,80}(no FDE containers|could not be read)/.test(text), `FDE 段在说「没有 FDE」或「读不到」，而 API 给了 ${(api.fdes ?? []).length} 台：${JSON.stringify(text.slice(text.indexOf('Engine per FDE'), text.indexOf('Engine per FDE') + 200))}`);

      // ② 页面显示的数字 == API 刚报的数字（逐格）。页面自己推算/取整就会漂 ⇒ 前端 spec 钉过形状，这里钉**真数据**。
      assert.equal(report.page.serverStation, api.server.station, `服务端版本格显示 ${JSON.stringify(report.page.serverStation)}，API 说 ${JSON.stringify(api.server.station)}`);
      assert.ok(String(report.page.serverRevision).startsWith(String(api.server.revision).slice(0, 12)),
        `revision 格显示 ${JSON.stringify(report.page.serverRevision)}，不含 API revision 前 12 位 ${JSON.stringify(String(api.server.revision).slice(0, 12))}（短 sha 是刻意的，完整值在 title 里）`);
      assert.equal(report.page.engineVersion, api.platformEngine?.version, `平台侧引擎格显示 ${JSON.stringify(report.page.engineVersion)}，API 说 ${JSON.stringify(api.platformEngine?.version)}`);
      // builtAt 那格跟 API 走：镜像里 built_at=unknown（本地 build 没带 STATION_BUILD_DATE）时，页面**必须**
      // 显式说 unknown（前端的「不猜数」红线），而不是伪装成一个时间或留空。
      const builtAtWant = UNKNOWNISH(api.server.builtAt) ? 'unknown' : null;
      if (builtAtWant) {
        assert.equal(report.page.serverBuiltAt, builtAtWant, `API 的 builtAt=${JSON.stringify(api.server.builtAt)}（unknown）而页面 builtAt 格显示 ${JSON.stringify(report.page.serverBuiltAt)} ⇒ 页面在猜一个时间`);
        t.diagnostic('提示：builtAt 格 = unknown（本地烘镜像没带 STATION_BUILD_DATE；发布路径由 ci.yml 拦，那不是本单要红的事）');
      } else {
        assert.ok(!UNKNOWNISH(report.page.serverBuiltAt), `builtAt 格显示 ${JSON.stringify(report.page.serverBuiltAt)}（API 有值却显示成未知/空？）`);
      }
      assert.ok(String(report.page.serverPath).includes(String(api.buildInfoPath)),
        `页面没透出实际读过的 build-info 路径（显示 ${JSON.stringify(report.page.serverPath)}，API 说 ${JSON.stringify(api.buildInfoPath)}）`);

      // ③ 第三格是**快照**：每台 FDE 都必须带口径字样，且页面上的行必须就是 API 给的那几台。
      assert.ok(report.page.fdeRows >= 1, `FDE 段一行都没有（API 报了 ${(api.fdes ?? []).length} 台）：${JSON.stringify(report.page.aboutUnreadable ?? report.page.sections)}`);
      assert.ok(report.page.snapshotLabels >= report.page.fdeRows,
        `「provision-time snapshot」标注 ${report.page.snapshotLabels} 个 < FDE 行 ${report.page.fdeRows} 台 ⇒ 有一台没标口径，会被当成实时事实`);
      for (const name of (api.fdes ?? []).map((row) => row.name)) {
        assert.ok((report.page.fdeNames ?? []).includes(name), `API 里的 FDE ${JSON.stringify(name)} 在页面上找不到（页面自己过滤了？应渲染 fdes[] 全量，含 revoked）`);
      }
      // 每一行的**版本值**也得是 API 那个数（前端只搬运，不推算；顺序与 fdes[] 一致）。
      const shown = new Map((report.page.fdeNames ?? []).map((name, i) => [name, (report.page.fdeVersions ?? [])[i] ?? null]));
      for (const row of api.fdes ?? []) {
        const want = UNKNOWNISH(row.agentVersion) ? 'unknown' : row.agentVersion;
        assert.equal(shown.get(row.name), want, `FDE ${JSON.stringify(row.name)} 的版本格显示 ${JSON.stringify(shown.get(row.name))}，API 的 agent_version=${JSON.stringify(row.agentVersion)}`);
      }
      // 来源标注跟的是**服务端推导**，不是前端自己写的文案（前端一推就有第二份口径）。
      if (api.provenance?.server === 'build-info.json') {
        assert.match(String(report.page.serverSource), /build-info\.json inside the image/, `来源标注没说清是镜像内构建产物：${JSON.stringify(report.page.serverSource)}`);
        assert.ok(!/Source: package\.json/.test(text), '镜像态的面板却标了 package.json ⇒ 谎报（推导链在 version-info.js provenanceFor）');
      }

      // ④ 版面与噪声。
      assert.ok(report.page.scrollW <= report.page.innerW + 2,
        `横向溢出：scrollWidth=${report.page.scrollW} > innerWidth=${report.page.innerW}+2，越界元素=${report.page.overflowing.join(', ')}`);
      assert.deepEqual(report.consoleErrors, [],
        `登录成功之后有控制台错误（登录前那发匿名 GET /api/me 401 已从计数里排除，共 ${report.consoleErrorsBeforeLogin} 条）：${report.consoleErrors.join(' / ')}`);
      if (report.fatal) t.diagnostic(`页面跑完后收台有小插曲（不影响判据）：${report.fatal}`);

      // ⑤ 截图（人工复核用的证据）。
      tryQuiet(() => fs.rmSync(SHOT_HOST, { force: true }));
      dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER} ${SHOT_HOST}`, { timeout: 60_000 });
      const bytes = fs.statSync(SHOT_HOST).size;
      assert.ok(bytes > 1024, `截图只有 ${bytes} 字节（${SHOT_HOST}）`);
      t.diagnostic(`截图：${SHOT_HOST}（${bytes} 字节）；FDE ${report.page.fdeRows} 台 / 快照标注 ${report.page.snapshotLabels} 个`);
    } finally {
      // 容器里那份临时 cfg **带着口令**，尽力删；宿主的临时文件同理。
      tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`, { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });
