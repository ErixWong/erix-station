// 单测：issue #506 的 copilot **第二轮复审①-b**（主 agent 现查核实）——`stopLoopsAndWait` 的
// `timeoutMs` 没夹到 Node timer 上限，越界值不是「等很久」而是 **1ms 就判超时**。
//
// 缺陷形状（现查 `portal/src/shutdown.js`）：
//   `const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;` ⇒ 只要「是正有限数」就原样
//   进 `setTimeout`。现查 Node v22.23.2：`setTimeout(fn, 3e9)` 打印
//     `TimeoutOverflowWarning: 3000000000 does not fit into a 32-bit signed integer.`
//     `Timeout duration was set to 1.`
//   ⇒ 关闭流程**刚发完 stop 就判定「循环没退」**，然后带着在途事务 `process.exit(0)`——正是
//   shutdown.js 存在的理由被配置一个数字破掉（本仓 #506 评审① 已在退避旋钮上踩过同一个坑，
//   见 `idle-backoff-safe-range-506b.test.js`；这条是同一个坑的第二个落点）。
//
// 判据形状：不测「代码里有没有 Math.min」，测**喂给 setTimeout 的那个数字**与**关闭是否过早返回**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { stopLoopsAndWait, MAX_SHUTDOWN_TIMEOUT_MS } from '../src/shutdown.js';

const NODE_TIMER_MAX_MS = 2147483647; // 32 位有符号上限：越界 ⇒ Node 把 duration 设成 1

function recordingLog() {
  const warns = [];
  return { warns, warn: (m) => warns.push(String(m)), error: () => {}, log: () => {} };
}

/** 把 globalThis.setTimeout 换成「记录延迟、真 timer 只走 1ms」的代理（用例不等 24 天）。 */
function spySetTimeout() {
  const real = globalThis.setTimeout;
  const captured = [];
  globalThis.setTimeout = (fn, ms, ...rest) => {
    captured.push(ms);
    return real(fn, 1, ...rest);
  };
  return { captured, restore: () => { globalThis.setTimeout = real; } };
}

// ---------------------------------------------------------------------------
// 核心：越界上限必须被夹住，而不是原样进 timer
// ---------------------------------------------------------------------------

test('#506c timeoutMs=3e9 ⇒ 喂给 setTimeout 的延迟被夹到 2147483647（改前是原样 3e9 ⇒ Node 折成 1ms）', async () => {
  const spy = spySetTimeout();
  const log = recordingLog();
  const never = { name: 'never', stop() {}, done: new Promise(() => {}) };
  try {
    const out = await stopLoopsAndWait([never], { timeoutMs: 3e9, log });
    assert.equal(spy.captured.length, 1, `helper 只该建一个限时 timer（实测 ${JSON.stringify(spy.captured)}）`);
    const ms = spy.captured[0];
    assert.ok(ms > 0, `延迟必须 > 0（实测 ${ms}）——0 等于根本不等`);
    assert.ok(ms <= NODE_TIMER_MAX_MS,
      `延迟必须 ≤ ${NODE_TIMER_MAX_MS}（实测 ${ms} ⇒ 越界，Node 会把它折成 1ms ⇒ 关闭刚发完 stop 就判超时）`);
    assert.equal(ms, NODE_TIMER_MAX_MS, `3e9 越界 ⇒ 必须夹成上限本身（实测 ${ms}）`);
    assert.equal(out.timedOut, true, '永不落定的 done 仍要如实报超时（夹取不是吞掉超时）');
    assert.deepEqual(out.pending, ['never'], '点名不许因为夹取而丢');
    assert.equal(log.warns.length, 1);
    assert.match(log.warns[0], /2147483647/, `warn 要报**实际生效**的上限（实测 ${log.warns[0]}）`);
    assert.doesNotMatch(log.warns[0], /超时（3000000000ms/, '不许报一个根本没等过的原配置值骗运维');
  } finally {
    spy.restore();
  }
});

test('#506c timeoutMs=3e9 不许 1ms 就返回（真 timer，不夹上限时 Node 会在 1ms 上判超时）', async () => {
  // 不用 spy：这条要的是「真实 timer 语义」——改前 3e9 被折成 1ms，于是下面那次赛跑会立刻拿到 'resolved'。
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const loops = [{ name: 'slow-tx', stop() {}, done }];
  const startedAt = Date.now();
  const p = stopLoopsAndWait(loops, { timeoutMs: 3e9, log: recordingLog() });
  // 给它 60ms（远大于被截断后的 1ms，远小于夹住后的 24.8 天）：这时必须**还在等**
  const early = await Promise.race([
    p.then(() => 'returned'),
    new Promise((r) => setTimeout(() => r('still-waiting'), 60)),
  ]);
  assert.equal(early, 'still-waiting',
    `改前：3e9 被 Node 折成 1ms ⇒ 这里已经是 'returned'（等了 ${Date.now() - startedAt}ms 就宣布循环没退，`
    + '在途事务被 process.exit 切断）');
  finish(); // 放它收尾，同时让 helper clearTimeout（否则这条用例会挂着一个 24 天的 timer）
  const out = await p;
  assert.equal(out.timedOut, false, '收尾成功就不该报超时');

  // 对照：合法的小上限照旧生效（夹取不是「一律忽略配置」）
  const t0 = Date.now();
  const short = await stopLoopsAndWait([{ name: 'n', stop() {}, done: new Promise(() => {}) }],
    { timeoutMs: 40, log: recordingLog() });
  assert.equal(short.timedOut, true);
  assert.ok(Date.now() - t0 < 1000, `合法小上限必须照旧短等（实测 ${Date.now() - t0}ms）`);
});

// ---------------------------------------------------------------------------
// 边界：夹取的口径本身（合法值不动、脏值仍旧当 0、导出常量存在且语义独立）
// ---------------------------------------------------------------------------

test('#506c 合法上限原样进 timer（夹取不许变成「一律取小」）；脏值仍当 0（不等）', async () => {
  const spy = spySetTimeout();
  try {
    const cases = [
      [250, 250], [5000, 5000], [NODE_TIMER_MAX_MS, NODE_TIMER_MAX_MS],
      [0, 0], [-5, 0], ['abc', 0], [Number.NaN, 0], [Number.POSITIVE_INFINITY, 0],
      [3e9, NODE_TIMER_MAX_MS], [Number.MAX_SAFE_INTEGER, NODE_TIMER_MAX_MS],
    ];
    for (const [timeoutMs, want] of cases) {
      spy.captured.length = 0;
      const out = await stopLoopsAndWait([{ name: 'never', stop() {}, done: new Promise(() => {}) }],
        { timeoutMs, log: recordingLog() });
      assert.deepEqual(spy.captured, [want], `timeoutMs=${String(timeoutMs)} ⇒ timer 延迟应为 ${want}（实测 ${spy.captured.join(',')}）`);
      assert.equal(out.timedOut, true, `timeoutMs=${String(timeoutMs)} 时永不落定的 done 必须如实报超时`);
    }
  } finally {
    spy.restore();
  }
});

test('#506c MAX_SHUTDOWN_TIMEOUT_MS 是导出常量、等于 Node timer 上限，且**不是**退避那个 60s 业务值', () => {
  assert.equal(MAX_SHUTDOWN_TIMEOUT_MS, NODE_TIMER_MAX_MS,
    '关闭超时的夹取点只受 timer 表示范围约束：它是 2147483647，不是退避的 60s');
  assert.notEqual(MAX_SHUTDOWN_TIMEOUT_MS, 60_000,
    '「退避超过 60s 没意义」这条业务判断对关闭超时不成立，两个语义不许共用一个常量');
  const src = fs.readFileSync(new URL('../src/shutdown.js', import.meta.url), 'utf8');
  assert.match(src, /const NODE_TIMER_MAX_MS = 2147483647;/, '上限要用字面量写明');
  assert.match(src, /Math\.min\(ms, MAX_SHUTDOWN_TIMEOUT_MS\)/, '进 setTimeout 前必须夹一次');
  assert.match(src, /2147483647|32 位/, '注释要写明越界为什么是 1ms');
  assert.doesNotMatch(src, /setTimeout\(\(\) => resolve\('timeout'\), timeoutMs\)/,
    '不许把未夹取的 timeoutMs 直接喂给 setTimeout');
  // 超时的 warn 要报**实际生效**的毫秒数，别报一个根本没等过的原配置值
  assert.match(src, /等循环收尾超时（\$\{effectiveTimeoutMs\}ms/, 'warn 要报实际生效的上限');
});
