// issue #370：接线与防漂移测试。
//
// 队列的**行为**在 `queued-inputs.test.js`（22 例判定表）。本文件只管一件在行为测试里永远测不到的事：
// **「五处终态产出点都必须出队」这条纪律有没有被后来的改动破坏**。这五处不在一条调用链上
// （U2 上报、release-requeue、租约收割、portal 直接终态的停止、offboard 收敛），加第六处时没人会
// 想起来回头改前面四处——漏一处的症状是「队列偶尔静默卡死」，界面上毫无线索。于是把「谁调了它」
// 变成断言（AGENTS §5 文档/代码防漂移的同一手法）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
const FRONTEND = path.join(SRC, '../frontend/src');
const RUNNER = path.join(SRC, '../../runner');
const readFile = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const read = (...p) => readFile(SRC, ...p);   // 默认指向 portal/src，跨目录处显式给绝对根

/**
 * 取出顶层函数体的文本切片（从 `head` 匹配处到下一个**顶格** `}`）。
 * 为什么不用正则一把梭：这些函数几百行，中间全是 `}`；本仓源码风格里「顶格 `}`」只出现在
 * 顶层函数结尾，据此截断既准又不受内部嵌套影响。
 */
function fnBody(file, head) {
  // file 相对 portal/src（`'internal.js'` / `'../src/provisioner.js'`），path.join 会规范化 `..`
  const src = readFile(SRC, file);
  const i = src.indexOf(head);
  assert.ok(i >= 0, `${file} 里找不到 ${head}（函数被改名/搬走 = 本测试要先于行为测试变红）`);
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, `${head} 的函数体没找到结尾`);
  return src.slice(i, j);
}

test('#370 五处终态产出点全都接了出队', () => {
  const sites = [
    // [文件, 函数头锚点, 额外断言]
    ['internal.js', 'async function finishRun(', null],
    ['internal.js', 'async function releaseRun(', 'committedRunEnd'],
    ['internal.js', 'async function reapExpiredRuns(', 'committedRunEnd'],
    ['../src/provisioner.js', 'export async function deprovisionFde(', null],
  ];
  for (const [file, head, gate] of sites) {
    const body = fnBody(file, head);
    assert.match(body, /drainQueueAfterRun\s*\(/, `${file} ${head}：终态处必须调 drainQueueAfterRun`);
    if (gate) {
      // requeue 分支**不是**终态（run 还活着），在它前面出队会把同一会话的第二条投进一个仍在跑的
      // run 的队列里 ⇒ 必须挂在 committedRunEnd 之后。
      assert.match(body, /if \(committedRunEnd\)\s*await drainQueueAfterRun/, `${file} ${head}：出队必须只在 run 真终态时发生（${gate} 门）`);
    }
  }
  // 第五处：停止端点的**直接终态**分支（`queued 且未被领走` ⇒ portal 自己写 finished，永不再有 worker 上报）。
  // 它在 http.js 而不在 sessions.js：`stopSession` 属会话模块，而队列属 internal/queued-inputs 这一侧，
  // 让 sessions.js 反过来 import internal.js 会成环（internal.js 已 import queued-inputs.js）。
  const httpSrc = read('http.js');
  const stopBranch = httpSrc.slice(
    httpSrc.indexOf('broadcastStopRequest'),
    httpSrc.indexOf('broadcastStopRequest') + 1200,
  );
  assert.match(stopBranch, /result\.run\?\.status === 'finished' \|\| result\.run\?\.status === 'failed'/,
    'http.js：只有停止真的产出终态时才出队');
  assert.match(stopBranch, /drainQueueAfterRun/, 'http.js：停止的直接终态分支必须出队');
});

test('#370 依赖方向不得成环（queued-inputs 不 import internal）', () => {
  const q = read('queued-inputs.js');
  assert.ok(!/from '\.\/internal\.js'/.test(q),
    'queued-inputs.js 不得 import internal.js：internal.js 已 import 本文件（终态出队接线），加了就成环');
  assert.ok(/from '\.\/sessions\.js'/.test(q),
    'queued-inputs.js 必须复用 sessions.js 的 postMessage（唯一发送路，#261B 红线）');
});

test('#370 queue_update：注册为 live-only，绝不进历史回放三处集合', () => {
  // 它没有 seq（信封要求 run_id NOT NULL，而入队时压根没有 run），落历史会写出一个无 run 的
  // run_events 行 ⇒ NOT NULL 直接崩。三处集合（后端下发白名单、前端监听、前端回放）互相独立，
  // #288 已经证明过「三处漏一处」是这里的常态故障模式，所以三处都钉。
  const internalSrc = read('internal.js');
  assert.match(internalSrc, /type: 'queue_update'/, 'internal.js 要发 queue_update');

  const httpSrc = read('http.js');
  const historyList = httpSrc.slice(httpSrc.indexOf('const HISTORY_EVENT_TYPES'), httpSrc.indexOf('const HISTORY_EVENT_TYPES') + 900);
  assert.ok(historyList.length > 50, 'HISTORY_EVENT_TYPES 锚点还在');
  assert.ok(!historyList.includes("'queue_update'"), 'queue_update 不得进后端历史白名单');

  const es = readFile(FRONTEND, 'composables/useEventStream.ts');
  const listen = es.slice(es.indexOf('const EVENT_TYPES'), es.indexOf('] as const'));
  assert.ok(listen.includes("'queue_update'"), '前端 EVENT_TYPES 必须监听 queue_update（漏加=实时一条都收不到）');
  const replay = es.slice(es.indexOf('const HISTORY_REPLAY_TYPES'), es.indexOf(']);', es.indexOf('const HISTORY_REPLAY_TYPES')));
  assert.ok(!replay.includes("'queue_update'"), 'queue_update 不得进前端回放白名单（它无 seq）');
});

test('#370 会话详情必须带队列快照（刷新/多端补齐的唯一来源），且不得为此造出循环依赖', () => {
  const h = read('http.js');
  assert.match(h, /result\.session\.queued_messages = await queuedInputs\.snapshotQueuedInputs/,
    'GET /api/sessions/:id 必须返回 queued_messages，且取自 queued_inputs 表（不是前端缓存）');
  assert.match(h, /catch \{ result\.session\.queued_messages = \{ steering: \[\], follow_up: \[\] \}; \}/,
    '快照失败必须退化成空队列，不许把会话详情拖成 5xx');
  // 依赖方向：queued-inputs → sessions（复用唯一发送路）是正向；sessions 反向 import 它就是环。
  const s = read('sessions.js');
  assert.ok(!/from '\.\/queued-inputs\.js'/.test(s),
    'sessions.js 不得 import queued-inputs.js（会成环：queued-inputs 已 import sessions）');
});

test('#370 转向的 runner 侧：只装标记，绝不起 SIGKILL 宽限', () => {
  const agentd = readFile(RUNNER, 'agentd.js');
  const i = agentd.indexOf("event === 'steer_request'");
  assert.ok(i > 0, 'agentd 必须处理 steer_request');
  const branch = agentd.slice(i, agentd.indexOf("if (event === 'revoke')", i));
  assert.match(branch, /MSG\.STEER_ARM/, 'steer_request 要转成 STEER_ARM IPC');
  assert.ok(!/abortRun\s*\(/.test(branch),
    '⚠ steer 绝不能走 abortRun：那会起 5s SIGKILL 宽限并砍掉正在跑的工具，正是轮边界停止要避免的事');

  const ipc = readFile(RUNNER, 'lib/ipc.js');
  assert.match(ipc, /STEER_ARM:\s*'steer_arm'/, 'IPC 类型表要加 STEER_ARM');

  const worker = readFile(RUNNER, 'worker.js');
  assert.match(worker, /case MSG\.STEER_ARM:/, 'worker 要接 STEER_ARM');
  assert.match(worker, /onRound:\s*\(\)\s*=>\s*\{/, 'worker 必须挂 onRound——它是轮边界 abort 的唯一落点');
  const onRound = worker.slice(worker.indexOf('onRound: () => {'), worker.indexOf('onRound: () => {') + 900);
  assert.match(onRound, /abortController\.abort\(\)/, 'onRound 里必须靠 abort() 停（#173：抛错不是控制流）');
  assert.ok(!/await/.test(onRound), 'onRound 里不得 await：park 住会卡 run，拿 90s 租约与静默看门狗冒险');

  // 每个 run 必须复位标记：worker 进程被 agentd 复用给下一个 run，漏复位 = 上个 run 的转向把下个 run 也停了。
  const startRun = worker.slice(worker.indexOf('async function startRun('), worker.indexOf('async function startRun(') + 900);
  assert.match(startRun, /steerArmed = false/, 'startRun 必须复位 steerArmed');
  assert.match(startRun, /steeredThisRun = false/, 'startRun 必须复位 steeredThisRun');
});

test('#370 trigger_kind 的取值必须与迁移 CHECK 一致（漂了就是写入即崩）', () => {
  const mig = read('../../deploy/migrations/0024-queued-inputs.sql');
  const check = /trigger_kind IN \(([^)]*)\)/.exec(mig)?.[1] ?? '';
  const allowed = check.split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  const q = read('queued-inputs.js');
  for (const kind of ['queued_steer', 'queued_follow_up']) {
    assert.ok(allowed.includes(kind), `迁移 CHECK 缺 ${kind}`);
    assert.ok(q.includes(`'${kind}'`), `queued-inputs.js 用了 ${kind} 之外的拼法`);
  }
  // postMessage 的默认口径也得在集合里——它是这条列的最大流量来源
  const sessionsSrc = read('sessions.js');
  assert.match(sessionsSrc, /triggerKind[^]{0,200}'user_send'/, "postMessage 缺 trigger_kind 时按 user_send 落库");
  assert.ok(allowed.includes('user_send'), '迁移 CHECK 必须容下默认值 user_send');
});

// #370：`CLAIM_STALE_MS` 不得是一根没人读的光纤（前例：#331 那根死光纤）。
// 行为测试在这里**测不到**这条：认领过期的判据在 SQL 里，而假池自己实现了一份同判据的 JS——
// 产品 SQL 怎么写、假池都照样绿（变异「把 pick 改回只认 pending」实测仍然 25/25 全绿，
// 这就是证据）。所以判据必须同时在源码上钉一次：pick 与 CAS 两条语句都得带过期重认领，
// 且那个时长必须由 CLAIM_STALE_MS 推导（不是硬编码第二个数）。
test('#370 认领过期重认领在 SQL 里真实存在（不是只写在注释与假池里）', () => {
  const q = read('queued-inputs.js');
  // pick 走模板变量 CLAIMABLE，所以断言分两段：那个变量本身必须含过期判据 + pick 必须真的用它。
  const claimable = /const CLAIMABLE = `([\s\S]*?)`;/.exec(q);
  assert.ok(claimable, 'CLAIMABLE 谓词不见了：pick 与 CAS 的同一性就是靠这个变量维持的');
  assert.match(claimable[1], /q\.status = 'pending'/, '可认领 = pending');
  assert.match(claimable[1], /q\.status = 'delivering'/, '…或 delivering');
  assert.match(claimable[1], /q\.claimed_at < now\(\) - make_interval\(secs => \$2::int\)/, '…且认领已过期');

  const pick = /SELECT q\.id[\s\S]*?ORDER BY/.exec(q);
  assert.ok(pick, '队头查询（pick）形状变了：重核本断言');
  assert.match(pick[0], /\$\{CLAIMABLE\}/, 'pick 必须用 CLAIMABLE，不得自己写一条只认 pending 的');
  assert.match(pick[0], /q2\.status = 'delivering'/, 'pick 的组内自连接也必须认过期 delivering（否则卡住的行会挡住同组后来的）');

  const cas = /UPDATE queued_inputs SET status = 'delivering'[\s\S]*?\[head\.id/.exec(q);
  assert.ok(cas, '认领 CAS 不见了');
  assert.match(cas[0], /status = 'delivering'\s*AND claimed_at < now\(\) - make_interval\(secs => \$2::int\)/,
    'CAS 的准入必须与 pick 同一条判据（选出来了却永远抢不到 = 白跑一轮）');
  assert.match(q, /const staleSeconds = Math\.max\(1, Math\.round\(CLAIM_STALE_MS \/ 1000\)\)/,
    '过期时长必须由 CLAIM_STALE_MS 推导（硬编码第二个数就是两处真相）');
  // 上限计数必须含 delivering：否则「认领后崩掉」那行不计入上限，20 条的红线会被绕过
  assert.match(q, /COUNT\(\*\)::int[\s\S]*?status IN \('pending', 'delivering'\)/,
    '上限计数必须含 delivering');
});
