// run 数据目录生命周期（issue #46 选项 A + issue #64 R1 配套归档修正，conversation-state.md §5 P1）：
// notes 等 logical-run 作用域数据的落点，两层目录、两种语义：
//
//   <home>/runs/<runId>/         活跃层：claim 后创建（0775 & umask 0002，worker UID 1002 同 GID 组可写），
//                                跨 attempt 保留（resume 可读前序 attempt 的 notes）。崩溃/异常退出残留
//                                由启动 sweep 按 mtime 保留期（ERIX_RUN_DATA_TTL_HOURS，默认 24h）物理清除
//                                ——残留从未到达终态，不是会话真相层。
//   <home>/runs-archive/<runId>/ 归档层：终态确认后由 archiveRunData 从 runs/ 整体**移入**（同盘 rename
//                                原子；跨设备 EXDEV 时递归复制后删源）。transcript/notes 等会话真相
//                                （conversation-state.md：真相层 append-only + 归档 TTL）物理保留，
//                                仅当 mtime 超过归档 TTL（ERIX_ARCHIVE_TTL_HOURS，默认 168h=7 天，
//                                0=禁用清扫）才由 sweep 物理删除。
//
// worktree 生命周期不变（D8 执行隔离物，照旧随 run 回收）；终态产物（issue #64 R1）由 agentd 在
// archiveRunData 之前捕获上传（runner/lib/artifacts.js），归档不拦截产物回收。
// 抽成独立模块：agentd.js 导入即用的同时可被单测直接驱动（agentd.js 顶层有 main() 副作用）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function runDataDir(home, runId) {
  return path.join(home, 'runs', String(runId));
}

export function runArchiveDir(home, runId) {
  return path.join(home, 'runs-archive', String(runId));
}

// claim 后、fork 前备好目录（0775 & umask 0002，worker UID 1002 同 GID 组可写）。
export function prepareRunDataDir(home, runId) {
  const dir = runDataDir(home, runId);
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true, mode: 0o775 });
  return dir;
}

// ---------------------------------------------------------------------------
// 目录移动 / 删除原语
// ---------------------------------------------------------------------------

/**
 * 移动目录：同盘 rename（原子）；跨设备（EXDEV）递归复制后删源。
 * fsImpl 可注入（测试用：mock renameSync 抛 EXDEV 验证复制兜底路径）。
 */
export function moveDir(src, dest, fsImpl = fs) {
  try {
    fsImpl.renameSync(src, dest);
    return;
  } catch (err) {
    if (err?.code !== 'EXDEV') throw err;
  }
  fsImpl.cpSync(src, dest, { recursive: true });
  fsImpl.rmSync(src, { recursive: true, force: true });
}

// worker-uid helper：file store 写入时会把 notes 目录树 chmod 0700/文件 0600（属主 = worker UID 1002），
// agentd（1001）直删/直读会 EACCES——改用 fork worker 同款 uid/gid 起一次性 helper
// （agentd 持 SETUID/SETGID ambient caps，entrypoint §M5）；本地同 UID 开发环境直删即可成功。
function runAsWorker(script, args, { workerUid, workerGid }) {
  const r = spawnSync(process.execPath, ['-e', script, ...args], {
    uid: workerUid, gid: workerGid, stdio: 'ignore', timeout: 20000,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`worker-uid helper exit code ${r.status}`);
}

const REMOVE_HELPER = "require('node:fs').rmSync(process.argv[1], { recursive: true, force: true });";

// 归档 helper：mkdir archiveRoot → 清同名旧归档 → rename（EXDEV 复制兜底）→ mtime 刷新为归档时刻。
// 与 archiveRunData 直走路径语义逐行对应，改动需双侧同步。
const ARCHIVE_HELPER = `
const fs = require('node:fs');
const [src, dst, root] = process.argv.slice(1);
fs.mkdirSync(root, { recursive: true });
try { fs.rmSync(dst, { recursive: true, force: true }); } catch {}
try { fs.renameSync(src, dst); }
catch (e) {
  if (e.code !== 'EXDEV') throw e;
  fs.cpSync(src, dst, { recursive: true });
  fs.rmSync(src, { recursive: true, force: true });
}
try { const t = new Date(); fs.utimesSync(dst, t, t); } catch {}
`;

// 物理删除目录（sweep 用）：直删失败后 worker-uid helper 兜底（见上权限注意）。
function removeDir(dir, { workerUid, workerGid }) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 落入 worker-uid helper 兜底
  }
  runAsWorker(REMOVE_HELPER, [dir], { workerUid, workerGid });
}

// ---------------------------------------------------------------------------
// 终态归档（best-effort）：runs/<runId> → runs-archive/<runId>
// ---------------------------------------------------------------------------

/**
 * 终态确认后调用：run 数据目录**归档**而非物理删除（conversation-state.md §5 P1：transcript/notes
 * 是会话真相层，真相层归档 TTL 替代物理删除）。失败仅 warn 不阻断终态收敛——目录残留由下次
 * agentd 启动 sweep 兜底（见 sweepRunDataDir；attempt 间绝不走这条路径）。
 * moveFn 为测试接缝（mock EXDEV/失败路径），生产调用不传入。
 */
export function archiveRunData({ home, runId, workerUid, workerGid, log, moveFn }) {
  const dir = runDataDir(home, runId);
  if (!fs.existsSync(dir)) return;
  const archiveRoot = path.join(home, 'runs-archive');
  const dest = runArchiveDir(home, runId);
  const move = moveFn ?? ((src, dst) => moveDir(src, dst));
  try {
    fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o775 });
    // 同名旧归档（理论上 runId 唯一，防御异常残留）：先清再移，避免 rename 目标非空报错
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    move(dir, dest);
    // mtime 刷新为归档时刻：归档 TTL 从归档起算（否则长 run 的归档会「先天过期」被秒删）
    try { fs.utimesSync(dest, new Date(), new Date()); } catch { /* best-effort */ }
    return;
  } catch {
    // 落入 worker-uid helper 兜底（0700 属主目录，见 runAsWorker 权限注意）
  }
  try {
    runAsWorker(ARCHIVE_HELPER, [dir, dest, archiveRoot], { workerUid, workerGid });
  } catch (err) {
    log('warn', 'run data archive failed, left for startup sweep', { run_id: runId, err: String(err?.message ?? err) });
  }
}

// ---------------------------------------------------------------------------
// 启动清扫
// ---------------------------------------------------------------------------

/**
 * 启动清扫：上次运行残留的 run 数据目录（终态清理失败/异常退出遗留）+ 超归档 TTL 的归档目录。
 * 两个扫描各自以「不在活跃集」以外的 mtime 保留期为唯一删除判据，各自 TTL 独立开关（<= 0 禁用该扫描）。
 *
 * ⚠️ race 推导（评审 #46 HIGH 修正，runs/ 扫描）：启动时 state.runs 必为空（本函数先于 claimLoop
 * 调用），因此**不能**用「不在活跃集」当删除判据——崩溃恢复场景 attempt1 worker 崩溃 → portal
 * re-claim 同一 run（resume=true，notes 全在 run 数据目录里）→ 恰好赶在 agentd 重启之后、新 attempt
 * claim 之前被 sweep 删光，选项 A 要保的跨 attempt 语义被启动清扫自己破坏。故只删「mtime 超过保留期」
 * 的目录：崩溃后 resume re-claim 必然在分钟级窗口内发生，目录 mtime 新鲜（prepareRunDataDir /
 * worker 写 notes 都会刷新），不会误删；真正的残留（终态清理失败/异常退出）在保留期内无人再碰，
 * mtime 过期后安全清除。
 *
 * runs-archive/ 扫描无此 race：归档只发生在 U2 终态确认之后，终态 run 永不再被 claim
 * （claim 要求 status ∈ queued/running），归档目录不存在「待 resume re-claim」的合法读者；
 * mtime 检查仍是双保险（归档时 utimes 刷新为归档时刻，TTL 从归档起算）。
 *
 * @param {{home:string, ttlHours:number, archiveTtlHours:number, workerUid:number, workerGid:number, log:Function}} options
 *   ttlHours：runs/ 残留保留期（小时）；<= 0 禁用该扫描（一律保留，纯人工/运维兜底）。
 *   archiveTtlHours：runs-archive/ 归档保留期（小时）；<= 0 禁用该扫描。
 */
export function sweepRunDataDir({ home, ttlHours, archiveTtlHours, workerUid, workerGid, log }) {
  sweepDir({
    root: path.join(home, 'runs'),
    ttlHours,
    workerUid, workerGid, log,
    sweptMsg: 'swept stale run data dir',
  });
  sweepDir({
    root: path.join(home, 'runs-archive'),
    ttlHours: archiveTtlHours,
    workerUid, workerGid, log,
    sweptMsg: 'swept stale archived run data dir',
  });
}

function sweepDir({ root, ttlHours, workerUid, workerGid, log, sweptMsg }) {
  if (!(ttlHours > 0)) return; // 0/负数/NaN/undefined = 禁用该扫描
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // 目录不存在（首跑 / 尚无归档）
  }
  const ttlMs = ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const { mtimeMs } = fs.statSync(dir);
      // 新鲜目录一律保留：可能是崩溃后待 resume re-claim 的 run（runs/，见上 race 推导）
      if (now - mtimeMs <= ttlMs) continue;
    } catch {
      continue; // stat 失败（竞争删除等）——本次不动它
    }
    // worker-uid helper 兜底 0700 属主目录（见 runAsWorker 权限注意）
    const before = fs.existsSync(dir);
    try {
      removeDir(dir, { workerUid, workerGid });
    } catch {
      continue; // 删除失败（权限等）——本次不动它，下轮启动再试
    }
    if (before && !fs.existsSync(dir)) {
      log('info', sweptMsg, { run_id: entry.name, ttl_hours: ttlHours });
    }
  }
}
