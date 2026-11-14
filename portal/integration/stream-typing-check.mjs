#!/usr/bin/env node
// 打字机不退化的**手工** e2e 用例（issue #502 判据 2 的复跑工具；台账 §8.126.1 用它取证的「72 → 759 → 1186」）
//
// 用途（一句话）：**真浏览器 + 真 SSE**，验「打字机没退化」——stream 档碎片帧仍在流、流式气泡的正文
// **逐次增长**。#502 之后碎片**不落库、不占 `seq`**（`docs/api/portal.md` §5.1），单测能钉住「portal
// 把碎片转发了」，但钉不住「浏览器里那个气泡真的在一格一格长」——而那正是形态 M 最可能悄悄坏掉的一格
// （累加器 / `roundSeq` 对账 / 前端覆盖判定任一环节出错，表现都是「等很久然后整段蹦出来」，
// 而库里一切正常、单测全绿）。
//
// 怎么跑（**在 playwright 容器里跑**，不在宿主直接跑；容器是 host 网络，能直接打到 127.0.0.1:18080）：
//   docker cp portal/integration/stream-typing-check.mjs \
//     erix_station_playwright:/home/node/.playwright-mcp/stream-typing-check.mjs
//   docker exec -e SESSION_ID=<会话 id> -e COOKIE=<会话 token> erix_station_playwright \
//     node /home/node/.playwright-mcp/stream-typing-check.mjs
//   （**只这两个变量就能跑**：`BASE_URL` 缺省即 compose 的 `127.0.0.1:18080`，`COOKIE_NAME` 缺省
//   跟着入口协议联动；要换入口/换 cookie 名再显式加 `-e BASE_URL=… -e COOKIE_NAME=…`。）
// 需要的环境变量：
//   SESSION_ID   必填。要一个**可写**的会话 ⇒ 本用例会真的发一条消息、真的起一个 run、真的花 token。
//   COOKIE       必填。会话 token 值（登录后那条 `Set-Cookie` 里的值）。cookie **名**由宿主的
//                `COOKIE_PROFILE` 决定（`portal/src/config.js` `cookieSettings`）：
//                `prod` → `__Host-fde_session`（Secure）、`dev-http` → `fde_session_dev`（非 Secure）。
//                名字**跟入口协议是一对**（见下面 `COOKIE_NAME`：缺省已联动，不必猜）。
//                名字不对 = 静默落回登录页 ⇒ `verdict=FAIL reason=not_authenticated`。
//   BASE_URL     选填，缺省 `http://127.0.0.1:18080`（compose 的 `PORTAL_HOST_PORT`）。
//                走边缘入口时形如 `https://station.fde.erix.vip:8443`（自签证书时本脚本会因 TLS 失败）。
//   COOKIE_NAME  选填，**缺省值按 `BASE_URL` 的协议联动**（不是写死的一个串）：
//                `https:` ⇒ `__Host-fde_session`（Secure）；`http:` ⇒ `fde_session_dev`（非 Secure）。
//                为什么要联动：`__Host-` 前缀被浏览器**强制要求 Secure**，在 http 入口下 Chromium 会
//                直接**拒收**这条 cookie ⇒ 表现成「落回登录页」，看着像会话问题其实是名字选错了。
//                ⇒ **按默认值跑 http 缺省入口就是可用的**（以前缺省写死 `__Host-fde_session`，
//                不传 `COOKIE_NAME` 必挂，只能靠调用方每次显式传参绕过）。
//                显式传 `COOKIE_NAME` 时**尊重传的值**，但「`__Host-` 名字 + 非 https 入口」这个组合
//                当场 `verdict=FAIL reason=cookie_name_needs_https` 退出（一句话修法），不进浏览器。
//   MESSAGE      选填。默认是一句「多吐正文、且这一轮别调工具」的话——工具轮会把流式打断成工具卡片，
//                量不到连续增长的正文。
//   SHOTS        选填，缺省 3（连拍张数，判据要求 ≥2）；`SHOT_GAP_MS` 缺省 2000。
//   FIRST_TEXT_TIMEOUT_MS 选填，缺省 **60000**（毫秒）。点发送到「量到第一段流式正文」的预算：
//                到点还没有任何正文 ⇒ `verdict=FAIL reason=no_streaming_text_within_budget`
//                （那是「打字机死了」的判据，不是「慢」——所以它必须给得比模型首 token 的正常延迟宽）。
//   OUT_DIR      选填，缺省 `/home/node/.playwright-mcp` —— 就是 playwright 容器的 output-dir
//                （宿主侧对应 `/docker/erix_station_playwright`，截图落那儿可以直接看/可以进 vision）。
//   PLAYWRIGHT_CORE_PATH 选填。`playwright-core` 的解析路径：mcp 镜像里它在 `/app/node_modules/playwright-core`
//                （本次实测**裸导入就能拿到**；仍保留「显式路径 → 裸导入 → `/app/node_modules/...`」的回退）。
//                浏览器二进制同理：镜像里**只有** `/ms-playwright/chromium-1237`、**没有** headless shell，
//                所以启动走 `channel: 'chromium'`（见 `launchBrowser`，新 playwright 的 `headless: true`
//                缺省去要 `chrome-headless-shell`，不指名就会 `Executable doesn't exist`）。
//
// 判据（**机器可读**，最后一行是结论；红了就 `process.exit(1)`）：
//   `TYPING_CHECK shot=<n> bubble_count=<..> len=<..> shot_file=<..>`   每张截图一条
//   `TYPING_CHECK lengths=<a>,<b>,<c>`                                  三次量到的流式气泡正文字符数
//   `TYPING_CHECK verdict=PASS reason=strictly_increasing`              **三次长度严格递增**才算过
//   `TYPING_CHECK verdict=FAIL reason=<码>[ detail=<..>]`                其余一切（含环境不满足）
//   环境类失败码（都在**不起浏览器**时就退，并带一行 `TYPING_CHECK fix=…` 修法）：
//                `missing_SESSION_ID` / `missing_COOKIE` / `bad_SHOTS` / `bad_BASE_URL` /
//                `cookie_name_needs_https`（`__Host-` 名字 @ 非 https 入口）
//   递增 ⇒ 碎片仍在流；不递增 ⇒ 要么根本没在流（长度不动），要么气泡被整段覆盖/清空（长度倒退）。
//
// 为什么不进 CI（也不进 `npm test`）：`docs/ops/ci-release.md` 已定「e2e 不进 CI」——它要真起栈、真浏览器、
// 真模型：花 token、时长不可控、失败原因九成在环境不在代码，而且它会**写库**（发消息 = 真 run）。
// 本文件的定位是**发版前 / 大改后手工跑一次**的验收用例（#502 判据 2 就是靠它落地的）。
// ⇒ 别把它加进 `package.json` 的 `test`，也别加进 `.github/workflows/ci.yml`。
// （文件名不带 `.test.` / `-test`，所以 `node --test` 的默认通配天然不会捡到它；CI 步骤 ① 的
//   `node --check` 会扫到它——这是好事，脚本语法坏了门禁就红。）

const SESSION_ID = process.env.SESSION_ID;
const COOKIE = process.env.COOKIE;
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
// `BASE_URL` 的协议决定 cookie 名的缺省值（两者是同一件事的两半，见头注释 `COOKIE_NAME` 那段）。
// URL 形态坏掉要在这里就报成机器可读的结论，而不是把裸堆栈留给调用方去猜。
let baseIsHttps;
try {
  baseIsHttps = new URL(BASE_URL).protocol === 'https:';
} catch {
  console.log(`TYPING_CHECK verdict=FAIL reason=bad_BASE_URL detail=${BASE_URL}`);
  console.log('TYPING_CHECK fix=给一个带协议的绝对 URL，例如 http://127.0.0.1:18080 或 https://station.fde.erix.vip:8443');
  process.exit(1);
}
// 口径与 `portal/src/config.js#cookieSettings` 同源：`prod` → `__Host-fde_session`（Secure）、
// `dev-http` → `fde_session_dev`（非 Secure）。显式传了就照办（下面的 fail-fast 只管浏览器真的会拒的那种组合）。
const COOKIE_NAME = process.env.COOKIE_NAME || (baseIsHttps ? '__Host-fde_session' : 'fde_session_dev');
const MESSAGE = process.env.MESSAGE
  || '请用大约 600 字讲讲这台工位平台的整体架构，纯文字回答，这一轮不要调用任何工具。';
const SHOTS = Number(process.env.SHOTS || 3);
const SHOT_GAP_MS = Number(process.env.SHOT_GAP_MS || 2000);
const OUT_DIR = process.env.OUT_DIR || '/home/node/.playwright-mcp';
const FIRST_TEXT_TIMEOUT_MS = Number(process.env.FIRST_TEXT_TIMEOUT_MS || 60_000);

let verdictPrinted = false;
let exitCode = 0;

/** 失败出口：打印机器可读的结论后抛出去（throw 而不是 process.exit，是为了让 finally 关掉浏览器）。 */
function fail(reason, extra = '') {
  verdictPrinted = true;
  const err = new Error(`fail:${reason}`);
  err.isVerdict = true;
  console.log(`TYPING_CHECK verdict=FAIL reason=${reason}${extra ? ` detail=${extra}` : ''}`);
  throw err;
}

// 环境变量不满足：还没有浏览器要收，直接退。
if (!SESSION_ID || !COOKIE || !(SHOTS >= 2)) {
  if (!SESSION_ID) console.log('TYPING_CHECK verdict=FAIL reason=missing_SESSION_ID');
  if (!COOKIE) console.log('TYPING_CHECK verdict=FAIL reason=missing_COOKIE');
  if (!(SHOTS >= 2)) console.log(`TYPING_CHECK verdict=FAIL reason=bad_SHOTS detail=${process.env.SHOTS}`);
  if (!SESSION_ID || !COOKIE) console.log('TYPING_CHECK fix=两个都要给：SESSION_ID=一个可写的会话 id，COOKIE=登录后 Set-Cookie 里的 token 值');
  process.exit(1);
}
// fail-fast：`__Host-` 前缀是**浏览器侧的硬约束**（必须 Secure），不是本脚本的偏好。名字带 `__Host-`
// 而入口不是 https 时，Chromium 会**静默拒收**这条 cookie，症状是「落回登录页」——一个真环境问题
// （名字选错）会被写成一条含糊的 `not_authenticated`。所以显式传了这个名字 + 非 https 入口就当场退。
// （缺省值已经按协议联动，走到这里的一定是**显式传参**。）
if (!baseIsHttps && COOKIE_NAME.startsWith('__Host-')) {
  console.log(`TYPING_CHECK verdict=FAIL reason=cookie_name_needs_https detail=${COOKIE_NAME} @ ${BASE_URL}`);
  console.log('TYPING_CHECK fix=非 https 入口用 dev-http 的名字：-e COOKIE_NAME=fde_session_dev（或直接不传，缺省已跟着协议走）；要用 `__Host-` 名字就把 BASE_URL 换成 https 入口');
  process.exit(1);
}

/** playwright-core 的解析：mcp 镜像里它不在脚本旁边，故多级回退。 */
async function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    'playwright-core',
    '/app/node_modules/playwright-core/index.mjs',
    '/app/node_modules/playwright-core/index.js',
  ].filter(Boolean);
  for (const spec of candidates) {
    const target = spec.startsWith('/') ? `file://${spec}` : spec;
    try {
      const mod = await import(target);
      if (mod?.chromium) return mod.chromium;
    } catch { /* 换下一个候选 */ }
  }
  fail('playwright_core_not_found', candidates.join(' | '));
}

const chromium = await loadChromium();
/**
 * 启浏览器。**先试 `channel: 'chromium'`**：mcp 镜像里只装了**完整 chromium**
 * （`/ms-playwright/chromium-1237`），**没有** `chromium_headless_shell`，而新版 playwright 的
 * `headless: true` 缺省去要 headless shell ⇒ 不指名 channel 就是 `Executable doesn't exist …
 * chrome-headless-shell`（本次跑时实测）。试失败再退回普通 launch（装有 headless shell 的机器）。
 * 容器里以 root 跑且没有 bpf 沙箱（mcp 自己也靠 `--no-sandbox` 起）。
 */
async function launchBrowser() {
  const args = ['--no-sandbox'];
  try {
    return await chromium.launch({ headless: true, channel: 'chromium', args });
  } catch (err) {
    console.log(`TYPING_CHECK note=channel_fallback ${err?.message?.split('\n')[0] || err}`);
    return await chromium.launch({ headless: true, args });
  }
}
// 起不来就没有任何东西要收（没有浏览器可关），直接把结论打完退掉。
let browser = null;
try {
  browser = await launchBrowser();
} catch (err) {
  console.log(`TYPING_CHECK note=launch_error ${err?.message?.split('\n')[0] || err}`);
  console.log('TYPING_CHECK verdict=FAIL reason=browser_launch_failed');
  process.exit(1);
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // 会话 cookie 是 host-only 的（`__Host-` 前缀强制 Secure + Path=/ + 无 Domain），所以只给 `url`：
  // Playwright 从 url 取 host/path（**给了 `url` 就不能同时给 `path`**，否则它直接拒：
  // 「Cookie should have either url or path」，实测）。`secure` 跟着协议走：http 入口
  // （dev-http profile）必须给 false。名字与协议**在缺省路径上已经联动**（见上面 `COOKIE_NAME`），
  // 显式传参传错组合的（`__Host-` + http）在上面就 fail-fast 退了；这里再兜一层 Chromium 自己的拒绝
  // （Playwright 不会替前缀规则报错，它照收，被拒是浏览器行为 ⇒ 下面 `not_authenticated` 那条会抓）。
  try {
    await context.addCookies([{
      name: COOKIE_NAME,
      value: COOKIE,
      url: BASE_URL,
      secure: baseIsHttps,
      httpOnly: true,
      sameSite: 'Lax',
    }]);
  } catch (err) {
    fail('cookie_rejected', `${err?.message?.split('\n')[0] || err}（COOKIE_NAME=${COOKIE_NAME} @ ${BASE_URL}：`
      + '`prod` → `__Host-fde_session` + https；`dev-http` → `fde_session_dev` + http）`');
  }
  const page = await context.newPage();

  // 流式气泡 = `.msg.assistant.md`（`StreamPanel.vue` 里 `en.kind === 'delta'` 那一支，与助手终稿同类名）。
  // 取**最后一个**：会话里可以有多条历史助手气泡，只有最后那条会在流。
  const measure = () => page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.msg.assistant.md')];
    const last = bubbles[bubbles.length - 1];
    return { count: bubbles.length, len: last ? (last.textContent || '').trim().length : 0 };
  });

  await page.goto(`${BASE_URL}/#/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  // 落到登录页 = cookie 没用（或会话不属于这个用户）。**必须显式判**：不判就会一路「找不到输入框」，
  // 把一个环境问题写成一条含糊的失败。⚠ 路由守卫是 SPA 挂载后才改 hash 的（实测：`goto` 完立刻看
  // 还看不到 `#/login`），所以先给一点沉降时间，再把「登录页」与「真的没有输入框」分开报。
  await page.waitForTimeout(1_500);
  const onLogin = () => new URL(page.url()).hash.startsWith('#/login');
  if (onLogin()) fail('not_authenticated', page.url());

  const ta = page.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => fail(onLogin() ? 'not_authenticated' : 'composer_not_found', page.url()));

  await ta.fill(MESSAGE);
  // 直发键按 `data-queued-kind="send"` 找，不按文案：运行中那支会分裂成 steer / follow_up，
  // 而文案还随语言切换（`composer.send` 有 zh/en 两套）。
  const send = page.locator('button[data-queued-kind="send"]').first();
  await send.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => fail('send_button_not_found'));
  await send.click();

  // 等第一段正文出现。超时 = 一条碎片都没到 ⇒ 那就是「打字机死了」，不是「慢」。
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('.msg.assistant.md')];
    const last = b[b.length - 1];
    return !!last && (last.textContent || '').trim().length > 0;
  }, undefined, { timeout: FIRST_TEXT_TIMEOUT_MS }).catch(() => fail('no_streaming_text_within_budget'));

  const lengths = [];
  for (let i = 0; i < SHOTS; i += 1) {
    if (i > 0) await new Promise((r) => setTimeout(r, SHOT_GAP_MS));
    const m = await measure();
    lengths.push(m.len);
    const file = `${OUT_DIR}/stream-typing-${Date.now()}-${i + 1}.png`;
    // 截图失败不算判据失败（目录不存在/权限），但它必须看得见——量到的长度才是真判据。
    await page.screenshot({ path: file }).catch((e) => console.log(`TYPING_CHECK note=screenshot_failed shot=${i + 1} err=${e?.message || e}`));
    console.log(`TYPING_CHECK shot=${i + 1} bubble_count=${m.count} len=${m.len} shot_file=${file}`);
  }
  console.log(`TYPING_CHECK lengths=${lengths.join(',')}`);
  console.log(`TYPING_CHECK session=${SESSION_ID} base=${BASE_URL} cookie_name=${COOKIE_NAME} gap_ms=${SHOT_GAP_MS} shots=${SHOTS}`);

  for (let i = 1; i < lengths.length; i += 1) {
    if (!(lengths[i] > lengths[i - 1])) {
      fail('not_strictly_increasing', `shot${i}=${lengths[i - 1]} -> shot${i + 1}=${lengths[i]}`);
    }
  }
  verdictPrinted = true;
  console.log('TYPING_CHECK verdict=PASS reason=strictly_increasing');
} catch (err) {
  if (!err?.isVerdict) {
    console.log(`TYPING_CHECK note=threw ${err?.stack || err}`);
    console.log('TYPING_CHECK verdict=FAIL reason=exception');
  }
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}

process.exit(exitCode);
