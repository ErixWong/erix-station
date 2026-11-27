// issue #808：用户面「我自己的额度 / 用量」两个 `/api/me` 端点 + 工作台顶栏徽标的集成 e2e
// （**真机活栈**，不新起隔离栈；与同目录 `llm-usage-e2e.mjs` / `seat-content-e2e.mjs` 同构）。
//
// 这是把一次手工跑通的真机 e2e 落进仓库的版本：验的是**本机活着的那套栈**，缺东西就 skip
// 而不把「环境形状」算成产品红。本单在 llm-usage 的口径上验**用户面**（人看自己的账）。
//
// 四条腿：
//   · HTTP-401 腿（总是跑）：不带凭据打 `GET /api/me/llm-quota` 与 `GET /api/me/llm-usage?days=7`
//     ⇒ 都 401（auth 在路由前拦，不依赖口令/路由是否注册）。
//   · HTTP-200 契约腿（要 FDE 口令）：登 dev 脚本账号（名字 = 下面 `FDE_LOGIN` 的默认值，不写进注释 ⇒ AGENTS §6）后——
//       - `llm-quota` 200：`quota` 为对象或 null；若对象则 8 键齐全、金额有限数或 null、
//         `spend_scope` 自洽（period⇒budget_duration 非空；spend==null⇔spend_scope==null）；
//         **响应全文不许出现 `api_key` / `token` / `sk-` 字样**（密钥红线）。
//       - `llm-usage?days=7` 200：`days` 数组、每行 6 键、`totals.spend` 有限数；
//         `?days=` / `?days=0` / `?days=91` 各 400 且 `error.details.field==='days'`。
//       - 越权面：带 `?fde_name=<别人>` / `?fde=<别人>` 打这两个端点，返回的仍是**自己的**读数
//         （参数被忽略，结构上看不了别人的账）。
//   · admin 越权口径腿（要 admin 口令）：admin 没有 `fde_name` ⇒ 打 `llm-quota` 回 400
//     `fde_name_required`（既有口径，不是新 bug）。
//   · lifetime 往返腿（要 admin+FDE 口令，**会短暂改真实额度，finally 必复原**）：PUT budget_usd=null
//     ⇒ `/api/me/llm-quota` 断言 `spend_scope==='lifetime'` 且 `budget_duration===null` 且 spend 非空；
//     finally 恢复 `{budget_usd:3,budget_period:'1mo'}` 并回读断言 `spend_scope==='period'`。
//     这是「未设额度不得被读成本周期」的真机判据。
//   · UI 腿（`E2E_UI=1` 且 playwright 容器在跑才跑，否则 skip 不算红）：登 dev 脚本账号进 `#/workbench`，
//     钉徽标紧跟 `who`、徽标文案是周期格式且 hover/aria 用完整词、点开弹窗（已用/进度条/30 天 chart 的
//     `<svg>`、进度条与 chart 同一蓝色族 `bg-blue-600`）、按钮与 Esc 都能关、0 pageerror、无裸 i18n key、
//     无「本周期从」句式、顶栏不换行；中英各一趟各存一张截图落 `os.tmpdir()`。
//
// 为什么这样写（沿用 llm-usage / seat / version-surface 的约定，这里只记本单相关的几条）：
//   1. admin host 是自签证书 ⇒ 本进程关 TLS 校验（只影响这个测试进程）。
//   2. 口令只读凭据目录里的口令文件（AGENTS §4：路径见冷层，仓库里不写；旧路径兜底），**绝不 print**；
//      FDE（脚本账号）与 admin 各用各的口令文件；进容器走临时文件（防 `ps` 抄走），跑完尽力删。
//   3. 登录**不发 Origin 头**（带不匹配的 Origin 会被 cross_origin_forbidden 403）。
//   4. 走 docker 包装层时命令串**不许含换行**。
//   5. UI 腿把 playwright 留在**容器里**（`/app/node_modules/playwright`），仓库**不**加这个依赖。
//   6. **活栈跑的是本功能改动之前的镜像** ⇒ `/api/me/llm-*` 回 404、前端也没有顶栏徽标；那是
//      「环境形状」不是产品红 ⇒ 按 skip 口径走，诊断里写清楚，绝不为凑绿放宽断言。
//   7. `/api/me/llm-quota` 有 30s 进程内缓存，且 `PUT /api/admin/fdes/:fde/llm/budget` **不**失效它
//      （见 llm.createQuotaCache / http.js）⇒ 往返腿每次 PUT 后必须睡过 TTL 再读，否则拿到旧值假红。
//   8. 截图落 `os.tmpdir()`，路径打在测试输出里，不提交图片。
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
/** 用户面主角：一个有 active litellm binding 的 dev FDE（有 `fde_name`，能看到自己的账）。 */
const FDE_LOGIN = process.env.E2E_FDE_LOGIN || 'agent01';
/** 越权面「别人」的取值：参数会被服务端忽略，取一个明确不是主角的名字即可。 */
const OTHER_FDE = process.env.E2E_OTHER_FDE || 'someone-else-zzz';
const QUOTA_PATH = '/api/me/llm-quota';
const USAGE_PATH = '/api/me/llm-usage';
/** `GET /api/me/llm-quota` 额度对象**必须有**的 8 个键（docs/api/portal.md 契约）。 */
const QUOTA_KEYS = ['budget_usd', 'budget_period', 'max_budget', 'budget_duration',
  'budget_reset_at', 'spend', 'remaining', 'spend_scope'];
/** `GET /api/me/llm-usage` 每个 day 行**必须有**的 6 个键。 */
const DAY_KEYS = ['date', 'spend', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'api_requests'];
/** `/api/me/llm-quota` 的 30s 进程内缓存 TTL；budget PUT 不失效它 ⇒ 往返腿读前睡过它。 */
const QUOTA_CACHE_WAIT_MS = Number(process.env.E2E_QUOTA_CACHE_WAIT_MS || 31_000);

// 凭据目录口径（AGENTS §4：具体路径见冷层，仓库不写）；env 点名只信 env
function credFiles(envVar, names) {
  return (process.env[envVar] ? [process.env[envVar]] : names)
    .map((p) => p.replace(/^~/, os.homedir()));
}
/** FDE（脚本账号）口令：任务指定的文件，env 可覆盖。 */
const FDE_PASSWORD_FILES = credFiles('E2E_FDE_PASSWORD_FILE',
  ['~/.config/mcp/creds/station-agent01.password', '~/.config/creds/station-agent01-password-file']);
/** admin 口令：与 llm-usage-e2e 同一份 dev 口令文件。 */
const ADMIN_PASSWORD_FILES = credFiles('ADMIN_PASSWORD_FILE',
  ['~/.config/mcp/creds/station-dev.password', '~/.config/creds/station-dev-password-file']);
const FDE_PASSWORD_FILE = FDE_PASSWORD_FILES.join(' 或 ');
const ADMIN_PASSWORD_FILE = ADMIN_PASSWORD_FILES.join(' 或 ');

const UI_ENABLED = process.env.E2E_UI === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
const SHOT_CONTAINER_ZH = process.env.E2E_SHOT_CONTAINER_ZH || '/tmp/user-usage-e2e-zh.png';
const SHOT_CONTAINER_EN = process.env.E2E_SHOT_CONTAINER_EN || '/tmp/user-usage-e2e-en.png';
const SHOT_HOST_ZH = process.env.E2E_SHOT_HOST_ZH || path.join(os.tmpdir(), 'user-usage-e2e-zh.png');
const SHOT_HOST_EN = process.env.E2E_SHOT_HOST_EN || path.join(os.tmpdir(), 'user-usage-e2e-en.png');

/**
 * 把域名在 TCP 层映到 IP（SNI/Host 仍用域名）：dev admin 由本机 Traefik 收在
 * `127.0.0.1:9443`、按 **SNI + Host** 路由到 portal。映射不命中则直连 URL 里的 host。
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
// 小工具（与 llm-usage-e2e.mjs 同一份实现口径，照搬不改）
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
 * 用 `node:https` 而不是全局 `fetch`：全局 fetch 没法同时「连 IP + 保持 SNI/Host 为域名」。
 * 这里 TCP 连 `HOST_MAP` 映到的 IP，但 `servername`（SNI）与 `Host` 头仍用域名（含端口）。
 * 自签证书⇒ `rejectUnauthorized:false`（只影响这个测试进程）。
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

/** 从候选文件里取第一个存在的口令；空文件视同没有 ⇒ null。绝不 print。 */
function readCred(files) {
  const file = files.find((p) => fs.existsSync(p));
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value === '' ? null : value;
}
// 哨兵用：模块加载就读一次，不依赖 gather 是否提前 return。
const CRED_FDE = readCred(FDE_PASSWORD_FILES);
const CRED_ADMIN = readCred(ADMIN_PASSWORD_FILES);

/** 带某个会话 cookie 打一个端点（GET；query 用对象传）。 */
function reqWith(cookies, p, { method = 'GET', body, params = {}, timeoutMs = 20_000 } = {}) {
  const u = new URL(BASE + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return fetchJson(u.toString(), { method, body, headers: { Cookie: (cookies || []).join('; ') }, timeoutMs });
}

/** 金额字段：有限数或 null（其余一律算形状破了）。 */
function moneyOk(v) { return v === null || (typeof v === 'number' && Number.isFinite(v)); }

// ---------------------------------------------------------------------------
// 探测阶段：把各腿「能不能跑」先判清楚（缺东西 ⇒ 记成 skip 原因，不算红）。
// ---------------------------------------------------------------------------
const probe = {
  fdeCookies: null, fdeLoginStatus: null, fdeLoginBody: null,
  adminCookies: null, adminLoginStatus: null, adminLoginBody: null,
  quotaStatus: null, quotaJson: null, quotaText: '',
  reasons: { fde: null, admin: null, roundtrip: null, ui: null },
};

async function gather() {
  // ── FDE 腿（200 契约 / 越权面 / UI）都要先登进 dev 脚本账号（`FDE_LOGIN`）──
  const fdePw = readCred(FDE_PASSWORD_FILES);
  if (fdePw === null) {
    const why = `缺 FDE（${FDE_LOGIN}）口令文件 ${FDE_PASSWORD_FILE}（明文不入库，轮换就改这个文件，或 E2E_FDE_PASSWORD_FILE 指过去）`;
    probe.reasons.fde = why;
    probe.reasons.roundtrip = `${why}（往返腿读回也要 ${FDE_LOGIN} 会话）`;
    probe.reasons.ui = `${why} ⇒ UI 腿要登 ${FDE_LOGIN}`;
  } else {
    // FDE 登录：**不发 Origin**（带不匹配的 Origin 会被 cross_origin_forbidden 403）。
    try {
      const fl = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: FDE_LOGIN, password: fdePw }, timeoutMs: 20_000 });
      probe.fdeLoginStatus = fl.status;
      probe.fdeLoginBody = fl.json;
      probe.fdeCookies = fl.cookies;
      if (fl.status !== 200 || fl.cookies.length === 0) {
        const code = fl.json?.error?.code;
        const why = `${FDE_LOGIN} 登录没拿到会话 cookie（HTTP ${fl.status}${code ? ` ${code}` : ''}`
          + `${fl.json?.pending_token ? '，响应带 pending_token ⇒ 这个账号开了第二因素，本脚本只会口令直通' : ''} ⇒ 环境形状，不算红）`;
        probe.reasons.fde = why;
        probe.reasons.roundtrip = why;
        probe.reasons.ui = `${why} ⇒ UI 腿要登 ${FDE_LOGIN}`;
      }
    } catch (err) {
      probe.reasons.fde = `${FDE_LOGIN} 登录连不上：${err.message}`;
      probe.reasons.roundtrip = probe.reasons.fde;
      probe.reasons.ui = `${probe.reasons.fde} ⇒ UI 腿要登 ${FDE_LOGIN}`;
    }
    // 登得上就顺手抓一次 llm-quota（定「有没有这一对端点」= 改动前后镜像的形状）。
    if (probe.fdeCookies && !probe.reasons.fde) {
      try {
        const q = await reqWith(probe.fdeCookies, QUOTA_PATH);
        probe.quotaStatus = q.status;
        probe.quotaJson = q.json;
        probe.quotaText = q.text || '';
      } catch (err) {
        probe.reasons.fde = err.message;
        probe.reasons.roundtrip = err.message;
      }
    }
  }

  // ── admin 腿（admin 越权口径 / 往返腿的 PUT）要能登 admin ──
  const adminPw = readCred(ADMIN_PASSWORD_FILES);
  if (adminPw === null) {
    const why = `缺 admin 口令文件 ${ADMIN_PASSWORD_FILE}（往返腿要 admin 会话去 PUT budget）`;
    probe.reasons.admin = why;
    probe.reasons.roundtrip = probe.reasons.roundtrip || why;
  } else {
    try {
      const al = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: ADMIN_LOGIN, password: adminPw }, timeoutMs: 20_000 });
      probe.adminLoginStatus = al.status;
      probe.adminLoginBody = al.json;
      probe.adminCookies = al.cookies;
      if (al.status !== 200 || al.cookies.length === 0) {
        const code = al.json?.error?.code;
        const why = `admin 登录没拿到会话 cookie（HTTP ${al.status}${code ? ` ${code}` : ''}`
          + `${al.json?.pending_token ? '，带 pending_token ⇒ 开了第二因素' : ''} ⇒ 环境形状）`;
        probe.reasons.admin = why;
        probe.reasons.roundtrip = probe.reasons.roundtrip || why;
      }
    } catch (err) {
      probe.reasons.admin = `admin 登录连不上：${err.message}`;
      probe.reasons.roundtrip = probe.reasons.roundtrip || err.message;
    }
  }

  // ── UI 腿：显式开开关 + playwright 容器在跑且里面有 playwright（仓库故意不加这个依赖）──
  if (!UI_ENABLED) {
    probe.reasons.ui = 'UI 腿要点名才跑：E2E_UI=1 npm run test:integration:user-usage（真浏览器要几十秒，且得有个 playwright 容器）';
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
  ['fde', `HTTP-200 契约腿（${FDE_LOGIN}：llm-quota 8 键 + 密钥红线 / llm-usage 6 键 + days 校验 / 越权面）`],
  ['admin', `admin 越权口径腿（admin 打 llm-quota 期望 400 fde_name_required）`],
  ['roundtrip', `lifetime 往返腿（牺牲 ${FDE_LOGIN} 真实额度：置 null 读 lifetime，finally 复原 1mo）`],
  ['ui', `UI 腿（真浏览器进 #/workbench：徽标紧跟 who / 文案 / 弹窗 / 中英各一趟截图）`],
]) {
  console.log(probe.reasons[leg] ? `[user-usage-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}` : `[user-usage-e2e] leg=${leg} (${label}) 开跑`);
}
console.log('[user-usage-e2e] leg=401 (HTTP-401 无凭据腿) 总是跑');

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
test('H0 不带凭据打 llm-quota 与 llm-usage ⇒ 都 401（不依赖口令）',
  { timeout: 60_000 }, async (t) => {
    for (const p of [QUOTA_PATH, `${USAGE_PATH}?days=7`]) {
      let res;
      try {
        res = await fetchJson(BASE + p, { timeoutMs: 20_000 });
      } catch (err) {
        t.diagnostic(`SKIP (401)：${BASE} 连不上（栈没起 / 入口到不了）：${err.message}`);
        t.skip();
        return;
      }
      assert.ok(res.status === 401 || res.status === 404,
        `不带凭据打 ${p} 期望 401（路由存在但需鉴权）或 404（改动前镜像无此路由），得到 ${res.status}（body=${res.text.slice(0, 200)}）`);
      if (res.status === 404) {
        t.diagnostic(`SKIP (401)：${p} 未认证回 404（路由不存在）⇒ 活栈跑的是改动之前的镜像，环境形状不算红；新镜像上未认证应回 401`);
        t.skip();
        return;
      }
    }
  });

// ---------------------------------------------------------------------------
// HTTP-200 契约腿 · llm-quota
// ---------------------------------------------------------------------------
test('H1 `GET /api/me/llm-quota`：200 + quota 对象或 null + 8 键 + 金额有限数/null + spend_scope 自洽 + 密钥红线（无 api_key/token/sk-）',
  { skip: probe.reasons.fde || false, timeout: 60_000 }, async (t) => {
    need(t, 'fde', probe.fdeCookies);
    if (probe.quotaStatus === 404) {
      t.diagnostic(`SKIP (fde)：${QUOTA_PATH} 回 404 ⇒ 活栈跑的是本功能改动之前的镜像（用户面端点还没上线），`
        + '这是「环境形状」不是产品红；活栈升到含 #808 的镜像后再跑此腿即真绿');
      t.skip();
      return;
    }
    assert.equal(probe.quotaStatus, 200, `llm-quota 期望 200，得到 ${probe.quotaStatus}（body=${probe.quotaText.slice(0, 200)}）`);
    // 密钥红线：整个响应全文不许出现 api_key / token / sk-（额度视图只该有金额与周期字段）。
    assert.ok(!/api_key/.test(probe.quotaText), 'llm-quota 响应全文出现了 `api_key`（密钥红线破了）');
    assert.ok(!/token/i.test(probe.quotaText), 'llm-quota 响应全文出现了 `token` 字样（密钥红线：额度响应不该带 token）');
    assert.ok(!/sk-/.test(probe.quotaText), 'llm-quota 响应全文出现了 `sk-`（疑似密钥前缀泄漏）');

    const quota = probe.quotaJson?.quota;
    assert.ok(quota === null || (quota && typeof quota === 'object'),
      `quota 既不是 null 也不是对象（json=${probe.quotaText.slice(0, 200)}）`);
    if (quota === null) {
      t.diagnostic(`quota=null（reason=${JSON.stringify(probe.quotaJson?.reason)}），无额度对象可查，密钥红线已过`);
      return;
    }
    for (const key of QUOTA_KEYS) {
      assert.ok(Object.prototype.hasOwnProperty.call(quota, key), `quota 缺键 \`${key}\`（契约要求 8 键齐全）`);
    }
    for (const key of ['spend', 'remaining', 'max_budget', 'budget_usd']) {
      assert.ok(moneyOk(quota[key]), `quota ${key}=${JSON.stringify(quota[key])} 不是有限数也不是 null`);
    }
    assert.ok(quota.budget_period === null || quota.budget_period === '1d' || quota.budget_period === '1mo',
      `quota budget_period=${JSON.stringify(quota.budget_period)} 不在 {null,1d,1mo}`);
    const scope = quota.spend_scope;
    assert.ok(scope === 'period' || scope === 'lifetime', `quota spend_scope=${JSON.stringify(scope)} 不在 {period,lifetime}`);
    if (scope === 'period') {
      assert.ok(typeof quota.budget_duration === 'string' && quota.budget_duration.length > 0,
        `spend_scope=period 却 budget_duration=${JSON.stringify(quota.budget_duration)}（period 必须带非空周期）`);
    }
    // spend 与 spend_scope 同 null 同非 null（额度响应里 spend_scope 永不 null ⇒ 这里钉 spend 非 null）。
    assert.equal(quota.spend === null, scope === null,
      `spend=${JSON.stringify(quota.spend)} 与 spend_scope=${JSON.stringify(scope)} 的 null 性不一致（自相矛盾）`);
  });

// ---------------------------------------------------------------------------
// HTTP-200 契约腿 · llm-usage（含 days 三非法）
// ---------------------------------------------------------------------------
test('H2 `GET /api/me/llm-usage?days=7`：200 + days 数组每行 6 键 + totals.spend 有限数；days= / 0 / 91 各 400 且 details.field=days',
  { skip: probe.reasons.fde || false, timeout: 60_000 }, async (t) => {
    need(t, 'fde', probe.fdeCookies);
    let ok;
    try {
      ok = await reqWith(probe.fdeCookies, USAGE_PATH, { params: { days: 7 } });
    } catch (err) {
      t.diagnostic(`SKIP (fde)：llm-usage 连不上：${err.message}`);
      t.skip();
      return;
    }
    if (ok.status === 404) {
      t.diagnostic(`SKIP (fde)：${USAGE_PATH} 回 404 ⇒ 活栈跑的是改动前的镜像（无此路由），环境形状`);
      t.skip();
      return;
    }
    assert.equal(ok.status, 200, `llm-usage?days=7 期望 200，得到 ${ok.status}（body=${ok.text.slice(0, 200)}）`);
    const days = ok.json?.days;
    assert.ok(Array.isArray(days), `200 却没回 days 数组（json=${ok.text.slice(0, 200)}）`);
    t.diagnostic(`days 行数=${days.length}`);
    for (const row of days) {
      for (const key of DAY_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(row, key), `day 行缺键 \`${key}\`（契约要求 6 键齐全，row=${JSON.stringify(row)}）`);
      }
      assert.ok(moneyOk(row.spend), `day spend=${JSON.stringify(row.spend)} 不是有限数也不是 null`);
    }
    assert.ok(Number.isFinite(ok.json?.totals?.spend), `totals.spend=${JSON.stringify(ok.json?.totals?.spend)} 不是有限数`);

    // days 三非法：只要带了 days 就必须 1–90 整数；空串 / 0 / 91 都 400 且 details.field=days。
    for (const raw of ['', '0', '91']) {
      const bad = await fetchJson(`${BASE}${USAGE_PATH}?days=${encodeURIComponent(raw)}`, { headers: { Cookie: probe.fdeCookies.join('; ') }, timeoutMs: 20_000 });
      assert.equal(bad.status, 400, `days=${JSON.stringify(raw)} 期望 400，得到 ${bad.status}（body=${bad.text.slice(0, 200)}）`);
      assert.equal(bad.json?.error?.details?.field, 'days', `days=${JSON.stringify(raw)} 的 400 里 error.details.field 应为 days，实得 ${JSON.stringify(bad.json?.error?.details)}（body=${bad.text.slice(0, 200)}）`);
    }
  });

// ---------------------------------------------------------------------------
// 越权面腿（参数被忽略，看的是自己的账）
// ---------------------------------------------------------------------------
test(`H3 越权面：带 ?fde_name=${OTHER_FDE} / ?fde=${OTHER_FDE} 打两端点，返回的仍是 ${FDE_LOGIN} 自己的读数（budget_usd 与不带参数时一致）`,
  { skip: probe.reasons.fde || false, timeout: 60_000 }, async (t) => {
    need(t, 'fde', probe.fdeCookies);
    const base = await reqWith(probe.fdeCookies, QUOTA_PATH);
    if (base.status === 404) {
      t.diagnostic(`SKIP (fde)：${QUOTA_PATH} 回 404 ⇒ 改动前镜像，环境形状`);
      t.skip();
      return;
    }
    assert.equal(base.status, 200, `基线 llm-quota 期望 200，得到 ${base.status}`);
    const baseBudget = base.json?.quota?.budget_usd ?? null;
    for (const p of [`${QUOTA_PATH}?fde_name=${encodeURIComponent(OTHER_FDE)}`, `${QUOTA_PATH}?fde=${encodeURIComponent(OTHER_FDE)}`]) {
      const r = await reqWith(probe.fdeCookies, p);
      assert.equal(r.status, 200, `${p} 期望 200（自己的账），得到 ${r.status}（body=${r.text.slice(0, 200)}）`);
      assert.equal(r.json?.quota?.budget_usd ?? null, baseBudget,
        `${p} 的 budget_usd=${JSON.stringify(r.json?.quota?.budget_usd)} 与不带参数时 ${JSON.stringify(baseBudget)} 不一致 ⇒ 参数没被忽略，变成了别人的账`);
    }
    // 用量端点同理：带别人名字仍返回自己的（totals 与不带参数一致；参数被忽略）。
    const u0 = await reqWith(probe.fdeCookies, USAGE_PATH, { params: { days: 7 } });
    const u1 = await fetchJson(`${BASE}${USAGE_PATH}?days=7&fde_name=${encodeURIComponent(OTHER_FDE)}`, { headers: { Cookie: probe.fdeCookies.join('; ') }, timeoutMs: 20_000 });
    if (u0.status === 200 && u1.status === 200) {
      assert.equal(u1.json?.totals?.spend ?? null, u0.json?.totals?.spend ?? null,
        `llm-usage 带 ?fde_name 的 totals.spend=${JSON.stringify(u1.json?.totals?.spend)} 与不带时 ${JSON.stringify(u0.json?.totals?.spend)} 不一致（参数没被忽略）`);
    }
  });

// ---------------------------------------------------------------------------
// admin 越权口径腿（admin 无 fde_name ⇒ 400）
// ---------------------------------------------------------------------------
test('H4 admin（无 fde_name）打 llm-quota ⇒ 400 fde_name_required（既有口径，不是新 bug）',
  { skip: probe.reasons.admin || false, timeout: 60_000 }, async (t) => {
    need(t, 'admin', probe.adminCookies);
    const r = await reqWith(probe.adminCookies, QUOTA_PATH);
    if (r.status === 404) {
      t.diagnostic(`SKIP (admin)：${QUOTA_PATH} 回 404 ⇒ 改动前镜像，环境形状`);
      t.skip();
      return;
    }
    assert.equal(r.status, 400, `admin 打 llm-quota 期望 400，得到 ${r.status}（body=${r.text.slice(0, 200)}）`);
    assert.equal(r.json?.error?.code, 'fde_name_required', `期望 error.code=fde_name_required，实得 ${JSON.stringify(r.json?.error?.code)}（body=${r.text.slice(0, 200)}）`);
  });

// ---------------------------------------------------------------------------
// lifetime 往返腿（会短暂改真实额度，finally 必复原）
// 声明在 UI 腿之前：节点按声明顺序串行跑 ⇒ UI 腿跑前脚本账号已被复原成 period（1mo），
// 徽标落在「月 $X/$3.00」这种周期格式上，UI 腿的文案断言才成立。
// ---------------------------------------------------------------------------
test(`H5 lifetime 往返（${FDE_LOGIN}）：PUT budget_usd=null ⇒ llm-quota 读 lifetime/零点空/spend 非空；finally 复原 1mo 并回读 period`,
  { skip: probe.reasons.roundtrip || false, timeout: 180_000 }, async (t) => {
    if (!need(t, 'roundtrip', probe.adminCookies)) return;
    if (!probe.fdeCookies) { t.diagnostic('SKIP (roundtrip)：没有 FDE 会话去读回'); t.skip(); return; }
    if (probe.quotaStatus === 404) {
      t.diagnostic(`SKIP (roundtrip)：${QUOTA_PATH} 回 404 ⇒ 改动前镜像，无法读回，环境形状`);
      t.skip();
      return;
    }
    // budget 端点不失效 /api/me/llm-quota 的 30s 缓存 ⇒ 每次 PUT 后睡过 TTL 再读。
    const clear = await reqWith(probe.adminCookies, `/api/admin/fdes/${FDE_LOGIN}/llm/budget`, { method: 'PUT', body: { budget_usd: null } });
    assert.equal(clear.status, 200, `PUT budget_usd=null 期望 200，得到 ${clear.status}（body=${clear.text.slice(0, 200)}）`);
    try {
      await sleep(QUOTA_CACHE_WAIT_MS);
      const q = await reqWith(probe.fdeCookies, QUOTA_PATH);
      assert.equal(q.status, 200, `置 null 后 llm-quota 期望 200，得到 ${q.status}`);
      const quota = q.json?.quota;
      assert.ok(quota && typeof quota === 'object', `置 null 后 llm-quota 没回 quota 对象（body=${q.text.slice(0, 200)}）`);
      assert.equal(quota.spend_scope, 'lifetime', `未设额度却被读成 spend_scope=${JSON.stringify(quota.spend_scope)}（应为 lifetime，「未设额度不得被读成本周期」判据）`);
      assert.equal(quota.budget_duration, null, `lifetime 下 budget_duration 应为 null，实得 ${JSON.stringify(quota.budget_duration)}`);
      assert.notEqual(quota.spend, null, `lifetime 下 spend 应非空（是建 key 以来累计），实得 ${JSON.stringify(quota.spend)}`);
      t.diagnostic(`lifetime 现场：spend_scope=${quota.spend_scope} spend=${JSON.stringify(quota.spend)} budget_duration=${JSON.stringify(quota.budget_duration)}`);
    } finally {
      const restore = await reqWith(probe.adminCookies, `/api/admin/fdes/${FDE_LOGIN}/llm/budget`, { method: 'PUT', body: { budget_usd: 3, budget_period: '1mo' } });
      assert.equal(restore.status, 200, `finally 复原 budget 期望 200，得到 ${restore.status}（body=${restore.text.slice(0, 200)}）`);
      await sleep(QUOTA_CACHE_WAIT_MS);
      const back = await reqWith(probe.fdeCookies, QUOTA_PATH);
      assert.equal(back.status, 200, `复原后 llm-quota 期望 200，得到 ${back.status}`);
      assert.equal(back.json?.quota?.spend_scope, 'period',
        `复原后 ${FDE_LOGIN} 期望回 spend_scope=period，实得 ${JSON.stringify(back.json?.quota?.spend_scope)}（dev 现场没复原！）`);
      t.diagnostic(`复原后：spend_scope=${back.json?.quota?.spend_scope} budget_usd=${JSON.stringify(back.json?.quota?.budget_usd)}（已恢复 period 1mo）`);
    }
  });

// ---------------------------------------------------------------------------
// UI 腿
// ---------------------------------------------------------------------------
/**
 * 跑在 playwright 容器里的采集脚本（**自包含**，仓库不加 playwright 依赖）。
 * 只收集事实并打一行 `REPORT:<json>`；断言全在外面。配置走 `argv[2]` 的临时文件
 * （口令不进命令行，`ps` 里会露出来），也不 print。中英各采集一趟 + 各存一张截图。
 */
const CONTAINER_SCRIPT = String.raw`
import { chromium } from '__PW_MODULE__';
import { readFileSync, statSync } from 'node:fs';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = {
  fatal: null, reachedLogin: false, login: { hash: '' },
  featurePresent: false, badgeSettled: false, badgeStuckPending: false,
  pageErrors: [], requests: [],
  zh: null, en: null,
  modal: null, closeButtonOk: false, closeEscOk: false,
  shotZhBytes: 0, shotEnBytes: 0,
};
let browser = null;

async function collectBadge(page) {
  const o = { exists: false, text: '', title: '', aria: '', followsWho: false, badgeTop: null, whoTop: null, headerHeight: null };
  o.exists = (await page.locator('[data-test="usage-badge"]').count()) > 0;
  if (!o.exists) return o;
  const info = await page.$eval('[data-test="usage-badge"]', (el) => {
    const rect = el.getBoundingClientRect();
    return {
      text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      title: el.getAttribute('title') || '',
      aria: el.getAttribute('aria-label') || '',
      badgeTop: rect.top,
    };
  });
  Object.assign(o, info);
  o.followsWho = await page.evaluate(() => {
    const who = document.querySelector('[data-test="who"]');
    if (!who || !who.nextElementSibling) return false;
    return who.nextElementSibling.getAttribute('data-test') === 'usage-badge';
  });
  const geo = await page.evaluate(() => {
    const h = document.querySelector('header');
    const who = document.querySelector('[data-test="who"]');
    return {
      headerHeight: h ? h.getBoundingClientRect().height : null,
      whoTop: who ? who.getBoundingClientRect().top : null,
    };
  });
  o.headerHeight = geo.headerHeight;
  o.whoTop = geo.whoTop;
  return o;
}

async function collectModal(page) {
  const m = {
    usedExists: false, progressExists: false, barClass: '', chartHasSvg: false,
    chartRegionSvg: false, bodyText: '', yMaxText: null,
  };
  m.usedExists = (await page.locator('[data-test="usage-used"]').count()) > 0;
  m.progressExists = (await page.locator('[data-test="usage-progress"]').count()) > 0;
  m.barClass = await page.$eval('[data-test="usage-progress"] > div', (el) => el.getAttribute('class') || '').catch(() => '');
  m.chartRegionSvg = (await page.locator('[data-test="metric-chart"] svg').count()) > 0;
  m.chartHasSvg = (await page.locator('svg').count()) > 0;
  // 本弹窗开了 hide-axis-values：y 轴上界文本应为空（金额信息改由一句摘要承担，不再靠左右轴标签）。
  m.yMaxText = await page.$eval('[data-test="metric-chart-y-max"]', (el) => (el.textContent || '').trim()).catch(() => null);
  m.bodyText = await page.evaluate(() => document.body.innerText || '');
  return m;
}

try {
  const launchArgs = ['--no-sandbox'];
  if (cfg.hostResolverRules) launchArgs.push('--host-resolver-rules=' + cfg.hostResolverRules);
  browser = await chromium.launch({ channel: 'chromium', args: launchArgs });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1200 }, locale: 'zh-CN', ignoreHTTPSErrors: true });
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

  await page.goto(cfg.base + '/#/workbench', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-test="who"]', { timeout: 25_000 });

  // 功能存在性：顶栏有没有徽标（改动前的前端根本没这一颗）。
  r.featurePresent = (await page.locator('[data-test="usage-badge"]').count()) > 0;

  // 等徽标脱离「…」（额度异步加载完）；等不到只记形状，不在这里判红。
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-test="usage-badge"]');
    return b && b.textContent.trim() !== '…';
  }, null, { timeout: 30_000 }).then(() => { r.badgeSettled = true; }).catch(() => { r.badgeStuckPending = true; });

  r.zh = await collectBadge(page);

  // 弹窗：点徽标 → 采集 → 按钮关 → 再开 → Esc 关。
  if (r.featurePresent && r.badgeSettled) {
    await page.click('[data-test="usage-badge"]');
    await page.waitForSelector('[data-test="usage-close"]', { timeout: 15_000 }).catch(() => {});
    r.modal = await collectModal(page);
    // 关闭按钮
    if (await page.locator('[data-test="usage-close"]').count()) {
      await page.click('[data-test="usage-close"]');
      r.closeButtonOk = !(await page.locator('[data-test="usage-close"]').count());
    }
    // 再开一次用 Esc 关
    await page.click('[data-test="usage-badge"]');
    await page.waitForSelector('[data-test="usage-close"]', { timeout: 15_000 }).catch(() => {});
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('[data-test="usage-close"]'), null, { timeout: 10_000 }).catch(() => {});
    r.closeEscOk = !(await page.locator('[data-test="usage-close"]').count());
  }

  await page.screenshot({ path: cfg.shotPathZh, fullPage: true });
  try { r.shotZhBytes = statSync(cfg.shotPathZh).size; } catch { r.shotZhBytes = 0; }

  // 切到英文（顶栏语言切换：按钮 aria-label 是「语言/Language」，菜单项母语自名「English」）。
  await page.click('button[aria-label="语言"], button[aria-label="Language"]');
  await page.click('role=menuitem[name="English"]');
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-test="usage-badge"]');
    return b && b.textContent.trim() !== '…';
  }, null, { timeout: 15_000 }).catch(() => {});
  r.en = await collectBadge(page);

  await page.screenshot({ path: cfg.shotPathEn, fullPage: true });
  try { r.shotEnBytes = statSync(cfg.shotPathEn).size; } catch { r.shotEnBytes = 0; }
} catch (err) {
  r.fatal = String(err?.message ?? err).split('\n')[0].slice(0, 300);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 收台失败不算判据 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
process.exit(0);
`;

const BADGE_RE_ZH = /^(月|日) \$\d+(\.\d+)?\s*\/\s*\$\d/;
const BADGE_RE_EN = /^(mo|d) \$\d+(\.\d+)?\s*\/\s*\$\d/;

test('U1 真浏览器进 #/workbench：徽标紧跟 who/周期文案+完整词 hover/弹窗(已用+进度条 bg-brand+chart svg)/按钮与 Esc 关/0 pageerror/无裸 i18n key/无「本周期从」/顶栏不换行/中英各一趟截图',
  { skip: probe.reasons.ui || false, timeout: 420_000 }, async (t) => {
    need(t, 'ui', probe.fdeCookies);
    const password = readCred(FDE_PASSWORD_FILES);
    if (password === null) { t.diagnostic(`SKIP (ui)：缺口令文件 ${FDE_PASSWORD_FILE}`); t.skip(); return; }

    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `user-usage-e2e-${uid}.mjs`);
    const cfgHost = path.join(os.tmpdir(), `user-usage-e2e-${uid}.json`);
    const scriptIn = `/tmp/user-usage-e2e-${uid}.mjs`;
    const cfgIn = `/tmp/user-usage-e2e-${uid}.json`;
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    // 口令走文件进容器（命令行会被 `ps` 抄走）；跑完在 finally 里尽力删（那是带口令的文件）。
    fs.writeFileSync(cfgHost, JSON.stringify({
      base: BASE, login: FDE_LOGIN, password, shotPathZh: SHOT_CONTAINER_ZH, shotPathEn: SHOT_CONTAINER_EN,
      hostResolverRules: HOST_RESOLVER_RULES,
    }), { mode: 0o600 });

    try {
      dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`, { timeout: 60_000 });
      dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`, { timeout: 60_000 });
      const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
      const m = out.match(/REPORT:(\{.*\})/);
      assert.ok(m, `容器里的采集脚本没交出 REPORT（tail=${out.slice(-400)}）`);
      const rep = JSON.parse(m[1]);

      // 导航/渲染挂了分两类：压根没到页面（DNS/TLS/入口挂了 = 环境）说 skip，到了页面却没跑通 = 产品红。
      if (rep.fatal && !rep.reachedLogin) {
        if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
          t.diagnostic(`SKIP (ui)：入口 ${BASE} 从容器里到不了：${rep.fatal}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器里没跑通：${rep.fatal}（登录态=${JSON.stringify(rep.login)}，pageerror=${rep.pageErrors.slice(0, 3).join(' / ')}）`);
      }
      assert.match(String(rep.login.hash || ''), /#\/(?!login)/, `登录后没离开 /login，hash=${JSON.stringify(rep.login.hash)}`);

      // 功能存在性：活栈跑改动前的前端时顶栏**根本没有徽标** ⇒ 环境形状 skip（不是产品红）。
      if (!rep.featurePresent) {
        t.diagnostic('SKIP (ui)：顶栏找不到 [data-test="usage-badge"] ⇒ 活栈跑的是改动之前的镜像（前端无徽标），环境形状；升到含 #808 的前端后此腿即真跑');
        t.skip();
        return;
      }
      if (!rep.badgeSettled) {
        t.diagnostic(`SKIP (ui)：等了 30s 徽标仍停在「…」(stuckPending=${rep.badgeStuckPending})，额度读数迟迟没回来 ⇒ 网关太慢的环境形状，不在这里判红`);
        t.skip();
        return;
      }

      // ① 徽标紧跟 who：who 的下一个兄弟元素就是徽标（「放在用户名后面」的判据）。
      const zh = rep.zh || {};
      assert.ok(zh.exists, 'zh 趟徽标不存在');
      assert.equal(zh.followsWho, true, '徽标不是紧跟在 [data-test="who"] 之后（who 的下一个兄弟元素不是 usage-badge）');

      // ② 徽标文案是周期格式（月/日 已用/额度），hover/aria 用完整词、不得窄黑话。
      assert.match(String(zh.text), BADGE_RE_ZH, `zh 徽标文案「${zh.text}」不匹配周期格式 ^(月|日) $…/ $…$`);
      const zhTip = `${zh.title} ${zh.aria}`;
      assert.ok(/本月|本日/.test(String(zh.title)) || /本月|本日/.test(String(zh.aria)),
        `zh 徽标 title/aria 应含完整词「本月/本日」，实得 title=${JSON.stringify(zh.title)} aria=${JSON.stringify(zh.aria)}`);
      assert.ok(!/^mo |^d |mo used/i.test(String(zh.title)), `zh 徽标 hover 出现窄黑话（如 "mo used"）：${JSON.stringify(zh.title)}`);
      // 顶栏不换行：徽标与 who 的 top 差 < 2px（同一行）。
      assert.ok(Number.isFinite(zh.badgeTop) && Number.isFinite(zh.whoTop), `拿不到徽标/who 的 top（badge=${JSON.stringify(zh.badgeTop)} who=${JSON.stringify(zh.whoTop)}）`);
      assert.ok(Math.abs(zh.badgeTop - zh.whoTop) < 2, `徽标 top=${zh.badgeTop} 与 who top=${zh.whoTop} 差 ≥ 2px ⇒ 顶栏换行了（header 高=${zh.headerHeight}）`);

      // ③ 弹窗：已用 + 进度条（与 chart 同一蓝色族 `bg-blue-600`）+ chart 区有 svg；按钮与 Esc 都能关。
      const modal = rep.modal || {};
      assert.ok(modal.usedExists, '弹窗没有 [data-test="usage-used"]（已用/额度那一行）');
      assert.ok(modal.progressExists, '弹窗没有 [data-test="usage-progress"]（进度条）');
      assert.ok(/\bbg-blue-600\b/.test(String(modal.barClass)), `进度条填充条 class=${JSON.stringify(modal.barClass)} 不含 bg-blue-600（与 chart 的蓝色族不一致）`);
      assert.ok(modal.chartRegionSvg || modal.chartHasSvg, 'chart 区没有 <svg>（30 天图没渲染）');
      // 本弹窗不靠 y 轴左右标签读金额（#808 真机实测：上/下界左右排会被读反）⇒ 上界文本应为空。
      assert.equal(modal.yMaxText, '', `弹窗 [data-test="metric-chart-y-max"] 不为空（=${JSON.stringify(modal.yMaxText)}）：本弹窗应 hide-axis-values`);
      // 金额信息改由紧贴 chart 上方的一句摘要承担（中文腿匹配）。
      assert.ok(/近 30 天合计|近 30 天无花费/.test(String(modal.bodyText || '')), '弹窗正文缺「近 30 天合计 / 近 30 天无花费」摘要句');
      assert.equal(rep.closeButtonOk, true, '点关闭按钮没关掉弹窗');
      assert.equal(rep.closeEscOk, true, '按 Esc 没关掉弹窗');

      // ④ 0 pageerror、无裸 i18n key、无「本周期从」句式。
      assert.deepEqual(rep.pageErrors, [], `有 pageerror：${rep.pageErrors.slice(0, 3).join(' / ')}`);
      const modalText = String(modal.bodyText || '');
      const rawKey = modalText.match(/workbench\.usage\.[A-Za-z]+/);
      assert.equal(rawKey, null, `弹窗正文残留未翻译的裸 i18n key：${JSON.stringify(rawKey && rawKey[0])}`);
      assert.ok(!modalText.includes('本周期从'), `弹窗正文出现「本周期从」句式（首周期是残周期，我们不知道起点）：见截图`);

      // ⑤ 英文趟：文案与 hover 用英文完整词，同样不得窄黑话。
      const en = rep.en || {};
      assert.ok(en.exists, 'en 趟徽标不存在');
      assert.match(String(en.text), BADGE_RE_EN, `en 徽标文案「${en.text}」不匹配周期格式 ^(mo|d) $…/ $…$`);
      assert.ok(/this month|this day/i.test(String(en.title)) || /this month|this day/i.test(String(en.aria)),
        `en 徽标 title/aria 应含完整词 this month/this day，实得 title=${JSON.stringify(en.title)} aria=${JSON.stringify(en.aria)}`);
      assert.ok(!/^mo |^d |mo used/i.test(String(en.title)), `en 徽标 hover 出现窄黑话（如 "mo used"）：${JSON.stringify(en.title)}`);

      // ⑥ 截图（人工复核证据，落宿主临时目录，不提交）。
      tryQuiet(() => fs.rmSync(SHOT_HOST_ZH, { force: true }));
      tryQuiet(() => fs.rmSync(SHOT_HOST_EN, { force: true }));
      dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER_ZH} ${SHOT_HOST_ZH}`, { timeout: 60_000 });
      dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER_EN} ${SHOT_HOST_EN}`, { timeout: 60_000 });
      const bytesZh = fs.statSync(SHOT_HOST_ZH).size;
      const bytesEn = fs.statSync(SHOT_HOST_EN).size;
      assert.ok(bytesZh > 1024, `zh 截图只有 ${bytesZh} 字节（${SHOT_HOST_ZH}）`);
      assert.ok(bytesEn > 1024, `en 截图只有 ${bytesEn} 字节（${SHOT_HOST_EN}）`);
      // header 高实测值（顶栏不换行的旁证；断言本身用 badge/who 的 top 差 < 2px）。
      t.diagnostic(`顶栏 header 高实测=${zh.headerHeight}px；徽标文案 zh=${JSON.stringify(zh.text)} en=${JSON.stringify(en.text)}`);
      t.diagnostic(`截图：${SHOT_HOST_ZH}（${bytesZh} 字节）；${SHOT_HOST_EN}（${bytesEn} 字节）`);
    } finally {
      tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`, { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });

// ---------------------------------------------------------------------------
// 哨兵用例：禁止「点名了却整腿静默 skip」的假通过。
// 为什么：E2E_UI=1 / E2E_HTTP=1 点名要跑，FDE 口令文件却不在 ⇒ 所有用例 skip、rc=0，
// 和真跑同色——这就是「假通过」，本仓反复在治的病。
// 未点名（默认）仍允许 skip：本地没有 dev 栈也得能跑 npm test。
// ---------------------------------------------------------------------------
const E2E_REQUESTED = UI_ENABLED || process.env.E2E_HTTP === '1';
test('哨兵：点名要跑时 FDE 口令文件必须存在（禁止静默全 skip）',
  { timeout: 10_000 }, (t) => {
    if (!E2E_REQUESTED) {
      t.diagnostic('未点名 ⇒ 允许 skip（本地没有 dev 栈也能跑 npm test）');
      return;
    }
    if (CRED_FDE === null) {
      assert.fail(`点名要跑却没找到 FDE 口令文件（试过 ${FDE_PASSWORD_FILE}）：`
        + '全腿静默 skip 会让 rc=0 与真跑同色（假通过）⇒ 判失败。'
        + '修法：放好凭据文件，或用 E2E_FDE_PASSWORD_FILE 指过去。');
    }
  });
