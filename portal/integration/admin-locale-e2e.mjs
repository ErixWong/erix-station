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
// #828 P3 在同一次跑里追加了一条腿（接在管理台那段之后，另开 context、另用脚本账号）：
//   在**用户面**切一次英文（顺手 PATCH /api/me/locale 必须真发出去，靠请求监听钉）⇒ 清掉这个
//   origin 的 cookie 与 localStorage（模拟新设备 / 清了站点数据，清完回读确认真的空了）⇒
//   重新登录**一步都不点**，界面直接是英文，且 cookie 与 localStorage 被账号值重新灌满。
//   这条是「下次登录不用重选」的判据本体：单测只能证 store 调了 applyAccountLocale，证不了
//   真会话 + 真登录响应 + 真清载体。跑完在 finally 里把该账号的 locale 恢复成 null 并回读确认
//   （别把 dev 账号留在英文态）；脚本账号口令同样只从本机凭据目录读，仓库里不出现口令。
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
import { credsFileCandidates, defaultScriptLogin } from './lib/dev-creds.mjs';

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
/**
 * #828 的脚本账号：dev 专用 FDE 账号（`role=fde`，不开邮箱验证码也不开 TOTP ⇒ 脚本能一路登到底），
 * 与同目录各脚本的 `E2E_FDE_LOGIN` 同名同默认。
 *
 * 为什么不用 `admin` 做这条腿：这条腿要往账号上写 `locale` 再清回去，拿管理员账号做写测试会把
 * 管理台那个入口的初始态搞脏（下一条跑的人看到的第一个界面就是英文）。先例：`user-usage-e2e.mjs`
 * 的 `FDE_LOGIN` / `E2E_FDE_PASSWORD_FILE`。但**收尾仍要把 `ADMIN_LOGIN` 一起恢复**——上面那条管理台
 * 腿经 UI 的 `PATCH /api/me/locale` 会真改 `users.locale`（现场曾把 dev 上的 `admin` 留成英文）。
 */
const SCRIPT_LOGIN = process.env.E2E_FDE_LOGIN || defaultScriptLogin();
// 凭据目录口径（AGENTS §4）：用户配置目录下 mcp/creds 里的 dev 口令文件（新路径优先、旧路径兜底）。
// env 点名只信 env。
const PASSWORD_FILE_CANDIDATES = (process.env.ADMIN_PASSWORD_FILE
  ? [process.env.ADMIN_PASSWORD_FILE]
  : credsFileCandidates('admin'))
  .map((p) => p.replace(/^~/, os.homedir()));
/** 报错文案用：缺口令时列出试过的路径（新前旧后）。 */
const PASSWORD_FILE = PASSWORD_FILE_CANDIDATES.join(' 或 ');
/** 脚本账号口令文件：同一套凭据目录口径（env 点名只信 env，新路径优先、旧路径兜底）。 */
const SCRIPT_PASSWORD_FILE_CANDIDATES = (process.env.E2E_FDE_PASSWORD_FILE
  ? [process.env.E2E_FDE_PASSWORD_FILE]
  : credsFileCandidates('script'))
  .map((p) => p.replace(/^~/, os.homedir()));
const SCRIPT_PASSWORD_FILE = SCRIPT_PASSWORD_FILE_CANDIDATES.join(' 或 ');
const UI_ENABLED = process.env.E2E_UI === '1';
/**
 * 逃生门：**显式**承认「这台机器今天跑不了活栈」，把点名（E2E_UI=1）的浏览器腿从「环境不齐判红」
 * 降级回 skip。默认（不设）= 点名即硬要求，环境不齐也判红（#804：真机 e2e 不做完不算合完）。
 * 与文件末尾「点名却没口令 ⇒ 判红」的哨兵用例是同一条口径的两半。
 */
const UI_SOFT = process.env.E2E_UI_SOFT === '1';
const PW_CONTAINER = process.env.PLAYWRIGHT_CONTAINER || 'erix_station_playwright';
const PW_MODULE = '/app/node_modules/playwright/index.mjs';
/** dev 栈的 Postgres 容器名（与同目录各 wpN/db 集成脚本同名同默认）；#828 收尾恢复账号语言值要用。 */
const STATION_DB_NAME = process.env.STATION_DB_NAME || 'station-db';
/**
 * 截图：宿主与容器是**两套文件系统**，同一个路径名在容器里未必存在（`/docker/<容器名>/` 是宿主
 * 侧给 vision 读的路，容器内没有那棵树 ⇒ `page.screenshot()` 直接 ENOENT）。
 * 所以两个路径各自有默认值、各自可 env 覆盖：容器内固定落 `/tmp/`，宿主落临时目录，
 * 跑完用 `docker cp` 搬回来（先例：`seat-content-e2e.mjs` 的 SHOT_CONTAINER/SHOT_HOST）。
 */
const SHOT_CONTAINER = process.env.E2E_SHOT_CONTAINER || '/tmp/admin-locale-e2e.png';
const SHOT_HOST = process.env.E2E_SHOT_HOST || path.join(os.tmpdir(), 'admin-locale-e2e.png');
// 第二张：**运行时设置页英文态**（#803 的可见面：行名与小字由服务端按语言下发，像素证据只能在这里拿）。
// 从主图路径派生（插一个 `-runtime` 后缀），免得两个变量各自漂：主图能落的目录这一张也能落。
const withSuffix = (p) => (p.endsWith('.png') ? `${p.slice(0, -4)}-runtime.png` : `${p}.runtime.png`);
const SHOT2_CONTAINER = process.env.E2E_SHOT2_CONTAINER || withSuffix(SHOT_CONTAINER);
// 第三张：**账号级语言偏好腿**重新登录后的英文态工作台（#828 P3）。同样从主图目录派生，
// 拿回宿主只当给人看的附件（硬判据是那几条 DOM 文本与载体读数），不判红。
const withAccountSuffix = (p) => (p.endsWith('.png') ? `${p.slice(0, -4)}-account.png` : `${p}.account.png`);
const SHOT3_CONTAINER = process.env.E2E_SHOT3_CONTAINER || withAccountSuffix(SHOT_CONTAINER);
const SHOT3_HOST = process.env.E2E_SHOT3_HOST || withAccountSuffix(SHOT_HOST);
const SHOT2_HOST = process.env.E2E_SHOT2_HOST || withSuffix(SHOT_HOST);
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

/**
 * 对 dev 栈 Postgres 跑一句单行 SQL（与同目录 `wp5-e2e.mjs` / `wp3b-e2e.mjs` 的 psql 同口径）。
 * `-tAc`：tuples-only + 不加边框 + 直接跑命令；`dockerCmd` 拒绝换行 ⇒ SQL 必须单行。
 */
function psql(query) {
  return dockerRun(`exec -i ${STATION_DB_NAME} psql -U station -d station -tAc ${JSON.stringify(query)}`, { timeout: 20_000 }).trim();
}

/** SQL 字符串字面量（登录名里的单引号转双单引号）。 */
function sqlLit(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * #878：`E2E_UI_SOFT=1` 到底该不该把一次失败降级成 skip——抽成纯函数，**只认调用点显式传来的
 * `phase`，绝不从 message 猜**。
 *
 * 只允许在**环境探测阶段**（`phase==='probe'`：口令/凭据读取、docker 可用性、playwright 容器在不在、
 * playwright 模块能不能加载、`--host-resolver-rules` 能不能生效——都是「真浏览器跑起来之前」的探测）
 * 降级。`phase==='run'`（真浏览器已经开起来、已经在导航/点击/断言）里炸出的 `net::` 一律判红：
 * 那多半是用例中段页面自身的问题，若被 `E2E_UI_SOFT=1` 降级成 skip，真回归就被静默吃掉了。
 * `soft` 为假（没点名软降级）时一律不降级——点名要跑就判红，与哨兵同口径。`message` 只是给人看的上下文，
 * 不参与阶段判定。
 */
export function shouldSoftSkip({ soft = false, phase, message = '' } = {}) {
  if (!soft) return false;
  if (phase !== 'probe') return false;
  void message;
  return true;
}

/**
 * #828 收尾（**必须放 finally**）：把浏览器腿在 DB 里改动的两个账号语言值恢复成 `null`，并**回读确认**。
 *
 * 为什么要：本腿在管理台把 admin 切到英文，切换当场经 `PATCH /api/me/locale` 真写进了 `users.locale`；
 * 旧脚本收尾只清了临时文件、**没碰 DB** ⇒ 把 dev 上的 `admin` 留成了英文（现场 `admin.locale='en'`）。
 * 两个账号（`ADMIN_LOGIN` 与 `SCRIPT_LOGIN`）一起恢复；UPDATE 尽力而为，
 * 但**回读确认是硬判据**：哪个账号没回到 `NULL`、或**回读本身跑不动**，都判红（留脏值正是本腿要修的污染）。
 *
 * #878：回读跑不动不再是「记一句日志就返回」——那等于「没确认成功也算过」。`psql` 调用做成可注入
 * 参数 `runPsql`（默认值仍是真 `docker exec` 的 `psql`）与 `soft`（默认 `UI_SOFT`），好让这条判据能在
 * **不启动真库/浏览器**的情况下被 `node --test` 测到。
 *
 * #902 ③：`soft` 已**不再兑底回读跑不动**——收尾发生在运行阶段之后，走 `shouldSoftSkip({ phase: 'run' })`
 * ⇒ 恒 `false` ⇒ 无论 `soft` 真假，回读跑不动一律判红。`soft` 参数保留只为让上面那些用例能显式传
 * `soft: true` 钉住这条性质（见新增的 soft:true 仍判红一例）；`E2E_UI_SOFT` 只兑环境**探测**阶段的降级。
 */
function resetAccountLocalesAndConfirm({ runPsql = psql, soft = UI_SOFT } = {}) {
  const targets = [ADMIN_LOGIN, SCRIPT_LOGIN];
  const inList = targets.map(sqlLit).join(', ');
  // UPDATE 尽力而为：容器不可用 / 这套库没这个账号 / docker 抖动 ⇒ 不让清理动作本身炸掉已经跑绿的用例。
  // 但注意：兜住「UPDATE 到底生效没有」的是**下面的回读判红**，不是这个 tryQuiet——tryQuiet 只吞异常，
  // 真把脏值留下了会由回读兜住（见下），别把它当成「恢复失败也算过」。
  tryQuiet(() => runPsql(`UPDATE users SET locale = NULL WHERE login IN (${inList})`));
  // 回读：`login=<value>` 一行一个，`NULL` 代指未设。**回读跑不动 = 没确认成功 = 不算恢复 ⇒ 一律判红。**
  // 理由：本腿会把 dev 上的账号语言值写脏，「恢复了却没确认」与「没恢复」在账上必须同等对待
  //（`E2E_UI=1` 的口径就是「不许静默冒充通过」）。回读本身抛错正是「没确认成功」，故判红而非记一句日志返回。
  // #902 ③：收尾发生在**运行阶段之后**，按 #884「运行阶段不降级」的口径，这里**不受 `E2E_UI_SOFT` 豁免**：
  // 走 `shouldSoftSkip({ phase: 'run' })` ⇒ 恒 `false`（它只兑环境**探测**阶段的降级，不兑运行阶段之后的收尾确认）。
  let rows;
  try {
    rows = runPsql(`SELECT login || '=' || COALESCE(locale, 'NULL') FROM users WHERE login IN (${inList}) ORDER BY login`);
  } catch (err) {
    const why = String(err?.message || err).split('\n')[0];
    // 恒判红：`phase: 'run'` 下 `shouldSoftSkip` 永远返回 `false`，所以 `soft` 为真也不降级（把下面
    // 改回 `if (soft)` 就等于旧行为，#902 ③ 新加的 soft:true 例就会变红）。
    if (shouldSoftSkip({ soft, phase: 'run', message: why })) {
      console.log(`# 收尾回读跑不动（降级，不判红）：${why}`);
      return;
    }
    assert.fail(`收尾回读跑不动：无法确认 ${targets.join(' 与 ')} 两个账号的语言值已恢复（原因：${why}）——本腿会把 dev 上的账号语言值写脏，恢复了却没确认和没恢复在账上同等对待，没确认成功不能算恢复（#902 ③：收尾在运行阶段之后，E2E_UI_SOFT 不兑这一段，恒判红）`);
    return;
  }
  const seen = Object.fromEntries(rows.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
  for (const login of targets) {
    const val = seen[login];
    // 「账号缺行（回读里没有这一行）不算脏」只覆盖一种情况：**这套 dev 库里本来就没有这个账号**。
    // 它**不**覆盖「UPDATE 没生效 ⇒ 行还在且非 NULL」——那种情况 `val` 是真值（如 'en'），下面判红（今天也确实判红）。
    if (val !== undefined && val !== 'NULL') {
      assert.fail(`收尾回读：账号 ${login} 的 locale 应已恢复为 NULL，实际为 ${JSON.stringify(val)}（本腿会把 dev 上的账号留成脏语言值）`);
    }
  }
}

  const file = PASSWORD_FILE_CANDIDATES.find((p) => fs.existsSync(p));
/** 先新后旧取第一个存在的；空文件视同没有 ⇒ null。（两个账号各读各的文件，同一套读法。） */
function readPassword(candidates = PASSWORD_FILE_CANDIDATES) {
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) return null;
  const value = fs.readFileSync(file, 'utf8').trim();
  return value === '' ? null : value;
}
// 哨兵用：模块加载就读一次。
const CRED_PASSWORD = readPassword();
// #828 P3：脚本账号（`SCRIPT_LOGIN`）的口令；缺失与 admin 口令缺失同口径（点名 ⇒ 判红，不静默 skip）。
const CRED_SCRIPT_PASSWORD = readPassword(SCRIPT_PASSWORD_FILE_CANDIDATES);

/**
 * 探测浏览器腿能不能跑：把「口令 / docker / 容器在不在跑 / 容器里有没有 playwright 模块」各查一次。
 * 只在**点名要跑**（E2E_UI=1）时调用（探测本身要碰 docker，不点名就别碰）。
 * 跑不了 ⇒ 返回给人看的原因，写进 `probe.reasons.ui`；能跑 ⇒ 返回 null。
 */
const probe = { reasons: {} };
function probeUi() {
  if (CRED_PASSWORD === null) return `没找到口令文件（试过 ${PASSWORD_FILE}）`;
  if (CRED_SCRIPT_PASSWORD === null) return `没找到脚本账号口令文件（账号 ${SCRIPT_LOGIN}，试过 ${SCRIPT_PASSWORD_FILE}）`;
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
  account: null,
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

// ── 下面四个小工具只服务「账号级语言偏好」那条腿（#828 P3）─────────────────────────────
// ⚠ 本文件把这些代码包在 String.raw 模板里 ⇒ 模板体内的注释与字符串一律不许写反引号
//   （反引号会提前闭合外层模板，而 node --check 可能照样过），也不许写模板插值。

// 登进某个入口：先 goto 登录页再填（登出之后那个口令 field 就不在了，直接 fill 会 not found）。
async function loginInto(page, base, login, password) {
  await page.goto(base + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
  // 必须再来一次**整页重载**：从已加载的 SPA 改 hash 不会重建文档，pinia 里那份「已登录」还在，
  // 守卫于是把 /login 又改写回工作台 ⇒ 表单永远不出现，本腿第一次判红就是死在这里（真机读数：
  // 清了 cookie 之后仍停在 #/ 且正文写着已登录的账号）。清站点数据模拟的是新设备，得让文档真的重来。
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#loginName, input[autocomplete="username"]', { timeout: 20000 });
  await page.fill('#loginName, input[autocomplete="username"]', login);
  await page.fill('#loginPass', password);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !location.hash.includes('/login'), null, { timeout: 20000 });
}

// 登进之后固定去用户面工作台：钉**路由里真存在的那条正址**（hash 后面的路径写 '/'）。
// router 里 name 'workbench' 挂在 path '/'，并没有 '/workbench' 这条 route ⇒ 导航到一个没注册的
// 路径只会渲染空视图，看着像「页面没顶栏」的假故障。hash 内部的导航不是整页重载（文档不重建、
// i18n 不重新检测），所以它不会把「登录后一步都不点就变英文」洗成「刷新后才变」。
async function gotoWorkbench(page, base) {
  await page.goto(base + '/#/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector(LOCALE_BTN_ADMIN, { timeout: 20000 });
}

// 同源调 API（会话 cookie 自动带上）。返回 status + 解不了的 body 就是 null；要它而不是靠界面
// 读数，是为了把「服务端确实收到/存了那个值」与「界面碰巧显示了英文」分开证。
async function apiCall(page, base, method, apiPath, payload) {
  const hasBody = payload !== undefined;
  return page.evaluate(async (args) => {
    const init = { method: args.method, credentials: 'same-origin' };
    if (args.hasBody) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = args.bodyText;
    }
    const res = await fetch(args.base + args.apiPath, init);
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    return { status: res.status, body: body };
  }, { base: base, method: method, apiPath: apiPath, hasBody: hasBody, bodyText: hasBody ? JSON.stringify(payload) : null });
}

// 语言偏好的两个载体（cookie 名 locale 与 localStorage 键 locale）一次读齐；cookieText 一起带回去，
// 免得「locale 没读到」其实是整串 cookie 都没了而断言说不清原因。
// #902 ①：顺带读 locale_chosen——它是「用户亲自点过开关」的跨子域标记（与偏好同作用域）。
// 这个性质 jsdom 证不了（jsdom 不按真实 hostname 处理 Domain），只有真机能证「在管理台点的标记，
// 用户面那个 origin 看得见」，所以在这里钉一条。（本段在 String.raw 模板体内 ⇒ 不带反引号。）
async function readCarriers(page) {
  return page.evaluate(() => {
    let cookieLocale = null;
    let cookieChosen = null;
    for (const part of (document.cookie || '').split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      const name = part.slice(0, i).trim();
      if (name === 'locale') cookieLocale = decodeURIComponent(part.slice(i + 1).trim());
      if (name === 'locale_chosen') cookieChosen = decodeURIComponent(part.slice(i + 1).trim());
    }
    let storageLocale = null;
    let storageKeys = [];
    try {
      storageLocale = localStorage.getItem('locale');
      storageKeys = Object.keys(localStorage);
    } catch (e) {
      storageLocale = null;
      storageKeys = [];
    }
    return { cookieLocale: cookieLocale, cookieChosen: cookieChosen, storageLocale: storageLocale, storageKeys: storageKeys, cookieText: document.cookie || '' };
  });
}

// 清掉这个 origin 的站点数据（模拟新设备 / 用户清了站点数据）：cookie 走 context.clearCookies，
// localStorage 走页面里 clear。清完立即回读一次交给断言判残留（残留 ⇒ 后面那条「重登还是英文」不算证据）。
async function clearSiteData(page, context) {
  await context.clearCookies();
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (e) { /* 隐私模式 / 禁用存储：本来就没什么可清 */ }
  });
  return readCarriers(page);
}

// 顶栏语言态的稳定文案读数（挑 DOM 文本与 aria-label，**不挑 class**）：
//   · 顶栏最后一颗 button = 登出（zh 登出 / en Sign out）
//   · 语言切换按钮自身文案（zh 中文 / en English）与它的 aria-label（locale.label：zh 语言 / en Language）
//   · header 整块里还有没有中文菜单文案（反向钉「chrome 真的换了语言」，限在 header 作用域里，
//     免得会话标题那种用户内容把它假红）
// cjkLines 只带回去给人看（用户内容可能本来就是中文），不当判据。
async function localeTexts(page) {
  return page.evaluate((pat) => {
    const re = new RegExp(pat);
    const header = document.querySelector('header');
    const btns = header ? Array.from(header.querySelectorAll('button')) : [];
    const last = btns.length ? (btns[btns.length - 1].textContent || '').trim() : null;
    const localeBtn = header ? header.querySelector('button[aria-haspopup="menu"]') : null;
    const headerText = header ? (header.innerText || '') : '';
    const bodyText = document.body ? (document.body.innerText || '') : '';
    return {
      headerButtonCount: btns.length,
      logoutText: last,
      localeBtnText: localeBtn ? (localeBtn.textContent || '').trim() : null,
      localeBtnAria: localeBtn ? (localeBtn.getAttribute('aria-label') || null) : null,
      headerHasZhChrome: /登出|新会话|语言/.test(headerText),
      bodyHasNewSessionEn: bodyText.indexOf('New session') >= 0,
      cjkLines: bodyText.split('\n').filter((l) => re.test(l)).slice(0, 5),
    };
  }, CJK);
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
  // #902 ①：在**用户面这个 origin** 读一次载体——标记必须在（它跟偏好同为跨子域 cookie，不是 localStorage）
  r.user.carriers = await readCarriers(page);

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
  // 像素证据：#803 之后这一屏该全英文（DOM 读数能证「没中文」，但「渲染得对不对」靠这张图给人看）。
  await page.screenshot({ path: cfg.shotPath2 });
  try { r.shotBytes2 = statSync(cfg.shotPath2).size; } catch { /* 容器内没落盘，宿主回收时再看 */ }
  // ── ⑩ 裸 key 哨兵：整页文本不得出现这些未翻译 key 前缀 ──
  r.runtime.bareKeyHits = await page.evaluate(() => {
    const text = document.body.innerText || '';
    return ['admin.runtime.', 'admin.tabs.', 'locale.'].filter((tok) => text.includes(tok));
  });

  await context.close();

  // ── ⓬ 账号级语言偏好（#828 P3，本单验收判据 4 的本体）：脚本账号在**用户面**切一次英文 ⇒
  //      清掉站点数据（模拟新设备 / 用户清了站点数据）⇒ 重新登录**一步都不点**就是英文。──
  // 为什么必须真机：单测只能证 store 里调了 applyAccountLocale，证不了「库里那个值真的经登录响应
  // 灌进了 cookie 与 localStorage、并且界面第一帧就按它渲染」——那要真会话、真登录响应、真清载体。
  // 载体口径（前端 i18n）：cookie 名 locale（父域、非 httpOnly ⇒ 脚本读得到）与 localStorage 键 locale。
  // ⚠ 本段在 String.raw 模板体内：注释与字符串里都不许出现反引号，也不许写模板插值。
  const acct = { patchCalls: [], pageErrors: [] };
  r.account = acct;
  let acctCtx = null;
  let apage = null;
  try {
    // 单独开一个 context：cookie 与 localStorage 按 context 隔离，别把上面那条腿的载体混进来。
    // 容器 locale 仍钉 zh-CN：模拟中文浏览器，这样「起点是中文」与「后来变英文」都只能归因到账号值。
    acctCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', ignoreHTTPSErrors: true });
    apage = await acctCtx.newPage();
    apage.on('pageerror', (e) => acct.pageErrors.push(String((e && e.message) || e).split('\n')[0].slice(0, 300)));
    // 请求监听（切语言时前端该顺手回写账号值）：**只看界面变了不算证据**，method / URL / 请求体
    // 三样一起记下来，交给宿主断言。每次要数之前把数组清一次，免得把上一枪算成这一枪。
    apage.on('request', (req) => {
      const url = req.url() || '';
      if (req.method() === 'PATCH' && url.indexOf('/api/me/locale') >= 0) {
        acct.patchCalls.push({ method: req.method(), url: url, body: req.postData() });
      }
    });

    // ⓬a 预清（本身不是判据）：先登一次，把账号上的值清成 null。本腿自己跑炸过一次就可能把 dev
    //      账号留在英文态；不清就直接断「起点是中文」会假红，这条腿也就不可重跑。
    await loginInto(apage, cfg.userBase, cfg.scriptLogin, cfg.scriptPassword);
    const meBefore = await apiCall(apage, cfg.userBase, 'GET', '/api/me');
    acct.meBeforeStatus = meBefore.status;
    acct.localeBefore = meBefore.body && meBefore.body.user ? meBefore.body.user.locale : null;
    if (acct.localeBefore !== null) {
      await apiCall(apage, cfg.userBase, 'PATCH', '/api/me/locale', { locale: null });
    }
    // ⓬b 起点钉死：账号值 null + 两个载体空 ⇒ 界面必须跟着浏览器语言（容器钉 zh-CN）。
    //      这同时是契约判据 5（没设过的用户行为与今天逐字相同）的证据，并保证下面的英文是新造成的。
    acct.preClear = await clearSiteData(apage, acctCtx);
    await loginInto(apage, cfg.userBase, cfg.scriptLogin, cfg.scriptPassword);
    await gotoWorkbench(apage, cfg.userBase);
    acct.langBaseline = await apage.evaluate(() => document.documentElement.lang);
    acct.textsBaseline = await localeTexts(apage);

    // ⓬c 点顶栏切 English：界面变英文，**且真的发了一枪 PATCH /api/me/locale**
    acct.patchCalls = [];
    await openLocaleMenu(apage, LOCALE_BTN_ADMIN);
    await clickMenuItem(apage, 'English');
    await apage.waitForFunction(() => document.documentElement.lang === 'en', null, { timeout: 10000 });
    await apage.waitForTimeout(300);
    acct.langAfterClickEn = await apage.evaluate(() => document.documentElement.lang);
    acct.textsAfterClickEn = await localeTexts(apage);
    acct.carriersAfterClickEn = await readCarriers(apage);

    // ⓬d 清掉这个 origin 的 cookie 与 localStorage（新设备 / 清了站点数据）；残留交给断言判。
    acct.cleared = await clearSiteData(apage, acctCtx);

    // ⓬e 重新登录（同一账号），**一步都不点**：界面第一帧就是英文，且两个载体被库里那个值重新灌满。
    await loginInto(apage, cfg.userBase, cfg.scriptLogin, cfg.scriptPassword);
    await gotoWorkbench(apage, cfg.userBase);
    acct.langAfterReLogin = await apage.evaluate(() => document.documentElement.lang);
    acct.textsAfterReLogin = await localeTexts(apage);
    acct.carriersAfterReLogin = await readCarriers(apage);
    await apage.screenshot({ path: cfg.shotPath3 });
    try { acct.shotBytes3 = statSync(cfg.shotPath3).size; } catch { /* 容器内没落盘，宿主回收时再看 */ }
  } catch (err) {
    // 这条腿自己的失败单独记：不拕 main 那条腿的 fatal，但同样会被宿主当成产品红。
    // 只截第一行会把「在等哪个选择器」丢掉（本腿第一次判红时就查不出是哪一步）：
    // Playwright 的超时把 selector 写在第二行，这里多留两行，判红时要能看出死在哪一步。
    acct.fatal = String((err && err.message) || err).split('\n').slice(0, 4).join(' | ').slice(0, 500);
    // 判红时要能看出「页面到底停在哪儿、渲染了什么」：URL + 标题 + 正文前 200 字（best-effort）。
    try {
      acct.fatalUrl = apage.url();
      acct.fatalTitle = await apage.evaluate(() => document.title);
      acct.fatalBody = await apage.evaluate(() => (document.body && document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200));
    } catch { /* 页面已经没了就算了 */ }
  } finally {
    // ⓬f 收尾（必做）：把该账号的 locale 恢复成 null ⇒ 别把 dev 账号留在英文态。
    //      走 API；会话可能已被上面某一步的清站点数据清掉 ⇒ 先探 /api/me，非 200 就重新登一次再 PATCH。
    try {
      if (apage) {
        // 先落到用户面 origin（才有同源 fetch；已登录时路由会自己把 /login 弹走，不影响）。
        await apage.goto(cfg.userBase + '/#/login', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        const probeMe = await apiCall(apage, cfg.userBase, 'GET', '/api/me');
        acct.restoreProbeStatus = probeMe.status;
        if (probeMe.status !== 200) {
          await loginInto(apage, cfg.userBase, cfg.scriptLogin, cfg.scriptPassword);
          acct.restoreReloggedIn = true;
        }
        const patched = await apiCall(apage, cfg.userBase, 'PATCH', '/api/me/locale', { locale: null });
        acct.restorePatchStatus = patched.status;
        const meAfter = await apiCall(apage, cfg.userBase, 'GET', '/api/me');
        acct.restoreGetStatus = meAfter.status;
        acct.localeAfterRestore = meAfter.body && meAfter.body.user ? meAfter.body.user.locale : null;
      } else {
        acct.restoreSkipped = '账号腿连页面都没建起来，没写过任何值 ⇒ 无需恢复';
      }
    } catch (err2) {
      acct.restoreFatal = String((err2 && err2.message) || err2).split('\n')[0].slice(0, 300);
    }
    try { if (acctCtx) await acctCtx.close(); } catch { /* ignore */ }
  }
} catch (err) {
  r.fatal = String((err && err.message) || err).split('\n')[0].slice(0, 300);
} finally {
  try { if (browser) await browser.close(); } catch { /* ignore */ }
}
process.stdout.write('\nREPORT:' + JSON.stringify(r) + '\n');
`;

test('管理台语言切换：真浏览器里切英文当场生效、刷新仍在、并跨 host 共享到用户面；账号级偏好：清了站点数据重新登录不用重选', async (t) => {
  if (!UI_ENABLED) {
    t.skip('浏览器腿要点名才跑（E2E_UI=1）——未点名，按设计 skip');
    return;
  }
  t.diagnostic(`管理台入口：${BASE}；用户面入口：${USER_BASE}；容器：${PW_CONTAINER}；域名映射：${HOST_RESOLVER_RULES || '(不映射，直连 URL host)'}`);
  const reason = probeUi();
  if (reason) {
    probe.reasons.ui = reason;
    // 点名即硬要求：环境不齐也算红（缺的是哪一样由 reason 点名）；不想被判红就显式带 E2E_UI_SOFT=1。
    // 这是**环境探测阶段**（probeUi：口令/docker/容器/模块）——`E2E_UI_SOFT` 只对这一阶段开（见 shouldSoftSkip）。
    if (shouldSoftSkip({ soft: UI_SOFT, phase: 'probe', message: reason })) {
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
    shotPath2: SHOT2_CONTAINER,
    shotPath3: SHOT3_CONTAINER,
    // 账号级语言偏好腿用的脚本账号与它的口令（只经临时 cfg 文件进容器，仓库里不出现口令）。
    scriptLogin: SCRIPT_LOGIN,
    scriptPassword: CRED_SCRIPT_PASSWORD,
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
    t.diagnostic(`致命：${rep.fatal ?? '(无)'}\n管理台读数：${JSON.stringify(admin)}\n用户面读数：${JSON.stringify(rep.user)}\nruntime 读数：${JSON.stringify(rep.runtime)}\n账号级偏好读数：${JSON.stringify(rep.account)}\npageErrors：${JSON.stringify(rep.pageErrors)}`);

    // 致命错误分两类（区分环境与产品）：
    //   环境到不了入口（net:: / 连不上 / 超时 / 握手）⇒ 环境问题，skip。
    //   到了页面却没跑通（脚本里抛的：找不到控件、点了没反应、超时）⇒ 产品红，assert.fail。
    if (rep.fatal) {
      if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(rep.fatal)) {
        // #878：这是**运行阶段**（真浏览器已开、已在导航/点击/断言）炸出的 `net::`，多半是用例中段页面
        // 自身的问题 ⇒ 一律判红，不再被 `E2E_UI_SOFT=1` 降级成 skip（否则真回归会被静默吃掉）。
        if (shouldSoftSkip({ soft: UI_SOFT, phase: 'run', message: rep.fatal })) {
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
    // ⑦b 「用户亲自点过开关」这个事实也必须跨 host 可见（#902 ①）：它要是只留在管理台的
    //     localStorage，用户面就看不到 ⇒ 账号默认值会把共享的 `locale` cookie 盖掉。
    assert.equal(
      rep.user.carriers && rep.user.carriers.cookieChosen,
      '1',
      `在管理台点过 English 后，用户面那个 origin 应当看得见 locale_chosen=1（标记与偏好同为跨子域 cookie），实际 ${JSON.stringify(rep.user.carriers && rep.user.carriers.cookieChosen)}、cookie=${JSON.stringify(rep.user.carriers && rep.user.carriers.cookieText)}`,
    );
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

    // ⓬ 账号级语言偏好（#828 P3：本单判据本体）：脚本账号在用户面切一次英文 ⇒ 清掉站点数据
    //    ⇒ 重新登录**一步都不点**就是英文。这段与管理台那条腿完全分开：不同的 context、不同的
    //    账号、不同的入口（用户面），互不污染载体。
    const acct = rep.account || {};
    if (acct.fatal) {
      if (/net::|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo|handshake/i.test(acct.fatal)) {
        // #878：同主腿——这也是**运行阶段**的 `net::`，一律判红，不再被 `E2E_UI_SOFT=1` 降级（见 shouldSoftSkip）。
        if (shouldSoftSkip({ soft: UI_SOFT, phase: 'run', message: acct.fatal })) {
          t.skip(`账号级偏好腿到不了用户面入口（net:: 类，已显式 E2E_UI_SOFT=1 降级）：${acct.fatal}`);
          return;
        }
        assert.fail(`E2E_UI=1 点名要跑，账号级偏好腿却到不了用户面入口（缺：${acct.fatal}）——不能以 skip 冒充通过；不想被判红就显式带 E2E_UI_SOFT=1`);
        return;
      }
      assert.fail(`账号级偏好腿到了用户面却没跑通（产品红）：${acct.fatal}（用户面 ${USER_BASE}，账号 ${SCRIPT_LOGIN}；停在 ${acct.fatalUrl ?? '未知 URL'}，标题 ${JSON.stringify(acct.fatalTitle ?? '?')}，正文 ${JSON.stringify(acct.fatalBody ?? '?')}）`);
      return;
    }
    // ⓬a 预清那一步得先真登进去（没登进去 ⇒ 后面每一条都是空读数，先钉这一条）
    assert.equal(acct.meBeforeStatus, 200, `脚本账号（${SCRIPT_LOGIN}）登用户面后 GET /api/me 该是 200，实际 ${JSON.stringify(acct.meBeforeStatus)}——登不进去（口令错 / 开了二步验证 / 账号禁用）后面全部读数都不可信`);
    // 「清干净了」的口径（预清与 ⓬d 两次清都过这个函数）：cookie 里没 locale、localStorage 里也没 locale。
    // 残留不算绿而算红：载体还在的话，「重登后直接是英文」完全可以是被残留的那份 cookie 骗出来的。
    const assertCleared = (label, c) => {
      assert.ok(c, `${label}：没拿到载体读数（清站点数据那步没跑成？）`);
      assert.equal(c.cookieLocale, null, `${label}：cookie 里不该再有 locale，实际 locale=${JSON.stringify(c.cookieLocale)}、cookie 全文=${JSON.stringify(c.cookieText)}`);
      assert.equal(c.storageLocale, null, `${label}：localStorage 里不该再有 locale，实际 locale=${JSON.stringify(c.storageLocale)}、keys=${JSON.stringify(c.storageKeys)}`);
    };
    assertCleared('⓬a 预清站点数据后', acct.preClear);
    // ⓬b 起点：账号没设过值 ⇒ 界面跟着浏览器语言（容器钉 zh-CN）。这同时是契约判据 5 的证据。
    assert.equal(acct.langBaseline, 'zh-CN', `账号值为 null 且载体已清 ⇒ 中文浏览器上用户面该是 zh-CN（判据 5：没设过的用户行为与今天逐字相同），实际 ${JSON.stringify(acct.langBaseline)}`);
    assert.equal(acct.textsBaseline && acct.textsBaseline.logoutText, '登出', `起点顶栏登出按钮文案该是中文「登出」，实际 ${JSON.stringify(acct.textsBaseline && acct.textsBaseline.logoutText)}——不是中文的话，下面「变英文」就没意义了`);
    assert.equal(acct.textsBaseline && acct.textsBaseline.headerHasZhChrome, true, '起点顶栏整块该还带中文菜单文案（反向钉起点真是中文）');
    // ⓬c 点顶栏 English：当场变英文 + **真的发了一枪 PATCH**（只看界面变了不算证据）
    assert.equal(acct.langAfterClickEn, 'en', `用户面点 English 后 <html lang> 当场该变 en，实际 ${JSON.stringify(acct.langAfterClickEn)}`);
    assert.equal(acct.textsAfterClickEn && acct.textsAfterClickEn.logoutText, 'Sign out', `点完顶栏登出按钮该变 Sign out，实际 ${JSON.stringify(acct.textsAfterClickEn && acct.textsAfterClickEn.logoutText)}`);
    const enPatch = (acct.patchCalls || []).find((c) => c.method === 'PATCH'
      && String(c.url).includes('/api/me/locale')
      && /"en"/.test(String(c.body)));
    assert.ok(enPatch, `已登录时切英文该顺手回写账号值（PATCH ${USER_BASE}/api/me/locale，体里带 "en"），实际监听到 ${JSON.stringify(acct.patchCalls)}——没这一枪就说明「下次登录不用重选」那个值根本没上传`);
    assert.ok(String(enPatch.url).startsWith(USER_BASE), `那一枪该发给用户面那个 origin，实际 ${JSON.stringify(enPatch.url)}`);
    // 前端双写：切完当场 cookie 与 localStorage 也得上 en（服务端谈判靠 cookie，不许有窗口差）
    assert.equal(acct.carriersAfterClickEn && acct.carriersAfterClickEn.cookieLocale, 'en', `切完英文后同站 cookie 的 locale 该是 en，实际 ${JSON.stringify(acct.carriersAfterClickEn)}`);
    assert.equal(acct.carriersAfterClickEn && acct.carriersAfterClickEn.storageLocale, 'en', `切完英文后 localStorage 的 locale 该是 en，实际 ${JSON.stringify(acct.carriersAfterClickEn)}`);
    // ⓬d 清站点数据：真的清干净了（这一步不算绿而算判据：它没做成，后面那条就是假的）
    assertCleared('⓬d 清站点数据后', acct.cleared);
    // ⓬e 重登后**一步都不点**：界面直接就是英文（断 DOM 文案，不断 class）
    assert.equal(acct.langAfterReLogin, 'en', `清掉站点数据后重新登录，<html lang> 该直接是 en（本单判据本体：不用重选），实际 ${JSON.stringify(acct.langAfterReLogin)}`);
    assert.equal(acct.textsAfterReLogin && acct.textsAfterReLogin.logoutText, 'Sign out', `重登后顶栏登出文案该直接是 Sign out（一步都没点），实际 ${JSON.stringify(acct.textsAfterReLogin && acct.textsAfterReLogin.logoutText)}`);
    assert.match(String((acct.textsAfterReLogin || {}).localeBtnText || ''), /English/, `重登后顶栏语言按钮自身文案该是 English，实际 ${JSON.stringify((acct.textsAfterReLogin || {}).localeBtnText)}`);
    assert.equal((acct.textsAfterReLogin || {}).localeBtnAria, 'Language', `重登后语言按钮的 aria-label 该是 locale.label 的英文取值 Language，实际 ${JSON.stringify((acct.textsAfterReLogin || {}).localeBtnAria)}`);
    assert.equal((acct.textsAfterReLogin || {}).headerHasZhChrome, false, `重登后顶栏整块不该再有中文菜单文案（起点那边刚钉过它确实是中文），实际 CJK 行 ${JSON.stringify((acct.textsAfterReLogin || {}).cjkLines)}`);
    // 机制证据：服务端那个值确实被灌回了两个载体（不只是「渲染碰巧是英文」）
    assert.equal(acct.carriersAfterReLogin && acct.carriersAfterReLogin.cookieLocale, 'en', `重登后 cookie 的 locale 该被登录响应里的账号值重新写成 en，实际 ${JSON.stringify(acct.carriersAfterReLogin)}`);
    assert.equal(acct.carriersAfterReLogin && acct.carriersAfterReLogin.storageLocale, 'en', `重登后 localStorage 的 locale 该被账号值重新写成 en，实际 ${JSON.stringify(acct.carriersAfterReLogin)}`);
    // ⓬f 收尾：该账号的 locale 已恢复 null（别把 dev 账号留在英文态），并且真的读回来了
    assert.ok(!acct.restoreFatal, `收尾恢复 locale 时抛错了：${JSON.stringify(acct.restoreFatal)}`);
    assert.equal(acct.restorePatchStatus, 200, `收尾 PATCH /api/me/locale 带 null 该 200，实际 ${JSON.stringify(acct.restorePatchStatus)}`);
    assert.equal(acct.restoreGetStatus, 200, `收尾回读 GET /api/me 该 200，实际 ${JSON.stringify(acct.restoreGetStatus)}`);
    assert.equal(acct.localeAfterRestore, null, `收尾后该账号的 user.locale 该是 null（没设过），实际 ${JSON.stringify(acct.localeAfterRestore)}——不是 null 就是下一个跑的人打开就是英文`);
    assert.deepEqual(acct.pageErrors, [], `账号级偏好腿不该抛页面级 JS 异常，实际 ${JSON.stringify(acct.pageErrors)}`);

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

    // 第二张：运行时设置页英文态（#803 的面）。拿不到宿主只记一句话，不判红——
    // 硬判据是上面那四条 DOM 读数（格数 + CJK 命中 0），图是给人看的附件。
    const bytes2 = (() => {
      try {
        tryQuiet(() => fs.rmSync(SHOT2_HOST));
        dockerRun(`cp ${PW_CONTAINER}:${SHOT2_CONTAINER} ${SHOT2_HOST}`, { timeout: 30_000 });
        return fs.statSync(SHOT2_HOST).size;
      } catch { return null; }
    })();
    t.diagnostic(bytes2
      ? `英文态运行时设置页截图：${SHOT2_HOST}（${bytes2} 字节，容器内读数 ${rep.shotBytes2}）`
      : `# 运行时设置页截图没拿回宿主（${SHOT2_HOST}；不影响判据，硬判据是行名/小字的 CJK 读数）`);

    // 第三张：账号级偏好腿「重登后直接英文」的那一屏（#828 P3）。与第二张同口径：拿回宿主只当给人
    // 看的附件，不判红（硬判据是上面那五条 DOM 读数与两个载体读数）。
    const bytes3 = (() => {
      try {
        tryQuiet(() => fs.rmSync(SHOT3_HOST));
        dockerRun(`cp ${PW_CONTAINER}:${SHOT3_CONTAINER} ${SHOT3_HOST}`, { timeout: 30_000 });
        return fs.statSync(SHOT3_HOST).size;
      } catch { return null; }
    })();
    t.diagnostic(bytes3
      ? `账号级偏好腿：清站点数据后重登、一步都没点的英文态截图：${SHOT3_HOST}（${bytes3} 字节，容器内读数 ${(rep.account || {}).shotBytes3}）`
      : `# 账号级偏好腿的截图没拿回宿主（${SHOT3_HOST}；不影响判据）`);
  } finally {
    // ⑫ 收尾：容器里那份带口令的 cfg + 脚本都尽力删；宿主临时文件也删（截图留在宿主，是给人看的）。
    tryQuiet(() => dockerRun(`exec ${PW_CONTAINER} sh -c "rm -f ${scriptIn} ${cfgIn}"`));
    tryQuiet(() => fs.rmSync(scriptHost));
    tryQuiet(() => fs.rmSync(cfgHost));
    // #828：把浏览器腿经 UI 写进 DB 的两个账号语言值恢复成 null 并回读确认（旧脚本只恢复了脚本
    // 账号、把 dev 上的 admin 留成了英文）——放 finally ⇒ 断言红也不能把脏值留在库。
    resetAccountLocalesAndConfirm();
  }
});

test('哨兵：点名了（E2E_UI=1）却没有口令 ⇒ 判红，禁止静默全 skip 拿 rc=0', () => {
  if (!UI_ENABLED) return;
  // 点名要跑却连口令都找不到 ⇒ 几乎一定是忘了注入凭据目录，必须判红而不是 skip。
  // 与主用例里「环境不齐（口令 / docker / 容器 / 模块 / net::）⇒ assert.fail」是同一条口径的两半：
  // 主用例那半要探测才拿得到原因（探测本身要碰 docker，不点名就别碰），口令这条在模块加载就能判，故各自守一段。
  assert.ok(CRED_PASSWORD !== null,
    `E2E_UI=1 点名了浏览器腿，但没找到口令文件（试过 ${PASSWORD_FILE}）——口令缺失不能静默 skip 冒充通过`);
  // 账号级偏好腿要往脚本账号上写值再清回去：它的口令缺失与上面同口径（缺了就跑不了，不是 skip）。
  assert.ok(CRED_SCRIPT_PASSWORD !== null,
    `E2E_UI=1 点名了浏览器腿，但没找到脚本账号（${SCRIPT_LOGIN}）的口令文件（试过 ${SCRIPT_PASSWORD_FILE}）——缺它这条腿一步都跑不了，不能静默 skip 冒充通过`);
});

// ---------------------------------------------------------------------------
// #878 纯判据用例：不启动浏览器、不碰真库/口令也能跑（`shouldSoftSkip` 是导出纯函数，
// `resetAccountLocalesAndConfirm` 的 `psql` 与 `soft` 均可注入 ⇒ 无 `E2E_UI` 环境下也能被调用并断言）。
// ---------------------------------------------------------------------------

test('shouldSoftSkip：soft + probe + net:: ⇒ 允许降级（环境探测阶段）#878', () => {
  assert.equal(shouldSoftSkip({ soft: true, phase: 'probe', message: 'net::ERR_CONNECTION_REFUSED' }), true);
});

test('shouldSoftSkip：soft + run + 同样的 net:: ⇒ 不许降级（运行阶段判红）#878', () => {
  assert.equal(shouldSoftSkip({ soft: true, phase: 'run', message: 'net::ERR_CONNECTION_REFUSED' }), false);
});

test('shouldSoftSkip：soft=false + probe ⇒ 不许降级（点名要跑就判红，与哨兵同口径）#878', () => {
  assert.equal(shouldSoftSkip({ soft: false, phase: 'probe', message: 'docker 不可用' }), false);
});

test('shouldSoftSkip：soft + run + 非 net::（断言失败）⇒ 不许降级 #878', () => {
  assert.equal(shouldSoftSkip({ soft: true, phase: 'run', message: 'AssertionError: 找不到控件' }), false);
});

test('收尾恢复：回读跑不动（psql 抛异常）⇒ 判红，不许静默返回 #878', () => {
  const boom = () => { throw new Error('docker exec psql: could not connect to server'); };
  const re = new RegExp(`收尾回读跑不动.*${ADMIN_LOGIN}.*${SCRIPT_LOGIN}.*没确认成功不能算恢复`);
  assert.throws(() => resetAccountLocalesAndConfirm({ runPsql: boom, soft: false }), (err) => re.test(err.message));
});

test('收尾恢复：soft=true 也判红（运行阶段之后的收尾不受 E2E_UI_SOFT 豁免）#902 ③', () => {
  // #902 ③：这一格今天没人测——旧代码 `if (soft)` 命中就「记一句日志返回」（等于没确认也算过）。
  // 新实现把收尾回读走 `shouldSoftSkip({ soft, phase: 'run' })` ⇒ 恒 `false` ⇒ 即便显式传 `soft: true`，
  // 回读跑不动仍判红（收尾发生在运行阶段之后，按 #884「运行阶段不降级」就该红）。把实现改回
  // `if (soft)` 记日志返回 ⇒ 本例的 assert.throws 拿不到异常 ⇒ 变红（这就是 #902 ③ 的变异钩）。
  const boom = () => { throw new Error('docker exec psql: could not connect to server'); };
  const re = new RegExp(`收尾回读跑不动.*${ADMIN_LOGIN}.*${SCRIPT_LOGIN}.*没确认成功不能算恢复`);
  assert.throws(() => resetAccountLocalesAndConfirm({ runPsql: boom, soft: true }), (err) => re.test(err.message));
});

test('收尾恢复：回读里某账号 locale=en（UPDATE 没生效）⇒ 判红 #878', () => {
  const rows = `${ADMIN_LOGIN}=en\n${SCRIPT_LOGIN}=NULL`;
  const fake = (q) => (String(q).startsWith('UPDATE') ? '' : rows);
  assert.throws(
    () => resetAccountLocalesAndConfirm({ runPsql: fake, soft: false }),
    (err) => err.message.includes(ADMIN_LOGIN) && /locale 应已恢复为 NULL/.test(err.message),
  );
});

test('收尾恢复：回读两账号都 NULL ⇒ 不判红（对照组）#878', () => {
  const fake = (q) => (String(q).startsWith('UPDATE') ? '' : `${ADMIN_LOGIN}=NULL\n${SCRIPT_LOGIN}=NULL`);
  assert.doesNotThrow(() => resetAccountLocalesAndConfirm({ runPsql: fake, soft: false }));
});

test('收尾恢复：回读里账号缺行 ⇒ 不算脏（库里本就没这个账号，行为保留）#878', () => {
  const fake = (q) => (String(q).startsWith('UPDATE') ? '' : '');
  assert.doesNotThrow(() => resetAccountLocalesAndConfirm({ runPsql: fake, soft: false }));
});
