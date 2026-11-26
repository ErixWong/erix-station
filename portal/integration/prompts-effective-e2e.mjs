// issue #801：管理台「提示词」页**生效面**的集成 e2e（**真机活栈**，不新起隔离栈）。
//
// 这是把一次手工跑通的真机 e2e 收编进仓库的版本（口径照 `seat-content-e2e.mjs`：
// 验的是**本机活着的那套栈**，缺东西就 skip 而不是把环境形状算成产品红）。
//
// 两条腿：
//   · HTTP 腿：登 admin → 读生效面 DTO（顶层 8 键 / 两份账 / 真工位名）→ 负例三条
//     （缺 fde / 不存在工位 / 非 GET）→ 存一段带标记的追加段 ⇒ 先「不一致」再等物化
//     收敛成「一致」，finally 必把那一格复位成空串并等盘上那份也跟上（别把 dev 栈留脏）。
//   · UI 腿（`E2E_UI=1` 且 playwright 容器在跑才跑）：真浏览器进 `#/admin/prompts`，
//     钉生效卡在编辑卡之前、两份全文各自长度、重读反馈、内置标题全文、裸 i18n key 哨兵、
//     0 pageerror，并落两张截图供人眼 / vision 复核。
//
// 为什么这样写（沿用 seat-content 的约定，别处已论证，这里只记本单相关的几条）：
//   1. admin host 是自签证书 ⇒ 本进程关 TLS 校验（只影响这个测试进程）。
//   2. 口令只读凭据目录里 dev 口令文件（新路径优先、旧路径兜底），**绝不 print**；
//      进容器走临时文件（防 `ps` 抄走），跑完在 finally 里尽力删（那是带口令的文件）。
//   3. 走 docker 包装层时命令串**不许含换行**（version-surface 头注 F-6）。
//   4. UI 腿把 playwright 留在**容器里**（`/app/node_modules/playwright`），仓库**不**加
//      这个依赖；采集脚本自包含，断言全在外层做（容器里 assert 拿不到有用信息）。
//   5. 本腿**不点名就整只 skip**（默认 `node --test` 全 skip ⇒ rc=0，本地没有 dev 栈也能跑）：
//      生效面会写 dev 库（A3 存/复位追加段），比只读页更重，所以连 HTTP 腿也要点名才跑。
//   6. 点名（`E2E_UI=1`）却缺口令文件 / 没有 playwright 容器 ⇒ **退 1**（哨兵用例），
//      不许静默全 skip 拿 rc=0（假通过）——比 seat 只查口令更严，这里连容器装配失败也判红。
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
// 凭据目录口径（AGENTS §4）：~/.config/ 下 mcp/creds/；env 点名只信 env。
const PASSWORD_FILE_CANDIDATES = (process.env.ADMIN_PASSWORD_FILE
  ? [process.env.ADMIN_PASSWORD_FILE]
  : ['~/.config/mcp/creds/station-dev.password', '~/.config/creds/station-dev-password-file'])
  .map((p) => p.replace(/^~/, os.homedir()));
/** 报错文案用：缺口令时列出试过的路径（新前旧后）。 */
const PASSWORD_FILE = PASSWORD_FILE_CANDIDATES.join(' 或 ');
/** 本腿两条腿都要点名才跑（A3 会写 dev 库，比只读页重）。 */
const UI_ENABLED = process.env.E2E_UI === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
/** 截图落宿主临时目录（跑完留着并打印路径，供人眼 / vision 复核；临时脚本 / 配置才删）。 */
const SHOT_HOST_A = process.env.E2E_SHOT_HOST_A || path.join(os.tmpdir(), 'prompts-effective-e2e-a.png');
const SHOT_HOST_B = process.env.E2E_SHOT_HOST_B || path.join(os.tmpdir(), 'prompts-effective-e2e-b.png');
/** 写进 dev 库的那段带标记的追加段正文（复位后必须从盘上那份消失）。 */
const MARK = 'E2E801 收工前必须跑 npm test。';
const SECTION_TITLE = '平台补充约定（由平台管理员撰写）';
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
/** 与 `HOST_MAP` 同源：给浏览器也加 `MAP <host> <ip>`（playwright 容器跑 host 网络）。 */
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
 * 用 `node:https` 而不是全局 `fetch`：全局 fetch 没法同时「连 IP + 保持 SNI/Host 为域名」。
 * TCP 连 `HOST_MAP` 映到的 IP，但 `servername`（SNI）与 `Host` 头仍用域名。
 */
function httpRequest(urlStr, { method = 'GET', body, headers = {}, timeoutMs = 15_000 }) {
  const u = new URL(urlStr);
  const secure = u.protocol === 'https:';
  const transport = secure ? https : http;
  const allHeaders = { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Origin: BASE, ...headers, Host: u.host };
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

// ---------------------------------------------------------------------------
// 会话（登录一次，两条腿共用）。GET 走 cookie jar；A3 的写也走同一 jar。
// ---------------------------------------------------------------------------
const EFF_PATH = `/api/admin/prompts/effective-agents-md?fde=${encodeURIComponent(FDE)}`;
const cookies = new Map();
function cookieHeader() { return [...cookies.values()].join('; '); }
function absorb(res) {
  for (const c of res.cookies) { const i = c.indexOf('='); if (i > 0) cookies.set(c.slice(0, i), c); }
  return res;
}
function api(p, opts = {}) {
  return fetchJson(BASE + p, { ...opts, headers: { ...(cookieHeader() ? { Cookie: cookieHeader() } : {}), ...(opts.headers || {}) } })
    .then(absorb);
}

// ---------------------------------------------------------------------------
// 探测：把「能不能登进去 + UI 腿的环境形状」在模块加载时各取一次；只读不断言。
// reasons[leg] 有值 = 那条腿 skip（值是给人看的原因）；没有该 key = 那条腿要跑。
// `uiEnvBlocked`：点名了 UI 腿但环境装配不起来（缺容器 / 缺模块 / docker 不可用）——哨兵据此判红。
// `loginBlocked`：口令文件在、HTTP 也答了，但登录没拿到会话 cookie ⇒「栈活着而登录失败」不是
//   环境形状，哨兵据此判红；连接类失败（栈没起）不置它，那才是合法的 skip。
// ---------------------------------------------------------------------------
const probe = { reasons: {}, uiEnvBlocked: false, loginStatus: null, loginBlocked: false };

async function gather() {
  // 本腿两条腿都要点名才跑：A3 会写 dev 库，默认 `node --test` 整只 skip（rc=0）。
  if (!UI_ENABLED) {
    const why = '本腿要点名才跑（生效面 A3 会写 dev 库）：E2E_UI=1 才跑 HTTP + UI 两条腿';
    probe.reasons.http = why;
    probe.reasons.ui = why;
    return;
  }
  const password = readPassword();
  if (password === null) {
    const why = `缺管理员口令文件 ${PASSWORD_FILE}（明文不入库，轮换就改这个文件）`;
    probe.reasons.http = why;
    probe.reasons.ui = `${why} ⇒ UI 腿要登管理台`;
    return; // 哨兵据 CRED_PASSWORD===null 判红
  }
  let login;
  try {
    login = await fetchJson(`${BASE}/api/auth/login`, { method: 'POST', body: { login: ADMIN_LOGIN, password }, timeoutMs: 20_000 });
  } catch (err) {
    probe.reasons.http = err.message;
    probe.reasons.ui = `${err.message} ⇒ UI 腿要登管理台`;
    return;
  }
  absorb(login);
  probe.loginStatus = login.status;
  if (login.status !== 200 || login.cookies.length === 0) {
    const code = login.json?.error?.code;
    // 拿到了 HTTP 响应但没有会话 cookie：dev 栈是活的，这不是「环境没起」的形状 ⇒ 哨兵判红用。
    probe.loginBlocked = true;
    probe.reasons.http = `登录没拿到会话 cookie（HTTP ${login.status}${code ? ` ${code}` : ''}`
      + `${login.json?.pending_token ? '，响应带 pending_token ⇒ 这个账号开了第二因素，本脚本只会口令直通' : ''}）`;
    probe.reasons.ui = `${probe.reasons.http} ⇒ UI 腿要登管理台`;
    return;
  }
  // UI 腿环境：docker + 容器在跑 + 里面有 playwright。任一不满足 ⇒ uiEnvBlocked（哨兵判红）。
  const d = dockerProbe();
  if (d !== true) {
    probe.reasons.ui = typeof d === 'object' ? d.reason : 'docker 不可用';
    probe.uiEnvBlocked = true;
  } else if (!containerRunning(PW_CONTAINER)) {
    probe.reasons.ui = `E2E_UI=1 但 playwright 容器 ${PW_CONTAINER} 不在跑（PLAYWRIGHT_CONTAINER 可指到别的）`;
    probe.uiEnvBlocked = true;
  } else {
    try {
      dockerRun(`exec ${PW_CONTAINER} sh -c "test -f ${PW_MODULE}"`, { timeout: 30_000 });
    } catch {
      probe.reasons.ui = `容器 ${PW_CONTAINER} 里没有 ${PW_MODULE}（UI 腿用容器里的 playwright，仓库不加这个依赖）`;
      probe.uiEnvBlocked = true;
    }
  }
}
await gather();

for (const [leg, label] of [['http', 'HTTP 腿（生效面 DTO + 负例 + 存/复位追加段收敛）'], ['ui', 'B1 管理台「提示词」页生效面（真浏览器）']]) {
  console.log(probe.reasons[leg] ? `[prompts-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}` : `[prompts-e2e] leg=${leg} (${label}) 开跑`);
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
test('A1 生效面 DTO 形状与两份账', { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
  need(t, 'http', cookieHeader());
  const r = await api(EFF_PATH);
  assert.equal(r.status, 200, `生效面期望 200，得到 ${r.status}：${(r.text || '').slice(0, 160)}`);
  const d = r.json ?? {};
  const keys = Object.keys(d).sort().join(',');
  assert.equal(keys, 'db,disk,expected,fdeName,matches,reason,renderLimitBytes,source',
    `顶层键集合不是那 8 个：${keys}`);
  assert.equal(d.fdeName, FDE, `fdeName 不是请求的那个工位（期望 ${FDE}，得到 ${d.fdeName}）`);
  assert.ok(['ok', 'missing', 'not_a_file', 'read_failed'].includes(d.disk?.state), `disk.state 不在四值内：${d.disk?.state}`);
  assert.ok((d.disk?.bytes ?? 0) > 0, `disk.bytes 应为非零（dev 现成工位已物化过）：${d.disk?.bytes}`);
  assert.ok((d.disk?.text ?? '').length > 0, 'disk.text 为空');
  // 该有那份的末尾标识行用的是**真工位名**，不是示例名 example。
  const tail = (d.expected?.text ?? '');
  assert.ok(tail.includes(`（FDE 标识：${FDE}）`), `expected.text 末尾标识行没用真工位名 ${FDE}：tail=${tail.slice(-40).replace(/\n/g, '\\n')}`);
  assert.ok(!tail.includes('标识：example'), 'expected.text 还带着示例名 example 的标识行');
});

test('A2 负例三条', { skip: probe.reasons.http || false, timeout: 60_000 }, async (t) => {
  need(t, 'http', cookieHeader());
  const noFde = await api('/api/admin/prompts/effective-agents-md');
  assert.equal(noFde.status, 400, `缺 fde 期望 400，得到 ${noFde.status}`);
  assert.equal(noFde.json?.error?.details?.field, 'fde', `缺 fde 的 details.field 不是 fde：${JSON.stringify(noFde.json?.error?.details)}`);
  const ghost = await api('/api/admin/prompts/effective-agents-md?fde=nope-not-here-801');
  assert.equal(ghost.status, 404, `不存在工位期望 404，得到 ${ghost.status}`);
  assert.equal(ghost.json?.error?.code, 'not_found', `不存在工位期望 not_found，得到 ${JSON.stringify(ghost.json?.error?.code)}`);
  const post = await api(EFF_PATH, { method: 'POST' });
  assert.equal(post.status, 405, `非 GET 期望 405，得到 ${post.status}`);
});

test('A3 存追加段 ⇒ 先不一致再收敛', { skip: probe.reasons.http || false, timeout: 300_000 }, async (t) => {
  need(t, 'http', cookieHeader());
  let sawStale = false;
  let converged = null;
  try {
    // 写入与两条断言必须在 try **内**：断言一失败也要走 finally 的复位，否则 dev 栈被留在脏标记上。
    const save = await api('/api/admin/prompts/addendum', { method: 'PUT', body: { text: MARK } });
    assert.equal(save.status, 200, `存追加段期望 200，得到 ${save.status}`);
    assert.ok((save.json?.materializeEnqueued ?? 0) > 0, `materializeEnqueued 应 >0，得到 ${save.json?.materializeEnqueued}`);

    for (let i = 0; i < 40; i += 1) {
      const d = (await api(EFF_PATH)).json ?? {};
      if (d.matches === false) sawStale = true;
      if (d.matches === true) { converged = d; break; }
      await sleep(3000);
    }
    assert.ok(sawStale, '保存后没等到一次「盘上那份还没跟上」（matches===false）⇒ 通知可能当场就收敛了或没触发比对');
    assert.ok(converged !== null, '120s 内没等到 matches===true ⇒ 通知没发出去或渲染不同数');
    const disk = converged.disk?.text ?? '';
    const expected = converged.expected?.text ?? '';
    assert.ok(disk.includes('E2E801') && expected.includes('E2E801'), '收敛后正文里找不到刚存的追加段标记');
    assert.ok(disk.includes(SECTION_TITLE), `收敛后盘上那份缺追加段那一节的标题「${SECTION_TITLE}」`);
  } finally {
    // 复位成空串（跟随内置）并等盘上那份也跟上；复位失败 ⇒ 判红，别把 dev 栈留在脏状态。
    const back = await api('/api/admin/prompts/addendum', { method: 'PUT', body: { text: '' } });
    assert.equal(back.status, 200, `复位 PUT 期望 200，得到 ${back.status}（dev 栈可能已被这段追加段弄脏）`);
    let clean = false;
    for (let i = 0; i < 30; i += 1) {
      const d = (await api(EFF_PATH)).json ?? {};
      if (d.matches === true && !(d.disk?.text ?? '').includes('E2E801')) { clean = true; break; }
      await sleep(3000);
    }
    assert.ok(clean, '复位后 90s 内没等到「matches===true 且盘上那份不含标记」⇒ 别把 dev 栈留在脏状态');
  }
});

// ---------------------------------------------------------------------------
// 容器里跑的采集脚本（自包含；断言全在外层做）。口径照 seat-content-e2e.mjs。
// ⚠ 两份全文的长度要拿**未截断**的 textContent 量（别拿截断后的字符串比 > 1500）。
// ---------------------------------------------------------------------------
const CONTAINER_SCRIPT = String.raw`
import { chromium } from '__PW_MODULE__';
import { readFileSync, statSync } from 'node:fs';
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = { fatal: null, facts: {}, pageErrors: [], shots: {} };
let browser = null;
const dt = (page, name) => page.locator('[data-test="' + name + '"]');
const txt = async (page, name) => { const l = dt(page, name); return (await l.count()) > 0 ? (await l.first().innerText()).slice(0, 400) : null; };
const fullLen = async (page, name) => { const l = dt(page, name); if ((await l.count()) === 0) return -1; return (await l.first().evaluate((el) => el.textContent || '')).length; };
const has = async (page, name) => (await dt(page, name).count()) > 0;
try {
  browser = await chromium.launch({ channel: 'chromium', args: ['--no-sandbox', '--host-resolver-rules=' + cfg.resolver] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 }, locale: 'zh-CN', ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.pageErrors.push(String(e?.message ?? e)));
  await page.goto(cfg.base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20_000 });
  await page.fill('#loginName, input[autocomplete="username"]', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20_000 });
  await page.goto(cfg.base + '/#/admin/prompts', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('[data-test="card-addendum"]', { timeout: 20_000 });
  await page.waitForSelector('[data-test="card-effective"]', { timeout: 20_000 });

  // 生效卡必须在编辑卡之前。
  r.facts.cardOrder = await page.evaluate(() => {
    const a = document.querySelector('[data-test="card-effective"]');
    const b = document.querySelector('[data-test="card-addendum"]');
    return a && b ? (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? 'effective_first' : 'effective_last') : 'missing';
  });
  r.facts.fdeOptions = await dt(page, 'effective-fde-select').locator('option').count();
  if (r.facts.fdeOptions > 0) {
    await page.selectOption('[data-test="effective-fde-select"]', cfg.fde);
    await page.waitForTimeout(2500);
  }
  r.facts.verdict = await txt(page, 'effective-verdict');
  // 两份全文各自展开后测**完整**长度（fullLen 不截断）。
  await page.click('[data-test="toggle-disk-text"]').catch(() => {});
  await page.click('[data-test="toggle-expected-text"]').catch(() => {});
  await page.waitForTimeout(400);
  r.facts.diskTextLen = await fullLen(page, 'disk-text');
  r.facts.expectedTextLen = await fullLen(page, 'expected-text');
  r.facts.placeholder = await page.getAttribute('[data-test="input-addendum"]', 'placeholder');
  await page.screenshot({ path: cfg.shotA, fullPage: true });
  try { r.shots.a = (() => { try { return statSync(cfg.shotA).size; } catch { return 0; } })(); } catch {}

  // 标题提示词：内置全文给不给。
  await page.click('[data-test="toggle-title-default"]').catch(() => {});
  await page.waitForTimeout(400);
  r.facts.titleDefault = await txt(page, 'title-default-text');

  // 重新读取：先写草稿 ⇒ 按钮文案含「放弃」；点 ⇒ 出现「已重新读取 <时间>」且草稿回落。
  await page.fill('[data-test="input-addendum"]', '没保存的草稿');
  await page.waitForTimeout(300);
  r.facts.reloadLabel = await txt(page, 'prompts-reload-label');
  r.facts.reloadedBefore = await has(page, 'prompts-reloaded-at');
  await page.click('[data-test="prompts-reload"]');
  await page.waitForTimeout(2500);
  r.facts.reloadedAfter = await has(page, 'prompts-reloaded-at');
  r.facts.reloadedText = await txt(page, 'prompts-reloaded-at');
  r.facts.draftAfterReload = await page.inputValue('[data-test="input-addendum"]');
  await page.screenshot({ path: cfg.shotB, fullPage: true });
  try { r.shots.b = (() => { try { return statSync(cfg.shotB).size; } catch { return 0; } })(); } catch {}
  r.facts.rawI18nKey = (await page.locator('body').innerText()).includes('admin.prompts.');
} catch (err) {
  r.fatal = String(err?.message ?? err).split('\n')[0].slice(0, 300);
} finally {
  if (browser) { try { await browser.close(); } catch { /* 收台失败不算判据 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
process.exit(0);
`;

test('B1 真浏览器进 `#/admin/prompts`：生效卡在前 + 两份全文 + 重读反馈 + 0 pageerror + 无裸 i18n key',
  { skip: probe.reasons.ui || false, timeout: 420_000 }, async (t) => {
    need(t, 'ui', cookieHeader());
    const password = readPassword();
    if (password === null) { t.diagnostic(`SKIP (ui)：缺口令文件 ${PASSWORD_FILE}`); t.skip(); return; }

    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `prompts-effective-e2e-${uid}.mjs`);
    const cfgHost = path.join(os.tmpdir(), `prompts-effective-e2e-${uid}.json`);
    const scriptIn = `/tmp/prompts-effective-e2e-${uid}.mjs`;
    const cfgIn = `/tmp/prompts-effective-e2e-${uid}.json`;
    const shotInA = `/tmp/prompts-effective-e2e-${uid}-a.png`;
    const shotInB = `/tmp/prompts-effective-e2e-${uid}-b.png`;
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    // 口令走文件进容器（命令行会被 `ps` 抄走）；跑完在 finally 里尽力删（那是带口令的文件）。
    fs.writeFileSync(cfgHost, JSON.stringify({
      base: BASE, login: ADMIN_LOGIN, password, fde: FDE, resolver: HOST_RESOLVER_RULES, shotA: shotInA, shotB: shotInB,
    }), { mode: 0o600 });

    try {
      dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`, { timeout: 60_000 });
      dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`, { timeout: 60_000 });
      const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
      const m = out.match(/REPORT:(\{.*\})/);
      assert.ok(m, `容器里的采集脚本没交出 REPORT（tail=${out.slice(-400)}）`);
      const rep = JSON.parse(m[1]);

      // 导航挂了分两类：压根没到页面（网络 / 入口挂了 = 环境）说 skip，到了页面却没跑通 = 产品红。
      if (rep.fatal && !rep.facts?.cardOrder) {
        if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
          t.diagnostic(`SKIP (ui)：管理台入口 ${BASE} 从容器里到不了：${rep.fatal}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器里没跑通：${rep.fatal}（pageerror=${(rep.pageErrors || []).slice(0, 3).join(' / ')}）`);
      }
      const f = rep.facts;
      assert.equal(f.cardOrder, 'effective_first', `生效卡没排在编辑卡之前（cardOrder=${f.cardOrder}）`);
      assert.ok(f.fdeOptions > 0, `工位下拉没有选项（fdeOptions=${f.fdeOptions}）`);
      assert.ok(typeof f.verdict === 'string' && f.verdict.length > 0, `effective-verdict 为空：${JSON.stringify(f.verdict)}`);
      assert.ok(f.diskTextLen > 1500, `盘上那份展开后长度不够（diskTextLen=${f.diskTextLen}，须 >1500）`);
      assert.ok(f.expectedTextLen > 1500, `该有那份展开后长度不够（expectedTextLen=${f.expectedTextLen}，须 >1500）`);
      assert.ok(typeof f.placeholder === 'string' && f.placeholder.includes('不覆写'), `编辑框 placeholder 没说明「留空 = 不覆写」：${JSON.stringify(f.placeholder)}`);
      assert.ok(typeof f.reloadLabel === 'string' && f.reloadLabel.includes('放弃'), `有草稿时按钮文案没含「放弃」：${JSON.stringify(f.reloadLabel)}`);
      assert.equal(f.reloadedAfter, true, '点重新读取后没出现 prompts-reloaded-at');
      assert.match(String(f.reloadedText ?? ''), /:/, `重读时间戳不含时刻：${JSON.stringify(f.reloadedText)}`);
      assert.equal(f.draftAfterReload, '', `重读没把草稿回落到落库值：${JSON.stringify(f.draftAfterReload)}`);
      assert.ok(typeof f.titleDefault === 'string' && f.titleDefault.length > 10, `内置标题全文为空（len=${f.titleDefault?.length}）`);
      assert.equal(f.rawI18nKey, false, '页面残留未翻译的裸 key「admin.prompts.」');
      assert.deepEqual(rep.pageErrors, [], `有 pageerror：${(rep.pageErrors || []).slice(0, 3).join(' / ')}`);

      // 截图：落容器 /tmp 后 docker cp 到宿主临时目录并打印路径；**截图留着**（供人眼 / vision 复核），
      // 跑完只删临时脚本 / 配置。
      tryQuiet(() => fs.rmSync(SHOT_HOST_A, { force: true }));
      tryQuiet(() => fs.rmSync(SHOT_HOST_B, { force: true }));
      dockerRun(`cp ${PW_CONTAINER}:${shotInA} ${SHOT_HOST_A}`, { timeout: 60_000 });
      dockerRun(`cp ${PW_CONTAINER}:${shotInB} ${SHOT_HOST_B}`, { timeout: 60_000 });
      const bytesA = fs.statSync(SHOT_HOST_A).size;
      const bytesB = fs.statSync(SHOT_HOST_B).size;
      assert.ok(bytesA > 1024 && bytesB > 1024, `截图过小（A=${bytesA}B B=${bytesB}B）`);
      t.diagnostic(`截图留着：A=${SHOT_HOST_A}（${bytesA}B） B=${SHOT_HOST_B}（${bytesB}B）；verdict=${JSON.stringify(f.verdict)}`);
    } finally {
      // 删临时脚本 / 配置（带口令的文件必须删）；截图留在宿主临时目录不删。
      tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn} ${shotInA} ${shotInB}"`, { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });

// ---------------------------------------------------------------------------
// 哨兵用例：禁止「点名了却整腿静默 skip」的假通过。
// 为什么：E2E_UI=1 点名要跑，口令文件却不在 / playwright 容器却没起 ⇒ 所有用例 skip、rc=0，
// 和真跑同色——这就是「假通过」。本腿比 seat 更严：连「UI 腿装配不起来」也判红。
// 未点名（默认）仍允许 skip：本地没有 dev 栈也得能跑 node --test / npm test。
// ---------------------------------------------------------------------------
test('哨兵：点名要跑时口令文件与 playwright 容器必须齐（禁止静默全 skip）', { timeout: 10_000 }, (t) => {
  if (!UI_ENABLED) {
    t.diagnostic('未点名 ⇒ 允许整只 skip（本地没有 dev 栈也能跑 node --test）');
    return;
  }
  if (CRED_PASSWORD === null) {
    assert.fail(`E2E_UI=1 点名要跑却没找到口令文件（试过 ${PASSWORD_FILE}）：`
      + '全腿静默 skip 会让 rc=0 与真跑同色（假通过）⇒ 判失败。'
      + '修法：放好凭据文件，或用 ADMIN_PASSWORD_FILE 指过去。');
  }
  if (probe.uiEnvBlocked) {
    assert.fail(`E2E_UI=1 点名要跑但 UI 腿装配不起来：${probe.reasons.ui} ⇒ 判失败（不许静默 skip 拿 rc=0）。`);
  }
  if (probe.loginBlocked) {
    // 口令文件在（上面已验）却登录失败 ⇒ 栈活着；全腿 skip 拿 rc=0 是假通过，这不是 skip 的形状。
    // 只报 HTTP 状态与原因，**不要把口令值打进去**。
    assert.fail(`E2E_UI=1 点名要跑：口令文件在但登录没成（${probe.reasons.http || `HTTP ${probe.loginStatus}`}）：`
      + '栈活着而登录失败 ⇒ 这不是 skip 的形状（静默全 skip 会拿 rc=0 假通过）⇒ 判失败。');
  }
});
