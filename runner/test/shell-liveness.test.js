// issue #288 M1：shell 执行期保活（缺陷 A）+ shell 子进程组泄漏（缺陷 D）的单测。
//
// 背景（dev 真机标本：`fde-eric` / run `e480a06f-0891-4bbd-a1f9-1079ab217a07`，默认配置零 env 放宽）：
//   一条消息让 agent 跑 `shell {command:"sleep 360 && echo DONE-288", timeout_ms:420000}` ⇒
//   08:05:44 tool_use shell → 08:10:45 `watchdog: worker silent, killing`（silent_ms=301584）→
//   `release run reason=worker_crashed outcome=requeued` → 08:11:12 attempt=2 **同一条命令再跑一遍**
//   → 三次同样被杀 → `error.code=max_attempts_exceeded`。用户侧 = 同一张工具卡片亮 3 次 + 16 分钟转圈。
//   根因：`runner/lib/shell-tools.js` 全程零 IPC，agentd 的 F6 watchdog（`ERIX_AGENTD_WATCHDOG_MS`
//   默认 300000）只看「有没有 IPC」，看不到「命令还在跑」。
//
// 本文件钉四件事（工单验收 ①②③④）：
//   ① 心跳：命令在跑就必须周期性冒泡，且**工具返回正文逐字节不变**（红线）。
//   ② pgid 上报与收敛：spawn 上报、命令退出后 agentd 侧登记集合清空。
//   ③ agentd 清理顺序：watchdog 路径上**先杀 `-workerPid`，再杀登记的每个 `-pgid`**。
//   ④ SIGKILL 前提：清理**不能**挂在 worker 的 `process.on('exit')` 上——SIGKILL 不给跑 handler 的机会。
//
// 隔离约定：进程内 spawn（bash -c）+ tmp 目录作项目根，不碰真实环境；agentd 经 direct-run
// 守卫被 import（不启动主循环），watchdog 用注入的 fake kill / 假 ctx 驱动，不真起子进程。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createShellTools, resolveShellLivenessIntervalMs, resolveShellMaxTimeoutMs } from '../lib/shell-tools.js';
import { MSG } from '../lib/ipc.js';

process.env.ERIX_STATION_TOKEN = 'test-token';
const { sweepWatchdog, killShellChildGroups, applyShellLiveness, warnIfWatchdogBelowShellMax, makeRunCtx } =
  await import('../agentd.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = 'run-288-liveness';

/** 造一个「在跑」的假 RunCtx（字段形态与 makeRunCtx 一致，worker 用桩对象满足判活条件）。 */
function makeFakeCtx({ runId = RUN_ID, workerPid = 41001, shellPgids = [], lastIpcAt = 0, ...extra } = {}) {
  const ctx = makeRunCtx(runId);
  ctx.worker = { connected: true };
  ctx.workerPid = workerPid;
  ctx.shellPgids = new Set(shellPgids);
  ctx.lastIpcAt = lastIpcAt;
  Object.assign(ctx, extra);
  return ctx;
}

/** 记录 `process.kill` 调用序列的 fake（③ 的顺序判据全靠它）。 */
function makeKillSpy({ throwOn = () => false } = {}) {
  const calls = [];
  return {
    calls,
    kill: (pid, sig) => {
      calls.push([pid, sig]);
      if (throwOn(pid, sig)) throw Object.assign(new Error(`kill ${pid}: no such process`), { code: 'ESRCH' });
    },
  };
}

/** 收集 shell 工具的 liveness 信号。 */
function collectLiveness(heartbeatIntervalMs) {
  const events = [];
  return {
    events,
    liveness: { heartbeatIntervalMs, onEvent: (ev) => events.push(ev) },
    phases: (phase) => events.filter((ev) => ev.phase === phase),
  };
}

function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-288-liveness-'));
  return Promise.resolve(fn(root)).finally(() => fs.rmSync(root, { recursive: true, force: true }));
}

// ---------------------------------------------------------------------------
// ① 执行期保活：命令在跑就周期性冒泡，且工具返回正文逐字节不变
// ---------------------------------------------------------------------------

test('#288① shell 执行期发保活：1200ms 命令 + 200ms 心跳间隔 ⇒ 至少 3 条 heartbeat', () =>
  withTempRoot(async (root) => {
    const sink = collectLiveness(200);
    const tools = createShellTools({ worktreeRoot: root, liveness: sink.liveness });
    const out = await tools.executors.shell({ command: 'sleep 1.2', timeout_ms: 20_000 });
    assert.match(out, /^exit_code: 0\n/, `命令本身要正常跑完：${out}`);

    const beats = sink.phases('heartbeat');
    assert.ok(beats.length >= 3, `预期至少 3 条保活（1200ms/200ms），实际 ${beats.length} 条`);
    // 每条保活必须带 pgid（agentd 侧账本按它记账）与 run 内可用的单调信息。
    for (const beat of beats) {
      assert.ok(Number.isInteger(beat.pgid) && beat.pgid > 0, `heartbeat 缺 pgid：${JSON.stringify(beat)}`);
      assert.ok(Number.isFinite(beat.elapsed_ms), `heartbeat 缺 elapsed_ms：${JSON.stringify(beat)}`);
    }
    // 间隔红线：≤60s（工单「≤60s，建议 30s」）。这里用注入值，默认值另有专门用例。
    assert.ok(resolveShellLivenessIntervalMs() <= 60_000, '默认保活间隔必须 ≤60s');
    assert.equal(resolveShellLivenessIntervalMs(), 30_000, '缺省保活间隔必须是 30s');
    // env 只允许下调，写坏/放宽到 60s 以上一律钳回 60s 以内。
    assert.equal(resolveShellLivenessIntervalMs({ ERIX_SHELL_LIVENESS_MS: '5000' }), 5_000);
    assert.equal(resolveShellLivenessIntervalMs({ ERIX_SHELL_LIVENESS_MS: '600000' }), 30_000,
      '写到上限外必须回落默认 30s（所以「放宽到 >60s」这条路根本不成立）');
    assert.equal(resolveShellLivenessIntervalMs({ ERIX_SHELL_LIVENESS_MS: 'junk' }), 30_000);
  }));

test('#288① 红线：启用保活与不启用保活，工具返回正文逐字节相同（时长行除外）', () =>
  withTempRoot(async (root) => {
    const command = 'echo A-288; printf "line2\\n"; echo B-288 1>&2';
    // 同一命令各跑 3 次（带/不带 liveness 交替），逐字节比对；`duration_ms` 是必然变化的计时行，先抹掉。
    const stripDur = (text) => text.replace(/^duration_ms: \d+$/m, 'duration_ms:<n>');
    const bare = createShellTools({ worktreeRoot: root });
    const livenessTools = createShellTools({ worktreeRoot: root, liveness: { heartbeatIntervalMs: 50, onEvent: () => {} } });
    const without = [];
    const withLiveness = [];
    for (let i = 0; i < 3; i += 1) {
      without.push(stripDur(await bare.executors.shell({ command })));
      withLiveness.push(stripDur(await livenessTools.executors.shell({ command })));
    }
    for (const [i, text] of without.entries()) {
      assert.equal(withLiveness[i], text, `第 ${i + 1} 次：启用保活改变了模型看到的工具返回正文`);
      assert.match(text, /^exit_code: 0\nduration_ms:<n>\ntruncated: false\nA-288\nline2\nB-288\n?$/);
    }
    // 保活本身不得往模型可见文本里塞任何字样（"heartbeat"/"liveness" 之类的漏字）。
    assert.doesNotMatch(withLiveness[0], /heartbeat|liveness|pgid/i, '保活字样漏进了工具返回正文');
  }));

test('#288① 不接 liveness 时零行为变化（既有调用方/单测路径不变）', () =>
  withTempRoot(async (root) => {
    const tools = createShellTools({ worktreeRoot: root });
    const out = await tools.executors.shell({ command: 'echo legacy-path' });
    assert.match(out, /^exit_code: 0\n/);
    assert.match(out, /legacy-path/);
  }));

test('#288① 保活定时器不得拖住事件循环（unref：与「abort 后不留存活定时器」同口径）', () =>
  withTempRoot(async (root) => {
    if (typeof process.getActiveResourcesInfo !== 'function') return; // 无探针则本例无意义（不是跳过判据）
    // 45s 的命令 + 5s 心跳：命令一结束，本工具持有的 Timeout 必须回到基线（含心跳定时器）。
    const sink = collectLiveness(5_000);
    const tools = createShellTools({ worktreeRoot: root, liveness: sink.liveness });
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await tools.executors.shell({ command: 'echo quick', timeout_ms: 45_000 });
    await new Promise((resolve) => setImmediate(resolve));
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    assert.ok(after <= before, `命令结束后仍有存活 Timeout：before=${before} after=${after}`);
  }));

// ---------------------------------------------------------------------------
// ② pgid 上报与收敛（worker 侧上报 + agentd 侧账本）
// ---------------------------------------------------------------------------

test('#288② spawn 上报 pgid、命令退出后清空：agentd 登记集合进出都收敛', () =>
  withTempRoot(async (root) => {
    const ctx = makeFakeCtx({ lastIpcAt: 1 });
    const sink = collectLiveness(50);
    const tools = createShellTools({ worktreeRoot: root, liveness: sink.liveness });
    const out = await tools.executors.shell({ command: 'echo in-flight' });
    assert.match(out, /in-flight/);

    const spawns = sink.phases('spawn');
    const exits = sink.phases('exit');
    assert.equal(spawns.length, 1, `spawn 必须恰好一条：${JSON.stringify(spawns)}`);
    assert.equal(exits.length, 1, `exit 必须恰好一条：${JSON.stringify(exits)}`);
    assert.equal(spawns[0].pgid, exits[0].pgid, 'exit 必须回报同一个 pgid');

    // worker 报的东西直接喂 agentd 的账本（同一条 IPC 消息形态）。
    for (const ev of sink.events) {
      applyShellLiveness(ctx, { phase: ev.phase, pgid: ev.pgid, command: ev.command });
    }
    assert.equal(ctx.shellPgids.size, 0, `命令已退出但登记集合没清空：${[...ctx.shellPgids]}`);
  }));

test('#288② pgid 就是子命令的进程组组长 pid（detached ⇒ 负 pid 能整组杀的前提）', () =>
  withTempRoot(async (root) => {
    const sink = collectLiveness(0);
    const tools = createShellTools({ worktreeRoot: root, liveness: sink.liveness });
    // `$$` = bash 自己的 pid；detached:true ⇒ bash 是新进程组的组长 ⇒ pgid === 它的 pid === child.pid。
    const out = await tools.executors.shell({ command: 'echo pgid-check $$' });
    const reported = sink.phases('spawn')[0].pgid;
    const shellPid = Number(out.match(/pgid-check (\d+)/)[1]);
    assert.equal(reported, shellPid, `上报的 pgid(${reported}) 必须等于子命令 pid(${shellPid})`);
  }));

test('#288② agentd 账本：spawn 登记 / exit 销登记 / 同 attempt 多次调用全登记 / 无 pgid 不炸', () => {
  const ctx = makeFakeCtx({ lastIpcAt: 1 });
  assert.equal(applyShellLiveness(ctx, { phase: 'spawn', pgid: 9001 }), 'spawn');
  assert.equal(applyShellLiveness(ctx, { phase: 'spawn', pgid: 9002 }), 'spawn');
  assert.deepEqual([...ctx.shellPgids], [9001, 9002], '同一次 attempt 内多次 shell 调用必须全部登记');
  assert.equal(applyShellLiveness(ctx, { phase: 'exit', pgid: 9001 }), 'exit');
  assert.deepEqual([...ctx.shellPgids], [9002]);
  // 重复 spawn 幂等（Set 语义），未知 pgid 的 exit 不炸。
  assert.equal(applyShellLiveness(ctx, { phase: 'spawn', pgid: 9002 }), 'spawn');
  assert.equal(applyShellLiveness(ctx, { phase: 'exit', pgid: 7777 }), 'exit');
  assert.deepEqual([...ctx.shellPgids], [9002]);
  // 字段不合法（缺 pgid / 非整数 / 未知 phase）⇒ 记 ignored，不得污染账本。
  assert.equal(applyShellLiveness(ctx, { phase: 'spawn' }), 'ignored');
  assert.equal(applyShellLiveness(ctx, { phase: 'spawn', pgid: 'NaN' }), 'ignored');
  assert.equal(applyShellLiveness(ctx, { phase: 'bogus', pgid: 1 }), 'ignored');
  assert.deepEqual([...ctx.shellPgids], [9002]);
});

test('#288② 保活到达就刷 lastIpcAt（这是 watchdog 唯一看得见的东西）', () => {
  const ctx = makeFakeCtx({ lastIpcAt: 1_000 });
  let now = 500_000;
  assert.equal(applyShellLiveness(ctx, { phase: 'heartbeat', pgid: 4242 }, { now: () => now }), 'heartbeat');
  assert.equal(ctx.lastIpcAt, 500_000, 'heartbeat 必须把静默计时归零');
  // 心跳**不得**动 pgid 账本（命令还没结束）。
  assert.equal(ctx.shellPgids.size, 0);
});

test('#288② 红线：保活消息不得变成 run_events / U3 事件（源码级双向钉）', () => {
  // worker 侧：SHELL_LIVENESS 只能走 sendIpc，不得走 emitEvent（后者会落 run_events）。
  const workerSrc = fs.readFileSync(path.join(HERE, '..', 'worker.js'), 'utf8');
  const block = workerSrc.match(/const shellTools = createShellTools\(\{[\s\S]*?\n  \}\);/);
  assert.ok(block, 'worker.js 里 createShellTools({...}) 装配段形状变了（用例需同步）');
  assert.match(block[0], /MSG\.SHELL_LIVENESS/, '装配段必须发 MSG.SHELL_LIVENESS');
  assert.doesNotMatch(block[0], /emitEvent|makeEvent/, '保活不得走 emitEvent（会变成用户可见的 run_events）');

  // agentd 侧：SHELL_LIVENESS 分支内不得出现 enqueueEvent（不入库就不可能有历史/SSE 两种可见性问题）。
  const agentdSrc = fs.readFileSync(path.join(HERE, '..', 'agentd.js'), 'utf8');
  const caseBlock = agentdSrc.match(/case MSG\.SHELL_LIVENESS: \{[\s\S]*?\n    \}/);
  assert.ok(caseBlock, 'agentd.js 的 SHELL_LIVENESS 分支形状变了（用例需同步）');
  assert.doesNotMatch(caseBlock[0], /enqueueEvent/, '保活分支不得进事件队列');
  assert.match(agentdSrc, /ctx\.lastIpcAt = Date\.now\(\); \/\/ F6/, 'agentd 必须在任意 IPC 上刷 lastIpcAt（保活的承重墙）');
});

// ---------------------------------------------------------------------------
// ③ agentd 清理顺序：先杀 worker 组，再杀登记的每个 shell 子进程组
// ---------------------------------------------------------------------------

test('#288③ watchdog 路径（端到端：shell 真 spawn → liveness IPC → agentd 账本 → 巡检补杀）：先 -workerPid，再每个 -pgid，且真杀生效', async () =>
  withTempRoot(async (root) => {
    // 这一条是从 worker 侧一路串到 agentd 侧的，所以「摘掉 pgid 上报」会让它直接红（登记集永远为空）。
    const ctx = makeFakeCtx({ workerPid: 41001, lastIpcAt: 0 });
    const spy = makeKillSpy();
    // 假 workerPid 只记录不真杀；登记到的真 pgid 转发给真 `process.kill`（验「真的杀到了」）。
    const kill = (pid, sig) => {
      spy.kill(pid, sig);
      if (pid < 0 && pid !== -ctx.workerPid) { try { process.kill(pid, sig); } catch {} }
    };
    const tools = createShellTools({
      worktreeRoot: root,
      // 与 worker.js 的接线同构：liveness 事件 → applyShellLiveness（中间那一跳是真 IPC，单测里直接喂）。
      liveness: { heartbeatIntervalMs: 0, onEvent: (ev) => applyShellLiveness(ctx, { phase: ev.phase, pgid: ev.pgid, command: ev.command }) },
    });
    const startedAt = Date.now();
    const running = tools.executors.shell({ command: 'sleep 6.288', timeout_ms: 20_000 });
    for (let i = 0; i < 200 && ctx.shellPgids.size === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pgids = [...ctx.shellPgids];
    assert.deepEqual(pgids.length, 1, `等不到 pgid 上报（保活/登记链路断了）：${JSON.stringify(pgids)}`);

    const killed = sweepWatchdog({
      runs: [ctx], now: Date.now() + 10 * 60_000, watchdogMs: 300_000,
      kill, refreshActivity: () => {}, logImpl: () => {},
    });
    assert.deepEqual(killed.map((k) => k.run_id), [RUN_ID]);
    assert.deepEqual(spy.calls, [
      [-41001, 'SIGKILL'],
      [-pgids[0], 'SIGKILL'],
    ], `杀进程顺序必须「先 worker 组、再 shell 组」：${JSON.stringify(spy.calls)}`);
    assert.equal(ctx.shellPgids.size, 0, '登记集必须随 attempt 结束清空');

    // 真杀生效：6.288s 的命令必须立刻返回（而不是跑满），且 `exit_code: null`（被信号打断）。
    const out = await running;
    assert.ok(Date.now() - startedAt < 3_000, `补杀没生效：命令跑了 ${Date.now() - startedAt}ms`);
    assert.match(out, /^exit_code: null\n/, `被外部 SIGKILL 的命令应成 exit_code: null：${out}`);
  }));

test('#288③ 多组 + 顺序：登记的每个 pgid 都被杀，一个不漏；活动戳照旧刷', () => {
  const spy = makeKillSpy();
  const ctx = makeFakeCtx({ workerPid: 5001, shellPgids: [5002, 5003, 5004], lastIpcAt: 0 });
  const touched = [];
  sweepWatchdog({ runs: [ctx], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill, refreshActivity: (c) => touched.push(c.runId), logImpl: () => {} });
  assert.deepEqual(touched, [RUN_ID], '巡检必须继续刷 run 数据目录活动戳（#64 既有行为不得回退，与是否判死无关）');
  assert.deepEqual(spy.calls, [[-5001, 'SIGKILL'], [-5002, 'SIGKILL'], [-5003, 'SIGKILL'], [-5004, 'SIGKILL']]);
  // 顺序反了（先 shell 组后 worker 组）就是红——拿一个手写反序的序列与上面的真实序列比对。
  assert.notDeepEqual(spy.calls, [[-5002, 'SIGKILL'], [-5003, 'SIGKILL'], [-5004, 'SIGKILL'], [-5001, 'SIGKILL']]);
});

test('#288③ 活动戳抛错不得挡住判死与补杀（既有 try/catch 口径不变）', () => {
  const spy = makeKillSpy();
  const ctx = makeFakeCtx({ workerPid: 5101, shellPgids: [5102], lastIpcAt: 0 });
  const logs = [];
  const killed = sweepWatchdog({
    runs: [ctx], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill,
    refreshActivity: () => { throw new Error('EACCES'); }, logImpl: (level, msg) => logs.push([level, msg]),
  });
  assert.equal(killed.length, 1);
  assert.ok(logs.some(([, msg]) => msg === 'run data activity refresh failed'));
  assert.deepEqual(spy.calls, [[-5101, 'SIGKILL'], [-5102, 'SIGKILL']]);
});

test('#288③ 没登记 shell 组时 watchdog 只杀 worker 组（不得凭空闲杀一个 0/-0 组）', () => {
  const spy = makeKillSpy();
  const ctx = makeFakeCtx({ workerPid: 42001, shellPgids: [], lastIpcAt: 0 });
  sweepWatchdog({ runs: [ctx], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill, refreshActivity: () => {}, logImpl: () => {} });
  assert.deepEqual(spy.calls, [[-42001, 'SIGKILL']]);
});

test('#288③ 一个 shell 组杀不掉（ESRCH）不得挡住后面的组，也不得挡住巡检本身', () => {
  const spy = makeKillSpy({ throwOn: (pid) => pid === -43002 });
  const ctx = makeFakeCtx({ workerPid: 43001, shellPgids: [43002, 43003, 43004], lastIpcAt: 0 });
  const logs = [];
  const killed = sweepWatchdog({
    runs: [ctx], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill,
    refreshActivity: () => {}, logImpl: (level, msg) => logs.push([level, msg]),
  });
  assert.equal(killed.length, 1);
  assert.deepEqual(spy.calls.map(([pid]) => pid), [-43001, -43002, -43003, -43004], 'ESRCH 之后必须继续杀剩下的组');
  assert.ok(logs.some(([level, msg]) => level === 'warn' && msg.includes('kill failed')), '杀失败要留痕');
});

test('#288③ 未超阈值的 ctx 一个都不杀（正常长 LLM 等待不误伤）', () => {
  const spy = makeKillSpy();
  const now = 1_000_000;
  const ctx = makeFakeCtx({ workerPid: 44001, shellPgids: [44002], lastIpcAt: now - 30_000 });
  const killed = sweepWatchdog({ runs: [ctx], now, watchdogMs: 300_000, kill: spy.kill, refreshActivity: () => {}, logImpl: () => {} });
  assert.deepEqual(killed, []);
  assert.deepEqual(spy.calls, []);
});

test('#288③ 正在收尾（finishing）或已无 worker 的 ctx 照旧跳过', () => {
  const spy = makeKillSpy();
  const finishing = makeFakeCtx({ runId: 'r-finishing', workerPid: 45001, shellPgids: [45002], lastIpcAt: 0 });
  finishing.finishing = true;
  const noWorker = makeFakeCtx({ runId: 'r-noworker', workerPid: 45003, shellPgids: [45004], lastIpcAt: 0 });
  noWorker.worker = null;
  const killed = sweepWatchdog({
    runs: [finishing, noWorker], now: 10_000_000, watchdogMs: 300_000, kill: spy.kill, refreshActivity: () => {}, logImpl: () => {},
  });
  assert.deepEqual(killed, []);
  assert.deepEqual(spy.calls, [], '跳过判据失效会重复杀（PID 复用风险）');
});

test('#288③ 真进程：agentd 的补杀真的能让 detached 的常驻子进程消失（负 pid 整组语义）', async () => {
  // 复刻 dev 真机的形状：一个 `sleep` 子进程**不在** agentd 测试进程的组里（detached 自成一族），
  // 只有 `process.kill(-pgid)` 能杀到它；单杀「父」是杀不到的。
  const child = spawn('bash', ['-c', 'sleep 30.288'], { detached: true, stdio: 'ignore' });
  const pgid = child.pid;
  child.unref();
  try {
    // 先证明「它真的自成一族」：本进程 kill(pgid) 打得到它，但按「组」杀才是本单的修法。
    const alive = () => { try { process.kill(pgid, 0); return true; } catch { return false; } };
    assert.equal(alive(), true, '子进程没起来，用例无意义');
    const ctx = makeFakeCtx({ workerPid: 999_998, shellPgids: [pgid], lastIpcAt: 0 });
    const killed = killShellChildGroups(ctx, { logImpl: () => {} });
    assert.deepEqual(killed, [pgid]);
    // SIGKILL 是同步投递的：稍等一次事件循环，探针必须 ESRCH。
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(alive(), false, `补杀没生效：pgid ${pgid} 还在`);
  } finally {
    try { process.kill(-pgid, 'SIGKILL'); } catch {}
    try { child.kill('SIGKILL'); } catch {}
  }
});

// ---------------------------------------------------------------------------
// ④ SIGKILL 前提：清理不得依赖 worker 的 `process.on('exit')`
// ---------------------------------------------------------------------------

test('#288④ 前提（能红的）：SIGKILL 下 process.on("exit") 根本不跑 ⇒ 清理必须在 agentd 侧', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erix-288-sigkill-'));
  try {
    const exitMarker = path.join(root, 'normal-exit-ran');
    const startedMarker = path.join(root, 'started');
    const script = `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(startedMarker)}, 'up');
      process.on('exit', () => { try { fs.writeFileSync(${JSON.stringify(exitMarker)}, 'ran'); } catch {} });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
    child.unref();
    // 等它真的起来了（否则「没有 marker」可能只是「还没跑」）。
    for (let i = 0; i < 200 && !fs.existsSync(startedMarker); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(startedMarker), '子进程没起来，用例无意义');

    process.kill(child.pid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fs.existsSync(exitMarker), false,
      'SIGKILL 后 exit handler 竟然跑了 ⇒ 本单「清理不能挂在 worker exit 上」的前提需要重新论证');
    // 对照组：同一脚本**自己正常退出**时 handler 会跑 ⇒ 上面那条「没跑」是 SIGKILL 的性质，
    // 不是脚本写坏了（没这条对照，「handler 不跑」可能只是用例自己塑的）。
    const control = spawn(process.execPath, ['-e', `${script}
      setTimeout(() => process.exit(0), 60);`], { detached: true, stdio: 'ignore' });
    control.unref();
    for (let i = 0; i < 200 && !fs.existsSync(path.join(root, 'normal-exit-ran')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(fs.existsSync(path.join(root, 'normal-exit-ran')),
      '正常退出的对照组不跑 handler ⇒ 用例本身失效（不能拿它当 SIGKILL 的证据）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 启动不变式（缺陷 A 的配置侧）：watchdogMs < shellMax ⇒ warn，且**不**自动抬高
// ---------------------------------------------------------------------------

test('#288 启动不变式：watchdog < shell 上限 ⇒ 一条 warn 点名两个数值与心跳依赖，且不改 watchdogMs', () => {
  const logs = [];
  const logImpl = (level, msg, extra) => logs.push({ level, msg, extra });
  const cfg = { watchdogMs: 300_000 };

  const warned = warnIfWatchdogBelowShellMax({ watchdogMs: cfg.watchdogMs, shellMaxTimeoutMs: 600_000, logImpl });
  assert.equal(warned, true, '默认形态（300s < 600s）必须 warn');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  const text = JSON.stringify(logs[0]);
  assert.match(text, /300000/, 'warn 必须打印 watchdog 阈值数值');
  assert.match(text, /600000/, 'warn 必须打印 shell 超时上限数值');
  assert.match(text, /心跳|保活/, 'warn 必须点名「依赖 shell 心跳保活」');
  assert.match(text, /失效/, 'warn 必须点名「心跳通道失效时仍会误杀」');
  // 红线：不得自动抬高（抬高会同时拖长「worker 真死」的发现时间）。
  assert.equal(cfg.watchdogMs, 300_000, '启动不变式只能 warn，不许把 watchdogMs 改掉');
});

test('#288 启动不变式：watchdog ≥ shell 上限 ⇒ 零 warn（放宽 env 的用户不该被噪音骂）', () => {
  const logs = [];
  const warned = warnIfWatchdogBelowShellMax({
    watchdogMs: 900_000, shellMaxTimeoutMs: resolveShellMaxTimeoutMs({}), logImpl: (level, msg, extra) => logs.push({ level, msg, extra }),
  });
  assert.equal(warned, false);
  assert.deepEqual(logs, []);
  // 两个数值同源同口径：agentd 与 worker 读的必须是同一套解析（同一 env 名 + 同一钳制）。
  assert.equal(resolveShellMaxTimeoutMs({ ERIX_SHELL_MAX_TIMEOUT_MS: '120000' }), 120_000);
  assert.equal(resolveShellMaxTimeoutMs({ ERIX_SHELL_MAX_TIMEOUT_MS: 'junk' }), 600_000);
  assert.equal(resolveShellMaxTimeoutMs(), resolveShellMaxTimeoutMs(process.env), '缺省必须读 process.env');
});

test('#288 M1 接线：agentd 启动路径真的调了不变式检查，且心跳消息进了 agentd 的账本', () => {
  const agentdSrc = fs.readFileSync(path.join(HERE, '..', 'agentd.js'), 'utf8');
  assert.match(agentdSrc, /warnIfWatchdogBelowShellMax\(\);/, 'main() 里必须挂上启动不变式检查');
  assert.match(agentdSrc, /sweepWatchdog\(\{ now: Date\.now\(\) \}\);/, 'heartbeatLoop 必须走抽出来的巡检（行为与内联版等价）');
  assert.match(agentdSrc, /MSG\.SHELL_LIVENESS:[\s\S]*applyShellLiveness\(ctx, msg\)/, '心跳消息必须落到 applyShellLiveness');
  assert.match(agentdSrc, /killShellChildGroups\(ctx\)/, '终止路径必须补杀 shell 子进程组');
});
