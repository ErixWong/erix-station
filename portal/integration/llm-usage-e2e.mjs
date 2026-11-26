// issue #800：管理台用户列表「周期 / 用量」列 + bulk 端点 `GET /api/admin/llm/key-usage`
// 的集成 e2e（**真机活栈**，不新起隔离栈；与 seat-content-e2e.mjs / version-surface-e2e.mjs 同构）。
//
// 这是把一次手工跑通的真机 e2e 落进仓库的版本（参照 seat-content-e2e.mjs 的口径：验的是
// **本机活着的那套栈**，缺东西就 skip 而不把「环境形状」算成产品红）。
//
// 四条腿：
//   · HTTP-401 腿（总是跑）：不带凭据打 key-usage ⇒ 401（这条不依赖口令/路由是否注册，auth 先拦）。
//   · HTTP-200 契约腿（要口令）：admin 登录后同端点 ⇒ 200；断言 `rows` 形状、9 个键齐全、
//     **响应全文不许出现 `api_key` 这个键**（密钥红线）、`spend_scope` 是周期/终身唯一判据的
//     自洽性（period⇒budget_duration 非空；spend==null⇔spend_scope==null；金额有限数或 null）。
//   · 额度往返腿（要口令）：挑一个可牺牲的 dev FDE 设/清周期额度，钉「设额度不得清零已花金额」
//     与「重置时刻＝本地次日零点」（portal 不自算周期、原样透传网关的实证）；finally 必 teardown。
//   · 非管理员腿（能登就测）：登一个普通 FDE 打 key-usage ⇒ 403；登不上（401/二因素）⇒ skip。
//   · UI 腿（`E2E_UI=1` 且 playwright 容器在跑才跑）：真浏览器进 `#/admin/users`，钉表头「周期 /
//     用量」、用量格 data-test 合法且不残留 pending、lifetime 灰字且整页无「本周期」、period hover
//     用完整词、0 pageerror、无裸 i18n key、金额格式合法、截图落临时目录。
//
// 为什么这样写（沿用 seat/version-surface 的约定，别处已论证，这里只记本单相关的几条）：
//   1. admin host 是自签证书 ⇒ 本进程关 TLS 校验（只影响这个测试进程）。
//   2. 口令只读凭据目录里 dev 口令文件（AGENTS §4：~/.config/ 下 mcp/creds/，旧路径兜底），
//      **绝不 print**；进容器走临时文件（防 `ps` 抄走），跑完尽力删（那是带口令的文件）。
//   3. 登录**不发 Origin 头**（活栈跨源守卫比对 Origin 的 host:port 与 Host；不带 Origin 即同形，
//      带了不匹配反而 403 `cross_origin_forbidden`；同 seat 模板 fetchJson 的既有口径）。
//   4. 走 docker 包装层时命令串**不许含换行**（version-surface 头注 F-6）。
//   5. UI 腿把 playwright 留在**容器里**（`/app/node_modules/playwright`），仓库**不**加这个依赖；
//      采集脚本自包含，断言全在外层做（容器里 assert 拿不到有用信息）。
//   6. **改动前的镜像**（活栈跑的功能上线之前的版本）⇒ `key-usage` 回 404、前端也没有「周期 / 用量」
//      列；那是「环境形状」不是产品红 ⇒ 按 skip 口径走，诊断里写清楚，绝不为凑绿放宽断言。
//   7. 截图落 `os.tmpdir()`，路径打在测试输出里，不提交图片。
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
/** 额度往返腿可牺牲的 dev FDE（设完额度当场 teardown；key-usage 里没它这一行 ⇒ skip）。 */
const BUDGET_FDE = process.env.E2E_BUDGET_FDE || 'acc019';
/** 非管理员腿登的普通 FDE（登不上就 skip，不强求）。 */
const FDE_LOGIN = process.env.E2E_FDE_LOGIN || 'agent01';
/** UI 腿钉表头/周期文案用的语言（缺省 zh；`en` 钉英文措辞）。 */
const UI_LOCALE = (process.env.E2E_UI_LOCALE || 'zh').toLowerCase();
const KEY_USAGE_PATH = '/api/admin/llm/key-usage';
/** `GET /api/admin/llm/key-usage` 每行**必须有**的 9 个键（docs/api/portal.md 契约）。 */
const ROW_KEYS = ['fde_name', 'budget_usd', 'budget_period', 'max_budget', 'budget_duration',
  'budget_reset_at', 'spend', 'remaining', 'spend_scope'];

// 凭据目录口径（AGENTS §4）：~/.config/ 下 mcp/creds/；env 点名只信 env
const PASSWORD_FILE_CANDIDATES = (process.env.ADMIN_PASSWORD_FILE
  ? [process.env.ADMIN_PASSWORD_FILE]
  : ['~/.config/mcp/creds/station-dev.password', '~/.config/creds/station-dev-password-file'])
  .map((p) => p.replace(/^~/, os.homedir()));
/** 报错文案用：缺口令时列出试过的路径（新前旧后）。 */
const PASSWORD_FILE = PASSWORD_FILE_CANDIDATES.join(' 或 ');
const UI_ENABLED = process.env.E2E_UI === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
const SHOT_CONTAINER = process.env.E2E_SHOT_CONTAINER || '/tmp/llm-usage-e2e.png';
const SHOT_HOST = process.env.E2E_SHOT_HOST || path.join(os.tmpdir(), 'llm-usage-e2e.png');

/**
 * 把域名在 TCP 层映到 IP（SNI/Host 仍用域名）：dev admin 由本机 Traefik 收在
 * `127.0.0.1:9443`、按 **SNI + Host** 路由到 portal（同手工脚本给浏览器加的
 * `--host-resolver-rules MAP admin.fde.erix.vip 127.0.0.1`）。映射不命中则直连
 * URL 里的 host。用 `E2E_RESOLVE=host=ip,host2=ip2` 可改这张表。
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
// 小工具（与 seat-content-e2e.mjs 同一份实现口径，照搬不改）
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
 * `HOST_MAP` 映到的 IP，但 `servername`（SNI）与 `Host` 头仍用域名（含端口）。自签证书⇒
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

/** 先新后旧取第一个存在的；空文件视同没有 ⇒ null。 */
function readPassword() {
  const file = PASSWORD_FILE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value === '' ? null : value;
}
// 哨兵用：模块加载就读一次，不依赖 gather 是否提前 return。
const CRED_PASSWORD = readPassword();

/** 带会话 cookie 打一个 admin 端点（GET/PUT 都走这里；query 用对象传）。 */
function adminReq(p, { method = 'GET', body, params = {}, timeoutMs = 20_000 } = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return fetchJson(u.toString(), { method, body, headers: { Cookie: (probe.cookies || []).join('; ') }, timeoutMs });
}

/** 金额字段：有限数或 null（其余一律算形状破了）。 */
function moneyOk(v) { return v === null || (typeof v === 'number' && Number.isFinite(v)); }
/** 把 ISO 时刻折算到 UTC+8 后取「时分秒」，用于断言落在本地零点。 */
function localHHMMSS(iso) {
  const d = new Date(iso);
  const shifted = new Date(d.getTime() + 480 * 60_000);
  return shifted.toISOString().slice(11, 19);
}

// ---------------------------------------------------------------------------
// 探测阶段：把各腿「能不能跑」先判清楚（缺东西 ⇒ 记成 skip 原因，不算红）。
// ---------------------------------------------------------------------------
const probe = {
  cookies: null, loginStatus: null, loginBody: null,
  keyUsageStatus: null, keyUsageJson: null, keyUsageText: '', keyUsageRows: null,
  fdeCookies: null, fdeLoginStatus: null, fdeLoginBody: null,
  reasons: { http: null, budget: null, nonadmin: null, ui: null },
};

async function gather() {
  // ── 三条 admin 依赖腿（200 契约 / 额度 / UI）都要先能登进 admin：口令文件 + 口令直通 ──
  const password = readPassword();
  if (password === null) {
    const why = `缺管理员口令文件 ${PASSWORD_FILE}（明文不入库，轮换就改这个文件）`;
    probe.reasons.http = why;
    probe.reasons.budget = why;
    probe.reasons.ui = `${why} ⇒ UI 腿要登管理台`;
    probe.reasons.nonadmin = `${why}（非管理员腿也用同一口令文件登 ${FDE_LOGIN}）`;
  } else {
    // admin 登录：**不发 Origin**（带不匹配的 Origin 会被 cross_origin_forbidden 403）。
    let login;
    try {
      login = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: ADMIN_LOGIN, password }, timeoutMs: 20_000 });
    } catch (err) {
      probe.reasons.http = err.message;
      probe.reasons.budget = err.message;
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
        const why = `admin 登录没拿到会话 cookie（HTTP ${login.status}${code ? ` ${code}` : ''}`
          + `${login.json?.pending_token ? '，响应带 pending_token ⇒ 这个账号开了第二因素，本脚本只会口令直通' : ''}）`;
        probe.reasons.http = why;
        probe.reasons.budget = why;
        probe.reasons.ui = `${why} ⇒ UI 腿要登管理台`;
      }
    }
    // admin 会话拿得到就顺手抓一次 key-usage（200 契约腿 + 额度腿都靠它定「有没有这一行」）。
    if (probe.cookies && !probe.reasons.http) {
      try {
        const k = await adminReq(KEY_USAGE_PATH);
        probe.keyUsageStatus = k.status;
        probe.keyUsageJson = k.json;
        probe.keyUsageText = k.text || '';
        probe.keyUsageRows = Array.isArray(k.json?.rows) ? k.json.rows : null;
      } catch (err) {
        probe.reasons.http = err.message;
        probe.reasons.budget = err.message;
      }
    }
    // ── 非管理员腿：登 FDE_LOGIN（登得上才测 403，登不上是环境形状）──
    try {
      const fl = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: FDE_LOGIN, password }, timeoutMs: 20_000 });
      probe.fdeLoginStatus = fl.status;
      probe.fdeLoginBody = fl.json;
      probe.fdeCookies = fl.cookies;
      if (fl.status !== 200 || fl.cookies.length === 0) {
        const code = fl.json?.error?.code;
        probe.reasons.nonadmin = `非管理员 ${FDE_LOGIN} 登不上（HTTP ${fl.status}${code ? ` ${code}` : ''}`
          + `${fl.json?.pending_token ? '，带 pending_token ⇒ 开了第二因素，本脚本只会口令直通' : ''} ⇒ 环境形状，不算红）`;
      }
    } catch (err) {
      probe.reasons.nonadmin = `非管理员 ${FDE_LOGIN} 登录连不上：${err.message}`;
    }
  }
  // ── UI 腿：显式开开关 + playwright 容器在跑且里面有 playwright（仓库故意不加这个依赖）──
  if (!UI_ENABLED) {
    probe.reasons.ui = 'UI 腿要点名才跑：E2E_UI=1 npm run test:integration:llm-usage（真浏览器要几十秒，且得有个 playwright 容器）';
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

for (const [leg, label] of [
  ['http', 'HTTP-200 契约腿（key-usage 形状 + 9 键 + api_key 红线 + spend_scope 自洽）'],
  ['budget', `额度往返腿（牺牲 ${BUDGET_FDE}，设/清周期额度 + 本地零点 + 不清零，含 teardown）`],
  ['nonadmin', `非管理员腿（登 ${FDE_LOGIN} 打 key-usage 期望 403）`],
  ['ui', 'U1 管理台「周期 / 用量」列（真浏览器）'],
]) {
  console.log(probe.reasons[leg] ? `[llm-usage-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}` : `[llm-usage-e2e] leg=${leg} (${label}) 开跑`);
}
console.log('[llm-usage-e2e] leg=401 (HTTP-401 无凭据腿) 总是跑');

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
// HTTP-401 腿（总是跑；不依赖口令，auth 中间件在路由前拦）
// ---------------------------------------------------------------------------
test('H0 不带凭据 `GET /api/admin/llm/key-usage` ⇒ 401（不依赖口令）',
  { timeout: 60_000 }, async (t) => {
    let res;
    try {
      res = await fetchJson(BASE + KEY_USAGE_PATH, { timeoutMs: 20_000 });
    } catch (err) {
      t.diagnostic(`SKIP (401)：${BASE} 连不上（栈没起 / 入口到不了）：${err.message}`);
      t.skip();
      return;
    }
    assert.equal(res.status, 401, `不带凭据打 key-usage 期望 401，得到 ${res.status}（body=${res.text.slice(0, 200)}）`);
  });

// ---------------------------------------------------------------------------
// HTTP-200 契约腿
// ---------------------------------------------------------------------------
test('H1 `GET /api/admin/llm/key-usage`：200 + `rows` 形状 + 9 键齐全 + 无 `api_key` 键 + `spend_scope` 自洽',
  { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
    need(t, 'http', probe.cookies);
    if (probe.keyUsageStatus === 404) {
      t.diagnostic(`SKIP (http)：${KEY_USAGE_PATH} 回 404 ⇒ 活栈跑的是本功能改动之前的镜像（bulk 端点还没上线），`
        + '这是「环境形状」不是产品红；活栈升到含 #800 的镜像后再跑此腿即真绿');
      t.skip();
      return;
    }
    assert.equal(probe.keyUsageStatus, 200, `key-usage 期望 200，得到 ${probe.keyUsageStatus}（body=${probe.keyUsageText.slice(0, 200)}）`);
    const rows = probe.keyUsageRows;
    assert.ok(Array.isArray(rows), `200 却没回数组形 rows（json=${probe.keyUsageText.slice(0, 200)}）`);
    assert.ok(!/"api_key"/.test(probe.keyUsageText), '响应全文里出现了 `api_key` 这个键（密钥红线破了）');
    t.diagnostic(`rows 行数=${rows.length}`);
    for (const row of rows) {
      const who = `fde_name=${JSON.stringify(row.fde_name)}`;
      for (const key of ROW_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(row, key), `行 ${who} 缺键 \`${key}\`（契约要求 9 键齐全）`);
      }
      assert.ok(!('api_key' in row), `行 ${who} 带了 \`api_key\` 键（密钥红线）`);
      const scope = row.spend_scope;
      assert.ok(scope === 'period' || scope === 'lifetime' || scope === null,
        `行 ${who} 的 spend_scope=${JSON.stringify(scope)} 不在 {period,lifetime,null}`);
      if (scope === 'period') {
        assert.ok(typeof row.budget_duration === 'string' && row.budget_duration.length > 0,
          `行 ${who} spend_scope=period 却 budget_duration=${JSON.stringify(row.budget_duration)}（period 必须带非空周期）`);
      }
      if (row.spend === null) {
        assert.equal(scope, null, `行 ${who} spend=null 却 spend_scope=${JSON.stringify(scope)}（「null 金额 + 非 null scope」自相矛盾）`);
      }
      if (scope === null) {
        assert.equal(row.spend, null, `行 ${who} spend_scope=null 却 spend=${JSON.stringify(row.spend)}（无读数却报金额，自相矛盾）`);
      }
      assert.ok(moneyOk(row.spend), `行 ${who} spend=${JSON.stringify(row.spend)} 不是有限数也不是 null`);
      assert.ok(moneyOk(row.remaining), `行 ${who} remaining=${JSON.stringify(row.remaining)} 不是有限数也不是 null`);
      assert.ok(moneyOk(row.max_budget), `行 ${who} max_budget=${JSON.stringify(row.max_budget)} 不是有限数也不是 null`);
      assert.ok(moneyOk(row.budget_usd), `行 ${who} budget_usd=${JSON.stringify(row.budget_usd)} 不是有限数也不是 null`);
      assert.ok(row.budget_period === null || row.budget_period === '1d' || row.budget_period === '1mo',
        `行 ${who} budget_period=${JSON.stringify(row.budget_period)} 不在 {null,1d,1mo}`);
    }
  });

// ---------------------------------------------------------------------------
// 额度往返腿（含 teardown；dev 数据被改坏要当场红）
// ---------------------------------------------------------------------------
test(`H2 额度往返（${BUDGET_FDE}）：设 1d 额度 ⇒ period/本地次日零点/不清零已花；teardown 回 lifetime`,
  { skip: probe.reasons.budget || false, timeout: 120_000 }, async (t) => {
    need(t, 'budget', probe.cookies);
    if (probe.keyUsageStatus !== 200) {
      t.diagnostic(`SKIP (budget)：${KEY_USAGE_PATH} 状态 ${probe.keyUsageStatus}（非 200，多为改动前镜像无此路由）⇒ 无法定位 ${BUDGET_FDE} 那一行，环境形状`);
      t.skip();
      return;
    }
    const findRow = (rows) => rows.find((r) => String(r.fde_name) === String(BUDGET_FDE));
    const startRow = findRow(probe.keyUsageRows || []);
    if (!startRow) {
      t.diagnostic(`SKIP (budget)：key-usage 里没有 ${BUDGET_FDE} 这一行（多半没有 active litellm binding）⇒ 没牺牲对象，环境形状`);
      t.skip();
      return;
    }
    const beforeSpend = startRow.spend;
    t.diagnostic(`起点：${BUDGET_FDE} spend=${JSON.stringify(beforeSpend)} spend_scope=${JSON.stringify(startRow.spend_scope)}`);
    let midSpend = beforeSpend;
    try {
      // 1) 设周期额度 1 USD / 1d
      const put = await adminReq(`/api/admin/fdes/${BUDGET_FDE}/llm/budget`, { method: 'PUT', body: { budget_usd: 1, budget_period: '1d' } });
      assert.equal(put.status, 200, `PUT 设 ${BUDGET_FDE} 额度期望 200，得到 ${put.status}（body=${put.text.slice(0, 200)}）`);
      // 2) key-usage 复核该行已变 period 周期
      const after = await adminReq(KEY_USAGE_PATH);
      assert.equal(after.status, 200, `设额度后 GET key-usage 期望 200，得到 ${after.status}`);
      const row = findRow(Array.isArray(after.json?.rows) ? after.json.rows : []);
      assert.ok(row, `设额度后 key-usage 里找不到 ${BUDGET_FDE} 那一行`);
      assert.equal(row.spend_scope, 'period', `${BUDGET_FDE} 设额度后期望 spend_scope=period，得到 ${JSON.stringify(row.spend_scope)}`);
      assert.equal(row.budget_duration, '1d', `${BUDGET_FDE} 设额度后期望 budget_duration=1d，得到 ${JSON.stringify(row.budget_duration)}`);
      assert.equal(row.budget_period, '1d', `${BUDGET_FDE} 设额度后期望 budget_period=1d，得到 ${JSON.stringify(row.budget_period)}`);
      assert.ok(row.budget_reset_at && typeof row.budget_reset_at === 'string',
        `${BUDGET_FDE} 设额度后期望有 budget_reset_at，得到 ${JSON.stringify(row.budget_reset_at)}`);
      // 3) 重置时刻 = 本地（UTC+8）次日零点（portal 不自算周期、原样透传网关的实证）
      assert.equal(localHHMMSS(row.budget_reset_at), '00:00:00',
        `${BUDGET_FDE} budget_reset_at=${row.budget_reset_at} 折算 UTC+8 后应落本地零点 00:00:00，实得 ${localHHMMSS(row.budget_reset_at)}`);
      // 4) 设额度**不得清零**已花金额
      assert.ok(moneyOk(row.spend), `${BUDGET_FDE} 设额度后 spend=${JSON.stringify(row.spend)} 不是有限数也不是 null`);
      assert.ok(typeof row.spend === 'number' && typeof beforeSpend === 'number' && row.spend >= beforeSpend,
        `${BUDGET_FDE} 设额度把已花金额清零了？期望 spend ≥ 起点 ${JSON.stringify(beforeSpend)}，实得 ${JSON.stringify(row.spend)}`);
      midSpend = row.spend;
      t.diagnostic(`设额度后：${BUDGET_FDE} spend=${JSON.stringify(midSpend)} reset_at=${row.budget_reset_at}（UTC+8 折算=${localHHMMSS(row.budget_reset_at)}）`);
    } finally {
      // teardown：清额度回 lifetime，且当场钉「dev 数据没被改坏」（清额度不得动已花金额）
      const clr = await adminReq(`/api/admin/fdes/${BUDGET_FDE}/llm/budget`, { method: 'PUT', body: { budget_usd: null } });
      assert.equal(clr.status, 200, `teardown PUT budget_usd=null 期望 200，得到 ${clr.status}（body=${clr.text.slice(0, 200)}）`);
      const back = await adminReq(KEY_USAGE_PATH);
      const brow = findRow(Array.isArray(back.json?.rows) ? back.json.rows : []);
      assert.ok(brow, `teardown 后 key-usage 里找不到 ${BUDGET_FDE} 那一行`);
      assert.equal(brow.spend_scope, 'lifetime', `teardown 后 ${BUDGET_FDE} 期望回 spend_scope=lifetime，得到 ${JSON.stringify(brow.spend_scope)}（dev 现场没复原！）`);
      assert.ok(typeof brow.spend === 'number' && brow.spend === midSpend,
        `teardown 后 ${BUDGET_FDE} spend 应与清额度前一致 ${JSON.stringify(midSpend)}，实得 ${JSON.stringify(brow.spend)}（清额度动了已花金额 / 现场被改坏）`);
      t.diagnostic(`teardown 后：${BUDGET_FDE} spend_scope=${brow.spend_scope} spend=${JSON.stringify(brow.spend)}（复原，与 ${JSON.stringify(midSpend)} 一致）`);
    }
  });

// ---------------------------------------------------------------------------
// 非管理员腿（能登就测，登不上 skip）
// ---------------------------------------------------------------------------
test(`H3 非管理员（${FDE_LOGIN}）打 key-usage ⇒ 403`,
  { skip: probe.reasons.nonadmin || false, timeout: 60_000 }, async (t) => {
    if (!need(t, 'nonadmin', probe.fdeCookies)) return;
    const res = await fetchJson(BASE + KEY_USAGE_PATH, { headers: { Cookie: probe.fdeCookies.join('; ') }, timeoutMs: 20_000 });
    if (res.status === 404) {
      t.diagnostic(`SKIP (nonadmin)：${FDE_LOGIN} 已登录但 key-usage 回 404 ⇒ 活栈跑的是改动前的镜像（无此路由），环境形状`);
      t.skip();
      return;
    }
    assert.equal(res.status, 403, `非管理员 ${FDE_LOGIN} 打 key-usage 期望 403，得到 ${res.status}（body=${res.text.slice(0, 200)}）`);
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
const r = { fatal: null, reachedLogin: false, login: {}, page: { tablePresent: false, featurePresent: false, headerCells: [], cells: [], pendingCount: null }, requests: [], pageErrors: [], shotBytes: 0 };
let browser = null;
try {
  const launchArgs = ['--no-sandbox'];
  if (cfg.hostResolverRules) launchArgs.push('--host-resolver-rules=' + cfg.hostResolverRules);
  browser = await chromium.launch({ channel: 'chromium', args: launchArgs });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: cfg.locale || 'zh-CN', ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('request', (req) => r.requests.push({ method: req.method(), url: req.url() }));
  page.on('pageerror', (e) => r.pageErrors.push(String(e && e.message ? e.message : e)));

  await page.goto(cfg.base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20_000 });
  r.reachedLogin = true;
  await page.fill('#loginName, input[autocomplete="username"]', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20_000 });
  r.login.hash = await page.evaluate(() => location.hash);

  await page.goto(cfg.base + '/#/admin/users', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-test="user-list"]', { timeout: 20_000 });
  // 等表格渲染（users 载入后 user-table 才出现）；等不到也不 fatal，外层按环境形状处理。
  await page.waitForSelector('[data-test="user-table"]', { timeout: 25_000 }).catch(() => {});
  // 用量列与列表并行拉，等 pending 占位消失（最多再等 15s；真卡住由外层判红）。
  await page.waitForFunction(() => document.querySelectorAll('[data-test="user-usage-pending"]').length === 0, null, { timeout: 15_000 }).catch(() => {});

  r.page.tablePresent = await page.locator('[data-test="user-table"]').count() > 0;
  r.page.headerCells = await page.$$eval('[data-test="user-table"] thead th', (els) => els.map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()));
  // 「功能是否在这份前端里」：表头出现「周期 / 用量」/「Period / usage」或存在 user-usage-* 用量格。
  r.page.featurePresent = r.page.headerCells.some((x) => /周期 \/ 用量|Period \/ usage/.test(x))
    || (await page.locator('[data-test^="user-usage-"]').count()) > 0;

  r.page.cells = await page.$$eval('[data-test^="user-usage-"]', (els) => els.map((e) => {
    const row = e.closest('[data-test="user-row"]');
    const firstCell = row ? row.querySelector('td') : null;
    return {
      dataTest: e.getAttribute('data-test'),
      login: firstCell ? (firstCell.textContent || '').replace(/\s+/g, ' ').trim() : null,
      text: (e.textContent || '').replace(/\s+/g, ' ').trim(),
      title: e.getAttribute('title') || '',
      muted: (e.className || '').split(/\s+/).includes('text-black/35'),
    };
  }));
  r.page.pendingCount = await page.locator('[data-test="user-usage-pending"]').count();
  r.page.bodyText = await page.evaluate(() => document.body.innerText || '');

  await page.screenshot({ path: cfg.shotPath, fullPage: true });
  try { r.shotBytes = statSync(cfg.shotPath).size; } catch { r.shotBytes = 0; }
} catch (err) {
  r.fatal = String(err?.message ?? err).split('\n')[0].slice(0, 300);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 收台失败不算判据 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
process.exit(0);
`;

const HEADER_EXPECT = UI_LOCALE === 'en' ? 'Period / usage' : '周期 / 用量';
const BROWSER_LOCALE = UI_LOCALE === 'en' ? 'en-US' : 'zh-CN';

test(`U1 真浏览器进 #/admin/users 钉「周期 / 用量」列：表头/用量格 data-test/lifetime 灰字无「本周期」/period hover 完整词/0 pageerror/无裸 i18n key/金额格式`,
  { skip: probe.reasons.ui || false, timeout: 420_000 }, async (t) => {
    need(t, 'ui', probe.cookies);
    const password = readPassword();
    if (password === null) { t.diagnostic(`SKIP (ui)：缺口令文件 ${PASSWORD_FILE}`); t.skip(); return; }

    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `llm-usage-e2e-${uid}.mjs`);
    const cfgHost = path.join(os.tmpdir(), `llm-usage-e2e-${uid}.json`);
    const scriptIn = `/tmp/llm-usage-e2e-${uid}.mjs`;
    const cfgIn = `/tmp/llm-usage-e2e-${uid}.json`;
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    // 口令走文件进容器（命令行会被 `ps` 抄走）；跑完在 finally 里尽力删（那是带口令的文件）。
    fs.writeFileSync(cfgHost, JSON.stringify({ base: BASE, login: ADMIN_LOGIN, password, shotPath: SHOT_CONTAINER, hostResolverRules: HOST_RESOLVER_RULES, locale: BROWSER_LOCALE }), { mode: 0o600 });

    try {
      dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`, { timeout: 60_000 });
      dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`, { timeout: 60_000 });
      const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
      const m = out.match(/REPORT:(\{.*\})/);
      assert.ok(m, `容器里的采集脚本没交出 REPORT（tail=${out.slice(-400)}）`);
      const rep = JSON.parse(m[1]);

      // 导航/渲染挂了分两类：压根没到页面（DNS/TLS/入口挂了 = 环境）说 skip，到了页面却没跑通 = 产品红。
      if (rep.fatal && !rep.page.tablePresent) {
        if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
          t.diagnostic(`SKIP (ui)：管理台入口 ${BASE} 从容器里到不了：${rep.fatal}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器里没跑通：${rep.fatal}（登录态=${JSON.stringify(rep.login)}，pageerror=${rep.pageErrors.slice(0, 3).join(' / ')}）`);
      }
      assert.match(String(rep.login.hash || ''), /#\/(?!login)/, `登录后没离开 /login，hash=${JSON.stringify(rep.login.hash)}`);

      // 表格 / 功能存在性：活栈跑改动前的前端时**根本没有这一列** ⇒ 环境形状 skip（不是产品红）。
      if (!rep.page.tablePresent) {
        t.diagnostic('SKIP (ui)：等了 25s `user-table` 仍没渲染出来（活栈太慢或登录态没拿到列表）⇒ 环境形状');
        t.skip();
        return;
      }
      if (!rep.page.featurePresent) {
        t.diagnostic(`SKIP (ui)：活栈这份前端里找不到「周期 / 用量」列（表头=${JSON.stringify(rep.page.headerCells)}，用量格 0 个）⇒ 改动前的镜像，环境形状；升到含 #800 的前端后此腿即真跑`);
        t.skip();
        return;
      }

      // ① 表头：10 格，下标 7 是「周期 / 用量」（或 en 的 `Period / usage`）。
      const hc = rep.page.headerCells;
      assert.equal(hc.length, 10, `表头格子数期望 10，得到 ${hc.length}（=${JSON.stringify(hc)}）`);
      assert.equal(hc[7], HEADER_EXPECT, `表头下标 7 期望「${HEADER_EXPECT}」，得到「${hc[7]}」（locale=${UI_LOCALE}）`);

      const cells = rep.page.cells || [];
      // ② 每个用量格 data-test 合法（unknown|period|lifetime），整表不残留 pending。
      assert.equal(rep.page.pendingCount, 0, `整表残留 user-usage-pending ${rep.page.pendingCount} 格（卡在加载态 = 红）`);
      for (const c of cells) {
        assert.match(String(c.dataTest), /^user-usage-(unknown|period|lifetime)$/,
          `用量格 data-test=${JSON.stringify(c.dataTest)}（login=${JSON.stringify(c.login)}）不是 unknown/period/lifetime 之一`);
      }
      // ③ lifetime 格必须灰字 text-black/35；整页文本不得出现「本周期」（终身被说成本周期 = 红）。
      for (const c of cells.filter((x) => x.dataTest === 'user-usage-lifetime')) {
        assert.ok(c.muted, `lifetime 用量格（login=${JSON.stringify(c.login)}）没带灰字类 text-black/35（终身该灰）`);
      }
      const bodyText = String(rep.page.bodyText || '');
      assert.ok(!bodyText.includes('本周期'), `整页文本出现「本周期」：lifetime 被说成本周期（或某格文案错），见截图`);
      // ④ period 格 hover 用完整词，不得短标签开头。
      for (const c of cells.filter((x) => x.dataTest === 'user-usage-period')) {
        const title = String(c.title || '');
        if (UI_LOCALE === 'en') {
          assert.ok(/this day|this month/i.test(title), `period 格 hover 应含完整词 this day/this month（login=${JSON.stringify(c.login)}），实得 ${JSON.stringify(title)}`);
          assert.ok(!/^mo |^d /.test(title), `period 格 hover 以短标签开头（login=${JSON.stringify(c.login)}），实得 ${JSON.stringify(title)}（hover 该用完整词不是黑话）`);
        } else {
          assert.ok(title.includes('本日') || title.includes('本月'), `period 格 hover 应含完整词「本日/本月」（login=${JSON.stringify(c.login)}），实得 ${JSON.stringify(title)}`);
          assert.ok(!/^月 |^日 |^\? /.test(title), `period 格 hover 以短标签开头（login=${JSON.stringify(c.login)}），实得 ${JSON.stringify(title)}（hover 该用完整词不是黑话）`);
        }
      }
      // ⑤ 0 pageerror、0 裸 i18n key、金额格式合法。
      assert.deepEqual(rep.pageErrors, [], `有 pageerror：${rep.pageErrors.slice(0, 3).join(' / ')}`);
      const rawKey = bodyText.match(/admin\.[A-Za-z]+\.[A-Za-z]+/);
      assert.equal(rawKey, null, `整页残留未翻译的裸 i18n key：${JSON.stringify(rawKey && rawKey[0])}`);
      for (const c of cells) {
        for (const hay of [c.text, c.title]) {
          for (const tok of String(hay).match(/<?-?\$\d+(?:\.\d+)?/g) || []) {
            assert.match(tok, /^<?-?\$\d+(?:\.\d{2})$/, `login=${JSON.stringify(c.login)} 的金额「${tok}」格式非法（应 \$数字两位小数 / <\$0.01 / —）`);
          }
        }
      }
      // ⑥ 截图（人工复核证据，落宿主临时目录，不提交）。
      tryQuiet(() => fs.rmSync(SHOT_HOST, { force: true }));
      dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER} ${SHOT_HOST}`, { timeout: 60_000 });
      const bytes = fs.statSync(SHOT_HOST).size;
      assert.ok(bytes > 1024, `截图只有 ${bytes} 字节（${SHOT_HOST}）`);
      const kinds = cells.reduce((a, c) => { const k = String(c.dataTest).replace('user-usage-', ''); a[k] = (a[k] || 0) + 1; return a; }, {});
      t.diagnostic(`截图：${SHOT_HOST}（${bytes} 字节）；用量格 ${cells.length} 个 kinds=${JSON.stringify(kinds)}`);
    } finally {
      tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`, { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });

// ---------------------------------------------------------------------------
// 哨兵用例：禁止「点名了却整腿静默 skip」的假通过。
// 为什么：E2E_UI=1 / E2E_HTTP=1 点名要跑，口令文件却不在 ⇒ 所有用例 skip、rc=0，
// 和真跑同色——这就是「假通过」，本仓反复在治的病。
// 未点名（默认）仍允许 skip：本地没有 dev 栈也得能跑 npm test。
// ---------------------------------------------------------------------------
const E2E_REQUESTED = UI_ENABLED || process.env.E2E_HTTP === '1';
test('哨兵：点名要跑时口令文件必须存在（禁止静默全 skip）',
  { timeout: 10_000 }, (t) => {
    if (!E2E_REQUESTED) {
      t.diagnostic('未点名 ⇒ 允许 skip（本地没有 dev 栈也能跑 npm test）');
      return;
    }
    if (CRED_PASSWORD === null) {
      assert.fail(`点名要跑却没找到口令文件（试过 ${PASSWORD_FILE}）：`
        + '全腿静默 skip 会让 rc=0 与真跑同色（假通过）⇒ 判失败。'
        + '修法：放好凭据文件，或用 ADMIN_PASSWORD_FILE 指过去。');
    }
  });
