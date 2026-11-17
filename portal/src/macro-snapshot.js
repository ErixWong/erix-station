// issue #537（事件平台 W4a：审查快照与隔离）——worktree 快照、内容级一致性校验、
// 失败门闸、孤儿清扫。本模块**只管快照与隔离**：不判决、不回灌（那是 W4b/W4c）。
//
// 为什么需要它：审查 run 要看的是**用户当时的未提交现场**，而 `git worktree add`
// 只会 checkout 已提交内容（HEAD）——未提交改动与未跟踪文件默认**看不见**。所以快照必须
// 显式把「已提交的 HEAD + 未提交的 diff + 未跟踪文件」三样一起搬进一个隔离的 worktree，
// 再把审查 agent 关进那个 worktree（只读、无 shell）。
//
// 搬运三步（对应任务 §①）：
//   git -C <repo> worktree add --detach <wt> HEAD        // 已提交内容
//   git -C <repo> diff HEAD --binary > <patch>           // 未提交的已跟踪改动
//   git -C <wt> apply <patch>                            //
//   git -C <repo> ls-files --others --exclude-standard -z | rsync -a --from0 --files-from=- <repo>/ <wt>/
//     // 未跟踪文件（rsync 缺失 ⇒ tar 回退，见 copyUntracked 注释）
//
// ⚠ **0 提交仓库（无 HEAD）不走上面三步**：`worktree add` 需要一个 commit 作基点，
//   `diff HEAD` 也无基线可 diff ⇒ 三行全挂（issue #670：真机上 0 提交是**多数情形**）。
//   无 HEAD 时改走**整树拷贝（含 `.git`）**，见 `copyWholeTree`。
//
// ⚠ worktree 必须落在 `~/projects/` **之外**，否则会被「收工灯」（在途工作树脏检查）
//   当成用户自己的脏文件统计进去。默认根见 `defaultSnapshotRoot`；`isUnderProjects` 是守卫。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** 单次快照（含一次搬运 + 校验，最多重试一次）的总时长上限；超 ⇒ `snapshot_timeout`。 */
export const SNAPSHOT_TIMEOUT_MS = 60_000;
/** 变更 + 未跟踪内容总量上限（字节），> ⇒ `snapshot_too_large`。 */
export const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
/** 变更文件数上限，> ⇒ `snapshot_too_large`。 */
export const MAX_CHANGED_FILES = 5000;
/** 快照根所在文件系统的最小可用空间（字节），< ⇒ `disk_low`。 */
export const MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024; // 2GB
/** 孤儿判定阈值：终态 > 1h 或 running > 1h ⇒ 视为可回收（含进程崩溃的残留）。 */
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

/**
 * ③ 失败门闸的全部 reason（任一失败都不启动审查）。契约常量：单测据此逐项锁定，
 * 新增/漏一个 reason 会红。`snapshot_root_in_projects` 是本站额外闸（worktree 必须
 * 在 `~/projects` 之外，否则污染收工灯），**不在任务的 7 个里**。
 *
 * `snapshot_copy_failed` 是 #670（0 提交仓库）新增的：**为什么不是既有的三个搬运 reason**——
 *   - 不是 `worktree_add_failed`：0 提交分支**根本没有 worktree**（无基点可 add），
 *     报它会把「git 结构问题」和「文件拷贝问题」混成一档，运维看 reason 分不开；
 *   - 不是 `untracked_copy_failed`：那条特指 `copyUntracked` 只搬未跟踪文件的那一步，
 *     整树拷贝搬的是**全部**（含 `.git` 与已跟踪内容），语义更宽、影响面不同；
 *   - 不是 `patch_apply_failed`：0 提交无基线，压根不产生 patch。
 * ⇒ 新失败模式需要一个自己的 reason（`macro-review` 按 `SNAPSHOT_FAILURE_REASONS.includes`
 *   分类，加进来才会被归成 `snapshot_failed:*` 而不是掉进 `llm_failed` 兼容分支）。
 */
export const SNAPSHOT_FAILURE_REASONS = Object.freeze([
  'worktree_add_failed',
  'patch_apply_failed',
  'untracked_copy_failed',
  'snapshot_copy_failed',
  'snapshot_unstable',
  'snapshot_timeout',
  'snapshot_too_large',
  'disk_low',
  'snapshot_root_in_projects',
]);

/** 整树拷贝的目标逃出了 `snapshotRoot` ⇒ 挂在 `err.code` 上（**不进 reason 表**：那是调用方
 *  传错 `id`/`snapshotRoot` 的编程错误，必须响亮地抛出去，不许被降级成可重试的软失败）。 */
export const SNAPSHOT_TARGET_ESCAPE = 'snapshot_target_escapes_root';

/** `macro_runs.status` 的终态集合（与 0035 的 CHECK 对齐；本模块**不 import macros.js**，
 *  以保持零第三方依赖——portal 测试只跑本文件，不能把 pg 拖进来）。 */
export const TERMINAL_MACRO_RUN_STATUSES = Object.freeze(['done', 'skipped', 'failed', 'superseded']);

/** 快照 worktree 的默认根：env `W4A_SNAPSHOT_ROOT` 优先，否则 `~/.erix/w4a-snapshots`。
 *  刻意选在 `~/.erix`（家目录里的平台目录），**与 `~/projects` 天然不同**，满足 §②「在 projects 之外」。 */
export function defaultSnapshotRoot() {
  const fromEnv = process.env.W4A_SNAPSHOT_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.erix', 'w4a-snapshots');
}

/** worktree 路径是否落在 `~/projects` 下（收工灯会把这些当成在途脏文件 ⇒ 必须为 false）。 */
export function isUnderProjects(candidate, home = os.homedir()) {
  const projects = path.resolve(home, 'projects');
  let resolved = path.resolve(candidate);
  // realpath 逐段解析到存在的祖先（worktree 目录可能尚未创建，realpath 直接调会 ENOENT）。
  try { resolved = fs.realpathSync(resolved); } catch { /* 不存在就用词法路径 */ }
  const rel = path.relative(projects, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// git / 进程执行原语
// ---------------------------------------------------------------------------

/**
 * git 的**全局选项**（放在子命令之前）。抽成纯函数是为了可测（见 `gitGlobalArgs()` 的用例）。
 *
 * `-c safe.directory=*`（issue #669）：portal 以 **root** 跑，而 FDE 项目目录属主是
 * 1000/1001 —— git ≥2.35 对「仓库属主 ≠ 当前用户」一律拒绝（CVE-2022-24765 的缓解），
 * 报 `detected dubious ownership in repository`。**这是部署常态，不是边角**：
 * 不加这一项，`createSnapshot` 里所有 git 调用（`rev-parse` / `status` / `diff` /
 * `worktree add`）在真机上全部失败 ⇒ M9 审查 100% 起不来。
 *
 * ⚠ 用 `-c` 而**不是** `git config --global --add safe.directory <path>`：
 * 后者往容器 `~/.gitconfig` 里**逐目录**累积，容器重建即丢、新目录永远漏；`-c` 每次显式带上，无状态。
 * 口径与 `gitlight.js:152`（D9 收工灯，同样跨 uid 读用户目录）一致。
 *
 * `--no-optional-locks`：只读探测不该去抢 index 锁（同 gitlight 的理由）。
 */
export function gitGlobalArgs() {
  return ['-c', 'safe.directory=*', '--no-optional-locks'];
}

/**
 * 跑 git，返回 stdout（utf8）。失败（非 0 退出）抛错。
 *
 * `stdio` 默认 **不传** ⇒ Node 的 execFileSync 默认**继承 stderr**（子进程的 `fatal:` 直接
 * 进 portal 日志）。对「**预期会失败**」的探测（如 `rev-parse --verify HEAD` 遇上 0 提交）
 * 这是污染：0 提交是多数情形（#670），每个快照都会漏几行看起来像故障的 `fatal:`。
 * 这类探测显式传 `stdio: ['ignore','pipe','pipe']`：stderr 被捕获（顺便让
 * `err.stderr` 有值，比继承时更好分类），也不再直接落盘。
 */
function git(args, { timeout, maxBuffer = 64 * 1024 * 1024, stdio } = {}) {
  return execFileSync('git', [...gitGlobalArgs(), ...args],
    { encoding: 'utf8', timeout, maxBuffer, ...(stdio ? { stdio } : {}) }).toString();
}

function sha256Text(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * 取 HEAD 的 commit sha；**0 提交仓库（尚无 HEAD）返回空串 `''`**，不抛错。
 *
 * 用 `rev-parse --verify HEAD` 而非 `rev-parse HEAD`：前者在无 HEAD 时干净地以非 0 退出
 * （`--verify` 的语义就是「不存在则失败」），后者会把 `HEAD` 当歧义参数报
 * "ambiguous argument"（#670 真机原文），两种写法退出码一样但错误信息更易误判为
 * 「仓库坏了」；这里统一以退出码分类：**失败 ⇒ 无 HEAD**，不猜别的成因。
 *
 * `runGit` 可注入，便于单测伪造「有 HEAD / 无 HEAD / git 本身炸了」三态。
 *
 * @param {string} repoDir
 * @param {{timeout?:number, runGit?:function}} [opts]
 * @returns {string} commit sha，或 `''`（0 提交）
 */
export function headShaOrEmpty(repoDir, { timeout, runGit = git } = {}) {
  try {
    return runGit(['-C', repoDir, 'rev-parse', '--verify', 'HEAD'],
      // 0 提交时 git 会报 `fatal: Needed a single revision` —— 那是**预期内**的假，不该漏到日志里。
      { timeout, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/**
 * 仓库是否有 HEAD（= 至少一个提交）。0 提交是**多数情形**（见 issue #670：真机现查
 * 7 个工位里 5 个 `rev-list --count HEAD` 为 0），不是异常态。
 *
 * @param {string} repoDir
 * @param {{timeout?:number, runGit?:function}} [opts]
 * @returns {boolean}
 */
export function hasHead(repoDir, opts = {}) {
  return headShaOrEmpty(repoDir, opts) !== '';
}

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 解析 NUL 分隔清单（`ls-files -z`）为路径数组。 */
function parseZList(out) {
  return out.split('\0').filter((s) => s.length > 0);
}

/**
 * 从 `git status --porcelain -uall` 取**已跟踪的变更**路径（跳过 `??` 未跟踪）。
 * 重命名 `R  old -> new` 取目标路径；`XY` 后到行尾即路径（本站文件路径均为普通字符，
 * 未触发 git 的引号转义；如遇到引号路径按字面处理，审查快照对未跟踪已单列，不依赖此处）。
 */
function parseChangedTrackedPaths(statusOut) {
  const out = [];
  for (const line of statusOut.split('\n')) {
    if (line.length < 4) continue; // 最短 "XY path"
    const xy = line.slice(0, 2);
    if (xy === '??') continue; // 未跟踪单列在 ls-files --others
    let p = line.slice(3);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4); // 重命名/复制取目标
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ② 内容级一致性校验（本单最容易做错的一格）
// ---------------------------------------------------------------------------

/**
 * 计算**内容级**指纹。
 *
 * 组成（`contentLevel=true`，默认）：
 *   HEAD sha
 *   + `git status --porcelain -uall` 文本
 *   + 每个已跟踪变更文件的 (path, size, sha256)
 *   + 每个未跟踪文件的 (path, sha256)
 *   ⇒ 整体 sha256 = `digest`（搬运前后各取一次，比对的就是它）。
 *
 * ⚠ **只 hash `git status` 文本不够**：同一个已跟踪文件的第二次编辑，`status` 仍是
 *   `M path`（文本一字不变），但内容变了。只有把每个变更文件的 sha256 纳入指纹才抓得住
 *   ——这就是「反向自证一」要逼红的东西（把 `contentLevel` 改回 false 即退化到只 hash status）。
 *
 * ⚠ **mtime 记录但刻意不进 digest**：`git apply` / rsync 重写 worktree 文件时必然改 mtime
 *   （已跟踪文件被 patch 重写、未跟踪文件被拷贝），mtime 不是**跨位置**可搬运不变量。它的
 *   作用是**同位置**的陈旧探测器（配合 sha 快速判漂移），不进比对用的 digest；否则
 *   搬运前（原目录）与搬运后（worktree）永远不等 ⇒ 每次都被判 `snapshot_unstable`。
 *
 * ⚠ **`head` 允许为空**：0 提交仓库没有 HEAD，此时 `head === ''`（哨兵空串，**不是错误**、
 *   也不是「未知」）。空串在搬运前后各取一次都是同一个值 ⇒ digest 仍可比对，一致性校验
 *   照常有效（0 提交仓库的比对实际只靠 status + 内容 sha256，本来也不含 commit 维度）。
 *
 * @returns {{ head:string, status:string, entries:object[], untracked:object[], totalBytes:number, digest:string }}
 */
export function computeContentFingerprint(repoDir, { contentLevel = true, timeout } = {}) {
  // 0 提交 ⇒ ''（见上：哨兵，不抛错）
  const head = headShaOrEmpty(repoDir, { timeout });
  const status = git(['-C', repoDir, 'status', '--porcelain', '-uall'], { timeout });
  const untrackedPaths = parseZList(
    git(['-C', repoDir, 'ls-files', '--others', '--exclude-standard', '-z'], { timeout }),
  ).sort();

  const changedPaths = parseChangedTrackedPaths(status).sort();
  const entries = changedPaths.map((p) => {
    const abs = path.join(repoDir, p);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* 已删除文件 */ }
    const isFile = stat !== null && stat.isFile();
    return {
      path: p,
      size: stat ? stat.size : null,
      mtimeMs: stat ? stat.mtimeMs : null, // 记录不进 digest（见函数头注释）
      sha256: isFile ? sha256File(abs) : null, // 已删除 ⇒ null
    };
  });

  const untracked = untrackedPaths.map((p) => {
    const abs = path.join(repoDir, p);
    let stat = null;
    try { stat = fs.statSync(abs); } catch { /* 竞态删除 */ }
    const isFile = stat !== null && stat.isFile();
    return {
      path: p,
      size: stat ? stat.size : null,
      sha256: isFile ? sha256File(abs) : null,
    };
  });

  // digest 只取**可搬运不变量**：head + status 文本 + 每个变更文件 (path,size,sha) + 未跟踪 (path,sha)。
  // contentLevel=false ⇒ 退化为「只 hash status 文本」的弱指纹（反向自证一的靶子）。
  const digestInput = contentLevel
    ? JSON.stringify([
        'v1',
        head,
        status,
        entries.map((e) => [e.path, e.size, e.sha256]),
        untracked.map((u) => [u.path, u.sha256]),
      ])
    : JSON.stringify(['status-only', head, status]);
  const digest = sha256Text(digestInput);

  const totalBytes = entries.reduce((a, e) => a + (e.size || 0), 0)
    + untracked.reduce((a, u) => a + (u.size || 0), 0);

  return { head, status, entries, untracked, totalBytes, digest };
}

// ---------------------------------------------------------------------------
// 未跟踪文件搬运：rsync（首选）/ tar（rsync 缺失时的回退）
// ---------------------------------------------------------------------------

let _rsyncPath;
/** 缓存式探测 rsync 是否存在（本机存在 ⇒ `/usr/bin/rsync`；缺失 ⇒ 走 tar 回退）。 */
function detectRsync() {
  if (_rsyncPath !== undefined) return _rsyncPath;
  _rsyncPath = process.platform === 'win32' ? null : (() => {
    try {
      const r = spawnSync('which', ['rsync'], { encoding: 'utf8' });
      const p = r && r.status === 0 ? String(r.stdout || '').trim() : '';
      return p.length > 0 ? p : null;
    } catch { return null; }
  })();
  return _rsyncPath;
}

/**
 * 把原目录里「未跟踪且不忽略」的文件搬进 worktree。两条实现：
 *   - rsync：`ls-files --others -z | rsync -a --from0 --files-from=- <repo>/ <wt>/`
 *     用 `--from0 --files-from=-` 而非 glob，是为了安全处理带空格/换行的文件名（NUL 分隔）。
 *   - tar（**回退**）：`ls-files --others -z | tar -C <repo> --null -T - -cf - | tar -C <wt> -xf -`
 *     **为什么显式回退而不是让它静默降级**：rsync 不在某些精简镜像里；若只写 rsync，缺它时
 *     未跟踪文件会**悄悄没搬进去**（审查对象少一截，且校验可能因 worktree 少文件而报 unstable，
 *     把「环境问题」伪装成「现场不稳定」）。所以显式探测、显式走 tar，并在返回值里标 `method`。
 * @returns {{ method:'rsync'|'tar' }} 抛错由上层映射为 `untracked_copy_failed`。
 */
export function copyUntracked(repoDir, worktreePath, { hasRsync = detectRsync() !== null, timeout } = {}) {
  const list = () => git(
    ['-C', repoDir, 'ls-files', '--others', '--exclude-standard', '-z'],
    { timeout },
  );
  const zlist = list();
  if (zlist.length === 0) return { method: hasRsync ? 'rsync' : 'tar', copied: 0 };

  if (hasRsync) {
    // 用 shell 管道跑，保持与任务 §① 逐字一致。
    const cmd = 'git -C "$1" ls-files --others --exclude-standard -z '
      + '| rsync -a --from0 --files-from=- "$1"/ "$2"/';
    const r = spawnSync('bash', ['-c', cmd, 'bash', repoDir, worktreePath],
      { encoding: 'utf8', timeout });
    if (!r || r.status !== 0) {
      throw new Error(`rsync untracked copy failed (status=${r?.status}): ${r?.stderr || r?.error || ''}`);
    }
    return { method: 'rsync', copied: parseZList(zlist).length };
  }

  // tar 回退：第一段 tar 从 stdin(--null -T -) 读名字、把归档写到 stdout；第二段解到 worktree。
  const cmd = 'git -C "$1" ls-files --others --exclude-standard -z '
    + '| tar -C "$1" --null -T - -cf - | tar -C "$2" -xf -';
  const r = spawnSync('bash', ['-c', cmd, 'bash', repoDir, worktreePath],
    { encoding: 'utf8', timeout });
  if (!r || r.status !== 0) {
    throw new Error(`tar untracked copy failed (status=${r?.status}): ${r?.stderr || r?.error || ''}`);
  }
  return { method: 'tar', copied: parseZList(zlist).length };
}

// ---------------------------------------------------------------------------
// ①′ 0 提交仓库（无 HEAD）的搬运：整树拷贝（含 `.git`）
// ---------------------------------------------------------------------------

/**
 * 把原目录**整树**拷进快照目录，**含 `.git`**。0 提交（无 HEAD）仓库专用（issue #670）。
 *
 * 为什么是整树拷贝而不是 worktree + patch：`worktree add` 需要一个 commit 当基点，
 * 0 提交仓库拿不出来。整树拷贝后：
 *   - 快照**仍然是一个 git 仓库** ⇒ 审查 run 里 `git status` / `git diff` 照常可用；
 *   - 所有文件天然是「未提交 / 未跟踪」⇒ 语义上等于「本次改动 = 全部内容」，正是审查
 *     该看到的（D9 收工灯把「0 提交但有内容」当合法红态，同一语义）；
 *   - index 一并拷过去 ⇒ `git add` 过但未 commit 的文件在快照里仍是已暂存（`A`），
 *     审查者能看见「用户已经暂存了哪些」。
 *
 * 实现两条（与 `copyUntracked` 同样的「显式探测、显式降级、不硬依赖 rsync」口径）：
 *   - `rsync -a <repo>/ <dst>/`（首选）：`-a` 保权限/软链、含 `.git`，源尾斜杠 = 拷**内容**；
 *   - `fs.cpSync(<repo>, <dst>, {recursive:true})`（**回退**）：rsync 不在精简镜像里时用。
 *     为什么这条用 cpSync 而不是像 `copyUntracked` 那样用 tar：整树要连 `.git` 一起搬，
 *     tar 管道得自己管「先建目标目录 + 覆盖已存在文件 + 软链不跟随」，而 cpSync 是 Node
 *     内置、默认不跟随软链，少一个外部依赖。**代价**：cpSync 不保留 mtime（默认
 *     `preserveTimestamps:false`）——本模块的 digest 刻意不含 mtime（见
 *     `computeContentFingerprint` 头注释），所以这个代价在这里无害；模式位仍按源写。
 *
 * ⚠ **不再调 `copyUntracked`**：整树拷贝**已经包含**未跟踪文件，再拷一遍是白干活（且两次
 *   结果不一致时会掩盖真错）。“未跟踪文件也要搬”这条语义仍然是满足的，只是由整树拷贝一次做足。
 *
 * ⚠ 超时：`fs.cpSync` 没有 timeout 选项，超时由上层 `createSnapshot` 在调用前后各查一次
 *   deadline 兜（`snapshot_timeout`）；rsync 分支直接把 timeout 交给 spawnSync。
 *
 * ⚠ 已知局限（不属本单范围，仅记录）：
 *   1. 整树拷贝不是 `git worktree`，所以不会出现在 `git worktree list` 里 ⇒
 *      `cleanOrphanWorktrees` 看**不到**它（进不了一次跨进程崩溃的孤儿清扫）；
 *      本进程内的 `cleanup()` 靠 `fs.rmSync` 仍能清掉（见 `removeWorktree`）。
 *   2. 若 `repoDir` 本身是个 linked worktree（`.git` 是个**文件**而非目录），拷过去的 `.git`
 *      会指向不存在的 gitdir ⇒ 快照里的 git 命令会失败，表现为比对报错而不是静默错数据。
 *
 * @param {string} repoDir
 * @param {string} worktreePath
 * @param {{snapshotRoot?:string|null, hasRsync?:boolean, timeout?:number}} [opts]
 * @returns {{method:'rsync'|'cpSync'}}
 */
export function copyWholeTree(repoDir, worktreePath, {
  snapshotRoot = null, hasRsync = detectRsync() !== null, timeout,
} = {}) {
  // 防路径穿越：worktreePath 是 `path.join(snapshotRoot, id)` 拼出来的，id 由调用方给
  // （生产是 uuid，但 `createSnapshot` 的 id 可被覆盖）⇒ 显式核验拼接结果**真的**在
  // snapshotRoot 之下（而不是只假定 id 看起来像 uuid）。`fs.cpSync` 不校这一层。
  if (typeof snapshotRoot === 'string' && snapshotRoot.length > 0) {
    const rootAbs = path.resolve(snapshotRoot);
    const target = path.resolve(worktreePath);
    const rel = path.relative(rootAbs, target);
    const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    if (!inside) {
      const err = new Error(`snapshot copy target escapes snapshotRoot: ${target} not under ${rootAbs}`);
      err.code = SNAPSHOT_TARGET_ESCAPE;
      throw err;
    }
  }

  if (hasRsync) {
    // 直接 spawn、不过 shell：目录名可能有空格/奇怪字符，拼 shell 反而多一层引号风险
    //（`copyUntracked` 过 shell 是因为它需要 git|rsync 管道，这里不需要）。
    const r = spawnSync('rsync', ['-a', `${repoDir}/`, `${worktreePath}/`],
      { encoding: 'utf8', timeout });
    if (!r || r.status !== 0) {
      throw new Error(`whole-tree rsync copy failed (status=${r?.status}): ${r?.stderr || r?.error || ''}`);
    }
    return { method: 'rsync' };
  }

  // 回退：Node 内置递归拷贝（语义等价 `rsync -a src/ dst/`：dst 成为 src 的一份拷贝，
  // 而不是 dst/src）。
  try {
    fs.cpSync(repoDir, worktreePath, { recursive: true, force: true, errorOnExist: false });
  } catch (err) {
    throw new Error(`whole-tree cpSync copy failed: ${err?.message || err}`);
  }
  return { method: 'cpSync' };
}

// ---------------------------------------------------------------------------
// ③ 失败门闸 + ① 搬运 + ② 前后比对（带一次重试）
// ---------------------------------------------------------------------------

function freeDiskBytes(dir) {
  try {
    const st = fs.statfsSync(dir);
    return st.bsize * st.bavail;
  } catch {
    // 目录可能还不存在 ⇒ 向上找一个存在的祖先
    let cur = path.resolve(dir);
    for (;;) {
      try { const st = fs.statfsSync(cur); return st.bsize * st.bavail; } catch { /* ENOENT */ }
      const parent = path.dirname(cur);
      if (parent === cur) return Infinity; // 查不到 ⇒ 不阻断（保守放行）
      cur = parent;
    }
  }
}

function removeWorktree(repoDir, worktreePath) {
  try { git(['-C', repoDir, 'worktree', 'remove', '--force', worktreePath]); } catch { /* 尽力 */ }
  try { fs.rmSync(worktreePath, { recursive: true, force: true }); } catch { /* 尽力 */ }
  try { git(['-C', repoDir, 'worktree', 'prune']); } catch { /* 尽力 */ }
}

/**
 * 一次完整搬运。两条路径（按有无 HEAD 分叉）：
 *   - **有 HEAD**（原路，未变）：worktree add → apply patch → copy untracked；
 *   - **无 HEAD**（0 提交，#670）：`copyWholeTree` 整树拷贝（含 `.git`），**不**再走
 *     worktree/patch/copyUntracked（三者都假定 HEAD 存在，或已被整树拷贝覆盖）。
 * 任一步失败抛带 `.reason` 的错；目标越界则抛 `err.code === SNAPSHOT_TARGET_ESCAPE`（不降级）。
 *
 * @param {{repoDir:string, worktreePath:string, patchFile:string,
 *   snapshotRoot?:string|null, hasRsync?:boolean, timeout?:number,
 *   hasHeadOf?:() => boolean}} opts
 */
function attemptTransfer({
  repoDir, worktreePath, patchFile, snapshotRoot = null, hasRsync, timeout,
  // 默认自己探测（走 `git()` 包装，因而自带 #669 的 `-c safe.directory=*` + `--no-optional-locks`）；
  // `createSnapshot` 会注入「复用指纹已取的结果」以省一次 git 调用，单测也可注入桩。
  hasHeadOf = () => hasHead(repoDir, { timeout }),
} = {}) {
  if (!hasHeadOf()) {
    // 0 提交：无基点 ⇒ 不能 worktree add，也没基线可 diff。整树拷贝（含 `.git`）。
    // 未跟踪文件已在树里，**不**调 copyUntracked（避免重复搬）。
    try {
      copyWholeTree(repoDir, worktreePath, { snapshotRoot, hasRsync, timeout });
    } catch (err) {
      // 守卫错（目标越界）：编程错误，原样抛，不许被当成可重试的搬运失败。
      if (err?.code === SNAPSHOT_TARGET_ESCAPE) throw err;
      if (!err.reason) err.reason = 'snapshot_copy_failed';
      throw err;
    }
    return;
  }

  // 已提交内容
  try {
    git(['-C', repoDir, 'worktree', 'add', '--detach', worktreePath, 'HEAD'], { timeout });
  } catch (err) {
    err.reason = 'worktree_add_failed';
    throw err;
  }
  // 未提交的已跟踪改动
  let diff;
  try {
    diff = git(['-C', repoDir, 'diff', 'HEAD', '--binary'], { timeout });
  } catch (err) {
    err.reason = 'patch_apply_failed';
    throw err;
  }
  if (diff && diff.trim().length > 0) {
    try {
      fs.writeFileSync(patchFile, diff);
      // 用 `git apply` 而非 `git am`：patch 来自 `diff HEAD`，是工作区改动，无提交头。
      git(['-C', worktreePath, 'apply', '-p1', patchFile], { timeout });
    } catch (err) {
      err.reason = 'patch_apply_failed';
      throw err;
    }
  }
  // 未跟踪文件
  try {
    copyUntracked(repoDir, worktreePath, { hasRsync, timeout });
  } catch (err) {
    if (!err.reason) err.reason = 'untracked_copy_failed';
    throw err;
  }
}

/**
 * 建一个隔离 worktree 快照（搬运「HEAD + 未提交 diff + 未跟踪文件」），并做**内容级**前后比对。
 *
 * 失败门闸（任一失败都不启动审查，返回 `{ ok:false, reason }`）：
 *   worktree_add_failed / patch_apply_failed / untracked_copy_failed / snapshot_unstable /
 *   snapshot_timeout（60s）/ snapshot_too_large（>500MB 或变更文件 >5000）/ disk_low（余量 <2GB）。
 *
 * 一致性：搬运前后各取一次 `computeContentFingerprint`；不等 ⇒ 重试一次；仍不等 ⇒ `snapshot_unstable`。
 *
 * @returns {Promise<{ok:boolean, snapshotId?:string, worktreePath?:string, contentDigest?:string, reason?:string}>}
 */
export async function createSnapshot({
  repoDir,
  id = crypto.randomUUID(),
  snapshotRoot = defaultSnapshotRoot(),
  timeoutMs = SNAPSHOT_TIMEOUT_MS,
  hasRsync = detectRsync() !== null,
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;
  const remaining = () => Math.max(1, deadline - now());
  const timedOut = () => now() >= deadline;

  // 门闸：worktree 根必须在 ~/projects 之外（否则污染收工灯）
  const worktreePath = path.join(snapshotRoot, id);
  if (isUnderProjects(worktreePath)) {
    return { ok: false, reason: 'snapshot_root_in_projects', worktreePath };
  }

  // 门闸：磁盘余量
  if (freeDiskBytes(snapshotRoot) < MIN_FREE_DISK_BYTES) {
    return { ok: false, reason: 'disk_low', worktreePath };
  }

  let before;
  try {
    before = computeContentFingerprint(repoDir, { timeout: remaining() });
  } catch (err) {
    if (timedOut()) return { ok: false, reason: 'snapshot_timeout', worktreePath };
    throw err;
  }

  // 门闸：体量
  const changedFileCount = before.entries.length + before.untracked.length;
  if (before.totalBytes > MAX_SIZE_BYTES || changedFileCount > MAX_CHANGED_FILES) {
    return { ok: false, reason: 'snapshot_too_large', worktreePath };
  }

  // 0 提交分叉（#670）：**复用上面指纹已经取过的结果**（`before.head === ''` ⇒ 无 HEAD），
  // 省一次 `rev-parse` git 调用，且保证「比对口径」与「搬运口径」用的是同一个判定。
  // 重试沿用同一个值：HEAD 中途出现/消失会让前后 digest 不等 ⇒ `snapshot_unstable`（保守、
  // 不会静默按错的分支搬运）。
  const headPresent = before.head !== '';

  const patchFile = path.join(os.tmpdir(), `${id}.patch`);
  fs.mkdirSync(snapshotRoot, { recursive: true });

  const cleanup = () => {
    removeWorktree(repoDir, worktreePath);
    try { fs.rmSync(patchFile, { force: true }); } catch { /* 尽力 */ }
  };

  // 一次搬运 + 校验；失败可重试一次（unstable 专用）
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt += 1;
    if (timedOut()) { cleanup(); return { ok: false, reason: 'snapshot_timeout', worktreePath }; }

    try {
      attemptTransfer({
        repoDir, worktreePath, patchFile, snapshotRoot, hasRsync, timeout: remaining(),
        hasHeadOf: () => headPresent,
      });
    } catch (err) {
      cleanup();
      if (timedOut()) return { ok: false, reason: 'snapshot_timeout', worktreePath };
      const reason = err?.reason
        || (/timed out|ETIMEDOUT|SIGTERM/i.test(String(err?.message || err)) ? 'snapshot_timeout' : null);
      if (reason) return { ok: false, reason, worktreePath };
      throw err;
    }

    if (timedOut()) { cleanup(); return { ok: false, reason: 'snapshot_timeout', worktreePath }; }

    let after;
    try {
      after = computeContentFingerprint(worktreePath, { timeout: remaining() });
    } catch (err) {
      cleanup();
      if (timedOut()) return { ok: false, reason: 'snapshot_timeout', worktreePath };
      throw err;
    }

    if (after.digest === before.digest) {
      try { fs.rmSync(patchFile, { force: true }); } catch { /* 尽力 */ }
      return { ok: true, snapshotId: id, worktreePath, contentDigest: after.digest };
    }

    // digest 不等
    if (attempt >= 2) { cleanup(); return { ok: false, reason: 'snapshot_unstable', worktreePath }; }
    // 重试一次：清掉半成品 worktree 再搬
    removeWorktree(repoDir, worktreePath);
  }
}

// ---------------------------------------------------------------------------
// ④ 孤儿清扫（含崩溃态）
// ---------------------------------------------------------------------------

/**
 * 决定某个 worktree 路径是否该被回收（纯函数，便于单测三条判据）。
 * @param {{status:string, startedAt:Date|string, finishedAt:Date|string|null}|null} row `macro_runs` 行；null = 行根本不存在
 * @param {number} nowMs
 * @returns {boolean}
 */
export function shouldRemoveOrphan(row, nowMs = Date.now()) {
  // 3) 行根本不存在：建完 worktree、写库前就死了
  if (row === null || row === undefined) return true;
  const ageOf = (t) => (t ? nowMs - new Date(t).getTime() : Infinity);
  if (TERMINAL_MACRO_RUN_STATUSES.includes(row.status)) {
    // 1) 已终态 > 1h
    return ageOf(row.finishedAt) > ORPHAN_AGE_MS;
  }
  if (row.status === 'running') {
    // 2) 仍 running 但 started_at > 1h（进程崩溃留下的，永远等不到终态）
    return ageOf(row.startedAt) > ORPHAN_AGE_MS;
  }
  // pending（还没真跑）⇒ 不回收
  return false;
}

/**
 * 生产用的 `macro_runs` 查找器（按 `worktree_path` 取孤儿判据所需的三列）。
 * 作为 `cleanOrphanWorktrees({ lookupMacroRun })` 的真实现注入；单测用 fake pool 验 SQL 形态，
 * **不必起真 Postgres**（decision 逻辑另由注入假 lookup 的 `cleanOrphanWorktrees` 用例覆盖）。
 * 查不到行 ⇒ 返回 null（对应孤儿判据 3：建完 worktree、写库前就死了）。
 */
export function makeMacroRunLookup(pool) {
  return async (worktreePath) => {
    const r = await pool.query(
      'SELECT status, started_at, finished_at FROM macro_runs WHERE worktree_path = $1 LIMIT 1',
      [worktreePath],
    );
    const row = r?.rows?.[0];
    if (!row) return null;
    return { status: row.status, startedAt: row.started_at, finishedAt: row.finished_at };
  };
}

/** 解析 `git worktree list --porcelain`，返回绝对路径数组。 */
export function parseWorktreeList(out) {
  const paths = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}

/**
 * 扫 `git worktree list`，对落在 snapshotRoot 下、且命中任一孤儿判据的路径 `worktree remove --force`。
 * 三条判据见 `shouldRemoveOrphan`。DB 查询与 git 执行可注入（测试不连真库也能跑满三条）。
 *
 * @param {{repoDir:string, snapshotRoot?:string,
 *   listWorktrees?:(()=>string), removeWorktree?:((p:string)=>void),
 *   lookupMacroRun?:((p:string)=>Promise<object|null>), nowMs?:number}} opts
 * @returns {Promise<{removed:string[], considered:string[]}>}
 */
export async function cleanOrphanWorktrees({
  repoDir,
  snapshotRoot = defaultSnapshotRoot(),
  listWorktrees = () => git(['-C', repoDir, 'worktree', 'list', '--porcelain']),
  removeWorktree = (p) => { git(['-C', repoDir, 'worktree', 'remove', '--force', p]); },
  lookupMacroRun = async () => null,
  nowMs = Date.now(),
} = {}) {
  const considered = [];
  const removed = [];
  const rootReal = (() => { try { return fs.realpathSync(snapshotRoot); } catch { return path.resolve(snapshotRoot); } })();

  let listed;
  try { listed = parseWorktreeList(listWorktrees()); } catch { return { removed, considered }; }

  for (const p of listed) {
    let rel = false;
    try {
      const pReal = fs.realpathSync(p);
      rel = path.relative(rootReal, pReal) !== '' && !path.relative(rootReal, pReal).startsWith('..');
    } catch {
      const lr = path.relative(rootReal, path.resolve(p));
      rel = lr !== '' && !lr.startsWith('..');
    }
    if (!rel) continue; // 不是本站快照根下的 worktree（比如用户自己的主 worktree）⇒ 不碰

    considered.push(p);
    const row = await lookupMacroRun(p);
    if (shouldRemoveOrphan(row, nowMs)) {
      try { removeWorktree(p); removed.push(p); } catch { /* 尽力 */ }
    }
  }
  return { removed, considered };
}
