/**
 * revoke / shutdown 收敛 drain（审计 #34 F-A，major）。
 *
 * 问题：`beginRevoke` 只是「发 IPC abort + 安排 5s 后 SIGKILL」，而 agentd 的主循环返回后
 * 立即 `process.exit(0)`——于是：① SIGKILL 兜底 timer 随进程消失 → 挂住的 worker 进程组残留；
 * ② `onWorkerExit` 不跑 → `cleanupRun` 不跑 → capacity 不释放、run 数据目录残留
 * （D8 修订 2026-09-24 后项目目录是用户资产，本就无 worktree 清理义务）。
 *
 * 本模块把「等 worker 真退出（带 deadline 强杀）」抽成可注入、可单测的纯逻辑：
 *   1. 等全部在跑 worker exit（deadlineMs，默认 8s = abort 的 5s 宽限 + 余量）
 *   2. 仍未退出 → 注入的 kill（agentd 传 killProcessGroup，按进程组 SIGKILL）
 *      ⚠️ 必须显式传 'SIGKILL'（评审 B 实测：不传信号时 process.kill 默认 SIGTERM，与「强杀」语义不符）
 *   3. 再等 killGraceMs（默认 2s）→ 仍不退出则如实报告 pending（D 状态的进程杀不掉，记日志）
 *
 * 判定「已退出」的契约：ctx.workerPid 由 onWorkerExit 置 null（agentd 现有行为）。
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等一批 ctx 的 exited promise 全部落定，或到 ms 超时。 */
function waitAllOrTimeout(list, ms) {
  if (list.length === 0) return Promise.resolve('done');
  const all = Promise.all(list.map((c) => c.exited ?? Promise.resolve()));
  if (!(ms > 0)) return all.then(() => 'done');
  return Promise.race([all.then(() => 'done'), sleep(ms).then(() => 'timeout')]);
}

/**
 * @param {Iterable<object>} ctxs 在跑 run 的 ctx（需含 workerPid 与 exited）
 * @param {{deadlineMs?:number, killGraceMs?:number, kill?:(pid:number, signal:string)=>void, log?:(msg:string, extra?:object)=>void}} [opts]
 * @returns {Promise<{drained:boolean, killed:number, pending:number, waitedMs:number}>}
 */
export async function drainRuns(ctxs, {
  deadlineMs = 8000,
  killGraceMs = 2000,
  kill = () => {},
  log = () => {},
} = {}) {
  const started = Date.now();
  const snapshot = [...ctxs].filter((c) => c && c.workerPid);
  const done = (killed = 0) => {
    const left = snapshot.filter((c) => c.workerPid);
    return { drained: left.length === 0, killed, pending: left.length, waitedMs: Date.now() - started };
  };
  if (snapshot.length === 0) return { drained: true, killed: 0, pending: 0, waitedMs: 0 };

  await waitAllOrTimeout(snapshot, deadlineMs);
  let left = snapshot.filter((c) => c.workerPid);
  if (left.length === 0) return done();

  log('drain deadline reached; killing leftover workers', { count: left.length, deadline_ms: deadlineMs });
  let killed = 0;
  for (const ctx of left) {
    if (!ctx.workerPid) continue;
    try { kill(ctx.workerPid, 'SIGKILL'); killed += 1; } catch { /* 进程已消失 */ }
  }
  await waitAllOrTimeout(left, killGraceMs);
  const result = done(killed);
  if (!result.drained) {
    log('drain incomplete; workers survived SIGKILL', { pending: result.pending });
  }
  return result;
}
