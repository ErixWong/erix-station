// run 数据目录生命周期（issue #46，选项 A）：notes 等 logical-run 作用域数据的落点。
// <home>/runs/<runId>/notes/ —— 跨 attempt 保留（resume 可读前序 attempt 的 notes），
// 与 worktree 生命周期完全解耦（worktree 照旧随 run 回收，不再连带 notes）。
// 抽成独立模块：agentd.js 导入即用的同时可被单测直接驱动（agentd.js 顶层有 main() 副作用）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function runDataDir(home, runId) {
  return path.join(home, 'runs', String(runId));
}

// claim 后、fork 前备好目录（0775 & umask 0002，worker UID 1002 同 GID 组可写）。
export function prepareRunDataDir(home, runId) {
  const dir = runDataDir(home, runId);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true, mode: 0o775 });
  return dir;
}

// 终态清理（best-effort）：失败只告警——目录残留由下次 agentd 启动 sweep 兜底
// （见 sweepRunDataDir；attempt 间绝不走这条路径）。
// 权限注意：file store 写入时会把 notes 目录树 chmod 0700/文件 0600（属主 = worker UID 1002），
// agentd（1001）直删会 EACCES——直删失败后改用 fork worker 同款 uid/gid 起一次性 helper 删
// （agentd 持 SETUID/SETGID ambient caps，entrypoint §M5）；本地同 UID 开发环境直删即可成功。
export function cleanupRunData({ home, runId, workerUid, workerGid, log }) {
  const dir = runDataDir(home, runId);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 落入 worker-uid helper 兜底
  }
  try {
    const r = spawnSync(
      process.execPath,
      ['-e', "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });", dir],
      { uid: workerUid, gid: workerGid, stdio: 'ignore', timeout: 10000 },
    );
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`cleanup helper exit code ${r.status}`);
  } catch (err) {
    log('warn', 'run data cleanup failed, left for startup sweep', { run_id: runId, err: String(err?.message ?? err) });
  }
}

/**
 * 启动清扫：上次运行残留的 run 数据目录（终态清理失败/异常退出遗留）。
 *
 * ⚠️ race 推导（评审 HIGH 修正）：启动时 state.runs 必为空（本函数先于 claimLoop 调用），
 * 因此**不能**用「不在活跃集」当删除判据——崩溃恢复场景 attempt1 worker 崩溃 → portal
 * re-claim 同一 run（resume=true，notes 全在 run 数据目录里）→ 恰好赶在 agentd 重启之后、
 * 新 attempt claim 之前被 sweep 删光，选项 A 要保的跨 attempt 语义被启动清扫自己破坏。
 * 故只删「mtime 超过保留期」的目录：崩溃后 resume re-claim 必然在分钟级窗口内发生，
 * 目录 mtime 新鲜（prepareRunDataDir / worker 写 notes 都会刷新），不会误删；真正的残留
 * （终态清理失败/异常退出）在保留期内无人再碰，mtime 过期后安全清除。
 *
 * @param {{home:string, ttlHours:number, workerUid:number, workerGid:number, log:Function}} options
 *   ttlHours：保留期（小时）；<= 0 表示禁用清扫（一律保留，纯人工/运维兜底）。
 */
export function sweepRunDataDir({ home, ttlHours, workerUid, workerGid, log }) {
  if (!(ttlHours > 0)) return; // 0/负数/NaN = 禁用清扫
  const root = path.join(home, 'runs');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // 目录不存在（首跑）
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const { mtimeMs } = fs.statSync(dir);
      // 新鲜目录一律保留：可能是崩溃后待 resume re-claim 的 run（见上 race 推导）
      if (now - mtimeMs <= ttlMs) continue;
    } catch {
      continue; // stat 失败（竞争删除等）——本次不动它
    }
    // 复用 cleanupRunData：worker-uid helper 兜底 0700 属主目录（见该函数注释）
    const before = fs.existsSync(dir);
    cleanupRunData({ home, runId: entry.name, workerUid, workerGid, log });
    if (before && !fs.existsSync(dir)) {
      log('info', 'swept stale run data dir', { run_id: entry.name, ttl_hours: ttlHours });
    }
  }
}
