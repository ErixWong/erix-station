#!/usr/bin/env node
// 队列投递出去的那句话在**实时对话**里看得见吗——erix-station issue #799 的验收 e2e（手工复跑工具）。
//
// 用途（一句话）：**真浏览器 + 真栈 + 真模型**，验「队列投递出去的那句话在**实时对话**里看得见」——
// 在一场会长跑的 run 进行中发一条转向（steer）/排队消息，等它被**投递**、run 结束后：**刷新前**的实时
// 视图里那句话必须已经是一个用户气泡（`live_bubble`），**刷新后**也照常在场（`reload_bubble`）且
// **不重复**（`dup_after_reload` 与刷新前一致）。#799 的症状正是「写侧完好（刷新后看得见）但实时视图
// 看不见」⇒ `live_bubble=0 reload_bubble=1` ⇒ `verdict=BUG reason=live_missing_reload_ok`。
//
// 怎么跑（**在 playwright 容器里跑**，不在宿主直接跑；容器是 host 网络，能直接打**宿主回环 publish**
// 的门户端口）：
//   docker cp portal/integration/queue-delivered-check.mjs <playwright 容器>:<容器内 output-dir>/queue-delivered-check.mjs
//   docker exec -e SESSION_ID=<会话 id> -e COOKIE=<会话 token> <playwright 容器> \
//     node <容器内 output-dir>/queue-delivered-check.mjs
//   （**只这两个变量就能跑**：`BASE_URL` 缺省即 compose 发布在宿主回环上的门户端口，`COOKIE_NAME` 缺省
//   跟着入口协议联动；要换入口 / 换 cookie 名再显式加 `-e BASE_URL=… -e COOKIE_NAME=…`。）
//
// 需要的环境变量：
//   SESSION_ID   必填。要一个**可写**的会话 ⇒ 本用例会真的发消息、真的起 run、真的花 token、真的写库。
//   COOKIE       必填。会话 token 值（登录后那条 `Set-Cookie` 里的值）。cookie **名**缺省按入口协议联动
//                （见下面 `COOKIE_NAME`）；名字不对 = 静默落回登录页 ⇒ `verdict=FAIL reason=not_authenticated`。
//   BASE_URL     选填，缺省是 compose 发布在**宿主回环**上的门户地址；容器是 host 网络，直接打这个回环
//                publish 就够（不必绕任何对外入口）。
//   COOKIE_NAME  选填，**缺省值按 `BASE_URL` 的协议联动**（不是写死的一个串）：
//                `https:` ⇒ `__Host-fde_session`（Secure）；`http:` ⇒ `fde_session_dev`（非 Secure）。
//                口径与门户 `cookieSettings` 同源。为什么要联动：`__Host-` 前缀被浏览器**强制要求 Secure**，
//                在 http 入口下 Chromium 会直接**拒收**这条 cookie ⇒ 看着像会话问题其实是名字选错了。
//   PROBE        选填，缺省带时间戳唯一串。这一句话的**指纹**（转向正文里嵌它，靠它判「那句话在不在气泡里」）。
//   PROMPT       选填，缺省是一句「会长跑（先 sleep 再答）」的指令——run 必须还活着，才轮得到「投递进行中」这一刻。
//   OUT_DIR      选填，缺省是 playwright 容器的 output-dir（截图落那儿，`shot_pre` / `shot_post` 两条指向它）。
//   WAIT_MS      选填，缺省 150000（毫秒）。等「这一场 run 结束」的预算：服务端活跃 run 连续两次为空才算结束。
//   PLAYWRIGHT_CORE_PATH 选填。`playwright-core` 的解析路径（回退顺序：显式路径 → 裸导入 → 镜像内置路径）。
//
// 判据（**机器可读**，最后一行是结论）：
//   `QDCHECK server_has_steer=…`                              转向确已落库（写侧完好；为 0 直接 FAIL reason=server_missing_steer）
//   `QDCHECK live_bubble=… user_bubbles=… shot_pre=…`         **刷新前**实时视图可见性
//   `QDCHECK reload_bubble=… dup_after_reload=… shot_post=…`  **刷新后**可见性与是否重复
//   `QDCHECK verdict=PASS`                                    实时看得见 + 刷新后仍在 + 不重复（修好之后的形态）
//   `QDCHECK verdict=BUG reason=live_missing_reload_ok`       刷新前看不见、刷新后看得见（#799 的症状本身）
//   `QDCHECK verdict=FAIL reason=steer_was_direct_post`      转向被判成直发（run 已先结束）⇒ 这句没走队列投递路径，没测到本单（评审 R4）
//   `QDCHECK verdict=FAIL reason=<码>[ detail=<..>]`          环境 / 前置不满足
//   退出码：`PASS`=0 / `BUG`=3 / `FAIL`=1（BUG 与 FAIL 分开：BUG = 测到了本单要测的那个缺陷；
//   FAIL = 根本没测成——环境不满足时既不该记成「修好了」，也不该记成「还有 bug」）。
//
// 为什么不进 CI（也不进 `npm test`）：口径同 `docs/ops/ci-release.md`「e2e 不进 CI」——它要真起栈、真浏览器、
// 真模型：花 token、时长不可控、失败原因九成在环境不在代码，而且它会**写库**（发消息 = 真 run）。
// 本文件的定位是**发版前 / 大改后手工跑一次**的验收用例（#799 的 PASS / BUG 两态就是靠它取的证）。
// ⇒ 别把它加进 `package.json` 的 `test`，也别加进 CI。

import { mkdirSync } from 'node:fs';

const SESSION_ID = process.env.SESSION_ID;
const COOKIE = process.env.COOKIE;
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:18080').replace(/\/+$/, '');
const COOKIE_NAME = process.env.COOKIE_NAME
  || (new URL(BASE_URL).protocol === 'https:' ? '__Host-fde_session' : 'fde_session_dev');
const PROBE = process.env.PROBE || `QD799-${Date.now()}`;
const STEER = `转向验收 ${PROBE}：请只回答 OK-${PROBE}`;
const PROMPT = process.env.PROMPT || '请用 shell 工具执行 `sleep 20 && echo SLEPT`，等它返回后再回答 DONE';
const OUT_DIR = process.env.OUT_DIR || '/home/node/.playwright-mcp';
const WAIT_MS = Number(process.env.WAIT_MS || 150_000);

function out(line) { console.log(line); }
function fail(reason, detail = '') {
  out(`QDCHECK verdict=FAIL reason=${reason}${detail ? ` detail=${detail}` : ''}`);
  process.exit(1);
}
if (!SESSION_ID || !COOKIE) fail('missing_SESSION_ID_or_COOKIE');

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

// 页面里没法插值模板串，重写成带参版本
const state = () => page.evaluate(async ({ sid, probe }) => {
  const r = await fetch(`/api/sessions/${sid}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return { http: r.status };
  const d = await r.json();
  return {
    http: r.status,
    active: d.session?.active_run_id ?? null,
    serverHasSteer: (d.messages || []).some((m) => m.role === 'user' && String(m.content || '').includes(probe)),
  };
}, { sid: SESSION_ID, probe: PROBE });

const domState = () => page.evaluate(({ probe }) => {
  const txt = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  const users = [...document.querySelectorAll('.msg.user')];
  const qbar = document.querySelector('[data-testid="queued-inputs-bar"]');
  return {
    userBubbles: users.length,
    liveHasSteer: users.some((el) => txt(el).includes(probe)),
    queueBar: !!qbar,
    queueBarText: txt(qbar),
  };
}, { probe: PROBE });

try {
  await page.goto(`${BASE_URL}/#/session/${SESSION_ID}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  if (new URL(page.url()).hash.startsWith('#/login')) fail('not_authenticated', page.url());
  const ta = page.locator('textarea').first();
  await ta.waitFor({ timeout: 15_000 }).catch(() => fail('composer_not_found', page.url()));

  // ① 发一条会长跑的指令（走浏览器的发送钮）
  await ta.fill(PROMPT);
  await page.locator('button[data-queued-kind="send"]').first().click();
  out('QDCHECK note=sent_prompt');
  await page.waitForTimeout(2500);

  // 评审 R4（硬闸，非仅 note）：点「转向钮」**之前**就挂上 /queued-inputs 的响应，用来判定这句到底进了队列还是被直发。
  const queuedResp = page.waitForResponse((r) => r.url().includes('/queued-inputs'), { timeout: 15_000 }).catch(() => null);
  // ② run 还在跑：发转向（走 steer 钮）
  await ta.fill(STEER);
  const steerBtn = page.locator('button[data-queued-kind="steer"]').first();
  if (await steerBtn.count()) await steerBtn.click(); else await ta.press('Enter');
  out(`QDCHECK note=sent_steer probe=${PROBE}`);
  // 评审 R4：转向必须真的进了队列。POST 响应没有 `queued`（或 `posted` 非空）⇒ 这句被服务端判成**直发**而非队列投递，
  // 本脚本就根本没在测投递路径（直发也实时可见 ⇒ 会假 PASS）。报 FAIL 比假 PASS 诚实。queueBar 观测保留，但不再是判据。
  const steerBody = await queuedResp?.json().catch(() => null);
  if (!steerBody?.queued || steerBody.posted) fail('steer_was_direct_post', JSON.stringify(steerBody ?? null));

  // ③ 队列条必须出现过（否则这句话根本没进队列，测的就不是本单）
  let barSeen = false;
  for (let i = 0; i < 20 && !barSeen; i++) {
    const d = await domState();
    if (d.queueBar) barSeen = true; else await page.waitForTimeout(500);
  }
  if (!barSeen) out('QDCHECK note=queue_bar_not_seen（可能太快投完了，继续量最终可见性）');

  // ④ 等到「这一场」结束：服务端活跃 run 连续两次为空
  let done = false;
  let last = null;
  for (let t = 0; t < WAIT_MS; t += 2000) {
    await page.waitForTimeout(2000);
    last = await state();
    if (last.http !== 200) { fail('session_fetch_failed', `http=${last.http}`); }
    if (last.active === null) { await page.waitForTimeout(2000); const again = await state(); if (again.active === null) { done = true; last = again; break; } }
  }
  if (!done) fail('run_never_ended', `active=${last?.active}`);
  out(`QDCHECK server_has_steer=${last.serverHasSteer ? 1 : 0}`);
  if (!last.serverHasSteer) fail('server_missing_steer');

  // ⑤ **刷新前**：实时视图里看得见吗
  const pre = await domState();
  mkdirSync(OUT_DIR, { recursive: true });
  const shotPre = `${OUT_DIR}/qd799-pre-refresh.png`;
  await page.screenshot({ path: shotPre, fullPage: false }).catch(() => {});
  out(`QDCHECK live_bubble=${pre.liveHasSteer ? 1 : 0} user_bubbles=${pre.userBubbles} shot_pre=${shotPre}`);

  // ⑥ **刷新后**：应当一直都在（写侧完好是 #799 的已知事实）
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const post = await domState();
  const shotPost = `${OUT_DIR}/qd799-after-reload.png`;
  await page.screenshot({ path: shotPost, fullPage: false }).catch(() => {});
  out(`QDCHECK reload_bubble=${post.liveHasSteer ? 1 : 0} dup_after_reload=${post.userBubbles} shot_post=${shotPost}`);

  if (pre.liveHasSteer && post.liveHasSteer && post.userBubbles === pre.userBubbles) {
    out('QDCHECK verdict=PASS');
    process.exitCode = 0;
  } else if (!pre.liveHasSteer && post.liveHasSteer) {
    out('QDCHECK verdict=BUG reason=live_missing_reload_ok');
    process.exitCode = 3;
  } else {
    out(`QDCHECK verdict=FAIL reason=unexpected live=${pre.liveHasSteer} reload=${post.liveHasSteer}`);
    process.exitCode = 1;
  }
} finally {
  await browser.close().catch(() => {});
}
