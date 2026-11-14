// 单测：issue #506 评审②——优雅关闭必须**等当前那一拍收尾**（且有上限，不挂死）。
//
// 缺陷形状（现查 `portal/src/cli.js`）：`shutdown()` 只同步调 7 个 `stop()`，随后
// `server.close(() => process.exit(0))`；而 `stop()` 只做 `abort.abort()`，**在途的
// `claim*Rows()` 事务不会被中断**，`done` 要等本轮结束才 resolve，却没人 await 它
// ⇒ 进程可能在事务中途退出（回滚 / 或已提交但没 mark*Published ⇒ 行带 60s 租约等回收）。
//
// 判据形状：不是「代码里 await 了」，而是**观察**：谁被 stop 了（顺序/次数）、真的等到了几个、
// 永不落定的那个是否把关闭流程拖挂死、超时有没有留一条 warn、拒绝有没有被吃掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stopLoopsAndWait } from '../src/shutdown.js';

function recordingLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
}

/** 假循环：记录 stop() 调用，`done` 由测试决定何时/是否落定。 */
function fakeLoop(name, stopOrder, donePromise, { throwOnStop = false } = {}) {
  const calls = { stop: 0 };
  return {
    name,
    calls,
    stop() {
      calls.stop += 1;
      stopOrder.push(name);
      if (throwOnStop) throw new Error(`stop() 炸了：${name}`);
    },
    done: donePromise,
  };
}

// ---------------------------------------------------------------------------
// 核心用例：A 立即 resolve、B 100ms 后 resolve、C 永不 resolve
// ---------------------------------------------------------------------------

test('#506b 关闭等收尾：A 立即 / B 100ms / C 永不 ⇒ 在 timeoutMs 后返回、不挂死、记一条 warn', async () => {
  const order = [];
  const log = recordingLog();
  const a = fakeLoop('A', order, Promise.resolve());
  const b = fakeLoop('B', order, new Promise((r) => setTimeout(r, 100)));
  const c = fakeLoop('C-never', order, new Promise(() => {})); // 永不落定（旧代码就是在等它却没人等）

  const t0 = Date.now();
  const out = await stopLoopsAndWait([a, b, c], { timeoutMs: 300, log });
  const elapsed = Date.now() - t0;

  assert.ok(out.timedOut, 'C 永不 resolve ⇒ 必须走超时分支（否则就是没设上限）');
  assert.deepEqual(out.pending, ['C-never'], `超时要能点名谁没退（实测 ${JSON.stringify(out.pending)}）`);
  assert.equal(out.waited, 3);
  assert.equal(out.skipped, 0);
  assert.ok(elapsed >= 90, `A/B 的收尾必须真等到（只用了 ${elapsed}ms ⇒ 根本没等 done）`);
  assert.ok(elapsed < 2000, `超时后必须马上返回（实测 ${elapsed}ms，timeoutMs=300）——不许无限等`);
  assert.equal(log.warns.length, 1, `超时只记一条 warn（实测 ${JSON.stringify(log.warns)}）`);
  assert.match(log.warns[0], /超时/);
  assert.match(log.warns[0], /C-never/, 'warn 要写清是哪个循环没退，运维才有的可查');
  assert.match(log.warns[0], /租约|lease/, 'warn 要交代后果（行带租约等回收），别只说“超时了”');
});

test('#506b 全部循环的 stop() 都被调用：一次、且按传入顺序', async () => {
  const order = [];
  const loops = ['A', 'B', 'C'].map((n) => fakeLoop(n, order, Promise.resolve()));
  const out = await stopLoopsAndWait(loops, { timeoutMs: 200, log: recordingLog() });
  assert.deepEqual(order, ['A', 'B', 'C'], `stop 必须按顺序全调（实测 ${order.join(',')}${order.length !== 3 ? `，共 ${order.length} 次` : ''}）`);
  for (const l of loops) assert.equal(l.calls.stop, 1, `${l.name} 的 stop 被调了 ${l.calls.stop} 次（要求幂等于 1）`);
  assert.equal(out.stopped, 3);
  assert.equal(out.timedOut, false, '全部立刻 resolve ⇒ 不该报超时');
});

test('#506b 全部能收尾时不记超时 warn，且真的等满了最慢那一拍（不是发完 stop 就退）', async () => {
  const order = [];
  const log = recordingLog();
  const loops = [
    fakeLoop('fast', order, Promise.resolve()),
    fakeLoop('slow', order, new Promise((r) => setTimeout(r, 120))),
  ];
  const t0 = Date.now();
  const out = await stopLoopsAndWait(loops, { timeoutMs: 1000, log });
  const elapsed = Date.now() - t0;
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.pending, []);
  assert.ok(elapsed >= 110, `最慢那一拍（120ms）没等到就返回了（${elapsed}ms ⇒ 旧行为：发完 stop 直接退）`);
  assert.deepEqual(log.warns, [], '正常收尾不该有告警噪声');
});

// ---------------------------------------------------------------------------
// allSettled 语义：拒绝不许把关闭流程炸掉
// ---------------------------------------------------------------------------

test('#506b 某个循环的 done 被拒绝 ⇒ helper 仍正常返回（allSettled 语义），拒绝被记账', async () => {
  const order = [];
  const log = recordingLog();
  const boom = new Error('循环带错误退出');
  const loops = [
    fakeLoop('ok', order, Promise.resolve()),
    fakeLoop('rejects', order, Promise.reject(boom)),
    fakeLoop('also-rejects', order, Promise.reject(new Error('第二条'))),
  ];
  const out = await stopLoopsAndWait(loops, { timeoutMs: 200, log }); // 不抛 ⇒ 断言本身就是判据
  assert.equal(out.timedOut, false, '拒绝不是超时');
  assert.equal(out.rejected, 2, `两个拒绝都要被记进账（实测 ${out.rejected}）`);
  assert.equal(out.stopped, 3);
  // 拒绝不许变成未捕获拒绝（本仓「摘要全绿但 rc=1」的成因形状）
  const seen = [];
  const onUnhandled = (err) => seen.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(seen, [], `关闭流程自己不该漏未捕获拒绝：${seen.map((e) => e.message).join(',')}`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('#506b stop() 自己抛错也不许中断关闭批次（其余循环照样被 stop、照样等）', async () => {
  const order = [];
  const log = recordingLog();
  const loops = [
    fakeLoop('bad-stop', order, Promise.resolve(), { throwOnStop: true }),
    fakeLoop('good', order, new Promise((r) => setTimeout(r, 30))),
  ];
  const out = await stopLoopsAndWait(loops, { timeoutMs: 300, log });
  assert.deepEqual(order, ['bad-stop', 'good'], '第一个 stop 抛错后必须继续 stop 其余的');
  assert.equal(out.timedOut, false);
  assert.equal(log.warns.length, 1);
  assert.match(log.warns[0], /bad-stop/);
});

// ---------------------------------------------------------------------------
// 缺 done 的循环（onboarding / offboarding / provisioner / reaper / driftMonitor 的真实形状）
// ---------------------------------------------------------------------------

test('#506b 只有 stop() 没有 done 的循环：跳过、不计入等待、也不把关闭拖到超时', async () => {
  const order = [];
  const log = recordingLog();
  const withDone = fakeLoop('routes', order, Promise.resolve());
  const noDone = { name: 'onboarding', stop: () => { order.push('onboarding'); } }; // 真形状：只有 stop
  const t0 = Date.now();
  const out = await stopLoopsAndWait([noDone, withDone, null, undefined], { timeoutMs: 5000, log });
  const elapsed = Date.now() - t0;
  assert.deepEqual(order, ['onboarding', 'routes'], '缺 done 的循环也必须被 stop（只是不 await）');
  assert.equal(out.stopped, 2, 'null/undefined 条目不算 stop 目标');
  assert.equal(out.waited, 1, '只有带 done 的才进等待名单');
  assert.equal(out.skipped, 1, '缺 done 的要记进账（日志里要看得见“有几个循环没等”）');
  assert.equal(out.timedOut, false);
  assert.ok(elapsed < 1000, `带一个永不落定的 done 都没等满，这里更不该等（${elapsed}ms）`);
});

test('#506b timeoutMs=0 / 非法 ⇒ 不等但仍返回（关闭路径上最不该出现“等死”）', async () => {
  const order = [];
  for (const timeoutMs of [0, -5, 'abc', Number.NaN]) {
    const loops = [fakeLoop('never', order, new Promise(() => {}))];
    const t0 = Date.now();
    const out = await stopLoopsAndWait(loops, { timeoutMs, log: recordingLog() });
    assert.ok(out.timedOut, `timeoutMs=${String(timeoutMs)} 时永不落定的 done 必须走超时分支`);
    assert.ok(Date.now() - t0 < 500, `timeoutMs=${String(timeoutMs)} 不该等（实测 ${Date.now() - t0}ms）`);
  }
  // 非法上限一律当作「不等」（0/-5/'abc'/NaN）；默认值由下面这条源码钉住（不真等 5s）
  assert.match(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/shutdown.js'), 'utf8'),
    /timeoutMs = 5000/, '默认上限必须是 5000ms');
});

test('#506b 收尾用的限时 timer 必须被 clearTimeout（否则“等循环退出的 timer”自己拖住进程退出）', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/shutdown.js'), 'utf8');
  assert.match(src, /clearTimeout\(timer\)/, '落定后必须 clearTimeout');
  assert.doesNotMatch(src, /timer\.unref\(\)/, '限时 timer 不许 unref：unref 后 Node 会认为事件循环已空，await 被跳过');
});

// ---------------------------------------------------------------------------
// 接线：cli.js 真的 await 了这个 helper（helper 绿不代表 serve 用了它）
// ---------------------------------------------------------------------------

test('#506b cli.js 的 shutdown 必须 await stopLoopsAndWait 并接住 rejection', () => {
  const cli = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.js'), 'utf8');
  assert.match(cli, /import \{ stopLoopsAndWait \} from '\.\/shutdown\.js'/, 'cli.js 要用 helper，别自己重抄一遍');
  assert.match(cli, /const shutdown = async \(\) => \{[\s\S]{0,400}?await stopLoopsAndWait\(/,
    'shutdown 必须是 async 并 await 收尾（旧行为：同步 stop 完就 server.close ⇒ 事务中途 process.exit）');
  const shutdownBody = /const shutdown = async \(\) => \{([\s\S]*?)\n  \};/.exec(cli);
  assert.ok(shutdownBody, 'cli.js 里找得到 `const shutdown = async () => { ... }` 的函数体');
  const waitAt = shutdownBody[1].search(/await stopLoopsAndWait\(/);
  const closeAt = shutdownBody[1].search(/server\.close\(\(\) => process\.exit\(0\)\)/);
  assert.ok(waitAt >= 0 && closeAt > waitAt,
    'shutdown 体内必须先等收尾再 close/exit（顺序反了等于没等，就是旧行为）');
  assert.match(cli, /shutdown\(\)\.catch\(/, 'process.once 的回调要接住 shutdown 的拒绝（否则未捕获拒绝 ⇒ rc=1）');
  // 七个循环一个都不能丢（旧代码是七个 stop）
  for (const n of ['materializer', 'onboarding', 'offboarding', 'routes', 'routes-drift', 'provisioner', 'reaper']) {
    assert.ok(cli.includes(`name: '${n}'`), `cli.js 的 loops 名单里少了 ${n}`);
  }
});
