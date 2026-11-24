// issue #727 片 2：管理台「工位内容」页的集成 e2e（**真机活栈**，不新起隔离栈）。
//
// 这是把一次手工跑通的真机 e2e 落进仓库的版本（参照 version-surface-e2e.mjs 的口径：
// 验的是**本机活着的那套栈**，缺东西就 skip 而不是把环境形状算成产品红）。
//
// 两条腿：
//   · HTTP 腿（总是跑，不需要浏览器）：fetch 走 admin host，断言 7 个只读端点的形状、
//     404 同形（不泄露存在性）、路径牢笼（`..` / `.git` 各 400）、归档开关。
//   · UI 腿（`E2E_UI=1` 且 playwright 容器在跑才跑，否则 skip）：真浏览器进
//     `#/admin/seat-content`，断言会话/树/对话/预览都渲染，并钉**只读红线**
//     （全程只允许 `/api/auth/login` 一个非 GET 方法、无 `/pv/`、无 preview-tickets、
//     0 pageerror）与**裸 i18n key 哨兵**。
//
// 为什么这样写（沿用 version-surface 的约定，别处已论证，这里只记本单相关的几条）：
//   1. admin host 是自签证书 ⇒ 本进程关 TLS 校验（只影响这个测试进程）。
//   2. 口令只从 `~/.config/creds/station-dev-password-file` 读，**绝不 print**；送进容器
//      走临时文件（命令行会被 `ps` 抄走），跑完尽力删（那是带口令的文件）。
//   3. 走 `sg docker -c` 那层时命令串**不许含换行**（version-surface 头注 F-6）。
//   4. UI 腿把 playwright 留在**容器里**（`/app/node_modules/playwright`），仓库**不**加
//      这个依赖；采集脚本自包含，断言全在外层做（容器里 assert 拿不到有用信息）。
//   5. 缺口令 / 第二因素（pending_token / email_code_required）/ 限流 ⇒ 环境形状，skip。
//   6. 截图落 `os.tmpdir()`，路径打在测试输出里，不提交图片。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// admin host 是自签证书；只在这个测试进程里关掉校验。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// 坐标（全部 env 可覆盖；缺省值就是这台部署机的 dev 栈）
// ---------------------------------------------------------------------------
/** HTTP 腿与 UI 腿共用的 admin 入口（同一台活栈：admin 反代把静态页和 /api 都收在这里）。 */
const BASE = (process.env.E2E_BASE || process.env.E2E_UI_BASE || 'https://admin.fde.erix.vip:9443')
  .replace(/\/$/, '');
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
const FDE = process.env.E2E_FDE || 'eric';
const PASSWORD_FILE = (process.env.ADMIN_PASSWORD_FILE || '~/.config/creds/station-dev-password-file')
  .replace(/^~/, os.homedir());
const UI_ENABLED = process.env.E2E_UI === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
const SHOT_CONTAINER = process.env.E2E_SHOT_CONTAINER || '/tmp/seat-content-e2e.png';
const SHOT_HOST = process.env.E2E_SHOT_HOST || path.join(os.tmpdir(), 'seat-content-e2e.png');
/** 一个形状合法、但几乎不可能存在的会话 id（decodeUuid 过 ⇒ 走到 getSession ⇒ 统一 404）。 */
const MISSING_UUID = '00000000-0000-4000-8000-000000000000';
/**
 * 把域名在 TCP 层映到 IP（SNI/Host 仍用域名）：dev admin 由本机 Traefik 收在
 * `127.0.0.1:9443`、按 **SNI + Host** 路由到 portal（同手工脚本给浏览器加的
 * `--host-resolver-rules MAP admin.fde.erix.vip 127.0.0.1`）。映射不命中则直连
 * URL 里的 host（给真能解析 / 指到 `http://127.0.0.1:18080` 的场景）。
 * 用 `E2E_RESOLVE=host=ip,host2=ip2` 可改这张表。
 */
const HOST_MAP = (() => {
  const map = {};
  for (const pair of (process.env.E2E_RESOLVE || 'admin.fde.erix.vip=127.0.0.1').split(',')) {
    const [h, ip] = pair.split('=').map((s) => s.trim());
    if (h && ip) map[h] = ip;
  }
  return map;
})();
/** 与 `HOST_MAP` 同源：给浏览器也加 `MAP <host> <ip>`（playwright 容器跑 host 网络⇒
 * `127.0.0.1` 就是宿主 admin，同手工脚本的 `--host-resolver-rules`）。 */
const HOST_RESOLVER_RULES = Object.entries(HOST_MAP).map(([h, ip]) => `MAP ${h} ${ip}`).join(',');

// ---------------------------------------------------------------------------
// 小工具（与 version-surface-e2e.mjs 同一份实现口径，照搬不改）
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** `docker` 直连与 `sg docker -c`（组未生效的会话）两条路，探一次记下来。 */
let dockerPrefix = null;
function dockerCmd(args) {
  if (/\n|\r/.test(args)) throw new Error(`docker 参数不许含换行（sg 层会变成字面 \\n）: ${JSON.stringify(args)}`);
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
function tryQuiet(fn) {
  try { fn(); return true; } catch (err) { console.log(`# 清理没成功（不影响判据）：${String(err?.message || err).split('\n')[0]}`); return false; }
}
function containerRunning(name) {
  try {
    return dockerRun(`inspect -f "{{.State.Running}}" ${name}`, { timeout: 20_000 }).trim() === 'true';
  } catch { return false; }
}

/** HTTP → `{status,json,text,cookies}`：拿不到 HTTP 响应才抛（那才是「环境没起」的形状）。 */
async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15_000, retries = 2 } = {}) {
  let last = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await httpRequest(url, { method, body, headers, timeoutMs });
      let json = null;
      try { json = res.text ? JSON.parse(res.text) : null; } catch { /* 只报状态码，不在这里猜形状 */ }
      return { status: res.status, json, text: res.text, cookies: res.cookies };
    } catch (err) {
      last = err;
      if (i < retries) await sleep(500 * (i + 1));
    }
  }
  const cause = last?.code || last?.cause?.code || last?.cause?.message || last?.message || String(last);
  const e = new Error(`${url} 连不上：${cause}`);
  e.transport = true;
  throw e;
}

/**
 * 用 `node:https` 而不是全局 `fetch`：全局 fetch 没法同时「连 IP + 保持 SNI/Host 为
 * 域名」（连 IP 会把 SNI 与 Host 也换成 IP ⇒ Traefik 按域名路由不命中）。这里 TCP 连
 * `HOST_MAP` 映到的 IP，但 `servername`（SNI）与 `Host` 头仍用域名。自签证书⇒
 * `rejectUnauthorized:false`（只影响这个测试进程）。
 */
function httpRequest(urlStr, { method = 'GET', body, headers = {}, timeoutMs = 15_000 }) {
  const u = new URL(urlStr);
  const secure = u.protocol === 'https:';
  const transport = secure ? https : http;
  const allHeaders = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers, Host: u.host };
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: HOST_MAP[u.hostname] || u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: allHeaders,
      ...(secure ? { servername: u.hostname, rejectUnauthorized: false } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        text: Buffer.concat(chunks).toString('utf8'),
        cookies: (res.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).filter(Boolean),
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`ETIMEDOUT ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

function readPassword() {
  if (!fs.existsSync(PASSWORD_FILE)) return null;
  const value = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
  return value === '' ? null : value;
}

/** 带会话 cookie 打一个 admin 只读端点（query 用对象传，URL.searchParams 负责编码）。 */
function adminGet(p, { params = {}, timeoutMs = 20_000 } = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return fetchJson(u.toString(), { headers: { Cookie: probe.cookies.join('; ') }, timeoutMs });
}

// ---------------------------------------------------------------------------
// 探测：把「能不能登进去 + 两条腿的环境形状」在模块加载时各取一次；只读不断言。
// reasons[leg] 有值 = 那条腿 skip（值是给人看的原因）；没有该 key = 那条腿要跑。
// ---------------------------------------------------------------------------
const probe = {
  reasons: {},
  cookies: [],
  loginStatus: null,
  loginBody: null,
};

async function gather() {
  // ── HTTP 腿 / UI 腿都要先能登进 admin：口令文件 + 口令直通 ──
  const password = readPassword();
  if (password === null) {
    const why = `缺管理员口令文件 ${PASSWORD_FILE}（明文不入库，轮换就改这个文件）`;
    probe.reasons.http = why;
    probe.reasons.ui = `${why} ⇒ UI 腿要登管理台`;
  } else {
    let login;
    try {
      login = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: ADMIN_LOGIN, password }, timeoutMs: 20_000 });
    } catch (err) {
      probe.reasons.http = err.message;
      probe.reasons.ui = `${err.message} ⇒ UI 腿要登管理台`;
    }
    if (login) {
      probe.loginStatus = login.status;
      probe.loginBody = login.json;
      probe.cookies = login.cookies;
      if (login.status !== 200 || login.cookies.length === 0) {
        // 口令不对/已轮换、开了第二因素（pending_token / email_code_required）、限流
        // ⇒ 都是环境形状，不是产品坏了：留成 skip，不硬失败。
        const code = login.json?.error?.code;
        probe.reasons.http = `登录没拿到会话 cookie（HTTP ${login.status}${code ? ` ${code}` : ''}`
          + `${login.json?.pending_token ? '，响应带 pending_token ⇒ 这个账号开了第二因素，本脚本只会口令直通' : ''}`
          + `）`;
        probe.reasons.ui = `${probe.reasons.http} ⇒ UI 腿要登管理台`;
      }
    }
  }
  // ── UI 腿：显式开开关 + playwright 容器在跑且里面有 playwright（仓库故意不加这个依赖） ──
  if (!UI_ENABLED) {
    probe.reasons.ui = 'UI 腿要点名才跑：E2E_UI=1 npm run test:integration:seat（真浏览器要几十秒，且得有个 playwright 容器）';
  } else if (!probe.reasons.ui) {
    const d = dockerProbe();
    if (d !== true) {
      probe.reasons.ui = typeof d === 'object' ? d.reason : 'docker 不可用';
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
}
await gather();

for (const [leg, label] of [['http', 'HTTP 腿（7 只读端点 + 404 同形 + 路径红线 + 归档开关）'], ['ui', 'U1 管理台「工位内容」页（真浏览器）']]) {
  console.log(probe.reasons[leg] ? `[seat-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}` : `[seat-e2e] leg=${leg} (${label}) 开跑`);
}

/** 有可用读数就返回它，没有就当场以「环境缺」收尾（skip + 打印原因），不算失败也不算通过。 */
function need(t, leg, value) {
  const reason = probe.reasons[leg];
  if (reason || value === null || value === undefined) {
    t.diagnostic(`SKIP (${leg})：${reason || `探测阶段没拿到 ${leg} 的读数`}`);
    t.skip();
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// HTTP 腿
// ---------------------------------------------------------------------------
test('S1 登录：口令直通拿到会话 cookie（缺口令 / 第二因素 / 限流 = 环境形状 ⇒ skip）',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    assert.equal(probe.loginStatus, 200, `登录期望 200，得到 ${probe.loginStatus}`);
    assert.ok(probe.cookies.length >= 1, '登录没带回会话 cookie');
  });

test('S2 `GET /api/admin/fdes/<eric>/dirs`：200 且 `dirs` 非空',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const r = await adminGet(`/api/admin/fdes/${FDE}/dirs`);
    assert.equal(r.status, 200, `dirs 期望 200，得到 ${r.status}：${r.text.slice(0, 160)}`);
    assert.ok(Array.isArray(r.json?.dirs), `响应里没有 dirs 数组（body=${r.text.slice(0, 200)}）`);
    assert.ok(r.json.dirs.length >= 1, `FDE ${FDE} 的 ~/projects 一级目录为空（dirs=${JSON.stringify(r.json.dirs)}）`);
  });

test('S3 `GET .../sessions?limit=2`：200 且 `items` 非空',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const r = await adminGet(`/api/admin/fdes/${FDE}/sessions`, { params: { limit: 2 } });
    assert.equal(r.status, 200, `sessions 期望 200，得到 ${r.status}：${r.text.slice(0, 160)}`);
    assert.ok(Array.isArray(r.json?.items), `响应里没有 items 数组（body=${r.text.slice(0, 200)}）`);
    assert.ok(r.json.items.length >= 1, `FDE ${FDE} 没有任何会话（items 为空）`);
  });

test('S4 `GET .../sessions/<第一条 id>`：200 且 `session.queued_messages` 存在',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const list = await adminGet(`/api/admin/fdes/${FDE}/sessions`, { params: { limit: 2 } });
    const id = list.json?.items?.[0]?.id;
    if (!id) { t.diagnostic('SKIP (http)：没有会话可点开（S3 若也空那是同一件事）'); t.skip(); return; }
    const r = await adminGet(`/api/admin/fdes/${FDE}/sessions/${id}`);
    assert.equal(r.status, 200, `会话详情期望 200，得到 ${r.status}：${r.text.slice(0, 160)}`);
    assert.ok(r.json?.session, `响应里没有 session 块（body=${r.text.slice(0, 200)}）`);
    assert.ok('queued_messages' in r.json.session, `session 缺 queued_messages（补齐面被摘了？getFdeSession 会兜底成空队列）`);
  });

test('S5 `GET .../events/history?limit=3`：200 且 `events` 是数组',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const list = await adminGet(`/api/admin/fdes/${FDE}/sessions`, { params: { limit: 2 } });
    const id = list.json?.items?.[0]?.id;
    if (!id) { t.diagnostic('SKIP (http)：没有会话可取历史'); t.skip(); return; }
    const r = await adminGet(`/api/admin/fdes/${FDE}/sessions/${id}/events/history`, { params: { limit: 3 } });
    assert.equal(r.status, 200, `events/history 期望 200，得到 ${r.status}：${r.text.slice(0, 160)}`);
    assert.ok(Array.isArray(r.json?.events), `响应里 events 不是数组（body=${r.text.slice(0, 200)}）`);
  });

test('S6 `GET .../files/tree?path=<真实目录>`：200 且 `entries` 是数组（目录名取自 dirs）',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const dirs = await adminGet(`/api/admin/fdes/${FDE}/dirs`);
    const dir = dirs.json?.dirs?.[0]?.name;
    if (!dir) { t.diagnostic('SKIP (http)：dirs 里没有可展开的目录'); t.skip(); return; }
    const r = await adminGet(`/api/admin/fdes/${FDE}/files/tree`, { params: { path: dir } });
    assert.equal(r.status, 200, `files/tree 期望 200，得到 ${r.status}：${r.text.slice(0, 160)}`);
    assert.ok(Array.isArray(r.json?.entries), `响应里 entries 不是数组（body=${r.text.slice(0, 200)}）`);
  });

test('S7 404 同形：跨 FDE 的 sessionId 与不存在的 uuid ⇒ 两次响应体逐字节相同（不泄露存在性）',
  { skip: probe.reasons.http || false, timeout: 90_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    // 取一个「存在但不属于 eric」的会话 id：从 /api/admin/version 找另一台有会话的 FDE。
    const ver = await adminGet('/api/admin/version');
    const others = (ver.json?.fdes ?? []).map((r) => r.name).filter((n) => n && n !== FDE);
    let foreignId = null;
    for (const name of others) {
      const s = await adminGet(`/api/admin/fdes/${encodeURIComponent(name)}/sessions`, { params: { limit: 1 } });
      const sid = s.json?.items?.[0]?.id;
      if (s.status === 200 && sid) { foreignId = sid; t.diagnostic(`外 FDE=${name} 的会话 ${sid}（在 ${FDE} 名下应 404）`); break; }
    }
    if (!foreignId) { t.diagnostic(`SKIP (http)：找不到第二台有会话的 FDE ⇒ 没有跨 FDE 的 404 样本`); t.skip(); return; }
    const a = await adminGet(`/api/admin/fdes/${FDE}/sessions/${foreignId}`);
    const b = await adminGet(`/api/admin/fdes/${FDE}/sessions/${MISSING_UUID}`);
    assert.equal(a.status, 404, `跨 FDE 会话期望 404，得到 ${a.status}：${a.text.slice(0, 160)}`);
    assert.equal(b.status, 404, `不存在 uuid 期望 404，得到 ${b.status}：${b.text.slice(0, 160)}`);
    assert.equal(a.text, b.text, `两种 404 响应体不同 ⇒ 泄露了存在性（a=${JSON.stringify(a.text.slice(0, 120))} b=${JSON.stringify(b.text.slice(0, 120))}）`);
  });

test('S8 路径红线：`path=../alice` ⇒ 400；`path=<dir>/.git` ⇒ 400（牢笼在 dirs 层）',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const up = await adminGet(`/api/admin/fdes/${FDE}/files/tree`, { params: { path: '../alice' } });
    assert.equal(up.status, 400, `path=../alice 期望 400，得到 ${up.status}：${up.text.slice(0, 160)}`);
    const dirs = await adminGet(`/api/admin/fdes/${FDE}/dirs`);
    const dir = dirs.json?.dirs?.[0]?.name;
    if (dir) {
      const g = await adminGet(`/api/admin/fdes/${FDE}/files/tree`, { params: { path: `${dir}/.git` } });
      // `.git` 只在它是目录时拦；若该目录下根本没有 .git 目录（裸仓库等）则 404，都可接受。
      assert.ok(g.status === 400 || g.status === 404, `path=<dir>/.git 期望 400/404，得到 ${g.status}：${g.text.slice(0, 160)}`);
      if (g.status !== 400) t.diagnostic(`提示：<dir>/.git 这次是 ${g.status}（该目录无 .git 目录 ⇒ 没触发 .git 拦截，不是 bug）`);
    } else {
      t.diagnostic('SKIP 分支：dirs 为空 ⇒ 没样本试 .git 那一半');
    }
  });

test('S9 归档开关：archived 会话不带开关 404、`?include_archived=1` 200（拿不到 archived 会话 ⇒ skip）',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    const list = await adminGet(`/api/admin/fdes/${FDE}/sessions`, { params: { limit: 50, include_archived: 1 } });
    const arch = (list.json?.items ?? []).find((it) => it.status === 'archived');
    if (!arch) { t.diagnostic(`SKIP (http)：${FDE} 名下 ${list.json?.items?.length ?? 0} 条里没有 archived 会话 ⇒ 没样本`); t.skip(); return; }
    const off = await adminGet(`/api/admin/fdes/${FDE}/sessions/${arch.id}`);
    assert.equal(off.status, 404, `archived 会话不带开关期望 404，得到 ${off.status}（归档可读性红线破了？）`);
    const on = await adminGet(`/api/admin/fdes/${FDE}/sessions/${arch.id}`, { params: { include_archived: 1 } });
    assert.equal(on.status, 200, `archived 会话带 ?include_archived=1 期望 200，得到 ${on.status}`);
    assert.ok(on.json?.session, `开关打开却没回 session 块（body=${on.text.slice(0, 200)}）`);
  });

// ---------------------------------------------------------------------------
// UI 腿
// ---------------------------------------------------------------------------
/**
 * 跑在 playwright 容器里的采集脚本（**自包含**，仓库不加 playwright 依赖）。
 * 只收集事实并打一行 `REPORT:<json>`；断言全在外面。配置走 `argv[2]` 的临时文件
 * （口令不进命令行，`ps` 里会露出来），也不 print。
 */
const CONTAINER_SCRIPT = String.raw`
import { chromium } from '__PW_MODULE__';
import { readFileSync, statSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = { fatal: null, login: {}, page: {}, requests: [], pageErrors: [], shotBytes: 0 };
let browser = null;
try {
  const launchArgs = ['--no-sandbox'];
  if (cfg.hostResolverRules) launchArgs.push('--host-resolver-rules=' + cfg.hostResolverRules);
  browser = await chromium.launch({ channel: 'chromium', args: launchArgs });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('request', (req) => r.requests.push({ method: req.method(), url: req.url() }));
  page.on('pageerror', (e) => r.pageErrors.push(String(e && e.message ? e.message : e)));

  await page.goto(cfg.base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20_000 });
  await page.fill('#loginName, input[autocomplete="username"]', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20_000 });
  r.login.hash = await page.evaluate(() => location.hash);

  await page.goto(cfg.base + '/#/admin/seat-content', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-test="seat-content-page"]', { timeout: 20_000 });
  await page.waitForSelector('[data-test="fde-select"] option[value="' + cfg.fde + '"]', { state: 'attached', timeout: 20_000 });
  await page.selectOption('[data-test="fde-select"]', cfg.fde);
  await page.waitForSelector('[data-test="session-row"]', { timeout: 20_000 });
  r.page.sessionRows = await page.locator('[data-test="session-row"]').count();

  // 点第一条会话 ⇒ 右栏出对话（工具卡 / 终态条 / 助手正文，任一可见）。
  await page.locator('[data-test="session-row"]').first().click();
  await page.waitForFunction(() => {
    const s = ['[data-test="tool-card"]', '[data-test="run-termination"]', '[data-test="msg-assistant"]', '[data-test="msg-user"]'];
    return s.some((q) => document.querySelector(q));
  }, null, { timeout: 20_000 }).catch(() => {});
  r.page.transcriptNodes = await page.locator('[data-test="tool-card"], [data-test="run-termination"], [data-test="msg-assistant"], [data-test="msg-user"]').count();

  // 展开文件树第一个目录，点第一个 📄 文件 ⇒ 出预览节点。
  const tree = page.locator('[data-test="tree-node"]');
  r.page.treeNodesInitial = await tree.count();
  if (r.page.treeNodesInitial > 0) {
    await tree.first().click();
    await page.waitForTimeout(1500);
  }
  r.page.treeNodesExpanded = await tree.count();
  const files = page.locator('[data-test="tree-node"]').filter({ hasText: '📄' });
  r.page.fileNodes = await files.count();
  if (r.page.fileNodes > 0) {
    await files.first().click();
    await page.waitForFunction(() => ['file-text', 'file-markdown', 'file-image', 'file-download-only']
      .some((t) => document.querySelector('[data-test="' + t + '"]')), null, { timeout: 15_000 }).catch(() => {});
  }
  r.page.filePreviewNodes = await page.locator('[data-test="file-text"], [data-test="file-markdown"], [data-test="file-image"], [data-test="file-download-only"]').count();
  const bodyText = await page.locator('[data-test="seat-content-page"]').innerText();
  r.page.rawI18nKey = bodyText.includes('admin.seatContent.');

  await page.screenshot({ path: cfg.shotPath, fullPage: false });
  try { r.shotBytes = statSync(cfg.shotPath).size; } catch { r.shotBytes = 0; }
} catch (err) {
  r.fatal = String(err?.message ?? err).split('\n')[0].slice(0, 300);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 收台失败不算判据 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
process.exit(0);
`;

test('U1 真浏览器进 `#/admin/seat-content`：会话行 + 文件树 + 对话 + 文件预览；只读红线（仅 GET 登录、无 /pv/、无 preview-tickets、0 pageerror）+ 无裸 i18n key',
  { skip: probe.reasons.ui || false, timeout: 420_000 }, async (t) => {
    need(t, 'ui', probe.cookies);
    const password = readPassword();
    if (password === null) { t.diagnostic(`SKIP (ui)：缺口令文件 ${PASSWORD_FILE}`); t.skip(); return; }

    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `seat-content-e2e-${uid}.mjs`);
    const cfgHost = path.join(os.tmpdir(), `seat-content-e2e-${uid}.json`);
    const scriptIn = `/tmp/seat-content-e2e-${uid}.mjs`;
    const cfgIn = `/tmp/seat-content-e2e-${uid}.json`;
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    // 口令走文件进容器（命令行会被 `ps` 抄走）；跑完在 finally 里尽力删（那是带口令的文件）。
    fs.writeFileSync(cfgHost, JSON.stringify({ base: BASE, login: ADMIN_LOGIN, password, fde: FDE, shotPath: SHOT_CONTAINER, hostResolverRules: HOST_RESOLVER_RULES }), { mode: 0o600 });

    try {
      dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`, { timeout: 60_000 });
      dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`, { timeout: 60_000 });
      const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
      const m = out.match(/REPORT:(\{.*\})/);
      assert.ok(m, `容器里的采集脚本没交出 REPORT（tail=${out.slice(-400)}）`);
      const rep = JSON.parse(m[1]);

      // 导航/渲染挂了分两类：压根没到页面（DNS/TLS/入口挂了 = 环境）说 skip，到了页面却没跑通 = 产品红。
      if (rep.fatal && !rep.page?.sessionRows) {
        if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
          t.diagnostic(`SKIP (ui)：管理台入口 ${BASE} 从容器里到不了：${rep.fatal}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器里没跑通：${rep.fatal}（登录态=${JSON.stringify(rep.login)}，pageerror=${rep.pageErrors.slice(0, 3).join(' / ')}）`);
      }
      assert.match(String(rep.login.hash || ''), /#\/(?!login)/, `登录后没离开 /login，hash=${JSON.stringify(rep.login.hash)}`);

      // ① 列表与树都渲染出来了。
      assert.ok(rep.page.sessionRows >= 1, `会话行 0 条（选了 ${FDE} 也没出列表？report=${JSON.stringify(rep.page)}）`);
      assert.ok(rep.page.treeNodesInitial >= 1, `文件树根一个节点都没有（treeNodes=${rep.page.treeNodesInitial}）`);

      // ② 点会话 ⇒ 右栏出对话；点 📄 ⇒ 出预览节点。
      assert.ok(rep.page.transcriptNodes >= 1, `点了第一条会话却没出对话（工具卡/终态条/正文一个都没有）：${JSON.stringify(rep.page)}`);
      assert.ok(rep.page.fileNodes >= 1, `展开树后没有 📄 文件节点可点（fileNodes=${rep.page.fileNodes}）`);
      assert.ok(rep.page.filePreviewNodes >= 1, `点了文件却没出 file-text/file-markdown/file-image/file-download-only 之一：${JSON.stringify(rep.page)}`);

      // ③ 裸 i18n key 哨兵（没被翻译就直接漏到界面上）。
      assert.equal(rep.page.rawI18nKey, false, '页面残留未翻译的裸 key「admin.seatContent.」');

      // ④ 只读红线：全程 method !== GET 只允许 /api/auth/login；/pv/ 0；preview-tickets 0；pageerror 0。
      const writes = (rep.requests || []).filter((x) => x.method !== 'GET' && !x.url.includes('/api/auth/login'));
      assert.deepEqual(writes, [], `只读页冒出了非登录的写请求：${JSON.stringify(writes.slice(0, 5))}`);
      const pv = (rep.requests || []).filter((x) => x.url.includes('/pv/'));
      assert.equal(pv.length, 0, `出现了 /pv/ 预览代理请求 ${pv.length} 次（工位内容页是只读，不该走预览代理）`);
      const tickets = (rep.requests || []).filter((x) => x.url.includes('/api/preview-tickets'));
      assert.equal(tickets.length, 0, `出现了 /api/preview-tickets 请求 ${tickets.length} 次（只读页不该取预览票）`);
      assert.deepEqual(rep.pageErrors, [], `有 pageerror：${rep.pageErrors.slice(0, 3).join(' / ')}`);

      // ⑤ 截图（人工复核证据，落宿主临时目录，不提交）。
      tryQuiet(() => fs.rmSync(SHOT_HOST, { force: true }));
      dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER} ${SHOT_HOST}`, { timeout: 60_000 });
      const bytes = fs.statSync(SHOT_HOST).size;
      assert.ok(bytes > 1024, `截图只有 ${bytes} 字节（${SHOT_HOST}）`);
      t.diagnostic(`截图：${SHOT_HOST}（${bytes} 字节）；会话行 ${rep.page.sessionRows} / 树节点 ${rep.page.treeNodesExpanded} / 文件节点 ${rep.page.fileNodes}`);
    } finally {
      tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`, { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });
