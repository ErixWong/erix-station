#!/usr/bin/env node
// 折叠呈现（常驻条 / 展开面板 / 右侧竖串）的真机 e2e —— erix-station issue #816 第③+⑥步的**手工**验收脚本。
//
// 用途（一句话）：**真浏览器 + 真栈**，验「折叠呈现那三件在真门户里真的出现、而且 hover 得出信息」——
// 常驻条 `fold-bar` 在、右侧竖串 `fold-node` 有节点且 active 恰好一个、hover 某节点能看见**它自己的**
// `fold-tip` 卡片且卡片真有内容、点节点能展开 `fold-panel` 且行数 = 节点数、面板里没漏出机械折的 title
// 模板句。单测能钉住「组件渲染了什么」，钉不住「真门户里那一列真的能被 hover 出来」——层叠样式、hover
// 目标、DOM 挂载顺序任一环节出错，表现都是「看着有、点不出东西」，而单测全绿。
//
// 怎么跑（**在 playwright 容器里跑**，不在宿主直接跑；容器是 host 网络，能直接打到宿主回环上 publish
// 出来的门户端口，不必额外做端口映射）：
//   docker cp portal/integration/fold-bar-rail-check.mjs <playwright 容器>:<容器内目录>/fold-check.mjs
//   docker exec -e SESSION_ID=<会话 id> -e COOKIE=<会话 token> <playwright 容器> \
//     node <容器内目录>/fold-check.mjs
//   （**只这两个变量就能跑**：门户地址、cookie 名、截图目录都有缺省，见下。）
//
// 需要的环境变量：
//   SESSION_ID   必填，而且必须是一个**真有折叠**的会话（该会话历史上真的折出过内容）。空会话里
//                `fold-bar` 压根不渲染 ⇒ 只会得到 `verdict=FAIL reason=exception`——那是取错了会话。
//   COOKIE       必填：会话 token 值（登录后那条 `Set-Cookie` 里的值）。名字/值不对 = 静默落回登录页
//                ⇒ 同样只剩一条 exception，看不出是 cookie 的事。
//   BASE_URL     选填，缺省见下面的代码行（compose 在宿主回环上 publish 的门户端口）。
//   COOKIE_NAME  选填，**缺省随 `BASE_URL` 的协议联动**：`https:` ⇒ `__Host-fde_session`（Secure）、
//                `http:` ⇒ `fde_session_dev`。为什么要联动：`__Host-` 前缀被浏览器**强制要求 Secure**，
//                在 http 入口下 Chromium 会直接**拒收**这条 cookie ⇒ 看着像会话问题，其实是名字选错了。
//   OUT_DIR      选填，缺省是容器内 playwright 的 output-dir（截图落那儿，宿主侧可以直接看 / 进 vision）。
//   PLAYWRIGHT_CORE_PATH 选填：镜像里只有 `playwright-core`，走「显式路径 → 裸导入 → 容器内固定路径」
//                三级兜底（同目录 `stream-typing-check.mjs` 的同一条路子）。
//
// 机器可读结论（`grep FOLDCHECK` 就能取走全部判据）：
//   FOLDCHECK bar="<常驻条文本>"
//   FOLDCHECK rail_nodes=<竖串节点数> active=<active 节点数>
//   FOLDCHECK tip="<被 hover 那个节点的卡片文本>"
//   FOLDCHECK panel_rows=<展开面板行数>
//   末行   FOLDCHECK verdict=PASS|BUG|FAIL reason=…
//   退出码：PASS=0 / BUG=3 / FAIL=1。**BUG 与 FAIL 是两回事**：FAIL = 脚本没跑成（参数缺、playwright
//   找不到、没到判据现场 ⇒ 先怀疑环境与用法）；BUG = 跑成了但产品表现不对（竖串空、active 不唯一、
//   卡片空、面板行数 ≠ 节点数、机械折 title 漏出 ⇒ 那是真缺陷，照 reason 开单）。
//
// ⚠ 卡片必须取「被 hover 那个节点自己的那张」（`nodes.nth(i).locator('[data-test="fold-tip"]')`）：
//   每个节点**各带一张**卡片，且全部**预渲染**、只靠 CSS `:hover` 显示。写成 `page.locator(...).first()`
//   拿到的是第 0 个节点那张，而你 hover 的是别的节点 ⇒ 它恒 `display:none` ⇒ `waitFor(visible)` 超时
//   ⇒ **误判成「hover 不显示」的产品缺陷**。这条是本脚本第一版真踩过的坑（当时报了个假 BUG），别重踩。
//
// 不进 CI、也不进 `npm test`（口径照 `docs/ops/ci-release.md` §6「e2e 为什么不进 CI」）：硬依赖真栈 +
// 真浏览器 + 真库数据（还得现成有一个**真有折叠**的会话），CI 里给不起；而且失败原因九成在环境（栈没起、
// 会话选错、cookie 过期）不在代码 ⇒ 放 CI 里只会把环境抖动报成代码红。正确用法：改完折叠呈现后手工跑
// 一次，把 `FOLDCHECK` 行与两张截图留在验收记录里。

import { mkdirSync } from 'node:fs';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:18080';
const SESSION_ID = process.env.SESSION_ID || '';
const COOKIE = process.env.COOKIE || '';
const COOKIE_NAME = process.env.COOKIE_NAME
  || (BASE_URL.startsWith('https:') ? '__Host-fde_session' : 'fde_session_dev');
const OUT_DIR = process.env.OUT_DIR || '/home/node/.playwright-mcp';

const out = (line) => console.log(line);
function fail(reason, detail = '') {
  out(`FOLDCHECK verdict=FAIL reason=${reason}${detail ? ` detail=${detail}` : ''}`);
  process.exit(1);
}
function bug(reason, detail = '') {
  out(`FOLDCHECK verdict=BUG reason=${reason}${detail ? ` detail=${detail}` : ''}`);
  process.exit(3);
}
if (!SESSION_ID || !COOKIE) fail('missing_SESSION_ID_or_COOKIE');

mkdirSync(OUT_DIR, { recursive: true });

// 容器里没有裸 `playwright` 包（只有 playwright-core）⇒ 照 stream-typing-check 的同一条三级兜底。
async function loadChromium() {
  for (const spec of [process.env.PLAYWRIGHT_CORE_PATH, 'playwright-core', '/app/node_modules/playwright-core/index.mjs']) {
    if (!spec) continue;
    try {
      const mod = await import(spec.startsWith('/') ? `file://${spec}` : spec);
      if (mod?.chromium) return mod.chromium;
    } catch { /* 下一个 */ }
  }
  fail('playwright_core_not_found');
}
const chromium = await loadChromium();
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox'] });
} catch {
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
}
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addCookies([{ name: COOKIE_NAME, value: COOKIE, url: BASE_URL }]);
const page = await context.newPage();

try {
  await page.goto(`${BASE_URL}/#/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-test="fold-bar"]', { timeout: 30_000 });
  const barText = (await page.locator('[data-test="fold-bar"]').innerText()).replace(/\s+/g, ' ').trim();
  out(`FOLDCHECK bar=${JSON.stringify(barText.slice(0, 120))}`);

  const nodes = page.locator('[data-test="fold-node"]');
  const nodeCount = await nodes.count();
  const activeCount = await page.locator('[data-test="fold-node-active"]').count();
  out(`FOLDCHECK rail_nodes=${nodeCount} active=${activeCount}`);
  if (nodeCount === 0) bug('rail_empty', 'fold-bar 在但竖串一个节点都没有');
  if (activeCount !== 1) bug('active_not_unique', `active=${activeCount}`);

  // hover 中间那个节点 ⇒ 卡片必须出现且带信息
  // 注意：每个节点各带一张卡片（全部预渲染、靠 CSS hover 显示）⇒ **必须取被 hover 那个节点自己的卡片**。
  // 用 `.first()` 会拿到未 hover 的第 0 个节点那张（恒 display:none）——主 agent 第一版就是这么误判成 bug 的。
  const hoverIndex = Math.min(2, nodeCount - 1);
  const target = nodes.nth(hoverIndex);
  await target.hover();
  const tip = target.locator('[data-test="fold-tip"]');
  await tip.waitFor({ state: 'visible', timeout: 8_000 });
  const tipText = (await tip.innerText()).replace(/\s+/g, ' ').trim();
  out(`FOLDCHECK tip=${JSON.stringify(tipText.slice(0, 160))}`);
  if (tipText.length < 4) bug('tip_empty');
  await page.screenshot({ path: `${OUT_DIR}/fold-rail-hover.png` });

  // 点节点 ⇒ 面板展开，行数 = 节点数
  await target.click();
  await page.waitForSelector('[data-test="fold-panel"]', { timeout: 8_000 });
  const rows = await page.locator('[data-test="fold-row"]').count();
  out(`FOLDCHECK panel_rows=${rows}`);
  if (rows !== nodeCount) bug('panel_rows_mismatch', `rows=${rows} nodes=${nodeCount}`);
  const panelText = (await page.locator('[data-test="fold-panel"]').innerText()).replace(/\s+/g, ' ').trim();
  // 机械折的 title 是把范围复述一遍的模板句 ⇒ 面板里不该出现
  if (panelText.includes('需要原文请重读文件')) bug('mechanical_title_leaked', '机械折 title 被当索引显示了');
  await page.screenshot({ path: `${OUT_DIR}/fold-panel-open.png` });

  // 无折叠的会话不该出现常驻条（负例：换成空会话 id 由调用方另行验证，这里只查当前会话一致性）
  out(`FOLDCHECK verdict=PASS nodes=${nodeCount} rows=${rows}`);
  await browser.close();
  process.exit(0);
} catch (error) {
  await page.screenshot({ path: `${OUT_DIR}/fold-rail-failure.png` }).catch(() => {});
  out(`FOLDCHECK error=${String(error?.message ?? error).slice(0, 300)}`);
  fail('exception');
}
