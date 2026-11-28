#!/usr/bin/env node
// @ts-check
// 活栈 e2e（#817 管理台用户表列简化 / #818 管理台左侧分组侧栏）。
//
// 这两单当时是手工跑脚本验的，跑完脚本就没了——仓库里没有任何集成脚本覆盖它们。
// 本文件把那次手工取证固化成一支能重复跑的活栈资产：口径照 `llm-usage-e2e.mjs`
// （probe→skip→finally 清理→REPORT）与 `admin-locale-e2e.mjs`（管理台 host / 登录 /
// 截图 / `E2E_UI` 硬要求那条腿）。零新增依赖：只用 node 内置 + `node --test`，
// playwright 只在容器里用（本仓库不加这个依赖）。
//
// 两腿：
//   - 导航腿（#818）：分组侧栏 15 链接 / 6 组标题 / 「关于」底部固定不入组；逐条点进去
//     当前项 `aria-current="page"`；文档无横向溢出；侧栏与 main 两个滚动面；窄视口收成
//     图标轨仍不横向溢出；默认只展开当前组、导航到别组自动展开、刷新后从 localStorage 保持。
//   - 表格腿（#817）：`thead` 全部单行；窄视口表格外层滚动容器自己可横滚而页面不溢出；
//     「工位」列每行一个状态（`workspace 保留中` 只在 hover）；状态列是 `✓/◌/⊘` 形状不是
//     `●` 装饰点；动作列「会话/文件」「编辑」各含一个内联 `<svg>` 且文字仍在。
//
// 跳过语义（同 llm-usage / admin-locale，别自创）：
//   - 不带 `E2E_UI=1`：浏览器腿 skip 并写清原因；HTTP 腿（管理台入口未认证 401）总是跑。
//   - 带 `E2E_UI=1`：硬要求——缺口令 / docker 不可用 / 容器没跑 / 容器里没 playwright /
//     入口 `net::` 不通 ⇒ 一律判红，不许 skip 冒充通过；要退回 skip 必须显式 `E2E_UI_SOFT=1`。
//   - 活栈跑的是改动之前的镜像（没有侧栏分组或没有工位列）⇒ 浏览器腿按「环境形状」skip 并
//     写诊断，不为凑绿放宽断言。
//
// 口令只从本机凭据目录读（路径见 `PASSWORD_FILE_CANDIDATES`），绝不打印；进容器走临时文件、
// 跑完 finally 删。截图落宿主临时目录、路径打在输出里，不提交图片。
//
// 跑法：E2E_UI=1 npm run test:integration:admin-ui
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
// #897：宿主凭据路径与脚本账号默认登录名的**唯一来源**（坐标只许住在 lib/dev-creds.mjs，
// 闸 `check:doc-portable` 的窄判据会拦代码行里的新凭据字面）。
import { credsFileCandidates } from './lib/dev-creds.mjs';
// #932：软降级判据、E2E_UI_SOFT 判定、host-resolver 解析与拼接收成一份（唯一来源在 lib）。
import { shouldSoftSkip, uiSoft, hostResolverRules } from './lib/e2e-ui-soft.mjs';

// 自签证书（本机 CA 未进容器信任库），关掉校验；只在测试进程内生效，不外溢。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// 管理台入口（admin 子域 + 443 映射到宿主暴露的端口）。可用 `E2E_UI_BASE` / `E2E_BASE` 覆盖。
const BASE = (process.env.E2E_BASE || process.env.E2E_UI_BASE || 'https://admin.fde.erix.vip:9443').replace(/\/$/, '');
// dev 管理账号（与口令文件配对；口令绝不打印）。可用 `ADMIN_LOGIN` 覆盖。
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
// 口令候选：显式 `ADMIN_PASSWORD_FILE` 优先，否则走本机凭据目录（坐标由 #897 收敛到 lib/dev-creds.mjs）。
const PASSWORD_FILE_CANDIDATES = (process.env.ADMIN_PASSWORD_FILE
  ? [process.env.ADMIN_PASSWORD_FILE]
  : credsFileCandidates('admin'))
  .map((p) => p.replace(/^~/, os.homedir()));
const PASSWORD_FILE = PASSWORD_FILE_CANDIDATES.join(' 或 ');

const UI_ENABLED = process.env.E2E_UI === '1';
// #932：软开关在**模块加载时**读一次（与 admin-locale 同一时机，免得两处语义不同）。
const UI_SOFT = uiSoft();
// #932：`E2E_UI_SOFT` 判定改用 lib 的 `uiSoft()`（唯一来源），本文件不再单独定义 `UI_SOFT`。

const PW_CONTAINER = 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
// 截图先落 playwright 容器的 /tmp，再由本进程取回到宿主临时目录（不提交）。
const SHOT_WIDE_CONTAINER = '/tmp/admin-nav-cols-e2e-wide.png';
const SHOT_NARROW_CONTAINER = '/tmp/admin-nav-cols-e2e-narrow.png';
const SHOT_WIDE_HOST = path.join(os.tmpdir(), 'admin-nav-cols-e2e-wide.png');
const SHOT_NARROW_HOST = path.join(os.tmpdir(), 'admin-nav-cols-e2e-narrow.png');

// 浏览器跑在容器里 ⇒ 它自己解析不到入口域名，用 `--host-resolver-rules` 把域名映射到宿主。
// 只覆盖容器内解析，不动宿主 hosts、不写文件。坐标可用 `E2E_HOST_MAP` 覆盖：`host=ip,host=ip`。
// #932：解析与拼接统一到 lib 的 hostResolverRules()——读 E2E_RESOLVE（旧名 E2E_HOST_MAP 兼容一世代），
// 两者皆无时用与现有脚本一致的缺省串；多条规则逗号连接（chromium 实测要求）。HOST_MAP/规则串同源。
const { entries: HOST_MAP, rules: HOST_RESOLVER_RULES, warning: HOST_MAP_WARNING } = hostResolverRules();

const WIDE_VIEWPORT = { width: 1440, height: 900 };
const NARROW_WIDTH = 820;
// 状态列允许的形状（与容器脚本内同名常量一致）：勾/虚线圆/斜标，非旧装饰圆点。
const STATUS_SHAPES = ['✓', '◌', '⊘'];

// ---------------------------------------------------------------------------
// docker 包装层：普通用户能跑就用普通用户，否则包一层组权限；整条命令串不许含换行。
// 权限探测用**无副作用的** `docker version`（早先的写法把真命令当探针跑一遍、再跑一遍 ⇒
// 浏览器脚本会被执行两次，且第一次失败会被误判成权限问题而改走 sg）。
// sg 回退的 shell 转义：单引号包裹 + 内嵌单引号写成 '\''（JSON.stringify 不是 shell 转义）。
// ---------------------------------------------------------------------------
function shQuote(arg) {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function dockerCmd(args) {
  const inner = ['docker', ...args].map(shQuote).join(' ');
  if (inner.includes('\n')) throw new Error('docker 命令串含换行（sg docker -c 的引号会断）');
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { shell: 'plain', inner };
  } catch {
    return { shell: 'sg', inner: `sg docker -c ${shQuote(inner)}` };
  }
}

function dockerProbe() {
  try {
    execFileSync('docker', ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return null;
  } catch (err) {
    const msg = String((err && err.message) || err).split('\n')[0];
    if (/docker.sock.*permission|permission denied/i.test(msg)) return '当前用户对 docker.sock 没权限（用 sg docker 或把用户加进 docker 组）';
    return `docker 不可用：${msg}`;
  }
}

function dockerRun(args, opts = {}) {
  const { shell, inner } = dockerCmd(args);
  return execFileSync(shell === 'plain' ? 'docker' : 'sh', shell === 'plain' ? args : ['-c', inner], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeout || 60_000,
  });
}

function tryQuiet(fn) {
  try { fn(); return true; } catch (err) {
    console.log(`# 清理没成功（不影响判据）：${String(err?.message || err).split('\n')[0]}`);
    return false;
  }
}

function containerRunning(name) {
  try {
    const out = dockerRun(['ps', '--format', '{{.Names}}'], { timeout: 15_000 });
    return out.split('\n').some((l) => l.trim() === name);
  } catch { return false; }
}

// 只有显式 `E2E_UI_SOFT=1` 才允许降级成 skip，且**只在探测阶段**（还没碰过页面）；
// 进了 run 阶段（已进容器）一律不降级，免得把产品回归伪装成 skip。
// #932：本文件旧有一份重复的 shouldSoftSkip（缺 message 参数、不分类），已删；唯一实现在 lib/e2e-ui-soft.mjs（顶部 import）。

/** 口令只从本机凭据目录读；绝不打印内容，只读返回。返回 null = 没找到文件。 */
function readPassword() {
  for (const f of PASSWORD_FILE_CANDIDATES) {
    try {
      if (fs.existsSync(f)) {
        const v = fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
        if (v.length > 0) return v;
      }
    } catch { /* 下一个候选 */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 通用：HTTP 取值（无浏览器；自签证书靠 NODE_TLS_REJECT_UNAUTHORIZED + rejectUnauthorized:false）。
// 宿主通常不解析入口域名（只有容器经 host-resolver-rules 能解）⇒ 这里按 HOST_MAP 把域名连到映射 IP，
// 同时保留 SNI 与 Host 头为真域名，这样 HTTP 腿在宿主上也能真拿到 401（与浏览器腿同源）。
// ---------------------------------------------------------------------------
function mapHost(hostName) {
  const hit = HOST_MAP.find((h) => h.host === hostName);
  return hit ? hit.ip : hostName;
}

function fetchJson(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: mapHost(u.hostname),
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      method: opts.method || 'GET',
      servername: u.hostname,
      headers: { host: u.hostname, accept: 'application/json', ...(opts.headers || {}) },
      rejectUnauthorized: false,
      timeout: opts.timeoutMs || 15_000,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: body, header: (k) => res.headers[k.toLowerCase()] }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

// 浏览器腿「能不能跑」逐项预探测；缺的东西记成原因，不算红。
const probe = { reasons: { ui: null }, ready: false };
function probeUi() {
  const missing = [];
  if (CRED_PASSWORD === null) missing.push(`口令文件不存在（试过 ${PASSWORD_FILE}）`);
  const dockerReason = dockerProbe();
  if (dockerReason) missing.push(dockerReason);
  else {
    if (!containerRunning(PW_CONTAINER)) missing.push(`容器 ${PW_CONTAINER} 没在跑（缺浏览器腿执行环境）`);
    else {
      try {
        dockerRun(['exec', PW_CONTAINER, 'test', '-f', PW_MODULE], { timeout: 30_000 });
      } catch { missing.push(`${PW_CONTAINER} 里没有 ${PW_MODULE}（缺 playwright）`); }
    }
  }
  return missing.length > 0 ? missing.join('；') : null;
}

const CRED_PASSWORD = readPassword();
probe.reasons.ui = UI_ENABLED ? (probeUi() || null) : '浏览器腿要点名才跑（设 E2E_UI=1 开启：需口令文件 + 在跑的 playwright 容器，见冷层机况笔记）';

function announceLeg(leg, label) {
  console.log(probe.reasons[leg]
    ? `[admin-nav-cols-e2e] leg=${leg} (${label}) SKIP：${probe.reasons[leg]}`
    : `[admin-nav-cols-e2e] leg=${leg} (${label}) 开跑`);
}
announceLeg('ui', '浏览器（导航腿 + 表格腿）');

// ---------------------------------------------------------------------------
// 浏览器腿（#818 + #817）。
//
// 分工（同 llm-usage）：容器内脚本**只收集事实**并打 `REPORT:`，所有断言留在外层。
// 容器内脚本自包含：除 playwright 外只用 node 内置；`__PW_MODULE__` 占位符被
// `PW_MODULE` 替换。**整段是 String.raw 模板：体内禁反引号、禁 ${} 插值**（反引号会提前
// 闭合外层模板，`${}` 会被外层模板提前求值）。
// ---------------------------------------------------------------------------
const CONTAINER_SCRIPT = String.raw`
import { readFileSync } from 'node:fs';
const { chromium } = await import('__PW_MODULE__');

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const NAV_GROUPS = ['usersSeats', 'models', 'platformAccess', 'platformConfig', 'observe', 'macros'];
const STATUS_SHAPES = ['✓', '◌', '⊘'];

const r = {
  fatal: null,
  login: { reachedLogin: false, afterHash: '' },
  pageErrors: [],
  consoleErrors: [],
  nav: {},
  navActive: [],
  expandedInitialCount: null,
  expandedGroupsInitial: [],
  macrosExpandedAfterNav: null,
  macrosCollapsed: null,
  macrosReexpandAfterCollapse: null,
  expandedAfterReloadIncludesMacros: null,
  storedExpandedAfterReload: null,
  table: {},
  narrow: {},
};

function selByTest(v) { return '[data-test="' + v + '"]'; }
function clickLink(tt) {
  const a = document.querySelector('nav a' + selByTest(tt));
  if (!a) return false;
  a.click();
  return true;
}

let browser = null;
try {
  browser = await chromium.launch({
    channel: 'chromium',
    args: ['--no-sandbox', '--host-resolver-rules=' + cfg.hostResolverRules],
  });
  const ctx = await browser.newContext({
    viewport: { width: cfg.wideViewport.width, height: cfg.wideViewport.height },
    locale: cfg.locale,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => r.pageErrors.push(String((e && e.message) || e).split('\n')[0].slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') r.consoleErrors.push(m.text().slice(0, 300)); });

  // 登录（坐标与选择器全部照 admin-locale：#loginName / #loginPass / submit）。
  await page.goto(cfg.base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  r.login.reachedLogin = await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20000 }).then(() => true).catch(() => false);
  await page.fill('#loginName', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20000 }).catch(() => {});
  r.login.afterHash = page.url();

  // 进用户表（默认管理台路由）。
  await page.goto(cfg.base + '/#/admin/users', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 先拍一张「特性在不在」的快照（**在任何可能 fatal 的 waitForSelector 之前**）：
  // 外层靠它区分「活栈跑的是本功能之前的镜像」（环境形状 ⇒ 可 skip）与「真回归」（必须红）。
  r.boot = await page.evaluate(() => ({
    hasSidebar: !!document.querySelector('nav a[data-test^="nav-link-"]'),
    hasUserTable: !!document.querySelector('table[data-test="user-table"]'),
    hasSeatCell: !!document.querySelector('[data-test="seat-cell"]'),
    // 停在登录页 ⇒ 不是「旧镜像」而是登录没走通（真回归）——两者都表现为「没有侧栏」，必须分开。
    hash: location.hash || '',
    onLoginPage: !!document.querySelector('#loginName, input[autocomplete="username"]'),
  }));
  await page.waitForSelector('nav a[data-test^="nav-link-"]', { timeout: 20000 });

  // 导航腿结构事实（宽视口）。
  r.nav = await page.evaluate((groups) => {
    const links = [...document.querySelectorAll('nav a[data-test^="nav-link-"]')];
    const headers = [...document.querySelectorAll('[data-test^="nav-group-"]')].filter((el) => el.tagName === 'BUTTON');
    const about = document.querySelector('[data-test="nav-link-admin-about"]');
    const nav = document.querySelector('nav.admin-nav') || document.querySelector('nav');
    const cs = nav ? getComputedStyle(nav) : {};
    const expanded = headers.filter((b) => b.getAttribute('aria-expanded') === 'true').map((b) => b.getAttribute('data-test'));
    return {
      linkCount: links.length,
      groupHeaderCount: headers.length,
      headerTests: headers.map((b) => b.getAttribute('data-test')),
      aboutPresent: !!about,
      aboutInFooter: about ? !!about.closest('[data-test="nav-footer"]') : false,
      aboutInAnyGroup: about ? !!about.closest('[data-test="nav-group"]') : true,
      links: links.map((a) => ({
        test: a.getAttribute('data-test'),
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().slice(0, 40),
      })),
      expandedGroupsInitial: expanded,
      navOverflowY: cs.overflowY || '',
      navScrollWidth: nav ? nav.scrollWidth : -1,
      navClientWidth: nav ? nav.clientWidth : -1,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      storedExpanded: localStorage.getItem('admin.nav.expanded'),
    };
  }, NAV_GROUPS);

  // 逐条点进全部 15 链接（用程序化 a.click()，折叠组里隐藏项也能触发 router-link）。
  for (const info of r.nav.links) {
    const tt = info.test;
    await page.evaluate((v) => {
      const a = document.querySelector('nav a' + '[data-test="' + v + '"]');
      if (a) a.click();
    }, tt);
    await page.waitForFunction((v) => {
      const a = document.querySelector('nav a' + '[data-test="' + v + '"]');
      return !!a && a.getAttribute('aria-current') === 'page';
    }, tt, { timeout: 8000 }).catch(() => {});
    const res = await page.evaluate((v) => {
      const all = [...document.querySelectorAll('nav [aria-current="page"]')].map((x) => x.getAttribute('data-test'));
      const a = document.querySelector('nav a' + '[data-test="' + v + '"]');
      return { isCurrent: !!a && a.getAttribute('aria-current') === 'page', currentList: all, hash: location.hash };
    }, tt);
    r.navActive.push({ test: tt, href: info.href, isCurrent: res.isCurrent, currentCount: res.currentList.length, currentList: res.currentList, hash: res.hash });
  }

  // 展开态：清 localStorage ⇒ 默认只展开当前组；导航到别组自动展开；收起再进仍展开；刷新保持。
  await page.evaluate(() => localStorage.removeItem('admin.nav.expanded'));
  await page.goto(cfg.base + '/#/admin/users', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-test="nav-group-usersSeats"]', { timeout: 20000 });
  r.expandedGroupsInitial = await page.evaluate(() => [...document.querySelectorAll('[data-test^="nav-group-"]')]
    .filter((b) => b.tagName === 'BUTTON' && b.getAttribute('aria-expanded') === 'true')
    .map((b) => b.getAttribute('data-test')));
  r.expandedInitialCount = r.expandedGroupsInitial.length;

  // 导航到 macros 组（当前在 usersSeats）⇒ 目标组自动展开。
  await page.evaluate(() => {
    const a = document.querySelector('nav a' + '[data-test="nav-link-admin-macros"]');
    if (a) a.click();
  });
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return !!b && b.getAttribute('aria-expanded') === 'true';
  }, null, { timeout: 8000 }).catch(() => {});
  r.macrosExpandedAfterNav = await page.evaluate(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return b ? b.getAttribute('aria-expanded') : null;
  });

  // 手动收起 macros 组。
  await page.click('[data-test="nav-group-macros"]').catch(() => {});
  await page.waitForTimeout(250);
  r.macrosCollapsed = await page.evaluate(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return b ? b.getAttribute('aria-expanded') : null;
  });

  // 收起后点进同组另一项 ⇒ 必须再展开。
  await page.evaluate(() => {
    const a = document.querySelector('nav a' + '[data-test="nav-link-admin-macro-runs"]');
    if (a) a.click();
  });
  await page.waitForFunction(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return !!b && b.getAttribute('aria-expanded') === 'true';
  }, null, { timeout: 8000 }).catch(() => {});
  r.macrosReexpandAfterCollapse = await page.evaluate(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return b ? b.getAttribute('aria-expanded') : null;
  });

  // 刷新后展开态保持（localStorage）。
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-test="nav-group-macros"]', { timeout: 20000 });
  r.expandedAfterReloadIncludesMacros = await page.evaluate(() => {
    const b = document.querySelector('[data-test="nav-group-macros"]');
    return b ? b.getAttribute('aria-expanded') === 'true' : false;
  });
  r.storedExpandedAfterReload = await page.evaluate(() => localStorage.getItem('admin.nav.expanded'));

  // 表格腿（宽视口，回用户表）。
  await page.goto(cfg.base + '/#/admin/users', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('table[data-test="user-table"] thead th', { timeout: 20000 }).catch(() => {});
  r.table = await page.evaluate((shapes) => {
    const table = document.querySelector('table[data-test="user-table"]');
    const ths = table ? [...table.querySelectorAll('thead th')] : [];
    // 「表头是否换行」不能用 scrollHeight > clientHeight 判：表格单元格的高度会跟着行高一起长，
    // 两个值永远相等 ⇒ 那条断言恒真（变异实测：把 th 压到 48px 宽 + white-space:normal 强制折行，
    // 旧写法仍然报空数组）。改为数**行盒**：Range 覆盖文本后取 client rects，按 top 去重即行数。
    // 注意本段代码住在模板字符串里（要投进容器执行）⇒ 注释里不许出现反引号。
    const lineCount = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].map((rc) => Math.round(rc.top)));
      return tops.size;
    };
    const wrappedThs = ths.map((th) => ({ text: (th.textContent || '').trim().slice(0, 40), lines: lineCount(th) }))
      .filter((each) => each.lines > 1);
    const rows = table ? [...table.querySelectorAll('tbody [data-test="user-row"]')] : [];
    const seatCells = [];
    const statusGlyphs = [];
    const actionBtns = [];
    const actionBtnRightEdges = [];
    for (const row of rows) {
      const seat = row.querySelector('[data-test="seat-cell"]');
      const seatSpan = seat ? seat.querySelector('span') : null;
      if (seatSpan) {
        seatCells.push({
          text: (seatSpan.textContent || '').trim(),
          title: seatSpan.getAttribute('title') || '',
          len: (seatSpan.textContent || '').trim().length,
        });
      }
      const glyphs = [...row.querySelectorAll('[aria-hidden="true"]')].map((el) => (el.textContent || '').trim()).filter((t) => t.length === 1);
      if (glyphs.length > 0) statusGlyphs.push({ glyphs, rowText: (row.textContent || '').slice(0, 120) });
      // #817 步 5：三个操作控件全部纯图标 ⇒ 一并收 aria-label / title / className（颜色判据要看类名）。
      for (const sel of ['seat-content-link', 'toggle-user-status', 'edit-user']) {
        const btn = row.querySelector('[data-test="' + sel + '"]');
        if (btn) actionBtns.push({
          test: sel,
          svgCount: btn.querySelectorAll('svg').length,
          text: (btn.textContent || '').trim(),
          ariaLabel: btn.getAttribute('aria-label') || '',
          title: btn.getAttribute('title') || '',
          className: btn.getAttribute('class') || '',
        });
      }
      // #923：直接量**按钮**的右边界（量最后一个表头格不够：格子装得下不代表按钮没被内部裁切样式遮住）。
      for (const btn of row.querySelectorAll('[data-test="seat-content-link"], [data-test="edit-user"]')) {
        actionBtnRightEdges.push(Math.round(btn.getBoundingClientRect().right));
      }
    }
    const scroll = document.querySelector('[data-test="user-table-scroll"]');
    const bodyText = document.body.innerText || '';
    return {
      tablePresent: !!table,
      thCount: ths.length,
      wrappedThs,
      rowCount: rows.length,
      seatCells,
      statusGlyphs,
      actionBtns,
      scrollHasContent: !!scroll,
      // #923：宽视口下「操作」列必须完整可见（不需要横滚）。这三项是那条回归的硬判据：
      // 容器 scrollWidth/clientWidth 判「要不要横滚」，两个 right 判「操作列有没有被容器切掉」。
      scrollScrollWidth: scroll ? scroll.scrollWidth : -1,
      scrollClientWidth: scroll ? scroll.clientWidth : -1,
      actionsRightEdge: (scroll && ths.length) ? Math.round(ths[ths.length - 1].getBoundingClientRect().right) : -1,
      // 按钮自身的右边界（取全表最大）：真正要保证「点得到」的是按钮，不是表头格。
      actionBtnRightEdge: actionBtnRightEdges.length ? Math.max(...actionBtnRightEdges) : -1,
      scrollRightEdge: scroll ? Math.round(scroll.getBoundingClientRect().right) : -1,
      bodyHasRawI18nKey: /admin\.[A-Za-z]+\.[A-Za-z]+/.test(bodyText),
      bodyHasLegacyDot: bodyText.includes('●'),
      bodyHasRetainedInText: bodyText.includes('workspace 保留中'),
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
    };
  }, STATUS_SHAPES);

  // 宽视口截图（导航腿证据）。
  await page.screenshot({ path: cfg.shotWide, fullPage: false }).catch(() => {});

  // 英文态（#817 那次表头被挤成两行，最先出问题的就是英文长标签：Repository management 之类）：
  // 切到 English 再量一次表头行盒与文档溢出，量完**切回中文**（切换会写账号级偏好，不能把 dev 的
  // 管理员留在英文态）。切不回中文也要尽力尝试（finally）。
  const pickLocale = async (want) => {
    await page.click('header button[aria-haspopup="menu"]');
    await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
    const hit = await page.evaluate((w) => {
      const el = [...document.querySelectorAll('[role="menuitem"]')].find((e) => (e.textContent || '').trim() === w);
      if (!el) return false;
      el.click();
      return true;
    }, want);
    if (!hit) throw new Error('语言菜单里没有文案为 ' + want + ' 的项');
    await page.waitForTimeout(600);
  };
  try {
    await pickLocale('English');
    await page.waitForSelector('table[data-test="user-table"] thead th', { timeout: 20000 }).catch(() => {});
    r.en = await page.evaluate(() => {
      const table = document.querySelector('table[data-test="user-table"]');
      const ths = table ? [...table.querySelectorAll('thead th')] : [];
      const lineCount = (el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return new Set([...range.getClientRects()].map((rc) => Math.round(rc.top))).size;
      };
      return {
        lang: document.documentElement.lang,
        thCount: ths.length,
        thLabels: ths.map((th) => (th.textContent || '').trim().slice(0, 40)),
        wrappedThs: ths.map((th) => ({ text: (th.textContent || '').trim().slice(0, 40), lines: lineCount(th) }))
          .filter((each) => each.lines > 1),
        docScrollWidth: document.documentElement.scrollWidth,
        docClientWidth: document.documentElement.clientWidth,
      };
    });
  } finally {
    try { await pickLocale('中文'); } catch (e) { r.enRestoreError = String((e && e.message) || e); }
  }

  // 窄视口（#817/#818 的横向溢出与滚动面在窄屏才暴露）。
  await page.setViewportSize({ width: cfg.narrowWidth, height: 900 });
  await page.goto(cfg.base + '/#/admin/users', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('table[data-test="user-table"] thead th', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(300);
  r.narrow = await page.evaluate(() => {
    const aside = document.querySelector('aside.admin-side') || document.querySelector('aside');
    const nav = document.querySelector('nav.admin-nav') || document.querySelector('nav');
    const main = document.querySelector('main');
    const scroll = document.querySelector('[data-test="user-table-scroll"]');
    return {
      railWidth: aside ? Math.round(aside.getBoundingClientRect().width) : -1,
      navOverflowY: nav ? getComputedStyle(nav).overflowY : '',
      navScrollHeight: nav ? nav.scrollHeight : -1,
      navClientHeight: nav ? nav.clientHeight : -1,
      mainOverflowY: main ? getComputedStyle(main).overflowY : '',
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      scrollOverflowX: scroll ? getComputedStyle(scroll).overflowX : '',
      scrollScrollWidth: scroll ? scroll.scrollWidth : -1,
      scrollClientWidth: scroll ? scroll.clientWidth : -1,
    };
  });

  // 窄视口截图（表格腿证据）。
  await page.screenshot({ path: cfg.shotNarrow, fullPage: false }).catch(() => {});
} catch (err) {
  r.fatal = String((err && err.stack) || (err && err.message) || err).split('\n').slice(0, 3).join(' / ');
} finally {
  if (browser) { try { await browser.close(); } catch { /* 忽略 */ } }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
`;

// ---------------------------------------------------------------------------
// HTTP-401 腿（总是跑；不依赖口令，auth 中间件在路由前拦，证明管理台入口与鉴权门可达）。
// ---------------------------------------------------------------------------
test('H0 不带凭据 `GET /api/admin/users` ⇒ 401（不依赖口令，证明管理台入口可达）',
  { timeout: 60_000 }, async (t) => {
    let res;
    try {
      res = await fetchJson(BASE + '/api/admin/users', { timeoutMs: 20_000 });
    } catch (err) {
      t.diagnostic(`SKIP (401)：${BASE} 连不上（栈没起 / 入口到不了）：${err.message}`);
      t.skip();
      return;
    }
    assert.equal(res.status, 401, `不带凭据打 /api/admin/users 期望 401，得到 ${res.status}（body=${res.text.slice(0, 200)}）`);
  });

// ---------------------------------------------------------------------------
// 浏览器腿：#818 导航 + #817 表格（一次性进页面、收集 REPORT、外层逐条断言）。
// ---------------------------------------------------------------------------
test('UI 活栈管理台：#818 分组侧栏导航（15 链接 / 6 组 / 关于固定 / aria-current / 滚动面 / 窄屏图标轨 / 展开态 / 英文态表头不折）+ #817 用户表（表头单行 / 横滚容器 / 工位列单状态 / 状态形状 / 动作图标+文字）',
  // 点名（E2E_UI=1）时**不许**用 skip 把预检缺口吞成 rc=0：那时跳过 = 假通过。
  { skip: (!UI_ENABLED && probe.reasons.ui) || false, timeout: 300_000 }, async (t) => {
    if (!UI_ENABLED) {
      t.diagnostic('浏览器腿要点名才跑（设 E2E_UI=1 开启；缺口令/容器会判红，除非显式 E2E_UI_SOFT=1）');
      t.skip();
      return;
    }
    // #932：旧名 E2E_HOST_MAP 若被用上，这里必须报出来（静默兼容 = 永远移不掉）。
    if (HOST_MAP_WARNING) t.diagnostic(`host-map 兼容提示：${HOST_MAP_WARNING}`);
    // 点名之后的预检缺口（缺 docker / 容器没跑 / 容器里没 playwright / 缺口令）：
    // 只有显式逃生门 E2E_UI_SOFT=1 才允许降级 skip，其余一律判红。
    if (probe.reasons.ui) {
      // #932：环境探测阶段的缺项——先分类（phase:'probe'），soft 才降级；其余判红。
      if (shouldSoftSkip({ soft: UI_SOFT, phase: 'probe', message: probe.reasons.ui })) {
        t.diagnostic(`E2E_UI_SOFT=1 ⇒ 按环境形状 skip：${probe.reasons.ui}`);
        t.skip();
        return;
      }
      assert.fail(`E2E_UI=1 点名要跑，但环境不齐：${probe.reasons.ui}。`
        + '点名却静默 skip 会让 rc=0 与真跑同色（假通过）⇒ 判失败。'
        + '确知这台机器今天跑不了活栈 ⇒ 显式带 E2E_UI_SOFT=1 降级。');
    }
    t.diagnostic(`入口：${BASE}（自签证书已跳过校验）`);
    t.diagnostic(`执行环境：容器 ${PW_CONTAINER} 内 ${PW_MODULE}（本仓库不装 playwright）`);
    t.diagnostic(`容器内域名映射：${HOST_MAP.map((h) => `${h.host}→${h.ip}`).join('，') || '(未配，依赖容器自身 DNS)'}`);

    const reason = probeUi();
    if (reason) {
      probe.reasons.ui = reason;
      if (shouldSoftSkip({ soft: UI_SOFT, phase: 'probe', message: reason })) {
        t.diagnostic(`E2E_UI_SOFT=1 ⇒ 探测缺项按 skip 降级：${reason}`);
        t.skip();
        return;
      }
      assert.fail(`E2E_UI=1 点名要跑，环境却不齐（缺：${reason}）——不能以 skip 冒充通过。`
        + `判红；确认 dev 栈在跑并放好口令文件后重跑，或显式用 E2E_UI_SOFT=1 降级为 skip。`);
      t.skip();
      return;
    }

    const password = CRED_PASSWORD;
    const uid = `${process.pid}-${Date.now()}`;
    const scriptHost = path.join(os.tmpdir(), `admin-nav-cols-e2e.${uid}.script.mjs`);
    const cfgHost = path.join(os.tmpdir(), `admin-nav-cols-e2e.${uid}.cfg.json`);
    const scriptIn = `/tmp/admin-nav-cols-e2e.${uid}.script.mjs`;
    const cfgIn = `/tmp/admin-nav-cols-e2e.${uid}.cfg.json`;
    const cfg = {
      base: BASE,
      login: ADMIN_LOGIN,
      password,
      hostResolverRules: HOST_RESOLVER_RULES,
      shotWide: SHOT_WIDE_CONTAINER,
      shotNarrow: SHOT_NARROW_CONTAINER,
      locale: 'zh-CN',
      wideViewport: WIDE_VIEWPORT,
      narrowWidth: NARROW_WIDTH,
    };

    try {
      fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
      fs.writeFileSync(cfgHost, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      dockerRun(['cp', scriptHost, `${PW_CONTAINER}:${scriptIn}`], { timeout: 60_000 });
      dockerRun(['cp', cfgHost, `${PW_CONTAINER}:${cfgIn}`], { timeout: 60_000 });

      let out;
      try {
        out = dockerRun(['exec', PW_CONTAINER, 'node', scriptIn, cfgIn], { timeout: 300_000 });
      } catch (err) {
        const detail = String((err && err.stderr) || (err && err.message) || err).split('\n').slice(-6).join(' / ');
        // #932：run 阶段（已进容器）不降级 ⇒ shouldSoftSkip(phase:'run') 恒 false ⇒ 下面 assert.fail 必达。
        if (!shouldSoftSkip({ soft: UI_SOFT, phase: 'run', message: detail })) {
          assert.fail(`E2E_UI=1 点名要跑，浏览器脚本在容器里跑挂了（run 阶段，E2E_UI_SOFT 也不降级）：${detail}`);
        }
        t.diagnostic(`E2E_UI_SOFT=1 ⇒ 容器内执行失败按 skip 降级：${detail}`);
        t.skip();
        return;
      }

      const m = out && out.match(/REPORT:(\{.*\})/);
      if (!m) {
        assert.fail(`浏览器脚本没吐出 REPORT：${String(out).slice(-2000)}`);
        return;
      }
      const rep = JSON.parse(m[1]);
      t.diagnostic(`致命：${rep.fatal ?? '(无)'}`);
      t.diagnostic(`导航读数：${JSON.stringify(rep.nav)}`);
      t.diagnostic(`导航 active：${JSON.stringify(rep.navActive)}`);
      t.diagnostic(`表格读数：${JSON.stringify(rep.table)}`);
      t.diagnostic(`窄视口读数：${JSON.stringify(rep.narrow)}`);
      t.diagnostic(`展开态读数：initial=${JSON.stringify(rep.expandedGroupsInitial)} macrosAfterNav=${JSON.stringify(rep.macrosExpandedAfterNav)}`
        + ` collapsed=${JSON.stringify(rep.macrosCollapsed)} reexpand=${JSON.stringify(rep.macrosReexpandAfterCollapse)}`
        + ` afterReloadIncludesMacros=${JSON.stringify(rep.expandedAfterReloadIncludesMacros)}`);

      // 致命分支：只有**能正面认定**的两类环境形状才允许 skip，其余一律判红——
      // 早先的写法是「非网络错误一律 skip」⇒ 登录选择器改名、侧栏没渲染、脚本自身抛错都会被报成
      // 环境 skip 而 rc=0（假通过）。
      if (rep.fatal) {
        const entryUnreachable = /net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(String(rep.fatal));
        // 旧镜像的**正面证据**：登录过了（不在登录页，说明入口与鉴权都通），但侧栏与用户表**两者都不存在**。
        const stillOnLogin = !!(rep.boot && (rep.boot.onLoginPage || /\/login/.test(String(rep.boot.hash))));
        const oldImage = !!rep.boot && !stillOnLogin
          && rep.boot.hasSidebar === false && rep.boot.hasUserTable === false;
        if (entryUnreachable) {
          // #932：run 阶段 net:: 先分类再决定——走 phase:'run' ⇒ shouldSoftSkip 恒 false ⇒ 判红；
          //（旧写法把 `if (UI_SOFT)` 排在分类之前，soft=true 会把运行阶段 net:: 静默降级成 skip=假绿）。
          if (shouldSoftSkip({ soft: UI_SOFT, phase: 'run', message: rep.fatal })) {
            t.diagnostic(`E2E_UI_SOFT=1 ⇒ 按环境形状 skip：${rep.fatal}`);
            t.skip();
            return;
          }
          assert.fail(`E2E_UI=1 点名要跑：容器内连入口 ${BASE} 都不通（#878：run 阶段 net:: 一律判红，不能降级 skip）：${rep.fatal}`);
        }
        if (stillOnLogin) {
          assert.fail(`登录没走通（致命后仍停在登录页）：${rep.fatal}；boot=${JSON.stringify(rep.boot)}`);
        }
        if (oldImage) {
          t.diagnostic(`活栈跑的是本功能之前的镜像（侧栏与用户表都不存在，boot=${JSON.stringify(rep.boot)}），按环境形状 skip：${rep.fatal}`);
          t.skip();
          return;
        }
        assert.fail(`浏览器腿在页面已连通的情况下失败（不是环境形状，按产品红计）：${rep.fatal}；boot=${JSON.stringify(rep.boot)}`);
      }

      // ---- 断言：导航腿（#818）----
      const nav = rep.nav;
      // 钉死**集合**而不只钉总数：只数 15 时，缺一项 + 多一项仍能凑够 15 而通过（评审指出的真缺口）。
      const EXPECTED_NAV = [
        'nav-link-admin-users', 'nav-link-admin-seat-content', 'nav-link-admin-llm',
        'nav-link-admin-repos', 'nav-link-admin-mail', 'nav-link-admin-tls',
        'nav-link-admin-upload', 'nav-link-admin-prompts', 'nav-link-admin-runtime',
        'nav-link-admin-market', 'nav-link-admin-system', 'nav-link-admin-preview-pool',
        'nav-link-admin-macros', 'nav-link-admin-macro-runs', 'nav-link-admin-about',
      ].sort();
      const actualNav = (nav.links || []).map((l) => String(l.test)).sort();
      assert.deepEqual(actualNav, EXPECTED_NAV,
        `侧栏链接集合不对（缺/多/改名都算红）。实测 ${JSON.stringify(actualNav)}`);
      assert.ok(nav.linkCount === 15, `侧栏链接数应 = 15，实测 ${JSON.stringify(nav.linkCount)}`);
      assert.ok(nav.groupHeaderCount === 6, `分组标题数应 = 6，实测 ${JSON.stringify(nav.groupHeaderCount)}（headers=${JSON.stringify(nav.headerTests)}）`);
      assert.ok(nav.aboutPresent && nav.aboutInFooter && !nav.aboutInAnyGroup,
        `「关于」应在底部固定区且不在任何分组内：present=${JSON.stringify(nav.aboutPresent)} inFooter=${JSON.stringify(nav.aboutInFooter)} inGroup=${JSON.stringify(nav.aboutInAnyGroup)}`);

      const badActive = (rep.navActive || []).filter((x) => !x.isCurrent || x.currentCount !== 1 || !/^#\/admin/.test(String(x.hash)));
      assert.deepEqual(badActive, [],
        `存在点进去后 aria-current 未对上或 hash 非 admin 的链接：${JSON.stringify(badActive)}`);
      assert.equal((rep.navActive || []).length, 15, `遍历链接数应 = 15，实测 ${JSON.stringify((rep.navActive || []).length)}`);

      assert.ok(nav.docScrollWidth <= nav.docClientWidth + 1,
        `宽视口文档不应横向溢出：scrollWidth=${nav.docScrollWidth} > clientWidth=${nav.docClientWidth} +1`);
      assert.ok(['auto', 'scroll'].includes(nav.navOverflowY), `侧栏 overflow-y 应为 auto/scroll（两个滚动面），实测 ${JSON.stringify(nav.navOverflowY)}`);
      assert.ok(nav.navScrollWidth <= nav.navClientWidth + 1,
        `宽视口侧栏不应横向溢出：nav.scrollWidth=${nav.navScrollWidth} > nav.clientWidth=${nav.navClientWidth} +1`);
      // 「两个滚动面」放到窄视口那段量（那里同时收了 main 的 overflow 与侧栏的实际高）。

      // 展开态
      assert.ok(Array.isArray(rep.expandedGroupsInitial) && rep.expandedGroupsInitial.length === 1,
        `默认应只展开当前路由所在组（实测展开组数 = ${JSON.stringify(rep.expandedInitialCount)}，期望 1）：${JSON.stringify(rep.expandedGroupsInitial)}`);
      assert.equal(rep.expandedGroupsInitial[0], 'nav-group-usersSeats',
        `在 admin/users 默认展开组应为 usersSeats，实测 ${JSON.stringify(rep.expandedGroupsInitial[0])}`);
      assert.equal(rep.macrosExpandedAfterNav, 'true', `导航到 macros 组后目标组应自动展开，实测 aria-expanded=${JSON.stringify(rep.macrosExpandedAfterNav)}`);
      assert.equal(rep.macrosCollapsed, 'false', `手动收起后 macros 组 aria-expanded 应为 false，实测 ${JSON.stringify(rep.macrosCollapsed)}`);
      assert.equal(rep.macrosReexpandAfterCollapse, 'true', `收起后点进同组另一项应再次自动展开，实测 aria-expanded=${JSON.stringify(rep.macrosReexpandAfterCollapse)}`);
      assert.equal(rep.expandedAfterReloadIncludesMacros, true, `刷新后 macros 组应保持展开（localStorage），实测 ${JSON.stringify(rep.expandedAfterReloadIncludesMacros)}`);
      assert.ok(rep.storedExpandedAfterReload && /macros/.test(String(rep.storedExpandedAfterReload)),
        `localStorage 展开态应含 macros（持久化证据），实测 ${JSON.stringify(rep.storedExpandedAfterReload)}`);

      // ---- 断言：表格腿（#817）----
      const tbl = rep.table;
      assert.ok(tbl.tablePresent, '用户表没渲染出来（tablePresent=false）——可能活栈跑的是改动前镜像');
      // 表头数量与非空先钉住：表头被删空时 wrappedThs 恒为空数组，光看它会假绿。
      assert.equal(tbl.thCount, 11, `表头格数应 = 11（#817 的列序），实测 ${JSON.stringify(tbl.thCount)}：${JSON.stringify(tbl.thLabels)}`);
      const emptyTh = (tbl.thLabels || []).filter((x) => !x || x.length < 1);
      assert.deepEqual(emptyTh, [], `存在空表头（文案丢了）：${JSON.stringify(tbl.thLabels)}`);
      assert.deepEqual(tbl.wrappedThs, [], `表头有换行的格（thead th 应全部单行）：${JSON.stringify(tbl.wrappedThs)}`);
      assert.ok(tbl.rowCount >= 1, `用户表至少要有 1 行，实测 ${JSON.stringify(tbl.rowCount)}`);
      // ---- 断言：#923 宽视口（1440）不需要横滚、操作列完整可见 ----
      // 根因是**容器上限与表格 min-width 打架**：内容区 `max-w-5xl`=1024 < 表格 `min-width: 1150px`（#817 下限）
      // ⇒ 表格永远比内容区宽约 126px，任何视口都得横滚才点得到「操作」列（#923）。
      // 窄视口段（820）另有「容器必须可横滚」的断言，口径不同：那里的 sw>cw 是**预期**，这里必须 sw≤cw。
      assert.ok(tbl.scrollScrollWidth <= tbl.scrollClientWidth + 1,
        `宽视口(1440)表格外层容器不该还需要横滚（scrollWidth 应 ≤ clientWidth+1）：`
        + `scrollScrollWidth=${tbl.scrollScrollWidth} > scrollClientWidth=${tbl.scrollClientWidth} +1`
        + `（内容区上限与表格 min-width 打架（#923）：section 的 max-w 必须容得下表格 min-width 1150 + 侧栏 210）`);
      assert.ok(tbl.actionsRightEdge <= tbl.scrollRightEdge + 1,
        `宽视口(1440)「操作」列右边界超出滚动容器（列被切掉，必须横滚才点得到按钮）：`
        + `actionsRightEdge=${tbl.actionsRightEdge} > scrollRightEdge=${tbl.scrollRightEdge} +1`
        + `（内容区上限与表格 min-width 打架（#923）；scrollScrollWidth=${tbl.scrollScrollWidth} scrollClientWidth=${tbl.scrollClientWidth}）`);
      // 真正要保证的是「按钮点得到」：直接量按钮自身的右边界（表头格装得下 ≠ 按钮没被内部裁切遮住）。
      assert.ok(tbl.actionBtnRightEdge > 0 && tbl.actionBtnRightEdge <= tbl.scrollRightEdge + 1,
        `宽视口(1440)动作按钮被容器切掉（量的是按钮自身右边界）：`
        + `actionBtnRightEdge=${tbl.actionBtnRightEdge} > scrollRightEdge=${tbl.scrollRightEdge} +1`);

      // 工位列：每行一个状态，可见文本不含保留中、非空、长度有上界；hover(title) 必须非空。
      const seatBad = (tbl.seatCells || []).filter((c) => !c.text || c.text.includes('workspace 保留中') || c.len > 30);
      assert.deepEqual(seatBad, [], `「工位」列出现空/堆叠/超长文本（每行应只有一个状态，保留中只在 title）：${JSON.stringify(seatBad)}`);
      const titleBad = (tbl.seatCells || []).filter((c) => !c.title);
      assert.deepEqual(titleBad, [], `「工位」格缺 hover 全文（title 为空）：${JSON.stringify(titleBad)}`);
      assert.ok((tbl.seatCells || []).length === tbl.rowCount, `工位列格数应 = 行数（每行一格）：cells=${JSON.stringify((tbl.seatCells || []).length)} rows=${JSON.stringify(tbl.rowCount)}`);
      // 「workspace 保留中」允许在 hover(title) 里，但不许在可见文本里 ⇒ 整页 innerText 不含它。
      assert.equal(tbl.bodyHasRetainedInText, false, `整页可见文本出现「workspace 保留中」（应只在 title/hover），实测 ${JSON.stringify(tbl.bodyHasRetainedInText)}`);

      // 状态列：形状（✓/◌/⊘），不是旧圆点。
      const shapeBad = (tbl.statusGlyphs || []).filter((g) => !g.glyphs.some((ch) => STATUS_SHAPES.includes(ch)));
      assert.deepEqual(shapeBad, [], `状态列存在非形状字形（应含 ✓/◌/⊘ 之一）：${JSON.stringify(shapeBad)}`);
      assert.ok((tbl.statusGlyphs || []).length === tbl.rowCount, `状态列格数应 = 行数：glyphs=${JSON.stringify((tbl.statusGlyphs || []).length)} rows=${JSON.stringify(tbl.rowCount)}`);
      assert.equal(tbl.bodyHasLegacyDot, false, `整页出现旧装饰圆点 ●（#817 应已去掉），实测 ${JSON.stringify(tbl.bodyHasLegacyDot)}`);

      // #817 步 5：操作列三个控件全部纯图标 ⇒ 各 1 个 <svg>、无可见文字、aria-label 与 title 非空（语义硬判据）。
      const byTest = {};
      for (const b of tbl.actionBtns || []) (byTest[b.test] = byTest[b.test] || []).push(b);
      for (const key of ['seat-content-link', 'toggle-user-status', 'edit-user']) {
        const list = byTest[key] || [];
        assert.ok(list.length >= 1, `动作列缺 ${key}`);
        const iconBad = list.filter((b) => b.svgCount !== 1);
        assert.deepEqual(iconBad, [], `${key} 应恰含 1 个 <svg>：${JSON.stringify(iconBad)}`);
        const textBad = list.filter((b) => b.text.replace(/\s+/g, '').length !== 0);
        assert.deepEqual(textBad, [], `${key} 应为纯图标（可见文字为空）：${JSON.stringify(textBad)}`);
        const ariaBad = list.filter((b) => !(b.ariaLabel || '').trim() || !(b.title || '').trim());
        assert.deepEqual(ariaBad, [], `${key} aria-label/title 缺失（纯图标必须靠它们承载全词）：${JSON.stringify(ariaBad)}`);
      }
      // 危险方向（停用）给红、启用方向中性；颜色非唯一信号（图标 + aria/title 已由上面钉）。**条件断言**：
      // 按动作方向判而非行数——dev 上有启用态用户时，每个「停用」toggle 必须带红；若哪天全是停用态，
      // 「停用 toggle」集合为空 ⇒ 不触发（不误红）。启用方向 toggle 不得带红。
      const isRed = (b) => /(^|\s)(text-red-600|border-red-500)(\s|$)/.test(b.className || '');
      const toggles = byTest['toggle-user-status'] || [];
      const disableToggles = toggles.filter((b) => (b.ariaLabel || '').trim() === '停用');
      const enableToggles = toggles.filter((b) => (b.ariaLabel || '').trim() === '启用');
      // ⚠ 空集不许通过（评审指出的假绿路径）：若活栈上全是停用态用户，「停用」集合为空时
      // missRed 也是空数组 ⇒ deepEqual([], []) 照样绿，红色危险方向等于没验过。
      // 这条要求活栈**至少有 1 个启用态用户**（dev 常态如此）；真没有就判红并说明怎么办，
      // 而不是静默跳过——「验不了」和「验过了」不能同色。
      assert.ok(disableToggles.length >= 1,
        '活栈上没有任何「停用」方向的 toggle（整表都是停用态用户）⇒ 红色危险方向无法验证；'
        + '请让 dev 上存在启用态用户，或显式改这条判据的口径（不许空集通过）。'
        + `实测 toggle 总数=${toggles.length} aria-label 分布=${JSON.stringify(toggles.map((b) => b.ariaLabel))}`);
      const missRed = disableToggles.filter((b) => !isRed(b));
      assert.deepEqual(missRed, [], `「停用」toggle 必须带红色类（text-red-600/border-red-500）：${JSON.stringify(missRed)}`);
      const spuriousRed = enableToggles.filter((b) => isRed(b));
      assert.deepEqual(spuriousRed, [], `「启用」toggle（非破坏）不该带红色类：${JSON.stringify(spuriousRed)}`);
      assert.equal(tbl.bodyHasRawI18nKey, false, `整页残留裸 i18n key（形如 admin.tabs.xxx 原样出现），实测 ${JSON.stringify(tbl.bodyHasRawI18nKey)}`);

      // ---- 断言：英文态（#817 的表头换行事故最先出在英文长标签上）----
      const en = rep.en;
      assert.ok(en, `英文态没测到（r.en 缺失），enRestoreError=${JSON.stringify(rep.enRestoreError)}`);
      assert.equal(en.thCount, 11, `英文态表头格数应 = 11，实测 ${JSON.stringify(en.thCount)}：${JSON.stringify(en.thLabels)}`);
      assert.ok(/[A-Za-z]/.test((en.thLabels || []).join('')), `英文态表头应含拉丁字母（证明确实切到了英文）：${JSON.stringify(en.thLabels)}`);
      assert.deepEqual(en.wrappedThs, [], `英文态表头有换行的格（英文长标签最容易折）：${JSON.stringify(en.wrappedThs)}`);
      assert.ok(en.docScrollWidth <= en.docClientWidth + 1,
        `英文态文档不应横向溢出：scrollWidth=${en.docScrollWidth} > clientWidth=${en.docClientWidth} +1`);
      assert.equal(rep.enRestoreError, undefined, `英文态量完没切回中文（dev 账号会留在英文态）：${JSON.stringify(rep.enRestoreError)}`);

      // ---- 断言：窄视口（#818 图标轨 + #817 表格外层横滚）----
      const nar = rep.narrow;
      // 下限不只 >0：1px 也算「<60」而通过。
      assert.ok(nar.railWidth >= 32 && nar.railWidth < 60, `窄视口侧栏应收成图标轨（≈44，32–59），实测 railWidth=${JSON.stringify(nar.railWidth)}`);
      // 侧栏的 overflow-y 在宽视口那段已钉（窄视口它收成图标轨，computed 值会变成 visible，属正常）。
      assert.ok(nar.navScrollHeight >= nar.navClientHeight,
        `侧栏 scrollHeight 不应小于 clientHeight（小于说明量错了元素）：${JSON.stringify({ sh: nar.navScrollHeight, ch: nar.navClientHeight })}`);
      assert.ok(['auto', 'scroll'].includes(nar.mainOverflowY),
        `main 应是独立滚动面（overflow-y auto/scroll），实测 ${JSON.stringify(nar.mainOverflowY)}`);
      assert.ok(['auto', 'scroll'].includes(nar.scrollOverflowX),
        `表格外层容器应是可横滚（overflow-x auto/scroll），实测 ${JSON.stringify(nar.scrollOverflowX)}（hidden 也能让 scrollWidth>clientWidth 成立，故先钉 CSS）`);
      assert.ok(nar.scrollScrollWidth > nar.scrollClientWidth,
        `窄视口表格外层滚动容器应自己可横滚（scrollWidth>clientWidth）：scroll=${JSON.stringify({ sw: nar.scrollScrollWidth, cw: nar.scrollClientWidth, ox: nar.scrollOverflowX })}`);
      // 窄屏的横滚要留在**表格容器**里：页面本身不许横溢（否则整页左右拖，顶栏与侧栏一起跑）。
      // 这条之前只在 REPORT 里收了数、没断言（评审指出）：页面溢出而容器恰好仍可滚时，上面两条都会绿。
      assert.ok(nar.docScrollWidth <= nar.docClientWidth + 1,
        `窄视口(820)页面本身不应横向溢出（滚的应该是表格容器）：scrollWidth=${nar.docScrollWidth} > clientWidth=${nar.docClientWidth} +1`);

      // ---- 断言：通用 ----
      assert.deepEqual(rep.pageErrors, [], `有 pageerror：${JSON.stringify(rep.pageErrors.slice(0, 3))}`);
      // console error 白名单（常见良性噪声）；白名单外一律红。
      // 其中「Failed to load resource ... 401」是 SPA 进登录页时未登录探会话的**预期** 401
      //（登录后页面正常渲染出数据）；只放行 401 这一种，不 blanket 放行所有 failed-load（会掩盖 500）。
      // 白名单只放「浏览器级瞬时现象」与开发提示，**不放应用错误**：
      // ERR_NETWORK_CHANGED / ERR_ABORTED 是导航与 reload 期间被浏览器主动丢弃的请求（本次实测：
      // 切语言后重渲染 + 立刻换视口导航时偶发），与应用无关；其余 net:: 一律仍算红。
      const CONSOLE_ALLOW = [/favicon/i, /ResizeObserver loop/i, /Download the Vue Devtools/i, /DevTools/i, /status of 401\b/,
        /Failed to load resource: net::ERR_(NETWORK_CHANGED|ABORTED)\b/];
      const realConsole = (rep.consoleErrors || []).filter((e) => !CONSOLE_ALLOW.some((re) => re.test(e)));
      assert.deepEqual(realConsole, [], `白名单外的 console error：${JSON.stringify(realConsole.slice(0, 5))}`);

      // 截图取回（人工复核证据，落宿主临时目录，不提交）。
      tryQuiet(() => fs.rmSync(SHOT_WIDE_HOST, { force: true }));
      tryQuiet(() => fs.rmSync(SHOT_NARROW_HOST, { force: true }));
      tryQuiet(() => dockerRun(['cp', `${PW_CONTAINER}:${SHOT_WIDE_CONTAINER}`, SHOT_WIDE_HOST], { timeout: 60_000 }));
      tryQuiet(() => dockerRun(['cp', `${PW_CONTAINER}:${SHOT_NARROW_CONTAINER}`, SHOT_NARROW_HOST], { timeout: 60_000 }));
      const wideBytes = fs.existsSync(SHOT_WIDE_HOST) ? fs.statSync(SHOT_WIDE_HOST).size : 0;
      const narrowBytes = fs.existsSync(SHOT_NARROW_HOST) ? fs.statSync(SHOT_NARROW_HOST).size : 0;
      assert.ok(wideBytes > 1024, `宽视口截图只有 ${wideBytes} 字节（${SHOT_WIDE_HOST}）`);
      assert.ok(narrowBytes > 1024, `窄视口截图只有 ${narrowBytes} 字节（${SHOT_NARROW_HOST}）`);

      t.diagnostic(`截图：宽=${SHOT_WIDE_HOST}（${wideBytes} 字节），窄=${SHOT_NARROW_HOST}（${narrowBytes} 字节）`);
      const REPORT = {
        linkCount: nav.linkCount,
        groupHeaderCount: nav.groupHeaderCount,
        aboutInFooter: nav.aboutInFooter,
        aboutInAnyGroup: nav.aboutInAnyGroup,
        activeMismatch: (rep.navActive || []).filter((x) => !x.isCurrent).length,
        wideDocScroll: [nav.docScrollWidth, nav.docClientWidth],
        navOverflowY: nav.navOverflowY,
        navScroll: [nav.navScrollWidth, nav.navClientWidth],
        expandedInitial: rep.expandedGroupsInitial,
        macrosAfterNav: rep.macrosExpandedAfterNav,
        macrosReexpand: rep.macrosReexpandAfterCollapse,
        reloadIncludesMacros: rep.expandedAfterReloadIncludesMacros,
        wrappedThs: tbl.wrappedThs,
        enThLabels: (rep.en || {}).thLabels,
        enWrappedThs: (rep.en || {}).wrappedThs,
        enDocScroll: rep.en ? [rep.en.docScrollWidth, rep.en.docClientWidth] : null,
        rowCount: tbl.rowCount,
        seatMaxLen: (tbl.seatCells || []).reduce((a, c) => Math.max(a, c.len), 0),
        statusShapesOk: (tbl.statusGlyphs || []).length === tbl.rowCount && (tbl.statusGlyphs || []).length > 0,
        legacyDot: tbl.bodyHasLegacyDot,
        actionSvg: { seat: (byTest['seat-content-link'] || [])[0], toggle: (byTest['toggle-user-status'] || [])[0], edit: (byTest['edit-user'] || [])[0] },
        railWidth: nar.railWidth,
        narrowDocScroll: [nar.docScrollWidth, nar.docClientWidth],
        tableScroll: { sw: nar.scrollScrollWidth, cw: nar.scrollClientWidth, ox: nar.scrollOverflowX },
        // #923：宽视口（1440）不横滚 + 操作列完整可见的实测值。
        wideTableScroll: { sw: tbl.scrollScrollWidth, cw: tbl.scrollClientWidth },
        wideActionsFit: { actionsRightEdge: tbl.actionsRightEdge, actionBtnRightEdge: tbl.actionBtnRightEdge, scrollRightEdge: tbl.scrollRightEdge },
        pageErrors: rep.pageErrors.length,
        consoleErrorsReal: realConsole,
        rawI18nKey: tbl.bodyHasRawI18nKey,
      };
      console.log('REPORT:' + JSON.stringify(REPORT));
    } finally {
      tryQuiet(() => dockerRun(['exec', PW_CONTAINER, 'sh', '-c', `rm -f ${scriptIn} ${cfgIn}`], { timeout: 30_000 }));
      tryQuiet(() => fs.rmSync(scriptHost, { force: true }));
      tryQuiet(() => fs.rmSync(cfgHost, { force: true }));
    }
  });

// ---------------------------------------------------------------------------
// 哨兵用例：禁止「点名了却整腿静默 skip」的假通过。
// 未点名（默认）仍允许 skip：本地没有 dev 栈也得能跑 npm test。
// ---------------------------------------------------------------------------
test('哨兵：点名要跑时口令文件必须存在（禁止静默全 skip）',
  { timeout: 10_000 }, (t) => {
    if (!UI_ENABLED) {
      t.diagnostic('未点名 ⇒ 允许 skip（本地没有 dev 栈也能跑 npm test）');
      return;
    }
    if (CRED_PASSWORD === null) {
      assert.fail(`点名要跑却没找到口令文件（试过 ${PASSWORD_FILE}）：`
        + '全腿静默 skip 会让 rc=0 与真跑同色（假通过）⇒ 判失败。'
        + '修法：放好凭据文件，或用 ADMIN_PASSWORD_FILE 指过去。');
    }
  });
