import test from 'node:test';
import assert from 'node:assert/strict';
import { drainRuns } from '../lib/drain.js';

/** 造一个「可控退出」的 ctx：resolve exit() 即模拟 worker 退出（onWorkerExit 置 workerPid=null）。 */
function makeCtx({ pid = 1000, autoExitMs = null } = {}) {
  const ctx = { workerPid: pid };
  let resolveExit;
  ctx.exited = new Promise((r) => { resolveExit = r; });
  ctx.exit = () => { ctx.workerPid = null; resolveExit(); };
  if (autoExitMs != null) setTimeout(() => ctx.exit(), autoExitMs);
  return ctx;
}

test('drain：无在跑 worker → 立即 drained', async () => {
  const r = await drainRuns([], { deadlineMs: 10 });
  assert.deepEqual(r, { drained: true, killed: 0, pending: 0, waitedMs: 0 });
});

test('drain：worker 及时退出 → drained，不 kill', async () => {
  const killed = [];
  const r = await drainRuns([makeCtx({ autoExitMs: 5 })], {
    deadlineMs: 200, kill: (pid) => killed.push(pid),
  });
  assert.equal(r.drained, true);
  assert.equal(r.killed, 0);
  assert.deepEqual(killed, [], '按时退出不得强杀');
});

test('drain：worker 挂住 → 到 deadline 强杀，杀后退出则 drained', async () => {
  const killed = [];
  const ctx = makeCtx({ pid: 4242 });
  const r = await drainRuns([ctx], {
    deadlineMs: 20,
    killGraceMs: 100,
    kill: (pid) => { killed.push(pid); ctx.exit(); }, // 杀即退出
  });
  assert.deepEqual(killed, [4242], '必须在 deadline 后强杀');
  assert.equal(r.drained, true);
  assert.equal(r.killed, 1);
});

test('drain：强杀后仍不退出 → 如实报告 pending=false（D 状态进程）', async () => {
  const logs = [];
  const r = await drainRuns([makeCtx({ pid: 7 })], {
    deadlineMs: 10,
    killGraceMs: 15,
    kill: () => {},
    log: (msg) => logs.push(msg),
  });
  assert.equal(r.drained, false);
  assert.equal(r.pending, 1);
  assert.ok(logs.some((m) => m.includes('drain incomplete')), '杀不掉必须告警（不静默）');
});

test('drain：多个 worker 部分退出 → 只强杀存活者', async () => {
  const killed = [];
  const fast = makeCtx({ pid: 1, autoExitMs: 5 });
  const slow = makeCtx({ pid: 2 });
  const r = await drainRuns([fast, slow], {
    deadlineMs: 30, killGraceMs: 50, kill: (pid) => { killed.push(pid); slow.exit(); },
  });
  assert.deepEqual(killed, [2], '只杀未退出的那个');
  assert.equal(r.drained, true);
});
