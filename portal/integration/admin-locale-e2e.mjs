#!/usr/bin/env node
// 管理台语言切换：真机 e2e（issue #804）。零依赖（只用 node: 内置 + node --test），
// 与 `portal/integration/version-surface-e2e.mjs` / `seat-content-e2e.mjs` 同口径、同结构。
//
// 要验的是「中文浏览器进管理台，就地切英文并让偏好跨 host 共享」这一整条——
// 这是 #804 真正要修的东西，不是某个接口返回什么：
//   - 管理台是独立 origin（`admin.<伞域>:<端口>`），旧版本只把语言偏好存 localStorage（按 origin
//     隔离）⇒ 用户面切的英文，管理台读不到，只能按 navigator.language 重新检测（中文浏览器恒中文）。
//   - #804 把偏好换成**同站 cookie**（Domain = 父域）⇒ 跨子域可见；#450 边缘隔离之后两个 host 各发
//     一份 SPA，语言只能就地在管理台里切（管理台顶栏必须自己挂切换控件）。
// 所以本腿的判据全在**浏览器里的真实行为**上：切了当场生效、刷新仍在、跨 host 也共享。
// 单位级单测（LocaleSwitch.spec / localeCookie.spec / i18n）已验逻辑；本腿验的是装配、cookie 落地
// 形状与**两个 host 共享同一份偏好**这三件纯函数测不出来的东西。
//
// 跑法（口令 / 域名 / 端口等坐标只在本机，不进文档）：
//     node --test portal/integration/admin-locale-e2e.mjs          # 不点名 ⇒ 浏览器腿 skip（带原因）
//     E2E_UI=1 npm run test:integration:locale                     # 点名才跑浏览器腿（需口令 + 容器）
// 本腿口径：点名（E2E_UI=1）即硬要求——环境不齐（缺口令 / docker 不可用 / 容器没跑 / 容器里没
//   playwright 模块 / 入口 net:: 不通）也算**红**（退 1），不许 skip 冒充通过（#804：真机 e2e
//   不做完不算合完）。确知这台机器今天跑不了活栈、只想降级回 skip ⇒ 显式带 E2E_UI_SOFT=1（逃生门）。
// 口令缺失却点名要跑（E2E_UI=1）⇒ 退 1（禁止静默全 skip 拿 rc=0 的假通过）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 自签证书：只在本测试进程内关掉校验。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// 坐标（全部 env 可覆盖；缺省值就是这台部署机的 dev 栈）
// ---------------------------------------------------------------------------
/** 管理台入口（本腿的主场）。 */
const BASE = (process.env.E2E_BASE || process.env.E2E_UI_BASE || 'https://admin.fde.erix.vip:9443')
  .replace(/\/$/, '');
/** 用户面入口（跨 host 共享的对照端：偏好要能从这里也读到）。 */
const USER_BASE = (process.env.E2E_USER_BASE || 'https://station.fde.erix.vip:8443')
  .replace(/\/$/, '');
const ADMIN_LOGIN = process.env.ADMIN_LOGIN || 'admin';
// 凭据目录口径（AGENTS §4）：用户配置目录下 mcp/creds 里的 dev 口令文件（新路径优先、旧路径兜底）。
// env 点名只信 env。
const PASSWORD_FILE_CANDIDATES = (process.env.ADMIN_PASSWORD_FILE
  ? [process.env.ADMIN_PASSWORD_FILE]
  : ['~/.config/mcp/creds/station-dev.password', '~/.config/creds/station-dev-password-file'])
  .map((p) => p.replace(/^~/, os.homedir()));
/** 报错文案用：缺口令时列出试过的路径（新前旧后）。 */
const PASSWORD_FILE = PASSWORD_FILE_CANDIDATES.join(' 或 ');
const UI_ENABLED = process.env.E2E_UI === '1';
/**
 * 逃生门：**显式**承认「这台机器今天跑不了活栈」，把点名（E2E_UI=1）的浏览器腿从「环境不齐判红」
 * 降级回 skip。默认（不设）= 点名即硬要求，环境不齐也判红（#804：真机 e2e 不做完不算合完）。
 * 与文件末尾「点名却没口令 ⇒ 判红」的哨兵用例是同一条口径的两半。
 */
const UI_SOFT = process.env.E2E_UI_SOFT === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
/**
 * 截图：宿主与容器是**两套文件系统**，同一个路径名在容器里未必存在（`/docker/<容器名>/` 是宿主
 * 侧给 vision 读的路，容器内没有那棵树 ⇒ `page.screenshot()` 直接 ENOENT）。
 * 所以两个路径各自有默认值、各自可 env 覆盖：容器内固定落 `/tmp/`，宿主落临时目录，
 * 跑完用 `docker cp` 搬回来（先例：`seat-content-e2e.mjs` 的 SHOT_CONTAINER/SHOT_HOST）。
 */
const SHOT_CONTAINER = process.env.E2E_SHOT_CONTAINER || '/tmp/admin-locale-e2e.png';
const SHOT_HOST = process.env.E2E_SHOT_HOST || path.join(os.tmpdir(), 'admin-locale-e2e.png');
/**
 * 把域名在 TCP 层映到 IP（SNI/Host 仍用域名）。本腿两个 host 都要映：管理台与用户面各是一条
 * `MAP`，都用 `E2E_RESOLVE=host=ip,host2=ip2` 覆盖。缺省把两个域名都映到本机。
 */
const HOST_MAP = (() => {
  const map = {};
  const pairs = process.env.E2E_RESOLVE
    || 'admin.fde.erix.vip=127.0.0.1,station.fde.erix.vip=127.0.0.1';
  for (const pair of pairs.split(',')) {
    const [h, ip] = pair.split('=').map((s) => s.trim());
    if (h && ip) map[h] = ip;
  }
  return map;
})();
/** 与 `HOST_MAP` 同源：给浏览器也加 `MAP <host> <ip>`（两条 host 都进 `--host-resolver-rules`）。 */
const HOST_RESOLVER_RULES = Object.entries(HOST_MAP).map(([h, ip]) => `MAP ${h} ${ip}`).join(',');

// ---------------------------------------------------------------------------
// 小工具（与 seat-content-e2e.mjs 同一份实现口径，照搬不改）
// ---------------------------------------------------------------------------
/** `docker` 直连与「以 docker 组重跑」两条路，探一次记下来（组未生效的会话需要后者）。 */
let dockerPrefix = null;
function dockerCmd(args) {
  if (/\n|\r/.test(args)) throw new Error(`docker 参数不许含换行（组重跑层会变成字面量）: ${JSON.stringify(args)}`);
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
        return { reason: `docker 不可用（直连与组重跑都不行）：${why}` };
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

/** 先新后旧取第一个存在的；空文件视同没有 ⇒ null。 */
function readPassword() {
  const file = PASSWORD_FILE_CANDIDATES.find((p) => fs.existsSync(p));
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value === '' ? null : value;
}
// 哨兵用：模块加载就读一次。
const CRED_PASSWORD = readPassword();

/**
 * 探测浏览器腿能不能跑：把「口令 / docker / 容器在不在跑 / 容器里有没有 playwright 模块」各查一次。
 * 只在**点名要跑**（E2E_UI=1）时调用（探测本身要碰 docker，不点名就别碰）。
 * 跑不了 ⇒ 返回给人看的原因，写进 `probe.reasons.ui`；能跑 ⇒ 返回 null。
 */
const probe = { reasons: {} };
function probeUi() {
  if (CRED_PASSWORD === null) return `没找到口令文件（试过 ${PASSWORD_FILE}）`;
  const d = dockerProbe();
  if (d !== true) return (d && d.reason) || String(d);
  if (!containerRunning(PW_CONTAINER)) return `playwright 容器没在跑（容器名 ${PW_CONTAINER}）`;
  try {
    dockerRun(`exec ${PW_CONTAINER} sh -c "test -e ${PW_MODULE}"`, { timeout: 20_000 });
  } catch {
    return `容器 ${PW_CONTAINER} 里没有 ${PW_MODULE}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 容器里跑的脚本（playwright 只在容器里有；仓库不装这个依赖）。
// 只走 `node:` 内置 + playwright（占位符替换后），用 stdout 的 `REPORT:{json}` 交回结构化结果。
// ---------------------------------------------------------------------------
const CONTAINER_SCRIPT = String.raw`
import { readFileSync, statSync } from 'node:fs';
import { chromium } from '__PW_MODULE__';

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const r = {
  fatal: null,
  login: {},
  admin: {},
  user: {},
  runtime: {},
  pageErrors: [],
  shotBytes: 0,
};

// 语言切换按钮的锚：组件上写死的 button[aria-haspopup="menu"]（aria-label 会随界面语言变，不能当锚）。
// 管理台/用户面工作台里它在 <header> 内，登录卡片头部里它不在 <header> 内 ⇒ 管理台用 header 作用域，
// 用户面登录页用「无作用域」的 button[aria-haspopup="menu"]。
const LOCALE_BTN_ADMIN = 'header button[aria-haspopup="menu"]';
const LOCALE_BTN_ANY = 'button[aria-haspopup="menu"]';
const CJK = '[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]';

// 开语言菜单（真 click 触发组件的 @click；组件是 click 切换开关）。
async function openLocaleMenu(page, sel) {
  await page.waitForSelector(sel, { timeout: 15000 });
  await page.click(sel);
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
}

// 点文案精确等于 want 的那项（语言菜单两项：中文 / English；textContent.trim() 命中）。
async function clickMenuItem(page, want) {
  const found = await page.evaluate((w) => {
    const els = Array.from(document.querySelectorAll('[role="menuitem"]'));
    const el = els.find((e) => (e.textContent || '').trim() === w);
    if (!el) return false;
    el.click();
    return true;
  }, want);
  if (!found) throw new Error('语言菜单里没有文案为 ' + JSON.stringify(want) + ' 的项');
}

let browser = null;
try {
  const launchArgs = ['--no-sandbox'];
  if (cfg.hostResolverRules) launchArgs.push('--host-resolver-rules=' + cfg.hostResolverRules);
  browser = await chromium.launch({ channel: 'chromium', args: launchArgs });

  // ctx locale 固定 zh-CN：模拟中文浏览器（本单的故障就发生在中文浏览器上）。
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => r.pageErrors.push(String((e && e.message) || e).split('\n')[0].slice(0, 300)));

  // ── ① 登录管理台：#\/login 填口令提交，等 hash 离开 /login ──
  await page.goto(cfg.base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20000 });
  await page.fill('#loginName', cfg.login);
  await page.fill('#loginPass', cfg.password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20000 });
  r.login.hash = await page.evaluate(() => location.hash);

  // ── ② 进 #\/admin，等 header；钉「初始是中文」+「顶栏有语言切换控件」 ──
  await page.goto(cfg.base + '/#/admin', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('header', { timeout: 20000 });
  r.admin.langInitial = await page.evaluate(() => document.documentElement.lang);
  // 只有初始中文态才有 aria-label="语言"（该值 = i18n key locale.label 的取值；不 import i18n，只钉这一下）。
  r.admin.ariaLabelLang = await page.evaluate(() => !!document.querySelector('header button[aria-label="语言"]'));
  await page.waitForSelector(LOCALE_BTN_ADMIN, { timeout: 10000 });

  // ── ③ 点控件 → 出现两项 中文 / English；点 English ──
  await openLocaleMenu(page, LOCALE_BTN_ADMIN);
  r.admin.menuItems = await page.evaluate(() => Array.from(document.querySelectorAll('[role="menuitem"]')).map((e) => (e.textContent || '').trim()));
  await clickMenuItem(page, 'English');
  await page.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 10000 });
  await page.waitForTimeout(300);

  // ── ④ 切换当场生效：lang=en；登出按钮文案 Sign out；某颗 nav tab 是英文（取含 User 的一条） ──
  r.admin.langAfterEn = await page.evaluate(() => document.documentElement.lang);
  // 登出按钮 = **布局顶栏**（DOM 里第一个 <header> 元素）的最后一颗 button。
  // ⚠ 不能用「全页 header button」集合取最后一颗：子视图（如用户管理自己的区块 <header>）也在
  //   header 里放按钮，真页面上那颗「＋ Create user」会排在登出之后（真机腿实测踩过）。
  //   单测里没这问题是因为它只挂 AdminLayout、没有子视图 ⇒ 组件注释钉的「插在登出之前」在真页面上
  //   必须由**作用域限定**保证，这里就是那条作用域。
  //   （本段在容器里跑，外面套的是模板字符串 ⇒ 这段注释里不许写反引号。）
  r.admin.logoutText = await page.evaluate(() => {
    const header = document.querySelector('header');
    if (!header) return null;
    const btns = Array.from(header.querySelectorAll('button'));
    const out = btns[btns.length - 1];
    return out ? (out.textContent || '').trim() : null;
  });
  r.admin.localeBtnText = await page.evaluate(() => {
    const header = document.querySelector('header');
    const b = header ? header.querySelector('button[aria-haspopup="menu"]') : null;
    return b ? (b.textContent || '').trim() : null;
  });
  r.admin.tabTexts = await page.evaluate(() => Array.from(document.querySelectorAll('nav a')).map((e) => (e.textContent || '').trim()));

  // ── ⑤ 偏好落同站 cookie：document.cookie 里 locale=en（该 cookie 非 httpOnly ⇒ 脚本读得到） ──
  r.admin.cookie = await page.evaluate(() => document.cookie);
  r.admin.cookieLocale = await page.evaluate(() => {
    for (const p of (document.cookie || '').split(';')) {
      const i = p.indexOf('=');
      if (i < 0) continue;
      if (p.slice(0, i).trim() === 'locale') return decodeURIComponent(p.slice(i + 1).trim());
    }
    return null;
  });

  // 英文态管理台截图（此时在 #\/admin 且已切到 en）。
  await page.screenshot({ path: cfg.shotPath });
  try { r.shotBytes = statSync(cfg.shotPath).size; } catch { /* 容器内没落盘，宿主回收时再看 */ }

  // ── ⑥ 刷新仍在（钉持久化 + detectLocale 读 cookie） ──
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('header', { timeout: 20000 });
  r.admin.langAfterReload = await page.evaluate(() => document.documentElement.lang);

  // ── ⑦ 跨 host 共享（本单要治的故障）：同 context 去用户面登录页，断言也是英文 ──
  //    会话 cookie 是 host-only、不跨 host ⇒ 用户面显示登录页是预期，别断言登录态。
  await page.goto(cfg.userBase + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(LOCALE_BTN_ANY, { timeout: 20000 });
  r.user.lang = await page.evaluate(() => document.documentElement.lang);

  // ── ⑧ 反方向也共享：用户面切回中文 → 回管理台 reload → zh-CN ──
  await openLocaleMenu(page, LOCALE_BTN_ANY);
  await clickMenuItem(page, '中文');
  await page.goto(cfg.base + '/#/admin', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('header', { timeout: 20000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('header', { timeout: 20000 });
  r.admin.langBackToZh = await page.evaluate(() => document.documentElement.lang);

  // ── ⑩ 切回 English → 进 #\/admin\/runtime：表头英文；**行名与小字都不该再有中文**（#803 S1）──
  await openLocaleMenu(page, LOCALE_BTN_ADMIN);
  await clickMenuItem(page, 'English');
  await page.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 10000 });
  await page.goto(cfg.base + '/#/admin/runtime', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('[data-test^="runtime-label-"]', { timeout: 20000 });
  await page.waitForTimeout(400);
  r.runtime.colValueFound = await page.evaluate(() => Array.from(document.querySelectorAll('th'))
    .some((e) => (e.textContent || '').trim() === 'Current value'));
  // #803 S1 之后，注册表的 label / hint 由服务端按请求语言下发（cookie locale=en 随同源 API 自动带上）
  // ⇒ 英文态这一屏的**行名与小字都不该含中文**。读数把「命中格数」一起带回去：selector 一格没命中时
  // 「没中文」会恒真，必须同时钉「确实是一屏真条目」，否则断言会被空页面骗过。
  const cjkRe = new RegExp(CJK);
  r.runtime.rows = await page.evaluate((re) => {
    const grab = (sel) => Array.from(document.querySelectorAll(sel)).map((e) => (e.textContent || '').trim());
    const labels = grab('[data-test^="runtime-label-"]');
    const hints = grab('[data-test^="runtime-hint-"]');
    return {
      labelCount: labels.length,
      hintCount: hints.length,
      labelCjk: labels.filter((t) => re.test(t)),
      hintCjk: hints.filter((t) => re.test(t)),
    };
  }, cjkRe);
  // ── ⑩ 裸 key 哨兵：整页文本不得出现这些未翻译 key 前缀 ──
  r.runtime.bareKeyHits = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return ['admin.runtime.', 'admin.tabs.', 'locale.'].filter((tok) => text.includes(tok));
  });

  await context.close();
} catch (err) {
  r.fatal = String((err && err.message) || err).split('\n')[0].slice(0, 300);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
`;

test('管理台语言切换：真浏览器里切英文当场生效、刷新仍在、并跨 host 共享到用户面', async (t) => {
  if (!UI_ENABLED) {
    t.skip('浏览器腿要点名才跑（E2E_UI=1）——未点名，按设计 skip');
    return;
  }
  t.diagnostic(`管理台入口：${BASE}；用户面入口：${USER_BASE}；容器：${PW_CONTAINER}；域名映射：${HOST_RESOLVER_RULES || '(不映射，直连 URL host)'}`);
  const reason = probeUi();
  if (reason) {
    probe.reasons.ui = reason;
    // 点名即硬要求：环境不齐也算红（缺的是哪一样由 reason 点名）；不想被判红就显式带 E2E_UI_SOFT=1。
    if (UI_SOFT) {
      t.skip(`浏览器腿跑不了（已显式 E2E_UI_SOFT=1 降级）：${reason}`);
      return;
    }
    assert.fail(`E2E_UI=1 点名要跑，环境却不齐（缺：${reason}）——不能以 skip 冒充通过；不想被判红就显式带 E2E_UI_SOFT=1`);
    return;
  }
  const password = CRED_PASSWORD;

  // 把脚本与配置（含口令）拷进容器；跑完在 finally 里尽力删（那是带口令的文件）。
  const uid = `${process.pid}-${Date.now()}`;
  const scriptHost = path.join(os.tmpdir(), `admin-locale-ui-${uid}.mjs`);
  const cfgHost = path.join(os.tmpdir(), `admin-locale-ui-${uid}.json`);
  const scriptIn = `/tmp/admin-locale-ui-${uid}.mjs`;
  const cfgIn = `/tmp/admin-locale-ui-${uid}.json`;
  const cfg = {
    base: BASE,
    userBase: USER_BASE,
    login: ADMIN_LOGIN,
    password,
    hostResolverRules: HOST_RESOLVER_RULES,
    shotPath: SHOT_CONTAINER,
  };
  try {
    fs.writeFileSync(scriptHost, CONTAINER_SCRIPT.replace('__PW_MODULE__', PW_MODULE), { mode: 0o600 });
    fs.writeFileSync(cfgHost, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    dockerRun(`cp ${scriptHost} ${PW_CONTAINER}:${scriptIn}`);
    dockerRun(`cp ${cfgHost} ${PW_CONTAINER}:${cfgIn}`);
    const out = dockerRun(`exec ${PW_CONTAINER} node ${scriptIn} ${cfgIn}`, { timeout: 300_000 });
    const m = out.match(/REPORT:(\{.*\})/);
    assert.ok(m, `容器脚本没吐 REPORT——原始输出尾部：\n${out.slice(-2000)}`);
    const rep = JSON.parse(m[1]);
    const admin = rep.admin;
    t.diagnostic(`致命：${rep.fatal ?? '(无)'}\n管理台读数：${JSON.stringify(admin)}\n用户面读数：${JSON.stringify(rep.user)}\nruntime 读数：${JSON.stringify(rep.runtime)}\npageErrors：${JSON.stringify(rep.pageErrors)}`);

    // 致命错误分两类（区分环境与产品）：
    //   环境到不了入口（net:: / 连不上 / 超时 / 握手）⇒ 环境问题，skip。
    //   到了页面却没跑通（脚本里抛的：找不到控件、点了没反应、超时）⇒ 产品红，assert.fail。
    if (rep.fatal) {
      if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
        // 环境到不了入口：点名即硬要求，也算红；不想被判红就显式带 E2E_UI_SOFT=1。
        if (UI_SOFT) {
          t.skip(`环境到不了入口（net:: 类，已显式 E2E_UI_SOFT=1 降级）：${rep.fatal}`);
          return;
        }
        assert.fail(`E2E_UI=1 点名要跑，环境却到不了入口（缺：${rep.fatal}）——不能以 skip 冒充通过；不想被判红就显式带 E2E_UI_SOFT=1`);
        return;
      }
      assert.fail(`到了入口却没跑通（产品红）：${rep.fatal}（管理台 ${BASE}）`);
    }

    // ② 初始是中文 + 顶栏挂了语言切换控件
    assert.equal(admin.langInitial, 'zh-CN', `中文浏览器 + 无偏好 ⇒ 管理台初始应是 zh-CN，实际 ${JSON.stringify(admin.langInitial)}`);
    assert.ok(admin.ariaLabelLang, '顶栏应有 aria-label="语言" 的语言切换按钮（该值是 i18n key locale.label 的取值）');
    // ③ 菜单两项、文案分别是中文 / English
    assert.deepEqual(admin.menuItems, ['中文', 'English'], `语言菜单两项应是「中文 / English」，实际 ${JSON.stringify(admin.menuItems)}`);
    // ④ 切换当场生效：lang=en、登出按钮 Sign out、某颗 nav tab 是英文
    assert.equal(admin.langAfterEn, 'en', `点 English 后 <html lang> 应当场变 en，实际 ${JSON.stringify(admin.langAfterEn)}`);
    assert.equal(admin.logoutText, 'Sign out', `英文态**布局顶栏**最后一颗 button 应是登出（Sign out），实际 ${JSON.stringify(admin.logoutText)}——若这里出现「＋ Create user」，说明作用域又漏到子视图自己的 <header> 了`);
    assert.match(String(admin.localeBtnText || ''), /English/, `英文态顶栏语言按钮自身文案应跟着变（实测是「English ▾」），实际 ${JSON.stringify(admin.localeBtnText)}`);
    assert.ok((admin.tabTexts || []).some((x) => /User/.test(x)), `英文态 nav 里应至少一颗 tab 是英文（取含 User 的一条），实际 ${JSON.stringify(admin.tabTexts)}`);
    // ⑤ 偏好落同站 cookie
    assert.equal(admin.cookieLocale, 'en', `切英文后同站 cookie 的 locale 应是 en（document.cookie 含 locale=en），实际 locale=${JSON.stringify(admin.cookieLocale)}、cookie=${JSON.stringify(admin.cookie)}`);
    // ⑥ 刷新仍在
    assert.equal(admin.langAfterReload, 'en', `刷新后 <html lang> 仍应是 en（钉持久化 + detectLocale 读 cookie），实际 ${JSON.stringify(admin.langAfterReload)}`);
    // ⑦ 跨 host 共享：用户面登录页也是英文
    assert.equal(rep.user.lang, 'en', `跨 host 到用户面也应读到英文（同站 cookie 共享，这是 #804 要治的故障），实际 ${JSON.stringify(rep.user.lang)}`);
    // ⑧ 反方向也共享
    assert.equal(admin.langBackToZh, 'zh-CN', `用户面切回中文后，回管理台 reload 应是 zh-CN，实际 ${JSON.stringify(admin.langBackToZh)}`);
    // ⑩ 运行时设置页：表头英文 + **服务端下发的行名与小字也已双语**（#803 S1 的验收面）
    assert.ok(rep.runtime.colValueFound, '英文态 runtime 表头应有 "Current value" 那一格');
    //    注册表现有 12 条 label / 11 条 hint；这里留余量（增删条目不该假红），但必须是「一屏真条目」，
    //    否则下面两条「不含中文」会被空 selector 顶成恒真。
    assert.ok(rep.runtime.rows.labelCount >= 10, `英文态 runtime 页应渲染出一屏条目（现注册表 12 条，留余量取 >=10），实际命中 ${rep.runtime.rows.labelCount} 格`);
    assert.ok(rep.runtime.rows.hintCount >= 8, `英文态 runtime 页的小字提示也应有一屏（现注册表 11 条带 hint，留余量取 >=8），实际命中 ${rep.runtime.rows.hintCount} 格`);
    assert.deepEqual(rep.runtime.rows.labelCjk, [], `英文态行名格不该再含中文（#803 S1：注册表 label 已按请求语言下发），实际 ${JSON.stringify(rep.runtime.rows.labelCjk)}`);
    assert.deepEqual(rep.runtime.rows.hintCjk, [], `英文态小字提示不该再含中文（#803 S1：注册表 hint 已按请求语言下发），实际 ${JSON.stringify(rep.runtime.rows.hintCjk)}`);
    // ⑩b 裸 key 哨兵
    assert.deepEqual(rep.runtime.bareKeyHits, [], `整页不得出现未翻译 key 前缀（admin.runtime. / admin.tabs. / locale.），实际命中 ${JSON.stringify(rep.runtime.bareKeyHits)}`);
    // ⑪ pageerror = 0
    assert.deepEqual(rep.pageErrors, [], `管理台英文态不该抛页面级 JS 异常，实际 ${JSON.stringify(rep.pageErrors)}`);

    // 把容器里的截图取回宿主（两侧路径各自独立，见文件头 SHOT_* 那段）；只证明「英文态页面真渲染出来了」，不当硬判据。
    const bytes = (() => {
      try {
        tryQuiet(() => fs.rmSync(SHOT_HOST));
        dockerRun(`cp ${PW_CONTAINER}:${SHOT_CONTAINER} ${SHOT_HOST}`, { timeout: 30_000 });
        return fs.statSync(SHOT_HOST).size;
      } catch { return 0; }
    })();
    assert.ok(bytes > 1024, `英文态管理台截图没拿回宿主（容器内读数 ${rep.shotBytes}，宿主 ${SHOT_HOST}）`);
    t.diagnostic(`英文态管理台截图：${SHOT_HOST}（${bytes} 字节，容器内读数 ${rep.shotBytes}）`);
  } finally {
    // ⑫ 收尾：容器里那份带口令的 cfg + 脚本都尽力删；宿主临时文件也删（截图留在宿主，是给人看的）。
    tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`));
    tryQuiet(() => fs.rmSync(scriptHost));
    tryQuiet(() => fs.rmSync(cfgHost));
  }
});

test('哨兵：点名了（E2E_UI=1）却没有口令 ⇒ 判红，禁止静默全 skip 拿 rc=0', () => {
  if (!UI_ENABLED) return;
  // 点名要跑却连口令都找不到 ⇒ 几乎一定是忘了注入凭据目录，必须判红而不是 skip。
  // 与主用例里「环境不齐（口令 / docker / 容器 / 模块 / net::）⇒ assert.fail」是同一条口径的两半：
  // 主用例那半要探测才拿得到原因（探测本身要碰 docker，不点名就别碰），口令这条在模块加载就能判，故各自守一段。
  assert.ok(CRED_PASSWORD !== null,
    `E2E_UI=1 点名了浏览器腿，但没找到口令文件（试过 ${PASSWORD_FILE}）——口令缺失不能静默 skip 冒充通过`);
});
